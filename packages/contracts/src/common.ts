// Primitives and envelopes shared by every schema in this package. Anything
// that more than one domain file would otherwise redefine belongs here —
// duplicating a regex across queue.ts and checkin.ts is how "9-10 digits" and
// "9 digits" quietly drift apart.

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

export const uuid = z.string().uuid();

// Thai mobile/landline numbers as staff actually key them: with or without
// dashes/spaces, 9-10 digits. Normalising (stripping separators) is a
// repository-layer concern, not this schema's — the wire value keeps whatever
// the caller typed so it round-trips for display.
export const thaiPhone = z
  .string()
  .trim()
  .regex(/^[0-9\s-]{9,12}$/, 'invalid_phone')
  .refine((v) => v.replace(/[\s-]/g, '').length >= 9 && v.replace(/[\s-]/g, '').length <= 10, {
    message: 'invalid_phone',
  });

// -----------------------------------------------------------------------------
// Blank means absent
// -----------------------------------------------------------------------------

/**
 * An optional form field where a blank entry means "not given".
 *
 * A form sends `''` for a field nobody filled in (`value.trim()` of an empty
 * input), not `undefined`. Left to the plain schema, `''` either FAILS —
 * a `.min(1)`, a phone regex, a date regex, an enum, a uuid — and the whole
 * request is a 400 with nothing to fix, or it PASSES and an empty string is
 * stored where NULL belongs. The first is the worse bug: a walk-in whose
 * province box was left empty could not open a job at all, which breaks the
 * rule that a walk-in is never blocked for lack of optional details (code
 * review, 26 Sep 2026).
 *
 * So a string that is empty after trimming — and `null`, which a form or a
 * client library may send for "nothing selected" — becomes `undefined`
 * BEFORE the field's own rules run: blank is treated exactly like the field
 * being left out, and a non-blank value is still checked in full. Numeric
 * fields are wrapped too: an empty number box arrives as `''` or `null`,
 * never as a number, and must not block a walk-in either. Use this for optional
 * fields a person types or picks — never for a required one, where a blank is
 * genuinely invalid and must stay a 400.
 */
export function blankAsAbsent<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
    schema.optional(),
  );
}

// Free text, not a strict format check: plates carry Thai script, province
// names, and staff shorthand. The only real rule is "not empty, not absurd".
export const plate = z.string().trim().min(1).max(20);

// -----------------------------------------------------------------------------
// Pagination
// -----------------------------------------------------------------------------

// Offset-based, not cursor-based: every list this package's first callers
// need (queue rows, bookings for a day) is small and re-queried on every
// screen refresh rather than infinite-scrolled, so an opaque cursor buys
// nothing yet. If a future endpoint needs stable pagination under concurrent
// writes, add a cursor variant there rather than bolting one onto this one.
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function Page<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
  });
}
export type PageOf<T> = { items: T[]; total: number };

// -----------------------------------------------------------------------------
// Error envelope — CLAUDE.md §9: every failure body conforms to this shape.
// -----------------------------------------------------------------------------

export const ApiError = z.object({
  // snake_case machine-readable code, e.g. "booking_overlap", "not_found".
  error: z.string(),
  message: z.string().optional(),
  // Per-field validation messages, keyed by field name.
  fields: z.record(z.array(z.string())).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
