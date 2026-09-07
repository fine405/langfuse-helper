import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, root } from './cli.mjs';
import { withEngine, installPlugin, pluginId } from './engine.mjs';

await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
const configDir = await mkdtemp(join(root, '.local/plugin test '));
const source = join(configDir, 'source with spaces');
await mkdir(source);
await cp(join(root, '.codebuddy-plugin'), join(source, '.codebuddy-plugin'), { recursive: true });
await cp(join(root, 'plugins'), join(source, 'plugins'), { recursive: true });
const manifestPath = join(source, 'plugins/workbuddy-langfuse/.codebuddy-plugin/plugin.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = '0.0.1';
await writeFile(manifestPath, JSON.stringify(manifest));
try {
  await withEngine({ app, configDir, cwd: root }, async request => {
    await installPlugin(request, source);
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
    assert.equal(runtime.hooks, 11, 'Each event must register once');
  });
  // Match npm start: each installation uses a fresh, bounded control process.
  for (const version of ['0.0.2', '0.0.1']) {
    manifest.version = version;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await withEngine({ app, configDir, cwd: root }, async request => {
      const updated = await installPlugin(request, source).catch(error => { throw new Error(`Selected version ${version}: ${error.message}`); });
      const installed = JSON.parse(await readFile(join(updated.installedPath, '.codebuddy-plugin/plugin.json'), 'utf8'));
      assert.equal(installed.version, version, 'Update and rollback must install the selected source');
    });
  }
  await withEngine({ app, configDir, cwd: root }, async request => {
    await request('/plugins/uninstall', { plugin: pluginId });
    assert.ok(!(await request('/plugins')).some(item => `${item.name}@${item.marketplace}` === pluginId));
  });
  console.log('PASS: persistent installation, fresh-process discovery without plugin-directory env, exactly 11 hooks, update, rollback, paths with spaces, and uninstall.');
  console.log('Temporary configuration only. Desktop trigger acceptance is a separate check.');
} finally { await rm(configDir, { recursive: true, force: true }); }
