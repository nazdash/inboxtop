import { z } from 'zod';
export const PROMPT_VERSION = 'terminal-detail-7';
export interface Classification {
  source_type: 'contact' | 'subscription' | 'service' | 'unknown';
  intent: 'informational' | 'action_required' | 'time_sensitive' | 'transactional' | 'promotional';
  route: 'act' | 'read' | 'clear' | 'check';
  priority: 'high' | 'medium' | 'low';
  needsDetail: boolean;
  newsletter: boolean;
  confidence: number;
  signals: {
    action: number;
    reply: number;
    deadline: number;
    reading: number;
    routine: number;
    uncertain: number;
  };
  reason: string;
  characters: number;
  total: number;
  complete: boolean;
  classifiedAt: string;
  provider: string;
  model: string;
}
export interface Digest {
  key: string;
  text: string;
  created: string;
  messageIDs: string[];
}
export const AnalysisSchema = z
  .object({
    source_type: z.enum(['contact', 'subscription', 'service', 'unknown']),
    intent: z.enum([
      'informational',
      'action_required',
      'time_sensitive',
      'transactional',
      'promotional',
    ]),
    priority: z.enum(['high', 'medium', 'low', 'archive']),
    kind: z.enum(['action', 'time_sensitive', 'newsletter', 'general']),
    takeaway: z.string().min(1).max(1200),
    reason: z.string().min(1).max(800),
    action: z.string().max(800),
    deadline: z.string().max(200),
    context: z.string().max(1200),
    secondary_actions: z.array(z.string().max(500)).max(8),
    blockers: z.array(z.string().max(500)).max(8),
    topics: z
      .array(
        z.object({
          title: z.string().max(200),
          summary: z.string().max(1000),
          relevance: z.enum(['high', 'medium', 'low']),
        }),
      )
      .max(5),
    key_facts: z.array(z.string().max(500)).max(8),
    recommended: z.boolean(),
    recommendation_reason: z.string().max(500),
    requires_response: z.boolean(),
    evidence: z.array(z.string().min(1).max(1000)).min(1).max(6),
    uncertain: z.boolean(),
  })
  .strict();
export type Analysis = z.infer<typeof AnalysisSchema> & {
  // New reviews distinguish uncertainty about the next step from incomplete coverage.
  // Absent on legacy reviews, which are routed using their existing findings.
  decisionUncertain?: boolean;
  coverage?: { stage: 'triage' | 'detail'; characters: number; total: number };
  analyzedAt?: string;
};
export interface Message {
  id: string;
  uid: number;
  validity: string;
  subject: string;
  sender: string;
  address: string;
  date: string;
  read: boolean;
  present: boolean;
  body: string;
  complete: boolean;
  unsubscribe?: string;
  listID?: string;
  analysis?: Analysis;
  classification?: Classification;
  classificationKey?: string;
  detailRequested?: boolean;
  error?: string;
  kept?: boolean;
  cacheKey?: string;
}
export interface Scope {
  mode: 'unread' | 'subscriptions';
  limit: number | null;
  order: 'newest' | 'oldest';
}
export interface Identity {
  account: string;
  mailbox: string;
  validity: string;
}
export interface Receipt {
  id: string;
  messageId: string;
  subject: string;
  uid: number;
  validity: string;
  before: boolean;
  after: boolean;
  status: 'pending' | 'succeeded' | 'skipped' | 'unknown' | 'undone';
  detail: string;
  date: string;
}
export interface Session {
  version: 1;
  identity: Identity;
  scope: Scope;
  uids: number[];
  messages: Message[];
  errors: Record<string, string>;
  created: string;
  provider: string;
  model: string;
  state: 'loading' | 'reviewing' | 'paused' | 'stopped' | 'complete';
  receipts: Receipt[];
  total?: number;
}
export interface Saved {
  version: 1;
  profileRevision?: string;
  session?: Session;
  cache: Record<string, Analysis>;
  library?: Record<string, Message>;
  history?: Receipt[];
  classifications?: Record<string, Classification>;
  digests?: Record<string, Digest>;
  inbox?: { identity: Identity; uids: number[]; at: string };
  mode?: 'adhoc' | 'live';
  analysisPaused?: boolean;
  inboxSummary?: Digest;
  settings?: import('./settings.ts').Settings;
  chats?: Record<string, import('./chat.ts').StoredChat>;
  chatCharges?: import('./chat-policy.ts').Charge[];
  chatMail?: Record<string, { message: Message; at: number }>;
}
export type ReadResult = 'changed' | 'skipped' | 'unknown';
export interface Mailbox {
  snapshot(
    scope: Scope,
  ): Promise<{ identity: Identity; uids: number[]; total?: number; unreadUIDs?: number[] }>;
  fetch(uid: number, identity: Identity): Promise<Message>;
  setRead(message: Message, read: boolean, expected: boolean): Promise<'changed' | 'skipped'>;
  setReadMany?(
    messages: Message[],
    read: boolean,
    expected: boolean,
  ): Promise<Map<string, ReadResult>>;
  close(): Promise<void>;
}
export interface Analyzer {
  chatStep?(
    input: import('./chat.ts').ChatInput,
    signal: AbortSignal,
  ): Promise<import('./chat.ts').ChatStep>;
  classify?(message: Message, signal: AbortSignal): Promise<Classification>;
  summarizeInbox?(messages: Message[], signal: AbortSignal): Promise<string>;
  digest?(messages: Message[], signal: AbortSignal): Promise<string>;
  analyze(message: Message, signal: AbortSignal): Promise<Analysis>;
  review?(
    message: Message,
    signal: AbortSignal,
    stage: (stage: 'triage' | 'detail') => void,
  ): Promise<Analysis>;
}
export function clean(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
export function oneLine(text: string): string {
  return clean(text).replace(/\s+/g, ' ').trim();
}
export function safeURL(value: string | undefined): string | undefined {
  try {
    const u = new URL(value ?? '');
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      !u.hostname ||
      u.hostname === 'localhost' ||
      /^[\d.:[\]]+$/.test(u.hostname) ||
      /\.(local|localhost)$/.test(u.hostname)
    )
      return;
    return u.href;
  } catch {
    return;
  }
}
export function needsAction(m: Message): boolean {
  const a = m.analysis;
  return (
    (!a &&
      ((m.classification?.signals.action ?? 0) >= 0.2 ||
        (m.classification?.signals.reply ?? 0) >= 0.2)) ||
    (!!a &&
      (a.intent === 'action_required' ||
        a.requires_response ||
        !!a.action.trim() ||
        a.secondary_actions.length > 0))
  );
}
export function cleanupCandidate(m: Message): boolean {
  const a = m.analysis;
  if (m.classification && !a)
    return (
      m.present &&
      !m.read &&
      !m.kept &&
      !m.error &&
      m.complete &&
      m.classification.complete &&
      m.classification.route === 'clear' &&
      !m.classification.needsDetail
    );
  return (
    m.present &&
    !m.read &&
    !m.kept &&
    !m.error &&
    m.complete &&
    !!a &&
    !a.uncertain &&
    a.decisionUncertain !== true &&
    (!a.coverage || a.coverage.characters >= a.coverage.total) &&
    a.source_type !== 'unknown' &&
    !needsAction(m) &&
    a.intent !== 'time_sensitive' &&
    !a.deadline &&
    !a.recommended &&
    ['low', 'archive'].includes(a.priority)
  );
}
export const FILTERS = [
  'all',
  'action',
  'reading',
  'cleanup',
  'kept',
  'high',
  'medium',
  'low',
  'archive',
  'retry',
] as const;
export type Filter = (typeof FILTERS)[number];
export function filterMessages(messages: Message[], filter: Filter, query = ''): Message[] {
  return messages.filter(
    (m) =>
      (!query ||
        oneLine(m.sender + ' ' + m.address + ' ' + m.subject)
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (filter === 'all' ||
        (filter === 'action'
          ? needsAction(m) || m.analysis?.intent === 'time_sensitive' || !!m.analysis?.deadline
          : filter === 'reading'
            ? !!m.analysis?.recommended && !m.read && m.present
            : filter === 'kept'
              ? !!m.kept && !m.read && m.present
              : filter === 'cleanup'
                ? cleanupCandidate(m)
                : filter === 'retry'
                  ? !!m.error || !m.analysis || m.analysis.uncertain
                  : m.analysis?.priority === filter)),
  );
}
export interface Finding {
  section: string;
  message: Message;
  text: string;
}
export const SORTS = ['importance', 'newest', 'oldest'] as const;
export type EmailSort = (typeof SORTS)[number];
export const SORT_LABELS: Record<EmailSort, string> = {
  importance: 'Important first',
  newest: 'Newest first',
  oldest: 'Oldest first',
};
function priorityRank(m: Message): number {
  const a = m.analysis;
  if (a?.priority === 'high' || (!a && m.classification?.priority === 'high')) return 0;
  if (
    !a ||
    m.error ||
    !m.complete ||
    a.uncertain ||
    a.source_type === 'unknown' ||
    needsAction(m) ||
    a.deadline ||
    a.intent === 'time_sensitive'
  )
    return 1;
  return { high: 0, medium: 1, low: 2, archive: 3 }[a.priority];
}
function attentionRank(m: Message): number {
  const a = m.analysis;
  if (a?.deadline || a?.intent === 'time_sensitive') return 0;
  if (a?.requires_response || needsAction(m)) return 1;
  if (!a || m.error || a.uncertain || !m.complete || a.source_type === 'unknown') return 2;
  if (a.recommended) return 3;
  return 4;
}
export function sortMessages(
  messages: readonly Message[],
  sort: EmailSort = 'importance',
): Message[] {
  const date = (m: Message) => {
    const value = Date.parse(m.date);
    return Number.isFinite(value) ? value : 0;
  };
  return [...messages].sort((a, b) => {
    if (sort === 'importance') {
      const rank =
        Number(a.read) - Number(b.read) ||
        priorityRank(a) - priorityRank(b) ||
        attentionRank(a) - attentionRank(b);
      if (rank) return rank;
    }
    return (sort === 'oldest' ? date(a) - date(b) : date(b) - date(a)) || a.id.localeCompare(b.id);
  });
}
export function attentionLabel(m: Message): string {
  if (m.read) return 'Read';
  if (!m.analysis || m.error || m.analysis.uncertain || !m.complete) return 'Needs review';
  if (m.analysis.deadline || m.analysis.intent === 'time_sensitive') return 'Deadline';
  if (m.analysis.requires_response) return 'Reply needed';
  if (needsAction(m)) return 'Action needed';
  if (m.kept) return 'Kept unread';
  if (m.analysis.recommended) return 'Worth reading';
  return cleanupCandidate(m) ? 'Can clear' : 'Review';
}
export function briefing(messages: Message[]): Finding[] {
  const out: Finding[] = [];
  for (const section of [
    'Action Required',
    'Upcoming Deadlines',
    'People Waiting',
    'Worth Reading',
    'Notable',
  ]) {
    for (const m of sortMessages(messages)) {
      const a = m.analysis;
      if (!a) continue;
      const include =
        section === 'Action Required'
          ? needsAction(m)
          : section === 'Upcoming Deadlines'
            ? !!a.deadline || a.intent === 'time_sensitive'
            : section === 'People Waiting'
              ? a.source_type === 'contact' && a.requires_response
              : section === 'Worth Reading'
                ? a.recommended
                : a.priority === 'high' &&
                  !needsAction(m) &&
                  !a.deadline &&
                  a.intent !== 'time_sensitive';
      if (include)
        out.push({
          section,
          message: m,
          text:
            section === 'Worth Reading'
              ? a.recommendation_reason || a.takeaway
              : section === 'Upcoming Deadlines'
                ? [a.deadline, a.action || a.takeaway].filter(Boolean).join(' · ')
                : a.action || a.takeaway,
        });
    }
  }
  return out;
}
export interface SenderGroup {
  id: string;
  name: string;
  address: string;
  messages: Message[];
  latest: string;
  unread: number;
  minutes: number;
  unsubscribe?: string;
}
export function senders(messages: Message[]): SenderGroup[] {
  const grouped = new Map<string, SenderGroup>();
  for (const m of messages) {
    const id = m.listID || m.address.toLowerCase();
    let group = grouped.get(id);
    if (!group) {
      group = {
        id,
        name: m.sender,
        address: m.address,
        messages: [],
        latest: m.date,
        unread: 0,
        minutes: 0,
      };
      grouped.set(id, group);
    }
    group.messages.push(m);
    group.unread += Number(!m.read && m.present);
    group.minutes += m.body.split(/\s+/).filter(Boolean).length / 220;
    if (m.date >= group.latest) {
      group.latest = m.date;
      group.unsubscribe = m.unsubscribe || group.unsubscribe;
    }
  }
  return [...grouped.values()].sort(
    (a, b) => b.messages.length - a.messages.length || a.name.localeCompare(b.name),
  );
}

export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
