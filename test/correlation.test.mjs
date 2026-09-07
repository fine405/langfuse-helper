import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore, readStore } from '../collector/trace-store.mjs';
import { spansFrom, summarize } from '../scripts/data.mjs';

const t1 = '1'.repeat(32), t2 = '2'.repeat(32);
const span = (traceId, number, session, type = 'tool') => ({ traceId, spanId: String(number).padStart(16, '0'),
  parentSpanId: '9'.repeat(16), startTimeUnixNano: '1000000000', endTimeUnixNano: '4000000000',
  attributes: [{ key: 'span.type', value: { stringValue: type } },
    ...(session ? [{ key: 'langfuse.session.id', value: { stringValue: session } }] : [])] });
const payload = (...spans) => ({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'test' }, spans }] }] });
const read = store => spansFrom(store.db.prepare('SELECT payload FROM observations ORDER BY seq').all().map(row => JSON.parse(row.payload)));

test('interleaved sessions and child-before-anchor arrivals never borrow another trace session', () => {
  const store = new TraceStore(':memory:');
  try {
    store.ingest(payload(span(t1, 1), span(t2, 2), span(t2, 3, 'session-b', 'interaction')));
    assert.deepEqual(store.stats(), { pending: 1, ready: 2 });
    assert.equal(read(store)[0].attributes['langfuse.session.id'], undefined);
    assert.equal(read(store)[1].attributes['langfuse.session.id'], 'session-b');
    store.ingest(payload(span(t1, 4, 'session-a', 'model_stream')));
    const records = read(store);
    assert.equal(records[0].attributes['langfuse.session.id'], 'session-a');
    assert.equal(records[0].attributes['workbuddy.langfuse.session.origin'], 'trace-id');
    assert.equal(records[0].parentSpanId, '9'.repeat(16));
    assert.equal(records[0].endTimeUnixNano, '4000000000');
    assert.equal(records[1].attributes['langfuse.session.id'], 'session-b');
    assert.deepEqual(store.stats(), { ready: 4 });
  } finally { store.close(); }
});

test('pending spans and learned associations survive restart without replaying or losing rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-lf-correlate-'));
  const path = join(dir, 'traces.sqlite');
  try {
    let store = new TraceStore(path);
    store.ingest(payload(span(t1, 1), span(t2, 2, 'b', 'interaction'))); store.close();
    store = new TraceStore(path);
    try { store.ingest(payload(span(t1, 3, 'a', 'interaction'), span(t2, 4))); } finally { store.close(); }
    const saved = readStore(path), records = spansFrom(saved.batches);
    assert.equal(records.length, 4);
    assert.deepEqual(saved.states, { ready: 4 });
    assert.deepEqual(records.map(row => row.attributes['langfuse.session.id']), ['a', 'b', 'a', 'b']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('conflicting sessions quarantine the trace and retract inferred associations', () => {
  const store = new TraceStore(':memory:');
  try {
    store.ingest(payload(span(t1, 1, 'a', 'interaction'), span(t1, 2)));
    store.ingest(payload(span(t1, 3, 'b', 'model_stream')));
    assert.deepEqual(store.stats(), { conflict: 3 });
    assert.equal(read(store)[1].attributes['langfuse.session.id'], undefined);
    assert.equal(read(store)[0].attributes['langfuse.session.id'], 'a');
    assert.equal(read(store)[2].attributes['langfuse.session.id'], 'b');
    assert.ok(read(store).every(row => row.attributes['workbuddy.langfuse.session.conflict'] === 'true'));
  } finally { store.close(); }
});

test('repeated deliveries remain visible and an invalid batch cannot partially change storage', () => {
  const store = new TraceStore(':memory:');
  try {
    const body = payload(span(t1, 1, 'a', 'interaction'));
    store.ingest(body); store.ingest(body);
    assert.equal(summarize(read(store)).duplicateIdentities, 1);
    assert.throws(() => store.ingest(payload(span(t2, 2, 'b'), span('invalid', 3))), /Invalid OTLP identity/);
    assert.equal(read(store).length, 2);
  } finally { store.close(); }
});
