import { test, expect } from 'bun:test';
import { Controller } from '../src/controller.ts';
import { DemoMailbox, demoMessages } from '../src/demo.ts';
import { MemoryStore } from '../src/store.ts';
import { routeClassification, CLASSIFIER_MODEL } from '../src/classification.ts';
import { inboxStats, barCells } from '../src/inbox-stats.ts';
import { pendingDetail, analysisReady, outcomeOf } from '../src/decisions.ts';
import { routine } from './classification-fixtures.ts';
import type { Analyzer, Message } from '../src/domain.ts';
const all = { mode: 'unread', limit: null, order: 'oldest' } as const;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function until(c: Controller, condition: () => boolean) {
  if (condition()) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      c.off('change', changed);
    };
    const changed = () => {
      if (condition()) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Condition timed out'));
    }, 2000);
    c.on('change', changed);
    changed();
  });
}
function classifier(m: Message, important = m.uid === 100) {
  return routeClassification(
    important ? { ...routine, action: 0.99, routine: 0.01 } : routine,
    m,
    m.body.length,
    'openai',
    CLASSIFIER_MODEL,
  );
}

test('slow deep review does not block the classifier; routine mail never calls the deep model', async () => {
  const gate = deferred();
  let classified = 0,
    detailed = 0;
  const analyzer: Analyzer = {
    async classify(m) {
      classified++;
      return classifier(m);
    },
    async analyze(m, signal) {
      detailed++;
      await Promise.race([
        gate.promise,
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
      ]);
      return structuredClone(demoMessages().find((x) => x.id === m.id)!.analysis!);
    },
  };
  const c = new Controller(
    new DemoMailbox(),
    analyzer,
    new MemoryStore(),
    'openai',
    'gpt-6.1-sol',
    1,
  );
  await c.init();
  const task = c.start(all);
  try {
    await until(c, () => c.progress.classified === 14 && detailed === 1);
    expect(c.busy).toBe(true);
    expect(classified).toBe(14);
    expect(c.messages.filter(pendingDetail)).toHaveLength(1);
    expect(c.messages.filter(analysisReady)).toHaveLength(13);
    expect(outcomeOf(c.messages.find((m) => m.uid === 100)!)).toBe('act');
    expect(c.progress.detail).toBe(1);
    gate.resolve();
    await task;
    expect(detailed).toBe(1);
    expect(c.completed).toBe(14);
    expect(c.session!.state).toBe('complete');
    await c.start(all);
    expect(classified).toBe(14);
    expect(detailed).toBe(1);
    c.model = 'different-detail-model';
    await c.start(all);
    expect(classified).toBe(14);
    expect(detailed).toBe(1);
    expect(c.pool).toHaveLength(14);
    expect(c.session!.uids).toHaveLength(0);
    expect(c.messages.every((m) => !m.read)).toBe(true);
  } finally {
    gate.resolve();
    await task;
    await c.close();
  }
});

test('stop retains classification as reusable data; a fresh batch finishes remaining summaries', async () => {
  const store = new MemoryStore();
  let classifications = 0;
  const analyzer: Analyzer = {
    async classify(m) {
      classifications++;
      return classifier(m);
    },
    async analyze(_m, signal) {
      return new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const c = new Controller(new DemoMailbox(), analyzer, store, 'openai', 'sol', 1);
  await c.init();
  const run = c.start(all);
  await until(c, () => c.progress.classified === 14);
  await c.stop();
  await run;
  expect(c.session!.state).toBe('stopped');
  expect(c.messages.filter(pendingDetail)).toHaveLength(1);
  await c.close();
  let details = 0;
  const resumed = new Controller(
    new DemoMailbox(),
    {
      ...analyzer,
      async analyze(m) {
        details++;
        return structuredClone(demoMessages().find((x) => x.id === m.id)!.analysis!);
      },
    },
    store,
    'openai',
    'sol',
    1,
  );
  await resumed.init();
  await resumed.start(all);
  expect(classifications).toBe(14);
  expect(details).toBe(1);
  expect(
    resumed.pool.filter((m) => m.analysis || (m.classification && !m.classification.needsDetail)),
  ).toHaveLength(14);
  await resumed.close();
});

test('whole-inbox map covers saved work outside the chosen batch and verified read/undo', async () => {
  const mail = new DemoMailbox();
  const c = new Controller(
    mail,
    {
      async classify(m) {
        return classifier(m, false);
      },
      async analyze() {
        throw new Error('Routine mail must not escalate');
      },
    },
    new MemoryStore(),
    'openai',
    'sol',
  );
  await c.init();
  await c.start({ ...all, limit: 2 });
  expect(inboxStats(c)).toMatchObject({
    total: 14,
    classified: 2,
    ready: 2,
    unclassified: 12,
    outcomes: { clear: 2 },
  });
  const first = c.messages[0];
  await c.start({ ...all, order: 'newest', limit: 2 });
  expect(inboxStats(c)).toMatchObject({ total: 14, classified: 4, ready: 4, unclassified: 10 });
  const last = c.messages[0];
  await c.apply([last.id]);
  expect(inboxStats(c)).toMatchObject({ total: 13, ready: 3 });
  await c.undo(c.session!.receipts[0].id);
  expect(inboxStats(c)).toMatchObject({ total: 14, ready: 4 });
  mail.rows.find((m) => m.id === first.id)!.read = true;
  await c.start({ ...all, order: 'newest', limit: 2 });
  expect(inboxStats(c)).toMatchObject({ total: 13, ready: 5 });
  expect(c.messages).toHaveLength(2);
  const snapshot = mail.snapshot.bind(mail);
  mail.snapshot = async (scope) => ({
    ...(await snapshot(scope)),
    identity: { account: 'demo', mailbox: 'INBOX', validity: '2' },
  });
  // Identity changes exclude old classifications even before new bodies arrive.
  mail.fetch = async () => {
    throw new Error('changed identity fixture');
  };
  await c.start(all);
  expect(inboxStats(c).classified).toBe(0);
  await c.close();
});

test('classification failure stays retryable without silently calling a stronger model', async () => {
  let fail = true,
    details = 0;
  const c = new Controller(
    new DemoMailbox(),
    {
      async classify(m) {
        if (fail) throw new Error('Refused');
        return classifier(m, false);
      },
      async analyze() {
        details++;
        throw new Error('Must not run');
      },
    },
    new MemoryStore(),
    'openai',
    'sol',
  );
  await c.init();
  await c.start({ ...all, limit: 2 });
  expect(c.failed).toBe(2);
  expect(details).toBe(0);
  expect(c.completed).toBe(0);
  fail = false;
  await c.retry();
  expect(c.failed).toBe(0);
  expect(c.completed).toBe(2);
  expect(details).toBe(0);
  await c.close();
});

test('newsletter digest is explicitly requested, cached and invalidated when membership changes', async () => {
  let details = 0,
    digests = 0;
  const c = new Controller(
    new DemoMailbox(),
    {
      async classify(m) {
        return classifier(m, false);
      },
      async analyze(m) {
        details++;
        return structuredClone(demoMessages().find((x) => x.id === m.id)!.analysis!);
      },
      async digest(rows) {
        digests++;
        return 'Combined digest of ' + rows.length + ' issues.';
      },
    },
    new MemoryStore(),
    'openai',
    'sol',
  );
  await c.init();
  await c.start({ ...all, limit: 2 });
  expect(details).toBe(0);
  expect(digests).toBe(0);
  const ids = c.messages.map((m) => m.id);
  await c.reviewNewsletter(ids);
  expect(details).toBe(0);
  expect(digests).toBe(1);
  expect(c.newsletterDigest(ids)?.text).toContain('2 issues');
  await c.reviewNewsletter(ids);
  expect(digests).toBe(1);
  await c.apply([ids[0]]);
  // The all-issues digest survives read changes; the unread scope has fewer IDs.
  expect(c.newsletterDigest(ids)?.text).toContain('2 issues');
  expect(c.newsletterDigest(ids.slice(1))).toBeUndefined();
  await c.reviewNewsletter(ids.slice(1));
  expect(digests).toBe(2);
  await c.close();
});

test('bars allocate exact widths without inventing progress for empty or unknown inboxes', () => {
  expect(barCells([0, 0, 0], 20)).toEqual([0, 0, 0]);
  expect(barCells([1, 1, 1], 20).reduce((n, v) => n + v, 0)).toBe(20);
  expect(barCells([0, 1, 0], 20)).toEqual([0, 20, 0]);
  expect(barCells([1, 9999], 20).reduce((n, v) => n + v, 0)).toBe(20);
});

test('failed subscription synthesis preserves individual reviews and can be retried', async () => {
  const c = new Controller(
    new DemoMailbox(),
    {
      async classify(m) {
        return classifier(m, false);
      },
      async analyze() {
        throw new Error('Detailed provider failed');
      },
      async digest() {
        throw new Error('Summary provider failed');
      },
    },
    new MemoryStore(),
    'openai',
    'sol',
  );
  await c.init();
  await c.start({ ...all, limit: 1 });
  const m = c.messages[0];
  await c.reviewNewsletter([m.id]);
  expect(m.classification?.route).toBe('clear');
  expect(m.error).toBeUndefined();
  expect(c.status).toContain('Summary provider failed');
  expect(c.status).toContain(m.sender);
  expect(c.newsletterProgress).toBeUndefined();
  expect(outcomeOf(m)).toBe('clear');
  c.analyzer.digest = async () => 'Recovered summary';
  await c.reviewNewsletter([m.id]);
  expect(c.newsletterDigest([m.id])?.text).toBe('Recovered summary');
  expect(pendingDetail(m)).toBe(false);
  expect(c.saved.classifications).toBeDefined();
  await c.close();
});

test('subscription synthesis reuses classification-only findings without upgrading or changing reviews', async () => {
  let details = 0;
  const c = new Controller(
    new DemoMailbox(),
    {
      async classify(m) {
        return classifier(m, false);
      },
      async analyze(m) {
        details++;
        return {
          ...structuredClone(demoMessages().find((row) => row.id === m.id)!.analysis!),
          coverage: { stage: 'detail' as const, characters: m.body.length, total: m.body.length },
        };
      },
      async digest(rows) {
        return `Digest with ${rows.length} saved findings`;
      },
    },
    new MemoryStore(),
    'openai',
    'sol',
  );
  try {
    await c.init();
    await c.start({ ...all, limit: 2 });
    for (const m of c.messages)
      m.analysis = {
        ...structuredClone(demoMessages().find((row) => row.id === m.id)!.analysis!),
        coverage: { stage: 'triage', characters: 20, total: m.body.length },
      };
    const ids = c.messages.map((m) => m.id);
    await c.reviewNewsletter(ids);
    expect(details).toBe(0);
    expect(c.messages.every((m) => m.analysis?.coverage?.stage === 'triage')).toBe(true);
    await c.reviewNewsletter(ids);
    expect(details).toBe(0);
    expect(c.messages.every((m) => !m.read)).toBe(true);
  } finally {
    await c.close();
  }
});
