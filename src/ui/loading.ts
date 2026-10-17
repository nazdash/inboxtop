import { ActivityIndicator } from './activity.ts';
import {
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { watchTerminalTheme, type ThemeColors } from './theme.ts';
import { clean } from '../domain.ts';

/** Startup owns this small shell until the controller is ready for the inbox UI. */
export class LoadingScreen {
  private colors: ThemeColors;
  private stopTheme: () => void;
  private brand: TextRenderable;
  private footer: TextRenderable;
  private failed = false;
  private root: BoxRenderable;
  private title: TextRenderable;
  private status: TextRenderable;
  private activity: TextRenderable;
  private indicator = new ActivityIndicator();
  private disposed = false;
  private key = (event: KeyEvent) => {
    if (event.name === 'q' || (event.ctrl && event.name === 'c')) {
      event.preventDefault();
      event.stopPropagation();
      this.onQuit();
    }
  };
  constructor(
    private renderer: CliRenderer,
    private onQuit: () => void,
  ) {
    const theme = watchTerminalTheme(renderer, (colors) => this.applyTheme(colors));
    this.colors = theme.colors;
    this.stopTheme = theme.dispose;
    renderer.setBackgroundColor(this.colors.bg);
    this.root = new BoxRenderable(renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      backgroundColor: this.colors.bg,
      paddingX: 1,
      paddingY: 1,
    });
    renderer.root.add(this.root);
    const text = (parent: BoxRenderable, content: string, fg: string, bold = false) => {
      const node = new TextRenderable(renderer, {
        content,
        fg,
        wrapMode: 'word',
        flexShrink: 0,
        attributes: bold ? TextAttributes.BOLD : undefined,
      });
      parent.add(node);
      return node;
    };
    this.brand = text(this.root, 'inboxtop', this.colors.green, true);
    const center = new BoxRenderable(renderer, {
      flexGrow: 1,
      justifyContent: 'center',
      alignItems: 'center',
    });
    this.root.add(center);
    const card = new BoxRenderable(renderer, {
      width: '100%',
      flexDirection: 'column',
      gap: 1,
    });
    center.add(card);
    this.title = text(card, 'Getting your inbox ready', this.colors.text, true);
    this.status = text(card, 'Reading configuration…', this.colors.muted);
    this.status.height = 1;
    this.status.wrapMode = 'none';
    this.activity = text(card, '', this.colors.muted);
    this.activity.visible = false;
    this.footer = text(this.root, 'q / Ctrl+C  Close', this.colors.muted);
    renderer.keyInput.on('keypress', this.key);
    this.update('Reading configuration…');
  }
  private applyTheme(colors: ThemeColors) {
    if (this.disposed) return;
    this.colors = colors;
    this.renderer.setBackgroundColor(colors.bg);
    this.root.backgroundColor = colors.bg;
    this.brand.fg = colors.green;
    this.title.fg = colors.text;
    this.status.fg = this.failed ? colors.red : colors.muted;
    this.activity.fg = this.footer.fg = colors.muted;
  }
  update(message: string) {
    if (!this.disposed && !this.failed)
      this.indicator.bind({ node: this.status, key: 'startup', label: clean(message) });
  }
  fail(message: string) {
    if (this.disposed) return;
    this.indicator.dispose();
    this.failed = true;
    this.title.content = 'Could not open inbox';
    this.status.fg = this.colors.red;
    this.status.height = 'auto';
    this.status.wrapMode = 'word';
    this.status.content = clean(message);
    this.activity.visible = true;
    this.activity.content = 'Close the app, fix the issue, then try again.';
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTheme();
    this.indicator.dispose();
    this.renderer.keyInput.off('keypress', this.key);
    this.renderer.root.remove(this.root);
    this.root.destroyRecursively();
  }
}
