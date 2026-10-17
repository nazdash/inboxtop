import { test, expect } from 'bun:test';
import {
  chatCorpus,
  ChatSession,
  searchChat,
  EMPTY_SEARCH,
  requestsReadAction,
  type ChatStep,
  type ChatInput,
} from '../src/chat.ts';
import { demoSession, DemoMailbox, DemoAnalyzer } from '../src/demo.ts';
import { ModelAnalyzer } from '../src/analysis.ts';
import { loadConfig } from '../src/config.ts';
import { Controller } from '../src/controller.ts';
import { MemoryStore, EncryptedStore } from '../src/store.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Saved } from '../src/domain.ts';
const step = (action: ChatStep['action'], options: Partial<ChatStep> = {}): ChatStep => ({
  action,
  plan: null,
  search: { ...EMPTY_SEARCH },
  sources: [],
  text: '',
  ...options,
});
const saved = (): Saved => ({ version: 1, cache: {}, session: demoSession() });

test('Chat corpus includes retained read mail, includes unanalyzed originals but excludes other accounts', () => {
  const data = saved();
  data.session!.messages[0].read = true;
  data.session!.messages[1].present = false;
  data.session!.messages[2].error = 'failed';
  delete data.session!.messages[3].analysis;
  const alien = { ...data.session!.messages[0], id: 'someone:INBOX:1:100' };
  data.library = { [alien.id]: alien };
  const corpus = chatCorpus(data);
  expect(corpus.map((m) => m.id)).toContain(data.session!.messages[0].id);
  expect(corpus.map((m) => m.id)).toContain(data.session!.messages[1].id);
  expect(corpus.some((m) => m.id === alien.id)).toBe(false);
  expect(corpus).toHaveLength(data.session!.messages.length);
});

test('deterministic search applies sender, date, state and OR terms without regex execution', () => {
  const rows = chatCorpus(saved());
  rows[0].read = true;
  expect(searchChat(rows, { ...EMPTY_SEARCH, state: 'read' }).messages.map((m) => m.id)).toEqual([
    rows[0].id,
  ]);
  expect(searchChat(rows, { ...EMPTY_SEARCH, terms: ['Sarah', 'Invoice'] }).total).toBe(2);
  expect(
    searchChat(rows, {
      ...EMPTY_SEARCH,
      sender: 'SARAH',
      after: '2000-01-01',
      before: '2099-12-31',
    }).messages[0].id,
  ).toBe(rows[0].id);
  expect(searchChat(rows, { ...EMPTY_SEARCH, terms: ['.*'] }).total).toBe(0);
  expect(() => searchChat(rows, { ...EMPTY_SEARCH, after: 'yesterday' })).toThrow();
  expect(searchChat(rows, EMPTY_SEARCH).total).toBe(14);
  expect(searchChat(rows, EMPTY_SEARCH).messages).toHaveLength(10);
});

test('conversation retrieves evidence each turn and stable references survive read-state changes', async () => {
  const data = saved();
  const inputs: any[] = [];
  const steps = [
    step('search', { search: { ...EMPTY_SEARCH, terms: ['Sarah'] } }),
    step('answer', { text: 'Sarah needs a decision [1].', sources: [1] }),
    step('read', { sources: [1] }),
    step('answer', { text: 'The saved request asks for approval [1].', sources: [1] }),
  ];
  const chat = new ChatSession(
    () => chatCorpus(data),
    async (input) => {
      inputs.push(JSON.parse(input.context));
      return steps.shift()!;
    },
  );
  await chat.send('What needs a decision?');
  expect(chat.entries.at(-1)?.sources).toEqual([1]);
  data.session!.messages[0].read = true;
  data.session!.messages.reverse();
  await chat.send('Explain that one');
  expect(chat.sources).toHaveLength(1);
  expect(inputs[2].history.map((e: any) => e.text)).toContain('Sarah needs a decision [1].');
  expect(inputs[3].evidence[0].results[0].read).toBe(true);
  expect(chat.error).toBe('');
});

test('unsupported answers get one correction and fail with an accurate citation error', async () => {
  let calls = 0;
  const chat = new ChatSession(
    () => chatCorpus(saved()),
    async () => {
      calls++;
      return step('answer', { text: 'You owe money [99].', sources: [99] });
    },
  );
  await chat.send('Do I owe money?');
  expect(calls).toBe(2);
  expect(chat.entries.filter((e) => e.role === 'assistant')).toHaveLength(0);
  expect(chat.error).toContain('evidence/citation');
  expect(chat.details.stop).toBe('answer_validation_failed');
  expect(chat.retryText).toBe('Do I owe money?');
});

test('mark-read proposals require a user request, freeze known IDs and never execute via model', async () => {
  const data = saved();
  let next = step('search', { search: { ...EMPTY_SEARCH, terms: ['Sarah'] } });
  const chat = new ChatSession(
    () => chatCorpus(data),
    async () => {
      const result = next;
      next = step('mark_read', { sources: [1] });
      return result;
    },
  );
  await chat.send('Find Sarah');
  expect(chat.proposal).toBeUndefined(); // Even repeated injected tool requests cannot propose a write.
  expect(chatCorpus(data).every((m) => !m.read)).toBe(true);
  await chat.send('Mark that email read');
  expect(chat.proposal?.sources.map((s) => s.id)).toEqual(['demo:INBOX:1:100']);
  expect(chat.proposal?.status).toBe('pending');
  data.session!.messages.push({ ...data.session!.messages[0], id: 'demo:INBOX:1:999', uid: 999 });
  expect(chat.proposal?.sources).toHaveLength(1);
  chat.cancelProposal();
  expect(chat.proposal?.status).toBe('cancelled');
  expect(chat.entries.at(-1)?.text).toContain('No emails changed');
  expect(requestsReadAction('Do not mark it read')).toBe(false);
  expect(requestsReadAction('Mark it unread')).toBe(false);
  expect(requestsReadAction('Отметь эти письма прочитанными')).toBe(true);
});

test('cancel aborts the model and retry preserves one user turn without replaying actions', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const chat = new ChatSession(
    () => [],
    async (_input, signal) => {
      calls++;
      if (calls === 1) {
        started();
        await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      return step('clarify', { text: 'Which sender?' });
    },
  );
  const running = chat.send('Find a message');
  await ready;
  chat.cancel();
  await running;
  expect(chat.busy).toBe(false);
  expect(chat.error).toContain('Cancelled');
  await chat.send(chat.retryText!, true);
  expect(chat.entries.filter((e) => e.role === 'user')).toHaveLength(1);
  expect(chat.entries.at(-1)?.text).toBe('Which sender?');
});

test('provider chat uses the configured detailed model, language and bounded structured output', async () => {
  for (const provider of ['openai', 'ollama'] as const) {
    const config = loadConfig(false, {
      LLM_PROVIDER: provider,
      ANALYSIS_LANGUAGE: 'ru',
      OPENAI_MODEL: 'test-api-model',
      OLLAMA_MODEL: 'test-local-model',
    });
    const bodies: any[] = [];
    const response = step('clarify', { text: 'Какого отправителя?' });
    const request = Object.assign(
      async (url: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify(
            String(url).endsWith('/api/show')
              ? { capabilities: [] }
              : provider === 'openai'
                ? {
                    status: 'completed',
                    output: [
                      {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: JSON.stringify(response) }],
                      },
                    ],
                  }
                : { message: { content: JSON.stringify(response) } },
          ),
        );
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    const analyzer = new ModelAnalyzer(config, request);
    expect(await analyzer.chatStep({ context: '{}' }, new AbortController().signal)).toEqual(
      response,
    );
    const body = bodies.at(-1);
    expect(body.model).toBe(config.model);
    expect(provider === 'openai' ? body.instructions : body.messages[0].content).toContain(
      'Russian',
    );
    if (provider === 'openai') expect(body.store).toBe(false);
  }
});

test('confirmed Chat writes revalidate eligibility and report verified, skipped and uncertain outcomes', async () => {
  const store = new MemoryStore();
  store.value = saved();
  const mail = new DemoMailbox();
  const c = new Controller(mail, new DemoAnalyzer(), store, 'demo', 'fictional');
  await c.init();
  try {
    const ids = c.messages.slice(0, 3).map((m) => m.id);
    const original = mail.setRead.bind(mail);
    mail.setRead = async (m, read, expected) => {
      if (m.id === ids[1]) return 'skipped';
      if (m.id === ids[2]) throw new Error('Uncertain write');
      return original(m, read, expected);
    };
    expect(await c.applyChat(ids)).toMatchObject({
      succeeded: 1,
      skipped: 1,
      unconfirmed: 1,
      outcomes: [
        { id: ids[0], status: 'succeeded' },
        { id: ids[1], status: 'skipped' },
        { id: ids[2], status: 'unknown' },
      ],
    });
    expect(chatCorpus(c.saved).some((m) => m.id === ids[0])).toBe(true);
    await expect(c.applyChat([ids[0]])).rejects.toThrow('changed');
    expect(c.session!.receipts).toHaveLength(3);
    await expect(c.applyChat(['other:INBOX:1:999'])).rejects.toThrow('changed');
  } finally {
    await c.close();
  }
});

test('saved Chat restores questions and proposals without automatically repeating work', async () => {
  const data = saved();
  const source = data.session!.messages[0];
  const original = new ChatSession(
    () => chatCorpus(data),
    async () => step('clarify', { text: 'Which sender?' }),
  );
  original.sources = [
    { ref: 1, id: source.id, sender: source.sender, subject: source.subject, date: source.date },
  ];
  original.entries = [{ role: 'user', text: 'Find a payment', sources: [] }];
  original.busy = true;
  const state = original.snapshot('unfinished draft', 4, 12);
  let calls = 0;
  const restored = new ChatSession(
    () => chatCorpus(data),
    async () => {
      calls++;
      return step('clarify', { text: 'Which sender?' });
    },
  );
  restored.restore(state);
  expect(calls).toBe(0);
  expect(restored.busy).toBe(false);
  expect(restored.retryText).toBe('Find a payment');
  await restored.send(restored.retryText!, true);
  expect(restored.entries.filter((e) => e.role === 'user')).toHaveLength(1);
  expect(calls).toBe(1);
  original.busy = false;
  original.proposal = { id: 'proposal', sources: original.sources, status: 'pending' };
  restored.restore(original.snapshot());
  expect(restored.proposal?.status).toBe('pending');
  expect(calls).toBe(1);
  original.proposal.status = 'applying';
  restored.restore(original.snapshot());
  expect(restored.proposal?.status).toBe('done');
  expect(restored.entries.at(-1)?.text).toContain('Check History');
  expect(restored.retryText).toBeUndefined();
  expect(calls).toBe(1);
});

test('Chat saves reject stale clients and wrong mailbox IDs, survive failures and merge with inbox writes', async () => {
  const store = new MemoryStore();
  store.value = saved();
  const c = new Controller(new DemoMailbox(), new DemoAnalyzer(), store, 'demo', 'fictional');
  await c.init();
  try {
    const chat = new ChatSession(
      () => chatCorpus(c.saved),
      async () => step('clarify', { text: 'Which sender?' }),
    );
    const state = chat.snapshot('a private draft');
    const save = store.save.bind(store);
    store.save = async () => {
      throw new Error('Disk full');
    };
    await expect(c.saveChat(c.chatScope, 0, state)).rejects.toThrow('Disk full');
    expect(c.saved.chats).toBeUndefined();
    store.save = save;
    const results = await Promise.allSettled([
      c.saveChat(c.chatScope, 0, state),
      c.saveChat(c.chatScope, 0, chat.snapshot('another terminal')),
      c.syncInbox(),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect((await c.loadChat())?.state.draft).toBe('a private draft');
    expect(store.value.chats?.[c.chatScope].state.draft).toBe('a private draft');
    expect(store.value.inbox).toBeDefined();
    await expect(c.saveChat('another:INBOX', 1, state)).rejects.toThrow('mailbox');
    await expect(
      c.saveChat(c.chatScope, 1, {
        ...state,
        sources: [{ ref: 1, id: 'another:INBOX:1:1', sender: '', subject: '', date: '' }],
      }),
    ).rejects.toThrow('another mailbox');
  } finally {
    await c.close();
  }
});

test('current Chat roundtrips through encrypted storage without plaintext or action replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inboxtop-chat-store-'));
  let store = await new EncryptedStore(directory).init();
  try {
    await store.save(saved());
    const c = new Controller(new DemoMailbox(), new DemoAnalyzer(), store, 'demo', 'fictional');
    await c.init();
    const chat = new ChatSession(
      () => chatCorpus(c.saved),
      async () => step('clarify', { text: 'Which sender?' }),
    );
    await chat.send('A private conversation question');
    const state = chat.snapshot('Unfinished private draft', 7, 3);
    await c.saveChat(c.chatScope, 0, state);
    await c.close();
    const ciphertext = await readFile(join(directory, 'session.enc'));
    expect(ciphertext.includes(Buffer.from('private conversation'))).toBe(false);
    expect(ciphertext.includes(Buffer.from('private draft'))).toBe(false);
    store = await new EncryptedStore(directory).init();
    const next = new Controller(new DemoMailbox(), new DemoAnalyzer(), store, 'demo', 'fictional');
    await next.init();
    expect(await next.loadChat()).toEqual({ revision: 1, state });
    await next.close();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('draft writes during worker replies merge without losing the answer or overwriting another draft', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const store = new MemoryStore();
  store.value = saved();
  const analyzer = new DemoAnalyzer();
  analyzer.chatStep = async () => {
    await gate;
    return step('clarify', { text: 'Which period?' });
  };
  const c = new Controller(new DemoMailbox(), analyzer, store, 'demo', 'fictional');
  await c.init();
  try {
    const state = new ChatSession(() => [], analyzer.chatStep).snapshot('question');
    const revision = await c.saveChat(c.chatScope, 0, state);
    const run = await c.startChat({
      turnID: crypto.randomUUID(),
      revision,
      question: 'question',
      retry: false,
    });
    expect(run.busy).toBe(true);
    await c.saveChatDraft(c.chatScope, '', 'next question draft', 5, 4);
    await expect(c.saveChatDraft(c.chatScope, '', 'stale terminal draft', 0, 0)).rejects.toThrow(
      'another terminal',
    );
    finish();
    for (let i = 0; i < 100 && (await c.chatRunState()).busy; i++) await Bun.sleep(2);
    const stored = await c.loadChat();
    expect(stored?.state.draft).toBe('next question draft');
    expect(stored?.state.entries.at(-1)?.text).toBe('Which period?');
    expect(stored?.ledger?.usage.calls).toBe(1);
  } finally {
    finish();
    await c.close();
  }
});
