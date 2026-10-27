import type { Settings } from './types'
import { DEFAULT_SETTINGS } from './types'
import { clampRepeat, clampThreshold } from './escalation'
import { isValidClock } from './time'

type SettingsPatch = Partial<Omit<Settings, 'sound' | 'escalation'>> & {
  sound?: Partial<Settings['sound']>
  escalation?: Partial<Omit<Settings['escalation'], 'quietHours'>> & { quietHours?: Partial<Settings['escalation']['quietHours']> }
}

/** Deep-merges stored or patched settings over a base, filling every nested default and clamping ranges. */
export function mergeSettings(patch: SettingsPatch | null | undefined, base: Settings = DEFAULT_SETTINGS): Settings {
  const p = patch ?? {}
  const esc = { ...base.escalation, ...(p.escalation ?? {}), quietHours: { ...base.escalation.quietHours, ...(p.escalation?.quietHours ?? {}) } }
  esc.thresholdMinutes = clampThreshold(Number(esc.thresholdMinutes) || DEFAULT_SETTINGS.escalation.thresholdMinutes)
  esc.repeatMinutes = clampRepeat(Number(esc.repeatMinutes) || DEFAULT_SETTINGS.escalation.repeatMinutes)
  if (!isValidClock(esc.quietHours.start)) esc.quietHours.start = DEFAULT_SETTINGS.escalation.quietHours.start
  if (!isValidClock(esc.quietHours.end)) esc.quietHours.end = DEFAULT_SETTINGS.escalation.quietHours.end
  return { ...base, ...(p as Partial<Settings>), sound: { ...base.sound, ...(p.sound ?? {}) }, escalation: esc }
}

export type { SettingsPatch }
