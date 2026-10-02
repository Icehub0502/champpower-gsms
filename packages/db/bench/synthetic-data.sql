-- Synthetic data for P3.1 0020/0021 EXPLAIN measurement, on gsms_scratch only.
-- Run as postgres (bypasses RLS; shop_id is set explicitly on every row).
-- Sizes per v3 §4.1: ~300 catalog items/shop incl. 154 sets x 6 components,
-- 632 vehicle models, model prices for 536 models x 60 items/shop,
-- 5,000 vehicles/shop, 20,000 document lines/shop. Two shops.

\timing on

DO $$
DECLARE
  shop_ids uuid[];
  s uuid;
  i integer;
  j integer;
  cust uuid;
  doc uuid;
  model_ids uuid[];
  item_ids uuid[];
  set_ids uuid[];
  plain_ids uuid[];
  wt uuid;
  header uuid;
  mids uuid[];
  n_lines integer;
  k integer;
BEGIN
  SELECT array_agg(id) INTO shop_ids FROM (SELECT id FROM shops ORDER BY ctid LIMIT 2) x;

  FOREACH s IN ARRAY shop_ids LOOP
    RAISE NOTICE 'shop %', s;

    -- 1 warranty term to point catalog items at.
    INSERT INTO warranty_terms (shop_id, name, days, max_km)
      VALUES (s, 'ลูกหมาก 1 ปี 100,000 กม.', 365, 100000)
      RETURNING id INTO wt;

    -- 632 vehicle models.
    INSERT INTO vehicle_models (shop_id, brand, name, year_range)
      SELECT s, 'Brand' || (n % 80), 'Model' || n, '2015-2020'
      FROM generate_series(1, 632) AS n;
    SELECT array_agg(id) INTO model_ids FROM vehicle_models WHERE shop_id = s;

    -- 300 catalog items: 154 sets (is_set, no base_price on the header's own
    -- line — header DOES carry a price) + 146 plain items.
    item_ids := ARRAY[]::uuid[];
    INSERT INTO catalog_items (shop_id, category, name, line_type, base_price, warranty_term_id, is_set)
      SELECT s, 'หมวด' || (n % 10), 'รายการ' || n, 'part', (100 + n)::numeric, wt, (n <= 154)
      FROM generate_series(1, 300) AS n;
    SELECT array_agg(id ORDER BY ctid) INTO item_ids FROM catalog_items WHERE shop_id = s;
    SELECT array_agg(id) INTO set_ids FROM (
      SELECT id FROM catalog_items WHERE shop_id = s AND is_set ORDER BY ctid LIMIT 154) x;
    SELECT array_agg(id ORDER BY ctid) INTO plain_ids FROM catalog_items WHERE shop_id = s AND NOT is_set;

    -- 6 components per set, linked to plain items round-robin.
    FOR i IN 1..array_length(set_ids, 1) LOOP
      FOR j IN 1..6 LOOP
        INSERT INTO catalog_set_components (shop_id, set_item_id, component_item_id, component_name, sort_order)
          VALUES (s, set_ids[i], plain_ids[1 + ((i * 6 + j) % array_length(plain_ids, 1))], 'ชิ้นที่ ' || j, j);
      END LOOP;
    END LOOP;

    -- model prices: 536 models x 60 items.
    INSERT INTO catalog_model_prices (shop_id, item_id, vehicle_model_id, price)
      SELECT s, item_ids[1 + ((m * 60 + it) % array_length(item_ids, 1))], model_ids[m], (200 + it)::numeric
      FROM generate_series(1, 536) m, generate_series(1, 60) it
      ON CONFLICT DO NOTHING;

    -- 5,000 vehicles, 80% linked to a controlled model. One customer per car,
    -- matched by row_number (not OFFSET-in-a-loop, which is O(n^2)).
    INSERT INTO customers (shop_id, name, phone)
      SELECT s, 'ลูกค้า ' || n, '08' || lpad(n::text, 8, '0')
      FROM generate_series(1, 5000) AS n;

    INSERT INTO vehicles (shop_id, customer_id, plate, province, brand, model, vehicle_model_id)
      SELECT s, c.id, 'กข' || (1000 + c.i), 'กรุงเทพมหานคร', 'Brand' || (c.i % 80), 'Model' || (c.i % 632),
             CASE WHEN c.i % 5 = 0 THEN NULL ELSE model_ids[1 + (c.i % array_length(model_ids, 1))] END
      FROM (SELECT id, row_number() OVER (ORDER BY ctid) AS i FROM customers WHERE shop_id = s) c;

    -- 20,000 document lines spread across quotations, each on a real vehicle.
    SELECT array_agg(customer_id) INTO mids FROM vehicles WHERE shop_id = s;
    n_lines := 0;
    FOR i IN 1..1000 LOOP
      cust := mids[1 + ((i - 1) % array_length(mids, 1))];

      INSERT INTO documents (shop_id, job_id, customer_id, type, series, status)
        VALUES (s, NULL, cust, 'quotation', 'QUO', 'draft')
        RETURNING id INTO doc;

      -- 20 lines per quotation = 20,000 / shop. Every 4th is a set header + 6 children.
      k := 0;
      WHILE k < 20 LOOP
        IF k % 4 = 0 THEN
          INSERT INTO document_lines (shop_id, document_id, line_type, name_snapshot, qty, unit_price, line_total,
                                       catalog_item_id, list_price, price_source)
            VALUES (s, doc, 'part', 'ชุด', 1, 1500, 1500,
                    item_ids[1 + ((i + k) % array_length(item_ids, 1))], 1500, 'base')
            RETURNING id INTO header;
          FOR j IN 1..6 LOOP
            INSERT INTO document_lines (shop_id, document_id, parent_line_id, line_type, name_snapshot, qty, unit_price, line_total)
              VALUES (s, doc, header, 'part', 'ชิ้นย่อย ' || j, 1, 0, 0);
          END LOOP;
          k := k + 7;
          n_lines := n_lines + 7;
        ELSE
          INSERT INTO document_lines (shop_id, document_id, line_type, name_snapshot, qty, unit_price, line_total,
                                       catalog_item_id, list_price, price_source)
            VALUES (s, doc, 'part', 'รายการ', 1, 300, 300,
                    item_ids[1 + ((i + k) % array_length(item_ids, 1))], 300, 'base');
          k := k + 1;
          n_lines := n_lines + 1;
        END IF;
      END LOOP;
      EXIT WHEN n_lines >= 20000;
    END LOOP;

    RAISE NOTICE 'shop % done: % lines', s, n_lines;
  END LOOP;
END $$;

SELECT 'vehicle_models' t, count(*) FROM vehicle_models
UNION ALL SELECT 'catalog_items', count(*) FROM catalog_items
UNION ALL SELECT 'catalog_set_components', count(*) FROM catalog_set_components
UNION ALL SELECT 'catalog_model_prices', count(*) FROM catalog_model_prices
UNION ALL SELECT 'vehicles', count(*) FROM vehicles
UNION ALL SELECT 'document_lines', count(*) FROM document_lines
UNION ALL SELECT 'documents', count(*) FROM documents;
