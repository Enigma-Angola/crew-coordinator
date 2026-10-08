# Acceptance evidence

Results of the final run in the build environment (Node 22, PostgreSQL 16.15, Chromium 1194):

| Suite | Command | Result |
|---|---|---|
| Server: security, tenancy, workflow, dashboards, AI, audit | `npm test --workspace server` | **97 / 97 passed** (6 files) |
| Web: translation parity | `npm test --workspace web` | **4 / 4 passed** |
| Browser: both languages, axe WCAG 2.1 AA, dark mode, mobile | `npx playwright test -c web/playwright.config.ts` | **6 / 6 passed**: 15 screen checks with no serious or critical axe violations |
| Type checks (server and web) | `npm run typecheck` | clean |
| Dependency audit | `npm audit` | 0 vulnerabilities |

**What "tested" means here.** The OIDC flow runs against a local test IdP. The Microsoft Graph
connector runs against a local fake that implements the endpoints the connector calls. Claude calls
run against a fake endpoint. These fakes verify behaviour against the documented API contracts; they
are **not** evidence of live Microsoft 365, Keycloak, ClamAV or Anthropic integration. Those must be
verified in a staging environment (see SECURITY.md, risk 1).

## Platform acceptance criteria

| Criterion | Demonstrated by |
|---|---|
| Multiple users collaborate without silent data loss | `collab-dashboards-ai.test.ts` › merges edits to different fields…; › detects a conflicting edit to the same field…; UI conflict dialog (`ConflictDialog`); live "updated by a colleague" banner |
| An employee cannot view another employee's restricted records | `access.test.ts` › an employee sees only their own record…; › …only their own itinerary and tasks |
| A supplier cannot view another supplier's requests | access › a supplier sees only requests assigned to them…; › …cannot see draft requests…, personnel, crew changes or emails |
| One organisation cannot access another's data | access › tenant isolation (5 tests, including the RLS check at database level) |
| Revoked access stops working | `auth.test.ts` › suspending a member and revoking sessions stops access on the very next request; › a permission change applies… immediately; › expires idle sessions |
| Both languages work across complete workflows | `web/e2e` › every main screen renders in Portuguese and English… (checked for English leaking onto Portuguese screens); translation parity tests; Portuguese templates, emails and exports in the workflow test (steps 4, 15, 18) |
| Charts reconcile with their source records | dashboards › every KPI total equals the length of its drill-down list; › the chart bars reconcile with the drill-down records…; e2e › dashboard drill-down lists exactly the records behind a figure |
| Dashboard totals do not leak restricted information | dashboards › totals never include records outside the viewer's scope; › medical-category expiries are hidden…; › role dashboards… |
| Sensitive actions require the right permissions and authentication | auth › requires a recent authentication (step-up)…; access › privilege escalation and segregation of duties (6 tests); dashboards/AI › exports… require step-up for identity data |
| AI features respect the same security boundaries | AI › is disabled until approved…; › retrieval is limited to the asker's scope…; › sends only permitted, non-restricted fields and treats them as untrusted data; › …never includes another organisation's data |
| Security, accessibility and workflow checks have documented results | this document, SECURITY.md, DESIGN_AND_ACCESSIBILITY.md |

## Operational acceptance test (email-based coordination)

`server/test/workflow.test.ts` runs the required workflow end to end against the API, in order:

| Required step | Test step(s) |
|---|---|
| Import a crew roster | 1: CSV with Portuguese headings and day-first dates; dry-run preview with per-row errors; then commit |
| Select an upcoming crew change | 2: add the new crew member; generate draft arrangements without duplicating existing ones |
| Generate provider-specific Excel attachments from database records | 3–5: four packages (travel, hotel, transport, medical), each with its supplier's workbook template, filename convention and language; missing information blocks approval; regeneration keeps the superseded file |
| Prepare separate travel, transport and medical emails | 3–4: grouping by template, confidentiality and window; recipients only from verified contacts (the unverified contact is excluded) |
| Review and send through a connected mailbox | 6: segregated review; 7: demonstration mode refuses to send and offers labelled downloads; 8: OAuth connection with least-privilege scopes and encrypted tokens; 9: send with the exact attachment; 10: uncertain outcome reconciled without a duplicate; 11: a rejection is reported as failed |
| Receive a supplier reply containing an altered arrangement | 12: delta sync; a duplicate delivery is deduplicated; personal mail is not imported |
| Associate the reply with the correct request | 12: thread headers; only the requests named in the body are linked, plus the request whose row changed in the returned spreadsheet; 19: low-confidence and unverified senders go to the unmatched queue |
| Extract and review the proposed changes | 13: proposals with source excerpts; "received" cannot confirm; modification and confirmation kept distinct |
| Update the approved operational records | 14: a person applies selected fields and the resulting status; the timeline shows every stage; delivery or read status is never claimed |
| Flag downstream impacts | 15: the flight change lists the dependent hotel and transfer; the transfer before arrival is flagged; nothing changes automatically; an amendment email is prepared for review |
| Preserve the complete email and attachment history | 16: returned workbook compared with the sent version and current records, conflicts need explicit resolution; 17: the sent attachment is byte-identical and immutable, and its snapshot is unaffected by later edits; history shows outbound and inbound messages; 18: reminders prepared for non-responders only and stopped by replies; 20: expired authorisation detected |

## Not verified in this environment

- A live Microsoft 365 tenant (Graph `sendMail`, delta and Sent Items search with real throttling and
  consistency delays).
- The Keycloak realm import and its AMR mapper; Entra ID or Okta as IdP.
- ClamAV scanning (`MALWARE_SCAN_MODE=clamav`).
- Real Claude responses: refusals, fallbacks, latency.
- Production deployment (TLS termination, multi-instance rate limiting, backups).
- Manual screen-reader testing and usability testing with coordinators.
