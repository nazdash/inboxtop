import { cleanupCandidate, needsAction, oneLine, sortMessages, type Message } from './domain.ts';
import type { AnalysisLanguage } from './language.ts';
import { inPeriod, type Period } from './overview.ts';

export const OUTCOMES = ['act', 'read', 'clear', 'check'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABELS: Record<Outcome, string> = {
  act: 'Act',
  read: 'Read',
  clear: 'Can mark as read',
  check: 'Check manually',
};
export const OUTCOME_DESCRIPTIONS: Record<Outcome, string> = {
  act: 'Reply, approve, pay, or handle a deadline',
  read: 'Information worth your attention',
  clear: 'Routine mail — review before marking read',
  check: 'Incomplete or uncertain analysis — inspect the original',
};
export function pendingDetail(m: Message): boolean {
  return (
    m.present &&
    !m.read &&
    !m.error &&
    !m.analysis &&
    !!(m.classification?.needsDetail || m.classification?.route === 'check' || m.detailRequested)
  );
}
export function analysisReady(m: Message): boolean {
  return !m.error && (!!m.analysis || (!!m.classification && !pendingDetail(m)));
}
/** Failed reviews need an explicit retry; Live must not schedule empty batches for them. */
export function needsAutomaticReview(m: Message | undefined): boolean {
  return !m || (m.present && !m.read && !m.error && !analysisReady(m));
}
export function summaryText(m: Message): string {
  if (m.error) return 'Review failed — retry or inspect the original.';
  if (m.analysis) return m.analysis.takeaway;
  if (pendingDetail(m)) return 'Summary preparing · ' + m.classification?.reason;
  return m.classification?.reason ?? 'Waiting for classification — original available.';
}
export function outcomeOf(m: Message): Outcome {
  const a = m.analysis;
  if (!a && m.classification && !m.error) {
    const c = m.classification;
    if (c.route === 'clear') return cleanupCandidate(m) ? 'clear' : m.kept ? 'read' : 'check';
    return c.route;
  }
  if (!a || m.error || a.decisionUncertain === true) return 'check';
  // A concrete next step is useful even when its real-world status is unknown.
  if (needsAction(m) || a.deadline || a.intent === 'time_sensitive') return 'act';
  if (cleanupCandidate(m)) return 'clear';
  const incomplete = !m.complete || (a.coverage && a.coverage.characters < a.coverage.total);
  if (a.decisionUncertain === undefined && (a.uncertain || incomplete)) {
    // Reuse legacy reading recommendations, but never silently resolve an old
    // classifier/detail disagreement in favor of reading or cleanup.
    const signals = m.classification?.signals;
    const conflict = signals && Math.max(signals.action, signals.reply, signals.deadline) >= 0.5;
    if (!conflict && a.recommended && a.intent === 'informational') return 'read';
    return 'check';
  }
  return 'read';
}
export function decisionQueues(messages: readonly Message[], period: Period = 'all') {
  const queues: Record<Outcome, Message[]> = { act: [], read: [], clear: [], check: [] };
  for (const m of sortMessages(inPeriod(messages, period)))
    if (analysisReady(m) || m.error) queues[outcomeOf(m)].push(m);
  return queues;
}
const short = (value: string, length: number) => {
  const text = oneLine(value);
  if (text.length <= length) return text;
  const prefix = text.slice(0, length - 1);
  const boundary = prefix.lastIndexOf(' ');
  return (boundary > length / 2 ? prefix.slice(0, boundary) : prefix).trimEnd() + '…';
};
export function dashboardSummary(
  messages: readonly Message[],
  period: Period = 'all',
  language: AnalysisLanguage = 'en',
): string {
  const q = decisionQueues(messages, period);
  const total = OUTCOMES.reduce((n, key) => n + q[key].length, 0);
  const ru = language === 'ru';
  if (!total)
    return inPeriod(messages, period).length
      ? ru
        ? 'Письма анализируются. Рекомендации появятся по мере готовности.'
        : 'Classifying your selected emails. Recommendations appear as each classification finishes.'
      : ru
        ? 'В сохранённом списке нет непрочитанных писем. Обновите входящие.'
        : 'No unread emails in this saved view. Update inbox to check for new mail.';
  // A brief fallback while the synthesized overview is unavailable. The category
  // controls already show the full breakdown; surface only the leading topics.
  const highlights = [...q.act, ...q.read]
    .slice(0, 2)
    .map(
      (m) =>
        `${short(m.sender, 28)}: ${short(m.analysis?.takeaway || m.classification?.reason || m.subject, 110)}`,
    );
  if (q.clear.length)
    highlights.push(
      ru
        ? `Можно отметить прочитанными: ${q.clear.length}.`
        : `${q.clear.length} emails can be marked read.`,
    );
  if (!highlights.length)
    highlights.push(
      ru
        ? 'Откройте письма с неполным или неуверенным анализом для ручной проверки.'
        : 'Open emails with incomplete or uncertain analysis for a manual check.',
    );
  return highlights.join('\n');
}
export function inboxBriefingCounts(messages: readonly Message[]) {
  const queues = decisionQueues(messages.filter(analysisReady));
  const ready = Object.values(queues).flat();
  const newsletters = ready.filter(isNewsletter);
  return {
    analyzed: ready.length,
    act: queues.act.length,
    read: queues.read.length,
    canMarkRead: queues.clear.length,
    checkManually: queues.check.length,
    replyRequested: queues.act.filter((m) => m.analysis?.requires_response).length,
    newsletterIssues: newsletters.length,
    newslettersWorthReading: newsletters.filter(
      (m) => newsletterVerdict(m).label === 'Read in full',
    ).length,
  };
}
export function isNewsletter(m: Message): boolean {
  return (
    !!m.classification?.newsletter ||
    !!m.listID ||
    m.analysis?.source_type === 'subscription' ||
    m.analysis?.kind === 'newsletter'
  );
}
export function newsletterVerdict(m: Message): { label: string; reason: string } {
  if (m.error) return { label: 'Analysis failed', reason: 'Retry analysis or open the original.' };
  const outcome = outcomeOf(m);
  if (pendingDetail(m))
    return {
      label: 'Summary preparing',
      reason: m.classification?.reason ?? 'Detailed review requested.',
    };
  if (outcome === 'check')
    return {
      label: 'Check manually',
      reason: 'The review is incomplete or uncertain. Inspect this issue before deciding.',
    };
  if (outcome === 'act')
    return { label: 'Action inside', reason: m.analysis?.action || summaryText(m) };
  if (m.analysis?.recommended)
    return {
      label: 'Read in full',
      reason: m.analysis.recommendation_reason || m.analysis.takeaway,
    };
  if (outcome === 'clear')
    return {
      label: m.analysis ? 'Summary may be enough' : 'Routine issue',
      reason: m.analysis?.reason || m.classification?.reason || '',
    };
  return {
    label: 'Consider reading',
    reason:
      m.analysis?.recommendation_reason || m.analysis?.reason || m.classification?.reason || '',
  };
}
export type NewsletterScope = 'unread' | 'all';
export const NEWSLETTER_SCOPE_LABELS: Record<NewsletterScope, string> = {
  unread: 'Unread',
  all: 'All analyzed',
};

export type NewsletterSort = 'latest' | 'issues' | 'name';
export const NEWSLETTER_SORT_LABELS: Record<NewsletterSort, string> = {
  latest: 'Latest issue',
  issues: 'Issue count',
  name: 'Name',
};
export interface NewsletterGroup {
  id: string;
  name: string;
  address: string;
  messages: Message[];
  summary: string;
  preview: string;
  recommendation: string;
  reviewed: number;
}
export function newsletterGroups(
  messages: readonly Message[],
  period: Period = 'all',
  sort: NewsletterSort = 'latest',
  scope: NewsletterScope = 'unread',
): NewsletterGroup[] {
  const groups = new Map<string, Message[]>();
  // Read status must not make an unfinished classification count as analyzed.
  const analyzed = messages.filter(
    (m) =>
      isNewsletter(m) &&
      !m.error &&
      (m.analysis
        ? m.analysis.coverage?.stage !== 'triage'
        : !!m.classification &&
          !m.classification.needsDetail &&
          m.classification.route !== 'check' &&
          !m.detailRequested),
  );
  const scoped = scope === 'all' ? analyzed : inPeriod(analyzed, period);
  for (const m of scoped) {
    const id = m.address.trim().toLowerCase() || m.listID || m.id;
    groups.set(id, [...(groups.get(id) ?? []), m]);
  }
  return [...groups]
    .map(([id, rows]) => {
      const messages = sortMessages(rows, 'newest');
      const reviewed = messages.filter(
        (m) => !!m.analysis && m.analysis.coverage?.stage !== 'triage' && !m.error,
      );
      const highlights = [...new Set(messages.map((m) => oneLine(summaryText(m))))];
      const worthy = messages.filter((m) => newsletterVerdict(m).label === 'Read in full');
      const checks = messages.filter((m) => analysisReady(m) && outcomeOf(m) === 'check');
      const actions = messages.filter((m) => outcomeOf(m) === 'act');
      return {
        id,
        name: messages[0].sender,
        address: messages[0].address,
        messages,
        reviewed: reviewed.length,
        preview: highlights.length
          ? highlights
              .slice(0, 2)
              .map((text) => short(text, 85))
              .join(' ') +
            (highlights.length > 2
              ? ` Plus ${highlights.length - 2} more summaries in the full digest.`
              : '')
          : 'No summaries available yet.',
        summary: highlights.length
          ? highlights.join('\n\n')
          : 'These issues have not been analyzed yet. Open an original to inspect it.',
        recommendation: [
          worthy.length
            ? `${worthy.length} issue${worthy.length === 1 ? '' : 's'} worth reading in full.`
            : 'No issue is currently recommended for a full read.',
          actions.length ? `${actions.length} contain an action or deadline.` : '',
          checks.length ? `${checks.length} still need a manual check.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
    })
    .sort((a, b) => {
      const byName =
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.id.localeCompare(b.id);
      if (sort === 'name') return byName;
      if (sort === 'issues') return b.messages.length - a.messages.length || byName;
      return (
        (Date.parse(b.messages[0].date) || 0) - (Date.parse(a.messages[0].date) || 0) || byName
      );
    });
}
