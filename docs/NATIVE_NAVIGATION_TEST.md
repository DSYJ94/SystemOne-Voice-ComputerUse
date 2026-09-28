# Synthetic native Documents and file selection check

This is an optional owner-run macOS check of fixed Accessibility presses.
It uses only the synthetic Fixture. It does not prove Finder support, general
file control, file opening or production signing.

1. From the `codex/native-fixture-locate` checkout, quit any existing
   **SystemOne Dev**, **SystemOne Mock** and **SystemOne Fixture** builds before
   rebuilding. Run `npm run run:native-mock` to open the synthetic Fixture, then
   `npm run run:native-dev` to open the development controller panel. The ad-hoc
   Dev build may need a fresh Accessibility grant after rebuilding.
2. In the Fixture, choose **Reset**. Its title should be `SystemOne Fixture`
   and its file status should say `No folder selected.`
3. In SystemOne Dev, choose **Show Fixture Documents**. Expected result: the
   Fixture window title becomes `SystemOne Fixture — Documents`, its file
   status says Budget.xlsx is not selected, and Dev reports verified
   navigation. It must not report that Budget.xlsx was located or opened.
4. Choose **Show Fixture Documents** again. Dev should verify that Documents
   is already showing without another press.
5. Choose **Reset** in the Fixture. In Dev, choose **Locate Fixture
   Budget.xlsx**. Expected result: the Fixture title becomes
   `SystemOne Fixture — Documents — Budget.xlsx selected`, its status says
   `Selected Documents/Budget.xlsx; file remains closed.`, and Dev reports
   verified selection. The Fixture must not show `opened`.
6. Choose **Locate Fixture Budget.xlsx** again. Dev should report that the
   selected, closed state already matches without another press.
7. Choose **Downloads** in the Fixture, then **Locate Fixture Budget.xlsx**
   in Dev. It should return to Documents and select that file, not the
   same-named Downloads file.
8. If Dev instead reports unsupported, uncertain or blocked recovery, stop
   there. Record its exact status, the Fixture title, whether Accessibility is
   granted to the current **SystemOne Dev** build, and whether the Fixture was
   visible. Do not clear the worker ledger or retry an uncertain press.

No real files, browser profiles or accounts are involved. Stop during a
dispatched AX call and recovery after an uncertain live effect require a
separate controlled check; the automated tests cover only synthetic timing.
