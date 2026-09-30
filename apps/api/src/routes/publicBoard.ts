/**
 * GET /api/public/board/:token — the waiting-room television. NO LOGIN.
 *
 * Everything about this route assumes the caller is a stranger:
 *
 *   - The shop is named by an unguessable token (shops.public_board_token,
 *     256 bits, migration 0016), never an id or a slug — CLAUDE.md §8 rule 7.
 *     Ids and slugs can be enumerated; a token cannot.
 *   - The token is resolved in `shops` alone, through unscoped(), because
 *     nothing about the caller is known yet. EVERY read after that runs inside
 *     withShop() for the shop the token named, so RLS still bounds it.
 *   - The data comes from repositories/publicBoard.ts, which never touches
 *     `customers` or `queue_board` — see that file for why.
 *   - The response is parsed through PublicBoardResponse, a .strict() schema
 *     written from scratch. If anyone ever adds a field to the projection
 *     below, the parse throws and the request fails with a 500: this screen
 *     fails CLOSED rather than show a stray field to the room.
 *
 * Unknown token -> 404 `{ error: 'not_found' }`. The same body, the same
 * status and the same single lookup for every token that does not resolve,
 * well-formed or not, so the endpoint cannot be used to learn anything about
 * which tokens exist.
 */
import rateLimit from 'express-rate-limit'
import { unscoped, withShop } from '@gsms/db/client.js'
import { PublicBoardResponse } from '@gsms/contracts/index.js'
import { estLabel, estMinutes, statusOf } from '@champpower/domain'
import { db } from '../lib/db.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import * as publicRepo from '../repositories/publicBoard.js'

export const publicBoardRouter = asyncRouter()

/**
 * Never cached, by anyone — and registered FIRST so it covers every response
 * this router can produce: the board, both 404 paths, and the limiter's 429.
 *
 * The body changes minute to minute and is fetched unauthenticated by a TV.
 * A cached copy is at best stale — a car shown in a bay it left an hour ago —
 * and behind a shared proxy it can be ANOTHER request's board. `no-store`
 * forbids keeping it at all, which is the only setting that rules out both.
 */
publicBoardRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})

/**
 * Unauthenticated and it touches the database, so it is limited here, at the
 * router, rather than trusting whoever mounts it to remember. A wall screen
 * refreshing every 15-30 seconds uses a small fraction of this; someone
 * sweeping tokens hits it within a minute.
 */
publicBoardRouter.use(rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
}))

const NOT_FOUND = { error: 'not_found' } as const

/**
 * Tokens are 43 characters. Anything absurdly long is replaced by a value that
 * can never match — NOT refused early — so a malformed token costs the same
 * single indexed lookup as a well-formed unknown one and the two are
 * indistinguishable from outside.
 */
const MAX_TOKEN_LENGTH = 128
const NEVER_MATCHES = '~'

const EST_UNITS = new Set(['minute', 'hour', 'day'])

publicBoardRouter.get('/:token', async (req, res) => {
  const raw = String(req.params.token ?? '')
  const token = raw.length > 0 && raw.length <= MAX_TOKEN_LENGTH ? raw : NEVER_MATCHES

  const shop = await unscoped(db, (trx) => publicRepo.shopByToken(trx, token))
  if (!shop) {
    res.status(404).json(NOT_FOUND)
    return
  }

  const { cars, bays } = await withShop(db, shop.id, async (trx) => ({
    cars: await publicRepo.publicCars(trx),
    bays: await publicRepo.publicBays(trx),
  }))

  const occupied = new Set(
    cars.filter((c) => c.status !== 'delivered' && c.bay_id !== null).map((c) => c.bay_id as string),
  )

  // The projection. Each field is named, and the schema below refuses any
  // field that is not in PublicBoardResponse.
  const payload = {
    shopName: shop.name,
    bays: bays.map((b) => ({ name: b.name, inUse: occupied.has(b.id) })),
    cars: cars.map((c) => {
      const est = {
        estValue: c.est_value ?? undefined,
        estUnit: c.est_unit !== null && EST_UNITS.has(c.est_unit)
          ? (c.est_unit as 'minute' | 'hour' | 'day')
          : undefined,
      }
      return {
        queueNo: c.queue_no,
        plate: c.plate,
        province: c.province,
        brand: c.brand,
        model: c.model,
        color: c.color,
        bayName: c.bay_name,
        status: c.status,
        statusLabel: statusOf(c.status).label,
        estLabel: estLabel(est),
        estMinutes: estMinutes(est),
        repairStartedAt: c.repair_started_at?.toISOString() ?? null,
        repairEndedAt: c.repair_ended_at?.toISOString() ?? null,
        // on_board (migration 0018) drops a delivered car the moment it is
        // delivered, so this is always false; see the contract's note.
        deliveredToday: c.status === 'delivered',
        statusChangedAt: (c.status_changed_at ?? new Date()).toISOString(),
      }
    }),
    generatedAt: new Date().toISOString(),
  }

  res.json(PublicBoardResponse.parse(payload))
})

// Anything else under this mount — including the bare path with no token —
// answers exactly like an unknown token.
publicBoardRouter.use((_req, res) => {
  res.status(404).json(NOT_FOUND)
})
