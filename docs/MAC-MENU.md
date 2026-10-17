# inboxtop Menu

Optional native macOS companion to the terminal app. Uses AppKit's standard status
item and menu: keyboard navigation, native appearance and accessibility labels.
It shares the existing worker; it has no email store, model client or mailbox engine.

## Build and enable

On a Mac with Xcode Command Line Tools and the project's dependencies installed:

```sh
npm run build:menu
./inboxtop
```

In terminal Settings, find **Mac integration → Show in menu bar**, switch it On,
then **Save changes**. The default is Off. The built bundle is
`dist/inboxtop Menu.app`. Reopening the terminal launches it again when enabled.
There is no companion login item in v1. Closing the terminal leaves the companion
and background worker running. Hiding the icon disables its preference but does
not stop Live or an existing analysis. Hide may take up to five seconds when
changed from terminal Settings.

## The menu

- One bold monochrome icon matching the other menu bar items: a plain envelope normally,
  an envelope with an exclamation badge for **1+ Act emails**, and a warning triangle
  for blocking connection or provider failures. No colored tint or adjacent number.
  The template icon appears white on dark menu bars and adapts to light menu bars.
  Exact Act counts and Live/Ad hoc mode remain inside the menu and accessibility label.
- Compact status header: mode and last sync on one line, unread/analyzed counts below.
  Live has a green dot inside the menu; progress appears only while active.
- Review groups **1–4**, **l Subscriptions**, **c Chat** open the corresponding
  terminal screen. **o Open inboxtop** opens the dashboard.
- **m Switch mode**, **p Stop analysis** when available. **More** holds
  **u Sync inbox** and **Hide menu bar icon**; the Sync shortcut also works from the main menu.
- Native action icons make destinations easier to scan. Color is limited to cues
  inside the menu; labels and keyboard access always convey the same meaning.
- Only app-level failures show a warning: worker disconnection, blocked inbox sync,
  or a failed AI provider connection, credentials, quota or model. Individual email
  failures and incomplete summaries keep the normal/Act icon. The cause and recovery
  advice are visible in the header, with **, Open settings…** or **Open inboxtop…**.
  A successful provider request clears its warning; cancelled or invalid reviews do not.
  Disconnection replaces the
  Act icon with the warning state and makes menu counts unavailable. Retry is explicit.
- **Hide menu bar icon** saves Off. If disconnected, **Hide until next launch**
  closes only this helper because the saved preference cannot be updated.

Use the macOS keyboard command for focusing menu bar status items, then arrows,
Enter and Escape; letter/number equivalents work within the open menu. There are
no global keyboard grabs. Native light/dark appearance follows macOS; terminal
appearance continues to follow the terminal.

Terminal launching currently uses Apple's Terminal and may open a new window.
macOS may ask for Automation permission when opening it for the first time.
Other terminal applications and reuse of an existing terminal window are deferred.
No native email preview, read/unread actions, Chat UI, notifications, batch setup
or summaries are included.

## Local build boundary

This is an ad-hoc signed development bundle, not a notarized standalone release.
Its runtime manifest references this checkout's Bun and TypeScript bridge. Keep
the checkout and dependencies in place; rebuild after moving them. It is meant
to be launched from terminal Settings so the worker socket and configuration file
are explicit. For a standalone candidate, build the terminal first, then use
`npm run build:menu -- --standalone DIST_DIRECTORY`. That bundle resolves the
terminal executable beside it and does not need the checkout or Bun installation.
Keep both together. Optional Developer ID/notarization preparation is documented
in [release guidance](RELEASING.md); actual Apple acceptance and a clean
Mac test remain necessary before distributing a notarized download. Swift is not
required to run either built artifact.

The compact `/menu/status` endpoint contains aggregate counts, command availability
and sanitized issue labels only. It excludes addresses, subjects, bodies, Chat,
provider credentials and detailed diagnostics. Opening/polling the menu is read-only.
Mode/Sync/Stop commands wait for worker acknowledgement, freeze conflicting controls
and are not automatically replayed after an uncertain response.

## Fictional verification

```sh
npm exec -- bun test tests/menu.test.ts
npm exec -- bun scripts/preview-menu.ts
# Optional interactive preview; never connects to real mail:
npm exec -- bun scripts/preview-menu.ts --open
# Native self-closing action check:
'dist/inboxtop Menu.app/Contents/MacOS/inboxtopMenu' \
  --fixture "$PWD/docs/internal/previews/menu-fixture.json" --smoke-test
```

The preview generates fictional snapshots and verifies native decoding and the
normal/Act/problem icons, with artwork in `docs/internal/previews/menu-icons.png` and light/dark
header previews beside it. In preview mode, terminal destinations don't launch anything;
mode and stop change only local fixture state, and Hide closes the preview.
