import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projectRoot, readConfig, writeConfig } from '../scripts/settings.mjs';
import { DeliveryLedger } from '../scripts/langfuse.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "wb lf cli ' "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'langfuse.json'), helper = join(directory, 'helper');
  const state = join(helper, 'state/workbuddy', createHash('sha256').update('http://127.0.0.1:1/project-test').digest('hex'));
  await mkdir(helper);
  await writeFile(join(helper, 'config.json'), JSON.stringify({ version: 1,
    targets: { workbuddy: { base_url: 'http://127.0.0.1:1', project_id: 'project-test', project_name: 'Test', public_key: 'pk-test', secret_key: 'sk-test' } },
    agents: { workbuddy: { target: 'workbuddy', enabled: false, content: 'metadata' } } }));
  const env = { ...process.env, LANGFUSE_HELPER_HOME: helper, WORKBUDDY_CONFIG_DIR: directory, WORKBUDDY_LANGFUSE_CONFIG: config, WORKBUDDY_LANGFUSE_STATE_DIR: state };
  for (const key of Object.keys(env)) if (/^(WORKBUDDY_)?LANGFUSE_(BASE_URL|PUBLIC_KEY|SECRET_KEY)$/.test(key)) delete env[key];
  return { directory, config, state, env };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000, ...options });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}

test('CLI help and version work without valid configuration; invalid arguments cannot run an action', async t => {
  const f = await fixture(t), executable = join(projectRoot, 'bin/langfuse-helper.mjs');
  await writeFile(f.config, '{"secret_key":"DO_NOT_PRINT_SECRET",');
  for (const args of [[], ['--help'], ['--version'], ['workbuddy', '--help'], ['codex', '--help'], ['agents', '--json'], ['workbuddy', 'configure', '--help']]) {
    const output = run(process.execPath, [executable, ...args], { env: f.env, cwd: tmpdir() });
    assert.doesNotMatch(output, /\p{Script=Han}|DO_NOT_PRINT_SECRET/u);
  }
  for (const args of [['unknown'], ['stop', '--dry-run'], ['start', 'extra'], ['verify'], ['export', 'session', '--oops'], ['recover', '--retry-confirmed-absent']]) {
    const result = spawnSync(process.execPath, [executable, 'workbuddy', ...args], { env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command|Invalid arguments/);
    assert.doesNotMatch(result.stderr, /DO_NOT_PRINT_SECRET|\p{Script=Han}/u);
  }
  const unsupported = spawnSync(process.execPath, [executable, 'unsupported', 'start'], { env: f.env, encoding: 'utf8' });
  assert.equal(unsupported.status, 1); assert.match(unsupported.stderr, /Unsupported agent/);
  assert.equal(existsSync(f.state), false);
});

test('npm package installs globally outside the source, updates and uninstalls while retaining configuration and accepted deliveries', async t => {
  const f = await fixture(t), prefix = join(f.directory, 'prefix');
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', f.directory], { cwd: projectRoot }))[0];
  const shipped = packed.files.map(file => file.path);
  for (const asset of ['bin/langfuse-helper.mjs', 'scripts/setup.mjs', 'collector/compose.yaml', 'collector/correlator.mjs', '.codebuddy-plugin/marketplace.json', 'plugins/workbuddy-langfuse/hooks/events.json', '.agents/plugins/marketplace.json', 'plugins/codex-langfuse/runtime/hook.mjs', 'plugins/codex-langfuse/vendor/LICENSE']) assert.ok(shipped.includes(asset), asset);
  assert.ok(!shipped.some(path => /(^|\/)(\.env[^/]*|\.local|dist|test)(\/|$)|\.command$|\.sqlite$/.test(path)));
  const config = { ...readConfig({ file: f.config, env: {} }), data_directory: f.state };
  await writeConfig(config, f.config); await mkdir(f.state, { recursive: true });
  const saved = await readFile(f.config, 'utf8');
  const savedProfile = await readFile(join(f.env.LANGFUSE_HELPER_HOME, 'config.json'), 'utf8');
  const records = [{ key: 'trace:span', digest: 'digest', payload: {} }];
  let ledger = new DeliveryLedger(join(f.state, 'langfuse-deliveries.sqlite'), 'http://fixture/project');
  ledger.reserve(records); ledger.finish(records, 'accepted'); ledger.close();
  const install = archive => run('npm', ['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: tmpdir(), env: f.env });
  install(join(f.directory, packed.filename));
  const executable = join(prefix, 'bin/langfuse-helper');
  assert.equal(run(executable, ['--version'], { cwd: tmpdir(), env: f.env }).trim(), manifest.version);
  assert.match(run(executable, ['workbuddy', 'status'], { cwd: tmpdir(), env: f.env }), /Delivery service: not running/);
  const nonInteractive = spawnSync(executable, ['workbuddy', 'configure'], { cwd: tmpdir(), env: f.env, encoding: 'utf8' });
  assert.equal(nonInteractive.status, 1); assert.match(nonInteractive.stderr, /interactive terminal/);
  assert.doesNotMatch(nonInteractive.stderr, /\p{Script=Han}/u);
  const update = join(f.directory, 'update'); await mkdir(update);
  run('tar', ['-xzf', join(f.directory, packed.filename), '-C', update]);
  const next = { ...manifest, version: '0.6.1-test' };
  await writeFile(join(update, 'package/package.json'), JSON.stringify(next));
  const nextPacked = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', f.directory], { cwd: join(update, 'package') }))[0];
  install(join(f.directory, nextPacked.filename));
  assert.equal(run(executable, ['--version'], { cwd: tmpdir(), env: f.env }).trim(), next.version);
  ledger = new DeliveryLedger(join(f.state, 'langfuse-deliveries.sqlite'), 'http://fixture/project');
  assert.equal(ledger.pending(records).length, 0); ledger.close();
  run('npm', ['uninstall', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', manifest.name], { cwd: tmpdir(), env: f.env });
  assert.equal(existsSync(executable), false);
  assert.equal(await readFile(f.config, 'utf8'), saved);
  assert.equal(await readFile(join(f.env.LANGFUSE_HELPER_HOME, 'config.json'), 'utf8'), savedProfile);
  assert.ok(existsSync(join(f.state, 'langfuse-deliveries.sqlite')));
});

test('status --json forwards authenticated runtime data and preserves failure exit codes', async t => {
  const f = await fixture(t); await mkdir(f.state, { recursive: true });
  const expected = { queue: 2, sessions: [], faults: [] };
  const server = createServer((req, res) => {
    assert.equal(req.url, '/status'); assert.equal(req.headers.authorization, 'Bearer test-token');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(expected));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await writeFile(join(f.state, 'service.json'), JSON.stringify({ port: server.address().port, token: 'test-token' }));
  const child = spawn(process.execPath, [join(projectRoot, 'bin/langfuse-helper.mjs'), 'workbuddy', 'status', '--json'], { env: f.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal(await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }), 0, stderr);
  assert.deepEqual(JSON.parse(stdout), expected);
  await rm(join(f.state, 'service.json'));
  const failed = spawnSync(process.execPath, [join(projectRoot, 'bin/langfuse-helper.mjs'), 'workbuddy', 'status', '--json'], { env: f.env, encoding: 'utf8' });
  assert.equal(failed.status, 1);
});
