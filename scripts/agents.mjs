import { existsSync, accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

export const extensions = {
  workbuddy: { name: 'WorkBuddy', commands: ['configure', 'start', 'status', 'stop', 'doctor', 'diagnose', 'uninstall'] },
  codex: { name: 'Codex', commands: ['configure', 'install', 'start', 'status', 'stop', 'doctor', 'recover', 'uninstall'] },
};
function executable(file) { try { accessSync(file, constants.X_OK); return file; } catch { return null; } }
export function discoverAgents({ env = process.env, home = homedir(), exists = existsSync, findExecutable = executable } = {}) {
  const cli = name => (env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, name)).find(file => findExecutable(file)) || null;
  return [
    { id: 'workbuddy', name: 'WorkBuddy', application: env.WORKBUDDY_APP_PATH || '/Applications/WorkBuddy.app', cli: cli('workbuddy') },
    { id: 'codex', name: 'Codex', application: env.CODEX_APP_PATH || '/Applications/Codex.app', cli: env.LANGFUSE_HELPER_CODEX_BIN ? findExecutable(env.LANGFUSE_HELPER_CODEX_BIN) : cli('codex') },
    { id: 'claude', name: 'Claude Code', application: null, cli: cli('claude') },
  ].map(agent => {
    if (agent.application && !exists(agent.application)) {
      const userApp = join(home, 'Applications', `${agent.name}.app`);
      agent.application = exists(userApp) ? userApp : null;
    }
    if (agent.id === 'codex' && !agent.cli && agent.application) agent.cli = findExecutable(join(agent.application, 'Contents/Resources/codex')) || null;
    const supported = !!extensions[agent.id], detected = !!(agent.application || agent.cli);
    const runnable = agent.id === 'workbuddy' ? !!agent.application : agent.id === 'codex' && !!agent.cli;
    return { ...agent, detected, supported, runnable: !!runnable,
      commands: supported ? extensions[agent.id].commands : [] };
  });
}
