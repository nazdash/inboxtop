# Repository guidance

Before planning or implementing any change, read [PRINCINPLES.md](PRINCINPLES.md).
It is the main product reference for future functionality. Check decisions against
its principles in order; earlier principles win when they conflict.

For terminal UI work, read and follow [UI-PRINCIPLES.md](UI-PRINCIPLES.md).
Reuse the shared layout rules in `src/ui/layout.ts` and the existing OpenTUI Core
components. Keep unread analysis and mailbox actions separate; no automatic
mailbox changes. Verify UI changes with fictional fixtures, not real email or
model calls. Do not modify the separate email-analyzer project.

The product is keyboard-first. Every action and link must be discoverable and
usable without a mouse. Show accurate keyboard hints, preserve focus on Back,
and verify complete keyboard-only navigation for new interactions.

## Start here

- For installing/configuring the app for someone: follow the ordered [agent setup runbook](docs/AGENT-SETUP.md). Report installed, configured and connection-tested separately.
- For code navigation and data ownership: [ARCHITECTURE.md](ARCHITECTURE.md).
- For current user behavior: [README.md](README.md).
- Keep main documents in the root: README, agent guidance, product/UI principles,
  architecture, contributing, security and license. `docs/` holds supporting public
  guides. Put private plans, future feature ideas,
  local research, audit notes and generated previews in `docs/internal/`, which is
  ignored by Git and excluded from releases. Never force-add that folder. A fresh
  clone must work without it. Keep root README/agent files and GitHub policy
  entry points discoverable. Public instructions must not depend on internal files.

## Commands and boundaries

Run `npm ci` for the pinned dependencies/runtime, `npm run typecheck` for types,
and `npm test` for fictional-fixture tests. Unix-socket integration tests need local
socket permission. Use `npm run preview` and `npm run test:terminal` for terminal
UI changes. Previews are generated into ignored `docs/internal/previews/`.

Use `npm start -- doctor --json` for offline config diagnostics and
`npm start -- setup --schema` for accepted setup fields. npm adds a script banner;
for machine JSON use `npm run --silent start -- doctor --json` or `./inboxtop doctor --json`.
These checks do not prove credentials/models work and do not inspect saved overrides.
Interactive `setup` is the credential-entry path; the user enters secrets locally.
`doctor --test-vault` is an explicit exception to read-only diagnostics: it creates,
reads and deletes one uniquely named fictional credential. Never run connection
tests, including the wizard's potentially paid AI test, as an implicit install check.

`npm run build` creates a host-native standalone candidate. `npm run audit:release`
is a supplemental privacy scan, not a substitute for a dedicated secret scanner.
See [release guidance](docs/RELEASING.md) before distributing artifacts.
Packaging requires the source to match BUILD.json; rebuild after code or public-doc
edits. `npm run verify:release` checks extracted candidates in an isolated home and
runs fictional terminal tests (Python 3.11+). Mac signing is optional for source
publication; its preparation command only prints a plan unless explicitly executed.

Never print secrets, real mail or full environment dumps. Do not ask users to put
credentials in chat or CLI arguments. Installation verification uses `--demo`,
never `--once`/`--watch`: those can analyze real mail and spend money. Do not enable
Live, mutate read flags, register services or delete cache/history merely to test
installation. Keep explicit `--env` account isolation and persisted message identity.
Tests must not require a real account, paid model requests or personal fixtures.
