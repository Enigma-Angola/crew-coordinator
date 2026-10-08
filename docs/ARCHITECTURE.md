# Architecture

## Components

```
Browser (React SPA, pt-PT/en) ──HTTPS, same origin──▶ API (Fastify, Node 22) ──▶ PostgreSQL 16 (RLS)
        │                                               │   ├─▶ Private object storage (encrypted volume / bucket)
        └──▶ OIDC IdP (Keycloak / Entra ID / Okta) ◀────┤   ├─▶ ClamAV (clamd INSTREAM)
                                                        │   ├─▶ Microsoft Graph (delegated OAuth, per mailbox)
                                                        │   └─▶ Anthropic API (only if approved per workspace)
                               Worker (same codebase) ──┘   send queue · Sent Items reconciliation · reminders · sync · insights
```

| Path | Responsibility |
|---|---|
| `server/src/auth` | OIDC login, callback, step-up, server-side sessions |
| `server/src/authz` | Role permissions (`permissions.ts`) and record-scope predicates (`scope.ts`) |
| `server/src/http/guard.ts` | `need()`: permission + step-up check on every handler; `orgTx()`: RLS-scoped transaction |
| `server/src/api/*` | Route modules: me, admin, personnel, operations, collaboration, communications, dashboards, exports |
| `server/src/email/*` | XLSX engine, rendering, packages, Graph connector, ingestion and matching, extraction, reconciliation |
| `server/src/domain/*` | Readiness evaluation, request type definitions, insights engine |
| `server/src/audit`, `security` | Hash-chained audit log, security events and alert rules |
| `server/src/storage` | Private storage, content sniffing, malware scan, signed links |
| `web/src` | SPA: i18n, session, shell, pages, charts and operational visuals |

## Request path

1. `onRequest` loads the session from the cookie, which holds an opaque token; only its SHA-256 is stored.
   It then checks, against the database on every request: revocation, absolute expiry, idle expiry,
   user suspension, membership status, MFA, phishing resistance and required SSO for the active
   workspace. Any change by an administrator therefore applies on the next request.
2. `preHandler` enforces CSRF (a session-bound token header plus an Origin check) on state-changing calls.
3. The handler calls `need(req, ...permissions)`. That checks the role permissions, plus a recent IdP
   authentication for sensitive administration and approval actions.
4. The handler runs inside `orgTx`. This transaction sets `app.org_id` / `app.user_id`, so row-level
   security limits every statement to the active organisation. Queries then add record scope:
   the employee's own records, the supplier's own requests, the coordinator's asset scope.
5. Mutations write a hash-chained audit record and emit a change notification. The notification carries
   ids only; clients re-fetch through the same scoped endpoints.

## Data model (main tables)

- Identity and tenancy: `organizations`, `users`, `memberships` (role, status, supplier, asset scope),
  `invitations`, `sessions`.
- Operations: `assets`, `positions` (requirements per position), `personnel` plus restricted
  `personnel_identity` and `personnel_medical`, `credentials`, `documents`, `assignments`,
  `crew_changes`, `crew_change_people`, `service_requests` (one arrangement per person: flight, hotel,
  transfer, medical, training, immigration), `request_events` (business timeline).
- Collaboration: `tasks`, `comments` (permission-checked mentions), `notifications`, `insights`.
- Communications: `suppliers`, `supplier_contacts` (verified recipients only), versioned
  `email_templates` and `workbook_templates`, `email_packages`, `package_requests`, `attachments`
  (immutable, with source snapshot), `package_attachments` (superseded versions kept),
  `mailbox_connections` (encrypted OAuth tokens, folder scope, delta state), `email_messages`,
  `message_links`, `extraction_proposals`, `workbook_reconciliations`, `reminders`.
- Assurance: `audit_events` (append-only, hash chain), `security_events`, `security_alerts`, `exports`.

Status columns hold stable internal codes such as `change_pending_review`. Labels are translated in the
client, or by the server for emails and exports. Timestamps are `timestamptz`. Arrangement times are
entered as local wall-clock times at the location and normalised to UTC, and every displayed time
carries its zone label.

Mutable records carry `version`. `patchVersioned` applies field-level optimistic concurrency:
edits to different fields made from the same version merge automatically. An edit to a field that
someone else has also changed returns HTTP 409 with base, their value and my value for each
conflicting field, and the UI's conflict dialog lets the user choose per field.

## Email and Excel pipeline

```
records ─▶ preparePackages ─▶ group by (template family, confidentiality, crew change | day | single)
        ─▶ recipients = verified supplier contacts (never free text, never AI)
        ─▶ snapshot rows ─▶ validate required fields ─▶ XLSX (template definition [+ inspected base file])
        ─▶ immutable attachment + snapshot ─▶ package "in review" with warnings
review ─▶ approve (a different person when the template requires review; stale records force regeneration)
send   ─▶ queued ─▶ "submitting" committed ─▶ Graph sendMail with idempotency key (extended property + header)
        ─▶ 202: submitted (internetMessageId / conversationId fetched from Sent Items)
        ─▶ 5xx / timeout: send_uncertain ─▶ worker searches Sent Items by key ─▶ submitted, or safe retry
        ─▶ 4xx: send_failed (never shown as sent)
reply  ─▶ delta sync of configured folders only ─▶ relevance filter ─▶ dedup by Internet Message-ID
        ─▶ match: In-Reply-To/References ▸ conversationId ▸ PKG ref ▸ REQ refs (never names)
           sender must be a verified supplier contact (or an internal forwarder), otherwise unmatched queue
        ─▶ attachments: type sniffing ▸ malware scan ▸ quarantined files never parsed
        ─▶ rules-based extraction per request segment with source spans ─▶ proposal (pending)
        ─▶ returned XLSX: match rows by reference column and hidden metadata ─▶ diff vs sent and current
human  ─▶ apply selected fields + resulting status ─▶ request updated ─▶ insights recomputed
```

- The technical sending status (`email_packages.status`) is kept separate from the business status
  (`service_requests.status`). Delivery and read status are never claimed.
- Without a connected mailbox, packages can be downloaded as `.eml` + `.xlsx` and are labelled as a
  demonstration. A person can record that they sent the email themselves; it is then shown as
  "sent outside the platform".
- Reminders are prepared when a response deadline passes with no reply. They are sent automatically
  only when the template explicitly allows routine automation, and they are cancelled when a reply arrives.

## Intelligence engine (`server/src/domain/insights.ts`)

The engine is recomputed after relevant changes and by the worker. Each insight has a `kind`:
`fact`, `rule_warning` or `prediction`. It lists the records it is based on and the assumptions behind
it, and suggests actions that a person must trigger. Rules:

- A changed flight lists the dependent hotel and transfer bookings, and an amendment can be prepared.
- A hotel or transfer misaligned with the flight's arrival in local time is flagged.
- A credential missing, expired, unverified or expiring during an assignment triggers a readiness
  reassessment.
- Supplier responses past their deadline are listed with the affected crew changes.
- Uncovered position slots are listed with candidates who meet every recorded requirement and are free.
- Overdue onboarding or verification tasks name the responsible person and the crew changes they block.
- Prediction: a reply is likely to be late, based on the supplier's median response time. It needs at
  least 5 past samples and is labelled as a prediction.

Nothing in the engine approves mobilisation, changes bookings, decides medical fitness or alters access.
