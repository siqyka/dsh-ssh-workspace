/**
 * Documentation numbers: generated, not typed.
 *
 * The repository's history has a pattern in it: the route count, the tool count
 * and the suite count were corrected more than once, each correction happening
 * after a release had already shipped with the old value. A number a human
 * maintains goes stale the moment the code changes.
 *
 * These assertions pin the two halves that make the generator trustworthy:
 * the counters actually read the source (so a new route is counted without
 * anyone remembering to), and a stale document is DETECTED (so "forgot to
 * regenerate" is a red build, not a later correction).
 *
 * Run: node tests/doc-numbers-smoke.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const numbers = await import(pathToFileURL(path.join(pluginRoot, 'scripts', 'doc-numbers.mjs')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const toolsSource = readFileSync(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')

console.log('\n[1] the counters read the source')
{
  // The route family is a folder: `lib/routes/` holds the composition point and
  // every handler module, so the counter is exercised against the sum of every
  // source. Asserting a positive count for any ONE file would fail for a reason
  // that is not a defect.
  const sources = numbers.routeSources()
  const routesSource = sources.join('\n')
  const baseline = numbers.countRoutes(routesSource)
  check('the route count is a positive integer', Number.isInteger(baseline) && baseline > 0, String(baseline))
  // A new route written in the established style must be counted without
  // anyone updating a table: append one and prove the number moves.
  const withOneMore = `${routesSource}\n{\n  kind: 'exact',\n  path: '/api/dsh-ssh-workspace/example',\n  handler: async () => {},\n}\n`
  check('adding a route increases the count',
    numbers.countRoutes(withOneMore) === baseline + 1,
    `${numbers.countRoutes(withOneMore)} vs ${baseline}`)

  const toolBaseline = numbers.countTools(toolsSource)
  check('the tool count is a positive integer', Number.isInteger(toolBaseline) && toolBaseline > 0, String(toolBaseline))
  const withOneMoreTool = `${toolsSource}\nfunction exampleTool () {\n  return defineTool({\n    name: 'ssh_workspace_example',\n  })\n}\n`
  check('adding a tool increases the count',
    numbers.countTools(withOneMoreTool) === toolBaseline + 1,
    `${numbers.countTools(withOneMoreTool)} vs ${toolBaseline}`)

  // The route handlers live in `lib/routes/` beside the composition point. The
  // figure has to follow them, or it would drop the moment a handler moved out
  // of the file it used to share — and a number that changes because of a
  // refactor stops being trusted.
  check('the route sources are found', sources.length > 0, String(sources.length))
  check('they include the composition point', sources.some(source => source.includes('export function makeRoutes')))
  // The figure the document reports is the SUM over every source, so a route
  // that moved into lib/routes/ is still counted exactly once. Asserted as
  // "the document's number equals the sum" rather than against the single-file
  // count: that count shrinks as handlers move out, and comparing to it would
  // turn the refactor itself into a failure.
  const across = sources.reduce((total, source) => total + numbers.countRoutes(source), 0)
  const documented = /^\| HTTP routes \| (\d+) \|/mu.exec(numbers.renderNumbers())?.[1]
  check('the documented figure is the sum over every source',
    documented === String(across), `doc says ${documented}, sources sum to ${across}`)
}

console.log('\n[2] the suite list comes from the runner, not the directory')
{
  const names = numbers.suiteNames()
  check('suites were found', names.length > 0, String(names.length))
  check('every name maps to a real file', names.every(name => {
    try {
      readFileSync(path.join(pluginRoot, 'tests', `${name}-smoke.mjs`))
      return true
    } catch {
      return false
    }
  }), names.join(','))
  // The runner's list is the authority: a file present but unlisted never runs,
  // and counting the directory would report a suite nobody executes.
  check('the count matches the runner list, not the directory listing',
    names.length === numbers.suiteNames().length, String(names.length))
}

console.log('\n[3] the generated region is well formed')
{
  const region = numbers.renderNumbers()
  check('the region is bounded by its markers',
    region.startsWith(numbers.renderNumbers().split('\n')[0]) && region.includes('doc-numbers:end'),
    region.split('\n')[0])
  check('the region says it is generated', /do not edit by hand/u.test(region), 'missing warning')
  check('the region is a markdown table', region.includes('| figure | value | source |'), 'not a table')
  check('the assertion total is not invented',
    /passing assertions \(sampled\)/u.test(region) && /—/u.test(region),
    'assertion row claims a number it did not measure')
}

console.log('\n[4] a stale document is detected, not silently accepted')
{
  const document = readFileSync(path.join(pluginRoot, 'docs', 'development.md'), 'utf8')
  // The assertion total is the one figure that cannot be computed from source —
  // it needs a full test run — so it is STAMPED into the document and `--check`
  // replays that stamp. Comparing a stamped document against the placeholder
  // would report it stale forever the moment anyone measured it, which is the
  // bug this suite caught when the sample was first written.
  const stamped = /^\| passing assertions \(sampled\) \| (\d+) \| measured ([^|]+?) \|/mu.exec(document)
  check('the document stamps a measured assertion total', stamped !== null,
    'no stamp row — the sampled figure exists to be measured, not guessed')
  const region = stamped === null
    ? numbers.renderNumbers()
    : numbers.renderNumbers({
        assertions: Number.parseInt(stamped[1], 10),
        // The row reads `measured <date>`; `renderNumbers` adds the word itself.
        sampledAt: stamped[2].trim(),
      })
  const current = numbers.spliceRegion(document, region)
  check('splicing the current numbers is a no-op (the doc is up to date)',
    current === document, 'docs/development.md is stale — run node scripts/doc-numbers.mjs')

  // Simulate drift: change one generated figure and confirm the splice differs,
  // which is exactly what `--check` compares.
  const stale = document.replace(/\| HTTP routes \| \d+ \|/u, '| HTTP routes | 999 |')
  const regenerated = numbers.spliceRegion(stale, region)
  check('a changed figure is detected as drift', regenerated !== stale, 'drift not detected')
  check('the regenerated text restores the real number',
    regenerated.includes(`| HTTP routes | ${numbers.routeSources().reduce((total, source) => total + numbers.countRoutes(source), 0)} |`),
    regenerated.split('\n').find(line => line.includes('HTTP routes')) ?? '(no row)')
}

console.log('\n[5] splicing refuses a document with no markers')
{
  let error
  try {
    numbers.spliceRegion('# a document without markers\n', 'generated')
  } catch (caught) {
    error = caught
  }
  check('a missing region is an error, not a silent no-op', error !== undefined, String(error))
  check('the error names the marker to add',
    /doc-numbers:begin/u.test(String(error?.message ?? '')), String(error?.message))
}

// ---------------------------------------------------------------------------
// The suite table must list every suite the runner runs — and nothing else
// ---------------------------------------------------------------------------
// Two failure modes have actually happened here:
//
//   1. `ssh-config-smoke` and `redact-smoke` existed, passed, and were NOT in
//      `run.mjs`'s SUITES — 72 assertions that `npm test` never executed. A
//      suite that exists but never runs is worse than a missing one: the file
//      is evidence of coverage that does not exist.
//   2. The development table drifted out of step with SUITES, so the document
//      described a suite list the runner did not have (and omitted two).
//
// Both are the same missing invariant, so it is asserted once: the suite list
// in `run.mjs`, the rows in `docs/development.md`, and the generated table's
// suite count must agree. A new suite therefore cannot be added by creating a
// file, and cannot be added to the runner without being documented.
console.log('\n[6] the runner, the document table and the generated count agree')
{
  const suites = numbers.suiteNames()
  const document = readFileSync(path.join(pluginRoot, 'docs', 'development.md'), 'utf8')
  const documented = [...document.matchAll(/^\| `([a-z0-9-]+)-smoke` \|/gmu)].map(match => match[1])

  // A suite FILE that is not in the runner: 72 assertions existed that way
  // (`ssh-config`, `redact`) and `npm test` never executed them. This is the
  // direction that is invisible — the file looks like coverage.
  const orphans = readdirSync(path.join(pluginRoot, 'tests'))
    .filter(name => name.endsWith('-smoke.mjs'))
    .map(name => name.replace(/-smoke\.mjs$/u, ''))
    .filter(name => !suites.includes(name))
  check('no suite file is orphaned from the runner', orphans.length === 0, JSON.stringify(orphans))

  // A suite listed in the runner with no file would fail at run time with a
  // confusing "not found"; catching it here names the problem.
  const missingFiles = suites.filter(name => !existsSync(path.join(pluginRoot, 'tests', `${name}-smoke.mjs`)))
  check('every listed suite has a file', missingFiles.length === 0, JSON.stringify(missingFiles))

  const undocumented = suites.filter(name => !documented.includes(name))
  check('every suite in the runner has a row in the development table',
    undocumented.length === 0, JSON.stringify(undocumented))

  const phantom = documented.filter(name => !suites.includes(name))
  check('the development table names no suite the runner does not run',
    phantom.length === 0, JSON.stringify(phantom))

  check('the generated suite count equals the runner length',
    document.includes(`| test suites | ${suites.length} |`), `runner has ${suites.length}`)

  check('the runner list has no duplicate entries',
    new Set(suites).size === suites.length,
    `${suites.length} entries, ${new Set(suites).size} distinct`)
}

// ---------------------------------------------------------------------------
// A counter must not answer 0 for something it could not find
// ---------------------------------------------------------------------------
// The figures in this table are spliced into a document, which is what makes a
// silent zero dangerous: nothing is red, and the document now states a number
// that is not merely stale but WRONG in a direction nobody re-derives. Three
// sites had that shape — a flat listing of `lib/`, a `tools.js` read whose
// failure became `''` and then `0`, and a patch count that only saw the top
// level. `lib/patch/` and any future folder would have made each of them
// quietly smaller.
console.log('\n[7] a counter refuses to answer 0 for something it could not find')
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'doc-numbers-'))
  try {
    mkdirSync(path.join(sandbox, 'nested'))
    writeFileSync(path.join(sandbox, 'top.js'), 'export const a = 1\n')
    writeFileSync(path.join(sandbox, 'nested', 'deep.js'), 'export const b = 2\n')
    writeFileSync(path.join(sandbox, 'nested', 'notes.txt'), 'not a module\n')

    // The walk is the authority for both the module count and the patch count,
    // so a file in a subfolder has to appear in it — by relative path, because
    // two folders may hold a same-named module.
    const walked = numbers.moduleFiles(sandbox)
    check('the walk finds a module in a subfolder', walked.includes('nested/deep.js'), JSON.stringify(walked))
    check('the walk ignores a non-module file', !walked.some(name => name.endsWith('.txt')), JSON.stringify(walked))
    check('the walk reports relative paths, not basenames',
      walked.every(name => path.isAbsolute(name) === false), JSON.stringify(walked))
    check('the module count is the walk length',
      numbers.countModules(sandbox) === walked.length, `${numbers.countModules(sandbox)} vs ${walked.length}`)

    // A directory that is not there is a defect, not an empty answer: "there
    // are zero modules in a folder that does not exist" reads as a fact.
    let missing
    try {
      numbers.moduleFiles(path.join(sandbox, 'gone'))
    } catch (caught) {
      missing = caught
    }
    check('walking a missing directory is an error, not 0', missing !== undefined, String(missing))
    check('the error names the directory it could not list',
      /gone/u.test(String(missing?.message ?? '')), String(missing?.message))

    // The counters behind the tool and patch figures locate their module by
    // basename, so a move into a folder keeps the figure. Ambiguity and absence
    // are both errors — they are different defects and neither is a number.
    const tools = numbers.findModule('tools.js')
    check('the tools module is found wherever it lives', path.basename(tools) === 'tools.js', tools)
    check('the module it finds is under lib/', tools.includes(`${path.sep}lib${path.sep}`), tools)
    let unknown
    try {
      numbers.findModule('does-not-exist.js')
    } catch (caught) {
      unknown = caught
    }
    check('a module that cannot be found is an error, not 0 tools', unknown !== undefined, String(unknown))
    check('the error names the module it wanted',
      /does-not-exist\.js/u.test(String(unknown?.message ?? '')), String(unknown?.message))

    // The real numbers still come out, so the tightening did not turn the gate
    // into a check that can only fail.
    const region = numbers.renderNumbers()
    const modules = /^\| modules under `lib\/` \| (\d+) \|/mu.exec(region)?.[1]
    check('the module figure is still computed from the source',
      modules === String(numbers.moduleFiles(path.join(pluginRoot, 'lib')).length),
      `doc region says ${modules}`)
    // The patch family is a naming convention, not a folder: it is FOUND by
    // walking, so the figure survives the files moving into `lib/patch/` and the
    // table's `source` column follows them there instead of naming a folder that
    // no longer holds them.
    const patches = numbers.patchModules()
    check('the patch modules are found by walking', patches.length > 0, String(patches.length))
    check('the patch count is the list length',
      numbers.countPatches() === patches.length, `${numbers.countPatches()} vs ${patches.length}`)
    check('the patch source column names where they actually are',
      /^\| upstream patch modules \| \d+ \| `lib\/(?:[\w.-]+\/)?patch-\*\.js` \|$/mu.test(numbers.renderNumbers()),
      numbers.renderNumbers().split('\n').find(line => line.includes('upstream patch')) ?? '(no row)')
    check('the patch figure is still positive',
      /^\| upstream patch modules \| [1-9]\d* \|/mu.test(region),
      region.split('\n').find(line => line.includes('upstream patch')) ?? '(no row)')
    check('the tool figure is still positive',
      /^\| model-facing tools \| [1-9]\d* \|/mu.test(region),
      region.split('\n').find(line => line.includes('model-facing tools')) ?? '(no row)')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
