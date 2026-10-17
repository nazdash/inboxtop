import type { Message } from './domain.ts';

export const DETAIL_CHARACTERS = 24000;

/** Keep original text intact in storage. Only redundant whitespace is omitted.
 * A bounded head/tail excerpt includes closing requests without another model call.
 * Never strip signatures, quoted replies or legal footers: they can contain obligations.
 */
export function analysisContent(m: Message, limit = DETAIL_CHARACTERS) {
  const text = m.body.replace(/\n[\t ]*\n(?:[\t ]*\n)+/g, '\n\n').trim();
  const marker = '\n[Middle of email omitted]\n';
  const full = text.length <= limit;
  const budget = Math.max(0, limit - marker.length);
  const head = Math.ceil(budget * 0.75);
  const sections = full ? [text] : [text.slice(0, head), text.slice(-(budget - head))];
  return {
    body: sections.join(marker),
    sections,
    characters: full ? m.body.length : sections.reduce((n, part) => n + part.length, 0),
    total: m.body.length,
    complete: m.complete && full && !!text,
  };
}
