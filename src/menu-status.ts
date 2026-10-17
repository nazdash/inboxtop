import { z } from 'zod';
import type { Controller } from './controller.ts';
import { inboxStats } from './inbox-stats.ts';
import { newsletterGroups } from './decisions.ts';

export const MENU_PROTOCOL = 1;
export const MenuCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.enum(['sync', 'stop', 'hide']) }).strict(),
  z.object({ command: z.literal('mode'), value: z.enum(['adhoc', 'live']) }).strict(),
]);
/** Content-free projection. Never include status strings, subjects, bodies, or credentials. */
export function menuStatus(c: Controller, revision: number, pending = false) {
  const stats = inboxStats(c);
  const locked = pending || c.mutating;
  const providerProblems = {
    credentials: ['AI credentials rejected', 'Check your API key and access.'],
    limit: ['AI usage limit reached', 'Check provider quota or try later.'],
    model: ['AI model unavailable', 'Check the selected model in Settings.'],
    connection: ['Cannot reach AI provider', 'Check connection or local AI service.'],
    service: ['AI provider unavailable', 'Check provider status, then retry.'],
  } as const;
  const provider = c.providerFailure && providerProblems[c.providerFailure];
  const blockingIssue = c.syncError
    ? {
        title: 'Inbox sync failed',
        detail: 'Check connection and mail settings.',
        destination: 'settings',
      }
    : provider
      ? { title: provider[0], detail: provider[1], destination: 'settings' }
      : null;
  return {
    protocol: MENU_PROTOCOL,
    revision,
    enabled: c.saved.settings?.menuBarEnabled ?? false,
    mode: c.mode,
    unread: stats.total,
    ready: stats.ready,
    unanalyzed: stats.unanalyzed,
    groups: stats.outcomes,
    subscriptions: newsletterGroups(c.pool).length,
    lastSync: c.saved.inbox?.at ?? null,
    progress: c.busy ? { done: c.progress.resolved, total: c.progress.total } : null,
    activity: pending
      ? 'Updating…'
      : c.mutating
        ? 'Updating emails…'
        : c.syncing || c.snapshotting
          ? 'Syncing inbox…'
          : c.busy
            ? 'Analyzing…'
            : c.summaryBusy
              ? 'Preparing summary…'
              : null,
    // Keep the legacy field content-free; only app-level failures belong here.
    issue: blockingIssue
      ? c.syncError
        ? 'Sync failed · check mail settings'
        : blockingIssue.title
      : null,
    blockingIssue,
    commands: {
      mode: !locked && !c.syncing && !c.snapshotting,
      sync: !locked && !c.syncing && !c.snapshotting,
      stop: !locked && (c.busy || c.mode === 'live' || c.summaryBusy),
    },
  };
}
export type MenuStatus = ReturnType<typeof menuStatus>;
