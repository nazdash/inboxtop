import { z } from 'zod';
import { type Message } from './domain.ts';
import { isNewsletter, outcomeOf, summaryText } from './decisions.ts';

export const ChatSearchSchema = z
  .object({
    terms: z.array(z.string().max(80)).max(8),
    sender: z.string().max(160),
    after: z.string().max(10),
    before: z.string().max(10),
    state: z.enum(['all', 'read', 'unread']),
    category: z.enum(['all', 'act', 'read', 'clear', 'check']),
    kind: z.enum(['all', 'newsletter', 'contact', 'service', 'unknown']),
    area: z.enum(['findings', 'original']),
    offset: z.number().int().min(0).max(10000000),
    limit: z.number().int().min(1).max(30),
  })
  .strict();
export type ChatSearch = z.infer<typeof ChatSearchSchema>;
export const EMPTY_SEARCH: ChatSearch = {
  terms: [],
  sender: '',
  after: '',
  before: '',
  state: 'all',
  category: 'all',
  kind: 'all',
  area: 'findings',
  offset: 0,
  limit: 10,
};
const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase();
export function chatKind(m: Message) {
  return isNewsletter(m)
    ? 'newsletter'
    : (m.analysis?.source_type ?? m.classification?.source_type ?? 'unknown');
}
function findingsText(m: Message) {
  const a = m.error ? undefined : m.analysis;
  return [
    m.error ? '' : summaryText(m),
    a?.action,
    a?.reason,
    a?.context,
    a?.deadline,
    ...(a?.key_facts ?? []),
    ...(a?.topics.flatMap((t) => [t.title, t.summary]) ?? []),
    ...(a?.secondary_actions ?? []),
    ...(a?.blockers ?? []),
  ]
    .filter(Boolean)
    .join(' ');
}
export function rankChat(rows: Message[], query: ChatSearch): Message[] {
  const q = ChatSearchSchema.parse(query);
  for (const date of [q.after, q.before]) {
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date)
    )
      throw new Error('Dates must use YYYY-MM-DD.');
  }
  if (q.after && q.before && q.after > q.before)
    throw new Error('The start date must be before the end date.');
  const terms = q.terms.map((t) => normalize(t.trim())).filter(Boolean);
  return rows
    .flatMap((m) => {
      if (q.state !== 'all' && m.read !== (q.state === 'read')) return [];
      if (q.sender && !normalize(`${m.sender} ${m.address}`).includes(normalize(q.sender.trim())))
        return [];
      if (
        ((q.after || q.before) && Number.isNaN(Date.parse(m.date))) ||
        (q.after && m.date.slice(0, 10) < q.after) ||
        (q.before && m.date.slice(0, 10) > q.before)
      )
        return [];
      if (q.kind !== 'all' && chatKind(m) !== q.kind) return [];
      if (q.category !== 'all' && (!m.analysis || m.error)) return [];
      if (q.category !== 'all' && outcomeOf({ ...m, read: false }) !== q.category) return [];
      const title = normalize(`${m.sender} ${m.address} ${m.subject}`);
      const body = normalize(q.area === 'original' ? m.body : findingsText(m));
      const score = terms.reduce(
        (sum, t) => sum + (title.includes(t) ? 3 : body.includes(t) ? 1 : 0),
        0,
      );
      return terms.length && !score ? [] : [{ message: m, score }];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.message.date.localeCompare(a.message.date) ||
        a.message.id.localeCompare(b.message.id),
    )
    .map((r) => r.message);
}
export function searchChat(rows: Message[], query: ChatSearch) {
  const ranked = rankChat(rows, query);
  const messages = ranked.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + messages.length;
  return {
    total: ranked.length,
    messages,
    nextOffset: nextOffset < ranked.length ? nextOffset : null,
  };
}
export function discoverChat(rows: Message[], query: ChatSearch) {
  const matches = rankChat(rows, query);
  const senders = new Map<string, { sender: string; address: string; count: number }>();
  const kinds: Record<string, number> = {};
  let earliest = '',
    latest = '',
    unread = 0,
    missingDates = 0;
  for (const m of matches) {
    const key = normalize(m.address || m.sender);
    const sender = senders.get(key) ?? {
      sender: m.sender.slice(0, 160),
      address: m.address.slice(0, 160),
      count: 0,
    };
    sender.count++;
    senders.set(key, sender);
    const kind = chatKind(m);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    unread += Number(!m.read);
    if (Number.isNaN(Date.parse(m.date))) {
      missingDates++;
      continue;
    }
    const date = m.date.slice(0, 10);
    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;
  }
  const sorted = [...senders.values()].sort(
    (a, b) => b.count - a.count || a.address.localeCompare(b.address),
  );
  const nextOffset = query.offset + query.limit;
  return {
    total: matches.length,
    unread,
    read: matches.length - unread,
    kinds,
    earliest,
    latest,
    missingDates,
    senderCount: sorted.length,
    senders: sorted.slice(query.offset, nextOffset),
    nextOffset: nextOffset < sorted.length ? nextOffset : null,
  };
}
/** Saved findings, not an assertion that an original or linked article was read. */
export function savedFindings(m: Message, detailed: boolean) {
  const a = m.error ? undefined : m.analysis;
  const full = !!a && a.coverage?.stage !== 'triage';
  return {
    read: m.read,
    available: m.present,
    kind: chatKind(m),
    evidenceType:
      m.error || (!a && !m.classification)
        ? 'metadata_only'
        : full
          ? 'saved_analysis'
          : 'classification_only',
    summary: (m.error ? '' : summaryText(m)).slice(0, detailed ? 1200 : 600),
    summaryTruncated: summaryText(m).length > (detailed ? 1200 : 600),
    action: a?.action,
    deadline: a?.deadline,
    uncertain: !!a?.uncertain,
    originalIncomplete: !m.complete,
    analysisCoverage: a?.coverage,
    ...(detailed
      ? {
          topics: a?.topics,
          facts: a?.key_facts,
          context: a?.context,
          secondaryActions: a?.secondary_actions,
          blockers: a?.blockers,
        }
      : {}),
  };
}
/** Literal terms locate an original passage, including beyond the first 6,000 chars. */
export function originalPassage(m: Message, offset: number, terms: string[]) {
  const needles = terms.map((t) => t.trim()).filter(Boolean);
  let start = offset;
  if (needles.length) {
    // Escape every metacharacter: these are literal terms. Match the unchanged
    // body so Unicode case folding cannot shift the returned character offsets.
    const text = m.body.slice(offset);
    const hits = needles
      .map((term) => {
        const literal = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = new RegExp(literal, 'iu').exec(text);
        return match ? offset + match.index : -1;
      })
      .filter((i) => i >= 0);
    if (!hits.length)
      return { matched: false, totalCharacters: m.body.length, originalComplete: m.complete };
    start = Math.max(offset, Math.min(...hits) - 400);
  }
  const text = m.body.slice(start, start + 4000);
  const end = start + text.length;
  return {
    matched: true,
    start,
    end,
    text,
    totalCharacters: m.body.length,
    originalComplete: m.complete,
    nextOffset: end < m.body.length ? end : null,
    complete: m.complete && start === 0 && end === m.body.length,
  };
}

export type OriginalExcerpt = Extract<ReturnType<typeof originalPassage>, { text: string }>;

/** Keep selected evidence once, even when keyword windows overlap or touch. */
export function mergeOriginalPassages(passages: OriginalExcerpt[]): OriginalExcerpt[] {
  const merged: OriginalExcerpt[] = [];
  for (const passage of [...passages].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (!previous || passage.start > previous.end) {
      merged.push({ ...passage });
    } else if (passage.end > previous.end) {
      previous.text += passage.text.slice(previous.end - passage.start);
      previous.end = passage.end;
      previous.nextOffset = passage.nextOffset;
      previous.complete =
        previous.originalComplete &&
        previous.start === 0 &&
        previous.end === previous.totalCharacters;
    }
  }
  return merged;
}
