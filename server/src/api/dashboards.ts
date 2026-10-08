import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, type Db } from '../db/pool.js';
import { can, need, orgTx, requireOrg, type OrgContext } from '../http/guard.js';
import { ApiError, notFound } from '../http/errors.js';
import { assetScope, crewChangeScope, Params, personnelScope, requestScope, taskScope } from '../authz/scope.js';
import type { Permission } from '../authz/permissions.js';
import { addDays } from '../util/time.js';
import { isReady, readinessFor } from '../domain/readiness.js';
import { idParam } from './util.js';

const today = () => new Date().toISOString().slice(0, 10);

interface Period {
  from: string;
  to: string;
}

/**
 * A KPI is defined once: the same scoped predicate produces both the total shown on the card
 * and the drill-down list of underlying records, so the two always reconcile. Definitions
 * and period labels are translated client-side from `code`.
 */
interface KpiDef {
  code: string;
  permission: Permission;
  unit: 'count' | 'percent' | 'hours' | 'money';
  /** Returns the FROM/WHERE clause for the period (records), using scope predicates. */
  source: (a: OrgContext, p: Params, period: Period) => { from: string; where: string; columns: string; order: string } | null;
  aggregate?: (rows: any[]) => { value: number | null; breakdown?: Record<string, number>; samples?: number };
  period: (t: string) => Period;
  comparison?: (t: string) => Period;
  minSamples?: number;
}

const next = (days: number) => (t: string) => ({ from: t, to: addDays(t, days) });
const last = (days: number) => (t: string) => ({ from: addDays(t, -days), to: t });
const prevOf = (days: number, offset: number) => (t: string) => ({ from: addDays(t, offset - days), to: addDays(t, offset) });

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const KPIS: KpiDef[] = [
  {
    code: 'upcoming_movements',
    permission: 'dashboard:coordination',
    unit: 'count',
    period: next(14),
    source: (a, p, per) => ({
      from: 'service_requests r JOIN personnel pe ON pe.id = r.personnel_id',
      where: `${requestScope(a, p)} AND r.status NOT IN ('cancelled') AND r.type IN ('flight', 'transfer', 'hotel') AND r.starts_at >= ${p.add(per.from)}::date AND r.starts_at < ${p.add(per.to)}::date + 1`,
      columns: "r.id, r.reference, r.type, r.status, r.starts_at, r.location_tz, pe.full_name AS person, 'request' AS entity",
      order: 'r.starts_at',
    }),
    aggregate: (rows) => ({ value: rows.length, breakdown: countBy(rows, 'type') }),
  },
  {
    code: 'awaiting_confirmation',
    permission: 'dashboard:coordination',
    unit: 'count',
    period: (t) => ({ from: t, to: t }),
    source: (a, p) => ({
      from: 'service_requests r JOIN personnel pe ON pe.id = r.personnel_id LEFT JOIN suppliers s ON s.id = r.supplier_id',
      where: `${requestScope(a, p)} AND r.status IN ('requested', 'acknowledged', 'quoted', 'proposed', 'change_pending_review')`,
      columns: "r.id, r.reference, r.type, r.status, r.response_due_at, s.name AS supplier, pe.full_name AS person, (r.response_due_at < now()) AS overdue, 'request' AS entity",
      order: 'r.response_due_at NULLS LAST',
    }),
    aggregate: (rows) => ({ value: rows.length, breakdown: { overdue: rows.filter((r) => r.overdue).length, on_time: rows.filter((r) => !r.overdue).length } }),
  },
  {
    code: 'uncovered_assignments',
    permission: 'dashboard:coordination',
    unit: 'count',
    period: next(60),
    source: (a, p, per) => ({
      from: 'assignments x JOIN assets s ON s.id = x.asset_id LEFT JOIN positions pos ON pos.id = x.position_id',
      where: `${assetScope(a, p, 's')} AND x.personnel_id IS NULL AND x.status <> 'cancelled' AND x.starts_on <= ${p.add(per.to)} AND x.ends_on >= ${p.add(per.from)}`,
      columns: "x.id, s.name AS asset, pos.title AS position, x.starts_on, x.ends_on, 'assignment' AS entity",
      order: 'x.starts_on',
    }),
  },
  {
    code: 'schedule_changes',
    permission: 'dashboard:coordination',
    unit: 'count',
    period: last(7),
    comparison: prevOf(7, -7),
    source: (a, p, per) => ({
      from: 'request_events e JOIN service_requests r ON r.id = e.request_id JOIN personnel pe ON pe.id = r.personnel_id',
      where: `${requestScope(a, p)} AND e.stage = 'changed' AND e.at >= ${p.add(per.from)}::date AND e.at < ${p.add(per.to)}::date + 1`,
      columns: "e.id::text AS id, r.id AS request_id, r.reference, r.type, e.at, e.detail->>'source' AS source, pe.full_name AS person, 'request' AS entity",
      order: 'e.at DESC',
    }),
  },
  {
    code: 'mobilisation_blockers',
    permission: 'dashboard:coordination',
    unit: 'count',
    period: (t) => ({ from: t, to: t }),
    source: (a, p) => insightSource(a, p, "i.severity = 'critical'"),
  },
  {
    code: 'staffing_coverage',
    permission: 'dashboard:management',
    unit: 'percent',
    period: next(30),
    comparison: prevOf(30, 0),
    source: (a, p, per) => ({
      from: 'positions pos JOIN assets s ON s.id = pos.asset_id',
      where: `${assetScope(a, p, 's')}`,
      columns: `pos.id, s.name AS asset, pos.title AS position, pos.headcount,
        (pos.headcount * (${p.add(per.to)}::date - ${p.add(per.from)}::date)) AS required_days,
        coalesce((SELECT sum(least(x.ends_on, ${p.add(per.to)}::date) - greatest(x.starts_on, ${p.add(per.from)}::date))
          FROM assignments x WHERE x.position_id = pos.id AND x.personnel_id IS NOT NULL AND x.status <> 'cancelled'
            AND x.starts_on < ${p.add(per.to)}::date AND x.ends_on > ${p.add(per.from)}::date), 0)::int AS covered_days, 'position' AS entity`,
      order: 's.name, pos.title',
    }),
    aggregate: (rows) => {
      const req = rows.reduce((n, r) => n + Number(r.required_days), 0);
      const cov = rows.reduce((n, r) => n + Math.min(Number(r.covered_days), Number(r.required_days)), 0);
      return { value: req ? Math.round((cov / req) * 1000) / 10 : null, samples: rows.length };
    },
    minSamples: 1,
  },
  {
    code: 'readiness',
    permission: 'dashboard:management',
    unit: 'percent',
    period: next(30),
    source: (a, p, per) => ({
      from: 'assignments x JOIN personnel pe ON pe.id = x.personnel_id JOIN assets s ON s.id = x.asset_id LEFT JOIN positions pos ON pos.id = x.position_id',
      where: `${assetScope(a, p, 's')} AND ${personnelScope(a, p, 'pe')} AND x.status IN ('planned', 'confirmed') AND x.starts_on BETWEEN ${p.add(per.from)} AND ${p.add(per.to)}`,
      columns: "x.id, x.personnel_id, pe.full_name AS person, s.name AS asset, x.starts_on, x.ends_on, coalesce(pos.requirement_ids, '{}') AS requirement_ids, 'assignment' AS entity",
      order: 'x.starts_on',
    }),
    minSamples: 1,
  },
  {
    code: 'outstanding_approvals',
    permission: 'dashboard:management',
    unit: 'count',
    period: (t) => ({ from: t, to: t }),
    source: (a, p) => ({
      from: 'crew_changes cc JOIN assets s ON s.id = cc.asset_id',
      where: `${crewChangeScope(a, p)} AND cc.status = 'approval_pending'`,
      columns: "cc.id, cc.reference, s.name AS asset, cc.scheduled_on, cc.updated_at, 'crew_change' AS entity",
      order: 'cc.scheduled_on',
    }),
  },
  {
    code: 'supplier_response_time',
    permission: 'dashboard:management',
    unit: 'hours',
    period: last(30),
    comparison: prevOf(30, -30),
    minSamples: 3,
    source: (a, p, per) => ({
      from: 'service_requests r LEFT JOIN suppliers s ON s.id = r.supplier_id',
      where: `${requestScope(a, p)} AND r.first_requested_at >= ${p.add(per.from)}::date AND r.first_requested_at < ${p.add(per.to)}::date + 1 AND r.first_response_at IS NOT NULL`,
      columns: "r.id, r.reference, s.name AS supplier, r.first_requested_at, r.first_response_at, round(extract(epoch FROM r.first_response_at - r.first_requested_at) / 3600, 1)::float AS hours, 'request' AS entity",
      order: 'hours DESC',
    }),
    aggregate: (rows) => ({ value: median(rows.map((r) => Number(r.hours))), samples: rows.length }),
  },
  {
    code: 'recorded_costs',
    permission: 'costs:view',
    unit: 'money',
    period: last(30),
    comparison: prevOf(30, -30),
    source: (a, p, per) => ({
      from: 'service_requests r JOIN personnel pe ON pe.id = r.personnel_id',
      where: `${requestScope(a, p)} AND r.status IN ('confirmed', 'completed') AND r.cost_amount IS NOT NULL AND r.starts_at >= ${p.add(per.from)}::date AND r.starts_at < ${p.add(per.to)}::date + 1`,
      columns: "r.id, r.reference, r.type, r.cost_amount, r.cost_currency, r.starts_at, pe.full_name AS person, 'request' AS entity",
      order: 'r.starts_at',
    }),
    // Totals are kept per currency: amounts are never converted without an exchange-rate source.
    aggregate: (rows) => {
      const by: Record<string, number> = {};
      for (const r of rows) by[r.cost_currency ?? 'XXX'] = Math.round(((by[r.cost_currency ?? 'XXX'] ?? 0) + Number(r.cost_amount)) * 100) / 100;
      return { value: rows.length ? null : 0, breakdown: by, samples: rows.length };
    },
  },
  {
    code: 'expiring_credentials',
    permission: 'dashboard:compliance',
    unit: 'count',
    period: next(60),
    source: (a, p, per) => ({
      from: 'credentials c JOIN personnel pe ON pe.id = c.personnel_id JOIN requirement_types rt ON rt.id = c.requirement_type_id',
      where: `${personnelScope(a, p, 'pe')} AND c.verification_status <> 'rejected' AND c.expires_on <= ${p.add(per.to)}
        AND NOT EXISTS (SELECT 1 FROM credentials c2 WHERE c2.personnel_id = c.personnel_id AND c2.requirement_type_id = c.requirement_type_id AND c2.expires_on > c.expires_on AND c2.verification_status <> 'rejected')
        ${can(a, 'medical:view') ? '' : "AND rt.category <> 'medical'"}`,
      columns: `c.id, pe.id AS personnel_id, pe.full_name AS person, rt.code AS requirement, c.expires_on, (c.expires_on < ${p.add(per.from)}) AS expired, 'personnel' AS entity`,
      order: 'c.expires_on',
    }),
    aggregate: (rows) => ({ value: rows.length, breakdown: { expired: rows.filter((r) => r.expired).length, expiring: rows.filter((r) => !r.expired).length } }),
  },
  {
    code: 'verification_queue',
    permission: 'dashboard:compliance',
    unit: 'count',
    period: (t) => ({ from: t, to: t }),
    source: (a, p) => ({
      from: 'credentials c JOIN personnel pe ON pe.id = c.personnel_id JOIN requirement_types rt ON rt.id = c.requirement_type_id',
      where: `${personnelScope(a, p, 'pe')} AND c.verification_status = 'pending' ${can(a, 'medical:view') ? '' : "AND rt.category <> 'medical'"}`,
      columns: "c.id, pe.id AS personnel_id, pe.full_name AS person, rt.code AS requirement, c.created_at, 'personnel' AS entity",
      order: 'c.created_at',
    }),
  },
  {
    code: 'onboarding_progress',
    permission: 'dashboard:compliance',
    unit: 'percent',
    period: (t) => ({ from: t, to: t }),
    source: (a, p) => ({
      from: 'personnel pe',
      where: `${personnelScope(a, p, 'pe')} AND pe.status = 'onboarding'`,
      columns: `pe.id, pe.full_name AS person,
        (SELECT count(*)::int FROM tasks t WHERE t.personnel_id = pe.id AND t.kind = 'onboarding' AND t.status <> 'cancelled') AS total,
        (SELECT count(*)::int FROM tasks t WHERE t.personnel_id = pe.id AND t.kind = 'onboarding' AND t.status = 'done') AS done, 'personnel' AS entity`,
      order: 'pe.full_name',
    }),
    aggregate: (rows) => {
      const total = rows.reduce((n, r) => n + r.total, 0);
      const done = rows.reduce((n, r) => n + r.done, 0);
      return { value: total ? Math.round((done / total) * 1000) / 10 : null, samples: total, breakdown: { people: rows.length, tasks_done: done, tasks_total: total } };
    },
    minSamples: 1,
  },
  {
    code: 'supplier_open_requests',
    permission: 'dashboard:supplier',
    unit: 'count',
    period: (t) => ({ from: t, to: t }),
    source: (a, p) => ({
      from: 'service_requests r JOIN personnel pe ON pe.id = r.personnel_id',
      where: `${requestScope(a, p)} AND r.status IN ('requested', 'acknowledged', 'quoted', 'proposed')`,
      columns: "r.id, r.reference, r.type, r.status, r.starts_at, r.response_due_at, pe.full_name AS person, 'request' AS entity",
      order: 'r.response_due_at NULLS LAST',
    }),
  },
  {
    code: 'my_itinerary',
    permission: 'dashboard:employee',
    unit: 'count',
    period: next(60),
    source: (a, p, per) => ({
      from: 'service_requests r',
      where: `${requestScope(a, p)} AND r.status <> 'cancelled' AND r.starts_at >= ${p.add(per.from)}::date AND r.starts_at < ${p.add(per.to)}::date + 1`,
      columns: "r.id, r.reference, r.type, r.status, r.starts_at, r.ends_at, r.location_tz, r.details, 'request' AS entity",
      order: 'r.starts_at',
    }),
  },
  {
    code: 'my_tasks',
    permission: 'dashboard:employee',
    unit: 'count',
    period: (t) => ({ from: t, to: t }),
    source: (a, p) => ({
      from: 'tasks t',
      where: `${taskScope(a, p)} AND t.status IN ('todo', 'in_progress', 'blocked')`,
      columns: "t.id, t.title, t.kind, t.status, t.due_at, 'task' AS entity",
      order: 't.due_at NULLS LAST',
    }),
  },
  {
    code: 'my_expiring_credentials',
    permission: 'dashboard:employee',
    unit: 'count',
    period: next(90),
    source: (a, p, per) => ({
      from: 'credentials c JOIN personnel pe ON pe.id = c.personnel_id JOIN requirement_types rt ON rt.id = c.requirement_type_id',
      where: `${personnelScope(a, p, 'pe')} AND c.expires_on <= ${p.add(per.to)} AND c.verification_status <> 'rejected'`,
      columns: "c.id, rt.code AS requirement, rt.name_en, rt.name_pt, c.expires_on, 'credential' AS entity",
      order: 'c.expires_on',
    }),
  },
];

/**
 * Insights visible to the viewer: only those whose crew change and person are within the
 * viewer's scope. Suppliers and employees do not see cross-cutting operational insights.
 */
function insightSource(a: OrgContext, p: Params, extra: string) {
  if (['supplier', 'employee'].includes(a.membership.role)) return null;
  return {
    from: 'insights i LEFT JOIN crew_changes cc ON cc.id = i.crew_change_id LEFT JOIN personnel pe ON pe.id = i.personnel_id',
    where: `i.org_id = ${p.add(a.org.id)} AND i.status = 'open' AND ${extra}
      AND (i.crew_change_id IS NULL OR (${crewChangeScope(a, p, 'cc')})) AND (i.personnel_id IS NULL OR (${personnelScope(a, p, 'pe')}))`,
    columns: "i.id, i.kind, i.code, i.severity, i.params, i.supporting, i.assumptions, i.actions, i.crew_change_id, i.personnel_id, i.request_id, i.detected_at, 'insight' AS entity",
    order: "CASE i.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, i.detected_at DESC",
  };
}

function countBy(rows: any[], key: string) {
  const out: Record<string, number> = {};
  for (const r of rows) out[r[key]] = (out[r[key]] ?? 0) + 1;
  return out;
}

async function runKpi(db: Db, a: OrgContext, def: KpiDef, period: Period) {
  const p = new Params();
  const src = def.source(a, p, period);
  if (!src) return { rows: [] as any[], value: 0 };
  const rows = await many(db, `SELECT ${src.columns} FROM ${src.from} WHERE ${src.where} ORDER BY ${src.order} LIMIT 2000`, p.values);
  if (def.code === 'readiness') {
    const cells = await readinessFor(db, a.org.id, rows.map((r) => ({ personnelId: r.personnel_id, from: r.starts_on, to: r.ends_on, requirementIds: r.requirement_ids })));
    for (const r of rows) {
      const c = cells.get(`${r.personnel_id}:${r.starts_on}`) ?? [];
      r.ready = isReady(c);
      r.gaps = c.filter((x) => !['valid', 'expiring_soon'].includes(x.status)).length;
    }
    return { rows, value: rows.length ? Math.round((rows.filter((r) => r.ready).length / rows.length) * 1000) / 10 : null, samples: rows.length };
  }
  const agg = def.aggregate ? def.aggregate(rows) : { value: rows.length };
  return { rows, ...agg };
}

async function computeKpi(db: Db, a: OrgContext, def: KpiDef) {
  const t = today();
  const period = def.period(t);
  const cur: any = await runKpi(db, a, def, period);
  let comparison = null;
  if (def.comparison) {
    const cp = def.comparison(t);
    const prev: any = await runKpi(db, a, def, cp);
    const insufficient = def.minSamples !== undefined && (prev.samples ?? prev.rows.length) < def.minSamples;
    comparison = { period: cp, value: insufficient ? null : prev.value, breakdown: prev.breakdown ?? null, status: insufficient ? 'insufficient_data' : 'ok' };
  }
  const samples = cur.samples ?? cur.rows.length;
  const insufficient = def.minSamples !== undefined && samples < def.minSamples;
  return {
    code: def.code,
    unit: def.unit,
    value: insufficient ? null : cur.value,
    breakdown: cur.breakdown ?? null,
    samples,
    status: insufficient ? 'insufficient_data' : 'ok',
    period,
    comparison,
    drill: `/api/dashboard/kpi/${def.code}`,
  };
}

const LAYOUTS: Record<string, string[]> = {
  management: ['staffing_coverage', 'readiness', 'outstanding_approvals', 'supplier_response_time', 'recorded_costs'],
  coordination: ['upcoming_movements', 'uncovered_assignments', 'awaiting_confirmation', 'schedule_changes', 'mobilisation_blockers'],
  compliance: ['expiring_credentials', 'onboarding_progress', 'verification_queue'],
  supplier: ['supplier_open_requests'],
  employee: ['my_itinerary', 'my_tasks', 'my_expiring_credentials'],
};
const DEFAULT_FOR_ROLE: Record<string, string> = {
  org_admin: 'management',
  manager: 'management',
  auditor: 'management',
  coordinator: 'coordination',
  hr_compliance: 'compliance',
  supplier: 'supplier',
  employee: 'employee',
};

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (req) => {
    const a = requireOrg(req);
    const kind = String((req.query as any).kind ?? DEFAULT_FOR_ROLE[a.membership.role]);
    if (!LAYOUTS[kind]) throw notFound();
    if (!a.permissions.has(`dashboard:${kind}` as Permission)) throw new ApiError(403, 'forbidden');
    return orgTx(a, async (db) => {
      const available = Object.keys(LAYOUTS).filter((k) => a.permissions.has(`dashboard:${k}` as Permission));
      const kpis = [];
      for (const code of LAYOUTS[kind]) {
        const def = KPIS.find((k) => k.code === code)!;
        if (!a.permissions.has(def.permission)) continue; // e.g. costs:view
        kpis.push(await computeKpi(db, a, def));
      }
      const mailbox = await one(db, "SELECT max(last_sync_at) AS at, count(*) FILTER (WHERE status = 'connected')::int AS connected FROM mailbox_connections WHERE org_id = $1", [a.org.id]);
      let exceptions: any[] = [];
      const ip = new Params();
      const isrc = insightSource(a, ip, "i.severity IN ('critical', 'warning')");
      if (isrc) exceptions = await many(db, `SELECT ${isrc.columns} FROM ${isrc.from} WHERE ${isrc.where} ORDER BY ${isrc.order} LIMIT 30`, ip.values);
      const pp = new Params();
      const predSrc = insightSource(a, pp, "i.kind = 'prediction'");
      const preds = predSrc ? await many(db, `SELECT ${predSrc.columns} FROM ${predSrc.from} WHERE ${predSrc.where} ORDER BY ${predSrc.order} LIMIT 10`, pp.values) : [];
      return {
        kind,
        available,
        generatedAt: new Date().toISOString(),
        dataFreshness: {
          mailboxConnected: (mailbox?.connected ?? 0) > 0,
          lastMailboxSync: mailbox?.at ?? null,
          stale: (mailbox?.connected ?? 0) > 0 && (!mailbox?.at || Date.now() - new Date(mailbox.at).getTime() > 30 * 60_000),
        },
        kpis,
        exceptions,
        predictions: preds,
        charts: await charts(db, a, kind),
      };
    });
  });

  app.get('/dashboard/kpi/:code', async (req) => {
    const a = requireOrg(req);
    const def = KPIS.find((k) => k.code === (req.params as any).code);
    if (!def) throw notFound();
    if (!a.permissions.has(def.permission)) throw new ApiError(403, 'forbidden');
    const q = z.object({ comparison: z.enum(['0', '1']).optional(), breakdown: z.string().max(40).optional() }).parse(req.query);
    return orgTx(a, async (db) => {
      const period = q.comparison === '1' && def.comparison ? def.comparison(today()) : def.period(today());
      const r: any = await runKpi(db, a, def, period);
      let rows = r.rows;
      if (q.breakdown) rows = rows.filter((x: any) => x.type === q.breakdown || x.status === q.breakdown || (q.breakdown === 'overdue' ? x.overdue : q.breakdown === 'on_time' ? !x.overdue : false) || (q.breakdown === 'expired' ? x.expired : q.breakdown === 'expiring' ? x.expired === false : false) || x.cost_currency === q.breakdown);
      return { code: def.code, period, value: r.value, rows };
    });
  });

  // Chart drill-down: the records behind one bar segment, through the same scoped predicate.
  app.get('/dashboard/chart/requests-by-status', async (req) => {
    const a = need(req, 'request:view');
    const q = z.object({ type: z.string().max(20).optional(), status: z.string().max(30).optional() }).parse(req.query);
    return orgTx(a, async (db) => {
      const p = new Params();
      const conds = [requestScope(a, p), "r.status <> 'cancelled'", `r.starts_at >= now() - interval '1 day'`, `r.starts_at < now() + interval '30 days'`];
      if (q.type) conds.push(`r.type = ${p.add(q.type)}`);
      if (q.status) conds.push(`r.status = ${p.add(q.status)}`);
      return many(db, `SELECT r.id, r.reference, r.type, r.status, r.starts_at, pe.full_name AS person FROM service_requests r JOIN personnel pe ON pe.id = r.personnel_id WHERE ${conds.join(' AND ')} ORDER BY r.starts_at`, p.values);
    });
  });

  app.get('/insights', async (req) => {
    const a = requireOrg(req);
    const q = req.query as Record<string, string>;
    return orgTx(a, async (db) => {
      const p = new Params();
      const extra = [q.crewChangeId ? `i.crew_change_id = ${p.add(idParam(q.crewChangeId))}` : 'true', q.kind ? `i.kind = ${p.add(q.kind)}` : 'true'].join(' AND ');
      const src = insightSource(a, p, extra);
      if (!src) return [];
      return many(db, `SELECT ${src.columns} FROM ${src.from} WHERE ${src.where} ORDER BY ${src.order} LIMIT 200`, p.values);
    });
  });

  app.post('/insights/:id/acknowledge', async (req) => {
    const a = need(req, 'crew_change:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const p = new Params();
      const src = insightSource(a, p, `i.id = ${p.add(id)}`);
      if (!src || !(await one(db, `SELECT i.id FROM ${src.from} WHERE ${src.where}`, p.values))) throw notFound();
      await db.query("UPDATE insights SET status = 'acknowledged', acknowledged_by = $2 WHERE id = $1", [id, a.user.id]);
      return { ok: true };
    });
  });
}

async function charts(db: Db, a: OrgContext, kind: string) {
  if (!['coordination', 'management'].includes(kind) || !can(a, 'request:view')) return {};
  const p = new Params();
  const rows = await many(
    db,
    `SELECT r.type, r.status, count(*)::int AS n FROM service_requests r
     WHERE ${requestScope(a, p)} AND r.status <> 'cancelled' AND r.starts_at >= now() - interval '1 day' AND r.starts_at < now() + interval '30 days'
     GROUP BY r.type, r.status ORDER BY r.type, r.status`,
    p.values,
  );
  const p2 = new Params();
  const weekly = await many(
    db,
    `SELECT date_trunc('week', cc.scheduled_on)::date AS week, count(*)::int AS n, count(*) FILTER (WHERE cc.status IN ('approved', 'in_progress', 'completed'))::int AS approved
     FROM crew_changes cc WHERE ${crewChangeScope(a, p2)} AND cc.status <> 'cancelled' AND cc.scheduled_on BETWEEN current_date - 28 AND current_date + 56
     GROUP BY 1 ORDER BY 1`,
    p2.values,
  );
  return { requestsByStatus: { period: { from: addDays(today(), -1), to: addDays(today(), 30) }, rows, drill: '/api/dashboard/chart/requests-by-status' }, crewChangesByWeek: { rows: weekly } };
}

export { KPIS };
