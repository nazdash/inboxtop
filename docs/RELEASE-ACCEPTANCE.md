# Release acceptance

Use fictional fixtures for automation. Real-account checks below are a deliberate
manual step performed by the person entering their own credentials locally.
Do not print passwords, private messages or whole environment dumps.

## Automated candidate checks

1. `npm ci`, `npm run check`, `npm run audit:release`.
2. Run a dedicated secret scanner on publishable files and full Git history. Check
   screenshots and personal paths manually; scanners do not prove their absence.
3. `npm run build`; optionally build the Mac menu into the emitted directory.
4. On Linux, install `dbus`, `gnome-keyring`, `libsecret-tools`, then run
   `npm run test:vault:linux -- /absolute/path/to/binary`. This starts a disposable
   D-Bus/keyring session with fictional credentials, then verifies unavailable-store
   failure. It does not connect to the person's existing keyring.
5. `npm run package:release`, then `npm run verify:release`. Checks cover archive
   and full payload hashes, safe extraction, CLI JSON, demo navigation, terminal
   restoration and first-run cancellation while editing a masked password.

Run native checks separately on macOS arm64, macOS x64, Linux arm64 and Linux x64
before claiming support. Linux candidates target glibc; musl/Alpine and native
Windows are not supported release targets. Emulation is useful but is not native
hardware verification. Keep a record of OS/architecture, runtime version and result.

## First-time person walkthrough

On a fresh user profile with no checkout/runtime installed, extract the candidate.
Try `--demo`, keyboard navigation, Chat sources, original text and narrow/light/dark
terminal layouts. Reopen after Ctrl+C and check normal terminal echo/cursor behavior.

Open setup, choose the provider, enter credentials locally and explicitly test
email. Confirm that failed credentials stay editable and cancellation saves nothing.
Choose cloud/local AI, read the cost/content notice, and explicitly test fictional
content through both stages. This is the only real provider validation step; cloud
requests may cost money. Test account/model access rather than assuming that any
API key grants it. No private email is sent by this test.

Save, confirm Ad hoc and inspect the account identity. Analysis should require
an explicit Start. If the person wants to test real analysis, they choose a small
batch themselves. Verify summary/original distinction and keyboard Back. Do not
mark messages read as part of installation verification.

Reconnect through Settings; test a failed save with a locked/unavailable store,
then recover without losing the draft. Confirm that upgrading/reconnecting retains
saved reviews, Chat and account identity. Do not delete the account cache to test.

## Agent walkthrough

From only README, AGENTS.md and docs/AGENT-SETUP.md, verify that an agent can find
installation commands, inspect `setup --schema`, interpret `doctor --json` and
launch fictional Demo. It should direct the person to masked local credential
entry, without asking for secrets in chat or triggering paid connection tests.

## Mac downloadable binaries

Signing/notarization is optional for a source-only release. For downloadable Mac
artifacts, use the preparation command in RELEASING.md, then test the exact disk
image downloaded through a browser on a clean Mac. Confirm normal Gatekeeper
behavior, menu Automation permission and Keychain access. Do not bypass quarantine
or tell people to disable Gatekeeper as the acceptance path. A locally ad-hoc-signed
smoke test does not prove Developer ID/notarization or another user's Keychain flow.
