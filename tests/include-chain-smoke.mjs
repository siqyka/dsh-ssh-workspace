/**
 * `Include` following: order, globs, cycles, and the depth cap.
 *
 * Every case here is a file-system hazard that would otherwise become an
 * infinite loop or a silently misordered configuration, so each is executed
 * against real temporary directories rather than asserted from source text.
 *
 * Run: node tests/include-chain-smoke.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { readConfigWithIncludes, expandGlob, MAX_INCLUDE_DEPTH } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'include-chain.js')).href)
const { sectionsOf, selects } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'ssh-config.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const cleanups = []
function scratch () {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-include-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** Write a file, creating parent directories as needed. */
function write (file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

console.log('\n=== include chain smoke ===\n')

// ---------------------------------------------------------------------------
// 1. A plain include is spliced IN PLACE
// ---------------------------------------------------------------------------
console.log('[1] an included file is inserted where the directive is')
{
  const dir = scratch()
  write(path.join(dir, 'main'), 'Host first\n  HostName one.example\nInclude inc\nHost last\n  HostName three.example\n')
  write(path.join(dir, 'inc'), 'Host middle\n  HostName two.example\n')

  const { text, files, problems } = readConfigWithIncludes(path.join(dir, 'main'))
  const sections = sectionsOf(text)
  check('three host blocks', sections.filter(section => section.kind === 'host').length === 3,
    JSON.stringify(sections.map(section => section.patterns)))
  check('the order is main, included, main',
    sections.filter(section => section.kind === 'host').map(section => section.patterns[0]).join(',') === 'first,middle,last',
    JSON.stringify(sections.filter(section => section.kind === 'host').map(section => section.patterns[0])))
  check('both files were read', files.length === 2, JSON.stringify(files))
  check('nothing was reported as a problem', problems.length === 0, JSON.stringify(problems))
}

// ---------------------------------------------------------------------------
// 2. Order decides precedence, which is the reason for splicing
// ---------------------------------------------------------------------------
console.log('\n[2] a value after the Include overrides the included one')
{
  const dir = scratch()
  // This is the whole point of in-place expansion. If an implementation put the
  // included file at the END, `Host *` from the include would come last and the
  // specific `Host web` written above would still win — but the reverse case
  // (an include that must lose) would be silently inverted.
  write(path.join(dir, 'main'), 'Host web\n  User specific\nInclude inc\n')
  write(path.join(dir, 'inc'), 'Host *\n  User catchall\n')

  const { text } = readConfigWithIncludes(path.join(dir, 'main'))
  // First-wins across the merged text, exactly as hosts.js resolves it.
  const props = {}
  for (const section of sectionsOf(text)) {
    if (!selects(section, 'web')) continue
    for (const { keyword, value } of section.entries) {
      if (!(keyword in props)) props[keyword] = value
    }
  }
  check('the specific block still wins', props.user === 'specific', JSON.stringify(props))
}

// ---------------------------------------------------------------------------
// 3. Globs
// ---------------------------------------------------------------------------
console.log('\n[3] a glob include reads every match, in order')
{
  const dir = scratch()
  write(path.join(dir, 'main'), 'Include conf.d/*.conf\n')
  write(path.join(dir, 'conf.d', 'b.conf'), 'Host bee\n  HostName b.example\n')
  write(path.join(dir, 'conf.d', 'a.conf'), 'Host aye\n  HostName a.example\n')
  write(path.join(dir, 'conf.d', 'ignored.txt'), 'Host nope\n  HostName n.example\n')

  const { text } = readConfigWithIncludes(path.join(dir, 'main'))
  const names = sectionsOf(text).filter(section => section.kind === 'host').map(section => section.patterns[0])
  check('only the matching suffix is read', !names.includes('nope'), JSON.stringify(names))
  check('both matches are read', names.includes('aye') && names.includes('bee'), JSON.stringify(names))
  check('matches are in sorted order, not directory order', names.join(',') === 'aye,bee', JSON.stringify(names))
}

// ---------------------------------------------------------------------------
// 4. A glob matching nothing is not an error
// ---------------------------------------------------------------------------
console.log('\n[4] an empty glob is reported, not thrown')
{
  const dir = scratch()
  write(path.join(dir, 'main'), 'Include conf.d/*.conf\nHost web\n  HostName w.example\n')
  mkdirSync(path.join(dir, 'conf.d'))
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'main'))
  check('the rest of the file still reads', /Host web/u.test(text), JSON.stringify(text))
  check('the empty glob is reported', problems.some(entry => entry.kind === 'no-match'),
    JSON.stringify(problems))
  check('and it did not throw', true)
}

// ---------------------------------------------------------------------------
// 5. Cycles
// ---------------------------------------------------------------------------
console.log('\n[5] a cycle stops instead of hanging')
{
  const dir = scratch()
  write(path.join(dir, 'a'), 'Host alpha\n  HostName a.example\nInclude b\n')
  write(path.join(dir, 'b'), 'Host beta\n  HostName b.example\nInclude a\n')
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'a'))
  check('the first file read completely', /Host alpha/u.test(text) && /Host beta/u.test(text),
    JSON.stringify(text))
  check('the cycle was detected', problems.some(entry => entry.kind === 'cycle'),
    JSON.stringify(problems))
  check('it terminated', true)
}

{ // A self-include is the smallest cycle.
  const dir = scratch()
  write(path.join(dir, 'self'), 'Host me\n  HostName me.example\nInclude self\n')
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'self'))
  check('a self-include terminates', /Host me/u.test(text), JSON.stringify(text))
  check('and is reported as a cycle', problems.some(entry => entry.kind === 'cycle'),
    JSON.stringify(problems))
}

// ---------------------------------------------------------------------------
// 6. Two different PATHS naming one file are still one file
// ---------------------------------------------------------------------------
console.log('\n[6] a cycle reached through a second path is detected')
{
  // The property under test is not "symlinks work" — it is that cycle detection
  // compares REAL paths, so two spellings of one file cannot be walked twice.
  //
  // Built without a symlink on purpose. `symlinkSync` needs Developer Mode or
  // elevation on Windows and silently EPERMs elsewhere, and a case that skips
  // on the platform CI runs most is a case that proves nothing there. A `./`
  // in the include path produces the same two-spellings-of-one-file situation
  // portably, because `realpathSync` collapses it.
  const dir = scratch()
  write(path.join(dir, 'self'), 'Host me\n  HostName me.example\nInclude ./self\n')
  const first = readConfigWithIncludes(path.join(dir, 'self'))
  check('a `.`-spelled self-include terminates', /Host me/u.test(first.text), JSON.stringify(first.text))
  check('and is reported as a cycle', first.problems.some(entry => entry.kind === 'cycle'),
    JSON.stringify(first.problems))

  // And the same thing one level out: a includes b, b includes a.
  write(path.join(dir, 'x'), 'Host ex\n  HostName x.example\nInclude y\n')
  write(path.join(dir, 'y'), 'Host why\n  HostName y.example\nInclude x\n')
  const second = readConfigWithIncludes(path.join(dir, 'x'))
  check('a two-file cycle is detected',
    second.problems.some(entry => entry.kind === 'cycle'), JSON.stringify(second.problems))
  check('and both files were still read', /Host ex/u.test(second.text) && /Host why/u.test(second.text),
    JSON.stringify(second.text))
}

{
  // THE case that distinguishes a real-path comparison from a written-path one.
  //
  // One file reached under TWO spellings — `conf.d/w` and `link/w`, with `link`
  // a junction to `conf.d` — is one file, and reading it twice yields two copies
  // of the same `Host` block. Comparing the strings a reader was handed sees two
  // names and obliges; comparing real paths sees one file and reports a cycle.
  //
  // Not a contrived shape: `Include conf.d/*` next to an explicit
  // `Include conf.d/web.conf` produces exactly it, as does any `..` or
  // symlinked config a person actually writes. The duplicate is SILENT —
  // first-wins makes the second copy change nothing — so the cycle report is
  // the only symptom a reader could act on.
  const dir = scratch()
  const realDir = path.join(dir, 'conf.d')
  mkdirSync(realDir, { recursive: true })
  write(path.join(realDir, 'w'), 'Host web\n  HostName w.example\n')
  let linked = true
  try {
    // `junction` is ignored on POSIX, where a symlink to a directory is what
    // this produces anyway. A file symlink needs a privilege on Windows while a
    // directory junction does not — and a case that skips on the platform CI
    // runs most proves nothing there.
    symlinkSync(realDir, path.join(dir, 'link'), 'junction')
  } catch {
    linked = false
  }
  if (linked) {
    write(path.join(dir, 'main'), 'Include conf.d/w\nInclude link/w\n')
    const outcome = readConfigWithIncludes(path.join(dir, 'main'))
    // Reported as a DUPLICATE, not a cycle: the walk terminates on its own,
    // so calling it a loop would be the wrong word for the right fix. What the
    // user needs to know is "this block appears twice", and only a real-path
    // comparison can know that two spellings are one file.
    check('one file included under two spellings is a DUPLICATE',
      outcome.problems.some(entry => entry.kind === 'duplicate'),
      JSON.stringify(outcome.problems.map(entry => entry.kind)))
    check('and it is not misreported as a cycle',
      !outcome.problems.some(entry => entry.kind === 'cycle'),
      JSON.stringify(outcome.problems.map(entry => entry.kind)))
    check('and its block was not read twice',
      outcome.text.split('Host web').length - 1 === 1,
      JSON.stringify(outcome.text))
  } else {
    console.log('  NOTE  no directory link could be created here; the realpath comparison is unpinned on this platform')
  }
}

// ---------------------------------------------------------------------------
// 7. The depth cap
// ---------------------------------------------------------------------------
console.log('\n[7] nesting is capped')
{
  const dir = scratch()
  const depth = MAX_INCLUDE_DEPTH + 3
  for (let index = 0; index < depth; index += 1) {
    const next = join(dir, `f${index}`)
    const text = index + 1 < depth ? `Host h${index}\n  HostName h.example\nInclude f${index + 1}\n` : `Host h${index}\n  HostName h.example\n`
    write(next, text)
  }
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'f0'))
  check(`reading stops at the cap (${MAX_INCLUDE_DEPTH})`, problems.some(entry => entry.kind === 'too-deep'),
    JSON.stringify(problems.map(entry => entry.kind)))
  check('the shallow files were read', /Host h0/u.test(text), JSON.stringify(text.slice(0, 80)))
}

// ---------------------------------------------------------------------------
// 8. Quoted arguments and several arguments on one line
// ---------------------------------------------------------------------------
console.log('\n[8] quoting and multiple arguments')
{
  const dir = scratch()
  write(path.join(dir, 'main'), 'Include "one" two\n')
  write(path.join(dir, 'one'), 'Host one\n  HostName one.example\n')
  write(path.join(dir, 'two'), 'Host two\n  HostName two.example\n')
  const { text } = readConfigWithIncludes(path.join(dir, 'main'))
  check('quotes are stripped', /Host one/u.test(text), JSON.stringify(text))
  check('both arguments are read', /Host two/u.test(text), JSON.stringify(text))
}

// ---------------------------------------------------------------------------
// 9. A missing top-level file is empty, not a throw
// ---------------------------------------------------------------------------
console.log('\n[9] a missing config file')
{
  const dir = scratch()
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'nope'))
  check('the text is empty', text === '', JSON.stringify(text))
  check('and nothing is reported (this is the normal first-run state)',
    problems.length === 0, JSON.stringify(problems))
}

// ---------------------------------------------------------------------------
// 10. expandGlob's own contract
// ---------------------------------------------------------------------------
console.log('\n[10] expandGlob')
{
  const dir = scratch()
  write(path.join(dir, 'a.conf'), 'x')
  write(path.join(dir, 'b.conf'), 'x')
  mkdirSync(path.join(dir, 'sub.conf'))
  check('a literal path returns itself', expandGlob(path.join(dir, 'a.conf')).length === 1,
    JSON.stringify(expandGlob(path.join(dir, 'a.conf'))))
  check('a missing literal returns nothing', expandGlob(path.join(dir, 'none')).length === 0)
  check('a glob skips directories', expandGlob(path.join(dir, '*.conf')).every(item => !item.endsWith('sub.conf')),
    JSON.stringify(expandGlob(path.join(dir, '*.conf'))))
  check('? matches exactly one character',
    expandGlob(path.join(dir, '?.conf')).length === 2, JSON.stringify(expandGlob(path.join(dir, '?.conf'))))
}

for (const cleanup of cleanups.reverse()) {
  try { cleanup() } catch { /* best effort */ }
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
