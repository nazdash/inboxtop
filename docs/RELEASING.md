# Preparing a release

The repository is not automatically published by CI. The Check and build workflow
runs tests, builds native candidates, exercises the actual terminal executable,
and uploads archives/checksums as workflow artifacts. Those are candidates, not
signed/notarized public releases. Native Windows is not a release target yet.

## Name and publication decisions

The product and command are named `inboxtop`, and its source uses the MIT license.
The repository is https://github.com/nazdash/inboxtop. Publish installation and
download links only for artifacts that have completed acceptance. Future renames must update package metadata and its lockfile,
launcher/help text, documentation, menu branding, artifact names and CI labels
together. Rebuild and verify the renamed artifacts; candidates made under the old
name are not evidence that renamed installation works.

Keep existing storage paths, credential-service identifiers, account hashes and
worker/service identities stable unless an explicit, tested migration preserves
existing profiles, credentials, reviews and Chat. A global text replacement of
the old name is unsafe. Display branding can change independently of these
persistent identifiers. Verify both a fresh fictional profile and an upgrade.

Source publication and binary distribution have separate gates. A public source
repository needs the chosen license, reviewed source/history, working contributor
instructions and a private security reporting channel. Downloadable binaries also
need target-native acceptance, native dependency redistribution review and the
platform signing checks below. Passing a local build does not satisfy those gates.

A GitHub repository with a clear README is sufficient for the first source release.
A GitHub Pages website is optional; it must link to the actual repository and
verified releases and accurately describe tested platforms. Do not add placeholder
download buttons or publish `docs/internal/` as the website. CI builds candidates
only; creating a repository, making it public and publishing releases remain
deliberate maintainer actions.

Before the first public release:

1. Verify that the MIT LICENSE and required third-party notices ship with the source.
2. Configure the repository URL, private vulnerability reporting and maintainer
   contact. Review public documentation and replace fictional screenshots only
   with other fictional screenshots.
3. Run `npm run check`, `npm run audit:release` and a dedicated secret scanner over
   the working tree and complete history. The supplemental audit reports locations
   only and detects a limited set of patterns; it cannot certify absence of secrets.
4. Review transitive dependency licenses and ship required notices. Ensure bundled
   native libraries, parsers, grammars, Bun and the keyring binding are accounted for.
5. Pass native CI and clean-machine setup on each advertised target, including a
   locked/unavailable credential store, cancellation and upgrade with existing data.
6. For downloadable Mac binaries, prepare Developer ID signing/notarization.
   This is optional for source-only publication. Current candidates use ad hoc
   signing where applicable; do not tell users to disable system security.
   No Apple signing credentials are stored in this repository.
7. Verify provider access with fictional content through onboarding using an
   ordinary API account. Documentation of an API/model is not proof of account access.
8. Create a reviewed release and attach verified archives plus their SHA256 files.
   Update the README with actual release URLs and only platforms that passed.

Local commands:

```sh
npm run build
# Optional, macOS only; use the directory emitted by build:
npm run build:menu -- --standalone dist/inboxtop-VERSION-darwin-arm64
npm run package:release
npm run verify:release
```

Keep the executable and optional `inboxtop Menu.app` together. The companion's
standalone runtime resolves that executable relative to the app bundle. Build on
each target so native assets match. Checksum archives after signing and packaging.
If artifacts change, rerun smoke tests and regenerate checksums.

For upgrades, stop analysis, keep local data/config/credential-store entries, replace
the installed bundle and reopen. Worker upgrades verify process ownership before
termination. Account hashes remain stable. Do not add an updater that resets or
silently migrates incompatible data. See [recovery](RECOVERY.md).

## Optional Mac signing and notarization

First finish the candidate build, companion build, packaging and verification.
The following prints a plan without accessing certificates or sending anything:

```sh
npm run prepare:mac-signing -- dist/inboxtop-VERSION-darwin-arm64 --notarize
```

For a real signing run, install your Developer ID Application certificate in your
own Keychain. Store notarization credentials interactively with
`xcrun notarytool store-credentials` and use its named Keychain profile. Never put
passwords/private keys in shell arguments, this repo or chat. Set `MAC_SIGN_IDENTITY`
to the certificate's SHA-1 identifier and `MAC_NOTARY_PROFILE` to the profile name;
these references are not passwords. Add `--execute --notarize` only when ready to
submit that candidate to Apple. Omitting `--notarize` prepares a signed, unnotarized
DMG for local testing.

The script copies the candidate, signs the terminal with Bun/OpenTUI runtime
entitlements and the native helper without those entitlements, checks signatures,
runs fictional terminal tests, notarizes/staples the helper when present, builds a
DMG, then signs/notarizes/staples the DMG and creates its checksum. Input archives
stay unchanged. Existing output images are never overwritten. No certificate is
exported, no GitHub upload occurs, and Apple rejection stops preparation.

A DMG can carry a stapled ticket; a bare command-line executable cannot. Keep the
final DMG/checksum together and test the browser-downloaded artifact on a clean
Mac. The runtime uses JIT/FFI and bundled native modules: the terminal entitlements
are separate from the much smaller native helper. Ad-hoc runtime testing is not
proof of Developer ID or Apple acceptance.

References: [Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
[Bun executable signing](https://bun.sh/docs/bundler/executables#code-signing-on-macos).

See [acceptance walkthrough](RELEASE-ACCEPTANCE.md) and
[dependency inventory/rebuild notes](DEPENDENCIES.md). The source archive is a
required companion to our binary candidates; native redistribution review remains
separate from selecting this project's license.

## First publication gate

Keep the repository private during preparation. Before making it public, review
the exact files in the first commit, scan the tree and all history with Gitleaks,
and confirm that credentials, personal mail, local research and `docs/internal/`
are excluded. Confirm a private security reporting route is actually enabled;
GitHub may not offer private vulnerability reporting until the repository is public.
Do not claim it is enabled based only on SECURITY.md.

The main branch is `main`. After the first push, verify native CI results, then
configure branch rules to require review/checks where the account plan supports
them. Keep Actions workflow permissions read-only; no workflow in this repository
automatically publishes a release. The secret-scanning job uses a pinned upstream
Gitleaks archive with an explicit SHA-256 digest; update both together after review.

Local source/build checks do not replace a fresh-person credential/setup walkthrough
or native acceptance on other platforms. Complete source publication separately
from signing, native redistribution review and public binary releases.
