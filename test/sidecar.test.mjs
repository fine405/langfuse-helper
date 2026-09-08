import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../collector/trace-store.mjs';
import { Sidecar, enrichmentReady } from '../scripts/sidecar.mjs';
import { SidecarStore } from '../scripts/sidecar-store.mjs';
import { DeliveryLedger, sendRecords, selectSession } from '../scripts/langfuse.mjs';
import { reconcileDeliveries } from '../scripts/recovery.mjs';
import { reduceActivity, activityView } from '../scripts/activity.mjs';
import { defaults } from '../scripts/settings.mjs';

const trace = 'a'.repeat(32), sid = 's1';
const attr = data => Object.entries(data).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } }));
const span = (id, type, session = sid, traceId = trace) => ({ traceId, spanId: id.repeat(16), name: type,
  ...(type !== 'interaction' ? { parentSpanId: '1'.repeat(16) } : { parentSpanId: 'f'.repeat(16) }),
  startTimeUnixNano: '1788800000000000000', endTimeUnixNano: '1788800003000000000',
  attributes: attr({ 'span.type': type, ...(session ? { 'langfuse.session.id': session } : {}),
    'langfuse.observation.type': type === 'interaction' ? 'agent' : type === 'model_stream' ? 'generation' : type === 'tool' ? 'tool' : 'span',
    'workbuddy.message_id': 'message1', 'tool.call_id': 'call1', ...(type === 'model_stream' ? { 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10 } : {}) }) });
const batch = spans => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
const line = value => JSON.stringify(value) + '\n';
function records(sessionId = sid, traceId = trace) {
  return [
    { id: 'user1', sessionId, type: 'message', role: 'user', timestamp: 1, content: [{ type: 'text', text: 'hello' }] },
    { id: 'response1', sessionId, type: 'function_call', name: 'Bash', callId: 'call1', timestamp: 2, arguments: '{"command":"printf OK"}',
      providerData: { traceId, messageId: 'message1', model: 'model', rawUsage: { prompt_tokens: 100, credit: 0.1 } }, message: { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 60 } } },
    { id: 'result1', sessionId, type: 'function_call_result', callId: 'call1', timestamp: 3, status: 'completed', output: [{ type: 'text', text: 'OK' }], providerData: { traceId } },
  ];
}

test('automatic pipeline exports ended children before the root, isolates concurrent sessions, and survives restart without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb lf sidecar '));
  const projects = join(directory, 'projects'); await mkdir(projects);
  const corePath = join(directory, 'core.sqlite'), hooksPath = join(directory, 'hooks.jsonl');
  const core = new TraceStore(corePath);
  let service = new Sidecar({ directory, projectsDir: projects, hooksPath, corePath, settings: { ...defaults, content: 'text' } });
  let posts = 0;
  const configure = () => {
    service.ledger = new DeliveryLedger(join(directory, 'langfuse-deliveries.sqlite'), 'target');
    service.config = { base: 'http://test', project: { name: 'test' }, request: async (path) => { if (path.includes('/observations')) return Response.json({ data: [] }); posts++; return Response.json({}); } };
  };
  try {
    await service.initialize(); configure();
    core.ingest(batch([span('4', '', sid, trace), span('8', '', sid, 'c'.repeat(32))]));
    for (const [sessionId, traceId] of [[sid, trace], ['s2', 'b'.repeat(32)]]) {
      const path = join(projects, `${sessionId}.jsonl`);
      await writeFile(path, records(sessionId, traceId).map(line).join(''));
      await appendFile(hooksPath, line({ source: 'workbuddy-hook', hook_event_name: 'UserPromptSubmit', session_id: sessionId, contentMode: 'text', transcript_path: path, receivedAt: '2026-09-07T14:00:00Z' }));
      core.ingest(batch([span('2', 'model_stream', sessionId, traceId), span('3', 'tool', sessionId, traceId)]));
    }
    await service.capture();
    assert.equal(service.status().queue, 5, 'Keep untyped children of a native trace, exclude unrelated auxiliary traces');
    await service.deliver();
    assert.equal(posts, 1);
    assert.deepEqual(service.ledger.counts(), { accepted: 5 });
    // Missing parents are allowed while running; no synthetic running root is sent.
    assert.equal(service.ledger.db.prepare('SELECT count(*) AS n FROM deliveries WHERE identity LIKE ?').get(`%:${'1'.repeat(16)}`).n, 0);
    core.ingest(batch([span('1', 'interaction')]));
    await service.capture(); await service.deliver();
    assert.equal(service.ledger.counts().accepted, 6);
    service.close();
    service = new Sidecar({ directory, projectsDir: projects, hooksPath, corePath, settings: { ...defaults, content: 'text' } });
    await service.initialize(); configure();
    core.ingest(batch([span('2', 'model_stream'), span('3', 'tool'), span('1', 'interaction')]));
    await service.capture(); await service.deliver();
    assert.equal(posts, 2);
    assert.equal(service.status().queue, 0);
    assert.equal(service.ledger.counts().accepted, 6);
  } finally { service.close(); core.close(); await rm(directory, { recursive: true }); }
});

test('incremental native reader refreshes old pending rows; hook partial lines and replacement are replay safe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-lf-cursors-'));
  const store = new SidecarStore(join(directory, 'sidecar.sqlite')), core = new TraceStore(join(directory, 'core.sqlite'));
  const hooks = join(directory, 'hooks.jsonl');
  try {
    await store.hooks(hooks, { initialize: true }); store.native(core.db);
    core.ingest(batch([span('2', 'model_stream', null)])); store.native(core.db);
    assert.equal(store.db.prepare('SELECT state FROM native_pending WHERE seq = 1').get().state, 'pending');
    core.ingest(batch([span('1', 'interaction')])); store.native(core.db);
    assert.equal(store.db.prepare('SELECT state FROM native_pending WHERE seq = 1').get().state, 'ready');
    const event = line({ source: 'workbuddy-hook', hook_event_name: 'SubagentStart', session_id: sid, contentMode: 'metadata', transcript_path: join(directory, `${sid}.jsonl`), receivedAt: '2026-09-07T14:00:00Z' });
    await writeFile(hooks, event.slice(0, -1)); await store.hooks(hooks); assert.equal(store.sessions().length, 0);
    await appendFile(hooks, '\n'); await store.hooks(hooks);
    assert.equal(JSON.parse(store.sessions()[0].activity).subagents, 1);
    await rm(hooks); await writeFile(hooks, event + event); await store.hooks(hooks);
    assert.equal(JSON.parse(store.sessions()[0].activity).subagents, 1);
  } finally { store.close(); core.close(); await rm(directory, { recursive: true }); }
});

test('ambiguous accepted delivery reconciles by exact remote ID and digest, while absent/conflicting data cannot be blindly retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-lf-recovery-'));
  let ledger = new DeliveryLedger(join(directory, 'ledger.sqlite'), 'target');
  const selected = selectSession([batch([span('1', 'interaction')])], sid);
  let remote = [], posts = 0;
  try {
    await assert.rejects(sendRecords(selected, ledger, async body => {
      posts++;
      const sent = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans[0];
      remote = [{ traceId: sent.traceId, id: sent.spanId, metadata: { deliveryDigest: sent.attributes.find(item => item.key.endsWith('.deliveryDigest')).value.stringValue } }];
      throw new Error('response lost after server accepted');
    }));
    ledger.close(); ledger = new DeliveryLedger(join(directory, 'ledger.sqlite'), 'target');
    const query = async () => Response.json({ data: remote });
    const accepted = remote;
    remote = []; assert.equal((await reconcileDeliveries(ledger, query))[0].status, 'unconfirmed');
    assert.throws(() => ledger.pending(selected), /uncertain/);
    remote = [...accepted, ...accepted]; assert.equal((await reconcileDeliveries(ledger, query))[0].status, 'conflict');
    remote = [{ ...accepted[0], metadata: { deliveryDigest: 'wrong' } }]; assert.equal((await reconcileDeliveries(ledger, query))[0].status, 'conflict');
    remote = accepted; assert.equal((await reconcileDeliveries(ledger, query))[0].status, 'accepted');
    assert.equal(await sendRecords(selected, ledger, () => { posts++; }), 0); assert.equal(posts, 1);
  } finally { ledger.close(); await rm(directory, { recursive: true }); }
});

test('connection refusal is retryable without marking an uncertain send', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-lf-offline-'));
  const ledger = new DeliveryLedger(join(directory, 'ledger.sqlite'), 'target');
  const selected = selectSession([batch([span('1', 'interaction')])], sid);
  try {
    await assert.rejects(sendRecords(selected, ledger, async () => { throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } }); }));
    assert.equal(ledger.pending(selected).length, 1);
    assert.equal(await sendRecords(selected, ledger, async () => Response.json({})), 1);
  } finally { ledger.close(); await rm(directory, { recursive: true }); }
});

test('activity distinguishes permission, quiet periods, failed tool, cancelled turn and exited or reused worker PID', () => {
  const event = hook_event_name => ({ hook_event_name, receivedAt: '2026-09-07T14:00:00Z', workerPid: 123, workerIdentity: 'identity', tool_name: 'Bash', tool_use_id: '1' });
  let state = reduceActivity(undefined, event('UserPromptSubmit'));
  state = reduceActivity(state, event('PreToolUse')); assert.equal(state.phase, 'tool');
  assert.equal(activityView(state, { now: Date.parse(state.updatedAt) + 61000, identity: () => 'identity' }).quiet, true);
  state = reduceActivity(state, event('PermissionRequest')); assert.equal(state.phase, 'waiting');
  assert.equal(activityView(state, { now: Date.parse(state.updatedAt) + 61000, identity: () => 'identity' }).quiet, undefined);
  state = reduceActivity(state, event('PostToolUseFailure')); assert.equal(state.phase, 'running'); assert.equal(state.lastToolFailed, true);
  assert.equal(activityView(state, { identity: () => null }).phase, 'process-exited');
  assert.equal(activityView(state, { identity: () => 'other start time' }).phase, 'process-exited');
  assert.equal(reduceActivity({ ...state, phase: 'cancelled' }, event('Stop')).phase, 'cancelled');
  assert.equal(reduceActivity({ ...state, phase: 'completed' }, event('Stop')).phase, 'completed');
  assert.equal(reduceActivity({ ...state, phase: 'cancelled' }, event('PostToolUse')).phase, 'cancelled');
  assert.equal(reduceActivity({ ...state, phase: 'ending' }, event('PostToolUse')).phase, 'ending');
});

test('model and tool observations wait for transcript completion; one response with multiple tools cannot freeze a partial output', () => {
  const model = span('2', 'model_stream'), tool = span('3', 'tool');
  const projected = [{ traceId: trace, messageId: 'message1', type: 'function_call', callId: 'call1', usage: {} },
    { traceId: trace, messageId: 'message1', type: 'function_call', callId: 'call2', usage: {} }];
  assert.equal(enrichmentReady(model, projected), false);
  projected.push({ traceId: trace, type: 'function_call_result', callId: 'call1' });
  assert.equal(enrichmentReady(tool, projected), true); assert.equal(enrichmentReady(model, projected), false);
  projected.push({ traceId: trace, type: 'function_call_result', callId: 'call2' }); assert.equal(enrichmentReady(model, projected), true);
  delete projected[0].usage;
  assert.equal(enrichmentReady(model, projected), true);
  assert.equal(enrichmentReady({ ...model, status: { code: 2 } }, []), true, 'A failed native model span may have no usage');
});

test('automatic selection excludes unrelated session-labelled auxiliary traces', () => {
  const auxiliary = span('8', '', sid, 'c'.repeat(32));
  const selected = selectSession([batch([auxiliary, span('2', 'model_stream')])], sid, { allowIncomplete: true });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].key, `${trace}:${'2'.repeat(16)}`);
});

test('user-cancel terminal marker resolves within its turn and releases completed model/tool records without fabricating output', async () => {
  const { TranscriptStore } = await import('../scripts/transcript.mjs');
  const { enrichBatches } = await import('../scripts/enrichment.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'wb-lf-cancel-'));
  const store = new TranscriptStore(join(directory, 'transcripts.sqlite'));
  try {
    const path = join(directory, `${sid}.jsonl`);
    const terminal = { id: 'cancel', sessionId: sid, type: 'message', role: 'assistant', timestamp: 4, status: 'incomplete',
      content: [{ type: 'output_text', text: 'Interrupted by user' }], providerData: { skipRun: true, error: { message: 'Interrupted by user' } } };
    await writeFile(path, [...records().slice(0, 2), terminal].map(line).join(''));
    await store.read(path, sid, { projectsDir: directory, content: 'text' });
    const projected = store.records(sid);
    assert.equal(projected.at(-1).traceId, trace);
    assert.equal(projected.at(-1).cancelled, true);
    assert.equal(enrichmentReady(span('2', 'model_stream'), projected), true);
    assert.equal(enrichmentReady(span('3', 'tool'), projected), true);
    const enriched = enrichBatches([batch([span('3', 'tool')])], projected, { content: 'text' });
    const attrs = enriched[0].resourceSpans[0].scopeSpans[0].spans[0].attributes;
    assert.equal(attrs.find(item => item.key === 'langfuse.observation.metadata.outputUnavailable').value.stringValue, 'cancelled-before-transcript-result');
    assert.equal(attrs.some(item => item.key === 'langfuse.observation.output'), false);
    await appendFile(path, line({ id: 'next-user', type: 'message', role: 'user', sessionId: sid, timestamp: 5 }) + line({ ...terminal, id: 'next-cancel', timestamp: 6 }));
    await store.read(path, sid, { projectsDir: directory, content: 'text' });
    assert.equal(store.records(sid).at(-1).traceId, undefined, 'An empty cancelled turn cannot borrow the previous trace');
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test('more than one page of uncertain records cannot starve another session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-lf-queue-pages-'));
  const store = new SidecarStore(join(directory, 'sidecar.sqlite'));
  const ledger = new DeliveryLedger(join(directory, 'ledger.sqlite'), 'target');
  const service = Object.assign(Object.create(Sidecar.prototype), { store, ledger, lastReconcile: Date.now(),
    config: { request: async () => Response.json({}) } });
  try {
    const records = Array.from({ length: 1002 }, (_, i) => ({ key: `${trace}:${(i + 1).toString(16).padStart(16, '0')}`,
      digest: String(i), payload: batch([span('1', 'interaction')]) }));
    const blocked = records.slice(0, -1), next = records.at(-1);
    ledger.reserve(blocked); ledger.finish(blocked, 'uncertain');
    store.transaction(() => { for (const record of records) store.db.prepare('INSERT INTO queue VALUES (?, ?, ?, ?, NULL)').run(record.key, record.digest, JSON.stringify(record.payload), record === next ? 'next-session' : 'blocked-session'); });
    await service.deliver();
    assert.equal(ledger.status(next.key).status, 'accepted');
    assert.equal(ledger.counts().uncertain, 1001);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM queue').get().n, 1001);
  } finally { store.close(); ledger.close(); await rm(directory, { recursive: true }); }
});
