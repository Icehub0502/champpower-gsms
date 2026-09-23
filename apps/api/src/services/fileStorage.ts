/**
 * Check-in photos as files on disk, not base64 in a column.
 *
 * The prototype stored `job_photos.photo_data LONGTEXT` and the table became
 * the reason the system got slower every month — every `SELECT *` anywhere
 * near it dragged megabytes of base64 across the wire. This module writes
 * bytes to `storage/<shop_id>/<yyyy-mm>/<uuid>.<ext>` and the `files` table
 * (packages/db/migrations/0001) keeps only the path and metadata.
 *
 * Nothing here trusts the client for anything that becomes part of a path or
 * a stored mime type:
 *   - the mime is decided by sniffing the file's magic bytes, never the
 *     filename, extension or Content-Type header;
 *   - the on-disk filename is a server-generated uuid with the extension
 *     that sniffing chose, never anything derived from client input — so
 *     there is no filename for a path-traversal payload to hide in, and
 *     nothing to sanitise or reject, because nothing client-supplied ever
 *     reaches the filesystem API. This makes traversal structurally
 *     impossible rather than filtered-against.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

// This file lives at apps/api/src/services/fileStorage.ts, four directories
// below the repo root, in both the tsx dev run and the compiled lib/ output
// (tsc mirrors the src/ layout under lib/). Resolving from import.meta.url
// rather than process.cwd() means STORAGE_DIR=./storage in .env always lands
// on the repo-root storage/ directory documented in CLAUDE.md §2, regardless
// of what directory the process happened to be started from (npm workspaces,
// vitest, and a plain `node lib/index.js` do not all agree on cwd).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const STORAGE_ROOT = path.resolve(REPO_ROOT, process.env.STORAGE_DIR ?? './storage')

export type SniffedImageType = 'jpeg' | 'png' | 'webp'

export interface SniffResult {
  type: SniffedImageType
  mime: string
  ext: string
}

/**
 * Identify an image purely from its bytes. A renamed .exe or .html never gets
 * past this: there is no branch here that trusts a filename or a declared
 * Content-Type, only the handful of leading bytes every real encoder for
 * these formats writes.
 *
 * Returns null for anything that isn't one of the three accepted formats —
 * including formats sharp itself could decode (gif, tiff, avif, svg) that we
 * deliberately do not accept, so "accepted" stays a short, auditable list.
 */
export function sniffImageType(buf: Buffer): SniffResult | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { type: 'jpeg', mime: 'image/jpeg', ext: 'jpg' }
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { type: 'png', mime: 'image/png', ext: 'png' }
  }
  // WebP: "RIFF" .... "WEBP" — bytes 0-3 and 8-11.
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { type: 'webp', mime: 'image/webp', ext: 'webp' }
  }
  return null
}

/**
 * A phone photo, even downscaled client-side by apps/web/src/lib/compressImage.ts,
 * can still land well past what a form field needs. 8 MB comfortably covers a
 * full-resolution JPEG from a mid-range phone camera (a modern 12-48MP sensor's
 * JPEG output is typically 3-8MB) while keeping a single upload from being able
 * to fill the disk or the request body budget on its own. Enforced by multer's
 * own `limits.fileSize` in routes/files.ts, so the cap applies before the
 * bytes are fully buffered — not after a write to disk.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

const THUMB_MAX_DIMENSION = 320
// Server-side JPEG re-encode quality for thumbnails. Thumbnails are for list
// views, not proof of condition, so a lossy re-encode is fine here even
// though the original photo is kept byte-for-byte.
const THUMB_JPEG_QUALITY = 70

export interface StoredFile {
  relativePath: string
  absolutePath: string
  bytes: number
}

/** yyyy-MM in the server's local time; matches the folder scheme in the work order. */
function yearMonth(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/**
 * Write one buffer under `storage/<shopId>/<yyyy-mm>/<uuid>.<ext>` and return
 * both the path stored in `files.path` (relative, portable across machines)
 * and the absolute path actually written.
 *
 * `shopId` must already be a validated UUID (it comes from `req.auth.shop`,
 * the verified JWT, never client input) — it becomes a path segment, so a
 * caller that let an arbitrary string through here would reopen exactly the
 * traversal risk this module exists to close for filenames.
 */
export async function writeImageFile(
  shopId: string,
  ext: string,
  data: Buffer,
): Promise<StoredFile> {
  const relativeDir = path.join(shopId, yearMonth(new Date()))
  const filename = `${randomUUID()}.${ext}`
  const relativePath = path.join(relativeDir, filename)
  const absoluteDir = path.join(STORAGE_ROOT, relativeDir)
  const absolutePath = path.join(absoluteDir, filename)

  await fs.mkdir(absoluteDir, { recursive: true })
  await fs.writeFile(absolutePath, data, { flag: 'wx' }) // 'wx': never silently overwrite

  return { relativePath, absolutePath, bytes: data.length }
}

/** Best-effort delete, used to clean up a file whose DB insert failed. */
export async function deleteFile(relativePath: string): Promise<void> {
  const abs = resolveStoredPath(relativePath)
  if (!abs) return
  await fs.unlink(abs).catch(() => {
    // Nothing more useful to do: the DB row was already rolled back or never
    // written, so there is no record to reconcile against.
  })
}

/**
 * Resolve a `files.path` value to an absolute path, refusing anything that
 * would resolve outside STORAGE_ROOT.
 *
 * This is the second line of defence promised in the route comment: the
 * first (never building a path from client input) already makes traversal
 * impossible for uploads. This guard exists for the read side, in case a
 * `files.path` value is ever corrupted or hand-edited in the database —
 * defence that does not depend on every future writer of that column being
 * as careful as this one.
 */
export function resolveStoredPath(relativePath: string): string | null {
  const abs = path.resolve(STORAGE_ROOT, relativePath)
  const rootWithSep = STORAGE_ROOT.endsWith(path.sep) ? STORAGE_ROOT : STORAGE_ROOT + path.sep
  if (abs !== STORAGE_ROOT && !abs.startsWith(rootWithSep)) return null
  return abs
}

export interface ThumbnailResult {
  buffer: Buffer
  mime: string
  ext: string
  width: number
  height: number
}

/**
 * Downscale to a small JPEG thumbnail. Always re-encodes to JPEG regardless
 * of the source format, since thumbnails are for fast list rendering, not
 * format fidelity.
 */
export async function makeThumbnail(source: Buffer): Promise<ThumbnailResult> {
  const image = sharp(source).rotate() // honour EXIF orientation before resizing
  const resized = image.resize({
    width: THUMB_MAX_DIMENSION,
    height: THUMB_MAX_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true,
  })
  const buffer = await resized.jpeg({ quality: THUMB_JPEG_QUALITY }).toBuffer()
  const meta = await sharp(buffer).metadata()
  return {
    buffer,
    mime: 'image/jpeg',
    ext: 'jpg',
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  }
}

/** Read image dimensions without re-encoding — used for the original photo. */
export async function readImageDimensions(
  buf: Buffer,
): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}
