import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { payloadHashes, sha256, writeChecksums } from './release-files.ts';

// Deliberately not part of build/CI: submitting code to Apple is an explicit release action.
const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log(`Usage: npm run prepare:mac-signing -- DIST_DIRECTORY [--execute] [--notarize]
Default: print the plan only; no signing, uploads or credential access.
Execute: MAC_SIGN_IDENTITY must be the SHA-1 of an installed Developer ID Application certificate.
Notarize: also set MAC_NOTARY_PROFILE to an existing notarytool Keychain profile.
No passwords or private keys are accepted as command arguments. No GitHub publishing.`);
  process.exit(0);
}
if (process.platform !== 'darwin') throw new Error('Mac signing runs on macOS.');
const execute = args.includes('--execute'),
  notarize = args.includes('--notarize');
if (args.slice(1).some((a) => !['--execute', '--notarize'].includes(a)))
  throw new Error('Unknown signing option.');
const input = resolve(args[0]);
const manifest = JSON.parse(await readFile(join(input, 'BUILD.json'), 'utf8'));
if (!/^darwin-(?:arm64|x64)$/.test(manifest.target) || manifest.executable !== 'inboxtop')
  throw new Error('Expected a macOS release candidate.');
const identity = process.env.MAC_SIGN_IDENTITY || '<certificate SHA-1>';
const profile = process.env.MAC_NOTARY_PROFILE || '<notary Keychain profile>';
if (execute && !/^[a-f\d]{40}$/i.test(identity))
  throw new Error('Set MAC_SIGN_IDENTITY to a Developer ID Application certificate SHA-1.');
if (execute && notarize && (!process.env.MAC_NOTARY_PROFILE || /[\r\n\0]/.test(profile)))
  throw new Error('Set MAC_NOTARY_PROFILE to an existing notarytool Keychain profile.');
if (execute) {
  const identities = execFileSync(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8' },
  );
  if (
    !identities
      .split('\n')
      .some(
        (line) =>
          line.toLowerCase().includes(identity.toLowerCase()) &&
          line.includes('Developer ID Application:'),
      )
  )
    throw new Error(
      'The chosen certificate is not an available Developer ID Application identity.',
    );
  const actual = Object.entries(await payloadHashes(input))
    .map(([file, hash]) => `${hash}  ${file}\n`)
    .join('');
  if (actual !== (await readFile(join(input, 'SHA256SUMS'), 'utf8')))
    throw new Error('Candidate checksums are stale. Run package:release and verify:release first.');
}
const output = join(root, 'dist/signed');
if (execute) await mkdir(output, { recursive: true });
const stage = execute ? await mkdtemp(join(output, '.stage-')) : join(output, '<temporary-stage>');
const directory = join(stage, basename(input));
const binary = join(directory, manifest.executable);
const menu = join(directory, 'inboxtop Menu.app');
const hasMenu = existsSync(join(input, 'inboxtop Menu.app'));
const image = join(output, `${basename(input)}${notarize ? '-notarized' : '-signed'}.dmg`);
if (execute && existsSync(image)) {
  await rm(stage, { recursive: true, force: true });
  throw new Error(
    'Output already exists. Move the previous signed candidate aside before preparing another.',
  );
}
function run(tool: string, argv: string[]) {
  if (!execute) {
    console.log(JSON.stringify([tool, ...argv]));
    return '';
  }
  return execFileSync(tool, argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}
function submit(path: string) {
  const raw = run('/usr/bin/xcrun', [
    'notarytool',
    'submit',
    path,
    '--keychain-profile',
    profile,
    '--wait',
    '--output-format',
    'json',
  ]);
  if (execute) {
    const result = JSON.parse(raw);
    if (result.status !== 'Accepted')
      throw new Error(
        `Apple did not accept this submission (${result.id}). Inspect its notarytool log before distributing.`,
      );
  }
}
try {
  if (execute) await cp(input, directory, { recursive: true, errorOnExist: true, force: false });
  else console.log('Copy candidate into a temporary staging directory; the input stays unchanged.');
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    identity,
    '--timestamp',
    '--options',
    'runtime',
    '--entitlements',
    join(root, 'macos/terminal-entitlements.plist'),
    binary,
  ]);
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', binary]);
  if (hasMenu) {
    run('/usr/bin/codesign', [
      '--force',
      '--sign',
      identity,
      '--timestamp',
      '--options',
      'runtime',
      menu,
    ]);
    run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', menu]);
  }
  if (execute) {
    // Verify the hardened runtime before any upload to Apple.
    const home = join(stage, 'fictional-home');
    await mkdir(home);
    execFileSync('python3', [join(root, 'scripts/smoke-terminal.py')], {
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        HOME: home,
        INBOXTOP_TEST_BINARY: binary,
      },
    });
  } else console.log('Run fictional terminal smoke tests against the staged, signed executable.');
  if (notarize && hasMenu) {
    const zip = join(stage, 'menu.zip');
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', menu, zip]);
    submit(zip);
    run('/usr/bin/xcrun', ['stapler', 'staple', menu]);
    run('/usr/bin/xcrun', ['stapler', 'validate', menu]);
  }
  if (execute) {
    const readme = await readFile(join(directory, 'README.md'), 'utf8');
    await writeFile(
      join(directory, 'README.md'),
      readme.replace(
        'These local candidate builds are not Developer ID signed/notarized releases.',
        'This is a Developer ID signed candidate. See SIGNING.md; notarization applies to the final disk image only after Apple accepts it.',
      ),
    );
    await writeFile(
      join(directory, 'SIGNING.md'),
      'Developer ID signed candidate. Verify this exact downloaded disk image and run the fictional smoke tests before distribution.\n',
    );
    await writeChecksums(directory);
  } else console.log('Refresh all payload checksums after signing/stapling.');
  run('/usr/bin/hdiutil', ['create', '-ov', '-format', 'UDZO', '-srcfolder', directory, image]);
  run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', image]);
  if (notarize) {
    submit(image);
    run('/usr/bin/xcrun', ['stapler', 'staple', image]);
    run('/usr/bin/xcrun', ['stapler', 'validate', image]);
    run('/usr/sbin/spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=2',
      image,
    ]);
  }
  if (execute) {
    await writeFile(image + '.sha256', `${sha256(await readFile(image))}  ${basename(image)}\n`);
    console.log(
      `Prepared ${image}. Test the downloaded/quarantined artifact on a clean Mac before release.`,
    );
  }
} finally {
  if (execute) await rm(stage, { recursive: true, force: true });
}
