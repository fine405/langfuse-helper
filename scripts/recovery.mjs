import { isMain } from './entry.mjs';
import { resolve } from 'node:path';
import { DeliveryLedger, connectLangfuse as connect, reconcileDeliveries } from './delivery.mjs';
import { readConfig } from './settings.mjs';
import { local } from './cli.mjs';

export { observationsForTrace, reconcileDeliveries } from './delivery.mjs';
export const connectLangfuse = (settings = readConfig()) => connect(settings);


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
