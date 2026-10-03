import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentGoal, refineGoal, spanCandidates } from '../src/agent-goal.ts';

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

test('sites, tabs and apps are recognised wherever the request names them', () => {
  assert.equal(parseAgentGoal('Go to the Gmail inbox', APPS).url, 'https://gmail.com/');
  assert.equal(parseAgentGoal('go to the research page', APPS).url, null);
  assert.equal(parseAgentGoal('using this current tab go to Gmail', APPS).newTab, false);
  assert.equal(parseAgentGoal('open gmail in a new tab', APPS).newTab, true);
  assert.equal(parseAgentGoal('reply to Sam on WhatsApp saying hi', APPS).app, 'WhatsApp');
  assert.equal(parseAgentGoal('take notes about this page', APPS).app, null);
  assert.equal(parseAgentGoal('open Notes and type "milk"', APPS).app, 'Notes');
});

test('word runs are exact byte spans of what was said, and the chosen one becomes the typed text', async () => {
  const text = 'tell Zoë on slack café at 6, see you';
  const spans = spanCandidates(text);
  for (const span of spans) assert.equal(Buffer.from(text).subarray(span.start, span.end).toString(), span.text);
  assert.ok(spans.some(span => span.text === 'café at 6'));
  const goal = await refineGoal(text, parseAgentGoal(text, APPS), async (_request, role, list) =>
    role === 'typed' ? list.indexOf('café at 6') : null);
  assert.equal(goal.typedText?.text, 'café at 6');
  const none = await refineGoal('open chrome', parseAgentGoal('open chrome', APPS), async () => null);
  assert.equal(none.typedText, null);
});
