import { DatabaseSync } from 'node:sqlite';
const spanOf = batch => batch.resourceSpans[0].scopeSpans[0].spans[0];

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

export function langfuseConfig(config) {
  const baseUrl = new URL(config.base_url);
  if (!config.public_key || !config.secret_key) throw new Error('Project API keys are missing. Run langfuse-helper <agent> configure.');
  const base = baseUrl.href.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${config.public_key}:${config.secret_key}`).toString('base64')}`;
  return { base, request: (path, options = {}) => fetch(`${base}${path}`, { ...options, redirect: 'error',
    signal: AbortSignal.timeout(15000), headers: { ...options.headers, Authorization: auth } }) };
}

export async function observationsForTrace(request, traceId) {
  const observations = [], cursors = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({ traceId, limit: '1000', fields: 'basic,time,usage,model,io,metadata', ...(cursor ? { cursor } : {}) });
    const response = await request(`/api/public/v2/observations?${query}`);
    if (!response.ok) throw new Error(`Langfuse query failed (HTTP ${response.status}).`);
    const result = await response.json();
    if (!Array.isArray(result.data)) throw new Error('Langfuse query response is missing data');
    observations.push(...result.data);
    cursor = result.meta?.cursor;
    if (cursor && cursors.has(cursor)) throw new Error('Langfuse returned a repeated pagination cursor');
    cursors.add(cursor);
  } while (cursor);
  return observations;
}

// Absence is never an acknowledgement: ingestion and public queries are asynchronous.
export async function reconcileDeliveries(ledger, request) {
  const report = [], byTrace = new Map();
  for (const row of ledger.uncertain()) {
    const [traceId, spanId] = row.identity.split(':');
    if (!byTrace.has(traceId)) byTrace.set(traceId, await observationsForTrace(request, traceId));
    const matches = byTrace.get(traceId).filter(item => item.id === spanId && item.traceId === traceId);
    let status = 'unconfirmed';
    if (matches.length === 1 && matches[0].metadata?.deliveryDigest === row.digest) {
      ledger.finish([{ key: row.identity }], 'accepted');
      status = 'accepted';
    } else if (matches.length) status = 'conflict';
    report.push({ identity: row.identity, status, matches: matches.length, updatedAt: row.updated_at });
  }
  return report;
}

export async function connectLangfuse(settings) {
  const config = langfuseConfig(settings);
  const response = await config.request('/api/public/projects');
  if (!response.ok) throw new Error(`Langfuse project authentication failed (HTTP ${response.status}).`);
  const projects = (await response.json()).data;
  if (projects?.length !== 1 || !projects[0].id) throw new Error('Use API keys for exactly one Langfuse project.');
  return { ...config, project: projects[0], target: `${config.base}/${projects[0].id}` };
}
