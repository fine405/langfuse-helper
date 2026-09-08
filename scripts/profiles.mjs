import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { defaults, validateConfig } from './settings.mjs';

export const helperHome = () => {
  const directory = process.env.LANGFUSE_HELPER_HOME || join(homedir(), '.langfuse-helper');
  if (!isAbsolute(directory)) throw new Error('LANGFUSE_HELPER_HOME must be an absolute path.');
  return directory;
};
export const profilePath = () => join(helperHome(), 'config.json');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Could not read JSON: ${file}`);
  }
}
export function saveJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
export function readProfiles() {
  const config = readJson(profilePath(), { version: 1, targets: {}, agents: {} });
  if (config?.version !== 1 || !config.targets || !config.agents || Array.isArray(config.targets) || Array.isArray(config.agents)) throw new Error('Invalid helper configuration. Expected version 1, targets and agents.');
  return config;
}
export function resolveAgent(agent, config = readProfiles()) {
  const binding = config.agents[agent];
  const target = binding && config.targets[binding.target];
  if (!target || !target.project_id) throw new Error(`No verified target. Run langfuse-helper ${agent} configure.`);
  const settings = validateConfig({ ...defaults, organization_name: 'Personal', ...binding, ...target });
  const identity = `${settings.base_url}/${target.project_id}`;
  return { ...settings, targetName: binding.target, identity,
    data_directory: join(helperHome(), 'state', agent, digest(identity)) };
}
export function saveAgent(agent, targetName, settings, connected) {
  settings = validateConfig({ ...defaults, ...settings, base_url: connected.base, project_name: connected.project.name });
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(targetName)) throw new Error('Target name must use lowercase English letters, numbers and hyphens (1–64 characters).');
  const config = readProfiles();
  const previous = config.targets[targetName];
  if (previous && `${previous.base_url}/${previous.project_id}` !== connected.target) throw new Error('This target name belongs to a different project. Create a new target name.');
  config.targets[targetName] = { base_url: connected.base, public_key: settings.public_key, secret_key: settings.secret_key,
    project_id: connected.project.id, project_name: connected.project.name,
    organization_name: connected.project.organization?.name || settings.organization_name };
  config.agents[agent] = { target: targetName, enabled: settings.enabled, content: settings.content,
    maxContentChars: settings.maxContentChars, stalledAfterSeconds: settings.stalledAfterSeconds,
    pollIntervalMs: settings.pollIntervalMs, prices: settings.prices };
  saveJson(profilePath(), config);
  return resolveAgent(agent, config);
}
export function setAgentEnabled(agent, enabled) {
  const config = readProfiles();
  if (!config.agents[agent]) return;
  config.agents[agent].enabled = enabled;
  saveJson(profilePath(), config);
}
