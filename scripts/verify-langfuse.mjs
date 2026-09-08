import { isMain } from './entry.mjs';
import { resolve } from 'node:path';
import { selectSession, langfuseConfig } from './langfuse.mjs';
import { readPreview } from './preview.mjs';
import { spansFrom } from './data.mjs';
import { local } from './cli.mjs';
import { enrichSession } from './session-input.mjs';

export function compareObservations(expected, actual, sessionId) {
  const key = span => `${span.traceId}:${span.spanId || span.id}`;
  const remote = new Map(actual.map(span => [key(span), span]));
  const empty = value => value == null || value === '';
  const decoded = value => { try { return JSON.parse(value); } catch { return value; } };
  const expectedUsage = span => {
    const provided = span.attributes['langfuse.observation.usage_details'];
    return provided ? JSON.parse(provided) : Object.fromEntries(['input', 'output'].map(key => [key, span.attributes[`gen_ai.usage.${key}_tokens`]]).filter(([, value]) => value !== undefined));
  };
  const timeMatches = (nano, date) => Number.isFinite(Date.parse(date)) && Math.abs(Number(BigInt(nano) / 1000000n) - Date.parse(date)) <= 1;
  const generations = expected.filter(span => span.attributes['langfuse.observation.type'] === 'generation');
  const checks = {
    exactObservations: actual.length === expected.length && remote.size === actual.length && expected.every(span => remote.has(key(span))),
    sessions: actual.length > 0 && actual.every(span => span.sessionId === sessionId),
    hierarchy: expected.every(span => (remote.get(key(span))?.parentObservationId || '') === (span.parentSpanId || '')),
    types: expected.every(span => remote.get(key(span))?.type?.toLowerCase() === span.attributes['langfuse.observation.type']),
    times: expected.every(span => timeMatches(span.startTimeUnixNano, remote.get(key(span))?.startTime)
      && timeMatches(span.endTimeUnixNano, remote.get(key(span))?.endTime)),
    generationUsageAvailable: generations.length > 0 && generations.every(span => {
      const usage = expectedUsage(span);
      return usage.input !== undefined && usage.output !== undefined && Object.values(usage).every(tokens => Number.isSafeInteger(tokens) && tokens >= 0);
    }),
    models: generations
      .every(span => remote.get(key(span))?.model === span.attributes['langfuse.observation.model.name']),
    usage: expected.every(span => {
      if (!remote.get(key(span))?.usageDetails) return false;
      const usage = remote.get(key(span)).usageDetails;
      const expected = expectedUsage(span);
      return Object.entries(expected).every(([type, tokens]) => usage[type] === tokens)
        && Object.entries(usage).every(([type, tokens]) => type === 'total' ? tokens === Object.values(expected).reduce((sum, value) => sum + value, 0) : expected[type] === tokens || tokens === 0);
    }),
    content: expected.every(span => ['input', 'output'].every(type => {
      const observed = remote.get(key(span));
      if (!observed || !Object.hasOwn(observed, type)) return false;
      const wanted = span.attributes[`langfuse.observation.${type}`];
      return wanted === undefined ? empty(observed[type]) : JSON.stringify(decoded(wanted)) === JSON.stringify(decoded(observed[type]));
    })),
    credits: expected.every(span => {
      const credits = span.attributes['langfuse.observation.metadata.workbuddyCredits'];
      return credits === undefined || Number(remote.get(key(span))?.metadata?.workbuddyCredits) === credits;
    }),
    configuredCost: expected.every(span => {
      const provided = span.attributes['langfuse.observation.cost_details'];
      if (!provided) return true;
      const observed = remote.get(key(span))?.costDetails || {};
      return Object.entries(JSON.parse(provided)).every(([type, cost]) => typeof observed[type] === 'number' && Math.abs(observed[type] - cost) < 1e-9);
    }),
  };
  const total = type => actual.reduce((sum, span) => sum + (span.usageDetails?.[type] || 0), 0);
  return { passed: Object.values(checks).every(Boolean), checks, observations: actual.length,
    generationsWithUsage: actual.filter(span => span.type === 'GENERATION' && span.usageDetails?.input !== undefined && span.usageDetails?.output !== undefined).length,
    inputTokens: total('input') + total('input_cached') + total('input_cache_creation'), outputTokens: total('output'),
    cachedInputTokens: total('input_cached'),
    workbuddyCredits: Number(actual.reduce((sum, span) => sum + Number(span.metadata?.workbuddyCredits || 0), 0).toFixed(8)),
    costNote: 'WorkBuddy 积分与 USD 成本分开；configuredCost 仅核对显式配置的估算，不把积分或未知值当成美元费用。' };
}

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error('用法：npm run langfuse:verify -- <Session ID>');
  const preview = await readPreview(resolve(local, 'collector'));
  const expected = spansFrom((await enrichSession(selectSession(preview.batches, sessionId), sessionId)).map(record => record.payload));
  const { request } = langfuseConfig();
  const actual = [];
  // Query by Trace, not Session, so missing/mismatched Session fields cannot disappear from verification.
  for (const traceId of new Set(expected.map(span => span.traceId))) {
    let cursor;
    const seen = new Set();
    do {
      const query = new URLSearchParams({ traceId, limit: '1000', fields: 'basic,time,usage,model,io,metadata', ...(cursor ? { cursor } : {}) });
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

if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
