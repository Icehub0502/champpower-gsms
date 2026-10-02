-- =============================================================================
-- 0020_catalog.sql — selling-price catalog, set components, per-car-model
--                    prices, and the car -> controlled model link
--
-- WHAT:     1. price_key(text): the ONE normaliser for brand / model / item
--              names (NFKC, lower case, no whitespace / dashes / zero-width).
--              packages/domain priceKey() must give the same answer.
--           2. catalog_items: what the shop sells, axis category -> item.
--              base_price NULL = nobody has priced it yet (0 is a deliberate
--              free price). merged_into_id supports merging duplicates.
--              warranty_term_id reuses `warranty_terms` from migration 0010 —
--              see the note below, this file does NOT create that table.
--           3. catalog_set_components: what a set expands into.
--           4. catalog_model_prices: the standard price of an item for one
--              CONTROLLED car model (vehicle_models), layered over base_price.
--           5. vehicles.vehicle_model_id: links a car to a controlled model.
--              Nullable; the typed brand / model text stays as the evidence.
--           6. UNIQUE (shop_id, id) on vehicle_models AND on warranty_terms
--              (0010 created neither), so composite foreign keys can force
--              "same shop" on both (see DESIGN NOTE).
--
-- WHY:      Production has no selling-price table at all (products.price is
--           COST; quote_part_prices is 99.99% empty). Staff typed every price.
--           The catalog starts empty and fills from real work: the first price
--           typed for an item on a car model becomes that model's standard
--           price (owner decision 12). Keys are vehicle_model_id, not free
--           text, because staff typed 36 spellings of brand in vehicles, 13 of
--           which are not in the controlled list; a price filed under
--           'Chevloret' would never be found (REVIEW-COWORK-v2 R2).
--
--           NOTE — warranty_terms already exists. Migration 0010 created
--           `warranty_terms (id, shop_id, name, days, max_km, is_active,
--           sort_order)` and `document_lines.warranty_term_id / warranty_days /
--           warranty_max_km` for the per-sold-item warranty. P3.1's catalog
--           reuses the SAME table and the SAME columns on document_lines —
--           there is no second warranty concept here, only a selling catalog
--           that points at the terms 0010 already modelled. 0021 adds just the
--           one thing 0010 does not have: a NAME snapshot on the line.
--
--           DESIGN NOTE — same-shop foreign keys. A plain REFERENCES check
--           runs as the table owner and ignores RLS, so a bug that wrote shop
--           B's item id into shop A's row would be accepted. Every reference
--           between two tenant tables here is therefore COMPOSITE
--           (shop_id, x_id) -> parent(shop_id, id): the database itself
--           refuses a cross-shop link.
--
--           DESIGN NOTE — search. Staff type 2-3 characters of a Thai name
--           (no word breaks) and expect hits anywhere in the name, which a
--           btree cannot serve. With ~300 items per shop a filtered scan of
--           that shop's rows is the plan the planner picks anyway and a
--           trigram index was never used on the synthetic data; see the
--           measurements below. No pg_trgm index is added. If a shop ever
--           holds tens of thousands of items, add one then, with a new file.
--
-- ROLLBACK: Roll the three P3.1 files back together, in the order
--           0022 -> 0021 -> 0020 (0021's FKs point into this file's tables;
--           0022's triggers cover columns 0021 added — each must come off
--           before the one underneath it). For this file, as postgres, in
--           one transaction (packages/db/README.md "Rolling back a
--           migration"):
--
--           First, export what this migration's tables hold — the data is
--           gone once DROP TABLE runs:
--             \copy (SELECT id, category, name, line_type, unit, default_qty,
--                      warranty_term_id, is_set, base_price, is_active,
--                      merged_into_id FROM catalog_items)
--               TO 'catalog_items.csv' CSV HEADER
--             \copy (SELECT id, set_item_id, component_item_id, component_name,
--                      line_type, qty, sort_order FROM catalog_set_components)
--               TO 'catalog_set_components.csv' CSV HEADER
--             \copy (SELECT id, item_id, vehicle_model_id, price, set_by, set_at
--                      FROM catalog_model_prices)
--               TO 'catalog_model_prices.csv' CSV HEADER
--             \copy (SELECT id, vehicle_model_id FROM vehicles
--                     WHERE vehicle_model_id IS NOT NULL)
--               TO 'vehicles_model_links.csv' CSV HEADER
--
--           Then:
--             ALTER TABLE vehicles DROP COLUMN vehicle_model_id;
--             -- idx_vehicle_models_keys is an expression index that calls
--             -- price_key(); it must go before the function does, or
--             -- DROP FUNCTION fails on a dependent object.
--             DROP INDEX idx_vehicle_models_keys;
--             ALTER TABLE vehicle_models DROP CONSTRAINT uq_vehicle_models_shop_id;
--             ALTER TABLE warranty_terms DROP CONSTRAINT uq_warranty_terms_shop_id;
--             -- catalog_items' generated columns (category_key, name_key) and
--             -- catalog_model_prices/catalog_set_components also depend on
--             -- price_key(); dropping the tables removes those dependents too.
--             DROP TABLE catalog_model_prices, catalog_set_components, catalog_items;
--             DROP FUNCTION price_key(text);
--             DELETE FROM schema_migrations WHERE filename = '0020_catalog.sql';
--           Anything that already references catalog_items from
--           document_lines (0021) must be rolled back first (hence the file
--           order above). warranty_terms itself is 0010's table and is NOT
--           dropped here — only the unique key this file added to it.
--
-- LOCKS:    ALTER TABLE vehicles ADD COLUMN (nullable, no default) and ADD
--           CONSTRAINT FK: a brief ACCESS EXCLUSIVE for the column, then a
--           SHARE ROW EXCLUSIVE while the FK validates (every row is NULL, so
--           the validation scans but finds nothing to check). The two ADD
--           UNIQUE statements (vehicle_models, warranty_terms) each build an
--           index under a SHARE lock over a small table (hundreds of rows).
--           Everything else creates new tables. Run outside shop hours anyway.
--
-- MEASUREMENTS — EXPLAIN (ANALYZE, BUFFERS), role gsms_app, SET LOCAL
-- app.current_shop_id (inside an explicit BEGIN/COMMIT — SET LOCAL with no
-- transaction evaporates before the next statement), on a scratch database
-- cloned from a dev database carrying 0001-0021 (never run against `gsms`).
-- Synthetic data: 2 shops x 300 catalog items (154 sets x 6 components =
-- 1,848 component rows), 632 vehicle models, 64,320 model-price rows (536
-- models x 60 items x 2 shops), 10,002 vehicles, 1,740 quotations, 40,020
-- document lines. Reproduce with packages/db/bench/ (scratch only).
--
--   catalog search (name ILIKE, this shop)        Seq Scan, 300 rows, 0.7 ms
--   catalog search (sets-first ranking)            Seq Scan, 300 rows, 2.3 ms
--   price lookup, one item x one model             Index Scan on uq_model_prices
--   set expansion (6 components of one set)        Bitmap on idx_set_components_set, 0.6 ms
--   document lines of one quotation (~23 lines)     Bitmap on idx_doc_lines_document, 2.7 ms
--   children of a set header, within one document   Index Scan on idx_doc_lines_parent, 5.2 ms
--   lines of one catalog item, newest first (merge)  Index Scan on idx_doc_lines_catalog_item, 1.1 ms
--   vehicle -> controlled model (brand+model text)   Bitmap on idx_vehicle_models_keys, 2.7 ms
--   all model prices of one item (merge conflicts)   Bitmap on idx_model_prices_item, 1.4 ms
--   cross-shop probe (shop A session, shop B id)      0 rows, as required
--
-- At this scale (hundreds of catalog items, ~632 models) the planner picks a
-- Seq Scan for name search over either table, confirming the DESIGN NOTE
-- above: no pg_trgm index yet. Every lookup keyed by (shop_id, parent/item/
-- document) uses its intended index. All ten queries ran under 6 ms.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. price_key
-- -----------------------------------------------------------------------------
-- Mirrors KEY_STRIP / asciiLower in packages/domain/src/rules/catalogItems.ts
-- EXACTLY. Two deliberate departures from the obvious SQL -- both because the
-- obvious version is NOT deterministic across clusters, which an IMMUTABLE
-- function must be (migration-safety finding: on this dev cluster, locale
-- Thai_Thailand.874, lower() on an accented capital is a no-op, while JS
-- .toLowerCase() folds it -- the two sides would key Citroen/Skoda-style
-- names differently, and a restore onto a cluster with a different locale
-- would change the keys again):
--
--   1. ASCII-ONLY case fold via translate(), never lower(). lower() consults
--      LC_CTYPE; translate() maps the 26 fixed characters A-Z to a-z and
--      nothing else, on any cluster. A non-ASCII letter (an accented Latin
--      letter, or a Turkish dotted/dotless I) is left exactly as typed,
--      matching asciiLower() on the domain side.
--   2. The removed character class is built from chr(<decimal code point>)
--      calls, concatenated at call time -- never a literal backslash-u escape
--      or a backslash-s class in the SQL source. Backslash-s and POSIX
--      classes like [[:space:]] are collation-aware in PostgreSQL and carry
--      the same cluster-dependence this function exists to avoid; chr() reads
--      a Unicode code point and nothing else. Same set as
--      packages/domain/src/rules/catalogItems.ts (STRIP_CODE_POINTS -- keep
--      the two in step), decimal with its U+ form for the human reader:
--        45        U+002D hyphen-minus (first: literal, not a range operator)
--        95        U+005F underscore
--        9-13      U+0009-U+000D  (JS trim() set = migration 0019's
--                  ck_status_history_reason CHECK)
--        32        U+0020 space
--        160       U+00A0 NBSP
--        5760      U+1680 Ogham space mark
--        8192-8202 U+2000-U+200A
--        8232,8233 U+2028, U+2029 line/paragraph separator
--        8239      U+202F narrow no-break space
--        8287      U+205F medium mathematical space
--        12288     U+3000 ideographic space
--        65279     U+FEFF BOM / zero-width no-break space
--        8203-8205 U+200B-U+200D zero-width joiner/non-joiner -- not in JS
--                  trim()'s set, stripped anyway on purpose (see the domain
--                  file: two staff pasting the same name from different
--                  sources, one with an invisible joiner, must key the same)
--        8208-8213 U+2010-U+2015 the Unicode dash block
--        8722      U+2212 minus sign
-- A shared fixture (packages/domain/src/rules/priceKeyFixtures.ts) is checked
-- against BOTH implementations: a domain vitest, and a tier-2 test that runs
-- this function over the same inputs (apps/api's priceKeySql test).
CREATE OR REPLACE FUNCTION price_key(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT regexp_replace(
           translate(normalize(t, NFKC), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
           '[' || array_to_string(array[
             chr(45), chr(95),
             chr(9), chr(10), chr(11), chr(12), chr(13),
             chr(32), chr(160), chr(5760),
             chr(8192), chr(8193), chr(8194), chr(8195), chr(8196), chr(8197),
             chr(8198), chr(8199), chr(8200), chr(8201), chr(8202),
             chr(8232), chr(8233), chr(8239), chr(8287), chr(12288), chr(65279),
             chr(8203), chr(8204), chr(8205),
             chr(8208), chr(8209), chr(8210), chr(8211), chr(8212), chr(8213),
             chr(8722)
           ], '') || ']+',
           '', 'g')
$$;


-- -----------------------------------------------------------------------------
-- 6. composite-FK targets: vehicle_models and warranty_terms (both from
--    earlier migrations; neither had a (shop_id, id) unique key yet)
-- -----------------------------------------------------------------------------
ALTER TABLE vehicle_models ADD CONSTRAINT uq_vehicle_models_shop_id UNIQUE (shop_id, id);
-- Used to find "the one controlled model that matches what staff typed".
CREATE INDEX idx_vehicle_models_keys ON vehicle_models (shop_id, price_key(brand), price_key(name));

ALTER TABLE warranty_terms ADD CONSTRAINT uq_warranty_terms_shop_id UNIQUE (shop_id, id);


-- -----------------------------------------------------------------------------
-- 2. catalog_items
-- -----------------------------------------------------------------------------
CREATE TABLE catalog_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  category         text NOT NULL,
  category_key     text GENERATED ALWAYS AS (price_key(category)) STORED,
  name             text NOT NULL,
  name_key         text GENERATED ALWAYS AS (price_key(name)) STORED,
  line_type        text NOT NULL DEFAULT 'part'
                   CHECK (line_type IN ('part', 'labor', 'fee')),
  unit             text,
  default_qty      numeric(12,2) NOT NULL DEFAULT 1 CHECK (default_qty > 0),
  -- The shop's standard warranty for this item, from 0010's warranty_terms —
  -- NOT a new table. A line created from this item snapshots days/max_km/name
  -- onto itself (0021); editing the term later never touches a sold line.
  warranty_term_id uuid,
  is_set           boolean NOT NULL DEFAULT false,
  -- NULL = nobody has priced this yet. 0 = free, on purpose.
  base_price       numeric(12,2) CHECK (base_price >= 0),
  is_active        boolean NOT NULL DEFAULT true,
  -- Set when this item was merged into another (D12). The old lines that point
  -- here are never rewritten; readers follow this link (resolveCatalogItem).
  merged_into_id   uuid,
  -- Where an imported row came from (WO-004), so a re-run does not duplicate.
  legacy_source    text,
  legacy_id        text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_catalog_items_shop_id UNIQUE (shop_id, id),
  CONSTRAINT fk_catalog_items_warranty FOREIGN KEY (shop_id, warranty_term_id)
    REFERENCES warranty_terms (shop_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_items_merged FOREIGN KEY (shop_id, merged_into_id)
    REFERENCES catalog_items (shop_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_catalog_not_self_merged CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  -- A merged item is retired; it must not show up in search any more.
  CONSTRAINT ck_catalog_merged_inactive CHECK (merged_into_id IS NULL OR NOT is_active),
  CONSTRAINT ck_catalog_legacy_pair CHECK ((legacy_source IS NULL) = (legacy_id IS NULL))
);
-- One live item per (category, name) after normalising; merged items are
-- history and may repeat a name.
CREATE UNIQUE INDEX uq_catalog_items_name ON catalog_items (shop_id, category_key, name_key)
  WHERE merged_into_id IS NULL;
CREATE UNIQUE INDEX uq_catalog_items_legacy ON catalog_items (shop_id, legacy_source, legacy_id)
  WHERE legacy_source IS NOT NULL;
CALL apply_tenant_rls('catalog_items');
CREATE TRIGGER trg_catalog_items_updated BEFORE UPDATE ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- 3. catalog_set_components
-- -----------------------------------------------------------------------------
CREATE TABLE catalog_set_components (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  set_item_id        uuid NOT NULL,
  -- Linked to a catalog item when one matches; otherwise just the name the
  -- prototype stored.
  component_item_id  uuid,
  component_name     text NOT NULL,
  -- A set can contain labour ("ประกอบติดตั้งรวมตั้งศูนย์"); the child line needs
  -- its type, and a linked item may not exist.
  line_type          text NOT NULL DEFAULT 'part'
                     CHECK (line_type IN ('part', 'labor', 'fee')),
  qty                numeric(12,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
  sort_order         integer NOT NULL DEFAULT 0,

  CONSTRAINT fk_set_components_set FOREIGN KEY (shop_id, set_item_id)
    REFERENCES catalog_items (shop_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_set_components_item FOREIGN KEY (shop_id, component_item_id)
    REFERENCES catalog_items (shop_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_set_component_not_self CHECK (component_item_id IS NULL OR component_item_id <> set_item_id)
);
CREATE INDEX idx_set_components_set ON catalog_set_components (shop_id, set_item_id, sort_order);
CALL apply_tenant_rls('catalog_set_components');


-- -----------------------------------------------------------------------------
-- 4. catalog_model_prices
-- -----------------------------------------------------------------------------
CREATE TABLE catalog_model_prices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  item_id          uuid NOT NULL,
  vehicle_model_id uuid NOT NULL,
  -- A row that exists IS a price, including 0 (free). "No price" = no row.
  price            numeric(12,2) NOT NULL CHECK (price >= 0),
  set_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  set_at           timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_model_prices_item FOREIGN KEY (shop_id, item_id)
    REFERENCES catalog_items (shop_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_model_prices_model FOREIGN KEY (shop_id, vehicle_model_id)
    REFERENCES vehicle_models (shop_id, id) ON DELETE RESTRICT,
  -- First writer wins: the first-price INSERT is ON CONFLICT DO NOTHING on this.
  CONSTRAINT uq_model_prices UNIQUE (shop_id, vehicle_model_id, item_id)
);
-- "All model prices of this item" — merge and the price-fix screen.
CREATE INDEX idx_model_prices_item ON catalog_model_prices (shop_id, item_id);
CALL apply_tenant_rls('catalog_model_prices');


-- -----------------------------------------------------------------------------
-- 5. vehicles -> controlled model
-- -----------------------------------------------------------------------------
ALTER TABLE vehicles ADD COLUMN vehicle_model_id uuid;
ALTER TABLE vehicles ADD CONSTRAINT fk_vehicles_model FOREIGN KEY (shop_id, vehicle_model_id)
  REFERENCES vehicle_models (shop_id, id) ON DELETE RESTRICT;
CREATE INDEX idx_vehicles_model ON vehicles (shop_id, vehicle_model_id);
