import type { Controller } from './controller.ts';
import { analysisReady, outcomeOf, pendingDetail, OUTCOMES, type Outcome } from './decisions.ts';
import type { Message } from './domain.ts';

export function inboxStats(c: Controller) {
  const inbox = c.saved.inbox;
  const library = new Map(Object.values(c.saved.library ?? {}).map((m) => [m.id, m]));
  for (const m of c.messages)
    library.set(
      m.id,
      c.session?.scope.mode === 'subscriptions'
        ? {
            ...m,
            analysis: library.get(m.id)?.analysis,
            classification: library.get(m.id)?.classification,
          }
        : m,
    );
  let rows: Message[], total: number | null;
  if (inbox) {
    const prefix = `${inbox.identity.account}:${inbox.identity.mailbox}:${inbox.identity.validity}:`;
    const known = inbox.uids.map((uid) => library.get(prefix + uid));
    rows = known.filter((m): m is Message => !!m && !m.read && m.present);
    total = inbox.uids.length - known.filter((m) => m && (m.read || !m.present)).length;
    // Undo can restore an unread message outside the last snapshot's membership.
    const members = new Set(inbox.uids);
    for (const m of library.values())
      if (m.id.startsWith(prefix) && !members.has(m.uid) && !m.read && m.present) {
        rows.push(m);
        total++;
      }
  } else {
    rows = c.messages.filter((m) => m.present && !m.read);
    total =
      c.session?.scope.mode === 'unread'
        ? c.session.total === undefined
          ? null
          : Math.max(
              rows.length,
              c.session.total - c.messages.filter((m) => m.read || !m.present).length,
            )
        : null;
  }
  const classified = rows.filter((m) => m.classification || m.analysis).length;
  const readyRows = rows.filter(analysisReady);
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const m of rows) if (analysisReady(m) || m.error) outcomes[outcomeOf(m)]++;
  return {
    total,
    unanalyzed: total === null ? null : Math.max(0, total - readyRows.length),
    classified,
    ready: readyRows.length,
    reviewable: readyRows.length + rows.filter((m) => m.error).length,
    pending: rows.filter(pendingDetail).length,
    unclassified: total === null ? null : Math.max(0, total - classified),
    failed: rows.filter((m) => m.error).length,
    outcomes,
    snapshotAt: inbox?.at ?? c.session?.created ?? null,
    known: rows.length,
  };
}
/** Allocate exactly width cells, including zero and tiny categories, without overrun. */
export function barCells(values: readonly number[], width: number): number[] {
  const total = values.reduce((n, x) => n + Math.max(0, x), 0);
  if (!total || width <= 0) return values.map(() => 0);
  const exact = values.map((x) => (Math.max(0, x) / total) * width);
  const cells = exact.map(Math.floor);
  const order = exact
    .map((x, i) => ({ i, remainder: x - cells[i] }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let n = width - cells.reduce((a, b) => a + b, 0), i = 0; i < n; i++) cells[order[i].i]++;
  return cells;
}
