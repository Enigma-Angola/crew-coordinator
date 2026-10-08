import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, verifyAuditChain } from '../audit/audit.js';
import { config } from '../config.js';
import { many, one, type Db } from '../db/pool.js';
import { ROLES, type Role } from '../authz/permissions.js';
import { actorOf, need, orgTx, type OrgContext } from '../http/guard.js';
import { ApiError, badRequest, notFound } from '../http/errors.js';
import { securityEvent } from '../security/monitor.js';
import { randomToken, sha256 } from '../util/crypto.js';
import { renderSystemEmail } from '../i18n/server-messages.js';
import { idParam, page } from './util.js';

const roleSchema = z.enum(ROLES as [Role, ...Role[]]);

async function revokeOrgSessions(db: Db, a: OrgContext, userId: string, reason: string) {
  const r = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_by = $3, revoke_reason = $4
     WHERE user_id = $1 AND active_org_id = $2 AND revoked_at IS NULL RETURNING id`,
    [userId, a.org.id, a.user.id, reason],
  );
  return r.rowCount ?? 0;
}

async function activeAdminCount(db: Db, orgId: string) {
  const r = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'org_admin' AND status = 'active'", [orgId]);
  return r?.n ?? 0;
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/members', async (req) => {
    const a = need(req, 'members:view');
    return orgTx(a, (db) =>
      many(
        db,
        `SELECT m.id, m.user_id, m.role, m.status, m.supplier_id, m.asset_scope, m.approved_at, m.created_at, m.version,
                u.display_name, u.email, u.status AS user_status, u.last_login_at, s.name AS supplier_name,
                (SELECT count(*)::int FROM sessions x WHERE x.user_id = m.user_id AND x.active_org_id = m.org_id
                   AND x.revoked_at IS NULL AND x.expires_at > now()) AS active_sessions
         FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN suppliers s ON s.id = m.supplier_id
         WHERE m.org_id = $1 ORDER BY m.status, u.display_name`,
        [a.org.id],
      ),
    );
  });

  app.get('/admin/invitations', async (req) => {
    const a = need(req, 'members:manage');
    return orgTx(a, (db) =>
      many(
        db,
        `SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at, u.display_name AS invited_by_name
         FROM invitations i JOIN users u ON u.id = i.invited_by WHERE i.org_id = $1 ORDER BY i.created_at DESC LIMIT 200`,
        [a.org.id],
      ),
    );
  });

  app.post('/admin/invitations', async (req) => {
    const a = need(req, 'members:manage');
    const b = z
      .object({
        email: z.string().email().max(200),
        role: roleSchema,
        supplierId: z.string().uuid().nullish(),
        assetScope: z.array(z.string().uuid()).nullish(),
        personnelId: z.string().uuid().nullish(),
        language: z.enum(['pt-PT', 'en']).optional(),
      })
      .parse(req.body);
    if (b.role === 'supplier' && !b.supplierId) throw badRequest('supplier_required');
    const token = randomToken(32);
    const inv = await orgTx(a, async (db) => {
      if (b.supplierId && !(await one(db, 'SELECT id FROM suppliers WHERE id = $1 AND org_id = $2', [b.supplierId, a.org.id]))) throw notFound();
      if (b.personnelId && !(await one(db, 'SELECT id FROM personnel WHERE id = $1 AND org_id = $2', [b.personnelId, a.org.id]))) throw notFound();
      const row = await one(
        db,
        `INSERT INTO invitations (org_id, email, role, supplier_id, asset_scope, personnel_id, token_hash, invited_by, expires_at)
         VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, now() + interval '7 days') RETURNING id, email, role, expires_at`,
        [a.org.id, b.email, b.role, b.supplierId ?? null, b.assetScope ?? null, b.personnelId ?? null, sha256(token), a.user.id],
      );
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'invitation.created', entityType: 'invitation', entityId: row.id, metadata: { role: b.role } });
      return row;
    });
    const inviteUrl = `${config.APP_BASE_URL}/invite/${token}`;
    const language = b.language ?? (a.org.default_language as 'pt-PT' | 'en');
    // The invitation link is shown once to the administrator, together with a translated
    // message they can send. The token itself is never stored in clear.
    return { ...inv, inviteUrl, email: renderSystemEmail('invitation', language, { org: a.org.name, inviteUrl, inviter: a.user.display_name }) };
  });

  app.delete('/admin/invitations/:id', async (req) => {
    const a = need(req, 'members:manage');
    const id = idParam((req.params as any).id);
    await orgTx(a, async (db) => {
      const r = await db.query('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL', [id, a.org.id]);
      if (!r.rowCount) throw notFound();
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'invitation.revoked', entityType: 'invitation', entityId: id });
    });
    return { ok: true };
  });

  app.post('/admin/members/:id/approve', async (req) => {
    const a = need(req, 'members:approve');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const m = await one(db, 'SELECT * FROM memberships WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, a.org.id]);
      if (!m) throw notFound();
      if (m.status !== 'pending_approval') throw new ApiError(409, 'invalid_state');
      if (m.user_id === a.user.id) throw new ApiError(403, 'cannot_approve_self');
      // Segregation of duties: a new administrator must be approved by someone other than the inviter.
      if (m.role === 'org_admin' && m.invited_by === a.user.id && (await activeAdminCount(db, a.org.id)) > 1) {
        throw new ApiError(403, 'segregation_of_duties');
      }
      await db.query("UPDATE memberships SET status = 'active', approved_by = $2, approved_at = now(), version = version + 1 WHERE id = $1", [id, a.user.id]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'membership.approved', entityType: 'membership', entityId: id, metadata: { role: m.role } });
      await securityEvent(db, 'privilege_change', { orgId: a.org.id, userId: a.user.id, ip: a.ip, detail: { membershipId: id, change: 'approved', role: m.role } });
      return { ok: true };
    });
  });

  app.patch('/admin/members/:id', async (req) => {
    const a = need(req, 'members:manage');
    const id = idParam((req.params as any).id);
    const b = z
      .object({ role: roleSchema.optional(), assetScope: z.array(z.string().uuid()).nullable().optional(), supplierId: z.string().uuid().nullable().optional(), version: z.number().int() })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const m = await one(db, 'SELECT * FROM memberships WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, a.org.id]);
      if (!m) throw notFound();
      // Nobody can change their own role or scope, so privileges cannot be self-granted.
      if (m.user_id === a.user.id) throw new ApiError(403, 'cannot_modify_self');
      if (m.version !== b.version) throw new ApiError(409, 'edit_conflict', { currentVersion: m.version, current: m, conflicts: [] });
      const role = b.role ?? m.role;
      const supplierId = b.supplierId !== undefined ? b.supplierId : m.supplier_id;
      if (role === 'supplier' && !supplierId) throw badRequest('supplier_required');
      if (m.role === 'org_admin' && role !== 'org_admin' && (await activeAdminCount(db, a.org.id)) <= 1) throw new ApiError(409, 'last_admin');
      const updated = await one(
        db,
        `UPDATE memberships SET role = $2, asset_scope = $3, supplier_id = $4, version = version + 1 WHERE id = $1 RETURNING id, role, asset_scope, supplier_id, version`,
        [id, role, b.assetScope !== undefined ? b.assetScope : m.asset_scope, role === 'supplier' ? supplierId : null],
      );
      await audit(db, actorOf(a), {
        orgId: a.org.id,
        action: 'membership.changed',
        entityType: 'membership',
        entityId: id,
        metadata: { from: { role: m.role, assetScope: m.asset_scope }, to: { role: updated.role, assetScope: updated.asset_scope } },
      });
      await securityEvent(db, 'privilege_change', { orgId: a.org.id, userId: a.user.id, ip: a.ip, detail: { membershipId: id, from: m.role, to: role } });
      return updated;
    });
  });

  app.post('/admin/members/:id/suspend', async (req) => {
    const a = need(req, 'members:manage', 'sessions:revoke');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const m = await one(db, 'SELECT * FROM memberships WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, a.org.id]);
      if (!m) throw notFound();
      if (m.user_id === a.user.id) throw new ApiError(403, 'cannot_modify_self');
      if (m.role === 'org_admin' && m.status === 'active' && (await activeAdminCount(db, a.org.id)) <= 1) throw new ApiError(409, 'last_admin');
      await db.query("UPDATE memberships SET status = 'suspended', suspended_by = $2, suspended_at = now(), version = version + 1 WHERE id = $1", [id, a.user.id]);
      const revoked = await revokeOrgSessions(db, a, m.user_id, 'membership_suspended');
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'membership.suspended', entityType: 'membership', entityId: id, metadata: { revokedSessions: revoked } });
      await securityEvent(db, 'privilege_change', { orgId: a.org.id, userId: a.user.id, ip: a.ip, detail: { membershipId: id, change: 'suspended' } });
      return { ok: true, revokedSessions: revoked };
    });
  });

  app.post('/admin/members/:id/reactivate', async (req) => {
    const a = need(req, 'members:manage');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const m = await one(db, "SELECT * FROM memberships WHERE id = $1 AND org_id = $2 AND status = 'suspended'", [id, a.org.id]);
      if (!m) throw notFound();
      if (m.user_id === a.user.id) throw new ApiError(403, 'cannot_modify_self');
      await db.query("UPDATE memberships SET status = 'active', suspended_by = NULL, suspended_at = NULL, version = version + 1 WHERE id = $1", [id]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'membership.reactivated', entityType: 'membership', entityId: id });
      await securityEvent(db, 'privilege_change', { orgId: a.org.id, userId: a.user.id, ip: a.ip, detail: { membershipId: id, change: 'reactivated' } });
      return { ok: true };
    });
  });

  app.get('/admin/members/:id/sessions', async (req) => {
    const a = need(req, 'sessions:revoke');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const m = await one(db, 'SELECT user_id FROM memberships WHERE id = $1 AND org_id = $2', [id, a.org.id]);
      if (!m) throw notFound();
      return many(
        db,
        `SELECT id, idp, ip::text, user_agent, created_at, last_seen_at, amr FROM sessions
         WHERE user_id = $1 AND active_org_id = $2 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
        [m.user_id, a.org.id],
      );
    });
  });

  app.post('/admin/members/:id/revoke-sessions', async (req) => {
    const a = need(req, 'sessions:revoke');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const m = await one(db, 'SELECT user_id FROM memberships WHERE id = $1 AND org_id = $2', [id, a.org.id]);
      if (!m) throw notFound();
      const n = await revokeOrgSessions(db, a, m.user_id, 'admin_revoked');
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'session.revoked_by_admin', entityType: 'membership', entityId: id, metadata: { count: n } });
      return { revoked: n };
    });
  });

  app.get('/admin/settings', async (req) => {
    const a = need(req, 'settings:manage');
    const o = await orgTx(a, (db) => one(db, 'SELECT * FROM organizations WHERE id = $1', [a.org.id]));
    return { ...o, identityProviders: config.providers.map((p) => ({ id: p.id, name: p.name })), aiProviderAvailable: { anthropic: !!config.ANTHROPIC_API_KEY } };
  });

  app.patch('/admin/settings', async (req) => {
    const a = need(req, 'settings:manage');
    const b = z
      .object({
        name: z.string().min(2).max(120).optional(),
        default_language: z.enum(['pt-PT', 'en']).optional(),
        default_timezone: z.string().refine((t) => Intl.supportedValuesOf('timeZone').includes(t)).optional(),
        default_currency: z.string().regex(/^[A-Z]{3}$/).optional(),
        mfa_required: z.boolean().optional(),
        phishing_resistant_admins: z.boolean().optional(),
        required_idp: z.string().nullable().optional(),
        session_idle_minutes: z.number().int().min(5).max(480).optional(),
        export_alert_threshold: z.number().int().min(1).max(1000).optional(),
        ai_provider: z.enum(['none', 'anthropic']).optional(),
      })
      .strict()
      .parse(req.body);
    if (b.required_idp && !config.providers.some((p) => p.id === b.required_idp)) throw badRequest('unknown_provider');
    if (b.ai_provider === 'anthropic' && !config.ANTHROPIC_API_KEY) throw badRequest('ai_provider_not_configured');
    return orgTx(a, async (db) => {
      const before = await one(db, 'SELECT * FROM organizations WHERE id = $1', [a.org.id]);
      const keys = Object.keys(b) as (keyof typeof b)[];
      if (keys.length) {
        const sets = keys.map((k, i) => `${k} = $${i + 2}`);
        const values: unknown[] = [a.org.id, ...keys.map((k) => b[k])];
        if (b.ai_provider === 'none') sets.push('ai_approved_by = NULL, ai_approved_at = NULL');
        else if (b.ai_provider) {
          // Recording who approved sending data to an AI provider, and when.
          values.push(a.user.id);
          sets.push(`ai_approved_by = $${values.length}, ai_approved_at = now()`);
        }
        await db.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $1`, values);
      }
      const changed = Object.fromEntries(keys.map((k) => [k, { from: before[k], to: b[k] }]));
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'settings.changed', entityType: 'organization', entityId: a.org.id, metadata: changed });
      if (b.mfa_required !== undefined || b.required_idp !== undefined || b.phishing_resistant_admins !== undefined || b.ai_provider !== undefined) {
        await securityEvent(db, 'privilege_change', { orgId: a.org.id, userId: a.user.id, ip: a.ip, detail: { membershipId: 'settings', settings: keys } });
      }
      return one(db, 'SELECT * FROM organizations WHERE id = $1', [a.org.id]);
    });
  });

  app.get('/admin/audit', async (req) => {
    const a = need(req, 'audit:view');
    const q = req.query as Record<string, string>;
    const { limit, offset } = page(q);
    return orgTx(a, (db) =>
      many(
        db,
        `SELECT e.seq, e.at, e.action, e.entity_type, e.entity_id, e.metadata, e.ip::text, u.display_name AS actor
         FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.org_id = $1 AND ($2 = '' OR e.action LIKE $2 || '%') AND ($3 = '' OR e.entity_id = $3)
         ORDER BY e.seq DESC LIMIT $4 OFFSET $5`,
        [a.org.id, q.action ?? '', q.entityId ?? '', limit, offset],
      ),
    );
  });

  app.get('/admin/audit/verify', async (req) => {
    const a = need(req, 'audit:view');
    return orgTx(a, (db) => verifyAuditChain(db, a.org.id));
  });

  app.get('/admin/security/alerts', async (req) => {
    const a = need(req, 'security:monitor');
    return orgTx(a, (db) =>
      many(db, `SELECT * FROM security_alerts WHERE org_id = $1 ORDER BY status = 'open' DESC, created_at DESC LIMIT 100`, [a.org.id]),
    );
  });

  app.get('/admin/security/events', async (req) => {
    const a = need(req, 'security:monitor');
    return orgTx(a, (db) =>
      many(db, `SELECT id, at, kind, user_id, ip::text, detail FROM security_events WHERE org_id = $1 ORDER BY at DESC LIMIT 200`, [a.org.id]),
    );
  });

  app.post('/admin/security/alerts/:id/:action', async (req) => {
    const a = need(req, 'security:monitor');
    const { id, action } = req.params as any;
    if (!['acknowledge', 'close'].includes(action)) throw notFound();
    await orgTx(a, async (db) => {
      const r = await db.query('UPDATE security_alerts SET status = $3, handled_by = $4, handled_at = now() WHERE id = $1 AND org_id = $2', [
        idParam(id),
        a.org.id,
        action === 'close' ? 'closed' : 'acknowledged',
        a.user.id,
      ]);
      if (!r.rowCount) throw notFound();
      await audit(db, actorOf(a), { orgId: a.org.id, action: `security_alert.${action}`, entityType: 'security_alert', entityId: id });
    });
    return { ok: true };
  });
}
