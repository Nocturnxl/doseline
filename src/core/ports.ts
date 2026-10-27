/**
 * Platform ports. src/core depends only on these interfaces; the Electron app supplies
 * implementations in src/main, and a future web build would supply its own.
 */
import type { DoseLog, EscalationRecord, Medication, Settings, Snooze } from './types'
import type { CalendarEvent, CalendarEventBody } from './calendar'
import type { MissedDose, PlannedAlarm } from './alarms'

export interface LogFilter {
  medicationId?: string
  from?: Date
  to?: Date
}

export type SyncTarget = string // `${medicationId}` or `refill:${medicationId}`

export interface SyncJob {
  target: SyncTarget
  attempts: number
  nextAttemptAt: string
  lastError?: string | null
}

export interface EventLink {
  target: SyncTarget
  calendarId: string
  eventId: string
  doseKey: string
  updatedAt: string
}

export interface BackupData {
  app: 'doseline'
  version: number
  exportedAt: string
  medications: Medication[]
  logs: DoseLog[]
  settings: Settings
  kv?: Record<string, string>
}

export interface Repository {
  listMedications(): Promise<Medication[]>
  getMedication(id: string): Promise<Medication | null>
  saveMedication(med: Medication): Promise<void>
  deleteMedication(id: string): Promise<void>

  listLogs(filter?: LogFilter): Promise<DoseLog[]>
  getLog(id: string): Promise<DoseLog | null>
  saveLog(log: DoseLog): Promise<void>
  deleteLog(id: string): Promise<void>

  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>

  listSnoozes(): Promise<Snooze[]>
  saveSnooze(s: Snooze): Promise<void>
  deleteSnooze(id: string): Promise<void>

  listSyncJobs(): Promise<SyncJob[]>
  saveSyncJob(job: SyncJob): Promise<void>
  deleteSyncJob(target: SyncTarget): Promise<void>

  getEventLink(target: SyncTarget): Promise<EventLink | null>
  saveEventLink(link: EventLink): Promise<void>
  deleteEventLink(target: SyncTarget): Promise<void>
  clearEventLinks(): Promise<void>

  /** Escalation state per dose (medication + due instant). */
  listEscalations(): Promise<EscalationRecord[]>
  saveEscalation(r: EscalationRecord): Promise<void>
  /** Drops records for doses due before `before` (housekeeping). */
  pruneEscalations(before: Date): Promise<void>

  getKV(key: string): Promise<string | null>
  setKV(key: string, value: string | null): Promise<void>

  exportAll(): Promise<BackupData>
  importAll(data: BackupData): Promise<void>
}

export interface Clock {
  now(): Date
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
}

/** One-shot timers. Electron uses setTimeout in the main process. */
export interface TimerScheduler {
  setTimer(at: Date, cb: () => void): unknown
  clearTimer(handle: unknown): void
}

/** Presents an alarm: system notification + alarm window, sound, etc. */
export interface EscalationAlert {
  med: Medication
  dueAt: Date
  escalatedAt: Date
  repeats: number
  /** True for the first escalation alarm of this dose. */
  first: boolean
}

export interface AlarmPresenter {
  present(alarm: PlannedAlarm, med: Medication): void
  /** One call per repeat cycle: every escalated dose in the cycle, one window and one sound. */
  presentEscalation(alerts: EscalationAlert[], opts: { quiet: boolean }): void
  showMissed(missed: MissedDose[]): void
}

export interface StoredTokens {
  refreshToken: string
  accessToken?: string
  accessTokenExpiresAt?: number
  email?: string | null
  scope?: string
}

/** Secure storage for OAuth secrets (Electron: safeStorage / DPAPI). */
export interface TokenStore {
  load(): Promise<StoredTokens | null>
  save(tokens: StoredTokens): Promise<void>
  clear(): Promise<void>
}

export class AuthRequiredError extends Error {
  constructor(message = 'Google authorization is required') {
    super(message)
    this.name = 'AuthRequiredError'
  }
}

/** Supplies a valid access token, refreshing as needed. Throws AuthRequiredError when re-auth is needed. */
export interface AccessTokenProvider {
  isConnected(): Promise<boolean>
  getAccessToken(forceRefresh?: boolean): Promise<string>
}

export type GatewayErrorKind = 'offline' | 'auth' | 'notFound' | 'gone' | 'rateLimit' | 'server' | 'client'

export class GatewayError extends Error {
  constructor(
    public kind: GatewayErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

export interface CalendarInfo {
  id: string
  summary: string
}

export interface CalendarGateway {
  /** Create the dedicated calendar (or find a previously created one). */
  createCalendar(name: string, description: string, zone: string): Promise<CalendarInfo>
  getCalendar(calendarId: string): Promise<CalendarInfo | null>
  findAppCalendar?(name: string, description: string): Promise<CalendarInfo | null>
  findEvents(calendarId: string, privateProps: Record<string, string>): Promise<CalendarEvent[]>
  insertEvent(calendarId: string, body: CalendarEventBody): Promise<CalendarEvent>
  patchEvent(calendarId: string, eventId: string, body: CalendarEventBody): Promise<CalendarEvent>
  /** Must treat already-deleted events (404/410) as success. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>
}
