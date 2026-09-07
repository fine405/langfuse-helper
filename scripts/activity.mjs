import { execFileSync } from 'node:child_process';

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,comm='], { encoding: 'utf8', timeout: 500 }).trim() || null; }
  catch { return null; }
}

export function reduceActivity(previous = {}, event) {
  const state = { phase: 'idle', tools: {}, ...previous, updatedAt: event.receivedAt, lastEvent: event.hook_event_name };
  if (event.workerPid && event.workerIdentity) { state.workerPid = event.workerPid; state.workerIdentity = event.workerIdentity; }
  const call = event.tool_use_id || event.call_id || event.tool_name;
  switch (event.hook_event_name) {
    case 'UserPromptSubmit': state.phase = 'running'; state.tools = {}; state.turnStartedAt = event.receivedAt; delete state.outcome; break;
    case 'PreToolUse':
      state.phase = ['AskUserQuestion', 'AskFollowupQuestion'].includes(event.tool_name) ? 'waiting' : 'tool';
      if (call) state.tools[call] = event.tool_name;
      break;
    case 'PermissionRequest': state.phase = 'waiting'; break;
    case 'Notification': if (event.notification_type === 'permission_prompt') state.phase = 'waiting'; break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (call) delete state.tools[call];
      if (!['ending', 'completed', 'failed', 'cancelled', 'ended'].includes(state.phase)) state.phase = Object.keys(state.tools).length ? 'tool' : 'running';
      if (event.hook_event_name === 'PostToolUseFailure') state.lastToolFailed = true;
      break;
    case 'Stop': if (!['completed', 'failed', 'cancelled'].includes(state.phase)) state.phase = 'ending'; state.tools = {}; break;
    case 'SessionEnd': state.phase = 'ended'; state.reason = event.reason; state.tools = {}; break;
    case 'SubagentStart': state.subagents = (state.subagents || 0) + 1; break;
    case 'SubagentStop': state.subagents = Math.max(0, (state.subagents || 0) - 1); break;
  }
  return state;
}

export function activityView(state, { now = Date.now(), stalledAfterSeconds = 60, identity = processIdentity } = {}) {
  const view = { ...state };
  if (['running', 'tool', 'waiting', 'ending'].includes(state.phase)) {
    if (state.workerPid && identity(state.workerPid) !== state.workerIdentity) view.phase = 'process-exited';
    else if (state.phase !== 'waiting' && now - Date.parse(state.updatedAt) > stalledAfterSeconds * 1000) view.quiet = true;
  }
  return view;
}
