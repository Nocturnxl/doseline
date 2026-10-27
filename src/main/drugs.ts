import path from 'node:path'
import { net } from 'electron'
import {
  DrugLookup,
  DrugLookupError,
  type DrugMatch,
  type FetchFn,
  OpenFdaStrengthRanker,
  RxTermsCatalog,
  type StrengthOption,
  type StrengthRanking,
  type UsedStrength,
  isAbort,
} from '../core/drugs'
import type { Logger } from '../core/ports'
import type { Medication, Settings } from '../core/types'
import type { DrugErrorCode, Result } from '../shared/api'
import type { SqliteRepository } from './db'
import { EncryptedFile } from './secureStore'

const REQUEST_TIMEOUT_MS = 10_000
const USED_KEY = 'drugs.used'
const MAX_USED_PER_DRUG = 12

/**
 * Online drug lookup for the renderer. All HTTP happens here, in the main process, so the renderer
 * CSP stays `connect-src 'self'`. Requests carry no cookies, account or user identifiers: only the
 * typed query (RxTerms) or the selected drug's RXCUIs (openFDA), plus the optional openFDA key.
 */
export class DrugService {
  readonly lookup: DrugLookup
  private inflight = new Map<string, AbortController>()
  private keyFile: EncryptedFile<{ key: string }>
  private apiKey: string | null

  constructor(
    private repo: SqliteRepository,
    private logger: Logger,
    private settings: () => Promise<Settings>,
    secureDir: string,
  ) {
    this.keyFile = new EncryptedFile(path.join(secureDir, 'openfda-key.bin'))
    this.apiKey = this.keyFile.load()?.key ?? null
    const fetchFn: FetchFn = async (url, init) => {
      if (!net.isOnline()) throw new DrugLookupError('offline')
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      try {
        return await net.fetch(url, { headers: init?.headers, signal, credentials: 'omit', cache: 'no-store', redirect: 'error' })
      } catch (e) {
        if (timeout.aborted && !init?.signal?.aborted) throw new DrugLookupError('unavailable', 'timeout')
        throw e
      }
    }
    this.lookup = new DrugLookup({ catalog: new RxTermsCatalog(fetchFn), ranker: new OpenFdaStrengthRanker(fetchFn, () => this.apiKey), store: repo })
  }

  get keySet(): boolean {
    return !!this.apiKey
  }

  setKey(key: string | null): void {
    const k = key?.trim() || null
    if (k && !/^[A-Za-z0-9]{20,64}$/.test(k)) throw new Error('An openFDA API key is 40 letters and digits.')
    if (k) this.keyFile.save({ key: k })
    else this.keyFile.clear()
    this.apiKey = k
  }

  async search(query: string, requestId: string): Promise<Result<DrugMatch[]>> {
    return this.run(requestId, (signal) => this.lookup.search(query, signal))
  }

  cancel(requestId: string): void {
    this.inflight.get(requestId)?.abort()
    this.inflight.delete(requestId)
  }

  async strengths(drug: DrugMatch): Promise<Result<StrengthOption[]>> {
    return this.run(null, (signal) => this.lookup.strengths(drug, signal))
  }

  async ranking(drug: DrugMatch): Promise<Result<StrengthRanking>> {
    return this.run(null, async (signal) => this.lookup.ranking(drug, await this.lookup.strengths(drug, signal), signal))
  }

  /** Strengths you've saved for this drug: current medications plus remembered past entries. */
  async used(displayName: string): Promise<UsedStrength[]> {
    const meds = (await this.repo.listMedications()).filter((m) => m.catalogName === displayName && m.strength)
    const current: UsedStrength[] = meds.map((m) => ({ strength: m.strength, form: m.form, rxcui: m.strengthRxcui ?? null }))
    return [...current, ...((await this.readUsed())[displayName] ?? [])]
  }

  /** Remembers the strength of a saved linked medication, so it stays suggested after edits or deletion. */
  async recordUsed(m: Medication): Promise<void> {
    if (!m.catalogName || !m.strength.trim()) return
    const all = await this.readUsed()
    const list = (all[m.catalogName] ?? []).filter((u) => !(u.strength === m.strength && (u.form ?? '') === m.form))
    all[m.catalogName] = [{ strength: m.strength, form: m.form, rxcui: m.strengthRxcui ?? null }, ...list].slice(0, MAX_USED_PER_DRUG)
    await this.repo.setKV(USED_KEY, JSON.stringify(all))
  }

  private async readUsed(): Promise<Record<string, UsedStrength[]>> {
    try {
      const v = await this.repo.getKV(USED_KEY)
      return v ? (JSON.parse(v) as Record<string, UsedStrength[]>) : {}
    } catch {
      return {}
    }
  }

  private async run<T>(requestId: string | null, fn: (signal: AbortSignal) => Promise<T>): Promise<Result<T>> {
    if (!(await this.settings()).drugLookup) return { ok: false, error: 'disabled' satisfies DrugErrorCode }
    const ac = new AbortController()
    if (requestId) this.inflight.set(requestId, ac)
    try {
      return { ok: true, value: await fn(ac.signal) }
    } catch (e) {
      const code: DrugErrorCode = isAbort(e) ? 'aborted' : e instanceof DrugLookupError ? e.code : 'unavailable'
      // Never log the query or drug name: they are medication data.
      if (code !== 'aborted') this.logger.warn('drug lookup failed', { reason: code })
      return { ok: false, error: code }
    } finally {
      if (requestId && this.inflight.get(requestId) === ac) this.inflight.delete(requestId)
    }
  }
}

/** Rebuilds a DrugMatch from untrusted renderer input, keeping only known fields. */
export function sanitizeDrug(v: unknown): DrugMatch {
  const d = (v ?? {}) as Partial<DrugMatch>
  const str = (x: unknown, max = 300) => (typeof x === 'string' ? x.slice(0, max) : '')
  const displayName = str(d.displayName).trim()
  if (!displayName) throw new Error('Invalid drug')
  return {
    displayName,
    name: str(d.name) || displayName,
    route: d.route ? str(d.route, 100) : null,
    brand: !!d.brand,
    rxcui: d.rxcui && /^\d{1,12}$/.test(String(d.rxcui)) ? String(d.rxcui) : null,
    source: 'rxterms',
    ...(Array.isArray(d.strengths)
      ? { strengths: d.strengths.slice(0, 200).map((s) => ({ raw: str((s as { raw?: unknown })?.raw, 200), rxcui: /^\d{1,12}$/.test(String((s as { rxcui?: unknown })?.rxcui)) ? String((s as { rxcui: unknown }).rxcui) : null })).filter((s) => s.raw) }
      : {}),
  }
}
