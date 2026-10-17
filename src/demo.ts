import { EMPTY_SEARCH, requestsReadAction, type ChatInput, type ChatStep } from './chat.ts';
import {
  AnalysisSchema,
  type Analysis,
  type Analyzer,
  type Identity,
  type Mailbox,
  type Message,
  type Scope,
  type Session,
} from './domain.ts';
export function demoMessages(): Message[] {
  const rows: [
    string,
    string,
    string,
    Analysis['source_type'],
    Analysis['intent'],
    Analysis['priority'],
  ][] = [
    [
      'Sarah Chen',
      'A decision before Thursday',
      'Please approve the revised budget before Thursday. Our team is waiting for your decision.',
      'contact',
      'action_required',
      'high',
    ],
    [
      'North Studio',
      'Invoice 1042 · payment due Friday',
      'Payment of EUR 840 is due Friday. Please arrange the transfer or let us know about any corrections.',
      'service',
      'action_required',
      'high',
    ],
    [
      'Maya Patel',
      'Design review · tomorrow at 10:00',
      'Our design review starts tomorrow at 10:00 CET. Please bring the latest onboarding flow.',
      'contact',
      'time_sensitive',
      'high',
    ],
    [
      'The Pragmatic Engineer',
      'What 100 engineering leaders learned',
      'Interviews with 100 engineering leaders reveal that clear ownership and fast feedback matter more than team size.',
      'subscription',
      'informational',
      'medium',
    ],
    [
      'Alex Morgan',
      'Notes from our conversation',
      'Here are the notes we discussed, with a proposed outline for the project. Let me know which direction you prefer.',
      'contact',
      'action_required',
      'medium',
    ],
    [
      'Payload',
      'The week in orbit',
      'Orbital servicing companies announced two new satellite missions. The first launch is planned for next spring.',
      'subscription',
      'informational',
      'medium',
    ],
    [
      'Cloudbox',
      'Your monthly receipt',
      'Your payment of EUR 12 was received. This receipt is for your records. No payment or response is needed.',
      'service',
      'transactional',
      'low',
    ],
    [
      'Linear',
      'Your weekly workspace recap',
      'Your team completed 12 issues this week. All projects are on track. No action is required.',
      'service',
      'informational',
      'low',
    ],
    [
      'Parcel Post',
      'Your parcel was delivered',
      'Your parcel was delivered to your door today. No further action is needed.',
      'service',
      'transactional',
      'low',
    ],
    [
      'Field Notes',
      'The autumn collection is here',
      'Our new notebooks and desk accessories are now available. Explore the autumn collection in our shop.',
      'subscription',
      'promotional',
      'archive',
    ],
    [
      'Field Notes',
      'Last season, one last look',
      'A look back at last season. This promotional campaign has ended and no response is needed.',
      'subscription',
      'promotional',
      'archive',
    ],
    [
      'Meetup',
      'Photos from the gathering',
      'Photos from last month’s gathering are now available. Thanks for joining us. No action is needed.',
      'service',
      'informational',
      'archive',
    ],
    [
      'The Pragmatic Engineer',
      'Building systems that last',
      'Small teams ship reliable systems with clear ownership, observable failures, and carefully chosen constraints.',
      'subscription',
      'informational',
      'medium',
    ],
    [
      'Studio Dispatch',
      'A few things for your weekend',
      'Independent projects, thoughtful interfaces, and three long reads for the weekend.',
      'subscription',
      'informational',
      'medium',
    ],
  ];
  return rows.map((r, i) => ({
    id: `demo:INBOX:1:${100 + i}`,
    uid: 100 + i,
    validity: '1',
    subject: r[1],
    sender: r[0],
    address: r[0].toLowerCase().replaceAll(' ', '') + '@example.com',
    date: new Date(Date.now() - i * 14_400_000).toISOString(),
    read: false,
    present: true,
    body: r[2],
    complete: true,
    unsubscribe: r[3] === 'subscription' ? 'https://example.com/unsubscribe' : undefined,
    listID: r[3] === 'subscription' ? r[0].toLowerCase() : undefined,
    analysis: AnalysisSchema.parse({
      source_type: r[3],
      intent: r[4],
      priority: r[5],
      kind:
        r[4] === 'action_required'
          ? 'action'
          : r[4] === 'time_sensitive'
            ? 'time_sensitive'
            : r[3] === 'subscription'
              ? 'newsletter'
              : 'general',
      takeaway: r[2],
      reason: ['low', 'archive'].includes(r[5])
        ? 'Routine update with no identified obligation.'
        : 'Contains a request or information worth your attention.',
      action:
        r[4] === 'action_required'
          ? 'Review and respond to ' + r[0]
          : r[4] === 'time_sensitive'
            ? 'Prepare the onboarding flow.'
            : '',
      deadline: i === 0 ? 'Thursday' : i === 1 ? 'Friday' : i === 2 ? 'tomorrow at 10:00 CET' : '',
      context: 'Fictional email for the interactive demo.',
      secondary_actions: [],
      blockers: [],
      topics:
        r[3] === 'subscription' && r[5] === 'medium'
          ? [{ title: r[1], summary: r[2], relevance: 'high' }]
          : [],
      key_facts: [],
      recommended: i === 3 || i === 5,
      recommendation_reason:
        i === 3
          ? 'Lessons from 100 engineering leaders on how to build effective teams.'
          : i === 5
            ? 'Two new orbital servicing missions and what they make possible.'
            : '',
      requires_response: r[3] === 'contact' && r[4] === 'action_required',
      evidence: [r[2]],
      uncertain: false,
    }),
  }));
}
export class DemoMailbox implements Mailbox {
  rows = demoMessages();
  async snapshot(scope: Scope) {
    const all = this.rows
      .filter((m) => scope.mode === 'subscriptions' || !m.read)
      .map((m) => m.uid)
      .sort((a, b) => (scope.order === 'newest' ? b - a : a - b));
    return {
      identity: { account: 'demo', mailbox: 'INBOX', validity: '1' },
      total: all.length,
      unreadUIDs: scope.mode === 'unread' ? [...all] : undefined,
      uids: scope.limit === null ? all : all.slice(0, scope.limit),
    };
  }
  async fetch(uid: number, _identity: Identity) {
    const m = this.rows.find((m) => m.uid === uid);
    if (!m) throw new Error('Message not found.');
    const clone = structuredClone(m);
    clone.analysis = undefined;
    return clone;
  }
  async setRead(
    message: Message,
    read: boolean,
    expected: boolean,
  ): Promise<'changed' | 'skipped'> {
    const m = this.rows.find((m) => m.id === message.id);
    if (!m || m.read !== expected) return 'skipped';
    m.read = read;
    return 'changed';
  }
  async close() {}
}
export class DemoAnalyzer implements Analyzer {
  async chatStep(input: ChatInput, signal: AbortSignal): Promise<ChatStep> {
    signal.throwIfAborted();
    const context = JSON.parse(input.context);
    const evidence = context.evidence.at(-1);
    const previous = [...context.history].reverse().find((e: any) => e.role === 'assistant');
    const base = { search: { ...EMPTY_SEARCH }, sources: [], text: '' };
    if (requestsReadAction(context.question) && previous?.sources.length)
      return { ...base, action: 'mark_read', plan: null, sources: previous.sources };
    if (!evidence) {
      if (previous?.sources.length && /second|explain|original|more/i.test(context.question))
        return {
          ...base,
          action: 'read',
          plan: null,
          sources: [
            previous.sources[/second/i.test(context.question) ? 1 : 0] ?? previous.sources[0],
          ],
        };
      return {
        ...base,
        action: 'search',
        plan: null,
        search: {
          ...EMPTY_SEARCH,
          terms: /school|kids/i.test(context.question)
            ? ['school']
            : /pay|invoice|money/i.test(context.question)
              ? ['invoice', 'payment']
              : [],
        },
      };
    }
    const rows = evidence.results ?? [];
    return {
      ...base,
      action: 'answer',
      plan: null,
      sources: rows.slice(0, 3).map((r: any) => r.ref),
      text: rows.length
        ? rows
            .slice(0, 3)
            .map((r: any) => `[${r.ref}] ${r.summary || r.text || r.subject}`)
            .join('\n\n')
        : 'No matches among the analyzed emails available here. This demo uses fictional mail.',
    };
  }

  async analyze(m: Message, signal: AbortSignal) {
    await Bun.sleep(40);
    signal.throwIfAborted();
    return structuredClone(demoMessages().find((row) => row.id === m.id)!.analysis!);
  }
}
export function demoSession(): Session {
  const messages = demoMessages();
  return {
    version: 1,
    identity: { account: 'demo', mailbox: 'INBOX', validity: '1' },
    scope: { mode: 'unread', limit: null, order: 'oldest' },
    uids: messages.map((m) => m.uid),
    total: messages.length,
    messages,
    errors: {},
    created: new Date().toISOString(),
    provider: 'demo',
    model: 'fictional',
    state: 'complete',
    receipts: [],
  };
}
