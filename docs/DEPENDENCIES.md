# Dependency and model record

Pins selected 26 September 2026. Package licenses below were inspected from installed
package metadata/license files; this is not release-wide legal clearance. No agent
framework/controller source was copied. Review small dependency updates with the
same parser, schema and digest fixtures before merging.

| Component | Pin | Purpose / license / security and replacement boundary |
|---|---|---|
| Node | 26.5.0 tested | Development/controller runtime. The official `node-v26.5.0-darwin-arm64.tar.xz` archive was SHA-256 verified as `48231d6204eca6be13e6c5184dfdffa1d64ad88880364cc2cfb198f872cb2b13` and staged in an ignored ad-hoc app; its executable links only system libraries. The Homebrew build is not self-contained. Release signing, authenticated checksum provenance, full license notices, clean-Mac testing and security-update cadence remain B01/B27. [Official release directory](https://nodejs.org/dist/v26.5.0/). |
| Node `node:sqlite` | Bundled with tested Node 26.5.0 | Host-private attempt journal foundation; SQLite WAL and full synchronous commits avoid a new native npm package. The controller must use an app-owned local path, guard file access and qualify crash/update behavior. Replace behind `AttemptJournal` if the bundled runtime changes; this does not authorize execution by itself. [Node API](https://nodejs.org/download/release/v26.5.1/docs/api/sqlite.html). |
| Ajv | 8.20.0 | Draft 2020-12 schema validation, MIT. Compile only the bundled schema; no remote refs, coercion or provider schemas. Replace behind `decodeMessage`. |
| ajv-formats | 3.0.1 | Actual date-time assertions, MIT. Retain invalid-date tests on every update; same validator replacement seam. |
| jsonc-parser | 3.3.1 | Microsoft's parser exposes duplicate keys and bounded traversal before JSON materialization, MIT. Comments/trailing commas are disabled. Replace behind `parseJSON`; keep malformed-input tests. |
| Playwright | 1.63.0 | Managed Chromium driver and isolated browser tests, Apache-2.0. Exact npm lockfile and version-matched Chromium build are required; this driver uses a fresh temporary profile and a fixture-origin route restriction. Replace behind the browser adapter interface if needed. Browser binary redistribution, bundled licenses, security updates and clean-Mac packaging remain B01/B27 work. [Official browser/version guidance](https://playwright.dev/docs/browsers). |
| TypeScript | 7.0.2 | Development-only type checks, Apache-2.0. Exact lockfile; never required from end users. |
| @types/node | 26.6.3 | Development-only types, MIT. Runtime compatibility is tested separately. |
| jsonschema | 4.26.0 with format-nongpl extra | Independent Python test oracle, MIT. All resolved test dependencies pinned in `requirements-test.txt`; no Python authorization service is shipped. |
| Swift / Foundation / CryptoKit / Security / libbsm | Swift 6.4, macOS SDK supplied locally | Native digest and Unix-socket peer identity implementation using platform SHA-256, audit-token parsing and code-signing validation. No third-party runtime is added. SDK/build pins, release requirement policy and minimum app OS require qualification. |

`npm install --ignore-scripts` was used. Playwright 1.63.0 was added from the
local npm cache; an existing version-matched Chromium/headless-shell build was
used for tests, so this slice did not download a browser. A lockfile records registry integrity; no
postinstall scripts are required. The initial npm audit reported zero advisories;
this is time-specific dependency evidence, not an application-security certificate.
Python dependency hashes and a complete distributable SBOM remain release work.

## CLM is still the primary model

- Reference source: https://github.com/Contrastive-LM/CLM/tree/bb42c6c5bf914fd449bed2f6ca65be80602cb1f7
- Head repository metadata revision: `e939398d4556fcd9400c76fa8c5a513202f42b0a`.
- Published head SHA-256: `b2b4a8c9c2d39263eff78a351eb909a342ce9b3bf21a3f07c1d1bf15f1c4eda5`.
- Encoder recipe: Qwen/Qwen3-8B, last-token 4096-dimensional embeddings,
  normalization before and after independent checkpoint-configured heads; source
  defaults to a 2048-token per-text limit. Exact tokenizer/encoder artifact revisions
  and the downloaded checkpoint contents are not verified yet.

The model card asserts Apache-2.0; review the exact encoder/head artifact licenses
before distribution. No weights downloaded, inference run or runtime selected.
Qualify safe loading, immutable artifacts and full serialization/token budgeting
in B01/B02. Keep alternatives behind a separately qualified DecisionProvider; no
provider substitution or external fallback is authorized by this manifest.
