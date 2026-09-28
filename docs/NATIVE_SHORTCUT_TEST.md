# Development-panel shortcut check

This is an owner-run macOS check of panel access and focus display. It does not
qualify general computer use or production Stop. Use only the synthetic Fixture
and disposable data. The app is ad-hoc signed and uses a local Node path.

1. Quit any running **SystemOne Dev** app. From this checkout, run
   `npm run run:native-dev`. If the build reports that another instance is
   running, quit that instance from its Dock icon or menu before retrying.
2. Check that the panel says `Control–Option–Space: open panel ·
   Control–Option–Escape: Stop`. If it instead reports a registration error,
   record the two status codes; the menu/Dock fallback remains available.
3. Open the synthetic **SystemOne Fixture** using the existing
   [native test guide](NATIVE_COMPUTER_USE_TEST.md). Bring the Fixture forward,
   then press **Control–Option–Space**. The SystemOne Dev panel should open and
   show `Previously focused: SystemOne Fixture` with a PID. It must not fill
   the Fixture or start a task from this shortcut alone.
4. Choose **Hide** in SystemOne Dev, then press **Control–Option–Escape** while
   no task is active. Reopen the panel. It should show `No active task to stop.`
   This checks shortcut delivery to the Stop entry point, not a Stop barrier
   during a dispatched effect.
5. Test the menu item and Dock reopen fallback if either shortcut fails. Report
   whether the panel opened, what the focus line said, and the shortcut status
   line. No Accessibility grant is needed merely to test these shortcuts.

Do not use a private app or account as the focus target for this check. A later
authorized manual run must separately establish Stop during a live fixture
action, cancellation after a dispatch boundary, and focus behavior across
displays and full-screen spaces.
