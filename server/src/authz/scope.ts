import type { OrgContext } from '../http/guard.js';

/** Accumulates positional SQL parameters. */
export class Params {
  values: unknown[] = [];
  add(v: unknown) {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/*
 * Record-scope predicates. Organisation isolation is enforced by RLS and by the explicit
 * org_id predicates below; these functions add the narrower scopes that depend on who is
 * asking: an employee's own records, a supplier's own requests, an asset-scoped coordinator.
 * Every list, detail, total, export and AI retrieval goes through them.
 */

export function personnelScope(a: OrgContext, p: Params, alias = 'p'): string {
  const conds = [`${alias}.org_id = ${p.add(a.org.id)}`];
  const role = a.membership.role;
  if (role === 'employee') conds.push(a.personnelId ? `${alias}.id = ${p.add(a.personnelId)}` : 'false');
  else if (role === 'supplier') {
    // Suppliers only see passengers on requests assigned to them (permitted fields only).
    conds.push(`EXISTS (SELECT 1 FROM service_requests sr WHERE sr.personnel_id = ${alias}.id AND sr.supplier_id = ${p.add(a.membership.supplier_id)})`);
  } else if (a.membership.asset_scope?.length) {
    const s = p.add(a.membership.asset_scope);
    conds.push(
      `(EXISTS (SELECT 1 FROM assignments x WHERE x.personnel_id = ${alias}.id AND x.asset_id = ANY(${s}::uuid[]))
        OR NOT EXISTS (SELECT 1 FROM assignments x WHERE x.personnel_id = ${alias}.id))`,
    );
  }
  return conds.join(' AND ');
}

export function crewChangeScope(a: OrgContext, p: Params, alias = 'cc'): string {
  const conds = [`${alias}.org_id = ${p.add(a.org.id)}`];
  const role = a.membership.role;
  if (role === 'employee') {
    conds.push(
      a.personnelId
        ? `EXISTS (SELECT 1 FROM crew_change_people ccp WHERE ccp.crew_change_id = ${alias}.id AND ccp.personnel_id = ${p.add(a.personnelId)})`
        : 'false',
    );
  } else if (role === 'supplier') {
    conds.push('false');
  } else if (a.membership.asset_scope?.length) {
    conds.push(`${alias}.asset_id = ANY(${p.add(a.membership.asset_scope)}::uuid[])`);
  }
  return conds.join(' AND ');
}

export function requestScope(a: OrgContext, p: Params, alias = 'r'): string {
  const conds = [`${alias}.org_id = ${p.add(a.org.id)}`];
  const role = a.membership.role;
  if (role === 'employee') conds.push(a.personnelId ? `${alias}.personnel_id = ${p.add(a.personnelId)}` : 'false');
  else if (role === 'supplier') {
    // Draft requests have not been sent to the supplier yet and are not visible to them.
    conds.push(`${alias}.supplier_id = ${p.add(a.membership.supplier_id)} AND ${alias}.status <> 'draft'`);
  } else if (a.membership.asset_scope?.length) {
    const s = p.add(a.membership.asset_scope);
    conds.push(
      `(EXISTS (SELECT 1 FROM crew_changes c2 WHERE c2.id = ${alias}.crew_change_id AND c2.asset_id = ANY(${s}::uuid[]))
        OR (${alias}.crew_change_id IS NULL AND (
          EXISTS (SELECT 1 FROM assignments x WHERE x.personnel_id = ${alias}.personnel_id AND x.asset_id = ANY(${s}::uuid[]))
          OR NOT EXISTS (SELECT 1 FROM assignments x WHERE x.personnel_id = ${alias}.personnel_id))))`,
    );
  }
  return conds.join(' AND ');
}

export function taskScope(a: OrgContext, p: Params, alias = 't'): string {
  const conds = [`${alias}.org_id = ${p.add(a.org.id)}`];
  const role = a.membership.role;
  if (role === 'employee') conds.push(`(${alias}.assignee_id = ${p.add(a.user.id)})`);
  else if (role === 'supplier') conds.push('false');
  else if (a.membership.asset_scope?.length) {
    const s = p.add(a.membership.asset_scope);
    conds.push(
      `(${alias}.crew_change_id IS NULL OR EXISTS (SELECT 1 FROM crew_changes c3 WHERE c3.id = ${alias}.crew_change_id AND c3.asset_id = ANY(${s}::uuid[])))`,
    );
  }
  return conds.join(' AND ');
}

export function assetScope(a: OrgContext, p: Params, alias = 'a'): string {
  const conds = [`${alias}.org_id = ${p.add(a.org.id)}`];
  if (a.membership.asset_scope?.length) conds.push(`${alias}.id = ANY(${p.add(a.membership.asset_scope)}::uuid[])`);
  if (a.membership.role === 'supplier') conds.push('false');
  return conds.join(' AND ');
}

/** Personnel fields a supplier may see for an assigned request, by request type. */
export const SUPPLIER_PERSONNEL_FIELDS: Record<string, string[]> = {
  flight: ['full_name', 'employee_no', 'phone', 'nationality'],
  hotel: ['full_name', 'employee_no', 'phone'],
  transfer: ['full_name', 'employee_no', 'phone'],
  medical: ['full_name', 'employee_no'],
  training: ['full_name', 'employee_no', 'job_title'],
  immigration: ['full_name', 'employee_no', 'nationality'],
};
