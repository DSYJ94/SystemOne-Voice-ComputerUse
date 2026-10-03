# Native development task intake

`apps/native-dev/DevTaskIntake.swift` is the development UI's single place for
building the protocol 2.0 committed command and its typed start request. The
compact voice/text panel and developer buttons still perform target-specific
preflight, then submit an intent to this module. The module generates one task
ID, preserves the original final text for compact requests, records the source
as voice only when the displayed text still matches the final transcript,
sends once, and occupies its single writer slot only after successful delivery.
It releases that slot only for the matching controller `ready` or acknowledged
Stop. A stale request ID cannot release it. The persistent controller still
parses the command, validates provenance, owns action permits and journals
dispatch; the UI module does not grant execution authority.

Supported intents are the existing bounded managed field fill/link navigate,
native field fill, synthetic portal/Documents/LOCATE/OPEN and granted Chrome
fixture field fill. No general planner or new action type was added. The exact
developer-panel command texts and controller request keys are intentionally
preserved. The app remains a development alpha and one successful synthetic
request does not qualify arbitrary computer use.

`npm run test:dev-task-intake` checks failed delivery, one active writer,
voice/text provenance, captured native process fields, stale status, distinct
LOCATE/OPEN and existing-Chrome grant fields without opening apps or browsers.
`npm run build:native-dev` compiles the integration; `npm run check` exercises
the controller's independent authority checks. A live panel and action test
remains a separate owner gate. See [voice test](VOICE_COMPUTER_USE_TEST.md).

The controller now routes the existing Documents/LOCATE/OPEN intents through the
[persistent native fixture actor](NATIVE_CONTROLLER_ACTOR.md). A paused task
keeps intake blocked across every surface and restart. An explicit Stop of the
retained fixture actor can release intake after its worker fence and operation
settle, provided no effect remains uncertain. Resume/replacement intent is still
not exposed by the panel.
