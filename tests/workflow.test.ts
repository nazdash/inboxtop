import { test, expect } from 'bun:test';
import { ModelAnalyzer, cacheKey, reusableAnalysis } from '../src/analysis.ts';
import { cleanupCandidate, type Analyzer } from '../src/domain.ts';
import { loadConfig } from '../src/config.ts';
import { SettingsSchema, settingsFrom } from '../src/settings.ts';
import { demoMessages, DemoMailbox, DemoAnalyzer } from '../src/demo.ts';
import { Controller } from '../src/controller.ts';
import { MemoryStore } from '../src/store.ts';
import { inPeriod, summarize, statusSnapshot } from '../src/overview.ts';

import { routine, decisionResponse, compact, response } from './classification-fixtures.ts';
import { classificationKey, parseDecisions } from '../src/classification.ts';
function fixture(body = 'Paid in full.') {
  return { ...demoMessages()[6], body, subject: 'Receipt', complete: true, analysis: undefined };
}
function mocked(responses: unknown[], provider: 'openai' | 'ollama' = 'openai') {
  const calls: { url: string; body: any }[] = [];
  const config = loadConfig(false, { LLM_PROVIDER: provider, OLLAMA_MODEL: 'test' });
  const request = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['completion'] });
    const next = responses.shift();
    if (next === undefined) throw new Error('Unexpected extra request');
    return Response.json(
      provider === 'openai'
        ? String(url).endsWith('/decisions')
          ? next
          : response(next)
        : { done: true, message: { content: JSON.stringify(next) } },
    );
  }) as typeof fetch;
  return { analyzer: new ModelAnalyzer(config, request), calls, config };
}
test('partial routine classification goes straight to one detail pass, including closing requests', async () => {
  const m = fixture('Paid in full.' + ' x'.repeat(2000) + ' Please pay another bill.');
  const h = mocked([
    decisionResponse(routine),
    compact({
      ...demoMessages()[0].analysis!,
      action: 'Verify the other bill.',
      deadline: '',
      evidence: ['Please pay another bill.'],
    }),
  ]);
  const result = await h.analyzer.review(m, new AbortController().signal, () => {});
  expect(h.calls).toHaveLength(2);
  expect(JSON.parse(h.calls[0].body.input).body.length).toBeLessThanOrEqual(3000);
  expect(JSON.parse(h.calls[1].body.input[0].content).body).toContain('Please pay another bill.');
  expect(result.action).toBe('Verify the other bill.');
  expect(cleanupCandidate({ ...m, analysis: result })).toBe(false);
});
test('complete routine mail needs only Decisions; important mail uses the separate detailed model', async () => {
  const m = fixture();
  const h = mocked([decisionResponse(routine)]);
  const classification = await h.analyzer.classify(m, new AbortController().signal);
  expect(cleanupCandidate({ ...m, classification })).toBe(true);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].body.model).toBe('gpt-6-luna');
  expect(h.calls[0].body.store).toBeUndefined();
  expect(h.calls[0].body.questions).toHaveLength(9);
  const important = demoMessages()[0];
  const detailed = mocked([
    decisionResponse({ ...routine, action: 0.95, routine: 0.01 }),
    compact(important.analysis),
  ]);
  const stages: string[] = [];
  const result = await detailed.analyzer.review(important, new AbortController().signal, (s) =>
    stages.push(s),
  );
  expect(detailed.calls).toHaveLength(2);
  expect(stages).toEqual(['triage', 'detail']);
  expect(detailed.calls[1].body.model).toBe('gpt-6.1-sol');
  expect(result.coverage?.stage).toBe('detail');
  expect(result.action).toBeTruthy();
});
test('refused, incomplete, duplicated and invalid probabilities never count as successful classification', () => {
  const normal = decisionResponse(routine);
  const refused = structuredClone(normal) as any;
  refused.answers[0] = { name: 'source', type: 'refusal' };
  expect(() => parseDecisions(refused)).toThrow('refused');
  expect(() => parseDecisions({ ...normal, answers: normal.answers.slice(1) })).toThrow();
  expect(() =>
    parseDecisions({ ...normal, answers: [...normal.answers.slice(1), normal.answers[1]] }),
  ).toThrow();
  const invalid = structuredClone(normal) as any;
  invalid.answers[2].probability = 2;
  expect(() => parseDecisions(invalid)).toThrow();
});
test('incomplete routine cannot clear; detailed evidence resolves a classifier false alarm in two calls', async () => {
  const h = mocked([decisionResponse(routine)]);
  const m = { ...fixture(), complete: false };
  const classification = await h.analyzer.classify(m, new AbortController().signal);
  expect(classification.route).toBe('check');
  expect(cleanupCandidate({ ...m, classification })).toBe(false);
  const receipt = demoMessages()[6];
  const conflict = mocked([
    decisionResponse({ ...routine, action: 0.95, routine: 0.01 }),
    compact(receipt.analysis),
  ]);
  const result = await conflict.analyzer.review(receipt, new AbortController().signal, () => {});
  expect(result.decisionUncertain).toBe(false);
  expect(result.uncertain).toBe(false);
  expect(cleanupCandidate({ ...receipt, analysis: result })).toBe(true);
  expect(conflict.calls).toHaveLength(2);
  expect(JSON.parse(conflict.calls[1].body.input[0].content).initialClassification.action).toBe(
    0.95,
  );
});
test('Ollama classification stays local and checks each model; cloud-backed models are rejected', async () => {
  const h = mocked([{ ...routine }, { ...routine }], 'ollama');
  await h.analyzer.classify(fixture(), new AbortController().signal);
  await h.analyzer.classify(fixture(), new AbortController().signal);
  expect(h.calls.filter((c) => c.url.endsWith('/api/show'))).toHaveLength(1);
  expect(h.calls[1].body.think).toBeUndefined();
  expect(h.calls[1].body.keep_alive).toBe('10m');
  expect(h.calls[1].body.format.additionalProperties).toBe(false);
  expect(h.calls.every((c) => c.url.startsWith('http://127.0.0.1:11434'))).toBe(true);
  const config = loadConfig(false, { LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'cloud' });
  let calls = 0;
  const remote = new ModelAnalyzer(config, (async () => {
    calls++;
    return Response.json({ remote_model: 'remote' });
  }) as unknown as typeof fetch);
  await expect(remote.classify(fixture(), new AbortController().signal)).rejects.toThrow(
    'cloud-backed',
  );
  expect(calls).toBe(1);
});
test('settings survive restart and override defaults without storing credentials', async () => {
  const config = loadConfig(false, { OPENAI_API_KEY: 'private-test-key' });
  const store = new MemoryStore();
  const c = new Controller(
    new DemoMailbox(),
    new DemoAnalyzer(),
    store,
    'openai',
    config.model,
    3,
    config,
  );
  await c.init();
  await c.saveSettings({
    ...settingsFrom(config),
    provider: 'ollama',
    ollamaModel: 'qwen3.5:4b',
    analysisLanguage: 'ru',
    pollMinutes: 15,
  });
  expect(JSON.stringify(store.value)).not.toContain('private-test-key');
  await c.close();
  const next = loadConfig(false, {});
  const restarted = new Controller(
    new DemoMailbox(),
    new DemoAnalyzer(),
    store,
    'openai',
    next.model,
    3,
    next,
  );
  await restarted.init();
  expect(next.provider).toBe('ollama');
  expect(next.analysisLanguage).toBe('ru');
  expect(next.model).toBe('qwen3.5:4b');
  expect(restarted.concurrency).toBe(1);
  expect(restarted.monitoring).toBe(false);
  await restarted.close();
});
test('refresh reuses immutable UID bodies, preserves kept decisions and history, and never writes flags', async () => {
  const mail = new DemoMailbox();
  const c = new Controller(mail, new DemoAnalyzer(), new MemoryStore(), 'demo', 'fictional');
  await c.init();
  await c.refresh();
  const kept = c.messages[0];
  await c.keep(kept.id);
  const changed = c.messages[1];
  await c.apply([changed.id]);
  const receipt = c.session!.receipts[0].id;
  let fetched = 0;
  const fetch = mail.fetch.bind(mail);
  mail.fetch = async (...args) => {
    fetched++;
    return fetch(...args);
  };
  let writes = 0;
  const setRead = mail.setRead.bind(mail);
  mail.setRead = async (...args) => {
    writes++;
    return setRead(...args);
  };
  c.startMonitoring(5);
  await c.refresh();
  expect(fetched).toBe(0);
  expect(writes).toBe(0);
  expect(c.pool.find((m) => m.id === kept.id)?.kept).toBe(true);
  expect(c.session?.receipts[0].id).toBe(receipt);
  expect(c.messages.some((m) => m.id === changed.id)).toBe(false);
  await c.undo(receipt);
  expect(writes).toBe(1);
  expect(mail.rows.find((m) => m.id === changed.id)?.read).toBe(false);
  await c.close();
  expect(c.monitoring).toBe(false);
});
test('local calendar summaries exclude read/future mail and preserve one finding per unread email', () => {
  const base = demoMessages()[0];
  const now = new Date(2026, 9, 11, 12); // Sunday, local time
  const m = (id: string, day: number, hour = 9) => ({
    ...base,
    id,
    date: new Date(2026, 9, day, hour).toISOString(),
  });
  const rows = [
    m('today', 11),
    m('monday', 5),
    m('last-week', 4),
    m('future', 11, 20),
    { ...m('read', 11), read: true },
  ];
  expect(inPeriod(rows, 'today', now).map((m) => m.id)).toEqual(['today']);
  expect(inPeriod(rows, 'week', now).map((m) => m.id)).toEqual(['today', 'monday']);
  expect(summarize(rows, 'all', now).findings).toHaveLength(4);
});
test('progress distinguishes failed work; content-free status and date-sensitive cache rules', async () => {
  const c = new Controller(
    new DemoMailbox(),
    {
      analyze: async () => {
        throw new Error('Bad output');
      },
    },
    new MemoryStore(),
    'demo',
    'test',
  );
  await c.init();
  await c.start({ mode: 'unread', limit: 2, order: 'newest' });
  expect(c.progress.resolved).toBe(2);
  expect(c.progress.reviewed).toBe(0);
  expect(c.progress.failed).toBe(2);
  const status = JSON.stringify(statusSnapshot(c));
  expect(status).not.toContain(c.messages[0].subject);
  expect(status).not.toContain(c.messages[0].body);
  const a = demoMessages()[6].analysis!;
  expect(reusableAnalysis({ ...a, analyzedAt: '2000-01-01' })).toBe(true);
  expect(reusableAnalysis({ ...a, deadline: 'tomorrow', analyzedAt: '2000-01-01' })).toBe(true);
  expect(cacheKey(fixture(), 'openai', 'a', 1500)).not.toBe(
    cacheKey(fixture(), 'openai', 'a', 3000),
  );
  await c.close();
});

test('new batches use the new model and model changes are blocked while working', async () => {
  const config = loadConfig(false, {});
  const c = new Controller(
    new DemoMailbox(),
    new DemoAnalyzer(),
    new MemoryStore(),
    'demo',
    'fictional',
  );
  await c.init();
  await c.start({ mode: 'unread', limit: 2, order: 'newest' });
  c.model = 'different-model';
  let analyzed = 0;
  const delegate = new DemoAnalyzer();
  c.analyzer = {
    analyze: async (m, signal) => {
      analyzed++;
      return delegate.analyze(m, signal);
    },
  };
  const run = c.start({ mode: 'unread', limit: 2, order: 'newest' });
  await expect(c.saveSettings(settingsFrom(config), config)).rejects.toThrow('Stop');
  await run;
  expect(analyzed).toBe(2);
  expect(c.reused).toBe(0);
  await c.close();
});
test('mark read and immediate undo during review resume analysis; a failed manual review can be retried', async () => {
  const c = new Controller(
    new DemoMailbox(),
    new DemoAnalyzer(),
    new MemoryStore(),
    'demo',
    'fictional',
    1,
  );
  await c.init();
  const run = c.refresh();
  await Bun.sleep(80);
  const target = c.messages[0];
  await c.apply([target.id]);
  await run;
  expect(c.busy).toBe(true);
  await c.undo(c.session!.receipts[0].id);
  expect(target.read).toBe(false);
  expect(c.session!.receipts[0].status).toBe('undone');
  while (c.busy) await Bun.sleep(10);
  expect(target.read).toBe(false);
  expect(c.session?.state).toBe('complete');
  expect(c.progress.resolved).toBe(c.session!.uids.length);
  const other = c.messages.find((m) => !m.read)!;
  const analyzer = c.analyzer;
  c.analyzer = {
    analyze: async () => {
      throw new Error('Temporary malformed result');
    },
  };
  await c.reviewOne(other.id);
  expect(c.failed).toBe(1);
  c.analyzer = analyzer;
  await c.retry();
  expect(c.failed).toBe(0);
  expect(other.analysis).toBeDefined();
  await c.close();
});

test('inbox synthesis uses saved findings, bounded chunks, and reuses unchanged chunks', async () => {
  const calls: any[] = [];
  const request = (async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return Response.json(response({ summary: 'Combined saved findings.' }));
  }) as typeof fetch;
  const analyzer = new ModelAnalyzer(loadConfig(false, {}), request);
  const base = demoMessages()[0];
  const rows = Array.from({ length: 21 }, (_, i) => ({
    ...structuredClone(base),
    id: String(i),
    uid: i,
    subject: `Saved finding ${i}`,
    body: 'RAW_EMAIL_BODY_MUST_NOT_BE_RESENT',
  }));
  const signal = new AbortController().signal;
  expect(await analyzer.summarizeInbox(rows, signal)).toBe('Combined saved findings.');
  expect(calls).toHaveLength(3);
  const inputs = calls.map((call) => JSON.parse(call.input[0].content));
  expect(inputs.map((input) => input.phase)).toEqual(['notes', 'notes', 'briefing']);
  expect(inputs[2].counts).toMatchObject({ analyzed: 21, act: 21, replyRequested: 21 });
  expect(JSON.stringify(calls)).not.toContain('RAW_EMAIL_BODY_MUST_NOT_BE_RESENT');
  await analyzer.summarizeInbox(rows, signal);
  expect(calls).toHaveLength(3);
  rows.push({ ...structuredClone(base), id: '21', uid: 21, subject: 'One more saved finding' });
  await analyzer.summarizeInbox(rows, signal);
  expect(calls).toHaveLength(5);
  expect(calls.every((call) => call.store === false)).toBe(true);
});

test('inbox briefing receives exact action, reply, newsletter and cleanup counts from the review outcomes', async () => {
  const mail = demoMessages();
  const bank = structuredClone(mail[0]);
  bank.subject = 'Bank payment request';
  bank.analysis!.requires_response = false;
  const reports = [1, 2].map((n) => ({
    ...structuredClone(mail[0]),
    id: `report-${n}`,
    uid: 500 + n,
    sender: `Customer ${n}`,
    subject: 'App is not working',
  }));
  const rows = [bank, ...reports, mail[3], mail[12], mail[6]];
  const m = mocked([
    { summary: 'You have three emails needing action, including two asking for replies.' },
  ]);
  await m.analyzer.summarizeInbox(rows, new AbortController().signal);
  const input = JSON.parse(m.calls[0].body.input[0].content);
  expect(input.counts).toEqual({
    analyzed: 6,
    act: 3,
    read: 2,
    canMarkRead: 1,
    checkManually: 0,
    replyRequested: 2,
    newsletterIssues: 2,
    newslettersWorthReading: 1,
  });
  expect(input.findings).toHaveLength(5);
  expect(input.findings.filter((finding: any) => finding.replyRequested)).toHaveLength(2);
  expect(input.findings.some((finding: any) => finding.subject === 'Bank payment request')).toBe(
    true,
  );
});

test('analysis language defaults and legacy settings migrate safely; caches separate languages', () => {
  const config = loadConfig(false, {});
  expect(config.analysisLanguage).toBe('en');
  expect(loadConfig(false, { ANALYSIS_LANGUAGE: 'ru' }).analysisLanguage).toBe('ru');
  expect(() => loadConfig(false, { ANALYSIS_LANGUAGE: 'nl' })).toThrow();
  const { analysisLanguage, ...legacy } = settingsFrom(config);
  expect(SettingsSchema.parse(legacy).analysisLanguage).toBe('en');
  expect(() => SettingsSchema.parse({ ...legacy, analysisLanguage: 'nl' })).toThrow();
  expect(cacheKey(fixture(), 'openai', 'test', 3000, 'en')).not.toBe(
    cacheKey(fixture(), 'openai', 'test', 3000, 'ru'),
  );
  expect(classificationKey(fixture(), 'openai', 'test', 3000, 'en')).not.toBe(
    classificationKey(fixture(), 'openai', 'test', 3000, 'ru'),
  );
});

test('both providers use the selected language for Dutch mail, inbox briefings and newsletter digests while retaining evidence', async () => {
  for (const provider of ['openai', 'ollama'] as const) {
    for (const language of ['en', 'ru'] as const) {
      const message = {
        ...demoMessages()[0],
        subject: 'Vrijwillige ouderbijdrage',
        body: 'Betaal de vrijwillige bijdrage voor donderdag.',
      };
      const summary =
        language === 'ru'
          ? 'Школа просит добровольный взнос.'
          : 'The school requests a voluntary contribution.';
      const detail = compact({
        ...message.analysis,
        takeaway: summary,
        action:
          language === 'ru'
            ? 'Решите, хотите ли вы внести взнос до четверга.'
            : 'Decide whether to contribute before Thursday.',
        reason: summary,
        deadline: 'voor donderdag',
        evidence: ['vrijwillige bijdrage'],
      });
      const h = mocked([detail, { summary }, { summary }], provider);
      h.config.analysisLanguage = language;
      const signal = new AbortController().signal;
      const analysis = await h.analyzer.analyze(message, signal);
      expect(analysis.takeaway).toBe(summary);
      expect(analysis.deadline).toBe('voor donderdag');
      expect(analysis.evidence).toEqual(['vrijwillige bijdrage']);
      expect(message.body).toBe('Betaal de vrijwillige bijdrage voor donderdag.');
      const reviewed = [{ ...message, analysis }];
      expect(await h.analyzer.summarizeInbox(reviewed, signal)).toBe(summary);
      expect(await h.analyzer.digest(reviewed, signal)).toBe(summary);
      const generations = h.calls.filter((call) => !call.url.endsWith('/api/show'));
      expect(generations).toHaveLength(3);
      for (const { body } of generations) {
        const instructions = body.instructions ?? body.messages[0].content;
        expect(instructions).toContain(
          'Write all generated user-facing prose in ' + (language === 'ru' ? 'Russian' : 'English'),
        );
        expect(instructions).not.toContain("Preserve the email's language");
        expect(instructions).toContain('exact original substrings');
      }
    }
  }
});

test('routine classification explanations use Russian without an extra model call', async () => {
  for (const provider of ['openai', 'ollama'] as const) {
    const h = mocked([provider === 'openai' ? decisionResponse(routine) : routine], provider);
    h.config.analysisLanguage = 'ru';
    const result = await h.analyzer.review(fixture(), new AbortController().signal, () => {});
    expect(result.reason).toContain('Обычное уведомление');
    expect(result.takeaway).toBe(result.reason);
    expect(h.calls.filter((call) => !call.url.endsWith('/api/show'))).toHaveLength(1);
    expect(result.priority).toBe('low');
  }
});

test('changing language refreshes aggregate caches without reanalyzing completed emails', async () => {
  const config = loadConfig(false, {});
  const analyzer: Analyzer = new DemoAnalyzer();
  let summaries = 0,
    digests = 0;
  analyzer.summarizeInbox = async () => `${config.analysisLanguage} inbox ${++summaries}`;
  analyzer.digest = async () => `${config.analysisLanguage} digest ${++digests}`;
  const c = new Controller(
    new DemoMailbox(),
    analyzer,
    new MemoryStore(),
    'demo',
    'test',
    2,
    config,
  );
  try {
    await c.init();
    await c.start({ mode: 'unread', limit: 2, order: 'oldest' });
    await c.updateInboxSummary();
    const ids = c.pool.map((m) => m.id);
    await c.reviewNewsletter(ids);
    const saved = JSON.stringify(c.pool.map((m) => m.analysis));
    const oldSummary = c.inboxSummary;
    expect(c.newsletterDigest(ids)?.text).toContain('en digest');
    await c.saveSettings({ ...settingsFrom(config), analysisLanguage: 'ru' });
    expect(c.inboxSummary).not.toBe(oldSummary);
    expect(c.newsletterDigest(ids)).toBeUndefined();
    await c.refreshInboxSummary();
    await c.reviewNewsletter(ids);
    expect(c.inboxSummary).toContain('ru inbox');
    expect(c.newsletterDigest(ids)?.text).toContain('ru digest');
    expect(JSON.stringify(c.pool.map((m) => m.analysis))).toBe(saved);
  } finally {
    await c.close();
  }
});

test('large newsletter digests include every issue through bounded synthesis batches', async () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({
    ...demoMessages()[3],
    id: `issue-${i}`,
    subject: `Issue ${i}`,
    uid: 8000 + i,
  }));
  const h = mocked([
    { summary: 'First batch topics' },
    { summary: 'Second batch topics' },
    { summary: 'Last batch topics' },
    { summary: 'Combined all forty issues' },
  ]);
  expect(await h.analyzer.digest(messages, new AbortController().signal)).toBe(
    'Combined all forty issues',
  );
  const inputs = h.calls.map((call) => JSON.parse(call.body.input[0].content));
  expect(
    inputs
      .filter((input) => input.phase === 'notes')
      .flatMap((input) => input.findings.map((m: any) => m.id)),
  ).toEqual(messages.map((m) => m.id));
  expect(inputs.at(-1).issueCount).toBe(40);
  expect(inputs.at(-1).notes).toHaveLength(3);
  expect(h.calls.every((call) => call.body.max_output_tokens === 3200)).toBe(true);
});

test('subscription synthesis sends saved substance, not original bodies or reading advice', async () => {
  const message = structuredClone(demoMessages()[3]);
  message.body = 'Original body must not be sent for synthesis.';
  message.analysis!.takeaway = 'Indexes reduced the measured query time from 80ms to 12ms.';
  message.analysis!.recommendation_reason = 'Worth reading for database engineers.';
  const h = mocked([{ summary: 'Database tuning: the June issue reports faster queries.' }]);
  await h.analyzer.digest([message], new AbortController().signal);
  expect(h.calls).toHaveLength(1);
  const request = JSON.stringify(h.calls[0].body);
  expect(request).toContain(message.analysis!.takeaway);
  expect(request).not.toContain(message.body);
  expect(request).not.toContain(message.analysis!.recommendation_reason);
  const input = JSON.parse(h.calls[0].body.input[0].content);
  expect(input.findings[0].subject).toBe(message.subject);
  expect(input.findings[0].date).toBe(message.date);
  expect(input.findings[0].summaryAvailable).toBe(true);
});

test('subscription digests use exact retained issue IDs and cache unread and all scopes separately', async () => {
  const store = new MemoryStore();
  const [unread, read] = demoMessages().slice(3, 5);
  read.read = true;
  const analyzer: Analyzer = new DemoAnalyzer();
  const calls: string[][] = [];
  analyzer.digest = async (messages) => {
    calls.push(messages.map((m) => m.id));
    return messages.map((m) => m.subject).join('\n');
  };
  const c = new Controller(new DemoMailbox(), analyzer, store, 'demo', 'fictional');
  await c.init();
  c.saved.library = { [unread.id]: unread, [read.id]: read };
  try {
    await c.reviewNewsletter([unread.id]);
    const unreadDigest = c.newsletterDigest([unread.id]);
    expect(unreadDigest?.messageIDs).toEqual([unread.id]);
    expect(c.newsletterDigest([unread.id, read.id])).toBeUndefined();
    await c.reviewNewsletter([unread.id, read.id]);
    expect(c.newsletterDigest([unread.id, read.id])?.messageIDs).toEqual([unread.id, read.id]);
    expect(c.newsletterDigest([unread.id])).toEqual(unreadDigest);
    await c.reviewNewsletter([unread.id, read.id]);
    expect(calls).toEqual([[unread.id], [unread.id, read.id]]);
    expect(c.pool.map((m) => m.id)).toEqual([unread.id]);
    expect(read.read).toBe(true);
    expect(unread.read).toBe(false);
  } finally {
    await c.close();
  }
});
