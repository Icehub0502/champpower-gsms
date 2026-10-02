-- =============================================================================
-- 0021_quote_lines.sql — quotation line columns: sets, catalog link, price
--                        provenance, warranty NAME snapshot, agreed amount
--
-- WHAT:     document_lines gains (all nullable, no defaults):
--             parent_line_id    a set child points at its set header, in the
--                               SAME document (composite FK, not a convention)
--             catalog_item_id   which catalog item the line came from
--             list_price        the catalog price when the line was added
--             price_source      model | base | manual
--             price_ref_id      the catalog_model_prices row (or item) it came
--                               from; no FK on purpose (polymorphic)
--             decided_by        who recorded the customer's decision
--             warranty_name     the term's name AS SOLD, snapshot, never re-read
--             approved_amount   the agreed price of a set that had pieces cut
--           and:
--             decline_reason accepts 'chose_alternative' (owner decision D13)
--             unit_price >= 0 is enforced (owner decision D2)
--             a trigger keeps the tree one level deep (header -> children)
--             a tenant-safe (shop_id, warranty_term_id) FK, on top of 0010's
--             plain one — see WHY
--
--           warranty_term_id, warranty_days and warranty_max_km are NOT added
--           here — migration 0010 already added them to document_lines (for
--           exactly this purpose, the per-line warranty pick). Only the name
--           snapshot was missing; see the ROLLBACK note on why this file does
--           not touch them beyond that one column and the new CHECK.
--
-- WHY:      See P3.1-TECH-PLAN-v3. Sets are the best seller and the old system
--           stored them as unlinked flat rows, which is how a set was priced
--           twice and how the customer's decision on it was lost. A snapshot
--           per line is how a later warranty edit cannot change a sold line —
--           0010 snapshots days/max_km but not the term's NAME, so a renamed
--           term would still change what an old quotation prints; warranty_name
--           closes that. approved_amount is how "customer dropped one piece of
--           a set" is priced by a person rather than guessed by the system
--           (D10).
--
--           0010's `document_lines.warranty_term_id uuid REFERENCES
--           warranty_terms(id) ON DELETE SET NULL` has no shop_id in it, so as
--           written it is a cross-shop hole: nothing stops shop A's line from
--           pointing at shop B's term. 0020 adds the (shop_id, id) unique key
--           warranty_terms needed to close this. This file adds the SECOND,
--           tenant-safe FK (shop_id, warranty_term_id) -> warranty_terms
--           (shop_id, id) alongside 0010's; it does not drop 0010's FK (an
--           already-applied migration is never edited, CLAUDE.md §11),
--           but every INSERT/UPDATE from this point on is checked by both.
--
-- ROLLBACK: (run as postgres, in one transaction, after exporting the columns;
--           see packages/db/README.md "Rolling back a migration")
--             DROP TRIGGER trg_document_lines_parent_top_level ON document_lines;
--             DROP FUNCTION document_lines_parent_top_level();
--             ALTER TABLE document_lines
--               DROP CONSTRAINT fk_doc_lines_warranty_term_shop,
--               DROP CONSTRAINT ck_lines_unit_price_nonneg,
--               DROP CONSTRAINT ck_lines_approved_amount_top,
--               DROP CONSTRAINT ck_lines_warranty_snapshot,
--               DROP COLUMN approved_amount, DROP COLUMN warranty_name,
--               DROP COLUMN decided_by, DROP COLUMN price_ref_id,
--               DROP COLUMN price_source, DROP COLUMN list_price,
--               DROP COLUMN catalog_item_id, DROP COLUMN parent_line_id;
--             ALTER TABLE document_lines DROP CONSTRAINT uq_doc_lines_document_id;
--             -- put the old CHECK back. If any row already uses
--             -- 'chose_alternative' it must be decided another way first:
--             ALTER TABLE document_lines DROP CONSTRAINT document_lines_decline_reason_check;
--             ALTER TABLE document_lines ADD CONSTRAINT document_lines_decline_reason_check
--               CHECK (decline_reason IN ('too_expensive','next_time','going_elsewhere',
--                                         'not_needed_yet','other'));
--             DELETE FROM schema_migrations WHERE filename = '0021_quote_lines.sql';
--           warranty_term_id / warranty_days / warranty_max_km are 0010's
--           columns and are NOT dropped here.
--
--           Before any of the above, export what this migration's own columns
--           hold (the rollback checklist in packages/db/README.md says export
--           first; this is the actual command, not just the instruction to
--           run one):
--             \copy (SELECT id, document_id, parent_line_id, catalog_item_id,
--                      list_price, price_source, price_ref_id, decided_by,
--                      warranty_name, approved_amount, decline_reason
--                      FROM document_lines
--                     WHERE parent_line_id IS NOT NULL OR catalog_item_id IS NOT NULL
--                        OR list_price IS NOT NULL OR price_source IS NOT NULL
--                        OR price_ref_id IS NOT NULL OR decided_by IS NOT NULL
--                        OR warranty_name IS NOT NULL OR approved_amount IS NOT NULL
--                        OR decline_reason = 'chose_alternative')
--               TO 'document_lines_0021_columns.csv' CSV HEADER
--           This is 0021's own rollback; rolling back the three P3.1 files
--           together is always in the order 0022 -> 0021 -> 0020 (0022's
--           triggers reference columns and tables 0021/0020 added, and 0021's
--           FKs reference 0020's tables — each must come off before the one
--           underneath it).
--
-- LOCKS:    The runner wraps this whole file in ONE transaction, so every lock
--           below is held until COMMIT — "VALIDATE only needs SHARE UPDATE
--           EXCLUSIVE" does NOT mean reads and writes continue during this
--           migration: the ACCESS EXCLUSIVE taken by the ADD COLUMN / ADD
--           CONSTRAINT ... NOT VALID statements earlier in this SAME
--           transaction is already held on document_lines and is not released
--           (and does not downgrade) until the transaction commits. Concretely:
--             1. ADD CONSTRAINT uq_doc_lines_document_id UNIQUE, and the block
--                of ADD COLUMN statements: catalogue-only, no table rewrite
--                (no defaults), but each is ACCESS EXCLUSIVE on document_lines
--                for its instant.
--             2. ADD CONSTRAINT ... NOT VALID (the two new FKs, every CHECK,
--                and the decline_reason swap): also ACCESS EXCLUSIVE, briefly,
--                to add the constraint to the catalog.
--             3. VALIDATE CONSTRAINT (each one): a sequential scan of
--                document_lines. Its OWN required lock is SHARE UPDATE
--                EXCLUSIVE, which on its own would let other sessions read and
--                write — but it does not get to apply on its own, because step
--                1's ACCESS EXCLUSIVE is still held from earlier in this same
--                transaction. So for the full duration of this migration,
--                document_lines is UNAVAILABLE to every other session, for as
--                long as the VALIDATE scans take (document_lines on the dev
--                database: 0 rows as applied — the scans are instant there;
--                this is the shape to worry about once real quotations exist).
--           Run outside shop hours regardless, and re-time this file on a copy
--           of production-sized data before running it against a shop with
--           real quotations.
-- =============================================================================

-- Target for the same-document composite FK below.
ALTER TABLE document_lines ADD CONSTRAINT uq_doc_lines_document_id UNIQUE (document_id, id);

ALTER TABLE document_lines
  ADD COLUMN parent_line_id   uuid,
  ADD COLUMN catalog_item_id  uuid,
  ADD COLUMN list_price       numeric(12,2),
  ADD COLUMN price_source     text,
  ADD COLUMN price_ref_id     uuid,
  ADD COLUMN decided_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- warranty_term_id / warranty_days / warranty_max_km already exist (0010).
  ADD COLUMN warranty_name    text,
  ADD COLUMN approved_amount  numeric(12,2);

-- A set child lives in the same quotation as its header. ON DELETE CASCADE: a
-- child means nothing without its header (CLAUDE.md §11), and the freeze
-- trigger (0022) only allows deleting lines of a draft anyway.
ALTER TABLE document_lines
  ADD CONSTRAINT fk_doc_lines_parent FOREIGN KEY (document_id, parent_line_id)
    REFERENCES document_lines (document_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT fk_doc_lines_catalog_item FOREIGN KEY (shop_id, catalog_item_id)
    REFERENCES catalog_items (shop_id, id) ON DELETE RESTRICT NOT VALID,
  -- Tenant-safe companion to 0010's plain (warranty_term_id) FK — see WHY.
  ADD CONSTRAINT fk_doc_lines_warranty_term_shop FOREIGN KEY (shop_id, warranty_term_id)
    REFERENCES warranty_terms (shop_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE document_lines VALIDATE CONSTRAINT fk_doc_lines_parent;
ALTER TABLE document_lines VALIDATE CONSTRAINT fk_doc_lines_catalog_item;
ALTER TABLE document_lines VALIDATE CONSTRAINT fk_doc_lines_warranty_term_shop;

ALTER TABLE document_lines
  ADD CONSTRAINT ck_lines_not_own_parent CHECK (parent_line_id IS NULL OR parent_line_id <> id) NOT VALID,
  ADD CONSTRAINT ck_lines_list_price_nonneg CHECK (list_price IS NULL OR list_price >= 0) NOT VALID,
  ADD CONSTRAINT ck_lines_price_source CHECK (price_source IS NULL OR price_source IN ('model', 'base', 'manual')) NOT VALID,
  -- Free (0) is allowed; negative never (owner decision D2).
  ADD CONSTRAINT ck_lines_unit_price_nonneg CHECK (unit_price >= 0) NOT VALID,
  -- The agreed amount belongs to a set HEADER only, and is never negative. The
  -- 2x ceiling is the API's rule (checkApprovedAmount), not a table constraint:
  -- a revision can legitimately price a set higher.
  ADD CONSTRAINT ck_lines_approved_amount_top CHECK (
    approved_amount IS NULL OR (approved_amount >= 0 AND parent_line_id IS NULL)) NOT VALID,
  -- The snapshot travels as a unit: name and term_id together or neither;
  -- days/max_km only alongside a name, at least one of them when there is one,
  -- both positive when present. Matches warranty_terms' own ck_term_has_limit.
  ADD CONSTRAINT ck_lines_warranty_snapshot CHECK (
    (warranty_name IS NULL) = (warranty_term_id IS NULL)
    AND (warranty_days IS NULL OR warranty_name IS NOT NULL)
    AND (warranty_max_km IS NULL OR warranty_name IS NOT NULL)
    AND (warranty_name IS NULL OR warranty_days IS NOT NULL OR warranty_max_km IS NOT NULL)
    AND (warranty_days IS NULL OR warranty_days > 0)
    AND (warranty_max_km IS NULL OR warranty_max_km > 0)) NOT VALID;
ALTER TABLE document_lines VALIDATE CONSTRAINT ck_lines_not_own_parent;
ALTER TABLE document_lines VALIDATE CONSTRAINT ck_lines_list_price_nonneg;
ALTER TABLE document_lines VALIDATE CONSTRAINT ck_lines_price_source;
ALTER TABLE document_lines VALIDATE CONSTRAINT ck_lines_unit_price_nonneg;
ALTER TABLE document_lines VALIDATE CONSTRAINT ck_lines_approved_amount_top;
ALTER TABLE document_lines VALIDATE CONSTRAINT ck_lines_warranty_snapshot;

-- decline_reason: add chose_alternative (D13). Same NOT VALID + VALIDATE swap.
ALTER TABLE document_lines DROP CONSTRAINT document_lines_decline_reason_check;
ALTER TABLE document_lines ADD CONSTRAINT document_lines_decline_reason_check
  CHECK (decline_reason IN ('too_expensive', 'next_time', 'going_elsewhere',
                            'not_needed_yet', 'other', 'chose_alternative')) NOT VALID;
ALTER TABLE document_lines VALIDATE CONSTRAINT document_lines_decline_reason_check;

-- One level only: a child's parent must itself be a header. A grandchild would
-- be invisible to the totals (which count top-level lines) and to the work
-- order. A CHECK cannot look at another row, so this is a trigger.
--
-- Both EXISTS checks below carry `document_id = NEW.document_id` even though
-- `id` and `parent_line_id` are already unique/looked-up by other means,
-- because the SECOND check's actual query plan depends on it: without that
-- predicate, `c.parent_line_id = NEW.id` alone has no matching index (the
-- real index, idx_doc_lines_parent, is on (document_id, parent_line_id)) and
-- the planner falls back to a scan of every line in the SHOP, not just this
-- document. EXPLAIN of that exact query, on the scratch data (one document
-- with ~20-23 lines out of 20,010 lines for the shop):
--
-- Measured on the scratch data (packages/db/bench/): one document with a set
-- header that has 6 children, out of 20,010 lines for that shop.
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT 1 FROM document_lines c
--    WHERE c.parent_line_id = '<the header's id>'
--      AND c.document_id = '<that header's document_id>';
--
--   Index Scan using idx_doc_lines_parent on document_lines c
--     (cost=0.29..8.34 rows=1 width=4) (actual time=0.041..0.042 rows=0 loops=1)
--     Index Cond: ((document_id = ...) AND (parent_line_id = ...))
--   Planning Time: 2.193 ms
--   Execution Time: 0.089 ms
--
-- The SAME query with the document_id predicate removed (what the trigger ran
-- before this fix), on the identical data:
--
--   Bitmap Heap Scan on document_lines c
--     (cost=378.99..540.28 rows=1 width=4) (actual time=0.510..0.510 rows=0 loops=1)
--     Recheck Cond: (parent_line_id = ...)
--     ->  Bitmap Index Scan on idx_doc_lines_parent
--           (cost=0.00..378.99 rows=50 width=0) (actual time=0.495..0.495 rows=6 loops=1)
--   Execution Time: 0.605 ms
--
-- idx_doc_lines_parent is still the index used either way — it is the only
-- index touching parent_line_id — but without document_id in the condition it
-- can only be entered as a wide bitmap scan (cost 378 vs 8, ~7x slower here at
-- 20,010 rows; the gap widens with more lines per shop, not per document).
CREATE OR REPLACE FUNCTION document_lines_parent_top_level() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_line_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM document_lines p
        WHERE p.id = NEW.parent_line_id
          AND p.document_id = NEW.document_id
          AND p.parent_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a set line cannot have a set line as its parent'
      USING ERRCODE = '23514', TABLE = 'document_lines', CONSTRAINT = 'ck_lines_one_level';
  END IF;
  -- A header that already has children must not become a child itself.
  IF NEW.parent_line_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM document_lines c
        WHERE c.parent_line_id = NEW.id
          AND c.document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'a set header with children cannot become a child'
      USING ERRCODE = '23514', TABLE = 'document_lines', CONSTRAINT = 'ck_lines_one_level';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_document_lines_parent_top_level
  BEFORE INSERT OR UPDATE OF parent_line_id ON document_lines
  FOR EACH ROW EXECUTE FUNCTION document_lines_parent_top_level();

-- Lines of one catalog item, newest first: "most used items" in the search box
-- and the merge report. Partial: free-text lines have no item.
CREATE INDEX idx_doc_lines_catalog_item ON document_lines (shop_id, catalog_item_id)
  WHERE catalog_item_id IS NOT NULL;
-- Children of a header.
CREATE INDEX idx_doc_lines_parent ON document_lines (document_id, parent_line_id)
  WHERE parent_line_id IS NOT NULL;
