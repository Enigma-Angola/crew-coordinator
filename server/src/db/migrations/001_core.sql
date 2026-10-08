-- Crew Coordinator core schema.
--
-- Conventions
--   * Every tenant-owned table carries org_id and is protected by row-level security
--     (see 002_rls.sql). The application connects as a role without BYPASSRLS and sets
--     app.org_id per transaction, so a missing WHERE clause cannot leak another tenant.
--   * Status columns hold stable internal codes. Labels are translated in the client.
--   * All timestamps are timestamptz (stored in UTC). Display timezones come from user
--     preferences or the asset/location record.
--   * Mutable operational records carry a "version" column for optimistic concurrency.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity and tenancy (global tables, accessed only through scoped queries)
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name text NOT NULL,
  default_language text NOT NULL DEFAULT 'pt-PT' CHECK (default_language IN ('pt-PT', 'en')),
  default_timezone text NOT NULL DEFAULT 'Africa/Luanda',
  default_currency text NOT NULL DEFAULT 'AOA',
  mfa_required boolean NOT NULL DEFAULT false,
  phishing_resistant_admins boolean NOT NULL DEFAULT false,
  required_idp text,                       -- enterprise SSO: only this IdP may access the workspace
  session_idle_minutes int NOT NULL DEFAULT 30 CHECK (session_idle_minutes BETWEEN 5 AND 480),
  ai_provider text NOT NULL DEFAULT 'none' CHECK (ai_provider IN ('none', 'anthropic')),
  ai_approved_by uuid,
  ai_approved_at timestamptz,
  export_alert_threshold int NOT NULL DEFAULT 20,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idp text NOT NULL,                        -- identity provider id from configuration
  idp_subject text NOT NULL,                -- OIDC "sub" claim
  email text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  display_name text NOT NULL,
  language text NOT NULL DEFAULT 'pt-PT' CHECK (language IN ('pt-PT', 'en')),
  timezone text NOT NULL DEFAULT 'Africa/Luanda',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  suspended_at timestamptz,
  suspended_by uuid,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idp, idp_subject)
);
CREATE INDEX users_email_idx ON users (lower(email));

-- Server-side sessions. The cookie carries a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  active_org_id uuid REFERENCES organizations(id),
  idp text NOT NULL,
  auth_time timestamptz NOT NULL,          -- when the user last authenticated at the IdP
  amr text[] NOT NULL DEFAULT '{}',        -- authentication methods reported by the IdP
  acr text,
  csrf_token text NOT NULL,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,         -- absolute expiry
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('travel', 'hotel', 'transport', 'medical', 'training', 'immigration', 'other')),
  default_language text NOT NULL DEFAULT 'en' CHECK (default_language IN ('pt-PT', 'en')),
  trusted_structured_updates boolean NOT NULL DEFAULT false,
  response_hours_target int NOT NULL DEFAULT 24,
  notes text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (org_id, name)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('org_admin', 'manager', 'coordinator', 'hr_compliance', 'supplier', 'employee', 'auditor')),
  status text NOT NULL CHECK (status IN ('pending_approval', 'active', 'suspended')),
  supplier_id uuid REFERENCES suppliers(id),   -- required for supplier role
  asset_scope uuid[],                          -- NULL = all assets in the organisation
  invited_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  suspended_by uuid REFERENCES users(id),
  suspended_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id),
  CHECK (role <> 'supplier' OR supplier_id IS NOT NULL)
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  role text NOT NULL,
  supplier_id uuid REFERENCES suppliers(id),
  asset_scope uuid[],
  personnel_id uuid,
  token_hash bytea NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_preferences (
  user_id uuid NOT NULL REFERENCES users(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  dashboard jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE saved_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  view text NOT NULL,
  name text NOT NULL,
  filter jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Operational domain
-- ---------------------------------------------------------------------------

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('vessel', 'rig', 'platform', 'base', 'other')),
  timezone text NOT NULL DEFAULT 'Africa/Luanda',
  location text,
  version int NOT NULL DEFAULT 1,
  UNIQUE (org_id, code)
);

CREATE TABLE requirement_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL,
  name_en text NOT NULL,
  name_pt text NOT NULL,
  category text NOT NULL CHECK (category IN ('certificate', 'medical', 'identity', 'training', 'other')),
  UNIQUE (org_id, code)
);

-- Positions required on an asset (the staffing plan).
CREATE TABLE positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  title text NOT NULL,
  headcount int NOT NULL DEFAULT 1 CHECK (headcount > 0),
  requirement_ids uuid[] NOT NULL DEFAULT '{}'
);

CREATE TABLE personnel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  employee_no text NOT NULL,
  full_name text NOT NULL,
  email text,
  phone text,
  nationality text,
  job_title text,
  home_base text,
  employer text,
  user_id uuid REFERENCES users(id),           -- links an employee login to their record
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding', 'active', 'inactive')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (org_id, employee_no)
);

-- Restricted fields live in separate tables so that ordinary personnel queries cannot
-- select them by accident; access requires explicit permissions (see authz/permissions.ts).
CREATE TABLE personnel_identity (
  personnel_id uuid PRIMARY KEY REFERENCES personnel(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  date_of_birth date,
  passport_number text,
  passport_country text,
  passport_expiry date,
  visa_type text,
  visa_expiry date,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE personnel_medical (
  personnel_id uuid PRIMARY KEY REFERENCES personnel(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  -- Recorded as issued by the examining medical provider. The platform never determines fitness.
  fitness_status text CHECK (fitness_status IN ('fit', 'fit_with_restrictions', 'unfit', 'pending')),
  examined_on date,
  expires_on date,
  restrictions text,
  provider_name text,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  personnel_id uuid REFERENCES personnel(id),
  classification text NOT NULL CHECK (classification IN ('general', 'identity', 'medical')),
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  scan_status text NOT NULL DEFAULT 'quarantined' CHECK (scan_status IN ('quarantined', 'clean', 'infected', 'scan_failed')),
  scanned_at timestamptz,
  scan_detail text,
  uploaded_by uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  retention_until date,
  deleted_at timestamptz
);

CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  personnel_id uuid NOT NULL REFERENCES personnel(id),
  requirement_type_id uuid NOT NULL REFERENCES requirement_types(id),
  reference text,
  issued_on date,
  expires_on date,
  document_id uuid REFERENCES documents(id),
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verified_by uuid,
  verified_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE TABLE crew_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  reference text NOT NULL,
  asset_id uuid NOT NULL REFERENCES assets(id),
  scheduled_on date NOT NULL,
  embarkation_point text,
  embarkation_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'planning', 'approval_pending', 'approved', 'in_progress', 'completed', 'cancelled')),
  notes text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  submitted_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  UNIQUE (org_id, reference),
  -- Segregation of duties: the approver cannot be the person who submitted the change.
  CHECK (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by)
);

-- Rotation assignments: who is on which asset, in which position, when.
CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  personnel_id uuid REFERENCES personnel(id),     -- NULL = uncovered slot
  asset_id uuid NOT NULL REFERENCES assets(id),
  position_id uuid REFERENCES positions(id),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  crew_change_on_id uuid REFERENCES crew_changes(id),
  crew_change_off_id uuid REFERENCES crew_changes(id),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  version int NOT NULL DEFAULT 1,
  created_by uuid,
  updated_by uuid,
  CHECK (ends_on >= starts_on)
);

CREATE TABLE crew_change_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  crew_change_id uuid NOT NULL REFERENCES crew_changes(id),
  personnel_id uuid NOT NULL REFERENCES personnel(id),
  direction text NOT NULL CHECK (direction IN ('on', 'off')),
  assignment_id uuid REFERENCES assignments(id),
  UNIQUE (crew_change_id, personnel_id, direction)
);

CREATE SEQUENCE request_ref_seq;

-- A service request is one arrangement for one person: a flight, hotel stay, transfer,
-- medical appointment, training booking or immigration submission.
CREATE TABLE service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  reference text NOT NULL,                 -- stable reference used in emails and spreadsheets
  crew_change_id uuid REFERENCES crew_changes(id),
  personnel_id uuid NOT NULL REFERENCES personnel(id),
  supplier_id uuid REFERENCES suppliers(id),
  type text NOT NULL CHECK (type IN ('flight', 'hotel', 'transfer', 'medical', 'training', 'immigration')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'requested', 'acknowledged', 'quoted', 'proposed', 'confirmed', 'change_pending_review',
    'cancelled', 'completed')),
  details jsonb NOT NULL DEFAULT '{}',
  starts_at timestamptz,                   -- normalised start (departure, check-in, pickup, appointment)
  ends_at timestamptz,
  location_tz text NOT NULL DEFAULT 'Africa/Luanda',
  booking_reference text,
  cost_amount numeric(14, 2),
  cost_currency text CHECK (cost_currency ~ '^[A-Z]{3}$'),
  response_due_at timestamptz,
  first_requested_at timestamptz,
  first_response_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  cancelled_by uuid,
  cancelled_at timestamptz,
  UNIQUE (org_id, reference)
);
CREATE INDEX service_requests_cc_idx ON service_requests (crew_change_id);
CREATE INDEX service_requests_person_idx ON service_requests (personnel_id);

-- Business timeline of a request (separate from technical email sending status).
CREATE TABLE request_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  stage text NOT NULL CHECK (stage IN ('draft_prepared', 'reviewed', 'queued', 'submitted', 'response_received',
    'confirmation_recorded', 'completed', 'cancelled', 'changed', 'reminder_prepared')),
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  package_id uuid,
  message_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX request_events_req_idx ON request_events (request_id, at);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  title text NOT NULL,
  description text,
  kind text NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'onboarding', 'verification', 'document_request', 'mobilisation')),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid REFERENCES users(id),
  due_at timestamptz,
  personnel_id uuid REFERENCES personnel(id),
  crew_change_id uuid REFERENCES crew_changes(id),
  request_id uuid REFERENCES service_requests(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  completed_at timestamptz
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  entity_type text NOT NULL CHECK (entity_type IN ('crew_change', 'request', 'task', 'personnel', 'package')),
  entity_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) <= 5000),
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_entity_idx ON comments (entity_type, entity_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  code text NOT NULL,                      -- translated client-side
  params jsonb NOT NULL DEFAULT '{}',
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Computed operational insights (facts, rule-based warnings, model predictions).
CREATE TABLE insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  dedupe_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fact', 'rule_warning', 'prediction')),
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  params jsonb NOT NULL DEFAULT '{}',
  supporting jsonb NOT NULL DEFAULT '[]',  -- [{type, id, label}] records the insight is based on
  assumptions jsonb NOT NULL DEFAULT '[]', -- translation codes describing assumptions
  actions jsonb NOT NULL DEFAULT '[]',     -- suggested actions; never applied automatically
  crew_change_id uuid,
  personnel_id uuid,
  request_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  acknowledged_by uuid,
  UNIQUE (org_id, dedupe_key)
);

-- ---------------------------------------------------------------------------
-- Communications: contacts, templates, packages, messages, attachments
-- ---------------------------------------------------------------------------

CREATE TABLE supplier_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  name text NOT NULL,
  email text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text NOT NULL DEFAULT 'to' CHECK (role IN ('to', 'cc')),
  request_types text[] NOT NULL DEFAULT '{}',   -- empty = all request types
  verified boolean NOT NULL DEFAULT false,
  verified_by uuid,
  verified_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (supplier_id, email)
);

CREATE TABLE workbook_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  family_id uuid NOT NULL,                 -- all versions of one template share a family
  version int NOT NULL,
  name text NOT NULL,
  definition jsonb NOT NULL,
  base_file_document_id uuid REFERENCES documents(id),
  inspection jsonb,                        -- result of checking the base file for unsupported features
  feature_loss_acknowledged_by uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (family_id, version)
);

CREATE TABLE email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  family_id uuid NOT NULL,
  version int NOT NULL,
  name text NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  request_type text NOT NULL,
  language text NOT NULL CHECK (language IN ('pt-PT', 'en')),
  subject_format text NOT NULL,
  body_template text NOT NULL,
  to_rule jsonb NOT NULL DEFAULT '{"contactRole": "to"}',
  cc_rule jsonb NOT NULL DEFAULT '{"contactRole": "cc"}',
  required_fields text[] NOT NULL DEFAULT '{}',
  workbook_template_id uuid REFERENCES workbook_templates(id),
  filename_convention text NOT NULL DEFAULT '{type}_{crewChange}_{date}.xlsx',
  requires_review boolean NOT NULL DEFAULT true,
  automation_allowed boolean NOT NULL DEFAULT false,
  response_hours int NOT NULL DEFAULT 24,
  reminder_hours int NOT NULL DEFAULT 24,
  grouping text NOT NULL DEFAULT 'crew_change' CHECK (grouping IN ('crew_change', 'day', 'single')),
  provider_instructions text,
  confidentiality text NOT NULL DEFAULT 'standard' CHECK (confidentiality IN ('standard', 'identity', 'medical')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (family_id, version)
);

CREATE TABLE mailbox_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL CHECK (provider IN ('microsoft', 'google')),
  address text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('individual', 'shared')),
  status text NOT NULL CHECK (status IN ('pending', 'connected', 'reauthorisation_required', 'revoked', 'error')),
  token_ciphertext bytea,                  -- AES-256-GCM, key held outside the database
  scopes text[] NOT NULL DEFAULT '{}',
  sync_folders text[] NOT NULL DEFAULT '{inbox}',
  sync_state jsonb NOT NULL DEFAULT '{}',  -- delta links per folder
  connected_by uuid,
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Immutable stored files: generated attachments, inbound attachments, returned workbooks.
CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('generated', 'inbound')),
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  workbook_template_id uuid REFERENCES workbook_templates(id),
  source_snapshot jsonb,                   -- exact rows used to generate the file
  scan_status text NOT NULL DEFAULT 'clean' CHECK (scan_status IN ('quarantined', 'clean', 'infected', 'scan_failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE TABLE email_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  reference text NOT NULL,
  crew_change_id uuid REFERENCES crew_changes(id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  email_template_id uuid NOT NULL REFERENCES email_templates(id),
  mailbox_id uuid REFERENCES mailbox_connections(id),
  purpose text NOT NULL DEFAULT 'request' CHECK (purpose IN ('request', 'reminder', 'amendment')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'in_review', 'approved', 'queued', 'submitting', 'submitted', 'send_failed', 'send_uncertain', 'cancelled')),
  to_addresses text[] NOT NULL DEFAULT '{}',
  cc_addresses text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL,
  body_text text NOT NULL,
  language text NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]',
  blocking boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL UNIQUE,
  provider_message_id text,
  internet_message_id text,
  conversation_id text,
  submitted_at timestamptz,
  send_attempts int NOT NULL DEFAULT 0,
  last_send_error text,
  response_due_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  sent_by uuid,
  cancelled_by uuid,
  UNIQUE (org_id, reference)
);

CREATE TABLE package_requests (
  package_id uuid NOT NULL REFERENCES email_packages(id),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  PRIMARY KEY (package_id, request_id)
);

CREATE TABLE package_attachments (
  package_id uuid NOT NULL REFERENCES email_packages(id),
  attachment_id uuid NOT NULL REFERENCES attachments(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  PRIMARY KEY (package_id, attachment_id)
);

CREATE TABLE email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  mailbox_id uuid REFERENCES mailbox_connections(id),
  source text NOT NULL CHECK (source IN ('sync', 'manual_import', 'sent')),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  provider_message_id text,
  internet_message_id text,
  conversation_id text,
  in_reply_to text,
  references_ids text[] NOT NULL DEFAULT '{}',
  from_address text,
  to_addresses text[] NOT NULL DEFAULT '{}',
  cc_addresses text[] NOT NULL DEFAULT '{}',
  subject text,
  body_text text,
  received_at timestamptz,
  is_forward boolean NOT NULL DEFAULT false,
  match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched', 'unmatched', 'ignored')),
  match_confidence numeric(4, 3),
  match_method text,
  package_id uuid REFERENCES email_packages(id),
  imported_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_messages_imid_idx ON email_messages (org_id, internet_message_id) WHERE internet_message_id IS NOT NULL;

CREATE TABLE message_links (
  message_id uuid NOT NULL REFERENCES email_messages(id),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  method text NOT NULL,
  confidence numeric(4, 3) NOT NULL,
  linked_by uuid,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, request_id)
);

CREATE TABLE message_attachments (
  message_id uuid NOT NULL REFERENCES email_messages(id),
  attachment_id uuid NOT NULL REFERENCES attachments(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE extraction_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  message_id uuid NOT NULL REFERENCES email_messages(id),
  attachment_id uuid REFERENCES attachments(id),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  classification text NOT NULL CHECK (classification IN (
    'acknowledgement', 'quotation', 'proposed', 'confirmed', 'modification', 'cancellation', 'missing_info', 'unclear')),
  extractor text NOT NULL CHECK (extractor IN ('rules', 'ai', 'workbook')),
  fields jsonb NOT NULL DEFAULT '[]',      -- [{field, current, proposed, source:{kind, start, end, excerpt}}]
  critical boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'auto_applied')),
  request_version int NOT NULL,            -- request version when extracted (detects stale proposals)
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workbook_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  returned_attachment_id uuid NOT NULL REFERENCES attachments(id),
  original_attachment_id uuid REFERENCES attachments(id),
  package_id uuid REFERENCES email_packages(id),
  message_id uuid REFERENCES email_messages(id),
  result jsonb NOT NULL,                   -- {rows:[{status, ref, requestId, changes:[...]}], unsupported:[]}
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  package_id uuid NOT NULL REFERENCES email_packages(id),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'prepared', 'cancelled', 'superseded')),
  reminder_package_id uuid REFERENCES email_packages(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit, security monitoring, exports
-- ---------------------------------------------------------------------------

-- Append-only, hash-chained audit log. Contents are metadata only: never document
-- contents, medical details or message bodies.
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,                    -- all-zero UUID for platform-level events (e.g. sign-in)
  seq bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  session_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  ip inet,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  UNIQUE (org_id, seq)
);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);

CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- Generated and inbound files are immutable once stored.
CREATE FUNCTION attachments_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot OR NEW.filename IS DISTINCT FROM OLD.filename THEN
    RAISE EXCEPTION 'attachment content is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attachments_no_content_update BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_immutable();
CREATE TRIGGER attachments_no_delete BEFORE DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TABLE security_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,                      -- login_failed, login_denied, privilege_change, export, ...
  org_id uuid,
  user_id uuid,
  ip inet,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX security_events_kind_idx ON security_events (kind, at);

CREATE TABLE security_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  detail jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid,
  handled_at timestamptz
);

CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  dataset text NOT NULL,
  format text NOT NULL,
  row_count int NOT NULL,
  includes_restricted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idp_login_attempts (
  id bigserial PRIMARY KEY,
  state_hash bytea NOT NULL UNIQUE,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  idp text NOT NULL,
  return_to text NOT NULL DEFAULT '/',
  invitation_token text,
  step_up boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
