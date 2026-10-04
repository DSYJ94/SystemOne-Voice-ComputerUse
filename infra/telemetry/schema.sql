-- SystemOne telemetry and problem reports (schema version 1).
-- One structure serves three uses: problem reports, product analytics, and training data
-- for a SystemOne chooser. Plain Postgres (GCP Cloud SQL, AWS RDS/Aurora or Supabase).
-- Retention: indefinite (owner decision, 4 Oct 2026). Erasure: delete_install() below
-- removes everything for one install, for deletion requests.

create table if not exists installs (
  install_id     uuid primary key,          -- random per Mac, no hardware or account ids
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  app_version    text,
  os_version     text
);

create table if not exists tasks (
  task_id        text primary key,          -- trace name: <ISO time>-<request id prefix>
  install_id     uuid not null references installs(install_id) on delete cascade,
  schema_version int  not null,
  started_at     timestamptz,
  ended_at       timestamptz,
  goal           text not null,              -- what the user said or typed
  outcome        text,                       -- completed | paused | stopped | error | needs_text
  stop_reason    text,
  understood_by  text,                       -- jev | local | ...
  wants_answer   boolean,
  typed_text     text,
  step_count     int,
  app_version    text,
  os_version     text,
  received_at    timestamptz not null default now()
);
create index if not exists tasks_install_time on tasks (install_id, started_at);
create index if not exists tasks_outcome on tasks (outcome);

create table if not exists steps (
  task_id          text not null references tasks(task_id) on delete cascade,
  step             int  not null,
  at               timestamptz,
  app              text,
  window_title     text,
  url              text,
  via              text,                     -- dom | ax
  kind             text not null,            -- press | type | open_url | finish | ...
  label            text,
  risky            boolean,
  option_count     int,
  element_count    int,
  read_ms          int,
  decide_ms        int,
  done_probability real,
  changed          boolean,
  act_ms           int,
  verify_ms        int,
  primary key (task_id, step)
);

-- Every question put to the decision model, verbatim: the core training examples.
create table if not exists judgments (
  task_id        text not null references tasks(task_id) on delete cascade,
  seq            int  not null,
  at             timestamptz,
  kind           text not null,              -- choose_step | is_done | which_answer | pick_words | ...
  model          text,                       -- e.g. jev-1.13.0
  instructions   text not null,
  state          text not null,
  options        jsonb not null,             -- {candidate id: description}
  probabilities  jsonb not null,             -- {candidate id: probability}
  pick           text,                       -- the model's top choice
  decided_step   int,                        -- the step this judgment decided, if any
  latency_ms     int,
  primary key (task_id, seq)
);
create index if not exists judgments_kind on judgments (kind);

-- The user's verdicts: 👍/👎, a one-tap reason, an optional correction, screenshots.
create table if not exists feedback (
  task_id        text not null references tasks(task_id) on delete cascade,
  seq            int  not null,
  at             timestamptz,
  value          text not null,              -- good | bad
  reason         text,                       -- wrong_place | wrong_words | wrong_steps | stopped_early | too_slow | other
  note           text,                       -- "what it should have done"
  attachments    text[] not null default '{}', -- object names in the screenshots bucket
  primary key (task_id, seq)
);

create table if not exists local_model_calls (
  task_id        text not null references tasks(task_id) on delete cascade,
  at             timestamptz,
  kind           text not null,              -- understanding | answers
  ms             int,
  answer         text,
  accepted       boolean
);

-- "Report a Problem…": the app state around a problem, linked to recent tasks.
create table if not exists reports (
  report_id      uuid primary key,
  install_id     uuid not null references installs(install_id) on delete cascade,
  at             timestamptz not null,
  description    text,                       -- what the user wrote, if anything
  permissions    jsonb,
  settings       jsonb,
  app_log        text,
  controller_log text,
  recent_tasks   text[] not null default '{}',
  received_at    timestamptz not null default now()
);

-- Training view: one row per deciding judgment, with what happened and the user's verdict.
create or replace view training_choices as
select j.task_id, j.seq, j.kind, j.model, j.instructions, j.state, j.options, j.probabilities, j.pick,
       s.kind as executed_kind, s.label as executed_label, s.changed,
       t.goal, t.outcome,
       f.value as verdict, f.reason as verdict_reason, f.note as correction, f.attachments
from judgments j
join tasks t using (task_id)
left join steps s on s.task_id = j.task_id and s.step = j.decided_step
left join lateral (select * from feedback f where f.task_id = j.task_id order by f.seq desc limit 1) f on true;

-- Weekly digest (for the Monday email): reports and 👎 by reason over the last 7 days.
create or replace view weekly_digest as
select
  (select count(*) from reports where at > now() - interval '7 days')                         as reports,
  (select count(*) from tasks where started_at > now() - interval '7 days')                   as tasks,
  (select count(*) from feedback where value = 'bad' and at > now() - interval '7 days')      as thumbs_down,
  (select count(*) from feedback where value = 'good' and at > now() - interval '7 days')     as thumbs_up,
  (select jsonb_object_agg(reason, n) from (select coalesce(reason, 'none') as reason, count(*) as n
     from feedback where value = 'bad' and at > now() - interval '7 days' group by 1) r)      as bad_by_reason;

-- Erasure for one install (deletion requests); cascades to tasks, steps, judgments, feedback, reports.
create or replace function delete_install(target uuid) returns void language sql as
$$ delete from installs where install_id = target; $$;
