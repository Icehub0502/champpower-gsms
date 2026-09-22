-- =============================================================================
-- 0015_match_blocklist.sql — values that must never join two records together
--
-- WHAT:     1. New tenant table match_blocklist: per shop, a list of phone
--              numbers and plates that may be STORED on a record but never
--              used as a key to find an existing one.
--           2. Seeds the three placeholder phones and two test plates found in
--              the production dump, for every shop that exists today.
--           3. Adds one arm to attention_items so an automatically blocked key
--              surfaces to the owner instead of being invisible.
-- WHY:      docs/WORK-ORDERS/IMPORT-FINDINGS.md §4, from the real production
--           dump (cps2-20260916-0246.sql.gz). The phone 0999999999 is shared
--           by EIGHT unrelated customers — it is what staff type when the
--           customer will not give a number. 0993333333 and 0000000000 are the
--           same. The plate 1กอ2222 appears four times and 1กก1111 three.
--
--           WO-003's intake resolver matches a customer by phone and a car by
--           plate, which is right and is what stops the same person being
--           created twice. Applied to these values it would fuse eight
--           people's repair histories into one customer — the
--           vehicle_owner_mismatch disaster arriving through the phone-number
--           door, and silently: no error, no exception, just a customer record
--           that is quietly wrong forever.
--
--           TWO LAYERS, AND THIS TABLE IS ONLY THE SECOND ONE. The floor is
--           isPlaceholderKey() in packages/domain/src/rules/matchKeys.ts,
--           which recognises the shapes that are placeholders by construction
--           (a phone that is one repeated digit, a plate whose trailing digits
--           are all the same) and therefore protects a brand-new shop on its
--           first day with this table empty. That split is deliberate: 0014
--           had to be written because seed_document_series() lived in one
--           script and nothing else, so every shop not created by that script
--           was broken. A blocklist that only covers shops present when THIS
--           file ran would have the identical defect, and this one fails
--           silently rather than raising. So the table carries what a specific
--           shop discovers later — 0993333333 is a placeholder by convention
--           here, not by shape, and no pattern could ever know that — and it
--           ADDS TO the floor rather than being the whole of it.
-- ROLLBACK: Runnable in one transaction as the owning role. The attention_items
--           body must be restored from 0010_gaps.sql (lines 361-450) — it is
--           CREATE OR REPLACE, so dropping this migration's arm means putting
--           the 0010 definition back verbatim, WITHOUT the match_key_blocked
--           arm added below and WITH every other arm unchanged.
--
--           BEGIN;
--             -- 1. restore attention_items from 0010_gaps.sql verbatim
--             --    (copy the CREATE OR REPLACE VIEW block from that file)
--             -- 2. then:
--             DROP TABLE match_blocklist;
--           COMMIT;
--
--           Dropping the table loses any 'auto' and 'manual' rows a shop has
--           accumulated, which are real operational decisions — an owner
--           deciding a number is junk. They are not recoverable from the seed
--           below, which only reinstates the five known values. Export
--           match_blocklist before rolling back if the shop has been live.
-- LOCKS:    None worth planning for. The table is new, so nothing can be
--           waiting on it. CREATE OR REPLACE VIEW takes ACCESS EXCLUSIVE on
--           the view's own catalogue row, not on the tables it reads, and
--           completes in microseconds. The seed INSERT touches only the new
--           table.
-- ROWS:     Writes 5 rows per existing shop (3 phones + 2 plates). shops holds
--           6 rows as this file is written, so 30 rows inserted. Reads no
--           other table's data.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
CREATE TABLE match_blocklist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,

  kind        text NOT NULL CHECK (kind IN ('phone', 'plate')),

  -- THE MOST IMPORTANT COLUMN IN THIS FILE, and the easiest thing here to get
  -- wrong in a way that nothing catches.
  --
  -- value_key stores the ALREADY-NORMALISED form: digits only for a phone
  -- (customersRepo.normalisePhone -> '0999999999'), plate_key form for a plate
  -- (vehiclesRepo.plateKeyOf, upper-cased with punctuation stripped ->
  -- '1กอ2222'). The lookup it guards normalises its input the same way before
  -- comparing.
  --
  -- If this column ever holds '099-999-9999' while the lookup normalises to
  -- '0999999999', the two never compare equal, the blocklist never fires, and
  -- every other line of this migration — and of the code that reads it — is
  -- decorative. There is no error when that happens. The customers simply
  -- start merging again. Store normalised, compare normalised, and never
  -- insert into this table from a form field without normalising first.
  value_key   text NOT NULL,

  -- Free text, required in spirit: whoever deletes a row in two years needs to
  -- know why it was added.
  reason      text,

  -- 'seed'   put here by this migration, from the production dump
  -- 'manual'  a person at this shop decided this value is junk
  -- 'auto'    the threshold rule fired (findings §4 item 3: a phone used by
  --           more than 3 customers stops being a matching key). Written as a
  --           ROW, not computed on the fly, so the owner can see it, ask why,
  --           and delete it if it was wrong. A rule that lives only in code is
  --           invisible and cannot be undone.
  source      text NOT NULL DEFAULT 'manual'
              CHECK (source IN ('seed', 'manual', 'auto')),

  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Per shop: one branch's junk number is another's real customer, and the
  -- threshold rule is counted per shop too.
  CONSTRAINT uq_match_blocklist UNIQUE (shop_id, kind, value_key)
);

-- The unique constraint's own index (shop_id, kind, value_key) is exactly the
-- lookup this table exists to serve — "is this key blocked for this shop" — so
-- no second index is added. CLAUDE.md §11: index what a query needs, measured,
-- not guessed.
CALL apply_tenant_rls('match_blocklist');


-- -----------------------------------------------------------------------------
-- 2. Seed the known values, for every shop that exists now
-- -----------------------------------------------------------------------------
-- Note what this does NOT do: it does not make new shops safe. A shop created
-- tomorrow gets an empty blocklist, and is protected only by isPlaceholderKey
-- in packages/domain — which is why that function exists and why these two
-- layers are not the same thing. See the WHY block above.
--
-- Values are written normalised, which for these five happens to look the same
-- as how a person would type them. That is a coincidence of these particular
-- values, not a reason to relax about the rule.
INSERT INTO match_blocklist (shop_id, kind, value_key, reason, source)
SELECT s.id, v.kind, v.value_key, v.reason, 'seed'
  FROM shops s
 CROSS JOIN (VALUES
   ('phone', '0999999999', 'ค่าหลอกที่พนักงานพิมพ์ตอนลูกค้าไม่ให้เบอร์ — พบใช้ซ้ำ 8 รายในข้อมูลจริง'),
   ('phone', '0993333333', 'ค่าหลอกที่พบในข้อมูลจริง'),
   ('phone', '0000000000', 'ค่าหลอกที่พบในข้อมูลจริง'),
   ('plate', '1กอ2222',    'ข้อมูลทดสอบ — พบซ้ำ 4 คันในข้อมูลจริง'),
   ('plate', '1กก1111',    'ข้อมูลทดสอบ — พบซ้ำ 3 คันในข้อมูลจริง')
 ) AS v(kind, value_key, reason)
 ON CONFLICT (shop_id, kind, value_key) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 3. Surface automatic blocks to the owner
-- -----------------------------------------------------------------------------
-- The full 0010 definition with ONE arm appended. CREATE OR REPLACE VIEW
-- cannot change the column list, so every arm below is reproduced exactly as
-- 0010 wrote it — same order, same expressions, same types.
--
-- The new arm is the other half of findings §4 item 3: the rule says to stop
-- matching AND to warn whoever looks after the shop. Stopping quietly would
-- leave the owner with duplicate customers appearing for a reason nobody can
-- see.

CREATE OR REPLACE VIEW attention_items WITH (security_invoker = true) AS

  SELECT d.shop_id, 'deposit_overdue' AS kind, d.id AS ref_id,
         'มัดจำเลยนัด ' || to_char(d.amount, 'FM999,999.00') || ' บาท' AS label,
         d.expected_date::timestamptz AS due_at, 'high' AS severity
    FROM deposits d
   WHERE d.status = 'held' AND d.expected_date < current_date

  UNION ALL
  SELECT b.shop_id, 'booking_today', b.id,
         'จองวันนี้ ' || coalesce(b.contact_name, 'ไม่ระบุชื่อ'),
         b.slot_start, 'normal'
    FROM bookings b
   WHERE b.status IN ('booked', 'confirmed')
     AND b.slot_start::date = current_date

  UNION ALL
  SELECT s.shop_id, 'reorder', s.id,
         'ของใกล้หมด: ' || s.name,
         now(), 'normal'
    FROM skus s
    JOIN stock_balances sb ON sb.shop_id = s.shop_id AND sb.sku_id = s.id
   WHERE s.stocking_policy = 'stocked'
     AND s.reorder_point IS NOT NULL
     AND sb.on_hand - sb.reserved <= s.reorder_point

  UNION ALL
  SELECT ps.shop_id, 'purchase_needed', ps.id,
         'ต้องสั่งอะไหล่',
         ps.created_at, 'high'
    FROM purchase_suggestions ps
   WHERE ps.status = 'open'

  UNION ALL
  SELECT st.to_shop_id, 'transfer_pending', st.id,
         'ของโอนเข้ายังไม่รับ: ' || st.transfer_no,
         st.sent_at, 'high'
    FROM stock_transfers st
   WHERE st.status = 'sent'

  UNION ALL
  SELECT ss.shop_id, 'statement_open', ss.id,
         'ใบวางบิลรอกระทบยอด',
         ss.period_end::timestamptz, 'normal'
    FROM supplier_statements ss
   WHERE ss.status IN ('open', 'disputed')

  UNION ALL
  SELECT pi.shop_id, 'payable_due', pi.id,
         'ครบกำหนดจ่ายร้านอะไหล่ ' || to_char(pi.grand_total, 'FM999,999.00'),
         pi.due_date::timestamptz, 'high'
    FROM purchase_invoices pi
   WHERE pi.status IN ('open', 'partially_paid')
     AND pi.due_date IS NOT NULL
     AND pi.due_date <= current_date + 7

  UNION ALL
  SELECT d.shop_id, 'quote_pending', d.id,
         'ใบเสนอราคายังไม่ตอบ',
         d.issued_at, 'normal'
    FROM documents d
   WHERE d.type = 'quotation'
     AND d.status = 'issued'
     AND d.issued_at < now() - interval '3 days'
     AND NOT EXISTS (SELECT 1 FROM documents r
                      WHERE r.source_document_id = d.id AND r.type = 'receipt')

  UNION ALL
  SELECT e.shop_id, 'evaluation_due', e.id,
         'แบบประเมินยังไม่ส่ง',
         e.period_end::timestamptz, 'normal'
    FROM evaluations e
   WHERE e.status = 'draft' AND e.period_end < current_date

  UNION ALL
  SELECT r.shop_id, 'pdpa_request', r.id,
         'คำขอข้อมูลส่วนบุคคลรอดำเนินการ',
         r.requested_at, 'high'
    FROM data_subject_requests r
   WHERE r.status = 'open'

  UNION ALL
  -- NEW IN 0015. A value the system stopped trusting on its own, so the person
  -- who runs the shop can see it happened, understand why the customer got a
  -- second record, and delete the row if the automatic judgement was wrong.
  -- 'seed' and 'manual' rows are deliberately NOT listed: those were decided
  -- by a person and need no attention.
  SELECT mb.shop_id, 'match_key_blocked', mb.id,
         CASE mb.kind
           WHEN 'phone' THEN 'เบอร์นี้ถูกใช้หลายราย ระบบหยุดใช้จับคู่ลูกค้า: ' || mb.value_key
           ELSE 'ทะเบียนนี้ถูกใช้หลายคัน ระบบหยุดใช้จับคู่รถ: ' || mb.value_key
         END,
         mb.created_at, 'normal'
    FROM match_blocklist mb
   WHERE mb.source = 'auto';


-- =============================================================================
-- ROLLBACK — see the ROLLBACK section in the header comment above.
-- =============================================================================
