# แผนระบบ Champpower GSMS — คิว / เอกสาร / สต๊อก / VAT / หลายร้าน

> เอกสารนี้คือแผนสถาปัตยกรรมและรายการช่องโหว่พร้อมวิธีแก้
> อ่านคู่กับ `.claude/CLAUDE.md` (กติกาที่บังคับใช้)
> สถานะ: ร่างสำหรับตัดสินใจ — ข้อที่ทำเครื่องหมาย 🔴 ต้องได้คำตอบก่อนเริ่มเขียนโค้ด

---

## 0. สรุปสิ่งที่ตัดสินใจไปแล้ว

| เรื่อง | ที่เลือก |
|---|---|
| ห้อง VAT | เอกสารชุดที่ 2 บนบิลเดิม — ติดธง vatable ที่ระดับบรรทัด แล้วออกใบกำกับภาษีเฉพาะบรรทัดนั้น |
| **โหมด VAT** | มี 3 โหมด: `none` (ปกติ) / `add_7` ลูกค้าขอเอง จ่ายเพิ่ม 7% / `include_7` บริษัทอยากได้ VAT เก็บลูกค้ายอดเดิม **ร้านรับภาระ 7%** |
| **VAT คิดจากอะไร** | **เฉพาะค่าของ** — ค่าแรงไม่เข้า VAT เด็ดขาด |
| **ใบกำกับผูกกับอะไร** | **บิลจริง + ลูกค้าจริงที่ขอ** ห้ามออกลอย ๆ ไม่ผูกบิล |
| **ลูกค้าเลือก VAT ตอนไหน** | **ได้ทั้งตอนเสนอราคาและตอนจ่ายเงิน** และหน้าเก็บเงิน**ต้องถามทุกบิล** ว่าเอาใบกำกับไหม |
| **การอนุมัติ** | **ลูกค้าอนุมัติรายบรรทัด** แล้วเซ็นบนใบเสนอราคา — บรรทัดที่ไม่อนุมัติ **ต้องคงอยู่บนเอกสาร** เพื่อตรวจย้อนหลังได้ |
| **ใบแจ้งซ่อม** | เด้งออกทันทีตอนกดอนุมัติ ดึงเฉพาะบรรทัดที่อนุมัติ |
| **ทำไม่ครบ** | **ใบเสร็จเก็บตามที่ทำจริง** ต้องติ๊กยืนยันทีละบรรทัดก่อนออกใบเสร็จ ของที่จองไว้คืนอัตโนมัติ |
| **ค่าแรง** | คิดแยกเป็นบรรทัดชนิด `labor` แต่ไม่เข้าใบกำกับ ไม่ตัดสต๊อก |
| **ของไม่พอตอนอนุมัติ** | **อนุมัติได้ + เตือนให้สั่งซื้อ** ไม่บล็อก แต่ยอด on_hand ห้ามติดลบ |
| **ข้อมูลบริษัท** | ร้านจดในนามบริษัท — เลข 13 หลัก/รหัสสาขา/ที่อยู่ ทำเป็น**ช่องว่างในหน้าตั้งค่า** กรอกทีหลังได้ตลอด |
| ความลึกของสต๊อก | เต็มรูปแบบ — PO + supplier + ใบรับเข้า + lot/serial + reorder point |
| หลายร้าน | multi-tenant **3 ชั้น**: กลุ่มเจ้าของ → สาขา → พนักงาน · เจ้าของ login บัญชีเดียว สลับสาขาได้ + มีหน้ารวมกลุ่ม · ผู้จัดการสาขาสร้างบัญชีพนักงานในสาขาตัวเองได้ · `login_id` unique ทั้งระบบ |
| แชร์ข้ามสาขา | **เฉพาะรายชื่อร้านอะไหล่** — ลูกค้า สต๊อก ราคากลาง เอกสาร ไม่แชร์ · หนี้แยกต่อสาขา · เคลมประกันได้เฉพาะสาขาที่ทำ |
| ชนิดข้อมูลเงิน | migrate VARCHAR → DECIMAL(12,2) ก่อนเริ่มงานใหม่ |

### สายเอกสารที่ตกลงกันแล้ว

```
ใบรับรถ ──▶ ใบเสนอราคา ──(ลูกค้าติ๊กอนุมัติทีละรายการ + เซ็น)──▶ FREEZE
                 │                                                  │
                 │                          ┌───────────────────────┤
                 │                          ▼                       ▼
                 │                    ใบแจ้งซ่อม               จองสต๊อก
                 │                 (เฉพาะบรรทัด approved)   (เฉพาะ approved)
                 │                          │                       │
                 │                          ▼  ช่างทำจริง           ▼ ตัดจริงตอนเบิก
                 │                    ยืนยัน "ทำครบไหม"
                 │                          │
                 └──────────────────────────▼
                                        ใบเสร็จ  =  approved ∩ ทำจริง
                                            │
                                   (ถ้าลูกค้าขอ VAT)
                                            ▼
                                   ห้อง VAT ──▶ ใบกำกับภาษี (+7% เฉพาะบรรทัด vatable)
                                                     │
                                                     ▼
                                            รายงานภาษีขาย → บัญชี/สรรพากร
```

---

## 1. ระบบตอนนี้เป็นยังไง

**สแตก:** npm workspaces monorepo — `apps/api` (Express 4 + mysql2 + socket.io + JWT), `apps/web` (React 19 + Vite + react-router v6), `packages/domain` (business rules ที่ pure + vitest)

**สิ่งที่ทำได้แล้วและทำได้ดี**

- แยก business rule ออกมาไว้ที่ `packages/domain` พร้อมเทส — เป็นรากฐานที่ดีมาก ระบบใหม่ควรต่อยอดตรงนี้
- Status flow ครบ: `received → inspecting → quoted → [approved | scheduled | rejected] → repairing → aligning → ready → delivered` + `carout`
- มีหน้า launcher หลัง login แล้ว (`HomeLauncherPage`) — โครงที่คุณอยากได้ "แยก dashboard" มีอยู่แล้วครึ่งทาง
- แยก socket room `authed` / `public` เพื่อไม่ให้ข้อมูลลูกค้ารั่วไปหน้าจอสาธารณะ — คิดมาดี
- Soft delete + ถังขยะ + audit บางส่วน (`technicianHistory`, `statusHistory`)

**สิ่งที่ยังไม่มีเลย**

- ไม่มีตาราง **เอกสาร** ใด ๆ — ใบเสนอราคา/ใบเสร็จ/ใบกำกับ ยังเป็นการ render จาก `job` สด ๆ
- ไม่มีตาราง **สต๊อก** ใด ๆ — `master_parts` มีแค่ชื่อกับหมวด ไม่มีจำนวน ไม่มีต้นทุน ไม่มี SKU
- ไม่มี **VAT** ที่ใดเลยในฐานข้อมูล
- ไม่มี **shop_id** — เป็น single-tenant ล้วน
- ไม่มี **การจองคิวล่วงหน้า** (มี `appointmentDate` ช่องเดียวบน job ไม่มี capacity ไม่มีตารางเวลา)
- Role มีแค่ `admin` / `staff`

---

## 2. โครงระบบใหม่: 5 โมดูล + สันหลังกลาง

```
                        ┌─────────────────┐
   login ──────────────▶│  Launcher       │  (มีแล้ว — ขยายเป็น 5 การ์ด + กรองตาม role)
                        └────────┬────────┘
        ┌───────────────┬────────┼────────┬───────────────┐
        ▼               ▼        ▼        ▼               ▼
   ① คิว/รับรถ    ② ใบงาน   ③ เอกสาร   ④ สต๊อก      ⑤ ห้อง VAT
   booking         job      quotation   ledger        tax invoice
   check-in        status   work order  PO/receipt    credit note
   queue board     photos   receipt     reserve/issue accountant view
        │               │        │        │               │
        └───────────────┴────────┴────────┴───────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │  packages/domain        │  money, tax, ledger, numbering
                    │  (pure + tested)        │
                    └─────────────────────────┘
```

**หลักคิดที่สำคัญที่สุดของทั้งระบบ**

> **Job คืองาน — เอกสารคือภาพนิ่งของงาน ณ เวลาหนึ่ง — สต๊อกคือบัญชีการเคลื่อนไหว**
> สามอย่างนี้เป็นคนละชั้นกัน ห้ามยุบรวม

ทำไมถึงสำคัญ: ตอนนี้ราคาอยู่บน `job_parts_needed` ตรง ๆ ถ้าออกใบเสนอราคาให้ลูกค้าไปแล้ว แล้วมีคนแก้ราคาในใบงานทีหลัง **ใบที่พิมพ์ไปกับในระบบจะไม่ตรงกัน และไม่มีทางรู้ว่าเคยเสนอไปเท่าไหร่** พอมีสต๊อกกับ VAT เข้ามา ปัญหานี้จะกลายเป็นบัญชีไม่ลง

---

## 3. ช่องโหว่ + วิธีแก้

### 🔴 A. ช่องโหว่ระดับ blocker — ต้องแก้ก่อนเขียนโมดูลใหม่

| # | ช่องโหว่ | เกิดอะไรขึ้นจริง | วิธีแก้ |
|---|---|---|---|
| A1 | **เอกสารไม่ immutable** | แก้ราคาในใบงานหลังส่งใบเสนอราคา → เอกสารที่ลูกค้าถืออยู่กับในระบบไม่ตรงกัน เถียงกันไม่จบ | ตาราง `documents` + `document_lines` ที่ snapshot ชื่อ/ราคา/จำนวน/ยี่ห้อ ณ ตอนออก แก้ = ออกเวอร์ชันใหม่ ไม่ UPDATE |
| A2 | **ราคาเป็น VARCHAR** | `parseFloat("1,200")` = `1` — ยอดหายไป 1,199 บาทเงียบ ๆ; พอมี VAT ยอดสองใบจะไม่ตรงกัน | migrate เป็น `DECIMAL(12,2)` แบบ expand→backfill→switch→contract (ดู agent `migration-safety-engineer`) |
| A3 | **gen เลขที่แบบอ่านแล้วเขียน** | `genJobNumber(await listJobs(true))` — รับรถพร้อมกันสองเครื่อง ได้เลขซ้ำ → ชน `uq_jobs_job_number` → พนักงานเห็น error 500 | counter table + `SELECT ... FOR UPDATE` ใน transaction เดียวกับ INSERT |
| A4 | **API key รั่วถึง browser** | `GET /api/config` คืน `settings.aiApiKey` / `geminiApiKey` เป็น plaintext ให้ทุกคนที่ล็อกอิน — เปิด devtools ก็ได้ key ไปใช้ | ย้าย key ไป env, endpoint คืนแค่ `{ hasClaudeKey, hasGeminiKey }` |
| A5 | **ไม่มี tenant scope** | พอเพิ่มร้านที่สอง ลืม `WHERE shop_id` แม้แต่ query เดียว = ข้อมูลลูกค้าข้ามร้าน | บังคับผ่าน repository layer + integration test 2 ร้านทุก PR |
| A6 | **socket room ไม่แยกร้าน** | ทุกคนที่ล็อกอิน join `'authed'` เหมือนกันหมด → ร้าน A ได้ payload ของ job ร้าน B แบบเต็มแถว | `authed:${shopId}` / `public:${shopSlug}` และ join จาก `active_shop_id` ใน token เท่านั้น |
| A8 | 🔴 **เชื่อ `shopId` ที่ client ส่งมา** — กับดักของโครงสร้าง 3 ชั้น ถ้าทำ "สลับสาขา" ด้วยการส่ง `shopId` มากับ request เจ้าของกลุ่ม A จะอ่านกลุ่ม B ได้ทันที | `active_shop_id` อยู่ใน JWT · สลับสาขา = endpoint ที่ตรวจ membership แล้วออก token ใหม่ · ทุก request ตรวจซ้ำว่า membership ยังอยู่ |
| A9 | 🔴 **ยกระดับสิทธิ์ตัวเอง** — `manager` สร้าง user role `owner` หรือเพิ่ม membership ให้ตัวเองในสาขาอื่น | ห้ามสร้าง/แก้ role สูงกว่าหรือเท่าตัวเอง · ห้ามเพิ่ม membership ในสาขาที่ตัวเองไม่มีสิทธิ์ · ห้ามแก้ role ตัวเอง · ห้ามถอด `owner` คนสุดท้าย |
| A7 | **`listJobs()` โหลดทั้งตาราง** | `POST /api/jobs` เรียก `listJobs(true)` เพื่อ gen เลข → ทุกครั้งที่รับรถ 1 คัน ดึงทุก job + `SELECT *` ที่มี LONGTEXT thumb ติดมาด้วย | pagination + gen เลขจาก counter (ไม่ต้องโหลด list เลย) + เลิก `SELECT *` |

### 🟠 B. ช่องโหว่ของโมดูลสต๊อก (จะเจอตอนทำ ถ้าไม่กันไว้)

| # | ช่องโหว่ | วิธีแก้ |
|---|---|---|
| B1 | **ตัดสต๊อกซ้ำ** — กดอนุมัติสองครั้ง / เน็ตหลุดแล้ว retry / socket reconnect | `idempotency_key` = `{ref_type}:{ref_id}:{line_id}:{type}` + `UNIQUE INDEX` ระดับฐานข้อมูล ไม่ใช่เช็คใน JS |
| B2 | **ตัดผิดจังหวะ** — ตัดตอนเสนอราคา ของถูกกันไว้ทั้งที่ลูกค้ายังไม่ตกลง | สองจังหวะ: `reserve` ตอนอนุมัติ → `issue` ตอนช่างเบิก/ปิดงาน; หน้าจอดู `available = on_hand − reserved` |
| B3 | **Lost update** — สองคนตัดของชิ้นเดียวกันพร้อมกัน ยอดหายไปหนึ่งรายการ | ledger append-only + `SELECT ... FOR UPDATE` บน balance row ใน transaction |
| B4 | **ยกเลิกงานแล้วของไม่คืน** | ทุก flow ที่ย้อน (reject / void / ลบบรรทัด) ต้องมี `unreserve` / `return` คู่กัน — ทำเป็น test case |
| B5 | **"ตัดมือ" กลายเป็นช่องขโมยของ** | จำกัด role + บังคับกรอกเหตุผล + audit log + รายงาน "การปรับสต๊อกด้วยมือรายวัน" ให้เจ้าของเห็น |
| B6 | **ไม่มีทางรู้ว่าตัดผิด** — ทั้งที่คุณขอ manual override *เพราะ* ระบบอาจตัดผิด | หน้ากระทบยอด: ของในบิล vs ของที่ตัดจริง vs ของที่นับได้ ต่างเมื่อไหร่ขึ้นแดง |
| B7 | **อะไหล่ในบิลเป็นข้อความอิสระ** — `job_parts_needed.name` เป็น VARCHAR ที่พิมพ์มือได้ ตัดสต๊อกไม่ได้ | เพิ่ม `sku_id` (nullable ช่วงเปลี่ยนผ่าน) + UI บังคับเลือกจาก catalog สำหรับของที่มีสต๊อก + รายงาน "บรรทัดที่ยังไม่ผูก SKU" |
| B8 | **ต้นทุนย้อนหลังเปลี่ยน** — ถ้าอ่าน `avg_cost` ปัจจุบันมาคำนวณกำไรของบิลเก่า ตัวเลขจะขยับทุกครั้งที่รับของเข้า | เก็บ `unit_cost` ลงบนแถว `issue` ตอนตัด ห้ามคำนวณย้อนหลัง |

### 🟠 C. ช่องโหว่ของห้อง VAT

| # | ช่องโหว่ | วิธีแก้ |
|---|---|---|
| C1 | ~~inclusive หรือ exclusive~~ **ตอบแล้ว: ต้องรองรับทั้งสอง** `add_7` (ลูกค้าขอ จ่ายเพิ่ม) และ `include_7` (บริษัทขอ ร้านรับภาระ) | helper เดียวใน `packages/domain/src/rules/vat.ts` รับ `vat_mode` เป็นพารามิเตอร์ ห้ามคำนวณเองที่อื่น |
| C1b | 🔴 **ลูกค้าเซ็นที่ยอด 1,000 แล้วมาขอ VAT ตอนจ่าย → ยอดกลายเป็น 1,070** ลูกค้าอาจไม่ยอมจ่ายส่วนต่าง ทะเลาะกันหน้าเคาน์เตอร์ | ใบเสนอราคา**แสดงสองยอดตั้งแต่ต้นเสมอ**; เปลี่ยนไป `add_7` หลังเซ็น → ต้องออก rev ใหม่ + เซ็นใหม่; เปลี่ยนไป `include_7` ไม่ต้องเซ็นใหม่ (ยอดลูกค้าเท่าเดิม) แต่ต้องเข้า audit log |
| C1c | **บางบรรทัด vatable บางบรรทัดไม่ (ค่าแรง) → ยอดใบกำกับ ≠ ยอดบิล** พนักงานจะงงว่าเก็บเงินเท่าไหร่ | VAT คิดจากเฉพาะบรรทัด `part` ที่ vatable; หน้าจอเก็บเงินแตกยอดให้เห็นทุกครั้ง (ค่าของ / ค่าแรง / VAT / รวม) |
| C1e | 🔴 **`include_7` กินกำไรร้าน 7% ต่อบิลแบบเงียบ ๆ** — บิล 1,000 ร้านได้จริง 934.58 ทำไปเรื่อย ๆ ไม่มีใครรู้ว่าปีนึงหายไปเท่าไหร่ | รายงาน **"VAT ที่ร้านรับภาระ"** รายเดือน/รายปี + แสดงเตือนที่หน้าจอตอนเลือกโหมดนี้ว่าจะหักกำไรไปเท่าไหร่ |
| C1f | **ปัดเศษ inclusive ไม่ลงตัว** — ปัด base กับ vat แยกกันแล้วรวมได้ 999.99 หรือ 1,000.01 บนใบกำกับ | `vat = round(vatable / 1.07 * 0.07, 2)` แล้ว `base = vatable − vat` เสมอ + มีเทสยืนยัน `base + vat == total` |
| C1g | **ค่าแรงหลุดเข้าใบกำกับ** เพราะระบบเดิมไม่แยกค่าของกับค่าแรง — ทุกอย่างอยู่ใน `job_parts_needed` เหมือนกันหมด | เพิ่ม `line_type` (`part`/`labor`/`fee`); `labor` บังคับ `is_vatable = false` ที่ระดับ domain ไม่ใช่แค่ UI |
| C1d | **ใบกำกับลอย** — ออกใบกำกับที่ไม่ผูกบิล/ลูกค้าจริง เพราะสะดวกกว่า | บังคับ `source_document_id` + `customer_id` NOT NULL ที่ระดับ schema ไม่ใช่แค่ที่ UI |
| C2 | **เลขที่ใบกำกับข้าม/ซ้ำ** | counter แยกชุด แยกร้าน แยกปี + lock ใน transaction; เลขที่ยกเลิกยังคงอยู่ในลำดับ |
| C3 | **ลบเอกสารภาษี** | ห้าม hard delete ห้าม soft delete — ยกเลิกคือ `void` + ใบลดหนี้ |
| C4 | **ถอยสถานะหลังออกใบกำกับ** — `prevStatusOf` ถอยได้อิสระอยู่ตอนนี้ | block การถอยข้ามจุดที่มีเอกสารเลข ต้อง void ก่อน |
| C5 | **ไม่มีเลขประจำตัวผู้เสียภาษีของลูกค้าในระบบ** — ตาราง `customers` มีแค่ชื่อกับเบอร์ | เพิ่ม `tax_id(13)`, `branch_code`, `legal_name`, `address` ที่ `customers` และ `shops` — **ต้องมีก่อนเริ่มทำห้อง VAT** |
| C6 | **template เปลี่ยนแล้วเอกสารเก่าเปลี่ยนตาม** | เก็บ PDF snapshot ของทุกเอกสารภาษี ไม่ render ใหม่ |
| C7 | **ปัดเศษไม่เหมือนกันระหว่างจอ/พิมพ์/export** | กำหนดกฎเดียว (ปัดต่อบรรทัดแล้วรวม) ใส่ใน `packages/domain` แล้วเรียกที่เดียวทุกที่ |

### 🟠 F. ช่องโหว่ของ flow อนุมัติรายบรรทัด (ใหม่ — มาจากรอบคุยล่าสุด)

| # | ช่องโหว่ | วิธีแก้ |
|---|---|---|
| F1 | **ลบบรรทัดที่ลูกค้าไม่อนุมัติทิ้ง** — พอลูกค้ากลับมาถามว่า "ทำไมไม่เปลี่ยนตัวนี้ให้" ไม่มีหลักฐานว่าเคยเสนอไปแล้ว | บรรทัด `declined` **คงอยู่บนเอกสารและบนใบพิมพ์** พร้อมเครื่องหมายชัดเจน ห้ามลบ ห้ามซ่อน |
| F2 | **ยอดรวมสับสน** — พนักงานเห็นยอดเดียวแล้วเก็บเงินผิด | ใบเสนอราคาแสดงสองยอดคู่กันเสมอ: `ยอดเสนอทั้งหมด` / `ยอดที่อนุมัติ` และยอดที่ผูกไปใบเสร็จคือยอดที่อนุมัติ |
| F3 | **แก้ใบเสนอราคาหลังลูกค้าเซ็น** — ราคาที่ลูกค้าเซ็นกับที่เรียกเก็บไม่ตรงกัน นี่คือปัญหาที่ร้ายแรงที่สุดของ flow นี้ | ลายเซ็น = จุด freeze; ลายเซ็นเก็บบน `documents` ไม่ใช่บน `jobs`; แก้ = ออก rev ใหม่ + เซ็นใหม่ |
| F4 | **ลูกค้าอนุมัติเพิ่มระหว่างซ่อม** (เจอปัญหาเพิ่มตอนถอด) แล้วไปแก้ rev เดิม | ออก rev 2 ที่อ้าง `supersedes_document_id` ไป rev 1; rev 1 ยังอยู่ในระบบเป็นหลักฐาน |
| F5 | **ช่างเห็นรายการที่ลูกค้าไม่อนุมัติ แล้วทำไปเลย** → ทำฟรี + ตัดสต๊อกฟรี | ใบแจ้งซ่อมดึงเฉพาะ `approved`; รายการ `declined` แสดงแยกโซนเป็น "ไม่อนุมัติ — ห้ามทำ" |
| F6 | **ใบเสร็จ auto จากใบเสนอราคาแบบตรง ๆ** — ช่างทำไม่ครบ (ทำไม่ได้/อะไหล่ไม่มา) แต่ใบเสร็จเก็บเต็ม | ต้องมีจังหวะยืนยัน "ทำจริงครบไหม" ก่อนออกใบเสร็จ; ใบเสร็จ = `approved ∩ ทำจริง` และน้อยกว่าใบเสนอราคาได้ |
| F7 | **บรรทัดที่ยังไม่ตัดสินใจ (`pending`) ค้างตลอดกาล** ไม่มีใครตาม | มีหน้า "ใบเสนอราคาที่ลูกค้ายังไม่ตอบ" + แจ้งเตือนเมื่อค้างเกิน N วัน (ต่อยอดจาก `StuckJobsPage` ที่มีอยู่) |
| F8 | **จองสต๊อกทั้งใบ** ทั้งที่ลูกค้าอนุมัติแค่บางรายการ → ของถูกกันไว้เกินจริง | `reserve` ผูกที่ `document_line_id` ไม่ใช่ที่ `document_id` |

### 🟡 D. ช่องโหว่ของโมดูลคิว/จอง

| # | ช่องโหว่ | วิธีแก้ |
|---|---|---|
| D1 | จองซ้อน — ช่าง/ช่องซ่อมเดียวกัน เวลาเดียวกัน สองใบจอง | capacity model: `bays` × `time_slot` + `UNIQUE (shop_id, bay_id, slot)` ที่ฐานข้อมูล ไม่ใช่เช็คใน JS |
| D2 | คิวจองล่วงหน้าชนกับคิว walk-in หน้าร้าน | รวมสองอย่างเป็นคิวเดียวที่มี `source: 'booking' \| 'walkin'` และจัดสรรช่องจากตารางเดียวกัน |
| D3 | จองแล้วไม่มา (no-show) กินคิวคนอื่น | สถานะ `no_show` + ปล่อยช่องอัตโนมัติเมื่อเลยเวลา + นับสถิติ no-show ต่อลูกค้า |
| D4 | `queueNo` gen จาก list เหมือน job number → เลขซ้ำ | counter ต่อร้านต่อวัน |
| D5 | ลูกค้าจองผ่านหน้า public แล้วยิงถี่ ๆ | rate limit + CAPTCHA เบา ๆ + ยืนยันด้วย OTP/LINE ก่อนล็อกช่อง |

### 🟡 E. ช่องโหว่ทั่วไปที่เจอในโค้ดปัจจุบัน

| # | เรื่อง | วิธีแก้ |
|---|---|---|
| E1 | `PATCH /api/jobs/:id` ส่ง `...req.body` เข้า `updateJob` ทั้งก้อน (mass assignment) | zod schema ที่ขอบ route แล้วสร้าง patch object เอง |
| E2 | `POST /api/jobs` สร้าง customer → vehicle → job **ไม่อยู่ใน transaction** ถ้าพังกลางทางเหลือ customer/vehicle ค้าง | ครอบด้วย transaction เดียว |
| E3 | รูปเก็บเป็น base64 ใน LONGTEXT + `SELECT *` + body limit 25MB | ย้ายไปไฟล์/object storage, เก็บแค่ path; ระยะสั้น: แยกคอลัมน์รูปออกจาก query หลัก |
| E4 | JWT ไม่มี refresh/revoke — พนักงานลาออกแล้ว token ยังใช้ได้ | refresh token + ตาราง revoke + `jti` |
| E5 | ไม่มี rate limit / helmet / audit log กลาง | เพิ่มทั้งสาม; audit log จำเป็นมากเมื่อมีเงินและสต๊อก |
| E6 | CORS fallback `'*'` | บังคับ origin จริงใน production |
| E7 | `replaceTechnicians` ใช้ DELETE-ALL แล้ว INSERT ใหม่ → id เปลี่ยนทุกครั้ง | เปลี่ยนเป็น upsert; ตอนนี้รอดเพราะ `job.technician` เก็บเป็นชื่อ ไม่ใช่ FK แต่เป็น anti-pattern ที่จะระเบิดตอนทำรายงานต่อช่าง |
| E8 | Role มีแค่ `admin`/`staff` | เพิ่ม `owner`/`manager`/`advisor`/`technician`/`accountant`/`viewer` และเช็คที่ backend ทุก endpoint |
| E9 | โปรเจกต์อยู่ใน **OneDrive** พร้อม `node_modules` และไฟล์ `.env` จริง | ย้าย repo ออกจาก OneDrive (sync ทำไฟล์ล็อคและ build พัง) + ยืนยันว่า `.env` อยู่ใน `.gitignore` แล้ว secret ไม่ได้ sync ขึ้น cloud |
| E10 | `JobDetailPage.tsx` 33KB ไฟล์เดียว | แตกก่อนเพิ่มฟีเจอร์ใหม่ ไม่งั้นทุกโมดูลใหม่จะไปกองที่นี่ |
| E11 | ยังรันผ่าน pm2 + ngrok บนเครื่องส่วนตัว | วางแผน production: VPS + reverse proxy + TLS + backup อัตโนมัติรายวัน + monitoring ก่อนขายให้ร้านอื่น |

---

## 4. โครงตารางที่จะเพิ่ม (ร่าง)

```
-- ตัวตนและสิทธิ์: 3 ชั้น
owner_groups(id, name, created_at)                    -- กลุ่มเจ้าของ
shops(id, owner_group_id, name, legal_name, tax_id, branch_code, address,
      phone, slug, plan, created_at)                  -- สาขา
users(id, login_id, password_hash, name, created_at)  -- ตัวตน, UNIQUE(login_id) ทั้งระบบ
                                                      -- login_id = อีเมล หรือ username สำหรับช่างที่ไม่มีอีเมล
shop_memberships(id, user_id, shop_id, role, created_at, created_by)
  -- UNIQUE (user_id, shop_id) · role อยู่ที่นี่ ไม่ใช่ที่ users
  -- เจ้าของ 4 สาขา = 1 user + 4 rows role='owner'

-- ตัวอย่างข้อมูลจริง
--   group A: ดอนเมือง · ประชาอุทิศ · วงเวียนใหญ่ · อยุธยา
--   group B: สมุทรปราการ · เพชรเกษม

-- เอกสาร
document_counters(shop_id, series, year, next_no)            -- ล็อกด้วย FOR UPDATE
  -- ชุดเอกสาร: QUO ใบเสนอราคา · WO ใบแจ้งซ่อม · REC ใบเสร็จ · TAX ใบกำกับ · DEP ใบรับเงินมัดจำ
documents(id, shop_id, job_id, customer_id, type, series, number, revision,
          supersedes_document_id, source_document_id,
          status /* draft|signed|issued|void */,
          vat_mode /* none|add_7|include_7 */,
          vat_absorbed_amount,  -- ใช้เมื่อ include_7: ส่วนที่ร้านรับภาระ ใช้ทำรายงาน
          offered_total,        -- ยอดเสนอทั้งหมด (รวมบรรทัดที่ไม่อนุมัติ)
          approved_total,       -- ยอดที่ลูกค้าอนุมัติ  ← ยอดนี้ผูกไปใบเสร็จ
          discount, vat_base, vat_amount, grand_total,
          -- snapshot คู่สัญญา ณ วันออก (ห้าม join สดจาก customers/shops)
          buyer_legal_name, buyer_tax_id, buyer_branch_code, buyer_address,
          seller_legal_name, seller_tax_id, seller_branch_code, seller_address,
          signature_customer, signed_at, issued_at, issued_by, pdf_path)
document_lines(id, document_id, source_line_id, sku_id,
               line_type /* part|labor|fee */,   -- labor/fee ไม่ตัดสต๊อก ไม่เข้า VAT
               name_snapshot, brand_snapshot, qty, unit, unit_price, line_total,
               is_vatable,                       -- labor บังคับ false
               approval_status /* pending|approved|declined */, decided_at,
               fulfilled_qty,   -- ทำจริงเท่าไหร่ ติ๊กยืนยันก่อนออกใบเสร็จ
               sort_order)
vehicle_offered_items(id, shop_id, vehicle_id, document_line_id, name, offered_at,
                      status /* declined|later */)   -- รายการที่เคยเสนอ ไว้เสนอซ้ำครั้งหน้า

-- สต๊อก
skus(id, shop_id, code, name, category, unit, is_vatable_default, reorder_point,
     stocking_policy /* stocked | buy_to_order */, ...)
  -- buy_to_order = ซื้อเฉพาะงาน ไม่มี reorder point ไม่เข้ารายงานของค้าง
  --                แต่มี balance/ต้นทุน/ประวัติครบเหมือนกัน
  -- ซื้อซ้ำถึงเกณฑ์ (เช่น 3 ครั้ง/90 วัน) → ระบบแนะนำให้เปลี่ยนเป็น stocked
suppliers(id, shop_id, name, tax_id, ...)
-- suppliers เป็น "ระดับกลุ่ม" อย่างเดียวที่แชร์ข้ามสาขา
suppliers(id, owner_group_id, name, category, tax_id, branch_code, address,
          payment_terms /* cash|credit_N|monthly_statement */, credit_days)
  -- แต่หนี้/ใบกำกับซื้อ/ใบวางบิล/การจ่ายเงิน ยังแยกต่อสาขา (มี shop_id)
purchase_orders / purchase_order_lines

-- ใบกำกับซื้อ: กรอกครั้งเดียว เกิด 3 อย่าง — ของเข้าสต๊อก + หนี้เจ้าหนี้ + ภาษีซื้อ
purchase_invoices(id, shop_id, supplier_id,
                  supplier_invoice_no, invoice_date, due_date,
                  subtotal, vat_amount, grand_total,
                  has_vat_credit,        -- false เมื่อซื้อจากร้านที่ไม่จด VAT
                  status /* open|partially_paid|paid|void */,
                  entered_by, created_at)
  -- UNIQUE (owner_group_id, supplier_id, supplier_invoice_no)  กันกรอกบิลซ้ำ
  -- ระดับกลุ่ม ไม่ใช่ระดับสาขา เพราะเลขบิลของร้านอะไหล่ไม่ซ้ำอยู่แล้ว
  -- จึงจับได้ด้วยว่าสาขาหนึ่งเผลอกรอกบิลของอีกสาขา
purchase_invoice_lines(id, purchase_invoice_id, sku_id, name_typed,
                       qty, unit, unit_cost, line_total, is_vatable, sort_order)

supplier_statements(id, shop_id, supplier_id, period, total_claimed, status)
supplier_statement_lines(id, statement_id, purchase_invoice_id, matched /* bool */)
supplier_payments(id, shop_id, supplier_id, purchase_invoice_id, amount,
                  method, paid_at, paid_by)   -- append-only ตัดทีละใบ ห้ามลงยอดรวมลอย ๆ

-- คืนของให้ร้านอะไหล่: กลับครบสามทางเหมือนตอนซื้อ
purchase_returns(id, shop_id, purchase_invoice_id, supplier_credit_note_no,
                 returned_at, returned_by, subtotal, vat_amount, grand_total)
purchase_return_lines(id, purchase_return_id, purchase_invoice_line_id, sku_id, qty, unit_cost)
  -- ห้ามแก้ใบกำกับซื้อใบเดิม เดือนนั้นอาจยื่นภาษีไปแล้ว

goods_receipts / goods_receipt_lines                          -- ที่ avg_cost ขยับ
stock_lots(id, shop_id, sku_id, lot_no, serial, expiry, qty_remaining, unit_cost)
stock_moves(id, shop_id, sku_id, lot_id, supplier_id, type, qty, unit_cost,
            ref_type, ref_id, ref_line_id, idempotency_key UNIQUE,
            reason, user_id, created_at)                      -- append-only
            -- supplier_id: ทุกชิ้นต้องรู้ว่ามาจากร้านไหน
stock_balances(shop_id, sku_id, on_hand, reserved, avg_cost, updated_at)
purchase_suggestions(id, shop_id, sku_id, qty_needed, document_line_id,
                     status /* open|ordered|done */, created_at)  -- ของขาดตอนอนุมัติ

-- งาน
-- jobs เดิม + เพิ่ม:
--   job_type /* normal|warranty_claim */, parent_job_id
--   งานเคลม: ยอดเรียกเก็บ 0 แต่ตัดสต๊อกจริง ไม่เข้ารายได้ เข้าเฉพาะต้นทุน

-- คิว
bays(id, shop_id, name, capacity)
bookings(id, shop_id, customer_id, vehicle_id, bay_id, slot_start, slot_end,
         source, status, job_id, created_at)                  -- UNIQUE(shop_id,bay_id,slot_start)

-- รับเงินลูกค้า
payments(id, shop_id, document_id, deposit_id, method /* cash|transfer|card|deposit_offset */,
         amount, change_given, received_by, received_at)      -- append-only หลายแถวต่อบิลได้
         -- จ่ายไม่ครบ = บล็อกการปิดบิล (ร้านไม่เคยมีลูกค้าค้างจ่าย)

-- มัดจำ: เอกสารของตัวเอง แต่ปุ่มอยู่บนหน้าใบรับรถ/ใบเสนอราคา
deposits(id, shop_id, customer_id /* บังคับ */,
         job_id /* nullable */, vehicle_id /* nullable */,
         channel /* walk_in|page|line|phone */, slip_photo /* สลิปโอน สำหรับมัดจำออนไลน์ */,
         amount, reason /* booking|special_part|large_job */, method,
         expected_date /* บังคับ: นัดว่าจะเอารถมาวันไหน */,
         status /* held|applied|refunded|forfeited */, applied_to_document_id,
         received_by, received_at,
         closed_at, closed_by, close_reason /* ใช้ทั้งตอนคืนและตอนริบ */)
  -- เลย expected_date = ขึ้นเตือนทันทีในหน้า "มัดจำค้างอยู่" พร้อมสองปุ่ม คืน / ริบ
  -- ริบได้เฉพาะ manager ขึ้นไป · ริบแล้วเข้ารายได้วันที่ริบ แยกประเภทจากค่าซ่อม
  -- ห้ามริบอัตโนมัติเมื่อครบกำหนด — ตัดสินเป็นเคส ๆ เสมอ
  -- ผูกกับ "ลูกค้า" ไม่ใช่ "งาน" — มัดจำออนไลน์เกิดก่อนรถมาถึงร้าน
  -- มัดจำที่ยัง held = หนี้ของร้าน ต้องมีหน้า "มัดจำค้างอยู่"
  -- ตอนเปิดงานใหม่ ถ้าเบอร์โทรตรงกับ deposit ที่ held → เตือน + ปุ่มผูกเข้างาน
daily_closings(id, shop_id, business_date, expected_cash, counted_cash,
               variance, closed_by, closed_at)

-- ทีมช่าง และใครทำจริง
teams(id, shop_id, name, lead_technician_id)
team_members(id, team_id, technician_id)
job_workers(id, job_id, technician_id, role /* lead|helper */)   -- ติ๊กตอนปิดงาน หลายคนได้
  -- jobs เพิ่ม: assigned_team_id, assigned_technician_id (nullable ทั้งคู่)
  -- shops เพิ่ม: assignment_mode /* team|individual|none */

-- ประเมินพนักงาน (ผู้ประเมิน = manager / assistant_manager เท่านั้น)
evaluation_templates(id, shop_id, name, target /* technician|office */,
                     cadence /* quarterly — ไตรมาสตามปฏิทิน */)
evaluation_template_items(id, template_id, label, scale_max, sort_order)
evaluations(id, shop_id, employee_user_id, template_id,
            period_start, period_end, evaluator_user_id,
            status /* draft|submitted|delivered */,
            supersedes_evaluation_id, revise_reason,
            submitted_at, delivered_at, delivered_by)
  -- delivered = ผู้จัดการพิมพ์ใบสรุปแล้วนั่งคุยกับพนักงาน แล้วยื่นให้
  -- ช่างไม่ต้อง login — ไม่มีช่องให้พนักงานเขียนตอบในระบบ
evaluation_answers(id, evaluation_id, template_item_id, score, comment)
  -- submitted แล้วแก้ไม่ได้ · แก้ = ออกฉบับใหม่ที่อ้างฉบับเดิม
  -- audit log ทั้งตอนอ่านและตอนเขียน

-- อื่น ๆ
audit_logs(id, shop_id, actor_id, action, entity_type, entity_id, before, after, at)
```

---

## 5. แผนเป็นเฟส (ทำตามลำดับ ห้ามข้าม)

> ⚠️ **ตารางข้างล่างนี้ล้าสมัยแล้ว — แผนตัวจริงอยู่ที่ `docs/TEAM.md`**
>
> เขียนไว้ตอนที่เข้าใจว่าเริ่มจากศูนย์ ความจริงคือ `stock-system` ที่สมุทรปราการใช้อยู่มี 37 ตาราง 33 หน้าจอ
> และมีข้อมูลจริง — เฟส 0–5b ส่วนใหญ่**ทำเสร็จและใช้งานอยู่แล้ว**
>
> ข้อที่ยกเลิก: **SYS-14 (ไม่ย้ายข้อมูล)** ต้องย้ายจริง · **FIX-02 (เงินเป็น VARCHAR)** เป็นปัญหาของ `ChamppowerD` เท่านั้น
> อ่านตารางนี้ในฐานะ**รายละเอียดของแต่ละเรื่อง** ไม่ใช่ลำดับการทำงาน

| เฟส | สิ่งที่ทำ | agent หลัก | เกณฑ์ผ่าน |
|---|---|---|---|
| **0. ปิดรูรั่ว** | A4 (API key), E1 (zod), E2 (transaction), E6 (CORS), E9 (OneDrive/.env) | `security-auditor`, `backend-engineer` | ไม่มี secret ออกจาก API; ทุก mutation ผ่าน schema |
| **1. เงินเป็น DECIMAL** | A2 — survey → quarantine → migrate → verify | `migration-safety-engineer`, `database-engineer` | ยอดรวมทุกงานก่อน/หลัง migrate ตรงกันทุกบาท |
| **2. Multi-tenant 3 ชั้น** | A5, A6, `owner_groups` / `shops` / `users` / `shop_memberships`, `shop_id` ทุกตาราง, unique key ต่อสาขา, `active_shop_id` ใน JWT + endpoint สลับสาขา, role matrix | `database-architect`, `security-auditor` | เทส 2 กลุ่ม 6 สาขา: กลุ่ม A query กลุ่ม B = 0 แถว · ส่ง `shopId` ที่ไม่มี membership มาทาง body → 403 · `manager` สร้าง `owner` ไม่ได้ |
| **2b. หน้ารวมกลุ่ม** | repository `group*` แยกไฟล์ อ่านอย่างเดียว `WHERE shop_id IN (memberships)` | `backend-engineer`, `security-auditor` | เจ้าของเห็นเฉพาะสาขาที่ตัวเองมี membership ไม่ใช่ทุกสาขาในกลุ่ม |
| **3. เลขที่เอกสาร + counter** | A3, D4, C2 | `backend-engineer` | ยิงพร้อมกัน 100 request ได้ 100 เลข ไม่ซ้ำ ไม่ข้าม |
| **4. โมดูลเอกสาร + อนุมัติรายบรรทัด** | A1, F1–F8 — documents/document_lines, approval_status, ลายเซ็น freeze, revision, gate ที่ backend, PDF snapshot | `solution-architect`, `backend-engineer`, `api-designer` | แก้ job แล้วเอกสารที่เซ็นแล้วไม่ขยับ; ใบแจ้งซ่อมมีเฉพาะบรรทัด approved; บรรทัด declined ยังพิมพ์ออกมาเห็น |
| **5. โมดูลสต๊อก** | B1–B8 — ledger, reserve/issue (office กดตอนของมากองหน้าห้อง), สแกน QR เบิกของ, ตัดมือ + เกณฑ์วงเงิน, ซื้อด่วน/`buy_to_order`, กระทบยอด | `inventory-ledger-engineer`, `backend-engineer` | invariant ทั้ง 8 ข้อผ่านเทส |
| **5b. รับเงิน + มัดจำ + ปิดบิล** | payments, มัดจำ (รวมมัดจำออนไลน์ผ่านเพจ + เตือนตอนเปิดงาน), เงินทอน, สรุปยอดรายวัน, ปิดกะ | `backend-engineer` | `SUM(payments) = grand_total` จึงปิดได้; เงินสดที่ควรมีเทียบกับที่นับได้ |
| **6. ฝั่งซื้อ: ใบกำกับซื้อ + เจ้าหนี้** | suppliers, purchase_invoices (กรอกมือ), เข้าสต๊อก + หนี้ + ภาษีซื้อ ในครั้งเดียว, ใบวางบิลรอบเดือน, จ่ายเงินร้านอะไหล่, PO/lot | `inventory-ledger-engineer`, `backend-engineer` | กรอกบิลซ้ำไม่ได้; ทุกชิ้นในสต๊อกรู้ว่ามาจากร้านไหน; ยอดค้างต่อร้านตรงกับผลรวมบิลที่ยังไม่จ่าย |
| **6b. เคลมประกัน** | `job_type`, `parent_job_id`, ตัดสต๊อกแต่ไม่เข้ารายได้, รายงานต้นทุนประกัน | `backend-engineer` | งานเคลมไม่โผล่ในรายได้; ของยังหายจากคลังจริง |
| **7. ห้อง VAT** | C1–C7 + ภาษีซื้อดึงจากเฟส 6 ไม่กรอกซ้ำ | `thai-tax-compliance`, `backend-engineer` | ยอดใบกำกับกระทบกับยอดที่ลูกค้าจ่ายได้; เลขที่ไม่ข้าม; ภาษีขาย/ซื้อ export ได้ทั้งคู่ |
| **8. โมดูลคิว/จอง** | D1–D5 + หน้าจองสาธารณะ | `product-analyst`, `frontend-engineer` | จองซ้อนไม่ได้ที่ระดับฐานข้อมูล |
| **9. Launcher + role** | ขยาย launcher เป็น 5 การ์ด กรองตาม role | `frontend-engineer`, `ux-advocate` | แต่ละ role เห็นเฉพาะที่ตัวเองมีสิทธิ์ |
| **10. Production** | E11 — VPS, TLS, backup, monitoring | `devops-engineer`, `observability-engineer` | restore จาก backup สำเร็จจริงหนึ่งรอบ |

---

## 6. คำถามที่ยังเหลือ

### ✅ เคลียร์แล้วทั้งหมดสำหรับเฟส 5–7

- **ใครกดเบิกของ** → พนักงาน office กด ตอนอะไหล่มากองรอหน้าห้องสต๊อก
- **สแกน QR** → ยกมาจากระบบเดิม ใช้ที่หน้าจอเบิกของ
- **อะไหล่ซื้อเฉพาะงาน** → ผ่านสต๊อกเสมอ ผ่าน "ซื้อด่วน" + `stocking_policy = buy_to_order`
- **ตัดสต๊อกด้วยมือ** → เปิดถึง `advisor` (office) + บังคับเหตุผล + รายงานรายวัน + เกณฑ์วงเงินที่เกินแล้วต้องผู้จัดการอนุมัติ
- **มัดจำ** → เอกสารของตัวเอง (`deposits`) แต่ปุ่มอยู่บนหน้าใบรับรถ/ใบเสนอราคา
- **จ่ายไม่ครบ** → บล็อกการปิดบิล ร้านไม่เคยมีลูกค้าค้างจ่าย
- **ใบกำกับให้บุคคลธรรมดา** → ออกได้ถ้ามีเลขผู้เสียภาษี 13 หลัก ใช้ชื่อ/ที่อยู่ตามบัตรประชาชน
- **ใบลดหนี้** → ร้านไม่ออก ไม่ทำ UI แต่เก็บ `credit_note` ไว้ใน schema และมี `void` แทน
- **คืนของให้ร้านอะไหล่** → กลับครบสามทาง: สต๊อก + หนี้ + ภาษีซื้อ ผ่าน `purchase_returns`

### 🔴 ต้องตอบก่อนเริ่มเฟส 7 (ห้อง VAT)

4. ~~ร้านจดในนามอะไร~~ **ตอบแล้ว: บริษัท** — เลข 13 หลัก/รหัสสาขา/ที่อยู่ ทำเป็นช่องว่างในหน้าตั้งค่า กรอกทีหลัง
5. ~~ค่าแรงเสีย VAT ไหม~~ **ตอบแล้ว: ไม่เสีย เอาแค่ค่าของ** → เพิ่ม `line_type`
6. **ลูกค้าบุคคลธรรมดาที่ไม่มีเลขผู้เสียภาษี ขอใบกำกับได้ไหม** — ถ้าได้ ต้องใช้เลขบัตรประชาชนแทน ยังไม่ได้คำตอบ

### 🟡 ตอบทีหลังได้ แต่ควรตอบก่อนเฟส 2

7. ~~หลายร้าน = สาขาหรือขายให้อู่อื่น~~ **ตอบแล้ว: กลุ่มเจ้าของ 2 กลุ่ม 6 สาขา** โครงสร้าง 3 ชั้น
8. ~~ราคากลางแชร์ข้ามสาขาไหม~~ **ตอบแล้ว: ไม่แชร์** แชร์เฉพาะรายชื่อร้านอะไหล่
9. ~~ประกันข้ามสาขา~~ **ตอบแล้ว: เคลมได้เฉพาะสาขาที่ทำ**
10. **ช่างที่ไม่มีอีเมลจะ login ด้วยอะไร** — ผมออกแบบ `login_id` ให้เป็นอีเมล **หรือ** username ไว้แล้ว แต่ต้องตัดสินใจว่าจะใช้รูปแบบไหน (เช่น `spk.somchai`) และใครเป็นคนตั้งรหัสผ่านครั้งแรก
11. **เจ้าของแฟรนไชส์ Champ Power ควรเห็นข้ามกลุ่มไหม** — ถ้าใช่ ต้องมี role ระดับแพลตฟอร์มเหนือ `owner` ซึ่งยังไม่ได้ออกแบบ
12. **พนักงานย้ายสาขา** — ถอด membership เก่าแล้วเพิ่มใหม่ หรือให้มีสองสาขาพร้อมกันชั่วคราว

### ข้อสังเกตที่อยากให้ยืนยันกับบัญชี

- **ค่าแรงไม่ออก VAT** — ผู้ประกอบการที่จด VAT โดยทั่วไปต้องเรียกเก็บภาษีขายจากทั้งการขายสินค้าและการให้บริการ การไม่คิด VAT กับค่าแรงเป็นเรื่องที่ควรให้บัญชีของร้านยืนยันว่าทำได้ในบริบทของร้าน ระบบจะทำตามที่ตกลง แต่ควรมีคนยืนยัน
- **`include_7` (ร้านรับภาระ 7%)** ในทางบัญชีคือการขายแบบราคารวม VAT ซึ่งทำได้ปกติ แค่ต้องรู้ว่ากำไรลดลง 7% — ระบบจะมีรายงานให้เห็นตัวเลขนี้ชัด ๆ
- ระบบจะไม่ยอมออกใบกำกับที่ไม่ผูกบิลจริง เพราะเป็นเงื่อนไขที่ตรวจย้อนกลับได้ — ถ้าบัญชีมีวิธีทำงานอื่น ต้องคุยกันก่อนเปลี่ยน
