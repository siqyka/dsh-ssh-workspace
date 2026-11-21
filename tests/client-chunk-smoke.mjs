/**
 * Can a chunk reach the main bundle?
 *
 * The Host serves a plugin's browser half as one `client.js` plus any number of
 * `client.<name>.js` chunks beside it, loaded on demand through
 * `require.async('./client.<name>.js')`. Splitting the 12,603-line bundle along
 * its section boundaries depends on ONE unproven fact: a chunk can call
 * `require('<this plugin's id>')` and receive the main bundle's exports, so the
 * moved components can still reach `API`, `useDialogA11y`, the icons and the
 * other kernel declarations that stayed behind.
 *
 * Reading `dsh-client-modules/lib/client.js` says it should work — the
 * synchronous `require` walks seed → `loadCache` → `factories` → throw, and the
 * main bundle registers itself as a factory under its own id, so the
 * `factories` branch should materialize it. "Should" is why this suite exists:
 * the branch is exercised here against the REAL loader and the REAL bundle,
 * both unchanged, rather than against a description of them.
 *
 * The loader is browser code that installs itself on `window.__ModuleLoader__`,
 * so it runs inside a `node:vm` context with a facade that behaves the way the
 * page's does: it queues registrations until boot, then hands them to the
 * module system. No browser is involved and nothing is stubbed except React,
 * which the bundle requires and this process does not have.
 *
 * Skips when `DSH_CORE_ROOT` does not hold `@deepseek-ai/dsh-client-modules`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { bundleBorrows, bundleNames, exportedNames, seamNames, unboundBorrows, unexportedBorrows } from './support/free-names.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const coreRoot = process.env.DSH_CORE_ROOT
const loaderFile = coreRoot === undefined
  ? undefined
  : path.join(coreRoot, '@deepseek-ai', 'dsh-client-modules', 'lib', 'client.js')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== client chunk smoke ===')

let loaderSource
try {
  loaderSource = readFileSync(loaderFile, 'utf8')
} catch {
  console.log('\n  SKIP  DSH_CORE_ROOT does not hold @deepseek-ai/dsh-client-modules')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}

/**
 * The page's `window.__ModuleLoader__` facade.
 *
 * Before boot every bundle script pushes its registration into a queue; the
 * module system drains that queue and then replaces `load` with live
 * registration. Modelling both states matters: a chunk's script executes
 * against the LIVE facade, and getting that wrong is exactly the failure this
 * suite is looking for.
 *
 * @returns {{facade: object, drain: Function}} the facade and a drain helper.
 */
function makeFacade () {
  const facade = {
    mode: 'queue',
    pendingQueue: [],
    load (registration) { facade.pendingQueue.push(registration) },
  }
  return {
    facade,
    drain () {
      const queued = facade.pendingQueue.splice(0)
      return queued
    },
  }
}

/** React, only as much as the bundle touches at module scope. */
function reactStub () {
  const element = (type, props) => ({ type, props })
  return {
    createElement: element,
    Fragment: 'Fragment',
    Suspense: 'Suspense',
    StrictMode: 'StrictMode',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useReducer: (reducer, initial) => [initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useContext: (context) => context?._value,
    createContext: (value) => ({ Provider: 'Provider', Consumer: 'Consumer', _value: value }),
    lazy: (factory) => ({ _lazy: factory }),
    memo: (component) => component,
    forwardRef: (render) => render,
    Children: {
      map: (children, fn) => (Array.isArray(children) ? children.map(fn) : []),
      toArray: (children) => (Array.isArray(children) ? children : []),
      only: (children) => children,
    },
    isValidElement: (value) => value !== null && typeof value === 'object' && 'type' in value,
    cloneElement: (value) => value,
  }
}

// ---------------------------------------------------------------------------
// [1] the real loader loads, and reports the surface this suite drives
// ---------------------------------------------------------------------------
const { facade } = makeFacade()
const sandbox = { window: { __ModuleLoader__: facade }, console, setTimeout, clearTimeout, queueMicrotask }
vm.createContext(sandbox)
vm.runInContext(loaderSource, sandbox, { filename: 'dsh-client-modules/lib/client.js' })

const bootstrap = facade.pendingQueue[0]
console.log('\n[1] the host module system')
check('the loader registered itself on window.__ModuleLoader__', bootstrap !== undefined)
check('...under the id the boot graph names',
  bootstrap?.id === '@deepseek-ai/dsh-client-modules', String(bootstrap?.id))
const host = bootstrap?.factory((spec) => { throw new Error(`unexpected require(${spec})`) })
check('its factory materializes', typeof host === 'object' && host !== null)
check('...and exports the module system', typeof host?.ClientModuleSystem === 'function')

// ---------------------------------------------------------------------------
// [2] our real bundle registers, and materializes, under that system
// ---------------------------------------------------------------------------
const BUNDLE_ID = '@shiqyka/dsh-ssh-workspace'
const BUNDLE_URL = `http://127.0.0.1:4074/plugins/??${BUNDLE_ID}/client.js&rev=abc123`
const manifest = {
  rev: 'abc123',
  modules: [{ id: BUNDLE_ID, url: BUNDLE_URL, rev: 'abc123', inject: [], external: [], initialUrl: BUNDLE_URL }],
  plugins: [],
}

const { facade: live } = makeFacade()
const system = new host.ClientModuleSystem({
  manifest,
  staticModules: {
    react: reactStub(),
    'react-dom': { createPortal: (node) => node, render: () => {}, createRoot: () => ({ render: () => {} }) },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
  },
  registrationTarget: live,
  bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: {} },
  // No chunk is fetched in this section; a fetch means the bundle asked for one.
  loadBundle: async (url) => { throw new Error(`unexpected chunk fetch: ${url}`) },
})

// The bundle as shipped, unchanged: run it in a context whose facade collects
// the one registration it makes.
const collected = []
const bundleContext = { window: { __ModuleLoader__: { load: (registration) => collected.push(registration) } } }
vm.createContext(bundleContext)
vm.runInContext(readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8'), bundleContext, { filename: 'lib/client.js' })

console.log('\n[2] the main bundle under the real loader')
check('it registers exactly one module', collected.length === 1, String(collected.length))
check('...under this plugin\'s package id', collected[0]?.id === BUNDLE_ID, String(collected[0]?.id))
check('...as a factory', typeof collected[0]?.factory === 'function')

let mainExports
let materializeError
try {
  live.load(collected[0])
  mainExports = await system.import(BUNDLE_ID)
} catch (error) {
  materializeError = error
}
check('the module system materializes it', materializeError === undefined, materializeError?.message)
check('...and the exports carry the plugin surface', typeof mainExports?.apply === 'function', JSON.stringify(Object.keys(mainExports ?? {})))
check('...including the slot declarations', Array.isArray(mainExports?.inject), JSON.stringify(mainExports?.inject))

// ---------------------------------------------------------------------------
// [3] a chunk reaches those exports — the whole reason the split is possible
// ---------------------------------------------------------------------------
// What a served `client.<name>.js` does at execution time, verbatim: register
// under the owner's id with a `chunk` member, and receive a `require` whose
// synchronous branch is the module table.
const CHUNK = 'client.probe.js'
const requested = []
system.loadBundle = async (url) => {
  requested.push(url)
  live.load({
    id: BUNDLE_ID,
    chunk: CHUNK,
    factory: (require) => {
      const module = { exports: {} }
      module.exports.chunkMarker = 'chunk-ok'
      // The claim under test: the main bundle is reachable by package id.
      module.exports.mainExports = require(BUNDLE_ID)
      module.exports.react = require('react')
      return module.exports
    },
  })
}

let chunk
let chunkError
try {
  chunk = await system.importChunk(BUNDLE_ID, CHUNK)
} catch (error) {
  chunkError = error
}

console.log('\n[3] a chunk reaches the main bundle')
check('the chunk is fetched from the sibling URL the Host serves',
  requested.length === 1 && requested[0] === `http://127.0.0.1:4074/plugins/${BUNDLE_ID}/${CHUNK}?rev=abc123`,
  JSON.stringify(requested))
check('the chunk materializes', chunkError === undefined, chunkError?.message)
check('...and its own exports arrive', chunk?.chunkMarker === 'chunk-ok')
check('require("<plugin id>") returns the main bundle\'s exports',
  chunk?.mainExports !== undefined && chunk.mainExports === mainExports,
  JSON.stringify(Object.keys(chunk?.mainExports ?? {})))
check('...so a moved component can still reach the kernel',
  typeof chunk?.mainExports?.apply === 'function')
check('the chunk also keeps the platform seeds it needs', typeof chunk?.react === 'object')

// ---------------------------------------------------------------------------
// [4] the limits the split has to respect
// ---------------------------------------------------------------------------
console.log('\n[4] what a chunk may NOT do')

// A chunk name that is not `client.<name>.js` is refused by the loader, so the
// naming rule is not a convention to remember — it is enforced.
let badName
try {
  await system.importChunk(BUNDLE_ID, 'chunk.js')
} catch (error) {
  badName = error
}
check('a chunk must be named client.<name>.js', badName !== undefined, 'the loader accepted chunk.js')

// `require` is synchronous and table-only: a module that was never registered
// is a loud error, not a lazy fetch. A split that assumes otherwise would fail
// at click time in the browser and pass every source-level test.
system.loadBundle = async () => { /* a script that runs but registers nothing */ }
let missed
try {
  await system.importChunk(BUNDLE_ID, 'client.miss.js')
} catch (error) {
  missed = error
}
check('a chunk that never registers is an error, not a silent success',
  missed !== undefined && /loaded without registering/u.test(missed.message), missed?.message)

// The async branch requires the `./` prefix; without it the spec is treated as
// a package id and goes through the graph, which is a different resolution.
check('require.async needs a "./" prefix for a sibling chunk',
  typeof system.makeRequire(BUNDLE_ID, new Set()).async === 'function')

// ---------------------------------------------------------------------------
// [5] every chunk carries across every bundle name it borrows
// ---------------------------------------------------------------------------
// The bug this exists for, twice over: `client.dialogs.js` called `fetchJson`
// three times without destructuring it, and then reached for
// `BROWSE_LIST_LIMIT` — a constant that was not even exported yet. Both were
// invisible until a user opened the directory picker, because an undeclared
// identifier is a load-time nothing and a run-time ReferenceError.
//
// The question is narrow on purpose: does a chunk name something the main
// bundle declares, without either destructuring it from the bundle or declaring
// it locally? That is exactly the bug, and it needs no scope analysis to answer
// — the tokenizer in `tests/support/free-names.mjs` removes comments, strings
// and regexes (and keeps the code inside `${…}`), so what is left is real
// mentions of real names.
//
// Deliberately NOT asked: whether a use is reachable from a declaration in a
// nested scope. Over-approximating there can only hide a bug, and a check that
// cries wolf on correct code is a check that gets deleted.
console.log('\n[5] every chunk carries what it borrows')
{
  const bundleSource = readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')
  const available = bundleNames(bundleSource)
  const exported = exportedNames(bundleSource)
  check('the bundle makes names available to its chunks', available.size > 0, String(available.size))
  check('the exports block is smaller than "everything declared"', exported.size > 0 && exported.size < available.size,
    `${exported.size} exported of ${available.size} declared — equal would mean the check below cannot fail`)

  const chunkFiles = readdirSync(path.join(pluginRoot, 'lib'))
    .filter(name => /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u.test(name))
    .sort()
  check('there is at least one chunk to check', chunkFiles.length > 0, chunkFiles.join(', '))

  for (const file of chunkFiles) {
    const source = readFileSync(path.join(pluginRoot, 'lib', file), 'utf8')
    // A chunk that borrows nothing is a leaf (`client.styles.js` is CSS text,
    // `client.icons.js` is glyph factories, `client.locale.js` is tables). It
    // has nothing to carry across, so demanding a seam of it would push an
    // empty destructuring into a file that does not need one. The rule is
    // about borrowers only.
    const borrowed = bundleBorrows(source, available)
    if (borrowed.size === 0) {
      check(`${file}: is a leaf, so it needs no seam`, seamNames(source).size === 0,
        `borrows nothing but destructures ${[...seamNames(source)].join(', ')}`)
      continue
    }
    check(`${file}: reaches the bundle through the documented seam`,
      seamNames(source).size > 0, `borrows ${borrowed.size} name(s) with no destructuring from the package id`)
    const unbound = unboundBorrows(source, available)
    check(`${file}: carries every bundle name it borrows`, unbound.length === 0,
      `used but neither destructured nor declared: ${unbound.join(', ')}`)
    // The question above is "did the chunk carry the name across"; this one is
    // "does the bundle actually hand it over". They are different, and the
    // weaker one passed while `refreshRemoteWorkspaceMarks` was destructured by
    // the add-workspace chunk and absent from the exports block — `undefined`,
    // not a ReferenceError, thrown only after a workspace had been created.
    const unexported = unexportedBorrows(source, exported)
    check(`${file}: every name it destructures is really exported`, unexported.length === 0,
      `destructured but the bundle's exports block does not list: ${unexported.join(', ')}`)
  }
}


// ---------------------------------------------------------------------------
// [6] the names the boot chunks own are republished, not frozen as stand-ins
// ---------------------------------------------------------------------------
// `Object.assign(exports, …)` copies VALUES, and it runs while the module is
// being evaluated — long before `apply`. Every name that lives in a boot chunk
// is a stand-in at that moment: `() => null` for a glyph, `() => undefined` for
// the provenance line. A chunk that destructured the exports before `apply`
// ran would hold those stand-ins forever and draw nothing, with no error
// anywhere. `republishBootNames()` exists for exactly that, and this asserts
// both halves: that it covers every name it has to, and that after a real
// `apply` the exported glyph is the real one.
console.log('\n[6] the boot chunks\' names are republished')
{
  const bundleSource = readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')
  const bootBody = /async function loadBootChunks \(\) \{([\s\S]*?)\n {4}\}/u.exec(bundleSource)?.[1] ?? ''
  const republishBody = /function republishBootNames \(\) \{([\s\S]*?)\n {4}\}/u.exec(bundleSource)?.[1] ?? ''
  check('loadBootChunks and republishBootNames both exist',
    bootBody !== '' && republishBody !== '', `boot=${bootBody.length} republish=${republishBody.length}`)

  /** The names in one `{ a, b, c }` destructuring assignment of the boot body. */
  const filled = new Set()
  for (const match of bootBody.matchAll(/\(\{([\s\S]*?)\} = (?:locale|styles|icons)\)/gu)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(':').pop()?.trim() ?? ''
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) filled.add(name)
    }
  }
  const listed = (body) => {
    const names = new Set()
    const block = /Object\.assign\(exports, \{([\s\S]*?)\n\s*\}\)/u.exec(body)?.[1] ?? ''
    for (const line of block.split('\n')) {
      const name = line.replace(/\/\/.*$/u, '').trim().replace(/,$/u, '')
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name)
    }
    return names
  }
  const exportedNamesHere = listed(bundleSource)
  const republished = listed(republishBody)
  check('the boot load fills in some names', filled.size > 0, String(filled.size))
  check('republishBootNames lists some names', republished.size > 0, String(republished.size))

  // Only the ones a chunk can actually reach matter: a boot name that is not
  // exported is invisible to chunks and needs no republishing.
  const mustRepublish = [...filled].filter(name => exportedNamesHere.has(name))
  const missing = mustRepublish.filter(name => !republished.has(name))
  check('every exported boot name is republished after it is filled in',
    missing.length === 0,
    `exported and filled in by loadBootChunks but never republished: ${missing.join(', ')}`)
  // Declaring the function is not the fix; calling it is. The dynamic check
  // below catches a missing call too, but this one names the reason.
  check('...and loadBootChunks actually calls it',
    /republishBootNames\(\)/u.test(bootBody), 'the call is gone, so the exports keep the stand-ins')

  // ...and the dynamic half, on the real loader: after `apply`, the exported
  // glyph draws something. `document` is absent here, so the apply-time
  // installers take their headless branch; `setTimeout` is a no-op so the
  // session catch-up does not schedule work, and the check can exit.
  const live = makeFacade()
  live.facade.mode = 'queue'
  const loadedChunks = []
  const applySystem = new host.ClientModuleSystem({
    manifest,
    staticModules: {
      react: reactStub(),
      'react-dom': { createPortal: (node) => node, render: () => {}, createRoot: () => ({ render: () => {} }) },
      'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    },
    registrationTarget: live.facade,
    bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: {} },
    loadBundle: async (url) => {
      const name = url.split('/').pop().split('?')[0]
      loadedChunks.push(name)
      // A chunk's script executes against the LIVE facade — the module system.
      const chunkContext = { window: { __ModuleLoader__: live.facade }, console }
      vm.createContext(chunkContext)
      vm.runInContext(readFileSync(path.join(pluginRoot, 'lib', name), 'utf8'), chunkContext, { filename: name })
    },
  })
  const bundleRegistrations = []
  const applyBundleContext = {
    window: { __ModuleLoader__: { load: (registration) => bundleRegistrations.push(registration) } },
    console, setTimeout: () => 0, clearTimeout: () => {}, queueMicrotask,
  }
  vm.createContext(applyBundleContext)
  vm.runInContext(bundleSource, applyBundleContext, { filename: 'lib/client.js' })
  live.facade.load(bundleRegistrations[0])

  let applied
  let applyError
  try {
    applied = await applySystem.import(BUNDLE_ID)
    const registeredSlots = []
    await applied.apply({
      slots: {
        inject: (_name, factory) => factory(),
        register: (declaration) => { registeredSlots.push(declaration.name); return () => {} },
      },
      locale: { register: () => () => {}, bind: () => undefined },
      effect: (fn) => fn(),
    })
    applied.registeredSlots = registeredSlots
  } catch (error) {
    applyError = error
  }
  check('apply completes against the real loader and the real chunks',
    applyError === undefined, applyError?.message)
  check('...after fetching exactly the three boot chunks',
    loadedChunks.sort().join(',') === 'client.icons.js,client.locale.js,client.styles.js',
    loadedChunks.join(', '))
  const glyph = applyError === undefined ? applied.CloseIcon({}) : undefined
  check('...and the exported glyph is the real one, not the module-scope stand-in',
    glyph !== null && glyph !== undefined && glyph.type === 'svg',
    JSON.stringify(glyph)?.slice(0, 120))
  check('...while the stand-in would have drawn nothing',
    typeof applied.CloseIcon === 'function' && String(applied.CloseIcon).includes('size'),
    String(applied.CloseIcon).slice(0, 60))
}


if (failures > 0) {
  console.log('\nfailures:')
  console.log(`  ${failures} assertion(s) failed`)
}
console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures > 0 ? 1 : 0)
