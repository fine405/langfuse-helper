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
    if (!response.ok) throw new Error(`Langfuse 查询失败（HTTP ${response.status}）。`);
    const result = await response.json();
    if (!Array.isArray(result.data)) throw new Error('Langfuse 查询响应缺少 data');
    observations.push(...result.data);
    cursor = result.meta?.cursor;
    if (cursor && cursors.has(cursor)) throw new Error('Langfuse 返回重复分页游标');
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
  if (!response.ok) throw new Error(`Langfuse 项目认证失败（HTTP ${response.status}）。`);
  const projects = (await response.json()).data;
  if (projects?.length !== 1 || !projects[0].id) throw new Error('必须使用单个 Langfuse 项目的密钥。');
  return { ...config, project: projects[0], target: `${config.base}/${projects[0].id}` };
}

async function main() {
  const { request, target } = await connectLangfuse();
  const ledger = new DeliveryLedger(resolve(local, 'langfuse-deliveries.sqlite'), target);
  try {
    const report = await reconcileDeliveries(ledger, request);
    const [option, identity] = process.argv.slice(2);
    if (option) {
      if (option !== '--retry-confirmed-absent' || !identity) throw new Error('用法：npm run recover [-- --retry-confirmed-absent <traceId:spanId>]');
      const item = report.find(row => row.identity === identity);
      if (!item || item.status !== 'unconfirmed') throw new Error('只能释放本次查询未找到的不确定记录');
      if (Date.now() - item.updatedAt < 5 * 60 * 1000) throw new Error('发送未满 5 分钟；必须等待入库后再核查');
      ledger.finish([{ key: identity }], 'rejected');
      console.log('已按你的显式确认释放一条记录，下次发送会重试。查询缺失不能证明永久未入库，请保留审计记录。');
    }
    console.log(JSON.stringify({ report, deliveries: ledger.counts() }, null, 2));
  } finally { ledger.close(); }
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
