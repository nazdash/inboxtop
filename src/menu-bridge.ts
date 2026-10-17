import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { DestinationSchema } from './destinations.ts';
import { MENU_PROTOCOL, MenuCommandSchema } from './menu-status.ts';
import { workerRequest, ensureWorker, workerSocket } from './worker.ts';
import { loadRuntimeConfig } from './credentials.ts';
import { compiled } from './runtime.ts';

// Terminal's do-script API requires shell text. Quote every argument, then pass the
// complete text as an osascript argv value (never interpolate it into AppleScript).
export function terminalCommand(
  destination: string,
  envFile?: string,
  cwd = process.cwd(),
  profilePath?: string,
) {
  const target = DestinationSchema.parse(destination);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const args = [
    compiled ? process.execPath : resolve(import.meta.dir, '../inboxtop'),
    '--open',
    target,
  ];
  if (profilePath) args.push('--profile', resolve(profilePath));
  else if (envFile) args.push('--env', resolve(envFile));
  return `cd ${quote(cwd)} && ${args.map(quote).join(' ')}`;
}
export async function openTerminal(
  destination: string,
  envFile?: string,
  cwd?: string,
  profilePath?: string,
) {
  if (process.platform !== 'darwin')
    throw new Error('Opening Terminal is supported on macOS only.');
  await promisify(execFile)('/usr/bin/osascript', [
    '-e',
    `on run argv
    tell application "Terminal"
      activate
      do script (item 1 of argv)
    end tell
  end run`,
    terminalCommand(destination, envFile, cwd, profilePath),
  ]);
}
export async function runBridge(args: string[]) {
  const [command, ...options] = args;
  const values: Record<string, string> = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i];
    if (
      !['--socket', '--env', '--profile', '--cwd', '--value'].includes(key) ||
      !options[i + 1] ||
      key in values
    )
      throw new Error('Invalid menu bridge arguments.');
    values[key] = options[i + 1];
  }
  if (values['--cwd']) process.chdir(values['--cwd']);
  if (command === 'open') {
    await openTerminal(values['--value'], values['--env'], values['--cwd'], values['--profile']);
    return { ok: true };
  }
  const socket = values['--socket'];
  if (!socket) throw new Error('Missing worker connection. Open inboxtop to reconnect.');
  if (command === 'connect') {
    const config = await loadRuntimeConfig(values['--env'], values['--profile']);
    if (workerSocket(config) !== socket)
      throw new Error('Configuration changed. Reopen the menu from terminal Settings.');
    const found = await ensureWorker(config, values['--env']);
    if (found !== socket)
      throw new Error('Configuration changed. Reopen the menu from terminal Settings.');
  } else if (command !== 'status') {
    const request = MenuCommandSchema.parse({
      command,
      ...(values['--value'] ? { value: values['--value'] } : {}),
    });
    await workerRequest(socket, '/menu/command', request, undefined, 60000);
  }
  const status = await workerRequest(socket, '/menu/status');
  if (status.protocol !== MENU_PROTOCOL)
    throw new Error('Menu companion needs an update. Open inboxtop.');
  return status;
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runBridge(process.argv.slice(2))));
  } catch (error) {
    // Diagnostics from the worker can include personal content. Show only a fixed
    // error to the helper; the terminal remains the place for detailed diagnostics.
    console.log(
      JSON.stringify({
        error: 'Could not complete the request. Open inboxtop to check the connection or settings.',
      }),
    );
    process.exitCode = 1;
  }
}
