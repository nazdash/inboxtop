import { test, expect } from 'bun:test';
import { ModelAnalyzer, ProviderFailure, validateAnalysis } from '../src/analysis.ts';
import { analysisContent } from '../src/analysis-content.ts';
import { parseMessage } from '../src/mail.ts';
import { DemoMailbox, demoMessages, demoSession } from '../src/demo.ts';
import { Controller } from '../src/controller.ts';
import { MemoryStore } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';
import { routeClassification } from '../src/classification.ts';
import { analysisReady, decisionQueues, inboxBriefingCounts } from '../src/decisions.ts';
import { inboxStats } from '../src/inbox-stats.ts';
import { cleanupCandidate } from '../src/domain.ts';
import { routine, compact, response } from './classification-fixtures.ts';

test('MIME falls back from empty plain alternatives to readable HTML, without replacing valid plain text', async () => {
  const base = demoMessages()[0];
  for (const plain of ['', '   \r\n\t', 'Use the plain-text instructions.']) {
    const raw = Buffer.from(
      'From: Team <team@example.com>\r\nSubject: Budget\r\nMIME-Version: 1.0\r\n' +
        'Content-Type: multipart/alternative; boundary="fixture"\r\n\r\n' +
        '--fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
        plain +
        '\r\n--fixture\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' +
        '<p>Please approve the revised budget.</p><img src="https://example.com/tracker.png">' +
        '\r\n--fixture--\r\n',
    );
    const m = await parseMessage(raw, base);
    expect(m.body).toContain(plain.trim() || 'Please approve the revised budget.');
    expect(m.body).not.toContain('<img');
    expect(m.complete).toBe(true);
    const partial = await parseMessage(raw, base, false);
    expect(partial.body).toBe(m.body);
    expect(partial.complete).toBe(false);
  }
});

test('evidence whitespace repair retains exact original quotations and literal deadlines', () => {
  const m = {
    ...demoMessages()[0],
    body: 'Budget approved.\n\n\n\nPlease notify\tthe team by\u00a0Friday.',
  };
  const quote = analysisContent(m).body;
  const a = validateAnalysis({ ...m.analysis, evidence: [quote], deadline: 'by Friday' }, m);
  expect(a.evidence).toEqual([m.body]);
  expect(a.deadline).toBe('by\u00a0Friday');
  expect(m.body).toContain('\n\n\n\n');
});

test('evidence repair cannot change facts, interpret regex, or bridge omitted content', () => {
  const m = { ...demoMessages()[0], body: 'Pay EUR 50.\nDue Friday.\nDo not approve.' };
  for (const quote of ['Pay EUR 500.', 'Due Monday.', 'Do approve.', 'Pay EUR .*', '   ']) {
    expect(() => validateAnalysis({ ...m.analysis, deadline: '', evidence: [quote] }, m)).toThrow(
      'evidence',
    );
  }
  const long = {
    ...m,
    body:
      'Visible start. ' +
      'x'.repeat(25000) +
      ' Hidden obligation. ' +
      'x'.repeat(25000) +
      ' Visible end.',
  };
  for (const quote of [
    'Hidden obligation.',
    'Visible start. Visible end.',
    'Middle of email omitted',
  ]) {
    expect(() =>
      validateAnalysis({ ...m.analysis, deadline: '', evidence: [quote] }, long),
    ).toThrow('evidence');
  }
  const literal = { ...m, body: 'Use [team](v2) + $5.' };
  expect(
    validateAnalysis({ ...m.analysis, deadline: '', evidence: [literal.body] }, literal).evidence,
  ).toEqual([literal.body]);
  expect(() =>
    validateAnalysis({ ...m.analysis, deadline: '', evidence: ['Pay EUR 50.', 'Pay EUR 500.'] }, m),
  ).toThrow('1 of 2 quotes');
});

test('OpenAI and Ollama accept whitespace repairs in one detailed call; empty bodies cost zero calls', async () => {
  for (const provider of ['openai', 'ollama'] as const) {
    let requests = 0;
    const m = { ...demoMessages()[0], body: 'Please approve\nthe budget by Friday.' };
    const value = compact({
      ...m.analysis,
      deadline: 'by Friday',
      evidence: ['Please approve the budget by Friday.'],
    });
    const analyzer = new ModelAnalyzer(loadConfig(false, { LLM_PROVIDER: provider }), (async (
      url: string | URL | Request,
    ) => {
      if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['completion'] });
      requests++;
      return Response.json(
        provider === 'openai'
          ? response(value)
          : { done: true, message: { content: JSON.stringify(value) } },
      );
    }) as unknown as typeof fetch);
    const a = await analyzer.analyze(m, new AbortController().signal);
    expect(a.evidence).toEqual([m.body]);
    expect(requests).toBe(1);
    requests = 0;
    await expect(
      analyzer.classify({ ...m, body: ' \n' }, new AbortController().signal),
    ).rejects.toThrow('No readable email');
    await expect(
      analyzer.analyze({ ...m, body: '' }, new AbortController().signal),
    ).rejects.toThrow('No readable email');
    expect(requests).toBe(0);
  }
});

async function recoveryHarness(empty = true, classified = true) {
  const original = demoMessages()[0];
  const m = {
    ...original,
    body: empty ? '' : original.body,
    complete: !empty,
    analysis: undefined,
    classification: routeClassification(
      { ...routine, action: 0.95 },
      { ...original, body: empty ? '' : original.body },
      empty ? 0 : original.body.length,
      'test',
      'test',
    ),
    error: 'Model evidence did not match this email. Retry or inspect the original.',
    kept: true,
  };
  const store = new MemoryStore();
  store.value.session = { ...demoSession(), messages: [m], uids: [m.uid], total: 1 };
  const mail = new DemoMailbox();
  const calls = { fetch: 0, classify: 0, analyze: 0 };
  const fetch = mail.fetch.bind(mail);
  mail.fetch = async (uid, identity) => {
    calls.fetch++;
    return fetch(uid, identity);
  };
  const analyzer = {
    ...(classified
      ? {
          async classify(message: typeof original) {
            calls.classify++;
            expect(message.body).toBe(original.body);
            return routeClassification(
              { ...routine, action: 0.95 },
              message,
              message.body.length,
              'test',
              'test',
            );
          },
        }
      : {}),
    async analyze(message: typeof original) {
      calls.analyze++;
      expect(message.body).toBe(original.body);
      return original.analysis!;
    },
  };
  const c = new Controller(mail, analyzer, store, 'test', 'test');
  await c.init();
  return { c, mail, calls, m, store };
}

test('saved failures appear in Check manually without becoming successful analysis or cleanup evidence', async () => {
  const h = await recoveryHarness();
  try {
    const m = h.c.pool[0];
    expect(decisionQueues(h.c.pool).check.map((m) => m.id)).toEqual([m.id]);
    expect(analysisReady(m)).toBe(false);
    expect(cleanupCandidate(m)).toBe(false);
    expect(inboxStats(h.c)).toMatchObject({
      ready: 0,
      reviewable: 1,
      failed: 1,
      outcomes: { check: 1, act: 0 },
    });
    expect(inboxBriefingCounts(h.c.pool).analyzed).toBe(0);
    expect(h.calls).toEqual({ fetch: 0, classify: 0, analyze: 0 });
  } finally {
    await h.c.close();
  }
});

test('single and batch retry recover missing bodies once, invalidate stale classification, and preserve mailbox flags', async () => {
  for (const classified of [true, false])
    for (const single of [true, false]) {
      const h = await recoveryHarness(true, classified);
      try {
        if (single) await h.c.reviewOne(h.m.id);
        else await h.c.retry();
        expect(h.calls).toEqual({ fetch: 1, classify: classified ? 1 : 0, analyze: 1 });
        expect(h.c.pool[0].error).toBeUndefined();
        expect(h.c.pool[0].kept).toBe(true);
        expect(h.c.pool[0].read).toBe(false);
        expect(decisionQueues(h.c.pool).act).toHaveLength(1);
        expect(h.mail.rows.every((m) => !m.read)).toBe(true);
      } finally {
        await h.c.close();
      }
    }
});

test('retry reuses readable content and valid classification without an extra fetch or classifier call', async () => {
  const h = await recoveryHarness(false);
  try {
    await h.c.retry();
    expect(h.calls).toEqual({ fetch: 0, classify: 0, analyze: 1 });
  } finally {
    await h.c.close();
  }
});

test('still-empty mail stays in Check manually without model calls or automatic repeated fetches', async () => {
  for (const single of [false, true]) {
    const h = await recoveryHarness();
    h.mail.rows[0].body = '';
    h.mail.rows[0].complete = false;
    try {
      if (single) await h.c.reviewOne(h.m.id);
      else await h.c.retry();
      expect(h.calls).toEqual({ fetch: 1, classify: 0, analyze: 0 });
      expect(h.c.pool[0].error).toContain('No readable email');
      expect(decisionQueues(h.c.pool).check).toHaveLength(1);
    } finally {
      await h.c.close();
    }
  }
});

test('a wrong-identity refetch cannot replace retained mail or reach the model', async () => {
  const h = await recoveryHarness();
  const fetch = h.mail.fetch;
  h.mail.fetch = async (uid, identity) => ({
    ...(await fetch(uid, identity)),
    id: 'different:INBOX:1:100',
  });
  try {
    await h.c.retry();
    expect(h.calls).toEqual({ fetch: 1, classify: 0, analyze: 0 });
    expect(h.c.pool[0].id).toBe(h.m.id);
    expect(h.c.pool[0].body).toBe('');
    expect(h.c.pool[0].error).toContain('identity changed');
  } finally {
    await h.c.close();
  }
});

test('provider failure during explicit re-analysis does not turn a valid review into a manual-check failure', async () => {
  const h = await recoveryHarness(false);
  try {
    await h.c.retry();
    const before = h.c.pool[0].analysis;
    h.c.analyzer = {
      async analyze() {
        throw new ProviderFailure('Unavailable', 'credentials');
      },
    };
    await h.c.reviewOne(h.m.id);
    expect(h.c.pool[0].analysis).toEqual(before);
    expect(h.c.pool[0].error).toBeUndefined();
    expect(h.c.providerFailure).toBe('credentials');
    expect(decisionQueues(h.c.pool).check).toHaveLength(0);
  } finally {
    await h.c.close();
  }
});

test('provider failures are actionable and ambiguous transport or invalid output is never replayed', async () => {
  const m = demoMessages()[0];
  for (const [status, hint] of [
    [401, 'credentials'],
    [404, 'Settings'],
  ] as const) {
    let calls = 0;
    const analyzer = new ModelAnalyzer(loadConfig(false, {}), (async () => {
      calls++;
      return new Response('private-provider-body', { status });
    }) as unknown as typeof fetch);
    await expect(analyzer.analyze(m, new AbortController().signal)).rejects.toThrow(hint);
    expect(calls).toBe(1);
  }
  for (const invalid of [false, true]) {
    let calls = 0;
    const analyzer = new ModelAnalyzer(loadConfig(false, {}), (async () => {
      calls++;
      if (!invalid) throw new Error('private-transport-error');
      return Response.json(response({ invalid: 'No valid review' }));
    }) as unknown as typeof fetch);
    await expect(analyzer.analyze(m, new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test('unsupported calendar dates in summary or action cannot bypass the deadline check', () => {
  const m = {
    ...demoMessages()[0],
    body: 'Please pay within 14 days.',
    date: '2026-01-01T12:00:00Z',
  };
  const base = {
    ...m.analysis!,
    evidence: ['Please pay within 14 days.'],
    deadline: 'within 14 days',
    action: 'Check payment status; pay if outstanding.',
    takeaway: 'A payment was requested in the 2026-01-01 notice.',
  };
  expect(validateAnalysis(base, m).deadline).toBe('within 14 days');
  for (const field of ['action', 'takeaway'] as const)
    expect(() =>
      validateAnalysis({ ...base, [field]: 'Payment is due on 2026-01-15.' }, m),
    ).toThrow('calendar date');
  const dated = { ...m, body: m.body + ' The stated deadline is 2026-01-15.' };
  expect(
    validateAnalysis({ ...base, action: 'Check payment status before 2026-01-15.' }, dated).action,
  ).toContain('2026-01-15');
});
