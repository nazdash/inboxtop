import { ImapFlow, type SearchObject, type MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { accountID, type Config } from './config.ts';
import { clean, oneLine, type Identity, type Message } from './domain.ts';
import { type ChatSearch } from './chat-retrieval.ts';
import { validateWindow, ChatMailboxError, type Usage } from './chat-policy.ts';

export type Reserve = (cost: Partial<Usage>) => Promise<void>;
export interface RemotePage {
  messages: Message[];
  nextOffset: number | null;
  complete: boolean;
  countQuality: 'exact' | 'lower-bound';
  matched: number;
  at: string;
  scope: ChatSearch;
  omissions: string[];
}
export interface ChatMailbox {
  search(query: ChatSearch, signal: AbortSignal, reserve: Reserve): Promise<RemotePage>;
  read(message: Message, signal: AbortSignal, reserve: Reserve): Promise<Message>;
  close(): void;
  snapshot?(): ChatMailboxState;
}
export interface ChatMailboxState {
  cursors: [number, Cursor][];
  nextCursor: number;
  pages: Record<string, RemotePage>;
}
interface Cursor {
  key: string;
  identity: Identity;
  high: number;
  pending: number[];
  matched: number;
}
/** Dedicated read-only connection. Never uses snapshot(), STORE or unrestricted SEARCH. */
export class IMAPChatMailbox implements ChatMailbox {
  private client?: ImapFlow;
  private cursors = new Map<number, Cursor>();
  private nextCursor = 1;
  private failed?: Error;
  private commandCode?: string;
  private recordCommandError = (entry: {
    err?: { serverResponseCode?: string; code?: string };
  }) => {
    const code = entry?.err?.serverResponseCode ?? entry?.err?.code;
    // Keep only known protocol/error codes, never raw commands, server prose or credentials.
    if (
      code &&
      [
        'SERVERBUG',
        'CLIENTBUG',
        'PARSE',
        'CANNOT',
        'BADCHARSET',
        'LIMIT',
        'AUTHENTICATIONFAILED',
        'InvalidSearchQuery',
        'InvalidSequenceSet',
        'ECONNRESET',
        'ETIMEDOUT',
      ].includes(code)
    )
      this.commandCode = code;
  };
  private pages: Record<string, RemotePage> = {};
  private metadataReserved = 0;
  private metadata(bytes: number) {
    if (this.metadataReserved + bytes > 1024 * 1024)
      throw new Error('Mailbox metadata limit reached. Coverage is partial.');
    this.metadataReserved += bytes;
  }
  constructor(
    private config: Config,
    private create = (options: ConstructorParameters<typeof ImapFlow>[0]) => new ImapFlow(options),
    state?: ChatMailboxState,
  ) {
    if (state) {
      this.cursors = new Map(state.cursors);
      this.nextCursor = state.nextCursor;
      this.pages = structuredClone(state.pages);
    }
  }
  snapshot(): ChatMailboxState {
    return {
      cursors: [...this.cursors],
      nextCursor: this.nextCursor,
      pages: structuredClone(this.pages),
    };
  }
  close() {
    this.client?.close();
    this.client = undefined;
  }
  private async operation<T>(signal: AbortSignal, work: (c: ImapFlow) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.failed) throw this.failed;
    const abort = () => this.close();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    bounded.addEventListener('abort', abort, { once: true });
    try {
      if (!this.client) {
        this.client = this.create({
          host: this.config.host,
          port: this.config.port,
          secure: true,
          auth: { user: this.config.address, pass: this.config.password },
          logger: {
            trace() {},
            debug() {},
            info() {},
            fatal: this.recordCommandError,
            warn: this.recordCommandError,
            error: this.recordCommandError,
          },
          disableAutoIdle: true,
          disableCompression: true,
          disableBinary: true,
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 15000,
          maxLineLength: 8192,
          maxLiteralSize: 262144,
          maxResponseSize: 524288,
          tls: { rejectUnauthorized: true },
        });
        this.client.on('error', () => {});
        await this.client.connect();
      }
      const client = this.client;
      const lock = await client.getMailboxLock(this.config.mailbox, { readOnly: true });
      try {
        bounded.throwIfAborted();
        return await work(client);
      } finally {
        lock.release();
      }
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error('Mailbox operation failed.');
      this.close();
      if (bounded.aborted)
        throw new Error(
          signal.aborted
            ? 'Mailbox search stopped.'
            : 'Mailbox request timed out. Coverage is incomplete.',
        );
      throw error;
    } finally {
      bounded.removeEventListener('abort', abort);
    }
  }
  private identity(c: ImapFlow): Identity {
    if (!c.mailbox) throw new Error('No selected mailbox.');
    return {
      account: accountID(this.config),
      mailbox: this.config.mailbox,
      validity: String(c.mailbox.uidValidity),
    };
  }
  private check(c: ImapFlow, expected: Identity) {
    if (JSON.stringify(this.identity(c)) !== JSON.stringify(expected))
      throw new Error(
        'Mailbox identity changed. Cached sources remain available; start a new search.',
      );
  }
  async search(q: ChatSearch, signal: AbortSignal, reserve: Reserve): Promise<RemotePage> {
    validateWindow(q.after, q.before);
    if (q.category !== 'all' || !['all', 'newsletter'].includes(q.kind))
      throw new Error('Connected mail has no AI categories. Use dates, sender or literal terms.');
    const pageKey = JSON.stringify(q);
    if (this.pages[pageKey]) return structuredClone(this.pages[pageKey]);
    const key = JSON.stringify({ ...q, offset: 0 });
    const previous = q.offset ? this.cursors.get(q.offset) : undefined;
    if (q.offset && (!previous || previous.key !== key))
      throw new Error('Use the returned nextOffset with unchanged search filters.');
    return this.operation(signal, async (c) => {
      const identity = this.identity(c);
      if (previous) this.check(c, previous.identity);
      const cursor: Cursor = previous
        ? structuredClone(previous)
        : {
            key,
            identity,
            high: c.mailbox ? Math.max(0, Number(c.mailbox.uidNext) - 1) : 0,
            pending: [],
            matched: 0,
          };
      if (!Number.isSafeInteger(cursor.high)) throw new Error('Invalid mailbox UID boundary.');
      if (!cursor.pending.length && cursor.high > 0) {
        const low = Math.max(1, cursor.high - 499);
        const terms = q.terms.map((t) => t.trim()).filter(Boolean);
        const query: SearchObject = {
          uid: `${low}:${cursor.high}`,
          since: q.after,
          before: new Date(Date.parse(q.before) + 86400000).toISOString().slice(0, 10),
          ...(q.sender ? { from: q.sender } : {}),
          ...(q.state !== 'all' ? { seen: q.state === 'read' } : {}),
          // Gmail rejects HEADER LIST-ID "" with SERVERBUG. Match the non-empty
          // list identifier marker instead, keeping the same bounded date/UID scope.
          ...(q.kind === 'newsletter' ? { header: { 'List-ID': '<' } } : {}),
          ...(terms.length === 1
            ? { text: terms[0] }
            : terms.length
              ? { or: terms.map((text) => ({ text })) }
              : {}),
        };
        this.metadata(8192);
        await reserve({ searches: 1 });
        this.commandCode = undefined;
        let result: number[] | false | undefined;
        try {
          result = await c.search(query, { uid: true });
        } catch (error) {
          this.recordCommandError({ err: error as { code?: string; serverResponseCode?: string } });
          throw new ChatMailboxError(
            `Mailbox search failed${this.commandCode ? ` (IMAP ${this.commandCode})` : ''}. No search results were available. Retry explicitly; this does not mean no emails matched.`,
          );
        }
        // ImapFlow can report a command failure as false after logging its error.
        // An empty successful result is [], never false or undefined.
        if (result === false || result === undefined)
          throw new ChatMailboxError(
            `Mailbox search failed${this.commandCode ? ` (IMAP ${this.commandCode})` : ''}. No search results were available. Retry explicitly; this does not mean no emails matched.`,
          );
        if (
          !Array.isArray(result) ||
          result.length > 500 ||
          result.some((uid) => !Number.isSafeInteger(uid) || uid < low || uid > cursor.high)
        )
          throw new ChatMailboxError(
            'Mailbox returned an invalid bounded search result. No email was fetched.',
          );
        cursor.pending = [...new Set(result)].sort((a, b) => b - a);
        cursor.matched += cursor.pending.length;
        cursor.high = low - 1;
      }
      const uids = cursor.pending.splice(0, Math.min(20, q.limit));
      const messages: Message[] = [];
      if (uids.length) {
        this.metadata(uids.length * 8192);
        await reserve({ headers: uids.length });
        // Each response has a hard parser cap; the page is at most 20 envelopes.
        const rows = await c.fetchAll(
          uids.join(','),
          { uid: true, envelope: true, flags: true, internalDate: true },
          { uid: true },
        );
        if (rows.length > uids.length)
          throw new Error('Mailbox metadata response exceeded its limit.');
        // FETCH includes native BigInt MODSEQ values with CONDSTORE, even when
        // not requested. Preserve their digits for size accounting; Set-backed
        // flags/labels must count too. Raw rows never enter saved Chat state.
        const metadataJSON = JSON.stringify(rows, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value instanceof Set ? [...value] : value,
        );
        if (Buffer.byteLength(metadataJSON) > 1024 * 1024)
          throw new Error('Mailbox metadata response exceeded its limit.');
        for (const row of rows) {
          if (!uids.includes(row.uid)) throw new Error('Mailbox returned an unrequested UID.');
          const from = row.envelope?.from?.[0];
          const date = row.internalDate || row.envelope?.date;
          messages.push({
            id: `${identity.account}:${identity.mailbox}:${identity.validity}:${row.uid}`,
            uid: row.uid,
            validity: identity.validity,
            subject: oneLine(row.envelope?.subject || '(No subject)').slice(0, 2000),
            sender: oneLine(from?.name || from?.address || 'Unknown sender').slice(0, 500),
            address: oneLine(from?.address || '').slice(0, 500),
            date: date ? new Date(date).toISOString() : '',
            read: row.flags?.has('\\Seen') ?? false,
            present: true,
            body: '',
            complete: false,
          });
        }
      }
      const complete = cursor.high === 0 && !cursor.pending.length;
      const nextOffset = complete ? null : this.nextCursor++;
      if (nextOffset) this.cursors.set(nextOffset, cursor);
      const page: RemotePage = {
        messages,
        nextOffset,
        complete,
        matched: cursor.matched,
        countQuality: complete ? 'exact' : 'lower-bound',
        at: new Date().toISOString(),
        scope: q,
        omissions: [
          'Attachments and linked pages excluded.',
          ...(complete
            ? []
            : [
                'Only bounded UID windows searched; older or imported mail may be outside inspected windows.',
              ]),
          ...(q.kind === 'newsletter'
            ? [
                'Likely subscriptions with a List-ID identifier marker only; senders without this header are not included.',
              ]
            : []),
        ],
      };
      this.pages[pageKey] = page;
      return structuredClone(page);
    });
  }
  async read(m: Message, signal: AbortSignal, reserve: Reserve): Promise<Message> {
    if (m.body) return m;
    return this.operation(signal, async (c) => {
      const identity = {
        account: accountID(this.config),
        mailbox: this.config.mailbox,
        validity: m.validity,
      };
      this.check(c, identity);
      if (m.id !== `${identity.account}:${identity.mailbox}:${identity.validity}:${m.uid}`)
        throw new Error('Source belongs to another mailbox.');
      this.metadata(8192);
      const row = await c.fetchOne(
        String(m.uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      if (!row || row.uid !== m.uid || !row.bodyStructure)
        throw new Error('Original is no longer available.');
      const parts = (node: MessageStructureObject): MessageStructureObject[] => {
        if (
          node.disposition?.toLowerCase() === 'attachment' ||
          node.parameters?.name ||
          node.dispositionParameters?.filename ||
          node.type.toLowerCase() === 'message/rfc822'
        )
          return [];
        return (
          node.childNodes?.flatMap(parts) ?? (/^text\/(plain|html)$/i.test(node.type) ? [node] : [])
        );
      };
      const choices = parts(row.bodyStructure);
      const part = choices.find((p) => p.type.toLowerCase() === 'text/plain') ?? choices[0];
      if (!part) throw new Error('No readable text part. Attachments are not retrieved.');
      const bytes = Math.min(262144, Math.max(1, part.size ?? 262144));
      await reserve({ bodies: 1, bytes });
      const key = part.part || 'TEXT';
      const body = await c.fetchOne(
        String(m.uid),
        { uid: true, bodyParts: [{ key, start: 0, maxLength: bytes }] },
        { uid: true },
      );
      const raw = body && body.uid === m.uid && body.bodyParts?.get(key.toLowerCase());
      if (!raw || raw.length > bytes)
        throw new Error('Original text unavailable or exceeded its byte limit.');
      // Parse only the chosen text MIME part. Never download embedded files.
      const charset = (part.parameters?.charset || 'utf-8').replace(/[^a-zA-Z0-9_-]/g, '');
      const encoding = (part.encoding || '7bit').replace(/[^a-zA-Z0-9-]/g, '');
      const parsed = await simpleParser(
        Buffer.concat([
          Buffer.from(
            `Content-Type: ${part.type}; charset=${charset}\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`,
          ),
          raw,
        ]),
        { skipTextToHtml: true, skipImageLinks: true },
      );
      const text = clean(parsed.text || '').trim();
      return {
        ...m,
        body: text.slice(0, 60000),
        complete:
          choices.length === 1 &&
          part.size !== undefined &&
          part.size <= bytes &&
          text.length > 0 &&
          text.length <= 60000,
      };
    });
  }
}
