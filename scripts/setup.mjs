import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, local, app, requireWorkBuddyClosed } from './cli.mjs';
import { readConfig, writeConfig, configPath, stateDirectory } from './settings.mjs';
import { connectLangfuse } from './recovery.mjs';
import { runtimeRequest } from './sidecar.mjs';
import { collectConfig } from './wizard.mjs';
import { isMain } from './entry.mjs';

function run(script, argument) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', script), argument], { stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error(`${argument} 未完成，请处理上面的提示后重试。`);
}

export function assertSameTarget(directory, target) {
  for (const [name, sql] of [
    ['sidecar.sqlite', "SELECT value AS target FROM cursors WHERE name = 'target'"],
    ['langfuse-deliveries.sqlite', 'SELECT DISTINCT target FROM deliveries'],
  ]) {
    if (!existsSync(join(directory, name))) continue;
    const db = new DatabaseSync(join(directory, name), { readOnly: true });
    try {
      const targets = db.prepare(sql).all().map(row => name === 'sidecar.sqlite' ? JSON.parse(row.target) : row.target);
      if (targets.some(previous => previous !== target)) throw new Error('现有发送账本属于另一个 Langfuse 项目，配置未保存。请为新项目使用独立的数据目录，保留原账本。');
    } finally { db.close(); }
  }
}

export async function verifyAndSave(config, { file = configPath, directory = stateDirectory(config), onVerified = () => {} } = {}) {
  const previous = readConfig({ file, env: {} });
  if (!config.enabled && ['base_url', 'public_key', 'secret_key'].every(key => config[key] === previous[key])) {
    return writeConfig({ ...config, data_directory: directory }, file);
  }
  const connected = await connectLangfuse(config);
  assertSameTarget(directory, connected.target);
  onVerified(connected);
  return writeConfig({ ...config, base_url: connected.base, project_name: connected.project.name,
    project_id: connected.project.id, data_directory: directory }, file);
}

export async function configure() {
  if (!process.stdin.isTTY) throw new Error(`请在交互终端打开配置向导，也可按接入指南编辑 ${configPath}`);
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk, encoding); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  rl.on('SIGINT', () => { rl.close(); });
  const ask = label => rl.question(label);
  const secret = async label => {
    process.stdout.write(label); hidden = true;
    try { return await ask(''); } finally { hidden = false; process.stdout.write('\n'); }
  };
  try {
    const current = readConfig();
    if (Object.keys(process.env).some(key => /^(WORKBUDDY_)?LANGFUSE_(BASE_URL|PUBLIC_KEY|SECRET_KEY)$/.test(key))) {
      console.log('当前终端存在 Langfuse 环境变量，它们会优先于配置文件。修改后请清除旧的覆盖值，或通过安装后的启动入口运行。');
    }
    const config = await collectConfig(current, { ask, secret, log: console.log, openBrowser: async url => {
      const result = spawnSync('open', [url], { stdio: 'ignore' });
      if (result.error || result.status !== 0) console.log(`请手动在浏览器中打开 ${url}`);
    } });
    console.log('正在检查配置……');
    const saved = await verifyAndSave(config, { onVerified: connected => console.log(`已验证：${connected.base} → 项目“${connected.project.name}”`) });
    console.log(`配置已保存：${configPath}\n连接地址：${saved.base_url}\n实际项目：${saved.project_name}\n采集：${saved.enabled ? '启用' : '关闭'}；正文：${saved.content}`);
    console.log('配置将在重新启动接入后生效；正文模式对新任务生效。发送账本已保留。');
    if (!saved.enabled) {
      const answer = (await ask('现在停止采集与上报？[Y/n]：')).trim().toLowerCase();
      if (!answer || ['y', 'yes'].includes(answer)) await stop();
      else console.log('关闭设置已保存；正在运行的进程需要通过“停止采集.command”停止。');
      return saved;
    }
    try { requireWorkBuddyClosed(); }
    catch { console.log('请完全退出 WorkBuddy，然后双击“启动 WorkBuddy.command”使设置生效。'); return saved; }
    if (['y', 'yes'].includes((await ask('现在启动 WorkBuddy 并启用采集？[y/N]：')).trim().toLowerCase())) await start();
    return saved;
  } finally { rl.close(); }
}

async function ensureDocker() {
  const ready = () => spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 2000 }).status === 0;
  if (ready()) return;
  const opened = spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
  if (opened.error || opened.status !== 0) throw new Error('需要 Docker Desktop。请从 https://www.docker.com/products/docker-desktop/ 安装并启动后重试。');
  console.log('正在启动 Docker Desktop……');
  for (let i = 0; i < 30; i++) { await delay(1000); if (ready()) return; }
  throw new Error('Docker Desktop 还未就绪。请完成首次启动提示，再重新打开启动入口。');
}

export async function assertServiceAvailable(port = Number(process.env.WB_LF_SERVICE_PORT || 14319), directory = local) {
  try {
    const response = await runtimeRequest('/status', directory);
    if (response.ok && Number(new URL(response.url).port) === port) return;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.cause?.code !== 'ECONNREFUSED') throw error;
  }
  try {
    await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return;
    throw new Error('无法确认上报端口是否空闲，请检查其他接入进程。');
  }
  throw new Error('该端口已有另一处接入服务，请先从对应安装的停止入口停止，再启动此安装。');
}

async function start() {
  requireWorkBuddyClosed();
  const config = readConfig();
  if (!config.public_key || !config.secret_key) { await configure(); return; }
  if (!config.enabled) throw new Error('采集已关闭。请打开“配置 Langfuse.command”启用后再启动。');
  const connected = await connectLangfuse(config);
  assertSameTarget(local, connected.target);
  await assertServiceAvailable();
  await ensureDocker();
  if (!existsSync(join(app, 'Contents/MacOS/Electron'))) throw new Error('未找到 WorkBuddy，请先安装 WorkBuddy 桌面应用后重试。');
  run('cli.mjs', 'plugin:install');
  run('sidecar.mjs', 'stop');
  run('cli.mjs', 'collector:start');
  run('sidecar.mjs', 'start');
  run('cli.mjs', 'launch');
  console.log(`接入已启动，任务将发送到 ${connected.project.name}。可打开“查看状态.command”检查进度。`);
}

async function stop() {
  run('sidecar.mjs', 'stop');
  if (existsSync(join(local, 'collector'))) { await ensureDocker(); run('cli.mjs', 'collector:stop'); }
  console.log('采集与上报已停止，配置、发送账本和历史保留。完全退出 WorkBuddy 后可从普通入口重新打开。');
}

async function status() {
  const config = readConfig();
  console.log(`配置文件：${configPath}\n运行数据：${local}\n配置开关：${config.enabled ? '启用' : '关闭'}\n正文模式：${config.content}\n连接地址：${config.base_url}`);
  try {
    const connected = await connectLangfuse(config);
    console.log(`Langfuse 连接正常；实际项目：${connected.project.name}`);
  } catch (error) { console.log(`Langfuse 连接未就绪：${error.message}`); }
  try {
    const response = await runtimeRequest('/status');
    if (!response.ok) throw new Error('状态接口认证失败');
    const service = await response.json();
    if (service.starting) { console.log('上报服务正在启动。'); return; }
    console.log(`上报服务：运行中\n待发送：${service.queue} 条\n已登记任务：${service.sessions.length} 个`);
    if (service.target) console.log(`运行中的发送目标：${service.target.base} / ${service.target.project}`);
    for (const fault of service.faults) console.log(`需要处理：${fault.message}`);
    if (!service.faults.length) console.log('当前没有上报异常。');
    const phases = { running: '执行中', tool: '执行工具', waiting: '等待输入或审批', ending: '收尾中', completed: '已完成', failed: '失败', cancelled: '已取消', ended: '已结束', 'process-exited': '进程已退出' };
    for (const session of service.sessions.toSorted((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)).slice(0, 5)) console.log(`任务 ${session.sessionId}：${phases[session.phase] || session.phase}${session.quiet ? '（暂时没有新活动）' : ''}`);
  } catch (error) {
    if (error.code === 'ENOENT' || error.cause?.code === 'ECONNREFUSED') console.log('上报服务：未运行。需要采集时请打开启动入口。');
    else throw error;
  }
}

async function main() {
  switch (process.argv[2] || 'help') {
    case 'configure': return configure();
    case 'start': return start();
    case 'stop': return stop();
    case 'status': return status();
    case 'uninstall':
      requireWorkBuddyClosed();
      await stop();
      run('cli.mjs', 'plugin:uninstall');
      run('install.mjs', 'uninstall');
      return;
    case 'update':
      console.log('下载新版本安装包，再次运行“安装.command”即可更新；配置和发送记录保留。');
      spawnSync('open', ['https://github.com/fine405/workbuddy-langfuse-plugin/releases'], { stdio: 'ignore' });
      return;
    case 'help':
    case '--help':
      console.log('WorkBuddy Langfuse\n用法：workbuddy-langfuse <命令>\n  configure  配置连接、组织/项目与正文模式\n  start      启动采集并打开 WorkBuddy\n  status     查看连接和上报状态\n  stop       停止采集与上报\n  update     获取新版安装包\n  uninstall  卸载插件与启动入口，保留用户数据');
      return;
    default: throw new Error('未知操作，请运行 workbuddy-langfuse --help。');
  }
}

if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
