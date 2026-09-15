# WO-001 — แก้ช่องโหว่ชั้น auth (15 ข้อ)

> ใบสั่งงานจาก Cowork · 14 ก.ย. 2026 · **ทำก่อนเริ่ม W2**
> มาจากการรีวิวโดย security auditor อิสระ หลังจาก Cowork เขียนชั้น auth เสร็จ
> เจ้าของโค้ดตรวจเอง แล้วมองข้ามทั้ง 15 ข้อ — อย่าให้ซ้ำรอย: **ข้อไหนแก้แล้วต้องมีเทสคู่กัน**

## เริ่มที่ `gsms-lead`

มอบหมายตามนี้: `security-auditor` เป็นเจ้าของงานนี้ทั้งใบ · `backend-engineer` ลงมือ ·
`database-engineer` สำหรับข้อ 3 · `test-engineer` เขียนเทสทุกข้อที่ติดดาว

ไฟล์ที่เกี่ยวข้องทั้งหมด:
`apps/api/src/lib/jwt.ts` · `apps/api/src/lib/db.ts` · `apps/api/src/lib/socket.ts` ·
`apps/api/src/middleware/requireAuth.ts` · `apps/api/src/routes/auth.ts` · `apps/api/src/app.ts` ·
`packages/db/src/client.ts` · `packages/db/migrations/0001_foundation.sql`

---

## 🔴 ต้องแก้ก่อนอย่างอื่น

### ★ 1. การยกเลิกสิทธิ์ไม่ทำงาน — `/switch-shop` ต่ออายุ token ได้ไม่จำกัด

`requireAuth` ตรวจแค่ลายเซ็น JWT ไม่เคยอ่าน `sessions` เลย และ `/switch-shop` ออก access token
ใหม่โดย **ใช้ `jti` เดิม** พร้อม `exp` ใหม่ 15 นาที โดยไม่เช็ค `revoked_at` / `expires_at` / `is_active`

**ผลจริง:** เจ้าของไล่ช่างออกแล้วสั่ง revoke session ตามที่ระบบออกแบบไว้ ช่างไม่ต้องเรียก `/refresh`
แค่ยิง `/switch-shop` ด้วยสาขาตัวเองทุก 14 นาที ก็ได้ token ใหม่ตลอดไป — เกิน 15 นาที เกิน 30 วัน
ไม่มีวันหมด จนกว่าจะมีคนลบแถว `shop_memberships` ทิ้ง

**แก้:**
- `requireAuth` ต้องโหลด session ตาม `jti` ทุก request แล้วปฏิเสธเมื่อ `revoked_at IS NOT NULL`
  หรือ `expires_at < now()` (แคชสั้นๆ ได้ถ้ากังวลเรื่อง round-trip)
- `/switch-shop` ต้อง **ออก `jti` ใหม่ + แถว session ใหม่** ไม่ใช่ใช้ของเดิมซ้ำ —
  การใช้ `jti` ซ้ำคือสิ่งที่ทำให้วนลูปนี้มองไม่เห็นในตาราง session

### ★ 2. `users.is_active` เช็คแค่ตอนล็อกอิน และไม่มีทางยกเลิก session ของคนอื่น

`/refresh` อ่าน membership ใหม่ แต่ไม่เคยอ่าน `is_active` ซ้ำ — ผู้จัดการปิดบัญชีคนที่ลาออกด้วย
`UPDATE users SET is_active = false` ซึ่งเป็นสิ่งที่ทุกคนจะทำ แล้ว**ไม่มีผลอะไรเลย** refresh token
ยังออก access token ได้อีก 30 วัน

ซ้ำร้าย **ไม่มี endpoint ไหนยกเลิก session ของคนอื่นได้เลย** `/logout` ยกเลิกได้แค่ของตัวเอง

**แก้:**
- join `users` เข้าไปในการเช็ค session ของ `requireAuth` และ `/refresh` ปฏิเสธเมื่อ `is_active = false`
- เพิ่ม `POST /api/admin/users/:id/revoke-sessions` เฉพาะ `owner`/`manager`
- ยกเลิก session อัตโนมัติเมื่อลบ membership หรือปิดบัญชี

### ★ 3. `withShops` ลบข้ามสาขาได้ — คอมเมนต์ในโค้ดบอกผิด

`client.ts` เขียนไว้ว่า "เขียนไม่ได้เพราะ `WITH CHECK` ไม่ได้ตั้ง" **ถูกครึ่งเดียว**
ใน PostgreSQL `WITH CHECK` คุมเฉพาะแถวที่ถูกสร้างหรือแก้ (INSERT และแถวใหม่ของ UPDATE)
ส่วน **DELETE คุมด้วย `USING` อย่างเดียว** ซึ่ง policy ใน `0001` เขียนว่า

```sql
USING (shop_id = current_shop_id() OR shop_id = ANY (current_shop_ids()))
```

เท่ากับหน้ารวมกลุ่มที่มีคำสั่งลบ จะลบข้ามทุกสาขาในลิสต์ กระทบทั้ง 40 ตารางที่เรียก `apply_tenant_rls`

**แก้ — ทำทั้งสองอย่าง:**
- migration ใหม่: แยก policy เป็น `FOR SELECT USING (current_shop_id() OR ANY(current_shop_ids()))`
  กับ `FOR INSERT/UPDATE/DELETE USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id())`
- `withShops` สั่ง `SET TRANSACTION READ ONLY` หลัง BEGIN ให้ฐานข้อมูลบังคับเจตนา ไม่ใช่พึ่งความละเอียดของ policy

### ★ 4. ด่านกัน superuser เป็น regex บนสตริง ไม่ใช่ข้อเท็จจริงของ connection

`db.ts` เช็ค `/:\/\/postgres[:@]/` ซึ่งจับได้แค่ role ที่ชื่อ `postgres` เขียนตรงๆ ใน URL
จับไม่ได้: role อื่นที่เป็น superuser หรือมี `BYPASSRLS` · role เจ้าของตาราง ·
และ **`PGUSER=postgres` ใน environment กับ URL ที่ไม่ระบุ user** ซึ่งคนดีบักจะทำใน 30 วินาที

**แก้:** ตอนสตาร์ทให้ query จริง

```sql
SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
```

ไม่ยอมสตาร์ทถ้า `current_user <> 'gsms_app'` หรือธงใดธงหนึ่งเป็นจริง
บวก integration test: insert แถวของสาขา A → เปิด `withShop(B)` → ต้อง select ได้ 0 แถว
(เทสตัวนี้จะล้มทันทีถ้าต่อด้วย superuser ซึ่ง regex จับไม่ได้ตลอดกาล)

### ★ 5. login เป็น timing oracle — ไม่เรียก bcrypt เมื่อไม่มี user

`const ok = user?.is_active === true && (await compare(...))` — `&&` ลัดวงจร ถ้าไม่มี user
หรือบัญชีถูกปิด `compare` ไม่ถูกเรียกเลย เราใช้ `bcryptjs` ซึ่งเป็น JS ล้วน ช้ากว่า native หลายเท่า
cost 10 ใช้ราว 150–300 ms ส่วนทางที่ไม่มี user คือ SELECT ที่มี index ~2 ms —
**ต่างกันร้อยเท่า เห็นได้ด้วย `curl -w %{time_total}` ไม่ต้องใช้สถิติ**
และยังแยกออกได้อีกว่า "เคยทำงานที่นี่แต่ถูกปิดบัญชี" ต่างจาก "ไม่เคยมี"

**แก้:** แฮชรหัสหลอกไว้ตอนบูต แล้วเทียบกับมันเสมอเมื่อไม่มี user หรือบัญชีถูกปิด
และรวม `403 no_shop_membership` เข้าเป็น `401` เดียวกัน

### ★ 6. Express 4 ไม่จับ async error — ยิงรัวๆ แล้ว process ตาย

`express: ^4.21.1` ไม่จับ rejection จาก async handler (เพิ่งมีใน Express 5) ทุก route ใน `auth.ts`
เป็น async ที่ `await db...` โดยไม่มี try/catch ครอบ → เป็น unhandled rejection →
Node 24 ค่าเริ่มต้น `--unhandled-rejections=throw` → **process ตาย** และ error handler กลางใน `app.ts`
ไม่เคยทำงานเลยสำหรับ route พวกนี้

pool ตั้ง `max: 10` กับ `connectionTimeoutMillis: 5000` ส่วน `/me` ไม่มี rate limit —
ยิงพร้อมกันไม่กี่ร้อย request ก็ล้ม

**แก้:** ครอบทุก handler (`express-async-errors` หรือ wrapper เอง หรือย้ายไป Express 5) ·
`process.on('unhandledRejection')` เป็นพื้นขั้นต่ำ · ตั้ง `statement_timeout` และ
`idle_in_transaction_session_timeout` บน pool

---

## 🟠 ต้องแก้ ไม่ด่วนเท่า

### 7. rate limit นับ IP ของ proxy — คนเดียวล็อกได้ทั้งระบบ
ไม่มี `app.set('trust proxy', ...)` พออยู่หลัง nginx/Cloudflare `req.ip` เป็นของ proxy ทุก request
กลายเป็นถังเดียวรวม 20 ครั้ง/15 นาที — **ยิง 20 ครั้งแล้วทั้งอู่ล็อกอินไม่ได้ 15 นาที**
และจำกัดแค่ `/login` ส่วน `/refresh` `/switch-shop` `/me` ไม่มีเลย
แก้: ตั้ง trust proxy ตามจำนวน hop จริง · จำกัดทั้ง `/api/auth` · เพิ่มตัวนับต่อ `loginId`

### 8. socket — client ที่ไม่ได้ล็อกอินเลือกสาขาเองได้ และ room ไม่มีวันหมดอายุ
`socket.join('public:' + socket.handshake.auth.shopId)` คือ client บอกสาขาเอง ผิดกฎ §8 ข้อ 2
ที่กันไว้คือคอมเมนต์ว่า "public ส่งแค่สัญญาณ ไม่ส่งข้อมูล" แต่ `emitPublic` รับ payload ได้
และ socket ที่ล็อกอินตอน 9 โมง ยังรับข้อมูลตอน 5 โมงเย็น ไม่เคยตรวจ token ซ้ำ
แก้: `emitPublic` ตัดพารามิเตอร์ payload ออกให้ type บังคับ · เก็บ `exp` แล้วตัดการเชื่อมต่อเมื่อหมดอายุ

### 9. refresh token 30 วัน ไม่หมุน ไม่มี reuse detection
`device` เก็บไว้แต่ไม่เคยเทียบ · token เดิมใช้ได้ไม่จำกัดครั้งจากที่ไหนก็ได้ 30 วัน
ขโมยไปแล้วดูไม่ออก เพราะสัญญาณมาตรฐาน (token ที่ถูกหมุนแล้วถูกใช้ซ้ำ) ไม่มีในดีไซน์นี้
แก้: หมุน `jti` ทุกครั้งที่ refresh · เก็บ `replaced_by` · ถ้า token ที่ถูกแทนที่แล้วถูกใช้ซ้ำ
ให้ยกเลิกทั้งสายแล้วบันทึก · ลด TTL เหลือ 7–14 วันแบบ sliding

---

## 🟡 hardening

10. `/refresh` อ่าน `req.body.shopId` ดิบ นอก zod — ไม่พบทางโจมตีข้ามสาขา (เพราะ `find` จับได้เฉพาะ
    membership ที่มีจริง) แต่ผิดกฎ §8 ข้อ 2 ตามตัวอักษร **และมีบั๊กจริงซ่อนอยู่**: เมื่อไม่ส่ง `shopId`
    เงื่อนไขกลายเป็น `m.shop_id === m.shop_id` ซึ่งจริงเสมอ → refresh ทีไรเด้งกลับสาขาแรกทุกที
    แก้: ใส่ `shopId` เข้า zod เป็น optional uuid และให้ shop เดินทางไปกับ refresh token แทน
11. `/me` ซ่อน shop claim ที่ใช้ไม่ได้แทนที่จะ error — ควรตอบ 403 ให้ล็อกอินใหม่
12. **ตารางตัวตนไม่มี RLS เลย** (`users` `sessions` `shops` `shop_memberships` `owner_groups`)
    และ `unscoped` มี type เหมือน `withShop` เป๊ะ → `unscoped(db, t => shopRepo.list(t))` คอมไพล์ผ่าน
    แล้วคืน **ทุกสาขาของทั้งสองกลุ่ม** แก้: brand type ให้ต่างกัน + ใส่ policy บน `shops`/`shop_memberships`
13. `withShops` เชื่อลิสต์ที่ caller ส่งมา ไม่ตรวจอะไรเลย — ควรรับ `userId` แล้วไปดึงเองจาก membership
14. `as never` บนเส้นทางเขียนของการ revoke — ปิด type check ทั้งหมด ใช้ `Insertable<Sessions>` แทน
15. `jwt.verify` ไม่ pin `algorithms` — ปัจจุบันปลอดภัยเพราะ secret เป็น string แต่เป็นการพึ่ง
    พฤติกรรมของ dependency ใส่ `{ algorithms: ['HS256'] }` ให้ชัด

---

## เกณฑ์ผ่าน

- [ ] ข้อ 1–6 แก้ครบ **พร้อมเทสที่พิสูจน์ว่าช่องโหว่เดิมปิดแล้ว** (ไม่ใช่แค่เทสว่าโค้ดใหม่ทำงาน)
- [ ] เทสข้อ 1: revoke session แล้ว `/switch-shop` ต้องได้ 401
- [ ] เทสข้อ 3: `withShops` แล้วสั่ง DELETE ต้องถูกปฏิเสธ
- [ ] เทสข้อ 4: ต่อด้วย superuser แล้วแอปต้องไม่สตาร์ท
- [ ] เทสข้อ 5: เวลาตอบของ login ที่มี user กับไม่มี user ต่างกันไม่เกิน 20%
- [ ] `npm run typecheck -w apps/api` ผ่าน
- [ ] ข้อ 7–15 แก้หรือบันทึกเหตุผลว่าทำไมเลื่อน

**รายงานกลับมาที่ Cowork ตามรูปแบบใน `CLAUDE.md` §17**
