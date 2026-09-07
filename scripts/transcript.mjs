import { DatabaseSync } from 'node:sqlite';
import { open, realpath } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { sanitizeContent, visibleText } from './content.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const id = value => typeof value === 'string' && value.length <= 160 ? value : undefined;

// Projection happens before persistence: no reasoning, snapshots, system prompts, or raw providerData.
export function projectRecord(record, sessionId, contentMode = 'metadata', maxChars = 16000) {
  if (record.sessionId !== sessionId || !id(record.id)) return null;
  const provider = record.providerData || {};
  const result = { id: record.id, type: record.type, timestamp: record.timestamp, sessionId,
    traceId: id(provider.traceId), messageId: id(provider.messageId), callId: id(record.callId),
    status: id(record.status), role: id(record.role), name: id(record.name) };
  if (provider.isPartialAborted === true) result.cancelled = true;
  if (record.status === 'incomplete' && provider.skipRun === true && provider.error?.message === 'Interrupted by user') result.cancelled = true;
  if (!['message', 'function_call', 'function_call_result'].includes(record.type)) return null;
  if (provider.isMeta) return null;
  const usage = record.message?.usage;
  if (usage && ['message', 'function_call'].includes(record.type) && result.messageId && result.traceId) {
    const raw = provider.rawUsage || {};
    const input = count(usage.input_tokens), output = count(usage.output_tokens);
    const cacheRead = count(usage.cache_read_input_tokens), cacheWrite = count(usage.cache_creation_input_tokens);
    result.model = id(provider.model);
    result.requestModel = id(provider.requestModelId);
    result.usage = { input, output, cacheRead, cacheWrite };
    // WorkBuddy's OpenAI-compatible prompt_tokens includes cache hits. Other conventions stay explicit.
    result.inputIncludesCache = raw.prompt_tokens === input && input !== undefined;
    result.credits = amount(raw.credit);
  }
  if (contentMode === 'text') {
    let value;
    if (record.type === 'message') value = visibleText(record.content, record.role);
    else if (record.type === 'function_call') {
      value = record.arguments;
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch {} }
    } else value = visibleText(record.output);
    if (value !== undefined && value !== '') result.content = sanitizeContent(value, maxChars);
  }
  return result;
}

export class TranscriptStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS transcript_cursors (
        path TEXT PRIMARY KEY, session_id TEXT NOT NULL, identity TEXT NOT NULL,
        offset INTEGER NOT NULL, mode TEXT NOT NULL, resets INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS transcript_records (
        session_id TEXT, record_key TEXT, timestamp INTEGER, payload TEXT,
        PRIMARY KEY(session_id, record_key)
      );`);
    if (this.db.prepare('PRAGMA user_version').get().user_version < 2) {
      this.db.exec('BEGIN IMMEDIATE; UPDATE transcript_cursors SET offset = 0; PRAGMA user_version=2; COMMIT;');
    }
  }
  async read(path, sessionId, { projectsDir, content = 'metadata', maxContentChars = 16000 } = {}) {
    const filePath = await realpath(path);
    const projectsPath = await realpath(projectsDir);
    if (!filePath.startsWith(`${projectsPath}${sep}`) || basename(filePath) !== `${sessionId}.jsonl`) throw new Error('Transcript path does not match the registered WorkBuddy session');
    const file = await open(filePath, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Transcript must be a regular file');
      const identity = `${stat.dev}:${stat.ino}`;
      const previous = this.db.prepare('SELECT * FROM transcript_cursors WHERE path = ?').get(filePath);
      if (previous && previous.mode !== content) throw new Error('An existing session cannot change content mode; start a new session');
      const reset = previous && (previous.identity !== identity || previous.offset > stat.size);
      const offset = !previous || reset ? 0 : previous.offset;
      const length = Math.min(stat.size - offset, 8 * 1024 * 1024);
      if (length <= 0 && previous && !reset) return { readBytes: 0, records: 0, offset, partial: false };
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
      if (!end && bytesRead >= 8 * 1024 * 1024) throw new Error('Transcript line exceeds 8 MiB; cursor is unchanged');
      const projected = buffer.subarray(0, end).toString('utf8').split('\n').filter(line => line.trim())
        .map(line => projectRecord(JSON.parse(line), sessionId, content, maxContentChars)).filter(Boolean);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const record of projected) this.db.prepare(`INSERT INTO transcript_records VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, record_key) DO UPDATE SET timestamp = excluded.timestamp, payload = excluded.payload`)
          .run(sessionId, `${record.type}:${record.id}:${record.callId || ''}`, record.timestamp || 0, JSON.stringify(record));
        this.db.prepare(`INSERT INTO transcript_cursors(path, session_id, identity, offset, mode, resets) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET identity = excluded.identity, offset = excluded.offset, resets = excluded.resets`)
          .run(filePath, sessionId, identity, offset + end, content, (previous?.resets || 0) + (reset ? 1 : 0));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return { readBytes: bytesRead, records: projected.length, offset: offset + end, partial: end < bytesRead, reset: !!reset };
    } finally { await file.close(); }
  }
  records(sessionId) {
    let traceId;
    return this.db.prepare('SELECT payload FROM transcript_records WHERE session_id = ? ORDER BY timestamp, rowid').all(sessionId).map(row => {
      const record = JSON.parse(row.payload);
      if (record.role === 'user') traceId = undefined;
      if (record.traceId) traceId = record.traceId;
      // WorkBuddy's terminal user-interrupt marker omits traceId; associate only within this turn.
      if (record.cancelled && !record.traceId && traceId) record.traceId = traceId;
      return record;
    });
  }
  close() { this.db.close(); }
}
