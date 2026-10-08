-- Row-level security: second, independent tenant-isolation layer.
--
-- The runtime database role (member of cc_app) has no BYPASSRLS and does not own the
-- tables, so these policies always apply to it. Every request transaction sets
-- app.org_id (and app.user_id) with set_config(..., true). If the setting is absent,
-- no tenant rows are visible at all (deny by default).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_app') THEN
    CREATE ROLE cc_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'suppliers', 'user_preferences', 'saved_filters', 'assets', 'requirement_types', 'positions',
    'personnel', 'personnel_identity', 'personnel_medical', 'documents', 'credentials', 'crew_changes',
    'assignments', 'crew_change_people', 'service_requests', 'request_events', 'tasks', 'comments',
    'notifications', 'insights', 'supplier_contacts', 'workbook_templates', 'email_templates',
    'mailbox_connections', 'attachments', 'email_packages', 'package_requests', 'package_attachments',
    'email_messages', 'message_links', 'message_attachments', 'extraction_proposals',
    'workbook_reconciliations', 'reminders', 'exports'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_org()) WITH CHECK (org_id = app_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO cc_app', t);
  END LOOP;
END
$$;

-- Memberships: a user can always see their own memberships (to list and switch
-- workspaces); everything else is limited to the active organisation.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_visibility ON memberships
  USING (org_id = app_org() OR user_id = app_user())
  WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, UPDATE ON memberships TO cc_app;

-- Audit log: insert and read only. No UPDATE/DELETE privilege, plus triggers.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_events FOR SELECT USING (org_id = app_org());
CREATE POLICY audit_insert ON audit_events FOR INSERT
  WITH CHECK (org_id = app_org() OR org_id = '00000000-0000-0000-0000-000000000000');
GRANT SELECT, INSERT ON audit_events TO cc_app;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO cc_app;

-- Identity and platform tables are accessed through explicitly scoped queries.
GRANT SELECT, INSERT, UPDATE ON organizations, users, sessions, invitations TO cc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_login_attempts TO cc_app;
GRANT SELECT, INSERT ON security_events TO cc_app;
GRANT SELECT, INSERT, UPDATE ON security_alerts TO cc_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO cc_app;
GRANT EXECUTE ON FUNCTION app_org(), app_user() TO cc_app;

-- The application role must never be able to rewrite attachment rows' content either.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM cc_app;
