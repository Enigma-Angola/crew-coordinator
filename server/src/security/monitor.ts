import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';

/**
 * Security event recording and threshold-based alerting. Alerts appear in the
 * administrator's security panel; docs/INCIDENT_RESPONSE.md describes handling.
 */
export async function securityEvent(
  db: Db,
  kind: string,
  e: { orgId?: string | null; userId?: string | null; ip?: string | null; detail?: Record<string, unknown> },
) {
  await db.query('INSERT INTO security_events (kind, org_id, user_id, ip, detail) VALUES ($1,$2,$3,$4,$5)', [
    kind,
    e.orgId ?? null,
    e.userId ?? null,
    e.ip ?? null,
    e.detail ?? {},
  ]);
  await evaluateRules(db, kind, e);
}

async function raise(db: Db, orgId: string | null | undefined, code: string, severity: 'warning' | 'critical', detail: Record<string, unknown>) {
  // One open alert per code/subject at a time.
  const existing = await one(
    db,
    `SELECT id FROM security_alerts WHERE code = $1 AND status = 'open' AND org_id IS NOT DISTINCT FROM $2 AND detail->>'subject' = $3`,
    [code, orgId ?? null, String(detail.subject ?? '')],
  );
  if (existing) return;
  await db.query('INSERT INTO security_alerts (org_id, code, severity, detail) VALUES ($1,$2,$3,$4)', [orgId ?? null, code, severity, detail]);
}

async function evaluateRules(db: Db, kind: string, e: { orgId?: string | null; userId?: string | null; ip?: string | null; detail?: Record<string, unknown> }) {
  if ((kind === 'login_failed' || kind === 'login_denied') && e.ip) {
    const r = await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM security_events WHERE kind IN ('login_failed','login_denied') AND ip = $1 AND at > now() - interval '15 minutes'`,
      [e.ip],
    );
    if (r && r.n >= 10) await raise(db, null, 'repeated_login_failures', 'warning', { subject: e.ip, count: r.n, windowMinutes: 15 });
  }
  if (kind === 'privilege_change' && e.orgId) {
    await raise(db, e.orgId, 'privilege_change', 'warning', { subject: `${e.detail?.membershipId ?? ''}:${Date.now()}`, ...e.detail });
  }
  if (kind === 'export' && e.orgId && e.userId) {
    const org = await one<{ export_alert_threshold: number }>(db, 'SELECT export_alert_threshold FROM organizations WHERE id = $1', [e.orgId]);
    const r = await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM security_events WHERE kind = 'export' AND user_id = $1 AND org_id = $2 AND at > now() - interval '1 hour'`,
      [e.userId, e.orgId],
    );
    if (org && r && r.n >= org.export_alert_threshold) {
      await raise(db, e.orgId, 'unusual_export_volume', 'critical', { subject: e.userId, count: r.n, windowMinutes: 60 });
    }
    if (e.detail?.includesRestricted) {
      await raise(db, e.orgId, 'restricted_data_export', 'warning', { subject: `${e.userId}:${Date.now()}`, dataset: e.detail.dataset });
    }
  }
}
