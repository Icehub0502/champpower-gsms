/**
 * Two requests creating the same (category, name) at once: exactly one wins
 * (201), every other answers 409 catalog_item_exists — never a 500 from the
 * unique index uq_catalog_items_name (0020). TIER 2.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'
import { createTwoShopFixture, issueTokensFor, post, startApi, type RunningApi, type TwoShopFixture } from '../test/fixtures.js'


describe.skipIf(!hasDatabase || !adminDatabaseUrl)(tier2('concurrent catalog item creates (uq_catalog_items_name race)'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi({ intakeWriteLimit: 1_000_000 })
    fx = await createTwoShopFixture('p31race')
  })
  afterAll(async () => {
    if (fx) {
      const admin = new pg.Client({ connectionString: adminDatabaseUrl })
      await admin.connect()
      try {
        await admin.query('set session_replication_role = replica')
        await admin.query('delete from audit_logs where shop_id = any($1)', [[fx.shopA, fx.shopB]])
        await admin.query('delete from catalog_items where shop_id = any($1)', [[fx.shopA, fx.shopB]])
      } finally { await admin.end() }
    }
    await fx?.cleanup()
    await api?.close()
  })

  it('N parallel creates of one name: exactly one 201, the rest 409 catalog_item_exists, no 5xx; repeated', async () => {
    const token = (await issueTokensFor(fx.userId, fx.shopA, 'owner')).accessToken
    for (let round = 0; round < 5; round++) {
      const body = { category: 'หมวดแข่ง', name: `ชื่อแข่งกัน ${round}`, confirmNotSimilar: true }
      const results = await Promise.all(Array.from({ length: 8 }, () => post<any>(api, '/api/catalog/items', body, token))) // eslint-disable-line @typescript-eslint/no-explicit-any
      const statuses = results.map((r) => r.status).sort()
      expect(statuses.filter((s) => s >= 500), JSON.stringify(results.map((r) => r.body))).toHaveLength(0)
      expect(statuses.filter((s) => s === 201)).toHaveLength(1)
      expect(statuses.filter((s) => s === 409)).toHaveLength(7)
      const winner = results.find((r) => r.status === 201)!.body.id
      for (const r of results.filter((x) => x.status === 409)) {
        expect(r.body).toMatchObject({ error: 'catalog_item_exists', itemId: winner })
      }
    }
  })
})
