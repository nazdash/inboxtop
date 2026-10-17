import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { compiled } from './runtime.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const menuAppPath = compiled
  ? resolve(dirname(process.execPath), 'inboxtop Menu.app')
  : resolve(import.meta.dir, '../dist/inboxtop Menu.app');
export function menuAvailable() {
  return (
    process.platform === 'darwin' && existsSync(resolve(menuAppPath, 'Contents/MacOS/inboxtopMenu'))
  );
}
export async function launchMenu(socket: string, envFile?: string, profilePath?: string) {
  if (process.platform !== 'darwin')
    throw new Error('The menu companion is available on macOS only.');
  await access(resolve(menuAppPath, 'Contents/MacOS/inboxtopMenu')).catch(() => {
    throw new Error('Build the menu companion first: npm run build:menu');
  });
  // Starting/reopening the menu helper must not take keyboard focus from the terminal.
  const args = ['-g', '-a', menuAppPath, '--args', '--socket', socket, '--cwd', process.cwd()];
  if (profilePath) args.push('--profile', resolve(profilePath));
  else if (envFile) args.push('--env', resolve(envFile));
  await promisify(execFile)('/usr/bin/open', args);
}
