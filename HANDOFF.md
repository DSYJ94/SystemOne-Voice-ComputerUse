# SystemOne handoff

Updated 4 October 2026. This is the entry point for a new agent session. Read it
first, then [docs/V1_PLAN.md](docs/V1_PLAN.md) (stages and status) and
[docs/USING_SYSTEMONE.md](docs/USING_SYSTEMONE.md) (what the owner sees).
[docs/MAC_GPU_HANDOFF.md](docs/MAC_GPU_HANDOFF.md) is the older CLM-era
handoff, kept for history. Evidence lives in [docs/VALIDATION.md](docs/VALIDATION.md).

## What SystemOne is now

Voice or text computer use on the owner's Mac. The user holds a shortcut
(default Control-Option-Space, configurable), speaks, and lets go. A glass bar
shows progress. A Node controller runs an agent loop:

1. Read the front app: the browser's own page through AppleScript JavaScript
   (`dom-agent.js`), Accessibility otherwise, and the screen image when an app
   exposes nothing.
2. Build every possible action as an option.
3. **Jev** (TypeSafe, `jev-1.13.0`, a choice-only model) picks one.
4. Act, check the screen changed, and record the step.

CLM is parked. The original plan's fixed rules were removed by the owner: safety
comes from staging features with the owner, not from rules.

## Owner direction (binding)

- **Robust, general fixes; never keyword patches.** Every failure becomes eval
  scenarios plus natural/dictation paraphrases. A fix must be a general rule and
  must pass the whole eval. If an eval run shows a change hurts, revert it (done
  twice on 4 Oct).
- **Benchmark before deciding.** Models and framings are chosen by measurement.
  See the span, generator and vision benchmarks below.
- **Stage B is continuous.** The owner tests, gives 👍/👎 with reasons and
  corrections, and the builder fixes generally and adds the case to the eval.
- **Speed matters.** Report the time cost of every feature. The eval prints a
  timing breakdown.
- **Staging, not rules.** Risky steps (send, buy, delete, sleep, lock, Wi-Fi off,
  a second tab close) ask first. Everything else is the owner's call per stage.
- **Distribution is parked:** onboarding, signing, notarization, installer,
  updates.

## Hard rules for agents

- Branch `codex/mac-first-validation`. **Everything after `5527c96` (the pushed
  head) is local and unpushed** (`git log 5527c96..HEAD`); the owner has not
  asked to push. Sync with fast-forward only.
  Never reset, clean or stash: this checkout is on OneDrive.
- Preserve the untracked `EXECUTION_ASSESSMENT.md` and `approval-record.patch`.
  The `README.md` change in the working tree predates this work; it is not part
  of any commit.
- **No Claude co-author trailer** on commits; the owner's rule overrides tool
  defaults. Commit at verified milestones. Messages say what ran and what did not.
- The Jev API key lives only in the login Keychain item `systemone-jev`. It
  never goes in chat, git or a file in this OneDrive repo.
- No TCC (Accessibility, Screen Recording, Automation) or Keychain changes by
  the agent. The owner grants these.
- **Never build `.build/native-dev` in place, or ad hoc.** It breaks the owner's
  Accessibility grant. Typecheck Swift instead (command below), or build into a
  scratch folder. The owner rebuilds with `npm start`, which signs with the
  pinned certificate.
- No billable cloud infrastructure without an owner-approved plan. GCP or AWS
  details for telemetry are pending from the owner.

## Where things are

| Area | Files |
|---|---|
| Glass bar, Settings, hotkey, menu bar, feedback UI | `apps/native-dev/main.swift`, `BarControls.swift` (orb buttons, growing field), `TalkShortcut.swift`, `ActivityHighlight.swift` (outline), `SpokenReplies.swift` + `Earcons.swift`, `Diagnostics.swift` (logs, reports) |
| Executor | `apps/native-dev/UniversalAX.swift` (Accessibility read and act; windows, displays, menus, status items, settings panes, media/system keys, file open, Mac state), `BrowserDOM.swift` + `dom-agent.js` (page read/act, tabs, real-click fallback), `VisionReader.swift` (Stage D screenshot + OCR) |
| Agent loop | `packages/runtime/src/universal-agent-task.ts` (options, the three loop rules, answers, compose, look, settle-by-watching), `agent-goal.ts` (parse + `refineGoal` span picking), `agent-ax-client.ts` |
| Jev | `packages/providers/src/jev-agent-decision.ts` (select, rounds, done, pickSpan, findAnswer, asksForAnswer, chooseOne), `jev-wire.ts`, `clm-http-transport.ts` (pooled keep-alive HTTPS: required for parallel calls) |
| Controller | `packages/runtime/src/native-managed-controller.ts` (requests, traces, feedback, local models, telemetry outbox, exits with its app) |
| On-device models | `packages/runtime/src/local-understanding.ts`; `scripts/local-model/worker.py` (Qwen2.5-0.5B, words to type), `answer_worker.py` (Llama-3.2-3B, composed answers); installed under `~/Library/Application Support/SystemOne-Dev/local-model` |
| Training data, telemetry | `training-data.ts` (`datasets/tasks/`), `telemetry.ts` (`datasets/outbox/`), `infra/telemetry/schema.sql`, `docs/TELEMETRY.md` |
| Eval and benchmarks | `packages/runtime/eval/` (`sim.ts`, `scenarios.ts`, `span-bench.ts`), `scripts/eval-agent.ts`, `scripts/vision-bench/` |

Owner data on the Mac: traces `~/Library/Application Support/SystemOne-Dev/traces`,
datasets and attachments under `.../datasets`, logs `~/Library/Logs/SystemOne Dev`.

## How to run and check

```sh
npm start                      # owner: build (signed) and run; agents must not build in place
npx tsc --noEmit               # TypeScript
npm test                       # 504 unit tests (4 Oct)
npm run eval:agent             # simulated Mac, live Jev: 158/168, median ~1.5 s per task (4 Oct)
UNDERSTANDING=local npm run eval:agent    # words picked by on-device Qwen
COMPOSER=local npm run eval:agent         # Stage C answers composed by on-device Llama
VERBOSE=1 node scripts/eval-agent.ts <name-filter>   # one scenario family with steps
node packages/runtime/eval/span-bench.ts  # words-to-type benchmark (Jev 20/22, Qwen 17/22)
npm run traces                 # the owner's recent real tasks
npm run traces:export          # rebuild datasets from traces
# Swift typecheck without building:
zsh -c 'repository_root=$PWD; script_dir=$PWD/scripts; source scripts/native-dev-sources.zsh; \
  swiftc -typecheck -swift-version 6 -parse-as-library -module-cache-path /tmp/s1-mc "${native_dev_sources[@]}"'
```

When adding a Swift file, add it to `scripts/native-dev-sources.zsh`. When adding
a framework, add it to `scripts/build-native-dev.sh`. Xcode's licence is not
accepted, so Swift macros (`@Generable`) are unavailable; use the Command Line
Tools `swiftc`.

## Status by stage (4 Oct 2026)

- **A, universal agent:** done and owner-tested.
- **B, reliability (continuous):**
  - Traces, automatic training data, and 👍/👎 with reason, correction and
    screenshots.
  - Eval: 94 scenarios plus 74 paraphrases, 158/168.
  - Loop prevention by three general rules: no undo of the last step, no
    repeating a step taken from a screen seen before, no retrying a step that
    changed nothing.
  - Verified app switching and window moves; the page reader collects every ARIA
    interactive role, cleans icon-glyph labels, gives list positions, and falls
    back to a real click.
  - Known failures: compressed Slack phrasings ("slack Priya running late"),
    "find my budget spreadsheet and open it", "I need the system settings app"
    (Jev picks Chrome › Settings…), "wikipedia alan turing", ambiguous "this
    monitor".
- **C, conversation:**
  - Follow-ups, copy/paste across apps, dictation, undo, spoken replies.
  - Answers read from the screen. A separate focused Jev question picks the text
    that answers; "several together" reads them all out.
  - Toggle "Summaries and combined answers": Llama-3.2-3B on device, spoken only
    if every number in it is on screen. Adds 0.47–0.66 s per answer.
- **OS level:**
  - All windows across displays: bring forward, place, move by display name or
    to "this monitor", verified after moving.
  - Any app's menu commands and menu-bar icons; Notification Centre; System
    Settings panes from the system's own list.
  - Sleep, lock, dark mode, Wi‑Fi, media, volume and brightness; files by name;
    Mac state visible to Jev.
- **D, vision fallback:**
  - Built: ScreenCaptureKit window capture plus Apple OCR, used when fewer than 5
    readable controls are found or when Jev chooses "read the screen image".
    Needs Screen Recording, which the owner has not granted yet.
  - **Benchmark (ScreenSpot-v2, 100 samples):** OCR + Jev 44% (icons 12%);
    **UI-TARS-1.5-7B 88%** (text 98%, icons 78%; 2.6 s); Qwen2.5-VL-7B 75%;
    Qwen2.5-VL-3B 73%; ShowUI-2B 22%.
  - Proposed, awaiting the owner's go-ahead: UI-TARS for clicks in the vision
    fallback, OCR kept for reading text.
- **E, product (distribution parked):**
  - Menu-bar menu with Recent Requests and Report a Problem; optional Dock icon.
  - Local logs; controller auto-restart; the controller exits with its app (an
    orphan was found and fixed).
  - Custom shortcut; redesigned bar and Settings; earcons and the best installed
    voice.
- **F, models:**
  - On-device understanding (Qwen2.5-0.5B, 17/22 vs Jev 20/22, ~40–70 ms).
  - Structured telemetry and training data collected automatically.
  - Training a SystemOne chooser (text-based, does Jev's job) once about 1–2k
    labelled examples exist; needs an agreed model, GPU and cost plan.

## Lessons that cost time (do not relearn)

- Node's `fetch` sent parallel Jev calls down one connection, so they queued
  (median 7.0 s per task). Keep the pooled HTTPS agent.
- Jev provider views need candidate descriptions of at least 10 characters,
  candidate ids matching `^[A-Za-z0-9_.:-]{1,160}$`, and at least 2 candidates.
- Jev's framing matters and is measured, not guessed:
  - Span picking describes the leftover words.
  - Answer-finding uses a focused state ("The user asked …. These texts are on
    screen.").
  - A focused "is it done?" state was worse; it is reverted.
- Element ids are positions. Compare labels only on the same page of the same
  app with the same element count.
- Static text is excluded from the layout signature (clocks) but included in the
  content signature (song titles). Use content to decide whether something
  changed and layout for visit limits.
- Apple's on-device model (FoundationModels) scored 2/22 as a request
  interpreter and invented text. Not used.
- The simulator must match the real reader. Several "failures" were simulator
  inconsistencies; check before blaming Jev.

## Waiting on the owner

1. Go-ahead to build UI-TARS-1.5-7B (about 4.5 GB, 2.6 s per vision step) into
   the vision fallback.
2. GCP or AWS details for telemetry upload, the screenshot bucket and the weekly
   email (plan in `docs/TELEMETRY.md`).
3. A test round with `npm start` after the latest commits. Screen Recording grant
   (⚙ Permissions); optionally a Premium voice (⚙ Voice › Get Better Voices…);
   try the Qwen and Summaries toggles.
4. Whether to push the local commits after `5527c96`.

## Next steps (builder)

1. With the owner's go-ahead, integrate UI-TARS into the vision fallback, then
   re-run `scripts/vision-bench` plus the eval. Confirm on the owner's 👎
   screenshots in `datasets/attachments`.
2. Stage B round: read the newest traces, outbox records and 👎 notes; fix the
   failures generally; add eval scenarios and paraphrases.
3. Telemetry upload (endpoint, background sending with preview, bucket, weekly
   digest) once cloud details arrive.
4. Remaining known eval failures, each with a general cause.
