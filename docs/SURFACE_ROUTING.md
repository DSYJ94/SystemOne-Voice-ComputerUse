# One decision loop, several ways to see the screen

Added 3 October 2026 at the owner's request: on Chromium pages Jev should work
from HTML, while Mac apps may need Accessibility and sometimes OCR. The switch
must be seamless. This note is the design; only the browser half exists today.

## The loop never changes

Every surface feeds the same loop, which is already in place for browsing:

```text
goal ──► observe (surface adapter) ──► host-built candidates ──► Jev picks one
   ▲                                                                   │
   └──── verify (surface adapter) ◄── permit + act (surface adapter) ◄─┘
                                       (user confirms or auto-allow)
```

Jev only ever sees the same thing: the goal, a short description of the
current screen, verified-step history, and a list of candidate descriptions.
It never sees *how* the screen was read. Candidates, one-use permits, the
journal, confirmation and Stop are surface-independent (`action-candidates.ts`,
`attempt-journal.ts`, `PersistentTaskActor`).

## Adapters, chosen per step

| Surface | Observe | Act | Verify | Status |
|---|---|---|---|---|
| Managed Chromium (isolated profile) | DOM walk: links, fields, submit buttons, clickable controls, links in collapsed menus | `goto` in-scope URL, `fill`, `requestSubmit`, click | URL/revision in scope, field value, DOM change signature | **Built** (`managed-observation.ts`, `managed-browse-task.ts`) |
| Existing Chrome (your profile) | Same DOM model via the extension and native host | Same, through the extension's granted tab | Same | Read and single-field fill exist; browse loop next |
| Native Mac apps | Accessibility tree: windows, buttons, menus, rows, fields | AXPress, AXValue set, menu selection | Fresh AX read: title, selection, value | Single-field fill and fixture presses exist; Jev loop next |
| Apps with poor AX coverage | Screenshot, then on-device OCR/vision to find labeled targets | Pointer click at the recognized box (allowed only after a fresh capture) | A new capture shows the expected change | Not started; fallback only |

**Routing rule.** The frontmost target decides the adapter. A managed or
granted Chrome tab uses the DOM. Any other app uses Accessibility. The
OCR/vision fallback is used only when the AX observation reports incomplete
coverage (`coverage.complete === false`) or finds no labeled target, and only
with its own explicit permission. HTML and AX are preferred because they are
exact, fast and verifiable. Vision is slower and fuzzier, so it is never the
default.

**Seamless switching.** A task can cross surfaces, for example "find the
invoice in the portal, then locate it in Finder". The controller already owns
one task across surfaces (M4 in V1_PLAN). Each step re-routes on the current
target, and history carries over as plain text, so Jev keeps the thread.

## What makes the browser path robust (lessons from the first live runs)

These were found against real Wikipedia on 3 October 2026 and are now fixed:

- **Rounds:** large pages are judged in rounds of about 45 options, with the
  top two of each round going to a final round, instead of keyword-trimming to
  40. Without this, "german" never matched "Deutsch".
- **Hidden menu links:** links inside collapsed menus are offered and followed
  by direct in-scope navigation. Wikipedia's language links live there.
- **Settling:** redirect chains are allowed to settle before verification, and
  observations are retried. Wikipedia search goes through several redirects.
- **Jev rounding:** Jev's two-decimal probabilities may total 0.99 or 1.01. A
  too-strict decoder rejected those replies and made runs flaky.
- **Follow-ups:** a follow-up instruction continues in the same window as a
  new task, so "change the page to German" doesn't close the browser.

## Next, in order

1. Native apps through the same loop, starting with Finder. AX observation
   becomes a candidate set; press, select and fill are verified by a fresh AX
   read. The first time, Accessibility must be granted to the
   certificate-signed build.
2. Existing Chrome browse loop on the user's profile (B19).
3. OCR/vision fallback adapter, behind its own Screen Recording permission.
