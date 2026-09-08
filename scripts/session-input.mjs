import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TranscriptStore } from './transcript.mjs';
import { enrichBatches } from './enrichment.mjs';
import { readJsonLines } from './data.mjs';
import { readConfig } from './settings.mjs';
import { local, configDir, dataDir } from './cli.mjs';

export async function enrichSession(records, sessionId) {
  const hooks = await readJsonLines(join(dataDir, 'hooks.jsonl'));
  const registration = hooks.find(event => event.session_id === sessionId && event.transcript_path && event.source === 'workbuddy-hook');
  // Old diagnostic sessions remain unchanged, including observations already delivered by v0.2.0.
  if (!registration) return records;
  const settings = { ...readConfig(), content: registration.contentMode || 'metadata' };
  const transcript = new TranscriptStore(join(local, 'transcripts.sqlite'));
  try {
    let read;
    do { read = await transcript.read(registration.transcript_path, sessionId, { ...settings, projectsDir: join(configDir, 'projects') }); }
    while (read.readBytes === 8 * 1024 * 1024);
    const batches = enrichBatches(records.map(record => record.payload), transcript.records(sessionId), settings);
    return records.map((record, index) => ({ ...record, payload: batches[index],
      digest: createHash('sha256').update(JSON.stringify(batches[index])).digest('hex') }));
  } finally { transcript.close(); }
}
