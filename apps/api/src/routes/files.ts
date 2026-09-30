/**
 * Check-in photo upload and retrieval — files on disk, metadata in `files`.
 *
 * CLAUDE.md §12 forbids `express.static` for these images: photos belong to
 * one shop and must be authorised per request, not handed out to anyone who
 * guesses a URL. Every route here goes through `requireAuth`, and every
 * database read/write is scoped with `withShop(db, req.auth.shop, ...)` so
 * RLS and the row's `shop_id` are checked by the same mechanism every other
 * tenant-scoped query in this codebase uses — never a hand-written
 * `WHERE shop_id = ?` that someone could forget.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import multer from 'multer'
import type { NextFunction, Response } from 'express'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { fieldErrorsOf } from '../lib/fieldErrors.js'
import type { InvalidRequestError } from '@gsms/contracts/index.js'
import {
  MAX_UPLOAD_BYTES,
  deleteFile,
  makeThumbnail,
  reencodeOriginal,
  withDecodeSlot,
  resolveStoredPath,
  sniffImageType,
  writeImageFile,
} from '../services/fileStorage.js'

// Every handler on this router is wrapped; see middleware/asyncHandler.ts.
export const filesRouter = asyncRouter()

/**
 * CLAUDE.md §12.1's "อัปเดตสถานะงาน / ถ่ายรูป" row, named so the next change
 * to the matrix has one place to land instead of two routes silently
 * drifting apart. Deliberately NOT the intake role set (queue.ts,
 * bookings.ts, checkin.ts) — that set excludes `technician`, and
 * technicians are the people standing next to the car with the phone; the
 * matrix grants them photos on purpose.
 */
const PHOTO_WRITE_ROLES = ['owner', 'manager', 'assistant_manager', 'advisor', 'technician'] as const

/**
 * Who may SEE a check-in photo: the five who may take one, plus `viewer`.
 *
 * `viewer` — THE OWNER'S DECISION (docs/WORK-ORDERS/DECISION-7-today.md §2,
 * 24 Sep 2026), not a default: a check-in photo is the evidence of the car's
 * condition on arrival, which is the single most important thing someone
 * reviewing past work needs to see; without it the viewer role cannot actually
 * review a job. The decision is conditional on `viewer` being an INTERNAL,
 * signed-in role (an owner or manager who only looks) — which it is: it exists
 * only as a shop_memberships role behind requireAuth. If `viewer` is ever
 * repurposed for customers, this line must be revisited: the owner's answer
 * for a customer-facing viewer was "no". Read only — `viewer` is deliberately
 * NOT in PHOTO_WRITE_ROLES.
 *
 * `accountant` stays excluded, by an explicit rule rather than a default:
 * CLAUDE.md §7 rule 13 — the accountant sees only what tax needs,
 * "ไม่เห็นรูป/โน้ตภายใน/ประวัติช่าง".
 *
 * And the line nobody crosses, whatever role: the public waiting-room board
 * (/api/public/board) carries NO photo for anyone. It needs no login and the
 * whole room can see it; a photo of a customer's car is the customer's.
 */
const PHOTO_READ_ROLES = [...PHOTO_WRITE_ROLES, 'viewer'] as const

/**
 * memoryStorage + multer's own `limits.fileSize`: the cap is enforced by
 * multer while it is still buffering the multipart body, so an oversized
 * upload is rejected before a single byte reaches disk — not after a write
 * we would then have to clean up. The file only exists in memory (one
 * request at a time, capped at MAX_UPLOAD_BYTES) until writeImageFile is
 * called explicitly, below.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
})

/**
 * multer reports a rejected upload (over the size cap, more than one file,
 * a malformed multipart body) by calling its own `next(err)`, not by
 * rejecting a promise — so asyncHandler's try/catch never sees it, and
 * without this wrapper the error would reach app.ts's central handler and
 * come back as a bare 500. Translating it here, at the point the upload was
 * attempted, is what actually produces the 413/400 the client needs to
 * distinguish "too big" from "something broke".
 */
function uploadSingle(req: AuthedRequest, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) {
      next()
      return
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'file_too_large' })
      return
    }
    // Any other multer/busboy failure (bad boundary, too many files, a
    // field that isn't part of this form) is a malformed request, not a
    // server error.
    res.status(400).json({ error: 'invalid_request' })
  })
}

const uploadBody = z.object({
  // The only kind a client may request. The server derives the matching
  // 'checkin_thumb' itself — see contracts/src/files.ts and migration 0013.
  kind: z.literal('checkin_photo'),
})

filesRouter.post(
  '/',
  requireAuth,
  // Role check before multer runs, deliberately: a caller who is not
  // allowed to upload photos should never have their body accepted at all,
  // let alone buffered, sniffed or written to disk. A 403 that still left
  // bytes behind would be the access-control bug with a nicer status code.
  requireRole(...PHOTO_WRITE_ROLES),
  uploadSingle,
  async (req: AuthedRequest, res) => {
    const auth = req.auth!
    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'missing_file' })
      return
    }

    const parsedBody = uploadBody.safeParse(req.body)
    if (!parsedBody.success) {
      // Codes only, never zod's own messages — those can quote what the caller
      // sent (lib/fieldErrors.ts) — and the house InvalidRequestError shape.
      const body: InvalidRequestError = {
        error: 'invalid_request',
        message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง',
        fields: fieldErrorsOf(parsedBody.error),
      }
      res.status(400).json(body)
      return
    }

    // mime comes from the bytes, never from file.mimetype (the client's
    // Content-Type header) or file.originalname — see fileStorage.ts.
    const sniffed = sniffImageType(file.buffer)
    if (!sniffed) {
      res.status(400).json({ error: 'unsupported_file_type' })
      return
    }

    // multer's limits.fileSize already stopped anything larger from being
    // buffered at all; this is defence in depth in case that config is ever
    // changed without this route being revisited.
    if (file.size > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: 'file_too_large' })
      return
    }

    // Sniffing only inspects a handful of leading bytes, so a file that
    // passes it can still fail to decode — truncated mid-transfer, or a
    // polyglot that merely starts with valid JPEG/PNG/WebP magic bytes.
    // That is the same "not actually a usable photo" case sniffing exists
    // to catch, so it gets the same 400 rather than surfacing as a bare 500
    // from whatever sharp call happens to hit it first. Decoding happens
    // BEFORE anything is written, so a bad file leaves nothing on disk.
    //
    // The stored original is a re-encode, not the uploaded bytes: that is what
    // strips EXIF/GPS from a direct API upload (fileStorage.reencodeOriginal).
    let reencoded: Awaited<ReturnType<typeof reencodeOriginal>>
    let thumbnail: Awaited<ReturnType<typeof makeThumbnail>>
    try {
      // Bounded concurrency: see DECODE_SLOTS. Waiting here costs a request
      // some latency; it never fails one.
      ;[reencoded, thumbnail] = await withDecodeSlot(async () => {
        const original = await reencodeOriginal(file.buffer, sniffed.type)
        return [original, await makeThumbnail(original.buffer)] as const
      })
    } catch {
      res.status(400).json({ error: 'unsupported_file_type' })
      return
    }
    const dims = { width: reencoded.width, height: reencoded.height }
    const original = await writeImageFile(auth.shop, sniffed.ext, reencoded.buffer)

    let thumb: Awaited<ReturnType<typeof writeImageFile>> | null = null
    let thumbMeta: { width: number; height: number; mime: string } | null = null

    try {
      thumb = await writeImageFile(auth.shop, thumbnail.ext, thumbnail.buffer)
      thumbMeta = { width: thumbnail.width, height: thumbnail.height, mime: thumbnail.mime }

      const photoId = randomUUID()
      const thumbId = randomUUID()

      // Insert scoped to the caller's own shop: RLS enforces it, and the
      // WITH CHECK the migration installs would refuse a mismatched shop_id
      // outright even if this code had a bug.
      await withShop(db, auth.shop, async (trx) => {
        await trx.insertInto('files').values([
          {
            id: photoId,
            shop_id: auth.shop,
            path: original.relativePath,
            mime: sniffed.mime,
            bytes: original.bytes,
            kind: 'checkin_photo',
            uploaded_by: auth.sub,
          },
          {
            id: thumbId,
            shop_id: auth.shop,
            path: thumb!.relativePath,
            mime: thumbnail.mime,
            bytes: thumb!.bytes,
            kind: 'checkin_thumb',
            uploaded_by: auth.sub,
          },
        ]).execute()
      })

      res.status(201).json({
        photo: {
          id: photoId,
          kind: 'checkin_photo',
          mime: sniffed.mime,
          bytes: original.bytes,
          width: dims.width,
          height: dims.height,
        },
        thumb: {
          id: thumbId,
          kind: 'checkin_thumb',
          mime: thumbMeta.mime,
          bytes: thumb!.bytes,
          width: thumbMeta.width,
          height: thumbMeta.height,
        },
      })
    } catch (err) {
      // An orphaned file with no DB row is a wasted few KB on disk. An
      // orphaned DB row pointing at nothing is worse: every future read of
      // it 500s, and nothing about the row says why. Clean up what we wrote.
      await deleteFile(original.relativePath)
      if (thumb) await deleteFile(thumb.relativePath)
      throw err
    }
  },
)

const fileIdParam = z.object({ id: z.string().uuid() })

filesRouter.get(
  '/:id',
  requireAuth,
  requireRole(...PHOTO_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const auth = req.auth!
    const parsed = fileIdParam.safeParse(req.params)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }

    // Scoped to the caller's own shop. A file belonging to another shop is
    // therefore not a 403 — it is a 404, exactly as if the id did not exist
    // at all. A 403 would confirm the id is real, which is itself a leak of
    // information the caller has no business getting (CLAUDE.md §8, and the
    // work order's explicit "ขอไฟล์รูปของสาขาอื่น ... 404 ไม่ใช่ไฟล์").
    const row = await withShop(db, auth.shop, (trx) =>
      trx.selectFrom('files')
        .select(['path', 'mime', 'bytes'])
        .where('id', '=', parsed.data.id)
        .executeTakeFirst(),
    )

    if (!row) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    // Second line of defence: even though row.path was written exclusively
    // by writeImageFile with a server-generated uuid (see fileStorage.ts),
    // resolve-and-check again before opening anything from disk, in case a
    // future writer of this column is ever less careful than this one.
    const absolutePath = resolveStoredPath(row.path)
    if (!absolutePath) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    try {
      await stat(absolutePath)
    } catch {
      // Row exists, file does not — a storage/DB mismatch, not a client
      // error. Reported as 404 rather than 500: from the caller's point of
      // view "this image was not returned" either way, and no detail about
      // why leaks out.
      res.status(404).json({ error: 'not_found' })
      return
    }

    res.setHeader('Content-Type', row.mime)
    res.setHeader('Content-Length', String(row.bytes))
    // Private: these are one shop's customer photos, never a shared/public
    // cache. A short max-age still saves a re-fetch when the same check-in
    // screen re-renders the same thumbnail a few times in a row.
    res.setHeader('Cache-Control', 'private, max-age=300')
    createReadStream(absolutePath).pipe(res)
  },
)
