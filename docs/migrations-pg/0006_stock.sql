-- =============================================================================
-- 0006_stock.sql — SKUs, the movement ledger, balances
--
-- WHAT:     Stock as an append-only ledger with a derived balance cache, not an
--           editable quantity column.
-- WHY:      A quantity you can UPDATE is a quantity two people can overwrite,
--           and a shortfall nobody can explain afterwards. Everything here is
--           built so the number can always be traced back to the rows that
--           made it.
-- ROLLBACK: DROP TABLE purchase_suggestions, stock_balances, stock_moves,
--           stock_lots, skus CASCADE;
--           ALTER TABLE document_lines DROP CONSTRAINT fk_doc_lines_sku;
-- LOCKS:    Brief ACCESS EXCLUSIVE on document_lines to add one FK.
-- =============================================================================

CREATE TABLE skus (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  code               text NOT NULL,
  name               text NOT NULL,
  category           text,
  unit               text NOT NULL DEFAULT 'ชิ้น',

  is_vatable_default boolean NOT NULL DEFAULT true,

  -- stocked      = the shop keeps it on the shelf; has a reorder point
  -- buy_to_order = bought for one job from an outside shop. Still a real SKU
  --                with a balance, a cost and a history — the leftovers from
  --                "bought 4, fitted 2" have to exist somewhere.
  stocking_policy    text NOT NULL DEFAULT 'stocked'
                     CHECK (stocking_policy IN ('stocked', 'buy_to_order')),
  reorder_point      numeric(12,2),
  shelf_location     text,
  is_active          boolean NOT NULL DEFAULT true,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_skus_code UNIQUE (shop_id, code),
  CONSTRAINT ck_reorder_point CHECK (
    stocking_policy = 'stocked' OR reorder_point IS NULL)
);
CREATE INDEX idx_skus_category ON skus (shop_id, category, name) WHERE is_active;
CREATE INDEX idx_skus_name_trgm ON skus USING gin (name gin_trgm_ops);
CALL apply_tenant_rls('skus');

CREATE TRIGGER trg_skus_updated BEFORE UPDATE ON skus
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Now that skus exists, the document line can point at it.
ALTER TABLE document_lines
  ADD CONSTRAINT fk_doc_lines_sku FOREIGN KEY (sku_id)
  REFERENCES skus(id) ON DELETE RESTRICT;


-- -----------------------------------------------------------------------------
-- Lots
-- -----------------------------------------------------------------------------
-- Which delivery a part came out of, and therefore which parts shop supplied it
-- and what it cost that time.

CREATE TABLE stock_lots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  sku_id        uuid NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  supplier_id   uuid,  -- FK added in 0007 once suppliers exists
  lot_no        text,
  serial        text,
  expiry        date,
  unit_cost     numeric(12,4) NOT NULL,
  qty_received  numeric(12,2) NOT NULL,
  qty_remaining numeric(12,2) NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_lot_remaining CHECK (qty_remaining >= 0
                                     AND qty_remaining <= qty_received)
);
CREATE INDEX idx_lots_sku ON stock_lots (shop_id, sku_id, received_at)
  WHERE qty_remaining > 0;
CALL apply_tenant_rls('stock_lots');


-- -----------------------------------------------------------------------------
-- The ledger
-- -----------------------------------------------------------------------------
-- Append-only. Nothing in this table is ever updated or deleted; a mistake is
-- corrected by a compensating row, the same way a cash book works.

CREATE TABLE stock_moves (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  sku_id       uuid NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  lot_id       uuid REFERENCES stock_lots(id) ON DELETE RESTRICT,
  -- Every physical part has to be traceable to the shop it was bought from.
  supplier_id  uuid,  -- FK added in 0007

  -- receipt   ของเข้า          reserve   จองตอนลูกค้าอนุมัติ
  -- unreserve คืนของที่จอง     issue     ตัดจริงตอน office จ่ายของออกหน้าห้อง
  -- return    ลูกค้าคืน/ยกเลิก  adjustment ปรับมือ (ต้องมีเหตุผลเสมอ)
  -- count     ปรับจากการตรวจนับ transfer_out / transfer_in ระหว่างสาขา
  type         text NOT NULL CHECK (type IN (
                 'receipt', 'reserve', 'unreserve', 'issue', 'return',
                 'adjustment', 'count', 'transfer_out', 'transfer_in')),
  -- Signed. A receipt is positive, an issue negative; the balance is their sum.
  qty          numeric(12,2) NOT NULL,
  -- The cost in force at this moment, frozen onto the row. Without this, last
  -- month's margin changes every time a new delivery arrives at a new price.
  unit_cost    numeric(12,4),

  ref_type     text,
  ref_id       uuid,
  ref_line_id  uuid,

  -- {ref_type}:{ref_id}:{ref_line_id}:{type}. A double-tapped button, a retry
  -- after a timeout and a resend from the offline outbox all produce the same
  -- key and therefore one row.
  idempotency_key text NOT NULL,

  -- Mandatory for adjustments. Free text, not a dropdown alone: the reason that
  -- matters is never in the list.
  reason       text,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_stock_move_key UNIQUE (shop_id, idempotency_key),
  CONSTRAINT ck_adjustment_reason CHECK (type <> 'adjustment' OR reason IS NOT NULL),
  CONSTRAINT ck_qty_nonzero CHECK (qty <> 0)
);
CREATE INDEX idx_moves_sku ON stock_moves (shop_id, sku_id, created_at DESC);
CREATE INDEX idx_moves_ref ON stock_moves (shop_id, ref_type, ref_id);
-- The owner's daily "who adjusted what by hand" report.
CREATE INDEX idx_moves_adjustments ON stock_moves (shop_id, created_at DESC)
  WHERE type = 'adjustment';
CALL apply_tenant_rls('stock_moves');

-- The ledger is history. History does not get edited.
CREATE OR REPLACE FUNCTION stock_moves_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_moves is append-only; post a compensating move instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_moves_no_update BEFORE UPDATE OR DELETE ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION stock_moves_append_only();


-- -----------------------------------------------------------------------------
-- Balances
-- -----------------------------------------------------------------------------
-- A cache, always reproducible from stock_moves. There is a job that replays
-- the ledger and reports drift; if it can ever drift silently the design is
-- wrong, not the job.

CREATE TABLE stock_balances (
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  sku_id      uuid NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  on_hand     numeric(12,2) NOT NULL DEFAULT 0,
  reserved    numeric(12,2) NOT NULL DEFAULT 0,
  -- Moving average. Changes on receipt only, never on issue.
  avg_cost    numeric(12,4) NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (shop_id, sku_id),
  -- Stock that is not there is a shortfall on the document, never a negative
  -- balance here.
  CONSTRAINT ck_on_hand_nonneg CHECK (on_hand >= 0),
  CONSTRAINT ck_reserved_nonneg CHECK (reserved >= 0)
);
CALL apply_tenant_rls('stock_balances');

-- available = on_hand - reserved. This is what any "do we have it?" screen
-- reads, and it is a view so the subtraction cannot be forgotten in one query
-- and remembered in another.
-- security_invoker: without it the view runs as its owner and the base tables'
-- RLS is skipped, which would let any shop read every shop's balances.
CREATE VIEW stock_available WITH (security_invoker = true) AS
  SELECT shop_id, sku_id, on_hand, reserved,
         on_hand - reserved AS available,
         avg_cost
  FROM stock_balances;

-- Balance rows are locked with SELECT ... FOR UPDATE inside the same
-- transaction as the move that changes them. Reading, computing and writing
-- back outside a lock is how two technicians drawing the same part end up
-- deducting one.


-- -----------------------------------------------------------------------------
-- Shortfall follow-up
-- -----------------------------------------------------------------------------
-- Approval is never blocked for want of stock. What exists is reserved, the
-- rest becomes a line on the buying list and the work order says "รออะไหล่".

CREATE TABLE purchase_suggestions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  sku_id           uuid NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  document_line_id uuid REFERENCES document_lines(id) ON DELETE SET NULL,
  qty_needed       numeric(12,2) NOT NULL,
  -- shortfall = a customer is waiting. reorder_point = the shelf is getting low.
  origin           text NOT NULL DEFAULT 'shortfall'
                   CHECK (origin IN ('shortfall', 'reorder_point')),
  status           text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'ordered', 'done', 'cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX idx_suggestions_open ON purchase_suggestions (shop_id, created_at)
  WHERE status = 'open';
CALL apply_tenant_rls('purchase_suggestions');


-- -----------------------------------------------------------------------------
-- Stock counts
-- -----------------------------------------------------------------------------

CREATE TABLE stock_counts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'posted', 'cancelled')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  posted_at    timestamptz,
  posted_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
CALL apply_tenant_rls('stock_counts');

CREATE TABLE stock_count_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  stock_count_id  uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  sku_id          uuid NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  -- What the system thought, captured when the count sheet was printed.
  expected_qty    numeric(12,2) NOT NULL,
  counted_qty     numeric(12,2),
  variance        numeric(12,2) GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
  note            text,

  CONSTRAINT uq_count_line UNIQUE (stock_count_id, sku_id)
);
CREATE INDEX idx_count_lines_variance ON stock_count_lines (stock_count_id)
  WHERE counted_qty IS NOT NULL AND counted_qty <> expected_qty;
CALL apply_tenant_rls('stock_count_lines');

-- Posting a count writes one 'count' move per line with a variance, which is
-- how the adjustment stays visible in the ledger instead of a quantity being
-- quietly overwritten.
