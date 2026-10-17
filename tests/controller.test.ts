import { test, expect } from 'bun:test';
import { Controller } from '../src/controller.ts';
import { DemoMailbox, DemoAnalyzer, demoSession } from '../src/demo.ts';
import { MemoryStore, EncryptedStore } from '../src/store.ts';
import { ProviderFailure } from '../src/analysis.ts';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Analyzer } from '../src/domain.ts';
const scope = { mode: 'unread', limit: 4, order: 'oldest' } as const;
async function setup(analyzer: Analyzer = new DemoAnalyzer(), seed = false) {
  const mail = new DemoMailbox(),
    store = new MemoryStore();
  if (seed) store.value.session = demoSession();
  const c = new Controller(mail, analyzer, store, 'demo', 'fictional', 2);
  await c.init();
  return { c, mail, store };
}
test('finite additional count and order; previous results remain in the pool', async () => {
  const { c, mail } = await setup();
  await c.start(scope);
  expect(c.completed).toBe(4);
  expect(c.session?.uids).toEqual([100, 101, 102, 103]);
  expect(mail.rows.every((m) => !m.read)).toBe(true);
  await c.start(scope);
  expect(c.session?.uids).toEqual([104, 105, 106, 107]);
  expect(c.pool).toHaveLength(8);
  expect(c.pool.every((m) => m.analysis)).toBe(true);
  await c.close();
});
test('statistics require no analyzer and include read emails', async () => {
  const { c, mail } = await setup({
    analyze: async () => {
      throw new Error('Must not call AI');
    },
  });
  mail.rows[0].read = true;
  await c.start({ ...scope, mode: 'subscriptions' });
  expect(c.messages).toHaveLength(4);
  expect(c.messages[0].read).toBe(true);
  expect(c.completed).toBe(0);
  await c.close();
});
test('malformed output remains retryable; provider failure stops; a fresh batch retries remaining mail', async () => {
  let bad = true;
  const delegate = new DemoAnalyzer();
  const { c } = await setup({
    analyze: async (m, s) => {
      if (bad && m.uid === 100) throw new Error('Bad model output');
      return delegate.analyze(m, s);
    },
  });
  await c.start(scope);
  expect(c.failed).toBe(1);
  expect(c.completed).toBe(3);
  bad = false;
  await c.retry();
  expect(c.completed).toBe(4);
  await c.close();
  let offline = true;
  const result = await setup({
    analyze: async (m, s) => {
      if (offline) throw new ProviderFailure('Offline');
      return delegate.analyze(m, s);
    },
  });
  await result.c.start(scope);
  expect(result.c.session?.state).toBe('stopped');
  expect(result.c.providerFailure).toBe('service');
  offline = false;
  await result.c.start(scope);
  expect(result.c.completed).toBe(4);
  expect(result.c.providerFailure).toBeUndefined();
  await result.c.close();
});
test('explicit selection, duplicate invocation protection, verified undo and stale state', async () => {
  const { c, mail } = await setup(undefined, true);
  const m = c.messages[6];
  await Promise.all([c.apply([m.id, m.id]), c.apply([m.id])]);
  expect(c.session?.receipts).toHaveLength(1);
  expect(m.read).toBe(true);
  expect(mail.rows.filter((m) => m.read)).toHaveLength(1);
  await c.undo(c.session!.receipts[0].id);
  expect(m.read).toBe(false);
  expect(c.session?.receipts[0].status).toBe('undone');
  mail.rows[6].read = true;
  await c.apply([m.id]);
  expect(c.session?.receipts[0].status).toBe('skipped');
  expect(m.read).toBe(false);
  await c.close();
});
test('unconfirmed server outcome never claims success and is not replayed on restart', async () => {
  const { c, mail, store } = await setup(undefined, true);
  mail.setRead = async () => {
    throw new Error('Disconnected after STORE');
  };
  await c.apply([c.messages[0].id]);
  expect(c.session?.receipts[0].status).toBe('unknown');
  expect(c.messages[0].read).toBe(false);
  const restarted = new Controller(mail, new DemoAnalyzer(), store, 'demo', 'fictional');
  await restarted.init();
  expect(restarted.session?.receipts[0].status).toBe('unknown');
  await restarted.close();
});
test('stop discards the batch; restart keeps results and a new batch selects fresh count and order', async () => {
  const { c, mail, store } = await setup();
  const run = c.start({ ...scope, limit: 14 });
  await Bun.sleep(70);
  await c.stop();
  await run;
  expect(c.session?.state).toBe('stopped');
  expect(c.completed).toBeGreaterThan(0);
  expect(c.completed).toBeLessThan(14);
  const restarted = new Controller(mail, new DemoAnalyzer(), store, 'demo', 'fictional');
  await restarted.init();
  expect(restarted.busy).toBe(false);
  expect(restarted.session?.uids).toEqual([]);
  const finished = restarted.pool.filter((m) => m.analysis).map((m) => m.uid);
  await restarted.start({ ...scope, limit: 2, order: 'newest' });
  expect(restarted.session?.uids).toEqual([113, 112]);
  expect(restarted.pool.filter((m) => m.analysis)).toHaveLength(finished.length + 2);
  expect(mail.rows.every((m) => !m.read)).toBe(true);
  await restarted.close();
});
test('quit during snapshot waits and stops review before AI calls', async () => {
  const { c, mail } = await setup({
    analyze: async () => {
      throw new Error('Must not start');
    },
  });
  const snapshot = mail.snapshot.bind(mail);
  mail.snapshot = async (s) => {
    await Bun.sleep(30);
    return snapshot(s);
  };
  const run = c.start(scope);
  await c.close();
  await run;
  expect(c.completed).toBe(0);
  expect(c.session).toBeUndefined();
});
test('encrypted storage roundtrip, lock exclusion, permissions and tamper rejection', async () => {
  const path = await mkdtemp(join(tmpdir(), 'inboxtop-test-'));
  try {
    const store = await new EncryptedStore(path).init();
    const saved = { version: 1 as const, cache: {}, session: demoSession() };
    await store.save(saved);
    const raw = await readFile(join(path, 'session.enc'));
    expect(raw.includes(Buffer.from('Sarah Chen'))).toBe(false);
    expect((await stat(join(path, 'cache.key'))).mode & 0o777).toBe(0o600);
    await expect(new EncryptedStore(path).init()).rejects.toThrow('Another inboxtop');
    expect((await store.load()).session?.messages).toHaveLength(14);
    await store.close();
    const reopened = await new EncryptedStore(path).init();
    expect((await reopened.load()).session?.uids).toHaveLength(14);
    raw[raw.length - 1] ^= 1;
    await writeFile(join(path, 'session.enc'), raw);
    await expect(reopened.load()).rejects.toThrow('left untouched');
    await reopened.close();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test('failed persistence still releases mailbox and store resources on close', async () => {
  const { c, mail, store } = await setup();
  let mailClosed = false,
    storeClosed = false;
  mail.close = async () => {
    mailClosed = true;
  };
  store.close = async () => {
    storeClosed = true;
  };
  store.save = async () => {
    throw new Error('Disk unavailable');
  };
  await expect(c.start(scope)).rejects.toThrow('Disk unavailable');
  await expect(c.close()).rejects.toThrow('Disk unavailable');
  expect(mailClosed).toBe(true);
  expect(storeClosed).toBe(true);
});

test('read queue accepts other emails, deduplicates pending IDs and verifies writes serially', async () => {
  const { c, mail } = await setup(undefined, true);
  const [first, second, third] = c.messages;
  const original = mail.setRead.bind(mail);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  mail.setRead = async (m, value, expected) => {
    calls.push(m.id);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      if (m.id === first.id) {
        await gate;
        throw new Error('Unconfirmed server outcome');
      }
      return await original(m, value, expected);
    } finally {
      inFlight--;
    }
  };
  try {
    const one = c.apply([first.id]);
    while (!calls.length) await Bun.sleep(1);
    const two = c.apply([first.id, second.id, second.id, third.id]);
    expect(c.pendingReads).toEqual({
      [first.id]: 'updating',
      [second.id]: 'queued',
      [third.id]: 'queued',
    });
    expect(c.writeProgress?.total).toBe(3);
    expect(calls).toEqual([first.id]);
    // A queued email that disappears is rechecked and never sent.
    third.present = false;
    release();
    await Promise.all([one, two]);
    expect(calls).toEqual([first.id, second.id]);
    expect(maxInFlight).toBe(1);
    expect(first.read).toBe(false);
    expect(second.read).toBe(true);
    expect(c.session!.receipts.find((r) => r.messageId === first.id)?.status).toBe('unknown');
    expect(c.pendingReads).toEqual({});
    expect(c.mutating).toBe(false);
  } finally {
    release();
    await c.close();
  }
});

test('batched reads persist intent before writes, save per chunk and retain per-email undo', async () => {
  const { c, mail, store } = await setup(undefined, true);
  const seed = c.messages[0];
  c.session!.messages = Array.from({ length: 60 }, (_, i) => ({
    ...structuredClone(seed),
    uid: 1000 + i,
    id: `demo:INBOX:1:${1000 + i}`,
  }));
  c.session!.uids = c.messages.map((m) => m.uid);
  mail.rows = structuredClone(c.messages);
  const ids = c.messages.map((m) => m.id);
  const chunks: number[] = [];
  let saves = 0;
  const save = store.save.bind(store);
  store.save = async (value) => {
    saves++;
    await save(value);
  };
  c.mail.setReadMany = async (rows, value, expected) => {
    chunks.push(rows.length);
    for (const m of rows)
      expect(store.value.session!.receipts.find((r) => r.messageId === m.id)?.status).toBe(
        'pending',
      );
    const result = new Map<string, import('../src/domain.ts').ReadResult>();
    for (const m of rows) {
      result.set(
        m.id,
        m.id === ids[1]
          ? 'unknown'
          : m.id === ids[2]
            ? 'skipped'
            : await mail.setRead(m, value, expected),
      );
    }
    return result;
  };
  try {
    await c.apply(ids);
    expect(chunks).toEqual([50, 10]);
    expect(saves).toBe(4);
    expect(c.messages.filter((m) => m.read)).toHaveLength(58);
    expect(c.session!.receipts.find((r) => r.messageId === ids[1])?.status).toBe('unknown');
    expect(c.session!.receipts.find((r) => r.messageId === ids[2])?.status).toBe('skipped');
    const receipt = c.session!.receipts.find((r) => r.messageId === ids[0])!;
    await c.undo(receipt.id);
    expect(c.messages[0].read).toBe(false);
    expect(receipt.status).toBe('undone');
  } finally {
    await c.close();
  }
});

test('a failed pre-write batch save prevents any mailbox mutation', async () => {
  const { c, store } = await setup(undefined, true);
  const save = store.save.bind(store);
  let writes = 0;
  c.mail.setReadMany = async () => {
    writes++;
    return new Map();
  };
  store.save = async () => {
    throw new Error('Disk full');
  };
  try {
    await expect(c.apply(c.messages.slice(0, 3).map((m) => m.id))).rejects.toThrow('Disk full');
    expect(writes).toBe(0);
    expect(c.pendingReads).toEqual({});
    expect(c.mutating).toBe(false);
  } finally {
    store.save = save;
    await c.close();
  }
});
