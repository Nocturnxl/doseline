/**
 * Parser for RxTerms STRENGTHS_AND_FORMS strings, e.g.
 *   " 25 mg 24 HR XR Tab", "5-325 mg Tab", "10 mg/ml Susp", "0.1 mg/hr Patch",
 *   "90 mcg/puff NDA020503 MDI", "100 unt/ml Pen Injector 3 ml", "100-0.033 var units Pen Injector 3 ml".
 * Anything without a leading amount + unit (e.g. "mixed Pack") is returned unparsed but still selectable.
 */
import type { MedIcon } from '../types'
import type { RawStrength, StrengthOption } from './types'

const NUM = String.raw`(?:\d[\d,]*(?:\.\d+)?|\.\d+)`
// amount ("25", "5-325", "1,000-62.5"), unit ("mg", "mg/5ml", "mcg/puff", "unt/ml", "var units"), rest (form).
const STRENGTH_RE = new RegExp(String.raw`^(${NUM}(?:\s*-\s*${NUM})*)\s*(var\s+units|[A-Za-z%µ]+(?:\s*\/\s*${NUM}?\s*[A-Za-z]+)?)(?:\s+(.*))?$`)
const PACKAGE_RE = /\s+(\d[\d.,]*\s*(?:ml|mL|l|g|gm|puff|puffs|actuat|spray|sprays|dose|doses|patch|patches|ea|each))$/i
const APPLICATION_RE = /\b(?:NDA|ANDA|BLA)\d+\b\s*/g

/** Token expansions for readable form names. Order matters only for multi-word tokens. */
const FORM_WORDS: [RegExp, string][] = [
  [/\b(\d+) HR\b/g, '$1-hour'],
  [/\bXR\b|\bER\b|\bSR\b|\bCR\b|\bLA\b/g, 'extended-release'],
  [/\bDR\b|\bEC\b/g, 'delayed-release'],
  [/\bODT\b/g, 'orally disintegrating tablet'],
  [/\bMDI\b/g, 'metered-dose inhaler'],
  [/\bDPI\b/g, 'dry powder inhaler'],
  [/\bTab\b/g, 'tablet'],
  [/\bCap\b/g, 'capsule'],
  [/\bSol\b/g, 'solution'],
  [/\bSusp\b/g, 'suspension'],
  [/\bPwdr\b/g, 'powder'],
  [/\bOint\b/g, 'ointment'],
  [/\bSupp\b/g, 'suppository'],
  [/\bChewable\b/g, 'chewable'],
  [/\bUNT\b/g, 'unit'],
]

interface FormKind {
  test: RegExp
  /** Value for the Form field. */
  label: string
  /** Default per-dose unit; '' means "derive from the strength unit". */
  doseUnit: string
  icon: MedIcon
}

// First match wins, so more specific device names come before generic ones.
const FORM_KINDS: FormKind[] = [
  { test: /\bMDI\b|\bInhaler\b|\bHFA\b/i, label: 'inhaler', doseUnit: 'puff', icon: 'inhaler' },
  { test: /\bDPI\b/i, label: 'inhaler', doseUnit: 'puff', icon: 'inhaler' },
  { test: /\bPen Injector\b|\bAuto-Injector\b|\bAutoinjector\b/i, label: 'pen injector', doseUnit: '', icon: 'syringe' },
  { test: /\bPrefilled Syringe\b|\bSyringe\b/i, label: 'prefilled syringe', doseUnit: '', icon: 'syringe' },
  { test: /\bCartridge\b|\bInjection\b|\bInjectable\b|\bVial\b/i, label: 'injection', doseUnit: '', icon: 'syringe' },
  { test: /\bPatch\b|\bTransdermal\b/i, label: 'patch', doseUnit: 'patch', icon: 'patch' },
  { test: /\bODT\b|\bDisintegrating\b/i, label: 'orally disintegrating tablet', doseUnit: 'tablet', icon: 'tablet' },
  { test: /\bTab\b|\bTablet\b/i, label: 'tablet', doseUnit: 'tablet', icon: 'tablet' },
  { test: /\bCap\b|\bCapsule\b/i, label: 'capsule', doseUnit: 'capsule', icon: 'capsule' },
  { test: /\bSusp\b|\bSuspension\b/i, label: 'suspension', doseUnit: 'ml', icon: 'bottle' },
  { test: /\bSyrup\b|\bElixir\b/i, label: 'liquid', doseUnit: 'ml', icon: 'bottle' },
  { test: /\bDrops?\b|\bOphth\b|\bOtic\b/i, label: 'drops', doseUnit: 'drop', icon: 'drop' },
  { test: /\bSpray\b/i, label: 'spray', doseUnit: 'spray', icon: 'inhaler' },
  { test: /\bSol\b|\bSolution\b|\bLiquid\b/i, label: 'liquid', doseUnit: 'ml', icon: 'bottle' },
  { test: /\bCream\b/i, label: 'cream', doseUnit: 'application', icon: 'drop' },
  { test: /\bOint\b|\bOintment\b/i, label: 'ointment', doseUnit: 'application', icon: 'drop' },
  { test: /\bGel\b/i, label: 'gel', doseUnit: 'application', icon: 'drop' },
  { test: /\bLotion\b|\bFoam\b/i, label: 'lotion', doseUnit: 'application', icon: 'drop' },
  { test: /\bPwdr\b|\bPowder\b|\bGranules\b/i, label: 'powder', doseUnit: 'dose', icon: 'bottle' },
  { test: /\bSupp\b|\bSuppository\b/i, label: 'suppository', doseUnit: 'suppository', icon: 'pill' },
  { test: /\bLozenge\b|\bTroche\b|\bGum\b|\bFilm\b|\bStrip\b/i, label: 'other', doseUnit: 'piece', icon: 'pill' },
]

function formKind(form: string): FormKind | null {
  return FORM_KINDS.find((k) => k.test.test(form)) ?? null
}

function expandForm(form: string): string {
  let s = form
  for (const [re, rep] of FORM_WORDS) s = s.replace(re, rep)
  // "Osmotic", "Soft Gelatin" etc. are already words; lower-case them but keep remaining acronyms.
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w))
    .join(' ')
}

function displayUnit(unit: string): string {
  return unit
    .replace(/\s+/g, '')
    .replace(/^var(units)$/i, 'var units')
    .replace(/\bunt\b/gi, 'units')
    .replace(/mL/g, 'ml')
}

/** Parses one STRENGTHS_AND_FORMS string. Never throws. */
export function parseStrength(raw: string, rxcui: string | null = null): StrengthOption {
  const text = raw.replace(/\s+/g, ' ').trim()
  const m = STRENGTH_RE.exec(text)
  if (!m) {
    const kind = formKind(text)
    return {
      raw: text,
      rxcui,
      parsed: false,
      value: '',
      amounts: [],
      unit: '',
      form: text,
      formGroup: capitalize(expandForm(text)) || 'Other',
      formLabel: kind?.label ?? 'other',
      doseUnit: kind?.doseUnit || 'dose',
      details: [],
      variants: [text],
      rxcuis: rxcui ? [rxcui] : [],
      score: null,
    }
  }
  const value = m[1]!.replace(/\s+/g, '')
  const amounts = value.split('-').map((a) => Number(a.replace(/,/g, '')))
  const unit = displayUnit(m[2]!)
  let rest = (m[3] ?? '').trim()
  const details: string[] = []
  const pkg = PACKAGE_RE.exec(rest)
  if (pkg) {
    details.push(pkg[1]!.replace(/\s+/g, ' '))
    rest = rest.slice(0, pkg.index).trim()
  }
  const apps = rest.match(APPLICATION_RE)
  if (apps) {
    details.push(...apps.map((a) => a.trim()))
    rest = rest.replace(APPLICATION_RE, '').trim()
  }
  const kind = formKind(rest)
  return {
    raw: text,
    rxcui,
    parsed: true,
    value,
    amounts,
    unit,
    form: rest,
    formGroup: capitalize(expandForm(rest)) || 'Other',
    formLabel: formLabelFor(rest, kind),
    doseUnit: kind?.doseUnit || doseUnitFromStrength(unit),
    details,
    variants: [text],
    rxcuis: rxcui ? [rxcui] : [],
    score: null,
  }
}

function formLabelFor(form: string, kind: FormKind | null): string {
  if (!kind) return form ? expandForm(form) : 'other'
  const ext = /\b(?:XR|ER|SR|CR|LA)\b/.test(form) ? 'extended-release ' : /\b(?:DR|EC)\b/.test(form) ? 'delayed-release ' : ''
  return ext && (kind.label === 'tablet' || kind.label === 'capsule' || kind.label === 'suspension') ? ext + kind.label : kind.label
}

function doseUnitFromStrength(unit: string): string {
  if (/^units?\b|^var units/.test(unit)) return 'units'
  if (/\/[\d.]*ml$/.test(unit)) return 'ml'
  if (/\/puff$/.test(unit)) return 'puff'
  if (/\/spray$/.test(unit)) return 'spray'
  if (/\/actuat$/.test(unit)) return 'puff'
  return 'dose'
}

/** Icon suggestion for a parsed form (used only when the user hasn't picked one). */
export function iconForForm(form: string): MedIcon {
  return formKind(form)?.icon ?? 'pill'
}

/**
 * Parses a whole RxTerms strength list. Options that differ only by package size or
 * application number (e.g. three "90 mcg/puff MDI" products) fold into one, keeping the first RXCUI.
 */
export function parseStrengthList(list: RawStrength[]): StrengthOption[] {
  const out: StrengthOption[] = []
  const byKey = new Map<string, StrengthOption>()
  for (const s of list) {
    const o = parseStrength(s.raw, s.rxcui)
    const key = o.parsed ? `${o.value}|${o.unit}|${o.form}` : `raw|${o.raw}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, o)
      out.push(o)
      continue
    }
    for (const d of o.details) if (!prev.details.includes(d)) prev.details.push(d)
    prev.variants.push(o.raw)
    prev.rxcuis.push(...o.rxcuis.filter((r) => !prev.rxcuis.includes(r)))
  }
  return out
}

/** Numeric comparison: by each ingredient amount in turn, then by unit and raw text. */
export function compareStrengthNumeric(a: StrengthOption, b: StrengthOption): number {
  if (a.parsed !== b.parsed) return a.parsed ? -1 : 1
  const n = Math.max(a.amounts.length, b.amounts.length)
  for (let i = 0; i < n; i++) {
    const d = (a.amounts[i] ?? -1) - (b.amounts[i] ?? -1)
    if (d) return d
  }
  return a.unit.localeCompare(b.unit) || a.raw.localeCompare(b.raw)
}

/** Splits a stored strength like "10 mg" or "5-325 mg" into amount and unit for the editor. */
export function splitStrength(strength: string): { value: string; unit: string } {
  const s = strength.trim()
  const m = new RegExp(String.raw`^(${NUM}(?:\s*-\s*${NUM})*)\s*(.*)$`).exec(s)
  if (!m) return { value: s, unit: '' }
  return { value: m[1]!.replace(/\s+/g, ''), unit: m[2]!.trim() }
}

export function joinStrength(value: string, unit: string): string {
  return [value.trim(), unit.trim()].filter(Boolean).join(' ')
}

/** Comparable key for "is this the same strength?", insensitive to spacing, case and commas. */
export function strengthKey(strength: string): string {
  const { value, unit } = splitStrength(strength)
  return `${value.replace(/,/g, '')} ${displayUnit(unit).toLowerCase()}`.trim()
}

/**
 * openFDA strengths look like "50 mg/1" (per unit: tablet, capsule...), "10 mg/mL" or "5 mg/5mL".
 * Returns the RxTerms-style key ("50 mg", "10 mg/ml", "5 mg/5ml") or null when not comparable.
 */
export function normalizeFdaStrength(s: string): string | null {
  const m = /^\s*([\d.,]+)\s*([A-Za-z%µ[\]']+)\s*(?:\/\s*([\d.]*)\s*([A-Za-z]*))?\s*$/.exec(s)
  if (!m) return null
  const amount = Number(m[1]!.replace(/,/g, ''))
  if (!Number.isFinite(amount)) return null
  const unit = m[2]!.toLowerCase().replace(/^\[iu\]$|^iu$|^\[usp'u\]$|^units?$/, 'units')
  const perN = m[3] ?? ''
  const per = (m[4] ?? '').toLowerCase()
  const amt = fmtAmount(amount)
  // "/1" (or no denominator) means per tablet/capsule/etc., which RxTerms writes as a bare unit.
  if (!per) return `${amt} ${unit}`
  return `${amt} ${unit}/${perN && perN !== '1' ? fmtAmount(Number(perN)) : ''}${per}`
}

function fmtAmount(n: number): string {
  return String(Number(n.toPrecision(6)))
}

/** The comparable key for an RxTerms option, matching normalizeFdaStrength's output. */
export function optionStrengthKey(o: StrengthOption): string | null {
  if (!o.parsed || o.amounts.length !== 1) return null
  return `${fmtAmount(o.amounts[0]!)} ${o.unit.toLowerCase().replace(/\s+/g, '')}`
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}
