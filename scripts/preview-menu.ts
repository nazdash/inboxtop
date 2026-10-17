import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Controller } from '../src/controller.ts';
import { DemoMailbox, DemoAnalyzer, demoSession } from '../src/demo.ts';
import { MemoryStore } from '../src/store.ts';
import { menuStatus } from '../src/menu-status.ts';
const store = new MemoryStore();
store.value.session = demoSession();
const c = new Controller(new DemoMailbox(), new DemoAnalyzer(), store, 'demo', 'fictional');
await c.init();
await c.syncInbox();
const status = { ...menuStatus(c, 1), enabled: true, mode: 'live' as const };
await c.close();
await mkdir('docs/internal/previews', { recursive: true });
const path = resolve('docs/internal/previews/menu-fixture.json');
await writeFile(path, JSON.stringify(status));
const binary = resolve('dist/inboxtop Menu.app/Contents/MacOS/inboxtopMenu');
const check = await promisify(execFile)(binary, ['--check-fixture', path]);
if (!check.stdout.includes(`${status.groups.act} emails need action`))
  throw new Error('Native accessibility label does not match the shared Act count.');
if (!check.stdout.includes('Icon: act')) throw new Error('Act mail must use the action icon.');
const zero = resolve('docs/internal/previews/menu-zero-fixture.json');
await writeFile(
  zero,
  JSON.stringify({ ...status, mode: 'adhoc', groups: { ...status.groups, act: 0 } }),
);
const noBadge = await promisify(execFile)(binary, ['--check-fixture', zero]);
if (!noBadge.stdout.includes('Icon: idle'))
  throw new Error('Zero Act count must use the plain envelope.');
const problem = resolve('docs/internal/previews/menu-error-fixture.json');
await writeFile(
  problem,
  JSON.stringify({
    ...status,
    issue: 'Sync failed',
    blockingIssue: {
      title: 'Inbox sync failed',
      detail: 'Check connection and mail settings.',
      destination: 'settings',
    },
  }),
);
const warning = await promisify(execFile)(binary, ['--check-fixture', problem]);
if (!warning.stdout.includes('Icon: problem'))
  throw new Error('Problems must have a distinct warning icon.');
const isolated = resolve('docs/internal/previews/menu-isolated-error-fixture.json');
await writeFile(
  isolated,
  JSON.stringify({
    ...status,
    issue: 'Some emails could not be analyzed · open inboxtop',
    blockingIssue: null,
  }),
);
const isolatedCheck = await promisify(execFile)(binary, ['--check-fixture', isolated]);
if (!isolatedCheck.stdout.includes('Icon: act'))
  throw new Error('An isolated failure must preserve the Act icon.');
const provider = resolve('docs/internal/previews/menu-provider-error-fixture.json');
await writeFile(
  provider,
  JSON.stringify({
    ...status,
    blockingIssue: {
      title: 'AI credentials rejected',
      detail: 'Check your API key and access.',
      destination: 'settings',
    },
  }),
);
const providerCheck = await promisify(execFile)(binary, ['--check-fixture', provider]);
if (!providerCheck.stdout.includes('Icon: problem'))
  throw new Error('A blocked provider must use the warning icon.');
await promisify(execFile)(binary, [
  '--fixture',
  provider,
  '--render-header',
  resolve('docs/internal/previews/menu-header-problem.png'),
]);
await promisify(execFile)(binary, ['--render-icons', resolve('docs/internal/previews/menu-icons.png')]);
for (const appearance of ['light', 'dark']) {
  await promisify(execFile)(binary, [
    '--fixture',
    path,
    '--render-header',
    resolve(`docs/internal/previews/menu-header-${appearance}.png`),
    '--appearance',
    appearance,
  ]);
}
console.log('Native decoding, accessibility counts, icon states and light/dark headers verified.');
if (process.argv.includes('--open')) {
  await promisify(execFile)('/usr/bin/open', [
    '-a',
    resolve('dist/inboxtop Menu.app'),
    '--args',
    '--fixture',
    path,
  ]);
  console.log(
    'Opened fictional menu preview. Hide menu bar icon closes it; no real mailbox is used.',
  );
}
