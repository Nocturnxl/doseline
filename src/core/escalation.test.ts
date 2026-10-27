import { describe, expect, it } from 'vitest'
import { AlarmEngine } from './alarmEngine'
import { outcomesForMed } from './adherence'
import {
  CONSOLIDATE_MS,
  dueEscalations,
  escalationThreshold,
  isQuietHours,
  overdueLabel,
  planEscalations,
  recordFired,
  recordSnoozed,
  resolveRecords,
  stampLog,
} from './escalation'
import { MemoryRepository } from './memoryRepository'
import { mergeSettings } from './settings'
import { DoseService } from './service'
import { DEFAULT_SETTINGS, type EscalationRecord, type Medication, type Settings } from './types'
import { FakeClock, FakeTimers, RecordingPresenter, med, nextId, silentLogger, taken } from './testkit'
import { MINUTE } from './time'

const NY = 'America/New_York'
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7] as const
const settingsWith = (esc: Partial<Settings['escalation']> = {}): Settings => mergeSettings({ escalation: esc })
// 2026-05-04 is a Monday; New York is UTC-4 (EDT). 08:00 local = 12:00Z.
const daily = (times: string[], over: Partial<Medication> = {}) => med({ type: 'fixed', times, days: [...EVERY_DAY] }, { createdAt: '2026-05-04T10:00:00Z', ...over })

function setup(start: string, settings: Settings = settingsWith()) {
  const repo = new MemoryRepository()
  repo.settings = settings
  const clock = new FakeClock(new Date(start))
  const timers = new FakeTimers()
  const presenter = new RecordingPresenter()
  const engine = new AlarmEngine({ repo, clock, zone: () => NY, timers, presenter, logger: silentLogger })
  /** Advance in 1-minute steps (as a running app would), firing timers on the way. */
  const runUntil = async (iso: string, stepMs = MINUTE) => {
    const end = new Date(iso).getTime()
    while (clock.now().getTime() < end) {
      clock.advance(Math.min(stepMs, end - clock.now().getTime()))
      const before = presenter.escalations.length
      timers.fireDue(clock.now())
      await engine.recompute('test')
      for (const e of presenter.escalations.slice(before)) e.at = clock.now()
    }
  }
  const fires = () => presenter.escalations.map((e) => ({ at: e.at?.toISOString().slice(11, 16), meds: e.alerts.map((a) => a.med.id), repeats: e.alerts.map((a) => a.repeats), first: e.alerts.map((a) => a.first), quiet: e.quiet }))
  return { repo, clock, timers, presenter, engine, runUntil, fires }
}

describe('escalation thresholds', () => {
  it('uses the global default, per-med overrides, and Off', () => {
    const s = settingsWith({ thresholdMinutes: 45 })
    expect(escalationThreshold(daily(['08:00']), s)).toBe(45)
    expect(escalationThreshold(daily(['08:00'], { escalationMinutes: 120 }), s)).toBe(120)
    expect(escalationThreshold(daily(['08:00'], { escalationMinutes: 0 }), s)).toBeNull()
    expect(escalationThreshold(daily(['08:00'], { escalationMinutes: 2 }), s)).toBe(5) // clamped to 5-360
    expect(escalationThreshold(daily(['08:00'], { active: false }), s)).toBeNull()
  })

  it('merges and clamps settings', () => {
    const s = mergeSettings({ escalation: { thresholdMinutes: 9999, repeatMinutes: 1, quietHours: { enabled: true, start: 'bogus' } } })
    expect(s.escalation).toEqual({ thresholdMinutes: 360, repeatMinutes: 5, sound: 'urgent', quietHours: { enabled: true, start: '22:00', end: '07:00' } })
    expect(mergeSettings({}).escalation).toEqual(DEFAULT_SETTINGS.escalation)
  })

  it('crosses the threshold exactly once, then repeats on the configured cadence', async () => {
    const m = daily(['08:00', '20:00'])
    const { repo, engine, runUntil, fires } = setup('2026-05-04T11:00:00Z')
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    expect(engine.getEscalationPlan()[0]).toMatchObject({ kind: 'first', fireAt: new Date('2026-05-04T12:30:00Z') })
    await runUntil('2026-05-04T12:29:00Z')
    expect(fires()).toEqual([])
    await runUntil('2026-05-04T13:01:00Z')
    expect(fires()).toEqual([
      { at: '12:30', meds: [m.id], repeats: [0], first: [true], quiet: false },
      { at: '12:45', meds: [m.id], repeats: [1], first: [false], quiet: false },
      { at: '13:00', meds: [m.id], repeats: [2], first: [false], quiet: false },
    ])
    const [rec] = await repo.listEscalations()
    expect(rec).toMatchObject({ escalatedAt: '2026-05-04T12:30:00.000Z', repeats: 2, resolution: null })
  })

  it('honours a custom repeat interval', async () => {
    const m = daily(['08:00'])
    const { repo, engine, runUntil, fires } = setup('2026-05-04T11:59:00Z', settingsWith({ thresholdMinutes: 5, repeatMinutes: 5 }))
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T12:21:00Z')
    expect(fires().map((f) => f.at)).toEqual(['12:05', '12:10', '12:15', '12:20'])
  })
})

describe('resolving an escalation', () => {
  it('stops when the dose is taken, and the log records the escalation', async () => {
    const m = daily(['08:00', '20:00'])
    const { repo, clock, engine, runUntil, fires } = setup('2026-05-04T11:00:00Z')
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T12:50:00Z')
    const service = new DoseService({ repo, clock, zone: () => NY, newId: nextId, onChanged: () => engine.recompute('logged') })
    const { log } = await service.logDose({ medicationId: m.id, kind: 'taken' })
    expect(log).toMatchObject({ scheduledFor: '2026-05-04T12:00:00.000Z', escalatedAt: '2026-05-04T12:30:00.000Z', escalationRepeats: 1 })
    expect((await repo.getLog(log.id))!.escalatedAt).toBe('2026-05-04T12:30:00.000Z')
    await runUntil('2026-05-04T14:00:00Z')
    expect(fires().length).toBe(2)
    expect((await repo.listEscalations())[0]!.resolution).toBe('taken')
  })

  it('a backdated "took it at" the due time also stops it', async () => {
    const m = daily(['08:00', '20:00'])
    const { repo, clock, engine, runUntil, fires } = setup('2026-05-04T11:00:00Z')
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T12:31:00Z')
    const service = new DoseService({ repo, clock, zone: () => NY, newId: nextId, onChanged: () => engine.recompute('logged') })
    const { log } = await service.logDose({ medicationId: m.id, kind: 'taken', at: new Date('2026-05-04T12:00:00Z') })
    expect(log.scheduledFor).toBe('2026-05-04T12:00:00.000Z')
    await runUntil('2026-05-04T14:00:00Z')
    expect(fires().length).toBe(1)
  })

  it('a skip stops it; undo brings it back on the same cadence', async () => {
    const m = daily(['08:00', '20:00'])
    const { repo, clock, engine, runUntil, fires } = setup('2026-05-04T11:00:00Z')
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T12:31:00Z')
    const service = new DoseService({ repo, clock, zone: () => NY, newId: nextId, onChanged: () => engine.recompute('logged') })
    const r = await service.logDose({ medicationId: m.id, kind: 'skipped' })
    await runUntil('2026-05-04T12:31:05Z')
    expect(await service.undo(r.undoToken)).toBe(true)
    await runUntil('2026-05-04T12:46:00Z')
    expect(fires().map((f) => [f.at, f.repeats[0]])).toEqual([
      ['12:30', 0],
      ['12:45', 1],
    ])
  })

  it('fixed schedule: the next slot auto-resolves the old dose as missed and starts fresh', async () => {
    const m = daily(['08:00', '09:00'])
    const { repo, engine, runUntil, presenter } = setup('2026-05-04T11:55:00Z')
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T13:46:00Z')
    const cycles = presenter.escalations.map((e) => ({ at: e.at!.toISOString().slice(11, 16), dueAt: e.alerts.map((a) => a.dueAt.toISOString().slice(11, 16)), first: e.alerts.map((a) => a.first) }))
    expect(cycles).toEqual([
      { at: '12:30', dueAt: ['12:00'], first: [true] },
      { at: '12:45', dueAt: ['12:00'], first: [false] },
      // 13:00: the 09:00 slot came due, so the 08:00 dose stops escalating (no 13:00 repeat).
      { at: '13:30', dueAt: ['13:00'], first: [true] },
      { at: '13:45', dueAt: ['13:00'], first: [false] },
    ])
    // Never two escalations for the same medication in one cycle.
    expect(presenter.escalations.every((e) => new Set(e.alerts.map((a) => a.med.id)).size === e.alerts.length)).toBe(true)
    const recs = (await repo.listEscalations()).sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    expect(recs.map((r) => r.resolution)).toEqual(['missed', null])
    const outcomes = outcomesForMed(m, [], new Date('2026-05-04T00:00:00Z'), new Date('2026-05-05T00:00:00Z'), new Date('2026-05-04T13:46:00Z'), NY, 60)
    expect(outcomes.map((o) => o.status)).toEqual(['missed'])
  })

  it('interval schedules escalate until acted on', async () => {
    const m = med({ type: 'interval', everyHours: 8, firstDoseAt: '2026-05-04T12:00:00Z' }, { createdAt: '2026-05-01T00:00:00Z' })
    const { repo, engine, runUntil, fires } = setup('2026-05-04T11:50:00Z', settingsWith({ repeatMinutes: 30 }))
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-05T00:01:00Z')
    const f = fires()
    expect(f[0]).toMatchObject({ at: '12:30', first: [true] })
    expect(f).toHaveLength(24) // 12:30 then every 30 min through 00:00, past the would-be next 8 h dose
    expect(f[f.length - 1]).toMatchObject({ at: '00:00', repeats: [23] })
  })

  it('PRN medications never escalate', async () => {
    const prn = med({ type: 'prn', minIntervalHours: 4, notifyWhenAvailable: true })
    const logs = [taken(prn.id, '2026-05-04T06:00:00Z')]
    expect(planEscalations([prn], logs, [], settingsWith(), new Date('2026-05-04T23:00:00Z'), NY)).toEqual([])
    expect(escalationThreshold(prn, settingsWith())).toBeNull()
  })

  it('per-medication Off and per-medication thresholds', async () => {
    const off = daily(['08:00'], { escalationMinutes: 0 })
    const hour = daily(['08:00'], { escalationMinutes: 60 })
    const { repo, engine, runUntil, fires } = setup('2026-05-04T11:55:00Z')
    await repo.saveMedication(off)
    await repo.saveMedication(hour)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T13:01:00Z')
    expect(fires()).toEqual([{ at: '13:00', meds: [hour.id], repeats: [0], first: [true], quiet: false }])
  })
})

describe('snooze', () => {
  it('defers only the next repeat, without resetting the overdue clock', async () => {
    const m = daily(['08:00', '20:00'])
    const { repo, engine, runUntil, fires } = setup('2026-05-04T11:00:00Z')
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T12:32:00Z')
    await engine.snoozeEscalation(m.id, new Date('2026-05-04T12:00:00Z'), 30)
    await runUntil('2026-05-04T13:18:00Z')
    expect(fires().map((f) => [f.at, f.repeats[0]])).toEqual([
      ['12:30', 0],
      ['13:02', 1], // snoozed past 12:45
      ['13:17', 2], // then the normal cadence resumes
    ])
    expect((await repo.listEscalations())[0]!.escalatedAt).toBe('2026-05-04T12:30:00.000Z')
  })

  it('a snooze shorter than the cadence never pulls the repeat earlier', () => {
    const rec: EscalationRecord = { medicationId: 'a', dueAt: '2026-05-04T12:00:00.000Z', escalatedAt: '2026-05-04T12:30:00.000Z', lastFiredAt: '2026-05-04T12:30:00.000Z', repeats: 0, snoozedUntil: null, resolution: null }
    const snoozed = recordSnoozed(rec, new Date('2026-05-04T12:30:00Z'), 15)
    const m = daily(['08:00', '20:00'], { id: 'a' })
    const [p] = planEscalations([m], [], [snoozed], settingsWith({ repeatMinutes: 60 }), new Date('2026-05-04T12:31:00Z'), NY)
    expect(p!.fireAt.toISOString()).toBe('2026-05-04T13:30:00.000Z')
    expect(recordSnoozed(rec, new Date('2026-05-04T12:30:00Z'), 7).snoozedUntil).toBe('2026-05-04T12:45:00.000Z') // invalid → 15
  })
})

describe('consolidation', () => {
  it('cycles landing within 60 s share one presentation; later ones do not', async () => {
    const a = daily(['08:00', '20:00'])
    const b = med({ type: 'interval', everyHours: 24, firstDoseAt: '2026-05-04T12:00:40Z' }, { createdAt: '2026-05-01T00:00:00Z' })
    const c = med({ type: 'interval', everyHours: 24, firstDoseAt: '2026-05-04T12:05:00Z' }, { createdAt: '2026-05-01T00:00:00Z' })
    const { repo, engine, runUntil, fires } = setup('2026-05-04T11:55:00Z')
    for (const m of [a, b, c]) await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T12:51:00Z')
    expect(fires().map((f) => [f.at, f.meds.length])).toEqual([
      ['12:30', 2], // a (12:30:00) and b (12:30:40) together
      ['12:35', 1], // c
      ['12:45', 2], // a and b stay in step
      ['12:50', 1],
    ])
  })

  it('dueEscalations pulls forward anything within the window, but only when something is due', () => {
    const p = (min: number) => ({ fireAt: new Date(Date.UTC(2026, 4, 4, 12, 0) + min * MINUTE) }) as never
    const now = new Date(Date.UTC(2026, 4, 4, 12, 0))
    expect(dueEscalations([p(0), p(0.9), p(1.1)], now).fire).toHaveLength(2)
    expect(dueEscalations([p(0.5)], now).fire).toHaveLength(0)
    expect(dueEscalations([p(-5), p(0)], now)).toMatchObject({ fire: [{}], stale: [{}] })
    expect(CONSOLIDATE_MS).toBe(60_000)
  })
})

describe('quiet hours', () => {
  it('detects ranges that cross midnight', () => {
    const s = settingsWith({ quietHours: { enabled: true, start: '22:00', end: '07:00' } })
    const at = (local: string) => new Date(`2026-05-04T${local}:00-04:00`)
    expect(isQuietHours(s, at('21:59'), NY)).toBe(false)
    expect(isQuietHours(s, at('22:00'), NY)).toBe(true)
    expect(isQuietHours(s, at('03:00'), NY)).toBe(true)
    expect(isQuietHours(s, at('07:00'), NY)).toBe(false)
    expect(isQuietHours(settingsWith(), at('03:00'), NY)).toBe(false) // off by default
    const day = settingsWith({ quietHours: { enabled: true, start: '13:00', end: '14:00' } })
    expect(isQuietHours(day, at('13:30'), NY)).toBe(true)
    expect(isQuietHours(day, at('14:30'), NY)).toBe(false)
  })

  it('mutes sound during quiet hours and the first alarm after them rings', async () => {
    const m = daily(['06:00']) // 06:00 EDT = 10:00Z
    const s = settingsWith({ repeatMinutes: 30, quietHours: { enabled: true, start: '22:00', end: '07:00' } })
    const { repo, engine, runUntil, fires } = setup('2026-05-04T09:55:00Z', s)
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T11:31:00Z')
    expect(fires().map((f) => [f.at, f.quiet])).toEqual([
      ['10:30', true], // 06:30 local
      ['11:00', false], // 07:00 local: quiet hours over, rings normally
      ['11:30', false],
    ])
  })
})

describe('restart and sleep recovery', () => {
  it('relaunching mid-escalation restores the cadence without a burst', async () => {
    const m = daily(['08:00', '20:00'])
    const first = setup('2026-05-04T11:00:00Z')
    await first.repo.saveMedication(m)
    await first.engine.recompute('startup', true)
    await first.runUntil('2026-05-04T12:36:00Z')
    first.engine.stop() // quit at 12:36 after the first escalation
    // Relaunch at 12:41 on the same database.
    const { clock, timers, presenter } = first
    clock.set('2026-05-04T12:41:00Z')
    const engine = new AlarmEngine({ repo: first.repo, clock, zone: () => NY, timers, presenter, logger: silentLogger })
    const before = presenter.escalations.length
    await engine.recompute('startup', true)
    expect(presenter.escalations.length).toBe(before) // nothing fires at launch
    expect(engine.getEscalationPlan()[0]).toMatchObject({ kind: 'repeat', fireAt: new Date('2026-05-04T12:45:00Z') })
    clock.set('2026-05-04T12:45:00Z')
    timers.fireDue(clock.now())
    await engine.recompute('test')
    expect(presenter.escalations.length).toBe(before + 1)
    expect(presenter.escalations.at(-1)!.alerts[0]!.repeats).toBe(1)
  })

  it('sleep through several repeats: folded into the away summary, then the cadence resumes', async () => {
    const m = daily(['08:00', '20:00'])
    const { repo, clock, timers, engine, runUntil, presenter } = setup('2026-05-04T11:00:00Z')
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T12:31:00Z')
    // Asleep 12:31 → 14:07: four repeats were due meanwhile.
    clock.set('2026-05-04T14:07:00Z')
    timers.fireDue(clock.now())
    await engine.recompute('resume', true)
    expect(presenter.escalations).toHaveLength(1) // no backlog burst
    expect(await engine.getMissed()).toEqual([{ medicationId: m.id, dueAt: '2026-05-04T12:00:00.000Z', escalated: true }])
    const [rec] = await repo.listEscalations()
    expect(rec).toMatchObject({ repeats: 0, lastFiredAt: '2026-05-04T14:07:00.000Z' })
    await runUntil('2026-05-04T14:23:00Z')
    expect(presenter.escalations.map((e) => e.at!.toISOString().slice(11, 16))).toEqual(['12:30', '14:22'])
  })

  it('launching after escalation started while the app was closed folds it in once', async () => {
    const m = daily(['08:00', '20:00'])
    const { repo, engine, runUntil, presenter } = setup('2026-05-04T11:50:00Z')
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    // App closed at 11:50; launched again at 13:10.
    const later = setup('2026-05-04T13:10:00Z')
    later.repo.meds = repo.meds
    later.repo.kv = repo.kv
    await later.engine.recompute('startup', true)
    expect(later.presenter.escalations).toEqual([])
    expect(await later.engine.getMissed()).toEqual([{ medicationId: m.id, dueAt: '2026-05-04T12:00:00.000Z', escalated: true }])
    expect((await later.repo.listEscalations())[0]).toMatchObject({ escalatedAt: '2026-05-04T12:30:00.000Z', lastFiredAt: '2026-05-04T13:10:00.000Z' })
    await later.runUntil('2026-05-04T13:26:00Z')
    expect(later.fires()).toEqual([{ at: '13:25', meds: [m.id], repeats: [1], first: [false], quiet: false }])
    expect(presenter.escalations).toEqual([])
    void runUntil
  })

  it('lowering the threshold while awake fires once now, not a backlog', async () => {
    const m = daily(['08:00', '20:00'])
    const { repo, engine, runUntil, fires } = setup('2026-05-04T11:55:00Z', settingsWith({ thresholdMinutes: 120 }))
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-05-04T13:00:00Z')
    expect(fires()).toEqual([])
    repo.settings = settingsWith({ thresholdMinutes: 30 })
    await engine.recompute('settings') // 12:30 start is long past: one alarm now, not a catch-up series
    expect(fires().map((f) => [f.first[0], f.repeats[0]])).toEqual([[true, 0]])
    expect((await repo.listEscalations())[0]!.escalatedAt).toBe('2026-05-04T13:00:00.000Z')
    await runUntil('2026-05-04T13:16:00Z')
    expect(fires().map((f) => [f.at ?? 'now', f.first[0]])).toEqual([
      ['now', true],
      ['13:15', false],
    ])
  })
})

describe('DST', () => {
  it('fall back: the repeat cadence stays 15 real minutes through the repeated hour', async () => {
    // 2026-11-01: 02:00 EDT → 01:00 EST. A 01:15 dose fires at its first occurrence (05:15Z).
    const m = daily(['01:15'], { createdAt: '2026-11-01T04:00:00Z' })
    const { repo, engine, runUntil, presenter } = setup('2026-11-01T05:00:00Z')
    await repo.saveMedication(m)
    await engine.recompute('startup', true)
    await runUntil('2026-11-01T06:31:00Z')
    const times = presenter.escalations.map((e) => e.at!.toISOString().slice(11, 16))
    expect(times).toEqual(['05:45', '06:00', '06:15', '06:30'])
    expect(presenter.escalations.every((e) => e.alerts[0]!.dueAt.toISOString() === '2026-11-01T05:15:00.000Z')).toBe(true)
  })

  it('spring forward: a 02:30 dose in the gap escalates 30 real minutes after its shifted slot', async () => {
    // 2026-03-08: 02:00 EST → 03:00 EDT. 02:30 doesn't exist; the schedule shifts it to 03:30 EDT (07:30Z).
    const m = daily(['02:30'], { createdAt: '2026-03-08T05:00:00Z' })
    const s = settingsWith()
    const plan = planEscalations([m], [], [], s, new Date('2026-03-08T06:50:00Z'), NY)
    expect(plan[0]!.dueAt.toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(plan[0]!.fireAt.toISOString()).toBe('2026-03-08T08:00:00.000Z')
    const rec = recordFired(plan[0]!, new Date('2026-03-08T08:00:00Z'))
    const [next] = planEscalations([m], [], [rec], s, new Date('2026-03-08T08:01:00Z'), NY)
    expect(next!.fireAt.toISOString()).toBe('2026-03-08T08:15:00.000Z')
  })

  it('an escalation active across a zone change keeps its absolute schedule', async () => {
    const m = med({ type: 'interval', everyHours: 24, firstDoseAt: '2026-05-04T12:00:00Z' }, { createdAt: '2026-05-01T00:00:00Z' })
    const rec = recordFired(planEscalations([m], [], [], settingsWith(), new Date('2026-05-04T12:30:00Z'), NY)[0]!, new Date('2026-05-04T12:30:00Z'))
    const ny = planEscalations([m], [], [rec], settingsWith(), new Date('2026-05-04T12:31:00Z'), NY)[0]!
    const tokyo = planEscalations([m], [], [rec], settingsWith(), new Date('2026-05-04T12:31:00Z'), 'Asia/Tokyo')[0]!
    expect(tokyo.fireAt.toISOString()).toBe(ny.fireAt.toISOString())
  })
})

describe('history and adherence', () => {
  it('a dose taken after escalation counts as late even inside the grace window', () => {
    const m = daily(['08:00'])
    const stamped = taken(m.id, '2026-05-04T12:40:00Z', '2026-05-04T12:00:00Z', { escalatedAt: '2026-05-04T12:30:00.000Z', escalationRepeats: 0 })
    const plain = taken(m.id, '2026-05-04T12:40:00Z', '2026-05-04T12:00:00Z')
    const judge = (log: typeof plain) => outcomesForMed(m, [log], new Date('2026-05-04T00:00:00Z'), new Date('2026-05-05T00:00:00Z'), new Date('2026-05-04T23:00:00Z'), NY, 60)[0]!.status
    expect(judge(plain)).toBe('onTime')
    expect(judge(stamped)).toBe('late')
    // Backdated to before the escalation: judged by the normal grace window.
    expect(judge({ ...stamped, takenAt: '2026-05-04T12:05:00.000Z' })).toBe('onTime')
  })

  it('stampLog copies only the matching record', () => {
    const rec: EscalationRecord = { medicationId: 'a', dueAt: '2026-05-04T12:00:00.000Z', escalatedAt: '2026-05-04T12:30:00.000Z', lastFiredAt: '2026-05-04T13:00:00.000Z', repeats: 2, snoozedUntil: null, resolution: null }
    const log = taken('a', '2026-05-04T13:05:00Z', '2026-05-04T12:00:00Z')
    expect(stampLog(log, [rec])).toMatchObject({ escalatedAt: rec.escalatedAt, escalationRepeats: 2 })
    expect(stampLog({ ...log, scheduledFor: '2026-05-04T13:00:00.000Z' }, [rec]).escalatedAt).toBeUndefined()
    expect(stampLog({ ...log, medicationId: 'b' }, [rec]).escalatedAt).toBeUndefined()
  })

  it('resolveRecords labels taken, skipped, missed and pending', () => {
    const m = daily(['08:00', '20:00'], { id: 'a' })
    const base: EscalationRecord = { medicationId: 'a', dueAt: '2026-05-04T12:00:00.000Z', escalatedAt: '2026-05-04T12:30:00.000Z', lastFiredAt: '2026-05-04T12:30:00.000Z', repeats: 0, snoozedUntil: null, resolution: null }
    const now = new Date('2026-05-04T12:40:00Z')
    expect(resolveRecords([base], [m], [], now, NY)).toEqual([])
    expect(resolveRecords([base], [m], [taken('a', '2026-05-04T12:39:00Z', '2026-05-04T12:00:00Z')], now, NY)[0]!.resolution).toBe('taken')
    expect(resolveRecords([base], [m], [], new Date('2026-05-05T00:01:00Z'), NY)[0]!.resolution).toBe('missed')
  })

  it('formats the overdue counter', () => {
    const due = new Date('2026-05-04T12:00:00Z')
    expect(overdueLabel(due, new Date('2026-05-04T13:15:30Z'))).toBe('1 h 15 m')
    expect(overdueLabel(due, new Date('2026-05-04T12:45:00Z'))).toBe('45 m')
    expect(overdueLabel(due, new Date('2026-05-04T14:00:00Z'))).toBe('2 h')
  })
})
