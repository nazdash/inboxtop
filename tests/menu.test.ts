import { test, expect, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Controller } from '../src/controller.ts';
import { DemoMailbox, DemoAnalyzer, demoSession } from '../src/demo.ts';
import { MemoryStore } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';
import { settingsFrom } from '../src/settings.ts';
import { inboxStats } from '../src/inbox-stats.ts';
import { menuStatus } from '../src/menu-status.ts';
import { ProviderFailure } from '../src/analysis.ts';
import { serveWorker, workerRequest } from '../src/worker.ts';
import { terminalCommand, runBridge } from '../src/menu-bridge.ts';
import { DestinationSchema } from '../src/destinations.ts';

async function setup() {
  const store = new MemoryStore();
  store.value.session = demoSession();
  const config = loadConfig(false, {});
  const mail = new DemoMailbox();
  const c = new Controller(mail, new DemoAnalyzer(), store, 'demo', 'fictional', 2, config);
  await c.init();
  return { c, store, config, mail };
}

test('menu status shares unread counts, keeps Act independent from Live and never exposes email content', async () => {
  const { c } = await setup();
  try {
    await c.syncInbox();
    let status = menuStatus(c, 4);
    expect(status.groups).toEqual(inboxStats(c).outcomes);
    expect(status.groups.act).toBeGreaterThan(0);
    expect(status.enabled).toBe(false);
    c.saved.mode = 'live';
    expect(menuStatus(c, 5).groups.act).toBe(status.groups.act);
    c.status = 'private-address@example.invalid secret subject';
    c.summaryError = 'personal model diagnostic';
    c.syncError = true;
    status = menuStatus(c, 6);
    const json = JSON.stringify(status);
    for (const m of c.messages) {
      expect(json).not.toContain(m.subject);
      expect(json).not.toContain(m.body);
      expect(json).not.toContain(m.sender);
    }
    expect(json).not.toContain('private-address');
    expect(json).not.toContain('personal model diagnostic');
    expect(status.issue).toContain('Sync failed');
    expect(status.lastSync).toBe(c.saved.inbox?.at ?? null);
    for (const m of c.messages) m.read = true;
    expect(menuStatus(c, 7).groups.act).toBe(0);
    expect(menuStatus(c, 7).mode).toBe('live');
    c.mutating = true;
    expect(menuStatus(c, 8).commands).toEqual({ mode: false, sync: false, stop: false });
    c.mutating = false;
  } finally {
    await c.close();
  }
});

test('only blocking service failures affect menu health, and successful retry clears them', async () => {
  const { c } = await setup();
  const analyzer = c.analyzer;
  try {
    const message = c.messages[0];
    message.error = 'Invalid evidence for a single email';
    c.summaryError = 'Summary did not validate';
    expect(menuStatus(c, 1).blockingIssue).toBeNull();
    expect(menuStatus(c, 1).issue).toBeNull();
    c.analyzer = {
      analyze: async () => {
        throw new ProviderFailure('secret provider diagnostic', 'credentials');
      },
    };
    await c.reviewOne(message.id);
    const status = menuStatus(c, 2);
    expect(status.blockingIssue).toEqual({
      title: 'AI credentials rejected',
      detail: 'Check your API key and access.',
      destination: 'settings',
    });
    expect(JSON.stringify(status)).not.toContain('secret provider diagnostic');
    // An ordinary email failure is not proof that the service has recovered.
    c.analyzer = {
      analyze: async () => {
        throw new Error('Invalid evidence');
      },
    };
    await c.reviewOne(message.id);
    expect(menuStatus(c, 3).blockingIssue?.title).toBe('AI credentials rejected');
    c.analyzer = analyzer;
    await c.reviewOne(message.id);
    expect(menuStatus(c, 4).blockingIssue).toBeNull();
  } finally {
    await c.close();
  }
});

test('menu preference saves before launching, hides during analysis, and does not launch on a failed save', async () => {
  const { c, store, config } = await setup();
  const calls: boolean[] = [];
  c.menuBarHook = async (enabled) => {
    expect(store.value.settings?.menuBarEnabled).toBe(enabled);
    calls.push(enabled);
  };
  const save = store.save.bind(store);
  try {
    const settings = { ...settingsFrom(config), menuBarEnabled: true };
    store.save = async () => {
      throw new Error('Disk full');
    };
    await expect(c.saveSettings(settings)).rejects.toThrow('Disk full');
    expect(calls).toEqual([]);
    expect(c.saved.settings?.menuBarEnabled).not.toBe(true);
    store.save = save;
    await c.saveSettings(settings);
    expect(calls).toEqual([true]);
    c.busy = true;
    c.saved.mode = 'live';
    await c.setMenuBarEnabled(false);
    expect(calls).toEqual([true, false]);
    expect(c.mode).toBe('live');
    expect(c.busy).toBe(true);
    expect(config.menuBarEnabled).toBe(false);
    c.busy = false;
    c.menuBarHook = async () => {
      throw new Error('Launch failed');
    };
    await expect(c.saveSettings(settings)).rejects.toThrow('Settings saved, but');
    expect(store.value.settings?.menuBarEnabled).toBe(true);
  } finally {
    store.save = save;
    c.busy = false;
    await c.close();
  }
});

test('menu endpoint acknowledges completed commands, rejects duplicates and recovers from sync failures', async () => {
  const { c, mail } = await setup();
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-menu-'));
  const socket = join(dir, 'w.sock');
  const server = await serveWorker(c, socket);
  let release!: () => void;
  const snapshot = mail.snapshot.bind(mail);
  try {
    const before = await workerRequest(socket, '/menu/status');
    expect(before.protocol).toBe(1);
    expect(before.lastSync).toBeNull();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mail.snapshot = async (scope) => {
      await gate;
      return snapshot(scope);
    };
    let completed = false;
    const command = runBridge(['sync', '--socket', socket]).then((value) => {
      completed = true;
      return value;
    });
    for (let n = 0; n < 100 && !c.syncing; n++) await Bun.sleep(5);
    expect(c.syncing).toBe(true);
    expect(completed).toBe(false);
    const pending = await workerRequest(socket, '/menu/status');
    expect(pending.commands.sync).toBe(false);
    expect(pending.activity).toBe('Updating…');
    await expect(workerRequest(socket, '/menu/command', { command: 'sync' })).rejects.toThrow(
      'still running',
    );
    await expect(
      workerRequest(socket, '/command', { command: 'mode', value: 'live' }),
    ).rejects.toThrow('still running');
    release();
    expect((await command).lastSync).not.toBeNull();
    mail.snapshot = async () => {
      throw new Error('private provider diagnostic');
    };
    await expect(workerRequest(socket, '/menu/command', { command: 'sync' })).rejects.toThrow();
    expect((await runBridge(['status', '--socket', socket])).issue).toContain('Sync failed');
    mail.snapshot = snapshot;
    await workerRequest(socket, '/menu/command', { command: 'sync' });
    expect(c.syncError).toBe(false);
    await expect(
      workerRequest(socket, '/menu/command', { command: 'apply', value: ['anything'] }),
    ).rejects.toThrow();
    const change = spyOn(c, 'setMode').mockImplementation(async (mode) => {
      c.saved.mode = mode;
      c.changed();
    });
    await workerRequest(socket, '/menu/command', { command: 'mode', value: 'live' });
    expect((await runBridge(['status', '--socket', socket])).mode).toBe('live');
    await workerRequest(socket, '/menu/command', { command: 'stop' });
    expect(c.mode).toBe('adhoc');
    change.mockRestore();
    await c.setMenuBarEnabled(true);
    await workerRequest(socket, '/menu/command', { command: 'hide' });
    expect((await runBridge(['status', '--socket', socket])).enabled).toBe(false);
  } finally {
    release?.();
    mail.snapshot = snapshot;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await c.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('terminal destinations are explicit and shell arguments remain quoted, including paths with spaces', () => {
  for (const destination of DestinationSchema.options)
    expect(
      terminalCommand(destination, "/tmp/a 'quoted' $file.env", '/tmp/space folder'),
    ).toContain(`'--open' '${destination}'`);
  expect(terminalCommand('chat', "/tmp/a 'quoted' $file.env", '/tmp/space folder')).toContain(
    "cd '/tmp/space folder' &&",
  );
  expect(terminalCommand('chat', "/tmp/a 'quoted' $file.env")).toContain(
    "'/tmp/a '\\''quoted'\\'' $file.env'",
  );
  expect(() => terminalCommand('chat; echo wrong')).toThrow();
});
