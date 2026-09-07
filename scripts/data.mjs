import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export const attributes = (items = []) => Object.fromEntries(items.map(({ key, value }) => [key,
  value?.stringValue ?? (value?.intValue !== undefined ? Number(value.intValue) : undefined) ?? value?.boolValue ?? value?.doubleValue,
]));

export async function readJsonLines(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.split('\n');
  lines.pop(); // Live files may end with a partial write; wait for the newline.
  return lines.filter(line => line.trim()).map(line => JSON.parse(line));
}

export function spansFrom(batches) {
  return batches.flatMap(batch => (batch.resourceSpans || []).flatMap(resource =>
    (resource.scopeSpans || []).flatMap(scope => (scope.spans || []).map(span => ({
      traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
      name: span.name, attributes: attributes(span.attributes),
      startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano,
    })))));
}

export function summarize(spans) {
  const counts = {};
  const identities = new Set();
  let duplicates = 0;
  for (const span of spans) {
    const identity = `${span.traceId}:${span.spanId}`;
    if (identities.has(identity)) duplicates++;
    identities.add(identity);
    const type = span.attributes['langfuse.observation.type'] || 'unclassified';
    counts[type] = (counts[type] || 0) + 1;
  }
  const sessions = new Set(spans.map(span => span.attributes['langfuse.session.id']).filter(Boolean));
  return { spans: spans.length, traces: new Set(spans.map(span => span.traceId)).size,
    sessions: sessions.size, types: counts, duplicateIdentities: duplicates,
    missingSession: spans.filter(span => !span.attributes['langfuse.session.id']).length,
    modelsWithUsage: spans.filter(span => span.attributes['langfuse.observation.type'] === 'generation'
      && span.attributes['gen_ai.usage.input_tokens'] !== undefined
      && span.attributes['gen_ai.usage.output_tokens'] !== undefined).length };
}

const kv = object => Object.entries(object).map(([key, value]) => ({ key, value:
  typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } }));

export function demoPayload() {
  const traceId = randomBytes(16).toString('hex');
  const rootId = randomBytes(8).toString('hex');
  const sessionId = `synthetic-${traceId}`;
  const now = BigInt(Date.now()) * 1000000n;
  const common = { 'conversation.id': sessionId, 'workbuddy.langfuse.source': 'synthetic' };
  const make = (type, extra = {}, root = false) => ({
    traceId, spanId: root ? rootId : randomBytes(8).toString('hex'),
    ...(root ? {} : { parentSpanId: rootId }),
    name: `sensitive-name-${type}`, kind: 1,
    startTimeUnixNano: String(now - 1000000000n), endTimeUnixNano: String(now),
    attributes: kv({ ...common, 'span.type': type, user_prompt: 'DO_NOT_CAPTURE_CONTENT', ...extra }),
    events: [{ name: 'DO_NOT_CAPTURE_CONTENT', timeUnixNano: String(now), attributes: kv({ content: 'DO_NOT_CAPTURE_CONTENT' }) }],
    status: { code: 1, message: 'DO_NOT_CAPTURE_CONTENT' },
  });
  return { traceId, rootId, sessionId, body: { resourceSpans: [{
    resource: { attributes: kv({ 'service.name': 'workbuddy-langfuse-demo', 'user.email': 'DO_NOT_CAPTURE_CONTENT' }) },
    scopeSpans: [{ scope: { name: 'workbuddy-preview-test' }, spans: [
      make('interaction', { 'gen_ai.usage.input_tokens': 999 }, true),
      make('model_stream', { 'model.id': 'test-model', 'llm.usage.prompt_tokens': 100, 'llm.usage.completion_tokens': 20 }),
      make('tool', { tool_name: 'Bash', 'tool.call_id': 'demo-call', 'gen_ai.usage.output_tokens': 999 }),
      make('model_request', { 'model.id': 'test-model', 'gen_ai.usage.input_tokens': 100 }),
    ] }],
  }] } };
}
