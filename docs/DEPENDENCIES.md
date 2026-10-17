# Dependencies and redistribution

This project uses pinned npm dependencies and a pinned Bun runtime. inboxtop's own
source is licensed under [MIT](../LICENSE); third-party components keep their
respective terms and notices.

Each binary candidate includes `DEPENDENCIES.json`, `THIRD-PARTY-NOTICES.md`,
`BUILD.json` and `SHA256SUMS`. The dependency inventory covers installed runtime npm
packages and Bun, including packages that bundling may remove. It is not a complete
SBOM of statically linked C, Zig or Rust code. `BUILD.json` records the runtime
revision, target and hashes of publishable source files without personal paths.

## Review findings for the pinned versions

- OpenTUI 0.6.0 supplies native notices for Ghostty, LCMS2, libwebp, STB and Wuffs.
  The collector includes all `LICENSE-*` and `NOTICE*` files, not only `LICENSE`.
  Its JavaScript parser/runtime dependencies have their own collected notices.
- Mail parsing and IMAP dependencies include alternative/dual license declarations.
  Preserve all supplied terms; an `OR` choice does not mean both licenses must be
  applied simultaneously. This inventory does not choose the application's license.
- Bun 1.4.3 reports MIT for Bun itself, but statically links JavaScriptCore/WebKit
  under LGPL terms and other libraries under their own terms. The pinned upstream
  overview is bundled in `third-party/BUN-LICENSE.md`. Do not label the entire
  executable “MIT-only.” Follow the upstream source/relink instructions:
  [Bun license](https://github.com/oven-sh/bun/blob/bun-v1.4.3/LICENSE.md).
- `@napi-rs/keyring` 2.0.0 and its platform package declare MIT. Its tagged source
  contains Cargo.toml but no Cargo.lock, so npm's lock/integrity alone cannot tell
  us the exact transitive Rust revisions used in its prebuilt binary. The platform
  adapter inherits the binding's LICENSE text in our inventory. Upstream provenance:
  [keyring source](https://github.com/Brooooooklyn/keyring-node/tree/v2.0.0).

## Matching source and rebuilding

`npm run package:release` creates a source archive alongside binary archives. It
uses Git's publishable file list, excludes ignored local data, rejects tracked
private files and refuses packaging when source hashes differ from the build.
It includes public `docs/` files, but never copies `.env`, `docs/internal/`,
installed dependencies or repository history.

Extract the matching source archive, run `git init` (archives omit Git history),
then `npm ci`, `npm run check` and `npm run build`. Git is required for the
publishable-source inventory; a normal repository clone already has it. `npm run build:menu -- --standalone DIST_DIRECTORY` adds the
optional Mac helper. Python 3.11+ is needed for release verification. Build on the
target architecture with its native dependencies; signing is a separate operation.
For a modified Bun/JavaScriptCore runtime, follow the pinned Bun instructions and
run `scripts/build.ts` with that locally rebuilt Bun instead of the npm runtime.
The build records the runtime actually used.

## Binary-distribution review still needed

Generated notices are evidence, not a legal compliance certification. Before
advertising standalone binaries, account for the full linked Bun libraries,
bundled parser grammar sources and the keyring binary's transitive Rust licenses;
obtain reproducible upstream provenance or rebuild components if necessary.
Verify that corresponding-source/relink materials and all required notices are
provided with the actual distribution. This does not prevent publishing the source
project once its own license is chosen. Do not hide unresolved native provenance
behind a passing npm license scan.
