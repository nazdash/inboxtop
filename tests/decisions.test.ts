import { test, expect } from 'bun:test';
import {
  decisionQueues,
  outcomeOf,
  dashboardSummary,
  newsletterGroups,
  newsletterVerdict,
} from '../src/decisions.ts';
import { demoMessages } from '../src/demo.ts';

test('four outcomes partition unread mail; ambiguous obligations stay protected and kept mail stays out of cleanup', () => {
  const rows = demoMessages();
  const extra = [
    { ...rows[0], id: 'uncertain-action', analysis: { ...rows[0].analysis!, uncertain: true } },
    { ...rows[6], id: 'kept-low', kept: true },
    {
      ...rows[6],
      id: 'excerpt',
      analysis: {
        ...rows[6].analysis!,
        coverage: { stage: 'triage' as const, characters: 20, total: 100 },
      },
    },
    { ...rows[0], id: 'read', read: true },
    { ...rows[0], id: 'gone', present: false },
  ];
  const q = decisionQueues([...rows, ...extra]);
  const ids = Object.values(q)
    .flat()
    .map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBe(rows.length + 3);
  expect(q.act.map((m) => m.id)).toContain('uncertain-action');
  expect(q.check.map((m) => m.id)).toContain('excerpt');
  expect(q.read.map((m) => m.id)).toContain('kept-low');
  expect(outcomeOf(rows[0])).toBe('act');
  expect(outcomeOf(rows[3])).toBe('read');
  expect(outcomeOf(rows[6])).toBe('clear');
  expect(dashboardSummary(rows)).toContain('Sarah Chen');
  expect(dashboardSummary(rows)).toContain('budget');
});
test('newsletter digest combines issues by sender identity and keeps full-read advice linked to each issue', () => {
  const base = demoMessages()[3];
  const first = {
    ...base,
    id: 'one',
    address: 'NEWS@example.com',
    analysis: {
      ...base.analysis!,
      takeaway: 'Issue one explains database indexes.',
      recommendation_reason: 'Useful practical indexing guidance.',
    },
  };
  const second = {
    ...base,
    id: 'two',
    address: 'news@example.com',
    analysis: { ...base.analysis!, takeaway: 'Issue two explains deployment safety.' },
  };
  const other = { ...base, id: 'other', address: 'different@example.com' };
  const direct = { ...demoMessages()[0], sender: base.sender, address: first.address };
  const groups = newsletterGroups([
    first,
    second,
    other,
    direct,
    { ...first, id: 'read', read: true },
  ]);
  expect(groups).toHaveLength(2);
  const combined = groups.find((g) => g.id === 'news@example.com')!;
  expect(combined.messages.map((m) => m.id).sort()).toEqual(['one', 'two']);
  expect(combined.summary).toContain('database indexes');
  expect(combined.summary).toContain('deployment safety');
  expect(combined.recommendation).toContain('2 issues worth reading in full');
  expect(newsletterVerdict(first)).toEqual({
    label: 'Read in full',
    reason: 'Useful practical indexing guidance.',
  });
  expect(newsletterVerdict({ ...first, analysis: undefined }).label).toBe('Check manually');
});

test('newsletter sorting uses latest receipt, issue count or name with stable sender identity', () => {
  const base = demoMessages()[3];
  const rows = [
    { ...base, id: 'a', sender: 'Zulu', address: 'z@example.com', date: '2026-01-03T10:00:00Z' },
    { ...base, id: 'b', sender: 'Alpha', address: 'a@example.com', date: '2026-01-01T10:00:00Z' },
    { ...base, id: 'c', sender: 'Alpha', address: 'a@example.com', date: '2026-01-02T10:00:00Z' },
    { ...base, id: 'read', sender: 'Read sender', address: 'read@example.com', read: true },
  ];
  expect(newsletterGroups(rows).map((g) => g.name)).toEqual(['Zulu', 'Alpha']);
  expect(newsletterGroups(rows, 'all', 'issues').map((g) => g.name)).toEqual(['Alpha', 'Zulu']);
  expect(newsletterGroups(rows, 'all', 'name').map((g) => g.name)).toEqual(['Alpha', 'Zulu']);
  expect(newsletterGroups(rows, 'all', 'issues')[0].messages.map((m) => m.id)).toEqual(['c', 'b']);
});

test('subscription scopes include only completed analysis, with retained read issues only in All analyzed', () => {
  const base = demoMessages()[3];
  const rows = [
    { ...base, id: 'unread' },
    { ...base, id: 'read', read: true },
    { ...base, id: 'retained', read: true, present: false },
    {
      ...base,
      id: 'pending',
      analysis: undefined,
      classification: undefined,
      listID: 'list.example',
    },
    { ...base, id: 'failed', error: 'Failed' },
    {
      ...base,
      id: 'triage',
      analysis: {
        ...base.analysis!,
        coverage: { stage: 'triage' as const, characters: 10, total: 100 },
      },
    },
    { ...demoMessages()[0], id: 'direct' },
  ];
  expect(newsletterGroups(rows)[0].messages.map((m) => m.id)).toEqual(['unread']);
  expect(
    newsletterGroups(rows, 'all', 'latest', 'all')[0]
      .messages.map((m) => m.id)
      .sort(),
  ).toEqual(['read', 'retained', 'unread']);
  expect(newsletterGroups(rows.filter((m) => m.read))).toEqual([]);
});
