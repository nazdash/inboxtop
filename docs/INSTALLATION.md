# Installation

The current installation path is a source checkout. Public signed binary releases
are pending. A repository being public does not mean every platform is supported.

## Platform status

| Target | Status |
| --- | --- |
| macOS ARM64 | Local source, native build and fictional terminal checks passed |
| macOS Intel | Native build/tests passed CI; manual release acceptance pending |
| Linux x64 / ARM64 (glibc) | Native CI, archive and isolated keyring checks passed; manual acceptance pending |
| Windows native | Worker/IPC portability is unfinished; not supported for releases |
| Alpine / musl | Not a supported binary target |

[Native CI results](https://github.com/nazdash/inboxtop/actions/workflows/check.yml)
cover fictional fixtures and isolated installation checks, not real account access.

WSL is not separately validated. The optional menu app requires macOS 13+ and Apple
Terminal; the terminal application does not require the menu app.

## From source

Install Git and Node.js/npm. Node 26.4+ matches the installed OpenTUI package's
declared Node requirement. The application itself uses pinned Bun 1.4.3, installed
by npm; do not substitute a global runtime when reproducing a problem.

```sh
git clone https://github.com/nazdash/inboxtop.git
cd inboxtop
npm ci
./inboxtop --version
./inboxtop --demo
```

Demo is offline and fictional. Do not test installation with `--once`, `--watch`,
or a normal configured launch: those can connect to real mail and spend model
credits. No personal `.env` file or ignored internal documentation is required.

When ready, run `./inboxtop setup` and follow [setup](SETUP.md). For secure credential
storage, macOS uses Keychain. Linux needs `secret-tool` and an unlocked Secret
Service session (for example, the desktop keyring); a headless shell may lack one.
On Debian/Ubuntu, `secret-tool` is supplied by `libsecret-tools`. There is no silent
plaintext fallback. Password-based IMAP over verified implicit TLS is required;
OAuth-only accounts cannot connect yet.

## Build a local executable

Build on the intended target OS/architecture:

```sh
npm run build
```

The printed `dist/inboxtop-VERSION-OS-ARCH/` directory contains the executable,
public docs, license, dependency notices and a source manifest. Keep the directory
together; it needs no Node.js/npm/Bun installation at runtime. macOS local builds
are not Developer ID signed/notarized public releases. Do not disable Gatekeeper.

The optional menu helper requires Apple's Command Line Tools (`xcrun swiftc`):

```sh
npm run build:menu
# Or attach it to a standalone candidate directory:
npm run build:menu -- --standalone dist/inboxtop-VERSION-darwin-arm64
```

Use [release preparation](RELEASING.md) for packaging and verification. Python 3.11+
is required for terminal and archive verification; CI explicitly selects 3.12.
Do not treat CI artifact downloads as signed production releases.

## Local decision models with Ollama

For local classification, install a decision model such as Tev1 (Ollama 0.35 or later):

```sh
ollama pull tev1:4b
ollama list
```

In inboxtop, press `,` for Settings and choose:

- **Provider: Ollama** — email processing stays on this computer, with no cloud fallback.
- **Classification: tev1:4b** — sorts mail and decides which emails need detailed review.
- **Detailed review: qwen3.5:4b** (or another installed text model) — writes summaries,
  suggested next steps and Chat answers. Install it with `ollama pull qwen3.5:4b` if needed.

Use arrows and Enter to choose values, then **Test** to check both models with fictional
text. Test does not save changes or use your mailbox. **Save changes** applies your choices
to new work; existing reviews remain unchanged. If analysis is running, stop it before saving.

The classifier accepts both decision models and ordinary text models. It detects the
model's capabilities automatically. Decision-only models are excluded from the detailed
review picker; a manually entered incompatible tag produces an explanation in Test.
Choosing a model never downloads it. Cloud-backed Ollama models are rejected.

Decision models use the same bounded email excerpt and safety checks as other classifiers.
One classification request asks the rubric questions together. Missing or invalid answers
never become successful low-priority decisions. Probabilities are model scores, not a
guarantee of correctness; uncertain mail still gets a detailed review.

Environment-based setup uses `LLM_PROVIDER=ollama`, `OLLAMA_CLASSIFIER=tev1:4b` and
`OLLAMA_MODEL=qwen3.5:4b`. Saved Settings take precedence over these defaults.
See [Ollama decision models](https://docs.ollama.com/capabilities/decision).

## Upgrade or recover

Stop analysis and quit the menu helper before replacing an installation. Keep the
existing config, credential entries and encrypted account directory, including
its key. For a source checkout, update to the intended revision, run `npm ci`, then
rebuild the optional menu helper. Do not delete saved data to fix installation.

If the project directory moved and Swift reports an old module-cache path, remove
only the generated project `.cache/swift/` directory and rebuild the helper.
That compiler cache is unrelated to the encrypted email store.

If the launcher says dependencies are missing, run `npm ci` from the project root.
If the terminal is too small, enlarge it; use at least 40 columns by 18 rows.
For offline configuration checks use `./inboxtop doctor --json`; it does not prove
provider access. See [recovery](RECOVERY.md) and [agent setup](AGENT-SETUP.md) for
diagnostics, account isolation and safe removal.
