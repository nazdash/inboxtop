import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isNotice, payloadHashes, sourceFiles, writeChecksums } from '../scripts/release-files.ts';

test('notice collection covers hyphenated native licenses and alternative spellings', () => {
  for (const file of [
    'LICENSE',
    'license.txt',
    'LICENSE-WUFFS',
    'LICENSE-MIT.txt',
    'LICENSE.EUPL-1.2',
    'COPYING',
    'NOTICE.md',
    'LICENCE',
  ])
    expect(isNotice(file)).toBe(true);
  for (const file of ['package.json', 'README.md']) expect(isNotice(file)).toBe(false);
});

test('release checksums include nested payloads and reject linked content outside the bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-hash-'));
  try {
    await mkdir(join(dir, 'menu'));
    await writeFile(join(dir, 'inboxtop'), 'fictional binary');
    await writeFile(join(dir, 'menu/runtime.json'), '{}');
    await writeChecksums(dir);
    const before = await readFile(join(dir, 'SHA256SUMS'), 'utf8');
    expect(before).toContain('  menu/runtime.json');
    expect(before).not.toContain('  SHA256SUMS');
    await writeFile(join(dir, 'menu/runtime.json'), '{"changed":true}');
    await writeChecksums(dir);
    expect(await readFile(join(dir, 'SHA256SUMS'), 'utf8')).not.toBe(before);
    await symlink('/etc/hosts', join(dir, 'outside'));
    await expect(payloadHashes(dir)).rejects.toThrow('symbolic links');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('source packaging excludes ignored local data and refuses tracked private files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-source-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    await writeFile(join(dir, '.gitignore'), '.env\n/docs/internal/\n');
    await writeFile(join(dir, '.env'), 'FICTIONAL=private');
    await mkdir(join(dir, 'docs/internal'), { recursive: true });
    await writeFile(join(dir, 'docs/internal/plan.md'), 'internal');
    await writeFile(join(dir, 'docs/SETUP.md'), 'public setup');
    await writeFile(join(dir, '.env.example'), 'FICTIONAL=example');
    await writeFile(join(dir, 'app.ts'), 'export {}');
    expect(Object.keys(await sourceFiles(dir))).toEqual([
      '.env.example',
      '.gitignore',
      'app.ts',
      'docs/SETUP.md',
    ]);
    execFileSync('git', ['add', '--force', 'docs/internal/plan.md'], { cwd: dir });
    await expect(sourceFiles(dir)).rejects.toThrow('Private or unsafe');
    execFileSync('git', ['rm', '--cached', 'docs/internal/plan.md'], { cwd: dir });
    execFileSync('git', ['add', '--force', '.env'], { cwd: dir });
    await expect(sourceFiles(dir)).rejects.toThrow('Private or unsafe');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
