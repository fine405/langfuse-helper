import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, delimiter } from 'node:path';
import { discoverAgents } from './agents.mjs';
import { projectRoot } from './settings.mjs';
import { resolveAgent, setAgentEnabled, readJson } from './profiles.mjs';
import { DeliveryLedger, connectLangfuse, reconcileDeliveries } from './delivery.mjs';

const plugin = 'codex-langfuse';
const marketplace = JSON.parse(readFileSync(join(projectRoot, '.agents/plugins/marketplace.json'), 'utf8')).name;
const pluginId = `${plugin}@${marketplace}`;
function codex() {
  const agent = discoverAgents().find(agent => agent.id === 'codex');
  if (!agent.cli) throw new Error('Codex executable was not found. Install Codex or set LANGFUSE_HELPER_CODEX_BIN.');
  return agent;
}
function invoke(args, { json = true, inherit = false } = {}) {
  const result = spawnSync(codex().cli, args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', timeout: inherit ? undefined : 30000,
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` } });
  if (result.error || result.status !== 0) throw new Error(`Codex command failed: ${args.join(' ')}. ${result.stderr?.trim() || result.error?.message || ''}`);
  return json ? JSON.parse(result.stdout) : result.stdout;
}
export function installCodexPlugin() {
  const installed = invoke(['plugin', 'list', '--json']).installed;
  if (installed.some(item => item.enabled !== false && item.pluginId === 'tracing@codex-observability-plugin')) {
    throw new Error('The upstream Langfuse tracing plugin is enabled. Disable it in Codex Plugins before installing this extension to avoid two exporters.');
  }
  const markets = invoke(['plugin', 'marketplace', 'list', '--json']).marketplaces;
  const existing = markets.find(item => item.name === marketplace);
  if (existing && resolve(existing.root) !== resolve(projectRoot)) throw new Error(`Marketplace ${marketplace} points to another directory. Remove that registration with Codex before installing from this helper location.`);
  invoke(['plugin', 'marketplace', 'add', projectRoot, '--json']);
  const added = invoke(['plugin', 'add', pluginId, '--json']);
  invoke(['features', 'enable', 'hooks'], { json: false });
  console.log(`Installed ${added.pluginId}. In a new Codex task, open /hooks and review/trust this plugin's Stop hook. Installation does not grant hook trust.`);
  return added;
}

export async function codexCommand(command, args) {
  if (['export'].includes(command)) {
    if (!args[0] || args[0].startsWith('-') || args.length > 2 || (args[1] && args[1] !== '--send')) throw new Error('Usage: langfuse-helper codex export <rollout-path> [--send]');
    const result = spawnSync(process.execPath, [join(projectRoot, 'plugins/codex-langfuse/runtime/hook.mjs'), '--report', ...(args[1] ? [] : ['--preview'])], {
      input: JSON.stringify({ transcript_path: resolve(args[0]) }), encoding: 'utf8', timeout: 30000,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.error || result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || 'Export failed.');
    return;
  }
  const allowed = (command === 'start' && args.length === 1 && args[0] === '--app') || (command === 'status' && args.length === 1 && args[0] === '--json') ||
    (command === 'recover' && args.length === 2 && args[0] === '--retry-confirmed-absent' && /^[a-f0-9]{32}:[a-f0-9]{16}$/.test(args[1]));
  if (args.length && !allowed) throw new Error('Invalid arguments. Run langfuse-helper codex --help.');
  switch (command) {
    case 'install': return installCodexPlugin();
    case 'doctor': {
      const agent = codex();
      console.log(JSON.stringify({ node: process.version, executable: agent.cli, application: agent.application,
        version: invoke(['--version'], { json: false }).trim(), plugins: invoke(['plugin', 'list', '--json']).installed,
        hookReview: 'Review the Stop hook in /hooks in a new Codex task.' }, null, 2)); return;
    }
    case 'start': {
      const config = resolveAgent('codex');
      const connected = await connectLangfuse(config);
      if (connected.target !== config.identity) throw new Error('Target project differs from the saved project. Run configure.');
      if (args[0] === '--app' && !codex().application) throw new Error('Codex desktop application was not found.');
      installCodexPlugin();
      setAgentEnabled('codex', true);
      console.log('Capture enabled. Create a new task and review /hooks. Use langfuse-helper codex status after a completed turn.');
      // No credentials are passed to the launched agent; the cached hook resolves its target.
      invoke(args[0] === '--app' ? ['app'] : ['--enable', 'hooks'], { json: false, inherit: true });
      return;
    }
    case 'stop':
      setAgentEnabled('codex', false);
      console.log('Codex capture disabled for future hook invocations. A delivery already in progress may finish. Codex stays open; configuration and history are retained.'); return;
    case 'uninstall':
      setAgentEnabled('codex', false);
      if (invoke(['plugin', 'list', '--json']).installed.some(item => item.pluginId === pluginId)) invoke(['plugin', 'remove', pluginId, '--json']);
      console.log('Codex extension removed. Configuration and history are retained.'); return;
    case 'status': {
      const config = resolveAgent('codex'), file = join(config.data_directory, 'langfuse-deliveries.sqlite');
      const status = { agent: 'codex', enabled: config.enabled, target: config.targetName, baseUrl: config.base_url,
        project: config.project_name, content: config.content, stateDirectory: config.data_directory,
        hookReview: 'Trust must be checked in Codex /hooks.', lastRun: readJson(join(config.data_directory, 'status.json'), null), deliveries: {} };
      if (existsSync(file)) { const ledger = new DeliveryLedger(file, config.identity); try { status.deliveries = ledger.counts(); } finally { ledger.close(); } }
      try { status.plugin = invoke(['plugin', 'list', '--json']).installed.find(item => item.pluginId === pluginId) || null; }
      catch { status.plugin = 'Could not query Codex plugins'; }
      console.log(JSON.stringify(status, null, 2)); return;
    }
    case 'recover': {
      const config = resolveAgent('codex'), connected = await connectLangfuse(config);
      if (connected.target !== config.identity) throw new Error('Target project differs from the saved project.');
      const file = join(config.data_directory, 'langfuse-deliveries.sqlite');
      if (!existsSync(file)) { console.log('No delivery history for this target.'); return; }
      const ledger = new DeliveryLedger(file, config.identity);
      try {
        const report = await reconcileDeliveries(ledger, connected.request);
        if (args.length) {
          const item = report.find(row => row.identity === args[1]);
          if (!item || item.status !== 'unconfirmed' || Date.now() - item.updatedAt < 300000) throw new Error('Only an unconfirmed record at least 5 minutes old can be released after checking Langfuse.');
          ledger.finish([{ key: args[1] }], 'rejected');
        }
        console.log(JSON.stringify({ report, deliveries: ledger.counts(), next: 'Retry the rollout with codex export <rollout-path> --send after reconciliation.' }, null, 2));
      } finally { ledger.close(); } return;
    }
    default: throw new Error('Unknown command. Run langfuse-helper codex --help.');
  }
}
