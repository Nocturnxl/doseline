import type { Medication } from './types'
import type { AccessTokenProvider, CalendarGateway, Clock, Logger, Repository, SyncJob, SyncTarget } from './ports'
import { AuthRequiredError, GatewayError } from './ports'
import { APP_MARKER, CALENDAR_DESCRIPTION, CALENDAR_NAME, buildDoseEvent, buildRefillEvent, eventNeedsUpdate, type CalendarEvent, type CalendarEventBody } from './calendar'
import { computeNextDue } from './schedule'
import { effectiveOffsets, wantsAlarms } from './alarms'
import { inventoryStatus } from './inventory'
import { localDateKey, MINUTE } from './time'

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'offline' | 'error' | 'reconnect'

export interface SyncStatus {
  state: SyncState
  pending: number
  lastSyncAt: string | null
  lastError: string | null
}

export interface SyncDeps {
  repo: Repository
  gateway: CalendarGateway
  auth: AccessTokenProvider
  clock: Clock
  zone: () => string
  logger: Logger
  onStatus?: (s: SyncStatus) => void
  /** Jitter source in [0, 1); injectable for tests. */
  random?: () => number
}

const KV_CALENDAR = 'google.calendarId'
const MAX_CLIENT_ERROR_ATTEMPTS = 5

/** Exponential backoff: 30s, 1m, 2m, ... capped at 30 min, ±20% jitter. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * MINUTE)
  return Math.round(base * (0.8 + 0.4 * random()))
}

export function refillTarget(medId: string): SyncTarget {
  return `refill:${medId}`
}

/**
 * Keeps Google Calendar in line with local state. Each medication has at most one
 * "next dose" event; work is expressed as idempotent per-medication reconcile jobs that
 * are persisted, so offline changes are retried with backoff and never duplicated.
 */
export class CalendarSync {
  private running = false
  private rerun = false
  private authBroken = false
  private lastErrorKind: GatewayError['kind'] | 'other' | null = null
  private status: SyncStatus = { state: 'disabled', pending: 0, lastSyncAt: null, lastError: null }

  constructor(private d: SyncDeps) {}

  getStatus(): SyncStatus {
    return this.status
  }

  /** Clear the auth failure flag after the user reconnects. */
  authRestored(): void {
    this.authBroken = false
  }

  async enqueue(targets: SyncTarget[]): Promise<void> {
    const now = this.d.clock.now().toISOString()
    for (const target of new Set(targets)) {
      await this.d.repo.saveSyncJob({ target, attempts: 0, nextAttemptAt: now, lastError: null })
    }
    await this.publish()
  }

  async enqueueMeds(medIds: string[]): Promise<void> {
    await this.enqueue(medIds.flatMap((id) => [id, refillTarget(id)]))
  }

  async enqueueAll(): Promise<void> {
    const meds = await this.d.repo.listMedications()
    await this.enqueueMeds(meds.map((m) => m.id))
  }

  async reset(): Promise<void> {
    for (const j of await this.d.repo.listSyncJobs()) await this.d.repo.deleteSyncJob(j.target)
    await this.d.repo.clearEventLinks()
    await this.d.repo.setKV(KV_CALENDAR, null)
    this.authBroken = false
    this.lastErrorKind = null
    this.status = { ...this.status, lastError: null }
    await this.publish()
  }

  /** Earliest time a queued job is due, for scheduling the next run. */
  async nextRunAt(): Promise<Date | null> {
    const jobs = await this.d.repo.listSyncJobs()
    if (!jobs.length) return null
    return new Date(Math.min(...jobs.map((j) => new Date(j.nextAttemptAt).getTime())))
  }

  /** Process all due jobs. Safe to call often; concurrent calls coalesce. */
  async run(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    try {
      do {
        this.rerun = false
        await this.runOnce()
      } while (this.rerun)
    } finally {
      this.running = false
      await this.publish()
    }
  }

  private async runOnce(): Promise<void> {
    if (!(await this.d.auth.isConnected()) || this.authBroken) {
      await this.publish()
      return
    }
    const now = this.d.clock.now()
    const jobs = (await this.d.repo.listSyncJobs()).filter((j) => new Date(j.nextAttemptAt) <= now)
    if (!jobs.length) return
    this.setState('syncing')
    for (const job of jobs) {
      try {
        await this.process(job.target)
        await this.d.repo.deleteSyncJob(job.target)
        this.lastErrorKind = null
        this.status.lastSyncAt = this.d.clock.now().toISOString()
        this.status.lastError = null
      } catch (err) {
        const stop = await this.handleError(job, err)
        if (stop) break
      }
    }
  }

  /** Returns true if the whole run should stop (offline / auth). */
  private async handleError(job: SyncJob, err: unknown): Promise<boolean> {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof AuthRequiredError || (err instanceof GatewayError && err.kind === 'auth')) {
      this.authBroken = true
      this.lastErrorKind = 'auth'
      this.status.lastError = 'Google access was revoked or expired. Reconnect to resume syncing.'
      this.d.logger.warn('calendar sync: auth required')
      return true
    }
    const kind = err instanceof GatewayError ? err.kind : 'other'
    this.lastErrorKind = kind
    this.status.lastError = kind === 'offline' ? 'Offline. Changes will sync when you reconnect.' : msg
    const attempts = job.attempts + 1
    if (kind === 'client' && attempts >= MAX_CLIENT_ERROR_ATTEMPTS) {
      this.d.logger.error('calendar sync: dropping job after repeated client errors', { target: job.target, error: msg })
      await this.d.repo.deleteSyncJob(job.target)
      return false
    }
    const next = new Date(this.d.clock.now().getTime() + backoffMs(attempts, this.d.random))
    await this.d.repo.saveSyncJob({ target: job.target, attempts, nextAttemptAt: next.toISOString(), lastError: msg })
    if (kind !== 'offline') this.d.logger.warn('calendar sync: job failed', { target: job.target, kind, attempts })
    return kind === 'offline'
  }

  private async calendarId(): Promise<string> {
    const { repo, gateway } = this.d
    const stored = await repo.getKV(KV_CALENDAR)
    if (stored) return stored
    let cal = gateway.findAppCalendar ? await gateway.findAppCalendar(CALENDAR_NAME, CALENDAR_DESCRIPTION).catch(() => null) : null
    if (!cal) cal = await gateway.createCalendar(CALENDAR_NAME, CALENDAR_DESCRIPTION, this.d.zone())
    await repo.setKV(KV_CALENDAR, cal.id)
    this.d.logger.info('calendar sync: using calendar', { created: true })
    return cal.id
  }

  /** Run fn against the app calendar; if the calendar vanished (deleted by the user), recreate it once. */
  private async withCalendar<T>(fn: (calendarId: string) => Promise<T>): Promise<T> {
    const id = await this.calendarId()
    try {
      return await fn(id)
    } catch (err) {
      if (err instanceof GatewayError && (err.kind === 'notFound' || err.kind === 'gone')) {
        const exists = await this.d.gateway.getCalendar(id).catch(() => null)
        if (!exists) {
          this.d.logger.warn('calendar sync: app calendar missing, recreating')
          await this.d.repo.setKV(KV_CALENDAR, null)
          await this.d.repo.clearEventLinks()
          return fn(await this.calendarId())
        }
      }
      throw err
    }
  }

  async desiredFor(target: SyncTarget): Promise<CalendarEventBody | null> {
    const { repo, clock, zone } = this.d
    const isRefill = target.startsWith('refill:')
    const medId = isRefill ? target.slice('refill:'.length) : target
    const med = await repo.getMedication(medId)
    if (!med) return null
    const logs = await repo.listLogs({ medicationId: medId })
    const now = clock.now()
    if (isRefill) {
      if (!med.inventory?.refillEvent || !med.active) return null
      const st = inventoryStatus(med, logs, now)
      if (!st || !st.low) return null
      const link = await repo.getEventLink(target)
      const date = link?.doseKey.startsWith('date:') ? link.doseKey.slice(5) : localDateKey(now, zone())
      return buildRefillEvent(med, date, st.count)
    }
    if (!wantsAlarms(med)) return null
    const next = computeNextDue(med, logs, now, zone())
    if (!next) return null
    const settings = await repo.getSettings()
    return buildDoseEvent(med, next.dueAt, zone(), effectiveOffsets(med, settings), next.kind)
  }

  /** Make Google match the desired state for one target. Idempotent. */
  async process(target: SyncTarget): Promise<void> {
    const desired = await this.desiredFor(target)
    const { gateway, repo, clock } = this.d
    const isRefill = target.startsWith('refill:')
    const medId = isRefill ? target.slice('refill:'.length) : target
    await this.withCalendar(async (calId) => {
      const found = await gateway.findEvents(calId, { app: APP_MARKER, medicationId: medId, kind: isRefill ? 'refill' : 'dose' })
      if (!desired) {
        for (const ev of found) await gateway.deleteEvent(calId, ev.id)
        await repo.deleteEventLink(target)
        return
      }
      const wantKey = desired.extendedProperties.private.doseId!
      const keep: CalendarEvent | undefined = found.find((e) => e.extendedProperties?.private?.doseId === wantKey) ?? found[0]
      for (const ev of found) if (ev !== keep) await gateway.deleteEvent(calId, ev.id)
      let saved: CalendarEvent
      if (!keep) saved = await gateway.insertEvent(calId, desired)
      else if (eventNeedsUpdate(keep, desired)) saved = await gateway.patchEvent(calId, keep.id, desired)
      else saved = keep
      const key = isRefill ? `date:${desired.start.date}` : wantKey
      await repo.saveEventLink({ target, calendarId: calId, eventId: saved.id, doseKey: key, updatedAt: clock.now().toISOString() })
    })
  }

  /** Developer helper: an event two minutes out to verify the Google side end-to-end. */
  async createTestEvent(med: Medication, at: Date): Promise<CalendarEvent> {
    return this.withCalendar(async (calId) => {
      const body = buildDoseEvent(med, at, this.d.zone(), [1])
      body.summary = `💊 Doseline test event`
      body.extendedProperties.private = { app: APP_MARKER, kind: 'test', medicationId: 'test', doseId: `test@${at.toISOString()}` }
      return this.d.gateway.insertEvent(calId, body)
    })
  }

  private setState(state: SyncState): void {
    this.status = { ...this.status, state }
    this.d.onStatus?.(this.status)
  }

  private async publish(): Promise<void> {
    const connected = await this.d.auth.isConnected().catch(() => false)
    const jobs = await this.d.repo.listSyncJobs()
    let state: SyncState
    if (!connected) state = 'disabled'
    else if (this.authBroken) state = 'reconnect'
    else if (this.running) state = 'syncing'
    else if (this.lastErrorKind === 'offline' && jobs.length) state = 'offline'
    else if (this.lastErrorKind && jobs.length) state = 'error'
    else state = 'idle'
    this.status = { ...this.status, state, pending: jobs.length }
    this.d.onStatus?.(this.status)
  }
}
