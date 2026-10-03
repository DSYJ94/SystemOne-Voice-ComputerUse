import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentGoal } from '../src/agent-goal.ts';

const APPS = ['WhatsApp', 'Google Chrome', 'Notes'];

test('quitting or closing is only in scope when the request says so', () => {
  const close = parseAgentGoal('close WhatsApp', APPS);
  assert.equal(close.quit, true);
  assert.equal(close.app, 'WhatsApp');
  assert.equal(parseAgentGoal('close the empty new tabs', APPS).quit, true);
  assert.equal(parseAgentGoal('reply to Sam saying see you at 7', APPS).quit, false);
  assert.equal(parseAgentGoal('open the football group chat', APPS).quit, false);
});

test('a reply with no words asks instead of guessing', () => {
  assert.equal(parseAgentGoal('Reply in the current chat', APPS).needsText, true);
  assert.equal(parseAgentGoal('message Priya', APPS).needsText, true);
  assert.equal(parseAgentGoal('reply saying I will be there at six', APPS).needsText, false);
  assert.equal(parseAgentGoal('message Priya on Slack saying running late', APPS).needsText, false);
  assert.equal(parseAgentGoal('copy the amount and paste it in the reply', APPS).needsText, false);
  assert.equal(parseAgentGoal('open Messages', APPS).needsText, false);
});
