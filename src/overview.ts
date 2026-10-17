import { cleanupCandidate, needsAction, sortMessages, type Message } from './domain.ts';
import { inboxStats } from './inbox-stats.ts';
import { decisionQueues, analysisReady } from './decisions.ts';
import type { Controller } from './controller.ts';
export type Period = 'all' | 'today' | 'week';
export const PERIOD_LABELS: Record<Period, string> = {
  all: 'All unread',
  today: 'Received today',
  week: 'This week (Mon–now)',
};
export function inPeriod(
  messages: readonly Message[],
  period: Period,
  now = new Date(),
): Message[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return messages.filter(
    (m) =>
      m.present &&
      !m.read &&
      (period === 'all' ||
        (Date.parse(m.date) >= start.getTime() && Date.parse(m.date) <= now.getTime())),
  );
}
export function summarize(messages: readonly Message[], period: Period = 'all', now = new Date()) {
  const rows = inPeriod(messages, period, now);
  return {
    unread: rows.length,
    analyzed: rows.filter(analysisReady).length,
    action: rows.filter(
      (m) => needsAction(m) || !!m.analysis?.deadline || m.analysis?.intent === 'time_sensitive',
    ).length,
    reading: rows.filter((m) => m.analysis?.recommended).length,
    cleanup: rows.filter(cleanupCandidate).length,
    uncertain: decisionQueues(rows).check.length,
    failed: rows.filter((m) => !!m.error).length,
    findings: sortMessages(rows).map((m) => ({
      message: m,
      section: needsAction(m)
        ? 'Action Required'
        : m.analysis?.deadline || m.analysis?.intent === 'time_sensitive'
          ? 'Upcoming Deadlines'
          : m.analysis?.recommended
            ? 'Worth Reading'
            : cleanupCandidate(m)
              ? 'Suggested Cleanup'
              : !m.analysis || m.analysis.uncertain || m.error
                ? 'Needs Review'
                : 'Notable',
      text: m.analysis?.takeaway || 'Awaiting analysis — open the original to inspect.',
    })),
  };
}
/** Versioned, content-free projection for CLI and a future menu-bar service. */
export function statusSnapshot(c: Controller, now = new Date()) {
  const count = (period: Period) => {
    const { findings: _, ...counts } = summarize(c.pool, period, now);
    return counts;
  };
  return {
    version: 1,
    generatedAt: now.toISOString(),
    snapshotAt: c.session?.created ?? null,
    scope: c.session?.scope ?? null,
    inboxUnreadAtSnapshot: c.session?.scope.mode === 'unread' ? (c.session.total ?? null) : null,
    provider: c.provider,
    model: c.model,
    state: c.busy ? 'working' : (c.session?.state ?? 'idle'),
    mode: c.mode,
    analysisPaused: c.analysisPaused,
    monitoring: c.monitoring,
    nextRefresh: c.nextRefresh ?? null,
    progress: c.progress,
    inbox: inboxStats(c),
    outcomes: Object.fromEntries(
      Object.entries(decisionQueues(c.pool)).map(([name, rows]) => [name, rows.length]),
    ),
    all: count('all'),
    today: count('today'),
    week: count('week'),
  };
}
