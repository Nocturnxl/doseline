/**
 * Domain types. Everything in src/core is platform-agnostic: no Electron, no Node APIs.
 * Instants are stored as ISO-8601 UTC strings; wall-clock values use explicit IANA zones.
 */

export type ISODateTime = string // e.g. 2026-10-26T14:00:00.000Z
export type LocalDate = string // e.g. 2026-10-26 (YYYY-MM-DD, interpreted in the user's zone)
export type ClockTime = string // e.g. 08:30 (HH:mm, 24h)

/** ISO weekday: 1 = Monday ... 7 = Sunday */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface IntervalSchedule {
  type: 'interval'
  /** Hours between doses, measured from the last logged dose (absolute elapsed time). */
  everyHours: number
  /** When the very first dose is due if nothing has been logged yet. Defaults to creation time. */
  firstDoseAt?: ISODateTime
}

export interface FixedSchedule {
  type: 'fixed'
  /** Wall-clock times, evaluated in the user's current time zone. */
  times: ClockTime[]
  days: Weekday[]
}

export interface PrnSchedule {
  type: 'prn'
  /** Minimum hours between doses. */
  minIntervalHours: number
  /** Optional cap on doses in any rolling 24h window. */
  maxPer24h?: number | null
  /** Schedule an alarm + calendar event for when the next dose becomes available. */
  notifyWhenAvailable: boolean
}

export type Schedule = IntervalSchedule | FixedSchedule | PrnSchedule
export type ScheduleType = Schedule['type']

export interface Inventory {
  /** Units on hand (tablets, ml, puffs...). */
  count: number
  /** Units consumed by a single dose. */
  unitsPerDose: number
  /** Alert when count is at or below this many units. */
  refillThreshold: number
  /** Create an all-day "Refill" calendar event when supply runs low. */
  refillEvent: boolean
}

export interface PauseRange {
  from: ISODateTime
  to?: ISODateTime | null
}

export interface Medication {
  id: string
  name: string
  /** e.g. "10 mg" */
  strength: string
  /** e.g. "tablet" */
  form: string
  doseAmount: number
  doseUnit: string
  instructions: string
  color: string // #rrggbb
  icon: MedIcon
  notes: string
  schedule: Schedule
  active: boolean
  pauses: PauseRange[]
  startDate?: LocalDate | null
  endDate?: LocalDate | null
  inventory?: Inventory | null
  /** Minutes-before-due reminder offsets; null/undefined = use global defaults. */
  reminderOffsets?: number[] | null
  /** Overdue escalation threshold in minutes: null/undefined = global default, 0 = off. */
  escalationMinutes?: number | null
  /** RxNorm concept of the linked catalog entry (drug + route group); null for free-text names. */
  rxcui?: string | null
  /** RXCUI of the selected catalog strength + form, when a strength chip was used. */
  strengthRxcui?: string | null
  /** Catalog display name, e.g. "Metoprolol XR (Oral Pill)"; null for free-text names. */
  catalogName?: string | null
  catalogSource?: 'rxterms' | null
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

export type MedIcon = 'pill' | 'capsule' | 'tablet' | 'drop' | 'syringe' | 'inhaler' | 'patch' | 'bottle' | 'heart' | 'leaf'

export const MED_ICONS: MedIcon[] = ['pill', 'capsule', 'tablet', 'drop', 'syringe', 'inhaler', 'patch', 'bottle', 'heart', 'leaf']

export type DoseKind = 'taken' | 'skipped'

export interface DoseLog {
  id: string
  medicationId: string
  kind: DoseKind
  /** When the dose was taken (or when the skip was recorded). */
  takenAt: ISODateTime
  /** The scheduled slot this log fulfils, if the med is scheduled. */
  scheduledFor?: ISODateTime | null
  /** Inventory units removed by this log (positive number), so edits/deletes can restore it. */
  inventoryDelta: number
  note?: string
  /** When this dose's overdue escalation first fired (copied from its escalation record at log time). */
  escalatedAt?: ISODateTime | null
  /** Escalation repeats fired before the dose was logged. */
  escalationRepeats?: number
  createdAt: ISODateTime
}

export type ThemePref = 'dark' | 'light' | 'system'

export interface Settings {
  reminderOffsets: number[]
  graceMinutes: number
  sound: { enabled: boolean; volume: number; choice: SoundChoice }
  theme: ThemePref
  launchAtLogin: boolean
  hotkey: string
  onboarded: boolean
  devMode: boolean
  /** Online drug-name suggestions (NLM RxTerms) and strength ranking (openFDA). */
  drugLookup: boolean
  escalation: EscalationSettings
}

export interface EscalationSettings {
  /** Minutes past due before the escalated alarm starts (5-360). */
  thresholdMinutes: number
  /** Minutes between escalation repeats (5-60). */
  repeatMinutes: number
  sound: SoundChoice
  /** During quiet hours escalation still shows and flashes, but plays no sound. */
  quietHours: { enabled: boolean; start: ClockTime; end: ClockTime }
}

/**
 * Persisted escalation state for one dose (medication + due instant). Whether the dose is
 * still unresolved is always derived from logs, never from this record.
 */
export interface EscalationRecord {
  medicationId: string
  dueAt: ISODateTime
  /** When escalation first fired (or, if it happened while the PC was away, when it would have). */
  escalatedAt: ISODateTime
  /** Last time an escalation alarm fired or was folded into the away summary; repeats count from here. */
  lastFiredAt: ISODateTime
  /** Repeats fired after the first escalation alarm. */
  repeats: number
  /** Snooze: the next repeat waits until at least this instant. */
  snoozedUntil: ISODateTime | null
  /** Derived bookkeeping for history: how the dose ended, once it's no longer pending. */
  resolution: 'taken' | 'skipped' | 'missed' | null
}

export type SoundChoice = 'chime' | 'bell' | 'pulse' | 'urgent' | 'siren'

export const DEFAULT_SETTINGS: Settings = {
  reminderOffsets: [30, 15],
  graceMinutes: 60,
  sound: { enabled: true, volume: 0.7, choice: 'chime' },
  theme: 'system',
  launchAtLogin: true,
  hotkey: 'Ctrl+Alt+M',
  onboarded: false,
  devMode: false,
  drugLookup: true,
  escalation: {
    thresholdMinutes: 30,
    repeatMinutes: 15,
    sound: 'urgent',
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
  },
}

export type DoseStatus = 'upcoming' | 'due' | 'overdue' | 'taken' | 'skipped' | 'missed'

export interface NextDue {
  dueAt: Date
  /** 'scheduled' for interval/fixed; 'available' for PRN (when the next dose may be taken). */
  kind: 'scheduled' | 'available'
  /** Start of the current dose period (previous dose or slot), for progress rings. */
  periodStart: Date
}

export interface Snooze {
  id: string
  medicationId: string
  dueAt: ISODateTime
  fireAt: ISODateTime
}

export type SafetyWarningCode = 'prn-too-soon' | 'prn-max-24h' | 'duplicate'

export interface SafetyWarning {
  code: SafetyWarningCode
  message: string
}
