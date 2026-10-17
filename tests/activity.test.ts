import { test, expect } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { TextRenderable, InputRenderable } from '@opentui/core';
import { ActivityIndicator } from '../src/ui/activity.ts';

const text = (node: TextRenderable) => node.chunks.map((chunk) => chunk.text).join('');

test('activity ticks preserve nodes and input, bound elapsed width, and stop without replacing results', async () => {
  const h = await createTestRenderer({ width: 40, height: 18 });
  let now = 0;
  const activity = new ActivityIndicator(() => now);
  const status = new TextRenderable(h.renderer, { width: 38, height: 1, wrapMode: 'none' });
  const input = new InputRenderable(h.renderer, { value: 'Unsent question', width: 38 });
  h.renderer.root.add(status);
  h.renderer.root.add(input);
  input.focus();
  input.cursorOffset = 5;
  try {
    activity.bind({ node: status, key: 'reply', label: 'Preparing answer…' });
    await h.flush();
    const first = text(status);
    await Bun.sleep(210);
    await h.flush();
    expect(text(status)).not.toBe(first);
    expect(text(status).slice(2)).toBe('Preparing answer…');
    expect(input.focused).toBe(true);
    expect(input.cursorOffset).toBe(5);
    expect(input.value).toBe('Unsent question');
    now = 4100;
    activity.bind({ node: status, key: 'reply', label: 'Reading saved email text…' });
    expect(text(status)).toContain('4s');
    status.width = 28;
    await h.flush();
    await Bun.sleep(210);
    expect(text(status)).not.toContain('4s');
    expect(status.height).toBe(1);
    // Replacing the renderable for the same operation keeps its elapsed clock.
    const replacement = new TextRenderable(h.renderer, { width: 38, height: 1 });
    h.renderer.root.add(replacement);
    await h.flush();
    activity.bind({ node: replacement, key: 'reply', label: 'Preparing answer…' });
    expect(text(status)).toBe('Reading saved email text…');
    expect(text(replacement)).toContain('4s');
    activity.bind({ node: replacement, key: 'write', label: 'Marking read · 1/3' });
    expect(text(replacement)).not.toContain('4s');
    replacement.content = '2 changes verified · 1 unconfirmed';
    activity.bind();
    await Bun.sleep(210);
    expect(text(replacement)).toBe('2 changes verified · 1 unconfirmed');
    activity.bind({ node: status, key: 'sync', label: 'Syncing inbox…' });
    status.destroy();
    await Bun.sleep(210);
    expect((activity as any).timer).toBeUndefined();
  } finally {
    activity.dispose();
    await h.dispose();
  }
});
