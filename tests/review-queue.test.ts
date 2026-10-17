import { test, expect } from 'bun:test';
import { Controller } from '../src/controller.ts';
import { DemoMailbox, DemoAnalyzer, demoSession } from '../src/demo.ts';
import { MemoryStore } from '../src/store.ts';
import { ProviderFailure } from '../src/analysis.ts';
import type { Analyzer } from '../src/domain.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error('Fictional queue did not reach expected state');
}
async function fixture() {
  const store = new MemoryStore();
  store.value.session = demoSession();
  const analyzer: Analyzer = new DemoAnalyzer();
  const mail = new DemoMailbox();
  const c = new Controller(mail, analyzer, store, 'demo', 'fictional');
  await c.init();
  return { c, analyzer, mail, store, ids: c.messages.map((m) => m.id) };
}

test('explicit review queue is FIFO across summary/email requests, deduplicates exact sets and never changes mail', async () => {
  const { c, analyzer, ids } = await fixture();
  const gate = deferred();
  const calls: string[] = [];
  let active = 0,
    maxActive = 0;
  analyzer.digest = async (rows) => {
    maxActive = Math.max(maxActive, ++active);
    calls.push(rows.map((m) => m.id).join(','));
    if (calls.length === 1) await gate.promise;
    active--;
    return 'Fictional combined summary';
  };
  const analyze = analyzer.analyze.bind(analyzer);
  analyzer.analyze = async (m, signal) => {
    maxActive = Math.max(maxActive, ++active);
    calls.push(m.id);
    const result = await analyze(m, signal);
    active--;
    return result;
  };
  try {
    const first = c.reviewNewsletter([ids[1], ids[0]]);
    await until(() => c.newsletterGenerating([ids[0], ids[1]]));
    expect(c.reviewNewsletter([ids[0], ids[1], ids[0]])).toBe(first);
    const second = c.reviewNewsletter([ids[2]]);
    const third = c.reviewOne(ids[3]);
    expect(c.reviewJobs.map((j) => j.state)).toEqual(['running', 'queued', 'queued']);
    expect(c.reviewNewsletter([ids[2]])).toBe(second);
    expect(c.reviewOne(ids[3])).toBe(third);
    expect(c.newsletterGenerating([ids[0]])).toBe(false);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(calls).toEqual([[ids[0], ids[1]].sort().join(','), ids[2], ids[3]]);
    expect(maxActive).toBe(1);
    expect(c.reviewJobs.every((j) => j.state === 'completed')).toBe(true);
    await c.reviewNewsletter([ids[1], ids[0]]);
    expect(calls).toHaveLength(3);
    expect(c.messages.every((m) => !m.read)).toBe(true);
  } finally {
    gate.resolve();
    await c.close();
  }
});

test('Stop clears waiting work and ignores a late model response after abort', async () => {
  const { c, analyzer, ids } = await fixture();
  const gate = deferred();
  let calls = 0;
  analyzer.digest = async () => {
    calls++;
    await gate.promise;
    return 'Late result';
  };
  try {
    const first = c.reviewNewsletter([ids[0]]);
    await until(() => c.busy);
    const second = c.reviewNewsletter([ids[1]]);
    const stopping = c.stop();
    expect(c.reviewJob('newsletter', [ids[1]])?.state).toBe('cancelled');
    gate.resolve();
    await Promise.all([first, second, stopping]);
    expect(calls).toBe(1);
    expect(c.newsletterDigest([ids[0]])).toBeUndefined();
    expect(c.reviewJob('newsletter', [ids[0]])?.state).toBe('cancelled');
    expect(c.busy).toBe(false);
  } finally {
    gate.resolve();
    await c.close();
  }
});

test('mailbox writes interrupt only the active request, hold queued work and never resume it as a batch', async () => {
  const { c, analyzer, ids, mail } = await fixture();
  const calls: string[] = [];
  let fetches = 0,
    analyses = 0;
  const fetch = mail.fetch.bind(mail);
  mail.fetch = async (...args) => {
    fetches++;
    return fetch(...args);
  };
  const analyze = analyzer.analyze.bind(analyzer);
  analyzer.analyze = async (...args) => {
    analyses++;
    return analyze(...args);
  };
  analyzer.digest = async (rows, signal) => {
    calls.push(rows[0].id);
    if (calls.length === 1)
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    return 'Saved summary';
  };
  try {
    const first = c.reviewNewsletter([ids[0]]);
    await until(() => c.busy);
    const email = c.reviewOne(ids[1]);
    const second = c.reviewNewsletter([ids[2]]);
    await c.apply([ids[1]]);
    await Promise.all([first, email, second]);
    expect(c.reviewJob('newsletter', [ids[0]])?.state).toBe('cancelled');
    expect(c.reviewJob('email', [ids[1]])?.state).toBe('cancelled');
    expect(c.reviewJob('newsletter', [ids[2]])?.state).toBe('completed');
    expect(calls).toEqual([ids[0], ids[2]]);
    expect(fetches).toBe(0);
    expect(analyses).toBe(0);
    expect(c.messages.find((m) => m.id === ids[1])?.read).toBe(true);
  } finally {
    await c.close();
  }
});

test('one request failure does not lose other requests; a provider failure cancels waiting work', async () => {
  for (const providerFailure of [false, true]) {
    const { c, analyzer, ids } = await fixture();
    const gate = deferred();
    let calls = 0;
    analyzer.digest = async () => {
      if (++calls === 1) {
        await gate.promise;
        throw providerFailure
          ? new ProviderFailure('Fictional provider unavailable')
          : new Error('Invalid summary');
      }
      return 'Successful summary';
    };
    try {
      const first = c.reviewNewsletter([ids[0]]);
      await until(() => c.busy);
      const second = c.reviewNewsletter([ids[1]]);
      gate.resolve();
      await Promise.all([first, second]);
      expect(c.reviewJob('newsletter', [ids[0]])?.state).toBe('failed');
      expect(c.reviewJob('newsletter', [ids[1]])?.state).toBe(
        providerFailure ? 'cancelled' : 'completed',
      );
      expect(calls).toBe(providerFailure ? 1 : 2);
      await c.reviewNewsletter([ids[0]]); // Explicit retry is allowed after recovery.
      expect(c.reviewJob('newsletter', [ids[0]])?.state).toBe('completed');
      expect(c.providerFailure).toBeUndefined();
    } finally {
      gate.resolve();
      await c.close();
    }
  }
});

test('queued issue IDs stay fixed; missing source fails instead of summarizing a smaller set', async () => {
  const { c, analyzer, ids } = await fixture();
  const gate = deferred();
  let calls = 0;
  analyzer.digest = async () => {
    calls++;
    await gate.promise;
    return 'Summary';
  };
  try {
    const first = c.reviewNewsletter([ids[0]]);
    await until(() => c.busy);
    const second = c.reviewNewsletter([ids[1], ids[2]]);
    c.session!.messages = c.session!.messages.filter((m) => m.id !== ids[2]);
    delete c.saved.library![ids[2]];
    gate.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(c.reviewJob('newsletter', [ids[1], ids[2]])?.detail).toContain('no longer retained');
    expect(c.newsletterDigest([ids[1]])).toBeUndefined();
  } finally {
    gate.resolve();
    await c.close();
  }
});

test('queued summaries start after a finite batch finishes and survive neither worker close nor restart', async () => {
  const { c, analyzer, ids, store } = await fixture();
  const gate = deferred();
  const analyze = analyzer.analyze.bind(analyzer);
  analyzer.analyze = async (...args) => {
    await gate.promise;
    return analyze(...args);
  };
  let summaries = 0;
  analyzer.digest = async () => {
    summaries++;
    return 'After batch';
  };
  // Remove one saved review so this fictional batch has real work to hold.
  const m = c.messages[0];
  m.analysis = undefined;
  m.classification = undefined;
  try {
    const batch = c.start({ mode: 'unread', limit: 1, order: 'oldest' });
    await until(() => c.busy && !c.snapshotting);
    const digest = c.reviewNewsletter([ids[1]]);
    expect(c.reviewJob('newsletter', [ids[1]])?.state).toBe('queued');
    expect(summaries).toBe(0);
    gate.resolve();
    await Promise.all([batch, digest]);
    expect(summaries).toBe(1);
    expect(c.reviewJob('newsletter', [ids[1]])?.state).toBe('completed');
    c.mutating = true; // Hold the queue without invoking another operation.
    const queued = c.reviewNewsletter([ids[2]]);
    c.mutating = false;
    await c.close();
    await queued;
    expect(c.reviewJob('newsletter', [ids[2]])?.state).toBe('cancelled');
    const restarted = new Controller(new DemoMailbox(), analyzer, store, 'demo', 'fictional');
    await restarted.init();
    expect(restarted.reviewJobs).toEqual([]);
    expect(summaries).toBe(1);
    await restarted.close();
  } finally {
    gate.resolve();
    await c.close();
  }
});

test('a saving failure is not a cached success and stops further paid work', async () => {
  const { c, analyzer, ids, store } = await fixture();
  const gate = deferred();
  let calls = 0;
  analyzer.digest = async () => {
    calls++;
    await gate.promise;
    return 'Unsaved summary';
  };
  const save = store.save.bind(store);
  try {
    const first = c.reviewNewsletter([ids[0]]);
    await until(() => c.busy);
    const second = c.reviewNewsletter([ids[1]]);
    store.save = async () => {
      throw new Error('Fictional disk failure');
    };
    gate.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(c.reviewJob('newsletter', [ids[0]])?.state).toBe('failed');
    expect(c.reviewJob('newsletter', [ids[0]])?.detail).toContain('Could not save');
    expect(c.reviewJob('newsletter', [ids[1]])?.state).toBe('cancelled');
    expect(c.newsletterDigest([ids[0]])).toBeUndefined();
  } finally {
    store.save = save;
    gate.resolve();
    await c.close();
  }
});

test('queue capacity and cancelled history are bounded; duplicate requests do not consume capacity', async () => {
  const { c } = await fixture();
  const base = c.messages[0];
  const extra = Array.from({ length: 51 }, (_, i) => ({
    ...base,
    uid: 500 + i,
    id: base.id.replace(/:[^:]+$/, ':' + (500 + i)),
  }));
  c.session!.messages.push(...extra);
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      c.mutating = true;
      const pending = extra.slice(0, 50).map((m) => c.reviewOne(m.id));
      expect(c.reviewOne(extra[0].id)).toBe(pending[0]);
      expect(() => c.reviewOne(extra[50].id)).toThrow('50 review requests');
      c.mutating = false;
      await c.stop();
      await Promise.all(pending);
      expect(c.reviewJobs).toHaveLength(50);
      expect(c.reviewJobs.every((j) => j.state === 'cancelled')).toBe(true);
    }
  } finally {
    c.mutating = false;
    await c.close();
  }
});

test('cancelled email re-analysis cannot overwrite its previous saved analysis', async () => {
  const { c, analyzer, ids } = await fixture();
  const original = structuredClone(c.messages[0].analysis!);
  const gate = deferred();
  analyzer.analyze = async () => {
    await gate.promise;
    return { ...original, takeaway: 'Late replacement' };
  };
  try {
    const review = c.reviewOne(ids[0]);
    await until(() => c.busy);
    const stopping = c.stop();
    gate.resolve();
    await Promise.all([review, stopping]);
    expect(c.messages[0].analysis).toEqual(original);
    expect(c.reviewJob('email', [ids[0]])?.state).toBe('cancelled');
  } finally {
    gate.resolve();
    await c.close();
  }
});

test('failed saving of email re-analysis restores its prior result and cancels waiting work', async () => {
  const { c, analyzer, ids, store } = await fixture();
  const original = structuredClone(c.messages[0].analysis!);
  const save = store.save.bind(store);
  analyzer.analyze = async () => ({ ...original, takeaway: 'Unsaved replacement' });
  store.save = async () => {
    throw new Error('Fictional disk failure');
  };
  try {
    const first = c.reviewOne(ids[0]);
    const second = c.reviewOne(ids[1]);
    await Promise.all([first, second]);
    expect(c.messages[0].analysis).toEqual(original);
    expect(c.reviewJob('email', [ids[0]])?.state).toBe('failed');
    expect(c.reviewJob('email', [ids[0]])?.detail).toContain('Could not save');
    expect(c.reviewJob('email', [ids[1]])?.state).toBe('cancelled');
    expect(c.status).not.toBe('Review updated.');
  } finally {
    store.save = save;
    await c.close();
  }
});
