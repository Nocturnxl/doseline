import type { Medication, Settings } from './types'
import type { AlarmPresenter, Clock, EscalationAlert, Logger, Repository, TimerScheduler } from './ports'
import { activeEscalations, dueEscalations, isQuietHours, planEscalations, recordFired, recordFolded, recordSnoozed, resolveRecords, type PlannedEscalation } from './escalation'
import { LATE_FIRE_TOLERANCE_MS, findMissedWhileAway, planAlarms, staleSnoozes, type MissedDose, type PlannedAlarm } from './alarms'
import { DAY, HOUR, MINUTE } from './time'

export interface AlarmEngineDeps {
  repo: Repository
  clock: Clock
  zone: () => string
  timers: TimerScheduler
  presenter: AlarmPresenter
  logger: Logger
}

const KV_LAST_SEEN = 'alarms.lastSeen'
const KV_FIRED = 'alarms.fired'
const KV_MISSED = 'alarms.missed'
/** Never sleep longer than this, so wall-clock changes are picked up even without events. */
const MAX_TIMER_MS = HOUR
/** A gap this large between heartbeats means the machine slept or the clock jumped. */
const GAP_MS = 2 * MINUTE

export interface MissedSummaryEntry {
  medicationId: string
  dueAt: string
  escalated?: boolean
}

/** Escalation records for doses due longer ago than this are pruned. */
const ESCALATION_RETENTION_MS = 90 * DAY

/**
 * Local alarm scheduler. Recomputes the full plan from current state (never relies on
 * previously scheduled timers being accurate), so it is robust to sleep, clock and zone changes.
 * Has no dependency on Google: alarms are derived purely from local data.
 */
export class AlarmEngine {
  private handle: unknown = null
  private armedFor = 0
  private plan: PlannedAlarm[] = []
  private escalationPlan: PlannedEscalation[] = []
  private fired = new Set<string>()
  private lastTick: number | null = null
  private loaded = false
  private chain: Promise<void> = Promise.resolve()

  constructor(private d: AlarmEngineDeps) {}

  getPlan(): PlannedAlarm[] {
    return this.plan
  }

  getEscalationPlan(): PlannedEscalation[] {
    return this.escalationPlan
  }

  /** Serialize recomputes so overlapping triggers can't interleave. */
  recompute(reason: string, checkMissed = false): Promise<void> {
    this.chain = this.chain.then(() => this.doRecompute(reason, checkMissed)).catch((e) => {
      this.d.logger.error('alarm recompute failed', { reason, error: String(e) })
    })
    return this.chain
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    const raw = await this.d.repo.getKV(KV_FIRED)
    try {
      for (const id of JSON.parse(raw ?? '[]') as string[]) this.fired.add(id)
    } catch {
      /* corrupt list: start fresh */
    }
    this.loaded = true
  }

  private async doRecompute(reason: string, checkMissed: boolean): Promise<void> {
    await this.load()
    const { repo, clock, zone } = this.d
    const now = clock.now()
    const tz = zone()
    const [meds, logs, snoozes, settings] = await Promise.all([repo.listMedications(), repo.listLogs(), repo.listSnoozes(), repo.getSettings()])

    for (const s of staleSnoozes(meds, logs, snoozes, now, tz)) await repo.deleteSnooze(s.id)
    const liveSnoozes = await repo.listSnoozes()

    let records = await repo.listEscalations()
    for (const r of resolveRecords(records, meds, logs, now, tz)) await repo.saveEscalation(r)
    await repo.pruneEscalations(new Date(now.getTime() - ESCALATION_RETENTION_MS))
    records = await repo.listEscalations()
    const stale = dueEscalations(planEscalations(meds, logs, records, settings, now, tz), now).stale

    let gap = false
    if (checkMissed) {
      const lastSeenRaw = await repo.getKV(KV_LAST_SEEN)
      const lastSeen = lastSeenRaw ? new Date(lastSeenRaw) : null
      if (lastSeen && now.getTime() - lastSeen.getTime() > GAP_MS) {
        gap = true
        const missed = findMissedWhileAway(meds, logs, lastSeen, now, tz)
        // Escalations that came due while away join the summary; their repeat cadence restarts now.
        for (const p of stale) {
          await repo.saveEscalation(recordFolded(p, now))
          const same = missed.find((m) => m.medicationId === p.medicationId && m.dueAt.getTime() === p.dueAt.getTime())
          if (same) same.escalated = true
          else missed.push({ medicationId: p.medicationId, dueAt: p.dueAt, escalated: true })
        }
        if (missed.length) {
          await this.rememberMissed(missed)
          this.d.presenter.showMissed(missed)
        }
        this.d.logger.info('alarms: gap detected', { reason, gapMin: Math.round((now.getTime() - lastSeen.getTime()) / MINUTE), missed: missed.length, escalationsFolded: stale.length })
      }
    }
    // Stale without a gap (e.g. the threshold was just lowered): fire once now, never a backlog.
    if (!gap && stale.length) await this.fireEscalations(stale, meds, settings, now, tz)

    this.escalationPlan = planEscalations(meds, logs, await repo.listEscalations(), settings, now, tz)
    this.plan = planAlarms(meds, logs, liveSnoozes, settings, now, tz).filter((a) => !this.fired.has(a.id))
    await repo.setKV(KV_LAST_SEEN, now.toISOString())
    this.lastTick = now.getTime()
    this.arm(now)
  }

  private arm(now: Date): void {
    if (this.handle != null) this.d.timers.clearTimer(this.handle)
    this.handle = null
    const candidates = [now.getTime() + MAX_TIMER_MS]
    if (this.plan[0]) candidates.push(this.plan[0].fireAt.getTime())
    if (this.escalationPlan[0]) candidates.push(this.escalationPlan[0].fireAt.getTime())
    const wake = Math.min(...candidates)
    this.armedFor = Math.max(wake, now.getTime())
    this.handle = this.d.timers.setTimer(new Date(this.armedFor), () => {
      this.handle = null
      this.chain = this.chain.then(() => this.onTimer()).catch((e) => this.d.logger.error('alarm timer failed', { error: String(e) }))
    })
  }

  private async onTimer(): Promise<void> {
    const now = this.d.clock.now()
    // If the timer fired late (machine was asleep), treat everything as "missed while away".
    if (now.getTime() - this.armedFor > GAP_MS) {
      await this.doRecompute('late-timer', true)
      return
    }
    const due = this.plan.filter((a) => a.fireAt.getTime() <= now.getTime() + 500 && a.fireAt.getTime() >= now.getTime() - LATE_FIRE_TOLERANCE_MS)
    if (due.length) {
      const meds = new Map((await this.d.repo.listMedications()).map((m) => [m.id, m]))
      // One presentation per medication even if several offsets coincide.
      const byMed = new Map<string, PlannedAlarm>()
      for (const a of due) {
        this.fired.add(a.id)
        const prev = byMed.get(a.medicationId)
        if (!prev || a.offsetMin < prev.offsetMin) byMed.set(a.medicationId, a)
      }
      for (const a of byMed.values()) {
        const med = meds.get(a.medicationId)
        if (med) this.d.presenter.present(a, med)
      }
      await this.persistFired()
    }
    if (this.escalationPlan.some((p) => p.fireAt.getTime() <= now.getTime() + 500)) {
      const { repo, zone } = this.d
      const tz = zone()
      const [meds, logs, records, settings] = await Promise.all([repo.listMedications(), repo.listLogs(), repo.listEscalations(), repo.getSettings()])
      const { fire, stale } = dueEscalations(planEscalations(meds, logs, records, settings, now, tz), now)
      await this.fireEscalations([...stale, ...fire], meds, settings, now, tz)
    }
    await this.doRecompute('timer', false)
  }

  /** Fire one consolidated escalation cycle: one presentation and one sound for every dose in it. */
  private async fireEscalations(list: PlannedEscalation[], meds: Medication[], settings: Settings, now: Date, tz: string): Promise<void> {
    if (!list.length) return
    const byId = new Map(meds.map((m) => [m.id, m]))
    const alerts: EscalationAlert[] = []
    for (const p of list) {
      const med = byId.get(p.medicationId)
      if (!med) continue
      const rec = recordFired(p, now)
      await this.d.repo.saveEscalation(rec)
      alerts.push({ med, dueAt: p.dueAt, escalatedAt: new Date(rec.escalatedAt), repeats: rec.repeats, first: p.kind === 'first' })
    }
    if (!alerts.length) return
    const quiet = isQuietHours(settings, now, tz)
    this.d.presenter.presentEscalation(alerts, { quiet })
    this.d.logger.info('escalation presented', { count: alerts.length, first: alerts.filter((a) => a.first).length, quiet })
  }

  /** Snooze the current escalation of a medication's pending dose: defers only the next repeat. */
  async snoozeEscalation(medicationId: string, dueAt: Date, minutes: number): Promise<void> {
    const rec = (await this.d.repo.listEscalations()).find((r) => r.medicationId === medicationId && new Date(r.dueAt).getTime() === dueAt.getTime())
    if (!rec) return
    await this.d.repo.saveEscalation(recordSnoozed(rec, this.d.clock.now(), minutes))
    await this.recompute('escalation-snooze')
  }

  /** Escalated doses right now, for the dashboard. */
  async currentEscalations(): Promise<PlannedEscalation[]> {
    const { repo, clock, zone } = this.d
    const [meds, logs, records, settings] = await Promise.all([repo.listMedications(), repo.listLogs(), repo.listEscalations(), repo.getSettings()])
    return activeEscalations(meds, logs, records, settings, clock.now(), zone())
  }

  /** Heartbeat (every ~30s). Detects sleep / clock jumps that produced no OS event. */
  async tick(intervalMs: number): Promise<void> {
    const now = this.d.clock.now().getTime()
    const last = this.lastTick
    this.lastTick = now
    if (last != null && Math.abs(now - last - intervalMs) > GAP_MS) {
      await this.recompute('clock-jump', true)
      return
    }
    await this.d.repo.setKV(KV_LAST_SEEN, new Date(now).toISOString())
  }

  async getMissed(): Promise<MissedSummaryEntry[]> {
    try {
      return JSON.parse((await this.d.repo.getKV(KV_MISSED)) ?? '[]') as MissedSummaryEntry[]
    } catch {
      return []
    }
  }

  async dismissMissed(): Promise<void> {
    await this.d.repo.setKV(KV_MISSED, null)
  }

  private async rememberMissed(missed: MissedDose[]): Promise<void> {
    const prev = await this.getMissed()
    const key = (e: MissedSummaryEntry) => `${e.medicationId}|${e.dueAt}`
    const merged = new Map(prev.map((e) => [key(e), e]))
    for (const m of missed) {
      const e: MissedSummaryEntry = { medicationId: m.medicationId, dueAt: m.dueAt.toISOString(), ...(m.escalated ? { escalated: true } : {}) }
      const prevEntry = merged.get(key(e))
      merged.set(key(e), prevEntry?.escalated ? { ...e, escalated: true } : e)
    }
    await this.d.repo.setKV(KV_MISSED, JSON.stringify([...merged.values()].slice(-50)))
  }

  private async persistFired(): Promise<void> {
    const list = [...this.fired].slice(-500)
    this.fired = new Set(list)
    await this.d.repo.setKV(KV_FIRED, JSON.stringify(list))
  }

  /** Developer helper: present an alarm immediately for the given (possibly synthetic) med. */
  fireTest(med: Medication, dueInMs = 0): void {
    const dueAt = new Date(this.d.clock.now().getTime() + dueInMs)
    this.d.presenter.present({ id: `test|${dueAt.toISOString()}`, medicationId: med.id, dueAt, fireAt: this.d.clock.now(), offsetMin: 0, kind: 'due' }, med)
  }

  stop(): void {
    if (this.handle != null) this.d.timers.clearTimer(this.handle)
    this.handle = null
  }
}
