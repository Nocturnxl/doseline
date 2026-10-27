import { describe, expect, it } from 'vitest'
import { assignScheduledFor, computeNextDue, describeSchedule, fixedSlotsBetween, isActiveAt, pendingStatus, periodProgress, prnAvailableAt } from './schedule'
import type { FixedSchedule } from './types'
import { med, skipped, taken } from './testkit'

const NY = 'America/New_York'
const LON = 'Europe/London'
const daily = (times: string[]): FixedSchedule => ({ type: 'fixed', times, days: [1, 2, 3, 4, 5, 6, 7] })
const at = (s: string) => new Date(s)

describe('interval schedules', () => {
  const m = med({ type: 'interval', everyHours: 8, firstDoseAt: '2026-05-01T12:00:00Z' })

  it('first dose is due at firstDoseAt when nothing is logged', () => {
    expect(computeNextDue(m, [], at('2026-05-01T10:00:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-01T12:00:00.000Z')
  })

  it('next dose is N hours after the last taken dose', () => {
    const logs = [taken(m.id, '2026-05-01T12:30:00Z', '2026-05-01T12:00:00Z')]
    const n = computeNextDue(m, logs, at('2026-05-01T13:00:00Z'), NY)!
    expect(n.dueAt.toISOString()).toBe('2026-05-01T20:30:00.000Z')
    expect(n.periodStart.toISOString()).toBe('2026-05-01T12:30:00.000Z')
  })

  it('logging early or late re-anchors the schedule', () => {
    const early = [taken(m.id, '2026-05-01T11:00:00Z')]
    expect(computeNextDue(m, early, at('2026-05-01T11:01:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-01T19:00:00.000Z')
  })

  it('a skip advances from the skipped slot, not from when it was skipped', () => {
    const logs = [skipped(m.id, '2026-05-01T14:00:00Z', '2026-05-01T12:00:00Z')]
    expect(computeNextDue(m, logs, at('2026-05-01T14:00:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-01T20:00:00.000Z')
  })

  it('uses the latest log regardless of input order', () => {
    const logs = [taken(m.id, '2026-05-02T04:00:00Z'), taken(m.id, '2026-05-01T20:00:00Z')]
    expect(computeNextDue(m, logs, at('2026-05-02T05:00:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-02T12:00:00.000Z')
  })

  it('ignores logs of other medications', () => {
    const logs = [taken('other', '2026-05-01T12:00:00Z')]
    expect(computeNextDue(m, logs, at('2026-05-01T12:30:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-01T12:00:00.000Z')
  })

  it('is measured in absolute hours across the spring-forward DST change', () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT. Dose at 00:00 EST (05:00Z) + 8h = 13:00Z = 09:00 EDT.
    const logs = [taken(m.id, '2026-03-08T05:00:00Z')]
    const due = computeNextDue(m, logs, at('2026-03-08T06:00:00Z'), NY)!.dueAt
    expect(due.toISOString()).toBe('2026-03-08T13:00:00.000Z')
    expect(due.toLocaleTimeString('en-US', { timeZone: NY, hour: '2-digit', minute: '2-digit', hour12: false })).toBe('09:00')
  })

  it('is measured in absolute hours across the fall-back DST change', () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST. 00:00 EDT (04:00Z) + 8h = 12:00Z = 07:00 EST.
    const logs = [taken(m.id, '2026-11-01T04:00:00Z')]
    const due = computeNextDue(m, logs, at('2026-11-01T05:00:00Z'), NY)!.dueAt
    expect(due.toISOString()).toBe('2026-11-01T12:00:00.000Z')
  })

  it('paused meds have no next dose', () => {
    expect(computeNextDue({ ...m, active: false }, [], at('2026-05-01T10:00:00Z'), NY)).toBeNull()
  })

  it('returns null once past the end date', () => {
    const ended = { ...m, endDate: '2026-05-01' }
    const logs = [taken(m.id, '2026-05-01T22:00:00Z')] // 18:00 NY -> next 02:00 NY on May 2
    expect(computeNextDue(ended, logs, at('2026-05-01T22:30:00Z'), NY)).toBeNull()
  })

  it('a future start date delays the first dose', () => {
    const later = { ...m, startDate: '2026-06-01', schedule: { type: 'interval' as const, everyHours: 8, firstDoseAt: '2026-05-01T12:00:00Z' } }
    expect(computeNextDue(later, [], at('2026-05-01T10:00:00Z'), NY)!.dueAt.toISOString()).toBe('2026-06-01T04:00:00.000Z')
  })
})

describe('fixed-time schedules', () => {
  const m = med(daily(['08:00', '20:00']), { createdAt: '2026-05-01T00:00:00Z' })

  it('next dose is the next slot after now', () => {
    // 07:00 NY (11:00Z) -> 08:00 NY (12:00Z). Created just now, so last night's slot isn't pending.
    const fresh = { ...m, createdAt: '2026-05-04T10:00:00Z' }
    expect(computeNextDue(fresh, [], at('2026-05-04T11:00:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-04T12:00:00.000Z')
  })

  it('an unlogged slot stays pending (overdue) until the next slot arrives', () => {
    // 09:30 NY: the 08:00 slot is overdue
    const n = computeNextDue(m, [], at('2026-05-04T13:30:00Z'), NY)!
    expect(n.dueAt.toISOString()).toBe('2026-05-04T12:00:00.000Z')
    expect(pendingStatus(n.dueAt, at('2026-05-04T13:30:00Z'), 60)).toBe('overdue')
    // 20:30 NY: 08:00 is superseded by 20:00
    expect(computeNextDue(m, [], at('2026-05-05T00:30:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-05T00:00:00.000Z')
  })

  it('after logging the pending slot, the next slot is due', () => {
    const logs = [taken(m.id, '2026-05-04T12:10:00Z', '2026-05-04T12:00:00Z')]
    expect(computeNextDue(m, logs, at('2026-05-04T12:11:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-05T00:00:00.000Z')
  })

  it('logging a dose early moves the schedule past that slot', () => {
    // At 07:30 NY, take the 08:00 dose.
    const slot = assignScheduledFor(m, [], at('2026-05-04T11:30:00Z'), NY)!
    expect(slot.toISOString()).toBe('2026-05-04T12:00:00.000Z')
    const logs = [taken(m.id, '2026-05-04T11:30:00Z', slot.toISOString())]
    expect(computeNextDue(m, logs, at('2026-05-04T11:31:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-05T00:00:00.000Z')
  })

  it('a skip handles the slot without counting as taken', () => {
    const logs = [skipped(m.id, '2026-05-04T12:05:00Z', '2026-05-04T12:00:00Z')]
    expect(computeNextDue(m, logs, at('2026-05-04T12:06:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-05T00:00:00.000Z')
  })

  it('respects chosen weekdays', () => {
    const mwf = med({ type: 'fixed', times: ['09:00'], days: [1, 3, 5] }, { createdAt: '2026-05-01T00:00:00Z' })
    // Tue 2026-05-05 10:00 NY -> Wed 09:00 NY
    expect(computeNextDue(mwf, [], at('2026-05-05T14:00:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-06T13:00:00.000Z')
    // Fri after 09:00 -> Mon
    const n = computeNextDue(mwf, [taken(mwf.id, '2026-05-08T13:00:00Z', '2026-05-08T13:00:00Z')], at('2026-05-08T14:00:00Z'), NY)!
    expect(n.dueAt.toISOString()).toBe('2026-05-11T13:00:00.000Z')
  })

  it('slots before the med was created are not pending', () => {
    const fresh = { ...m, createdAt: '2026-05-04T13:00:00Z' } // created 09:00 NY, after the 08:00 slot
    expect(computeNextDue(fresh, [], at('2026-05-04T13:30:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-05T00:00:00.000Z')
  })

  it('skips slots inside a pause and stays quiet while paused', () => {
    const paused = { ...m, pauses: [{ from: '2026-05-04T00:00:00Z', to: '2026-05-06T00:00:00Z' }] }
    expect(isActiveAt(paused, at('2026-05-05T12:00:00Z'), NY)).toBe(false)
    // Pause ends 2026-05-06T00:00Z = 20:00 NY on May 5, which is a slot.
    expect(computeNextDue(paused, [], at('2026-05-04T11:00:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-06T00:00:00.000Z')
  })

  it('follows the wall clock across spring-forward', () => {
    const slots = fixedSlotsBetween(daily(['08:00']), at('2026-03-07T00:00:00Z'), at('2026-03-10T00:00:00Z'), NY)
    expect(slots.map((d) => d.toISOString())).toEqual(['2026-03-07T13:00:00.000Z', '2026-03-08T12:00:00.000Z', '2026-03-09T12:00:00.000Z'])
  })

  it('a slot in the spring-forward gap moves to the first valid instant', () => {
    const slots = fixedSlotsBetween(daily(['02:30']), at('2026-03-08T00:00:00Z'), at('2026-03-09T00:00:00Z'), NY)
    expect(slots).toHaveLength(1)
    expect(slots[0]!.toISOString()).toBe('2026-03-08T07:30:00.000Z') // 03:30 EDT
  })

  it('an ambiguous slot on fall-back day fires exactly once', () => {
    const slots = fixedSlotsBetween(daily(['01:30']), at('2026-11-01T00:00:00Z'), at('2026-11-02T00:00:00Z'), NY)
    expect(slots).toHaveLength(1)
    expect(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']).toContain(slots[0]!.toISOString())
  })

  it('follows the wall clock across fall-back', () => {
    const slots = fixedSlotsBetween(daily(['08:00']), at('2026-10-31T00:00:00Z'), at('2026-11-03T00:00:00Z'), NY)
    expect(slots.map((d) => d.toISOString())).toEqual(['2026-10-31T12:00:00.000Z', '2026-11-01T13:00:00.000Z', '2026-11-02T13:00:00.000Z'])
  })

  it('handles EU DST dates independently of US ones', () => {
    // UK springs forward 2026-03-29.
    const slots = fixedSlotsBetween(daily(['08:00']), at('2026-03-28T00:00:00Z'), at('2026-03-30T00:00:00Z'), LON)
    expect(slots.map((d) => d.toISOString())).toEqual(['2026-03-28T08:00:00.000Z', '2026-03-29T07:00:00.000Z'])
  })

  it('re-evaluates wall-clock times when the time zone changes', () => {
    const now = at('2026-05-04T06:00:00Z')
    const m2 = { ...m, createdAt: now.toISOString() }
    expect(computeNextDue(m2, [], now, LON)!.dueAt.toISOString()).toBe('2026-05-04T07:00:00.000Z') // 08:00 BST
    expect(computeNextDue(m2, [], now, NY)!.dueAt.toISOString()).toBe('2026-05-04T12:00:00.000Z') // 08:00 EDT
    expect(computeNextDue(m2, [], now, 'Asia/Tokyo')!.dueAt.toISOString()).toBe('2026-05-04T11:00:00.000Z') // 20:00 JST
  })

  it('handled slots from before a zone change are not repeated', () => {
    // Took 08:00 London dose, then flew to New York the same day.
    const logs = [taken(m.id, '2026-05-04T07:00:00Z', '2026-05-04T07:00:00Z')]
    const n = computeNextDue(m, logs, at('2026-05-04T11:00:00Z'), NY)! // 07:00 NY
    expect(n.dueAt.toISOString()).toBe('2026-05-04T12:00:00.000Z') // 08:00 NY is a new slot
  })
})

describe('assignScheduledFor', () => {
  const m = med(daily(['08:00', '20:00']), { createdAt: '2026-05-01T00:00:00Z' })

  it('picks the nearest unhandled slot for a backdated dose', () => {
    const slot = assignScheduledFor(m, [], at('2026-05-04T12:20:00Z'), NY)!
    expect(slot.toISOString()).toBe('2026-05-04T12:00:00.000Z')
  })

  it('skips slots that are already handled', () => {
    const logs = [taken(m.id, '2026-05-04T12:00:00Z', '2026-05-04T12:00:00Z')]
    const slot = assignScheduledFor(m, logs, at('2026-05-04T12:20:00Z'), NY)!
    expect(slot.toISOString()).toBe('2026-05-05T00:00:00.000Z')
  })

  it('returns null for PRN', () => {
    const prn = med({ type: 'prn', minIntervalHours: 4, notifyWhenAvailable: false })
    expect(assignScheduledFor(prn, [], at('2026-05-04T12:20:00Z'), NY)).toBeNull()
  })

  it('for interval meds, uses the dose that was due before the log', () => {
    const iv = med({ type: 'interval', everyHours: 6, firstDoseAt: '2026-05-04T06:00:00Z' })
    const logs = [taken(iv.id, '2026-05-04T06:00:00Z', '2026-05-04T06:00:00Z')]
    expect(assignScheduledFor(iv, logs, at('2026-05-04T12:30:00Z'), NY)!.toISOString()).toBe('2026-05-04T12:00:00.000Z')
  })
})

describe('PRN rules', () => {
  const prn = med({ type: 'prn', minIntervalHours: 4, maxPer24h: 3, notifyWhenAvailable: true })

  it('is available immediately when never taken', () => {
    expect(prnAvailableAt(prn.schedule as never, [])).toBeNull()
    expect(computeNextDue(prn, [], at('2026-05-04T12:00:00Z'), NY)).toBeNull()
  })

  it('becomes available after the minimum interval', () => {
    const logs = [taken(prn.id, '2026-05-04T10:00:00Z')]
    const n = computeNextDue(prn, logs, at('2026-05-04T11:00:00Z'), NY)!
    expect(n.kind).toBe('available')
    expect(n.dueAt.toISOString()).toBe('2026-05-04T14:00:00.000Z')
  })

  it('applies the rolling 24h cap', () => {
    const logs = [taken(prn.id, '2026-05-04T00:00:00Z'), taken(prn.id, '2026-05-04T05:00:00Z'), taken(prn.id, '2026-05-04T10:00:00Z')]
    // min interval would allow 14:00Z, but 3 doses in 24h: next once the 00:00Z dose drops out.
    expect(computeNextDue(prn, logs, at('2026-05-04T11:00:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-05T00:00:00.000Z')
  })

  it('ignores skips', () => {
    const logs = [taken(prn.id, '2026-05-04T10:00:00Z'), { ...taken(prn.id, '2026-05-04T13:00:00Z'), kind: 'skipped' as const }]
    expect(computeNextDue(prn, logs, at('2026-05-04T13:30:00Z'), NY)!.dueAt.toISOString()).toBe('2026-05-04T14:00:00.000Z')
  })
})

describe('helpers', () => {
  it('periodProgress is clamped to [0,1]', () => {
    const n = { dueAt: at('2026-05-04T12:00:00Z'), periodStart: at('2026-05-04T08:00:00Z'), kind: 'scheduled' as const }
    expect(periodProgress(n, at('2026-05-04T10:00:00Z'))).toBeCloseTo(0.5)
    expect(periodProgress(n, at('2026-05-04T13:00:00Z'))).toBe(1)
    expect(periodProgress(n, at('2026-05-04T07:00:00Z'))).toBe(0)
  })

  it('pendingStatus honours the grace window', () => {
    const due = at('2026-05-04T12:00:00Z')
    expect(pendingStatus(due, at('2026-05-04T11:59:00Z'), 60)).toBe('upcoming')
    expect(pendingStatus(due, at('2026-05-04T12:59:00Z'), 60)).toBe('due')
    expect(pendingStatus(due, at('2026-05-04T13:01:00Z'), 60)).toBe('overdue')
  })

  it('describes schedules', () => {
    expect(describeSchedule(med({ type: 'interval', everyHours: 8 }))).toBe('Every 8 h')
    expect(describeSchedule(med(daily(['20:00', '08:00'])))).toBe('Daily · 08:00, 20:00')
    expect(describeSchedule(med({ type: 'fixed', times: ['09:00'], days: [1, 2, 3, 4, 5] }))).toBe('Weekdays · 09:00')
    expect(describeSchedule(med({ type: 'prn', minIntervalHours: 4, maxPer24h: 6, notifyWhenAvailable: false }))).toBe('As needed · ≥4 h apart · max 6/24h')
  })
})
