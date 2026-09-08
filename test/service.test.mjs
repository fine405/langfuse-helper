import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, cp, readFile, appendFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TraceStore } from '../collector/trace-store.mjs';
import { root } from '../scripts/cli.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function eventually(check) { for (let i = 0; i < 80; i++) { const value = await check(); if (value) return value; await delay(100); } throw new Error('condition timed out'); }

test('real service process keeps durable capture during lost HTTP acknowledgement, recovers after crash, and authenticates control requests', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb lf daemon '));
  await cp(join(root, 'scripts'), join(directory, 'scripts'), { recursive: true });
  await cp(join(root, 'collector'), join(directory, 'collector'), { recursive: true });
  const state = join(directory, 'user-state');
  await mkdir(join(state, 'collector'), { recursive: true });
  const projects = join(directory, 'config/projects'); await mkdir(projects, { recursive: true });
  const hooksDir = join(directory, 'hooks'); await mkdir(hooksDir);
  const core = new TraceStore(join(state, 'collector/traces.sqlite'));
  let posts = 0, observed = [];
  const mock = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/public/projects') return res.end(JSON.stringify({ data: [{ id: 'project', name: 'fixture' }] }));
    if (req.url.startsWith('/api/public/v2/observations')) return res.end(JSON.stringify({ data: observed }));
    if (req.url === '/api/public/otel/v1/traces') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString()); posts++;
      observed = payload.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans)).map(span => ({ id: span.spanId, traceId: span.traceId,
        metadata: { deliveryDigest: span.attributes.find(item => item.key.endsWith('.deliveryDigest')).value.stringValue } }));
      res.destroy(); // Server accepted the full body; the client cannot confirm the outcome.
      return;
    }
    res.writeHead(404).end();
  });
  const mockPort = await listen(mock), probe = createServer(), servicePort = await listen(probe); await new Promise(resolve => probe.close(resolve));
  await writeFile(join(directory, 'config/langfuse.json'), JSON.stringify({ enabled: true,
    base_url: `http://127.0.0.1:${mockPort}`, public_key: 'pk-fixture', secret_key: 'sk-fixture', data_directory: state }));
  let child, startupError = '';
  const start = () => { child = spawn(process.execPath, [join(directory, 'scripts/sidecar.mjs'), 'serve'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env,
    WORKBUDDY_CONFIG_DIR: join(directory, 'config'), WORKBUDDY_LANGFUSE_DATA_DIR: hooksDir, WB_LF_SERVICE_PORT: String(servicePort),
    WORKBUDDY_LANGFUSE_CONFIG: join(directory, 'config/langfuse.json'), WORKBUDDY_LANGFUSE_STATE_DIR: state,
    LANGFUSE_BASE_URL: undefined, LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined,
    WORKBUDDY_LANGFUSE_BASE_URL: undefined, WORKBUDDY_LANGFUSE_PUBLIC_KEY: undefined, WORKBUDDY_LANGFUSE_SECRET_KEY: undefined } }); child.stderr.on('data', chunk => { startupError += chunk; }); };
  const runtime = async () => { if (child.exitCode !== null && child.exitCode !== 0) throw new Error(startupError); try { return JSON.parse(await readFile(join(state, 'service.json'), 'utf8')); } catch { return null; } };
  const status = async token => { try { return await (await fetch(`http://127.0.0.1:${servicePort}/status`, { headers: { Authorization: `Bearer ${token}` } })).json(); } catch { return null; } };
  try {
    start(); const initial = await eventually(runtime);
    assert.equal((await fetch(`http://127.0.0.1:${servicePort}/status`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${servicePort}/stop`, { method: 'POST' })).status, 403);
    const sid = 'service-session', path = join(projects, `${sid}.jsonl`);
    await writeFile(path, '');
    await appendFile(join(hooksDir, 'hooks.jsonl'), JSON.stringify({ source: 'workbuddy-hook', session_id: sid, transcript_path: path,
      contentMode: 'metadata', receivedAt: new Date().toISOString(), hook_event_name: 'UserPromptSubmit' }) + '\n');
    const span = { traceId: 'd'.repeat(32), spanId: 'e'.repeat(16), name: 'interaction', startTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
      endTimeUnixNano: String(BigInt(Date.now() + 1) * 1000000n), attributes: Object.entries({ 'span.type': 'interaction', 'langfuse.session.id': sid,
        'langfuse.observation.type': 'agent' }).map(([key, stringValue]) => ({ key, value: { stringValue } })) };
    core.ingest({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] });
    await eventually(async () => (await status(initial.token))?.deliveries?.uncertain === 1);
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    start(); const restarted = await eventually(async () => { const r = await runtime(); return r?.pid === child.pid && r; });
    await eventually(async () => (await status(restarted.token))?.deliveries?.accepted === 1);
    assert.equal(posts, 1, 'Crash recovery must query the accepted record without another POST');
    const stopped = once(child, 'close');
    assert.equal((await fetch(`http://127.0.0.1:${servicePort}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${restarted.token}` } })).status, 200);
    await stopped; assert.equal(await runtime(), null);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
    core.close(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); await rm(directory, { recursive: true });
  }
});
