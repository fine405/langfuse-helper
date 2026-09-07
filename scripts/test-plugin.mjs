import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, root } from './cli.mjs';

await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
const config = await mkdtemp(join(root, '.local/plugin-test-'));
const probe = createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const password = randomBytes(24).toString('hex');
const plugin = join(root, 'plugins/workbuddy-langfuse');
const child = spawn(join(app, 'Contents/MacOS/Electron'), [
  join(app, 'Contents/Resources/app.asar/cli/dist/codebuddy.js'),
  '--serve', '--host', '127.0.0.1', '--port', String(port),
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '',
  CODEBUDDY_CONFIG_DIR: config, WORKBUDDY_CONFIG_DIR: config,
  CODEBUDDY_PLUGIN_DIRS: plugin, CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS: '1',
  CODEBUDDY_GATEWAY_AUTH: 'password', CODEBUDDY_GATEWAY_PASSWORD: password,
  DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
  WORKBUDDY_LANGFUSE_DATA_DIR: join(config, 'hook-events'),
  PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`,
} });
// Startup output contains the temporary server password; never print it.
child.stdout.resume(); child.stderr.resume();
let spawnError;
child.on('error', error => { spawnError = error; });
const closed = new Promise(resolve => child.once('close', resolve));
const endpoint = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json', 'x-codebuddy-request': '1' };
try {
  let items;
  let diagnostic = 'No response';
  for (let i = 0; i < 60; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`WorkBuddy test engine exited (${child.exitCode})`);
    try {
      const response = await fetch(`${endpoint}/api/v1/plugins`, { headers, signal: AbortSignal.timeout(1000) });
      diagnostic = `HTTP ${response.status}`;
      if (!response.ok) diagnostic += ` ${(await response.text()).replaceAll(password, '[redacted]').slice(0, 400)}`;
      if (response.ok) {
        const body = await response.json();
        diagnostic += ` keys=${Object.keys(body).join(',')} dataType=${typeof body.data}`;
        items = Array.isArray(body) ? body : body.data;
        if (items?.some(item => item.name === 'workbuddy-langfuse')) break;
      }
    } catch {}
    await delay(500);
  }
  const loaded = items?.find(item => item.name === 'workbuddy-langfuse');
  assert.ok(loaded, `Local plugin was not discovered by the real WorkBuddy engine (${diagnostic})`);
  assert.equal(loaded.status, 'enabled');
  assert.equal(loaded.marketplace, 'inline');
  assert.equal(loaded.hooks, './hooks/events.json');
  const response = await fetch(`${endpoint}/api/v1/plugins/validate`, {
    method: 'POST', headers, body: JSON.stringify({ path: plugin }), signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  assert.equal(response.ok, true, 'Plugin validation endpoint failed');
  const validation = body.data || body;
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const reloaded = await fetch(`${endpoint}/api/v1/plugins/reload`, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(10000),
  });
  assert.equal(reloaded.ok, true, 'Plugin runtime reload failed');
  const runtime = (await reloaded.json()).data;
  assert.equal(runtime.errors, 0, 'Plugin runtime reported loading errors');
  assert.equal(runtime.plugins, 1, 'Isolated test must load only our plugin');
  assert.equal(runtime.hooks, 6, 'Each event must register once; duplicate loading would duplicate diagnostic records');
  console.log(`PASS: WorkBuddy engine discovered workbuddy-langfuse@inline (${loaded.status}), validated its manifest, and loaded ${runtime.hooks} hooks.`);
  console.log('Temporary configuration only; no model request or user settings change. Desktop task triggers remain a user verification step.');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([closed, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
  await rm(config, { recursive: true, force: true });
}
