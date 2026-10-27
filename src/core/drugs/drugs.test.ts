import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CACHE_TTL_MS,
  DrugLookup,
  DrugLookupError,
  DrugSearchController,
  LruCache,
  MemoryDrugCache,
  OpenFdaStrengthRanker,
  RxTermsCatalog,
  compareStrengthNumeric,
  editName,
  exactUrl,
  findLinkCandidates,
  genericForFallback,
  groupStrengths,
  highlightSegments,
  isBrandName,
  matchFromLink,
  nameStateFromMedication,
  normalizeFdaStrength,
  parseCountResponse,
  parseRxTermsResponse,
  parseStrength,
  parseStrengthList,
  rankDrugMatches,
  readableName,
  rxcuiCountUrl,
  scoresFromRxcuiCounts,
  scoresFromStrengthCounts,
  searchUrl,
  selectSuggestion,
  splitDisplayName,
  splitStrength,
  strengthKey,
  type DrugMatch,
  type DrugSearchState,
  type FetchFn,
  type SearchTimers,
} from './index'

const FIX = path.resolve(__dirname, '../../../tests/fixtures')
const rx = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIX, 'rxterms', `${name}.json`), 'utf8'))
const fda = (name: string): { status: number; body: unknown } => JSON.parse(fs.readFileSync(path.join(FIX, 'openfda', `${name}.json`), 'utf8'))
const SEARCHES = ['met', 'meto', 'metoprolol', 'insulin', 'hydrocodone', 'albuterol', 'amox', 'xqzvplk']

const matches = (q: string) => parseRxTermsResponse(rx(q))
const drug = (q: string, displayName: string): DrugMatch => {
  const m = matches(q).find((x) => x.displayName === displayName)
  if (!m) throw new Error(`fixture ${q} has no ${displayName}`)
  return m
}
const allStrings = (): string[] =>
  SEARCHES.flatMap((q) => {
    const d = rx(q) as [number, string[], { STRENGTHS_AND_FORMS?: string[][] } | null]
    return d[2]?.STRENGTHS_AND_FORMS?.flat() ?? []
  })

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('RxTerms response parser', () => {
  it.each(SEARCHES)('parses the "%s" fixture', (q) => {
    const raw = rx(q) as [number, string[]]
    const ms = matches(q)
    expect(ms).toHaveLength(raw[1].length)
    for (const m of ms) {
      expect(m.source).toBe('rxterms')
      expect(m.route).toBeTruthy()
      expect(m.strengths!.length).toBeGreaterThan(0)
      expect(m.strengths!.every((s) => s.rxcui && /^\d+$/.test(s.rxcui))).toBe(true)
      expect(m.rxcui === null || /^\d+$/.test(m.rxcui)).toBe(true)
    }
  })

  it('returns nothing for a nonsense query', () => {
    expect(matches('xqzvplk')).toEqual([])
  })

  it('keeps salts and formulations as separate entries', () => {
    const names = matches('met').map((m) => m.displayName)
    // RxTerms names metoprolol tartrate "Metoprolol" and the succinate ER formulation "Metoprolol XR".
    expect(names).toContain('Metoprolol (Oral Pill)')
    expect(names).toContain('Metoprolol XR (Oral Pill)')
    const xr = drug('metoprolol', 'Metoprolol XR (Oral Pill)')
    const ir = drug('metoprolol', 'Metoprolol (Oral Pill)')
    expect(xr.strengths!.map((s) => s.raw.trim())).toContain('25 mg 24 HR XR Tab')
    expect(ir.strengths!.map((s) => s.raw.trim())).toContain('25 mg Tab')
  })

  it('splits display names and detects brands', () => {
    expect(splitDisplayName('Metoprolol XR (Oral Pill)')).toEqual({ name: 'Metoprolol XR', route: 'Oral Pill' })
    expect(splitDisplayName('Estrogens, esterified (USP)/methylTESTOSTERone (Oral Pill)')).toEqual({ name: 'Estrogens, esterified (USP)/methylTESTOSTERone', route: 'Oral Pill' })
    expect(splitDisplayName('Plain')).toEqual({ name: 'Plain', route: null })
    expect(isBrandName('TOPROL XR')).toBe(true)
    expect(isBrandName('ACTOPLUS MET')).toBe(true)
    expect(isBrandName('metFORMIN')).toBe(false)
    expect(isBrandName('Insulin analog, glargine')).toBe(false)
    const met = matches('met')
    expect(met.find((m) => m.displayName === 'METROGEL (Topical)')!.brand).toBe(true)
    expect(met.find((m) => m.displayName === 'metFORMIN (Oral Pill)')!.brand).toBe(false)
  })

  it('makes names readable without losing meaning', () => {
    expect(readableName('metFORMIN')).toBe('Metformin')
    expect(readableName('HYDROcodone XR')).toBe('Hydrocodone XR')
    expect(readableName('glyBURIDE/metFORMIN')).toBe('Glyburide/Metformin')
    expect(readableName('TOPROL XR')).toBe('Toprol XR')
    expect(readableName('LOPRESSOR HCT')).toBe('Lopressor HCT')
    expect(readableName('Insulin analog, glargine')).toBe('Insulin analog, glargine')
    expect(readableName('Estrogens, esterified (USP)/methylTESTOSTERone')).toBe('Estrogens, esterified (USP)/Methyltestosterone')
  })

  it('rejects malformed responses and tolerates missing extra fields', () => {
    expect(() => parseRxTermsResponse({})).toThrow(DrugLookupError)
    expect(() => parseRxTermsResponse(null)).toThrow(DrugLookupError)
    expect(parseRxTermsResponse([0, [], null, []])).toEqual([])
    const bare = parseRxTermsResponse([1, ['ARAVA (Oral Pill)'], null, [['ARAVA (Oral Pill)']]])
    expect(bare[0]).toMatchObject({ displayName: 'ARAVA (Oral Pill)', name: 'Arava', brand: true, rxcui: null })
    expect(bare[0]!.strengths).toBeUndefined()
  })

  it('builds the documented URLs', () => {
    expect(searchUrl(' meto ')).toBe('https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search?terms=meto&maxList=50&ef=STRENGTHS_AND_FORMS,RXCUIS,SXDG_RXCUI')
    expect(decodeURIComponent(exactUrl('A "B" (Oral Pill)'))).toContain('sf=name_as_code&terms="A \\"B\\" (Oral Pill)"')
  })
})

describe('strength string parser', () => {
  it('parses every fixture string without throwing', () => {
    const strings = allStrings()
    expect(strings.length).toBeGreaterThan(150)
    for (const s of strings) {
      const o = parseStrength(s)
      expect(o.raw).toBe(s.replace(/\s+/g, ' ').trim())
      if (o.parsed) {
        expect(o.value).toMatch(/^[\d.,]+(-[\d.,]+)*$/)
        expect(o.amounts.every((n) => Number.isFinite(n))).toBe(true)
        expect(o.unit).toBeTruthy()
        expect(o.formGroup).toBeTruthy()
        expect(o.formLabel).toBeTruthy()
        expect(o.doseUnit).toBeTruthy()
      } else {
        expect(o.formGroup).toBeTruthy()
      }
    }
    // Only the "mixed Pack" kits have no leading amount.
    expect(strings.filter((s) => !parseStrength(s).parsed).every((s) => s.trim() === 'mixed Pack')).toBe(true)
  })

  it.each([
    [' 25 mg 24 HR XR Tab', { value: '25', unit: 'mg', form: '24 HR XR Tab', formGroup: '24-hour extended-release tablet', formLabel: 'extended-release tablet', doseUnit: 'tablet' }],
    ['5-325 mg Tab', { value: '5-325', amounts: [5, 325], unit: 'mg', form: 'Tab', formGroup: 'Tablet', formLabel: 'tablet' }],
    ['1,000-62.5 mg 12 HR XR Tab', { value: '1,000-62.5', amounts: [1000, 62.5], form: '12 HR XR Tab' }],
    ['10 mg/ml Susp', { value: '10', unit: 'mg/ml', form: 'Susp', formLabel: 'suspension', doseUnit: 'ml' }],
    ['125 mg/5ml Susp', { unit: 'mg/5ml', formGroup: 'Suspension', doseUnit: 'ml' }],
    ['0.1 mg/hr Patch', { value: '0.1', unit: 'mg/hr', form: 'Patch', formLabel: 'patch', doseUnit: 'patch' }],
    ['90 mcg/puff NDA020503 MDI', { unit: 'mcg/puff', form: 'MDI', formGroup: 'Metered-dose inhaler', formLabel: 'inhaler', doseUnit: 'puff', details: ['NDA020503'] }],
    ['90 mcg/puff DPI 200 puff', { form: 'DPI', formGroup: 'Dry powder inhaler', details: ['200 puff'] }],
    ['100 unt/ml Pen Injector 3 ml', { value: '100', unit: 'units/ml', form: 'Pen Injector', formLabel: 'pen injector', doseUnit: 'units', details: ['3 ml'] }],
    ['100 unt/ml 0.5 UNT Doses Pen Injector 3 ml', { form: '0.5 UNT Doses Pen Injector', formGroup: '0.5 unit doses pen injector' }],
    ['100-0.033 var units Pen Injector 3 ml', { value: '100-0.033', unit: 'var units', form: 'Pen Injector' }],
    ['  1 unt/ml Injection 100 ml', { value: '1', unit: 'units/ml', form: 'Injection', formLabel: 'injection', details: ['100 ml'] }],
    ['5 mg/5ml Injection 5 ml', { unit: 'mg/5ml', doseUnit: 'ml' }],
    [' 4 unt Pwdr', { unit: 'units', form: 'Pwdr', formLabel: 'powder' }],
    ['250-10-12.5 mg DR Cap', { amounts: [250, 10, 12.5], formLabel: 'delayed-release capsule' }],
    ['8-10 mg/5ml 12 HR XR Susp', { formLabel: 'extended-release suspension', formGroup: '12-hour extended-release suspension' }],
    ['100-20 mcg/spray Spray 120 puff', { unit: 'mcg/spray', form: 'Spray', formLabel: 'spray' }],
    [' 20 mg Abuse-Deterrent 24 HR XR Tab', { form: 'Abuse-Deterrent 24 HR XR Tab', formGroup: 'Abuse-deterrent 24-hour extended-release tablet' }],
    ['40 mg/0.4ml Prefilled Syringe 0.4 ml', { unit: 'mg/0.4ml', formLabel: 'prefilled syringe', doseUnit: 'ml' }],
  ])('parses %j', (raw, expected) => {
    expect(parseStrength(raw)).toMatchObject({ parsed: true, ...expected })
  })

  it('keeps unparseable strings as raw options', () => {
    expect(parseStrength('mixed Pack')).toMatchObject({ parsed: false, raw: 'mixed Pack', value: '', formGroup: 'Mixed pack' })
    expect(parseStrength('')).toMatchObject({ parsed: false })
    expect(parseStrength('see package insert')).toMatchObject({ parsed: false, raw: 'see package insert' })
  })

  it('folds variants that differ only by application number or package size', () => {
    const albuterol = drug('albuterol', 'Albuterol (Inhalant)')
    const opts = parseStrengthList(albuterol.strengths!)
    const mdi = opts.filter((o) => o.form === 'MDI')
    expect(mdi).toHaveLength(1)
    expect(mdi[0]!.variants).toHaveLength(3)
    expect(mdi[0]!.rxcuis).toHaveLength(3)
    expect(mdi[0]!.details).toEqual(['NDA020503', 'NDA020983', 'NDA021457'])
    const glargine = parseStrengthList(drug('insulin', 'Insulin analog, glargine (Injectable)').strengths!)
    expect(glargine.filter((o) => o.form === 'Pen Injector').map((o) => `${o.value} ${o.unit}`)).toEqual(['100 units/ml', '300 units/ml'])
  })

  it('sorts numerically by each ingredient amount', () => {
    const opts = parseStrengthList(drug('hydrocodone', 'Acetaminophen/HYDROcodone (Oral Pill)').strengths!)
    expect([...opts].sort(compareStrengthNumeric).map((o) => o.value)).toEqual(['300-5', '300-7.5', '300-10', '325-2.5', '325-5', '325-7.5', '325-10'])
    const ir = parseStrengthList(drug('metoprolol', 'Metoprolol (Oral Pill)').strengths!)
    expect([...ir].sort(compareStrengthNumeric).map((o) => o.value)).toEqual(['12.5', '25', '37.5', '50', '75', '100'])
  })

  it('splits, joins and compares stored strengths', () => {
    expect(splitStrength('10 mg')).toEqual({ value: '10', unit: 'mg' })
    expect(splitStrength('5-325 mg')).toEqual({ value: '5-325', unit: 'mg' })
    expect(splitStrength('one scoop')).toEqual({ value: 'one scoop', unit: '' })
    expect(strengthKey('1,000 MG')).toBe(strengthKey('1000 mg'))
    expect(strengthKey('100 unt/ml')).toBe(strengthKey('100 units/ml'))
  })

  it('normalises openFDA strength units', () => {
    expect(normalizeFdaStrength('50 mg/1')).toBe('50 mg')
    expect(normalizeFdaStrength('10 mg/mL')).toBe('10 mg/ml')
    expect(normalizeFdaStrength('5 mg/5mL')).toBe('5 mg/5ml')
    expect(normalizeFdaStrength('100 [iU]/mL')).toBe('100 units/ml')
    expect(normalizeFdaStrength('.1 mg/h')).toBe('0.1 mg/h')
    expect(normalizeFdaStrength('garbage')).toBeNull()
  })
})

describe('openFDA ranking', () => {
  const xr = drug('metoprolol', 'Metoprolol XR (Oral Pill)')
  const xrOpts = parseStrengthList(xr.strengths!)

  it('builds one count query over the drug\'s RXCUIs', () => {
    const url = rxcuiCountUrl(['1', '2'])
    expect(decodeURIComponent(url)).toBe('https://api.fda.gov/drug/ndc.json?search=openfda.rxcui:(1 2) AND finished:true&count=openfda.rxcui.exact&limit=1000')
    expect(rxcuiCountUrl(['1'], 'k e y')).toMatch(/ndc\.json\?api_key=k%20e%20y&search=/)
  })

  it('maps product counts back to RxTerms strengths', () => {
    const scores = scoresFromRxcuiCounts(xrOpts, parseCountResponse(fda('metoprolol-xr').body))
    expect(Object.keys(scores).sort()).toEqual(xrOpts.map((o) => o.raw).sort())
    // Tablets are listed by far more manufacturers than the newer sprinkle capsules.
    expect(scores['50 mg 24 HR XR Tab']).toBeGreaterThan(scores['50 mg 24 HR XR Cap']!)
    expect(scores['200 mg 24 HR XR Tab']).toBeLessThan(scores['50 mg 24 HR XR Tab']!)
  })

  it('handles combination products via their RXCUIs', () => {
    const apap = drug('hydrocodone', 'Acetaminophen/HYDROcodone (Oral Pill)')
    const opts = parseStrengthList(apap.strengths!)
    const scores = scoresFromRxcuiCounts(opts, parseCountResponse(fda('apap-hydrocodone').body))
    expect(scores['325-5 mg Tab']).toBeGreaterThan(0)
    expect(scores['325-10 mg Tab']).toBeGreaterThan(scores['300-5 mg Tab'] ?? 0)
  })

  it('sums folded variants', () => {
    const albuterol = parseStrengthList(drug('albuterol', 'Albuterol (Inhalant)').strengths!)
    const scores = scoresFromRxcuiCounts(albuterol, parseCountResponse(fda('albuterol-inhalant').body))
    const mdi = albuterol.find((o) => o.form === 'MDI')!
    expect(scores[mdi.raw]).toBeGreaterThan(0)
  })

  it('treats "no matches" as an empty ranking', async () => {
    expect(parseCountResponse(fda('not-found').body)).toEqual([])
    const fetchFn: FetchFn = async () => jsonResponse(fda('not-found').body, 404)
    const r = await new OpenFdaStrengthRanker(fetchFn).rank(xr, xrOpts)
    expect(r.method).toBe('rxcui')
    expect(Object.values(r.scores).every((v) => v === 0)).toBe(true)
  })

  it('falls back to strength counts for single-ingredient drugs without RXCUIs', async () => {
    const bare = { ...xr, strengths: xr.strengths!.map((s) => ({ raw: s.raw, rxcui: null })) }
    const opts = parseStrengthList(bare.strengths)
    expect(scoresFromStrengthCounts(opts, parseCountResponse(fda('strength-metoprolol-succinate').body))['50 mg 24 HR XR Tab']).toBeGreaterThan(0)
    const urls: string[] = []
    const fetchFn: FetchFn = async (url) => {
      urls.push(url)
      return jsonResponse(fda('strength-metoprolol-succinate').body)
    }
    const r = await new OpenFdaStrengthRanker(fetchFn).rank(bare, opts)
    expect(r.method).toBe('strength')
    expect(urls).toHaveLength(1)
    expect(decodeURIComponent(urls[0]!)).toContain('generic_name:"metoprolol" AND finished:true&count=active_ingredients.strength')
    // Combinations and brands skip the fallback rather than mixing ingredient strengths.
    expect(genericForFallback(drug('hydrocodone', 'Acetaminophen/HYDROcodone (Oral Pill)'))).toBeNull()
    const none = await new OpenFdaStrengthRanker(fetchFn).rank({ ...bare, name: 'Acetaminophen/Hydrocodone' }, opts)
    expect(none.method).toBe('none')
    expect(urls).toHaveLength(1)
  })

  it('reports network failures as offline and HTTP errors as unavailable', async () => {
    const offline: FetchFn = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(new OpenFdaStrengthRanker(offline).rank(xr, xrOpts)).rejects.toMatchObject({ code: 'offline' })
    const down: FetchFn = async () => jsonResponse({}, 503)
    await expect(new OpenFdaStrengthRanker(down).rank(xr, xrOpts)).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('suggestion ranking', () => {
  it('"met" shows the common met- drugs, tartrate and succinate separately', () => {
    const top = rankDrugMatches(matches('met'), 'met').map((m) => m.displayName)
    expect(top).toHaveLength(12)
    for (const n of ['metFORMIN (Oral Pill)', 'Metoprolol (Oral Pill)', 'Metoprolol XR (Oral Pill)', 'Methotrexate (Oral Pill)', 'metroNIDAZOLE (Oral Pill)']) expect(top).toContain(n)
    expect(top.indexOf('Metoprolol (Oral Pill)')).toBeLessThan(top.indexOf('Metoprolol XR (Oral Pill)'))
  })

  it('"meto" narrows to names with a word starting with meto', () => {
    const top = rankDrugMatches(matches('meto'), 'meto')
    expect(top.length).toBeGreaterThan(5)
    for (const m of top) expect(m.name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.startsWith('meto'))).toBe(true)
    expect(top[0]!.displayName).toBe('Metoprolol (Oral Pill)')
  })

  it('orders tiers: owned, first word, any word, other', () => {
    const mk = (displayName: string): DrugMatch => ({ ...splitDisplayName(displayName), displayName, brand: false, rxcui: null, source: 'rxterms' })
    const list = [mk('Zz other (Oral Pill)'), mk('Hydrochlorothiazide/Metoprolol (Oral Pill)'), mk('Metoprolol XR (Oral Pill)'), mk('Metoprolol (Oral Pill)'), mk('Methotrexate (Oral Pill)')]
    const ranked = rankDrugMatches(list, 'meto', { displayNames: ['Methotrexate (Oral Pill)'], names: [] }).map((m) => m.displayName)
    // Same tier: server order blended with length, so the shorter "Metoprolol" edges past "Metoprolol XR".
    expect(ranked).toEqual(['Methotrexate (Oral Pill)', 'Metoprolol (Oral Pill)', 'Metoprolol XR (Oral Pill)', 'Hydrochlorothiazide/Metoprolol (Oral Pill)', 'Zz other (Oral Pill)'])
    // Unlinked medications match by name.
    expect(rankDrugMatches(list, 'meto', { displayNames: [], names: ['metoprolol '] })[0]!.displayName).toBe('Metoprolol (Oral Pill)')
  })

  it('caps results and drops duplicates', () => {
    const dup = [...matches('met'), ...matches('met')]
    const top = rankDrugMatches(dup, 'met', undefined, 30)
    expect(new Set(top.map((m) => m.displayName)).size).toBe(top.length)
  })

  it('highlights matching word prefixes', () => {
    expect(highlightSegments('Hydrochlorothiazide/Metoprolol', 'meto')).toEqual([
      { text: 'Hydrochlorothiazide/', match: false },
      { text: 'Meto', match: true },
      { text: 'prolol', match: false },
    ])
    expect(highlightSegments('Metoprolol XR', 'met xr').filter((s) => s.match).map((s) => s.text)).toEqual(['Met', 'XR'])
    expect(highlightSegments('Lisinopril', '')).toEqual([{ text: 'Lisinopril', match: false }])
  })
})

describe('strength chips', () => {
  const xr = drug('metoprolol', 'Metoprolol XR (Oral Pill)')
  const opts = parseStrengthList(xr.strengths!)
  const scores = scoresFromRxcuiCounts(opts, parseCountResponse(fda('metoprolol-xr').body))

  it('groups by form in numeric order while the ranking loads', () => {
    const groups = groupStrengths(opts)
    expect(groups.map((g) => g.label)).toEqual(['24-hour extended-release capsule', '24-hour extended-release tablet'])
    expect(groups[1]!.chips.map((c) => c.option.value)).toEqual(['25', '50', '100', '200'])
    expect(groups.flatMap((g) => g.chips).some((c) => c.common)).toBe(false)
  })

  it('orders by commonness once scores arrive and marks the top few', () => {
    const groups = groupStrengths(opts, { scores })
    expect(groups[0]!.label).toBe('24-hour extended-release tablet') // far more listed products
    const tab = groups[0]!.chips
    expect(tab.map((c) => c.option.score)).toEqual([...tab.map((c) => c.option.score)].sort((a, b) => b! - a!))
    expect(tab.filter((c) => c.common).length).toBe(2) // at most half of a 4-chip group
    expect(tab[tab.length - 1]!.common).toBe(false)
  })

  it('marks nothing "Common" when every strength in a form is listed equally', () => {
    const caps = groupStrengths(opts, { scores }).find((g) => g.label === '24-hour extended-release capsule')!
    expect(new Set(caps.chips.map((c) => c.option.score)).size).toBe(1) // 8 products each in the fixture
    expect(caps.chips.some((c) => c.common)).toBe(false)
    expect(caps.chips.map((c) => c.option.value)).toEqual(['25', '50', '100', '200']) // ties fall back to numeric
  })

  it('puts strengths you have used first, with their group', () => {
    const groups = groupStrengths(opts, { scores, used: [{ strength: '200 mg', form: 'extended-release capsule' }] })
    expect(groups[0]!.label).toBe('24-hour extended-release capsule')
    expect(groups[0]!.chips[0]).toMatchObject({ yours: true, option: { value: '200' } })
    const byRxcui = groupStrengths(opts, { used: [{ strength: 'whatever', rxcui: '866419' }] })
    expect(byRxcui.flatMap((g) => g.chips).find((c) => c.yours)!.option.raw).toBe('200 mg 24 HR XR Tab')
  })

  it('remembers custom strengths as first-class chips', () => {
    const groups = groupStrengths(opts, { used: [{ strength: '12.5 mg', form: 'half tablet' }, { strength: '12.5 MG', form: 'Half tablet' }] })
    expect(groups[0]!.key).toBe('custom')
    expect(groups[0]!.chips).toHaveLength(1)
    expect(groups[0]!.chips[0]).toMatchObject({ custom: true, yours: true, option: { value: '12.5', unit: 'mg', formLabel: 'half tablet' } })
  })

  it('shows unparsed options in their own group', () => {
    const groups = groupStrengths(parseStrengthList([{ raw: 'mixed Pack', rxcui: '1' }, { raw: '5 mg Tab', rxcui: '2' }]))
    expect(groups.map((g) => g.label)).toEqual(['Mixed pack', 'Tablet'])
  })
})

describe('name linking', () => {
  const xr = drug('metoprolol', 'Metoprolol XR (Oral Pill)')

  it('links on select and unlinks on any edit', () => {
    let s = selectSuggestion({ text: 'meto', link: null }, xr)
    expect(s).toEqual({ text: 'Metoprolol XR', link: { displayName: 'Metoprolol XR (Oral Pill)', name: 'Metoprolol XR', rxcui: '1163524', source: 'rxterms' } })
    s = editName(s, 'Metoprolol XR ')
    expect(s.link).not.toBeNull() // trailing whitespace is not an edit
    s = editName(s, 'Metoprolol X')
    expect(s.link).toBeNull()
    s = editName(s, 'Metoprolol XR')
    expect(s.link).toBeNull() // retyping doesn't silently relink
  })

  it('restores links from saved medications', () => {
    expect(nameStateFromMedication(null)).toEqual({ text: '', link: null })
    expect(nameStateFromMedication({ name: 'Fish oil', rxcui: null, catalogName: null, catalogSource: null }).link).toBeNull()
    const s = nameStateFromMedication({ name: 'Metoprolol XR', rxcui: '1163524', catalogName: 'Metoprolol XR (Oral Pill)', catalogSource: 'rxterms' })
    expect(matchFromLink(s.link!)).toMatchObject({ displayName: 'Metoprolol XR (Oral Pill)', route: 'Oral Pill', brand: false })
  })

  it('finds link candidates for unlinked medications by exact name', () => {
    expect(findLinkCandidates('metoprolol', matches('metoprolol')).map((m) => m.route)).toEqual(['Oral Pill', 'Injectable', 'Oral Liquid'])
    expect(findLinkCandidates('Meto', matches('meto'))).toEqual([])
  })
})

describe('DrugSearchController', () => {
  function fakeTimers() {
    let t: { cb: () => void } | null = null
    const timers: SearchTimers = {
      set: (cb) => (t = { cb }),
      clear: (h) => {
        if (t === h) t = null
      },
    }
    return { timers, flush: () => (t ? (t.cb(), (t = null), true) : false), pending: () => !!t }
  }
  const deferred = <T,>() => {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
    return { promise, resolve, reject }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('waits for two characters and debounces', () => {
    const t = fakeTimers()
    const search = vi.fn(async () => [])
    const c = new DrugSearchController({ search, onChange: () => {}, timers: t.timers })
    c.setQuery('m')
    expect(t.pending()).toBe(false)
    expect(c.current.status).toBe('idle')
    c.setQuery('me')
    c.setQuery('met')
    expect(c.current.status).toBe('loading')
    t.flush()
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('met', expect.any(AbortSignal))
  })

  it('discards a slow stale response and aborts it', async () => {
    const t = fakeTimers()
    const slow = deferred<DrugMatch[]>()
    const fast = deferred<DrugMatch[]>()
    const signals: AbortSignal[] = []
    const states: DrugSearchState[] = []
    const c = new DrugSearchController({
      search: (q, signal) => {
        signals.push(signal)
        return q === 'met' ? slow.promise : fast.promise
      },
      rank: (r, q) => rankDrugMatches(r, q),
      onChange: (s) => states.push(s),
      timers: t.timers,
    })
    c.setQuery('Met')
    t.flush()
    c.setQuery('Meto')
    expect(signals[0]!.aborted).toBe(true)
    t.flush()
    fast.resolve(matches('meto'))
    await tick()
    slow.resolve(matches('met')) // arrives last, ignoring the abort
    await tick()
    expect(c.current.query).toBe('Meto')
    expect(c.current.status).toBe('ready')
    expect(c.current.results.every((m) => /\bmeto/i.test(m.name.replace(/\//g, ' ')))).toBe(true)
    expect(states.filter((s) => s.status === 'ready')).toHaveLength(1)
  })

  it('reports offline without throwing and recovers', async () => {
    const t = fakeTimers()
    let fail = true
    const c = new DrugSearchController({
      search: async () => {
        if (fail) throw new DrugLookupError('offline')
        return matches('meto')
      },
      onChange: () => {},
      timers: t.timers,
    })
    c.setQuery('meto')
    t.flush()
    await tick()
    expect(c.current).toMatchObject({ status: 'error', error: 'offline', results: [] })
    fail = false
    c.setQuery('metop')
    t.flush()
    await tick()
    expect(c.current.status).toBe('ready')
  })

  it('ignores aborts and treats unknown errors as unavailable', async () => {
    const t = fakeTimers()
    const c = new DrugSearchController({ search: async () => Promise.reject(new Error('boom')), onChange: () => {}, timers: t.timers })
    c.setQuery('xx')
    t.flush()
    await tick()
    expect(c.current.error).toBe('unavailable')
    const d = new DrugSearchController({ search: async () => Promise.reject(new DrugLookupError('aborted')), onChange: () => {}, timers: t.timers })
    d.setQuery('xx')
    t.flush()
    await tick()
    expect(d.current.status).toBe('loading')
    d.reset()
    expect(d.current.status).toBe('idle')
  })
})

describe('DrugLookup caching', () => {
  function fixtureFetch(log: string[]) {
    const fn: FetchFn = async (url) => {
      log.push(url)
      if (url.startsWith('https://api.fda.gov/')) return jsonResponse(fda('metoprolol-xr').body)
      if (url.includes('name_as_code')) return jsonResponse(rx('exact-metoprolol-xr'))
      const q = new URL(url).searchParams.get('terms')!
      return jsonResponse(rx(q))
    }
    return fn
  }

  it('caches searches in an LRU', async () => {
    const log: string[] = []
    const f = fixtureFetch(log)
    const lookup = new DrugLookup({ catalog: new RxTermsCatalog(f), ranker: new OpenFdaStrengthRanker(f), store: new MemoryDrugCache() })
    await lookup.search('meto')
    await lookup.search(' METO ')
    expect(log).toHaveLength(1)
    const lru = new LruCache<string, number>(2)
    lru.set('a', 1)
    lru.set('b', 2)
    lru.get('a')
    lru.set('c', 3)
    expect([lru.get('a'), lru.get('b'), lru.get('c')]).toEqual([1, undefined, 3])
  })

  it('persists strengths and rankings for 30 days and serves them offline', async () => {
    const log: string[] = []
    let online = true
    const base = fixtureFetch(log)
    const f: FetchFn = async (url, init) => {
      if (!online) throw new TypeError('fetch failed')
      return base(url, init)
    }
    let now = new Date('2026-10-27T12:00:00Z')
    const store = new MemoryDrugCache()
    const make = () => new DrugLookup({ catalog: new RxTermsCatalog(f), ranker: new OpenFdaStrengthRanker(f), store, now: () => now })
    const xr = drug('metoprolol', 'Metoprolol XR (Oral Pill)')

    const first = make()
    const opts = await first.strengths(xr)
    await first.ranking(xr, opts)
    await first.ranking(xr, opts)
    expect(log.filter((u) => u.includes('api.fda.gov'))).toHaveLength(1)

    // A new session, offline, editing a saved medication: only the display name is known.
    online = false
    const saved = matchFromLink({ displayName: xr.displayName, name: xr.name, rxcui: xr.rxcui, source: 'rxterms' })
    const offline = make()
    const scored = await offline.scoredStrengths(saved)
    expect(scored.map((o) => o.raw)).toEqual(opts.map((o) => o.raw))
    expect(scored.find((o) => o.raw === '50 mg 24 HR XR Tab')!.score).toBeGreaterThan(0)
    await expect(offline.search('meto')).rejects.toMatchObject({ code: 'offline' })

    // Expired entries refresh when online and are still served when not.
    now = new Date(now.getTime() + CACHE_TTL_MS + 1000)
    expect((await make().strengths(saved)).length).toBe(opts.length)
    online = true
    const before = log.length
    await make().strengths(saved)
    expect(log.length).toBe(before + 1)
    expect(log[log.length - 1]).toContain('name_as_code')
  })

  it('returns unscored strengths when openFDA fails', async () => {
    const f: FetchFn = async (url) => (url.includes('api.fda.gov') ? jsonResponse({}, 429) : jsonResponse(rx('metoprolol')))
    const lookup = new DrugLookup({ catalog: new RxTermsCatalog(f), ranker: new OpenFdaStrengthRanker(f), store: new MemoryDrugCache() })
    const scored = await lookup.scoredStrengths(drug('metoprolol', 'Metoprolol XR (Oral Pill)'))
    expect(scored.length).toBe(8)
    expect(scored.every((o) => o.score === null)).toBe(true)
  })
})
