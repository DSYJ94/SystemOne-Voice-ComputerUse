#!/usr/bin/env python3
"""Offline planning-contract tests. No network, models, GUI actions or file mutation.

Usage (Python 3.10+):
  python -m pip install 'jsonschema[format-nongpl]==4.26.0'
  python validate_contract.py
  python validate_contract.py --json

This is a REFERENCE TEST ORACLE, not a production authorization implementation.
The small semantic harness demonstrates invariants against trusted synthetic
registries. It does not implement OS/TCC identity, races, privacy classification,
secure IPC, durable transactions, native revalidation or real cancel barriers.
Port these cases into Swift and TypeScript; add actual platform/fault tests.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

try:
    import jsonschema
except ImportError:
    sys.exit("Install test dependency: python -m pip install 'jsonschema[format-nongpl]==4.26.0'")

HERE = Path(__file__).resolve().parent
SCHEMA = json.loads((HERE / 'protocol.schema.json').read_text(encoding='utf-8'))
CHECKER = jsonschema.FormatChecker()
if 'date-time' not in CHECKER.checkers:
    sys.exit("Missing date-time validation: install 'jsonschema[format-nongpl]==4.26.0'")
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA, format_checker=CHECKER)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def strict_loads(text: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k, value in items:
            require(k not in out, f'duplicate key: {k}')
            out[k] = value
        return out
    def invalid_constant(value: str) -> None:
        raise ValueError(f'non-finite JSON constant: {value}')
    def finite_float(value: str) -> float:
        parsed = float(value)
        require(math.isfinite(parsed), 'non-finite JSON number')
        return parsed
    def safe_int(value: str) -> int:
        parsed = int(value)
        require(abs(parsed) <= 2**53-1, 'integer outside portable safe range')
        return parsed
    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant,
                      parse_float=finite_float, parse_int=safe_int)


def digest(value: Any) -> str:
    """Restricted fixture canonicalizer; not a general-purpose JCS replacement."""
    def check(v: Any) -> None:
        if v is None or isinstance(v, bool):
            return
        if isinstance(v, int):
            require(abs(v) <= 2**53-1, 'integer outside portable safe range')
            return
        if isinstance(v, str):
            v.encode('utf-8', errors='strict')
            return
        if isinstance(v, list):
            for item in v:
                check(item)
            return
        if isinstance(v, dict):
            for k, item in v.items():
                require(isinstance(k, str) and k.isascii(), 'digest keys must be ASCII strings')
                check(item)
            return
        raise ValueError('digest inputs must not contain floats or unsupported objects')
    check(value)
    wire = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(wire.encode('utf-8')).hexdigest()


def validate(value: Any, definition: str | None = None) -> None:
    if definition:
        local = {'$schema': SCHEMA['$schema'], '$defs': SCHEMA['$defs'], '$ref': f'#/$defs/{definition}'}
        jsonschema.Draft202012Validator(local, format_checker=CHECKER).validate(value)
    else:
        VALIDATOR.validate(value)


def timestamp(s: str) -> datetime:
    return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(timezone.utc)


def check_span(binding: dict[str, Any], sources: dict[str, str]) -> None:
    validate(binding, 'Binding')
    if binding['source'] != 'transcript_span':
        return
    require(binding['sourceRef'] in sources, 'missing immutable source')
    raw = sources[binding['sourceRef']].encode('utf-8')
    a, b = binding['sourceStart'], binding['sourceEnd']
    require(0 <= a <= b <= len(raw), 'span range invalid')
    require(raw[a:b].decode('utf-8', errors='strict') == binding['value'], 'span changed source text')


def action_digest(request: dict[str, Any], candidate: dict[str, Any]) -> str:
    # All fixture bindings are bound conservatively. Production may bind only the
    # resolved subset with a versioned format and corresponding parity fixtures.
    return digest({'candidate': candidate, 'scopeRef': request['context']['scopeRef'],
                   'bindings': request['context']['bindings']})


@dataclass
class FixtureGuard:
    """Trusted in-memory fixture registry; deliberately NOT an app policy engine."""
    issued: dict[str, Any]
    epoch: int = field(init=False)
    lease: int = 1
    used_permits: set[str] = field(default_factory=set)
    used_executions: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.issued = copy.deepcopy(self.issued)
        self.epoch = self.issued['taskEpoch']

    def cancel(self) -> None:
        self.epoch += 1
        self.lease += 1

    def check(self, request: dict[str, Any], proposal: dict[str, Any], execution: dict[str, Any],
              permit: dict[str, Any], *, producer: str = 'host',
              now: str = '2026-09-25T17:00:02Z', live_targets: list[dict] | None = None) -> None:
        for message in (request, proposal, execution, permit):
            validate(message)
        require(producer == 'host', 'untrusted channel cannot mint a permit')
        t = timestamp(now)
        require(self.epoch == request['taskEpoch'], 'cancelled task epoch')
        for message in (proposal, execution, permit):
            for key in ('taskId', 'taskEpoch', 'goalRevision'):
                require(message[key] == self.issued[key], f'{key} mismatch')
        for key in ('taskId', 'taskEpoch', 'goalRevision'):
            require(request[key] == self.issued[key], f'changed request {key}')
        obs = request['observation']
        require(obs['observationId'] == self.issued['observation']['observationId'], 'observation changed')
        require(obs['surface'] == self.issued['observation']['surface'], 'issued surface changed')
        require(obs['targets'] == self.issued['observation']['targets'], 'issued target registry changed')
        require(request['requestId'] == self.issued['requestId'], 'issued request ID changed')
        require(request['deadline'] == self.issued['deadline'], 'issued deadline changed')
        expected_candidates = self.issued['observation']['candidateSetDigest']
        require(digest(obs['candidates']) == expected_candidates == obs['candidateSetDigest'], 'candidate records changed')
        require(digest(request['providerView']) == self.issued['providerViewDigest'] == request['providerViewDigest'], 'unapproved provider projection')
        require(proposal['providerViewDigest'] == request['providerViewDigest'], 'projection response mismatch')
        require(proposal['requestId'] == request['requestId'], 'request correlation mismatch')
        require(request['context']['scopeRef'] == self.issued['context']['scopeRef'], 'scope widening')
        require(digest(request['context']['bindings']) == digest(self.issued['context']['bindings']), 'changed private binding')
        require(request['context']['stepCount'] < request['context']['maxSteps'], 'task budget exhausted')
        for fact in request['context']['verifiedFacts']:
            require(fact['scopeRef'] == request['context']['scopeRef'], 'fact scope mismatch')
            if fact['validity'] == 'observation':
                require(fact['observationId'] == obs['observationId'], 'expired current-state fact')
        for message in (proposal, execution, permit):
            require(message['observationId'] == obs['observationId'], 'stale response observation')
            require(message['candidateSetDigest'] == expected_candidates, 'candidate digest mismatch')
        require(execution['scopeRef'] == permit['scopeRef'] == self.issued['context']['scopeRef'], 'permit scope mismatch')
        require(execution['leaseGeneration'] == permit['leaseGeneration'] == self.lease, 'stale writer lease')
        require(timestamp(permit['issuedAt']) <= t < timestamp(permit['expiresAt']), 'permit expired or future')
        require(timestamp(proposal['createdAt']) <= t < timestamp(proposal['expiresAt']), 'proposal expired or future')
        require(t < timestamp(request['deadline']) and t < timestamp(execution['deadline']), 'deadline expired')
        require(execution['permitRef'] == permit['permitRef'], 'permit lookup mismatch')
        require(permit['permitRef'] not in self.used_permits, 'permit replay')
        require(execution['executionId'] not in self.used_executions, 'duplicate execution')
        rows = proposal['ranked']
        ids = [r['candidateId'] for r in rows]
        candidates = {c['candidateId']: c for c in obs['candidates']}
        require(len(candidates) == len(obs['candidates']), 'duplicate issued candidate')
        require(len(ids) == len(set(ids)) and set(ids) == set(candidates), 'ranked IDs missing, duplicate or invented')
        probabilities = [r['probability'] for r in rows]
        require(all(math.isfinite(p) for p in probabilities), 'non-finite probability')
        require(abs(sum(probabilities)-1.0) <= 1e-6, 'invalid probability sum')
        chosen = proposal['selectedCandidateId']
        require(chosen in candidates, 'unknown selected ID')
        best = max(probabilities)
        require(any(r['candidateId'] == chosen and r['probability'] == best for r in rows), 'selection not top-ranked')
        require(chosen == execution['candidateId'] == permit['candidateId'], 'selected/permit/action mismatch')
        candidate = candidates[chosen]
        require(candidate['delivery'] != 'controller', 'meta-action sent to OS executor')
        require('UNKNOWN' not in candidate['effects'], 'unknown effects denied')
        require(set(candidate['effects']) <= set(self.issued['context']['approvedEffects']), 'effect not approved')
        require(execution['actionDigest'] == permit['actionDigest'] == action_digest(request, candidate), 'action/argument binding changed')
        target_ref = candidate.get('targetRef')
        if target_ref:
            targets = live_targets if live_targets is not None else obs['targets']
            matches = [x for x in targets if x['targetRef'] == target_ref]
            issued_targets = [x for x in self.issued['observation']['targets'] if x['targetRef'] == target_ref]
            require(len(matches) == len(issued_targets) == 1, 'missing or ambiguous target')
            target, prior = matches[0], issued_targets[0]
            require(target['identityFingerprint'] == prior['identityFingerprint'] and target['surfaceId'] == prior['surfaceId'], 'target identity changed')
            require(target['enabled'] and target['visible'], 'target unavailable')
            require(candidate['operation'] in target['capabilities'], 'unsupported target operation')
        location = proposal['provider']['location']
        mode = request['privacyMode']
        require(mode == self.issued['privacyMode'], 'privacy mode changed')
        if mode == 'offline':
            require(location == 'local', 'offline request routed remotely')
        elif mode == 'owned_service':
            require(location in ('local', 'owned_service'), 'external service not opted in')
        require(proposal['provider']['name'] != 'semif', 'research provider not enabled in production fixture')

    def consume(self, *args: Any, **kwargs: Any) -> None:
        self.check(*args, **kwargs)
        execution, permit = args[2], args[3]
        self.used_permits.add(permit['permitRef'])
        self.used_executions.add(execution['executionId'])


def retry_permitted(candidate: dict[str, Any], receipt: dict[str, Any], *, fresh_not_applied: bool,
                    idempotence_verified: bool = False) -> bool:
    # Tests use conservative policy. Real applications need operation-specific
    # proof of non-application, including any effect that may complete later.
    if receipt['effectStatus'] == 'unknown' or receipt['deliveryStatus'] == 'unknown':
        return False
    mode = candidate['replayPolicy']
    if mode == 'only_if_not_applied':
        return fresh_not_applied and receipt['deliveryStatus'] == 'not_dispatched' and receipt['effectStatus'] == 'not_applied'
    return mode == 'idempotent_verified' and idempotence_verified


def run() -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    def test(group: str, name: str, action: Callable[[], None], rejection: bool = False) -> None:
        try:
            action()
        except (ValueError, jsonschema.ValidationError, UnicodeError) as exc:
            if rejection:
                results.append({'group': group, 'test': name, 'passed': True})
            else:
                results.append({'group': group, 'test': name, 'passed': False, 'error': str(exc)[:180]})
        else:
            results.append({'group': group, 'test': name, 'passed': not rejection,
                            **({'error': 'invalid case was accepted'} if rejection else {})})
    jsonschema.Draft202012Validator.check_schema(SCHEMA)
    ex = SCHEMA['examples']
    for i, example in enumerate(ex):
        test('valid_messages', f'example_{i+1}_{example["type"]}', lambda e=example: validate(e))
    candidate = ex[1]['data']['candidates'][0]
    def invalid(name: str, value: dict, mutate: Callable[[dict], None], definition: str | None = None) -> None:
        obj = copy.deepcopy(value); mutate(obj)
        test('invalid_structure', name, lambda: validate(obj, definition), rejection=True)
    invalid('success_without_evidence', ex[5], lambda x: x.update(evidence=[]))
    invalid('success_with_unknown_effect', ex[5], lambda x: x.update(effectStatus='unknown'))
    invalid('success_without_matched_verifier', ex[5], lambda x: x.update(verification='unavailable'))
    invalid('old_boolean_receipt', ex[5], lambda x: x.update(effectsCommitted=True))
    invalid('unknown_outcome_claims_matched_verification', ex[8], lambda x: x.update(verification='matched', evidence=ex[5]['evidence']))
    invalid('not_dispatched_but_applied', ex[5], lambda x: x.update(deliveryStatus='not_dispatched'))
    invalid('scroll_without_amount_and_direction', candidate, lambda x: x.update(operation='scroll', parameters={}), 'Candidate')
    invalid('set_value_with_foreign_url', candidate, lambda x: x.update(operation='set_value', parameters={'textRef':'t1','urlRef':'u1'}), 'Candidate')
    invalid('set_value_without_text', candidate, lambda x: x.update(operation='set_value', parameters={}), 'Candidate')
    invalid('invoke_without_target', candidate, lambda x: (x.update(operation='invoke'), x.pop('targetRef')), 'Candidate')
    invalid('unbounded_scroll_amount', candidate, lambda x: x.update(operation='scroll', parameters={'direction':'down','amount':'infinite'}), 'Candidate')
    invalid('arbitrary_key_code', candidate, lambda x: x.update(operation='key_chord', parameters={'keyCode':24}), 'Candidate')
    invalid('upload_without_destination', candidate, lambda x: x.update(operation='upload', parameters={'fileRef':'f1'}), 'Candidate')
    invalid('download_without_destination', candidate, lambda x: x.update(operation='download', parameters={}), 'Candidate')
    invalid('switch_tab_without_identity', candidate, lambda x: x.update(operation='tab_operation', parameters={'tabOperation':'switch'}), 'Candidate')
    invalid('inspect_with_excessive_nodes', candidate, lambda x: x.update(operation='inspect', delivery='controller', effects=['READ'], parameters={'regionRef':'r1','maxNodes':101}), 'Candidate')
    invalid('wait_without_bound', candidate, lambda x: x.update(operation='wait', delivery='controller', effects=['READ'], parameters={}), 'Candidate')
    invalid('finish_without_evidence_reference', candidate, lambda x: x.update(operation='finish', delivery='controller', effects=['READ'], parameters={}), 'Candidate')
    invalid('meta_action_as_pointer_effect', ex[1]['data']['candidates'][1], lambda x: x.update(delivery='foreground_input'), 'Candidate')
    invalid('duplicate_effect', candidate, lambda x: x.update(effects=['READ','READ']), 'Candidate')
    invalid('unknown_operation', candidate, lambda x: x.update(operation='shell'), 'Candidate')
    invalid('comparison_without_expected_value', {'kind':'value_equals'}, lambda x: None, 'Verifier')
    invalid('incomplete_browser_identity', ex[11], lambda x: x['data']['surface'].pop('documentId'))
    invalid('truncation_claimed_complete', ex[1], lambda x: x['data'].update(truncated=True, coverage='complete'))
    invalid('target_without_fingerprint', ex[1]['data']['targets'][0], lambda x: x.pop('identityFingerprint'), 'Target')
    invalid('current_fact_without_observation', ex[2]['context']['verifiedFacts'][0], lambda x: x.pop('observationId'), 'Fact')
    invalid('completed_status_without_evidence', ex[10], lambda x: x.update(status='completed'))
    invalid('multi_use_permit', ex[7], lambda x: x.update(uses=2))
    invalid('multi_use_approval', ex[12], lambda x: x.update(uses=2))
    invalid('approval_without_prompt', ex[12], lambda x: x.pop('promptId'))
    invalid('approval_with_non_elevated_effect', ex[12], lambda x: x.update(approvedEffects=['READ']))
    invalid('execution_without_policy_revision', ex[4], lambda x: x.pop('policyRevision'))
    invalid('permit_without_policy_revision', ex[7], lambda x: x.pop('policyRevision'))
    invalid('clarification_without_observation_identity', ex[13], lambda x: x.pop('observationId'))
    invalid('resume_without_checkpoint_digest', ex[14], lambda x: x.pop('checkpointDigest'))
    invalid('resume_with_old_protocol', ex[14], lambda x: x.update(protocolVersion='1.0'))
    invalid('old_protocol_version', ex[0], lambda x: x.update(protocolVersion='1.0'))
    invalid('invalid_timestamp', ex[5], lambda x: x.update(finishedAt='tomorrow'))
    invalid('negative_probability', ex[3], lambda x: x['ranked'][0].update(probability=-0.1))
    invalid('private_fields_in_provider_view', ex[2]['providerView'], lambda x: x.update(bindings=[]), 'ProviderView')
    invalid('false_cancel_barrier', ex[9], lambda x: x.update(barrierApplied=False))
    invalid('visual_target_without_capture', ex[1]['data']['targets'][0], lambda x: x.update(source='vision'), 'Target')
    invalid('visual_surface_without_capture', ex[1]['data']['surface'], lambda x: x.update(adapter='vision'), 'Surface')
    invalid('upload_verifier_without_receipt_target', {'kind':'upload_complete'}, lambda x: None, 'Verifier')
    invalid('partial_transcript_as_committed_command', ex[0], lambda x: x.update(isFinal=False))
    invalid('unsafe_integer_epoch', ex[0], lambda x: x.update(taskEpoch=2**53))
    # Objective uncertainty must not erase known delivery/effect history.
    for effect, delivery in (('applied', 'dispatched'), ('not_applied', 'not_dispatched')):
        receipt = copy.deepcopy(ex[8]); receipt.update(effectStatus=effect, deliveryStatus=delivery)
        test('valid_outcome_dimensions', effect, lambda r=receipt: validate(r))
    def bundle():
        request, proposal, execution, permit = (copy.deepcopy(ex[i]) for i in (2,3,4,7))
        return request, proposal, execution, permit
    test('semantic_accept', 'valid_proposal_and_permit', lambda: FixtureGuard(ex[2]).check(*bundle()))
    def bad_semantic(name: str, mutate: Callable[[tuple], None], **kw: Any) -> None:
        messages = bundle(); mutate(messages)
        test('semantic_reject', name, lambda: FixtureGuard(ex[2]).check(*messages, **kw), rejection=True)
    bad_semantic('unknown_selected_candidate', lambda x: x[1].update(selectedCandidateId='invented'))
    bad_semantic('stale_task_epoch', lambda x: x[1].update(taskEpoch=0))
    bad_semantic('stale_goal_revision', lambda x: x[1].update(goalRevision=0))
    bad_semantic('wrong_request_correlation', lambda x: x[1].update(requestId='another'))
    bad_semantic('rebound_request_id', lambda x: (x[0].update(requestId='another'), x[1].update(requestId='another')))
    bad_semantic('extended_request_deadline', lambda x: x[0].update(deadline='2026-09-25T18:00:00Z'))
    bad_semantic('mutated_target_registry', lambda x: x[0]['observation']['targets'][0].update(identityFingerprint='c'*64))
    bad_semantic('changed_surface_same_observation', lambda x: x[0]['observation']['surface'].update(contentRevision='new'))
    bad_semantic('stale_observation', lambda x: x[1].update(observationId='old'))
    bad_semantic('wrong_candidate_digest', lambda x: x[1].update(candidateSetDigest='f'*64))
    bad_semantic('changed_provider_projection', lambda x: x[0]['providerView'].update(stateText='New unapproved contents'))
    bad_semantic('projection_response_mismatch', lambda x: x[1].update(providerViewDigest='f'*64))
    bad_semantic('duplicate_ranked_id', lambda x: x[1]['ranked'][1].update(candidateId='a17'))
    bad_semantic('missing_ranked_candidate', lambda x: x[1]['ranked'].pop())
    bad_semantic('distribution_not_normalized', lambda x: x[1]['ranked'][0].update(probability=0.8))
    bad_semantic('selection_not_top_ranked', lambda x: x[1].update(selectedCandidateId='help'))
    bad_semantic('scope_widening', lambda x: x[0]['context'].update(scopeRef='new-scope'))
    bad_semantic('binding_value_substituted', lambda x: x[0]['context']['bindings'][0].update(value='Downloads'))
    bad_semantic('stale_fact', lambda x: x[0]['context']['verifiedFacts'][0].update(observationId='old'))
    bad_semantic('task_budget_exhausted', lambda x: x[0]['context'].update(stepCount=30))
    bad_semantic('old_writer_lease', lambda x: x[2].update(leaseGeneration=2))
    bad_semantic('expired_permit', lambda x: x[3].update(expiresAt='2026-09-25T17:00:01Z'))
    bad_semantic('changed_action_digest', lambda x: x[2].update(actionDigest='f'*64))
    bad_semantic('model_issued_permit', lambda x: None, producer='model')
    bad_semantic('unapproved_external_provider', lambda x: x[1]['provider'].update(location='external_service'))
    bad_semantic('research_provider_enabled', lambda x: x[1]['provider'].update(name='semif'))
    bad_semantic('target_disappeared', lambda x: None, live_targets=[])
    changed = copy.deepcopy(ex[1]['data']['targets']);changed[0]['identityFingerprint']='c'*64
    bad_semantic('target_reidentified_differently', lambda x: None, live_targets=changed)
    changed = copy.deepcopy(ex[1]['data']['targets']);changed[0]['enabled']=False
    bad_semantic('target_disabled', lambda x: None, live_targets=changed)
    bad_semantic('target_ambiguous', lambda x: None, live_targets=ex[1]['data']['targets']*2)
    def replay():
        g=FixtureGuard(ex[2]); messages=bundle();g.consume(*messages);g.consume(*messages)
    test('semantic_reject','single_use_permit_replay',replay,True)
    def cancelled():
        g=FixtureGuard(ex[2]);g.cancel();g.check(*bundle())
    test('semantic_reject','response_after_cancel',cancelled,True)
    def offline():
        messages=bundle();messages[0]['privacyMode']='offline'
        FixtureGuard(messages[0]).check(*messages)
    test('semantic_reject','offline_mode_remote_response_rejected',offline,True)
    test('retry_policy','unknown_effect_cannot_retry', lambda: require(not retry_permitted(candidate,ex[8],fresh_not_applied=True), 'unsafe retry'))
    good_no_effect=copy.deepcopy(ex[5]);good_no_effect.update(outcome='failed',deliveryStatus='not_dispatched',effectStatus='not_applied',verification='unavailable',evidence=[])
    test('retry_policy','known_not_dispatched_retry',lambda: require(retry_permitted(candidate,good_no_effect,fresh_not_applied=True),'expected reviewed retry'))
    test('retry_policy','no_fresh_proof_no_retry',lambda: require(not retry_permitted(candidate,good_no_effect,fresh_not_applied=False),'unsafe retry'))
    test('parser','duplicate_json_key_rejected',lambda:strict_loads('{"x":1,"x":2}'),True)
    test('parser','NaN_rejected',lambda:strict_loads('{"p":NaN}'),True)
    test('parser','Infinity_rejected',lambda:strict_loads('{"p":Infinity}'),True)
    test('parser','exponent_overflow_rejected',lambda:strict_loads('{"latencyMs":1e999}'),True)
    test('parser','unsafe_integer_rejected',lambda:strict_loads('{"taskEpoch":9007199254740993}'),True)
    test('parser','valid_strict_JSON',lambda:require(strict_loads('{"x":1}')=={'x':1},'parser'))
    text='Find caf\u00e9.txt'; start=len('Find '.encode());end=len(text.encode())
    binding={'bindingId':'name','source':'transcript_span','value':'caf\u00e9.txt','sourceRef':'utterance-1-r1','sensitivity':'normal','sourceStart':start,'sourceEnd':end,'offsetUnit':'utf8_bytes'}
    test('span','valid_unicode_span',lambda:check_span(binding,{'utterance-1-r1':text}))
    bad=copy.deepcopy(binding);bad['sourceEnd']=9
    test('span','split_utf8_character_rejected',lambda:check_span(bad,{'utterance-1-r1':text}),True)
    bad2=copy.deepcopy(binding);bad2['value']='another.txt'
    test('span','changed_transcript_value_rejected',lambda:check_span(bad2,{'utterance-1-r1':text}),True)
    test('span','missing_source_rejected',lambda:check_span(binding,{}),True)
    test('digest','candidate_golden_hash',lambda:require(digest(ex[1]['data']['candidates'])==ex[1]['data']['candidateSetDigest'],'hash mismatch'))
    test('digest','projection_golden_hash',lambda:require(digest(ex[2]['providerView'])==ex[2]['providerViewDigest'],'hash mismatch'))
    test('digest','action_golden_hash',lambda:require(action_digest(ex[2],candidate)==ex[4]['actionDigest'],'hash mismatch'))
    test('digest','float_digest_rejected',lambda:digest({'p':0.1}),True)
    test('digest','non_ascii_digest_key_rejected',lambda:digest({'\u00e9':1}),True)
    groups={name:sum(r['group']==name for r in results) for name in sorted({r['group'] for r in results})}
    return {'protocolVersion':'2.0','passed':sum(r['passed'] for r in results),'total':len(results),'groups':groups,
            'scope':'Synthetic contract checks only; no OS/model/runtime execution or concurrency validation.',
            'tests':results}


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json',action='store_true',help='Print the machine-readable test report')
    args=parser.parse_args();report=run()
    if args.json:
        print(json.dumps(report,indent=2))
    else:
        for result in report['tests']:
            if not result['passed']:
                print('FAIL:',result['test'],result.get('error',''))
        print(f"{report['passed']}/{report['total']} contract checks passed.")
        for group,count in report['groups'].items(): print(f'  {group}: {count}')
        print(report['scope'])
    return 0 if report['passed']==report['total'] else 1

if __name__=='__main__':
    sys.exit(main())
