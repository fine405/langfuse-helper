import { isMain } from './entry.mjs';
import { resolve } from 'node:path';
import { DeliveryLedger, langfuseConfig } from './langfuse.mjs';
import { local } from './cli.mjs';

export async function observationsForTrace(request, traceId) {
  const observations = [], cursors = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({ traceId, limit: '1000', fields: 'basic,time,usage,model,io,metadata', ...(cursor ? { cursor } : {}) });
    const response = await request(`/api/public/v2/observations?${query}`);
    if (!response.ok) throw new Error(`Langfuse query failed (HTTP ${response.status}).`);
    const result = await response.json();
    if (!Array.isArray(result.data)) throw new Error('Langfuse query response is missing data');
    observations.push(...result.data);
    cursor = result.meta?.cursor;
    if (cursor && cursors.has(cursor)) throw new Error('Langfuse returned a repeated pagination cursor');
    cursors.add(cursor);
  } while (cursor);
  return observations;
}

// Absence is never an acknowledgement: ingestion and public queries are asynchronous.
export async function reconcileDeliveries(ledger, request) {
  const report = [], byTrace = new Map();
  for (const row of ledger.uncertain()) {
    const [traceId, spanId] = row.identity.split(':');
    if (!byTrace.has(traceId)) byTrace.set(traceId, await observationsForTrace(request, traceId));
    const matches = byTrace.get(traceId).filter(item => item.id === spanId && item.traceId === traceId);
    let status = 'unconfirmed';
    if (matches.length === 1 && matches[0].metadata?.deliveryDigest === row.digest) {
      ledger.finish([{ key: row.identity }], 'accepted');
      status = 'accepted';
    } else if (matches.length) status = 'conflict';
    report.push({ identity: row.identity, status, matches: matches.length, updatedAt: row.updated_at });
  }
  return report;
}

export async function connectLangfuse(settings) {
  const config = langfuseConfig(settings);
  const response = await config.request('/api/public/projects');
  if (!response.ok) throw new Error(`Langfuse project authentication failed (HTTP ${response.status}).`);
  const projects = (await response.json()).data;
  if (projects?.length !== 1 || !projects[0].id) throw new Error('Use API keys for exactly one Langfuse project.');
  return { ...config, project: projects[0], target: `${config.base}/${projects[0].id}` };
}

async function main() {
  const { request, target } = await connectLangfuse();
  const ledger = new DeliveryLedger(resolve(local, 'langfuse-deliveries.sqlite'), target);
  try {
    const report = await reconcileDeliveries(ledger, request);
    const [option, identity] = process.argv.slice(2);
    if (option) {
      if (option !== '--retry-confirmed-absent' || !identity) throw new Error('Usage: langfuse-helper workbuddy recover [--retry-confirmed-absent <trace-id:span-id>]');
      const item = report.find(row => row.identity === identity);
      if (!item || item.status !== 'unconfirmed') throw new Error('Only an uncertain record absent from the current query can be released');
      if (Date.now() - item.updatedAt < 5 * 60 * 1000) throw new Error('Delivery is less than 5 minutes old. Wait for ingestion before checking again');
      ledger.finish([{ key: identity }], 'rejected');
      console.log('Released one record at your explicit request; delivery will retry. Absence from a query does not prove permanent absence. Retain the audit record.');
    }
    console.log(JSON.stringify({ report, deliveries: ledger.counts() }, null, 2));
  } finally { ledger.close(); }
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
