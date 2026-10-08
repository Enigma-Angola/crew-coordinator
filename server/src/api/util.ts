import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';
import { ApiError, notFound } from '../http/errors.js';

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

function getPath(obj: Record<string, any>, path: string) {
  return path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj: Record<string, any>, path: string, value: unknown) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    o[k] = isObj(o[k]) ? { ...o[k] } : {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

const norm = (v: unknown) => {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined || v === '') return null;
  return v;
};
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

export interface VersionedPatch {
  table: string;
  id: string;
  orgId: string;
  /** Version the client loaded. */
  version: number;
  /** Changed fields (dotted paths allowed for jsonb columns, e.g. "details.flight_no"). */
  changes: Record<string, unknown>;
  /** The values the client saw for those fields before editing. */
  base?: Record<string, unknown>;
  allowed: string[];
  actorId: string;
  touch?: { updatedBy?: boolean; updatedAt?: boolean };
}

/**
 * Optimistic concurrency with field-level merge.
 *
 * - If the record is unchanged since the client loaded it, the change is applied.
 * - If someone else changed the record but none of the fields this client edited, the edits
 *   are merged onto the latest version (nobody's change is lost).
 * - If another user changed a field this client also changed, nothing is written and a 409
 *   is returned listing each conflicting field with the base, their value and this client's
 *   value, so the user can choose how to resolve it.
 */
export async function patchVersioned(db: Db, p: VersionedPatch) {
  for (const f of Object.keys(p.changes)) {
    if (!p.allowed.includes(f) && !p.allowed.includes(f.split('.')[0] + '.*')) throw new ApiError(400, 'field_not_editable', { field: f });
  }
  const current = await one(db, `SELECT * FROM ${p.table} WHERE id = $1 AND org_id = $2 FOR UPDATE`, [p.id, p.orgId]);
  if (!current) throw notFound();

  if (current.version !== p.version) {
    const conflicts = [];
    for (const [field, mine] of Object.entries(p.changes)) {
      const theirs = getPath(current, field);
      const base = p.base ? getPath(p.base, field) ?? p.base[field] : undefined;
      if (p.base === undefined || (!same(theirs, base) && !same(theirs, mine))) {
        conflicts.push({ field, base: base ?? null, theirs: norm(theirs), mine: norm(mine) });
      }
    }
    if (conflicts.length) {
      throw new ApiError(409, 'edit_conflict', {
        currentVersion: current.version,
        current,
        conflicts,
        updatedBy: current.updated_by ?? null,
        updatedAt: current.updated_at ?? null,
      });
    }
  }

  const next: Record<string, any> = {};
  for (const [field, value] of Object.entries(p.changes)) {
    const col = field.split('.')[0];
    if (field.includes('.')) {
      next[col] = next[col] ?? (isObj(current[col]) ? { ...current[col] } : {});
      setPath(next, field, value);
    } else next[col] = value;
  }
  const cols = Object.keys(next);
  const sets = cols.map((c, i) => `${c} = $${i + 3}`);
  const values: unknown[] = cols.map((c) => next[c]);
  if (p.touch?.updatedBy !== false && 'updated_by' in current) {
    values.push(p.actorId);
    sets.push(`updated_by = $${values.length + 2}`);
  }
  if (p.touch?.updatedAt !== false && 'updated_at' in current) sets.push('updated_at = now()');
  sets.push('version = version + 1');
  const updated = await one(db, `UPDATE ${p.table} SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING *`, [
    p.id,
    current.version,
    ...values,
  ]);
  const changedFields = Object.keys(p.changes).filter((f) => !same(getPath(current, f), p.changes[f]));
  return { before: current, after: updated!, merged: current.version !== p.version, changedFields };
}

export function page(q: { limit?: unknown; offset?: unknown }) {
  const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 500);
  const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
  return { limit, offset };
}

export const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function idParam(v: unknown): string {
  if (typeof v !== 'string' || !uuidRe.test(v)) throw notFound();
  return v;
}
