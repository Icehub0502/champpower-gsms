// Upload responses for the check-in flow. Bytes never reach this package —
// only metadata does. See CLAUDE.md §12: images are served through an
// authenticated route that checks the file's shop_id against the caller's
// active_shop_id, never express.static.

import { z } from 'zod';

// Kinds this phase produces. `files.kind` in packages/db/migrations/0001
// currently only knows 'part_photo' | 'signature' | 'deposit_slip' |
// 'document_pdf' | 'other' — check-in needs its own values, added by the
// migration that lands alongside this endpoint (WO-003-ANSWERS.md §d.3).
// This schema is written for the target state; do not narrow it back to
// 'other' to dodge an unmerged migration.
export const CheckInFileKind = z.enum(['checkin_photo', 'checkin_thumb']);
export type CheckInFileKind = z.infer<typeof CheckInFileKind>;

export const UploadedFile = z.object({
  id: z.string().uuid(),
  kind: CheckInFileKind,
  mime: z.string(),
  bytes: z.number().int().min(0),
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
});
export type UploadedFile = z.infer<typeof UploadedFile>;

// Server-side constraints this schema does not (and cannot) enforce, kept
// here as documentation so nobody has to go read the route to find them:
//   - mime is verified from the file's magic bytes, not its filename or the
//     Content-Type header the client sent — an .exe renamed to .jpg must fail.
//   - only image/* is accepted for both kinds.
//   - there is a size cap enforced before the file is written to disk.
//   - GET on an uploaded file 404s if files.shop_id !== the caller's
//     active_shop_id, rather than leaking a "403 exists but not for you".
