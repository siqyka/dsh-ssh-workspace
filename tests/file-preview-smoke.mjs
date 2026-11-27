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
  const end = text.indexOf('    /**\n     * Whether the directory pickers list files as read-only context rows.', start)
  const decisionStart = text.indexOf('    function filePreviewDecision', start)
  const decisionEnd = text.indexOf('    /**\n     * Fetch and install the chunk', decisionStart)
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
  // The claim follows the VIEWER, not the text whitelist: a file the plugin can
  // paint without reading it as text must not fall through to the host.
  for (const path of ['logo.png', 'shot.JPEG', 'icon.svg', 'clip.mp4', 'song.mp3', 'manual.pdf']) {
    check('conversation mode claims ' + path,
      filePreviewDecision({ path, kind: 'file', fileView: 'conversation' }) === 'pane')
  }
  for (const path of ['archive.zip', 'a.bin', 'firmware.img']) {
    check('an unknown binary keeps the host preview: ' + path,
      filePreviewDecision({ path, kind: 'file', fileView: 'conversation' }) === 'host')
  }
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
  {
    // The host sorts `conversation.view` by this number (Chat 0, Trajectory 10,
    // Stats 40), and an entry without one sorts as 0 — which put the file tab
    // between "对话" and "轨迹". A file is an aside, so it must sort last.
    const declared = /const FILE_TAB_ORDER = (\d+)/u.exec(client)
    const used = /order: FILE_TAB_ORDER,/u.test(client)
    check('a file tab sorts after every built-in view',
      declared !== null && used && Number(declared[1]) > 40,
      'without an order above the built-ins the host files the tab among the primary views')
  }
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
    'the marker is the primary handle; the n-th same-name tab is the pre-decoration fallback')
  check('the tab carries a close affordance of its own',
    /data-sshwsp-tab-close/u.test(client) && /new MutationObserver\(decorate\)/u.test(client) &&
      /preview\.tabClose/u.test(client),
    'a file tab that can only be closed from inside the file view is a trap once several are open')
  check('the × stays on the name\'s line, pinned right, above a capped tab width',
    /const FILE_TAB_MAX_WIDTH = 200/u.test(client) && /const FILE_TAB_CLOSE_ROOM = 22/u.test(client) &&
      /position: 'absolute'/u.test(client) && /right: '4px'/u.test(client) &&
      /flex: '0 1 auto'/u.test(client) && /maxWidth: `\$\{FILE_TAB_MAX_WIDTH\}px`/u.test(client) && /paddingRight: `\$\{FILE_TAB_CLOSE_ROOM\}px`/u.test(client),
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
    /decision === 'pane' && \(fileView\?\.open\(/u.test(client) &&
      (client.match(/decision === 'pane' && \(fileView\?\.open\(/gu) ?? []).length === 2,
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

// ---------------------------------------------------------------------------
// [viewers] what each kind of file opens as
// ---------------------------------------------------------------------------
console.log('\n[viewers]')
{
  const bundle = clientPartSource(pluginRoot, 'client.js')
  const lift = (marker, next) => {
    const start = bundle.indexOf(marker)
    const end = bundle.indexOf(next, start)
    if (start < 0 || end < 0) throw new Error('cannot lift ' + marker)
    return bundle.slice(start, end)
  }
  // The binary table has to travel WITH the classifier: it is the only name
  // list left, and an 'unknown' verdict is meaningless without it.
  const source = lift('const VIEWER_FAMILIES', 'function viewerOf') +
    lift('const PREVIEW_BINARY_EXTENSIONS', '    /**') +
    lift('function viewerOf', '    /**\n     * Whether the directory pickers')
  const previewNameOf = (path) => String(path ?? '').split(/[\\/]/u).pop().toLowerCase()
  const isPreviewablePath = (path) => /\.(?:txt|json|ts|cts|bat)$/u.test(String(path ?? '').toLowerCase())
  const factory = new Function('previewNameOf', 'isPreviewablePath', source + '\nreturn viewerOf')
  const viewerOf = factory(previewNameOf, isPreviewablePath)
  const table = [
    ['/repo/README.md', 'markdown'],
    ['/repo/doc.markdown', 'markdown'],
    ['/repo/index.html', 'html'],
    ['/repo/page.htm', 'html'],
    ['/repo/logo.PNG', 'image'],
    ['/repo/clip.mp4', 'video'],
    ['/repo/song.mp3', 'audio'],
    ['/repo/manual.pdf', 'pdf'],
    ['/repo/config.json', 'text'],
    ['/repo/archive.zip', 'binary'],
    ['/repo/tsconfig.cts', 'text'],
    ['/repo/build.bat', 'text'],
    // Neither text-by-name nor binary-by-name: the bytes decide, so the name
    // alone must not send it to the host's preview.
    ['/repo/LICENSE-APACHE', 'unknown'],
    ['/repo/script', 'unknown'],
  ]
  for (const [path, kind] of table) {
    check(path + ' opens as ' + kind, viewerOf(path) === kind)
  }
  check('the pane borrows the table instead of copying it',
    /const \{ isPreviewablePath, isDocumentPath, previewNameOf, fileTabName, fileTabIdOf, viewerOf, aliasOfSession \} = host/u
      .test(clientPartSource(pluginRoot, 'client.fileview.js')) &&
      /\n        viewerOf,\n/u.test(bundle) &&
      /\n        aliasOfSession: /u.test(bundle),
    'two tables would drift')
  check('opening a file uses the same gate as the claim',
    /const viewer = viewerOf\(path\)\n      if \(viewer === 'binary'\) return false/u.test(clientPartSource(pluginRoot, 'client.fileview.js')) &&
      !/if \(!isPreviewablePath\(path\)\) return false/u.test(clientPartSource(pluginRoot, 'client.fileview.js')),
    'claiming the click and then declining it sends media back to the host after the navigation was prevented')
}

// ---------------------------------------------------------------------------
// [byte route] ranges and real media types
// ---------------------------------------------------------------------------
const load = (rel) => import(new URL('../' + rel, import.meta.url).href)
const ROOT = pluginRoot
console.log('\n[byte route]')
{
  const range = await load('lib/routes/byte-range.js')
  check('a png is served as an image, not octet-stream',
    range.mediaTypeOfPath('a/b/c.png') === 'image/png' && range.mediaTypeOfPath('x.mp4') === 'video/mp4' &&
      range.mediaTypeOfPath('x.pdf') === 'application/pdf')
  check('an unknown suffix stays octet-stream', range.mediaTypeOfPath('x.bin') === 'application/octet-stream')
  const window = range.parseByteRange('bytes=10-19', 100)
  check('one range window is parsed', window !== null && window.start === 10 && window.end === 19)
  const openEnded = range.parseByteRange('bytes=90-', 100)
  check('an open-ended range reaches the end', openEnded.start === 90 && openEnded.end === 99)
  const suffix = range.parseByteRange('bytes=-10', 100)
  check('a suffix range counts from the end', suffix.start === 90 && suffix.end === 99)
  check('no header means no range', range.parseByteRange(undefined, 100) === null)
  check('a start past the end is refused', range.parseByteRange('bytes=200-300', 100) === 'invalid')
  check('a reversed window is refused', range.parseByteRange('bytes=20-10', 100) === 'invalid')
  check('multi-range is refused rather than half-served', range.parseByteRange('bytes=0-1,5-6', 100) === 'invalid')
}

// ---------------------------------------------------------------------------
// [html view] relative references become byte-route URLs
// ---------------------------------------------------------------------------
console.log('\n[html view]')
{
  const rewrite = await load('lib/routes/html-rewrite.js')
  const byteUrl = (target) => 'byte:' + target
  const html = '<link href="./style.css"><img src="../img/a.png"><a href="#top">t</a>' +
    '<script src="/app.js"></script><div style="background: url(bg.png)"></div>' +
    '<a href="https://example.com/x">x</a>'
  const out = rewrite.rewriteHtmlReferences(html, '/site/docs/page.html', byteUrl)
  check('a sibling stylesheet is resolved against the document', out.includes('href="byte:/site/docs/style.css"'))
  check('a parent-relative image is resolved too', out.includes('src="byte:/site/img/a.png"'))
  check('a root-relative script is resolved against the remote root', out.includes('src="byte:/app.js"'))
  check('an inline url() is resolved', out.includes('url(byte:/site/docs/bg.png)'))
  check('a fragment is left alone', out.includes('href="#top"'))
  check('an absolute URL is left alone', out.includes('href="https://example.com/x"'))
  const route = readFileSync(path.join(ROOT, 'lib/routes/view.js'), 'utf8')
  check('the route refuses documents past its window', /HTML_TOO_LARGE/u.test(route))
  check('the route serves html with an explicit type', /text\/html; charset=utf-8/u.test(route))
}

// ---------------------------------------------------------------------------
// [renderer] the document pane renders with the plugin's own styled renderer
// ---------------------------------------------------------------------------
console.log('\n[renderer]')
{
  const chunk = clientPartSource(pluginRoot, 'client.fileview.js')
  check('the host MarkdownText is NOT borrowed',
    !chunk.includes("require('@deepseek-ai/dsh-client-ui-primitives')"),
    'its look comes from CSS modules a plugin chunk cannot import: rendered output is unstyled')
  check('the document goes through the plugin renderer',
    /jsx\(Document, \{ text: state\.text, t, imgSrc: imageResolverFor\(path, sessionId\) \}\)/u.test(chunk),
    'the only renderer that carries the plugin stylesheet')
  check('a document image is routed through the byte route',
    /byteUrlOf\(API\.download, absolute, sessionId/u.test(chunk) &&
      /function resolveRelativePath/u.test(chunk) &&
      /function imageResolverFor/u.test(chunk),
    'a remote <img src> has no local file to point at')
  check('the pane carries its own close button',
    /className: 'sshwsp-filepane-head'/u.test(chunk) &&
      /className: 'sshwsp-filepane-close'/u.test(chunk) &&
      /closeFilePreview\(filePath, sessionId\)/u.test(chunk),
    'a tab collapsed into the overflow menu has no × on the strip, so the pane needs one')
  check('fenced code is toned, not flat',
    /sshwsp-md-tok-\$\{run\.kind\}/u.test(clientPartSource(pluginRoot, 'client.markdown.js')) &&
      /sshwsp-md-tok-comment/u.test(clientPartSource(pluginRoot, 'client.styles.js')),
    'the host preview colours code; a flat grey block is the thing being compared')
  check('an unresolvable image keeps the placeholder path',
    /typeof src !== 'string' \|\| src === ''/u.test(clientPartSource(pluginRoot, 'client.markdown.js')),
    'an unknown alias must not become src="" (which looks like a broken image)')
  const styles = clientPartSource(pluginRoot, 'client.styles.js')
  check('the pane carries the token class, not only a scope selector',
    /className: 'sshwsp-filepane sshwsp-tokens'/u.test(chunk) && /\.sshwsp-tokens,\n/u.test(styles),
    'a class that carries the token definitions works anywhere; a scope selector depends on an ancestor')
  check('the file pane defines the token scope it renders in',
    /\.sshwsp,\n\.sshwsp-filepane,/u.test(styles) &&
      /body:not\(\[data-ds-dark-theme\]\) \.sshwsp-filepane,/u.test(styles),
    'the pane renders OUTSIDE .sshwsp; without the scope every var(--sshwsp-*) is empty and borders/backgrounds vanish')
  check('the document body takes the token text colour, not the host default',
    /\.sshwsp-md \{ max-width: 1240px;[^}]*color: var\(--sshwsp-text\)/u.test(styles),
    'unstyled-looking text is the symptom of an unresolved token')
  check('source and preview share one column',
    /\.sshwsp-filepane-body \.sshwsp-editor-panel-inline \{[^}]*max-width: 1284px;[^}]*margin: 0 auto;/u.test(styles) &&
      /\.sshwsp-md \{ max-width: 1240px/u.test(styles),
    '1240px of text plus 22px of side padding on each side: the buffer must not be full-bleed next to a centred document')
  check('the mode buttons end on the text edge',
    (() => {
      const rule = /\.sshwsp-filepane-bar \{([^}]*)\}/u.exec(styles)
      if (rule === null) return false
      return rule[1].includes('max-width: 1284px') &&
        rule[1].includes('justify-content: flex-end') &&
        rule[1].includes('padding: 6px 22px 4px') &&
        rule[1].includes('margin: 0 auto')
    })(),
    'a bar pinned to the pane edge puts the buttons past the text column; the 22px must match the docpane padding')
}

// [media] byte viewers need an alias, and failures name the reason
console.log('\n[media]')
{
  const chunk = clientPartSource(pluginRoot, 'client.fileview.js')
  check('a local workspace keeps its media',
    chunk.includes("if (viewer !== 'text' && viewer !== 'markdown')") &&
      chunk.includes("if (alias === '' && (typeof sessionId !== 'string' || sessionId === '')) return false"),
    'a local file has no alias but still has a session to fence the read against')
  check('one byte URL builder serves both worlds',
    chunk.includes('function byteUrlOf (base, path, sessionId, extra = {})') &&
      chunk.includes("else if (typeof sessionId === 'string' && sessionId !== '') query.set('sessionId', sessionId)") &&
      chunk.includes("const source = byteUrlOf(API.html, path, sessionId)"),
    'two hand-built URLs drifted apart once already')
  check('the frame is remounted when scripts are unlocked', (() => {
    const chunk = clientPartSource(pluginRoot, 'client.fileview.js')
    return /key: unlocked \? 'unlocked' : 'sandboxed'/u.test(chunk) &&
      /sandbox: unlocked \? 'allow-scripts allow-forms allow-popups' : ''/u.test(chunk) &&
      !/allow-same-origin/u.test(chunk)
  })(), 'sandbox flags apply at navigation: flipping the attribute alone changes nothing, and allow-same-origin would let a page reach the app')
  check('the unlock banner does not claim a remote host',
    /preview\.htmlUnlocked': '脚本已允许：页面可以运行自己的代码/u.test(clientPartSource(pluginRoot, 'client.locale.js')),
    'local files reach the same viewer')
  check('a failed media preview quotes the route',
    chunk.includes('sshwsp-filepane-reason') &&
      chunk.includes("typeof body?.error === 'string'"),
    'the element only says "no"; the JSON body says which repair it needs')
}

// [sniff] whose bytes decide, not whose name
console.log('\n[sniff]')
{
  const { sniffTextBytes, bomlessUtf16, SNIFF_BYTES } = await load('lib/routes/text-sniff.js')
  check('a plain UTF-8 file is text', sniffTextBytes(Buffer.from('hello\n')).kind === 'text')
  check('a NUL after the encoding checks is binary',
    sniffTextBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])).kind === 'binary')
  check('a UTF-8 BOM keeps text as text',
    sniffTextBytes(Buffer.from('\ufeffhi', 'utf8')).encoding === 'utf8-bom')
  check('UTF-16 without a BOM is not binary',
    sniffTextBytes(Buffer.from('hello world', 'utf16le')).kind === 'text' &&
      bomlessUtf16(Buffer.from('hello world', 'utf16le')) === 'utf16le')
  check('a legacy CJK file stays text',
    sniffTextBytes(Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7])).kind === 'text')
  check('the window is the documented 4 KiB', SNIFF_BYTES === 4096)

  const routes = readFileSync(new URL('../lib/routes/text.js', import.meta.url), 'utf8')
  check('the read route answers the sniff', routes.includes("trimmedParam(url, 'sniff') === '1'") &&
    routes.includes('sniffTextBytes(head)'), 'the client asks by path, so the route has to answer')

  const chunk = clientPartSource(pluginRoot, 'client.fileview.js')
  check('the pane probes instead of refusing', chunk.includes('function probeFile') &&
    chunk.includes("sniffedKinds.set(key, kind)"), 'a verdict costs one read and is then free')
  check('...and says so while it waits', chunk.includes('preview.sniffing') && chunk.includes('function BinaryNote'))

  const bundleSource = clientPartSource(pluginRoot, 'client.js')
  check('an unknown suffix is not a refusal', /return 'unknown'/u.test(bundleSource) &&
    /PREVIEW_BINARY_EXTENSIONS/u.test(bundleSource), 'binary needs a name list; everything else is sniffed')
  check('the fast path still knows cts and bat', /'bat', 'cmd', 'cts'/u.test(bundleSource),
    'a whitelist is there so the common case never waits for a probe')
}

// [compatibility] a stale server is named, not guessed at
console.log('\n[compatibility]')
{
  const routes = readFileSync(new URL('../lib/routes/routes.js', import.meta.url), 'utf8')
  const workspaces = readFileSync(new URL('../lib/routes/workspaces.js', import.meta.url), 'utf8')
  const panel = clientPartSource(pluginRoot, 'client.panel.js')
  const bundleSource = clientPartSource(pluginRoot, 'client.js')
  check('the server publishes what it can do',
    /export const SERVER_FEATURES = \[/u.test(routes) && workspaces.includes('features: SERVER_FEATURES'),
    'a restart is a human action; the client must not assume the new routes are live')
  check('the features cover what the previews need',
    ['byte-range', 'html-rewrite', 'local-bytes', 'sniff']
      .every((name) => routes.includes("'" + name + "'")),
    'one missing route is one silent failure')
  check('the client checks the list', bundleSource.includes('REQUIRED_SERVER_FEATURES') &&
    bundleSource.includes('noteServerCompatibility'))
  check('the panel says so instead of failing later',
    panel.includes('settings.restartRequired') && panel.includes('restartNeeded'))
}

// [local bytes] a local preview is served from disk under the session fence
console.log('\n[local bytes]')
{
  const localBytes = readFileSync(new URL('../lib/routes/local-bytes.js', import.meta.url), 'utf8')
  const transfers = readFileSync(new URL('../lib/routes/transfers.js', import.meta.url), 'utf8')
  const view = readFileSync(new URL('../lib/routes/view.js', import.meta.url), 'utf8')
  check('a local read is fenced by the session root',
    localBytes.includes('localRootOf(owner)') && localBytes.includes('isWithinLocalRoot(root, local)'),
    'the root must come from the session, never from the request')
  check('a junction cannot walk the read outside',
    localBytes.includes('await realpath(local)') && localBytes.includes('isWithinLocalRoot(root, absolute)'),
    'the lexical check alone is not enough on Windows')
  check('both byte routes take the local branch',
    transfers.includes('resolveLocalRead(ctx') && view.includes('resolveLocalRead(ctx'),
    'the media viewer and the HTML frame share the download source')
  check('a local byte route is addressed by session, not by alias',
    clientPartSource(pluginRoot, 'client.fileview.js').includes("query.set('sessionId', sessionId)") && transfers.includes("trimmedParam(url, 'sessionId')"),
    'a local workspace has no alias to name it by')
}

// [target] a workspace-spelled path is normalised before SFTP sees it
console.log('\n[target]')
{
  const { resolveRemoteTarget } = await load('lib/routes/remote-target.js')
  const prefixed = resolveRemoteTarget('', 'ssh://qiyk/home/qiyk/test/dzfp.pdf')
  check('an ssh:// spelling is split into alias and path',
    prefixed?.alias === 'qiyk' && prefixed?.remotePath === '/home/qiyk/test/dzfp.pdf',
    JSON.stringify(prefixed))
  check('an explicit alias wins over the prefix', (() => {
    const target = resolveRemoteTarget('other', 'ssh://qiyk/home/a.png')
    return target?.alias === 'other' && target?.remotePath === '/home/a.png'
  })(), 'the route already said which host it means')
  check('a bare path is passed through', (() => {
    const target = resolveRemoteTarget('qiyk', '/home/a.png')
    return target?.alias === 'qiyk' && target?.remotePath === '/home/a.png'
  })(), 'the common case must not regress')
  check('a bare path with no alias names nothing', resolveRemoteTarget('', '/home/a.png') === undefined)
  check('a broken prefix is a bad request, not a missing file',
    resolveRemoteTarget('qiyk', 'ssh://broken') === undefined)
  const transfers = readFileSync(new URL('../lib/routes/transfers.js', import.meta.url), 'utf8')
  const view = readFileSync(new URL('../lib/routes/view.js', import.meta.url), 'utf8')
  check('both byte routes normalise', transfers.includes('resolveRemoteTarget(') && view.includes('resolveRemoteTarget('),
    'the media viewer and the HTML frame take the same path, so both need the same split')
  check('the raw query string never reaches SFTP',
    !/openRemoteRead\(engine, alias, trimmedParam\(url, 'path'\)/u.test(transfers),
    'passing ssh://qiyk/home/… to sftpStatOrNull is the bug this guards')
}

// [tab menu] right-click on a file tab closes only file tabs
console.log('\n[tab menu]')
{
  const chunk = clientPartSource(pluginRoot, 'client.fileview.js')
  const bundle = clientPartSource(pluginRoot, 'client.js')
  const locale = clientPartSource(pluginRoot, 'client.locale.js')

  check('a file tab carries the claim marker',
    chunk.includes("button.setAttribute('data-sshwsp-tab-path', path)"),
    'the tab element is the host\'s, so the only handle we can own is an attribute we write')
  check('the tab menu lives with the tab feature, not the bundle',
    chunk.includes("const marked = button.getAttribute('data-sshwsp-tab-path')") &&
      chunk.includes('const FILE_TAB_SELECTOR') &&
      !bundle.includes('function openFileTabMenu') &&
      bundle.includes('menu: { show: (model, x, y) => renderMenuDom(model, x, y) }'),
    'the bundle owns HOW a menu is drawn; what a tab menu means belongs to the file view chunk')
  check('...and trusts a label only when it is unique', (() => {
    // Both functions travel together: the fallback asks for the DRAWn label, so
    // a bare-name argument would be a second naming rule waiting to disagree.
    const source = chunk.slice(chunk.indexOf('function tabSegmentsOf'), chunk.indexOf('function clickNthByText')) +
      chunk.slice(chunk.indexOf('function pathOfTabLabel'), chunk.indexOf('function closeTabs ('))
    const pathOf = new Function(
      'openFileTabs', 'fileTabName', 'sessionOpenFiles', 'registeredSessionId',
      source + '; return pathOfTabLabel',
    )(
      new Map([['/a/index.ts', () => {}], ['/b/index.ts', () => {}], ['/c/README.md', () => {}]]),
      path => path.split('/').pop(),
      new Map([['s1', ['/a/index.ts', '/b/index.ts', '/c/README.md']]]),
      's1',
    )
    return pathOf('README.md') === '/c/README.md' && pathOf('index.ts') === undefined
  })(), 'closing the wrong index.ts is worse than showing no menu')

  check('the menu offers exactly the three close verbs',
    chunk.includes("translate('tabmenu.close')") &&
      chunk.includes("translate('tabmenu.closeOthers')") &&
      chunk.includes("translate('tabmenu.closeRight')") &&
      chunk.includes('disabled: others.length === 0') &&
      chunk.includes('disabled: right.length === 0'),
    'a verb with nothing to act on is drawn disabled, not hidden')
  check('"to the right" reads the strip order',
    chunk.includes('const right = index >= 0 ? paths.slice(index + 1) : []'),
    'the host renders entries in registration order, which IS the visual order')
  check('the batch is scoped to stamped tabs',
    chunk.includes('[role="tab"][data-sshwsp-tab-path]') &&
    'chat, trajectory and other plugins\' views carry no marker, so they are never in the batch')

  const batch = (() => {
    const source = chunk.slice(chunk.indexOf('function closeTabs ('), chunk.indexOf('/** Close one file tab'))
    const open = new Map([['/a.ts', () => {}], ['/b.ts', () => {}], ['/c.ts', () => {}]])
    const closed = []
    let prompts = 0
    const build = (answer) => new Function(
      'openFileTabs', 'isFileDirty', 'translate', 'closeFilePreview', 'window',
      source + '; return closeTabs',
    )(open, (_session, path) => path === '/a.ts' || path === '/b.ts',
      (key, params) => key + ':' + (params?.count ?? ''), path => { closed.push(path) },
      { confirm: () => { prompts += 1; return answer } })
    return { build, closed, prompts: () => prompts }
  })()

  const confirmed = batch.build(true)
  const closedCount = confirmed(['/a.ts', '/b.ts', '/c.ts'], 's1')
  check('a batch asks once for every unsaved file',
    closedCount === 3 && batch.prompts() === 1 && batch.closed.length === 3,
    'one dialog per tab would be an interrogation, and naming one buffer hides the others')
  check('...and a refusal aborts the whole batch', (() => {
    const closed = []
    const source = chunk.slice(chunk.indexOf('function closeTabs ('), chunk.indexOf('/** Close one file tab'))
    const run = new Function('openFileTabs', 'isFileDirty', 'translate', 'closeFilePreview', 'window',
      source + '; return closeTabs')(
      new Map([['/a.ts', () => {}], ['/b.ts', () => {}]]),
      () => true, key => key, path => { closed.push(path) }, { confirm: () => false })
    return run(['/a.ts', '/b.ts'], 's1') === 0 && closed.length === 0
  })(), 'a partial close after a refusal would leave a row that no longer matches the prompt')

  check('both languages name the menu',
    /tabmenu\.close': '关闭'/u.test(locale) && /tabmenu\.close': 'Close'/u.test(locale) &&
      locale.includes("'preview.tabsUnsaved'"),
    'an untranslated verb falls back to the key, which is not a word')
}

// [tab labels] a colliding name grows a dim tail, not a prefix
console.log('\n[tab labels]')
{
  const chunk = clientPartSource(pluginRoot, 'client.fileview.js')
  const source = chunk.slice(chunk.indexOf('function tabSegmentsOf'), chunk.indexOf('function clickNthByText'))
  const build = (paths, session = 's1') => new Function(
    'fileTabName', 'sessionOpenFiles', 'registeredSessionId', 'openFileTabs',
    source + '; return tabDirTailFor',
  )(
    path => path.split(/[/\\\\]/u).pop(),
    new Map([[session, paths]]),
    session,
    new Map(paths.map(path => [path, () => {}])),
  )

  check('a unique name carries no tail',
    build(['/a/README.md', '/a/app.ts'])('/a/app.ts') === '',
    'the tail exists to tell twins apart, not to name paths nobody asked for')
  check('a colliding name grows the shortest tail',
    (() => {
      const tail = build(['/x/src/index.ts', '/y/lib/index.ts'])
      return tail('/x/src/index.ts') === '…/src' && tail('/y/lib/index.ts') === '…/lib'
    })(), 'one segment is enough when the parents already differ')
  check('a deeper collision grows the tail, not the name',
    (() => {
      const tail = build(['/r/a/x/index.ts', '/r/b/x/index.ts'])
      return tail('/r/a/x/index.ts') === '…/a/x' && tail('/r/b/x/index.ts') === '…/b/x'
    })(), 'the shortest prefix that disambiguates, at any depth')
  check('the tail keeps the path separator the path uses',
    (() => {
      const tail = build(['C:\\one\\api\\__init__.py', 'C:\\two\\core\\__init__.py'])
      return tail('C:\\one\\api\\__init__.py') === '…\\api'
    })(), 'a Windows workspace should not grow a mixed-separator tail')
  check('closing the twin takes the tail away',
    build(['/x/src/index.ts'])('/x/src/index.ts') === '',
    'the roster is read per render: a label is a function of what is open')
  check('the name is still the host text, the tail is ours',
    chunk.includes('label: () => fileTabName(path)') &&
      chunk.includes("setAttribute('data-sshwsp-tab-dir', '')") &&
      chunk.includes("direction: 'rtl'"),
    'React owns the name; the tail must be a node we can re-add, never text we rewrite')
  check('hovering names the file in full',
    chunk.includes('button.title = String(path)') && chunk.includes("textOverflow: 'ellipsis'"),
    'the tab is capped at 200px, not pinned: a pinned width made the host wrap the strip onto a second row')
}

console.log(`\n=== file preview smoke: ${passed} passed, ${failures.length} failed ===\n`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
