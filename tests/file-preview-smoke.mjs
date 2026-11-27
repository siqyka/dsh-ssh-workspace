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
      DEFAULT_PREFERENCES.hideComposer === undefined,
    JSON.stringify(DEFAULT_PREFERENCES))

  check('preferencesOf rejects an unknown mode instead of guessing',
    preferencesOf({ preferences: { fileView: 'bogus' } }).fileView === 'sidebar')
  check('preferencesOf coerces a non-boolean showFiles to false',
    preferencesOf({ preferences: { showFiles: 'yes' } }).showFiles === false &&
      preferencesOf({ preferences: { showFiles: true } }).showFiles === true)
  check('preferencesOf survives a missing or damaged section',
    preferencesOf({}).fileView === 'sidebar' && preferencesOf({ preferences: [] }).showFiles === false)
  check('a stored composer flag is ignored, not carried forward',
    preferencesOf({ preferences: { fileView: 'conversation', hideComposer: true } }).hideComposer === undefined)

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

  // The composer flag belonged to the removed composer pane: a stale page that
  // still posts it must be told, not quietly accepted.
  const retired = preferencesPatchOf({ hideComposer: true })
  check('the retired composer flag is refused',
    retired.ok === false && /unknown preference: hideComposer/.test(retired.error), JSON.stringify(retired))

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
  check('a save returns the normalized section', saved.fileView === 'conversation' && saved.hideComposer === undefined &&
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
  const decisionEnd = text.indexOf('    /** Open one file in its session', decisionStart)
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
  check('Markdown keeps the host preview', isPreviewablePath('README.md') === false)
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
  check('Markdown is never claimed, even in conversation mode',
    filePreviewDecision({ path: 'README.md', kind: 'file', fileView: 'conversation' }) === 'host')
}

// ---------------------------------------------------------------------------
// [client wiring] the conversation tab, the close gestures and the claim gate
// ---------------------------------------------------------------------------
console.log('\n[client wiring]')
{
  const client = clientSource(pluginRoot)
  const panel = clientPartSource(pluginRoot, 'client.panel.js')

  check('the file tab registers into conversation.view',
    client.includes("name: 'conversation.view'") && client.includes('const FILE_VIEW_ID = ') &&
      client.includes("slots.inject('conversation.view'"),
    'the host seat is not used, or the registration has no seat lifetime')
  check('the tab is registered lazily, on the first open',
    /registerInFileSeat = \(\) => slots\.register/u.test(client) &&
      /if \(!ensureFileView\(\)\) return false/u.test(client),
    'registering at apply time would put a file tab in every conversation')
  check('the tab goes away with the last preview',
    /if \(filePreviews\.size === 0\) releaseFileView\(\)/u.test(client),
    'a tab nobody can close is worse than no tab')
  check('opening a file switches the conversation to that tab',
    /function clickByText/u.test(client) && client.includes("clickByText('[role=\"tab\"]'") &&
      client.includes("document.querySelector('[data-conversation-tabs]')"),
    'the tab would open without ever being shown')
  check('a click is only claimed when the tab could be created',
    /decision === 'pane' && openFilePreview\(/u.test(client) &&
      (client.match(/decision === 'pane' && openFilePreview\(/gu) ?? []).length === 2,
    'claiming a click the view cannot show turns "open this file" into nothing')
  check('the file view reads through the plugin\'s own text route',
    /API\.readText\}/u.test(client), 'a second read path would be a second fence to keep in step')
  check('the file view closes with ×', client.includes("className: 'sshwsp-filepane-close'") && client.includes("children: '×'"),
    'the × is the click half of the close contract')
  check('Esc closes too', /event\.key !== 'Escape'/u.test(client) && /closeFilePreview\(sessionId\)/u.test(client),
    'the keyboard half must not depend on focus staying inside the view')
  check('Esc does not steal a modal dialog\'s key',
    /\[role="dialog"\]\[aria-modal="true"\]/u.test(client), 'Escape would close the view behind an open dialog')
  check('the composer is never hidden by the file view',
    !client.includes("data-sshwsp-fileview") && !client.includes('hideComposer'),
    'a view that fills the conversation does not compete with the composer')
  check('a session with no open file gets an explanation, not a blank pane',
    /'data-sshwsp-filepane': 'empty'/u.test(client) && /t\('preview\.empty'\)/u.test(client),
    'selecting the tab by hand must say where files come from')
  check('switching back to the right-hand preview drops the open files',
    /if \(settings\.fileView === 'sidebar' && filePreviews\.size > 0\)/u.test(client),
    'the tab would keep a file nobody asked to keep')

  check('the panel publishes a saved value to the bridge',
    panel.includes('applyPreferences(result.preferences)'), 'a save that never reaches the bridge leaves the click stale')
  check('the panel applies every /status reply',
    panel.includes('applyPreferences(statusData?.preferences)'), 'a hand-edited value would only apply after a reload')
  check('the setting row is a two-state switch, not a checkbox',
    /role: 'radiogroup'/u.test(panel) && /role: 'radio'/u.test(panel) && panel.includes('sshwsp-seg-btn-on'),
    'a single box cannot express "right-hand tree" as the other answer')
  check('the retired composer box is gone from the panel',
    !panel.includes('hideComposer') && !panel.includes('sshwsp-fileview-composer'),
    'a control for a removed behaviour is a setting that lies')
  check('the save goes through the POST route', panel.includes('API.preferences'),
    'the panel must not write the store through another door')
  check('the save failure is reported, not swallowed',
    panel.includes("toastError(t('fileview.saveFail')"), 'a refused save would look like a successful one')
  check('both locales define the new strings',
    [...client.matchAll(/'fileview\.group': '([^']*)'/g)].length === 2 &&
    [...client.matchAll(/'preview\.empty': '([^']*)'/g)].length === 2 &&
    [...client.matchAll(/'preview\.tabLabel': '([^']*)'/g)].length === 2,
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
