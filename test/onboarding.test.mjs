import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { readConfig, writeConfig } from '../scripts/settings.mjs';
import { collectConfig } from '../scripts/wizard.mjs';
import { assertServiceAvailable } from '../scripts/setup.mjs';
import { connectLangfuse } from '../scripts/delivery.mjs';
import { saveAgent, setAgentEnabled, readProfiles, profilePath } from '../scripts/profiles.mjs';

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
  assert.throws(() => readConfig({ ...f.options, env: { LANGFUSE_PUBLIC_KEY: 'pk-partial' } }), /set together/);
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
  assert.ok(logs.join('\n').includes('does not create'));
  assert.ok(!logs.join('\n').includes('sk-fixture'));
  assert.ok(questions.some(label => label.includes('Organization name')));
  assert.equal(answers.length, 0);
});

test('existing users retain keys and skip creation; custom organization and project names are supported', async t => {
  const f = await fixture(t), current = { ...readConfig(f.options), public_key: 'pk-kept', secret_key: 'sk-kept', enabled: true };
  const questions = [];
  const unchanged = await collectConfig(current, { ask: async label => { questions.push(label); return ''; }, secret: async () => '', log: () => {}, openBrowser: () => assert.fail('unexpected browser') });
  assert.equal(unchanged.secret_key, 'sk-kept');
  assert.ok(!questions.some(label => label.includes('Organization name')));
  const answers = ['', 'n', 'Team', 'Agent Usage', 'n', '', 'text', 'n'];
  const changed = await collectConfig(current, { ask: async () => answers.shift(), secret: async () => '', log: () => {}, openBrowser: () => assert.fail('unexpected browser') });
  assert.equal(changed.organization_name, 'Team'); assert.equal(changed.project_name, 'Agent Usage');
  assert.equal(changed.content, 'text'); assert.equal(changed.enabled, false);
});

test('real HTTP validation saves the actual project, rejects auth failure and refuses target retargeting', async t => {
  const f = await fixture(t);
  const previousHome = process.env.LANGFUSE_HELPER_HOME;
  process.env.LANGFUSE_HELPER_HOME = f.home;
  t.after(() => { if (previousHome === undefined) delete process.env.LANGFUSE_HELPER_HOME; else process.env.LANGFUSE_HELPER_HOME = previousHome; });
  const verifyAndSave = async config => saveAgent('workbuddy', 'workbuddy', config, await connectLangfuse(config));
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
  const saved = await verifyAndSave(config);
  assert.equal(saved.project_name, 'Actual project'); assert.equal(saved.project_id, 'project-one');
  const original = await readFile(profilePath(), 'utf8');
  reject = true;
  await assert.rejects(verifyAndSave(config), /401/);
  assert.equal(await readFile(profilePath(), 'utf8'), original);
  setAgentEnabled('workbuddy', false);
  assert.equal(readProfiles().agents.workbuddy.enabled, false, 'Capture can be disabled while Langfuse is unavailable');
  await writeFile(profilePath(), original); reject = false;
  project = { id: 'project-two', name: 'Wrong project' };
  await assert.rejects(verifyAndSave(config), /different project/);
  assert.equal(await readFile(profilePath(), 'utf8'), original);
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
  await assert.rejects(assertServiceAvailable(port, f.root), /Another integration/);
  await writeFile(join(f.root, 'service.json'), JSON.stringify({ port, token: 'fixture-token' }));
  await assertServiceAvailable(port, f.root);
});
