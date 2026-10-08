import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { many, one, type Db } from '../db/pool.js';
import { actorOf, can, need, orgTx, type OrgContext } from '../http/guard.js';
import { ApiError, badRequest, notFound } from '../http/errors.js';
import { assetScope, crewChangeScope, Params, personnelScope, requestScope, SUPPLIER_PERSONNEL_FIELDS } from '../authz/scope.js';
import { emitChange } from '../realtime/events.js';
import { isReady, readinessFor } from '../domain/readiness.js';
import { DETAIL_SCHEMAS, normaliseTimes, REQUEST_TYPES, STATUS_FLOW, type RequestType } from '../domain/requests.js';
import { refreshInsights } from '../domain/insights.js';
import { idParam, page, patchVersioned } from './util.js';

/* Loaders that enforce record scope ------------------------------------------------------ */

export async function loadCrewChange(db: Db, a: OrgContext, id: string, lock = false) {
  const p = new Params();
  const idP = p.add(id);
  const row = await one(
    db,
    `SELECT cc.*, s.name AS asset_name, s.code AS asset_code, s.timezone AS asset_timezone
     FROM crew_changes cc JOIN assets s ON s.id = cc.asset_id WHERE cc.id = ${idP} AND ${crewChangeScope(a, p)}${lock ? ' FOR UPDATE OF cc' : ''}`,
    p.values,
  );
  if (!row) throw notFound();
  return row;
}

export async function loadRequest(db: Db, a: OrgContext, id: string, lock = false) {
  const p = new Params();
  const idP = p.add(id);
  const row = await one(db, `SELECT r.* FROM service_requests r WHERE r.id = ${idP} AND ${requestScope(a, p)}${lock ? ' FOR UPDATE' : ''}`, p.values);
  if (!row) throw notFound();
  return row;
}

/** Shapes a request for the viewer; suppliers see only the passenger fields their request type needs and never internal costs of other suppliers. */
export function presentRequest(a: OrgContext, r: any, person?: any) {
  const base = { ...r };
  if (!can(a, 'costs:view') && a.membership.role !== 'supplier') {
    delete base.cost_amount;
    delete base.cost_currency;
  }
  if (person) {
    if (a.membership.role === 'supplier') {
      const allowed = SUPPLIER_PERSONNEL_FIELDS[r.type] ?? ['full_name'];
      base.person = Object.fromEntries(allowed.map((f) => [f, person[f] ?? null]));
    } else base.person = { id: person.id, full_name: person.full_name, employee_no: person.employee_no };
  }
  return base;
}

async function nextReference(db: Db, orgId: string, prefix: string, table: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${table}:${orgId}`]);
  const year = new Date().getUTCFullYear();
  const r = await one(db, `SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1 AND reference LIKE $2`, [orgId, `${prefix}-${year}-%`]);
  return `${prefix}-${year}-${String((r?.n ?? 0) + 1).padStart(4, '0')}`;
}

export async function addRequestEvent(db: Db, orgId: string, requestId: string, stage: string, actorId: string | null, extra: { packageId?: string; messageId?: string; detail?: any } = {}) {
  await db.query('INSERT INTO request_events (org_id, request_id, stage, actor_id, package_id, message_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    orgId,
    requestId,
    stage,
    actorId,
    extra.packageId ?? null,
    extra.messageId ?? null,
    extra.detail ?? {},
  ]);
}

const requestCreate = z.object({
  crewChangeId: z.string().uuid().nullish(),
  personnelId: z.string().uuid(),
  supplierId: z.string().uuid().nullish(),
  type: z.enum(REQUEST_TYPES as [RequestType, ...RequestType[]]),
  details: z.record(z.string(), z.unknown()).default({}),
  locationTz: z.string().default('Africa/Luanda'),
  responseDueAt: z.string().datetime({ offset: true }).nullish(),
});

export async function createRequest(db: Db, a: OrgContext, input: z.infer<typeof requestCreate>) {
  const details = DETAIL_SCHEMAS[input.type].strict().parse(input.details);
  if (!Intl.supportedValuesOf('timeZone').includes(input.locationTz)) throw badRequest('invalid_timezone');
  await loadPersonnelForWrite(db, a, input.personnelId);
  if (input.crewChangeId) await loadCrewChange(db, a, input.crewChangeId);
  if (input.supplierId && !(await one(db, 'SELECT id FROM suppliers WHERE id = $1 AND org_id = $2', [input.supplierId, a.org.id]))) throw notFound();
  const times = normaliseTimes(input.type, details, input.locationTz);
  const reference = await nextReference(db, a.org.id, 'REQ', 'service_requests');
  const row = await one(
    db,
    `INSERT INTO service_requests (org_id, reference, crew_change_id, personnel_id, supplier_id, type, details, location_tz, starts_at, ends_at,
       response_due_at, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [a.org.id, reference, input.crewChangeId ?? null, input.personnelId, input.supplierId ?? null, input.type, details, input.locationTz, times.starts_at, times.ends_at, input.responseDueAt ?? null, a.user.id],
  );
  await addRequestEvent(db, a.org.id, row.id, 'draft_prepared', a.user.id);
  await audit(db, actorOf(a), { orgId: a.org.id, action: 'request.created', entityType: 'request', entityId: row.id, metadata: { type: input.type, reference } });
  return row;
}

async function loadPersonnelForWrite(db: Db, a: OrgContext, id: string) {
  const p = new Params();
  const idP = p.add(id);
  const row = await one(db, `SELECT p.id, p.full_name, p.employee_no FROM personnel p WHERE p.id = ${idP} AND ${personnelScope(a, p)}`, p.values);
  if (!row) throw notFound();
  return row;
}

export async function operationsRoutes(app: FastifyInstance) {
  /* Assets, positions, rotation ---------------------------------------------------------- */

  app.get('/assets', async (req) => {
    const a = need(req, 'crew_change:view');
    return orgTx(a, async (db) => {
      const p = new Params();
      const assets = await many(db, `SELECT a.* FROM assets a WHERE ${assetScope(a, p)} ORDER BY a.code`, p.values);
      const positions = await many(db, 'SELECT * FROM positions WHERE org_id = $1 AND asset_id = ANY($2::uuid[]) ORDER BY title', [a.org.id, assets.map((x) => x.id)]);
      return assets.map((x) => ({ ...x, positions: positions.filter((pos) => pos.asset_id === x.id) }));
    });
  });

  app.get('/rotation', async (req) => {
    const a = need(req, 'crew_change:view');
    const q = req.query as Record<string, string>;
    const from = z.string().date().parse(q.from);
    const to = z.string().date().parse(q.to);
    return orgTx(a, async (db) => {
      const p = new Params();
      const conds = [assetScope(a, p, 's')];
      if (q.assetId) conds.push(`s.id = ${p.add(idParam(q.assetId))}`);
      if (a.membership.role === 'employee') conds.push(a.personnelId ? `x.personnel_id = ${p.add(a.personnelId)}` : 'false');
      const rows = await many(
        db,
        `SELECT x.id, x.personnel_id, pe.full_name, pe.employee_no, x.asset_id, s.code AS asset_code, s.name AS asset_name,
                x.position_id, pos.title AS position_title, x.starts_on, x.ends_on, x.status, x.crew_change_on_id, x.crew_change_off_id
         FROM assignments x JOIN assets s ON s.id = x.asset_id LEFT JOIN personnel pe ON pe.id = x.personnel_id
         LEFT JOIN positions pos ON pos.id = x.position_id
         WHERE ${conds.join(' AND ')} AND x.status <> 'cancelled' AND x.starts_on <= ${p.add(to)} AND x.ends_on >= ${p.add(from)}
         ORDER BY s.code, pos.title NULLS LAST, x.starts_on`,
        p.values,
      );
      return { from, to, rows };
    });
  });

  app.post('/assignments', async (req) => {
    const a = need(req, 'crew_change:edit');
    const b = z
      .object({ personnelId: z.string().uuid().nullable(), assetId: z.string().uuid(), positionId: z.string().uuid().nullish(), startsOn: z.string().date(), endsOn: z.string().date() })
      .parse(req.body);
    if (b.endsOn < b.startsOn) throw badRequest('end_before_start');
    return orgTx(a, async (db) => {
      const p = new Params();
      if (!(await one(db, `SELECT a.id FROM assets a WHERE a.id = ${p.add(b.assetId)} AND ${assetScope(a, p)}`, p.values))) throw notFound();
      if (b.personnelId) await loadPersonnelForWrite(db, a, b.personnelId);
      if (b.personnelId) {
        const overlap = await one(
          db,
          `SELECT id FROM assignments WHERE personnel_id = $1 AND status <> 'cancelled' AND starts_on <= $3 AND ends_on >= $2`,
          [b.personnelId, b.startsOn, b.endsOn],
        );
        if (overlap) throw new ApiError(409, 'assignment_overlap', { assignmentId: overlap.id });
      }
      const row = await one(
        db,
        'INSERT INTO assignments (org_id, personnel_id, asset_id, position_id, starts_on, ends_on, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *',
        [a.org.id, b.personnelId, b.assetId, b.positionId ?? null, b.startsOn, b.endsOn, a.user.id],
      );
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'assignment.created', entityType: 'assignment', entityId: row.id });
      await refreshInsights(db, a.org.id);
      await emitChange(db, a.org.id, 'assignment', row.id, row.version, a.user.id);
      return row;
    });
  });

  app.patch('/assignments/:id', async (req) => {
    const a = need(req, 'crew_change:edit');
    const id = idParam((req.params as any).id);
    const b = z.object({ version: z.number().int(), changes: z.object({ personnel_id: z.string().uuid().nullable().optional(), starts_on: z.string().date().optional(), ends_on: z.string().date().optional(), status: z.enum(['planned', 'confirmed', 'in_progress', 'completed', 'cancelled']).optional() }).strict(), base: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    return orgTx(a, async (db) => {
      const x = await one(db, 'SELECT * FROM assignments WHERE id = $1 AND org_id = $2', [id, a.org.id]);
      if (!x) throw notFound();
      const p = new Params();
      if (!(await one(db, `SELECT a.id FROM assets a WHERE a.id = ${p.add(x.asset_id)} AND ${assetScope(a, p)}`, p.values))) throw notFound();
      if (b.changes.personnel_id) await loadPersonnelForWrite(db, a, b.changes.personnel_id);
      const r = await patchVersioned(db, { table: 'assignments', id, orgId: a.org.id, version: b.version, changes: b.changes, base: b.base, allowed: ['personnel_id', 'starts_on', 'ends_on', 'status'], actorId: a.user.id });
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'assignment.updated', entityType: 'assignment', entityId: id, metadata: { fields: r.changedFields } });
      await refreshInsights(db, a.org.id);
      await emitChange(db, a.org.id, 'assignment', id, r.after.version, a.user.id);
      return { record: r.after, merged: r.merged };
    });
  });

  /* Crew changes -------------------------------------------------------------------------- */

  app.get('/crew-changes', async (req) => {
    const a = need(req, 'crew_change:view');
    const q = req.query as Record<string, string>;
    const { limit, offset } = page(q);
    return orgTx(a, async (db) => {
      const p = new Params();
      const conds = [crewChangeScope(a, p)];
      if (q.status) conds.push(`cc.status = ANY(${p.add(q.status.split(','))})`);
      if (q.from) conds.push(`cc.scheduled_on >= ${p.add(z.string().date().parse(q.from))}`);
      if (q.to) conds.push(`cc.scheduled_on <= ${p.add(z.string().date().parse(q.to))}`);
      if (q.assetId) conds.push(`cc.asset_id = ${p.add(idParam(q.assetId))}`);
      return many(
        db,
        `SELECT cc.id, cc.reference, cc.asset_id, s.name AS asset_name, s.code AS asset_code, cc.scheduled_on, cc.embarkation_point, cc.embarkation_at,
                cc.status, cc.version, cc.updated_at,
                (SELECT count(*)::int FROM crew_change_people x WHERE x.crew_change_id = cc.id) AS people,
                (SELECT count(*)::int FROM service_requests r WHERE r.crew_change_id = cc.id AND r.status NOT IN ('cancelled')) AS requests,
                (SELECT count(*)::int FROM service_requests r WHERE r.crew_change_id = cc.id AND r.status IN ('confirmed', 'completed')) AS confirmed,
                (SELECT count(*)::int FROM insights i WHERE i.crew_change_id = cc.id AND i.status = 'open' AND i.severity <> 'info') AS open_issues
         FROM crew_changes cc JOIN assets s ON s.id = cc.asset_id WHERE ${conds.join(' AND ')}
         ORDER BY cc.scheduled_on LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
        p.values,
      );
    });
  });

  app.get('/crew-changes/:id', async (req) => {
    const a = need(req, 'crew_change:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const cc = await loadCrewChange(db, a, id);
      const pp = new Params();
      const people = await many(
        db,
        `SELECT x.id, x.direction, x.personnel_id, p.full_name, p.employee_no, p.job_title, x.assignment_id, asg.starts_on, asg.ends_on, pos.requirement_ids
         FROM crew_change_people x JOIN personnel p ON p.id = x.personnel_id
         LEFT JOIN assignments asg ON asg.id = x.assignment_id LEFT JOIN positions pos ON pos.id = asg.position_id
         WHERE x.crew_change_id = ${pp.add(id)} AND ${personnelScope(a, pp)} ORDER BY x.direction DESC, p.full_name`,
        pp.values,
      );
      const rp = new Params();
      const requests = await many(
        db,
        `SELECT r.*, s.name AS supplier_name FROM service_requests r LEFT JOIN suppliers s ON s.id = r.supplier_id
         WHERE r.crew_change_id = ${rp.add(id)} AND ${requestScope(a, rp)} ORDER BY r.starts_at NULLS LAST`,
        rp.values,
      );
      const readiness = await readinessFor(
        db,
        a.org.id,
        people
          .filter((x) => x.direction === 'on')
          .map((x) => ({ personnelId: x.personnel_id, from: x.starts_on ?? cc.scheduled_on, to: x.ends_on ?? cc.scheduled_on, requirementIds: x.requirement_ids ?? [] })),
      );
      const insights = await many(db, `SELECT * FROM insights WHERE crew_change_id = $1 AND status <> 'resolved' ORDER BY severity DESC, detected_at DESC`, [id]);
      const packages = can(a, 'email:view')
        ? await many(
            db,
            `SELECT p.id, p.reference, p.status, p.purpose, p.subject, p.supplier_id, s.name AS supplier_name, p.submitted_at, p.response_due_at, p.created_at
             FROM email_packages p JOIN suppliers s ON s.id = p.supplier_id WHERE p.crew_change_id = $1 ORDER BY p.created_at DESC`,
            [id],
          )
        : [];
      const tasks = can(a, 'task:view')
        ? await many(db, `SELECT t.id, t.title, t.status, t.due_at, t.assignee_id, t.priority FROM tasks t WHERE t.crew_change_id = $1 AND t.status <> 'cancelled' ORDER BY t.due_at NULLS LAST`, [id])
        : [];
      const visible = new Set(people.map((x) => x.personnel_id));
      return {
        ...cc,
        people: people.map((x) => {
          const cells = readiness.get(`${x.personnel_id}:${x.starts_on ?? cc.scheduled_on}`) ?? null;
          return { ...x, readiness: cells, ready: x.direction === 'on' ? (cells ? isReady(cells) : null) : null };
        }),
        requests: requests.filter((r) => visible.has(r.personnel_id)).map((r) => presentRequest(a, r)),
        insights,
        packages,
        tasks,
      };
    });
  });

  app.post('/crew-changes', async (req) => {
    const a = need(req, 'crew_change:edit');
    const b = z
      .object({ assetId: z.string().uuid(), scheduledOn: z.string().date(), embarkationPoint: z.string().max(160).nullish(), embarkationAt: z.string().datetime({ offset: true }).nullish(), notes: z.string().max(4000).nullish() })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const p = new Params();
      if (!(await one(db, `SELECT a.id FROM assets a WHERE a.id = ${p.add(b.assetId)} AND ${assetScope(a, p)}`, p.values))) throw notFound();
      const reference = await nextReference(db, a.org.id, 'CC', 'crew_changes');
      const row = await one(
        db,
        `INSERT INTO crew_changes (org_id, reference, asset_id, scheduled_on, embarkation_point, embarkation_at, notes, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'planning',$8,$8) RETURNING *`,
        [a.org.id, reference, b.assetId, b.scheduledOn, b.embarkationPoint ?? null, b.embarkationAt ?? null, b.notes ?? null, a.user.id],
      );
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'crew_change.created', entityType: 'crew_change', entityId: row.id, metadata: { reference } });
      await emitChange(db, a.org.id, 'crew_change', row.id, row.version, a.user.id);
      return row;
    });
  });

  app.patch('/crew-changes/:id', async (req) => {
    const a = need(req, 'crew_change:edit');
    const id = idParam((req.params as any).id);
    const b = z
      .object({
        version: z.number().int(),
        changes: z.object({ scheduled_on: z.string().date().optional(), embarkation_point: z.string().max(160).nullable().optional(), embarkation_at: z.string().datetime({ offset: true }).nullable().optional(), notes: z.string().max(4000).nullable().optional() }).strict(),
        base: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const cc = await loadCrewChange(db, a, id);
      if (['completed', 'cancelled'].includes(cc.status)) throw new ApiError(409, 'invalid_state');
      const r = await patchVersioned(db, { table: 'crew_changes', id, orgId: a.org.id, version: b.version, changes: b.changes, base: b.base, allowed: ['scheduled_on', 'embarkation_point', 'embarkation_at', 'notes'], actorId: a.user.id });
      // A schedule change after approval sends the crew change back for re-approval.
      if (cc.status === 'approved' && r.changedFields.some((f) => ['scheduled_on', 'embarkation_at'].includes(f))) {
        await db.query("UPDATE crew_changes SET status = 'approval_pending', approved_by = NULL, approved_at = NULL, submitted_by = $2 WHERE id = $1", [id, a.user.id]);
      }
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'crew_change.updated', entityType: 'crew_change', entityId: id, metadata: { fields: r.changedFields, merged: r.merged } });
      await refreshInsights(db, a.org.id);
      await emitChange(db, a.org.id, 'crew_change', id, r.after.version, a.user.id);
      return { record: await loadCrewChange(db, a, id), merged: r.merged };
    });
  });

  app.post('/crew-changes/:id/people', async (req) => {
    const a = need(req, 'crew_change:edit');
    const id = idParam((req.params as any).id);
    const b = z.object({ personnelId: z.string().uuid(), direction: z.enum(['on', 'off']), assignmentId: z.string().uuid().nullish() }).parse(req.body);
    return orgTx(a, async (db) => {
      const cc = await loadCrewChange(db, a, id);
      if (['completed', 'cancelled'].includes(cc.status)) throw new ApiError(409, 'invalid_state');
      await loadPersonnelForWrite(db, a, b.personnelId);
      let assignmentId = b.assignmentId ?? null;
      if (!assignmentId && b.direction === 'on') {
        const asg = await one(db, `SELECT id FROM assignments WHERE personnel_id = $1 AND asset_id = $2 AND status <> 'cancelled' AND starts_on <= $3::date + 3 AND ends_on >= $3::date ORDER BY starts_on LIMIT 1`, [
          b.personnelId,
          cc.asset_id,
          cc.scheduled_on,
        ]);
        assignmentId = asg?.id ?? null;
      }
      const row = await one(
        db,
        `INSERT INTO crew_change_people (org_id, crew_change_id, personnel_id, direction, assignment_id) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (crew_change_id, personnel_id, direction) DO NOTHING RETURNING *`,
        [a.org.id, id, b.personnelId, b.direction, assignmentId],
      );
      if (!row) throw new ApiError(409, 'already_added');
      await db.query('UPDATE crew_changes SET version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1', [id, a.user.id]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'crew_change.person_added', entityType: 'crew_change', entityId: id, metadata: { personnelId: b.personnelId, direction: b.direction } });
      await refreshInsights(db, a.org.id);
      await emitChange(db, a.org.id, 'crew_change', id, null, a.user.id);
      return row;
    });
  });

  app.delete('/crew-changes/:id/people/:pid', async (req) => {
    const a = need(req, 'crew_change:edit');
    const id = idParam((req.params as any).id);
    const pid = idParam((req.params as any).pid);
    return orgTx(a, async (db) => {
      await loadCrewChange(db, a, id);
      const r = await db.query('DELETE FROM crew_change_people WHERE id = $1 AND crew_change_id = $2', [pid, id]);
      if (!r.rowCount) throw notFound();
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'crew_change.person_removed', entityType: 'crew_change', entityId: id });
      await emitChange(db, a.org.id, 'crew_change', id, null, a.user.id);
      return { ok: true };
    });
  });

  // Status transitions. Approval is always a human action by an authorised user other than
  // the person who submitted it; no automated process or AI suggestion can approve.
  app.post('/crew-changes/:id/:action', async (req) => {
    const { action } = req.params as any;
    if (!['submit', 'approve', 'start', 'complete', 'cancel', 'reopen'].includes(action)) throw notFound();
    const perm = action === 'approve' ? 'crew_change:approve' : action === 'cancel' ? 'crew_change:cancel' : 'crew_change:edit';
    const a = need(req, perm);
    const id = idParam((req.params as any).id);
    const b = z.object({ version: z.number().int(), reason: z.string().max(1000).optional(), acknowledgeBlockers: z.boolean().optional() }).parse(req.body);
    return orgTx(a, async (db) => {
      const cc = await loadCrewChange(db, a, id, true);
      if (cc.version !== b.version) throw new ApiError(409, 'edit_conflict', { currentVersion: cc.version, current: cc, conflicts: [{ field: 'status', theirs: cc.status }] });
      const allowed: Record<string, string[]> = {
        submit: ['draft', 'planning'],
        approve: ['approval_pending'],
        start: ['approved'],
        complete: ['in_progress', 'approved'],
        cancel: ['draft', 'planning', 'approval_pending', 'approved', 'in_progress'],
        reopen: ['approval_pending', 'approved'],
      };
      if (!allowed[action].includes(cc.status)) throw new ApiError(409, 'invalid_state', { status: cc.status });
      let sql = '';
      const params: unknown[] = [id, a.user.id];
      if (action === 'submit') sql = "status = 'approval_pending', submitted_by = $2";
      if (action === 'approve') {
        if (cc.submitted_by === a.user.id || cc.created_by === a.user.id) throw new ApiError(403, 'segregation_of_duties');
        const open = await many(db, "SELECT code FROM insights WHERE crew_change_id = $1 AND status = 'open' AND severity = 'critical'", [id]);
        if (open.length && !b.acknowledgeBlockers) throw new ApiError(409, 'blockers_present', { blockers: open.map((x) => x.code) });
        sql = "status = 'approved', approved_by = $2, approved_at = now()";
      }
      if (action === 'start') sql = "status = 'in_progress'";
      if (action === 'complete') sql = "status = 'completed'";
      if (action === 'reopen') sql = "status = 'planning', approved_by = NULL, approved_at = NULL";
      if (action === 'cancel') {
        if (!b.reason) throw badRequest('reason_required');
        sql = "status = 'cancelled', cancelled_by = $2, cancelled_at = now()";
      }
      const row = await one(db, `UPDATE crew_changes SET ${sql}, version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1 RETURNING *`, params);
      await audit(db, actorOf(a), {
        orgId: a.org.id,
        action: `crew_change.${action}`,
        entityType: 'crew_change',
        entityId: id,
        metadata: { from: cc.status, to: row.status, ...(b.reason ? { reasonLength: b.reason.length } : {}), ...(b.acknowledgeBlockers ? { acknowledgedBlockers: true } : {}) },
      });
      if (action === 'cancel' && b.reason) {
        await db.query(`INSERT INTO comments (org_id, entity_type, entity_id, author_id, body) VALUES ($1,'crew_change',$2,$3,$4)`, [a.org.id, id, a.user.id, b.reason]);
      }
      await refreshInsights(db, a.org.id);
      await emitChange(db, a.org.id, 'crew_change', id, row.version, a.user.id);
      return row;
    });
  });

  /** Creates draft requests for everyone joining a crew change, with sensible default details. */
  app.post('/crew-changes/:id/requests/generate', async (req) => {
    const a = need(req, 'request:edit');
    const id = idParam((req.params as any).id);
    const b = z
      .object({ types: z.array(z.enum(REQUEST_TYPES as [RequestType, ...RequestType[]])).min(1), suppliers: z.record(z.string(), z.string().uuid()).default({}), direction: z.enum(['on', 'off', 'both']).default('on') })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const cc = await loadCrewChange(db, a, id);
      const people = await many(db, `SELECT personnel_id, direction FROM crew_change_people WHERE crew_change_id = $1 ${b.direction === 'both' ? '' : 'AND direction = $2'}`, b.direction === 'both' ? [id] : [id, b.direction]);
      const created = [];
      for (const person of people) {
        for (const type of b.types) {
          const exists = await one(db, "SELECT id FROM service_requests WHERE crew_change_id = $1 AND personnel_id = $2 AND type = $3 AND status <> 'cancelled'", [id, person.personnel_id, type]);
          if (exists) continue;
          const details: Record<string, string> = {};
          if (type === 'hotel') Object.assign(details, { check_in: addDaysIso(cc.scheduled_on, -1), check_out: cc.scheduled_on });
          if (type === 'transfer' && cc.embarkation_point) details.dropoff_location = cc.embarkation_point;
          if (type === 'flight') details.to = cc.embarkation_point ?? '';
          const r = await createRequest(db, a, { crewChangeId: id, personnelId: person.personnel_id, supplierId: b.suppliers[type] ?? null, type, details: Object.fromEntries(Object.entries(details).filter(([, v]) => v)), locationTz: cc.asset_timezone });
          created.push(r);
        }
      }
      await refreshInsights(db, a.org.id);
      await emitChange(db, a.org.id, 'crew_change', id, null, a.user.id);
      return { created: created.length, requests: created };
    });
  });

  /* Service requests ---------------------------------------------------------------------- */

  app.get('/requests', async (req) => {
    const a = need(req, 'request:view');
    const q = req.query as Record<string, string>;
    const { limit, offset } = page(q);
    return orgTx(a, async (db) => {
      const p = new Params();
      const conds = [requestScope(a, p)];
      if (q.status) conds.push(`r.status = ANY(${p.add(q.status.split(','))})`);
      if (q.type) conds.push(`r.type = ANY(${p.add(q.type.split(','))})`);
      if (q.crewChangeId) conds.push(`r.crew_change_id = ${p.add(idParam(q.crewChangeId))}`);
      if (q.supplierId) conds.push(`r.supplier_id = ${p.add(idParam(q.supplierId))}`);
      if (q.from) conds.push(`r.starts_at >= ${p.add(q.from)}`);
      if (q.to) conds.push(`r.starts_at < ${p.add(q.to)}`);
      if (q.overdue === '1') conds.push(`r.response_due_at < now() AND r.status IN ('requested', 'acknowledged')`);
      const rows = await many(
        db,
        `SELECT r.*, pe.full_name, pe.employee_no, pe.phone, pe.nationality, pe.job_title, pe.id AS pid, s.name AS supplier_name, cc.reference AS crew_change_reference
         FROM service_requests r JOIN personnel pe ON pe.id = r.personnel_id LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN crew_changes cc ON cc.id = r.crew_change_id
         WHERE ${conds.join(' AND ')} ORDER BY r.starts_at NULLS LAST, r.reference LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
        p.values,
      );
      return rows.map((r) => {
        const { full_name, employee_no, phone, nationality, job_title, pid, ...rest } = r;
        return presentRequest(a, rest, { id: pid, full_name, employee_no, phone, nationality, job_title });
      });
    });
  });

  app.get('/requests/:id', async (req) => {
    const a = need(req, 'request:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const r = await loadRequest(db, a, id);
      const person = await one(db, 'SELECT id, full_name, employee_no, phone, nationality, job_title FROM personnel WHERE id = $1', [r.personnel_id]);
      const supplier = r.supplier_id ? await one(db, 'SELECT id, name, category FROM suppliers WHERE id = $1', [r.supplier_id]) : null;
      const events = await many(
        db,
        `SELECT e.id, e.stage, e.at, e.package_id, e.message_id, e.detail, u.display_name AS actor FROM request_events e LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.request_id = $1 ORDER BY e.at, e.id`,
        [id],
      );
      const out: any = presentRequest(a, r, person);
      out.supplier = supplier;
      if (a.membership.role !== 'supplier') {
        out.events = events;
        if (can(a, 'email:view')) {
          out.messages = await many(
            db,
            `SELECT m.id, m.direction, m.subject, m.from_address, m.received_at, l.method, l.confidence FROM message_links l JOIN email_messages m ON m.id = l.message_id
             WHERE l.request_id = $1 ORDER BY m.received_at`,
            [id],
          );
          out.proposals = await many(db, 'SELECT * FROM extraction_proposals WHERE request_id = $1 ORDER BY created_at DESC', [id]);
          out.packages = await many(
            db,
            `SELECT p.id, p.reference, p.status, p.purpose, p.submitted_at FROM package_requests pr JOIN email_packages p ON p.id = pr.package_id WHERE pr.request_id = $1 ORDER BY p.created_at`,
            [id],
          );
        }
      } else {
        out.events = events.filter((e) => ['submitted', 'response_received', 'confirmation_recorded', 'cancelled'].includes(e.stage)).map(({ actor: _a, detail: _d, ...e }) => e);
      }
      return out;
    });
  });

  app.post('/requests', async (req) => {
    const a = need(req, 'request:edit');
    const b = requestCreate.parse(req.body);
    return orgTx(a, async (db) => {
      const row = await createRequest(db, a, b);
      await refreshInsights(db, a.org.id);
      if (row.crew_change_id) await emitChange(db, a.org.id, 'crew_change', row.crew_change_id, null, a.user.id);
      return row;
    });
  });

  app.patch('/requests/:id', async (req) => {
    const a = need(req, 'request:edit');
    const id = idParam((req.params as any).id);
    const b = z.object({ version: z.number().int(), changes: z.record(z.string(), z.unknown()), base: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    return orgTx(a, async (db) => applyRequestChanges(db, a, id, b.version, b.changes, b.base, { source: 'manual' }));
  });

  app.post('/requests/:id/status', async (req) => {
    const a = need(req, 'request:edit');
    const id = idParam((req.params as any).id);
    const b = z
      .object({ version: z.number().int(), status: z.enum(['requested', 'acknowledged', 'quoted', 'proposed', 'confirmed', 'completed', 'cancelled']), note: z.string().max(1000).optional(), evidenceMessageId: z.string().uuid().optional() })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const r = await loadRequest(db, a, id, true);
      if (r.version !== b.version) throw new ApiError(409, 'edit_conflict', { currentVersion: r.version, current: r, conflicts: [{ field: 'status', theirs: r.status, mine: b.status }] });
      if (!STATUS_FLOW[r.status]?.includes(b.status)) throw new ApiError(409, 'invalid_transition', { from: r.status, to: b.status });
      // Recording a confirmation needs either a linked supplier message as evidence or an explanatory note.
      if (b.status === 'confirmed' && !b.evidenceMessageId && !b.note) throw badRequest('confirmation_evidence_required');
      if (b.evidenceMessageId && !(await one(db, 'SELECT 1 FROM message_links WHERE message_id = $1 AND request_id = $2', [b.evidenceMessageId, id]))) throw notFound();
      const row = await one(
        db,
        `UPDATE service_requests SET status = $2, version = version + 1, updated_by = $3, updated_at = now(),
           confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END, confirmed_by = CASE WHEN $2 = 'confirmed' THEN $3 ELSE confirmed_by END,
           cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END, cancelled_by = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancelled_by END,
           first_requested_at = CASE WHEN $2 = 'requested' THEN coalesce(first_requested_at, now()) ELSE first_requested_at END
         WHERE id = $1 RETURNING *`,
        [id, b.status, a.user.id],
      );
      const stage = b.status === 'confirmed' ? 'confirmation_recorded' : b.status === 'completed' ? 'completed' : b.status === 'cancelled' ? 'cancelled' : 'changed';
      await addRequestEvent(db, a.org.id, id, stage, a.user.id, { messageId: b.evidenceMessageId, detail: { from: r.status, to: b.status, manual: true } });
      if (b.note) await db.query(`INSERT INTO comments (org_id, entity_type, entity_id, author_id, body) VALUES ($1,'request',$2,$3,$4)`, [a.org.id, id, a.user.id, b.note]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: `request.status_${b.status}`, entityType: 'request', entityId: id, metadata: { from: r.status } });
      await refreshInsights(db, a.org.id);
      await emitChange(db, a.org.id, 'request', id, row.version, a.user.id);
      return row;
    });
  });

  // Optional supplier portal response. Suppliers are not required to have accounts (email is
  // the primary channel); those who do can acknowledge or confirm their own requests only.
  app.post('/requests/:id/respond', async (req) => {
    const a = need(req, 'request:respond');
    const id = idParam((req.params as any).id);
    const b = z.object({ version: z.number().int(), response: z.enum(['acknowledged', 'confirmed', 'cannot_fulfil']), bookingReference: z.string().max(40).optional(), note: z.string().max(1000).optional() }).parse(req.body);
    return orgTx(a, async (db) => {
      const r = await loadRequest(db, a, id, true);
      if (r.version !== b.version) throw new ApiError(409, 'edit_conflict', { currentVersion: r.version, conflicts: [{ field: 'status' }] });
      if (!['requested', 'acknowledged', 'quoted', 'proposed'].includes(r.status)) throw new ApiError(409, 'invalid_state');
      // A supplier's confirmation is recorded as a proposal for the coordinator to validate.
      const status = b.response === 'acknowledged' ? 'acknowledged' : 'change_pending_review';
      const row = await one(
        db,
        `UPDATE service_requests SET status = $2, booking_reference = coalesce($3, booking_reference), first_response_at = coalesce(first_response_at, now()),
           version = version + 1, updated_at = now(), updated_by = $4 WHERE id = $1 RETURNING id, status, version`,
        [id, status, b.bookingReference ?? null, a.user.id],
      );
      await addRequestEvent(db, a.org.id, id, 'response_received', a.user.id, { detail: { channel: 'portal', response: b.response } });
      if (b.note) await db.query(`INSERT INTO comments (org_id, entity_type, entity_id, author_id, body) VALUES ($1,'request',$2,$3,$4)`, [a.org.id, id, a.user.id, b.note]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'request.supplier_responded', entityType: 'request', entityId: id, metadata: { response: b.response } });
      await refreshInsights(db, a.org.id);
      return row;
    });
  });

  /* Calendar ------------------------------------------------------------------------------ */

  app.get('/calendar', async (req) => {
    const a = need(req, 'request:view');
    const q = req.query as Record<string, string>;
    const from = z.string().date().parse(q.from);
    const to = z.string().date().parse(q.to);
    return orgTx(a, async (db) => {
      const p = new Params();
      const requests = await many(
        db,
        `SELECT r.id, r.reference, r.type, r.status, r.starts_at, r.ends_at, r.location_tz, pe.full_name, r.crew_change_id
         FROM service_requests r JOIN personnel pe ON pe.id = r.personnel_id
         WHERE ${requestScope(a, p)} AND r.status <> 'cancelled' AND r.starts_at >= ${p.add(from)}::date AND r.starts_at < ${p.add(to)}::date + 1
         ORDER BY r.starts_at`,
        p.values,
      );
      let crewChanges: any[] = [];
      if (can(a, 'crew_change:view')) {
        const p2 = new Params();
        crewChanges = await many(
          db,
          `SELECT cc.id, cc.reference, cc.scheduled_on, cc.status, s.name AS asset_name FROM crew_changes cc JOIN assets s ON s.id = cc.asset_id
           WHERE ${crewChangeScope(a, p2)} AND cc.status <> 'cancelled' AND cc.scheduled_on BETWEEN ${p2.add(from)} AND ${p2.add(to)}`,
          p2.values,
        );
      }
      return {
        from,
        to,
        events: [
          ...requests.map((r) => ({
            kind: r.type === 'medical' ? 'appointment' : r.type === 'training' ? 'training' : 'movement',
            type: r.type,
            id: r.id,
            reference: r.reference,
            status: r.status,
            startsAt: r.starts_at,
            endsAt: r.ends_at,
            timezone: r.location_tz,
            title: r.full_name,
            crewChangeId: r.crew_change_id,
          })),
          ...crewChanges.map((c) => ({ kind: 'crew_change', id: c.id, reference: c.reference, status: c.status, date: c.scheduled_on, title: c.asset_name })),
        ],
      };
    });
  });
}

function addDaysIso(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Applies validated changes to a request (manual edit, accepted extraction or accepted
 * workbook reconciliation), records the change in the request timeline and recomputes
 * downstream impacts.
 */
export async function applyRequestChanges(
  db: Db,
  a: OrgContext,
  id: string,
  version: number,
  rawChanges: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  ctx: { source: 'manual' | 'extraction' | 'workbook'; messageId?: string },
) {
  const r = await loadRequest(db, a, id);
  if (['cancelled', 'completed'].includes(r.status) && ctx.source === 'manual') throw new ApiError(409, 'invalid_state');
  const allowedTop = ['supplier_id', 'response_due_at', 'booking_reference', 'cost_amount', 'cost_currency', 'location_tz'];
  const detailSchema = DETAIL_SCHEMAS[r.type as RequestType];
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawChanges)) {
    if (k.startsWith('details.')) {
      const field = k.slice(8);
      const shape = (detailSchema as any).shape[field];
      if (!shape) throw badRequest('field_not_editable', { field: k });
      changes[k] = v === null ? null : shape.parse(v);
    } else if (allowedTop.includes(k)) {
      if (k === 'cost_amount' && v !== null) changes[k] = z.number().nonnegative().max(1e9).parse(v);
      else if (k === 'cost_currency' && v !== null) changes[k] = z.string().regex(/^[A-Z]{3}$/).parse(v);
      else if (k === 'supplier_id' && v !== null) {
        if (!(await one(db, 'SELECT id FROM suppliers WHERE id = $1 AND org_id = $2', [v, a.org.id]))) throw notFound();
        changes[k] = v;
      } else if (k === 'location_tz' && !Intl.supportedValuesOf('timeZone').includes(String(v))) throw badRequest('invalid_timezone');
      else changes[k] = v;
    } else throw badRequest('field_not_editable', { field: k });
  }
  // A cost without a currency is meaningless (and amounts are never converted between currencies).
  if (changes.cost_amount != null && !(changes.cost_currency ?? r.cost_currency)) throw badRequest('currency_required');
  const result = await patchVersioned(db, {
    table: 'service_requests',
    id,
    orgId: a.org.id,
    version,
    changes,
    base,
    allowed: [...allowedTop, 'details.*'],
    actorId: a.user.id,
  });
  const after = result.after;
  const times = normaliseTimes(after.type, after.details, after.location_tz);
  await db.query('UPDATE service_requests SET starts_at = $2, ends_at = $3 WHERE id = $1', [id, times.starts_at, times.ends_at]);
  if (result.changedFields.length) {
    const diff = Object.fromEntries(
      result.changedFields.map((f) => [f, { from: f.startsWith('details.') ? result.before.details?.[f.slice(8)] ?? null : result.before[f] ?? null, to: rawChanges[f] ?? null }]),
    );
    await addRequestEvent(db, a.org.id, id, 'changed', a.user.id, { messageId: ctx.messageId, detail: { source: ctx.source, changes: diff } });
  }
  await audit(db, actorOf(a), { orgId: a.org.id, action: 'request.updated', entityType: 'request', entityId: id, metadata: { fields: result.changedFields, source: ctx.source, merged: result.merged } });
  await refreshInsights(db, a.org.id, { changedRequestId: id, changedFields: result.changedFields });
  await emitChange(db, a.org.id, 'request', id, after.version, a.user.id);
  return { record: { ...after, starts_at: times.starts_at, ends_at: times.ends_at }, merged: result.merged, changedFields: result.changedFields };
}
