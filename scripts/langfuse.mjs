import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPreview } from './preview.mjs';
import { attributes, spansFrom, summarize } from './data.mjs';
import { prepare, root } from './cli.mjs';

const spanOf = batch => batch.resourceSpans[0].scopeSpans[0].spans[0];
const identity = span => `${span.traceId}:${span.spanId}`;
const hash = value => createHash('sha256').update(value).digest('hex');

export function selectSession(batches, sessionId) {
  const spans = spansFrom(batches);
  const traceIds = new Set(spans.filter(span => span.attributes['span.type'] === 'interaction'
    && span.attributes['langfuse.session.id'] === sessionId
    && span.attributes['workbuddy.langfuse.source'] !== 'synthetic').map(span => span.traceId));
  if (!traceIds.size) throw new Error('指定 Session 没有已完成的原生 interaction。');
  const selected = new Map();
  for (const batch of batches) {
    for (const resource of batch.resourceSpans || []) for (const scope of resource.scopeSpans || []) for (const span of scope.spans || []) {
      if (!traceIds.has(span.traceId)) continue;
      const attrs = attributes(span.attributes);
      if (attrs['langfuse.session.id'] !== sessionId || attrs['workbuddy.langfuse.session.conflict']) throw new Error('Session 关联缺失或冲突，停止上传。');
      if (!span.startTimeUnixNano || !span.endTimeUnixNano || BigInt(span.endTimeUnixNano) <= 0n
        || BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano)) throw new Error('span 尚未结束或时间无效。');
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
      if (selected.has(key) && selected.get(key).digest !== digest) throw new Error('同一 span ID 出现不同内容，停止上传。');
      selected.set(key, { key, digest, payload });
    }
  }
  for (const { payload } of selected.values()) {
    const span = spanOf(payload);
    if (span.parentSpanId && !/^0+$/.test(span.parentSpanId) && !selected.has(`${span.traceId}:${span.parentSpanId}`)) throw new Error('父 span 尚未收到，停止上传。');
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
  }
  pending(records) {
    return records.filter(record => {
      const previous = this.db.prepare('SELECT digest, status FROM deliveries WHERE target = ? AND identity = ?').get(this.target, record.key);
      if (!previous) return true;
      if (previous.digest !== record.digest) throw new Error('已登记的 span 内容变化，不能覆盖远端记录。');
      if (previous.status === 'sending' || previous.status === 'uncertain') throw new Error('上次发送结果不确定；先核查 Langfuse，当前不会自动重传。');
      return previous.status !== 'accepted';
    });
  }
  reserve(records) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.pending(records);
      for (const record of pending) this.db.prepare(`INSERT INTO deliveries VALUES (?, ?, ?, 'sending')
        ON CONFLICT(target, identity) DO UPDATE SET status = 'sending'`).run(this.target, record.key, record.digest);
      this.db.exec('COMMIT');
      return pending;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(records, status) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) this.db.prepare('UPDATE deliveries SET status = ? WHERE target = ? AND identity = ?')
        .run(status, this.target, record.key);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

export async function sendRecords(records, ledger, request) {
  const pending = ledger.pending(records);
  if (!pending.length) return 0;
  const body = JSON.stringify({ resourceSpans: pending.flatMap(record => record.payload.resourceSpans) });
  if (pending.length > 1000 || Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('当前阶段支持一次最多 1000 个 span、4 MiB；本次未发送。');
  const reserved = ledger.reserve(pending);
  if (!reserved.length) return 0;
  // Rebuild after the transactional reservation in case a concurrent uploader finished first.
  const reservedBody = JSON.stringify({ resourceSpans: reserved.flatMap(record => record.payload.resourceSpans) });
  let response;
  try { response = await request(reservedBody); }
  catch { ledger.finish(reserved, 'uncertain'); throw new Error('网络响应不确定；已阻止自动重传，请先核查远端。'); }
  if (!response.ok) {
    ledger.finish(reserved, [400, 401, 403, 404, 413, 415].includes(response.status) ? 'rejected' : 'uncertain');
    throw new Error(`Langfuse 返回 HTTP ${response.status}；发送状态已保留。`);
  }
  try {
    const result = await response.json();
    if (Number(result.partialSuccess?.rejectedSpans || 0) > 0) throw new Error('partial rejection');
  } catch {
    ledger.finish(reserved, 'uncertain');
    throw new Error('Langfuse 响应无法完整确认；已阻止自动重传。');
  }
  ledger.finish(reserved, 'accepted');
  return reserved.length;
}

export function langfuseConfig() {
  try { process.loadEnvFile(resolve(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const baseUrl = new URL(process.env.LANGFUSE_BASE_URL || 'http://localhost:3000');
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('LANGFUSE_BASE_URL 无效。');
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) throw new Error('请在项目 .env 中填写 Langfuse 项目密钥。');
  const base = baseUrl.href.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64')}`;
  return { base, request: (path, options = {}) => fetch(`${base}${path}`, { ...options, redirect: 'error',
    signal: AbortSignal.timeout(15000), headers: { ...options.headers, Authorization: auth } }) };
}

async function main() {
  const [sessionId, option] = process.argv.slice(2);
  if (!sessionId || (option && option !== '--send')) throw new Error('用法：npm run langfuse:upload -- <Session ID> [--send]');
  const preview = await readPreview(resolve(root, '.local/collector'));
  const records = selectSession(preview.batches, sessionId);
  const summary = summarize(spansFrom(records.map(record => record.payload)));
  if (!option) { console.log(JSON.stringify({ mode: 'preview', sessionId, ...summary, note: '本次未连接或上传 Langfuse；加 --send 才发送。仅选择已结束的主 Trace。' }, null, 2)); return; }
  const { base, request } = langfuseConfig();
  const response = await request('/api/public/projects');
  if (!response.ok) throw new Error(`Langfuse 项目认证失败（HTTP ${response.status}）。`);
  const projects = (await response.json()).data;
  if (projects?.length !== 1 || !projects[0].id) throw new Error('必须使用单个 Langfuse 项目的密钥。');
  await prepare();
  const ledger = new DeliveryLedger(resolve(root, '.local/langfuse-deliveries.sqlite'), `${base}/${projects[0].id}`);
  try {
    const uploaded = await sendRecords(records, ledger, body => request('/api/public/otel/v1/traces', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' }, body,
    }));
    console.log(JSON.stringify({ sessionId, project: projects[0].name, uploaded, skipped: records.length - uploaded,
      sessionUrl: `${base}/project/${projects[0].id}/sessions/${encodeURIComponent(sessionId)}`,
      note: 'HTTP 接收确认；实际入库请运行 langfuse:verify。请保留发送账本，结果不确定时不会自动重传。' }, null, 2));
  } finally { ledger.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
