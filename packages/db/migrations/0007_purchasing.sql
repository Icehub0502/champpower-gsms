-- =============================================================================
-- 0007_purchasing.sql — suppliers, purchase invoices, payables, returns
--
-- WHAT:     The buying side. One paper bill from a parts shop, entered once,
--           produces three things at the same time: stock in, money owed, and
--           input VAT.
-- WHY:      Those three are the same event. Systems that make staff enter them
--           on three screens end up with three numbers that disagree, and
--           nobody can say which is right.
-- ROLLBACK: DROP TABLE supplier_payments, supplier_statement_lines,
--           supplier_statements, purchase_return_lines, purchase_returns,
--           purchase_invoice_lines, purchase_invoices, purchase_order_lines,
--           purchase_orders, suppliers CASCADE;
--           ALTER TABLE stock_lots DROP CONSTRAINT fk_lots_supplier;
--           ALTER TABLE stock_moves DROP CONSTRAINT fk_moves_supplier;
-- LOCKS:    Brief ACCESS EXCLUSIVE on stock_lots and stock_moves for two FKs.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Suppliers — the one thing shared across branches in an owner group
-- -----------------------------------------------------------------------------
-- Note owner_group_id, not shop_id: the same parts shops serve every branch, so
-- maintaining the list six times would be pointless. What each branch OWES is
-- still its own, which is why the invoices below carry shop_id.

CREATE TABLE suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_group_id  uuid NOT NULL REFERENCES owner_groups(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  -- Lets the owner see the month's spend split by what was bought.
  category        text CHECK (category IN (
                    'suspension', 'tyre', 'oil', 'general', 'service', 'other')),
  tax_id          text,
  branch_code     text,
  address         text,
  phone           text,
  payment_terms   text NOT NULL DEFAULT 'cash'
                  CHECK (payment_terms IN ('cash', 'credit', 'monthly_statement')),
  credit_days     integer,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_suppliers_group ON suppliers (owner_group_id, category) WHERE is_active;
-- No RLS: this table is group-scoped, not shop-scoped. Access is checked in the
-- repository against the caller's owner_group_id.

CREATE TRIGGER trg_suppliers_updated BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE stock_lots ADD CONSTRAINT fk_lots_supplier
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT;
ALTER TABLE stock_moves ADD CONSTRAINT fk_moves_supplier
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT;


-- -----------------------------------------------------------------------------
-- Purchase orders — optional, for parts ordered ahead
-- -----------------------------------------------------------------------------

CREATE TABLE purchase_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  supplier_id  uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  po_number    text NOT NULL,
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'partial', 'received', 'cancelled')),
  ordered_at   timestamptz NOT NULL DEFAULT now(),
  ordered_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  note         text,

  CONSTRAINT uq_po_number UNIQUE (shop_id, po_number)
);
CREATE INDEX idx_po_supplier ON purchase_orders (shop_id, supplier_id, status);
CALL apply_tenant_rls('purchase_orders');

CREATE TABLE purchase_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  purchase_order_id  uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sku_id             uuid REFERENCES skus(id) ON DELETE RESTRICT,
  name_typed         text NOT NULL,
  qty                numeric(12,2) NOT NULL,
  qty_received       numeric(12,2) NOT NULL DEFAULT 0,
  unit_cost          numeric(12,4),
  sort_order         integer NOT NULL DEFAULT 0
);
CALL apply_tenant_rls('purchase_order_lines');


-- -----------------------------------------------------------------------------
-- Purchase invoices — the heart of this migration
-- -----------------------------------------------------------------------------
-- Typed in by hand from the paper bill the parts shop hands over. That one
-- entry brings the stock in, records what the branch owes, and captures the
-- input VAT for the month's filing.

CREATE TABLE purchase_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  owner_group_id       uuid NOT NULL REFERENCES owner_groups(id) ON DELETE RESTRICT,
  supplier_id          uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  purchase_order_id    uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,

  -- The number printed on the supplier's own bill, not one we generate.
  supplier_invoice_no  text NOT NULL,
  invoice_date         date NOT NULL,
  due_date             date,

  subtotal             numeric(12,2) NOT NULL DEFAULT 0,
  vat_amount           numeric(12,2) NOT NULL DEFAULT 0,
  grand_total          numeric(12,2) NOT NULL DEFAULT 0,
  -- False when the parts shop is not VAT-registered, or handed over no invoice.
  -- Never fill in a VAT figure to make the month look tidier.
  has_vat_credit       boolean NOT NULL DEFAULT true,

  status               text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'partially_paid', 'paid', 'void')),
  entered_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Unique across the GROUP, not the branch. A supplier's invoice numbers are
  -- unique from their side, so this also catches one branch accidentally
  -- entering another branch's bill — which would double the stock, the debt
  -- and the tax credit all at once.
  CONSTRAINT uq_purchase_invoice UNIQUE (owner_group_id, supplier_id, supplier_invoice_no),
  CONSTRAINT ck_no_vat_credit CHECK (has_vat_credit OR vat_amount = 0)
);
CREATE INDEX idx_pinv_supplier ON purchase_invoices (shop_id, supplier_id, invoice_date DESC);
-- Feeds the payables screen: who is owed what, and when it falls due.
CREATE INDEX idx_pinv_unpaid ON purchase_invoices (shop_id, supplier_id, due_date)
  WHERE status IN ('open', 'partially_paid');
-- Feeds the monthly input-VAT report.
CREATE INDEX idx_pinv_month ON purchase_invoices (shop_id, invoice_date)
  WHERE has_vat_credit;
CALL apply_tenant_rls('purchase_invoices');

CREATE TRIGGER trg_pinv_updated BEFORE UPDATE ON purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_invoice_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  purchase_invoice_id  uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  -- Null means the line could not be brought into stock. There is a report for
  -- exactly these so they get chased rather than forgotten.
  sku_id               uuid REFERENCES skus(id) ON DELETE RESTRICT,
  name_typed           text NOT NULL,
  qty                  numeric(12,2) NOT NULL,
  unit                 text,
  unit_cost            numeric(12,4) NOT NULL,
  line_total           numeric(12,2) NOT NULL,
  is_vatable           boolean NOT NULL DEFAULT true,
  sort_order           integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_pinv_lines_invoice ON purchase_invoice_lines (purchase_invoice_id, sort_order);
CREATE INDEX idx_pinv_lines_unlinked ON purchase_invoice_lines (shop_id)
  WHERE sku_id IS NULL;
CALL apply_tenant_rls('purchase_invoice_lines');


-- -----------------------------------------------------------------------------
-- Returns to the supplier
-- -----------------------------------------------------------------------------
-- Reverses all three effects together. The original invoice is never edited:
-- that month's VAT return may already have been filed.

CREATE TABLE purchase_returns (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  purchase_invoice_id     uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  -- The credit note number the parts shop issued to us, if they issued one.
  supplier_credit_note_no text,
  reason                  text NOT NULL,
  subtotal                numeric(12,2) NOT NULL DEFAULT 0,
  vat_amount              numeric(12,2) NOT NULL DEFAULT 0,
  grand_total             numeric(12,2) NOT NULL DEFAULT 0,
  returned_at             timestamptz NOT NULL DEFAULT now(),
  returned_by             uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_preturn_invoice ON purchase_returns (purchase_invoice_id);
CALL apply_tenant_rls('purchase_returns');

CREATE TABLE purchase_return_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                  uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  purchase_return_id       uuid NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  purchase_invoice_line_id uuid NOT NULL REFERENCES purchase_invoice_lines(id) ON DELETE RESTRICT,
  sku_id                   uuid REFERENCES skus(id) ON DELETE RESTRICT,
  qty                      numeric(12,2) NOT NULL CHECK (qty > 0),
  unit_cost                numeric(12,4) NOT NULL
);
CALL apply_tenant_rls('purchase_return_lines');


-- -----------------------------------------------------------------------------
-- Monthly statements — where the money actually leaks
-- -----------------------------------------------------------------------------
-- A parts shop sends a statement covering a month of deliveries. Matching it
-- line by line against the invoices already in the system is slow enough by
-- hand that most garages simply pay what they are billed.

CREATE TABLE supplier_statements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  supplier_id    uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  -- What the supplier says is owed, before we check it.
  total_claimed  numeric(12,2) NOT NULL,
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'reconciled', 'disputed', 'paid')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_statement_period UNIQUE (shop_id, supplier_id, period_start, period_end)
);
CREATE INDEX idx_statements_open ON supplier_statements (shop_id, supplier_id)
  WHERE status IN ('open', 'disputed');
CALL apply_tenant_rls('supplier_statements');

CREATE TABLE supplier_statement_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  statement_id         uuid NOT NULL REFERENCES supplier_statements(id) ON DELETE CASCADE,
  -- Null when the statement lists a bill we have no record of — which is
  -- precisely the row the shop needs to see before paying.
  purchase_invoice_id  uuid REFERENCES purchase_invoices(id) ON DELETE SET NULL,
  claimed_invoice_no   text NOT NULL,
  claimed_amount       numeric(12,2) NOT NULL,
  match_status         text NOT NULL DEFAULT 'unmatched'
                       CHECK (match_status IN (
                         'matched', 'unmatched', 'amount_differs', 'not_in_system')),
  note                 text
);
CREATE INDEX idx_stmt_lines_problem ON supplier_statement_lines (statement_id)
  WHERE match_status <> 'matched';
CALL apply_tenant_rls('supplier_statement_lines');


-- -----------------------------------------------------------------------------
-- Paying suppliers
-- -----------------------------------------------------------------------------
-- Append-only, applied to one invoice at a time. Recording only a lump sum
-- leaves no way to answer which bills are still outstanding.

CREATE TABLE supplier_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  supplier_id          uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  purchase_invoice_id  uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  statement_id         uuid REFERENCES supplier_statements(id) ON DELETE SET NULL,
  amount               numeric(12,2) NOT NULL CHECK (amount > 0),
  method               text NOT NULL CHECK (method IN ('cash', 'transfer', 'cheque')),
  reference            text,
  paid_at              timestamptz NOT NULL DEFAULT now(),
  paid_by              uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_supplier_payments_invoice ON supplier_payments (purchase_invoice_id);
CREATE INDEX idx_supplier_payments_day ON supplier_payments (shop_id, paid_at DESC);
CALL apply_tenant_rls('supplier_payments');
