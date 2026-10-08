import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, withTx, type Db } from '../db/pool.js';
import { audit, PLATFORM_ORG } from '../audit/audit.js';
import { securityEvent } from '../security/monitor.js';
import { sha256 } from '../util/crypto.js';
import { buildLoginUrl, exchangeCode, getIdp, oidc } from './oidc.js';
import { clearSessionCookie, createSession, setSessionCookie } from './session.js';

/** Only same-site relative paths are accepted as post-login destinations (no open redirects). */
export function safeReturnTo(v: unknown) {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v.slice(0, 500);
}

function fail(code: string) {
  // A single generic code is used for every identity-related refusal so that responses do not
  // reveal whether an address is registered, invited, suspended or unverified.
  return `${config.APP_BASE_URL}/signin?error=${encodeURIComponent(code)}`;
}

export async function authRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get('/auth/providers', async () => config.providers.map((p) => ({ id: p.id, name: p.name })));

  app.get('/auth/login', strict, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const idp = getIdp(q.idp ?? config.providers[0]?.id ?? '');
    if (!idp) return reply.redirect(fail('unknown_provider'));
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const stepUp = q.stepup === '1';
    await withTx({}, (db) =>
      db.query(
        `INSERT INTO idp_login_attempts (state_hash, code_verifier, nonce, idp, return_to, invitation_token, step_up, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '10 minutes')`,
        [sha256(state), codeVerifier, nonce, idp.id, safeReturnTo(q.returnTo), q.invitation?.slice(0, 200) ?? null, stepUp],
      ),
    );
    const url = await buildLoginUrl(idp, { state, nonce, codeVerifier, requireMfa: q.mfa === '1', stepUp });
    return reply.redirect(url);
  });

  app.get('/auth/callback', strict, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const ip = req.ip ?? null;
    if (!q.state) return reply.redirect(fail('access_unavailable'));
    const attempt = await withTx({}, async (db) => {
      const a = await one(db, 'DELETE FROM idp_login_attempts WHERE state_hash = $1 RETURNING *', [sha256(q.state!)]);
      await db.query('DELETE FROM idp_login_attempts WHERE expires_at < now()');
      return a;
    });
    if (!attempt || new Date(attempt.expires_at) < new Date()) {
      await withTx({}, (db) => securityEvent(db, 'login_failed', { ip, detail: { reason: 'invalid_state' } }));
      return reply.redirect(fail('access_unavailable'));
    }
    const idp = getIdp(attempt.idp)!;
    let claims: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      const current = new URL(req.url, config.APP_BASE_URL);
      claims = await exchangeCode(idp, current, { state: q.state, nonce: attempt.nonce, codeVerifier: attempt.code_verifier, stepUp: attempt.step_up });
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'oidc callback failed');
      await withTx({}, (db) => securityEvent(db, 'login_failed', { ip, detail: { reason: 'token_exchange', idp: idp.id } }));
      return reply.redirect(fail('access_unavailable'));
    }

    if (attempt.step_up) return completeStepUp(req, reply, idp.id, claims, attempt.return_to);

    const outcome = await withTx({ orgId: PLATFORM_ORG }, async (db) => {
      const deny = async (reason: string, userId?: string) => {
        await securityEvent(db, 'login_denied', { ip, userId, detail: { reason, idp: idp.id } });
        return { ok: false as const };
      };
      if (!claims.email || !claims.emailVerified) return deny('email_not_verified');

      let user = await one(db, 'SELECT * FROM users WHERE idp = $1 AND idp_subject = $2', [idp.id, claims.sub]);
      let invitation: any = null;
      if (attempt.invitation_token) {
        invitation = await one(
          db,
          `SELECT * FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
          [sha256(attempt.invitation_token)],
        );
        if (!invitation || invitation.email.toLowerCase() !== claims.email) {
          // An existing account following a used or foreign link simply signs in; the link
          // grants nothing. Without an account, the attempt is refused.
          if (!user) return deny('invitation_invalid_or_mismatch');
          await securityEvent(db, 'invitation_ignored', { ip, userId: user.id, detail: { reason: invitation ? 'email_mismatch' : 'invalid_or_used' } });
          invitation = null;
        }
      }
      if (!user && !invitation) return deny('no_account');
      if (user && user.status !== 'active') return deny('user_suspended', user.id);

      if (!user) {
        user = await one(
          db,
          `INSERT INTO users (idp, idp_subject, email, email_verified, display_name) VALUES ($1,$2,$3,true,$4) RETURNING *`,
          [idp.id, claims.sub, claims.email, claims.name ?? claims.email],
        );
      } else {
        await db.query('UPDATE users SET email = $2, email_verified = true, last_login_at = now() WHERE id = $1', [user.id, claims.email]);
      }

      if (invitation) await acceptInvitation(db, invitation, user.id, ip);

      await db.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
      const active = await db.query("SELECT org_id FROM memberships WHERE user_id = $1 AND status = 'active'", [user.id]);
      const activeOrgId = active.rowCount === 1 ? active.rows[0].org_id : null;
      const s = await createSession(db, {
        userId: user.id,
        idp: idp.id,
        authTime: claims.authTime,
        amr: claims.amr,
        acr: claims.acr,
        ip,
        userAgent: req.headers['user-agent'] ?? null,
        activeOrgId,
      });
      await audit(db, { userId: user.id, sessionId: s.sessionId, ip }, {
        orgId: PLATFORM_ORG,
        action: 'auth.sign_in',
        entityType: 'user',
        entityId: user.id,
        metadata: { idp: idp.id, amr: claims.amr },
      });
      return { ok: true as const, ...s };
    });

    if (!outcome.ok) return reply.redirect(fail('access_unavailable'));
    setSessionCookie(reply, outcome.token, outcome.expires);
    return reply.redirect(`${config.APP_BASE_URL}${attempt.return_to}`);
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) {
      await withTx({ orgId: PLATFORM_ORG }, async (db) => {
        await db.query("UPDATE sessions SET revoked_at = now(), revoke_reason = 'sign_out' WHERE id = $1", [req.auth!.session.id]);
        await audit(db, { userId: req.auth!.user.id, sessionId: req.auth!.session.id, ip: req.ip }, {
          orgId: PLATFORM_ORG,
          action: 'auth.sign_out',
          entityType: 'session',
          entityId: req.auth!.session.id,
        });
      });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });
}

async function acceptInvitation(db: Db, inv: any, userId: string, ip: string | null) {
  await db.query('UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [inv.id, userId]);
  await db.query("SELECT set_config('app.org_id', $1, true)", [inv.org_id]);
  const existing = await one(db, 'SELECT id FROM memberships WHERE org_id = $1 AND user_id = $2', [inv.org_id, userId]);
  if (!existing) {
    // Membership is not usable until an administrator approves it.
    await db.query(
      `INSERT INTO memberships (org_id, user_id, role, status, supplier_id, asset_scope, invited_by)
       VALUES ($1,$2,$3,'pending_approval',$4,$5,$6)`,
      [inv.org_id, userId, inv.role, inv.supplier_id, inv.asset_scope, inv.invited_by],
    );
    if (inv.personnel_id) {
      await db.query('UPDATE personnel SET user_id = $1 WHERE id = $2 AND org_id = $3 AND user_id IS NULL', [userId, inv.personnel_id, inv.org_id]);
    }
  }
  await audit(db, { userId, ip }, { orgId: inv.org_id, action: 'membership.invitation_accepted', entityType: 'invitation', entityId: inv.id, metadata: { role: inv.role } });
  await db.query("SELECT set_config('app.org_id', $1, true)", [PLATFORM_ORG]);
}

async function completeStepUp(req: FastifyRequest, reply: any, idpId: string, claims: Awaited<ReturnType<typeof exchangeCode>>, returnTo: string) {
  const current = req.auth;
  const ok = await withTx({ orgId: PLATFORM_ORG }, async (db) => {
    if (!current || current.session.idp !== idpId) return false;
    const user = await one(db, 'SELECT idp_subject FROM users WHERE id = $1', [current.user.id]);
    if (!user || user.idp_subject !== claims.sub) {
      await securityEvent(db, 'login_denied', { ip: req.ip, userId: current.user.id, detail: { reason: 'step_up_subject_mismatch' } });
      return false;
    }
    await db.query('UPDATE sessions SET auth_time = $2, amr = $3, acr = $4 WHERE id = $1', [current.session.id, claims.authTime, claims.amr, claims.acr]);
    await audit(db, { userId: current.user.id, sessionId: current.session.id, ip: req.ip }, {
      orgId: PLATFORM_ORG,
      action: 'auth.step_up',
      entityType: 'session',
      entityId: current.session.id,
      metadata: { amr: claims.amr },
    });
    return true;
  });
  return reply.redirect(ok ? `${config.APP_BASE_URL}${returnTo}` : fail('access_unavailable'));
}

