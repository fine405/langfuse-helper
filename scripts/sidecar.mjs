import { isMain } from './entry.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { SidecarStore } from './sidecar-store.mjs';
import { TranscriptStore } from './transcript.mjs';
import { DeliveryLedger, selectSession, sendRecords } from './langfuse.mjs';
import { enrichBatches } from './enrichment.mjs';
import { connectLangfuse, reconcileDeliveries } from './recovery.mjs';
import { attributes } from './data.mjs';
import { activityView } from './activity.mjs';
import { readConfig } from './settings.mjs';
import { local, dataDir, configDir } from './cli.mjs';

const spanOf = payload => payload.resourceSpans[0].scopeSpans[0].spans[0];
const digest = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const runtimePath = join(local, 'service.json');

export function enrichmentReady(span, records) {
  const attrs = attributes(span.attributes), type = attrs['span.type'];
  const related = records.filter(record => record.traceId === span.traceId);
  const cancelled = related.some(record => record.cancelled);
  if (type === 'model_stream') {
    const messageId = attrs['workbuddy.message_id'] || attrs['message.id'];
    const messages = related.filter(record => record.messageId === messageId && (record.type === 'function_call' || record.role === 'assistant'));
    if (!messages.some(record => record.usage)) return span.status?.code === 2;
    // Tool responses are frozen only after their call results exist. WorkBuddy persists the full
    // response before tool execution; this also avoids exporting an incomplete parallel-call list.
    return cancelled || messages.every(record => record.type !== 'function_call' || related.some(result => result.type === 'function_call_result' && result.callId === record.callId));
  }
  if (type === 'tool' || type === 'mcp_call') return cancelled || related.some(record => record.type === 'function_call_result' && record.callId === attrs['tool.call_id']);
  return true;
}

export class Sidecar {
  constructor({ directory, hooksPath, projectsDir, settings, corePath }) {
    this.store = new SidecarStore(join(directory, 'sidecar.sqlite'));
    this.transcripts = new TranscriptStore(join(directory, 'transcripts.sqlite'));
    this.core = new DatabaseSync(corePath, { readOnly: true });
    this.core.exec('PRAGMA busy_timeout=5000');
    Object.assign(this, { hooksPath, projectsDir, settings, directory });
  }
  async initialize() { await this.store.hooks(this.hooksPath, { initialize: true }); this.store.native(this.core); }
  async capture() {
    await this.store.hooks(this.hooksPath);
    this.store.native(this.core);
    const traceContexts = new Map(), selectedContexts = new Map();
    for (const session of this.store.sessions()) {
      if (this.store.db.prepare('SELECT 1 FROM faults WHERE identity = ?').get(session.id)) continue;
      const rows = this.store.db.prepare("SELECT * FROM native_pending WHERE state = 'ready' AND session_id = ?").all(session.id);
      if (!rows.length && !['running', 'tool', 'waiting', 'ending'].includes(JSON.parse(session.activity).phase)) continue;
      try {
        const options = { ...this.settings, content: session.mode, projectsDir: this.projectsDir };
        let read;
        do { read = await this.transcripts.read(session.path, session.id, options); } while (read.readBytes === 8 * 1024 * 1024);
        const records = this.transcripts.records(session.id);
        const latest = records.at(-1);
        if (latest?.cancelled && latest.timestamp >= Date.parse(JSON.parse(session.activity).turnStartedAt || 0)) {
          const activity = { ...JSON.parse(session.activity), phase: 'cancelled', outcome: 'transcript-user-interrupt', tools: {} };
          this.store.db.prepare('UPDATE sessions SET activity = ? WHERE id = ?').run(JSON.stringify(activity), session.id);
          session.activity = JSON.stringify(activity);
        }
        for (const row of rows) {
          const payload = JSON.parse(row.payload), span = spanOf(payload);
          const attrs = attributes(span.attributes);
          if (attrs['workbuddy.langfuse.source'] === 'synthetic') { this.store.db.prepare('DELETE FROM native_pending WHERE seq = ?').run(row.seq); continue; }
          if (!traceContexts.has(span.traceId)) traceContexts.set(span.traceId, this.core.prepare('SELECT payload FROM observations WHERE trace_id = ? ORDER BY seq').all(span.traceId).map(item => JSON.parse(item.payload)));
          const context = traceContexts.get(span.traceId);
          if (!context.some(payload => attributes(spanOf(payload).attributes)['span.type'])) continue;
          if (!enrichmentReady(span, records)) continue;
          if (!selectedContexts.has(span.traceId)) selectedContexts.set(span.traceId, new Map(selectSession(context, session.id, { allowIncomplete: true }).map(record => [record.key, record])));
          const selected = selectedContexts.get(span.traceId).get(`${span.traceId}:${span.spanId}`);
          const [enriched] = enrichBatches([selected.payload], records, options);
          const record = { key: selected.key, payload: enriched, digest: digest(enriched) };
          this.store.transaction(() => {
            const previous = this.store.db.prepare('SELECT digest FROM queue WHERE identity = ?').get(record.key) || this.ledger?.status(record.key);
            if (previous && previous.digest !== record.digest) throw new Error('原生 ID 对应的已冻结内容发生变化，已隔离');
            this.store.db.prepare('INSERT OR IGNORE INTO queue VALUES (?, ?, ?, ?, NULL)').run(record.key, record.digest, JSON.stringify(record.payload), session.id);
            this.store.db.prepare('DELETE FROM native_pending WHERE seq = ?').run(row.seq);
            if (attrs['span.type'] === 'interaction') {
              const activity = JSON.parse(session.activity);
              // A delayed previous turn must not finish the new turn currently on screen.
              if (Number(BigInt(span.startTimeUnixNano) / 1000000n) >= Date.parse(activity.turnStartedAt || activity.updatedAt) - 2000) {
                activity.phase = attrs['conversation.cancelled'] === true || attrs['conversation.cancelled'] === 'true' || records.some(record => record.traceId === span.traceId && record.cancelled) ? 'cancelled' : span.status?.code === 2 ? 'failed' : 'completed';
                activity.outcome = 'native-interaction';
                this.store.db.prepare('UPDATE sessions SET activity = ? WHERE id = ?').run(JSON.stringify(activity), session.id);
              }
            }
          });
        }
        this.store.clearFault(`session:${session.id}`);
      } catch (error) { if (error.code !== 'ENOENT') this.store.fault(`session:${session.id}`, error.message); }
    }
  }
  async connect() {
    const config = await connectLangfuse();
    const previous = this.store.cursor('target');
    if (previous && previous !== config.target) throw new Error('发送目标已变化；请恢复原项目配置，或为新项目使用单独安装目录');
    this.store.setCursor('target', config.target);
    this.config = config;
    this.ledger = new DeliveryLedger(join(this.directory, 'langfuse-deliveries.sqlite'), config.target);
  }
  async deliver() {
    if (!this.ledger) await this.connect();
    if (!this.lastReconcile || Date.now() - this.lastReconcile >= 15000) {
      this.lastReconcile = Date.now();
      const report = await reconcileDeliveries(this.ledger, this.config.request);
      for (const item of report) {
        if (item.status === 'conflict') this.store.fault(item.identity, '远端 ID 重复或摘要不一致，需要人工核查');
        else if (item.status === 'accepted') this.store.clearFault(item.identity);
      }
    }
    const pending = [];
    let bytes = 0;
    for (const row of this.store.queueRows()) {
      const status = this.ledger.status(row.identity);
      if (status?.digest && status.digest !== row.digest) { this.store.fault(row.identity, '发送账本与待发送正文摘要不同'); continue; }
      if (status?.status === 'accepted') { this.store.db.prepare('DELETE FROM queue WHERE identity = ?').run(row.identity); continue; }
      if (['uncertain', 'sending'].includes(status?.status)) continue;
      if (pending.length && bytes + Buffer.byteLength(row.payload) > 3 * 1024 * 1024) break;
      bytes += Buffer.byteLength(row.payload);
      pending.push({ key: row.identity, digest: row.digest, payload: JSON.parse(row.payload) });
      if (pending.length === 50) break;
    }
    if (pending.length) {
      await sendRecords(pending, this.ledger, body => this.config.request('/api/public/otel/v1/traces', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' }, body,
      }));
      for (const record of pending) this.store.db.prepare('DELETE FROM queue WHERE identity = ?').run(record.key);
    }
  }
  status() {
    return { target: this.config ? { base: this.config.base, project: this.config.project.name } : null,
      queue: this.store.db.prepare('SELECT count(*) AS count FROM queue').get().count,
      waitingForNativeOrTranscript: this.store.db.prepare('SELECT state, count(*) AS count FROM native_pending GROUP BY state').all(),
      deliveries: this.ledger?.counts() || {}, faults: this.store.db.prepare('SELECT * FROM faults').all(),
      sessions: this.store.sessions().map(session => ({ sessionId: session.id, content: session.mode, ...activityView(JSON.parse(session.activity), this.settings) })),
      note: '只有已完成的原生 span 发送到 Langfuse；waiting/quiet/process-exited 是本地活动证据，不伪造模型耗时或结束结果。' };
  }
  close() { this.core.close(); this.store.close(); this.transcripts.close(); this.ledger?.close(); }
}

export async function runtimeRequest(path, directory = local) {
  const runtime = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'));
  return fetch(`http://127.0.0.1:${runtime.port}${path}`, { method: path === '/stop' ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(2000), redirect: 'error' });
}
async function serve() {
  await mkdir(local, { recursive: true, mode: 0o700 });
  const settings = readConfig(), token = randomUUID();
  if (!settings.enabled) throw new Error('采集已关闭，请先通过配置向导启用。');
  let running = true, sidecar, retryAfter = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    if (req.url === '/status' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(sidecar ? sidecar.status() : { starting: true })); }
    else if (req.url === '/stop' && req.method === 'POST') { running = false; res.end('stopping'); }
    else res.writeHead(404).end();
  });
  // A fixed loopback port is also the single-writer lock. Never kill a process on collision.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.WB_LF_SERVICE_PORT || 14319), '127.0.0.1', resolve); });
  try {
    sidecar = new Sidecar({ directory: local, hooksPath: join(dataDir, 'hooks.jsonl'), projectsDir: join(configDir, 'projects'), settings, corePath: join(local, 'collector/traces.sqlite') });
    await sidecar.initialize();
    await writeFile(runtimePath, JSON.stringify({ pid: process.pid, port: server.address().port, token }), { mode: 0o600 });
    process.on('SIGTERM', () => { running = false; });
    process.on('SIGINT', () => { running = false; });
    while (running) {
      try { await sidecar.capture(); sidecar.store.clearFault('capture'); }
      catch (error) { sidecar.store.fault('capture', error.message); }
      if (Date.now() >= retryAfter) {
        try { await sidecar.deliver(); sidecar.store.clearFault('delivery'); }
        catch (error) { sidecar.store.fault('delivery', error.message); retryAfter = Date.now() + 15000; }
      }
      await delay(settings.pollIntervalMs);
    }
  } finally { server.closeAllConnections(); server.close(); sidecar?.close(); await rm(runtimePath, { force: true }); }
}

async function main() {
  const command = process.argv[2];
  if (command === 'serve') return serve();
  if (command === 'start') {
    try { const result = await runtimeRequest('/status'); if (result.ok) { console.log('自动上报服务已运行。'); return; } } catch {}
    await mkdir(local, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: 'ignore', env: process.env });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    for (let i = 0; i < 40; i++) {
      await delay(250);
      try { if ((await runtimeRequest('/status')).ok) { console.log('自动上报服务已就绪；从现在起记录新的活动，保留历史与发送账本。'); return; } } catch {}
    }
    throw new Error('服务未启动。请运行 npm run service:foreground 查看原因（常见为 Collector 未启动或端口占用）。');
  }
  if (command === 'stop') {
    try {
      const response = await runtimeRequest('/stop'); if (!response.ok) throw new Error('停止请求被拒绝');
      let stopped = false;
      for (let i = 0; i < 100; i++) {
        await delay(250);
        try { await readFile(runtimePath); } catch (error) { if (error.code === 'ENOENT') { stopped = true; break; } throw error; }
      }
      if (!stopped) throw new Error('停止尚未确认；服务可能仍在完成一次有界请求，请稍后检查状态');
      console.log('自动上报已停止；本地队列和 Langfuse 历史保留。');
    }
    catch (error) { if (error.code === 'ENOENT' || error.cause?.code === 'ECONNREFUSED') console.log('自动上报服务没有运行。'); else throw error; }
    return;
  }
  if (command === 'status') { const response = await runtimeRequest('/status'); if (!response.ok) throw new Error('状态查询被拒绝'); console.log(JSON.stringify(await response.json(), null, 2)); return; }
  throw new Error('Use service:start, service:stop, service:status or service:foreground');
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
