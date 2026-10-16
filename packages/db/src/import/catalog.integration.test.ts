/**
 * Tier-2 test: the catalog import's write path against a REAL PostgreSQL, on a
 * synthetic gzip dump (no real data). Skipped -- loudly, by name -- unless
 * TEST_DATABASE_URL and TEST_DATABASE_ADMIN_URL are set, and refuses to run if
 * they name the dev database, a non-local host, or differ from each other.
 *
 * Covers: the full apply path, the idempotent re-run, a hand-edit being
 * restored, a staff price being kept, and two-shop isolation.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { sql } from 'kysely'
import { createDb, withShop, type Db } from '../client.js'
import { assertAppRole, assertLocalDatabase, readSource, runCatalogImport } from './catalog.js'
import { countByAction } from './catalogPlan.js'

const url = process.env.TEST_DATABASE_URL?.trim() ?? ''
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL?.trim() ?? ''
const dbNameOf = (u: string) => { try { return decodeURIComponent(new URL(u).pathname.slice(1)) } catch { return '' } }
const enabled = url !== '' && adminUrl !== ''

const q = (s: string) => '`' + s + '`'
const DUMP_SQL = [
  '-- synthetic fixture, invented data only',
  `CREATE TABLE ${q('customers')} (`, `  ${q('id')} bigint NOT NULL,`, `  ${q('phone')} varchar(20) DEFAULT NULL`, ') ENGINE=InnoDB;',
  `INSERT INTO ${q('customers')} VALUES (1,'0800000000');`,
  `CREATE TABLE ${q('warranties')} (`, `  ${q('id')} bigint NOT NULL,`, `  ${q('warranty_name')} varchar(255) NOT NULL,`,
  `  ${q('warranty_year')} int DEFAULT '0',`, `  ${q('warranty_month')} int DEFAULT '0',`, `  ${q('warranty_km')} int DEFAULT '0',`,
  `  ${q('is_active')} tinyint(1) DEFAULT '1'`, ') ENGINE=InnoDB;',
  `INSERT INTO ${q('warranties')} VALUES (1,'ทดสอบ 1 ปี',1,0,100000,1),(4,'ทดสอบ 6 เดือน',0,6,0,1);`,
  `CREATE TABLE ${q('service_items')} (`, `  ${q('id')} bigint NOT NULL,`, `  ${q('category')} varchar(100) NOT NULL,`,
  `  ${q('product_name')} varchar(255) NOT NULL,`, `  ${q('warranty_id')} bigint DEFAULT NULL,`, `  ${q('is_active')} tinyint(1) DEFAULT '1',`,
  `  ${q('created_at')} timestamp NOT NULL,`, `  ${q('is_set')} tinyint(1) NOT NULL DEFAULT '0',`, `  ${q('set_price')} decimal(10,2) DEFAULT NULL`, ') ENGINE=InnoDB;',
  `INSERT INTO ${q('service_items')} VALUES `
    + `(1,'หมวดทดสอบ','รายการ A',1,1,'2026-01-01 00:00:00',0,2500.00),`
    + `(2,'หมวดทดสอบ','รายการ B',4,1,'2026-01-01 00:00:00',0,NULL),`
    + `(3,'ชุดทดสอบ','ชุดโปร',NULL,1,'2026-01-01 00:00:00',1,6500.00),`
    + `(4,'หมวดทดสอบ','รายการ ซ้ำ',NULL,1,'2026-01-01 00:00:00',0,NULL),`
    + `(5,'หมวดทดสอบ','รายการซ้ำ',NULL,1,'2026-02-01 00:00:00',0,NULL),`
    + `(6,'หมวดทดสอบ','รายการ ฟรี?',NULL,1,'2026-01-01 00:00:00',0,0.00);`,
  `CREATE TABLE ${q('service_item_components')} (`, `  ${q('id')} bigint NOT NULL,`, `  ${q('service_item_id')} bigint NOT NULL,`,
  `  ${q('component_name')} varchar(255) NOT NULL,`, `  ${q('default_qty')} int NOT NULL DEFAULT '1',`, `  ${q('sort_order')} int NOT NULL DEFAULT '0'`, ') ENGINE=InnoDB;',
  `INSERT INTO ${q('service_item_components')} VALUES (1,3,'ชุดโปร',1,0),(2,3,'- ปีกนก',2,1),(3,3,'- ประกอบติดตั้ง',1,2);`,
  '',
].join('\n')

describe.skipIf(!enabled)('[tier2/db] catalog import write path (gsms_test, synthetic dump)', () => {
  let dir = ''
  let dumpPath = ''
  let db: Db
  let admin: pg.Client
  let groupId = ''
  let shopA = ''
  let shopB = ''

  const counts = (shopId: string) => withShop(db, shopId, async (trx) => ({
    items: Number((await trx.selectFrom('catalog_items').select((e) => e.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    terms: Number((await trx.selectFrom('warranty_terms').select((e) => e.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    comps: Number((await trx.selectFrom('catalog_set_components').select((e) => e.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
  }))
  const act = (p: { items: { action: string }[]; terms: { action: string }[]; components: { action: string }[] }) =>
    ({ items: countByAction(p.items as never), terms: countByAction(p.terms as never), comps: countByAction(p.components as never) })

  beforeAll(async () => {
    // Guards first: never the dev database, never remote, admin and app on the same database.
    const name = dbNameOf(url)
    if (!name || ['gsms', 'postgres'].includes(name.toLowerCase())) throw new Error('refusing: TEST_DATABASE_URL must be a dedicated test database')
    if (dbNameOf(adminUrl) !== name) throw new Error('refusing: TEST_DATABASE_ADMIN_URL names a different database')
    assertLocalDatabase(url)
    assertLocalDatabase(adminUrl)

    dir = await mkdtemp(join(tmpdir(), 'gsms-cat-it-'))
    dumpPath = join(dir, 'fixture.sql.gz')
    await writeFile(dumpPath, gzipSync(Buffer.from(DUMP_SQL, 'utf8')))

    admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    const tag = `wo004-it-${Date.now()}`
    groupId = (await admin.query<{ id: string }>('insert into owner_groups (slug, name) values ($1, $1) returning id', [tag])).rows[0]!.id
    shopA = (await admin.query<{ id: string }>("insert into shops (owner_group_id, slug, name, doc_code) values ($1, $2, 'A', 'ITA') returning id", [groupId, `${tag}-a`])).rows[0]!.id
    shopB = (await admin.query<{ id: string }>("insert into shops (owner_group_id, slug, name, doc_code) values ($1, $2, 'B', 'ITB') returning id", [groupId, `${tag}-b`])).rows[0]!.id

    db = createDb(url)
    const who = (await sql<{ u: string }>`select current_user as u`.execute(db)).rows[0]!
    assertAppRole(who.u)
  })

  afterAll(async () => {
    if (db) await db.destroy()
    if (admin) {
      if (shopA && shopB) {
        const ids = [shopA, shopB]
        await admin.query('delete from catalog_set_components where shop_id = any($1)', [ids])
        await admin.query('delete from catalog_items where shop_id = any($1)', [ids])
        await admin.query('delete from warranty_terms where shop_id = any($1)', [ids])
        await admin.query('delete from audit_logs where shop_id = any($1)', [ids])
        await admin.query('delete from shops where id = any($1)', [ids])
      }
      if (groupId) await admin.query('delete from owner_groups where id = $1', [groupId])
      await admin.end()
    }
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('dry-run writes nothing; the real run applies; the re-run is all unchanged; shop B sees nothing', async () => {
    const src = await readSource(dumpPath)
    expect(src.service_items).toHaveLength(6)

    const dry = await runCatalogImport(db, shopA, src, { dryRun: true })
    expect(act(dry).items.insert).toBe(5) // 6 rows, one of the duplicate pair held back
    expect(await counts(shopA)).toEqual({ items: 0, terms: 0, comps: 0 })

    const first = await runCatalogImport(db, shopA, src, { dryRun: false })
    expect(act(first)).toEqual({
      items: { insert: 5, update: 0, unchanged: 0 },
      terms: { insert: 2, update: 0, unchanged: 0 },
      comps: { insert: 3, update: 0, unchanged: 0 },
    })
    expect(await counts(shopA)).toEqual({ items: 5, terms: 2, comps: 3 })

    // The inactive term's item has no warranty link; the active one does.
    const linked = await withShop(db, shopA, (trx) =>
      trx.selectFrom('catalog_items').select(['legacy_id', 'warranty_term_id', 'base_price']).orderBy('legacy_id').execute())
    expect(linked.find((r) => r.legacy_id === '1')!.warranty_term_id).not.toBeNull()
    expect(linked.find((r) => r.legacy_id === '2')!.warranty_term_id).toBeNull()
    expect(linked.find((r) => r.legacy_id === '6')!.base_price).toBeNull() // 0 means "unpriced"
    expect(linked.find((r) => r.legacy_id === '5')).toBeUndefined() // duplicate loser

    const again = await runCatalogImport(db, shopA, src, { dryRun: false })
    expect(act(again)).toEqual({
      items: { insert: 0, update: 0, unchanged: 5 },
      terms: { insert: 0, update: 0, unchanged: 2 },
      comps: { insert: 0, update: 0, unchanged: 3 },
    })
    expect(await counts(shopA)).toEqual({ items: 5, terms: 2, comps: 3 })

    // Two-shop isolation: shop B, through its own withShop, sees none of it.
    expect(await counts(shopB)).toEqual({ items: 0, terms: 0, comps: 0 })
  })

  it('restores a hand-edited name and keeps a hand-set price', async () => {
    const src = await readSource(dumpPath)
    await admin.query("update catalog_items set name = 'edited by hand' where shop_id = $1 and legacy_id = '1'", [shopA])
    await admin.query("update catalog_items set base_price = 777.00 where shop_id = $1 and legacy_id = '1'", [shopA])
    const p = await runCatalogImport(db, shopA, src, { dryRun: false })
    expect(p.items.filter((i) => i.action === 'update').map((i) => i.legacyId)).toEqual(['1'])
    const row = await withShop(db, shopA, (trx) =>
      trx.selectFrom('catalog_items').select(['name', 'base_price']).where('legacy_id', '=', '1').executeTakeFirstOrThrow())
    expect(row.name).toBe('รายการ A')
    expect(row.base_price).toBe('777.00')
    expect(p.ambiguities.some((a) => a.code === 'price_differs')).toBe(true)
    // no new rows from the edit
    expect(await counts(shopA)).toEqual({ items: 5, terms: 2, comps: 3 })
  })

  it('links the item once the inactive term is activated, and leaves a locally merged item alone', async () => {
    const src = await readSource(dumpPath)
    await admin.query("update warranty_terms set is_active = true where shop_id = $1 and name = 'ทดสอบ 6 เดือน'", [shopA])
    const p = await runCatalogImport(db, shopA, src, { dryRun: false })
    expect(p.items.find((i) => i.legacyId === '2')!.action).toBe('update')
    const two = await withShop(db, shopA, (trx) =>
      trx.selectFrom('catalog_items').select('warranty_term_id').where('legacy_id', '=', '2').executeTakeFirstOrThrow())
    expect(two.warranty_term_id).not.toBeNull()

    // Merge item 6 into item 1 the way the app would, then re-run: no failure, no write to it.
    await admin.query(
      `update catalog_items set merged_into_id = (select id from catalog_items where shop_id = $1 and legacy_id = '1'), is_active = false
        where shop_id = $1 and legacy_id = '6'`, [shopA])
    const again = await runCatalogImport(db, shopA, src, { dryRun: false })
    expect(again.ambiguities.some((a) => a.code === 'item_merged_locally_skipped' && a.legacyId === '6')).toBe(true)
    const six = await withShop(db, shopA, (trx) =>
      trx.selectFrom('catalog_items').select(['is_active', 'merged_into_id']).where('legacy_id', '=', '6').executeTakeFirstOrThrow())
    expect(six.is_active).toBe(false)
    expect(six.merged_into_id).not.toBeNull()
  })
})
