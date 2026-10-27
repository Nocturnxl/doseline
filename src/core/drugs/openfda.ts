/**
 * Strength commonness from the openFDA NDC directory (https://api.fda.gov/drug/ndc.json).
 *
 * Primary query, one request per selected drug:
 *   search = openfda.rxcui:(<every RXCUI of the drug's RxTerms strengths>) AND finished:true
 *   count  = openfda.rxcui.exact
 * The result counts distinct finished NDC products per RxNorm clinical drug. Because RxTerms gives an
 * RXCUI for each strength + form string, the counts map back exactly, including combination products
 * (the RXCUI identifies the whole combination) and salts/formulations (each has its own RXCUI).
 *
 * Fallback, only when the drug has no RXCUIs at all and is a single ingredient:
 *   search = generic_name:"<name>" AND finished:true, count = active_ingredients.strength
 * and strengths like "50 mg/1" are normalised onto RxTerms strings. Combinations skip the fallback,
 * since that count mixes every ingredient's strength together.
 *
 * "Commonness" here means how many products are listed, i.e. availability, not prescribing volume.
 */
import { normalizeFdaStrength, optionStrengthKey } from './strength'
import { type DrugMatch, type FetchFn, type StrengthOption, type StrengthRanker, type StrengthRanking, fetchJson } from './types'

export const OPENFDA_NDC_URL = 'https://api.fda.gov/drug/ndc.json'
/** Keep URLs comfortably short; drugs rarely have more than ~30 strength RXCUIs. */
const MAX_RXCUIS = 80

interface CountResult {
  term: string
  count: number
}

/** Parses an openFDA count response. "No matches" (HTTP 404 with error.code NOT_FOUND) is an empty list. */
export function parseCountResponse(data: unknown): CountResult[] {
  if (!data || typeof data !== 'object') return []
  const d = data as { results?: unknown; error?: { code?: string } }
  if (!Array.isArray(d.results)) return []
  return d.results.filter((r): r is CountResult => !!r && typeof (r as CountResult).term === 'string' && typeof (r as CountResult).count === 'number')
}

export function rxcuiCountUrl(rxcuis: string[], apiKey?: string | null): string {
  const search = `openfda.rxcui:(${rxcuis.join(' ')}) AND finished:true`
  return `${OPENFDA_NDC_URL}?${keyParam(apiKey)}search=${encodeURIComponent(search)}&count=openfda.rxcui.exact&limit=1000`
}

export function strengthCountUrl(genericName: string, apiKey?: string | null): string {
  const search = `generic_name:"${genericName.replace(/"/g, '')}" AND finished:true`
  return `${OPENFDA_NDC_URL}?${keyParam(apiKey)}search=${encodeURIComponent(search)}&count=active_ingredients.strength&limit=1000`
}

/** openFDA's docs ask for api_key before the other parameters. */
function keyParam(apiKey?: string | null): string {
  return apiKey ? `api_key=${encodeURIComponent(apiKey)}&` : ''
}

/** Generic ingredient name for the fallback query: "Metoprolol XR" → "metoprolol". */
export function genericForFallback(drug: DrugMatch): string | null {
  if (drug.brand || /[/,]/.test(drug.name)) return null
  return drug.name.replace(/\b(?:XR|ER|SR|CR|LA|DR|EC|ODT)\b/g, '').trim().toLowerCase() || null
}

export function scoresFromRxcuiCounts(options: StrengthOption[], counts: CountResult[]): Record<string, number> {
  const byRxcui = new Map(counts.map((c) => [c.term, c.count]))
  const scores: Record<string, number> = {}
  for (const o of options) {
    const total = o.rxcuis.reduce((sum, r) => sum + (byRxcui.get(r) ?? 0), 0)
    if (o.rxcuis.length) scores[o.raw] = total
  }
  return scores
}

export function scoresFromStrengthCounts(options: StrengthOption[], counts: CountResult[]): Record<string, number> {
  const byKey = new Map<string, number>()
  for (const c of counts) {
    const key = normalizeFdaStrength(c.term)
    if (key) byKey.set(key, (byKey.get(key) ?? 0) + c.count)
  }
  const scores: Record<string, number> = {}
  for (const o of options) {
    const key = optionStrengthKey(o)
    if (key && byKey.has(key)) scores[o.raw] = byKey.get(key)!
  }
  return scores
}

export class OpenFdaStrengthRanker implements StrengthRanker {
  constructor(
    private fetchFn: FetchFn,
    private apiKey: () => string | null = () => null,
  ) {}

  async rank(drug: DrugMatch, options: StrengthOption[], signal?: AbortSignal): Promise<StrengthRanking> {
    const rxcuis = [...new Set(options.flatMap((o) => o.rxcuis))].slice(0, MAX_RXCUIS)
    if (rxcuis.length) {
      const counts = parseCountResponse(await fetchJson(this.fetchFn, rxcuiCountUrl(rxcuis, this.apiKey()), signal, true))
      return { scores: scoresFromRxcuiCounts(options, counts), method: 'rxcui' }
    }
    const generic = genericForFallback(drug)
    if (!generic) return { scores: {}, method: 'none' }
    const counts = parseCountResponse(await fetchJson(this.fetchFn, strengthCountUrl(generic, this.apiKey()), signal, true))
    return { scores: scoresFromStrengthCounts(options, counts), method: 'strength' }
  }
}
