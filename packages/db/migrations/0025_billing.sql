-- =============================================================================
-- 0025_billing.sql — P3.2: receipts, taking money in, print history
--
-- WHAT:     1. documents: receipt columns (bill_subtotal, discount_reason,
--              discount_entered_at, discount_approved_by, receipt_snapshot) and
--              the "bill presented" columns (presented_at, presented_by,
--              presented_hash, presented_totals); a partial unique index (one
--              LIVE receipt per job); a CHECK that a receipt is never 'signed'.
--           2. document_lines: line_discount + line_discount_reason (Ice 20 Oct,
--              P3.2 B4: staff may discount single receipt lines, reason mandatory).
--           3. payment_channels (new, per shop, Ice 20 Oct P3.2 B3): the shop's own
--              list of ways to be paid - name, kind (cash | transfer | card), a
--              surcharge percent, active flag, sort order. Never deleted.
--              seed_payment_channels() gives a shop its one cash channel.
--           4. payments: payment_channel_id and surcharge_amount; made APPEND-ONLY by
--              a trigger (it was only so by convention); CHECK ck_payment_change
--              (change is cash only and strictly less than what was handed over).
--           5. payment_reversals (new): the money-out side of a voided receipt.
--           6. document_prints (new): one row per print action, append-only
--              (DECISION-2026-10-15 s2).
--           7. The default REC pattern becomes the shop's real receipt format,
--              RC{BE}{MM}{DD}{SEQ:3} (e.g. RC690916002), daily reset.
--              seed_document_series() is replaced and REC rows that have never
--              numbered a document are moved to it. 0003's allocator already
--              understands {BE}, {MM}, {DD} and a daily reset, so NO engine
--              change is needed.
--
--           NOT here, on purpose (Ice 20 Oct): no till / drawer count (B7 cut -
--           daily_closings from 0005 is untouched) and no tax-invoice request flag
--           (B8 cut).
--
-- WHY:      P3.2 (docs/WORK-ORDERS/P3.2-REQUIREMENTS-DRAFT.md). The ledger rules
--           of CLAUDE.md s5.3 (money is append-only rows) and s5 (a numbered
--           document never changes) had no database enforcement for payments;
--           this adds it.
--
--           DESIGN CHOICE — how a voided receipt's money is reversed.
--           payments.amount has CHECK (amount > 0) and the table is append-only,
--           so a negative "refund" row is impossible and editing the original
--           row would rewrite the day it was received. Options considered:
--             (a) a `kind` column on payments with negative rows  - breaks
--                 amount > 0 and every "SUM(amount)" already written;
--             (b) a separate append-only table, one row per reversed payment.
--           (b) is used. "Money in" for a day D is
--                 SUM(payments.amount - change_given   where received_at in D)
--               - SUM(payment_reversals.amount          where reversed_at in D)
--           so the original day keeps showing the money that really came in, and
--           the void day shows the refund as its own negative line. UNIQUE
--           (payment_id) means a payment can be reversed once.
--
--           DESIGN CHOICE — what payments.amount holds with a surcharge.
--           payments.amount = everything the customer handed over through that
--           channel = (the part applied to the bill) + surcharge_amount.
--           The surcharge is a fee on top of the bill, not a discount and not part
--           of the 40% base. SUM(amount - change_given) = bill total + surcharges,
--           and "money in" includes the surcharge. DEFAULT pending Ice (B3
--           surcharge display).
--
--           DESIGN CHOICE — receipt columns on documents, not a side table.
--           trg_documents_immutable (0022/0024) freezes every column that is not
--           on a transition's allow-list by diffing the whole row as JSON, so
--           columns added here are frozen on an issued receipt (and on a void
--           one) for free. How a receipt maps onto the shared columns:
--             grand_total      = the BILL TOTAL (ยอดบิล) = bill_subtotal
--                                - sum(line_discount) - discount
--             bill_subtotal    = sum of the charged lines BEFORE any discount
--             discount         = the document-level receipt discount
--             offered_discount = the discount AGREED on the quotation at confirm
--                                (reference only; the receipt discount may differ)
--             approved_total   = the quotation's approved_total at snapshot
--             offered_total    = 0 (unused for receipts)
--             source_document_id = the signed quotation it was built from
--           NOTE: grand_total means "offered" on a quotation and "bill total" on
--           a receipt; the document type says which. Do not mix them in a query.
--
-- ROLLBACK: (psql -v ON_ERROR_STOP=1 --single-transaction, as postgres, after
--           taking a backup and rolling the API back first; delete the
--           schema_migrations row in the same transaction.) Order matters.
--
--             DROP TRIGGER trg_document_prints_append_only ON document_prints;
--             DROP TABLE document_prints;
--             DROP TRIGGER trg_payment_reversals_append_only ON payment_reversals;
--             DROP TABLE payment_reversals;   -- LOSES the record of refunds
--             DROP TRIGGER trg_payments_append_only ON payments;
--             ALTER TABLE payments DROP CONSTRAINT ck_payment_change,
--               DROP CONSTRAINT ck_payment_surcharge,
--               DROP COLUMN payment_channel_id, DROP COLUMN surcharge_amount;
--             DROP FUNCTION billing_append_only();
--             DROP FUNCTION seed_payment_channels(uuid);
--             DROP TABLE payment_channels;
--             ALTER TABLE document_lines DROP CONSTRAINT ck_line_discount,
--               DROP COLUMN line_discount, DROP COLUMN line_discount_reason;
--             ALTER TABLE documents DROP CONSTRAINT ck_receipt_never_signed;
--             DROP INDEX uq_live_receipt_per_job;
--             ALTER TABLE documents DROP COLUMN bill_subtotal,
--               DROP COLUMN discount_reason, DROP COLUMN discount_entered_at,
--               DROP COLUMN discount_approved_by, DROP COLUMN receipt_snapshot,
--               DROP COLUMN presented_at, DROP COLUMN presented_by,
--               DROP COLUMN presented_hash, DROP COLUMN presented_totals;
--             -- seed_document_series(): restore 0003's body (REC pattern
--             -- 'RC-{YY}{MM}-{SEQ:4}', monthly). Existing REC rows keep the new
--             -- pattern; set them back by hand if wanted.
--             DELETE FROM schema_migrations WHERE filename = '0025_billing.sql';
--
--           Rolling back after receipts exist DELETES their reversal history,
--           channels and print history. Do not, once the shop is live: void and
--           re-issue instead.
-- LOCKS:    ADD COLUMN (nullable / constant default) is catalog-only on PG 16.
--           CREATE UNIQUE INDEX and ADD CONSTRAINT take SHARE / ACCESS EXCLUSIVE
--           locks for the time it takes to scan documents / payments (small).
--           Run outside shop hours.
-- ROWS:     The REC UPDATE touches document_series rows where REC has never
--           numbered a document. The channel seed inserts one cash channel per
--           existing shop. Nothing else is backfilled.
-- RUN AS:   a superuser (the runner). The REC UPDATE reads documents of every
--           shop, which RLS would hide from gsms_app.
-- SQLSTATE: reuses GS002 (CLAUDE.md s9.1) with TABLE = the table name and
--           HINT = 'append_only'. No new code, so no s9.1 entry.
-- =============================================================================

DO $guard$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0025 must run as a superuser (the REC pattern UPDATE reads documents of every shop)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'documents' AND column_name = 'offered_discount') THEN
    RAISE EXCEPTION '0025_billing requires 0024_offered_discount first';
  END IF;
END
$guard$;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. documents — receipt columns, bill presentation, one live receipt per job
-- -----------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN bill_subtotal        numeric(12,2),
  -- Why the receipt discount differs from the agreed one, or why the total
  -- discount exceeds the 40% ceiling. Free text typed by staff.
  ADD COLUMN discount_reason      text,
  -- NULL = staff never typed a discount on this draft; the carried (agreed)
  -- discount is in force iff every line was done in full (domain: receiptDiscount).
  ADD COLUMN discount_entered_at  timestamptz,
  -- The manager / assistant manager / owner who closed a bill whose total
  -- discount is above the ceiling. NULL when the ceiling was not exceeded.
  ADD COLUMN discount_approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Who and what the receipt was for on the day it was issued: customer name and
  -- phone, plate / brand / model / mileage, job number, the closer's name.
  -- Written once at issue (frozen with the row); the print reads this, never a
  -- live join (CLAUDE.md s5 rule 1, AC-E7). Contains personal data by design -
  -- it is the printed receipt - and is never logged.
  ADD COLUMN receipt_snapshot     jsonb,
  -- Ice 20 Oct (P3.2 B1): the customer sees the bill BEFORE money is taken.
  -- "Present bill" stores the figures shown and a hash of everything they depend
  -- on (ticks, line discounts, the document discount). Closing needs a
  -- presentation whose hash still equals the current one; any change after
  -- presenting makes it stale and the bill must be presented again.
  ADD COLUMN presented_at         timestamptz,
  ADD COLUMN presented_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN presented_hash       text,
  ADD COLUMN presented_totals     jsonb;

-- One receipt in flight or standing per job. A voided receipt leaves the slot
-- free (A-1: void, then issue a new one; the old number stays in the sequence).
CREATE UNIQUE INDEX uq_live_receipt_per_job ON documents (shop_id, job_id)
  WHERE type = 'receipt' AND job_id IS NOT NULL AND status IN ('draft', 'issued');

-- A receipt is not a quotation: it is never "signed". The API never writes it;
-- the domain/service answers 409 first (CLAUDE.md s4.y).
ALTER TABLE documents ADD CONSTRAINT ck_receipt_never_signed
  CHECK (type <> 'receipt' OR status IN ('draft', 'issued', 'void')) NOT VALID;
ALTER TABLE documents VALIDATE CONSTRAINT ck_receipt_never_signed;

-- -----------------------------------------------------------------------------
-- 2. document_lines — a discount on one receipt line (Ice 20 Oct, P3.2 B4)
-- -----------------------------------------------------------------------------
-- Frozen with the line when the receipt is issued (document_lines_are_immutable).
-- The domain (receiptLineDiscountIssue) refuses a discount above the line's
-- charge and a missing reason with a field error first.
ALTER TABLE document_lines
  ADD COLUMN line_discount        numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN line_discount_reason text;
ALTER TABLE document_lines ADD CONSTRAINT ck_line_discount
  CHECK (line_discount >= 0
         AND (line_discount = 0 OR (line_discount_reason IS NOT NULL AND length(btrim(line_discount_reason)) > 0))) NOT VALID;
ALTER TABLE document_lines VALIDATE CONSTRAINT ck_line_discount;

-- -----------------------------------------------------------------------------
-- 3. payment_channels (Ice 20 Oct, P3.2 B3)
-- -----------------------------------------------------------------------------
-- The shop's own list: "ออมสิน", "กสิกร", "รูดบัตร"... `kind` is the reporting
-- category (transfer and QR are the same kind). surcharge_percent is what a
-- channel adds on top of the amount paid through it (e.g. 3.00 for a card).
-- Never deleted - payments reference it - only deactivated.
CREATE TABLE payment_channels (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name              text NOT NULL CHECK (length(btrim(name)) > 0),
  kind              text NOT NULL CHECK (kind IN ('cash', 'transfer', 'card')),
  surcharge_percent numeric(5,2) NOT NULL DEFAULT 0
                    CHECK (surcharge_percent >= 0 AND surcharge_percent <= 100),
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Two live channels with one name would be indistinguishable on the screen.
CREATE UNIQUE INDEX uq_payment_channels_name ON payment_channels (shop_id, lower(btrim(name))) WHERE is_active;
CREATE INDEX idx_payment_channels_shop ON payment_channels (shop_id, sort_order, name);
CALL apply_tenant_rls('payment_channels');
CREATE TRIGGER trg_payment_channels_updated BEFORE UPDATE ON payment_channels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A shop's starting point: one cash channel. Called by the seed and by shop
-- creation (like seed_document_series), and by the API on first use.
CREATE OR REPLACE FUNCTION seed_payment_channels(p_shop_id uuid) RETURNS void AS $$
BEGIN
  INSERT INTO payment_channels (shop_id, name, kind, sort_order)
  SELECT p_shop_id, 'เงินสด', 'cash', 0
   WHERE NOT EXISTS (SELECT 1 FROM payment_channels WHERE shop_id = p_shop_id);
END;
$$ LANGUAGE plpgsql;

-- Existing shops get their cash channel now (superuser: RLS does not narrow this).
SELECT seed_payment_channels(id) FROM shops;

-- -----------------------------------------------------------------------------
-- 4. Append-only guard (shared) and the payment columns
-- -----------------------------------------------------------------------------
-- Allowed: nothing, except the FK action ON DELETE SET NULL on the actor columns
-- (a user row is never deleted in practice; if one is, NULLing the actor must not
-- be blocked by the very trigger that protects the ledger).
CREATE OR REPLACE FUNCTION billing_append_only() RETURNS trigger AS $$
DECLARE
  v_actor_cols text[] := ARRAY['received_by', 'closed_by', 'printed_by', 'reversed_by'];
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - v_actor_cols) = (to_jsonb(OLD) - v_actor_cols)
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(to_jsonb(NEW)) n
         JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
        WHERE n.key = ANY (v_actor_cols)
          AND n.value IS DISTINCT FROM o.value
          AND n.value <> 'null'::jsonb) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'GS002', TABLE = TG_TABLE_NAME, HINT = 'append_only';
END;
$$ LANGUAGE plpgsql;

ALTER TABLE payments
  ADD COLUMN payment_channel_id uuid REFERENCES payment_channels(id) ON DELETE RESTRICT,
  -- Part of `amount`: the fee the channel added on top of the bill (never negative).
  ADD COLUMN surcharge_amount   numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD CONSTRAINT ck_payment_surcharge
  CHECK (surcharge_amount >= 0 AND surcharge_amount < amount) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT ck_payment_surcharge;
CREATE INDEX idx_payments_channel ON payments (shop_id, payment_channel_id, received_at DESC)
  WHERE payment_channel_id IS NOT NULL;

-- Change given is cash only and strictly less than what was handed over; the
-- domain (settlePayments) refuses first.
ALTER TABLE payments ADD CONSTRAINT ck_payment_change
  CHECK (change_given >= 0 AND change_given < amount
         AND (change_given = 0 OR method = 'cash')) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT ck_payment_change;

CREATE TRIGGER trg_payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();

-- -----------------------------------------------------------------------------
-- 5. payment_reversals
-- -----------------------------------------------------------------------------
CREATE TABLE payment_reversals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  payment_id  uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  -- Copied from the payment so a report by kind needs no join.
  method      text NOT NULL CHECK (method IN ('cash', 'transfer', 'card', 'deposit_offset')),
  payment_channel_id uuid REFERENCES payment_channels(id) ON DELETE RESTRICT,
  -- What actually went back to the customer: payments.amount - change_given.
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  reason      text NOT NULL CHECK (length(btrim(reason)) > 0),
  reversed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reversed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_reversed_once UNIQUE (payment_id)
);
CREATE INDEX idx_payment_reversals_day ON payment_reversals (shop_id, reversed_at DESC);
CREATE INDEX idx_payment_reversals_document ON payment_reversals (shop_id, document_id);
CALL apply_tenant_rls('payment_reversals');
CREATE TRIGGER trg_payment_reversals_append_only BEFORE UPDATE OR DELETE ON payment_reversals
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();

-- -----------------------------------------------------------------------------
-- 6. document_prints
-- -----------------------------------------------------------------------------
-- One row per print ACTION (one action = two physical copies, customer + shop).
-- The row is written BEFORE the browser prints, so N on the paper is always a
-- row that exists. It records "the system produced a print", not "paper came
-- out": the browser cannot tell a print from a cancelled dialog.
--
-- subject_id is the document id for a quotation or a receipt, and the JOB id for
-- a work order (which has no document of its own, A-4). N counts per subject.
CREATE TABLE document_prints (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_id              uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  document_id         uuid REFERENCES documents(id) ON DELETE RESTRICT,
  doc_type            text NOT NULL CHECK (doc_type IN ('quotation', 'work_order', 'receipt')),
  subject_id          uuid NOT NULL,
  seq                 integer NOT NULL CHECK (seq >= 1),
  status_at_print     text NOT NULL,
  revision            integer,
  copy_set            text NOT NULL DEFAULT 'customer_shop'
                      CHECK (copy_set IN ('customer_shop', 'customer_only', 'shop_only')),
  -- sha-256 of the printable content as it stood at print time. The next print
  -- compares against the latest one: that is "content changed since last print".
  content_hash        text NOT NULL,
  -- The operator saw "printed N times, content changed" and pressed continue.
  acknowledged_change boolean NOT NULL DEFAULT false,
  printed_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  printed_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_prints_seq UNIQUE (shop_id, doc_type, subject_id, seq)
);
CREATE INDEX idx_document_prints_job ON document_prints (shop_id, job_id, printed_at DESC);
CALL apply_tenant_rls('document_prints');
CREATE TRIGGER trg_document_prints_append_only BEFORE UPDATE OR DELETE ON document_prints
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();

-- -----------------------------------------------------------------------------
-- 7. REC numbering — the shop's real format
-- -----------------------------------------------------------------------------
-- RC{BE}{MM}{DD}{SEQ:3} -> RC690916002 on 16 Sep 2569, second receipt of the day.
-- Daily reset so the pattern's {DD} cannot repeat a number.
-- (WO-005 s2; 0003 had seeded 'RC-{YY}{MM}-{SEQ:4}' monthly.)
CREATE OR REPLACE FUNCTION seed_document_series(p_shop_id uuid) RETURNS void AS $$
BEGIN
  INSERT INTO document_series (shop_id, series, name, pattern, reset_policy) VALUES
    (p_shop_id, 'JOB', 'เลขงาน',              'JB-{YY}{MM}{DD}-{SEQ:3}', 'daily'),
    (p_shop_id, 'QUO', 'ใบเสนอราคา',           'IV{YY}{MM}{DD}{SEQ:3}',   'daily'),
    (p_shop_id, 'WO',  'ใบแจ้งซ่อม',            'WO-{YY}{MM}{DD}-{SEQ:3}', 'daily'),
    (p_shop_id, 'REC', 'ใบเสร็จรับเงิน',         'RC{BE}{MM}{DD}{SEQ:3}',   'daily'),
    (p_shop_id, 'DEP', 'ใบรับเงินมัดจำ',         'DEP-{YY}{MM}-{SEQ:4}',    'monthly'),
    (p_shop_id, 'TAX', 'ใบกำกับภาษี',           'TX{BEEE}{SEQ:5}',         'yearly'),
    (p_shop_id, 'ABB', 'ใบกำกับภาษีอย่างย่อ',    'AB{BEEE}{SEQ:5}',         'yearly'),
    (p_shop_id, 'CN',  'ใบลดหนี้',              'CN{BEEE}{SEQ:5}',         'yearly')
  ON CONFLICT (shop_id, series) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Move shops that still carry 0003's default and have never numbered a receipt.
-- A shop that already issued receipts under the old pattern keeps it: changing
-- a live series is the owner's decision in settings, not a migration's.
UPDATE document_series ds
   SET pattern = 'RC{BE}{MM}{DD}{SEQ:3}', reset_policy = 'daily'
 WHERE ds.series = 'REC'
   AND ds.pattern = 'RC-{YY}{MM}-{SEQ:4}'
   AND NOT EXISTS (SELECT 1 FROM documents d
                    WHERE d.shop_id = ds.shop_id AND d.series = 'REC' AND d.number IS NOT NULL);
