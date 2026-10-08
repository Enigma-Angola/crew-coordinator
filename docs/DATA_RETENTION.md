# Data retention, deletion and backups

The defaults below are a policy for each organisation to confirm with its legal and HR advisers
(including GDPR and Angola's Lei n.º 22/11). **This release implements the data structures and
immutability guarantees; scheduled purging is not yet automated.** The deletion steps below describe
what must be run (see SECURITY.md, risk 11).

| Data | Default retention | Notes |
|---|---|---|
| Audit events | 7 years | Append-only; never deleted by the application |
| Security events and alerts | 2 years | Forward to the SIEM for longer retention |
| Sessions, login attempts | 90 days after expiry | Only token hashes are stored |
| Personnel base records | Employment + 6 years | Mark `inactive` when someone leaves |
| Identity data (passport, visa, date of birth) | Until 12 months after the last mobilisation | Restricted tables; delete the row to purge |
| Medical records and medical documents | Per occupational-health rules (typically 5–40 years); never shorter than required | Restricted, with access audited |
| Service requests and their timeline | 6 years (financial and operational record) | |
| Sent emails, generated attachments and their snapshots | 6 years | Immutable; the evidence of what was requested |
| Inbound messages and attachments | 6 years if matched; 90 days if unmatched or ignored | Unrelated mail is never stored |
| Mailbox OAuth tokens | Until disconnected | Deleted on disconnect |
| Exports log | 2 years | |

## Deletion and right to erasure

- Personnel identity and medical rows can be deleted outright. Documents use `deleted_at` (hidden
  immediately) followed by object deletion from storage.
- Generated attachments and audit records are evidence and are retained. For an erasure request,
  document the legal basis for keeping them, or pseudonymise names in snapshots through a supervised
  database procedure. The application refuses to modify attachment content.
- Deleting an organisation requires exporting the audit log first, then removing all of its rows in a
  maintenance procedure run with the owner role.

## Backups

- PostgreSQL: continuous WAL archiving plus a daily base backup, encrypted, kept for 35 days, with a
  monthly restore test.
- Object storage: versioned, encrypted bucket or volume snapshots on the same schedule.
- Store backups in a separate account or region. Access to backups is privileged and logged.
- Restored environments must keep the same `TOKEN_ENCRYPTION_KEY`, or mailboxes must reconnect.
