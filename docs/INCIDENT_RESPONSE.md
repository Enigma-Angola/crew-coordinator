# Incident response

## Detection

| Signal | Source | Default threshold |
|---|---|---|
| Repeated failed or denied sign-ins from one address | `security_alerts.repeated_login_failures` | 10 in 15 minutes |
| Any privilege change (approval, role or scope change, suspension, security settings, AI provider) | `security_alerts.privilege_change` | every event |
| Unusual export volume by one user | `security_alerts.unusual_export_volume` | the organisation's `export_alert_threshold` per hour |
| Export containing restricted identity data | `security_alerts.restricted_data_export` | every event |
| Audit chain integrity failure | Administration › Audit log › Verify integrity | any break |
| Mailbox authorisation revoked or expired | mailbox status `reauthorisation_required` | every event |
| Uncertain or failed sends | package status `send_uncertain` / `send_failed` | every event |

Alerts appear under **Administration › Security** for users with `security:monitor`. Forward
`security_events` and the application logs to the organisation's SIEM for out-of-band retention.

## Severity

- **Critical:** suspected account compromise of a privileged user, a cross-tenant data exposure, an
  audit-chain break, or confirmed malware in an uploaded file.
- **High:** unusual export volume, unexplained privilege changes, repeated attacks on sign-in.
- **Medium:** a revoked mailbox or failed sends affecting live mobilisations.

## Procedure

1. **Triage (within 1 hour for critical).** Acknowledge the alert (this is recorded with your name),
   identify the user, organisation and time window, and review `audit_events` and `security_events`
   for that actor.
2. **Contain.**
   - Suspend the membership (Administration › Members › Suspend). This revokes the member's sessions
     in the workspace immediately.
   - For platform-wide compromise, set `users.status = 'suspended'` and revoke the identity at the IdP
     (disable the account, reset MFA, revoke refresh tokens).
   - For mailbox compromise, disconnect the mailbox (this deletes the stored tokens) and revoke the app
     consent in Entra ID.
   - For a suspected key compromise, rotate `TOKEN_ENCRYPTION_KEY` (mailboxes must reconnect) and
     `URL_SIGNING_KEY` (outstanding download links become invalid).
3. **Preserve evidence.** Export the relevant audit range and verify the chain. Snapshot the database
   and storage before any clean-up. Do not edit or delete audit rows (the database refuses).
4. **Eradicate and recover.** Remove malicious files (quarantined files are never served or parsed),
   restore affected records from backup if needed, re-enable access after review, and require MFA
   re-enrolment.
5. **Notify.** Inform the data protection officer and the affected organisations. Assess regulatory
   duties (for example GDPR Article 33's 72-hour notification, and Angola's Lei n.º 22/11 on personal
   data protection), especially for medical or identity data.
6. **Review.** Within 10 working days, hold a post-incident review covering root cause, control gaps,
   and changes to rules or thresholds. Record it.

## Contacts and drills

Keep an on-call rota and the IdP, email-provider and hosting escalation contacts outside this system.
Run a tabletop exercise at least twice a year: account takeover of a coordinator, supplier mailbox
spoofing, and a mistaken bulk export.
