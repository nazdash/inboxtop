# Vendored upstream licensing information

`BUN-LICENSE.md` is an unchanged copy of the Bun 1.4.3 upstream licensing overview:
https://github.com/oven-sh/bun/blob/bun-v1.4.3/LICENSE.md

Tag commit: `c6da4a4d3010e5553438c60f6bd76d981976867c`.
It describes Bun's own license, linked libraries and JavaScriptCore rebuilding.
It is not the license for this project and is not a full set of native-library
license texts. See [dependency review](../docs/DEPENDENCIES.md).

Builds collect installed npm license/notice files, including suffixes such as
`LICENSE-WUFFS`, into THIRD-PARTY-NOTICES.md. DEPENDENCIES.json preserves package
versions, npm integrity digests and notice-file digests. Update this upstream
snapshot and repeat the review when changing the pinned runtime.
