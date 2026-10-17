import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
if (process.platform !== 'darwin') throw new Error('Build the optional menu companion on macOS.');
const root = resolve(import.meta.dir, '..');
const standalone = process.argv.indexOf('--standalone');
const destination = standalone >= 0 ? process.argv[standalone + 1] : undefined;
if (standalone >= 0 && !destination) throw new Error('Pass the standalone binary directory.');
const contents = join(
  destination ? resolve(destination) : join(root, 'dist'),
  'inboxtop Menu.app/Contents',
);
await mkdir(join(contents, 'MacOS'), { recursive: true });
await mkdir(join(contents, 'Resources'), { recursive: true });
await mkdir(join(root, '.cache/swift'), { recursive: true });
await promisify(execFile)('/usr/bin/xcrun', [
  'swiftc',
  '-swift-version',
  '5',
  '-target',
  `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
  '-O',
  '-framework',
  'AppKit',
  '-module-cache-path',
  join(root, '.cache/swift'),
  join(root, 'macos/main.swift'),
  '-o',
  join(contents, 'MacOS/inboxtopMenu'),
]);
await writeFile(
  join(contents, 'Resources/runtime.json'),
  JSON.stringify({
    executable: destination ? '@inboxtop' : process.execPath,
    bridge: destination ? '--menu-bridge' : join(root, 'src/menu-bridge.ts'),
    directory: destination ? '@bundle-parent' : root,
  }),
);
await writeFile(
  join(contents, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.inboxtop.terminal.menu</string>
<key>CFBundleName</key><string>inboxtop Menu</string>
<key>CFBundleDisplayName</key><string>inboxtop Menu</string>
<key>CFBundleExecutable</key><string>inboxtopMenu</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>LSMultipleInstancesProhibited</key><true/>
<key>NSAppleEventsUsageDescription</key><string>Open inboxtop destinations in Terminal.</string>
</dict></plist>`,
);
await promisify(execFile)('/usr/bin/codesign', ['--force', '--sign', '-', resolve(contents, '..')]);
console.log(`Built ${resolve(contents, '..')}. Enable Show in menu bar in terminal Settings.`);
