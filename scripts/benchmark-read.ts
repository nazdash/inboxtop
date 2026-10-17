// Fictional mail and simulated network only. Measures the real controller/store path.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImapFlow } from 'imapflow';
import type { Mailbox } from '../src/domain.ts';
import { Controller } from '../src/controller.ts';
import { IMAPMailbox } from '../src/mail.ts';
import { EncryptedStore } from '../src/store.ts';
import { demoSession } from '../src/demo.ts';
import { accountID, loadConfig } from '../src/config.ts';
const count = 100;
const config = loadConfig(false, { EMAIL_ADDRESS: 'fictional@example.invalid' });
const session = demoSession();
session.identity = { account: accountID(config), mailbox: 'INBOX', validity: '1' };
session.messages = Array.from({ length: count }, (_, i) => ({
  ...structuredClone(session.messages[0]),
  uid: 1000 + i,
  id: `${session.identity.account}:INBOX:1:${1000 + i}`,
  body: 'Fictional text. '.repeat(100),
}));
session.uids = session.messages.map((m) => m.uid);
session.total = count;
const flags = new Map(session.uids.map((uid) => [uid, new Set<string>()]));
let commands = 0;
const trip = async () => {
  commands++;
  await Bun.sleep(5);
};
const fake = {
  usable: true,
  mailbox: { uidValidity: 1 },
  on() {},
  async connect() {},
  async logout() {},
  async getMailboxLock() {
    return { release() {} };
  },
  async fetchOne(uid: string) {
    await trip();
    return { uid: Number(uid), flags: new Set(flags.get(Number(uid))) };
  },
  async fetchAll(uids: string) {
    await trip();
    return uids
      .split(',')
      .map((uid) => ({ uid: Number(uid), flags: new Set(flags.get(Number(uid))) }));
  },
  async messageFlagsAdd(uids: string) {
    await trip();
    for (const uid of uids.split(',')) flags.get(Number(uid))!.add('\\Seen');
    return true;
  },
};
const directory = await mkdtemp(join(tmpdir(), 'inboxtop-read-bench-'));
const store = await new EncryptedStore(directory).init();
await store.save({ version: 1, cache: {}, session });
const original = store.save.bind(store);
let saves = 0,
  saveMS = 0;
store.save = async (value) => {
  const start = performance.now();
  saves++;
  await original(value);
  saveMS += performance.now() - start;
};
const mail: Mailbox = new IMAPMailbox(config, () => fake as unknown as ImapFlow);
if (process.argv.includes('--single')) mail.setReadMany = undefined;
const c = new Controller(
  mail,
  {
    analyze: async () => {
      throw new Error('No AI in this benchmark');
    },
  },
  store,
  'demo',
  'fictional',
);
try {
  await c.init();
  saves = 0;
  saveMS = 0;
  const start = performance.now();
  await c.apply(session.messages.map((m) => m.id));
  console.log(
    JSON.stringify({
      emails: count,
      mode: mail.setReadMany ? 'batched' : 'single',
      simulatedRoundTripMS: 5,
      commands,
      saves,
      saveMS: Math.round(saveMS),
      elapsedMS: Math.round(performance.now() - start),
      verified: c.messages.filter((m) => m.read).length,
    }),
  );
} finally {
  await c.close();
  await rm(directory, { recursive: true, force: true });
}
