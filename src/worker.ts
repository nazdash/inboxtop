import { type ChatRunRequest, type ChatRunState } from './chat-runner.ts';
import { ChatSaveSchema, type ChatState, type ChatInput } from './chat.ts';
import { createServer, request, type Server } from 'node:http';
import { mkdir, chmod, unlink, lstat, writeFile, readFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Controller } from './controller.ts';
import { MemoryStore } from './store.ts';
import { SettingsSchema, applySettings } from './settings.ts';
import { accountID, configErrors, loadConfig, type Config } from './config.ts';
import { loadProfile } from './credentials.ts';
import { runtimeCommand, compiled } from './runtime.ts';
import { clean, type Saved, type Scope } from './domain.ts';
import { menuStatus, MenuCommandSchema } from './menu-status.ts';
const WORKER_PROTOCOL = 29;

export function workerSocket(config: Config) {
  const key = createHash('sha256')
    .update(config.dataDir + ':' + accountID(config))
    .digest('hex')
    .slice(0, 20);
  return `/tmp/inboxtop-${process.getuid?.() ?? 'user'}-${key}/worker.sock`;
}
export async function privateSocketDirectory(socket: string) {
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  const stat = await lstat(dirname(socket));
  if (!stat.isDirectory() || stat.uid !== process.getuid?.())
    throw new Error('Unsafe worker socket directory.');
  await chmod(dirname(socket), 0o700);
}
export function workerRequest(
  socket: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMS = 15000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        signal,
        path,
        agent: false,
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            if ((res.statusCode ?? 500) >= 400)
              reject(new Error(JSON.parse(data).error ?? 'Worker command failed.'));
            else resolve(data ? JSON.parse(data) : undefined);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(timeoutMS, () => req.destroy(new Error('Background worker is not responding.')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const scopeSchema = z
  .object({
    mode: z.enum(['unread', 'subscriptions']),
    limit: z.number().int().positive().nullable(),
    order: z.enum(['oldest', 'newest']),
  })
  .strict();
const idSchema = z.string().min(1).max(1000);
const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('start'), value: scopeSchema }).strict(),
  z.object({ command: z.literal('mode'), value: z.enum(['adhoc', 'live']) }).strict(),
  z.object({ command: z.literal('settings'), value: SettingsSchema }).strict(),
  z
    .object({ command: z.enum(['apply', 'newsletter']), value: z.array(idSchema).max(100000) })
    .strict(),
  z.object({ command: z.enum(['review', 'undo', 'prioritize']), value: idSchema }).strict(),
  z
    .object({
      command: z.enum([
        'resume',
        'pause',
        'togglePause',
        'stop',
        'retry',
        'sync',
        'refresh',
        'summary',
      ]),
    })
    .strict(),
]);
export async function serveWorker(c: Controller, socket: string): Promise<Server> {
  await privateSocketDirectory(socket);
  // Caller owns the encrypted store's exclusive lock before stale socket removal.
  await unlink(socket).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  let revision = 1;
  let menuPending = false;
  const changed = () => revision++;
  c.on('change', changed);
  const state = () => ({
    revision,
    saved: { ...c.saved, cache: {}, classifications: {} },
    status: c.status,
    busy: c.busy,
    snapshotting: c.snapshotting,
    syncing: c.syncing,
    mutating: c.mutating,
    monitoring: c.monitoring,
    summaryBusy: c.summaryBusy,
    newsletterProgress: c.newsletterProgress,
    reviewJobs: c.reviewJobs,
    summaryError: c.summaryError,
    reused: c.reused,
    classifiedReused: c.classifiedReused,
    stages: [...c.stages],
    writeProgress: c.writeProgress,
    pendingReads: c.pendingReads,
    provider: c.provider,
    model: c.model,
  });
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET' && req.url === '/ping') {
        res.end(
          JSON.stringify({
            ok: true,
            protocol: WORKER_PROTOCOL,
            profileRevision: c.config?.profileRevision,
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/state')) {
        const since = new URL(req.url, 'http://localhost').searchParams.get('since');
        if (since === String(revision)) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.end(JSON.stringify(state()));
        return;
      }
      if (req.method === 'GET' && req.url === '/menu/status') {
        res.end(JSON.stringify(menuStatus(c, revision, menuPending)));
        return;
      }
      if (req.method === 'POST' && req.url === '/menu/command') {
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 1000) throw new Error('Menu command too large.');
        }
        const cmd = MenuCommandSchema.parse(JSON.parse(body));
        if (menuPending) throw new Error('A menu command is still running.');
        if (cmd.command !== 'hide' && !menuStatus(c, revision).commands[cmd.command])
          throw new Error('This command is not available right now.');
        menuPending = true;
        c.changed();
        try {
          if (cmd.command === 'mode') await c.setMode(cmd.value);
          else if (cmd.command === 'sync') await c.syncInbox();
          else if (cmd.command === 'stop') await c.stop();
          else await c.setMenuBarEnabled(false);
          res.end(JSON.stringify({ ok: true }));
        } finally {
          menuPending = false;
          c.changed();
        }
        return;
      }
      if (req.method === 'GET' && req.url === '/chat/current') {
        res.end(JSON.stringify({ chat: await c.loadChat() }));
        return;
      }
      if (req.method === 'POST' && req.url === '/chat/draft') {
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 32000) throw new Error('Draft too large.');
        }
        const input = z
          .object({
            scope: z.string().max(1000),
            expected: z.string().max(2000),
            draft: z.string().max(2000),
            cursor: z.number().int().min(0).max(2000),
            scrollTop: z.number().min(0).max(10000000),
          })
          .strict()
          .parse(JSON.parse(body));
        res.end(
          JSON.stringify(
            await c.saveChatDraft(
              input.scope,
              input.expected,
              input.draft,
              input.cursor,
              input.scrollTop,
            ),
          ),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/chat/save') {
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 4000000) throw new Error('Chat save too large.');
        }
        const input = ChatSaveSchema.parse(JSON.parse(body));
        const revision = await c.saveChat(input.scope, input.revision, input.state);
        res.end(JSON.stringify({ revision }));
        return;
      }
      if (req.method === 'GET' && req.url === '/chat/run') {
        res.end(JSON.stringify(await c.chatRunState()));
        return;
      }
      if (req.method === 'POST' && ['/chat/start', '/chat/cancel'].includes(req.url ?? '')) {
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 16000) throw new Error('Chat command too large.');
        }
        if (req.url === '/chat/cancel') {
          const input = z.object({ turnID: z.string().uuid() }).strict().parse(JSON.parse(body));
          await c.cancelChat(input.turnID);
          res.end('{}');
        } else {
          const input = z
            .object({
              turnID: z.string().uuid(),
              revision: z.number().int().min(0),
              question: z.string().min(1).max(2000),
              retry: z.boolean(),
            })
            .strict()
            .parse(JSON.parse(body));
          res.end(JSON.stringify(await c.startChat(input)));
        }
        return;
      }
      if (req.method !== 'POST' || req.url !== '/command') {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 1024 * 1024) throw new Error('Command too large.');
      }
      const cmd = commandSchema.parse(JSON.parse(body));
      if (menuPending && cmd.command !== 'prioritize')
        throw new Error('A menu command is still running. Try again shortly.');
      let task: Promise<unknown> | undefined;
      switch (cmd.command) {
        case 'start':
          task = c.start(cmd.value);
          break;
        case 'mode':
          await c.setMode(cmd.value);
          break;
        case 'settings':
          await c.saveSettings(cmd.value);
          break;
        case 'apply':
          task = c.apply(cmd.value);
          break;
        case 'newsletter':
          task = c.reviewNewsletter(cmd.value);
          break;
        case 'review':
          task = c.reviewOne(cmd.value);
          break;
        case 'undo':
          task = c.undo(cmd.value);
          break;
        case 'prioritize':
          c.prioritize(cmd.value);
          break;
        case 'resume':
          task = c.resume();
          break;
        case 'stop':
          task = c.stop();
          break;
        case 'summary':
          task = c.refreshInboxSummary();
          break;
        case 'pause':
          task = c.pause();
          break;
        case 'togglePause':
          task = c.togglePause();
          break;
        case 'retry':
          task = c.retry();
          break;
        case 'sync':
          task = c.syncInbox();
          break;
        case 'refresh':
          task = c.refresh();
          break;
      }
      void task?.catch((e) => {
        c.status = clean(e instanceof Error ? e.message : 'Command failed.');
        c.changed();
      });
      res.end(JSON.stringify({ accepted: true }));
    } catch (e) {
      res.writeHead(400);
      res.end(
        JSON.stringify({ error: clean(e instanceof Error ? e.message : 'Invalid command.') }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  server.on('close', () => {
    c.off('change', changed);
    void unlink(socket).catch(() => {});
  });
  return server;
}

export async function ensureWorker(
  config: Config,
  envFile?: string,
  options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
  upgrades = 0,
): Promise<string> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  if (upgrades === 0) await updateInstalledService(config, envFile || resolve('.env'));
  onProgress?.('Connecting to background worker…');
  const socket = workerSocket(config);
  let existing: { protocol?: number; profileRevision?: string } | undefined;
  const matches = (value: { protocol?: number; profileRevision?: string }) =>
    value.protocol === WORKER_PROTOCOL && value.profileRevision === config.profileRevision;
  try {
    existing = await workerRequest(socket, '/ping', undefined, signal);
  } catch {}
  signal?.throwIfAborted();
  if (existing && matches(existing)) return socket;
  if (existing) {
    onProgress?.('Updating background worker…');
    if (upgrades >= 3)
      throw new Error(
        'An older worker keeps restarting. Close inboxtop background processes and reopen the app.',
      );
    // Upgrade only this account's verified inboxtop process, after a graceful shutdown.
    const lock = join(config.dataDir, accountID(config), 'session.lock');
    const owner = await lstat(lock);
    const pid = Number(await readFile(lock, 'utf8'));
    const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command=']);
    if (
      owner.uid !== process.getuid?.() ||
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      !stdout.includes(compiled ? process.execPath : resolve(import.meta.dir, 'index.ts')) ||
      !stdout.includes('--worker')
    )
      throw new Error('Close the older inboxtop background worker before starting this version.');
    signal?.throwIfAborted();
    process.kill(pid, 'SIGTERM');
    let stopped = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      await delay(100, undefined, { signal });
      try {
        process.kill(pid, 0);
      } catch {
        stopped = true;
        break;
      }
    }
    if (!stopped)
      throw new Error(
        'The older worker is still shutting down. Try opening inboxtop again shortly.',
      );
    try {
      const running = await workerRequest(socket, '/ping', undefined, signal);
      if (matches(running)) return socket;
    } catch {}
  }
  signal?.throwIfAborted();
  onProgress?.('Starting background worker…');
  await privateSocketDirectory(socket);
  signal?.throwIfAborted();
  const child = spawn(
    process.execPath,
    runtimeCommand([
      '--worker',
      ...(config.profilePath
        ? ['--profile', config.profilePath]
        : envFile
          ? ['--env', envFile]
          : []),
    ]).slice(1),
    {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  );
  let error: Error | undefined;
  child.on('error', (e) => {
    error = e;
  });
  child.unref();
  onProgress?.('Waiting for background worker…');
  for (let attempt = 0; attempt < 80; attempt++) {
    if (error) throw error;
    await delay(100, undefined, { signal });
    try {
      const running = await workerRequest(socket, '/ping', undefined, signal);
      if (matches(running)) return socket;
      return ensureWorker(config, envFile, options, upgrades + 1);
    } catch {}
    signal?.throwIfAborted();
  }
  throw new Error(
    'Could not start the background worker. Check configuration or close an older inboxtop process holding the cache.',
  );
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function servicePlist(config: Config, envFile: string) {
  const label =
    'local.inboxtop.' +
    accountID(config) +
    '.' +
    createHash('sha256').update(config.dataDir).digest('hex').slice(0, 8);
  const argv = runtimeCommand([
    '--worker',
    ...(config.profilePath ? ['--profile', config.profilePath] : ['--env', resolve(envFile)]),
  ]);
  return {
    label,
    text: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${argv.map((v) => `<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(compiled ? dirname(process.execPath) : resolve(import.meta.dir, '..'))}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n`,
  };
}
export async function installLiveService(config: Config, envFile: string) {
  if (process.platform !== 'darwin') return;
  // launchd must be able to reload credentials after login; never copy keys into a plist.
  const restart = config.profilePath
    ? await loadProfile(config.profilePath)
    : loadConfig(envFile, {});
  // The encrypted settings restore the selected provider on startup.
  restart.provider = config.provider;
  restart.model = config.model;
  if (configErrors(restart, true).length)
    throw new Error(
      'Live startup needs IMAP and provider credentials in the --env file so it can restart after login.',
    );
  const { label, text } = servicePlist(config, envFile);
  const directory = join(homedir(), 'Library/LaunchAgents');
  await mkdir(directory, { recursive: true });
  const path = join(directory, label + '.plist');
  const exec = promisify(execFile);
  try {
    await exec('launchctl', ['print', `gui/${process.getuid?.()}/${label}`]);
    return;
  } catch {}
  await writeFile(path, text, { mode: 0o600 });
  try {
    await exec('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, path]);
  } catch {
    throw new Error('Could not register the macOS Live service. Live mode was not enabled.');
  }
}

/** Update only an already installed, owned service; never install one during ordinary startup. */
async function updateInstalledService(config: Config, envFile: string) {
  if (process.platform !== 'darwin') return;
  const { label, text } = servicePlist(config, envFile);
  const path = join(homedir(), 'Library/LaunchAgents', label + '.plist');
  let owner;
  try {
    owner = await lstat(path);
  } catch {
    return;
  }
  if (!owner.isFile() || owner.uid !== process.getuid?.())
    throw new Error('Unsafe existing inboxtop service file.');
  if ((await readFile(path, 'utf8')) === text) return;
  if (!config.profilePath) {
    try {
      if (accountID(loadConfig(envFile, {})) !== accountID(config)) return;
    } catch {
      return;
    }
  }
  const exec = promisify(execFile);
  const target = `gui/${process.getuid?.()}/${label}`;
  let installed = false;
  try {
    await exec('launchctl', ['print', target]);
    installed = true;
  } catch {}
  const temporary = path + '.' + process.pid + '.tmp';
  await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  if (installed) {
    try {
      await exec('launchctl', ['bootout', target]);
      await exec('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, path]);
    } catch {
      throw new Error(
        'The existing inboxtop login service could not be updated. Reopen inboxtop after checking launchd. Saved data is unchanged.',
      );
    }
  }
}

/** UI connection: the worker is the only owner of IMAP, model calls, and encrypted storage. */
export class RemoteController extends Controller {
  private timer?: ReturnType<typeof setInterval>;
  private revision = 0;
  private pulling = false;
  private nextIdlePoll = 0;
  constructor(
    readonly socket: string,
    config: Config,
  ) {
    super(
      {
        snapshot: async () => {
          throw new Error('Remote mailbox');
        },
        fetch: async () => {
          throw new Error('Remote mailbox');
        },
        setRead: async () => {
          throw new Error('Remote mailbox');
        },
        close: async () => {},
      },
      {
        analyze: async () => {
          throw new Error('Remote analyzer');
        },
      },
      new MemoryStore(),
      config.provider,
      config.model,
      config.concurrency,
      config,
    );
  }
  override async init(signal?: AbortSignal) {
    await this.pull(signal);
    signal?.throwIfAborted();
    this.timer = setInterval(() => {
      if (!this.mutating && Date.now() < this.nextIdlePoll) return;
      this.nextIdlePoll = Date.now() + 750;
      void this.pull().catch((e) => {
        this.status = clean(e.message);
        this.changed();
      });
    }, 100);
  }
  async pull(signal?: AbortSignal) {
    if (this.pulling) return;
    this.pulling = true;
    try {
      const state = await workerRequest(
        this.socket,
        '/state?since=' + this.revision,
        undefined,
        signal,
      );
      if (!state) return;
      this.revision = state.revision;
      this.saved = state.saved as Saved;
      for (const field of [
        'status',
        'busy',
        'snapshotting',
        'syncing',
        'mutating',
        'monitoring',
        'summaryBusy',
        'newsletterProgress',
        'reviewJobs',
        'summaryError',
        'reused',
        'classifiedReused',
        'writeProgress',
        'pendingReads',
        'provider',
        'model',
      ] as const)
        (this as any)[field] = state[field];
      this.stages = new Map(state.stages);
      if (this.config && this.saved.settings) applySettings(this.config, this.saved.settings);
      this.changed();
    } finally {
      this.pulling = false;
    }
  }
  private async command(command: string, value?: unknown) {
    await workerRequest(this.socket, '/command', {
      command,
      ...(value === undefined ? {} : { value }),
    });
    await this.pull();
  }
  override async loadChat() {
    return (await workerRequest(this.socket, '/chat/current')).chat;
  }
  override async saveChatDraft(
    scope: string,
    expected: string,
    draft: string,
    cursor: number,
    scrollTop: number,
  ) {
    const stored = await workerRequest(this.socket, '/chat/draft', {
      scope,
      expected,
      draft,
      cursor,
      scrollTop,
    });
    this.saved.chats = { ...this.saved.chats, [scope]: stored };
    return stored;
  }
  override async saveChat(scope: string, revision: number, state: ChatState) {
    const result = await workerRequest(this.socket, '/chat/save', { scope, revision, state });
    this.saved.chats = { ...this.saved.chats, [scope]: { revision: result.revision, state } };
    return result.revision as number;
  }
  override async startChat(request: ChatRunRequest): Promise<ChatRunState> {
    return await workerRequest(this.socket, '/chat/start', request);
  }
  override async chatRunState(): Promise<ChatRunState> {
    const state = await workerRequest(this.socket, '/chat/run');
    await this.pull(); // Make newly cached originals available before exposing their citations.
    return state;
  }
  override async cancelChat(turnID: string) {
    await workerRequest(this.socket, '/chat/cancel', { turnID });
  }
  override async chatStep(_input: ChatInput, _signal: AbortSignal): Promise<never> {
    throw new Error('Chat model calls must run inside a worker-owned investigation.');
  }
  override start(scope: Scope) {
    return this.command('start', scope);
  }
  override stop() {
    return this.command('stop');
  }
  override refreshInboxSummary() {
    return this.command('summary');
  }
  override resume() {
    return this.command('resume');
  }
  override pause() {
    return this.command('pause');
  }
  override togglePause() {
    return this.command('togglePause');
  }
  override retry() {
    return this.command('retry');
  }
  override refresh() {
    return this.command('refresh');
  }
  override syncInbox() {
    return this.command('sync');
  }
  override setMode(mode: 'adhoc' | 'live') {
    return this.command('mode', mode);
  }
  override reviewOne(id: string) {
    return this.command('review', id);
  }
  override reviewNewsletter(ids: string[]) {
    return this.command('newsletter', ids);
  }
  override apply(ids: string[]) {
    return this.command('apply', ids);
  }
  override undo(id: string) {
    return this.command('undo', id);
  }
  override saveSettings(settings: z.infer<typeof SettingsSchema>) {
    return this.command('settings', settings);
  }
  override prioritize(id: string) {
    void this.command('prioritize', id).catch(() => {});
  }
  override startMonitoring() {} // Owned by the worker, independent of terminal lifetime.
  override stopMonitoring() {}
  override async close() {
    this.closed = true;
    clearInterval(this.timer);
  }
}
