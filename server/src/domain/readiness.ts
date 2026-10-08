import type { Db } from '../db/pool.js';
import { many } from '../db/pool.js';

export type CellStatus = 'valid' | 'expiring_soon' | 'expires_during' | 'expired' | 'pending_verification' | 'missing' | 'not_met';

export interface ReadinessCell {
  requirementTypeId: string;
  status: CellStatus;
  expiresOn: string | null;
  credentialId: string | null;
}

const SOON_DAYS = 60;

function addDays(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/**
 * Evaluates one requirement for one person over a period. Medical requirements only use the
 * validity of the recorded fitness certificate and the provider's recorded outcome; the
 * platform never determines fitness itself, and the reason for "not met" is not exposed.
 */
export function evaluate(
  cred: { id: string; expires_on: string | null; verification_status: string } | undefined,
  period: { from: string; to: string },
  today: string,
  medicalOutcomeOk: boolean | null,
  category: string,
): ReadinessCell['status'] {
  if (!cred) return 'missing';
  if (category === 'medical' && medicalOutcomeOk === false) return 'not_met';
  if (cred.verification_status === 'pending') return 'pending_verification';
  if (cred.verification_status === 'rejected') return 'missing';
  if (!cred.expires_on) return 'valid';
  if (cred.expires_on < period.from || cred.expires_on < today) return 'expired';
  if (cred.expires_on <= period.to) return 'expires_during';
  if (cred.expires_on <= addDays(today, SOON_DAYS)) return 'expiring_soon';
  return 'valid';
}

export async function readinessFor(
  db: Db,
  orgId: string,
  people: { personnelId: string; from: string; to: string; requirementIds: string[] }[],
) {
  if (!people.length) return new Map<string, ReadinessCell[]>();
  const ids = [...new Set(people.map((p) => p.personnelId))];
  const creds = await many(
    db,
    `SELECT DISTINCT ON (c.personnel_id, c.requirement_type_id) c.id, c.personnel_id, c.requirement_type_id, c.expires_on, c.verification_status
     FROM credentials c WHERE c.org_id = $1 AND c.personnel_id = ANY($2::uuid[]) AND c.verification_status <> 'rejected'
     ORDER BY c.personnel_id, c.requirement_type_id, c.expires_on DESC NULLS FIRST`,
    [orgId, ids],
  );
  const types = await many(db, 'SELECT id, category FROM requirement_types WHERE org_id = $1', [orgId]);
  const category = new Map(types.map((t) => [t.id, t.category]));
  const med = await many(db, 'SELECT personnel_id, fitness_status FROM personnel_medical WHERE org_id = $1 AND personnel_id = ANY($2::uuid[])', [orgId, ids]);
  const medOk = new Map(med.map((m) => [m.personnel_id, m.fitness_status === null ? null : ['fit', 'fit_with_restrictions'].includes(m.fitness_status)]));
  const today = new Date().toISOString().slice(0, 10);
  const out = new Map<string, ReadinessCell[]>();
  for (const p of people) {
    const cells = p.requirementIds.map((rt) => {
      const c = creds.find((x) => x.personnel_id === p.personnelId && x.requirement_type_id === rt);
      return {
        requirementTypeId: rt,
        status: evaluate(c, p, today, medOk.get(p.personnelId) ?? null, category.get(rt) ?? 'other'),
        expiresOn: c?.expires_on ?? null,
        credentialId: c?.id ?? null,
      };
    });
    out.set(`${p.personnelId}:${p.from}`, cells);
  }
  return out;
}

export const isReady = (cells: ReadinessCell[]) => cells.every((c) => c.status === 'valid' || c.status === 'expiring_soon');
