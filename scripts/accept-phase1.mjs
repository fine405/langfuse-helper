import { join } from 'node:path';
import { root, dataDir } from './cli.mjs';
import { readJsonLines, spansFrom } from './data.mjs';
import { assessPhase1 } from './acceptance.mjs';
import { readPreview } from './preview.mjs';

try {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error('用法：npm run accept:phase1 -- <WorkBuddy Session ID>');
  const [preview, hooks] = await Promise.all([
    readPreview(join(root, '.local/collector')),
    readJsonLines(join(dataDir, 'hooks.jsonl')),
  ]);
  const result = assessPhase1(spansFrom(preview.batches), hooks, sessionId);
  result.storage = preview.storage;
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
