import { TextareaRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { writeFile, mkdir } from 'node:fs/promises';
import { Controller } from '../src/controller.ts';
import { DemoMailbox, DemoAnalyzer, demoSession } from '../src/demo.ts';
import { MemoryStore } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';
import { newsletterGroups } from '../src/decisions.ts';
import { LoadingScreen } from '../src/ui/loading.ts';
import { TerminalApp } from '../src/ui/app.ts';
import { EMPTY_SEARCH } from '../src/chat.ts';
import { chatAnswerFixture } from '../tests/fixtures/chat-answer.ts';
await mkdir('docs/internal/previews', { recursive: true });
for (const [width, height] of [
  [120, 36],
  [80, 24],
  [65, 18],
  [50, 24],
  [40, 18],
]) {
  const test = await createTestRenderer({ width, height });
  const loading = new LoadingScreen(test.renderer, () => {});
  loading.update('Connecting to background worker…');
  await test.flush();
  await writeFile(`docs/internal/previews/loading-${width}.txt`, test.captureCharFrame());
  loading.fail('Could not load saved results. Close the app and try again.');
  await test.flush();
  await writeFile(`docs/internal/previews/startup-error-${width}.txt`, test.captureCharFrame());
  loading.dispose();
  const store = new MemoryStore();
  store.value.session = demoSession();
  const controller = new Controller(
    new DemoMailbox(),
    new DemoAnalyzer(),
    store,
    'demo',
    'fictional',
  );
  await controller.init();
  const app = new TerminalApp(test.renderer, controller, loadConfig(false, {}), true);
  await controller.syncInbox();
  for (const screen of [
    'inbox',
    'setup',
    'home',
    'overview',
    'report',
    'confirm',
    'settings',
    'newsletters',
    'newsletter',
    'progress',
    'reader',
  ] as const) {
    if (screen === 'confirm') {
      test.mockInput.pressKey('3');
      await test.flush();
      test.mockInput.pressKey('a');
      await test.flush();
      test.mockInput.pressKey('x');
      await test.flush();
    } else if (screen === 'newsletters' || screen === 'newsletter') {
      app.selected.clear();
      app.screen = 'report';
      app.tab = 'subscriptions';
      app.newsletterID =
        screen === 'newsletter'
          ? newsletterGroups(controller.messages).find((g) => g.messages.length > 1)?.id
          : undefined;
      app.render();
    } else if (screen === 'reader') {
      controller.busy = false;
      app.screen = 'reader';
      app.readerID = controller.messages[0].id;
      app.render();
    } else if (screen === 'progress') {
      app.screen = 'report';
      app.tab = 'emails';
      app.outcome = 'act';
      app.newsletterID = undefined;
      app.selected.clear();
      controller.session!.state = 'reviewing';
      controller.busy = true;
      controller.status = 'Analyzing batch · p stops analysis; completed results stay saved.';
      for (const m of controller.messages.slice(8)) m.analysis = undefined;
      app.render();
    } else {
      app.screen = screen;
      app.render();
    }
    await test.flush();
    await writeFile(`docs/internal/previews/${screen}-${width}.txt`, test.captureCharFrame());
    if (screen === 'confirm') {
      test.mockInput.pressKey('ESCAPE');
      await Bun.sleep(40);
      await test.flush();
    }
    if (screen === 'inbox') {
      test.mockInput.pressKey(';');
      await test.flush();
      await writeFile(`docs/internal/previews/inbox-menu-${width}.txt`, test.captureCharFrame());
      test.mockInput.pressKey(';');
      await test.flush();
      const mode = controller.saved.mode;
      controller.saved.mode = 'live';
      controller.busy = true;
      app.render();
      await test.flush();
      await writeFile(`docs/internal/previews/inbox-live-${width}.txt`, test.captureCharFrame());
      controller.saved.mode = mode;
      controller.busy = false;
      app.render();
    }
    if (screen === 'newsletters') {
      const group = (app as any).current?.newsletter;
      if (group) {
        const savedStatus = controller.status;
        controller.busy = true;
        controller.newsletterProgress = {
          messageIDs: group.messages.map((m: any) => m.id),
          sender: group.name,
        };
        controller.status = `Generating summary · ${group.name}`;
        app.selected.add(group.messages[0].id);
        app.render();
        await test.flush();
        await writeFile(
          `docs/internal/previews/newsletters-selected-busy-${width}.txt`,
          test.captureCharFrame(),
        );
        controller.busy = false;
        controller.newsletterProgress = undefined;
        controller.reviewJobs = [
          {
            id: (controller as any).reviewKey(
              'newsletter',
              group.messages.map((m: any) => m.id),
            ),
            kind: 'newsletter',
            messageIDs: group.messages.map((m: any) => m.id),
            label: group.name,
            state: 'queued',
          },
        ];
        app.selected.clear();
        app.render();
        await test.flush();
        await writeFile(`docs/internal/previews/newsletters-queued-${width}.txt`, test.captureCharFrame());
        controller.reviewJobs = [];
        controller.status = savedStatus;
        app.selected.clear();
        const key = (controller as any).digestKey(group.messages);
        (controller.saved.digests ??= {})[key] = {
          key,
          created: new Date().toISOString(),
          messageIDs: group.messages.map((m: any) => m.id),
          text: 'These issues explore how engineering teams make decisions and operate reliable systems.\n\n## Across the issues\nThe leadership issue focuses on clear ownership and fast feedback. The systems issue turns those ideas into a practical approach to team-scale architecture.\n\n## What to read\nStart with the leadership interviews for the broader lessons; read the systems issue for implementation details.',
        };
        app.render();
        await test.flush();
        await writeFile(`docs/internal/previews/newsletters-${width}.txt`, test.captureCharFrame());
        (app as any).openNewsletterDigest(group);
        await test.flush();
        await writeFile(`docs/internal/previews/newsletter-digest-${width}.txt`, test.captureCharFrame());
        app.screen = 'report';
        (app as any).newsletterSort = 'issues';
        app.render();
        await test.flush();
        await writeFile(
          `docs/internal/previews/newsletters-by-issues-${width}.txt`,
          test.captureCharFrame(),
        );
        (app as any).newsletterSort = 'name';
        app.render();
        await test.flush();
        await writeFile(`docs/internal/previews/newsletters-by-name-${width}.txt`, test.captureCharFrame());
        (app as any).newsletterSort = 'latest';
      }
    }
    if (screen === 'settings') {
      const settingsApp = app as any;
      const snapshot = async (name: string) => {
        app.render();
        await test.flush();
        await writeFile(`docs/internal/previews/settings-${name}-${width}.txt`, test.captureCharFrame());
      };
      settingsApp.settingsAdvanced = true;
      settingsApp.settingsFocus = 'excerpt';
      await snapshot('advanced');
      settingsApp.settingsFocus = 'language';
      settingsApp.settingsPicker = 'language';
      app.cursor = 0;
      await snapshot('choices');
      settingsApp.draft.provider = 'ollama';
      settingsApp.settingsModelField = 'ollamaClassifier';
      settingsApp.settingsPicker = 'model';
      settingsApp.localModels = ['qwen3.5:4b', 'qwen3.5:9b'];
      await snapshot('models');
      settingsApp.settingsPicker = 'discard';
      await snapshot('unsaved');
      settingsApp.settingsPicker = undefined;
      settingsApp.settingsFocus = 'model';
      settingsApp.editingSetting = 'openaiModel';
      await snapshot('edit');
      settingsApp.editingSetting = undefined;
      settingsApp.settingsAdvanced = false;
      settingsApp.draft.provider = 'openai';
      settingsApp.settingsFocus = 'provider';
    }
    if (screen === 'report') {
      (app as any).moreActions = true;
      app.render();
      await test.flush();
      await writeFile(`docs/internal/previews/more-actions-${width}.txt`, test.captureCharFrame());
      (app as any).moreActions = false;
      app.selected = new Set(controller.messages.slice(0, 2).map((m) => m.id));
      app.render();
      await test.flush();
      await writeFile(`docs/internal/previews/selected-actions-${width}.txt`, test.captureCharFrame());
      app.selected.clear();
      app.render();
      for (const group of ['2', '3', '4']) {
        test.mockInput.pressKey(group);
        await test.flush();
        await writeFile(`docs/internal/previews/group-${group}-${width}.txt`, test.captureCharFrame());
      }
      test.mockInput.pressKey('1');
      await test.flush();
    }
    if (screen === 'inbox') {
      test.mockInput.pressKey('v');
      await test.flush();
      await writeFile(`docs/internal/previews/summary-${width}.txt`, test.captureCharFrame());
      test.mockInput.pressKey('ESCAPE');
      await Bun.sleep(40);
      await test.flush();
    }
    if (screen === 'reader') {
      test.mockInput.pressKey('d');
      await test.flush();
      await writeFile(`docs/internal/previews/recommendation-details-${width}.txt`, test.captureCharFrame());
      test.mockInput.pressKey('d');
      await test.flush();
      test.mockInput.pressKey('o');
      await test.flush();
      await writeFile(`docs/internal/previews/original-${width}.txt`, test.captureCharFrame());
    }
  }
  controller.busy = false;
  app.screen = 'inbox';
  app.render();
  test.mockInput.pressKey('c');
  await test.flush();
  await writeFile(`docs/internal/previews/chat-empty-${width}.txt`, test.captureCharFrame());
  const chat = (app as any).chat;
  const composerInput = test.renderer.root.findDescendantById('chat-input') as TextareaRenderable;
  composerInput.insertText(
    'Read through my saved newsletters and summarize the most interesting ideas. '.repeat(5),
  );
  await test.flush();
  await writeFile(`docs/internal/previews/chat-multiline-${width}.txt`, test.captureCharFrame());
  composerInput.selectAll();
  composerInput.deleteSelection();
  await test.flush();
  await chat.submit('Any payment requests?');
  await test.waitFor(() => !chat.session.busy);
  await test.flush();
  const chatDeadline = Date.now() + 3000;
  while (!test.captureCharFrame().includes('Payment') && Date.now() < chatDeadline) {
    await Bun.sleep(10);
    await test.flush();
  }
  if (!test.captureCharFrame().includes('Payment'))
    throw new Error('Chat answer text did not render');
  await writeFile(`docs/internal/previews/chat-answer-${width}.txt`, test.captureCharFrame());
  const answer = chat.session.entries.at(-1);
  const originalAnswer = answer.text;
  answer.text =
    '1. **Payment request** from `Acme` [1].\n\n2. **Check the original** before paying.';
  app.render();
  await test.flush();
  await writeFile(`docs/internal/previews/chat-markdown-${width}.txt`, test.captureCharFrame());
  answer.text = chatAnswerFixture;
  app.render();
  await test.flush();
  await writeFile(`docs/internal/previews/chat-sections-${width}.txt`, test.captureCharFrame());
  test.mockInput.pressKey('F2');
  await test.flush();
  await writeFile(`docs/internal/previews/chat-menu-${width}.txt`, test.captureCharFrame());
  test.mockInput.pressKey('ESCAPE');
  await Bun.sleep(40);
  await test.flush();
  answer.text = originalAnswer;
  app.render();

  test.mockInput.pressKey('o', { ctrl: true });
  await test.flush();
  await writeFile(`docs/internal/previews/chat-sources-${width}.txt`, test.captureCharFrame());
  test.mockInput.pressKey('RETURN');
  await test.flush();
  await writeFile(`docs/internal/previews/chat-source-original-${width}.txt`, test.captureCharFrame());
  for (let back = 0; back < 2; back++) {
    test.mockInput.pressKey('ESCAPE');
    await Bun.sleep(40);
    await test.flush();
  }
  await chat.submit('Mark those emails read');
  await test.waitFor(() => !chat.session.busy);
  await test.flush();
  await writeFile(`docs/internal/previews/chat-confirm-${width}.txt`, test.captureCharFrame());
  chat.session.cancelProposal();
  const normalChatStep = controller.chatStep;
  let finishCalls = 0;
  controller.chatStep = async () => ({
    action: finishCalls++ === 0 ? 'findings' : 'answer',
    plan: null,
    search: { ...EMPTY_SEARCH, limit: 2 },
    sources: finishCalls === 1 ? [] : [999],
    text: finishCalls === 1 ? '' : 'Unsupported prose [999].',
  });
  await chat.submit('Compare the saved findings');
  await test.waitFor(() => !chat.session.busy);
  await test.flush();
  await writeFile(`docs/internal/previews/chat-partial-evidence-${width}.txt`, test.captureCharFrame());
  controller.chatStep = normalChatStep;
  controller.busy = false;
  controller.session!.scope.mode = 'subscriptions';
  (app as any).auditView = true;
  for (const message of controller.messages) message.analysis = undefined;
  app.screen = 'report';
  app.tab = 'subscriptions';
  app.sort = 'newest';
  app.selected.clear();
  app.render();
  await test.flush();
  await writeFile(`docs/internal/previews/audit-${width}.txt`, test.captureCharFrame());
  await app.dispose();
  await controller.close();
  await test.dispose();
}
