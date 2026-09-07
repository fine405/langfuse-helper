import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonLines } from './data.mjs';

export async function readPreview(directory) {
  const path = join(directory, 'traces.sqlite');
  try { await access(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { batches: await readJsonLines(join(directory, 'traces.jsonl')), states: {}, storage: 'legacy-raw-jsonl' };
  }
  const { readStore } = await import('../collector/trace-store.mjs');
  return { ...readStore(path), storage: 'correlated-sqlite' };
}
