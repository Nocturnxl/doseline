import { describe, expect, it } from 'vitest'
import { checkSafety } from './safety'
import { med, taken } from './testkit'

const NY = 'America/New_York'

describe('safety checks', () => {
  const prn = med({ type: 'prn', minIntervalHours: 4, maxPer24h: 3, notifyWhenAvailable: false }, { name: 'Ibuprofen' })

  it('no warnings for a first PRN dose', () => {
    expect(checkSafety(prn, [], new Date('2026-05-04T12:00:00Z'), NY)).toEqual([])
  })

  it('warns when a PRN dose is logged before its minimum interval', () => {
    const logs = [taken(prn.id, '2026-05-04T10:00:00Z')]
    const w = checkSafety(prn, logs, new Date('2026-05-04T12:00:00Z'), NY)
    expect(w.map((x) => x.code)).toEqual(['prn-too-soon'])
  })

  it('no warning exactly at the minimum interval', () => {
    const logs = [taken(prn.id, '2026-05-04T08:00:00Z')]
    expect(checkSafety(prn, logs, new Date('2026-05-04T12:00:00Z'), NY)).toEqual([])
  })

  it('warns when the max doses per 24h would be exceeded', () => {
    const logs = [taken(prn.id, '2026-05-03T14:00:00Z'), taken(prn.id, '2026-05-03T20:00:00Z'), taken(prn.id, '2026-05-04T02:00:00Z')]
    const w = checkSafety(prn, logs, new Date('2026-05-04T08:00:00Z'), NY)
    expect(w.map((x) => x.code)).toEqual(['prn-max-24h'])
    // Once the oldest dose is > 24h old the cap no longer applies.
    expect(checkSafety(prn, logs, new Date('2026-05-04T14:00:01Z'), NY)).toEqual([])
  })

  it('warns about a likely duplicate for any schedule type', () => {
    const daily = med({ type: 'fixed', times: ['08:00'], days: [1, 2, 3, 4, 5, 6, 7] })
    const logs = [taken(daily.id, '2026-05-04T12:00:00Z')]
    expect(checkSafety(daily, logs, new Date('2026-05-04T12:10:00Z'), NY).map((x) => x.code)).toEqual(['duplicate'])
    expect(checkSafety(daily, logs, new Date('2026-05-04T13:00:00Z'), NY)).toEqual([])
  })

  it('can exclude the log being edited', () => {
    const daily = med({ type: 'fixed', times: ['08:00'], days: [1, 2, 3, 4, 5, 6, 7] })
    const l = taken(daily.id, '2026-05-04T12:00:00Z')
    expect(checkSafety(daily, [l], new Date('2026-05-04T12:05:00Z'), NY, l.id)).toEqual([])
  })
})
