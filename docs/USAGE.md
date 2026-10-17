# User guide

Open source under the [MIT license](../LICENSE).

A terminal companion for your **unread INBOX**. It classifies mail, summarizes important messages, and helps you decide what to mark read. Replies, payments, approvals, and other real-world actions happen in your usual email client.

## Try it

```sh
./inboxtop --demo    # fictional mail, no network or background service
./inboxtop           # your configured inbox
```

On a fresh checkout, run `npm ci` first (Node.js/npm required). The launcher uses
the project's pinned Bun runtime. This is currently a source-checkout installation;
first launch offers fictional Demo or keyboard-first credential setup.
`npm run build` creates a standalone executable; public signed releases are pending.
macOS is the current development platform; Linux release validation and native
Windows worker portability are pending.

For credential entry, follow [the onboarding guide](SETUP.md).
For configuration, privacy boundaries and machine-readable setup, read the
[setup guide for users and agents](AGENT-SETUP.md). Useful offline commands:

```sh
./inboxtop --version
./inboxtop setup --schema
./inboxtop doctor --json
```

Diagnostics do not connect, analyze mail or validate credentials with a provider.
Cloud AI can incur charges and receives selected email content. Demo is fictional
and offline. Retained analyzed mail is not a complete mailbox backup.

Contributors preparing a release: see [release preparation](RELEASING.md),
[acceptance checks](RELEASE-ACCEPTANCE.md) and
[dependency/source inventory](DEPENDENCIES.md). Publishing the source does
not require Apple signing; downloadable Mac binaries have a separate signing path.

The main dashboard shows total unread mail, analysis coverage, a concise summary, and all four review groups immediately. Open a group with **1–4**, or choose **Subscriptions** (**l**) to browse analyzed subscription issues by sender. Live updates the dashboard as results arrive; Ad hoc shows saved results between batches.

## Optional Mac menu companion

Build with `npm run build:menu`, then enable **Settings → Mac integration → Show in
menu bar** and save. It uses one monochrome icon: a plain envelope normally, an
envelope with an exclamation badge when Act has emails, and a warning triangle for
blocking connection or provider failures. Counts and Live status stay inside the menu.
Open Review, Subscriptions or Chat in the terminal; switch
mode, sync or stop analysis directly from the menu.

The companion keeps running when the terminal closes. Hiding it leaves the worker
running. It has no login item, notifications or mailbox write actions. This local
Mac build uses the existing checkout/runtime and opens destinations in Apple
Terminal, potentially in a new window. See [build, behavior and limitations](MAC-MENU.md).

## Chat with your mail

Choose **c Chat** on the dashboard. Ask a question, then follow up naturally—for
example, “Explain the second one.” Chat searches deterministically by dates,
sender and literal terms, uses saved findings where available, and reads selected
original passages when needed. No vector database or separate research mode.

Chat uses your existing mailbox credentials automatically—there is no extra
connection step or access switch. It reuses saved read and unread mail, including
unanalyzed originals, and searches the configured mailbox (usually INBOX) when
saved evidence is insufficient. Inbox retrieval is bounded and read-only; it does
not search other folders or mark anything read. Failed analyses are not evidence.
Retrieved excerpts go to your configured model; retrieval never changes providers.
An explicit request to use only saved mail is respected by the model.

Search sends compact candidate headers, not full originals. Model-facing subjects
and senders are capped at 300 and 160 characters, with truncation labelled; internal
account/message IDs stay local. The model selects 1–3 sources per read operation.
Each supplies at most 4,000 characters around literal search terms or an explicit
offset. Overlapping excerpts are merged without duplication; unselected text stays
local. Further passages require another tool request within the same limits.
All source evidence together is capped at 24k characters, and each model context
at 36k. These are character limits, not exact token counts. Full retained titles,
source identities and available originals remain accessible from the source browser.

Chat uses the configured detailed-review model and language, including **local
Ollama**. Both providers use validated structured JSON; native model tool calling
is not required. There is no cloud fallback for a local model. Small models can
still fail the schema or evidence requirements; errors keep the question retryable.
A slow local model may reach the same request deadline as a hosted model.

Answers label saved summaries, original passages and metadata-only candidates.
These counts can overlap. Header matches are not proof of body contents. Sources
have stable numbers: **Ctrl+O**, arrows, **Enter** opens an available original;
**Esc** returns to the same source, then Chat. Opening it never marks it read.
**F4 Details** shows the latest reply's public task description, date scope,
completed operations, coverage limits and usage counters. It is not a reasoning
transcript. Attachments and linked pages are excluded.

For an unbounded request such as “summarize all my newsletters,” Chat is instructed
to ask for a period. Relative periods such as “last two months” already specify
the scope and do not need another clarification. Simple rolling day/week/month
periods get a local date hint; other wording is interpreted by the model. A rejected
tool request can be corrected without being mistaken for a completed search.
The worker requires valid dates and permits at most 90 days
per remote window, including an older period. Newsletter lookup matches the non-empty List-ID identifier marker (`<`) as a
candidate signal; senders without that header are outside this heuristic. Remote
search walks at most 500 UID positions per command and returns at most 20 headers
per page. This deliberately conservative fallback may not reach older messages;
it reports partial coverage, never an exhaustive not-found result. Search pages
remain frozen within the conversation, including after reconnecting.

The account worker owns the investigation. One reply can run at a time across
terminals. **Esc Stop reply** cancels it; **Ctrl+B Back to inbox** leaves it running.
**F4 Details** remains available during work, and Esc closes Details without stopping
the reply. Detaching a terminal does not cancel the worker; worker restart does not
automatically replay an interrupted request. Retry is explicit.

**Enter** sends; **Tab** switches input/conversation. **F2 More** includes scope,
details, sources, New chat, Retry reply and save recovery. **Ctrl+N** asks before
clearing the current conversation; **Ctrl+R** retries a failed reply. Ordinary
letters and punctuation stay editable text. Current conversation, citations, draft,
caret and scroll autosave locally in the encrypted store. A save failure retains
unsaved text and offers Retry save; stale terminals cannot overwrite a newer draft.
There is one current conversation per account/mailbox, not a history browser.

Limits apply to Ollama and hosted models alike. Each reply allows at most eight
model generation attempts, six remote searches, 100 header requests, 20 body
requests, 5 MiB of requested body data and 120 seconds. A conversation shares caps
of 24 attempts, 12 searches, 200 headers, 40 bodies, 10 MiB and 300 seconds across
follow-ups and retries. A rolling hourly account backstop allows 48 generation
attempts, 80 bodies and 20 MiB, including cancelled/failed attempts; New chat does
not reset it. There are also cumulative input-character limits (120k per reply,
240k per conversation, 480k per hour), a 24k evidence budget and a 36k user-context
budget per call. These are resource bounds, not exact token or price guarantees.
The last two of eight model turns are reserved for an answer and, when needed,
one correction. Input, time and cumulative allowances can end retrieval earlier.
If too little allowance remains to search and no evidence or successful search
result exists for this reply, Chat stops locally without another model call.
It identifies the limiting allowance in the message and F4 Details. For a
conversation limit, use F2 More → New chat (confirms before clearing the current
conversation); for the hourly limit, wait for the displayed renewal time.
Chat summarizes supported findings with partial coverage instead of continuing
to search. If answer validation still fails, the conversation keeps a labelled
collection of retrieved summary/original excerpts and keyboard-accessible sources;
unsupported model prose is not published. Details identifies the validation failure.
Mailbox search failures retain safe IMAP error codes in Details and are never
reported as an empty search or hidden behind a later citation error. With no
content evidence, Chat stops immediately; with saved evidence, it can give a
partial answer labelled “Inbox search failed.” Raw IMAP commands and responses
are not logged. Chat does not retry provider errors automatically.
These caps are local to this account/store, not a provider-wide spending limit.

Chat's retrieved-mail cache is separate from unread analysis: at most 250 records
and 32 MiB, with up to 60k decoded text characters per original and 256 KiB of
requested MIME text per message per conversation. Current source references pin
cached originals. Other records can be evicted; retained mail is not an archive.
Fetching for Chat never starts classification or changes unread review counts.

An explicit “Mark those emails read” request retains the separate confirmation
flow. Only messages already eligible in the existing analyzed review pool can be
changed; newly retrieved messages are read-only in this version. The app verifies
mailbox outcomes and never silently applies part of a mixed selection. Mark unread,
sending and deletion through Chat remain outside scope.

`./inboxtop --demo` exercises fictional Chat without mailbox or model requests.

## Two modes, one persistent pool

- **Ad hoc:** choose how many *additional* messages to analyze, oldest first by default. Newest first and custom counts are available. Completed emails do not consume the batch allowance.

  Choose **n New analysis** near the top of the main screen. This Ad hoc-only panel groups **Batch size**, **Order**, and **Start analysis**. Move between controls with ↑/↓ or Tab, change values with ←/→, and press Enter on Batch size to type a custom amount. Select **Start analysis** when ready. Starting returns to the main dashboard; existing recommendations remain available throughout.

  Choose **Start analysis** to select a fresh batch. **Stop analysis** saves completed results and discards unfinished batch membership. Unfinished emails remain in the ordinary unanalyzed pool; there is no saved queue or Resume action. A later batch uses its newly selected count and order, skipping completed results.

  The overview groups counts, sync status, and analysis progress around the coverage bar. The unread summary has its own section; press **v** to read it in full. The current mode sits at the top right. On the overview, **m** or a click focuses it, revealing a highlighted **‹ Ad hoc ›** or **‹ ● Live ›** selector. **←** selects Ad hoc, **→** selects Live, and **Enter** or another click switches modes. Active Live mode shows a green **● Live** indicator.
- **Live:** analyze all unread mail oldest first, then incoming mail. Completed results are reused. Mailbox membership is checked every 30 seconds, even during analysis. Large backlogs are processed in successive batches of 100.

Choose the mode on the overview. Mode and pause state persist. Switching modes does not change read flags.

The real terminal connects to a private background worker. Closing the terminal detaches the UI; requested work continues. **Stop analysis** stops current and automatic analysis and returns Live to Ad hoc. On worker restart, Ad hoc stays idle; Live selects fresh oldest-first batches from remaining unanalyzed unread emails. Opening this version gracefully upgrades older background workers, preserving saved results.

On macOS, choosing Live registers a per-user launch agent that restarts the worker after login or a crash. This requires a saved secure profile or an explicit complete legacy configuration file; keys are never copied into the launch-agent plist. On other systems the detached worker survives terminal closure, but automatic login startup is not installed. Quitting the fictional demo stops its in-process work.

The worker owns IMAP, model requests, and encrypted storage. Multiple terminal clients and the optional menu companion share the same local API.

## Overview and recommendations

Coverage separates:

- **Ready:** completed recommendations, including messages needing manual inspection. Routine mail needs only classification; important mail also needs its detailed summary.
- **Not analyzed:** every unfinished unread email, including those that still need a summary.

All counts refer to the unread pool, including previous batches. While a batch runs, its completion bar and classification/summary counts appear separately. Stopped batches have no pending queue. Unknown totals are shown as unknown until IMAP synchronization completes.

The overview summary is a short personal briefing: how many messages need action, what the important requests are about, worthwhile reading and newsletter issues, and how many emails can be marked read. Counts come from the same outcomes as the review screens. Related messages are grouped by topic; unread notices are not assumed to represent unresolved problems or current urgency.

It combines saved findings across the analyzed unread pool, without rereading original emails. It is cached and regenerated after changes, using bounded groups of findings for large inboxes. While synthesis is unavailable or running, the overview shows a local summary. Prose referring to a message that left the pool is hidden immediately. Press **v** to expand or **r** on the overview to refresh the briefing from saved results. Refreshing does not start an email-analysis batch.

The main dashboard always shows:

| Group | Recommendation |
|---|---|
| Act | A reply, approval, payment, or other action needs attention |
| Read | Information worth reading, with a summary |
| Low priority | Routine mail; Select all then Mark read acts on the displayed list |
| Check manually | The available evidence does not establish a useful next step |

An unknown sender type or uncertainty about whether an old request was handled does
not automatically require manual classification. A supported action stays in Act;
useful informational content stays in Read. Partial coverage is still shown and
never qualifies an email for Low priority. Existing saved actions and reading
recommendations benefit from these routing rules without new model calls; legacy
ambiguity and unresolved classifier disagreements remain protected.

Analysis uses one classification request and, unless the entire email is confidently
routine, at most one detailed review. That review receives the classifier's concerns
and makes the final decision; there is no disagreement-review loop. Input removes
redundant whitespace, retaining original mail locally. Long bodies use a bounded
24,000-character beginning/end excerpt, explicitly labeled incomplete. Evidence must
match both the visible excerpt and original text. Recoverable HTTP failures retain
the existing limit of two retries; invalid output is not automatically regenerated.

Failed analyses are **not analyzed**, outside the four recommendation groups. Their
count is visible on the dashboard: **! View** opens the failed-email list, and
**Shift+R** retries failures. Both commands are also in More. Opening the app does
not reanalyze saved emails; unresolved initial classifications receive their missing
detailed review when a new analysis batch includes them.

The overview has two states: **analyzed** and **not analyzed**. Preliminary classifications that still need deeper review count as not analyzed. Batch progress appears separately only while analysis is running. The stronger model's final findings determine the destination. Opening a group freezes its membership and order. New completed findings appear behind a **g Load results** indicator; they never silently join a bulk selection.

Original email text supports selection without rebuilding the preview on click. Web URLs are native terminal hyperlinks (Cmd-click in supporting macOS terminals; the gesture depends on your terminal). Press **Shift+L Links**, choose with arrows and press Enter to open a destination in your browser. Esc closes the picker and keeps your reading position. Links are also available in More and in originals opened from Chat.

Reading a message here does **not** mark it read. **Mark read** (or **x**) immediately starts a verified read update for a single email. The email stays open and the same button becomes **Mark unread**. After moving on, **z Undo last read** restores the last single change. You can mark other emails while a write is pending: they queue in the worker, with
**Updating** or **Queued** shown on each pending row. Queued reads use verified batches of up to 50;
repeat requests for a pending email are ignored. Each email retains its own verified result and undo record. Bulk changes still require a selection confirmation.
The queue continues after closing the terminal, but unsent requests are not replayed after a worker restart. An email read in another client leaves the pool on synchronization. If its reader is open, the text stays visible with a read-status notice until you leave it. Undo verifies server state before restoring unread status.

## Terminal navigation

| Key | Action |
|---|---|
| ↑ / ↓ | Move through the list, or scroll the focused email pane |
| → / Enter | Focus the preview below the list at every terminal size |
| ← | Return to the list |
| Tab / Shift+Tab | Switch list and preview; return to the list from an expanded reader |
| c | Clear the email selection in a review list |
| c on the dashboard | Open Chat with saved mail and automatic bounded inbox access |
| o | Toggle App review / Original without changing focus |
| e | Toggle between the email preview and full-screen reader; Esc also returns |
| d | Show/hide “Why this recommendation”: reasoning, review coverage, and quoted evidence |
| + / − | Give the preview more / less height |
| [ / ] while reading | Previous / next email in the current queue; disabled at either end |
| Cmd+Up / Down, or Home / End in the list | Jump to the first / last displayed row; Cmd requires the terminal to forward the shortcut |
| Page Up / Down, Home / End in the preview | Scroll longer messages |
| Space | Select or deselect an email |
| a | Select all unread emails in the displayed list; visible in every review list |
| x | Immediately mark one email read/unread; multiple selected emails open bulk confirmation |
| z | Undo the last single mark-read action |
| Enter in confirmation | Apply exactly the confirmed selection |
| g | Refresh the labeled content: email list or newsletter digest |
| 1–4 in results | Open a recommendation group |
| l | Newsletter senders and combined digests |
| p | Stop analysis and return Live to Ad hoc |
| r | Refresh the inbox summary on overview screens, or re-analyze the current email in review; also available in the preview command bar (clear bulk selection first) |
| Shift+R in a message list or reader | Retry failed reviews; offered in More when failures exist |
| / | Search sender or subject |
| s in a message list | Change importance/newest/oldest review order |
| u / t / i on the dashboard | Sync inbox / change time period / open inbox map; discoverable in More |
| ; on the dashboard, message list or reader | Open the command menu; arrows choose, Enter runs, Esc closes |
| h | Verified changes and undo |
| , | Provider/model/language settings |
| Esc | Back one level |
| q / Ctrl+C | Close the terminal |

Review and Subscriptions keep scope, Search, Sort and new-results notices above the
list. **Backspace** clears an active search. Original/Review and Expand/Collapse
stay beside the preview title; subscription groups show Read digest there.
Mark read, selection and Re-analyze stay in the bottom dock, with navigation below.
Switching pane focus does not move the view controls. **; More** exposes all
commands through arrows and Enter. Mouse and keyboard share the same availability
and confirmation checks. Re-analysis status also appears in the preview heading.

You can request another email review or subscription summary while analysis is busy.
Requests run one at a time after the current batch, in request order. **Queued**
identifies waiting targets; **Generating** / **Re-analyzing** identifies active work.
Duplicate requests do not add another job. Each summary keeps its requested issue
set even if you switch Unread/All analyzed or new emails arrive. **p Stop** cancels
active and queued reviews; Back only navigates. Mailbox writes interrupt the active
review without replaying it and hold waiting requests until the writes finish.
The queue belongs to the worker: closing the terminal keeps it running, but worker
shutdown cancels it. Restart never automatically replays paid requests. Completed
results remain saved; failures stay visible on their target for an explicit retry.

The dashboard also has **; More**, for Sync inbox, Time period, Inbox map,
history/undo, summaries, sender statistics and settings. Esc closes the menu
without changing your place. **, Settings** stays directly accessible.

Selection has the same scope everywhere, including the expanded reader: **x marks
selected emails read**, or the current email when nothing is selected. The bar
shows the count. **c** clears selection; bulk marking shows a short confirmation in the bottom command area.
**Enter Confirm** applies that exact selection; **Esc Cancel** returns to the same
position and selection so you can adjust it. Once confirmed, marking continues in
the background: Esc goes back and you can keep browsing. Progress stays visible;
conflicting write and analysis actions remain disabled until it finishes.
All review lists keep Select all visible in list context. To mark the displayed list read,
press **a Select all**, then **x Mark N read**. A read row remains until you move to another email, and its button
changes to Mark unread. After moving away, **z Undo last read** becomes visible
when no bulk selection is active. It is also available in More.

Messages use one row with aligned sender, subject and date. At every supported terminal size, a preview
below the list shows a short Action (when there is a concrete task) and Summary.
The heading says **Review** for app analysis and **Original** for sender text.
Explanation and quoted evidence are available with **d** or through More. Focus is
shown by a subtle marker on the current area's heading. Tab switches list/preview;
there is no separate action-button focus mode. Narrow or short terminals keep both the list and preview, with smaller panes and wrapped text.
**e** explicitly expands/collapses the reader, and Esc also returns. The minimum size is 40×18. Below 65 columns, category tabs use two rows,
message lists omit the date column, and controls wrap within the bottom bar.
Focus, scroll position and the selected email survive updates and resizing.

The app follows your **terminal's theme**, independently of macOS/system appearance.
It selects one fixed light or dark app palette, including during startup; it does not
copy the terminal’s background or color palette. Supporting terminals update the app
when their light/dark mode changes. Detection never delays startup; terminals without
mode reporting use `COLORFGBG`
when available, otherwise the dark theme. Active text edits finish before recoloring.

## Subscriptions

Choose **Subscriptions** on the main dashboard, or press **l**. Recognized, analyzed
subscription emails are grouped by sender address. The scope selector above the
list (**t Show**) switches between
**Unread** (default) and **All analyzed**, including retained read issues.
All analyzed means mail saved in inboxtop, not your entire mailbox archive; retained
read history is bounded. Emails awaiting analysis and failed reviews are excluded.
Counts show unread issues and total issues in the current scope. **s** cycles
**Latest issue** (default), **Issue count**, and **Name** sorting.
The selected sender stays selected when sorting or new results update the view.
Changing scope clears selection; Select all and Mark read target only unread issues.

All review lists share **Space Select/Deselect**, **a Select/Deselect all** and
**x Mark read** (or **Mark N read** when emails are selected). In the sender list, selection covers each sender's unread issues;
partial selections show `[-]`. Search limits bulk actions to the displayed results.
Marking a group or batch read uses the same inline confirmation before making any mailbox changes.

The lower preview shows one combined AI summary of the sender’s issues in the selected
scope, connecting shared themes and highlighting substantive issues by subject and
date. It can be longer than the inbox briefing. A compact list of originals follows it.
Use **Tab / →** to scroll the preview or **v Read digest** to expand it. Narrow terminals keep the digest below the list; **v** explicitly opens it full-screen. **Enter Open issues** shows that sender's
issues; opening one displays its original email. Click an issue heading in the digest
to open that original directly. Esc returns through the issue list to the sender list.

Browsing, opening issues and switching scope use saved results without model calls.
The digest covers exactly the issues in the selected scope. Use **g Generate summary**
from the sender list or expanded digest to combine saved summaries. This does not
re-analyze the emails or fetch linked articles. Until then, individual saved summaries
remain readable. Each exact issue set has its own cached digest, reused on later visits.
New issues or updated analyses make Generate summary available again. Large groups
use bounded batches before producing one combined summary.

## Configuration and models

First launch opens onboarding when configuration is missing. Run `./inboxtop setup`
or choose Settings → **k Email / API credentials** to reconnect. Enter passwords
and API keys in masked fields; Save uses the OS credential store. See
[setup and storage](SETUP.md).

Advanced users can still copy `.env.example` to a private `.env` or supply an existing file:

```sh
./inboxtop --env /absolute/path/to/config.env
```

Without `--env`, a saved secure profile takes precedence; otherwise configuration comes from `.env` in the working directory and environment overrides. An **explicit `--env` file is an isolated configuration**: inherited configuration variables, including Bun's automatically loaded `.env`, cannot supply or override its account or credentials. Include the complete account/provider configuration in that file.

Required IMAP variables: `EMAIL_ADDRESS`, `EMAIL_PASSWORD`, `IMAP_SERVER`. `IMAP_PORT` defaults to 993; TLS is required. The app works with INBOX.

- OpenAI: `OPENAI_API_KEY`; `OPENAI_MODEL` defaults to `gpt-6.1-sol`. Every selected email first uses `gpt-6-luna` through Decisions. Only important/potentially important messages reach the detailed model automatically.
- Ollama: `LLM_PROVIDER=ollama`, `OLLAMA_MODEL`, and optional `OLLAMA_CLASSIFIER`. Both local models default to `qwen3.5:4b`. The service must be on a loopback address (`OLLAMA_API_BASE`, default `http://127.0.0.1:11434`). Cloud-backed models are rejected; there is no cloud fallback.
- `INBOXTOP_DATA_DIR` changes the encrypted store location.

Use **Settings** to choose the provider, classifier (Ollama), detailed model, and analysis language. First-pass excerpt size is under **Advanced**. Saved settings override environment defaults on restart. They apply to new work; completed recommendations remain saved even after changing models. Stop active processing before saving settings. The provider test uses a fictional receipt and does not save your changes.

Settings groups fields into **AI** and **Preferences**. Fixed information is muted
and skipped by keyboard navigation. **↑↓ / Tab** moves through fields and buttons;
**Enter** opens a choice or editor. Help follows the focused field. **s Save changes**
and **t Test provider** stay in the bottom dock. Changes remain a draft until saved;
Esc cancels the current edit, then offers Save / Discard / Keep editing when leaving
with unsaved changes. Failed saves preserve the draft. Ctrl+C exits after saving Chat; it does not save uncommitted Settings edits.
Ollama's two model fields each offer installed models, manual tag entry, and Refresh.
Install a missing model separately with `ollama pull MODEL:TAG`; the chooser never
downloads models. OpenAI's detailed-review field accepts an exact API model ID;
its classifier is fixed. Press **?** in Settings for these instructions.
Sender statistics is available in a review screen's **; More** menu (**Shift+S**).

Inbox briefings are two or three short sentences highlighting the most important topics, normally 40–60 words. The four category controls provide the detailed breakdown. Both overview screens share the same coverage and summary section. Summaries grow to fit up to six lines on standard terminals, with scrolling only for overflow; press **v** to expand or **r** to refresh it. The saved-findings fallback also stays compact.

Analysis language defaults to **English**; choose **Russian** in Settings → Analysis language, then **Save changes**. The choice applies to new email summaries, suggested actions, reasons, inbox briefings, and combined newsletter digests with either OpenAI or Ollama. Original email text, exact evidence quotes, and literal deadline wording stay unchanged for verification. Interface controls remain in English. `ANALYSIS_LANGUAGE=en` or `ru` supplies the initial default.

Changing language keeps completed email reviews intact. Open an email with **e**, then press **r** to regenerate its review in the selected language. Press **r** on the inbox overview to refresh the inbox briefing from saved findings; request a newsletter digest again to generate it in the new language. Summary and digest caches are separated by language.


OpenAI receives selected email content for classification/review and saved findings for synthesis. Ollama processing stays local. Generating a subscription summary sends saved findings for synthesis; browsing it makes no model calls. Explicitly retrying a message can request further analysis.

The terminal opens a loading screen before connecting to the worker. An animated indicator and elapsed time accompany the current startup step: connecting, updating or starting the worker, loading saved results, then preparing the inbox. Press **q** or **Ctrl+C** to close while loading. Startup errors stay visible until you close the screen; `--once`, `--watch`, and the background worker remain non-interactive.

## Persistence and local worker

Each message is identified by account, mailbox, UIDVALIDITY, and UID. Completed results remain attached to unread emails, regardless of batch, restart, model changes, or date. A fresh batch may reuse saved classification work, but interrupted batch membership is never resumed. Explicit re-review can replace a result. Old absolute deadlines are labeled as passed locally, without rereading the email through a model.

Unread results are never evicted at the former 1,000-message limit. Read history is bounded; recent changes retain identity for verified undo. A mailbox UIDVALIDITY change invalidates the old active membership rather than reusing unrelated messages.

Data uses authenticated AES-256-GCM encryption and atomic replacement under `~/.local/share/inboxtop-terminal/<account-hash>/`. Files and keys are owner-only. The key lives beside the cache, so encryption does not protect against someone with access to your user account. Credentials are not stored in the cache. Only the worker owns the account store's write lock.

IPC uses an owner-only Unix socket in an owner-only `/tmp/inboxtop-<uid>-<hash>/` directory, with validated commands. Email content travels only over that local socket to the terminal. `GET /ping` is a content-free health check; `GET /state` provides the local application state. There is no listening TCP port.

On macOS the launch agent is `~/Library/LaunchAgents/local.inboxtop.<account-hash>.<storage-hash>.plist`. It starts the current project's Bun executable and entry point with an absolute config path. Keep those paths available. Switching to Ad hoc stops automatic analysis but leaves the shared worker/service available for synchronization and later use.

## Headless use

```sh
./inboxtop --once                 # analyze remaining unread once; JSON counts
./inboxtop --watch                # enable Live and observe JSON counts
./inboxtop --demo --once          # fictional, no network
```

These commands attach to the same worker as the terminal. JSON contains counts and operational metadata, not subjects or bodies. Stopping `--watch` detaches the observer; use the terminal's Stop or Ad hoc controls to stop automatic analysis.

## Development and verification

```sh
npm run check
npm run preview
npm run test:terminal
```

Tests cover additional batches, analyzed-once persistence, pending classifications, failures, incoming/external-read synchronization, worker detach/reattach, the actual CLI over private IPC, explicit configuration isolation, aggregate-summary caching, stable selections, keyboard focus, responsive frames, and verified read/undo. Socket integration tests require local Unix-socket permission. Previews are in `docs/internal/previews/` at 120×36, 80×24, 65×18, 50×24, and 40×18.


UI changes follow [the shared terminal layout principles](../UI-PRINCIPLES.md), with row budgets in `src/ui/layout.ts`.


### Read-update performance check

`npm exec -- bun scripts/benchmark-read.ts` runs 100 fictional updates through the
real controller and encrypted store with a simulated 5 ms mail-server round trip.
Add `--single` to compare the per-email path. It never connects to a real mailbox.
Batches retain a saved pending receipt before the write and verify each UID afterward;
missing or uncertain results never become successful reads. Single-email requests
start immediately without waiting for a batch. During writes, terminal state is
polled every 100 ms; idle polling stays approximately 750 ms.
