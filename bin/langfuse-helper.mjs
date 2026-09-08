#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const help = `Langfuse Helper - WorkBuddy

Usage: langfuse-helper workbuddy <command> [options]

  configure                     Configure Langfuse and capture settings
  start                         Start capture and open WorkBuddy
  status [--json]                Show connection and delivery status
  stop                          Stop capture, keeping configuration and data
  doctor                        Check Node.js, WorkBuddy and Docker
  diagnose                      Show native capture and correlation statistics
  serve                         Run the delivery service in the foreground
  verify <session-id>           Compare a completed session with Langfuse
  export <session-id> [--send]   Preview a session; --send explicitly uploads it
  recover [--retry-confirmed-absent <trace-id:span-id>]
                                Reconcile uncertain deliveries
  uninstall                     Stop capture and remove the WorkBuddy plugin
  --help, -h                    Show this help

Install and update the CLI with npm. Run langfuse-helper workbuddy uninstall
before npm uninstall -g langfuse-helper. User configuration and delivery history are retained.
`;

const generalHelp = `Langfuse Helper

Usage: langfuse-helper [<agent> <command> [options]]

  (no arguments)     Select a detected agent and action in a terminal
  agents [--json]     Discover known local agents and available extensions
  targets            List target profiles without API keys
  workbuddy          WorkBuddy desktop capture (macOS, Docker)
  codex              Codex CLI and desktop Stop-hook capture
  --help, -h         Show this help
  --version, -v      Show the installed version

Run langfuse-helper <agent> --help for agent commands.`;
const codexHelp = `Langfuse Helper - Codex

Usage: langfuse-helper codex <command> [options]

  configure                    Choose a target and content settings
  install                      Install the bundled extension; review /hooks in Codex
  start [--app]                Enable capture and start the CLI (or desktop app)
  status [--json]               Show plugin, target and delivery state
  stop                         Disable future captures, keeping Codex open
  doctor                       Inspect Codex and extension availability
  export <rollout-path> [--send] Preview completed turns; --send uploads explicitly
  recover [--retry-confirmed-absent <trace-id:span-id>]
                               Reconcile uncertain deliveries
  uninstall                    Disable capture and remove the Codex extension
  --help, -h                   Show this help

API keys belong to target profiles. Review and trust the Stop hook in Codex /hooks.
New target bindings apply to new tasks. Configuration and delivery history are retained.`;

async function dispatch(agent, command, args = []) {
  const known = agent === 'codex' ? ['configure', 'install', 'start', 'status', 'stop', 'doctor', 'export', 'recover', 'uninstall']
    : ['configure', 'start', 'status', 'stop', 'doctor', 'diagnose', 'serve', 'verify', 'export', 'recover', 'uninstall'];
  if (!known.includes(command)) throw new Error('Unknown command. Run langfuse-helper <agent> --help.');
  if (command === 'configure') {
    if (args.length) throw new Error('Invalid arguments. Run langfuse-helper <agent> --help.');
    return (await import('../scripts/configure.mjs')).configureAgent(agent);
  }
  if (agent === 'codex') return (await import('../scripts/codex.mjs')).codexCommand(command, args);
  return (await import('../scripts/workbuddy.mjs')).workbuddyCommand(command, args);
}
async function main() {
  const [agent, command, ...args] = process.argv.slice(2);
  if (['--help', '-h', 'help'].includes(agent) || (!agent && !process.stdin.isTTY)) { console.log(generalHelp); return; }
  if (['--version', '-v'].includes(agent) && !command) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required.');
  if (!agent) {
    const { discoverAgents } = await import('../scripts/agents.mjs');
    const { withPrompts, choose } = await import('../scripts/prompts.mjs');
    const available = discoverAgents().filter(item => item.detected && item.supported && item.runnable);
    if (!available.length) throw new Error('No supported runnable agent found. Run langfuse-helper agents.');
    const selected = await withPrompts(async ({ ask }) => {
      const id = await choose(ask, 'Select an agent', available.map(item => ({ label: item.name, value: item.id })));
      if (!id) return;
      const item = available.find(item => item.id === id);
      const choices = item.commands.flatMap(command => command === 'start' && id === 'codex' && item.application
        ? [{ label: 'start (CLI)', value: { command, args: [] } }, { label: 'start (desktop app)', value: { command, args: ['--app'] } }]
        : [{ label: command, value: { command, args: [] } }]);
      const action = await choose(ask, 'Select an action', choices);
      return action && { id, action };
    });
    if (selected) await dispatch(selected.id, selected.action.command, selected.action.args);
    return;
  }
  if (agent === 'agents') {
    if (args.length || (command && command !== '--json')) throw new Error('Invalid arguments. Use langfuse-helper agents [--json].');
    const found = (await import('../scripts/agents.mjs')).discoverAgents();
    if (command) console.log(JSON.stringify(found, null, 2));
    else for (const item of found) console.log(`${item.name}: ${item.detected ? 'detected' : 'not found'}; extension ${item.supported ? 'available' : 'not supported'}; ${item.runnable ? 'ready to configure' : 'not runnable'}${item.cli ? `; CLI ${item.cli}` : ''}${item.application ? `; app ${item.application}` : ''}`);
    return;
  }
  if (agent === 'targets') {
    if (command) throw new Error('Invalid arguments. Use langfuse-helper targets.');
    const { readProfiles } = await import('../scripts/profiles.mjs');
    const config = readProfiles();
    for (const [name, target] of Object.entries(config.targets)) console.log(`${name}: ${target.base_url} / ${target.project_name}; agents: ${Object.entries(config.agents).filter(([, value]) => value.target === name).map(([id]) => id).join(', ') || 'none'}`);
    if (!Object.keys(config.targets).length) console.log('No targets configured. Run langfuse-helper <agent> configure.');
    return;
  }
  if (!['workbuddy', 'codex'].includes(agent)) throw new Error('Unsupported agent. Available agents: workbuddy, codex.');
  if (!command || ['--help', '-h', 'help'].includes(command) || (args.length === 1 && ['--help', '-h'].includes(args[0]))) { console.log(agent === 'codex' ? codexHelp : help); return; }
  await dispatch(agent, command, args);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
