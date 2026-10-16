/**
 * Every refusal the quotation and catalog doors can send has its own Thai
 * words on screen; a body that does not parse against the contract is an
 * unknown error and nothing from it is shown.
 */
import { describe, expect, it } from 'vitest';
import type { QuotationBody } from '@gsms/contracts/index.js';
import { ApiError } from '../../lib/api/client';
import { SessionCancelledError } from '../../lib/api/sessionCancelled';
import { GENERIC_QUOTE_FAILURE, discountExceedsApprovedText, describeQuoteError } from './quoteErrors';

const LINE = '00000000-0000-4000-8000-000000000101';
const ITEM = '00000000-0000-4000-8000-000000000201';

function refusal(status: number, body: QuotationBody): ApiError {
  return new ApiError(status, body.error, body);
}

// One body per code in QuotationBody (packages/contracts errors.ts).
const BODIES: QuotationBody[] = [
  { error: 'quotation_not_found', message: 'x' },
  { error: 'quotation_line_not_found', message: 'x' },
  { error: 'job_not_found', message: 'x' },
  { error: 'catalog_item_not_found', message: 'x' },
  { error: 'vehicle_model_not_found', message: 'x' },
  { error: 'offered_item_not_found', message: 'x' },
  { error: 'forbidden', message: 'x' },
  { error: 'quotation_exists', message: 'x' },
  { error: 'quotation_not_draft', message: 'x' },
  { error: 'quotation_not_issued', message: 'x' },
  { error: 'quotation_frozen', message: 'x' },
  { error: 'quotation_empty', message: 'x' },
  { error: 'decisions_incomplete', message: 'x', lineIds: [LINE] },
  { error: 'set_amount_required', message: 'x', lineIds: [LINE] },
  { error: 'discount_required', message: 'x', fields: { 'adjustments.discount.amount': ['required'] } },
  { error: 'discount_exceeds_approved', message: 'x', fields: { 'adjustments.discount.amount': ['too_big'] }, max: '100.00' },
  { error: 'amount_over_2x', message: 'x', lineId: LINE, offered: '20000.00', max: '40000.00' },
  { error: 'amount_above_offer_free_set', message: 'x', lineId: LINE },
  { error: 'approved_amount_not_allowed', message: 'x', lineId: LINE },
  { error: 'undo_confirm_different_day', message: 'x' },
  { error: 'undo_confirm_job_moved_on', message: 'x' },
  { error: 'quotation_confirmed', message: 'x' },
  { error: 'price_already_set', message: 'x', existingPrice: '1250.00', scope: 'model' },
  { error: 'similar_item_found', message: 'x', similar: [{ id: ITEM, category: 'ช่วงล่าง', name: 'ลูกหมากปีกนกล่าง L+R' }] },
  { error: 'catalog_item_exists', message: 'x', itemId: ITEM },
  { error: 'merge_not_allowed', message: 'x' },
  { error: 'merge_price_conflict', message: 'x', vehicleModelIds: [ITEM] },
  { error: 'vehicle_model_exists', message: 'x', vehicleModelId: ITEM },
  { error: 'invalid_request', message: 'x', fields: { reason: ['required'] } },
  { error: 'document_series_missing', message: 'x' },
  { error: 'warranty_term_not_found', message: 'x' },
  { error: 'vehicle_not_found', message: 'x' },
  { error: 'job_not_open', message: 'x' },
  { error: 'quotation_missing', message: 'x' },
  { error: 'quotation_not_confirmed', message: 'x' },
  { error: 'document_frozen', message: 'x' },
  { error: 'document_line_frozen', message: 'x' },
  { error: 'document_job_immutable', message: 'x' },
];

describe('describeQuoteError', () => {
  it.each(BODIES.map((b) => [b.error, b] as const))('%s has its own Thai words, never the server message', (_code, body) => {
    const f = describeQuoteError(refusal(409, body));
    expect(f.text).not.toBe(GENERIC_QUOTE_FAILURE);
    expect(f.text).not.toBe('x');
    expect(f.text).toMatch(/[฀-๿]/); // Thai script
    expect(f.body?.error).toBe(body.error);
  });

  it('amount_over_2x names the offer and the ceiling as baht, and the set it is about', () => {
    const f = describeQuoteError(refusal(422, BODIES.find((b) => b.error === 'amount_over_2x')!));
    expect(f.text).toContain('฿20,000.00');
    expect(f.text).toContain('฿40,000.00');
    expect(f.lineIds).toEqual([LINE]);
  });

  it('price_already_set says the price that stands', () => {
    const f = describeQuoteError(refusal(409, BODIES.find((b) => b.error === 'price_already_set')!));
    expect(f.text).toBe('ราคานี้ถูกตั้งไปแล้วเป็น ฿1,250.00');
  });

  it('invalid_request puts each field code next to its field, in words', () => {
    const f = describeQuoteError(refusal(400, { error: 'invalid_request', message: 'x', fields: { reason: ['required'], unitPrice: ['invalid_money'] } }));
    expect(f.fields.reason).toBe('จำเป็นต้องกรอก');
    expect(f.fields.unitPrice).toContain('จำนวนเงินไม่ถูกต้อง');
  });

  it('discount_required puts its words on the discount amount field of the confirm body', () => {
    const f = describeQuoteError(refusal(400, { error: 'discount_required', message: 'x', fields: { 'adjustments.discount.amount': ['required'] } }));
    expect(f.fields['adjustments.discount.amount']).toContain('กรอกส่วนลดใหม่');
    expect(f.stale).toBe(false);
  });

  it('discount_exceeds_approved puts the dialog\'s own words, with the ceiling, on the discount amount field', () => {
    const f = describeQuoteError(refusal(400, {
      error: 'discount_exceeds_approved', message: 'x', fields: { 'adjustments.discount.amount': ['too_big'] }, max: '100.00',
    }));
    expect(f.fields['adjustments.discount.amount']).toBe(discountExceedsApprovedText('฿100.00'));
    expect(f.fields['adjustments.discount.amount']).toContain('฿100.00');
    expect(f.text).toBe(f.fields['adjustments.discount.amount']);
  });

  it('a refusal that means the page is out of date asks for a reload', () => {
    expect(describeQuoteError(refusal(409, { error: 'quotation_not_draft', message: 'x' })).stale).toBe(true);
    expect(describeQuoteError(refusal(409, { error: 'price_already_set', message: 'x', existingPrice: '1.00', scope: 'base' })).stale).toBe(false);
    expect(describeQuoteError(new ApiError(409, 'document_line_frozen', { error: 'document_line_frozen', message: 'x' })).stale).toBe(true);
    // Parsed through the contract now: a frozen body with a stray field is an unknown error, not trusted by its code.
    expect(describeQuoteError(new ApiError(409, 'document_frozen', { error: 'document_frozen', message: 'x', table: 'documents' })).text).toBe(GENERIC_QUOTE_FAILURE);
  });

  it('document_job_immutable is stale (reload) and carries its own words', () => {
    const f = describeQuoteError(new ApiError(409, 'document_job_immutable', { error: 'document_job_immutable', message: 'x' }));
    expect(f.stale).toBe(true);
    expect(f.text).toContain('เปลี่ยนงานไม่ได้');
  });

  it('a body that does not parse is an unknown error — nothing from it is shown', () => {
    // An extra field (a phone, say) fails the strict schema.
    const f = describeQuoteError(new ApiError(409, 'price_already_set', { error: 'price_already_set', message: 'x', existingPrice: '1.00', scope: 'model', phone: '0812345678' }));
    expect(f.text).toBe(GENERIC_QUOTE_FAILURE);
    expect(f.body).toBeNull();
    expect(JSON.stringify(f)).not.toContain('0812345678');
  });

  it('403 / 429 / network / logout', () => {
    expect(describeQuoteError(new ApiError(403, 'forbidden')).text).toBe('คุณไม่มีสิทธิ์ทำรายการนี้');
    expect(describeQuoteError(new ApiError(429, 'rate_limited')).text).toContain('ถี่เกินไป');
    expect(describeQuoteError(new TypeError('Failed to fetch')).text).toBe(GENERIC_QUOTE_FAILURE);
    expect(describeQuoteError(new SessionCancelledError()).cancelled).toBe(true);
  });
});
