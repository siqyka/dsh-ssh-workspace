/**
 * The panel's service container must reach the directory browser.
 *
 * ## The bug this suite exists for
 *
 * `DirectoryBrowser` takes a `ctx` prop (the batch download asks the HOST's
 * folder chooser for a destination, via `pickDirTarget`). When that prop was
 * added, the render call site in `RemoteWorkspacePanel` started passing `ctx`
 * — but the panel's own signature still destructured only `{ t }`. Every
 * render of the panel was fine (the browser is rendered conditionally), so the
 * defect stayed invisible until someone clicked "浏览目录": the label resolves,
 * `browserAlias` becomes non-null, the JSX object literal evaluates `ctx`, the
 * identifier is not bound, and the ReferenceError takes down the whole slot.
 * The user sees a white page, not an error in the panel.
 *
 * ## Why not a grep
 *
 * A grep for `ctx` would have been green on the broken build too: the call site
 * already said `ctx`. What was missing was the BINDING, on a different line,
 * inside a function signature. So this suite evaluates the real shipped wiring
 * instead: the `main` slot registration is lifted out and driven with a fake
 * slot ledger, its injected props are fed to the real `RemoteWorkspacePage`,
 * and the page's element is inspected to prove the container arrived. The
 * panel's destructuring pattern is then executed against a props object — if
 * `ctx` is not bound there, that throws here, before a browser click can.
 *
 * ## What is deliberately not covered
 *
 * The panel body is not rendered: it fetches routes, mounts hosts and owns
 * timers. This suite stops at the boundary it is about — props in, element
 * out — and the real GUI was exercised separately.
 *
 * Run: node tests/panel-ctx-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== panel ctx smoke ===\n')

/**
 * A contiguous source region, located by two markers the file has to carry.
 *
 * A missing marker throws instead of slicing an empty string: a suite that
 * asserts on `''` passes exactly the checks whose whole point was that the
 * shipped code contains something.
 */
function sliceBetween (startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`client.js no longer marks ${label} (start)`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`client.js no longer marks ${label} (end)`)
  return source.slice(start, end + endMarker.length)
}

// ---- the real `main` slot registration, driven ------------------------------

const PANEL_ID = '@shiqyka/dsh-ssh-workspace'
const registrationSource = sliceBetween(
  "      slots.inject('main', () => slots.register({",
  '}, RemoteWorkspacePage))',
  'the main slot registration',
)

const registered = []
const slots = {
  inject (name, produce) {
    registered.push({ injected: name })
    return produce()
  },
  register (definition, component) {
    registered.push({ definition, component })
    return { definition, component }
  },
}
const translate = (key) => key
const pluginCtx = { get: () => ({ pickDirectory: async () => '/tmp' }) }

const PageStub = function RemoteWorkspacePageStub () { return null }
new Function('slots', 'translate', 'ctx', 'RemoteWorkspacePage', 'PANEL_ID', `${registrationSource};`)(slots, translate, pluginCtx, PageStub, PANEL_ID)

const registration = registered.find(entry => entry.definition !== undefined)
check('the main slot registration still exists', registration !== undefined, 'no slots.register call recorded')
check('it still registers the page component',
  registration?.component === PageStub,
  'the component handed to slots.register is not RemoteWorkspacePage')

const injected = typeof registration?.definition?.inject === 'function' ? registration.definition.inject() : undefined
check('the injected props carry the applied context',
  injected?.ctx === pluginCtx,
  'definition.inject() must return the apply-time ctx object itself')
check('the injected props still carry the translator',
  injected?.translate === translate,
  'the translator was dropped while adding ctx')

// ---- the page wrapper forwards both to the panel -----------------------------

const pageSource = sliceBetween(
  '    function RemoteWorkspacePage ({ translate, ctx }) {',
  '    // Remote-workspace marks',
  'the page wrapper',
)
// The slice ends on the marks banner; cut the banner back off.
const pageCode = pageSource.slice(0, pageSource.indexOf('    // =========================================================================\n    // Remote-workspace marks'))

const PanelStub = function RemoteWorkspacePanelStub () { return null }
const jsxTree = (type, props) => ({ type, props })
const page = new Function('jsx', 'RemoteWorkspacePanel', `${pageCode}; return RemoteWorkspacePage`)(jsxTree, PanelStub)
const pageElement = page({ translate, ctx: pluginCtx })
check('the page renders the panel',
  pageElement?.type === 'div' && pageElement?.props?.children?.type === PanelStub,
  'the page no longer wraps RemoteWorkspacePanel in its container div')
check('the page hands the container to the panel as ctx',
  pageElement?.props?.children?.props?.ctx === pluginCtx,
  'RemoteWorkspacePanel was rendered without the apply-time ctx')
check('the page hands the translator to the panel as t',
  pageElement?.props?.children?.props?.t === translate,
  'the translator was dropped on the way to the panel')

// ---- the panel signature actually binds ctx ---------------------------------

const signatureMatch = source.match(/function RemoteWorkspacePanel\s*\((.+?)\)\s*\{/u)
check('the panel still has a destructuring signature',
  signatureMatch !== null && signatureMatch[1].startsWith('{'),
  'RemoteWorkspacePanel no longer destructures its props')
/**
 * Bind one name through the panel's own destructuring pattern.
 *
 * Each name gets its own evaluation: sharing one meant a missing `ctx` threw
 * before `t` was read, so the report blamed both bindings for one defect.
 *
 * @param {string} name - identifier to read after destructuring.
 * @returns {unknown} the bound value, or undefined when the pattern lacks it.
 */
function bindFrom (name) {
  try {
    return new Function('props', `const ${signatureMatch[1]} = props; return ${name}`)({ t: translate, ctx: pluginCtx })
  } catch {
    return undefined
  }
}
const boundCtx = bindFrom('ctx')
const boundT = bindFrom('t')
check('the panel binds ctx from its props',
  boundCtx === pluginCtx,
  'the signature does not destructure ctx — the identifier used by the browser dialog is unbound')
check('the panel still binds the translator',
  boundT === translate,
  'the signature no longer destructures t')

// ---- the browser dialog receives that binding --------------------------------

const dialogMatch = source.match(/browserAlias !== null && jsx\(DirectoryBrowser, \{[\s\S]*?\n        \}\)/u)
check('the browser dialog render is still a conditional JSX call',
  dialogMatch !== null,
  'the browser dialog call could not be located')
const BrowserStub = function DirectoryBrowserStub () { return null }
let dialog
try {
  dialog = new Function(
    'browserAlias', 'jsx', 'DirectoryBrowser', 'setBrowserAlias', 'refresh', 'ctx', 't',
    `return (${dialogMatch[0]})`,
  )('host-alias', jsxTree, BrowserStub, () => {}, () => {}, pluginCtx, translate)
} catch (err) {
  dialog = undefined
}
check('the browser dialog is rendered with the container',
  dialog?.props?.ctx === pluginCtx,
  'DirectoryBrowser was rendered without ctx — its batch download would fall back to "unsupported"')
check('the dialog still receives the alias under the cursor',
  dialog?.props?.alias === 'host-alias',
  'the clicked alias no longer reaches the dialog')

// ---- and the defect that started this: nothing else in the panel asks for ctx

const panelBody = sliceBetween(
  '    function RemoteWorkspacePanel (',
  '    // =========================================================================\n    // Add-workspace flow',
  'the panel body',
)
const ctxUses = [...panelBody.matchAll(/\bctx\b/gu)].length
check('ctx is referenced exactly twice in the panel body (signature + dialog)',
  ctxUses === 2,
  `found ${ctxUses} references — a new one needs its own thread, and a stale one outlives its source`)

console.log(`\n=== ${passed} passed, ${failures.length} failed ===\n`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
