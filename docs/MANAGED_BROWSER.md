# Managed Chromium source status

Updated 28 September 2026. `ManagedObservationSession` in
`packages/browser/src/managed-observation.ts` is a general semantic observation
surface, separate from the scripted invoice-portal driver. A trusted caller
supplies an exact start URL and 1–16 approved origins; only HTTPS and exact
`127.0.0.1` HTTP origins are accepted. It creates a temporary private Chromium
profile, defaults to a visible browser, blocks requests outside that scope,
page-initiated POSTs and WebSockets, and disables downloads and service workers.
Closing the session removes that temporary profile after browser closure is
confirmed; a failed close retains the profile and blocks a success claim.

The snapshot is limited to 80 visible labelled controls in the first 5,000
main-document elements. It omits input values and password controls, gives
duplicate controls nearby text context, and marks truncated trees, subframes
and open shadow roots as incomplete coverage. IDs are observation-scoped
descriptions; actual element handles stay private in the browser session.
`prepareFill` rechecks the retained node's identity, capability, URL and
navigation revision without modifying the page. Any label or context may still
be private and must pass provider disclosure policy before model egress.
Plain same-origin links now expose an exact approved destination URL; external,
download and new-tab links have no navigable destination. `prepareNavigate`
rechecks the retained anchor, label, context, href and document revision.
Its send step goes directly to the exact href with a GET rather than firing
page click handlers. A subsequent observation must show that URL on a newer
document revision before an admitted `NAVIGATE` task can complete. This is not
an `OPEN` predicate for a named object, and GET may still have server effects.

`ManagedFillTask` binds one final-command task admission, exact browser-session
scope and source-byte digest to a one-use in-process permit and durable journal
attempt. It fills a supported text field only after preflight; the dispatch
boundary is committed before Playwright receives the command. A current exact
DOM value can complete an admitted `FILL` goal, not a later submit or server
save. Stop fences the journal, closes the browser context and reports unresolved
attempts; it cannot undo a fill already dispatched. A failure after the
boundary remains unknown and blocks a new task. No model response or plain
candidate ID can call the driver through this task object, but the permit and
admission are still in-process, with no authenticated OS worker boundary.

The development AppKit panel now reaches this one FILL path through a persistent
Node controller over private inherited pipes. The native parent supplies a
structured final command and explicit field/value; the controller verifies the
binding and admits it before the browser action. A successful fill leaves the
isolated browser open for inspection until Stop. This is a source-level
development bridge, not a bundled or OS-authenticated release worker.
The same panel now has **Navigate link** for an exact link label and explicit
same-origin expected URL. The controller requires a complete observation,
one matching link, a `NAVIGATE` admission and one journaled permit. It keeps
the browser open after exact-URL verification; Stop closes it. See the
[synthetic test](MANAGED_NAVIGATION_TEST.md). This is still one action per task.
Controller Stop now reports a closed-context fence without waiting for a late
workflow result. If browser launch is still in flight, Stop reports uncertainty
and blocks further work until that launch settles; it does not claim closure of
an unseen process.
It cannot press, upload, download or verify a broader goal. Automatic page code can still run on navigation, and
the network policy does not establish a production privacy or security boundary
for arbitrary sites. Before release, add a supervised worker, authenticated
controller authority, exact tab/frame/document registries, fixed semantic
actions with worker-side Stop fences, real headed workflows, and compatibility
qualification. The separate existing-Chrome bridge remains mandatory.
