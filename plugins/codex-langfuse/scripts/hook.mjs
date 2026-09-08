import { readFile, readdir } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { parseSession } from '../vendor/parse.ts';
import { resolveAgent, readProfiles, helperHome, readJson, saveJson, digest } from '../../../scripts/profiles.mjs';
import { DeliveryLedger, connectLangfuse, sendRecords } from '../../../scripts/delivery.mjs';
import { sanitizeContent } from '../../../scripts/content.mjs';
import { isMain } from '../../../scripts/entry.mjs';

export { parseSession };
const turnKey = turn => turn.turnId || String(turn.startTime);
export async function readRollout(file) {
  const lines = [];
  const text = await readFile(file, 'utf8'), raw = text.split('\n');
  for (const [index, line] of raw.entries()) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch {
      if (index !== raw.length - 1 || text.endsWith('\n')) throw new Error('Rollout contains a malformed complete line. Export stopped.');
    }
  }
  const parsed = parseSession(lines);
  if (!parsed.sessionMeta.sessionId || parsed.sessionMeta.sessionId === 'unknown') throw new Error('Rollout has no session identity.');
  return parsed;
}
async function findChild(parent, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid subagent identity.');
  const root = resolve(dirname(parent), '../../..');
  if (basename(root) !== 'sessions') throw new Error('Subagent lookup requires the Codex sessions/YYYY/MM/DD layout.');
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { const found = await walk(file); if (found) return found; }
      else if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) return file;
    }
  }
  return walk(root);
}
function usageDetails(usage) {
  if (!usage) return;
  const { input_tokens: input, output_tokens: output, total_tokens: total, cached_input_tokens: cached = 0, reasoning_output_tokens: reasoning = 0 } = usage;
  if (![input, output, total, cached, reasoning].every(n => Number.isSafeInteger(n) && n >= 0) || total !== input + output || cached > input || reasoning > output) return;
  return { input: input - cached, input_cached: cached, output: output - reasoning, output_reasoning: reasoning };
}
function attribute(key, value) {
  return { key, value: typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { intValue: String(value) } : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } };
}

// Only completed trees are exported. IDs do not depend on configuration, hook runs or API keys.
export async function recordsForTurn(file, parsed, turn, config) {
  const records = [], traceId = digest(`langfuse-helper:codex:${parsed.sessionMeta.sessionId}:${turnKey(turn)}`).slice(0, 32);
  const sessionId = `codex:${parsed.sessionMeta.sessionId}`, seen = new Set();
  const content = value => config.content === 'text' && value !== undefined ? JSON.stringify(sanitizeContent(value, config.maxContentChars).value) : undefined;
  const add = (key, name, type, start, end, parent, fields = {}) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid observation timestamps.');
    const spanId = digest(`${traceId}:${key}`).slice(0, 16);
    const attrs = { 'langfuse.session.id': sessionId, 'langfuse.trace.name': 'Codex',
      'langfuse.observation.type': type, 'langfuse.observation.metadata.agent': 'codex',
      'langfuse.observation.metadata.contentMode': config.content,
      'langfuse.observation.metadata.source': 'codex-rollout', ...fields };
    const span = { traceId, spanId, ...(parent ? { parentSpanId: parent } : {}), name,
      startTimeUnixNano: String(BigInt(Math.trunc(start)) * 1000000n), endTimeUnixNano: String(BigInt(Math.trunc(end)) * 1000000n),
      attributes: Object.entries(attrs).filter(([, v]) => v !== undefined).map(([k, v]) => attribute(k, v)) };
    span.attributes.push({ key: 'langfuse.trace.tags', value: { arrayValue: { values: [{ stringValue: 'codex' }] } } });
    const payload = { resourceSpans: [{ resource: { attributes: [attribute('service.name', 'langfuse-helper-codex')] }, scopeSpans: [{ scope: { name: 'langfuse-helper' }, spans: [span] }] }] };
    records.push({ key: `${traceId}:${spanId}`, digest: digest(JSON.stringify(payload)), payload });
    return spanId;
  };
  async function emit(currentFile, session, current, parent) {
    if (!current.completed) throw new Error('Waiting for a complete turn and subagent tree. Retry after completion.');
    const key = `${session.sessionMeta.sessionId}:${turnKey(current)}`;
    if (seen.has(key)) throw new Error('Repeated subagent reference. Export stopped.');
    seen.add(key);
    const root = add(key, parent ? 'Codex Subagent Turn' : 'Codex Turn', 'agent', current.startTime, current.endTime, parent, {
      'langfuse.observation.metadata.threadId': session.sessionMeta.sessionId,
      'langfuse.observation.metadata.turnId': turnKey(current),
      'langfuse.observation.metadata.aborted': current.aborted,
      'langfuse.observation.level': current.aborted ? 'WARNING' : 'DEFAULT',
      'langfuse.observation.input': content(current.userInput), 'langfuse.observation.output': content(current.finalOutput),
    });
    for (const [i, step] of current.steps.entries()) {
      const generation = add(`${key}:step:${i}`, 'LLM', 'generation', step.startTime, step.endTime, root, {
        'langfuse.observation.model.name': current.model,
        'langfuse.observation.usage_details': usageDetails(step.usage),
        'langfuse.observation.input': i === 0 ? content(current.userInput) : undefined,
        'langfuse.observation.output': content(step.text),
      });
      for (const [j, tool] of step.toolCalls.entries()) add(`${key}:step:${i}:tool:${tool.callId || j}`,
        tool.mcp ? `${tool.mcp.server}.${tool.mcp.tool}` : tool.name || 'tool', 'tool', tool.startTime, tool.endTime ?? step.endTime, generation, {
          'langfuse.observation.metadata.callId': tool.callId,
          'langfuse.observation.level': tool.error ? 'ERROR' : 'DEFAULT',
          'langfuse.observation.input': content(tool.args), 'langfuse.observation.output': content(tool.output),
        });
    }
    for (const id of current.subagentThreadIds) {
      const childFile = await findChild(currentFile, id);
      if (!childFile) throw new Error('A subagent rollout is not available yet. Retry after completion.');
      const child = await readRollout(childFile);
      if (!child.turns.length) throw new Error('Waiting for subagent turns.');
      for (const childTurn of child.turns) await emit(childFile, child, childTurn, root);
    }
  }
  await emit(file, parsed, turn);
  return records;
}

export async function capture(input, { send = true } = {}) {
  if (!readProfiles().agents.codex?.enabled) return { enabled: false, uploaded: 0 };
  const config = resolveAgent('codex');
  if (!input.transcript_path) throw new Error('Hook payload is missing transcript_path.');
  const parsed = await readRollout(input.transcript_path);
  if (input.session_id && input.session_id !== parsed.sessionMeta.sessionId) throw new Error('Hook session and rollout identity differ.');
  if (parsed.sessionMeta.isSubagentThread) return { uploaded: 0, reason: 'Subagent is exported through its parent.' };
  const bindingPath = join(helperHome(), 'bindings/codex', `${digest(parsed.sessionMeta.sessionId)}.json`);
  let binding = readJson(bindingPath, null);
  if (binding && binding.identity !== config.identity) throw new Error('This task belongs to a different target. Start a new Codex task, or select its original target.');
  if (!binding) {
    const first = input.turn_id ? parsed.turns.find(turn => turn.turnId === input.turn_id) : parsed.turns.findLast(turn => turn.completed);
    if (!first) throw new Error('The completed hook turn is not available in the rollout yet.');
    binding = { identity: config.identity, first: turnKey(first), content: config.content, maxContentChars: config.maxContentChars };
    if (send) {
      mkdirSync(dirname(bindingPath), { recursive: true, mode: 0o700 });
      try { writeFileSync(bindingPath, JSON.stringify(binding), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; binding = readJson(bindingPath, null); }
      if (!binding || binding.identity !== config.identity) throw new Error('Task target changed during capture. Start a new task.');
    }
  }
  const firstIndex = parsed.turns.findIndex(turn => turnKey(turn) === binding.first);
  if (firstIndex < 0) throw new Error('The original capture boundary is missing. Export stopped.');
  const settings = { ...config, content: binding.content, maxContentChars: binding.maxContentChars };
  const selected = parsed.turns.slice(firstIndex).filter(turn => turn.completed);
  if (!send) {
    const records = [];
    for (const turn of selected) records.push(...await recordsForTurn(input.transcript_path, parsed, turn, settings));
    return { mode: 'preview', sessionId: parsed.sessionMeta.sessionId, target: config.targetName, turns: selected.length, observations: records.length, content: settings.content };
  }
  const connected = await connectLangfuse(config);
  if (connected.target !== config.identity) throw new Error('API keys now resolve to another project. Configure a new target.');
  mkdirSync(config.data_directory, { recursive: true, mode: 0o700 });
  const ledger = new DeliveryLedger(join(config.data_directory, 'langfuse-deliveries.sqlite'), config.identity);
  const completedPath = join(config.data_directory, 'turns', `${digest(parsed.sessionMeta.sessionId)}.json`);
  const completed = new Set(readJson(completedPath, []));
  let uploaded = 0;
  try {
    for (const turn of selected) {
      if (completed.has(turnKey(turn))) continue;
      const records = await recordsForTurn(input.transcript_path, parsed, turn, settings);
      // Bound requests by bytes as well as count when users opt into larger content limits.
      let batch = [], bytes = 0;
      const flush = async () => {
        uploaded += await sendRecords(batch, ledger, body => connected.request('/api/public/otel/v1/traces', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' }, body,
        }));
        batch = []; bytes = 0;
      };
      for (const record of records) {
        const size = Buffer.byteLength(JSON.stringify(record.payload));
        if (batch.length && (batch.length >= 100 || bytes + size > 3 * 1024 * 1024)) await flush();
        batch.push(record); bytes += size;
      }
      if (batch.length) await flush();
      completed.add(turnKey(turn));
      saveJson(completedPath, [...completed]);
    }
    const status = { enabled: true, uploaded, deliveries: ledger.counts(), lastSuccess: new Date().toISOString(), target: config.targetName };
    saveJson(join(config.data_directory, 'status.json'), status);
    return status;
  } finally { ledger.close(); }
}

if (isMain(import.meta.url)) {
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const result = await capture(JSON.parse(text), { send: !process.argv.includes('--preview') });
    if (process.argv.includes('--report')) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    try { saveJson(join(resolveAgent('codex').data_directory, 'status.json'), { lastFailure: new Date().toISOString(), error: error.message }); } catch {}
    // A hook error must not interrupt the agent. Direct CLI operations do return a failure.
    if (process.argv.includes('--report')) { console.error(error.message); process.exitCode = 1; }
    else console.error('Langfuse Helper could not complete delivery. Run langfuse-helper codex status.');
  }
}
