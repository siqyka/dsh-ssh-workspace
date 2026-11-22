/**
 * The file editor's browser half, asserted at the source level plus the pure
 * helpers driven for real.
 *
 * Two kinds of claim live here and they are deliberately kept apart:
 *
 *  - SHAPE: "the dialog is portalled", "the body is the only scroll port",
 *    "there is no second Escape handler". These are properties of how the code
 *    is written, and no amount of driving a component would prove them.
 *  - BEHAVIOUR: `lineCount`, `gutterNumbers`, `isDirty`, `refusalKey`,
 *    `expectedTokens`. These are pure functions, so they are imported and
 *    called rather than pattern-matched.
 *
 * The chunk is loaded the way the Host loads it: `window.__ModuleLoader__.load`
 * is a stub that captures the factory, the factory is run with a `require` that
 * returns this plugin's exports, and the resulting module is inspected. That is
 * the same seam `client-chunk-smoke` uses, so a chunk that cannot load fails
 * here too.
 *
 * Run: node tests/file-editor-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { clientSource, clientChunkNames } from './support/client-source.mjs'
import { routeModuleSource } from './support/route-source.mjs'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== file editor smoke ===\n')

const chunks = clientChunkNames(pluginRoot)
const client = clientSource(pluginRoot)
const editorPath = path.join(pluginRoot, 'lib', 'client', 'client.editor.js')
const editor = readFileSync(editorPath, 'utf8').replace(/\r\n/gu, '\n')
const styles = readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.styles.js'), 'utf8').replace(/\r\n/gu, '\n')
const textRoutes = routeModuleSource(pluginRoot, 'text')

// ---------------------------------------------------------------------------
// [1] The chunk exists and is reachable
// ---------------------------------------------------------------------------
{
  check('the editor lives in its own chunk', chunks.includes('client.editor.js'), chunks.join(','))
  check('the bundle loads it lazily, not at boot',
    client.includes("require.async('./client.editor.js')") &&
      !/loadBootChunks[\s\S]{0,4000}client\.editor\.js/u.test(client))
  check('a chunk that fails to arrive costs the button, not the panel',
    /const FileEditAction = React\.lazy\(async \(\) => \{[\s\S]{0,200}client\.editor\.js/u.test(client))
}

// ---------------------------------------------------------------------------
// [2] The registration (task 11)
// ---------------------------------------------------------------------------
{
  check('the button registers in the document preview action slot',
    client.includes("slots.inject('sidebar.right.tab.document.actions'") &&
      client.includes("name: 'sidebar.right.tab.document.actions'"))
  check('...under a plugin-scoped id', client.includes('id: `${PANEL_ID}-edit`'))
  check('...and hands the component its translate function and the ctx',
    /id: `\$\{PANEL_ID\}-edit`,\s*\n\s*inject: \(\) => \(\{ t: translate, ctx \}\),/u.test(client))
  check('the action slot is a DIFFERENT slot from the files-panel one',
    client.includes("slots.inject('sidebar.right.tab.files.actions'") &&
      client.includes("slots.inject('sidebar.right.tab.document.actions'"))
}

// ---------------------------------------------------------------------------
// [2b] A lazy occupant needs its own Suspense boundary
//
// The Host's slot renderer wraps each occupant in an ERROR boundary and nothing
// else — there is no Suspense anywhere above it. A `React.lazy` component
// registered straight into a slot therefore suspends with nothing to catch it,
// and React paints that subtree as EMPTY: no error, no console warning, no
// failing assertion, just a control that is never there. That is exactly how
// this button first shipped, so the wrapper is pinned rather than assumed.
// ---------------------------------------------------------------------------
{
  const occupant = /id: `\$\{PANEL_ID\}-edit`,[\s\S]{0,200}?\}, (\w+)\)\)/u.exec(client)
  check('the registered occupant is a wrapper, not the lazy component itself',
    occupant !== null && occupant[1] === 'FileEditActionSlot', occupant?.[1])
  check('...and the wrapper renders it behind Suspense',
    /function FileEditActionSlot \(props\) \{\s*\n\s*return jsx\(React\.Suspense, \{ fallback: null, children: jsx\(FileEditAction, props\) \}\)/u.test(client))
  // The general rule, so the next lazy occupant cannot repeat the mistake: any
  // `React.lazy` that reaches a slot must be inside a component that renders
  // `React.Suspense`. Asserted by name — every slot occupant registered in this
  // file that is declared as a lazy must appear in a Suspense-bearing wrapper.
  const lazyNames = [...client.matchAll(/const (\w+) = React\.lazy\(/gu)].map(match => match[1])
  check('the file declares some lazy components', lazyNames.length >= 4, lazyNames.join(','))
  const registeredRaw = lazyNames.filter((name) =>
    new RegExp(`\\}, ${name}\\)\\)`, 'u').test(client))
  check('no lazy component is registered into a slot without a Suspense wrapper',
    registeredRaw.length === 0, registeredRaw.join(','))
}

// ---------------------------------------------------------------------------
// [2c] The Session comes from the slot, not from the composer
//
// The slot is `scope: 'session'`, so the Host renders it inside the Session
// that owns the preview and hands every occupant `sessionId` (ui-session's
// BUILTIN_SOURCE declares that prop). Reading the composer's session instead
// asks the probe about a session that may not be able to see the file at all,
// and the server answers "could not identify the session that owns this
// workspace" — a refusal the user cannot act on, for a file they are looking at.
// ---------------------------------------------------------------------------
{
  check('the editor reads the session the slot handed it',
    editor.includes("const scoped = typeof props?.sessionId === 'string' ? props.sessionId : ''") &&
      editor.includes("if (scoped !== '') return scoped"))
  check('...and only falls back to the composer when the slot gave none',
    editor.indexOf("if (scoped !== '') return scoped") <
      editor.indexOf("ctx?.get?.('uiSession')?.adapter?.current"))
  check('the fallback is inside the same memo, so a new scoped session re-probes',
    editor.includes('}, [ctx, absolutePath, props?.sessionId])'))
}

// ---------------------------------------------------------------------------
// [3] The editor covers the preview body IN PLACE, not the screen (12, 13)
//
// The request was "click edit and edit right there in the file area". A modal
// takes the file off screen and hands every dismissal the power to discard the
// work, so the editor is a fixed box over the preview's own measured rect
// instead. These assertions pin that shape — and, just as importantly, pin the
// ABSENCE of the modal machinery, so a later "just make it a dialog" change
// cannot quietly reintroduce it.
// ---------------------------------------------------------------------------
{
  // "Not a modal" is about BEHAVIOUR, not about where the node goes. The panel
  // does portal to `document.body` — a transformed or scrolling ancestor would
  // otherwise rebase or clip a fixed-position box — but a portal is not a
  // modal: there is no backdrop to click, no focus trap, and no document-level
  // Escape. So the assertion is on the modal machinery, which must stay absent.
  check('the editor is not a modal', !/sshwsp-backdrop/u.test(editor))
  // Own class, not borrowed ones. A panel that quietly kept `sshwsp-dialog-fill`
  // would pick up the modal's `height: min(88vh, 760px)` and grow past the box
  // it was told to cover — so the absence of the dialog classes is load-bearing,
  // not cosmetic.
  check('...and it carries its own panel class, not the dialog fill',
    editor.includes("className: 'sshwsp-editor-panel'") &&
      !/sshwsp-dialog(-fill)?[\s']/u.test(editor))
  // The contract it no longer borrows. Testing the DESTRUCTURE rather than a
  // bare `includes` on the whole file: the comments deliberately name the old
  // helpers to explain why they went, and a substring test would then forbid
  // ever documenting the change.
  check('...and does not borrow the modal contract',
    !/\bbackdropDismiss,/u.test(editor) && !/\buseDialogA11y,/u.test(editor))
  // The portal IS wanted, for the two ancestor failure modes named in the
  // chunk. Pinned separately so "not a modal" cannot be over-read into
  // "portals nowhere" by a later edit.
  check('...but does portal, so no ancestor can rebase or clip it',
    /return modalLayer\(jsxs\('div', \{/u.test(editor) && /\bmodalLayer,/u.test(editor))
  check('...but still borrows what it does use',
    editor.includes('API,') && editor.includes('requestJson,') && editor.includes('formatBytes,'))
  check('the panel is fixed and placed from the measured box',
    /\.sshwsp-editor-panel \{[^}]*position: fixed/u.test(styles) &&
      editor.includes('left: `${rect.left + offset.x}px`') &&
      editor.includes('top: `${rect.top + offset.y}px`') &&
      editor.includes('width: `${rect.width}px`') &&
      editor.includes('height: `${rect.height}px`'))
  // `position: fixed` is only viewport-relative while no ancestor establishes a
  // containing block, and the Host does put `will-change: transform` on its
  // composer. The first attempt at handling that reasoned about WHICH element
  // was the containing block and got it wrong — `offsetParent` is the nearest
  // positioned ancestor, not the fixed-position containing block — so the
  // editor was placed relative to the sidebar and landed over the conversation.
  //
  // The fix is not a better guess: render, measure where the panel actually
  // landed, and correct by the difference. These assertions pin the measurement
  // (and pin that the guess is gone, so it cannot come back).
  check('the offset is measured after render, not inferred from the ancestor chain',
    editor.includes('const actual = node.getBoundingClientRect()') &&
      // The CODE must not walk `offsetParent`; the comment is free to name it
      // while explaining why that approach was wrong.
      !/host\.offsetParent/u.test(editor) && !editor.includes('const block = host.offsetParent'))
  check('...and the correction is accumulated, so a re-measure cannot oscillate',
    editor.includes('const nextX = wantLeft - actual.left + current.x') &&
      editor.includes('const nextY = wantTop - actual.top + current.y'))
  check('...tolerating sub-pixel drift instead of re-rendering on it',
    editor.includes('Math.abs(a - b) < 0.5'))
  check('the box it covers is the preview BODY, not the whole preview',
    editor.includes("root.querySelector('[data-textpreview-body]')"))
  check('...found through the documented data attributes, not a hashed class',
    editor.includes("[data-textpreview-url]") && editor.includes("[data-textpreview-state]") &&
      !/closest\('\./u.test(editor))
  check('the box is re-measured on resize and on any ancestor scroll',
    editor.includes("window.addEventListener('resize', schedule)") &&
      editor.includes("window.addEventListener('scroll', schedule, true)"))
  check('...coalesced to one measure per frame, not one per scroll event',
    editor.includes('requestAnimationFrame') && editor.includes('if (frame !== 0) return'))
  check('the head and the foot are fixed', /\.sshwsp-editor-head \{[^}]*flex: 0 0 auto/u.test(styles) &&
    /\.sshwsp-editor-foot \{[^}]*flex: 0 0 auto/u.test(styles))
  check('the textarea is the only scrolling element', /\.sshwsp-editor-area \{[^}]*overflow: auto/u.test(styles))
  check('...and it can actually shrink, or it would push the panel open',
    /\.sshwsp-editor-area \{[^}]*min-height: 0/u.test(styles))
  check('the gutter does NOT scroll on its own', /\.sshwsp-editor-gutter \{[^}]*overflow: hidden/u.test(styles))
  check('the gutter is driven by the textarea scroll', editor.includes('gutter.scrollTop = area.scrollTop'))
  check('the panel itself never grows past the box it was given',
    /\.sshwsp-editor-panel \{[^}]*overflow: hidden/u.test(styles) &&
      /\.sshwsp-editor-panel \{[^}]*box-sizing: border-box/u.test(styles))
}

// ---------------------------------------------------------------------------
// [4] Keys: Tab, Shift+Tab, Ctrl+S, and an Escape scoped to the panel (14, 16-18)
// ---------------------------------------------------------------------------
{
  check('Tab is intercepted in the textarea', editor.includes("if (event.key !== 'Tab') return") &&
    editor.includes('event.preventDefault()'))
  check('...and inserts through execCommand, so undo keeps working',
    editor.includes("document.execCommand('insertText', false, text)"))
  check('...reading the value back from the DOM instead of composing it',
    editor.includes('element.value') && !/setState\([^)]*text: `\$\{.*\}  `/u.test(editor))
  check('Shift+Tab un-indents', editor.includes('event.shiftKey') && editor.includes("document.execCommand('delete')"))
  check('Ctrl/Cmd+S saves and stops the browser save dialog',
    /\(event\.ctrlKey \|\| event\.metaKey\) && !event\.altKey && \(event\.key === 's' \|\| event\.key === 'S'\)/u.test(editor) &&
      /preventDefault\(\)\s*\n\s*void save\(\)/u.test(editor))
  // Escape CLOSES, and it is handled on the panel's own keydown — not on
  // `document`. The reversal is deliberate: a global capture-phase listener is
  // right for a modal (it owns the screen) and wrong for an inline editor,
  // which must not swallow Escape while the composer or a stacked dialog has
  // focus. The old modal assertions said "no Escape handler at all"; that rule
  // died with the modal, so this one replaces it rather than deleting it.
  check('Escape closes the panel', /event\.key === 'Escape'[\s\S]{0,200}?close\(\)/u.test(editor))
  check('...scoped to the panel, with no document-level listener',
    !/document\.addEventListener\('keydown'/u.test(editor) &&
      !editor.includes('useDialogA11y({'))
  check('a save in flight blocks the close', /if \(busy\) return/u.test(editor))
  check('closing with unsaved text asks first', editor.includes('window.confirm(t(\'edit.unsavedPrompt\'))'))
}

// ---------------------------------------------------------------------------
// [5] Conflict handling (14, and the "no force" rule) (15)
// ---------------------------------------------------------------------------
{
  check('a 409 is recognised as a state, not an error', editor.includes('if (reply.status === 409)'))
  check('...and carries the tokens that won', editor.includes('reply.data?.current?.version'))
  // Both must be present before their ORDER means anything: `indexOf` returns
  // -1 for a missing marker, and -1 is less than any real offset, so a deleted
  // reload button would keep "reload comes first" passing.
  const reloadAt = editor.indexOf("t('edit.conflictReload')")
  const overwriteAt = editor.indexOf("t('edit.conflictOverwrite')")
  check('both conflict actions are still offered', reloadAt >= 0 && overwriteAt >= 0, `reload ${reloadAt}, overwrite ${overwriteAt}`)
  check('reload is offered BEFORE overwrite', reloadAt < overwriteAt)
  check('overwrite asks once more before doing it', editor.includes('setConfirmOverwrite(true)') &&
    editor.includes("t('edit.conflictConfirm')"))
  check('overwrite RE-READS the tokens instead of skipping the check',
    editor.includes('if (overwrite) {') && editor.includes('const fresh = await requestJson('))
  check('the save always sends expected tokens', editor.includes('expected: tokens'))
  check('...built by one helper, so the two fields cannot be swapped',
    editor.includes('function expectedTokens (base)') && editor.includes('return { version: base.version, revision: base.revision }'))
  check('nothing in the client or the route family can bypass the check',
    !/\bforce\b\s*:/u.test(editor) && !/skipExpected/u.test(editor) && !/skipExpected/u.test(textRoutes) &&
      !/body\?\.force/u.test(textRoutes))
  // A token that moved while the bytes did not is not a conflict. The refusal
  // carries the digest of what is on disk now, so a save may adopt it — but only
  // after comparing, and only once.
  check('a refused save compares the digest before calling it a conflict',
    editor.includes('movedTokenOnly(current, tokens.revision)'))
  check('...and retries exactly once against the newer token',
    editor.includes('if (reply.status !== 409 || attempt > 1) break'))
  // Adopting the token is the whole point of the retry: comparing the digests
  // and then saving against the STALE token would be refused again, so the user
  // would get a conflict dialog anyway and the comparison would have bought
  // nothing. Asserted as an assignment, not as a call — `void expectedTokens(…)`
  // still mentions the helper.
  const adoptAt = editor.indexOf('if (!movedTokenOnly(current, tokens.revision)) break')
  const assignAt = editor.indexOf('tokens = expectedTokens({', adoptAt)
  const conflictAt = editor.indexOf('if (reply.status === 409) {', adoptAt)
  check('...and adopts the token it was just shown',
    adoptAt >= 0 && assignAt > adoptAt && (conflictAt === -1 || assignAt < conflictAt),
    `retry ${adoptAt}, assign ${assignAt}, conflict ${conflictAt}`)
  check('the retry still sends the expected tokens, never a bypass',
    /expected: tokens,/u.test(editor) && !/\bforce\b\s*:/u.test(editor))
}

// ---------------------------------------------------------------------------
// [6] Encoding, BOM, and the refusal copy (19, 20)
// ---------------------------------------------------------------------------
{
  check('the read route reports a BOM rather than dropping it',
    textRoutes.includes('hasBom(raw)') && /^\s+bom,$/mu.test(textRoutes))
  check('the save sends the BOM flag back', editor.includes('bom: state.bom'))
  check('...and the line-ending policy is the server\'s, not the browser\'s',
    editor.includes("eol: 'auto'") && !/\\r\\n/u.test(editor))
  check('every refusal reason maps to its own copy key',
    ["'read-only'", "'binary'", "'not-utf8'", "'too-large'", "'not-file'"].every((reason) => editor.includes(`reason === ${reason}`)))
  check('the refusals are worded for all five reasons', ['edit.readOnly', 'edit.binary', 'edit.notUtf8', 'edit.tooLarge', 'edit.notFile']
    .every((key) => editor.includes(`return '${key}'`)))
  check('the refusal is visible as a title rather than a silent absence',
    editor.includes('const title = ready ? t(\'edit.actionHint\') :'))
  check('a truncated file cannot be saved', editor.includes('if (state.truncated) return') &&
    editor.includes('disabled: saving || state.phase !== \'ready\' || state.truncated'))
}

// ---------------------------------------------------------------------------
// [7] Saving does not eat what was typed while it ran
// ---------------------------------------------------------------------------
{
  check('the baseline advances without replacing the buffer',
    editor.includes('baseText: sent') && !/setState\([^)]*text: reply\.data/u.test(editor))
  check('...so a keystroke during a save survives', editor.includes('const sent = state.text'))
}

// ---------------------------------------------------------------------------
// [7b] A page unload that would discard the draft is guarded (defect 5)
// ---------------------------------------------------------------------------
{
  // The close button asks, but a refresh or a tab close never reaches it. This
  // is the only hook the page gets for those.
  check('a beforeunload guard is registered', editor.includes("addEventListener('beforeunload'"))
  check('...bound to dirty, so a saved buffer does not block a refresh',
    /if \(dirty !== true\) return undefined/u.test(editor) && /\}, \[dirty\]\)/u.test(editor))
  check('...and unbound on unmount, so a closed editor leaves nothing behind',
    editor.includes("removeEventListener('beforeunload'"))
  // Browsers disagree about which of the two is honoured; neither is a message,
  // so no text is put in either. Scoped to the handler body on purpose: other
  // `preventDefault()` calls in this file (Tab, Ctrl+S, Escape) would otherwise
  // keep the assertion green with the guard's own calls deleted.
  const guardStart = editor.indexOf('const guard = (event) => {')
  const guardEnd = editor.indexOf('window.addEventListener', guardStart)
  const guardBody = guardStart >= 0 && guardEnd > guardStart ? editor.slice(guardStart, guardEnd) : ''
  check('the guard body was located', guardBody !== '', `start ${guardStart}, end ${guardEnd}`)
  check('both the modern and the legacy suppression are set',
    guardBody.includes('event.preventDefault()') && guardBody.includes('event.returnValue'))
  check('...and no message text is written (no browser shows it)',
    !/returnValue\s*=\s*['"][^'"]+['"]/u.test(guardBody))
  check('the guard does not add a second Escape handler',
    (editor.match(/key === 'Escape'/gu) ?? []).length === 1)
}

// ---------------------------------------------------------------------------
// [8] The pure helpers, driven
// ---------------------------------------------------------------------------
{
  // Load the chunk the way the Host does: capture the factory, run it against
  // this plugin's exports.
  const saved = globalThis.window
  let factory
  globalThis.window = {
    __ModuleLoader__: {
      load (spec) { factory = spec.factory },
    },
  }
  let loaded
  try {
    // eslint-disable-next-line no-new-func
    const run = new Function('window', 'require', 'module', 'exports', readFileSync(editorPath, 'utf8'))
    const shim = { exports: {} }
    run(globalThis.window, () => ({}), shim, shim.exports)
    // The factory takes the chunk's `require`, not a module object: the Host
    // calls it with the loader's own function, and a chunk's first line is
    // `require('react')`.
    loaded = factory((name) => ({
      react: {},
      'react/jsx-runtime': {},
    })[name] ?? {
      API: {},
      CloseIcon: () => null,
      formatBytes: () => '',
      requestJson: async () => ({ ok: true, status: 200, data: {} }),
    })
  } finally {
    globalThis.window = saved
  }

  check('the chunk exports the action and the panel',
    typeof loaded.FileEditAction === 'function' && typeof loaded.FileEditorPanel === 'function')
  check('...and the dialog it replaced is gone, not merely unused',
    loaded.FileEditorDialog === undefined && !editor.includes('FileEditorDialog'))
  check('...plus the box resolver a suite can drive without a DOM',
    typeof loaded.paneBoxOf === 'function')

  check('lineCount counts lines, not newlines', loaded.lineCount('a\nb\nc') === 3 && loaded.lineCount('') === 1 &&
    loaded.lineCount('a\n') === 2)
  check('gutterNumbers numbers from one', loaded.gutterNumbers(3).join(',') === '1,2,3')
  check('gutterNumbers never answers an empty list', loaded.gutterNumbers(0).length === 1)
  check('gutterWidth grows with the line count', loaded.gutterWidth(9) === 1 && loaded.gutterWidth(10) === 2 &&
    loaded.gutterWidth(100) === 3)
  check('isDirty is exact, so a deleted trailing newline IS a change',
    loaded.isDirty('a\n', 'a') === true && loaded.isDirty('a', 'a') === false)
  check('refusalKey maps every reason', loaded.refusalKey('binary') === 'edit.binary' &&
    loaded.refusalKey('not-utf8') === 'edit.notUtf8' && loaded.refusalKey('too-large') === 'edit.tooLarge' &&
    loaded.refusalKey('not-file') === 'edit.notFile' && loaded.refusalKey('read-only') === 'edit.readOnly')
  check('refusalKey answers undefined for an unknown reason', loaded.refusalKey('something-new') === undefined)
  check('expectedTokens names the two fields the server requires',
    JSON.stringify(loaded.expectedTokens({ version: 'v', revision: 'r' })) === '{"version":"v","revision":"r"}')

  // Driven, not pattern-matched: this decision decides whether a person sees a
  // conflict dialog, and both directions are bad — a false positive nags on
  // every `touch`, a false negative saves over a real edit.
  check('movedTokenOnly is true when the digest is unchanged',
    loaded.movedTokenOnly({ version: '2:9:900', revision: 'abc' }, 'abc') === true)
  check('...and false when the bytes really changed',
    loaded.movedTokenOnly({ version: '2:9:900', revision: 'def' }, 'abc') === false)
  check('...and false when either side has no digest',
    loaded.movedTokenOnly({ revision: 'abc' }, '') === false &&
      loaded.movedTokenOnly({ revision: '' }, '') === false &&
      loaded.movedTokenOnly(null, 'abc') === false)
  check('...so an absent token can never be read as agreement',
    loaded.movedTokenOnly({}, undefined) === false)
}

// ---------------------------------------------------------------------------
// [9] Every key the chunk asks for exists in both dictionaries
// ---------------------------------------------------------------------------
{
  const locale = readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.locale.js'), 'utf8')
  const asked = [...editor.matchAll(/\bt\('(edit\.[A-Za-z]+)'/gu)].map(match => match[1])
  const unique = [...new Set(asked)]
  check('the chunk asks for some edit keys', unique.length >= 20, String(unique.length))
  const missing = unique.filter(key => !locale.includes(`'${key}':`))
  check('...and every one of them is in the dictionaries', missing.length === 0, missing.join(','))
  // The mapping helper names its keys as string literals rather than through
  // `t(...)`, so they are checked separately — a reason with no copy would
  // render the raw key into a tooltip.
  const mapped = [...editor.matchAll(/return '(edit\.[A-Za-z]+)'/gu)].map(match => match[1])
  check('the reason-to-copy mapping only names real keys',
    mapped.every(key => locale.includes(`'${key}':`)), mapped.filter(key => !locale.includes(`'${key}':`)).join(','))
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
