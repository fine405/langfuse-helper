import { attributes } from './data.mjs';
import { sanitizeContent } from './content.mjs';

const spanOf = batch => batch.resourceSpans[0].scopeSpans[0].spans[0];
const set = (span, key, value) => {
  span.attributes = span.attributes.filter(item => item.key !== key);
  span.attributes.push({ key, value: typeof value === 'number' ? { doubleValue: value } : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } });
};

export function usageDetails(record) {
  const { input, output, cacheRead, cacheWrite } = record.usage || {};
  if (input === undefined || output === undefined) return null;
  const cached = (cacheRead || 0) + (cacheWrite || 0);
  if (cached > 0 && !record.inputIncludesCache) throw new Error('Cache accounting convention is unverified');
  if (cached > input) throw new Error('Cache input exceeds total input');
  return { input: input - cached, output,
    ...(cacheRead !== undefined ? { input_cached: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { input_cache_creation: cacheWrite } : {}) };
}

export function estimateCost(usage, price) {
  if (!price) return null;
  if (price.currency !== 'USD' || typeof price.source !== 'string' || !price.source.trim()) throw new Error('Prices require USD currency and an explicit source');
  const costs = {};
  for (const [type, tokens] of Object.entries(usage)) {
    if (!tokens) { costs[type] = 0; continue; }
    const rate = price.perMillion?.[type];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) throw new Error(`Missing or invalid price for ${type}`);
    costs[type] = tokens * rate / 1e6;
  }
  return { ...costs, total: Object.values(costs).reduce((sum, amount) => sum + amount, 0) };
}

export function enrichBatches(batches, records, { content = 'metadata', prices = {}, maxContentChars = 16000 } = {}) {
  const messages = new Map(), tools = new Map();
  let input = null;
  for (const record of records) {
    if (record.role === 'user') input = record.content;
    if (record.messageId && record.traceId && (record.type === 'function_call' || record.role === 'assistant')) {
      const key = `${record.sessionId}:${record.traceId}:${record.messageId}`;
      const previous = messages.get(key);
      if (previous?.record.usage && record.usage && JSON.stringify(previous.record.usage) !== JSON.stringify(record.usage)) throw new Error('Conflicting usage for one model response');
      const entry = previous || { record, input, output: [], callIds: new Set() };
      if (record.usage) entry.record = record;
      if (record.content) {
        if (record.type === 'function_call' && !entry.callIds.has(record.callId)) {
          entry.callIds.add(record.callId);
          entry.output.push({ type: 'tool_call', id: record.callId, name: record.name, arguments: record.content.value });
        } else if (record.role === 'assistant') entry.output = [{ type: 'text', text: record.content.value }];
      }
      messages.set(key, entry);
    }
    if (record.callId && record.traceId) {
      const key = `${record.sessionId}:${record.traceId}:${record.callId}`;
      const pair = tools.get(key) || {};
      if (record.type === 'function_call') pair.input = record.content;
      if (record.type === 'function_call_result') { pair.output = record.content; pair.status = record.status; }
      tools.set(key, pair);
    }
  }
  return batches.map(batch => {
    const result = structuredClone(batch), span = spanOf(result), attrs = attributes(span.attributes);
    const session = attrs['langfuse.session.id'], type = attrs['span.type'];
    const cancelled = records.some(record => record.sessionId === session && record.traceId === span.traceId && record.cancelled);
    if (cancelled && type === 'interaction') {
      set(span, 'langfuse.observation.metadata.workbuddyOutcome', 'cancelled');
      set(span, 'langfuse.observation.level', 'WARNING');
    }
    let io;
    if (type === 'model_stream') {
      const message = messages.get(`${session}:${span.traceId}:${attrs['workbuddy.message_id'] || attrs['message.id']}`);
      if (!message?.record.usage) return result;
      const record = message.record, usage = usageDetails(record);
      if (usage) {
        for (const key of ['input', 'output']) {
          const native = attrs[`gen_ai.usage.${key}_tokens`];
          if (native !== undefined && native !== record.usage[key]) throw new Error(`Native and transcript ${key} usage disagree`);
        }
        set(span, 'langfuse.observation.usage_details', usage);
        set(span, 'langfuse.observation.metadata.inputTokensIncludingCache', record.usage.input);
      }
      if (record.model) set(span, 'langfuse.observation.model.name', record.model);
      set(span, 'langfuse.observation.metadata.enrichment', 'workbuddy-transcript');
      if (record.requestModel) set(span, 'langfuse.observation.metadata.requestModel', record.requestModel);
      if (record.credits !== undefined) set(span, 'langfuse.observation.metadata.workbuddyCredits', record.credits);
      const costs = usage && estimateCost(usage, prices[record.model]);
      set(span, 'langfuse.observation.metadata.costBasis', costs ? 'configured-usd-estimate' : 'workbuddy-credits; monetary-cost-unknown');
      if (costs) {
        set(span, 'langfuse.observation.cost_details', costs);
        set(span, 'langfuse.observation.metadata.priceSource', prices[record.model].source);
      }
      io = { input: message.input, output: sanitizeContent(message.output, maxContentChars) };
      set(span, 'langfuse.observation.metadata.inputScope', 'user-query; system-context-and-history-omitted');
    } else if (type === 'tool' || type === 'mcp_call') {
      io = tools.get(`${session}:${span.traceId}:${attrs['tool.call_id']}`);
      if (cancelled && !io?.output) set(span, 'langfuse.observation.metadata.outputUnavailable', 'cancelled-before-transcript-result');
    }
    if (content === 'text' && io) {
      for (const key of ['input', 'output']) if (io[key]) {
        set(span, `langfuse.observation.${key}`, io[key].value);
        if (io[key].truncated) set(span, `langfuse.observation.metadata.${key}Truncated`, 'true');
        if (io[key].redacted) set(span, `langfuse.observation.metadata.${key}Redacted`, 'true');
      }
      set(span, 'langfuse.observation.metadata.contentMode', 'text');
    }
    return result;
  });
}
