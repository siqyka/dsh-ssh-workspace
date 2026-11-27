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
  check('Python files get four spaces',
    /function indentFor \(path\)[\s\S]{0,240}?PYTHON_INDENT/u.test(editor) &&
      editor.includes('const indent = indentFor(target)'),
    'indentation is syntax in Python; two spaces writes a file its own formatter would rewrite')
  check('the engine is told the indent unit', (() => {
    const engine = readFileSync(path.join(pluginRoot, 'editor-engine', 'engine.js'), 'utf8')
    return /function createEditorEngine \(\{[^}]*indent/u.test(engine) &&
      engine.includes('indentUnit.of(unit)') &&
      engine.includes('EditorState.tabSize.of(unit.length)')
  })(), 'CodeMirror consults its own facet: the textarea rule cannot reach it')
  check('...and the panel passes the per-file unit', editor.includes('indent: indentFor(target)'))
  check('...which is four spaces for Python', (() => {
    const start = editor.indexOf('const INDENT =')
    const end = editor.indexOf('\n    }', editor.indexOf('function indentFor'))
    if (start < 0 || end < 0) return false
    const factory = new Function(editor.slice(start, end + 6) + '\nreturn indentFor')
    const indentFor = factory()
    return indentFor('/a/b.py').length === 4 && indentFor('/a/b.PY').length === 4 &&
      indentFor('/a/b.pyw').length === 4 && indentFor('/a/b.js').length === 2 &&
      indentFor('/a/b').length === 2
  })(), 'python only, including .pyw and any case')
  check('...and the un-indent unit follows the file',
    editor.includes('while (remove < indent.length') && editor.includes('insertAtCaret(area, indent)'),
    'Shift+Tab must take back exactly what Tab inserted')
  check('Ctrl/Cmd+S saves and stops the browser save dialog',
    /\(event\.ctrlKey \|\| event\.metaKey\) && !event\.altKey && \(event\.key === 's' \|\| event\.key === 'S'\)/u.test(editor) &&
      /preventDefault\(\)\s*\n\s*void save\(\)/u.test(editor))
  // Escape CLOSES, and it is handled on the panel's own keydown — not on
  // `document`. The reversal is deliberate: a global capture-phase listener is
  // right for a modal (it owns the screen) and wrong for an inline editor,
  // which must not swallow Escape while the composer or a stacked dialog has
  // focus. The old modal assertions said "no Escape handler at all"; that rule
  // died with the modal, so this one replaces it rather than deleting it.
  // Escape is one policy shared by both surfaces: the keydown handler and the
  // CodeMirror keymap both call `handleEscape`, and only that function decides
  // between "close the find bar" and "close the panel".
  check('Escape closes the find bar first, then the panel',
    /const handleEscape = React\.useCallback\(\(\) => \{[\s\S]{0,160}?find\.open === true\) closeFind\(\)[\s\S]{0,80}?else close\(\)/u.test(editor) &&
      /event\.key === 'Escape'[\s\S]{0,160}?handleEscape\(\)/u.test(editor))
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
  // The BOM is now one fact among several that the format sniff reports, so the
  // assertion follows it out of `text.js` rather than pinning an implementation
  // detail that moved into its own module.
  const textEncoding = readFileSync(path.join(pluginRoot, 'lib', 'routes', 'text-encoding.js'), 'utf8')
  check('the read route reports a BOM rather than dropping it',
    textEncoding.includes('BOM_UTF8') && /^\s+bom: format\.bom,$/mu.test(textRoutes))
  check('the save sends the BOM flag back', editor.includes('bom: state.bom'))
  check('...and the line-ending policy is the server\'s, not the browser\'s',
    editor.includes("eol: state.eolPolicy === 'auto' ? 'auto' : state.eolPolicy") && !/\\r\\n/u.test(editor))
  check('every refusal reason maps to its own copy key',
    ["'read-only'", "'binary'", "'not-utf8'", "'too-large'", "'not-file'"].every((reason) => editor.includes(`reason === ${reason}`)))
  check('the refusals are worded for all five reasons', ['edit.readOnly', 'edit.binary', 'edit.notUtf8', 'edit.tooLarge', 'edit.notFile']
    .every((key) => editor.includes(`return '${key}'`)))
  check('the refusal is visible as a title rather than a silent absence',
    editor.includes('const label = ready') && editor.includes('const title = openable ? label :'))
  check('a truncated file cannot be saved', editor.includes('if (state.truncated) return') &&
    editor.includes('disabled: saving || state.phase !== \'ready\' || state.truncated'))
}

// ---------------------------------------------------------------------------
// [7] Saving does not eat what was typed while it ran
// ---------------------------------------------------------------------------
{
  // Scoped to the SAVE, not the whole chunk: the pager legitimately replaces its
  // text with what the server sent, and an assertion that swept the file would
  // either forbid that or stop noticing a save that overwrote the buffer.
  const saveStart = editor.indexOf('const save = React.useCallback')
  const saveEnd = editor.indexOf('const reload = React.useCallback', saveStart)
  const saveBody = saveStart < 0 || saveEnd < 0 ? '' : editor.slice(saveStart, saveEnd)
  check('the baseline advances without replacing the buffer',
    saveBody !== '' && editor.includes('baseText: sent') && !/setState\([^)]*text: reply\.data/u.test(saveBody))
  check('...so a keystroke during a save survives', editor.includes('const sent = state.text'))
}

// ---------------------------------------------------------------------------
// [7b] A page unload that would discard the draft is guarded (defect 5)
// ---------------------------------------------------------------------------
{
  // The close button asks, but a refresh or a tab close never reaches it. This
  // is the only hook the page gets for those.
  check('a beforeunload guard is registered', editor.includes("addEventListener('beforeunload'"))
  check('...bound to the strip, so a saved buffer does not block a refresh and a dirty tab behind the visible one still does',
    /if \(dirtyPaths\.size === 0\) return undefined/u.test(editor) && /\}, \[dirtyPaths\]\)/u.test(editor))
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
  // The panel must own Escape, and own it on the elements it renders. A
  // document-level handler (what `useDialogA11y` installs) RACES this one: with
  // a save in flight, Escape would sometimes close the editor. Two Escape sites
  // are legitimate and both are element-scoped — the textarea and the find box.
  check('no document-level keydown handler competes for the panel\'s keys',
    !/document\.addEventListener\(\s*['"]keydown/u.test(editor) && !/useDialogA11y\s*\(/u.test(editor))
  check('...and both Escape sites are on elements the panel renders',
    (editor.match(/key === 'Escape'/gu) ?? []).length === 2)
}

// ---------------------------------------------------------------------------
// [7c] Find in file: the keys and the layer order (defect 6)
// ---------------------------------------------------------------------------
{
  // Comments cannot satisfy a rendering or wiring check, so this section reads
  // code with the comment lines removed.
  const code = editor.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')

  check('Ctrl/Cmd+F is taken before the browser opens its own find',
    /\(event\.key === 'f' \|\| event\.key === 'F'\)/u.test(code) &&
      /event\.preventDefault\(\)\s*\n\s*openFind\(\)/u.test(code))
  // The layer order is the whole contract: one press closes the bar, the next
  // closes the panel. Reversed, Escape with the bar open would throw away the
  // whole buffer's editing session.
  const escapeBranch = /if \(find\.open === true\) closeFind\(\)\s*\n\s*else close\(\)/u.exec(code)
  check('Escape closes the find bar before it closes the panel', escapeBranch !== null)
  check('...which is why the bar is only drawn while the text is ready',
    /find\.open !== true \|\| state\.phase !== 'ready'/u.test(code))
  check('the bar is rendered inside the panel, above the text',
    code.indexOf("className: 'sshwsp-editor-find'") < code.indexOf("className: 'sshwsp-editor-body'") &&
      code.includes('findBar,'))
  check('Enter steps forward and Shift+Enter steps back',
    /event\.shiftKey \? -1 : 1/u.test(code))
  check('the count is announced rather than only drawn',
    /'aria-live': 'polite'/u.test(code))
  // Closing with the match still selected would mean the next character typed
  // REPLACES it — an edit nobody asked for. The selection is collapsed instead.
  check('closing the bar collapses the selection instead of leaving it armed',
    /setSelectionRange\(area\.selectionEnd, area\.selectionEnd\)/u.test(code))
  check('no text arrow glyph is drawn beside the plugin\'s icons',
    !/children:\s*'[↑↓×]'/u.test(code))
}

// ---------------------------------------------------------------------------
// [7d] A file past the editing cap opens read-only paging, not an editor
// ---------------------------------------------------------------------------
{
  // `paged` is the ONLY refusal that unlocks the button. Every other reason
  // (binary, not-utf8, read-only session) must keep the click inert, or the panel
  // opens only to fail. "Inert" is now `aria-disabled` plus a guarded click, not
  // the HTML `disabled` attribute: a disabled control does not reliably hover its
  // own title, which used to be the only place the reason was written.
  check('the probe carries the server\'s "too big to edit, still readable" flag',
    editor.includes('paged: reply.data?.paged === true'))
  check('...and only that refusal unlocks the button',
    editor.includes("const pageable = probe.phase === 'refused' && probe.paged === true") &&
      editor.includes("'aria-disabled': openable ? undefined : 'true'"))
  check('...which opens the pager instead of the editor',
    editor.includes('setPaged(pageable)') && editor.includes('children: paged') &&
      editor.includes('jsx(FilePagerPanel, {'))

  const pagerStart = editor.indexOf('function FilePagerPanel')
  // The pager's own exports come right after it, so the end of the block is the
  // next `exports.` line rather than the file end: a future component added
  // below must not silently widen what this section asserts about.
  const pagerEnd = editor.indexOf('\n    exports.', pagerStart)
  const pager = pagerStart < 0 || pagerEnd < 0 ? '' : editor.slice(pagerStart, pagerEnd)
  check('the pager asks for a byte offset rather than the whole file',
    pager.includes("offset: String(at)"), String(pager.length))
  // The encoding is decided once, by the server, from the head. A page that
  // sniffed itself would decode a GB18030 file two different ways.
  check('...echoing the encoding and line endings the first page decided',
    pager.includes("query.set('encoding', encoding)") && pager.includes("query.set('eol', eol)"))
  check('...and never sniffs an encoding of its own', !/decodeUtf8|TextDecoder/u.test(pager))
  check('the text is read-only, not disabled, so it can still be selected and scrolled',
    pager.includes('readOnly: true') && !/disabled: true/u.test(pager))
  // A read-only view must not reach the write route at all: the shortest path
  // from "look at a big file" to "overwrite it" is a save button nobody meant
  // to leave on.
  check('...and there is no way to save from it',
    !pager.includes('API.writeText') && !pager.includes('t(\'edit.save\')'))
  check('a page is walked by nextOffset, not by adding PAGE_BYTES',
    pager.includes('state.nextOffset') && pager.includes('visited'))
}

// ---------------------------------------------------------------------------
// [7e] A file that cannot be edited says so: red dot, reason on hover
// ---------------------------------------------------------------------------
{
  // The refusal used to be a `disabled` button whose tooltip said why — which is
  // the same as saying nothing, because a disabled control does not hover its
  // title in every browser. So the button stays live (guarded click, `aria-
  // disabled` for assistive tech), carries a red dot so the refusal is visible
  // before anyone hovers, and keeps the reason in its title.
  check('a refused file keeps the pencil and marks it with a dot',
    editor.includes('const blocked = !ready') &&
      editor.includes("(blocked ? ' sshwsp-fileaction-blocked' : '')") &&
      editor.includes("className: 'sshwsp-fileaction-dot', 'aria-hidden': 'true'"))
  check('...the dot is decoration, not a second hit target',
    styles.includes('.sshwsp-fileaction-dot') && styles.includes('pointer-events: none'))
  check('...and it is painted from the theme\'s error token, not a hardcoded red',
    styles.includes('--dsw-alias-state-error-primary'))
  check('...the button is live so hover and focus can show the reason',
    !/disabled: !openable/u.test(editor) &&
      editor.includes("'aria-disabled': openable ? undefined : 'true'") &&
      // The refusal still cannot open an editor: the click guard is what makes
      // `aria-disabled` honest rather than decorative.
      editor.includes('if (!openable) return'))
  check('...and the title carries the localised reason plus the server\'s own words',
    editor.includes('const title = openable ? label :') &&
      editor.includes('probe.message === \'\' ? \'\' :'))
  check('the dot sits on the icon corner rather than reflowing the header',
    /\.sshwsp-fileaction-edit \{[^}]*position: relative/u.test(styles) &&
      /\.sshwsp-fileaction-dot \{[^}]*position: absolute/u.test(styles))
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
  check('...and the read-only pager that a too-large file opens',
    typeof loaded.FilePagerPanel === 'function' && typeof loaded.pageOf === 'function')
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

  // The page counter is derived from the offset so a jump, a reload and a step
  // back all agree. Off-by-one here is invisible in code review and obvious to
  // the user ("page 0 of 0").
  const page = loaded.PAGE_BYTES
  check('pageOf counts from one', loaded.pageOf(0, page * 3).page === 1 &&
    loaded.pageOf(page, page * 3).page === 2 && loaded.pageOf(page * 2, page * 3).page === 3)
  check('...and knows how many there are', loaded.pageOf(0, page * 3).pages === 3 &&
    loaded.pageOf(0, page * 3 + 1).pages === 4 && loaded.pageOf(0, 1).pages === 1)
  check('...and a partial page counts as a page', loaded.pageOf(page * 3 - 1, page * 3).page === 3)
  check('...and an offset past the end clamps instead of inventing a page',
    loaded.pageOf(page * 5, page * 2).page === 2)
  check('...and an empty file is one page, not zero', loaded.pageOf(0, 0).pages === 1)
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

  // ---- find in file (defect 6)
  //
  // The bar is only useful if the span it selects is the occurrence the user
  // asked for, so the matcher and the stepper are driven rather than grepped.
  const haystack = 'alpha\nBeta\nbeta\nALPHA\n'
  check('findMatches finds every occurrence, case-insensitively by default',
    loaded.findMatches(haystack, 'beta').matches.length === 2,
    JSON.stringify(loaded.findMatches(haystack, 'beta')))
  check('...and the spans it reports are the text it matched',
    loaded.findMatches(haystack, 'beta').matches.every(match => haystack.slice(match.start, match.end).toLowerCase() === 'beta'))
  check('case sensitivity is honoured when asked for',
    loaded.findMatches(haystack, 'beta', { caseSensitive: true }).matches.length === 1)
  check('an empty query matches nothing rather than everything',
    loaded.findMatches(haystack, '').matches.length === 0)
  check('a query is a literal, so a dot does not match any character',
    loaded.findMatches('a.b axb', '.').matches.length === 1 &&
      loaded.findMatches('a.b axb', '.').matches[0].start === 1)
  check('matches do not overlap, so a repeated needle cannot loop forever',
    loaded.findMatches('aaaa', 'aa').matches.length === 2 &&
      loaded.findMatches('aaaa', 'aa').matches[1].start === 2)
  check('the list is capped and says so instead of counting forever',
    (() => {
      const huge = 'a'.repeat(loaded.FIND_MATCH_CAP + 50)
      const foundList = loaded.findMatches(huge, 'a')
      return foundList.matches.length === loaded.FIND_MATCH_CAP && foundList.capped === true
    })(), String(loaded.FIND_MATCH_CAP))

  check('stepping with nothing selected lands on the first match',
    loaded.stepMatchIndex(5, -1, 1) === 0)
  check('...and on the last one when stepping backwards',
    loaded.stepMatchIndex(5, -1, -1) === 4)
  check('stepping wraps at both ends', loaded.stepMatchIndex(3, 2, 1) === 0 &&
    loaded.stepMatchIndex(3, 0, -1) === 2)
  check('stepping in an empty list answers "nothing", not -1 modulo zero',
    loaded.stepMatchIndex(0, 0, 1) === -1 && loaded.stepMatchIndex(0, 3, -1) === -1)
  check('an out-of-range index is treated as "nothing selected"',
    loaded.stepMatchIndex(3, 9, 1) === 0)

  check('lineIndexOf counts the lines before an offset',
    loaded.lineIndexOf('a\nbb\nccc', 0) === 0 &&
      loaded.lineIndexOf('a\nbb\nccc', 2) === 1 &&
      loaded.lineIndexOf('a\nbb\nccc', 5) === 2)
  check('...and an offset on a newline belongs to the line it ends',
    loaded.lineIndexOf('a\nb', 1) === 0)

  check('revealing a line scrolls it into the upper third',
    loaded.revealScrollTop(10, 180) === 10 * loaded.EDITOR_LINE_HEIGHT - 60)
  check('...never above the top of the file', loaded.revealScrollTop(0, 180) === 0 &&
    loaded.revealScrollTop(1, 3000) === 0)
  check('...and a viewport it cannot read does not produce a NaN scroll',
    loaded.revealScrollTop(3, undefined) === 3 * loaded.EDITOR_LINE_HEIGHT &&
      Number.isFinite(loaded.revealScrollTop(3, Number.NaN)))

  // The scroll arithmetic needs the same line height the stylesheet uses. If
  // these two drift, find scrolls to the wrong line and nothing else notices.
  const areaRule = /\.sshwsp-editor-area \{([^}]*)\}/u.exec(styles)
  const cssLineHeight = areaRule === null ? '' : /line-height:\s*(\d+)px/u.exec(areaRule[1])
  // ---- syntax highlighting (the colour layer)
  //
  // The tokenizer is load-bearing and invisible: a scanner that colours a
  // comment as a string looks plausible in source and wrong on screen, so the
  // sections here DRIVE it. Every case is a line whose correct answer is known,
  // and the reconstruction check turns "the layer renders the same text" into
  // an assertion rather than a hope.
  const kindsOf = step => step.tokens.map(token => token.type).join(',')
  const scan = (language, line, state) => loaded.highlightLine(language, state ?? { mode: 'code' }, line)

  check('every language has a unique id and at least one extension',
    new Set(loaded.LANGUAGES.map(def => def.id)).size === loaded.LANGUAGES.length &&
      loaded.LANGUAGES.every(def => (def.exts ?? []).length > 0))
  check('...and no extension is claimed by two languages',
    new Set(loaded.LANGUAGES.flatMap(def => def.exts ?? [])).size ===
      loaded.LANGUAGES.flatMap(def => def.exts ?? []).length)

  check('the language is chosen by the LAST extension, case-insensitively',
    loaded.languageOfPath('src/a.test.js') === 'javascript' &&
      loaded.languageOfPath('a.TSX') === 'javascript' &&
      loaded.languageOfPath('NOTES.MD') === 'markdown' &&
      loaded.languageOfPath('x.json') === 'json')
  check('...and by the two names that have no extension',
    loaded.languageOfPath('Dockerfile') === 'dockerfile' && loaded.languageOfPath('Makefile') === 'make' &&
      loaded.languageOfPath('.env.local') === 'shell')
  check('...while a dotfile and an unknown extension claim no colour',
    loaded.languageOfPath('.gitignore') === null && loaded.languageOfPath('a.log') === null)

  const scriptLine = 'const value = "hi" + 42 // note'
  check('a JavaScript line splits into keyword, string, number and comment',
    kindsOf(scan('javascript', scriptLine)) === 'keyword,string,number,comment',
    kindsOf(scan('javascript', scriptLine)))
  check('...a call name and a property are told apart',
    kindsOf(scan('javascript', 'obj.value = call()')) === 'prop,fn',
    kindsOf(scan('javascript', 'obj.value = call()')))
  const openComment = scan('javascript', '/* start')
  const insideComment = scan('javascript', 'still comment', openComment.state)
  const afterComment = scan('javascript', 'end */ const x = 1', insideComment.state)
  check('a block comment carries across lines',
    openComment.state.mode === 'block' && kindsOf(insideComment) === 'comment')
  check('...and the code after its close is scanned again',
    kindsOf(afterComment) === 'comment,keyword,number', kindsOf(afterComment))
  const openTemplate = scan('javascript', 'const t = `one')
  check('a template literal carries across lines',
    openTemplate.state.mode === 'template' &&
      kindsOf(scan('javascript', 'two` + 1', openTemplate.state)) === 'string,number')
  check('an unterminated single-line string does not swallow the next line',
    scan('javascript', 'const s = "oops').state.mode === 'code')

  // A regex literal is the one JavaScript construct where a quote is not a
  // string: without this, `/ab"c/` opened a string and painted the rest of the
  // line as one. The division cases are the other half of the same decision —
  // a scanner that sees a regex everywhere is as wrong as one that sees none.
  const regexLine = 'const re = /ab"c/g'
  const regexStep = scan('javascript', regexLine)
  check('a regex literal is one token, quotes and all',
    kindsOf(regexStep) === 'keyword,string' && regexStep.tokens[1].start === 11 &&
      regexStep.tokens[1].end === regexLine.length,
    kindsOf(regexStep))
  check('...while a division is not mistaken for one',
    kindsOf(scan('javascript', 'const x = a / b')) === 'keyword' &&
      kindsOf(scan('javascript', 'const x = a / b / c')) === 'keyword' &&
      // `++` ends a value like a name does, so the slash after it divides.
      kindsOf(scan('javascript', 'x = y++ / 2 / 3')) === 'number,number',
    kindsOf(scan('javascript', 'x = y++ / 2 / 3')))
  check('...and a regex after a keyword or a bracket still opens',
    kindsOf(scan('javascript', 'return /x/.test(s)')) === 'keyword,string,prop' &&
      kindsOf(scan('javascript', 'if (/x/.test(s)) {}')) === 'keyword,string,prop')
  check('...and a slash inside a character class does not close it',
    kindsOf(scan('javascript', 'x = /[a/]/')) === 'string',
    kindsOf(scan('javascript', 'x = /[a/]/')))

  // Rust gives the same quote to a lifetime and a character literal. Only the
  // closing quote tells them apart; without the test, every `&'a str` borrow
  // painted the rest of its line as a string.
  const lifetime = scan('rust', "fn f<'a>(x: &'a str) -> &'a str { x }")
  check('a Rust lifetime is not a string, while a char literal still is',
    lifetime.tokens.every(token => token.type !== 'string') &&
      kindsOf(scan('rust', "let c = 'x';")) === 'keyword,string' &&
      kindsOf(scan('rust', "let n = '\\n';")) === 'keyword,string',
    kindsOf(lifetime))

  check('a quoted JSON key is a property, its value is not',
    kindsOf(scan('json', '"key": [1, true]')) === 'prop,number,constant',
    kindsOf(scan('json', '"key": [1, true]')))
  check('SQL keywords are matched case-insensitively',
    kindsOf(scan('sql', 'Select * From t')) === 'keyword,keyword',
    kindsOf(scan('sql', 'Select * From t')))

  check('a markdown heading is a marker plus a strong line',
    kindsOf(scan('markdown', '# Title')) === 'keyword,strong')
  const fenceOpen = scan('markdown', '```js')
  const fenceBody = scan('markdown', 'const a = 1', fenceOpen.state)
  const fenceClose = scan('markdown', '```', fenceBody.state)
  check('a fenced code block is one colour and ends where the fence does',
    fenceOpen.state.fence === '```' && kindsOf(fenceBody) === 'string' &&
      kindsOf(fenceClose) === 'keyword' && fenceClose.state.fence === '')
  check('a markdown link and inline code are recognised',
    kindsOf(scan('markdown', 'see `x` and [y](z)')) === 'string,link')

  check('markup tags, attributes and values are told apart',
    kindsOf(scan('markup', '<div class="x" id=y>t</div>')) === 'keyword,prop,string,prop,string,keyword')
  const openNote = scan('markup', '<!-- note')
  check('a markup comment carries across lines',
    openNote.state.comment === true && kindsOf(scan('markup', 'end -->', openNote.state)) === 'comment')

  const openDoc = scan('python', '    """doc')
  const inDoc = scan('python', '    more', openDoc.state)
  const afterDoc = scan('python', '    """', inDoc.state)
  check('a Python triple-quoted string spans lines',
    openDoc.state.mode === 'block' && kindsOf(inDoc) === 'string' &&
      kindsOf(afterDoc) === 'string' && afterDoc.state.mode === 'code')
  check('...and the code after it is scanned again',
    kindsOf(scan('python', '    return None', afterDoc.state)) === 'keyword,constant')

  const reconstruction = [
    ['javascript', scriptLine],
    ['javascript', 'obj.value = call()'],
    ['javascript', '\tconst t = `x${y}`'],
    ['javascript', 'const re = /ab"c/g'],
    ['json', '"key": [1, true]'],
    ['css', '.a > b { color: "red"; }'],
    ['markdown', '- item with `code`'],
    ['markup', '<div class="x" id=y>t</div>'],
    ['python', 'def f (a): return None'],
    ['sql', 'select * from t'],
  ]
  check('the token spans put the line back together exactly',
    reconstruction.every(([language, line]) =>
      loaded.tokenSpans(line, scan(language, line).tokens).map(part => part.text).join('') === line),
    reconstruction.map(([language, line]) => language).join(','))
  check('...and tokens never overlap or run past the line',
    reconstruction.every(([language, line]) => {
      let end = 0
      return scan(language, line).tokens.every((token) => {
        const ok = token.start >= end && token.end > token.start && token.end <= line.length
        end = token.end
        return ok
      })
    }))
  check('a token that runs past the line is clipped, not crashed',
    loaded.tokenSpans('ab', [{ start: 1, end: 9, type: 'string' }]).map(part => part.text).join('') === 'ab')

  check('the changed line is where the token cache resumes',
    loaded.firstChangedLine('a\nb\nc', 'a\nb\nc') === -1 &&
      loaded.firstChangedLine('a\nb\nc', 'a\nB\nc') === 1 &&
      loaded.firstChangedLine('a\nb', 'a\nb\nc') === 1 &&
      loaded.firstChangedLine('a\nb', 'a') === 0)

  const topWindow = loaded.visibleLineRange(0, 180, 100, 12)
  const middleWindow = loaded.visibleLineRange(900, 180, 100, 12)
  check('the window follows the scroll and stays inside the file',
    topWindow.first === 0 && middleWindow.first === 38 &&
      loaded.visibleLineRange(9999, 180, 100, 12).last === 100 &&
      loaded.visibleLineRange(9999, 180, 100, 12).first === 99)
  check('...and an empty file or an unreadable viewport asks for nothing impossible',
    loaded.visibleLineRange(0, 180, 0, 12).last === 0 &&
      Number.isFinite(loaded.visibleLineRange(Number.NaN, Number.NaN, 10, 12).first))

  const ready = { phase: 'ready', language: 'javascript', wrap: false, composing: false, length: 10 }
  check('the layer is on only where colouring is correct',
    loaded.highlightEnabled(ready) === true &&
      loaded.highlightEnabled({ ...ready, wrap: true }) === false &&
      loaded.highlightEnabled({ ...ready, composing: true }) === false &&
      loaded.highlightEnabled({ ...ready, language: null }) === false &&
      loaded.highlightEnabled({ ...ready, length: loaded.HIGHLIGHT_MAX_CHARS + 1 }) === false &&
      loaded.highlightEnabled({ ...ready, phase: 'loading' }) === false)
  check('the size cap is a real number below the editor\'s own limit',
    Number.isInteger(loaded.HIGHLIGHT_MAX_CHARS) && loaded.HIGHLIGHT_MAX_CHARS > 0 &&
      loaded.HIGHLIGHT_MAX_CHARS <= 2 * 1024 * 1024)

  // The cache is the difference between a per-keystroke cost bounded by the
  // window and one bounded by the file. Retaining the STATE at a line is only
  // sound if an edit invalidates every state after it, which is what the second
  // half of this check would catch.
  const cache = loaded.createHighlightCache()
  loaded.syncHighlightCache(cache, 'javascript', 'const a = 1\n/* open\nconst b = 2\nconst c = 3')
  check('an open block comment colours the lines it covers',
    kindsOf({ tokens: loaded.tokensAt(cache, 3) }) === 'comment',
    kindsOf({ tokens: loaded.tokensAt(cache, 3) }))
  loaded.syncHighlightCache(cache, 'javascript', 'const a = 1\n// open\nconst b = 2\nconst c = 3')
  check('...and rewriting its opener re-colours every line below it',
    kindsOf({ tokens: loaded.tokensAt(cache, 3) }) === 'keyword,number',
    kindsOf({ tokens: loaded.tokensAt(cache, 3) }))
  check('a line outside the file answers no tokens', loaded.tokensAt(cache, 99).length === 0 &&
    loaded.tokensAt(cache, -1).length === 0)

  // -- and the shape that keeps the layer underneath without stealing a job
  const layerAreaRule = /\.sshwsp-editor-area \{([^}]*)\}/u.exec(styles)
  const lineRule = /\.sshwsp-editor-hl-line \{([^}]*)\}/u.exec(styles)
  const metrics = (rule) => ['font-family', 'font-size', 'line-height', 'tab-size', 'white-space']
    .map((name) => {
      const found = rule === undefined ? null : new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(rule)
      return found === null ? `${name}=absent` : `${name}=${found[1].trim()}`
    }).join('|')
  check('the colour layer repeats the textarea\'s metrics exactly',
    layerAreaRule !== null && lineRule !== null && metrics(layerAreaRule[1]) === metrics(lineRule[1]),
    `${metrics(layerAreaRule?.[1])} vs ${metrics(lineRule?.[1])}`)
  check('the layer is a clip, not a second scroll port',
    /\.sshwsp-editor-hl \{[^}]*overflow: hidden/u.test(styles) &&
      /\.sshwsp-editor-hl \{[^}]*pointer-events: none/u.test(styles))
  check('...and the textarea is transparent only while the layer paints',
    /\.sshwsp-editor-area-box-hl \.sshwsp-editor-area \{[^}]*color: transparent/u.test(styles) &&
      /\.sshwsp-editor-area-box-hl \.sshwsp-editor-area \{[^}]*caret-color/u.test(styles))
  // The selection has to stay translucent: the highlight layer paints the
  // glyph colours underneath it, and an opaque wash would erase them. It used
  // to be an rgba() literal; it is now a token, so the assertion follows the
  // token and separately proves the token itself is a wash rather than a fill.
  check('...with a translucent selection, so the colour underneath survives it',
    /\.sshwsp-editor-area-box-hl \.sshwsp-editor-area::selection \{[^}]*background: var\(--sshwsp-selection\)/u.test(styles) &&
      /--sshwsp-selection: color-mix\(in srgb, var\(--sshwsp-accent\) \d+%, transparent\);/u.test(styles))
  // The light palette must follow the app's theme, not the desktop's: DSH
  // publishes `data-ds-theme-source` on <html> (the preference, `system`
  // included) and the OS query is only right when the app is following it.
  check('the light palette follows the host\'s theme source, not the OS alone',
    styles.includes('[data-ds-theme-source="light"] .sshwsp-editor-panel') &&
      styles.includes('[data-ds-theme-source="system"] .sshwsp-editor-panel') &&
      !/@media \(prefers-color-scheme: light\) \{\s*\n\s*\.sshwsp-editor-panel/u.test(styles))
  // A colour that looks fine in one theme can be unreadable in the other: One
  // Light's string green measured 3.1:1 on white while the same role clears 6:1
  // in the dark palette. Both palettes are measured against their own
  // background, with 4.5:1 as the WCAG AA floor for body text.
  const relativeLuminance = (hex) => {
    const channel = (value) => {
      const ratio = value / 255
      return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) +
      0.7152 * channel(parseInt(hex.slice(3, 5), 16)) +
      0.0722 * channel(parseInt(hex.slice(5, 7), 16))
  }
  const contrastOn = (hex, background) => {
    const [high, low] = [relativeLuminance(hex), relativeLuminance(background)].sort((a, b) => b - a)
    return (high + 0.05) / (low + 0.05)
  }
  const paletteOf = (block) => Object.fromEntries(
    [...block.matchAll(/--sshwsp-hl-([a-z]+):\s*(#[0-9a-f]{6});/gu)].map(match => [match[1], match[2]]))
  const darkPalette = paletteOf(
    [...styles.matchAll(/\.sshwsp-editor-panel \{([^}]*)\}/gu)]
      .map(match => match[1]).find(block => block.includes('--sshwsp-hl-comment')) ?? '')
  const lightPalette = paletteOf(
    /\[data-ds-theme-source="light"\] \.sshwsp-editor-panel,[\s\S]*?\{([^}]*)\}/u.exec(styles)?.[1] ?? '')
  check('both palettes name the same colours',
    Object.keys(darkPalette).length === 11 && Object.keys(lightPalette).length === 11 &&
      Object.keys(lightPalette).sort().join(',') === Object.keys(darkPalette).sort().join(','),
    `${Object.keys(darkPalette).length}/${Object.keys(lightPalette).length}`)
  check('...and every colour stays readable on its own background',
    Object.values(darkPalette).every(hex => contrastOn(hex, '#1e1e1e') >= 4.5) &&
      Object.values(lightPalette).every(hex => contrastOn(hex, '#ffffff') >= 4.5),
    Object.entries(darkPalette).map(([name, hex]) => `${name}=${contrastOn(hex, '#1e1e1e').toFixed(1)}`)
      .concat(Object.entries(lightPalette).map(([name, hex]) => `light.${name}=${contrastOn(hex, '#ffffff').toFixed(1)}`))
      .join(','))
  // The relationship is what matters, not the numbers: the textarea sits above
  // the colour layer so its caret and selection paint over the glyphs. Both
  // now read from the z scale, so pin the two scale steps and their order.
  check('...and the layer is drawn where the textarea can paint over it',
    /z-index: var\(--sshwsp-z-raised\)/u.test(layerAreaRule?.[1] ?? '') &&
      /z-index: var\(--sshwsp-z-base\)/u.test(/\.sshwsp-editor-hl \{[^}]*\}/u.exec(styles)?.[0] ?? '') &&
      Number(/--sshwsp-z-raised: (\d+);/u.exec(styles)?.[1]) > Number(/--sshwsp-z-base: (\d+);/u.exec(styles)?.[1]))
  check('the panel puts the layer before the textarea in its own box',
    editor.indexOf('jsx(HighlightLayer') > 0 && editor.indexOf('jsx(HighlightLayer') < editor.indexOf("className: 'sshwsp-editor-area' +"))
  check('an IME composition hands the glyphs back to the textarea',
    editor.includes('onCompositionStart: () => setComposing(true)') &&
      editor.includes('onCompositionEnd: () => setComposing(false)'))
  // The wrap toggle used to be labelled with the Tab hint ("Tab inserts two
  // spaces"), which describes none of what the button does — and now it also
  // turns the colours off, so the label has to say what it IS.
  check('the wrap toggle is labelled as wrapping, not as the Tab hint',
    editor.includes("title: t('edit.wrapHint')") && editor.includes("children: t('edit.wrap')") &&
      !editor.includes("children: t('edit.tabHint')"))
}

// ---------------------------------------------------------------------------
// [8a] Open tabs: the store that outlives the panel, and the strip that shows it
// ---------------------------------------------------------------------------
{
  const saved = globalThis.window
  let factory
  globalThis.window = { __ModuleLoader__: { load (spec) { factory = spec.factory } } }
  let loaded
  try {
    // eslint-disable-next-line no-new-func
    const run = new Function('window', 'require', 'module', 'exports', readFileSync(editorPath, 'utf8'))
    const shim = { exports: {} }
    run(globalThis.window, () => ({}), shim, shim.exports)
    loaded = factory((name) => ({ react: {}, 'react/jsx-runtime': {} })[name] ?? {
      API: {},
      CloseIcon: () => null,
      formatBytes: () => '',
      requestJson: async () => ({ ok: true, status: 200, data: {} }),
    })
  } finally {
    globalThis.window = saved
  }

  check('the tab store is exported, so its rules are asserted rather than rewritten',
    typeof loaded.createTabStore === 'function')
  const tabs = loaded.createTabStore()
  check('a session starts with no tabs and nothing in front',
    tabs.list('s').length === 0 && tabs.active('s') === '')
  tabs.open('s', '/a')
  tabs.open('s', '/b')
  tabs.open('s', '/a')
  check('...opening a file twice keeps one tab and brings it forward',
    tabs.list('s').join(',') === '/a,/b' && tabs.active('s') === '/a')

  let notified = 0
  const stop = tabs.subscribe('s', () => { notified += 1 })
  tabs.remember('s', '/b', { text: 'x' })
  tabs.remember('s', '/b', { text: 'xy' })
  check('...a dirty buffer is remembered, and the strip is not woken for every keystroke',
    tabs.draft('s', '/b')?.text === 'xy' && notified === 1)
  tabs.remember('s', '/b', null)
  check('...forgetting a draft is a flip the strip does hear about',
    tabs.draft('s', '/b') === null && notified === 2)
  check('...closing the active tab puts its right neighbour in front',
    tabs.close('s', '/a') === '/b' && tabs.list('s').join(',') === '/b')
  check('...and closing the last tab leaves nothing in front',
    tabs.close('s', '/b') === '' && tabs.list('s').length === 0)
  stop()
  notified = 0
  tabs.remember('s', '/c', { text: 'z' })
  check('...an unsubscribed listener is not called', notified === 0)
  check('...and every store is its own', loaded.createTabStore().list('s').length === 0)

  check('the panel shows the strip of every file the session opened, not just its own',
    editor.includes("jsx('div', { className: 'sshwsp-editor-tabs'") &&
      editor.includes('tabPaths.map') &&
      editor.includes('openTabs.list(sessionId)'))
  check('...restores an unsaved draft instead of re-reading the file it belongs to',
    /const draft = openTabs\.draft\(sessionId, target\)\s*\n\s*if \(draft !== null\) \{/u.test(editor))
  check('...checks the draft BEFORE it starts a read',
    editor.indexOf('openTabs.draft(sessionId, target)') > 0 &&
      editor.indexOf('openTabs.draft(sessionId, target)') < editor.indexOf('new AbortController()', editor.indexOf('One load path, driven')))
  check('...mirrors the buffer into the store as it changes',
    /React\.useEffect\(\(\) => \{\s*\n\s*rememberActive\(\)\s*\n\s*\}, \[state, rememberActive\]\)/u.test(editor))
  check('...asks before closing a dirty tab',
    editor.includes("if (window.confirm(t('edit.unsavedPrompt')) !== true) return"))
  check('...and a save no longer closes the panel that holds the file in a tab',
    /onSaved: \(\) => undefined/u.test(editor))
  // Two bugs the first version had, both born from `target` changing before
  // `state` did: the previous file's buffer was mirrored under the new tab, and
  // closing a tab behind the visible one pushed the visible buffer into a
  // loading state that no effect would ever leave.
  check('...a buffer carries the path it came from, and the draft mirror checks it',
    editor.includes('current.path !== target') &&
      editor.includes("path: target,\n              text,"))
  check('...and closing a tab behind the visible one leaves the visible one alone',
    editor.includes('if (closedPath !== target) return'))
  check('...while the engine is created only once the body it mounts into exists',
    /state\.phase !== 'ready'\) return undefined/u.test(editor) &&
      /\[engineModule, target, state\.phase\]/u.test(editor))
  check('...and a session has ONE panel on screen: a newer mount closes the older',
    editor.indexOf('const panelOwners = new Map()') > 0 &&
      editor.indexOf('const panelOwners = new Map()') < editor.indexOf('function FileEditorPanel') &&
      /if \(previous !== undefined && previous !== handle\) previous\.close\(\)/u.test(editor))
}

// ---------------------------------------------------------------------------
// [8b] The editor engine chunk (CodeMirror), and the fallback that outlives it
// ---------------------------------------------------------------------------
{
  const enginePath = path.join(pluginRoot, 'lib', 'client', 'client.editor-engine.js')
  const engineSource = readFileSync(enginePath, 'utf8')
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))

  // The chunk is generated, and generated files rot silently. Three things keep
  // it honest: the size (a stray empty file would "work" and mount nothing),
  // the registration footer (the Host evaluates chunks, it does not import
  // them), and the build scripts being declared at all.
  check('the engine ships as its own chunk, large enough to be worth a lazy load',
    engineSource.length > 300 * 1024, `${Math.round(engineSource.length / 1024)} KiB`)
  check('...and registers itself the way the Host loads chunks',
    /window\.__ModuleLoader__\.load\(\{[\s\S]{0,200}?chunk: 'client\.editor-engine\.js'[\s\S]{0,120}?factory: \(\) => window\.__sshwsp_engine/u
      .test(engineSource))
  check('...with build and staleness scripts, so the artifact cannot drift',
    /node scripts\/build-editor-engine\.mjs/u.test(manifest.scripts?.['build:editor'] ?? '') &&
      /--check/u.test(manifest.scripts?.['check:editor'] ?? ''))
  // Word wrap off makes CodeMirror scroll the text under a pinned gutter. A
  // see-through gutter lets a long line print straight over the line numbers,
  // so the gutter paints the surface the code sits on — not `transparent`.
  check('the gutter is opaque, so unwrapped text cannot run over the line numbers',
    engineSource.includes('backgroundColor:"var(--sshwsp-gutter-bg, transparent)"') &&
      /--sshwsp-gutter-bg: var\(--sshwsp-surface\)/u.test(styles) &&
      /\.sshwsp-editor-panel-inline \{ --sshwsp-gutter-bg: var\(--sshwsp-bg\)/u.test(styles),
    'a transparent gutter shows the line text through the numbers once the code scrolls sideways')

  // A three-digit line number already fills the 2ch floor, so the digits need
  // padding of their own before the first character of the line starts. This
  // lives in the generated chunk, so the numbers are pinned here: change the
  // theme without rebuilding and this fails.
  check('the line numbers keep a gap from the text (gutter padding, not zero)',
    engineSource.includes('".cm-gutterElement":{padding:"0 14px 0 0",minWidth:"2ch"}') &&
      engineSource.includes('borderRight:"none",paddingLeft:"8px"}') &&
      engineSource.includes('".cm-line":{padding:"0 12px 0 0"}'),
    'gutter right padding at 6px left the first character touching the digits')

  // Evaluating the real bundle is the difference between "a file exists" and
  // "mounting an editor is possible": it proves the factory returns a real
  // `createEditorEngine`, not an empty namespace.
  const savedEngineWindow = globalThis.window
  let engineFactory
  let engineExports = null
  try {
    globalThis.window = { __ModuleLoader__: { load (spec) { engineFactory = spec.factory } } }
    // eslint-disable-next-line no-new-func
    new Function('window', engineSource)(globalThis.window)
    engineExports = engineFactory()
  } catch {
    engineExports = null
  } finally {
    globalThis.window = savedEngineWindow
  }
  check('the bundle evaluates and exports a mount function',
    typeof engineExports?.createEditorEngine === 'function')

  // The panel owns the fallback: if the engine chunk never arrives, the textarea
  // has to still be there, which means the CM branch must be conditional rather
  // than a replacement in source.
  check('the panel asks for the engine lazily, and only after a file loaded',
    editor.includes("require.async('./client.editor-engine.js')") &&
      editor.includes('engineModulePromise') &&
      /if \(state\.phase !== 'ready' \|\| engineModule !== null\) return undefined/u.test(editor))
  check('...remembers a failed load instead of retrying on every render',
    /\.catch\(\(\) => null\)/u.test(editor) && editor.includes('if (engineModulePromise === null)'))
  check('...keeps the textarea as the editor when the engine is absent',
    editor.includes("className: 'sshwsp-editor-cm'") &&
      editor.includes("className: 'sshwsp-editor-area'") &&
      editor.includes('engineModule !== null'))
  check('...and hands the engine the panel\'s own save, find and escape policy',
    editor.includes('onSave: () => handlersRef.current.save?.()') &&
      editor.includes('onFind: () => handlersRef.current.openFind?.()') &&
      editor.includes('onEscape: () => handlersRef.current.escape?.()'))
  check('the engine host is the only scroller where it mounts',
    /\.sshwsp-editor-cm \{[^}]*min-height: 0/u.test(styles) &&
      /\.sshwsp-editor-cm \{[^}]*display: flex/u.test(styles))
}

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
  const eolKeys = ['edit.eolLabel', 'edit.eolHint', 'edit.eolAuto']
  check('...including the line-ending control\'s copy',
    eolKeys.every(key => locale.includes(`'${key}':`)), eolKeys.filter(key => !locale.includes(`'${key}':`)).join(','))
}

{
  // A save reply is keyed to the file it started on. The panel used to write
  // the returned baseline tokens into whichever tab was visible when the
  // request settled, which marked the wrong file dirty and guaranteed a 409 on
  // its next save.
  check('a save pins the file it started on',
    editor.includes('const savingPath = target') &&
      editor.includes('const sent = state.text'))
  check('...and decides every post-await write against the live path',
    editor.includes('const stillActive = () => stateRef.current.path === savingPath') &&
      /if \(!stillActive\(\)\) return/u.test(editor) &&
      editor.includes('openTabs.remember(sessionId, savingPath, null)'))
  check('a failed save is only announced on the tab that asked for it',
    /if \(stillActive\(\)\) \{\s*setNotice/u.test(editor))
  check('tab switches are refused while a save is in flight',
    (editor.match(/if \(busy\) return/gu) ?? []).length >= 2 &&
      /disabled: busy/u.test(editor) &&
      editor.includes('[busy, rememberActive, sessionId, target]'))

  // Save results are plain text that appears beside the title: without a live
  // region a screen reader never hears "saved" or "409".
  check('the save notice is a live status region',
    /className: 'sshwsp-editor-notice'[\s\S]{0,400}?role: 'status'[\s\S]{0,400}?'aria-live': 'polite'/u.test(editor))
  check('the conflict dialog has an accessible name',
    /role: 'alertdialog'[\s\S]{0,400}?'aria-labelledby': 'sshwsp-editor-conflict-title'/u.test(editor) &&
      editor.includes("id: 'sshwsp-editor-conflict-title'"))

  // Counting a 60k-line buffer cost ~3 ms on EVERY keystroke, even when
  // CodeMirror was on screen and the number was never read.
  check('line counting is cached by buffer identity',
    /let lastLineCount = \{ text: null, count: 1 \}/u.test(editor) &&
      editor.includes('function lineCountCached (text)') &&
      editor.includes('lastLineCount.text === text'))
  check('...and the gutter is the only consumer that counts',
    editor.includes('gutterWidth(lineCountCached(state.text))') &&
      editor.includes('gutterNumbers(lineCountCached(state.text))') &&
      !editor.includes('const lines = lineCount(state.text)'))
  check('the footer reports the same cached count',
    editor.includes("t('edit.lines', { count: lineCountCached(state.text) })"))

  // The probe is the only thing standing between a preview and a pencil, and
  // for a small file it already read the whole body. Seeding the editor from it
  // is the difference between one read round trip and two.
  check('a small probe body seeds the editor instead of being read again',
    editor.includes('function takePreload (sessionId, path)') &&
      editor.includes('stashPreload(sessionId, absolutePath, reply.data?.preload)') &&
      editor.includes('const preloaded = takePreload(sessionId, target)') &&
      editor.includes('baseRevision: String(preloaded.revision'))

  // The ending badge is a control now, not decoration: the save body reads its
  // value, and the file's own ending is only the default.
  check('the ending badge is a save-policy control',
    editor.includes('value: state.eolPolicy') &&
      editor.includes("eol: state.eolPolicy === 'auto' ? 'auto' : state.eolPolicy") &&
      editor.includes("jsx('option', { value: 'LF', children: 'LF' })") &&
      editor.includes("jsx('option', { value: 'CRLF', children: 'CRLF' })"))
  check('a pending ending change counts as unsaved work',
    editor.includes('const eolDirty = state.phase === \'ready\' && state.eolPolicy !== \'auto\' && state.eolPolicy !== state.eol'))
  check('a successful save adopts the ending the server wrote',
    /eol: typeof reply\.data\.eol === 'string' \? reply\.data\.eol : current\.eol/u.test(editor) &&
      editor.includes("eolPolicy: 'auto',"))

  // A tablist is a keyboard contract (roving tabindex, arrows, aria-controls).
  // This strip never implemented one, and claiming the role while ignoring the
  // contract is worse for a keyboard user than plain buttons. It says `group`
  // and exposes the one fact that matters through `aria-current`.
  check('the tab strip does not claim tablist semantics it does not implement',
    editor.includes("className: 'sshwsp-editor-tabs', role: 'group'") &&
      !/className: 'sshwsp-editor-tabs', role: 'tablist'/u.test(editor))
  check('...and marks the open file with aria-current instead of aria-selected',
    editor.includes("'aria-current': tabPath === target ? 'true' : undefined") &&
      !/role: 'tab',\n\s+'aria-selected'/u.test(editor))
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
