/**
 * Generate the documentation's "how big is this" numbers from the source.
 *
 * ## Why this exists
 *
 * `docs/development.md` states the route count, the tool count, the patch
 * count, the suite count and the assertion totals. Those numbers were typed by
 * hand, and the repository's own history shows what that costs: several of them
 * were corrected more than once, each time after a release had already shipped
 * with the old value. A number a human maintains goes stale the moment the code
 * changes, and nobody notices until someone rereads the whole document.
 *
 * So the numbers are COMPUTED here and spliced into a marked region of the
 * document. The marker is the contract:
 *
 *     <!-- doc-numbers:begin -->
 *     ...generated table...
 *     <!-- doc-numbers:end -->
 *
 * `--check` compares the file against a fresh generation and fails when they
 * differ, which is what makes "forgot to update the docs" a red build instead of
 * a later correction.
 *
 * ## What it deliberately does not count
 *
 * Assertion totals require RUNNING the suites, and a check that runs the whole
 * test matrix before it can compare a number is not a fast gate. The suite count
 * comes from the runner's own list; the assertion total is reported as a
 * separately stamped sample when a caller passes `--assertions N`.
 *
 * @module @shiqyka/dsh-ssh-workspace/scripts/doc-numbers
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The document this script owns. */
const TARGET = path.join(root, 'docs', 'development.md')

const BEGIN = '<!-- doc-numbers:begin -->'
const END = '<!-- doc-numbers:end -->'

/**
 * Read a file that must exist, or fail loudly.
 *
 * There is deliberately no `readOrEmpty` beside this. A reader that answers ''
 * for a missing file does not report "missing": it reports an empty answer, and
 * every caller then turns that into a number (0 tools), a passing claim (over
 * an empty set), or a second error that names the wrong thing. A moved or
 * renamed file has to turn into a red gate that names the file.
 *
 * @param {string} file - the file to read.
 * @returns {string} the file's text.
 * @throws {Error} when the file cannot be read.
 */
function readRequired (file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(
      `doc-numbers: cannot read ${path.relative(root, file)} — the figure it feeds would be silently wrong (${error.code ?? error.message})`
    )
  }
}

/**
 * Count the routes a route module declares.
 *
 * Counted from the descriptor list rather than by grepping a number, because the
 * point is to reflect the code. Each route is one `kind: '…'` entry followed by
 * its `path:`; the entry shape is the module's own contract, so a new route
 * written in the established style is counted automatically.
 *
 * @param {string} source - the routes module source.
 * @returns {number} the route count.
 */
export function countRoutes (source) {
  return (source.match(/kind: 'exact',\s*\n\s*path:/gu) ?? []).length
}

/**
 * Count the tools a module registers.
 *
 * Every tool is built by `defineTool({ name: '…' })`, which is the one place a
 * tool's identity is declared.
 *
 * @param {string} source - the tools module source.
 * @returns {number} the tool count.
 */
export function countTools (source) {
  return (source.match(/defineTool\(\{\s*\n\s*name: '/gu) ?? []).length
}

/**
 * Count the upstream patch modules.
 *
 * They are the `lib/patch-*.js` files, which is also how `docs/upstream-workarounds.md`
 * identifies them — one file, one workaround.
 *
 * @returns {number} the patch module count.
 */
export function countPatches () {
  return patchModules().length
}

/**
 * The patch modules, as paths relative to `lib/`.
 *
 * The family is a naming convention (`patch-*.js`), not a folder, so it is
 * FOUND by walking rather than assumed to sit at the top level. What the figure
 * reports is a fact about the source; where the files happen to live is a
 * detail of the layout, and it is derived below so the table's `source` column
 * cannot go on naming a folder that no longer holds them.
 *
 * @returns {string[]} relative patch module paths, sorted.
 */
export function patchModules () {
  return moduleFiles(path.join(root, 'lib'))
    .filter(name => path.posix.basename(name).startsWith('patch-') && name.endsWith('.js'))
}

/**
 * The suite names, from the runner's own list.
 *
 * Read from `tests/run.mjs` rather than from the directory: a suite file that is
 * not in the list never runs, and counting files would report a suite that
 * nobody executes.
 *
 * @returns {string[]} suite names in run order.
 */
export function suiteNames () {
  const source = readRequired(path.join(root, 'tests', 'run.mjs'))
  const block = /const SUITES = \[([\s\S]*?)\]/u.exec(source)
  if (block === null) {
    throw new Error('doc-numbers: tests/run.mjs has no `const SUITES = [...]` list — the suite count cannot be computed')
  }
  return [...block[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
}

/**
 * The route module sources, wherever they live.
 *
 * The family is a folder: `lib/routes/` holds the composition point, the
 * descriptor table and every handler module. Reading only one of them would
 * make the count silently drop as a handler moved — a figure that changes
 * because of a refactor is a figure nobody trusts afterwards.
 *
 * Every `.js` under the directory is read, in sorted order, so a new module is
 * counted without anyone updating a list here.
 *
 * @returns {string[]} the route module sources.
 */
export function routeSources () {
  const directory = path.join(root, 'lib', 'routes')
  return moduleFiles(directory).map(name => readRequired(path.join(directory, ...name.split('/'))))
}

/**
 * Count the modules under `lib/`, subdirectories included.
 *
 * `lib/client/` and `lib/routes/` hold real modules; counting only the top level
 * would make the figure fall whenever a file moved into one of them, which is
 * exactly the kind of drift this table exists to prevent.
 *
 * @param {string} [directory] - the directory to walk; defaults to `lib/`.
 * @returns {number} module count.
 */
export function countModules (directory = path.join(root, 'lib')) {
  return moduleFiles(directory).length
}

/**
 * Every `.js` module under a directory, as paths relative to it.
 *
 * A module that moved into a subfolder is still a module of this plugin, so the
 * walk is recursive and the answer is a relative path rather than a bare name —
 * two folders can hold a same-named file, and a caller that has to say WHICH one
 * it found cannot do that with a basename.
 *
 * @param {string} directory - the directory to walk.
 * @returns {string[]} relative module paths, POSIX separators, sorted.
 * @throws {Error} when the directory cannot be read.
 */
export function moduleFiles (directory) {
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    throw new Error(
      `doc-numbers: cannot list ${path.relative(root, directory)} — every figure derived from it would be silently wrong (${error.code ?? error.message})`
    )
  }
  const found = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const nested of moduleFiles(path.join(directory, entry.name))) {
        found.push(path.posix.join(entry.name, nested))
      }
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      found.push(entry.name)
    }
  }
  return found.sort()
}

/**
 * The one module of `lib/` whose basename is `name`.
 *
 * Found rather than assumed, so a module that moves into a subfolder keeps its
 * figure instead of turning it into a silent zero. Zero or several matches are
 * both errors: "not there" and "there twice" are different defects, and neither
 * is something a count should paper over.
 *
 * @param {string} name - the module's basename, e.g. `tools.js`.
 * @returns {string} its absolute path.
 * @throws {Error} when the module is missing or ambiguous.
 */
export function findModule (name) {
  const matches = moduleFiles(path.join(root, 'lib'))
    .filter(relative => path.posix.basename(relative) === name)
  if (matches.length !== 1) {
    throw new Error(
      `doc-numbers: expected exactly one lib/**/${name}, found ${matches.length} — the figure it feeds cannot be computed`
    )
  }
  return path.join(root, 'lib', ...matches[0].split('/'))
}

/**
 * Build the generated table.
 *
 * @param {{assertions?: number, sampledAt?: string}} [options] - the run-dependent figures.
 * @returns {string} the marked region, markers included.
 */
export function renderNumbers (options = {}) {
  const routes = routeSources().reduce((total, source) => total + countRoutes(source), 0)
  const toolsPath = findModule('tools.js')
  const tools = countTools(readRequired(toolsPath))
  const patchFiles = patchModules()
  const patches = patchFiles.length
  const modules = countModules()
  const suites = suiteNames()
  // The `source` column names where the figure was read FROM, so it is derived
  // from the paths actually used. A hardcoded `lib/tools.js` would keep pointing
  // at a file that moved, which reads as "the count is wrong" rather than "the
  // label is stale" — and the number itself would already have thrown above.
  const toolsSource = path.relative(root, toolsPath).split(path.sep).join('/')
  // The patch family is one convention that could be spread over more than one
  // folder (a split family is a layout choice, not a defect), so the column only
  // names a folder when every patch module sits in the same one.
  const patchFolders = new Set(patchFiles.map(name => path.posix.dirname(name)))
  const [patchFolder] = patchFolders
  const patchSource = patchFolders.size === 1 && patchFolder !== '.'
    ? `\`lib/${patchFolder}/patch-*.js\``
    : '`lib/patch-*.js`'
  const lines = [
    BEGIN,
    '<!-- generated by scripts/doc-numbers.mjs — do not edit by hand -->',
    '',
    '| figure | value | source |',
    '| --- | --- | --- |',
    `| HTTP routes | ${routes} | \`lib/routes/\` |`,
    `| model-facing tools | ${tools} | \`${toolsSource}\` |`,
    `| upstream patch modules | ${patches} | ${patchSource} |`,
    `| modules under \`lib/\` | ${modules} | recursive listing |`,
    `| test suites | ${suites.length} | \`tests/run.mjs\` |`,
  ]
  if (typeof options.assertions === 'number' && Number.isInteger(options.assertions)) {
    const when = options.sampledAt ?? new Date().toISOString().slice(0, 10)
    lines.push(`| passing assertions (sampled) | ${options.assertions} | measured ${when} |`)
  } else {
    lines.push('| passing assertions (sampled) | — | run `node scripts/doc-numbers.mjs --assertions N` with the count from a full test run |')
  }
  lines.push('', END)
  return lines.join('\n')
}

/**
 * Read the stamped assertion sample back out of a document.
 *
 * The assertion total is the one figure this script cannot compute: it requires
 * running every suite. It is therefore STAMPED by a caller who measured it, and
 * `--check` has to honour that stamp — comparing against the placeholder would
 * declare a freshly stamped document stale on the very next check.
 *
 * A missing or unparsable row means "not stamped", so a document that never had
 * a sample keeps the placeholder rather than failing to check.
 *
 * @param {string} document - the document text.
 * @returns {{assertions: number, sampledAt: string} | undefined} the stamp, when present.
 */
function readStamp (document) {
  const row = /\| passing assertions \(sampled\) \| (\d+) \| measured ([^|]+?) \|/u.exec(document)
  if (row === null) return undefined
  const assertions = Number.parseInt(row[1], 10)
  if (!Number.isInteger(assertions) || assertions <= 0) return undefined
  return { assertions, sampledAt: row[2].trim() }
}

/**
 * Splice the generated region into a document.
 *
 * The region is replaced in place, so surrounding prose survives. A document
 * without markers is a hard error rather than a silent no-op: silently doing
 * nothing is how a generator ends up never having run.
 *
 * @param {string} document - the current document text.
 * @param {string} region - the generated region.
 * @returns {string} the updated document.
 * @throws {Error} when the markers are missing.
 */
export function spliceRegion (document, region) {
  const begin = document.indexOf(BEGIN)
  const end = document.indexOf(END)
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`the document has no ${BEGIN} … ${END} region to replace`)
  }
  return document.slice(0, begin) + region + document.slice(end + END.length)
}

/** The suite names, for the summary line. */
function main () {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const assertionsIndex = args.indexOf('--assertions')
  const assertions = assertionsIndex >= 0 ? Number.parseInt(args[assertionsIndex + 1], 10) : undefined
  const sampledAtIndex = args.indexOf('--sampled-at')
  const sampledAt = sampledAtIndex >= 0 ? args[sampledAtIndex + 1] : undefined

  let document
  try {
    document = fs.readFileSync(TARGET, 'utf8')
  } catch (error) {
    console.error(`doc-numbers: cannot read ${path.relative(root, TARGET)} (${error.code ?? error.message})`)
    process.exit(1)
  }
  // A sampled number cannot be regenerated from the source — it comes from a
  // test run. `--check` must therefore REPLAY the stamped sample instead of
  // comparing against the placeholder, or the moment someone stamps a count
  // every subsequent `--check` would call the document stale. The stamp is read
  // back out of the document itself, which is the only place it exists.
  const stamped = assertions === undefined ? readStamp(document) : undefined
  const region = renderNumbers(stamped === undefined ? { assertions, sampledAt } : stamped)
  const expected = spliceRegion(document, region)

  if (check) {
    if (expected === document) {
      console.log(`doc-numbers: ${path.relative(root, TARGET)} is up to date`)
      process.exit(0)
    }
    // Say WHICH figure drifted: "the docs are stale" without the number is a
    // search, not an error message.
    const current = document.slice(document.indexOf(BEGIN), document.indexOf(END) + END.length)
    const currentRows = current.split('\n')
    const expectedRows = region.split('\n')
    console.error(`doc-numbers: ${path.relative(root, TARGET)} is STALE — regenerate with \`node scripts/doc-numbers.mjs\``)
    for (let index = 0; index < Math.max(currentRows.length, expectedRows.length); index += 1) {
      if (currentRows[index] !== expectedRows[index]) {
        console.error(`  line ${index + 1}:`)
        console.error(`    now:       ${currentRows[index] ?? '(missing)'}`)
        console.error(`    expected:  ${expectedRows[index] ?? '(missing)'}`)
      }
    }
    process.exit(1)
  }

  fs.writeFileSync(TARGET, expected)
  const suites = suiteNames()
  console.log(`doc-numbers: wrote ${path.relative(root, TARGET)} (${suites.length} suites, ${routeSources().reduce((total, source) => total + countRoutes(source), 0)} routes)`)
}

// Only run when invoked directly, so the exports stay importable by a suite.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
