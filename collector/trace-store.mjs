import { DatabaseSync } from 'node:sqlite';

const get = (span, key) => span.attributes?.find(item => item.key === key)?.value?.stringValue;
const set = (span, key, value) => {
  span.attributes ||= [];
  const item = span.attributes.find(item => item.key === key);
  if (item) item.value = { stringValue: value };
  else span.attributes.push({ key, value: { stringValue: value } });
};
const onlySpan = payload => payload.resourceSpans[0].scopeSpans[0].spans[0];

export class TraceStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS trace_sessions (
        trace_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, conflict INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS observations (
        seq INTEGER PRIMARY KEY, trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
        state TEXT NOT NULL, raw TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observations_trace ON observations(trace_id);`);
  }

  ingest(body) {
    const records = [];
    if (!Array.isArray(body?.resourceSpans)) throw new TypeError('Expected OTLP JSON resourceSpans');
    for (const resource of body.resourceSpans) for (const scope of resource.scopeSpans || []) {
      for (const span of scope.spans || []) {
        if (!/^[a-f0-9]{32}$/i.test(span.traceId) || !/^[a-f0-9]{16}$/i.test(span.spanId)) throw new TypeError('Invalid OTLP identity');
        records.push({ span, raw: JSON.stringify({ resourceSpans: [{ ...resource, scopeSpans: [{ ...scope, spans: [span] }] }] }) });
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const traceIds = new Set();
      for (const { span, raw } of records) {
        traceIds.add(span.traceId);
        const session = get(span, 'langfuse.session.id');
        if (session) {
          this.db.prepare(`INSERT INTO trace_sessions(trace_id, session_id) VALUES (?, ?)
            ON CONFLICT(trace_id) DO UPDATE SET conflict = CASE
              WHEN trace_sessions.session_id <> excluded.session_id THEN 1 ELSE trace_sessions.conflict END`)
            .run(span.traceId, session);
        }
        // Preserve duplicate arrivals as separate diagnostic records; IDs do not imply exactly-once ingestion.
        this.db.prepare('INSERT INTO observations(trace_id, span_id, state, raw, payload) VALUES (?, ?, ?, ?, ?)')
          .run(span.traceId, span.spanId, 'pending', raw, raw);
      }
      for (const traceId of traceIds) this.reconcile(traceId);
      this.db.exec('COMMIT'); // Only acknowledge HTTP after identities and pending data are durable.
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return records.length;
  }

  reconcile(traceId) {
    const mapping = this.db.prepare('SELECT session_id, conflict FROM trace_sessions WHERE trace_id = ?').get(traceId);
    const records = this.db.prepare('SELECT seq, raw FROM observations WHERE trace_id = ? AND (state <> ? OR ? = 1)')
      .all(traceId, 'ready', mapping?.conflict || 0);
    const update = this.db.prepare('UPDATE observations SET state = ?, payload = ? WHERE seq = ?');
    for (const row of records) {
      const payload = JSON.parse(row.raw);
      const span = onlySpan(payload);
      let state;
      if (mapping?.conflict) {
        // Rebuild from the raw metadata, removing any earlier inferred session on conflict.
        state = 'conflict';
        set(span, 'workbuddy.langfuse.session.conflict', 'true');
      } else if (mapping) {
        state = 'ready';
        if (!get(span, 'langfuse.session.id')) {
          set(span, 'langfuse.session.id', mapping.session_id);
          set(span, 'workbuddy.langfuse.session.origin', 'trace-id');
        }
      } else state = get(span, 'span.type') ? 'pending' : 'unassociated';
      update.run(state, JSON.stringify(payload), row.seq);
    }
  }

  stats() {
    return Object.fromEntries(this.db.prepare('SELECT state, count(*) AS count FROM observations GROUP BY state').all()
      .map(row => [row.state, row.count]));
  }
  close() { this.db.close(); }
}

export function readStore(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('SELECT state, payload FROM observations ORDER BY seq').all();
    return { batches: rows.map(row => JSON.parse(row.payload)),
      states: rows.reduce((counts, row) => { counts[row.state] = (counts[row.state] || 0) + 1; return counts; }, {}) };
  } finally { db.close(); }
}
