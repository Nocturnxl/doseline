// Prints the CHANGELOG.md section for one version, for GitHub Release notes.
//   node scripts/changelog-section.mjs 1.0.0
import fs from 'node:fs'
import path from 'node:path'

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!version) {
  console.error('usage: node scripts/changelog-section.mjs <version>')
  process.exit(2)
}
const text = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8')
const lines = text.split(/\r?\n/)
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`)
  process.exit(1)
}
let end = lines.findIndex((l, i) => i > start && (/^## \[/.test(l) || /^\[[^\]]+\]: /.test(l)))
if (end < 0) end = lines.length
process.stdout.write(lines.slice(start + 1, end).join('\n').trim() + '\n')
