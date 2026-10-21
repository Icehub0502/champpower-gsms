// Deposits (P3.3, CLAUDE.md s5.4): money the shop holds for a CUSTOMER before (or while) a job
// exists. Real money on the day received; never part of the bill; never deleted.
//
//   POST /api/deposits                          CreateDepositInput   -> CreateDepositResult (201 new, 200 replay)
//   GET  /api/deposits                          DepositListQuery     -> DepositList  ("มัดจำค้างอยู่"; ?status=held default)
//   GET  /api/deposits/:id                                           -> Deposit
//   POST /api/files/deposit-slip                multipart (file)     -> DepositSlipFile (the transfer slip IMAGE; read back with GET /api/files/:id)
//   POST /api/deposits/:id/attach               AttachDepositInput   -> Deposit  (bind a held deposit to a job)
//   POST /api/deposits/:id/detach               DetachDepositInput   -> Deposit  (undo a wrong attach)
//   POST /api/deposits/:id/refund               RefundDepositInput   -> Deposit  (advisor and above)
//   POST /api/deposits/:id/forfeit              ForfeitDepositInput  -> Deposit  (manager and above)
//   POST /api/deposits/:id/slip                 CreateDepositSlipInput -> DepositSlipPrint (numbers DEP-xxxx on first print)
//   GET  /api/deposits/:id/slip                 DepositSlipHistoryQuery -> DepositSlipHistory
//   GET  /api/jobs/:jobId/deposits                                   -> JobDeposits (the warning + what is attached)
//
// Offsetting into a bill is part of POST /api/jobs/:jobId/receipt/close (billing.ts: depositIds).
// Money is a numeric(12,2) string; the server computes every figure. The shop and the role
// come from the JWT only - there is no shopId anywhere in this file. Everything is .strict().

import { z } from 'zod';
import { DEPOSIT_CHANNELS, DEPOSIT_REASONS, DEPOSIT_STATUSES } from '@champpower/domain';
import { MoneyString } from './catalog.js';
import { PageQuery, thaiPhone, uuid } from './common.js';

const isoDateTime = z.string().datetime();
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date');
const Reason = z.string().trim().min(1).max(500);

export const DepositChannel = z.enum(DEPOSIT_CHANNELS);
export type DepositChannel = z.infer<typeof DepositChannel>;
export const DepositReason = z.enum(DEPOSIT_REASONS);
export type DepositReason = z.infer<typeof DepositReason>;
export const DepositStatus = z.enum(DEPOSIT_STATUSES);
export type DepositStatus = z.infer<typeof DepositStatus>;
// The kind of the payment channel the money came through (same words as billing.ts PaymentMethod;
// declared here so billing.ts and checkin.ts can import this file without a cycle).
export const DepositMethod = z.enum(['cash', 'transfer', 'card']);
export type DepositMethod = z.infer<typeof DepositMethod>;

// -----------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------

export const DepositSlipRef = z
  .object({
    documentId: uuid,
    // DEP-2610-0001: allocated when the slip was first printed, not when the deposit was received.
    number: z.string(),
    printCount: z.number().int().min(0),
  })
  .strict();
export type DepositSlipRef = z.infer<typeof DepositSlipRef>;

export const Deposit = z
  .object({
    id: uuid,
    customerId: uuid,
    customerName: z.string().nullable(),
    customerPhone: z.string().nullable(),
    // Nullable: a deposit exists before any car or job (page / LINE / phone transfer).
    jobId: uuid.nullable(),
    jobNumber: z.string().nullable(),
    vehicleId: uuid.nullable(),
    plate: z.string().nullable(),
    amount: MoneyString,
    reason: DepositReason,
    channel: DepositChannel,
    // The shop's own payment channel the money came in through (ออมสิน, เงินสด...). null = recorded before channels.
    paymentChannelId: uuid.nullable(),
    paymentChannelName: z.string().nullable(),
    method: DepositMethod,
    // The slip IMAGE of a transfer (GET /api/files/:id, shop-checked). null = none attached.
    slipFileId: uuid.nullable(),
    // The numbered ใบรับเงินมัดจำ. null until it is first printed.
    slip: DepositSlipRef.nullable(),
    // YYYY-MM-DD, Bangkok. The day the customer said the car would come.
    expectedDate: dateKey,
    // Past expectedDate while still held - flagged the moment the day is over, no waiting period.
    overdue: z.boolean(),
    daysOverdue: z.number().int().min(0),
    status: DepositStatus,
    receivedAt: isoDateTime,
    receivedByName: z.string().nullable(),
    // applied: the receipt it was offset into.
    appliedToReceiptId: uuid.nullable(),
    appliedToReceiptNumber: z.string().nullable(),
    // refunded | forfeited: when, by whom, why (mandatory).
    closedAt: isoDateTime.nullable(),
    closedByName: z.string().nullable(),
    closeReason: z.string().nullable(),
    // Internal note typed when the deposit was received. null = none. Never printed on the DEP slip.
    note: z.string().nullable(),
    // refunded: the channel the money went back through.
    refundChannelName: z.string().nullable(),
    // What the CALLER may do now (the server decides; the screen displays).
    next: z
      .object({
        canAttach: z.boolean(),
        canDetach: z.boolean(),
        canRefund: z.boolean(),
        canForfeit: z.boolean(),
        canPrintSlip: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type Deposit = z.infer<typeof Deposit>;

// The warning shown when a job is opened, and on the job / receipt views (s5.4 item 3):
// "ลูกค้ารายนี้มีมัดจำค้าง ฿X (โอนมาเมื่อ ...)" with a button that binds it to the job.
export const DepositWarning = z
  .object({
    depositId: uuid,
    amount: MoneyString,
    receivedAt: isoDateTime,
    channel: DepositChannel,
    paymentChannelName: z.string().nullable(),
    expectedDate: dateKey,
    overdue: z.boolean(),
    reason: DepositReason,
    // Why this deposit was matched to the person at the counter.
    // customer = the same customer row; booking = the deposit was taken to hold this booking's slot;
    // phone = a customer row with the same (non-placeholder) phone number.
    matchedBy: z.enum(['customer', 'booking', 'phone']),
    // Already bound to THIS job (so the button is not needed, only the offset at the till).
    attachedToThisJob: z.boolean(),
    slipNumber: z.string().nullable(),
  })
  .strict();
export type DepositWarning = z.infer<typeof DepositWarning>;

export const JobDeposits = z
  .object({
    jobId: uuid,
    // Held deposits of this customer / this phone that could be attached or are attached to this job.
    warnings: z.array(DepositWarning),
    // Bound to this job and applied to its receipt (history).
    applied: z.array(Deposit),
    heldTotal: MoneyString,
  })
  .strict();
export type JobDeposits = z.infer<typeof JobDeposits>;

export const DepositSummary = z
  .object({
    heldCount: z.number().int().min(0),
    // Σ amount over ALL held deposits of the shop - what the shop is holding for customers.
    heldTotal: MoneyString,
    overdueCount: z.number().int().min(0),
    overdueTotal: MoneyString,
    // Today in Bangkok: the day "overdue" is judged against.
    asOf: dateKey,
  })
  .strict();
export type DepositSummary = z.infer<typeof DepositSummary>;

export const DepositList = z
  .object({ items: z.array(Deposit), total: z.number().int().min(0), summary: DepositSummary })
  .strict();
export type DepositList = z.infer<typeof DepositList>;

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

const CustomerName = z.string().trim().min(1).max(120);

// Who the deposit is for. Exactly ONE of: an existing customer (customerId), a minimal new
// customer from name + phone (the online deposit: no car, no job), or the job's own customer
// (jobId alone). Anything else is a 400 with a field error.
export const CreateDepositInput = z
  .object({
    // Generated by the client per attempt; a retry with the same key returns the same deposit.
    idempotencyKey: uuid,
    customerId: uuid.optional(),
    customerName: CustomerName.optional(),
    customerPhone: thaiPhone.optional(),
    jobId: uuid.optional(),
    vehicleId: uuid.optional(),
    bookingId: uuid.optional(),
    channel: DepositChannel,
    reason: DepositReason,
    amount: MoneyString,
    // One of the shop's payment channels (GET /api/payment-channels). The deposit's method is its kind.
    paymentChannelId: uuid,
    // Mandatory (s5.4 item 8): the day the customer said they would come. YYYY-MM-DD.
    expectedDate: dateKey,
    // The transfer slip image (POST /api/files/deposit-slip). Optional for cash.
    slipFileId: uuid.optional(),
    // Optional internal note (หมายเหตุ), max 500 - the CHECK ck_deposits_note_len is only the net behind this.
    // An empty / blank string means "no note" and is dropped, so the form can send its textarea as is.
    note: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(500).optional()),
  })
  .strict()
  .superRefine((v, ctx) => {
    const named = v.customerName !== undefined || v.customerPhone !== undefined;
    const forms = [v.customerId !== undefined, named, v.jobId !== undefined && v.customerId === undefined && !named].filter(Boolean).length;
    if (forms !== 1) {
      ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'customer_required' });
      return;
    }
    if (named && (v.customerName === undefined || v.customerPhone === undefined)) {
      ctx.addIssue({ code: 'custom', path: [v.customerName === undefined ? 'customerName' : 'customerPhone'], message: 'required' });
    }
  });
export type CreateDepositInput = z.infer<typeof CreateDepositInput>;

export const CreateDepositResult = z
  .object({
    deposit: Deposit,
    // A minimal customer (name + phone) was created for this deposit.
    customerCreated: z.boolean(),
    // The same idempotencyKey was already used: this is the deposit it created.
    replayed: z.boolean(),
  })
  .strict();
export type CreateDepositResult = z.infer<typeof CreateDepositResult>;

export const DepositSlipFile = z
  .object({ id: uuid, mime: z.string(), bytes: z.number().int().min(0) })
  .strict();
export type DepositSlipFile = z.infer<typeof DepositSlipFile>;

export const DepositListQuery = PageQuery.extend({
  status: DepositStatus.default('held'),
  // Only the deposits past their expected day.
  overdue: z.enum(['true', 'false']).default('false'),
  customerId: uuid.optional(),
});
export type DepositListQuery = z.infer<typeof DepositListQuery>;

export const AttachDepositInput = z.object({ jobId: uuid }).strict();
export type AttachDepositInput = z.infer<typeof AttachDepositInput>;

export const DetachDepositInput = z.object({ reason: Reason }).strict();
export type DetachDepositInput = z.infer<typeof DetachDepositInput>;

// Both buttons demand a reason and record who and when (s5.4 item 8). Neither is ever automatic.
export const RefundDepositInput = z
  .object({
    reason: Reason,
    // The channel the money goes back through; omitted = the channel it came in through.
    refundChannelId: uuid.optional(),
  })
  .strict();
export type RefundDepositInput = z.infer<typeof RefundDepositInput>;

// Manager and above. The money becomes shop income on the day it is forfeited - NOT repair sales,
// and with no VAT. That no-VAT treatment is the owner's decision, not a tax conclusion.
export const ForfeitDepositInput = z.object({ reason: Reason }).strict();
export type ForfeitDepositInput = z.infer<typeof ForfeitDepositInput>;

// -----------------------------------------------------------------------------
// The slip (ใบรับเงินมัดจำ) and its print history
// -----------------------------------------------------------------------------

export const DepositSlipCopySet = z.enum(['customer_shop', 'customer_only', 'shop_only']);

export const CreateDepositSlipInput = z
  .object({
    copySet: DepositSlipCopySet.default('customer_shop'),
    // The operator saw "printed N times, content changed" (e.g. the deposit was refunded since) and went on.
    acknowledgeChange: z.boolean().default(false),
  })
  .strict();
export type CreateDepositSlipInput = z.infer<typeof CreateDepositSlipInput>;

// What the sheet prints. Frozen on the slip document the first time it is numbered; the print never joins live.
export const DepositSlipContent = z
  .object({
    // Always 'ใบรับเงินมัดจำ' - never a receipt, never a tax invoice.
    title: z.literal('ใบรับเงินมัดจำ'),
    number: z.string(),
    issuedOn: dateKey,
    customerName: z.string().nullable(),
    customerPhone: z.string().nullable(),
    amount: MoneyString,
    reason: DepositReason,
    channel: DepositChannel,
    paymentChannelName: z.string().nullable(),
    method: DepositMethod,
    receivedAt: isoDateTime,
    receivedByName: z.string().nullable(),
    expectedDate: dateKey,
    // The quotation it is for, if one was linked when the slip was numbered.
    quotationNumber: z.string().nullable(),
    jobNumber: z.string().nullable(),
    plate: z.string().nullable(),
  })
  .strict();
export type DepositSlipContent = z.infer<typeof DepositSlipContent>;

export const DepositSlipPrint = z
  .object({
    content: DepositSlipContent,
    // N on the paper ("พิมพ์ครั้งที่ N"): counts itself, equals the number of history rows.
    printNo: z.number().int().min(1),
    isReprint: z.boolean(),
    printedAt: isoDateTime,
    printedByName: z.string().nullable(),
    copySet: DepositSlipCopySet,
    // The deposit has left 'held' since the slip was numbered: print "คืนแล้ว" / "ริบแล้ว" / "หักเข้าบิลแล้ว" beside it.
    statusAtPrint: DepositStatus,
    previous: z.object({ seq: z.number().int(), printedAt: isoDateTime, printedByName: z.string().nullable() }).strict().nullable(),
    contentChangedSincePrevious: z.boolean(),
  })
  .strict();
export type DepositSlipPrint = z.infer<typeof DepositSlipPrint>;

export const DepositSlipHistoryQuery = PageQuery;
export type DepositSlipHistoryQuery = z.infer<typeof DepositSlipHistoryQuery>;

export const DepositSlipHistory = z
  .object({
    number: z.string().nullable(),
    printCount: z.number().int().min(0),
    contentChangedSinceLastPrint: z.boolean(),
    items: z.array(
      z
        .object({
          seq: z.number().int(),
          printedAt: isoDateTime,
          printedByName: z.string().nullable(),
          statusAtPrint: z.string(),
          copySet: DepositSlipCopySet,
          acknowledgedChange: z.boolean(),
        })
        .strict(),
    ),
    total: z.number().int().min(0),
  })
  .strict();
export type DepositSlipHistory = z.infer<typeof DepositSlipHistory>;

// -----------------------------------------------------------------------------
// Errors (all { error, message }; field errors use InvalidRequestError from common.ts)
// -----------------------------------------------------------------------------

function refusal<const C extends string>(code: C) {
  return z.object({ error: z.literal(code), message: z.string() }).strict();
}

export const DepositNotFoundError = refusal('deposit_not_found'); // 404 (also another shop's deposit)
export const DepositNotHeldError = z // 409: already applied / refunded / forfeited
  .object({ error: z.literal('deposit_not_held'), message: z.string(), status: DepositStatus })
  .strict();
export const DepositCustomerMismatchError = refusal('deposit_customer_mismatch'); // 422
export const DepositJobMismatchError = refusal('deposit_job_mismatch'); // 409: already attached to another job
export const DepositNotAttachedError = refusal('deposit_not_attached'); // 422: offset a deposit not bound to this job
export const DepositExceedsBillError = z // 422
  .object({ error: z.literal('deposit_exceeds_bill'), message: z.string(), over: MoneyString, max: MoneyString })
  .strict();
export const DepositForfeitForbiddenError = refusal('forfeit_requires_manager'); // 403
export const DepositSlipUnavailableError = refusal('deposit_slip_unavailable'); // 409: closed deposit never numbered
export const DepositJobNotFoundError = refusal('job_not_found'); // 404
export const DepositCustomerNotFoundError = refusal('customer_not_found'); // 404
export const DepositJobBilledError = refusal('job_already_billed'); // 409: attach to a job whose receipt is issued
// 409: the database refused to change a deposit (a backstop - the checks above answer first).
export const DepositLockedError = refusal('deposit_locked');
export type DepositLockedError = z.infer<typeof DepositLockedError>;

export const DepositBody = z.union([
  DepositNotFoundError, DepositNotHeldError, DepositCustomerMismatchError, DepositJobMismatchError,
  DepositNotAttachedError, DepositExceedsBillError, DepositForfeitForbiddenError, DepositSlipUnavailableError,
  DepositJobNotFoundError, DepositCustomerNotFoundError, DepositJobBilledError, DepositLockedError,
  z.object({ error: z.literal('invalid_request'), message: z.string(), fields: z.record(z.array(z.string())) }).strict(),
  z.object({ error: z.literal('document_series_missing'), message: z.string() }).strict(),
  z
    .object({
      error: z.literal('print_content_changed'),
      message: z.string(),
      printCount: z.number().int(),
      lastPrintedAt: isoDateTime,
    })
    .strict(),
]);
export type DepositBody = z.infer<typeof DepositBody>;
