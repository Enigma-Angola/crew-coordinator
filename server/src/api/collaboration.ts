import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { many, one, type Db } from '../db/pool.js';
import { actorOf, can, need, orgTx, requireOrg, type OrgContext } from '../http/guard.js';
import { ApiError, notFound } from '../http/errors.js';
import { Params, taskScope } from '../authz/scope.js';
import { permissionsFor, type Permission, type Role } from '../authz/permissions.js';
import { emitChange } from '../realtime/events.js';
import { refreshInsights } from '../domain/insights.js';
import { loadCrewChange, loadRequest } from './operations.js';
import { loadPersonnel } from './personnel.js';
import { idParam, patchVersioned } from './util.js';

const ENTITY_TYPES = ['crew_change', 'request', 'task', 'personnel', 'package'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];
const VIEW_PERM: Record<EntityType, Permission> = {
  crew_change: 'crew_change:view',
  request: 'request:view',
  task: 'task:view',
  personnel: 'personnel:view',
  package: 'email:view',
};

export async function loadTask(db: Db, a: OrgContext, id: string) {
  const p = new Params();
  const idP = p.add(id);
  const t = await one(db, `SELECT t.* FROM tasks t WHERE t.id = ${idP} AND ${taskScope(a, p)}`, p.values);
  if (!t) throw notFound();
  return t;
}

/** Confirms the caller can see an entity before showing or adding comments and activity. */
export async function assertEntityAccess(db: Db, a: OrgContext, type: EntityType, id: string) {
  if (!can(a, VIEW_PERM[type])) throw notFound();
  if (type === 'crew_change') return loadCrewChange(db, a, id);
  if (type === 'request') return loadRequest(db, a, id);
  if (type === 'task') return loadTask(db, a, id);
  if (type === 'personnel') return loadPersonnel(db, a, id);
  const pkg = await one(db, 'SELECT * FROM email_packages WHERE id = $1 AND org_id = $2', [id, a.org.id]);
  if (!pkg) throw notFound();
  return pkg;
}

/** Asset an entity belongs to, used to check that a mentioned colleague is in scope. */
async function entityAsset(db: Db, type: EntityType, entity: any): Promise<string | null> {
  if (type === 'crew_change') return entity.asset_id;
  const ccId = type === 'request' || type === 'task' || type === 'package' ? entity.crew_change_id : null;
  if (!ccId) return null;
  return (await one(db, 'SELECT asset_id FROM crew_changes WHERE id = $1', [ccId]))?.asset_id ?? null;
}

export async function notify(db: Db, orgId: string, userId: string, code: string, params: Record<string, unknown>, entity?: { type: string; id: string }) {
  await db.query('INSERT INTO notifications (org_id, user_id, code, params, entity_type, entity_id) VALUES ($1,$2,$3,$4,$5,$6)', [
    orgId,
    userId,
    code,
    params,
    entity?.type ?? null,
    entity?.id ?? null,
  ]);
}

const MENTION_RE = /@\[([^\]]{1,80})\]\(user:([0-9a-f-]{36})\)/g;

const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullish(),
  kind: z.enum(['general', 'onboarding', 'verification', 'document_request', 'mobilisation']).default('general'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  assigneeId: z.string().uuid().nullish(),
  dueAt: z.string().datetime({ offset: true }).nullish(),
  personnelId: z.string().uuid().nullish(),
  crewChangeId: z.string().uuid().nullish(),
  requestId: z.string().uuid().nullish(),
});

async function assertAssignable(db: Db, a: OrgContext, userId: string) {
  const m = await one(db, "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'", [a.org.id, userId]);
  if (!m || m.role === 'supplier') throw new ApiError(400, 'invalid_assignee');
}

export async function collaborationRoutes(app: FastifyInstance) {
  app.get('/tasks', async (req) => {
    const a = need(req, 'task:view');
    const q = req.query as Record<string, string>;
    return orgTx(a, async (db) => {
      const p = new Params();
      const conds = [taskScope(a, p)];
      if (q.assigneeId) conds.push(q.assigneeId === 'me' ? `t.assignee_id = ${p.add(a.user.id)}` : `t.assignee_id = ${p.add(idParam(q.assigneeId))}`);
      if (q.status) conds.push(`t.status = ANY(${p.add(q.status.split(','))})`);
      else conds.push("t.status <> 'cancelled'");
      if (q.kind) conds.push(`t.kind = ANY(${p.add(q.kind.split(','))})`);
      if (q.crewChangeId) conds.push(`t.crew_change_id = ${p.add(idParam(q.crewChangeId))}`);
      if (q.dueBefore) conds.push(`t.due_at < ${p.add(q.dueBefore)}`);
      return many(
        db,
        `SELECT t.*, u.display_name AS assignee_name, pe.full_name AS personnel_name, cc.reference AS crew_change_reference,
                (SELECT count(*)::int FROM comments c WHERE c.entity_type = 'task' AND c.entity_id = t.id) AS comment_count
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN personnel pe ON pe.id = t.personnel_id
         LEFT JOIN crew_changes cc ON cc.id = t.crew_change_id
         WHERE ${conds.join(' AND ')} ORDER BY t.due_at NULLS LAST, t.created_at LIMIT 500`,
        p.values,
      );
    });
  });

  app.post('/tasks', async (req) => {
    const a = need(req, 'task:edit');
    const b = taskSchema.parse(req.body);
    return orgTx(a, async (db) => {
      if (b.assigneeId) await assertAssignable(db, a, b.assigneeId);
      if (b.personnelId) await loadPersonnel(db, a, b.personnelId);
      if (b.crewChangeId) await loadCrewChange(db, a, b.crewChangeId);
      if (b.requestId) await loadRequest(db, a, b.requestId);
      const t = await one(
        db,
        `INSERT INTO tasks (org_id, title, description, kind, priority, assignee_id, due_at, personnel_id, crew_change_id, request_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
        [a.org.id, b.title, b.description ?? null, b.kind, b.priority, b.assigneeId ?? null, b.dueAt ?? null, b.personnelId ?? null, b.crewChangeId ?? null, b.requestId ?? null, a.user.id],
      );
      if (b.assigneeId && b.assigneeId !== a.user.id) await notify(db, a.org.id, b.assigneeId, 'task_assigned', { title: b.title, by: a.user.display_name }, { type: 'task', id: t.id });
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'task.created', entityType: 'task', entityId: t.id });
      await refreshInsights(db, a.org.id);
      await emitChange(db, a.org.id, 'task', t.id, t.version, a.user.id);
      return t;
    });
  });

  app.patch('/tasks/:id', async (req) => {
    const a = need(req, 'task:view');
    const id = idParam((req.params as any).id);
    const b = z
      .object({
        version: z.number().int(),
        changes: z
          .object({
            title: z.string().trim().min(1).max(200).optional(),
            description: z.string().max(4000).nullable().optional(),
            status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
            priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
            assignee_id: z.string().uuid().nullable().optional(),
            due_at: z.string().datetime({ offset: true }).nullable().optional(),
          })
          .strict(),
        base: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const t = await loadTask(db, a, id);
      // Assignees without task:edit (e.g. employees) may only move their own task's status.
      if (!can(a, 'task:edit')) {
        if (t.assignee_id !== a.user.id || Object.keys(b.changes).some((k) => k !== 'status') || b.changes.status === 'cancelled') throw new ApiError(403, 'forbidden');
      }
      if (b.changes.assignee_id) await assertAssignable(db, a, b.changes.assignee_id);
      const r = await patchVersioned(db, { table: 'tasks', id, orgId: a.org.id, version: b.version, changes: b.changes, base: b.base, allowed: ['title', 'description', 'status', 'priority', 'assignee_id', 'due_at'], actorId: a.user.id });
      if (b.changes.status === 'done') await db.query('UPDATE tasks SET completed_at = now() WHERE id = $1', [id]);
      if (b.changes.assignee_id && b.changes.assignee_id !== t.assignee_id && b.changes.assignee_id !== a.user.id) {
        await notify(db, a.org.id, b.changes.assignee_id, 'task_assigned', { title: r.after.title, by: a.user.display_name }, { type: 'task', id });
      }
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'task.updated', entityType: 'task', entityId: id, metadata: { fields: r.changedFields, merged: r.merged } });
      await refreshInsights(db, a.org.id);
      await emitChange(db, a.org.id, 'task', id, r.after.version, a.user.id);
      return { record: r.after, merged: r.merged };
    });
  });

  app.get('/comments', async (req) => {
    const a = requireOrg(req);
    const q = z.object({ entityType: z.enum(ENTITY_TYPES), entityId: z.string().uuid() }).parse(req.query);
    return orgTx(a, async (db) => {
      await assertEntityAccess(db, a, q.entityType, q.entityId);
      return many(
        db,
        `SELECT c.id, c.body, c.mentions, c.created_at, c.author_id, u.display_name AS author FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.entity_type = $1 AND c.entity_id = $2 ORDER BY c.created_at`,
        [q.entityType, q.entityId],
      );
    });
  });

  app.post('/comments', async (req) => {
    const a = requireOrg(req);
    const b = z.object({ entityType: z.enum(ENTITY_TYPES), entityId: z.string().uuid(), body: z.string().trim().min(1).max(5000) }).parse(req.body);
    if (a.membership.role === 'supplier') throw new ApiError(403, 'forbidden');
    return orgTx(a, async (db) => {
      const entity = await assertEntityAccess(db, a, b.entityType, b.entityId);
      const assetId = await entityAsset(db, b.entityType, entity);
      const mentioned = [...new Set([...b.body.matchAll(MENTION_RE)].map((m) => m[2]))];
      const valid: string[] = [];
      for (const uid of mentioned) {
        // Mentions only notify colleagues who are themselves allowed to see the record, so a
        // mention can never be used to push restricted information to someone.
        const m = await one(db, "SELECT role, asset_scope FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'", [a.org.id, uid]);
        if (!m || ['supplier', 'employee'].includes(m.role)) continue;
        if (!permissionsFor(m.role as Role).has(VIEW_PERM[b.entityType])) continue;
        if (b.entityType === 'personnel' && !permissionsFor(m.role as Role).has('personnel:view')) continue;
        if (m.asset_scope?.length && assetId && !m.asset_scope.includes(assetId)) continue;
        valid.push(uid);
      }
      const c = await one(
        db,
        'INSERT INTO comments (org_id, entity_type, entity_id, author_id, body, mentions) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [a.org.id, b.entityType, b.entityId, a.user.id, b.body, valid],
      );
      for (const uid of valid) {
        if (uid !== a.user.id) await notify(db, a.org.id, uid, 'mentioned', { by: a.user.display_name, entityType: b.entityType }, { type: b.entityType, id: b.entityId });
      }
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'comment.created', entityType: b.entityType, entityId: b.entityId, metadata: { mentions: valid.length, droppedMentions: mentioned.length - valid.length } });
      await emitChange(db, a.org.id, b.entityType, b.entityId, null, a.user.id);
      return { ...c, droppedMentions: mentioned.filter((m) => !valid.includes(m)) };
    });
  });

  // Activity timeline: who created, changed, approved or cancelled the record and when.
  app.get('/activity', async (req) => {
    const a = requireOrg(req);
    const q = z.object({ entityType: z.enum(ENTITY_TYPES), entityId: z.string().uuid() }).parse(req.query);
    if (a.membership.role === 'supplier') throw new ApiError(403, 'forbidden');
    return orgTx(a, async (db) => {
      await assertEntityAccess(db, a, q.entityType, q.entityId);
      const auditRows = await many(
        db,
        `SELECT e.at, e.action, e.metadata, u.display_name AS actor FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.org_id = $1 AND e.entity_type = $2 AND e.entity_id = $3 AND e.action NOT LIKE '%restricted_viewed' ORDER BY e.seq`,
        [a.org.id, q.entityType, q.entityId],
      );
      const comments = await many(
        db,
        `SELECT c.created_at AS at, c.body, u.display_name AS actor FROM comments c JOIN users u ON u.id = c.author_id WHERE c.entity_type = $1 AND c.entity_id = $2`,
        [q.entityType, q.entityId],
      );
      return [
        ...auditRows.map((r) => ({ kind: 'event', at: r.at, action: r.action, actor: r.actor, fields: r.metadata?.fields ?? null })),
        ...comments.map((c) => ({ kind: 'comment', at: c.at, actor: c.actor, body: c.body })),
      ].sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
    });
  });
}
