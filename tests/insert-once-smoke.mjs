/**
 * One drop must insert exactly one @ reference, even across HMR reloads.
 *
 * The reported bug: dragging one file from the Files panel into the composer
 * produced ~22 identical chips. The plugin's per-materialization install flag
 * cannot see a PREVIOUS materialization's document listeners, and HMR drops the
 * module cache entry (`loadCache.delete`) so `apply` runs again with a fresh
 * closure — stacking one more set of listeners each time.
 *
 * The fix parks the claim set on the global so every materialization shares it,
 * and keyed on the event object so one dispatch can only be consumed once.
 * These checks exercise that contract directly, plus the wiring in the source.
 *
 * Run: node tests/insert-once-smoke.mjs
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

console.log('\n=== insert once smoke ===\n')

const source = readFileSync(path.join(pluginRoot, 'lib/client.js'), 'utf8')

/**
 * Pull one top-level function out of the client source by brace matching.
 * The helpers under test are dependency-free so they run here unchanged.
 */
function extractFunction (name) {
  const start = source.indexOf(`function ${name} (`)
  if (start < 0) throw new Error(`client.js does not define ${name}()`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}()`)
}

console.log('[shared claim set]')

// Reproduce the closure the bundle builds, against a tiny global stand-in.
const KEY = '__dshSshWorkspaceGestureClaims__'

function makeClosure (scope) {
  const build = new Function('scope', 'WeakSet', `
    const GESTURE_CLAIMS_KEY = '${KEY}'
    const handledGestures = (() => {
      if (typeof WeakSet !== 'function') return null
      const host = typeof scope === 'object' && scope !== null ? scope : null
      if (host === null) return new WeakSet()
      const existing = host[GESTURE_CLAIMS_KEY]
      if (existing instanceof WeakSet) return existing
      const created = new WeakSet()
      try {
        Object.defineProperty(host, GESTURE_CLAIMS_KEY, { value: created, configurable: true, writable: false, enumerable: false })
      } catch { return created }
      return created
    })()
    ${extractFunction('firstClaim')}
    return { firstClaim, handledGestures }
  `)
  return build(scope, WeakSet)
}

{
  const scope = {}
  const a = makeClosure(scope)
  const b = makeClosure(scope)
  check('both closures find one shared WeakSet', a.handledGestures === b.handledGestures)
  check('the set is parked on the global scope', scope[KEY] instanceof WeakSet)

  const event = { type: 'drop' }
  check('the first materialization claims the event', a.firstClaim(event) === true)
  check('a re-materialized listener refuses the same event', b.firstClaim(event) === false)
  check('a different event is still free to claim', b.firstClaim({ type: 'drop' }) === true)
}

console.log('\n[destroyed previous closure]')

{
  // The old materialization's objects are collected; the global must survive it.
  const scope = {}
  {
    const a = makeClosure(scope)
    a.firstClaim({ type: 'x' })
  }
  const b = makeClosure(scope)
  check('a later closure still reuses the parked set', scope[KEY] instanceof WeakSet)
  const reused = b.firstClaim({ type: 'y' })
  check('claiming works after the earlier closure is gone', reused === true)
}

console.log('\n[wiring]')

check('the claim set is parked on a namespaced global key',
  source.includes("const GESTURE_CLAIMS_KEY = '__dshSshWorkspaceGestureClaims__'"))
check('the set is parked on globalThis, not the module closure',
  source.includes('globalThis') && source.includes('Object.defineProperty(scope, GESTURE_CLAIMS_KEY'))
check('every gesture handler consults firstClaim',
  (source.match(/if \(!firstClaim\(event\)\) return/g) ?? []).length >= 4,
  `${(source.match(/if \(!firstClaim\(event\)\) return/g) ?? []).length} guard(s)`)
check('the drop handler claims before touching its payload',
  /const onDrop = \(event\) => \{[\s\S]{0,240}?if \(!firstClaim\(event\)\) return[\s\S]{0,40}?const payload = dragPayload/.test(source))
check('dragend deliberately does not claim (every instance must clear)',
  !/const onDragEnd = \(event\) => \{\s*\n\s*if \(!firstClaim\(event\)\)/.test(source))

console.log('\n[disposer]')

check('the drag bridge returns a detach function', /function installTreeDragBridge[\s\S]{0,120}?if \(typeof document === 'undefined'\) return \(\) => \{\}/.test(source))
check('the row menu returns a detach function', /function installTreeMenuBridge[\s\S]{0,120}?if \(typeof document === 'undefined'\) return \(\) => \{\}/.test(source))
check('the drag bridge removes every listener it added',
  (source.match(/document\.removeEventListener\('(dragstart|dragover|drop|dragend)'/g) ?? []).length === 4,
  `${(source.match(/document\.removeEventListener\('(dragstart|dragover|drop|dragend)'/g) ?? []).length} removal(s)`)
check('the row menu removes its listener',
  source.includes("document.removeEventListener('contextmenu', onContextMenu, true)"))
check('apply() returns the disposer', /return \(\) => \{\s*\n\s*clearTimeout\(transferActionsProbe\)\s*\n\s*detachBridges\(\)\s*\n\s*\}/.test(source))
check('apply() keeps the installed disposer', source.includes('const detachBridges = installComposerBridges(ctx)'))

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
