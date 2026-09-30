/**
 * WO-003/T5 — check-in photo storage, end to end against a real PostgreSQL
 * and the real filesystem.
 *
 * TIER 2. Skipped (not failing) on a machine with no database — see
 * test/env.ts. Run with GSMS_TEST_DB=1 and a reachable DATABASE_URL.
 *
 * What each case proves, and why it's here rather than being "obviously
 * fine": CLAUDE.md §12 forbids express.static for these images specifically
 * because a wrong answer here is a silent cross-tenant photo leak, and the
 * work order's stated pass criterion is 404, not 403, for another shop's
 * file — a 403 would itself confirm the id exists.
 */
import { promises as fsp } from 'node:fs'
import sharp from 'sharp'
import { crc32, deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { InvalidRequestError } from '@gsms/contracts/index.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, issueTokensFor, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'
import { resolveStoredPath } from '../services/fileStorage.js'

// A minimal, valid 1x1 JPEG — real magic bytes (FF D8 FF ... FF D9) and a
// real (tiny) baseline-encoded body, so sharp can decode it for the
// thumbnail step, not just so the sniffer accepts it.
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI' +
  'CQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQ' +
  'EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEB' +
  'AQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX' +
  '/9k='
const JPEG_BUF = Buffer.from(JPEG_BASE64, 'base64')

/**
 * The stored original is a re-encode (EXIF/GPS stripped), so it is no longer
 * byte-identical to the upload. What must hold: it still decodes, as the same
 * kind of image at the same size.
 */
async function expectDecodesAsTinyJpeg(buf: Buffer): Promise<void> {
  const meta = await sharp(buf).metadata()
  expect(meta.format).toBe('jpeg')
  expect([meta.width, meta.height]).toEqual([1, 1])
}

/**
 * A 1-bit greyscale PNG declaring 12000x12000 (144 MP, over the 100 MP cap): a
 * few KB on disk, but it would expand to hundreds of MB decoded if we let it.
 * Built by hand so the test itself stays cheap.
 */
function hugePng(): Buffer {
  const W = 12000
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // greyscale
  const rowBytes = 1 + Math.ceil(W / 8) // filter byte + packed pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(rowBytes * W))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

interface UploadResponse {
  photo: { id: string; kind: string; mime: string; bytes: number; width: number; height: number }
  thumb: { id: string; kind: string; mime: string; bytes: number; width: number; height: number }
}

/** POST multipart/form-data to /api/files the way a browser upload does. */
async function uploadFile(
  api: RunningApi, token: string, bytes: Buffer, filename: string, kind = 'checkin_photo',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData()
  form.append('kind', kind)
  form.append('file', new Blob([new Uint8Array(bytes)]), filename)
  const res = await fetch(`${api.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function getFile(
  api: RunningApi, token: string, id: string,
): Promise<{ status: number; buf: Buffer; contentType: string | null; cacheControl: string | null }> {
  const res = await fetch(`${api.url}/api/files/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const buf = Buffer.from(await res.arrayBuffer())
  return {
    status: res.status,
    buf,
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
  }
}

describe.skipIf(!hasDatabase)(tier2('check-in photo files'), () => {
  let api: RunningApi
  let fx: TwoShopFixture
  // Every file id this suite creates, cleaned up in afterAll regardless of
  // which test created it or whether it failed partway through.
  const createdFileIds: string[] = []

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo003files')
  })

  afterAll(async () => {
    // Delete rows and the bytes on disk they point at — a leftover file with
    // no row is a wasted few KB; a leftover row is a wasted few KB AND a
    // future 500 for whoever queries it next. Neither should survive a run.
    for (const shopId of [fx.shopA, fx.shopB]) {
      const rows = await withShop(db, shopId, (trx) =>
        trx.selectFrom('files')
          .select(['id', 'path'])
          .where('shop_id', '=', shopId)
          .where('id', 'in', createdFileIds.length ? createdFileIds : ['00000000-0000-0000-0000-000000000000'])
          .execute())
      for (const row of rows) {
        const abs = resolveStoredPath(row.path)
        if (abs) await fsp.unlink(abs).catch(() => {})
      }
      await withShop(db, shopId, (trx) =>
        trx.deleteFrom('files').where('shop_id', '=', shopId).execute())
    }
    await fx?.cleanup()
    await api?.close()
  })

  const tokenA = () => issueTokensFor(fx.userId, fx.shopA, 'advisor')
  const tokenB = () => issueTokensFor(fx.outsiderId, fx.shopB, 'advisor')

  /**
   * Row count for one shop, used to prove a refused request left nothing
   * behind. `files` carries RLS, so this has to run inside withShop.
   */
  const fileCountForShop = (shopId: string) =>
    withShop(db, shopId, (trx) =>
      trx.selectFrom('files')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow())
      .then((r) => Number(r.n))

  /**
   * How many bytes-on-disk exist under one shop's storage folder right now.
   * Used the same way as fileCountForShop, but for the filesystem side: a 403
   * that still wrote a file would pass a rows-only check and still be the bug
   * this whole route exists to prevent (CLAUDE.md §12).
   */
  async function diskFileCountForShop(shopId: string): Promise<number> {
    const base = resolveStoredPath(shopId)
    if (!base) return 0
    try {
      const entries = await fsp.readdir(base, { recursive: true, withFileTypes: true })
      return entries.filter((e) => e.isFile()).length
    } catch {
      return 0 // shop has never had a folder created yet
    }
  }

  it('uploads a real JPEG and reads it back through its own shop', async () => {
    const { accessToken: access } = await tokenA()
    const up = await uploadFile(api, access, JPEG_BUF, 'checkin.jpg')
    expect(up.status).toBe(201)
    const body = up.body as unknown as UploadResponse
    expect(body.photo.kind).toBe('checkin_photo')
    expect(body.thumb.kind).toBe('checkin_thumb')
    expect(body.photo.bytes).toBeGreaterThan(0)
    createdFileIds.push(body.photo.id, body.thumb.id)

    // The row landed in the caller's own shop, with the sniffed mime — not
    // whatever Content-Type the client happened to send.
    const row = await withShop(db, fx.shopA, (trx) =>
      trx.selectFrom('files')
        .select(['shop_id', 'kind', 'mime', 'path'])
        .where('id', '=', body.photo.id)
        .executeTakeFirstOrThrow())
    expect(row.shop_id).toBe(fx.shopA)
    expect(row.mime).toBe('image/jpeg')

    const got = await getFile(api, access, body.photo.id)
    expect(got.status).toBe(200)
    await expectDecodesAsTinyJpeg(got.buf)
    expect(got.buf.length).toBe(body.photo.bytes)
    expect(got.contentType).toBe('image/jpeg')
    // Private: these are one shop's customer photos, never a shared cache —
    // CLAUDE.md §12.
    expect(got.cacheControl ?? '').toMatch(/^private/)

    const gotThumb = await getFile(api, access, body.thumb.id)
    expect(gotThumb.status).toBe(200)
    expect(gotThumb.buf.length).toBeGreaterThan(0)
  })

  it('strips EXIF/GPS from the stored original, and keeps the picture upright at the right size', async () => {
    const CANARY = 'HOME-LOCATION-CANARY'
    // 40x20 pixels tagged Orientation 6 (rotate 90deg): a viewer shows 20x40.
    const raw = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 20, b: 20 } },
    }).withMetadata({
      orientation: 6,
      exif: {
        IFD0: { ImageDescription: CANARY },
        IFD3: {
          GPSLatitudeRef: 'N', GPSLatitude: '13/1 39/1 0/1',
          GPSLongitudeRef: 'E', GPSLongitude: '100/1 35/1 0/1',
        },
      },
    }).jpeg().toBuffer()
    // The precondition: the upload really does carry metadata.
    const rawMeta = await sharp(raw).metadata()
    expect(rawMeta.exif).toBeDefined()
    expect(rawMeta.orientation).toBe(6)
    expect(raw.includes(Buffer.from(CANARY))).toBe(true)

    const { accessToken } = await tokenA()
    const up = await uploadFile(api, accessToken, raw, 'gps.jpg')
    expect(up.status).toBe(201)
    const body = up.body as unknown as UploadResponse
    createdFileIds.push(body.photo.id, body.thumb.id)

    const got = await getFile(api, accessToken, body.photo.id)
    expect(got.status).toBe(200)
    const meta = await sharp(got.buf).metadata()
    expect(meta.exif, 'EXIF survived the upload').toBeUndefined()
    expect(meta.xmp).toBeUndefined()
    expect(meta.iptc).toBeUndefined()
    expect(got.buf.includes(Buffer.from(CANARY))).toBe(false)
    // Orientation baked into the pixels: sideways source is now 20x40 upright,
    // and the API reports the dimensions a viewer sees.
    expect([meta.width, meta.height]).toEqual([20, 40])
    expect([body.photo.width, body.photo.height]).toEqual([20, 40])
    expect(body.photo.bytes).toBe(got.buf.length)
    expect(meta.orientation ?? 1).toBe(1)
  })

  it('uploads beyond the decode slots all complete, whether they succeed or are refused', async () => {
    const { accessToken } = await tokenA()
    const png = hugePng()
    const results = await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => uploadFile(api, accessToken, JPEG_BUF, `burst-${i}.jpg`)),
      ...Array.from({ length: 4 }, (_, i) => uploadFile(api, accessToken, png, `burst-huge-${i}.png`)),
    ])
    expect(results.slice(0, 5).map((r) => r.status)).toEqual([201, 201, 201, 201, 201])
    expect(results.slice(5).map((r) => r.status)).toEqual([400, 400, 400, 400])
    for (const r of results.slice(0, 5)) {
      const b = r.body as unknown as UploadResponse
      createdFileIds.push(b.photo.id, b.thumb.id)
    }
    // Slots were released by the failures too: a further upload still goes through.
    const after = await uploadFile(api, accessToken, JPEG_BUF, 'after-burst.jpg')
    expect(after.status).toBe(201)
    const ab = after.body as unknown as UploadResponse
    createdFileIds.push(ab.photo.id, ab.thumb.id)
  })

  it('refuses an image with an absurd pixel count that is tiny on disk: 400, nothing written, server still healthy', async () => {
    const png = hugePng()
    expect(png.length).toBeLessThan(1024 * 1024)

    const { accessToken } = await tokenA()
    const rowsBefore = await fileCountForShop(fx.shopA)
    const diskBefore = await diskFileCountForShop(fx.shopA)
    const rssBefore = process.memoryUsage().rss

    const up = await uploadFile(api, accessToken, png, 'huge.png')
    expect(up.status).toBe(400)
    expect(up.body).toEqual({ error: 'unsupported_file_type' })
    expect(JSON.stringify(up.body)).not.toMatch(/pixel|limit|sharp|at /i)
    expect(await fileCountForShop(fx.shopA)).toBe(rowsBefore)
    expect(await diskFileCountForShop(fx.shopA)).toBe(diskBefore)
    // No decode happened: the process did not balloon (hundreds of MB would).
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(200 * 1024 * 1024)

    // And the server carries on serving.
    const ok = await uploadFile(api, accessToken, JPEG_BUF, 'after-huge.jpg')
    expect(ok.status).toBe(201)
    const okBody = ok.body as unknown as UploadResponse
    createdFileIds.push(okBody.photo.id, okBody.thumb.id)
  })

  it('answers 404, not 403, when the file belongs to a different shop', async () => {
    const { accessToken: accessA } = await tokenA()
    const up = await uploadFile(api, accessA, JPEG_BUF, 'checkin-cross-shop.jpg')
    expect(up.status).toBe(201)
    const body = up.body as unknown as UploadResponse
    createdFileIds.push(body.photo.id, body.thumb.id)

    const { accessToken: accessB } = await tokenB()
    const got = await getFile(api, accessB, body.photo.id)
    // Not 403: a 403 would itself confirm the id exists, which is the leak
    // CLAUDE.md §8 and the work order both call out explicitly.
    expect(got.status).toBe(404)
    // The body is the standard JSON error shape, not any part of the photo.
    expect(got.contentType ?? '').toMatch(/application\/json/)
    expect(JSON.parse(got.buf.toString('utf8'))).toEqual({ error: 'not_found' })
  })

  it('an unknown kind is invalid_request with codes only — the value sent is never echoed', async () => {
    // It returned zod's flatten() — the wrong shape ({formErrors, fieldErrors})
    // and default messages that can quote the input.
    const { accessToken: access } = await tokenA()
    const canary = 'KIND-CANARY-4417'
    const up = await uploadFile(api, access, JPEG_BUF, 'checkin.jpg', canary)
    expect(up.status).toBe(400)
    expect(InvalidRequestError.parse(up.body).fields).toEqual({ kind: ['invalid_value'] })
    expect(JSON.stringify(up.body)).not.toContain(canary)
  })

  it('rejects a text file renamed .jpg as unsupported_file_type', async () => {
    const { accessToken: access } = await tokenA()
    const notAnImage = Buffer.from('this is plain text, not a jpeg\n'.repeat(20))
    const up = await uploadFile(api, access, notAnImage, 'totally-a-photo.jpg')
    expect(up.status).toBe(400)
    expect(up.body.error).toBe('unsupported_file_type')
  })

  it('rejects an oversized upload with 413', async () => {
    const { accessToken: access } = await tokenA()
    // 9 MB, one over the 8 MB cap (fileStorage.ts MAX_UPLOAD_BYTES) — real
    // JPEG magic bytes, so the only reason it can fail is size.
    const big = Buffer.alloc(9 * 1024 * 1024, 0)
    big[0] = 0xff
    big[1] = 0xd8
    big[2] = 0xff
    const up = await uploadFile(api, access, big, 'huge.jpg')
    expect(up.status).toBe(413)
  })

  it('ignores a path-traversal filename entirely — the stored path is server-chosen', async () => {
    const { accessToken: access } = await tokenA()
    const up = await uploadFile(api, access, JPEG_BUF, '../../../../etc/passwd.jpg')
    expect(up.status).toBe(201)
    const body = up.body as unknown as UploadResponse
    createdFileIds.push(body.photo.id, body.thumb.id)

    const row = await withShop(db, fx.shopA, (trx) =>
      trx.selectFrom('files')
        .select(['path', 'shop_id'])
        .where('id', '=', body.photo.id)
        .executeTakeFirstOrThrow())

    // The stored path is built only from the server's own shop id, a
    // yyyy-mm folder, and a randomUUID — nothing from the client's filename
    // field ever reaches path construction (services/fileStorage.ts), so
    // there is no "../" to find here even though the client sent one.
    expect(row.path).not.toContain('..')
    expect(row.path).not.toContain('etc')
    expect(row.path).not.toContain('passwd')
    expect(row.path.startsWith(fx.shopA)).toBe(true)

    // And the file actually landed under the storage root, not escaped from
    // it — resolveStoredPath returns null for anything that would resolve
    // outside, so a non-null result here is itself part of the proof.
    const abs = resolveStoredPath(row.path)
    expect(abs).not.toBeNull()
    await expect(fsp.stat(abs!)).resolves.toBeTruthy()

    // Fetching it back still works normally.
    const got = await getFile(api, access, body.photo.id)
    expect(got.status).toBe(200)
    await expectDecodesAsTinyJpeg(got.buf)
    expect(got.buf.length).toBe(body.photo.bytes)
  })

  // ===========================================================================
  // Security review finding (HIGH): requireAuth alone let ANY authenticated
  // role upload and read photos. CLAUDE.md §12.1's "ถ่ายรูป" row names five
  // roles, not seven; §7 rule 13 excludes accountant from photos explicitly.
  // ===========================================================================
  describe('role gate', () => {
    it('lets viewer READ a photo but never upload one — owner decision 2', async () => {
      const { accessToken: viewer } = await issueTokensFor(fx.userId, fx.shopA, 'viewer')
      const beforeRows = await fileCountForShop(fx.shopA)
      const beforeDisk = await diskFileCountForShop(fx.shopA)

      // Upload stays refused: viewer is read-only.
      const up = await uploadFile(api, viewer, JPEG_BUF, 'viewer-attempt.jpg')
      expect(up.status).toBe(403)
      expect(up.body.error).toBe('forbidden')

      // A 403 that still wrote bytes would be the access-control bug with a
      // nicer status code — the role check runs before multer specifically
      // so this can never be true.
      expect(await fileCountForShop(fx.shopA)).toBe(beforeRows)
      expect(await diskFileCountForShop(fx.shopA)).toBe(beforeDisk)

      // Reading is allowed (DECISION-7-today.md §2): a check-in photo is the
      // evidence of the car's condition, and an internal viewer reviewing a job
      // must be able to see it. Upload one as an allowed role, fetch as viewer.
      const { accessToken: advisor } = await tokenA()
      const legit = await uploadFile(api, advisor, JPEG_BUF, 'legit.jpg')
      expect(legit.status).toBe(201)
      const legitBody = legit.body as unknown as UploadResponse
      createdFileIds.push(legitBody.photo.id, legitBody.thumb.id)

      const got = await getFile(api, viewer, legitBody.photo.id)
      expect(got.status).toBe(200)
    })

    it('refuses accountant on both POST and GET — CLAUDE.md §7 rule 13', async () => {
      const { accessToken: accountant } = await issueTokensFor(fx.userId, fx.shopA, 'accountant')
      const beforeRows = await fileCountForShop(fx.shopA)
      const beforeDisk = await diskFileCountForShop(fx.shopA)

      const up = await uploadFile(api, accountant, JPEG_BUF, 'accountant-attempt.jpg')
      expect(up.status).toBe(403)
      expect(up.body.error).toBe('forbidden')
      expect(await fileCountForShop(fx.shopA)).toBe(beforeRows)
      expect(await diskFileCountForShop(fx.shopA)).toBe(beforeDisk)

      const { accessToken: advisor } = await tokenA()
      const legit = await uploadFile(api, advisor, JPEG_BUF, 'legit-for-accountant.jpg')
      expect(legit.status).toBe(201)
      const legitBody = legit.body as unknown as UploadResponse
      createdFileIds.push(legitBody.photo.id, legitBody.thumb.id)

      const got = await getFile(api, accountant, legitBody.photo.id)
      expect(got.status).toBe(403)
    })

    it('allows technician on both POST and GET — the matrix grants photos to the person holding the phone', async () => {
      const { accessToken: technician } = await issueTokensFor(fx.userId, fx.shopA, 'technician')

      const up = await uploadFile(api, technician, JPEG_BUF, 'technician-photo.jpg')
      expect(up.status).toBe(201)
      const body = up.body as unknown as UploadResponse
      createdFileIds.push(body.photo.id, body.thumb.id)

      const got = await getFile(api, technician, body.photo.id)
      expect(got.status).toBe(200)
      await expectDecodesAsTinyJpeg(got.buf)
    expect(got.buf.length).toBe(body.photo.bytes)
    })
  })

  // ===========================================================================
  // Security review finding (LOW): sniffing only reads magic bytes, so a file
  // that passes the sniff but cannot actually be decoded (truncated transfer,
  // a polyglot) must not surface as a bare 500.
  // ===========================================================================
  it('rejects a truncated JPEG (valid magic bytes, undecodable body) as unsupported_file_type', async () => {
    const { accessToken: access } = await tokenA()
    const beforeRows = await fileCountForShop(fx.shopA)
    const beforeDisk = await diskFileCountForShop(fx.shopA)

    // Real JPEG magic bytes (passes sniffImageType) but cut off long before
    // the FF D9 end marker or any real scan data — sharp cannot decode this.
    const truncated = JPEG_BUF.subarray(0, 20)
    const up = await uploadFile(api, access, truncated, 'truncated.jpg')
    expect(up.status).toBe(400)
    expect(up.body.error).toBe('unsupported_file_type')

    // Nothing left behind: the original write that happens before the
    // decode attempt gets unlinked in the catch path (routes/files.ts).
    expect(await fileCountForShop(fx.shopA)).toBe(beforeRows)
    expect(await diskFileCountForShop(fx.shopA)).toBe(beforeDisk)
  })
})
