-- =============================================================================
-- 0026_deposits.sql — P3.3: deposits (มัดจำ) as money held for a customer
--
-- WHAT:     1. deposits: payment_channel_id (which of the shop's channels the money
--              came in through), closed_channel_id (which channel a refund went out
--              through), idempotency_key (a retried "receive deposit" never doubles),
--              and indexes for the three questions asked of this table: money received
--              on a day, money refunded / forfeited on a day, what a job or customer
--              holds. One slip image and one slip document per deposit (partial UNIQUE).
--           2. trg_deposits_guard: a deposit is never deleted; the money columns never
--              change; the only status moves are held -> applied | refunded | forfeited
--              and applied -> held (a voided receipt gives the deposit back). Every
--              other column is frozen once the row leaves 'held'.
--           3. documents.type admits 'deposit_receipt' (ใบรับเงินมัดจำ) and
--              documents.deposit_snapshot (customer, amount, channel, quotation number
--              as they were on the day the slip was numbered - frozen with the row).
--           4. document_prints: job_id may be NULL for a deposit slip (a deposit exists
--              before any job) and doc_type admits 'deposit_receipt'.
--
--           NO NEW TABLE, therefore no apply_tenant_rls() call: every table touched here
--           already has its policy (0005, 0004, 0025). The refund and the forfeit are
--           states of the deposit row (status, closed_at, closed_by, close_reason), not
--           rows elsewhere: a deposit leaves 'held' exactly once, so "money out on day D"
--           is read from deposits.closed_at and cannot drift from the deposit itself.
--
-- WHY:      CLAUDE.md s5.4 (deposits belong to the customer, are real money on the day
--           received, have their own numbered slip, are never deleted) and
--           docs/WORK-ORDERS/P3.3-DEPOSITS-SPEC.md. 0005 created the table; nothing
--           enforced "never delete / money never changes" and nothing could carry the
--           slip document or the channel.
--
-- ROLLBACK: (psql -v ON_ERROR_STOP=1 --single-transaction, as postgres, after
--           taking a backup and rolling the API back first.) Order matters.
--
--             DROP TRIGGER trg_deposits_guard ON deposits;
--             DROP FUNCTION deposits_guard();
--             ALTER TABLE document_prints DROP CONSTRAINT ck_prints_job_or_deposit;
--             ALTER TABLE document_prints ALTER COLUMN job_id SET NOT NULL;  -- fails if
--               -- deposit_receipt prints exist: DELETE them first (this loses print history)
--             ALTER TABLE document_prints DROP CONSTRAINT document_prints_doc_type_check;
--             ALTER TABLE document_prints ADD CONSTRAINT document_prints_doc_type_check
--               CHECK (doc_type IN ('quotation','work_order','receipt','bill_statement'));
--             ALTER TABLE documents DROP COLUMN deposit_snapshot;
--             ALTER TABLE documents DROP CONSTRAINT documents_type_check;
--             ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN (
--               'quotation','work_order','receipt','tax_invoice','abbreviated_tax_invoice',
--               'credit_note'));   -- fails if deposit_receipt documents exist: they are
--               -- numbered, immutable documents; do not delete them, keep this migration.
--             DROP INDEX uq_deposits_idem, uq_deposits_slip_file, uq_deposits_slip_doc,
--               idx_deposits_received, idx_deposits_closed, idx_deposits_job;
--             ALTER TABLE deposits DROP COLUMN payment_channel_id,
--               DROP COLUMN closed_channel_id, DROP COLUMN idempotency_key;
--             DELETE FROM schema_migrations WHERE filename = '0026_deposits.sql';
--
--           Rolling back after deposits exist LOSES which channel each was received
--           through and the idempotency keys. Do not, once the shop is live.
-- LOCKS:    ADD COLUMN (nullable) is catalog-only on PG 16. CREATE INDEX takes SHARE on
--           deposits / documents for the time it takes to scan them (small). The CHECK
--           swap on documents scans documents once under ACCESS EXCLUSIVE (a few
--           thousand rows at most). Run outside shop hours.
-- ROWS:     No backfill. Existing deposits (none in production: the table was never
--           written by the API before P3.3) keep payment_channel_id NULL, which the daily
--           summary reads as "ไม่ระบุช่องทาง" and groups by deposits.method.
-- RUN AS:   the runner (superuser).
-- SQLSTATE: reuses GS002 (CLAUDE.md s9.1) with TABLE = 'deposits' and HINT in
--           deposit_no_delete | deposit_frozen_columns | deposit_transition_invalid |
--           deposit_closed. No new code, so no s9.1 entry.
-- =============================================================================

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_channels') THEN
    RAISE EXCEPTION '0026_deposits requires 0025_billing first';
  END IF;
END
$guard$;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. deposits — columns and indexes
-- -----------------------------------------------------------------------------
ALTER TABLE deposits
  -- The shop's own channel the money came in through (ออมสิน, เงินสด...). Nullable only
  -- because a row written before channels existed has none; the API always sets it.
  ADD COLUMN payment_channel_id uuid REFERENCES payment_channels(id) ON DELETE RESTRICT,
  -- Set only by a refund: the channel the money went back out through. NULL on a refund
  -- means "the channel it came in through". Never set for forfeit / applied.
  ADD COLUMN closed_channel_id  uuid REFERENCES payment_channels(id) ON DELETE RESTRICT,
  -- Client-generated, so a retried POST (double click, flaky shop wifi) is one deposit.
  ADD COLUMN idempotency_key    uuid;

CREATE UNIQUE INDEX uq_deposits_idem ON deposits (shop_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- One slip photo and one slip document belong to one deposit only.
CREATE UNIQUE INDEX uq_deposits_slip_file ON deposits (slip_file_id) WHERE slip_file_id IS NOT NULL;
CREATE UNIQUE INDEX uq_deposits_slip_doc  ON deposits (slip_document_id) WHERE slip_document_id IS NOT NULL;
-- "เงินเข้าวันนี้": deposits by the day they were received.
CREATE INDEX idx_deposits_received ON deposits (shop_id, received_at DESC);
-- Refunds and forfeits by the day they were decided.
CREATE INDEX idx_deposits_closed ON deposits (shop_id, closed_at DESC)
  WHERE status IN ('refunded', 'forfeited');
-- What a job holds (receipt view, the close).
CREATE INDEX idx_deposits_job ON deposits (shop_id, job_id) WHERE job_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. trg_deposits_guard
-- -----------------------------------------------------------------------------
-- The front gate is the API (field errors / 409 first, CLAUDE.md s4.y); this is the net.
CREATE OR REPLACE FUNCTION deposits_guard() RETURNS trigger AS $$
DECLARE
  -- A user row is never deleted in practice; if one is, ON DELETE SET NULL on the actor
  -- columns must not be blocked by the trigger that protects the money.
  v_actor   text[] := ARRAY['received_by', 'closed_by'];
  -- Never change, in any status.
  v_frozen  text[] := ARRAY['id', 'shop_id', 'customer_id', 'amount', 'reason', 'method', 'channel',
                            'expected_date', 'received_at', 'payment_channel_id', 'idempotency_key'];
  v_old     jsonb := to_jsonb(OLD);
  v_new     jsonb := to_jsonb(NEW);
  v_allowed text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deposit % is never deleted', OLD.id
      USING ERRCODE = 'GS002', TABLE = 'deposits', HINT = 'deposit_no_delete';
  END IF;

  IF (v_new - v_actor) = (v_old - v_actor)
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(v_new) n JOIN jsonb_each(v_old) o USING (key)
        WHERE n.key = ANY (v_actor) AND n.value IS DISTINCT FROM o.value AND n.value <> 'null'::jsonb) THEN
    RETURN NEW;  -- a no-op, or only an actor column being NULLed
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(v_frozen) k WHERE v_new -> k IS DISTINCT FROM v_old -> k) THEN
    RAISE EXCEPTION 'deposit % money columns cannot change', OLD.id
      USING ERRCODE = 'GS002', TABLE = 'deposits', HINT = 'deposit_frozen_columns';
  END IF;

  -- The actor columns are outside the diff below, so they are guarded here: received_by only
  -- ever goes to NULL; closed_by is set only by the move to refunded / forfeited.
  IF (NEW.received_by IS DISTINCT FROM OLD.received_by AND NEW.received_by IS NOT NULL)
     OR (NEW.closed_by IS DISTINCT FROM OLD.closed_by AND NEW.closed_by IS NOT NULL
         AND NEW.status NOT IN ('refunded', 'forfeited')) THEN
    RAISE EXCEPTION 'deposit % actor columns cannot change', OLD.id
      USING ERRCODE = 'GS002', TABLE = 'deposits', HINT = 'deposit_frozen_columns';
  END IF;

  IF OLD.status = 'held' THEN
    IF NEW.status = 'held' THEN
      -- Attaching to a job / a booking, adding the slip photo, numbering the slip.
      v_allowed := ARRAY['job_id', 'vehicle_id', 'booking_id', 'slip_file_id', 'slip_document_id'];
    ELSIF NEW.status = 'applied' THEN
      v_allowed := ARRAY['status', 'applied_to_document_id', 'job_id', 'vehicle_id', 'slip_document_id'];
    ELSIF NEW.status = 'refunded' THEN
      v_allowed := ARRAY['status', 'closed_at', 'closed_by', 'close_reason', 'closed_channel_id'];
    ELSIF NEW.status = 'forfeited' THEN
      v_allowed := ARRAY['status', 'closed_at', 'closed_by', 'close_reason'];
    ELSE
      RAISE EXCEPTION 'deposit % cannot become %', OLD.id, NEW.status
        USING ERRCODE = 'GS002', TABLE = 'deposits', HINT = 'deposit_transition_invalid';
    END IF;
  ELSIF OLD.status = 'applied' THEN
    IF NEW.status = 'held' THEN
      -- The receipt it paid into was voided (owner): the customer's money is still ours to hold.
      v_allowed := ARRAY['status', 'applied_to_document_id'];
    ELSIF NEW.status = 'applied' THEN
      -- Numbering the slip of a deposit that was applied before anyone printed it.
      v_allowed := ARRAY['slip_document_id'];
    ELSE
      RAISE EXCEPTION 'deposit % is applied and cannot become %', OLD.id, NEW.status
        USING ERRCODE = 'GS002', TABLE = 'deposits', HINT = 'deposit_transition_invalid';
    END IF;
  ELSE
    -- refunded / forfeited: history. Not even a slip photo.
    RAISE EXCEPTION 'deposit % is % and closed to further change', OLD.id, OLD.status
      USING ERRCODE = 'GS002', TABLE = 'deposits', HINT = 'deposit_closed';
  END IF;

  -- slip_file_id / slip_document_id: set once, never swapped or cleared.
  IF (OLD.slip_file_id IS NOT NULL AND NEW.slip_file_id IS DISTINCT FROM OLD.slip_file_id)
     OR (OLD.slip_document_id IS NOT NULL AND NEW.slip_document_id IS DISTINCT FROM OLD.slip_document_id) THEN
    RAISE EXCEPTION 'deposit % slip cannot be replaced', OLD.id
      USING ERRCODE = 'GS002', TABLE = 'deposits', HINT = 'deposit_frozen_columns';
  END IF;

  IF ((v_new - v_allowed) - v_actor) IS DISTINCT FROM ((v_old - v_allowed) - v_actor) THEN
    RAISE EXCEPTION 'deposit % is % and only % may change in this transition',
        OLD.id, OLD.status, array_to_string(v_allowed, ', ')
      USING ERRCODE = 'GS002', TABLE = 'deposits', HINT = 'deposit_frozen_columns';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_deposits_guard BEFORE UPDATE OR DELETE ON deposits
  FOR EACH ROW EXECUTE FUNCTION deposits_guard();

-- -----------------------------------------------------------------------------
-- 3. documents — the deposit slip
-- -----------------------------------------------------------------------------
ALTER TABLE documents DROP CONSTRAINT documents_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN (
  'quotation', 'work_order', 'receipt', 'tax_invoice', 'abbreviated_tax_invoice', 'credit_note',
  'deposit_receipt')) NOT VALID;
ALTER TABLE documents VALIDATE CONSTRAINT documents_type_check;

-- The slip as it was on the day it was numbered: customer name + phone, amount, channel
-- name, reason, expected date, the quotation number if one was linked, the plate if a job
-- was attached, the closer's name. Written once at issue (the row is inserted as a draft
-- by trg_documents_insert_draft, then updated to 'issued' in the same transaction) and
-- frozen with it by documents_are_immutable(). Personal data by design - it is the
-- printed slip - and never logged.
ALTER TABLE documents ADD COLUMN deposit_snapshot jsonb;

-- -----------------------------------------------------------------------------
-- 4. document_prints — a slip can be printed with no job
-- -----------------------------------------------------------------------------
ALTER TABLE document_prints DROP CONSTRAINT document_prints_doc_type_check;
ALTER TABLE document_prints ADD CONSTRAINT document_prints_doc_type_check
  CHECK (doc_type IN ('quotation', 'work_order', 'receipt', 'bill_statement', 'deposit_receipt'));
ALTER TABLE document_prints ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE document_prints ADD CONSTRAINT ck_prints_job_or_deposit
  CHECK (job_id IS NOT NULL OR doc_type = 'deposit_receipt') NOT VALID;
ALTER TABLE document_prints VALIDATE CONSTRAINT ck_prints_job_or_deposit;
