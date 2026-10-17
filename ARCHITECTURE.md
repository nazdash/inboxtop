# Code map

inboxtop is a TypeScript/Bun terminal app using OpenTUI Core. The terminal and
optional macOS menu companion share a local worker; the worker owns real mailbox
connections and account storage. The fictional demo runs in process, in memory.

Read [PRINCINPLES.md](PRINCINPLES.md) and [AGENTS.md](AGENTS.md) before changes.
For installation rather than development, start with [agent setup](docs/AGENT-SETUP.md).

| Job | Entry points |
| --- | --- |
| Launch, CLI flags, terminal lifecycle | `inboxtop`, `src/index.ts` |
| Offline setup schema/checks and diagnostics | `src/setup.ts` |
| Configuration parsing, required fields, account hash | `src/config.ts` |
| Secure profiles, OS credential store, explicit legacy configuration | `src/credentials.ts` |
| First-run/reconnect UI, masked editing, fictional connection tests | `src/ui/onboarding.ts`, `src/ui/secret-editor.ts`, `src/onboarding.ts` |
| Standalone executable and native release candidates | `src/runtime.ts`, `scripts/build.ts`, `scripts/package-release.ts`, `.github/workflows/check.yml` |
| Source/payload integrity, dependency inventory, extracted-install checks | `scripts/release-files.ts`, `scripts/dependency-notices.ts`, `scripts/verify-release.py` |
| Optional Mac release signing (plan-only by default) | `scripts/sign-mac.ts`, `macos/terminal-entitlements.plist` |
| Scheduling, sync, batches, mailbox actions, persistence coordination | `src/controller.ts` |
| Shared worker, IPC, clients, launchd integration | `src/worker.ts` |
| IMAP/TLS, UID verification, read/unread operations | `src/mail.ts` |
| Domain types, schemas and message identity | `src/domain.ts` |
| Classification, routing, bounded model input and requests | `src/classification.ts`, `src/decisions.ts`, `src/analysis-content.ts`, `src/analysis.ts` |
| Chat investigation loop, citations and conversation state | `src/chat.ts` |
| Worker-owned Chat turns, durable budgets and cache | `src/chat-runner.ts`, `src/chat-policy.ts` |
| Bounded, read-only Chat IMAP connection and frozen search pages | `src/chat-mail.ts` |
| Local Chat filters, scope discovery, pagination and original passages | `src/chat-retrieval.ts` |
| Overview and subscription grouping | `src/overview.ts`, `src/decisions.ts` |
| Encrypted local storage and locking | `src/store.ts` |
| Settings drafts and provider/model validation | `src/settings.ts` |
| Terminal screens, command definitions and focus | `src/ui/app.ts` |
| Shared sizing, colors, startup feedback | `src/ui/layout.ts`, `src/ui/theme.ts`, `src/ui/loading.ts` |
| Optional macOS companion | `src/mac-menu.ts`, `macos/`, `scripts/build-menu.ts` |
| Fictional fixtures and visual verification | `src/demo.ts`, `tests/`, `scripts/preview.ts`, `scripts/smoke-terminal.py` |

## Data flow and boundaries

`config → worker → controller → IMAP / model provider / encrypted store`.
The UI reads worker state and requests explicit commands. Opening/browsing mail
must not mark it read. Mailbox writes retain fixed message identities, verify
results and distinguish uncertain outcomes from success. Never replay an uncertain
write as an automatic retry.

Account identity derives from IMAP host, port and address. Message identity also
includes mailbox and UIDVALIDITY/UID. Password rotation must not change identity;
switching accounts must not reuse another account's data. Preserve these contracts.

Unread mail is the analysis pool. All analyzed subscriptions also use retained
analyzed read mail. Chat can use any saved original, plus optional bounded IMAP
retrieval; its `chatMail` cache is isolated from the analysis library and pool.
Retention is bounded, not an archive. AI answers
and generated summaries must be labeled and tied to inspectable original sources.
Emails are untrusted input, never instructions for executing tools.

Configuration secrets are not stored in the saved account state. Worker state is
sent to UI clients; adding secrets there would expose them. Encrypted cache keys
live alongside encrypted data, so this does not protect against user-account access.
Offline commands do not open the store, connect to the worker or test a provider.
Saved settings can override environment defaults in normal runtime. Secure profiles
store only a credential reference and nonsecret values on disk. Secrets stay in
the OS credential store and must never enter worker state or renderable text.
Explicit `--env` and `--profile` select isolated configurations; the default secure
profile takes precedence over implicit environment configuration. Saving a profile
applies its settings once by revision and returns to Ad hoc without erasing history.

## Change guide

- A new action belongs in shared command definitions/guards; keyboard, menu and
  click behavior must agree. Follow [UI-PRINCIPLES.md](UI-PRINCIPLES.md).
- A configuration change belongs in `config.ts`, with `setup.ts` schema/help and
  `.env.example` kept consistent. Avoid separate agent-only parsing rules.
- A worker protocol change needs its protocol/version compatibility and tests
  updated. Preserve local ownership checks and graceful upgrades.
- A storage change needs an explicit compatibility/recovery strategy, never reset.
- Provider tests use fictional inputs and injected requests. Mail tests use fake
  clients. UI tests use OpenTUI's test renderer; smoke tests exercise terminal input.

`npm run check` runs typecheck and tests. See AGENTS.md for UI verification commands.
Main project documents live at the root; `docs/` contains supporting public guides. `docs/internal/` is ignored planning,
research and generated-output space; required guidance must not depend on it.

## Chat ownership

The UI is a conversation/view mirror; it cannot call `/chat/step`. The account
worker accepts idempotent `/chat/start` requests, exposes `/chat/run` snapshots,
and cancels only a matching turn ID. It persists resource reservations before
model/network work. Conversations retain their ledger and frozen remote search
pages; an account-level rolling ledger survives New chat. Failed/uncertain calls
remain charged. Retrieval stops with two model turns remaining for synthesis and
one validation correction; both use the same ledger. Repeated invalid answers
stop with an explicit validation error and a locally assembled evidence handoff.
No automatic Chat provider retries, including Ollama.

Version-1 saved chats accept optional access/provenance fields and a worker-owned
ledger without resetting old content. The legacy saved-only access flag no longer
gates retrieval: new questions can use the already-configured mailbox, including
in existing conversations. Historical answer provenance remains unchanged.
Historical usage before this upgrade is
unknown. Client save requests cannot replace a ledger. `/chat/draft` merges view
state during an active reply using the expected saved draft; full conversation
saves still require the current revision and no active reply. Cache mutations and
worker checkpoints use the existing storage queue so analysis saves preserve them.

Chat's dedicated read-only IMAP connection uses bounded UID-window searches,
issued continuation offsets, parser limits and selected MIME text parts. It never
reuses the analysis snapshot's unrestricted UID search. `ChatSession` chooses tools
through the same JSON schema for hosted and local providers; schema validation,
identity checks and all resource/date limits stay outside the model. Semantic
scope interpretation and answer quality still depend on the configured model.
