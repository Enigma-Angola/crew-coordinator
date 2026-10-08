import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, PLATFORM_ORG } from '../audit/audit.js';
import { many, one, withTx } from '../db/pool.js';
import { hasMfa, hasPhishingResistant, isRecentAuth, workspaceBlock } from '../auth/session.js';
import { actorOf, need, orgTx, requireAuth, requireOrg } from '../http/guard.js';
import { ApiError, notFound } from '../http/errors.js';
import { idParam } from './util.js';

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const a = requireAuth(req);
    const memberships = await withTx({ userId: a.user.id }, (db) =>
      many(
        db,
        `SELECT m.org_id, m.role, m.status, o.name, o.slug FROM memberships m JOIN organizations o ON o.id = m.org_id
         WHERE m.user_id = $1 ORDER BY o.name`,
        [a.user.id],
      ),
    );
    return {
      user: { id: a.user.id, email: a.user.email, displayName: a.user.display_name, language: a.user.language, timezone: a.user.timezone },
      session: {
        id: a.session.id,
        idp: a.session.idp,
        mfa: hasMfa(a.session),
        phishingResistant: hasPhishingResistant(a.session),
        recentAuth: isRecentAuth(a.session),
        authTime: a.session.auth_time,
        expiresAt: a.session.expires_at,
      },
      csrfToken: a.session.csrf_token,
      memberships: memberships.map((m) => ({ orgId: m.org_id, orgName: m.name, slug: m.slug, role: m.role, status: m.status })),
      activeOrg: a.org
        ? {
            id: a.org.id,
            name: a.org.name,
            defaultLanguage: a.org.default_language,
            defaultTimezone: a.org.default_timezone,
            defaultCurrency: a.org.default_currency,
            mfaRequired: a.org.mfa_required,
          }
        : null,
      orgBlock: a.orgBlock,
      role: a.orgBlock ? null : a.membership?.role ?? null,
      supplierId: a.orgBlock ? null : a.membership?.supplier_id ?? null,
      personnelId: a.personnelId,
      permissions: [...a.permissions].sort(),
    };
  });

  // Explicit workspace switching. Data from the previous workspace is never mixed in: every
  // subsequent request is evaluated against the newly selected organisation only.
  app.post('/me/workspace', async (req) => {
    const a = requireAuth(req);
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.body);
    return withTx({ userId: a.user.id, orgId }, async (db) => {
      const m = await one(db, 'SELECT * FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, a.user.id]);
      if (!m) throw notFound();
      const org = await one(db, 'SELECT * FROM organizations WHERE id = $1', [orgId]);
      await db.query('UPDATE sessions SET active_org_id = $2 WHERE id = $1', [a.session.id, orgId]);
      await audit(db, actorOf(a), { orgId, action: 'workspace.switched', entityType: 'session', entityId: a.session.id });
      return { orgId, block: workspaceBlock(org, m, a.session) };
    });
  });

  app.patch('/me/preferences', async (req) => {
    const a = requireAuth(req);
    const b = z
      .object({ language: z.enum(['pt-PT', 'en']).optional(), timezone: z.string().refine((t) => TIMEZONES.has(t)).optional() })
      .parse(req.body);
    await withTx({}, (db) =>
      db.query('UPDATE users SET language = coalesce($2, language), timezone = coalesce($3, timezone) WHERE id = $1', [
        a.user.id,
        b.language ?? null,
        b.timezone ?? null,
      ]),
    );
    return { ok: true };
  });

  app.get('/me/sessions', async (req) => {
    const a = requireAuth(req);
    const rows = await withTx({}, (db) =>
      many(
        db,
        `SELECT id, idp, ip::text, user_agent, created_at, last_seen_at, expires_at, amr FROM sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
        [a.user.id],
      ),
    );
    return rows.map((r) => ({ ...r, current: r.id === a.session.id }));
  });

  app.delete('/me/sessions/:id', async (req) => {
    const a = requireAuth(req);
    const id = idParam((req.params as any).id);
    await withTx({ orgId: PLATFORM_ORG }, async (db) => {
      const r = await db.query(
        "UPDATE sessions SET revoked_at = now(), revoked_by = $2, revoke_reason = 'user_revoked' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        [id, a.user.id],
      );
      if (!r.rowCount) throw notFound();
      await audit(db, actorOf(a), { orgId: PLATFORM_ORG, action: 'session.revoked_by_user', entityType: 'session', entityId: id });
    });
    return { ok: true };
  });

  app.get('/me/dashboard-preferences', async (req) => {
    const a = requireOrg(req);
    const r = await orgTx(a, (db) => one(db, 'SELECT dashboard FROM user_preferences WHERE user_id = $1 AND org_id = $2', [a.user.id, a.org.id]));
    return r?.dashboard ?? {};
  });

  // Preferences only change presentation (order, hidden cards, default period). Data is still
  // fetched through the scoped endpoints, so preferences can never widen access.
  app.put('/me/dashboard-preferences', async (req) => {
    const a = requireOrg(req);
    const b = z
      .object({ hidden: z.array(z.string().max(60)).max(50).default([]), order: z.array(z.string().max(60)).max(50).default([]), periodDays: z.number().int().min(7).max(365).optional() })
      .parse(req.body);
    await orgTx(a, (db) =>
      db.query(
        `INSERT INTO user_preferences (user_id, org_id, dashboard) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, org_id) DO UPDATE SET dashboard = EXCLUDED.dashboard`,
        [a.user.id, a.org.id, b],
      ),
    );
    return b;
  });

  app.get('/me/saved-filters', async (req) => {
    const a = requireOrg(req);
    const view = String((req.query as any).view ?? '');
    return orgTx(a, (db) =>
      many(db, 'SELECT id, view, name, filter FROM saved_filters WHERE user_id = $1 AND org_id = $2 AND ($3 = \'\' OR view = $3) ORDER BY name', [
        a.user.id,
        a.org.id,
        view,
      ]),
    );
  });

  app.post('/me/saved-filters', async (req) => {
    const a = requireOrg(req);
    const b = z
      .object({ view: z.string().max(40), name: z.string().min(1).max(80), filter: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])) })
      .parse(req.body);
    return orgTx(a, (db) =>
      one(db, 'INSERT INTO saved_filters (org_id, user_id, view, name, filter) VALUES ($1,$2,$3,$4,$5) RETURNING id, view, name, filter', [
        a.org.id,
        a.user.id,
        b.view,
        b.name,
        b.filter,
      ]),
    );
  });

  app.delete('/me/saved-filters/:id', async (req) => {
    const a = requireOrg(req);
    const id = idParam((req.params as any).id);
    await orgTx(a, (db) => db.query('DELETE FROM saved_filters WHERE id = $1 AND user_id = $2', [id, a.user.id]));
    return { ok: true };
  });

  app.get('/notifications', async (req) => {
    const a = requireOrg(req);
    return orgTx(a, (db) =>
      many(
        db,
        `SELECT id, code, params, entity_type, entity_id, read_at, created_at FROM notifications
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [a.user.id],
      ),
    );
  });

  app.post('/notifications/:id/read', async (req) => {
    const a = requireOrg(req);
    const id = idParam((req.params as any).id);
    await orgTx(a, (db) => db.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2', [id, a.user.id]));
    return { ok: true };
  });

  // Lightweight directory for assignment and @mentions: active members of this workspace only.
  app.get('/directory', async (req) => {
    const a = need(req, 'task:view');
    if (a.membership.role === 'employee') throw new ApiError(403, 'forbidden');
    return orgTx(a, (db) =>
      many(
        db,
        `SELECT u.id, u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = $1 AND m.status = 'active' AND m.role NOT IN ('supplier') ORDER BY u.display_name`,
        [a.org.id],
      ),
    );
  });
}
