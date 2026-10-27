import type { DoseLog, Medication, SafetyWarning } from './types'
import { MINUTE } from './time'
import { logsFor, prnAvailableAt, takenInLast24h } from './schedule'

/** Two "taken" logs this close together are probably a double-tap. */
export const DUPLICATE_WINDOW_MIN = 30

function fmtTime(d: Date, zone: string): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone })
}

/**
 * Safety checks for logging a dose at `at`. These are warnings only; the caller decides
 * whether to ask for confirmation. Never a hard block.
 */
export function checkSafety(med: Medication, allLogs: DoseLog[], at: Date, zone: string, excludeLogId?: string): SafetyWarning[] {
  const logs = logsFor(med.id, allLogs).filter((l) => l.id !== excludeLogId)
  const warnings: SafetyWarning[] = []

  const near = logs.find(
    (l) => l.kind === 'taken' && Math.abs(new Date(l.takenAt).getTime() - at.getTime()) < DUPLICATE_WINDOW_MIN * MINUTE,
  )
  if (near) {
    warnings.push({
      code: 'duplicate',
      message: `${med.name} was already logged at ${fmtTime(new Date(near.takenAt), zone)}. This may be a duplicate.`,
    })
  }

  const s = med.schedule
  if (s.type === 'prn') {
    const prior = logs.filter((l) => new Date(l.takenAt) <= at)
    const available = prnAvailableAt(s, prior)
    const lastBefore = prior.filter((l) => l.kind === 'taken').sort((a, b) => b.takenAt.localeCompare(a.takenAt))[0]
    if (lastBefore && at.getTime() - new Date(lastBefore.takenAt).getTime() < s.minIntervalHours * 60 * MINUTE) {
      warnings.push({
        code: 'prn-too-soon',
        message: `Less than ${s.minIntervalHours} h since the last dose. Next dose is available at ${fmtTime(available!, zone)}.`,
      })
    }
    if (s.maxPer24h && takenInLast24h(prior, at) + 1 > s.maxPer24h) {
      warnings.push({
        code: 'prn-max-24h',
        message: `This would exceed the maximum of ${s.maxPer24h} doses in 24 hours.`,
      })
    }
  }
  return warnings
}
