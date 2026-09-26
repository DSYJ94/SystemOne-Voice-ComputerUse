# Implementation Backlog

Version 1.1; internal protocol 2.0. Read `REVIEW_HANDOFF.md` and `BUILD_PLAN.md` first. Original ticket states were NOT STARTED; current implementation slices and evidence are tracked in `docs/IMPLEMENTATION_STATUS.md`. No ticket is complete merely because a foundation slice exists. Check a ticket only after its evidence is committed or attached to the release record. Commands mentioned here are repository targets the team must implement unless expressly described as upstream commands.

Role abbreviations: MAC = native application/platform; CORE = controller/browser; ML = models/evaluation; RELEASE = CI/security/distribution. These are responsibilities, not a required team size.

## M0 - Establish reality before building around it

### [ ] B01 - Pin sources, models, and licenses
Owner: ML + RELEASE. Dependencies: none.

Create a dependency/model manifest containing commit/tag, checkpoint hash, tokenizer/pooling configuration, source URL, license, conversion recipe, model location, and benchmark hardware. Start by reproducing CLM at the inspected `bb42c6c5bf914fd449bed2f6ca65be80602cb1f7` revision, then deliberately adopt later fixes. Record Laya's exact checkpoint when evaluated or enabled. Audit license notices and safe checkpoint loading; do not confuse a 75 MB head with an 8B model. Record pre-head normalization, checkpoint head configuration, tokenizer/template, truncation and logit scale; prohibit moving model downloads and unapproved hot reload in release configuration.

Record the seven resource decisions from the plan: references/test baselines only by default, no agent framework fork or copied module without an explicit dependency decision. Review optional model artifact licenses separately.

Done when: sources and weights are reproducibly resolved; license review items are explicit; checksums fail on a modified artifact; no secrets or model binaries enter git.

### [ ] B02 - Serve the CLM reference and build a model probe
Owner: ML. Dependencies: B01.

Reproduce the upstream Qwen3-8B pooling endpoint plus CLM service in a private Linux/NVIDIA environment. Establish context limits, exact pooling, temperature, cache behavior, authentication, and failure responses. Use full semantic candidate descriptions. The model probe must support fixture input, raw output capture, latency, token accounting, and provider revision.

Done when: 50 known typed/ranking fixtures complete reproducibly; the probe reports unavailable services, truncation, and malformed output; fresh/cached timings and resource use are recorded; no live UI is controlled.

### [ ] B03 - Define protocol and generate validated bindings
Owner: CORE + MAC. Dependencies: none.

Review protocol 2.0 and run `validate_contract.py`; create Swift Codable and TypeScript bindings or equivalent tested models. Add framed private-RPC transport, payload limits, correlation IDs, timeouts, cancellation, and unknown-version rejection. Implement cross-field checks that JSON Schema cannot express.

Define host-private task admission and revision-bound clarification/approval/resume events before effectful tests. Bind dictation to a retained editable destination; specify whole-value versus range insertion behavior for the note workflow. Add authoritative registry comparison, safe numeric parsing and required date-time validation. An offline response check is not a pre-egress test.

Done when: positive examples round-trip in both languages; invalid candidate IDs, stale revisions, out-of-order replies, oversized data, and nonfinite scores fail closed. Add fixtures for every protocol change. Port operation-specific parameters, effect/delivery tri-state, nonempty success evidence, provider projection, UTF-8 offsets, producer-role checks, one-use permits and cancel barriers. Elevated approvals bind the authenticated actor/UI session, exact prompt and presentation, task revision, scope, observation, candidate set, action, policy revision and effects; stale, replayed, mismatched or non-UI approvals fail closed. Reject protocol 1.0; hash round-trips must agree in Swift and TypeScript.

### [ ] B04 - Prove native permissions and signing attribution
Owner: MAC + RELEASE. Dependencies: B03.

Create a minimal signed agent app. Establish which process owns microphone, Accessibility, screen capture, shortcuts, and synthesized inputs. Test permission denial/revocation, app update, and helper restart. Choose a stable development identity and bundle ID. Prove the responsible-app/helper TCC chain; run blocking AX work off the UI thread and show Stop still works under a hung adapter. Do not assume a spawned binary has the parent app's grants.

Done when: the supported access paths work without root or disabled security; prompts identify the intended app; refusal leaves text-only or appropriately degraded operation; permissions behave correctly after a new build.

### [ ] B05 - Build deterministic fixture applications and browser pages
Owner: CORE + MAC. Dependencies: B03.

Create synthetic documents, duplicate filenames, accessible controls, editable/read-only fields, delayed transitions, confirmation dialogs, a mock invoice portal, and controlled download/upload flows. Add exact verification hooks for tests but keep runtime behavior based on real adapter observations.

Done when: every initial workflow can reset to a known state; no personal accounts/data are needed; expected outcomes are machine-checkable.

### [ ] B06 - Run local CLM feasibility spike
Owner: ML. Dependencies: B01, B02.

Evaluate a Mac embedding backend, including vLLM-Metal only where its actual pooling/hidden-state support matches requirements. Preserve tokenizer, truncation, last-token pooling, normalization, and heads. Compare FP/reference and quantized variants. Test memory pressure with ASR and the app running.

Done when: a published matrix says which device/configurations pass ranking agreement, task accuracy, latency, and memory gates. The decision is explicit: native CLM qualified, more work needed, or initial CLM inference stays on the owned server. No blanket claim that Metal support proves CLM compatibility.

M0 reference-track exit: B01-B05 complete; B06 may be explicitly deferred if local CLM is not shipped. Contracts, signed mocks and scripted drivers can proceed before B02/B06 experiments complete.

## M1 - Native experience and safe input

### [ ] B07 - Ship shortcut panel and target-focus capture
Owner: MAC. Dependencies: B04.

Implement the agent lifecycle, menu-bar icon, configurable shortcuts, compact translucent panel, text entry, status, pause/stop, settings, and reduced-transparency support. Capture the intended target before showing the panel and exclude the app itself from observations.

Done when: shortcut response meets the warm UI budget; multiple monitors, full-screen spaces, keyboard navigation, and VoiceOver are tested; a submitted command never accidentally targets its own input panel.

### [ ] B08 - Implement local voice transcription and dictation modes
Owner: MAC. Dependencies: B07, B01.

Add WhisperKit with pinned model assets, microphone capture, partial/final results, push-to-talk, cancellation, and source revisions. Optional Apple SpeechAnalyzer uses the same interface. Separate literal dictation from command interpretation. Store no raw audio by default.

Done when: 100 representative utterances include file names, numbers, negation, noise, corrections, and accented speech; final text is editable; no execution happens on unstable partial input; dictating "delete this" never invokes deletion; network-off transcription works after asset installation.

### [ ] B09 - Build host stop, task epochs, and effect policy
Owner: CORE + MAC. Dependencies: B03, B07.

Implement a global cancellation path independent of inference. Add session revision/epoch invalidation, one-writer lease, action permits, application/domain/file scope, and default-denied effect classes. Define explicit local-edit capability behavior.

Bind permits to producer identity, candidate/argument digests, scope, policy revision and lease generation. One desktop-input writer across tasks. Explain autosave/external effects and scoped upload exceptions.

Done when: stop invalidates every queued dispatch; already-dispatched calls are recorded as possibly in flight, not falsely cancelled; stale responses cannot act; attempted forbidden operations fail even when a mock provider selects them with probability 1; keyboard stop works when ASR is disabled.

Prove one host authority with adapter-specific dispatch boundaries. Persist attempts through the B15 foundation before live effects. Inject Stop/expiry during browser actionability waits and native worker hangs; acknowledge the barrier only after all queues are fenced, report unresolved calls, and prevent a second permit from replaying an unresolved proposal.

M1 exit: UI, speech, and stop work against mocks. No autonomous real-machine behavior yet.

## M2 - Deterministic observation and execution

### [ ] B10 - Implement native observation registry
Owner: MAC. Dependencies: B04, B05.

Read the relevant AX tree and normalize role, label, parent context, state, supported actions, and bounds. Retain original native handles locally; assign observation-scoped IDs. Add event refresh, pagination, limits, and timeout handling. Include shallow region observations, inspect/drill-down candidates, coverage markers and stable identity fingerprints. A truncated snapshot cannot prove a missing target.

Done when: expected targets are present in fixtures; duplicate labels stay distinguishable; secure text is omitted; unsupported actions are not offered; disappeared/reused handles are rejected.

### [ ] B11 - Implement native actions and verifiers
Owner: MAC. Dependencies: B09, B10.

Implement approved app activation, invocation, focus, field value setting, selection, scroll, permitted key chords, and selected-text copy. Verify real state changes. Add pointer fallback only for current grounded bounds. Keep raw shell and arbitrary AppleScript unavailable.

Never silently fall back from AX to foreground keys, pointer or clipboard. Check capabilities and request a new permitted action for a changed delivery method.

Done when: scripted Finder and TextEdit/Notes fixtures succeed without any model; moved windows, changed focus, unsupported AXPress, and timed-out operations fail safely; locate-versus-open remains distinct.

### [ ] B12 - Implement managed Playwright browser worker
Owner: CORE. Dependencies: B03, B05, B09.

Launch a dedicated headed profile; implement semantic DOM snapshots, frame identity, locators, actionability waiting, navigation, tabs, fields, selections, downloads, and uploads. Use fixed driver code, not generated JavaScript. Add profile protection and shutdown.

Done when: scripted portal tests pass without any model; URLs and file destinations are validated; cross-origin frames, open shadow roots, delayed controls, native dialogs, and popups have documented supported/degraded behavior; no debug endpoint is exposed to the LAN.

### [ ] B13 - Implement shared candidate builder and provider projection
Owner: CORE + ML. Dependencies: B10-B12.

Build complete legal action candidates with semantic descriptions, operation/argument provenance, risk, expected outcome, and local resolution. Limit candidate/input budgets; retain request_help/wait. Add bounded utterance span and selected-value extraction with UTF-8 byte offsets. Build a separate allowlisted provider view: exclude raw handles, secret bindings, permissions and full private task records; apply egress policy to candidate text as well as state.

Done when: all gold next actions are present in the fixture candidate sets or the request explicitly abstains; CLM never receives bare meaningless IDs as action descriptions; TYPE plus non-editable button cannot be executed; filenames and typed text retain their source bytes.

M2 exit: observe/execute/verify works through scripts and mocks. Model errors can now be isolated from driver errors.

## M3 - Model-driven multi-hop control

### [ ] B14 - Add CLM provider and calibrated decisions
Owner: ML + CORE. Dependencies: B02, B13 and the scripted B15/B16/B17 safety/completion gates.

Translate internal requests to the pinned CLM API. Validate output IDs/distributions and record model/calibration metadata. Implement abstention and a decision budget. Start with one complete next-action choice, not unrelated verb/target selections.

Before any provider I/O, enforce enabled endpoint/location/revision and per-field egress policy, including candidate descriptions. Prove offline mode makes zero provider/health/telemetry calls; never trust returned provider metadata as authorization. Reject silent tokenizer truncation; B22 extends this boundary rather than introducing privacy later.

Done when: replay accuracy and candidate recall are reported separately; malformed/unknown IDs never execute; missing-candidate fixtures abstain; live execution remains limited to fixture environments.

### [ ] B15 - Implement persistent task actor and journal
Owner: CORE. Dependencies: B03/B05/B09 for the journal/actor foundation; B11/B12 for scripted integration. B14 is NOT a prerequisite.

Implement the task state machine, goal revisions, verified facts, recent outcomes, budgets, execution permits, and SQLite event journal. Re-observe after each step. Persist prepared, dispatch, effect and verification dimensions separately. Unknown effects never become failed-and-safe-to-retry. Current facts expire with the relevant observation; historical evidence stays in the journal. Resume only from paused state after recovery.

Done when: scripted Finder -> Documents -> locate a file and portal -> search -> download work without a model; crash/timeout injection does not duplicate effects; a resumed session revalidates current UI; user corrections invalidate pending steps. CLM integration follows B14 after these gates.

### [ ] B16 - Implement outcome predicates and clarification
Owner: CORE + MAC + ML. Dependencies: B03/B05 for predicate contracts; B15 for scripted task integration. No inference prerequisite.

Add supported outcome-kind admission and parameter selection, with deterministic completion predicates for LOCATE, OPEN, NAVIGATE, FILL, DOWNLOAD and UPLOAD. Start with explicit fixture/user-selected task contracts; model interpretation is integrated in B14. For ambiguous/unverifiable goals, show a concise question and safe choices. Numbered visual selection must remain tied to the displayed observation. User-confirmed completion is labelled separately from objective/unassisted success.

Done when: the app never treats DONE or progress evidence as proof; duplicate names, wrong paths/accounts, stale evidence, already-satisfied states and partial observations have explicit tests; choosing a stale number cannot select a new target; routine help uses templates rather than a generative model.

### [ ] B17 - Add recovery, interruption, and session boundaries
Owner: CORE + MAC. Dependencies: B15, B16.

Handle stale elements, no-progress loops, network loss, failed app activation, blocked dialogs, sleep/lock, manual interference, and provider cancellation. Classify each failure as perception, decision, execution, authorization, or unknown outcome.

Done when: recovery is bounded; unknown side effects pause; no retry storm or pointer fight; progress messages match actual events; end-user voice reaches this same tested execution path.

Prove the scripted recovery subset before B14; repeat it with model decisions during M3. Late receipts may reconcile old execution history but cannot resume a cancelled task.

M3 exit: a usable voice/text alpha performs qualified multi-hop native and managed-browser tasks with CLM.

## M4 - Browser/native continuity

### [ ] B18 - Implement surface routing and transition tests
Owner: CORE + MAC. Dependencies: B17.

Select adapters by target capability. Preserve task identity across native app, browser content, browser toolbar, and real native modal transitions. Rebuild target registries and revalidate clipboard/file references at each boundary.

Done when: native -> browser -> native tasks complete from multiple starting windows; an upload uses a browser file-input route where appropriate; no action uses a handle from another surface.

### [ ] B19 - Implement existing-Chrome extension bridge
Owner: CORE + RELEASE. Dependencies: B12, B18.

Implement scoped host permissions, native messaging, fixed DOM operations, user-visible tab connection, and disconnect/reconnect. Add privileged debugger capability only for a demonstrated requirement. Do not pretend the extension is automatically a Playwright transport.

Implement explicit extension invocation or optional per-origin grants; a native app shortcut alone does not activate activeTab. Pair extension ID/browser instance/profile and target tab/frame/document, handle MV3 reconnect and origin revocation, and test unsupported trusted-input operations.

Done when: approved existing Chrome tabs work without remote-debugging changes to the normal profile; origin restrictions and incognito/enterprise restrictions behave explicitly; an unapproved webpage cannot call native execution.

### [ ] B20 - Complete native interaction and compatibility coverage
Owner: MAC + CORE. Dependencies: B18, B19.

Expand to tested menus, tab/window switching, file chooser boundaries, multiple displays, and approved Slack workspace/channel/canvas workflows. Document unsupported controls rather than silently using arbitrary coordinates.

Done when: the first full support matrix names app/browser/OS versions and action families, with passing and unsupported cases; all hybrid release fixtures run end to end.

M4 exit: public beta requires native apps, managed Chromium and existing Chrome using the user's actual current profile, data and tabs (owner decision, 26 September 2026). B19/G4 remain mandatory; a fresh or copied profile is not a substitute. Publish explicit supported operation limits, and pass security and packaging prerequisites.

## M5 - Perception, open models, and improvement

### [ ] B21 - Add targeted visual perception
Owner: MAC + ML. Dependencies: B17, B20.

Implement user-consented ScreenCaptureKit capture and Apple Vision OCR, then evaluate the selected open VLM only on genuine structured-perception gaps. Map visual bounds back to the current window and validate coordinates. Add memory admission control.

Done when: caption/grounding output is schema-checked; stale screenshots and invalid bounds cannot trigger actions; denied capture permission degrades safely; supported visual tasks have their own evaluation results.

### [ ] B22 - Add qualified Laya and opt-in Jev providers
Owner: ML + CORE. Dependencies: B14, B17.

Create independent provider adapters, limits, circuit breakers, and calibration. Implement privacy modes and disclosed remote transfers. Evaluate provider switch rules by failure type, not "try every model until one agrees".

Done when: CLM outage can use an already-enabled qualified alternative; no external API is called in offline mode; unauthorized actions remain blocked under every provider; fallback behavior is tested under OOM and network failure.

### [ ] B23 - Collect and validate training traces
Owner: ML + CORE. Dependencies: B15, B20.

Build an opt-in exporter for redacted decision states, candidate sets, acceptable actions, outcomes, and evidence. Create task-disjoint train/calibration/test splits and leakage checks. Collect recovery and abstention examples, not only successful demonstrations.

Done when: starting 3,000-6,000-state budget is reviewed, or learning-curve evidence justifies another amount; no test paraphrase leaks into training; dataset licenses/consent and provenance are recorded.

### [ ] B24 - Train and calibrate CLM projection heads
Owner: ML. Dependencies: B23, B02.

Adapt the collected dataset to the pinned training implementation. Keep the encoder fixed initially; use contrastive positives/hard negatives and properly handle multiple acceptable actions. Evaluate generic-retention and per-task calibration. Add checkpoint manifests and rollback.

Done when: improvements appear on held-out closed-loop tasks, not just training loss; accepted-action error and safety do not regress; the chosen head has a versioned model card and reproducible commands.

### [ ] B25 - Close local-inference decision and optimize measured bottlenecks
Owner: ML + CORE + MAC. Dependencies: B14, B17; B06 only for shipped local CLM, B22 only for a shipped fallback, B21 only for a shipped visual mode. B23/B24 are NOT prerequisites.

Complete qualification for each enabled mode; an owned-server CLM release may explicitly defer local CLM and Laya. Any Laya-local mode must be separately qualified and enabled. Optimize snapshot sizes, candidate cache, model loading, and ASR after profiling. Do not preload all models on memory-constrained machines.

Done when: all shipped modes meet their published resource/latency/quality requirements; cold/warm results and inference location are visible; no silent external fallback occurs.

M5 exit: every shipped optional visual/model mode is qualified, not merely connected. Training, offline CLM, SemIf and visual extensions can remain deferred if excluded from release claims; CLM reference and the stable protocol stay the default.

## M6 - Production and open-source release

### [ ] B26 - Build complete validation and adversarial CI
Owner: CORE + MAC + RELEASE. Dependencies: B03/B05 to START the suite; B20/B25 and all ENABLED optional modules before release sign-off. Begin in M0 and extend with each feature.

Maintain schema/semantic, browser and signed-native tests from their first implementation. Reproduce the four original protocol counterexamples. Add uncertain dispatch, replayed permit, scope widening, malicious labels, cross-profile navigation, interrupted uploads and model/projection mismatch cases. Assemble the 300-run positive suite, 100 negative/safety scenarios, controlled failure injection, and hardware/OS matrix. Use dedicated interactive Mac runners isolated from release secrets and untrusted public pull requests.

Done when: release gates in BUILD_PLAN pass with evidence; interventions and false success are counted separately; security tests include malicious UI labels and forged IPC messages.

### [ ] B27 - Package, sign, notarize, update, and uninstall
Owner: RELEASE + MAC. Dependencies: B04/B07 to START packaging; B25 disposition before final mode-specific release. Do not wait for training or vision.

Bundle all necessary helpers; implement model download verification, first-run diagnostics, signed update channels, staged rollout, rollback, login opt-in, and uninstall. Sign nested executables with minimal entitlements. Produce notarized/stapled distribution, checksums, and SBOM.

Done when: clean supported Macs install and run without developer tools or disabled protections; updates preserve legitimate permissions and stop obsolete helpers; removal leaves no running automation or retained secrets.

### [ ] B28 - Publish a usable repository and supported app release
Owner: RELEASE + all owners. Dependencies: B26, B27.

Publish source, README, build commands, license notices, security policy, contribution guide, mock mode, synthetic fixtures, model cards, data policy, compatibility matrix, release notes, and redacted diagnostics. Keep private traces/model assets/browser profiles out of git.

Done when: another engineer builds/tests from a clean checkout; a normal user completes the first safe voice workflow from the app; every claimed feature is linked to an acceptance test; rollback and incident ownership are documented.

## Tracking fields

For each ticket record: owner name; status; branch/PR; evidence/test command; supported hardware; risks; and decision log. Change a requirement through a reviewed plan revision, not by silently weakening an acceptance test.

## Do not start these first

Do not begin with online RL, arbitrary shell access, a multi-agent planner, always-listening voice, speculative destructive actions, Windows support, or a large web frontend. None repairs an unreliable observation/execution loop.

## First three reviewable implementation PRs

1. **Contracts and fixtures (B01/B03/B05, B26 foundation):** no live effects; generate types, port all conformance cases, record source/model pins and effect policy.
2. **Signed native shell (B04/B07/B08/B09):** microphone/text with mock actions, stable TCC identity, focus capture and independent stop.
3. **Scripted native and managed-browser slice (B10/B11/B12/B13 plus B15/B16/B17 foundations):** locate a fixture file, query/download from a fixture portal, verify outcomes, and inject crash/Stop/interference; no model until both drivers, durable dispatch and task predicates pass. CLM integration follows through B14 and M3 integration of B15-B17.

Run B02/B06 in parallel where hardware is available. The reviewer must not block shell/driver correctness on fine-tuning or on a speculative Mac inference port.
