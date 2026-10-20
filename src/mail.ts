import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { accountID, type Config } from './config.ts';
import {
  clean,
  oneLine,
  safeURL,
  type Identity,
  type Mailbox,
  type Message,
  type Scope,
  type ReadResult,
} from './domain.ts';
const SOURCE_LIMIT = 2 * 1024 * 1024;
export class MessageUnavailable extends Error {}
export async function parseMessage(
  raw: Buffer,
  base: Omit<Message, 'body' | 'complete'>,
  complete = true,
): Promise<Message> {
  const parsed = await simpleParser(raw, {
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const sender = parsed.from?.value[0];
  let body = clean(parsed.text || '').trim();
  // multipart/alternative may advertise a plain part which is actually empty.
  // Mailparser then suppresses HTML-to-text conversion. Reuse its converter on
  // that HTML alone; never replace a readable plain part or load remote content.
  if (!body && typeof parsed.html === 'string' && parsed.html.trim()) {
    const fallback = await simpleParser(
      Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n' + parsed.html),
      { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true },
    );
    body = clean(fallback.text || '').trim();
  }
  const header = parsed.headerLines
    .filter((h) => h.key === 'list-unsubscribe')
    .map((h) => h.line.replace(/^list-unsubscribe:\s*/i, ''))
    .join(' ');
  const rawLink =
    typeof header === 'string' ? header.match(/<(https:\/\/[^>]+)>/i)?.[1] : undefined;
  const list = parsed.headerLines
    .find((h) => h.key === 'list-id')
    ?.line.replace(/^list-id:\s*/i, '');
  return {
    ...base,
    subject: oneLine(parsed.subject || base.subject),
    sender: oneLine(sender?.name || base.sender),
    address: oneLine(sender?.address || base.address),
    body: body.slice(0, 60000),
    complete: complete && body.length <= 60000 && body.length > 0,
    unsubscribe: safeURL(rawLink),
    listID: list ? oneLine(list.match(/<([^>]+)>/)?.[1] || list) : undefined,
  };
}
export class IMAPMailbox implements Mailbox {
  private client?: ImapFlow;
  private connecting?: Promise<ImapFlow>;
  constructor(
    private config: Config,
    private createClient = (options: ConstructorParameters<typeof ImapFlow>[0]) =>
      new ImapFlow(options),
  ) {}
  private async connected() {
    if (this.connecting) return this.connecting;
    if (this.client?.usable) return this.client;
    this.client?.close();
    const client = this.createClient({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.address, pass: this.config.password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 60000,
      tls: { rejectUnauthorized: true },
    });
    client.on('error', () => {});
    this.client = client;
    this.connecting = client.connect().then(() => client);
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  private identity(client: ImapFlow): Identity {
    if (!client.mailbox) throw new Error('No selected mailbox.');
    return {
      account: accountID(this.config),
      mailbox: this.config.mailbox,
      validity: String(client.mailbox.uidValidity),
    };
  }
  abortConnection() {
    this.client?.close();
  }
  async testConnection() {
    const client = await this.connected();
    const lock = await client.getMailboxLock(this.config.mailbox, { readOnly: true });
    try {
      this.identity(client);
    } finally {
      lock.release();
    }
  }
  private check(client: ImapFlow, identity: Identity) {
    const actual = this.identity(client);
    if (
      actual.account !== identity.account ||
      actual.mailbox !== identity.mailbox ||
      actual.validity !== identity.validity
    )
      throw new Error('Mailbox identity changed. Start a fresh review; no change was applied.');
  }
  async snapshot(scope: Scope) {
    const client = await this.connected();
    const lock = await client.getMailboxLock(this.config.mailbox, { readOnly: true });
    try {
      const found = await client.search(scope.mode === 'unread' ? { seen: false } : { all: true }, {
        uid: true,
      });
      if (!Array.isArray(found)) throw new Error('The server did not return a valid UID list.');
      const sorted = found.sort((a, b) => (scope.order === 'newest' ? b - a : a - b));
      return {
        identity: this.identity(client),
        total: sorted.length,
        unreadUIDs: scope.mode === 'unread' ? [...sorted] : undefined,
        uids: scope.limit === null ? sorted : sorted.slice(0, scope.limit),
      };
    } finally {
      lock.release();
    }
  }
  async fetch(uid: number, identity: Identity): Promise<Message> {
    const client = await this.connected();
    const lock = await client.getMailboxLock(this.config.mailbox, { readOnly: true });
    try {
      this.check(client, identity);
      const row = await client.fetchOne(
        String(uid),
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
          source: { maxLength: SOURCE_LIMIT },
        },
        { uid: true },
      );
      if (!row || row.uid !== uid || !row.source)
        throw new MessageUnavailable('Email is no longer available in INBOX.');
      const from = row.envelope?.from?.[0];
      const base = {
        id: `${identity.account}:${identity.mailbox}:${identity.validity}:${uid}`,
        uid,
        validity: identity.validity,
        subject: row.envelope?.subject || '(No subject)',
        sender: from?.name || from?.address || 'Unknown sender',
        address: from?.address || '',
        date: row.internalDate
          ? new Date(row.internalDate).toISOString()
          : row.envelope?.date
            ? new Date(row.envelope.date).toISOString()
            : '',
        read: row.flags?.has('\\Seen') ?? false,
        present: true,
      };
      return await parseMessage(row.source, base, (row.size ?? SOURCE_LIMIT + 1) <= SOURCE_LIMIT);
    } finally {
      lock.release();
    }
  }
  async setRead(
    message: Message,
    read: boolean,
    expected: boolean,
  ): Promise<'changed' | 'skipped'> {
    const client = await this.connected();
    const lock = await client.getMailboxLock(this.config.mailbox, { readOnly: false });
    try {
      this.check(client, {
        account: message.id.split(':')[0],
        mailbox: this.config.mailbox,
        validity: message.validity,
      });
      const before = await client.fetchOne(
        String(message.uid),
        { uid: true, flags: true },
        { uid: true },
      );
      if (
        !before ||
        before.uid !== message.uid ||
        !before.flags ||
        before.flags.has('\\Seen') !== expected
      )
        return 'skipped';
      if (read === expected) return 'skipped';
      const ok = read
        ? await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true })
        : await client.messageFlagsRemove(String(message.uid), ['\\Seen'], { uid: true });
      if (!ok) throw new Error('The server rejected the read-state change.');
      const after = await client.fetchOne(
        String(message.uid),
        { uid: true, flags: true },
        { uid: true },
      );
      if (!after || after.uid !== message.uid || !after.flags || after.flags.has('\\Seen') !== read)
        throw new Error('The server outcome could not be verified. Refresh before retrying.');
      return 'changed';
    } finally {
      lock.release();
    }
  }
  async setReadMany(
    messages: Message[],
    read: boolean,
    expected: boolean,
  ): Promise<Map<string, ReadResult>> {
    const results = new Map<string, ReadResult>(messages.map((m) => [m.id, 'skipped']));
    if (!messages.length || read === expected) return results;
    const client = await this.connected();
    const lock = await client.getMailboxLock(this.config.mailbox, { readOnly: false });
    try {
      // Validate every identity before sending any mutation. Explicit UID lists
      // must never include unselected emails between two selected UIDs.
      for (const m of messages)
        this.check(client, {
          account: m.id.split(':')[0],
          mailbox: this.config.mailbox,
          validity: m.validity,
        });
      const uids = [...new Set(messages.map((m) => m.uid))].join(',');
      const before = new Map(
        (await client.fetchAll(uids, { uid: true, flags: true }, { uid: true })).map((m) => [
          m.uid,
          m.flags,
        ]),
      );
      const eligible = messages.filter((m) => before.get(m.uid)?.has('\\Seen') === expected);
      if (!eligible.length) return results;
      const target = [...new Set(eligible.map((m) => m.uid))].join(',');
      for (const m of eligible) results.set(m.id, 'unknown');
      try {
        const ok = read
          ? await client.messageFlagsAdd(target, ['\\Seen'], { uid: true })
          : await client.messageFlagsRemove(target, ['\\Seen'], { uid: true });
        if (!ok) return results;
        const after = new Map(
          (await client.fetchAll(target, { uid: true, flags: true }, { uid: true })).map((m) => [
            m.uid,
            m.flags,
          ]),
        );
        for (const m of eligible)
          if (after.get(m.uid)?.has('\\Seen') === read) results.set(m.id, 'changed');
      } catch {
        // A disconnected or partially applied STORE must never be replayed.
        // Preserve skipped rows; attempted rows remain unconfirmed.
      }
      return results;
    } finally {
      lock.release();
    }
  }
  async close() {
    const c = this.client;
    this.client = undefined;
    if (c?.usable) await c.logout().catch(() => c.close());
    else c?.close();
  }
}
