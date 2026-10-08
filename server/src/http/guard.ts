import type { FastifyRequest } from 'fastify';
import { STEP_UP_ACTIONS, type Permission } from '../authz/permissions.js';
import { isRecentAuth, type AuthContext } from '../auth/session.js';
import { withTx, type Db } from '../db/pool.js';
import type { AuditActor } from '../audit/audit.js';
import { ApiError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export type OrgContext = AuthContext & { org: NonNullable<AuthContext['org']>; membership: NonNullable<AuthContext['membership']> };

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new ApiError(401, 'unauthenticated');
  return req.auth;
}

/** Requires an explicitly selected, usable workspace. */
export function requireOrg(req: FastifyRequest): OrgContext {
  const a = requireAuth(req);
  if (!a.org || !a.membership) throw new ApiError(403, 'workspace_required');
  if (a.orgBlock) throw new ApiError(403, a.orgBlock);
  return a as OrgContext;
}

/**
 * Server-side permission check. Sensitive administrative permissions also require that the
 * user authenticated at the IdP recently (step-up), not merely that the session is valid.
 */
export function need(req: FastifyRequest, ...perms: Permission[]): OrgContext {
  const a = requireOrg(req);
  for (const p of perms) {
    if (!a.permissions.has(p)) throw new ApiError(403, 'forbidden', { permission: p });
    if (STEP_UP_ACTIONS.has(p) && req.method !== 'GET' && !isRecentAuth(a.session)) {
      throw new ApiError(401, 'reauth_required');
    }
  }
  return a;
}

export function can(a: AuthContext, p: Permission) {
  return a.permissions.has(p);
}

export function actorOf(a: AuthContext): AuditActor {
  return { userId: a.user.id, sessionId: a.session.id, ip: a.ip };
}

/** Runs fn in a transaction scoped to the caller's active organisation (RLS context). */
export function orgTx<T>(a: OrgContext, fn: (db: Db) => Promise<T>) {
  return withTx({ orgId: a.org.id, userId: a.user.id }, fn);
}
