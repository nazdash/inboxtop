# Contributing

Read [AGENTS.md](AGENTS.md), [PRINCINPLES.md](PRINCINPLES.md) and
[ARCHITECTURE.md](ARCHITECTURE.md). UI changes also follow [UI-PRINCIPLES.md](UI-PRINCIPLES.md).

Install dependencies with `npm ci`; run `npm run demo` using fictional mail.
Run `npm run check` before submitting a change. Tests do not need real credentials
or paid AI requests. Worker tests need local Unix-socket permission.
For UI changes, run `npm run preview` and `npm run test:terminal`, and verify
keyboard-only use at 40×18 as well as standard sizes. Keep Back, focus and drafts stable.

Use focused changes that explain the problem, resulting behavior and validation.
Do not silently reset storage or change account/message identity. Protect existing
data during upgrades. Mail content is untrusted; mailbox actions need explicit
user intent and verified outcomes. Scope changes require tests of the actual boundary.

Never submit personal mail, keys, `.env`, caches, screenshots of a real inbox or
full environment dumps. Main project documents belong in the root; supporting
public guides belong in `docs/`. Private plans,
future ideas, local research and generated output belong in ignored `docs/internal/`.
Never force-add internal files or make public instructions depend on them.
Use fictional fixtures for reports.

`npm run build` creates a standalone target-native executable. CI verifies macOS
and Linux candidates; passing on one OS does not establish support on another.
`npm run audit:release` is a supplemental privacy/secret preflight, not certification.
See [release preparation](docs/RELEASING.md) before making artifacts public.

## Proposing a change

Use a focused branch from `main`. For a larger feature, describe the user problem
and smallest useful change in an issue before implementation. A pull request should
explain behavior, verification and any compatibility implications. Review against
the product principles in their listed order. Do not add dependencies or infrastructure
without explaining why the current approach cannot meet the need.

CI scans history with pinned Gitleaks before native checks. Dependencies and action
revisions are pinned; Dependabot proposes updates for review. Passing CI is not
approval to publish artifacts or change supported-platform claims.

## Checking local model quality

Software tests use mocked model responses; passing tests does not establish model
accuracy. For an explicit, local-only comparison with installed Ollama models:

```sh
./node_modules/.bin/bun scripts/evaluate-local.ts --run tev1:4b,qwen3.5:4b qwen3.5:4b
```

This opt-in check uses nine fictional cases: receipts, approval, an old security
notice, Russian and Dutch requests, a newsletter, marketing, embedded instructions
and missing text. It runs classification and detailed review when needed, with at
most two generation requests per case and a 90-second case timeout. It never loads
mail, credentials or saved settings, downloads models, or calls a cloud provider.
The last argument is the text model used for detailed review for both classifiers.
Compare final categories, failures, latency and request size; inspect the fictional
summaries and next steps too. Character counts are not token usage. This is a small
regression sample, not an accuracy estimate for real inboxes or proof of safety.
Keep local reports in ignored `docs/internal/`. Do not change model defaults based
only on a passing software suite or this small sample.
