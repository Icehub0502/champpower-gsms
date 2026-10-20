// TEMPORARY — shapes for Ice's P3.2 rulings of 20 Oct 2026 (B1 present the
// bill, B3 per-shop payment channels + surcharge, B4 line discounts) that are
// NOT in @gsms/contracts yet. CLAUDE.md §2 says web never declares API types of
// its own: this file is the one sanctioned exception, kept in ONE place so it
// can be deleted the day the backend lands the real schemas — replace each
// import of this file with the @gsms/contracts export and let tsc show what
// moved. Every new field is OPTIONAL so the screen still works against the
// f25038f API (it then shows the bill as "not presented yet").

import type { PrintDocType, Receipt, ReceiptLine, ReceiptPayment } from '@gsms/contracts/index.js';

export type ChannelKind = 'cash' | 'transfer' | 'card';

/** GET /api/payment-channels -> { items } (ASSUMED). */
export interface PaymentChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** "3.00" = +3% on what is paid through this channel; "0.00" = none. */
  surchargePercent: string;
  active: boolean;
  sortOrder: number;
}
export interface PaymentChannelList {
  items: PaymentChannel[];
}
/** POST /api/payment-channels (ASSUMED). */
export interface CreatePaymentChannelInput {
  name: string;
  kind: ChannelKind;
  surchargePercent: string;
}
/** PATCH /api/payment-channels/:id (ASSUMED). Deactivate = { active: false }; never a DELETE. */
export interface PatchPaymentChannelInput {
  name?: string;
  kind?: ChannelKind;
  surchargePercent?: string;
  active?: boolean;
}
/** PUT /api/payment-channels/order (ASSUMED). */
export interface ReorderPaymentChannelsInput {
  ids: string[];
}

/** B1: the moment the customer was shown the amount. `current` false = lines/discounts changed since. */
export interface ReceiptPresentation {
  presentedAt: string;
  presentedByName: string | null;
  current: boolean;
}

export type PendingReceiptLine = ReceiptLine & {
  /** B4: a discount on this line, satang text. */
  discount?: string;
  discountReason?: string | null;
};

export type PendingReceiptPayment = ReceiptPayment & {
  channelId?: string | null;
  channelName?: string | null;
  /** B3: the surcharge charged on this row, separate from the bill. */
  surcharge?: string;
};

export type PendingReceipt = Omit<Receipt, 'lines' | 'payments' | 'totals'> & {
  lines: PendingReceiptLine[];
  payments: PendingReceiptPayment[];
  totals: Receipt['totals'] & { lineDiscountTotal?: string; surchargeTotal?: string };
  presentation?: ReceiptPresentation | null;
};

/** PATCH /api/jobs/:jobId/receipt/lines/:lineId (ASSUMED). */
export interface LineDiscountInput {
  discount: string;
  discountReason?: string;
}

/** POST /api/jobs/:jobId/receipt/close, B3 shape (ASSUMED): one row per channel, the server adds the surcharge. */
export interface ChannelPaymentInput {
  channelId: string;
  /** The part of the BILL paid this way (before the channel's surcharge). */
  amount: string;
}
export interface CloseReceiptChannelsInput {
  payments: ChannelPaymentInput[];
  discountReason?: string;
}

/** B1: the "ใบแจ้งยอด" sheet is recorded in the print history like the others (ASSUMED doc type). */
export type AnyPrintDocType = PrintDocType | 'bill_statement';

/** Daily summary, B3 (ASSUMED): money in by channel, surcharges on their own line. */
export interface MoneyInChannelRow {
  channelId: string | null;
  name: string;
  kind: ChannelKind;
  received: string;
  changeGiven: string;
  reversed: string;
  surcharge: string;
  net: string;
}
