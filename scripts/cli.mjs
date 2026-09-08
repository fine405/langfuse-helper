import { isMain } from './entry.mjs';
import { spawnSync, spawn } from 'node:child_process';
import { mkdir, access, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { demoPayload, readJsonLines, spansFrom, summarize } from './data.mjs';
import { withEngine, installPlugin, pluginId } from './engine.mjs';
import { readPreview } from './preview.mjs';
import { readConfig, stateDirectory, projectRoot, workbuddyHome } from './settings.mjs';

export const local = stateDirectory();
export const root = projectRoot;
export const configDir = workbuddyHome;
export const app = process.env.WORKBUDDY_APP_PATH || '/Applications/WorkBuddy.app';
export const dataDir = process.env.WORKBUDDY_LANGFUSE_DATA_DIR || join(configDir, 'langfuse-plugin');
const executable = join(app, 'Contents/MacOS/Electron');
export const composeFile = join(root, 'collector/compose.yaml');
export const port = Number(process.env.WB_LF_PORT || 14318);

export function compose(args, extraEnv = {}) {
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: root, stdio: 'inherit', env: { ...process.env,
      WB_LF_COLLECTOR_DATA: join(local, 'collector'),
      WB_LF_UID: String(process.getuid?.() ?? 1000), WB_LF_GID: String(process.getgid?.() ?? 1000), ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Collector command failed (${result.status})`);
}

export async function prepare() {
  await mkdir(join(local, 'collector'), { recursive: true, mode: 0o700 });
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }

export function requireWorkBuddyClosed() {
  const processes = spawnSync('ps', ['-axo', 'comm='], { encoding: 'utf8' });
  if (processes.status !== 0) throw new Error('Could not determine whether WorkBuddy has exited.');
  if (processes.stdout.split('\n').some(line => line.trim() === executable)) throw new Error('Quit WorkBuddy completely before running this command. Existing tasks will not be interrupted.');
}

async function waitForCollector() {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, { signal: AbortSignal.timeout(500) });
      if (response.status === 405) return;
    } catch {}
    await delay(200);
  }
  throw new Error('Collector is not ready. Check Docker logs and retry.');
}

export async function sendDemo(targetPort = port, payload = demoPayload()) {
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
      const checks = { node: process.version, nodeSupported: Number(process.versions.node.split('.')[0]) >= 24,
        workbuddyFound: await exists(executable), workbuddyVersion: version.status === 0 ? version.stdout.trim() : null,
        configDirectoryExists: await exists(configDir), dockerReady: docker.status === 0,
        collectorEndpoint: `http://127.0.0.1:${port}/v1/traces`, hookDataDirectory: dataDir,
        phase: '3: native tracing, optional transcript enrichment, durable automatic delivery' };
      console.log(JSON.stringify(checks, null, 2));
      if (!checks.nodeSupported || !checks.workbuddyFound || !checks.dockerReady) process.exitCode = 1;
      break;
    }
    case 'collector:start': await prepare(); compose(['up', '-d', '--force-recreate']); await waitForCollector(); console.log('Local Collector and session correlator are ready.'); break;
    case 'collector:stop': compose(['down']); break;
    case 'plugin:install':
    case 'plugin:uninstall': {
      requireWorkBuddyClosed();
      await withEngine({ app, configDir, cwd: root }, async request => {
        if (command === 'plugin:install') await installPlugin(request, root);
        else await request('/plugins/uninstall', { plugin: pluginId });
      });
      console.log(command === 'plugin:install' ? 'Plugin installed or updated and verified. Run langfuse-helper workbuddy start to enable capture.' : 'WorkBuddy plugin removed.');
      break;
    }
    case 'demo': console.log(JSON.stringify({ syntheticTraceId: (await sendDemo()).traceId, note: 'Synthetic data. Run langfuse-helper workbuddy diagnose to inspect it. Nothing was uploaded to Langfuse.' }, null, 2)); break;
    case 'preview:export': {
      const preview = await readPreview(join(local, 'collector'));
      for (const batch of preview.batches) console.log(JSON.stringify(batch));
      break;
    }
    case 'status': {
      const preview = await readPreview(join(local, 'collector'));
      const spans = spansFrom(preview.batches);
      const synthetic = spans.filter(span => span.attributes['workbuddy.langfuse.source'] === 'synthetic');
      const native = spans.filter(span => span.attributes['workbuddy.langfuse.source'] !== 'synthetic');
      const hooks = await readJsonLines(join(dataDir, 'hooks.jsonl'));
      const hookCounts = {};
      for (const hook of hooks.filter(hook => hook.source !== 'synthetic')) hookCounts[hook.hook_event_name] = (hookCounts[hook.hook_event_name] || 0) + 1;
      console.log(JSON.stringify({ storage: preview.storage, correlation: preview.states, native: summarize(native), synthetic: summarize(synthetic), hooks: hookCounts,
        note: 'Diagnostics retain duplicate arrivals for inspection. These are not delivery counts. Missing usage is unknown.' }, null, 2));
      break;
    }
    case 'launch': {
      requireWorkBuddyClosed();
      await prepare();
      const settings = readConfig();
      if (!settings.enabled) throw new Error('Capture is disabled. Run langfuse-helper workbuddy configure to enable it.');
      const env = { ...process.env, CODEBUDDY_CODE_ENABLE_TELEMETRY: '1', OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`, OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf',
        OTEL_SERVICE_NAME: 'workbuddy', OTEL_SEMCONV: 'agentlens',
        OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_RAW_API_BODIES: '0',
        WORKBUDDY_LANGFUSE_DATA_DIR: dataDir, WORKBUDDY_LANGFUSE_ENABLED: '1',
        WORKBUDDY_LANGFUSE_CONTENT: settings.content,
        PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.OTEL_EXPORTER_OTLP_HEADERS;
      delete env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
      delete env.LANGFUSE_PUBLIC_KEY;
      delete env.LANGFUSE_SECRET_KEY;
      delete env.WORKBUDDY_LANGFUSE_PUBLIC_KEY;
      delete env.WORKBUDDY_LANGFUSE_SECRET_KEY;
      if (env.DISABLE_TELEMETRY || env.OTEL_SDK_DISABLED === 'true') throw new Error('Telemetry is disabled in this environment. Check DISABLE_TELEMETRY / OTEL_SDK_DISABLED.');
      const log = await open(join(local, 'workbuddy-startup.log'), 'a', 0o600);
      const child = spawn(executable, [], { detached: true, stdio: ['ignore', log.fd, log.fd], env });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref(); await log.close();
      console.log('WorkBuddy started with capture enabled. Create a new task, then run langfuse-helper workbuddy status.');
      break;
    }
    default: throw new Error('Unknown command. Use an npm script listed in README.md.');
  }
}

if (isMain(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
