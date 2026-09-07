import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { langfuseConfig, DeliveryLedger, sendRecords } from './langfuse.mjs';
import { compareObservations } from './verify-langfuse.mjs';
import { spansFrom } from './data.mjs';
import { reconcileDeliveries } from './recovery.mjs';

// Explicit opt-in integration command: creates clearly tagged synthetic records in the configured project.
const { request, base } = langfuseConfig();
const projectResponse = await request('/api/public/projects');
assert.ok(projectResponse.ok, 'Langfuse project authentication');
const project = (await projectResponse.json()).data[0];
const directory = await mkdtemp(join(tmpdir(), 'wb-lf-remote-test-'));
const traceId = randomBytes(16).toString('hex'), rootId = randomBytes(8).toString('hex');
const sessionId = `workbuddy-selftest-${traceId}`;
const now = BigInt(Date.now()) * 1000000n;
const kv = object => Object.entries(object).map(([key, value]) => ({ key, value: typeof value === 'number' ? { doubleValue: value }
  : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } }));
const make = (type, extra, isRoot = false) => ({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId,
  spanId: isRoot ? rootId : randomBytes(8).toString('hex'), ...(isRoot ? {} : { parentSpanId: rootId }), name: `workbuddy-selftest-${type}`,
  startTimeUnixNano: String(now - 3000000000n), endTimeUnixNano: String(now), attributes: kv({
    'span.type': type === 'agent' ? 'interaction' : type === 'generation' ? 'model_stream' : 'tool',
    'langfuse.observation.type': type, 'langfuse.session.id': sessionId,
    'langfuse.trace.name': 'WorkBuddy plugin synthetic verification', 'workbuddy.langfuse.source': 'synthetic', ...extra,
  }),
}] }] }] });
const batches = [make('agent', {}, true), make('generation', {
  'langfuse.observation.model.name': 'workbuddy-pricing-fixture',
  'langfuse.observation.usage_details': { input: 40, input_cached: 60, output: 20 },
  'langfuse.observation.cost_details': { input: 0.00008, input_cached: 0.00003, output: 0.00016, total: 0.00027 },
  'langfuse.observation.metadata.priceSource': 'synthetic fixture; not a real model price',
  'langfuse.observation.metadata.workbuddyCredits': 0.2,
  'langfuse.observation.input': 'synthetic user query',
  'langfuse.observation.output': [{ type: 'tool_call', id: 'selftest-tool', name: 'Bash', arguments: { command: 'printf test' } }],
}), make('tool', { 'langfuse.observation.input': { command: 'printf test' }, 'langfuse.observation.output': 'test' })];
const expected = spansFrom(batches);
const records = batches.map((payload, index) => ({ key: `${traceId}:${expected[index].spanId}`, payload, digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }));
let ledger = new DeliveryLedger(join(directory, 'ledger.sqlite'), `${base}/${project.id}`);
try {
  await assert.rejects(sendRecords(records, ledger, async body => {
    const response = await request('/api/public/otel/v1/traces', { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' } });
    assert.ok(response.ok, 'Real ingestion must succeed before injecting a lost acknowledgement');
    throw new Error('Injected loss of acknowledgement after actual Langfuse ingestion');
  }), /不确定/);
  ledger.close(); ledger = new DeliveryLedger(join(directory, 'ledger.sqlite'), `${base}/${project.id}`);
  assert.equal(ledger.uncertain().length, 3);
  let result;
  for (let i = 0; i < 30; i++) {
    const response = await request(`/api/public/v2/observations?traceId=${traceId}&limit=100&fields=basic,io,metadata,usage,model,time`);
    assert.ok(response.ok, 'Langfuse observations query');
    result = compareObservations(expected, (await response.json()).data, sessionId);
    if (result.passed) break;
    await delay(1000);
  }
  assert.equal(result.passed, true, JSON.stringify(result));
  const recovered = await reconcileDeliveries(ledger, request);
  assert.equal(recovered.length, 3);
  assert.ok(recovered.every(item => item.status === 'accepted'));
  ledger.close(); ledger = new DeliveryLedger(join(directory, 'ledger.sqlite'), `${base}/${project.id}`);
  assert.equal(await sendRecords(records, ledger, () => { throw new Error('Repeated send must not make a request'); }), 0);
  console.log(JSON.stringify({ passed: true, project: project.name, sessionId, ...result, lostAcknowledgementRecoveredWithoutReplay: true,
    note: 'Synthetic integration records retained and clearly tagged; no real prices or WorkBuddy billing asserted.' }, null, 2));
} finally { ledger.close(); await rm(directory, { recursive: true }); }
