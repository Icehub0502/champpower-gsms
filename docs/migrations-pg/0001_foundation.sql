-- =============================================================================
-- 0001_foundation.sql — tenancy, identity, audit, files
--
-- WHAT:     The three-layer tenancy spine (owner group -> shop -> membership),
--           user identity and sessions, the audit log, and file metadata.
--           Also installs the Row Level Security machinery every later
--           migration depends on.
-- WHY:      Every other table in this system hangs off shop_id. This has to
--           exist and be correct before anything else is created.
-- ROLLBACK: DROP SCHEMA public CASCADE; CREATE SCHEMA public;
--           (safe only on a fresh database — this is the first migration)
-- LOCKS:    None of consequence; empty database.
-- ROWS:     0 affected. Seeds nothing.
-- =============================================================================

-- gen_random_uuid() is built in from PG 13; pgcrypto kept for older installs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- btree_gist is required by the booking overlap constraint in a later migration.
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- pg_trgm powers fuzzy search on Thai customer names and part names.
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Keeps updated_at honest without every writer having to remember it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The shop the current transaction is acting within. The API sets this with
-- SET LOCAL app.current_shop_id = '<uuid>' at the start of every request,
-- taken from active_shop_id inside the JWT and nowhere else.
CREATE OR REPLACE FUNCTION current_shop_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.current_shop_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- The set of shops a group-level read may span. Only the group repositories
-- set this, and only to shops the user holds a membership in.
CREATE OR REPLACE FUNCTION current_shop_ids() RETURNS uuid[] AS $$
  SELECT coalesce(
    nullif(current_setting('app.current_shop_ids', true), '')::uuid[],
    ARRAY[]::uuid[]
  );
$$ LANGUAGE sql STABLE;

-- Applies the standard tenant policy to a table. Called once per shop-scoped
-- table so the policy can never be written slightly differently in one place.
-- A row is visible when it belongs to the active shop, or to one of the shops
-- an explicit group-level read has been scoped to.
CREATE OR REPLACE PROCEDURE apply_tenant_rls(tbl regclass) AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format($f$
    CREATE POLICY tenant_isolation ON %s
      USING (shop_id = current_shop_id() OR shop_id = ANY (current_shop_ids()))
      WITH CHECK (shop_id = current_shop_id())
  $f$, tbl);
END;
$$ LANGUAGE plpgsql;
-- Note the asymmetry and keep it: reads may span a group, writes never can.
-- Every mutation must name exactly one shop.


-- -----------------------------------------------------------------------------
-- Tenancy
-- -----------------------------------------------------------------------------

CREATE TABLE owner_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- Stable handle used by the seed and by fixtures, so tests and scripts can
  -- name a group without hard-coding a generated uuid.
  slug        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_owner_groups_slug UNIQUE (slug)
);

CREATE TABLE shops (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_group_id  uuid NOT NULL REFERENCES owner_groups(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  slug            text NOT NULL,

  -- Seller identity printed on tax documents. Blank until the user fills it in;
  -- the VAT room refuses to issue while any of these is empty.
  legal_name      text NOT NULL DEFAULT '',
  tax_id          text NOT NULL DEFAULT '',
  branch_code     text NOT NULL DEFAULT '',
  address         text NOT NULL DEFAULT '',
  phone           text NOT NULL DEFAULT '',

  -- Short code the owner picks, used by the {SHOP} token in document number
  -- patterns (see 0003). Empty is fine for a single-branch shop.
  doc_code        text NOT NULL DEFAULT '',

  -- Don Mueang runs led teams; Samut Prakan works as one pool and sets 'none'.
  assignment_mode text NOT NULL DEFAULT 'none'
                  CHECK (assignment_mode IN ('team', 'individual', 'none')),
  -- Manual stock adjustments above this value need a manager's approval.
  -- 0 means every adjustment needs one.
  adjustment_limit numeric(12,2) NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_shops_slug UNIQUE (slug)
);
CREATE INDEX idx_shops_group ON shops (owner_group_id);


-- -----------------------------------------------------------------------------
-- Identity
-- -----------------------------------------------------------------------------

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- An email, or a plain username for technicians who have no email.
  login_id       text NOT NULL,
  password_hash  text NOT NULL,
  name           text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive and unique across the whole system, not per shop.
CREATE UNIQUE INDEX uq_users_login_id ON users (lower(login_id));

-- Role lives here, not on users: one person can hold different roles in
-- different branches, and an owner holds one row per branch they own.
CREATE TABLE shop_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN (
                'owner', 'manager', 'assistant_manager', 'advisor',
                'technician', 'accountant', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT uq_membership UNIQUE (user_id, shop_id)
);
CREATE INDEX idx_memberships_shop ON shop_memberships (shop_id, role);
CREATE INDEX idx_memberships_user ON shop_memberships (user_id);

-- Refresh-token sessions, so a departing employee can be cut off immediately
-- instead of staying valid until the token expires.
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti         text NOT NULL,
  device      text,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,

  CONSTRAINT uq_sessions_jti UNIQUE (jti)
);
CREATE INDEX idx_sessions_user_live ON sessions (user_id) WHERE revoked_at IS NULL;


-- -----------------------------------------------------------------------------
-- Audit
-- -----------------------------------------------------------------------------

-- Every mutation that touches money, stock, documents or personnel data writes
-- here. Reads of evaluation data write here too — see CLAUDE.md 5.7.
CREATE TABLE audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  request_id   text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_shop_at ON audit_logs (shop_id, at DESC);
CREATE INDEX idx_audit_entity ON audit_logs (shop_id, entity_type, entity_id);
-- Lets the owner answer "what changed about this part last month" without a scan.
CREATE INDEX idx_audit_after_gin ON audit_logs USING gin (after jsonb_path_ops);
CALL apply_tenant_rls('audit_logs');


-- -----------------------------------------------------------------------------
-- Files
-- -----------------------------------------------------------------------------

-- Metadata only. Bytes live on disk at storage/<shop_id>/<yyyy>/<mm>/<id>.<ext>
-- and are served ONLY through an endpoint that checks the JWT and matches
-- shop_id against active_shop_id. Never express.static — see ARCHITECTURE.md 5.
CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  path         text NOT NULL,
  mime         text NOT NULL,
  bytes        bigint NOT NULL,
  kind         text NOT NULL CHECK (kind IN (
                 'part_photo', 'signature', 'deposit_slip',
                 'document_pdf', 'other')),
  uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_files_path UNIQUE (path)
);
CREATE INDEX idx_files_shop_kind ON files (shop_id, kind, created_at DESC);
CALL apply_tenant_rls('files');


-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------

CREATE TRIGGER trg_owner_groups_updated BEFORE UPDATE ON owner_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_shops_updated BEFORE UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- Roles
-- -----------------------------------------------------------------------------
-- The application connects as gsms_app, which owns nothing and is not a
-- superuser, so RLS actually applies to it. Migrations run as the owning role,
-- which bypasses RLS by design.
--
-- Run once per database, outside this migration (needs a superuser):
--   CREATE ROLE gsms_app LOGIN PASSWORD '...';
--   GRANT USAGE ON SCHEMA public TO gsms_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gsms_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gsms_app;
--
-- If the app ever connects as the table owner, RLS silently stops protecting
-- anything. There is an integration test for exactly this.
