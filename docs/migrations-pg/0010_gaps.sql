-- =============================================================================
-- 0010_gaps.sql — fixes and additions found reviewing 0001–0009
--
-- WHAT:     Four corrections to earlier migrations, and five things the design
--           needed but nobody had written down yet.
-- WHY:      Cheaper now than after the shop has data in these tables.
-- ROLLBACK: listed at the foot of the file.
-- LOCKS:    Brief ACCESS EXCLUSIVE on jobs, customers, document_lines,
--           stock_moves, deposits, evaluations while columns are added.
--           All tables are still empty, so this is instant.
-- =============================================================================


-- =============================================================================
-- PART 1 — corrections
-- =============================================================================

-- 1.1  jobs.bay was carried over from MySQL as free text, but 0008 introduced a
--      real bays table. Two lists of bays that can disagree is worse than one.
ALTER TABLE jobs DROP COLUMN bay;
ALTER TABLE jobs ADD COLUMN bay_id uuid REFERENCES bays(id) ON DELETE SET NULL;
CREATE INDEX idx_jobs_bay ON jobs (shop_id, bay_id) WHERE deleted_at IS NULL;

-- 1.2  Mileage was text, which makes warranty arithmetic impossible. Warranty
--      terms here are "1 year OR 100,000 km, whichever comes first", so the
--      odometer has to be a number, and we need the reading at delivery too.
ALTER TABLE jobs ADD COLUMN mileage_in_km  integer;
ALTER TABLE jobs ADD COLUMN mileage_out_km integer;
COMMENT ON COLUMN jobs.mileage_in  IS 'DEPRECATED: free text from the MySQL era. Use mileage_in_km.';

-- 1.3  Customers could not be deleted at all, while jobs could. Beyond the
--      inconsistency, PDPA gives customers a right to erasure — see part 2.4.
ALTER TABLE customers ADD COLUMN deleted_at timestamptz;
ALTER TABLE customers ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN anonymised_at timestamptz;
CREATE INDEX idx_customers_live ON customers (shop_id) WHERE deleted_at IS NULL;

-- 1.4  Who ticked the line off as done. Needed for the audit trail and because
--      "who said this was finished" is the first question when it wasn't.
ALTER TABLE document_lines ADD COLUMN fulfilled_at timestamptz;
ALTER TABLE document_lines ADD COLUMN fulfilled_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- 1.5  A deposit taken to hold a slot should point at the slot it holds.
ALTER TABLE deposits ADD COLUMN booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;

-- 1.6  The VAT rate is a number that has changed before and can change again.
--      Documents snapshot their own vat_amount, so old ones are unaffected.
ALTER TABLE shops ADD COLUMN vat_rate numeric(5,4) NOT NULL DEFAULT 0.07;


-- =============================================================================
-- PART 2 — what was missing
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1  Warranty, at the level it actually exists: per part
-- -----------------------------------------------------------------------------
-- jobs.warranty_days held one number for a whole job. Replace four parts in one
-- bill and they carry different terms — a rack is a year or 100,000 km, a shock
-- is something else. One number cannot express that, so claims were going to be
-- judged by memory.

CREATE TABLE warranty_terms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name        text NOT NULL,          -- 'แร็ค/ลูกหมาก OEM'
  days        integer,                -- null = no time limit
  max_km      integer,                -- null = no distance limit
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,

  CONSTRAINT ck_term_has_limit CHECK (days IS NOT NULL OR max_km IS NOT NULL)
);
CALL apply_tenant_rls('warranty_terms');

-- Terms are chosen on the quotation line and snapshotted there, because the
-- shop's standard terms change and a warranty already sold must not.
ALTER TABLE document_lines ADD COLUMN warranty_term_id uuid
  REFERENCES warranty_terms(id) ON DELETE SET NULL;
ALTER TABLE document_lines ADD COLUMN warranty_days integer;
ALTER TABLE document_lines ADD COLUMN warranty_max_km integer;

-- The live warranty. One row per part actually fitted, created when the car is
-- handed back — not when it was quoted, because the clock starts at delivery.
CREATE TABLE warranties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  vehicle_id        uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  job_id            uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  document_line_id  uuid REFERENCES document_lines(id) ON DELETE SET NULL,
  sku_id            uuid REFERENCES skus(id) ON DELETE SET NULL,

  -- Snapshot again: what was fitted and under what terms, as printed.
  part_name         text NOT NULL,
  brand             text,
  days              integer,
  max_km            integer,

  starts_at         timestamptz NOT NULL,
  start_mileage_km  integer,
  -- Not a generated column: adding an interval to a timestamptz is STABLE, not
  -- IMMUTABLE (day arithmetic depends on the session time zone), and PostgreSQL
  -- refuses a generation expression that is not immutable. Filled by the
  -- trigger below instead, which is the better behaviour anyway — the expiry a
  -- customer was promised must not move if a setting changes years later.
  expires_at        timestamptz,

  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'claimed', 'expired', 'void')),
  claimed_job_id    uuid REFERENCES jobs(id) ON DELETE SET NULL,
  claimed_at        timestamptz,
  void_reason       text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_warranty_has_limit CHECK (days IS NOT NULL OR max_km IS NOT NULL)
);
-- Computed once, at creation, from the terms in force that day.
CREATE OR REPLACE FUNCTION warranties_set_expiry() RETURNS trigger AS $$
BEGIN
  IF NEW.days IS NULL THEN
    NEW.expires_at := NULL;                    -- mileage-only cover
  ELSE
    NEW.expires_at := NEW.starts_at + make_interval(days => NEW.days);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_warranties_expiry BEFORE INSERT ON warranties
  FOR EACH ROW EXECUTE FUNCTION warranties_set_expiry();

CREATE INDEX idx_warranties_vehicle ON warranties (shop_id, vehicle_id, status);
CREATE INDEX idx_warranties_active ON warranties (shop_id, expires_at)
  WHERE status = 'active';
CALL apply_tenant_rls('warranties');

-- Whether a warranty still covers the car, checked on BOTH limits. The counter
-- staff should never have to work this out on paper.
CREATE OR REPLACE FUNCTION warranty_is_valid(
  w warranties, at_time timestamptz, current_km integer
) RETURNS boolean AS $$
  SELECT w.status = 'active'
     AND (w.expires_at IS NULL OR at_time <= w.expires_at)
     AND (w.max_km IS NULL
          OR w.start_mileage_km IS NULL
          OR current_km IS NULL
          OR current_km - w.start_mileage_km <= w.max_km);
$$ LANGUAGE sql STABLE;

-- A warranty-claim job now points at the specific warranty it is redeeming,
-- not just at the earlier job. Four parts on one bill means four warranties,
-- and only one of them is being claimed.
ALTER TABLE jobs ADD COLUMN warranty_id uuid REFERENCES warranties(id) ON DELETE RESTRICT;

COMMENT ON COLUMN jobs.warranty_days IS
  'DEPRECATED: warranty now lives per part in the warranties table.';

-- Application rule (cannot be a constraint, it spans rows): when a job reaches
-- 'delivered', insert one warranty per approved-and-fulfilled part line that
-- carries terms, with starts_at = delivery time and start_mileage_km =
-- jobs.mileage_out_km.


-- -----------------------------------------------------------------------------
-- 2.2  Time the job spent waiting, so speed metrics are fair
-- -----------------------------------------------------------------------------
-- KPI compares actual time against the estimate. Derived from status history
-- alone that includes every hour the car sat waiting for a part, and a
-- technician would be marked slow for a delivery that never arrived.

CREATE TABLE job_holds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  reason      text NOT NULL CHECK (reason IN (
                'waiting_parts', 'waiting_customer', 'waiting_bay',
                'waiting_approval', 'other')),
  note        text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  started_by  uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT ck_hold_order CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE INDEX idx_holds_job ON job_holds (job_id, started_at);
CREATE INDEX idx_holds_open ON job_holds (shop_id, started_at) WHERE ended_at IS NULL;
CALL apply_tenant_rls('job_holds');

-- working time = (ready - repairing) - SUM(hold durations)
-- Hold rows open automatically when a shortfall is recorded and close when the
-- goods arrive, so the common case needs nobody to remember anything.


-- -----------------------------------------------------------------------------
-- 2.3  Branch transfers, as a pair that has to complete
-- -----------------------------------------------------------------------------
-- 0006 had transfer_out and transfer_in as movement types with nothing joining
-- them. Parts could leave Don Mueang and never arrive at Samut Prakan and no
-- report would show it.

CREATE TABLE stock_transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Keyed on the group, not a shop: this row belongs to two branches at once.
  -- Access is checked in the repository against membership in either end.
  owner_group_id  uuid NOT NULL REFERENCES owner_groups(id) ON DELETE RESTRICT,
  from_shop_id    uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  to_shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  transfer_no     text NOT NULL,
  status          text NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('sent', 'received', 'cancelled')),
  note            text,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  sent_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  received_at     timestamptz,
  received_by     uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT uq_transfer_no UNIQUE (owner_group_id, transfer_no),
  CONSTRAINT ck_transfer_different CHECK (from_shop_id <> to_shop_id)
);
CREATE INDEX idx_transfers_pending ON stock_transfers (owner_group_id, sent_at)
  WHERE status = 'sent';

CREATE TABLE stock_transfer_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id  uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  sku_id       uuid NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  qty          numeric(12,2) NOT NULL CHECK (qty > 0),
  -- Cost travels with the goods, so the receiving branch's average is right.
  unit_cost    numeric(12,4) NOT NULL
);
CREATE INDEX idx_transfer_lines ON stock_transfer_lines (transfer_id);

ALTER TABLE stock_moves ADD COLUMN transfer_id uuid
  REFERENCES stock_transfers(id) ON DELETE RESTRICT;
CREATE INDEX idx_moves_transfer ON stock_moves (transfer_id)
  WHERE transfer_id IS NOT NULL;

-- Goods in transit belong to neither branch's on_hand. transfer_out posts on
-- send, transfer_in posts on receipt, and a transfer still 'sent' after a few
-- days is a line on the attention list below.


-- -----------------------------------------------------------------------------
-- 2.4  PDPA — personal data has rights attached to it
-- -----------------------------------------------------------------------------
-- The system holds names, phone numbers, plate numbers and photographs of
-- customers' cars. Thai PDPA gives those customers a right to see what is held
-- and to have it erased, and the shop has to be able to show it responded.
--
-- The hard part is the collision with tax law: a tax invoice must be kept for
-- years and carries the buyer's name and address. Erasure and retention pull
-- in opposite directions.
--
-- How this design resolves it: ANONYMISE the customer record, KEEP the issued
-- documents. The tax document's buyer snapshot stays because retaining it is a
-- legal obligation, which PDPA itself allows for. Everything that is not
-- legally required to be kept is cleared.
--
-- This is a design position, not legal advice. Have the shop's accountant or a
-- lawyer confirm it before the first erasure request is honoured.

CREATE TABLE customer_consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- 'service' is needed to do the work at all. 'marketing' is the one that
  -- matters for the owner's advertising, and the one that can be withdrawn.
  purpose       text NOT NULL CHECK (purpose IN ('service', 'marketing', 'photos')),
  granted       boolean NOT NULL,
  source        text NOT NULL CHECK (source IN ('checkin_form', 'verbal', 'line', 'page')),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz,
  recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_consents_customer ON customer_consents (shop_id, customer_id, purpose);
CALL apply_tenant_rls('customer_consents');

CREATE TABLE data_subject_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  -- Kept even if the customer record is later erased, so the shop can prove
  -- the request was handled.
  contact_name  text NOT NULL,
  contact_phone text,
  type          text NOT NULL CHECK (type IN (
                  'access', 'erasure', 'correction', 'withdraw_consent')),
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'completed', 'refused')),
  -- When erasure is refused because tax law requires retention, the reason
  -- goes here. Refusing without a written reason is the thing that gets a
  -- business into trouble.
  outcome_note  text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  handled_by    uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT ck_dsr_outcome CHECK (
    status = 'open' OR outcome_note IS NOT NULL)
);
CREATE INDEX idx_dsr_open ON data_subject_requests (shop_id, requested_at)
  WHERE status = 'open';
CALL apply_tenant_rls('data_subject_requests');

-- Clears the personal fields while leaving the transactional history intact.
-- Issued documents keep their buyer snapshot: that is the legal-obligation
-- carve-out, and it is why this is anonymisation rather than deletion.
CREATE OR REPLACE FUNCTION anonymise_customer(p_customer_id uuid, p_by uuid)
RETURNS void AS $$
BEGIN
  UPDATE customers SET
    name          = 'ลูกค้าที่ขอลบข้อมูล',
    phone         = NULL,
    legal_name    = NULL,
    tax_id        = NULL,
    address       = NULL,
    lead_source   = NULL,
    anonymised_at = now(),
    deleted_at    = coalesce(deleted_at, now()),
    deleted_by    = p_by
  WHERE id = p_customer_id;

  -- Photographs of the car are personal data too and have no retention duty.
  DELETE FROM job_photos
   WHERE job_id IN (SELECT id FROM jobs WHERE customer_id = p_customer_id);

  UPDATE customer_consents SET withdrawn_at = now()
   WHERE customer_id = p_customer_id AND withdrawn_at IS NULL;
END;
$$ LANGUAGE plpgsql;
-- The file rows on disk must be removed by the application afterwards; SQL
-- cannot unlink files.


-- -----------------------------------------------------------------------------
-- 2.5  Evaluation figures, frozen at submission
-- -----------------------------------------------------------------------------
-- The form shows the technician's numbers while the manager fills it in. Reopen
-- it next year and those numbers would be today's — which quietly rewrites the
-- basis of a judgement about somebody's work.

ALTER TABLE evaluations ADD COLUMN stats_snapshot jsonb;
COMMENT ON COLUMN evaluations.stats_snapshot IS
  'The figures shown to the evaluator, captured at submit. Read-only thereafter.';


-- =============================================================================
-- PART 3 — one place that says what needs doing today
-- =============================================================================
-- Six features each produce their own "somebody should look at this" list.
-- Left apart, staff have to remember to open six screens.
--
-- Deliberately a VIEW, not a notifications table: computed from the source
-- rows, so it can never drift out of step with them, and an item disappears
-- the moment the underlying thing is dealt with. Nothing to sync, nothing to
-- clean up, no stale alert for work already finished.

-- security_invoker: see the note on stock_available. A view without it bypasses
-- the RLS of every table it reads.
CREATE OR REPLACE VIEW attention_items WITH (security_invoker = true) AS

  -- Money the shop is holding past the day the customer said they would come
  SELECT d.shop_id, 'deposit_overdue' AS kind, d.id AS ref_id,
         'มัดจำเลยนัด ' || to_char(d.amount, 'FM999,999.00') || ' บาท' AS label,
         d.expected_date::timestamptz AS due_at, 'high' AS severity
    FROM deposits d
   WHERE d.status = 'held' AND d.expected_date < current_date

  UNION ALL
  -- Cars expected today that have not turned up
  SELECT b.shop_id, 'booking_today', b.id,
         'จองวันนี้ ' || coalesce(b.contact_name, 'ไม่ระบุชื่อ'),
         b.slot_start, 'normal'
    FROM bookings b
   WHERE b.status IN ('booked', 'confirmed')
     AND b.slot_start::date = current_date

  UNION ALL
  -- Shelf running low
  SELECT s.shop_id, 'reorder', s.id,
         'ของใกล้หมด: ' || s.name,
         now(), 'normal'
    FROM skus s
    JOIN stock_balances sb ON sb.shop_id = s.shop_id AND sb.sku_id = s.id
   WHERE s.stocking_policy = 'stocked'
     AND s.reorder_point IS NOT NULL
     AND sb.on_hand - sb.reserved <= s.reorder_point

  UNION ALL
  -- A customer is waiting on a part nobody has ordered yet
  SELECT ps.shop_id, 'purchase_needed', ps.id,
         'ต้องสั่งอะไหล่',
         ps.created_at, 'high'
    FROM purchase_suggestions ps
   WHERE ps.status = 'open'

  UNION ALL
  -- Parts that left another branch and have not been booked in here
  SELECT st.to_shop_id, 'transfer_pending', st.id,
         'ของโอนเข้ายังไม่รับ: ' || st.transfer_no,
         st.sent_at, 'high'
    FROM stock_transfers st
   WHERE st.status = 'sent'

  UNION ALL
  -- A supplier statement waiting to be checked before anyone pays it
  SELECT ss.shop_id, 'statement_open', ss.id,
         'ใบวางบิลรอกระทบยอด',
         ss.period_end::timestamptz, 'normal'
    FROM supplier_statements ss
   WHERE ss.status IN ('open', 'disputed')

  UNION ALL
  -- Bills to the parts shops falling due
  SELECT pi.shop_id, 'payable_due', pi.id,
         'ครบกำหนดจ่ายร้านอะไหล่ ' || to_char(pi.grand_total, 'FM999,999.00'),
         pi.due_date::timestamptz, 'high'
    FROM purchase_invoices pi
   WHERE pi.status IN ('open', 'partially_paid')
     AND pi.due_date IS NOT NULL
     AND pi.due_date <= current_date + 7

  UNION ALL
  -- Quotations the customer has gone quiet on
  SELECT d.shop_id, 'quote_pending', d.id,
         'ใบเสนอราคายังไม่ตอบ',
         d.issued_at, 'normal'
    FROM documents d
   WHERE d.type = 'quotation'
     AND d.status = 'issued'
     AND d.issued_at < now() - interval '3 days'
     AND NOT EXISTS (SELECT 1 FROM documents r
                      WHERE r.source_document_id = d.id AND r.type = 'receipt')

  UNION ALL
  -- Evaluation rounds left half-finished
  SELECT e.shop_id, 'evaluation_due', e.id,
         'แบบประเมินยังไม่ส่ง',
         e.period_end::timestamptz, 'normal'
    FROM evaluations e
   WHERE e.status = 'draft' AND e.period_end < current_date

  UNION ALL
  -- Somebody exercising their PDPA rights, waiting on an answer
  SELECT r.shop_id, 'pdpa_request', r.id,
         'คำขอข้อมูลส่วนบุคคลรอดำเนินการ',
         r.requested_at, 'high'
    FROM data_subject_requests r
   WHERE r.status = 'open';

-- The view inherits RLS from every table it reads, so a branch sees only its
-- own items with no extra filtering.


-- =============================================================================
-- ROLLBACK
--   DROP VIEW attention_items;
--   ALTER TABLE evaluations DROP COLUMN stats_snapshot;
--   DROP FUNCTION anonymise_customer(uuid,uuid);
--   DROP TABLE data_subject_requests, customer_consents CASCADE;
--   ALTER TABLE stock_moves DROP COLUMN transfer_id;
--   DROP TABLE stock_transfer_lines, stock_transfers CASCADE;
--   DROP TABLE job_holds CASCADE;
--   ALTER TABLE jobs DROP COLUMN warranty_id;
--   DROP FUNCTION warranty_is_valid(warranties,timestamptz,integer);
--   DROP TABLE warranties CASCADE;
--   ALTER TABLE document_lines
--     DROP COLUMN warranty_term_id, DROP COLUMN warranty_days,
--     DROP COLUMN warranty_max_km, DROP COLUMN fulfilled_at,
--     DROP COLUMN fulfilled_by;
--   DROP TABLE warranty_terms CASCADE;
--   ALTER TABLE shops DROP COLUMN vat_rate;
--   ALTER TABLE deposits DROP COLUMN booking_id;
--   ALTER TABLE customers
--     DROP COLUMN deleted_at, DROP COLUMN deleted_by, DROP COLUMN anonymised_at;
--   ALTER TABLE jobs
--     DROP COLUMN mileage_in_km, DROP COLUMN mileage_out_km, DROP COLUMN bay_id;
--   ALTER TABLE jobs ADD COLUMN bay text;
-- =============================================================================
