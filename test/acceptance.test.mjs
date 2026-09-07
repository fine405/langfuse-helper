import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPhase1 } from '../scripts/acceptance.mjs';

function fixture() {
  const spans = ['turn1', 'turn2'].flatMap(traceId => ['interaction', 'model_stream', 'tool'].map((type, i) => ({
    traceId, spanId: `${traceId}-${i}`, startTimeUnixNano: '1000000000', endTimeUnixNano: '5000000000',
    attributes: { 'span.type': type, 'langfuse.session.id': 'test-session',
      ...(type === 'tool' ? { 'tool.call_id': `${traceId}-call` } : {}),
      'langfuse.observation.type': ['agent', 'generation', 'tool'][i], 'workbuddy.langfuse.source': 'native-preview' },
  })));
  const hooks = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].flatMap(hook_event_name =>
    [1, 2].map(turn => ({ hook_event_name, session_id: 'test-session', source: 'workbuddy-hook', tool_use_id: `turn${turn}-call` })));
  return { spans, hooks };
}

test('complete native turns pass; unrelated auxiliary spans do not cause false failures', () => {
  const { spans, hooks } = fixture();
  spans.push({ traceId: 'auxiliary', spanId: 'aux', attributes: {} });
  const result = assessPhase1(spans, hooks, 'test-session');
  assert.equal(result.passed, true);
  assert.equal(result.summary.spans, 6);
  assert.equal(result.summary.modelsWithUsage, 0);
});

test('real desktop failure: missing child sessions and absent hooks block acceptance', () => {
  const { spans } = fixture();
  for (const span of spans.filter(span => span.attributes['span.type'] === 'tool')) delete span.attributes['langfuse.session.id'];
  const result = assessPhase1(spans, [], 'test-session');
  assert.equal(result.passed, false);
  assert.equal(result.checks.modelAndToolInEachTrace, true);
  assert.equal(result.checks.sessionOnEverySpan, false);
  assert.equal(result.checks.hooksForBothTurns, false);
  assert.equal(result.summary.missingSession, 2);
});

test('duplicate spans and a missing second turn cannot pass acceptance', () => {
  const { spans, hooks } = fixture();
  assert.equal(assessPhase1([...spans, spans[1]], hooks, 'test-session').checks.noDuplicateSpans, false);
  assert.equal(assessPhase1(spans.slice(0, 3), hooks, 'test-session').passed, false);
});

test('synthetic data never substitutes for a desktop acceptance run', () => {
  const { spans, hooks } = fixture();
  for (const span of spans) span.attributes['workbuddy.langfuse.source'] = 'synthetic';
  for (const hook of hooks) hook.source = 'synthetic';
  const result = assessPhase1(spans, hooks, 'test-session');
  assert.equal(result.passed, false);
  assert.equal(result.summary.spans, 0);
  assert.equal(result.checks.hooksForBothTurns, false);
});

test('repeated hooks from one tool cannot substitute for the second tool hooks', () => {
  const { spans, hooks } = fixture();
  for (const hook of hooks) hook.tool_use_id = 'turn1-call';
  const result = assessPhase1(spans, hooks, 'test-session');
  assert.equal(result.hookCounts.PreToolUse, 2);
  assert.equal(result.checks.hooksForBothTurns, false);
});
