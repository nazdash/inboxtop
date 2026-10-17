import { test, expect } from 'bun:test';
import { IMAPChatMailbox } from '../src/chat-mail.ts';
import { loadConfig, accountID } from '../src/config.ts';
import { ChatRunner } from '../src/chat-runner.ts';
import { ChatSession, EMPTY_SEARCH, chatCorpus, type ChatStep } from '../src/chat.ts';
import { savedFindings } from '../src/chat-retrieval.ts';
import {
  emptyUsage,
  LIMITS,
  ChatMailboxError,
  explicitChatWindow,
  validateWindow,
} from '../src/chat-policy.ts';
import searchCommand from 'imapflow/lib/commands/search.js';
import compiler from 'imapflow/lib/handler/imap-compiler.js';
import parser from 'imapflow/lib/handler/imap-parser.js';
import { formatMessageResponse } from 'imapflow/lib/tools.js';
import { demoSession } from '../src/demo.ts';
import { ModelAnalyzer } from '../src/analysis.ts';
import { localDay, type Saved, type Message } from '../src/domain.ts';
const step = (action: ChatStep['action'], rest: Partial<ChatStep> = {}): ChatStep => ({
  action,
  plan: null,
  search: { ...EMPTY_SEARCH },
  sources: [],
  text: '',
  ...rest,
});
const plan = {
  goal: 'locate' as const,
  after: '2026-09-01',
  before: '2026-09-30',
  dateOrigin: 'explicit' as const,
  evidence: ['matching message'],
  stopWhen: 'One matching original',
};
const query = { ...EMPTY_SEARCH, after: plan.after, before: plan.before };
const wait = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await Bun.sleep(2);
  expect(fn()).toBe(true);
};
function fixture(
  model: (input: any, signal: AbortSignal) => Promise<ChatStep>,
  mailbox?: any,
  scope = 'demo:INBOX',
) {
  let saved: Saved = { version: 1, cache: {}, session: demoSession() };
  const session = new ChatSession(() => [], model);
  saved.chats = { [scope]: { revision: 1, state: session.snapshot('draft', 3) } };
  let queue = Promise.resolve();
  let failing = false;
  const runner = new ChatRunner({
    saved: () => saved,
    scope: () => scope,
    transact: (work) => {
      const next = queue.then(work);
      queue = next.catch(() => {});
      return next;
    },
    commit: async (patch) => {
      if (failing) throw new Error('Disk full');
      // Match the encrypted store's JSON boundary, not just in-memory cloning.
      saved = JSON.parse(JSON.stringify({ ...saved, ...patch }));
    },
    model,
    mailbox: () => {
      if (!mailbox) throw new Error('No remote access');
      return mailbox;
    },
    changed() {},
  });
  const send = async (question = 'Find a message', retry = false) => {
    const run = await runner.start({
      turnID: crypto.randomUUID(),
      revision: saved.chats![scope].revision,
      question,
      retry,
    });
    await wait(() => !runner.busy);
    return runner.state();
  };
  return {
    runner,
    send,
    get saved() {
      return saved;
    },
    scope,
    fail: (value: boolean) => {
      failing = value;
    },
  };
}
function fakeIMAP() {
  const config = loadConfig(false, {});
  const calls: any[] = [];
  const client: any = {
    mailbox: { path: 'INBOX', uidValidity: 7n, uidNext: 1201 },
    on() {},
    connect: async () => {},
    close() {
      calls.push(['close']);
    },
    getMailboxLock: async (name: string, options: any) => {
      calls.push(['lock', name, options]);
      return { release() {} };
    },
    search: async (q: any, options: any) => {
      calls.push(['search', q, options]);
      return [1199, 1200];
    },
    fetchAll: async (uids: string, query: any, options: any) => {
      calls.push(['headers', uids, query, options]);
      return Promise.all(
        uids
          .split(',')
          .map(Number)
          .map(async (uid) =>
            formatMessageResponse(
              await parser(
                `* ${uid} FETCH (UID ${uid} MODSEQ (9007199254740993) X-GM-MSGID 17000000000000000001 X-GM-THRID 17000000000000000002 X-GM-LABELS ("Newsletters") FLAGS () INTERNALDATE "10-Sep-2026 00:00:00 +0000" ENVELOPE ("Thu, 10 Sep 2026 00:00:00 +0000" "Repair" (("Pat" NIL "pat" "example.invalid")) NIL NIL NIL NIL NIL NIL "<repair@example.invalid>"))`,
              ),
              client.mailbox,
            ),
          ),
      );
    },
    fetchOne: async (uid: string, q: any) => {
      calls.push(['fetch', uid, q]);
      return q.bodyStructure
        ? {
            uid: +uid,
            bodyStructure: {
              type: 'multipart/mixed',
              childNodes: [
                { part: '1', type: 'text/plain', size: 12, encoding: '7bit' },
                { part: '2', type: 'application/pdf', size: 10000000, disposition: 'attachment' },
              ],
            },
          }
        : { uid: +uid, bodyParts: new Map([['1', Buffer.from('Bike repair.')]]) };
    },
  };
  let options: any;
  const mail = new IMAPChatMailbox(config, (o) => {
    options = o;
    return client;
  });
  return {
    mail,
    client,
    calls,
    config,
    get options() {
      return options;
    },
  };
}
test('real FETCH parser BigInt counters and Gmail metadata stay outside persisted Chat messages', async () => {
  const f = fakeIMAP();
  const [row] = await f.client.fetchAll('1200', {}, {});
  expect(row.modseq).toBe(9007199254740993n);
  expect(row.emailId).toBe('17000000000000000001');
  expect(row.threadId).toBe('17000000000000000002');
  expect(row.labels).toEqual(new Set(['Newsletters']));
  expect(row.flags).toBeInstanceOf(Set);
  expect(row.internalDate).toBeInstanceOf(Date);
  expect(() => JSON.stringify(row)).toThrow(); // Reproduce the old size-check failure.
  const page = await f.mail.search(query, new AbortController().signal, async () => {});
  expect(page.messages[0]).toMatchObject({ uid: 1200, sender: 'Pat', validity: '7', read: false });
  expect(JSON.parse(JSON.stringify(page))).toEqual(page);
  expect(JSON.parse(JSON.stringify(f.mail.snapshot()))).toEqual(f.mail.snapshot());
  expect(JSON.stringify(page)).not.toContain('modseq');
  expect(JSON.stringify(page)).not.toContain('17000000000000000001');
});

test('metadata size limits count Set-backed flags and Gmail labels, and reject excessive rows', async () => {
  for (const field of ['labels', 'flags', 'subject', 'rows']) {
    const f = fakeIMAP();
    const fetch = f.client.fetchAll;
    f.client.fetchAll = async (...args: any[]) => {
      const rows = await fetch(...args);
      if (field === 'rows') return [...rows, ...rows];
      if (field === 'subject') rows[0].envelope.subject = 'x'.repeat(1024 * 1024);
      else rows[0][field] = new Set(['x'.repeat(1024 * 1024)]);
      return rows;
    };
    await expect(
      f.mail.search(query, new AbortController().signal, async () => {}),
    ).rejects.toThrow('metadata response exceeded');
    expect(f.mail.snapshot().pages).toEqual({});
  }
});

test('IMAP Chat uses frozen UID windows, read-only headers and issued cursors, never snapshot/full search', async () => {
  const f = fakeIMAP(),
    costs: any[] = [];
  const page = await f.mail.search(query, new AbortController().signal, async (cost) => {
    costs.push(cost);
  });
  expect(f.calls.find((c) => c[0] === 'search')[1]).toMatchObject({
    uid: '701:1200',
    since: '2026-09-01',
    before: '2026-10-01',
  });
  expect(f.calls.filter((c) => c[0] === 'lock').every((c) => c[2].readOnly)).toBe(true);
  expect(f.calls.find((c) => c[0] === 'headers')[2].source).toBeUndefined();
  expect(page.complete).toBe(false);
  expect(page.countQuality).toBe('lower-bound');
  expect(page.messages.every((m) => !m.body && !m.complete)).toBe(true);
  expect(costs).toEqual([{ searches: 1 }, { headers: 2 }]);
  await expect(
    f.mail.search({ ...query, offset: 99 }, new AbortController().signal, async () => {}),
  ).rejects.toThrow('nextOffset');
  await expect(
    f.mail.search({ ...query, after: '2020-01-01' }, new AbortController().signal, async () => {}),
  ).rejects.toThrow('90 days');
  await expect(
    f.mail.search({ ...query, category: 'act' }, new AbortController().signal, async () => {}),
  ).rejects.toThrow('categories');
  expect(f.options.maxLiteralSize).toBe(262144);
  f.mail.close();
});
test('Chat fetches a bounded text MIME part, never attachments or read flags, and checks UIDVALIDITY', async () => {
  const f = fakeIMAP(),
    signal = new AbortController().signal,
    costs: any[] = [];
  const page = await f.mail.search(query, signal, async () => {});
  const m = await f.mail.read(page.messages[0], signal, async (cost) => {
    costs.push(cost);
  });
  expect(m.body).toBe('Bike repair.');
  expect(costs).toEqual([{ bodies: 1, bytes: 12 }]);
  expect(f.calls.filter((c) => c[0] === 'fetch')[1][2]).toMatchObject({
    bodyParts: [{ key: '1', start: 0, maxLength: 12 }],
  });
  f.client.mailbox.uidValidity = 8n;
  await expect(f.mail.read(page.messages[1], signal, async () => {})).rejects.toThrow('identity');
  expect(f.calls.filter((c) => c[0] === 'fetch')).toHaveLength(2);
});
test('invalid server UID responses fail without fetching substitute messages', async () => {
  const f = fakeIMAP();
  f.client.search = async () => [2000];
  await expect(f.mail.search(query, new AbortController().signal, async () => {})).rejects.toThrow(
    'invalid bounded',
  );
  expect(f.calls.some((c) => c[0] === 'headers')).toBe(false);
});
test('worker reserves calls before dispatch, shares cumulative ledger and keeps detached results', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    expect(f.saved.chats![f.scope].ledger!.usage.calls).toBe(calls);
    return step('clarify', { text: 'Which sender?' });
  });
  await f.send();
  await f.send('Continue');
  expect(f.saved.chats![f.scope].ledger!.usage.calls).toBe(2);
  expect(f.saved.chatCharges!.reduce((sum, c) => sum + c.usage.calls, 0)).toBe(2);
  const current = f.saved.chats![f.scope];
  expect(current.state.pendingQuestion).toBeNull();
  const same = await f.runner.start({
    turnID: current.lastTurnID!,
    revision: 0,
    question: 'Find a message',
    retry: false,
  });
  expect(same.busy).toBe(false);
  expect(calls).toBe(2);
});
test('one account turn at a time, cancellation keeps charges and retry uses same ledger', async () => {
  let signal!: AbortSignal;
  const f = fixture(async (_input, s) => {
    signal = s;
    await new Promise((_, reject) =>
      s.addEventListener('abort', () => reject(s.reason), { once: true }),
    );
    return step('clarify');
  });
  const run = await f.runner.start({
    turnID: crypto.randomUUID(),
    revision: 1,
    question: 'Find a message',
    retry: false,
  });
  await wait(() => !!signal);
  await expect(
    f.runner.start({
      turnID: crypto.randomUUID(),
      revision: f.saved.chats![f.scope].revision,
      question: 'Another',
      retry: false,
    }),
  ).rejects.toThrow('already running');
  f.runner.cancel(run.turnID);
  await wait(() => !f.runner.busy);
  expect(f.saved.chats![f.scope].ledger!.usage.calls).toBe(1);
  expect(f.runner.state().stored?.state.error).toContain('Cancelled');
  expect(f.saved.chats![f.scope].state.retryText).toBe('Find a message');
});
test('no model request when durable reservation fails; hourly backstop survives a new conversation', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return step('clarify', { text: 'Hello' });
  });
  f.fail(true);
  await expect(f.send()).rejects.toThrow('Disk full');
  expect(calls).toBe(0);
  f.fail(false);
  f.saved.chatCharges = [{ at: Date.now(), usage: { ...emptyUsage(), calls: LIMITS.hour.calls } }];
  await f.send();
  expect(calls).toBe(0);
  expect(f.runner.state().stored?.state.error).toContain('Hourly Chat');
});
test('saved evidence does not open a mailbox unnecessarily; failed analysis is excluded from findings', async () => {
  let remote = 0,
    calls = 0;
  const f = fixture(
    async () =>
      calls++ === 0 ? step('scope') : step('answer', { text: 'These saved emails are available.' }),
    {
      search: async () => {
        remote++;
      },
      close() {},
    },
  );
  await f.send();
  expect(remote).toBe(0);
  const m = f.saved.session!.messages[0];
  m.error = 'failed';
  expect(chatCorpus(f.saved).some((r) => r.id === m.id)).toBe(true);
  expect(savedFindings(m, true)).toMatchObject({ evidenceType: 'metadata_only', summary: '' });
});
test('legacy saved-only chats can search missing dates automatically and preserve review data', async () => {
  const m: Message = {
    ...demoSession().messages[0],
    id: 'demo:INBOX:1:999',
    uid: 999,
    body: '',
    analysis: undefined,
    classification: undefined,
    complete: false,
  };
  let calls = 0,
    reads = 0;
  const f = fixture(
    async (input) => {
      const context = JSON.parse(input.context);
      expect(context.scope).toContain('automatic bounded read-only access');
      if (calls === 1) expect(context.tools.at(-1)).toMatchObject({ tool: 'scope', total: 0 });
      return [
        step('scope', { plan, search: query }),
        step('mailbox_search', { plan, search: query }),
        step('read', { sources: [1] }),
        step('answer', { text: 'The repair shop contact is Pat [1].', sources: [1] }),
      ][calls++];
    },
    {
      search: async (q: any, _s: any, reserve: any) => {
        await reserve({ searches: 1, headers: 1 });
        return {
          messages: [m],
          nextOffset: null,
          complete: true,
          countQuality: 'exact',
          matched: 1,
          scope: q,
          at: new Date().toISOString(),
          omissions: [],
        };
      },
      read: async (_m: any, _s: any, reserve: any) => {
        reads++;
        await reserve({ bodies: 1, bytes: 40 });
        return { ...m, body: 'Pat can repair the bicycle.', complete: true };
      },
      close() {},
    },
  );
  f.saved.chats![f.scope].state.access = 'saved'; // Previous default must not block retrieval.
  const count = f.saved.session!.messages.length;
  await f.send('Find the repair contact in September 2026');
  expect(reads).toBe(1);
  expect(f.saved.chats![f.scope].state.access).toBe('connected');
  expect(f.saved.session!.messages).toHaveLength(count);
  expect(f.saved.library?.[m.id]).toBeUndefined();
  expect(f.saved.chatMail?.[m.id].message.body).toContain('Pat');
  expect(f.saved.chats![f.scope].state.entries.at(-1)?.coverage).toContain('1 originals');
});
test('explicit rolling periods resolve deterministically without expanding the 90-day guard', () => {
  expect(explicitChatWindow('Check the last two months of my subscriptions', '2026-10-17')).toEqual(
    { after: '2026-08-17', before: '2026-10-17' },
  );
  expect(explicitChatWindow('Summarize the past 30 days', '2026-03-01')).toEqual({
    after: '2026-01-30',
    before: '2026-03-01',
  });
  expect(explicitChatWindow('Past two weeks', '2026-01-05')).toEqual({
    after: '2025-12-22',
    before: '2026-01-05',
  });
  expect(explicitChatWindow('Last 1 month', '2024-03-31')).toEqual({
    after: '2024-02-29',
    before: '2024-03-31',
  });
  expect(explicitChatWindow('Last 1 month', '2025-03-31')).toEqual({
    after: '2025-02-28',
    before: '2025-03-31',
  });
  for (const question of [
    'All my newsletters',
    'Last month',
    'Last two months versus past four weeks',
    'Last 0 days',
    'Last 999 months',
    'Last two months ending in September',
    'Last two months of 2025',
  ])
    expect(explicitChatWindow(question, '2026-10-17')).toBeUndefined();
  const wide = explicitChatWindow('Last three months', '2026-10-17')!;
  expect(() => validateWindow(wide.after, wide.before)).toThrow('at most 90 days');
});

test('last two months reaches IMAP and cited original synthesis even when the model labels dates inferred', async () => {
  const imap = fakeIMAP();
  const question =
    'Can you check the last two months of my subscriptions and give me the most important insights from them?';
  const window = explicitChatWindow(question, localDay())!;
  const search = { ...query, ...window, kind: 'newsletter' as const };
  let calls = 0;
  const f = fixture(
    async (input) => {
      const context = JSON.parse(input.context);
      expect(context.requestedWindow).toEqual(window);
      const n = calls++;
      if (n === 0)
        return step('scope', {
          plan: { ...plan, ...window, goal: 'synthesize', dateOrigin: 'inferred' },
          search,
        });
      expect(context.plan.dateOrigin).toBe('explicit');
      if (n === 1) {
        expect(context.tools.at(-1).total).toBe(0);
        return step('mailbox_search', { search });
      }
      if (n === 2) return step('read', { sources: [1, 2] });
      expect(
        context.evidence[0].results.every((r: any) => r.passages[0].text.includes('Bike repair.')),
      ).toBe(true);
      return step('answer', {
        text: 'These two issues discuss bicycle repair [1][2]. Other issues remain unreviewed.',
        sources: [1, 2],
      });
    },
    imap.mail,
    `${accountID(imap.config)}:${imap.config.mailbox}`,
  );
  await f.send(question);
  const state = f.runner.state().stored!.state;
  expect(state.error).toBe('');
  expect(calls).toBe(4);
  expect(state.entries.at(-1)?.sources).toEqual([1, 2]);
  expect(state.entries.at(-1)?.coverage).toContain('2 originals');
  expect(state.details?.usage).toMatchObject({ searches: 1, headers: 2, bodies: 2 });
  expect(imap.calls.filter((c) => c[0] === 'search')).toHaveLength(1);
  expect(imap.calls.find((c) => c[0] === 'search')[1]).toMatchObject({
    since: window.after,
    header: { 'List-ID': '<' },
  });
  expect(imap.calls.filter((c) => c[0] === 'lock').every((c) => c[2].readOnly)).toBe(true);
});

test('a relative period does not authorize mismatching model dates', async () => {
  let remote = 0,
    calls = 0;
  const f = fixture(
    async () =>
      calls++ === 0
        ? step('mailbox_search', {
            plan: {
              ...plan,
              after: '2000-01-01',
              before: '2000-02-01',
              goal: 'synthesize',
              dateOrigin: 'inferred',
            },
            search: { ...query, after: '2000-01-01', before: '2000-02-01' },
          })
        : step('clarify', { text: 'I need to correct the date range.' }),
    {
      search: async () => {
        remote++;
      },
      close() {},
    },
  );
  await f.send('Summarize the last two months of newsletters');
  expect(remote).toBe(0);
  expect(f.runner.state().stored?.state.details?.plan?.dateOrigin).toBe('inferred');
});

test('correcting a rejected date plan can execute the same search filters', async () => {
  const imap = fakeIMAP();
  let calls = 0;
  const f = fixture(
    async () => {
      const n = calls++;
      if (n < 2)
        return step('mailbox_search', {
          plan: { ...plan, goal: 'synthesize', dateOrigin: n === 0 ? 'inferred' : 'explicit' },
          search: query,
        });
      if (n === 2) return step('read', { sources: [1] });
      return step('answer', { text: 'This issue discusses bike repair [1].', sources: [1] });
    },
    imap.mail,
    `${accountID(imap.config)}:${imap.config.mailbox}`,
  );
  await f.send('Summarize my newsletters for September 2026');
  const state = f.runner.state().stored!.state;
  expect(state.error).toBe('');
  expect(state.details?.operations[0].result).toContain('correct dateOrigin');
  expect(state.details?.operations.some((op) => op.result.includes('Identical request'))).toBe(
    false,
  );
  expect(imap.calls.filter((c) => c[0] === 'search')).toHaveLength(1);
  expect(state.entries.at(-1)?.coverage).toContain('1 originals');
  expect(calls).toBe(4);
});

test('broad inferred synthesis asks for dates without remote work', async () => {
  let remote = 0,
    calls = 0;
  const f = fixture(
    async () =>
      calls++ === 0
        ? step('mailbox_search', {
            plan: { ...plan, goal: 'synthesize', dateOrigin: 'inferred' },
            search: query,
          })
        : step('clarify', { text: 'Which period should I summarize?' }),
    {
      search: async () => {
        remote++;
      },
      close() {},
    },
  );
  await f.send('Summarize all my newsletters');
  expect(remote).toBe(0);
  expect(f.saved.chats![f.scope].state.entries.at(-1)?.text).toContain('Which period');
});
test('Ollama and hosted Chat use schema JSON without native tools or hidden retries', async () => {
  for (const provider of ['ollama', 'openai'] as const) {
    const config = loadConfig(false, { LLM_PROVIDER: provider });
    let generations = 0;
    const request = Object.assign(
      async (url: any, init: any) => {
        if (String(url).endsWith('/api/show'))
          return new Response(JSON.stringify({ capabilities: [] }));
        generations++;
        const body = JSON.parse(init.body);
        expect(body.tools).toBeUndefined();
        expect(
          provider === 'ollama'
            ? body.format.properties.action.enum
            : body.text.format.schema.properties.action.enum,
        ).toContain('mailbox_search');
        return new Response('{}', { status: 503 });
      },
      { preconnect() {} },
    ) as typeof fetch;
    await expect(
      new ModelAnalyzer(config, request).chatStep({ context: '{}' }, new AbortController().signal),
    ).rejects.toThrow('503');
    expect(generations).toBe(1);
  }
});

test('bounded mailbox pages survive reconnect without another search or header charge', async () => {
  const f = fakeIMAP(),
    signal = new AbortController().signal;
  const first = await f.mail.search(query, signal, async () => {});
  const restored = new IMAPChatMailbox(
    f.config,
    () => {
      throw new Error('Cached page must not connect');
    },
    JSON.parse(JSON.stringify(f.mail.snapshot())),
  );
  expect(
    await restored.search(query, signal, async () => {
      throw new Error('No new charge');
    }),
  ).toEqual(first);
  f.client.mailbox.uidNext = 9999;
  f.client.search = async (q: any) => {
    expect(q.uid).toBe('201:700');
    return [];
  };
  const next = new IMAPChatMailbox(f.config, () => f.client, f.mail.snapshot());
  const page = await next.search({ ...query, offset: first.nextOffset! }, signal, async () => {});
  expect(page.complete).toBe(false);
  expect(page.messages).toHaveLength(0);
  next.close();
  f.mail.close();
});
test('plain root MIME parts use the library lowercase body-part keys and decode transfer encoding', async () => {
  const f = fakeIMAP();
  const page = await f.mail.search(query, new AbortController().signal, async () => {});
  f.client.fetchOne = async (uid: string, q: any) =>
    q.bodyStructure
      ? { uid: +uid, bodyStructure: { type: 'text/plain', size: 16, encoding: 'base64' } }
      : { uid: +uid, bodyParts: new Map([['text', Buffer.from('QmlrZSByZXBhaXIu')]]) };
  expect(
    (await f.mail.read(page.messages[0], new AbortController().signal, async () => {})).body,
  ).toBe('Bike repair.');
  f.mail.close();
});
test('failed final save retains the answer and blocks another model request until recovery', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    f.fail(true);
    return step('clarify', { text: 'Which sender?' });
  });
  await f.send();
  expect(f.runner.state().unsaved).toBe(true);
  expect(f.runner.state().stored?.state.entries.at(-1)?.text).toBe('Which sender?');
  await expect(f.send('Another question')).rejects.toThrow('Save the previous');
  expect(calls).toBe(1);
  f.fail(false);
  f.runner.saved();
});

test('worker reserves the last conversation calls for finishing and charges the correction', async () => {
  let calls = 0,
    remote = 0;
  const f = fixture(
    async (input) => {
      const c = JSON.parse(input.context);
      if (calls++ === 0) {
        expect(c.answerRequired).toBe(false);
        return step('scope');
      }
      expect(c.answerRequired).toBe(true);
      expect(c.retrievalStepsRemaining).toBe(0);
      return calls === 2
        ? step('answer', { sources: [999], text: 'Unsupported [999].' })
        : step('answer', {
            text: 'Only the saved-mail scope was checked; no originals were read.',
          });
    },
    {
      search: async () => {
        remote++;
      },
      close() {},
    },
  );
  f.saved.chats![f.scope].ledger = {
    usage: { ...emptyUsage(), calls: LIMITS.conversation.calls - 3 },
    historyKnown: true,
  };
  await f.send();
  expect(calls).toBe(3);
  expect(remote).toBe(0);
  expect(f.runner.state().stored?.state.error).toBe('');
  expect(f.saved.chats![f.scope].ledger!.usage.calls).toBe(LIMITS.conversation.calls);
  expect(f.saved.chatCharges!.reduce((sum, c) => sum + c.usage.calls, 0)).toBe(3);
  await f.send('Continue');
  expect(calls).toBe(3);
  expect(f.runner.state().stored?.state.error).toContain('Conversation');
});

test('low remaining allowance stops before generation, survives retry, and preserves conversation', async () => {
  for (const scenario of [
    { usage: { calls: LIMITS.conversation.calls - 2 }, label: 'Conversation' },
    { usage: { input: LIMITS.conversation.input - 20000 }, label: 'Conversation' },
    { usage: { ms: LIMITS.conversation.ms - 20000 }, label: 'Conversation' },
    { hourly: { calls: LIMITS.hour.calls - 2 }, label: 'Hourly Chat' },
    { hourly: { input: LIMITS.hour.input - 20000 }, label: 'Hourly Chat' },
  ]) {
    let calls = 0,
      remote = 0;
    const f = fixture(
      async () => {
        calls++;
        return step('answer', { text: 'No evidence was retrieved.' });
      },
      {
        search: async () => {
          remote++;
        },
        close() {},
      },
    );
    const previous = [
      { role: 'user' as const, text: 'Earlier question', sources: [] },
      { role: 'assistant' as const, text: 'Earlier answer', sources: [] },
    ];
    f.saved.chats![f.scope].state.entries = structuredClone(previous);
    f.saved.chats![f.scope].ledger = {
      usage: { ...emptyUsage(), ...scenario.usage },
      historyKnown: true,
    };
    f.saved.chatCharges = scenario.hourly
      ? [{ at: Date.now(), usage: { ...emptyUsage(), ...scenario.hourly } }]
      : [];
    const originalUsage = structuredClone(f.saved.chats![f.scope].ledger!.usage);
    const hourlyCalls = scenario.hourly?.calls ?? 0;
    for (const retry of [false, true]) {
      await f.send('Summarize the last two months of newsletters', retry);
      const state = f.runner.state().stored!.state;
      expect(state.error).toContain(scenario.label);
      expect(state.error).toContain('too low to search');
      expect(state.error).not.toContain('citation');
      expect(state.error).toContain(scenario.hourly ? 'Starts renewing at' : 'F2 More → New chat');
      expect(state.details?.stop).toBe('budget_reached');
      expect(state.details?.operations.at(-1)?.tool).toBe('limit');
      expect(state.details?.usage.calls).toBe(0);
      expect(state.entries.slice(0, 2)).toEqual(previous);
      expect(state.entries).toHaveLength(3);
      expect(state.retryText).toBe('Summarize the last two months of newsletters');
      expect(f.saved.chats![f.scope].ledger!.usage.calls).toBe(originalUsage.calls);
      expect(f.saved.chats![f.scope].ledger!.usage.input).toBe(originalUsage.input);
      expect(f.saved.chatCharges!.reduce((n, c) => n + c.usage.calls, 0)).toBe(hourlyCalls);
    }
    expect(calls).toBe(0);
    expect(remote).toBe(0);
  }
});

test('a retrieval limit before evidence stops with its cause, without paying for citation repairs', async () => {
  let calls = 0;
  const f = fixture(
    async () => {
      calls++;
      return step('mailbox_search', { plan, search: query });
    },
    {
      search: async (_q: any, _signal: any, reserve: any) => {
        await reserve({ searches: LIMITS.turn.searches + 1 });
        throw new Error('Must not fetch after rejected reservation');
      },
      close() {},
    },
  );
  await f.send();
  const state = f.runner.state().stored!.state;
  expect(calls).toBe(1);
  expect(state.error).toContain('This reply limit reached (searches)');
  expect(state.details?.stop).toBe('budget_reached');
  expect(state.details?.operations.some((op) => op.tool === 'answer_validation')).toBe(false);
  expect(state.details?.usage.searches).toBe(0);
  expect(state.entries.map((e) => e.role)).toEqual(['user']);
});

test('newsletter search avoids Gmail empty-header SERVERBUG through the real IMAP compiler', async () => {
  const f = fakeIMAP();
  const wire: string[] = [];
  const connection: any = {
    states: { SELECTED: 3 },
    state: 3,
    mailbox: f.client.mailbox,
    capabilities: new Map(),
    enabled: new Set(),
    log: { warn: (entry: any) => f.options.logger.warn(entry) },
    exec: async (command: string, attributes: any[], options: any) => {
      const commandText = compiler({ tag: 'A1', command, attributes }).toString();
      wire.push(commandText);
      if (commandText.includes('HEADER LIST-ID ""'))
        throw Object.assign(new Error('Fictional server error'), {
          serverResponseCode: 'SERVERBUG',
        });
      await options.untagged.SEARCH({ attributes: [{ value: '1199' }, { value: '1200' }] });
      return { next() {} };
    },
  };
  f.client.search = (q: any, options: any) => searchCommand(connection, q, options);
  const page = await f.mail.search(
    { ...query, kind: 'newsletter' },
    new AbortController().signal,
    async () => {},
  );
  expect(wire[0]).toContain('UID SEARCH UID 701:1200');
  expect(wire[0]).toContain('HEADER LIST-ID <');
  expect(wire[0]).not.toContain('HEADER LIST-ID ""');
  expect(page.messages).toHaveLength(2);
  // Prove the old query hits the dependency's false-return path, not an empty result.
  const old = await f.client.search(
    { uid: '701:1200', header: { 'List-ID': true } },
    { uid: true },
  );
  expect(old).toBe(false);
  f.mail.close();
});

test('false IMAP search results preserve safe error codes, and repeat attempts preserve the root cause', async () => {
  const f = fakeIMAP();
  let searches = 0;
  f.client.search = async () => {
    searches++;
    f.options.logger.warn({
      err: {
        serverResponseCode: 'SERVERBUG',
        message: 'private email contents',
        response: 'private response',
        command: 'private search',
      },
    });
    return false;
  };
  const signal = new AbortController().signal;
  for (let i = 0; i < 2; i++) {
    await expect(f.mail.search(query, signal, async () => {})).rejects.toThrow('IMAP SERVERBUG');
  }
  expect(searches).toBe(1);
  try {
    await f.mail.search(query, signal, async () => {});
  } catch (error) {
    expect(String(error)).not.toContain('private');
    expect(String(error)).not.toContain('invalid bounded');
  }
  expect(f.calls.some((c) => c[0] === 'headers')).toBe(false);
  expect(f.mail.snapshot().pages).toEqual({});
  const empty = fakeIMAP();
  empty.client.search = async () => [];
  const page = await empty.mail.search(query, signal, async () => {});
  expect(page.messages).toHaveLength(0);
  expect(page.nextOffset).not.toBeNull();
  expect(page.complete).toBe(false);
  empty.mail.close();
});

test('mailbox failure with no evidence stops immediately without extra model calls or citation errors', async () => {
  let calls = 0,
    searches = 0;
  const f = fixture(
    async () => {
      calls++;
      return step('mailbox_search', { plan, search: query });
    },
    {
      async search() {
        searches++;
        throw new ChatMailboxError('Mailbox search failed (IMAP SERVERBUG).');
      },
      close() {},
    },
  );
  await f.send('Summarize September newsletters');
  expect(calls).toBe(1);
  expect(searches).toBe(1);
  const state = f.runner.state().stored!.state;
  expect(state.error).toBe('Mailbox search failed (IMAP SERVERBUG).');
  expect(state.details?.stop).toBe('mailbox_failure');
  expect(state.details?.operations.at(-1)?.result).toContain('SERVERBUG');
  expect(state.error).not.toContain('citation');
  expect(state.entries.filter((e) => e.role === 'assistant')).toHaveLength(0);
});

test('mailbox failure can finish from saved evidence, and never disappears behind a citation failure', async () => {
  for (const valid of [true, false]) {
    let calls = 0,
      searches = 0;
    const f = fixture(
      async (input) => {
        const turn = calls++;
        if (turn === 0) return step('findings', { search: { ...EMPTY_SEARCH, limit: 1 } });
        if (turn === 1) return step('mailbox_search', { plan, search: query });
        const c = JSON.parse(input.context);
        expect(c.answerRequired).toBe(true);
        expect(c.mailboxFailure).toContain('SERVERBUG');
        return step('answer', {
          text: valid ? 'Saved findings only; inbox search failed [1].' : 'Unverified [99].',
          sources: [valid ? 1 : 99],
        });
      },
      {
        async search() {
          searches++;
          throw new ChatMailboxError('Mailbox search failed (IMAP SERVERBUG).');
        },
        close() {},
      },
    );
    await f.send();
    expect(searches).toBe(1);
    const state = f.runner.state().stored!.state;
    if (valid) {
      expect(calls).toBe(3);
      expect(state.error).toBe('');
      expect(state.entries.at(-1)?.coverage).toContain('Partial coverage');
      expect(state.entries.at(-1)?.coverage).toContain('Inbox search failed');
      expect(state.details?.stop).toBe('mailbox_failure');
    } else {
      expect(calls).toBe(4);
      expect(state.error).toContain('SERVERBUG');
      expect(state.details?.stop).toBe('mailbox_failure');
      expect(state.entries.at(-1)?.text).toContain('Collected evidence');
    }
  }
});
