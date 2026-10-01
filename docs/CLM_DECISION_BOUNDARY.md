# CLM decision boundary

`CLMDecisionClient` ranks a host-built candidate set through an explicitly
registered transport. It returns a proposal bound to the observation, candidate
digest, provider revision and host calibration revision. A proposal carries no
admission, permit or completion authority.

Before I/O, the client checks registration/egress policy, the approved projection
digest, its schema and exact candidate IDs/descriptions. The shared wire codec
sends semantic state, question and choices to `/v1/systemone`; private target
handles, parameter references, permits and journal history stay local. Every
real input still requires host disclosure review, including app-origin text.

Replies require the exact offered probability keys, a finite normalized
distribution, matching top choice, model alias and token count. Host thresholds
for probability and margin apply after parsing. Ties, malformed output and
transport failures abstain. Wait/help remain explicit non-effect proposals.
Cancellation rejects late replies. The alias and token accounting do not prove
artifact identity or absence of tokenizer truncation.

The owned HTTP transport performs no construction/health/telemetry I/O, requires
HTTPS plus bearer authentication remotely, permits loopback HTTP fixtures, rejects
redirects, bounds request/reply bytes and checks strict JSON. A configured artifact
manifest header must match; this is a consistency check against an owned server,
not independent proof of loaded weights. Server startup must verify actual bytes.

An optional trusted selector connects proposals to `NativeFixtureTask` only.
The fixture rechecks active generation and resolves the current offered action
before existing worker preparation, journal dispatch and independent predicate
verification. Synthetic tests complete Documents → Budget.xlsx → Open and prove
abstention, invented IDs, wait/help and Stop cannot prepare an effect. Default
scripted execution remains available for deterministic fixtures.

This source path is not enabled in the owner app. No real CLM inference or
calibration has run. Synthetic thresholds establish test behavior only. B02/B14
remain open pending immutable verified artifacts, authenticated owned inference,
task-disjoint calibration/evaluation and supported controller/UI integration.
See [serving preparation](CLM_DEPLOYMENT_PLAN.md) and [v1 readiness](V1_READINESS.md).
