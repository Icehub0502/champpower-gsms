-- =============================================================================
-- 0005_money.sql — deposits, payments, daily close
--
-- WHAT:     Taking money in. Deposits (including the ones transferred through
--           the shop's page before a car ever arrives), payments against a
--           bill, and the end-of-day cash reconciliation.
-- WHY:      The system currently has no idea whether a customer has paid.
-- ROLLBACK: DROP TABLE daily_closings, payments, deposits CASCADE;
-- LOCKS:    None; tables are new.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Deposits
-- -----------------------------------------------------------------------------
-- A deposit belongs to a CUSTOMER, not to a job. Someone messages the shop's
-- page and transfers money days before the car shows up — there is no job, no
-- vehicle and no queue entry to hang it on yet.

CREATE TABLE deposits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  job_id       uuid REFERENCES jobs(id) ON DELETE SET NULL,
  vehicle_id   uuid REFERENCES vehicles(id) ON DELETE SET NULL,

  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  reason       text NOT NULL CHECK (reason IN (
                 'booking', 'special_part', 'large_job')),
  method       text NOT NULL CHECK (method IN ('cash', 'transfer', 'card')),
  channel      text NOT NULL DEFAULT 'walk_in'
               CHECK (channel IN ('walk_in', 'page', 'line', 'phone')),
  -- Proof for a transfer the shop never saw in person.
  slip_file_id uuid REFERENCES files(id) ON DELETE SET NULL,

  -- When the customer said they would bring the car. Past this date the row
  -- surfaces as overdue immediately — no waiting period.
  expected_date date NOT NULL,

  status       text NOT NULL DEFAULT 'held'
               CHECK (status IN ('held', 'applied', 'refunded', 'forfeited')),
  applied_to_document_id uuid REFERENCES documents(id) ON DELETE RESTRICT,

  -- The document the customer is handed. Says "ใบรับเงินมัดจำ" and nothing
  -- resembling a receipt or a tax invoice.
  slip_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,

  received_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  -- Used for both refunds and forfeits. Forfeiting turns a customer's money
  -- into the shop's, so it is manager-and-above and always needs a reason.
  closed_at    timestamptz,
  closed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  close_reason text,

  CONSTRAINT ck_deposit_closed CHECK (
    (status IN ('refunded', 'forfeited')) = (close_reason IS NOT NULL)),
  CONSTRAINT ck_deposit_applied CHECK (
    (status = 'applied') = (applied_to_document_id IS NOT NULL))
);
-- The list of money the shop is holding on someone else's behalf.
CREATE INDEX idx_deposits_held ON deposits (shop_id, expected_date)
  WHERE status = 'held';
-- Matching a walk-in against a transfer made weeks earlier is done by phone
-- number, so this index is what makes the reminder at check-in possible.
CREATE INDEX idx_deposits_customer ON deposits (shop_id, customer_id, status);
CALL apply_tenant_rls('deposits');

-- Forfeited money becomes shop income on the day it is forfeited, and must be
-- reportable separately from repair revenue or the average bill value lies.
-- It carries no VAT (the user's decision, recorded in CLAUDE.md 5.4).


-- -----------------------------------------------------------------------------
-- Payments
-- -----------------------------------------------------------------------------
-- Append-only, several rows per bill. A deposit applied at the counter and the
-- balance paid in cash are two rows, not one adjusted number.

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  deposit_id   uuid REFERENCES deposits(id) ON DELETE RESTRICT,

  method       text NOT NULL CHECK (method IN (
                 'cash', 'transfer', 'card', 'deposit_offset')),
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  -- Recorded separately from amount. Storing the net would lose what was
  -- actually handed over, which is what the till has to reconcile against.
  change_given numeric(12,2) NOT NULL DEFAULT 0,

  received_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_deposit_offset CHECK (
    (method = 'deposit_offset') = (deposit_id IS NOT NULL))
);
CREATE INDEX idx_payments_document ON payments (document_id);
CREATE INDEX idx_payments_day ON payments (shop_id, received_at DESC);
CALL apply_tenant_rls('payments');

-- A bill closes only when SUM(payments.amount) >= grand_total. Short payment
-- blocks the close: this shop has never had a customer leave one part-paid,
-- so the flow does not open a door for it.


-- -----------------------------------------------------------------------------
-- Daily close
-- -----------------------------------------------------------------------------

CREATE TABLE daily_closings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  business_date  date NOT NULL,

  expected_cash  numeric(12,2) NOT NULL,
  counted_cash   numeric(12,2) NOT NULL,
  variance       numeric(12,2) GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
  note           text,

  closed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_closing_day UNIQUE (shop_id, business_date)
);
CREATE INDEX idx_closings_variance ON daily_closings (shop_id, business_date DESC)
  WHERE variance <> 0;
CALL apply_tenant_rls('daily_closings');
