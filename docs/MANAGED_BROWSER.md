# Managed Chromium source status

Updated 28 September 2026. `ManagedObservationSession` in
`packages/browser/src/managed-observation.ts` is a general semantic observation
surface, separate from the scripted invoice-portal driver. A trusted caller
supplies an exact start URL and 1–16 approved origins; only HTTPS and exact
`127.0.0.1` HTTP origins are accepted. It creates a temporary private Chromium
profile, defaults to a visible browser, blocks requests outside that scope,
page-initiated POSTs and WebSockets, and disables downloads and service workers.
Closing the session removes that temporary profile.

The snapshot is limited to 80 visible labelled controls in the first 5,000
main-document elements. It omits input values and password controls, gives
duplicate controls nearby text context, and marks truncated trees, subframes
and open shadow roots as incomplete coverage. IDs are observation-scoped
descriptions; actual element handles stay private in the browser session.
`prepareFill` rechecks the retained node's identity, capability, URL and
navigation revision without modifying the page. Any label or context may still
be private and must pass provider disclosure policy before model egress.

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

No app command reaches this path yet. It cannot press, navigate by task action,
upload, download or verify a broader goal. Automatic page code can still run on navigation, and
the network policy does not establish a production privacy or security boundary
for arbitrary sites. Before release, add a supervised worker, authenticated
controller authority, exact tab/frame/document registries, fixed semantic
actions with worker-side Stop fences, real headed workflows, and compatibility
qualification. The separate existing-Chrome bridge remains mandatory.
