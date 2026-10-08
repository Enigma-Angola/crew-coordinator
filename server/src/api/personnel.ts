import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { many, one, type Db } from '../db/pool.js';
import { actorOf, can, need, orgTx, type OrgContext } from '../http/guard.js';
import { ApiError, badRequest, notFound } from '../http/errors.js';
import { Params, personnelScope } from '../authz/scope.js';
import { emitChange } from '../realtime/events.js';
import { readinessFor } from '../domain/readiness.js';
import { getObject, putObject, safeFilename, scanForMalware, signLink, sniff, verifyLink } from '../storage/files.js';
import { idParam, page, patchVersioned } from './util.js';

const BASE_FIELDS = 'p.id, p.employee_no, p.full_name, p.email, p.phone, p.nationality, p.job_title, p.home_base, p.employer, p.status, p.user_id, p.version, p.updated_at, p.updated_by';
const SUPPLIER_FIELDS = 'p.id, p.employee_no, p.full_name';

export async function loadPersonnel(db: Db, a: OrgContext, id: string) {
  const p = new Params();
  const idP = p.add(id);
  const fields = a.membership.role === 'supplier' ? SUPPLIER_FIELDS : BASE_FIELDS;
  const row = await one(db, `SELECT ${fields} FROM personnel p WHERE p.id = ${idP} AND ${personnelScope(a, p)}`, p.values);
  if (!row) throw notFound();
  return row;
}

const isSelf = (a: OrgContext, personnelId: string) => a.personnelId === personnelId;
export const canSeeIdentity = (a: OrgContext, personnelId: string) => can(a, 'identity:view') || isSelf(a, personnelId);
export const canSeeMedical = (a: OrgContext, personnelId: string) => can(a, 'medical:view') || isSelf(a, personnelId);

export function canSeeDocument(a: OrgContext, doc: { classification: string; personnel_id: string | null }) {
  if (!can(a, 'documents:view')) return false;
  if (doc.classification === 'identity') return doc.personnel_id ? canSeeIdentity(a, doc.personnel_id) : can(a, 'identity:view');
  if (doc.classification === 'medical') return doc.personnel_id ? canSeeMedical(a, doc.personnel_id) : can(a, 'medical:view');
  return true;
}

const personSchema = z.object({
  employee_no: z.string().trim().min(1).max(40),
  full_name: z.string().trim().min(1).max(160),
  email: z.string().email().max(200).nullish(),
  phone: z.string().max(40).nullish(),
  nationality: z.string().max(60).nullish(),
  job_title: z.string().max(120).nullish(),
  home_base: z.string().max(120).nullish(),
  employer: z.string().max(160).nullish(),
  status: z.enum(['onboarding', 'active', 'inactive']).default('active'),
});

const EDITABLE = ['full_name', 'email', 'phone', 'nationality', 'job_title', 'home_base', 'employer', 'status'];

export async function personnelRoutes(app: FastifyInstance) {
  app.get('/personnel', async (req) => {
    const a = need(req, 'personnel:view');
    const q = req.query as Record<string, string>;
    const { limit, offset } = page(q);
    return orgTx(a, async (db) => {
      const p = new Params();
      const conds = [personnelScope(a, p)];
      if (q.q) conds.push(`(p.full_name ILIKE ${p.add(`%${q.q}%`)} OR p.employee_no ILIKE ${p.add(`%${q.q}%`)})`);
      if (q.status) conds.push(`p.status = ${p.add(q.status)}`);
      const where = conds.join(' AND ');
      const rows = await many(db, `SELECT ${BASE_FIELDS} FROM personnel p WHERE ${where} ORDER BY p.full_name LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`, p.values);
      const total = await one(db, `SELECT count(*)::int AS n FROM personnel p WHERE ${where}`, p.values.slice(0, -2));
      return { rows, total: total.n };
    });
  });

  app.get('/personnel/:id', async (req) => {
    const a = need(req, 'personnel:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const person = await loadPersonnel(db, a, id);
      const identity = canSeeIdentity(a, id) ? await one(db, 'SELECT * FROM personnel_identity WHERE personnel_id = $1', [id]) : undefined;
      const medical = canSeeMedical(a, id) ? await one(db, 'SELECT * FROM personnel_medical WHERE personnel_id = $1', [id]) : undefined;
      if (identity !== undefined || medical !== undefined) {
        await audit(db, actorOf(a), {
          orgId: a.org.id,
          action: 'personnel.restricted_viewed',
          entityType: 'personnel',
          entityId: id,
          metadata: { identity: identity !== undefined, medical: medical !== undefined },
        });
      }
      const credentials = await many(
        db,
        `SELECT c.id, c.requirement_type_id, rt.code, rt.name_en, rt.name_pt, rt.category, c.reference, c.issued_on, c.expires_on,
                c.verification_status, c.verified_at, c.document_id, c.version
         FROM credentials c JOIN requirement_types rt ON rt.id = c.requirement_type_id WHERE c.personnel_id = $1 ORDER BY rt.code`,
        [id],
      );
      const docs = (
        await many(
          db,
          `SELECT id, classification, filename, mime_type, size_bytes, scan_status, uploaded_at, personnel_id FROM documents
           WHERE personnel_id = $1 AND deleted_at IS NULL ORDER BY uploaded_at DESC`,
          [id],
        )
      ).filter((d) => canSeeDocument(a, d));
      const assignments = await many(
        db,
        `SELECT x.id, x.asset_id, s.name AS asset_name, x.position_id, pos.title AS position_title, pos.requirement_ids,
                x.starts_on, x.ends_on, x.status
         FROM assignments x JOIN assets s ON s.id = x.asset_id LEFT JOIN positions pos ON pos.id = x.position_id
         WHERE x.personnel_id = $1 AND x.status <> 'cancelled' ORDER BY x.starts_on`,
        [id],
      );
      const readiness = await readinessFor(
        db,
        a.org.id,
        assignments
          .filter((x) => x.ends_on >= new Date().toISOString().slice(0, 10))
          .map((x) => ({ personnelId: id, from: x.starts_on, to: x.ends_on, requirementIds: x.requirement_ids ?? [] })),
      );
      return {
        ...person,
        identity: identity === undefined ? { restricted: true } : identity,
        medical: medical === undefined ? { restricted: true } : medical,
        credentials,
        documents: docs,
        assignments: assignments.map((x) => ({ ...x, readiness: readiness.get(`${id}:${x.starts_on}`) ?? null })),
      };
    });
  });

  app.post('/personnel', async (req) => {
    const a = need(req, 'personnel:edit');
    const b = personSchema.parse(req.body);
    return orgTx(a, async (db) => {
      const exists = await one(db, 'SELECT id FROM personnel WHERE org_id = $1 AND employee_no = $2', [a.org.id, b.employee_no]);
      if (exists) throw new ApiError(409, 'duplicate_employee_no');
      const row = await one(
        db,
        `INSERT INTO personnel (org_id, employee_no, full_name, email, phone, nationality, job_title, home_base, employer, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
        [a.org.id, b.employee_no, b.full_name, b.email ?? null, b.phone ?? null, b.nationality ?? null, b.job_title ?? null, b.home_base ?? null, b.employer ?? null, b.status, a.user.id],
      );
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'personnel.created', entityType: 'personnel', entityId: row.id });
      await emitChange(db, a.org.id, 'personnel', row.id, row.version, a.user.id);
      return row;
    });
  });

  app.patch('/personnel/:id', async (req) => {
    const a = need(req, 'personnel:edit');
    const id = idParam((req.params as any).id);
    const b = z.object({ version: z.number().int(), changes: z.record(z.string(), z.unknown()), base: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    const changes = personSchema.partial().omit({ employee_no: true }).strict().parse(b.changes);
    return orgTx(a, async (db) => {
      await loadPersonnel(db, a, id);
      const r = await patchVersioned(db, { table: 'personnel', id, orgId: a.org.id, version: b.version, changes, base: b.base, allowed: EDITABLE, actorId: a.user.id });
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'personnel.updated', entityType: 'personnel', entityId: id, metadata: { fields: r.changedFields, merged: r.merged } });
      await emitChange(db, a.org.id, 'personnel', id, r.after.version, a.user.id);
      return { record: r.after, merged: r.merged };
    });
  });

  for (const kind of ['identity', 'medical'] as const) {
    const table = kind === 'identity' ? 'personnel_identity' : 'personnel_medical';
    const schema =
      kind === 'identity'
        ? z.object({
            date_of_birth: z.string().date().nullish(),
            passport_number: z.string().max(40).nullish(),
            passport_country: z.string().max(60).nullish(),
            passport_expiry: z.string().date().nullish(),
            visa_type: z.string().max(60).nullish(),
            visa_expiry: z.string().date().nullish(),
          })
        : z.object({
            fitness_status: z.enum(['fit', 'fit_with_restrictions', 'unfit', 'pending']).nullish(),
            examined_on: z.string().date().nullish(),
            expires_on: z.string().date().nullish(),
            restrictions: z.string().max(1000).nullish(),
            provider_name: z.string().max(160).nullish(),
          });
    app.put(`/personnel/:id/${kind}`, async (req) => {
      const a = need(req, `${kind}:edit`);
      const id = idParam((req.params as any).id);
      const b = z.object({ version: z.number().int().nullable(), values: schema.strict() }).parse(req.body);
      return orgTx(a, async (db) => {
        await loadPersonnel(db, a, id);
        const existing = await one(db, `SELECT * FROM ${table} WHERE personnel_id = $1 FOR UPDATE`, [id]);
        let row;
        if (!existing) {
          const cols = Object.keys(b.values);
          row = await one(
            db,
            `INSERT INTO ${table} (personnel_id, org_id, updated_by${cols.map((c) => `, ${c}`).join('')}) VALUES ($1,$2,$3${cols.map((_, i) => `, $${i + 4}`).join('')}) RETURNING *`,
            [id, a.org.id, a.user.id, ...cols.map((c) => (b.values as any)[c] ?? null)],
          );
        } else {
          if (existing.version !== b.version) throw new ApiError(409, 'edit_conflict', { currentVersion: existing.version, conflicts: Object.keys(b.values).map((f) => ({ field: f })) });
          const cols = Object.keys(b.values);
          row = await one(
            db,
            `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}${cols.length ? ',' : ''} updated_by = $2, updated_at = now(), version = version + 1
             WHERE personnel_id = $1 RETURNING *`,
            [id, a.user.id, ...cols.map((c) => (b.values as any)[c] ?? null)],
          );
        }
        // Field names only; the values themselves are restricted and stay out of the audit log.
        await audit(db, actorOf(a), { orgId: a.org.id, action: `personnel.${kind}_updated`, entityType: 'personnel', entityId: id, metadata: { fields: Object.keys(b.values) } });
        return row;
      });
    });
  }

  app.get('/requirement-types', async (req) => {
    const a = need(req, 'personnel:view');
    return orgTx(a, (db) => many(db, 'SELECT id, code, name_en, name_pt, category FROM requirement_types WHERE org_id = $1 ORDER BY code', [a.org.id]));
  });

  app.post('/personnel/:id/credentials', async (req) => {
    const a = need(req, 'personnel:view');
    const id = idParam((req.params as any).id);
    const b = z
      .object({ requirementTypeId: z.string().uuid(), reference: z.string().max(80).nullish(), issuedOn: z.string().date().nullish(), expiresOn: z.string().date().nullish(), documentId: z.string().uuid().nullish() })
      .parse(req.body);
    // HR/compliance can record credentials for anyone; employees can submit their own for verification.
    if (!can(a, 'personnel:edit') && !isSelf(a, id)) throw new ApiError(403, 'forbidden');
    return orgTx(a, async (db) => {
      await loadPersonnel(db, a, id);
      const rt = await one(db, 'SELECT id FROM requirement_types WHERE id = $1 AND org_id = $2', [b.requirementTypeId, a.org.id]);
      if (!rt) throw notFound();
      if (b.documentId && !(await one(db, 'SELECT id FROM documents WHERE id = $1 AND personnel_id = $2', [b.documentId, id]))) throw notFound();
      const row = await one(
        db,
        `INSERT INTO credentials (org_id, personnel_id, requirement_type_id, reference, issued_on, expires_on, document_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [a.org.id, id, b.requirementTypeId, b.reference ?? null, b.issuedOn ?? null, b.expiresOn ?? null, b.documentId ?? null, a.user.id],
      );
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'credential.recorded', entityType: 'credential', entityId: row.id, metadata: { personnelId: id } });
      await emitChange(db, a.org.id, 'personnel', id, null, a.user.id);
      return row;
    });
  });

  app.post('/credentials/:id/verify', async (req) => {
    const a = need(req, 'credentials:verify');
    const id = idParam((req.params as any).id);
    const b = z.object({ outcome: z.enum(['verified', 'rejected']), version: z.number().int() }).parse(req.body);
    return orgTx(a, async (db) => {
      const c = await one(db, 'SELECT * FROM credentials WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, a.org.id]);
      if (!c) throw notFound();
      // Segregation of duties: whoever recorded a credential cannot also verify it.
      if (c.created_by === a.user.id) throw new ApiError(403, 'segregation_of_duties');
      if (c.version !== b.version) throw new ApiError(409, 'edit_conflict', { currentVersion: c.version, conflicts: [{ field: 'verification_status' }] });
      const row = await one(
        db,
        'UPDATE credentials SET verification_status = $2, verified_by = $3, verified_at = now(), version = version + 1 WHERE id = $1 RETURNING *',
        [id, b.outcome, a.user.id],
      );
      await db.query("UPDATE tasks SET status = 'done', completed_at = now(), version = version + 1 WHERE kind = 'verification' AND personnel_id = $1 AND status <> 'done' AND description LIKE $2", [
        c.personnel_id,
        `%${id}%`,
      ]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: `credential.${b.outcome}`, entityType: 'credential', entityId: id });
      await emitChange(db, a.org.id, 'personnel', c.personnel_id, null, a.user.id);
      return row;
    });
  });

  app.post('/personnel/:id/documents', async (req) => {
    const a = need(req, 'documents:view');
    const id = idParam((req.params as any).id);
    const file = await req.file();
    if (!file) throw badRequest('file_required');
    const classification = z.enum(['general', 'identity', 'medical']).parse((file.fields.classification as any)?.value ?? 'general');
    const data = await file.toBuffer();
    if (!can(a, 'documents:upload') && !isSelf(a, id)) throw new ApiError(403, 'forbidden');
    if (classification === 'identity' && !can(a, 'identity:edit') && !isSelf(a, id)) throw new ApiError(403, 'forbidden');
    if (classification === 'medical' && !can(a, 'medical:edit') && !isSelf(a, id)) throw new ApiError(403, 'forbidden');
    const type = sniff(data, file.filename);
    if (!type || ![ 'application/pdf', 'image/png', 'image/jpeg'].includes(type.mime)) throw badRequest('file_type_not_allowed');
    return orgTx(a, async (db) => {
      await loadPersonnel(db, a, id);
      const stored = await putObject(a.org.id, data);
      // Stored in quarantine first; it becomes downloadable only after a clean scan result.
      const doc = await one(
        db,
        `INSERT INTO documents (org_id, personnel_id, classification, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, classification, filename, mime_type, size_bytes, scan_status, uploaded_at`,
        [a.org.id, id, classification, safeFilename(file.filename), type.mime, stored.size, stored.sha256, stored.key, a.user.id],
      );
      const scan = await scanForMalware(data);
      await db.query('UPDATE documents SET scan_status = $2, scan_detail = $3, scanned_at = CASE WHEN $2 <> $4 THEN now() END WHERE id = $1', [
        doc.id,
        scan.status,
        scan.detail,
        'quarantined',
      ]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'document.uploaded', entityType: 'document', entityId: doc.id, metadata: { classification, scan: scan.status } });
      return { ...doc, scan_status: scan.status };
    });
  });

  app.post('/documents/:id/link', async (req) => {
    const a = need(req, 'documents:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const d = await one(db, 'SELECT * FROM documents WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL', [id, a.org.id]);
      if (!d) throw notFound();
      if (d.personnel_id) await loadPersonnel(db, a, d.personnel_id);
      if (!canSeeDocument(a, d)) throw notFound();
      if (d.scan_status !== 'clean') throw new ApiError(423, 'file_quarantined', { scanStatus: d.scan_status });
      return { url: `/api/files/${signLink({ kind: 'document', id, org: a.org.id, sid: a.session.id })}`, expiresInSeconds: 60 };
    });
  });

  app.post('/personnel/import', async (req) => {
    const a = need(req, 'personnel:import');
    const dryRun = (req.query as any).dryRun !== '0';
    const file = await req.file();
    if (!file) throw badRequest('file_required');
    const data = await file.toBuffer();
    const type = sniff(data, file.filename);
    if (!type || !['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(type.mime)) throw badRequest('file_type_not_allowed');
    const rows = type.ext === 'csv' ? parseCsv(data.toString('utf8')) : await parseXlsx(data);
    return orgTx(a, (db) => importRoster(db, a, rows, dryRun));
  });
}

/* Roster import -------------------------------------------------------------------------- */

export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  const delimiter = (src.split('\n')[0].match(/;/g)?.length ?? 0) > (src.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    records.push(row);
  }
  const [header, ...body] = records.filter((r) => r.some((v) => v.trim()));
  if (!header) return [];
  const keys = header.map(normaliseHeader);
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

async function parseXlsx(data: Buffer): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as any);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const header: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => (header[col - 1] = normaliseHeader(String(cell.text ?? ''))));
  const out: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      const cell = row.getCell(i + 1);
      const v = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : String(cell.text ?? '');
      rec[h] = v.trim();
    });
    if (Object.values(rec).some((v) => v)) out.push(rec);
  });
  return out;
}

const HEADER_ALIASES: Record<string, string> = {
  employee_no: 'employee_no', employee_number: 'employee_no', n_colaborador: 'employee_no', numero: 'employee_no', id: 'employee_no',
  full_name: 'full_name', name: 'full_name', nome: 'full_name', nome_completo: 'full_name',
  email: 'email', phone: 'phone', telefone: 'phone', nationality: 'nationality', nacionalidade: 'nationality',
  job_title: 'job_title', position: 'job_title', funcao: 'job_title', home_base: 'home_base', base: 'home_base',
  employer: 'employer', empregador: 'employer', status: 'status', estado: 'status',
  asset_code: 'asset_code', asset: 'asset_code', unidade: 'asset_code', starts_on: 'starts_on', start: 'starts_on', inicio: 'starts_on',
  ends_on: 'ends_on', end: 'ends_on', fim: 'ends_on',
};

function normaliseHeader(h: string) {
  const k = h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return HEADER_ALIASES[k] ?? k;
}

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
function toIsoDate(v: string) {
  if (!v) return null;
  if (dateRe.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy (European)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return 'invalid';
}

export async function importRoster(db: Db, a: OrgContext, rows: Record<string, string>[], dryRun: boolean) {
  const assets = await many(db, 'SELECT id, code FROM assets WHERE org_id = $1', [a.org.id]);
  const report = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const errors: string[] = [];
    if (!r.employee_no) errors.push('missing_employee_no');
    if (!r.full_name) errors.push('missing_full_name');
    if (r.employee_no && seen.has(r.employee_no)) errors.push('duplicate_in_file');
    if (r.email && !z.string().email().safeParse(r.email).success) errors.push('invalid_email');
    if (r.status && !['onboarding', 'active', 'inactive'].includes(r.status)) errors.push('invalid_status');
    const asset = r.asset_code ? assets.find((x) => x.code === r.asset_code) : null;
    if (r.asset_code && !asset) errors.push('unknown_asset');
    const starts = toIsoDate(r.starts_on ?? '');
    const ends = toIsoDate(r.ends_on ?? '');
    if (starts === 'invalid' || ends === 'invalid') errors.push('invalid_date');
    if (asset && (!starts || !ends)) errors.push('rotation_dates_required');
    if (starts && ends && starts !== 'invalid' && ends !== 'invalid' && ends < starts) errors.push('end_before_start');
    seen.add(r.employee_no);
    const existing = r.employee_no ? await one(db, 'SELECT * FROM personnel WHERE org_id = $1 AND employee_no = $2', [a.org.id, r.employee_no]) : null;
    let action: 'create' | 'update' | 'unchanged' | 'error' = errors.length ? 'error' : existing ? 'update' : 'create';
    const values = {
      full_name: r.full_name,
      email: r.email || null,
      phone: r.phone || null,
      nationality: r.nationality || null,
      job_title: r.job_title || null,
      home_base: r.home_base || null,
      employer: r.employer || null,
      status: r.status || 'active',
    };
    const changed = existing ? Object.keys(values).filter((k) => (existing[k] ?? null) !== ((values as any)[k] ?? null)) : [];
    if (action === 'update' && !changed.length && !asset) action = 'unchanged';
    if (!dryRun && action !== 'error') {
      let pid = existing?.id;
      if (action === 'create') {
        const row = await one(
          db,
          `INSERT INTO personnel (org_id, employee_no, full_name, email, phone, nationality, job_title, home_base, employer, status, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
          [a.org.id, r.employee_no, values.full_name, values.email, values.phone, values.nationality, values.job_title, values.home_base, values.employer, values.status, a.user.id],
        );
        pid = row.id;
      } else if (changed.length) {
        await db.query(
          `UPDATE personnel SET ${changed.map((k, j) => `${k} = $${j + 3}`).join(', ')}, updated_by = $2, updated_at = now(), version = version + 1 WHERE id = $1`,
          [pid, a.user.id, ...changed.map((k) => (values as any)[k])],
        );
      }
      if (asset && starts && ends) {
        const dup = await one(db, 'SELECT id FROM assignments WHERE personnel_id = $1 AND asset_id = $2 AND starts_on = $3', [pid, asset.id, starts]);
        if (!dup) {
          await db.query('INSERT INTO assignments (org_id, personnel_id, asset_id, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [a.org.id, pid, asset.id, starts, ends, a.user.id]);
        }
      }
    }
    report.push({ row: i + 2, employeeNo: r.employee_no ?? null, fullName: r.full_name ?? null, action, errors, changedFields: changed });
  }
  const summary = {
    total: report.length,
    create: report.filter((r) => r.action === 'create').length,
    update: report.filter((r) => r.action === 'update').length,
    unchanged: report.filter((r) => r.action === 'unchanged').length,
    errors: report.filter((r) => r.action === 'error').length,
  };
  if (!dryRun) {
    await audit(db, actorOf(a), { orgId: a.org.id, action: 'personnel.roster_imported', entityType: 'organization', entityId: a.org.id, metadata: summary });
  }
  return { dryRun, summary, rows: report };
}

/* Signed file download -------------------------------------------------------------------- */

export async function fileRoutes(app: FastifyInstance) {
  app.get('/files/:token', async (req, reply) => {
    const claims = verifyLink((req.params as any).token);
    const a = req.auth;
    // The link is bound to the session that requested it and expires within a minute.
    if (!claims || !a || a.session.id !== claims.sid || a.org?.id !== claims.org || a.orgBlock) throw notFound();
    const ctx = a as OrgContext;
    const result = await orgTx(ctx, async (db) => {
      if (claims.kind === 'document') {
        const d = await one(db, 'SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL', [claims.id]);
        // Permissions are re-checked at download time, so a revoked permission takes effect immediately.
        if (!d || !canSeeDocument(ctx, d) || d.scan_status !== 'clean') throw notFound();
        if (d.personnel_id) await loadPersonnel(db, ctx, d.personnel_id);
        await audit(db, actorOf(ctx), { orgId: ctx.org.id, action: 'document.downloaded', entityType: 'document', entityId: d.id, metadata: { classification: d.classification } });
        return { key: d.storage_key, filename: d.filename, mime: d.mime_type };
      }
      const { attachmentForDownload } = await import('./communications.js');
      return attachmentForDownload(db, ctx, claims);
    });
    const body = 'buffer' in result ? (result as any).buffer : await getObject(result.key);
    reply
      .header('content-type', result.mime)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff');
    return reply.send(body);
  });
}
