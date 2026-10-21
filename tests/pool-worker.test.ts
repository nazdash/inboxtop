import { test, expect, spyOn } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatSession, EMPTY_SEARCH } from '../src/chat.ts';
import { Controller } from '../src/controller.ts';
import { DemoMailbox, DemoAnalyzer, demoMessages, demoSession } from '../src/demo.ts';
import { MemoryStore } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';
import { analysisReady, decisionQueues } from '../src/decisions.ts';
import { routeClassification } from '../src/classification.ts';
import { routine } from './classification-fixtures.ts';
import { inboxStats } from '../src/inbox-stats.ts';
import { ProviderFailure } from '../src/analysis.ts';
import { menuStatus } from '../src/menu-status.ts';
import { serveWorker, RemoteController, workerRequest, servicePlist } from '../src/worker.ts';
import type { Analyzer, Message } from '../src/domain.ts';
const all = { mode: 'unread', limit: null, order: 'oldest' } as const;
function classifier(m: Message, important = false) {
  return routeClassification(
    important ? { ...routine, action: 0.99, routine: 0.01 } : routine,
    m,
    m.body.length,
    'openai',
    'gpt-6-luna',
  );
}
function instant(): Analyzer {
  return {
    classify: async (m) => classifier(m),
    analyze: async () => {
      throw new Error('Routine mail must not reach deep review');
    },
  };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error('Condition timed out');
}
test('additional batches skip all completed results across restarts and changed models', async () => {
  const store = new MemoryStore(),
    mail = new DemoMailbox();
  const ids: number[] = [];
  const analyzer = {
    ...instant(),
    classify: async (m: Message) => {
      ids.push(m.uid);
      return classifier(m);
    },
  };
  let c = new Controller(mail, analyzer, store, 'openai', 'old');
  await c.init();
  await c.syncInbox();
  expect(inboxStats(c)).toMatchObject({ total: 14, ready: 0, unanalyzed: 14 });
  await c.start({ ...all, limit: 2 });
  expect(ids).toEqual([100, 101]);
  await c.close();
  c = new Controller(mail, analyzer, store, 'ollama', 'new');
  await c.init();
  await c.start({ ...all, limit: 2 });
  expect(ids).toEqual([100, 101, 102, 103]);
  expect(c.pool).toHaveLength(4);
  expect(decisionQueues(c.pool).clear).toHaveLength(4);
  await c.start(all);
  await c.start(all);
  expect(ids).toHaveLength(14);
  expect(c.pool).toHaveLength(14);
  await c.close();
});

test('unfinished detail stays out of outcomes; synchronization removes externally read mail while busy', async () => {
  const mail = new DemoMailbox(),
    store = new MemoryStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const c = new Controller(
    mail,
    {
      classify: async (m) => classifier(m, true),
      analyze: async (m) => {
        await gate;
        return demoMessages().find((row) => row.id === m.id)!.analysis!;
      },
    },
    store,
    'openai',
    'sol',
    1,
  );
  await c.init();
  const run = c.start({ ...all, limit: 1 });
  try {
    await until(() => c.progress.classified === 1);
    expect(decisionQueues(c.pool).act).toHaveLength(0);
    expect(inboxStats(c)).toMatchObject({ total: 14, ready: 0, unanalyzed: 14 });
    mail.rows[0].read = true;
    await c.syncInbox();
    expect(c.pool).toHaveLength(0);
    expect(inboxStats(c).total).toBe(13);
    release();
    await run;
    expect(decisionQueues(c.pool).act).toHaveLength(0);
  } finally {
    release();
    await run;
    await c.close();
  }
});

test('legacy interrupted batches are discarded; Ad hoc stays idle and Live starts oldest remaining mail', async () => {
  for (const mode of ['adhoc', 'live'] as const) {
    const store = new MemoryStore();
    const old = demoSession();
    const complete = structuredClone(old.messages[0]);
    const unfinished = structuredClone(old.messages.at(-1)!);
    unfinished.analysis = undefined;
    old.messages = [unfinished];
    old.uids = [unfinished.uid];
    old.scope = { mode: 'unread', limit: 1, order: 'newest' };
    old.state = 'paused';
    store.value.session = old;
    store.value.library = { [complete.id]: complete };
    store.value.mode = mode;
    const calls: number[] = [];
    const c = new Controller(
      new DemoMailbox(),
      {
        ...instant(),
        classify: async (m) => {
          calls.push(m.uid);
          return classifier(m);
        },
      },
      store,
      'openai',
      'sol',
    );
    try {
      await c.init();
      expect(c.session?.uids).toEqual([]);
      expect(c.busy).toBe(false);
      await c.tick();
      if (mode === 'adhoc') {
        expect(calls).toEqual([]);
        expect(inboxStats(c)).toMatchObject({ total: 14, ready: 1, unanalyzed: 13 });
        await c.start({ ...all, limit: 2, order: 'oldest' });
        expect(calls).toEqual([101, 102]);
      } else {
        expect(calls).toEqual(Array.from({ length: 13 }, (_, i) => 101 + i));
        expect(inboxStats(c)).toMatchObject({ total: 14, ready: 14, unanalyzed: 0 });
      }
    } finally {
      await c.close();
    }
  }
});

test('Live enqueues incoming mail oldest first; stopped Live returns to Ad hoc and still synchronizes', async () => {
  const mail = new DemoMailbox(),
    calls: number[] = [];
  const c = new Controller(
    mail,
    {
      ...instant(),
      classify: async (m) => {
        calls.push(m.uid);
        return classifier(m);
      },
    },
    new MemoryStore(),
    'openai',
    'sol',
  );
  await c.init();
  c.saved.mode = 'live';
  await c.tick();
  expect(calls).toEqual(mail.rows.map((m) => m.uid));
  await c.stop();
  const added = { ...mail.rows[0], id: 'demo:INBOX:1:200', uid: 200, analysis: undefined };
  mail.rows.push(added);
  mail.rows[0].read = true;
  await c.tick();
  expect(calls).toHaveLength(14);
  expect(inboxStats(c).total).toBe(14);
  expect(c.pool.some((m) => m.uid === 100)).toBe(false);
  await c.setMode('live');
  await until(() => !c.busy && calls.includes(200));
  expect(calls).toHaveLength(15);
  expect(c.mode).toBe('live');
  await c.setMode('adhoc');
  mail.rows.push({ ...added, id: 'demo:INBOX:1:201', uid: 201 });
  await c.tick();
  expect(calls).toHaveLength(15);
  await c.close();
});

test('completed unread results are never evicted at the old 1000-message boundary', async () => {
  const store = new MemoryStore();
  const template = demoMessages()[0];
  store.value.library = Object.fromEntries(
    Array.from({ length: 1100 }, (_, i) => {
      const m = { ...template, id: `demo:INBOX:1:${1000 + i}`, uid: 1000 + i };
      return [m.id, m];
    }),
  );
  const mail = new DemoMailbox();
  mail.rows = Object.values(store.value.library);
  const c = new Controller(mail, instant(), store, 'openai', 'sol');
  await c.init();
  await c.syncInbox();
  await c.start(all);
  expect(c.pool).toHaveLength(1100);
  expect(Object.keys(store.value.library!)).toHaveLength(1100);
  expect(c.pool.every(analysisReady)).toBe(true);
  await c.close();
});

test('aggregate synthesis is cached, and stale prose is hidden as soon as membership changes', async () => {
  const store = new MemoryStore();
  store.value.session = demoSession();
  let calls = 0;
  const c = new Controller(
    new DemoMailbox(),
    {
      ...instant(),
      summarizeInbox: async (rows) => {
        calls++;
        return `Saved synthesis for ${rows.length} messages.`;
      },
    },
    store,
    'openai',
    'sol',
  );
  await c.init();
  await c.syncInbox();
  c.saved.inboxSummary = {
    key: 'old-summary-format',
    text: 'Saved findings cover many emails, evidence is partial.',
    messageIDs: c.pool.map((m) => m.id),
    created: new Date().toISOString(),
  };
  expect(c.inboxSummary).not.toContain('evidence is partial');
  await c.refreshInboxSummary();
  expect(c.inboxSummary).toBe('Saved synthesis for 14 messages.');
  await c.updateInboxSummary();
  expect(calls).toBe(1);
  await c.apply([c.pool[0].id]);
  expect(c.inboxSummary).not.toContain('14 messages');
  await c.updateInboxSummary();
  expect(c.inboxSummary).toBe('Saved synthesis for 13 messages.');
  expect(calls).toBe(2);
  await c.close();
});

test('private worker survives terminal detach, shares analysis with another client, and validates commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-worker-'));
  const socket = join(dir, 'w.sock');
  const store = new MemoryStore(),
    mail = new DemoMailbox();
  const c = new Controller(mail, instant(), store, 'openai', 'sol');
  await c.init();
  const server = await serveWorker(c, socket);
  const config = loadConfig(false, {});
  const first = new RemoteController(socket, config),
    second = new RemoteController(socket, config);
  try {
    await first.init();
    await first.start({ ...all, limit: 2 });
    await first.close();
    await until(() => !c.busy);
    await second.init();
    expect(second.pool).toHaveLength(2);
    expect(mail.rows.some((m) => m.read)).toBe(false);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    await expect(
      workerRequest(socket, '/command', { command: 'shell', value: 'echo bad' }),
    ).rejects.toThrow();
    await expect(
      workerRequest(socket, '/command', { command: 'start', value: { ...all, limit: -1 } }),
    ).rejects.toThrow();
    await second.apply([second.pool[0].id]);
    await until(() => !c.mutating);
    await second.pull();
    expect(second.pool).toHaveLength(1);
    expect(mail.rows.filter((m) => m.read)).toHaveLength(1);
    await second.setMode('live');
    await until(() => !c.busy);
    await second.pull();
    expect(second.mode).toBe('live');
  } finally {
    await first.close();
    await second.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await c.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker shares the exact subscription generation target and clears it after cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-digest-progress-'));
  const socket = join(dir, 'w.sock');
  const store = new MemoryStore();
  store.value.session = demoSession();
  const analyzer: Analyzer = new DemoAnalyzer();
  analyzer.digest = async (_messages, signal) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const c = new Controller(new DemoMailbox(), analyzer, store, 'demo', 'fictional');
  await c.init();
  const server = await serveWorker(c, socket);
  const client = new RemoteController(socket, loadConfig(false, {}));
  try {
    await client.init();
    const target = c.messages[3];
    await client.reviewNewsletter([target.id]);
    expect(client.newsletterProgress).toEqual({ messageIDs: [target.id], sender: target.sender });
    expect(client.newsletterGenerating([c.messages[0].id])).toBe(false);
    await client.reviewNewsletter([c.messages[0].id]);
    expect(client.newsletterProgress?.messageIDs).toEqual([target.id]);
    expect(client.reviewJob('newsletter', [c.messages[0].id])?.state).toBe('queued');
    const secondClient = new RemoteController(socket, loadConfig(false, {}));
    await secondClient.init();
    try {
      await secondClient.reviewNewsletter([c.messages[0].id]);
      expect(secondClient.reviewJobs.filter((j) => j.state === 'queued')).toHaveLength(1);
      expect(secondClient.reviewJob('newsletter', [target.id])?.state).toBe('running');
    } finally {
      await secondClient.close();
    }

    await client.pause();
    await until(() => !c.busy);
    await client.pull();
    expect(client.newsletterProgress).toBeUndefined();
    expect(client.newsletterDigest([target.id])).toBeUndefined();
    expect(client.reviewJobs.every((j) => j.state === 'cancelled')).toBe(true);
  } finally {
    await c.pause();
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await c.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('macOS service configuration has absolute paths and no API or IMAP secrets', () => {
  const config = loadConfig(false, { OPENAI_API_KEY: 'secret-api', EMAIL_PASSWORD: 'secret-imap' });
  const plist = servicePlist(config, '/tmp/private & config.env');
  expect(plist.text).toContain('/tmp/private &amp; config.env');
  expect(plist.text).toContain('--worker');
  expect(plist.text).not.toContain('secret-api');
  expect(plist.text).not.toContain('secret-imap');
  expect(plist.text).toContain('<key>KeepAlive</key><true/>');
});

test('the real CLI attaches to an existing worker, prints counts, and exits without stopping it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-cli-'));
  const { writeFile } = await import('node:fs/promises');
  const { workerSocket } = await import('../src/worker.ts');
  const config = loadConfig(false, {
    EMAIL_ADDRESS: 'fictional@example.invalid',
    EMAIL_PASSWORD: 'fictional',
    IMAP_SERVER: 'fixture.invalid',
    OPENAI_API_KEY: 'fictional',
    INBOXTOP_DATA_DIR: dir,
  });
  const envPath = join(dir, 'test.env');
  await writeFile(
    envPath,
    `EMAIL_ADDRESS=fictional@example.invalid\nEMAIL_PASSWORD=fictional\nIMAP_SERVER=fixture.invalid\nOPENAI_API_KEY=fictional\nINBOXTOP_DATA_DIR=${dir}\n`,
    { mode: 0o600 },
  );
  const c = new Controller(new DemoMailbox(), instant(), new MemoryStore(), 'openai', 'sol');
  await c.init();
  const socket = workerSocket(config);
  const server = await serveWorker(c, socket);
  try {
    const child = Bun.spawn(
      [process.execPath, join(process.cwd(), 'src/index.ts'), '--once', '--env', envPath],
      {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    const timeout = setTimeout(() => child.kill(), 3000);
    try {
      const status = await child.exited;
      const out = await new Response(child.stdout).text(),
        err = await new Response(child.stderr).text();
      if (status !== 0)
        throw new Error(JSON.stringify({ status, out, err, pool: c.pool.length, busy: c.busy }));
      expect(err).toBe('');
      expect(status).toBe(0);
      if (JSON.parse(out).inbox.ready !== 14)
        throw new Error(JSON.stringify({ out, err, pool: c.pool.length, busy: c.busy }));
      expect(JSON.parse(out).inbox.ready).toBe(14);
      expect(await workerRequest(socket, '/ping')).toMatchObject({ ok: true, protocol: 31 });
      expect(c.pool).toHaveLength(14);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await c.close();
    await rm(dir, { recursive: true, force: true });
    await rm(socket.slice(0, socket.lastIndexOf('/')), { recursive: true, force: true });
  }
});

test('explicit env files cannot inherit a different account or credentials from Bun auto-loaded environment', async () => {
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-env-')),
    path = join(dir, 'explicit.env');
  try {
    await writeFile(
      path,
      'EMAIL_ADDRESS=selected@example.invalid\nIMAP_SERVER=selected.invalid\nEMAIL_PASSWORD=selected-password\n',
    );
    const config = loadConfig(path, {
      EMAIL_ADDRESS: 'wrong@example.invalid',
      IMAP_SERVER: 'wrong.invalid',
      EMAIL_PASSWORD: 'wrong-password',
      OPENAI_API_KEY: 'wrong-api-key',
    });
    expect(config.address).toBe('selected@example.invalid');
    expect(config.host).toBe('selected.invalid');
    expect(config.password).toBe('selected-password');
    expect(config.apiKey).toBe('');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a summary remains publishable when new results arrive, but never after a source leaves the pool', async () => {
  const store = new MemoryStore();
  store.value.session = demoSession();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const c = new Controller(
    new DemoMailbox(),
    {
      ...instant(),
      summarizeInbox: async (rows) => {
        await gate;
        return `Snapshot of ${rows.length} ready messages.`;
      },
    },
    store,
    'openai',
    'sol',
  );
  await c.init();
  const work = c.updateInboxSummary();
  const added = { ...structuredClone(demoMessages()[0]), id: 'demo:INBOX:1:200', uid: 200 };
  c.saved.library![added.id] = added;
  release();
  await work;
  expect(c.saved.inboxSummary?.messageIDs).toHaveLength(14);
  expect(c.pool).toHaveLength(15);
  expect(c.inboxSummary).toContain('Snapshot of 14');
  c.pool[0].read = true;
  expect(c.inboxSummary).not.toContain('Snapshot of 14');
  await c.close();
});

test('Chat model requests run in the worker and client cancellation aborts only that request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-chat-worker-'));
  const socket = join(dir, 'w.sock');
  let activeSignal: AbortSignal | undefined;
  const response = {
    action: 'clarify' as const,
    plan: null,
    search: { ...EMPTY_SEARCH },
    sources: [],
    text: 'Which sender?',
  };
  const analyzer: Analyzer = {
    ...instant(),
    chatStep: async (input, signal) => {
      if (JSON.parse(input.context).question === 'wait') {
        activeSignal = signal;
        await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      return response;
    },
  };
  const c = new Controller(new DemoMailbox(), analyzer, new MemoryStore(), 'demo', 'fictional');
  await c.init();
  await c.syncInbox();
  const server = await serveWorker(c, socket);
  const remote = new RemoteController(socket, loadConfig(false, {}));
  try {
    await remote.init();
    await expect(remote.chatStep({ context: '{}' }, new AbortController().signal)).rejects.toThrow(
      'worker-owned',
    );
    await expect(workerRequest(socket, '/chat/step', { context: '{}' })).rejects.toThrow();
    const session = new ChatSession(
      () => [],
      async () => response,
    );
    let revision = await remote.saveChat(remote.chatScope, 0, session.snapshot());
    const run = await remote.startChat({
      turnID: crypto.randomUUID(),
      revision,
      question: 'Which sender?',
      retry: false,
    });
    await until(() => !c['runner'].busy);
    expect((await remote.chatRunState()).stored?.state.entries.at(-1)?.text).toBe(response.text);
    revision = (await remote.loadChat())!.revision;
    const waiting = await remote.startChat({
      turnID: crypto.randomUUID(),
      revision,
      question: 'wait',
      retry: false,
    });
    await until(() => !!activeSignal);
    await remote.cancelChat(waiting.turnID);
    await until(() => !!activeSignal?.aborted && !c['runner'].busy);
    expect((await remote.chatRunState()).stored?.state.error).toContain('Cancelled');
    expect(c.mutating).toBe(false);
    expect(c.busy).toBe(false);
  } finally {
    await remote.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await c.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker persists one current Chat and refuses stale terminal overwrites after reconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-chat-save-'));
  const socket = join(dir, 'w.sock');
  const store = new MemoryStore();
  store.value.session = demoSession();
  const c = new Controller(new DemoMailbox(), new DemoAnalyzer(), store, 'demo', 'fictional');
  await c.init();
  const server = await serveWorker(c, socket);
  const first = new RemoteController(socket, loadConfig(false, {}));
  const second = new RemoteController(socket, loadConfig(false, {}));
  try {
    await first.init();
    await second.init();
    const session = new ChatSession(
      () => [],
      async () => {
        throw new Error('No model calls');
      },
    );
    const state = session.snapshot('draft from first terminal', 5, 8);
    expect(await first.saveChat(first.chatScope, 0, state)).toBe(1);
    expect(await second.loadChat()).toEqual({ revision: 1, state });
    await expect(
      second.saveChat(second.chatScope, 0, session.snapshot('stale draft')),
    ).rejects.toThrow('another terminal');
    expect((await first.loadChat())?.state.draft).toBe('draft from first terminal');
    await first.close();
    const reopened = new RemoteController(socket, loadConfig(false, {}));
    try {
      await reopened.init();
      expect(reopened.saved.chats?.[reopened.chatScope]).toEqual({ revision: 1, state });
      expect(
        await reopened.saveChat(reopened.chatScope, 1, session.snapshot('updated draft')),
      ).toBe(2);
      await expect(
        workerRequest(socket, '/chat/save', {
          scope: reopened.chatScope,
          revision: 2,
          state: { version: 999 },
        }),
      ).rejects.toThrow();
      expect((await reopened.loadChat())?.state.draft).toBe('updated draft');
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    await second.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await c.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker accepts queued reads from two clients and finishes after they detach', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inboxtop-read-queue-'));
  const socket = join(dir, 'w.sock');
  const store = new MemoryStore();
  store.value.session = demoSession();
  const mail = new DemoMailbox();
  const c = new Controller(mail, new DemoAnalyzer(), store, 'demo', 'fictional');
  await c.init();
  const server = await serveWorker(c, socket);
  const first = new RemoteController(socket, loadConfig(false, {}));
  const second = new RemoteController(socket, loadConfig(false, {}));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = mail.setRead.bind(mail);
  const calls: string[] = [];
  mail.setRead = async (m, value, expected) => {
    calls.push(m.id);
    await gate;
    return original(m, value, expected);
  };
  try {
    await first.init();
    await second.init();
    const [a, b] = first.pool;
    await first.apply([a.id]);
    await until(() => calls.length === 1);
    await second.apply([a.id, b.id]);
    await second.pull();
    expect(second.pendingReads).toEqual({ [a.id]: 'updating', [b.id]: 'queued' });
    expect(calls).toEqual([a.id]);
    await first.close();
    await second.close();
    release();
    await until(() => !c.mutating);
    expect(calls).toEqual([a.id, b.id]);
    expect(c.pendingReads).toEqual({});
    expect(c.session!.receipts.filter((r) => r.status === 'succeeded')).toHaveLength(2);
  } finally {
    release();
    await first.close();
    await second.close();
    await c.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Live skips failed reviews without scheduling empty batches and still analyzes newly arrived mail', async () => {
  const mail = new DemoMailbox();
  mail.rows = [mail.rows[0]];
  const failed = { ...mail.rows[0], analysis: undefined, error: 'Evidence validation failed' };
  const store = new MemoryStore();
  store.value.session = { ...demoSession(), messages: [failed], uids: [failed.uid], total: 1 };
  store.value.library = { [failed.id]: failed };
  const calls: number[] = [];
  const c = new Controller(
    mail,
    {
      async analyze(m) {
        calls.push(m.uid);
        return demoMessages()[0].analysis!;
      },
    },
    store,
    'demo',
    'fictional',
  );
  await c.init();
  c.saved.mode = 'live';
  let batches = 0;
  const start = c.start.bind(c);
  c.start = async (scope) => {
    batches++;
    await start(scope);
  };
  try {
    for (let i = 0; i < 3; i++) {
      await c.tick();
      expect(c.hasPendingAnalysis).toBe(false);
    }
    expect(batches).toBe(0);
    expect(calls).toEqual([]);
    expect(inboxStats(c)).toMatchObject({ total: 1, ready: 0, outcomes: { check: 1 } });
    const arrived = { ...mail.rows[0], id: 'demo:INBOX:1:200', uid: 200, analysis: undefined };
    mail.rows.push(arrived);
    await c.syncInbox();
    expect(c.hasPendingAnalysis).toBe(true);
    await c.tick();
    expect(batches).toBe(1);
    expect(calls).toEqual([200]);
    expect(c.hasPendingAnalysis).toBe(false);
    expect(inboxStats(c)).toMatchObject({ total: 2, ready: 1, outcomes: { act: 1, check: 1 } });
    await c.tick();
    expect(batches).toBe(1);
    expect(c.pool.find((m) => m.id === failed.id)?.error).toBe(failed.error);
  } finally {
    await c.close();
  }
});

test('Live survives internal pauses, mailbox writes and worker shutdown; explicit Stop and mode choices persist', async () => {
  for (const action of ['pause', 'write', 'close', 'stop', 'adhoc'] as const) {
    const mail = new DemoMailbox();
    mail.rows = [mail.rows[0]];
    const store = new MemoryStore();
    let entered = false;
    const c = new Controller(
      mail,
      {
        async analyze(_message, signal) {
          entered = true;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          signal.throwIfAborted();
          return demoMessages()[0].analysis!;
        },
      },
      store,
      'demo',
      'fictional',
    );
    await c.init();
    c.saved.mode = 'live';
    const tick = c.tick();
    try {
      await until(() => entered);
      if (action === 'write') await c.apply([mail.rows[0].id]);
      else if (action === 'adhoc') await c.setMode('adhoc');
      else await c[action]();
      await tick;
      await until(() => !c.busy);
      const expected = action === 'stop' || action === 'adhoc' ? 'adhoc' : 'live';
      expect(c.mode).toBe(expected);
      expect(store.value.mode).toBe(expected);
      expect(c.analysisPaused).toBe(action === 'stop');
      if (action === 'write') expect(mail.rows[0].read).toBe(true);
      if (action === 'close') {
        const reopened = new Controller(mail, instant(), store, 'demo', 'fictional');
        await reopened.init();
        expect(reopened.mode).toBe('live');
        await reopened.close();
      }
    } finally {
      await c.close();
      await tick;
    }
  }
});

test('Live batch failures retain mode and back off automatic retries while syncing continues', async () => {
  for (const classified of [false, true]) {
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const mail = new DemoMailbox();
    mail.rows = [mail.rows[0]];
    const snapshot = spyOn(mail, 'snapshot');
    const store = new MemoryStore();
    let attempts = 0;
    let offline = true;
    const request = () => {
      attempts++;
      if (offline) throw new ProviderFailure('Fictional provider unavailable', 'connection');
    };
    const c = new Controller(
      mail,
      {
        ...(classified
          ? {
              classify: async (m: Message) => {
                request();
                return classifier(m);
              },
            }
          : {}),
        async analyze() {
          request();
          return demoMessages()[0].analysis!;
        },
      },
      store,
      'demo',
      'fictional',
    );
    await c.init();
    c.saved.mode = 'live';
    try {
      await c.tick();
      expect(attempts).toBe(1);
      expect(c.mode).toBe('live');
      expect(c.canStartLiveAnalysis).toBe(false);
      expect(menuStatus(c, 1).blockingIssue?.title).toBe('Cannot reach AI provider');
      const snapshots = snapshot.mock.calls.length;
      await c.tick();
      expect(snapshot.mock.calls.length).toBe(snapshots + 1);
      expect(attempts).toBe(1);
      for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
        now += delay - 1;
        expect(c.canStartLiveAnalysis).toBe(false);
        now++;
        expect(c.canStartLiveAnalysis).toBe(true);
        const before = attempts;
        await c.tick();
        expect(attempts).toBe(before + 1);
        expect(c.mode).toBe('live');
      }
      offline = false;
      now += 300_000;
      await c.tick();
      expect(c.session?.state).toBe('complete');
      expect(c.mode).toBe('live');
      expect(c.hasPendingAnalysis).toBe(false);
      expect(menuStatus(c, 2).blockingIssue).toBeNull();
      await c.stop();
      now += 600_000;
      await c.tick();
      expect(c.mode).toBe('adhoc');
      expect(c.canStartLiveAnalysis).toBe(false);
    } finally {
      await c.close();
      snapshot.mockRestore();
      clock.mockRestore();
    }
  }
});
