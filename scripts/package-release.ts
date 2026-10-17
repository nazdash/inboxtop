import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir, copyFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { name, version } from '../package.json';
import { sha256, sourceFiles, writeChecksums } from './release-files.ts';
const root = resolve(import.meta.dir, '..');
const dist = resolve(import.meta.dir, '../dist');
const sources = await sourceFiles(root);
const sourceName = `${name}-${version}-source`;
const candidates: string[] = [];
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (
    !entry.isDirectory() ||
    !entry.name.startsWith(`${name}-${version}-`) ||
    !existsSync(join(dist, entry.name, 'BUILD.json'))
  )
    continue;
  const manifest = JSON.parse(await readFile(join(dist, entry.name, 'BUILD.json'), 'utf8'));
  if (
    manifest.name !== name ||
    manifest.version !== version ||
    JSON.stringify(manifest.source) !== JSON.stringify(sources)
  )
    throw new Error(`Source changed since ${entry.name} was built. Rebuild before packaging.`);
  candidates.push(entry.name);
}
if (!candidates.length) throw new Error('No current build candidates. Run npm run build first.');
// Stage source outside the checkout: Bun discovers tests in extracted source folders.
const temporary = await mkdtemp(join(tmpdir(), 'inboxtop-source-release-'));
try {
  const sourceDirectory = join(temporary, sourceName);
  await mkdir(sourceDirectory);
  for (const file of Object.keys(sources)) {
    await mkdir(dirname(join(sourceDirectory, file)), { recursive: true });
    await copyFile(join(root, file), join(sourceDirectory, file));
  }
  for (const label of [...candidates, sourceName]) {
    const parent = label === sourceName ? temporary : dist;
    await writeChecksums(join(parent, label));
    const archive = join(dist, label + '.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', parent, label], {
      stdio: 'inherit',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    await writeFile(archive + '.sha256', `${sha256(await readFile(archive))}  ${label}.tar.gz\n`);
    console.log(archive);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
