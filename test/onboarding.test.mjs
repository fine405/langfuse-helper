import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readConfig, writeConfig, projectRoot } from '../scripts/settings.mjs';
import { collectConfig } from '../scripts/wizard.mjs';
import { verifyAndSave, assertServiceAvailable } from '../scripts/setup.mjs';
import { install, uninstallFiles, installationPaths, releaseFiles, requireStopped } from '../scripts/install.mjs';
import { DeliveryLedger } from '../scripts/langfuse.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "wb lf setup ' "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source'), home = join(directory, 'user');
  await mkdir(root); await mkdir(home);
  const file = join(home, '.workbuddy/langfuse.json');
  return { directory, root, home, file, options: { file, env: {} } };
}

test('user config has safe defaults, keeps explicit disabled, and has deterministic environment precedence', async t => {
  const f = await fixture(t);
  const initial = readConfig(f.options);
  assert.equal(initial.public_key, ''); assert.equal(initial.content, 'metadata'); assert.equal(initial.enabled, false);
  assert.equal(initial.data_directory, undefined);
  await writeConfig({ ...initial, enabled: false, public_key: 'pk-new', secret_key: 'sk-new' }, f.file);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const current = readConfig(f.options);
  assert.equal(current.enabled, false); assert.equal(current.public_key, 'pk-new');
  const override = readConfig({ ...f.options, env: { LANGFUSE_PUBLIC_KEY: 'pk-standard', LANGFUSE_SECRET_KEY: 'sk-standard',
    WORKBUDDY_LANGFUSE_PUBLIC_KEY: 'pk-scoped', WORKBUDDY_LANGFUSE_SECRET_KEY: 'sk-scoped' } });
  assert.equal(override.public_key, 'pk-scoped'); assert.equal(override.enabled, false);
  assert.throws(() => readConfig({ ...f.options, env: { LANGFUSE_PUBLIC_KEY: 'pk-partial' } }), /成对/);
});

test('invalid configuration cannot replace the previous file or expose its secret in an error', async t => {
  const f = await fixture(t), config = readConfig(f.options);
  await writeConfig(config, f.file); const original = await readFile(f.file, 'utf8');
  for (const patch of [{ enabled: 'true' }, { base_url: 'https://user:SECRET@example.test' }, { base_url: 'http://localhost:3000/api' },
    { content: 'everything' }, { secret_key: 'SECRET invalid' }, { prices: [] }, { data_directory: 'relative' }]) {
    await assert.rejects(writeConfig({ ...config, ...patch }, f.file), error => !error.message.includes('SECRET'));
    assert.equal(await readFile(f.file, 'utf8'), original);
  }
  await writeFile(f.file, '{"secret_key":"SECRET",');
  assert.throws(() => readConfig(f.options), error => !error.message.includes('SECRET'));
});

test('first-use wizard guides organization/project creation with defaults and never logs credentials', async t => {
  const f = await fixture(t), current = readConfig(f.options), questions = [], logs = [], opened = [];
  const answers = ['', '', '', '', '', '', 'bad-mode', '', ''];
  const keys = ['pk-fixture', 'sk-fixture'];
  const config = await collectConfig(current, { ask: async label => { questions.push(label); return answers.shift(); },
    secret: async () => keys.shift(), log: line => logs.push(line), openBrowser: async url => opened.push(url) });
  assert.equal(config.organization_name, 'Personal'); assert.equal(config.project_name, 'WorkBuddy');
  assert.equal(config.content, 'metadata'); assert.equal(config.enabled, true);
  assert.deepEqual(opened, ['http://localhost:3000']);
  assert.ok(logs.join('\n').includes('不会自动创建'));
  assert.ok(!logs.join('\n').includes('sk-fixture'));
  assert.ok(questions.some(label => label.includes('组织名称')));
  assert.equal(answers.length, 0);
});

test('existing users retain keys and skip creation; custom organization and project names are supported', async t => {
  const f = await fixture(t), current = { ...readConfig(f.options), public_key: 'pk-kept', secret_key: 'sk-kept', enabled: true };
  const questions = [];
  const unchanged = await collectConfig(current, { ask: async label => { questions.push(label); return ''; }, secret: async () => '', log: () => {}, openBrowser: () => assert.fail('unexpected browser') });
  assert.equal(unchanged.secret_key, 'sk-kept');
  assert.ok(!questions.some(label => label.includes('组织名称')));
  const answers = ['', 'n', 'Team', 'Agent Usage', 'n', '', 'text', 'n'];
  const changed = await collectConfig(current, { ask: async () => answers.shift(), secret: async () => '', log: () => {}, openBrowser: () => assert.fail('unexpected browser') });
  assert.equal(changed.organization_name, 'Team'); assert.equal(changed.project_name, 'Agent Usage');
  assert.equal(changed.content, 'text'); assert.equal(changed.enabled, false);
});

test('real HTTP validation saves the actual project, rejects auth failure and refuses a different ledger target', async t => {
  const f = await fixture(t), state = join(f.directory, 'state'); await mkdir(state);
  let project = { id: 'project-one', name: 'Actual project' }, reject = false;
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/public/projects');
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('pk-fixture:sk-fixture').toString('base64'));
    res.setHeader('Content-Type', 'application/json');
    if (reject) { res.writeHead(401).end('{}'); return; }
    res.end(JSON.stringify({ data: [project] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { ...readConfig(f.options), enabled: true, base_url: `http://127.0.0.1:${server.address().port}`, public_key: 'pk-fixture', secret_key: 'sk-fixture' };
  const saved = await verifyAndSave(config, { file: f.file, directory: state });
  assert.equal(saved.project_name, 'Actual project'); assert.equal(saved.project_id, 'project-one');
  const original = await readFile(f.file, 'utf8');
  reject = true;
  await assert.rejects(verifyAndSave(config, { file: f.file, directory: state }), /401/);
  assert.equal(await readFile(f.file, 'utf8'), original);
  await verifyAndSave({ ...saved, enabled: false }, { file: f.file, directory: state });
  assert.equal(readConfig({ file: f.file, env: {} }).enabled, false, 'Existing users can disable capture while Langfuse is unavailable');
  await writeFile(f.file, original); reject = false;
  const ledger = new DeliveryLedger(join(state, 'langfuse-deliveries.sqlite'), `${config.base_url}/project-one`);
  ledger.reserve([{ key: 'trace:span', digest: 'digest', payload: {} }]); ledger.close();
  project = { id: 'project-two', name: 'Wrong project' };
  await assert.rejects(verifyAndSave(config, { file: f.file, directory: state }), /另一个/);
  assert.equal(await readFile(f.file, 'utf8'), original);
});

test('installer works from an extracted directory, updates in place, launches outside the source and preserves config/data on uninstall', async t => {
  const f = await fixture(t), paths = installationPaths(f.home, join(f.home, '.workbuddy'), f.file);
  for (const file of releaseFiles) await cp(join(projectRoot, file), join(f.root, file), { recursive: true });
  await writeFile(join(f.root, '.env.ignore-me'), 'secret must not ship');
  const result = await install({ source: f.root, paths });
  assert.equal(result.version, '0.5.0');
  assert.equal(existsSync(join(paths.app, '.env.ignore-me')), false);
  assert.equal((await stat(paths.bin)).mode & 0o777, 0o700);
  const help = spawnSync(paths.bin, ['--help'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /configure/);
  const stopped = spawnSync(paths.bin, ['status'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(stopped.status, 0, stopped.stderr); assert.match(stopped.stdout, /未运行/);
  await writeFile(join(result.state, 'keep-ledger'), 'preserved');
  const record = { key: 'trace:span', digest: 'digest', payload: {} };
  let ledger = new DeliveryLedger(join(result.state, 'langfuse-deliveries.sqlite'), 'http://fixture/project');
  ledger.reserve([record]); ledger.finish([record], 'accepted'); ledger.close();
  const before = readConfig({ file: f.file, env: {} });
  const manifest = JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8')); manifest.version = '0.5.1';
  await writeFile(join(f.root, 'package.json'), JSON.stringify(manifest));
  await install({ source: f.root, paths });
  assert.equal(JSON.parse(await readFile(paths.marker, 'utf8')).version, '0.5.1');
  assert.deepEqual(readConfig({ file: f.file, env: {} }), before);
  ledger = new DeliveryLedger(join(result.state, 'langfuse-deliveries.sqlite'), 'http://fixture/project');
  assert.equal(ledger.pending([record]).length, 0, 'Updating code must not replay accepted records'); ledger.close();
  await uninstallFiles(paths);
  assert.equal(existsSync(paths.bin), false); assert.equal(existsSync(paths.app), false);
  assert.equal(existsSync(f.file), true); assert.equal(await readFile(join(result.state, 'keep-ledger'), 'utf8'), 'preserved');
});

test('installation refuses a live writer and installation refuses unrelated commands', async t => {
  const f = await fixture(t), paths = installationPaths(f.home, join(f.home, '.workbuddy'), f.file);
  await writeFile(join(f.root, 'service.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(requireStopped(f.root), /仍在运行/);
  await mkdir(join(f.home, '.local/bin'), { recursive: true });
  await writeFile(paths.bin, 'unrelated user command');
  await assert.rejects(install({ source: f.root, paths }), /不会覆盖/);
  assert.equal(await readFile(paths.bin, 'utf8'), 'unrelated user command');
  await writeConfig({ ...readConfig(f.options), data_directory: join(paths.app, 'state') }, f.file);
  await assert.rejects(install({ source: f.root, paths }), /安装目录之外/);
});

test('start refuses an unrelated service before changing Collector, and accepts its own authenticated service', async t => {
  const f = await fixture(t);
  const server = createServer((req, res) => {
    if (req.headers.authorization === 'Bearer fixture-token') res.end('{}');
    else res.writeHead(403).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(assertServiceAvailable(port, f.root), /另一处/);
  await writeFile(join(f.root, 'service.json'), JSON.stringify({ port, token: 'fixture-token' }));
  await assertServiceAvailable(port, f.root);
});
