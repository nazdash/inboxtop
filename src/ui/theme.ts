import { CliRenderEvents, type CliRenderer } from '@opentui/core';

type Mode = 'light' | 'dark';
export const DARK_COLORS = {
  bg: '#14191f',
  panel: '#1a2129',
  raised: '#24303a',
  line: '#35424d',
  text: '#e9e5dc',
  muted: '#93a2ad',
  green: '#a4d5bd',
  amber: '#e3bd7d',
  red: '#e69b92',
  blue: '#adc6dc',
};
export type ThemeColors = typeof DARK_COLORS;
export const LIGHT_COLORS: ThemeColors = {
  bg: '#ffffff',
  panel: '#f5f6f7',
  raised: '#e5ecef',
  line: '#b3bdc4',
  text: '#20272d',
  muted: '#52616d',
  green: '#24664e',
  amber: '#855300',
  red: '#ad3430',
  blue: '#285e87',
};
export function terminalColors(mode: Mode): ThemeColors {
  return { ...(mode === 'light' ? LIGHT_COLORS : DARK_COLORS) };
}
export function environmentMode(value = process.env.COLORFGBG): Mode {
  const index = Number(value?.split(';').at(-1));
  return value && [7, 15].includes(index) ? 'light' : 'dark';
}
const cached = new WeakMap<CliRenderer, ThemeColors>();

/** Follow OpenTUI's light/dark signal; use only our fixed app palettes. */
export function watchTerminalTheme(renderer: CliRenderer, changed: (colors: ThemeColors) => void) {
  let disposed = false;
  let colors = renderer.themeMode
    ? terminalColors(renderer.themeMode)
    : (cached.get(renderer) ?? terminalColors(environmentMode()));
  const onMode = (mode: Mode) => {
    if (disposed || (mode !== 'light' && mode !== 'dark')) return;
    const next = terminalColors(mode);
    cached.set(renderer, next);
    if (next.bg === colors.bg) return;
    colors = next;
    changed(next);
  };
  renderer.on(CliRenderEvents.THEME_MODE, onMode);
  return {
    colors,
    dispose() {
      disposed = true;
      renderer.off(CliRenderEvents.THEME_MODE, onMode);
    },
  };
}
