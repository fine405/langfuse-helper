import { cp, mkdir, writeFile, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { projectRoot, workbuddyHome, configPath, readConfig, writeConfig } from './settings.mjs';
import { requireWorkBuddyClosed } from './cli.mjs';
import { isMain } from './entry.mjs';

export const releaseFiles = ['scripts', 'collector', 'plugins', '.codebuddy-plugin', 'package.json', 'README.md', 'docs', 'test', '安装.command'];
const managed = '# Managed by workbuddy-langfuse';
const actions = { '启动 WorkBuddy': 'start', '配置 Langfuse': 'configure', '查看状态': 'status', '停止采集': 'stop', '更新插件': 'update', '卸载插件': 'uninstall' };
const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function installationPaths(home = homedir(), workbuddy = workbuddyHome, file = configPath) {
  const base = join(workbuddy, 'langfuse-plugin');
  return { base, app: join(base, 'app'), state: join(base, 'state'), marker: join(base, 'installation.json'),
    config: file, workbuddy, bin: join(home, '.local/bin/workbuddy-langfuse'), launchers: join(home, 'Applications/WorkBuddy Langfuse') };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function requireStopped(directory) {
  if (existsSync(join(directory, 'service.json'))) {
    const runtime = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'));
    if (alive(runtime.pid)) throw new Error('上报服务仍在运行。请先完全退出 WorkBuddy，并停止采集，再安装或更新。');
  }
  if (existsSync(join(directory, 'collector'))) {
    const result = spawnSync('docker', ['ps', '--filter', 'label=com.docker.compose.project=workbuddy-langfuse-preview', '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) throw new Error('请启动 Docker Desktop，并通过停止入口停止 Collector 后重试。');
    if (result.stdout.trim()) throw new Error('Collector 仍在运行。请先通过停止入口停止采集后重试。');
  }
}

async function checkManaged(path) {
  try {
    const text = await readFile(path, 'utf8');
    if (!text.includes(managed)) throw new Error(`该位置已有其他文件，安装不会覆盖：${path}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function writeExecutable(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, text, { mode: 0o700, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function assertSeparateState(paths, state) {
  if (resolve(state) === resolve(paths.app) || resolve(state).startsWith(resolve(paths.app) + sep)) {
    throw new Error('运行数据必须放在程序安装目录之外，避免更新时替换数据。');
  }
}

export async function install({ source = projectRoot, paths = installationPaths(), node = process.execPath } = {}) {
  const config = readConfig({ file: paths.config, env: {} });
  const state = config.data_directory || paths.state;
  assertSeparateState(paths, state);
  await requireStopped(state);
  const wrapperPaths = [paths.bin, ...Object.keys(actions).map(name => join(paths.launchers, `${name}.command`))];
  for (const path of wrapperPaths) await checkManaged(path);
  if (existsSync(paths.app) && !existsSync(paths.marker)) throw new Error(`安装目录已存在但不属于本安装器：${paths.app}`);
  if (resolve(source) === resolve(paths.app)) throw new Error('请从新下载并解压的安装包运行安装器。');
  await mkdir(paths.base, { recursive: true, mode: 0o700 });
  const lock = join(paths.base, 'install.lock');
  try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (alive(Number(await readFile(lock, 'utf8')))) throw new Error('另一个安装器正在运行，请等待完成。');
    await rm(lock); await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  const stage = join(paths.base, `app-${randomUUID()}`), backup = join(paths.base, `backup-${randomUUID()}`);
  let backedUp = false, installed = false;
  try {
    await mkdir(stage);
    for (const file of releaseFiles) await cp(join(source, file), join(stage, file), { recursive: true });
    const version = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8')).version;
    if (existsSync(paths.app)) { await rename(paths.app, backup); backedUp = true; }
    await rename(stage, paths.app); installed = true;
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeConfig({ ...config, data_directory: state }, paths.config);
    const environment = `unset LANGFUSE_BASE_URL LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY WORKBUDDY_LANGFUSE_BASE_URL WORKBUDDY_LANGFUSE_PUBLIC_KEY WORKBUDDY_LANGFUSE_SECRET_KEY WORKBUDDY_LANGFUSE_STATE_DIR\nexport WORKBUDDY_CONFIG_DIR=${quote(paths.workbuddy)}\nexport CODEBUDDY_CONFIG_DIR=${quote(paths.workbuddy)}\nexport WORKBUDDY_LANGFUSE_CONFIG=${quote(paths.config)}\nexport PATH=${quote(dirname(node) + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}\n`;
    await writeExecutable(paths.bin, `#!/bin/sh\n${managed}\n${environment}exec ${quote(node)} ${quote(join(paths.app, 'scripts/setup.mjs'))} "$@"\n`);
    for (const [name, command] of Object.entries(actions)) {
      await writeExecutable(join(paths.launchers, `${name}.command`), `#!/bin/sh\n${managed}\n${quote(paths.bin)} ${quote(command)}\nresult=$?\nprintf '\\n按回车关闭窗口…'\nread -r answer\nexit "$result"\n`);
    }
    await writeFile(paths.marker, JSON.stringify({ name: 'workbuddy-langfuse', version, installedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    await rm(backup, { recursive: true, force: true }); backedUp = false;
    return { version, config: paths.config, state, launchers: paths.launchers, command: paths.bin };
  } catch (error) {
    if (installed) await rm(paths.app, { recursive: true, force: true });
    if (backedUp) { await rename(backup, paths.app); backedUp = false; }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { force: true });
  }
}

export async function uninstallFiles(paths = installationPaths()) {
  if (!existsSync(paths.marker)) throw new Error('未找到本安装器的安装记录；源码目录不会被删除。');
  const marker = JSON.parse(await readFile(paths.marker, 'utf8'));
  if (marker.name !== 'workbuddy-langfuse') throw new Error('安装记录不匹配。');
  const state = readConfig({ file: paths.config, env: {} }).data_directory || paths.state;
  assertSeparateState(paths, state);
  await requireStopped(state);
  for (const path of [paths.bin, ...Object.keys(actions).map(name => join(paths.launchers, `${name}.command`))]) {
    await checkManaged(path); await rm(path, { force: true });
  }
  await rm(paths.app, { recursive: true });
  await rm(paths.marker);
  try { await rmdir(paths.launchers); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('当前安装器仅支持 macOS。');
  requireWorkBuddyClosed();
  if (process.argv[2] === 'uninstall') {
    await uninstallFiles();
    console.log('安装文件和启动入口已卸载；配置、队列和历史保留。');
    return;
  }
  const result = await install();
  console.log(`WorkBuddy Langfuse ${result.version} 安装完成。\n启动与配置入口：${result.launchers}\n配置文件：${result.config}\n命令行入口：${result.command}\n请双击“配置 Langfuse.command”完成接入；日常使用双击“启动 WorkBuddy.command”。`);
  spawnSync('open', [result.launchers], { stdio: 'ignore' });
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
