import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotice, sha256 } from './release-files.ts';

/** Inventory is intentionally broader than tree-shaken JS; native internals are called out separately. */
export async function dependencyNotices(root: string, output: string) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const packages = [];
  const notices = [
    '# Third-party notices\n\nSee docs/DEPENDENCIES.md for native runtime sources and redistribution limits.\n',
  ];
  for (const [path, meta] of Object.entries(lock.packages).sort(([a], [b]) =>
    a.localeCompare(b),
  ) as [string, any][]) {
    if (
      !path ||
      !existsSync(join(root, path)) ||
      (meta.dev && !/node_modules\/(?:bun(?:-types)?$|@oven\/)/.test(path))
    )
      continue;
    const pkg = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
    const files = (await readdir(join(root, path))).filter(isNotice).sort();
    const texts: { file: string; sha256: string }[] = [];
    notices.push(
      `\n## ${pkg.name} ${pkg.version}\n\nDeclared license: ${pkg.license || meta.license || 'UNKNOWN'}\n`,
    );
    for (const file of files) {
      const text = await readFile(join(root, path, file), 'utf8');
      notices.push(`\n### ${file}\n\n${text}\n`);
      texts.push({ file, sha256: sha256(text) });
    }
    let inheritedFrom: string | undefined;
    if (!files.length && pkg.name.startsWith('@napi-rs/keyring-')) {
      inheritedFrom = '@napi-rs/keyring/LICENSE';
      notices.push(
        '\nBinding license: see @napi-rs/keyring above. Rust dependencies need separate accounting.\n',
      );
    }
    if (!files.length && /^(bun|bun-types|@oven\/bun-)/.test(pkg.name)) {
      inheritedFrom = 'third-party/BUN-LICENSE.md';
      notices.push(
        '\nRuntime terms and source/rebuild instructions: see bundled BUN-LICENSE and docs/DEPENDENCIES.md.\n',
      );
    }
    if (!files.length && !inheritedFrom) throw new Error(`Missing license text: ${pkg.name}`);
    packages.push({
      name: pkg.name,
      version: pkg.version,
      path,
      license: pkg.license || meta.license || 'UNKNOWN',
      integrity: meta.integrity || null,
      licenseFiles: texts,
      ...(inheritedFrom ? { inheritedFrom } : {}),
    });
  }
  notices.push(
    '\n## Bun runtime upstream license information\n\n' +
      (await readFile(join(root, 'third-party/BUN-LICENSE.md'), 'utf8')),
  );
  await writeFile(join(output, 'THIRD-PARTY-NOTICES.md'), notices.join(''));
  await writeFile(
    join(output, 'DEPENDENCIES.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        scope:
          'Installed runtime npm packages and Bun; includes packages that may be removed by bundling. Not a complete native-library SBOM.',
        packages,
        nativeReview:
          'See docs/DEPENDENCIES.md; npm metadata alone does not cover Bun or Rust internals.',
      },
      null,
      2,
    ) + '\n',
  );
}
