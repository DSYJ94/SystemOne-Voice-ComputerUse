# Controller topology decision experiment

Status: proposed experiment; neither topology measured or selected.

B03 must resolve task/policy/journal ownership before expanding the production
controller. Compare the planned Node controller with a Swift task actor using
identical mock schedules and protocol fixtures. CLM stays the primary model and
all inference is mocked in this experiment.

The expected advantage of Swift is local ordering of native focus, epoch changes,
policy and dispatch. This is a hypothesis; cross-process isolation and existing
TypeScript expertise may favor Node. The team skill mix has not been measured.

| Step | Node controller hypothesis | Swift controller hypothesis |
|---|---|---|
| Native observe | One Swift/Node request-response | In-process |
| Native authorize and execute/receipt | One bundled exchange, or two if permit minting is separate | In-process |
| Browser observe | One controller/worker exchange, plus native-host state synchronization where needed | One host/worker exchange |
| Browser authorize and execute/receipt | Host authorization routing still needs a defined sequence | One host/worker exchange; worker freshness checks remain |
| Provider inference | Same provider boundary | Same provider boundary |

These are proposed lower-bound message counts, not measurements. Browser CDP
traffic, fresh verification observations, journal acknowledgments, and any extra
host fence must be included in the measured end-to-end trace. Neither design may
omit authority checks to improve its numbers.

Run 10,000 seeded mock schedules spanning focus changes, Stop, late decisions,
worker death, reconnect, and crashes before/after dispatch intent. Record every
queue boundary and reject stale dispatch. Measure p50/p95/p99 message overhead,
revalidation-to-dispatch interval, memory, launch cost and engineering effort.
Preserve a responsive UI and separately test the real native 150 ms Stop target
after signed fixtures exist; synthetic schedules do not qualify that target.

Both variants must retain exactly one dispatch owner, durable attempts, one-use
permits and truthful unknown outcomes. The browser worker remains trusted and
checks its audience, lease, epoch and document identity before dispatch. Faults
after dispatch must never be relabeled not-dispatched.

Record the chosen topology and counter-evidence in an ADR. Prefer Swift when both
meet correctness requirements and maintenance/latency evidence is comparable.
Retain Node if concrete evidence favors it. The current TypeScript input/reply
utilities are conformance building blocks and do not settle controller ownership.

Existing-Chrome qualification remains mandatory for beta in either topology.
