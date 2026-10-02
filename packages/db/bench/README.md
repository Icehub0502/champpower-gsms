# bench/

Scratch-only tooling used to measure 0020/0021's indexes (CLAUDE.md §11: "ใส่
index ตามที่ query ใช้จริง อย่าเดา — วัดด้วย `EXPLAIN` ก่อนเพิ่ม").

- `synthetic-data.sql` — generates the P3.1 catalog sizes from
  `P3.1-TECH-PLAN-v3.md` §4.1 (≈300 items/shop incl. 154 sets x 6 components,
  632 vehicle models, model prices for 536 models x 60 items/shop, 5,000
  vehicles/shop, 20,000 document lines/shop) across 2 shops.
- `explain-queries.sql` — the real queries the catalog/quotation endpoints run
  (search, price lookup, set expansion, document lines by document, set
  children, merge report, model matching, a cross-shop isolation probe),
  wrapped in one `BEGIN`/`SET LOCAL app.current_shop_id`/`COMMIT` so the RLS
  session variable actually survives across statements.

**Run these ONLY against a scratch database**, never `gsms`:

```bash
A=... # DATABASE_ADMIN_URL pointed at a scratch clone (CREATE DATABASE x TEMPLATE gsms)
psql -d "$A" -f packages/db/bench/synthetic-data.sql

APP=... # DATABASE_URL (gsms_app role) pointed at the same scratch clone
psql -d "$APP" -f packages/db/bench/explain-queries.sql
```

The measured plans and timings from this run are recorded in the `0020_catalog.sql` header, per CLAUDE.md §11. These two files are not run anywhere automatically; they exist so the next person who adds a 0020/0021-adjacent index can reproduce the same sizes instead of guessing.
