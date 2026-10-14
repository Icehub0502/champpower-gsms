// Tier 1 — the P3.1 wire contracts (packages/contracts catalog.ts / quotation.ts).
// These schemas are what keeps a cost or a price out of the wrong response, so
// the guarantees are tested directly: strictness, the work order carrying no
// money, and the input rules the screen relies on.

import { describe, expect, it } from 'vitest'
import {
  AddLineInput,
  CatalogHit,
  CatalogMergeInput,
  CatalogPriceCreateInput,
  ConfirmInput,
  DecideLineInput,
  PatchLineInput,
  QuotationBody,
  QuotationRefusal,
  UndoConfirmInput,
  UpdateJobStatusInput,
  WorkOrder,
  WorkOrderLine,
} from '@gsms/contracts/index.js'

const id = '11111111-1111-4111-8111-111111111111'
const id2 = '22222222-2222-4222-8222-222222222222'

describe('catalog hits carry no cost', () => {
  const hit = {
    section: 'set', itemId: id, offeredItemId: null, category: 'ช่วงล่าง', name: 'ชุดโปรช่วงล่าง',
    lineType: 'part', unit: 'ชุด', defaultQty: '1', isSet: true, componentCount: 6,
    price: '20000.00', priceSource: 'base', priceRefId: null, warranty: null,
  }
  it('parses a normal hit', () => {
    expect(CatalogHit.safeParse(hit).success).toBe(true)
  })
  it.each(['cost', 'avgCost', 'avg_cost', 'unitCost', 'margin', 'productPrice'])('refuses an extra %s field', (k) => {
    expect(CatalogHit.safeParse({ ...hit, [k]: '1.00' }).success).toBe(false)
  })
})

describe('work order has no money and no document number', () => {
  const line = { id, parentLineId: null, sortOrder: 0, lineType: 'part', name: 'x', brand: null, qty: '1', unit: null, warrantyName: null }
  it('parses', () => {
    expect(WorkOrderLine.safeParse(line).success).toBe(true)
    expect(WorkOrder.safeParse({ jobId: id, jobNumber: 'JB-1', plate: null, province: null, brand: null, model: null, lines: [line] }).success).toBe(true)
  })
  it.each(['unitPrice', 'lineTotal', 'price', 'approvedAmount', 'listPrice'])('refuses %s on a work order line', (k) => {
    expect(WorkOrderLine.safeParse({ ...line, [k]: '1.00' }).success).toBe(false)
  })
  it.each(['number', 'documentNumber', 'totals', 'approvedTotal'])('refuses %s on a work order', (k) => {
    expect(
      WorkOrder.safeParse({ jobId: id, jobNumber: 'J', plate: null, province: null, brand: null, model: null, lines: [], [k]: 'x' }).success,
    ).toBe(false)
  })
})

describe('AddLineInput', () => {
  it('item / set / offered / free', () => {
    expect(AddLineInput.safeParse({ kind: 'item', itemId: id }).success).toBe(true)
    expect(AddLineInput.safeParse({ kind: 'set', itemId: id, unitPrice: '19000' }).success).toBe(true)
    expect(AddLineInput.safeParse({ kind: 'offered', offeredItemId: id }).success).toBe(true)
    expect(AddLineInput.safeParse({ kind: 'free', name: 'น็อต', category: 'ทั่วไป' }).success).toBe(true)
  })
  it('free text: add-to-catalog defaults to true and then needs a category', () => {
    const r = AddLineInput.safeParse({ kind: 'free', name: 'น็อต' })
    expect(r.success).toBe(false)
    const ok = AddLineInput.safeParse({ kind: 'free', name: 'น็อต', category: 'ทั่วไป' })
    expect(ok.success && ok.data.kind === 'free' && ok.data.addToCatalog).toBe(true)
    expect(AddLineInput.safeParse({ kind: 'free', name: 'น็อต', addToCatalog: false }).success).toBe(true)
    expect(AddLineInput.safeParse({ kind: 'free', name: 'น็อต', useExistingItemId: id }).success).toBe(true)
  })
  it('rejects a negative or float-ish price and unknown keys', () => {
    expect(AddLineInput.safeParse({ kind: 'item', itemId: id, unitPrice: '-1' }).success).toBe(false)
    expect(AddLineInput.safeParse({ kind: 'item', itemId: id, unitPrice: '1.005' }).success).toBe(false)
    expect(AddLineInput.safeParse({ kind: 'item', itemId: id, shopId: id }).success).toBe(false)
    expect(AddLineInput.safeParse({ kind: 'item', itemId: id, children: [] }).success).toBe(false)
  })
  it('qty must be positive', () => {
    expect(AddLineInput.safeParse({ kind: 'item', itemId: id, qty: '0' }).success).toBe(false)
  })
})

describe('PatchLineInput', () => {
  it('refuses an empty patch and unknown keys', () => {
    expect(PatchLineInput.safeParse({}).success).toBe(false)
    expect(PatchLineInput.safeParse({ approvalStatus: 'approved' }).success).toBe(false)
    expect(PatchLineInput.safeParse({ unitPrice: '10' }).success).toBe(true)
  })
})

describe('DecideLineInput', () => {
  it('approve takes no reason', () => {
    expect(DecideLineInput.safeParse({ decision: 'approved' }).success).toBe(true)
    expect(DecideLineInput.safeParse({ decision: 'approved', reason: 'other' }).success).toBe(false)
  })
  it('decline needs a reason; other needs a note', () => {
    expect(DecideLineInput.safeParse({ decision: 'declined' }).success).toBe(false)
    expect(DecideLineInput.safeParse({ decision: 'declined', reason: 'next_time' }).success).toBe(true)
    expect(DecideLineInput.safeParse({ decision: 'declined', reason: 'other' }).success).toBe(false)
    expect(DecideLineInput.safeParse({ decision: 'declined', reason: 'other', note: 'x' }).success).toBe(true)
  })
  it('chose_alternative is a valid line reason', () => {
    expect(DecideLineInput.safeParse({ decision: 'declined', reason: 'chose_alternative' }).success).toBe(true)
  })
})

describe('ConfirmInput', () => {
  it('works with no adjustments', () => {
    expect(ConfirmInput.safeParse({}).success).toBe(true)
  })
  it('an adjustment needs a reason', () => {
    expect(ConfirmInput.safeParse({ adjustments: { discount: { amount: '100' } } }).success).toBe(false)
    expect(ConfirmInput.safeParse({ adjustments: { discount: { amount: '100', reason: 'ลูกค้าประจำ' } } }).success).toBe(true)
    expect(
      ConfirmInput.safeParse({ adjustments: { setLines: [{ lineId: id, approvedAmount: '18000', reason: 'ตัดตั้งศูนย์ออก' }] } }).success,
    ).toBe(true)
    expect(ConfirmInput.safeParse({ adjustments: { setLines: [{ lineId: id, approvedAmount: '-1', reason: 'x' }] } }).success).toBe(false)
  })
})

describe('other inputs', () => {
  it('undo confirm needs a reason', () => {
    expect(UndoConfirmInput.safeParse({}).success).toBe(false)
    expect(UndoConfirmInput.safeParse({ reason: 'กดผิด' }).success).toBe(true)
  })
  it('the first price must not carry a shop id', () => {
    expect(CatalogPriceCreateInput.safeParse({ jobId: id, itemId: id2, price: '100' }).success).toBe(true)
    expect(CatalogPriceCreateInput.safeParse({ jobId: id, itemId: id2, price: '100', shopId: id }).success).toBe(false)
  })
  it('merge defaults to no conflict choices', () => {
    const r = CatalogMergeInput.safeParse({ intoItemId: id })
    expect(r.success && r.data.priceConflicts).toEqual([])
  })
  it('closing a job as rejected accepts a decline reason but not chose_alternative', () => {
    const base = { to: 'rejected', fromStatus: 'quoted' }
    expect(UpdateJobStatusInput.safeParse({ ...base, declineReason: 'too_expensive' }).success).toBe(true)
    expect(UpdateJobStatusInput.safeParse({ ...base, declineReason: 'chose_alternative' }).success).toBe(false)
  })
})

describe('error codes are strict schemas', () => {
  it('parses a price_already_set body and refuses an extra field', () => {
    const body = { error: 'price_already_set', message: 'm', existingPrice: '1200.00', scope: 'model' }
    expect(QuotationRefusal.safeParse(body).success).toBe(true)
    expect(QuotationRefusal.safeParse({ ...body, cost: '1' }).success).toBe(false)
  })
  it('refuses a code nobody registered', () => {
    expect(QuotationRefusal.safeParse({ error: 'something_else', message: 'm' }).success).toBe(false)
  })
})

describe('QuotationBody carries the freeze refusals', () => {
  it('document_job_immutable is strict: a stray field fails', () => {
    expect(QuotationBody.safeParse({ error: 'document_job_immutable', message: 'm', jobId: 'x' }).success).toBe(false)
  })
  it.each(['document_frozen', 'document_line_frozen', 'document_job_immutable'])('parses %s', (code) => {
    const r = QuotationBody.safeParse({ error: code, message: 'm' })
    expect(r.success).toBe(true)
  })
})
