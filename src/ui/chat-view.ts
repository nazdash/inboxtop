import { randomUUID } from 'node:crypto';
import type { ChatRunState } from '../chat-runner.ts';
import type { Activity } from './activity.ts';
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextAttributes,
  MarkdownRenderable,
  SyntaxStyle,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { ChatSession, ChatStateSchema, type ChatState, chatCorpus } from '../chat.ts';
import { clean, type Message } from '../domain.ts';
import type { Controller } from '../controller.ts';
import type { ThemeColors } from './theme.ts';
import { emailLinks } from './email-links.ts';
import { ChatInput } from './chat-input.ts';

export class ChatView {
  readonly session: ChatSession;
  draft = '';
  private draftBase = '';
  private draftCursor?: number;
  private input?: ChatInput;
  private scroll?: ScrollBoxRenderable;
  private scrollTop = 0;
  private sourceScroll = 0;
  private sourceListScroll = 0;
  private focus: 'input' | 'conversation' = 'input';
  private view: 'chat' | 'sources' | 'original' | 'details' = 'chat';
  private polling?: ReturnType<typeof setTimeout>;
  private turnID = '';
  private observing = false;
  private submitting = false;
  private checking = true;
  private lastRun = '';
  private scrollFrame?: () => void;
  private observeAgain = false;
  private onWorkerChange = () => {
    void this.observe();
  };
  private original?: number;
  private originalFrom: 'chat' | 'sources' = 'chat';
  private overlayFrom: 'chat' | 'sources' | 'original' = 'chat';
  private overlayScroll = 0;
  private sourceIndex = 0;
  private sourceRefs: number[] = [];
  private bottom = false;
  private revealEntry?: number;
  private entryCount = 0;
  private disposed = false;
  private localError = '';
  private saveError = '';
  private loadFailed = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saveTask?: Promise<void>;
  private savedJSON = '';
  private revision = 0;
  private scope: string;
  private menu = false;
  private menuIndex = 0;
  private resetPrompt?: 'new' | 'reload';
  private styles = new Map<string, SyntaxStyle>();
  constructor(
    private renderer: CliRenderer,
    private controller: Controller,
    private redraw: () => void,
    private back: () => void,
    private originalContent: (parent: BoxRenderable, m: Message) => void,
    private openEmailURL: (url: string) => void,
  ) {
    this.scope = controller.chatScope;
    this.session = new ChatSession(
      () => chatCorpus(controller.saved, controller.chatScope),
      async () => {
        throw new Error('Chat execution belongs to the worker.');
      },
      () => {
        if (this.disposed) return;
        if (this.session.entries.length > this.entryCount)
          this.revealEntry = this.session.entries.length - 1;
        this.entryCount = this.session.entries.length;
        this.queueSave();
        this.redraw();
      },
    );
    const stored = controller.saved.chats?.[this.scope];
    if (stored) {
      this.revision = stored.revision;
      try {
        this.restore(stored.state, stored.revision);
      } catch {
        this.loadFailed = true;
        this.saveError = 'Saved chat could not be read. It has been left untouched.';
      }
    } else this.savedJSON = JSON.stringify(this.state());
    this.controller.on('change', this.onWorkerChange);
    void this.observe();
  }
  private async observe() {
    if (this.disposed || this.submitting) return;
    if (this.observing) {
      this.observeAgain = true;
      return;
    }
    clearTimeout(this.polling);
    this.observing = true;
    try {
      const run = await this.controller.chatRunState();
      if (this.disposed) return;
      const cleanLocal = JSON.stringify(this.state()) === this.savedJSON;
      if (
        run.busy ||
        this.session.busy ||
        (run.stored &&
          run.turnID &&
          run.turnID !== this.turnID &&
          run.stored.revision > this.revision &&
          cleanLocal)
      )
        this.acceptRun(run);
    } catch (error) {
      if (this.session.busy)
        this.localError =
          'Worker connection unavailable. The reply may still be running; reconnect to check.';
    } finally {
      this.checking = false;
      this.observing = false;
      if (!this.disposed) {
        this.queueSave();
        if (this.observeAgain) {
          this.observeAgain = false;
          void this.observe();
        } else if (this.session.busy)
          this.polling = setTimeout(() => {
            void this.observe();
          }, 350);
      }
    }
  }
  private acceptRun(run: ChatRunState) {
    const json = JSON.stringify(run);
    if (json === this.lastRun) return;
    this.lastRun = json;
    const count = this.session.entries.length;
    if (run.stored) {
      this.session.restore(run.stored.state);
      this.revision = run.stored.revision;
      this.savedJSON = run.unsaved ? '' : JSON.stringify(run.stored.state);
      if (this.draft === this.draftBase) {
        this.draft = run.stored.state.draft;
        this.draftCursor = run.stored.state.cursor;
        this.draftBase = this.draft;
      }
      if (run.unsaved)
        this.saveError =
          'Reply not saved. F2 More → Retry save. The result is kept in this worker.';
      if (run.busy) {
        this.session.error = run.stored.state.error;
        this.session.retryText = undefined;
      }
      // Draft and viewport are client-owned while observing another terminal.
    }
    this.turnID = run.turnID;
    this.session.busy = run.busy;
    this.session.status = run.status;
    this.entryCount = this.session.entries.length;
    if (this.entryCount > count) this.revealEntry = this.entryCount - 1;
    this.redraw();
  }
  private stopReply() {
    void this.controller.cancelChat(this.turnID).catch(() => {
      this.localError = 'Could not confirm cancellation. Reconnect to check the reply.';
      this.redraw();
    });
  }
  private showDetails() {
    this.capture();
    if (this.view !== 'details') this.overlayFrom = this.view;
    this.view = 'details';
    this.overlayScroll = 0;
    this.redraw();
  }
  private restore(value: ChatState, revision: number) {
    const state = ChatStateSchema.parse(value);
    this.session.restore(state);
    this.draft = state.draft;
    this.draftBase = state.draft;
    this.draftCursor = state.cursor;
    this.scrollTop = state.scrollTop;
    this.entryCount = this.session.entries.length;
    this.revision = revision;
    this.savedJSON = JSON.stringify(state);
  }
  private state() {
    return this.session.snapshot(this.draft, this.draftCursor ?? this.draft.length, this.scrollTop);
  }
  private queueSave() {
    if (
      this.disposed ||
      this.saveError ||
      this.saveTimer ||
      this.session.busy ||
      this.submitting ||
      this.checking
    )
      return;
    if (JSON.stringify(this.state()) === this.savedJSON) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch(() => {});
    }, 200);
    this.refreshStatus();
  }
  async flush(force = false) {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.session.busy) {
      if (this.draft !== this.draftBase) {
        try {
          const stored = await this.controller.saveChatDraft(
            this.scope,
            this.draftBase,
            this.draft,
            this.draftCursor ?? this.draft.length,
            this.scrollTop,
          );
          this.draftBase = stored.state.draft;
          this.revision = stored.revision;
        } catch (error) {
          this.saveError = clean(error instanceof Error ? error.message : 'Draft not saved.');
          throw error;
        }
      }
      return;
    }
    if (this.saveTask) await this.saveTask;
    if (this.saveError) throw new Error(this.saveError);
    if ((!force || this.revision) && JSON.stringify(this.state()) === this.savedJSON) return;
    const task = async () => {
      try {
        while (true) {
          const state = this.state();
          const recoveringReply = state.error.startsWith('Chat result could not be saved.');
          if (recoveringReply) state.error = '';
          const json = JSON.stringify(state);
          if ((!force || this.revision) && json === this.savedJSON) break;
          this.revision = await this.controller.saveChat(this.scope, this.revision, state);
          this.savedJSON = json;
          if (recoveringReply) this.session.error = '';
          this.draftBase = state.draft;
        }
      } catch (error) {
        this.saveError =
          'Chat not saved: ' +
          clean(error instanceof Error ? error.message : 'Storage unavailable.');
        if (!this.disposed) this.redraw();
        throw error;
      } finally {
        this.saveTask = undefined;
        if (!this.disposed) this.refreshStatus();
      }
    };
    this.saveTask = task();
    return this.saveTask;
  }
  async flushBeforeExit() {
    this.capture();
    await this.flush();
  }
  private scopeLabel() {
    const status = this.saveError
      ? 'Not saved · F2 More'
      : this.saveTimer || this.saveTask
        ? 'Saving…'
        : this.revision
          ? 'Saved locally'
          : 'Autosave on';
    const plan = this.session.busy ? this.session.details.plan : undefined;
    const detail = plan?.after
      ? `${plan.after}–${plan.before}`
      : `${chatCorpus(this.controller.saved, this.controller.chatScope).length} saved`;
    return `${detail} · ${this.controller.config?.mailbox ?? 'INBOX'}${this.renderer.width >= 65 || !plan?.after ? ' · ' + status : ''}`;
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.saveTimer);
    clearTimeout(this.polling);
    this.controller.off('change', this.onWorkerChange);
    if (this.scrollFrame) this.renderer.off('frame', this.scrollFrame);
    for (const style of this.styles.values()) style.destroy();
    this.styles.clear();
  }
  capture() {
    if (this.input && !this.input.isDestroyed) this.draftCursor = this.input.cursorOffset;
    if (this.scroll && !this.scroll.isDestroyed) {
      if (this.view === 'chat') this.scrollTop = this.scroll.scrollTop;
      else if (this.view === 'sources') this.sourceListScroll = this.scroll.scrollTop;
      else if (this.view === 'details') this.overlayScroll = this.scroll.scrollTop;
      else this.sourceScroll = this.scroll.scrollTop;
    }
    this.input = undefined;
    this.scroll = undefined;
    this.queueSave();
  }
  refreshStatus() {
    const scope = this.renderer.root.findDescendantById('chat-scope') as TextRenderable | undefined;
    if (scope) scope.content = this.scopeLabel();
    const status = this.renderer.root.findDescendantById('chat-status') as
      | TextRenderable
      | undefined;
    if (status) status.content = this.activityLabel();
  }
  private activityLabel() {
    const progress = this.controller.writeProgress;
    return this.session.proposal?.status === 'applying'
      ? progress
        ? `Marking read · ${progress.done}/${progress.total}`
        : 'Verifying read status…'
      : this.session.busy
        ? this.session.status
        : '';
  }
  activity(): Activity | undefined {
    const node = this.renderer.root.findDescendantById('chat-status') as TextRenderable | undefined;
    const label = this.activityLabel();
    return node && label
      ? {
          node,
          key: this.session.proposal?.status === 'applying' ? 'chat-write' : 'chat-answer',
          label,
        }
      : undefined;
  }
  private box(parent: BoxRenderable, options: ConstructorParameters<typeof BoxRenderable>[1] = {}) {
    const node = new BoxRenderable(this.renderer, options);
    parent.add(node);
    return node;
  }
  private text(
    parent: BoxRenderable,
    content: string,
    color: string,
    options: ConstructorParameters<typeof TextRenderable>[1] = {},
  ) {
    const node = new TextRenderable(this.renderer, {
      content: clean(content),
      fg: color,
      wrapMode: 'word',
      flexShrink: 0,
      ...options,
    });
    parent.add(node);
    return node;
  }
  private openSource(ref: number) {
    if (!this.session.message(ref)) {
      this.localError =
        'This source is no longer retained. Its citation remains in the conversation.';
      this.redraw();
      return;
    }
    this.localError = '';
    this.capture();
    this.originalFrom = this.view === 'sources' ? 'sources' : 'chat';
    this.view = 'original';
    this.original = ref;
    this.sourceScroll = 0;
    this.redraw();
  }
  private leave() {
    this.capture();
    if (this.view !== 'chat') {
      this.view =
        this.view === 'original'
          ? this.originalFrom
          : this.view === 'details'
            ? this.overlayFrom
            : 'chat';
      this.redraw();
    } else this.back();
  }
  private showSources() {
    this.capture();
    if (this.view === 'chat' || (this.view === 'original' && this.originalFrom === 'chat')) {
      // Freeze the browser order while it is open, including when a reply finishes.
      this.sourceRefs = [
        ...new Set(
          this.session.entries
            .slice()
            .reverse()
            .flatMap((entry) => entry.sources),
        ),
      ];
      this.sourceIndex =
        this.view === 'original' ? Math.max(0, this.sourceRefs.indexOf(this.original!)) : 0;
      this.sourceListScroll = 0;
    }
    this.view = 'sources';
    this.redraw();
  }
  private citedSources() {
    // Match the answer's citation order, putting the latest answer first.
    // Retrieved candidates that were never cited are not links in the conversation.
    return this.sourceRefs.flatMap((ref) => {
      const source = this.session.sources.find((source) => source.ref === ref);
      return source ? [source] : [];
    });
  }
  private send() {
    void this.submit(this.draft.trim());
  }
  private async submit(question: string, retry = false) {
    if (
      !question ||
      this.session.busy ||
      this.submitting ||
      ['pending', 'applying'].includes(this.session.proposal?.status ?? '')
    )
      return;
    this.submitting = true;
    this.localError = '';
    try {
      await this.flush(true);
      const run = await this.controller.startChat({
        turnID: randomUUID(),
        revision: this.revision,
        question,
        retry,
      });
      if (!retry) {
        this.draft = '';
        this.draftBase = '';
        this.draftCursor = 0;
      }
      this.acceptRun(run);
    } catch (error) {
      this.localError = clean(
        error instanceof Error ? error.message : 'Could not start reply. Your draft is kept.',
      );
      this.redraw();
    } finally {
      this.submitting = false;
      void this.observe();
    }
  }
  private retry() {
    if (this.session.retryText) void this.submit(this.session.retryText, true);
  }
  private focusInput() {
    this.focus = 'input';
    this.redraw();
  }
  private moreCommands() {
    if (this.view === 'original')
      return this.originalLinks().map((url, i) => ({
        key: String(i + 1),
        label: url,
        run: () => this.openEmailURL(url),
      }));
    return [
      { key: 'Ctrl+O', label: 'Browse sources', run: () => this.showSources() },
      ...(!this.session.busy && this.session.retryText
        ? [{ key: 'Ctrl+R', label: 'Retry reply', run: () => this.retry() }]
        : []),
      ...(this.saveError
        ? [
            {
              key: 'Enter',
              label: 'Retry save',
              run: () => {
                this.saveError = '';
                void this.flush().catch(() => {});
              },
            },
            {
              key: 'Enter',
              label: 'Reload saved chat',
              run: () => {
                this.resetPrompt = 'reload';
                this.redraw();
              },
            },
          ]
        : []),
      ...(!this.session.busy
        ? [
            {
              key: 'Ctrl+N',
              label: 'New chat',
              run: () => {
                this.resetPrompt = 'new';
                this.redraw();
              },
            },
          ]
        : []),
      { key: 'F4', label: 'Investigation details', run: () => this.showDetails() },
    ];
  }
  private openMore() {
    if (this.session.proposal?.status === 'applying') return;
    this.menu = true;
    this.menuIndex = 0;
    this.redraw();
  }
  private originalLinks() {
    const m = this.original ? this.session.message(this.original) : undefined;
    return [...new Set(emailLinks(m?.body ?? '').map((link) => link.url))];
  }
  private openOriginalLinks() {
    if (!this.originalLinks().length) return;
    this.menu = true;
    this.menuIndex = 0;
    this.redraw();
  }
  private runMore(index: number) {
    const command = this.moreCommands()[index];
    if (!command) return;
    this.menu = false;
    command.run();
    this.redraw();
  }
  private async confirmReset() {
    const kind = this.resetPrompt;
    if (!kind) return;
    this.resetPrompt = undefined;
    if (kind === 'new') this.newChat();
    else {
      try {
        const saved = await this.controller.loadChat();
        const state = saved
          ? ChatStateSchema.parse(saved.state)
          : new ChatSession(
              () => [],
              async () => {
                throw new Error('No model');
              },
            ).snapshot();
        this.restore(state, saved?.revision ?? 0);
        this.loadFailed = false;
        this.saveError = '';
        this.localError = '';
      } catch (error) {
        this.localError = clean(
          error instanceof Error ? error.message : 'Could not reload saved chat.',
        );
      }
      this.redraw();
    }
  }
  private newChat() {
    if (this.loadFailed) {
      this.saveError = '';
      this.loadFailed = false;
    }
    this.localError = '';
    this.draft = '';
    this.draftCursor = 0;
    this.focus = 'input';
    this.scrollTop = 0;
    this.sourceRefs = [];
    this.sourceIndex = 0;
    this.session.clear();
  }
  private async confirm() {
    const proposal = this.session.proposal;
    if (proposal?.status !== 'pending' || this.controller.mutating) return;
    proposal.status = 'applying';
    this.redraw();
    try {
      await this.flush();
      const result = await this.controller.applyChat(proposal.sources.map((s) => s.id));
      if (this.disposed) return;
      const detail = result.outcomes
        .map((item) => {
          const source = proposal.sources.find((s) => s.id === item.id)!;
          return `[${source.ref}] ${item.status === 'succeeded' ? 'Marked read' : item.status === 'skipped' ? 'Skipped: server state changed' : 'Outcome unconfirmed; inspect History before retrying'}`;
        })
        .join('\n');
      this.session.result(
        `${result.succeeded} marked read; ${result.skipped} skipped; ${result.unconfirmed} unconfirmed.\n${detail}`,
      );
    } catch (e) {
      if (this.disposed) return;
      this.session.result(
        `Mark-read result not confirmed: ${clean(e instanceof Error ? e.message : 'Request failed')}. Check History before trying again.`,
      );
    }
  }
  render(parent: BoxRenderable, colors: ThemeColors) {
    if (this.scrollFrame) this.renderer.off('frame', this.scrollFrame);
    const session = this.session;
    const scopeControls = this.box(parent, {
      flexDirection: 'row',
      columnGap: 2,
      height: 1,
      flexShrink: 0,
    });
    this.text(
      scopeControls,
      this.controller.provider === 'demo' ? 'Demo mail' : 'Saved mail + inbox',
      colors.text,
      { height: 1 },
    );
    this.text(scopeControls, 'F4 Details', colors.muted, {
      height: 1,
      onMouseDown: () => this.showDetails(),
    });
    this.text(parent, this.scopeLabel(), colors.muted, {
      id: 'chat-scope',
      height: 1,
      wrapMode: 'none',
    });
    const scroll = (this.scroll = new ScrollBoxRenderable(this.renderer, {
      id: 'chat-conversation',
      flexGrow: 1,
      minHeight: 0,
      scrollX: false,
      scrollY: true,
      contentOptions: { flexDirection: 'column', paddingRight: 1 },
      onMouseDown: () => {
        if (this.view !== 'chat' || this.focus === 'conversation') return;
        this.focus = 'conversation';
        this.redraw();
      },
    }));
    parent.add(scroll);
    if (this.view === 'details') {
      const d = session.details;
      this.text(scroll, 'Investigation details · latest reply', colors.text, {
        attributes: TextAttributes.BOLD,
      });
      this.text(
        scroll,
        `Access: ${d.access === 'connected' ? 'Connected inbox' : 'Saved mail'}\nStop: ${session.busy ? 'Working' : d.stop.replaceAll('_', ' ') || 'No investigation yet'}`,
        colors.muted,
        { marginTop: 1 },
      );
      this.text(
        scroll,
        this.controller.provider === 'demo'
          ? 'Fictional demo mail only; no real mailbox connection.'
          : `Chat uses saved mail first and searches ${this.controller.config?.mailbox ?? 'INBOX'} when needed, with bounded read-only access. Other folders, attachments and linked pages are excluded. Retrieved excerpts use your configured ${this.controller.provider === 'ollama' ? 'local Ollama' : this.controller.provider} model.`,
        colors.muted,
        { marginTop: 1 },
      );
      if (d.plan)
        this.text(
          scroll,
          `Goal: ${d.plan.goal}\nDates: ${d.plan.after || 'Not specified'}–${d.plan.before || ''} (${d.plan.dateOrigin})\nEvidence needed: ${d.plan.evidence.join('; ')}\nFinish when: ${d.plan.stopWhen}`,
          colors.text,
          { marginTop: 1 },
        );
      this.text(
        scroll,
        `This reply: ${d.usage.calls} model requests · ${d.usage.searches} mailbox searches · ${d.usage.bodies} originals fetched\n${d.usage.input} input characters · ${d.usage.bytes} body bytes reserved. Provider tokens/cost unknown.`,
        colors.muted,
        { marginTop: 1 },
      );
      for (const op of d.operations)
        this.text(
          scroll,
          `${op.tool}${op.reason ? ' · ' + op.reason : ''}\n${op.result}`,
          colors.text,
          { marginTop: 1 },
        );
      this.text(
        scroll,
        'Counts can overlap: a source may supply both saved findings and original passages. A header match alone is not body evidence. Limits apply equally to local and hosted models.',
        colors.muted,
        { marginTop: 1 },
      );
    } else if (this.view === 'original') {
      const m = this.original && session.message(this.original);
      if (m) {
        this.text(scroll, `Original email · [${this.original}]`, colors.green, {
          attributes: TextAttributes.BOLD,
        });
        if (m.body) this.originalContent(scroll, m);
        else
          this.text(
            scroll,
            'Only this email’s headers are saved. Ask Chat to read the original from your inbox.',
            colors.muted,
            { marginTop: 1 },
          );
      } else this.text(scroll, 'Source no longer available in saved mail.', colors.amber);
    } else if (this.view === 'sources') {
      this.text(scroll, 'Sources · latest answer first', colors.green, { height: 2 });
      const sources = this.citedSources();
      if (!sources.length)
        this.text(scroll, 'Sources will appear when an answer cites an email.', colors.muted);
      for (const [index, source] of sources.entries())
        this.text(
          scroll,
          `[${source.ref}] ${source.sender} · ${source.date.slice(0, 10)}\n${source.subject}`,
          index === this.sourceIndex ? colors.green : colors.text,
          {
            id: `chat-source-row-${index}`,
            marginBottom: 1,
            bg: index === this.sourceIndex ? colors.raised : undefined,
            onMouseDown: () => {
              this.sourceIndex = index;
              this.openSource(source.ref);
            },
          },
        );
    } else {
      if (!session.entries.length) {
        this.text(scroll, 'Ask your inbox', colors.green, {
          attributes: TextAttributes.BOLD,
          marginTop: 1,
        });
        this.text(
          scroll,
          'Anything important about school?\nFind the bicycle repair conversation.\nWhich payment requests need checking?',
          colors.text,
          { marginTop: 1 },
        );
        this.text(
          scroll,
          'Ask about your emails, read or unread. Chat uses saved mail first and searches your configured inbox when needed. Attachments and linked pages are excluded.',
          colors.muted,
          { marginTop: 1 },
        );
      }
      for (const [index, entry] of session.entries.entries()) {
        const block = this.box(scroll, {
          id: `chat-entry-${index}`,
          flexDirection: 'column',
          flexShrink: 0,
          marginTop: 1,
          ...(entry.role === 'user'
            ? {
                border: ['left'] as const,
                borderColor: colors.blue,
                backgroundColor: colors.panel,
                paddingX: 1,
              }
            : {}),
        });
        this.text(
          block,
          entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'AI answer' : 'inboxtop',
          entry.role === 'user'
            ? colors.blue
            : entry.role === 'assistant'
              ? colors.text
              : colors.muted,
          { attributes: TextAttributes.BOLD },
        );
        if (entry.role === 'assistant') {
          let style = this.styles.get(colors.bg);
          if (!style) {
            style = SyntaxStyle.fromStyles(
              {
                default: { fg: colors.text },
                'markup.strong': { bold: true },
                'markup.italic': { italic: true },
                'markup.heading': { fg: colors.text, bold: true },
                'markup.raw': { fg: colors.blue },
                'markup.link': { fg: colors.blue },
                'markup.link.label': { fg: colors.blue },
                'markup.link.url': { fg: colors.muted },
                'markup.list': { fg: colors.text },
                'markup.quote': { fg: colors.muted },
              },
              this.renderer.nativeScene,
            );
            this.styles.set(colors.bg, style);
          }
          block.add(
            new MarkdownRenderable(this.renderer, {
              id: `chat-answer-${index}`,
              // Keep cited labels literal and styled; leave existing code spans intact.
              content: clean(entry.text).replace(/(`+)[\s\S]*?\1|\[(\d+)\]/g, (match, code, ref) =>
                !code && entry.sources.includes(Number(ref)) ? '`' + match + '`' : match,
              ),
              syntaxStyle: style,
              fg: colors.text,
              conceal: true,
              internalBlockMode: 'top-level',
              width: '100%',
              flexShrink: 0,
              renderNode: (token) => {
                if (token.type === 'code')
                  return new TextRenderable(this.renderer, {
                    content: clean(token.text),
                    fg: colors.blue,
                    wrapMode: 'word',
                    flexShrink: 0,
                    marginTop: 0,
                  });
                // Markdown treats a later numbered item immediately after prose
                // as part of that paragraph. Give it a section boundary without
                // changing saved text, fenced code or multiline inline code.
                if (
                  token.type === 'paragraph' &&
                  !token.tokens?.some((part) => part.type === 'codespan' && part.raw.includes('\n'))
                ) {
                  const spaced = token.raw.replace(/\n(?=\d+\.[ \t]+\S)/g, '\n\n');
                  if (spaced !== token.raw)
                    return new MarkdownRenderable(this.renderer, {
                      content: spaced,
                      syntaxStyle: style!,
                      fg: colors.text,
                      conceal: true,
                      internalBlockMode: 'top-level',
                      width: '100%',
                      flexShrink: 0,
                      marginTop: 0,
                    });
                }
                return undefined;
              },
            }),
          );
        } else this.text(block, entry.text, colors.text);
        if (entry.coverage) this.text(block, entry.coverage, colors.muted, { marginTop: 1 });
        if (entry.sources.length)
          this.text(block, 'Sources · Ctrl+O Browse', colors.muted, {
            id: `chat-sources-heading-${index}`,
            marginTop: 1,
            onMouseDown: () => this.showSources(),
          });
        for (const ref of entry.sources) {
          const source = session.sources.find((s) => s.ref === ref);
          if (source)
            this.text(block, `[${ref}] ${source.sender} · ${source.subject} ›`, colors.blue, {
              id: `chat-citation-${index}-${ref}`,
              onMouseDown: () => this.openSource(ref),
            });
        }
      }
    }
    const pending = session.proposal?.status === 'pending';
    const applying = session.proposal?.status === 'applying';
    const hasInput =
      this.view === 'chat' && !pending && !applying && !this.menu && !this.resetPrompt;
    const dock = this.box(parent, {
      id: 'chat-dock',
      marginTop: 1,
      border: hasInput ? false : ['top'],
      borderColor: hasInput ? undefined : colors.line,
      flexShrink: 0,
      flexDirection: 'column',
    });
    const error = this.saveError || this.localError || session.error;
    const status = this.activityLabel();
    if (error) this.text(dock, error, colors.amber, { maxHeight: 3 });
    if (status)
      this.text(dock, status, colors.muted, { id: 'chat-status', height: 1, wrapMode: 'none' });
    if (this.view === 'chat' && pending && !this.menu && !this.resetPrompt)
      this.text(
        dock,
        `Mark ${session.proposal!.sources.length} listed emails read?`,
        colors.amber,
        { height: 1 },
      );
    if (hasInput) {
      const composer = this.box(dock, {
        id: 'chat-composer',
        flexShrink: 0,
        border: true,
        borderStyle: 'rounded',
        borderColor: this.focus === 'input' && !session.busy ? colors.green : colors.line,
        title: session.busy ? ' Message ' : ' Message · Ctrl+J New line ',
        paddingX: 1,
        backgroundColor: colors.panel,
      });
      const input = (this.input = new ChatInput(this.renderer, {
        id: 'chat-input',
        initialValue: this.draft,
        minHeight: 1,
        maxHeight: 4,
        wrapMode: 'word',
        keyBindings: [
          { name: 'return', action: 'submit' },
          { name: 'kpenter', action: 'submit' },
          { name: 'return', shift: true, action: 'newline' },
          { name: 'j', ctrl: true, action: 'newline' },
        ],
        onSubmit: () => this.send(),
        placeholder: session.busy
          ? 'Wait for the answer, or Esc to cancel'
          : 'Ask about your emails…',
        width: '100%',
        flexShrink: 0,
        backgroundColor: colors.panel,
        focusedBackgroundColor: colors.panel,
        textColor: colors.text,
        placeholderColor: colors.muted,
        cursorColor: colors.green,
        onMouseDown: () => {
          if (!session.busy) {
            if (this.focus !== 'input') this.focusInput();
          }
        },
      }));
      composer.add(input);
      input.cursorOffset = this.draftCursor ?? this.draft.length;
      input.onContentChange = () => {
        this.draft = input.plainText;
        this.draftCursor = input.cursorOffset;
        this.queueSave();
      };
      if (this.focus === 'input' && !session.busy) input.focus();
      else scroll.focus();
    } else scroll.focus();
    if (this.resetPrompt)
      this.text(
        dock,
        this.resetPrompt === 'new'
          ? 'Clear saved conversation and draft?'
          : 'Discard local changes and reload saved chat?',
        colors.amber,
        { maxHeight: 2 },
      );
    else if (this.menu) {
      const menu = new ScrollBoxRenderable(this.renderer, {
        id: 'chat-more-menu',
        height: Math.min(4, this.moreCommands().length),
        flexShrink: 0,
        scrollY: true,
      });
      dock.add(menu);
      this.moreCommands().forEach((command, index) =>
        this.text(menu, `${command.key.padEnd(7)} ${command.label}`, colors.text, {
          id: `chat-more-${index}`,
          height: 1,
          bg: index === this.menuIndex ? colors.raised : undefined,
          onMouseDown: () => this.runMore(index),
        }),
      );
      menu.focus();
      this.renderer.once('frame', () => {
        if (!menu.isDestroyed) menu.scrollChildIntoView(`chat-more-${this.menuIndex}`);
      });
    }
    const controls = this.box(dock, {
      id: 'chat-controls',
      marginTop: hasInput ? 1 : 0,
      flexDirection: 'row',
      flexWrap: 'wrap',
      flexShrink: 0,
    });
    const button = (id: string, key: string, label: string, action: () => void) => {
      const box = this.box(controls, {
        id,
        flexDirection: 'row',
        height: 1,
        flexShrink: 0,
        width: Bun.stringWidth(`${key} ${label}`),
        marginRight: 2,
        onMouseDown: action,
      });
      this.text(box, key, colors.green, {
        height: 1,
        bg: colors.raised,
        attributes: TextAttributes.BOLD,
      });
      this.text(box, ' ' + label, colors.text, { height: 1 });
    };
    if (this.resetPrompt) {
      button('chat-reset-cancel', 'Esc', 'Cancel', () => {
        this.resetPrompt = undefined;
        this.redraw();
      });
      button(
        'chat-reset-confirm',
        'Enter',
        this.resetPrompt === 'new' ? 'Clear chat' : 'Reload',
        () => {
          void this.confirmReset();
        },
      );
    } else if (this.menu) {
      button('chat-menu-back', 'Esc', 'Close menu', () => {
        this.menu = false;
        this.redraw();
      });
      button('chat-menu-run', 'Enter', 'Choose', () => this.runMore(this.menuIndex));
      this.text(controls, '↑↓ Move', colors.muted, { height: 1 });
    } else if (this.view !== 'chat') {
      button(
        'chat-back',
        'Esc',
        (this.view === 'original' && this.originalFrom === 'sources') ||
          (this.view === 'details' && this.overlayFrom === 'sources')
          ? 'Back to sources'
          : this.view === 'details' && this.overlayFrom === 'original'
            ? 'Back to email'
            : 'Back to chat',
        () => this.leave(),
      );
      if (this.view === 'sources' && this.citedSources().length) {
        button('chat-open-source', 'Enter', 'Open source', () => {
          const source = this.citedSources()[this.sourceIndex];
          if (source) this.openSource(source.ref);
        });
        this.text(controls, '↑↓ Choose', colors.muted, { height: 1 });
      } else if (this.view === 'original') {
        if (this.originalLinks().length)
          button('chat-email-links', 'L', 'Links', () => this.openOriginalLinks());
        this.text(controls, '↑↓ Scroll', colors.muted, { height: 1 });
      }
    } else if (pending) {
      button('chat-cancel-proposal', 'Esc', 'Cancel', () => session.cancelProposal());
      button('chat-confirm', 'Enter', 'Confirm', () => {
        void this.confirm();
      });
      button('chat-sources', 'Ctrl+O', 'Sources', () => this.showSources());
    } else {
      button('chat-back', 'Esc', session.busy ? 'Stop reply' : 'Back to inbox', () =>
        session.busy ? this.stopReply() : this.leave(),
      );
      if (!session.busy && !applying) {
        button('chat-send', 'Enter', this.focus === 'input' ? 'Send' : 'Type message', () =>
          this.focus === 'input' ? this.send() : this.focusInput(),
        );
        button('chat-focus', 'Tab', this.focus === 'input' ? 'Conversation' : 'Input', () => {
          this.focus = this.focus === 'input' ? 'conversation' : 'input';
          this.redraw();
        });
        button('chat-sources', 'Ctrl+O', 'Sources', () => this.showSources());
        button('chat-more', 'F2', 'More', () => this.openMore());
      }
      if (session.busy) {
        button('chat-details', 'F4', 'Details', () => this.showDetails());
        button('chat-more', 'F2', 'More', () => this.openMore());
        button('chat-leave', 'Ctrl+B', 'Back to inbox', () => this.back());
      }
    }
    const top =
      this.view === 'chat'
        ? this.scrollTop
        : this.view === 'sources'
          ? this.sourceListScroll
          : this.view === 'details'
            ? this.overlayScroll
            : this.sourceScroll;
    const bottom = this.view === 'chat' && this.bottom;
    this.bottom = false;
    const reveal = this.view === 'chat' ? this.revealEntry : undefined;
    this.scrollFrame = () => {
      if (scroll.isDestroyed) return;
      const entry =
        reveal === undefined ? undefined : scroll.findDescendantById(`chat-entry-${reveal}`);
      scroll.scrollTo(entry ? entry.y - scroll.content.y : bottom ? scroll.scrollHeight : top);
      if (entry && this.revealEntry === reveal) {
        this.revealEntry = undefined;
        this.scrollTop = scroll.scrollTop;
      }
      if (this.view === 'sources')
        scroll.scrollChildIntoView(`chat-source-row-${this.sourceIndex}`);
    };
    this.renderer.once('frame', this.scrollFrame);
  }
  key(key: KeyEvent) {
    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    const session = this.session;
    if (this.resetPrompt) {
      consume();
      if (key.name === 'escape') {
        this.resetPrompt = undefined;
        this.redraw();
      } else if (key.name === 'return') void this.confirmReset();
      return;
    }
    if (this.menu) {
      consume();
      if (key.name === 'escape' || key.name === 'f2') {
        this.menu = false;
        this.redraw();
      } else if (key.name === 'return') this.runMore(this.menuIndex);
      else if (['up', 'down'].includes(key.name)) {
        this.menuIndex = Math.max(
          0,
          Math.min(this.moreCommands().length - 1, this.menuIndex + (key.name === 'up' ? -1 : 1)),
        );
        this.redraw();
      }
      return;
    }
    if (key.ctrl && key.name === 'b') {
      consume();
      this.back();
      return;
    }
    if (key.name === 'escape') {
      consume();
      if (this.view !== 'chat') this.leave();
      else if (session.busy) this.stopReply();
      else if (session.proposal?.status === 'pending') session.cancelProposal();
      else this.leave();
      return;
    }
    if (key.ctrl && key.name === 'o') {
      consume();
      this.showSources();
      return;
    }
    if (key.name === 'f4') {
      consume();
      this.showDetails();
      return;
    }
    if (key.name === 'f2') {
      consume();
      this.openMore();
      return;
    }
    if (this.view === 'details') return;
    if (this.view === 'sources') {
      if (['up', 'down', 'home', 'end', 'return'].includes(key.name)) {
        consume();
        const sources = this.citedSources();
        if (key.name === 'return') {
          const source = sources[this.sourceIndex];
          if (source) this.openSource(source.ref);
        } else {
          this.sourceIndex = Math.max(
            0,
            Math.min(
              sources.length - 1,
              key.name === 'home'
                ? 0
                : key.name === 'end'
                  ? sources.length - 1
                  : this.sourceIndex + (key.name === 'up' ? -1 : 1),
            ),
          );
          this.redraw();
        }
      }
      return;
    }
    if (this.view === 'original') {
      if (key.name === 'L' || (key.name === 'l' && key.shift)) {
        consume();
        this.openOriginalLinks();
      }
      return;
    }
    if (session.proposal?.status === 'pending') {
      consume();
      if (key.name === 'return') void this.confirm();
      return;
    }
    if (session.busy || session.proposal?.status === 'applying') return;
    if (key.name === 'f2') {
      consume();
      this.openMore();
    } else if (key.ctrl && key.name === 'n') {
      consume();
      this.resetPrompt = 'new';
      this.redraw();
    } else if (key.ctrl && key.name === 'r') {
      consume();
      this.retry();
    } else if (key.name === 'tab') {
      consume();
      this.focus = this.focus === 'input' ? 'conversation' : 'input';
      this.redraw();
    } else if (key.name === 'return' && this.focus === 'conversation') {
      consume();
      this.focusInput();
    }
  }
}
