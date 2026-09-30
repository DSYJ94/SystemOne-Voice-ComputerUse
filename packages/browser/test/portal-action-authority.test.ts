import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskAdmission } from '../../runtime/src/task-authority.ts';
import type { PortalObservation } from '../src/managed-portal.ts';
import type { ScriptedPortalRecord } from '../src/scripted-portal-task.ts';
import { PortalActionAuthority } from '../src/portal-action-authority.ts';

const origin = 'http://127.0.0.1:12345';
const admission: TaskAdmission = {
  taskId: 'portal-task', taskEpoch: 3, goalRevision: 2,
  admissionId: 'portal-admission', commandMessageId: 'portal-command',
  goal: 'Locate INV-105', outcomeKind: 'LOCATE',
  scopeRef: 'synthetic-portal-only', completionVerifierRef: 'portal-locate-v1',
  policyRevision: 'portal-policy-1', approvedEffects: ['READ', 'NAVIGATE'],
  parameters: [],
};
const task: ScriptedPortalRecord = {
  taskId: admission.taskId, origin, outcomeKind: 'LOCATE',
  invoiceId: 'INV-105', title: 'April Service Statement',
  account: 'Harbor Works', query: 'April',
  state: 'active', stage: 'admitted', inFlight: null, reason: null,
};
const home: PortalObservation = { kind: 'home', revision: 1, url: origin };

test('host portal permit binds action, task revision and observation and transfers once', () => {
  let id = 0;
  const authority = new PortalActionAuthority(admission, () => 100, () => `host-${++id}`);
  const permit = authority.issue(task, 'search', home);
  assert.equal(permit.taskEpoch, 3);
  assert.equal(permit.goalRevision, 2);
  assert.equal(permit.candidateId, 'scripted-search');
  assert.throws(() => authority.consume({ ...permit }, task, 'search', home), /cloned/);
  assert.throws(() => authority.consume(permit, task, 'open', home), /outside|changed/);
  assert.throws(() => authority.consume(permit, task, 'search',
    { ...home, revision: 2 }), /changed/);
  authority.consume(permit, task, 'search', home);
  assert.throws(() => authority.consume(permit, task, 'search', home), /replayed/);
});

test('portal action authority rejects changed target, origin, stage and effect', () => {
  const authority = new PortalActionAuthority(admission);
  assert.throws(() => authority.issue({ ...task, stage: 'located' }, 'search', home), /outside/);
  assert.throws(() => authority.issue(task, 'search',
    { ...home, url: 'http://127.0.0.1:12346' }), /URL/);
  assert.throws(() => authority.issue(task, 'search',
    { ...home, revision: -1 }), /revision/);
  assert.throws(() => new PortalActionAuthority({ ...admission, approvedEffects: ['READ'] })
    .issue(task, 'search', home), /outside/);
  assert.throws(() => authority.issue({ ...task, state: 'cancelled' }, 'search', home), /outside/);
});

test('portal permit expires and Stop revokes an unconsumed permit', () => {
  let now = 100;
  const authority = new PortalActionAuthority(admission, () => now);
  const permit = authority.issue(task, 'search', home);
  now = 5_100;
  assert.throws(() => authority.consume(permit, task, 'search', home), /expired/);
  const next = authority.issue(task, 'search', home);
  authority.stop();
  assert.throws(() => authority.consume(next, task, 'search', home), /missing/);
  assert.throws(() => authority.issue(task, 'search', home), /closed/);
});

test('a host read reference binds the permit without weakening observation revalidation', () => {
  const authority = new PortalActionAuthority(admission);
  assert.throws(() => authority.issue(task, 'search', home, 'bad reference'), /observation ID/);
  const permit = authority.issue(task, 'search', home, 'fresh-host-read');
  assert.equal(permit.observationId, 'fresh-host-read');
  assert.throws(() => authority.consume(permit, task, 'search', { ...home, revision: 2 }), /changed/);
  authority.consume(permit, task, 'search', home);
});
