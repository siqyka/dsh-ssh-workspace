/**
 * The tree menu is a list of descriptors before it is pixels.
 *
 * ## What this suite drives
 *
 * The row menu and the blank-area menu are built by `rowMenuModel` /
 * `blankMenuModel` and drawn by `renderMenuDom`, this plugin's own floating
 * menu — one renderer, the same one in a local tree and in a remote one. The
 * shipped section is lifted out of `lib/client/client.js` by its own source
 * text and driven with stubs, so the assertions are about behaviour — order,
 * separators, disabled conditions, and what the drawing pass receives — and not
 * about strings happening to sit next to each other.
 *
 * ## The failures this catches
 *
 * A model that reads a request (a policy lookup, a listing) makes opening the
 * menu wait on the network, so the model stays pure and the policy answer
 * arrives after the menu is up. A second renderer — the host's context-menu
 * service — is what made one gesture look like two different menus, so the
 * source must not name it at all.
 *
 * Run: node tests/tree-menu-model-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientSource } from './support/client-source.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const source = clientSource(pluginRoot)

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  PASS  ' + name)
  } else {
    const line = name + (detail === undefined ? '' : ' — ' + detail)
    failures.push(line)
    console.log('  FAIL  ' + line)
  }
}

console.log('\n=== tree menu model smoke ===\n')

// ---- lift the shipped section -----------------------------------------------

const START = "    const POLICY_GATED_ROW_IDS = ['new-file', 'new-folder', 'rename', 'delete']"
const END = '    /**\n     * Open one plugin menu at the pointer, clamped to the viewport.'
const startAt = source.indexOf(START)
const endAt = source.indexOf(END, startAt + 1)
if (startAt < 0 || endAt < 0) throw new Error('client.js no longer marks the menu model section')
const SECTION = source.slice(startAt, endAt)

/**
 * Build the shipped menu section with stubs for everything it talks to.
 *
 * Every free name the section reads is a parameter of the factory, so the
 * lifted code cannot reach anything the test did not hand it.
 */
function build () {
  const calls = []
  const record = (name) => (...args) => { calls.push({ name, args }) }
  const state = { now: 1000000, policyAnswer: null, policyCalls: 0, lastClaim: null }
  const FakeDate = { now: () => state.now }
  const jsx = (type, props) => ({ type, props })
  const dict = {}
  const translate = (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
  }
  const entryNameOf = (p) => String(p).replace(/\/+$/u, '').split('/').pop()
  const remoteTargetOf = (p) => (typeof p === 'string' && p.startsWith('ssh://') ? { alias: 'box' } : null)
  const remoteDirOf = (p) => {
    const cut = String(p).lastIndexOf('/')
    return cut <= 0 ? '/' : String(p).slice(0, cut)
  }
  const rowOfPath = (p) => ({ path: p })
  const mentionToken = (p) => (String(p).startsWith('ssh://') ? '@' + p : null)
  const resolveTargets = (clicked, selection) => {
    const list = Array.isArray(selection) ? selection : []
    const inside = list.some((item) => item !== null && item.path === clicked.path)
    const chosen = inside ? list : [clicked]
    return {
      targets: chosen.map((item) => ({ path: item.path, isDir: item.isDir === true, name: entryNameOf(item.path) })),
    }
  }
  const mutationPolicyOf = (claim) => {
    state.policyCalls += 1
    state.lastClaim = claim
    // A deferred answer lets a test hold two opens in flight at once, which is
    // the only way to see whether the second one asks again.
    if (state.deferred === true) return new Promise((resolve) => { state.settle = resolve })
    return Promise.resolve(state.policyAnswer)
  }
  const openMenuAt = (x, y, fill) => {
    const el = { children: [], appendChild (child) { this.children.push(child) } }
    if (typeof fill === 'function') fill(el)
    return el
  }
  const createTransferItem = (spec) => ({ spec })
  const createMenuSeparator = () => ({ separator: true })
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'translate', 'entryNameOf', 'resolveTargets', 'mentionToken', 'remoteTargetOf', 'remoteDirOf', 'rowOfPath',
    'addPathsToTask', 'downloadRows', 'uploadTreeRow', 'copyRowPath', 'requestRowNewFile', 'requestRowNewFolder',
    'requestRowRename', 'requestRowDelete', 'mutationPolicyOf', 'openMenuAt', 'createTransferItem',
    'createMenuSeparator', 'jsx', 'Date',
    SECTION + '\nreturn { rowMenuModel, blankMenuModel, policyGate, openTreeMenu, policyOf, cachedPolicyOf, renderMenuDom, POLICY_GATED_ROW_IDS }',
  )
  const api = factory(
    translate, entryNameOf, resolveTargets, mentionToken, remoteTargetOf, remoteDirOf, rowOfPath,
    record('addPathsToTask'), record('downloadRows'), record('uploadTreeRow'), record('copyRowPath'),
    record('requestRowNewFile'), record('requestRowNewFolder'), record('requestRowRename'), record('requestRowDelete'),
    mutationPolicyOf, openMenuAt, createTransferItem, createMenuSeparator, jsx, FakeDate,
  )
  return { api, calls, state, record }
}

/** A fake host context-menu service that records what the plugin asks of it. */
function fakeMenus () {
  return {
    registrations: [],
    opened: null,
    closed: 0,
    disposed: 0,
    register (spec) { this.registrations.push(spec); return () => { this.disposed += 1 } },
    open (target, point) { this.opened = { target, point } },
    close () { this.closed += 1 },
  }
}

/** A ctx that offers the service, the icon slot, or neither. */
function fakeCtx (menus, options = {}) {
  const icons = []
  const slot = { disposed: 0 }
  return {
    icons,
    slot,
    ctx: {
      get (name) {
        if (options.throwing === true) throw new Error('no such service')
        if (name !== 'contextMenus') return undefined
        return menus ?? undefined
      },
      slots: {
        inject (name, generator) {
          if (options.noSlots === true) throw new Error('no such slot')
          if (name !== 'contextMenu.icon') return undefined
          for (const entry of generator()) icons.push(entry)
          return () => { slot.disposed += 1 }
        },
        register (spec, component) { return { spec, component } },
      },
    },
  }
}

const REMOTE_DIR = 'ssh://box/home/me/project'
const REMOTE_FILE = 'ssh://box/home/me/project/a.txt'
const LOCAL_FILE = 'C:\\Users\\me\\a.txt'
const ROOT = '/home/me/project'
const CLAIM = { sessionId: 's1', root: ROOT }

// ---- the row menu -----------------------------------------------------------

console.log('[the row menu, as data]')
const rowRun = build()
const modelDir = rowRun.api.rowMenuModel({ ctx: {}, absPath: REMOTE_DIR, isDir: true, root: ROOT, sessionId: 's1', selection: null })
check('a remote directory row offers eight verbs in order',
  modelDir.map((e) => e.id).join(',') === 'add-to-task,download,upload,copy-path,new-file,new-folder,rename,delete',
  modelDir.map((e) => e.id).join(','))
check('...with a rule before download and before the destructive group',
  modelDir.filter((e) => e.separatorBefore === true).map((e) => e.id).join(',') === 'download,new-file')
check('...and delete is the only danger',
  modelDir.filter((e) => e.danger === true).map((e) => e.id).join(',') === 'delete')
check('...each naming its own glyph',
  modelDir.map((e) => e.glyph).join(',') === 'addToTask,download,upload,copy,newFile,newFolder,rename,delete')
check('...and an id that appears once', new Set(modelDir.map((e) => e.id)).size === modelDir.length)
check('...and a run function on every entry', modelDir.every((e) => typeof e.run === 'function'))
check('...and no disabled verb while the policy is unknown', modelDir.every((e) => e.disabled !== true))

const modelFile = rowRun.api.rowMenuModel({ ctx: {}, absPath: REMOTE_FILE, isDir: false, root: ROOT, sessionId: 's1' })
check('a remote FILE row drops the two create verbs',
  modelFile.map((e) => e.id).join(',') === 'add-to-task,download,upload,copy-path,rename,delete',
  modelFile.map((e) => e.id).join(','))
check('...and its destructive group still opens with a rule',
  modelFile.filter((e) => e.separatorBefore === true).map((e) => e.id).join(',') === 'download,rename')

const modelLocal = rowRun.api.rowMenuModel({ ctx: {}, absPath: LOCAL_FILE, isDir: false, root: ROOT, sessionId: 's1' })
check('a local row drops upload and copy-path',
  !modelLocal.some((e) => e.id === 'upload') && !modelLocal.some((e) => e.id === 'copy-path'))
check('...keeps download on screen, disabled with its reason',
  modelLocal.find((e) => e.id === 'download').disabled === true &&
  modelLocal.find((e) => e.id === 'download').reason === 'transfer.notRemote')
check('...and cannot be added to the task either',
  modelLocal.find((e) => e.id === 'add-to-task').disabled === true &&
  modelLocal.find((e) => e.id === 'add-to-task').reason === 'mention.unrepresentable')
check('a remote directory row offers new file', modelDir.some((e) => e.id === 'new-file'))
check('a local row does not offer new file', !modelLocal.some((e) => e.id === 'new-file'))

// ---- one target set, decided once -------------------------------------------

console.log('\n[one target set]')
const selection = [{ path: REMOTE_FILE, isDir: false }, { path: 'ssh://box/home/me/project/b.txt', isDir: false }]
const modelSel = rowRun.api.rowMenuModel({ ctx: {}, absPath: REMOTE_FILE, isDir: false, root: ROOT, sessionId: 's1', selection: { items: selection } })
modelSel.find((e) => e.id === 'download').run()
const downloadCalls = rowRun.calls.filter((c) => c.name === 'downloadRows')
check('a multi-row right-click downloads the whole target set',
  downloadCalls.length === 1 && downloadCalls[0].args[0].length === 2)
modelSel.find((e) => e.id === 'delete').run()
const deleteCalls = rowRun.calls.filter((c) => c.name === 'requestRowDelete')
check('...and delete acts on the same set, not on the clicked row',
  deleteCalls.length === 1 && deleteCalls[0].args[0].items.length === 2)
modelDir.find((e) => e.id === 'rename').run()
const renameCall = rowRun.calls.find((c) => c.name === 'requestRowRename')
check('...while rename names the one row it acts on',
  renameCall.args[0].path === REMOTE_DIR && renameCall.args[0].name === 'project' && renameCall.args[0].root === ROOT)

// ---- the policy gate --------------------------------------------------------

console.log('\n[the write verbs follow the policy]')
const policyRun = build()
const base = { ctx: {}, absPath: REMOTE_DIR, isDir: true, root: ROOT, sessionId: 's1' }
const disabledIds = (model) => model.filter((e) => e.disabled === true).map((e) => e.id).join(',')
check('an unanswered policy disables nothing', disabledIds(policyRun.api.rowMenuModel(base)) === '')
const readOnlyModel = policyRun.api.rowMenuModel({ ...base, policy: { readOnly: true } })
check('a read-only session disables the four write verbs',
  disabledIds(readOnlyModel) === 'new-file,new-folder,rename,delete', disabledIds(readOnlyModel))
check('...with the read-only reason on each',
  readOnlyModel.filter((e) => e.disabled === true).every((e) => e.reason === 'rowmenu.readonly'))
check('...and leaves add, download, upload and copy alone',
  readOnlyModel.filter((e) => ['add-to-task', 'download', 'upload', 'copy-path'].includes(e.id)).every((e) => e.disabled !== true))
const localUnknown = policyRun.api.rowMenuModel({ ...base, absPath: LOCAL_FILE, isDir: false, policy: { readOnly: false, sessionFound: false } })
check('a local row whose session is unknown disables the two write verbs',
  ['rename', 'delete'].every((id) => localUnknown.find((e) => e.id === id).disabled === true) &&
  localUnknown.find((e) => e.id === 'add-to-task').reason === 'mention.unrepresentable',
  disabledIds(localUnknown))
check('...with the unknown-root reason, not the read-only one',
  ['rename', 'delete'].every((id) => localUnknown.find((e) => e.id === id).reason === 'rowmenu.localRootUnknown'))
check('...while a REMOTE row with the same policy stays enabled',
  disabledIds(policyRun.api.rowMenuModel({ ...base, policy: { readOnly: false, sessionFound: false } })) === '')

// ---- the blank-area menu ----------------------------------------------------

console.log('\n[the blank-area menu, as data]')
const blankRun = build()
const target = { dir: ROOT, root: ROOT, sessionId: 's1', container: { id: 'c' } }
const blankModel = blankRun.api.blankMenuModel({ target })
check('the blank menu is three descriptors',
  blankModel.map((e) => e.id).join(',') === 'new-file,new-folder,copy-path', blankModel.map((e) => e.id).join(','))
check('...the two create verbs adjacent and in one group',
  blankModel.every((e) => e.separatorBefore !== true) &&
  blankModel[0].id === 'new-file' && blankModel[1].id === 'new-folder')
check('...copy path carrying the directory as its reason',
  blankModel.find((e) => e.id === 'copy-path').reason === ROOT)
blankModel.find((e) => e.id === 'new-file').run()
const newFileCall = blankRun.calls.find((c) => c.name === 'requestRowNewFile')
check('...new file asks the shared dialog for the resolved directory',
  newFileCall.args[0].path === ROOT && newFileCall.args[0].root === ROOT &&
  newFileCall.args[0].row === null && newFileCall.args[0].container === target.container)
blankModel.find((e) => e.id === 'new-folder').run()
const newFolderCall = blankRun.calls.find((c) => c.name === 'requestRowNewFolder')
check('...new folder likewise',
  newFolderCall.args[0].path === ROOT && newFolderCall.args[0].row === null)
const blankReadOnly = blankRun.api.blankMenuModel({ target, policy: { readOnly: true } })
check('...only the two create verbs are gated by the policy',
  disabledIds(blankReadOnly) === 'new-file,new-folder', disabledIds(blankReadOnly))
check('...copy-path is never gated',
  blankReadOnly.find((e) => e.id === 'copy-path').disabled !== true)
check('...and the unknown-root policy says so instead',
  blankRun.api.blankMenuModel({ target, policy: { readOnly: false, sessionFound: false } })
    .filter((e) => e.disabled === true).every((e) => e.reason === 'rowmenu.localRootUnknown'))

// ---- one renderer -----------------------------------------------------------

console.log('\n[one renderer, and it is ours]')
const drawRun = build()
const drawModel = drawRun.api.rowMenuModel({ ctx: {}, absPath: REMOTE_DIR, isDir: true, root: ROOT, sessionId: 's1' })
const drawnMenu = drawRun.api.openTreeMenu(drawModel, 12, 34)
check('opening the menu draws it here', drawnMenu !== null && typeof drawnMenu.el === 'object')
check('...one node per descriptor, in order',
  drawnMenu !== null && [...drawnMenu.nodes.keys()].join(',') === drawModel.map((e) => e.id).join(','))
check('...and one separator per rule',
  drawnMenu !== null && drawnMenu.el.children.filter((child) => child.separator === true).length === 2)
// The Host publishes a context-menu service; this plugin used to hand it the
// model, so the same right-click answered with the Host's chrome in a local tree
// and with the plugin's in a remote one. One gesture, one look.
check('the drawing never asks the Host to draw',
  !/\.get\??\.\('contextMenus'\)/u.test(source) &&
  !/hostMenuEntries|openHostMenu|registerHostMenuProvider|disposeHostMenuProvider|hostMenusOf/u.test(source) &&
  /function openTreeMenu \(model, x, y\) \{\s*return renderMenuDom\(model, x, y\)/u.test(source),
  'a second renderer came back')
check('...and both open paths use it',
  /function openTreeMenu \(model, x, y\)/u.test(source) &&
  (source.match(/const drawn = openTreeMenu\(model, x, y\)/gu) ?? []).length === 2,
  'one of the two open paths still hands the model to a host renderer')

// ---- the cache, and what it costs to open twice -----------------------------

console.log('\n[a menu that opens twice asks once]')
const dedupe = build()
dedupe.state.deferred = true
const firstAsk = dedupe.api.policyOf(CLAIM)
const secondAsk = dedupe.api.policyOf(CLAIM)
check('two opens in flight share one request', dedupe.state.policyCalls === 1, String(dedupe.state.policyCalls))
dedupe.state.settle({ readOnly: true })
const answers = await Promise.all([firstAsk, secondAsk])
check('...and both callers get the same answer',
  answers[0] === answers[1] && answers[0].readOnly === true)
check('...which is now cached, so a third open costs nothing',
  dedupe.api.cachedPolicyOf(CLAIM) !== null && dedupe.state.policyCalls === 1)

const keyless = build()
keyless.state.policyAnswer = { readOnly: false }
await keyless.api.policyOf({})
await keyless.api.policyOf({})
check('a claim with no session is still cached, so the blank menu asks once',
  keyless.state.policyCalls === 1, String(keyless.state.policyCalls))
check('...under a key of its own, not the session one',
  keyless.api.cachedPolicyOf({}) !== null && keyless.api.cachedPolicyOf(CLAIM) === null)

// The keyboard gestures (F2 / Delete) are the other way into the same four
// verbs. They used to call the wire directly, so a right-click followed by a
// Delete on one root was two full `/mutation-policy` round trips and the answer
// the menu had just received could not help the key press.
console.log('\n[the keyboard gestures share the menu cache]')
const keyboardStart = source.indexOf("event.key === 'F2'")
const keyboardBlock = keyboardStart < 0 ? '' : source.slice(Math.max(0, keyboardStart - 2000), keyboardStart + 6000)
check('F2 / Delete resolve through the shared policy cache',
  /\bpolicyOf\(\{ root \}\)/u.test(keyboardBlock) && !/mutationPolicyOf/u.test(keyboardBlock))

const bounded = build()
bounded.state.policyAnswer = { readOnly: true }
for (let i = 0; i < 40; i += 1) await bounded.api.policyOf({ sessionId: 's' + i, root: '/r' + i })
check('the cache keeps a bounded number of answers, oldest first out',
  bounded.api.cachedPolicyOf({ sessionId: 's39', root: '/r39' }) !== null &&
  bounded.api.cachedPolicyOf({ sessionId: 's0', root: '/r0' }) === null)
check('...and a miss is still a miss, not a stale yes',
  bounded.api.cachedPolicyOf({ sessionId: 'nobody', root: '/nowhere' }) === null)

// A hit has to move the entry to the warm end. Without the re-insert, the map
// is FIFO and the eviction below drops the answer that was JUST used.
const lru = build()
lru.state.policyAnswer = { readOnly: true }
for (let i = 0; i < 32; i += 1) await lru.api.policyOf({ sessionId: 's' + i, root: '/r' + i })
lru.api.cachedPolicyOf({ sessionId: 's0', root: '/r0' })
await lru.api.policyOf({ sessionId: 's32', root: '/r32' })
check('a cache hit makes an entry recent, so eviction spares it',
  lru.api.cachedPolicyOf({ sessionId: 's0', root: '/r0' }) !== null)
check('...and the genuinely coldest entry is the one that goes',
  lru.api.cachedPolicyOf({ sessionId: 's1', root: '/r1' }) === null)

// ---- the dictionaries -------------------------------------------------------

console.log('\n[the two new strings]')
const locale = readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.locale.js'), 'utf8')
check('the host-menu-only strings are gone from both dictionaries',
  (locale.match(/'menu\.disabledReason':/gu) ?? []).length === 0 &&
  (locale.match(/'menu\.actionFailed':/gu) ?? []).length === 0)
check('the gated verb list is the four write verbs',
  rowRun.api.POLICY_GATED_ROW_IDS.join(',') === 'new-file,new-folder,rename,delete')

console.log('\n=== ' + passed + ' passed, ' + failures.length + ' failed ===')
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const line of failures) console.log('  - ' + line)
  process.exitCode = 1
}
