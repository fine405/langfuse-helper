import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, sendDemo } from './cli.mjs';
import { readJsonLines, spansFrom } from './data.mjs';

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return result.stdout.trim();
}

async function connected(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, { signal: AbortSignal.timeout(500) });
    await response.text();
    return response.status === 405;
  } catch { return false; }
}

await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, '.local/collector-test-'));
const name = `workbuddy-langfuse-test-${randomBytes(4).toString('hex')}`;
const image = 'otel/opentelemetry-collector-contrib:0.160.0@sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6';
let started = false;
try {
  docker(['run', '--detach', '--rm', '--name', name, '--user', `${process.getuid()}:${process.getgid()}`,
    '-p', '127.0.0.1::4319',
    '-v', `${join(root, 'collector/preview.yaml')}:/etc/preview.yaml:ro`,
    '-v', `${join(root, 'test/protobuf-loopback.yaml')}:/etc/probe.yaml:ro`,
    '-v', `${directory}:/data`, image, '--config=/etc/preview.yaml', '--config=/etc/probe.yaml']);
  started = true;
  const port = Number(docker(['port', name, '4319/tcp']).split(':').at(-1));
  let ready = false;
  for (let i = 0; i < 30; i++) { if (await connected(port)) { ready = true; break; } await delay(200); }
  assert.ok(ready, 'Collector did not become ready');
  const sent = await sendDemo(port);
  let spans = [];
  for (let i = 0; i < 40; i++) {
    spans = spansFrom(await readJsonLines(join(directory, 'traces.jsonl'))).filter(span => span.traceId === sent.traceId);
    if (spans.length >= 4) break;
    await delay(200);
  }
  assert.equal(spans.length, 4, 'All four spans must survive the protobuf round-trip');
  assert.equal(spans.filter(span => span.attributes['langfuse.observation.type'] === 'generation').length, 1);
  const model = spans.find(span => span.attributes['span.type'] === 'model_stream');
  assert.equal(model.attributes['langfuse.observation.model.name'], 'test-model');
  assert.equal(model.attributes['gen_ai.usage.input_tokens'], 100);
  assert.equal(model.attributes['gen_ai.usage.output_tokens'], 20);
  assert.equal(spans.find(span => span.attributes['span.type'] === 'tool').attributes['langfuse.observation.type'], 'tool');
  assert.equal(spans.find(span => span.spanId === sent.rootId).attributes['langfuse.observation.type'], 'agent');
  for (const span of spans) {
    assert.equal(span.attributes['langfuse.session.id'], sent.sessionId);
    assert.equal(span.attributes['workbuddy.langfuse.source'], 'synthetic');
    assert.equal(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano), 1000000000n);
    if (span.spanId !== sent.rootId) assert.equal(span.parentSpanId, sent.rootId);
    if (span !== model) {
      assert.equal(span.attributes['gen_ai.usage.input_tokens'], undefined);
      assert.equal(span.attributes['gen_ai.usage.output_tokens'], undefined);
    }
  }
  const output = await readFile(join(directory, 'traces.jsonl'), 'utf8');
  assert.ok(!output.includes('DO_NOT_CAPTURE_CONTENT') && !output.includes('sensitive-name'));
  console.log('PASS: protobuf ingestion, session/type/model mapping, IDs/parents/times, usage counted on one generation, content omitted.');
  console.log('This is a synthetic test. Live WorkBuddy verification is still required.');
} catch (error) {
  if (started) console.error(docker(['logs', name]));
  throw error;
} finally {
  if (started) docker(['stop', name]);
  await rm(directory, { recursive: true, force: true });
}
