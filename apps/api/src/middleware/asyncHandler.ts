/**
 * Express 4 does not understand promises.
 *
 * `express: ^4.21.1` calls a handler and ignores what it returns. An async
 * handler that rejects therefore produces an unhandled rejection, which Node 24
 * turns into a fatal error by default — the process dies, and the central error
 * handler in app.ts, which exists precisely to keep stack traces away from the
 * client, never runs. Every async handler must be wrapped.
 *
 * Express 5 fixes this natively. When this project moves, these wrappers can be
 * deleted in one commit and nothing else has to change.
 */
import { Router, type NextFunction, type RequestHandler, type Request, type Response } from 'express'

type AnyHandler = (req: Request, res: Response, next: NextFunction) => unknown

/** Wrap one handler so a rejection reaches Express's error pipeline. */
export function asyncHandler(fn: AnyHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/**
 * A Router whose verb methods wrap every handler they are given.
 *
 * The rule for this codebase: routers that run async work are created with
 * `asyncRouter()`, never with `Router()`. A wrapper applied by hand is a
 * wrapper someone will forget on the next endpoint they add; this way the
 * router itself cannot be used wrongly.
 *
 * Error-handling middleware (arity 4) and mounted sub-routers are passed
 * through untouched — wrapping either would change what Express does with it.
 */
export function asyncRouter(): Router {
  const router = Router()
  const methods = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete'] as const

  for (const method of methods) {
    const original = router[method].bind(router) as (...args: unknown[]) => unknown
    const wrapped = (...args: unknown[]): unknown =>
      original(...args.map((arg) => {
        if (typeof arg !== 'function') return arg
        // Sub-routers are functions too, and carry a layer stack.
        if ('stack' in (arg as object)) return arg
        // Arity 4 means (err, req, res, next): an error handler, not a handler.
        if ((arg as { length: number }).length >= 4) return arg
        return asyncHandler(arg as AnyHandler)
      }))
    // Express's own overloads are far wider than what we call; the cast is
    // confined to this one assignment rather than leaking to every call site.
    ;(router as unknown as Record<string, unknown>)[method] = wrapped
  }

  return router
}
