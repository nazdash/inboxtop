import { z } from 'zod';

export const ChatPlanSchema = z
  .object({
    goal: z.enum(['locate', 'explain', 'synthesize', 'check_task']),
    after: z.string().max(10),
    before: z.string().max(10),
    dateOrigin: z
      .enum(['explicit', 'conversation', 'inferred'])
      .describe(
        'explicit: user supplied a period, including relative dates such as last two months; conversation: reuse a user-specified period; inferred: model chose a period the user did not supply.',
      ),
    evidence: z.array(z.string().max(160)).max(4),
    stopWhen: z.string().max(240),
  })
  .strict();
export type ChatPlan = z.infer<typeof ChatPlanSchema>;
export type ChatAccess = 'saved' | 'connected';
export const LIMITS = {
  turn: {
    calls: 8,
    input: 120000,
    searches: 6,
    headers: 100,
    bodies: 20,
    bytes: 5 * 1024 ** 2,
    ms: 120000,
  },
  conversation: {
    calls: 24,
    input: 240000,
    searches: 12,
    headers: 200,
    bodies: 40,
    bytes: 10 * 1024 ** 2,
    ms: 300000,
  },
  hour: { calls: 48, input: 480000, bodies: 80, bytes: 20 * 1024 ** 2 },
} as const;
export type Usage = {
  calls: number;
  input: number;
  searches: number;
  headers: number;
  bodies: number;
  bytes: number;
  ms: number;
};
export const emptyUsage = (): Usage => ({
  calls: 0,
  input: 0,
  searches: 0,
  headers: 0,
  bodies: 0,
  bytes: 0,
  ms: 0,
});
export interface Charge {
  at: number;
  usage: Usage;
}
export interface ChatLedger {
  usage: Usage;
  window?: { after: string; before: string };
  historyKnown: boolean;
  bodyBytes?: Record<string, number>;
  mailboxState?: import('./chat-mail.ts').ChatMailboxState;
}
export class ChatLimit extends Error {}
export class ChatMailboxError extends Error {}
export function validDay(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** Resolve a single, unambiguous rolling period supplied by the user. This is
 * only a scope hint; unrecognized wording remains the model's responsibility. */
export function explicitChatWindow(question: string, today: string) {
  if (!validDay(today)) return;
  // Do not anchor a historical or qualified range to today. Let the model
  // interpret it instead of overriding a different intended end date.
  if (/\b(?:ago|ending|ended|before|until|through)\b|\b\d{4}\b/i.test(question)) return;
  const matches = [
    ...question.matchAll(
      /\b(?:last|past)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?|months?)\b/gi,
    ),
  ];
  if (matches.length !== 1) return;
  const [, amount, unit] = matches[0];
  const words = [
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
  ];
  const count = /^\d+$/.test(amount) ? Number(amount) : words.indexOf(amount.toLowerCase()) + 1;
  if (!Number.isInteger(count) || count < 1 || count > 90) return;
  const date = new Date(`${today}T00:00:00Z`);
  if (unit.toLowerCase().startsWith('month')) {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - count);
    const lastDay = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    ).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  } else {
    date.setUTCDate(date.getUTCDate() - count * (unit.toLowerCase().startsWith('week') ? 7 : 1));
  }
  return { after: date.toISOString().slice(0, 10), before: today };
}
export function validateWindow(after: string, before: string) {
  if (!validDay(after) || !validDay(before) || after > before)
    throw new Error('Choose valid start and end dates (YYYY-MM-DD) before searching the inbox.');
  if ((Date.parse(before) - Date.parse(after)) / 86400000 >= 90)
    throw new Error('Choose a period of at most 90 days. A wider mailbox search is not available.');
}
export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return Object.fromEntries(
    Object.entries(a).map(([k, n]) => [k, n + (b[k as keyof Usage] ?? 0)]),
  ) as Usage;
}
export function checkUsage(
  used: Usage,
  cost: Partial<Usage>,
  limits: Partial<Usage>,
  label: string,
) {
  for (const [key, cap] of Object.entries(limits)) {
    const k = key as keyof Usage;
    if (used[k] + (cost[k] ?? 0) > cap)
      throw new ChatLimit(
        `${label} limit reached (${key}). Existing answers and sources are kept. Narrow the request or wait for the allowance to renew.`,
      );
  }
}
export interface ChatDetails {
  access: ChatAccess;
  plan?: ChatPlan;
  operations: { tool: string; reason: string; result: string }[];
  stop: string;
  usage: Usage;
}
export const ChatDetailsSchema = z
  .object({
    access: z.enum(['saved', 'connected']),
    plan: ChatPlanSchema.optional(),
    operations: z
      .array(
        z
          .object({
            tool: z.string().max(40),
            reason: z.string().max(240),
            result: z.string().max(1000),
          })
          .strict(),
      )
      .max(16),
    stop: z.string().max(80),
    usage: z
      .object({
        calls: z.number(),
        input: z.number(),
        searches: z.number(),
        headers: z.number(),
        bodies: z.number(),
        bytes: z.number(),
        ms: z.number(),
      })
      .strict(),
  })
  .strict();

/** Factual operation receipts for people, not raw tool JSON or hidden reasoning. */
export function describeChatTool(value: Record<string, unknown>): string {
  if (value.error) return String(value.error);
  const q = (value.query ?? value.scope) as
    | { after?: string; before?: string; sender?: string; terms?: string[]; state?: string }
    | undefined;
  const filters = q
    ? [
        q.after && `${q.after}–${q.before || 'now'}`,
        q.sender && `Sender: ${q.sender}`,
        q.terms?.length && `Terms: ${q.terms.join(' / ')}`,
        q.state !== 'all' && q.state,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const count =
    value.returned ?? (Array.isArray(value.results) ? value.results.length : value.total);
  const total = value.total ?? value.matched;
  const summary =
    count === undefined
      ? 'Scope checked'
      : `${count} returned${total === undefined ? '' : ` / ${total}${value.countQuality === 'lower-bound' ? '+' : ''} matches`}`;
  return [
    filters,
    summary,
    value.nextOffset != null ? 'More results remain' : undefined,
    value.complete === false ? 'Partial mailbox coverage' : undefined,
    value.budgetLimited ? 'Evidence limit reached' : undefined,
    ...(Array.isArray(value.omissions) ? value.omissions.map(String) : []),
    ...(Array.isArray(value.results)
      ? value.results.map((r: any) =>
          r.error
            ? `[${r.ref}] ${r.error}`
            : `[${r.ref}] Characters ${r.start}–${r.end}${r.nextOffset != null ? '; more text remains' : ''}`,
        )
      : []),
  ]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 1000);
}
