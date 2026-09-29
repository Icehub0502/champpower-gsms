# สถาปัตยกรรมและการตัดสินใจทางเทคนิค

> บันทึกการตัดสินใจ (ADR) ของ Champpower GSMS
> อ่านคู่กับ `CLAUDE.md` (กติกาที่บังคับใช้) และ `docs/SYSTEM_PLAN.md` (แผนธุรกิจ)
> ข้อที่ทำเครื่องหมาย 🟡 คือผมแนะนำไว้ ยังรอคุณยืนยัน

---

## 0. สรุปที่ตัดสินใจแล้ว

| เรื่อง | เลือก | เหตุผลสั้น ๆ |
|---|---|---|
| จุดเริ่มโค้ด | **Fork `ChamppowerD`** ไปโฟลเดอร์ใหม่ | เก็บ `packages/domain` + เทสที่เขียนใหม่จะเสียเวลาหลายอาทิตย์ |
| Query layer | **Kysely** | บังคับ `shop_id` ที่ระดับโครงสร้างได้ · type มาจาก schema จริง |
| **ฐานข้อมูล** | **PostgreSQL 16** (เปลี่ยนจาก MySQL) | transactional DDL + Row Level Security — สองอย่างที่ระบบนี้ต้องการมาก |
| ที่เก็บไฟล์ | **ไฟล์บนเครื่องเซิร์ฟเวอร์** | ใช้ได้กับ pm2 ทันที · ย้ายไป object storage ทีหลังโดยไม่แก้โค้ด |
| ออฟไลน์ | **กันงานหายอย่างเดียว** (outbox) | ได้ 90% ของปัญหาจริง โดยไม่ต้องแบก PWA เต็มรูป |

---

## 1. ฐานข้อมูล — **PostgreSQL 16**

เปลี่ยนจาก MySQL เพราะต้นทุนการย้ายตอน fork เกือบเป็นศูนย์ (ไม่ย้ายข้อมูลเก่าตาม SYS-14 และเฟส 2 จะรื้อ schema ใหม่อยู่แล้ว) แต่จะแพงขึ้นทุกเฟสที่ผ่านไป

**สี่อย่างที่ชี้ขาด**

1. **Transactional DDL** — migration ล้มกลางทางแล้ว rollback ทั้งก้อนเหมือนไม่เคยรัน
   ไม่มี staging + เฟส 0–11 แตะ schema แทบทุกเฟส + ร้านใช้งานอยู่จริง = ข้อนี้ข้อเดียวก็คุ้มแล้ว
2. **Row Level Security** — ตาข่ายชั้นที่สองกัน 2 กลุ่มเจ้าของเห็นกัน ถึงโค้ดพลาด DB ก็ไม่คืนแถว
3. **Exclusion constraint** — กันจองคิวซ้อนช่วงเวลาได้ที่ระดับ DB (QUE-07) ซึ่ง MySQL ทำไม่ได้ถ้าเวลาไม่ตายตัว
4. **JSONB + GIN** — audit log เก็บ before/after แล้ว query ได้จริง

**สิ่งที่ยอมเสียจาก MySQL และวิธีชดเชย**

- ค้นหาภาษาไทย: MySQL มี ngram parser พร้อมใช้ · PG ใช้ **`pg_trgm`** แทน (ติดตั้งไว้ใน `0001` แล้ว) สำหรับค้นชื่อลูกค้า/อะไหล่แบบคล้าย ๆ
- การเรียงลำดับภาษาไทย: ใช้ **ICU collation** `th-TH-x-icu` ที่คอลัมน์ที่ต้องเรียงตามพจนานุกรมจริง
- คุณไม่คุ้น PG: SQL เหมือนกัน ~95% ส่วนที่ต่างอยู่ใน `0001`/`0002` ให้ดูเป็นตัวอย่างแล้ว

**ข้อกำหนด** PostgreSQL **16+** · `UTF8` · extension: `pgcrypto` · `btree_gist` · `pg_trgm`

### RLS ทำงานยังไง

```
ทุก request  →  SET LOCAL app.current_shop_id = '<uuid จาก JWT>'
                ↓
policy ทุกตาราง:  USING  (shop_id = current_shop_id()
                          OR shop_id = ANY (current_shop_ids()))
                  WITH CHECK (shop_id = current_shop_id())
```

- **อ่านข้ามสาขาได้ เขียนไม่ได้** — `WITH CHECK` ผูกกับสาขาเดียวเสมอ หน้ารวมกลุ่มจึงอ่านได้แต่แก้ไม่ได้
- `current_shop_ids()` ตั้งโดย repository ระดับกลุ่มเท่านั้น และตั้งได้แค่สาขาที่ผู้ใช้มี membership จริง
- 🔴 **แอปต้องต่อ DB ด้วย role `gsms_app` ที่ไม่ใช่เจ้าของตาราง** — ถ้าต่อด้วย role เจ้าของ **RLS จะเงียบไปเฉย ๆ โดยไม่มี error** มีเทส integration จับข้อนี้โดยเฉพาะ
- migration รันด้วย role เจ้าของ ซึ่งข้าม RLS โดยตั้งใจ
- `CALL apply_tenant_rls('<table>')` เรียกหลังสร้างทุกตารางที่มี `shop_id` — policy จึงเขียนที่เดียว ไม่มีทางเขียนเพี้ยนคนละแบบ

### ไฟล์ migration ที่มีแล้ว

| ไฟล์ | มีอะไร |
|---|---|
| `0001_foundation.sql` | extension · helper · RLS machinery · `owner_groups` `shops` `users` `shop_memberships` `sessions` `audit_logs` `files` |
| `0002_core.sql` | `customers` `vehicles` `technicians` `teams` `team_members` `jobs` `job_workers` + ประวัติ/โน้ต/รูป · catalog ราคากลาง |

ที่เหลือออกตามเฟส: `0003` เลขที่เอกสาร · `0004` documents · `0005` payments/deposits · `0006` stock · `0007` purchasing · `0008` VAT · `0009` bookings · `0010` evaluations

## 2. โครงสร้าง monorepo

```
apps/
  api/        Express 4 · Kysely · socket.io · JWT          (ESM, tsx dev)
  web/        React 19 · Vite · react-router v6
packages/
  domain/     business rules ที่ pure + vitest               ← ยกมาจากของเดิมทั้งก้อน
  contracts/  zod schema + type ที่ api กับ web ใช้ร่วมกัน   ← ใหม่
  db/         Kysely schema types + migration runner        ← ใหม่
storage/      ไฟล์รูป/PDF (ไม่เข้า git)
docs/         SYSTEM_PLAN · TEAM · ARCHITECTURE · agents
```

**กติกา**

- `packages/domain` ยังห้าม import อะไรที่ผูก runtime — pure TS เท่านั้น
- `packages/contracts` เป็นแหล่งเดียวของ request/response schema — **web ห้ามประกาศ type ของ API เอง**
- `packages/db` ถือ `Database` interface ของ Kysely ซึ่ง **generate จาก schema จริงด้วย `kysely-codegen`** ไม่ใช่เขียนมือ
- ยังใช้ **npm workspaces** เฉย ๆ ยังไม่ต้อง Turborepo (โปรเจกต์ยังเล็กพอ)
- Node **24 LTS "Krypton"** — ตรวจสอบเมื่อ 12 ก.ย. 2026
  - Active LTS ตั้งแต่ ต.ค. 2025 · เข้าโหมด maintenance ต.ค. 2026 · หมดอายุ **เม.ย. 2028**
  - Node 20 และ 22 อยู่ในโหมด maintenance แล้วทั้งคู่ — ไม่เหมาะกับโปรเจกต์ที่เพิ่งเริ่ม
  - Node 26 จะขึ้นเป็น LTS 28 ต.ค. 2026 แต่ **ยังไม่ใช้** — ช่วงที่เพิ่งขึ้น LTS คือช่วงที่ native module (`sharp`, `pg`) มี prebuilt ไม่ครบที่สุด และโปรเจกต์นี้ไม่ได้ต้องการฟีเจอร์อะไรจาก 26
  - แผนขยับ: ไป Node 26 ราวกลางปี 2027 ตอน v24 เข้า maintenance ลึกแล้ว
  - ตรึงด้วย `.nvmrc` + `engines` ใน `package.json` + CI ทดสอบเวอร์ชันเดียว

---

## 3. Kysely — วิธีบังคับ tenant ที่ระดับโครงสร้าง

นี่คือเหตุผลหลักที่เลือก Kysely ไม่ใช่เพราะ type สวย

```ts
// packages/db/src/scoped.ts — ตัวอย่างแนวคิด ไม่ใช่โค้ดสุดท้าย
export async function withShop<T>(
  db: Kysely<Database>, shopId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    // RLS reads this. SET LOCAL dies with the transaction, so it can never
    // leak into the next request on a pooled connection.
    await sql`SET LOCAL app.current_shop_id = ${sql.lit(shopId)}`.execute(trx);
    return fn(trx);
  });
}
```

**ชั้นป้องกันสามชั้น ซ้อนกันโดยตั้งใจ**

| ชั้น | กันอะไร |
|---|---|
| `withShop()` + `SET LOCAL` | ทุก query ในทรานแซกชันถูก scope โดยอัตโนมัติ |
| RLS policy ที่ DB | ถึงลืม `WHERE` ก็ยังไม่คืนแถวข้ามสาขา |
| lint rule + เทส 2 กลุ่ม | จับตอน CI ก่อนขึ้น production |

- **route ไม่เคยเห็น `db` ตัวเปล่า** — middleware สร้าง `req.scoped` จาก `active_shop_id` ใน JWT แล้วส่งต่อ
- ตารางที่ไม่มี `shop_id` (`users`, `owner_groups`, `suppliers`) อยู่คนละ type list เรียกผ่าน scoped ไม่ได้
- query ข้ามสาขาสำหรับหน้ารวมกลุ่ม อยู่ที่ `db/group/*` เรียก `db` ตัวเปล่าอย่างจงใจ และรับ `shopIds` ที่ผ่าน membership แล้วเท่านั้น
- **lint rule**: ห้าม import `db` ตัวเปล่าจากใต้ `routes/` — ผิดคือ CI แดง

---

## 4. Migration

- ยังเป็น **ไฟล์ `.sql` เรียงเลข** ใน `packages/db/migrations/` — บัญชี/ใครก็อ่านออก และ rollback เขียนง่ายกว่า TypeScript
- **รันทั้งไฟล์ในทรานแซกชันเดียว** — PG รองรับ DDL ในทรานแซกชัน ล้มกลางทางแล้วกลับสู่สภาพเดิมทั้งก้อน นี่คือเหตุผลหลักที่ย้ายมา PG
- runner ต้องมีสามอย่าง:
  1. `schema_migrations(version, checksum, applied_at, applied_by)` — จับกรณีมีคนแก้ไฟล์ที่รันไปแล้ว
  2. **`pg_advisory_lock`** ก่อนรัน — สองเครื่องรัน migrate พร้อมกันไม่ได้
  3. `--dry-run` ที่พิมพ์ SQL ออกมาโดยไม่ commit
- Kysely มี migrator ของตัวเอง — **ไม่ใช้** เพราะจะทำให้ migration เป็น TypeScript ซึ่งคนอื่นอ่านยากกว่าและ rollback เขียนยากกว่า
- ทุกไฟล์ยังต้องมีคอมเมนต์หัวไฟล์: ทำอะไร · ทำไม · rollback SQL · ล็อกตารางนานแค่ไหน (ตาม `CLAUDE.md` §11)

---

## 5. ที่เก็บไฟล์ — และช่องโหว่ที่ตามมาทันที

```
storage/<shop_id>/<yyyy>/<mm>/<uuid>.<ext>
```

- DB เก็บแค่ **path + mime + ขนาด + ผู้อัปโหลด** ไม่เก็บ binary
- 🔴 **ห้ามเสิร์ฟด้วย `express.static` เด็ดขาด** — รูปเป็นของลูกค้าแต่ละสาขา ถ้าเสิร์ฟเป็น static ใครเดา path ถูกก็เปิดดูได้ข้ามสาขา
  ต้องผ่าน endpoint ที่ **ตรวจ JWT + ตรวจว่า `shop_id` ของไฟล์ตรงกับ `active_shop_id`** ก่อนทุกครั้ง
- รูปที่หน้า public (`/lookup`) ต้องใช้ **signed URL หมดอายุ** ไม่ใช่ path ตรง
- ย้ายไป object storage ทีหลัง = เปลี่ยน adapter ตัวเดียว → เขียนเป็น `StorageAdapter` interface ตั้งแต่วันแรก
- backup ต้องครอบ `storage/` ด้วย ไม่ใช่แค่ dump DB — **เอกสารภาษีอยู่ในนั้น**

---

## 6. ออฟไลน์ — outbox ไม่ใช่ PWA

```
ผู้ใช้กดบันทึก → เขียนลง IndexedDB outbox → พยายามส่ง
                                              ├─ สำเร็จ → ลบออกจาก outbox
                                              └─ ล้มเหลว → ค้างไว้ ลองใหม่แบบ backoff
```

- ทุกรายการใน outbox มี **`idempotency_key` ที่ client สร้าง** และส่งไปกับ request
- backend เก็บ key ที่เคยรับแล้ว → ส่งซ้ำได้ผลลัพธ์เดิม ไม่เกิดซ้ำ
- **ข้อนี้ต่อกับกฎ idempotency ของสต๊อกพอดี** (`CLAUDE.md` §6.3) — ใช้กลไกเดียวกัน ไม่ต้องสร้างสองอย่าง
- UI ต้องบอกชัดว่ามีกี่รายการที่ยังส่งไม่สำเร็จ และห้ามบอกว่า "บันทึกแล้ว" ถ้ายังอยู่ใน outbox
- **ไม่ทำ**: อ่านข้อมูลออฟไลน์ · แก้ข้อมูลออฟไลน์แล้ว merge · service worker cache ทั้งแอป

---

## 7. Auth

- **Access token** JWT อายุ 15 นาที เก็บ **ในหน่วยความจำของหน้าเว็บ** ไม่ใช่ localStorage
  payload: `user_id · active_shop_id · role · jti`
- **Refresh token** อายุ **14 วัน** เก็บใน **httpOnly + Secure + SameSite=Strict cookie** (ชื่อ `gsms_rt` · `Path=/api/auth`)
  - 14 วันไม่ใช่ 30 — WO-001 ลดลงมาโดยเจตนา และมี **rotation** อยู่แล้ว คนที่ใช้งานประจำจึงไม่มีวันเจอเพดานนี้เลย คนที่ถูกบังคับล็อกอินใหม่คือคนที่หายไปเกินสองสัปดาห์ ซึ่งควรยืนยันตัวใหม่อยู่แล้ว
  - `assertRefreshTtl()` ใน `apps/api/src/lib/startupChecks.ts` **ไม่ให้ boot ขึ้น** ถ้า `JWT_REFRESH_TTL` เกิน 14 วัน — เพราะ default ในโค้ดกันได้แค่กรณีที่ไม่มีใครตั้งค่า ซึ่งไม่เคยจริงในของที่ deploy จริง
  - refresh token **ไม่เคยถูกส่งกลับเป็น JSON** และ `/api/auth/refresh` อ่านจาก cookie ทางเดียว ไม่มี fallback ใน body แม้แต่หลัง test flag
- `sessions(id, user_id, jti, device, issued_at, revoked_at)` — ไล่พนักงานออกแล้วตัดสิทธิ์ได้ทันที
- **สลับสาขา = endpoint ที่ตรวจ membership แล้วออก access token ใหม่** ไม่ใช่ส่ง `shopId` มากับ request (`CLAUDE.md` §8)
- รหัสผ่าน **bcrypt** cost 12 (มีอยู่แล้วในโปรเจกต์)
- rate limit ที่ `/api/auth/login` และทุก endpoint ที่เขียนข้อมูล

---

## 8. API

- **`/api/v1/...` ตั้งแต่วันแรก** — ใส่ทีหลังเจ็บกว่า
- REST · response สำเร็จคืน object/array ตรง ๆ · ผิดพลาดคืน `{ error, message?, fields? }`
- ทุก list endpoint paginate ด้วย **cursor** ไม่ใช่ offset (ตารางโตแล้ว offset ช้าขึ้นเรื่อย ๆ)
- zod schema จาก `packages/contracts` ทั้งขาเข้าและขาออก
- socket.io ยังใช้ต่อ · room `authed:${shopId}` / `public:${shopSlug}` · **emit หลัง commit เท่านั้น ไม่ใช่ใน transaction**

---

## 9. Frontend 🟡

- **TanStack Query** แทน `useCollection`/`useDocument` ที่เขียนมือ — 7 โมดูลจะทำให้ hook เดิมเอาไม่อยู่ และ query ให้ cache/refetch/optimistic มาฟรี
- socket event → `queryClient.invalidateQueries` ไม่ใช่ยัด payload เข้า state ตรง ๆ
- **react-hook-form + zod resolver** ใช้ schema ตัวเดียวกับ backend
- ฟอร์มที่ยาว (ใบเสนอราคา · ใบกำกับซื้อ) ต้อง autosave draft ลง IndexedDB
- CSS: ใช้ `styles/globals.css` ที่มีอยู่ต่อ **ไม่เพิ่ม CSS framework ใหม่**
- แตก `JobDetailPage.tsx` (33KB) ก่อนเริ่มเพิ่มฟีเจอร์

---

## 10. การทดสอบ

| ชั้น | เครื่องมือ | ครอบอะไร |
|---|---|---|
| domain | vitest (มีแล้ว) | เงิน · VAT · ledger · status flow · เลขที่เอกสาร |
| api integration | vitest + **PostgreSQL จริงใน docker-compose** | tenant isolation · RLS · transaction · concurrency |
| e2e | Playwright (มีในเครื่องแล้ว) | เฉพาะ flow วิกฤต: รับรถ→อนุมัติ→เบิกของ→ปิดบิล→ออกใบกำกับ |

**เทสที่ต้องมีก่อน merge ทุกครั้งที่แตะ query**: สร้าง 2 กลุ่มเจ้าของ 6 สาขา แล้วพิสูจน์ว่ากลุ่ม A query กลุ่ม B ได้ 0 แถว
**เทส RLS ที่ต้องมี**: ต่อ DB ด้วย role `gsms_app` แล้วยิง `SELECT * FROM jobs` โดย**ไม่ตั้ง** `app.current_shop_id` → ต้องได้ 0 แถว (ไม่ใช่ทุกแถว)
**เทสที่จับความผิดพลาดร้ายแรงที่สุด**: พิสูจน์ว่า connection ของแอป**ไม่ได้**เป็นเจ้าของตาราง — ถ้าเป็น RLS จะเงียบไปโดยไม่มี error
**เทส concurrency ที่ต้องมี**: ยิงออกเลขเอกสาร 100 request พร้อมกัน → 100 เลข ไม่ซ้ำ ไม่ข้าม

---

## 11. Seed และข้อมูลทดสอบ

สคริปต์ `npm run seed:dev` สร้าง:
- กลุ่ม A (ดอนเมือง · ประชาอุทิศ · วงเวียนใหญ่ · อยุธยา) · กลุ่ม B (สมุทรปราการ · เพชรเกษม)
- ผู้ใช้ครบ 7 role ในแต่ละสาขา
- ร้านอะไหล่ · SKU · งานตัวอย่างในทุกสถานะ

เทส isolation ใช้ seed ชุดนี้ — ไม่ใช่ mock

---

## 12. Logging และ error 🟡

- **pino** เขียน JSON · มี `request_id` · `shop_id` · `user_id` ทุกบรรทัด
- **ห้าม log ชื่อลูกค้า เบอร์โทร ทะเบียนรถ** ลง log ที่เก็บไว้
- error handler กลางอยู่แล้วใน `app.ts` — ห้าม leak stack trace
- ยังไม่ต้องต่อ Sentry ตอนนี้ (ยังไม่มี VPS) แต่เขียน logger ให้ต่อทีหลังได้

---

## 13. Git และการทำงานกับ agent 🟡

- **branch ต่องาน** ชื่อ `fix/01-api-key-leak`, `feat/doc-numbering` — agent ทำงานบน branch ไม่แตะ `main`
- commit message แบบ conventional (`fix:`, `feat:`, `refactor:`)
- ทุก branch ต้องผ่านเกตรีวิวใน `docs/TEAM.md` ก่อน merge
- `.env` ต้องอยู่ใน `.gitignore` และ **เปลี่ยน key ทุกตัวหลังย้ายออกจาก OneDrive** (FIX-10)
- 🟡 ยังไม่มี remote/CI — ถ้าจะมี แนะนำ GitHub private + Actions รัน `typecheck` + `test` เท่านั้นก่อน

---

## 14. Deploy ตอนนี้

- pm2 + ngrok บนเครื่องส่วนตัว (ตามที่ตกลง) — `ecosystem.config.cjs` เดิมใช้ได้
- MySQL local
- **ที่ต้องทำแม้ยังไม่มี VPS**:
  - `pg_dump -Fc` + สำรอง `storage/` อัตโนมัติรายวัน ไปไดรฟ์คนละลูก
  - **ทดสอบ restore จริงหนึ่งรอบ** แล้วจดวันที่ไว้ — backup ที่ยังไม่เคย restore ไม่นับ
  - health check endpoint + pm2 auto-restart (มีแล้ว)
- **`@champpower/domain` ถูกอ่านจากที่ไหน — แยกทีละเส้นทาง** (ยืนยันจริง 29 ก.ย. 2026 ด้วยการย้าย `packages/domain/dist` ออกไปชั่วคราว
  เส้นทางไหนยังทำงานได้ตอนไม่มี `dist` = พิสูจน์ว่าอ่านจาก `src` · ทุกบรรทัดยืนยันด้วย `--traceResolution` หรือรันจริง ไม่ได้อนุมานจาก config)

  | เส้นทาง | อ่านจาก | กลไก | หลักฐาน (ตอนไม่มี `dist`) |
  |---|---|---|---|
  | เทสของ api (`npm test -w apps/api`) | `src` | alias ใน `apps/api/vitest.config.ts` | เทสผ่าน |
  | typecheck ของ api (`npm run typecheck -w apps/api`) | `src` | `customConditions: ["gsms-source"]` ใน `apps/api/tsconfig.json` | exit 0 · trace → `src/index.ts` |
  | dev ของ api (`npm run dev -w apps/api`) | `src` | `tsx watch --conditions=gsms-source` | trace → `src/index.ts` · dev server เปิดและตอบ endpoint ที่ใช้ domain ได้ |
  | **production** (`node lib/index.js`) | **`dist`** | ค่า `default` ใน `exports` (ไม่มี condition) | trace → `dist/index.js` · **ไม่มี `dist` = รันไม่ขึ้น (`ERR_MODULE_NOT_FOUND`)** |
  | build ของ api (`npm run build -w apps/api`) | `dist` (d.ts) | `tsconfig.build.json` ล้าง `customConditions` เป็น `[]` · `prebuild` build domain ก่อน | ไม่มี `dist` ก็ build ผ่าน เพราะ `prebuild` สร้างให้ · `lib/` ไม่มีไฟล์ของ domain |
  | เว็บ: tsc · vitest · vite build | `src` | `paths` ใน `tsconfig.app.json` · alias ใน `vitest.config.ts` และ `vite.config.ts` | trace → `src/index.ts` · เทสผ่าน · build exit 0 |

  **สิ่งที่ต้องจำตอน deploy:** production คือเส้นทางเดียวที่อ่าน `dist` ตอนรัน
  `npm run build -w apps/api` build domain ให้เองผ่าน `prebuild` จึงไม่มีทางได้ `dist` ค้างของเก่าถ้า build ผ่านคำสั่งนี้
  แต่กติกาของ domain ที่ production รันมาจาก `packages/domain/dist` ไม่ใช่จาก `lib/` — ถ้า `dist` ค้างของเก่า (เช่น pull โค้ดใหม่แล้วรัน `node lib/index.js` โดยไม่ build ใหม่) ระบบจะรันกติกาเก่า**โดยไม่มี error เตือน**
  (สถานะงาน · การลากการ์ด · เบอร์หลอก) — **ห้ามใส่ `--conditions=gsms-source` ใน production**: `node` ไม่ได้ออกแบบมาให้รัน `.ts` ของ domain ตรง ๆ
- วันที่มี VPS: reverse proxy + TLS + สำรองนอกเครื่อง + monitoring

---

## 15. ที่ยังไม่ตัดสิน

- ~~Node 20 หรือ 22~~ → **ตัดสินแล้ว: Node 24 LTS** (ดูหัวข้อ runtime)
- ตั้ง PG บน Windows ด้วย installer ทางการ หรือ Docker Desktop
- TanStack Query หรือเขียน hook เองต่อ
- มี GitHub remote + CI ไหม
- ชื่อโฟลเดอร์/repo ใหม่
