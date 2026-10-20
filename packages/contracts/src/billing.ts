// Billing (P3.2): receipt, taking money, voiding, print history, daily summary
// and the cash count.
//
//   POST  /api/jobs/:jobId/receipt                        CreateReceiptInput     -> Receipt (201 new, 200 existing draft)
//   GET   /api/jobs/:jobId/receipt                        Receipt                (draft | issued | void)
//   POST  /api/jobs/:jobId/receipt/rebuild                RebuildReceiptInput    -> Receipt (draft only; re-reads the quotation)
//   PUT   /api/jobs/:jobId/receipt/fulfillment            FulfillmentInput       -> Receipt (draft only; explicit value per line)
//   PATCH /api/jobs/:jobId/receipt                        PatchReceiptInput      -> Receipt (draft only; the discount)
//   POST  /api/jobs/:jobId/receipt/close                  CloseReceiptInput      -> CloseReceiptResult (ONE transaction: payments + number + freeze)
//   POST  /api/jobs/:jobId/receipt/void                   VoidReceiptInput       -> Receipt (owner only)
//   PATCH /api/jobs/:jobId/receipt/lines/:lineId          LineDiscountInput      -> Receipt (draft only; Ice 20 Oct B4)
//   POST  /api/jobs/:jobId/receipt/present                PresentBillInput       -> Receipt (draft only; Ice 20 Oct B1: show the bill BEFORE money)
//   GET   /api/payment-channels                           PaymentChannelList     (?includeInactive=true for settings)
//   POST  /api/payment-channels                           CreatePaymentChannelInput -> PaymentChannel (owner, manager)
//   PATCH /api/payment-channels/:id                       PatchPaymentChannelInput  -> PaymentChannel (rename / surcharge / deactivate)
//   PUT   /api/payment-channels/order                     ReorderPaymentChannelsInput -> PaymentChannelList
//   POST  /api/jobs/:jobId/prints                         CreatePrintInput       -> PrintResult   (record BEFORE window.print())
//   GET   /api/jobs/:jobId/prints                         PrintHistoryQuery      -> PrintHistory
//   GET   /api/daily-summary                              DailySummaryQuery      -> DailySummary
//
// Money is a numeric(12,2) string on the wire. The server computes every total
// (packages/domain rules/receipt.ts) and says what the screen may do next; the
// screen displays, it does not decide. Nothing here accepts a total from the
// client (AC-E6). Payments are append-only: there is no PUT / DELETE for them.
//
// Ice 20 Oct (P3.2 B3): payment CHANNELS are per shop (name + kind + surcharge %).
// The kind is cash | transfer | card (QR counts as transfer). No `credit`.
//
// Everything is .strict().

import { z } from 'zod';
import { LineType, MoneyString, QtyString } from './catalog.js';
import { PageQuery, uuid } from './common.js';
import { LineWarranty } from './quotation.js';

const isoDateTime = z.string().datetime();
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date');
// Zero is a legal answer to "how many were done", unlike QtyString which refuses it.
export const FulfilledQtyString = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'invalid_qty');
const Reason = z.string().trim().min(1).max(500);

export const PaymentMethod = z.enum(['cash', 'transfer', 'card']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const ReceiptStatus = z.enum(['draft', 'issued', 'void']);
export type ReceiptStatus = z.infer<typeof ReceiptStatus>;

// -----------------------------------------------------------------------------
// Receipt (output)
// -----------------------------------------------------------------------------

export const ReceiptLineState = z.enum(['unanswered', 'done', 'partial', 'not_done']);
export type ReceiptLineState = z.infer<typeof ReceiptLineState>;

export const ReceiptLine = z
  .object({
    id: uuid,
    // The quotation line this one was copied from (what ties a tick to a revision).
    sourceLineId: uuid.nullable(),
    // Set child -> its set header; children carry no price and no tick of their own.
    parentLineId: uuid.nullable(),
    // A set header: done or not done as a whole (B5).
    isSet: z.boolean(),
    sortOrder: z.number().int(),
    lineType: LineType,
    name: z.string(),
    brand: z.string().nullable(),
    // Quantity approved on the quotation.
    qty: QtyString,
    unit: z.string().nullable(),
    unitPrice: MoneyString,
    approvedAmount: MoneyString.nullable(),
    warranty: LineWarranty.nullable(),
    // null = nobody has answered for this line yet. There is no default tick.
    fulfilledQty: FulfilledQtyString.nullable(),
    state: ReceiptLineState,
    // What the customer is charged for this line. null while unanswered;
    // "0.00" for a line approved but not done (shown, not charged - A-6).
    charged: MoneyString.nullable(),
    // Ice 20 Oct (P3.2 B4): a discount on this line ("0.00" when none), why, and the line after it.
    discount: MoneyString,
    discountReason: z.string().nullable(),
    net: MoneyString.nullable(),
    fulfilledAt: isoDateTime.nullable(),
    fulfilledByName: z.string().nullable(),
  })
  .strict();
export type ReceiptLine = z.infer<typeof ReceiptLine>;

export const ReceiptDiscountState = z.enum(['none', 'carried', 'needs_entry', 'entered']);
export type ReceiptDiscountState = z.infer<typeof ReceiptDiscountState>;

export const ReceiptDiscount = z
  .object({
    // none: nothing agreed or typed. carried: every line done, the agreed discount stands.
    // needs_entry: something was not done, staff must type the discount (0 is allowed).
    // entered: staff typed it.
    state: ReceiptDiscountState,
    // The DOCUMENT discount in force ("0.00" while needs_entry).
    amount: MoneyString,
    // Line discounts + the document discount: what the ceiling is measured on.
    total: MoneyString,
    // The discount agreed on the quotation at confirm, for reference.
    agreed: MoneyString,
    // The base it is measured against: the charged lines before ANY discount.
    base: MoneyString,
    // "12.50" - total / base, two places.
    percent: z.string(),
    exceedsCeiling: z.boolean(),
    ceilingPercent: z.number().int(),
    reason: z.string().nullable(),
    // A reason is needed to close (differs from agreed, or above the ceiling).
    reasonRequired: z.boolean(),
    approvedByName: z.string().nullable(),
  })
  .strict();
export type ReceiptDiscount = z.infer<typeof ReceiptDiscount>;

export const ReceiptTotals = z
  .object({
    // Charged lines before discount.
    subtotal: MoneyString,
    // Sum of the line discounts (B4).
    lineDiscountTotal: MoneyString,
    // The document-level discount.
    discount: MoneyString,
    // lineDiscountTotal + discount.
    totalDiscount: MoneyString,
    // ยอดบิล - the bill total, before any channel surcharge. There is no deposit in P3.2.
    billTotal: MoneyString,
    // Channel surcharges (B3): their own line on the receipt, not a discount, not in the 40% base.
    // "0.00" until payment is taken (a draft cannot know the channel yet).
    surchargeTotal: MoneyString,
    // billTotal + surchargeTotal.
    totalPaid: MoneyString,
    // The quotation's approved_total at the time the draft was built ("ยอดที่ตกลง").
    agreedTotal: MoneyString,
  })
  .strict();
export type ReceiptTotals = z.infer<typeof ReceiptTotals>;

export const ReceiptPayment = z
  .object({
    id: uuid,
    method: PaymentMethod,
    channelId: uuid.nullable(),
    channelName: z.string().nullable(),
    // Handed over by the customer through this channel = applied + surcharge.
    amount: MoneyString,
    // The channel's fee on top (B3).
    surcharge: MoneyString,
    // Given back (cash only).
    changeGiven: MoneyString,
    // amount - changeGiven: what stayed in the till or the account.
    net: MoneyString,
    receivedAt: isoDateTime,
    receivedByName: z.string().nullable(),
    // The money was handed back when the receipt was voided.
    reversed: z.boolean(),
  })
  .strict();
export type ReceiptPayment = z.infer<typeof ReceiptPayment>;

// What kept the bill from closing right now. Codes, so the screen can pick wording.
export const ReceiptBlocker = z.enum([
  'job_not_ready',
  'quotation_changed',
  'lines_unanswered',
  'discount_entry_required',
  'discount_exceeds_subtotal',
  'discount_reason_required',
  'discount_requires_manager',
  'nothing_to_bill',
  // Ice 20 Oct (P3.2 B2): deposits are agreed outside the system; a held deposit blocks closing here.
  'deposit_held',
  // Ice 20 Oct (P3.2 B1): the customer has not been shown this bill yet, or it changed since.
  'bill_not_presented',
  'presentation_stale',
]);
export type ReceiptBlocker = z.infer<typeof ReceiptBlocker>;

export const ReceiptNext = z
  .object({
    canTick: z.boolean(),
    canEditDiscount: z.boolean(),
    // Everything is in place EXCEPT possibly the money: payments are validated at close.
    canClose: z.boolean(),
    // Show the customer the bill (B1): everything except the presentation and the money is in place.
    canPresent: z.boolean(),
    canEditLineDiscount: z.boolean(),
    blockers: z.array(ReceiptBlocker),
    unansweredLineIds: z.array(uuid),
    // The caller's role may close a bill above the ceiling.
    canApproveOverCeiling: z.boolean(),
    canVoid: z.boolean(),
  })
  .strict();
export type ReceiptNext = z.infer<typeof ReceiptNext>;

export const ReceiptParty = z
  .object({
    customerName: z.string().nullable(),
    customerPhone: z.string().nullable(),
    plate: z.string().nullable(),
    province: z.string().nullable(),
    brand: z.string().nullable(),
    model: z.string().nullable(),
    mileageInKm: z.number().int().nullable(),
    jobNumber: z.string(),
  })
  .strict();
export type ReceiptParty = z.infer<typeof ReceiptParty>;

// Ice 20 Oct (P3.2 B1): the bill as the customer was shown it, before money is taken.
export const ReceiptPresentation = z
  .object({
    presentedAt: isoDateTime,
    presentedByName: z.string().nullable(),
    // The figures shown.
    subtotal: MoneyString,
    totalDiscount: MoneyString,
    billTotal: MoneyString,
    // false once ticks, line discounts or the document discount changed after presenting:
    // present again before taking payment.
    current: z.boolean(),
  })
  .strict();
export type ReceiptPresentation = z.infer<typeof ReceiptPresentation>;

export const Receipt = z
  .object({
    id: uuid,
    jobId: uuid,
    status: ReceiptStatus,
    // null while draft. e.g. RC690916002.
    number: z.string().nullable(),
    // The signed quotation this was built from, and its number.
    quotationId: uuid,
    quotationNumber: z.string().nullable(),
    // The live quotation is no longer the one this draft was built from, or is not
    // confirmed any more. A draft in this state cannot close: rebuild it.
    quotationChanged: z.boolean(),
    // Frozen at issue. For a draft, the live customer / vehicle / job (not yet frozen).
    party: ReceiptParty,
    lines: z.array(ReceiptLine),
    totals: ReceiptTotals,
    discount: ReceiptDiscount,
    payments: z.array(ReceiptPayment),
    // SUM(amount - change_given) over this receipt's payments.
    paidNet: MoneyString,
    changeTotal: MoneyString,
    issuedAt: isoDateTime.nullable(),
    issuedByName: z.string().nullable(),
    voidedAt: isoDateTime.nullable(),
    voidReason: z.string().nullable(),
    voidedByName: z.string().nullable(),
    presentation: ReceiptPresentation.nullable(),
    next: ReceiptNext,
  })
  .strict();
export type Receipt = z.infer<typeof Receipt>;

// -----------------------------------------------------------------------------
// Receipt (input)
// -----------------------------------------------------------------------------

export const CreateReceiptInput = z.object({}).strict();
export type CreateReceiptInput = z.infer<typeof CreateReceiptInput>;

export const RebuildReceiptInput = z.object({}).strict();
export type RebuildReceiptInput = z.infer<typeof RebuildReceiptInput>;

// Explicit value per line. "Done in full for every line" is a button that sends
// every line with its full qty - it is never a default (AC-B6, A-7).
export const FulfillmentInput = z
  .object({
    lines: z
      .array(z.object({ lineId: uuid, fulfilledQty: FulfilledQtyString }).strict())
      .min(1)
      .max(100),
  })
  .strict();
export type FulfillmentInput = z.infer<typeof FulfillmentInput>;

export const PatchReceiptInput = z
  .object({
    // The receipt discount. 0 is allowed (it answers "needs_entry").
    discount: MoneyString.optional(),
    // Why it differs from the agreed discount / why it is above the ceiling.
    discountReason: Reason.optional(),
  })
  .strict()
  .refine((v) => v.discount !== undefined || v.discountReason !== undefined, { message: 'empty_patch' });
export type PatchReceiptInput = z.infer<typeof PatchReceiptInput>;

// Per channel: the amount APPLIED to the bill through it. The server adds the
// channel's surcharge and works out the change; the client sends no total, no
// fee and no change (AC-E6).
export const PaymentEntryInput = z.object({ channelId: uuid, amount: MoneyString }).strict();
export type PaymentEntryInput = z.infer<typeof PaymentEntryInput>;

export const CloseReceiptInput = z
  .object({
    payments: z.array(PaymentEntryInput).min(1).max(6),
    // Required when the discount is above the ceiling (the closer - manager and up -
    // types it personally) or differs from the agreed one; overrides the draft's.
    discountReason: Reason.optional(),
  })
  .strict();
export type CloseReceiptInput = z.infer<typeof CloseReceiptInput>;

export const CloseReceiptResult = z
  .object({
    receipt: Receipt,
    // Change to hand back, cash only. Also on the cash payment row.
    change: MoneyString,
    // Channel surcharges collected on top of the bill.
    surchargeTotal: MoneyString,
    // Stock lines handed back to available stock because they were not done.
    // 0 until the stock module reserves anything (known gap G6).
    unreservedLines: z.number().int().min(0),
    // true when this call returned the receipt it created earlier (a retry).
    replayed: z.boolean(),
  })
  .strict();
export type CloseReceiptResult = z.infer<typeof CloseReceiptResult>;

export const VoidReceiptInput = z.object({ reason: Reason }).strict();
export type VoidReceiptInput = z.infer<typeof VoidReceiptInput>;

export const PresentBillInput = z.object({}).strict();
export type PresentBillInput = z.infer<typeof PresentBillInput>;

// Ice 20 Oct (P3.2 B4). 0 clears the line's discount; a reason is mandatory otherwise.
export const LineDiscountInput = z
  .object({ discount: MoneyString, discountReason: Reason.optional() })
  .strict();
export type LineDiscountInput = z.infer<typeof LineDiscountInput>;

// -----------------------------------------------------------------------------
// Payment channels (Ice 20 Oct, P3.2 B3)
// -----------------------------------------------------------------------------

export const PaymentChannel = z
  .object({
    id: uuid,
    name: z.string(),
    kind: PaymentMethod,
    // numeric(5,2): "3.00" = 3% on top of the amount paid through the channel.
    surchargePercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
    active: z.boolean(),
    sortOrder: z.number().int(),
  })
  .strict();
export type PaymentChannel = z.infer<typeof PaymentChannel>;

export const PaymentChannelList = z.object({ items: z.array(PaymentChannel) }).strict();
export type PaymentChannelList = z.infer<typeof PaymentChannelList>;

export const PaymentChannelQuery = z
  .object({ includeInactive: z.enum(['true', 'false']).default('false') })
  .strict();
export type PaymentChannelQuery = z.infer<typeof PaymentChannelQuery>;

const ChannelName = z.string().trim().min(1).max(60);
const SurchargePercent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'invalid_percent')
  .refine((v) => Number(v) <= 100, 'invalid_percent');

export const CreatePaymentChannelInput = z
  .object({ name: ChannelName, kind: PaymentMethod, surchargePercent: SurchargePercent.default('0') })
  .strict();
export type CreatePaymentChannelInput = z.infer<typeof CreatePaymentChannelInput>;

// There is no delete: payments reference the channel. Deactivate instead.
export const PatchPaymentChannelInput = z
  .object({ name: ChannelName.optional(), surchargePercent: SurchargePercent.optional(), active: z.boolean().optional() })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'empty_patch' });
export type PatchPaymentChannelInput = z.infer<typeof PatchPaymentChannelInput>;

// Every channel id of the shop, in the order they should appear.
export const ReorderPaymentChannelsInput = z
  .object({ ids: z.array(uuid).min(1).max(100) })
  .strict();
export type ReorderPaymentChannelsInput = z.infer<typeof ReorderPaymentChannelsInput>;

// -----------------------------------------------------------------------------
// Print history (DECISION-2026-10-15 s2)
// -----------------------------------------------------------------------------

// bill_statement = ใบแจ้งยอด: the presented bill printed from the DRAFT receipt. NOT a receipt (no number).
export const PrintDocType = z.enum(['quotation', 'work_order', 'receipt', 'bill_statement']);
export type PrintDocType = z.infer<typeof PrintDocType>;

export const PrintCopySet = z.enum(['customer_shop', 'customer_only', 'shop_only']);
export type PrintCopySet = z.infer<typeof PrintCopySet>;

// One print action = the customer's copy + the shop's copy (or fewer).
export const CreatePrintInput = z
  .object({
    docType: PrintDocType,
    copySet: PrintCopySet.default('customer_shop'),
    // The operator saw "printed N times, content changed since" and went on.
    acknowledgeChange: z.boolean().default(false),
  })
  .strict();
export type CreatePrintInput = z.infer<typeof CreatePrintInput>;

export const PrintRecord = z
  .object({
    id: uuid,
    seq: z.number().int().min(1),
    printedAt: isoDateTime,
    printedByName: z.string().nullable(),
    statusAtPrint: z.string(),
    revision: z.number().int().nullable(),
    copySet: PrintCopySet,
    acknowledgedChange: z.boolean(),
  })
  .strict();
export type PrintRecord = z.infer<typeof PrintRecord>;

// What the sheet needs to print "พิมพ์ครั้งที่ N" in the footer.
export const PrintResult = z
  .object({
    docType: PrintDocType,
    // The document id (quotation / receipt) or the job id (work order).
    subjectId: uuid,
    documentNumber: z.string().nullable(),
    // N - this print, counting itself. Equals the number of history rows.
    printNo: z.number().int().min(1),
    isReprint: z.boolean(),
    printedAt: isoDateTime,
    printedByName: z.string().nullable(),
    statusAtPrint: z.string(),
    copySet: PrintCopySet,
    // A quotation draft prints with a "ฉบับร่าง" mark; a void receipt with "ยกเลิก".
    mark: z.enum(['draft', 'void', 'statement']).nullable(),
    // The previous print of this subject, if any.
    previous: z.object({ seq: z.number().int(), printedAt: isoDateTime, printedByName: z.string().nullable() }).strict().nullable(),
    // The content differs from what the previous print showed. Only ever true on a
    // success when the caller sent acknowledgeChange: true.
    contentChangedSincePrevious: z.boolean(),
  })
  .strict();
export type PrintResult = z.infer<typeof PrintResult>;

export const PrintHistoryQuery = PageQuery.extend({ docType: PrintDocType });
export type PrintHistoryQuery = z.infer<typeof PrintHistoryQuery>;

export const PrintHistory = z
  .object({
    docType: PrintDocType,
    subjectId: uuid.nullable(),
    documentNumber: z.string().nullable(),
    printCount: z.number().int().min(0),
    // The printable content NOW differs from the latest print: warn before printing
    // ("ใบนี้เคยพิมพ์ไปแล้ว N ครั้ง เนื้อหาเปลี่ยนหลังจากนั้น - เก็บใบเก่าคืนจากลูกค้า").
    contentChangedSinceLastPrint: z.boolean(),
    items: z.array(PrintRecord),
    total: z.number().int().min(0),
  })
  .strict();
export type PrintHistory = z.infer<typeof PrintHistory>;

// -----------------------------------------------------------------------------
// Daily summary - two figures that are NEVER merged (CLAUDE.md s5.4 rule 9)
// -----------------------------------------------------------------------------

export const DailySummaryQuery = z.object({ date: dateKey.optional() }).strict();
export type DailySummaryQuery = z.infer<typeof DailySummaryQuery>;

export const MoneyInChannel = z
  .object({
    // null = payments recorded before channels existed.
    channelId: uuid.nullable(),
    name: z.string(),
    kind: PaymentMethod,
    received: MoneyString,
    changeGiven: MoneyString,
    // Of `received`: the channel's surcharge (B3).
    surcharge: MoneyString,
    reversed: MoneyString,
    net: MoneyString,
  })
  .strict();

export const MoneyInMethod = z
  .object({
    method: PaymentMethod,
    received: MoneyString, // handed over
    changeGiven: MoneyString,
    reversed: MoneyString, // handed back on voids dated this day
    net: MoneyString, // received - changeGiven - reversed
  })
  .strict();

export const DailySummary = z
  .object({
    date: dateKey,
    timezone: z.literal('Asia/Bangkok'),
    // เงินเข้า - by the day the money was RECEIVED. Net of change and of refunds
    // dated this day. Excludes deposit_offset (that money was counted when the
    // deposit was taken).
    moneyIn: z
      .object({
        label: z.string(),
        paymentCount: z.number().int(),
        reversalCount: z.number().int(),
        byMethod: z.array(MoneyInMethod),
        // The same money by the shop's own channel (ออมสิน, กสิกร, รูดบัตร...). Same total as byMethod.
        byChannel: z.array(MoneyInChannel),
        // Included in `total` and in each net: the channel surcharges received.
        surchargeTotal: MoneyString,
        total: MoneyString,
        changeCount: z.number().int(),
        changeTotal: MoneyString,
      })
      .strict(),
    // ยอดขาย - by the day the BILL WAS CLOSED. Receipts issued that day, not void.
    sales: z
      .object({
        label: z.string(),
        billCount: z.number().int(),
        customerCount: z.number().int(),
        subtotal: MoneyString,
        discountTotal: MoneyString,
        billTotal: MoneyString,
        // Channel surcharges on those bills ("ค่าธรรมเนียมรับชำระ"): a separate category, not repair revenue
        // and not in billTotal. DEFAULT pending Ice (B3 surcharge display).
        surchargeTotal: MoneyString,
        // Bills above the ceiling, with who approved - the owner reads these daily.
        overCeiling: z.array(
          z.object({
            receiptId: uuid,
            number: z.string(),
            percent: z.string(),
            discount: MoneyString,
            approvedByName: z.string().nullable(),
            reason: z.string().nullable(),
          }).strict(),
        ),
        // Bills smaller than the agreed quotation (a line was not done).
        belowAgreed: z.array(
          z.object({
            receiptId: uuid,
            number: z.string(),
            billTotal: MoneyString,
            agreedTotal: MoneyString,
          }).strict(),
        ),
      })
      .strict(),
    // Shown apart, never inside sales: receipts issued this day and voided since,
    // and receipts voided this day (their refunds are in moneyIn).
    voided: z
      .object({
        issuedToday: z.object({ count: z.number().int(), billTotal: MoneyString }).strict(),
        voidedToday: z.object({ count: z.number().int(), billTotal: MoneyString }).strict(),
      })
      .strict(),
    // Warranty-claim jobs delivered this day: no receipt, no revenue.
    warrantyClaimsDelivered: z.number().int(),
    // Ice 20 Oct (P3.2 B7): no till count. The cash received total is information only.
    // Cash handed over minus change minus cash refunds dated this day, over all cash channels.
    cashReceivedNet: MoneyString,
  })
  .strict();
export type DailySummary = z.infer<typeof DailySummary>;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

function refusal<const C extends string>(code: C) {
  return z.object({ error: z.literal(code), message: z.string() }).strict();
}

export const ReceiptNotFoundError = refusal('receipt_not_found');
export const ReceiptExistsError = refusal('receipt_exists'); // 409 - issued receipt already there
export const ReceiptNotDraftError = refusal('receipt_not_draft');
export const ReceiptNotIssuedError = refusal('receipt_not_issued');
export const ClaimNoReceiptError = refusal('claim_no_receipt');
export const JobNotBillableError = z
  .object({ error: z.literal('job_not_billable'), message: z.string(), status: z.string() })
  .strict();
export const QuotationNotConfirmedForReceiptError = refusal('quotation_not_confirmed');
export const QuotationMissingForReceiptError = refusal('quotation_missing');
export const RevisionPendingError = refusal('revision_pending');
export const QuotationInconsistentError = refusal('quotation_inconsistent');
export const QuotationChangedError = refusal('quotation_changed');
export const ReceiptLineNotFoundError = refusal('receipt_line_not_found');
export const FulfillmentIncompleteError = z
  .object({ error: z.literal('fulfillment_incomplete'), message: z.string(), lineIds: z.array(uuid) })
  .strict();
export const DiscountEntryRequiredError = refusal('discount_entry_required');
export const DiscountExceedsSubtotalError = z
  .object({ error: z.literal('discount_exceeds_subtotal'), message: z.string(), max: MoneyString, fields: z.record(z.array(z.string())) })
  .strict();
export const DiscountRequiresManagerError = z
  .object({
    error: z.literal('discount_requires_manager'),
    message: z.string(),
    percent: z.string(),
    ceilingPercent: z.number().int(),
  })
  .strict();
export const DiscountReasonRequiredError = z
  .object({ error: z.literal('discount_reason_required'), message: z.string(), fields: z.record(z.array(z.string())) })
  .strict();
export const NothingToBillError = refusal('nothing_to_bill');
export const PaymentShortError = z
  .object({ error: z.literal('payment_short'), message: z.string(), short: MoneyString, due: MoneyString })
  .strict();
export const PaymentOverNoncashError = z
  .object({ error: z.literal('payment_over_noncash'), message: z.string(), over: MoneyString })
  .strict();
export const PaymentCashUnneededError = refusal('payment_cash_unneeded');
export const AlreadyBilledError = z
  .object({ error: z.literal('already_billed'), message: z.string(), receiptId: uuid, number: z.string() })
  .strict();
export const DepositHeldError = refusal('deposit_held'); // Ice 20 Oct (P3.2 B2): deposits are agreed outside the system
export const ReceiptRequiredError = refusal('receipt_required'); // B1: deliver needs a closed receipt
export const ReceiptIssuedError = refusal('receipt_issued'); // delivered -> ready while a receipt stands
export const PrintContentChangedError = z
  .object({
    error: z.literal('print_content_changed'),
    message: z.string(),
    printCount: z.number().int(),
    lastPrintedAt: isoDateTime,
  })
  .strict();
export const PrintNotAllowedError = refusal('print_not_allowed');
export const BillNotPresentedError = refusal('bill_not_presented');
export const PresentationStaleError = refusal('presentation_stale');
export const ChannelNotFoundError = refusal('channel_not_found');
export const ChannelInactiveError = refusal('channel_inactive');
export const ChannelNameTakenError = refusal('channel_name_taken');
export const LastCashChannelError = refusal('last_active_channel');
export const AppendOnlyError = refusal('record_append_only');
export type AppendOnlyError = z.infer<typeof AppendOnlyError>;

export const BillingBody = z.union([
  ReceiptNotFoundError, ReceiptExistsError, ReceiptNotDraftError, ReceiptNotIssuedError, ClaimNoReceiptError,
  JobNotBillableError, QuotationNotConfirmedForReceiptError, QuotationMissingForReceiptError,
  RevisionPendingError, QuotationInconsistentError, QuotationChangedError, ReceiptLineNotFoundError,
  FulfillmentIncompleteError, DiscountEntryRequiredError, DiscountExceedsSubtotalError,
  DiscountRequiresManagerError, DiscountReasonRequiredError, NothingToBillError, PaymentShortError,
  PaymentOverNoncashError, PaymentCashUnneededError, AlreadyBilledError, DepositHeldError,
  ReceiptRequiredError, ReceiptIssuedError, PrintContentChangedError, PrintNotAllowedError,
  BillNotPresentedError, PresentationStaleError, ChannelNotFoundError, ChannelInactiveError,
  ChannelNameTakenError, LastCashChannelError, AppendOnlyError,
  z.object({ error: z.literal('job_not_found'), message: z.string() }).strict(),
  z.object({ error: z.literal('invalid_request'), message: z.string(), fields: z.record(z.array(z.string())) }).strict(),
  z.object({ error: z.literal('document_series_missing'), message: z.string() }).strict(),
]);
export type BillingBody = z.infer<typeof BillingBody>;
