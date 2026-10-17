import { resolve } from 'node:path';
declare const INBOXTOP_COMPILED: boolean | undefined;
export const compiled = typeof INBOXTOP_COMPILED !== 'undefined' && INBOXTOP_COMPILED;
export function runtimeCommand(args: string[]) {
  return [process.execPath, ...(compiled ? [] : [resolve(import.meta.dir, 'index.ts')]), ...args];
}
