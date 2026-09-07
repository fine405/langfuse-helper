import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app, root } from './cli.mjs';
import { withEngine, installPlugin, pluginId } from './engine.mjs';

await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
const configDir = await mkdtemp(join(root, '.local/plugin-test-'));
try {
  await withEngine({ app, configDir, cwd: root }, async request => {
    await installPlugin(request, root);
    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'));
    assert.equal(settings.enabledPlugins[pluginId], true, 'Installation must persist in user settings');
  });
  // A fresh process must load the registered plugin with no CODEBUDDY_PLUGIN_DIRS.
  await withEngine({ app, configDir, cwd: root }, async request => {
    const items = await request('/plugins');
    const plugin = items.find(item => `${item.name}@${item.marketplace}` === pluginId);
    assert.equal(plugin?.status, 'enabled');
    assert.equal(plugin.hooks, './hooks/events.json');
    const runtime = await request('/plugins/reload', {});
    assert.equal(runtime.errors, 0);
    assert.equal(runtime.plugins, 1);
    assert.equal(runtime.hooks, 6, 'Each event must register once');
    await request('/plugins/uninstall', { plugin: pluginId });
    assert.ok(!(await request('/plugins')).some(item => `${item.name}@${item.marketplace}` === pluginId));
  });
  console.log('PASS: persistent installation, fresh-process discovery without plugin-directory env, exactly 6 hooks, and uninstall.');
  console.log('Temporary configuration only. Desktop trigger acceptance is a separate check.');
} finally { await rm(configDir, { recursive: true, force: true }); }
