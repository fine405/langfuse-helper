import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptStore, projectRecord } from '../scripts/transcript.mjs';
import { sanitizeContent, visibleText } from '../scripts/content.mjs';
import { enrichBatches, usageDetails, estimateCost } from '../scripts/enrichment.mjs';
import { attributes } from '../scripts/data.mjs';

const traceId = 'a'.repeat(32), sessionId = 'session';
const user = { id: 'user', type: 'message', role: 'user', sessionId, timestamp: 1000,
  content: [{ type: 'input_text', text: '<system-reminder>DO_NOT_STORE_SYSTEM</system-reminder><user_query>run demo</user_query>' }] };
const call = (callId = 'call-1') => ({ id: 'message-1', type: 'function_call', sessionId, callId, name: 'Bash', timestamp: 2000,
  arguments: '{"command":"printf test", "api_key":"PRIVATE_VALUE"}',
  message: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60 } },
  providerData: { traceId, messageId: 'message-1', model: 'actual-model', requestModelId: 'fast-model', reasoning: 'DO_NOT_STORE_REASONING',
    rawUsage: { prompt_tokens: 100, credit: 0.2 } } });
const result = { id: 'result', type: 'function_call_result', sessionId, timestamp: 3000, callId: 'call-1', status: 'completed',
  output: { type: 'text', text: 'test /Users/example/private' }, providerData: { traceId, messageId: 'message-1' } };
const batch = (type, extra = {}) => ({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId, spanId: '1'.repeat(16), attributes:
  Object.entries({ 'span.type': type, 'langfuse.session.id': sessionId, ...extra }).map(([key, value]) => ({ key,
    value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } })) }] }] }] });

test('content opt-in excludes system context and reasoning, redacts credentials and home paths, and marks truncation', () => {
  assert.equal(visibleText(user.content, 'user'), 'run demo');
  assert.equal(projectRecord(user, sessionId).content, undefined);
  assert.equal(projectRecord({ ...user, type: 'reasoning' }, sessionId, 'text'), null);
  assert.equal(projectRecord({ ...user, type: 'file-history-snapshot' }, sessionId, 'text'), null);
  const projected = [user, call(), result].map(record => projectRecord(record, sessionId, 'text'));
  const saved = JSON.stringify(projected);
  assert.ok(!/DO_NOT_STORE|PRIVATE_VALUE|Users\/example/.test(saved));
  assert.ok(saved.includes('[REDACTED]') && saved.includes('[HOME]'));
  assert.equal(sanitizeContent('a'.repeat(100), 20).truncated, true);
  assert.equal(sanitizeContent({ password: 'value', reasoning: 'secret' }).redacted, true);
});

test('transcript cursor commits complete lines only, survives restart and handles replacement without duplicate records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-lf-transcript-'));
  const path = join(directory, `${sessionId}.jsonl`), database = join(directory, 'state.sqlite');
  const line = JSON.stringify(call());
  let store = new TranscriptStore(database);
  try {
    await writeFile(path, `${JSON.stringify(user)}\n${line.slice(0, 40)}`);
    let read = await store.read(path, sessionId, { projectsDir: directory, content: 'text' });
    assert.equal(read.records, 1); assert.equal(read.partial, true);
    store.close(); store = new TranscriptStore(database);
    await appendFile(path, `${line.slice(40)}\n`);
    read = await store.read(path, sessionId, { projectsDir: directory, content: 'text' });
    assert.equal(read.records, 1); assert.equal(store.records(sessionId).length, 2);
    assert.equal((await store.read(path, sessionId, { projectsDir: directory, content: 'text' })).readBytes, 0);
    await writeFile(`${path}.new`, `${JSON.stringify(user)}\n${line}\n${JSON.stringify(result)}\n`);
    await rename(`${path}.new`, path);
    assert.equal((await store.read(path, sessionId, { projectsDir: directory, content: 'text' })).reset, true);
    assert.equal(store.records(sessionId).length, 3);
    await writeFile(path, `${JSON.stringify(user)}\n`);
    assert.equal((await store.read(path, sessionId, { projectsDir: directory, content: 'text' })).reset, true);
    assert.equal(store.records(sessionId).length, 3);
    await assert.rejects(store.read(path, sessionId, { projectsDir: directory, content: 'metadata' }), /cannot change content mode/);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test('invalid complete lines roll back their whole read; unrelated paths and sessions cannot be imported', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-lf-transcript-'));
  const path = join(directory, `${sessionId}.jsonl`), store = new TranscriptStore(':memory:');
  try {
    await writeFile(path, `${JSON.stringify(user)}\ninvalid\n`);
    await assert.rejects(store.read(path, sessionId, { projectsDir: directory }));
    assert.equal(store.records(sessionId).length, 0);
    await writeFile(path, `${JSON.stringify(user)}\n`);
    assert.equal((await store.read(path, sessionId, { projectsDir: directory })).records, 1);
    await assert.rejects(store.read(path, 'another-session', { projectsDir: directory }), /does not match/);
    assert.equal(projectRecord({ ...user, sessionId: 'another' }, sessionId, 'text'), null);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test('one model response with multiple tool calls contributes usage and credits once, while tool content is paired by call ID', () => {
  const records = [user, call(), call('call-2'), result].map(record => projectRecord(record, sessionId, 'text'));
  const modelBatch = batch('model_stream', { 'workbuddy.message_id': 'message-1', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20 });
  const toolBatch = batch('tool', { 'tool.call_id': 'call-1' });
  const enriched = enrichBatches([modelBatch, toolBatch], records, { content: 'text' });
  const getAttrs = index => attributes(enriched[index].resourceSpans[0].scopeSpans[0].spans[0].attributes);
  const model = getAttrs(0), tool = getAttrs(1);
  assert.deepEqual(JSON.parse(model['langfuse.observation.usage_details']), { input: 40, input_cached: 60, output: 20 });
  assert.equal(model['langfuse.observation.metadata.workbuddyCredits'], 0.2);
  assert.equal(model['langfuse.observation.model.name'], 'actual-model');
  assert.equal(JSON.parse(model['langfuse.observation.output']).length, 2);
  assert.equal(model['langfuse.observation.input'], 'run demo');
  assert.ok(tool['langfuse.observation.input'].includes('[REDACTED]'));
  assert.equal(tool['langfuse.observation.output'], 'test [HOME]/private');
  assert.equal(tool['langfuse.observation.usage_details'], undefined);
  const metadata = enrichBatches([modelBatch], records)[0];
  assert.equal(attributes(metadata.resourceSpans[0].scopeSpans[0].spans[0].attributes)['langfuse.observation.input'], undefined);
  // Real 5.5.3 parallel responses attach usage only to the last function_call.
  delete records[1].usage;
  const sparse = attributes(enrichBatches([modelBatch], records, { content: 'text' })[0].resourceSpans[0].scopeSpans[0].spans[0].attributes);
  assert.equal(JSON.parse(sparse['langfuse.observation.output']).length, 2);
  assert.deepEqual(JSON.parse(sparse['langfuse.observation.usage_details']), { input: 40, input_cached: 60, output: 20 });
});

test('cache sums, unknown conventions and native usage disagreement cannot silently inflate usage', () => {
  const record = projectRecord(call(), sessionId);
  assert.throws(() => usageDetails({ ...record, inputIncludesCache: false }), /unverified/);
  assert.throws(() => usageDetails({ ...record, usage: { ...record.usage, cacheRead: 101 } }), /exceeds/);
  assert.throws(() => enrichBatches([batch('model_stream', { 'workbuddy.message_id': 'message-1', 'gen_ai.usage.input_tokens': 99 })], [record]), /disagree/);
});

test('USD estimates require explicit prices and provenance; unknown WorkBuddy monetary cost stays absent', () => {
  const usage = { input: 40, input_cached: 60, output: 20 };
  assert.equal(estimateCost(usage), null);
  const price = { currency: 'USD', source: 'synthetic verification fixture', perMillion: { input: 2, input_cached: 0.5, output: 8 } };
  const cost = estimateCost(usage, price);
  assert.ok(Math.abs(cost.total - 0.00027) < 1e-12);
  assert.throws(() => estimateCost(usage, { ...price, currency: 'CNY' }), /USD/);
  assert.throws(() => estimateCost(usage, { ...price, perMillion: { input: 2, output: 8 } }), /input_cached/);
});
