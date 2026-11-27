/**
 * File viewing preferences and the conversation view that shows a file.
 *
 * The feature has three halves that can drift apart, so each is pinned where it
 * actually lives:
 *
 *  - the RULES own `{ fileView, showFiles }`, normalize a hand-edited bad value
 *    back to the defaults, and validate a POST body with the same table
 *    (`lib/hosts/preferences.js` — dependency-free, so this suite runs alone);
 *  - the STORE persists the section without disturbing the shared host file;
 *  - the CLIENT decides synchronously (`isPreviewablePath` /
 *    `filePreviewDecision`) and shows the file in its own `conversation.view`
 *    tab, which exists only while a file is open.
 *
 * The pure client helpers are lifted out of the shipped bundle and executed
 * here, the same way the tree-gesture suites drive their reducers. The rest are
 * source-level claims, and the store/rules half runs the real code.
 *
 * The route is checked as source rather than imported: `lib/routes/workspaces.js`
 * pulls the DSH peer packages, and a suite that needs the assembled host would
 * skip exactly where it is most useful.
 *
 * Run: node tests/file-preview-smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HostConfigStore } from '../lib/hosts/store.js'
import { DEFAULT_PREFERENCES, preferencesOf, preferencesPatchOf } from '../lib/hosts/preferences.js'
import { clientPartSource, clientSource } from './support/client-source.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

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

console.log('\n=== file preview smoke ===\n')

// ---------------------------------------------------------------------------
// [rules] normalization and request validation
// ---------------------------------------------------------------------------
console.log('[rules]')
{
  check('the defaults are the pre-feature behaviour',
    DEFAULT_PREFERENCES.fileView === 'sidebar' && DEFAULT_PREFERENCES.showFiles === false &&
      DEFAULT_PREFERENCES.hideComposer === true,
    JSON.stringify(DEFAULT_PREFERENCES))

  check('preferencesOf rejects an unknown mode instead of guessing',
    preferencesOf({ preferences: { fileView: 'bogus' } }).fileView === 'sidebar')
  check('preferencesOf coerces a non-boolean showFiles to false',
    preferencesOf({ preferences: { showFiles: 'yes' } }).showFiles === false &&
      preferencesOf({ preferences: { showFiles: true } }).showFiles === true)
  check('preferencesOf survives a missing or damaged section',
    preferencesOf({}).fileView === 'sidebar' && preferencesOf({ preferences: [] }).showFiles === false)
  check('a stored composer flag carries forward, and only an explicit false opts out',
    preferencesOf({ preferences: { hideComposer: false } }).hideComposer === false &&
      preferencesOf({ preferences: { hideComposer: 'no' } }).hideComposer === true &&
      preferencesOf({}).hideComposer === true)

  const valid = preferencesPatchOf({ fileView: 'conversation' })
  check('a valid one-key body is a patch', valid.ok === true && JSON.stringify(valid.patch) === '{"fileView":"conversation"}',
    JSON.stringify(valid))

  const files = preferencesPatchOf({ showFiles: true })
  check('the other key saves on its own',
    files.ok === true && files.patch.showFiles === true && files.patch.fileView === undefined,
    JSON.stringify(files))

  const unknown = preferencesPatchOf({ autoStart: true })
  check('an unknown key is refused, not silently ignored',
    unknown.ok === false && /unknown preference: autoStart/.test(unknown.error), JSON.stringify(unknown))

  const composer = preferencesPatchOf({ hideComposer: false })
  check('the composer switch saves on its own',
    composer.ok === true && composer.patch.hideComposer === false && composer.patch.fileView === undefined,
    JSON.stringify(composer))
  check('a non-boolean hideComposer is refused',
    preferencesPatchOf({ hideComposer: 'true' }).ok === false)

  const badMode = preferencesPatchOf({ fileView: 'neither' })
  check('a mode outside the two known ones is refused',
    badMode.ok === false && /fileView must be/.test(badMode.error), JSON.stringify(badMode))

  const badFiles = preferencesPatchOf({ showFiles: 'true' })
  check('a non-boolean showFiles is refused',
    badFiles.ok === false && /showFiles must be a boolean/.test(badFiles.error), JSON.stringify(badFiles))

  check('a non-object body is refused',
    preferencesPatchOf(null).ok === false && preferencesPatchOf(['fileView']).ok === false)
}

// ---------------------------------------------------------------------------
// [store] the preferences section
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(path.join(os.tmpdir(), 'sshwsp-filepreview-'))
const storePath = path.join(scratch, 'dsh-ssh.json')
const store = new HostConfigStore(storePath)

console.log('\n[store]')
{
  check('the store starts from the same defaults',
    JSON.stringify(store.preferences()) === JSON.stringify(DEFAULT_PREFERENCES),
    JSON.stringify(store.preferences()))

  const saved = store.setPreferences({ fileView: 'conversation' })
  check('a save returns the normalized section', saved.fileView === 'conversation' && saved.hideComposer === true &&
    saved.showFiles === false,
    JSON.stringify(saved))

  const reopened = new HostConfigStore(storePath)
  check('the value survives a new store instance', reopened.preferences().fileView === 'conversation',
    JSON.stringify(reopened.preferences()))

  reopened.setPreferences({ showFiles: true })
  check('a partial save keeps the other key',
    reopened.preferences().fileView === 'conversation' &&
      reopened.preferences().showFiles === true,
    JSON.stringify(reopened.preferences()))

  reopened.setPreferences({ fileView: 'bogus' })
  check('a bogus value written through the store lands on the default, not on a third mode',
    reopened.preferences().fileView === 'sidebar', JSON.stringify(reopened.preferences()))

  // The document is shared with DSH's own SSH tooling: writing our section must
  // not drop unknown top-level fields.
  const document = JSON.parse(readFileSync(storePath, 'utf8'))
  document.announceToAgent = true
  writeFileSync(storePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  reopened.setPreferences({ fileView: 'conversation' })
  const after = JSON.parse(readFileSync(storePath, 'utf8'))
  check('a save keeps unknown top-level fields', after.announceToAgent === true, JSON.stringify(after))
  check('...and writes the section it was asked for', after.preferences.fileView === 'conversation' && after.preferences.showFiles === true,
    JSON.stringify(after.preferences))
}

// ---------------------------------------------------------------------------
// [route] the write half and the /status read
// ---------------------------------------------------------------------------
console.log('\n[route]')
{
  const routesSource = readFileSync(path.join(pluginRoot, 'lib', 'routes', 'routes.js'), 'utf8')
  check('ROUTES.preferences names the API path',
    routesSource.includes("preferences: '/api/dsh-ssh-workspace/preferences'"),
    'the client API table and the server table must agree on the path')

  const source = readFileSync(path.join(pluginRoot, 'lib', 'routes', 'workspaces.js'), 'utf8')
  check('the preferences route is registered', /path: ROUTES\.preferences/u.test(source))
  check('the POST validates with the shared rules', /preferencesPatchOf\(body\)/u.test(source),
    'a second validation table would drift from the store\'s normalization')
  check('the POST refuses before writing', /if \(verdict\.ok !== true\)/u.test(source) && /writeJson\(res, 400/u.test(source),
    'a refused body must not reach the store')
  check('the POST is the only writer', /store\.setPreferences\(verdict\.patch\)/u.test(source))
  check('/status publishes the section the route writes',
    /\.\.\.\(preferences === undefined \? \{\} : \{ preferences \}\)/u.test(source), 'status reply has no preferences field')
  check('/status reads the section once, not per use',
    /const preferences = preferencesOfStore\(engine\)/u.test(source),
    'the accessor reads the store; calling it twice in one reply reads it twice')
  check('/status and the POST route share one accessor',
    /function preferencesOfStore \(engine\)/u.test(source), 'two accessors would drift')
}

// ---------------------------------------------------------------------------
// [client] the pure decision, lifted from the shipped bundle
// ---------------------------------------------------------------------------
console.log('\n[client decision]')

let helpers
try {
  const text = clientPartSource(pluginRoot, 'client.js')
  const start = text.indexOf('    /**\n     * The extension whitelist the file view will show.')
  const end = text.indexOf('    /** The cached viewing preferences', start)
  const decisionStart = text.indexOf('    function filePreviewDecision', start)
  const decisionEnd = text.indexOf('    /** Open one file in its own conversation tab', decisionStart)
  if (start < 0 || end < 0 || decisionStart < 0 || decisionEnd < 0) {
    throw new Error('the preview helpers are not where the map says they are')
  }
  helpers = new Function(`${text.slice(start, end)}\n${text.slice(decisionStart, decisionEnd)}\nreturn { previewNameOf, isPreviewablePath, filePreviewDecision }`)()
} catch (error) {
  console.log(`  FAIL  the preview helpers are liftable — ${error.message}`)
  process.exit(1)
}

{
  const { previewNameOf, isPreviewablePath, filePreviewDecision } = helpers
  check('the preview name reads the last path segment', previewNameOf('ssh://box/home/me/a.ts') === 'a.ts',
    previewNameOf('ssh://box/home/me/a.ts'))
  check('a Windows path is read too', previewNameOf('F:\\repo\\src\\a.py') === 'a.py',
    previewNameOf('F:\\repo\\src\\a.py'))

  check('a source file is previewable', isPreviewablePath('a.ts') === true)
  check('a remote path is previewable', isPreviewablePath('ssh://box/home/me/a.py') === true)
  check('Markdown is shown by the file view too', isPreviewablePath('README.md') === true &&
    isPreviewablePath('notes.markdown') === true && isPreviewablePath('page.mdx') === true)
  check('an extensionless README is treated as the Markdown it is', isPreviewablePath('README') === true)
  check('an image keeps the host preview', isPreviewablePath('logo.png') === false)
  check('a binary keeps the host preview', isPreviewablePath('a.bin') === false)
  check('a name without a dot is judged by the name list', isPreviewablePath('Dockerfile') === true && isPreviewablePath('notes') === false)
  check('an empty path is never claimed', isPreviewablePath('') === false && isPreviewablePath(undefined) === false)

  check('sidebar mode leaves every click to the host',
    filePreviewDecision({ path: 'a.ts', kind: 'file', fileView: 'sidebar' }) === 'host')
  check('conversation mode claims a plain file click',
    filePreviewDecision({ path: 'a.ts', kind: 'file', fileView: 'conversation' }) === 'pane')
  check('a directory is never claimed',
    filePreviewDecision({ path: 'src', kind: 'directory', fileView: 'conversation' }) === 'host')
  check('Ctrl/Cmd+click keeps the host preview (the documented escape)',
    filePreviewDecision({ path: 'a.ts', kind: 'file', ctrl: true, fileView: 'conversation' }) === 'host')
  check('Shift+click keeps its selection meaning',
    filePreviewDecision({ path: 'a.ts', kind: 'file', shift: true, fileView: 'conversation' }) === 'host')
  check('a Markdown file is claimed in conversation mode, like any other text',
    filePreviewDecision({ path: 'README.md', kind: 'file', fileView: 'conversation' }) === 'pane')
}

// ---------------------------------------------------------------------------
// [client wiring] the conversation tab, the close gestures and the claim gate
// ---------------------------------------------------------------------------
console.log('\n[client wiring]')
{
  const client = clientSource(pluginRoot)
  const panel = clientPartSource(pluginRoot, 'client.panel.js')

  check('the file tabs register into conversation.view',
    client.includes("name: 'conversation.view'") && client.includes('function fileTabIdOf') &&
      client.includes("slots.inject('conversation.view'"),
    'the host seat is not used, or the registration has no seat lifetime')
  check('one registration is one file — the id and the label come from the path',
    /registerFileTab = \(path\) => slots\.register/u.test(client) &&
      /id: fileTabIdOf\(path\)/u.test(client) &&
      /label: \(\) => fileTabName\(path\)/u.test(client),
    'a single shared tab would show whichever file was opened last')
  check('each tab injects its own path, so two same-named files stay apart',
    /inject: \(sessionId\) => \(\{ t: translate, filePath: path, sessionId \}\)/u.test(client),
    'a component that reads the path off the DOM cannot tell two `index.ts` apart')
  check('the tabs are registered lazily, one per opened file',
    /function ensureFileTab \(path\)/u.test(client) &&
      /if \(!ensureFileTab\(path\)\) return false/u.test(client) &&
      /if \(openFileTabs\.has\(path\)\) return true/u.test(client),
    'registering at apply time would put a file tab in every conversation, and a second click would duplicate it')
  check('closing one file disposes exactly that registration',
    /openFileTabs\.delete\(path\)/u.test(client) && /try \{ dispose\(\) \}/u.test(client) &&
      /if \(openFileTabs\.size === 0\)/u.test(client),
    'a closed tab must leave the strip, and the last close must leave no observer behind')
  check('opening a file switches the conversation to that tab',
    /function activateFileTab/u.test(client) && client.includes("clickNthByText('[role=\"tab\"]'") &&
      client.includes("document.querySelector('[data-conversation-tabs]')"),
    'the tab would open without ever being shown')
  check('two tabs with the same file name are told apart by registration order',
    /function clickNthByText/u.test(client) && /\.filter\(open => fileTabName\(open\) === label\)/u.test(client),
    'clicking the first `index.ts` would focus the other one')
  check('the tab carries a close affordance of its own',
    /data-sshwsp-tab-close/u.test(client) && /new MutationObserver\(decorate\)/u.test(client) &&
      /preview\.tabClose/u.test(client),
    'a file tab that can only be closed from inside the file view is a trap once several are open')
  check('the × stays on the name\'s line, pinned right, under a fixed tab width',
    /const FILE_TAB_WIDTH = 132/u.test(client) && /const FILE_TAB_CLOSE_ROOM = 22/u.test(client) &&
      /position: 'absolute'/u.test(client) && /right: '4px'/u.test(client) &&
      /flex: `0 0 \$\{FILE_TAB_WIDTH\}px`/u.test(client) && /paddingRight: `\$\{FILE_TAB_CLOSE_ROOM\}px`/u.test(client),
    'an inline × wraps under a long name and makes the whole tab row a line taller')
  check('closing the last tab returns the session to the conversation',
    /openView\('chat', ''\)/u.test(client),
    'the strip would keep naming a view that no longer resolves')
  check('closing one of several tabs lands on a tab that still exists',
    /const remaining = \[\.\.\.openFileTabs\.keys\(\)\]/u.test(client) &&
      /const next = remaining\.length > 0 \? remaining\[remaining\.length - 1\] : null/u.test(client) &&
      /activateFileTab\(next\)/u.test(client),
    'closing the active file while another stays open must not dump the whole row of files for Chat')
  check('the close path only leaves the strip when nothing file-shaped is left',
    client.indexOf('if (next === null) openView(\'chat\', \'\')') > 0,
    'Chat must be the absence of a file tab, not the first thing every close does')
  check('a click is only claimed when the tab could be created',
    /decision === 'pane' && openFilePreview\(/u.test(client) &&
      (client.match(/decision === 'pane' && openFilePreview\(/gu) ?? []).length === 2,
    'claiming a click the view cannot show turns "open this file" into nothing')
  check('the file view reuses the plugin editor, not a second reader',
    client.includes("require.async('./client.editor.js')") && client.includes('ConversationFileEditor') &&
      /surface: 'conversation'/u.test(client) && !/sshwsp-filepane-text/u.test(client),
    'a read-only <pre> would drop editing, highlighting and the save path')
  check('the view renders the editor inline, not as an overlay',
    /inline: true/u.test(client) && /sshwsp-editor-panel-inline/u.test(clientSource(pluginRoot)) &&
      /return inline \? shell : modalLayer\(shell\)/u.test(clientPartSource(pluginRoot, 'client.editor.js')),
    'a fixed, measured box on top of the host DOM is what read as a layer over the conversation')
  check('the inline panel drops the header and close button the tab already owns',
    /!inline \|\| dirty \|\| notice !== ''/u.test(clientPartSource(pluginRoot, 'client.editor.js')) &&
      /inline \? null : jsx\('span', \{ className: 'sshwsp-editor-title'/u.test(clientPartSource(pluginRoot, 'client.editor.js')),
    'a repeated path line and a second × inside the tab is the overlay look in miniature')
  check('the editor chunk the view reuses saves through the plugin write route',
    /loaded\.FileEditorPanel/u.test(client) &&
      /API\.writeText/u.test(clientSource(pluginRoot)) &&
      /expected: tokens/u.test(clientSource(pluginRoot)),
    'the view editor must carry the same double-token write path as the sidebar')
  check('Esc closes too', /event\.key !== 'Escape'/u.test(client) && /closeFilePreview\(filePath, sessionId\)/u.test(client),
    'the keyboard half must not depend on focus staying inside the view')
  check('the view asks before dropping unsaved text',
    /t\('edit\.unsavedPrompt'\)/u.test(client) && /onDirtyChange/u.test(client) &&
      /isFileDirty\(sessionId, filePath\)/u.test(client) && /setFileDirty\(sessionId, filePath/u.test(client),
    'a × or Esc that discards typing is worse than one that refuses to close')
  check('Esc does not steal a modal dialog\'s key',
    /\[role="dialog"\]\[aria-modal="true"\]/u.test(client), 'Escape would close the view behind an open dialog')
  check('Esc inside the editor is left to the editor',
    /activeElement\.closest\('\.sshwsp-editor-panel'\)/u.test(client),
    'the editor owns its own Escape (find bar first), so the view must not double-handle it')
  check('the composer is hidden only while a file view is open, and only when asked',
    /function applyComposerHiding/u.test(client) &&
      /const hide = mountedFileViews > 0 && fileViewPreferences\.hideComposer === true/u.test(client) &&
      /data-sshwsp-composer-off/u.test(clientSource(pluginRoot)) &&
      /\[data-sshwsp-composer-off\] \{ display: none !important; \}/u.test(clientSource(pluginRoot)),
    'the composer is a seat under the view area, so a file tab sits above it unless the seat is hidden')
  check('the composer is re-decided when the setting changes, not only at mount',
    /applyPreferences/u.test(client) && /await saveFileViewPreference/.test(panel) === false &&
      /applyComposerHiding\(\)/u.test(client),
    'flipping the checkbox while a file is open must take effect immediately')
  check('closing the file view puts the composer back',
    /mountedFileViews = Math\.max\(0, mountedFileViews - 1\)[\s\S]{0,120}applyComposerHiding\(\)/u.test(client),
    'a hidden composer that never comes back is a lost input box')
  check('switching back to the right-hand preview drops the open files',
    /if \(settings\.fileView === 'sidebar' && openFileTabs\.size > 0\) closeEveryFileTab\(\)/u.test(client),
    'the tab would keep a file nobody asked to keep')

  check('the panel publishes a saved value to the bridge',
    panel.includes('applyPreferences(result.preferences)'), 'a save that never reaches the bridge leaves the click stale')
  check('the panel applies every /status reply',
    panel.includes('applyPreferences(statusData?.preferences)'), 'a hand-edited value would only apply after a reload')
  check('the setting row is a two-state switch, not a checkbox',
    /role: 'radiogroup'/u.test(panel) && /role: 'radio'/u.test(panel) && panel.includes('sshwsp-seg-btn-on'),
    'a single box cannot express "right-hand tree" as the other answer')
  check('the settings pane offers the composer switch beside the file-view target',
    panel.includes('fileview.hideComposer') && panel.includes("hideComposer: event.target.checked") &&
      panel.includes("status.preferences?.hideComposer !== false"),
    'the composer stays on screen under a file tab, so there has to be a way to hide it')
  check('the save goes through the POST route', panel.includes('API.preferences'),
    'the panel must not write the store through another door')
  check('the save failure is reported, not swallowed',
    panel.includes("toastError(t('fileview.saveFail')"), 'a refused save would look like a successful one')
  check('both locales define the new strings',
    [...client.matchAll(/'fileview\.group': '([^']*)'/g)].length === 2 &&
    [...client.matchAll(/'preview\.tabClose': '([^']*)'/g)].length === 2 &&
    [...client.matchAll(/'fileview\.hint': '([^']*)'/g)].length === 2 &&
    [...client.matchAll(/'preview\.empty': '([^']*)'/g)].length === 0 &&
    [...client.matchAll(/'preview\.tabLabel': '([^']*)'/g)].length === 0,
    'a missing key renders as a raw namespace path')

  // ---- show files (the directory pickers) ----
  // One preference, two consumers: the panel row that saves it and the pickers
  // that read it at listing time. Pinning both sides here keeps a saved value
  // from silently meaning nothing.
  check('the panel exposes a show-files row wired to the same save path',
    /status\.preferences\?\.showFiles === true/u.test(panel) &&
      /saveFileViewPreference\(\{ showFiles: event\.target\.checked \}\)/u.test(panel),
    'the option has no control, or it writes somewhere else')
  check('the pickers read the preference when they list',
    /function pickerShowsFiles \(\)/u.test(client) &&
      /pickerShowsFiles\(\) \? '' : '&dirs=1'/u.test(client) &&
      [...client.matchAll(/pickerShowsFiles\(\) \? '' : '&dirs=1'/g)].length === 2,
    'a picker no longer consults the preference, or only one of the two does')
  check('the panel reloads the saved value into the pickers',
    /showFiles: next\?\.showFiles === true/u.test(client),
    'the normalized snapshot drops the new key, so a save never reaches the pickers')

  // ---- the bundle / kernel contract ----
  // `loadBootChunks()` destructures the kernel into the bundle's locals. A name
  // the kernel defines but never exports arrives as `undefined` without any
  // error until something calls it: the directory pickers reported
  // "sortPickerEntries is not a function" from a listing that has nothing to do
  // with that helper. Assert the whole list, not just the two names that broke.
  const kernel = readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.kernel.js'), 'utf8')
  const bootBody = /async function loadBootChunks \(\) \{([\s\S]*?)\n    \}/u.exec(client)?.[1] ?? ''
  const kernelNames = (/\(\{([\s\S]*?)\} = kernel\)/u.exec(bootBody)?.[1] ?? '')
    .split(',')
    .map(piece => piece.trim().split(':').pop()?.trim() ?? '')
    .filter(name => /^[A-Za-z_$][\w$]*$/u.test(name))
  const kernelExports = new Set()
  for (const match of kernel.matchAll(/Object\.assign\(exports, \{([\s\S]*?)\n    \}\)/gu)) {
    for (const line of match[1].split('\n')) {
      const name = line.replace(/\/\/.*$/u, '').trim().replace(/,$/u, '')
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) kernelExports.add(name)
    }
  }
  const unexported = kernelNames.filter(name => !kernelExports.has(name))
  check('every name the bundle takes from the kernel is exported by it',
    kernelNames.length > 0 && unexported.length === 0,
    `destructured from the kernel but absent from its exports block: ${unexported.join(', ')}`)

  // A view fills the conversation area, so its one geometry claim is that it
  // takes the whole height instead of a share above the composer.
  check('the file view fills the conversation area',
    /\.sshwsp-filepane \{[^}]*height: 100%/u.test(client), 'a capped pane would leave the transcript half visible')
  // The view owns no geometry of its own any more: it sits in the host's flow,
  // and the only number it measures is the height its footer must not leave.
  const paneSource = clientPartSource(pluginRoot, 'client.js')
    .slice(clientPartSource(pluginRoot, 'client.js').indexOf('function useFilePaneHeight'))
  check('the file view is laid out in flow, not measured into place',
    /\.sshwsp-editor-panel-inline \{[^}]*position: relative/u.test(clientSource(pluginRoot)) &&
      !/style\.(left|top|width) /u.test(paneSource) &&
      !/position: 'fixed'/u.test(paneSource),
    'a fixed, measured box is exactly what made the view look like a layer over the conversation')
  // The pane takes the scrollport's height instead of growing with its content:
  // the host lets a view grow, and a growing view drags this footer into the
  // transcript's scroller.
  check('the pane takes the scrollport height, so its footer cannot scroll away',
    /function useFilePaneHeight/u.test(client) &&
      client.includes("closest('[data-conversation-scroll]')") &&
      client.includes("querySelector('[data-composer-seat]')") &&
      client.includes("querySelector('[data-composer-card]')") &&
      /const height = Math\.max\(180, Math\.round\(Math\.min\(scroller\.clientHeight, limit - top\)\)\)/u.test(client) &&
      /node\.style\.height = `\$\{height\}px`/u.test(client) &&
      /observe\(scroller\)/u.test(client),
    'a pane sized by its content scrolls the status bar with the transcript, and a pane that ignores the composer runs under it')
  check('showing or hiding the composer re-measures the pane',
    /let remeasureFilePanes = null/u.test(client) &&
      /remeasureFilePanes = schedule/u.test(client) &&
      /if \(typeof remeasureFilePanes === 'function'\) remeasureFilePanes\(\)/u.test(client),
    'hiding the composer does not resize the scrollport, so nothing else would trigger a re-measure')
  check('the composer seat is found by the host landmark before any layout guess',
    /card\.closest\('\[data-composer-seat\]'\)/u.test(client),
    'a seat whose stickiness moves to another wrapper would stop being hidden')
  // A conversation.view registration is plugin-wide, but the strip is per
  // Session: without a roster, a file opened in one Session follows the user
  // into every other one.
  check('the open files belong to a session, not to the plugin',
    /const sessionOpenFiles = new Map\(\)/u.test(client) &&
      /function adoptSession \(sessionId\)/u.test(client) &&
      /for \(const path of sessionOpenFiles\.get\(sessionId\) \?\? \[\]\) ensureFileTab\(path\)/u.test(client),
    'a plugin-wide registration would put one session\'s files in every session\'s strip')
  check('leaving a session disposes its tabs without forgetting them',
    /registeredSessionId = sessionId/u.test(client) &&
      /openFileTabs\.delete\(path\)/u.test(client) &&
      !/adoptSession[\s\S]{0,400}?sessionOpenFiles\.delete/u.test(client),
    'switching away must not close the files: switching back has to show them again')
  check('the session landmark is watched, not polled',
    /function watchConversationSession/u.test(client) &&
      /attributeFilter: \['data-conversation-session'\]/u.test(client) &&
      /const stopSessionWatch = watchConversationSession\(\)/u.test(client),
    'a view registration cannot be scoped by the host, so the roster has to follow the open session')
  // Switching workspace does not only swap the attribute: it can rebuild the
  // whole conversation shell, and then the landmark arrives inside a new
  // subtree, which an attribute-only observer never sees.
  check('a rebuilt conversation shell is noticed too, and coalesced to one pass per frame',
    /function watchConversationSession[\s\S]{0,2200}?childList: true[\s\S]{0,120}?subtree: true/u.test(client) &&
      /function watchConversationSession[\s\S]{0,1200}?if \(frame !== 0\) return[\s\S]{0,160}?requestAnimationFrame\(run\)/u.test(client),
    'the tabs of the session you come back to would never be re-registered')
  check('the landmark is cached, so a quiet conversation costs one attribute read',
    /let cachedSessionRoot = null/u.test(client) &&
      /cachedSessionRoot !== null && cachedSessionRoot\.isConnected === true/u.test(client) &&
      /cachedSessionRoot = root \?\? null/u.test(client),
    'a document-wide query on every conversation mutation is a scan, not a check')
  check('with nothing open anywhere, the watcher does not even look',
    /function syncSessionTabs[\s\S]{0,300}?if \(sessionOpenFiles\.size === 0 && openFileTabs\.size === 0\) return/u.test(client),
    'an idle plugin should not pay for the child-list pass')
  check('a rebuilt conversation root still lands on the right session',
    /function decorateFileTabs[\s\S]{0,1200}?syncSessionTabs\(\)/u.test(client),
    'an attribute observer never sees a landmark that arrives inside a new subtree')
  check('one close removes the file from every session that had it open',
    /forgetSessionFile\(path\)/u.test(client) && /function forgetSessionFile \(path\)/u.test(client),
    'a file closed from another session would come back the next time that session is visited')
  // A workspace switch can re-declare the view seat, which disposes every entry
  // registered inside it. Dropping the handles is unavoidable; dropping the
  // roster is what would lose the files for good.
  check('a re-declared seat drops the handles but keeps the roster',
    /function deregisterFileTabs/u.test(client) &&
      (() => {
        const body = /function deregisterFileTabs \(\) \{[\s\S]*?\n    \}/u.exec(client)?.[0] ?? ''
        return body.includes('openFileTabs.clear()') &&
          body.includes("registeredSessionId = ''") &&
          !body.includes('sessionOpenFiles.clear()')
      })() &&
      /function closeEveryFileTab[\s\S]{0,260}?sessionOpenFiles\.clear\(\)/u.test(client) &&
      /const stopSessionWatch = watchConversationSession\(\)[\s\S]{0,600}?deregisterFileTabs\(\)/u.test(client),
    'the host owns the entries, so a new seat has to be able to put the same files back')
  check('the two surfaces have separate panel ownership',
    /\$\{sessionId\}\\u0000\$\{surface\}/u.test(clientSource(pluginRoot)) &&
      /surface = 'preview'/u.test(clientSource(pluginRoot)),
    'opening a conversation file would close an editor already on screen in the sidebar')

  // The seat's render props are not promised to carry the session, and the host
  // reads the active session off its own body landmark — the same fallback.
  check('the session is read from the host landmark when props omit it',
    client.includes("closest('[data-conversation-session]')") &&
      client.includes("getAttribute('data-conversation-session')"),
    'a seat that passes no sessionId would render every tab empty')
}

rmSync(scratch, { recursive: true, force: true })

console.log(`\n=== file preview smoke: ${passed} passed, ${failures.length} failed ===\n`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
