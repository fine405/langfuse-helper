import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaults = { content: 'metadata', maxContentChars: 16000, stalledAfterSeconds: 60, pollIntervalMs: 1000, prices: {} };

export async function readSettings(path = resolve(projectRoot, '.local/settings.json')) {
  let saved = {};
  try { saved = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = { ...defaults, ...saved };
  if (!['metadata', 'text'].includes(settings.content)) throw new Error('content must be metadata or text');
  if (!Number.isInteger(settings.maxContentChars) || settings.maxContentChars < 100 || settings.maxContentChars > 64000) throw new Error('maxContentChars must be 100–64000');
  if (!Number.isInteger(settings.stalledAfterSeconds) || settings.stalledAfterSeconds < 5) throw new Error('stalledAfterSeconds must be at least 5');
  if (!Number.isInteger(settings.pollIntervalMs) || settings.pollIntervalMs < 500) throw new Error('pollIntervalMs must be at least 500');
  if (!settings.prices || typeof settings.prices !== 'object' || Array.isArray(settings.prices)) throw new Error('prices must be an object');
  return settings;
}
