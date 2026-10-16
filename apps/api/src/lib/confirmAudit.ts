/**
 * The shape of the `quotation_confirmed` audit row, defined ONCE for the writer
 * (services/quotation.ts confirm) and the reader (repositories/quotation.ts
 * latestConfirmAfter, which undo relies on to put a confirm's figures back).
 *
 * Strict on purpose: undo restores money from this row, so a row that does not
 * match is a bug or tampering, and parsing it throws instead of guessing.
 * Fields added over time are optional so older rows still parse; `before.setLines`
 * absent with `after.setLines` present is the LEGACY shape (see undoConfirm).
 */
import { z } from 'zod'
import { MoneyString } from '@gsms/contracts/index.js'

const lineId = z.string().uuid()

export const ConfirmAuditBefore = z
  .object({
    discount: MoneyString,
    offeredDiscount: MoneyString.optional(),
    /** What each cut set held BEFORE confirm: money or null (nothing). */
    setLines: z.array(z.object({ lineId, approvedAmount: MoneyString.nullable() }).strict()).optional(),
  })
  .strict()
export type ConfirmAuditBefore = z.infer<typeof ConfirmAuditBefore>

export const ConfirmAuditAfter = z
  .object({
    approvedTotal: MoneyString,
    discount: MoneyString,
    /** What staff typed, only when the stored discount differs. */
    enteredDiscount: MoneyString.optional(),
    discountReason: z.string().optional(),
    setLines: z.array(z.object({ lineId, approvedAmount: MoneyString, reason: z.string() }).strict()).optional(),
    jobAdvancedFrom: z.string().nullable().optional(),
    /** documents.signed_at this confirm wrote (ISO). Lets undo find ITS confirm; absent on legacy rows. */
    signedAt: z.string().datetime().optional(),
  })
  .strict()
export type ConfirmAuditAfter = z.infer<typeof ConfirmAuditAfter>
