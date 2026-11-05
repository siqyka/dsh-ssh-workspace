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

import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

const routesSource = readFileSync(path.join(pluginRoot, 'lib', 'routes.js'), 'utf8')
const toolsSource = readFileSync(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')

console.log('\n[1] the counters read the source')
{
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
    regenerated.includes(`| HTTP routes | ${numbers.countRoutes(routesSource)} |`),
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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
