import { isMain } from './entry.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readPreview } from './preview.mjs';
import { attributes, spansFrom, summarize } from './data.mjs';
import { prepare, local } from './cli.mjs';
import { enrichSession } from './session-input.mjs';
import { readConfig } from './settings.mjs';

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

export class DeliveryLedger {
  constructor(path, target) {
    this.db = new DatabaseSync(path);
    this.target = target;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS deliveries (target TEXT, identity TEXT, digest TEXT, status TEXT,
        PRIMARY KEY(target, identity));`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(deliveries)').all().map(row => row.name));
    if (!columns.has('payload')) this.db.exec('ALTER TABLE deliveries ADD COLUMN payload TEXT');
    if (!columns.has('updated_at')) this.db.exec('ALTER TABLE deliveries ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
  }
  pending(records) {
    return records.filter(record => {
      const previous = this.db.prepare('SELECT digest, status FROM deliveries WHERE target = ? AND identity = ?').get(this.target, record.key);
      if (!previous) return true;
      if (previous.digest !== record.digest) throw new Error('Registered span content changed; remote records cannot be overwritten.');
      if (previous.status === 'sending' || previous.status === 'uncertain') throw new Error('Previous delivery is uncertain. Check Langfuse before retrying; automatic replay is blocked.');
      return previous.status !== 'accepted';
    });
  }
  reserve(records) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.pending(records);
      for (const record of pending) this.db.prepare(`INSERT INTO deliveries(target, identity, digest, status, payload, updated_at) VALUES (?, ?, ?, 'sending', ?, ?)
        ON CONFLICT(target, identity) DO UPDATE SET status = 'sending', payload = excluded.payload, updated_at = excluded.updated_at`)
        .run(this.target, record.key, record.digest, JSON.stringify(record.payload), Date.now());
      this.db.exec('COMMIT');
      return pending;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(records, status) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) this.db.prepare('UPDATE deliveries SET status = ?, updated_at = ? WHERE target = ? AND identity = ?')
        .run(status, Date.now(), this.target, record.key);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  uncertain() {
    return this.db.prepare("SELECT * FROM deliveries WHERE target = ? AND status IN ('sending', 'uncertain')").all(this.target);
  }
  status(key) { return this.db.prepare('SELECT status, digest FROM deliveries WHERE target = ? AND identity = ?').get(this.target, key); }
  counts() { return Object.fromEntries(this.db.prepare('SELECT status, count(*) AS count FROM deliveries WHERE target = ? GROUP BY status').all(this.target).map(row => [row.status, row.count])); }
  close() { this.db.close(); }
}

export async function sendRecords(records, ledger, request) {
  const pending = ledger.pending(records);
  if (!pending.length) return 0;
  const body = JSON.stringify({ resourceSpans: pending.flatMap(record => record.payload.resourceSpans) });
  if (pending.length > 1000 || Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('A manual batch supports at most 1000 spans and 4 MiB. Nothing was sent.');
  const reserved = ledger.reserve(pending);
  if (!reserved.length) return 0;
  // Rebuild after the transactional reservation in case a concurrent uploader finished first.
  const reservedBody = JSON.stringify({ resourceSpans: reserved.flatMap(record => {
    const payload = structuredClone(record.payload);
    spanOf(payload).attributes.push({ key: 'langfuse.observation.metadata.deliveryDigest', value: { stringValue: record.digest } });
    return payload.resourceSpans;
  }) });
  let response;
  try { response = await request(reservedBody); }
  catch (error) {
    // A refused connection/DNS failure occurs before sending any HTTP body; other failures are ambiguous.
    const unsent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code || error.code);
    ledger.finish(reserved, unsent ? 'rejected' : 'uncertain');
    throw new Error(unsent ? 'Connection was not established. Records are retained for retry.' : 'Network response is uncertain. Automatic replay is blocked; check remote records first.');
  }
  if (!response.ok) {
    ledger.finish(reserved, [400, 401, 403, 404, 413, 415].includes(response.status) ? 'rejected' : 'uncertain');
    throw new Error(`Langfuse returned HTTP ${response.status}; delivery state was retained.`);
  }
  try {
    const result = await response.json();
    if (Number(result.partialSuccess?.rejectedSpans || 0) > 0) throw new Error('partial rejection');
  } catch {
    ledger.finish(reserved, 'uncertain');
    throw new Error('Langfuse response did not fully confirm acceptance; automatic replay is blocked.');
  }
  ledger.finish(reserved, 'accepted');
  return reserved.length;
}

export function langfuseConfig(config = readConfig()) {
  const baseUrl = new URL(config.base_url);
  if (!config.public_key || !config.secret_key) throw new Error('Project API keys are missing. Run langfuse-helper workbuddy configure.');
  const base = baseUrl.href.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${config.public_key}:${config.secret_key}`).toString('base64')}`;
  return { base, request: (path, options = {}) => fetch(`${base}${path}`, { ...options, redirect: 'error',
    signal: AbortSignal.timeout(15000), headers: { ...options.headers, Authorization: auth } }) };
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
