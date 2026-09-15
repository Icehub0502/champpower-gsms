-- Run once per database, as the postgres superuser.
--
--   psql -U postgres -d gsms -f packages\db\setup-role.sql
--
-- Then set the password in a SEPARATE command, so the value is visible and
-- unambiguous:
--
--   psql -U postgres -d gsms -c "ALTER ROLE gsms_app PASSWORD 'yourpassword'"
--
-- This file deliberately does NOT prompt for the password. psql's \prompt does
-- not mask input and keeps trailing whitespace, so a single stray space becomes
-- a password nobody can reproduce — and a Postgres password cannot be read back
-- to check, only tested or reset.
--
-- Why a separate role at all: a table's owner and any superuser BYPASS row-level
-- security. Connect the API as postgres and every tenant policy in this schema
-- silently stops applying, while every test still passes.

-- NOLOGIN until a password is set, so the role cannot be used half-configured.
CREATE ROLE gsms_app NOLOGIN;

GRANT USAGE ON SCHEMA public TO gsms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gsms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gsms_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO gsms_app;

-- Tables created by later migrations need the same grants automatically,
-- otherwise the next migration quietly leaves the app unable to read its own
-- new table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gsms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gsms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO gsms_app;

-- Deliberately NOT granted: CREATE on the schema, and any DDL. Migrations run
-- as the superuser; the application must never alter its own schema.

\echo ''
\echo 'Role created with NOLOGIN. Now set its password:'
\echo '  psql -U postgres -d gsms -c "ALTER ROLE gsms_app LOGIN PASSWORD ''yourpassword''"'
\echo 'Then put the SAME value in DATABASE_URL in .env'
\echo ''
