import { many, one, withTx } from './db/pool.js';
import { refreshInsights } from './domain/insights.js';
import { GraphClient, type MailboxRow } from './email/connectors/graph.js';
import { ProviderRateLimited, ReauthorisationRequired } from './email/connectors/types.js';
import { ingestInbound } from './email/ingest.js';
import { processOutbox, processReminders } from './email/packages.js';

/** Synchronises one mailbox's configured folders. */
export async function syncMailbox(orgId: string, mailboxId: string) {
  const box = await withTx({ orgId }, (db) => one<MailboxRow>(db, 'SELECT * FROM mailbox_connections WHERE id = $1', [mailboxId]));
  if (!box || box.status !== 'connected') return { status: box?.status ?? 'not_found', stored: 0 };
  let stored = 0;
  let seen = 0;
  try {
    await withTx({ orgId }, async (db) => {
      const client = new GraphClient(db, box);
      for await (const m of client.sync()) {
        seen++;
        const r = await ingestInbound(db, orgId, m, { source: 'sync', mailboxId });
        if (r.stored && !r.duplicate) stored++;
      }
      await db.query('UPDATE mailbox_connections SET last_sync_at = now(), last_error = NULL WHERE id = $1', [mailboxId]);
    });
  } catch (e) {
    const status = e instanceof ReauthorisationRequired ? 'reauthorisation_required' : 'connected';
    const message = e instanceof ProviderRateLimited ? `rate_limited:${e.retryAfterSeconds}` : (e as Error).message.slice(0, 200);
    await withTx({ orgId }, (db) => db.query('UPDATE mailbox_connections SET status = $2, last_error = $3 WHERE id = $1', [mailboxId, status, message]));
    return { status: e instanceof ReauthorisationRequired ? 'reauthorisation_required' : 'sync_failed', error: message, stored, seen };
  }
  return { status: 'ok', stored, seen };
}

/** One pass of background work for every organisation. */
export async function runOnce() {
  const orgs = await withTx({}, (db) => many(db, 'SELECT id FROM organizations'));
  for (const o of orgs) {
    await processOutbox(o.id).catch((e) => console.error('outbox', o.id, e.message));
    await processReminders(o.id).catch((e) => console.error('reminders', o.id, e.message));
    const boxes = await withTx({ orgId: o.id }, (db) => many(db, "SELECT id FROM mailbox_connections WHERE org_id = $1 AND status = 'connected'", [o.id]));
    for (const b of boxes) await syncMailbox(o.id, b.id);
    await withTx({ orgId: o.id }, (db) => refreshInsights(db, o.id)).catch((e) => console.error('insights', o.id, e.message));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const loop = async () => {
    await runOnce().catch((e) => console.error(e));
    setTimeout(loop, 60_000);
  };
  loop();
}
