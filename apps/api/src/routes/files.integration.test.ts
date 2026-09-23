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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
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
    expect(body.photo.bytes).toBe(JPEG_BUF.length)
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
    expect(got.buf.equals(JPEG_BUF)).toBe(true)
    expect(got.contentType).toBe('image/jpeg')
    // Private: these are one shop's customer photos, never a shared cache —
    // CLAUDE.md §12.
    expect(got.cacheControl ?? '').toMatch(/^private/)

    const gotThumb = await getFile(api, access, body.thumb.id)
    expect(gotThumb.status).toBe(200)
    expect(gotThumb.buf.length).toBeGreaterThan(0)
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
    expect(got.buf.equals(JPEG_BUF)).toBe(true)
  })

  // ===========================================================================
  // Security review finding (HIGH): requireAuth alone let ANY authenticated
  // role upload and read photos. CLAUDE.md §12.1's "ถ่ายรูป" row names five
  // roles, not seven; §7 rule 13 excludes accountant from photos explicitly.
  // ===========================================================================
  describe('role gate', () => {
    it('refuses viewer on both POST and GET, and leaves no row or file behind', async () => {
      const { accessToken: viewer } = await issueTokensFor(fx.userId, fx.shopA, 'viewer')
      const beforeRows = await fileCountForShop(fx.shopA)
      const beforeDisk = await diskFileCountForShop(fx.shopA)

      const up = await uploadFile(api, viewer, JPEG_BUF, 'viewer-attempt.jpg')
      expect(up.status).toBe(403)
      expect(up.body.error).toBe('forbidden')

      // A 403 that still wrote bytes would be the access-control bug with a
      // nicer status code — the role check runs before multer specifically
      // so this can never be true.
      expect(await fileCountForShop(fx.shopA)).toBe(beforeRows)
      expect(await diskFileCountForShop(fx.shopA)).toBe(beforeDisk)

      // A viewer also cannot read a photo that legitimately exists — upload
      // one as an allowed role first, then try to fetch it as viewer.
      const { accessToken: advisor } = await tokenA()
      const legit = await uploadFile(api, advisor, JPEG_BUF, 'legit.jpg')
      expect(legit.status).toBe(201)
      const legitBody = legit.body as unknown as UploadResponse
      createdFileIds.push(legitBody.photo.id, legitBody.thumb.id)

      const got = await getFile(api, viewer, legitBody.photo.id)
      expect(got.status).toBe(403)
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
      expect(got.buf.equals(JPEG_BUF)).toBe(true)
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
