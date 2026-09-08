import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { discoverAgents } from '../scripts/agents.mjs';
import { defaults, projectRoot } from '../scripts/settings.mjs';
import { readProfiles, saveAgent, profilePath, saveJson, setAgentEnabled } from '../scripts/profiles.mjs';
import { capture, readRollout, recordsForTurn } from '../plugins/codex-langfuse/runtime/hook.mjs';
import { DeliveryLedger, reconcileDeliveries, connectLangfuse } from '../scripts/delivery.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "helper agents ' "));
  const previous = process.env.LANGFUSE_HELPER_HOME;
  process.env.LANGFUSE_HELPER_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.LANGFUSE_HELPER_HOME; else process.env.LANGFUSE_HELPER_HOME = previous; await rm(home, { recursive: true, force: true }); });
  await cp(join(projectRoot, 'test/fixtures/codex/sessions'), join(home, 'sessions'), { recursive: true });
  return { home, rollout: name => join(home, 'sessions/2026/06/03', name) };
}
function configure(agent, base, project = 'project-one', name = agent, content = 'metadata') {
  return saveAgent(agent, name, { ...defaults, enabled: true, content, public_key: `pk-${project}`, secret_key: `sk-${project}`, organization_name: 'Personal' },
    { base, target: `${base}/${project}`, project: { id: project, name: project } });
}
async function endpoint(t) {
  const batches = [], observations = [];
  const control = { lose: false, reject: false };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const project = Buffer.from(req.headers.authorization.split(' ')[1], 'base64').toString().split(':')[0].slice(3);
    if (req.url === '/api/public/projects') return res.end(JSON.stringify({ data: [{ id: project, name: project }] }));
    if (req.url.startsWith('/api/public/v2/observations?')) return res.end(JSON.stringify({ data: observations, meta: {} }));
    assert.equal(req.url, '/api/public/otel/v1/traces');
    let body = ''; for await (const chunk of req) body += chunk;
    if (control.reject) return res.writeHead(401).end('{}');
    const payload = JSON.parse(body); batches.push(payload);
    for (const resource of payload.resourceSpans) for (const scope of resource.scopeSpans) for (const span of scope.spans) observations.push({
      id: span.spanId, traceId: span.traceId, metadata: { deliveryDigest: span.attributes.find(a => a.key.endsWith('.deliveryDigest')).value.stringValue },
    });
    if (control.lose) { req.socket.destroy(); return; }
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, batches, observations, control };
}

test('discovery distinguishes installed unsupported agents, desktop-only WorkBuddy and Codex bundled CLI', () => {
  const files = new Set(['/Applications/WorkBuddy.app', '/Applications/Codex.app', '/bin/claude', '/Applications/Codex.app/Contents/Resources/codex']);
  const found = discoverAgents({ env: { PATH: '/bin' }, home: '/user', exists: file => files.has(file), findExecutable: file => files.has(file) ? file : null });
  assert.equal(found[0].runnable, true); assert.equal(found[0].cli, null);
  assert.equal(found[1].runnable, true); assert.match(found[1].cli, /Resources\/codex$/);
  assert.equal(found[2].detected, true); assert.equal(found[2].supported, false); assert.deepEqual(found[2].commands, []);
  const cliOnly = discoverAgents({ env: { PATH: '/bin' }, home: '/user', exists: () => false, findExecutable: file => file === '/bin/workbuddy' ? file : null });
  assert.equal(cliOnly[0].detected, true); assert.equal(cliOnly[0].runnable, false);
});

test('targets route by actual project, allow sharing, isolate agent state and keep API keys private', async t => {
  await fixture(t);
  const a = configure('workbuddy', 'http://localhost:3000');
  const b = configure('codex', 'http://localhost:3000', 'project-one', 'workbuddy');
  assert.equal(a.identity, b.identity); assert.notEqual(a.data_directory, b.data_directory);
  const c = configure('codex', 'http://localhost:3000', 'project-two');
  assert.notEqual(b.data_directory, c.data_directory);
  const d = configure('codex', 'https://second.example', 'project-two', 'second');
  assert.notEqual(c.data_directory, d.data_directory);
  assert.throws(() => configure('codex', 'https://third.example', 'project-two', 'second'), /different project/);
  assert.equal((await stat(profilePath())).mode & 0o777, 0o600);
  const output = spawnSync(process.execPath, [join(projectRoot, 'bin/langfuse-helper.mjs'), 'targets'], { encoding: 'utf8' });
  assert.equal(output.status, 0); assert.doesNotMatch(output.stdout + output.stderr, /pk-|sk-/);
  assert.equal(readProfiles().agents.workbuddy.target, 'workbuddy');
});

test('Codex maps completed turns and nested subagents; metadata excludes text and text mode redacts secrets and reasoning', async t => {
  const f = await fixture(t), config = configure('codex', 'http://localhost:3000');
  const file = f.rollout('rollout-basic-main.jsonl');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replaceAll('List the files in the repo', 'password=secretfixture /Users/privateperson/repo sk-lf-1234567890'));
  const parsed = await readRollout(file);
  const metadata = await recordsForTurn(file, parsed, parsed.turns[0], config);
  assert.equal(metadata.length, 4);
  assert.doesNotMatch(JSON.stringify(metadata), /secretfixture|privateperson|1234567890|file1.txt|list files with ls/);
  const records = await recordsForTurn(file, parsed, parsed.turns[0], { ...config, content: 'text' });
  assert.doesNotMatch(JSON.stringify(records), /secretfixture|privateperson|1234567890|list files with ls/);
  assert.match(JSON.stringify(records), /REDACTED/);
  const usages = records.flatMap(r => r.payload.resourceSpans[0].scopeSpans[0].spans[0].attributes).filter(a => a.key.endsWith('usage_details')).map(a => JSON.parse(a.value.stringValue));
  assert.equal(usages.flatMap(Object.values).reduce((a, b) => a + b, 0), 300);
  const parentFile = f.rollout('rollout-parent.jsonl'), parent = await readRollout(parentFile);
  const nested = await recordsForTurn(parentFile, parent, parent.turns[0], config);
  const spans = nested.map(r => r.payload.resourceSpans[0].scopeSpans[0].spans[0]);
  assert.ok(spans.some(span => span.name === 'Codex Subagent Turn'));
  assert.equal(new Set(spans.map(span => span.traceId)).size, 1);
  for (const span of spans.filter(span => span.parentSpanId)) assert.ok(spans.some(parent => parent.spanId === span.parentSpanId));
});

test('Codex hook retries known rejection, skips acknowledged turns across runs and freezes task routing', async t => {
  const f = await fixture(t), remote = await endpoint(t);
  configure('codex', remote.base);
  const input = { transcript_path: f.rollout('rollout-basic-main.jsonl'), session_id: 'sess-basic', turn_id: 'turn-1' };
  remote.control.reject = true;
  await assert.rejects(capture(input), /401/);
  remote.control.reject = false;
  assert.equal((await capture(input)).uploaded, 4);
  assert.equal((await capture(input)).uploaded, 0);
  assert.equal(remote.batches.length, 1);
  assert.equal(existsSync(`${input.transcript_path}.langfuse`), false);
  configure('codex', remote.base, 'project-two', 'second');
  await assert.rejects(capture(input), /different target/);
  assert.equal(remote.batches.length, 1);
  setAgentEnabled('codex', false);
  assert.equal((await capture(input)).enabled, false);
});

test('Codex acknowledgement loss blocks replay, then exact remote reconciliation permits completion without another upload', async t => {
  const f = await fixture(t), remote = await endpoint(t), config = configure('codex', remote.base);
  const input = { transcript_path: f.rollout('rollout-basic-main.jsonl') };
  remote.control.lose = true;
  await assert.rejects(capture(input), /uncertain/);
  remote.control.lose = false;
  await assert.rejects(capture(input), /uncertain/);
  assert.equal(remote.batches.length, 1);
  const ledger = new DeliveryLedger(join(config.data_directory, 'langfuse-deliveries.sqlite'), config.identity);
  try {
    const connected = await connectLangfuse(config);
    assert.equal((await reconcileDeliveries(ledger, connected.request)).filter(row => row.status === 'accepted').length, 4);
  } finally { ledger.close(); }
  assert.equal((await capture(input)).uploaded, 0);
  assert.equal(remote.batches.length, 1);
});

test('Codex starts at the hook turn, excludes unfinished turns, preserves content mode, and preview writes no state', async t => {
  const f = await fixture(t), remote = await endpoint(t);
  configure('codex', remote.base);
  const file = f.rollout('rollout-two-turns-main.jsonl'), parsed = await readRollout(file);
  assert.equal(parsed.turns.length, 2);
  const preview = await capture({ transcript_path: file }, { send: false });
  assert.equal(preview.turns, 1); assert.equal(existsSync(join(f.home, 'bindings')), false);
  await capture({ transcript_path: file, turn_id: parsed.turns[0].turnId });
  assert.equal(remote.batches.length, 2);
  const saved = readProfiles(); saved.agents.codex.content = 'text'; saveJson(profilePath(), saved);
  assert.equal((await capture({ transcript_path: file }, { send: false })).content, 'metadata');
  await writeFile(file, '{invalid}\n');
  await assert.rejects(readRollout(file), /malformed complete line/);
});

test('Codex cached hook installs and removes with the real CLI in an isolated home', async t => {
  const f = await fixture(t), executable = discoverAgents().find(agent => agent.id === 'codex').cli;
  if (!executable) { t.skip('Codex is not installed'); return; }
  const env = { ...process.env, CODEX_HOME: join(f.home, 'codex') };
  await mkdir(env.CODEX_HOME);
  const run = args => {
    const result = spawnSync(process.execPath, [join(projectRoot, 'bin/langfuse-helper.mjs'), 'codex', ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  assert.match(run(['install']), /Installation does not grant hook trust/);
  const list = JSON.parse(spawnSync(executable, ['plugin', 'list', '--json'], { env, encoding: 'utf8' }).stdout);
  assert.equal(list.installed[0].pluginId, 'codex-langfuse@personal');
  const cached = join(env.CODEX_HOME, 'plugins/cache/personal/codex-langfuse/0.7.0/runtime/hook.mjs');
  assert.ok(existsSync(cached));
  // The cached bundle runs with Node only, without importing the helper installation.
  const hook = spawnSync(process.execPath, [cached, '--report'], { env, input: '{}', encoding: 'utf8', cwd: tmpdir() });
  assert.equal(hook.status, 0, hook.stderr); assert.equal(JSON.parse(hook.stdout).enabled, false);
  run(['uninstall']);
  assert.equal(JSON.parse(spawnSync(executable, ['plugin', 'list', '--json'], { env, encoding: 'utf8' }).stdout).installed.length, 0);
});
