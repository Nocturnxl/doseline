/**
 * Caching around the catalog and ranker:
 * - search results: in-memory LRU for the session (searches are cheap, and typed names are not persisted);
 * - strength lists and openFDA rankings of drugs you select: persistent, 30-day TTL. When a refresh
 *   fails (offline), expired entries are still served, so a saved medication's chips work offline.
 */
import { RxTermsCatalog } from './rxterms'
import { type DrugCacheStore, type DrugMatch, DrugLookupError, type StrengthOption, type StrengthRanker, type StrengthRanking, isAbort } from './types'

export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export class LruCache<K, V> {
  private map = new Map<K, V>()
  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as K)
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }
}

export interface DrugLookupDeps {
  catalog: RxTermsCatalog
  ranker: StrengthRanker
  store: DrugCacheStore
  now?: () => Date
  /** Search LRU capacity. */
  searchCapacity?: number
}

/** The app-facing lookup: cached search, cached strengths, cached rankings. */
export class DrugLookup {
  private searches: LruCache<string, DrugMatch[]>
  private now: () => Date
  private rankInflight = new Map<string, Promise<StrengthRanking>>()

  constructor(private deps: DrugLookupDeps) {
    this.searches = new LruCache(deps.searchCapacity ?? 200)
    this.now = deps.now ?? (() => new Date())
  }

  async search(query: string, signal?: AbortSignal): Promise<DrugMatch[]> {
    const key = query.trim().toLowerCase().replace(/\s+/g, ' ')
    const hit = this.searches.get(key)
    if (hit) return hit
    const results = await this.deps.catalog.searchDrugs(key, signal)
    this.searches.set(key, results)
    return results
  }

  /** Unscored strength options (RxTerms order). Persisted so they're available offline later. */
  async strengths(drug: DrugMatch, signal?: AbortSignal): Promise<StrengthOption[]> {
    const key = `rxterms:strengths:${drug.displayName}`
    if (drug.strengths) {
      const options = await this.deps.catalog.getStrengths(drug, signal)
      await this.put(key, drug.strengths)
      return options
    }
    const raw = await this.cached(key, async () => (await this.deps.catalog.lookup(drug.displayName, signal))?.strengths ?? [])
    return this.deps.catalog.getStrengths({ ...drug, strengths: raw }, signal)
  }

  /** openFDA commonness. At most one request per drug at a time, then cached for 30 days. */
  async ranking(drug: DrugMatch, options: StrengthOption[], signal?: AbortSignal): Promise<StrengthRanking> {
    const key = `openfda:rank:${drug.displayName}`
    const pending = this.rankInflight.get(key)
    if (pending) return pending
    const p = this.cached(key, () => this.deps.ranker.rank(drug, options, signal)).finally(() => this.rankInflight.delete(key))
    this.rankInflight.set(key, p)
    return p
  }

  /** Strength options with commonness applied (the full DrugCatalog.getStrengths contract). */
  async scoredStrengths(drug: DrugMatch, signal?: AbortSignal): Promise<StrengthOption[]> {
    const options = await this.strengths(drug, signal)
    try {
      const { scores } = await this.ranking(drug, options, signal)
      return options.map((o) => ({ ...o, score: scores[o.raw] ?? 0 }))
    } catch (e) {
      if (isAbort(e)) throw e
      return options
    }
  }

  clearSession(): void {
    this.searches.clear()
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const entry = await this.deps.store.getCached(key)
    const fresh = entry && this.now().getTime() - new Date(entry.fetchedAt).getTime() < CACHE_TTL_MS
    if (entry && fresh) return JSON.parse(entry.value) as T
    try {
      const value = await load()
      await this.put(key, value)
      return value
    } catch (e) {
      // Stale beats nothing when offline or the service is down.
      if (entry && e instanceof DrugLookupError && e.code !== 'aborted') return JSON.parse(entry.value) as T
      throw e
    }
  }

  private async put(key: string, value: unknown): Promise<void> {
    await this.deps.store.setCached(key, JSON.stringify(value), this.now().toISOString())
  }
}

/** In-memory DrugCacheStore for tests and non-persistent builds. */
export class MemoryDrugCache implements DrugCacheStore {
  readonly entries = new Map<string, { value: string; fetchedAt: string }>()
  async getCached(key: string) {
    return this.entries.get(key) ?? null
  }
  async setCached(key: string, value: string, fetchedAt: string) {
    this.entries.set(key, { value, fetchedAt })
  }
}
