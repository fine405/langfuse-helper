import { spawnSync, spawn } from 'node:child_process';
import { mkdir, access, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { demoPayload, readJsonLines, spansFrom, summarize } from './data.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const app = process.env.WORKBUDDY_APP_PATH || '/Applications/WorkBuddy.app';
export const dataDir = process.env.WORKBUDDY_LANGFUSE_DATA_DIR || join(homedir(), '.workbuddy', 'langfuse-plugin');
const executable = join(app, 'Contents/MacOS/Electron');
const configDir = process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy');
export const composeFile = join(root, 'collector/compose.yaml');
export const port = Number(process.env.WB_LF_PORT || 14318);

export function compose(args, extraEnv = {}) {
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: root, stdio: 'inherit', env: { ...process.env,
      WB_LF_UID: String(process.getuid?.() ?? 1000), WB_LF_GID: String(process.getgid?.() ?? 1000), ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Collector command failed (${result.status})`);
}

export async function prepare() {
  await mkdir(join(root, '.local/collector'), { recursive: true, mode: 0o700 });
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function waitForCollector() {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, { signal: AbortSignal.timeout(500) });
      if (response.status === 405) return;
    } catch {}
    await delay(200);
  }
  throw new Error('Collector 尚未就绪，请检查 Docker 日志后重试。');
}

export async function sendDemo(targetPort = port) {
  const payload = demoPayload();
  const response = await fetch(`http://127.0.0.1:${targetPort}/v1/traces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload.body), signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok || Number(result.partialSuccess?.rejectedSpans || 0) > 0) throw new Error('Collector rejected demo spans');
  return payload;
}

async function main(command) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('WB_LF_PORT must be 1024–65535');
  switch (command) {
    case 'doctor': {
      const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 5000 });
      const version = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' });
      const checks = { node: process.version, nodeSupported: Number(process.versions.node.split('.')[0]) >= 22,
        workbuddyFound: await exists(executable), workbuddyVersion: version.status === 0 ? version.stdout.trim() : null,
        configDirectoryExists: await exists(configDir), dockerReady: docker.status === 0,
        collectorEndpoint: `http://127.0.0.1:${port}/v1/traces`, hookDataDirectory: dataDir,
        phase: '1: local metadata preview; no Langfuse exporter' };
      console.log(JSON.stringify(checks, null, 2));
      if (!checks.nodeSupported || !checks.workbuddyFound || !checks.dockerReady) process.exitCode = 1;
      break;
    }
    case 'collector:start': await prepare(); compose(['up', '-d']); await waitForCollector(); console.log('本地 Collector 已就绪。'); break;
    case 'collector:stop': compose(['down']); break;
    case 'demo': console.log(JSON.stringify({ syntheticTraceId: (await sendDemo()).traceId, note: '模拟数据；请稍后运行 npm run status。未上传 Langfuse。' }, null, 2)); break;
    case 'status': {
      const spans = spansFrom(await readJsonLines(join(root, '.local/collector/traces.jsonl')));
      const synthetic = spans.filter(span => span.attributes['workbuddy.langfuse.source'] === 'synthetic');
      const native = spans.filter(span => span.attributes['workbuddy.langfuse.source'] !== 'synthetic');
      const hooks = await readJsonLines(join(dataDir, 'hooks.jsonl'));
      const hookCounts = {};
      for (const hook of hooks.filter(hook => hook.source !== 'synthetic')) hookCounts[hook.hook_event_name] = (hookCounts[hook.hook_event_name] || 0) + 1;
      console.log(JSON.stringify({ native: summarize(native), synthetic: summarize(synthetic), hooks: hookCounts,
        note: '诊断统计保留重复记录用于发现问题；不是去重上报器。usage 缺失表示未知。' }, null, 2));
      break;
    }
    case 'launch': {
      const processes = spawnSync('ps', ['-axo', 'comm='], { encoding: 'utf8' });
      if (processes.status !== 0) throw new Error('无法确认 WorkBuddy 是否已退出。');
      if (processes.stdout.split('\n').some(line => line.trim() === executable)) throw new Error('请先完全退出 WorkBuddy，再运行此命令；不会中断现有任务。');
      await prepare();
      const env = { ...process.env, CODEBUDDY_CODE_ENABLE_TELEMETRY: '1', OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`, OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf',
        OTEL_SERVICE_NAME: 'workbuddy', OTEL_SEMCONV: 'codebuddy',
        OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_RAW_API_BODIES: '0',
        WORKBUDDY_LANGFUSE_DATA_DIR: dataDir,
        CODEBUDDY_PLUGIN_DIRS: [join(root, 'plugins/workbuddy-langfuse'), process.env.CODEBUDDY_PLUGIN_DIRS].filter(Boolean).join(delimiter),
        PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.OTEL_EXPORTER_OTLP_HEADERS;
      delete env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
      if (env.DISABLE_TELEMETRY || env.OTEL_SDK_DISABLED === 'true') throw new Error('当前环境已禁用遥测，请先检查 DISABLE_TELEMETRY / OTEL_SDK_DISABLED。');
      const log = await open(join(root, '.local/workbuddy-startup.log'), 'a', 0o600);
      const child = spawn(executable, [], { detached: true, stdio: ['ignore', log.fd, log.fd], env });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref(); await log.close();
      console.log('WorkBuddy 已通过本次诊断环境启动。新建无敏感信息的测试任务，然后运行 npm run status。');
      break;
    }
    default: throw new Error('Unknown command. Use an npm script listed in README.md.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
