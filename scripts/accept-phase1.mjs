import { join } from 'node:path';
import { root, dataDir } from './cli.mjs';
import { readJsonLines, spansFrom } from './data.mjs';
import { assessPhase1 } from './acceptance.mjs';

try {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error('用法：npm run accept:phase1 -- <WorkBuddy Session ID>');
  const [batches, hooks] = await Promise.all([
    readJsonLines(join(root, '.local/collector/traces.jsonl')),
    readJsonLines(join(dataDir, 'hooks.jsonl')),
  ]);
  const result = assessPhase1(spansFrom(batches), hooks, sessionId);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
