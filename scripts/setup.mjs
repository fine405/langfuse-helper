import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { root, requireWorkBuddyClosed } from './cli.mjs';
import { readSettings } from './settings.mjs';
import { connectLangfuse } from './recovery.mjs';

const local = join(root, '.local');
function run(script, argument) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', script), argument], { stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${argument} 未完成，请处理上面的提示后重试。`);
}
async function configure() {
  if (!process.stdin.isTTY) throw new Error('请在交互终端运行 npm run configure；也可按 docs/getting-started.md 手工填写 .env。');
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk, encoding); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const secret = async label => {
    process.stdout.write(label); hidden = true;
    try { return (await rl.question('')).trim(); } finally { hidden = false; process.stdout.write('\n'); }
  };
  try {
    console.log('配置只保存到本机 Git 忽略的文件；密钥输入不回显。已有值可按回车保留。');
    const base = (await rl.question(`Langfuse 地址 [${process.env.LANGFUSE_BASE_URL || 'http://localhost:3000'}]：`)).trim();
    const publicKey = await secret('Project Public Key：');
    const secretKey = await secret('Project Secret Key：');
    const settings = await readSettings();
    const content = (await rl.question(`正文模式 metadata/text [${settings.content}]：`)).trim() || settings.content;
    if (!['metadata', 'text'].includes(content)) throw new Error('正文模式只能是 metadata 或 text');
    if (base) process.env.LANGFUSE_BASE_URL = base;
    if (publicKey) process.env.LANGFUSE_PUBLIC_KEY = publicKey;
    if (secretKey) process.env.LANGFUSE_SECRET_KEY = secretKey;
    const config = await connectLangfuse();
    for (const key of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) if (!/^[A-Za-z0-9_-]+$/.test(process.env[key] || '')) throw new Error('密钥格式无效');
    await mkdir(local, { recursive: true, mode: 0o700 });
    const envPath = join(root, '.env');
    await writeFile(envPath, `LANGFUSE_BASE_URL=${config.base}\nLANGFUSE_PUBLIC_KEY=${process.env.LANGFUSE_PUBLIC_KEY}\nLANGFUSE_SECRET_KEY=${process.env.LANGFUSE_SECRET_KEY}\n`, { mode: 0o600 });
    await chmod(envPath, 0o600);
    await writeFile(join(local, 'settings.json'), JSON.stringify({ ...settings, content }, null, 2) + '\n', { mode: 0o600 });
    console.log(`已验证项目“${config.project.name}”，正文模式 ${content}。配置仅在重启服务并通过 npm start 启动的 WorkBuddy 新任务中生效。`);
  } finally { rl.close(); }
}
try {
  switch (process.argv[2]) {
    case 'configure': await configure(); break;
    case 'start':
      requireWorkBuddyClosed();
      run('cli.mjs', 'doctor');
      await connectLangfuse();
      run('cli.mjs', 'plugin:install');
      run('cli.mjs', 'collector:start');
      run('sidecar.mjs', 'stop');
      run('sidecar.mjs', 'start');
      run('cli.mjs', 'launch:phase2');
      console.log('接入完成。新建测试任务，然后运行 npm run service:status 查看 Session 与发送状态。');
      break;
    case 'stop':
      run('sidecar.mjs', 'stop');
      run('cli.mjs', 'collector:stop');
      console.log('接收和上报已停止，历史与待发送数据保留。完全退出 WorkBuddy 并从普通入口重开后，Hook 也恢复默认不采集。');
      break;
    default: throw new Error('Use configure, start or stop');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
