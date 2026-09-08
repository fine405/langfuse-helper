import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { projectRoot, writeConfig } from './settings.mjs';
import { resolveAgent, helperHome, saveJson, readJson } from './profiles.mjs';
import { discoverAgents } from './agents.mjs';

export async function workbuddyCommand(command, args) {
  const id = value => typeof value === 'string' && value.length > 0 && !value.startsWith('-');
  let script, forwarded;
  if (['start', 'stop', 'uninstall'].includes(command) && !args.length) [script, forwarded] = ['setup.mjs', [command]];
  else if (command === 'status' && !args.length) [script, forwarded] = ['setup.mjs', ['status']];
  else if (command === 'status' && args.length === 1 && args[0] === '--json') [script, forwarded] = ['sidecar.mjs', ['status']];
  else if (command === 'serve' && !args.length) [script, forwarded] = ['sidecar.mjs', ['serve']];
  else if (['doctor', 'diagnose'].includes(command) && !args.length) [script, forwarded] = ['cli.mjs', [command === 'doctor' ? 'doctor' : 'status']];
  else if (command === 'verify' && args.length === 1 && id(args[0])) [script, forwarded] = ['verify-langfuse.mjs', args];
  else if (command === 'export' && id(args[0]) && (args.length === 1 || (args.length === 2 && args[1] === '--send'))) [script, forwarded] = ['langfuse.mjs', args];
  else if (command === 'recover' && (!args.length || (args.length === 2 && args[0] === '--retry-confirmed-absent' && id(args[1])))) [script, forwarded] = ['recovery.mjs', args];
  else throw new Error('Invalid arguments. Run langfuse-helper workbuddy --help.');

  const env = { ...process.env };
  const found = discoverAgents().find(agent => agent.id === 'workbuddy');
  if (found.application) env.WORKBUDDY_APP_PATH = found.application;
  if (command !== 'doctor') {
    const activePath = join(helperHome(), 'state/workbuddy/active.json');
    const active = readJson(activePath, null);
    if (['stop', 'status', 'uninstall', 'diagnose'].includes(command) && active && existsSync(active.config)) {
      env.WORKBUDDY_LANGFUSE_CONFIG = active.config;
      env.WORKBUDDY_LANGFUSE_DATA_DIR = active.hooks;
    } else {
      const config = resolveAgent('workbuddy');
      const file = join(config.data_directory, 'runtime.json'), hooks = join(config.data_directory, 'hooks');
      await writeConfig(config, file);
      env.WORKBUDDY_LANGFUSE_CONFIG = file;
      env.WORKBUDDY_LANGFUSE_DATA_DIR = hooks;
      if (command === 'start' || command === 'serve') saveJson(activePath, { config: file, hooks });
    }
    // Profiles select credentials and state. Ambient SDK variables must not retarget a run.
    for (const key of Object.keys(env)) if (/^(WORKBUDDY_)?LANGFUSE_(BASE_URL|PUBLIC_KEY|SECRET_KEY|STATE_DIR)$/.test(key)) delete env[key];
  }
  const result = spawnSync(process.execPath, [join(projectRoot, 'scripts', script), ...forwarded], { stdio: 'inherit', env });
  if (result.error || result.status !== 0) throw new Error(`${command} failed${result.status ? ` (exit ${result.status})` : ''}. See the message above.`);
}
