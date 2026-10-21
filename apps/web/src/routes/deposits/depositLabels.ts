// Words for deposits, and which roles the screen OFFERS things to. Display only:
// every rule is enforced by the API (CLAUDE.md §5.4 item 8, §12.1). The role
// lists are the domain's own (packages/domain rules/deposit.ts), never a copy.

import {
  DEPOSIT_CHANNELS, DEPOSIT_CHANNEL_LABEL, DEPOSIT_REASONS, DEPOSIT_REASON_LABEL, DEPOSIT_STATUS_LABEL,
  roleMayForfeitDeposit, roleMayRefundDeposit, roleMayWriteDeposit,
} from '@champpower/domain';
import type { Role } from '@gsms/contracts/index.js';

export { DEPOSIT_CHANNELS, DEPOSIT_CHANNEL_LABEL, DEPOSIT_REASONS, DEPOSIT_REASON_LABEL, DEPOSIT_STATUS_LABEL };

export function canWriteDeposit(role: Role | null): boolean {
  return role !== null && roleMayWriteDeposit(role);
}
export function canRefundDeposit(role: Role | null): boolean {
  return role !== null && roleMayRefundDeposit(role);
}
/** Manager and above (s5.4 item 8). The button is not even shown to anyone else. */
export function canForfeitDeposit(role: Role | null): boolean {
  return role !== null && roleMayForfeitDeposit(role);
}

export const DEPOSITS_PATH = '/api/deposits';
export const DEPOSIT_SOCKET_EVENT = 'deposit:changed';

export function depositPath(id: string): string {
  return `${DEPOSITS_PATH}/${encodeURIComponent(id)}`;
}
export function jobDepositsPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/deposits`;
}

/** A fresh key per attempt: a retry of the same attempt reuses it, so the server answers with the same deposit. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
