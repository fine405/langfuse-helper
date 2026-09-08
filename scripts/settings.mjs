import { readFileSync } from 'node:fs';
import { writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const workbuddyHome = process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy');
export const configPath = process.env.WORKBUDDY_LANGFUSE_CONFIG || join(workbuddyHome, 'langfuse.json');
export const pluginHome = join(workbuddyHome, 'langfuse-plugin');
export const defaults = { content: 'metadata', maxContentChars: 16000, stalledAfterSeconds: 60, pollIntervalMs: 1000, prices: {} };

function readObject(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`配置文件无法读取或 JSON 格式错误：${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`配置必须是 JSON 对象：${path}`);
  return value;
}

export function validateSettings(settings) {
  if (!['metadata', 'text'].includes(settings.content)) throw new Error('content must be metadata or text');
  if (!Number.isInteger(settings.maxContentChars) || settings.maxContentChars < 100 || settings.maxContentChars > 64000) throw new Error('maxContentChars must be 100–64000');
  if (!Number.isInteger(settings.stalledAfterSeconds) || settings.stalledAfterSeconds < 5) throw new Error('stalledAfterSeconds must be at least 5');
  if (!Number.isInteger(settings.pollIntervalMs) || settings.pollIntervalMs < 500) throw new Error('pollIntervalMs must be at least 500');
  if (!settings.prices || typeof settings.prices !== 'object' || Array.isArray(settings.prices)) throw new Error('prices must be an object');
  return settings;
}

export function validateConfig(config) {
  validateSettings(config);
  if (typeof config.enabled !== 'boolean') throw new Error('enabled 必须为 true 或 false');
  let url;
  try { url = new URL(config.base_url); } catch { throw new Error('Langfuse 地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('请填写 Langfuse 基础地址，不包含 /api、项目路径、用户名或密码');
  }
  for (const key of ['public_key', 'secret_key']) {
    if (typeof config[key] !== 'string' || (config[key] && !/^[A-Za-z0-9_-]+$/.test(config[key]))) throw new Error(`${key} 格式无效`);
  }
  for (const key of ['organization_name', 'project_name']) {
    if (typeof config[key] !== 'string' || !config[key].trim() || /[\x00-\x1f\x7f]/.test(config[key])) throw new Error(`${key} 必须是非空名称`);
  }
  if (config.data_directory && (typeof config.data_directory !== 'string' || !isAbsolute(config.data_directory))) throw new Error('data_directory 必须为绝对路径');
  return { ...config, base_url: url.origin };
}

export function readConfig({ file = configPath, env = process.env } = {}) {
  const saved = readObject(file);
  const config = { ...defaults, enabled: false, base_url: 'http://localhost:3000', public_key: '', secret_key: '',
    organization_name: 'Personal', project_name: 'WorkBuddy', ...saved };
  for (const prefix of ['LANGFUSE_', 'WORKBUDDY_LANGFUSE_']) {
    const publicKey = env[`${prefix}PUBLIC_KEY`], secretKey = env[`${prefix}SECRET_KEY`];
    if ((publicKey !== undefined) !== (secretKey !== undefined)) throw new Error(`${prefix}PUBLIC_KEY 和 SECRET_KEY 必须成对设置`);
    if (publicKey !== undefined) {
      config.public_key = publicKey; config.secret_key = secretKey;
    }
    if (env[`${prefix}BASE_URL`]) config.base_url = env[`${prefix}BASE_URL`];
  }
  return validateConfig(config);
}

export function stateDirectory(config = readConfig()) {
  return process.env.WORKBUDDY_LANGFUSE_STATE_DIR || config.data_directory || join(pluginHome, 'state');
}

export async function writeConfig(config, file = configPath) {
  const saved = validateConfig(config), temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return saved;
}
