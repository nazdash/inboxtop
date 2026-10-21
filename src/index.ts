#!/usr/bin/env bun
import { localCommand } from './setup.ts';
import { loadRuntimeConfig, readProfile, userConfigPath } from './credentials.ts';
import { configFromValues } from './config.ts';
import { existsSync } from 'node:fs';
import type { OnboardingScreen } from './ui/onboarding.ts';
import { DestinationSchema, type Destination } from './destinations.ts';
import { launchMenu } from './mac-menu.ts';
import type { CliRenderer } from '@opentui/core';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, accountID, configErrors, type Config } from './config.ts';
import { Controller } from './controller.ts';
import { IMAPMailbox } from './mail.ts';
import { ModelAnalyzer } from './analysis.ts';
import { EncryptedStore, MemoryStore, type Store } from './store.ts';
import { DemoMailbox, DemoAnalyzer, demoSession } from './demo.ts';
import type { LoadingScreen } from './ui/loading.ts';
import type { TerminalApp } from './ui/app.ts';
import { clean } from './domain.ts';
import { statusSnapshot } from './overview.ts';
import {
  ensureWorker,
  RemoteController,
  serveWorker,
  workerRequest,
  workerSocket,
  installLiveService,
} from './worker.ts';

const args = process.argv.slice(2);
if (args[0] === '--menu-bridge') {
  const { runBridge } = await import('./menu-bridge.ts');
  try {
    console.log(JSON.stringify(await runBridge(args.slice(1))));
  } catch {
    console.log(
      JSON.stringify({ error: 'Could not complete menu request. Open inboxtop to reconnect.' }),
    );
    process.exit(1);
  }
  process.exit(0);
}
const localResult = await localCommand(args);
if (localResult) {
  console.log(localResult.output);
  process.exit(localResult.exitCode);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'inboxtop — recommendations for your unread inbox\n\nUsage: ./inboxtop [--demo] [--env PATH] [--watch | --once] [--open DESTINATION]\n\n  --demo       Fictional mail; no credentials, network, or background service\n  --env PATH   Configuration file (default: .env)\n  --watch      Enable persistent Live mode; print content-free JSON status\n  --once       Analyze remaining unread once; print content-free JSON status\n  --open NAME  inbox, act, read, clear, check, subscriptions, chat, settings\n\nThe terminal connects to a private background worker. Closing it does not\nstop analysis. Switch to Ad hoc or Stop to stop automatic analysis.\nLive mode on macOS registers a user service to restart after login.',
  );
  console.log(
    '\nSetup and diagnostics (offline):\n  setup --schema\n  setup --check --stdin --json\n  doctor [--env PATH] [--json]\n  --version\n\nAgent setup: docs/AGENT-SETUP.md',
  );
  process.exit(0);
}
let renderer: CliRenderer | undefined,
  app: TerminalApp | undefined,
  controller: Controller | undefined,
  store: Store | undefined,
  server: Awaited<ReturnType<typeof serveWorker>> | undefined;
let quitting = false;
let loading: LoadingScreen | undefined;
let onboarding: OnboardingScreen | undefined;
let startupTask: Promise<Config> | undefined;
let quitTask: Promise<void> | undefined;
const startupAbort = new AbortController();
let finish!: () => void;
const stopped = new Promise<void>((resolve) => {
  finish = resolve;
});
function quit(): Promise<void> {
  if (quitTask) return quitTask;
  quitTask = (async () => {
    if (app && !(await app.flushChat())) {
      quitTask = undefined;
      return;
    }
    try {
      await app?.dispose();
    } catch {
      await app?.flushChat();
      quitTask = undefined;
      return;
    }
    quitting = true;
    startupAbort.abort();
    onboarding?.cancel();
    loading?.dispose();
    renderer?.destroy();
    // Startup may still be assigning a controller/store. Wait for cancellation
    // before releasing resources, with the terminal already restored.
    await startupTask?.catch(() => {});
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((r) => server!.close(() => r()));
      }
      await controller?.close();
      if (!controller) await store?.close();
    } finally {
      renderer?.destroy();
      await renderer?.closed;
    }
  })();
  return quitTask;
}

try {
  let destination: Destination | undefined;
  let envFile: string | undefined,
    profileFile: string | undefined,
    forceSetup = false,
    setupSaved = false,
    demo = false,
    watch = false,
    once = false,
    worker = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'setup' && i === 0) forceSetup = true;
    else if (args[i] === '--demo') demo = true;
    else if (args[i] === '--watch') watch = true;
    else if (args[i] === '--once') once = true;
    else if (args[i] === '--worker') worker = true;
    else if (args[i] === '--open') destination = DestinationSchema.parse(args[++i]);
    else if (args[i] === '--env' && args[i + 1] && !args[i + 1].startsWith('--'))
      envFile = args[++i];
    else if (args[i] === '--profile' && args[i + 1] && !args[i + 1].startsWith('--'))
      profileFile = args[++i];
    else throw new Error('Unknown or incomplete option. Run ./inboxtop --help.');
  }
  if (destination && (worker || watch || once))
    throw new Error('--open requires an interactive terminal.');
  if (watch && once) throw new Error('Choose --watch or --once.');
  if (envFile && profileFile) throw new Error('Choose --env or --profile.');
  if (forceSetup && (watch || once || worker || demo))
    throw new Error('Setup requires an interactive terminal.');
  if (!watch && !once && !worker && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error('Run inboxtop in an interactive terminal. Use --help for instructions.');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => {
      void quit()
        .catch(() => {
          process.exitCode = 1;
        })
        .finally(finish);
    });
  startupTask = (async () => {
    if (!worker && !watch && !once) {
      const [{ createCliRenderer }, { LoadingScreen }] = await Promise.all([
        import('@opentui/core'),
        import('./ui/loading.ts'),
      ]);
      startupAbort.signal.throwIfAborted();
      renderer = await createCliRenderer({
        exitOnCtrlC: false,
        exitSignals: [],
        screenMode: 'alternate-screen',
        useMouse: true,
      });
      if (quitting) renderer.destroy();
      startupAbort.signal.throwIfAborted();
      loading = new LoadingScreen(renderer, () => {
        void quit()
          .catch(() => {
            process.exitCode = 1;
          })
          .finally(finish);
      });
    }
    loading?.update('Reading configuration…');
    let config: Config;
    try {
      config = demo ? loadConfig(false, {}) : await loadRuntimeConfig(envFile, profileFile);
    } catch (error) {
      if (!forceSetup) throw error;
      const path = profileFile || userConfigPath();
      config = existsSync(path)
        ? configFromValues((await readProfile(path)).values)
        : configFromValues({});
    }
    if (!demo && !worker && !watch && !once && (forceSetup || configErrors(config).length)) {
      loading?.dispose();
      loading = undefined;
      const { OnboardingScreen } = await import('./ui/onboarding.ts');
      onboarding = new OnboardingScreen(renderer!, config, profileFile || userConfigPath());
      const result = await onboarding.result;
      onboarding = undefined;
      if (result.kind === 'cancel') {
        startupAbort.abort();
        throw new Error('Setup cancelled.');
      }
      startupAbort.signal.throwIfAborted();
      if (result.kind === 'demo') {
        demo = true;
        config = loadConfig(false, {});
      } else {
        config = result.config;
        envFile = undefined;
        profileFile = config.profilePath;
        setupSaved = true;
      }
      const { LoadingScreen } = await import('./ui/loading.ts');
      loading = new LoadingScreen(renderer!, () => {
        void quit().finally(finish);
      });
    }
    if (!demo && !worker && !configErrors(config).length) {
      const remote = new RemoteController(
        await ensureWorker(config, envFile ? resolve(envFile) : undefined, {
          signal: startupAbort.signal,
          onProgress: (message) => loading?.update(message),
        }),
        config,
      );
      controller = remote;
      loading?.update('Loading saved inbox results…');
      await remote.init(startupAbort.signal);
    } else {
      if (worker) {
        const socket = workerSocket(config);
        // A newly registered launchd job waits for an already detached worker, then takes over.
        while (true) {
          try {
            await workerRequest(socket, '/ping', undefined, startupAbort.signal);
          } catch {
            break;
          }
          await delay(2000, undefined, { signal: startupAbort.signal });
        }
      }
      startupAbort.signal.throwIfAborted();
      if (demo) {
        const memory = new MemoryStore();
        memory.value.session = demoSession();
        store = memory;
      } else store = await new EncryptedStore(join(config.dataDir, accountID(config))).init();
      controller = new Controller(
        demo ? new DemoMailbox() : new IMAPMailbox(config),
        demo ? new DemoAnalyzer() : new ModelAnalyzer(config),
        store,
        demo ? 'demo' : config.provider,
        demo ? 'fictional' : config.model,
        config.concurrency,
        demo ? undefined : config,
      );
      loading?.update('Loading saved inbox results…');
      await controller.init();
    }
    startupAbort.signal.throwIfAborted();
    return config;
  })();
  let config = await startupTask;
  startupAbort.signal.throwIfAborted();
  if (worker) {
    const c = controller!;
    c.modeHook = (mode) =>
      mode === 'live' ? installLiveService(config, resolve(envFile || '.env')) : Promise.resolve();
    if (process.platform === 'darwin')
      c.menuBarHook = async (enabled) => {
        if (enabled)
          await launchMenu(
            workerSocket(config),
            envFile ? resolve(envFile) : resolve('.env'),
            config.profilePath,
          );
      };
    server = await serveWorker(c, workerSocket(config));
    c.startMonitoring();
    let scheduled = false;
    const pump = () => {
      if (scheduled || quitting || !c.canStartLiveAnalysis) return;
      if (!c.hasPendingAnalysis) return;
      scheduled = true;
      setTimeout(() => {
        void c.tick().finally(() => {
          scheduled = false;
          pump();
        });
      }, 100);
    };
    c.on('change', pump);
    if (!configErrors(config).length) {
      void c.tick();
    }
    await stopped;
  } else if (watch || once) {
    const missing = demo ? [] : configErrors(config, true);
    if (missing.length) throw new Error('Setup needed: ' + missing.join(', '));
    if (watch) {
      await controller!.setMode('live');
      if (demo) controller!.startMonitoring();
    } else await controller!.refresh();
    if (controller instanceof RemoteController) {
      do {
        await new Promise((r) => setTimeout(r, 300));
        await controller!.pull();
      } while (!quitting && controller!.busy);
    }
    console.log(JSON.stringify(statusSnapshot(controller!)));
    if (once) {
      if (controller!.session?.state === 'stopped' || controller!.failed) process.exitCode = 1;
      await quit();
    } else {
      controller!.on('change', () => {
        if (!quitting && !controller!.busy)
          console.log(JSON.stringify(statusSnapshot(controller!)));
      });
      await stopped;
    }
  } else {
    loading?.update('Preparing inbox view…');
    const { TerminalApp } = await import('./ui/app.ts');
    startupAbort.signal.throwIfAborted();
    loading?.dispose();
    loading = undefined;
    const reconnect = async () => {
      if (
        !app ||
        !controller ||
        controller.busy ||
        controller.mutating ||
        controller.mode === 'live'
      )
        return;
      if (!(await app.flushChat())) return;
      await app.dispose();
      app = undefined;
      const { OnboardingScreen } = await import('./ui/onboarding.ts');
      onboarding = new OnboardingScreen(
        renderer!,
        config,
        config.profilePath || userConfigPath(),
        undefined,
        true,
      );
      const result = await onboarding.result;
      onboarding = undefined;
      if (quitting) return;
      if (result.kind === 'saved') {
        await controller.close();
        config = result.config;
        envFile = undefined;
        profileFile = config.profilePath;
        try {
          const remote = new RemoteController(await ensureWorker(config, undefined), config);
          controller = remote;
          await remote.init();
        } catch {
          // Keep setup saved; reopening retries the connection without losing account data.
          loading = new (await import('./ui/loading.ts')).LoadingScreen(renderer!, () => {
            void quit().finally(finish);
          });
          loading.fail(
            'Setup saved, but the worker could not reconnect. Close and reopen inboxtop.',
          );
          return;
        }
      }
      // Demo from Settings is an exit from setup, not a switch of the real account.
      app = new TerminalApp(renderer!, controller!, config, demo, quit, reconnect);
      app.openDestination('settings');
    };
    app = new TerminalApp(renderer!, controller!, config, demo, quit, reconnect);
    if (setupSaved) {
      app.scope = { mode: 'unread', limit: 10, order: 'oldest' };
      app.notice = 'Setup saved. Choose New analysis to review your first 10 unread emails.';
      app.render();
    }
    if (destination) app.openDestination(destination);
    if (!demo && process.platform === 'darwin' && controller!.saved.settings?.menuBarEnabled) {
      void launchMenu(
        workerSocket(config),
        envFile ? resolve(envFile) : resolve('.env'),
        config.profilePath,
      ).catch(() => {
        app!.notice =
          'Menu companion could not start. Run npm run build:menu, then reopen inboxtop.';
        app!.render();
      });
    }
    if (demo) void controller!.syncInbox();
    else if (!(controller instanceof RemoteController) && !configErrors(config).length)
      void controller!.syncInbox();
    await renderer!.closed;
  }
} catch (e) {
  const message = clean(e instanceof Error ? e.message : 'Could not start inboxtop.');
  if (!quitting && loading && renderer) {
    process.exitCode = 1;
    loading.fail(message);
    await stopped;
    await quit().catch(() => {});
  } else {
    const cancelled = startupAbort.signal.aborted;
    await quit().catch(() => {});
    if (!cancelled) {
      console.error(message);
      process.exitCode = 1;
    }
  }
}
