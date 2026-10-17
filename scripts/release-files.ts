import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
export const isNotice = (name: string) =>
  /^(?:license|licence|copying|notice)(?:[._-].*)?$/i.test(name);

/** Git's publishable file list, never a recursive copy of the working directory. */
export async function sourceFiles(root: string) {
  const names = [
    ...new Set(
      execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const files: Record<string, string> = {};
  for (const name of names) {
    if (
      /^(?:docs\/internal|dist|node_modules|\.git|\.cache)(?:\/|$)/.test(name) ||
      /(?:^|\/)\.env(?:$|\.(?!example$))/.test(name) ||
      /[\r\n\\]/.test(name) ||
      /(?:^|\/)(?:cache\.key|session\.enc)$/.test(name)
    )
      throw new Error(`Private or unsafe source path: ${name}`);
    const file = join(root, name);
    const info = await lstat(file).catch(() => undefined);
    if (!info) continue; // Deleted tracked file.
    if (!info.isFile()) throw new Error(`Source packages only accept regular files: ${name}`);
    files[name] = sha256(await readFile(file));
  }
  return files;
}

export async function payloadHashes(
  directory: string,
  relative = '',
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (/[\r\n\\]/.test(name)) throw new Error('Unsafe release filename.');
    if (entry.isSymbolicLink()) throw new Error('Release payload must not contain symbolic links.');
    if (entry.isDirectory()) Object.assign(result, await payloadHashes(directory, name));
    else if (entry.isFile() && name !== 'SHA256SUMS')
      result[name] = sha256(await readFile(join(directory, name)));
  }
  return result;
}

export async function writeChecksums(directory: string) {
  const files = await payloadHashes(directory);
  await writeFile(
    join(directory, 'SHA256SUMS'),
    Object.entries(files)
      .map(([name, hash]) => `${hash}  ${name}\n`)
      .join(''),
  );
}
