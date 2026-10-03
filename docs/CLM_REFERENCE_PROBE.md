# CLM reference probe

For hosting choices, the owner's M5/32 GB Mac and advance preparation, see
[CLM serving and preparation](CLM_DEPLOYMENT_PLAN.md). No service is deployed yet.

This is a fixture-only measurement tool for backlog B02, not a decision provider
connected to the computer-use controller. It cannot issue execution permits or
operate macOS/Chrome. The three committed synthetic cases exercise native
navigation, exact browser identity and missing-target abstention. They are a
starting point, not the required 50 task-disjoint cases or a quality claim.

The request uses the [pinned CLM source `bb42c6c`](https://github.com/Contrastive-LM/CLM/blob/bb42c6c5bf914fd449bed2f6ca65be80602cb1f7/src/clm/server.py)
`POST /v1/systemone` shape, with one `choice` question. The
[pinned schema](https://github.com/Contrastive-LM/CLM/blob/bb42c6c5bf914fd449bed2f6ca65be80602cb1f7/src/clm/schema.py)
embeds the state plus question separately from each candidate description.
The probe sends the full semantic descriptions from a validated `ProviderView`;
its internal protocol JSON is not sent as the CLM API request. Output validation
requires exact candidate keys, a finite normalized distribution, matching top
choice, the expected model alias and token accounting. Invalid output is recorded
but never treated as a valid choice.

To run against a privately owned CLM reference service, first verify the
encoder/tokenizer and head artifacts and review the fixture text for disclosure.
Use an explicitly selected HTTPS endpoint (loopback HTTP is allowed for local
development), and supply an API key through `CLM_PROBE_API_KEY` if configured:

```sh
mkdir -p private-traces
node scripts/probe-clm.ts \
  --allow-owned-service \
  --endpoint https://YOUR-OWNED-HOST/v1/systemone \
  --fixtures packages/providers/fixtures/clm-probe-synthetic.json \
  --output private-traces/clm-probe.json
```

The output is created once with owner-only file mode and contains **raw model
responses**, so `private-traces/` is git-ignored. The command makes no health or
telemetry request. Unavailable services and invalid outputs remain failures in
the report; a failed run still writes its report. Do not use live UI, account
data or secrets as probe fixtures.

The upstream `clm-latest` name is an alias, not cryptographic model identity.
This probe cannot yet prove the exact encoder/tokenizer revision, head checkpoint
hash, last-token pooling, 2048-token truncation, caching, calibration or service
authentication. The report marks artifact identity and tokenizer truncation
unverified. Before B02/G1 pass, pin and attest actual model bytes, run at least
50 representative task-disjoint fixtures on a private reference deployment,
record fresh/cached timing and resource use, measure candidate recall separately
from choice accuracy, and exercise overflow/timeout/malformed-output cases.
