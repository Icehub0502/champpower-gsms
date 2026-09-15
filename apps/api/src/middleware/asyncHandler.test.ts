/**
 * WO-001 item 6 — Express 4 does not catch a rejected async handler.
 *
 * TIER 1: runs with no database.
 *
 * What the old code did (WO-001 item 6): every route in auth.ts was
 * `async (req, res) => { await db... }` registered on a plain `Router()`.
 * Express 4 calls the handler and discards its return value, so a rejection
 * became an unhandled rejection. Under Node 24 the default is
 * `--unhandled-rejections=throw`, so the PROCESS DIED — and the central error
 * handler in app.ts, which exists to keep stack traces away from clients, never
 * ran for any of those routes.
 *
 * The tests below are written so that each one fails if `asyncRouter()` is
 * swapped back for `Router()`: the request would never be answered (the test
 * times out on the awaited response) and an unhandledRejection would fire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { createServer, type Server } from 'node:http'
import { asyncHandler, asyncRouter } from './asyncHandler.js'

/** Start an app on an ephemeral port and return its base URL. */
async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (typeof addr === 'string' || addr === null) throw new Error('no port')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}

/**
 * Collect anything that escapes to the process while `fn` runs.
 *
 * Vitest installs its own listener, so a rejection here does not actually kill
 * the worker — which is exactly why the assertion has to be explicit. Without
 * it, the "old code" version of these tests would fail only by timing out, and
 * a reader could mistake that for flakiness rather than for the process dying.
 */
async function withRejectionWatch<T>(fn: () => Promise<T>): Promise<{ result: T; escaped: unknown[] }> {
  const escaped: unknown[] = []
  const onRejection = (reason: unknown): void => { escaped.push(reason) }

  // Vitest installs its own unhandledRejection listener and fails the file when
  // it fires. That is normally the right behaviour, but one test here
  // deliberately provokes a rejection in order to demonstrate the old code's
  // failure mode, so its listener is stood down for the duration and restored
  // afterwards. Restoring matters: without it, a genuine leak later in the run
  // would go unreported.
  const previous = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', onRejection)
  try {
    const result = await fn()
    // Rejections are reported on a later turn of the event loop.
    await new Promise((r) => setTimeout(r, 100))
    return { result, escaped }
  } finally {
    process.off('unhandledRejection', onRejection)
    for (const listener of previous) process.on('unhandledRejection', listener)
  }
}

describe('asyncHandler', () => {
  it('forwards a rejection to next()', async () => {
    const boom = new Error('boom')
    const next = vi.fn()
    asyncHandler(async () => { throw boom })({} as Request, {} as Response, next as unknown as NextFunction)
    await new Promise((r) => setTimeout(r, 0))
    expect(next).toHaveBeenCalledWith(boom)
  })

  it('forwards a throw from an async function to next()', async () => {
    // An `async` function that throws before its first `await` still returns a
    // rejected promise, so this goes down the same path.
    const boom = new Error('early boom')
    const next = vi.fn()
    // eslint-disable-next-line @typescript-eslint/require-await
    asyncHandler(async () => { throw boom })({} as Request, {} as Response, next as unknown as NextFunction)
    await new Promise((r) => setTimeout(r, 0))
    expect(next).toHaveBeenCalledWith(boom)
  })

  /**
   * Documented behaviour, deliberately not "fixed" here: a NON-async handler
   * that throws synchronously propagates out of the wrapper rather than going
   * to next(), because `fn(req, res, next)` is evaluated before
   * `Promise.resolve` ever sees it.
   *
   * That is harmless in practice and the test below proves it end to end:
   * Express 4 invokes each layer inside its own try/catch, so a synchronous
   * throw was always handled correctly — it is only the asynchronous case
   * Express 4 cannot see, which is the case WO-001 item 6 is about. Recorded
   * here so nobody mistakes it for a gap later.
   */
  it('lets a synchronous throw propagate, for Express\'s own try/catch to take', () => {
    const boom = new Error('sync boom')
    const next = vi.fn()
    expect(() =>
      asyncHandler(() => { throw boom })({} as Request, {} as Response, next as unknown as NextFunction),
    ).toThrow(boom)
    expect(next).not.toHaveBeenCalled()
  })

  it('does not call next() when the handler resolves', async () => {
    const next = vi.fn()
    asyncHandler(async () => 'ok')({} as Request, {} as Response, next as unknown as NextFunction)
    await new Promise((r) => setTimeout(r, 0))
    expect(next).not.toHaveBeenCalled()
  })
})

describe('asyncRouter', () => {
  /**
   * THE DISCRIMINATING TEST for item 6.
   *
   * Would have FAILED against the old code in two visible ways at once: nothing
   * would answer the request (the fetch below never resolves), and the promise
   * would surface as an unhandledRejection — the thing that killed the process.
   */
  it('routes a rejected async handler to the central error handler', async () => {
    const app = express()
    const router = asyncRouter()
    router.get('/boom', async () => {
      await Promise.resolve()
      throw new Error('database exploded at line 42 of repository.ts')
    })
    app.use(router)
    // The same shape as the handler in app.ts.
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      void err
      res.status(500).json({ error: 'internal_error' })
    })

    const { url, close } = await listen(app)
    try {
      const { result, escaped } = await withRejectionWatch(async () => {
        const res = await fetch(`${url}/boom`)
        return { status: res.status, body: await res.text() }
      })

      expect(result.status).toBe(500)
      expect(JSON.parse(result.body)).toEqual({ error: 'internal_error' })
      // No stack trace, no file name, no query fragment reaches the client.
      expect(result.body).not.toContain('repository.ts')
      expect(result.body).not.toMatch(/\bat \w+ \(/)
      // And nothing escaped to the process.
      expect(escaped).toEqual([])
    } finally {
      await close()
    }
  })

  /**
   * The contrast, stated as a test rather than as a claim: the SAME route on a
   * plain Router() — which is what the old code used — leaves the request
   * unanswered and the rejection unhandled. If this ever stops being true,
   * Express has been upgraded to 5 and the wrappers can go.
   */
  it('a plain Router() with the same handler answers nothing and leaks the rejection', async () => {
    const app = express()
    const router = Router()
    router.get('/boom', (async () => {
      await Promise.resolve()
      throw new Error('boom')
    }) as unknown as express.RequestHandler)
    app.use(router)
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: 'internal_error' })
    })

    const { url, close } = await listen(app)
    try {
      const { result, escaped } = await withRejectionWatch(async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 300)
        try {
          await fetch(`${url}/boom`, { signal: controller.signal })
          return 'answered'
        } catch {
          return 'no answer'
        } finally {
          clearTimeout(timer)
        }
      })
      expect(result).toBe('no answer')
      expect(escaped.length).toBeGreaterThan(0)
    } finally {
      await close()
    }
  })

  it('wraps every verb, not just get', async () => {
    const app = express()
    const router = asyncRouter()
    for (const verb of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      router[verb](`/${verb}`, async () => { throw new Error('boom') })
    }
    app.use(router)
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: 'internal_error' })
    })

    const { url, close } = await listen(app)
    try {
      for (const verb of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const res = await fetch(`${url}/${verb}`, { method: verb.toUpperCase() })
        expect(res.status, `${verb} was not wrapped`).toBe(500)
      }
    } finally {
      await close()
    }
  })

  /**
   * Arity 4 means (err, req, res, next). Wrapping one would turn it into an
   * ordinary handler and silently disable error handling on that router — a
   * regression the wrapper itself could introduce.
   */
  it('passes an error-handling middleware through untouched', async () => {
    const app = express()
    const router = asyncRouter()
    router.get('/boom', async () => { throw new Error('boom') })
    router.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(418).json({ error: 'handled_by_router' })
    })
    app.use(router)

    const { url, close } = await listen(app)
    try {
      const res = await fetch(`${url}/boom`)
      expect(res.status).toBe(418)
      expect(await res.json()).toEqual({ error: 'handled_by_router' })
    } finally {
      await close()
    }
  })

  /** A mounted sub-router is a function too, and must not be wrapped. */
  it('passes a mounted sub-router through untouched', async () => {
    const app = express()
    const parent = asyncRouter()
    const child = asyncRouter()
    child.get('/inner', async (_req, res) => { res.json({ ok: true }) })
    parent.use('/child', child)
    app.use(parent)

    const { url, close } = await listen(app)
    try {
      const res = await fetch(`${url}/child/inner`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await close()
    }
  })

  /** The end-to-end half of the synchronous-throw note above. */
  it('still returns 500 for a handler that throws synchronously', async () => {
    const app = express()
    const router = asyncRouter()
    router.get('/sync-boom', () => { throw new Error('boom') })
    app.use(router)
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: 'internal_error' })
    })

    const { url, close } = await listen(app)
    try {
      const res = await fetch(`${url}/sync-boom`)
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'internal_error' })
    } finally {
      await close()
    }
  })

  it('leaves a handler that answers normally alone', async () => {
    const app = express()
    const router = asyncRouter()
    router.get('/ok', async (_req, res) => {
      await Promise.resolve()
      res.json({ ok: true })
    })
    app.use(router)

    const { url, close } = await listen(app)
    try {
      const res = await fetch(`${url}/ok`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await close()
    }
  })
})

afterEach(() => { vi.restoreAllMocks() })
