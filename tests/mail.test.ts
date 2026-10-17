import { test, expect } from 'bun:test';
import type { ImapFlow } from 'imapflow';
import { IMAPMailbox, MessageUnavailable } from '../src/mail.ts';
import { loadConfig, accountID } from '../src/config.ts';
import { demoMessages } from '../src/demo.ts';
function fixture() {
  const config = loadConfig(false, {
    EMAIL_ADDRESS: 'test@example.com',
    IMAP_SERVER: 'imap.example.com',
    EMAIL_PASSWORD: 'fake',
  });
  const calls: { method: string; args: unknown[] }[] = [];
  let flags = new Set<string>();
  let available = true;
  const fake = {
    usable: true,
    mailbox: { uidValidity: 1 },
    on() {},
    async connect() {},
    close() {},
    async logout() {},
    async getMailboxLock(...args: unknown[]) {
      calls.push({ method: 'lock', args });
      return { release() {} };
    },
    async search(...args: unknown[]) {
      calls.push({ method: 'search', args });
      return [100, 101, 102];
    },
    async fetchOne(...args: unknown[]) {
      calls.push({ method: 'fetch', args });
      return available
        ? {
            uid: 100,
            flags: new Set(flags),
            size: 48,
            source: Buffer.from('Subject: Test\r\n\r\nA routine update.'),
            envelope: {},
            internalDate: new Date(),
          }
        : false;
    },
    async fetchAll(...args: unknown[]) {
      calls.push({ method: 'fetchAll', args });
      return available
        ? String(args[0])
            .split(',')
            .map((uid) => ({ uid: Number(uid), flags: new Set(flags) }))
        : [];
    },
    async messageFlagsAdd(...args: unknown[]) {
      calls.push({ method: 'add', args });
      flags.add('\\Seen');
      return true;
    },
    async messageFlagsRemove(...args: unknown[]) {
      calls.push({ method: 'remove', args });
      flags.delete('\\Seen');
      return true;
    },
  };
  const mail = new IMAPMailbox(config, () => fake as unknown as ImapFlow);
  const identity = { account: accountID(config), mailbox: 'INBOX', validity: '1' };
  const message = { ...demoMessages()[0], id: `${identity.account}:INBOX:1:100` };
  return {
    mail,
    fake,
    calls,
    identity,
    message,
    setAvailable: (v: boolean) => {
      available = v;
    },
  };
}
test('setup connection check opens INBOX read-only without fetching or changing mail', async () => {
  const f = fixture();
  await f.mail.testConnection();
  expect(f.calls).toEqual([{ method: 'lock', args: ['INBOX', { readOnly: true }] }]);
  await f.mail.close();
});
test('IMAP reads use UIDs, read-only locks and finite sorted snapshots', async () => {
  const f = fixture();
  expect((await f.mail.snapshot({ mode: 'unread', order: 'newest', limit: 2 })).uids).toEqual([
    102, 101,
  ]);
  const result = await f.mail.fetch(100, f.identity);
  expect(result.read).toBe(false);
  expect(f.calls.filter((c) => c.method === 'lock').every((c) => (c.args[1] as any).readOnly)).toBe(
    true,
  );
  expect(f.calls.find((c) => c.method === 'fetch')?.args[2]).toEqual({ uid: true });
  expect(f.calls.some((c) => c.method === 'add')).toBe(false);
  f.setAvailable(false);
  await expect(f.mail.fetch(100, f.identity)).rejects.toBeInstanceOf(MessageUnavailable);
  await f.mail.close();
});
test('UIDVALIDITY is checked before touching flags; UID writes verified with a second fetch', async () => {
  const f = fixture();
  f.fake.mailbox.uidValidity = 2;
  await expect(f.mail.setRead(f.message, true, false)).rejects.toThrow('identity changed');
  expect(f.calls.some((c) => c.method === 'add')).toBe(false);
  f.fake.mailbox.uidValidity = 1;
  expect(await f.mail.setRead(f.message, true, false)).toBe('changed');
  expect(f.calls.filter((c) => c.method === 'fetch')).toHaveLength(2);
  expect(f.calls.find((c) => c.method === 'add')?.args).toEqual(['100', ['\\Seen'], { uid: true }]);
  expect(await f.mail.setRead(f.message, true, false)).toBe('skipped');
  expect(await f.mail.setRead(f.message, false, true)).toBe('changed');
  await f.mail.close();
});
test('server rejection and unverifiable changes are errors, never successful receipts', async () => {
  const f = fixture();
  f.fake.messageFlagsAdd = async () => false;
  await expect(f.mail.setRead(f.message, true, false)).rejects.toThrow('rejected');
  f.fake.messageFlagsAdd = async () => true;
  await expect(f.mail.setRead(f.message, true, false)).rejects.toThrow('verified');
  await f.mail.close();
});

test('batch read uses explicit selected UIDs and verifies each result in three commands', async () => {
  const f = fixture();
  const rows = [100, 104, 110].map((uid) => ({
    ...f.message,
    uid,
    id: `${f.identity.account}:INBOX:1:${uid}`,
  }));
  const results = await f.mail.setReadMany(rows, true, false);
  expect([...results.values()]).toEqual(['changed', 'changed', 'changed']);
  expect(f.calls.filter((c) => c.method === 'fetchAll')).toHaveLength(2);
  expect(f.calls.find((c) => c.method === 'add')?.args).toEqual([
    '100,104,110',
    ['\\Seen'],
    { uid: true },
  ]);
  expect(f.calls.filter((c) => c.method === 'lock')).toHaveLength(1);
  await f.mail.close();
});

test('batch read excludes stale rows and leaves missing verification unconfirmed', async () => {
  const f = fixture();
  const rows = [100, 104, 110, 120].map((uid) => ({
    ...f.message,
    uid,
    id: `${f.identity.account}:INBOX:1:${uid}`,
  }));
  let fetched = 0;
  f.fake.fetchAll = async () =>
    ++fetched === 1
      ? [
          { uid: 100, flags: new Set<string>() },
          { uid: 104, flags: new Set(['\\Seen']) },
          { uid: 110, flags: new Set<string>() },
        ]
      : [{ uid: 100, flags: new Set(['\\Seen']) }];
  const results = await f.mail.setReadMany(rows, true, false);
  expect([...results.values()]).toEqual(['changed', 'skipped', 'unknown', 'skipped']);
  expect(f.calls.find((c) => c.method === 'add')?.args[0]).toBe('100,110');
  await f.mail.close();
});

test('batch identity failure prevents all writes; disconnects never replay a batch', async () => {
  const f = fixture();
  const second = { ...f.message, uid: 104, id: `${f.identity.account}:INBOX:1:104` };
  await expect(
    f.mail.setReadMany([f.message, { ...second, validity: '2' }], true, false),
  ).rejects.toThrow('identity changed');
  expect(f.calls.some((c) => c.method === 'add')).toBe(false);
  let attempts = 0;
  f.fake.messageFlagsAdd = async () => {
    attempts++;
    throw new Error('Connection lost after STORE');
  };
  expect([...(await f.mail.setReadMany([f.message, second], true, false)).values()]).toEqual([
    'unknown',
    'unknown',
  ]);
  expect(attempts).toBe(1);
  await f.mail.close();
});
