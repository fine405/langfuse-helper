import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Diagnostic events only. No transcript reads, model/tool content, or networking.
if (process.env.WORKBUDDY_LANGFUSE_ENABLED !== '1' && process.env.WORKBUDDY_LANGFUSE_TEST !== '1') process.exit(0);
try {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('payload too large');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const event = {
    schemaVersion: 1,
    receivedAt: new Date().toISOString(),
    source: process.env.WORKBUDDY_LANGFUSE_TEST === '1' ? 'synthetic' : 'workbuddy-hook',
    transcriptAvailable: typeof input.transcript_path === 'string' && input.transcript_path.length > 0,
  };
  for (const key of ['hook_event_name', 'session_id', 'tool_name', 'tool_use_id', 'call_id']) {
    if (typeof input[key] === 'string') event[key] = input[key].slice(0, 160);
  }
  if (!event.hook_event_name || !event.session_id) throw new Error('missing identity');
  const directory = process.env.WORKBUDDY_LANGFUSE_DATA_DIR || join(homedir(), '.workbuddy', 'langfuse-plugin');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(join(directory, 'hooks.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
} catch {
  // Hooks must never block the agent or inject diagnostics into its context.
}
