/**
 * WO-001 item 12 (TypeScript half) — the three transaction kinds must not be
 * interchangeable.
 *
 * TIER 1, and mostly a COMPILE-TIME test. The brand is erased at runtime, so
 * vitest can only assert that this file type-checked; the real gate is
 * `npm run typecheck -w apps/api`, which reads this file (apps/api/tsconfig.json
 * includes `src` and does not exclude tests — see tsconfig.build.json for why).
 *
 * What the old code did (WO-001 item 12): `withShop`, `withShops` and `unscoped`
 * all handed the callback a plain `Transaction<DB>`. The three were therefore
 * the same type, and the WO's example —
 *
 *     unscoped(db, (t) => shopRepo.list(t))
 *
 * — compiled without complaint and returned every shop of every owner group,
 * because `unscoped` sets no `app.current_shop_id` and the identity tables carry
 * no RLS. Nothing in the type system objected, and nothing at runtime did
 * either. That is the shape of a cross-tenant read that reviews do not catch.
 *
 * Every `@ts-expect-error` below is an assertion. `@ts-expect-error` is a
 * failure when the line beneath it compiles CLEANLY — so against the old code,
 * where all three types were identical, EVERY ONE of these would have been
 * reported as "Unused '@ts-expect-error' directive" and the typecheck would have
 * failed. That is the discrimination.
 */
import { describe, expect, it } from 'vitest'
import type { GroupTx, ScopedTx, UnscopedTx } from '@gsms/db/client.js'
import type { Transaction } from 'kysely'
import type { DB } from '@gsms/db/types.js'

/** Stands in for a repository that reads shop data: it requires the shop scope. */
declare function readsShopData(trx: ScopedTx): Promise<void>
/** Stands in for the owner's group-level, read-only reporting query. */
declare function readsGroupData(trx: GroupTx): Promise<void>
/** Stands in for an identity-table read on the pre-authentication path. */
declare function readsIdentityTables(trx: UnscopedTx): Promise<void>

declare const scoped: ScopedTx
declare const group: GroupTx
declare const unscopedTx: UnscopedTx
declare const plain: Transaction<DB>

// --- the exact bug the WO names ------------------------------------------
// @ts-expect-error unscoped() must not satisfy a shop-scoped repository
void (() => readsShopData(unscopedTx))

// --- the group-level read path must not be usable as a shop scope ---------
// @ts-expect-error withShops() is READ ONLY and spans shops; not a shop scope
void (() => readsShopData(group))

// --- and the reverse, in both directions ----------------------------------
// @ts-expect-error a single-shop transaction is not a group-level one
void (() => readsGroupData(scoped))
// @ts-expect-error an identity transaction is not a group-level one
void (() => readsGroupData(unscopedTx))
// @ts-expect-error a shop-scoped transaction is not an identity-only one
void (() => readsIdentityTables(scoped))
// @ts-expect-error a group transaction is not an identity-only one
void (() => readsIdentityTables(group))

/**
 * An unbranded Transaction<DB> must not launder its way into any of them
 * either, or `db.transaction().execute(...)` written by hand would be an
 * escape hatch around all three.
 */
// @ts-expect-error a raw Transaction<DB> carries no scope declaration
void (() => readsShopData(plain))
// @ts-expect-error a raw Transaction<DB> carries no scope declaration
void (() => readsGroupData(plain))
// @ts-expect-error a raw Transaction<DB> carries no scope declaration
void (() => readsIdentityTables(plain))

// --- the correct calls must still compile, or the brand is just noise ------
void (() => readsShopData(scoped))
void (() => readsGroupData(group))
void (() => readsIdentityTables(unscopedTx))

/**
 * Each branded type must still BE a Transaction<DB>, so every existing Kysely
 * call site keeps working. If this broke, the brand would have been implemented
 * as a wrapper rather than an intersection and half the codebase would need
 * rewriting.
 */
void (() => { const asTransaction: Transaction<DB> = scoped; void asTransaction })
void (() => { const asTransaction: Transaction<DB> = group; void asTransaction })
void (() => { const asTransaction: Transaction<DB> = unscopedTx; void asTransaction })

describe('transaction brands', () => {
  it('are compile-time only: this file type-checking IS the assertion', () => {
    // Nothing to measure at runtime — the brand is a phantom property. The test
    // exists so the file appears in the run and its purpose is discoverable
    // from the report rather than only from the typecheck.
    expect(true).toBe(true)
  })
})
