-- =============================================================================
-- 0002_core.sql — customers, vehicles, jobs, teams, catalog
--
-- WHAT:     The existing MySQL schema (0001_init.sql) rewritten for PostgreSQL,
--           with shop_id added throughout, money moved from VARCHAR to numeric,
--           base64 photo columns replaced by file references, and the team /
--           job_workers model added.
-- WHY:      This is the working core the shop uses every day. Everything from
--           phase 4 onward (documents, stock, purchasing, VAT) attaches to it.
-- ROLLBACK: DROP TABLE IN REVERSE ORDER OF CREATION (listed at the foot of this
--           file). Safe while no later migration has run.
-- LOCKS:    None; tables are new.
-- ROWS:     0 affected.
--
-- CHANGES FROM THE MYSQL VERSION — read before comparing the two files:
--   * CHAR(36) ids           -> uuid
--   * DATETIME               -> timestamptz  (the shop is UTC+7; store UTC)
--   * VARCHAR(191)           -> text         (PG has no index-length penalty)
--   * VARCHAR money          -> numeric(12,2)  <- FIX-02
--   * LONGTEXT base64 photos -> uuid REFERENCES files(id)  <- FIX-09
--   * ENUM(...)              -> text + CHECK  (alterable without a table rewrite)
--   * global unique keys     -> per-shop unique keys
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Customers and vehicles
-- -----------------------------------------------------------------------------

CREATE TABLE customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name           text,
  phone          text,

  -- Needed before a tax invoice can be issued. An individual may have one too:
  -- their 13-digit taxpayer id, with the name and address from their ID card.
  customer_type  text NOT NULL DEFAULT 'individual'
                 CHECK (customer_type IN ('individual', 'juristic')),
  legal_name     text,
  tax_id         text,
  branch_code    text,
  address        text,

  -- Captured once, at the first check-in, so the owner can see which channel
  -- actually brings cars in. 'unknown' is a real option on purpose: without it
  -- staff pick at random to get past the form and the data is worse than none.
  lead_source    text CHECK (lead_source IN (
                   'page', 'line', 'shopfront_sign', 'referral',
                   'google', 'passing_by', 'other', 'unknown')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_phone ON customers (shop_id, phone);
-- Fuzzy name search; Thai names rarely match exactly on the first try.
CREATE INDEX idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);
CALL apply_tenant_rls('customers');

CREATE TABLE vehicles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plate        text NOT NULL,
  -- Normalised plate for lookup: no spaces, no dashes. Generated, so the
  -- application cannot forget to keep it in step with plate.
  plate_key    text GENERATED ALWAYS AS
               (upper(regexp_replace(plate, '[^0-9A-Za-zก-๙]', '', 'g'))) STORED,
  province     text,
  brand        text NOT NULL,
  model        text NOT NULL,
  year         text,
  color        text,
  mileage      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_vehicles_customer ON vehicles (shop_id, customer_id);
CREATE INDEX idx_vehicles_plate_key ON vehicles (shop_id, plate_key);
CALL apply_tenant_rls('vehicles');


-- -----------------------------------------------------------------------------
-- Teams
-- -----------------------------------------------------------------------------

CREATE TABLE technicians (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  -- Set once a technician gets a login; null while the role stays switched off.
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_technicians_shop ON technicians (shop_id, is_active, sort_order);
CALL apply_tenant_rls('technicians');

CREATE TABLE teams (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name                 text NOT NULL,
  lead_technician_id   uuid REFERENCES technicians(id) ON DELETE SET NULL,
  is_active            boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_teams_shop ON teams (shop_id, is_active);
CALL apply_tenant_rls('teams');

CREATE TABLE team_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  team_id        uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  technician_id  uuid NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,

  CONSTRAINT uq_team_member UNIQUE (team_id, technician_id)
);
CALL apply_tenant_rls('team_members');


-- -----------------------------------------------------------------------------
-- Jobs
-- -----------------------------------------------------------------------------

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_number      text NOT NULL,
  queue_no        text,

  vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  mileage_in      text,

  status          text NOT NULL DEFAULT 'received' CHECK (status IN (
                    'received', 'inspecting', 'quoted', 'approved', 'scheduled',
                    'rejected', 'repairing', 'aligning', 'ready', 'delivered',
                    'carout')),

  -- A warranty return is its own job, pointing back at the one it redoes.
  -- It bills nothing but still consumes stock — see CLAUDE.md 5.5.
  job_type        text NOT NULL DEFAULT 'normal'
                  CHECK (job_type IN ('normal', 'warranty_claim')),
  parent_job_id   uuid REFERENCES jobs(id) ON DELETE RESTRICT,

  -- Who is responsible. Contribution is recorded separately, in job_workers.
  assigned_team_id        uuid REFERENCES teams(id) ON DELETE SET NULL,
  assigned_technician_id  uuid REFERENCES technicians(id) ON DELETE SET NULL,

  bay               text,
  appointment_date  timestamptz,
  est_value         numeric(12,2),
  est_unit          text CHECK (est_unit IN ('minute', 'hour', 'day')),
  warranty_days     integer,

  thumb_file_id     uuid REFERENCES files(id) ON DELETE SET NULL,
  photo_count       integer NOT NULL DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  deleted_by        uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Was global in MySQL; a second branch would have collided immediately.
  CONSTRAINT uq_jobs_number UNIQUE (shop_id, job_number),
  -- A warranty claim must redo work done at this same branch — CLAUDE.md 8.1.
  CONSTRAINT ck_warranty_parent CHECK (
    (job_type = 'warranty_claim') = (parent_job_id IS NOT NULL))
);
CREATE INDEX idx_jobs_status ON jobs (shop_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_jobs_created ON jobs (shop_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_jobs_vehicle ON jobs (shop_id, vehicle_id);
CREATE INDEX idx_jobs_customer ON jobs (shop_id, customer_id);
CREATE INDEX idx_jobs_parent ON jobs (parent_job_id) WHERE parent_job_id IS NOT NULL;
CALL apply_tenant_rls('jobs');

-- Enforces the same-branch rule above at write time; a CHECK cannot see
-- another row, so this has to be a trigger.
CREATE OR REPLACE FUNCTION check_warranty_same_shop() RETURNS trigger AS $$
DECLARE parent_shop uuid;
BEGIN
  IF NEW.parent_job_id IS NULL THEN RETURN NEW; END IF;
  SELECT shop_id INTO parent_shop FROM jobs WHERE id = NEW.parent_job_id;
  IF parent_shop IS DISTINCT FROM NEW.shop_id THEN
    RAISE EXCEPTION 'warranty claim must stay in the branch that did the work';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jobs_warranty_shop BEFORE INSERT OR UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION check_warranty_same_shop();

CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Who actually put hands on the car. Several people per job is normal at
-- Samut Prakan. KPI reads this table and never assigned_* — CLAUDE.md 5.6.
CREATE TABLE job_workers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id  uuid NOT NULL REFERENCES technicians(id) ON DELETE RESTRICT,
  role           text NOT NULL DEFAULT 'helper' CHECK (role IN ('lead', 'helper')),
  recorded_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_job_worker UNIQUE (job_id, technician_id)
);
CREATE INDEX idx_job_workers_tech ON job_workers (shop_id, technician_id, recorded_at DESC);
CALL apply_tenant_rls('job_workers');


CREATE TABLE job_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status      text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_status_history_job ON job_status_history (job_id, changed_at);
CALL apply_tenant_rls('job_status_history');

CREATE TABLE job_technician_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id  uuid REFERENCES technicians(id) ON DELETE SET NULL,
  name           text NOT NULL,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_tech_history_job ON job_technician_history (job_id, changed_at);
CALL apply_tenant_rls('job_technician_history');

CREATE TABLE job_complaints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  text        text NOT NULL,
  custom      boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_complaints_job ON job_complaints (job_id, sort_order);
CALL apply_tenant_rls('job_complaints');

CREATE TABLE job_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  text        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_notes_job ON job_notes (job_id, at);
CALL apply_tenant_rls('job_notes');

-- Photos of the replaced part, shown to the customer. File reference, not
-- base64 — the old LONGTEXT columns are what made SELECT * expensive.
CREATE TABLE job_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  caption     text,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_job_photos_job ON job_photos (job_id, sort_order);
CALL apply_tenant_rls('job_photos');


-- -----------------------------------------------------------------------------
-- Catalog — the price book, unchanged in shape from the MySQL version
-- -----------------------------------------------------------------------------

CREATE TABLE vehicle_models (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  brand       text NOT NULL,
  name        text NOT NULL,
  year_range  text,
  seed_key    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_models_brand ON vehicle_models (shop_id, brand, name);
CALL apply_tenant_rls('vehicle_models');

CREATE TABLE model_parts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  model_id    uuid NOT NULL REFERENCES vehicle_models(id) ON DELETE CASCADE,
  part_name   text NOT NULL,
  category    text,
  qty         numeric(12,2),
  unit        text,
  variant     text,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_model_parts_model ON model_parts (model_id, sort_order);
CALL apply_tenant_rls('model_parts');

CREATE TABLE model_part_brands (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  model_part_id  uuid NOT NULL REFERENCES model_parts(id) ON DELETE CASCADE,
  name           text NOT NULL,
  price          numeric(12,2),
  sort_order     integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_part_brands_part ON model_part_brands (model_part_id, sort_order);
CALL apply_tenant_rls('model_part_brands');

CREATE TABLE promotions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  model_id       uuid NOT NULL REFERENCES vehicle_models(id) ON DELETE CASCADE,
  name           text NOT NULL,
  price          numeric(12,2),
  date_start     date,
  date_end       date,
  mileage_start  integer,
  mileage_end    integer,
  sort_order     integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_promotions_model ON promotions (model_id, date_start, date_end);
CALL apply_tenant_rls('promotions');

CREATE TABLE promotion_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  promotion_id  uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  item_ref      text NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0
);
CALL apply_tenant_rls('promotion_items');


-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_vehicles_updated BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- ROLLBACK
--   DROP TABLE promotion_items, promotions, model_part_brands, model_parts,
--     vehicle_models, job_photos, job_notes, job_complaints,
--     job_technician_history, job_status_history, job_workers, jobs,
--     team_members, teams, technicians, vehicles, customers CASCADE;
--   DROP FUNCTION check_warranty_same_shop();
-- =============================================================================
