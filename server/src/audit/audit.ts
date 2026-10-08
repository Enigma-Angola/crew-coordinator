import type { Db } from '../db/pool.js';
import { many } from '../db/pool.js';
import { canonicalJson } from '../util/json.js';
import { sha256hex } from '../util/crypto.js';

export const PLATFORM_ORG = '00000000-0000-0000-0000-000000000000';
const GENESIS = '0'.repeat(64);

export interface AuditActor {
  userId?: string | null;
  sessionId?: string | null;
  ip?: string | null;
}

export interface AuditEntry {
  orgId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  /** Metadata only. Never put document contents, medical details or message bodies here. */
  metadata?: Record<string, unknown>;
}

function hashOf(prev: string, row: Record<string, unknown>) {
  return sha256hex(prev + canonicalJson(row));
}

/**
 * Appends a hash-chained audit record in the caller's transaction. A per-organisation
 * advisory lock serialises writers so the chain cannot fork. The table is append-only
 * (no UPDATE/DELETE privilege and a blocking trigger).
 */
export async function audit(db: Db, actor: AuditActor, entry: AuditEntry) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${entry.orgId}`]);
  const last = await db.query('SELECT seq, hash FROM audit_events WHERE org_id = $1 ORDER BY seq DESC LIMIT 1', [entry.orgId]);
  const seq = last.rowCount ? Number(last.rows[0].seq) + 1 : 1;
  const prev = last.rowCount ? last.rows[0].hash : GENESIS;
  const at = new Date().toISOString();
  const body = {
    orgId: entry.orgId,
    seq,
    at,
    actorId: actor.userId ?? null,
    sessionId: actor.sessionId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
  };
  const hash = hashOf(prev, body);
  await db.query(
    `INSERT INTO audit_events (org_id, seq, at, actor_id, session_id, action, entity_type, entity_id, metadata, ip, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [entry.orgId, seq, at, body.actorId, body.sessionId, entry.action, body.entityType, body.entityId, body.metadata, actor.ip ?? null, prev, hash],
  );
  return { seq, hash };
}

/** Recomputes the chain and reports the first break, if any. */
export async function verifyAuditChain(db: Db, orgId: string) {
  const rows = await many(db, 'SELECT * FROM audit_events WHERE org_id = $1 ORDER BY seq', [orgId]);
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const r of rows) {
    const body = {
      orgId: r.org_id,
      seq: Number(r.seq),
      at: new Date(r.at).toISOString(),
      actorId: r.actor_id,
      sessionId: r.session_id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      metadata: r.metadata,
    };
    if (Number(r.seq) !== expectedSeq || r.prev_hash !== prev || hashOf(prev, body) !== r.hash) {
      return { valid: false, checked: rows.length, brokenAtSeq: Number(r.seq) };
    }
    prev = r.hash;
    expectedSeq++;
  }
  return { valid: true, checked: rows.length, headHash: prev };
}
