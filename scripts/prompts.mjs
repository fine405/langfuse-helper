import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export async function withPrompts(action) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use an interactive terminal for configuration and selection.');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk, encoding); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  rl.on('SIGINT', () => rl.close());
  const ask = label => rl.question(label);
  const secret = async label => {
    process.stdout.write(label); hidden = true;
    try { return await ask(''); } finally { hidden = false; process.stdout.write('\n'); }
  };
  try { return await action({ ask, secret, log: console.log }); }
  finally { rl.close(); }
}
export async function choose(ask, title, choices) {
  console.log(`\n${title}`);
  choices.forEach((choice, i) => console.log(`  ${i + 1}. ${choice.label}`));
  for (;;) {
    const answer = (await ask('Select a number (q to cancel): ')).trim();
    if (answer.toLowerCase() === 'q') return null;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index].value;
    console.log('Enter one of the listed numbers.');
  }
}
