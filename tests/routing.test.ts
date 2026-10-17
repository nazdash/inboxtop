import { expect, test } from 'bun:test';
import { analysisContent } from '../src/analysis-content.ts';
import { ModelAnalyzer, validateAnalysis } from '../src/analysis.ts';
import { routeClassification } from '../src/classification.ts';
import { analysisReady, decisionQueues, outcomeOf, pendingDetail } from '../src/decisions.ts';
import { cleanupCandidate } from '../src/domain.ts';
import { demoMessages, DemoMailbox } from '../src/demo.ts';
import { Controller } from '../src/controller.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryStore } from '../src/store.ts';
import { inboxStats } from '../src/inbox-stats.ts';
import { compact, response, routine } from './classification-fixtures.ts';

test('saved findings route useful next steps locally without relaxing cleanup', () => {
  const [action, , , reading, , , receipt] = demoMessages();
  const uncertainAction = {
    ...action,
    complete: false,
    analysis: { ...action.analysis!, uncertain: true },
  };
  expect(outcomeOf(uncertainAction)).toBe('act');
  expect(cleanupCandidate(uncertainAction)).toBe(false);
  const unknown = {
    ...receipt,
    analysis: { ...receipt.analysis!, source_type: 'unknown' as const },
  };
  expect(outcomeOf(unknown)).toBe('read');
  expect(cleanupCandidate(unknown)).toBe(false);
  const newsletter = {
    ...reading,
    analysis: {
      ...reading.analysis!,
      uncertain: true,
      coverage: { stage: 'detail' as const, characters: 24000, total: 40000 },
    },
  };
  expect(outcomeOf(newsletter)).toBe('read');
  expect(cleanupCandidate(newsletter)).toBe(false);
  const conflict = routeClassification(
    { ...routine, action: 0.95 },
    newsletter,
    newsletter.body.length,
    'test',
    'test',
  );
  expect(outcomeOf({ ...newsletter, classification: conflict })).toBe('check');
  const ambiguous = { ...receipt, analysis: { ...receipt.analysis!, uncertain: true } };
  expect(outcomeOf(ambiguous)).toBe('check');
  // A new review explicitly unable to determine the next step is not overridden.
  expect(
    outcomeOf({
      ...action,
      analysis: { ...action.analysis!, uncertain: true, decisionUncertain: true },
    }),
  ).toBe('check');
});

test('every unresolved classifier result requests detail, including former threshold gaps', () => {
  const m = demoMessages()[6];
  for (const overrides of [
    { uncertain: 0.15 },
    { sourceConfidence: 0.7 },
    { routine: 0.9 },
    { intentConfidence: 0.7 },
  ]) {
    const c = routeClassification({ ...routine, ...overrides }, m, m.body.length, 'test', 'test');
    expect(c.route).toBe('check');
    expect(c.needsDetail).toBe(true);
    expect(pendingDetail({ ...m, analysis: undefined, classification: c })).toBe(true);
  }
  const partial = routeClassification(routine, m, 10, 'test', 'test');
  expect(partial.needsDetail).toBe(true);
  // Old saved classifications do not require a new classifier call to escalate.
  expect(
    pendingDetail({
      ...m,
      analysis: undefined,
      classification: { ...partial, needsDetail: false },
    }),
  ).toBe(true);
});

test('long mail keeps a bounded head/tail, validates only visible original evidence and preserves storage', async () => {
  const m = {
    ...demoMessages()[3],
    body: 'Useful engineering research.\n' + 'x'.repeat(35000) + '\nPlease approve the new budget.',
  };
  const original = m.body;
  const content = analysisContent(m);
  expect(content.body.length).toBeLessThanOrEqual(24000);
  expect(content.body).toContain('Middle of email omitted');
  expect(content.body).toContain('Please approve the new budget.');
  expect(content.complete).toBe(false);
  let calls = 0;
  const analyzer = new ModelAnalyzer(loadConfig(false, {}), (async () => {
    calls++;
    return Response.json(
      response(
        compact({ ...m.analysis!, evidence: ['Useful engineering research.'], uncertain: false }),
      ),
    );
  }) as unknown as typeof fetch);
  const analysis = await analyzer.analyze(m, new AbortController().signal);
  expect(calls).toBe(1);
  expect(analysis.uncertain).toBe(true); // Coverage remains visibly partial.
  expect(analysis.decisionUncertain).toBe(false);
  expect(outcomeOf({ ...m, analysis })).toBe('read');
  expect(cleanupCandidate({ ...m, analysis })).toBe(false);
  expect(m.body).toBe(original);
  const hidden = { ...m, body: 'x'.repeat(20000) + 'Hidden payment request' + 'x'.repeat(20000) };
  expect(() =>
    validateAnalysis({ ...m.analysis!, evidence: ['Hidden payment request'] }, hidden),
  ).toThrow('evidence');
  expect(() =>
    validateAnalysis({ ...m.analysis!, evidence: ['Middle of email omitted'] }, m),
  ).toThrow('evidence');
  const whitespace = { ...m, body: 'Paid in full.' + '\n'.repeat(30000) + 'Receipt ends.' };
  expect(analysisContent(whitespace).complete).toBe(true);
  expect(analysisContent(whitespace).characters).toBe(whitespace.body.length);
});

test('failed analyses stay retryable and outside all completed categories', () => {
  const m = { ...demoMessages()[0], error: 'Invalid evidence' };
  expect(analysisReady(m)).toBe(false);
  expect(Object.values(decisionQueues([m])).flat()).toHaveLength(0);
});

test('restart reuses saved decisions; legacy unresolved classification costs one detail call only', async () => {
  const m = { ...demoMessages()[6], analysis: undefined };
  const classification = routeClassification(
    { ...routine, uncertain: 0.15 },
    m,
    m.body.length,
    'test',
    'test',
  );
  m.classification = { ...classification, needsDetail: false };
  const store = new MemoryStore();
  store.value.library = { [m.id]: m };
  let calls = 0;
  const controller = new Controller(
    new DemoMailbox(),
    {
      async classify() {
        throw new Error('Must reuse saved classification');
      },
      async analyze() {
        calls++;
        return { ...demoMessages()[6].analysis!, decisionUncertain: false };
      },
    },
    store,
    'test',
    'test',
  );
  try {
    await controller.init();
    expect(calls).toBe(0);
    // Select just this retained UID using a mailbox snapshot fixture.
    const snapshot = controller.mail.snapshot.bind(controller.mail);
    controller.mail.snapshot = async (scope) => ({
      ...(await snapshot(scope)),
      uids: [m.uid],
      total: 1,
    });
    await controller.start({ mode: 'unread', limit: 1, order: 'oldest' });
    expect(calls).toBe(1);
    expect(inboxStats(controller).outcomes.clear).toBe(1);
    await controller.start({ mode: 'unread', limit: 1, order: 'oldest' });
    expect(calls).toBe(1);
  } finally {
    await controller.close();
  }
});
