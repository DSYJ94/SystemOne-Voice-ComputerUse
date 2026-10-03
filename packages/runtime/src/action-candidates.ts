import { validateCandidate, validateProviderView } from '../../protocol/src/contract.ts';
import { ContractError, digest } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { ManagedObservation } from '../../browser/src/managed-observation.ts';
import type { NativeFieldObservation } from './native-fill-authority.ts';
import type { ChromeReadSnapshot } from './chrome-read-session.ts';
import type { ApprovedProjection, ProviderRegistration } from './provider-egress.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_CONTROLS = 200;
const MAX_ACTIONS = 62; // Reserve wait and request_help within protocol's 64.

export interface ActionControl {
  readonly targetRef: string;
  readonly role: string;
  readonly label: string;
  readonly context: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly invokable?: boolean;
  readonly destinationUrl: string | null;
}

export interface ActionSource {
  readonly surface: 'native' | 'managed' | 'chrome';
  readonly observationId: string;
  /** Required for managed links; their current driver permits same-origin only. */
  readonly currentUrl?: string;
  readonly complete: boolean;
  readonly controls: readonly ActionControl[];
}

export interface BoundText {
  readonly textRef: string;
  readonly source: 'final_command' | 'approved_binding';
  /** Host-admitted scope; the builder never expands it from visible controls. */
  readonly allowedTargetRefs: readonly string[];
}

export interface BoundDestination {
  readonly urlRef: string;
  readonly exactUrl: string;
}

export interface BoundInvocation {
  readonly targetRef: string;
  readonly expectedRef: string;
  readonly expectedDescription: string;
}

export interface CandidateBuildInput {
  readonly source: ActionSource;
  readonly text?: BoundText;
  readonly destinations?: readonly BoundDestination[];
  readonly invocations?: readonly BoundInvocation[];
  /** Managed GET-form submit buttons the host admitted for this step. */
  readonly submissions?: readonly string[];
  /** Multi-step browsing only: real pages are rarely fully observed. Offered
   * candidates are still exact observed controls; each step is user-confirmed. */
  readonly allowPartialCoverage?: boolean;
  /** Offers a non-effect "goal achieved" choice that the user must confirm. */
  readonly finishEvidenceRef?: string;
  readonly policyRevision: string;
}

export interface ResolvedCandidate {
  readonly candidateId: string;
  readonly operation: 'set_value' | 'navigate' | 'invoke';
  readonly targetRef: string;
  readonly parameterRef: string;
}

export interface BuiltCandidateSet {
  readonly observationId: string;
  readonly candidateSetDigest: string;
  readonly candidates: readonly Record<string, JSONValue>[];
  readonly abstained: boolean;
  resolve(candidateId: string, observationId: string,
    candidateSetDigest: string): ResolvedCandidate | undefined;
}

/** Exact host selection for the current scripted drivers. A provider proposal
 * may identify a candidate later, but cannot supply or expand target refs. */
export function selectBoundCandidate(set: BuiltCandidateSet,
  operation: ResolvedCandidate['operation'],
  allowedTargetRefs: readonly string[]): ResolvedCandidate | undefined {
  const allowed = new Set(allowedTargetRefs);
  const matches = set.candidates.flatMap(candidate => {
    const resolved = set.resolve(candidate.candidateId as string,
      set.observationId, set.candidateSetDigest);
    return resolved?.operation === operation && allowed.has(resolved.targetRef)
      ? [resolved] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizedText(value: string, limit: number, field: string): string {
  if (typeof value !== 'string' || !value.isWellFormed()
    || value.length > limit
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ContractError(`invalid ${field}`);
  }
  return value.replace(/\s+/gu, ' ').trim();
}

function frozenCandidate(value: Record<string, JSONValue>): Record<string, JSONValue> {
  for (const part of Object.values(value)) {
    if (part !== null && typeof part === 'object') {
      Object.freeze(part);
    }
  }
  return Object.freeze(value);
}

function checkedSource(source: ActionSource): void {
  if (!['native', 'managed', 'chrome'].includes(source.surface)
    || !ID.test(source.observationId) || typeof source.complete !== 'boolean'
    || !Array.isArray(source.controls) || source.controls.length > MAX_CONTROLS) {
    throw new ContractError('invalid candidate source');
  }
  if (source.surface === 'managed') {
    try {
      const url = new URL(source.currentUrl ?? '');
      if (url.href !== source.currentUrl
        || (url.protocol !== 'https:'
          && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
        || url.username || url.password) throw new Error('invalid');
    } catch { throw new ContractError('invalid managed candidate URL'); }
  } else if (source.currentUrl !== undefined) {
    throw new ContractError('unexpected candidate source URL');
  }
  const seen = new Set<string>();
  for (const control of source.controls) {
    normalizedText(control.context, 500, 'control context');
    if (!ID.test(control.targetRef) || seen.has(control.targetRef)
      || !normalizedText(control.role, 80, 'control role')
      || typeof control.context !== 'string'
      || typeof control.visible !== 'boolean'
      || typeof control.enabled !== 'boolean'
      || typeof control.editable !== 'boolean'
      || (control.invokable !== undefined
        && typeof control.invokable !== 'boolean')
      || (control.destinationUrl !== null
        && (source.surface !== 'managed' || typeof control.destinationUrl !== 'string'))) {
      throw new ContractError('invalid action control');
    }
    normalizedText(control.label, 160, 'control label');
    seen.add(control.targetRef);
  }
}

function destinationMap(bindings: readonly BoundDestination[],
  source: ActionSource): Map<string, string> {
  if (bindings.length > MAX_CONTROLS) throw new ContractError('too many destination bindings');
  if (source.surface !== 'managed' && bindings.length) {
    throw new ContractError('destination bindings require managed browser');
  }
  const urls = new Map<string, string>();
  const refs = new Set<string>();
  for (const binding of bindings) {
    if (!ID.test(binding.urlRef) || refs.has(binding.urlRef)) {
      throw new ContractError('invalid destination binding');
    }
    let url: URL;
    try { url = new URL(binding.exactUrl); }
    catch { throw new ContractError('invalid destination URL'); }
    if (binding.exactUrl.length > 512 || url.href !== binding.exactUrl
      || url.username || url.password
      || (url.protocol !== 'https:'
        && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
      || url.origin !== new URL(source.currentUrl!).origin
      || urls.has(binding.exactUrl)) {
      throw new ContractError('unapproved destination URL');
    }
    refs.add(binding.urlRef);
    urls.set(binding.exactUrl, binding.urlRef);
  }
  return urls;
}

function fallback(operation: 'wait' | 'request_help', reason: string,
  policyRevision: string): Record<string, JSONValue> {
  return frozenCandidate({ candidateId: operation,
    description: operation === 'wait'
      ? 'Wait briefly, then observe this scope again before proposing an action.'
      : 'Pause and ask the user because no offered action can safely advance this task.',
    operation, parameters: operation === 'wait'
      ? { timeoutMs: 1_000 } : { reason },
    preconditions: [], verifier: { kind: 'no_effect_expected' },
    effects: ['READ'], delivery: 'controller',
    riskPolicyRef: policyRevision, replayPolicy: 'idempotent_verified' });
}

/** Builds only actions already supported by the selected semantic driver.
 * Candidate IDs are opaque and never contain private observation handles.
 * This is neither task admission nor an execution permit. */
export function buildActionCandidates(input: CandidateBuildInput): BuiltCandidateSet {
  const { source } = input;
  checkedSource(source);
  if (!ID.test(input.policyRevision)) throw new ContractError('invalid candidate policy');
  if (input.text && (!ID.test(input.text.textRef)
    || !['final_command', 'approved_binding'].includes(input.text.source)
    || !Array.isArray(input.text.allowedTargetRefs)
    || input.text.allowedTargetRefs.length > MAX_CONTROLS
    || new Set(input.text.allowedTargetRefs).size !== input.text.allowedTargetRefs.length
    || !input.text.allowedTargetRefs.every(ref => ID.test(ref)))) {
    throw new ContractError('unbound candidate text');
  }
  const textTargets = new Set(input.text?.allowedTargetRefs ?? []);
  const destinations = destinationMap(input.destinations ?? [], source);
  const invocations = new Map<string, BoundInvocation>();
  if ((input.invocations?.length ?? 0) > MAX_CONTROLS) {
    throw new ContractError('too many native invocation bindings');
  }
  for (const binding of input.invocations ?? []) {
    if (source.surface !== 'native' || !ID.test(binding.targetRef)
      || !ID.test(binding.expectedRef)
      || invocations.has(binding.targetRef)
      || !normalizedText(binding.expectedDescription, 160,
        'invocation expected description')) {
      throw new ContractError('invalid native invocation binding');
    }
    invocations.set(binding.targetRef, binding);
  }
  if ((input.submissions?.length ?? 0) > MAX_CONTROLS
    || (input.submissions ?? []).some(ref => !ID.test(ref))
    || (input.submissions?.length && source.surface !== 'managed')) {
    throw new ContractError('invalid submit bindings');
  }
  const submissions = new Set(input.submissions ?? []);
  const candidates: Record<string, JSONValue>[] = [];
  const resolutions = new Map<string, ResolvedCandidate>();
  const labelCounts = new Map<string, number>();
  for (const control of source.controls) {
    if (!control.visible || !control.enabled || !control.editable) continue;
    const label = normalizedText(control.label, 160, 'control label');
    if (!label) continue;
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  let ambiguous = false;
  if (source.complete) {
    for (const control of source.controls) {
      if (!control.visible || !control.enabled) continue;
      const label = normalizedText(control.label, 160, 'control label');
      if (!label) continue;
      const context = normalizedText(control.context, 500, 'control context');
      if (control.editable && input.text && textTargets.has(control.targetRef)) {
        if (labelCounts.get(label) !== 1) { ambiguous = true; continue; }
        const candidateId = `c${candidates.length}`;
        const description = `Set the visible ${control.role} field “${label}”${context
          ? ` in ${context}` : ''} to the user's bound text, then verify its current value.`;
        const candidate: Record<string, JSONValue> = frozenCandidate({ candidateId,
          description, operation: 'set_value', targetRef: control.targetRef,
          parameters: { textRef: input.text.textRef },
          preconditions: ['target_exists', 'target_visible', 'target_enabled',
            'field_editable', 'fresh_observation'],
          verifier: { kind: 'value_equals', expectedRef: input.text.textRef },
          effects: source.surface === 'native' ? ['LOCAL_EDIT']
            : ['LOCAL_EDIT', 'EXTERNAL_WRITE'],
          delivery: 'semantic', riskPolicyRef: input.policyRevision,
          replayPolicy: 'only_if_not_applied' });
        validateCandidate(candidate);
        candidates.push(candidate);
        resolutions.set(candidateId, Object.freeze({ candidateId,
          operation: 'set_value', targetRef: control.targetRef,
          parameterRef: input.text.textRef }));
      }
      const invocation = invocations.get(control.targetRef);
      if (source.surface === 'native' && control.invokable && invocation
        && ['AXButton', 'AXMenuItem'].includes(control.role)) {
        const candidateId = `c${candidates.length}`;
        const description = `Invoke the visible ${control.role} “${label}”${context
          ? ` in ${context}` : ''}, then independently verify ${invocation.expectedDescription}.`;
        const candidate: Record<string, JSONValue> = frozenCandidate({ candidateId,
          description, operation: 'invoke', targetRef: control.targetRef,
          parameters: {}, preconditions: ['target_exists', 'target_visible',
            'target_enabled', 'fresh_observation'],
          verifier: { kind: 'folder_identity',
            expectedRef: invocation.expectedRef },
          effects: ['NAVIGATE'], delivery: 'semantic',
          riskPolicyRef: input.policyRevision,
          replayPolicy: 'only_if_not_applied' });
        validateCandidate(candidate);
        candidates.push(candidate);
        resolutions.set(candidateId, Object.freeze({ candidateId,
          operation: 'invoke', targetRef: control.targetRef,
          parameterRef: invocation.expectedRef }));
      }
      if (source.surface === 'managed' && !control.editable
        && ['a', 'link'].includes(control.role.toLowerCase())
        && control.destinationUrl
        && destinations.has(control.destinationUrl)) {
        const urlRef = destinations.get(control.destinationUrl)!;
        const candidateId = `c${candidates.length}`;
        const description = `Follow the visible link “${label}”${context
          ? ` in ${context}` : ''} to the approved destination ${control.destinationUrl}, then verify exact URL arrival.`;
        const candidate: Record<string, JSONValue> = frozenCandidate({ candidateId,
          description, operation: 'navigate', targetRef: control.targetRef,
          parameters: { urlRef },
          preconditions: ['target_exists', 'target_visible', 'target_enabled',
            'origin_approved', 'fresh_observation'],
          verifier: { kind: 'url_matches', expectedRef: urlRef },
          effects: ['NAVIGATE', 'EXTERNAL_READ'], delivery: 'semantic',
          riskPolicyRef: input.policyRevision, replayPolicy: 'only_if_not_applied' });
        validateCandidate(candidate);
        candidates.push(candidate);
        resolutions.set(candidateId, Object.freeze({ candidateId,
          operation: 'navigate', targetRef: control.targetRef,
          parameterRef: urlRef }));
      }
      if (source.surface === 'managed' && control.invokable === true && submissions.has(control.targetRef)) {
        const candidateId = `c${candidates.length}`;
        const candidate: Record<string, JSONValue> = frozenCandidate({ candidateId,
          description: `Submit the form with the visible button “${label}”${context
            ? ` in ${context}` : ''}, then verify the page changes within the approved site.`,
          operation: 'invoke', targetRef: control.targetRef, parameters: {},
          preconditions: ['target_exists', 'target_visible', 'target_enabled',
            'origin_approved', 'fresh_observation'],
          verifier: { kind: 'content_changed' },
          effects: ['NAVIGATE', 'EXTERNAL_READ'], delivery: 'semantic',
          riskPolicyRef: input.policyRevision, replayPolicy: 'only_if_not_applied' });
        validateCandidate(candidate);
        candidates.push(candidate);
        resolutions.set(candidateId, Object.freeze({ candidateId,
          operation: 'invoke', targetRef: control.targetRef, parameterRef: 'submit' }));
      }
      if (candidates.length > MAX_ACTIONS) break;
    }
  }
  const covered = source.complete || input.allowPartialCoverage === true;
  const abstained = !covered || candidates.length > MAX_ACTIONS;
  if (abstained) { candidates.length = 0; resolutions.clear(); }
  const reason = !covered ? 'unsupported'
    : ambiguous ? 'ambiguous_target'
      : !input.text && source.controls.some(control => control.editable)
        ? 'missing_value'
      : candidates.length === 0 ? 'missing_target' : 'uncertain_decision';
  if (input.finishEvidenceRef !== undefined && !abstained) {
    if (!ID.test(input.finishEvidenceRef)) throw new ContractError('invalid finish evidence');
    candidates.push(frozenCandidate({ candidateId: 'finish',
      description: 'Stop here because the goal is already achieved on the current page; the user confirms completion.',
      operation: 'finish', parameters: { completionEvidenceRef: input.finishEvidenceRef },
      preconditions: [], verifier: { kind: 'user_confirmation' }, effects: ['READ'],
      delivery: 'controller', riskPolicyRef: input.policyRevision, replayPolicy: 'idempotent_verified' }));
  }
  candidates.push(fallback('wait', reason, input.policyRevision));
  candidates.push(fallback('request_help', reason, input.policyRevision));
  for (const candidate of candidates) validateCandidate(candidate);
  const frozen = Object.freeze([...candidates]);
  const candidateSetDigest = digest([...frozen]);
  return Object.freeze({ observationId: source.observationId,
    candidateSetDigest, candidates: frozen, abstained,
    resolve(candidateId: string, observationId: string, suppliedDigest: string) {
      if (observationId !== source.observationId
        || suppliedDigest !== candidateSetDigest) return undefined;
      return resolutions.get(candidateId);
    } });
}

/** Projects only reviewed text and opaque candidate IDs. The reviewer must
 * inspect every candidate description, including page- or app-origin text. */
export function approveCandidateProjection(input: {
  readonly set: BuiltCandidateSet;
  readonly stateText: string;
  readonly questionText: string;
  readonly provider: ProviderRegistration;
  readonly disclosureReview: (field: string, text: string) => boolean;
}): ApprovedProjection {
  const stateText = normalizedText(input.stateText, 24_000, 'state text');
  const questionText = normalizedText(input.questionText, 2_000, 'question text');
  if (!stateText || !questionText || !input.disclosureReview('stateText', stateText)
    || !input.disclosureReview('questionText', questionText)) {
    throw new ContractError('provider projection disclosure denied');
  }
  const candidates = input.set.candidates.map(candidate => {
    const candidateId = candidate.candidateId as string;
    const description = candidate.description as string;
    if (!input.disclosureReview(`candidate:${candidateId}`, description)) {
      throw new ContractError('candidate description disclosure denied');
    }
    return { candidateId, description };
  });
  const value = { projectionRevision: 'candidate-projection-v1',
    stateText, questionText, candidates };
  validateProviderView(value);
  return Object.freeze({ value, digest: digest(value),
    providerId: input.provider.id, providerRevision: input.provider.revision });
}

export function fromManagedObservation(value: ManagedObservation): ActionSource {
  return { surface: 'managed', observationId: value.observationId,
    currentUrl: value.url,
    complete: value.coverage.complete,
    controls: value.controls.map(control => ({ targetRef: control.id,
      role: control.role, label: control.label, context: control.context,
      enabled: control.enabled, visible: true, editable: control.editable,
      invokable: control.submittable, destinationUrl: control.destinationUrl })) };
}

export function fromChromeObservation(value: ChromeReadSnapshot): ActionSource {
  return { surface: 'chrome', observationId: value.observationId,
    complete: value.complete,
    controls: value.elements.map(control => ({ targetRef: control.id,
      role: control.role, label: control.label, context: '',
      enabled: !control.disabled, visible: true, editable: control.editable,
      destinationUrl: null })) };
}

export function fromNativeObservation(value: NativeFieldObservation): ActionSource {
  return { surface: 'native', observationId: value.observationId,
    complete: value.complete,
    controls: value.controls.map(control => ({ targetRef: control.id,
      role: control.role, label: control.label, context: '',
      enabled: control.enabled, visible: true,
      editable: !control.secure && control.canSetValue,
      destinationUrl: null })) };
}
