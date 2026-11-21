/**
 * The map at the top of the browser bundle, checked against the bundle.
 *
 * `lib/client/client.js` is one ~8,300-line factory, and the numbered map in its
 * first lines is the only navigation aid it has. That map had drifted to ten
 * entries while the file held eighteen sections: two entries named banners that
 * do not exist, the rest were renamed, and six real sections were missing.
 *
 * Nothing caught it because a comment cannot fail. This can: parse the real
 * banners, parse the map, and require the two lists to agree in content AND in
 * order. Order matters because the map's whole claim is "a jump-to-next-banner
 * walk visits them in order".
 *
 * It lives in `scripts/` rather than in a suite because two callers need the
 * same rule — `npm run check` on every run, and `tests/client-shape-smoke.mjs`
 * which reports it as an assertion — and because a chunk split moves sections
 * between files, at which point "the map describes the bundle" has to be
 * answerable about more than one file.
 *
 * @module scripts/client-map
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A section banner is a line between two `// ====` borders, indented 4 spaces. */
const BORDER_RE = /^ {4}\/\/ =+\s*$/u

/** A map entry is `//   7. Directory browser dialog`. */
const ENTRY_RE = /^ {4}\/\/ +(\d+)\. (.+)$/gmu

/** A chunk is `client.<something>.js` beside `client.js`, per the Host's CLIENT_CHUNK. */
const CHUNK_RE = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u

/**
 * Every client part's source, main bundle first then chunks sorted by name.
 *
 * @returns {Array<{name: string, source: string}>} the parts.
 */
export function clientParts () {
  const directory = path.join(root, 'lib', 'client')
  const names = ['client.js', ...readdirSync(directory).filter(name => CHUNK_RE.test(name)).sort()]
  return names.map(name => ({ name, source: readFileSync(path.join(directory, name), 'utf8').replace(/\r\n/gu, '\n') }))
}

/**
 * The section banners a source actually carries, in file order.
 *
 * @param {string} source - one client part.
 * @returns {string[]} banner titles, without the `//` prefix.
 */
export function clientSections (source) {
  const lines = source.split('\n')
  const titles = []
  for (let i = 1; i < lines.length - 1; i += 1) {
    if (!BORDER_RE.test(lines[i - 1]) || !BORDER_RE.test(lines[i + 1])) continue
    if (BORDER_RE.test(lines[i])) continue
    const title = lines[i].trim().replace(/^\/\/ ?/u, '')
    if (title !== '') titles.push(title)
  }
  return titles
}

/**
 * The numbered entries of a source's map, in the order written.
 *
 * @param {string} source - one client part.
 * @returns {Array<{number: number, title: string}>} the entries.
 */
export function clientMapEntries (source) {
  return [...source.matchAll(ENTRY_RE)].map(match => ({ number: Number(match[1]), title: match[2].trim() }))
}

/** Strip a map entry's parenthetical gloss and normalise whitespace. */
function plain (title) {
  return title.replace(/\s*\([^)]*\)\s*$/u, '').trim()
}

/**
 * Whether two titles name the same section.
 *
 * A map entry may gloss a banner that itself carries a parenthetical, so one is
 * allowed to be a prefix of the other. Prefixes only — "Host card" and "Host
 * editor dialog" must never be treated as the same section.
 *
 * @param {string} a - one title.
 * @param {string} b - the other.
 * @returns {boolean} true when they match.
 */
export function sameSection (a, b) {
  const left = plain(a).toLowerCase()
  const right = plain(b).toLowerCase()
  if (left === right) return true
  return left.startsWith(right) || right.startsWith(left)
}

/**
 * Compare every part's map with its own banners.
 *
 * The main bundle's map describes the main bundle: a chunk has no map, and its
 * banners are its own. The map's own banner is not a section of the file it
 * describes, hence the leading `slice(1)`.
 *
 * @returns {{ok: boolean, parts: Array<object>}} the verdict and the evidence.
 */
export function compareClientMap () {
  const parts = clientParts().map(({ name, source }) => {
    const banners = clientSections(source)
    // Only the main bundle carries a map; a chunk starts with its own header.
    const sections = name === 'client.js' ? banners.slice(1) : banners
    const entries = clientMapEntries(source)
    const missingFromMap = entries.length === 0
      ? []
      : sections.filter(title => !entries.some(entry => sameSection(entry.title, title)))
    const phantomInMap = entries.filter(entry => !sections.some(title => sameSection(entry.title, title)))
    const numbersOk = entries.every((entry, index) => entry.number === index + 1)
    const orderOk = entries.length === sections.length &&
      entries.every((entry, index) => sameSection(entry.title, sections[index]))
    return {
      name,
      sections,
      entries: entries.map(entry => entry.title),
      missingFromMap,
      phantomInMap: phantomInMap.map(entry => entry.title),
      numbersOk,
      orderOk,
      // A chunk has no map to compare, so it cannot fail this rule.
      ok: entries.length === 0 ? true : missingFromMap.length === 0 && phantomInMap.length === 0 && numbersOk && orderOk,
    }
  })
  return { ok: parts.every(part => part.ok), parts }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verdict = compareClientMap()
  if (verdict.ok) {
    const described = verdict.parts.filter(part => part.entries.length > 0)
    const total = described.reduce((sum, part) => sum + part.sections.length, 0)
    console.log(`client-map: ${described.length} map(s) describe ${total} section(s)`)
  } else {
    for (const part of verdict.parts.filter(entry => !entry.ok)) {
      console.error(`client-map: ${part.name} disagrees with its own map`)
      if (part.missingFromMap.length > 0) console.error(`  missing from map: ${JSON.stringify(part.missingFromMap)}`)
      if (part.phantomInMap.length > 0) console.error(`  names no section: ${JSON.stringify(part.phantomInMap)}`)
      if (!part.numbersOk) console.error('  numbers are not consecutive from 1')
      if (!part.orderOk) console.error(`  order differs: map=${JSON.stringify(part.entries)} actual=${JSON.stringify(part.sections)}`)
    }
    process.exitCode = 1
  }
}
