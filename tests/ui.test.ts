import { test, expect, spyOn } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import {
  ScrollBoxRenderable,
  TextRenderable,
  InputRenderable,
  TextareaRenderable,
  RGBA,
  TextAttributes,
  MarkdownRenderable,
} from '@opentui/core';
import { Controller } from '../src/controller.ts';
import { DemoMailbox, DemoAnalyzer, demoSession } from '../src/demo.ts';
import { MemoryStore } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';
import { newsletterGroups } from '../src/decisions.ts';
import type { Saved } from '../src/domain.ts';
import { EMPTY_SEARCH } from '../src/chat.ts';
import { TerminalApp } from '../src/ui/app.ts';
import { chatAnswerFixture } from './fixtures/chat-answer.ts';

async function harness(width = 120, height = 36, dashboard = true, saved?: Saved) {
  const store = new MemoryStore();
  store.value = saved ?? { version: 1, cache: {}, session: demoSession() };
  const controller = new Controller(
    new DemoMailbox(),
    new DemoAnalyzer(),
    store,
    'demo',
    'fictional',
  );
  await controller.init();
  const terminal = await createTestRenderer({ width, height, exitOnCtrlC: false });
  const app = new TerminalApp(terminal.renderer, controller, loadConfig(false, {}), true);
  if (dashboard) {
    app.screen = 'home';
    app.render();
  }
  const frame = async () => {
    await terminal.flush();
    return terminal.captureCharFrame();
  };
  const key = async (name: string) => {
    terminal.mockInput.pressKey(name);
    if (name === 'ESCAPE') await Bun.sleep(40);
    await terminal.flush();
  };
  const report = async () => {
    app.screen = 'report';
    app.render();
    await terminal.flush();
  };
  const dispose = async () => {
    await app.dispose();
    await controller.close();
    await terminal.dispose();
  };
  return { ...terminal, app, controller, store, frame, key, report, dispose };
}
function nodeText(node: any): string {
  if (!node) return '';
  return [
    node instanceof TextRenderable ? node.chunks.map((c) => c.text).join('') : (node.title ?? ''),
    ...node.getChildren().map(nodeText),
  ].join('');
}

test('original preview mouse focus and selection preserve text, geometry and scroll; links work by keyboard', async () => {
  for (const [width, height] of [
    [120, 36],
    [80, 24],
    [65, 18],
    [50, 24],
    [40, 18],
  ]) {
    const h = await harness(width, height);
    const opened: string[] = [];
    (h.app as any).openEmailURL = (url: string) => opened.push(url);
    try {
      h.controller.messages[0].body =
        'https://example.com/one\nhttps://example.org/two\n' +
        Array.from({ length: 100 }, (_, i) => `Selectable email line ${i}`).join('\n');
      await h.key('1');
      await h.key('o');
      // Toggling the original preserves list focus.
      const reader = (h.app as any).reader as ScrollBoxRenderable;
      reader.scrollTo(20);
      await h.flush();
      const text = h.renderer.root.findDescendantById('original-email-text') as TextRenderable;
      const position = { y: text.y, top: reader.scrollTop, height: reader.height };
      expect(text.chunks.filter((chunk) => chunk.link)).toHaveLength(2);
      const mouseY = reader.y + Math.floor(reader.height / 2);
      await h.mockMouse.click(text.x + 2, mouseY);
      await h.flush();
      expect((h.app as any).pane).toBe('reader');
      expect(h.renderer.root.findDescendantById('original-email-text')).toBe(text);
      expect({ y: text.y, top: reader.scrollTop, height: reader.height }).toEqual(position);
      await h.mockMouse.drag(text.x + 1, mouseY, text.x + 9, mouseY);
      await h.flush();
      expect(h.renderer.getSelection()?.getSelectedText().length).toBeGreaterThan(0);
      expect(h.renderer.root.findDescendantById('original-email-text')).toBe(text);
      // Very short panes intentionally auto-scroll while dragging near their edges.
      if (reader.height >= 6) expect(reader.scrollTop).toBe(position.top);
      position.top = reader.scrollTop;
      expect(await h.frame()).toContain('Links (2)');
      await h.key('L');
      expect(await h.frame()).toContain('Email links');
      expect(await h.frame()).toContain('https://example.com/one');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      expect(opened).toEqual(['https://example.org/two']);
      expect(h.app.screen).toBe('report');
      expect((h.app as any).reader.scrollTop).toBe(position.top);
      await h.key('L');
      await h.key('ESCAPE');
      expect((h.app as any).previewMode).toBe('original');
      expect((h.app as any).reader.scrollTop).toBe(position.top);
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      await h.dispose();
    }
  }
});

test('failed analyses are in Check manually with keyboard original and retry paths', async () => {
  for (const [width, height] of [
    [120, 36],
    [80, 24],
    [65, 18],
    [50, 24],
    [40, 18],
  ]) {
    const h = await harness(width, height, false);
    let retries = 0;
    h.controller.retry = async () => {
      retries++;
    };
    try {
      const m = h.controller.messages[0];
      m.error = 'Evidence validation failed';
      h.app.render();
      expect(await h.frame()).toContain('1 failed');
      expect(await h.frame()).not.toContain('failed · 4 Check');
      expect(await h.frame()).toContain('4 Check manually');
      await h.key('4');
      expect(h.app.screen).toBe('report');
      expect(nodeText((h.app as any).reader)).toContain('Evidence validation failed');
      expect(nodeText((h.app as any).reader)).not.toContain('Next step unclear');
      expect(nodeText((h.app as any).reader)).not.toContain('AI Summary');
      expect((h.app as any).rows.map((row: any) => row.id)).toEqual([m.id]);
      await h.key('R');
      expect(retries).toBe(1);
      await h.key('o');
      expect((h.app as any).previewMode).toBe('original');
      expect((h.app as any).pane).toBe('list');
      await h.key('ESCAPE');
      expect(h.app.screen).toBe('inbox');
      await h.key('1');
      expect((h.app as any).rows.some((row: any) => row.id === m.id)).toBe(false);
    } finally {
      await h.dispose();
    }
  }
});
function commands(h: Awaited<ReturnType<typeof harness>>) {
  return (h.app as any).reviewCommands() as {
    key: string;
    label: string;
    disabled: boolean;
    primary: boolean;
  }[];
}
async function clickCommand(h: Awaited<ReturnType<typeof harness>>, key: string) {
  const node = h.renderer.root.findDescendantById(`command-${key}`)!;
  expect(node).toBeDefined();
  await h.mockMouse.click(node.x + 1, node.y);
  await h.flush();
}
test('terminal theme changes preserve review focus, selection and settings edits', async () => {
  const h = await harness(80, 24);
  const shell = () => (h.app as any).shell;
  try {
    await h.key('2');
    await h.key(' ');
    const selected = [...h.app.selected];
    const current = (h.app as any).current.id;
    h.renderer.emit('theme_mode', 'light');
    await h.flush();
    expect(shell().backgroundColor.equals(RGBA.fromHex('#ffffff'))).toBe(true);
    expect((h.app as any).current.id).toBe(current);
    expect([...h.app.selected]).toEqual(selected);
    await h.key(',');
    (h.app as any).openModelPicker('openaiModel');
    await h.flush();
    const inputs = (node: any): InputRenderable[] => [
      ...(node instanceof InputRenderable ? [node] : []),
      ...node.getChildren().flatMap(inputs),
    ];
    const input = inputs(shell())[0];
    await h.mockInput.typeText('custom-model');
    const before = input.value;
    h.renderer.emit('theme_mode', 'dark');
    await h.flush();
    expect(inputs(shell())[0]).toBe(input);
    expect(input.value).toBe(before);
    await h.key('ESCAPE');
    expect(shell().backgroundColor.equals(RGBA.fromHex('#14191f'))).toBe(true);
  } finally {
    await h.dispose();
  }
});

test('Esc names the next destination and mouse back follows keyboard navigation at every size', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
  ]) {
    const h = await harness(width, height, false);
    const clickBack = async () => {
      const node = h.renderer.root.findDescendantById('footer-back')!;
      expect(node).toBeDefined();
      expect(node.y).toBeLessThan(height);
      await h.mockMouse.click(node.x + 1, node.y);
      await h.flush();
    };
    try {
      await h.key('1');
      expect(await h.frame()).toContain('Esc Back to inbox');
      await clickBack();
      expect(h.app.screen).toBe('inbox');
      await h.key('l');
      await h.key('RETURN');
      expect(await h.frame()).toContain('Esc Back to subscriptions');
      await h.key('ARROW_RIGHT');
      expect(await h.frame()).toContain('Esc Back to list');
      await clickBack();
      expect(h.app.screen).toBe('report');
      expect(await h.frame()).toContain('Esc Back to subscriptions');
      await clickBack();
      expect(await h.frame()).toContain('Esc Back to inbox');
      await h.key('v');
      expect(await h.frame()).toContain('Esc Back to subscriptions');
      await clickBack();
      expect(h.app.screen).toBe('report');
      await h.key(';');
      expect(await h.frame()).toContain('Esc Close menu');
      await h.key('ESCAPE');
      await h.key(',');
      expect(await h.frame()).toContain('Esc Back to subscriptions');
      await clickBack();
      expect(h.app.screen).toBe('report');
      await h.key('ESCAPE');
      await h.key('n');
      expect(await h.frame()).toContain('Esc Back to inbox');
      await clickBack();
      expect(h.app.screen).toBe('inbox');
    } finally {
      await h.dispose();
    }
  }
});

test('unified main keeps all four groups and Subscriptions visible in both modes as results arrive', async () => {
  for (const [width, height] of [
    [40, 18],
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    try {
      for (const mode of ['adhoc', 'live'] as const) {
        h.controller.saved.mode = mode;
        for (const busy of [false, true]) {
          h.controller.busy = busy;
          h.app.render();
          const frame = await h.frame();
          for (const label of [
            '1 Act',
            '2 Read',
            '3 Can mark as read',
            '4 Check manually',
            'l Browse subscriptions',
            ', Settings',
          ])
            expect(frame).toContain(label);
          expect(frame).not.toContain('Review results');
          if (mode === 'live') {
            expect(frame).not.toContain('New analysis');
            await h.key('n');
            expect(h.app.screen).toBe('inbox');
          }
        }
      }
      h.controller.busy = false;
      h.app.cursor = (h.app as any).rows.findIndex((r: any) => r.id === 'read');
      h.app.render();
      const before = nodeText(h.renderer.root.findDescendantById('outcome-read-metrics'));
      const fresh = structuredClone(h.controller.messages[3]);
      fresh.id = 'new-live-result';
      fresh.uid = 4321;
      h.controller.messages.push(fresh);
      h.controller.changed();
      await h.flush();
      expect(nodeText(h.renderer.root.findDescendantById('outcome-read-metrics'))).not.toBe(before);
      expect((h.app as any).current.id).toBe('read');
      await h.key('RETURN');
      expect(h.app.screen).toBe('report');
      expect((h.app as any).rows.some((r: any) => r.id === fresh.id)).toBe(true);
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      h.controller.busy = false;
      await h.dispose();
    }
  }
});

test('newsletter browser sorts all unread senders, keeps selection and opens originals from combined digests', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
  ]) {
    const h = await harness(width, height, false);
    try {
      await h.key('l');
      expect(h.app.screen).toBe('report');
      expect(await h.frame()).toContain('Latest issue');
      const initial = (h.app as any).current.id;
      await h.key('s');
      expect(await h.frame()).toContain('Issue count');
      const counts = (h.app as any).rows.map((r: any) => r.newsletter.messages.length);
      expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
      expect((h.app as any).current.id).toBe(initial);
      await h.key('s');
      expect(await h.frame()).toContain('Name');
      const names = (h.app as any).rows.map((r: any) => r.newsletter.name);
      expect(names).toEqual(
        [...names].sort((a: string, b: string) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' }),
        ),
      );
      await h.key('s');
      expect(await h.frame()).toContain('Latest issue');
      const group = (h.app as any).current.newsletter;
      const ids = group.messages.map((m: any) => m.id);
      const key = (h.controller as any).digestKey(group.messages);
      const text =
        'Shared themes across the issues.\n\n## Developments\n' +
        'Fictional topic details. '.repeat(35) +
        '\n\nWorth reading: the engineering issue.';
      (h.controller.saved.digests ??= {})[key] = {
        key,
        text,
        messageIDs: ids,
        created: new Date().toISOString(),
      };
      h.controller.changed();
      await h.flush();
      await h.key('TAB');
      expect(nodeText((h.app as any).reader)).toContain('Shared themes across the issues');
      for (const message of group.messages)
        expect(nodeText((h.app as any).reader)).toContain(message.subject);
      (h.app as any).reader.scrollTo(4);
      await h.flush();
      const offset = (h.app as any).reader.scrollTop;
      h.controller.changed();
      await h.flush();
      expect((h.app as any).reader.scrollTop).toBe(offset);
      if (width >= 65) await h.key('ESCAPE');
      await h.key('RETURN');
      expect(h.app.newsletterID).toBe(group.id);
      await h.key('RETURN');
      expect(nodeText((h.app as any).reader)).toContain('Original email');
      expect(nodeText((h.app as any).reader)).toContain(group.messages[0].body);
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      await h.dispose();
    }
  }
});

test.each([40, 50, 65, 79, 80, 120])(
  'Settings stays visible and opens from overview footers at every supported width (%d columns)',
  async (width) => {
    const h = await harness(width, 24, false);
    try {
      for (const cursor of [0, 1, 2, 3, 4]) {
        h.app.cursor = cursor;
        h.app.render();
        const frame = await h.frame();
        expect(frame).toContain(', Settings');
        const button = h.renderer.root.findDescendantById('footer-settings')!;
        expect(button.x + button.width).toBeLessThanOrEqual(width - 1);
        expect(
          nodeText(h.renderer.root.findDescendantById('shortcut-footer')).match(/Settings/g),
        ).toHaveLength(1);
      }
      const button = h.renderer.root.findDescendantById('footer-settings')!;
      await h.mockMouse.click(button.x + 2, button.y);
      await h.flush();
      expect(h.app.screen).toBe('settings');
      await h.key('ESCAPE');
      expect(h.app.screen).toBe('inbox');
      await h.key(',');
      expect(h.app.screen).toBe('settings');
      await h.key('ESCAPE');
      h.app.screen = 'home';
      h.app.render();
      expect(await h.frame()).toContain(', Settings');
      expect(await h.frame()).toContain('4 Check manually');
      const homeButton = h.renderer.root.findDescendantById('footer-settings')!;
      expect(homeButton.x + homeButton.width).toBeLessThanOrEqual(width - 1);
      await h.key(',');
      expect<string>(h.app.screen).toBe('settings');
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  [40, 18],
  [50, 24],
  [64, 30],
])(
  '40–64 column layouts keep review, bulk controls and settings usable (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height, false);
    try {
      let frame = await h.frame();
      expect(frame).not.toContain('Please resize');
      expect(frame).toContain('New analysis');
      expect(frame).toContain('REVIEW · unread');
      expect(frame).toContain('‹ Ad hoc ›');
      h.controller.session!.total = 1775;
      h.app.render();
      expect(await h.frame()).toContain('1775 UNREAD');
      expect(await h.frame()).toContain('1761 not analyzed');
      h.app.screen = 'home';
      h.app.render();
      frame = await h.frame();
      for (const label of ['1 Act', '2 Read', '3 Can mark as read', '4 Check manually'])
        expect(frame).toContain(label);
      h.controller.busy = true;
      h.app.render();
      frame = await h.frame();
      for (const label of ['1 Act', '2 Read', '3 Can mark as read', '4 Check manually'])
        expect(frame).toContain(label);
      expect(frame).toContain('Analyzing');
      h.controller.busy = false;
      await h.key('2');
      frame = await h.frame();
      expect(frame).toContain('Sender');
      expect(frame).toContain('Subject');
      expect(frame).not.toContain('Date');
      expect((h.app as any).reader).toBeDefined();
      for (const key of ['x', 'Space', 'a', '/']) {
        const node = h.renderer.root.findDescendantById(`command-${key}`)!;
        expect(node).toBeDefined();
        expect(node.x).toBeGreaterThanOrEqual(1);
        expect(node.x + node.width).toBeLessThanOrEqual(width - 1);
        expect(node.y + node.height).toBeLessThanOrEqual(height);
      }
      const id = (h.app as any).current.message.id;
      await h.key('TAB');
      expect<string>(h.app.screen).toBe('report');
      expect((h.app as any).pane).toBe('reader');
      expect(h.app.readerID).toBe(id);
      expect(await h.frame()).toContain('o Show original');
      await h.key('x');
      await h.waitFor(() => !h.controller.mutating);
      expect(await h.frame()).toContain('x Mark unread');
      await h.key('x');
      await h.waitFor(() => !h.controller.mutating);
      await h.key('TAB');
      expect<string>(h.app.screen).toBe('report');
      await clickCommand(h, 'a');
      const ids = [...h.app.selected];
      expect(ids.length).toBeGreaterThan(1);
      await clickCommand(h, 'x');
      expect(h.renderer.root.findDescendantById('read-confirmation')).toBeDefined();
      expect([...h.app.selected]).toEqual(ids);
      expect(await h.frame()).toContain('Enter Mark read');
      expect(await h.frame()).toContain('Esc Cancel');
      expect<string>(h.app.screen).toBe('report');
      await h.key('ESCAPE');
      await h.key(';');
      expect(await h.frame()).toContain('Enter Run');
      await h.key('ESCAPE');
      await h.key(',');
      expect<string>(h.app.screen).toBe('settings');
      expect(await h.frame()).toContain('Provider');
      expect(await h.frame()).toContain('OpenAI');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      expect(await h.frame()).toContain('API model ID from your account');
      await h.key('ESCAPE');
      await h.key('ESCAPE');
      await h.key('4');
      expect(commands(h).find((c) => c.key === 'a')!.disabled).toBe(true);
      expect(commands(h).find((c) => c.key === 'b')).toBeUndefined();
      expect(await h.frame()).toContain('Nothing here');
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      h.controller.busy = false;
      await h.dispose();
    }
  },
);

test('short review screens retain usable list and preview panes above the command dock', async () => {
  for (const [width, height] of [
    [40, 18],
    [50, 24],
    [65, 18],
  ]) {
    for (const key of ['1', 'l']) {
      const h = await harness(width, height);
      try {
        h.controller.session!.total = 1775;
        await h.key(key);
        for (const busy of [false, true]) {
          h.controller.busy = busy;
          for (const selected of [false, true]) {
            if (selected) await h.key('a');
            else await h.key('c');
            h.app.render();
            await h.flush();
            const list = h.renderer.root.findDescendantById('review-list-pane')!;
            const preview = h.renderer.root.findDescendantById('review-preview-pane')!;
            const dock = h.renderer.root.findDescendantById('command-dock')!;
            expect(list.height).toBeGreaterThanOrEqual(2);
            expect(preview.height).toBeGreaterThanOrEqual(3);
            expect(list.y + list.height).toBeLessThanOrEqual(preview.y);
            expect(preview.y + preview.height).toBeLessThanOrEqual(dock.y);
            expect(dock.y + dock.height).toBeLessThanOrEqual(height);
          }
        }
      } finally {
        h.controller.busy = false;
        await h.dispose();
      }
    }
  }
});

test('shrinking keeps the list and preview, focused email and scroll', async () => {
  const h = await harness(80, 30);
  try {
    h.controller.messages[0].body = Array.from(
      { length: 100 },
      (_, i) => `Fictional line ${i}`,
    ).join('\n');
    await h.key('1');
    await h.key('o');
    await h.key('TAB'); // Explicitly focus the preview before testing resize.
    const id = h.app.readerID;
    (h.app as any).reader.scrollTo(15);
    await h.flush();
    const scroll = (h.app as any).reader.scrollTop;
    h.resize(40, 30);
    await h.flush();
    expect(h.app.screen).toBe('report');
    expect((h.app as any).pane).toBe('reader');
    expect(h.app.readerID).toBe(id);
    expect((h.app as any).reader.scrollTop).toBe(scroll);
    await h.key('e');
    expect(h.app.screen).toBe('reader');
    await h.key('e');
    expect(h.app.screen).toBe('report');
    expect((h.app as any).current.message.id).toBe(id);
    h.resize(39, 18);
    expect(await h.frame()).toContain('Please resize');
    h.resize(40, 18);
    expect(await h.frame()).toContain('Subject');
    expect((h.app as any).current.message.id).toBe(id);
  } finally {
    await h.dispose();
  }
});

test('dashboard opens a decision queue with a preview and original email', async () => {
  const h = await harness();
  try {
    expect(await h.frame()).toContain('Can mark as read');
    await h.report();
    await h.key('1');
    const initial = await h.frame();
    expect(initial).toContain('Act');
    expect(initial).toContain('A decision before Thursday');
    await h.key('ARROW_DOWN');
    expect(h.app.cursor).toBe(1);
    await h.key('RETURN');
    expect(h.app.screen).toBe('report');
    expect((h.app as any).pane).toBe('reader');
    await h.key('o');
    expect(await h.frame()).toContain('Original email');
    await h.key('ARROW_LEFT');
    expect(h.app.screen).toBe('report');
  } finally {
    await h.dispose();
  }
});

test('compact rows align sender, subject and date above the preview at 80 and 120 columns', async () => {
  for (const [width, height] of [
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    try {
      await h.key('1');
      const lines = (await h.frame()).split('\n');
      const header = lines.find((line) => line.includes('Sender') && line.includes('Subject'))!;
      const first = lines.findIndex((line) => line.includes('[ ] Sarah Chen'));
      const second = lines.findIndex((line) => line.includes('[ ] North Studio'));
      const preview = lines.findIndex((line) => line.includes('Review ·'));
      expect(second).toBe(first + 1);
      expect(preview).toBeGreaterThan(second);
      expect(lines[first].indexOf('Sarah')).toBe(header.indexOf('Sender'));
      expect(lines[first].indexOf('A decision')).toBe(header.indexOf('Subject'));
      expect(lines[first].indexOf('2026-')).toBe(header.indexOf('Date'));
      await h.mockMouse.click(12, second);
      await h.flush();
      expect(h.app.cursor).toBe(1);
      await h.mockMouse.click(12, first);
      await h.flush();
      expect(h.app.cursor).toBe(0);
      await h.key('ARROW_DOWN');
      expect((await h.frame()).split('Review ·')[1]).toContain('Invoice 1042');
      await h.key(' ');
      expect(await h.frame()).toContain('1 selected');
      expect(h.controller.messages.every((message) => !message.read)).toBe(true);
      const tabRow = lines.findIndex((line) => line.includes('1 Act'));
      await h.mockMouse.click(lines[tabRow].indexOf('2 Read') + 2, tabRow);
      await h.flush();
      expect(h.app.outcome).toBe('read');
      expect(h.app.selected.size).toBe(0);
    } finally {
      await h.dispose();
    }
  }
});

test('preview toggles original text, scrolls independently, resizes and expands without losing selection', async () => {
  const h = await harness(80, 24);
  try {
    h.controller.messages[0].body = Array.from({ length: 60 }, (_, i) => `Original line ${i}`).join(
      '\n',
    );
    await h.key('1');
    await h.key('ARROW_RIGHT');
    const before = await h.frame();
    expect(before).toContain('o Show original');
    expect(before).not.toContain('Original line 0');
    await h.key('o');
    expect(await h.frame()).toContain('Original line 0');
    expect((h.app as any).pane).toBe('reader');
    const id = h.app.readerID;
    await h.key('ARROW_DOWN');
    await h.key('ARROW_DOWN');
    const scroll = (h.app as any).reader.scrollTop;
    expect(scroll).toBeGreaterThan(0);
    h.controller.changed();
    await h.flush();
    expect((h.app as any).reader.scrollTop).toBe(scroll);
    expect(h.app.readerID).toBe(id);
    const fraction = (h.app as any).listFraction;
    await h.key('=');
    expect((h.app as any).listFraction).toBeLessThan(fraction);
    await h.key('o');
    expect(await h.frame()).toContain('Please approve');
    expect(await h.frame()).not.toContain('Original line');
    h.resize(100, 30);
    await h.flush();
    expect(h.app.screen).toBe('report');
    expect(h.app.readerID).toBe(id);
    await h.key('e');
    expect(h.app.screen).toBe('reader');
    expect(await h.frame()).toContain('e Collapse');
    await h.key('e');
    expect(h.app.screen).toBe('report');
    expect(h.app.readerID).toBe(id);
    await h.key('e');
    expect(h.app.screen).toBe('reader');
    await h.key('RETURN');
    expect(h.app.screen).toBe('reader');
    await h.key('ESCAPE');
    expect(h.app.screen).toBe('report');
    expect((h.app as any).current.message.id).toBe(id);
    await h.key('ARROW_RIGHT');
    h.resize(65, 18);
    await h.flush();
    expect(h.app.screen).toBe('report');
    expect((h.app as any).pane).toBe('reader');
    expect(h.app.readerID).toBe(id);
  } finally {
    await h.dispose();
  }
});
test('bulk is reviewable, selection toggles, confirmation changes exact set and undo works', async () => {
  const h = await harness();
  try {
    await h.report();
    await h.key('3');
    await h.key('a');
    await h.key('x');
    expect(await h.frame()).toContain('Mark 6 emails as read?');
    expect(h.renderer.root.findDescendantById('read-confirmation')).toBeDefined();
    expect(h.app.selected.size).toBe(6);
    expect(h.controller.messages.some((m) => m.read)).toBe(false);
    await h.key('ESCAPE');
    expect(h.app.selected.size).toBe(6);
    await h.key(' ');
    expect(h.app.selected.size).toBe(5);
    await h.key('x');
    await h.key('RETURN');
    await h.waitFor(() => !h.controller.mutating);
    expect(h.controller.messages.filter((m) => m.read)).toHaveLength(5);
    await h.key('h');
    expect(await h.frame()).toContain('SUCCEEDED');
    await h.key('RETURN');
    await h.waitFor(() => !h.controller.mutating);
    expect(h.controller.messages.filter((m) => m.read)).toHaveLength(4);
  } finally {
    await h.dispose();
  }
});
test('80x24 navigation, search, filter selection reset, resize and help', async () => {
  const h = await harness(80, 24);
  try {
    await h.report();
    await h.key('1');
    expect(await h.frame()).toContain('Act');
    await h.key(' ');
    expect(h.app.selected.size).toBe(1);
    await h.key('f');
    expect(h.app.selected.size).toBe(0);
    await h.key('1');
    await h.key('/');
    await h.mockInput.typeText('Sarah');
    await h.key('RETURN');
    expect(h.app.query).toBe('Sarah');
    expect(await h.frame()).toContain('Sarah Chen');
    await h.key('RETURN');
    expect(h.app.screen).toBe('report');
    expect((h.app as any).pane).toBe('reader');
    await h.key('ESCAPE');
    await h.key('?');
    expect(await h.frame()).toContain('Choose emails. Review results. Decide.');
    h.resize(60, 15);
    expect(await h.frame()).toContain('Please resize');
    h.resize(100, 30);
    expect(await h.frame()).toContain('Choose emails. Review results. Decide.');
  } finally {
    await h.dispose();
  }
});

test('review navigation switches only content panes and search shows editing controls', async () => {
  for (const [width, height] of [
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    try {
      await h.key('1');
      expect(await h.frame()).toContain('Space Select');
      if (width >= 100) expect(await h.frame()).toContain('↑↓ Move');
      await h.key('TAB');
      if (width >= 100) expect(await h.frame()).toContain('↑↓ Scroll');
      expect(await h.frame()).toContain('Tab List');
      await h.key('TAB');
      expect(h.app.screen).toBe('report');
      expect((h.app as any).pane).toBe('list');
      await h.key('/');
      const frame = await h.frame();
      expect(frame).toContain('Enter apply');
      expect(frame).toContain('Esc cancel');
      expect(h.renderer.root.findDescendantById('command-dock')).toBeUndefined();
    } finally {
      await h.dispose();
    }
  }
});

test('view controls stay near content while email actions stay in the dock', async () => {
  const h = await harness(80, 24);
  try {
    await h.key('2');
    expect(!!h.renderer.root.findDescendantById('list-controls')).toBe(true);
    expect(!!h.renderer.root.findDescendantById('view-controls')).toBe(true);
    expect(h.renderer.root.findDescendantById('message-actions')).toBeUndefined();
    const dock = () => nodeText(h.renderer.root.findDescendantById('command-dock'));
    expect(dock()).toContain('Space Select');
    expect(dock()).toContain('a Select all');
    expect(dock()).not.toContain('Mark all read');
    expect(commands(h).some((c) => c.key === 'b')).toBe(false);
    await h.key('b');
    expect(h.app.screen).toBe('report');
    expect(h.app.selected.size).toBe(0);
    expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    await h.key(';');
    expect(nodeText(h.renderer.root.findDescendantById('command-dock'))).not.toContain(
      'Mark all read',
    );
    await h.key('ESCAPE');
    expect(dock()).toContain('r Re-analyze');
    await clickCommand(h, 'Space');
    expect(h.app.selected.size).toBe(1);
    expect(dock()).toContain('Space Deselect');
    await h.key('TAB');
    expect(dock()).toContain('Preview · 1 selected');
    expect(dock()).toContain('x Mark 1 read');
    expect(dock()).toContain('c Clear selection');
    expect(dock()).not.toContain('o Show original');
    expect(nodeText(h.renderer.root.findDescendantById('view-controls'))).toContain(
      'o Show original',
    );
    expect(dock()).not.toContain('Re-analyze');
    await clickCommand(h, 'c');
    expect((h.app as any).pane).toBe('reader');
    expect(dock()).toContain('r Re-analyze');
    expect(h.app.selected.size).toBe(0);
  } finally {
    await h.dispose();
  }
});

test('review dock keeps one status row and puts secondary subscription commands in More', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    try {
      await h.key('l');
      await h.key(' ');
      h.controller.busy = true;
      h.controller.status = 'Preparing combined newsletter digest…';
      h.app.render();
      await h.flush();
      const dock = h.renderer.root.findDescendantById('command-dock')!;
      expect(nodeText(dock)).toContain('Preparing digest');
      expect(nodeText(dock)).not.toContain('Classified');
      expect(nodeText(dock)).not.toContain('Fetched');
      expect(h.renderer.root.findDescendantById('command-metadata')!.height).toBe(1);
      for (const key of ['x', 'Space', 'a', 'c'])
        expect(h.renderer.root.findDescendantById(`command-${key}`)).toBeDefined();
      for (const key of ['s', 'v', '/'])
        expect(!!h.renderer.root.findDescendantById(`command-${key}`)).toBe(true);
      for (const key of ['g', 'Enter'])
        expect(!!h.renderer.root.findDescendantById(`command-${key}`)).toBe(false);
      expect(nodeText(dock)).not.toContain('Sort:');
      expect(nodeText(dock)).not.toContain('/ Search');
      expect(nodeText(dock)).toContain('; More actions');
      expect(dock.y + dock.height).toBeLessThanOrEqual(height);
      await h.key(';');
      const menu = (h.app as any).menuCommands();
      expect(menu.some((c: any) => c.key === 's')).toBe(true);
      // An unrelated busy operation does not prevent queuing this sender's summary.
      expect(menu.some((c: any) => c.key === 'g' && !c.disabled)).toBe(true);
      await h.key('ESCAPE');
      await h.key('c');
      expect(h.renderer.root.findDescendantById('command-Enter')).toBeDefined();
      expect(nodeText(h.renderer.root.findDescendantById('command-s'))).toContain(
        'Sort: Latest issue',
      );
      await h.key('s');
      expect(nodeText(h.renderer.root.findDescendantById('command-s'))).toContain(
        'Sort: Issue count',
      );
      await h.key('TAB');
      expect(h.renderer.root.findDescendantById('command-v')).toBeDefined();
    } finally {
      h.controller.busy = false;
      await h.dispose();
    }
  }
});

test('menu keeps its selected command through updates and disabled commands cannot run', async () => {
  const h = await harness(65, 18);
  let retries = 0;
  h.controller.retry = async () => {
    retries++;
  };
  try {
    await h.key('1');
    h.controller.messages.at(-1)!.error = 'Fixture failure';
    await h.key(';');
    const index = (h.app as any).menuCommands().findIndex((c: any) => c.key === 'R');
    for (let i = 0; i < index; i++) await h.key('ARROW_DOWN');
    expect((h.app as any).menuKey).toBe('R');
    h.controller.busy = true;
    h.controller.changed();
    await h.flush();
    h.resize(80, 24);
    await h.flush();
    expect((h.app as any).menuKey).toBe('R');
    await h.key('RETURN');
    await clickCommand(h, 'R');
    expect(retries).toBe(0);
    expect((h.app as any).moreActions).toBe(true);
    h.controller.busy = false;
    h.controller.changed();
    await h.flush();
    await h.key('RETURN');
    expect(retries).toBe(1);
    expect((h.app as any).pane).toBe('list');
    expect((h.app as any).moreActions).toBe(false);
  } finally {
    h.controller.busy = false;
    await h.dispose();
  }
});

test('simple reading recommendations omit redundant action titles and idle status', async () => {
  const h = await harness(80, 24);
  try {
    await h.key('2');
    const message = (h.app as any).current.message;
    message.analysis.action = 'Read';
    message.analysis.deadline = null;
    message.analysis.secondary_actions = [];
    message.analysis.blockers = [];
    h.controller.status = 'Stopped · classifications and summaries saved.';
    h.app.render();
    await h.flush();
    const content = nodeText((h.app as any).reader);
    expect(content).toContain('AI Summary');
    expect(content).not.toContain('Next step:');
    expect(content).not.toContain('INBOXTOP');
    expect(await h.frame()).not.toContain('Stopped');
    message.analysis.action = 'Confirm your attendance by Friday';
    h.app.render();
    await h.flush();
    expect(nodeText((h.app as any).reader)).toContain('Next step: Confirm your attendance');
  } finally {
    await h.dispose();
  }
});

test('email review keeps summary and amber next steps in one panel at every width', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    try {
      await h.key('1');
      const message = (h.app as any).current.message;
      message.analysis.takeaway = 'The revised budget is ready for approval.';
      message.analysis.action = 'Approve the budget.';
      message.analysis.deadline = 'Thursday';
      message.analysis.secondary_actions = ['Notify the team.'];
      message.analysis.blockers = ['Finance sign-off'];
      for (const expanded of [false, true]) {
        if (expanded) await h.key('e');
        h.app.render();
        await h.flush();
        const nodes = (node: any): any[] => [node, ...node.getChildren().flatMap(nodes)];
        const all = nodes((h.app as any).reader);
        const panels = all.filter((node) => node.title?.trim() === 'AI Summary');
        expect(panels).toHaveLength(1);
        const panel = panels[0];
        const content = nodeText(panel);
        expect(content).toContain('Next step: Approve the budget.');
        expect(content.indexOf(message.analysis.takeaway)).toBeLessThan(
          content.indexOf('Next step:'),
        );
        expect(content).toContain('When: Thursday');
        expect(content).toContain('• Notify the team.');
        expect(content).toContain('Needs: Finance sign-off');
        expect(
          all.some((node) => node instanceof TextRenderable && nodeText(node) === 'Action'),
        ).toBe(false);
        const texts = nodes(panel).filter((node) => node instanceof TextRenderable);
        const summary = texts.find((node) => nodeText(node) === message.analysis.takeaway);
        const next = texts.find((node) => nodeText(node).startsWith('Next step:'));
        expect(summary).toBeDefined();
        expect(next).toBeDefined();
        expect(summary!.fg.equals(RGBA.fromHex((h.app as any).colors.text))).toBe(true);
        expect(next!.fg.equals(RGBA.fromHex((h.app as any).colors.amber))).toBe(true);
        expect(next!.y).toBeGreaterThan(summary!.y);
        // All content remains keyboard-scrollable, including in the compact preview.
        if (!expanded) await h.key('TAB');
        await h.key('END');
        expect(await h.frame()).toContain('Finance sign-off');
        expect(h.controller.messages.every((m) => !m.read)).toBe(true);
      }
    } finally {
      await h.dispose();
    }
  }
});

test('re-analysis is visible in list and preview with shared shortcut, mouse and menu availability', async () => {
  for (const [width, height] of [
    [40, 18],
    [50, 24],
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    const calls: string[] = [];
    h.controller.reviewOne = async (id) => {
      calls.push(id);
    };
    try {
      await h.key('1');
      const id = (h.app as any).current.message.id;
      expect(await h.frame()).toContain('r Re-analyze');
      const button = h.renderer.root.findDescendantById('command-r')!;
      expect(button.y + button.height).toBeLessThanOrEqual(height);
      expect(commands(h).some((c) => c.key === 'r')).toBe(true);
      await h.key('r');
      expect(calls).toEqual([id]);
      expect((h.app as any).pane).toBe('list');
      await h.key(' ');
      await h.key('e');
      expect(commands(h).some((c) => c.key === 'r')).toBe(false);
      await h.key('r');
      expect(calls).toHaveLength(1);
      await h.key('c');
      await clickCommand(h, 'r');
      expect(calls).toEqual([id, id]);
      h.controller.busy = true;
      h.controller.changed();
      await h.flush();
      expect(commands(h).find((c) => c.key === 'r')!.disabled).toBe(false);
      await h.key('r');
      await clickCommand(h, 'r');
      expect(calls).toHaveLength(4);
      h.controller.busy = false;
      h.controller.changed();
      await h.flush();
      expect(commands(h).find((c) => c.key === 'r')!.disabled).toBe(false);
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      h.controller.busy = false;
      await h.dispose();
    }
  }
});

test('re-analysis shows immediate progress on its button and preserves the open reader', async () => {
  const h = await harness(80, 24);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  h.controller.analyzer.analyze = async (message) => {
    calls++;
    await pending;
    return structuredClone(message.analysis!);
  };
  try {
    await h.key('1');
    await h.key('e');
    await h.key('o');
    const reader = (h.app as any).reader;
    const scroll = reader.scrollTop;
    await h.key('r');
    expect(await h.frame()).toContain('Re-analyzing…');
    expect(nodeText(h.renderer.root.findDescendantById('focus-reader'))).toContain('Re-analyzing…');
    expect((h.app as any).reader === reader).toBe(true);
    expect(reader.scrollTop).toBe(scroll);
    expect(commands(h).find((a) => a.key === 'r')!.disabled).toBe(true);
    await h.key('r');
    expect(calls).toBe(1);
    finish();
    await h.waitFor(() => !h.controller.busy);
    expect(await h.frame()).toContain('r Re-analyze');
    expect(await h.frame()).not.toContain('Re-analyzing…');
    expect((h.app as any).reader.scrollTop).toBe(scroll);
  } finally {
    finish();
    await h.dispose();
  }
});

test('subtle headings identify keyboard and mouse focus without an actions zone', async () => {
  for (const [width, height] of [
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    const active = (zone: string) =>
      expect(nodeText(h.renderer.root.findDescendantById(`focus-${zone}`))).toContain('▶');
    try {
      await h.key('1');
      const id = (h.app as any).current.message.id;
      active('list');
      await h.key('TAB');
      active('reader');
      await h.key('TAB');
      active('list');
      expect((h.app as any).current.message.id).toBe(id);
      expect(h.renderer.root.findDescendantById('focus-actions')).toBeUndefined();
      if (height >= 24) {
        let reader = (h.app as any).reader;
        await h.mockMouse.click(reader.x + 2, reader.y);
        await h.flush();
        active('reader');
        const list = (h.app as any).list;
        await h.mockMouse.click(list.x + 8, list.y);
        await h.flush();
        active('list');
        await h.key('e');
        h.controller.busy = true;
        h.controller.changed();
        await h.flush();
        reader = (h.app as any).reader;
        await h.mockMouse.click(reader.x + 2, reader.y);
        await h.flush();
        active('reader');
        expect(h.app.readerID).toBe(id);
      }
    } finally {
      h.controller.busy = false;
      await h.dispose();
    }
  }
});

test('single-selection hints track the current row and section gaps adapt to terminal height', async () => {
  for (const [width, height] of [
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    const selectionControl = async () => {
      await h.flush();
      return nodeText(h.renderer.root.findDescendantById('command-Space'));
    };
    try {
      await h.key('1');
      const lines = (await h.frame()).split('\n');
      const tabs = lines.findIndex((line) => line.includes('1 Act') && line.includes('2 Read'));
      const heading = lines.findIndex(
        (line) => line.includes('Sender') && line.includes('Subject'),
      );
      expect(heading - tabs).toBe(height >= 30 ? 3 : 2);
      if (height >= 30) {
        expect(lines[tabs + 1].trim()).toBe('');
        const preview = lines.findIndex((line) => line.includes('Review ·'));
        expect(lines[preview - 1].trim()).toBe('');
      }
      expect(await selectionControl()).toContain('Space Select');
      await h.key(' ');
      expect(await selectionControl()).toContain('Space Deselect');
      await h.key('ARROW_DOWN');
      expect(await selectionControl()).toContain('Space Select');
      await h.key('ARROW_UP');
      expect(await selectionControl()).toContain('Space Deselect');
      await h.key(' ');
      expect(await selectionControl()).toContain('Space Select');
      expect(h.app.selected.size).toBe(0);
      await h.key('x');
      await h.waitFor(() => !h.controller.mutating);
      expect(await selectionControl()).not.toContain('Space');
    } finally {
      await h.dispose();
    }
  }
});

test('ready status uses unread analysis counts and preserves operational errors', async () => {
  const h = await harness();
  try {
    await h.key('1');
    h.controller.messages[0].analysis = undefined;
    h.controller.messages[0].error = 'Failed analysis';
    h.controller.status = 'Review ready · 98 ready · 4 retry · 4 classifications reused';
    h.app.render();
    const ready = await h.frame();
    expect(ready).toContain('1 could not be analyzed');
    expect(ready).not.toContain('13 ready to review');
    expect(ready).not.toContain('classifications reused');
    expect(ready).not.toContain('Monitoring');
    h.controller.status = 'Synchronization failed; retrying.';
    h.app.render();
    expect(await h.frame()).toContain('Synchronization failed; retrying.');
    h.controller.status = '3 marked read · 0 skipped or unconfirmed. See history for details.';
    h.app.render();
    expect((h.app as any).progress()).toBe('3 marked read');
  } finally {
    await h.dispose();
  }
});

test('expanded email toggles review and original both ways; Enter does not navigate back', async () => {
  for (const [width, height] of [
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    try {
      await h.key('1');
      await h.key('e');
      const id = h.app.readerID;
      await h.key('RETURN');
      expect(h.app.screen).toBe('reader');
      expect(await h.frame()).toContain('Review ·');
      await h.key('o');
      expect(await h.frame()).toContain('Original ·');
      expect(await h.frame()).toContain('Original email');
      expect(await h.frame()).not.toContain('Summary');
      await h.key('o');
      expect(await h.frame()).toContain('Review ·');
      expect(await h.frame()).not.toContain('Original email');
      const lines = (await h.frame()).split('\n');
      const row = lines.findIndex((line) => line.includes('Show original'));
      const originalX = lines[row].indexOf('Show original');
      await h.mockMouse.click(originalX + 2, row);
      await h.flush();
      expect(await h.frame()).toContain('Original ·');
      expect(h.app.readerID).toBe(id);
      await h.key('ESCAPE');
      expect(h.app.screen).toBe('report');
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      await h.dispose();
    }
  }
});

test.each([
  [65, 18],
  [80, 24],
  [120, 36],
])(
  'More is a keyboard-navigable menu with identical shortcut and click behavior (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height);
    let retries = 0;
    h.controller.retry = async () => {
      retries++;
    };
    try {
      await h.key('1');
      h.controller.messages.at(-1)!.error = 'Retry fixture';
      const id = (h.app as any).current.message.id;
      await h.key(';');
      expect(await h.frame()).toContain('Commands · current email');
      const index = (h.app as any).menuCommands().findIndex((c: any) => c.key === 's');
      for (let i = 0; i < index; i++) await h.key('ARROW_DOWN');
      expect((h.app as any).current.message.id).toBe(id);
      expect(await h.frame()).toContain('Sort: Important first');
      await h.key('RETURN');
      expect(h.app.sort).not.toBe('importance');
      expect((h.app as any).moreActions).toBe(false);
      await h.key(';');
      await h.key('R');
      expect(retries).toBe(1);
      await h.key(';');
      const settingsIndex = (h.app as any).menuCommands().findIndex((c: any) => c.key === ',');
      for (let i = 0; i < settingsIndex; i++) await h.key('ARROW_DOWN');
      await clickCommand(h, ',');
      expect(h.app.screen).toBe('settings');
      await h.key('ESCAPE');
      expect(h.app.screen).toBe('report');
      await h.key(';');
      await h.key('ESCAPE');
      expect(h.app.screen).toBe('report');
      expect((h.app as any).moreActions).toBe(false);
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      await h.dispose();
    }
  },
);

test('refresh shortcuts target the labeled summary, list, or newsletter digest', async () => {
  const h = await harness();
  let summaries = 0;
  let digestIDs: string[] = [];
  h.controller.refreshInboxSummary = async () => {
    summaries++;
  };
  h.controller.reviewNewsletter = async (ids) => {
    digestIDs = ids;
  };
  try {
    const lines = (await h.frame()).split('\n');
    const row = lines.findIndex((line) => line.includes('r Refresh summary'));
    await h.mockMouse.click(lines[row].indexOf('r Refresh summary') + 3, row);
    await h.flush();
    expect(summaries).toBe(1);
    await h.key('r');
    expect(summaries).toBe(2);
    await h.key('ESCAPE');
    expect(h.app.screen).toBe('inbox');
    await h.key('r');
    expect(summaries).toBe(3);
    h.app.screen = 'home';
    h.app.render();
    await h.key('1');
    await h.key('g');
    expect<string>(h.app.screen).toBe('report');
    expect(summaries).toBe(3);
    await h.key('l');
    expect(commands(h).find((c) => c.key === 'g')?.label).toBe('Generate summary');
    const expected = (h.app as any).current.newsletter.messages.map((m: any) => m.id);
    await h.key('g');
    expect(digestIDs).toEqual(expected);
    expect(h.controller.messages.every((m) => !m.read)).toBe(true);
  } finally {
    await h.dispose();
  }
});

test('home has exactly four decisions and opens Read summaries and newsletter groups', async () => {
  const h = await harness(80, 24);
  try {
    const home = await h.frame();
    for (const label of ['Act', 'Read', 'Can mark as read', 'Check manually'])
      expect(home).toContain(label);
    for (const old of [
      'Review inbox',
      'Continue saved review',
      'Refresh all unread',
      'Keep analysis ready',
    ])
      expect(home).not.toContain(old);
    await h.key('2');
    expect(h.app.outcome).toBe('read');
    expect(await h.frame()).toContain('Read');
    expect(await h.frame()).toContain(h.controller.messages[3].analysis!.takeaway.slice(0, 30));
    await h.key('ESCAPE');
    await h.key('l');
    expect(await h.frame()).toContain('Subscriptions');
    expect(await h.frame()).toContain('issues');
  } finally {
    await h.dispose();
  }
});
test('sender audit is accessible without AI and has no empty Briefing view', async () => {
  const h = await harness(80, 24);
  try {
    h.controller.analyzer.analyze = async () => {
      throw new Error('Audit must never call AI');
    };
    await h.key('s');
    expect(await h.frame()).toContain('Sender audit');
    await h.key('ARROW_DOWN');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await h.waitFor(() => !h.controller.busy);
    expect(h.controller.session?.scope.mode).toBe('subscriptions');
    expect(h.controller.messages).toHaveLength(14);
    expect(await h.frame()).not.toContain('Briefing');
    expect(await h.frame()).toContain('no AI');
    await h.key('1');
    expect(h.app.tab).toBe('emails');
    expect(await h.frame()).not.toContain('Awaiting review');
    expect(await h.frame()).not.toContain('Filter:');
    await h.key('s');
    await h.key('s');
    expect(h.app.sort).toBe('newest');
    await h.key('RETURN');
    await h.key('r');
    expect(commands(h).some((c) => c.key === 'r')).toBe(false);
  } finally {
    await h.dispose();
  }
});
test('one email marks read immediately, the same button restores unread, and undo remains after moving on', async () => {
  const h = await harness(80, 24);
  try {
    await h.report();
    const target = h.controller.messages[0];
    const analysis = target.analysis;
    await h.key('ARROW_RIGHT');
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    expect(h.app.screen).toBe('report');
    expect(target.read).toBe(true);
    expect(h.controller.pool.some((m) => m.id === target.id)).toBe(false);
    expect(h.app.readerID).toBe(target.id);
    const lines = (await h.frame()).split('\n');
    const button = lines.findIndex((line) => line.includes('x Mark unread'));
    expect(button).toBeGreaterThan(0);
    await h.mockMouse.click(lines[button].indexOf('Mark unread') + 2, button);
    await h.waitFor(() => !h.controller.mutating);
    expect(target.read).toBe(false);
    expect(target.analysis).toBe(analysis);
    expect(h.controller.session?.receipts[0].status).toBe('undone');
    // Clicking the button focuses the actions; explicitly return to the preview.
    await h.key('TAB');
    await h.key('ARROW_RIGHT');
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    expect(target.read).toBe(true);
    // Return to the list, then the next email; undo targets the previous email.
    await h.key('ARROW_LEFT');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    expect(h.app.readerID).toBe('demo:INBOX:1:101');
    expect(commands(h).find((c) => c.key === 'z')?.label).toBe('Undo last read');
    await h.key('z');
    await h.waitFor(() => !h.controller.mutating);
    expect(target.read).toBe(false);
    expect(h.controller.messages[1].read).toBe(false);
    expect(target.analysis).toBe(analysis);
  } finally {
    await h.dispose();
  }
});
test('read row stays selected until navigation, supports immediate undo, and preserves list focus', async () => {
  for (const [width, height] of [
    [120, 36],
    [80, 24],
    [65, 18],
  ]) {
    const h = await harness(width, height);
    const rowIDs = () => (h.app as any).rows.map((r: { id: string }) => r.id);
    try {
      await h.report();
      const target = h.controller.messages[0];
      const originalIDs = rowIDs();
      await h.key('x');
      await h.waitFor(() => !h.controller.mutating);
      expect(target.read).toBe(true);
      expect(h.controller.pool.some((m) => m.id === target.id)).toBe(false);
      expect(h.app.screen).toBe('report');
      expect((h.app as any).pane).toBe('list');
      expect(h.app.cursor).toBe(0);
      expect(rowIDs()).toEqual(originalIDs);
      expect(await h.frame()).toContain('[✓]');
      // A background render must not remove the row or steal focus.
      h.controller.changed();
      await h.flush();
      expect(rowIDs()).toEqual(originalIDs);
      await h.key('x');
      await h.waitFor(() => !h.controller.mutating);
      expect(target.read).toBe(false);
      expect(rowIDs()).toEqual(originalIDs);
      await h.key('x');
      await h.waitFor(() => !h.controller.mutating);
      await h.key('ARROW_DOWN');
      expect(rowIDs()).not.toContain(target.id);
      expect(rowIDs()[h.app.cursor]).toBe(originalIDs[1]);
      expect((h.app as any).pane).toBe('list');
      await h.key('z');
      await h.waitFor(() => !h.controller.mutating);
      expect(target.read).toBe(false);
      expect(rowIDs()).toContain(target.id);
      expect(rowIDs()[h.app.cursor]).toBe(originalIDs[1]);
      // Moving up from a retained last row must also preserve the intended target.
      await h.key('END');
      const last = (h.app as any).rows[h.app.cursor].message;
      const beforeLast = rowIDs()[h.app.cursor - 1];
      await h.key('x');
      await h.waitFor(() => !h.controller.mutating);
      expect(rowIDs()).toContain(last.id);
      await h.key('ARROW_UP');
      expect(rowIDs()).not.toContain(last.id);
      expect(rowIDs()[h.app.cursor]).toBe(beforeLast);
    } finally {
      await h.dispose();
    }
  }
});
test('all outcome and subscription issue lists share selection and confirmed bulk read controls', async () => {
  for (const [width, height] of [
    [40, 18],
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    for (const group of ['1', '2', '3', '4', 'subscriptions', 'senders']) {
      const h = await harness(width, height);
      const click = async (label: string) => {
        const lines = (await h.frame()).split('\n');
        const row = lines.findIndex((line) => line.includes(label));
        expect(row).toBeGreaterThanOrEqual(0);
        await h.mockMouse.click(lines[row].indexOf(label) + 2, row);
        await h.flush();
      };
      try {
        if (group === '4') {
          h.controller.messages[0].analysis!.uncertain = true;
          h.controller.messages[0].analysis!.decisionUncertain = true;
        }
        if (group === 'subscriptions' || group === 'senders') {
          await h.key('l');
          if (group === 'subscriptions') await h.key('RETURN');
        } else await h.key(group);
        const ids: string[] = (h.app as any).rows.flatMap((row: any) =>
          row.message ? [row.message.id] : row.newsletter.messages.map((m: any) => m.id),
        );
        expect(ids.length).toBeGreaterThan(0);
        expect(await h.frame()).toContain('a Select all');
        expect(await h.frame()).not.toContain('Mark all read');
        await click('a Select all');
        expect([...h.app.selected]).toEqual(ids);
        expect(await h.frame()).toContain('a Deselect all');
        await h.key('a');
        expect(h.app.selected.size).toBe(0);
        expect(await h.frame()).toContain('a Select all');
        await h.key('a');
        expect([...h.app.selected]).toEqual(ids);
        expect(h.controller.messages.every((m) => !m.read)).toBe(true);
        expect(commands(h).some((c) => c.key === 'b')).toBe(false);
        await click(`x Mark ${ids.length} read`);
        if (ids.length > 1 || group === 'senders') {
          expect(h.renderer.root.findDescendantById('read-confirmation')).toBeDefined();
          expect([...h.app.selected].sort()).toEqual([...ids].sort());
          expect(h.controller.messages.every((m) => !m.read)).toBe(true);
          await h.key('RETURN');
        }
        await h.waitFor(() => !h.controller.mutating);
        for (const message of h.controller.messages)
          expect(message.read).toBe(ids.includes(message.id));
      } finally {
        await h.dispose();
      }
    }
  }
}, 10000);

test('subscription selection and bulk read stay within searched sender groups and issues', async () => {
  const h = await harness(80, 24);
  try {
    await h.key('l');
    const group = (h.app as any).current.newsletter;
    const ids = group.messages.map((m: any) => m.id);
    await h.key(' ');
    expect([...h.app.selected]).toEqual(ids);
    expect((h.app as any).current.name).toContain('[x]');
    await h.key(' ');
    expect(h.app.selected.size).toBe(0);
    await h.key('/');
    await h.mockInput.typeText(group.name);
    await h.key('RETURN');
    await h.key('a');
    expect([...h.app.selected]).toEqual(ids);
    await h.key('x');
    expect(h.renderer.root.findDescendantById('read-confirmation')).toBeDefined();
    expect([...h.app.selected].sort()).toEqual([...ids].sort());
    await h.key('ESCAPE');
    await h.key('RETURN');
    const issue = (h.app as any).current.message;
    await h.key('/');
    await h.mockInput.typeText(issue.subject);
    await h.key('RETURN');
    await h.key('a');
    expect([...h.app.selected]).toEqual([issue.id]);
    await h.key('TAB');
    expect((h.app as any).pane).toBe('reader');
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    expect(h.app.screen).toBe('report');
    expect((h.app as any).pane).toBe('reader');
    expect(h.controller.messages.filter((m) => m.read).map((m) => m.id)).toEqual([issue.id]);
  } finally {
    await h.dispose();
  }
});

test('bulk controls disable for empty groups and respect searches without appearing in the single reader', async () => {
  const h = await harness(80, 24);
  try {
    await h.key('4');
    expect(commands(h).find((c) => c.key === 'b')).toBeUndefined();
    expect(commands(h).find((c) => c.key === 'a')!.disabled).toBe(true);
    await h.key('2');
    const first = (h.app as any).rows[0].message;
    await h.key('/');
    await h.mockInput.typeText(first.subject);
    await h.key('RETURN');
    await h.key('a');
    expect([...h.app.selected]).toEqual([first.id]);
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    expect(h.controller.messages.filter((m) => m.read).map((m) => m.id)).toEqual([first.id]);
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    await h.key('e');
    expect(h.app.screen).toBe('reader');
    expect(await h.frame()).not.toContain('Select all');
    expect(await h.frame()).not.toContain('Mark all read');
    expect(h.controller.messages.every((m) => !m.read)).toBe(true);
  } finally {
    await h.dispose();
  }
});

test('selection takes precedence over the highlighted email in list and preview actions', async () => {
  const h = await harness(80, 24);
  try {
    await h.report();
    await h.key(' ');
    await h.key('ARROW_DOWN');
    await h.key(' ');
    const ids = [...h.app.selected];
    await h.key('ARROW_DOWN');
    await h.key('TAB');
    expect(await h.frame()).toContain('Preview · 2 selected');
    expect(await h.frame()).toContain('x Mark 2 read');
    await clickCommand(h, 'x');
    expect(h.renderer.root.findDescendantById('read-confirmation')).toBeDefined();
    expect([...h.app.selected]).toEqual(ids);
    expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    await h.key('ESCAPE');
    await h.key('c');
    expect(h.app.selected.size).toBe(0);
    expect(await h.frame()).toContain('current email');
  } finally {
    await h.dispose();
  }
});

test('expanded reader preserves bulk scope until selection is cleared', async () => {
  const h = await harness(65, 18);
  try {
    await h.report();
    await h.key(' ');
    await h.key('ARROW_DOWN');
    await h.key(' ');
    const ids = [...h.app.selected];
    await h.key('e');
    const id = h.app.readerID;
    expect(await h.frame()).toContain('Preview · 2 selected');
    expect(await h.frame()).toContain('x Mark 2 read');
    expect(await h.frame()).not.toContain('Re-analyze');
    await h.key('x');
    expect(h.renderer.root.findDescendantById('read-confirmation')).toBeDefined();
    expect([...h.app.selected]).toEqual(ids);
    expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    await h.key('ESCAPE');
    expect(h.app.screen).toBe('reader');
    expect(h.app.readerID).toBe(id);
    await clickCommand(h, 'c');
    expect(await h.frame()).toContain('Preview · current email');
    const target = h.app.readerID;
    await clickCommand(h, 'x');
    await h.waitFor(() => !h.controller.mutating);
    expect(h.app.screen).toBe('reader');
    expect(h.controller.messages.filter((m) => m.read).map((m) => m.id)).toEqual([target!]);
    expect(await h.frame()).toContain('x Mark unread');
  } finally {
    await h.dispose();
  }
});

test('the compact full-screen reader offers immediate read/unread and uncertain writes never offer undo', async () => {
  const h = await harness(65, 18);
  try {
    await h.key('1');
    await h.key('e');
    expect(h.app.screen).toBe('reader');
    const target = h.controller.messages[0];
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    expect(h.app.screen).toBe('reader');
    expect(await h.frame()).toContain('x Mark unread');
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    expect(target.read).toBe(false);
    expect(await h.frame()).toContain('x Mark read');
    h.controller.mail.setRead = async () => {
      throw new Error('Unconfirmed server write');
    };
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    expect(target.read).toBe(false);
    expect(h.controller.session?.receipts[0].status).toBe('unknown');
    expect(await h.frame()).not.toContain('x Mark unread');
    expect(await h.frame()).not.toContain('z Undo');
  } finally {
    await h.dispose();
  }
});
test('mouse selection dismisses the retained read row only when selecting another email', async () => {
  const h = await harness();
  try {
    await h.report();
    const target = h.controller.messages[0];
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    const lines = (await h.frame()).split('\n');
    const row = lines.findIndex((line) => line.includes('[✓]'));
    await h.mockMouse.click(lines[row].indexOf('[✓]') + 5, row);
    await h.flush();
    expect((h.app as any).current.id).toBe(target.id);
    expect((h.app as any).rows.some((r: { id: string }) => r.id === target.id)).toBe(true);
    const nextRow = (await h.frame())
      .split('\n')
      .findIndex((line) => line.includes('[ ]') && line.includes('North Studio'));
    await h.mockMouse.click(10, nextRow);
    await h.flush();
    expect((h.app as any).current.id).toBe(h.controller.messages[1].id);
    expect((h.app as any).rows.some((r: { id: string }) => r.id === target.id)).toBe(false);
  } finally {
    await h.dispose();
  }
});
test('newsletter issue remains visible after marking read, including the last issue from a sender', async () => {
  const h = await harness();
  try {
    await h.key('l');
    await h.key('RETURN');
    const groupID = h.app.newsletterID;
    const target = (h.app as any).current.message;
    expect(target).toBeDefined();
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    expect(target.read).toBe(true);
    expect(h.app.newsletterID).toBe(groupID);
    expect((h.app as any).current.message.id).toBe(target.id);
    expect((h.app as any).pane).toBe('list');
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    expect(target.read).toBe(false);
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    await h.key('ESCAPE');
    expect(h.app.newsletterID).toBeUndefined();
    expect(
      (h.app as any).rows.every(
        (r: any) => !r.newsletter?.messages.some((m: any) => m.id === target.id),
      ),
    ).toBe(true);
  } finally {
    await h.dispose();
  }
});
test('sorting and selection survive confirmation; reader returns to its email', async () => {
  const h = await harness(80, 24);
  try {
    h.controller.messages.reverse();
    await h.report();
    await h.key('RETURN');
    expect(h.app.readerID).toBe('demo:INBOX:1:100');
    await h.key(']');
    expect(h.app.readerID).toBe('demo:INBOX:1:101');
    await h.key(' ');
    await h.key('ESCAPE');
    expect(h.app.selected.has('demo:INBOX:1:101')).toBe(true);
    await h.key('RETURN');
    expect(h.app.readerID).toBe('demo:INBOX:1:101');
    await h.key('ESCAPE');
    await h.key('s');
    await h.key('s');
    expect(h.app.sort).toBe('oldest');
    expect(h.app.selected.has('demo:INBOX:1:101')).toBe(true);
    await h.key('a');
    const order = (h.app as any).rows.map((r: any) => r.id);
    await h.key('x');
    expect(h.renderer.root.findDescendantById('read-confirmation')).toBeDefined();
    expect(h.app.sort).toBe('oldest');
    expect((h.app as any).rows.map((r: any) => r.id)).toEqual(order);
    const frozen = [...h.app.selected];
    h.controller.messages[0].analysis = undefined;
    h.controller.changed();
    await h.flush();
    expect([...h.app.selected]).toEqual(frozen);
  } finally {
    await h.dispose();
  }
});

test('settings choices stay in a draft until Save; provider models and language persist', async () => {
  const h = await harness(80, 24);
  try {
    await h.key(',');
    expect(await h.frame()).toContain('No unsaved changes');
    await h.key('RETURN');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    expect(nodeText(h.renderer.root.findDescendantById('setting-provider'))).toContain('Ollama');
    expect(h.app.config.provider).toBe('openai');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await h.waitFor(() => !(h.app as any).modelsLoading);
    expect(await h.frame()).toContain('Classification model');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    expect((h.app as any).draft.ollamaClassifier).toBe('qwen3.5:9b');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await h.waitFor(() => !(h.app as any).modelsLoading);
    expect(await h.frame()).toContain('Detailed review model');
    await h.key('RETURN');
    expect((h.app as any).draft.ollamaModel).toBe('qwen3.5:4b');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    expect((h.app as any).draft.analysisLanguage).toBe('ru');
    expect(h.app.config.analysisLanguage).toBe('en');
    await h.key('s');
    await h.waitFor(() => !(h.app as any).savingSettings);
    expect(h.controller.saved.settings?.provider).toBe('ollama');
    expect(h.controller.saved.settings?.ollamaClassifier).toBe('qwen3.5:9b');
    expect(h.app.config.analysisLanguage).toBe('ru');
    expect(await h.frame()).toContain('Settings saved');
    await h.key('ESCAPE');
    expect(h.app.screen).toBe('home');
  } finally {
    await h.dispose();
  }
});

test('settings form skips fixed fields, scrolls focused values and keeps its dock visible', async () => {
  for (const [width, height] of [
    [40, 18],
    [50, 24],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    try {
      await h.key(',');
      expect(await h.frame()).toContain('AI');
      expect((h.app as any).settingsFocus).toBe('provider');
      await h.key('ARROW_DOWN');
      expect((h.app as any).settingsFocus).toBe('model');
      await h.key('ARROW_DOWN');
      expect((h.app as any).settingsFocus).toBe('language');
      expect(await h.frame()).toContain('English');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      await h.key('ARROW_DOWN');
      expect((h.app as any).settingsFocus).toBe('excerpt');
      expect(await h.frame()).toContain('3,000 characters');
      const focused = h.renderer.root.findDescendantById('setting-excerpt')!;
      const form = h.renderer.root.findDescendantById('settings-form') as ScrollBoxRenderable;
      expect(focused.y).toBeGreaterThanOrEqual(form.viewport.y);
      expect(focused.y + focused.height).toBeLessThanOrEqual(
        form.viewport.y + form.viewport.height,
      );
      await h.key('ARROW_DOWN');
      expect((h.app as any).settingsFocus).toBe('save');
      expect(await h.frame()).toContain('Enter Run');
      const save = h.renderer.root.findDescendantById('settings-save')!;
      const test = h.renderer.root.findDescendantById('settings-test')!;
      for (const button of [save, test]) {
        expect(button.x).toBeGreaterThanOrEqual(1);
        expect(button.x + button.width).toBeLessThanOrEqual(width - 1);
        expect(button.y + button.height).toBeLessThanOrEqual(height);
      }
      await h.mockMouse.click(save.x + 2, save.y);
      await h.flush();
      expect(h.controller.saved.settings).toBeUndefined();
      h.controller.status = 'Background mailbox refresh';
      h.controller.changed();
      expect(await h.frame()).toContain('No unsaved changes');
      expect(await h.frame()).not.toContain('Background mailbox refresh');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      await h.waitFor(() => !(h.app as any).testingSettings);
      expect(await h.frame()).toContain('Test passed');
      expect(h.controller.saved.settings).toBeUndefined();
    } finally {
      await h.dispose();
    }
  }
});

test('settings validates model edits, preserves typing on resize and cancels without changing the draft', async () => {
  const h = await harness(80, 24);
  try {
    await h.key(',');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    const findInput = (node: any): any =>
      node instanceof InputRenderable ? node : node.getChildren().map(findInput).find(Boolean);
    const editor = findInput(h.renderer.root) as InputRenderable;
    editor.value = 'fictional-model-test';
    h.resize(40, 18);
    await h.flush();
    expect(findInput(h.renderer.root).value).toBe('fictional-model-test');
    expect(await h.frame()).toContain('Enter Keep edit');
    findInput(h.renderer.root).value = 'bad model';
    await h.key('RETURN');
    expect((h.app as any).editingSetting).toBe('openaiModel');
    expect(await h.frame()).toContain('Use 1–160');
    findInput(h.renderer.root).value = 'fictional-valid-model';
    await h.key('RETURN');
    expect((h.app as any).draft.openaiModel).toBe('fictional-valid-model');
    expect(h.app.config.openaiModel).not.toBe('fictional-valid-model');
    await h.key('RETURN');
    findInput(h.renderer.root).value = 'cancelled-edit';
    h.controller.changed();
    await h.flush();
    expect(findInput(h.renderer.root).value).toBe('cancelled-edit');
    await h.key('ESCAPE');
    expect((h.app as any).draft.openaiModel).toBe('fictional-valid-model');
    await h.key('?');
    expect(await h.frame()).toContain('Settings');
    await h.key('ESCAPE');
    expect((h.app as any).draft.openaiModel).toBe('fictional-valid-model');
  } finally {
    await h.dispose();
  }
});

test('leaving changed settings offers keep, save or discard; save failure preserves the draft', async () => {
  const h = await harness(40, 18);
  try {
    await h.key(',');
    await h.key('RETURN');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await h.key('ESCAPE');
    expect(await h.frame()).toContain('Keep editing');
    expect(await h.frame()).toContain('Discard changes');
    await h.key('RETURN');
    expect((h.app as any).draft.provider).toBe('ollama');
    const save = h.controller.saveSettings.bind(h.controller);
    h.controller.saveSettings = async () => {
      throw new Error('Fictional save failure');
    };
    await h.key('s');
    await h.waitFor(() => !(h.app as any).savingSettings);
    expect(await h.frame()).toContain('Fictional save failure');
    expect((h.app as any).settingsDirty).toBe(true);
    expect(h.app.config.provider).toBe('openai');
    await h.key('ESCAPE');
    await h.key('ARROW_DOWN');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    expect(h.app.screen).toBe('home');
    await h.key(',');
    expect((h.app as any).draft.provider).toBe('openai');
    expect((h.app as any).settingsDirty).toBe(false);
    h.controller.saveSettings = save;
    await h.key('RETURN');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await h.key('ESCAPE');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await h.waitFor(() => !(h.app as any).savingSettings);
    expect(h.app.screen).toBe('home');
    expect(h.app.config.provider).toBe('ollama');
  } finally {
    await h.dispose();
  }
});

test('Ollama model discovery failure keeps manual entry available and ignores a late response', async () => {
  const h = await harness(40, 18);
  const fetchMock = spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Fictional Ollama offline'),
  );
  try {
    await h.key(',');
    await h.key('RETURN');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    (h.app as any).demo = false;
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await h.waitFor(() => !(h.app as any).modelsLoading);
    expect(await h.frame()).toContain('Fictional Ollama offline');
    expect(await h.frame()).toContain('Enter model tag');
    await h.key('RETURN');
    const findInput = (node: any): any =>
      node instanceof InputRenderable ? node : node.getChildren().map(findInput).find(Boolean);
    findInput(h.renderer.root).value = 'fictional-classifier:4b';
    await h.key('RETURN');
    expect((h.app as any).draft.ollamaClassifier).toBe('fictional-classifier:4b');
    expect(h.app.config.ollamaClassifier).not.toBe('fictional-classifier:4b');
    let release!: (response: Response) => void;
    fetchMock.mockImplementation(
      Object.assign(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
        { preconnect: () => {} },
      ),
    );
    await h.key('RETURN');
    expect(await h.frame()).toContain('Finding installed models');
    await h.key('ESCAPE');
    release(new Response(JSON.stringify({ models: [{ name: 'late-model:4b' }] })));
    await Bun.sleep(10);
    await h.flush();
    expect((h.app as any).settingsPicker).toBeUndefined();
    expect(await h.frame()).not.toContain('late-model');
    expect((h.app as any).draft.ollamaClassifier).toBe('fictional-classifier:4b');
  } finally {
    fetchMock.mockRestore();
    await h.dispose();
  }
});

test('bulk dock prompt blocks background input and cancels without changing list position or selection', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    try {
      await h.key('3');
      await h.key('a');
      await h.key('ARROW_DOWN');
      const cursor = h.app.cursor;
      const selected = [...h.app.selected];
      const before = await h.frame();
      await h.key('x');
      const prompt = h.renderer.root.findDescendantById('read-confirmation')!;
      const dock = h.renderer.root.findDescendantById('command-dock')!;
      expect(prompt).toBeDefined();
      expect(prompt.width).toBe(width - 2);
      expect(prompt.height).toBe(height >= 30 && width >= 65 ? 7 : 5);
      expect(prompt.y).toBe(dock.y);
      expect(prompt.y + prompt.height).toBeLessThanOrEqual(height);
      expect(h.renderer.root.findDescendantById('review-preview-pane')!.y).toBeLessThan(prompt.y);
      expect(h.renderer.root.findDescendantById('command-actions')).toBeUndefined();
      expect(await h.frame()).not.toContain('need attention');
      expect(h.app.screen).toBe('report');
      for (const key of [' ', 'a', 'c', 'o', 'ARROW_DOWN', 'TAB', 's', 'x', ',']) await h.key(key);
      const list = (h.app as any).list;
      await h.mockMouse.click(list.x + 1, list.y);
      await h.flush();
      expect(h.app.cursor).toBe(cursor);
      expect([...h.app.selected]).toEqual(selected);
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
      const cancel = h.renderer.root.findDescendantById('cancel-read')!;
      await h.mockMouse.click(cancel.x + 1, cancel.y);
      await h.flush();
      expect(h.renderer.root.findDescendantById('read-confirmation')).toBeUndefined();
      expect(h.app.cursor).toBe(cursor);
      expect([...h.app.selected]).toEqual(selected);
      expect(await h.frame()).toBe(before);
      await h.key('x');
      const confirm = h.renderer.root.findDescendantById('confirm-read')!;
      await h.mockMouse.click(confirm.x + 1, confirm.y);
      await h.flush();
      await h.waitFor(() => !h.controller.mutating);
      expect(
        h.controller.messages
          .filter((m) => m.read)
          .map((m) => m.id)
          .sort(),
      ).toEqual(selected.sort());
    } finally {
      await h.dispose();
    }
  }
});

test('subscription confirmation preserves unselected state on cancel and freezes issue IDs through updates and resize', async () => {
  const h = await harness(80, 24);
  try {
    await h.key('l');
    const group = (h.app as any).current.newsletter;
    const ids = group.messages.map((m: any) => m.id);
    await h.key('x');
    expect(h.app.selected.size).toBe(0);
    await h.key('ESCAPE');
    expect(h.app.selected.size).toBe(0);
    expect((h.app as any).current.id).toBe(group.id);
    await h.key('x');
    const incoming = {
      ...structuredClone(group.messages[0]),
      id: 'demo:INBOX:1:999',
      uid: 999,
      subject: 'A later newsletter issue',
    };
    h.controller.saved.library![incoming.id] = incoming;
    h.controller.changed();
    await h.flush();
    h.resize(40, 18);
    await h.flush();
    expect(await h.frame()).toContain(`Mark ${ids.length} emails as read?`);
    expect(h.renderer.root.findDescendantById('read-confirmation')).toBeDefined();
    await h.key('RETURN');
    await h.waitFor(() => !h.controller.mutating);
    expect(
      h.controller.messages
        .filter((m) => m.read)
        .map((m) => m.id)
        .sort(),
    ).toEqual(ids.sort());
    expect(incoming.read).toBe(false);
  } finally {
    await h.dispose();
  }
});

test('background progress does not replace a reader or reset its scroll position', async () => {
  const h = await harness(80, 24);
  try {
    await h.report();
    await h.key('e');
    await h.key('o');
    const scroll = (h.app as any).reader;
    const before = scroll.scrollTop;
    h.controller.busy = true;
    h.controller.changed();
    await h.flush();
    expect((h.app as any).reader === scroll).toBe(true);
    expect(scroll.scrollTop).toBe(before);
    h.controller.busy = false;
    h.controller.changed();
    await h.flush();
    expect((h.app as any).reader.scrollTop).toBe(before);
  } finally {
    h.controller.busy = false;
    await h.dispose();
  }
});

test('the open email shows explicitly updated analysis without changing selection', async () => {
  const h = await harness(80, 24);
  try {
    await h.report();
    await h.key('RETURN');
    const m = h.controller.messages.find((m) => m.id === h.app.readerID)!;
    h.controller.busy = true;
    m.analysis = { ...m.analysis!, takeaway: 'Updated summary while the batch is still running.' };
    h.controller.changed();
    await h.flush();
    await h.key('END');
    expect(await h.frame()).toContain('Updated summary while the batch is still running.');
    expect(h.controller.busy).toBe(true);
  } finally {
    h.controller.busy = false;
    await h.dispose();
  }
});

test('recommendation details start collapsed, toggle by key and mouse, and belong to each email', async () => {
  for (const [width, height] of [
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    const textOf = (node: any): string =>
      [
        node instanceof TextRenderable
          ? node.chunks.map((c) => c.text).join('')
          : (node.title ?? ''),
        ...node.getChildren().map(textOf),
      ].join('\n');
    const content = () => textOf((h.app as any).reader);
    try {
      await h.key('1');
      await h.key('e');
      const id = h.app.readerID;
      expect(content()).toContain('Next step:');
      expect(content()).toContain('AI Summary');
      expect(content()).toContain('When: Thursday');
      expect(commands(h).find((c) => c.key === 'd')!.label).toBe('Why this recommendation');
      expect(content()).not.toContain('Details');
      expect(content()).not.toContain('Quoted evidence');
      expect(content()).not.toContain('Original email');
      await h.key('o');
      expect(content()).toContain('Original email');
      expect(content()).not.toContain('Summary');
      await h.key('o');
      expect(content()).toContain('AI Summary');
      await h.key('d');
      expect(commands(h).find((c) => c.key === 'd')!.label).toBe('Hide explanation');
      expect(content()).toContain('Details');
      expect(content()).toContain('Quoted evidence');
      expect(h.app.readerID).toBe(id);
      h.controller.changed();
      await h.flush();
      expect(content()).toContain('Details');
      await h.key(';');
      const detailIndex = (h.app as any).menuCommands().findIndex((c: any) => c.key === 'd');
      for (let i = 0; i < detailIndex; i++) await h.key('ARROW_DOWN');
      await clickCommand(h, 'd');
      expect(content()).not.toContain('Details');
      await h.key('d');
      await h.key(']');
      expect(h.app.readerID).not.toBe(id);
      expect(content()).not.toContain('Details');
      await h.key('[');
      expect(content()).toContain('Details');
      await h.key('d');
      await h.key('o');
      expect(await h.frame()).toContain('Original email');
      await h.key('e');
      if (height >= 24) {
        await h.key('d');
        expect(content()).toContain('Details');
        await h.key('d');
        expect(content()).not.toContain('Details');
      }
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      await h.dispose();
    }
  }
});

test('digest headings use bold normal text without styling the following paragraph', async () => {
  const h = await harness(80, 24);
  const texts = (node: any): TextRenderable[] => [
    ...(node instanceof TextRenderable ? [node] : []),
    ...node.getChildren().flatMap(texts),
  ];
  try {
    await h.key('l');
    const group = (h.app as any).current.newsletter;
    const key = (h.controller as any).digestKey(group.messages);
    (h.controller.saved.digests ??= {})[key] = {
      key,
      messageIDs: group.messages.map((m: any) => m.id),
      created: new Date().toISOString(),
      text: 'Opening summary.\n\n## Shared themes\nThe following paragraph stays normal.\nIts second line does too.\n\n**Distinct issues**\nAnother normal paragraph.',
    };
    h.controller.changed();
    await h.flush();
    for (const mode of ['dark', 'light'] as const) {
      h.renderer.emit('theme_mode', mode);
      await h.flush();
      for (const expanded of [false, true]) {
        if (expanded) await h.key('v');
        const rendered = texts((h.app as any).reader);
        const normalColor = RGBA.fromHex((h.app as any).colors.text);
        for (const heading of ['Shared themes', 'Distinct issues']) {
          const node = rendered.find((n) => nodeText(n) === heading)!;
          expect(node).toBeDefined();
          expect(node.fg.equals(normalColor)).toBe(true);
          expect(node.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
        }
        for (const body of [
          'Opening summary.',
          'The following paragraph stays normal.\nIts second line does too.',
          'Another normal paragraph.',
        ]) {
          const node = rendered.find((n) => nodeText(n) === body)!;
          expect(node).toBeDefined();
          expect(node.fg.equals(normalColor)).toBe(true);
          expect(node.attributes & TextAttributes.BOLD).toBe(0);
        }
        if (expanded) await h.key('ESCAPE');
      }
    }
  } finally {
    await h.dispose();
  }
});

test('summary progress follows its sender while browsing other groups and clears on completion', async () => {
  for (const [width, height] of [
    [80, 24],
    [40, 18],
  ]) {
    const h = await harness(width, height);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    h.controller.analyzer.digest = async () => {
      calls++;
      await pending;
      return 'Combined sender summary.';
    };
    try {
      await h.key('l');
      const group = (h.app as any).current.newsletter;
      await h.key('g');
      const task = (h.controller as any).task;
      expect(h.controller.newsletterProgress?.messageIDs).toEqual(
        group.messages.map((m: any) => m.id).sort(),
      );
      const status = h.renderer.root.findDescendantById('review-activity')!;
      const preview = (h.app as any).reader;
      const initial = nodeText(status);
      expect(initial).toMatch(/^[|/\\-] Generating summary/);
      await Bun.sleep(210);
      await h.flush();
      expect(nodeText(status)).not.toBe(initial);
      expect(h.renderer.root.findDescendantById('review-activity')).toBe(status);
      expect((h.app as any).reader).toBe(preview);
      expect(nodeText((h.app as any).reader)).toContain('Generating summary from');
      expect(nodeText(h.renderer.root.findDescendantById('command-g'))).toContain('Generating…');
      expect(nodeText(h.renderer.root.findDescendantById('review-activity'))).not.toContain(
        'Analyzing',
      );
      await h.key('ARROW_DOWN');
      expect((h.app as any).current.id).not.toBe(group.id);
      expect(nodeText((h.app as any).reader)).not.toContain('Generating summary from');
      expect(nodeText(h.renderer.root.findDescendantById('command-g'))).toContain(
        'Generate summary',
      );
      expect(nodeText(h.renderer.root.findDescendantById('review-activity'))).toBe('');
      expect((h.app as any).activity.timer).toBeUndefined();
      expect((h.app as any).rows.find((r: any) => r.id === group.id).name).toContain('Generating');
      await h.key('g'); // Another sender is accepted, but waits for the active one.
      expect(calls).toBe(1);
      expect(nodeText(h.renderer.root.findDescendantById('command-g'))).toContain('Queued');
      expect(nodeText(h.renderer.root.findDescendantById('review-activity'))).toBe(
        'Summary queued',
      );
      expect((h.app as any).activity.timer).toBeUndefined();
      await h.key('g'); // Duplicate queue submissions do not add another request.
      expect(h.controller.reviewJobs.filter((j) => j.state === 'queued')).toHaveLength(1);
      await h.key('ARROW_UP');
      expect(nodeText((h.app as any).reader)).toContain('Generating summary from');
      await h.key('v');
      expect(await h.frame()).not.toContain('Analyzing');
      release();
      await task;
      await h.waitFor(() =>
        h.controller.reviewJobs.every((j) => !['queued', 'running'].includes(j.state)),
      );
      await h.flush();
      expect(calls).toBe(2);
      expect(h.controller.newsletterProgress).toBeUndefined();
      expect((h.app as any).activity.timer).toBeUndefined();
      expect(nodeText((h.app as any).reader)).toContain('Combined sender summary');
      expect(nodeText((h.app as any).reader)).not.toContain('Generating summary from');
    } finally {
      release();
      await h.dispose();
    }
  }
});

test('subscription group summary is discoverable, generated once, and opens originals by keyboard', async () => {
  for (const [width, height] of [
    [80, 24],
    [40, 18],
  ]) {
    const h = await harness(width, height);
    try {
      const first = h.controller.messages[3];
      first.sender = 'Summary Sender';
      first.address = 'summary@example.com';
      first.analysis!.takeaway = 'The first issue describes database indexes.';
      const second = structuredClone(first);
      second.id = 'demo:INBOX:1:998';
      second.uid = 998;
      second.subject = 'Safer deployments';
      h.controller.messages.push(second);
      let calls = 0;
      h.controller.analyzer.analyze = async () => {
        throw new Error('Must reuse saved reviews');
      };
      h.controller.analyzer.digest = async (messages) => {
        calls++;
        expect(messages.map((m) => m.id).sort()).toEqual([first.id, second.id].sort());
        return 'One combined overview: faster queries and safer releases.\n\nSafer deployments explains rollback checks.';
      };
      await h.key('l');
      await h.key('/');
      await h.mockInput.typeText('Summary Sender');
      await h.key('RETURN');
      expect(await h.frame()).toContain('Generate summary');
      expect(calls).toBe(0);
      if (width === 40) {
        await h.key('v');
        expect(await h.frame()).toContain('g Generate summary');
        expect(await h.frame()).toContain('Enter Open issues');
      }
      await h.key('g');
      await (h.controller as any).task;
      await h.flush();
      expect(calls).toBe(1);
      const content = nodeText((h.app as any).reader);
      expect(content).toContain('One combined overview');
      expect(content).toContain(second.subject);
      expect(content).not.toContain(first.analysis!.takeaway);
      expect(content).not.toContain('Read in full');
      if (h.app.screen !== 'digest') await h.key('v');
      expect(h.app.screen).toBe('digest');
      await h.key('g');
      expect(calls).toBe(1);
      await h.key('RETURN');
      expect(h.app.newsletterID).toBe('summary@example.com');
      await h.key('RETURN');
      expect(nodeText((h.app as any).reader)).toContain('Original email');
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      await h.dispose();
    }
  }
});

test('subscription browsing shows saved findings and originals without duplicate reading advice or provider calls', async () => {
  const h = await harness(80, 24);
  try {
    const original = h.controller.messages[3];
    original.sender = 'Digest Sender';
    original.address = 'digest@example.com';
    original.analysis!.takeaway = 'First issue covers database indexes.';
    const second = structuredClone(original);
    second.id = 'demo:INBOX:1:999';
    second.uid = 999;
    second.analysis!.takeaway = 'Second issue covers deployment safety.';
    h.controller.messages.push(second);
    h.controller.analyzer.analyze = async () => {
      throw new Error('Browsing must not call AI');
    };
    await h.key('l');
    await h.key('/');
    await h.mockInput.typeText('Digest Sender');
    await h.key('RETURN');
    await h.key('RETURN');
    expect(h.app.newsletterID).toBe('digest@example.com');
    expect((h.app as any).newsletterID).toBe('digest@example.com');
    await h.key('v');
    expect(await h.frame()).toContain('First issue covers database indexes');
    expect(await h.frame()).toContain('Second issue covers deployment safety');
    await h.key('ESCAPE');
    await h.key('RETURN');
    expect(h.app.screen).toBe('report');
    expect((h.app as any).pane).toBe('reader');
    expect(await h.frame()).toContain('Original email');
    await h.key('o');
    expect(nodeText((h.app as any).reader)).not.toContain('Read in full');
    expect(nodeText((h.app as any).reader)).not.toContain('Worth reading:');
    expect(nodeText((h.app as any).reader)).toContain('First issue covers database indexes');
    expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    await h.key('ESCAPE');
    await h.key('ESCAPE');
    await h.key('ESCAPE');
    expect(h.app.screen).toBe('inbox');
  } finally {
    await h.dispose();
  }
});
test('empty dashboard metrics stay muted when selected and keyboard and mouse navigation still work', async () => {
  for (const [width, height] of [
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    const metrics = (id: string) =>
      h.renderer.root.findDescendantById(`outcome-${id}-metrics`) as TextRenderable;
    try {
      await h.frame();
      expect(metrics('check').fg.equals(RGBA.fromHex('#93a2ad'))).toBe(true);
      expect(metrics('act').fg.equals(RGBA.fromHex('#a4d5bd'))).toBe(true);
      await h.key('END');
      expect(h.app.cursor).toBe(5);
      await h.key('ARROW_UP');
      await h.key('ARROW_UP');
      expect(h.app.cursor).toBe(3);
      expect(metrics('check').fg.equals(RGBA.fromHex('#93a2ad'))).toBe(true);
      expect(
        (await h.frame()).split('\n').find((line) => line.includes('4 Check manually')),
      ).toContain('0%');
      await h.key('RETURN');
      expect(h.app.outcome).toBe('check');
      expect(h.app.screen).toBe('report');
      await h.key('ESCAPE');
      await h.key('ARROW_DOWN');
      expect(h.app.cursor).toBe(1);
      const row = h.renderer.root.findDescendantById('outcome-act')!;
      await h.mockMouse.click(row.x + 4, row.y);
      await h.flush();
      expect(h.app.cursor).toBe(0);
      expect(h.app.outcome).toBe('act');
      expect(h.app.screen).toBe('report');
    } finally {
      await h.dispose();
    }
  }
});

test('dashboard groups stay aligned and summary controls work across terminal sizes', async () => {
  for (const [width, height] of [
    [65, 18],
    [80, 24],
    [120, 36],
    [200, 48],
  ]) {
    const h = await harness(width, height);
    try {
      const briefing = 'Approve the budget; review the deployment notices.';
      Object.defineProperty(h.controller, 'inboxSummary', { get: () => briefing });
      let refreshes = 0;
      h.controller.refreshInboxSummary = async () => {
        refreshes++;
      };
      h.app.render();
      const frame = await h.frame();
      const lines = frame.split('\n');
      const rows = ['1 Act', '2 Read', '3 Can mark as read', '4 Check manually'].map(
        (label) => lines.find((line) => line.includes(label))!,
      );
      expect(rows.every(Boolean)).toBe(true);
      expect(new Set(rows.map((line) => line.search(/[━─]/))).size).toBe(1);
      expect(new Set(rows.map((line) => line.indexOf('%'))).size).toBe(1);
      expect(frame.match(/not analyzed/g)).toHaveLength(1);
      expect(frame.indexOf('UNREAD')).toBeLessThan(frame.indexOf('SUMMARY'));
      expect(frame.indexOf('SUMMARY')).toBeLessThan(frame.indexOf('REVIEW ·'));
      expect(frame).toContain(', Settings');
      await h.key('v');
      expect(h.app.screen).toBe('digest');
      expect(await h.frame()).toContain(briefing);
      await h.key('ESCAPE');
      await h.key('r');
      expect(refreshes).toBe(1);
      await h.key('4');
      expect(h.app.screen).toBe('report');
      expect(h.app.outcome).toBe('check');
    } finally {
      await h.dispose();
    }
  }
});
test('both overview screens share coverage and size summaries to fit before scrolling', async () => {
  for (const [width, height] of [
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    let briefing = 'Review the budget request.';
    Object.defineProperty(h.controller, 'inboxSummary', { get: () => briefing });
    const summary = () =>
      h.renderer.root.findDescendantById('inbox-summary') as ScrollBoxRenderable;
    try {
      const render = async (screen: 'inbox' | 'home') => {
        h.app.screen = screen;
        h.app.render();
        const lines = (await h.frame()).split('\n');
        const start = lines.findIndex((line) => line.includes('14 UNREAD'));
        return lines.slice(start, summary().y + summary().height).join('\n');
      };
      expect(await render('inbox')).toBe(await render('home'));
      expect(summary().height).toBe(1);
      expect(summary().scrollHeight).toBeLessThanOrEqual(summary().viewport.height);
      if (width >= 80) {
        briefing =
          'Approve the revised budget and check the older failed-payment notice against your records.\nYour reading includes a practical guide to database performance and this week’s infrastructure newsletter.\nSix routine notifications can be marked read after a quick review.';
        expect(await render('inbox')).toBe(await render('home'));
        expect(summary().height).toBeGreaterThan(2);
        expect(summary().height).toBeLessThanOrEqual(6);
        if (height >= 30)
          expect(summary().scrollHeight).toBeLessThanOrEqual(summary().viewport.height);
      }
      briefing = 'A much longer saved summary with additional topics. '.repeat(100);
      for (const busy of [false, true]) {
        h.controller.busy = busy;
        expect(await render('inbox')).toBe(await render('home'));
        expect(summary().scrollHeight).toBeGreaterThan(summary().viewport.height);
        const frame = await h.frame();
        for (const label of ['1 Act', '2 Read', '3 Can mark as read', '4 Check manually'])
          expect(frame).toContain(label);
        await render('inbox');
        expect(await h.frame()).toContain('REVIEW · unread');
      }
    } finally {
      h.controller.busy = false;
      await h.dispose();
    }
  }
});
test('shared mode selector stays aligned and mode commands preserve review focus', async () => {
  for (const [width, height] of [
    [65, 18],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    try {
      let column: number | undefined;
      for (const screen of ['inbox', 'home', 'report', 'settings'] as const) {
        h.app.screen = screen;
        h.app.render();
        const lines = (await h.frame()).split('\n');
        const row = lines.findIndex((l) => l.includes('inboxtop'));
        expect(lines[row]).toContain('Ad hoc');
        if (height >= 24 || !['inbox', 'home'].includes(screen))
          expect(lines[row + 1]).toContain('─');
        column ??= lines[row].indexOf('Ad hoc');
        expect(lines[row].indexOf('Ad hoc')).toBe(column);
        expect(lines[row + 1]).not.toContain('OpenAI');
      }
      await h.report();
      await h.key('ARROW_RIGHT');
      const screen = h.app.screen;
      const id = h.app.readerID;
      let changed = 0;
      h.controller.setMode = async () => {
        changed++;
      };
      await h.key('m');
      expect(changed).toBe(1);
      expect(h.app.screen).toBe(screen);
      expect(h.app.readerID).toBe(id);
    } finally {
      await h.dispose();
    }
  }
});

test('compact mode selector highlights focus and waits for confirmed changes', async () => {
  for (const [width, height] of [
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    const calls: string[] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.controller.setMode = async (mode) => {
      calls.push(mode);
      if (mode === 'live') await pending;
      h.controller.saved.mode = mode;
    };
    const clickMode = async () => {
      const node = h.renderer.root.findDescendantById('app-mode')!;
      await h.mockMouse.click(node.x + 2, node.y);
      await h.flush();
    };
    try {
      expect(await h.frame()).toContain('‹ Ad hoc ›');
      expect(
        (h.renderer.root.findDescendantById('app-mode') as TextRenderable).bg?.equals(
          RGBA.fromHex('#24303a'),
        ),
      ).toBe(true);
      expect(await h.frame()).toContain('← Ad hoc');
      expect(await h.frame()).toContain('→ Live');
      await h.key('ARROW_DOWN'); // Header no longer has keyboard focus.
      expect(await h.frame()).not.toContain('‹ Ad hoc ›');
      await clickMode();
      expect(calls).toEqual([]);
      await clickMode();
      expect(calls).toEqual(['live']);
      expect(await h.frame()).toContain('Switching to Live');
      expect(await h.frame()).not.toContain('● Live');
      await clickMode();
      await clickMode();
      expect(calls).toEqual(['live']);
      finish();
      await h.waitFor(() => !(h.app as any).modeChanging);
      expect(await h.frame()).toContain('● Live');
      const live = h.renderer.root.findDescendantById('app-mode') as TextRenderable;
      expect(live.fg.equals(RGBA.fromHex('#a4d5bd'))).toBe(true);
      await h.key('m');
      await h.key('ARROW_RIGHT');
      expect(calls).toEqual(['live']);
      await h.key('ARROW_LEFT');
      await h.waitFor(() => !(h.app as any).modeChanging);
      expect(calls).toEqual(['live', 'adhoc']);
      await h.key('ARROW_LEFT');
      expect(calls).toHaveLength(2);
      expect(await h.frame()).toContain('‹ Ad hoc ›');
      expect(nodeText(h.renderer.root.findDescendantById('app-mode'))).not.toContain('Live');
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
    } finally {
      finish();
      await h.dispose();
    }
  }
});

test('all four dashboard decisions remain visible while analysis is running at 80x24', async () => {
  const h = await harness(80, 24);
  try {
    h.controller.busy = true;
    h.app.render();
    const frame = await h.frame();
    for (const label of ['1 Act', '2 Read', '3 Can mark as read', '4 Check manually'])
      expect(frame).toContain(label);
    expect(frame).toContain('Fetched');
  } finally {
    h.controller.busy = false;
    await h.dispose();
  }
});

test('switching mode preserves an expanded email and its scroll position', async () => {
  const h = await harness(80, 24);
  try {
    h.controller.messages[0].body = Array.from(
      { length: 80 },
      (_, i) => `Fictional line ${i}`,
    ).join('\n');
    h.controller.setMode = async (mode) => {
      h.controller.saved.mode = mode;
    };
    await h.key('1');
    await h.key('e');
    await h.key('o');
    const id = h.app.readerID;
    (h.app as any).reader.scrollTo(15);
    await h.flush();
    const scroll = (h.app as any).reader.scrollTop;
    expect(scroll).toBeGreaterThan(0);
    await h.key('m');
    await h.waitFor(() => !(h.app as any).modeChanging);
    await h.flush();
    expect(h.app.screen).toBe('reader');
    expect(h.app.readerID).toBe(id);
    expect((h.app as any).reader.scrollTop).toBe(scroll);
    expect(await h.frame()).toContain('● Live');
  } finally {
    await h.dispose();
  }
});

test('main dashboard opens without analysis; Ad hoc batch controls are a separate panel', async () => {
  const h = await harness(80, 24, false);
  let calls = 0;
  h.controller.analyzer.analyze = async () => {
    calls++;
    throw new Error('No startup analysis');
  };
  try {
    const frame = await h.frame();
    expect(frame).toContain('14 UNREAD');
    expect(frame).toContain('REVIEW · unread');
    expect(frame).toContain('l Browse subscriptions');
    expect(frame.indexOf('New analysis')).toBeLessThan(frame.indexOf('SUMMARY'));
    for (const label of ['1 Act', '2 Read', '3 Can mark as read', '4 Check manually'])
      expect(frame).toContain(label);
    expect(frame).not.toContain('Review results');
    await h.key('n');
    expect(h.app.screen).toBe('setup');
    expect(await h.frame()).toContain('Ad hoc · New analysis');
    expect(await h.frame()).toContain('Oldest first');
    await h.key('ARROW_LEFT');
    expect(h.app.scope.limit).toBe(50);
    await h.key('ARROW_RIGHT');
    expect(h.app.scope.limit).toBe(100);
    await h.key('RETURN');
    expect((h.app as any).customCount).toBe(true);
    await h.key('ESCAPE');
    await h.key('TAB');
    await h.key('ARROW_RIGHT');
    expect(h.app.scope.order).toBe('newest');
    await h.key('ESCAPE');
    expect(h.app.screen).toBe('inbox');
    expect(calls).toBe(0);
  } finally {
    await h.dispose();
  }
});

test('Ad hoc additional batches keep previous results and default to oldest first', async () => {
  const h = await harness(80, 24, false);
  h.controller.saved.library = {};
  h.controller.saved.session = undefined;
  h.app.render();
  try {
    await h.key('n');
    await h.key('RETURN');
    await h.key('END');
    for (let i = 0; i < 3; i++) await h.key('BACKSPACE');
    await h.mockInput.typeText('2');
    await h.key('RETURN');
    expect(h.app.scope.limit).toBe(2);
    await h.key('ARROW_DOWN');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await Bun.sleep(120);
    await h.waitFor(() => !h.controller.busy);
    expect(h.app.screen).toBe('inbox');
    expect(h.controller.session!.uids).toEqual([100, 101]);
    await h.key('n');
    await h.key('ARROW_DOWN');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await Bun.sleep(120);
    await h.waitFor(() => !h.controller.busy);
    expect(h.controller.session!.uids).toEqual([102, 103]);
    expect(h.controller.pool).toHaveLength(4);
    expect(await h.frame()).toContain('4 ready to review');
  } finally {
    await h.dispose();
  }
});

test('stopped sessions offer a fresh Ad hoc batch without a Resume queue', async () => {
  for (const [width, height] of [
    [40, 18],
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    let started = 0;
    h.controller.start = async (scope) => {
      started++;
      expect(scope.limit).toBe(50);
      expect(scope.order).toBe('newest');
    };
    try {
      h.controller.session!.state = 'paused';
      h.app.render();
      expect(await h.frame()).toContain('New analysis');
      expect(await h.frame()).not.toContain('Resume');
      await h.key('n');
      for (const label of ['Batch size', 'Order', 'Start analysis'])
        expect(await h.frame()).toContain(label);
      await h.key('ARROW_LEFT');
      await h.key('TAB');
      await h.key('ARROW_RIGHT');
      expect(started).toBe(0);
      await h.key('TAB');
      await h.key('RETURN');
      expect(started).toBe(1);
    } finally {
      await h.dispose();
    }
  }
});

test('inbox map shows all four completed destinations at 80 columns and returns to dashboard', async () => {
  const h = await harness(80, 24);
  try {
    await h.key('i');
    const map = await h.frame();
    expect(h.app.screen).toBe('overview');
    expect(map).toContain('14 analyzed and waiting');
    for (const label of ['Act', 'Read', 'Can mark as read', 'Check manually'])
      expect(map).toContain(label);
    expect(map).toContain('%');
    await h.key('ESCAPE');
    expect(h.app.screen).toBe('inbox');
    expect(await h.frame()).toContain('14 UNREAD');
    delete h.controller.session!.total;
    h.app.render();
    expect(await h.frame()).toContain('Coverage unknown');
  } finally {
    await h.dispose();
  }
});

test('unfinished mail is not analyzed and never a manual-check decision', async () => {
  const h = await harness(80, 24);
  try {
    for (const m of h.controller.messages) m.analysis = undefined;
    h.controller.busy = true;
    h.app.render();
    const frame = await h.frame();
    expect(frame).toContain('No completed recommendations yet');
    expect(frame).toMatch(/4 Check manually\s+0/);
    expect(frame).toContain('14 not analyzed');
  } finally {
    h.controller.busy = false;
    await h.dispose();
  }
});

test('minimum terminal size keeps four choices visible during processing', async () => {
  const h = await harness(65, 18);
  try {
    h.controller.busy = true;
    h.app.render();
    const frame = await h.frame();
    for (const label of ['1 Act', '2 Read', '3 Can mark as read', '4 Check manually'])
      expect(frame).toContain(label);
    expect(frame).toContain('Analyzing');
  } finally {
    h.controller.busy = false;
    await h.dispose();
  }
});

test('ready review lists stay fixed until Load results; bulk confirmation never adds new arrivals', async () => {
  const h = await harness();
  try {
    await h.key('3');
    const originalIDs = (h.app as any).rows.map((r: any) => r.id);
    const template = h.controller.pool.find((m) => m.uid === 106)!;
    const incoming = {
      ...structuredClone(template),
      id: 'demo:INBOX:1:999',
      uid: 999,
      subject: 'New routine message',
    };
    h.controller.saved.library![incoming.id] = incoming;
    h.controller.changed();
    await h.flush();
    expect((h.app as any).rows.map((r: any) => r.id)).toEqual(originalIDs);
    expect(await h.frame()).toContain('1 new results');
    expect(nodeText(h.renderer.root.findDescendantById('list-controls'))).toContain(
      'g Load 1 new results',
    );
    expect(nodeText(h.renderer.root.findDescendantById('command-dock'))).not.toContain(
      'Load 1 new results',
    );
    await h.key('a');
    await h.key('x');
    expect(h.app.selected.size).toBe(6);
    expect(h.app.selected.has(incoming.id)).toBe(false);
    await h.key('ESCAPE');
    await h.key('g');
    expect((h.app as any).rows).toHaveLength(7);
    await h.key('a');
    await h.key('x');
    expect(h.app.selected.size).toBe(7);
  } finally {
    await h.dispose();
  }
});

test('arrow and Tab focus preserve email selection; externally read text stays open until leaving the pane', async () => {
  const h = await harness();
  try {
    await h.key('1');
    await h.key('ARROW_RIGHT');
    expect((h.app as any).pane).toBe('reader');
    const id = h.app.readerID;
    const cursor = h.app.cursor;
    await h.key('ARROW_DOWN');
    await h.key('ARROW_DOWN');
    expect(h.app.cursor).toBe(cursor);
    expect(h.app.readerID).toBe(id);
    await h.key('TAB');
    expect((h.app as any).pane).toBe('list');
    await h.key('ARROW_RIGHT');
    h.controller.saved.library![id!].read = true;
    h.controller.changed();
    await h.flush();
    expect(h.controller.pool.some((m) => m.id === id)).toBe(false);
    expect(h.app.readerID).toBe(id);
    expect(await h.frame()).toContain('current email · Read');
    await h.key('ARROW_LEFT');
    expect((h.app as any).rows.some((r: any) => r.id === id)).toBe(false);
  } finally {
    await h.dispose();
  }
});

test('overview and review controls fit the minimum terminal during processing', async () => {
  const h = await harness(65, 18, false);
  try {
    h.controller.busy = true;
    h.app.render();
    const frame = await h.frame();
    expect(frame).toContain('REVIEW · unread');
    expect(frame).toContain('p Stop');
    expect(frame).toContain('Analyzing');
    h.app.screen = 'home';
    h.app.render();
    await h.key('3');
    expect(await h.frame()).toContain('x Mark read');
    await h.key('ARROW_RIGHT');
    expect(String(h.app.screen)).toBe('report');
    expect((h.app as any).pane).toBe('reader');
    await h.key('ARROW_LEFT');
    expect(String(h.app.screen)).toBe('report');
  } finally {
    h.controller.busy = false;
    await h.dispose();
  }
});

test('dashboard More discovers secondary commands and preserves context on close', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    const sync = spyOn(h.controller, 'syncInbox').mockResolvedValue(undefined);
    try {
      h.app.screen = 'inbox';
      h.app.render();
      await h.key('ARROW_DOWN');
      const before = (h.app as any).current.id;
      const more = h.renderer.root.findDescendantById('footer-more')!;
      expect(more.y + more.height).toBeLessThanOrEqual(height);
      await h.mockMouse.click(more.x, more.y);
      await h.flush();
      expect(await h.frame()).toContain('Inbox actions');
      const menu = (h.app as any).menuCommands();
      for (const key of ['u', 't', 'i', 'h', 'r', 'v', 'S', ','])
        expect(menu.some((command: any) => command.key === key)).toBe(true);
      await h.key('ARROW_DOWN');
      await h.key('ESCAPE');
      expect((h.app as any).current.id).toBe(before);
      await h.key(';');
      h.controller.snapshotting = true;
      h.controller.changed();
      await h.flush();
      await h.key('u');
      expect(sync).not.toHaveBeenCalled();
      h.controller.snapshotting = false;
      await h.key('u');
      expect(sync).toHaveBeenCalledTimes(1);
      expect((h.app as any).moreActions).toBe(false);
      await h.key(';');
      await h.key('t');
      expect(h.app.period).toBe('today');
      await h.key(';');
      await h.key('i');
      expect(String(h.app.screen)).toBe('overview');
      await h.key('ESCAPE');
      await h.key(';');
      await h.key('h');
      expect(String(h.app.screen)).toBe('history');
      expect(await h.frame()).toContain('Back to inbox');
      await h.key('ESCAPE');
      expect(String(h.app.screen)).toBe('inbox');
    } finally {
      sync.mockRestore();
      await h.dispose();
    }
  }
});

test('reader navigation uses the same boundary checks for mouse, keys and More', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height);
    try {
      await h.key('1');
      expect(nodeText(h.renderer.root.findDescendantById('command-s'))).toContain(
        'Sort: Important first',
      );
      const first = (h.app as any).current.id;
      await h.key('TAB');
      expect(commands(h).find((c) => c.key === '[')?.disabled).toBe(true);
      const previous = h.renderer.root.findDescendantById('footer-[')!;
      await h.mockMouse.click(previous.x, previous.y);
      await h.flush();
      expect((h.app as any).current.id).toBe(first);
      const next = h.renderer.root.findDescendantById('footer-]')!;
      await h.mockMouse.click(next.x, next.y);
      await h.flush();
      expect((h.app as any).current.id).not.toBe(first);
      expect((h.app as any).pane).toBe('reader');
      await h.key(';');
      expect((h.app as any).menuCommands().some((c: any) => c.label === 'Previous email')).toBe(
        true,
      );
      await h.key('[');
      expect((h.app as any).current.id).toBe(first);
      await h.key('e');
      await h.key('[');
      expect(h.app.readerID).toBe(first);
      await h.key(']');
      expect(h.app.readerID).not.toBe(first);
      const dock = h.renderer.root.findDescendantById('command-dock')!;
      expect(dock.y + dock.height).toBeLessThanOrEqual(height);
    } finally {
      await h.dispose();
    }
  }
});

test('Undo becomes visible after leaving a verified read row and disappears after undo', async () => {
  const h = await harness(40, 18);
  try {
    await h.key('1');
    const message = (h.app as any).current.message;
    await h.key('x');
    await h.waitFor(() => !h.controller.mutating);
    await h.flush();
    expect(nodeText(h.renderer.root.findDescendantById('command-x'))).toContain('Mark unread');
    await h.key('ARROW_DOWN');
    expect(nodeText(h.renderer.root.findDescendantById('command-z'))).toContain('Undo last read');
    const dock = h.renderer.root.findDescendantById('command-dock')!;
    expect(dock.y + dock.height).toBeLessThanOrEqual(18);
    const preview = h.renderer.root.findDescendantById('review-preview-pane')!;
    expect(preview.height).toBeGreaterThanOrEqual(3);
    await clickCommand(h, 'z');
    await h.waitFor(() => !h.controller.mutating);
    await h.flush();
    expect(message.read).toBe(false);
    expect(h.renderer.root.findDescendantById('command-z')).toBeUndefined();
  } finally {
    await h.dispose();
  }
});

test('subscription rows show pending read markers only for updating or queued groups and clear them after verification', async () => {
  for (const [width, height, success] of [
    [80, 24, true],
    [40, 18, false],
  ] as const) {
    const h = await harness(width, height);
    const mail = (h.controller as any).mail;
    const setRead = mail.setRead.bind(mail);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = spyOn(mail, 'setRead').mockImplementation(async (...args: any[]) => {
      await gate;
      return success ? setRead(...args) : 'unknown';
    });
    const row = (id: string) => (h.app as any).rows.find((r: any) => r.id === id);
    try {
      await h.key('l');
      const first = (h.app as any).current.newsletter;
      await h.key('x');
      expect((h.app as any).confirmation.length).toBeGreaterThan(1);
      await h.key('RETURN');
      const task = (h.controller as any).readTask;
      expect(row(first.id).name).toContain('[…]');
      expect(first.messages.every((m: any) => !m.read)).toBe(true);
      await h.key('ARROW_DOWN');
      const second = (h.app as any).current.newsletter;
      expect(second.id).not.toBe(first.id);
      expect(row(second.id).name).not.toContain('[…]');
      await h.key('x');
      if ((h.app as any).confirmation.length) await h.key('RETURN');
      expect(row(second.id).name).toContain('[…]');
      expect(commands(h).find((c) => c.key === 'x')?.label).toBe('Queued…');
      expect(row(first.id).name).toContain('[…]');
      await h.key('ARROW_DOWN');
      expect((h.app as any).current.name).not.toContain('[…]');
      release();
      await task;
      await h.flush();
      expect((h.app as any).rows.every((r: any) => !r.name.includes('[…]'))).toBe(true);
      if (!success) {
        expect(row(first.id)).toBeDefined();
        expect(row(second.id)).toBeDefined();
        expect(first.messages.every((m: any) => !m.read)).toBe(true);
      }
    } finally {
      release();
      await (h.controller as any).readTask;
      write.mockRestore();
      await h.dispose();
    }
  }
});

test('mailbox writes allow back and browsing without cancelling the batch or resetting the new view', async () => {
  for (const bulk of [false, true]) {
    const h = await harness(40, 18);
    const mail = (h.controller as any).mail;
    const setRead = mail.setRead.bind(mail);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = spyOn(mail, 'setRead').mockImplementation(async (...args: any[]) => {
      await gate;
      return setRead(...args);
    });
    try {
      await h.key('3');
      const ids = bulk ? (h.app as any).rows.map((r: any) => r.id) : [(h.app as any).current.id];
      if (bulk) await h.key('a');
      await h.key('x');
      if (bulk) await h.key('RETURN');
      await h.waitFor(() => !!h.controller.writeProgress);
      await h.flush();
      expect(await h.frame()).toContain('Marking read');
      expect(await h.frame()).toContain('Esc Back to inbox');
      await h.key('ESCAPE');
      expect(h.app.screen).toBe('inbox');
      expect(h.controller.mutating).toBe(true);
      expect(await h.frame()).toContain(`0/${ids.length}`);
      if (bulk) {
        const read = h.renderer.root.findDescendantById('outcome-read')!;
        await h.mockMouse.click(read.x + 1, read.y);
        await h.flush();
      } else await h.key('2');
      await h.key('ARROW_DOWN');
      const nextID = (h.app as any).current.id;
      expect(commands(h).find((c) => c.key === 'x')!.disabled).toBe(false);
      await clickCommand(h, 'x');
      expect(await h.frame()).toContain('Queued');
      expect(commands(h).find((c) => c.key === 'x')!.disabled).toBe(true);
      await h.key('x');
      await h.key('r');
      expect(write).toHaveBeenCalledTimes(1);
      await h.key('TAB');
      expect((h.app as any).pane).toBe('reader');
      await h.key('o');
      expect((h.app as any).previewMode).toBe('original');
      const back = h.renderer.root.findDescendantById('footer-back')!;
      await h.mockMouse.click(back.x, back.y);
      await h.flush();
      expect((h.app as any).pane).toBe('list');
      expect((h.app as any).current.id).toBe(nextID);
      const cursor = h.app.cursor;
      release();
      await h.waitFor(() => !h.controller.mutating);
      await h.flush();
      expect(h.app.screen).toBe('report');
      expect(h.app.outcome).toBe('read');
      expect(h.app.cursor).toBe(cursor);
      expect((h.app as any).current.id).toBe(nextID);
      expect(
        h.controller.messages
          .filter((m) => m.read)
          .map((m) => m.id)
          .sort(),
      ).toEqual([...ids, nextID].sort());
      expect(commands(h).find((c) => c.key === 'x')!.disabled).toBe(false);
    } finally {
      release();
      await h.waitFor(() => !h.controller.mutating);
      write.mockRestore();
      await h.dispose();
    }
  }
});

test.each([
  [40, 18],
  [80, 24],
  [120, 36],
])(
  'Chat supports conversation, sources, draft preservation and confirmed read at narrow sizes (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height, false);
    try {
      expect(await h.frame()).toContain('CHAT');
      await h.key('c');
      expect(h.app.screen).toBe('chat');
      expect(await h.frame()).toContain('Autosave on');
      expect(h.renderer.root.findDescendantById('chat-input')).toBeDefined();
      await h.mockInput.typeText('Any payment requests?');
      await h.key('RETURN');
      const chat = (h.app as any).chat;
      await h.waitFor(() => !chat.session.busy);
      expect(chat.session.error).toBe('');
      expect(chat.session.entries.at(-1).role).toBe('assistant');
      expect(chat.session.sources.length).toBeGreaterThan(0);
      expect(await h.frame()).toContain('AI answer');
      await h.mockInput.typeText('explain more');
      const draft = chat.draft;
      h.controller.changed();
      await h.flush();
      expect(
        (h.renderer.root.findDescendantById('chat-input') as TextareaRenderable).plainText,
      ).toBe(draft);
      h.mockInput.pressKey('o', { ctrl: true });
      await h.flush();
      expect(await h.frame()).toContain('Sources');
      await h.key('RETURN');
      expect(await h.frame()).toContain('Original email');
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
      await h.key('ESCAPE');
      expect(await h.frame()).toContain('Sources · latest answer first');
      await h.key('ESCAPE');
      expect(
        (h.renderer.root.findDescendantById('chat-input') as TextareaRenderable).plainText,
      ).toBe(draft);
      await h.key('ESCAPE');
      expect(h.app.screen).toBe('inbox');
      await h.key('c');
      expect(chat.session.entries).toHaveLength(2);
      expect(chat.draft).toBe(draft);
      await h.key('RETURN');
      await h.waitFor(() => !chat.session.busy);
      expect(chat.session.entries).toHaveLength(4);
      await h.mockInput.typeText('Mark that email read');
      await h.key('RETURN');
      await h.waitFor(() => !chat.session.busy);
      expect(chat.session.proposal.status).toBe('pending');
      expect(await h.frame()).toContain('confirming Mark read.');
      const ids = chat.session.proposal.sources.map((s: any) => s.id);
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
      const confirm = h.renderer.root.findDescendantById('chat-confirm')!;
      await h.mockMouse.click(confirm.x + 1, confirm.y);
      await h.flush();
      await h.waitFor(() => chat.session.proposal.status === 'done');
      expect(
        h.controller.messages
          .filter((m) => m.read)
          .map((m) => m.id)
          .sort(),
      ).toEqual(ids.sort());
      expect(chat.session.entries.at(-1).text).toContain('marked read');
      const dock = h.renderer.root.findDescendantById('chat-dock')!;
      expect(dock.y + dock.height).toBeLessThanOrEqual(height);
      h.mockInput.pressKey('n', { ctrl: true });
      await h.flush();
      expect(await h.frame()).toContain('Clear saved conversation');
      await h.key('RETURN');
      expect(chat.session.entries).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  },
);

test('results dashboard exposes Chat through row navigation', async () => {
  const h = await harness(40, 18);
  try {
    for (let i = 0; i < 5; i++) await h.key('ARROW_DOWN');
    expect(h.app.cursor).toBe(5);
    expect(await h.frame()).toContain('▶ c Ask your inbox');
    await h.key('RETURN');
    expect(h.app.screen).toBe('chat');
  } finally {
    await h.dispose();
  }
});

test('Chat cancellation, retry and navigation keep the draft and avoid replaying writes', async () => {
  const h = await harness(40, 18);
  let calls = 0;
  const model = spyOn(h.controller, 'chatStep').mockImplementation(async (_input, signal) => {
    calls++;
    if (calls === 1)
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    return {
      action: 'clarify',
      plan: null,
      search: { ...EMPTY_SEARCH },
      sources: [],
      text: 'Which sender should I search?',
    };
  });
  try {
    await h.key('c');
    await h.mockInput.typeText('Find a message');
    await h.key('RETURN');
    const chat = (h.app as any).chat;
    expect(chat.session.busy).toBe(true);
    expect(await h.frame()).toContain('Stop reply');
    const status = h.renderer.root.findDescendantById('chat-status')!;
    const input = h.renderer.root.findDescendantById('chat-input');
    const first = nodeText(status);
    await Bun.sleep(210);
    await h.flush();
    expect(nodeText(status)).not.toBe(first);
    expect(h.renderer.root.findDescendantById('chat-status')).toBe(status);
    expect(h.renderer.root.findDescendantById('chat-input')).toBe(input);
    await h.key('ESCAPE');
    await h.waitFor(() => !chat.session.busy);
    expect(chat.session.error).toContain('Cancelled');
    expect((h.app as any).activity.timer).toBeUndefined();
    h.mockInput.pressKey('r', { ctrl: true });
    await h.flush();
    await h.waitFor(() => !chat.session.busy);
    expect(chat.session.entries.filter((e: any) => e.role === 'user')).toHaveLength(1);
    expect(chat.session.entries.at(-1).text).toContain('Which sender');
    expect(h.controller.messages.every((m) => !m.read)).toBe(true);
  } finally {
    model.mockRestore();
    await h.dispose();
  }
});

test('dashboard destinations share explicit groups, neutral colors and visible bounds', async () => {
  for (const [width, height] of [
    [40, 18],
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    try {
      for (const screen of ['inbox', 'home'] as const) {
        for (const busy of [false, true]) {
          h.app.screen = screen;
          h.app.cursor = 0;
          h.controller.busy = busy;
          h.app.render();
          await h.flush();
          const sections = ['review', 'newsletters', 'chat'].map(
            (id) => h.renderer.root.findDescendantById(`dashboard-${id}`)!,
          );
          expect(sections.every(Boolean)).toBe(true);
          expect(sections[1].y).toBeGreaterThanOrEqual(sections[0].y + sections[0].height);
          expect(sections[2].y).toBeGreaterThanOrEqual(sections[1].y + sections[1].height);
          const rows = ['outcome-read', 'inbox-newsletters', 'inbox-chat'].map(
            (id) => h.renderer.root.findDescendantById(id)!,
          );
          const labels = rows.map((row) => row.getChildren()[0] as TextRenderable);
          // Review has a line container; the other destinations share its label style.
          const reviewLabel = labels[0].getChildren()[0] as TextRenderable;
          expect(labels[1].fg.equals(reviewLabel.fg)).toBe(true);
          expect(labels[2].fg.equals(reviewLabel.fg)).toBe(true);
          expect(labels[1].x).toBe(reviewLabel.x);
          expect(labels[2].x).toBe(reviewLabel.x);
          const footer = h.renderer.root.findDescendantById('shortcut-footer')!;
          expect(rows[2].y + rows[2].height).toBeLessThanOrEqual(footer.y);
          expect(footer.y + footer.height).toBeLessThanOrEqual(height);
        }
      }
      h.controller.busy = false;
      h.app.screen = 'inbox';
      (h.app as any).notice = 'Could not sync. Try again.';
      h.app.render();
      const frame = await h.frame();
      expect(frame).toContain('Could not sync');
      expect(frame).toContain('c Ask your inbox');
      expect(frame).toContain(', Settings');
    } finally {
      h.controller.busy = false;
      await h.dispose();
    }
  }
});

test('Chat separates composer and commands, preserves the caret and labels Enter by focus', async () => {
  for (const [width, height] of [
    [40, 18],
    [65, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    try {
      await h.key('c');
      const checkGeometry = () => {
        const composer = h.renderer.root.findDescendantById('chat-composer')!;
        const conversation = h.renderer.root.findDescendantById('chat-conversation')!;
        const dock = h.renderer.root.findDescendantById('chat-dock')!;
        expect(dock.y).toBeGreaterThanOrEqual(conversation.y + conversation.height + 1);
        const input = h.renderer.root.findDescendantById('chat-input')!;
        const controls = h.renderer.root.findDescendantById('chat-controls')!;
        expect(input.y).toBe(composer.y + 1);
        expect(input.y + input.height).toBeLessThan(composer.y + composer.height);
        expect(controls.y).toBeGreaterThanOrEqual(composer.y + composer.height + 1);
        expect(controls.y + controls.height).toBeLessThanOrEqual(h.renderer.height);
        const buttons = controls.getChildren() as any[];
        for (const [index, button] of buttons.entries()) {
          expect(button.x).toBeGreaterThanOrEqual(1);
          expect(button.x + button.width).toBeLessThanOrEqual(h.renderer.width - 1);
          const previous = buttons[index - 1];
          if (previous?.y === button.y)
            expect(button.x).toBeGreaterThanOrEqual(previous.x + previous.width + 2);
        }
      };
      checkGeometry();
      await h.mockInput.typeText('payment request');
      const input = () => h.renderer.root.findDescendantById('chat-input') as TextareaRenderable;
      input().cursorOffset = 3;
      await h.key('TAB');
      expect(nodeText(h.renderer.root.findDescendantById('chat-send'))).toContain('Type message');
      checkGeometry();
      await h.key('RETURN');
      expect(input().plainText).toBe('payment request');
      expect(input().cursorOffset).toBe(3);
      expect((h.app as any).chat.session.entries).toHaveLength(0);
      h.resize(40, 18);
      await h.flush();
      expect(input().cursorOffset).toBe(3);
      checkGeometry();
      h.renderer.emit('theme_mode', 'light');
      await h.flush();
      expect(input().plainText).toBe('payment request');
      expect(input().cursorOffset).toBe(3);
      checkGeometry();
      const chat = (h.app as any).chat;
      chat.session.error = 'A long provider error with some useful details. '.repeat(8);
      chat.session.retryText = 'payment request';
      h.app.render();
      await h.flush();
      checkGeometry();
      expect(
        (h.renderer.root.findDescendantById('chat-conversation') as ScrollBoxRenderable).height,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await h.dispose();
    }
  }
});

test('Chat sources are discoverable and navigable entirely by keyboard with stable selection', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    try {
      h.controller.messages[0].body += '\nhttps://example.com/source-link';
      const opened: string[] = [];
      (h.app as any).openEmailURL = (url: string) => opened.push(url);
      await h.key('c');
      const chat = (h.app as any).chat;
      const messages = h.controller.messages.slice(0, 4);
      chat.session.sources = messages.map((m, i) => ({
        ref: i + 1,
        id: m.id,
        sender: m.sender,
        subject: m.subject,
        date: m.date,
      }));
      chat.session.entries = [
        { role: 'assistant', text: 'An earlier finding [2].', sources: [2] },
        { role: 'assistant', text: 'Latest findings [3] and [1].', sources: [3, 1] },
      ];
      h.app.render();
      await h.flush();
      expect(nodeText(h.renderer.root.findDescendantById('chat-sources-heading-1'))).toBe(
        'Sources · Ctrl+O Browse',
      );
      await h.mockInput.typeText('a follow-up draft');
      (h.renderer.root.findDescendantById('chat-input') as TextareaRenderable).cursorOffset = 4;
      h.mockInput.pressKey('o', { ctrl: true });
      await h.flush();
      const row = (i: number) =>
        h.renderer.root.findDescendantById(`chat-source-row-${i}`) as TextRenderable;
      expect(nodeText(row(0))).toContain('[3]');
      expect(nodeText(row(1))).toContain('[1]');
      expect(nodeText(row(2))).toContain('[2]');
      expect(row(3)).toBeUndefined(); // An uncited search result is not an answer link.
      expect(await h.frame()).toContain('Enter Open source');
      expect(await h.frame()).toContain('↑↓ Choose');
      await h.key('ARROW_DOWN');
      expect(chat.sourceIndex).toBe(1);
      expect(row(1).bg?.equals(RGBA.fromHex('#24303a'))).toBe(true);
      await h.key('RETURN');
      expect(chat.original).toBe(1);
      expect(await h.frame()).toContain('Esc Back to sources');
      expect(await h.frame()).toContain('L Links');
      await h.key('L');
      expect(await h.frame()).toContain('https://example.com/source-link');
      await h.key('RETURN');
      expect(opened).toEqual(['https://example.com/source-link']);
      expect(chat.view).toBe('original');
      // A newly completed answer must not reorder an open source browser.
      chat.session.entries.push({ role: 'assistant', text: 'Another finding [4].', sources: [4] });
      await h.key('ESCAPE');
      expect(chat.sourceIndex).toBe(1);
      expect(nodeText(row(1))).toContain('[1]');
      expect(row(3)).toBeUndefined();
      await h.key('END');
      expect(chat.sourceIndex).toBe(2);
      await h.key('HOME');
      expect(chat.sourceIndex).toBe(0);
      await h.key('ESCAPE');
      const input = h.renderer.root.findDescendantById('chat-input') as TextareaRenderable;
      expect(input.plainText).toBe('a follow-up draft');
      expect(input.cursorOffset).toBe(4);
      h.mockInput.pressKey('o', { ctrl: true });
      await h.flush();
      expect(nodeText(row(0))).toContain('[4]');
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
      const controls = h.renderer.root.findDescendantById('chat-controls')!;
      expect(controls.y + controls.height).toBeLessThanOrEqual(height);
    } finally {
      await h.dispose();
    }
  }
});

test('Chat sections have one-row gaps and retain keyboard source navigation at narrow widths', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    try {
      await h.key('c');
      await h.mockInput.typeText('Any payment requests?');
      await h.key('RETURN');
      const chat = (h.app as any).chat;
      await h.waitFor(() => !chat.session.busy);
      const entry = chat.session.entries.at(-1);
      entry.text = chatAnswerFixture;
      h.app.render();
      await h.flush();
      const markdown = h.renderer.root.findDescendantById('chat-answer-1') as MarkdownRenderable;
      expect(markdown).toBeInstanceOf(MarkdownRenderable);
      // Markdown syntax work finishes outside the render scheduler. Its first
      // idle frame is not necessarily the final layout on a cold CI runner.
      // Wait for the paragraph whose actual cell spacing we assert below.
      let frame = await h.frame();
      if (width === 120) {
        const deadline = Date.now() + 3000;
        while (!frame.includes('A separate paragraph ends here.') && Date.now() < deadline) {
          await Bun.sleep(10);
          frame = await h.frame();
        }
      }
      const blocks = markdown.getChildren();
      expect(nodeText(markdown)).toContain('Example\n2. literal code');
      expect(blocks.length).toBeGreaterThan(5);
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i].y - (blocks[i - 1].y + blocks[i - 1].height)).toBe(1);
      }
      expect(frame).not.toContain('##');
      if (width === 120) {
        const lines = frame.split('\n');
        const ending = lines.findIndex((line) => line.includes('A separate paragraph ends here.'));
        const next = lines.findIndex((line) => line.includes('2. The next numbered section'));
        expect(ending).toBeGreaterThan(0);
        expect(next - ending).toBe(2);
      }
      await h.mockInput.typeText('keep my draft');
      h.mockInput.pressKey('o', { ctrl: true });
      await h.flush();
      await h.key('RETURN');
      expect(await h.frame()).toContain('Original email');
      await h.key('ESCAPE');
      await h.key('ESCAPE');
      const input = h.renderer.root.findDescendantById('chat-input') as TextareaRenderable;
      expect(input.plainText).toBe('keep my draft');
      expect(entry.text).toBe(chatAnswerFixture);
    } finally {
      await h.dispose();
    }
  }
});

test.each([
  [40, 18],
  [120, 36],
])(
  'Chat Markdown and keyboard workflow survive restart, including draft and pending confirmation (%dx%d)',
  async (width, height) => {
    let h = await harness(width, height, false);
    try {
      await h.key('c');
      await h.mockInput.typeText('Any payment requests?');
      await h.key('RETURN');
      let chat = (h.app as any).chat;
      await h.waitFor(() => !chat.session.busy);
      chat.session.entries.at(-1).text =
        '1. **Payment request** from `Acme` [1].\n\n2. **Check the original** before paying.';
      h.app.render();
      // The syntax worker can reply while the render scheduler is idle. waitFor()
      // stops at scheduler idle, so poll this external result with a real deadline.
      let frame = '';
      const deadline = Date.now() + 3000;
      do {
        await Bun.sleep(10);
        frame = await h.frame();
      } while (!frame.includes('Payment request') && Date.now() < deadline);
      expect(frame).toContain('Payment request');
      expect(frame.replace(/\s+/g, ' ')).toContain('from Acme [1]');
      expect(frame).not.toContain('**');
      expect(frame).not.toContain('`Acme`');
      await h.mockInput.typeText('explain more');
      (h.renderer.root.findDescendantById('chat-input') as TextareaRenderable).cursorOffset = 4;
      await h.dispose();
      h = await harness(width, height, false, h.store.value);
      await h.key('c');
      chat = (h.app as any).chat;
      expect(chat.session.entries).toHaveLength(2);
      const input = h.renderer.root.findDescendantById('chat-input') as TextareaRenderable;
      expect(input.plainText).toBe('explain more');
      expect(input.cursorOffset).toBe(4);
      h.mockInput.pressKey('o', { ctrl: true });
      await h.flush();
      await h.key('RETURN');
      expect(await h.frame()).toContain('Original email');
      await h.key('ESCAPE');
      await h.key('ESCAPE');
      await h.key('RETURN');
      await h.waitFor(() => !chat.session.busy);
      expect(chat.session.entries).toHaveLength(4);
      await h.mockInput.typeText('Mark that email read');
      await h.key('RETURN');
      await h.waitFor(() => !chat.session.busy);
      expect(chat.session.proposal.status).toBe('pending');
      await h.dispose();
      h = await harness(width, height, false, h.store.value);
      await h.key('c');
      chat = (h.app as any).chat;
      expect(chat.session.proposal.status).toBe('pending');
      expect(h.controller.messages.every((m) => !m.read)).toBe(true);
      await h.key('RETURN');
      await h.waitFor(() => chat.session.proposal.status === 'done');
      expect(chat.session.entries.at(-1).text).toContain('marked read');
      await h.mockInput.typeText('keep this draft; q');
      await h.key('F2');
      expect(await h.frame()).toContain('New chat');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      expect(await h.frame()).toContain('Clear saved conversation');
      await h.key('ESCAPE');
      expect(chat.draft).toBe('keep this draft; q');
      expect(chat.session.entries.length).toBeGreaterThan(0);
      h.mockInput.pressKey('n', { ctrl: true });
      await h.flush();
      await h.key('RETURN');
      await chat.flushBeforeExit();
      expect(h.store.value.chats?.[h.controller.chatScope].state.entries).toEqual([]);
      expect(chat.draft).toBe('');
      const dock = h.renderer.root.findDescendantById('chat-dock')!;
      expect(dock.y + dock.height).toBeLessThanOrEqual(height);
    } finally {
      await h.dispose();
    }
  },
);

test('Chat save failure preserves local text, blocks closing and offers keyboard retry', async () => {
  const h = await harness(80, 24, false);
  const save = h.store.save.bind(h.store);
  try {
    await h.key('c');
    await h.mockInput.typeText('Please keep this draft');
    h.store.save = async () => {
      throw new Error('Disk full');
    };
    expect(await h.app.flushChat()).toBe(false);
    expect(h.app.screen).toBe('chat');
    expect(await h.frame()).toContain('Chat not saved: Disk full');
    expect((h.app as any).chat.draft).toBe('Please keep this draft');
    h.store.save = save;
    await h.key('F2');
    expect(await h.frame()).toContain('Retry save');
    await h.key('ARROW_DOWN');
    await h.key('RETURN');
    await h.waitFor(() => !!h.store.value.chats?.[h.controller.chatScope]);
    expect(await h.app.flushChat()).toBe(true);
    expect(h.store.value.chats?.[h.controller.chatScope].state.draft).toBe(
      'Please keep this draft',
    );
  } finally {
    h.store.save = save;
    await h.dispose();
  }
});

test('Chat reload requires confirmation and never clears local text on an unreadable save', async () => {
  const h = await harness(80, 24, false);
  try {
    await h.key('c');
    const chat = (h.app as any).chat;
    const other = chat.session.snapshot('draft from another terminal');
    await h.controller.saveChat(h.controller.chatScope, 0, other);
    await h.mockInput.typeText('my local draft');
    expect(await h.app.flushChat()).toBe(false);
    const openReload = async () => {
      await h.key('F2');
      await h.key('ARROW_DOWN');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
    };
    await openReload();
    await h.key('ESCAPE');
    expect(chat.draft).toBe('my local draft');
    const load = spyOn(h.controller, 'loadChat').mockResolvedValue({
      revision: 2,
      state: { version: 99 },
    } as any);
    await openReload();
    await h.key('RETURN');
    expect(chat.draft).toBe('my local draft');
    load.mockRestore();
    await openReload();
    await h.key('RETURN');
    expect(chat.draft).toBe('draft from another terminal');
    expect(await h.app.flushChat()).toBe(true);
  } finally {
    await h.dispose();
  }
});

test('menu destinations open the shared terminal screens and preserve their keyboard controls', async () => {
  for (const [width, height] of [
    [40, 18],
    [120, 36],
  ]) {
    const h = await harness(width, height, false);
    try {
      for (const outcome of ['act', 'read', 'clear', 'check'] as const) {
        h.app.openDestination(outcome);
        await h.flush();
        expect(h.app.screen).toBe('report');
        expect(h.app.outcome).toBe(outcome);
        await h.key('ESCAPE');
        expect(h.app.screen).toBe('inbox');
      }
      h.app.openDestination('subscriptions');
      await h.flush();
      expect(h.app.tab).toBe('subscriptions');
      await h.key('ESCAPE');
      h.app.openDestination('chat');
      await h.flush();
      expect(h.renderer.root.findDescendantById('chat-input')).toBeDefined();
      await h.key('ESCAPE');
      h.app.openDestination('settings');
      await h.flush();
      expect(h.app.screen).toBe('settings');
      await h.key('ESCAPE');
      expect(h.app.screen).toBe('inbox');
    } finally {
      await h.dispose();
    }
  }
});

test('Mac companion setting changes only on Save, cancels safely and remains visible in a narrow form', async () => {
  if (process.platform !== 'darwin') return;
  const mac = await import('../src/mac-menu.ts');
  const available = spyOn(mac, 'menuAvailable').mockReturnValue(true);
  const h = await harness(40, 18, false);
  const calls: boolean[] = [];
  h.controller.menuBarHook = async (enabled) => {
    calls.push(enabled);
  };
  (h.app as any).demo = false;
  try {
    await h.key(',');
    (h.app as any).settingsFocus = 'menuBar';
    h.app.render();
    await h.flush();
    expect(await h.frame()).toContain('Show in menu bar');
    await h.key('RETURN');
    expect(calls).toEqual([]);
    expect(h.store.value.settings?.menuBarEnabled).not.toBe(true);
    await h.key('ESCAPE');
    const choices = (h.app as any).rows;
    const discardIndex = choices.findIndex((r: any) => r.name.includes('Discard'));
    expect(discardIndex).toBeGreaterThanOrEqual(0);
    for (let n = 0; n < discardIndex; n++) await h.key('ARROW_DOWN');
    await h.key('RETURN');
    expect(calls).toEqual([]);
    await h.key(',');
    (h.app as any).settingsFocus = 'menuBar';
    h.app.render();
    await h.flush();
    await h.key('RETURN');
    await h.key('s');
    await h.waitFor(() => !(h.app as any).savingSettings);
    expect(calls).toEqual([true]);
    expect(h.store.value.settings?.menuBarEnabled).toBe(true);
  } finally {
    available.mockRestore();
    await h.dispose();
  }
});

test.each([
  [120, 36],
  [80, 24],
  [65, 18],
  [50, 24],
  [40, 18],
])(
  'subscription scope is keyboard accessible, uses saved mail, and selects only unread issues (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height);
    try {
      const first = h.controller.messages[3];
      first.sender = 'Scope Test';
      first.address = 'scope@example.com';
      const read = {
        ...structuredClone(first),
        id: 'demo:INBOX:1:900',
        uid: 900,
        read: true,
        subject: 'Saved read issue',
      };
      const pending = {
        ...structuredClone(first),
        id: 'demo:INBOX:1:901',
        uid: 901,
        analysis: undefined,
        classification: undefined,
        listID: 'scope.example',
      };
      h.controller.messages.splice(0, h.controller.messages.length, first, read, pending);
      h.controller.saved.library = {};
      const digest = spyOn(h.controller, 'reviewNewsletter').mockResolvedValue();
      (h.app as any).demo = false; // Exercise production browsing guards, without any provider.
      await h.key('l');
      const scope = h.renderer.root.findDescendantById('subscription-scope')!;
      const list = h.renderer.root.findDescendantById('review-list-pane')!;
      expect(scope.y + scope.height).toBeLessThanOrEqual(list.y);
      expect(nodeText(h.renderer.root.findDescendantById('command-actions'))).not.toContain(
        'Show:',
      );
      const allOption = h.renderer.root.findDescendantById('subscription-scope-all')!;
      expect(allOption.x + allOption.width).toBeLessThanOrEqual(width - 1);
      await h.mockMouse.click(allOption.x + 1, allOption.y);
      await h.flush();
      expect((h.app as any).newsletterScope).toBe('all');
      // Clicking the active scope is a no-op; clicking Unread selects it directly.
      await h.mockMouse.click(allOption.x + 1, allOption.y);
      await h.flush();
      expect((h.app as any).newsletterScope).toBe('all');
      const unreadOption = h.renderer.root.findDescendantById('subscription-scope-unread')!;
      await h.mockMouse.click(unreadOption.x + 1, unreadOption.y);
      await h.flush();
      expect((h.app as any).newsletterScope).toBe('unread');
      expect(await h.frame()).toContain('t Show:');
      expect((h.app as any).current.newsletter.messages.map((m: any) => m.id)).toEqual([first.id]);
      await h.key('t');
      expect(await h.frame()).toContain('All analyzed');
      expect((h.app as any).current.newsletter.messages).toHaveLength(2);
      await h.key('a');
      expect([...h.app.selected]).toEqual([first.id]);
      expect(await h.frame()).toContain('Mark 1 read');
      await h.key('t');
      expect(h.app.selected.size).toBe(0);
      expect((h.app as any).current.newsletter.messages).toHaveLength(1);
      await h.key('t');
      await h.key('TAB');
      expect(nodeText((h.app as any).reader)).toContain('AI Summary · 2 retained issues');
      await h.key('v');
      expect(h.app.screen).toBe('digest');
      expect(await h.frame()).toContain('All analyzed');
      await h.key('ESCAPE');
      await h.key('RETURN');
      expect(h.app.newsletterID).toBe('scope@example.com');
      expect((h.app as any).rows).toHaveLength(2);
      await h.key('a');
      expect([...h.app.selected]).toEqual([first.id]);
      await h.key('c');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      expect(nodeText((h.app as any).reader)).toContain(read.body);
      expect(digest).not.toHaveBeenCalled();
      await h.key('ESCAPE');
      await h.key('ESCAPE');
      expect((h.app as any).newsletterScope).toBe('all');
      await h.key('x');
      expect((h.app as any).confirmation.map((m: any) => m.id)).toEqual([first.id]);
      await h.key('RETURN');
      await h.waitFor(() => !h.controller.mutating);
      expect(first.read).toBe(true);
      expect(read.read).toBe(true);
      expect((h.app as any).current.newsletter.messages).toHaveLength(2);
      await h.key('t');
      expect(await h.frame()).toContain('No analyzed unread subscriptions');
      expect(await h.frame()).toContain('t Show:');
      await h.key('t');
      expect((h.app as any).current.newsletter.messages).toHaveLength(2);
      expect(digest).not.toHaveBeenCalled();
      digest.mockRestore();
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  [120, 36],
  [80, 24],
  [65, 18],
  [50, 24],
  [40, 18],
])(
  'list and preview controls stay above their content through focus, search and confirmation (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height);
    try {
      for (const destination of ['1', 'l']) {
        await h.key(destination);
        const verify = () => {
          const controls = h.renderer.root.findDescendantById('list-controls')!;
          const list = h.renderer.root.findDescendantById('review-list-pane')!;
          const preview = h.renderer.root.findDescendantById('review-preview-pane')!;
          const view = h.renderer.root.findDescendantById('view-controls')!;
          const dock = h.renderer.root.findDescendantById('command-dock')!;
          expect(controls.y + controls.height).toBeLessThanOrEqual(list.y);
          expect(nodeText(controls)).toContain('/ Search');
          expect(nodeText(controls)).toContain('s Sort:');
          expect(view.y).toBe(preview.y);
          expect(view.x + view.width).toBeLessThanOrEqual(width - 1);
          expect((h.app as any).list.height).toBeGreaterThanOrEqual(1);
          expect((h.app as any).reader.height).toBeGreaterThanOrEqual(2);
          expect(dock.y + dock.height).toBeLessThanOrEqual(height);
          expect(nodeText(dock)).not.toContain('/ Search');
          expect(nodeText(dock)).not.toContain('Sort:');
          expect(nodeText(dock)).not.toContain('Show original');
          return { listY: list.y, viewY: view.y, viewX: view.x };
        };
        const before = verify();
        await h.key('TAB');
        expect(verify()).toEqual(before);
        await h.key(' ');
        verify();
        await h.key('c');
        await h.key('/');
        await h.mockInput.typeText('no fictional match');
        await h.key('RETURN');
        expect(await h.frame()).toContain('Search: no fictional match');
        expect(nodeText(h.renderer.root.findDescendantById('list-controls'))).toContain(
          'Backspace Clear search',
        );
        await h.key('BACKSPACE');
        expect(h.app.query).toBe('');
        expect((h.app as any).rows.length).toBeGreaterThan(0);
        verify();
        await h.key('a');
        await h.key('x');
        const order = (h.app as any).newsletterSort;
        const sort = h.app.sort;
        const sortControl = h.renderer.root.findDescendantById('command-s')!;
        await h.mockMouse.click(sortControl.x + 1, sortControl.y);
        await h.key('s');
        expect((h.app as any).newsletterSort).toBe(order);
        expect(h.app.sort).toBe(sort);
        expect((h.app as any).confirmation.length).toBeGreaterThan(0);
        await h.key('ESCAPE');
        await h.key('c');
        if (destination === 'l') {
          await h.key('RETURN');
          verify();
        }
      }
    } finally {
      await h.dispose();
    }
  },
);

test('activity stays quiet when idle and fits dashboard and settings in both themes at minimum size', async () => {
  const h = await harness(40, 18);
  try {
    for (const theme of ['dark', 'light']) {
      h.renderer.emit('theme_mode', theme);
      h.controller.saved.mode = 'live';
      h.app.screen = 'inbox';
      h.app.render();
      await h.flush();
      expect((h.app as any).activity.timer).toBeUndefined();
      expect(await h.frame()).toContain('● Live');
      // Locally held fictional states: no network request or Live service is started.
      h.controller.summaryBusy = true;
      h.app.render();
      await h.flush();
      const summary = h.renderer.root.findDescendantById('inbox-summary-refresh') as TextRenderable;
      expect(nodeText(summary)).toMatch(/^[|/\\-] Updating/);
      expect(summary.fg.equals(RGBA.fromHex((h.app as any).colors.muted))).toBe(true);
      expect(summary.x + summary.width).toBeLessThanOrEqual(39);
      expect(await h.frame()).toContain('AI SUMMARY');
      expect(await h.frame()).toContain('c Ask your inbox');
      expect(await h.frame()).toContain(', Settings');
      h.controller.summaryBusy = false;
      h.controller.snapshotting = true;
      h.controller.busy = true;
      h.app.render();
      expect(await h.frame()).not.toContain('Syncing inbox');
      expect(await h.frame()).toContain('● Live');
      expect((h.app as any).activity.timer).toBeUndefined();
      h.controller.snapshotting = false;
      h.controller.busy = false;
      h.app.render();
      expect((h.app as any).activity.timer).toBeUndefined();
      await h.key(',');
      (h.app as any).testingSettings = true;
      h.app.render();
      await h.flush();
      const status = (h.app as any).statusNode as TextRenderable;
      const first = nodeText(status);
      await Bun.sleep(210);
      await h.flush();
      expect(nodeText(status)).not.toBe(first);
      expect(status.y + status.height).toBeLessThanOrEqual(18);
      (h.app as any).testingSettings = false;
      h.app.render();
      expect((h.app as any).activity.timer).toBeUndefined();
    }
  } finally {
    h.controller.busy = false;
    h.controller.snapshotting = false;
    h.controller.summaryBusy = false;
    await h.dispose();
  }
});

test.each([
  [80, 24],
  [40, 18],
])(
  'list boundary shortcuts preserve selection and preview toggles preserve pane focus (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height);
    try {
      for (const destination of ['1', 'l']) {
        await h.key(destination);
        if (destination === 'l') {
          // Sender lists and the issue lists use the same boundary commands.
          h.mockInput.pressKey('ARROW_DOWN', { super: true });
          await h.flush();
          expect(h.app.cursor).toBe((h.app as any).rows.length - 1);
          h.mockInput.pressKey('ARROW_UP', { super: true });
          await h.flush();
          expect(h.app.cursor).toBe(0);
          await h.key('RETURN');
        }
        if ((h.app as any).previewMode === 'original') await h.key('o');
        const rows = (h.app as any).rows;
        expect(rows.length).toBeGreaterThan(1);
        await h.key(' ');
        const selected = [...h.app.selected];
        h.mockInput.pressKey('ARROW_DOWN', { super: true });
        await h.flush();
        expect(h.app.cursor).toBe(rows.length - 1);
        expect(h.app.readerID).toBe(rows.at(-1).message.id);
        expect([...h.app.selected]).toEqual(selected);
        expect((h.app as any).pane).toBe('list');
        await h.key('o');
        expect((h.app as any).previewMode).toBe('original');
        expect((h.app as any).pane).toBe('list');
        expect((h.app as any).list.focused).toBe(true);
        await h.key('o');
        expect((h.app as any).previewMode).toBe('summary');
        expect((h.app as any).pane).toBe('list');
        h.mockInput.pressKey('ARROW_UP', { super: true });
        await h.flush();
        expect(h.app.cursor).toBe(0);
        expect(h.app.readerID).toBe(rows[0].message.id);
        await h.key('END');
        expect(h.app.cursor).toBe(rows.length - 1);
        await h.key('HOME');
        expect(h.app.cursor).toBe(0);
        await h.key('TAB');
        await h.key('o');
        expect((h.app as any).pane).toBe('reader');
        await h.key('END');
        expect(h.app.cursor).toBe(0); // Scroll mail, never jump the unfocused list.
        await h.key('TAB');
        await h.key('o'); // Back to review, staying in the list.
        await h.key('a');
        await h.key('x');
        expect((h.app as any).confirmation.length).toBeGreaterThan(1);
        h.mockInput.pressKey('ARROW_DOWN', { super: true });
        await h.flush();
        expect(h.app.cursor).toBe(0); // Confirmation blocks background navigation.
        await h.key('ESCAPE');
        await h.key('c');
        await h.key('/');
        await h.mockInput.typeText('no matching fictional email');
        await h.key('RETURN');
        await h.key('END');
        await h.key('HOME');
        expect((h.app as any).rows).toHaveLength(0);
        expect(h.app.cursor).toBe(0);
        await h.key('BACKSPACE');
      }
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  [120, 36],
  [80, 24],
  [65, 18],
  [50, 24],
  [40, 18],
])(
  'Chat uses automatic access and investigation details stay keyboard-first in narrow/light terminals (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height);
    try {
      await h.key('c');
      const chat = (h.app as any).chat;
      await h.mockInput.typeText('keep my question');
      expect(chat.session.access).toBe('connected');
      expect(await h.frame()).not.toContain('F3 Scope');
      expect(await h.frame()).toContain('Demo mail');
      await h.key('F2');
      expect(await h.frame()).not.toContain('Change access scope');
      await h.key('ESCAPE');
      h.renderer.emit('theme_mode', 'light');
      await h.flush();
      expect(chat.draft).toBe('keep my question');
      await h.key('F4');
      expect(await h.frame()).toContain('Investigation details');
      expect(h.renderer.root.findDescendantById('chat-input')).toBeUndefined();
      await h.key('ESCAPE');
      expect(chat.draft).toBe('keep my question');
      const input = h.renderer.root.findDescendantById('chat-input')!;
      const dock = h.renderer.root.findDescendantById('chat-dock')!;
      expect(input.y + input.height).toBeLessThanOrEqual(dock.y + dock.height);
      expect(dock.y + dock.height).toBeLessThanOrEqual(height);
      h.mockInput.pressKey('o', { ctrl: true });
      await h.flush();
      await h.key('F4');
      expect(await h.frame()).toContain('Back to sources');
      await h.key('ESCAPE');
      expect(await h.frame()).toContain('Sources · latest answer first');
      await h.key('ESCAPE');
      await chat.flushBeforeExit();
      expect(h.store.value.chats![h.controller.chatScope].state.access).toBe('connected');
    } finally {
      await h.dispose();
    }
  },
);

test('Chat Details and Back do not cancel a worker reply; Stop does', async () => {
  const h = await harness(40, 18);
  let signal: AbortSignal | undefined;
  const model = spyOn(h.controller, 'chatStep').mockImplementation(async (_input, s) => {
    signal = s;
    await new Promise((_, reject) =>
      s.addEventListener('abort', () => reject(s.reason), { once: true }),
    );
    return {
      action: 'clarify',
      plan: null,
      search: { ...EMPTY_SEARCH },
      sources: [],
      text: 'Stopped',
    };
  });
  try {
    await h.key('c');
    await h.mockInput.typeText('Find repair');
    await h.key('RETURN');
    const chat = (h.app as any).chat;
    await h.waitFor(() => !!signal);
    await h.key('F4');
    expect(await h.frame()).toContain('Investigation details');
    await h.key('ESCAPE');
    expect(signal!.aborted).toBe(false);
    h.mockInput.pressKey('b', { ctrl: true });
    await h.flush();
    expect(h.app.screen).toBe('inbox');
    expect(signal!.aborted).toBe(false);
    await h.key('c');
    await h.waitFor(() => (h.app as any).chat.session.busy);
    await h.key('ESCAPE');
    await h.waitFor(() => !(h.app as any).chat.session.busy);
    expect(signal!.aborted).toBe(true);
  } finally {
    model.mockRestore();
    await h.dispose();
  }
});

test.each([
  [40, 18],
  [65, 18],
  [80, 24],
  [120, 36],
])(
  'Chat composer wraps, grows to four rows, scrolls and shrinks without losing edits (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height, false);
    try {
      await h.key('c');
      const input = () => h.renderer.root.findDescendantById('chat-input') as TextareaRenderable;
      const check = (rows: number) => {
        const composer = h.renderer.root.findDescendantById('chat-composer')!;
        const controls = h.renderer.root.findDescendantById('chat-controls')!;
        expect(input().height).toBe(rows);
        expect(composer.height).toBe(rows + 2);
        expect(controls.y).toBeGreaterThanOrEqual(composer.y + composer.height + 1);
        expect(controls.y + controls.height).toBeLessThanOrEqual(h.renderer.height);
        expect(
          h.renderer.root.findDescendantById('chat-conversation')!.height,
        ).toBeGreaterThanOrEqual(1);
      };
      check(1);
      const original = input();
      await h.mockInput.typeText('word '.repeat(Math.ceil(input().width / 5) + 1));
      await h.flush();
      check(2);
      expect(input()).toBe(original); // Typing resizes the editor without replacing it.
      await h.mockInput.typeText('More newsletter insights. '.repeat(30));
      await h.flush();
      check(4);
      expect(input().scrollY).toBeGreaterThan(0);
      await h.key('HOME');
      expect(input().cursorOffset).toBe(0);
      expect(input().scrollY).toBe(0);
      await h.key('END');
      expect(input().cursorOffset).toBe(input().plainText.length);
      const draft = input().plainText;
      input().cursorOffset = 12;
      await h.key('TAB');
      await h.key('RETURN');
      expect(input().plainText).toBe(draft);
      expect(input().cursorOffset).toBe(12);
      h.resize(40, 18);
      h.renderer.emit('theme_mode', 'light');
      await h.flush();
      check(4);
      expect(input().cursorOffset).toBe(12);
      input().selectAll();
      await h.mockInput.typeText('First line');
      await h.flush();
      check(1);
      h.mockInput.pressKey('j', { ctrl: true });
      await h.mockInput.typeText('Second line');
      await h.flush();
      expect(input().plainText).toBe('First line\nSecond line');
      check(2);
      expect((h.app as any).chat.session.entries).toHaveLength(0);
      await h.key('F4');
      await h.key('ESCAPE');
      expect(input().plainText).toBe('First line\nSecond line');
      check(2);
      input().selectAll();
      input().insertText('a'.repeat(1999) + '🙂');
      await h.flush();
      expect(input().plainText).toBe('a'.repeat(1999));
      input().insertText('bc');
      expect(input().plainText).toHaveLength(2000);
      input().selectAll();
      input().insertText('Pasted\r\nmessage');
      await h.flush();
      expect(input().plainText).toBe('Pasted\nmessage');
      check(2);
      await h.key('END');
      for (let i = 0; i < 'message'.length + 1; i++) await h.key('BACKSPACE');
      check(1);
      expect(input().plainText).toBe('Pasted');
    } finally {
      await h.dispose();
    }
  },
);

test('Chat keeps partial evidence readable and its sources keyboard accessible after an invalid answer', async () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
  ]) {
    const h = await harness(width, height);
    let calls = 0;
    const model = spyOn(h.controller, 'chatStep').mockImplementation(async () => ({
      action: calls++ === 0 ? 'findings' : 'answer',
      plan: null,
      search: { ...EMPTY_SEARCH, limit: 1 },
      sources: calls === 1 ? [] : [999],
      text: calls === 1 ? '' : 'Unsupported prose [999].',
    }));
    try {
      await h.key('c');
      await h.mockInput.typeText('Summarize recent mail');
      await h.key('RETURN');
      const chat = (h.app as any).chat;
      await h.waitFor(() => !chat.session.busy);
      await h.flush();
      expect(calls).toBe(3);
      expect(chat.session.entries.at(-1).role).toBe('app');
      expect(chat.session.entries.at(-1).text).toContain('Collected evidence');
      expect(nodeText(h.renderer.root)).toContain('Partial coverage');
      expect(nodeText(h.renderer.root)).not.toContain('Unsupported prose');
      expect(await h.frame()).toContain('evidence/citation');
      h.mockInput.pressKey('o', { ctrl: true });
      await h.flush();
      expect(await h.frame()).toContain('Enter Open source');
      await h.key('RETURN');
      expect(await h.frame()).toContain('Original email');
      await h.key('ESCAPE');
      await h.key('ESCAPE');
      await h.key('F4');
      expect(nodeText(h.renderer.root)).toContain('answer validation failed');
      expect(nodeText(h.renderer.root)).toContain('answer_validation');
    } finally {
      model.mockRestore();
      await h.dispose();
    }
  }
});

test.each([
  [40, 18],
  [50, 30],
  [65, 18],
  [80, 24],
  [120, 40],
])(
  'Live polling stays quiet and never moves summary or destinations; real work and sync failures remain visible (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height);
    try {
      h.controller.saved.mode = 'live';
      Object.defineProperty(h.controller, 'inboxSummary', {
        get: () => 'The fictional budget needs approval. '.repeat(20),
      });
      const bounds = () =>
        ['inbox-summary', 'dashboard-review', 'dashboard-newsletters', 'dashboard-chat'].map(
          (id) => {
            const node = h.renderer.root.findDescendantById(id)!;
            return [node.x, node.y, node.width, node.height];
          },
        );
      for (const screen of ['inbox', 'home'] as const) {
        h.app.screen = screen;
        h.app.render();
        await h.flush();
        (h.app as any).cursor = (h.app as any).rows.findIndex(
          (row: any) => row.id === 'newsletters',
        );
        h.app.render();
        await h.flush();
        const baseline = bounds();
        for (const state of [
          'sync',
          'snapshot',
          'analysis',
          'analysis-sync',
          'idle',
          'write',
          'idle',
        ] as const) {
          h.controller.syncing = state === 'sync' || state === 'analysis-sync';
          h.controller.snapshotting = state === 'snapshot';
          h.controller.busy =
            state === 'snapshot' || state === 'analysis' || state === 'analysis-sync';
          h.controller.writeProgress =
            state === 'write' ? { done: 1, total: 2, verified: 1 } : undefined;
          h.controller.changed();
          const frame = await h.frame();
          expect(bounds(), `${width}x${height} ${screen} ${state}`).toEqual(baseline);
          expect((h.app as any).current.id).toBe('newsletters');
          expect(frame).toContain('● Live');
          expect(frame).not.toContain('Syncing');
          expect(frame).not.toContain('fresh snapshot');
          expect(frame).toContain('c Ask your inbox');
          expect(frame).toContain(', Settings');
          if (state === 'analysis' || state === 'analysis-sync')
            expect(frame).toContain('Analyzing');
          else if (state === 'write') expect(frame).toContain('Marking read');
          else expect((h.app as any).activity.timer).toBeUndefined();
        }
        h.controller.syncError = true;
        h.controller.status = 'Sync failed: reconnect your account.';
        h.controller.changed();
        expect(await h.frame()).toContain('Sync failed');
        expect(bounds()).toEqual(baseline);
        h.controller.syncError = false;
      }
      h.controller.saved.mode = 'adhoc';
      h.controller.snapshotting = true;
      h.controller.busy = true;
      h.controller.changed();
      expect(await h.frame()).toContain('Syncing inbox');
    } finally {
      h.controller.busy = false;
      h.controller.snapshotting = false;
      h.controller.syncing = false;
      h.controller.syncError = false;
      h.controller.writeProgress = undefined;
      await h.dispose();
    }
  },
);

test.each([
  [40, 18],
  [80, 24],
  [120, 36],
])(
  'Ollama Settings selects Tev1 by keyboard and keeps decision models out of review (%dx%d)',
  async (width, height) => {
    const h = await harness(width, height);
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
      if (String(url).endsWith('/api/tags'))
        return Response.json({
          models: [{ name: 'qwen3.5:4b' }, { name: 'qwen3.5:9b' }, { name: 'tev1:4b' }],
        });
      const model = JSON.parse(String(init?.body)).model;
      return Response.json({ capabilities: [model === 'tev1:4b' ? 'decision' : 'completion'] });
    }) as typeof fetch);
    try {
      (h.app as any).demo = false;
      await h.key(',');
      await h.key('RETURN');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      expect((h.app as any).draft.provider).toBe('ollama');
      await h.key('ARROW_DOWN');
      expect((h.app as any).settingsFocus).toBe('classifier');
      expect(nodeText(h.renderer.root)).toContain('decision model such as Tev1');
      await h.key('RETURN');
      await h.waitFor(() => !(h.app as any).modelsLoading);
      expect((h.app as any).localModels).toContain('tev1:4b');
      await h.key('ARROW_DOWN');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      expect((h.app as any).draft.ollamaClassifier).toBe('tev1:4b');
      expect(h.controller.saved.settings).toBeUndefined();
      await h.key('ARROW_DOWN');
      expect((h.app as any).settingsFocus).toBe('model');
      await h.key('RETURN');
      await h.waitFor(() => !(h.app as any).modelsLoading);
      expect((h.app as any).localModels).toEqual(['qwen3.5:4b', 'qwen3.5:9b']);
      await h.key('RETURN');
      await h.key('s');
      await h.waitFor(() => !(h.app as any).savingSettings);
      expect(h.controller.saved.settings).toMatchObject({
        provider: 'ollama',
        ollamaClassifier: 'tev1:4b',
        ollamaModel: 'qwen3.5:4b',
      });
      const dock = h.renderer.root.findDescendantById('settings-dock')!;
      expect(dock.y + dock.height).toBeLessThanOrEqual(height);
      expect(
        fetcher.mock.calls.every(
          ([url]) => String(url).endsWith('/api/tags') || String(url).endsWith('/api/show'),
        ),
      ).toBe(true);
    } finally {
      fetcher.mockRestore();
      await h.dispose();
    }
  },
);

test.each([
  [40, 18],
  [80, 24],
])(
  'Settings Test stages and cancellation keep the draft and focus (%dx%d)',
  async (width, height) => {
    const { decisionResponse, routine } = await import('./classification-fixtures.ts');
    const h = await harness(width, height);
    let release: (response: Response) => void = () => {};
    let calls = 0;
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      calls++;
      return new Promise<Response>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch);
    try {
      (h.app as any).demo = false;
      h.app.config.apiKey = 'fictional-test-key';
      await h.key(',');
      // Change a field using the keyboard so cancellation must preserve an unsaved draft.
      await h.key('ARROW_DOWN');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      await h.key('ARROW_DOWN');
      await h.key('RETURN');
      const draft = structuredClone((h.app as any).draft);
      const focus = (h.app as any).settingsFocus;
      const saved = structuredClone(h.controller.saved);
      await h.key('t');
      await h.waitFor(() => calls === 1);
      expect(await h.frame()).toContain('Testing classification');
      release(Response.json(decisionResponse(routine)));
      await h.waitFor(() => calls === 2);
      expect(await h.frame()).toContain('Testing detailed review');
      h.resize(width === 40 ? 80 : 40, 18);
      await h.flush();
      await h.key('ESCAPE');
      await h.waitFor(() => !(h.app as any).testingSettings);
      expect(await h.frame()).toContain('Test cancelled');
      expect((h.app as any).draft).toEqual(draft);
      expect((h.app as any).settingsFocus).toBe(focus);
      expect(h.controller.saved).toEqual(saved);
      expect(calls).toBe(2);
      await h.key('ESCAPE');
      expect((h.app as any).settingsPicker).toBe('discard');
      await h.key('ESCAPE');
      expect((h.app as any).draft).toEqual(draft);
    } finally {
      fetcher.mockRestore();
      await h.dispose();
    }
  },
);
