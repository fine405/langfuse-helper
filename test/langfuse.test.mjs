import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryLedger, selectSession, sendRecords } from '../scripts/langfuse.mjs';
import { compareObservations } from '../scripts/verify-langfuse.mjs';
import { spansFrom } from '../scripts/data.mjs';

function fixture() {
  const traceId = 'a'.repeat(32), sessionId = 'session';
  const span = (id, type, parentSpanId) => ({ traceId, spanId: id.repeat(16), parentSpanId,
    startTimeUnixNano: '1788800000000000000', endTimeUnixNano: '1788800003000000000',
    attributes: Object.entries({ 'span.type': type, 'langfuse.session.id': sessionId,
      'langfuse.observation.type': type === 'interaction' ? 'agent' : 'generation',
      ...(type === 'model_stream' ? { 'langfuse.observation.model.name': 'test', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20 } : {}),
    }).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } })) });
  return { sessionId, batches: [{ resourceSpans: [{ scopeSpans: [{ spans: [span('1', 'interaction', 'f'.repeat(16)), span('2', 'model_stream', '1'.repeat(16))] }] }] }] };
}

test('session selection preserves child hierarchy, makes external interaction boundary explicit, and rejects internal gaps/conflicts', () => {
  const { sessionId, batches } = fixture();
  const original = JSON.stringify(batches);
  const selected = selectSession(batches, sessionId);
  const spans = spansFrom(selected.map(record => record.payload));
  assert.equal(spans[0].parentSpanId, undefined);
  assert.equal(spans[0].attributes['langfuse.observation.metadata.nativeParentSpanId'], 'f'.repeat(16));
  assert.equal(spans[1].parentSpanId, '1'.repeat(16));
  assert.equal(JSON.stringify(batches), original);
  assert.equal(selectSession([...batches, ...batches], sessionId).length, 2);
  const child = batches[0].resourceSpans[0].scopeSpans[0].spans[1];
  child.parentSpanId = '3'.repeat(16);
  assert.throws(() => selectSession(batches, sessionId), /父 span/);
  child.parentSpanId = '1'.repeat(16);
  child.attributes.push({ key: 'workbuddy.langfuse.session.conflict', value: { stringValue: 'true' } });
  assert.throws(() => selectSession(batches, sessionId), /冲突/);
});

test('acknowledged delivery survives restart; project identity scopes the ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wb-lf-delivery-'));
  const file = join(directory, 'ledger.sqlite');
  const data = fixture(), records = selectSession(data.batches, data.sessionId);
  let ledger = new DeliveryLedger(file, 'project-1'), requests = 0;
  const request = async () => { requests++; return Response.json({}); };
  try {
    assert.equal(await sendRecords(records, ledger, request), 2);
    ledger.close(); ledger = new DeliveryLedger(file, 'project-1');
    assert.equal(await sendRecords(records, ledger, request), 0);
    assert.equal(requests, 1);
    assert.throws(() => ledger.pending([{ ...records[0], digest: 'changed' }]), /内容变化/);
    ledger.close(); ledger = new DeliveryLedger(file, 'project-2');
    assert.equal(ledger.pending(records).length, 2);
  } finally { ledger.close(); rmSync(directory, { recursive: true }); }
});

test('network ambiguity, partial rejection and crashed reservations block retry; definite auth rejection can retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wb-lf-delivery-'));
  const data = fixture(), records = selectSession(data.batches, data.sessionId);
  try {
    for (const [name, request] of [
      ['network', async () => { throw new Error('timeout'); }],
      ['partial', async () => Response.json({ partialSuccess: { rejectedSpans: 1 } })],
      ['server', async () => new Response('', { status: 500 })],
    ]) {
      const ledger = new DeliveryLedger(join(directory, `${name}.sqlite`), 'project');
      try { await assert.rejects(sendRecords(records, ledger, request)); assert.throws(() => ledger.pending(records), /不确定/); }
      finally { ledger.close(); }
    }
    const ledger = new DeliveryLedger(join(directory, 'auth.sqlite'), 'project');
    try {
      await assert.rejects(sendRecords(records, ledger, async () => new Response('', { status: 401 })), /401/);
      assert.equal(ledger.pending(records).length, 2);
      ledger.reserve(records);
      assert.throws(() => ledger.pending(records), /不确定/);
    } finally { ledger.close(); }
  } finally { rmSync(directory, { recursive: true }); }
});

test('remote verification detects duplicate observations, token inflation, content and missing session', () => {
  const data = fixture(), expected = spansFrom(selectSession(data.batches, data.sessionId).map(record => record.payload));
  const actual = expected.map(span => ({ id: span.spanId, traceId: span.traceId, parentObservationId: span.parentSpanId,
    sessionId: data.sessionId, type: span.attributes['langfuse.observation.type'].toUpperCase(),
    startTime: new Date(Number(BigInt(span.startTimeUnixNano) / 1000000n)).toISOString(),
    endTime: new Date(Number(BigInt(span.endTimeUnixNano) / 1000000n)).toISOString(),
    model: span.attributes['langfuse.observation.model.name'], input: null, output: null,
    usageDetails: span.attributes['span.type'] === 'model_stream' ? { input: 100, output: 20 } : {},
  }));
  assert.equal(compareObservations(expected, actual, data.sessionId).passed, true);
  const omitted = actual.map(({ usageDetails, input, output, ...rest }) => rest);
  assert.equal(compareObservations(expected, omitted, data.sessionId).checks.usage, false);
  assert.equal(compareObservations(expected, omitted, data.sessionId).checks.content, false);
  const unknownUsage = structuredClone(expected);
  delete unknownUsage[1].attributes['gen_ai.usage.input_tokens'];
  assert.equal(compareObservations(unknownUsage, actual, data.sessionId).checks.generationUsageAvailable, false);
  assert.equal(compareObservations(expected, [...actual, actual[1]], data.sessionId).passed, false);
  actual[1].usageDetails.input++;
  actual[0].sessionId = null;
  actual[0].input = 'unexpected content';
  const result = compareObservations(expected, actual, data.sessionId);
  assert.equal(result.checks.usage, false);
  assert.equal(result.checks.sessions, false);
  assert.equal(result.checks.content, false);
});
