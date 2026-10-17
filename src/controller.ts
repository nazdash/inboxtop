import { ChatRunner, type ChatRunRequest } from './chat-runner.ts';
import { IMAPChatMailbox } from './chat-mail.ts';
import {
  ChatStateSchema,
  type ChatState,
  chatCorpus,
  type ChatInput,
  type ChatStep,
  type ChatWriteResult,
} from './chat.ts';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import {
  cacheKey,
  ProviderFailure,
  reusableAnalysis,
  ModelAnalyzer,
  INBOX_SUMMARY_VERSION,
} from './analysis.ts';
import { classificationKey, reusableClassification, CLASSIFIER_MODEL } from './classification.ts';
import { WorkQueue } from './work-queue.ts';
import { analysisReady, pendingDetail, dashboardSummary } from './decisions.ts';
import { MessageUnavailable } from './mail.ts';
import {
  clean,
  type Analyzer,
  type Mailbox,
  type Message,
  type Receipt,
  type ReadResult,
  type Saved,
  type Scope,
  type Session,
} from './domain.ts';
import { applySettings, settingsFrom, SettingsSchema, type Settings } from './settings.ts';
import { accountID, type Config } from './config.ts';
import type { Store } from './store.ts';
export type ReviewJob = {
  id: string;
  kind: 'newsletter' | 'email';
  messageIDs: string[];
  label: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  detail?: string;
};
class ReviewSaveFailure extends Error {}

export class Controller extends EventEmitter {
  saved: Saved = { version: 1, cache: {} };
  status = 'Choose a workflow to begin.';
  busy = false;
  snapshotting = false;
  mutating = false;
  reused = 0;
  classifiedReused = 0;
  private preferredID?: string;
  reviewJobs: ReviewJob[] = [];
  private reviewRequests = new Map<
    string,
    { job: ReviewJob; done: Promise<void>; resolve: () => void }
  >();
  private reviewDrain?: Promise<void>;
  private reviewPausing = false;
  private reviewKey(kind: ReviewJob['kind'], ids: string[]) {
    return (
      kind +
      ':' +
      createHash('sha256')
        .update(JSON.stringify([...new Set(ids)].sort()))
        .digest('hex')
    );
  }
  reviewJob(kind: ReviewJob['kind'], ids: string[]) {
    return this.reviewJobs.find((job) => job.id === this.reviewKey(kind, ids));
  }
  reviewPending(kind: ReviewJob['kind'], ids: string[]) {
    const state = this.reviewJob(kind, ids)?.state;
    return state === 'queued' || state === 'running';
  }
  private get runningReview() {
    return this.reviewJobs.find((job) => job.state === 'running');
  }
  newsletterProgress?: { messageIDs: string[]; sender: string };
  newsletterGenerating(ids: string[]) {
    return (
      !!this.newsletterProgress &&
      this.reviewKey('newsletter', ids) ===
        this.reviewKey('newsletter', this.newsletterProgress.messageIDs)
    );
  }
  prioritize(id: string) {
    this.preferredID = id;
  }
  get classifierModel() {
    return this.provider === 'openai'
      ? CLASSIFIER_MODEL
      : (this.config?.ollamaClassifier ?? this.model);
  }
  private classKey(m: Message) {
    return classificationKey(
      m,
      this.provider,
      this.classifierModel,
      this.config?.triageChars ?? 3000,
      this.config?.analysisLanguage,
    );
  }
  stages = new Map<number, 'triage' | 'detail'>();
  private polling?: ReturnType<typeof setInterval>;
  monitoring = false;
  nextRefresh?: string;
  protected closed = false;
  private storageQueue: Promise<unknown> = Promise.resolve();
  syncing = false;
  syncError = false;
  menuBarHook?: (enabled: boolean) => Promise<void>;
  summaryBusy = false;
  summaryError = '';
  providerFailure?: ProviderFailure['reason'];
  private providerFailureRevision = 0;
  // Track service failures separately from per-email validation failures. A request
  // already in flight when a failure occurred cannot clear the newer warning.
  private async modelRequest<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
    const revision = this.providerFailureRevision;
    try {
      const result = await request();
      if (!signal.aborted && this.providerFailure && revision === this.providerFailureRevision) {
        this.providerFailure = undefined;
        this.changed();
      }
      return result;
    } catch (error) {
      if (!signal.aborted && error instanceof ProviderFailure) {
        this.providerFailure = error.reason;
        this.providerFailureRevision++;
        this.changed();
      }
      throw error;
    }
  }
  private summaryAbort?: AbortController;
  private summaryTask?: Promise<void>;
  private summaryTimer?: ReturnType<typeof setTimeout>;
  private lastSummaryAttempt = '';
  private lastSummaryAt = 0;
  modeHook?: (mode: 'adhoc' | 'live') => Promise<void>;
  get mode() {
    return this.saved.mode ?? 'adhoc';
  }
  get analysisPaused() {
    return this.saved.analysisPaused ?? false;
  }
  get chatScope() {
    const identity = this.saved.inbox?.identity ?? this.session?.identity;
    return identity
      ? `${identity.account}:${identity.mailbox}`
      : `${this.config ? accountID(this.config) : 'local'}:${this.config?.mailbox ?? 'INBOX'}`;
  }
  private storeTask<T>(work: () => Promise<T>): Promise<T> {
    const next = this.storageQueue.then(work);
    this.storageQueue = next.catch(() => {});
    return next;
  }
  private chatRunner?: ChatRunner;
  private get runner() {
    return (this.chatRunner ??= new ChatRunner({
      saved: () => this.saved,
      scope: () => this.chatScope,
      transact: (work) => this.storeTask(work),
      commit: async (patch) => {
        await this.store.save({ ...this.saved, ...patch });
        Object.assign(this.saved, patch);
        this.changed();
      },
      model: (input, signal) => this.chatStep(input, signal),
      mailbox: (state) => {
        if (!this.config || this.provider === 'demo')
          throw new Error('Connected inbox unavailable in demo.');
        return new IMAPChatMailbox(this.config, undefined, state);
      },
      changed: () => this.changed(),
    }));
  }
  async startChat(request: ChatRunRequest) {
    if (this.mutating)
      throw new Error('Wait for the current mailbox or settings update before starting Chat.');
    return this.runner.start(request);
  }
  async chatRunState() {
    return this.runner.state();
  }
  async cancelChat(turnID: string) {
    this.runner.cancel(turnID);
  }
  async loadChat() {
    await this.storageQueue;
    return structuredClone(this.saved.chats?.[this.chatScope]);
  }
  async saveChatDraft(
    scope: string,
    expected: string,
    draft: string,
    cursor: number,
    scrollTop: number,
  ) {
    if (scope !== this.chatScope || draft.length > 2000)
      throw new Error('Chat draft scope changed.');
    return this.storeTask(async () => {
      const current = this.saved.chats?.[scope];
      if (!current || current.state.draft !== expected)
        throw new Error('Draft changed in another terminal. Your local text is kept.');
      const state = ChatStateSchema.parse({ ...current.state, draft, cursor, scrollTop });
      const next = { ...current, state, revision: current.revision + 1 };
      const chats = { ...this.saved.chats, [scope]: next };
      await this.store.save({ ...this.saved, chats });
      this.saved.chats = chats;
      this.changed();
      return structuredClone(next);
    });
  }
  async saveChat(scope: string, revision: number, value: ChatState): Promise<number> {
    const state = ChatStateSchema.parse(value);
    if (scope !== this.chatScope)
      throw new Error('Chat mailbox changed. Reopen Chat before saving.');
    if (state.sources.some((source) => !source.id.startsWith(scope + ':')))
      throw new Error('Source belongs to another mailbox.');
    return this.storeTask(async () => {
      if (this.chatRunner?.busy)
        throw new Error('Chat reply is running. Wait before changing the conversation.');
      const previous = this.saved.chats?.[scope];
      const current = previous?.revision ?? 0;
      if (revision !== current)
        throw new Error(
          'Saved chat changed in another terminal. Your local conversation has not overwritten it.',
        );
      const chats = {
        ...this.saved.chats,
        [scope]: {
          ...previous,
          ledger:
            state.entries.length === 0 && previous?.state.entries.length
              ? undefined
              : previous?.ledger,
          lastTurnID: state.entries.length === 0 ? undefined : previous?.lastTurnID,
          revision: current + 1,
          state,
        },
      };
      await this.store.save({ ...this.saved, chats });
      this.saved.chats = chats;
      this.chatRunner?.saved();
      this.changed();
      return current + 1;
    });
  }
  async chatStep(input: ChatInput, signal: AbortSignal): Promise<ChatStep> {
    if (!this.analyzer.chatStep) throw new Error('Chat is not supported by this provider.');
    return this.modelRequest(signal, () => this.analyzer.chatStep!(input, signal));
  }
  async applyChat(ids: string[]): Promise<ChatWriteResult> {
    if (this.mutating) throw new Error('Another mailbox change is in progress.');
    const unique = [...new Set(ids)];
    const eligible = new Set(this.retainedMessages.filter(analysisReady).map((m) => m.id));
    const available = new Set(this.pool.map((m) => m.id));
    if (
      !unique.length ||
      unique.length > 20 ||
      unique.some((id) => !eligible.has(id) || !available.has(id))
    )
      throw new Error(
        'The proposed messages changed or are no longer available. No new action was started.',
      );
    const before = new Set(this.session?.receipts.map((r) => r.id));
    await this.apply(unique);
    // Remote apply acknowledges the request before its verified writes finish.
    const deadline = Date.now() + 180000;
    while (this.mutating) {
      if (this.closed)
        throw new Error('Verification continues in the worker. Check History for results.');
      if (Date.now() > deadline)
        throw new Error('Verification is still running. Check History for the final result.');
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const results = unique.map((id) =>
      this.session?.receipts.find((r) => r.messageId === id && !before.has(r.id)),
    );
    const succeeded = results.filter((r) => r?.status === 'succeeded').length;
    const skipped = results.filter((r) => r?.status === 'skipped').length;
    return {
      succeeded,
      skipped,
      unconfirmed: results.length - succeeded - skipped,
      outcomes: unique.map((id, i) => ({
        id,
        status:
          results[i]?.status === 'succeeded'
            ? 'succeeded'
            : results[i]?.status === 'skipped'
              ? 'skipped'
              : 'unknown',
      })),
    };
  }
  get retainedMessages(): Message[] {
    const rows = new Map(Object.values(this.saved.library ?? {}).map((m) => [m.id, m]));
    for (const m of this.messages)
      rows.set(m.id, this.session?.scope.mode === 'subscriptions' ? (rows.get(m.id) ?? m) : m);
    const identity = this.saved.inbox?.identity;
    const prefix = identity && `${identity.account}:${identity.mailbox}:${identity.validity}:`;
    return [...rows.values()].filter((m) => !prefix || m.id.startsWith(prefix));
  }
  get pool(): Message[] {
    return this.retainedMessages.filter((m) => m.present && !m.read);
  }
  get reviewMessages() {
    return this.session?.scope.mode === 'subscriptions' ? this.messages : this.pool;
  }
  get inboxSummary() {
    const rows = this.pool.filter(analysisReady);
    const digest = this.saved.inboxSummary;
    // Never display prose referring to a message which has left the pool.
    const ids = new Set(rows.map((m) => m.id));
    return digest &&
      digest.key.startsWith(
        `briefing-v${INBOX_SUMMARY_VERSION}:${this.config?.analysisLanguage ?? 'en'}:`,
      ) &&
      digest.messageIDs.every((id) => ids.has(id))
      ? digest.text
      : (this.pool.length || this.saved.inbox?.uids.length) && !rows.length
        ? 'No completed recommendations yet. Choose a batch or wait for analysis to finish.'
        : dashboardSummary(rows, 'all', this.config?.analysisLanguage);
  }
  writeProgress?: { done: number; total: number; verified: number };
  private abort?: AbortController;
  private task?: Promise<void>;
  private taskIsReview = false;
  constructor(
    readonly mail: Mailbox,
    public analyzer: Analyzer,
    readonly store: Store,
    public provider: string,
    public model: string,
    public concurrency = 3,
    readonly config?: Config,
  ) {
    super();
  }
  get session() {
    return this.saved.session;
  }
  get messages() {
    return this.session?.messages ?? [];
  }
  get completed() {
    return this.messages.filter((m) => !m.error && analysisReady(m)).length;
  }
  get failed() {
    return new Set([
      ...Object.keys(this.session?.errors ?? {}),
      ...this.messages.filter((m) => m.error).map((m) => String(m.uid)),
    ]).size;
  }
  changed() {
    this.emit('change');
  }
  async init() {
    this.saved = await this.store.load();
    if (
      this.config?.profileRevision &&
      this.saved.profileRevision !== this.config.profileRevision
    ) {
      const settings = settingsFrom(this.config);
      if (this.saved.settings) {
        settings.menuBarEnabled = this.saved.settings.menuBarEnabled;
        settings.triageChars = this.saved.settings.triageChars;
        settings.pollMinutes = this.saved.settings.pollMinutes;
      }
      const next: Saved = {
        ...this.saved,
        settings,
        profileRevision: this.config.profileRevision,
        mode: 'adhoc',
        analysisPaused: true,
      };
      await this.store.save(next);
      this.saved = next;
    }
    if (this.config && this.saved.settings) {
      applySettings(this.config, this.saved.settings);
      this.provider = this.config.provider;
      this.model = this.config.model;
      this.concurrency = this.config.concurrency;
      this.analyzer = new ModelAnalyzer(this.config);
    }
    if (this.saved.analysisPaused) this.saved.mode = 'adhoc';
    this.saved.library ??= {};
    for (const m of this.messages) this.saved.library[m.id] = m;
    this.saved.history ??= this.session?.receipts ?? [];
    if (this.session) this.session.receipts = this.saved.history;
    if (this.session) {
      this.session.state = this.session.state === 'complete' ? 'complete' : 'stopped';
      if (this.session.state === 'stopped') this.session.uids = [];
      for (const r of this.session.receipts)
        if (r.status === 'pending') {
          r.status = 'unknown';
          r.detail = 'Interrupted during change. Inspect server state before retrying.';
        }
      this.status =
        this.session.state === 'complete'
          ? 'Saved report ready · no new model calls.'
          : 'Saved results loaded · choose a new batch for unanalyzed mail.';
    }
    this.changed();
  }
  private async persist() {
    this.saved.library ??= {};
    for (const m of this.messages) {
      const old = this.saved.library[m.id];
      this.saved.library[m.id] =
        this.session?.scope.mode === 'subscriptions'
          ? {
              ...m,
              analysis: old?.analysis,
              cacheKey: old?.cacheKey,
              classification: old?.classification,
              classificationKey: old?.classificationKey,
            }
          : m;
    }
    // Unread results are durable. Prune only read history, keeping recent undo data.
    const archived = Object.values(this.saved.library)
      .filter((m) => m.read || !m.present)
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const m of archived.slice(1000)) {
      if (!this.messages.some((row) => row.id === m.id)) delete this.saved.library[m.id];
    }
    const entries = Object.entries(this.saved.cache);
    if (entries.length > 3000) this.saved.cache = Object.fromEntries(entries.slice(-3000));
    if (this.saved.classifications)
      this.saved.classifications = Object.fromEntries(
        Object.entries(this.saved.classifications).slice(-3000),
      );
    if (this.saved.digests)
      this.saved.digests = Object.fromEntries(Object.entries(this.saved.digests).slice(-100));
    await this.storeTask(() => this.store.save(this.saved));
  }
  async start(scope: Scope) {
    if (this.busy || this.mutating || this.closed || this.reviewRequests.size) return;
    this.saved.analysisPaused = false;
    if (scope.limit !== null && (!Number.isSafeInteger(scope.limit) || scope.limit < 1))
      throw new Error('Choose a positive email count or All.');
    this.abort = new AbortController();
    this.reused = 0;
    this.classifiedReused = 0;
    const abort = this.abort;
    this.busy = true;
    this.snapshotting = true;
    this.status = 'Connecting to IMAP · taking a finite snapshot…';
    this.changed();
    this.taskIsReview = false;
    this.task = (async () => {
      try {
        const snapshot = await this.mail.snapshot({
          ...scope,
          limit: scope.mode === 'unread' ? null : scope.limit,
        });
        abort.signal.throwIfAborted();
        const { identity, total } = snapshot;
        const library = this.saved.library ?? {};
        const prefix = `${identity.account}:${identity.mailbox}:${identity.validity}:`;
        if (scope.mode === 'unread') this.reconcile(identity, snapshot.unreadUIDs ?? snapshot.uids);
        const available =
          scope.mode === 'unread'
            ? snapshot.uids.filter((uid) => {
                const m = library[prefix + uid];
                return !m || (!analysisReady(m) && !m.error);
              })
            : snapshot.uids;
        const uids = scope.limit === null ? available : available.slice(0, scope.limit);
        const restored =
          scope.mode === 'unread'
            ? uids.flatMap((uid) => {
                const old = library[prefix + uid];
                if (!old) return [];
                old.read = false;
                old.present = true;
                return [old];
              })
            : [];
        this.saved.session = {
          version: 1,
          identity,
          scope,
          uids,
          messages: restored,
          total,
          errors: {},
          created: new Date().toISOString(),
          provider: this.provider,
          model: this.model,
          state: 'loading',
          receipts: this.saved.history ?? [],
        };
        this.snapshotting = false;
        await this.persist();
        await this.process(this.saved.session, abort);
      } catch (e) {
        if (this.session) this.session.state = 'stopped';
        this.status = clean(e instanceof Error ? e.message : 'Could not start review.');
        await this.persist();
      } finally {
        this.snapshotting = false;
        this.busy = false;
        this.changed();
        this.finishBatchReviews();
        this.scheduleSummary();
      }
    })();
    return this.task;
  }
  // Compatibility for older clients: always select a fresh batch, never replay saved UIDs.
  async resume() {
    return this.start(this.session?.scope ?? { mode: 'unread', limit: 100, order: 'oldest' });
  }
  private async runSession() {
    const s = this.session;
    if (!s || this.busy || this.mutating || this.closed) return;
    s.provider = this.provider;
    s.model = this.model;
    this.abort = new AbortController();
    this.busy = true;
    this.reused = 0;
    this.classifiedReused = 0;
    s.state = s.scope.mode === 'subscriptions' ? 'loading' : 'reviewing';
    this.changed();
    const abort = this.abort;
    this.taskIsReview = false;
    this.task = this.process(s, abort)
      .catch(async (e) => {
        s.state = 'stopped';
        this.status = clean(e instanceof Error ? e.message : 'Review failed.');
        try {
          await this.persist();
        } catch {
          this.status += ' Could not save progress.';
        }
      })
      .finally(() => {
        this.busy = false;
        this.changed();
        this.finishBatchReviews();
        this.scheduleSummary();
      });
    return this.task;
  }
  private async process(s: Session, abort: AbortController) {
    if (s.scope.mode === 'unread' && this.analyzer.classify)
      return this.processClassified(s, abort);
    const todo = s.uids.filter((uid) => {
      const m = s.messages.find((m) => m.uid === uid);
      return (
        !s.errors[String(uid)] &&
        (!m || (s.scope.mode === 'unread' && !m.analysis && !m.error && m.present && !m.read))
      );
    });
    let offset = 0;
    let fatal: string | undefined;
    const worker = async () => {
      while (!abort.signal.aborted) {
        const uid = todo[offset++];
        if (uid === undefined) return;
        let m = s.messages.find((m) => m.uid === uid);
        try {
          if (!m) {
            this.status = `Fetching email ${s.messages.length + 1} of ${s.uids.length} · IMAP`;
            this.changed();
            m = await this.mail.fetch(uid, s.identity);
            m.kept = this.saved.library?.[m.id]?.kept;
            s.messages.push(m);
            s.messages.sort((a, b) => (s.scope.order === 'newest' ? b.uid - a.uid : a.uid - b.uid));
            await this.persist();
            this.changed();
          }
          if (abort.signal.aborted) return;
          if (s.scope.mode === 'unread' && !m.read) {
            const key = cacheKey(
              m,
              this.provider,
              this.model,
              this.config?.triageChars,
              this.config?.analysisLanguage,
            );
            m.cacheKey = key;
            if (this.saved.cache[key] && reusableAnalysis(this.saved.cache[key])) {
              m.analysis = this.saved.cache[key];
              this.reused++;
            } else {
              this.status = `Reviewing ${this.completed} / ${s.uids.length} · ${this.provider} / ${this.model}`;
              this.changed();
              const stage = (value: 'triage' | 'detail') => {
                this.stages.set(uid, value);
                this.changed();
              };
              stage('triage');
              const reviewed = m;
              const a = await this.modelRequest(abort.signal, () =>
                this.analyzer.review
                  ? this.analyzer.review(reviewed, abort.signal, stage)
                  : this.analyzer.analyze(reviewed, abort.signal),
              );
              if (abort.signal.aborted) return;
              a.analyzedAt ??= new Date().toISOString();
              m.analysis = a;
              this.saved.cache[key] = a;
            }
            m.error = undefined;
          }
          await this.persist();
          this.changed();
        } catch (e) {
          if (abort.signal.aborted) return;
          const error = clean(e instanceof Error ? e.message : 'Could not process email.');
          if (e instanceof MessageUnavailable) {
            s.errors[String(uid)] = error;
            await this.persist();
            this.changed();
            continue;
          }
          if (e instanceof ProviderFailure || !m) {
            fatal = error;
            abort.abort();
            return;
          }
          m.error = error;
          await this.persist();
          this.changed();
        } finally {
          this.stages.delete(uid);
          this.changed();
        }
      }
    };
    await Promise.all(
      Array.from({ length: s.scope.mode === 'subscriptions' ? 1 : this.concurrency }, () =>
        worker().catch((e) => {
          fatal = clean(e instanceof Error ? e.message : 'Could not save review progress.');
          abort.abort();
        }),
      ),
    );
    if (fatal) {
      s.state = 'stopped';
      this.status = fatal;
    } else if (abort.signal.aborted) {
      s.state = 'stopped';
      this.status = 'Stopped · completed work is saved.';
    } else {
      s.state = 'complete';
      this.status =
        s.scope.mode === 'subscriptions'
          ? `Sender report ready · ${s.messages.length} emails · no AI used`
          : `Report ready · ${this.completed} reviewed · ${this.failed} need retry · ${this.reused} reused`;
    }
    await this.persist();
    this.changed();
  }
  private async processClassified(s: Session, abort: AbortController) {
    const signal = abort.signal;
    const fetchQueue = new WorkQueue<Message>(signal, 24);
    const detailQueue = new WorkQueue<Message>(signal, 48, (a, b) => {
      return (
        (a.id === this.preferredID ? -1 : b.id === this.preferredID ? 1 : 0) ||
        (s.scope.order === 'oldest' ? a.uid - b.uid : b.uid - a.uid)
      );
    });
    let fatal: string | undefined;
    const protect = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        if (!signal.aborted) {
          fatal = clean(e instanceof Error ? e.message : 'Review failed.');
          abort.abort();
        }
      }
    };
    const failure = async (m: Message, e: unknown) => {
      if (signal.aborted) return;
      if (e instanceof ProviderFailure) throw e;
      m.error = clean(e instanceof Error ? e.message : 'Review failed.');
      await this.persist();
      this.changed();
    };
    const producer = protect(async () => {
      try {
        for (const uid of s.uids) {
          signal.throwIfAborted();
          if (s.errors[String(uid)]) continue;
          let m = s.messages.find((row) => row.uid === uid);
          if (!m) {
            try {
              m = await this.mail.fetch(uid, s.identity);
              m.kept = this.saved.library?.[m.id]?.kept;
              s.messages.push(m);
              await this.persist();
              this.changed();
            } catch (e) {
              if (!(e instanceof MessageUnavailable)) throw e;
              s.errors[String(uid)] = e.message;
              const missing: Message = {
                id: `${s.identity.account}:${s.identity.mailbox}:${s.identity.validity}:${uid}`,
                uid,
                validity: s.identity.validity,
                subject: 'Email unavailable',
                sender: 'Unknown sender',
                address: '',
                date: '',
                body: '',
                complete: false,
                read: false,
                present: true,
                error: e.message,
              };
              s.messages.push(missing);
              await this.persist();
              this.changed();
              continue;
            }
          }
          if (m.read || !m.present || m.error || analysisReady(m)) continue;
          await fetchQueue.put(m);
        }
      } finally {
        fetchQueue.end();
      }
    });
    const classifiers = Array.from({ length: this.config?.classificationConcurrency ?? 6 }, () =>
      protect(async () => {
        for (let m; (m = await fetchQueue.take()); ) {
          try {
            if (m.read || !m.present) continue;
            const key = this.classKey(m);
            const cached = this.saved.classifications?.[key];
            if (m.classification) this.classifiedReused++;
            else if (cached && reusableClassification(cached)) {
              m.classification = cached;
              this.classifiedReused++;
            } else {
              this.stages.set(m.uid, 'triage');
              this.changed();
              m.classification = await this.modelRequest(signal, () =>
                this.analyzer.classify!(m, signal),
              );
              signal.throwIfAborted();
              (this.saved.classifications ??= {})[key] = m.classification;
            }
            m.classificationKey = key;
            const detailKey = cacheKey(
              m,
              this.provider,
              this.model,
              this.config?.triageChars,
              this.config?.analysisLanguage,
            );
            if (
              !m.analysis &&
              this.saved.cache[detailKey] &&
              reusableAnalysis(this.saved.cache[detailKey])
            ) {
              m.analysis = this.saved.cache[detailKey];
              this.reused++;
            }
            m.cacheKey = detailKey;
            await this.persist();
            this.changed();
            if (pendingDetail(m)) await detailQueue.put(m);
          } catch (e) {
            await failure(m, e);
          } finally {
            if (this.stages.get(m.uid) === 'triage') this.stages.delete(m.uid);
            this.changed();
          }
        }
      }),
    );
    const detailFinish = protect(async () => {
      await Promise.all(classifiers);
      detailQueue.end();
    });
    const reviewers = Array.from({ length: this.concurrency }, () =>
      protect(async () => {
        for (let m; (m = await detailQueue.take()); ) {
          try {
            if (m.read || !m.present) continue;
            this.stages.set(m.uid, 'detail');
            this.changed();
            const result = await this.modelRequest(signal, () => this.analyzer.analyze(m, signal));
            signal.throwIfAborted();
            m.analysis = result;
            m.error = undefined;
            m.analysis.analyzedAt ??= new Date().toISOString();
            this.saved.cache[m.cacheKey!] = result;
            await this.persist();
            this.changed();
          } catch (e) {
            await failure(m, e);
          } finally {
            this.stages.delete(m.uid);
            this.changed();
          }
        }
      }),
    );
    await Promise.all([producer, detailFinish, ...reviewers]);
    this.stages.clear();
    s.state = fatal || signal.aborted ? 'stopped' : 'complete';
    this.status =
      fatal ??
      (signal.aborted
        ? 'Stopped · classifications and summaries saved.'
        : `Review ready · ${this.completed} ready · ${this.failed} retry · ${this.classifiedReused} classifications reused`);
    await this.persist();
    this.changed();
  }
  private finishBatchReviews() {
    if (
      this.providerFailure ||
      (this.session?.state === 'stopped' && !this.abort?.signal.aborted)
    ) {
      this.cancelWaitingReviews(
        'Queue stopped after the batch failed. Fix the problem, then request again.',
      );
      this.changed();
    } else this.pumpReviewQueue();
  }
  private enqueueReview(kind: ReviewJob['kind'], ids: string[]) {
    if (this.closed || this.reviewPausing)
      throw new Error('Analysis is stopping; try again once it stops.');
    const messageIDs = [...new Set(ids)].sort();
    const id = this.reviewKey(kind, messageIDs);
    const existing = this.reviewRequests.get(id);
    if (existing) return existing.done;
    if (this.reviewRequests.size >= 50)
      throw new Error('50 review requests are already pending. Wait for a request to finish.');
    const retained = new Map(this.retainedMessages.map((m) => [m.id, m]));
    const rows = messageIDs.map((id) => retained.get(id));
    if (!rows.length || rows.some((m) => !m))
      throw new Error('Requested emails are no longer available. Refresh the list.');
    if (kind === 'newsletter' && !this.analyzer.digest)
      throw new Error('Subscription summaries are not supported by this provider.');
    if (kind === 'newsletter' && this.newsletterDigest(messageIDs)) return Promise.resolve();
    if (kind === 'email' && (!this.session || rows[0]!.read || !rows[0]!.present))
      throw new Error('This email is no longer unread. Refresh the list.');
    const job: ReviewJob = {
      id,
      kind,
      messageIDs,
      label: kind === 'newsletter' ? rows[0]!.sender || rows[0]!.address : rows[0]!.subject,
      state: 'queued',
    };
    let resolve!: () => void;
    const done = new Promise<void>((finish) => {
      resolve = finish;
    });
    this.reviewJobs = [...this.reviewJobs.filter((j) => j.id !== id), job];
    this.reviewRequests.set(id, { job, done, resolve });
    this.changed();
    this.pumpReviewQueue();
    return done;
  }
  private trimReviewJobs() {
    const finished = this.reviewJobs.filter((j) => j.state !== 'queued' && j.state !== 'running');
    const expired = new Set(finished.slice(0, -50).map((j) => j.id));
    this.reviewJobs = this.reviewJobs.filter((j) => !expired.has(j.id));
  }
  private cancelWaitingReviews(detail: string) {
    for (const [id, request] of this.reviewRequests) {
      if (request.job.state !== 'queued') continue;
      request.job.state = 'cancelled';
      request.job.detail = detail;
      this.reviewRequests.delete(id);
      request.resolve();
    }
    this.trimReviewJobs();
  }
  private pumpReviewQueue() {
    if (this.reviewDrain || this.busy || this.mutating || this.closed || this.reviewPausing) return;
    if (!this.reviewRequests.size) return;
    this.reviewDrain = (async () => {
      // Install the drain handle before an operation can finish or emit events.
      await Promise.resolve();
      while (!this.busy && !this.mutating && !this.closed && !this.reviewPausing) {
        const request = [...this.reviewRequests.values()].find((r) => r.job.state === 'queued');
        if (!request) break;
        const job = request.job;
        job.state = 'running';
        this.abort = new AbortController();
        try {
          const retained = new Map(this.retainedMessages.map((m) => [m.id, m]));
          const rows = job.messageIDs.map((id) => retained.get(id));
          if (rows.some((m) => !m))
            throw new Error(
              'Source emails are no longer retained. Generate again for the current list.',
            );
          if (job.kind === 'newsletter' && rows.some((m) => !analysisReady(m!)))
            throw new Error(
              'Some issues have no completed review. Review them before generating a summary.',
            );
          if (job.kind === 'email' && (rows[0]!.read || !rows[0]!.present)) {
            job.state = 'cancelled';
            job.detail = 'Email is no longer unread; re-analysis skipped.';
          } else {
            if (job.kind === 'newsletter') await this.executeNewsletter(job.messageIDs);
            else await this.executeReview(job.messageIDs[0]);
            job.state = this.abort?.signal.aborted ? 'cancelled' : 'completed';
            if (job.state === 'cancelled')
              job.detail = 'Request interrupted; saved results kept. Request it again to retry.';
          }
        } catch (error) {
          job.state = this.abort?.signal.aborted ? 'cancelled' : 'failed';
          job.detail = clean(error instanceof Error ? error.message : 'Review failed. Try again.');
          if (error instanceof ProviderFailure || error instanceof ReviewSaveFailure)
            this.cancelWaitingReviews(
              'Queue stopped after a provider or saving failure. Fix the problem, then request again.',
            );
        } finally {
          this.reviewRequests.delete(job.id);
          request.resolve();
          this.trimReviewJobs();
          this.changed();
        }
      }
    })().finally(() => {
      this.reviewDrain = undefined;
      if (!this.reviewPausing) this.pumpReviewQueue();
    });
  }
  private async persistReview() {
    try {
      await this.persist();
    } catch {
      throw new ReviewSaveFailure('Could not save the review. Check local storage, then retry.');
    }
  }
  reviewNewsletter(ids: string[]): Promise<void> {
    return this.enqueueReview('newsletter', ids);
  }
  reviewOne(id: string): Promise<void> {
    return this.enqueueReview('email', [id]);
  }
  private digestKey(messages: Message[]) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          'newsletter-digest-3',
          this.config?.analysisLanguage ?? 'en',
          this.provider,
          this.model,
          [...messages]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((m) => [m.id, m.subject, m.date, m.analysis, m.classification, m.error]),
        ]),
      )
      .digest('hex');
  }
  newsletterDigest(ids: string[]) {
    const retained = new Map(this.retainedMessages.map((m) => [m.id, m]));
    const rows = ids.map((id) => retained.get(id)).filter((m): m is Message => !!m);
    return this.saved.digests?.[this.digestKey(rows)];
  }
  private async executeNewsletter(ids: string[]) {
    if (this.closed || !this.analyzer.digest) return;
    const retained = new Map(this.retainedMessages.map((m) => [m.id, m]));
    const rows = ids.map((id) => structuredClone(retained.get(id)!));
    if (!rows.length || this.newsletterDigest(ids)) return;
    this.newsletterProgress = {
      messageIDs: rows.map((m) => m.id),
      sender: rows[0].sender || rows[0].address,
    };
    this.busy = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.taskIsReview = true;
    this.task = (async () => {
      try {
        this.status = `Generating summary · ${this.newsletterProgress!.sender}`;
        this.changed();
        const key = this.digestKey(rows);
        const text = await this.modelRequest(signal, () => this.analyzer.digest!(rows, signal));
        signal.throwIfAborted();
        (this.saved.digests ??= {})[key] = {
          key,
          text,
          created: new Date().toISOString(),
          messageIDs: rows.map((m) => m.id),
        };
        try {
          await this.persistReview();
        } catch (error) {
          delete this.saved.digests![key];
          throw error;
        }
        this.status = `Summary ready · ${this.newsletterProgress!.sender}`;
      } catch (e) {
        if (e instanceof ReviewSaveFailure) throw e;
        if (!signal.aborted) {
          this.status = `Summary failed · ${this.newsletterProgress!.sender}: ${clean(e instanceof Error ? e.message : 'Try again.')}`;
        } else {
          this.status = `Summary cancelled · ${this.newsletterProgress!.sender}`;
        }
        await this.persistReview();
        throw e;
      } finally {
        this.newsletterProgress = undefined;
        this.stages.clear();
        this.busy = false;
        this.changed();
      }
    })();
    await this.task;
  }
  async pause(preserveQueued = false) {
    this.reviewPausing = true;
    if (!preserveQueued) this.cancelWaitingReviews('Cancelled before generation started.');
    this.abort?.abort();
    this.summaryAbort?.abort();
    try {
      await this.task?.catch((error) => {
        if (!this.taskIsReview) throw error;
      });
      await this.summaryTask?.catch(() => {});
      await this.reviewDrain;
    } finally {
      this.reviewPausing = false;
      this.changed();
    }
  }
  async retry() {
    if (this.busy || this.mutating || this.reviewRequests.size || !this.session) return;
    const s = this.session;
    for (const m of this.pool)
      if (m.error) {
        m.error = undefined;
        m.analysis = undefined;
        if (m.cacheKey) delete this.saved.cache[m.cacheKey];
        if (!s.uids.includes(m.uid)) s.uids.push(m.uid);
        if (!s.messages.some((row) => row.id === m.id)) s.messages.push(m);
      }
    s.errors = {};
    return this.runSession();
  }
  private async executeReview(id: string) {
    if (this.busy || this.mutating) return;
    const m = this.pool.find((m) => m.id === id);
    if (!m || !this.session) return;
    m.detailRequested = true;
    this.busy = true;
    this.abort = new AbortController();
    this.status = 'Reviewing selected email…';
    this.changed();
    const signal = this.abort.signal;
    this.taskIsReview = true;
    let completed = false;
    this.task = (async () => {
      try {
        if (!m.classification && this.analyzer.classify) {
          this.stages.set(m.uid, 'triage');
          this.changed();
          const classification = await this.modelRequest(signal, () =>
            this.analyzer.classify!(m, signal),
          );
          signal.throwIfAborted();
          const previousKey = m.classificationKey;
          const key = this.classKey(m);
          const previousCached = this.saved.classifications?.[key];
          m.classification = classification;
          m.classificationKey = key;
          (this.saved.classifications ??= {})[m.classificationKey] = m.classification;
          try {
            await this.persistReview();
          } catch (error) {
            m.classification = undefined;
            m.classificationKey = previousKey;
            if (previousCached) this.saved.classifications[key] = previousCached;
            else delete this.saved.classifications[key];
            throw error;
          }
        }
        this.stages.set(m.uid, 'detail');
        this.changed();
        const analysis = await this.modelRequest(signal, () => this.analyzer.analyze(m, signal));
        signal.throwIfAborted();
        const previous = { analysis: m.analysis, error: m.error, cacheKey: m.cacheKey };
        m.analysis = analysis;
        m.analysis.analyzedAt ??= new Date().toISOString();
        m.error = undefined;
        m.cacheKey = cacheKey(
          m,
          this.provider,
          this.model,
          this.config?.triageChars,
          this.config?.analysisLanguage,
        );
        const key = m.cacheKey;
        const previousCached = this.saved.cache[key];
        this.saved.cache[key] = m.analysis;
        try {
          await this.persistReview();
        } catch (error) {
          Object.assign(m, previous);
          if (previousCached) this.saved.cache[key] = previousCached;
          else delete this.saved.cache[key];
          throw error;
        }
        completed = true;
        this.status = 'Review updated.';
      } catch (e) {
        if (e instanceof ReviewSaveFailure) throw e;
        if (!this.abort?.signal.aborted) {
          m.error = clean(e instanceof Error ? e.message : 'Review failed.');
          this.status = m.error;
          await this.persistReview();
        }
        throw e;
      } finally {
        this.stages.delete(m.uid);
        this.busy = false;
        if (completed) this.scheduleSummary();
        this.changed();
      }
    })();
    await this.task;
  }
  async keep(id: string) {
    const m = this.pool.find((m) => m.id === id);
    if (m) {
      m.kept = !m.kept;
      await this.persist();
      this.changed();
    }
  }
  pendingReads: Record<string, 'queued' | 'updating'> = {};
  private readQueue: string[] = [];
  private readTask?: Promise<void>;
  async apply(ids: string[]) {
    if (this.closed || !this.session || (this.mutating && !this.readTask)) return;
    const eligible = new Set(this.pool.filter((m) => m.present && !m.read).map((m) => m.id));
    const added = [...new Set(ids)].filter((id) => eligible.has(id) && !this.pendingReads[id]);
    if (!added.length) return this.readTask;
    for (const id of added) this.pendingReads[id] = 'queued';
    this.readQueue.push(...added);
    if (this.writeProgress) this.writeProgress.total += added.length;
    if (!this.readTask) this.readTask = this.applyQueuedReads();
    this.changed();
    return this.readTask;
  }
  private async applyQueuedReads() {
    const resumeAfter = this.busy && !this.runningReview;
    this.mutating = true;
    let success = 0;
    try {
      await this.pause(true);
      const s = this.session!;
      this.writeProgress = { done: 0, total: this.readQueue.length, verified: 0 };
      this.changed();
      while (this.readQueue.length) {
        // Small bounded batches reduce network trips and encrypted saves without
        // delaying the first request to wait for more clicks.
        const ids = this.readQueue.splice(0, this.mail.setReadMany ? 50 : 1);
        const pool = new Map(this.pool.map((m) => [m.id, m]));
        const rows = ids.flatMap((id) => {
          const m = pool.get(id);
          if (!m || !m.present || m.read) {
            delete this.pendingReads[id];
            return [];
          }
          this.pendingReads[id] = 'updating';
          return [m];
        });
        this.changed();
        if (!rows.length) {
          this.writeProgress.done += ids.length;
          continue;
        }
        const receipts: Receipt[] = rows.map((m) => ({
          id: randomUUID(),
          messageId: m.id,
          subject: m.subject,
          uid: m.uid,
          validity: m.validity,
          before: m.read,
          after: true,
          status: 'pending',
          detail: 'Waiting for server verification',
          date: new Date().toISOString(),
        }));
        s.receipts.unshift(...receipts);
        // Persist every proposed receipt before sending any writes, then save
        // verified per-email outcomes together. Undo remains per email.
        await this.persist();
        let results: Map<string, ReadResult>;
        let detail = 'The server outcome could not be verified. Check History before retrying.';
        try {
          results =
            rows.length > 1 && this.mail.setReadMany
              ? await this.mail.setReadMany(rows, true, false)
              : new Map([[rows[0].id, await this.mail.setRead(rows[0], true, false)]]);
        } catch (e) {
          results = new Map();
          detail = clean(e instanceof Error ? e.message : 'Outcome not confirmed.');
        }
        for (const [index, m] of rows.entries()) {
          const receipt = receipts[index];
          const result = results.get(m.id);
          if (result === 'changed') {
            m.read = true;
            const current = this.messages.find((row) => row.id === m.id);
            if (current) current.read = true;
            success++;
            receipt.status = 'succeeded';
            receipt.detail = 'Read flag verified on the server.';
          } else if (result === 'skipped') {
            receipt.status = 'skipped';
            receipt.detail = 'Server state changed since selection; no change applied.';
          } else {
            receipt.status = 'unknown';
            receipt.detail = detail;
          }
        }
        this.writeProgress = {
          done: this.writeProgress.done + ids.length,
          total: this.writeProgress.total,
          verified: success,
        };
        this.status = `Marked ${success} / ${this.writeProgress.total} read · ${this.writeProgress.total - success} not yet confirmed`;
        await this.persist();
        for (const id of ids) delete this.pendingReads[id];
        this.changed();
      }
      this.status = `${success} marked read · ${this.writeProgress.total - success} skipped or unconfirmed. See history for details.`;
    } catch (error) {
      throw new Error(
        `${clean(error instanceof Error ? error.message : 'Read update failed.')} Remaining queued updates were not sent; check History before retrying.`,
      );
    } finally {
      this.readQueue = [];
      this.pendingReads = {};
      this.readTask = undefined;
      this.mutating = false;
      this.writeProgress = undefined;
      this.scheduleSummary();
      this.changed();
      if (resumeAfter && !this.closed && !this.analysisPaused)
        void this.runSession().catch((e) => {
          this.status = clean(e instanceof Error ? e.message : 'Could not resume review.');
          this.changed();
        });
      this.pumpReviewQueue();
    }
  }
  async undo(id: string) {
    if (this.mutating) return;
    const resumeAfter = this.busy && !this.runningReview;
    const receipt = this.session?.receipts.find((r) => r.id === id);
    const m =
      this.messages.find((m) => m.id === receipt?.messageId) ??
      (receipt
        ? (this.saved.library?.[receipt.messageId] ?? {
            id: receipt.messageId,
            uid: receipt.uid,
            validity: receipt.validity,
            subject: receipt.subject,
            sender: '',
            address: '',
            date: receipt.date,
            read: receipt.after,
            present: true,
            body: '',
            complete: false,
          })
        : undefined);
    if (!receipt || !m || receipt.status !== 'succeeded') return;
    this.mutating = true;
    this.changed();
    try {
      await this.pause(true);
    } catch (e) {
      this.mutating = false;
      this.changed();
      throw e;
    }
    // Persist an unknown outcome before attempting inverse mutation; never replay after crash.
    receipt.status = 'unknown';
    receipt.detail = 'Undo in progress; verify the mailbox if interrupted.';
    try {
      await this.persist();
      const result = await this.mail.setRead(m, receipt.before, receipt.after);
      if (result === 'changed') {
        m.read = receipt.before;
        const current = this.messages.find((row) => row.id === m.id);
        if (current) current.read = receipt.before;
        (this.saved.library ??= {})[m.id] = m;
        receipt.status = 'undone';
        receipt.detail = 'Original read flag restored and verified.';
        this.status = 'Undo complete.';
      } else {
        receipt.status = 'succeeded';
        receipt.detail = 'Undo skipped: server state changed.';
        this.status = receipt.detail;
      }
      await this.persist();
    } catch (e) {
      receipt.detail = clean(e instanceof Error ? e.message : 'Undo outcome unknown.');
      this.status = receipt.detail;
      await this.persist();
    } finally {
      this.mutating = false;
      this.scheduleSummary();
      this.changed();
      if (resumeAfter && !this.closed && !this.analysisPaused)
        void this.runSession().catch((e) => {
          this.status = clean(e instanceof Error ? e.message : 'Could not resume review.');
          this.changed();
        });
      this.pumpReviewQueue();
    }
  }
  async setMenuBarEnabled(enabled: boolean, config = this.config) {
    if (!config) throw new Error('Menu settings unavailable.');
    await this.storeTask(async () => {
      const settings = {
        ...(this.saved.settings ?? settingsFrom(config)),
        menuBarEnabled: enabled,
      };
      await this.store.save({ ...this.saved, settings });
      this.saved.settings = settings;
      config.menuBarEnabled = enabled;
      this.changed();
    });
    try {
      await this.menuBarHook?.(enabled);
    } catch {
      throw new Error(
        'Settings saved, but the menu companion could not start. Build it with npm run build:menu, then reopen inboxtop to retry.',
      );
    }
  }
  async saveSettings(settings: Settings, config = this.config) {
    if (config) {
      const current = settingsFrom(config);
      const next = SettingsSchema.parse(settings);
      if (
        JSON.stringify({ ...next, menuBarEnabled: current.menuBarEnabled }) ===
          JSON.stringify(current) &&
        next.menuBarEnabled !== current.menuBarEnabled
      )
        return this.setMenuBarEnabled(next.menuBarEnabled, config);
    }
    if (this.chatRunner?.busy)
      throw new Error('Stop the Chat reply before changing provider settings.');
    if (this.busy || this.mutating || this.reviewRequests.size)
      throw new Error('Stop the current review before saving settings.');
    if (!config) throw new Error('Settings are unavailable for this controller.');
    this.summaryAbort?.abort();
    await this.summaryTask;
    if (this.chatRunner?.busy)
      throw new Error('Stop the Chat reply before changing provider settings.');
    const validated = SettingsSchema.parse(settings);
    this.mutating = true;
    const previous = this.saved.settings;
    this.saved.settings = validated;
    try {
      await this.persist();
    } catch (e) {
      this.saved.settings = previous;
      throw e;
    } finally {
      this.mutating = false;
      this.changed();
    }
    applySettings(config, validated);
    if (this.provider !== 'demo') {
      this.provider = config.provider;
      this.model = config.model;
      this.concurrency = config.concurrency;
      this.analyzer = new ModelAnalyzer(config);
    }
    this.status =
      'Settings saved. New analysis uses your selected models and language; saved reviews stay unchanged.';
    this.changed();
    try {
      await this.menuBarHook?.(validated.menuBarEnabled);
    } catch {
      throw new Error(
        'Settings saved, but the menu companion could not start. Build it with npm run build:menu, then reopen inboxtop to retry.',
      );
    }
  }
  get progress() {
    const s = this.session;
    const total = s?.uids.length ?? 0;
    const resolved =
      this.messages.filter(
        (m) =>
          s?.scope.mode === 'subscriptions' ||
          analysisReady(m) ||
          !!m.error ||
          m.read ||
          !m.present,
      ).length + Object.keys(s?.errors ?? {}).length;
    return {
      total,
      fetched: this.messages.length,
      resolved: Math.min(total, resolved),
      failed: this.failed,
      reviewed: this.completed,
      classified: this.messages.filter((m) => !!m.classification || !!m.analysis).length,
      summaries: this.messages.filter((m) => !!m.analysis && !m.error).length,
      summariesNeeded: this.messages.filter(
        (m) =>
          m.classification?.needsDetail ||
          m.classification?.route === 'check' ||
          m.detailRequested ||
          !!m.analysis,
      ).length,
      pendingSummaries: this.messages.filter(pendingDetail).length,
      triage: [...this.stages.values()].filter((s) => s === 'triage').length,
      detail: [...this.stages.values()].filter((s) => s === 'detail').length,
    };
  }
  private reconcile(identity: Session['identity'], uids: number[]) {
    const prefix = `${identity.account}:${identity.mailbox}:${identity.validity}:`;
    const members = new Set(uids);
    for (const m of [...Object.values(this.saved.library ?? {}), ...this.messages]) {
      if (m.id.startsWith(prefix)) {
        m.read = !members.has(m.uid);
        if (!m.read) m.present = true;
      } else if (m.id.startsWith(`${identity.account}:${identity.mailbox}:`)) m.present = false;
    }
    this.saved.inbox = { identity, uids, at: new Date().toISOString() };
  }
  async syncInbox() {
    if (this.syncing || this.snapshotting || this.mutating || this.closed) return;
    this.syncing = true;
    this.changed();
    try {
      const snapshot = await this.mail.snapshot({ mode: 'unread', limit: null, order: 'oldest' });
      this.reconcile(snapshot.identity, snapshot.unreadUIDs ?? snapshot.uids);
      await this.persist();
      this.scheduleSummary();
      this.syncError = false;
    } catch (error) {
      this.syncError = true;
      throw error;
    } finally {
      this.syncing = false;
      this.changed();
    }
  }
  async refresh() {
    return this.start({ mode: 'unread', limit: null, order: 'oldest' });
  }
  async setMode(mode: 'adhoc' | 'live') {
    if (mode === this.mode) return;
    await this.modeHook?.(mode);
    await this.pause();
    this.saved.mode = mode;
    this.saved.analysisPaused = false;
    await this.persist();
    this.changed();
    if (mode === 'live') void this.tick();
  }
  async stop() {
    // Stop Live scheduling before waiting for in-flight calls to settle.
    this.saved.mode = 'adhoc';
    // This legacy flag now only suppresses automatic synthesis until the next Start.
    this.saved.analysisPaused = true;
    clearTimeout(this.summaryTimer);
    this.summaryTimer = undefined;
    await this.pause();
    if (this.session?.state === 'stopped') this.session.uids = [];
    await this.persist();
    this.status = 'Analysis stopped · completed results saved. Choose a new batch when ready.';
    this.changed();
  }
  async togglePause() {
    // Kept for old IPC clients; Stop never restarts an old batch.
    return this.stop();
  }
  async tick() {
    if (this.closed || this.mutating) return;
    try {
      await this.syncInbox();
      if (this.mode !== 'live' || this.analysisPaused || this.busy || this.closed) return;
      {
        const i = this.saved.inbox;
        if (
          !i ||
          !i.uids.some(
            (uid) =>
              !analysisReady(
                this.saved.library?.[
                  `${i.identity.account}:${i.identity.mailbox}:${i.identity.validity}:${uid}`
                ] ?? ({ present: true, read: false } as Message),
              ),
          )
        )
          return;
        await this.start({ mode: 'unread', limit: 100, order: 'oldest' });
      }
      if (this.session?.state === 'stopped') {
        this.saved.mode = 'adhoc';
        await this.persist();
        this.changed();
      }
    } catch (e) {
      this.status = clean(e instanceof Error ? e.message : 'Synchronization failed; retrying.');
      this.changed();
    }
  }
  startMonitoring(_minutes = this.config?.pollMinutes ?? 5) {
    if (this.closed) return;
    this.stopMonitoring();
    this.monitoring = true;
    // Synchronize even while a model is busy; newly read messages leave the pool promptly.
    this.polling = setInterval(() => {
      void this.tick();
    }, 30000);
    this.changed();
  }
  stopMonitoring() {
    clearInterval(this.polling);
    this.polling = undefined;
    this.monitoring = false;
    this.nextRefresh = undefined;
  }
  private summaryKey(rows: Message[]) {
    return (
      `briefing-v${INBOX_SUMMARY_VERSION}:${this.config?.analysisLanguage ?? 'en'}:` +
      createHash('sha256')
        .update(JSON.stringify(rows.map((m) => [m.id, m.analysis, m.classification, m.error])))
        .digest('hex')
    );
  }
  async refreshInboxSummary() {
    this.lastSummaryAttempt = '';
    return this.updateInboxSummary();
  }
  private scheduleSummary() {
    if (
      this.closed ||
      this.analysisPaused ||
      !this.analyzer.summarizeInbox ||
      this.summaryTimer ||
      this.summaryBusy
    )
      return;
    this.summaryTimer = setTimeout(
      () => {
        this.summaryTimer = undefined;
        void this.updateInboxSummary();
      },
      Math.max(1000, 30000 - (Date.now() - this.lastSummaryAt)),
    );
  }
  async updateInboxSummary() {
    if (this.closed || this.summaryBusy || !this.analyzer.summarizeInbox) return;
    const rows = structuredClone(this.pool.filter(analysisReady).sort((a, b) => a.uid - b.uid));
    const key = this.summaryKey(rows);
    if (!rows.length || key === this.saved.inboxSummary?.key || key === this.lastSummaryAttempt)
      return;
    this.lastSummaryAttempt = key;
    this.lastSummaryAt = Date.now();
    this.summaryBusy = true;
    this.summaryError = '';
    this.summaryAbort = new AbortController();
    this.changed();
    this.summaryTask = (async () => {
      try {
        const text = await this.modelRequest(this.summaryAbort!.signal, () =>
          this.analyzer.summarizeInbox!(rows, this.summaryAbort!.signal),
        );
        this.summaryAbort!.signal.throwIfAborted();
        // New arrivals may extend the pool while synthesis runs. Publish a labeled
        // snapshot, but never prose about removed messages or replaced findings.
        const ids = new Set(rows.map((m) => m.id));
        const remaining = this.pool
          .filter((m) => ids.has(m.id) && analysisReady(m))
          .sort((a, b) => a.uid - b.uid);
        if (key === this.summaryKey(remaining)) {
          this.saved.inboxSummary = {
            key,
            text,
            created: new Date().toISOString(),
            messageIDs: rows.map((m) => m.id),
          };
          await this.persist();
        }
      } catch (e) {
        if (this.summaryAbort?.signal.aborted) this.lastSummaryAttempt = '';
        else if (!this.closed)
          this.summaryError = clean(e instanceof Error ? e.message : 'Summary unavailable');
      } finally {
        this.summaryBusy = false;
        this.changed();
        this.scheduleSummary();
      }
    })();
    await this.summaryTask;
  }
  async close() {
    this.closed = true;
    await this.chatRunner?.close();
    clearTimeout(this.summaryTimer);
    this.summaryAbort?.abort();
    await this.summaryTask;
    this.stopMonitoring();
    try {
      await this.pause();
      while (this.mutating)
        await new Promise<void>((resolve) => this.once('change', () => resolve()));
    } finally {
      try {
        await this.mail.close();
      } finally {
        await this.storageQueue;
        await this.store.close();
      }
    }
  }
}
