# Pending release dependency inventory

Reconstructed 1 October 2026 from `codex/clm-artifact-preflight` at `3b6c6a8`.
The cloud snapshot had no pending inventory, stash, unreachable implementation
commit or remote inventory branch. This is release preparation for B01/B27;
neither ticket is complete and the owner goal remains stopped.

The reviewable [JSON inventory](release/dependency-inventory.json) records every
npm lockfile package, including transitives and optional platform-specific build
tools. There are **32 npm records: nine runtime and 23 development records**.
The 19 exact Python requirements are test-only and not shipped. Their artifact
hashes and individual licenses remain explicitly pending. npm license identifiers
come from lockfile metadata; full text notices and legal clearance are pending.
In particular, transitive `fast-uri` is BSD-3-Clause, not MIT.

[Non-npm declarations](release/dependencies.pending.json) cover the official
Apple Silicon Node archive, Node/system SQLite, both copied Playwright Chromium
builds, macOS frameworks and on-device speech assets, the mandatory Chrome
extension/native host, and excluded optional model/perception modes. Node's
published archive pin and earlier Mac verification are recorded as prior
evidence, not as a new verification of this release's bytes. Browser revision
1243 / version 153.0.8010.12 is checked against installed locked Playwright
metadata. Browser byte hashes and third-party notices remain unresolved.
Google Chrome is user-installed and its existing profile remains mandatory scope.

CLM declarations are read from the existing pending preflight manifest. The
published head hash is upstream metadata, not proof of downloaded bytes.
Unresolved encoder/tokenizer pins, file hashes, server/container identities and
license review stay unresolved. No model files, private profiles or credentials
are read, downloaded or included by the generator.

## Regeneration and validation

With the repository's pinned Node 26.5.0:

```sh
npm ci --ignore-scripts --cache /tmp/systemone-npm-cache --no-audit --no-fund
npm run inventory:write
npm run test:release-inventory
git diff --check
```

Review the generated diff before committing it. Generation uses only local
source and installed Playwright metadata; it performs no network calls and
does not execute package scripts. SHA-256 source fingerprints and exact sorted
records make the output repeatable without timestamps or machine-specific paths.
`inventory:check` rejects stale output without rewriting it. Generation rejects
unlocked direct dependencies, missing npm integrity/licenses, unpinned Python
requirements, Node bundle drift and browser metadata drift. It validates source
consistency; it does not hash an installed app or establish provenance of its
running code. The npm integrity values are expected archive hashes, not claims
that the generator verified installed package files.

## Remaining release evidence

Collect full license/NOTICE texts for all distributed npm, Node and browser
components, expand native transitive components into an artifact SBOM, and bind
it to the exact signed distribution. Qualify authenticated downloads, browser
checksums, dependency advisories/security updates, SDK/OS pins, Chrome delivery,
enabled model/privacy modes, notarization, and clean-Mac install/update/rollback.
This custom source inventory is not a complete SPDX/CycloneDX distributable SBOM.
The [v1 gates](V1_READINESS.md) and [validation](VALIDATION.md) remain authoritative.
