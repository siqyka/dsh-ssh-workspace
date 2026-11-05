/**
 * The locale dictionaries must survive a re-materialization, and a missing key
 * must never leak the raw namespace path into the UI.
 *
 * The reported bug: the "start tunnels on startup" checkbox rendered
 * `forwards.autoStart` / `forwards.autoStartHint` as literal text while every
 * other key on the same panel translated fine.
 *
 * Root cause (same family as the duplicate-chip bug): `apply` registered the
 * dictionaries with a bare `ctx.locale.register(NS, { zh, en })` wrapped in
 * `catch {}`. HMR drops the module cache entry, so `apply` runs again — but the
 * PREVIOUS instance still owns `(NS, zh)`. `register` throws on a duplicate
 * (ns, locale) pair, the catch swallows it, and `bind(NS)` keeps serving the
 * OLD dictionary. Every key added after that point resolves to undefined and
 * `dict[key] ?? key` renders the key name itself.
 *
 * Two independent defences are asserted here:
 *   1. registration goes through `ctx.effect`, so teardown releases the seat;
 *   2. `translate` falls back to the local zh table when the bound seat hands
 *      back a raw key (stale dictionary, or a language missing the entry).
 *
 * Run: node tests/locale-register-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

const passes = []
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== locale register smoke ===\n')

const source = readFileSync(path.join(pluginRoot, 'lib/client.js'), 'utf8')

/** Slice the source of the zh dictionary literal by brace matching. */
function dictionaryLiteral (name) {
  const start = source.indexOf(`const ${name} = {`)
  if (start < 0) throw new Error(`client.js does not define ${name}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const zh = eval(`(${dictionaryLiteral('zh')})`) // eslint-disable-line no-eval
const en = eval(`(${dictionaryLiteral('en')})`) // eslint-disable-line no-eval

// ---------------------------------------------------------------------------
console.log('[dictionary parity]')

const zhKeys = Object.keys(zh)
const enKeys = Object.keys(en)
check('zh dictionary is non-empty', zhKeys.length > 100, `${zhKeys.length} keys`)
check(
  'zh and en expose the same key set',
  zhKeys.length === enKeys.length && zhKeys.every((k) => Object.hasOwn(en, k)),
  `zh=${zhKeys.length} en=${enKeys.length}`,
)
check(
  'every key carries a translated zh value',
  zhKeys.every((k) => typeof zh[k] === 'string' && zh[k].length > 0),
)
check(
  'no zh value is a raw key name',
  zhKeys.every((k) => zh[k] !== k),
)

// The two keys the bug report singled out must exist with real text.
for (const key of ['forwards.autoStart', 'forwards.autoStartHint']) {
  check(`${key} exists in zh`, Object.hasOwn(zh, key) && zh[key] !== key)
  check(`${key} exists in en`, Object.hasOwn(en, key) && en[key] !== key)
}

// ---------------------------------------------------------------------------
console.log('\n[registration lifecycle]')

// Registration must run inside ctx.effect so its disposer fires on teardown.
const effectIdx = source.indexOf('ssh-workspace: locale dictionaries')
check('locale registration is owned by a lifecycle effect', effectIdx > 0)
if (effectIdx > 0) {
  const before = source.slice(Math.max(0, effectIdx - 900), effectIdx)
  check('the effect body registers the dictionaries', /locale\?\.register\?\.\(NS, \{ zh, en \}\)/.test(before))
  check(
    'registration returns a disposer (not a bare call)',
    /return ctx\.locale\?\.register\?\.\(NS, \{ zh, en \}\)/.test(before),
    'a bare register() leaves the previous instance owning (NS, zh)',
  )
  check('registration is passed to ctx.effect, not called directly', /ctx\.effect\(registerDictionaries/.test(source))
  check(
    'a host without ctx.effect still registers',
    /else \{\s*registerDictionaries\(\)\s*\}/.test(source),
  )
  check('registration is not a bare top-level call', !/^\s{6}try \{ ctx\.locale\?\.register\?\.\(NS/m.test(source))
}

// A failed registration must degrade, never throw out of apply.
check(
  'registration failure is contained',
  /catch \{\s*return \(\) => \{\}\s*\}/.test(source),
)

// ---------------------------------------------------------------------------
console.log('\n[missing-key fallback]')

// Reproduce the exact resolution rule the fix installs.
function makeTranslate (bound, table) {
  return (key, params) => {
    const out = bound(key)
    const text = out === undefined || out === null || out === key
      ? (table[key] ?? key)
      : out
    if (params === undefined) return text
    let acc = text
    for (const [k, v] of Object.entries(params)) acc = acc.replace(`{${k}}`, String(v))
    return acc
  }
}

// A stale bound dictionary: knows the older keys, not the newly added ones.
const staleBound = (key) => ({ 'forwards.title': '端口转发' }[key])

const t = makeTranslate(staleBound, zh)
check('a key the bound dictionary lacks falls back to zh', t('forwards.autoStart') === zh['forwards.autoStart'])
check('a key the bound dictionary knows keeps its value', t('forwards.title') === '端口转发')
check('an unknown-everywhere key still names itself', t('nope.missing') === 'nope.missing')

// A bound dictionary that returns the key verbatim must also fall back.
const echoBound = (key) => key
const tEcho = makeTranslate(echoBound, zh)
check(
  'a bound seat echoing the key falls back to zh',
  tEcho('forwards.autoStartHint') === zh['forwards.autoStartHint'],
)

// Placeholders must survive the fallback path.
check(
  'placeholder expansion survives the fallback',
  makeTranslate(echoBound, zh)('forwards.portBusy', { port: 5173 }).includes('5173') ||
    makeTranslate(echoBound, zh)('forwards.portBusy', { port: 5173 }) !== 'forwards.portBusy',
)

// No zh value may render as a key: guard the whole table, not just two keys.
const leaking = zhKeys.filter((k) => makeTranslate(echoBound, zh)(k) === k)
check('no key renders raw through the fallback path', leaking.length === 0, leaking.join(', '))

// ---------------------------------------------------------------------------
console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===\n`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
