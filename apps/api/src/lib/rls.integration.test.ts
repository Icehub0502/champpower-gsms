/**
 * WO-001 item 3 and item 4 — row-level security, proved against a real server.
 *
 * TIER 2. WRITTEN BUT NOT EXECUTED on a machine with no database. Skipped when
 * GSMS_TEST_DB is unset. The migration-safety-engineer returned NO-GO on
 * migration 0012 naming the absence of this suite as one of two fatal gaps, so
 * "skipped" here means migration 0012 is still unverified, not that it is fine.
 *
 * ================== READ THIS BEFORE TRUSTING A GREEN RUN ==================
 * The connection role matters more than anything else in this file. RLS does
 * not apply to a superuser, and it does not apply to a table's owner unless the
 * table is FORCEd. The identical suite, run on the wrong connection, passes
 * every assertion while proving nothing whatsoever — which is how a tenant hole
 * survives a test suite. `SELECT current_user` is therefore asserted first, and
 * a misconfigured connection fails loudly instead of going quietly green.
 * ===========================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { unscoped, withShop, withShops } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import { createTwoShopFixture, type TwoShopFixture } from '../test/fixtures.js'

const EXPECTED_ROLE = process.env.DB_APP_ROLE ?? 'gsms_app'

describe.skipIf(!hasDatabase)(tier2('row-level security (migration 0012)'), () => {
  let fx: TwoShopFixture
  let customerA: string
  let customerB: string

  beforeAll(async () => {
    fx = await createTwoShopFixture('wo001rls')
    const a = await withShop(db, fx.shopA, (trx) => trx.insertInto('customers')
      .values({ shop_id: fx.shopA, name: 'Customer at branch A', phone: '0800000001' })
      .returning('id').executeTakeFirstOrThrow())
    const b = await withShop(db, fx.shopB, (trx) => trx.insertInto('customers')
      .values({ shop_id: fx.shopB, name: 'Customer at branch B', phone: '0800000002' })
      .returning('id').executeTakeFirstOrThrow())
    customerA = a.id
    customerB = b.id
  })
  afterAll(async () => { await fx?.cleanup() })

  // ===========================================================================
  // 0. The precondition. Without this, everything below is theatre.
  // ===========================================================================
  describe('preconditions', () => {
    it(`is connected as ${EXPECTED_ROLE}, not as a superuser or a table owner`, async () => {
      const row = await sql<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>`
        select current_user::text as role_name, r.rolsuper, r.rolbypassrls
        from pg_roles r where r.rolname = current_user
      `.execute(db)
      const facts = row.rows[0]
      expect(facts, 'pg_roles returned nothing for current_user').toBeTruthy()
      expect(
        facts!.role_name,
        'this suite proves nothing unless it runs as the application role: '
        + 'RLS does not apply to a superuser, and a table owner is exempt unless '
        + 'the table is FORCEd. Point DATABASE_URL at the gsms_app role.',
      ).toBe(EXPECTED_ROLE)
      expect(facts!.rolsuper, 'connected as a superuser; RLS applies to nothing').toBe(false)
      expect(facts!.rolbypassrls, 'connected with BYPASSRLS; RLS applies to nothing').toBe(false)
    })

    /** Both fixture rows exist, each visible from its own shop. */
    it('has one customer in each branch', async () => {
      const inA = await withShop(db, fx.shopA, (trx) => trx.selectFrom('customers')
        .select(['id']).where('id', '=', customerA).executeTakeFirst())
      const inB = await withShop(db, fx.shopB, (trx) => trx.selectFrom('customers')
        .select(['id']).where('id', '=', customerB).executeTakeFirst())
      expect(inA?.id).toBe(customerA)
      expect(inB?.id).toBe(customerB)
    })
  })

  // ===========================================================================
  // (a) THE ORIGINAL HOLE — a cross-shop DELETE
  // ===========================================================================
  describe('(a) cross-shop DELETE', () => {
    /**
     * The transaction-mode defence.
     *
     * What the old code did (WO-001 item 3): `withShops` opened an ordinary
     * read-write transaction, and the comment beside it claimed writes were
     * impossible because WITH CHECK was not set. That is true for INSERT and
     * for the NEW row of an UPDATE. It is NOT true for DELETE, which PostgreSQL
     * governs with USING alone — and the 0001 USING clause read
     * `shop_id = current_shop_id() OR shop_id = ANY (current_shop_ids())`. So a
     * DELETE issued anywhere inside the owner's group-level view applied to
     * every branch in the list, across all 55 tables that call
     * apply_tenant_rls. Against that code this DELETE succeeded.
     */
    it('is refused by the database because withShops is READ ONLY', async () => {
      await expect(
        withShops(db, fx.userId, (trx) =>
          trx.deleteFrom('customers').where('id', '=', customerB).execute()),
      ).rejects.toThrow(/read-only transaction/i)

      // And nothing was deleted.
      const survivor = await withShop(db, fx.shopB, (trx) => trx.selectFrom('customers')
        .select(['id']).where('id', '=', customerB).executeTakeFirst())
      expect(survivor?.id).toBe(customerB)
    })

    /**
     * THE POLICY DEFENCE, TESTED SEPARATELY ON PURPOSE.
     *
     * This test targets migration 0012's `tenant_delete` policy, NOT the
     * transaction mode. It is deliberately written so that deleting the
     * `SET TRANSACTION READ ONLY` line from withShops would not make it pass:
     * the transaction below is an ordinary READ WRITE one, and it sets
     * `app.current_shop_ids` to BOTH branches by hand, exactly as the group-level
     * read path does. The old FOR ALL policy authorised this DELETE. The
     * per-command split must refuse it.
     *
     * A future read-write group path — a bulk correction screen, a data
     * migration, anything — would reopen the hole instantly if this policy were
     * the only thing not fixed. This is the test that says it was.
     */
    it('is refused by the tenant_delete policy even in a READ WRITE transaction', async () => {
      const deleted = await db.transaction().execute(async (trx) => {
        // The active shop is A. The group list contains A and B — the shape
        // withShops produces, reproduced here without its READ ONLY guard.
        await sql`select set_config('app.current_shop_id', ${fx.shopA}, true)`.execute(trx)
        await sql`select set_config('app.current_shop_ids', ${`{${fx.shopA},${fx.shopB}}`}, true)`
          .execute(trx)

        const result = await trx.deleteFrom('customers')
          .where('id', '=', customerB).executeTakeFirst()
        return Number(result.numDeletedRows ?? 0)
      })

      expect(
        deleted,
        'tenant_delete authorised a DELETE outside the active shop: migration 0012 '
        + 'has not taken effect, or USING still contains current_shop_ids()',
      ).toBe(0)

      const survivor = await withShop(db, fx.shopB, (trx) => trx.selectFrom('customers')
        .select(['id']).where('id', '=', customerB).executeTakeFirst())
      expect(survivor?.id, 'the row was deleted across branches').toBe(customerB)
    })

    /** A DELETE inside the row's own shop must still work, or the fix is a brick. */
    it('still allows a DELETE inside the active shop', async () => {
      const victim = await withShop(db, fx.shopA, (trx) => trx.insertInto('customers')
        .values({ shop_id: fx.shopA, name: 'deletable', phone: '0800000003' })
        .returning('id').executeTakeFirstOrThrow())

      const deleted = await withShop(db, fx.shopA, async (trx) => {
        const r = await trx.deleteFrom('customers').where('id', '=', victim.id).executeTakeFirst()
        return Number(r.numDeletedRows ?? 0)
      })
      expect(deleted).toBe(1)
    })
  })

  // ===========================================================================
  // (b) Cross-shop SELECT
  // ===========================================================================
  describe('(b) cross-shop SELECT', () => {
    /**
     * CLAUDE.md §13 invariant 5, and WO-001 item 4's integration test: insert a
     * row for shop A, open withShop(B), get zero rows.
     *
     * This is also the test that catches a superuser connection the instant it
     * happens, which is the property the old `/:\/\/postgres[:@]/` regex could
     * never guarantee: a superuser sees the row regardless of any GUC, so this
     * fails immediately. That is why it is worth having even though the startup
     * check exists.
     */
    it('returns 0 rows for another branch\'s customer', async () => {
      const rows = await withShop(db, fx.shopB, (trx) => trx.selectFrom('customers')
        .select(['id', 'name']).where('id', '=', customerA).execute())
      expect(rows, 'branch B could read branch A\'s customer').toHaveLength(0)
    })

    it('hides the other branch even from an unfiltered list', async () => {
      const rows = await withShop(db, fx.shopB, (trx) => trx.selectFrom('customers')
        .select(['id', 'shop_id']).execute())
      expect(rows.every((r) => r.shop_id === fx.shopB)).toBe(true)
      expect(rows.map((r) => r.id)).not.toContain(customerA)
    })

    /**
     * A query outside any scope sees nothing at all. An empty result is
     * recoverable; a leak across branches is not.
     */
    it('returns 0 rows when no shop has been declared', async () => {
      const rows = await unscoped(db, (trx) => trx.selectFrom('customers')
        .select(['id']).where('id', 'in', [customerA, customerB]).execute())
      expect(rows).toHaveLength(0)
    })

    /** The group-level read is the one place that legitimately spans branches. */
    it('lets a group-level read see both branches, since SELECT keeps the group clause', async () => {
      const rows = await withShops(db, fx.userId, (trx) => trx.selectFrom('customers')
        .select(['id']).where('id', 'in', [customerA, customerB]).execute())
      expect(rows.map((r) => r.id).sort()).toEqual([customerA, customerB].sort())
    })
  })

  // ===========================================================================
  // (c) An UPDATE that moves a row to another shop
  // ===========================================================================
  describe('(c) cross-shop UPDATE', () => {
    /**
     * The second variant of the same hole. The OLD-row side of an UPDATE is
     * governed by USING, exactly like DELETE, and the 0001 USING clause
     * contained `current_shop_ids()`. So a group-level transaction could also
     * edit rows in any branch in the list — and, with WITH CHECK naming only
     * the active shop, could not move them, but could certainly change them.
     *
     * Two things are asserted, because they fail through different clauses:
     *   1. re-homing a row of the ACTIVE shop into another shop is refused by
     *      WITH CHECK (this was already true before 0012, and must stay true);
     *   2. editing a row of ANOTHER shop while the group list names it is
     *      refused by USING (this is the part 0012 fixes).
     */
    it('refuses to move a row from the active shop into another shop', async () => {
      await expect(
        withShop(db, fx.shopA, (trx) => trx.updateTable('customers')
          .set({ shop_id: fx.shopB }).where('id', '=', customerA).execute()),
      ).rejects.toThrow(/row-level security|violates row-level security policy/i)

      const stillA = await withShop(db, fx.shopA, (trx) => trx.selectFrom('customers')
        .select(['shop_id']).where('id', '=', customerA).executeTakeFirst())
      expect(stillA?.shop_id).toBe(fx.shopA)
    })

    /**
     * Targets `tenant_update`'s USING clause specifically, in a READ WRITE
     * transaction with the group list set by hand — so, like the DELETE test
     * above, removing withShops' READ ONLY line would not rescue it.
     */
    it('refuses to edit another branch\'s row even when the group list names it', async () => {
      const updated = await db.transaction().execute(async (trx) => {
        await sql`select set_config('app.current_shop_id', ${fx.shopA}, true)`.execute(trx)
        await sql`select set_config('app.current_shop_ids', ${`{${fx.shopA},${fx.shopB}}`}, true)`
          .execute(trx)
        const r = await trx.updateTable('customers')
          .set({ name: 'renamed across branches' })
          .where('id', '=', customerB).executeTakeFirst()
        return Number(r.numUpdatedRows ?? 0)
      })

      expect(
        updated,
        'tenant_update authorised an UPDATE outside the active shop: USING still '
        + 'contains current_shop_ids()',
      ).toBe(0)

      const untouched = await withShop(db, fx.shopB, (trx) => trx.selectFrom('customers')
        .select(['name']).where('id', '=', customerB).executeTakeFirstOrThrow())
      expect(untouched.name).toBe('Customer at branch B')
    })

    /** And an INSERT naming another branch is refused by WITH CHECK. */
    it('refuses an INSERT that names another branch', async () => {
      await expect(
        withShop(db, fx.shopA, (trx) => trx.insertInto('customers')
          .values({ shop_id: fx.shopB, name: 'planted', phone: '0800000004' }).execute()),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  // ===========================================================================
  // (d) The thing that must NOT be tightened
  // ===========================================================================
  describe('(d) login must still work from a connection with no GUC set', () => {
    /**
     * THE CANARY, and the reason migration 0012 section 5 deliberately leaves
     * the identity tables without RLS.
     *
     * `users`, `sessions`, `shops`, `shop_memberships` and `owner_groups` are
     * all read on the PRE-AUTHENTICATION path, when no shop and no user are
     * known yet and there is therefore no session variable a policy could key
     * on. `CALL apply_tenant_rls('shop_memberships')` would make every one of
     * these reads return zero rows, and the result is not a degraded feature:
     * it is that NOBODY CAN LOG IN, owner included, and the way back in is a
     * superuser psql session. On a working garage's Monday morning that is the
     * worst available outcome.
     *
     * This test exists to catch a well-meaning future "tightening" — adding RLS
     * to the identity tables because a checklist said every table should have it
     * — before it reaches the shop. If it starts failing, read section 5 of
     * migration 0012 before changing anything: the fix is a SECURITY DEFINER
     * lookup function and an app.current_user_id GUC, not reverting this test.
     *
     * Deliberately uses a connection with NO GUC of any kind set, which is what
     * a freshly pooled connection handling a /login request looks like.
     */
    it('reads users, shop_memberships and shops with no shop declared', async () => {
      // Exactly the reads routes/auth.ts performs on /login.
      const user = await db.selectFrom('users')
        .select(['id', 'login_id', 'password_hash', 'is_active'])
        .where(sql`lower(login_id)`, '=', fx.loginId.toLowerCase())
        .executeTakeFirst()
      expect(
        user,
        'the /login user lookup returned nothing with no GUC set — RLS has been '
        + 'added to `users`. Nobody can log in. See migration 0012 section 5.',
      ).toBeTruthy()

      const memberships = await db.selectFrom('shop_memberships as m')
        .innerJoin('shops as s', 's.id', 'm.shop_id')
        .select(['m.shop_id', 'm.role', 's.name'])
        .where('m.user_id', '=', fx.userId)
        .execute()
      expect(
        memberships.length,
        'membershipsOf() returned nothing with no GUC set — RLS has been added to '
        + '`shop_memberships` or `shops`. The branch switcher is empty and login '
        + 'cannot choose a shop. See migration 0012 section 5.',
      ).toBe(2)

      // /refresh reads sessions by jti before any shop is known, too.
      const sessionsReadable = await db.selectFrom('sessions')
        .select(['id']).where('user_id', '=', fx.userId).execute()
      expect(Array.isArray(sessionsReadable)).toBe(true)
    })

    /** And the same from inside a scope that names an unrelated shop. */
    it('reads identity tables from inside any shop scope', async () => {
      const rows = await withShop(db, fx.shopB, (trx) => trx.selectFrom('shop_memberships')
        .select(['shop_id']).where('user_id', '=', fx.userId).execute())
      expect(rows).toHaveLength(2)
    })
  })

  // ===========================================================================
  // withShops: the shop list is a permission, not an argument
  // ===========================================================================
  describe('withShops resolves the shop list from membership', () => {
    /**
     * WO-001 item 13. The old signature took the list from the caller, so any
     * code path that could be persuaded to pass an array could read any branch.
     * The list now comes from `shop_memberships` inside the same transaction.
     */
    it('spans exactly the branches the user is a member of', async () => {
      const rows = await withShops(db, fx.outsiderId, (trx) => trx.selectFrom('customers')
        .select(['id', 'shop_id']).where('id', 'in', [customerA, customerB]).execute())
      // The outsider belongs to branch B only.
      expect(rows.map((r) => r.id)).toEqual([customerB])
    })

    it('refuses a user with no membership at all rather than seeing everything', async () => {
      const orphan = await db.insertInto('users').values({
        login_id: `orphan-${Date.now()}@example.test`,
        password_hash: 'x', name: 'Orphan', is_active: true,
      }).returning('id').executeTakeFirstOrThrow()
      try {
        await expect(
          withShops(db, orphan.id, (trx) => trx.selectFrom('customers').select(['id']).execute()),
        ).rejects.toThrow(/no shop membership/)
      } finally {
        await db.deleteFrom('users').where('id', '=', orphan.id).execute()
      }
    })

    it('refuses every kind of write, not only DELETE', async () => {
      await expect(
        withShops(db, fx.userId, (trx) => trx.insertInto('customers')
          .values({ shop_id: fx.shopA, name: 'x', phone: '1' }).execute()),
      ).rejects.toThrow(/read-only transaction/i)

      await expect(
        withShops(db, fx.userId, (trx) => trx.updateTable('customers')
          .set({ name: 'x' }).where('id', '=', customerA).execute()),
      ).rejects.toThrow(/read-only transaction/i)
    })
  })
})
