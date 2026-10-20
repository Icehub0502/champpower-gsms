// TEMPORARY — the channel surcharge (Ice B3, 20 Oct 2026) has no packages/domain
// function yet and this branch may only touch apps/web. Until the backend adds
// it (expected name: `channelSurchargeSatang` in rules/receipt.ts), the ONE
// calculation lives here, in integer satang, never in a component. Delete this
// file and import the domain export the day it exists; the API recomputes the
// surcharge at close regardless, so this only drives the preview.

import { MoneyError, toQtyCenti } from '@champpower/domain';

/**
 * Surcharge on `baseSatang` at `percentText` ("3.00" = 3%), rounded half up
 * once. null when the percent is not a valid number.
 */
export function previewSurchargeSatang(baseSatang: number, percentText: string): number | null {
  let hundredths: number;
  try {
    hundredths = toQtyCenti(percentText); // "3.00" -> 300 = 3.00%
  } catch (e) {
    if (e instanceof MoneyError) return null;
    throw e;
  }
  if (hundredths <= 0 || baseSatang <= 0) return 0;
  // base x percent/100, with percent in hundredths: base x h / 10000, half up (BigInt: no 2^53 overflow).
  return Number((BigInt(baseSatang) * BigInt(hundredths) * 2n + 10000n) / 20000n);
}
