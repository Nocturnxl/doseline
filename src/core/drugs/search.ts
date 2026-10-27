/**
 * Debounced, cancellable search-as-you-type. Each new query aborts the request in flight, and a
 * response is applied only if it belongs to the latest query, so a slow "met" can never overwrite "meto".
 */
import { type DrugLookupErrorCode, type DrugMatch, DrugLookupError, isAbort } from './types'

export const MIN_QUERY_CHARS = 2
export const DEBOUNCE_MS = 200

export interface SearchTimers {
  set(cb: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface DrugSearchState {
  query: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  results: DrugMatch[]
  error: Exclude<DrugLookupErrorCode, 'aborted'> | null
}

export interface DrugSearchDeps {
  search(query: string, signal: AbortSignal): Promise<DrugMatch[]>
  /** Client-side ranking applied to every response. */
  rank?(results: DrugMatch[], query: string): DrugMatch[]
  onChange(state: DrugSearchState): void
  timers: SearchTimers
  debounceMs?: number
  minChars?: number
}

export const IDLE_SEARCH: DrugSearchState = { query: '', status: 'idle', results: [], error: null }

export class DrugSearchController {
  private state: DrugSearchState = IDLE_SEARCH
  private timer: unknown = null
  private inflight: AbortController | null = null
  private seq = 0
  private disposed = false

  constructor(private deps: DrugSearchDeps) {}

  get current(): DrugSearchState {
    return this.state
  }

  /** Call on every keystroke. */
  setQuery(raw: string): void {
    if (this.disposed) return
    const query = raw.trim()
    this.cancelPending()
    const seq = ++this.seq
    if (query.length < (this.deps.minChars ?? MIN_QUERY_CHARS)) {
      this.emit({ ...IDLE_SEARCH, query })
      return
    }
    // Keep showing the previous results while the next ones load, to avoid flicker.
    this.emit({ query, status: 'loading', results: this.state.results, error: null })
    this.timer = this.deps.timers.set(() => {
      this.timer = null
      void this.run(query, seq)
    }, this.deps.debounceMs ?? DEBOUNCE_MS)
  }

  /** Stops any pending or in-flight lookup and returns to idle (e.g. the field lost focus or was linked). */
  reset(): void {
    this.cancelPending()
    this.seq++
    this.emit(IDLE_SEARCH)
  }

  dispose(): void {
    this.cancelPending()
    this.disposed = true
  }

  private cancelPending(): void {
    if (this.timer != null) this.deps.timers.clear(this.timer)
    this.timer = null
    this.inflight?.abort()
    this.inflight = null
  }

  private async run(query: string, seq: number): Promise<void> {
    const ac = new AbortController()
    this.inflight = ac
    try {
      const results = await this.deps.search(query, ac.signal)
      if (seq !== this.seq || ac.signal.aborted) return // stale
      this.emit({ query, status: 'ready', results: this.deps.rank ? this.deps.rank(results, query) : results, error: null })
    } catch (e) {
      if (seq !== this.seq || ac.signal.aborted || isAbort(e)) return
      const code = e instanceof DrugLookupError && e.code !== 'aborted' ? e.code : 'unavailable'
      this.emit({ query, status: 'error', results: [], error: code })
    } finally {
      if (this.inflight === ac) this.inflight = null
    }
  }

  private emit(s: DrugSearchState): void {
    this.state = s
    if (!this.disposed) this.deps.onChange(s)
  }
}
