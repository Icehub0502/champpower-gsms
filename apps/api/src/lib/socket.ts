import type { Server as HttpServer } from 'node:http'
import { Server as SocketIoServer } from 'socket.io'
import { accessExpiresAtMs, verifyAccess } from './jwt.js'
import { db } from './db.js'

let io: SocketIoServer | undefined

/**
 * Realtime, scoped to one shop.
 *
 * The old version joined every authenticated client to a single `authed` room.
 * With one shop that was harmless; with six it means a job created at Samut
 * Prakan pops up on a screen in Don Mueang, carrying a customer's name and
 * plate. Rooms are therefore per shop — `authed:<shopId>` — and the shop comes
 * from the signed token, never from anything the client sends.
 *
 * `public:<shopId>` is for the customer-facing board and lookup pages. It
 * carries refetch signals and nothing else: `emitPublic` takes no payload
 * parameter at all, so there is no way to put a row on it by accident.
 */
export function initSocket(server: HttpServer): SocketIoServer {
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS is not set; refusing to open a socket to any origin')
  }

  io = new SocketIoServer(server, { cors: { origin: origins, credentials: true } })

  io.on('connection', (socket) => {
    const token = socket.handshake.auth?.token as string | undefined
    if (token) {
      try {
        const { shop } = verifyAccess(token)
        socket.join(`authed:${shop}`)
        socket.join(`public:${shop}`)
        socket.data.shopId = shop

        /**
         * A socket used to be authenticated once and then trusted forever: one
         * opened at nine in the morning was still receiving that shop's data at
         * five in the afternoon, long after the access token behind it had
         * expired and possibly after the session was revoked. The connection now
         * ends when the token it was opened with does, and the client
         * reconnects with a fresh one.
         */
        const expiresAt = accessExpiresAtMs(token)
        if (expiresAt !== null) {
          const ms = Math.max(0, expiresAt - Date.now())
          const timer = setTimeout(() => socket.disconnect(true), ms)
          // Do not hold the process open for a socket's expiry alone.
          timer.unref?.()
          socket.on('disconnect', () => clearTimeout(timer))
        } else {
          socket.disconnect(true)
        }
        return
      } catch {
        // Expired or forged: fall through to the public room only.
      }
    }

    /**
     * An unauthenticated client watching a customer-facing board names the shop
     * by SLUG, which the server resolves. It used to name the shop id directly
     * and join that room unchecked — a client choosing its own tenant, exactly
     * what §8 rule 2 forbids. A slug is not a secret, but unlike an id it is not
     * enumerable, and an unknown one now joins nothing at all.
     */
    const slug = socket.handshake.auth?.shopSlug as string | undefined
    if (typeof slug !== 'string' || slug.length === 0 || slug.length > 64) return

    // socket.io's connection callback is synchronous, so the await lives in its
    // own async function rather than a .then() chain (CLAUDE.md §9).
    void (async () => {
      try {
        const shop = await db
          .selectFrom('shops')
          .select(['id'])
          .where('slug', '=', slug)
          .executeTakeFirst()
        if (shop && socket.connected) socket.join(`public:${shop.id}`)
      } catch {
        // A lookup failure must not take the process down; the board simply
        // polls instead of being pushed to.
      }
    })()
  })

  return io
}

export function getIo(): SocketIoServer {
  if (!io) throw new Error('socket.io not initialized')
  return io
}

/** Staff screens of one shop. Never call this without a shop id. */
export function emitAuthed(shopId: string, event: string, payload: unknown): void {
  io?.to(`authed:${shopId}`).emit(event, payload)
}

/**
 * Customer-facing screens of one shop. A signal to refetch, never a row.
 *
 * There is no payload parameter on purpose: the public room has no
 * authentication behind it, so the type system is what guarantees that nothing
 * personal can be put on it. Saying so in a comment was not enough.
 */
export function emitPublic(shopId: string, event: string): void {
  io?.to(`public:${shopId}`).emit(event)
}
