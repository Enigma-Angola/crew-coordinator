import type { Db } from '../db/pool.js';
import { many, one } from '../db/pool.js';
import { CRITICAL_FIELDS, type RequestType } from './requests.js';
import { evaluate } from './readiness.js';
import { addDays, localDate } from '../util/time.js';

/**
 * Operational intelligence: connects events across modules and stores the result as
 * insights. Three kinds are kept visually and semantically distinct:
 *   fact          – directly recorded data (e.g. "supplier changed the flight")
 *   rule_warning  – a deterministic rule found a problem; every input record is listed
 *   prediction    – a statistical estimate; always carries its sample size and assumptions
 * Insights only ever *suggest* actions. Nothing here changes bookings, approvals, medical
 * status or access rights.
 */

interface Insight {
  key: string;
  kind: 'fact' | 'rule_warning' | 'prediction';
  code: string;
  severity: 'info' | 'warning' | 'critical';
  params: Record<string, unknown>;
  supporting: { type: string; id: string; label: string }[];
  assumptions: string[];
  actions: { code: string; [k: string]: unknown }[];
  crewChangeId?: string | null;
  personnelId?: string | null;
  requestId?: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const MIN_PREDICTION_SAMPLES = 5;

export async function refreshInsights(db: Db, orgId: string, change?: { changedRequestId?: string; changedFields?: string[] }) {
  const found: Insight[] = [];

  if (change?.changedRequestId) await flightChangeImpact(db, orgId, change.changedRequestId, change.changedFields ?? [], found);
  await bookingAlignment(db, orgId, found);
  await credentialRules(db, orgId, found);
  await overdueConfirmations(db, orgId, found);
  await staffingGaps(db, orgId, found);
  await overdueTasks(db, orgId, found);
  await lateConfirmationPredictions(db, orgId, found);

  for (const i of found) {
    await db.query(
      `INSERT INTO insights (org_id, dedupe_key, kind, code, severity, params, supporting, assumptions, actions, crew_change_id, personnel_id, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (org_id, dedupe_key) DO UPDATE SET severity = EXCLUDED.severity, params = EXCLUDED.params, supporting = EXCLUDED.supporting,
         assumptions = EXCLUDED.assumptions, actions = EXCLUDED.actions,
         status = CASE WHEN insights.status = 'resolved' THEN 'open' ELSE insights.status END,
         resolved_at = NULL`,
      [orgId, i.key, i.kind, i.code, i.severity, i.params, JSON.stringify(i.supporting), JSON.stringify(i.assumptions), JSON.stringify(i.actions), i.crewChangeId ?? null, i.personnelId ?? null, i.requestId ?? null],
    );
  }
  // Insights whose condition no longer holds are resolved automatically. Event-type insights
  // (a recorded flight change) persist until acknowledged or until dependents are updated.
  const keys = found.map((i) => i.key);
  await db.query(
    `UPDATE insights SET status = 'resolved', resolved_at = now()
     WHERE org_id = $1 AND status <> 'resolved' AND code <> 'flight_change_impact' AND NOT (dedupe_key = ANY($2::text[]))`,
    [orgId, keys],
  );
  await db.query(
    `UPDATE insights i SET status = 'resolved', resolved_at = now()
     WHERE i.org_id = $1 AND i.code = 'flight_change_impact' AND i.status <> 'resolved'
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(i.supporting) s
         JOIN service_requests r ON r.id = (s->>'id')::uuid
         WHERE s->>'type' = 'request' AND (s->>'role') = 'dependent' AND r.status NOT IN ('cancelled') AND r.updated_at <= i.detected_at)`,
    [orgId],
  );
}

async function flightChangeImpact(db: Db, orgId: string, requestId: string, changed: string[], out: Insight[]) {
  const r = await one(db, 'SELECT * FROM service_requests WHERE id = $1 AND org_id = $2', [requestId, orgId]);
  if (!r || r.type !== 'flight') return;
  const critical = changed.filter((f) => CRITICAL_FIELDS.flight.includes(f.replace('details.', '')));
  if (!critical.length) return;
  const dependents = await many(
    db,
    `SELECT id, reference, type, status FROM service_requests WHERE org_id = $1 AND personnel_id = $2 AND id <> $3
       AND type IN ('hotel', 'transfer') AND status NOT IN ('cancelled', 'completed')
       AND (crew_change_id IS NOT DISTINCT FROM $4)`,
    [orgId, r.personnel_id, r.id, r.crew_change_id],
  );
  if (!dependents.length) return;
  const person = await one(db, 'SELECT full_name FROM personnel WHERE id = $1', [r.personnel_id]);
  out.push({
    key: `flight_change:${r.id}:v${r.version}`,
    kind: 'rule_warning',
    code: 'flight_change_impact',
    severity: dependents.some((d) => d.status === 'confirmed') ? 'critical' : 'warning',
    params: { flight: r.reference, person: person?.full_name, fields: critical, departLocal: r.details.depart_local ?? null, arriveLocal: r.details.arrive_local ?? null, count: dependents.length },
    supporting: [
      { type: 'request', id: r.id, label: r.reference, role: 'changed' } as any,
      ...dependents.map((d) => ({ type: 'request', id: d.id, label: `${d.reference} (${d.type})`, role: 'dependent' })),
    ],
    assumptions: ['dependent_bookings_same_person_and_crew_change'],
    actions: [{ code: 'prepare_amendment', requestIds: dependents.map((d) => d.id) }],
    crewChangeId: r.crew_change_id,
    personnelId: r.personnel_id,
    requestId: r.id,
  });
}

/** Hotel and transfer timings must line up with the person's flight arrival. */
async function bookingAlignment(db: Db, orgId: string, out: Insight[]) {
  const flights = await many(
    db,
    `SELECT r.*, pe.full_name FROM service_requests r JOIN personnel pe ON pe.id = r.personnel_id
     WHERE r.org_id = $1 AND r.type = 'flight' AND r.status NOT IN ('cancelled', 'completed') AND r.ends_at IS NOT NULL AND r.ends_at > now() - interval '1 day'`,
    [orgId],
  );
  for (const f of flights) {
    const deps = await many(
      db,
      `SELECT * FROM service_requests WHERE org_id = $1 AND personnel_id = $2 AND type IN ('hotel', 'transfer') AND status NOT IN ('cancelled', 'completed')
         AND crew_change_id IS NOT DISTINCT FROM $3`,
      [orgId, f.personnel_id, f.crew_change_id],
    );
    const arrival = new Date(f.ends_at);
    const arrivalTz = f.details.arrive_tz || f.location_tz;
    for (const d of deps) {
      let problem: string | null = null;
      if (d.type === 'transfer' && d.starts_at) {
        const pickup = new Date(d.starts_at);
        const sameDay = localDate(pickup, d.location_tz) === localDate(arrival, arrivalTz);
        if (sameDay && pickup < arrival) problem = 'transfer_before_arrival';
      }
      if (d.type === 'hotel' && d.details.check_in) {
        const arrivalDate = localDate(arrival, arrivalTz);
        if (d.details.check_in > arrivalDate) problem = 'hotel_checkin_after_arrival';
        if (d.details.check_out && d.details.check_out < arrivalDate) problem = 'hotel_stay_before_arrival';
      }
      if (!problem) continue;
      out.push({
        key: `misaligned:${d.id}:${f.id}`,
        kind: 'rule_warning',
        code: problem,
        severity: d.status === 'confirmed' ? 'critical' : 'warning',
        params: { person: f.full_name, flight: f.reference, booking: d.reference, arriveLocal: f.details.arrive_local ?? null, pickupLocal: d.details.pickup_local ?? null, checkIn: d.details.check_in ?? null },
        supporting: [
          { type: 'request', id: f.id, label: f.reference },
          { type: 'request', id: d.id, label: d.reference },
        ],
        assumptions: ['times_compared_in_local_time_zone'],
        actions: [{ code: 'prepare_amendment', requestIds: [d.id] }],
        crewChangeId: d.crew_change_id,
        personnelId: d.personnel_id,
        requestId: d.id,
      });
    }
  }
}

/** Credentials that are missing, or that expire before or during an upcoming assignment. */
async function credentialRules(db: Db, orgId: string, out: Insight[]) {
  const rows = await many(
    db,
    `SELECT x.id AS assignment_id, x.personnel_id, x.starts_on, x.ends_on, x.asset_id, s.name AS asset_name, pos.requirement_ids, pe.full_name,
            (SELECT ccp.crew_change_id FROM crew_change_people ccp JOIN crew_changes cc ON cc.id = ccp.crew_change_id
              WHERE ccp.personnel_id = x.personnel_id AND ccp.direction = 'on' AND cc.status <> 'cancelled' AND cc.asset_id = x.asset_id
                AND cc.scheduled_on BETWEEN x.starts_on - 3 AND x.ends_on ORDER BY cc.scheduled_on LIMIT 1) AS crew_change_id
     FROM assignments x JOIN positions pos ON pos.id = x.position_id JOIN personnel pe ON pe.id = x.personnel_id JOIN assets s ON s.id = x.asset_id
     WHERE x.org_id = $1 AND x.status IN ('planned', 'confirmed', 'in_progress') AND x.ends_on >= $2 AND x.starts_on <= $3`,
    [orgId, today(), addDays(today(), 90)],
  );
  if (!rows.length) return;
  const types = await many(db, 'SELECT id, code, category FROM requirement_types WHERE org_id = $1', [orgId]);
  const creds = await many(
    db,
    `SELECT DISTINCT ON (personnel_id, requirement_type_id) id, personnel_id, requirement_type_id, expires_on, verification_status FROM credentials
     WHERE org_id = $1 AND verification_status <> 'rejected' ORDER BY personnel_id, requirement_type_id, expires_on DESC NULLS FIRST`,
    [orgId],
  );
  const med = await many(db, 'SELECT personnel_id, fitness_status FROM personnel_medical WHERE org_id = $1', [orgId]);
  for (const x of rows) {
    for (const rt of x.requirement_ids ?? []) {
      const t = types.find((y) => y.id === rt);
      if (!t) continue;
      const c = creds.find((y) => y.personnel_id === x.personnel_id && y.requirement_type_id === rt);
      const m = med.find((y) => y.personnel_id === x.personnel_id);
      const medOk = m?.fitness_status ? ['fit', 'fit_with_restrictions'].includes(m.fitness_status) : null;
      const status = evaluate(c, { from: x.starts_on, to: x.ends_on }, today(), medOk, t.category);
      if (['valid', 'expiring_soon'].includes(status)) continue;
      const soon = x.starts_on <= addDays(today(), 14);
      out.push({
        key: `credential:${x.assignment_id}:${rt}:${status}`,
        kind: 'rule_warning',
        code: status === 'expires_during' ? 'credential_expires_during_assignment' : `credential_${status}`,
        severity: soon || status === 'expired' || status === 'missing' || status === 'not_met' ? 'critical' : 'warning',
        params: { person: x.full_name, requirement: t.code, expiresOn: c?.expires_on ?? null, startsOn: x.starts_on, endsOn: x.ends_on, asset: x.asset_name },
        supporting: [
          { type: 'personnel', id: x.personnel_id, label: x.full_name },
          { type: 'assignment', id: x.assignment_id, label: `${x.asset_name} ${x.starts_on} → ${x.ends_on}` },
          ...(c ? [{ type: 'credential', id: c.id, label: t.code }] : []),
        ],
        assumptions: t.category === 'medical' ? ['medical_status_as_recorded_by_provider'] : ['based_on_recorded_credentials'],
        actions: [{ code: 'reassess_readiness', personnelId: x.personnel_id }, { code: 'request_document', personnelId: x.personnel_id, requirementTypeId: rt }],
        crewChangeId: x.crew_change_id,
        personnelId: x.personnel_id,
      });
    }
  }
}

/** Supplier responses that are past their deadline, with the crew changes they put at risk. */
async function overdueConfirmations(db: Db, orgId: string, out: Insight[]) {
  const rows = await many(
    db,
    `SELECT r.id, r.reference, r.type, r.status, r.response_due_at, r.crew_change_id, r.supplier_id, s.name AS supplier_name, cc.reference AS cc_ref, cc.scheduled_on
     FROM service_requests r LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN crew_changes cc ON cc.id = r.crew_change_id
     WHERE r.org_id = $1 AND r.response_due_at < now() AND r.status IN ('requested', 'acknowledged', 'quoted', 'proposed')`,
    [orgId],
  );
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const k = `${r.supplier_id}:${r.crew_change_id}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, list] of groups) {
    const first = list[0];
    const urgent = first.scheduled_on && first.scheduled_on <= addDays(today(), 3);
    out.push({
      key: `overdue:${k}`,
      kind: 'rule_warning',
      code: 'confirmation_overdue',
      severity: urgent ? 'critical' : 'warning',
      params: { supplier: first.supplier_name, crewChange: first.cc_ref, count: list.length, oldestDue: list.map((r) => r.response_due_at).sort()[0] },
      supporting: [
        ...(first.crew_change_id ? [{ type: 'crew_change', id: first.crew_change_id, label: first.cc_ref }] : []),
        ...list.map((r) => ({ type: 'request', id: r.id, label: `${r.reference} (${r.type})` })),
      ],
      assumptions: ['deadline_from_template_response_hours'],
      actions: [{ code: 'prepare_reminder', requestIds: list.map((r) => r.id) }],
      crewChangeId: first.crew_change_id,
    });
  }
}

/** Uncovered position slots, with candidates who meet every configured requirement. */
async function staffingGaps(db: Db, orgId: string, out: Insight[]) {
  const gaps = await many(
    db,
    `SELECT x.id, x.asset_id, x.position_id, x.starts_on, x.ends_on, s.name AS asset_name, pos.title, pos.requirement_ids
     FROM assignments x JOIN assets s ON s.id = x.asset_id LEFT JOIN positions pos ON pos.id = x.position_id
     WHERE x.org_id = $1 AND x.personnel_id IS NULL AND x.status <> 'cancelled' AND x.ends_on >= $2 AND x.starts_on <= $3`,
    [orgId, today(), addDays(today(), 60)],
  );
  if (!gaps.length) return;
  const people = await many(db, "SELECT id, full_name, job_title FROM personnel WHERE org_id = $1 AND status = 'active'", [orgId]);
  const creds = await many(
    db,
    `SELECT DISTINCT ON (personnel_id, requirement_type_id) personnel_id, requirement_type_id, expires_on, verification_status, id FROM credentials
     WHERE org_id = $1 AND verification_status <> 'rejected' ORDER BY personnel_id, requirement_type_id, expires_on DESC NULLS FIRST`,
    [orgId],
  );
  const types = await many(db, 'SELECT id, category FROM requirement_types WHERE org_id = $1', [orgId]);
  const med = await many(db, 'SELECT personnel_id, fitness_status FROM personnel_medical WHERE org_id = $1', [orgId]);
  for (const g of gaps) {
    const busy = new Set(
      (await many(db, `SELECT personnel_id FROM assignments WHERE org_id = $1 AND personnel_id IS NOT NULL AND status <> 'cancelled' AND starts_on <= $3 AND ends_on >= $2`, [orgId, g.starts_on, g.ends_on])).map(
        (r) => r.personnel_id,
      ),
    );
    const candidates = people
      .filter((p) => !busy.has(p.id))
      .filter((p) =>
        (g.requirement_ids ?? []).every((rt: string) => {
          const c = creds.find((x) => x.personnel_id === p.id && x.requirement_type_id === rt);
          const m = med.find((x) => x.personnel_id === p.id);
          const medOk = m?.fitness_status ? ['fit', 'fit_with_restrictions'].includes(m.fitness_status) : null;
          return ['valid', 'expiring_soon'].includes(evaluate(c, { from: g.starts_on, to: g.ends_on }, today(), medOk, types.find((t) => t.id === rt)?.category ?? 'other'));
        }),
      )
      .slice(0, 10);
    out.push({
      key: `gap:${g.id}`,
      kind: 'rule_warning',
      code: 'staffing_gap',
      severity: g.starts_on <= addDays(today(), 14) ? 'critical' : 'warning',
      params: { asset: g.asset_name, position: g.title, startsOn: g.starts_on, endsOn: g.ends_on, candidates: candidates.length },
      supporting: [
        { type: 'assignment', id: g.id, label: `${g.asset_name} · ${g.title ?? ''}` },
        ...candidates.map((c) => ({ type: 'personnel', id: c.id, label: c.full_name, role: 'candidate' }) as any),
      ],
      assumptions: ['candidates_meet_recorded_requirements', 'availability_from_assignments_only', 'medical_status_as_recorded_by_provider'],
      actions: candidates.length ? [{ code: 'assign_candidate', assignmentId: g.id, candidateIds: candidates.map((c) => c.id) }] : [{ code: 'source_externally', assignmentId: g.id }],
    });
  }
}

/** Overdue onboarding/verification tasks, the responsible person and what they block. */
async function overdueTasks(db: Db, orgId: string, out: Insight[]) {
  const rows = await many(
    db,
    `SELECT t.id, t.title, t.kind, t.due_at, t.assignee_id, u.display_name AS assignee, t.personnel_id, pe.full_name, t.crew_change_id
     FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN personnel pe ON pe.id = t.personnel_id
     WHERE t.org_id = $1 AND t.status IN ('todo', 'in_progress', 'blocked') AND t.due_at < now() AND t.kind IN ('onboarding', 'verification', 'document_request', 'mobilisation')`,
    [orgId],
  );
  for (const t of rows) {
    const downstream = t.personnel_id
      ? await many(
          db,
          `SELECT cc.id, cc.reference, cc.scheduled_on FROM crew_change_people ccp JOIN crew_changes cc ON cc.id = ccp.crew_change_id
           WHERE ccp.personnel_id = $1 AND ccp.direction = 'on' AND cc.status NOT IN ('cancelled', 'completed') AND cc.scheduled_on >= $2 ORDER BY cc.scheduled_on`,
          [t.personnel_id, today()],
        )
      : [];
    if (t.crew_change_id && !downstream.some((d) => d.id === t.crew_change_id)) {
      const cc = await one(db, 'SELECT id, reference, scheduled_on FROM crew_changes WHERE id = $1', [t.crew_change_id]);
      if (cc) downstream.push(cc);
    }
    out.push({
      key: `task_overdue:${t.id}`,
      kind: 'rule_warning',
      code: 'task_overdue_impact',
      severity: downstream.some((d) => d.scheduled_on <= addDays(today(), 7)) ? 'critical' : 'warning',
      params: { task: t.title, assignee: t.assignee ?? null, dueAt: t.due_at, person: t.full_name ?? null, blocked: downstream.length },
      supporting: [
        { type: 'task', id: t.id, label: t.title },
        ...(t.assignee_id ? [{ type: 'user', id: t.assignee_id, label: t.assignee }] : []),
        ...downstream.map((d) => ({ type: 'crew_change', id: d.id, label: `${d.reference} (${d.scheduled_on})` })),
      ],
      assumptions: ['downstream_from_crew_change_membership'],
      actions: [{ code: 'notify_assignee', taskId: t.id }],
      crewChangeId: downstream[0]?.id ?? null,
      personnelId: t.personnel_id,
    });
  }
}

/**
 * Prediction: open requests likely to be confirmed late, based on the supplier's own median
 * response time. Only produced with at least MIN_PREDICTION_SAMPLES past responses.
 */
async function lateConfirmationPredictions(db: Db, orgId: string, out: Insight[]) {
  const stats = await many(
    db,
    `SELECT supplier_id, count(*)::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_response_at - first_requested_at) / 3600) AS median_hours
     FROM service_requests WHERE org_id = $1 AND first_requested_at IS NOT NULL AND first_response_at IS NOT NULL AND supplier_id IS NOT NULL
     GROUP BY supplier_id`,
    [orgId],
  );
  const open = await many(
    db,
    `SELECT r.id, r.reference, r.supplier_id, r.first_requested_at, r.response_due_at, r.crew_change_id, s.name AS supplier_name
     FROM service_requests r JOIN suppliers s ON s.id = r.supplier_id
     WHERE r.org_id = $1 AND r.status = 'requested' AND r.first_response_at IS NULL AND r.response_due_at > now() AND r.first_requested_at IS NOT NULL`,
    [orgId],
  );
  for (const r of open) {
    const st = stats.find((s) => s.supplier_id === r.supplier_id);
    if (!st || st.n < MIN_PREDICTION_SAMPLES) continue;
    const expected = new Date(new Date(r.first_requested_at).getTime() + Number(st.median_hours) * 3600_000);
    if (expected <= new Date(r.response_due_at)) continue;
    out.push({
      key: `predict_late:${r.id}`,
      kind: 'prediction',
      code: 'confirmation_likely_late',
      severity: 'info',
      params: { request: r.reference, supplier: r.supplier_name, medianHours: Math.round(Number(st.median_hours) * 10) / 10, samples: st.n, dueAt: r.response_due_at, expectedAt: expected.toISOString() },
      supporting: [{ type: 'request', id: r.id, label: r.reference }],
      assumptions: ['supplier_median_response_time', 'past_behaviour_predicts_future'],
      actions: [{ code: 'consider_early_follow_up', requestIds: [r.id] }],
      crewChangeId: r.crew_change_id,
      requestId: r.id,
    });
  }
}

export type { RequestType };
