// Quotation + per-line approval (P3.1).
//
//   POST  /api/jobs/:jobId/quotation                       CreateQuotationInput -> Quotation   (201)
//   GET   /api/jobs/:jobId/quotation                       Quotation
//   PATCH /api/jobs/:jobId/quotation                       PatchQuotationInput  -> Quotation   (draft)
//   POST  /api/jobs/:jobId/quotation/lines                 AddLineInput         -> Quotation   (draft)
//   PATCH /api/jobs/:jobId/quotation/lines/:lineId         PatchLineInput       -> Quotation   (draft)
//   DELETE /api/jobs/:jobId/quotation/lines/:lineId        -> Quotation (draft; deleting a set parent deletes its children)
//   POST  /api/jobs/:jobId/quotation/issue                 IssueInput           -> Quotation   (allocates the IV number)
//   PATCH /api/jobs/:jobId/quotation/lines/:lineId/decision DecideLineInput     -> Quotation   (issued)
//   POST  /api/jobs/:jobId/quotation/confirm               ConfirmInput         -> ConfirmResult (issued -> signed)
//   POST  /api/jobs/:jobId/quotation/confirm/undo          UndoConfirmInput     -> Quotation   (signed -> issued)
//   POST  /api/jobs/:jobId/quotation/revise                ReviseInput          -> Quotation   (new revision, old superseded)
//   POST  /api/jobs/:jobId/quotation/void                  VoidInput            -> Quotation   (owner only)
//   GET   /api/vehicles/:vehicleId/offered-items           OfferedItemPage
//   GET   /api/jobs/:jobId/work-order                      WorkOrder             (technician-visible, NO prices)
//
// The server computes every total (packages/domain quoteTotals) and says what
// the screen may do next (`next`); the screen displays, it does not decide.
// `signed` means "customer outcome confirmed" — see migration 0022.
//
// Everything is .strict(). The Quotation shape carries SELLING prices only;
// the WorkOrder shape carries no price field at all, so a technician cannot be
// sent one without changing this file (CLAUDE.md §12.1).

import { z } from 'zod';
import {
  ChangeReason,
  DeclineReason,
  LineType,
  MoneyString,
  PriceSource,
  QtyString,
} from './catalog.js';
import { PageQuery, uuid } from './common.js';

const isoDateTime = z.string().datetime();

export const QuotationStatus = z.enum(['draft', 'issued', 'signed', 'superseded', 'void']);
export type QuotationStatus = z.infer<typeof QuotationStatus>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'declined']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

const NoteText = z.string().trim().min(1).max(500);

// -----------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------

// Snapshot as sold (migration 0010's days / max_km units, not months).
export const LineWarranty = z
  .object({
    termId: uuid.nullable(),
    name: z.string(),
    days: z.number().int().min(1).nullable(),
    maxKm: z.number().int().min(1).nullable(),
  })
  .strict();
export type LineWarranty = z.infer<typeof LineWarranty>;

export const QuotationLine = z
  .object({
    id: uuid,
    // Set child -> the id of its top-level parent; null for ordinary lines and set headers.
    parentLineId: uuid.nullable(),
    sortOrder: z.number().int(),
    lineType: LineType,
    catalogItemId: uuid.nullable(),
    name: z.string(),
    brand: z.string().nullable(),
    qty: QtyString,
    unit: z.string().nullable(),
    // What the customer is charged per unit, and what the catalog said at the time.
    unitPrice: MoneyString,
    listPrice: MoneyString.nullable(),
    priceSource: PriceSource.nullable(),
    isVatable: z.boolean(),
    lineTotal: MoneyString,
    approvalStatus: ApprovalStatus,
    declineReason: DeclineReason.nullable(),
    declineNote: z.string().nullable(),
    decidedAt: isoDateTime.nullable(),
    decidedByName: z.string().nullable(),
    // The agreed amount for a set with pieces cut. "ราคาเสนอ lineTotal -> ตกลง approvedAmount".
    approvedAmount: MoneyString.nullable(),
    warranty: LineWarranty.nullable(),
    // Revision only: the line of the superseded quotation whose decision this line still carries
    // (item, qty, unit price and warranty unchanged — owner Q2). null = ask the customer again
    // (new or changed line) or not a revision. The screen shows "ตกลงไว้แล้ว" vs "ต้องถามใหม่".
    decisionCarriedFrom: uuid.nullable(),
  })
  .strict();
export type QuotationLine = z.infer<typeof QuotationLine>;

export const QuotationTotals = z
  .object({
    offeredSubtotal: MoneyString,
    approvedSubtotal: MoneyString,
    // The discount as entered, and the part of it that really applies to each base (clamped).
    discount: MoneyString,
    offeredDiscount: MoneyString,
    approvedDiscount: MoneyString,
    offeredTotal: MoneyString,
    approvedTotal: MoneyString,
  })
  .strict();
export type QuotationTotals = z.infer<typeof QuotationTotals>;

// What the screen is allowed to offer right now, decided on the server.
export const QuotationNext = z
  .object({
    canEditContent: z.boolean(), // draft
    canIssue: z.boolean(),
    canDecide: z.boolean(), // issued
    canConfirm: z.boolean(),
    canUndoConfirm: z.boolean(),
    canRevise: z.boolean(),
    // Top-level lines still pending (blocks confirm).
    undecidedLineIds: z.array(uuid),
    // Cut sets that need an agreed amount before confirm.
    setsNeedingAmountLineIds: z.array(uuid),
  })
  .strict();
export type QuotationNext = z.infer<typeof QuotationNext>;

export const Quotation = z
  .object({
    id: uuid,
    jobId: uuid,
    revision: z.number().int().min(1),
    status: QuotationStatus,
    // null while draft.
    number: z.string().nullable(),
    supersedesDocumentId: uuid.nullable(),
    issuedAt: isoDateTime.nullable(),
    // documents.signed_at = the moment the customer outcome was confirmed.
    confirmedAt: isoDateTime.nullable(),
    // Void by the system because the job ended (void_reason = 'job_closed'), not by a person.
    closedByJob: z.boolean(),
    voidReason: z.string().nullable(),
    totals: QuotationTotals,
    lines: z.array(QuotationLine),
    next: QuotationNext,
  })
  .strict();
export type Quotation = z.infer<typeof Quotation>;

// -----------------------------------------------------------------------------
// Draft editing
// -----------------------------------------------------------------------------

export const CreateQuotationInput = z.object({}).strict();
export type CreateQuotationInput = z.infer<typeof CreateQuotationInput>;

export const PatchQuotationInput = z.object({ discount: MoneyString }).strict();
export type PatchQuotationInput = z.infer<typeof PatchQuotationInput>;

// Add a line three ways (+ re-add from "เคยเสนอไว้"). The server expands a set
// into its child lines and takes the warranty snapshot — the screen sends no
// children and no warranty text.
export const AddLineInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('item'),
      itemId: uuid,
      qty: QtyString.optional(),
      // Override of the looked-up price; never written back to the catalog.
      unitPrice: MoneyString.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set'),
      itemId: uuid,
      qty: QtyString.optional(),
      unitPrice: MoneyString.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('free'),
      name: z.string().trim().min(1).max(200),
      lineType: LineType.default('part'),
      qty: QtyString.default('1'),
      unit: z.string().trim().min(1).max(30).optional(),
      brand: z.string().trim().min(1).max(80).optional(),
      unitPrice: MoneyString.default('0'),
      isVatable: z.boolean().optional(),
      warrantyTermId: uuid.optional(),
      // D12: pre-ticked. When true, `category` is required.
      addToCatalog: z.boolean().default(true),
      category: z.string().trim().min(1).max(80).optional(),
      // After the "similar to X" warning: use the existing item, or add anyway.
      useExistingItemId: uuid.optional(),
      confirmNotSimilar: z.boolean().default(false),
    })
    .strict(),
  z.object({ kind: z.literal('offered'), offeredItemId: uuid, qty: QtyString.optional() }).strict(),
]).superRefine((v, ctx) => {
  // D12: a free line that goes into the catalog needs a category — unless the
  // person chose an existing item from the similar-name warning.
  if (v.kind === 'free' && v.addToCatalog && v.useExistingItemId === undefined && v.category === undefined) {
    ctx.addIssue({ code: 'custom', path: ['category'], message: 'required' });
  }
});
export type AddLineInput = z.infer<typeof AddLineInput>;

export const PatchLineInput = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    brand: z.string().trim().min(1).max(80).nullable().optional(),
    lineType: LineType.optional(),
    qty: QtyString.optional(),
    unit: z.string().trim().min(1).max(30).nullable().optional(),
    unitPrice: MoneyString.optional(),
    isVatable: z.boolean().optional(),
    // Pick another warranty term (or null for none); the server re-snapshots it.
    warrantyTermId: uuid.nullable().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'empty_patch' });
export type PatchLineInput = z.infer<typeof PatchLineInput>;

export const IssueInput = z.object({}).strict();
export type IssueInput = z.infer<typeof IssueInput>;

// -----------------------------------------------------------------------------
// Decisions and confirm
// -----------------------------------------------------------------------------

export const DecideLineInput = z
  .object({
    decision: z.enum(['approved', 'declined']),
    reason: DeclineReason.optional(),
    note: NoteText.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.decision === 'approved') {
      if (v.reason !== undefined) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'not_allowed' });
      if (v.note !== undefined) ctx.addIssue({ code: 'custom', path: ['note'], message: 'not_allowed' });
      return;
    }
    if (v.reason === undefined) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'required' });
    if (v.reason === 'other' && v.note === undefined) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'required' });
    }
  });
export type DecideLineInput = z.infer<typeof DecideLineInput>;

// The ONE point where the agreed amount of a cut set and the discount change
// (D10 / D11). Reasons are mandatory; the audit entry records offered -> agreed.
export const ConfirmInput = z
  .object({
    adjustments: z
      .object({
        setLines: z
          .array(z.object({ lineId: uuid, approvedAmount: MoneyString, reason: ChangeReason }).strict())
          .max(50)
          .optional(),
        discount: z.object({ amount: MoneyString, reason: ChangeReason }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConfirmInput = z.infer<typeof ConfirmInput>;

// Confirm returns the quotation plus, when the job was still before "quoted"
// (received/inspecting), jobStatusUnchanged so the screen can say the job was not
// moved to approved. null otherwise (including when the job is already past quoted).
export const ConfirmResult = Quotation.extend({
  jobStatusUnchanged: z.object({ currentStatus: z.string() }).strict().nullable(),
}).strict();
export type ConfirmResult = z.infer<typeof ConfirmResult>;

export const UndoConfirmInput = z.object({ reason: ChangeReason }).strict();
export type UndoConfirmInput = z.infer<typeof UndoConfirmInput>;

export const ReviseInput = z.object({ reason: ChangeReason.optional() }).strict();
export type ReviseInput = z.infer<typeof ReviseInput>;

// Owner only. Distinct from the system close when a job ends.
export const VoidInput = z.object({ reason: ChangeReason }).strict();
export type VoidInput = z.infer<typeof VoidInput>;

// -----------------------------------------------------------------------------
// Offered items ("เคยเสนอไว้")
// -----------------------------------------------------------------------------

export const OfferedItem = z
  .object({
    id: uuid,
    name: z.string(),
    offeredAt: isoDateTime,
    lineType: LineType,
    catalogItemId: uuid.nullable(),
    // The price offered at the time — a selling price.
    unitPrice: MoneyString,
    qty: QtyString,
  })
  .strict();
export type OfferedItem = z.infer<typeof OfferedItem>;

export const OfferedItemQuery = PageQuery;
export const OfferedItemPage = z.object({ items: z.array(OfferedItem), total: z.number().int().min(0) }).strict();
export type OfferedItemPage = z.infer<typeof OfferedItemPage>;

// -----------------------------------------------------------------------------
// Work order — what the technician does. No prices, no document number, no
// declined line. Technician-visible.
// -----------------------------------------------------------------------------

export const WorkOrderLine = z
  .object({
    id: uuid,
    parentLineId: uuid.nullable(),
    sortOrder: z.number().int(),
    lineType: LineType,
    name: z.string(),
    brand: z.string().nullable(),
    qty: QtyString,
    unit: z.string().nullable(),
    // Warranty wording so the technician knows what the part is sold with.
    warrantyName: z.string().nullable(),
  })
  .strict();
export type WorkOrderLine = z.infer<typeof WorkOrderLine>;

export const WorkOrder = z
  .object({
    jobId: uuid,
    jobNumber: z.string(),
    plate: z.string().nullable(),
    province: z.string().nullable(),
    brand: z.string().nullable(),
    model: z.string().nullable(),
    // Empty until a quotation has been confirmed with at least one approved line.
    lines: z.array(WorkOrderLine),
  })
  .strict();
export type WorkOrder = z.infer<typeof WorkOrder>;
