import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../plugins/workbuddy-langfuse/scripts/hook.mjs', import.meta.url));
function run(input, directory, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env,
      WORKBUDDY_LANGFUSE_DATA_DIR: directory, WORKBUDDY_LANGFUSE_TEST: '1', ...overrides } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

test('hook captures identity without conversation content and remains silent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-lf-hook-'));
  try {
    const input = { session_id: 'session-1', hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_use_id: 'call-1', transcript_path: '/private/secret.jsonl', prompt: 'SECRET',
      tool_input: { command: 'SECRET' }, tool_response: 'SECRET' };
    assert.deepEqual(await run(JSON.stringify(input), dir), { code: 0, stdout: '', stderr: '' });
    const content = await readFile(join(dir, 'hooks.jsonl'), 'utf8');
    assert.ok(!content.includes('SECRET') && !content.includes('/private'));
    const event = JSON.parse(content);
    assert.equal(event.session_id, 'session-1');
    assert.equal(event.tool_use_id, 'call-1');
    assert.equal(event.transcriptAvailable, true);
    assert.equal(event.source, 'synthetic');
    assert.equal((await stat(join(dir, 'hooks.jsonl'))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a persistently installed hook stays inactive outside the diagnostic launch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-lf-disabled-'));
  try {
    assert.deepEqual(await run('{"session_id":"s","hook_event_name":"Stop"}', dir,
      { WORKBUDDY_LANGFUSE_TEST: '0', WORKBUDDY_LANGFUSE_ENABLED: '0' }), { code: 0, stdout: '', stderr: '' });
    await assert.rejects(readFile(join(dir, 'hooks.jsonl')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid input and unwritable output do not block WorkBuddy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-lf-invalid-'));
  try {
    assert.deepEqual(await run('bad-json', dir), { code: 0, stdout: '', stderr: '' });
    await mkdir(join(dir, 'hooks.jsonl'));
    assert.deepEqual(await run('{"session_id":"s","hook_event_name":"Stop"}', dir), { code: 0, stdout: '', stderr: '' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('parallel hook invocations produce complete independent diagnostic records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-lf-parallel-'));
  try {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => run(JSON.stringify({
      session_id: 's', hook_event_name: 'PreToolUse', tool_use_id: `call-${i}` }), dir)));
    assert.ok(results.every(result => result.code === 0 && result.stdout === ''));
    const records = (await readFile(join(dir, 'hooks.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(new Set(records.map(record => record.tool_use_id)).size, 12);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
