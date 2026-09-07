import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSession, langfuseConfig } from './langfuse.mjs';
import { readPreview } from './preview.mjs';
import { spansFrom } from './data.mjs';
import { root } from './cli.mjs';

export function compareObservations(expected, actual, sessionId) {
  const key = span => `${span.traceId}:${span.spanId || span.id}`;
  const remote = new Map(actual.map(span => [key(span), span]));
  const empty = value => value == null || value === '';
  const timeMatches = (nano, date) => Number.isFinite(Date.parse(date)) && Math.abs(Number(BigInt(nano) / 1000000n) - Date.parse(date)) <= 1;
  const generations = expected.filter(span => span.attributes['langfuse.observation.type'] === 'generation');
  const checks = {
    exactObservations: actual.length === expected.length && remote.size === actual.length && expected.every(span => remote.has(key(span))),
    sessions: actual.length > 0 && actual.every(span => span.sessionId === sessionId),
    hierarchy: expected.every(span => (remote.get(key(span))?.parentObservationId || '') === (span.parentSpanId || '')),
    types: expected.every(span => remote.get(key(span))?.type?.toLowerCase() === span.attributes['langfuse.observation.type']),
    times: expected.every(span => timeMatches(span.startTimeUnixNano, remote.get(key(span))?.startTime)
      && timeMatches(span.endTimeUnixNano, remote.get(key(span))?.endTime)),
    generationUsageAvailable: generations.length > 0 && generations.every(span => ['input', 'output'].every(type => {
      const tokens = span.attributes[`gen_ai.usage.${type}_tokens`];
      return Number.isSafeInteger(tokens) && tokens >= 0;
    })),
    models: generations
      .every(span => remote.get(key(span))?.model === span.attributes['langfuse.observation.model.name']),
    usage: expected.every(span => {
      if (!remote.get(key(span))?.usageDetails) return false;
      const usage = remote.get(key(span)).usageDetails;
      return ['input', 'output'].every(type => {
        const tokens = span.attributes[`gen_ai.usage.${type}_tokens`];
        return tokens === undefined ? !usage[type] : usage[type] === tokens;
      });
    }),
    contentOmitted: actual.length > 0 && actual.every(span => Object.hasOwn(span, 'input') && Object.hasOwn(span, 'output') && empty(span.input) && empty(span.output)),
  };
  const total = type => actual.reduce((sum, span) => sum + (span.usageDetails?.[type] || 0), 0);
  return { passed: Object.values(checks).every(Boolean), checks, observations: actual.length,
    generationsWithUsage: actual.filter(span => span.type === 'GENERATION' && span.usageDetails?.input !== undefined && span.usageDetails?.output !== undefined).length,
    inputTokens: total('input'), outputTokens: total('output'),
    costNote: '原生模型为路由别名，缓存用量未导出；当前不验收费用。空值或显示 0 不代表免费。' };
}

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error('用法：npm run langfuse:verify -- <Session ID>');
  const preview = await readPreview(resolve(root, '.local/collector'));
  const expected = spansFrom(selectSession(preview.batches, sessionId).map(record => record.payload));
  const { request } = langfuseConfig();
  const actual = [];
  // Query by Trace, not Session, so missing/mismatched Session fields cannot disappear from verification.
  for (const traceId of new Set(expected.map(span => span.traceId))) {
    let cursor;
    const seen = new Set();
    do {
      const query = new URLSearchParams({ traceId, limit: '1000', fields: 'basic,time,usage,model,io', ...(cursor ? { cursor } : {}) });
      const response = await request(`/api/public/v2/observations?${query}`);
      if (!response.ok) throw new Error(`Langfuse 验证查询失败（HTTP ${response.status}）。`);
      const result = await response.json();
      actual.push(...result.data);
      cursor = result.meta?.cursor;
      if (cursor && seen.has(cursor)) throw new Error('Langfuse 返回了重复分页游标。');
      seen.add(cursor);
    } while (cursor);
  }
  const result = compareObservations(expected, actual, sessionId);
  console.log(JSON.stringify({ sessionId, ...result }, null, 2));
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
