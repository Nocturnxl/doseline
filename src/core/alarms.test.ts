import { describe, expect, it } from 'vitest'
import { effectiveOffsets, findMissedWhileAway, planAlarms, staleSnoozes } from './alarms'
import { AlarmEngine } from './alarmEngine'
import { MemoryRepository } from './memoryRepository'
import { DEFAULT_SETTINGS } from './types'
import { FakeClock, FakeTimers, RecordingPresenter, med, silentLogger, taken } from './testkit'
import { MINUTE, HOUR } from './time'

const NY = 'America/New_York'
const settings = { ...DEFAULT_SETTINGS }
const daily = (over = {}) => med({ type: 'fixed', times: ['08:00', '20:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { createdAt: '2026-05-04T10:00:00Z', ...over })

describe('alarm planning', () => {
  it('defaults to 30 and 15 minutes before plus the due time', () => {
    const m = daily()
    const plan = planAlarms([m], [], [], settings, new Date('2026-05-04T11:00:00Z'), NY)
    expect(plan.map((a) => [a.fireAt.toISOString(), a.offsetMin, a.kind])).toEqual([
      ['2026-05-04T11:30:00.000Z', 30, 'reminder'],
      ['2026-05-04T11:45:00.000Z', 15, 'reminder'],
      ['2026-05-04T12:00:00.000Z', 0, 'due'],
    ])
  })

  it('per-medication offsets override the global list', () => {
    const m = daily({ reminderOffsets: [60, 5, 5] })
    expect(effectiveOffsets(m, settings)).toEqual([60, 5])
    const plan = planAlarms([m], [], [], settings, new Date('2026-05-04T10:30:00Z'), NY)
    expect(plan.map((a) => a.offsetMin)).toEqual([60, 5, 0])
  })

  it('omits alarms already in the past', () => {
    const plan = planAlarms([daily()], [], [], settings, new Date('2026-05-04T11:50:00Z'), NY)
    expect(plan.map((a) => a.offsetMin)).toEqual([0])
  })

  it('paused meds and PRN without notifications get no alarms', () => {
    const paused = daily({ active: false })
    const prn = med({ type: 'prn', minIntervalHours: 4, notifyWhenAvailable: false })
    expect(planAlarms([paused, prn], [taken(prn.id, '2026-05-04T10:00:00Z')], [], settings, new Date('2026-05-04T11:00:00Z'), NY)).toEqual([])
  })

  it('PRN with notifications alarms when available again', () => {
    const prn = med({ type: 'prn', minIntervalHours: 4, notifyWhenAvailable: true })
    const plan = planAlarms([prn], [taken(prn.id, '2026-05-04T10:00:00Z')], [], { ...settings, reminderOffsets: [] }, new Date('2026-05-04T11:00:00Z'), NY)
    expect(plan.map((a) => a.fireAt.toISOString())).toEqual(['2026-05-04T14:00:00.000Z'])
  })

  it('includes snoozes for the current pending dose only', () => {
    const m = daily()
    const snoozes = [
      { id: 's1', medicationId: m.id, dueAt: '2026-05-04T12:00:00.000Z', fireAt: '2026-05-04T12:10:00.000Z' },
      { id: 's2', medicationId: m.id, dueAt: '2026-05-03T12:00:00.000Z', fireAt: '2026-05-04T12:10:00.000Z' },
    ]
    const now = new Date('2026-05-04T12:01:00Z')
    const plan = planAlarms([m], [], snoozes, settings, now, NY)
    expect(plan.filter((a) => a.kind === 'snooze').map((a) => a.id)).toEqual(['snooze|s1'])
    expect(staleSnoozes([m], [], snoozes, now, NY).map((s) => s.id)).toEqual(['s2'])
  })

  it('finds doses missed while asleep, but not ones that were logged', () => {
    const m = daily()
    const logs = [taken(m.id, '2026-05-04T12:05:00Z', '2026-05-04T12:00:00Z')]
    const missed = findMissedWhileAway([m], logs, new Date('2026-05-04T11:00:00Z'), new Date('2026-05-05T13:00:00Z'), NY)
    expect(missed.map((x) => x.dueAt.toISOString())).toEqual(['2026-05-05T00:00:00.000Z', '2026-05-05T12:00:00.000Z'])
  })

  it('reports nothing for a short gap', () => {
    expect(findMissedWhileAway([daily()], [], new Date('2026-05-04T11:59:00Z'), new Date('2026-05-04T12:00:30Z'), NY)).toEqual([])
  })
})

describe('AlarmEngine', () => {
  function setup(start = '2026-05-04T11:00:00Z') {
    const repo = new MemoryRepository()
    const clock = new FakeClock(new Date(start))
    const timers = new FakeTimers()
    const presenter = new RecordingPresenter()
    const engine = new AlarmEngine({ repo, clock, zone: () => NY, timers, presenter, logger: silentLogger })
    const advanceTo = async (iso: string) => {
      clock.set(iso)
      timers.fireDue(clock.now())
      await engine.recompute('test')
    }
    return { repo, clock, timers, presenter, engine, advanceTo }
  }

  it('fires reminders and the due alarm at the right times, once each', async () => {
    const { repo, presenter, engine, advanceTo } = setup()
    await repo.saveMedication(daily())
    await engine.recompute('startup', true)
    await advanceTo('2026-05-04T11:30:00Z')
    await advanceTo('2026-05-04T11:45:00Z')
    await advanceTo('2026-05-04T12:00:00Z')
    await advanceTo('2026-05-04T12:00:30Z')
    expect(presenter.presented.map((p) => p.alarm.offsetMin)).toEqual([30, 15, 0])
    expect(presenter.missed).toEqual([])
  })

  it('does not re-fire alarms after a restart', async () => {
    const { repo, presenter, engine, advanceTo, clock, timers } = setup()
    await repo.saveMedication(daily())
    await engine.recompute('startup', true)
    await advanceTo('2026-05-04T11:30:00Z')
    expect(presenter.presented).toHaveLength(1)
    // New engine instance on the same repository (app relaunch) within the tolerance window.
    const p2 = new RecordingPresenter()
    const e2 = new AlarmEngine({ repo, clock, zone: () => NY, timers, presenter: p2, logger: silentLogger })
    clock.set('2026-05-04T11:30:20Z')
    await e2.recompute('startup', true)
    timers.fireDue(clock.now())
    await e2.recompute('t')
    expect(p2.presented).toHaveLength(0)
  })

  it('a snooze fires again after N minutes', async () => {
    const { repo, presenter, engine, advanceTo } = setup()
    const m = daily()
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await advanceTo('2026-05-04T11:30:00Z')
    await advanceTo('2026-05-04T11:45:00Z')
    await advanceTo('2026-05-04T12:00:00Z')
    await repo.saveSnooze({ id: 'sn', medicationId: m.id, dueAt: '2026-05-04T12:00:00.000Z', fireAt: '2026-05-04T12:10:00.000Z' })
    await engine.recompute('snooze')
    await advanceTo('2026-05-04T12:10:00Z')
    expect(presenter.presented.map((p) => p.alarm.kind)).toContain('snooze')
  })

  it('logging a dose cancels its remaining alarms', async () => {
    const { repo, presenter, engine, advanceTo } = setup()
    const m = daily()
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await advanceTo('2026-05-04T11:30:00Z')
    await repo.saveLog(taken(m.id, '2026-05-04T11:31:00Z', '2026-05-04T12:00:00Z'))
    await engine.recompute('logged')
    await advanceTo('2026-05-04T11:45:00Z')
    await advanceTo('2026-05-04T12:00:00Z')
    expect(presenter.presented.map((p) => p.alarm.offsetMin)).toEqual([30])
    expect(engine.getPlan()[0]!.dueAt.toISOString()).toBe('2026-05-05T00:00:00.000Z')
  })

  it('after sleep, shows a single missed summary instead of a burst of alarms', async () => {
    const { repo, presenter, engine, clock, timers } = setup()
    await repo.saveMedication(daily())
    await engine.recompute('startup', true)
    // Machine sleeps for 14 hours; the timer fires late on wake.
    clock.set('2026-05-05T01:00:00Z')
    timers.fireDue(clock.now())
    await engine.recompute('resume', true)
    expect(presenter.presented).toHaveLength(0)
    expect(presenter.missed).toHaveLength(1)
    expect(presenter.missed[0]!.map((x) => x.dueAt.toISOString())).toEqual(['2026-05-04T12:00:00.000Z', '2026-05-05T00:00:00.000Z'])
    expect((await engine.getMissed()).length).toBe(2)
    await engine.dismissMissed()
    expect(await engine.getMissed()).toEqual([])
  })

  it('tick() detects a clock jump and recomputes', async () => {
    const { repo, presenter, engine, clock } = setup()
    await repo.saveMedication(daily())
    await engine.recompute('startup', true)
    clock.advance(30_000)
    await engine.tick(30_000)
    clock.advance(10 * HOUR)
    await engine.tick(30_000)
    expect(presenter.missed).toHaveLength(1)
  })

  it('never sleeps longer than an hour between wake-ups', async () => {
    const { engine, timers, clock } = setup()
    await engine.recompute('startup', true)
    expect(timers.timers).toHaveLength(1)
    expect(timers.timers[0]!.at.getTime() - clock.now().getTime()).toBe(HOUR)
  })

  it('coincident alarms for one med present once', async () => {
    const { repo, presenter, engine, advanceTo } = setup('2026-05-04T11:59:00Z')
    await repo.saveMedication(daily({ reminderOffsets: [1] }))
    await engine.recompute('startup', true)
    await advanceTo('2026-05-04T12:00:00Z')
    expect(presenter.presented).toHaveLength(1)
  })

  it('fireTest presents immediately', () => {
    const { engine, presenter } = setup()
    engine.fireTest(daily())
    expect(presenter.presented).toHaveLength(1)
    expect(MINUTE).toBe(60_000)
  })
})
