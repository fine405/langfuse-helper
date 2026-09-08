import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, local, app, requireWorkBuddyClosed } from './cli.mjs';
import { readConfig, writeConfig, configPath, stateDirectory } from './settings.mjs';
import { connectLangfuse } from './recovery.mjs';
import { runtimeRequest } from './sidecar.mjs';
import { collectConfig } from './wizard.mjs';
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

export async function verifyAndSave(config, { file = configPath, directory = stateDirectory(config), onVerified = () => {} } = {}) {
  const previous = readConfig({ file, env: {} });
  if (!config.enabled && ['base_url', 'public_key', 'secret_key'].every(key => config[key] === previous[key])) {
    return writeConfig({ ...config, data_directory: directory }, file);
  }
  const connected = await connectLangfuse(config);
  assertSameTarget(directory, connected.target);
  onVerified(connected);
  return writeConfig({ ...config, base_url: connected.base, project_name: connected.project.name,
    project_id: connected.project.id, data_directory: directory }, file);
}

export async function configure() {
  if (!process.stdin.isTTY) throw new Error(`Run langfuse-helper workbuddy configure in an interactive terminal, or edit ${configPath}`);
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk, encoding); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  rl.on('SIGINT', () => { rl.close(); });
  const ask = label => rl.question(label);
  const secret = async label => {
    process.stdout.write(label); hidden = true;
    try { return await ask(''); } finally { hidden = false; process.stdout.write('\n'); }
  };
  try {
    const current = readConfig();
    if (Object.keys(process.env).some(key => /^(WORKBUDDY_)?LANGFUSE_(BASE_URL|PUBLIC_KEY|SECRET_KEY)$/.test(key))) {
      console.log('Langfuse environment variables override the configuration file. Clear outdated overrides before restarting capture.');
    }
    const config = await collectConfig(current, { ask, secret, log: console.log, openBrowser: async url => {
      const result = spawnSync('open', [url], { stdio: 'ignore' });
      if (result.error || result.status !== 0) console.log(`Open this URL in your browser: ${url}`);
    } });
    console.log('Checking configuration...');
    const saved = await verifyAndSave(config, { onVerified: connected => console.log(`Verified: ${connected.base} -> project "${connected.project.name}"`) });
    console.log(`Configuration saved: ${configPath}\nLangfuse URL: ${saved.base_url}\nProject: ${saved.project_name}\nCapture: ${saved.enabled ? 'enabled' : 'disabled'}; content: ${saved.content}`);
    console.log('Restart capture to apply configuration changes. Content mode applies to new sessions. The delivery ledger is retained.');
    if (!saved.enabled) {
      const answer = (await ask('Stop capture and delivery now? [Y/n]: ')).trim().toLowerCase();
      if (!answer || ['y', 'yes'].includes(answer)) await stop();
      else console.log('Capture is disabled in the saved configuration. Run langfuse-helper workbuddy stop to stop running processes.');
      return saved;
    }
    try { requireWorkBuddyClosed(); }
    catch { console.log('Quit WorkBuddy completely, then run langfuse-helper workbuddy start to apply the settings.'); return saved; }
    if (['y', 'yes'].includes((await ask('Start WorkBuddy with capture now? [y/N]: ')).trim().toLowerCase())) await start();
    return saved;
  } finally { rl.close(); }
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
  if (!config.public_key || !config.secret_key) { await configure(); return; }
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
    case 'configure': return configure();
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
