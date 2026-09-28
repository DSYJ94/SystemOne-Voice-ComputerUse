# Try the voice/text computer-use command panel

This development build can act on one labeled, editable field in a real native
app or on an approved HTTPS page in a fresh managed Chromium profile. It is a
bounded first agent workflow, not general computer control or v1 certification.
The final spoken transcript and typed text use the same task command field and
the same controller, journal, action permit, Stop and verification path.
This development build uses Apple's on-device Speech recognizer to make the
flow testable without a model download. The planned pinned WhisperKit path and
representative speech evaluation remain open; this does not change CLM as the
primary decision model.

From the `codex/voice-command-alpha` checkout, run `npm run run:native-dev` if
SystemOne Dev is not already open. Its compact translucent **SystemOne** panel
opens on launch; Control–Option–Space reopens it. The menu-bar or Dock item also
opens it. Control–Option–Escape is Stop. A rebuild is ad-hoc signed and may need
a fresh Accessibility grant for native actions.

For a real native app, open a disposable document or field in an app you choose
and bring that app to the front. Press Control–Option–Space. Confirm the panel's
**Target** names that app. Choose **Show fields** to see up to five observed,
nonsecure editable labels. If macOS asks for Accessibility access, grant it to
this exact development build and choose **Show fields** again. If coverage is
incomplete or no label appears, do
not guess. Enter `Fill <exact displayed label> with <disposable value>`. Choose
**Run request** once. **Verified** means a fresh read found that exact value in
the chosen field. It does not mean the document was saved or submitted.

For voice, choose **Enable Voice** once and grant microphone and speech
recognition access to this build. Hold **Talk** while speaking the same command,
then release. Recording stops on release. Wait for **Final transcript ready**,
read and edit the command text if needed, then choose **Run request**. Partial
transcripts never run. Recognition requires an available on-device recognizer
for the current Mac language; it never falls back to network speech. Raw audio
is not saved. If the recognizer is unavailable, type the command instead.

For a browser page, enter or speak `Fill <exact field label> on <HTTPS URL> with
<disposable value>`. Review the URL carefully before **Run request**. This opens
an isolated Chromium profile, observes that page and fills one matching field.
The page's scripts may transmit text over the network, so use only disposable
values. **Verified** means the current DOM field holds the value; it does not
prove a server save. **Stop** closes the managed browser. HTTP is accepted only
for `127.0.0.1` local testing.

If the target field is missing, duplicated, secure, outside observed coverage,
or changed before dispatch, the action is refused. If an effect becomes
uncertain, inspect the visible result before retrying; Stop cannot undo an
already-dispatched edit. The compact panel does not yet route commands into
the existing Chrome profile, perform multi-hop open/download tasks from an
arbitrary utterance, or call CLM. Those remain v1 work.
