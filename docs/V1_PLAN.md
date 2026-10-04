# V1 plan

Rewritten 3 October 2026 at the owner's direction. The earlier plan's fixed
scope rules have been removed from this plan:
- default-denied effects
- owner-app authorization gates
- one approved site per task
- no free typing
- browser-only first

That plan is in git history (`git show 5527c96:docs/V1_PLAN.md`). **Safety
now comes from staging:** owner and builder agree what each stage enables,
the owner tries it, and the next stage builds on what worked. Engineering
mechanisms (the step journal, per-step verification, Stop, history) remain
because they make the agent reliable, not as policy.

## What v1 is

Voice- or text-controlled computer use on the owner's Mac. The user holds a
hotkey, says what they want, and sits back. SystemOne works through whatever
is in front of them: their own browser and tabs, Finder, Mail, Notes, Slack,
System Settings, and any app with an Accessibility tree. It opens apps and
sites, clicks, types, presses keys, scrolls and uses menus, step by step,
until the goal is done. The user can watch, interrupt ("stop"), or approve
steps when they prefer to.

- **Decision model:** Jev (`jev-1.13.0`, TypeSafe API). CLM is parked and can
  be revisited later.
- **Interface:** one centred glass bar: push-to-talk, a text field, a status
  line, step approvals and ⚙ Settings. Nothing else on screen.
- **Start:** `npm start` (development). V1 ships as an installed menu-bar app.

## How it works now (stage A, built 3 October 2026)

```text
hold ⌃⌥Space → speak → release
        │
        ▼
glass bar ─► controller admits the goal (exact words bound; typed text is
             a span of what you said)
        │
        ▼  loop until done:
   observe front app (Accessibility; browsers expose web content too)
   → options: every labelled button, link, field, menu and tab, plus keys,
     scroll, "open <site>", "open <app>", done
   → Jev picks one (large screens judged in rounds)
   → you allow it, or auto-allow is on
   → act → check the screen changed → record it in history
```

Settings: auto-allow (on by default with `npm start`), "Ask before send /
buy / delete" (owner's choice, on by default), and Jev on or off. "privately
go to …" uses the isolated Chromium window instead of your own browser.

## Stages

Each stage ends when the owner has tried its scenarios on their Mac and is
happy. Stages after A are proposals to agree, not commitments.

| Stage | What it adds | Owner try-out scenarios |
|---|---|---|
| **A: universal agent** (done, owner-tested) | Accessibility agent on any app, push-to-talk, approvals or auto-allow, follow-ups, Jev | Done |
| **B: reliability (continuous, never "finished")** | A standing loop, run alongside every other stage: the owner uses SystemOne and leaves 👍/👎, reasons and corrections; every failure becomes eval scenarios plus paraphrases; fixes must be general rules (no per-phrase patches) and pass the whole eval. **In place:** traces and automatic training data, a simulated eval with live Jev (`npm run eval:agent`; 4 Oct 2026: 158/168 across 94 scenarios and 74 paraphrases, median 1.48 s per task), the span benchmark, loop prevention, verified app switching and window moves. **Ongoing:** replay real traces as eval cases, latency (fixed 4 Oct: parallel Jev calls had been queued on one connection; simulated median 7.0 s → 1.7 s), retire remaining word lists | Each owner test round's failures are fixed generally and kept in the eval |
| **C: conversation and multi-app** (mostly built) | Follow-ups, copy/paste across apps, dictation, undo, spoken replies, cross-app switching. **Built 4 Oct:** questions answered from the screen (“how much is the Acme invoice?”, “what song is playing?”): Jev classifies question vs action, then a separate focused question picks the visible text that answers it (never made up), after navigating if needed; “read this to me”. **Built 4 Oct (toggle):** ⚙ “Summaries and combined answers” composes short spoken answers from screen text with Llama-3.2-3B on this Mac (chosen by benchmark: 5/5 answers with the key facts at a median of 0.54 s; Qwen2.5-3B 4/5, Qwen2.5-1.5B 2/5); spoken only if every number in it is on screen; adds about 0.5–0.7 s per answered question in the eval (`COMPOSER=local npm run eval:agent`). **Next:** longer chains | Agreed question and multi-app scenarios |
| **OS level** (mostly built) | Every open window (bring forward, restore, place: halves, fill, centre, other display, “this monitor”, any window not just the front one, verified after moving); apps open or not; media, volume, brightness; sleep, lock, display off (ask first); dark mode, Wi‑Fi; any System Settings pane by name from the system's own list; files and folders by name; whole-Mac state (dark mode, Wi‑Fi, volume) visible to Jev. **Built 4 Oct:** any app's menu commands (read from the app's own menu bar, chosen by a follow-up Jev question with parallel rounds for long menus) and the menu-bar icons (Wi‑Fi, Battery, Control Centre, Focus, other apps' status items). **Built 4 Oct (later):** multiple displays: every window says which display it is on, Jev sees the displays and where the pointer is, and can move a window to a display by name, to the other one or to “this monitor”; Notification Centre can be opened, read and acted on like any window. **Shows where it works:** the glass bar stays where the user is; a click-through accent outline with a “Jev · App” tag follows the window being acted on, on whichever display, and fades when the task ends (⚙ “Show where Jev is working”); the status line names the app and display. **Next:** brightness readback | Agreed OS scenarios |
| **D: vision fallback** (built 4 Oct) | When a window exposes fewer than 5 readable controls, or Jev chooses “read the screen image”, the window is captured (ScreenCaptureKit, that window only) and read with Apple's on-device text recognition (~0.3 s); recognised text becomes clickable/typeable targets clicked for real at their screen position. Images never leave the Mac and are not kept; only text goes to Jev. Needs Screen Recording (⚙ Permissions). **Next:** icon-only controls (no text) need an icon/element detector or a small local vision model, if the eval shows the need | Apps where Accessibility fails |
| **E: product** (in progress; distribution parked) | **Built 4 Oct:** menu-bar menu (open with the shortcut, Settings, Stop, Recent Requests, Report a Problem, Developer Tools, Quit), optional Dock icon, local logs (~/Library/Logs/SystemOne Dev), automatic controller restart (3 a minute), local problem reports (nothing sent), controller always exits with its app. **Parked:** onboarding, signing and notarization, installer, updates | A day of use without restarting by hand |
| **F: models** | On-device understanding toggle (Qwen2.5-0.5B) built; training data collected automatically; next: a SystemOne chooser trained on traces once ~1–2k labelled examples exist (needs an agreed model/GPU/cost plan) | Same eval quality, faster or offline |

## Immediate next steps

1. **Stage B, continuous:** owner keeps using SystemOne with 👍/👎 and
   corrections; builder turns each round into general fixes plus eval cases.
2. **C:** summaries and multi-part answers (choose a text-writing model,
   local or cloud).
3. **Owner test of the new OS-level work** on the real multi-monitor setup (outline, displays, menus, notifications).
4. **Speed:** settling now watches the screen (0.7 s → 0.2 s per task); Jev decisions (~0.9 s per task) are the main cost.

## Where things live

| Area | Files |
|---|---|
| Glass bar, hotkey, voice, Accessibility executor | `apps/native-dev/main.swift`, `UniversalAX.swift`, `OnDeviceSpeech.swift` |
| Agent loop | `packages/runtime/src/universal-agent-task.ts`, `agent-goal.ts`, `agent-ax-client.ts` |
| Jev decisions | `packages/providers/src/jev-agent-decision.ts`, `jev-wire.ts` |
| Isolated browser path | `packages/browser/src/managed-browse-task.ts`, `managed-observation.ts` |
| Controller | `packages/runtime/src/native-managed-controller.ts` |
| Owner guide / evidence | `docs/USING_SYSTEMONE.md`, `docs/VALIDATION.md` |
