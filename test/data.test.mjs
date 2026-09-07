import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributes, readJsonLines, summarize } from '../scripts/data.mjs';

test('zero token counts remain known, and an absent count stays unknown', () => {
  assert.deepEqual(attributes([{ key: 'tokens', value: { intValue: '0' } }]), { tokens: 0 });
  assert.equal(attributes([]).tokens, undefined);
});

test('diagnostics expose duplicate spans rather than concealing them', () => {
  const span = { traceId: 't', spanId: 's', attributes: { 'langfuse.session.id': 'session',
    'langfuse.observation.type': 'generation', 'gen_ai.usage.input_tokens': 0, 'gen_ai.usage.output_tokens': 2 } };
  const result = summarize([span, span, { traceId: 't2', spanId: 's2', attributes: {} }]);
  assert.equal(result.spans, 3);
  assert.equal(result.duplicateIdentities, 1);
  assert.equal(result.missingSession, 1);
  assert.equal(result.sessions, 1);
  assert.equal(result.traces, 2);
  assert.equal(result.modelsWithUsage, 2);
});

test('live diagnostic reads tolerate a trailing partial line but reject corrupt complete lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-lf-lines-'));
  try {
    const file = join(dir, 'events.jsonl');
    assert.deepEqual(await readJsonLines(file), []);
    await writeFile(file, '{"id":1}\n{"id":');
    assert.deepEqual(await readJsonLines(file), [{ id: 1 }]);
    await writeFile(file, '{"id":1}\nINVALID\n');
    await assert.rejects(readJsonLines(file));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
