import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TraceStore } from './trace-store.mjs';

const path = process.env.WB_LF_DATABASE || '/data/traces.sqlite';
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const store = new TraceStore(path);
const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/health' && request.method === 'GET') { response.end('{}'); return; }
  if (request.url !== '/v1/traces' || request.method !== 'POST') { response.writeHead(404).end('{}'); return; }
  if (!request.headers['content-type']?.startsWith('application/json')) { response.writeHead(415).end('{}'); return; }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { response.writeHead(413).end('{}'); return; }
      chunks.push(chunk);
    }
    store.ingest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.end('{}');
  } catch (error) {
    // Never log telemetry bodies; a storage failure is retriable by the Collector.
    console.error(`correlator: ${error.name}`);
    response.writeHead(error instanceof SyntaxError || error instanceof TypeError ? 400 : 503).end('{}');
  }
});
server.listen(Number(process.env.WB_LF_CORRELATOR_PORT || 4319), '0.0.0.0');
process.on('SIGTERM', () => { server.close(() => store.close()); server.closeIdleConnections(); });
