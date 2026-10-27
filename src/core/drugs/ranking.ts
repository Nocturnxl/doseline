/** Client-side ordering for drug suggestions and strength chips. */
import { compareStrengthNumeric, joinStrength, parseStrength, splitStrength, strengthKey } from './strength'
import type { DrugMatch, StrengthOption } from './types'

export const SUGGESTION_LIMIT = 12

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** Medications the user already has, to float them to the top. */
export interface OwnedDrugs {
  /** catalogName of linked medications. */
  displayNames: Iterable<string>
  /** Names of all medications (matches unlinked ones by name). */
  names: Iterable<string>
}

/**
 * 0 = already in Doseline, 1 = first word starts with the query, 2 = any word starts with it, 3 = other.
 * Multi-word queries need every query word to prefix some word of the name.
 */
export function matchTier(m: DrugMatch, query: string, owned?: { displayNames: Set<string>; names: Set<string> }): number {
  if (owned && (owned.displayNames.has(m.displayName) || owned.names.has(m.name.toLowerCase()))) return 0
  const q = words(query)
  if (!q.length) return 3
  const w = words(m.name)
  const allPrefix = q.every((t) => w.some((x) => x.startsWith(t)))
  if (allPrefix && w[0]?.startsWith(q[0]!)) return 1
  if (allPrefix) return 2
  return 3
}

/**
 * Within a tier, shorter names come first, blended with NLM's own result order (which is
 * relevance-weighted): key = server position + LENGTH_WEIGHT × name length. Pure shortest-first
 * floated rare short brands (METROGEL, METHITEST) above Metoprolol XR and Methotrexate for "met".
 */
const LENGTH_WEIGHT = 0.5

export function rankDrugMatches(matches: DrugMatch[], query: string, owned?: OwnedDrugs, limit = SUGGESTION_LIMIT): DrugMatch[] {
  const o = owned ? { displayNames: new Set(owned.displayNames), names: new Set([...owned.names].map((n) => n.trim().toLowerCase())) } : undefined
  const seen = new Set<string>()
  return matches
    .filter((m) => !seen.has(m.displayName) && seen.add(m.displayName))
    .map((m, i) => ({ m, i, tier: matchTier(m, query, o), key: i + LENGTH_WEIGHT * m.name.length }))
    .sort((a, b) => a.tier - b.tier || a.key - b.key || a.m.name.length - b.m.name.length || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.m)
}

export interface TextSegment {
  text: string
  match: boolean
}

/** Splits text into segments, marking every word prefix that matches a query word (for bolding). */
export function highlightSegments(text: string, query: string): TextSegment[] {
  const q = words(query).sort((a, b) => b.length - a.length)
  const marks = new Array<boolean>(text.length).fill(false)
  if (q.length) {
    const re = /[A-Za-z0-9]+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const w = m[0].toLowerCase()
      const t = q.find((x) => w.startsWith(x))
      if (t) for (let i = 0; i < t.length; i++) marks[m.index + i] = true
    }
  }
  const out: TextSegment[] = []
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1]
    if (last && last.match === marks[i]) last.text += text[i]
    else out.push({ text: text[i]!, match: marks[i]! })
  }
  return out
}

// ------------------------------------------------------------------ strengths

/** A strength the user has saved before for this drug. */
export interface UsedStrength {
  strength: string
  form?: string | null
  rxcui?: string | null
}

export interface StrengthChip {
  option: StrengthOption
  yours: boolean
  common: boolean
  /** A remembered custom entry that isn't in RxTerms. */
  custom: boolean
}

export interface StrengthGroup {
  /** Stable key (RxTerms form, or "custom"). */
  key: string
  label: string
  chips: StrengthChip[]
}

export interface GroupOptions {
  used?: UsedStrength[]
  /** openFDA scores keyed by option.raw; null/undefined while loading or after a failure. */
  scores?: Record<string, number> | null
  /** How many chips per form may carry the "Common" marker. */
  commonPerForm?: number
}

function isUsed(o: StrengthOption, u: UsedStrength): boolean {
  if (u.rxcui && o.rxcuis.includes(u.rxcui)) return true
  if (!o.parsed) return u.strength.trim() === o.raw
  if (strengthKey(u.strength) !== strengthKey(joinStrength(o.value, o.unit))) return false
  return !u.form || u.form.trim().toLowerCase() === o.formLabel.toLowerCase()
}

/** Builds an option for a custom strength so it can be shown as a chip. */
export function customOption(u: UsedStrength): StrengthOption {
  const { value, unit } = splitStrength(u.strength)
  const base = parseStrength(u.strength)
  return { ...base, raw: `custom:${u.strength}|${u.form ?? ''}`, value, unit, form: u.form ?? '', formLabel: u.form ?? base.formLabel, formGroup: 'Your entries', parsed: true, rxcuis: [], variants: [], score: null }
}

/**
 * Groups options by form and orders chips: strengths you've used → openFDA commonness → numeric.
 * Groups containing your strengths come first, then groups with more listed products, then RxTerms order.
 */
export function groupStrengths(options: StrengthOption[], opts: GroupOptions = {}): StrengthGroup[] {
  const used = opts.used ?? []
  const scores = opts.scores ?? null
  const perForm = opts.commonPerForm ?? 3
  const groups = new Map<string, { key: string; label: string; chips: StrengthChip[]; order: number }>()
  const matchedUsed = new Set<UsedStrength>()

  options.forEach((o, i) => {
    const key = o.parsed ? o.form || o.formGroup : `raw:${o.formGroup}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { key, label: o.formGroup, chips: [], order: i }))
    const u = used.find((x) => isUsed(o, x))
    if (u) matchedUsed.add(u)
    g.chips.push({ option: { ...o, score: scores ? (scores[o.raw] ?? 0) : null }, yours: !!u, common: false, custom: false })
  })

  for (const g of groups.values()) {
    g.chips.sort((a, b) => Number(b.yours) - Number(a.yours) || (scores ? (b.option.score ?? 0) - (a.option.score ?? 0) : 0) || compareStrengthNumeric(a.option, b.option))
    if (scores && g.chips.length > 1) {
      const all = g.chips.map((c) => c.option.score ?? 0)
      const max = Math.max(...all)
      const min = Math.min(...all)
      const k = Math.min(perForm, Math.floor(g.chips.length / 2) || 1)
      // A chip must stand out: above the group's least-listed strength (ties carry no signal).
      ;[...g.chips]
        .filter((c) => (c.option.score ?? 0) > min && (c.option.score ?? 0) >= max * 0.25)
        .sort((a, b) => (b.option.score ?? 0) - (a.option.score ?? 0))
        .slice(0, k)
        .forEach((c) => (c.common = true))
    }
  }

  const total = (g: { chips: StrengthChip[] }) => g.chips.reduce((s, c) => s + (c.option.score ?? 0), 0)
  const ordered = [...groups.values()].sort(
    (a, b) => Number(b.chips.some((c) => c.yours)) - Number(a.chips.some((c) => c.yours)) || (scores ? total(b) - total(a) : 0) || a.order - b.order,
  )

  const customs = used.filter((u) => !matchedUsed.has(u) && u.strength.trim())
  const result: StrengthGroup[] = ordered.map(({ key, label, chips }) => ({ key, label, chips }))
  if (customs.length) {
    const seen = new Set<string>()
    const chips = customs
      .filter((u) => {
        const k = `${strengthKey(u.strength)}|${(u.form ?? '').toLowerCase()}`
        return !seen.has(k) && seen.add(k)
      })
      .map((u) => ({ option: customOption(u), yours: true, common: false, custom: true }))
    result.unshift({ key: 'custom', label: 'Your entries', chips })
  }
  return result
}
