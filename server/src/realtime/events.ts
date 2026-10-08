import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { loadAuth } from '../auth/session.js';
import { requireOrg } from '../http/guard.js';

/**
 * Change notifications. Payloads contain only the entity type, id, new version and actor —
 * never record contents. Clients re-fetch through the normal scoped endpoints, so the
 * stream cannot reveal data the viewer is not allowed to read. Delivered via Postgres
 * NOTIFY so that it works across multiple application instances, and only after commit.
 */
export async function emitChange(db: Db, orgId: string, entity: string, id: string, version: number | null, actorId: string | null) {
  await db.query('SELECT pg_notify($1, $2)', ['cc_changes', JSON.stringify({ orgId, entity, id, version, actorId, at: new Date().toISOString() })]);
}

type Listener = (msg: { orgId: string; entity: string; id: string; version: number | null; actorId: string | null }) => void;
const listeners = new Set<Listener>();
let listenClient: pg.Client | null = null;

async function ensureListening() {
  if (listenClient) return;
  listenClient = new pg.Client({ connectionString: config.DATABASE_URL });
  await listenClient.connect();
  listenClient.on('notification', (n) => {
    try {
      const msg = JSON.parse(n.payload ?? '{}');
      for (const l of listeners) l(msg);
    } catch {
      /* ignore malformed */
    }
  });
  listenClient.on('error', () => {
    listenClient = null;
  });
  await listenClient.query('LISTEN cc_changes');
}

export async function stopListening() {
  await listenClient?.end().catch(() => undefined);
  listenClient = null;
}

export async function eventRoutes(app: FastifyInstance) {
  app.get('/events', async (req, reply) => {
    const a = requireOrg(req);
    // Suppliers and employees work on a small set of their own records and refresh normally.
    if (a.membership.role === 'supplier' || a.membership.role === 'employee') return reply.code(204).send();
    await ensureListening();
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    reply.raw.write(': connected\n\n');
    const orgId = a.org.id;
    const listener: Listener = (msg) => {
      if (msg.orgId !== orgId) return;
      reply.raw.write(`event: change\ndata: ${JSON.stringify({ entity: msg.entity, id: msg.id, version: msg.version, actorId: msg.actorId })}\n\n`);
    };
    listeners.add(listener);
    // Re-validate the session periodically so a revoked or suspended user's stream stops.
    const timer = setInterval(async () => {
      const auth = await loadAuth(req).catch(() => null);
      if (!auth || auth.orgBlock || auth.org?.id !== orgId) {
        reply.raw.write('event: revoked\ndata: {}\n\n');
        cleanup();
        reply.raw.end();
      } else reply.raw.write(': ping\n\n');
    }, 15_000);
    const cleanup = () => {
      clearInterval(timer);
      listeners.delete(listener);
    };
    req.raw.on('close', cleanup);
  });
}
