import { expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountID, configFromValues } from '../src/config.ts';
import { loadProfile, userConfigPath, type CredentialVault } from '../src/credentials.ts';
import { demoSession } from '../src/demo.ts';
import { EncryptedStore } from '../src/store.ts';
import { servicePlist, workerSocket } from '../src/worker.ts';
import { terminalCommand } from '../src/menu-bridge.ts';

test('inboxtop loads saved profiles and retains account, socket and service identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inboxtop-saved-profile-'));
  const values = {
    EMAIL_ADDRESS: 'fictional@example.invalid',
    IMAP_SERVER: 'fixture.invalid',
    INBOXTOP_DATA_DIR: directory,
  };
  const credential = '00000000-0000-4000-8000-000000000001';
  const vault: CredentialVault = {
    get: async (ref) => {
      expect(ref).toBe(credential);
      return JSON.stringify({ password: 'fictional', apiKey: 'fictional' });
    },
    set: async () => {
      throw new Error('Rename must not rewrite credentials');
    },
    remove: async () => {
      throw new Error('Rename must not delete credentials');
    },
  };
  try {
    const profile = join(directory, 'config.json');
    const original = JSON.stringify({ version: 1, credential, values });
    await writeFile(profile, original);
    const config = await loadProfile(profile, vault);
    const account = createHash('sha256')
      .update('fixture.invalid:993:fictional@example.invalid')
      .digest('hex')
      .slice(0, 24);
    const socketHash = createHash('sha256')
      .update(`${directory}:${account}`)
      .digest('hex')
      .slice(0, 20);
    expect(accountID(config)).toBe(account);
    expect(config.dataDir).toBe(directory);
    expect(config.profileRevision).toBe(credential);
    expect(workerSocket(config)).toBe(
      `/tmp/inboxtop-${process.getuid?.() ?? 'user'}-${socketHash}/worker.sock`,
    );
    expect(servicePlist(config, '').label).toBe(
      `local.inboxtop.${account}.${createHash('sha256').update(directory).digest('hex').slice(0, 8)}`,
    );
    expect(await readFile(profile, 'utf8')).toBe(original);
    expect(userConfigPath().endsWith(join('inboxtop', 'config.json'))).toBe(true);
    expect(configFromValues({}).dataDir).toBe(join(homedir(), '.local/share/inboxtop-terminal'));
    expect(terminalCommand('inbox')).toContain("/inboxtop'");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('inboxtop reads and updates the authenticated cache format', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inboxtop-saved-cache-'));
  const key = randomBytes(32),
    iv = randomBytes(12);
  const saved = { version: 1 as const, cache: {}, session: demoSession() };
  // Construct the on-disk format independently of the current writer.
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('inboxtop-terminal-v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(saved)), cipher.final()]);
  await writeFile(join(directory, 'cache.key'), key);
  await writeFile(
    join(directory, 'session.enc'),
    Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
  );
  let store: EncryptedStore | undefined;
  try {
    store = await new EncryptedStore(directory).init();
    expect(await store.load()).toEqual(saved);
    await store.save(saved);
    expect(await readFile(join(directory, 'cache.key'))).toEqual(key);
    const raw = await readFile(join(directory, 'session.enc'));
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from('inboxtop-terminal-v1'));
    decipher.setAuthTag(raw.subarray(12, 28));
    expect(
      JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString()),
    ).toEqual(saved);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
