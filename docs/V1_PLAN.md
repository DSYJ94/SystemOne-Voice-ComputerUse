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
| **A: universal agent** (built, owner test next) | Accessibility agent on any app, push-to-talk, approvals or auto-allow, follow-ups, Jev | "Play the video", "go to youtube and search for lofi beats and play the first result", "open Notes and type 'buy milk'", "show me my Downloads in Finder" |
| **B: reliability on daily apps** (started) | **Built:** local per-step traces (`npm run traces`), browser tab keys, no-repeat of steps that changed nothing, and a **54-scenario simulated eval with live Jev (`npm run eval:agent`), 53/54 (3 Oct 2026, second pass)** at a median of about 4 s per task; the known failure is “pause the song playing in Music” while a video plays in Chrome (Jev presses Space in Chrome instead of switching apps). **Robustness pass after owner testing (3 Oct):** browser tabs are listed by name, switched and closed directly (identical tabs closed together) instead of cycled; change detection ignores clocks and counters; loops are prevented by three general rules (never undo the previous step, never repeat a step already taken from a screen seen before, never retry a step that changed nothing), while repeating a step that makes progress stays allowed; a separate “is it done?” check runs in parallel each step; quitting apps is an explicit action offered only when asked, and app-ending menu items (Quit, Log out) are hidden otherwise; “reply” with no words asks what to say; “this tab” keeps meaning the tab in front when asked; limits 40 steps / 6 visits per screen; sites open in the current tab unless a new tab is asked for; apps named anywhere in a request are recognised; Control-Option-Space also works while SystemOne is in front. The simulator now models Chrome as the page-read path, a live video clock, VS Code and WhatsApp. **Next:** a real-task eval set (about 50 scenarios across Chrome/YouTube, Gmail, Finder, Notes, Calendar, Slack and Settings) replayed from traces; labelling, ranking, verification and timing fixes; latency budget; ~~reading Chrome through the extension's DOM~~ done differently: the active tab of Chrome, Safari, Brave or Edge is read and driven through the browser's AppleScript JavaScript bridge (`dom-agent.js`, 4–37 ms per page read in tests), with Accessibility as the fallback | The eval pass rate the owner signs off on |
| **C: conversation and multi-app** (started) | **Built:** Jev knows the other open apps and can switch to them; a follow-up within 10 minutes carries what the previous request did; copy and paste across apps ("copy the invoice number from the Acme email into a new note"); natural dictation ("message Priya saying running late", no quotes needed); "undo that"; text areas are appended to, never wiped. spoken replies ("Done", "Should I …?") with hands-free yes/no; settings persist. **Next:** longer cross-app chains, selecting and copying part of a text, reading the screen aloud or answering questions about it | Agreed multi-app scenarios |
| **D: vision fallback** | On-device screenshot plus OCR/vision for apps with poor Accessibility (some Electron apps, games, canvases); click by recognized box | Agreed apps where Stage A fails |
| **E: product** | Menu-bar agent app, onboarding for permissions, Developer ID signing and notarization, installer, updates, crash reporting, settings persistence | A clean install on a second Mac |
| **F: models** | Revisit CLM or a local model for speed and offline use, measured on the Stage B eval set against Jev | The same eval at the same quality, faster or offline |

## Immediate next steps

1. **Owner tests Stage A:** `npm start`; add the signed SystemOne Dev to
   Accessibility once; try the scenarios above. Report what fails.
2. **Builder:** turn every reported failure into an eval scenario, then start
   Stage B (eval harness first, so fixes are measured rather than guessed).

## Where things live

| Area | Files |
|---|---|
| Glass bar, hotkey, voice, Accessibility executor | `apps/native-dev/main.swift`, `UniversalAX.swift`, `OnDeviceSpeech.swift` |
| Agent loop | `packages/runtime/src/universal-agent-task.ts`, `agent-goal.ts`, `agent-ax-client.ts` |
| Jev decisions | `packages/providers/src/jev-agent-decision.ts`, `jev-wire.ts` |
| Isolated browser path | `packages/browser/src/managed-browse-task.ts`, `managed-observation.ts` |
| Controller | `packages/runtime/src/native-managed-controller.ts` |
| Owner guide / evidence | `docs/USING_SYSTEMONE.md`, `docs/VALIDATION.md` |
