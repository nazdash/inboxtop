import { test, expect } from 'bun:test';
import { ChatSession, EMPTY_SEARCH, searchChat, type ChatStep } from '../src/chat.ts';
import {
  discoverChat,
  savedFindings,
  originalPassage,
  mergeOriginalPassages,
  type OriginalExcerpt,
} from '../src/chat-retrieval.ts';
import { demoMessages } from '../src/demo.ts';
import type { Message } from '../src/domain.ts';

const step = (action: ChatStep['action'], extra: Partial<ChatStep> = {}): ChatStep => ({
  action,
  plan: null,
  search: { ...EMPTY_SEARCH },
  sources: [],
  text: '',
  ...extra,
});
function issues(count: number): Message[] {
  const base = demoMessages().find((m) => m.analysis?.kind === 'newsletter')!;
  return Array.from({ length: count }, (_, i) => ({
    ...structuredClone(base),
    id: `demo:INBOX:1:${1000 + i}`,
    uid: 1000 + i,
    sender: `Publication ${i % 3}`,
    address: `editor${i % 3}@example.invalid`,
    subject: `Issue ${i}`,
    date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
    read: i % 2 === 0,
    body: `Original issue ${i}: concrete research findings.`,
    analysis: {
      ...structuredClone(base.analysis!),
      takeaway: `Finding ${i}: measuring actual outcomes matters.`,
      topics: [{ title: `Topic ${i}`, summary: 'A distinct saved insight.', relevance: 'high' }],
      key_facts: [`Measured result ${i}`],
      action: '',
      context: '',
      secondary_actions: [],
      blockers: [],
    },
  }));
}

test('scope and paginated search cover the same retained collection, including read mail', () => {
  const rows = issues(35);
  const q = {
    ...EMPTY_SEARCH,
    kind: 'newsletter' as const,
    after: '2026-09-01',
    before: '2026-09-30',
    limit: 10,
  };
  const scope = discoverChat(rows, q);
  expect(scope).toMatchObject({
    total: 35,
    read: 18,
    unread: 17,
    earliest: '2026-09-01',
    latest: '2026-09-28',
    senderCount: 3,
  });
  expect(scope.senders.reduce((sum, s) => sum + s.count, 0)).toBe(35);
  const ids: string[] = [];
  let offset: number | null = 0;
  do {
    const page = searchChat(rows, { ...q, offset });
    ids.push(...page.messages.map((m) => m.id));
    offset = page.nextOffset;
  } while (offset !== null);
  expect(new Set(ids).size).toBe(35);
  expect(ids).toEqual(
    searchChat([...rows].reverse(), { ...q, limit: 30 })
      .messages.map((m) => m.id)
      .concat(searchChat(rows, { ...q, offset: 30 }).messages.map((m) => m.id)),
  );
  expect(searchChat(rows, { ...q, state: 'unread' }).total).toBe(17);
  expect(searchChat(rows, { ...q, after: '2026-10-01', before: '' }).total).toBe(0);
  expect(() => searchChat(rows, { ...q, before: '2026-01-01' })).toThrow('start date');
});

test('search finds multilingual bike and school details in topics/facts; originals require explicit area', () => {
  const rows = issues(3);
  rows[0].analysis!.topics = [
    { title: 'Велосипед', summary: 'Ремонт велосипеда в сентябре', relevance: 'high' },
  ];
  rows[1].analysis!.key_facts = ['School trip consent must be returned Friday.'];
  rows[2].body = 'The dental clinic says the outstanding invoice is EUR 95.';
  expect(
    searchChat(rows, { ...EMPTY_SEARCH, terms: ['bicycle', 'ремонт'] }).messages.map((m) => m.id),
  ).toEqual([rows[0].id]);
  expect(
    searchChat(rows, { ...EMPTY_SEARCH, terms: ['school'] }).messages.map((m) => m.id),
  ).toEqual([rows[1].id]);
  expect(searchChat(rows, { ...EMPTY_SEARCH, terms: ['dental'] }).total).toBe(0);
  expect(
    searchChat(rows, { ...EMPTY_SEARCH, area: 'original', terms: ['dental'] }).messages.map(
      (m) => m.id,
    ),
  ).toEqual([rows[2].id]);
  expect(searchChat(rows, { ...EMPTY_SEARCH, terms: ['.*'] }).total).toBe(0);
});

test('free-form newsletter synthesis gathers multiple pages with stable citations despite live changes', async () => {
  let rows = issues(30);
  const query = {
    ...EMPTY_SEARCH,
    kind: 'newsletter' as const,
    after: '2026-07-01',
    before: '2026-10-01',
    limit: 15,
  };
  let call = 0;
  const chat = new ChatSession(
    () => rows,
    async (input) => {
      const c = JSON.parse(input.context);
      expect(input.context.length).toBeLessThanOrEqual(36000);
      switch (call++) {
        case 0:
          return step('scope', { search: query });
        case 1:
          expect(c.tools[0].total).toBe(30);
          expect(c.evidence).toHaveLength(0);
          return step('findings', { search: query });
        case 2:
          expect(c.tools.at(-1).nextOffset).toBe(15);
          rows = []; // A background sync cannot shift the in-flight turn's pages.
          return step('findings', { search: { ...query, offset: 15 } });
        default: {
          const docs = c.evidence[0].results;
          expect(docs).toHaveLength(30);
          expect(new Set(docs.map((d: any) => d.ref)).size).toBe(30);
          expect(docs.every((d: any) => d.id === undefined)).toBe(true);
          expect(new Set(chat.sources.map((source) => source.id)).size).toBe(30);
          expect(docs.every((d: any) => d.facts.length && d.topics.length)).toBe(true);
          expect(c.tools.at(-1).nextOffset).toBeNull();
          return step('answer', {
            sources: [docs[0].ref, docs[29].ref],
            text: `Based on saved summaries of 30 issues: distinct themes [${docs[0].ref}][${docs[29].ref}].`,
          });
        }
      }
    },
  );
  await chat.send(
    'What are the most interesting ideas in my newsletters from the last three months?',
  );
  expect(chat.error).toBe('');
  expect(call).toBe(4);
  expect(chat.entries.at(-1)?.sources).toHaveLength(2);
  expect(chat.snapshot().sources).toHaveLength(30);
});

test('a dental question can inspect a late original passage and follow up without re-searching', async () => {
  const rows = issues(1);
  rows[0].body =
    'Unrelated introduction. '.repeat(400) +
    'Dental clinic: outstanding EUR 95. Please pay by September 30.';
  const inputs: any[] = [];
  const plan = [
    step('search', { search: { ...EMPTY_SEARCH, area: 'original', terms: ['dental'] } }),
    step('read', { sources: [1], search: { ...EMPTY_SEARCH, terms: ['outstanding'] } }),
    step('answer', {
      sources: [1],
      text: 'The clinic requested EUR 95; this old notice does not prove it remains unpaid [1].',
    }),
    step('findings', { sources: [1] }),
    step('read', { sources: [1], search: { ...EMPTY_SEARCH, terms: ['September'] } }),
    step('answer', { sources: [1], text: 'The stated deadline was September 30 [1].' }),
  ];
  const chat = new ChatSession(
    () => rows,
    async (input) => {
      inputs.push(JSON.parse(input.context));
      return plan.shift()!;
    },
  );
  await chat.send('Is there an email saying I owe the dental clinic money?');
  const docs = inputs[2].evidence[0].results;
  expect(docs).toHaveLength(1);
  expect(docs[0].passages[0].start).toBeGreaterThan(6000);
  expect(docs[0].passages[0].text).toContain('EUR 95');
  expect(docs[0].passages[0].complete).toBe(false);
  rows[0].read = true;
  await chat.send('When was that due?');
  expect(chat.error).toBe('');
  expect(chat.sources).toHaveLength(1);
  expect(inputs[5].evidence[0].results[0].read).toBe(true);
});

test('original passages support sequential paging, missing matches and incomplete originals honestly', () => {
  const m = issues(1)[0];
  m.body = 'a'.repeat(9000) + 'payment';
  m.complete = false;
  const first = originalPassage(m, 0, []);
  expect(first.nextOffset).toBe(4000);
  expect(first.complete).toBe(false);
  expect(originalPassage(m, 8000, []).text).toContain('payment');
  expect(originalPassage(m, 0, ['absent']).matched).toBe(false);
  expect(originalPassage(m, 0, ['payment']).originalComplete).toBe(false);
  expect(originalPassage(m, 99999, []).text).toBe('');
  m.body = 'İ'.repeat(9000) + 'PAYMENT .* [invoice]';
  expect(originalPassage(m, 0, ['payment']).start).toBe(8600);
  expect(originalPassage(m, 0, ['.*']).text).toContain('PAYMENT');
  expect(originalPassage(m, 0, ['[missing]']).matched).toBe(false);
});

test('IMAP model context contains only compact headers and selected deduplicated original excerpts', async () => {
  const row = issues(1)[0];
  row.id = 'private-account:INBOX:7:9';
  row.analysis = undefined;
  row.classification = undefined;
  row.subject = 'Newsletter title '.repeat(100);
  row.sender = 'Newsletter sender '.repeat(30);
  row.body =
    'UNSELECTED_INTRO'.padEnd(12000, '.') +
    'REPAIR_COST_EVIDENCE: EUR 95.'.padEnd(4000, '.') +
    'UNSELECTED_TAIL'.padEnd(44000, '.');
  row.complete = true;
  let calls = 0,
    bodies = 0;
  const chat = new ChatSession(
    () => [],
    async (input) => {
      const context = JSON.parse(input.context);
      expect(input.context).not.toContain(row.id);
      expect(input.context).not.toContain('UNSELECTED_INTRO');
      expect(input.context).not.toContain('UNSELECTED_TAIL');
      expect(input.context.length).toBeLessThan(10000);
      const n = calls++;
      if (n === 0) return step('mailbox_search');
      const doc = context.evidence[0].results[0];
      expect(doc.subject).toHaveLength(300);
      expect(doc.sender).toHaveLength(160);
      expect(doc.metadataTruncated).toBe(true);
      if (n === 1) {
        expect(doc.passages).toBeUndefined();
        expect(input.context).not.toContain('REPAIR_COST_EVIDENCE');
        return step('read', {
          sources: [1],
          search: { ...EMPTY_SEARCH, terms: ['REPAIR_COST_EVIDENCE'] },
        });
      }
      if (n === 2) {
        expect(doc.passages[0].text).toHaveLength(4000);
        return step('read', { sources: [1], search: { ...EMPTY_SEARCH, offset: 12000 } });
      }
      expect(doc.passages).toHaveLength(1);
      expect(doc.passages[0]).toMatchObject({
        start: 11600,
        end: 16000,
        nextOffset: 16000,
        totalCharacters: 60000,
        complete: false,
      });
      expect(doc.passages[0].text).toBe(row.body.slice(11600, 16000));
      expect(doc.passages[0].text.match(/REPAIR_COST_EVIDENCE/g)).toHaveLength(1);
      return step('answer', {
        sources: [1],
        text: 'The selected passage quotes EUR 95 [1]. The rest was not reviewed.',
      });
    },
    () => {},
    {
      search: async (scope) => ({
        messages: [{ ...row, body: '', complete: false }],
        nextOffset: null,
        complete: true,
        countQuality: 'exact',
        matched: 1,
        at: '2026-10-17T00:00:00Z',
        scope,
        omissions: [],
      }),
      read: async () => {
        bodies++;
        return row;
      },
    },
  );
  await chat.send('What does this newsletter say about repair cost?');
  expect(chat.error).toBe('');
  expect(bodies).toBe(1);
  expect(calls).toBe(4);
  expect(chat.sources[0]).toMatchObject({ id: row.id, subject: row.subject, sender: row.sender });
});

test('excerpt merging preserves gaps, accurate completeness and the original inputs', () => {
  const row = issues(1)[0];
  row.body = 'a'.repeat(10000);
  row.complete = true;
  const excerpts = [
    originalPassage(row, 0, []),
    originalPassage(row, 3000, []),
    originalPassage(row, 2000, []),
  ] as OriginalExcerpt[];
  const before = structuredClone(excerpts);
  const merged = mergeOriginalPassages(excerpts);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ start: 0, end: 7000, nextOffset: 7000, complete: false });
  expect(merged[0].text).toHaveLength(7000);
  expect(excerpts).toEqual(before);
  const withGap = mergeOriginalPassages([
    originalPassage(row, 0, []),
    originalPassage(row, 8000, []),
  ] as OriginalExcerpt[]);
  expect(withGap).toHaveLength(2);
  expect(withGap.every((p) => !p.complete)).toBe(true);
  const complete = mergeOriginalPassages([
    ...merged,
    originalPassage(row, 7000, []),
  ] as OriginalExcerpt[]);
  expect(complete[0]).toMatchObject({ start: 0, end: 10000, nextOffset: null, complete: true });
});

test('repeated search/findings/read merge evidence without duplicate documents or passages', async () => {
  const rows = issues(1);
  const plan = [
    step('search'),
    step('findings', { sources: [1] }),
    step('search'),
    step('read', { sources: [1] }),
    step('read', { sources: [1] }),
    step('answer', { sources: [1], text: 'Saved findings and original [1].' }),
  ];
  const chat = new ChatSession(
    () => rows,
    async (input) => {
      const c = JSON.parse(input.context);
      if (c.evidence.length) expect(c.evidence[0].results).toHaveLength(1);
      if (plan.length === 1) {
        const doc = c.evidence[0].results[0];
        expect(doc.passages).toHaveLength(1);
        expect(doc.facts).toEqual(rows[0].analysis!.key_facts);
      }
      return plan.shift()!;
    },
  );
  await chat.send('Explain this issue');
  expect(chat.error).toBe('');
});

test('evidence budget retains admitted sources and reserves a model call for a qualified answer', async () => {
  const rows = issues(30);
  for (const m of rows) {
    m.analysis!.takeaway = 'Finding '.repeat(150);
    m.analysis!.topics = Array.from({ length: 5 }, () => ({
      title: 'Topic',
      summary: 'x'.repeat(1000),
      relevance: 'high',
    }));
    m.analysis!.key_facts = Array.from({ length: 8 }, () => 'y'.repeat(500));
  }
  let calls = 0;
  const chat = new ChatSession(
    () => rows,
    async (input) => {
      expect(input.context.length).toBeLessThanOrEqual(36000);
      const c = JSON.parse(input.context);
      if (calls++ === 0) return step('findings', { search: { ...EMPTY_SEARCH, limit: 30 } });
      expect(c.answerRequired).toBe(true);
      const docs = c.evidence[0].results;
      expect(docs.length).toBeGreaterThan(0);
      expect(docs.length).toBeLessThan(30);
      expect(c.tools.at(-1)).toMatchObject({
        total: 30,
        returned: docs.length,
        budgetLimited: true,
      });
      return step('answer', {
        sources: [docs[0].ref],
        text: `Only ${docs.length} of 30 summaries fit; these findings are partial [${docs[0].ref}].`,
      });
    },
  );
  await chat.send('Compare all issues');
  expect(chat.error).toBe('');
  expect(calls).toBe(2);
});

test('invalid dates and unknown read sources are recoverable; failed tools are not evidence', async () => {
  const rows = issues(1);
  const plan = [
    step('search', { search: { ...EMPTY_SEARCH, after: 'yesterday' } }),
    step('search'),
    step('read', { sources: [77] }),
    step('answer', { sources: [1], text: 'A supported finding [1].' }),
  ];
  let calls = 0;
  const chat = new ChatSession(
    () => rows,
    async (input) => {
      const c = JSON.parse(input.context);
      if (calls === 1 || calls === 3) {
        expect(c.tools.at(-1).error).toBeTruthy();
        expect(c.evidence).toHaveLength(calls === 1 ? 0 : 1);
      }
      calls++;
      return plan.shift()!;
    },
  );
  await chat.send('Find the issue');
  expect(chat.error).toBe('');
  expect(calls).toBe(4);
});

test('scope counts can answer metadata questions without pretending to read messages', async () => {
  let calls = 0;
  const chat = new ChatSession(
    () => issues(30),
    async (input) => {
      if (!calls++) return step('scope');
      const c = JSON.parse(input.context);
      expect(c.evidence).toHaveLength(0);
      expect(c.tools[0].total).toBe(30);
      return step('answer', { text: 'There are 30 retained analyzed issues.' });
    },
  );
  await chat.send('How many newsletter issues are available?');
  expect(chat.error).toBe('');
  expect(chat.sources).toHaveLength(0);
});

test('classification-only evidence remains identified and citations must appear in the answer', async () => {
  const m = issues(1)[0];
  m.analysis!.coverage = { stage: 'triage', characters: 100, total: 10000 };
  expect(savedFindings(m, true).evidenceType).toBe('classification_only');
  const plan = [
    step('search'),
    step('answer', { sources: [1], text: 'Unsupported uncited prose.' }),
    step('answer', { sources: [1], text: 'Only classification findings are available [1].' }),
  ];
  const chat = new ChatSession(
    () => [m],
    async () => plan.shift()!,
  );
  await chat.send('Summarize');
  expect(chat.error).toBe('');
  expect(chat.entries.at(-1)?.text).toContain('[1]');
  expect(chat.entries.some((e) => e.text === 'Unsupported uncited prose.')).toBe(false);
});

test('broad synthesis reserves an answer and one citation correction inside eight turns', async () => {
  const rows = issues(12);
  let calls = 0;
  const chat = new ChatSession(
    () => rows,
    async (input) => {
      const c = JSON.parse(input.context);
      const turn = calls++;
      if (turn < 6) {
        expect(c.answerRequired).toBe(false);
        return step('findings', { search: { ...EMPTY_SEARCH, offset: turn, limit: 1 } });
      }
      expect(c.answerRequired).toBe(true);
      expect(c.retrievalStepsRemaining).toBe(0);
      if (turn === 6) return step('answer', { text: 'Uncited draft', sources: [1] });
      expect(c.tools.at(-1).tool).toBe('answer_validation');
      expect(c.tools.at(-1).error).toContain('citations');
      return step('answer', {
        text: 'From six saved summaries: measure outcomes [1]. More issues remain.',
        sources: [1],
      });
    },
  );
  await chat.send('Summarize the last two months of newsletters');
  expect(calls).toBe(8);
  expect(chat.error).toBe('');
  expect(chat.entries.at(-1)?.coverage).toContain('6 saved summaries');
  expect(chat.entries.at(-1)?.coverage).toContain('Partial coverage');
  expect(chat.entries.some((e) => e.text === 'Uncited draft')).toBe(false);
});

test('invalid answers keep locally collected summaries without publishing unsupported prose', async () => {
  const rows = issues(2);
  let calls = 0;
  const chat = new ChatSession(
    () => rows,
    async () =>
      calls++ === 0
        ? step('findings')
        : step('answer', { text: 'Invented conclusion [99].', sources: [99] }),
  );
  await chat.send('Summarize my newsletters');
  expect(calls).toBe(3);
  expect(chat.error).toContain('evidence/citation');
  expect(chat.error).not.toContain('Search step limit');
  const evidence = chat.entries.at(-1)!;
  expect(evidence.role).toBe('app');
  expect(evidence.text).toContain('Collected evidence · partial');
  expect(evidence.text).toContain('Saved AI summary');
  expect(evidence.text).toContain('measuring actual outcomes');
  expect(evidence.text).not.toContain('Invented conclusion');
  expect(evidence.sources).toEqual([1, 2]);
  expect(evidence.coverage).toContain('2 saved summaries');
  expect(evidence.details?.stop).toBe('answer_validation_failed');
  const restored = new ChatSession(
    () => rows,
    async () => {
      throw new Error('No replay');
    },
  );
  restored.restore(chat.snapshot());
  expect(restored.entries.at(-1)).toEqual(evidence);
});

test('a model ignoring the finish signal cannot execute more tools and keeps original excerpts', async () => {
  const row = issues(1)[0];
  row.analysis = undefined;
  row.classification = undefined;
  let calls = 0;
  const chat = new ChatSession(
    () => [row],
    async () => {
      const turn = calls++;
      if (turn === 0) return step('search');
      if (turn === 1) return step('read', { sources: [1] });
      return step('read', { sources: [1], search: { ...EMPTY_SEARCH, offset: 5 } });
    },
    () => {},
    { beforeModel: async () => calls >= 2 },
  );
  await chat.send('Read this newsletter');
  expect(calls).toBe(4);
  expect(chat.details.operations.filter((op) => op.tool === 'read')).toHaveLength(1);
  expect(chat.entries.at(-1)?.text).toContain('Original excerpt');
  expect(chat.entries.at(-1)?.coverage).toContain('1 originals');
  expect(chat.error).toContain('instead of finishing');
});

test('header-only evidence is not presented as a summary after provider failure', async () => {
  const row = issues(1)[0];
  row.analysis = undefined;
  row.classification = undefined;
  row.body = '';
  let calls = 0;
  const chat = new ChatSession(
    () => [row],
    async () => {
      if (!calls++) return step('search');
      throw new Error('Provider unavailable');
    },
  );
  await chat.send('Summarize');
  expect(calls).toBe(2);
  expect(chat.error).toBe('Provider unavailable');
  expect(chat.details.stop).toBe('provider_failure');
  expect(chat.entries.at(-1)?.text).toContain('not enough content to summarize');
  expect(chat.entries.at(-1)?.coverage).toContain(
    '0 saved summaries · 0 originals · 1 metadata-only',
  );
});
