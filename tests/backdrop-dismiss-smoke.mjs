/**
 * Clicking outside a dialog must dismiss it; dragging out of it must not.
 *
 * The reported bug: while editing a remote workspace, dragging to select text in
 * a field and releasing the mouse over the backdrop closed the whole flow — the
 * selection was lost mid-gesture. The cause is that `click` is dispatched at the
 * nearest common ancestor of press and release, so a press INSIDE the dialog
 * followed by a release on the backdrop produces a click whose target is the
 * backdrop: `onClick: onClose` fires even though the interaction never started
 * outside.
 *
 * `backdropDismiss()` replaces that with "the press both started and ended on
 * the backdrop". These checks exercise the real helper against synthetic
 * pointer events (it is dependency-free on purpose) and then guard the wiring so
 * the old `onClick` form cannot come back.
 *
 * Run: node tests/backdrop-dismiss-smoke.mjs
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

console.log('\n=== backdrop dismiss smoke ===\n')

const source = readFileSync(path.join(pluginRoot, 'lib/client.js'), 'utf8')

/** Pull the helper out of the client source by brace matching. */
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

const backdropDismiss = new Function(`${extractFunction('backdropDismiss')}; return backdropDismiss`)()

/**
 * A fake backdrop element: `currentTarget` is the backdrop itself, `target` is
 * whatever the pointer was actually over. Only the fields the helper reads.
 */
function makeBackdrop () {
  const element = { __sshwspPressed: undefined }
  const props = backdropDismiss(() => { element.closes = (element.closes ?? 0) + 1 })
  element.down = (target, button = 0) => props.onPointerDown({ currentTarget: element, target, button })
  element.up = (target, button = 0) => props.onPointerUp({ currentTarget: element, target, button })
  return element
}

const inside = { name: 'dialog child' }

console.log('[dismiss: the intended outside click]')

{
  const backdrop = makeBackdrop()
  backdrop.down(backdrop)
  backdrop.up(backdrop)
  check('a press and release on the backdrop closes once', backdrop.closes === 1, `closes=${backdrop.closes}`)
}

{
  const backdrop = makeBackdrop()
  backdrop.down(backdrop)
  backdrop.up(backdrop)
  backdrop.up(backdrop)
  check('a second release without a fresh press does not close again', backdrop.closes === 1, `closes=${backdrop.closes}`)
}

console.log('\n[kept open: the reported bug]')

{
  const backdrop = makeBackdrop()
  // Drag a selection out of the dialog: the press is inside, the release lands
  // on the backdrop. Chromium still dispatches a click whose target is the
  // backdrop — the whole reason `onClick: onClose` was wrong.
  backdrop.down(inside)
  backdrop.up(backdrop)
  check('a press inside the dialog released on the backdrop does NOT close',
    backdrop.closes === undefined, `closes=${backdrop.closes}`)
}

{
  const backdrop = makeBackdrop()
  backdrop.down(backdrop)
  backdrop.up(inside)
  check('a press on the backdrop released inside the dialog does NOT close',
    backdrop.closes === undefined, `closes=${backdrop.closes}`)
}

{
  const backdrop = makeBackdrop()
  // Release outside the window: no pointerup reaches the document at all, so the
  // armed flag can only be cleared by the NEXT press — which must be recorded as
  // starting outside the backdrop even though it arrived as a bubbling event.
  backdrop.down(backdrop)
  backdrop.down(inside)
  backdrop.up(backdrop)
  check('an interrupted drag cannot make a later inside press dismiss',
    backdrop.closes === undefined, `closes=${backdrop.closes}`)
}

console.log('\n[buttons]')

{
  const backdrop = makeBackdrop()
  backdrop.down(backdrop, 2)
  backdrop.up(backdrop, 2)
  check('a secondary-button press never dismisses (the context menu owns it)',
    backdrop.closes === undefined, `closes=${backdrop.closes}`)
}

{
  const backdrop = makeBackdrop()
  backdrop.down(backdrop, 1)
  backdrop.up(backdrop, 1)
  check('a middle-button press never dismisses', backdrop.closes === undefined, `closes=${backdrop.closes}`)
}

{
  const backdrop = makeBackdrop()
  // Touch/pen: `button` is 0 on pointerdown but some engines report -1 on
  // pointerup, so only the press side may be gated.
  backdrop.down(backdrop, 0)
  backdrop.up(backdrop, -1)
  check('a touch release reported as button -1 still dismisses',
    backdrop.closes === 1, `closes=${backdrop.closes}`)
}

console.log('\n[per-element state]')

{
  const a = makeBackdrop()
  const b = makeBackdrop()
  a.down(a)
  b.down(inside)
  b.up(b)
  check('one backdrop\'s armed press does not leak into another', b.closes === undefined, `closes=${b.closes}`)
  a.up(a)
  check('the first backdrop still closes with its own press', a.closes === 1, `closes=${a.closes}`)
}

{
  const backdrop = makeBackdrop()
  check('the helper keeps its state on the element, not in a closure',
    'ready' in backdrop === false && backdrop.__sshwspPressed === undefined)
  backdrop.down(backdrop)
  check('the press is recorded on the host element', backdrop.__sshwspPressed === true)
  backdrop.up(inside)
  check('the flag is cleared on release', backdrop.__sshwspPressed === false)
}

console.log('\n[helper shape]')

const helper = extractFunction('backdropDismiss')
check('the helper does not use React hooks (it is called during render, not at the top of a component)',
  !/\bReact\.use[A-Z]/.test(helper))
check('the helper returns plain props rather than a component', /return \{[\s\S]*onPointerDown[\s\S]*onPointerUp[\s\S]*\}/.test(helper))
check('the helper has no `onClick` path left', !/onClick/.test(helper))
check('the helper is declared in the factory scope beside the components, not at module top level',
  /^ {4}function backdropDismiss \(close\) \{/m.test(source))

console.log('\n[wiring]')

const backdrops = [...source.matchAll(/className: 'sshwsp-backdrop'[^\n]*/g)].map(match => match[0])
check('all four dialog backdrops were found', backdrops.length === 4, `${backdrops.length} found`)
check('no backdrop still dismisses on a raw onClick',
  backdrops.every(line => !/onClick/.test(line)),
  backdrops.filter(line => /onClick/.test(line)).join(' | '))
check('every backdrop spreads backdropDismiss',
  backdrops.length === 4 && backdrops.every(line => line.includes('...backdropDismiss(')),
  backdrops.join(' | '))
check('the helper is wired at exactly four call sites',
  (source.match(/\.\.\.backdropDismiss\(/gu) ?? []).length === 4,
  `${(source.match(/\.\.\.backdropDismiss\(/gu) ?? []).length} call(s)`)

console.log('\n[wiring: each dialog keeps its own busy guard]')

/** The guard function a dialog passes in, so the gate can be checked per dialog. */
function guardOf (componentName) {
  const start = source.indexOf(`function ${componentName} (`)
  if (start < 0) throw new Error(`client.js does not define ${componentName}()`)
  const next = source.indexOf('\n    function ', start + 1)
  return source.slice(start, next < 0 ? source.length : next)
}

{
  const editor = guardOf('HostEditor')
  check('HostEditor refuses to be dismissed while a save is in flight',
    /const dismissBackdrop = \(\) => \{ if \(!saving\) onClose\(\) \}/.test(editor))
  check('HostEditor spreads that guarded callback',
    editor.includes('...backdropDismiss(dismissBackdrop)'))
}

{
  const browser = guardOf('DirectoryBrowser')
  check('DirectoryBrowser refuses to be dismissed mid-transfer',
    /const dismissBackdrop = \(\) => \{[\s\S]{0,160}?!mounting && !uploadBusy && transferBusy === undefined[\s\S]{0,40}?onClose\(\)/.test(browser))
  // The spread now goes through a second layer that clears an in-progress
  // SELECTION before closing, because closing on Escape there loses work that
  // has no undo. The transfer guard is still the last word: the wrapper has to
  // delegate to it, or Escape would close the dialog mid-transfer and hide the
  // only row reporting the outcome.
  check('DirectoryBrowser clears a selection before it closes',
    /const dismissOrClear = \(\) => \{[\s\S]{0,240}?if \(selectMode\)[\s\S]{0,200}?setSelected\(new Set\(\)\)[\s\S]{0,60}?return[\s\S]{0,40}?\}/.test(browser))
  check('...and the wrapper still delegates to the transfer guard',
    /const dismissOrClear = \(\) => \{[\s\S]{0,400}?dismissBackdrop\(\)/.test(browser))
  check('DirectoryBrowser spreads that guarded callback',
    browser.includes('...backdropDismiss(dismissOrClear)'))
}

{
  const dialog = guardOf('RemoteWorkspaceDialog')
  check('RemoteWorkspaceDialog keeps its create/owner guard',
    /const dismissBackdrop = \(\) => \{ if \(!creating && !busy\) onCancel\(\) \}/.test(dialog))
  check('RemoteWorkspaceDialog spreads that guarded callback',
    dialog.includes('...backdropDismiss(dismissBackdrop)'))
}

console.log('\n[the dialog body still stops propagation-free dismissal]')

// The panels must still stop their own clicks from reaching the backdrop,
// which is what makes click-to-dismiss safe. The assertion is on BEHAVIOUR
// rather than on the exact property order: the a11y wiring adds `role`/ref
// props between `className` and `onClick`, and matching that order would make a
// harmless insertion look like a regression.
{
  const panels = [...source.matchAll(/className: 'sshwsp-dialog[^']*'[\s\S]{0,400}?onClick: \((?:event|e)\) => (?:event|e)\.stopPropagation\(\)/gu)]
  check('every dialog panel still stops its own clicks (unchanged)',
    panels.length === 4, `${panels.length} panel(s)`)
}

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
