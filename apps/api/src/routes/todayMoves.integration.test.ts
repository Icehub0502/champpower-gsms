/**
 * `allowedMoves` on every /today card — decided on the server, for the caller.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * Why this field exists: stepping back from `ready` goes to `repairing` or
 * `aligning` depending on whether the car was actually aligned (alignment is
 * optional — DECISION-7-today.md §7), and only the job's history knows which. The
 * card did not carry history, so the screen had to guess or hide the action.
 * Now the server computes each card's moves from the transition table plus the
 * real history, filtered by the same role rule PATCH enforces — so the board can
 * never offer a move the server then refuses.
 *
 * Setup writes status and history directly (see seedPath) and only the request
 * under test goes through the API, so this file stays well inside the intake
 * write limiter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, get, issueTokensFor, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface Card { jobId: string; status: string; allowedMoves: string[] }
interface TodayBody { jobs: Card[] }

describe.skipIf(!hasDatabase)(tier2('allowedMoves on /api/jobs/today'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo006mv')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const tokenAs = async (role: Parameters<typeof issueTokensFor>[2]) =>
    (await issueTokensFor(fx.userId, fx.shopA, role)).accessToken

  // Ordinary plates: matching is not what this test is about.
  async function openJob(plate: string): Promise<string> {
    const res = await post<{ jobId: string }>(api, '/api/checkin', {
      plate, customerName: 'ทดสอบ', brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร',
    }, await tokenAs('owner'))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.jobId
  }

  /** Put the job at the last status, with history rows for every step. */
  async function seedPath(jobId: string, statuses: string[]) {
    const last = statuses[statuses.length - 1]!
    const start = Date.now() - 60_000 - statuses.length * 1000
    await withShop(db, fx.shopA, async (trx) => {
      await trx.updateTable('jobs').set({ status: last }).where('id', '=', jobId).execute()
      await trx.insertInto('job_status_history').values(statuses.map((status, i) => ({
        shop_id: fx.shopA, job_id: jobId, status, changed_at: new Date(start + i * 1000),
      }))).execute()
    })
  }

  async function movesFor(jobId: string, role: Parameters<typeof issueTokensFor>[2]): Promise<string[]> {
    const res = await get<TodayBody>(api, '/api/jobs/today', await tokenAs(role))
    expect(res.status).toBe(200)
    const card = res.body.jobs.find((j) => j.jobId === jobId)
    expect(card, 'the job was not on the board').toBeDefined()
    return card!.allowedMoves.slice().sort()
  }

  it('a car that skipped alignment is offered back-to-repairing, not aligning', async () => {
    const jobId = await openJob('ปป 1234')
    await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
    expect(await movesFor(jobId, 'owner')).toEqual(['delivered', 'repairing'])
  })

  it('a car that WAS aligned is offered back-to-aligning, not repairing', async () => {
    const jobId = await openJob('ปป 2345')
    await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'aligning', 'ready'])
    expect(await movesFor(jobId, 'owner')).toEqual(['aligning', 'delivered'])
  })

  it('the offered back-step is one the server accepts, and the other one is refused', async () => {
    // The point of the field: what the board offers, PATCH allows.
    const jobId = await openJob('ปป 3456')
    await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
    const owner = await tokenAs('owner')
    const patch = (to: string) => fetch(`${api.url}/api/jobs/${jobId}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
      body: JSON.stringify({ to, fromStatus: 'ready' }),
    })
    expect((await patch('aligning')).status, 'a move NOT offered was accepted').toBe(409)
    expect((await patch('repairing')).status, 'the offered move was refused').toBe(200)
  })

  it('a technician is never offered the quote decision; nobody is offered carout once quoted', async () => {
    const jobId = await openJob('ปป 4567')
    await seedPath(jobId, ['inspecting', 'quoted'])
    // The counter sees the customer's decisions — and no carout (DECISION-carout.md)...
    expect(await movesFor(jobId, 'owner')).toEqual(['approved', 'inspecting', 'rejected'])
    // ...the technician sees only the step back.
    expect(await movesFor(jobId, 'technician')).toEqual(['inspecting'])
  })

  it('a technician on an approved job is not offered to take it back to quoted; nobody is offered carout', async () => {
    const jobId = await openJob('ปป 5678')
    await seedPath(jobId, ['inspecting', 'quoted', 'approved'])
    expect(await movesFor(jobId, 'owner')).toEqual(['quoted', 'repairing'])
    expect(await movesFor(jobId, 'technician')).toEqual(['repairing'])
  })

  it('nobody is offered carout mid-repair — this shop has none (DECISION-carout.md)', async () => {
    const jobId = await openJob('ปป 6789')
    await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing'])
    expect(await movesFor(jobId, 'owner')).toEqual(['aligning', 'approved', 'ready'])
    expect(await movesFor(jobId, 'technician')).toEqual(['aligning', 'approved', 'ready'])
  })

  it('carout is offered before a quote exists — to the counter and the technician alike', async () => {
    const received = await openJob('ปป 6790')
    expect(await movesFor(received, 'advisor')).toEqual(['carout', 'inspecting'])
    expect(await movesFor(received, 'technician')).toEqual(['carout', 'inspecting'])

    const inspecting = await openJob('ปป 6791')
    await seedPath(inspecting, ['inspecting'])
    expect(await movesFor(inspecting, 'advisor')).toEqual(['carout', 'quoted', 'received'])
    expect(await movesFor(inspecting, 'technician')).toEqual(['carout', 'quoted', 'received'])
  })

  it('a technician is offered delivered, as before — only the quote decision is barred', async () => {
    const jobId = await openJob('ปป 6792')
    await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
    expect(await movesFor(jobId, 'advisor')).toEqual(['delivered', 'repairing'])
    expect(await movesFor(jobId, 'technician')).toEqual(['delivered', 'repairing'])
  })

  it('no card on /today needs a reason — the only such move starts from delivered, which is off the board', async () => {
    const jobId = await openJob('ปป 6793')
    await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
    const res = await get<{ jobs: (Card & { movesNeedingReason?: string[] })[] }>(
      api, '/api/jobs/today', await tokenAs('owner'))
    const card = res.body.jobs.find((j) => j.jobId === jobId)
    expect(card?.movesNeedingReason).toEqual([])
  })

  it('roles that cannot move jobs see the board with no moves at all', async () => {
    const jobId = await openJob('ปป 7890')
    expect(await movesFor(jobId, 'viewer')).toEqual([])
    expect(await movesFor(jobId, 'accountant')).toEqual([])
  })
})
