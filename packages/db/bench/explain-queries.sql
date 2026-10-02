-- EXPLAIN (ANALYZE, BUFFERS) as gsms_app under RLS, on gsms_scratch synthetic
-- data. Run: psql <gsms_app DSN to gsms_scratch> -f scratch-explain.sql
-- The shop id below is shop A from scratch-synthetic.sql.

-- SET LOCAL only lives inside a transaction block; without BEGIN it evaporates
-- after the next implicit-transaction statement, which is why a first attempt
-- at this file ran every EXPLAIN with no shop set (0 rows everywhere).
BEGIN;
SET LOCAL app.current_shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19';

\echo '=== Q1: catalog search by name, this shop only (GET /api/catalog/search) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, category, name, is_set, base_price
  FROM catalog_items
 WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19'
   AND is_active
   AND name ILIKE '%ยการ1%'
 LIMIT 20;

\echo ''
\echo '=== Q2: catalog search sets-first then plain, ordered (search box ranking) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, name, is_set
  FROM catalog_items
 WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19'
   AND is_active
   AND name_key LIKE price_key('รายการ')||'%'
 ORDER BY is_set DESC, name
 LIMIT 20;

\echo ''
\echo '=== Q3: price lookup for one item on one vehicle model (quote line price resolution) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT price
  FROM catalog_model_prices
 WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19'
   AND vehicle_model_id = (SELECT id FROM vehicle_models WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19' ORDER BY ctid LIMIT 1)
   AND item_id = (SELECT id FROM catalog_items WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19' ORDER BY ctid LIMIT 1);

\echo ''
\echo '=== Q4: set expansion — components of one set item (add-set-to-quotation) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT component_item_id, component_name, qty, sort_order
  FROM catalog_set_components
 WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19'
   AND set_item_id = (SELECT id FROM catalog_items WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19' AND is_set ORDER BY ctid LIMIT 1)
 ORDER BY sort_order;

\echo ''
\echo '=== Q5: document lines of one quotation, in order (load the draft/issued quote) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, parent_line_id, line_type, name_snapshot, qty, unit_price, line_total, approval_status
  FROM document_lines
 WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19'
   AND document_id = (SELECT id FROM documents WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19' ORDER BY ctid LIMIT 1)
 ORDER BY sort_order;

\echo ''
\echo '=== Q6: children of a set header within one document (decision cascade / set totals) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, approval_status
  FROM document_lines
 WHERE document_id = (SELECT id FROM documents WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19' ORDER BY ctid LIMIT 1)
   AND parent_line_id = (
     SELECT id FROM document_lines
      WHERE document_id = (SELECT id FROM documents WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19' ORDER BY ctid LIMIT 1)
        AND parent_line_id IS NULL
      ORDER BY ctid LIMIT 1);

\echo ''
\echo '=== Q7: lines of one catalog item across all documents (merge report / most-used) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, document_id
  FROM document_lines
 WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19'
   AND catalog_item_id = (SELECT id FROM catalog_items WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19' ORDER BY ctid LIMIT 1)
 ORDER BY document_id DESC
 LIMIT 50;

\echo ''
\echo '=== Q8: vehicle -> controlled model matching at intake (brand+model text to one model) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM vehicle_models
 WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19'
   AND price_key(brand) = price_key('Brand5')
   AND price_key(name) = price_key('Model123');

\echo ''
\echo '=== Q9: all model prices of one item (merge screen conflict check) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT vehicle_model_id, price
  FROM catalog_model_prices
 WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19'
   AND item_id = (SELECT id FROM catalog_items WHERE shop_id = 'd7b0e787-20ef-424d-97e5-36aa9e745c19' ORDER BY ctid LIMIT 1);

\echo ''
\echo '=== Q10: cross-shop isolation sanity — shop B vehicle_model id under shop A session (expect 0 rows) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM vehicle_models
 WHERE id = (SELECT id FROM vehicle_models WHERE shop_id = 'b5dc9f84-44ad-4f0d-ba9e-4a1f9fabdd67' ORDER BY ctid LIMIT 1);
COMMIT;
