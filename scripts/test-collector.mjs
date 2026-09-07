import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, sendDemo } from './cli.mjs';
import { demoPayload, readJsonLines, spansFrom } from './data.mjs';
import { readPreview } from './preview.mjs';

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
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
const correlatorName = `${name}-correlator`;
const nodeImage = 'node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const image = 'otel/opentelemetry-collector-contrib:0.160.0@sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6';
let started = false;
let correlatorStarted = false;
let networkCreated = false;
try {
  docker(['network', 'create', name]); networkCreated = true;
  docker(['run', '--detach', '--name', correlatorName, '--network', name, '--network-alias', 'correlator',
    '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${join(root, 'collector')}:/app:ro`,
    '-v', `${directory}:/data`, nodeImage, 'node', '/app/correlator.mjs']);
  correlatorStarted = true;
  docker(['run', '--detach', '--name', name, '--user', `${process.getuid()}:${process.getgid()}`,
    '--network', name, '-p', '127.0.0.1::4319',
    '-v', `${join(root, 'collector/preview.yaml')}:/etc/preview.yaml:ro`,
    '-v', `${join(root, 'test/protobuf-loopback.yaml')}:/etc/probe.yaml:ro`,
    '-v', `${directory}:/data`, image, '--config=/etc/preview.yaml', '--config=/etc/probe.yaml']);
  started = true;
  const port = Number(docker(['port', name, '4319/tcp']).split(':').at(-1));
  let ready = false;
  for (let i = 0; i < 30; i++) { if (await connected(port)) { ready = true; break; } await delay(200); }
  assert.ok(ready, 'Collector did not become ready');
  const fixture = demoPayload();
  const tool = fixture.body.resourceSpans[0].scopeSpans[0].spans.find(span => span.attributes.some(item => item.value.stringValue === 'tool'));
  tool.attributes = tool.attributes.filter(item => item.key !== 'conversation.id');
  const sent = await sendDemo(port, fixture);
  let spans = [];
  for (let i = 0; i < 40; i++) {
    spans = spansFrom((await readPreview(directory)).batches).filter(span => span.traceId === sent.traceId);
    const raw = spansFrom(await readJsonLines(join(directory, 'traces.jsonl'))).filter(span => span.traceId === sent.traceId);
    if (spans.length >= 4 && raw.length >= 4) break;
    await delay(200);
  }
  assert.equal(spans.length, 4, 'All four spans must survive the protobuf round-trip');
  assert.equal(spans.filter(span => span.attributes['langfuse.observation.type'] === 'generation').length, 1);
  const model = spans.find(span => span.attributes['span.type'] === 'model_stream');
  assert.equal(model.attributes['langfuse.observation.model.name'], 'test-model');
  assert.equal(model.attributes['gen_ai.usage.input_tokens'], 100);
  assert.equal(model.attributes['gen_ai.usage.output_tokens'], 20);
  assert.equal(spans.find(span => span.attributes['span.type'] === 'tool').attributes['langfuse.observation.type'], 'tool');
  assert.equal(spans.find(span => span.attributes['span.type'] === 'tool').attributes['workbuddy.langfuse.session.origin'], 'trace-id');
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
  const rawTool = spansFrom(await readJsonLines(join(directory, 'traces.jsonl'))).find(span => span.spanId === tool.spanId);
  assert.equal(rawTool.attributes['langfuse.session.id'], undefined, 'Fixture must reproduce the actual missing-session input');
  assert.ok(!JSON.stringify((await readPreview(directory)).batches).includes('DO_NOT_CAPTURE_CONTENT'));
  console.log('PASS: protobuf → content filtering → OTLP JSON → durable Session correlation; IDs/parents/times and single-generation usage preserved.');
  console.log('This is a synthetic test. Live WorkBuddy verification is still required.');
} catch (error) {
  if (started) console.error(docker(['logs', name]));
  if (correlatorStarted) console.error(docker(['logs', correlatorName]));
  throw error;
} finally {
  if (started) docker(['rm', '--force', name]);
  if (correlatorStarted) docker(['rm', '--force', correlatorName]);
  if (networkCreated) docker(['network', 'rm', name]);
  await rm(directory, { recursive: true, force: true });
}
