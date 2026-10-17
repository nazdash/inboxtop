import { ActivityIndicator } from './activity.ts';
import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  InputRenderable,
  InputRenderableEvents,
  TextAttributes,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
} from '@opentui/core';
import { configFromValues, type Config } from '../config.ts';
import { publicValues, saveProfile, userConfigPath } from '../credentials.ts';
import { testAIConnection, testMailConnection } from '../onboarding.ts';
import { watchTerminalTheme, type ThemeColors } from './theme.ts';
import { SecretEditor } from './secret-editor.ts';

type Page = 'welcome' | 'email' | 'ai' | 'save';
type Values = Record<string, string>;
export type OnboardingResult =
  | { kind: 'saved'; config: Config }
  | { kind: 'demo' }
  | { kind: 'cancel' };
type Services = {
  mail: typeof testMailConnection;
  ai: typeof testAIConnection;
  save: typeof saveProfile;
};
type Row = { name: string; description?: string; run: () => void };
const MAIL_PRESETS = [
  { name: 'Custom IMAP', host: '' },
  { name: 'Gmail', host: 'imap.gmail.com' },
  { name: 'Fastmail', host: 'imap.fastmail.com' },
  { name: 'iCloud', host: 'imap.mail.me.com' },
];
export class OnboardingScreen {
  private root?: BoxRenderable;
  private colors: ThemeColors;
  private stopTheme: () => void;
  private page: Page = 'welcome';
  private index = 0;
  private values: Values;
  private input?: InputRenderable;
  private secret?: SecretEditor;
  private editing?: string;
  private editLabel = '';
  private notice = '';
  private busy = false;
  private saving = false;
  private abort?: AbortController;
  private mailPassed = false;
  private aiPassed = false;
  private mailPreset = 0;
  private customHost = '';
  private disposed = false;
  private resolve!: (value: OnboardingResult) => void;
  readonly result = new Promise<OnboardingResult>((resolve) => {
    this.resolve = resolve;
  });
  private activity = new ActivityIndicator();
  private resize = () => this.render();
  private key = (key: KeyEvent) => {
    if (this.disposed || key.eventType === 'release') return;
    if (key.ctrl && key.name === 'c') {
      key.preventDefault();
      key.stopPropagation();
      this.cancel();
      return;
    }
    if (key.name === 'escape') {
      key.preventDefault();
      key.stopPropagation();
      if (this.saving) return;
      if (this.busy) {
        this.abort?.abort();
        return;
      }
      if (this.editing) {
        this.clearEditor();
        this.render();
      } else if (this.page === 'welcome') this.finish({ kind: 'cancel' });
      else this.go(this.page === 'save' ? 'ai' : this.page === 'ai' ? 'email' : 'welcome');
      return;
    }
    if (this.busy) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (!this.editing && key.name === 'tab') {
      key.preventDefault();
      key.stopPropagation();
      this.index = (this.index + (key.shift ? -1 : 1) + this.rows().length) % this.rows().length;
      this.render();
      return;
    }
    if (this.editing && this.secret) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === 'return') this.commitEdit(this.secret.value);
      else {
        this.secret.key(key);
        this.render();
      }
    }
  };
  private paste = (event: PasteEvent) => {
    if (!this.secret || this.busy) return;
    event.preventDefault();
    event.stopPropagation();
    this.secret.insert(new TextDecoder().decode(event.bytes));
    this.render();
  };
  constructor(
    private renderer: CliRenderer,
    initial = configFromValues({}),
    private path = userConfigPath(),
    private services: Services = {
      mail: testMailConnection,
      ai: testAIConnection,
      save: saveProfile,
    },
    private reconnecting = false,
  ) {
    this.values = {
      ...publicValues(initial),
      EMAIL_PASSWORD: initial.password,
      OPENAI_API_KEY: initial.apiKey,
    };
    this.mailPreset = Math.max(
      0,
      MAIL_PRESETS.findIndex((p) => p.host === initial.host),
    );
    this.customHost = this.mailPreset === 0 ? initial.host : '';
    const theme = watchTerminalTheme(renderer, (colors) => {
      this.colors = colors;
      this.render();
    });
    this.colors = theme.colors;
    this.stopTheme = theme.dispose;
    renderer.keyInput.on('keypress', this.key);
    renderer.keyInput.on('paste', this.paste);
    renderer.on('resize', this.resize);
    this.render();
  }
  cancel() {
    if (this.saving) return;
    this.abort?.abort();
    this.finish({ kind: 'cancel' });
  }
  private finish(value: OnboardingResult) {
    this.dispose();
    this.resolve(value);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.activity.dispose();
    this.abort?.abort();
    this.clearEditor();
    this.values = {};
    this.stopTheme();
    this.renderer.keyInput.off('keypress', this.key);
    this.renderer.keyInput.off('paste', this.paste);
    this.renderer.off('resize', this.resize);
    this.root?.destroyRecursively();
  }
  private clearEditor() {
    this.secret?.clear();
    this.secret = undefined;
    this.input = undefined;
    this.editing = undefined;
  }
  private go(page: Page) {
    this.page = page;
    this.index = 0;
    this.notice = '';
    this.render();
  }
  private edit(field: string, label: string, secret = false) {
    this.editing = field;
    this.editLabel = label;
    if (secret) this.secret = new SecretEditor(this.values[field]);
    this.render();
  }
  private commitEdit(value: string) {
    const field = this.editing!;
    if (this.values[field] !== value) {
      this.values[field] = value;
      if (field === 'IMAP_SERVER') {
        this.mailPreset = 0;
        this.customHost = value;
        this.values.EMAIL_PASSWORD = '';
      }
      if (['EMAIL_ADDRESS', 'EMAIL_PASSWORD', 'IMAP_SERVER', 'IMAP_PORT'].includes(field))
        this.mailPassed = false;
      else this.aiPassed = false;
    }
    this.clearEditor();
    this.notice = '';
    this.render();
  }
  private async test(kind: 'mail' | 'ai') {
    if (this.busy) return;
    let config: Config;
    try {
      config = configFromValues(this.values);
    } catch {
      this.notice = 'Check provider, language, port and local Ollama URL.';
      this.render();
      return;
    }
    this.busy = true;
    this.abort = new AbortController();
    this.notice =
      kind === 'mail'
        ? 'Testing read-only email access…'
        : 'Testing classification and detailed review with fictional text…';
    this.render();
    try {
      await this.services[kind](config, this.abort.signal);
      if (this.abort.signal.aborted) return;
      if (kind === 'mail') this.mailPassed = true;
      else this.aiPassed = true;
      this.notice = 'Test passed. Continue when ready.';
    } catch (error) {
      this.notice =
        error instanceof Error ? error.message : 'Test failed. Check your settings and retry.';
    } finally {
      this.busy = false;
      if (!this.disposed) this.render();
    }
  }
  private async save() {
    if (this.busy || !this.mailPassed || !this.aiPassed) return;
    this.busy = this.saving = true;
    this.notice = 'Saving in the system credential store…';
    this.render();
    try {
      const config = await this.services.save(configFromValues(this.values), this.path);
      this.finish({ kind: 'saved', config });
    } catch {
      this.notice =
        'Could not save securely. Unlock your system credential store and check config-directory access, then retry. Your draft is kept.';
    } finally {
      this.busy = this.saving = false;
      if (!this.disposed) this.render();
    }
  }
  private field(field: string, label: string, secret = false): Row {
    const value = this.values[field];
    return {
      name: `${label}: ${secret ? (value ? '••••••••' : 'Not entered') : value || 'Not entered'}`,
      run: () => this.edit(field, label, secret),
    };
  }
  private rows(): Row[] {
    if (this.page === 'welcome' && this.reconnecting)
      return [
        { name: 'Reconnect email / AI', run: () => this.go('email') },
        { name: 'Back to Settings', run: () => this.finish({ kind: 'cancel' }) },
      ];
    if (this.page === 'welcome')
      return [
        {
          name: 'Try demo',
          description: 'Fictional mail · no credentials or network',
          run: () => this.finish({ kind: 'demo' }),
        },
        {
          name: 'Connect email',
          description: 'One account · credentials stay on this computer',
          run: () => this.go('email'),
        },
      ];
    if (this.page === 'email')
      return [
        {
          name: `Mail provider: ${MAIL_PRESETS[this.mailPreset].name}`,
          run: () => {
            if (!this.mailPreset) this.customHost = this.values.IMAP_SERVER;
            this.mailPreset = (this.mailPreset + 1) % MAIL_PRESETS.length;
            this.values.IMAP_SERVER = MAIL_PRESETS[this.mailPreset].host || this.customHost;
            this.values.IMAP_PORT = '993';
            this.values.EMAIL_PASSWORD = '';
            this.mailPassed = false;
            this.notice = 'Server filled in. Enter an app password for this provider.';
            this.render();
          },
        },
        this.field('EMAIL_ADDRESS', 'Email'),
        this.field('IMAP_SERVER', 'IMAP server'),
        this.field('IMAP_PORT', 'TLS port'),
        this.field('EMAIL_PASSWORD', 'App password', true),
        {
          name: this.mailPassed ? 'Test email ✓' : 'Test email connection',
          run: () => {
            void this.test('mail');
          },
        },
        {
          name: 'Continue → AI',
          run: () => {
            if (this.mailPassed) this.go('ai');
            else {
              this.notice = 'Test the email connection before continuing.';
              this.render();
            }
          },
        },
      ];
    if (this.page === 'ai')
      return [
        {
          name: `Provider: ${this.values.LLM_PROVIDER === 'openai' ? 'OpenAI (paid API)' : 'Ollama (local)'}`,
          run: () => {
            this.values.LLM_PROVIDER = this.values.LLM_PROVIDER === 'openai' ? 'ollama' : 'openai';
            this.aiPassed = false;
            this.render();
          },
        },
        ...(this.values.LLM_PROVIDER === 'openai'
          ? [
              this.field('OPENAI_API_KEY', 'API key', true),
              this.field('OPENAI_MODEL', 'Review model'),
            ]
          : [
              this.field('OLLAMA_API_BASE', 'Local server'),
              this.field('OLLAMA_MODEL', 'Review model'),
              this.field('OLLAMA_CLASSIFIER', 'Classifier'),
            ]),
        {
          name: `Language: ${this.values.ANALYSIS_LANGUAGE === 'en' ? 'English' : 'Russian'}`,
          run: () => {
            this.values.ANALYSIS_LANGUAGE = this.values.ANALYSIS_LANGUAGE === 'en' ? 'ru' : 'en';
            this.aiPassed = false;
            this.render();
          },
        },
        {
          name: this.aiPassed
            ? 'Test AI ✓'
            : this.values.LLM_PROVIDER === 'openai'
              ? 'Test AI · 2 paid requests'
              : 'Test AI · local only',
          run: () => {
            void this.test('ai');
          },
        },
        {
          name: 'Continue → Save',
          run: () => {
            if (this.aiPassed) this.go('save');
            else {
              this.notice = 'Test both AI stages before continuing.';
              this.render();
            }
          },
        },
      ];
    return [
      {
        name: 'Save securely and open inbox',
        description: 'Start analysis when ready',
        run: () => {
          void this.save();
        },
      },
    ];
  }
  private render() {
    if (this.disposed) return;
    const editValue = this.input?.value;
    const caret = this.input?.cursorOffset;
    this.input = undefined;
    this.root?.destroyRecursively();
    this.renderer.setBackgroundColor(this.colors.bg);
    const root = (this.root = new BoxRenderable(this.renderer, {
      id: 'onboarding',
      width: '100%',
      height: '100%',
      paddingX: 1,
      flexDirection: 'column',
      backgroundColor: this.colors.bg,
    }));
    this.renderer.root.add(root);
    const text = (content: string, fg = this.colors.text, bold = false) => {
      const node = new TextRenderable(this.renderer, {
        content,
        fg,
        flexShrink: 0,
        wrapMode: 'word',
        attributes: bold ? TextAttributes.BOLD : undefined,
      });
      root.add(node);
      return node;
    };
    text(
      'inboxtop / ' +
        (this.editing
          ? this.editLabel
          : {
              welcome: 'Welcome',
              email: '1 · Connect email',
              ai: '2 · Choose AI',
              save: '3 · Save setup',
            }[this.page]),
      this.colors.green,
      true,
    );
    text(
      this.page === 'email'
        ? 'Choose a provider or enter a custom server. TLS IMAP · use an app password. OAuth-only accounts are not supported yet.'
        : this.page === 'ai'
          ? this.values.LLM_PROVIDER === 'openai'
            ? 'Selected email text goes to OpenAI. Testing sends fictional text and may incur charges.'
            : 'Email processing stays local. Install models in Ollama first.'
          : this.page === 'save'
            ? `${this.values.EMAIL_ADDRESS}\n${this.values.IMAP_SERVER} · ${this.values.LLM_PROVIDER}\nSecrets go to your OS credential store. Saving returns to Ad hoc; saved reviews remain. Choose a small first batch on the dashboard.`
            : 'Review unread mail, browse subscriptions and ask about analyzed emails.',
      this.colors.muted,
    );
    const body = new BoxRenderable(this.renderer, {
      flexGrow: 1,
      minHeight: 0,
      flexDirection: 'column',
      marginTop: 1,
    });
    root.add(body);
    if (this.editing) {
      const frame = new BoxRenderable(this.renderer, {
        border: true,
        borderStyle: 'rounded',
        borderColor: this.colors.green,
        height: 3,
        flexShrink: 0,
        width: '100%',
        paddingX: 1,
      });
      body.add(frame);
      if (this.secret) {
        const width = Math.max(1, this.renderer.width - 8);
        const start = Math.max(0, this.secret.cursor - width + 1);
        const visible = this.secret.masked.slice(start, start + width);
        const cursor = this.secret.cursor - start;
        frame.add(
          new TextRenderable(this.renderer, {
            id: 'secret-mask',
            content: visible.slice(0, cursor) + '▏' + visible.slice(cursor),
            fg: this.colors.text,
            wrapMode: 'none',
          }),
        );
      } else {
        const input = (this.input = new InputRenderable(this.renderer, {
          id: 'setup-input',
          value: editValue ?? this.values[this.editing] ?? '',
          width: '100%',
          textColor: this.colors.text,
          focusedBackgroundColor: this.colors.raised,
          cursorColor: this.colors.green,
        }));
        frame.add(input);
        input.on(InputRenderableEvents.ENTER, () => this.commitEdit(input.value));
        input.focus();
        if (caret !== undefined) input.cursorOffset = caret;
      }
    } else {
      const rows = this.rows();
      const select = new SelectRenderable(this.renderer, {
        id: 'setup-options',
        flexGrow: 1,
        minHeight: 0,
        width: '100%',
        options: rows.map((row) => ({ ...row, description: row.description ?? '' })),
        selectedIndex: this.index,
        showDescription: this.page === 'welcome' || this.page === 'save',
        textColor: this.colors.text,
        selectedTextColor: this.colors.green,
        selectedBackgroundColor: this.colors.raised,
        showScrollIndicator: true,
      });
      body.add(select);
      select.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
        this.index = index;
      });
      select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
        if (!this.busy) rows[index]?.run();
      });
      if (!this.busy) select.focus();
    }
    const status = this.notice
      ? text(this.notice, this.busy ? this.colors.muted : this.colors.amber)
      : undefined;
    this.activity.bind(
      status && this.busy
        ? {
            node: status,
            key: this.saving ? 'setup-save' : `setup-test:${this.page}`,
            label: this.notice,
            elapsed: false,
          }
        : undefined,
    );
    text(
      this.saving
        ? 'Saving… Please wait.'
        : this.busy
          ? 'Esc Cancel test'
          : this.editing
            ? 'Esc Cancel edit   Enter Keep edit'
            : 'Esc Back   ↑↓ Choose   Enter Select',
      this.colors.green,
    );
  }
}
