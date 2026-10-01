# Draft PR publication material

Head: `codex/release-dependency-inventory`
Base: `codex/clm-artifact-preflight` (draft #66), starting at `3b6c6a8`.
Title: `Add pending release dependency inventory and drift validation`

The earlier publication attempt at implementation `1673db7` was blocked with
GitHub API 403. After the owner applied the saved network settings, API access
and official browser downloads succeeded. Current validation is recorded below.
[Draft PR #67](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/67) is published and stacked on #66;
it does not merge or release the source.

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
inventory consistency and six focused tests passed. With official Playwright
1.63.0 Chromium/headless-shell revision 1243, `npm run check` passed typecheck
and all 363 executable tests: zero failures, two Mac-only skips (365 total).
`git diff --check` passed. The earlier network/browser failures are resolved;
no live Mac/model/owner-profile qualification is claimed.

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

The published URL and passing validation are recorded in handoff/status/validation.
If continuing, reuse #67 rather than creating a duplicate. Keep the owner goal stopped.
