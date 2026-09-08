import { DeliveryLedger, sendRecords, langfuseConfig as clientConfig } from './delivery.mjs';
import { isMain } from './entry.mjs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readPreview } from './preview.mjs';
import { attributes, spansFrom, summarize } from './data.mjs';
import { prepare, local } from './cli.mjs';
import { enrichSession } from './session-input.mjs';
import { readConfig } from './settings.mjs';

export { DeliveryLedger, sendRecords } from './delivery.mjs';
export const langfuseConfig = (config = readConfig()) => clientConfig(config);


const spanOf = batch => batch.resourceSpans[0].scopeSpans[0].spans[0];
const identity = span => `${span.traceId}:${span.spanId}`;
const hash = value => createHash('sha256').update(value).digest('hex');

export function selectSession(batches, sessionId, { allowIncomplete = false } = {}) {
  const spans = spansFrom(batches);
  const traceIds = new Set(spans.filter(span => (allowIncomplete ? !!span.attributes['span.type'] : span.attributes['span.type'] === 'interaction')
    && span.attributes['langfuse.session.id'] === sessionId
    && span.attributes['workbuddy.langfuse.source'] !== 'synthetic').map(span => span.traceId));
  if (!traceIds.size) throw new Error('No completed native spans are available for this session.');
  const selected = new Map();
  for (const batch of batches) {
    for (const resource of batch.resourceSpans || []) for (const scope of resource.scopeSpans || []) for (const span of scope.spans || []) {
      if (!traceIds.has(span.traceId)) continue;
      const attrs = attributes(span.attributes);
      if (attrs['langfuse.session.id'] !== sessionId || attrs['workbuddy.langfuse.session.conflict']) throw new Error('Session association is missing or conflicting; upload stopped.');
      if (!span.startTimeUnixNano || !span.endTimeUnixNano || BigInt(span.endTimeUnixNano) <= 0n
        || BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano)) throw new Error('Span is unfinished or has invalid timestamps.');
      const payload = structuredClone({ resourceSpans: [{ ...resource, scopeSpans: [{ ...scope, spans: [span] }] }] });
      // WorkBuddy interaction starts a new trace but can retain an unexported outer parent.
      // Make that explicit trace boundary a root; preserve the native parent as metadata.
      if (attrs['span.type'] === 'interaction' && span.parentSpanId && !/^0+$/.test(span.parentSpanId)
        && !spans.some(candidate => candidate.traceId === span.traceId && candidate.spanId === span.parentSpanId)) {
        spanOf(payload).attributes.push({ key: 'langfuse.observation.metadata.nativeParentSpanId', value: { stringValue: span.parentSpanId } });
        delete spanOf(payload).parentSpanId;
      }
      spanOf(payload).attributes.push(
        { key: 'langfuse.trace.name', value: { stringValue: 'WorkBuddy' } },
        { key: 'langfuse.trace.tags', value: { arrayValue: { values: [{ stringValue: 'workbuddy' }] } } },
        { key: 'langfuse.observation.metadata.source', value: { stringValue: 'workbuddy-native-otel' } },
      );
      const key = identity(span), digest = hash(JSON.stringify(payload));
      if (selected.has(key) && selected.get(key).digest !== digest) throw new Error('The same span ID has different content; upload stopped.');
      selected.set(key, { key, digest, payload });
    }
  }
  for (const { payload } of selected.values()) {
    const span = spanOf(payload);
    if (!allowIncomplete && span.parentSpanId && !/^0+$/.test(span.parentSpanId) && !selected.has(`${span.traceId}:${span.parentSpanId}`)) throw new Error('Parent span has not arrived; upload stopped.');
  }
  return [...selected.values()];
}

async function main() {
  const [sessionId, option] = process.argv.slice(2);
  if (!sessionId || (option && option !== '--send')) throw new Error('Usage: langfuse-helper workbuddy export <session-id> [--send]');
  const preview = await readPreview(resolve(local, 'collector'));
  const records = await enrichSession(selectSession(preview.batches, sessionId), sessionId);
  const summary = summarize(spansFrom(records.map(record => record.payload)));
  if (!option) { console.log(JSON.stringify({ mode: 'preview', sessionId, ...summary, note: 'Local preview only. Use --send to upload. Only completed main traces are selected.' }, null, 2)); return; }
  if (!readConfig().enabled) throw new Error('Capture is disabled. Run langfuse-helper workbuddy configure to enable it.');
  const { base, request } = langfuseConfig();
  const response = await request('/api/public/projects');
  if (!response.ok) throw new Error(`Langfuse project authentication failed (HTTP ${response.status}).`);
  const projects = (await response.json()).data;
  if (projects?.length !== 1 || !projects[0].id) throw new Error('Use API keys for exactly one Langfuse project.');
  await prepare();
  const ledger = new DeliveryLedger(resolve(local, 'langfuse-deliveries.sqlite'), `${base}/${projects[0].id}`);
  try {
    const uploaded = await sendRecords(records, ledger, body => request('/api/public/otel/v1/traces', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' }, body,
    }));
    console.log(JSON.stringify({ sessionId, project: projects[0].name, uploaded, skipped: records.length - uploaded,
      sessionUrl: `${base}/project/${projects[0].id}/sessions/${encodeURIComponent(sessionId)}`,
      note: 'HTTP acceptance confirmed. Use langfuse-helper workbuddy verify to check stored records. Retain the ledger; uncertain deliveries are not automatically replayed.' }, null, 2));
  } finally { ledger.close(); }
}

if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
