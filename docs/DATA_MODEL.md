# โครงสร้างข้อมูลทั้งหมด

> ดัชนีสำหรับไล่ดู — 62 ตาราง 2 view ใน 10 ไฟล์ migration
> SQL จริงอยู่ที่ `packages/db/migrations/` · กติกาอยู่ที่ `CLAUDE.md` · เหตุผลอยู่ที่ `docs/ARCHITECTURE.md`

---

## ภาพรวม

```
owner_groups ──┬── shops ──┬── shop_memberships ── users ── sessions
               │           │
               │           ├── customers ── vehicles ──┬── jobs ──┬── documents ── document_lines
               │           │                           │          │      │
               │           │                           │          │      ├── payments ── deposits
               │           │                           │          │      └── (tax invoice อ้าง source_document_id)
               │           │                           │          │
               │           │                           │          ├── job_workers ── technicians ── teams
               │           │                           │          └── job_photos / notes / history
               │           │                           │
               │           │                           └── bookings ── bays
               │           │
               │           ├── skus ──┬── stock_moves (append-only)
               │           │          ├── stock_balances (cache)
               │           │          ├── stock_lots
               │           │          └── stock_counts
               │           │
               │           ├── purchase_invoices ── purchase_invoice_lines
               │           │        ├── purchase_returns
               │           │        ├── supplier_statements
               │           │        └── supplier_payments
               │           │
               │           └── evaluations ── evaluation_answers
               │
               └── suppliers          ← ชั้นเดียวที่แชร์ข้ามสาขา
```

---

## 0001 · รากฐาน (7 ตาราง)

| ตาราง | คืออะไร |
|---|---|
| `owner_groups` | กลุ่มเจ้าของ — A: ดอนเมือง/ประชาอุทิศ/วงเวียนใหญ่/อยุธยา · B: สมุทรปราการ/เพชรเกษม |
| `shops` | สาขา + ข้อมูลบริษัทสำหรับหัวใบกำกับ + `assignment_mode` + วงเงินปรับสต๊อก |
| `users` | ตัวตน · `login_id` unique ทั้งระบบ (อีเมลหรือ username) |
| `shop_memberships` | **role อยู่ที่นี่ ไม่ใช่ที่ users** — คนหนึ่งอยู่หลายสาขา role ต่างกันได้ |
| `sessions` | refresh token + `jti` · ตัดสิทธิ์ทันทีเมื่อพนักงานลาออก |
| `audit_logs` | ใคร ทำอะไร ค่าเดิม→ค่าใหม่ · JSONB + GIN index |
| `files` | metadata ของรูป/PDF · bytes อยู่บนดิสก์ |

**เครื่องมือที่ไฟล์นี้วางไว้** — `apply_tenant_rls()` · `current_shop_id()` · `current_shop_ids()` · `set_updated_at()`

---

## 0002 · แกนงาน (17 ตาราง)

| ตาราง | จุดที่ควรดู |
|---|---|
| `customers` | `customer_type` individual/juristic · `tax_id` · **`lead_source` มี `unknown`** |
| `vehicles` | `plate_key` เป็น **generated column** — แอปลืมอัปเดตไม่ได้ |
| `technicians` | `user_id` nullable — ช่างยังไม่มีบัญชี |
| `teams` / `team_members` | ดอนเมือง = หลายทีม · สมุทรปราการ = ทีมเดียวหรือไม่ใช้เลย |
| `jobs` | `job_type` normal/warranty_claim + `parent_job_id` · **trigger กันเคลมข้ามสาขา** |
| `job_workers` | **ใครลงมือจริง** หลายคนต่อคัน ติ๊กตอนปิดงาน — KPI อ่านตารางนี้เท่านั้น |
| `job_photos` | อ้าง `files(id)` ไม่ใช่ base64 อีกแล้ว |
| catalog 5 ตาราง | ราคากลางต่อรุ่นรถ + โปรโมชัน (ยกโครงมาจากของเดิม) |

---

## 0003 · เลขที่เอกสาร + idempotency (2 ตาราง)

| ตาราง | จุดที่ควรดู |
|---|---|
| `document_counters` | `allocate_document_number()` — atomic · อยู่ใน transaction เดียวกับ INSERT จึงไม่มี gap |
| `idempotency_keys` | ใช้ร่วมกันระหว่าง **offline outbox** กับ **stock moves** · `request_hash` จับ key ซ้ำแต่ body ต่าง → 409 |

ชุดเลข: `QUO` `WO` `REC` `DEP` `TAX` `ABB` `CN` `JOB`

---

## 0004 · เอกสาร (3 ตาราง)

| ตาราง | จุดที่ควรดู |
|---|---|
| `documents` | `number` เป็น generated column · **trigger ห้ามแก้เมื่อ signed/issued** · `offered_total` vs `approved_total` · `vat_mode` 3 โหมด · `vat_absorbed` · snapshot คู่สัญญา 8 ฟิลด์ · `signature_file_id` อยู่ที่เอกสารไม่ใช่ที่ job |
| `document_lines` | `line_type` part/labor/fee · **`ck_labor_no_vat`** บังคับที่ DB · `approval_status` รายบรรทัด · `decline_reason` · `fulfilled_qty` |
| `vehicle_offered_items` | รายการที่ลูกค้าปฏิเสธ ผูกกับรถ — โอกาสขายครั้งหน้า |

**Constraint ที่น่าสนใจ**
`ck_tax_has_source` ใบกำกับต้องผูกบิลเสมอ · `ck_void_reason` void ต้องมีเหตุผล · `ck_decline_reason` ปฏิเสธต้องมีเหตุผล

---

## 0005 · เงินเข้า (3 ตาราง)

| ตาราง | จุดที่ควรดู |
|---|---|
| `deposits` | **ผูกกับ `customer_id` ไม่ใช่ `job_id`** · `channel` page/line/walk_in · `slip_file_id` · `expected_date` บังคับ · `status` held/applied/refunded/**forfeited** |
| `payments` | append-only หลายแถวต่อบิล · `change_given` แยกจาก `amount` · `ck_deposit_offset` |
| `daily_closings` | `variance` generated · index เฉพาะวันที่เงินไม่ตรง |

---

## 0006 · สต๊อก (7 ตาราง + 1 view)

| ตาราง | จุดที่ควรดู |
|---|---|
| `skus` | `stocking_policy` stocked/**buy_to_order** (อะไหล่ซื้อเฉพาะงาน) |
| `stock_lots` | ผูก `supplier_id` — รู้ว่าแต่ละชิ้นมาจากร้านไหน |
| `stock_moves` | **append-only ด้วย trigger** · `qty` มีเครื่องหมาย · `unit_cost` แช่แข็งบนแถว · `UNIQUE(shop_id, idempotency_key)` · `ck_adjustment_reason` |
| `stock_balances` | cache · `ck_on_hand_nonneg` — **ของไม่พอคือ shortfall ไม่ใช่ยอดติดลบ** |
| `stock_available` (view) | `on_hand − reserved` — ทำเป็น view ไม่ให้ลืมลบในบาง query |
| `purchase_suggestions` | ของขาดตอนอนุมัติ → เปิดรายการสั่งซื้ออัตโนมัติ |
| `stock_counts` / `_lines` | ตรวจนับ · `variance` generated · โพสต์แล้วเขียน move ชนิด `count` |

---

## 0007 · ฝั่งซื้อ (10 ตาราง)

| ตาราง | จุดที่ควรดู |
|---|---|
| `suppliers` | **`owner_group_id` ไม่ใช่ `shop_id`** — แชร์ทั้งกลุ่ม · `category` แยกหมวดร้าน |
| `purchase_invoices` | **`UNIQUE(owner_group_id, supplier_id, supplier_invoice_no)`** ระดับกลุ่ม — จับทั้งกรอกซ้ำและกรอกบิลของสาขาอื่น · `has_vat_credit` |
| `purchase_invoice_lines` | `sku_id` nullable + index เฉพาะบรรทัดที่ยังไม่ผูก SKU |
| `purchase_returns` / `_lines` | คืนของ — กลับสต๊อก+หนี้+ภาษีซื้อ **ห้ามแก้ใบเดิม** |
| `supplier_statements` / `_lines` | ใบวางบิลรอบเดือน · `match_status` บอกว่าใบไหนขาด/เกิน/ไม่ตรง **ก่อนจ่ายเงิน** |
| `supplier_payments` | append-only ตัดทีละใบ ห้ามลงยอดรวมลอย ๆ |
| `purchase_orders` / `_lines` | ใบสั่งซื้อล่วงหน้า (ไม่บังคับใช้) |

---

## 0008 · คิว/จอง (2 ตาราง)

| ตาราง | จุดที่ควรดู |
|---|---|
| `bays` | ช่องซ่อม |
| `bookings` | **`EXCLUDE USING gist`** — จองซ้อนช่องเดียวกันไม่ได้ที่ระดับ DB · `source` รวม walk-in กับ booking ไว้ตารางเดียว · `no_show` |

นี่คือตารางที่ **MySQL ทำไม่ได้** ถ้าเวลาไม่ตายตัว

---

## 0009 · ประเมินพนักงาน (4 ตาราง)

| ตาราง | จุดที่ควรดู |
|---|---|
| `evaluation_templates` / `_items` | หัวข้อตั้งเองได้ แยกฟอร์มช่าง/office · `cadence` quarterly |
| `evaluations` | `technician_id` **หรือ** `employee_user_id` (ช่างยังไม่มีบัญชี) · `short_period` · **trigger freeze ตอน submit** · `delivered` = ผู้จัดการพิมพ์ใบแล้วนั่งคุย · `ck_eval_not_self` |
| `evaluation_answers` | คำตอบรายหัวข้อ |

**การอ่านผลประเมินถูก audit ด้วย** ไม่ใช่แค่ตอนเขียน — trigger มองไม่เห็น SELECT จึงบังคับที่ repository + integration test

---

## 0010 · แก้ของที่ผิด + เติมของที่ขาด (7 ตาราง + 1 view)

**แก้ที่เขียนพลาดใน 0001–0009**

| # | แก้อะไร |
|---|---|
| 1.1 | `jobs.bay` เป็น text ทั้งที่มีตาราง `bays` → เปลี่ยนเป็น `bay_id` FK |
| 1.2 | เลขไมล์เป็น text คำนวณประกันไม่ได้ → เพิ่ม `mileage_in_km` / `mileage_out_km` |
| 1.3 | `customers` ลบไม่ได้ ทั้งที่ `jobs` ลบได้ → เพิ่ม soft delete + `anonymised_at` |
| 1.4 | ไม่รู้ว่าใครติ๊กว่าทำแล้ว → `fulfilled_at` / `fulfilled_by` |
| 1.5 | จองคิวแล้วจ่ายมัดจำ ไม่ได้เชื่อมกัน → `deposits.booking_id` |
| 1.6 | VAT 7% hardcode → `shops.vat_rate` |

**ของที่ขาดทั้งเรื่อง**

| ตาราง | แก้ปัญหาอะไร |
|---|---|
| `warranty_terms` | เงื่อนไขประกันที่ตั้งไว้ใช้ซ้ำ — "แร็ค/ลูกหมาก OEM 1 ปี / 100,000 กม." |
| `warranties` | **ประกันต่ออะไหล่ ไม่ใช่ต่องาน** · เริ่มนับตอนส่งรถ · `expires_at` generated · เช็คทั้งวันและระยะทางด้วย `warranty_is_valid()` |
| `job_holds` | ช่วงที่งานหยุดรอ (รออะไหล่/รอลูกค้า/รอช่อง) — **KPI ความเร็วจะได้ไม่ตัดคะแนนช่างเพราะของไม่มา** |
| `stock_transfers` / `_lines` | โอนของระหว่างสาขาแบบจับคู่ได้ · ของยังไม่ถึงปลายทาง = ขึ้นรายการต้องตาม |
| `customer_consents` | ความยินยอม PDPA แยกตามวัตถุประสงค์ · marketing ถอนได้ |
| `data_subject_requests` | ลูกค้าขอดู/ขอลบ/ขอแก้ + บันทึกว่าร้านตอบว่าอะไร |
| `attention_items` (view) | **รวม 10 เรื่องที่ต้องตามวันนี้ไว้ที่เดียว** |

**`evaluations.stats_snapshot`** — ตัวเลขที่ผู้ประเมินเห็นตอนกรอก แช่แข็งไว้ เปิดดูปีหน้าตัวเลขต้องไม่เปลี่ยน

### PDPA ชนกับกฎหมายภาษี — แก้ยังไง

ลูกค้ามีสิทธิ์ขอลบ · ใบกำกับภาษีต้องเก็บหลายปี · สองอย่างนี้ขัดกัน

**ทางออกที่เลือก: anonymise ตัวลูกค้า แต่เก็บเอกสารที่ออกไปแล้ว** — `anonymise_customer()` ล้างชื่อ เบอร์ ที่อยู่ เลขภาษี ลบรูปรถ ถอนความยินยอมทั้งหมด แต่ snapshot ผู้ซื้อบนใบกำกับยังอยู่ เพราะการเก็บเป็นหน้าที่ตามกฎหมาย ซึ่ง PDPA เองยกเว้นให้

⚠️ นี่เป็นจุดยืนทางออกแบบ ไม่ใช่คำแนะนำทางกฎหมาย **ต้องให้บัญชีหรือทนายยืนยันก่อนใช้จริงครั้งแรก**

---

## Invariant ที่บังคับได้ที่ระดับฐานข้อมูล

ไม่ต้องพึ่งวินัยของคนเขียนโค้ด:

| # | บังคับยังไง |
|---|---|
| ข้อมูลไม่ข้ามสาขา | RLS policy ทุกตาราง (`apply_tenant_rls`) |
| อ่านข้ามสาขาได้ เขียนไม่ได้ | `WITH CHECK (shop_id = current_shop_id())` |
| เลขเอกสารไม่ซ้ำไม่ข้าม | `allocate_document_number()` + `UNIQUE(shop_id, series, year, seq)` |
| เอกสารออกแล้วแก้ไม่ได้ | trigger `documents_are_immutable` |
| ค่าแรงไม่มี VAT | `ck_labor_no_vat` |
| ใบกำกับต้องผูกบิล | `ck_tax_has_source` |
| ledger แก้ไม่ได้ | trigger `stock_moves_append_only` |
| ตัดสต๊อกซ้ำไม่ได้ | `UNIQUE(shop_id, idempotency_key)` |
| สต๊อกติดลบไม่ได้ | `ck_on_hand_nonneg` |
| ปรับสต๊อกต้องมีเหตุผล | `ck_adjustment_reason` |
| กรอกบิลซื้อซ้ำไม่ได้ | `UNIQUE(owner_group_id, supplier_id, supplier_invoice_no)` |
| จองคิวซ้อนไม่ได้ | `EXCLUDE USING gist` |
| เคลมประกันข้ามสาขาไม่ได้ | trigger `check_warranty_same_shop` |
| ประเมินตัวเองไม่ได้ | `ck_eval_not_self` |
| ประเมินส่งแล้วแก้ไม่ได้ | trigger `evaluations_freeze_on_submit` |
| โอนของต้องคนละสาขา | `ck_transfer_different` |
| เงื่อนไขประกันต้องมีอย่างน้อยหนึ่งอย่าง | `ck_term_has_limit` |
| ปฏิเสธคำขอ PDPA ต้องมีเหตุผลเขียนไว้ | `ck_dsr_outcome` |

---

## ยังไม่ได้ทำ

- **`0011_reporting.sql`** — view สำหรับรายงานภาษีขาย/ซื้อ · ฐาน KPI · สรุปเจ้าของ
- **seed script** — 2 กลุ่ม 6 สาขา 7 role ใช้เป็นฐานของเทส isolation
- **`kysely-codegen`** — generate `Database` interface จาก schema นี้
- API contract · screen inventory · sequence diagram ของ flow วิกฤต · glossary
