import type { JournalTaskRecord } from '../../runtime/src/attempt-journal.ts';
import type { ScriptedPortalRecord } from './scripted-portal-task.ts';

type Stage = ScriptedPortalRecord['stage'];
type Action = NonNullable<ScriptedPortalRecord['inFlight']>;
const STAGES: readonly Stage[] = ['admitted', 'located', 'opened', 'downloaded_temporary', 'saved'];
const ACTIONS: Partial<Record<Stage, Action>> = {
  located: 'search', opened: 'open', downloaded_temporary: 'download', saved: 'save',
};

export function portalPredicate(stage: Stage): string {
  if (stage === 'located') return 'portal-locate-v1';
  if (stage === 'opened') return 'portal-open-v1';
  if (stage === 'downloaded_temporary') return 'portal-temporary-download-v1';
  if (stage === 'saved') return 'portal-download-v1';
  throw new Error('admission is not a verified portal predicate');
}

export function portalTerminalStage(task: Pick<ScriptedPortalRecord, 'outcomeKind'>): Stage {
  return task.outcomeKind === 'LOCATE' ? 'located' : task.outcomeKind === 'OPEN' ? 'opened' : 'saved';
}

/** Historical projection only, after the caller checks the exact admission
 * bindings. Never returns active, issues a permit, reopens a file or replays I/O. */
export function reconcilePortalHistory(task: ScriptedPortalRecord, journal: JournalTaskRecord):
  Pick<ScriptedPortalRecord, 'state' | 'stage' | 'inFlight' | 'reason'> {
  const terminalStage = portalTerminalStage(task);
  let stage: Stage = 'admitted';
  const latest = journal.progress?.checkpoints.at(-1);
  for (const checkpoint of journal.progress?.checkpoints ?? []) {
    const next = checkpoint.stageRef as Stage;
    if (!STAGES.includes(next) || next === 'admitted'
      || STAGES.indexOf(next) < STAGES.indexOf(stage)
      || STAGES.indexOf(next) > STAGES.indexOf(terminalStage)
      || checkpoint.predicateRef !== portalPredicate(next)
      || checkpoint.terminal !== (next === terminalStage)) {
      throw new Error('portal checkpoint stage or predicate mismatch');
    }
    if (checkpoint.executionId) {
      if (STAGES.indexOf(next) !== STAGES.indexOf(stage) + 1) {
        throw new Error('portal checkpoint skipped an action stage');
      }
      const attempt = journal.attempts.find(value => value.executionId === checkpoint.executionId);
      if (!attempt || attempt.phase !== 'settled'
        || attempt.candidateId !== `scripted-${ACTIONS[next]}`
        || attempt.scopeRef !== journal.admission?.scopeRef
        || attempt.policyRevision !== journal.admission?.policyRevision
        || attempt.outcome?.verification !== 'matched'
        || attempt.outcome.deliveryStatus !== 'dispatched'
        || attempt.outcome.effectStatus !== 'applied'
        || attempt.outcome.evidenceRef !== checkpoint.evidenceRef) {
        throw new Error('portal checkpoint attempt evidence mismatch');
      }
    } else if (!checkpoint.terminal || task.outcomeKind === 'DOWNLOAD') {
      throw new Error('portal checkpoint has no verified action');
    }
    stage = next;
  }
  const lastAttempt = journal.attempts.at(-1);
  const uncertain = journal.attempts.some(value => value.phase !== 'settled'
    || value.outcome?.deliveryStatus === 'unknown' || value.outcome?.effectStatus === 'unknown'
    || (value.outcome?.deliveryStatus === 'dispatched' && value.outcome.verification !== 'matched'));
  let inFlight = task.inFlight;
  if (!uncertain && inFlight && lastAttempt?.candidateId === `scripted-${inFlight}`
    && ((lastAttempt.outcome?.deliveryStatus === 'not_dispatched'
      && lastAttempt.outcome.effectStatus === 'not_applied')
      || (latest?.executionId === lastAttempt.executionId && ACTIONS[stage] === inFlight))) {
    inFlight = null;
  }
  const cancelled = task.state === 'cancelled' || journal.state === 'cancelled';
  if (cancelled) return { state: 'cancelled', stage, inFlight,
    reason: inFlight ? 'stopped with unresolved action' : 'stopped' };
  if (uncertain || inFlight) return { state: 'paused', stage, inFlight,
    reason: 'action outcome unknown after restart' };
  if (journal.state === 'completed' && latest?.terminal && latest.stageRef === terminalStage
    && journal.completion?.evidenceRef === latest.evidenceRef
    && journal.completion.completionVerifierRef === portalPredicate(terminalStage)) {
    return { state: 'completed', stage, inFlight: null, reason: null };
  }
  return { state: 'paused', stage, inFlight: null,
    reason: journal.state === 'completed' || task.state === 'completed'
      ? 'terminal checkpoint and completion disagree'
      : 'fresh observation required after restart' };
}
