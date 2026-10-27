import { DrugLookupError, type DrugLookupErrorCode, type DrugMatch } from '../../../core/drugs'
import { api } from './store'

let seq = 0

/** Search over the IPC bridge. Aborting the signal cancels the request in the main process. */
export async function searchDrugsViaIpc(query: string, signal: AbortSignal): Promise<DrugMatch[]> {
  const id = `q${++seq}-${Date.now().toString(36)}`
  const onAbort = () => api.drugCancel(id)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const r = await api.drugSearch(query, id)
    if (signal.aborted) throw new DrugLookupError('aborted')
    if (!r.ok) throw new DrugLookupError(r.error as DrugLookupErrorCode)
    return r.value
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export const browserTimers = {
  set: (cb: () => void, ms: number) => window.setTimeout(cb, ms),
  clear: (h: unknown) => window.clearTimeout(h as number),
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
