import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { many } from '../db/pool.js';
import { actorOf, can, need, orgTx } from '../http/guard.js';
import { ApiError } from '../http/errors.js';
import { isRecentAuth } from '../auth/session.js';
import { Params, personnelScope, requestScope } from '../authz/scope.js';
import { securityEvent } from '../security/monitor.js';
import { formatDateTime, st, tzLabel, type Lang } from '../i18n/server-messages.js';
import { neutraliseFormula } from '../email/xlsx.js';
import { aiEnabled, answer, retrieve } from '../ai/assistant.js';

/** CSV cell with formula-injection neutralisation and RFC 4180 quoting. */
export function csvCell(v: unknown) {
  if (v === null || v === undefined) return '';
  const s = neutraliseFormula(String(v));
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportRoutes(app: FastifyInstance) {
  app.post('/exports', async (req, reply) => {
    const a = need(req, 'export:run');
    const b = z
      .object({ dataset: z.enum(['requests', 'personnel']), format: z.enum(['xlsx', 'csv']).default('xlsx'), crewChangeId: z.string().uuid().optional(), includeRestricted: z.boolean().default(false) })
      .parse(req.body);
    if (b.dataset === 'requests' && !can(a, 'request:view')) throw new ApiError(403, 'forbidden');
    if (b.dataset === 'personnel' && !can(a, 'personnel:view')) throw new ApiError(403, 'forbidden');
    // Exporting identity data needs the permission to see it and a recent authentication.
    if (b.includeRestricted) {
      if (!can(a, 'identity:view')) throw new ApiError(403, 'forbidden', { permission: 'identity:view' });
      if (!isRecentAuth(a.session)) throw new ApiError(401, 'reauth_required');
    }
    const lang = a.user.language as Lang;
    const tz = a.user.timezone;
    const { columns, rows } = await orgTx(a, async (db) => {
      const p = new Params();
      if (b.dataset === 'requests') {
        const conds = [requestScope(a, p)];
        if (b.crewChangeId) conds.push(`r.crew_change_id = ${p.add(b.crewChangeId)}`);
        const data = await many(
          db,
          `SELECT r.reference, pe.full_name, pe.employee_no, r.type, r.status, s.name AS supplier, r.starts_at, r.ends_at, r.booking_reference, r.cost_amount, r.cost_currency, cc.reference AS crew_change
           FROM service_requests r JOIN personnel pe ON pe.id = r.personnel_id LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN crew_changes cc ON cc.id = r.crew_change_id
           WHERE ${conds.join(' AND ')} ORDER BY r.starts_at NULLS LAST`,
          p.values,
        );
        const cols = ['reference', 'person', 'employee_no', 'type', 'status', 'supplier', 'starts_at', 'ends_at', 'booking_reference', ...(can(a, 'costs:view') ? ['cost', 'currency'] : []), 'crew_change'];
        return {
          columns: cols,
          rows: data.map((r) => {
            const o: Record<string, unknown> = {
              reference: r.reference, person: r.full_name, employee_no: r.employee_no, type: st(lang, `type.${r.type}`), status: st(lang, `status.${r.status}`), supplier: r.supplier,
              starts_at: formatDateTime(r.starts_at, lang, tz), ends_at: formatDateTime(r.ends_at, lang, tz), booking_reference: r.booking_reference, crew_change: r.crew_change,
            };
            if (can(a, 'costs:view')) Object.assign(o, { cost: r.cost_amount, currency: r.cost_currency });
            return o;
          }),
        };
      }
      const data = await many(
        db,
        `SELECT p.employee_no, p.full_name, p.job_title, p.nationality, p.email, p.phone ${b.includeRestricted ? ', i.passport_number, i.passport_expiry' : ''}
         FROM personnel p ${b.includeRestricted ? 'LEFT JOIN personnel_identity i ON i.personnel_id = p.id' : ''} WHERE ${personnelScope(a, p)} ORDER BY p.full_name`,
        p.values,
      );
      const cols = ['employee_no', 'full_name', 'job_title', 'nationality', 'email', 'phone', ...(b.includeRestricted ? ['passport_number', 'passport_expiry'] : [])];
      return { columns: cols, rows: data };
    });
    const heading = (c: string) => st(lang, `export.col.${c}`);
    const footer = st(lang, 'export.generated', { at: formatDateTime(new Date(), lang, tz), tz: tzLabel(tz, lang), user: a.user.display_name });

    await orgTx(a, async (db) => {
      await db.query('INSERT INTO exports (org_id, user_id, dataset, format, row_count, includes_restricted) VALUES ($1,$2,$3,$4,$5,$6)', [a.org.id, a.user.id, b.dataset, b.format, rows.length, b.includeRestricted]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'export.created', entityType: 'export', entityId: b.dataset, metadata: { format: b.format, rows: rows.length, includesRestricted: b.includeRestricted } });
      await securityEvent(db, 'export', { orgId: a.org.id, userId: a.user.id, ip: a.ip, detail: { dataset: b.dataset, rows: rows.length, includesRestricted: b.includeRestricted } });
    });

    const stamp = new Date().toISOString().slice(0, 10);
    if (b.format === 'csv') {
      const lines = [columns.map((c) => csvCell(heading(c))).join(','), ...rows.map((r) => columns.map((c) => csvCell((r as any)[c])).join(',')), '', csvCell(footer)];
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${b.dataset}_${stamp}.csv"`)
        .header('cache-control', 'no-store')
        .send('﻿' + lines.join('\r\n'));
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(b.dataset);
    ws.addRow(columns.map(heading)).font = { bold: true };
    for (const r of rows) ws.addRow(columns.map((c) => { const v = (r as any)[c]; return typeof v === 'string' ? neutraliseFormula(v) : v ?? null; }));
    ws.addRow([]);
    ws.addRow([footer]);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    columns.forEach((_, i) => (ws.getColumn(i + 1).width = 18));
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${b.dataset}_${stamp}.xlsx"`)
      .header('cache-control', 'no-store')
      .send(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer));
  });

  app.get('/ai/status', async (req) => {
    const a = need(req, 'ai:use');
    return { provider: a.org.ai_provider, approved: !!a.org.ai_approved_at, enabled: aiEnabled(a) };
  });

  app.post('/ai/ask', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const a = need(req, 'ai:use');
    const { question } = z.object({ question: z.string().trim().min(3).max(500) }).parse(req.body);
    const records = await orgTx(a, (db) => retrieve(db, a, question));
    await orgTx(a, (db) => audit(db, actorOf(a), { orgId: a.org.id, action: 'ai.asked', entityType: 'ai', entityId: 'assistant', metadata: { records: records.length, provider: aiEnabled(a) ? a.org.ai_provider : 'none' } }));
    if (!aiEnabled(a) || !records.length) {
      return { mode: 'retrieval_only', answer: null, records, reason: !aiEnabled(a) ? 'ai_not_approved' : 'no_records' };
    }
    const result = await answer(question, records, a.user.language).catch((e) => {
      req.log.warn({ err: (e as Error).message }, 'ai provider error');
      return { text: null, refused: false, error: true };
    });
    return { mode: 'ai_summary', answer: result.text, refused: result.refused, error: (result as any).error ?? false, records, label: 'ai_generated_verify' };
  });
}
