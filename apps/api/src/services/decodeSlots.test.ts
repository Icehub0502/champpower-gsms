import { describe, expect, it } from 'vitest'
import { DECODE_SLOTS, withDecodeSlot } from './fileStorage.js'

describe('withDecodeSlot', () => {
  it('never runs more than DECODE_SLOTS at once, and finishes every task', async () => {
    let active = 0
    let peak = 0
    const task = async (fail: boolean) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 15))
      active--
      if (fail) throw new Error('boom')
      return 'ok'
    }
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => withDecodeSlot(() => task(i % 3 === 0))),
    )
    expect(peak).toBeLessThanOrEqual(DECODE_SLOTS)
    expect(peak).toBe(DECODE_SLOTS) // it does use the slots it has
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4)
  })

  it('releases the slot when a task throws, so later work is not starved', async () => {
    for (let i = 0; i < DECODE_SLOTS * 3; i++) {
      await expect(withDecodeSlot(async () => { throw new Error('x') })).rejects.toThrow('x')
    }
    await expect(withDecodeSlot(async () => 'still works')).resolves.toBe('still works')
  })
})
