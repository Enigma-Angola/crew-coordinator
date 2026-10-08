import { randomUUID } from 'node:crypto';
import { audit } from '../audit/audit.js';
import { config } from '../config.js';
import { many, one, withTx, type Db } from '../db/pool.js';
import { can, type OrgContext } from '../http/guard.js';
import { ApiError, notFound } from '../http/errors.js';
import { Params, requestScope } from '../authz/scope.js';
import { st, type Lang } from '../i18n/server-messages.js';
import { emitChange } from '../realtime/events.js';
import { getObject, putObject, MIME } from '../storage/files.js';
import { addRequestEvent } from '../api/operations.js';
import { refreshInsights } from '../domain/insights.js';
import { buildSnapshotRows, fillTemplate, personLines, safeAttachmentName } from './render.js';
import { generateWorkbooks, validateRows, workbookDefinitionSchema, REF_KEY } from './xlsx.js';
import { buildMime } from './mime.js';
import { GraphClient, type MailboxRow } from './connectors/graph.js';
import { SendFailed, SendUncertain } from './connectors/types.js';

export interface PackageWarning {
  code: string;
  requestId?: string;
  reference?: string;
  field?: string;
  blocking: boolean;
}

const ACTIVE_STATUSES = ['draft', 'in_review', 'approved', 'queued', 'submitting', 'submitted', 'send_uncertain'];

async function nextPackageRef(db: Db, orgId: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pkg:${orgId}`]);
  const year = new Date().getUTCFullYear();
  const r = await one(db, 'SELECT count(*)::int AS n FROM email_packages WHERE org_id = $1 AND reference LIKE $2', [orgId, `PKG-${year}-%`]);
  return `PKG-${year}-${String((r?.n ?? 0) + 1).padStart(4, '0')}`;
}

export async function activeTemplate(db: Db, orgId: string, supplierId: string, type: string) {
  return one(
    db,
    `SELECT * FROM email_templates WHERE org_id = $1 AND supplier_id = $2 AND request_type = $3 AND status = 'active' ORDER BY version DESC LIMIT 1`,
    [orgId, supplierId, type],
  );
}

/** Recipients only ever come from verified, active supplier contacts — never from AI or free text. */
export async function resolveRecipients(db: Db, orgId: string, supplierId: string, type: string, tpl: any) {
  const contacts = await many(
    db,
    `SELECT email, role FROM supplier_contacts WHERE org_id = $1 AND supplier_id = $2 AND verified AND active
       AND (cardinality(request_types) = 0 OR $3 = ANY(request_types)) ORDER BY email`,
    [orgId, supplierId, type],
  );
  const toRole = tpl.to_rule?.contactRole ?? 'to';
  const ccRole = tpl.cc_rule?.contactRole ?? 'cc';
  return { to: contacts.filter((c) => c.role === toRole).map((c) => c.email), cc: contacts.filter((c) => c.role === ccRole).map((c) => c.email) };
}

interface Group {
  key: string;
  tpl: any;
  supplier: any;
  requests: any[];
}

/**
 * Prepares email packages for selected requests. Requests are grouped only when they share
 * the same supplier template (so the same recipients and attachment format), the same
 * grouping window (crew change, day or single), and the same confidentiality class.
 */
export async function preparePackages(db: Db, a: OrgContext, p: { crewChangeId?: string | null; requestIds?: string[]; purpose?: 'request' | 'amendment' }) {
  const purpose = p.purpose ?? 'request';
  const q = new Params();
  const conds = [requestScope(a, q)];
  if (p.requestIds?.length) conds.push(`r.id = ANY(${q.add(p.requestIds)}::uuid[])`);
  if (p.crewChangeId) conds.push(`r.crew_change_id = ${q.add(p.crewChangeId)}`);
  if (!p.requestIds?.length && !p.crewChangeId) throw new ApiError(400, 'selection_required');
  conds.push(purpose === 'request' ? "r.status = 'draft'" : "r.status NOT IN ('draft', 'cancelled', 'completed')");
  const requests = await many(
    db,
    `SELECT r.*, cc.reference AS cc_reference, cc.scheduled_on, s.name AS asset_name FROM service_requests r
     LEFT JOIN crew_changes cc ON cc.id = r.crew_change_id LEFT JOIN assets s ON s.id = cc.asset_id WHERE ${conds.join(' AND ')}`,
    q.values,
  );
  const skipped: PackageWarning[] = [];
  const groups = new Map<string, Group>();
  for (const r of requests) {
    if (purpose === 'request') {
      const inPkg = await one(
        db,
        `SELECT p.reference FROM package_requests pr JOIN email_packages p ON p.id = pr.package_id
         WHERE pr.request_id = $1 AND p.purpose = 'request' AND p.status = ANY($2)`,
        [r.id, ACTIVE_STATUSES],
      );
      if (inPkg) {
        skipped.push({ code: 'already_in_package', requestId: r.id, reference: r.reference, blocking: false });
        continue;
      }
    }
    if (!r.supplier_id) {
      skipped.push({ code: 'no_supplier', requestId: r.id, reference: r.reference, blocking: true });
      continue;
    }
    const tpl = await activeTemplate(db, a.org.id, r.supplier_id, r.type);
    if (!tpl) {
      skipped.push({ code: 'no_template', requestId: r.id, reference: r.reference, blocking: true });
      continue;
    }
    const window = tpl.grouping === 'single' ? r.id : tpl.grouping === 'day' ? (r.starts_at ? new Date(r.starts_at).toISOString().slice(0, 10) : r.scheduled_on) : r.crew_change_id ?? r.id;
    const key = [tpl.family_id, tpl.confidentiality, window].join('|');
    if (!groups.has(key)) groups.set(key, { key, tpl, supplier: await one(db, 'SELECT * FROM suppliers WHERE id = $1', [r.supplier_id]), requests: [] });
    groups.get(key)!.requests.push(r);
  }

  const created = [];
  for (const g of groups.values()) created.push(await buildPackage(db, a, g, purpose));
  if (created.length || skipped.length) {
    await audit(db, { userId: a.user.id, sessionId: a.session.id, ip: a.ip }, {
      orgId: a.org.id,
      action: 'package.prepared',
      entityType: 'crew_change',
      entityId: p.crewChangeId ?? undefined,
      metadata: { packages: created.map((c) => c.reference), skipped: skipped.length, purpose },
    });
  }
  return { packages: created, skipped };
}

async function defaultMailbox(db: Db, orgId: string) {
  return one(db, "SELECT id, address, status FROM mailbox_connections WHERE org_id = $1 AND status = 'connected' ORDER BY kind DESC, connected_at LIMIT 1", [orgId]);
}

async function buildPackage(db: Db, a: OrgContext, g: Group, purpose: 'request' | 'amendment', existing?: any) {
  const { tpl } = g;
  const lang = tpl.language as Lang;
  const warnings: PackageWarning[] = [];
  const recipients = await resolveRecipients(db, a.org.id, g.supplier.id, tpl.request_type, tpl);
  if (!recipients.to.length) warnings.push({ code: 'no_verified_recipient', blocking: true });
  const includeIdentity = tpl.confidentiality === 'identity';
  if (includeIdentity && !can(a, 'identity:view')) throw new ApiError(403, 'identity_permission_required');
  const rows = await buildSnapshotRows(db, a.org.id, g.requests.map((r) => r.id), { includeIdentity, language: lang });

  const wbTpl = tpl.workbook_template_id ? await one(db, 'SELECT * FROM workbook_templates WHERE id = $1', [tpl.workbook_template_id]) : null;
  const def = wbTpl ? workbookDefinitionSchema.parse(wbTpl.definition) : null;
  const issues = def ? validateRows(def, rows, tpl.required_fields) : validateRows({ columns: [{ key: REF_KEY, heading: 'Ref', type: 'text', required: true }] } as any, rows, tpl.required_fields);
  for (const i of issues) {
    const req = g.requests.find((r) => r.reference === i.reference);
    warnings.push({ code: 'missing_field', requestId: req?.id, reference: i.reference, field: i.field, blocking: true });
  }
  if (includeIdentity) {
    for (const r of rows) if (!r['identity.passport_number']) warnings.push({ code: 'missing_identity_document', requestId: String(r['request.id']), reference: String(r['request.reference']), blocking: true });
  }
  if (wbTpl?.inspection && !wbTpl.inspection.ok && !wbTpl.feature_loss_acknowledged_by) {
    warnings.push({ code: 'template_unsupported_features', blocking: true });
  }

  const first = g.requests[0];
  const reference = existing?.reference ?? (await nextPackageRef(db, a.org.id));
  const date = first.scheduled_on ?? (first.starts_at ? new Date(first.starts_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
  const vars = {
    packageRef: reference,
    crewChange: first.cc_reference ?? '',
    asset: first.asset_name ?? '',
    date,
    supplier: g.supplier.name,
    type: st(lang, `type.${tpl.request_type}`),
    count: g.requests.length,
    people: personLines(rows, lang),
    instructions: tpl.provider_instructions ?? '',
    sender: a.org.name,
  };
  let subject = fillTemplate(tpl.subject_format, vars);
  if (purpose === 'amendment') subject = `${st(lang, 'email.amendment.prefix')}: ${subject}`;
  if (!subject.includes(reference)) subject = `${subject} [${reference}]`;
  let body = fillTemplate(tpl.body_template, vars);
  if (purpose === 'amendment') body = `${st(lang, 'email.amendment.intro')}\n\n${body}`;
  body = `${body}\n\n${st(lang, 'email.reference.footer', { ref: reference })}`;

  const mailbox = await defaultMailbox(db, a.org.id);
  const pkg = existing
    ? await one(
        db,
        `UPDATE email_packages SET status = 'in_review', to_addresses = $2, cc_addresses = $3, subject = $4, body_text = $5, warnings = $6, blocking = $7,
           reviewed_by = NULL, reviewed_at = NULL, version = version + 1, source_versions = $8 WHERE id = $1 RETURNING *`,
        [existing.id, recipients.to, recipients.cc, subject, body, JSON.stringify(warnings), warnings.some((w) => w.blocking), Object.fromEntries(g.requests.map((r) => [r.id, r.version]))],
      )
    : await one(
        db,
        `INSERT INTO email_packages (org_id, reference, crew_change_id, supplier_id, email_template_id, mailbox_id, purpose, status, to_addresses, cc_addresses,
           subject, body_text, language, warnings, blocking, idempotency_key, created_by, source_versions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'in_review',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [
          a.org.id, reference, first.crew_change_id, g.supplier.id, tpl.id, mailbox?.id ?? null, purpose, recipients.to, recipients.cc, subject, body, lang,
          JSON.stringify(warnings), warnings.some((w) => w.blocking), `${a.org.id}:${randomUUID()}`, a.user.id, Object.fromEntries(g.requests.map((r) => [r.id, r.version])),
        ],
      );
  if (!existing) {
    for (const r of g.requests) await db.query('INSERT INTO package_requests (package_id, request_id, org_id) VALUES ($1,$2,$3)', [pkg.id, r.id, a.org.id]);
  } else {
    await db.query('UPDATE package_attachments SET superseded_at = now() WHERE package_id = $1 AND superseded_at IS NULL', [pkg.id]);
  }

  // Attachments are generated even when warnings exist so the user can preview them; a blocking
  // warning prevents approval and sending until it is resolved.
  if (def && rows.length) {
    let baseFile: Buffer | null = null;
    if (wbTpl.base_file_document_id) {
      const doc = await one(db, 'SELECT storage_key FROM documents WHERE id = $1', [wbTpl.base_file_document_id]);
      baseFile = doc ? await getObject(doc.storage_key) : null;
    }
    const attachmentId = randomUUID();
    const files = await generateWorkbooks({
      def,
      rows,
      vars: { crewChange: vars.crewChange, asset: vars.asset, date, supplier: vars.supplier, type: vars.type },
      meta: { attachment_id: attachmentId, package_reference: reference, template_family: wbTpl.family_id, template_version: String(wbTpl.version), generated_at: new Date().toISOString() },
      baseFile,
    });
    let total = 0;
    for (const [i, f] of files.entries()) {
      const id = i === 0 ? attachmentId : randomUUID();
      const groupRows = f.groupKey ? rows.filter((r) => String(def.splitBy === 'asset' ? r['asset.name'] : r['group.date']) === f.groupKey) : rows;
      const name = safeAttachmentName(
        fillTemplate(tpl.filename_convention, { type: tpl.request_type, crewChange: vars.crewChange, date: f.groupKey || date, asset: vars.asset, supplier: vars.supplier, version: String(pkg.version), packageRef: reference }),
      );
      const stored = await putObject(a.org.id, f.buffer);
      total += stored.size;
      await db.query(
        `INSERT INTO attachments (id, org_id, kind, filename, mime_type, size_bytes, sha256, storage_key, workbook_template_id, source_snapshot, created_by)
         VALUES ($1,$2,'generated',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, a.org.id, name, MIME.xlsx, stored.size, stored.sha256, stored.key, wbTpl.id, JSON.stringify({ rows: groupRows, emailTemplateId: tpl.id, emailTemplateVersion: tpl.version }), a.user.id],
      );
      await db.query('INSERT INTO package_attachments (package_id, attachment_id, org_id) VALUES ($1,$2,$3)', [pkg.id, id, a.org.id]);
    }
    if (total > config.MAX_ATTACHMENT_TOTAL_BYTES) {
      warnings.push({ code: 'attachments_too_large', blocking: true });
      await db.query('UPDATE email_packages SET warnings = $2, blocking = true WHERE id = $1', [pkg.id, JSON.stringify(warnings)]);
    }
  }
  for (const r of g.requests) await addRequestEvent(db, a.org.id, r.id, 'draft_prepared', a.user.id, { packageId: pkg.id });
  await emitChange(db, a.org.id, 'package', pkg.id, pkg.version, a.user.id);
  return { id: pkg.id, reference, status: pkg.status, blocking: warnings.some((w) => w.blocking), warnings, requests: g.requests.length };
}

export async function loadPackage(db: Db, a: OrgContext, id: string, lock = false) {
  const pkg = await one(db, `SELECT * FROM email_packages WHERE id = $1 AND org_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, a.org.id]);
  if (!pkg) throw notFound();
  // Asset-scoped users can only open packages for crew changes in their scope.
  if (pkg.crew_change_id && a.membership.asset_scope?.length) {
    const cc = await one(db, 'SELECT asset_id FROM crew_changes WHERE id = $1', [pkg.crew_change_id]);
    if (!cc || !a.membership.asset_scope.includes(cc.asset_id)) throw notFound();
  }
  return pkg;
}

/** Everything a reviewer must see before sending. */
export async function packagePreview(db: Db, a: OrgContext, id: string) {
  const pkg = await loadPackage(db, a, id);
  const tpl = await one(db, 'SELECT id, name, version, requires_review, automation_allowed, provider_instructions, confidentiality, response_hours FROM email_templates WHERE id = $1', [pkg.email_template_id]);
  const mailbox = pkg.mailbox_id ? await one(db, 'SELECT id, address, kind, status, provider FROM mailbox_connections WHERE id = $1', [pkg.mailbox_id]) : null;
  const supplier = await one(db, 'SELECT id, name FROM suppliers WHERE id = $1', [pkg.supplier_id]);
  const attachments = await many(
    db,
    `SELECT a.id, a.filename, a.size_bytes, a.sha256, a.created_at, pa.superseded_at, wt.name AS template_name, wt.version AS template_version
     FROM package_attachments pa JOIN attachments a ON a.id = pa.attachment_id LEFT JOIN workbook_templates wt ON wt.id = a.workbook_template_id
     WHERE pa.package_id = $1 ORDER BY pa.superseded_at NULLS FIRST, a.created_at`,
    [id],
  );
  const requests = await many(
    db,
    `SELECT r.id, r.reference, r.type, r.status, r.version, r.starts_at, pe.full_name, pe.employee_no FROM package_requests pr
     JOIN service_requests r ON r.id = pr.request_id JOIN personnel pe ON pe.id = r.personnel_id WHERE pr.package_id = $1 ORDER BY pe.full_name`,
    [id],
  );
  const stale = requests.filter((r) => pkg.source_versions?.[r.id] !== undefined && pkg.source_versions[r.id] !== r.version).map((r) => r.reference);
  const messages = await many(
    db,
    'SELECT id, direction, subject, from_address, received_at, match_method FROM email_messages WHERE package_id = $1 OR id IN (SELECT message_id FROM message_links WHERE request_id = ANY($2::uuid[])) ORDER BY received_at',
    [id, requests.map((r) => r.id)],
  );
  const reviewer = pkg.reviewed_by ? await one(db, 'SELECT display_name FROM users WHERE id = $1', [pkg.reviewed_by]) : null;
  const creator = pkg.created_by ? await one(db, 'SELECT display_name FROM users WHERE id = $1', [pkg.created_by]) : null;
  return {
    ...pkg,
    template: tpl,
    supplier,
    mailbox,
    demonstrationMode: !mailbox || mailbox.status !== 'connected',
    attachments,
    requests,
    staleRecords: stale,
    messages,
    reviewedByName: reviewer?.display_name ?? null,
    createdByName: creator?.display_name ?? null,
  };
}

export async function regeneratePackage(db: Db, a: OrgContext, id: string) {
  const pkg = await loadPackage(db, a, id, true);
  if (!['draft', 'in_review', 'approved', 'send_failed'].includes(pkg.status)) throw new ApiError(409, 'invalid_state');
  const tpl = await one(db, 'SELECT * FROM email_templates WHERE id = $1', [pkg.email_template_id]);
  // Always regenerate from the currently active version of the template family.
  const current = (await activeTemplate(db, a.org.id, pkg.supplier_id, tpl.request_type)) ?? tpl;
  if (current.id !== tpl.id) await db.query('UPDATE email_packages SET email_template_id = $2 WHERE id = $1', [id, current.id]);
  const requests = await many(
    db,
    `SELECT r.*, cc.reference AS cc_reference, cc.scheduled_on, s.name AS asset_name FROM package_requests pr JOIN service_requests r ON r.id = pr.request_id
     LEFT JOIN crew_changes cc ON cc.id = r.crew_change_id LEFT JOIN assets s ON s.id = cc.asset_id WHERE pr.package_id = $1 AND r.status <> 'cancelled'`,
    [id],
  );
  if (!requests.length) throw new ApiError(409, 'no_active_requests');
  const supplier = await one(db, 'SELECT * FROM suppliers WHERE id = $1', [pkg.supplier_id]);
  return buildPackage(db, a, { key: id, tpl: current, supplier, requests }, pkg.purpose, pkg);
}

export async function approvePackage(db: Db, a: OrgContext, id: string, version: number) {
  const pkg = await loadPackage(db, a, id, true);
  if (pkg.version !== version) throw new ApiError(409, 'edit_conflict', { currentVersion: pkg.version, conflicts: [{ field: 'status', theirs: pkg.status }] });
  if (pkg.status !== 'in_review' && pkg.status !== 'draft') throw new ApiError(409, 'invalid_state');
  if (pkg.blocking) throw new ApiError(409, 'package_has_blocking_warnings');
  const preview = await packagePreview(db, a, id);
  if (preview.staleRecords.length) throw new ApiError(409, 'records_changed_regenerate', { references: preview.staleRecords });
  const tpl = preview.template;
  // Segregation of duties when the template requires an internal review.
  if (tpl.requires_review && pkg.created_by === a.user.id) throw new ApiError(403, 'segregation_of_duties');
  const row = await one(db, "UPDATE email_packages SET status = 'approved', reviewed_by = $2, reviewed_at = now(), version = version + 1 WHERE id = $1 RETURNING *", [id, a.user.id]);
  for (const r of preview.requests) await addRequestEvent(db, a.org.id, r.id, 'reviewed', a.user.id, { packageId: id });
  await audit(db, { userId: a.user.id, sessionId: a.session.id, ip: a.ip }, { orgId: a.org.id, action: 'package.approved', entityType: 'package', entityId: id });
  await emitChange(db, a.org.id, 'package', id, row.version, a.user.id);
  return row;
}

/**
 * Queues an approved package for submission through the connected mailbox. Sending is only
 * ever initiated by a person with email:send (or by an explicitly configured automation
 * rule for routine reminders); an AI recommendation can never trigger it.
 */
export async function queuePackage(db: Db, a: OrgContext, id: string, version: number) {
  const pkg = await loadPackage(db, a, id, true);
  if (pkg.version !== version) throw new ApiError(409, 'edit_conflict', { currentVersion: pkg.version, conflicts: [{ field: 'status', theirs: pkg.status }] });
  if (pkg.status !== 'approved') throw new ApiError(409, 'invalid_state', { status: pkg.status });
  const mailbox = pkg.mailbox_id ? await one(db, 'SELECT * FROM mailbox_connections WHERE id = $1', [pkg.mailbox_id]) : await defaultMailbox(db, a.org.id);
  if (!mailbox || mailbox.status !== 'connected') throw new ApiError(409, 'no_connected_mailbox');
  const row = await one(
    db,
    "UPDATE email_packages SET status = 'queued', mailbox_id = $3, sent_by = $2, next_attempt_at = now(), version = version + 1 WHERE id = $1 RETURNING *",
    [id, a.user.id, mailbox.id],
  );
  const reqs = await many(db, 'SELECT request_id FROM package_requests WHERE package_id = $1', [id]);
  for (const r of reqs) await addRequestEvent(db, a.org.id, r.request_id, 'queued', a.user.id, { packageId: id });
  await audit(db, { userId: a.user.id, sessionId: a.session.id, ip: a.ip }, { orgId: a.org.id, action: 'package.queued', entityType: 'package', entityId: id, metadata: { mailbox: mailbox.address } });
  await emitChange(db, a.org.id, 'package', id, row.version, a.user.id);
  return row;
}

/** Records that a person sent the prepared email outside the platform (clearly labelled as such). */
export async function recordExternalSend(db: Db, a: OrgContext, id: string, version: number, sentAt: Date) {
  const pkg = await loadPackage(db, a, id, true);
  if (pkg.version !== version) throw new ApiError(409, 'edit_conflict', { currentVersion: pkg.version, conflicts: [] });
  if (pkg.status !== 'approved') throw new ApiError(409, 'invalid_state');
  await markSubmitted(db, pkg, { at: sentAt, channel: 'recorded_external', actorId: a.user.id });
  await audit(db, { userId: a.user.id, sessionId: a.session.id, ip: a.ip }, { orgId: a.org.id, action: 'package.recorded_external_send', entityType: 'package', entityId: id });
  return one(db, 'SELECT * FROM email_packages WHERE id = $1', [id]);
}

async function markSubmitted(db: Db, pkg: any, p: { at: Date; channel: 'connector' | 'recorded_external'; actorId: string | null; providerMessageId?: string; internetMessageId?: string; conversationId?: string }) {
  const tpl = await one(db, 'SELECT response_hours, reminder_hours FROM email_templates WHERE id = $1', [pkg.email_template_id]);
  const due = new Date(p.at.getTime() + (tpl?.response_hours ?? 24) * 3600_000);
  await db.query(
    `UPDATE email_packages SET status = 'submitted', submitted_at = $2, send_channel = $3, provider_message_id = coalesce($4, provider_message_id),
       internet_message_id = coalesce($5, internet_message_id), conversation_id = coalesce($6, conversation_id), response_due_at = $7, version = version + 1, next_attempt_at = NULL
     WHERE id = $1`,
    [pkg.id, p.at, p.channel, p.providerMessageId ?? null, p.internetMessageId ?? null, p.conversationId ?? null, due],
  );
  const reqs = await many(db, 'SELECT request_id FROM package_requests WHERE package_id = $1', [pkg.id]);
  for (const r of reqs) {
    await db.query(
      `UPDATE service_requests SET status = CASE WHEN status = 'draft' THEN 'requested' ELSE status END, first_requested_at = coalesce(first_requested_at, $2),
         response_due_at = CASE WHEN status IN ('draft', 'requested', 'acknowledged', 'change_pending_review') OR $4 THEN $3 ELSE response_due_at END, version = version + 1
       WHERE id = $1`,
      [r.request_id, p.at, due, pkg.purpose === 'amendment'],
    );
    await addRequestEvent(db, pkg.org_id, r.request_id, 'submitted', p.actorId, { packageId: pkg.id, detail: { channel: p.channel } });
  }
  // Archive of exactly what was submitted, linked into the thread history.
  const exists = await one(db, "SELECT id FROM email_messages WHERE package_id = $1 AND source = 'sent'", [pkg.id]);
  if (!exists) {
    const mailbox = pkg.mailbox_id ? await one(db, 'SELECT address FROM mailbox_connections WHERE id = $1', [pkg.mailbox_id]) : null;
    const msg = await one(
      db,
      `INSERT INTO email_messages (org_id, mailbox_id, source, direction, provider_message_id, internet_message_id, conversation_id, from_address, to_addresses, cc_addresses,
         subject, body_text, received_at, match_status, match_confidence, match_method, package_id)
       VALUES ($1,$2,'sent','outbound',$3,$4,$5,$6,$7,$8,$9,$10,$11,'matched',1,'outbound_package',$12) RETURNING id`,
      [pkg.org_id, pkg.mailbox_id, p.providerMessageId ?? null, p.internetMessageId ?? null, p.conversationId ?? null, mailbox?.address ?? null, pkg.to_addresses, pkg.cc_addresses, pkg.subject, pkg.body_text, p.at, pkg.id],
    );
    for (const r of reqs) await db.query("INSERT INTO message_links (message_id, request_id, org_id, method, confidence) VALUES ($1,$2,$3,'outbound_package',1)", [msg.id, r.request_id, pkg.org_id]);
    const atts = await many(db, 'SELECT attachment_id FROM package_attachments WHERE package_id = $1 AND superseded_at IS NULL', [pkg.id]);
    for (const at of atts) await db.query('INSERT INTO message_attachments (message_id, attachment_id, org_id) VALUES ($1,$2,$3)', [msg.id, at.attachment_id, pkg.org_id]);
  }
  await db.query("UPDATE reminders SET status = 'superseded' WHERE package_id = $1 AND status = 'scheduled'", [pkg.id]);
  if (pkg.purpose !== 'reminder') await db.query("INSERT INTO reminders (org_id, package_id, due_at, reason) VALUES ($1,$2,$3,'response_deadline')", [pkg.org_id, pkg.id, due]);
  await refreshInsights(db, pkg.org_id);
  await emitChange(db, pkg.org_id, 'package', pkg.id, null, p.actorId);
}

export async function packageMime(db: Db, pkg: any) {
  const mailbox = pkg.mailbox_id ? await one(db, 'SELECT address FROM mailbox_connections WHERE id = $1', [pkg.mailbox_id]) : null;
  const atts = await many(
    db,
    'SELECT a.* FROM package_attachments pa JOIN attachments a ON a.id = pa.attachment_id WHERE pa.package_id = $1 AND pa.superseded_at IS NULL ORDER BY a.created_at',
    [pkg.id],
  );
  const files = [];
  for (const at of atts) files.push({ filename: at.filename, contentType: at.mime_type, content: await getObject(at.storage_key) });
  return {
    files,
    from: mailbox?.address ?? 'not-sent@demonstration.invalid',
    eml: buildMime({
      from: mailbox?.address ?? 'Demonstration - not sent <not-sent@demonstration.invalid>',
      to: pkg.to_addresses,
      cc: pkg.cc_addresses,
      subject: pkg.subject,
      text: pkg.body_text,
      messageId: `<${pkg.id}@crew-coordinator.invalid>`,
      headers: { 'X-CrewCoord-Key': pkg.idempotency_key, ...(mailbox ? {} : { 'X-CrewCoord-Demonstration': 'not sent by Crew Coordinator' }) },
      attachments: files,
    }),
  };
}

/* Worker: submission and reconciliation ------------------------------------------------- */

const UNCERTAIN_RECHECK_MS = 2 * 60_000;
const UNCERTAIN_GIVE_UP_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Processes queued and uncertain packages for one organisation. Each send is preceded by a
 * committed "submitting" state, so a crash mid-send is later treated as uncertain and
 * reconciled against Sent Items instead of being blindly resent.
 */
export async function processOutbox(orgId: string) {
  const candidates = await withTx({ orgId }, (db) =>
    many(
      db,
      `SELECT id FROM email_packages WHERE org_id = $1 AND ((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
         OR status = 'send_uncertain' OR (status = 'submitting' AND next_attempt_at < now() - interval '5 minutes')) ORDER BY created_at LIMIT 20`,
      [orgId],
    ),
  );
  const results: { id: string; outcome: string }[] = [];
  for (const c of candidates) results.push({ id: c.id, outcome: await processOne(orgId, c.id) });
  return results;
}

async function processOne(orgId: string, id: string): Promise<string> {
  // Phase 1: claim the package and decide what to do.
  const claim = await withTx({ orgId }, async (db) => {
    const pkg = await one(db, 'SELECT * FROM email_packages WHERE id = $1 FOR UPDATE SKIP LOCKED', [id]);
    if (!pkg) return null;
    const box = await one<MailboxRow>(db, 'SELECT * FROM mailbox_connections WHERE id = $1', [pkg.mailbox_id]);
    if (pkg.status === 'queued') {
      if (!box || box.status !== 'connected') {
        await db.query("UPDATE email_packages SET status = 'send_failed', last_send_error = 'mailbox_not_connected' WHERE id = $1", [id]);
        return null;
      }
      await db.query("UPDATE email_packages SET status = 'submitting', send_attempts = send_attempts + 1, next_attempt_at = now() WHERE id = $1", [id]);
      return { pkg, box, mode: 'send' as const };
    }
    if (!box) return null;
    return { pkg, box, mode: 'reconcile' as const };
  });
  if (!claim) return 'skipped';
  const { pkg, box } = claim;

  if (claim.mode === 'reconcile') {
    return withTx({ orgId }, async (db) => {
      const client = new GraphClient(db, box);
      const found = await client.findSent(pkg.idempotency_key).catch(() => undefined);
      if (found) {
        await markSubmitted(db, pkg, { at: new Date(found.sentAt ?? Date.now()), channel: 'connector', actorId: pkg.sent_by, ...found });
        return 'reconciled_submitted';
      }
      const age = Date.now() - new Date(pkg.next_attempt_at ?? pkg.created_at).getTime();
      if (found === null && age > UNCERTAIN_GIVE_UP_MS) {
        if (pkg.send_attempts >= MAX_ATTEMPTS) {
          await db.query("UPDATE email_packages SET status = 'send_failed', last_send_error = 'outcome_unresolved_check_sent_items' WHERE id = $1", [id]);
          return 'failed_unresolved';
        }
        // Not in Sent Items long after the attempt: the provider did not accept it, so retrying is safe.
        await db.query("UPDATE email_packages SET status = 'queued', next_attempt_at = now() WHERE id = $1", [id]);
        return 'requeued';
      }
      return age < UNCERTAIN_RECHECK_MS ? 'waiting' : 'still_uncertain';
    });
  }

  // Phase 2: submit through the provider, outside any long-held transaction.
  const { eml: _eml, files } = await withTx({ orgId }, (db) => packageMime(db, pkg));
  let outcome: 'submitted' | 'failed' | 'uncertain' | 'retry' = 'submitted';
  let error = '';
  let retryAfter = 60;
  await withTx({ orgId }, async (db) => {
    const client = new GraphClient(db, box);
    try {
      await client.send({ from: box.address, to: pkg.to_addresses, cc: pkg.cc_addresses, subject: pkg.subject, text: pkg.body_text, idempotencyKey: pkg.idempotency_key, attachments: files });
    } catch (e) {
      if (e instanceof SendUncertain) outcome = 'uncertain';
      else if (e instanceof SendFailed && e.retryable) {
        outcome = 'retry';
        retryAfter = e.retryAfterSeconds ?? 60;
      } else outcome = 'failed';
      error = (e as Error).message;
    }
  });

  return withTx({ orgId }, async (db) => {
    const fresh = await one(db, 'SELECT * FROM email_packages WHERE id = $1 FOR UPDATE', [id]);
    if (outcome === 'submitted') {
      const client = new GraphClient(db, box);
      const found = await client.findSent(pkg.idempotency_key).catch(() => null);
      await markSubmitted(db, fresh, { at: found?.sentAt ? new Date(found.sentAt) : new Date(), channel: 'connector', actorId: fresh.sent_by, ...(found ?? {}) });
      await audit(db, { userId: fresh.sent_by }, { orgId, action: 'package.submitted', entityType: 'package', entityId: id, metadata: { attempt: fresh.send_attempts } });
      return 'submitted';
    }
    if (outcome === 'retry') {
      await db.query("UPDATE email_packages SET status = 'queued', next_attempt_at = now() + make_interval(secs => $2), last_send_error = $3 WHERE id = $1", [id, retryAfter, error]);
      return 'retry_later';
    }
    if (outcome === 'uncertain') {
      await db.query("UPDATE email_packages SET status = 'send_uncertain', last_send_error = $2, next_attempt_at = now() WHERE id = $1", [id, error]);
      return 'uncertain';
    }
    await db.query("UPDATE email_packages SET status = 'send_failed', last_send_error = $2 WHERE id = $1", [id, error]);
    await audit(db, { userId: fresh.sent_by }, { orgId, action: 'package.send_failed', entityType: 'package', entityId: id, metadata: { error } });
    return 'failed';
  });
}

/* Reminders ------------------------------------------------------------------------------ */

/** Prepares reminder drafts for overdue responses; sends automatically only where a template explicitly allows it. */
export async function processReminders(orgId: string) {
  return withTx({ orgId }, async (db) => {
    const due = await many(
      db,
      `SELECT rm.*, p.reference, p.subject, p.body_text, p.to_addresses, p.cc_addresses, p.supplier_id, p.email_template_id, p.crew_change_id, p.mailbox_id, p.language,
              p.submitted_at, p.created_by, t.automation_allowed, t.reminder_hours
       FROM reminders rm JOIN email_packages p ON p.id = rm.package_id JOIN email_templates t ON t.id = p.email_template_id
       WHERE rm.org_id = $1 AND rm.status = 'scheduled' AND rm.due_at <= now() FOR UPDATE OF rm SKIP LOCKED`,
      [orgId],
    );
    const prepared = [];
    for (const r of due) {
      const open = await many(
        db,
        `SELECT sr.id FROM package_requests pr JOIN service_requests sr ON sr.id = pr.request_id
         WHERE pr.package_id = $1 AND sr.first_response_at IS NULL AND sr.status NOT IN ('cancelled', 'completed', 'confirmed')`,
        [r.package_id],
      );
      if (!open.length) {
        await db.query("UPDATE reminders SET status = 'cancelled', reason = 'response_received' WHERE id = $1", [r.id]);
        continue;
      }
      const lang = r.language as Lang;
      const ref = await nextPackageRef(db, orgId);
      const subject = `${st(lang, 'email.reminder.prefix')}: ${r.subject.replace(/\s*\[PKG-[^\]]+\]$/, '')} [${r.reference}]`;
      const body = `${st(lang, 'email.reminder.intro', { sentAt: new Date(r.submitted_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' })}\n\n${r.body_text}`;
      const auto = r.automation_allowed === true;
      const pkg = await one(
        db,
        `INSERT INTO email_packages (org_id, reference, crew_change_id, supplier_id, email_template_id, mailbox_id, purpose, status, to_addresses, cc_addresses, subject, body_text,
           language, warnings, blocking, idempotency_key, created_by, amends_package_id, next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,'reminder',$7,$8,$9,$10,$11,$12,'[]',false,$13,$14,$15,$16) RETURNING id`,
        [orgId, ref, r.crew_change_id, r.supplier_id, r.email_template_id, r.mailbox_id, auto ? 'queued' : 'in_review', r.to_addresses, r.cc_addresses, subject, body, lang, `${orgId}:${randomUUID()}`, r.created_by, r.package_id, auto ? new Date() : null],
      );
      for (const o of open) {
        await db.query('INSERT INTO package_requests (package_id, request_id, org_id) VALUES ($1,$2,$3)', [pkg.id, o.id, orgId]);
        await addRequestEvent(db, orgId, o.id, 'reminder_prepared', null, { packageId: pkg.id, detail: { automatic: auto } });
      }
      const atts = await many(db, 'SELECT attachment_id FROM package_attachments WHERE package_id = $1 AND superseded_at IS NULL', [r.package_id]);
      for (const at of atts) await db.query('INSERT INTO package_attachments (package_id, attachment_id, org_id) VALUES ($1,$2,$3)', [pkg.id, at.attachment_id, orgId]);
      await db.query("UPDATE reminders SET status = 'prepared', reminder_package_id = $2 WHERE id = $1", [r.id, pkg.id]);
      await db.query("INSERT INTO reminders (org_id, package_id, due_at, reason) VALUES ($1,$2, now() + make_interval(hours => $3), 'follow_up')", [orgId, r.package_id, r.reminder_hours ?? 24]);
      if (r.created_by) await db.query("INSERT INTO notifications (org_id, user_id, code, params, entity_type, entity_id) VALUES ($1,$2,'reminder_prepared',$3,'package',$4)", [orgId, r.created_by, { reference: r.reference }, pkg.id]);
      await audit(db, {}, { orgId, action: 'package.reminder_prepared', entityType: 'package', entityId: pkg.id, metadata: { original: r.reference, automatic: auto } });
      prepared.push(pkg.id);
    }
    return prepared;
  });
}
