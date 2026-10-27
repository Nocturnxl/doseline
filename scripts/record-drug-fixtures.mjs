// Re-records the live API responses used by the drug-lookup unit tests.
//   node scripts/record-drug-fixtures.mjs
// Writes tests/fixtures/rxterms/*.json and tests/fixtures/openfda/*.json.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', 'tests', 'fixtures')
const RX = 'https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search'
const FDA = 'https://api.fda.gov/drug/ndc.json'
const EF = 'STRENGTHS_AND_FORMS,RXCUIS,SXDG_RXCUI'

async function save(dir, name, url) {
  const res = await fetch(url)
  const body = await res.text()
  fs.mkdirSync(path.join(root, dir), { recursive: true })
  // openFDA answers "no matches" with HTTP 404 and a JSON error body; keep the status alongside it.
  const out = dir === 'openfda' ? JSON.stringify({ status: res.status, body: JSON.parse(body) }, null, 2) : body
  fs.writeFileSync(path.join(root, dir, `${name}.json`), out)
  console.log(`${dir}/${name}.json  ${res.status}  ${body.length} bytes`)
  return JSON.parse(body)
}

const searches = ['met', 'meto', 'metoprolol', 'insulin', 'hydrocodone', 'albuterol', 'amox', 'xqzvplk']
const found = {}
for (const q of searches) {
  const data = await save('rxterms', q, `${RX}?terms=${encodeURIComponent(q)}&maxList=50&ef=${EF}`)
  data[1].forEach((name, i) => (found[name] = data[2].RXCUIS[i]))
}
await save('rxterms', 'exact-metoprolol-xr', `${RX}?sf=name_as_code&terms=${encodeURIComponent('"Metoprolol XR (Oral Pill)"')}&maxList=1&ef=${EF}`)

const ranked = {
  'metoprolol-xr': 'Metoprolol XR (Oral Pill)',
  'metoprolol-tartrate': 'Metoprolol (Oral Pill)',
  'apap-hydrocodone': 'Acetaminophen/HYDROcodone (Oral Pill)',
  'albuterol-inhalant': 'Albuterol (Inhalant)',
  'amoxicillin-liquid': 'Amoxicillin (Oral Liquid)',
  'insulin-glargine': 'Insulin analog, glargine (Injectable)',
}
for (const [file, name] of Object.entries(ranked)) {
  const ids = found[name]
  if (!ids) throw new Error(`missing ${name}`)
  const search = `openfda.rxcui:(${ids.join(' ')}) AND finished:true`
  await save('openfda', file, `${FDA}?search=${encodeURIComponent(search)}&count=openfda.rxcui.exact&limit=1000`)
}
await save('openfda', 'not-found', `${FDA}?search=${encodeURIComponent('openfda.rxcui:(99999999) AND finished:true')}&count=openfda.rxcui.exact&limit=1000`)
await save('openfda', 'strength-metoprolol-succinate', `${FDA}?search=${encodeURIComponent('generic_name:"metoprolol succinate" AND finished:true')}&count=active_ingredients.strength&limit=1000`)
