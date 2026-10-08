-- Communications workflow additions.
ALTER TABLE email_packages ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE email_packages ADD COLUMN amends_package_id uuid REFERENCES email_packages(id);
ALTER TABLE email_packages ADD COLUMN send_channel text CHECK (send_channel IN ('connector', 'recorded_external'));
ALTER TABLE email_packages ADD COLUMN source_versions jsonb NOT NULL DEFAULT '{}';  -- request id -> version at generation
ALTER TABLE email_messages ADD COLUMN match_candidates jsonb NOT NULL DEFAULT '[]';
ALTER TABLE email_messages ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]';
-- Old attachments stay stored and linked when a package is regenerated; they are only marked superseded.
ALTER TABLE package_attachments ADD COLUMN superseded_at timestamptz;

CREATE TABLE mailbox_oauth_states (
  state_hash bytea PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  code_verifier text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('individual', 'shared')),
  shared_address text,
  expires_at timestamptz NOT NULL
);
ALTER TABLE mailbox_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mailbox_oauth_states USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, DELETE ON mailbox_oauth_states TO cc_app;
