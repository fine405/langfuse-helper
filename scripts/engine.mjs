import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

// A temporary authenticated control process; no model requests or credential extraction.
export async function withEngine({ app, configDir, cwd }, action) {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const password = randomBytes(24).toString('hex');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '',
    CODEBUDDY_CONFIG_DIR: configDir, WORKBUDDY_CONFIG_DIR: configDir,
    CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS: '1', CODEBUDDY_GATEWAY_AUTH: 'password',
    CODEBUDDY_GATEWAY_PASSWORD: password, DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
    PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}` };
  delete env.CODEBUDDY_PLUGIN_DIRS;
  delete env.WORKBUDDY_LANGFUSE_ENABLED;
  delete env.LANGFUSE_PUBLIC_KEY;
  delete env.LANGFUSE_SECRET_KEY;
  delete env.WORKBUDDY_LANGFUSE_PUBLIC_KEY;
  delete env.WORKBUDDY_LANGFUSE_SECRET_KEY;
  const child = spawn(join(app, 'Contents/MacOS/Electron'), [
    join(app, 'Contents/Resources/app.asar/cli/dist/codebuddy.js'),
    '--serve', '--host', '127.0.0.1', '--port', String(port),
  ], { cwd, stdio: 'ignore', env });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json', 'x-codebuddy-request': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`WorkBuddy ${path}: HTTP ${response.status}`);
    if (response.status === 204) return;
    return (await response.json()).data;
  };
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`WorkBuddy control process exited (${child.exitCode})`);
      try { await request('/plugins'); ready = true; break; } catch {}
      await delay(500);
    }
    if (!ready) throw new Error('WorkBuddy control process did not become ready');
    return await action(request);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([closed, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
  }
}

export const pluginId = 'workbuddy-langfuse@workbuddy-langfuse-local';
export async function installPlugin(request, root) {
  const validation = await request('/plugins/validate', { path: join(root, 'plugins/workbuddy-langfuse') });
  if (!validation.valid) throw new Error('Plugin manifest validation failed');
  await request('/plugins/marketplaces', { source: root, autoUpdate: false });
  await request('/plugins/marketplaces/update', { marketplace: 'workbuddy-langfuse-local', force: true });
  const existing = (await request('/plugins')).some(item => `${item.name}@${item.marketplace}` === pluginId);
  if (existing) await request('/plugins/update', { plugin: pluginId, scope: 'user', waitForApply: true });
  else await request('/plugins', { plugin: pluginId, options: { scope: 'user', waitForApply: true } });
  let plugin = (await request('/plugins')).find(item => `${item.name}@${item.marketplace}` === pluginId);
  if (plugin?.status !== 'enabled' || !plugin.installedPath) throw new Error('Plugin installation was not verified');
  const desired = JSON.parse(await readFile(join(root, 'plugins/workbuddy-langfuse/.codebuddy-plugin/plugin.json'), 'utf8'));
  const actual = JSON.parse(await readFile(join(plugin.installedPath, '.codebuddy-plugin/plugin.json'), 'utf8'));
  if (actual.version !== desired.version) {
    // WorkBuddy update can decline a downgrade. Reinstall only this plugin to select a rollback version.
    await request('/plugins/uninstall', { plugin: pluginId });
    await request('/plugins', { plugin: pluginId, options: { scope: 'user', waitForApply: true } });
    plugin = (await request('/plugins')).find(item => `${item.name}@${item.marketplace}` === pluginId);
    if (plugin?.status !== 'enabled' || !plugin.installedPath) throw new Error('Plugin rollback installation was not verified');
  }
  for (const path of ['.codebuddy-plugin/plugin.json', 'hooks/events.json', 'scripts/hook.mjs']) {
    const expected = await readFile(join(root, 'plugins/workbuddy-langfuse', path));
    const installed = await readFile(join(plugin.installedPath, path));
    if (!expected.equals(installed)) throw new Error(`Installed plugin is stale: ${path}`);
  }
  return plugin;
}
