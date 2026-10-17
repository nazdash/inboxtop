import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Supplemental preflight, not a replacement for a dedicated secret scanner/review.
// Report only location/rule: never print matching credential or email content.
const run = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const rules: [string, RegExp][] = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{35,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
];
let failures = 0;
function scan(text: string, location: string) {
  for (const [rule, regex] of rules)
    if (regex.test(text)) {
      console.error(`${location}: possible ${rule}; inspect privately`);
      failures++;
    }
}
const files = [
  ...new Set(
    run('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean),
  ),
];
for (const file of files) {
  if (
    /^(?:\.env(?:\.|$)(?!example$)|docs\/internal(?:\/|$)|.*\/(?:session\.enc|cache\.key)$)/.test(
      file,
    )
  ) {
    console.error(`${file}: private artifact would be published`);
    failures++;
    continue;
  }
  try {
    scan(readFileSync(file, 'utf8'), file);
  } catch {
    /* Deleted tracked files are checked in history. */
  }
}
const history = run('rev-list', '--all', '--objects');
for (const entry of history.split('\n')) {
  const [id, ...path] = entry.split(' ');
  if (!path.length) continue;
  if (run('cat-file', '-t', id).trim() !== 'blob') continue;
  scan(run('cat-file', 'blob', id), `history:${id.slice(0, 12)} ${path.join(' ')}`);
  if (/^(?:\.env$|docs\/internal(?:\/|$)|.*\/(?:session\.enc|cache\.key)$)/.test(path.join(' '))) {
    console.error(`history:${id.slice(0, 12)}: private artifact; inspect privately`);
    failures++;
  }
}
console.log(
  `Scanned ${files.length} publishable files and reachable Git history. ${failures} findings.`,
);
console.log(
  'Manual review of screenshots, personal data, dependency licenses and a dedicated secret scan are still release requirements.',
);
process.exitCode = failures ? 1 : 0;
