# Draft PR publication material

Head: `codex/release-dependency-inventory`
Base: `codex/clm-artifact-preflight` (draft #66), starting at `3b6c6a8`.
Title: `Add pending release dependency inventory and drift validation`

Publication is pending because this runtime denies GitHub API requests with
HTTP 403. The environment draft includes the required network additions for
user review. Native HTTPS Git access works; a pushed branch alone is not a PR.
Implementation commit `1673db7` was pushed and verified on the remote. The actual
draft creation attempt failed at `https://api.github.com/graphql` with 403.
After applying the network settings, check API access and reuse the existing
injected GitHub authentication. Do not create a duplicate PR if one exists.

## PR body

The existing dependency record lists direct pins but lacks a complete pending
release inventory. This change enumerates all 32 npm lockfile packages (nine
runtime), 19 Python test dependencies, and Node/browser/platform/Chrome/model
declarations. It preserves unresolved artifact hashes, model pins and license
reviews rather than asserting release clearance.

The generated JSON includes source fingerprints, exact versions, npm integrity,
licenses, dependency edges and platform/scope flags. Offline generation and
check commands reject stale output, manifest/lock drift, missing npm integrity
or license data, unpinned Python requirements and Node/browser metadata drift.
README, handoff, readiness, status and validation describe the final scope.
This is source inventory preparation for B01/B27, not a distributable SBOM.
The owner goal remains stopped; release and Mac gates remain open.

Validation: pinned Node 26.5.0, frozen npm install with scripts disabled;
inventory consistency and six focused tests passed; typecheck and
`git diff --check` passed. Broader suite: 338 passed, 25 failed, two Mac-only
skips (365 total), because pinned browser executables were unavailable and
their dependent controller tests timed out. Official Playwright downloads
were blocked with 403. Full-suite green remains pending network access and
browser installation; no live Mac/model/owner-profile qualification is claimed.

## Publication command

Write the text under **PR body** above to a temporary UTF-8 file, then run:

```sh
gh pr list --head codex/release-dependency-inventory --state open
gh pr create --draft \
  --base codex/clm-artifact-preflight \
  --head codex/release-dependency-inventory \
  --title 'Add pending release dependency inventory and drift validation' \
  --body-file /tmp/systemone-release-inventory-pr.md
```

After publication, record the actual draft PR URL in handoff/status/validation.
Install version-matched official browser assets and rerun `npm run check` before
replacing the current failure evidence. Keep the owner goal stopped.
