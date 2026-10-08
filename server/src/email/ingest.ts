import { audit } from '../audit/audit.js';
import { many, one, type Db } from '../db/pool.js';
import { refreshInsights } from '../domain/insights.js';
import { CRITICAL_FIELDS, type RequestType } from '../domain/requests.js';
import { addRequestEvent } from '../api/operations.js';
import { emitChange } from '../realtime/events.js';
import { putObject, safeFilename, scanForMalware, sniff, getObject } from '../storage/files.js';
import { analyse, extractFields, findReferences, ownContentRange, classify } from './extraction.js';
import { canonicalFromCell, readWorkbook, REF_KEY, workbookDefinitionSchema } from './xlsx.js';
import type { InboundEmail } from './connectors/types.js';

export const AUTO_LINK_THRESHOLD = 0.85;
const ALLOWED_INBOUND = ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'image/png', 'image/jpeg'];

interface MatchResult {
  confidence: number;
  method: string;
  packageId: string | null;
  requestIds: string[];
  candidates: { requestId?: string; packageId?: string; reference: string; reason: string; confidence: number }[];
  warnings: string[];
}

/**
 * Associates a message with requests. Signals, strongest first: provider threading headers
 * (In-Reply-To / References), provider conversation id, package reference, request references.
 * Names are never used. The sender must be a verified contact of the supplier concerned or
 * the confidence is lowered and the message goes to the manual "unmatched" queue.
 */
export async function matchMessage(db: Db, orgId: string, m: InboundEmail): Promise<MatchResult> {
  const range = ownContentRange(m.text);
  const searchable = `${m.subject}\n${m.text}`;
  const refs = findReferences(searchable);
  let pkg: any = null;
  let confidence = 0;
  let method = 'none';
  const threadIds = [m.inReplyTo, ...m.references].filter(Boolean) as string[];
  if (threadIds.length) {
    pkg = await one(db, "SELECT * FROM email_packages WHERE org_id = $1 AND internet_message_id = ANY($2) AND status = 'submitted' ORDER BY submitted_at DESC LIMIT 1", [orgId, threadIds]);
    if (pkg) [confidence, method] = [0.99, 'thread_headers'];
  }
  if (!pkg && m.conversationId) {
    pkg = await one(db, "SELECT * FROM email_packages WHERE org_id = $1 AND conversation_id = $2 AND status = 'submitted' ORDER BY submitted_at DESC LIMIT 1", [orgId, m.conversationId]);
    if (pkg) [confidence, method] = [0.95, 'conversation_id'];
  }
  if (!pkg && refs.packages.length) {
    pkg = await one(db, "SELECT * FROM email_packages WHERE org_id = $1 AND reference = ANY($2) AND status = 'submitted' ORDER BY submitted_at DESC LIMIT 1", [orgId, refs.packages]);
    if (pkg) [confidence, method] = [0.9, 'package_reference'];
  }
  const pkgRequests = pkg ? await many(db, 'SELECT r.id, r.reference, r.supplier_id FROM package_requests pr JOIN service_requests r ON r.id = pr.request_id WHERE pr.package_id = $1', [pkg.id]) : [];
  const refRequests = refs.requests.length ? await many(db, 'SELECT id, reference, supplier_id FROM service_requests WHERE org_id = $1 AND reference = ANY($2)', [orgId, refs.requests]) : [];

  let requestIds: string[];
  if (pkg) {
    // A reply to a package that names specific requests relates only to those requests.
    const named = pkgRequests.filter((r) => refs.requests.includes(r.reference));
    const extra = refRequests.filter((r) => !pkgRequests.some((p) => p.id === r.id));
    requestIds = [...(named.length ? named : pkgRequests), ...extra].map((r) => r.id);
  } else {
    requestIds = refRequests.map((r) => r.id);
    if (refRequests.length) [confidence, method] = [0.9, 'request_reference'];
  }

  const warnings: string[] = [];
  const supplierIds = [...new Set([...pkgRequests, ...refRequests].filter((r) => requestIds.includes(r.id)).map((r) => r.supplier_id).filter(Boolean))];
  if (requestIds.length && m.from) {
    const known = await one(db, 'SELECT 1 FROM supplier_contacts WHERE org_id = $1 AND lower(email) = $2 AND verified AND supplier_id = ANY($3::uuid[])', [orgId, m.from, supplierIds]);
    if (!known) {
      const internal = await one(db, "SELECT 1 FROM users u JOIN memberships mm ON mm.user_id = u.id WHERE mm.org_id = $1 AND lower(u.email) = $2 AND mm.status = 'active'", [orgId, m.from]);
      // A colleague forwarding a supplier reply is acceptable; an unknown external sender is not.
      if (!internal || !range.isForward) {
        warnings.push('sender_not_verified_supplier_contact');
        confidence = Math.min(confidence, 0.6);
      }
    }
  }

  const candidates: MatchResult['candidates'] = [];
  if (confidence < AUTO_LINK_THRESHOLD) {
    for (const r of [...pkgRequests, ...refRequests]) candidates.push({ requestId: r.id, reference: r.reference, reason: method, confidence });
    if (!candidates.length && m.from) {
      // Weak hint only: open packages awaiting this sender. Never auto-linked.
      const open = await many(
        db,
        `SELECT p.id, p.reference FROM email_packages p JOIN supplier_contacts c ON c.supplier_id = p.supplier_id AND lower(c.email) = $2 AND c.verified
         WHERE p.org_id = $1 AND p.status = 'submitted' AND p.submitted_at > now() - interval '30 days' ORDER BY p.submitted_at DESC LIMIT 5`,
        [orgId, m.from],
      );
      for (const p of open) candidates.push({ packageId: p.id, reference: p.reference, reason: 'sender_has_open_packages', confidence: 0.4 });
    }
  }
  return { confidence, method, packageId: pkg?.id ?? null, requestIds, candidates, warnings };
}

/** Stores one inbound message (idempotently) and runs association and extraction. */
export async function ingestInbound(db: Db, orgId: string, m: InboundEmail, opts: { source: 'sync' | 'manual_import'; mailboxId?: string | null; importedBy?: string | null }) {
  if (m.internetMessageId) {
    const dup = await one(db, 'SELECT id FROM email_messages WHERE org_id = $1 AND internet_message_id = $2', [orgId, m.internetMessageId]);
    if (dup) return { messageId: dup.id, duplicate: true, stored: true };
  }
  const match = await matchMessage(db, orgId, m);
  // Synchronisation imports only messages related to our requests or from known supplier
  // contacts; the rest of the mailbox is never stored.
  if (opts.source === 'sync' && !match.requestIds.length && !match.candidates.length) {
    const fromSupplier = m.from ? await one(db, 'SELECT 1 FROM supplier_contacts WHERE org_id = $1 AND lower(email) = $2 AND verified', [orgId, m.from]) : null;
    if (!fromSupplier) return { messageId: null, duplicate: false, stored: false };
  }
  const autoLinked = match.confidence >= AUTO_LINK_THRESHOLD && match.requestIds.length > 0;
  const range = ownContentRange(m.text);
  const msg = await one(
    db,
    `INSERT INTO email_messages (org_id, mailbox_id, source, direction, provider_message_id, internet_message_id, conversation_id, in_reply_to, references_ids,
       from_address, to_addresses, cc_addresses, subject, body_text, received_at, is_forward, match_status, match_confidence, match_method, package_id,
       imported_by, match_candidates, warnings)
     VALUES ($1,$2,$3,'inbound',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
    [
      orgId, opts.mailboxId ?? null, opts.source, m.providerMessageId, m.internetMessageId, m.conversationId, m.inReplyTo, m.references, m.from, m.to, m.cc,
      m.subject.slice(0, 500), m.text.slice(0, 200_000), m.receivedAt, range.isForward, autoLinked ? 'matched' : 'unmatched', match.confidence, match.method,
      autoLinked ? match.packageId : null, opts.importedBy ?? null, JSON.stringify(match.candidates), JSON.stringify(match.warnings),
    ],
  );

  const attachmentIds: string[] = [];
  for (const att of m.attachments) {
    const type = sniff(att.content, att.filename);
    if (!type || !ALLOWED_INBOUND.includes(type.mime)) continue; // not stored: unsupported or disallowed file type
    const stored = await putObject(orgId, att.content);
    const scan = await scanForMalware(att.content);
    const row = await one(
      db,
      `INSERT INTO attachments (org_id, kind, filename, mime_type, size_bytes, sha256, storage_key, scan_status) VALUES ($1,'inbound',$2,$3,$4,$5,$6,$7) RETURNING id`,
      [orgId, safeFilename(att.filename), type.mime, stored.size, stored.sha256, stored.key, scan.status],
    );
    await db.query('INSERT INTO message_attachments (message_id, attachment_id, org_id) VALUES ($1,$2,$3)', [msg.id, row.id, orgId]);
    attachmentIds.push(row.id);
  }
  await audit(db, { userId: opts.importedBy ?? null }, {
    orgId,
    action: opts.source === 'manual_import' ? 'message.imported' : 'message.synchronised',
    entityType: 'message',
    entityId: msg.id,
    metadata: { matched: autoLinked, method: match.method, confidence: match.confidence, attachments: attachmentIds.length },
  });
  if (autoLinked) await linkMessage(db, orgId, msg.id, match.requestIds, match.method, match.confidence, null);
  await emitChange(db, orgId, 'message', msg.id, null, opts.importedBy ?? null);
  return { messageId: msg.id, duplicate: false, stored: true, matched: autoLinked, match };
}

/** Links a message to requests (automatically or by a person) and runs downstream processing. */
export async function linkMessage(db: Db, orgId: string, messageId: string, requestIds: string[], method: string, confidence: number, userId: string | null) {
  const msg = await one(db, 'SELECT * FROM email_messages WHERE id = $1 AND org_id = $2', [messageId, orgId]);
  if (!msg) return;
  for (const rid of requestIds) {
    await db.query(
      `INSERT INTO message_links (message_id, request_id, org_id, method, confidence, linked_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [messageId, rid, orgId, method, confidence, userId],
    );
    await db.query('UPDATE service_requests SET first_response_at = coalesce(first_response_at, $2) WHERE id = $1', [rid, msg.received_at]);
    await addRequestEvent(db, orgId, rid, 'response_received', userId, { messageId, detail: { method } });
  }
  await db.query("UPDATE email_messages SET match_status = 'matched', match_method = coalesce($2, match_method), match_confidence = greatest(coalesce(match_confidence, 0), $3) WHERE id = $1", [
    messageId,
    method,
    confidence,
  ]);

  // A relevant response stops pending reminders for the packages it answers.
  await db.query(
    `UPDATE reminders SET status = 'cancelled', reason = 'response_received' WHERE org_id = $1 AND status = 'scheduled'
       AND package_id IN (SELECT package_id FROM package_requests WHERE request_id = ANY($2::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM package_requests pr JOIN service_requests sr ON sr.id = pr.request_id
                        WHERE pr.package_id = reminders.package_id AND sr.first_response_at IS NULL AND sr.status NOT IN ('cancelled', 'completed'))`,
    [orgId, requestIds],
  );
  await db.query(
    `UPDATE email_packages SET status = 'cancelled' WHERE org_id = $1 AND purpose = 'reminder' AND status IN ('draft', 'in_review')
       AND id IN (SELECT package_id FROM package_requests WHERE request_id = ANY($2::uuid[]))`,
    [orgId, requestIds],
  );

  await createProposals(db, orgId, msg, requestIds);
  const atts = await many(
    db,
    "SELECT a.* FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = $1 AND a.mime_type LIKE 'application/vnd.openxmlformats%'",
    [messageId],
  );
  for (const at of atts) {
    if (at.scan_status !== 'clean') continue; // quarantined files are never parsed
    await reconcileReturnedWorkbook(db, orgId, at, messageId, requestIds);
  }
  await refreshInsights(db, orgId);
}

/** Creates one proposal per linked request from the message body. */
export async function createProposals(db: Db, orgId: string, msg: any, requestIds: string[]) {
  const reqs = await many(db, 'SELECT * FROM service_requests WHERE org_id = $1 AND id = ANY($2::uuid[])', [orgId, requestIds]);
  const year = new Date(msg.received_at ?? Date.now()).getUTCFullYear();
  const text: string = msg.body_text ?? '';
  const { results, range } = analyse(text, reqs.map((r) => r.reference), year, (ref) => reqs.find((r) => r.reference === ref)?.type);
  const general = results.find((r) => r.refs.length === 0 || r.refs[0] === '*');
  for (const r of reqs) {
    const seg = results.find((s) => s.refs.includes(r.reference));
    let cls = seg ?? general;
    let fields = seg?.fields ?? [];
    if (!seg && reqs.length === 1) {
      // Single-request reply without explicit references: read the whole own-content region.
      const own = text.slice(range.start, range.end);
      cls = { ...classify(text, range.start, own), refs: [], start: range.start, end: range.end, text: own, fields: [] } as any;
      fields = extractFields(text, range.start, own, r.type, year);
    }
    if (!cls) continue;
    const proposed = fields
      .map((f) => {
        const current = f.field.startsWith('details.') ? r.details?.[f.field.slice(8)] ?? null : r[f.field] ?? null;
        return { field: f.field, current, proposed: f.value, source: f.source, changed: String(current ?? '') !== String(f.value) };
      })
      .filter((f) => f.changed || ['confirmed', 'modification'].includes(cls!.classification));
    const critical =
      ['confirmed', 'modification', 'cancellation', 'proposed'].includes(cls.classification) ||
      proposed.some((f) => f.changed && CRITICAL_FIELDS[r.type as RequestType]?.includes(f.field.replace('details.', '')));
    await db.query("UPDATE extraction_proposals SET status = 'superseded' WHERE request_id = $1 AND status = 'pending' AND message_id <> $2", [r.id, msg.id]);
    await db.query(
      `INSERT INTO extraction_proposals (org_id, message_id, request_id, classification, extractor, fields, critical, request_version)
       VALUES ($1,$2,$3,$4,'rules',$5,$6,$7)`,
      [orgId, msg.id, r.id, cls.classification, JSON.stringify({ items: proposed, evidence: cls.evidence, alsoConfirms: cls.alsoConfirms, negatedConfirmation: cls.negatedConfirmation, assumptions: ['day_first_numeric_dates', 'times_local_to_request_location'] }), critical, r.version],
    );
    // A business status changes only after a person validates it — including acknowledgements.
    if (['modification', 'cancellation'].includes(cls.classification) && r.status === 'confirmed') {
      await db.query("UPDATE service_requests SET status = 'change_pending_review', version = version + 1 WHERE id = $1", [r.id]);
    }
  }
}

/* Returned workbook reconciliation ------------------------------------------------------- */

const APPLICABLE = (key: string) => key.startsWith('details.') || ['request.booking_reference', 'request.cost_amount', 'request.cost_currency'].includes(key);
const NON_CRITICAL = new Set(['request.booking_reference', 'details.confirmation_no']);

function canonicalSnapshot(type: string, v: unknown) {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'number') return String(Number(v));
  if (type === 'datetime') return String(v).slice(0, 16);
  return String(v);
}

/**
 * Compares a returned workbook with the version we sent and with current records.
 * Rows are matched by the stable request reference column (never by person name).
 */
export async function reconcileReturnedWorkbook(db: Db, orgId: string, returned: any, messageId: string | null, linkedRequestIds: string[]) {
  const buf = await getObject(returned.storage_key);
  const firstPass = await readWorkbook(buf, ['Ref']).catch(() => null);
  let original: any = null;
  if (firstPass?.meta.attachment_id) {
    original = await one(db, "SELECT * FROM attachments WHERE id = $1 AND org_id = $2 AND kind = 'generated'", [firstPass.meta.attachment_id, orgId]);
  }
  if (!original && linkedRequestIds.length) {
    original = await one(
      db,
      `SELECT a.* FROM package_requests pr JOIN package_attachments pa ON pa.package_id = pr.package_id JOIN attachments a ON a.id = pa.attachment_id
       WHERE pr.request_id = ANY($1::uuid[]) AND a.kind = 'generated' ORDER BY pa.superseded_at NULLS FIRST, a.created_at DESC LIMIT 1`,
      [linkedRequestIds],
    );
  }
  if (!original) return null;
  const wbt = await one(db, 'SELECT * FROM workbook_templates WHERE id = $1', [original.workbook_template_id]);
  const def = workbookDefinitionSchema.parse(wbt.definition);
  const columns = def.columns.some((c) => c.key === REF_KEY) ? def.columns : [{ key: REF_KEY, heading: 'Ref', type: 'text' as const, required: true }, ...def.columns];
  const refHeading = columns.find((c) => c.key === REF_KEY)!.heading;
  const book = await readWorkbook(buf, [refHeading]);
  const sentRows: any[] = original.source_snapshot?.rows ?? [];
  const pkg = await one(db, 'SELECT pa.package_id FROM package_attachments pa WHERE pa.attachment_id = $1 LIMIT 1', [original.id]);
  const supplier = pkg ? await one(db, 'SELECT s.* FROM email_packages p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1', [pkg.package_id]) : null;

  const rows: any[] = [];
  const seen = new Set<string>();
  for (const sheet of book.sheets) {
    for (const r of sheet.rows) {
      const ref = (r.values[refHeading] ?? '').trim().replace(/^'/, '');
      const sent = sentRows.find((s) => s[REF_KEY] === ref);
      if (!ref || !sent) {
        rows.push({ sheet: sheet.name, rowNo: r.rowNo, reference: ref || null, status: ref ? 'unknown_reference' : 'added_without_reference', changes: [], values: r.values });
        continue;
      }
      seen.add(ref);
      const current = await one(db, 'SELECT * FROM service_requests WHERE id = $1 AND org_id = $2', [sent['request.id'], orgId]);
      const changes = [];
      // Date and time columns of the same datetime field are recombined.
      const dtParts: Record<string, { date?: string | null; time?: string | null; heading: string[] }> = {};
      for (const c of columns) {
        if (c.key === REF_KEY || c.type === 'formula' || c.key.startsWith('identity.')) continue;
        if (!(c.heading in r.values)) continue;
        const returnedV = canonicalFromCell(c.type, r.values[c.heading]);
        const sentV = canonicalSnapshot(c.type, sent[c.key]);
        if (returnedV === sentV) continue;
        const [base, part] = c.key.split(':');
        if (part && base.startsWith('details.')) {
          dtParts[base] = dtParts[base] ?? { heading: [] };
          dtParts[base][part as 'date' | 'time'] = returnedV;
          dtParts[base].heading.push(c.heading);
          continue;
        }
        const field = c.key.startsWith('request.') ? c.key.slice(8) : c.key;
        const currentV = c.key.startsWith('details.') ? current?.details?.[c.key.slice(8)] ?? null : current?.[field] ?? null;
        const dbChanged = canonicalSnapshot(c.type, currentV) !== sentV;
        changes.push({
          column: c.heading,
          key: c.key,
          field,
          sent: sentV,
          returned: returnedV,
          current: canonicalSnapshot(c.type, currentV),
          conflict: dbChanged && canonicalSnapshot(c.type, currentV) !== returnedV,
          applicable: APPLICABLE(c.key),
        });
      }
      for (const [base, p] of Object.entries(dtParts)) {
        const sentFull = String(sent[base] ?? '');
        const value = `${p.date ?? sentFull.slice(0, 10)}T${p.time ?? sentFull.slice(11, 16)}`;
        const currentV = current?.details?.[base.slice(8)] ?? null;
        changes.push({
          column: p.heading.join(' + '),
          key: base,
          field: base,
          sent: sentFull || null,
          returned: value,
          current: currentV,
          conflict: currentV !== (sentFull || null) && currentV !== value,
          applicable: true,
        });
      }
      rows.push({
        sheet: sheet.name,
        rowNo: r.rowNo,
        reference: ref,
        requestId: sent['request.id'],
        requestVersion: current?.version ?? null,
        status: changes.length ? (changes.some((c) => c.conflict) ? 'conflict' : 'changed') : 'unchanged',
        changes,
      });
    }
  }
  for (const s of sentRows) if (!seen.has(String(s[REF_KEY]))) rows.push({ reference: s[REF_KEY], requestId: s['request.id'], status: 'removed', changes: [] });

  const result = {
    originalAttachmentId: original.id,
    originalFilename: original.filename,
    templateVersion: wbt.version,
    summary: {
      unchanged: rows.filter((r) => r.status === 'unchanged').length,
      changed: rows.filter((r) => r.status === 'changed').length,
      conflict: rows.filter((r) => r.status === 'conflict').length,
      removed: rows.filter((r) => r.status === 'removed').length,
      added: rows.filter((r) => ['unknown_reference', 'added_without_reference'].includes(r.status)).length,
    },
    rows,
  };
  const rec = await one(
    db,
    `INSERT INTO workbook_reconciliations (org_id, returned_attachment_id, original_attachment_id, package_id, message_id, result) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [orgId, returned.id, original.id, pkg?.package_id ?? null, messageId, JSON.stringify(result)],
  );

  // Narrow automation: for suppliers explicitly marked as trusted structured sources, a pure
  // booking-reference fill-in on an exactly matched row with no conflict is applied directly.
  if (supplier?.trusted_structured_updates) {
    for (const row of rows.filter((r) => r.status === 'changed')) {
      if (!row.changes.every((c: any) => NON_CRITICAL.has(c.key) && !c.conflict && c.sent === null)) continue;
      for (const c of row.changes) {
        if (c.key === 'request.booking_reference') await db.query('UPDATE service_requests SET booking_reference = $2, version = version + 1 WHERE id = $1', [row.requestId, c.returned]);
        else await db.query("UPDATE service_requests SET details = jsonb_set(details, '{confirmation_no}', to_jsonb($2::text)), version = version + 1 WHERE id = $1", [row.requestId, c.returned]);
      }
      row.autoApplied = true;
      await addRequestEvent(db, orgId, row.requestId, 'changed', null, { messageId: messageId ?? undefined, detail: { source: 'workbook_auto_rule', fields: row.changes.map((c: any) => c.key) } });
    }
    await db.query('UPDATE workbook_reconciliations SET result = $2 WHERE id = $1', [rec.id, JSON.stringify(result)]);
  }
  await audit(db, {}, { orgId, action: 'workbook.reconciled', entityType: 'attachment', entityId: returned.id, metadata: result.summary });
  return rec.id;
}
