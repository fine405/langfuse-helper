import { summarize } from './data.mjs';

const requiredHooks = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const typeOf = span => span.attributes['langfuse.observation.type'];

export function assessPhase1(allSpans, allHooks, sessionId) {
  const native = allSpans.filter(span => span.attributes['workbuddy.langfuse.source'] !== 'synthetic');
  const roots = native.filter(span => span.attributes['span.type'] === 'interaction'
    && span.attributes['langfuse.session.id'] === sessionId);
  const traceIds = [...new Set(roots.map(span => span.traceId))];
  // Select by trace after finding its session, so children missing a session stay visible.
  const spans = native.filter(span => traceIds.includes(span.traceId));
  const summary = summarize(spans);
  const hooks = allHooks.filter(hook => hook.source === 'workbuddy-hook' && hook.session_id === sessionId);
  const hookCounts = Object.fromEntries(requiredHooks.map(event => [event, hooks.filter(hook => hook.hook_event_name === event).length]));
  const toolIds = spans.filter(span => typeOf(span) === 'tool').map(span => span.attributes['tool.call_id']);
  const toolDurationsMs = spans.filter(span => typeOf(span) === 'tool').map(span => {
    if (!span.startTimeUnixNano || !span.endTimeUnixNano) return null;
    return Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6;
  });
  const checks = {
    twoMainTraces: roots.length === 2 && traceIds.length === 2,
    modelAndToolInEachTrace: traceIds.length === 2 && traceIds.every(id =>
      ['generation', 'tool'].every(type => spans.some(span => span.traceId === id && typeOf(span) === type))),
    sessionOnEverySpan: spans.length > 0 && spans.every(span => span.attributes['langfuse.session.id'] === sessionId),
    noDuplicateSpans: spans.length > 0 && summary.duplicateIdentities === 0,
    threeSecondTool: toolDurationsMs.some(duration => duration >= 3000)
      && toolDurationsMs.every(duration => duration !== null && Number.isFinite(duration) && duration >= 0),
    hooksForBothTurns: hookCounts.UserPromptSubmit === 2 && hookCounts.Stop === 2 && toolIds.length >= 2
      && toolIds.every(id => id && ['PreToolUse', 'PostToolUse'].every(event => hooks.filter(hook =>
        hook.hook_event_name === event && (hook.tool_use_id || hook.call_id) === id).length === 1)),
  };
  return { sessionId, passed: Object.values(checks).every(Boolean), checks, summary, traceIds,
    hookCounts, toolDurationsMs,
    missingSessionByType: spans.filter(span => !span.attributes['langfuse.session.id']).map(span => span.attributes['span.type']),
    note: '只检查指定会话的两轮主 Trace；模拟和辅助 Trace 不充当验收证据。用量缺失仍表示未知。' };
}
