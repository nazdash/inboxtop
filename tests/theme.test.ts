import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { CliRenderer } from '@opentui/core';
import {
  DARK_COLORS,
  LIGHT_COLORS,
  environmentMode,
  terminalColors,
  watchTerminalTheme,
} from '../src/ui/theme.ts';

test('light and dark modes use fixed app palettes with predictable fallbacks', () => {
  expect(terminalColors('light')).toEqual(LIGHT_COLORS);
  expect(terminalColors('dark')).toEqual(DARK_COLORS);
  expect(environmentMode('0;15')).toBe('light');
  expect(environmentMode('15;0')).toBe('dark');
  expect(environmentMode('invalid')).toBe('dark');
});

test('theme observation follows mode changes, ignores terminal colors, and cleans up', () => {
  const emitter = new EventEmitter();
  let paletteQueries = 0;
  const renderer = Object.assign(emitter, {
    themeMode: null,
    getPalette: () => {
      paletteQueries++;
    },
  }) as unknown as CliRenderer;
  const updates: string[] = [];
  const observer = watchTerminalTheme(renderer, (colors) => updates.push(colors.bg));
  emitter.emit('theme_mode', 'light');
  expect(updates.at(-1) ?? observer.colors.bg).toBe(LIGHT_COLORS.bg);
  const count = updates.length;
  emitter.emit('palette', { defaultBackground: '#fff4de', defaultForeground: '#302010' });
  emitter.emit('theme_mode', 'light');
  expect(updates.length).toBe(count);
  observer.dispose();
  expect(emitter.listenerCount('theme_mode')).toBe(0);
  expect(emitter.listenerCount('palette')).toBe(0);
  // Loading-screen handoff retains the detected mode even when no getter is available.
  const next = watchTerminalTheme(renderer, (colors) => updates.push(colors.bg));
  expect(next.colors).toEqual(LIGHT_COLORS);
  emitter.emit('theme_mode', 'dark');
  expect(updates.at(-1)).toBe(DARK_COLORS.bg);
  next.dispose();
  const finishedCount = updates.length;
  emitter.emit('theme_mode', 'light');
  expect(updates.length).toBe(finishedCount);
  expect(paletteQueries).toBe(0);
});
