/**
 * Live smoke test: hits RxTerms and openFDA for real and checks the response shapes the app relies on.
 * Not part of `npm test`. Run with `npm run test:live` (needs internet).
 */
import { describe, expect, it } from 'vitest'
import { OpenFdaStrengthRanker, RxTermsCatalog, groupStrengths, parseStrengthList, rankDrugMatches, rxcuiCountUrl, searchUrl, type FetchFn } from '../../src/core/drugs'

const fetchFn: FetchFn = (url, init) => fetch(url, init)
const catalog = new RxTermsCatalog(fetchFn)

describe('RxTerms (live)', () => {
  it('returns the documented array shape', async () => {
    const res = await fetch(searchUrl('metoprolol'))
    expect(res.ok).toBe(true)
    const data = (await res.json()) as unknown[]
    expect(Array.isArray(data)).toBe(true)
    expect(typeof data[0]).toBe('number')
    expect(Array.isArray(data[1])).toBe(true)
    const extra = data[2] as Record<string, unknown[]>
    expect(Array.isArray(extra.STRENGTHS_AND_FORMS)).toBe(true)
    expect(Array.isArray(extra.RXCUIS)).toBe(true)
    expect(Array.isArray(extra.SXDG_RXCUI)).toBe(true)
    expect(extra.STRENGTHS_AND_FORMS!.length).toBe((data[1] as unknown[]).length)
  })

  it('"met" includes metformin, both metoprolols, methotrexate and metronidazole', async () => {
    const top = rankDrugMatches(await catalog.searchDrugs('met'), 'met').map((m) => m.displayName)
    for (const n of ['metFORMIN (Oral Pill)', 'Metoprolol (Oral Pill)', 'Metoprolol XR (Oral Pill)', 'Methotrexate (Oral Pill)', 'metroNIDAZOLE (Oral Pill)']) expect(top).toContain(n)
  })

  it('exact lookup finds Metoprolol XR with ER strengths', async () => {
    const m = await catalog.lookup('Metoprolol XR (Oral Pill)')
    expect(m).not.toBeNull()
    const opts = parseStrengthList(m!.strengths!)
    expect(opts.some((o) => o.value === '25' && /XR Tab/.test(o.form))).toBe(true)
    expect(opts.every((o) => o.rxcuis.length > 0)).toBe(true)
  })

  it('returns zero results for nonsense', async () => {
    expect(await catalog.searchDrugs('xqzvplk')).toEqual([])
  })
})

describe('openFDA NDC (live)', () => {
  it('count by RXCUI returns {term, count} results', async () => {
    const res = await fetch(rxcuiCountUrl(['866427', '866436']))
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { results: { term: string; count: number }[] }
    expect(Array.isArray(body.results)).toBe(true)
    expect(body.results.every((r) => typeof r.term === 'string' && typeof r.count === 'number')).toBe(true)
  })

  it('ranks Metoprolol XR strengths end to end', async () => {
    const drug = (await catalog.lookup('Metoprolol XR (Oral Pill)'))!
    const opts = await catalog.getStrengths(drug)
    const ranking = await new OpenFdaStrengthRanker(fetchFn).rank(drug, opts)
    expect(ranking.method).toBe('rxcui')
    expect(Object.values(ranking.scores).some((n) => n > 0)).toBe(true)
    const groups = groupStrengths(opts, { scores: ranking.scores })
    expect(groups.flatMap((g) => g.chips).some((c) => c.common)).toBe(true)
  })

  it('answers "no matches" with 404 NOT_FOUND', async () => {
    const res = await fetch(rxcuiCountUrl(['99999999']))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })
})
