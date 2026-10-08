import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { config } from '../config.js';
import { many, one, type Db } from '../db/pool.js';
import { actorOf, can, need, orgTx, type OrgContext } from '../http/guard.js';
import { ApiError, badRequest, notFound } from '../http/errors.js';
import { Params, requestScope } from '../authz/scope.js';
import { REQUEST_TYPES, STATUS_FLOW } from '../domain/requests.js';
import { emitChange } from '../realtime/events.js';
import { randomToken, sha256 } from '../util/crypto.js';
import { getObject, putObject, safeFilename, scanForMalware, signLink, sniff, type LinkClaims } from '../storage/files.js';
import { addRequestEvent, applyRequestChanges } from './operations.js';
import { notify } from './collaboration.js';
import { idParam } from './util.js';
import { workbookDefinitionSchema, inspectTemplate } from '../email/xlsx.js';
import { approvePackage, loadPackage, packageMime, packagePreview, preparePackages, processOutbox, queuePackage, recordExternalSend, regeneratePackage } from '../email/packages.js';
import { ingestInbound, linkMessage, refreshReconciliation } from '../email/ingest.js';
import { CONNECTORS, GraphClient, graphAuthorizeUrl, graphAvailable, graphExchangeCode, sealTokens } from '../email/connectors/graph.js';
import { ReauthorisationRequired } from '../email/connectors/types.js';
import { findReferences, ownContentRange } from '../email/extraction.js';

const emailTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  supplierId: z.string().uuid(),
  requestType: z.enum(REQUEST_TYPES as [string, ...string[]]),
  language: z.enum(['pt-PT', 'en']),
  subjectFormat: z.string().min(1).max(300),
  bodyTemplate: z.string().min(1).max(20_000),
  toRule: z.object({ contactRole: z.enum(['to', 'cc']) }).default({ contactRole: 'to' }),
  ccRule: z.object({ contactRole: z.enum(['to', 'cc']) }).default({ contactRole: 'cc' }),
  requiredFields: z.array(z.string().max(80)).max(40).default([]),
  workbookTemplateId: z.string().uuid().nullish(),
  filenameConvention: z.string().min(1).max(200).default('{type}_{crewChange}_{date}.xlsx'),
  requiresReview: z.boolean().default(true),
  automationAllowed: z.boolean().default(false),
  responseHours: z.number().int().min(1).max(720).default(24),
  reminderHours: z.number().int().min(1).max(720).default(24),
  grouping: z.enum(['crew_change', 'day', 'single']).default('crew_change'),
  providerInstructions: z.string().max(4000).nullish(),
  confidentiality: z.enum(['standard', 'identity', 'medical']).default('standard'),
});

/** Which requests linked to a message the viewer may see. */
async function visibleLinkedRequests(db: Db, a: OrgContext, messageId: string) {
  const p = new Params();
  const mid = p.add(messageId);
  return many(
    db,
    `SELECT r.id, r.reference, r.type, r.status, r.version, r.details, r.booking_reference, r.cost_amount, r.cost_currency, l.method, l.confidence
     FROM message_links l JOIN service_requests r ON r.id = l.request_id WHERE l.message_id = ${mid} AND ${requestScope(a, p)}`,
    p.values,
  );
}

/**
 * Message bodies may cover several people. When the viewer cannot see every linked request,
 * only the general text and the segments naming requests they can see are shown.
 */
function redactBody(body: string, allLinkedRefs: string[], visibleRefs: string[]) {
  if (allLinkedRefs.every((r) => visibleRefs.includes(r))) return { body, redacted: false };
  const range = ownContentRange(body);
  const own = body.slice(range.start, range.end);
  const lines = own.split('\n');
  const out: string[] = [];
  let keep = true;
  for (const line of lines) {
    const refs = findReferences(line).requests;
    if (refs.length) keep = refs.some((r) => visibleRefs.includes(r));
    out.push(keep ? line : '');
  }
  return { body: out.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n'), redacted: true };
}

export async function attachmentForDownload(db: Db, a: OrgContext, claims: LinkClaims) {
  if (claims.kind === 'package_eml') {
    if (!can(a, 'email:view')) throw notFound();
    const pkg = await loadPackage(db, a, claims.id);
    const { eml } = await packageMime(db, pkg);
    await audit(db, actorOf(a), { orgId: a.org.id, action: 'package.downloaded', entityType: 'package', entityId: pkg.id });
    return { buffer: eml, filename: `${pkg.reference}.eml`, mime: 'message/rfc822' };
  }
  const at = await one(db, 'SELECT * FROM attachments WHERE id = $1', [claims.id]);
  if (!at) throw notFound();
  if (at.scan_status !== 'clean') throw notFound();
  // The viewer must be able to see a package or a request the attachment belongs to.
  const pkgs = await many(db, 'SELECT package_id FROM package_attachments WHERE attachment_id = $1', [at.id]);
  const msgs = await many(db, 'SELECT message_id FROM message_attachments WHERE attachment_id = $1', [at.id]);
  let allowed = false;
  if (can(a, 'email:view')) {
    for (const p of pkgs) if (await loadPackage(db, a, p.package_id).then(() => true, () => false)) allowed = true;
    for (const m of msgs) if ((await visibleLinkedRequests(db, a, m.message_id)).length || (await canSeeUnmatched(db, a, m.message_id))) allowed = true;
  }
  if (!allowed) throw notFound();
  // Identity-classified spreadsheets (immigration lists) require identity permission to download.
  if (at.source_snapshot?.rows?.some((r: any) => 'identity.passport_number' in r) && !can(a, 'identity:view')) throw notFound();
  await audit(db, actorOf(a), { orgId: a.org.id, action: 'attachment.downloaded', entityType: 'attachment', entityId: at.id });
  return { key: at.storage_key, filename: at.filename, mime: at.mime_type };
}

async function canSeeUnmatched(db: Db, a: OrgContext, messageId: string) {
  if (!can(a, 'email:associate') || a.membership.asset_scope?.length) return false;
  const m = await one(db, "SELECT 1 FROM email_messages WHERE id = $1 AND match_status = 'unmatched'", [messageId]);
  return !!m;
}

export async function communicationsRoutes(app: FastifyInstance) {
  app.get('/connectors', async (req) => {
    need(req, 'email:view');
    return { configured: config.EMAIL_PROVIDER, connectors: CONNECTORS() };
  });

  /* Suppliers and verified contacts ----------------------------------------------------- */

  app.get('/suppliers', async (req) => {
    const a = need(req, 'request:view');
    if (a.membership.role === 'supplier') throw new ApiError(403, 'forbidden');
    return orgTx(a, async (db) => {
      const suppliers = await many(db, 'SELECT * FROM suppliers WHERE org_id = $1 ORDER BY name', [a.org.id]);
      const contacts = can(a, 'email:view') ? await many(db, 'SELECT * FROM supplier_contacts WHERE org_id = $1 ORDER BY email', [a.org.id]) : [];
      return suppliers.map((s) => ({ ...s, contacts: contacts.filter((c) => c.supplier_id === s.id) }));
    });
  });

  app.post('/suppliers', async (req) => {
    const a = need(req, 'supplier:manage');
    const b = z
      .object({ name: z.string().min(1).max(160), category: z.enum(['travel', 'hotel', 'transport', 'medical', 'training', 'immigration', 'other']), defaultLanguage: z.enum(['pt-PT', 'en']).default('en'), responseHoursTarget: z.number().int().min(1).max(720).default(24), trustedStructuredUpdates: z.boolean().default(false) })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const s = await one(
        db,
        'INSERT INTO suppliers (org_id, name, category, default_language, response_hours_target, trusted_structured_updates, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [a.org.id, b.name, b.category, b.defaultLanguage, b.responseHoursTarget, b.trustedStructuredUpdates, a.user.id],
      );
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'supplier.created', entityType: 'supplier', entityId: s.id });
      return s;
    });
  });

  app.post('/suppliers/:id/contacts', async (req) => {
    const a = need(req, 'supplier:manage');
    const id = idParam((req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(120), email: z.string().email().max(200), role: z.enum(['to', 'cc']).default('to'), requestTypes: z.array(z.enum(REQUEST_TYPES as [string, ...string[]])).default([]) }).parse(req.body);
    return orgTx(a, async (db) => {
      if (!(await one(db, 'SELECT id FROM suppliers WHERE id = $1 AND org_id = $2', [id, a.org.id]))) throw notFound();
      // New contacts start unverified; a second person must verify them before they can receive email.
      const c = await one(
        db,
        'INSERT INTO supplier_contacts (org_id, supplier_id, name, email, role, request_types) VALUES ($1,$2,$3,lower($4),$5,$6) RETURNING *',
        [a.org.id, id, b.name, b.email, b.role, b.requestTypes],
      );
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'supplier_contact.created', entityType: 'supplier_contact', entityId: c.id, metadata: { supplierId: id } });
      return c;
    });
  });

  app.post('/supplier-contacts/:id/:action', async (req) => {
    const a = need(req, 'supplier:manage');
    const id = idParam((req.params as any).id);
    const action = (req.params as any).action;
    if (!['verify', 'deactivate'].includes(action)) throw notFound();
    return orgTx(a, async (db) => {
      const c = await one(db, 'SELECT * FROM supplier_contacts WHERE id = $1 AND org_id = $2', [id, a.org.id]);
      if (!c) throw notFound();
      const created = await one(db, "SELECT actor_id FROM audit_events WHERE entity_type = 'supplier_contact' AND entity_id = $1 AND action = 'supplier_contact.created'", [id]);
      if (action === 'verify' && created?.actor_id === a.user.id) throw new ApiError(403, 'segregation_of_duties');
      const row =
        action === 'verify'
          ? await one(db, 'UPDATE supplier_contacts SET verified = true, verified_by = $2, verified_at = now() WHERE id = $1 RETURNING *', [id, a.user.id])
          : await one(db, 'UPDATE supplier_contacts SET active = false WHERE id = $1 RETURNING *', [id]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: `supplier_contact.${action}`, entityType: 'supplier_contact', entityId: id });
      return row;
    });
  });

  /* Workbook and email templates (versioned) --------------------------------------------- */

  app.get('/workbook-templates', async (req) => {
    const a = need(req, 'email:view');
    return orgTx(a, (db) => many(db, "SELECT id, family_id, version, name, definition, base_file_document_id, inspection, feature_loss_acknowledged_by, status, created_at FROM workbook_templates WHERE org_id = $1 ORDER BY name, version DESC", [a.org.id]));
  });

  app.post('/workbook-templates', async (req) => {
    const a = need(req, 'template:manage');
    const b = z.object({ name: z.string().min(1).max(120), familyId: z.string().uuid().optional(), definition: workbookDefinitionSchema }).parse(req.body);
    return orgTx(a, async (db) => {
      let version = 1;
      let family = b.familyId ?? randomUUID();
      let baseDoc = null;
      let inspection = null;
      if (b.familyId) {
        const prev = await one(db, "SELECT * FROM workbook_templates WHERE family_id = $1 AND org_id = $2 ORDER BY version DESC LIMIT 1", [b.familyId, a.org.id]);
        if (!prev) throw notFound();
        version = prev.version + 1;
        family = prev.family_id;
        baseDoc = prev.base_file_document_id;
        inspection = prev.inspection;
        await db.query("UPDATE workbook_templates SET status = 'superseded' WHERE family_id = $1 AND status = 'active'", [family]);
      }
      const row = await one(
        db,
        `INSERT INTO workbook_templates (org_id, family_id, version, name, definition, base_file_document_id, inspection, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [a.org.id, family, version, b.name, b.definition, baseDoc, inspection, a.user.id],
      );
      // Email templates follow the latest workbook version of the family.
      if (b.familyId) await db.query("UPDATE email_templates SET workbook_template_id = $1 WHERE org_id = $2 AND status = 'active' AND workbook_template_id IN (SELECT id FROM workbook_templates WHERE family_id = $3)", [row.id, a.org.id, family]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'workbook_template.saved', entityType: 'workbook_template', entityId: row.id, metadata: { version } });
      return row;
    });
  });

  app.post('/workbook-templates/:id/base-file', async (req) => {
    const a = need(req, 'template:manage');
    const id = idParam((req.params as any).id);
    const file = await req.file();
    if (!file) throw badRequest('file_required');
    const data = await file.toBuffer();
    const type = sniff(data, file.filename);
    if (type?.ext !== 'xlsx') throw badRequest('file_type_not_allowed');
    const inspection = await inspectTemplate(data);
    return orgTx(a, async (db) => {
      const t = await one(db, 'SELECT * FROM workbook_templates WHERE id = $1 AND org_id = $2', [id, a.org.id]);
      if (!t) throw notFound();
      const stored = await putObject(a.org.id, data);
      const scan = await scanForMalware(data);
      const doc = await one(
        db,
        `INSERT INTO documents (org_id, classification, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by, scan_status, scanned_at)
         VALUES ($1,'general',$2,$3,$4,$5,$6,$7,$8, now()) RETURNING id`,
        [a.org.id, safeFilename(file.filename), type.mime, stored.size, stored.sha256, stored.key, a.user.id, scan.status],
      );
      if (scan.status !== 'clean') throw new ApiError(423, 'file_quarantined', { scanStatus: scan.status });
      const def = workbookDefinitionSchema.parse(t.definition);
      const problems = [...inspection.unsupported];
      if (def.base && !inspection.sheets.includes(def.base.sheet)) problems.push('base_sheet_missing');
      await db.query('UPDATE workbook_templates SET base_file_document_id = $2, inspection = $3, feature_loss_acknowledged_by = NULL WHERE id = $1', [
        id,
        doc.id,
        { ...inspection, ok: problems.length === 0 && !inspection.loadError, unsupported: problems },
      ]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'workbook_template.base_uploaded', entityType: 'workbook_template', entityId: id, metadata: { unsupported: problems } });
      return { inspection: { ...inspection, unsupported: problems, ok: problems.length === 0 && !inspection.loadError } };
    });
  });

  app.post('/workbook-templates/:id/acknowledge-feature-loss', async (req) => {
    const a = need(req, 'template:manage');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const t = await one(db, 'SELECT inspection FROM workbook_templates WHERE id = $1 AND org_id = $2', [id, a.org.id]);
      if (!t?.inspection) throw notFound();
      if (t.inspection.loadError) throw new ApiError(409, 'template_unreadable');
      await db.query('UPDATE workbook_templates SET feature_loss_acknowledged_by = $2 WHERE id = $1', [id, a.user.id]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'workbook_template.feature_loss_acknowledged', entityType: 'workbook_template', entityId: id, metadata: { features: t.inspection.unsupported } });
      return { ok: true };
    });
  });

  app.get('/email-templates', async (req) => {
    const a = need(req, 'email:view');
    return orgTx(a, (db) =>
      many(db, `SELECT t.*, s.name AS supplier_name FROM email_templates t JOIN suppliers s ON s.id = t.supplier_id WHERE t.org_id = $1 ORDER BY s.name, t.request_type, t.version DESC`, [a.org.id]),
    );
  });

  app.post('/email-templates', async (req) => {
    const a = need(req, 'template:manage');
    const b = emailTemplateSchema.extend({ familyId: z.string().uuid().optional() }).parse(req.body);
    return orgTx(a, async (db) => {
      if (!(await one(db, 'SELECT id FROM suppliers WHERE id = $1 AND org_id = $2', [b.supplierId, a.org.id]))) throw notFound();
      if (b.workbookTemplateId && !(await one(db, 'SELECT id FROM workbook_templates WHERE id = $1 AND org_id = $2', [b.workbookTemplateId, a.org.id]))) throw notFound();
      let version = 1;
      let family = b.familyId ?? randomUUID();
      if (b.familyId) {
        const prev = await one(db, 'SELECT version FROM email_templates WHERE family_id = $1 AND org_id = $2 ORDER BY version DESC LIMIT 1', [b.familyId, a.org.id]);
        if (!prev) throw notFound();
        version = prev.version + 1;
        await db.query("UPDATE email_templates SET status = 'superseded' WHERE family_id = $1 AND status = 'active'", [family]);
      } else {
        await db.query("UPDATE email_templates SET status = 'superseded' WHERE org_id = $1 AND supplier_id = $2 AND request_type = $3 AND status = 'active'", [a.org.id, b.supplierId, b.requestType]);
      }
      const row = await one(
        db,
        `INSERT INTO email_templates (org_id, family_id, version, name, supplier_id, request_type, language, subject_format, body_template, to_rule, cc_rule,
           required_fields, workbook_template_id, filename_convention, requires_review, automation_allowed, response_hours, reminder_hours, grouping,
           provider_instructions, confidentiality, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [a.org.id, family, version, b.name, b.supplierId, b.requestType, b.language, b.subjectFormat, b.bodyTemplate, b.toRule, b.ccRule, b.requiredFields,
          b.workbookTemplateId ?? null, b.filenameConvention, b.requiresReview, b.automationAllowed, b.responseHours, b.reminderHours, b.grouping, b.providerInstructions ?? null, b.confidentiality, a.user.id],
      );
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'email_template.saved', entityType: 'email_template', entityId: row.id, metadata: { version, automationAllowed: b.automationAllowed, requiresReview: b.requiresReview } });
      return row;
    });
  });

  /* Mailbox connections (OAuth, no passwords) -------------------------------------------- */

  app.get('/mailboxes', async (req) => {
    const a = need(req, 'email:view');
    return orgTx(a, (db) =>
      many(db, 'SELECT id, provider, address, kind, status, scopes, sync_folders, connected_at, last_sync_at, last_error FROM mailbox_connections WHERE org_id = $1 ORDER BY created_at', [a.org.id]),
    );
  });

  app.post('/mailboxes/connect', async (req) => {
    const a = need(req, 'mailbox:manage');
    const b = z.object({ provider: z.enum(['microsoft', 'google']), kind: z.enum(['individual', 'shared']).default('individual'), sharedAddress: z.string().email().optional() }).parse(req.body);
    if (b.provider === 'google') throw new ApiError(409, 'connector_not_available');
    if (!graphAvailable()) throw new ApiError(409, 'connector_not_configured');
    if (b.kind === 'shared' && !b.sharedAddress) throw badRequest('shared_address_required');
    const state = randomToken(24);
    const verifier = randomToken(48);
    await orgTx(a, (db) =>
      db.query("INSERT INTO mailbox_oauth_states (state_hash, org_id, user_id, code_verifier, kind, shared_address, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '10 minutes')", [
        sha256(state),
        a.org.id,
        a.user.id,
        verifier,
        b.kind,
        b.sharedAddress?.toLowerCase() ?? null,
      ]),
    );
    return { authorizeUrl: await graphAuthorizeUrl({ state, codeVerifier: verifier, shared: b.kind === 'shared' }) };
  });

  app.get('/mailboxes/oauth/callback', async (req, reply) => {
    const a = need(req, 'mailbox:manage');
    const q = req.query as Record<string, string>;
    const fail = (code: string) => reply.redirect(`${config.APP_BASE_URL}/settings/mailboxes?error=${encodeURIComponent(code)}`);
    if (!q.state || !q.code) return fail(q.error ? 'consent_declined' : 'invalid_callback');
    const st = await orgTx(a, (db) => one(db, 'DELETE FROM mailbox_oauth_states WHERE state_hash = $1 AND user_id = $2 RETURNING *', [sha256(q.state), a.user.id]));
    if (!st || new Date(st.expires_at) < new Date()) return fail('invalid_callback');
    try {
      const { tokens, address } = await graphExchangeCode(q.code, st.code_verifier);
      const mailboxAddress = st.kind === 'shared' ? st.shared_address : address;
      await orgTx(a, async (db) => {
        const existing = await one(db, "SELECT id FROM mailbox_connections WHERE org_id = $1 AND provider = 'microsoft' AND address = $2", [a.org.id, mailboxAddress]);
        const id = existing?.id ?? randomUUID();
        const sealed = sealTokens(id, { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: tokens.expires_at });
        if (existing) {
          await db.query("UPDATE mailbox_connections SET status = 'connected', token_ciphertext = $2, scopes = $3, connected_by = $4, connected_at = now(), last_error = NULL WHERE id = $1", [id, sealed, tokens.scope.split(' '), a.user.id]);
        } else {
          await db.query(
            `INSERT INTO mailbox_connections (id, org_id, provider, address, kind, status, token_ciphertext, scopes, connected_by, connected_at)
             VALUES ($1,$2,'microsoft',$3,$4,'connected',$5,$6,$7, now())`,
            [id, a.org.id, mailboxAddress, st.kind, sealed, tokens.scope.split(' '), a.user.id],
          );
        }
        await audit(db, actorOf(a), { orgId: a.org.id, action: 'mailbox.connected', entityType: 'mailbox', entityId: id, metadata: { address: mailboxAddress, kind: st.kind, scopes: tokens.scope } });
      });
      return reply.redirect(`${config.APP_BASE_URL}/settings/mailboxes?connected=1`);
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'mailbox connect failed');
      return fail(e instanceof ReauthorisationRequired ? 'consent_declined' : 'connection_failed');
    }
  });

  app.patch('/mailboxes/:id', async (req) => {
    const a = need(req, 'mailbox:manage');
    const id = idParam((req.params as any).id);
    // Explicit scope control: only the listed folders are synchronised.
    const b = z.object({ syncFolders: z.array(z.string().regex(/^[A-Za-z0-9=_\-]{1,200}$/)).min(1).max(10) }).parse(req.body);
    return orgTx(a, async (db) => {
      const r = await one(db, "UPDATE mailbox_connections SET sync_folders = $2, sync_state = '{}' WHERE id = $1 AND org_id = $3 RETURNING id, sync_folders", [id, b.syncFolders, a.org.id]);
      if (!r) throw notFound();
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'mailbox.scope_changed', entityType: 'mailbox', entityId: id, metadata: { folders: b.syncFolders } });
      return r;
    });
  });

  app.post('/mailboxes/:id/disconnect', async (req) => {
    const a = need(req, 'mailbox:manage');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const r = await db.query("UPDATE mailbox_connections SET status = 'revoked', token_ciphertext = NULL WHERE id = $1 AND org_id = $2", [id, a.org.id]);
      if (!r.rowCount) throw notFound();
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'mailbox.disconnected', entityType: 'mailbox', entityId: id });
      return { ok: true };
    });
  });

  app.post('/mailboxes/:id/sync', async (req) => {
    const a = need(req, 'email:associate');
    const id = idParam((req.params as any).id);
    const { syncMailbox } = await import('../worker.js');
    return syncMailbox(a.org.id, id);
  });

  /* Packages ------------------------------------------------------------------------------ */

  app.post('/packages/prepare', async (req) => {
    const a = need(req, 'email:prepare');
    const b = z.object({ crewChangeId: z.string().uuid().nullish(), requestIds: z.array(z.string().uuid()).max(500).optional(), purpose: z.enum(['request', 'amendment']).default('request') }).parse(req.body);
    return orgTx(a, (db) => preparePackages(db, a, b));
  });

  app.get('/packages', async (req) => {
    const a = need(req, 'email:view');
    const q = req.query as Record<string, string>;
    return orgTx(a, async (db) => {
      const p = new Params();
      const conds = [`p.org_id = ${p.add(a.org.id)}`];
      if (q.status) conds.push(`p.status = ANY(${p.add(q.status.split(','))})`);
      if (q.crewChangeId) conds.push(`p.crew_change_id = ${p.add(idParam(q.crewChangeId))}`);
      if (a.membership.asset_scope?.length) conds.push(`(p.crew_change_id IS NULL OR EXISTS (SELECT 1 FROM crew_changes c WHERE c.id = p.crew_change_id AND c.asset_id = ANY(${p.add(a.membership.asset_scope)}::uuid[])))`);
      return many(
        db,
        `SELECT p.id, p.reference, p.purpose, p.status, p.subject, p.to_addresses, p.blocking, p.submitted_at, p.response_due_at, p.created_at, s.name AS supplier_name,
                cc.reference AS crew_change_reference, (SELECT count(*)::int FROM package_requests pr WHERE pr.package_id = p.id) AS request_count,
                EXISTS (SELECT 1 FROM package_requests pr JOIN service_requests r ON r.id = pr.request_id WHERE pr.package_id = p.id AND r.first_response_at IS NULL) AS awaiting_response
         FROM email_packages p JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN crew_changes cc ON cc.id = p.crew_change_id
         WHERE ${conds.join(' AND ')} ORDER BY p.created_at DESC LIMIT 300`,
        p.values,
      );
    });
  });

  app.get('/packages/:id', async (req) => {
    const a = need(req, 'email:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, (db) => packagePreview(db, a, id));
  });

  app.patch('/packages/:id', async (req) => {
    const a = need(req, 'email:prepare');
    const id = idParam((req.params as any).id);
    const b = z
      .object({ version: z.number().int(), subject: z.string().min(1).max(500).optional(), bodyText: z.string().min(1).max(50_000).optional(), to: z.array(z.string().email()).optional(), cc: z.array(z.string().email()).optional(), mailboxId: z.string().uuid().nullable().optional() })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const pkg = await loadPackage(db, a, id, true);
      if (pkg.version !== b.version) throw new ApiError(409, 'edit_conflict', { currentVersion: pkg.version, current: pkg, conflicts: [{ field: 'package' }] });
      if (!['draft', 'in_review', 'approved'].includes(pkg.status)) throw new ApiError(409, 'invalid_state');
      // Recipients can only be chosen from the supplier's verified contacts.
      const verified = (await many(db, 'SELECT lower(email) AS email FROM supplier_contacts WHERE supplier_id = $1 AND verified AND active', [pkg.supplier_id])).map((c) => c.email);
      for (const e of [...(b.to ?? []), ...(b.cc ?? [])]) if (!verified.includes(e.toLowerCase())) throw new ApiError(400, 'recipient_not_verified', { email: e });
      if (b.mailboxId && !(await one(db, "SELECT id FROM mailbox_connections WHERE id = $1 AND org_id = $2 AND status = 'connected'", [b.mailboxId, a.org.id]))) throw notFound();
      if (b.subject && !b.subject.includes(pkg.reference)) throw new ApiError(400, 'subject_must_keep_reference');
      const row = await one(
        db,
        `UPDATE email_packages SET subject = coalesce($2, subject), body_text = coalesce($3, body_text), to_addresses = coalesce($4, to_addresses), cc_addresses = coalesce($5, cc_addresses),
           mailbox_id = CASE WHEN $6::boolean THEN $7 ELSE mailbox_id END, status = 'in_review', reviewed_by = NULL, reviewed_at = NULL, version = version + 1 WHERE id = $1 RETURNING *`,
        [id, b.subject ?? null, b.bodyText ?? null, b.to ?? null, b.cc ?? null, b.mailboxId !== undefined, b.mailboxId ?? null],
      );
      const stillNoRecipient = row.to_addresses.length === 0;
      const warnings = (pkg.warnings ?? []).filter((w: any) => w.code !== 'no_verified_recipient');
      if (stillNoRecipient) warnings.push({ code: 'no_verified_recipient', blocking: true });
      await db.query('UPDATE email_packages SET warnings = $2, blocking = $3 WHERE id = $1', [id, JSON.stringify(warnings), warnings.some((w: any) => w.blocking)]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'package.edited', entityType: 'package', entityId: id, metadata: { fields: Object.keys(b).filter((k) => k !== 'version') } });
      await emitChange(db, a.org.id, 'package', id, row.version, a.user.id);
      return row;
    });
  });

  app.post('/packages/:id/:action', async (req) => {
    const id = idParam((req.params as any).id);
    const action = (req.params as any).action as string;
    const b = z.object({ version: z.number().int().optional(), sentAt: z.string().datetime({ offset: true }).optional() }).parse(req.body ?? {});
    if (action === 'regenerate') {
      const a = need(req, 'email:prepare');
      return orgTx(a, (db) => regeneratePackage(db, a, id));
    }
    if (action === 'approve') {
      const a = need(req, 'email:review');
      return orgTx(a, (db) => approvePackage(db, a, id, b.version ?? -1));
    }
    if (action === 'send') {
      const a = need(req, 'email:send');
      const row = await orgTx(a, (db) => queuePackage(db, a, id, b.version ?? -1));
      // Attempt immediately; the background worker retries and reconciles if needed.
      const results = await processOutbox(a.org.id).catch(() => []);
      return { ...row, attempt: results.find((r) => r.id === id)?.outcome ?? 'queued' };
    }
    if (action === 'record-external-send') {
      const a = need(req, 'email:send');
      return orgTx(a, (db) => recordExternalSend(db, a, id, b.version ?? -1, b.sentAt ? new Date(b.sentAt) : new Date()));
    }
    if (action === 'cancel') {
      const a = need(req, 'email:prepare');
      return orgTx(a, async (db) => {
        const pkg = await loadPackage(db, a, id, true);
        if (!['draft', 'in_review', 'approved', 'send_failed'].includes(pkg.status)) throw new ApiError(409, 'invalid_state');
        const row = await one(db, "UPDATE email_packages SET status = 'cancelled', cancelled_by = $2, version = version + 1 WHERE id = $1 RETURNING *", [id, a.user.id]);
        await audit(db, actorOf(a), { orgId: a.org.id, action: 'package.cancelled', entityType: 'package', entityId: id });
        return row;
      });
    }
    if (action === 'links') {
      const a = need(req, 'email:view');
      return orgTx(a, async (db) => {
        const pkg = await loadPackage(db, a, id);
        const atts = await many(db, 'SELECT a.id, a.filename FROM package_attachments pa JOIN attachments a ON a.id = pa.attachment_id WHERE pa.package_id = $1', [pkg.id]);
        return {
          eml: `/api/files/${signLink({ kind: 'package_eml', id: pkg.id, org: a.org.id, sid: a.session.id })}`,
          attachments: atts.map((x) => ({ id: x.id, filename: x.filename, url: `/api/files/${signLink({ kind: 'attachment', id: x.id, org: a.org.id, sid: a.session.id })}` })),
          expiresInSeconds: 60,
        };
      });
    }
    throw notFound();
  });

  app.post('/attachments/:id/link', async (req) => {
    const a = need(req, 'email:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      await attachmentForDownload(db, a, { kind: 'attachment', id, org: a.org.id, sid: a.session.id, exp: 0 });
      return { url: `/api/files/${signLink({ kind: 'attachment', id, org: a.org.id, sid: a.session.id })}`, expiresInSeconds: 60 };
    });
  });

  /* Messages ------------------------------------------------------------------------------ */

  app.get('/messages', async (req) => {
    const a = need(req, 'email:view');
    const q = req.query as Record<string, string>;
    return orgTx(a, async (db) => {
      if (q.status === 'unmatched') {
        if (!can(a, 'email:associate') || a.membership.asset_scope?.length) return [];
        return many(
          db,
          `SELECT id, source, from_address, subject, received_at, match_confidence, match_candidates, warnings, is_forward,
                  (SELECT count(*)::int FROM message_attachments ma WHERE ma.message_id = m.id) AS attachments
           FROM email_messages m WHERE org_id = $1 AND match_status = 'unmatched' AND direction = 'inbound' ORDER BY received_at DESC LIMIT 200`,
          [a.org.id],
        );
      }
      const p = new Params();
      return many(
        db,
        `SELECT DISTINCT m.id, m.direction, m.source, m.from_address, m.subject, m.received_at, m.match_method, m.match_confidence
         FROM email_messages m JOIN message_links l ON l.message_id = m.id JOIN service_requests r ON r.id = l.request_id
         WHERE ${requestScope(a, p)} ORDER BY m.received_at DESC LIMIT 200`,
        p.values,
      );
    });
  });

  app.get('/messages/:id', async (req) => {
    const a = need(req, 'email:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const m = await one(db, 'SELECT * FROM email_messages WHERE id = $1 AND org_id = $2', [id, a.org.id]);
      if (!m) throw notFound();
      const visible = await visibleLinkedRequests(db, a, id);
      const all = await many(db, 'SELECT r.reference FROM message_links l JOIN service_requests r ON r.id = l.request_id WHERE l.message_id = $1', [id]);
      if (!visible.length && !(m.match_status === 'unmatched' && (await canSeeUnmatched(db, a, id)))) throw notFound();
      const { body, redacted } = m.match_status === 'unmatched' ? { body: m.body_text, redacted: false } : redactBody(m.body_text ?? '', all.map((x) => x.reference), visible.map((x) => x.reference));
      const attachments = await many(
        db,
        'SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.scan_status, a.kind FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = $1',
        [id],
      );
      const proposals = await many(db, 'SELECT * FROM extraction_proposals WHERE message_id = $1 AND request_id = ANY($2::uuid[]) ORDER BY created_at', [id, visible.map((v) => v.id)]);
      const reconciliations = await many(db, 'SELECT id, status, result, created_at FROM workbook_reconciliations WHERE message_id = $1', [id]);
      for (const rec of reconciliations) await refreshReconciliation(db, a.org.id, rec.result);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'message.viewed', entityType: 'message', entityId: id });
      return {
        ...m,
        body_text: body,
        bodyRedacted: redacted,
        // Untrusted content: rendered as plain text only, never as HTML, and never executed.
        contentTrust: 'untrusted_external',
        requests: visible,
        attachments,
        proposals,
        reconciliations: redacted ? [] : reconciliations,
      };
    });
  });

  app.post('/messages/import', async (req) => {
    const a = need(req, 'email:associate');
    const file = await req.file();
    if (!file) throw badRequest('file_required');
    const data = await file.toBuffer();
    if (sniff(data, file.filename)?.ext !== 'eml') throw badRequest('file_type_not_allowed');
    const parsed = await simpleParser(data, { skipHtmlToText: false });
    const addr = (v: any) => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x: any) => x.value ?? []).map((x: any) => String(x.address ?? '').toLowerCase()).filter(Boolean);
    const inbound = {
      providerMessageId: null,
      internetMessageId: parsed.messageId ?? null,
      conversationId: null,
      inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : null,
      references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
      from: addr(parsed.from)[0] ?? null,
      to: addr(parsed.to),
      cc: addr(parsed.cc),
      subject: parsed.subject ?? '',
      // HTML is converted to text; scripts, styles and remote content are discarded.
      text: parsed.text ?? '',
      receivedAt: parsed.date ?? new Date(),
      attachments: parsed.attachments.map((x) => ({ filename: x.filename ?? 'attachment', contentType: x.contentType, content: x.content })),
    };
    return orgTx(a, (db) => ingestInbound(db, a.org.id, inbound, { source: 'manual_import', importedBy: a.user.id }));
  });

  app.post('/messages/:id/link', async (req) => {
    const a = need(req, 'email:associate');
    const id = idParam((req.params as any).id);
    const b = z.object({ requestIds: z.array(z.string().uuid()).min(1).max(100) }).parse(req.body);
    return orgTx(a, async (db) => {
      const m = await one(db, 'SELECT id FROM email_messages WHERE id = $1 AND org_id = $2', [id, a.org.id]);
      if (!m) throw notFound();
      const p = new Params();
      const ok = await many(db, `SELECT r.id FROM service_requests r WHERE r.id = ANY(${p.add(b.requestIds)}::uuid[]) AND ${requestScope(a, p)}`, p.values);
      if (ok.length !== b.requestIds.length) throw notFound();
      await linkMessage(db, a.org.id, id, b.requestIds, 'manual', 1, a.user.id);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'message.linked', entityType: 'message', entityId: id, metadata: { requests: b.requestIds.length } });
      return { ok: true };
    });
  });

  app.post('/messages/:id/ignore', async (req) => {
    const a = need(req, 'email:associate');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const r = await db.query("UPDATE email_messages SET match_status = 'ignored' WHERE id = $1 AND org_id = $2 AND match_status = 'unmatched'", [id, a.org.id]);
      if (!r.rowCount) throw notFound();
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'message.ignored', entityType: 'message', entityId: id });
      return { ok: true };
    });
  });

  /* Extraction proposals ------------------------------------------------------------------ */

  app.get('/proposals', async (req) => {
    const a = need(req, 'email:view');
    return orgTx(a, async (db) => {
      const p = new Params();
      return many(
        db,
        `SELECT x.id, x.classification, x.fields, x.critical, x.status, x.created_at, x.message_id, x.request_id, x.request_version,
                r.reference, r.type, r.status AS request_status, r.version AS current_version, pe.full_name, m.subject, m.from_address, m.received_at
         FROM extraction_proposals x JOIN service_requests r ON r.id = x.request_id JOIN personnel pe ON pe.id = r.personnel_id JOIN email_messages m ON m.id = x.message_id
         WHERE x.status = 'pending' AND ${requestScope(a, p)} ORDER BY x.created_at DESC LIMIT 200`,
        p.values,
      );
    });
  });

  app.post('/proposals/:id/apply', async (req) => {
    const a = need(req, 'request:edit');
    const id = idParam((req.params as any).id);
    const b = z
      .object({ fields: z.array(z.string()).max(30).default([]), resultingStatus: z.enum(['acknowledged', 'quoted', 'proposed', 'confirmed', 'cancelled', 'unchanged']).default('unchanged'), version: z.number().int() })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const x = await one(db, "SELECT * FROM extraction_proposals WHERE id = $1 AND org_id = $2 AND status = 'pending' FOR UPDATE", [id, a.org.id]);
      if (!x) throw notFound();
      const p = new Params();
      const r = await one(db, `SELECT r.* FROM service_requests r WHERE r.id = ${p.add(x.request_id)} AND ${requestScope(a, p)}`, p.values);
      if (!r) throw notFound();
      const items: any[] = x.fields.items ?? [];
      const selected = items.filter((f) => b.fields.includes(f.field));
      let version = b.version;
      if (selected.length) {
        const changes = Object.fromEntries(selected.map((f) => [f.field, f.proposed]));
        const base = Object.fromEntries(selected.map((f) => [f.field, f.current]));
        const res = await applyRequestChanges(db, a, r.id, version, changes, base, { source: 'extraction', messageId: x.message_id });
        version = res.record.version;
      }
      if (b.resultingStatus !== 'unchanged') {
        const cur = await one(db, 'SELECT * FROM service_requests WHERE id = $1 FOR UPDATE', [r.id]);
        if (!STATUS_FLOW[cur.status]?.includes(b.resultingStatus) && cur.status !== b.resultingStatus) throw new ApiError(409, 'invalid_transition', { from: cur.status, to: b.resultingStatus });
        // "Received" alone can never confirm a booking: confirmation requires a proposal classified as a confirmation or a confirmed modification.
        if (b.resultingStatus === 'confirmed' && !(x.classification === 'confirmed' || (x.classification === 'modification' && x.fields.alsoConfirms))) {
          throw new ApiError(409, 'not_a_confirmation', { classification: x.classification });
        }
        await db.query(
          `UPDATE service_requests SET status = $2, version = version + 1, updated_by = $3, updated_at = now(),
             confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END, confirmed_by = CASE WHEN $2 = 'confirmed' THEN $3 ELSE confirmed_by END,
             cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END, cancelled_by = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancelled_by END WHERE id = $1`,
          [r.id, b.resultingStatus, a.user.id],
        );
        await addRequestEvent(db, a.org.id, r.id, b.resultingStatus === 'confirmed' ? 'confirmation_recorded' : b.resultingStatus === 'cancelled' ? 'cancelled' : 'changed', a.user.id, {
          messageId: x.message_id,
          detail: { from: cur.status, to: b.resultingStatus, proposalId: id },
        });
      }
      if (x.classification === 'missing_info') {
        const t = await one(
          db,
          `INSERT INTO tasks (org_id, title, kind, priority, assignee_id, request_id, crew_change_id, created_by, due_at) VALUES ($1,$2,'mobilisation','high',$3,$4,$5,$3, now() + interval '1 day') RETURNING id`,
          [a.org.id, `Provide information requested by supplier (${r.reference})`, a.user.id, r.id, r.crew_change_id],
        );
        await notify(db, a.org.id, a.user.id, 'task_assigned', { title: r.reference }, { type: 'task', id: t.id });
      }
      await db.query("UPDATE extraction_proposals SET status = 'applied', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [id, a.user.id]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'proposal.applied', entityType: 'request', entityId: r.id, metadata: { proposalId: id, fields: b.fields, status: b.resultingStatus, classification: x.classification } });
      await emitChange(db, a.org.id, 'request', r.id, null, a.user.id);
      return one(db, 'SELECT * FROM service_requests WHERE id = $1', [r.id]);
    });
  });

  app.post('/proposals/:id/reject', async (req) => {
    const a = need(req, 'request:edit');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const x = await one(db, "SELECT * FROM extraction_proposals WHERE id = $1 AND org_id = $2 AND status = 'pending'", [id, a.org.id]);
      if (!x) throw notFound();
      const p = new Params();
      if (!(await one(db, `SELECT r.id FROM service_requests r WHERE r.id = ${p.add(x.request_id)} AND ${requestScope(a, p)}`, p.values))) throw notFound();
      await db.query("UPDATE extraction_proposals SET status = 'rejected', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [id, a.user.id]);
      await db.query("UPDATE service_requests SET status = 'confirmed', version = version + 1 WHERE id = $1 AND status = 'change_pending_review' AND confirmed_at IS NOT NULL", [x.request_id]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'proposal.rejected', entityType: 'request', entityId: x.request_id, metadata: { proposalId: id } });
      return { ok: true };
    });
  });

  /* Returned workbook reconciliations ----------------------------------------------------- */

  app.get('/reconciliations/:id', async (req) => {
    const a = need(req, 'email:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const r = await one(db, 'SELECT * FROM workbook_reconciliations WHERE id = $1 AND org_id = $2', [id, a.org.id]);
      if (!r) throw notFound();
      if (r.package_id) await loadPackage(db, a, r.package_id);
      return { ...r, result: await refreshReconciliation(db, a.org.id, r.result) };
    });
  });

  app.post('/reconciliations/:id/apply', async (req) => {
    const a = need(req, 'request:edit');
    const id = idParam((req.params as any).id);
    const b = z
      .object({ selections: z.array(z.object({ requestId: z.string().uuid(), version: z.number().int(), keys: z.array(z.string()).min(1), conflictsResolvedAs: z.enum(['returned']).optional() })).min(1).max(500) })
      .parse(req.body);
    return orgTx(a, async (db) => {
      const rec = await one(db, "SELECT * FROM workbook_reconciliations WHERE id = $1 AND org_id = $2 AND status = 'pending' FOR UPDATE", [id, a.org.id]);
      if (!rec) throw notFound();
      if (rec.package_id) await loadPackage(db, a, rec.package_id);
      await refreshReconciliation(db, a.org.id, rec.result);
      const applied = [];
      for (const s of b.selections) {
        const row = rec.result.rows.find((r: any) => r.requestId === s.requestId);
        if (!row) throw badRequest('row_not_in_reconciliation');
        const chosen = row.changes.filter((c: any) => s.keys.includes(c.key) && c.applicable);
        // Conflicting changes are never applied implicitly: the reviewer must say so explicitly.
        if (chosen.some((c: any) => c.conflict) && s.conflictsResolvedAs !== 'returned') throw new ApiError(409, 'conflict_resolution_required', { requestId: s.requestId });
        const changes: Record<string, unknown> = {};
        const base: Record<string, unknown> = {};
        for (const c of chosen) {
          const target = c.key.startsWith('request.') ? c.key.slice(8) : c.key;
          changes[target] = target === 'cost_amount' ? Number(c.returned) : c.returned;
          base[target] = c.current;
        }
        if (Object.keys(changes).length) applied.push((await applyRequestChanges(db, a, s.requestId, s.version, changes, base, { source: 'workbook', messageId: rec.message_id ?? undefined })).record.id);
      }
      await db.query("UPDATE workbook_reconciliations SET status = 'applied', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [id, a.user.id]);
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'workbook.changes_applied', entityType: 'reconciliation', entityId: id, metadata: { requests: applied.length } });
      return { applied: applied.length };
    });
  });

  app.post('/reconciliations/:id/reject', async (req) => {
    const a = need(req, 'request:edit');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const r = await db.query("UPDATE workbook_reconciliations SET status = 'rejected', reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND org_id = $3 AND status = 'pending'", [id, a.user.id, a.org.id]);
      if (!r.rowCount) throw notFound();
      await audit(db, actorOf(a), { orgId: a.org.id, action: 'workbook.changes_rejected', entityType: 'reconciliation', entityId: id });
      return { ok: true };
    });
  });

  /* Request timeline ---------------------------------------------------------------------- */

  app.get('/requests/:id/timeline', async (req) => {
    const a = need(req, 'request:view');
    const id = idParam((req.params as any).id);
    return orgTx(a, async (db) => {
      const p = new Params();
      const r = await one(db, `SELECT r.* FROM service_requests r WHERE r.id = ${p.add(id)} AND ${requestScope(a, p)}`, p.values);
      if (!r) throw notFound();
      const events = await many(db, 'SELECT stage, at, package_id, message_id, detail FROM request_events WHERE request_id = $1 ORDER BY at, id', [id]);
      const stages = ['draft_prepared', 'reviewed', 'queued', 'submitted', 'response_received', 'confirmation_recorded', 'completed'];
      const packages = await many(db, 'SELECT p.status, p.send_channel FROM package_requests pr JOIN email_packages p ON p.id = pr.package_id WHERE pr.request_id = $1', [id]);
      return {
        stages: stages.map((s) => ({ stage: s, reachedAt: events.find((e) => e.stage === s)?.at ?? null })),
        // Technical sending status is reported separately from the business status. Delivery or
        // read status is never claimed: Graph does not provide reliable evidence of either here.
        technical: packages.map((p) => ({ status: p.status, channel: p.send_channel })),
        business: r.status,
        events,
      };
    });
  });
}
