import { describe, expect, it } from 'vitest'
import { extractTables, parseCreateColumns, parseValuesTuples } from './mysqlDump.js'
import {
  buildPlan, convertPrice, convertWarranty, countByAction, warrantyDays,
  type ExistingState, type SourceTables,
} from './catalogPlan.js'
import { resolve } from 'node:path'
import { countWarrantyUse, duplicateGroups, duplicatesCsv } from './catalogReview.js'
import { assertAppRole, assertLocalDatabase, renderReport, renderWarrantyReview, resolveReportDir } from './catalog.js'

// Synthetic data only: invented names, no real rows.
const DUMP = String.raw`-- header
CREATE TABLE ` + '`customers`' + String.raw` (
  ` + '`id`' + String.raw` bigint NOT NULL,
  ` + '`phone`' + String.raw` varchar(20) DEFAULT NULL
) ENGINE=InnoDB;
INSERT INTO ` + '`customers`' + String.raw` VALUES (1,'0800000000');
CREATE TABLE ` + '`warranties`' + String.raw` (
  ` + '`id`' + String.raw` bigint NOT NULL,
  ` + '`warranty_name`' + String.raw` varchar(255) NOT NULL,
  ` + '`warranty_year`' + String.raw` int DEFAULT '0',
  ` + '`warranty_month`' + String.raw` int DEFAULT '0',
  ` + '`warranty_km`' + String.raw` int DEFAULT '0',
  PRIMARY KEY (` + '`id`' + String.raw`)
) ENGINE=InnoDB;
INSERT INTO ` + '`warranties`' + String.raw` VALUES (1,'one year',1,0,100000),(2,'six months',0,6,0),(3,'none',0,0,0);
`

const W: SourceTables['warranties'] = [
  { id: '1', warranty_name: 'one year', warranty_year: '1', warranty_month: '0', warranty_km: '100000' },
  { id: '2', warranty_name: 'six months', warranty_year: '0', warranty_month: '6', warranty_km: '0' },
  { id: '3', warranty_name: 'none', warranty_year: '0', warranty_month: '0', warranty_km: '0' },
]
const item = (id: string, category: string, name: string, extra: Record<string, string | null> = {}) => ({
  id, category, product_name: name, warranty_id: null, is_active: '1', is_set: '0', set_price: null, ...extra,
})
const comp = (id: string, set: string, name: string, qty = '1', sort = '0') => ({
  id, service_item_id: set, component_name: name, default_qty: qty, sort_order: sort,
})
const EMPTY: ExistingState = { terms: [], items: [], components: [] }

describe('mysqldump reader', () => {
  it('decodes strings, escapes, NULL and numbers', () => {
    const rows = parseValuesTuples(String.raw`(1,'a\'b',NULL,2.50),(2,'it''s\n',-3,'')`)
    expect(rows).toEqual([['1', "a'b", null, '2.50'], ['2', "it's\n", '-3', '']])
  })
  it('keeps commas and parentheses inside strings', () => {
    expect(parseValuesTuples(`(1,'x,(y)'),(2,'z');`)).toEqual([['1', 'x,(y)'], ['2', 'z']])
  })
  it('rejects malformed input instead of guessing', () => {
    expect(() => parseValuesTuples(`(1,'open`)).toThrow(/unterminated/)
    expect(() => parseValuesTuples(`(1,abc)`)).toThrow(/unsupported literal/)
  })
  it('reads column names from CREATE TABLE', () => {
    expect(parseCreateColumns(['  `id` bigint', '  `a_b` int DEFAULT 0', '  PRIMARY KEY (`id`)'])).toEqual(['id', 'a_b'])
  })
  it('extracts only the wanted table and never decodes the others', async () => {
    const out = await extractTables(DUMP.split('\n'), ['warranties'])
    expect(Object.keys(out)).toEqual(['warranties'])
    expect(out.warranties).toHaveLength(3)
    expect(out.warranties![1]).toEqual({ id: '2', warranty_name: 'six months', warranty_year: '0', warranty_month: '6', warranty_km: '0' })
  })
  it('fails when a wanted table is missing', async () => {
    await expect(extractTables(DUMP.split('\n'), ['service_items'])).rejects.toThrow(/not found/)
  })
})

describe('converters', () => {
  it('warranty days = year*365 + month*30', () => {
    expect(warrantyDays(1, 0)).toBe(365)
    expect(warrantyDays(0, 6)).toBe(180)
    expect(warrantyDays(1, 6)).toBe(545)
    expect(convertWarranty(1, 0, 100000)).toEqual({ days: 365, maxKm: 100000 })
    expect(convertWarranty(0, 3, 0)).toEqual({ days: 90, maxKm: null })
    expect(convertWarranty(0, 0, 50000)).toEqual({ days: null, maxKm: 50000 })
  })
  it('refuses an all-zero warranty (ck_term_has_limit) instead of inventing a limit', () => {
    expect(convertWarranty(0, 0, 0)).toHaveProperty('problem')
    expect(convertWarranty(-1, 0, 0)).toHaveProperty('problem')
  })
  it('price: 0 and NULL become NULL, real prices keep two decimals', () => {
    expect(convertPrice(null)).toEqual({ price: null, note: 'null_in_source' })
    expect(convertPrice('0.00')).toEqual({ price: null, note: 'zero_means_unpriced' })
    expect(convertPrice('0')).toEqual({ price: null, note: 'zero_means_unpriced' })
    expect(convertPrice('1500.00')).toEqual({ price: '1500.00', note: null })
    expect(convertPrice('1500')).toEqual({ price: '1500.00', note: null })
    expect(convertPrice('0.5')).toEqual({ price: '0.50', note: null })
    expect(convertPrice('12345.60')).toEqual({ price: '12345.60', note: null })
    expect(convertPrice('-5.00')).toEqual({ price: null, note: 'negative' })
    expect(convertPrice('1.234')).toEqual({ price: null, note: 'unparseable' })
    expect(convertPrice('abc')).toEqual({ price: null, note: 'unparseable' })
  })
})

describe('buildPlan', () => {
  const src = (): SourceTables => ({
    warranties: W,
    service_items: [
      item('1', 'Rack', 'Rack OEM', { warranty_id: '1', set_price: '2500.00' }),
      item('2', 'Rack', 'Rack used', { warranty_id: '2', set_price: '0.00' }),
      item('3', 'Pro set', 'Pro set A', { is_set: '1', set_price: '9900.00' }),
      item('4', 'Misc', 'Bush', { warranty_id: '3' }),
      item('5', 'Misc', 'Seal', { is_active: '0' }),
    ],
    service_item_components: [
      comp('10', '3', 'Pro set A'), comp('11', '3', '- arm', '2', '1'), comp('12', '3', '- install', '1', '2'),
    ],
  })

  it('converts items, sets, prices, warranties and counts', () => {
    const p = buildPlan(src(), EMPTY)
    expect(countByAction(p.items)).toEqual({ insert: 5, update: 0, unchanged: 0 })
    expect(p.items.filter((i) => i.isSet)).toHaveLength(1)
    expect(p.items.map((i) => i.basePrice)).toEqual(['2500.00', null, '9900.00', null, null])
    expect(p.priceNulls).toEqual({ zero: 1, nullInSource: 2, negative: 0, unparseable: 0 })
    expect(p.items.find((i) => i.legacyId === '5')!.isActive).toBe(false)
    expect(p.terms.map((t) => [t.name, t.days, t.maxKm])).toEqual([['one year', 365, 100000], ['six months', 180, null]])
    // warranty 3 is all zero: the term is skipped, item 4 imports without one, and it is reported.
    expect(p.items.find((i) => i.legacyId === '4')!.warrantyLegacyId).toBeNull()
    expect(p.ambiguities.map((a) => a.code)).toEqual(expect.arrayContaining(['price_zero_to_null', 'item_warranty_dropped']))
    expect(p.components.map((c) => [c.sortOrder, c.qty])).toEqual([[0, '1.00'], [1, '2.00'], [2, '1.00']])
  })

  it('is idempotent: planning against its own result changes nothing', () => {
    const first = buildPlan(src(), EMPTY)
    const state: ExistingState = {
      terms: first.terms.map((t, k) => ({ id: `t${k}`, name: t.name, days: t.days, max_km: t.maxKm })),
      items: first.items.map((i, k) => ({
        id: `i${k}`, legacy_id: i.legacyId, category: i.category, name: i.name,
        category_key: null, name_key: null, is_set: i.isSet, is_active: i.isActive, base_price: i.basePrice,
        warranty_term_name: i.warrantyLegacyId ? first.terms.find((t) => t.legacyId === i.warrantyLegacyId)!.name : null,
        merged: false,
      })),
      components: first.components.map((c, k) => ({
        id: `c${k}`, set_item_id: `i${first.items.findIndex((i) => i.legacyId === c.legacySetId)}`,
        sort_order: c.sortOrder, component_name: c.name, qty: c.qty,
      })),
    }
    const second = buildPlan(src(), state)
    expect(countByAction(second.terms)).toEqual({ insert: 0, update: 0, unchanged: 2 })
    expect(countByAction(second.items)).toEqual({ insert: 0, update: 0, unchanged: 5 })
    expect(countByAction(second.components)).toEqual({ insert: 0, update: 0, unchanged: 3 })
  })

  it('a hand edit in the target is planned as an update, not a new row', () => {
    const first = buildPlan(src(), EMPTY)
    const state: ExistingState = {
      terms: [],
      items: [{
        id: 'i0', legacy_id: '1', category: 'Rack', name: 'Rack OEM', category_key: null, name_key: null,
        is_set: false, is_active: true, base_price: '1.00', warranty_term_name: null, merged: false,
      }],
      components: [],
    }
    const p = buildPlan(src(), state)
    const one = p.items.find((i) => i.legacyId === '1')!
    expect(one.action).toBe('update')
    expect(one.existingId).toBe('i0')
    expect(countByAction(p.items).insert).toBe(first.items.length - 1)
  })

  const existingWithPrice = (price: string | null): ExistingState => ({
    terms: [],
    items: [{
      id: 'i0', legacy_id: '1', category: 'Rack', name: 'Rack OEM', category_key: null, name_key: null,
      is_set: false, is_active: true, base_price: price, warranty_term_name: null, merged: false,
    }],
    components: [],
  })

  it('never overwrites a DB price with NULL from the dump', () => {
    const s = src()
    s.service_items[0] = item('1', 'Rack', 'Rack OEM', { set_price: null })
    const one = buildPlan(s, existingWithPrice('1800.00')).items.find((i) => i.legacyId === '1')!
    expect(one.basePrice).toBe('1800.00')
  })

  it('keeps a different DB price, and lists it as "price differs"', () => {
    const p = buildPlan(src(), existingWithPrice('1800.00')) // dump says 2500.00
    const one = p.items.find((i) => i.legacyId === '1')!
    expect(one.basePrice).toBe('1800.00')
    const a = p.ambiguities.find((x) => x.code === 'price_differs')!
    expect(a.legacyId).toBe('1')
    expect(a.detail).toContain('1800.00')
    expect(a.detail).toContain('2500.00')
  })

  it('takes the dump price when the DB has none, and is silent when they match', () => {
    expect(buildPlan(src(), existingWithPrice(null)).items.find((i) => i.legacyId === '1')!.basePrice).toBe('2500.00')
    const same = buildPlan(src(), existingWithPrice('2500.00'))
    expect(same.ambiguities.some((x) => x.code === 'price_differs')).toBe(false)
  })

  it('shows both rows of a source duplicate side by side', () => {
    const s = src()
    s.service_items.push(item('6', 'Rack', 'rack-oem', { set_price: '999.00' }))
    const a = buildPlan(s, EMPTY).ambiguities.find((x) => x.code === 'item_duplicate_in_source')!
    expect(a.detail).toContain('#1:')
    expect(a.detail).toContain('#6:')
    expect(a.detail).toContain('set_price=2500.00')
    expect(a.detail).toContain('set_price=999.00')
  })

  it('imports only the lowest legacy id of a duplicate pair and reports the other', () => {
    const s = src()
    s.service_items.push(item('6', 'Rack', 'rack-oem'))
    const p = buildPlan(s, EMPTY)
    expect(p.items.find((i) => i.legacyId === '1')).toBeDefined()
    expect(p.items.find((i) => i.legacyId === '6')).toBeUndefined()
    expect(p.ambiguities.filter((a) => a.code === 'item_duplicate_in_source').map((a) => a.legacyId)).toEqual(['6'])
    // the held-back row is still listed in the review CSV, with its partner
    expect(duplicateGroups(s.service_items).map((g) => g.legacyIds)).toEqual([['1', '6']])
  })

  it('picks the winner by number, not by order in the dump or string order', () => {
    const s = src()
    s.service_items.push(item('100', 'Misc', 'Dup'), item('20', 'Misc', 'dup'))
    const p = buildPlan(s, EMPTY)
    expect(p.items.find((i) => i.legacyId === '20')).toBeDefined()
    expect(p.items.find((i) => i.legacyId === '100')).toBeUndefined()
  })

  it('does not overwrite a hand-made catalog row that already owns the name', () => {
    const state: ExistingState = {
      terms: [],
      items: [{
        id: 'x', legacy_id: null, category: 'Misc', name: 'Bush', category_key: 'misc', name_key: 'bush',
        is_set: false, is_active: true, base_price: null, warranty_term_name: null, merged: false,
      }],
      components: [],
    }
    const p = buildPlan(src(), state)
    expect(p.items.find((i) => i.legacyId === '4')).toBeUndefined()
    expect(p.ambiguities.some((a) => a.code === 'item_name_taken' && a.legacyId === '4')).toBe(true)
  })

  it('reports components that cannot be placed', () => {
    const s = src()
    s.service_item_components.push(comp('13', '999', 'orphan'), comp('14', '3', 'zero qty', '0', '9'), comp('15', '3', 'dup slot', '1', '1'))
    const p = buildPlan(s, EMPTY)
    const codes = p.ambiguities.map((a) => a.code)
    expect(codes).toEqual(expect.arrayContaining(['component_set_not_imported', 'component_invalid', 'component_duplicate_slot']))
    // both members of the duplicated (set 3, sort 1) slot are held back
    expect(p.components.map((c) => c.legacyId)).toEqual(['10', '12'])
  })

  it('imports warranty #4 inactive and everything else active; review note counts items', () => {
    const s = src()
    s.warranties.push({ id: '4', warranty_name: 'heavy', warranty_year: '0', warranty_month: '6', warranty_km: '0' })
    s.service_items.push(item('7', 'Misc', 'Heavy thing', { warranty_id: '4' }))
    const p = buildPlan(s, EMPTY)
    expect(p.terms.map((t) => [t.legacyId, t.isActive])).toEqual([['1', true], ['2', true], ['4', false]])
    const md = renderWarrantyReview(p, s)
    expect(md).toContain('"heavy"')
    expect(md).toContain('catalog items that reference it: 1')
    expect(md).toContain('not counted in this run')
    const withUsage = renderWarrantyReview(p, s, new Map([['4', { quotationLines: 5, quotationDocs: 3, receiptLines: 2, receiptDocs: 2 }]]))
    expect(withUsage).toContain('quotation lines 5 in 3 quotations; receipt lines 2 in 2 receipts')
  })

  it('leaves a locally merged item untouched and reports it (no write, no component noise)', () => {
    const s = src()
    s.service_item_components.push(comp('30', '1', 'part of merged'))
    const state: ExistingState = {
      terms: [],
      items: [{
        id: 'i0', legacy_id: '1', category: 'Rack', name: 'Rack OEM (old)', category_key: null, name_key: null,
        is_set: false, is_active: false, base_price: '1.00', warranty_term_name: null, merged: true,
      }],
      components: [],
    }
    const p = buildPlan(s, state)
    expect(p.items.find((i) => i.legacyId === '1')).toBeUndefined()
    expect(p.ambiguities.filter((a) => a.code === 'item_merged_locally_skipped').map((a) => a.legacyId)).toEqual(['1'])
    expect(p.components.some((c) => c.legacyId === '30')).toBe(false)
    expect(p.ambiguities.some((a) => a.code === 'component_set_not_imported' && a.legacyId === '30')).toBe(false)
  })

  it('never modifies an existing warranty term of the same name; reports a difference', () => {
    const state: ExistingState = {
      terms: [{ id: 'staff', name: 'one year', days: 400, max_km: null }],
      items: [], components: [],
    }
    const p = buildPlan(src(), state)
    const t = p.terms.find((x) => x.name === 'one year')!
    expect(t.action).toBe('unchanged')
    expect(t.existingId).toBe('staff')
    expect(p.terms.some((x) => x.action === 'update')).toBe(false)
    expect(p.ambiguities.some((a) => a.code === 'warranty_exists_differs')).toBe(true)
    // an identical existing term is linked silently
    const same = buildPlan(src(), { terms: [{ id: 'x', name: 'one year', days: 365, max_km: 100000 }], items: [], components: [] })
    expect(same.ambiguities.some((a) => a.code === 'warranty_exists_differs')).toBe(false)
  })

  it('reports an unreadable warranty value instead of reading it as 0 or unlimited', () => {
    expect(convertWarranty(null, 6, 0)).toHaveProperty('problem')
    expect(convertWarranty(0, 0, null)).toHaveProperty('problem')
    expect(convertWarranty(0, 0, 3_000_000_000)).toHaveProperty('problem')
    const s = src()
    s.warranties = [
      { id: '1', warranty_name: 'one year', warranty_year: 'abc', warranty_month: '0', warranty_km: '0' },
      { id: '2', warranty_name: 'six months', warranty_year: '0', warranty_month: null, warranty_km: '0' },
      W[2]!,
    ]
    const p = buildPlan(s, EMPTY)
    expect(p.terms).toHaveLength(0)
    expect(p.ambiguities.filter((a) => a.code === 'warranty_unreadable_value')).toHaveLength(2)
    expect(p.items.find((i) => i.legacyId === '1')!.warrantyLegacyId).toBeNull()
  })

  it('renders a report without throwing', () => {
    const md = renderReport(buildPlan(src(), EMPTY), { dryRun: true, shopSlug: 's', shopId: 'id', dump: 'd' })
    expect(md).toContain('DRY RUN')
    expect(md).toContain('price_zero_to_null')
  })
})

describe('review artefacts', () => {
  it('projects columns: unlisted cells never reach a row object', async () => {
    const lines = [
      'CREATE TABLE `t` (', '  `id` int NOT NULL,', '  `secret` varchar(20) DEFAULT NULL,', '  `w` varchar(20) DEFAULT NULL,', ') ENGINE=InnoDB;',
      "INSERT INTO `t` VALUES (1,'private','x'),(2,'private','y');",
    ]
    const out = await extractTables(lines, ['t'], { t: ['id', 'w'] })
    expect(out.t).toEqual([{ id: '1', w: 'x' }, { id: '2', w: 'y' }])
    expect(JSON.stringify(out)).not.toContain('private')
  })
  it('counts lines and distinct parent documents for one warranty text', () => {
    const q = [
      { quotation_id: '1', warranty_name: 'W4' }, { quotation_id: '1', warranty_name: ' W4 ' },
      { quotation_id: '2', warranty_name: 'other' }, { quotation_id: '3', warranty_name: null },
    ]
    const r = [{ receipt_id: '9', warranty_name: 'W4' }]
    expect(countWarrantyUse(q, r, 'W4')).toEqual({ quotationLines: 2, quotationDocs: 1, receiptLines: 1, receiptDocs: 1 })
  })
  it('lists every duplicate group in the CSV, with the WO-004 style columns', () => {
    const s = [
      item('1', 'Rack', 'Rack OEM', { created_at: '2026-01-01' }), item('6', 'Rack', 'rack-oem', { created_at: '2026-02-02' }),
      item('2', 'Rack', 'Unique'),
    ]
    const g = duplicateGroups(s)
    expect(g).toHaveLength(1)
    const csv = duplicatesCsv(g)
    expect(csv).toContain('kind,normalised_key,legacy_ids,names,categories,created_at')
    expect(csv).toContain('catalog_item,rack|rackoem,1 | 6,Rack OEM | rack-oem')
  })
})

describe('safety guard', () => {
  it('only accepts a local database', () => {
    expect(() => assertLocalDatabase('postgres://u:p@localhost:5432/gsms')).not.toThrow()
    expect(() => assertLocalDatabase('postgres://u:p@127.0.0.1/gsms')).not.toThrow()
    expect(() => assertLocalDatabase('postgres://u:p@[::1]:5432/gsms')).not.toThrow()
    expect(() => assertLocalDatabase('postgres://u:p@db.example.com/gsms')).toThrow(/not local/)
  })
  it('rejects query-string host overrides that pg would honour', () => {
    expect(() => assertLocalDatabase('postgres://u@localhost/db?host=evil.com')).toThrow()
    expect(() => assertLocalDatabase('postgres://u@localhost/db?hostaddr=203.0.113.9')).toThrow()
    expect(() => assertLocalDatabase('postgres://u@localhost/db?host=')).toThrow()
  })
  it('rejects any query parameter at all', () => {
    expect(() => assertLocalDatabase('postgres://u@localhost/db?sslmode=disable')).toThrow(/query/)
    expect(() => assertLocalDatabase('postgres://u@localhost/db?application_name=x')).toThrow(/query/)
  })
  it('rejects an empty host (unix socket or PGHOST fallback)', () => {
    expect(() => assertLocalDatabase('postgres://u@/db')).toThrow()
    expect(() => assertLocalDatabase('postgres:///db')).toThrow()
  })
  it('rejects garbage', () => {
    expect(() => assertLocalDatabase('not a url')).toThrow()
  })
})

describe('connected-role guard (L1)', () => {
  it('accepts only gsms_app', () => {
    expect(() => assertAppRole('gsms_app')).not.toThrow()
    expect(() => assertAppRole('postgres')).toThrow(/gsms_app/)
    expect(() => assertAppRole('')).toThrow()
  })
})

describe('report directory guard (L2)', () => {
  const root = resolve('/repo/_import')
  it('allows _import and its subfolders', () => {
    expect(resolveReportDir('/repo/_import', root)).toBe(root)
    expect(resolveReportDir('/repo/_import/out', root)).toBe(resolve('/repo/_import/out'))
  })
  it('rejects anything outside _import, including traversal and prefix tricks', () => {
    expect(() => resolveReportDir('/repo', root)).toThrow(/_import/)
    expect(() => resolveReportDir('/repo/docs', root)).toThrow(/_import/)
    expect(() => resolveReportDir('/repo/_import/../docs', root)).toThrow(/_import/)
    expect(() => resolveReportDir('/repo/_import-evil', root)).toThrow(/_import/)
  })
})
