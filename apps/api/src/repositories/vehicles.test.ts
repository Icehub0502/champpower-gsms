/**
 * choosePlateMatch — which car a (plate, province) names. TIER 1, pure.
 *
 * Owner decision (29 Sep 2026): the same plate in two provinces is two cars.
 * Each case below is one branch of that rule; the HTTP behaviour is pinned
 * again end to end in routes/province.integration.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { choosePlateMatch, type VehicleRow } from './vehicles.js'

let n = 0
function car(province: string | null): VehicleRow {
  n += 1
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    customer_id: '00000000-0000-4000-8000-ffffffffffff',
    plate: 'กก 1234', brand: 'Toyota', model: 'Vios', color: null, year: null, province,
  }
}

describe('choosePlateMatch — with a province', () => {
  it('a plate nobody has is a new car', () => {
    expect(choosePlateMatch([], 'ชลบุรี')).toEqual({ kind: 'none' })
  })

  it('the car in that province is the car, even beside cars in other provinces', () => {
    const bkk = car('กรุงเทพมหานคร')
    const cbi = car('ชลบุรี')
    expect(choosePlateMatch([bkk, cbi, car(null)], 'ชลบุรี'))
      .toEqual({ kind: 'one', vehicle: cbi, fillProvince: null })
  })

  it('two rows in the same province are one car recorded twice — the newest (first) wins', () => {
    const newer = car('ชลบุรี')
    const older = car('ชลบุรี')
    expect(choosePlateMatch([newer, older], 'ชลบุรี'))
      .toEqual({ kind: 'one', vehicle: newer, fillProvince: null })
  })

  it('a car on file only in ANOTHER province is a different car — a new one', () => {
    expect(choosePlateMatch([car('กรุงเทพมหานคร')], 'ชลบุรี')).toEqual({ kind: 'none' })
  })

  it('the only car, with no province, is this car and gets the province filled', () => {
    const legacy = car(null)
    expect(choosePlateMatch([legacy], 'ระยอง'))
      .toEqual({ kind: 'one', vehicle: legacy, fillProvince: 'ระยอง' })
  })

  it('an unknown-province car beside one in another province is ambiguous, not filled', () => {
    const legacy = car(null)
    const r = choosePlateMatch([legacy, car('กรุงเทพมหานคร')], 'ระยอง')
    expect(r).toEqual({ kind: 'ambiguous', candidates: [legacy] })
  })

  it('two unknown-province cars are ambiguous — both are offered', () => {
    const a = car(null)
    const b = car(null)
    expect(choosePlateMatch([a, b], 'ระยอง')).toEqual({ kind: 'ambiguous', candidates: [a, b] })
  })

  it('confirmNewVehicle skips the unknown-province cars …', () => {
    expect(choosePlateMatch([car(null), car(null)], 'ระยอง', { confirmNewVehicle: true }))
      .toEqual({ kind: 'none' })
  })

  it('… but never a car already on file in that same province', () => {
    const same = car('ระยอง')
    expect(choosePlateMatch([car(null), same], 'ระยอง', { confirmNewVehicle: true }))
      .toEqual({ kind: 'one', vehicle: same, fillProvince: null })
  })
})

describe('choosePlateMatch — without a province', () => {
  it('a single car is found by plate alone, as before, and nothing is filled', () => {
    const only = car('ชลบุรี')
    expect(choosePlateMatch([only], undefined))
      .toEqual({ kind: 'one', vehicle: only, fillProvince: null })
  })

  it('rows that all agree on one province (here: none) are one car — the newest', () => {
    const newer = car(null)
    expect(choosePlateMatch([newer, car(null)], undefined))
      .toEqual({ kind: 'one', vehicle: newer, fillProvince: null })
  })

  it('cars in more than one province are ambiguous — one candidate per province, newest of each', () => {
    const bkkNew = car('กรุงเทพมหานคร')
    const cbi = car('ชลบุรี')
    const bkkOld = car('กรุงเทพมหานคร')
    const r = choosePlateMatch([bkkNew, cbi, bkkOld], undefined)
    expect(r).toEqual({ kind: 'ambiguous', candidates: [bkkNew, cbi] })
  })

  it('an unknown province counts as a province of its own', () => {
    const cbi = car('ชลบุรี')
    const legacy = car(null)
    expect(choosePlateMatch([cbi, legacy], undefined))
      .toEqual({ kind: 'ambiguous', candidates: [cbi, legacy] })
  })
})
