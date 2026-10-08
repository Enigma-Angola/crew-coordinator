# Security

This document records the controls implemented in this release, the evidence that each one works, and
the risks that remain open. It does **not** claim the system is "100% secure". The evidence is
automated tests in `server/test` (97 tests) and `web/e2e`, all of which run in CI.

## 1. Identity and authentication

| Control | Implementation | Evidence |
|---|---|---|
| Maintained identity provider; no custom passwords | OIDC authorization code + PKCE (S256) via `openid-client`; state and nonce validated; tokens verified against the IdP's JWKS. The app never handles a password. | `auth.test.ts` › signs in a member… (real OIDC round trip against a test IdP) |
| Invitation-only registration | Unknown identities are refused. A user record is created only from a valid, unexpired, single-use invitation whose email matches the IdP's **verified** email. Only the token's hash is stored. | auth › registers an invited, verified user as pending… |
| Administrator-approved membership | Accepting an invitation creates `pending_approval`. A new administrator must be approved by someone other than the inviter (segregation of duties). | auth › …pending until a different administrator approves |
| MFA for privileged users; organisation-wide MFA | Privileged roles (admin, management, coordination, HR, auditor) need an MFA `amr` value from the IdP, otherwise the workspace is blocked before any data is returned. `mfa_required` extends this to everyone. | auth › requires MFA for privileged roles… |
| Phishing-resistant authentication | Optional organisation policy: administrators need `hwk`/`sc` (security key / passkey). | auth › can require phishing-resistant authentication… |
| Enterprise SSO | Multiple OIDC providers can be configured, and a workspace can require a specific one (`required_idp`). SAML is supported through IdP brokering, for example Keycloak to Entra ID. | `session.ts` › `workspaceBlock` |
| No account enumeration | Unknown, unverified, suspended and mismatched identities all receive the same generic refusal. The real reason goes only to `security_events`. | auth › uses one generic refusal… |
| Automated-attack protection | Per-IP rate limit on `/auth/*` (20/min) and on the API overall; an alert after 10 failed or denied sign-ins from one address in 15 minutes. The IdP's own brute-force protection is also enabled in the Keycloak realm. | auth › rate-limits…, raises a security alert… |
| Secure account recovery | Delegated to the IdP, so recovery cannot bypass the IdP's MFA policy. | configuration (`deploy/keycloak/realm-crew.json`) |
| Sessions: expiry, visibility, remote revocation | Opaque random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure`, `__Host-` prefix in production); only its SHA-256 is stored. Absolute expiry is 12 h, idle expiry is per organisation. Users can list and revoke their own sessions; administrators can revoke a member's sessions. | auth › lists the user's sessions…, expires idle sessions, signs out |
| Immediate effect of suspension and permission changes | Session, user and membership state is re-read on every request; nothing is cached in tokens. The change stream revalidates every 15 s. | auth › suspending a member… stops access on the very next request; › a permission change applies… immediately |
| Recent authentication for sensitive actions | Member management, approvals, session revocation, settings, mailbox and template management, and restricted exports require an IdP login within 10 minutes (`prompt=login`, `max_age=0`). The step-up must be completed by the same subject. | auth › requires a recent authentication (step-up)…; › refuses step-up completed by a different identity |
| Open-redirect and CSRF protection | Only relative `returnTo` paths are accepted. State-changing calls need the session CSRF token, and any Origin header must match. | auth › only accepts same-site return paths; › enforces CSRF tokens… |

## 2. Authorisation

| Control | Implementation | Evidence |
|---|---|---|
| Deny by default; server-side on every request | `need()` checks role permissions in every handler. Unknown permissions are refused. Data endpoints refuse requests without an explicitly selected, usable workspace. | access › non-administrators cannot manage members or settings… |
| Separate view / edit / export / approve / administer permissions | 40+ discrete permissions (`authz/permissions.ts`). For example, managers can approve but not edit; administrators do not see medical data by default. | access › HR/compliance sees medical details; managers see neither |
| Organisation, asset, assignment and record scope | `authz/scope.ts` predicates are applied to every list, detail, total, export, mention and AI retrieval: employee → own records; supplier → own non-draft requests and only the passenger fields that request type needs; coordinator → asset scope. | access › supplier isolation, asset scope, employee restricted records; dashboards › totals never include records outside the viewer's scope |
| Tenant isolation, defence in depth | Explicit `org_id` predicates **and** PostgreSQL row-level security (`FORCE RLS`, a runtime role without `BYPASSRLS`). Without tenant context, no rows are visible. Cross-tenant ids return 404. | access › tenant isolation (5 tests, including a direct database check) |
| No self-escalation | Nobody can change their own role, scope or status. Only administrators assign roles. The last administrator cannot be demoted or suspended. | access › nobody can change their own role or scope; › the last administrator cannot be removed |
| Segregation of duties | A crew change submitter or creator cannot approve it. Whoever records a credential or adds a supplier contact cannot verify it. A package preparer cannot approve it when the template requires review. | access › …cannot be approved by the person who submitted it; › whoever records a credential cannot verify it; › a supplier contact cannot be verified…; workflow › 6 |
| Insecure direct object references | UUID validation; scoped loaders for every object; uniform 404s. | access › random and malformed ids return 404… |

## 3. Data protection

| Control | Implementation | Evidence / notes |
|---|---|---|
| Encryption in transit | HTTPS required in production (`APP_BASE_URL` and IdP issuers must be `https`); HSTS, CSP (`script-src 'self'`, `frame-ancestors 'none'`), `nosniff`. | `config.ts`; headers checked in the production smoke test |
| Encryption at rest | Mailbox OAuth tokens are encrypted with AES-256-GCM, with the key outside the database and the mailbox id as AAD. Database and file storage rely on encrypted volumes or managed encryption in the deployment. | workflow › 8 (token not readable in the DB). Field-level encryption of passport numbers is **not** implemented (see risks) |
| Private document storage; short-lived links | Files live outside any web root. Downloads use HMAC-signed links valid for 60 s and bound to the requesting session. Permission is checked again at download time. | access › signed download links are bound to the session…; workflow › 7 |
| Field- and role-restricted medical and identity data | Separate tables. Fields are returned only with `identity:view` / `medical:view` or to the person themselves. Viewing is audited without recording values. Medical expiries are hidden from dashboards for viewers without medical access. | access › field-level restriction (4 tests); dashboards › medical-category expiries are hidden… |
| Medical decisions | The platform records the examining provider's outcome and never determines fitness. Readiness shows "not met" without a reason. | `domain/readiness.ts` |
| Secrets | Secrets are kept out of the frontend and the repository (`.env.example` has no values); keys are required in production. Logs redact cookies, authorisation headers and CSRF tokens. | `config.ts`, `app.ts` |
| Upload validation and quarantine | Type is checked by content (magic bytes), not by name or declared type, against an allow-list. Files are stored quarantined, scanned with clamd, and downloadable or parseable only when clean. Without a scanner they stay quarantined. | access › uploads are type-checked by content… |
| Export protection; formula injection | Exports need `export:run` plus the dataset's view permission, respect scope, and need step-up for identity data. They are audited and monitored (an alert above a per-hour threshold). Cells starting with `= + - @` or a tab/CR are neutralised in CSV and XLSX. | dashboards/AI › exports respect scope…; xlsx › neutralises spreadsheet formula injection |
| Retention, deletion, backups | See [DATA_RETENTION.md](DATA_RETENTION.md). | policy; automation partly implemented (see risks) |

## 4. Email, attachments and integrations

- **OAuth only; no mailbox passwords.** Microsoft Graph uses delegated permissions with the minimum
  scopes for the feature set: `offline_access User.Read Mail.Read Mail.Send`, plus `.Shared` variants
  for shared mailboxes. `Mail.ReadWrite` is not requested.
- **Recipients come only from verified, active supplier contacts.** A contact added by one person must
  be verified by another. Editing recipients to an unverified address is rejected.
- **Idempotent sending.** Each package has an idempotency key, stored as a MAPI extended property and a
  message header. A "submitting" state is committed before the network call. Uncertain outcomes are
  reconciled against Sent Items before any retry (workflow › 10). Definite rejections are shown as
  failed (workflow › 11).
- **Untrusted content.** Email bodies are stored and shown as plain text; HTML is converted to text and
  never rendered. Extraction only produces *proposals*. Nothing in a message can trigger tools,
  sending, approvals or permission changes (extraction › instructions inside an email are just text).
- **Association never relies on names.** It uses thread headers, conversation id and reference tokens.
  A reference typed by a sender who is not a verified contact drops to the manual queue
  (workflow › 19).
- **Partial visibility.** A message linked to several requests shows only the segments the viewer is
  allowed to see.
- **Mailbox scope.** Only configured folders are synchronised, and only relevant messages are stored
  (workflow › 12: personal mail is not imported).
- **Failure handling.** Expired or revoked authorisation sets the mailbox to "reconnection required"
  (workflow › 20). Throttling honours `Retry-After`. Attachments over the `sendMail` limit are refused
  before sending.

## 5. AI

| Control | Evidence |
|---|---|
| The same access controls for AI retrieval as for the ordinary API (shared scope predicates) | AI › retrieval is limited to the asker's scope…; › an AI answer… never includes another organisation's data |
| Nothing is sent to an AI provider without an approved configuration (the deployment key **and** a per-workspace administrator approval, recorded with approver and time) | AI › is disabled until an administrator approves a provider… |
| Restricted data (identity, medical, costs) and email bodies are never placed in the model context | AI › …sends only permitted, non-restricted fields… |
| Retrieved text is delimited and declared as data; the model has **no tools**, so injected instructions cannot act | same test (planted instruction stays inside `<records>`, no `tools`) |
| AI never approves mobilisation, determines fitness, changes access or books anything | no such code path exists; approvals are human-only endpoints with segregation of duties |
| No training on customer data by default | the provider is used under commercial API terms; no fine-tuning or data sharing is implemented |

## 6. Audit and monitoring

- **Tamper-evident audit log.** It is append-only (no UPDATE/DELETE grant, plus a blocking trigger) and
  SHA-256 hash-chained per organisation. Administrators can verify the chain from the UI. A test shows
  that tampering by a database superuser is detected at the exact record.
- **Metadata only.** The log records actor, time, action, record and IP, never document contents,
  medical values or message bodies.
- **Alerting.** Rules cover repeated sign-in failures, every privilege change, unusual export volume
  and restricted-data exports. Alerts appear in Administration › Security and are handled per
  [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md).

## 7. Supply chain

At the time of this build, `npm audit` reports **0 vulnerabilities**. `uuid` is pinned to ≥ 11.1.1
through an override (GHSA-w5hq-g745-h8pq in exceljs's transitive dependency). CI runs `npm audit`.

## 8. Unresolved risks and limitations

These are known and accepted for this release, or require deployment work:

1. **Live integrations are unverified.** The Graph connector, Keycloak realm, ClamAV and Claude calls
   are tested against local fakes or not exercised at all. Each needs verification in a staging tenant
   before production. Keycloak must emit `amr` (the realm includes the AMR mapper, untested here).
   Entra ID's `amr` values must be checked against `mfaAmr`.
2. **MFA enforcement trusts the IdP's `amr`/`acr` claims.** A misconfigured IdP that omits or
   misreports them weakens the control.
3. **Graph `Mail.Read` covers the whole mailbox at the provider.** The app limits what it *stores*, not
   what the token could read. Use a dedicated operational mailbox. For application permissions,
   Exchange application access policies can restrict mailboxes (not implemented; delegated only).
4. **Attachments larger than ~2.9 MB are refused**, because `sendMail` without `Mail.ReadWrite` upload
   sessions has a size limit. Large packages must be split.
5. **Field-level encryption of identity data is not implemented**; protection relies on access control
   plus database or volume encryption.
6. **The audit hash chain is tamper-evident, not tamper-proof.** Someone with full database control
   could rewrite the whole chain consistently. Recommended: export the chain head to external WORM
   storage or a log service daily (not automated in this release).
7. **Rate limits are kept in memory per instance.** Multi-instance deployments need a shared store
   (for example Redis) for consistent limits.
8. **Request and package references are sequential and guessable.** Combined with sender verification
   this only lets an outsider place a message in the manual review queue, but it is still noise to
   triage.
9. **Message redaction for partial visibility is line-based.** A supplier writing several people's
   details on one line without references could expose them to a narrowly scoped viewer.
10. **Readiness "not met" for a medical requirement** reveals to coordinators that the recorded
    medical outcome is negative (never the reason). This is necessary for mobilisation decisions.
11. **Retention deletion is policy, not automation.** Scheduled purging (see DATA_RETENTION.md) still
    has to be implemented as a job.
12. **The change stream** can deliver entity ids (never contents) to a just-revoked session for up to
    15 s.
13. **Not yet done:** an independent penetration test, load and performance testing, and a manual
    screen-reader audit (automated axe checks only).
14. **The development IdP** is refused when `NODE_ENV=production`, and production rejects `http`
    issuers. A deployment that runs with the wrong `NODE_ENV` loses this guard.
