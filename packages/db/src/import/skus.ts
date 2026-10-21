/**
 * WO-006 / WO-004 phase 2 -- import the prototype's parts as stock SKUs.
 *
 *   racks      -> skus (legacy_source 'rack')
 *   wing_arms  -> skus (legacy_source 'wing_arm')
 *
 * QUANTITIES ARE NOT IMPORTED (see skuPlan.ts). No stock_balances row and no stock_moves row is ever
 * written here: every imported SKU is "not counted" until staff count it in the system.
 *
 * Reads a LOCAL mysqldump file only. Writes only through withShop(<shop>) as the application role, so
 * RLS applies like to any request. Safe to re-run: SKUs are keyed on (legacy_source, legacy_id); a second
 * run updates in place and never duplicates. --dry-run plans in a READ ONLY transaction and writes nothing
 * to the database (it still writes the report files).
 *
 *   npm run import:skus:dry -w packages/db
 *   npm run import:skus -w packages/db -- --dump ../../_import/cps2-20260916-0246.sql.gz
 *
 * It does NOT bind catalog_items.sku_id. Matching a catalog item to a SKU by name is a guess, so the
 * run only writes _import/sku-catalog-suggestions.csv for a person to read; binding is done on the
 * stock screens (PUT /api/stock/catalog-items/:id/sku).
 *
 * Options: --dump <file.sql.gz>   --shop <slug, default samut-prakan>   --dry-run
 *          --import-root <dir>    a directory NAMED _import (reports + default dump live there)
 *          --db-env <NAME>        which environment variable holds the connection string (default
 *                                 DATABASE_URL). Used to point a rehearsal at the test database.
 *          A real run requires --dump; unknown flags are errors.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sql } from 'kysely'
import { createDb, unscoped, withShop, type Db, type ScopedTx } from '../client.js'
import { extractTables, linesOfFile } from './mysqlDump.js'
import { assertAppRole, assertLocalDatabase, resolveReportDir } from './catalog.js'
import {
  buildSkuPlan, countSkuActions, hadStockCsv, suggestLinks, suggestionsCsv,
  type ExistingSku, type SkuPlan, type SourceSkuTables,
} from './skuPlan.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_IMPORT_ROOT = resolve(HERE, '..', '..', '..', '..', '_import')
const DUMP_NAME = 'cps2-20260916-0246.sql.gz'

export async function readSkuSource(dumpPath: string): Promise<SourceSkuTables> {
  const t = await extractTables(linesOfFile(dumpPath), ['racks', 'wing_arms'])
  return { racks: t.racks!, wing_arms: t.wing_arms! }
}

async function loadExisting(trx: ScopedTx): Promise<ExistingSku[]> {
  return trx
    .selectFrom('skus')
    .select(['id', 'code', 'name', 'category', 'reorder_point', 'legacy_source', 'legacy_id', 'legacy_had_stock'])
    .execute()
}

async function applyPlan(trx: ScopedTx, shopId: string, plan: SkuPlan): Promise<void> {
  for (const i of plan.items) {
    if (i.action === 'insert') {
      await trx.insertInto('skus')
        .values({
          shop_id: shopId, code: i.code, name: i.name, category: i.category,
          stocking_policy: 'stocked', reorder_point: i.reorderPoint,
          legacy_source: i.source, legacy_id: i.legacyId, legacy_had_stock: i.hadStock,
        })
        .execute()
    } else if (i.action === 'update') {
      const set: Record<string, unknown> = { name: i.name, category: i.category, legacy_had_stock: i.hadStock }
      // A reorder point somebody set is theirs; only an empty one is filled.
      if (i.changes.includes('reorder_point')) set.reorder_point = i.reorderPoint
      await trx.updateTable('skus').set(set).where('shop_id', '=', shopId).where('id', '=', i.existingId!).execute()
    }
  }
  // One summary row per run: this is master data, not a quantity, so no per-row trail; the legacy keys say where each row came from.
  await trx.insertInto('audit_logs')
    .values({
      shop_id: shopId, actor_id: null, action: 'sku_import', entity_type: 'sku_import',
      after: JSON.stringify({ skus: countSkuActions(plan.items), ambiguities: plan.ambiguities.length, hadStock: plan.hadStock }),
    })
    .execute()
}

export interface SkuRunResult {
  plan: SkuPlan
  suggestions: ReturnType<typeof suggestLinks>
  skusAfter: number
}

/** Plan (and, unless dry-run, apply) for one shop. Exported so a test can drive exactly the code the CLI runs. */
export async function runSkuImport(db: Db, shopId: string, src: SourceSkuTables, opts: { dryRun: boolean }): Promise<SkuRunResult> {
  return withShop(db, shopId, async (trx) => {
    if (opts.dryRun) await sql`set transaction read only`.execute(trx)
    const plan = buildSkuPlan(src, await loadExisting(trx))
    if (!opts.dryRun) await applyPlan(trx, shopId, plan)

    // Suggestions are computed against what the shop holds AFTER the plan (so a dry run sees the SKUs that
    // would exist): existing SKUs, plus the planned inserts.
    const skuNames = [
      ...(await trx.selectFrom('skus').select(['code', 'name']).execute()),
      ...(opts.dryRun ? plan.items.filter((i) => i.action === 'insert').map((i) => ({ code: i.code, name: i.name })) : []),
    ]
    const parts = await trx
      .selectFrom('catalog_items')
      .select(['id', 'category', 'name'])
      .where('line_type', '=', 'part').where('merged_into_id', 'is', null).where('sku_id', 'is', null)
      .execute()
    const suggestions = suggestLinks(parts, skuNames)
    const after = await trx.selectFrom('skus').select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow()
    return { plan, suggestions, skusAfter: Number(after.n) }
  })
}

export function renderSkuReport(r: SkuRunResult, meta: { dryRun: boolean; shopSlug: string; shopId: string; dump: string; database: string }): string {
  const { plan } = r
  const n = countSkuActions(plan.items)
  const bySource = (s: string) => plan.items.filter((i) => i.source === s)
  const L: string[] = []
  L.push(`# WO-006 SKU import -- ${meta.dryRun ? 'DRY RUN (nothing written to the database)' : 'REAL RUN'}`)
  L.push('', `database: ${meta.database}`, `shop: ${meta.shopSlug} (${meta.shopId})`, `dump: ${meta.dump}`, '')
  L.push('## Counts', '')
  L.push(`- skus planned: ${plan.items.length} (insert ${n.insert}, update ${n.update}, unchanged ${n.unchanged})`)
  L.push(`  - racks (legacy_source rack): ${bySource('rack').length}`)
  L.push(`  - wing arms (legacy_source wing_arm): ${bySource('wing_arm').length}`)
  L.push(`- had stock in the prototype (stock_qty > 0, ordering hint only): ${plan.hadStock}`)
  L.push(`- skus in the shop after this run: ${r.skusAfter}`)
  L.push(`- ambiguities needing a person: ${plan.ambiguities.length}`)
  L.push('- stock_balances rows created: 0   stock_moves rows created: 0   (quantities are NOT imported)', '')
  L.push('## min_stock -> reorder_point', '', 'How many parts carry each value (the prototype defaulted min_stock to 1, so a pile at "1.00" means "nobody set it"):', '')
  for (const [v, c] of plan.minStockHistogram) L.push(`- ${v}: ${c}`)
  L.push('', '## Needs a human (nothing below was guessed)', '')
  const by = new Map<string, typeof plan.ambiguities>()
  for (const a of plan.ambiguities) by.set(a.code, [...(by.get(a.code) ?? []), a])
  if (by.size === 0) L.push('- no row-level ambiguities')
  for (const [code, rows] of by) {
    L.push('', `### ${code} (${rows.length})`, '')
    for (const a of rows) L.push(`- ${a.source} #${a.legacyId ?? '-'}: ${a.detail}`)
  }
  L.push('', '## Catalog link', '')
  L.push(`- catalog_items.sku_id was NOT touched. Name-based suggestions for a person: ${r.suggestions.length} row(s) in sku-catalog-suggestions.csv. Bind on the stock screen.`)
  return L.join('\n') + '\n'
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

export interface SkuCliArgs {
  dryRun: boolean
  dump: string | undefined
  shop: string
  importRoot: string
  dbEnv: string
}

export function parseSkuCliArgs(argv: readonly string[]): SkuCliArgs {
  const out: SkuCliArgs = { dryRun: false, dump: undefined, shop: 'samut-prakan', importRoot: DEFAULT_IMPORT_ROOT, dbEnv: 'DATABASE_URL' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dry-run') { out.dryRun = true; continue }
    if (a === '--dump' || a === '--shop' || a === '--import-root' || a === '--db-env') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--') || v === '') throw new Error(`${a} needs a value`)
      i++
      if (a === '--dump') out.dump = v
      else if (a === '--shop') out.shop = v
      else if (a === '--import-root') out.importRoot = resolve(v)
      else out.dbEnv = v
      continue
    }
    throw new Error(`unknown argument "${a.slice(0, 40)}" (known: --dry-run, --dump <file>, --shop <slug>, --import-root <dir>, --db-env <NAME>)`)
  }
  if (!out.dryRun && out.dump === undefined) throw new Error('a real run requires --dump <file> (only --dry-run may use the default dump)')
  // Reports and the default dump live in a gitignored directory; the name is the guard.
  if (basename(out.importRoot) !== '_import') throw new Error(`--import-root must be a directory named _import (got "${basename(out.importRoot)}")`)
  if (!/^[A-Z][A-Z0-9_]*$/.test(out.dbEnv)) throw new Error('--db-env must be an environment variable NAME')
  return out
}

function databaseNameOf(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) } catch { return '(unreadable)' }
}

export async function main(): Promise<void> {
  const args = parseSkuCliArgs(process.argv.slice(2))
  const url = process.env[args.dbEnv]
  if (!url) throw new Error(`${args.dbEnv} is not set (run through the npm script so .env is loaded)`)
  assertLocalDatabase(url)
  const dbName = databaseNameOf(url)
  console.log(`target database: ${dbName}   mode: ${args.dryRun ? 'DRY RUN' : 'REAL RUN'}`)

  const dump = resolve(args.dump ?? join(args.importRoot, DUMP_NAME))
  const reportDir = resolveReportDir(args.importRoot, args.importRoot)
  const db: Db = createDb(url)
  try {
    const who = await sql<{ current_user: string }>`select current_user`.execute(db)
    assertAppRole(who.rows[0]?.current_user ?? '')

    const src = await readSkuSource(dump)
    console.log(`read dump: racks=${src.racks.length} wing_arms=${src.wing_arms.length}`)

    const shop = await unscoped(db, (trx) =>
      trx.selectFrom('shops').select(['id', 'slug']).where('slug', '=', args.shop).executeTakeFirst())
    if (!shop) throw new Error(`no shop with slug "${args.shop}"`)
    console.log(`shop: ${shop.slug} ${shop.id}`)

    const result = await runSkuImport(db, shop.id, src, { dryRun: args.dryRun })

    await mkdir(reportDir, { recursive: true })
    const suffix = args.dryRun ? '-dryrun' : ''
    const reportPath = join(reportDir, `sku-import-report${suffix}.md`)
    await writeFile(reportPath, renderSkuReport(result, { dryRun: args.dryRun, shopSlug: shop.slug, shopId: shop.id, dump, database: dbName }), 'utf8')
    await writeFile(join(reportDir, 'sku-catalog-suggestions.csv'), suggestionsCsv(result.suggestions), 'utf8')
    await writeFile(join(reportDir, 'sku-had-stock.csv'), hadStockCsv(result.plan.items), 'utf8')

    const n = countSkuActions(result.plan.items)
    console.log(args.dryRun ? 'DRY RUN -- nothing written to the database' : 'WRITTEN')
    console.log(`  skus            insert ${n.insert}  update ${n.update}  unchanged ${n.unchanged}  (planned ${result.plan.items.length})`)
    console.log(`  had stock       ${result.plan.hadStock}`)
    console.log(`  ambiguities     ${result.plan.ambiguities.length}`)
    console.log(`  suggestions     ${result.suggestions.length}`)
    console.log(`  report: ${reportPath}`)
  } finally {
    await db.destroy()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
}
