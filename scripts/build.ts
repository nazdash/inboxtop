import { mkdir, writeFile, copyFile, cp, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { name, version } from '../package.json';
import { sourceFiles, writeChecksums } from './release-files.ts';
import { dependencyNotices } from './dependency-notices.ts';

// Build on the target runner so native addons and UI assets match the executable.
if (!['darwin', 'linux'].includes(process.platform))
  throw new Error(
    'Standalone releases currently target macOS and Linux. Native Windows verification is pending.',
  );
const root = resolve(import.meta.dir, '..');
const label = `${name}-${version}-${process.platform}-${process.arch}`;
const directory = join(root, 'dist', label);
// A fresh output prevents removed licenses, docs or an old companion leaking into a new build.
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const executable = join(directory, 'inboxtop');
// Bun embeds some CommonJS __dirname values. A clean, neutral staging path keeps
// build-machine usernames/project locations out of redistributed executables.
// Copy only build inputs, never .env or the user's ignored local data.
const stage = await mkdtemp('/tmp/inboxtop-compile-');
try {
  for (const directory of ['src', 'node_modules'])
    await cp(join(root, directory), join(stage, directory), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json'])
    await copyFile(join(root, file), join(stage, file));
  const result = await Bun.build({
    entrypoints: [join(stage, 'src/index.ts')],
    root: stage,
    compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false },
    define: { INBOXTOP_COMPILED: 'true', 'process.env.OPENTUI_LIBC': JSON.stringify('glibc') },
    minify: false,
  });
  if (!result.success) throw new AggregateError(result.logs, 'Standalone build failed.');
} finally {
  await rm(stage, { recursive: true, force: true });
}
// Copy only publishable docs, never recursively include local plans/research.
const sources = await sourceFiles(root);
for (const file of Object.keys(sources).filter((file) => file.startsWith('docs/'))) {
  await mkdir(dirname(join(directory, file)), { recursive: true });
  await copyFile(join(root, file), join(directory, file));
}
for (const file of [
  'AGENTS.md',
  'CLAUDE.md',
  'ARCHITECTURE.md',
  'PRINCINPLES.md',
  'UI-PRINCIPLES.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.env.example',
]) {
  await copyFile(join(root, file), join(directory, file));
}
await writeFile(
  join(directory, 'README.md'),
  `# inboxtop ${version}\n\nRun ./inboxtop to enter credentials locally or try ./inboxtop --demo without credentials.\nKeep this directory together, including the optional inboxtop Menu.app.\nNo Node.js, npm, Bun or source checkout is needed.\n\nSee docs/SETUP.md for setup and docs/RECOVERY.md for recovery/removal.\nOffline automation: ./inboxtop setup --schema and ./inboxtop doctor --json.\nThese local candidate builds are not Developer ID signed/notarized releases.\n`,
);
if (existsSync(join(root, 'LICENSE')))
  await copyFile(join(root, 'LICENSE'), join(directory, 'LICENSE'));
await cp(join(root, 'third-party'), join(directory, 'third-party'), { recursive: true });
await dependencyNotices(root, directory);
await writeFile(
  join(directory, 'BUILD.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      name,
      version,
      target: `${process.platform}-${process.arch}`,
      executable: 'inboxtop',
      runtime: { name: 'bun', version: Bun.version, revision: Bun.revision },
      source: sources,
    },
    null,
    2,
  ) + '\n',
);
await writeChecksums(directory);
console.log(`Built ${directory}`);
