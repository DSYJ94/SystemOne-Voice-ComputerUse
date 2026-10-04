import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questionKind, taskRecord } from '../src/telemetry.ts';

test('a trace becomes one structured task record with steps, judgments and feedback', () => {
  const events = [
    { at: '2026-10-04T10:00:00.000Z', kind: 'goal', goal: 'open the latest email' },
    { at: '2026-10-04T10:00:00.100Z', kind: 'understanding', by: 'jev', answer: false, typed: null },
    { at: '2026-10-04T10:00:00.300Z', kind: 'judgment', ms: 210,
      request: { state: 'Goal: open the latest email.', questions: { next_action: {
        instructions: 'Choose the one offered action that best moves the user toward their goal right now.',
        criteria: { c0: 'open the row “Acme”', finish: 'Done' } } } },
      answer: { model: 'jev-1.13.0', answers: { next_action: { probabilities: { c0: 0.9, finish: 0.1 } } } } },
    { at: '2026-10-04T10:00:00.400Z', kind: 'step', step: 1, app: 'Google Chrome', window: 'Inbox', url: 'https://mail.google.com/',
      chosen: 'press', label: 'Acme', risky: false, options: 40, elements: 60, decideMs: 210, done: 0, via: 'dom' },
    { at: '2026-10-04T10:00:00.900Z', kind: 'result', step: 1, changed: true, actMs: 300, verifyMs: 200 },
    { at: '2026-10-04T10:00:01.000Z', kind: 'end', outcome: 'completed' },
    { at: '2026-10-04T10:00:05.000Z', kind: 'feedback', value: 'bad', reason: 'wrong_steps', note: 'the newest is Sam', attachments: ['a.png'] },
  ];
  const record = taskRecord(events, '2026-10-04T10-00-00-000Z-abcd1234', '00000000-0000-4000-8000-000000000000');
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.task.goal, 'open the latest email');
  assert.equal(record.task.outcome, 'completed');
  assert.equal(record.steps[0]!.changed, true);
  assert.equal(record.judgments[0]!.kind, 'choose_step');
  assert.equal(record.judgments[0]!.pick, 'c0');
  assert.equal(record.judgments[0]!.decidedStep, 1);
  assert.deepEqual(record.feedback[0]!.attachments, ['a.png']);
  assert.equal(record.feedback[0]!.note, 'the newest is Sam');
});

test('every question SystemOne asks is classified', () => {
  assert.equal(questionKind('Has everything the user asked for already happened, so nothing else needs to be done?'), 'is_done');
  assert.equal(questionKind('Which text contains the information the user asked for?'), 'which_answer');
  assert.equal(questionKind('Some requests include words to type into a search box, message or note. Which candidate is exactly those words'), 'pick_words');
  assert.equal(questionKind('Does the user want to be told something (an answer, a value, or text read out), or want something done on the computer?'), 'question_or_action');
  assert.equal(questionKind('Which System Settings pane does the user need?'), 'which_item');
});
