# Shared action candidates: current foundation

Updated 28 September 2026. This is a B13 foundation for the actions currently
implemented in the development controller, not a general computer-use action
catalogue or an enabled CLM decision loop.

`packages/runtime/src/action-candidates.ts` normalizes the native field,
managed Chromium and existing-Chrome observations. It offers `set_value` only
for visible, enabled, editable fields with a host-supplied text reference and
an explicit allowed target. It offers `navigate` only for an observed managed
browser link whose exact destination has a host-supplied binding on the same
origin. Duplicate editable labels yield no action for that ambiguous label;
incomplete observations and candidate overflow yield no executable action.
Bounded `wait` and `request_help` remain available. Secure, disabled and
unlabeled fields are never offered.
The current native, managed and Chrome dispatch paths now check this set before
their existing task admission, journal, permit and driver checks. The candidate
set does not replace any of those authorities.

Each legal candidate is a complete protocol `Candidate`: operation, private
target reference, bound parameter reference, preconditions, verifier, possible
effects, delivery, policy revision and replay policy. Model-facing candidate
IDs are opaque and do not encode target handles. The private resolver requires
the exact observation ID and candidate-set digest. A provider view copies only
reviewed state text, question text, opaque IDs and candidate descriptions; it
does not serialize target refs, parameter refs, private observations or task
records. The disclosure callback sees **every** candidate description before
approval. `requestDecision` still enforces provider/location/offline policy
before any transport call. No provider is called by the candidate builder.

The managed field action now records `EXTERNAL_WRITE` as a possible effect,
because input/change handlers can send data even when the requested operation
only edits a DOM field. The development panel should continue using disposable
text; a current DOM value does not prove server persistence.

The development panel now commits literal field values and exact navigation
destinations inside its final private command. The host derives a UTF-8 byte
range and digest for each value, and task admission verifies that range against
the immutable utterance revision. A different request value, stale source
revision or split multibyte character cannot reach observation or dispatch in
the current field-fill paths. This is a structured panel command, not a
general free-form text parser. The command and its value remain private task
input; provider projection cannot reuse them without disclosure review.

Remaining B13 work includes bounded free-form utterance span extraction,
approved selected-value bindings, exact risk approval presentation, more
operations and surface coverage, candidate-recall fixtures across complete
workflows, and a provider projection budget measured against the exact CLM
tokenizer. Only after these gates and the driver/Stop checks can B14 insert CLM
as a decision provider; a model proposal never becomes an execution permit.
