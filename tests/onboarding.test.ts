import { test, expect } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveProfile, loadProfile, type CredentialVault } from '../src/credentials.ts';
import { configFromValues, accountID } from '../src/config.ts';
import { OnboardingScreen } from '../src/ui/onboarding.ts';
import { testAIConnection } from '../src/onboarding.ts';
import { Controller } from '../src/controller.ts';
import { DemoAnalyzer, DemoMailbox } from '../src/demo.ts';
import { MemoryStore } from '../src/store.ts';
import { settingsFrom } from '../src/settings.ts';

const fixture = () =>
  configFromValues({
    EMAIL_ADDRESS: 'someone@example.invalid',
    EMAIL_PASSWORD: 'private-fixture-password',
    IMAP_SERVER: 'imap.example.invalid',
    OPENAI_API_KEY: 'private-fixture-api-key',
  });
class Vault implements CredentialVault {
  values = new Map<string, string>();
  fail = false;
  async get(ref: string) {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string) {
    if (this.fail) throw new Error('private-provider-error');
    this.values.set(ref, value);
  }
  async remove(ref: string) {
    this.values.delete(ref);
  }
}
test('secure setup saves no plaintext secrets, rotates credentials atomically and preserves account identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-profile-'));
  const file = join(dir, 'config.json');
  const vault = new Vault();
  try {
    const first = await saveProfile(fixture(), file, vault);
    const disk = await readFile(file, 'utf8');
    expect(disk).not.toContain(first.password);
    expect(disk).not.toContain(first.apiKey);
    expect((await loadProfile(file, vault)).password).toBe(first.password);
    vault.fail = true;
    await expect(saveProfile({ ...first, password: 'replacement' }, file, vault)).rejects.toThrow(
      'previous configuration is unchanged',
    );
    expect(await readFile(file, 'utf8')).toBe(disk);
    expect(vault.values.size).toBe(1);
    vault.fail = false;
    const second = await saveProfile({ ...first, password: 'replacement' }, file, vault);
    expect(accountID(first)).toBe(accountID(second));
    expect(second.profileRevision).not.toBe(first.profileRevision);
    expect(vault.values.size).toBe(1);
    expect((await loadProfile(file, vault)).password).toBe('replacement');
    expect(await readdir(dir)).toEqual(['config.json']);
    await writeFile(file + '.lock', '');
    await expect(saveProfile(first, file, vault)).rejects.toThrow('Another setup');
    expect((await loadProfile(file, vault)).password).toBe('replacement');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('missing or unavailable vault fails closed without fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-profile-'));
  const file = join(dir, 'config.json');
  const vault = new Vault();
  try {
    await saveProfile(fixture(), file, vault);
    vault.values.clear();
    await expect(loadProfile(file, vault)).rejects.toThrow('No plaintext fallback');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('a new setup revision applies chosen settings once and starts Ad hoc without losing history', async () => {
  const store = new MemoryStore();
  const config = { ...fixture(), profileRevision: 'new-revision' };
  store.value = {
    version: 1,
    cache: {},
    settings: { ...settingsFrom(config), provider: 'ollama' },
    mode: 'live',
    chats: {},
  };
  const c = new Controller(
    new DemoMailbox(),
    new DemoAnalyzer(),
    store,
    'openai',
    config.model,
    2,
    config,
  );
  await c.init();
  expect(c.mode).toBe('adhoc');
  expect(c.saved.settings?.provider).toBe('openai');
  expect(c.saved.chats).toEqual({});
  expect(c.saved.profileRevision).toBe('new-revision');
  await c.saveSettings({ ...settingsFrom(config), analysisLanguage: 'ru' });
  await c.close();
  const next = new Controller(
    new DemoMailbox(),
    new DemoAnalyzer(),
    store,
    'openai',
    config.model,
    2,
    { ...fixture(), profileRevision: 'new-revision' },
  );
  await next.init();
  expect(next.config?.analysisLanguage).toBe('ru');
  await next.close();
});
test('AI setup explicitly tests both stages with fictional content and sanitizes failures', async () => {
  const seen: string[] = [];
  const fake = {
    classify: async (m: any) => {
      seen.push(m.body);
    },
    analyze: async (m: any) => {
      seen.push(m.body);
    },
  };
  await testAIConnection(fixture(), new AbortController().signal, fake as any);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toContain('fictional setup test');
  fake.analyze = async () => {
    throw new Error('private-fixture-api-key');
  };
  await expect(
    testAIConnection(fixture(), new AbortController().signal, fake as any),
  ).rejects.toThrow('Check your key');
});

test('onboarding works keyboard-only at narrow sizes, masks secrets, keeps cancelled edits and saves only after tests', async () => {
  for (const [width, height] of [
    [80, 24],
    [40, 18],
  ]) {
    const terminal = await createTestRenderer({ width, height, exitOnCtrlC: false });
    let mailCalls = 0,
      aiCalls = 0,
      saves = 0;
    let savedPassword = '';
    const screen = new OnboardingScreen(terminal.renderer, fixture(), '/unused', {
      mail: async () => {
        mailCalls++;
      },
      ai: async () => {
        aiCalls++;
      },
      save: async (config) => {
        saves++;
        savedPassword = config.password;
        return config;
      },
    });
    const key = async (key: string) => {
      terminal.mockInput.pressKey(key);
      if (key === 'ESCAPE') await Bun.sleep(40);
      await terminal.flush();
    };
    const frame = async () => {
      await terminal.flush();
      const value = terminal.captureCharFrame();
      expect(value).not.toContain('private-fixture');
      return value;
    };
    try {
      await key('ARROW_DOWN');
      await key('RETURN');
      expect(await frame()).toContain('Connect email');
      // Editing a secret never places the original or newly typed value in the frame.
      await key('ARROW_DOWN');
      await key('ARROW_DOWN');
      await key('ARROW_DOWN');
      await key('ARROW_DOWN');
      await key('RETURN');
      await terminal.mockInput.typeText('secret-new');
      expect(await frame()).not.toContain('secret-new');
      await key('ESCAPE');
      await key('ARROW_DOWN');
      await key('ARROW_DOWN');
      await key('RETURN');
      expect(await frame()).toContain('Test the email');
      expect(saves).toBe(0);
      await key('ARROW_UP');
      await key('RETURN');
      expect(mailCalls).toBe(1);
      await key('ARROW_DOWN');
      await key('RETURN');
      expect(await frame()).toContain('Choose AI');
      for (let n = 0; n < 4; n++) await key('ARROW_DOWN');
      await key('RETURN');
      expect(aiCalls).toBe(1);
      await key('ARROW_DOWN');
      await key('RETURN');
      expect(await frame()).toContain('Save setup');
      await key('RETURN');
      expect((await screen.result).kind).toBe('saved');
      expect(saves).toBe(1);
      expect(savedPassword).toBe(fixture().password);
    } finally {
      screen.dispose();
      await terminal.dispose();
    }
  }
});
