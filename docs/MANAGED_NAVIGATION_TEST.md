# Development managed-link navigation test

This is an optional synthetic macOS test. It starts at the local invoice portal,
finds one observed link by its exact visible label **and** user-supplied expected
destination, then navigates in a fresh managed Chromium profile. Success means
the browser re-observed the exact destination URL. It does not claim an invoice
was opened, a download occurred, or any website state was saved.

From this worktree, keep terminal 1 running:

```sh
npm run run:portal-fixture
```

Copy the printed URL, such as `http://127.0.0.1:PORT/`. In terminal 2 run:

```sh
npm run run:native-dev
```

Quit an older **SystemOne Dev** instance first if the build refuses to replace
its running executable. In the **SystemOne Dev** panel, enter:

1. **Approved page URL:** the printed URL including `/`.
2. **Exact visible field or link label:** `Browse all invoices`.
3. **Text to fill, or exact expected link URL:** the same origin followed by
   `/invoices`, for example `http://127.0.0.1:PORT/invoices`.

Choose **Navigate link**. A fresh Chromium window should show the invoice list,
and the panel should report that it reached the exact expected URL. Choose
**Stop** to close the isolated browser. For a negative check, use an expected
destination ending `/invoices/INV-104`; the panel should report unsupported
and must not open that detail page, because the observed Browse link does not
point there. Use disposable fixture data only.

This build does not use the user's existing Chrome profile or an external
account. Navigation is a GET to an approved origin, but real sites can attach
side effects to GET requests. Stop cannot undo a request already sent. The
general HTTPS path, extension support, release signing and multi-hop task
controller remain unqualified.
