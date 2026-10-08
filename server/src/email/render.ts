import type { Db } from '../db/pool.js';
import { many } from '../db/pool.js';
import { st, type Lang } from '../i18n/server-messages.js';
import { localDate } from '../util/time.js';
import type { Row } from './xlsx.js';

/**
 * Builds the exact rows used for an attachment and stored as its source snapshot. Identity
 * fields are only included for templates whose confidentiality class is "identity", and
 * medical details are never included in any outbound spreadsheet.
 */
export async function buildSnapshotRows(db: Db, orgId: string, requestIds: string[], opts: { includeIdentity: boolean; language: Lang }) {
  const rows = await many(
    db,
    `SELECT r.*, pe.full_name, pe.employee_no, pe.phone, pe.email AS person_email, pe.nationality, pe.job_title,
            cc.reference AS cc_reference, cc.scheduled_on, cc.embarkation_point, s.name AS asset_name, s.code AS asset_code,
            sup.name AS supplier_name
     FROM service_requests r JOIN personnel pe ON pe.id = r.personnel_id
     LEFT JOIN crew_changes cc ON cc.id = r.crew_change_id LEFT JOIN assets s ON s.id = cc.asset_id
     LEFT JOIN suppliers sup ON sup.id = r.supplier_id
     WHERE r.org_id = $1 AND r.id = ANY($2::uuid[]) ORDER BY r.starts_at NULLS LAST, pe.full_name`,
    [orgId, requestIds],
  );
  const identity = opts.includeIdentity
    ? await many(db, 'SELECT * FROM personnel_identity WHERE org_id = $1 AND personnel_id = ANY($2::uuid[])', [orgId, rows.map((r) => r.personnel_id)])
    : [];
  return rows.map((r) => {
    const out: Row = {
      'request.id': r.id,
      'request.reference': r.reference,
      'request.type': st(opts.language, `type.${r.type}`),
      'request.status': st(opts.language, `status.${r.status}`),
      'request.booking_reference': r.booking_reference,
      'request.cost_amount': r.cost_amount,
      'request.cost_currency': r.cost_currency,
      'request.version': r.version,
      'person.full_name': r.full_name,
      'person.employee_no': r.employee_no,
      'person.phone': r.phone,
      'person.email': r.person_email,
      'person.nationality': r.nationality,
      'person.job_title': r.job_title,
      'crew_change.reference': r.cc_reference,
      'crew_change.scheduled_on': r.scheduled_on,
      'crew_change.embarkation_point': r.embarkation_point,
      'asset.name': r.asset_name,
      'asset.code': r.asset_code,
      'supplier.name': r.supplier_name,
      'group.date': r.starts_at ? localDate(r.starts_at, r.location_tz) : r.scheduled_on,
      'location.timezone': r.location_tz,
    };
    for (const [k, v] of Object.entries(r.details ?? {})) {
      out[`details.${k}`] = v as string;
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
        out[`details.${k}:date`] = v.slice(0, 10);
        out[`details.${k}:time`] = v.slice(11, 16);
      }
    }
    if (opts.includeIdentity) {
      const idn = identity.find((x) => x.personnel_id === r.personnel_id);
      out['identity.passport_number'] = idn?.passport_number ?? null;
      out['identity.passport_country'] = idn?.passport_country ?? null;
      out['identity.passport_expiry'] = idn?.passport_expiry ?? null;
      out['identity.date_of_birth'] = idn?.date_of_birth ?? null;
      out['identity.visa_type'] = idn?.visa_type ?? null;
    }
    return out;
  });
}

const VAR_RE = /\{(\w+)\}/g;

export function fillTemplate(text: string, vars: Record<string, string | number | null | undefined>) {
  return text.replace(VAR_RE, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

export function safeAttachmentName(name: string) {
  const n = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_');
  return (n.endsWith('.xlsx') ? n : `${n}.xlsx`).slice(0, 120);
}

/** One summary line per person for the email body (no restricted data). */
export function personLines(rows: Row[], lang: Lang) {
  return rows
    .map((r) => {
      const when = r['details.depart_local'] ?? r['details.pickup_local'] ?? r['details.appointment_local'] ?? r['details.check_in'] ?? r['details.starts_on'] ?? '';
      const what = [r['details.from'] && r['details.to'] ? `${r['details.from']} → ${r['details.to']}` : '', r['details.city'] ?? '', r['details.pickup_location'] ?? '', r['details.course'] ?? '']
        .filter(Boolean)
        .join(' ');
      return `- [${r['request.reference']}] ${r['person.full_name']} (${r['person.employee_no']})${what ? ` — ${what}` : ''}${when ? ` — ${String(when).replace('T', ' ')}` : ''}`;
    })
    .join('\n');
}

export type { Lang };
