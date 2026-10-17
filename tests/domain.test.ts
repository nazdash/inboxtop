import { test, expect } from 'bun:test';
import { demoMessages } from '../src/demo.ts';
import {
  briefing,
  cleanupCandidate,
  clean,
  safeURL,
  senders,
  sortMessages,
  filterMessages,
} from '../src/domain.ts';
import {
  validateAnalysis,
  DetailSchema,
  cacheKey,
  ModelAnalyzer,
  ProviderFailure,
  responseText,
} from '../src/analysis.ts';
import { loadConfig, reasoningEffort, DEFAULT_OPENAI_MODEL } from '../src/config.ts';
import { parseMessage } from '../src/mail.ts';

test('cleanup excludes obligations, uncertainty, incomplete and explicitly kept mail', () => {
  const m = demoMessages()[6];
  expect(cleanupCandidate(m)).toBe(true);
  for (const override of [
    { requires_response: true },
    { action: 'Reply with your approval' },
    { secondary_actions: ['Send the documents'] },
    { deadline: 'Friday' },
    { uncertain: true },
    { intent: 'time_sensitive' },
    { source_type: 'unknown' },
    { recommended: true },
  ])
    expect(
      cleanupCandidate({ ...m, analysis: { ...m.analysis!, ...override } as typeof m.analysis }),
    ).toBe(false);
  for (const override of [
    { complete: false },
    { kept: true },
    { read: true },
    { present: false },
    { error: 'retry' },
  ])
    expect(cleanupCandidate({ ...m, ...override })).toBe(false);
});
test('briefing retains every action and reading-only recommendations', () => {
  const m = demoMessages();
  const many = Array.from({ length: 30 }, (_, i) => ({ ...m[0], id: String(i) }));
  expect(briefing(many).filter((f) => f.section === 'Action Required')).toHaveLength(30);
  expect(briefing([m[3]])[0].section).toBe('Worth Reading');
  expect(senders(m).find((s) => s.name === 'Field Notes')?.messages).toHaveLength(2);
});
test('evidence validation and conservative priority normalization', () => {
  const m = demoMessages()[0];
  expect(() => validateAnalysis({ ...m.analysis, evidence: ['invented'] }, m)).toThrow('evidence');
  expect(validateAnalysis({ ...m.analysis, priority: 'archive' }, m).priority).toBe('medium');
  expect(() => validateAnalysis({ ...m.analysis, deadline: 'next year' }, m)).toThrow('deadline');
  expect(validateAnalysis(m.analysis, { ...m, complete: false }).uncertain).toBe(true);
  expect(cacheKey(m, 'openai', 'a')).not.toBe(cacheKey(m, 'openai', 'b'));
});
test('untrusted terminal text and unsafe links are inert', () => {
  expect(clean('\x1b]52;c;secret\x07Hello\x1b[2J\u202eevil')).toBe('Helloevil');
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://127.0.0.1/a',
    'https://user:pass@example.com',
  ])
    expect(safeURL(url)).toBeUndefined();
  expect(safeURL('https://example.com/unsubscribe')).toBe('https://example.com/unsubscribe');
});
test('MIME HTML content, encoded subjects, list headers and terminal controls', async () => {
  const base = demoMessages()[0];
  const raw = Buffer.from(
    'From: Newsletter <news@example.com>\r\nSubject: =?UTF-8?B?SGVsbG8=?=\r\nList-ID: Example <weekly.example.com>\r\nList-Unsubscribe: <https://example.com/unsubscribe>, <mailto:leave@example.com>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h1>Hello</h1><p>Read this update.</p>',
  );
  const parsed = await parseMessage(raw, base);
  expect(parsed.subject).toBe('Hello');
  expect(parsed.body).toContain('Read this update.');
  expect(parsed.listID).toBe('weekly.example.com');
  expect(parsed.unsubscribe).toBe('https://example.com/unsubscribe');
});
test('OpenAI payload uses strict schema, isolated data and rejects provider failure', async () => {
  const m = demoMessages()[6];
  let captured: any;
  let endpoint: unknown;
  const request = (async (_url: unknown, options: RequestInit) => {
    endpoint = _url;
    captured = JSON.parse(String(options.body));
    return Response.json({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: JSON.stringify(DetailSchema.strip().parse(m.analysis)) },
          ],
        },
      ],
    });
  }) as typeof fetch;
  const config = loadConfig(false, {});
  const model = new ModelAnalyzer(config, request);
  expect((await model.analyze(m, new AbortController().signal)).priority).toBe('low');
  expect(captured.store).toBe(false);
  expect(endpoint).toBe('https://api.openai.com/v1/responses');
  expect(captured.text.format.strict).toBe(true);
  expect(captured.input[0].role).toBe('user');
  expect(captured.model).toBe(DEFAULT_OPENAI_MODEL);
  expect(captured.reasoning.effort).toBe('low');
  expect(captured.temperature).toBeUndefined();
  expect(reasoningEffort('gpt-4o-mini')).toBeUndefined();
  expect(loadConfig(false, { OPENAI_MODEL: 'custom-model' }).model).toBe('custom-model');
  const failing = new ModelAnalyzer(
    config,
    (async () => new Response('', { status: 429 })) as unknown as typeof fetch,
  );
  await expect(failing.analyze(m, new AbortController().signal)).rejects.toBeInstanceOf(
    ProviderFailure,
  );
});

test('Responses rejects incomplete, refused and missing text without trusting partial JSON', () => {
  expect(() => responseText({ status: 'incomplete', output: [] })).toThrow('incomplete');
  expect(() =>
    responseText({
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] },
      ],
    }),
  ).toThrow('declined');
  expect(() =>
    responseText({
      status: 'completed',
      output: [
        { type: 'reasoning', content: [{ type: 'output_text', text: 'not a final answer' }] },
      ],
    }),
  ).toThrow('no review');
});
test('importance ordering is deterministic, conservative, and leaves fetch order unchanged', () => {
  const rows = demoMessages();
  const high = rows[0],
    medium = rows[3],
    reply = rows[4],
    low = rows[6],
    archive = rows[9];
  const pending = { ...rows[8], analysis: undefined, id: 'pending' };
  const uncertain = {
    ...rows[7],
    id: 'uncertain',
    analysis: { ...rows[7].analysis!, uncertain: true },
  };
  const read = { ...high, id: 'read', read: true };
  const input = [archive, read, low, medium, pending, high, reply, uncertain];
  const original = input.map((m) => m.id);
  const sorted = sortMessages(input);
  expect(input.map((m) => m.id)).toEqual(original);
  expect(sorted[0].id).toBe(high.id);
  expect(sorted[1].id).toBe(reply.id);
  expect(sorted.at(-1)?.id).toBe('read');
  expect(sorted.findIndex((m) => m.id === 'pending')).toBeLessThan(
    sorted.findIndex((m) => m.id === low.id),
  );
  expect(sorted.findIndex((m) => m.id === 'uncertain')).toBeLessThan(
    sorted.findIndex((m) => m.id === low.id),
  );
  expect(sorted.findIndex((m) => m.id === medium.id)).toBeLessThan(
    sorted.findIndex((m) => m.id === low.id),
  );
  expect(sorted.findIndex((m) => m.id === low.id)).toBeLessThan(
    sorted.findIndex((m) => m.id === archive.id),
  );
  expect(sortMessages([...input].reverse()).map((m) => m.id)).toEqual(sorted.map((m) => m.id));
  expect(filterMessages(rows, 'action').map((m) => m.sender)).toContain('Alex Morgan');
});
test('date sorts use received dates; invalid dates and ties do not destabilize ordering', () => {
  const base = demoMessages()[0];
  const rows = [
    { ...base, id: 'z', date: '' },
    { ...base, id: 'a', date: '2026-01-01' },
    { ...base, id: 'b', date: '2026-10-01' },
  ];
  expect(sortMessages(rows, 'newest').map((m) => m.id)).toEqual(['b', 'a', 'z']);
  expect(sortMessages(rows, 'oldest').map((m) => m.id)).toEqual(['z', 'a', 'b']);
});
