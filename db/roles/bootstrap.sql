-- Run ONCE per Neon project, as the project owner, before the first migration.
-- Passwords are never written here. Pass them at run time (see scripts/apply-roles.mjs).
-- Store the resulting app connection string in AWS Secrets Manager, not in this repo.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'procurement_app') THEN
    CREATE ROLE procurement_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE procurement_app PASSWORD :'procurement_app_password';

-- The app role can use the procurement schema and touch rows only. It cannot create objects.
GRANT USAGE ON SCHEMA procurement TO procurement_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA procurement TO procurement_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA procurement GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO procurement_app;
