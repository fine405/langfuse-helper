import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, local, app, requireWorkBuddyClosed } from './cli.mjs';
import { readConfig, configPath } from './settings.mjs';
import { connectLangfuse } from './recovery.mjs';
import { runtimeRequest } from './sidecar.mjs';
import { isMain } from './entry.mjs';

function run(script, argument) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', script), argument], { stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error(`${argument} did not complete. Resolve the error above and retry.`);
}

export function assertSameTarget(directory, target) {
  for (const [name, sql] of [
    ['sidecar.sqlite', "SELECT value AS target FROM cursors WHERE name = 'target'"],
    ['langfuse-deliveries.sqlite', 'SELECT DISTINCT target FROM deliveries'],
  ]) {
    if (!existsSync(join(directory, name))) continue;
    const db = new DatabaseSync(join(directory, name), { readOnly: true });
    try {
      const targets = db.prepare(sql).all().map(row => name === 'sidecar.sqlite' ? JSON.parse(row.target) : row.target);
      if (targets.some(previous => previous !== target)) throw new Error('The delivery ledger belongs to a different Langfuse project. Configuration was not saved. Use a separate data directory for a new project and retain the existing ledger.');
    } finally { db.close(); }
  }
}

async function ensureDocker() {
  const ready = () => spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 2000 }).status === 0;
  if (ready()) return;
  const opened = spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
  if (opened.error || opened.status !== 0) throw new Error('Docker Desktop is required. Install it from https://www.docker.com/products/docker-desktop/ and retry.');
  console.log('Starting Docker Desktop...');
  for (let i = 0; i < 30; i++) { await delay(1000); if (ready()) return; }
  throw new Error('Docker Desktop is not ready. Complete its first-run setup, then run langfuse-helper workbuddy start again.');
}

export async function assertServiceAvailable(port = Number(process.env.WB_LF_SERVICE_PORT || 14319), directory = local) {
  try {
    const response = await runtimeRequest('/status', directory);
    if (response.ok && Number(new URL(response.url).port) === port) return;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.cause?.code !== 'ECONNREFUSED') throw error;
  }
  try {
    await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return;
    throw new Error('Could not determine whether the delivery port is available. Check other integration processes.');
  }
  throw new Error('Another integration is using this port. Stop it with its own configuration before starting this instance.');
}

async function start() {
  requireWorkBuddyClosed();
  const config = readConfig();
  if (!config.public_key || !config.secret_key) throw new Error('Run langfuse-helper workbuddy configure first.');
  if (!config.enabled) throw new Error('Capture is disabled. Run langfuse-helper workbuddy configure to enable it before starting.');
  const connected = await connectLangfuse(config);
  assertSameTarget(local, connected.target);
  await assertServiceAvailable();
  await ensureDocker();
  if (!existsSync(join(app, 'Contents/MacOS/Electron'))) throw new Error('WorkBuddy was not found. Install the desktop application and retry.');
  run('cli.mjs', 'plugin:install');
  run('sidecar.mjs', 'stop');
  run('cli.mjs', 'collector:start');
  run('sidecar.mjs', 'start');
  run('cli.mjs', 'launch');
  console.log(`Capture started. Tasks will be sent to ${connected.project.name}. Run langfuse-helper workbuddy status to check progress.`);
}

async function stop() {
  run('sidecar.mjs', 'stop');
  if (existsSync(join(local, 'collector'))) { await ensureDocker(); run('cli.mjs', 'collector:stop'); }
  console.log('Capture and delivery stopped. Configuration, the delivery ledger and history are retained. Quit WorkBuddy completely before reopening it normally.');
}

async function status() {
  const config = readConfig();
  console.log(`Configuration: ${configPath}\nState directory: ${local}\nCapture setting: ${config.enabled ? 'enabled' : 'disabled'}\nContent mode: ${config.content}\nLangfuse URL: ${config.base_url}`);
  try {
    const connected = await connectLangfuse(config);
    console.log(`Langfuse connected; project: ${connected.project.name}`);
  } catch (error) { console.log(`Langfuse connection unavailable: ${error.message}`); }
  try {
    const response = await runtimeRequest('/status');
    if (!response.ok) throw new Error('Status endpoint authentication failed');
    const service = await response.json();
    if (service.starting) { console.log('Delivery service is starting.'); return; }
    console.log(`Delivery service: running\nQueued: ${service.queue}\nRegistered sessions: ${service.sessions.length}`);
    if (service.target) console.log(`Active delivery target: ${service.target.base} / ${service.target.project}`);
    for (const fault of service.faults) console.log(`Action required: ${fault.message}`);
    if (!service.faults.length) console.log('No delivery faults reported.');
    const phases = { running: 'running', tool: 'tool', waiting: 'waiting for input or approval', ending: 'ending', completed: 'completed', failed: 'failed', cancelled: 'cancelled', ended: 'ended', 'process-exited': 'process exited' };
    for (const session of service.sessions.toSorted((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)).slice(0, 5)) console.log(`Session ${session.sessionId}: ${phases[session.phase] || session.phase}${session.quiet ? ' (no recent activity)' : ''}`);
  } catch (error) {
    if (error.code === 'ENOENT' || error.cause?.code === 'ECONNREFUSED') console.log('Delivery service: not running. Run langfuse-helper workbuddy start to enable capture.');
    else throw error;
  }
}

async function main() {
  switch (process.argv[2] || 'help') {
    case 'start': return start();
    case 'stop': return stop();
    case 'status': return status();
    case 'uninstall':
      requireWorkBuddyClosed();
      await stop();
      run('cli.mjs', 'plugin:uninstall');
      console.log('WorkBuddy plugin removed. Configuration and delivery history are retained.\nTo remove the CLI, run: npm uninstall -g langfuse-helper');
      return;
    default: throw new Error('Unknown command. Run langfuse-helper workbuddy --help.');
  }
}

if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
