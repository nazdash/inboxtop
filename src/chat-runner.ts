import {
  chatInputCharge,
  ChatSession,
  chatCorpus,
  type ChatInput,
  type ChatModel,
  type StoredChat,
} from './chat.ts';
import {
  ChatLimit,
  LIMITS,
  emptyUsage,
  addUsage,
  checkUsage,
  validateWindow,
  type Usage,
  type ChatPlan,
} from './chat-policy.ts';
import type { ChatMailbox } from './chat-mail.ts';
import type { Saved, Message } from './domain.ts';
import { analysisReady } from './decisions.ts';
export interface ChatRunState {
  turnID: string;
  busy: boolean;
  status: string;
  stored?: StoredChat;
  unsaved?: boolean;
}
export interface ChatRunRequest {
  turnID: string;
  revision: number;
  question: string;
  retry: boolean;
}
interface Owner {
  saved(): Saved;
  scope(): string;
  transact(work: () => Promise<void>): Promise<void>;
  commit(patch: Partial<Saved>): Promise<void>;
  model: ChatModel;
  mailbox(state?: import('./chat-mail.ts').ChatMailboxState): ChatMailbox;
  changed(): void;
}
/** All executable Chat state and accounting live here, in the account worker. */
export class ChatRunner {
  private active?: {
    turnID: string;
    session: ChatSession;
    done?: Promise<void>;
    running: boolean;
    unsaved?: boolean;
    abort: AbortController;
  };
  private starting = false;
  private last?: ChatRunState;
  constructor(private owner: Owner) {}
  get busy() {
    return this.starting || !!this.active?.running;
  }
  state(): ChatRunState {
    const stored = this.owner.saved().chats?.[this.owner.scope()];
    if (this.active)
      return {
        turnID: this.active.turnID,
        busy: this.busy,
        status: this.active.session.status,
        unsaved: this.active.unsaved,
        stored: {
          ...stored!,
          state: this.active.session.snapshot(
            stored?.state.draft,
            stored?.state.cursor,
            stored?.state.scrollTop,
          ),
        },
      };
    return this.last
      ? { ...this.last, stored }
      : { turnID: stored?.lastTurnID ?? '', busy: false, status: '', stored };
  }
  saved() {
    if (!this.busy) this.active = undefined;
  }
  cancel(turnID: string) {
    if (this.active?.turnID === turnID) this.active.abort.abort();
  }
  async close() {
    this.active?.abort.abort();
    await this.active?.done;
  }
  async start(request: ChatRunRequest): Promise<ChatRunState> {
    const owner = this.owner;
    if (
      this.active?.turnID === request.turnID ||
      owner.saved().chats?.[owner.scope()]?.lastTurnID === request.turnID
    )
      return this.state();
    if (this.active?.unsaved)
      throw new Error('Save the previous reply before starting another one.');
    if (this.busy)
      throw new Error('A Chat reply is already running for this account. Stop it or wait.');
    this.starting = true;
    let session!: ChatSession;
    let mail: ChatMailbox | undefined;
    const abort = new AbortController();
    let turnUsage = emptyUsage();
    const started = Date.now();
    let reservedMs = 0;
    let chargeAt = 0;
    const scope = owner.scope();
    const reserve = async (cost: Partial<Usage>) => {
      abort.signal.throwIfAborted();
      await owner.transact(async () => {
        const saved = owner.saved();
        const stored = saved.chats![scope];
        const ledger = stored.ledger!;
        const charges = (saved.chatCharges ?? []).filter((c) => c.at > Date.now() - 3600000);
        const hourly = charges.reduce((sum, c) => addUsage(sum, c.usage), emptyUsage());
        checkUsage(turnUsage, cost, LIMITS.turn, 'This reply');
        checkUsage(ledger.usage, cost, LIMITS.conversation, 'Conversation');
        try {
          checkUsage(hourly, cost, LIMITS.hour, 'Hourly Chat');
        } catch (error) {
          const expires = Math.min(...charges.map((c) => c.at)) + 3600000;
          throw new ChatLimit(
            `Hourly Chat limit reached. Allowance begins renewing at ${new Date(expires).toLocaleTimeString()}. Existing answers are kept.`,
          );
        }
        const usage = addUsage(ledger.usage, cost);
        const nextTurn = addUsage(turnUsage, cost);
        const own = charges.find((c) => c.at === chargeAt);
        const nextCharges = own
          ? charges.map((c) => (c === own ? { ...c, usage: addUsage(c.usage, cost) } : c))
          : [...charges, { at: chargeAt, usage: addUsage(emptyUsage(), cost) }];
        session.details.usage = nextTurn;
        const next = {
          ...stored,
          ledger: { ...ledger, usage },
          state: session.snapshot(stored.state.draft, stored.state.cursor, stored.state.scrollTop),
          revision: stored.revision + 1,
        };
        await owner.commit({ chats: { ...saved.chats, [scope]: next }, chatCharges: nextCharges });
        turnUsage = nextTurn;
      });
    };
    const checkpoint = async () =>
      owner.transact(async () => {
        const saved = owner.saved(),
          stored = saved.chats![scope];
        await owner.commit({
          chats: {
            ...saved.chats,
            [scope]: {
              ...stored,
              revision: stored.revision + 1,
              state: session.snapshot(
                stored.state.draft,
                stored.state.cursor,
                stored.state.scrollTop,
              ),
            },
          },
        });
      });
    const cache = async (m: Message) =>
      owner.transact(async () => {
        const saved = owner.saved();
        const records = { ...saved.chatMail, [m.id]: { message: m, at: Date.now() } };
        const pinned = new Set(session.sources.map((s) => s.id));
        pinned.add(m.id);
        const size = () => Buffer.byteLength(JSON.stringify(records));
        const evict = Object.values(records)
          .filter((r) => !pinned.has(r.message.id))
          .sort((a, b) => a.at - b.at);
        while ((Object.keys(records).length > 250 || size() > 32 * 1024 ** 2) && evict.length)
          delete records[evict.shift()!.message.id];
        if (Object.keys(records).length > 250 || size() > 32 * 1024 ** 2)
          throw new ChatLimit('Saved source cache is full. Cited originals were preserved.');
        await owner.commit({ chatMail: records });
      });
    const authorize = async (query: { after: string; before: string }, plan?: ChatPlan) => {
      validateWindow(query.after, query.before);
      if (!plan)
        throw new Error('Describe the goal and bounded date scope in plan before mailbox search.');
      validateWindow(plan.after, plan.before);
      if (plan.goal === 'synthesize' && plan.dateOrigin === 'inferred')
        throw new Error(
          'Synthesis needs a user-specified period. Relative dates such as last two months are explicit: correct dateOrigin and retry. Ask for dates only when the user supplied no period.',
        );
      if (query.after < plan.after || query.before > plan.before)
        throw new Error('Search must stay inside the stated plan dates.');
      await owner.transact(async () => {
        const saved = owner.saved(),
          stored = saved.chats![scope],
          ledger = stored.ledger!;
        if (
          ledger.window &&
          (query.after < ledger.window.after || query.before > ledger.window.before)
        ) {
          // A follow-up may name a different bounded period. Never infer expansion.
          if (plan.dateOrigin === 'inferred')
            throw new Error(
              'The requested window widens the previous scope. Ask for explicit dates.',
            );
        }
        await owner.commit({
          chats: {
            ...saved.chats,
            [scope]: {
              ...stored,
              ledger: { ...ledger, window: { after: plan.after, before: plan.before } },
            },
          },
        });
      });
    };
    try {
      await owner.transact(async () => {
        const saved = owner.saved(),
          stored = saved.chats?.[scope];
        if (!stored || stored.revision !== request.revision)
          throw new Error('Saved chat changed. Reload it before sending; your draft is kept.');
        if (stored.state.proposal && ['pending', 'applying'].includes(stored.state.proposal.status))
          throw new Error('Finish or cancel the pending mailbox proposal first.');
        const question = request.question.trim();
        if (!question || question.length > 2000)
          throw new Error('Use a question of 1–2,000 characters.');
        if (
          request.retry &&
          request.question !== (stored.state.retryText ?? stored.state.pendingQuestion)
        )
          throw new Error('Retry must use the interrupted question.');
        const ledger = stored.ledger ?? {
          usage: emptyUsage(),
          historyKnown: stored.state.entries.length === 0,
        };
        reservedMs = Math.min(LIMITS.turn.ms, LIMITS.conversation.ms - ledger.usage.ms);
        if (reservedMs <= 0)
          throw new ChatLimit('Conversation time limit reached. Existing answers are kept.');
        chargeAt = Date.now();
        session = new ChatSession(
          () => chatCorpus(owner.saved(), scope),
          owner.model,
          () => owner.changed(),
          {
            signal: abort.signal,
            checkpoint,
            beforeModel: async (input: ChatInput, final: boolean, evidenceAvailable: boolean) => {
              const usage = owner.saved().chats![scope].ledger!.usage;
              const charge = chatInputCharge(input.context);
              const charges = (owner.saved().chatCharges ?? []).filter(
                (c) => c.at > Date.now() - 3600000,
              );
              const hourly = charges.reduce((sum, c) => addUsage(sum, c.usage), emptyUsage());
              // Leave room for synthesis plus one correction, within the same hard caps.
              const hourlyLow =
                hourly.calls >= LIMITS.hour.calls - 2 ||
                hourly.input + charge * 3 > LIMITS.hour.input;
              const conversationLow =
                usage.calls >= LIMITS.conversation.calls - 2 ||
                usage.input + charge * 3 > LIMITS.conversation.input ||
                reservedMs <= 30000;
              const replyLow =
                turnUsage.input + charge * 3 > LIMITS.turn.input ||
                Date.now() - started >= reservedMs - 30000;
              const mustAnswer = final || hourlyLow || conversationLow || replyLow;
              // Finishing is useful only after a successful search (including an
              // empty result) or retrieved evidence. History alone is not evidence
              // for this reply. Stop locally before charging another model call.
              if (!evidenceAvailable && (hourlyLow || conversationLow || replyLow)) {
                if (hourlyLow) {
                  const expires = Math.min(...charges.map((c) => c.at)) + 3600000;
                  throw new ChatLimit(
                    `Hourly Chat allowance too low to search. Starts renewing at ${new Date(expires).toLocaleTimeString()}. New chat does not reset it.`,
                  );
                }
                throw new ChatLimit(
                  conversationLow
                    ? 'Conversation allowance too low to search. F2 More → New chat to continue.'
                    : 'Reply allowance reached before a search completed. F2 More → Retry reply.',
                );
              }
              if (mustAnswer)
                input.context = JSON.stringify({
                  ...JSON.parse(input.context),
                  answerRequired: true,
                  retrievalStepsRemaining: 0,
                });
              await reserve({ calls: 1, input: chatInputCharge(input.context) });
              return mustAnswer;
            },
            search: async (q, plan, signal) => {
              if (Date.now() - started >= reservedMs - 30000)
                throw new ChatLimit('Time reserved for a final answer; mailbox retrieval stopped.');
              await authorize(q, plan);
              mail ??= owner.mailbox(owner.saved().chats![scope].ledger!.mailboxState);
              const found = await mail.search(q, signal, reserve);
              const mailboxState = mail.snapshot?.();
              if (mailboxState)
                await owner.transact(async () => {
                  const saved = owner.saved(),
                    stored = saved.chats![scope];
                  await owner.commit({
                    chats: {
                      ...saved.chats,
                      [scope]: { ...stored, ledger: { ...stored.ledger!, mailboxState } },
                    },
                  });
                });
              for (const m of found.messages)
                if (!chatCorpus(owner.saved(), scope).some((row) => row.id === m.id))
                  await cache(m);
              return found;
            },
            read: async (m, signal) => {
              if (Date.now() - started >= reservedMs - 30000)
                throw new ChatLimit('Time reserved for a final answer; mailbox retrieval stopped.');
              const cached = chatCorpus(owner.saved(), scope).find((row) => row.id === m.id);
              if (cached?.body) {
                if (owner.saved().chatMail?.[m.id]) await cache(cached);
                return cached;
              }
              const pinned = new Set(session.sources.map((s) => s.id));
              const pinnedBytes = Object.values(owner.saved().chatMail ?? {})
                .filter((r) => pinned.has(r.message.id) && r.message.id !== m.id)
                .reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)), 0);
              if (pinnedBytes + 250000 > 32 * 1024 ** 2)
                throw new ChatLimit(
                  'Saved source cache is full. Cited originals were preserved; no body fetched.',
                );
              mail ??= owner.mailbox(owner.saved().chats![scope].ledger!.mailboxState);
              const original = await mail.read(m, signal, async (cost) => {
                const previous = owner.saved().chats![scope].ledger!.bodyBytes?.[m.id] ?? 0;
                if (previous + (cost.bytes ?? 0) > 262144)
                  throw new ChatLimit(
                    'Original byte allowance reached for this source. No automatic refetch.',
                  );
                await reserve(cost);
                await owner.transact(async () => {
                  const saved = owner.saved(),
                    stored = saved.chats![scope],
                    ledger = stored.ledger!;
                  await owner.commit({
                    chats: {
                      ...saved.chats,
                      [scope]: {
                        ...stored,
                        ledger: {
                          ...ledger,
                          bodyBytes: { ...ledger.bodyBytes, [m.id]: previous + (cost.bytes ?? 0) },
                        },
                      },
                    },
                  });
                });
              });
              await cache(original);
              return original;
            },
            canMark: (m) =>
              (analysisReady(m) && !!owner.saved().library?.[m.id]) ||
              !!owner
                .saved()
                .session?.messages.some((row) => row.id === m.id && analysisReady(row)),
          },
        );
        session.restore(stored.state);
        const next = {
          ...stored,
          state: {
            ...stored.state,
            draft: request.retry ? stored.state.draft : '',
            cursor: request.retry ? stored.state.cursor : 0,
          },
          lastTurnID: request.turnID,
          ledger,
          revision: stored.revision + 1,
        };
        await owner.commit({ chats: { ...saved.chats, [scope]: next } });
      });
      // Charge the full reserved time up front; a crash cannot reset the clock.
      this.active = { turnID: request.turnID, session, running: true, abort };
      await reserve({ ms: reservedMs });
      const timer = setTimeout(
        () => abort.abort(new Error('Chat time limit reached.')),
        reservedMs,
      );
      this.starting = false;
      const done = session.send(request.question, request.retry).finally(async () => {
        clearTimeout(timer);
        mail?.close();
        try {
          await owner.transact(async () => {
            const saved = owner.saved(),
              stored = saved.chats![scope];
            const unused = Math.max(0, reservedMs - (Date.now() - started));
            session.details.usage.ms = reservedMs - unused;
            const last = session.entries.at(-1);
            if (last?.details) last.details.usage.ms = reservedMs - unused;
            const ledger = {
              ...stored.ledger!,
              usage: addUsage(stored.ledger!.usage, { ms: -unused }),
            };
            await owner.commit({
              chats: {
                ...saved.chats,
                [scope]: {
                  ...stored,
                  ledger,
                  revision: stored.revision + 1,
                  state: session.snapshot(
                    stored.state.draft,
                    stored.state.cursor,
                    stored.state.scrollTop,
                  ),
                },
              },
            });
          });
          this.active = undefined;
        } catch {
          session.error =
            'Chat result could not be saved. Keep this terminal open and retry saving.';
          if (this.active) {
            this.active.running = false;
            this.active.unsaved = true;
          }
        }
        this.last = {
          turnID: request.turnID,
          busy: false,
          status: '',
          stored: this.state().stored,
        };
        // Keep unsaved result in memory for explicit recovery; no new execution.
        owner.changed();
      });
      this.active.done = done;
      return this.state();
    } catch (error) {
      this.starting = false;
      this.active = undefined;
      mail?.close();
      throw error;
    }
  }
}
