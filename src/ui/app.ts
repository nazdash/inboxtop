import { ActivityIndicator } from './activity.ts';
import { type Destination } from '../destinations.ts';
import { menuAvailable } from '../mac-menu.ts';
import { ChatView } from './chat-view.ts';
import { emailLinks, emailURL, linkedEmailText } from './email-links.ts';
import { chatCorpus } from '../chat.ts';
import {
  BoxRenderable,
  TextRenderable,
  TextBuffer,
  TextBufferView,
  SelectRenderable,
  SelectRenderableEvents,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextAttributes,
  type CliRenderer,
  KeyEvent,
} from '@opentui/core';
import { inboxStats, barCells } from '../inbox-stats.ts';
import { CLASSIFIER_MODEL } from '../classification.ts';
import { Controller } from '../controller.ts';
import {
  clean,
  oneLine,
  filterMessages,
  senders,
  safeURL,
  SORTS,
  SORT_LABELS,
  sortMessages,
  type EmailSort,
  type Filter,
  type Message,
  type Scope,
  type SenderGroup,
} from '../domain.ts';
import { configErrors, type Config } from '../config.ts';
import { PERIOD_LABELS, type Period } from '../overview.ts';
import { settingsFrom, installedModels, SettingsSchema, type Settings } from '../settings.ts';
import { testAIConnection } from '../onboarding.ts';
import {
  decisionQueues,
  analysisReady,
  summaryText,
  dashboardSummary,
  outcomeOf,
  OUTCOMES,
  OUTCOME_LABELS,
  OUTCOME_DESCRIPTIONS,
  newsletterGroups,
  NEWSLETTER_SORT_LABELS,
  type NewsletterSort,
  type NewsletterScope,
  NEWSLETTER_SCOPE_LABELS,
  newsletterVerdict,
  type Outcome,
  type NewsletterGroup,
} from '../decisions.ts';
import { LANGUAGE_LABELS } from '../language.ts';
import { layoutFor, MIN_TERMINAL_WIDTH, MIN_TERMINAL_HEIGHT } from './layout.ts';
import { spawn } from 'node:child_process';
import { DARK_COLORS, watchTerminalTheme, type ThemeColors } from './theme.ts';
type Screen =
  | 'chat'
  | 'inbox'
  | 'overview'
  | 'home'
  | 'setup'
  | 'report'
  | 'reader'
  | 'history'
  | 'help'
  | 'link'
  | 'settings'
  | 'digest';
interface ReviewCommand {
  key: string;
  label: string;
  run: () => void;
  disabled?: boolean;
  primary?: boolean;
}
interface Row {
  id: string;
  name: string;
  description: string;
  message?: Message;
  sender?: SenderGroup;
  newsletter?: NewsletterGroup;
  action?: () => void;
}
export class TerminalApp {
  screen: Screen = 'inbox';
  private setupBack: Screen = 'inbox';
  private settingsBack: Screen = 'inbox';
  private historyBack: Screen = 'report';
  tab: 'emails' | 'subscriptions' = 'emails';
  outcome: Outcome = 'act';
  private failedReviews = false;
  newsletterID?: string;
  private newsletterSort: NewsletterSort = 'latest';
  private newsletterScope: NewsletterScope = 'unread';
  private newsletterReturnID?: string;
  private digestBack: Screen = 'home';
  private digestTitle = '';
  private digestText = '';
  private digestGroup?: string;
  sort: EmailSort = 'importance';
  filter: Filter = 'all';
  query = '';
  cursor = 0;
  selected = new Set<string>();
  scope: Scope = { mode: 'unread', limit: 100, order: 'oldest' };
  private frozenIDs?: string[];
  private frozenKey = '';
  private newResults = 0;
  private pane: 'list' | 'reader' = 'list';
  private pinnedReaderID?: string;
  private retainedReadID?: string;
  private retainedNewsletter?: NewsletterGroup;
  private quickReadID?: string;
  private quickReadPending = false;
  private submittingReads = new Set<string>();
  private previewMode: 'summary' | 'original' = 'summary';
  private expandedReasons = new Set<string>();
  private listFraction = 0.4;
  private menuIndex = 0;
  private menuKey?: string;
  private moreActions = false;
  private emailLinkMenu?: string[];
  private modeChanging?: 'adhoc' | 'live';
  private submittingReviews = new Set<string>();
  private reanalysisControl?: { message: Message; text: TextRenderable };
  searching = false;
  customCount = false;
  notice = '';
  period: Period = 'all';
  private draft?: Settings;
  private editingSetting?: 'openaiModel' | 'ollamaModel' | 'ollamaClassifier';
  private settingsEditValue?: string;
  private settingsLeaving: 'back' | 'quit' = 'back';
  private settingsBaseline = '';
  private settingsFocus = 'provider';
  private settingsScroll = 0;
  private settingsAdvanced = false;
  private settingsPicker?: 'provider' | 'language' | 'excerpt' | 'model' | 'discard';
  private settingsModelField?: 'openaiModel' | 'ollamaModel' | 'ollamaClassifier';
  private modelsLoading = false;
  private settingsModelRequest = 0;
  private savingSettings = false;
  private localModels: string[] = [];
  private testingSettings = false;
  private settingsTestStage = 'Testing classification…';
  private settingsAbort = new AbortController();
  private activity = new ActivityIndicator();
  private dashboardActivityNode?: TextRenderable;
  private progressNodes: TextRenderable[] = [];
  private statusNode?: TextRenderable;
  private reviewActivityNode?: TextRenderable;
  private lastReaderID?: string;
  private lastReaderMessage?: Message;
  private lastReadControlState = '';
  private restoreScroll?: () => void;
  private pendingScroll = 0;
  readerID?: string;
  senderID?: string;
  private shell?: BoxRenderable;
  private reader?: ScrollBoxRenderable;
  private list?: SelectRenderable;
  private rows: Row[] = [];
  private returnRowID?: string;
  private readerQueue: string[] = [];
  private confirmation: Message[] = [];
  private chat?: ChatView;
  private link?: string;
  private backFromHelp: Screen = 'home';
  private colors: ThemeColors = DARK_COLORS;
  private stopTheme: () => void;
  private disposed = false;
  private renderQueued = false;
  private listener = () => {
    for (const id of this.submittingReads)
      if (this.controller.pendingReads[id]) this.submittingReads.delete(id);
    this.scheduleRender();
  };
  private keyListener = (key: KeyEvent) => this.key(key);
  private resizeListener = () => this.render();
  constructor(
    readonly renderer: CliRenderer,
    readonly controller: Controller,
    readonly config: Config,
    readonly demo = false,
    readonly onQuit: () => Promise<void> = async () => {},
    readonly onSetup?: () => Promise<void>,
  ) {
    const theme = watchTerminalTheme(renderer, (colors) => {
      this.colors = colors;
      renderer.setBackgroundColor(colors.bg);
      // Keep active native input edits and their caret intact; apply on leaving the editor.
      if (!this.searching && !this.customCount && !this.editingSetting) this.render();
    });
    this.colors = theme.colors;
    this.stopTheme = theme.dispose;
    renderer.setBackgroundColor(this.colors.bg);
    this.chat = new ChatView(
      renderer,
      controller,
      () => {
        if (this.screen === 'chat') this.render();
      },
      () => this.go('inbox'),
      (parent, m) => this.messageContent(parent, m, true),
      (url) => this.openEmailURL(url),
    );
    controller.on('change', this.listener);
    renderer.keyInput.on('keypress', this.keyListener);
    renderer.on('resize', this.resizeListener);
    this.render();
  }
  async flushChat() {
    try {
      await this.chat?.flushBeforeExit();
      return true;
    } catch {
      this.go('chat');
      return false;
    }
  }
  async dispose() {
    await this.chat?.flushBeforeExit();
    this.disposed = true;
    this.activity.dispose();
    this.shell?.destroyRecursively();
    this.chat?.dispose();
    this.stopTheme();
    this.settingsAbort.abort();
    this.controller.off('change', this.listener);
    this.renderer.keyInput.off('keypress', this.keyListener);
    this.renderer.off('resize', this.resizeListener);
    if (this.restoreScroll) this.renderer.off('frame', this.restoreScroll);
  }
  private scheduleRender() {
    if (this.renderQueued || this.disposed) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (this.disposed || this.searching || this.customCount || this.editingSetting) return;
      if (this.screen === 'chat') {
        this.chat?.refreshStatus();
        this.updateActivity();
        return;
      }
      const current =
        this.viewMessages.find((m) => m.id === this.readerID) ??
        this.controller.saved.library?.[this.readerID ?? ''];
      const previous = this.lastReaderMessage;
      const readControlState = `${this.controller.mode}:${this.pane}:${this.controller.mutating}:${this.quickReadPending}:${this.controller.writeProgress?.done ?? ''}/${this.controller.writeProgress?.total ?? ''}:${this.controller.pendingReads[this.readerID ?? ''] ?? ''}:${this.readReceipt(this.quickReadID)?.id ?? ''}`;
      const readerUnchanged =
        readControlState === this.lastReadControlState &&
        ((this.previewMode === 'original' && current?.body === previous?.body) ||
          (current?.classification === previous?.classification &&
            current?.analysis === previous?.analysis)) &&
        current?.error === previous?.error &&
        current?.read === previous?.read &&
        current?.kept === previous?.kept;
      if (
        (this.screen === 'reader' &&
          (this.controller.busy ||
            this.controller.reviewJobs.some((job) => job.state === 'queued') ||
            this.submittingReviews.size > 0) &&
          readerUnchanged &&
          !!this.reviewActivityNode &&
          !this.moreActions) ||
        this.screen === 'settings'
      ) {
        this.updateReanalysisControl();
        if (this.reviewActivityNode) {
          this.reviewActivityNode.content = this.reviewActivityLabel();
          this.reviewActivityNode.fg = this.notice ? this.colors.red : this.colors.muted;
          const context = this.renderer.root.findDescendantById('command-context');
          if (context)
            context.visible = this.renderer.width >= 65 || !this.reviewActivityNode.content;
        }
        const lines = this.progressLines();
        this.progressNodes.forEach((node, i) => {
          node.content = lines[i];
        });
        if (this.statusNode && this.screen !== 'settings')
          this.statusNode.content = ['report', 'reader'].includes(this.screen)
            ? this.reviewStatus()
            : this.notice || this.progress();
        this.updateActivity();
      } else this.render();
    });
  }
  private run(fn: () => Promise<unknown>) {
    this.notice = '';
    void fn().catch((e) => {
      this.notice = clean(e instanceof Error ? e.message : 'Operation failed.');
      this.render();
    });
  }
  private clear(box: BoxRenderable) {
    for (const child of [...box.getChildren()]) {
      box.remove(child);
      child.destroyRecursively();
    }
  }
  private box(
    parent: Pick<BoxRenderable, 'add'>,
    opts: ConstructorParameters<typeof BoxRenderable>[1] = {},
  ) {
    const b = new BoxRenderable(this.renderer, opts);
    parent.add(b);
    return b;
  }
  private text(
    parent: BoxRenderable,
    value: string,
    color = this.colors.text,
    opts: Partial<ConstructorParameters<typeof TextRenderable>[1]> = {},
  ) {
    const t = new TextRenderable(this.renderer, {
      content: clean(value),
      fg: color,
      wrapMode: 'word',
      ...opts,
    });
    parent.add(t);
    return t;
  }
  private get current() {
    return this.rows[Math.min(this.cursor, Math.max(0, this.rows.length - 1))];
  }
  private selectionRows() {
    return this.viewMessages.filter((m) => this.selected.has(m.id) && m.present && !m.read);
  }
  private auditView = false;
  private get isAudit() {
    return this.auditView;
  }
  private get viewMessages() {
    return this.isAudit
      ? this.controller.messages
      : this.tab === 'subscriptions'
        ? this.controller.retainedMessages
        : this.controller.pool;
  }
  private subscriptionGroups() {
    return newsletterGroups(
      this.controller.retainedMessages,
      this.period,
      this.newsletterSort,
      this.newsletterScope,
    );
  }
  private cycleSubscriptionScope() {
    this.newsletterScope = this.newsletterScope === 'unread' ? 'all' : 'unread';
    this.selected.clear();
    this.retainedReadID = undefined;
    this.retainedNewsletter = undefined;
    this.pinnedReaderID = undefined;
    this.pane = 'list';
    this.render();
  }
  private visibleEmails() {
    const candidates = sortMessages(
      filterMessages(
        this.isAudit
          ? this.viewMessages
          : this.failedReviews
            ? this.controller.pool.filter((m) => !!m.error)
            : decisionQueues(this.controller.pool, this.period)[this.outcome],
        this.filter,
        this.query,
      ).filter((m) => !this.senderID || (m.listID || m.address.toLowerCase()) === this.senderID),
      this.sort,
    );
    const key = [
      this.outcome,
      this.sort,
      this.filter,
      this.query,
      this.senderID,
      this.period,
      this.isAudit,
      this.failedReviews,
    ].join(':');
    if (!this.frozenIDs || this.frozenKey !== key) {
      if (this.frozenKey !== key) this.retainedReadID = undefined;
      this.frozenKey = key;
      this.frozenIDs = candidates.map((m) => m.id);
    }
    const ids = new Set(this.frozenIDs);
    const currentIDs = new Set(candidates.map((m) => m.id));
    this.newResults =
      candidates.filter((m) => !ids.has(m.id)).length +
      this.controller.pool.filter((m) => ids.has(m.id) && !currentIDs.has(m.id)).length;
    return this.frozenIDs.flatMap((id) => {
      const m = this.viewMessages.find((m) => m.id === id) ?? this.controller.saved.library?.[id];
      return m &&
        ((m.present && (!m.read || id === this.retainedReadID)) ||
          (this.pane !== 'list' && id === this.pinnedReaderID))
        ? [m]
        : [];
    });
  }
  private reloadResults() {
    this.retainedReadID = undefined;
    this.frozenIDs = undefined;
    this.selected.clear();
    this.pane = 'list';
    this.pinnedReaderID = undefined;
    this.render();
  }
  private toggleMode() {
    this.chooseMode(this.controller.mode === 'live' ? 'adhoc' : 'live');
  }
  private chooseMode(mode: 'adhoc' | 'live') {
    if (
      this.modeChanging ||
      mode === this.controller.mode ||
      this.confirmation.length > 0 ||
      this.quickReadPending ||
      this.controller.mutating ||
      this.customCount ||
      this.editingSetting ||
      this.searching
    )
      return;
    const c = this.controller;
    const missing = this.demo ? [] : configErrors(this.config, true);
    if (mode === 'live' && missing.length) {
      this.notice = 'Setup needed: ' + missing.join(', ');
      this.render();
      return;
    }
    this.modeChanging = mode;
    this.render();
    this.run(async () => {
      try {
        await c.setMode(mode);
      } finally {
        this.modeChanging = undefined;
        this.render();
      }
    });
  }
  render() {
    if (this.disposed) return;
    this.renderContent();
    this.updateActivity();
  }
  private renderContent() {
    this.dashboardActivityNode = undefined;
    this.chat?.capture();
    this.reanalysisControl = undefined;
    this.statusNode = undefined;
    this.reviewActivityNode = undefined;
    // A quick mode update can render twice before the next layout frame.
    const oldScroll = this.restoreScroll ? this.pendingScroll : (this.reader?.scrollTop ?? 0);
    if (this.restoreScroll) this.renderer.off('frame', this.restoreScroll);
    this.restoreScroll = undefined;
    this.lastReadControlState = `${this.controller.mode}:${this.pane}:${this.controller.mutating}:${this.quickReadPending}:${this.controller.writeProgress?.done ?? ''}/${this.controller.writeProgress?.total ?? ''}:${this.controller.pendingReads[this.readerID ?? ''] ?? ''}:${this.readReceipt(this.quickReadID)?.id ?? ''}`;
    const oldReaderID = this.lastReaderID;
    this.progressNodes = [];
    const remembered =
      this.screen === 'report' ? (this.returnRowID ?? this.current?.id) : this.current?.id;
    if (this.screen === 'report') this.returnRowID = undefined;
    if (this.shell) {
      const settingsForm = this.shell.findDescendantById('settings-form') as
        | ScrollBoxRenderable
        | undefined;
      if (settingsForm) this.settingsScroll = settingsForm.scrollTop;
      this.renderer.root.remove(this.shell);
      this.shell.destroyRecursively();
    }
    this.reader = undefined;
    this.list = undefined;
    const root = (this.shell = this.box(this.renderer.root, {
      width: '100%',
      height: '100%',
      backgroundColor: this.colors.bg,
      flexDirection: 'column',
      paddingX: 1,
      paddingTop: this.renderer.height < 24 ? 0 : 1,
    }));
    if (this.renderer.width < MIN_TERMINAL_WIDTH || this.renderer.height < MIN_TERMINAL_HEIGHT) {
      this.text(root, 'inboxtop', this.colors.green, { attributes: TextAttributes.BOLD });
      this.text(
        root,
        'Please resize to at least 40 columns × 18 rows.\nYour work is saved. Press q to quit.',
        this.colors.text,
      );
      return;
    }
    const top = this.box(root, {
      flexDirection: 'row',
      height: 1,
      flexShrink: 0,
      justifyContent: 'space-between',
    });
    const title = this.box(top, { flexDirection: 'column', flexGrow: 1, minWidth: 0 });
    this.text(
      title,
      this.renderer.width < 65
        ? this.screen === 'settings'
          ? 'inboxtop / Settings'
          : 'inboxtop'
        : 'inboxtop  /  ' +
            (this.screen === 'chat'
              ? 'chat'
              : this.screen === 'settings'
                ? 'settings'
                : this.screen === 'inbox'
                  ? 'your inbox'
                  : this.screen === 'home'
                    ? 'review recommendations'
                    : this.screen === 'setup'
                      ? 'choose your scope'
                      : this.screen === 'history'
                        ? 'recent decisions'
                        : this.isAudit
                          ? 'sender audit'
                          : 'inbox review'),
      this.colors.green,
      { attributes: TextAttributes.BOLD, height: 1, wrapMode: 'none' },
    );
    const activeMode =
      this.screen === 'inbox' && this.cursor === 0 && !this.customCount && !this.moreActions;
    const live = this.controller.mode === 'live';
    const modeLabel = live ? '● Live' : 'Ad hoc';
    if (this.demo && this.renderer.width >= 65)
      this.text(top, 'Demo · ', this.colors.muted, { height: 1, flexShrink: 0 });
    this.text(
      top,
      this.modeChanging
        ? ` Switching to ${this.modeChanging === 'live' ? 'Live' : 'Ad hoc'}… `
        : activeMode
          ? ` ‹ ${modeLabel} › `
          : `   ${modeLabel}   `,
      activeMode || live ? this.colors.green : this.colors.muted,
      {
        id: 'app-mode',
        height: 1,
        flexShrink: 0,
        bg: activeMode ? this.colors.raised : undefined,
        attributes: activeMode || live ? TextAttributes.BOLD : undefined,
        onMouseDown:
          this.screen === 'inbox' && !this.customCount
            ? () => {
                if (activeMode) this.toggleMode();
                else {
                  this.cursor = 0;
                  this.render();
                }
              }
            : undefined,
      },
    );
    if (!this.dashboard || this.renderer.height >= 24)
      this.box(root, {
        height: 1,
        flexShrink: 0,
        border: ['bottom'],
        borderColor: this.colors.line,
      });
    const body = this.box(root, {
      width: '100%',
      flexGrow: 1,
      minHeight: 0,
      flexDirection: 'column',
      paddingTop:
        this.renderer.height < 24 ||
        (this.screen === 'report' && this.renderer.height < 30) ||
        ['inbox', 'home'].includes(this.screen)
          ? 0
          : 1,
    });
    if (this.screen === 'chat') {
      this.chat?.render(body, this.colors);
      return;
    }
    if (this.dashboard && this.moreActions) {
      this.text(body, 'Inbox actions', this.colors.text, {
        height: 2,
        flexShrink: 0,
        attributes: TextAttributes.BOLD,
      });
      this.commandMenu(body, this.menuCommands(), Math.max(1, this.renderer.height - 7));
      return;
    }
    if (this.screen === 'inbox') this.inbox(body);
    else if (this.screen === 'home') this.home(body);
    else if (this.screen === 'setup') this.setup(body);
    else if (this.screen === 'overview') this.overview(body);
    else if (this.screen === 'report') this.report(body, remembered);
    else if (this.screen === 'reader') this.fullReader(body);
    else if (this.screen === 'digest') this.digest(body);
    else if (this.screen === 'history') this.history(body);
    else if (this.screen === 'help') this.help(body);
    else if (this.screen === 'link') this.linkReview(body);
    else if (this.screen === 'settings') this.settings(body);
    const currentReaderID =
      this.screen === 'reader'
        ? this.readerID
        : this.screen === 'digest'
          ? `digest:${this.digestGroup ?? this.digestTitle}`
          : (this.current?.message?.id ??
            (this.current?.newsletter ? `newsletter:${this.current.newsletter.id}` : undefined));
    if (currentReaderID && currentReaderID === oldReaderID && oldScroll > 0) {
      // Scroll limits are known after native layout, not during tree construction.
      const reader = this.reader as ScrollBoxRenderable | undefined;
      this.pendingScroll = oldScroll;
      this.restoreScroll = () => {
        this.restoreScroll = undefined;
        if (!this.disposed && this.reader === reader) reader?.scrollTo(oldScroll);
      };
      this.renderer.once('frame', this.restoreScroll);
    }
    this.lastReaderID = currentReaderID;
    if (['report', 'reader'].includes(this.screen) && !this.searching) {
      if (this.confirmation.length) {
        // Capture background mouse input without covering the list visually.
        this.box(root, {
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          zIndex: 100,
          onMouse: (event) => {
            event.preventDefault();
            event.stopPropagation();
          },
        });
      }
      this.reviewDock(root);
      return;
    }
    if (this.screen === 'settings') {
      this.settingsDock(root);
      return;
    }
    const showProgress =
      !['inbox', 'home'].includes(this.screen) &&
      ((this.controller.busy &&
        (!this.controller.newsletterProgress ||
          this.screen !== 'digest' ||
          !!this.currentNewsletterGeneration)) ||
        !!this.controller.writeProgress);
    const compactInbox = this.dashboard && this.renderer.height < 24;
    const foot = this.box(root, {
      flexShrink: 0,
      height:
        this.screen === 'digest' && this.digestGroup
          ? undefined
          : showProgress
            ? 5
            : compactInbox
              ? 1
              : 3,
      flexDirection: 'column',
      paddingTop: compactInbox ? 0 : 1,
    });
    if (showProgress)
      for (const line of this.progressLines())
        this.progressNodes.push(this.text(foot, line, this.colors.green, { height: 1 }));
    if (!compactInbox)
      this.statusNode = this.text(
        foot,
        this.notice || this.progress(),
        this.notice ? this.colors.red : this.colors.muted,
        { height: 1 },
      );
    this.shortcutFooter(foot);
  }
  private updateActivity() {
    const c = this.controller;
    const bind = (node: TextRenderable | undefined, key: string, label: string, elapsed = true) => {
      if (node && label) node.fg = this.colors.muted;
      this.activity.bind(node && label ? { node, key, label, elapsed } : undefined);
    };
    if (this.screen === 'chat') {
      this.activity.bind(this.chat?.activity());
      return;
    }
    if (this.screen === 'settings') {
      bind(
        this.statusNode,
        this.savingSettings ? 'settings-save' : this.settingsTestStage,
        this.testingSettings
          ? this.settingsTestStage
          : this.savingSettings
            ? 'Saving settings…'
            : '',
      );
      return;
    }
    if (this.notice || this.confirmation.length || this.moreActions) {
      this.activity.bind();
      return;
    }
    const review = ['report', 'reader', 'digest'].includes(this.screen);
    const dashboard = this.screen === 'home' || this.screen === 'inbox';
    const node = review
      ? (this.reviewActivityNode ?? this.progressNodes[0])
      : dashboard
        ? (this.dashboardActivityNode ?? this.progressNodes[0] ?? this.statusNode)
        : undefined;
    let key = '';
    let label = '';
    if (c.writeProgress || c.mutating) {
      key = 'mailbox-write';
      label = c.writeProgress
        ? `Marking read · ${c.writeProgress.done}/${c.writeProgress.total}`
        : 'Updating read status…';
    } else if (c.snapshotting || (c.syncing && c.mode !== 'live')) {
      // Routine Live polling is already represented by the persistent Live label.
      if (c.mode !== 'live') {
        key = 'sync';
        label = 'Syncing inbox…';
      }
    } else if (review && this.currentReviewJob && this.currentReviewJob.state !== 'completed') {
      const job = this.currentReviewJob;
      if (job.state === 'running') {
        key = job.id;
        label =
          job.kind === 'email'
            ? 'Re-analyzing…'
            : `Generating summary · ${job.messageIDs.length} issues`;
      }
    } else if (c.reviewJobs.some((job) => job.state === 'running')) {
      const job = c.reviewJobs.find((job) => job.state === 'running')!;
      if (dashboard) {
        key = job.id;
        label = `${job.kind === 'email' ? 'Re-analyzing' : 'Generating summary'} · ${job.label}`;
      }
    } else if (c.newsletterProgress) {
      if (dashboard || (review && this.currentNewsletterGeneration)) {
        key = `summary:${c.newsletterProgress.messageIDs.join(',')}`;
        label = dashboard
          ? `Generating summary · ${c.newsletterProgress.sender}`
          : `Generating summary · ${c.newsletterProgress.messageIDs.length} issues`;
      }
    } else if (c.busy && (!dashboard || c.mode !== 'live' || c.progress.total > 0)) {
      key = 'analysis';
      label = review
        ? this.reviewActivityLabel()
        : this.dashboardActivityNode
          ? `Analyzing ${c.progress.resolved}/${c.progress.total}`
          : this.progressLines()[0];
    }
    if (label && node) {
      if (node === this.dashboardActivityNode && c.busy && !c.writeProgress) label += ' · p Stop';
      bind(node, key, label);
    } else if (c.summaryBusy && dashboard) {
      bind(
        this.renderer.root.findDescendantById('inbox-summary-refresh') as
          | TextRenderable
          | undefined,
        'inbox-summary',
        'Updating…',
        false,
      );
    } else this.activity.bind();
  }
  private emailReviewState(id: string) {
    const job = this.controller.reviewJob('email', [id]);
    return job?.state === 'queued' || job?.state === 'running'
      ? job.state
      : this.submittingReviews.has(id)
        ? 'submitting'
        : undefined;
  }
  private get currentReviewJob() {
    const group =
      this.screen === 'digest'
        ? this.subscriptionGroups().find((g) => g.id === this.digestGroup)
        : this.tab === 'subscriptions' && !this.reviewMessage
          ? this.current?.newsletter
          : undefined;
    if (group)
      return this.controller.reviewJob(
        'newsletter',
        group.messages.map((m) => m.id),
      );
    const message = this.reviewMessage;
    return message ? this.controller.reviewJob('email', [message.id]) : undefined;
  }
  private newsletterLabel(ids: string[]) {
    if (this.controller.newsletterGenerating(ids)) return 'Generating…';
    if (this.controller.reviewJob('newsletter', ids)?.state === 'queued') return 'Queued';
    return this.controller.newsletterDigest(ids) ? 'Summary saved' : 'Generate summary';
  }
  private get currentNewsletterGeneration() {
    const group =
      this.screen === 'digest'
        ? this.subscriptionGroups().find((g) => g.id === this.digestGroup)
        : this.tab === 'subscriptions' && !this.isAudit
          ? (this.subscriptionGroups().find((g) => g.id === this.newsletterID) ??
            this.current?.newsletter)
          : undefined;
    return group && this.controller.newsletterGenerating(group.messages.map((m) => m.id))
      ? this.controller.newsletterProgress
      : undefined;
  }
  private progressLines(): string[] {
    if (this.controller.snapshotting)
      return ['Connecting to IMAP…', 'Taking a fresh snapshot · total not known yet'];
    const writes = this.controller.writeProgress;
    if (writes) {
      const fill = writes.total ? Math.floor((writes.done / writes.total) * 12) : 0;
      return [
        `Marking read ${'━'.repeat(fill)}${'─'.repeat(12 - fill)} ${writes.done}/${writes.total}`,
        `${writes.verified} changes verified · ${writes.done - writes.verified} skipped / unconfirmed`,
      ];
    }
    if (this.controller.newsletterProgress)
      return [
        this.currentNewsletterGeneration
          ? 'Generating summary…'
          : `Generating summary · ${this.controller.newsletterProgress.sender}`,
        'Combining saved issue summaries',
      ];
    const review = this.controller.reviewJobs.find(
      (job) => job.state === 'running' && job.kind === 'email',
    );
    if (review) return ['Re-analyzing email…', review.label];
    const p = this.controller.progress;
    const bar = (value: number, total = p.total) => {
      const filled = total ? Math.min(12, Math.floor((value / total) * 12)) : 0;
      return '━'.repeat(filled) + '─'.repeat(12 - filled);
    };
    if (this.renderer.width < 65)
      return [
        `Analyzing ${p.resolved}/${p.total} ${bar(p.resolved)}`,
        `Classified ${p.classified} · Deep ${p.summaries}/${p.summariesNeeded}`,
      ];
    return [
      `Analyzing batch ${bar(p.resolved)} ${p.resolved}/${p.total} complete`,
      `Classified ${p.classified}/${p.total} · Summaries ${p.summaries}/${p.summariesNeeded} · Fetched ${p.fetched}/${p.total}`,
    ];
  }
  private progress() {
    if (this.modeChanging)
      return `Switching to ${this.modeChanging === 'live' ? 'Live' : 'Ad hoc'}…`;
    if (this.controller.syncError) return oneLine(this.controller.status);
    if (this.screen === 'inbox' || (this.screen === 'home' && this.controller.mode === 'live'))
      return (
        this.notice ||
        (this.current?.id === 'mode'
          ? this.controller.mode === 'live'
            ? this.renderer.width < 65
              ? 'Live · all unread, in the background.'
              : 'Live · analyzes all unread and new mail in the background.'
            : this.renderer.width < 65
              ? 'Ad hoc · choose batches to analyze.'
              : 'Ad hoc · analyze batches you choose, when you start them.'
          : '') ||
        (this.controller.summaryBusy
          ? 'Updating inbox summary from saved findings…'
          : this.controller.summaryError
            ? 'Summary unavailable; showing saved findings. ' + this.controller.summaryError
            : this.controller.mode === 'live'
              ? 'Live continues when this terminal closes. Only your read/unread actions change the mailbox.'
              : 'Choose more mail to analyze, or review saved recommendations.')
      );
    if (this.screen === 'setup' && this.scope.mode === 'unread')
      return 'Completed emails do not count.';
    if (this.screen === 'setup')
      return 'Start review begins analysis. Only your read/unread actions change the mailbox.';
    if (this.controller.newsletterProgress && ['report', 'reader', 'digest'].includes(this.screen))
      return this.currentNewsletterGeneration ? 'Generating summary…' : '';
    const s = this.controller.session;
    if (!s)
      return 'u Update inbox · analysis only; only your read/unread actions change the mailbox.';
    if (
      !this.demo &&
      !this.controller.busy &&
      s.scope.mode === 'unread' &&
      (s.model !== this.config.model || s.provider !== this.config.provider)
    )
      return `Saved: ${s.model} · n starts a new review with ${this.config.model}`;
    if (this.controller.stages.size) return 'Analyzing emails · you can keep reviewing';
    const status = oneLine(this.controller.status);
    if (/^(Saved report ready|Saved results loaded|Report ready|Review ready)/.test(status)) {
      const stats = inboxStats(this.controller);
      const ready = stats.ready;
      return `${ready} ready to review${stats.failed ? ` · ${stats.failed} could not be analyzed` : ''}${this.controller.mode === 'live' ? ' · Watching for new mail' : ''}`;
    }
    const marked = /^(\d+) marked read · (\d+) skipped or unconfirmed\./.exec(status);
    if (marked)
      return `${marked[1]} marked read${Number(marked[2]) ? ` · ${marked[2]} changes not confirmed · h Details` : ''}`;
    return status;
  }
  private screenName(screen: Screen): string {
    if (screen === 'inbox' || screen === 'home') return 'inbox';
    if (screen === 'report')
      return this.failedReviews && !this.isAudit && this.tab === 'emails'
        ? 'failed analyses'
        : this.isAudit && this.tab === 'subscriptions'
          ? 'senders'
          : this.tab === 'subscriptions' && !this.newsletterID
            ? 'subscriptions'
            : 'email list';
    const names: Partial<Record<Screen, string>> = {
      settings: 'settings',
      setup: 'analysis setup',
      reader: 'email',
      digest: 'summary',
      overview: 'inbox map',
      history: 'history',
      help: 'help',
      link: 'link review',
    };
    return names[screen] ?? 'inbox';
  }
  private backLabel(): string {
    if (this.screen === 'report') {
      if (this.pane !== 'list') return 'Back to list';
      if (this.newsletterID) return 'Back to subscriptions';
      if (this.senderID) return 'Back to senders';
      return 'Back to inbox';
    }
    if (this.screen === 'reader') return 'Back to list';
    if (this.screen === 'settings' && this.settingsPicker) return 'Back to settings';
    const destination =
      this.screen === 'history'
        ? this.historyBack
        : this.screen === 'settings'
          ? this.settingsBack
          : this.screen === 'setup'
            ? this.setupBack
            : this.screen === 'digest'
              ? this.digestBack
              : this.screen === 'help'
                ? this.backFromHelp
                : ['home', 'overview'].includes(this.screen)
                  ? 'inbox'
                  : 'report';
    return `Back to ${this.screenName(destination)}`;
  }
  private clickEscape() {
    // Mouse Back follows exactly the same editor, confirmation and write guards as Esc.
    this.key(
      new KeyEvent({
        name: 'escape',
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: '\x1b',
        raw: '\x1b',
        number: false,
        eventType: 'press',
        source: 'raw',
      }),
    );
  }
  private shortcutFooter(parent: BoxRenderable, hints = this.hints(), showHelp = true) {
    const shortcuts: [string, string][] = hints.split(/ {2,}/).map((hint) => {
      const space = hint.indexOf(' ');
      const key = hint.slice(0, space);
      const label = hint.slice(space + 1);
      return [key, key === 'Esc' && /^back$/i.test(label) ? this.backLabel() : label];
    });
    const wrap = this.screen === 'digest' && !!this.digestGroup;
    const bar = this.box(parent, {
      id: 'shortcut-footer',
      flexDirection: 'row',
      height: wrap ? undefined : 1,
      flexWrap: wrap ? 'wrap' : undefined,
      flexShrink: 0,
      columnGap: 2,
      rowGap: 0,
    });
    const width = this.renderer.width - 2;
    let used = 0;
    const editing = this.searching || this.customCount || this.editingSetting;
    const help = ['?', ['report', 'reader'].includes(this.screen) ? 'Shortcuts' : 'Help'] as [
      string,
      string,
    ];
    // Reserve Settings on overview screens, plus Back and Help, before optional hints.
    const back = shortcuts.find(([key]) => key === 'Esc');
    const settings: [string, string] | undefined =
      !editing && ['inbox', 'home'].includes(this.screen) ? [',', 'Settings'] : undefined;
    const more: [string, string] | undefined =
      !editing && this.dashboard ? [';', 'More'] : undefined;
    const tail = [
      ...(more ? [more] : []),
      ...(settings ? [settings] : []),
      ...(back ? [back] : []),
      ...(showHelp && !editing && this.screen !== 'help' ? [help] : []),
    ];
    const size = ([key, label]: [string, string]) => Bun.stringWidth(key + ' ' + label);
    const reserved = tail.reduce((n, item) => n + size(item) + 2, 0);
    const renderedWidths: number[] = [];
    const add = ([key, label]: [string, string]) => {
      renderedWidths.push(size([key, label]));
      const group = this.box(bar, {
        id:
          key === ','
            ? 'footer-settings'
            : key === 'Esc'
              ? 'footer-back'
              : key === ';'
                ? 'footer-more'
                : `footer-${key}`,
        flexDirection: 'row',
        height: 1,
        flexShrink: 0,
        onMouseDown:
          key === ';'
            ? () => this.openMore()
            : key === '?'
              ? () => {
                  this.backFromHelp = this.screen;
                  this.go('help');
                }
              : key === ','
                ? () => this.openSettings()
                : key === 'Esc'
                  ? () => this.clickEscape()
                  : key === 'p' && this.screen === 'digest'
                    ? () => this.run(() => this.controller.stop())
                    : key === 'g' && this.screen === 'digest' && this.digestGroup
                      ? () => {
                          this.refreshDigest();
                        }
                      : key === 'Enter' && this.screen === 'digest' && this.digestGroup
                        ? () => {
                            const group = this.subscriptionGroups().find(
                              (g) => g.id === this.digestGroup,
                            );
                            if (group) this.openNewsletterIssues(group);
                          }
                        : undefined,
      });
      this.text(group, key, this.colors.green, {
        height: 1,
        bg: this.colors.raised,
        attributes: TextAttributes.BOLD,
      });
      this.text(group, ' ' + label, this.colors.text, { height: 1 });
    };
    if (back) {
      add(back);
      used = size(back);
    }
    for (const shortcut of shortcuts.filter(
      ([key]) => key !== 'Esc' && !(settings && key === ','),
    )) {
      const needed = size(shortcut) + (used ? 2 : 0);
      if (!wrap && used + needed + reserved - (back ? size(back) + 2 : 0) > width) continue;
      add(shortcut);
      used += needed;
    }
    for (const shortcut of tail) if (shortcut !== back) add(shortcut);
    if (wrap) bar.height = this.controlRows(renderedWidths);
  }

  private hints() {
    if (this.searching || this.customCount || this.editingSetting)
      return 'Enter apply   Esc cancel';
    if (this.screen === 'inbox' && this.current?.id === 'mode' && this.renderer.width < 65)
      return '←→ Mode  Enter Switch';
    if (this.screen === 'inbox' && this.current?.id === 'mode')
      return '← Ad hoc  → Live  Enter Switch  ↓ Continue';
    if (this.screen === 'inbox' && this.renderer.width < 65) return 'Enter Choose  ↑↓ Move  m Mode';
    if (this.screen === 'inbox')
      return this.renderer.width < 80
        ? '↑↓/Tab Move  Enter Select  v Summary  m Mode  q Close'
        : '↑↓/Tab Move  Enter Select  v Summary  m Mode  , Settings  q Close';
    if (this.screen === 'home' && this.renderer.width < 65)
      return '1–4 Open  l Subscriptions  Esc Back';
    if (this.screen === 'home')
      return this.renderer.width < 80
        ? `1–4 Review  ${this.controller.busy ? 'p Stop' : 'u Sync inbox'}  l Subscriptions  i Map  , Settings  Esc Back`
        : this.controller.busy
          ? '1–4 review  p Stop  l Subscriptions  i Inbox map  , Settings  Esc Back'
          : '1–4 review  u Sync inbox  l Subscriptions  i Inbox map  , Settings  Esc Back';
    if (this.screen === 'digest' && this.digestGroup) {
      const group = this.subscriptionGroups().find((g) => g.id === this.digestGroup);
      const missing = group && !this.controller.newsletterDigest(group.messages.map((m) => m.id));
      return `${this.controller.busy ? 'p Stop  ' : ''}Enter Open issues  ${missing ? `g ${this.newsletterLabel(group!.messages.map((m) => m.id))}  ` : ''}↑↓ Scroll  Esc Back`;
    }
    if (this.screen === 'digest' || this.screen === 'help' || this.screen === 'overview')
      return '↑↓ scroll   Esc back   q quit';
    if (this.screen === 'settings') return 'Enter edit / choose   Esc back';
    if (this.screen === 'link') return 'Enter open destination   Esc cancel';
    if (this.screen === 'setup' && this.scope.mode === 'unread')
      return 'Enter Choose  ←→ Adjust  ↑↓ Move  Esc Back';
    if (this.screen === 'setup') return '↑↓ Move  Enter Choose  c Custom count  Esc Back';
    return '↑↓ move   Enter choose   Esc back   q quit';
  }
  private select(
    parent: BoxRenderable,
    rows: Row[],
    onOpen: (row: Row) => void,
    remember?: string,
  ) {
    this.rows = rows;
    const index = remember ? rows.findIndex((r) => r.id === remember) : -1;
    if (index >= 0) this.cursor = index;
    this.cursor = Math.max(0, Math.min(this.cursor, rows.length - 1));
    if (!rows.length) {
      this.text(
        parent,
        this.query
          ? 'No matches. Press / to change your search.'
          : this.tab === 'subscriptions' && !this.isAudit && this.screen === 'report'
            ? this.newsletterScope === 'unread'
              ? 'No analyzed unread subscriptions. Press t to show all analyzed.'
              : 'No saved analyzed subscriptions yet.'
            : 'Nothing here. New results appear as analysis progresses.',
        this.colors.muted,
      );
      return;
    }
    const list = (this.list = new SelectRenderable(this.renderer, {
      width: '100%',
      flexGrow: 1,
      minHeight: 1,
      backgroundColor: this.colors.bg,
      focusedBackgroundColor: this.colors.bg,
      textColor: this.colors.text,
      focusedTextColor: this.colors.text,
      selectedBackgroundColor: this.colors.raised,
      selectedTextColor:
        this.screen === 'report' && !this.isAudit
          ? {
              act: this.colors.amber,
              read: this.colors.blue,
              clear: this.colors.green,
              check: this.colors.red,
            }[this.outcome]
          : this.colors.green,
      descriptionColor: this.colors.muted,
      selectedDescriptionColor: this.colors.text,
      showDescription:
        this.screen === 'report' || this.renderer.height < 24
          ? false
          : this.screen === 'inbox'
            ? this.renderer.height >= 34 && !this.controller.busy
            : this.screen === 'setup'
              ? this.renderer.height >= 24
              : this.screen !== 'home' ||
                layoutFor(this.renderer.width, this.renderer.height, this.controller.busy)
                  .showDescriptions,
      showScrollIndicator: true,
      showSelectionIndicator: this.screen !== 'report',
      wrapSelection: false,
      itemSpacing:
        this.renderer.height < 24 || ['inbox', 'home', 'setup', 'report'].includes(this.screen)
          ? 0
          : 1,
      selectedIndex: this.cursor,
      options: rows.map((r) => ({
        name: ['report', 'home'].includes(this.screen) ? clean(r.name) : oneLine(r.name),
        description: oneLine(r.description),
        value: r.id,
      })),
      keyBindings: [
        { name: 'j', action: 'move-down' },
        { name: 'k', action: 'move-up' },
      ],
      onMouseDown: (event) => {
        if (this.screen !== 'report' || event.button !== 0 || !this.list) return;
        // Core 0.6 Select centers the selected row; each report option is one cell high.
        const visible = Math.max(1, Math.floor(this.list.height));
        const offset = Math.max(
          0,
          Math.min(this.cursor - Math.floor(visible / 2), rows.length - visible),
        );
        const index = offset + Math.floor(event.y - this.list.y);
        if (index < 0 || index >= rows.length) return;
        this.pane = 'list';
        this.list.setSelectedIndex(index);
        this.pinnedReaderID = undefined;
        this.list.focus();
        this.scheduleRender();
      },
      onMouseScroll: (event) => {
        if (this.screen !== 'report' || !this.list) return;
        if (event.scroll?.direction === 'up') this.list.moveUp();
        else if (event.scroll?.direction === 'down') this.list.moveDown();
      },
    }));
    parent.add(list);
    list.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
      this.pane = 'list';
      this.cursor = index;
      if (this.current?.id !== this.retainedReadID) this.retainedReadID = undefined;
      this.readerID = this.current?.message?.id;
      this.updateReader();
      if (this.screen === 'report') this.scheduleRender();
    });
    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const row = this.current;
      if (row) onOpen(row);
    });
    list.focus();
  }
  private briefingContent(parent: BoxRenderable, value: string) {
    const headings =
      /^(ACT|READ|CAN MARK AS READ|CHECK MANUALLY|ДЕЙСТВИЯ|ПРОЧИТАТЬ|МОЖНО ОТМЕТИТЬ ПРОЧИТАННЫМИ|ПРОВЕРИТЬ ВРУЧНУЮ)\s*·\s*\d+$/i;
    for (const line of clean(value).split('\n')) {
      const text = line.trim();
      if (!text) {
        this.box(parent, { height: 1, flexShrink: 0 });
      } else if (headings.test(text)) {
        const color = /^(ACT|CHECK MANUALLY|ДЕЙСТВИЯ|ПРОВЕРИТЬ ВРУЧНУЮ)\s*·/i.test(text)
          ? this.colors.amber
          : this.colors.green;
        this.text(parent, text, color, { attributes: TextAttributes.BOLD, flexShrink: 0 });
      } else if (/^[•-] /.test(text)) {
        const row = this.box(parent, { flexDirection: 'row', flexShrink: 0 });
        this.text(row, '• ', this.colors.muted, { width: 2, flexShrink: 0 });
        this.text(row, text.slice(2), this.colors.text, { flexGrow: 1, flexBasis: 0, minWidth: 0 });
      } else this.text(parent, text, this.colors.text, { flexShrink: 0 });
    }
  }
  private aiSummaryBox(parent: BoxRenderable, title = 'AI Summary') {
    return this.box(parent, {
      flexDirection: 'column',
      flexShrink: 0,
      minWidth: 0,
      border: true,
      borderStyle: 'rounded',
      borderColor: this.colors.muted,
      title: ` ${title} `,
      titleAlignment: 'left',
      backgroundColor: this.colors.panel,
      paddingX: 1,
    });
  }
  private summaryPanel(parent: BoxRenderable, text: string, height = 4) {
    // Measure using the same native word wrapping as the displayed text, including
    // Unicode cell widths. ScrollBox's auto height otherwise fills its entire cap.
    const buffer = TextBuffer.create(this.renderer.widthMethod, this.renderer.nativeScene);
    const view = TextBufferView.create(buffer);
    let lines = 0;
    try {
      view.setWrapMode('word');
      const width = layoutFor(this.renderer.width, this.renderer.height).contentWidth - 4;
      for (const raw of clean(text).split('\n')) {
        const line = raw.trim();
        const bullet = /^[•-] /.test(line);
        buffer.setText(bullet ? line.slice(2) : line);
        lines += Math.max(
          1,
          view.measureForDimensions(width - (bullet ? 2 : 0), 4096)?.lineCount ?? 1,
        );
      }
    } finally {
      view.destroy();
      buffer.destroy();
    }
    const box = new ScrollBoxRenderable(this.renderer, {
      id: 'inbox-summary',
      height: Math.min(height, Math.max(1, lines)),
      flexShrink: 0,
      backgroundColor: this.colors.panel,
      paddingX: 0,
      scrollY: true,
      scrollX: false,
    });
    parent.add(box);
    this.briefingContent(box, text);
  }
  private coverage() {
    const stats = inboxStats(this.controller);
    return `${PERIOD_LABELS[this.period]} · ${stats.ready} ready across your unread inbox · ${stats.unanalyzed ?? '?'} not analyzed`;
  }
  private inbox(parent: BoxRenderable) {
    const c = this.controller;
    const remembered = this.current?.id;
    const queues = decisionQueues(c.pool, this.period);
    const groups = newsletterGroups(c.pool, this.period);
    const rows: Row[] = [
      { id: 'mode', name: 'Mode', description: '', action: () => this.toggleMode() },
    ];
    if (c.mode === 'adhoc' && !c.busy)
      rows.push({
        id: 'new',
        name: 'n New analysis',
        description: 'Choose an additional batch',
        action: () => this.openSetup('unread'),
      });
    else
      rows.push({
        id: 'stop',
        name: 'p Stop analysis',
        description: '',
        action: () =>
          this.executeCommand(this.dashboardCommands().find((command) => command.key === 'p')),
      });
    rows.push(
      ...OUTCOMES.map((outcome, i) => ({
        id: outcome,
        name: `${i + 1} ${OUTCOME_LABELS[outcome]}`,
        description: OUTCOME_DESCRIPTIONS[outcome],
        action: () => this.openOutcome(outcome),
      })),
    );
    rows.push({
      id: 'newsletters',
      name: 'l Subscriptions',
      description: '',
      action: () => this.openNewsletters(),
    });
    rows.push({ id: 'chat', name: 'c Chat', description: '', action: () => this.go('chat') });
    this.rows = rows;
    const index = rows.findIndex((row) => row.id === remembered);
    this.cursor = Math.max(0, Math.min(index < 0 ? this.cursor : index, rows.length - 1));
    const button = (container: BoxRenderable, row: Row, label = row.name) => {
      const active = this.current?.id === row.id;
      const disabled =
        (this.controller.mutating || this.quickReadPending) && ['new', 'stop'].includes(row.id);
      const box = this.box(container, {
        id: `inbox-${row.id}`,
        height: 1,
        flexShrink: 0,
        backgroundColor: active ? this.colors.raised : undefined,
        onMouseDown: () => {
          if (disabled) return;
          this.cursor = rows.indexOf(row);
          row.action?.();
        },
      });
      const text = this.text(
        box,
        `${active ? '▶' : ' '} ${label}`,
        disabled ? this.colors.muted : active ? this.colors.green : this.colors.blue,
        {
          height: 1,
          wrapMode: 'none',
        },
      );
      if ((this.renderer.height < 24 || c.mode === 'live') && row === rows[1])
        this.dashboardActivityNode = text;
    };
    const modeArea = this.box(parent, {
      flexDirection: 'column',
      flexShrink: 0,
      marginBottom: this.sectionGap,
    });
    const operation = rows[1];
    const compactActivity =
      this.renderer.height < 24 && c.mode !== 'live' && (c.busy || !!c.writeProgress);
    if (this.renderer.height < 24 && (this.notice || c.syncError))
      this.statusNode = this.text(modeArea, this.notice || oneLine(c.status), this.colors.red, {
        height: 1,
      });
    else
      button(
        modeArea,
        operation,
        compactActivity
          ? c.writeProgress
            ? `Marking read ${c.writeProgress.done}/${c.writeProgress.total}`
            : `Analyzing ${c.progress.resolved}/${c.progress.total} · p Stop`
          : c.mode === 'live'
            ? '● Live · all unread · p Stop'
            : c.busy
              ? 'Ad hoc · analyzing batch · p Stop'
              : this.renderer.width < 65
                ? 'Ad hoc · n New analysis'
                : `Ad hoc · n New analysis · ${this.scope.limit ?? 'All remaining'} emails · ${this.scope.order} first`,
      );
    this.inboxOverview(
      parent,
      this.period === 'all'
        ? c.inboxSummary
        : dashboardSummary(c.pool, this.period, this.config.analysisLanguage),
    );
    this.dashboardGroups(parent, rows, queues, groups.length);
  }
  private dashboardGroups(
    parent: BoxRenderable,
    rows: Row[],
    queues: ReturnType<typeof decisionQueues>,
    subscriptionCount: number,
  ) {
    const layout = layoutFor(
      this.renderer.width,
      this.renderer.height,
      this.controller.busy && this.controller.mode !== 'live',
    );
    const heading = (title: string, id: string) => {
      const group = this.box(parent, {
        id,
        flexDirection: 'column',
        flexShrink: 0,
        marginTop: layout.sectionGap,
      });
      this.text(group, title, this.colors.text, { height: 1, attributes: TextAttributes.BOLD });
      return group;
    };
    const review = heading(
      this.period === 'all' ? 'REVIEW · unread' : `REVIEW · ${PERIOD_LABELS[this.period]}`,
      'dashboard-review',
    );
    const total = Object.values(queues).reduce((n, emails) => n + emails.length, 0);
    const countWidth = Math.max(3, String(total).length);
    for (const [i, outcome] of OUTCOMES.entries()) {
      const row = rows.find((r) => r.id === outcome)!;
      const count = queues[outcome].length;
      const active = this.current?.id === outcome;
      const box = this.box(review, {
        id: `outcome-${outcome}`,
        flexDirection: 'column',
        flexShrink: 0,
        backgroundColor: active ? this.colors.raised : this.colors.bg,
        onMouseDown: () => {
          this.cursor = rows.indexOf(row);
          row.action?.();
        },
      });
      const line = this.box(box, { flexDirection: 'row', height: 1, flexShrink: 0 });
      this.text(
        line,
        `${active ? '▶' : ' '} ${i + 1} ${OUTCOME_LABELS[outcome].padEnd(21)} `,
        active ? this.colors.green : this.colors.text,
        { height: 1 },
      );
      this.text(
        line,
        `${String(count).padStart(countWidth)}${layout.narrow ? '' : `  ${this.miniBar(count, total, 10)}`}  ${String(total ? Math.round((count / total) * 100) : 0).padStart(3)}%`,
        count === 0 ? this.colors.muted : active ? this.colors.green : this.colors.text,
        { id: `outcome-${outcome}-metrics`, height: 1 },
      );
      if (layout.showDescriptions)
        this.text(box, `  ${OUTCOME_DESCRIPTIONS[outcome]}`, this.colors.muted, { height: 1 });
    }
    for (const item of [
      {
        id: 'newsletters',
        title: 'SUBSCRIPTIONS',
        label: 'Browse subscriptions',
        key: 'l',
        count: subscriptionCount,
        suffix: 'senders',
      },
      {
        id: 'chat',
        title: 'CHAT',
        label: 'Ask your inbox',
        key: 'c',
        count: chatCorpus(this.controller.saved, this.controller.chatScope).length,
        suffix: 'saved',
      },
    ]) {
      const row = rows.find((r) => r.id === item.id)!;
      const active = this.current?.id === item.id;
      const group = heading(item.title, `dashboard-${item.id}`);
      const line = this.box(group, {
        id: `inbox-${item.id}`,
        flexDirection: 'row',
        height: 1,
        flexShrink: 0,
        backgroundColor: active ? this.colors.raised : this.colors.bg,
        onMouseDown: () => {
          this.cursor = rows.indexOf(row);
          row.action?.();
        },
      });
      this.text(
        line,
        `${active ? '▶' : ' '} ${item.key} ${item.label.padEnd(21)} `,
        active ? this.colors.green : this.colors.text,
        { height: 1 },
      );
      this.text(
        line,
        `${String(item.count).padStart(countWidth)}${layout.narrow ? '' : ` ${item.suffix}`} ›`,
        !item.count ? this.colors.muted : active ? this.colors.green : this.colors.text,
        { height: 1 },
      );
    }
  }
  private inboxControls(parent: BoxRenderable, rows: Row[]) {
    const remembered = this.current?.id;
    this.rows = rows;
    const index = rows.findIndex((row) => row.id === remembered);
    this.cursor = Math.max(0, Math.min(index < 0 ? this.cursor : index, rows.length - 1));
    const spacious = this.renderer.width >= 65 && this.renderer.height >= 30;
    const control = (container: BoxRenderable, row: Row) => {
      const active = this.current?.id === row.id;
      const field = row.id === 'count' || row.id === 'order';
      const box = this.box(container, {
        height: 1,
        flexShrink: 0,
        backgroundColor: active ? this.colors.raised : undefined,
        onMouseDown: () => {
          this.cursor = rows.indexOf(row);
          row.action?.();
        },
      });
      this.text(
        box,
        `${active ? '▶' : ' '} ${row.name}${row.id === 'count' && active && this.renderer.width >= 65 ? '  Enter: custom' : ''}`,
        active ? this.colors.green : field ? this.colors.text : this.colors.blue,
        { height: 1, attributes: field ? undefined : TextAttributes.BOLD },
      );
    };
    const actions = rows.filter((row) => row.id === 'start' || row.id === 'stop');
    const section = (title: string, contentRows: number) => {
      const group = this.box(parent, {
        ...(spacious
          ? {
              border: true,
              borderStyle: 'rounded' as const,
              borderColor: this.colors.line,
              title: ` ${title} `,
              titleColor: this.colors.muted,
            }
          : { border: false }),
        paddingX: 1,
        marginTop: spacious ? 1 : 0,
        height: contentRows + (spacious ? 2 : 1),
        flexShrink: 0,
      });
      if (!spacious) this.text(group, title, this.colors.muted, { height: 1, flexShrink: 0 });
      return group;
    };
    let actionParent = parent;
    if (rows.some((row) => row.id === 'count')) {
      const group = section(
        this.renderer.width < 65
          ? 'New analysis · unanalyzed only'
          : 'New analysis · unanalyzed mail only',
        2 + (spacious ? 1 : 0) + (actions.length ? 1 : 0),
      );
      for (const row of rows.filter((row) => row.id === 'count' || row.id === 'order'))
        control(group, row);
      if (spacious)
        this.text(
          group,
          '  ←→ adjust · Enter on batch size for a custom amount',
          this.colors.muted,
          {
            height: 1,
          },
        );
      actionParent = group;
    }
    const actionBar = this.box(actionParent, { flexDirection: 'row', height: 1, flexShrink: 0 });
    for (const row of actions) {
      const slot = this.box(actionBar, { width: row.name.length + 4, height: 1, flexShrink: 0 });
      control(slot, row);
    }
  }
  private miniBar(value: number, total: number, width: number) {
    const fill = total ? Math.min(width, Math.round((value / total) * width)) : 0;
    return '━'.repeat(fill) + '─'.repeat(width - fill);
  }
  private stackedBar(
    parent: BoxRenderable,
    values: number[],
    colors: string[],
    width = Math.max(20, this.renderer.width - 4),
  ) {
    const row = this.box(parent, { flexDirection: 'row', height: 1, flexShrink: 0 });
    const cells = barCells(values, width);
    if (!cells.some(Boolean)) this.text(row, '─'.repeat(width), this.colors.line, { height: 1 });
    cells.forEach((size, i) => {
      if (size)
        this.text(row, '━'.repeat(size), colors[i], { width: size, height: 1, flexShrink: 0 });
    });
  }
  private inboxBar(
    parent: BoxRenderable,
    stats: ReturnType<typeof inboxStats>,
    width = Math.max(20, this.renderer.width - 4),
  ) {
    if (stats.total === null) {
      this.text(
        parent,
        'Coverage unknown · choose a scope and start to check INBOX',
        this.colors.muted,
        {
          height: 1,
          flexShrink: 0,
        },
      );
      return;
    }
    this.stackedBar(
      parent,
      [stats.ready, stats.unanalyzed ?? 0],
      [this.colors.green, this.colors.line],
      width,
    );
  }
  private summarySection(parent: BoxRenderable, text: string) {
    const layout = layoutFor(
      this.renderer.width,
      this.renderer.height,
      this.controller.mode !== 'live' && (this.controller.busy || !!this.controller.writeProgress),
    );
    const period = ['inbox', 'home'].includes(this.screen) ? this.period : 'all';
    const group = this.box(parent, {
      flexDirection: 'column',
      flexShrink: 0,
      marginTop: layout.sectionGap,
    });
    const digest = this.controller.saved.inboxSummary;
    const ready = inboxStats(this.controller).ready;
    const partial = period === 'all' && digest && digest.messageIDs.length < ready;
    const frame = this.aiSummaryBox(
      group,
      `AI SUMMARY${partial && !layout.narrow ? ` · ${digest.messageIDs.length}/${ready}` : ''}`,
    );
    const controls = this.box(frame, {
      position: 'absolute',
      top: -1,
      right: 0,
      paddingX: 1,
      flexDirection: 'row',
      height: 1,
      flexShrink: 0,
      gap: 2,
      backgroundColor: this.colors.panel,
    });
    this.text(controls, 'v Expand', this.colors.muted, {
      onMouseDown: () => this.openDigest('Inbox summary', text),
    });
    if (period === 'all')
      this.text(
        controls,
        this.controller.summaryBusy
          ? 'Updating…'
          : layout.narrow
            ? 'r Refresh'
            : 'r Refresh summary',
        this.colors.muted,
        {
          id: 'inbox-summary-refresh',
          width: this.controller.summaryBusy ? 11 : undefined,
          height: 1,
          wrapMode: 'none',
          onMouseDown: () =>
            this.executeCommand(this.dashboardCommands().find((c) => c.key === 'r')),
        },
      );
    const activity =
      this.controller.mode !== 'live' && (this.controller.busy || !!this.controller.writeProgress);
    const fixedRows =
      (layout.compact ? 1 : 3) + // header
      (layout.compact ? 1 : 3) + // footer
      1 +
      layout.sectionGap + // reserve the same analysis row on both overviews
      3 +
      (activity ? (layout.compact ? 0 : 2) : 0) + // coverage
      9 +
      3 * layout.sectionGap +
      (layout.showDescriptions ? 4 : 0) + // destinations
      2 +
      layout.sectionGap; // summary outline
    const rows = this.dashboard
      ? Math.max(1, Math.min(layout.narrow ? 4 : 6, this.renderer.height - fixedRows))
      : Math.max(1, layout.summaryRows - (layout.compact ? 1 : 0));
    this.summaryPanel(frame, text, rows);
  }
  private inboxOverview(parent: BoxRenderable, summary: string) {
    this.coveragePanel(parent);
    this.summarySection(parent, summary);
  }
  private coveragePanel(parent: BoxRenderable) {
    const c = this.controller;
    const stats = inboxStats(c);
    const compact = this.renderer.height < 24 || this.renderer.width < 65;
    const coverage = this.box(parent, {
      flexDirection: 'column',
      flexShrink: 0,
      backgroundColor: this.colors.panel,
      paddingX: compact ? 0 : 1,
    });
    const heading = this.box(coverage, {
      flexDirection: 'row',
      justifyContent: 'space-between',
      height: 1,
      flexShrink: 0,
    });
    this.text(
      heading,
      `${stats.total ?? '?'} UNREAD${stats.total ? `    ${Math.round((stats.ready / stats.total) * 100)}% analyzed` : ''}`,
      this.colors.green,
      { height: 1, flexShrink: 0, attributes: TextAttributes.BOLD },
    );
    if (!compact)
      this.text(
        heading,
        c.syncing && c.mode !== 'live'
          ? 'Syncing INBOX…'
          : c.saved.inbox
            ? 'Synced ' +
              new Date(c.saved.inbox.at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
            : 'Not synchronized',
        this.colors.muted,
        { height: 1, flexShrink: 0 },
      );
    this.inboxBar(
      coverage,
      stats,
      layoutFor(this.renderer.width, this.renderer.height).contentWidth - (compact ? 0 : 2),
    );
    const legend = this.box(coverage, { flexDirection: 'row', height: 1, flexShrink: 0 });
    this.text(
      legend,
      `${stats.ready} ${this.renderer.width < 65 ? 'ready' : 'ready to review'}`,
      this.colors.green,
      { height: 1 },
    );
    this.text(
      legend,
      stats.failed ? ` · ${stats.failed} failed` : ` · ${stats.unanalyzed ?? '?'} not analyzed`,
      stats.failed ? this.colors.amber : this.colors.muted,
      {
        height: 1,
        onMouseDown: stats.failed ? () => this.openOutcome('check') : undefined,
      },
    );
    if (
      (c.busy || c.writeProgress) &&
      !(this.dashboard && (this.renderer.height < 24 || c.mode === 'live'))
    )
      for (const line of this.progressLines().slice(0, this.renderer.height < 24 ? 1 : undefined))
        this.progressNodes.push(
          this.text(coverage, line, this.colors.muted, { height: 1, flexShrink: 0 }),
        );
  }
  private overview(parent: BoxRenderable) {
    const stats = inboxStats(this.controller);
    const scroll = this.boxReader(parent, 0);
    parent.add(scroll);
    this.reader = scroll;
    this.text(scroll, 'ALL UNREAD · saved inbox map', this.colors.green, {
      attributes: TextAttributes.BOLD,
    });
    this.text(
      scroll,
      `${stats.total ?? 'Unknown'} unread in INBOX · ${stats.unanalyzed ?? '?'} not analyzed.\n${stats.ready} analyzed and waiting for your decision.`,
      this.colors.text,
    );
    this.inboxBar(scroll, stats, Math.max(20, this.renderer.width - 10));
    this.text(
      scroll,
      `Analyzed ${stats.ready}  ·  Not analyzed ${stats.unanalyzed ?? '?'}  ·  Retry ${stats.failed}`,
      this.colors.muted,
    );
    this.text(scroll, 'REVIEW GROUPS', this.colors.green, {
      attributes: TextAttributes.BOLD,
    });
    const colors = [this.colors.amber, this.colors.blue, this.colors.green, this.colors.red];
    OUTCOMES.forEach((outcome, i) => {
      const n = stats.outcomes[outcome];
      this.text(
        scroll,
        `${OUTCOME_LABELS[outcome].padEnd(18)} ${String(n).padStart(5)}${this.renderer.width < 65 ? '' : `  ${this.miniBar(n, stats.reviewable, 20)}`}  ${stats.reviewable ? Math.round((n / stats.reviewable) * 100) : 0}%`,
        n === 0 ? this.colors.muted : colors[i],
      );
    });
    this.text(
      scroll,
      'Pending work is excluded. Check manually includes emails whose analysis failed; those are not counted as analyzed. No mailbox action was taken.',
      this.colors.muted,
    );
    this.text(scroll, 'YOUR CURRENT SELECTION', this.colors.green, {
      attributes: TextAttributes.BOLD,
    });
    const progress = this.controller.progress;
    this.text(
      scroll,
      `${progress.total} selected · ${progress.fetched} fetched · ${progress.classified} classified\n${progress.summaries}/${progress.summariesNeeded} detailed summaries ready · ${progress.failed} retry`,
    );
    this.text(
      scroll,
      `Snapshot: ${stats.snapshotAt ? new Date(stats.snapshotAt).toLocaleString() : 'not available'}. Saved work outside this selection is included above. External mailbox changes appear after Update inbox. Unread results remain saved across batches and restarts.`,
      this.colors.muted,
    );
    scroll.focus();
  }
  private home(parent: BoxRenderable) {
    const queues = decisionQueues(this.viewMessages, this.period);
    if (this.controller.mode === 'live') {
      const error =
        this.notice || (this.controller.syncError ? oneLine(this.controller.status) : '');
      const node = this.text(
        parent,
        error || '● Live · all unread · p Stop',
        error ? this.colors.red : this.colors.muted,
        {
          height: 1,
          flexShrink: 0,
          wrapMode: 'none',
        },
      );
      if (!error) this.dashboardActivityNode = node;
    } else if (
      this.renderer.height < 24 &&
      (this.notice || this.controller.busy || this.controller.writeProgress)
    )
      this.statusNode = this.text(
        parent,
        this.notice || this.progressLines()[0],
        this.notice ? this.colors.red : this.colors.muted,
        { height: 1 },
      );
    this.inboxOverview(
      parent,
      this.period === 'all'
        ? this.controller.inboxSummary
        : dashboardSummary(this.controller.pool, this.period, this.config.analysisLanguage),
    );
    this.rows = OUTCOMES.map((outcome, i) => ({
      id: outcome,
      name: `${i + 1} ${OUTCOME_LABELS[outcome]}`,
      description: OUTCOME_DESCRIPTIONS[outcome],
      action: () => this.openOutcome(outcome),
    }));
    this.rows.push(
      {
        id: 'newsletters',
        name: 'l Subscriptions',
        description: '',
        action: () => this.openNewsletters(),
      },
      { id: 'chat', name: 'c Chat', description: '', action: () => this.go('chat') },
    );
    this.cursor = Math.max(0, Math.min(this.cursor, this.rows.length - 1));
    this.dashboardGroups(
      parent,
      this.rows,
      queues,
      newsletterGroups(this.controller.pool, this.period).length,
    );
    const missing = this.demo ? [] : configErrors(this.config);
    if (missing.length)
      this.text(parent, 'Setup needed: ' + missing.join(', '), this.colors.amber, { height: 1 });
  }
  openDestination(destination: Destination) {
    if (destination === 'subscriptions') this.openNewsletters();
    else if (destination === 'settings') this.openSettings();
    else if (destination === 'inbox' || destination === 'chat') this.go(destination);
    else this.openOutcome(destination);
  }
  private openFailedReviews() {
    this.openOutcome('check');
    this.failedReviews = true;
    this.frozenIDs = undefined;
    this.period = 'all';
    this.render();
  }
  private openOutcome(outcome: Outcome) {
    this.failedReviews = false;
    this.previewMode = 'summary';
    this.auditView = false;
    this.frozenIDs = undefined;
    this.pane = 'list';
    this.pinnedReaderID = undefined;
    this.outcome = outcome;
    this.tab = 'emails';
    this.filter = 'all';
    this.senderID = undefined;
    this.newsletterID = undefined;
    this.query = '';
    this.selected.clear();
    this.sort = 'importance';
    this.go('report');
  }
  private openNewsletters() {
    this.failedReviews = false;
    this.previewMode = 'summary';
    this.pane = 'list';
    this.pinnedReaderID = undefined;
    this.auditView = false;
    this.tab = 'subscriptions';
    this.period = 'all';
    this.newsletterSort = 'latest';
    this.newResults = 0;
    this.newsletterReturnID = undefined;
    this.newsletterID = undefined;
    this.senderID = undefined;
    this.query = '';
    this.selected.clear();
    this.go('report');
  }
  private cyclePeriod() {
    const periods: Period[] = ['all', 'today', 'week'];
    this.period = periods[(periods.indexOf(this.period) + 1) % periods.length];
    this.selected.clear();
    this.cursor = 0;
    this.rows = [];
    this.render();
  }
  private openDigest(title: string, text: string, groupID?: string) {
    this.digestTitle = title;
    this.digestText = text;
    this.digestGroup = groupID;
    this.digestBack = this.screen;
    this.go('digest');
  }
  private digest(parent: BoxRenderable) {
    this.text(
      parent,
      this.digestTitle +
        (this.digestGroup ? ` · ${NEWSLETTER_SCOPE_LABELS[this.newsletterScope]}` : ''),
      this.colors.green,
      {
        height: 2,
        attributes: TextAttributes.BOLD,
      },
    );
    const box = this.boxReader(parent, 0);
    parent.add(box);
    this.reader = box;
    const group = this.digestGroup
      ? this.subscriptionGroups().find((g) => g.id === this.digestGroup)
      : undefined;
    const digest = group
      ? this.controller.newsletterDigest(group.messages.map((m) => m.id))
      : undefined;
    if (group) this.newsletterContent(box, group);
    else if (this.digestGroup)
      this.text(box, 'No unread issues remain for this sender.', this.colors.muted);
    else this.briefingContent(this.aiSummaryBox(box), this.digestText);
    box.focus();
  }
  private refreshAll(monitor: boolean) {
    const missing = this.demo ? [] : configErrors(this.config, true);
    if (missing.length) {
      this.notice = 'Missing configuration: ' + missing.join(', ');
      this.render();
      return;
    }
    if (this.controller.busy || this.controller.mutating || this.quickReadPending) {
      this.notice = 'Stop current work first.';
      this.render();
      return;
    }
    if (monitor) this.controller.startMonitoring(this.config.pollMinutes);
    this.selected.clear();
    this.senderID = undefined;
    this.query = '';
    this.tab = 'emails';
    this.period = 'all';
    this.sort = 'importance';
    this.go('inbox');
    this.run(() => this.controller.refresh());
  }
  private openSettings() {
    this.settingsBack = this.screen;
    this.settingsLeaving = 'back';
    this.draft = settingsFrom(this.config);
    this.settingsBaseline = JSON.stringify(this.draft);
    this.settingsFocus = 'provider';
    this.settingsScroll = 0;
    this.settingsAdvanced = false;
    this.settingsPicker = undefined;
    this.editingSetting = undefined;
    this.notice = '';
    this.go('settings');
  }
  private get settingsDirty() {
    return (
      JSON.stringify(this.draft) !==
      (this.settingsBaseline || JSON.stringify(settingsFrom(this.config)))
    );
  }
  private settingsFields() {
    const d = (this.draft ??= settingsFrom(this.config));
    const model = d.provider === 'openai' ? 'openaiModel' : 'ollamaModel';
    const fields: {
      id: string;
      label: string;
      value: string;
      group?: string;
      help: string;
      run?: () => void;
    }[] = [
      {
        id: 'provider',
        label: 'Provider',
        value: d.provider === 'openai' ? 'OpenAI' : 'Ollama',
        group: 'AI',
        help:
          d.provider === 'openai'
            ? 'Email content is sent to the paid OpenAI API.'
            : 'Local Ollama models. No cloud fallback.',
        run: () => this.openSettingsPicker('provider'),
      },
      {
        id: 'classifier',
        label: 'Classification',
        value: d.provider === 'openai' ? `${CLASSIFIER_MODEL} · fixed` : d.ollamaClassifier,
        help:
          d.provider === 'ollama'
            ? 'Sorts mail. Use a decision model such as Tev1, or a regular text model. Detected automatically.'
            : 'First pass: classifies every email. Important mail gets a detailed review.',
        run: d.provider === 'ollama' ? () => this.openModelPicker('ollamaClassifier') : undefined,
      },
      {
        id: 'model',
        label: 'Detailed review',
        value: d[model],
        help:
          d.provider === 'ollama'
            ? 'Writes summaries and Chat answers. Use a text model such as Qwen; decision models cannot write them.'
            : 'Writes summaries, suggested next steps and Chat answers.',
        run: () => this.openModelPicker(model),
      },
      {
        id: 'language',
        label: 'Analysis language',
        value: LANGUAGE_LABELS[d.analysisLanguage],
        group: 'PREFERENCES',
        help: 'Used for new analysis and summaries. Saved email reviews stay unchanged.',
        run: () => this.openSettingsPicker('language'),
      },
      {
        id: 'advanced',
        label: 'Advanced',
        value: this.settingsAdvanced ? 'Hide' : '',
        help: 'Text sent on the first pass, and mailbox synchronization information.',
        run: () => {
          this.settingsAdvanced = !this.settingsAdvanced;
          this.render();
        },
      },
    ];
    if (process.platform === 'darwin')
      fields.push({
        id: 'menuBar',
        label: 'Show in menu bar',
        group: 'MAC INTEGRATION',
        value: d.menuBarEnabled ? 'On' : 'Off',
        help: this.demo
          ? 'Available in the real app. Demo never launches the companion.'
          : menuAvailable()
            ? 'Native inbox status and Act indicator. Applies on Save; hiding it leaves analysis running.'
            : 'Build the companion first: npm run build:menu. Then reopen Settings.',
        run:
          !this.demo && (menuAvailable() || d.menuBarEnabled)
            ? () => {
                d.menuBarEnabled = !d.menuBarEnabled;
                this.render();
              }
            : undefined,
      });
    if (this.settingsAdvanced)
      fields.push(
        {
          id: 'excerpt',
          label: 'First-pass text',
          value: `${d.triageChars.toLocaleString()} characters`,
          help: 'Less text makes classification lighter; deeper review can read up to 24,000 characters.',
          run: () => this.openSettingsPicker('excerpt'),
        },
        {
          id: 'interval',
          label: 'Mailbox sync',
          value: 'Every 30 seconds · fixed',
          help: 'Unread membership updates in both modes.',
        },
      );
    return fields;
  }
  private settings(parent: BoxRenderable) {
    const d = (this.draft ??= settingsFrom(this.config));
    if (this.editingSetting) {
      const field = this.editingSetting;
      this.text(
        parent,
        field === 'openaiModel'
          ? 'Detailed review · API model ID'
          : `${field === 'ollamaClassifier' ? 'Classification' : 'Detailed review'} · model tag`,
        this.colors.green,
        { attributes: TextAttributes.BOLD },
      );
      this.text(
        parent,
        field === 'openaiModel'
          ? 'API model ID from your account.\nEnter keeps the edit; Save applies it.'
          : 'Use an installed model:tag.\nEnter keeps the edit; Save applies it.',
        this.colors.muted,
        { marginBottom: 1 },
      );
      this.input(parent, 'Model ID or tag', this.settingsEditValue ?? d[field], (value) => {
        const result = SettingsSchema.safeParse({ ...d, [field]: value.trim() });
        if (!result.success) {
          this.notice = 'Use 1–160 letters, digits, or . _ : / -';
          if (this.statusNode) this.statusNode.content = this.notice;
          return;
        }
        d[field] = value.trim();
        this.settingsEditValue = undefined;
        this.editingSetting = undefined;
        this.settingsPicker = undefined;
        this.notice = '';
        this.render();
      });
      return;
    }
    if (this.settingsPicker) {
      const kind = this.settingsPicker;
      const title = {
        provider: 'Choose provider',
        language: 'Analysis language',
        excerpt: 'First-pass text',
        model:
          this.settingsModelField === 'ollamaClassifier'
            ? 'Classification model'
            : 'Detailed review model',
        discard: 'Unsaved changes',
      }[kind];
      this.text(parent, title, this.colors.green, {
        height: 1,
        attributes: TextAttributes.BOLD,
        marginBottom: 1,
      });
      const choose = (apply: () => void) => {
        apply();
        this.settingsPicker = undefined;
        this.notice = '';
        this.render();
      };
      let rows: Row[] = [];
      if (kind === 'provider')
        rows = ['openai', 'ollama'].map((provider) => ({
          id: provider,
          name: `${provider === d.provider ? '● ' : '  '}${provider === 'openai' ? 'OpenAI' : 'Ollama'}`,
          description:
            provider === 'openai'
              ? 'Paid API · email content leaves this device'
              : 'Local models · no cloud fallback',
          action: () =>
            choose(() => {
              d.provider = provider as Settings['provider'];
            }),
        }));
      if (kind === 'language')
        rows = (['en', 'ru'] as const).map((language) => ({
          id: language,
          name: `${d.analysisLanguage === language ? '● ' : '  '}${LANGUAGE_LABELS[language]}`,
          description: 'New reviews and summaries',
          action: () =>
            choose(() => {
              d.analysisLanguage = language;
            }),
        }));
      if (kind === 'excerpt')
        rows = [1500, 3000, 6000].map((chars) => ({
          id: String(chars),
          name: `${d.triageChars === chars ? '● ' : '  '}${chars.toLocaleString()} characters`,
          description: 'Initial classification only',
          action: () =>
            choose(() => {
              d.triageChars = chars;
            }),
        }));
      if (kind === 'model') {
        this.text(
          parent,
          this.modelsLoading ? 'Finding installed models…' : 'Choose a model or enter its tag.',
          this.colors.muted,
          { height: 1 },
        );
        rows = this.localModels.map((model) => ({
          id: model,
          name: `${d[this.settingsModelField!] === model ? '● ' : '  '}${model}`,
          description: '',
          action: () =>
            choose(() => {
              d[this.settingsModelField!] = model;
            }),
        }));
        rows.push(
          {
            id: 'manual',
            name: 'Enter model tag…',
            description: 'Install first: ollama pull MODEL:TAG',
            action: () => {
              this.settingsEditValue = undefined;
              this.editingSetting = this.settingsModelField;
              this.notice = '';
              this.render();
            },
          },
          {
            id: 'reload',
            name: 'Refresh installed models',
            description: 'List models from Ollama',
            action: () => this.loadSettingsModels(),
          },
        );
      }
      if (kind === 'discard') {
        this.text(parent, 'Save your changes or discard them before leaving.', this.colors.muted, {
          marginBottom: 1,
        });
        rows = [
          {
            id: 'keep',
            name: 'Keep editing',
            description: '',
            action: () => {
              this.settingsPicker = undefined;
              this.render();
            },
          },
          {
            id: 'save',
            name: this.settingsLeaving === 'quit' ? 'Save and quit' : 'Save and return',
            description: '',
            action: () => this.saveSettingsDraft(true),
          },
          {
            id: 'discard',
            name: this.settingsLeaving === 'quit' ? 'Discard and quit' : 'Discard changes',
            description: '',
            action: () => {
              this.settingsPicker = undefined;
              this.draft = undefined;
              this.finishSettingsExit();
            },
          },
        ];
      }
      this.select(parent, rows, (row) => row.action?.());
      // Choosers stay compact; descriptions do not push choices off the screen.
      if (this.list) {
        this.list.showDescription = false;
        this.list.itemSpacing = 0;
      }
      return;
    }
    const fields = this.settingsFields();
    const narrow = this.renderer.width < 65;
    const scroll = new ScrollBoxRenderable(this.renderer, {
      id: 'settings-form',
      flexGrow: 1,
      minHeight: 0,
      width: '100%',
      scrollX: false,
      contentOptions: { flexDirection: 'column' },
    });
    parent.add(scroll);
    for (const field of fields) {
      if (field.group)
        this.text(scroll, field.group, this.colors.muted, {
          height: 1,
          marginTop: field.group === 'AI' ? 0 : 1,
          attributes: TextAttributes.BOLD,
        });
      const active = this.settingsFocus === field.id;
      const row = this.box(scroll, {
        id: `setting-${field.id}`,
        flexDirection: narrow ? 'column' : 'row',
        flexShrink: 0,
        backgroundColor: active ? this.colors.raised : undefined,
        onMouseDown: field.run
          ? () => {
              if (this.settingsLocked) return;
              if (active) field.run!();
              else {
                this.settingsFocus = field.id;
                this.render();
              }
            }
          : undefined,
      });
      this.text(
        row,
        `${active ? '▶' : ' '} ${field.label}`,
        active ? this.colors.green : this.colors.muted,
        {
          width: narrow ? '100%' : 23,
          height: 1,
          flexShrink: 0,
        },
      );
      this.text(
        row,
        `${narrow ? '  ' : ''}${field.value}${field.run ? '  ›' : ''}`,
        field.run ? this.colors.text : this.colors.muted,
        {
          flexGrow: narrow ? 0 : 1,
          minWidth: 0,
          wrapMode: 'char',
        },
      );
    }
    const focus = this.settingsFocus;
    this.renderer.once('frame', () => {
      if (this.disposed || this.screen !== 'settings' || scroll.isDestroyed) return;
      scroll.scrollTo(this.settingsScroll);
      scroll.scrollChildIntoView(`setting-${focus}`);
    });
  }
  private get settingsLocked() {
    return this.testingSettings || this.savingSettings;
  }
  private openSettingsPicker(kind: 'provider' | 'language' | 'excerpt' | 'discard') {
    if (this.settingsLocked) return;
    this.settingsPicker = kind;
    this.cursor =
      kind === 'provider'
        ? this.draft?.provider === 'ollama'
          ? 1
          : 0
        : kind === 'language'
          ? this.draft?.analysisLanguage === 'ru'
            ? 1
            : 0
          : kind === 'excerpt'
            ? Math.max(0, [1500, 3000, 6000].indexOf(this.draft!.triageChars))
            : 0;
    this.notice = '';
    this.render();
  }
  private openModelPicker(field: 'openaiModel' | 'ollamaModel' | 'ollamaClassifier') {
    this.settingsModelField = field;
    this.settingsEditValue = undefined;
    this.notice = '';
    if (field === 'openaiModel') {
      this.editingSetting = field;
      this.render();
      return;
    }
    this.settingsPicker = 'model';
    this.localModels = [];
    this.cursor = 0;
    this.render();
    this.loadSettingsModels();
  }
  private loadSettingsModels() {
    if (this.modelsLoading) return;
    this.modelsLoading = true;
    const previousModelChoice = this.localModels.length ? this.current?.id : undefined;
    const request = ++this.settingsModelRequest;
    this.render();
    void (
      this.demo
        ? Promise.resolve(['qwen3.5:4b', 'qwen3.5:9b'])
        : installedModels(
            this.config,
            this.settingsModelField === 'ollamaClassifier' ? 'classification' : 'review',
          )
    )
      .then((models) => {
        if (request !== this.settingsModelRequest || this.disposed) return;
        const selected = previousModelChoice ?? this.draft?.[this.settingsModelField!];
        this.localModels = models;
        const ids = [...models, 'manual', 'reload'];
        if (selected && ids.includes(selected)) this.cursor = ids.indexOf(selected);
        if (this.screen === 'settings' && this.settingsPicker === 'model') {
          this.notice = models.length
            ? ''
            : 'No compatible local models. Install with ollama pull MODEL:TAG.';
        }
      })
      .catch((e) => {
        if (
          request === this.settingsModelRequest &&
          this.screen === 'settings' &&
          this.settingsPicker === 'model'
        )
          this.notice = clean(e instanceof Error ? e.message : 'Could not list Ollama models.');
      })
      .finally(() => {
        if (request !== this.settingsModelRequest || this.disposed) return;
        this.modelsLoading = false;
        if (this.screen === 'settings' && this.settingsPicker === 'model' && !this.editingSetting)
          this.render();
      });
  }
  private saveSettingsDraft(leave = false) {
    if (
      this.settingsLocked ||
      !this.settingsDirty ||
      this.controller.mutating ||
      this.quickReadPending
    )
      return;
    this.savingSettings = true;
    this.notice = '';
    this.render();
    void this.controller
      .saveSettings({ ...this.draft! }, this.config)
      .then(() => {
        this.settingsBaseline = JSON.stringify(this.draft);
        this.notice = 'Settings saved. Existing reviews unchanged.';
        this.settingsPicker = undefined;
        if (leave) this.finishSettingsExit();
      })
      .catch((e) => {
        this.notice = clean(e instanceof Error ? e.message : 'Could not save settings.');
      })
      .finally(() => {
        this.savingSettings = false;
        if (!this.disposed) this.render();
      });
  }
  private testSettingsDraft() {
    if (this.settingsLocked) return;
    this.testingSettings = true;
    this.settingsTestStage = 'Testing classification…';
    this.settingsAbort = new AbortController();
    this.notice = '';
    this.render();
    const d = { ...this.draft! };
    const model = d.provider === 'openai' ? d.openaiModel : d.ollamaModel;
    const start = performance.now();
    void (async () => {
      if (!this.demo)
        await testAIConnection(
          { ...this.config, ...d, model },
          this.settingsAbort.signal,
          undefined,
          (stage) => {
            this.settingsTestStage = stage;
            if (!this.disposed) this.render();
          },
        );
      this.notice = `Test passed · both stages · ${((performance.now() - start) / 1000).toFixed(1)}s · ${this.settingsDirty ? 'not saved' : 'no changes'}`;
    })()
      .catch((e) => {
        this.notice = this.settingsAbort.signal.aborted
          ? 'Test cancelled. Settings unchanged.'
          : clean(e instanceof Error ? e.message : 'Provider test failed.');
      })
      .finally(() => {
        this.testingSettings = false;
        if (!this.disposed) this.render();
      });
  }
  private settingsDock(parent: BoxRenderable) {
    const dock = this.box(parent, {
      id: 'settings-dock',
      flexShrink: 0,
      flexDirection: 'column',
      border: ['top'],
      borderColor: this.colors.line,
    });
    const field = this.settingsFields().find((f) => f.id === this.settingsFocus);
    let help = field?.help ?? '';
    if (this.settingsFocus === 'save')
      help = 'Apply these choices to new work. Saved reviews stay unchanged.';
    if (this.settingsFocus === 'test')
      help =
        this.draft?.provider === 'openai'
          ? 'Two paid API tests with fictional text: classification and review. Does not save.'
          : 'Local fictional tests of classification and review. Does not save.';
    if (this.settingsFocus === 'connection')
      help =
        'Edit email or API credentials securely. Save/discard settings and stop work in Ad hoc first.';
    if (this.settingsPicker === 'provider') help = 'OpenAI: paid API. Ollama: local models.';
    if (this.settingsPicker === 'language') help = 'Applies to new analysis and summaries.';
    if (this.settingsPicker === 'excerpt') help = 'Initial text only; detailed review reads more.';
    if (this.settingsPicker === 'model')
      help =
        this.settingsModelField === 'ollamaClassifier'
          ? 'Decision or text models. Install: ollama pull tev1:4b'
          : 'Text models for summaries and Chat. Decision models are excluded.';
    if (this.settingsPicker === 'discard') help = '';
    if (this.editingSetting) help = '';
    if (help) this.text(dock, help, this.colors.muted, { maxHeight: 3, wrapMode: 'word' });
    const status = this.testingSettings
      ? this.settingsTestStage
      : this.savingSettings
        ? 'Saving settings…'
        : this.notice || (this.settingsDirty ? 'Unsaved changes' : 'No unsaved changes');
    this.statusNode = this.text(
      dock,
      status,
      this.settingsDirty ? this.colors.amber : this.colors.muted,
      {
        maxHeight: 2,
      },
    );
    if (!this.editingSetting && !this.settingsPicker) {
      const buttons = this.box(dock, {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 2,
        flexShrink: 0,
      });
      for (const command of this.settingsActions())
        this.text(
          buttons,
          ` ${command.key} ${command.label} `,
          command.disabled
            ? this.colors.muted
            : this.settingsFocus === command.id
              ? this.colors.green
              : this.colors.text,
          {
            id: `settings-${command.id}`,
            bg: this.settingsFocus === command.id ? this.colors.raised : this.colors.panel,
            height: 1,
            attributes: this.settingsFocus === command.id ? TextAttributes.BOLD : undefined,
            onMouseDown: () => this.runSettingsAction(command.id),
          },
        );
    }
    const verb = ['save', 'test'].includes(this.settingsFocus)
      ? 'Run'
      : this.settingsFocus === 'advanced'
        ? this.settingsAdvanced
          ? 'Hide'
          : 'Show'
        : this.settingsFocus === 'model' && this.draft?.provider === 'openai'
          ? 'Edit'
          : 'Choose';
    this.shortcutFooter(
      dock,
      this.testingSettings
        ? 'Esc Cancel test'
        : this.savingSettings
          ? 'Wait Saving…'
          : this.editingSetting
            ? 'Enter Keep edit  Esc Cancel'
            : this.settingsPicker
              ? 'Enter Choose  ↑↓ Move  Esc Back'
              : `Enter ${verb}  ↑↓ Move  Esc Back`,
      !this.settingsPicker && !this.settingsLocked,
    );
  }

  private settingsActions(): (ReviewCommand & { id: string })[] {
    return [
      {
        id: 'save',
        key: 's',
        label: 'Save changes',
        run: () => this.saveSettingsDraft(),
        disabled:
          !this.settingsDirty ||
          this.settingsLocked ||
          this.controller.mutating ||
          this.quickReadPending,
      },
      {
        id: 'test',
        key: 't',
        label: 'Test provider',
        run: () => this.testSettingsDraft(),
        disabled: this.settingsLocked,
      },
      ...(this.onSetup && !this.demo
        ? [
            {
              id: 'connection',
              key: 'k',
              label: 'Email / API credentials',
              run: () => {
                void this.onSetup!();
              },
              disabled:
                this.settingsLocked ||
                this.settingsDirty ||
                this.controller.busy ||
                this.controller.mutating ||
                this.controller.mode === 'live',
            },
          ]
        : []),
    ];
  }
  private runSettingsAction(id: string) {
    const action = this.settingsActions().find((command) => command.id === id);
    if (action && !action.disabled) action.run();
  }
  private finishSettingsExit() {
    if (this.settingsLeaving === 'quit') void this.onQuit();
    else this.go(this.settingsBack);
  }
  private settingsKey(key: KeyEvent) {
    const name = key.name;
    if (this.settingsLocked) {
      if (name === 'escape' && this.testingSettings) this.settingsAbort.abort();
      return;
    }
    if (name === 'q') {
      this.settingsLeaving = 'quit';
      if (this.settingsDirty) this.openSettingsPicker('discard');
      else this.finishSettingsExit();
      return;
    }
    if (this.settingsPicker) {
      if (name === 'escape') {
        this.settingsPicker = undefined;
        this.settingsModelRequest++;
        this.modelsLoading = false;
        this.notice = '';
        this.render();
      } else if (name === 'return') this.current?.action?.();
      else if (['up', 'down', 'j', 'k', 'tab'].includes(name)) {
        const delta = name === 'up' || name === 'k' || (name === 'tab' && key.shift) ? -1 : 1;
        this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
        this.list?.setSelectedIndex(this.cursor);
      }
      return;
    }
    const fields = this.settingsFields().filter((f) => f.run);
    const actions = this.settingsActions();
    const shortcut = actions.find((command) => command.key === name);
    if (shortcut) {
      this.runSettingsAction(shortcut.id);
      return;
    }
    const ids = [...fields.map((f) => f.id), ...actions.map((command) => command.id)];
    if (['up', 'down', 'j', 'k', 'tab'].includes(name)) {
      const delta = name === 'up' || name === 'k' || (name === 'tab' && key.shift) ? -1 : 1;
      this.settingsFocus = ids[(ids.indexOf(this.settingsFocus) + delta + ids.length) % ids.length];
      this.notice = '';
      this.render();
    } else if (name === 'return' || name === 'right') {
      if (actions.some((command) => command.id === this.settingsFocus))
        this.runSettingsAction(this.settingsFocus);
      else fields.find((f) => f.id === this.settingsFocus)?.run?.();
    } else if (name === 'escape') {
      this.settingsLeaving = 'back';
      if (this.settingsDirty) this.openSettingsPicker('discard');
      else this.go(this.settingsBack);
    } else if (name === '?') {
      this.backFromHelp = 'settings';
      this.go('help');
    }
  }
  private openSetup(mode: Scope['mode']) {
    if (this.controller.busy || this.controller.mutating || this.quickReadPending) {
      this.notice = 'Stop the current work before starting another review.';
      this.render();
      return;
    }
    if (mode === 'unread' && this.controller.mode !== 'adhoc') return;
    this.setupBack = this.screen === 'settings' ? this.settingsBack : 'inbox';
    this.scope =
      mode === 'unread' ? { ...this.scope, mode } : { mode, limit: 100, order: 'oldest' };
    this.go('setup');
  }
  private setup(parent: BoxRenderable) {
    if (this.scope.mode === 'unread') {
      this.text(parent, 'Ad hoc · New analysis', this.colors.green, {
        height: 2,
        attributes: TextAttributes.BOLD,
      });
      this.text(
        parent,
        'Choose additional unanalyzed mail. Saved results stay available.',
        this.colors.muted,
        { marginBottom: 1 },
      );
      if (this.customCount) {
        this.text(parent, 'Batch size · additional emails', this.colors.green);
        this.input(parent, 'Number of emails', String(this.scope.limit ?? 100), (value) => {
          const count = Number(value);
          if (!Number.isSafeInteger(count) || count < 1) {
            this.notice = 'Enter a positive whole number.';
            this.render();
            return;
          }
          this.scope.limit = count;
          this.customCount = false;
          this.render();
        });
        return;
      }
      this.inboxControls(parent, [
        {
          id: 'count',
          name: `Batch size   ‹ ${this.scope.limit === null ? 'All remaining' : `${this.scope.limit} emails`} ›`,
          description: '',
          action: () => {
            this.customCount = true;
            this.render();
          },
        },
        {
          id: 'order',
          name: `Order        ‹ ${this.scope.order === 'oldest' ? 'Oldest' : 'Newest'} first ›`,
          description: '',
          action: () => {
            this.scope.order = this.scope.order === 'oldest' ? 'newest' : 'oldest';
            this.render();
          },
        },
        { id: 'start', name: '[ Start analysis → ]', description: '', action: () => this.start() },
      ]);
      return;
    }

    this.text(parent, 'Sender audit · no AI', this.colors.text, {
      attributes: TextAttributes.BOLD,
      height: 1,
    });
    this.text(
      parent,
      'Counts and sender statistics use all mail in INBOX.\nNo AI or API key required. Read flags stay unchanged.',
      this.colors.muted,
      { height: 2, flexShrink: 0 },
    );
    if (this.customCount) {
      this.input(parent, 'Number of emails', String(this.scope.limit ?? 100), (value) => {
        const count = Number(value);
        if (!Number.isSafeInteger(count) || count < 1) {
          this.notice = 'Enter a positive whole number.';
          this.render();
          return;
        }
        this.scope.limit = count;
        this.customCount = false;
        this.render();
      });
      return;
    }
    this.select(
      parent,
      [
        {
          id: 'count',
          name: `Additional emails: ${this.scope.limit ?? 'All remaining'}`,
          description: 'Enter cycles 50 / 100 / 500 / All · c enters a custom amount',
          action: () => {
            const values = [50, 100, 500, null];
            this.scope.limit = values[(values.indexOf(this.scope.limit) + 1) % values.length];
            this.render();
          },
        },
        {
          id: 'order',
          name: `Start with: ${this.scope.order} mail`,
          description: 'Chooses the messages to fetch, not their review order',
          action: () => {
            this.scope.order = this.scope.order === 'newest' ? 'oldest' : 'newest';
            this.render();
          },
        },
        {
          id: 'start',
          name: 'Build sender audit →',
          description: 'Analyze additional mail; completed results stay in your inbox pool',
          action: () => this.start(),
        },
      ],
      (r) => r.action?.(),
    );
  }
  private start() {
    if (this.scope.mode === 'unread' && this.controller.mode !== 'adhoc') {
      this.go('inbox');
      return;
    }
    const missing = configErrors(this.config, this.scope.mode === 'unread');
    if (!this.demo && missing.length) {
      this.notice = 'Missing configuration: ' + missing.join(', ');
      this.render();
      return;
    }
    this.auditView = this.scope.mode === 'subscriptions';
    this.period = 'all';
    this.newsletterID = undefined;
    this.selected.clear();
    this.senderID = undefined;
    this.query = '';
    this.tab = this.scope.mode === 'unread' ? 'emails' : 'subscriptions';
    this.sort = this.scope.mode === 'unread' ? 'importance' : 'newest';
    this.filter = 'all';
    this.go(this.scope.mode === 'unread' ? 'inbox' : 'report');
    this.run(() => this.controller.start({ ...this.scope }));
  }
  private get sectionGap() {
    return layoutFor(this.renderer.width, this.renderer.height, this.controller.busy).sectionGap;
  }
  private reviewTabs(parent: BoxRenderable) {
    const narrow = this.renderer.width < 65;
    const counts = decisionQueues(this.controller.pool, this.period);
    const bar = this.box(parent, {
      flexDirection: 'row',
      height: narrow ? 2 : 1,
      flexWrap: 'wrap',
      flexShrink: 0,
      marginBottom: this.sectionGap,
    });
    const compact = this.renderer.width < 90;
    OUTCOMES.forEach((outcome, i) => {
      const active = this.tab === 'emails' && this.outcome === outcome;
      const label = narrow
        ? ['Act', 'Read', 'Low', 'Check'][i]
        : compact
          ? ['Act', 'Read', 'Low priority', 'Check'][i]
          : OUTCOME_LABELS[outcome];
      const tab = this.box(bar, {
        height: 1,
        width: narrow ? `${50}%` : undefined,
        flexShrink: 0,
        backgroundColor: active ? this.colors.raised : this.colors.bg,
        onMouseDown: () => this.openOutcome(outcome),
      });
      this.text(
        tab,
        ` ${i + 1} ${label} ${counts[outcome].length} `,
        active
          ? {
              act: this.colors.amber,
              read: this.colors.blue,
              clear: this.colors.green,
              check: this.colors.red,
            }[outcome]
          : this.colors.muted,
        { height: 1, attributes: active ? TextAttributes.BOLD : undefined },
      );
    });
  }
  private rowEmails(row: Row) {
    return row.message ? [row.message] : (row.newsletter?.messages ?? []);
  }
  private toggleSelectedEmail() {
    const message = this.reviewMessage;
    const emails = (message ? [message] : (this.current?.newsletter?.messages ?? [])).filter(
      (m) => m.present && !m.read,
    );
    const deselect = emails.every((m) => this.selected.has(m.id));
    for (const m of emails) deselect ? this.selected.delete(m.id) : this.selected.add(m.id);
    this.render();
  }
  private focusBadge(parent: BoxRenderable, zone: 'list' | 'reader', label: string) {
    const active =
      !this.moreActions && (this.screen === 'reader' ? zone === 'reader' : this.pane === zone);
    this.text(
      parent,
      `${active ? '▶' : ' '} ${label}`,
      active ? this.colors.green : this.colors.muted,
      {
        id: `focus-${zone}`,
        height: 1,
        flexShrink: 0,
      },
    );
  }
  private reviewColumns(
    sender: string,
    subject: string,
    date: string,
    header = false,
    marker = '   ',
  ) {
    const available = Math.max(20, this.renderer.width - 6);
    const narrow = this.renderer.width < 65;
    const senderWidth = Math.min(24, Math.floor(available * (narrow ? 0.32 : 0.24)));
    const dateWidth = narrow ? 0 : 10;
    const subjectWidth = Math.max(8, available - senderWidth - dateWidth - 7);
    const fit = (value: string, width: number) => {
      const text = oneLine(value);
      if (Bun.stringWidth(text) <= width) return text + ' '.repeat(width - Bun.stringWidth(text));
      let result = '';
      for (const { segment } of new Intl.Segmenter().segment(text)) {
        if (Bun.stringWidth(result + segment) > width - 1) break;
        result += segment;
      }
      return result + '…' + ' '.repeat(Math.max(0, width - 1 - Bun.stringWidth(result)));
    };
    return `${header ? ' ' : ''}${marker} ${fit(sender, senderWidth)}  ${fit(subject, subjectWidth)}${narrow ? '' : ` ${fit(header ? date : date.slice(0, 10) || 'Unknown', dateWidth)}`}`;
  }
  private messageRow(message: Message) {
    return this.reviewColumns(
      message.sender,
      this.pendingRead(message.id)
        ? `${this.pendingRead(message.id) === 'updating' ? 'Updating' : 'Queued'} · ${message.subject}`
        : this.emailReviewState(message.id) === 'running'
          ? `Re-analyzing · ${message.subject}`
          : this.emailReviewState(message.id) === 'queued'
            ? `Queued · ${message.subject}`
            : message.subject,
      message.date,
      false,
      this.pendingRead(message.id)
        ? '[…]'
        : this.selected.has(message.id)
          ? '[x]'
          : message.read
            ? '[✓]'
            : '[ ]',
    );
  }
  private get viewToggleLabel() {
    return this.previewMode === 'summary' ? 'Show original' : 'Show review';
  }
  private cycleSort() {
    const sorts: readonly EmailSort[] = this.isAudit ? ['newest', 'oldest'] : SORTS;
    this.sort = sorts[(sorts.indexOf(this.sort) + 1) % sorts.length];
    this.cursor = 0;
    this.rows = [];
    this.render();
  }
  private refreshDigest() {
    const group =
      this.subscriptionGroups().find(
        (g) => g.id === (this.screen === 'digest' ? this.digestGroup : this.newsletterID),
      ) ?? this.current?.newsletter;
    if (group) this.run(() => this.controller.reviewNewsletter(group.messages.map((m) => m.id)));
  }
  private setPreview(mode: 'summary' | 'original') {
    this.previewMode = mode;
    this.reader?.scrollTo(0);
    this.render();
  }
  private expandReader() {
    const row = this.current;
    if (!row?.message) return;
    this.readerID = row.message.id;
    this.returnRowID = row.id;
    this.readerQueue = this.rows.flatMap((r) => (r.message ? [r.message.id] : []));
    this.go('reader');
  }
  private messageSection(parent: BoxRenderable, title: string, color: string, original = false) {
    const section = this.box(parent, {
      flexDirection: 'column',
      flexShrink: 0,
      border: ['left'],
      borderColor: color,
      paddingLeft: 1,
      paddingRight: 1,
      marginTop: this.sectionGap,
      backgroundColor: original ? this.colors.bg : this.colors.panel,
    });
    const heading = this.text(section, title, color, {
      attributes: TextAttributes.BOLD,
      bg: original ? this.colors.bg : this.colors.panel,
    });
    return { section, heading };
  }
  private originalContent(parent: BoxRenderable, message: Message) {
    const { section } = this.messageSection(parent, 'Original email', this.colors.blue, true);
    this.text(
      section,
      `${message.sender} <${message.address}> · ${message.date.slice(0, 10)}`,
      this.colors.muted,
    );
    this.text(section, '', this.colors.text, {
      id: 'original-email-text',
      content: linkedEmailText(message.body || 'No readable text was found.', this.colors.blue),
      selectable: true,
    });
    if (!message.complete)
      this.text(
        section,
        'Incomplete message · some content was not downloaded.',
        this.colors.amber,
      );
  }
  private analysisContent(parent: BoxRenderable, message: Message) {
    const a = message.analysis;
    const c = message.classification;
    if (message.error || (!a && !c)) {
      const { section } = this.messageSection(
        parent,
        message.error ? 'Check manually' : 'Review',
        this.colors.muted,
      );
      this.text(
        section,
        message.error || 'Not reviewed yet.',
        message.error ? this.colors.red : this.colors.muted,
      );
      if (message.error) this.text(section, 'o Original · r Retry analysis', this.colors.muted);
      return;
    }

    const summary = this.aiSummaryBox(parent);
    summary.marginTop = this.sectionGap;
    this.text(summary, summaryText(message));
    if (a?.context) this.text(summary, a.context, this.colors.muted);
    for (const topic of a?.topics ?? []) {
      this.text(summary, topic.title, this.colors.blue, { attributes: TextAttributes.BOLD });
      this.text(summary, topic.summary);
    }
    for (const fact of a?.key_facts ?? []) this.text(summary, '• ' + fact);

    const actionText = a?.action?.trim();
    const meaningfulAction =
      actionText && !/^(read|read email|worth reading|прочитать)[.!]?$/i.test(actionText);
    if (meaningfulAction || a?.deadline || a?.secondary_actions?.length || a?.blockers?.length) {
      const action = this.box(summary, {
        flexDirection: 'column',
        flexShrink: 0,
        marginTop: 1,
      });
      if (meaningfulAction) this.text(action, 'Next step: ' + actionText, this.colors.amber);
      if (a?.deadline) {
        const absolute = /\b(\d{4}-\d{2}-\d{2})\b/.exec(a.deadline)?.[1];
        const passed = absolute && new Date(absolute + 'T23:59:59').getTime() < Date.now();
        this.text(
          action,
          'When: ' +
            a.deadline +
            (passed
              ? ' · date has passed; verify in your email client'
              : ' · as stated in the email; verify the date'),
          this.colors.amber,
        );
      }
      for (const task of a?.secondary_actions ?? [])
        this.text(action, '• ' + task, this.colors.amber);
      for (const blocker of a?.blockers ?? [])
        this.text(action, 'Needs: ' + blocker, this.colors.amber);
    }

    if (!message.complete || a?.uncertain || (!a && c && !c.complete))
      this.text(
        summary,
        outcomeOf(message) === 'check'
          ? 'Next step unclear · inspect the original.'
          : !message.complete || (a?.coverage && a.coverage.characters < a.coverage.total)
            ? 'Partial review · some email content was not analyzed.'
            : 'Some details remain uncertain · see the explanation.',
        this.colors.amber,
      );
    if (message.error) this.text(summary, message.error, this.colors.red);

    const expanded = this.expandedReasons.has(message.id);
    if (!expanded) return;
    const { section: details } = this.messageSection(parent, 'Details', this.colors.muted);
    this.text(details, 'Recommendation: ' + OUTCOME_LABELS[outcomeOf(message)], this.colors.green);
    this.text(
      details,
      'Why: ' + (a?.reason || c?.reason || 'Needs manual inspection.'),
      this.colors.muted,
    );
    if (a?.recommendation_reason && a.recommendation_reason !== a.reason)
      this.text(details, a.recommendation_reason, this.colors.muted);
    const coverage = a?.coverage;
    if (coverage)
      this.text(
        details,
        `${coverage.stage === 'triage' ? 'Quick check' : 'Deep review'} · ${coverage.characters}/${coverage.total} characters${coverage.characters < coverage.total ? ' · excerpt only' : ''}`,
        this.colors.muted,
      );
    else if (c)
      this.text(
        details,
        `Classification · ${c.model} · ${c.characters}/${c.total} characters`,
        this.colors.muted,
      );

    if (a?.evidence.length) {
      const { section: quotes } = this.messageSection(
        parent,
        'Quoted evidence',
        this.colors.blue,
        true,
      );
      for (const quote of a.evidence) this.text(quotes, '“' + quote + '”', this.colors.muted);
    }
  }
  private toggleRecommendation(message: Message) {
    if (this.isAudit || (!message.analysis && !message.classification)) return;
    if (this.expandedReasons.has(message.id)) this.expandedReasons.delete(message.id);
    else this.expandedReasons.add(message.id);
    if (this.previewMode === 'original') {
      this.previewMode = 'summary';
      this.reader?.scrollTo(0);
    }
    this.render();
  }
  private previewContent(parent: BoxRenderable, message: Message) {
    this.lastReaderMessage = { ...message };
    if (this.previewMode === 'original' || this.isAudit) this.originalContent(parent, message);
    else this.analysisContent(parent, message);
  }
  private viewControls(parent: BoxRenderable, keys: string[], id: string) {
    const bar = this.box(parent, {
      id,
      flexDirection: 'row',
      flexWrap: 'wrap',
      flexShrink: 0,
      columnGap: 2,
    });
    const commands = this.reviewCommands();
    for (const key of keys) {
      const command = commands.find((c) => c.key === key);
      if (!command) continue;
      const control = this.box(bar, {
        id: `command-${key}`,
        flexDirection: 'row',
        height: 1,
        flexShrink: 0,
        onMouseDown: (event) => {
          event.stopPropagation();
          this.executeCommand(command);
        },
      });
      this.text(control, key, command.disabled ? this.colors.muted : this.colors.green, {
        height: 1,
        attributes: TextAttributes.BOLD,
      });
      this.text(
        control,
        ' ' + command.label,
        command.disabled ? this.colors.muted : this.colors.text,
        { height: 1 },
      );
    }
    if (id === 'view-controls') {
      const visible = commands.filter((c) => keys.includes(c.key));
      bar.width =
        visible.reduce((width, c) => width + c.key.length + c.label.length + 1, 0) +
        Math.max(0, visible.length - 1) * 2;
    }
    return bar;
  }
  private previewTitle() {
    const message = this.reviewMessage;
    const label =
      message && this.emailReviewState(message.id)
        ? this.emailReviewState(message.id) === 'running'
          ? 'Re-analyzing…'
          : this.emailReviewState(message.id) === 'queued'
            ? 'Re-analysis queued'
            : 'Requesting review…'
        : this.current?.newsletter && this.screen === 'report'
          ? 'Combined summary'
          : this.isAudit || this.previewMode === 'original'
            ? 'Original'
            : 'Review';
    if (this.renderer.width < 65 && this.screen === 'report')
      return `${this.pane === 'reader' && !this.moreActions ? '▶' : ' '} ${label}`;
    return `${(this.pane === 'reader' && !this.moreActions) || this.screen === 'reader' ? '▶' : ' '} ${label} · ${message?.subject ?? this.current?.newsletter?.name ?? this.current?.sender?.name ?? 'Choose an email'}`;
  }
  private report(parent: BoxRenderable, remember?: string) {
    if (this.tab === 'emails') this.visibleEmails();
    const newsletters = !this.isAudit && this.tab === 'subscriptions';
    const groups = newsletters ? this.subscriptionGroups() : [];
    const retainedGroup =
      this.newsletterScope === 'unread' &&
      this.retainedReadID &&
      this.retainedNewsletter?.id === this.newsletterID
        ? this.retainedNewsletter
        : undefined;
    const group = retainedGroup
      ? {
          ...retainedGroup,
          messages: retainedGroup.messages.filter(
            (m) => m.present && (!m.read || m.id === this.retainedReadID),
          ),
        }
      : groups.find((g) => g.id === this.newsletterID);
    if (newsletters && this.newsletterID && !group) this.newsletterID = undefined;
    if (!this.isAudit && !newsletters) {
      if (this.failedReviews)
        this.text(parent, 'Analysis failed', this.colors.amber, {
          height: 1,
          flexShrink: 0,
          marginBottom: this.sectionGap,
        });
      else this.reviewTabs(parent);
    }
    if (this.isAudit)
      this.text(parent, 'Sender statistics · no AI', this.colors.green, {
        height: 1,
        flexShrink: 0,
        attributes: TextAttributes.BOLD,
      });
    if (this.searching) {
      this.input(parent, 'Search sender or subject', this.query, (v) => {
        this.query = v;
        this.searching = false;
        this.selected.clear();
        this.cursor = 0;
        this.render();
      });
      return;
    }
    if (newsletters || this.query)
      this.text(
        parent,
        this.query
          ? `Search: ${this.query}`
          : group
            ? `${group.name} · ${group.messages.length} issues`
            : 'Subscriptions · saved analyzed mail',
        this.colors.muted,
        { height: 1, flexShrink: 0 },
      );
    if (newsletters) {
      const scope = this.box(parent, {
        id: 'subscription-scope',
        flexDirection: 'row',
        height: 1,
        flexShrink: 0,
        columnGap: 1,
      });
      this.text(scope, 't Show:', this.colors.muted, { height: 1 });
      for (const value of ['unread', 'all'] as const) {
        const active = this.newsletterScope === value;
        this.text(
          scope,
          ` ${NEWSLETTER_SCOPE_LABELS[value]} `,
          active ? this.colors.green : this.colors.muted,
          {
            id: `subscription-scope-${value}`,
            height: 1,
            flexShrink: 0,
            attributes: active ? TextAttributes.BOLD : undefined,
            bg: active ? this.colors.raised : undefined,
            onMouseDown: () => {
              if (!active) this.executeCommand(this.reviewCommands().find((c) => c.key === 't'));
            },
          },
        );
      }
    }
    const listControls = this.box(parent, { flexDirection: 'column', flexShrink: 0 });
    let previewHeading: TextRenderable | undefined;
    let previewHeader: BoxRenderable | undefined;
    const stacked = layoutFor(this.renderer.width, this.renderer.height).splitPreview;
    const split = this.box(parent, { flexDirection: 'column', flexGrow: 1, minHeight: 0 });
    const left = this.box(split, {
      id: 'review-list-pane',
      flexGrow: stacked ? this.listFraction : 1,
      flexBasis: 0,
      minHeight: this.renderer.height < 24 ? 2 : 3,
      flexDirection: 'column',
    });
    const columns = this.box(left, {
      height: 1,
      flexShrink: 0,
      backgroundColor: this.colors.panel,
    });
    this.focusBadge(
      columns,
      'list',
      this.reviewColumns(
        newsletters && !group ? 'Newsletter' : 'Sender',
        newsletters && !group ? 'Issues' : 'Subject',
        newsletters && !group ? 'Latest' : 'Date',
        true,
      ).slice(2),
    );
    if (stacked) {
      const preview = this.box(split, {
        id: 'review-preview-pane',
        flexDirection: 'column',
        flexGrow: 1 - this.listFraction,
        marginTop: this.sectionGap,
        flexBasis: 0,
        minHeight: this.renderer.height < 24 ? 3 : 4,
      });
      const heading = (previewHeader = this.box(preview, {
        height: 1,
        flexShrink: 0,
        flexDirection: 'row',
        columnGap: 2,
        onMouseDown: () => this.focusPane('reader'),
      }));
      previewHeading = this.text(
        heading,
        '',
        this.pane === 'reader' && !this.moreActions ? this.colors.green : this.colors.muted,
        {
          id: 'focus-reader',
          height: 1,
          flexGrow: 1,
          flexBasis: 0,
          flexShrink: 1,
          minWidth: 0,
          wrapMode: 'none',
        },
      );
      this.reader = this.boxReader(preview, 0);
      this.reader.paddingY = 0;
      preview.add(this.reader);
    }
    let rows: Row[];
    if (newsletters && !this.newsletterID) {
      rows = groups
        .filter((g) => (g.name + ' ' + g.address).toLowerCase().includes(this.query.toLowerCase()))
        .map((g) => ({
          id: g.id,
          name: this.reviewColumns(
            g.name,
            `${
              this.controller.newsletterGenerating(g.messages.map((m) => m.id))
                ? 'Generating · '
                : this.controller.reviewJob(
                      'newsletter',
                      g.messages.map((m) => m.id),
                    )?.state === 'queued'
                  ? 'Queued · '
                  : ''
            }${g.messages.filter((m) => m.present && !m.read).length} unread · ${g.messages.length} ${g.messages.length === 1 ? 'issue' : 'issues'}`,
            g.messages[0]?.date ?? '',
            false,
            g.messages.some((m) => this.pendingRead(m.id))
              ? '[…]'
              : g.messages.some((m) => m.present && !m.read) &&
                  g.messages
                    .filter((m) => m.present && !m.read)
                    .every((m) => this.selected.has(m.id))
                ? '[x]'
                : g.messages.some((m) => this.selected.has(m.id))
                  ? '[-]'
                  : '[ ]',
          ),
          description: g.recommendation,
          newsletter: g,
        }));
    } else if (newsletters) {
      rows = sortMessages(group?.messages ?? [], this.sort)
        .filter((m) =>
          (m.subject + ' ' + m.sender).toLowerCase().includes(this.query.toLowerCase()),
        )
        .map((m) => ({
          id: m.id,
          name: this.messageRow(m),
          description: summaryText(m),
          message: m,
        }));
    } else if (this.isAudit && this.tab === 'subscriptions') {
      rows = senders(this.viewMessages)
        .filter((g) => (g.name + ' ' + g.address).toLowerCase().includes(this.query.toLowerCase()))
        .map((g) => ({
          id: g.id,
          name: this.reviewColumns(
            g.name,
            `${g.messages.length} emails · ${g.unread} unread`,
            g.latest,
          ),
          description: `${g.unread} unread · ${g.address}`,
          sender: g,
        }));
    } else
      rows = this.visibleEmails().map((m) => ({
        id: m.id,
        name: this.messageRow(m),
        description: this.isAudit ? (m.read ? 'Read' : 'Unread') : summaryText(m),
        message: m,
      }));
    this.select(
      left,
      rows,
      (row) => {
        if (row.newsletter) {
          this.openNewsletterIssues(row.newsletter);
        } else if (row.sender) {
          this.senderID = row.sender.id;
          this.tab = 'emails';
          this.filter = 'all';
          this.query = '';
          this.selected.clear();
          this.go('report');
        } else if (row.message) {
          if (this.reader && this.screen === 'report') {
            this.focusPane('reader');
            return;
          }
          this.readerID = row.message.id;
          this.controller.prioritize(row.message.id);
          this.returnRowID = row.id;
          this.readerQueue = this.rows.flatMap((r) => (r.message ? [r.message.id] : []));
          this.go('reader');
        }
      },
      remember ?? this.newsletterReturnID,
    );
    this.newsletterReturnID = undefined;
    this.viewControls(
      listControls,
      ['/', 's', 'Backspace', ...(this.newResults ? ['g'] : [])],
      'list-controls',
    );
    if (previewHeading) previewHeading.content = this.previewTitle();
    if (previewHeader)
      this.viewControls(
        previewHeader,
        this.current?.newsletter ? ['v'] : ['o', 'e'],
        'view-controls',
      );
    this.updateReader();
    if (this.pane === 'reader' && this.reader) this.reader.focus();
  }
  private openNewsletterIssues(group: NewsletterGroup) {
    this.newsletterID = group.id;
    this.sort = 'newest';
    this.previewMode = 'original';
    this.query = '';
    this.selected.clear();
    this.go('report');
  }
  private newsletterContent(parent: BoxRenderable, group: NewsletterGroup) {
    parent = this.aiSummaryBox(
      parent,
      `AI Summary · ${group.messages.length} ${this.newsletterScope === 'all' ? 'retained' : 'unread'} issues`,
    );
    const digest = this.controller.newsletterDigest(group.messages.map((m) => m.id));
    if (digest) {
      let paragraph: string[] = [];
      const flushParagraph = () => {
        if (!paragraph.length) return;
        this.text(parent, paragraph.join('\n'), this.colors.text, { marginBottom: 1 });
        paragraph = [];
      };
      for (const line of digest.text.split(/\r?\n/)) {
        // Headings style only their own line, even without a following blank line.
        const heading = /^(?:#{1,6}\s+(.+?)(?:\s+#+)?|\*\*([^*]+)\*\*)$/.exec(line.trim());
        if (heading || !line.trim()) {
          flushParagraph();
          if (heading)
            this.text(parent, heading[1] ?? heading[2], this.colors.text, {
              attributes: TextAttributes.BOLD,
            });
        } else paragraph.push(line);
      }
      flushParagraph();
    } else
      this.text(
        parent,
        this.controller.newsletterGenerating(group.messages.map((m) => m.id))
          ? `Generating summary from ${this.controller.newsletterProgress!.messageIDs.length} saved issues…`
          : this.controller.reviewJob(
                'newsletter',
                group.messages.map((m) => m.id),
              )?.state === 'queued'
            ? 'Summary queued for these issues. It will start after earlier work finishes.'
            : (this.controller.reviewJob(
                'newsletter',
                group.messages.map((m) => m.id),
              )?.detail ??
              'No combined summary yet. Use g Generate summary to combine these saved findings.'),
        this.colors.muted,
      );
    if (group.reviewed < group.messages.length)
      this.text(
        parent,
        `${group.reviewed} full summaries · ${group.messages.length - group.reviewed} quick checks only`,
        this.colors.muted,
      );
    this.text(parent, 'Issues · Enter opens the issue list', this.colors.muted, {
      attributes: TextAttributes.BOLD,
      marginTop: 1,
    });
    for (const message of group.messages) {
      const issue = this.box(parent, { flexDirection: 'column', flexShrink: 0, marginBottom: 1 });
      this.text(issue, `${message.date.slice(0, 10)} · ${message.subject}`, this.colors.blue, {
        attributes: TextAttributes.BOLD,
        onMouseDown: () => this.openNewsletterOriginal(group, message),
      });
      if (!digest) this.text(issue, summaryText(message));
    }
  }
  private openNewsletterOriginal(group: NewsletterGroup, message: Message) {
    this.newsletterID = group.id;
    this.previewMode = 'original';
    this.readerID = message.id;
    this.returnRowID = message.id;
    this.readerQueue = group.messages.map((m) => m.id);
    this.go('reader');
  }
  private openNewsletterDigest(group: NewsletterGroup) {
    this.openDigest(group.name, group.summary, group.id);
  }
  private boxReader(parent: BoxRenderable, gap = 1) {
    return new ScrollBoxRenderable(this.renderer, {
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      minHeight: 0,
      paddingX: this.renderer.width < 65 ? 1 : 2,
      paddingY: 1,
      backgroundColor: this.colors.panel,
      scrollY: true,
      scrollX: false,
      contentOptions: { gap },
      border: this.screen === 'report' ? false : undefined,
      onMouseDown: () => {
        if (this.screen === 'report' || this.screen === 'reader') {
          this.focusReaderFromMouse();
        }
      },
    });
  }
  private updateReader() {
    if (!this.reader || this.screen !== 'report') return;
    // ScrollBox has internal wrapper nodes: only destroy its content children.
    this.clear(this.reader.content);
    const row = this.current;
    if (row?.newsletter) this.newsletterContent(this.reader, row.newsletter);
    else if (row?.message) this.previewContent(this.reader, row.message);
    else if (row?.sender) this.senderContent(this.reader, row.sender);
    else
      this.text(
        this.reader,
        'A report you can act on.\n\nChoose an item to see its details.\nEnter opens the full original.',
        this.colors.muted,
      );
    this.reader.scrollTo(0);
  }
  private messageContent(parent: BoxRenderable, m: Message, original: boolean) {
    this.text(
      parent,
      `${m.sender} <${m.address}>\n${m.date ? new Date(m.date).toLocaleString() : 'Unknown date'}  ·  ${!m.present ? 'No longer in this INBOX' : m.read ? 'READ · removed from unread pool' : 'UNREAD'}`,
      this.colors.muted,
    );
    if (!this.isAudit && !original) this.analysisContent(parent, m);
    else this.originalContent(parent, m);
  }
  private focusPane(pane: 'list' | 'reader') {
    if (pane === 'reader' && !this.reader) {
      const row = this.current;
      if (row?.newsletter) {
        this.openNewsletterDigest(row.newsletter);
        return;
      }
      if (row?.message) {
        this.readerID = row.message.id;
        this.returnRowID = row.id;
        this.readerQueue = this.rows.flatMap((r) => (r.message ? [r.message.id] : []));
        this.go('reader');
      }
      return;
    }
    this.pane = pane;
    if (pane === 'reader') {
      this.pinnedReaderID = this.current?.message?.id;
      this.readerID = this.pinnedReaderID;
      this.readerQueue = this.rows.flatMap((r) => (r.message ? [r.message.id] : []));
    } else if (pane === 'list') this.pinnedReaderID = undefined;
    this.render();
  }
  private focusReaderFromMouse() {
    if (this.pane === 'reader' || this.screen === 'reader') return;
    this.pane = 'reader';
    this.pinnedReaderID = this.current?.message?.id;
    this.readerID = this.pinnedReaderID;
    this.readerQueue = this.rows.flatMap((r) => (r.message ? [r.message.id] : []));
    this.list?.blur();
    this.reader?.focus();
    // Do not destroy the text under a mouse-down: Core is starting a selection.
    for (const zone of ['list', 'reader']) {
      const heading = this.renderer.root.findDescendantById(`focus-${zone}`) as
        | TextRenderable
        | undefined;
      if (heading) {
        heading.content = (zone === 'reader' ? '▶' : ' ') + heading.plainText.slice(1);
        heading.fg = zone === 'reader' ? this.colors.green : this.colors.muted;
      }
    }
    const dock = this.renderer.root.findDescendantById('command-dock');
    const parent = dock?.parent as BoxRenderable | undefined;
    if (dock && parent) {
      parent.remove(dock);
      dock.destroyRecursively();
      this.reanalysisControl = undefined;
      this.reviewDock(parent);
    }
  }
  private readReceipt(id?: string) {
    const receipt = this.controller.session?.receipts.find((r) => r.messageId === id);
    return receipt?.status === 'succeeded' && !receipt.before && receipt.after
      ? receipt
      : undefined;
  }
  private pendingRead(id: string) {
    return (
      this.controller.pendingReads[id] ?? (this.submittingReads.has(id) ? 'queued' : undefined)
    );
  }
  private get canQueueRead() {
    return (
      !this.quickReadPending &&
      (!this.controller.mutating || Object.keys(this.controller.pendingReads).length > 0)
    );
  }
  private submitRead(ids: string[]) {
    for (const id of ids) this.submittingReads.add(id);
    this.render();
    this.run(async () => {
      try {
        await this.controller.apply(ids);
      } finally {
        for (const id of ids) this.submittingReads.delete(id);
        this.scheduleRender();
      }
    });
  }
  private undoQuickRead() {
    const receipt = this.readReceipt(this.quickReadID);
    if (!receipt || this.controller.mutating || this.quickReadPending) return;
    this.quickReadPending = true;
    this.run(async () => {
      try {
        await this.controller.undo(receipt.id);
      } finally {
        this.quickReadPending = false;
        this.scheduleRender();
      }
    });
  }
  private toggleMessageRead(message: Message) {
    if (!this.canQueueRead || this.pendingRead(message.id)) return;
    if (message.read && (this.controller.mutating || this.quickReadPending)) return;
    if (message.read) {
      const receipt = this.readReceipt(message.id);
      if (!receipt) {
        this.notice =
          'No verified inboxtop change to undo for this email. Use your email client to mark it unread.';
        this.render();
        return;
      }
      this.quickReadID = message.id;
      this.undoQuickRead();
      return;
    }
    if (!message.present) return;
    this.quickReadID = message.id;
    this.retainedReadID = message.id;
    this.retainedNewsletter = this.newsletterID
      ? this.subscriptionGroups().find((g) => g.id === this.newsletterID)
      : undefined;
    this.selected.delete(message.id);
    if (this.screen === 'report' && this.pane === 'reader') {
      this.readerID = message.id;
      this.returnRowID = message.id;
      this.readerQueue = this.rows.flatMap((r) => (r.message ? [r.message.id] : []));
      this.pinnedReaderID = message.id;
    }
    this.submitRead([message.id]);
  }
  private markCurrentRead() {
    const selection = this.selectionRows();
    const message = this.reviewMessage;
    const rows = selection.length
      ? selection
      : message
        ? [message]
        : (this.current?.newsletter?.messages ?? []);
    if (rows.length > 1 || (!message && rows.length)) this.prepareConfirmation(rows);
    else if (rows[0]) this.toggleMessageRead(rows[0]);
  }
  private leaveReader() {
    this.pane = 'list';
    this.pinnedReaderID = undefined;
    this.go('report');
  }
  private get reviewMessage() {
    return this.screen === 'reader'
      ? (this.viewMessages.find((m) => m.id === this.readerID) ??
          this.controller.saved.library?.[this.readerID ?? ''])
      : this.current?.message;
  }
  private get dashboard() {
    return this.screen === 'inbox' || this.screen === 'home';
  }
  private openMore() {
    this.emailLinkMenu = undefined;
    this.moreActions = true;
    this.menuIndex = 0;
    this.menuKey = undefined;
    this.render();
  }
  private dashboardCommands(): ReviewCommand[] {
    const commands: ReviewCommand[] = [
      {
        key: 'u',
        label:
          this.controller.syncing || this.controller.snapshotting ? 'Syncing inbox…' : 'Sync inbox',
        run: () => this.run(() => this.controller.syncInbox()),
        disabled: this.controller.syncing || this.controller.snapshotting,
      },
      {
        key: 't',
        label: `Time period: ${PERIOD_LABELS[this.period]}`,
        run: () => this.cyclePeriod(),
      },
      { key: 'i', label: 'Inbox map', run: () => this.go('overview') },
      { key: 'h', label: 'History / undo', run: () => this.openHistory() },
      {
        key: 'r',
        label: 'Refresh inbox summary',
        run: () => this.run(() => this.controller.refreshInboxSummary()),
        disabled: this.controller.summaryBusy || this.period !== 'all',
      },
      {
        key: 'v',
        label: 'Expand inbox summary',
        run: () =>
          this.openDigest(
            'Inbox summary',
            this.period === 'all'
              ? this.controller.inboxSummary
              : dashboardSummary(
                  this.screen === 'inbox' ? this.controller.pool : this.viewMessages,
                  this.period,
                  this.config.analysisLanguage,
                ),
          ),
      },
      {
        key: 'S',
        label: 'Sender statistics',
        run: () => this.openSetup('subscriptions'),
        disabled: this.controller.busy,
      },
      { key: 'c', label: 'Chat with your mail', run: () => this.go('chat') },
      { key: ',', label: 'Settings', run: () => this.openSettings() },
    ];
    if (this.controller.pool.some((m) => m.error))
      commands.push(
        { key: '!', label: 'View failed analyses', run: () => this.openFailedReviews() },
        {
          key: 'R',
          label: 'Retry failed reviews',
          run: () => this.run(() => this.controller.retry()),
          disabled: this.controller.busy || this.controller.mutating || !this.controller.session,
        },
      );
    if (
      this.controller.busy ||
      this.controller.reviewJobs.some((job) => job.state === 'queued') ||
      this.controller.mode === 'live'
    )
      commands.push({
        key: 'p',
        label: 'Stop analysis and queued reviews',
        run: () => this.run(() => this.controller.stop()),
      });
    return commands.map((command) => ({
      ...command,
      disabled:
        command.disabled ||
        ((this.controller.mutating || this.quickReadPending) &&
          ['u', 'r', 'S', 'p'].includes(command.key)),
    }));
  }
  private adjacentEmailID(delta: number) {
    const ids =
      this.screen === 'reader' ? this.readerQueue : this.rows.map((row) => row.message?.id);
    const index = this.screen === 'reader' ? ids.indexOf(this.readerID) : this.cursor;
    return index < 0 ? undefined : ids[index + delta];
  }
  private adjacentEmail(delta: number) {
    const next = this.adjacentEmailID(delta);
    if (!next) return;
    if (next !== this.retainedReadID) this.retainedReadID = undefined;
    this.readerID = next;
    if (this.screen === 'reader') {
      if (this.tab === 'emails') this.returnRowID = next;
    } else {
      this.cursor += delta;
      this.pinnedReaderID = next;
    }
    this.render();
  }
  private reviewCommands(): ReviewCommand[] {
    const message = this.reviewMessage;
    const selection = this.selectionRows();
    const list = this.screen === 'report' && this.pane === 'list';
    const emailList = this.tab === 'emails' || (!this.isAudit && !!this.newsletterID);
    const unread = this.rows
      .flatMap((row) => this.rowEmails(row))
      .filter((m) => m.present && !m.read);
    const currentUnread = (message ? [message] : (this.current?.newsletter?.messages ?? [])).filter(
      (m) => m.present && !m.read,
    );
    const writing =
      this.controller.mutating || this.quickReadPending || this.submittingReads.size > 0;
    const targets = selection.length ? selection : currentUnread;
    const available = targets.filter((m) => !this.pendingRead(m.id));
    const pending =
      targets.length && !available.length
        ? targets.some((m) => this.pendingRead(m.id) === 'updating')
          ? 'Updating…'
          : 'Queued…'
        : undefined;
    const commands: ReviewCommand[] = [];
    const add = (
      key: string,
      label: string,
      run: () => void,
      primary = false,
      disabled = false,
    ) => {
      const conflictsWithWrite =
        ['z', 'r', 'R', 'p', 'm', 'S'].includes(key) ||
        (key === 'x' && (!this.canQueueRead || (!!message?.read && !selection.length))) ||
        (key === 'g' && !emailList && !this.isAudit);
      commands.push({
        key,
        label,
        run,
        primary,
        disabled: disabled || (writing && conflictsWithWrite),
      });
    };
    if (list) {
      add(
        'Home',
        'First in list (Cmd+↑)',
        () => this.list?.setSelectedIndex(0),
        false,
        !this.rows.length || this.cursor === 0,
      );
      add(
        'End',
        'Last in list (Cmd+↓)',
        () => this.list?.setSelectedIndex(this.rows.length - 1),
        false,
        !this.rows.length || this.cursor === this.rows.length - 1,
      );
    }
    if (message || selection.length || currentUnread.length) {
      add(
        'x',
        pending
          ? pending
          : selection.length
            ? `Mark ${available.length} read`
            : !message
              ? `Mark ${available.length} read`
              : message?.read
                ? 'Mark unread'
                : 'Mark read',
        () => this.markCurrentRead(),
        true,
        !!pending ||
          (!selection.length &&
            !currentUnread.length &&
            (!message?.present || (!!message.read && !this.readReceipt(message.id)))),
      );
    }
    if (message && !this.isAudit && !selection.length)
      add(
        'r',
        this.emailReviewState(message.id) === 'running'
          ? 'Re-analyzing…'
          : this.emailReviewState(message.id) === 'queued'
            ? 'Queued'
            : this.emailReviewState(message.id) === 'submitting'
              ? 'Requesting…'
              : 'Re-analyze',
        () => this.reanalyzeMessage(message),
        true,
        !!this.emailReviewState(message.id) || !message.present || message.read,
      );
    if (currentUnread.length)
      add(
        'Space',
        currentUnread.every((m) => this.selected.has(m.id)) ? 'Deselect' : 'Select',
        () => this.toggleSelectedEmail(),
        true,
      );
    if (selection.length) add('c', 'Clear selection', () => this.clearSelection(), true);
    if (
      this.screen === 'report' &&
      (emailList || (!this.isAudit && this.tab === 'subscriptions'))
    ) {
      add(
        'a',
        unread.length && unread.every((m) => this.selected.has(m.id))
          ? 'Deselect all'
          : 'Select all',
        () => this.selectAll(),
        true,
        !unread.length,
      );
    }
    if (this.screen === 'report') {
      if (this.tab === 'subscriptions' && !this.isAudit)
        add(
          't',
          `Show: ${NEWSLETTER_SCOPE_LABELS[this.newsletterScope]}`,
          () => this.cycleSubscriptionScope(),
          false,
        );
      add(
        '/',
        'Search',
        () => {
          this.searching = true;
          this.render();
        },
        false,
      );
      if (this.query)
        add('Backspace', 'Clear search', () => {
          this.query = '';
          this.selected.clear();
          this.cursor = 0;
          this.render();
        });
      if (this.tab === 'subscriptions' && !this.isAudit && !this.newsletterID)
        add(
          's',
          `Sort: ${NEWSLETTER_SORT_LABELS[this.newsletterSort]}`,
          () => {
            const sorts: NewsletterSort[] = ['latest', 'issues', 'name'];
            this.newsletterSort = sorts[(sorts.indexOf(this.newsletterSort) + 1) % sorts.length];
            this.render();
          },
          false,
        );
      if (emailList) add('s', `Sort: ${SORT_LABELS[this.sort]}`, () => this.cycleSort(), false);
      if (emailList || this.isAudit)
        add(
          'g',
          this.newResults ? `Load ${this.newResults} new results` : 'Refresh list',
          () => this.reloadResults(),
          false,
        );
    }
    if (message) {
      const links = [...new Set(emailLinks(message.body).map((link) => link.url))];
      if (links.length)
        add(
          'L',
          `Links (${links.length})`,
          () => {
            this.emailLinkMenu = links;
            this.moreActions = true;
            this.menuIndex = 0;
            this.menuKey = undefined;
            this.render();
          },
          !list && (this.previewMode === 'original' || this.isAudit),
        );
      if (!this.isAudit)
        add(
          'o',
          this.viewToggleLabel,
          () => this.setPreview(this.previewMode === 'summary' ? 'original' : 'summary'),
          false,
        );
      add(
        'e',
        this.screen === 'reader' ? 'Collapse' : 'Expand',
        () => (this.screen === 'reader' ? this.leaveReader() : this.expandReader()),
        false,
      );
      if (!this.isAudit && (message.analysis || message.classification))
        add(
          'd',
          this.expandedReasons.has(message.id) && this.previewMode === 'summary'
            ? 'Hide explanation'
            : 'Why this recommendation',
          () => this.toggleRecommendation(message),
        );
      if (this.reader && this.screen === 'report') {
        add('+', 'Larger preview', () => {
          this.listFraction = Math.max(0.25, this.listFraction - 0.1);
          this.render();
        });
        add('-', 'Smaller preview', () => {
          this.listFraction = Math.min(0.65, this.listFraction + 0.1);
          this.render();
        });
      }
      if (safeURL(message.unsubscribe))
        add('u', 'Review unsubscribe link', () => {
          this.link = message.unsubscribe;
          this.go('link');
        });
    }
    if (!list && message) {
      for (const [key, label, delta] of [
        ['[', 'Previous email', -1],
        [']', 'Next email', 1],
      ] as const)
        add(key, label, () => this.adjacentEmail(delta), false, !this.adjacentEmailID(delta));
    }
    if (!this.isAudit && this.tab === 'subscriptions') {
      const group =
        this.subscriptionGroups().find((g) => g.id === this.newsletterID) ??
        this.current?.newsletter;
      if (group) {
        add('v', 'Read digest', () => this.openNewsletterDigest(group), false);
        if (!message && !this.newsletterID)
          add(
            'g',
            this.newsletterLabel(group.messages.map((m) => m.id)),
            () => this.refreshDigest(),
            !selection.length && !this.controller.newsletterDigest(group.messages.map((m) => m.id)),
            this.controller.reviewPending(
              'newsletter',
              group.messages.map((m) => m.id),
            ) || !!this.controller.newsletterDigest(group.messages.map((m) => m.id)),
          );
        if (!this.newsletterID)
          add(
            'Enter',
            'Open issues',
            () => this.openNewsletterIssues(group),
            list && !selection.length,
          );
      }
    }
    if (this.readReceipt(this.quickReadID))
      add(
        'z',
        'Undo last read',
        () => this.undoQuickRead(),
        !selection.length && message?.id !== this.quickReadID,
      );
    if (!this.isAudit && this.controller.pool.some((m) => m.error)) {
      add('!', 'View failed analyses', () => this.openFailedReviews());
      add(
        'R',
        'Retry failed reviews',
        () => this.run(() => this.controller.retry()),
        this.failedReviews,
        this.controller.busy || !this.controller.session,
      );
    }
    if (
      this.controller.busy ||
      this.controller.reviewJobs.some((job) => job.state === 'queued') ||
      this.controller.mode === 'live'
    )
      add('p', 'Stop analysis and queued reviews', () => this.run(() => this.controller.stop()));
    add('h', 'History / undo', () => this.openHistory());
    add('m', this.controller.mode === 'live' ? 'Switch to Ad hoc' : 'Switch to Live', () =>
      this.toggleMode(),
    );
    add(',', 'Settings', () => this.openSettings());
    if (!this.isAudit)
      add(
        'S',
        'Sender statistics',
        () => this.openSetup('subscriptions'),
        false,
        this.controller.busy,
      );
    return commands;
  }
  private menuCommands(): ReviewCommand[] {
    if (this.moreActions && this.emailLinkMenu)
      return this.emailLinkMenu.map((url, i) => ({
        key: String(i + 1),
        label: url,
        run: () => this.openEmailURL(url),
      }));
    const commands = this.dashboard ? this.dashboardCommands() : this.reviewCommands();
    return [...commands.filter((c) => !c.primary), ...commands.filter((c) => c.primary)];
  }
  private executeCommand(command?: ReviewCommand) {
    if (!command || this.confirmation.length) return;
    // Resolve again so clicks and keyboard shortcuts use the same current availability and scope.
    const current = (
      this.moreActions && this.emailLinkMenu
        ? this.menuCommands()
        : this.dashboard
          ? this.dashboardCommands()
          : this.reviewCommands()
    ).find((c) => c.key === command.key);
    if (!current || current.disabled) return;
    const wasMenu = this.moreActions;
    this.moreActions = false;
    this.emailLinkMenu = undefined;
    const shell = this.shell;
    current.run();
    if (wasMenu && shell === this.shell) this.render();
  }
  private reviewStatus() {
    if (this.notice) return this.notice;
    const status = this.progress();
    if (/^Analyzing batch/.test(status)) return '';
    if (status.includes('could not be analyzed'))
      return status.replace(/^\d+ ready to review · /, '');
    if (/^(Stopped|Saved|Report ready|Review ready|\d+ ready to review|Monitoring)/i.test(status))
      return '';
    return status;
  }
  private reviewActivityLabel() {
    const status = this.reviewStatus();
    if (this.controller.writeProgress) return this.progressLines()[0];
    if (this.controller.mutating || this.quickReadPending) return 'Updating read status…';
    if (this.notice) return oneLine(this.notice);
    if (this.controller.snapshotting) return 'Syncing unread mail…';
    const job = this.currentReviewJob;
    if (job?.state === 'queued')
      return job.kind === 'email' ? 'Re-analysis queued' : 'Summary queued';
    if (job?.state === 'running')
      return job.kind === 'email'
        ? 'Re-analyzing…'
        : `Generating summary · ${job.messageIDs.length} issues`;
    if (job?.state === 'failed' || job?.state === 'cancelled')
      return job.detail ?? 'Request stopped. Try again.';
    if (this.controller.reviewJobs.some((job) => job.state === 'running')) return '';
    if (
      !job &&
      !this.controller.busy &&
      this.controller.reviewJobs.length &&
      (/^(Summary (ready|failed|cancelled)|Review updated|Reviewing selected email)/.test(status) ||
        this.controller.reviewJobs.some((request) => request.detail === status))
    )
      return '';
    if (this.controller.newsletterProgress)
      return this.currentNewsletterGeneration
        ? `Generating summary · ${this.currentNewsletterGeneration.messageIDs.length} issues`
        : '';
    const progress = this.controller.progress;
    const activity = this.controller.busy ? `Analyzing ${progress.resolved}/${progress.total}` : '';
    const detail = /^Analyzing emails/.test(status)
      ? ''
      : status.replace('Preparing combined newsletter digest', 'Preparing digest');
    return [activity, detail].filter(Boolean).join(' · ');
  }
  private commandMenu(parent: BoxRenderable, commands: ReviewCommand[], capacity: number) {
    const previous = commands.findIndex((c) => c.key === this.menuKey);
    this.menuIndex =
      previous >= 0 ? previous : Math.max(0, Math.min(this.menuIndex, commands.length - 1));
    this.menuKey = commands[this.menuIndex]?.key;
    const start = Math.max(
      0,
      Math.min(this.menuIndex - Math.floor(capacity / 2), commands.length - capacity),
    );
    for (const [offset, command] of commands.slice(start, start + capacity).entries()) {
      const active = start + offset === this.menuIndex;
      this.text(
        parent,
        `${active ? '▶' : ' '} ${command.key.padEnd(5)} ${command.label}`,
        command.disabled ? this.colors.muted : active ? this.colors.green : this.colors.text,
        {
          id: `command-${command.key}`,
          height: 1,
          bg: active ? this.colors.raised : this.colors.bg,
          onMouseDown: () => this.executeCommand(command),
        },
      );
    }
    const navigation = this.box(parent, { height: 1, flexShrink: 0, flexDirection: 'row', gap: 2 });
    this.text(navigation, 'Esc Close menu', this.colors.text, {
      id: 'menu-back',
      height: 1,
      flexShrink: 0,
      onMouseDown: () => this.clickEscape(),
    });
    this.text(
      navigation,
      `↑↓ Choose  Enter ${this.emailLinkMenu ? 'Open' : 'Run'}${this.renderer.width < 65 ? '' : `   ${this.menuIndex + 1}/${commands.length}`}`,
      this.colors.muted,
      { height: 1 },
    );
  }
  private reviewDock(parent: BoxRenderable) {
    const commands = this.moreActions ? this.menuCommands() : this.reviewCommands();
    const count = this.selectionRows().length;
    const list = this.screen === 'report' && this.pane === 'list';
    const dock = this.box(parent, {
      id: 'command-dock',
      zIndex: this.confirmation.length ? 101 : undefined,
      flexDirection: 'column',
      flexShrink: 0,
      ...(this.confirmation.length
        ? {}
        : { border: ['top' as const], borderColor: this.colors.line }),
      marginTop: this.sectionGap,
    });
    if (this.confirmation.length) {
      this.confirm(dock);
      return;
    }
    const activity = this.reviewActivityLabel();
    const scope = count
      ? `${count} selected`
      : this.reviewMessage
        ? `current email${this.reviewMessage.read ? ' · Read' : ''}`
        : this.current?.newsletter
          ? 'current sender'
          : 'no email';
    const metadata = this.box(dock, {
      id: 'command-metadata',
      flexDirection: 'row',
      height: 1,
      flexShrink: 0,
      justifyContent: 'space-between',
      gap: 2,
    });
    // One quiet context/status row, never a stack of pipeline counters in review.
    const narrowActivity = this.renderer.width < 65 && !!activity;
    if (!narrowActivity)
      this.text(
        metadata,
        `${this.moreActions ? (this.emailLinkMenu ? 'Email links' : 'Commands') : list ? 'List' : 'Preview'} · ${scope}`,
        count ? this.colors.amber : this.colors.muted,
        { id: 'command-context', height: 1, flexShrink: 0 },
      );
    this.reviewActivityNode = this.text(
      metadata,
      activity,
      this.notice ? this.colors.red : this.colors.muted,
      { id: 'review-activity', height: 1, flexGrow: 1, minWidth: 0, wrapMode: 'none' },
    );
    if (this.moreActions) {
      this.list?.blur();
      this.reader?.blur();
      this.commandMenu(dock, commands, this.renderer.height < 24 ? 4 : 6);
      return;
    }
    const primary = this.box(dock, {
      id: 'command-actions',
      flexDirection: 'row',
      flexWrap: 'wrap',
      flexShrink: 0,
      columnGap: 2,
      rowGap: 0,
      minHeight: this.primaryDockRows(commands),
    });
    for (const command of commands.filter((c) => c.primary)) {
      const button = this.box(primary, {
        id: `command-${command.key}`,
        flexDirection: 'row',
        height: 1,
        flexShrink: 0,
        paddingX: 1,
        backgroundColor: this.colors.panel,
        onMouseDown: () => this.executeCommand(command),
      });
      this.text(button, command.key, command.disabled ? this.colors.muted : this.colors.blue, {
        height: 1,
        bg: this.colors.raised,
        attributes: TextAttributes.BOLD,
      });
      const label = this.text(
        button,
        ' ' + command.label,
        command.disabled ? this.colors.muted : this.colors.text,
        {
          height: 1,
        },
      );
      if (command.key === 'r' && this.reviewMessage)
        this.reanalysisControl = { message: this.reviewMessage, text: label };
    }
    // Navigation shares the same dock. It has no independent focus stop.
    const navigation = this.box(dock, {
      id: 'shortcut-footer',
      marginTop: this.sectionGap,
      flexDirection: 'row',
      flexWrap: 'wrap',
      flexShrink: 0,
      columnGap: 2,
      rowGap: 0,
      minHeight: this.controlRows(
        [
          `Esc ${this.screen === 'report' ? (this.newsletterID ? 'Back to subscriptions' : this.senderID ? 'Back to senders' : 'Back to inbox') : this.backLabel()}`,
          'Tab Preview',
          '; More actions',
          ...(this.reviewMessage ? ['[ Prev', '] Next'] : []),
          ...(this.renderer.width >= 100 ? ['↑↓ Scroll'] : []),
          '? Help',
        ].map((label) => label.length),
      ),
    });
    const hints: { key: string; label: string; run?: () => void; disabled?: boolean }[] = [
      { key: 'Esc', label: this.backLabel(), run: () => this.clickEscape() },
      {
        key: 'Tab',
        label: list
          ? this.reader
            ? 'Preview'
            : this.current?.newsletter
              ? 'Read digest'
              : 'Open email'
          : 'List',
        run: () =>
          this.screen === 'reader' ? this.leaveReader() : this.focusPane(list ? 'reader' : 'list'),
      },
      {
        key: ';',
        label: 'More actions',
        run: () => this.openMore(),
      },
      ...commands
        .filter((command) => command.key === '[' || command.key === ']')
        .map((command) => ({
          key: command.key,
          label: command.key === '[' ? 'Prev' : 'Next',
          disabled: command.disabled,
          run: () => this.executeCommand(command),
        })),
      { key: '↑↓', label: list ? 'Move' : 'Scroll' },
      {
        key: '?',
        label: 'Help',
        run: () => {
          this.backFromHelp = this.screen;
          this.go('help');
        },
      },
    ];
    for (const hint of hints) {
      if (hint.key === '↑↓' && this.renderer.width < 100) continue;
      if (hint.run) {
        const back = this.box(navigation, {
          id:
            hint.key === 'Esc'
              ? 'footer-back'
              : hint.key === ';'
                ? 'footer-more'
                : `footer-${hint.key}`,
          flexDirection: 'row',
          height: 1,
          flexShrink: 0,
          onMouseDown: hint.run,
        });
        this.text(back, hint.key, hint.disabled ? this.colors.muted : this.colors.green, {
          height: 1,
          bg: this.colors.raised,
          attributes: TextAttributes.BOLD,
        });
        this.text(back, ` ${hint.label}`, hint.disabled ? this.colors.muted : this.colors.text, {
          height: 1,
        });
      } else
        this.text(navigation, `${hint.key} ${hint.label}`, this.colors.muted, {
          height: 1,
          flexShrink: 0,
          onMouseDown: hint.run,
        });
    }
  }
  private controlRows(widths: number[]) {
    const available = this.renderer.width - 2;
    let rows = 1,
      used = 0;
    for (const width of widths) {
      if (used && used + 2 + width > available) {
        rows++;
        used = 0;
      }
      used += (used ? 2 : 0) + width;
    }
    return rows;
  }
  private primaryDockRows(commands: ReviewCommand[]) {
    const rows = (items: ReviewCommand[]) =>
      this.controlRows(
        items.filter((c) => c.primary).map((c) => c.key.length + c.label.length + 3),
      );
    if (this.screen !== 'report') return rows(commands);
    const pane = this.pane;
    try {
      this.pane = pane === 'list' ? 'reader' : 'list';
      return Math.max(rows(commands), rows(this.reviewCommands()));
    } finally {
      this.pane = pane;
    }
  }
  private updateReanalysisControl() {
    if (this.reviewActivityNode) this.reviewActivityNode.content = this.reviewActivityLabel();
    const heading = this.renderer.root.findDescendantById('focus-reader') as
      | TextRenderable
      | undefined;
    if (heading) heading.content = this.previewTitle();
    const control = this.reanalysisControl;
    if (!control) return;
    const command = this.reviewCommands().find((c) => c.key === 'r');
    if (!command) return;
    control.text.content = ' ' + command.label;
    control.text.fg = command.disabled ? this.colors.muted : this.colors.text;
  }
  private reanalyzeMessage(message: Message) {
    if (this.isAudit) {
      this.notice = 'This audit uses no AI. Use Update inbox for recommendations.';
    } else if (this.selectionRows().length) {
      this.notice = 'Clear the selection to re-analyze one email.';
    } else if (
      !!this.emailReviewState(message.id) ||
      this.controller.mutating ||
      this.quickReadPending ||
      !message.present ||
      message.read
    ) {
      return;
    } else {
      const missing = this.demo ? [] : configErrors(this.config, true);
      if (!missing.length) {
        this.notice = '';
        this.submittingReviews.add(message.id);
        this.updateReanalysisControl();
        this.updateActivity();
        this.run(async () => {
          try {
            await this.controller.reviewOne(message.id);
          } finally {
            this.submittingReviews.delete(message.id);
            this.updateReanalysisControl();
            this.updateActivity();
          }
        });
        return;
      }
      this.notice = 'Missing configuration: ' + missing.join(', ');
    }
    this.render();
  }
  private clearSelection() {
    this.selected.clear();
    this.render();
  }
  private selectAll() {
    const ids = this.rows
      .flatMap((row) => this.rowEmails(row))
      .filter((m) => m.present && !m.read)
      .map((m) => m.id);
    this.selected = new Set(ids.every((id) => this.selected.has(id)) ? [] : ids);
    this.render();
  }
  private senderContent(parent: BoxRenderable, g: SenderGroup) {
    this.text(parent, g.name, this.colors.text, { attributes: TextAttributes.BOLD });
    this.text(parent, g.address, this.colors.muted);
    this.text(parent, `${g.messages.length} emails  ·  ${g.unread} unread`, this.colors.green);
    this.text(
      parent,
      `Latest: ${g.latest.slice(0, 10) || 'unknown'}\nAverage reading time: ~${Math.max(1, Math.round(g.minutes / g.messages.length))} min${g.messages.some((m) => !m.complete) ? ' (partial text)' : ''}`,
      this.colors.muted,
    );
    this.text(
      parent,
      g.unsubscribe
        ? 'UNSUBSCRIBE\n' + g.unsubscribe
        : 'No supported HTTPS unsubscribe destination found.',
      this.colors.muted,
    );
    this.text(
      parent,
      'Enter inspect issues' + (g.unsubscribe ? '   u review unsubscribe destination' : ''),
      this.colors.green,
    );
    for (const m of g.messages.slice(0, 8)) this.text(parent, '• ' + m.subject);
  }
  private fullReader(parent: BoxRenderable) {
    const m =
      this.viewMessages.find((m) => m.id === this.readerID) ??
      this.controller.saved.library?.[this.readerID ?? ''];
    if (!m) return;
    const heading = this.box(parent, { flexDirection: 'row', height: 1, flexShrink: 0 });
    this.text(heading, this.previewTitle(), this.colors.green, {
      id: 'focus-reader',
      height: 1,
      flexGrow: 1,
      flexBasis: 0,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: 'none',
    });
    this.viewControls(heading, ['o', 'e'], 'view-controls');
    const reader = (this.reader = this.boxReader(parent, 0));
    parent.add(reader);
    this.messageContent(reader, m, this.previewMode === 'original');
    this.lastReaderMessage = { ...m };
    reader.focus();
  }
  private prepareConfirmation(rows: Message[]) {
    if (!this.canQueueRead || this.confirmation.length) return;
    this.confirmation = rows.filter((m) => m.present && !m.read && !this.pendingRead(m.id));
    if (!this.confirmation.length) {
      this.notice = 'No unread messages in this selection.';
    }
    this.render();
  }
  private cancelConfirmation() {
    this.confirmation = [];
    this.render();
  }
  private confirm(parent: BoxRenderable) {
    this.list?.blur();
    this.reader?.blur();
    const prompt = this.box(parent, {
      id: 'read-confirmation',
      width: '100%',
      flexShrink: 0,
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: this.colors.amber,
      backgroundColor: this.colors.panel,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: this.sectionGap,
      paddingBottom: this.sectionGap,
    });
    const count = this.confirmation.length;
    this.text(
      prompt,
      `Mark ${count} ${count === 1 ? 'email' : 'emails'} as read?`,
      this.colors.amber,
      {
        flexShrink: 0,
        attributes: TextAttributes.BOLD,
      },
    );
    const actions = this.box(prompt, {
      flexDirection: 'row',
      height: 1,
      gap: 2,
      marginTop: 1,
      flexShrink: 0,
    });
    for (const [id, key, label, run] of [
      ['cancel-read', 'Esc', 'Cancel', () => this.cancelConfirmation()],
      ['confirm-read', 'Enter', 'Mark read', () => this.commitSelection()],
    ] as const) {
      const button = this.box(actions, { id, flexDirection: 'row', height: 1, onMouseDown: run });
      this.text(button, key, this.colors.green, {
        height: 1,
        bg: this.colors.raised,
        attributes: TextAttributes.BOLD,
      });
      this.text(button, ` ${label}`, this.colors.text, { height: 1 });
    }
  }
  private commitSelection() {
    if (!this.canQueueRead || !this.confirmation.length) return;
    // The proposal is frozen when the prompt opens; background arrivals cannot enlarge it.
    const ids = this.confirmation.map((m) => m.id);
    this.confirmation = [];
    this.selected.clear();
    this.submitRead(ids);
  }
  private openHistory() {
    this.historyBack = this.screen;
    this.go('history');
  }
  private history(parent: BoxRenderable) {
    this.text(parent, 'Verified changes and outcomes', this.colors.text, {
      attributes: TextAttributes.BOLD,
      height: 2,
    });
    this.text(
      parent,
      'Enter undoes a successful change if the server state still matches.',
      this.colors.muted,
      { height: 2 },
    );
    this.select(
      parent,
      (this.controller.session?.receipts ?? []).map((r) => ({
        id: r.id,
        name: `${r.status.toUpperCase()}  ${r.subject}`,
        description: r.detail,
        action: () => this.run(() => this.controller.undo(r.id)),
      })),
      (r) => r.action?.(),
    );
  }
  private help(parent: BoxRenderable) {
    const scroll = this.boxReader(parent);
    parent.add(scroll);
    scroll.focus();
    this.reader = scroll;
    if (this.backFromHelp === 'settings') {
      this.text(scroll, 'Settings', this.colors.green, { attributes: TextAttributes.BOLD });
      this.text(
        scroll,
        '↑↓ or Tab moves through editable fields and the bottom buttons.\nEnter opens a choice or editor; fixed values are skipped.\nEnter in a text editor keeps the edit in your draft; Esc cancels it.\ns saves changes; t tests classification and review using fictional text (two requests).\nThe OpenAI test is a paid API call. Testing does not save changes.\nEsc goes back; unsaved changes offer Keep editing, Save or Discard.\n\nOpenAI: enter an exact model ID available to your API account.\nThe classification model is fixed; detailed review is editable.\nOllama: choose an installed model for each stage or enter its tag.\nInstall in Terminal: ollama pull MODEL:TAG\nList models: ollama list\n\nLanguage affects new reviews and summaries. Existing reviews stay unchanged.\nStop active analysis before saving settings.\nCtrl+C closes the app immediately without saving your draft.',
        this.colors.muted,
      );
      return;
    }
    this.text(scroll, 'Choose emails. Review results. Decide.', this.colors.green, {
      attributes: TextAttributes.BOLD,
    });
    this.text(
      scroll,
      'Overview: unread coverage, saved summary, Ad hoc / Live mode\n; More on the inbox: u Sync inbox, t Time period, i Inbox map, h History / undo\nAd hoc analyzes the next chosen count; oldest first is the default\nLive analyzes all unread and incoming mail in a background worker\nCompleted recommendations remain until the message becomes read\n1–4 opens Act / Read / Low priority / Check manually\n→ or Enter focuses the email; ← returns to the list; Tab switches list/preview\n↑↓ scrolls the focused pane; Page Up/Down and Home/End navigate long mail\nCmd+↑/↓ or Home/End jumps to first/last in the focused list\no toggles App review / Original without changing pane focus; e expands/collapses the email\nShift+L lists email links; arrows choose, Enter opens, Esc returns\nOriginal URLs support terminal-native link opening (gesture depends on terminal)\n[ previous email; ] next email while reading; unavailable at queue boundaries\nd shows/hides Why this recommendation (review details and quoted evidence)\n+ gives the preview more space; - gives the list more space\nSpace selects; x marks one email read immediately; x again restores unread\nr refreshes the inbox summary on overview screens; re-analyzes the current email in review\nShift+R retries failed reviews\nScope, Search and Sort stay above the list; Backspace clears an active search\nOriginal/Review and Expand stay beside the preview title; email actions stay in the bottom dock\nSpace selects; a selects all; c clears selection; / searches; s sorts\n; opens all commands; arrows choose, Enter runs, Esc closes\nTab switches list/preview; commands preserve focus\nSelections apply to x in both preview and expanded email; c clears them\na then x marks the selected list read; z undoes the last single mark read\nc opens Chat with saved mail and automatic bounded inbox search; F4 shows investigation details\nCtrl+O opens Chat sources; Ctrl+N starts a new chat\nBulk changes open a compact confirmation: Enter confirms; Esc cancels to adjust selection\ng refreshes the email list or newsletter digest; lists stay stable until refreshed\nl Subscriptions: saved analyzed issues grouped by sender; t switches Unread / All analyzed\ns changes review order; / searches; p stops analysis; completed results stay saved\nh opens changes and undo; , opens provider settings; q closes the terminal',
      this.colors.muted,
    );
  }
  private linkReview(parent: BoxRenderable) {
    this.text(parent, 'Open unsubscribe destination?', this.colors.amber, {
      attributes: TextAttributes.BOLD,
    });
    this.text(parent, safeURL(this.link) ?? 'No supported HTTPS destination.');
    this.text(
      parent,
      'Enter opens this address in your browser. Complete any further action there. Esc cancels.',
      this.colors.muted,
    );
  }
  private openLink() {
    const url = safeURL(this.link);
    if (!url) return;
    const child = spawn(
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'rundll32'
          : 'xdg-open',
      process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url],
      { stdio: 'ignore', shell: false },
    );
    child.on('error', () => {
      this.notice = 'Could not open a browser. Copy the displayed URL manually.';
      this.render();
    });
    this.notice = 'Browser opened. Unsubscription is not confirmed.';
    this.go('report');
  }
  private openEmailURL(value: string) {
    const url = emailURL(value);
    if (!url) return;
    const child = spawn(
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'rundll32'
          : 'xdg-open',
      process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url],
      { stdio: 'ignore', shell: false },
    );
    child.on('error', () => {
      this.notice = 'Could not open the link. Copy its address to your browser.';
      this.render();
    });
    child.once('exit', (code) => {
      if (code !== 0 && !this.disposed) {
        this.notice = 'Could not open the link. Copy its address to your browser.';
        this.render();
      }
    });
  }
  private input(
    parent: BoxRenderable,
    placeholder: string,
    value: string,
    apply: (value: string) => void,
  ) {
    const input = new InputRenderable(this.renderer, {
      value,
      placeholder,
      width: '100%',
      backgroundColor: this.colors.raised,
      textColor: this.colors.text,
      focusedBackgroundColor: this.colors.raised,
      cursorColor: this.colors.green,
    });
    parent.add(input);
    if (this.editingSetting)
      input.on(InputRenderableEvents.INPUT, () => {
        this.settingsEditValue = input.value;
      });
    input.on(InputRenderableEvents.ENTER, () => apply(input.value));
    input.focus();
  }
  private go(screen: Screen) {
    if (screen === 'report' && this.screen !== 'reader') {
      this.retainedReadID = undefined;
      this.retainedNewsletter = undefined;
    }
    if (screen === 'inbox' || screen === 'home') this.auditView = false;
    if (screen !== 'reader' && screen !== 'report') {
      this.retainedReadID = undefined;
      this.frozenIDs = undefined;
      this.pane = 'list';
      this.pinnedReaderID = undefined;
    }
    this.moreActions = false;
    this.screen = screen;
    if (screen !== 'reader') {
      this.cursor = 0;
      this.rows = [];
    }
    this.render();
  }
  private navigateBack() {
    this.notice = '';
    if (this.screen === 'report' && this.pane !== 'list') {
      this.focusPane('list');
      return;
    }
    if (this.screen === 'history') this.go(this.historyBack);
    else if (this.screen === 'help') this.go(this.backFromHelp);
    else if (this.screen === 'digest') {
      this.newsletterReturnID = this.digestGroup;
      this.go(this.digestBack);
    } else if (this.screen === 'overview') this.go('inbox');
    else if (this.screen === 'inbox') return;
    else if (this.screen === 'home') this.go('inbox');
    else if (this.screen === 'setup') this.go(this.setupBack);
    else if (this.screen === 'settings') this.go(this.settingsBack);
    else if (this.screen === 'reader') {
      this.leaveReader();
    } else if (this.screen === 'report' && this.newsletterID) {
      this.newsletterReturnID = this.newsletterID;
      this.newsletterID = undefined;
      this.query = '';
      this.previewMode = 'summary';
      this.selected.clear();
      this.go('report');
    } else if (this.screen === 'report' && this.senderID) {
      this.senderID = undefined;
      this.selected.clear();
      this.render();
    } else if (this.screen === 'report') {
      this.selected.clear();
      this.go('inbox');
    } else {
      this.selected.clear();
      this.go('report');
    }
  }
  private key(key: KeyEvent) {
    const name = key.name;
    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    if (key.ctrl && name === 'c') {
      consume();
      void this.onQuit();
      return;
    }
    if (this.screen === 'chat') {
      this.chat?.key(key);
      return;
    }
    if (this.dashboard && name === 'c') {
      consume();
      this.go('chat');
      return;
    }
    if (this.confirmation.length) {
      consume();
      if (name === 'escape') this.cancelConfirmation();
      else if (name === 'return') this.commitSelection();
      return;
    }
    if (this.searching || this.customCount || this.editingSetting) {
      if (name === 'escape') {
        consume();
        this.searching = false;
        this.customCount = false;
        this.editingSetting = undefined;
        this.settingsEditValue = undefined;
        this.notice = '';
        this.render();
      }
      return;
    }
    if (this.screen === 'settings') {
      consume();
      this.settingsKey(key);
      return;
    }
    if (name === 'q') {
      consume();
      void this.onQuit();
      return;
    }
    if (this.dashboard || ['report', 'reader'].includes(this.screen)) {
      const listBoundary =
        this.screen === 'report' &&
        this.pane === 'list' &&
        !key.ctrl &&
        !key.meta &&
        !key.shift &&
        (name === 'home' || name === 'end' || (key.super && ['up', 'down'].includes(name)))
          ? name === 'home' || name === 'up'
            ? 'Home'
            : 'End'
          : undefined;
      const commandKey =
        listBoundary ??
        (['r', 's', 'l'].includes(name) && key.shift
          ? name.toUpperCase()
          : name === 'space'
            ? 'Space'
            : name === '='
              ? '+'
              : name === 'backspace'
                ? 'Backspace'
                : name);
      const commands = this.menuCommands();
      if (this.moreActions) {
        consume();
        if (name === 'escape' || name === ';') {
          this.moreActions = false;
          this.render();
        } else if (['up', 'down', 'j', 'k'].includes(name)) {
          this.menuIndex =
            (this.menuIndex + (name === 'up' || name === 'k' ? -1 : 1) + commands.length) %
            commands.length;
          this.menuKey = commands[this.menuIndex]?.key;
          this.render();
        } else if (name === 'return')
          this.executeCommand(
            commands.find((c) => c.key === this.menuKey) ?? commands[this.menuIndex],
          );
        else {
          const command = commands.find(
            (c) => c.key === commandKey || (name === 'return' && c.key === 'Enter'),
          );
          if (command) this.executeCommand(command);
        }
        return;
      }
      if (name === ';') {
        consume();
        this.openMore();
        return;
      }
      const command = commands.find(
        (c) => c.key === commandKey || (name === 'return' && c.key === 'Enter'),
      );
      if (command) {
        consume();
        this.executeCommand(command);
        return;
      }
      // Unavailable review commands must not fall through to legacy handlers.
      if (
        !this.dashboard &&
        [
          '[',
          ']',
          'x',
          'z',
          'r',
          'R',
          'a',
          'c',
          'Space',
          'o',
          'd',
          'g',
          's',
          '/',
          'e',
          '+',
          '=',
          '-',
          'h',
          'p',
          'm',
          ',',
          'v',
        ].includes(commandKey)
      ) {
        consume();
        return;
      }
    }
    if (name === 'm') {
      consume();
      if (this.screen === 'inbox') {
        this.cursor = 0;
        this.render();
      } else this.toggleMode();
      return;
    }
    if (name === ',') {
      consume();
      this.openSettings();
      return;
    }
    if (name === '?' || (name === '/' && key.shift)) {
      consume();
      this.backFromHelp = this.screen;
      this.go('help');
      return;
    }
    if (name === 'escape') {
      consume();
      this.navigateBack();
      return;
    }
    if (this.screen === 'digest' && this.digestGroup && name === 'p') {
      consume();
      this.run(() => this.controller.stop());
      return;
    }
    if (this.screen === 'digest' && this.digestGroup && name === 'g') {
      consume();
      this.refreshDigest();
      return;
    }
    if (this.screen === 'digest' && this.digestGroup && name === 'return') {
      consume();
      const group = this.subscriptionGroups().find((g) => g.id === this.digestGroup);
      if (group) this.openNewsletterIssues(group);
      return;
    }
    if (this.screen === 'link') {
      if (name === 'return') {
        consume();
        this.openLink();
      }
      return;
    }
    if (['inbox', 'home', 'report'].includes(this.screen) && name === 'l' && !this.isAudit) {
      consume();
      this.openNewsletters();
      return;
    }
    if (this.screen === 'inbox' || (this.screen === 'setup' && this.scope.mode === 'unread')) {
      if (this.screen === 'inbox' && ['1', '2', '3', '4'].includes(name)) {
        consume();
        this.openOutcome(OUTCOMES[Number(name) - 1]);
        return;
      }
      if (this.screen === 'inbox' && name === 'n') {
        consume();
        this.openSetup('unread');
        return;
      }
      if (['up', 'down', 'j', 'k', 'tab'].includes(name)) {
        consume();
        if (!this.rows.length) return;
        const direction = name === 'up' || name === 'k' || (name === 'tab' && key.shift) ? -1 : 1;
        this.cursor = (this.cursor + direction + this.rows.length) % this.rows.length;
        this.render();
        return;
      }
      if (name === 'return') {
        consume();
        this.current?.action?.();
        return;
      }
      if (name === 'left' || name === 'right') {
        consume();
        if (this.current?.id === 'count') {
          const options = [...new Set([50, 100, 500, this.scope.limit])]
            .filter((value): value is number => value !== null)
            .sort((a, b) => a - b) as (number | null)[];
          options.push(null);
          const next = options.indexOf(this.scope.limit) + (name === 'left' ? -1 : 1);
          this.scope.limit = options[(next + options.length) % options.length]!;
          this.render();
        } else if (this.current?.id === 'mode') {
          this.chooseMode(name === 'left' ? 'adhoc' : 'live');
        } else if (this.current?.id === 'order') {
          this.current.action?.();
        }
        return;
      }
      if (name === 'v') {
        consume();
        this.openDigest(
          'Unread inbox summary',
          this.period === 'all'
            ? this.controller.inboxSummary
            : dashboardSummary(this.controller.pool, this.period, this.config.analysisLanguage),
        );
        return;
      }
      if (name === 'r') {
        consume();
        this.run(() => this.controller.refreshInboxSummary());
        return;
      }
      if (name === 'u') {
        consume();
        this.run(() => this.controller.syncInbox());
        return;
      }
      if (name === 'c') {
        consume();
        if (this.controller.mode !== 'adhoc' || this.controller.busy || this.controller.mutating)
          return;
        if (this.screen === 'inbox') this.openSetup('unread');
        this.customCount = true;
        this.render();
        return;
      }
      if (name === 'p') {
        consume();
        this.run(() => this.controller.stop());
        return;
      }
    }
    if (this.screen === 'home') {
      if (['up', 'down', 'j', 'k', 'tab', 'home', 'end'].includes(name)) {
        consume();
        const delta = name === 'up' || name === 'k' || (name === 'tab' && key.shift) ? -1 : 1;
        this.cursor =
          name === 'home'
            ? 0
            : name === 'end'
              ? this.rows.length - 1
              : Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
        this.render();
        return;
      }
      if (name === 'return') {
        consume();
        this.current?.action?.();
        return;
      }
      if (['1', '2', '3', '4'].includes(name)) {
        consume();
        this.openOutcome(OUTCOMES[Number(name) - 1]);
        return;
      }
    }
    if ((this.screen === 'home' || this.screen === 'setup') && name === 's') {
      consume();
      this.openSetup('subscriptions');
      return;
    }
    if (this.screen === 'setup' && name === 'c') {
      consume();
      this.customCount = true;
      this.render();
      return;
    }
    if (this.screen === 'reader') {
      const m =
        this.viewMessages.find((m) => m.id === this.readerID) ??
        this.controller.saved.library?.[this.readerID ?? ''];
      if (!m) return;
      if (name === 'tab') {
        consume();
        this.leaveReader();
      } else if (name === 'return') {
        consume();
      } else if (name === 'left') {
        consume();
        this.leaveReader();
      }
      return;
    }
    if (this.screen !== 'report') return;
    if (name === 'tab') {
      consume();
      this.focusPane(this.pane === 'reader' ? 'list' : 'reader');
      return;
    }
    if (
      name === 'right' &&
      this.pane === 'list' &&
      (this.current?.message || this.current?.newsletter)
    ) {
      consume();
      this.focusPane('reader');
      return;
    }
    if (name === 'left' && this.pane === 'reader') {
      consume();
      this.focusPane('list');
      return;
    }
    if (['1', '2', '3', '4'].includes(name)) {
      consume();
      if (!this.isAudit) this.openOutcome(OUTCOMES[Number(name) - 1]);
      else if (name === '1' || name === '2') {
        this.tab = name === '1' ? 'emails' : 'subscriptions';
        this.senderID = undefined;
        this.selected.clear();
        this.go('report');
      }
    } else if (name === 'f' && this.tab === 'emails') {
      consume();
      if (this.isAudit) {
        this.notice = 'No priority filters in the sender audit; / searches messages.';
        this.render();
        return;
      }
      this.outcome = OUTCOMES[(OUTCOMES.indexOf(this.outcome) + 1) % OUTCOMES.length];
      this.failedReviews = false;
      this.selected.clear();
      this.cursor = 0;
      this.rows = [];
      this.render();
    } else if (name === 'n') {
      consume();
      this.openSetup(this.controller.session?.scope.mode ?? 'unread');
    } else if (name === 'u' && this.current?.sender?.unsubscribe) {
      consume();
      this.link = this.current.sender.unsubscribe;
      this.go('link');
    }
  }
}
