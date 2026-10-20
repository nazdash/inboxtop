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

/** Missing content is an input problem, not a reason to spend a model call. */
export function requireReadableEmail(message: Message) {
  if (!message.body.trim())
    throw new Error(
      'No readable email text was found. Open the original or retry to fetch it again.',
    );
}

/** Match only literal text, allowing differences in whitespace. Return the
 * original substring for display. Never bridge separate supplied excerpts. */
export function originalQuote(
  quote: string,
  supplied: readonly string[],
  original: readonly string[],
) {
  const words = quote.trim().split(/\s+/u);
  if (!words[0]) return undefined;
  const pattern = new RegExp(
    words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'),
    'u',
  );
  if (!supplied.some((text) => pattern.test(text))) return undefined;
  for (const text of original) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}
