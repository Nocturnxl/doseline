/**
 * NLM Clinical Table Search Service, RxTerms v3.
 * https://clinicaltables.nlm.nih.gov/apidoc/rxterms/v3/doc.html
 *
 * Response: [total, codes[], { STRENGTHS_AND_FORMS: string[][], RXCUIS: string[][], SXDG_RXCUI: string[] }, display[][]]
 * Matching is word-prefix and case-insensitive; several words are ANDed. maxList caps results (≤ 500).
 */
import { parseStrengthList } from './strength'
import { type DrugCatalog, type DrugMatch, DrugLookupError, type FetchFn, type RawStrength, type StrengthOption, fetchJson } from './types'

export const RXTERMS_URL = 'https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search'
const EXTRA_FIELDS = 'STRENGTHS_AND_FORMS,RXCUIS,SXDG_RXCUI'

/** Results requested per search. The UI shows ~12 after client-side ranking. */
export const SEARCH_MAX_LIST = 50

/** Suffixes kept in capitals when re-casing brand names ("TOPROL XR" → "Toprol XR"). */
const KEEP_UPPER = new Set(['XR', 'ER', 'XL', 'SR', 'CR', 'LA', 'ODT', 'HCT', 'DR', 'CD', 'EC', 'HFA', 'DS', 'SA', 'PM', 'AM', 'HP', 'XT', 'ES', 'USP', 'IR', 'II', 'III', 'IV', 'MS', 'HC', 'DM', 'PE', 'CF', 'NPH', 'ADHD', 'MET', 'D'])

/** Splits "Metoprolol XR (Oral Pill)" into name and route group. */
export function splitDisplayName(display: string): { name: string; route: string | null } {
  const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(display)
  return m ? { name: m[1]!, route: m[2]! } : { name: display.trim(), route: null }
}

/** RxTerms writes brand names entirely in capitals; generics use Tall Man or title case. */
export function isBrandName(name: string): boolean {
  const letters = name.replace(/[^A-Za-z]/g, '')
  return letters.length >= 2 && letters === letters.toUpperCase()
}

/**
 * Readable casing for a stored medication name: Tall Man lettering ("metFORMIN", "HYDROcodone")
 * becomes "Metformin"/"Hydrocodone"; capitalised brands become title case with known suffixes kept.
 */
export function readableName(name: string, brand = isBrandName(name)): string {
  return name.replace(/[A-Za-z]+/g, (w, offset: number) => {
    if (brand) {
      if (KEEP_UPPER.has(w) && offset > 0) return w
      return w[0]! + w.slice(1).toLowerCase()
    }
    const tallMan = /[a-z]/.test(w) && /[A-Z]{2,}/.test(w)
    if (tallMan) return w[0]!.toUpperCase() + w.slice(1).toLowerCase()
    return w
  }).replace(/^[a-z]/, (c) => c.toUpperCase())
}

/** RxTerms uses "NA" for missing codes. */
const code = (v: unknown): string | null => (typeof v === 'string' && /^\d+$/.test(v) ? v : null)

type RxTermsResponse = [number, string[], Record<string, unknown> | null, unknown[]?]

/** Parses a raw RxTerms search response. Tolerates missing extra fields; throws only on a wrong shape. */
export function parseRxTermsResponse(data: unknown): DrugMatch[] {
  if (!Array.isArray(data) || typeof data[0] !== 'number' || !Array.isArray(data[1])) throw new DrugLookupError('unavailable', 'Unexpected RxTerms response')
  const [, codes, extra] = data as RxTermsResponse
  const strengths = (extra?.STRENGTHS_AND_FORMS ?? []) as unknown[]
  const rxcuis = (extra?.RXCUIS ?? []) as unknown[]
  const groups = (extra?.SXDG_RXCUI ?? []) as unknown[]
  return codes
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map((displayName, i) => {
      const { name, route } = splitDisplayName(displayName)
      const brand = isBrandName(name)
      const sList = Array.isArray(strengths[i]) ? (strengths[i] as unknown[]) : null
      const rList = Array.isArray(rxcuis[i]) ? (rxcuis[i] as unknown[]) : []
      const raw: RawStrength[] | undefined = sList
        ?.map((s, j) => ({ raw: typeof s === 'string' ? s : '', rxcui: code(rList[j]) }))
        .filter((s) => s.raw.trim())
      return {
        displayName,
        name: readableName(name, brand),
        route,
        brand,
        rxcui: code(groups[i]),
        source: 'rxterms' as const,
        ...(raw ? { strengths: raw } : {}),
      }
    })
}

export function searchUrl(query: string, maxList = SEARCH_MAX_LIST): string {
  return `${RXTERMS_URL}?terms=${encodeURIComponent(query.trim())}&maxList=${maxList}&ef=${EXTRA_FIELDS}`
}

/** Exact lookup of one DISPLAY_NAME via the name_as_code field (the value must be double-quoted). */
export function exactUrl(displayName: string): string {
  const quoted = `"${displayName.replace(/["\\]/g, (c) => `\\${c}`)}"`
  return `${RXTERMS_URL}?sf=name_as_code&terms=${encodeURIComponent(quoted)}&maxList=1&ef=${EXTRA_FIELDS}`
}

export class RxTermsCatalog implements DrugCatalog {
  constructor(private fetchFn: FetchFn) {}

  async searchDrugs(query: string, signal?: AbortSignal): Promise<DrugMatch[]> {
    const q = query.trim()
    if (q.length < 2) return []
    return parseRxTermsResponse(await fetchJson(this.fetchFn, searchUrl(q), signal))
  }

  /** Looks a drug up by its exact display name (used when only the name is known, e.g. a saved med). */
  async lookup(displayName: string, signal?: AbortSignal): Promise<DrugMatch | null> {
    const matches = parseRxTermsResponse(await fetchJson(this.fetchFn, exactUrl(displayName), signal))
    return matches.find((m) => m.displayName === displayName) ?? null
  }

  /** Strength options in RxTerms order, unscored. Uses the strengths embedded in the match when present. */
  async getStrengths(drug: DrugMatch, signal?: AbortSignal): Promise<StrengthOption[]> {
    const raw = drug.strengths ?? (await this.lookup(drug.displayName, signal))?.strengths ?? []
    return parseStrengthList(raw)
  }
}
