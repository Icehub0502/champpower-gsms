/**
 * WO-004 phase 1 -- import the prototype's service catalog.
 *
 *   service_items            -> catalog_items
 *   service_item_components  -> catalog_set_components
 *   warranties (only those the items reference) -> warranty_terms
 *
 * Reads a LOCAL mysqldump file only (never a server). Writes only through
 * withShop(<shop>) as the application role, so RLS applies to the import like
 * to any request. Safe to re-run: items are keyed on (legacy_source, legacy_id),
 * components on (set, sort_order), terms on name, and a second run updates in
 * place. --dry-run reads the target (in a READ ONLY transaction) and prints the
 * plan without writing anything.
 *
 *   npm run import:catalog -w packages/db -- --dry-run
 *   npm run import:catalog -w packages/db            (the real run)
 *
 * Known limitation, accepted for this phase: warranty_terms (keyed on name) and
 * catalog_set_components (keyed on set + sort_order) have no legacy_source /
 * legacy_id columns. The later phase should add them by migration and move
 * these two onto real legacy keys.
 *
 * Staff prices win: a non-NULL base_price in the DB is never replaced, by NULL
 * or by a different dump value (the latter is listed as "price_differs").
 *
 * Options: --dump <file.sql.gz>  --shop <slug, default samut-prakan>
 *          --report-dir <dir, default: next to the dump>
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parse as parseConnectionString } from 'pg-connection-string'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sql } from 'kysely'
import { createDb, withShop, type Db, type ScopedTx } from '../client.js'
import { extractTables, linesOfFile } from './mysqlDump.js'
import {
  USAGE_COLUMNS, countWarrantyUse, duplicateGroups, duplicatesCsv, type WarrantyUsage,
} from './catalogReview.js'
import {
  INACTIVE_WARRANTY_LEGACY_IDS, ITEM_SOURCE, buildPlan, countByAction,
  type ExistingState, type Plan, type SourceTables,
} from './catalogPlan.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DUMP = join(HERE, '..', '..', '..', '..', '_import', 'cps2-20260916-0246.sql.gz')
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** WO-004 section 2.1: this script must never be pointed at a remote database. */
export function assertLocalDatabase(url: string): void {
  // Query parameters can override the authority (?host=, ?hostaddr=), and the
  // URL parser would not notice: pg would connect somewhere the guard never
  // looked. A plain local URL needs none, so any query string is refused.
  let search: string
  try { search = new URL(url).search } catch { throw new Error('DATABASE_URL is not a valid URL') }
  if (search !== '' || url.includes('?')) {
    throw new Error('refusing to run: DATABASE_URL must not carry a query string (host/hostaddr overrides)')
  }
  // Check the host pg itself will use, parsed by the same library pg uses.
  const host = parseConnectionString(url).host
  if (!host) {
    throw new Error('refusing to run: DATABASE_URL has no host (unix socket or PGHOST fallback is not allowed)')
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`refusing to run: DATABASE_URL host "${host}" is not local (WO-004 allows a local database only)`)
  }
}

/**
 * L1: the import must run as the application role so row-level security
 * applies to it. A superuser or table owner would bypass RLS and make withShop
 * decorative.
 */
export function assertAppRole(role: string): void {
  if (role !== 'gsms_app') {
    throw new Error(`refusing to run: connected as "${role}", expected gsms_app (RLS must apply to the import)`)
  }
}

/**
 * L2: reports may only be written inside a gitignored `_import/` directory, so
 * a typo in --report-dir can never drop a file into tracked source. Resolution
 * normalises `..`; the separator in the prefix test rejects `_import-evil`.
 */
export function resolveReportDir(dir: string, root: string): string {
  const out = resolve(dir)
  const base = resolve(root)
  if (out !== base && !out.startsWith(base + sep)) {
    throw new Error(`refusing to write reports to "${out}": it must be inside ${base} (gitignored _import/)`)
  }
  return out
}

export async function readSource(dumpPath: string): Promise<SourceTables> {
  // Only these three tables are decoded; every other line of the dump is skipped.
  const t = await extractTables(linesOfFile(dumpPath), ['service_items', 'service_item_components', 'warranties'])
  return { service_items: t.service_items!, service_item_components: t.service_item_components!, warranties: t.warranties! }
}

async function loadExisting(trx: ScopedTx): Promise<ExistingState> {
  const terms = await trx.selectFrom('warranty_terms').select(['id', 'name', 'days', 'max_km']).execute()
  const termName = new Map(terms.map((t) => [t.id, t.name]))
  const items = await trx
    .selectFrom('catalog_items')
    .select(['id', 'legacy_id', 'legacy_source', 'category', 'name', 'category_key', 'name_key', 'is_set', 'is_active', 'base_price', 'warranty_term_id', 'merged_into_id'])
    .execute()
  const importedIds = items.filter((i) => i.legacy_source === ITEM_SOURCE).map((i) => i.id)
  const components = importedIds.length === 0 ? [] : await trx
    .selectFrom('catalog_set_components')
    .select(['id', 'set_item_id', 'sort_order', 'component_name', 'qty'])
    .where('set_item_id', 'in', importedIds)
    .execute()
  return {
    terms,
    items: items.map((i) => ({
      id: i.id,
      legacy_id: i.legacy_source === ITEM_SOURCE ? i.legacy_id : null,
      category: i.category, name: i.name, category_key: i.category_key, name_key: i.name_key,
      is_set: i.is_set, is_active: i.is_active, base_price: i.base_price,
      warranty_term_name: i.warranty_term_id ? termName.get(i.warranty_term_id) ?? null : null,
      merged: i.merged_into_id !== null,
    })),
    components,
  }
}

async function applyPlan(trx: ScopedTx, shopId: string, plan: Plan): Promise<{ audit: Record<string, unknown> }> {
  const termId = new Map<string, string>()
  for (const t of plan.terms) {
    if (t.action === 'insert') {
      const row = await trx.insertInto('warranty_terms')
        .values({ shop_id: shopId, name: t.name, days: t.days, max_km: t.maxKm, is_active: t.isActive })
        .returning('id').executeTakeFirstOrThrow()
      termId.set(t.legacyId, row.id)
    } else {
      termId.set(t.legacyId, t.existingId!)
      if (t.action === 'update') {
        await trx.updateTable('warranty_terms').set({ days: t.days, max_km: t.maxKm })
          .where('shop_id', '=', shopId).where('id', '=', t.existingId!).execute()
      }
    }
  }

  const itemId = new Map<string, string>()
  for (const i of plan.items) {
    const warranty_term_id = i.warrantyLegacyId ? termId.get(i.warrantyLegacyId)! : null
    if (i.action === 'insert') {
      const row = await trx.insertInto('catalog_items')
        .values({
          shop_id: shopId, category: i.category, name: i.name, line_type: 'part',
          is_set: i.isSet, is_active: i.isActive, base_price: i.basePrice, warranty_term_id,
          legacy_source: ITEM_SOURCE, legacy_id: i.legacyId,
        })
        .returning('id').executeTakeFirstOrThrow()
      itemId.set(i.legacyId, row.id)
    } else {
      itemId.set(i.legacyId, i.existingId!)
      if (i.action === 'update') {
        await trx.updateTable('catalog_items')
          .set({ category: i.category, name: i.name, is_set: i.isSet, is_active: i.isActive, base_price: i.basePrice, warranty_term_id })
          .where('shop_id', '=', shopId).where('id', '=', i.existingId!).execute()
      }
    }
  }

  for (const c of plan.components) {
    const set_item_id = itemId.get(c.legacySetId)!
    if (c.action === 'insert') {
      await trx.insertInto('catalog_set_components')
        .values({ shop_id: shopId, set_item_id, component_name: c.name, qty: c.qty, sort_order: c.sortOrder })
        .execute()
    } else if (c.action === 'update') {
      await trx.updateTable('catalog_set_components').set({ component_name: c.name, qty: c.qty })
        .where('shop_id', '=', shopId).where('id', '=', c.existingId!).execute()
    }
  }

  const audit = {
    terms: countByAction(plan.terms), items: countByAction(plan.items), components: countByAction(plan.components),
    ambiguities: plan.ambiguities.length,
  }
  // One summary row per run: this is catalog data, not money or stock, so a
  // per-row trail would be noise; the legacy keys already say where each row came from.
  await trx.insertInto('audit_logs')
    .values({ shop_id: shopId, actor_id: null, action: 'catalog_import', entity_type: 'catalog_import', after: JSON.stringify(audit) })
    .execute()
  return { audit }
}

export function renderReport(plan: Plan, meta: { dryRun: boolean; shopSlug: string; shopId: string; dump: string }): string {
  const L: string[] = []
  const c = (rows: { action: 'insert' | 'update' | 'unchanged' }[]) => {
    const n = countByAction(rows)
    return `${rows.length} (insert ${n.insert}, update ${n.update}, unchanged ${n.unchanged})`
  }
  L.push(`# WO-004 phase 1 catalog import -- ${meta.dryRun ? 'DRY RUN' : 'REAL RUN'}`)
  L.push('', `shop: ${meta.shopSlug} (${meta.shopId})`, `dump: ${meta.dump}`, '')
  L.push('## Counts', '', `- warranty_terms: ${c(plan.terms)}`, `- catalog_items: ${c(plan.items)}`, `- catalog_set_components: ${c(plan.components)}`)
  L.push(`- sets (is_set): ${plan.items.filter((i) => i.isSet).length}`, `- base_price NULL after import: ${plan.items.filter((i) => i.basePrice === null).length}`)
  L.push(`  - NULL already in source: ${plan.priceNulls.nullInSource}; 0 in source -> NULL: ${plan.priceNulls.zero}; negative: ${plan.priceNulls.negative}; unparseable: ${plan.priceNulls.unparseable}`, '')
  L.push('## Warranty conversion (days = year x 365 + month x 30; 0 km = no km limit)', '')
  for (const t of plan.terms) L.push(`- [${t.action}] #${t.legacyId} "${t.name}": ${t.from.year ?? 0}y ${t.from.month ?? 0}m ${t.from.km ?? 0}km -> days=${t.days ?? 'NULL'} max_km=${t.maxKm ?? 'NULL'}`)
  L.push('', '## Needs a human (nothing below was guessed)', '')
  L.push('- All catalog_items.line_type = part and all components line_type = part: the prototype has no type column and CLAUDE.md 5.2 forbids guessing from names. Many components are labour (e.g. "ประกอบติดตั้ง"); a person should set those.')
  L.push('- component_item_id is NULL on every component: linking to an item by name would be a guess.')
  const by = new Map<string, typeof plan.ambiguities>()
  for (const a of plan.ambiguities) by.set(a.code, [...(by.get(a.code) ?? []), a])
  if (by.size === 0) L.push('- no row-level ambiguities')
  for (const [code, rows] of by) {
    L.push('', `### ${code} (${rows.length})`, '')
    for (const a of rows) L.push(`- ${a.table} #${a.legacyId ?? '-'}: ${a.detail}`)
  }
  return L.join('\n') + '\n'
}

/**
 * Counts of old document lines per inactive warranty. Reads ONLY the parent id
 * and warranty_name of quotation_items / receipt_items: every other cell of
 * those rows is dropped at tokenising time (see extractTables keepColumns), no
 * customer table is opened, and only counts are returned.
 */
export async function readWarrantyUsage(dump: string, src: SourceTables): Promise<Map<string, WarrantyUsage>> {
  const out = new Map<string, WarrantyUsage>()
  const targets = src.warranties.filter((w) => INACTIVE_WARRANTY_LEGACY_IDS.includes(w.id ?? ''))
  if (targets.length === 0) return out
  const t = await extractTables(linesOfFile(dump), ['quotation_items', 'receipt_items'], USAGE_COLUMNS)
  for (const w of targets) {
    out.set(w.id!, countWarrantyUse(t.quotation_items!, t.receipt_items!, (w.warranty_name ?? '').trim()))
  }
  return out
}

/** Short readable note for the owner about each warranty imported inactive. */
export function renderWarrantyReview(plan: Plan, src: SourceTables, usageById: Map<string, WarrantyUsage> = new Map()): string {
  const L = ['# Warranties imported INACTIVE -- for review', '']
  for (const t of plan.terms.filter((x) => !x.isActive)) {
    const items = src.service_items.filter((r) => r.warranty_id === t.legacyId)
    L.push(`## #${t.legacyId} "${t.name}"`, '')
    L.push(`- days: ${t.days ?? 'none'}   max_km: ${t.maxKm ?? 'none'}   (from ${t.from.year ?? 0}y ${t.from.month ?? 0}m ${t.from.km ?? 0}km)`)
    L.push(`- catalog items that reference it: ${items.length}${items.length ? ' -- ' + items.map((r) => r.product_name).join(', ') : ''}`)
    const u = usageById.get(t.legacyId)
    L.push(u
      ? `- old documents using it (exact match on the warranty text, counts only): quotation lines ${u.quotationLines} in ${u.quotationDocs} quotations; receipt lines ${u.receiptLines} in ${u.receiptDocs} receipts`
      : '- old documents using it: not counted in this run')
    L.push('- state: is_active = false, so new quotes cannot pick it. Re-activate it in the warranty settings if you want it back; a re-run of the import will not switch it off again.', '')
  }
  if (L.length === 2) L.push('No inactive warranties in this run.')
  return L.join('\n') + '\n'
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const dump = resolve(arg('--dump') ?? DEFAULT_DUMP)
  const shopSlug = arg('--shop') ?? 'samut-prakan'
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set (run through the npm script so .env is loaded)')
  assertLocalDatabase(url)

  // Validated before anything is read or written. The dump's own folder is
  // accepted when it is a gitignored `_import` directory (it is, in practice).
  const checkoutImport = resolve(HERE, '..', '..', '..', '..', '_import')
  const dumpDir = dirname(dump)
  const reportRoot = basename(dumpDir) === '_import' ? dumpDir : checkoutImport
  const reportDir = resolveReportDir(arg('--report-dir') ?? reportRoot, reportRoot)

  const src = await readSource(dump)
  console.log(`read dump: service_items=${src.service_items.length} service_item_components=${src.service_item_components.length} warranties=${src.warranties.length}`)

  const usage = await readWarrantyUsage(dump, src)

  const db: Db = createDb(url)
  try {
    const who = await sql<{ current_user: string }>`select current_user`.execute(db)
    assertAppRole(who.rows[0]?.current_user ?? '')

    const shop = await db.selectFrom('shops').select(['id', 'slug']).where('slug', '=', shopSlug).executeTakeFirst()
    if (!shop) throw new Error(`no shop with slug "${shopSlug}"`)
    console.log(`shop: ${shop.slug} ${shop.id}`)

    const result = await withShop(db, shop.id, async (trx) => {
      if (dryRun) await sql`set transaction read only`.execute(trx)
      const plan = buildPlan(src, await loadExisting(trx))
      if (!dryRun) await applyPlan(trx, shop.id, plan)
      return plan
    })

    await mkdir(reportDir, { recursive: true })
    const reportPath = join(reportDir, `catalog-import-report${dryRun ? '-dryrun' : ''}.md`)
    await writeFile(reportPath, renderReport(result, { dryRun, shopSlug: shop.slug, shopId: shop.id, dump }), 'utf8')

    await writeFile(join(reportDir, 'warranty-4-for-review.md'), renderWarrantyReview(result, src, usage), 'utf8')
    await writeFile(join(reportDir, 'review-duplicates.csv'), duplicatesCsv(duplicateGroups(src.service_items)), 'utf8')

    const ct = (rows: { action: 'insert' | 'update' | 'unchanged' }[]) => JSON.stringify(countByAction(rows))
    console.log(`${dryRun ? 'DRY RUN -- nothing written' : 'WRITTEN'}`)
    console.log(`  warranty_terms          ${ct(result.terms)}`)
    console.log(`  catalog_items           ${ct(result.items)}  sets=${result.items.filter((i) => i.isSet).length}`)
    console.log(`  catalog_set_components  ${ct(result.components)}`)
    console.log(`  base_price NULL: ${result.items.filter((i) => i.basePrice === null).length} (0->NULL: ${result.priceNulls.zero}, NULL in source: ${result.priceNulls.nullInSource})`)
    console.log(`  ambiguities: ${result.ambiguities.length}`)
    console.log(`  report: ${reportPath}`)
  } finally {
    await db.destroy()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
}
