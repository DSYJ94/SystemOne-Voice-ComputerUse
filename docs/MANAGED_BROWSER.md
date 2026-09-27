# Managed Chromium source status

Updated 28 September 2026. `ManagedObservationSession` in
`packages/browser/src/managed-observation.ts` is a general read-only observation
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
descriptions, not DOM handles or execution authority. Any label or context may
still be private and must pass provider disclosure policy before model egress.

No app command reaches this observer yet. It cannot press, fill, upload,
download or verify a goal. Automatic page code can still run on navigation, and
the network policy does not establish a production privacy or security boundary
for arbitrary sites. Before release, add a supervised worker, authenticated
controller authority, exact tab/frame/document registries, fixed semantic
actions with worker-side Stop fences, real headed workflows, and compatibility
qualification. The separate existing-Chrome bridge remains mandatory.
