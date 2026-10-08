import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { one, withTx } from '../db/pool.js';
import { isPrivileged, permissionsFor, type Permission, type Role } from '../authz/permissions.js';
import { randomToken, sha256 } from '../util/crypto.js';

export interface SessionRow {
  id: string;
  user_id: string;
  active_org_id: string | null;
  idp: string;
  auth_time: Date;
  amr: string[];
  acr: string | null;
  csrf_token: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  language: 'pt-PT' | 'en';
  timezone: string;
  status: string;
}

export interface MembershipRow {
  id: string;
  org_id: string;
  user_id: string;
  role: Role;
  status: string;
  supplier_id: string | null;
  asset_scope: string[] | null;
}

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  default_language: string;
  default_timezone: string;
  default_currency: string;
  mfa_required: boolean;
  phishing_resistant_admins: boolean;
  required_idp: string | null;
  session_idle_minutes: number;
  ai_provider: string;
  ai_approved_at: Date | null;
}

/** Everything a request handler needs to make authorisation decisions. */
export interface AuthContext {
  session: SessionRow;
  user: UserRow;
  ip: string | null;
  org: OrgRow | null;
  membership: MembershipRow | null;
  /** Why the active workspace cannot be used, if it cannot (e.g. MFA not satisfied). */
  orgBlock: string | null;
  permissions: Set<Permission>;
  /** personnel.id linked to this user in the active organisation (employees). */
  personnelId: string | null;
}

export function hasMfa(session: Pick<SessionRow, 'amr' | 'idp'>) {
  const idp = config.providers.find((p) => p.id === session.idp);
  const accepted = idp?.mfaAmr ?? ['mfa'];
  return session.amr.some((m) => accepted.includes(m));
}

export function hasPhishingResistant(session: Pick<SessionRow, 'amr' | 'idp'>) {
  const idp = config.providers.find((p) => p.id === session.idp);
  const accepted = idp?.phishingResistantAmr ?? ['hwk'];
  return session.amr.some((m) => accepted.includes(m));
}

/** Decides whether a session may use a workspace with a given role. Returns a block code or null. */
export function workspaceBlock(org: OrgRow, membership: MembershipRow | null, session: SessionRow): string | null {
  if (!membership) return 'not_a_member';
  if (membership.status === 'pending_approval') return 'membership_pending';
  if (membership.status !== 'active') return 'membership_suspended';
  if (org.required_idp && org.required_idp !== session.idp) return 'sso_required';
  const privileged = isPrivileged(membership.role, config.privilegedRoles);
  if ((org.mfa_required || privileged) && !hasMfa(session)) return 'mfa_required';
  if (org.phishing_resistant_admins && membership.role === 'org_admin' && !hasPhishingResistant(session)) {
    return 'phishing_resistant_required';
  }
  return null;
}

export async function createSession(
  db: Db,
  p: { userId: string; idp: string; authTime: Date; amr: string[]; acr: string | null; ip: string | null; userAgent: string | null; activeOrgId: string | null },
) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + config.SESSION_ABSOLUTE_HOURS * 3600_000);
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO sessions (token_hash, user_id, active_org_id, idp, auth_time, amr, acr, csrf_token, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [sha256(token), p.userId, p.activeOrgId, p.idp, p.authTime, p.amr, p.acr, csrf, p.ip, p.userAgent?.slice(0, 300) ?? null, expires],
  );
  return { token, sessionId: row!.id, expires };
}

export function setSessionCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(config.cookieName, { path: '/' });
}

/**
 * Loads and validates the session on every request: revocation, absolute and idle expiry,
 * user suspension and membership status are all checked against the database, so
 * administrative changes take effect on the very next request.
 */
export async function loadAuth(req: FastifyRequest): Promise<AuthContext | null> {
  const token = req.cookies?.[config.cookieName];
  if (!token) return null;
  return withTx({}, async (db) => {
    const session = await one<SessionRow>(
      db,
      `SELECT s.* FROM sessions s WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (!session) return null;
    const user = await one<UserRow>(db, 'SELECT id, email, display_name, language, timezone, status FROM users WHERE id = $1', [session.user_id]);
    if (!user || user.status !== 'active') return null;

    let org: OrgRow | null = null;
    let membership: MembershipRow | null = null;
    let orgBlock: string | null = null;
    let personnelId: string | null = null;
    if (session.active_org_id) {
      org = await one<OrgRow>(db, 'SELECT * FROM organizations WHERE id = $1', [session.active_org_id]);
      await db.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
      membership = await one<MembershipRow>(db, 'SELECT * FROM memberships WHERE org_id = $1 AND user_id = $2', [session.active_org_id, user.id]);
      orgBlock = org ? workspaceBlock(org, membership, session) : 'not_a_member';
    }

    const idleMinutes = org?.session_idle_minutes ?? 30;
    if (Date.now() - new Date(session.last_seen_at).getTime() > idleMinutes * 60_000) {
      await db.query("UPDATE sessions SET revoked_at = now(), revoke_reason = 'idle_timeout' WHERE id = $1", [session.id]);
      return null;
    }
    if (Date.now() - new Date(session.last_seen_at).getTime() > 30_000) {
      await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [session.id]);
    }

    if (org && membership && !orgBlock) {
      await db.query("SELECT set_config('app.org_id', $1, true)", [org.id]);
      const p = await one<{ id: string }>(db, 'SELECT id FROM personnel WHERE org_id = $1 AND user_id = $2', [org.id, user.id]);
      personnelId = p?.id ?? null;
    }

    return {
      session,
      user,
      ip: req.ip ?? null,
      org,
      membership,
      orgBlock,
      permissions: org && membership && !orgBlock ? permissionsFor(membership.role) : new Set<Permission>(),
      personnelId,
    };
  });
}

export function isRecentAuth(session: SessionRow) {
  return Date.now() - new Date(session.auth_time).getTime() <= config.STEP_UP_MAX_AGE_SECONDS * 1000;
}
