# inboxtop terminal UI principles

Read [PRINCINPLES.md](PRINCINPLES.md) first. It defines the product's priorities
and why they matter. This document describes their interface implementation and
must remain consistent with them.

The app helps a person decide what to do with unread mail. Prefer a quiet layout
that keeps the email and its recommendation visible. Reuse OpenTUI Core components
and the shared geometry in `src/ui/layout.ts`.

## Screen structure

Onboarding and reconnect share one keyboard flow: Email, AI, Save. Keep passwords
masked in a dedicated secret editor; never place plaintext secrets in renderable
buffers. Draft edits survive navigation and resizing; cancelling an edit restores
its prior value. Tests run only on explicit actions, show progress and cancellation,
and must pass again after relevant edits. Explain fictional AI-test cost before
running it. Save errors retain the draft; successful save returns to Ad hoc with
existing history intact. Keep input and navigation hints on separate rows, including
at 40 columns. First setup does not start analysis or enable a background service.

- Use a single application header: app/location at left, current mode at right.
  Show only Ad hoc or green `● Live`. On the inbox, focus gives the mode a filled
  highlight and `‹ ›` arrows; inactive mode stays quiet. Clicking the inactive
  label focuses it; clicking again or Enter switches. `m` focuses the selector;
  Left selects Ad hoc and Right selects Live. No dropdown or side-by-side options.
  Disable changes during writes, editing, confirmation and a pending mode switch.
  Show switching feedback until it finishes. Provider settings belong in Settings;
  review screens also offer mode switching in More.
- The main dashboard shows three explicit groups: REVIEW with 1–4, SUBSCRIPTIONS
  with `l Browse subscriptions`, and CHAT with `c Ask your inbox`. Share this
  rendering across overview screens. Use neutral headings and entry text, matching
  indentation/count columns, and the same focus highlight. A destination must not
  inherit a different action-button color. Chat searches saved mail with automatic bounded inbox access
  independently of Ad hoc/Live. Separate groups by the standard section gap;
  keep headings even on short terminals. Do not add a Review results gateway.
  Live updates counts as results finish; Ad hoc shows existing completed results.
- Tie New analysis to Ad hoc in a compact control just below the header. It opens
  batch size, order and Start together; Live shows its status and Stop instead.
- Keep coverage counts beside their bar and the summary in its own area.
  Unanalyzed mail is outside the four completed recommendation groups.
  Failed analyses also remain outside those groups. Show their count with `! View`
  in the coverage row; More exposes View failed analyses and `R Retry failed reviews`.
  Reuse the email list/preview for inspecting failures and original text. Check manually
  means the next step cannot be determined, not a provider or validation failure.
- Review screens have a compact message list above an email preview. A single
  heading identifies Review (app-generated) or Original (sender's text).
- Put view controls beside the content they shape, and email actions/navigation in
  the bottom dock. Scope, category filters, Search, Sort and new-results notices
  belong above the list. Keep the current search visible; Backspace clears it.
  Original/Review and Expand/Collapse belong beside the preview title; Read digest
  occupies that position for a subscription group. Re-analysis status appears in
  the preview heading as well as the action's pending label.
- Keep these controls in their assigned places when pane focus or selection changes.
  Header controls wrap as whole key/label pairs on narrow terminals; reserve their
  width before truncating the preview title. Keep at least one list row and two
  preview content rows. Do not add another focus stop: visible shortcuts, mouse
  controls and More all execute the same command definitions and guards.
- The bottom dock has one quiet context/status row, email action buttons, then a
  navigation row. Mark read, selection and Re-analyze remain there; bulk selection
  changes their targets/labels. Keep selection controls visible in both panes.
  Keep summary generation tied to its sender and requested issue set, shared through
  the worker. Mark only that sender row and Generate button as Generating; unrelated
  previews must not inherit its progress. Summary work must never show batch-analysis
  counters. Clear the running indicator on completion, cancellation or failure. Generate summary is a visible action for subscription groups without a cached digest. The dashboard
  retains its own batch settings and destination controls.

## Waiting and operation states

Use one shared activity treatment across terminal screens. State comes from the
operation that owns the work, never from a generic global busy flag alone.

| State | Presentation |
| --- | --- |
| Idle | Normal action label; no animation or permanent completion banner. |
| Submitted / queued | Static “Queued…” or `[…]`; the work has not started yet. |
| Running | One small spinner beside a specific, steady label in the existing status area. |
| Completed | Stop immediately; show the result or a brief factual acknowledgement. |
| Cancelled | Stop immediately; state what was kept when relevant. Back alone never implies cancellation. |
| Failed / unconfirmed | Stop immediately; retain an explanation and recovery action. Never imply a mailbox write succeeded without verification. |

Prefer “Searching saved emails…”, “Preparing answer…”, “Generating summary…”,
“Re-analyzing…”, “Syncing inbox…” and “Testing connection…” to generic “Thinking”.
Use actual counts when available. No invented percentage, time estimate or claim
about the model's internal reasoning. A spinner signals a pending operation, not
proof that the remote service is making progress.

Animate only the symbol, at a quiet cadence in the existing muted text color.
Use one animated status per screen, prioritizing the current user operation;
duplicate buttons and row markers remain static. Subscription activity belongs
only to its target group. Background work may show its explicitly named target on
the dashboard, never masquerade as work on a different email or group.

After a few seconds, show whole seconds of locally observed waiting only where
there is room. This is not an ETA or a claimed server runtime; the observation
restarts when the visible operation changes. Never let this suffix wrap a label,
move a control, or push content out of a narrow screen.

Apply the treatment to Chat requests, summaries, re-analysis, active mailbox
updates, sync, startup, and explicit settings/onboarding tests and saves. Keep
autosave, queued rows, confirmations awaiting input, and the Live mode dot static.
Do not add panels or extra status rows solely for animation. Preserve existing
keyboard cancellation and Back semantics.

Reuse the shared activity component with a plain ASCII symbol cycle, so it does
not depend on special fonts. Timer ticks update the bound text node only: never
rebuild the screen, reset a selection/caret/scroll, or request work. Stop timers
when idle, hidden, failed, cancelled, or disposed. Verify lifecycle, target scope,
both themes and narrow layouts using fictional delayed operations.

Explicit email re-analysis and subscription summaries share a worker-owned FIFO.
Accept another target while analysis is busy; show static Queued until it starts.
Disable duplicate requests only. Freeze the requested issue set; scope changes do
not add emails to queued work. Retain scoped failures so another result cannot hide
them. Stop cancels active and queued reviews; Back only navigates. Mailbox writes
interrupt the active review without replay and hold the remaining queue until writes
finish. Queues survive terminal detach, but are cancelled on worker shutdown and
never automatically replayed on restart. Completed results remain saved.

## Commands and focus

- Keyboard first is a product requirement. Every action, link, chooser and
  confirmation must be discoverable and operable without a mouse. Mouse support
  is an additional path, never the only path. Show the keyboard entry point next
  to interactive content; selected rows need visible focus and predictable
  arrow/Enter/Esc behavior. Verify complete keyboard-only flows, including Back
  and preservation of selection, draft and scroll.

- Keep `; More` and `, Settings` visible and clickable in the inbox and results
  dashboard footer at every supported width, including while the mode selector is
  focused. Reserve them before optional hints. The dashboard More menu exposes
  Sync inbox, Time period (show current scope), Inbox map, history/undo, summary
  refresh/expansion, sender statistics, settings and Stop when applicable. Closing
  the menu preserves dashboard focus; returning from history restores its caller.
- Use one command definition for each action's key, label, scope, availability,
  mouse click and execution. Recheck availability when executing. Unavailable
  shortcuts must not fall through to a second handler with different behavior.
- Every email list uses the same controls: Mark read/unread, Select/Deselect,
  Select/Deselect all and Search, including Act, subscription issues
  and sender statistics. Subscription sender rows select their unread issues, with
  checked/partial markers; bulk actions cover only displayed sender groups. Use one
  Mark read action: the highlighted email/group by default, or selected emails.
  Marking the whole list is Select all followed by Mark read; no separate bulk button.
  Sort and Refresh list use the same keys in email lists. These act only on
  the displayed unread results, including filters, never unseen new arrivals.
- Preview viewing controls stay beside its title. Mark read and Re-analyze stay
  in the bottom dock. Labels describe the next action, not just a feature name.
  Re-analyze is also visible for the highlighted email in list context. Hide it
  while selecting emails; show Re-analyzing while that email's review is running.
- Selection has the same meaning in list, preview and expanded reader: `x` acts
  on selected messages before the highlighted email. Show “N selected” and
  “Mark N read,” plus Clear selection. Hide single-email re-analysis until the
  selection is cleared. Bulk writes replace the bottom command dock with a short inline
  confirmation: “Mark N emails as read?” with Esc Cancel and Enter Mark read.
  Use a rounded amber outline, subtle panel background, horizontal padding and a
  blank row between the question and actions. Add vertical padding when the standard
  section gap allows it; keep the panel compact on short terminals. Omit the normal
  dock separator and redundant instructional text while confirming.
  Keep the list and preview unobscured; no floating dialog or duplicate action rows.
  Freeze the proposed IDs; block background keyboard/mouse actions. Cancel preserves
  selection, position, sort, filters and preview focus/scroll. Adjust selection in
  the original list, not a duplicate confirmation list. Do not label all non-low-priority
  messages as needing attention.
- `; More` opens a scrollable command menu in the same bottom dock. Put secondary
  commands first: refresh, explanation, preview size, history/undo, settings,
  mode and retry failures when applicable. Include primary commands too for people
  who prefer arrows and Enter over remembering shortcuts. Render More with the
  same readable keycap/text treatment as other enabled navigation, never disabled
  styling. Dashboard and review menus share execution/availability handling. Esc closes the menu;
  menu navigation must not move the underlying message selection.
- Tab switches between list and preview, with no third Actions focus stop.
  Tab in the explicitly expanded reader returns to the list. Right/Enter focuses the email, Left returns to the list. Arrows move
  through the list or scroll the email according to focus. Cmd+Up/Down jumps to
  the first/last row of the focused list; Home/End provides a portable alternative
  when the terminal does not forward Cmd. Expose these in More and Help.
  `o` changes Original/Review without changing pane focus. `e` expands/collapses.
- Show `[ Prev` / `] Next` while reading an email, also listed by full name in
  More and Help. Disable at queue boundaries. Mouse,
  keyboard and menu navigation preserve reader focus and use the same queue.
- Keep Esc first and prominent in the navigation footer. Name its actual next
  destination (Back to inbox, subscriptions, or list); use Cancel/Close for transient
  editors and menus. Clicking it follows the same guards and behavior as the key.
- During mailbox writes, keep Back, browsing, sorting and reading available. Show
  write progress in the current view. Keep Mark read available for other emails:
  enqueue fixed IDs in the worker and deduplicate pending requests. Process bounded
  batches serially, verifying each email and retaining individual undo records.
  Show Updating/Queued on each pending row and its read button. Subscription sender
  rows use the same `[…]` marker while any issue has a submitted, queued or active
  read update; restore the normal marker when no issues are pending. Do not
  claim read until verified. Disable undo and conflicting analysis commands until
  the queue finishes; bulk additions still require their own scoped confirmation.
  Navigation does not cancel a confirmed batch, and completion must not reset the
  current screen, cursor, filters or selection.
- Esc first closes a menu, otherwise returns from the preview or expanded reader,
  then goes back one screen. Mouse and keyboard navigation use the same behavior.
- Indicate focus with a green `▶` marker on the area's existing heading.
  Avoid large filled badges. Clicks on content set focus; mailbox action buttons
  preserve it. Keep navigation hints inside the dock and label their actual target.
- Marking read keeps the current row until the user selects another email, with a
  read marker and Mark unread available. It leaves unread counts immediately.
  `z` undoes the last verified single-message read. After leaving that row, show
  Undo last read in the action bar when no bulk selection is active; on the same
  row, Mark unread already supplies that action. Keep Undo in More in both cases.
  An uncertain write must never
  offer a successful undo. Opening an email never marks it read.
- `r` refreshes the inbox summary on overview screens and re-analyzes the current
  email in review. Label the target explicitly; `g` refreshes lists or newsletter digests.
- Re-analysis shows immediate progress and disables duplicate requests. Preserve
  reader focus and scroll while it runs. Ordinary stopped/saved status should not
  occupy a persistent row; show active progress, useful feedback and errors.
- The main dashboard updates automatically. Email review queues remain stable:
  new results enter a review list only after explicit refresh. Newsletter sender
  sorting can reflect new data but must retain the selected sender and digest scroll.
- Subscriptions group analyzed issues by sender. Above the list, show Unread and
  All analyzed together with the active scope highlighted. `t Show` cycles Unread (default)
  and All analyzed, meaning retained read and unread mail, not the whole mailbox.
  Both scopes exclude pending/failed analysis. Counts show unread and total issues;
  selection and Mark read target only unread issues. Changing scope clears selection.
  Sort by latest issue by default,
  with issue count and name alternatives. Use the same list/preview/dock layout.
  The preview leads with one combined summary of all issues in the selected scope,
  highlighting substantive issues by subject and date. Compact original-issue links
  follow it; do not repeat every issue summary or reading recommendation underneath. Originals remain directly accessible. Keep the digest preview
  below the list on narrow terminals too; expansion is an explicit user action.
- Sender browsing, opening issues and changing scope reuse saved summaries without
  model calls. Preparing a combined digest is an explicit, visible `g Generate summary` action
  using saved findings only, without re-analyzing individual emails. Cache it by the
  exact issue set and label its scope and coverage. Show pending/missing coverage;
  never imply linked articles were read. Keep inbox briefings concise independently
  of the longer newsletter digest.

## Chat

Chat uses a growing conversation above its input and one contextual bottom dock.
Keep questions free-form: Chat chooses discovery, search, saved findings and
original-passage tools internally. Do not ask people to choose a retrieval mode.
Use specific progress labels for these operations in the existing status area.
When limits approach, show “Summarizing collected evidence…” and finish with
supported findings and explicit coverage. Reserve one correction for a rejected
answer within the existing allowance. Citation/format failures must name the
actual problem, not say a search limit was reached or blame the question.
Keep allowance exhaustion separate from citation failures: if retrieval cannot start,
stop locally, name the limiting allowance and show the recovery path (New chat
in F2 More for conversation limits; renewal time for hourly limits). Do not spend
model calls explaining a limit or treat it as evidence that no matching mail exists.
Keep retrieved summary/original excerpts in the conversation as “Collected evidence ·
partial”, labelled by provenance, with the usual keyboard source browser. Never
present rejected model prose as an answer.
Answers must distinguish saved findings from original reading and state partial
coverage when bounded retrieval cannot inspect all matches. Keep numbered sources
and their keyboard browser identical across narrow lookups and broad synthesis.
Show available mail above the conversation (saved mail plus the configured inbox),
with the active date range when one exists. Use existing credentials automatically;
no separate connection step or access toggle. Reuse saved findings, then retrieve
missing evidence from the inbox within the existing worker limits. Clarify missing
dates for unbounded synthesis, not whether to enable an already-configured account.
F4 Details shows factual operation receipts, source coverage and resource
limits, including during a running reply. Esc closes this layer without cancelling.
The dock names Esc Stop reply and Ctrl+B Back to inbox separately. Back/detach leaves
bounded worker-owned work running. Show the evidence basis below each answer;
metadata, saved AI findings and original passages must remain distinguishable.
Keep local saving status clear. Label generated answers
and provide stable, clickable sources opening original text. Preserve conversation,
draft and scroll when navigating; new replies start at their beginning. Tab switches
input/conversation. Ordinary typing must never trigger review shortcuts. Esc names
its current destination or cancellation action. Pending mailbox proposals show the
exact source list with Cancel/Confirm in the dock; confirmed writes keep Back
available. At 40×18 retain input, progress and navigation while prose scrolls.
Give the input a quiet rounded outline titled Message. Grow from one to four visual
lines as text wraps, then scroll inside the composer. Shrink when text is removed.
Enter sends; Ctrl+J (shown in the outline) or Shift+Enter inserts a new line.
Preserve pasted line breaks and the existing draft limit. Its focus border
is green; the other state is quiet. Reserve one blank row between the composer and
its controls. Commands have explicit horizontal separation and wrap as whole
key/label pairs; verify actual cell coordinates, not only text presence. Enter is
Send in the input and Type message in the conversation. Mouse and keyboard labels
must describe the same action. Preserve the input caret as well as its draft across
focus, source navigation, resize and theme changes. Source navigation hints belong
in the same dock, not a second toolbar above the source list.
Each answer's source block displays `Ctrl+O Browse`. The keyboard source browser
lists cited emails with the latest answer's citation order first; unused search
candidates are excluded. Arrows choose, Enter opens, and Esc returns from an
original to the same selected source, then to Chat. Source navigation preserves
the conversation and draft; it never marks an email read.
Render AI answer Markdown with OpenTUI's Markdown component; do not show formatting
punctuation as plain prose. Keep citations inspectable from the keyboard.
Use its top-level block layout so headings, paragraphs and lists have a consistent
one-row separation, including on narrow terminals. Headings use bold normal text;
do not color long sections as focus. Keep the saved answer unchanged when rendering.
Separate a numbered section that follows prose without a blank line at display
time; preserve fenced and multiline inline code literally.
Long generated answers should use short section headings and compact paragraphs,
without a redundant overall title or repeated “My takeaway” restatements. State
limited coverage briefly at the start; a few excerpts from one day must not be
presented as the most important insights across a two-month period.
Use F2 More in Chat so ordinary punctuation remains editable text. Keep Send,
focus, Sources and Back visible; put New chat and Retry reply in More. New chat
asks once before clearing the conversation and draft. Persist the current chat,
citations, draft, caret and reading position in the existing encrypted store.
Show saving failures, retain unsaved text, and prevent a stale terminal from
silently overwriting another terminal's saved chat. Reload explicitly discards
local changes only after a valid saved chat has been loaded. Flush on graceful
exit; keep the UI open if saving fails. Do not replay interrupted questions or
mailbox writes on restart; offer Retry for replies and History for write results.

## Settings and forms

- Distinguish editable fields, commands and information. Settings use quiet group
  headings, aligned labels/values, and a trailing `›` for fields that open a choice
  or editor. Fixed values are muted, labeled fixed, and skipped during navigation.
- Group AI provider/models together, in processing order: classification then
  detailed review. Keep language under Preferences and less common controls under
  Advanced. Unrelated navigation belongs in the relevant review menu.
- Show one contextual help area for the focused field, instead of descriptions
  under every row. Keep longer setup instructions in Help. Provider help explains
  where email content goes; model help explains each stage.
- Keep Save and Test in the bottom dock, outside the scrolling form. Their labels,
  keyboard behavior, disabled states and mouse actions must agree. Test uses
  fictional text and does not save. Show active work and its result in this dock,
  not unrelated mailbox progress.
- Edit a draft, show unsaved changes, and apply only on Save. Esc cancels an input
  or closes a chooser first; leaving a dirty form offers Keep editing, Save or
  Discard. Failed saves retain the draft. Ctrl+C exits after saving Chat, without committing Settings edits.
- Narrow forms stack values below labels and wrap full values. Scroll the focused
  field into view while retaining the dock. Preserve text edits during resize.
- Prefer Core Select for discrete choices and Input for model IDs/tags. Discover
  Ollama models inside either model chooser, with manual entry and retry available
  if discovery fails. Choosing a model never installs or downloads it.

## Content and hierarchy

- Follow the terminal's light/dark mode, not OS appearance. Use OpenTUI's theme
  signal to select one fixed light or dark palette from `src/ui/theme.ts`, shared
  with the loading screen. Do not query or copy terminal palette colors, derive
  shades from its background, or dynamically adjust app colors. Detection never
  blocks startup. Fall back to COLORFGBG, then dark when mode is unavailable.
  Theme changes must preserve selection, reader scroll and active input edits.

- Enclose AI summaries in a quiet rounded outline with an explicit AI Summary title
  in its top border. Use this treatment for inbox briefings, email summaries and
  subscription digests. Summary prose and section headings use the normal theme text
  color; headings differ only by bold weight, applied to the heading line alone.
  Original email text retains its distinct unboxed treatment.
  Keep summary controls on the top border; compact screens reserve space for the
  outline by shortening the excerpt, never by hiding navigation or outcome groups.

- Use short Action and AI Summary labels without repeated app branding. Omit Action
  when it merely says “Read.” Keep concrete tasks, deadlines and blockers visible.
- Email summaries convey the substance so people can decide whether to open the
  original. Do not append “Read in full” or “Worth reading” advice. Classification
  reasoning belongs in the optional explanation, not repeated below the summary.
- Keep explanation, analysis coverage and quoted evidence collapsed by default,
  available through More or `d`. Expansion belongs to that email, not the next one.
  Keep uncertainty and incomplete-review warnings visible.
- Clicking original text must preserve the existing renderable, selection and scroll.
  Update mouse focus in place; reserve command-dock space across list/preview focus
  so content does not move under the pointer. Render web URLs as native hyperlinks,
  with `L Links` providing an arrows/Enter/Esc keyboard picker in review and Chat.
- The Original view contains sender text. Generated recommendations and quotations
  must remain distinguishable from original content.
- Muted text provides context; green indicates focus; amber highlights tasks and
  warnings, blue reading, red errors. Pair color with text or a marker.
- Empty category counts, bars and percentages use muted gray even when selected.
  Their options remain accessible. Category percentages use analyzed results;
  mailbox coverage uses all unread mail. Unknown totals stay unknown.

## Geometry and density

- Use Core's Yoga flex layout in terminal cells. Growing content has `minHeight: 0`
  and `minWidth: 0`; headings and command rows use `flexShrink: 0`.
- Use the full terminal width with exactly one column of outer padding per side.
  Supported terminal sizes start at 40×18; keep the minimum dimensions in `src/ui/layout.ts`.
- Separate major sections by one row at 30+ rows. Compact screens omit these gaps.
  Do not add borders around every control. Batch settings and Start analysis share
  one genuine group on the Ad hoc setup screen.
- Keep the full-width preview below the list at every supported terminal size.
  Adapt pane heights and text wrapping; never remove the preview or automatically
  expand it on resize. Preserve the current email, focused pane and scroll.
  Short screens retain at least one list row and two preview content rows.
  Email and subscription lists indicate the current row with its background highlight,
  without a triangle cursor; keep checkboxes for multi-selection.
  Lists align sender, subject and date in one row per message; omit dates below
  65 columns. Narrow category tabs use two rows; overview outcomes retain full
  labels, counts and percentages but omit per-category bars. Shorten ancillary
  hints and hide secondary header metadata to keep controls usable.
- The command dock stays outside scrolling content. Wrap commands with zero
  vertical gap on narrow screens. Keep primary controls accessible; secondary
  commands live in More. Menu height is bounded so some content remains visible.
- Use a bounded ScrollBox for long prose. Summary height follows wrapped text,
  up to six lines normally, two below 24 rows (one during analysis), and four
  during analysis at 24–29 rows. Do not reserve empty rows for short summaries.
  Keep all four dashboard outcomes visible during analysis; below 24 rows, show
  processing status in the compact analysis row.
- Dashboard height budgets reserve all three group headings and six destinations
  before summary lines or descriptions. Below 24 rows omit the header rule and
  explanatory footer status. Put active progress (or an operational error) in the
  compact analysis row, and retain the navigation footer. Summary height uses the
  remaining budget, shared across both overviews. Descriptions appear only when
  the terminal is tall enough to preserve every destination.

## Verification and boundaries

All mailbox changes require a human action; bulk changes retain confirmation.
No reply editor or drafts: inboxtop supports the main email client.

Run typecheck and UI tests. Use `npm run preview` for fictional-data renders at
120×36, 80×24, 65×18, 50×24 and 40×18. Check focus, selected/read rows, menu navigation, active
analysis, errors, empty lists, long text and resizing. Never use the real mailbox
or paid model to test layout. Do not modify the separate email-analyzer project.

Core 0.6.0 references:

- [Layout and resize](https://opentui.com/docs/core-concepts/layout/?path=core)
- [ScrollBox](https://opentui.com/docs/components/scrollbox/)
- [Core documentation](https://opentui.com/docs/)


## Optional macOS menu companion

Use a standard native menu with keyboard navigation and system light/dark appearance.
Keep the terminal as the complete interface. Reuse worker counts and command guards;
never duplicate mailbox/model logic or expose email content in the status endpoint.
Use one monochrome template icon matching native menu bar items: a plain envelope
normally, an envelope with an exclamation badge for Act mail, and a warning triangle
for blocking connection or provider failures. No adjacent counts or colored Live icon; keep
mode and exact counts inside the menu and accessible labels. Do not blink or notify.
Use a compact two-line informational header; a green dot reinforces the Live label.
Action rows remain native menu items with icons, keyboard equivalents and text labels.
Keep Sync and Hide in More, with Sync still reachable by its key from the root menu.
Reserve the warning icon for app-level blockers. Never elevate individual email
failures or incomplete summaries into a persistent menu-bar warning. Explain the
cause and next step directly in the header, with a native keyboard-accessible
recovery action. Do not hide essential troubleshooting information in tooltips.
Keep status quiet; show progress only while active. Disconnection removes counts and
labels them unavailable. Commands wait for acknowledgement and never retry themselves.
Show in menu bar is a saved preference, off by default. Discarding Settings must have
no launch side effects. Hiding the helper never stops the worker. No helper login item
in v1. Review/Subscriptions/Chat reuse the existing terminal screens and controls.
