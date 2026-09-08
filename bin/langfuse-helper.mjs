#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

function main() {
  const [agent, command, ...args] = process.argv.slice(2);
  if (!agent || ['--help', '-h', 'help'].includes(agent)) {
    console.log('Langfuse Helper\n\nUsage: langfuse-helper <agent> <command> [options]\n\nAgents:\n  workbuddy   WorkBuddy desktop tracing and delivery (macOS)\n\nOptions:\n  --help, -h       Show this help\n  --version, -v    Show the installed version\n\nRun langfuse-helper workbuddy --help for agent commands.'); return;
  }
  if (['--version', '-v'].includes(agent) && !command) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return;
  }
  if (agent !== 'workbuddy') throw new Error('Unsupported agent. Available agents: workbuddy. Run langfuse-helper --help.');
  if (!command || ['--help', '-h', 'help'].includes(command)) { console.log(help); return; }
  const setup = ['configure', 'start', 'stop', 'uninstall'];
  const known = [...setup, 'status', 'doctor', 'diagnose', 'serve', 'verify', 'export', 'recover'];
  if (!known.includes(command)) throw new Error('Unknown command. Run langfuse-helper --help.');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(help); return; }
  let script, forwarded;
  const id = value => typeof value === 'string' && value.length > 0 && !value.startsWith('-');
  if (setup.includes(command) && !args.length) [script, forwarded] = ['setup.mjs', [command]];
  else if (command === 'status' && !args.length) [script, forwarded] = ['setup.mjs', ['status']];
  else if (command === 'status' && args.length === 1 && args[0] === '--json') [script, forwarded] = ['sidecar.mjs', ['status']];
  else if (command === 'serve' && !args.length) [script, forwarded] = ['sidecar.mjs', ['serve']];
  else if (['doctor', 'diagnose'].includes(command) && !args.length) [script, forwarded] = ['cli.mjs', [command === 'doctor' ? 'doctor' : 'status']];
  else if (command === 'verify' && args.length === 1 && id(args[0])) [script, forwarded] = ['verify-langfuse.mjs', args];
  else if (command === 'export' && id(args[0]) && (args.length === 1 || (args.length === 2 && args[1] === '--send'))) [script, forwarded] = ['langfuse.mjs', args];
  else if (command === 'recover' && (!args.length || (args.length === 2 && args[0] === '--retry-confirmed-absent' && id(args[1])))) [script, forwarded] = ['recovery.mjs', args];
  else throw new Error('Invalid arguments. Run langfuse-helper --help.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required.');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), ...forwarded], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? (result.signal === 'SIGINT' ? 130 : 1);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
