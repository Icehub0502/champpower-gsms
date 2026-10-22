-- =============================================================================
-- 0028_stock_wiring.sql — WO-006: connect the selling catalog to the stock SKUs,
--                         tenant-safe SKU references, and the ledger columns the
--                         stock card needs
--
-- WHAT:     1. skus
--                UNIQUE (shop_id, id)       composite-FK target (same trick as 0020/0021)
--                legacy_source, legacy_id   where an imported SKU came from (WO-004), so the
--                                           import is re-runnable: update by legacy key, never
--                                           a second row
--                legacy_had_stock           the prototype showed qty > 0 for this part. A SORT
--                                           HINT for the count screen (319 of 512 first) and
--                                           nothing else: NULL = not from the prototype. The
--                                           quantity itself is NEVER imported (Ice).
--           2. catalog_items.sku_id         which stock SKU a sellable part IS. Composite FK
--                                           (shop_id, sku_id) -> skus(shop_id, id). A part with
--                                           no sku_id is sellable but not stock-controlled.
--                                           CHECK: labor / fee rows never carry one (s5.2).
--           3. stock_moves
--                on_hand_after, reserved_after   the balance AFTER this move, written in the same
--                                                statement as the balance it describes (row is
--                                                locked). The stock card shows "was -> became"
--                                                from these and the integrity check compares the
--                                                latest one with the balance row.
--                ck_qty_nonzero relaxed for type 'count': counting a part and finding exactly the
--                                                number the system said (or finding ZERO on a part
--                                                nobody ever counted) is an event worth a ledger
--                                                row; "counted, found 0" is the ONLY way a SKU
--                                                becomes counted at zero (WO-006 s2, criterion 8).
--                ck_move_sign                    receipt/reserve/return/transfer_in > 0,
--                                                unreserve/issue/transfer_out < 0. The database
--                                                net under the domain's front gate (s4.y).
--                idx_moves_line                  moves of one document line (issue list, release).
--           4. composite (shop_id, sku_id) FKs on stock_moves, stock_balances, document_lines,
--              purchase_suggestions, on top of 0006's plain ones: a bug that wrote shop B's SKU
--              id into shop A's ledger would be accepted by a plain FK (it runs as table owner).
--           5. uq_suggestion_open_per_line   one open shortfall suggestion per document line, so
--                                           a replayed confirm cannot stack suggestions.
--
-- SIGN CONVENTION (the whole module relies on it; it is also in packages/domain stock.ts):
--           on_hand  = SUM(qty) over type IN (receipt, issue, return, adjustment, count,
--                      transfer_in, transfer_out)
--           reserved = SUM(qty) over type IN (reserve, unreserve)      reserve > 0, unreserve < 0
--           A shortfall is NEVER a negative reservation or a negative on_hand (CLAUDE.md s6.6).
--
-- WHY not just sku_id on document_lines? It already exists (0004/0006) and is filled at ISSUE
--           time of the quotation from catalog_items.sku_id (a snapshot, frozen with the line).
--           catalog_items is the one place the link is made.
--
-- NEW SQLSTATE: none.
--
-- ROLLBACK: (as postgres, one transaction, after a backup and after rolling the API back; the
--           stock_moves columns lose their data)
--             ALTER TABLE purchase_suggestions DROP CONSTRAINT fk_suggestions_sku_shop;
--             DROP INDEX uq_suggestion_open_per_line;
--             ALTER TABLE document_lines DROP CONSTRAINT fk_doc_lines_sku_shop;
--             ALTER TABLE stock_balances DROP CONSTRAINT fk_stock_balances_sku_shop;
--             ALTER TABLE stock_moves DROP CONSTRAINT fk_stock_moves_sku_shop;
--             DROP INDEX idx_moves_line;
--             ALTER TABLE stock_moves DROP CONSTRAINT ck_move_sign;
--             ALTER TABLE stock_moves DROP CONSTRAINT ck_qty_nonzero;
--             ALTER TABLE stock_moves ADD CONSTRAINT ck_qty_nonzero CHECK (qty <> 0);
--                 -- fails if a zero-qty count row exists: delete none, instead keep this
--                 -- migration and roll forward (the ledger is append-only).
--             ALTER TABLE stock_moves DROP COLUMN reserved_after, DROP COLUMN on_hand_after;
--             DROP INDEX idx_catalog_items_sku;
--             ALTER TABLE catalog_items DROP CONSTRAINT ck_catalog_sku_part_only,
--                                       DROP CONSTRAINT fk_catalog_items_sku,
--                                       DROP COLUMN sku_id;
--             DROP INDEX uq_skus_legacy;
--             ALTER TABLE skus DROP CONSTRAINT ck_skus_legacy_pair,
--                              DROP COLUMN legacy_had_stock, DROP COLUMN legacy_id,
--                              DROP COLUMN legacy_source,
--                              DROP CONSTRAINT uq_skus_shop_id;
--             DELETE FROM schema_migrations WHERE filename = '0028_stock_wiring.sql';
--
-- LOCKS:    ADD COLUMN without DEFAULT is catalog-only on PG 16. ADD UNIQUE builds an index under
--           SHARE lock on skus (hundreds of rows). Every FK / CHECK on a busy table is added
--           NOT VALID and validated afterwards (VALIDATE takes only SHARE UPDATE EXCLUSIVE), so
--           the ACCESS EXCLUSIVE window is the catalog change alone. stock_moves, stock_balances
--           and purchase_suggestions are empty before WO-006 ships. Run outside shop hours anyway.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. skus
-- -----------------------------------------------------------------------------
ALTER TABLE skus ADD CONSTRAINT uq_skus_shop_id UNIQUE (shop_id, id);

ALTER TABLE skus
  ADD COLUMN legacy_source    text,
  ADD COLUMN legacy_id        text,
  ADD COLUMN legacy_had_stock boolean;

ALTER TABLE skus ADD CONSTRAINT ck_skus_legacy_pair
  CHECK ((legacy_source IS NULL) = (legacy_id IS NULL));

CREATE UNIQUE INDEX uq_skus_legacy ON skus (shop_id, legacy_source, legacy_id)
  WHERE legacy_source IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 2. catalog_items.sku_id
-- -----------------------------------------------------------------------------
ALTER TABLE catalog_items ADD COLUMN sku_id uuid;

ALTER TABLE catalog_items ADD CONSTRAINT fk_catalog_items_sku
  FOREIGN KEY (shop_id, sku_id) REFERENCES skus (shop_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE catalog_items VALIDATE CONSTRAINT fk_catalog_items_sku;

ALTER TABLE catalog_items ADD CONSTRAINT ck_catalog_sku_part_only
  CHECK (line_type = 'part' OR sku_id IS NULL) NOT VALID;
ALTER TABLE catalog_items VALIDATE CONSTRAINT ck_catalog_sku_part_only;

CREATE INDEX idx_catalog_items_sku ON catalog_items (shop_id, sku_id) WHERE sku_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 3. stock_moves
-- -----------------------------------------------------------------------------
ALTER TABLE stock_moves
  ADD COLUMN on_hand_after numeric(12,2),
  ADD COLUMN reserved_after numeric(12,2);

ALTER TABLE stock_moves DROP CONSTRAINT ck_qty_nonzero;
ALTER TABLE stock_moves ADD CONSTRAINT ck_qty_nonzero
  CHECK (qty <> 0 OR type = 'count') NOT VALID;
ALTER TABLE stock_moves VALIDATE CONSTRAINT ck_qty_nonzero;

ALTER TABLE stock_moves ADD CONSTRAINT ck_move_sign CHECK (
     (type IN ('receipt', 'reserve', 'return', 'transfer_in') AND qty > 0)
  OR (type IN ('unreserve', 'issue', 'transfer_out') AND qty < 0)
  OR type IN ('adjustment', 'count')
) NOT VALID;
ALTER TABLE stock_moves VALIDATE CONSTRAINT ck_move_sign;

CREATE INDEX idx_moves_line ON stock_moves (shop_id, ref_line_id) WHERE ref_line_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 4. tenant-safe SKU references
-- -----------------------------------------------------------------------------
ALTER TABLE stock_moves ADD CONSTRAINT fk_stock_moves_sku_shop
  FOREIGN KEY (shop_id, sku_id) REFERENCES skus (shop_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE stock_moves VALIDATE CONSTRAINT fk_stock_moves_sku_shop;

ALTER TABLE stock_balances ADD CONSTRAINT fk_stock_balances_sku_shop
  FOREIGN KEY (shop_id, sku_id) REFERENCES skus (shop_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE stock_balances VALIDATE CONSTRAINT fk_stock_balances_sku_shop;

-- MATCH SIMPLE: a line with no sku_id is not checked, which is exactly right.
ALTER TABLE document_lines ADD CONSTRAINT fk_doc_lines_sku_shop
  FOREIGN KEY (shop_id, sku_id) REFERENCES skus (shop_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE document_lines VALIDATE CONSTRAINT fk_doc_lines_sku_shop;

ALTER TABLE purchase_suggestions ADD CONSTRAINT fk_suggestions_sku_shop
  FOREIGN KEY (shop_id, sku_id) REFERENCES skus (shop_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE purchase_suggestions VALIDATE CONSTRAINT fk_suggestions_sku_shop;


-- -----------------------------------------------------------------------------
-- 5. one open shortfall suggestion per document line
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX uq_suggestion_open_per_line ON purchase_suggestions (shop_id, document_line_id)
  WHERE origin = 'shortfall' AND status = 'open' AND document_line_id IS NOT NULL;
