# SystemOne task language

SystemOne receives a user's task request and may perform bounded computer-use
actions only after the request is admitted and each action is separately
authorized and verified.

## Language

**Task request**:
The user's typed text or final voice transcript describing an intended outcome.
_Avoid_: Action, instruction from a page

**Committed command**:
A final, identified user input record whose exact text and source are retained
for task admission. It is not permission to execute an action.
_Avoid_: Model proposal, draft transcript

**Task intake**:
The acceptance of one final task request as a committed command and a request
for one active task. It does not replace action-specific permission or verification.
_Avoid_: Execution authority

**Verified outcome**:
A task result established by a fresh observation matching the requested
predicate. A sent action or a returned adapter receipt is not sufficient.
_Avoid_: Progress, dispatch receipt
