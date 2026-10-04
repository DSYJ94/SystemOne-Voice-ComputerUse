# Telemetry, problem reports and training data

One structure serves three uses: problem reports, product analytics, and training a
SystemOne chooser (Stage F). It is structured from the first record, so nothing has
to be reshaped later.

## What is recorded

Per task, in `packages/runtime/src/telemetry.ts` (schema version 1):

| Part | Contents | Why |
|---|---|---|
| task | request text, start/end, outcome, stop reason, who understood it (Jev / Qwen), typed words, step count, app and macOS version | analytics, reports |
| steps | app, window, URL, page or Accessibility read, chosen action and label, timings, "is it done?" score, whether the screen changed | reports, training labels |
| judgments | every question put to the decision model, verbatim: instructions, state, every option, probabilities, its pick, the step it decided | **training examples** |
| feedback | 👍/👎, one-tap reason, correction ("what it should have done"), screenshot names | **training labels** |
| local model calls | on-device understanding and composed answers: answer, time, accepted | model comparison |
| reports | "Report a Problem…": permissions, settings, recent logs, linked recent tasks | support |

Identifiers: a random install id created on first use (`install-id` in the support
folder). No hardware serials, account names or Apple IDs.

## Where it is now

- On the Mac: `~/Library/Application Support/SystemOne-Dev/datasets/outbox/<task>.json`,
  one record per task, rewritten after every task and every 👍/👎. Screenshots:
  `datasets/attachments/`.
- Database schema, ready for the company database: `infra/telemetry/schema.sql`
  (Postgres: GCP Cloud SQL, AWS RDS/Aurora or Supabase), with a `training_choices`
  view (one training row per deciding judgment, joined to what happened and the
  verdict) and a `weekly_digest` view for the Monday email.

## Retention

Indefinite (owner decision, 4 Oct 2026). Because records contain what was on screen
(names, email subjects), an erasure path exists from the start: `delete_install()`
removes everything for one install, for deletion requests.

## Still to do (needs the owner's GCP or AWS details)

1. Upload: an insert-only HTTPS endpoint (Cloud Run / Cloud Functions, or AWS Lambda
   behind API Gateway) that validates a record against schema version 1 and writes it;
   screenshots to a private bucket (GCS / S3).
2. App: send the outbox in the background (a per-install key in Keychain; retries;
   a ⚙ setting to pause sending; a preview of a report before it is sent).
3. Weekly email: a scheduled job (Cloud Scheduler or EventBridge) reads
   `weekly_digest` every Monday and emails it (SendGrid, SES or similar).
