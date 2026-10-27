/**
 * Drug lookup contracts. Pure TypeScript: HTTP goes through an injected FetchFn so the same
 * catalog code runs in Electron's main process today and in a browser build later.
 */

export type CatalogSource = 'rxterms'

/** One RxTerms entry: a drug name + route group, e.g. "Metoprolol XR (Oral Pill)". */
export interface DrugMatch {
  /** RxTerms DISPLAY_NAME, verbatim. Unique within RxTerms and used as the cache key. */
  displayName: string
  /** Display name without the route group, in readable case ("metFORMIN" → "Metformin"). */
  name: string
  /** Route group from the display name, e.g. "Oral Pill", or null if absent. */
  route: string | null
  /** Brand entries are written in capitals by RxTerms (e.g. "TOPROL XR"). */
  brand: boolean
  /** RxNorm concept for drug + route (SXDG_RXCUI), when provided. */
  rxcui: string | null
  source: CatalogSource
  /** Strength/form strings with their RXCUIs, when the search response included them. */
  strengths?: RawStrength[]
}

export interface RawStrength {
  raw: string
  rxcui: string | null
}

export interface StrengthOption {
  /** RxTerms string, trimmed (e.g. "25 mg 24 HR XR Tab"). */
  raw: string
  rxcui: string | null
  /** False when the string had no leading amount + unit (e.g. "mixed Pack"); shown raw. */
  parsed: boolean
  /** Amount text as written, e.g. "25", "5-325", "1,000-62.5". */
  value: string
  /** Numeric amounts for sorting; one per ingredient. */
  amounts: number[]
  /** Display unit, e.g. "mg", "mg/ml", "mcg/puff", "units/ml". */
  unit: string
  /** RxTerms form with package size and application numbers removed, e.g. "24 HR XR Tab". */
  form: string
  /** Readable form group, e.g. "24-hour extended-release tablet". */
  formGroup: string
  /** Value for Doseline's Form field, e.g. "extended-release tablet". */
  formLabel: string
  /** Suggested per-dose unit, e.g. "tablet", "ml", "puff". */
  doseUnit: string
  /** Package sizes / variants folded into this option, e.g. ["3 ml", "1.5 ml"]. */
  details: string[]
  /** Every RxTerms string folded into this option (itself first). */
  variants: string[]
  /** RXCUIs of all folded variants, for ranking. */
  rxcuis: string[]
  /** openFDA commonness (count of distinct finished products), or null when unknown. */
  score: number | null
}

export interface DrugCatalog {
  searchDrugs(query: string, signal?: AbortSignal): Promise<DrugMatch[]>
  getStrengths(drug: DrugMatch, signal?: AbortSignal): Promise<StrengthOption[]>
}

/** Commonness scores keyed by StrengthOption.raw. */
export interface StrengthRanking {
  scores: Record<string, number>
  method: 'rxcui' | 'strength' | 'none'
}

export interface StrengthRanker {
  rank(drug: DrugMatch, options: StrengthOption[], signal?: AbortSignal): Promise<StrengthRanking>
}

export interface FetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<FetchResponse>

/** Persistent cache (SQLite in Electron). Values are JSON strings. */
export interface DrugCacheStore {
  getCached(key: string): Promise<{ value: string; fetchedAt: string } | null>
  setCached(key: string, value: string, fetchedAt: string): Promise<void>
}

export type DrugLookupErrorCode = 'offline' | 'unavailable' | 'aborted' | 'disabled'

export class DrugLookupError extends Error {
  constructor(
    readonly code: DrugLookupErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'DrugLookupError'
  }
}

export function isAbort(e: unknown): boolean {
  return (e instanceof DrugLookupError && e.code === 'aborted') || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError')
}

/** Normalises fetch failures: aborts stay aborts, network errors mean offline, HTTP errors mean unavailable. */
export async function fetchJson(fetchFn: FetchFn, url: string, signal?: AbortSignal, allow404 = false): Promise<unknown> {
  if (signal?.aborted) throw new DrugLookupError('aborted')
  let res: FetchResponse
  try {
    res = await fetchFn(url, { signal, headers: { Accept: 'application/json' } })
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw new DrugLookupError('aborted')
    throw new DrugLookupError('offline', e instanceof Error ? e.message : String(e))
  }
  if (!res.ok && !(allow404 && res.status === 404)) throw new DrugLookupError('unavailable', `HTTP ${res.status}`)
  try {
    return await res.json()
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw new DrugLookupError('aborted')
    throw new DrugLookupError('unavailable', 'Malformed response')
  }
}
