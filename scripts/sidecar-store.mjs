import { DatabaseSync } from 'node:sqlite';
import { open } from 'node:fs/promises';
import { reduceActivity } from './activity.mjs';
import { createHash } from 'node:crypto';

export class SidecarStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, path TEXT, mode TEXT, activity TEXT);
      CREATE TABLE IF NOT EXISTS native_pending (seq INTEGER PRIMARY KEY, payload TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS queue (identity TEXT PRIMARY KEY, digest TEXT, payload TEXT, session_id TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS faults (identity TEXT PRIMARY KEY, message TEXT);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS hook_events (digest TEXT PRIMARY KEY)');
    this.transaction(() => {
      const columns = new Set(this.db.prepare('PRAGMA table_info(native_pending)').all().map(row => row.name));
      if (!columns.has('trace_id')) this.db.exec('ALTER TABLE native_pending ADD COLUMN trace_id TEXT');
      if (!columns.has('session_id')) this.db.exec('ALTER TABLE native_pending ADD COLUMN session_id TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS pending_session ON native_pending(state, session_id)');
      if (!columns.has('session_id')) for (const row of this.db.prepare('SELECT seq, payload FROM native_pending').all()) this.updateNative(row);
    });
  }
  cursor(name) { const row = this.db.prepare('SELECT value FROM cursors WHERE name = ?').get(name); return row ? JSON.parse(row.value) : null; }
  setCursor(name, value) { this.db.prepare('INSERT INTO cursors VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, JSON.stringify(value)); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { fn(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  fault(key, message) { this.db.prepare('INSERT INTO faults VALUES (?, ?) ON CONFLICT(identity) DO UPDATE SET message = excluded.message').run(key, message); }
  clearFault(key) { this.db.prepare('DELETE FROM faults WHERE identity = ?').run(key); }
  updateNative(row) {
    const span = JSON.parse(row.payload).resourceSpans[0].scopeSpans[0].spans[0];
    const session = span.attributes?.find(item => item.key === 'langfuse.session.id')?.value?.stringValue || null;
    this.db.prepare('UPDATE native_pending SET trace_id = ?, session_id = ?, payload = ?, state = coalesce(?, state) WHERE seq = ?')
      .run(span.traceId, session, row.payload, row.state || null, row.seq);
  }
  async hooks(path, { initialize = false } = {}) {
    let file;
    try { file = await open(path, 'r'); } catch (error) { if (error.code === 'ENOENT') { if (initialize && !this.cursor('hooks')) this.setCursor('hooks', { offset: 0, identity: null }); return; } throw error; }
    try {
      const stat = await file.stat(), identity = `${stat.dev}:${stat.ino}`;
      const previous = this.cursor('hooks');
      if (initialize && !previous) { this.setCursor('hooks', { offset: stat.size, identity }); return; }
      const offset = !previous || previous.identity !== identity || previous.offset > stat.size ? 0 : previous.offset;
      const buffer = Buffer.alloc(Math.min(stat.size - offset, 4 * 1024 * 1024));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
      if (!end && bytesRead === 4 * 1024 * 1024) throw new Error('Hook line exceeds 4 MiB; cursor was not advanced');
      const events = buffer.subarray(0, end).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      this.transaction(() => {
        for (const event of events) {
          if (event.source !== 'workbuddy-hook' || !event.session_id || !event.transcript_path) continue;
          const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
          if (!this.db.prepare('INSERT OR IGNORE INTO hook_events VALUES (?)').run(digest).changes) continue;
          const old = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(event.session_id);
          if (old && (old.path !== event.transcript_path || old.mode !== event.contentMode)) { this.fault(event.session_id, 'Session path or content mode changed; processing paused'); continue; }
          const activity = reduceActivity(old ? JSON.parse(old.activity) : undefined, event);
          this.db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET activity = excluded.activity`)
            .run(event.session_id, event.transcript_path, event.contentMode || 'metadata', JSON.stringify(activity));
        }
        this.setCursor('hooks', { offset: offset + end, identity });
      });
    } finally { await file.close(); }
  }
  native(core) {
    const cursor = this.cursor('native');
    if (cursor === null) { this.setCursor('native', core.prepare('SELECT coalesce(max(seq), 0) AS seq FROM observations').get().seq); return; }
    const rows = core.prepare('SELECT seq, trace_id, state, payload FROM observations WHERE seq > ? ORDER BY seq LIMIT 1000').all(cursor);
    this.transaction(() => {
      const insert = this.db.prepare('INSERT OR REPLACE INTO native_pending(seq, payload, state) VALUES (?, ?, ?)');
      for (const row of rows) insert.run(row.seq, row.payload, row.state);
      // Correlation changes occur in the same transaction as a new arrival for that trace.
      // Refresh only affected traces, rather than rescanning every historical pending row each tick.
      for (const traceId of new Set(rows.map(row => row.trace_id))) {
        for (const row of core.prepare('SELECT seq, state, payload FROM observations WHERE trace_id = ?').all(traceId)) this.updateNative(row);
      }
      if (rows.length) this.setCursor('native', rows.at(-1).seq);
    });
  }
  sessions() { return this.db.prepare('SELECT * FROM sessions').all(); }
  *queueRows() {
    let cursor = 0;
    while (true) {
      const rows = this.db.prepare('SELECT rowid AS queue_seq, * FROM queue WHERE rowid > ? ORDER BY rowid LIMIT 1000').all(cursor);
      if (!rows.length) return;
      for (const row of rows) { cursor = row.queue_seq; yield row; }
    }
  }
  close() { this.db.close(); }
}
