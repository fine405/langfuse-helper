import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAgent, saveAgent } from './profiles.mjs';
import { readConfig, projectRoot } from './settings.mjs';
import { connectLangfuse, observationsForTrace } from './delivery.mjs';
import { capture, readRollout, recordsForTurn } from '../plugins/codex-langfuse/runtime/hook.mjs';
import { spansFrom } from './data.mjs';
import { compareObservations } from './verify-langfuse.mjs';

// Explicit integration command: sends synthetic content only, with isolated local state.
const source = process.env.LANGFUSE_HELPER_TEST_CONFIG ? readConfig({ file: process.env.LANGFUSE_HELPER_TEST_CONFIG, env: {} }) : resolveAgent('codex');
const connected = await connectLangfuse(source);
const directory = await mkdtemp(join(tmpdir(), 'helper-codex-remote-'));
const previous = process.env.LANGFUSE_HELPER_HOME;
process.env.LANGFUSE_HELPER_HOME = directory;
try {
  const config = saveAgent('codex', 'synthetic', { ...source, enabled: true, content: 'text' }, connected);
  const folder = join(directory, 'sessions/2026/09/08'); await mkdir(folder, { recursive: true });
  const file = join(folder, 'rollout-selftest.jsonl'), sessionId = `codex-selftest-${randomUUID()}`;
  const fixture = await readFile(join(projectRoot, 'test/fixtures/codex/sessions/2026/06/03/rollout-basic-main.jsonl'), 'utf8');
  const offset = Date.now() - 10000 - Date.parse('2026-06-03T10:00:00.000Z');
  await writeFile(file, fixture.trim().split('\n').map(line => {
    const event = JSON.parse(line.replaceAll('sess-basic', sessionId));
    event.timestamp = new Date(Date.parse(event.timestamp) + offset).toISOString();
    return JSON.stringify(event);
  }).join('\n') + '\n');
  const parsed = await readRollout(file);
  const expected = spansFrom((await recordsForTurn(file, parsed, parsed.turns[0], config)).map(record => record.payload));
  const first = await capture({ transcript_path: file });
  assert.equal(first.uploaded, 4);
  assert.equal((await capture({ transcript_path: file })).uploaded, 0);
  let result, actual;
  for (let i = 0; i < 30; i++) {
    actual = await observationsForTrace(connected.request, expected[0].traceId);
    result = compareObservations(expected, actual, `codex:${sessionId}`);
    if (result.passed) break;
    await delay(1000);
  }
  assert.equal(result.passed, true, JSON.stringify(result));
  const tokenBreakdown = Object.fromEntries(['input', 'input_cached', 'output', 'output_reasoning'].map(key => [key, actual.reduce((sum, row) => sum + (row.usageDetails?.[key] || 0), 0)]));
  assert.equal(Object.values(tokenBreakdown).reduce((sum, value) => sum + value, 0), 300);
  const checks = Object.fromEntries(Object.entries(result.checks).filter(([key]) => !['credits', 'configuredCost'].includes(key)));
  console.log(JSON.stringify({ passed: true, sessionId: `codex:${sessionId}`, checks, observations: result.observations, tokenBreakdown,
    repeatedHookUploaded: 0, note: 'Synthetic Codex rollout retained in Langfuse; no user conversation or Codex login data was read.' }, null, 2));
} finally {
  if (previous === undefined) delete process.env.LANGFUSE_HELPER_HOME; else process.env.LANGFUSE_HELPER_HOME = previous;
  await rm(directory, { recursive: true, force: true });
}
