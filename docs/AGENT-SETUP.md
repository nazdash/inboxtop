# Install inboxtop for a user

This is the canonical installation runbook for Claude Code, Codex and other coding
agents. Read [AGENTS.md](../AGENTS.md) before changing the project. No plugin or
agent-specific installer is needed. Installation must work from a fresh clone,
without any private documentation or existing developer configuration.

## Outcome and boundaries

Report these separately: **installed** (offline demo works), **configured** (a
profile has been saved), and **connection-tested** (the user completed the labeled
mail and AI tests). Do not call the account ready just because `doctor` exits 0.

Proceed with reversible installation work. Hand credential entry and deliberate
connection tests to the user in their local terminal. Never request secrets in
chat, read them out of a password manager, paste them into tool calls, or collect
screenshots of configuration. Do not start real analysis as an installation test.

## 1. Check the environment

- Source repository: https://github.com/nazdash/inboxtop. Clone into a new directory;
  if a checkout already exists, inspect its remote and local changes before using
  it. Never overwrite an existing checkout or reset someone else's changes.
- macOS ARM64 is the locally verified path. macOS Intel and Linux glibc x64/ARM64
  have native CI configured; consult [platform status](INSTALLATION.md) before
  promising support. Native Windows and Alpine/musl are not release targets.
- Check `git --version`, `node --version` and `npm --version`. Use Node 26.4+ to
  satisfy the pinned UI dependency's declared requirement. Do not use `sudo npm`.
  If missing, use the user's existing runtime manager or explain the prerequisite;
  do not replace their global runtime silently.
- Interactive UI needs a real terminal, at least 40 columns by 18 rows. A captured
  shell is sufficient for JSON checks, but not evidence that the demo is usable.
- Secure setup needs macOS Keychain or, on Linux, `secret-tool` and an unlocked
  Secret Service session. A headless server may not have one. Do not silently
  create a plaintext configuration when the vault is unavailable.

## 2. Install the pinned source

For a new installation:

```sh
git clone https://github.com/nazdash/inboxtop.git
cd inboxtop
npm ci
./inboxtop --version
./inboxtop setup --schema
```

`npm ci` installs pinned Bun and native dependencies; no global Bun is required.
Use the project launcher, not an unrelated `bun` from PATH. Install scripts are
required by native dependencies; if package policy blocks them, report that
constraint rather than claiming installation succeeded. Do not change the lockfile
or run `npm audit fix --force` to make installation pass.

Public signed binary downloads, a Homebrew formula and an npm-global installer are
not available yet. Do not invent install URLs. [Local builds](INSTALLATION.md#build-a-local-executable)
are optional; users do not need to compile a standalone executable for source use.

## 3. Verify offline

```sh
./inboxtop doctor --json
./inboxtop --demo
```

On a fresh installation, `doctor` normally returns **1** for missing configuration.
That is an onboarding state, not a failed install. Read `checks[].id` and `status`.
Demo is fictional: no mail, credentials, model requests or background worker.
Use arrows, Enter, Tab, Esc and `?`; Ctrl+C exits. If you cannot operate a real
terminal, report the CLI checks you completed and hand the demo check to the user.

Do not use `--once`, `--watch`, or an ordinary configured launch to verify an
installation: they can connect to real mail and incur costs. Do not enable Live,
modify read flags, register login services or delete cached mail. Closing a real
terminal session does not stop its worker.

## 4. Hand over credential entry

Ask the user to run this in their own terminal, from the checkout:

```sh
./inboxtop setup
```

They enter credentials locally, choose the provider, explicitly test connections,
and save securely. Do not automate those buttons as part of installation. After
saving, an optional offline `doctor --json` can confirm profile structure; it does
not read vault passwords or establish authentication. The first real analysis
batch is a separate user action. Do not start it on their behalf merely to test.

## 5. Report the handoff

Give the checkout path, verified version, exact launch command (`./inboxtop` from
that directory), checks performed, and any remaining user step. State whether the
account is configured and connection-tested, or whether these were left to the
user. Mention limitations actually encountered; do not present pending work as
complete. Do not include addresses, passwords, API keys or private file contents.

## Configure a real account

First launch offers Demo or Connect email. `inboxtop setup` reopens onboarding.
Have the user enter secrets directly into its masked fields. The user explicitly runs the wizard’s read-only IMAP test and both AI
stages with fictional text, then chooses Save to the OS credential store. It returns to Ad hoc and suggests an explicit 10-email batch.
See [the onboarding guide](SETUP.md) for storage paths and provider requirements.
Do not drive real connection tests or submit credentials as an installation smoke test.

### Advanced environment configuration

Have the user create a private configuration file from `.env.example` and enter
secrets **locally**, using an editor they trust. Do not ask for passwords/API keys
in chat. Do not put secrets in shell arguments, command history, screenshots or
issue reports. Keep the file out of Git; on POSIX restrict it to owner access
(`chmod 600` on that file). Existing environment variables are also supported.
This path is plaintext configuration, not a system credential vault.

Required fields are `EMAIL_ADDRESS`, `EMAIL_PASSWORD`, `IMAP_SERVER`. Implicit TLS
is mandatory, port 993 by default. Use an app password if the provider supports
and requires one; OAuth is not implemented. Some providers/accounts cannot use
this authentication method. Do not disable TLS to work around an error.

Choose `LLM_PROVIDER=openai` with `OPENAI_API_KEY`, or `LLM_PROVIDER=ollama` with
installed local models and a loopback Ollama service. Inspect `.env.example` and
`setup --schema` for additional fields. The cloud endpoints/models are documented by OpenAI; having a key still does not
establish that the account can access them. Onboarding tests both stages explicitly.

Check the complete file without connecting:

```sh
./inboxtop doctor --env /absolute/path/to/config.env --json
```

An explicit `--env` is isolated: inherited configuration cannot fill missing fields
or override that account. Without `--env`, a saved secure profile takes precedence; otherwise startup reads
`.env` in the current working directory and environment overrides. Saved account settings can override
provider/model/language defaults; offline diagnostics do not open that storage.

Once the user is ready to connect, they can open:

```sh
./inboxtop --env /absolute/path/to/config.env
```

Normal startup can sync the mailbox and resume an existing Live configuration.
For a new account, keep Ad hoc. In Settings, Test provider tests classification and detailed review with fictional content;
with a cloud provider this makes two potentially billable requests. Test before using
real email, then explicitly choose a small first analysis batch (10 emails).
Cloud analysis sends selected email content and saved findings to the chosen
provider. Local Ollama has no cloud fallback. Mark read is a separate user action.

## Machine-readable contract

Run the launcher or `npm run --silent start -- …` to avoid npm banners in stdout.

| Command | What it does |
| --- | --- |
| `setup` | Interactive masked credential entry and secure saving |
| `--version` | Plain application version |
| `setup --schema` | JSON Schema for supported string-valued configuration fields |
| `setup --check --stdin --json` | Validates one JSON object, maximum 64 KiB, without saving |
| `doctor --json` (optional `--env PATH` or `--profile PATH`) | Validates configuration defaults and reports offline limitations |

The check input uses environment variable names, not internal Config property
names. Unknown fields and non-string values are rejected. Secret schema fields
have `writeOnly: true`; report output contains no input values. A calling tool
should deliver credentials through a protected local input channel, not construct
a shell command containing them. Use fictional values when testing the contract.

Reports have `schemaVersion: 1`, `command`, application `version`, `ok`, and `checks`.
Each check has a stable `id`, a `status` (`pass`, `fail`, `warning`, `not_checked`),
a human `message`, and optional `fix`/known missing `fields`. Branch on IDs and
statuses, not English messages. Invalid commands/JSON return an error envelope
with `schemaVersion`, `ok: false`, and `error.code: invalid_input`. Invalid object
shape returns a failed `input` check. JSON stdout contains exactly one object.

Exit codes: **0** offline checks passed (warnings/unperformed checks may remain),
**1** configuration missing or invalid, **2** command or input format invalid.
`ok: true` is not proof of authentication, network reachability, available AI
models, writable storage, a running worker or effective saved account settings.
Offline check commands do not open mail/cache, send requests, write settings or start workers.
`doctor --test-vault --json` is an explicit exception: it creates, reads and deletes
a temporary fictional credential to verify OS storage. The interactive wizard
performs its labeled connection tests and saves only on explicit Save.

## Recovery and contributions

Do not erase the cache to fix setup. Preserve account identity, history and chat.
Do not silently switch account/provider. Opening Demo is always the safe way to
check UI behavior without private data. Before sharing diagnostics, inspect them;
do not attach `.env`, cache keys, email screenshots or complete environment dumps.

For code changes, read [AGENTS.md](../AGENTS.md) and
[ARCHITECTURE.md](../ARCHITECTURE.md). Claude Code, Codex and other agents should
use this same contract; no agent-specific setup plugin is required.

## Troubleshooting decisions

| Symptom | Next step |
| --- | --- |
| Missing dependencies / launcher refuses to start | Run `npm ci` in the checkout; verify the expected OS/architecture and Node version. |
| `doctor` exits 1 on a fresh clone | Continue to local onboarding; do not create fake production credentials. |
| JSON command exits 2 | Correct arguments/input against `setup --schema`; do not retry a network operation. |
| Native module or unsupported platform error | Check the platform table and install log; do not suppress the error or claim support. |
| Keychain/keyring locked or absent | Let the user unlock/configure the OS store; keep existing profile/data intact. |
| Email authentication fails | Check provider/app-password eligibility locally; OAuth-only accounts are unsupported. Never disable TLS. |
| AI test fails | Check the selected provider/model with the user; never switch to a cloud provider silently. |
| Demo cannot render in a captured shell | Open a real terminal; report UI verification as pending until checked. |

For an existing installation, follow [upgrade and recovery](INSTALLATION.md#upgrade-or-recover).
Inspect local changes before pulling, preserve data/config/credentials, stop active
work before replacing executables, and rebuild the optional menu helper after a
path change. Removing the checkout is not permission to erase user data. Use
[recovery/removal](RECOVERY.md) for deliberate uninstall.
