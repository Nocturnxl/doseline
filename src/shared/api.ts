/** Types shared by main, preload and renderer. Type-only: no runtime code crosses this file. */
import type { DoseKind, DoseLog, Medication, SafetyWarning, Settings } from '../core/types'
import type { SyncStatus } from '../core/sync'
import type { MissedSummaryEntry } from '../core/alarmEngine'
import type { DrugMatch, StrengthOption, StrengthRanking, UsedStrength } from '../core/drugs'
import type { SettingsPatch } from '../core/settings'

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface GoogleState {
  /** An OAuth client ID/secret has been entered. */
  configured: boolean
  clientId: string | null
  connected: boolean
  email: string | null
  needsReconnect: boolean
  calendarName: string
  connecting: boolean
}

export interface PlatformInfo {
  version: string
  mica: boolean
  isPackaged: boolean
  logPath: string
}

export interface AppSnapshot {
  meds: Medication[]
  logs: DoseLog[]
  settings: Settings
  zone: string
  google: GoogleState
  sync: SyncStatus
  drugs: { openFdaKeySet: boolean }
  /** Doses currently in overdue escalation. */
  escalations: EscalationView[]
  missed: MissedSummaryEntry[]
  platform: PlatformInfo
}

export interface EscalationView {
  medicationId: string
  dueAt: string
  /** When escalation started (first alarm, or the threshold crossing if it hasn't fired yet). */
  escalatedAt: string
  repeats: number
  /** Next escalation alarm, if one is scheduled. */
  nextAt: string | null
}

export type MedicationInput = Omit<Medication, 'id' | 'createdAt' | 'updatedAt' | 'pauses'> & { id?: string }

export interface LogDoseRequest {
  medicationId: string
  kind: DoseKind
  at?: string
  note?: string
}

export interface LogDoseResponse {
  log: DoseLog
  warnings: SafetyWarning[]
  undoToken: string
}

export interface AlarmView {
  key: string
  medicationId: string
  name: string
  strength: string
  dose: string
  instructions: string
  color: string
  icon: Medication['icon']
  dueAt: string
  offsetMin: number
  kind: 'reminder' | 'due' | 'snooze' | 'escalation'
  /** Escalation only: when it started and how many repeats have fired. */
  escalatedAt?: string
  repeats?: number
  test?: boolean
}

export type AlarmAction = 'take' | 'takeAt' | 'skip' | 'snooze' | 'dismiss'

export interface AlarmWindowState {
  alarms: AlarmView[]
  sound: Settings['sound']
  /** The escalation sound (uses the same volume and master switch as other alarms). */
  escalationSound: Settings['escalation']['sound']
  theme: Settings['theme']
  /** Increments whenever a new alarm arrives, so the window can replay the chime. */
  ring: number
  /** What the latest ring should sound like: escalations use their own sound, or none in quiet hours. */
  ringSound: 'normal' | 'escalation' | 'silent'
}

export interface ExportRange {
  from?: string
  to?: string
  medicationId?: string
}

export type ToastKind = 'error' | 'info' | 'success'

export interface ToastMessage {
  kind: ToastKind
  message: string
}

/** Error values returned by the drug lookup calls. */
export type DrugErrorCode = 'offline' | 'unavailable' | 'aborted' | 'disabled'

export type Route = 'today' | 'meds' | 'history' | 'adherence' | 'inventory' | 'settings'

export interface DoselineApi {
  getSnapshot(): Promise<AppSnapshot>
  onSnapshot(cb: (s: AppSnapshot) => void): () => void
  reportZone(zone: string): void

  saveMedication(input: MedicationInput): Promise<Result<Medication>>
  deleteMedication(id: string): Promise<Result<void>>
  setActive(id: string, active: boolean): Promise<Result<void>>
  adjustInventory(id: string, count: number): Promise<Result<void>>

  previewWarnings(medicationId: string, at?: string): Promise<SafetyWarning[]>
  logDose(req: LogDoseRequest): Promise<Result<LogDoseResponse>>
  undo(token: string): Promise<Result<boolean>>
  updateLog(id: string, patch: { takenAt?: string; kind?: DoseKind; note?: string }): Promise<Result<void>>
  deleteLog(id: string): Promise<Result<void>>

  updateSettings(patch: SettingsPatch): Promise<Result<Settings>>
  dismissMissed(): Promise<void>

  googleSaveClient(clientId: string, clientSecret: string): Promise<Result<void>>
  googleClearClient(): Promise<Result<void>>
  googleConnect(): Promise<Result<void>>
  googleCancelConnect(): Promise<void>
  googleDisconnect(): Promise<Result<void>>
  syncNow(): Promise<void>

  exportCsv(range: ExportRange): Promise<Result<string | null>>
  exportPdf(range: ExportRange): Promise<Result<string | null>>
  exportBackup(): Promise<Result<string | null>>
  importBackup(): Promise<Result<boolean>>

  /** RxTerms search. Pass a fresh requestId per query so drugCancel can abort it. Errors are DrugErrorCode. */
  drugSearch(query: string, requestId: string): Promise<Result<DrugMatch[]>>
  drugCancel(requestId: string): void
  drugStrengths(drug: DrugMatch): Promise<Result<StrengthOption[]>>
  drugRanking(drug: DrugMatch): Promise<Result<StrengthRanking>>
  drugUsedStrengths(displayName: string): Promise<UsedStrength[]>
  setOpenFdaKey(key: string | null): Promise<Result<void>>

  devFireTestAlarm(): Promise<void>
  /** Creates `count` real test medications due in `dueInMin` minutes (defaults: 1 dose, 2 minutes). */
  devCreateTestDose(opts?: { count?: number; dueInMin?: number }): Promise<Result<string>>
  /** Replaces all local data with the fictional demo dataset (refused while Google is connected). */
  devLoadDemoData(): Promise<Result<string>>
  /** Shows the escalated alarm window with `count` fake overdue medications. */
  devFireTestEscalation(count: number): Promise<void>
  openLogFolder(): Promise<void>
  openExternal(url: string): Promise<void>

  alarmGetState(): Promise<AlarmWindowState>
  onAlarmState(cb: (s: AlarmWindowState) => void): () => void
  /** `arg` is snooze minutes, or the ISO time for 'takeAt'. */
  alarmAct(key: string, action: AlarmAction, arg?: number | string): Promise<Result<void>>
  /** The alarm window asks for a size that fits its content. */
  alarmResize(height: number, width: number): void

  paletteClose(): void
  openPalette(): void
  onPaletteOpen(cb: () => void): () => void
  reportReady(): void

  onToast(cb: (t: ToastMessage) => void): () => void
  onNavigate(cb: (route: Route) => void): () => void
}
