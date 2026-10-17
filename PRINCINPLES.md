# Principles

What inboxtop is built around. Every change is checked against these principles;
when two pull in different directions, the earlier one wins. This is the main
reference for future functionality, design and implementation decisions.
[UI-PRINCIPLES.md](UI-PRINCIPLES.md) says how the interface follows them;
this file says why. These are commitments to guide development, not a claim that
every current implementation already meets them.

## 1. Minimal: everything must earn its place

The inbox, the relevant words, the next useful action. Each addition costs
attention, resources and upkeep. A screen, setting, label, indicator or dependency
belongs only when it clearly pays for itself. Taking away is as valuable as adding.
Start with the smallest useful version and prove its value before expanding it.

## 2. Nothing distracts

Keep attention on the person's current task: understanding an email, reviewing a
group or asking a question. Use quiet structure and clear hierarchy. Color,
movement, borders and status messages must communicate something useful. Avoid
competing toolbars, repeated explanations and decoration that makes important
content harder to find. Background work must not steal focus or move the selection.

## 3. Keyboard-first

Design every interaction for quick, complete use from the keyboard. Every action,
source link, setting and confirmation needs a discoverable keyboard path. Use
consistent hotkeys, visible focus and accurate contextual hints. Mouse support is
an additional convenience. A workflow is incomplete until someone can finish it
and return to where they started without touching a mouse.

## 4. Never lose anyone's data

Treat emails, saved work, settings and user-written text as belonging to the person.
Preserve drafts, selections and reading position through navigation and resizing.
Persist promised work safely; storage formats, account identities and message IDs
are contracts that upgrades must respect. Changes to storage or retention need a
safe migration or recovery path, never a silent reset.

Make session-only state and bounded cache retention explicit before someone relies
on them. inboxtop's retained mail is not a complete archive. Moving an email out of
the unread view must not be confused with deleting it. Mailbox changes need a
deliberate user action, verified results and undo where it can be offered reliably.
Never turn an uncertain write into a claimed success or blindly repeat it.

## 5. Fewer clicks, fewer windows

Minimize keystrokes and context changes as well as clicks. Keep related work in one
place, make common actions direct, and let Back return to the same position.
Cycle simple values where that is clear; use a picker when choices need explanation.
Use one discoverable command menu for less common actions. Ask for confirmation
only when the action needs it, once, with its exact scope visible. Do not interrupt
ordinary reading with extra screens or change focus after a simple action.

## 6. Transparency

Say what is true and only that. Distinguish original email, AI interpretation and
verified mailbox state. Show what is loading, what completed, what failed and what
remains uncertain. Answers need inspectable sources and honest limits: retained
analyzed mail is not all mail, an unread notice is not proof of an outstanding task,
and no search match is not proof that an email does not exist.

Explain which provider processes email content, what stays local, what is saved
and what expires. Never silently switch providers or broaden an action's scope.

## 7. Clear to someone who has never seen it

The screen should explain where the person is, what they are looking at, what is
focused and what they can do next. Label actions by their actual effect and scope.
Make selected versus current email, AI review versus original, and back versus
cancel distinguishable. Put the relevant keyboard hint where it is needed.
Common tasks must not require guessing a shortcut, interpreting an unexplained
symbol or remembering instructions from another screen.

## 8. Works on every OS and terminal it can

Keep the core terminal experience portable across macOS, Linux and Windows.
Design and verify for different terminal sizes, keyboard capabilities, fonts and
light/dark themes. Adapt layout while keeping essential content and keyboard
controls available. Use readable fallbacks when a terminal lacks a capability.

Keep platform-specific integrations optional and isolated. Document tested support
and real limitations; never claim compatibility that has not been verified. An
optional macOS helper must not become a requirement for using the terminal app.

## 9. Ask first: what if we did not build it?

Building has visible benefits; not building often costs nothing. Every feature
adds something to learn, test and maintain. Ask whether removing friction from an
existing workflow solves the problem, or whether the usual email client already
does the job well. Build only when the value survives that question. Parking or
rejecting an idea is a valid product decision.

## 10. A hammer, not a jet engine

A hammer works for a lifetime, in any hands, with no one on call. inboxtop should
remain understandable and maintainable for years by a small team or one person.
Keep installation, storage and recovery straightforward. Use a local worker where
ongoing analysis needs one, and the mailbox and model connections the person has
chosen. Avoid introducing additional hosted services, infrastructure or fragile
dependencies without a need that the existing architecture cannot meet. Choose
formats and boundaries that let the app survive upgrades and provider changes.

## 11. The simplest, lightest solution

Prefer fewer lines, fewer concepts and fewer moving parts: light to start, light
to run and light to understand. No abstraction for a single use or configuration
for a decision already made. Reuse the current stack before adding a dependency.
Bound background work, model context and resource use. Measure before optimizing;
remove what measurement shows is unnecessary. A heavier solution needs a concrete
reason the lighter one cannot meet. Keep code small enough for a stranger to follow.

## 12. The right part for each job, one part for alike jobs

Choose a component by the job it serves. Use a list to browse, a preview to inspect,
an input to write, a picker to choose and confirmation to authorize a consequential
action. Prefer the existing OpenTUI Core components and shared layout rules when
they fit. Do not stretch an unrelated component simply because it already exists.

Where jobs are alike, share the component and behavior. Email lists reached through
Review or Subscriptions should differ in their content, not their controls. One
command definition should drive its shortcut, label, availability and mouse action.
Keep focus, spacing, scrolling, colors and Back behavior consistent throughout the
app so each new feature feels like part of the same product.

## 13. Use known patterns where they exist

Follow familiar terminal behavior: arrows navigate, Enter activates, Tab moves
focus, and Esc closes the current layer or goes back. Preserve normal text editing
and paste inside inputs; typed letters must not trigger unrelated commands.
Respect terminal and shell conventions and use portable shortcuts. Reuse a key for
the same kind of action, with its current target clearly labeled. Change an
established pattern only when there is a clear benefit and an understandable path.

## 14. Be creative where no pattern exists

When no good pattern fits, invent a small, coherent one. Judge it by whether people
understand it and finish the task more easily. Try it with realistic examples and
keyboard-only use, including narrow terminals. Keep what works and remove what
adds explanation without adding value. Novelty alone does not earn a place.

## 15. Nothing personal is counted, only how the product is used

If analytics are ever introduced, limit them to basic, aggregate product usage.
Do not collect email content, subjects, addresses, contacts, chat questions,
answers, credentials or other personal data for analytics. Avoid identifying or
tracking individual people. Keep collection transparent and optional. Apply the
same restraint to diagnostics and logs; use fictional mail in tests and demos.
Content sent to a chosen AI provider for a requested feature must remain separate
from product analytics and be explained clearly.

## 16. It just works

Whatever a person would reasonably try, expecting it to work, should work. Opening
the app gives immediate feedback. Long operations show progress. Navigation stays
responsive, cancellation means what its label says, and returning restores context.
Selections and action scopes stay stable while new mail arrives. Failures provide
an honest explanation and a useful recovery path. Verify complete workflows,
including empty states, errors, interrupted work and different terminal sizes.
Reliability is part of the feature, not a later layer of polish.
