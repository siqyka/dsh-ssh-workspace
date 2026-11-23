/**
 * The tree menu is a list of descriptors before it is pixels.
 *
 * ## What this suite drives
 *
 * The row menu and the blank-area menu are built by `rowMenuModel` /
 * `blankMenuModel` and drawn by ONE of two renderers: the host context menu
 * (`ctx.contextMenus`) when the host publishes one, and the plugin's own
 * floating menu otherwise. Both shipped halves are lifted out of
 * `lib/client/client.js` by their own source text and driven with stubs, so the
 * assertions are about behaviour — order, separators, disabled conditions, the
 * host entry shape — and not about strings happening to sit next to each other.
 *
 * ## The two failures this catches
 *
 * A model that reads a request (a policy lookup, a listing) makes opening the
 * menu wait on the network, and the host gives `resolve` one second. A host
 * entry whose disabled reason lives only in a tooltip is a menu that offers an
 * action and refuses it on click, because the host menu has no tooltip. Both
 * are asserted here.
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

/** The shipped `hostMenuEntries`, for the "does it fetch" source assertion. */
const entriesSource = SECTION.slice(
  SECTION.indexOf('function hostMenuEntries ('),
  SECTION.indexOf('function menuGlyphComponent ('),
)
if (entriesSource === '') throw new Error('client.js no longer defines hostMenuEntries()')

const GLYPHS = { file: ['M0 0'], rename: ['M1 1'] }

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
  const dict = {
    'menu.disabledReason': '{label} ({reason})',
    'menu.actionFailed': 'The action failed',
  }
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
    'createMenuSeparator', 'jsx', 'MENU_GLYPH_PATHS', 'Date',
    SECTION + '\nreturn { rowMenuModel, blankMenuModel, policyGate, hostMenuEntry, hostMenuEntries, hostMenusOf, openHostMenu, openTreeMenu, registerHostMenuProvider, disposeHostMenuProvider, policyOf, cachedPolicyOf, renderMenuDom, HOST_MENU_ID, HOST_MENU_TARGET, POLICY_GATED_ROW_IDS }',
  )
  const api = factory(
    translate, entryNameOf, resolveTargets, mentionToken, remoteTargetOf, remoteDirOf, rowOfPath,
    record('addPathsToTask'), record('downloadRows'), record('uploadTreeRow'), record('copyRowPath'),
    record('requestRowNewFile'), record('requestRowNewFolder'), record('requestRowRename'), record('requestRowDelete'),
    mutationPolicyOf, openMenuAt, createTransferItem, createMenuSeparator, jsx, GLYPHS, FakeDate,
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
  return {
    icons,
    ctx: {
      get (name) {
        if (options.throwing === true) throw new Error('no such service')
        if (name !== 'contextMenus') return undefined
        return menus ?? undefined
      },
      slots: {
        inject (name, generator) {
          if (options.noSlots === true) throw new Error('no such slot')
          if (name !== 'contextMenu.icon') return
          for (const entry of generator()) icons.push(entry)
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

// ---- the host renderer ------------------------------------------------------

console.log('\n[the host renderer]')
const hostRun = build()
const menus = fakeMenus()
const host = fakeCtx(menus)
const hostModel = hostRun.api.rowMenuModel({ ctx: host.ctx, absPath: REMOTE_DIR, isDir: true, root: ROOT, sessionId: 's1' })
const value = { blank: false, path: REMOTE_DIR, isDir: true, root: ROOT, sessionId: 's1', selection: null }
const drawn = hostRun.api.openTreeMenu(host.ctx, hostModel, value, 10, 20)
check('a host with the service draws the menu', drawn === null && menus.opened !== null)
check('...registered under the plugin target',
  menus.registrations.length === 1 &&
  menus.registrations[0].id === 'ssh-workspace.tree' &&
  menus.registrations[0].target === 'ssh-workspace.files' &&
  menus.registrations[0].order === 100)
check('...opened at the pointer with the value the model needs',
  menus.opened.point.x === 10 && menus.opened.point.y === 20 &&
  menus.opened.target.kind === 'ssh-workspace.files' && menus.opened.target.value === value)
const entries = menus.registrations[0].resolve(value)
check('resolve answers with an array, synchronously', Array.isArray(entries))
check('...one entry per descriptor', entries.length === hostModel.length)
check('...each naming an icon the plugin publishes',
  entries.every((e) => typeof e.icon?.key === 'string' && e.icon.key.startsWith('ssh-workspace:')))
check('...each with a run function and a failure label',
  entries.every((e) => typeof e.run === 'function' && e.failureLabel === 'The action failed'))
check('...and a rule only where the model has one',
  entries.filter((e) => e.separatorBefore === true).map((e) => e.id).join(',') === 'download,new-file')
check('...carrying the danger flag through',
  entries.filter((e) => e.danger === true).map((e) => e.id).join(',') === 'delete')
check('the row-menu marks are published under the host icon slot',
  host.icons.length === Object.keys(GLYPHS).length &&
  host.icons.map((entry) => entry.spec.key).join(',') === 'ssh-workspace:file,ssh-workspace:rename')
check('...as components that draw the same paths',
  host.icons[0].component().type === 'svg' && host.icons[0].component().props.children.length === 1)

// ---- what resolve must NOT do ----------------------------------------------

console.log('\n[resolve reads the cache, never the wire]')
check('the entries builder names no fetch and awaits nothing',
  !/fetchJson|\bawait\b/u.test(entriesSource) && /cachedPolicyOf\(claim\)/u.test(entriesSource))
const bg = build()
const beforeCalls = bg.state.policyCalls
const immediate = bg.api.hostMenuEntries(host.ctx, value)
check('an empty cache still answers at once, and asks in the background',
  Array.isArray(immediate) && bg.state.policyCalls === beforeCalls + 1)
check('...with every verb enabled, because nothing is known yet',
  immediate.every((e) => e.disabled !== true))
const cached = build()
cached.state.policyAnswer = { readOnly: true }
await cached.api.policyOf(CLAIM)
const afterFill = cached.state.policyCalls
const answered = cached.api.hostMenuEntries(host.ctx, value)
check('a cached answer disables the four verbs without another round trip',
  answered.filter((e) => e.disabled === true).map((e) => e.id).join(',') === 'new-file,new-folder,rename,delete' &&
  cached.state.policyCalls === afterFill)
const renameEntry = answered.find((e) => e.id === 'rename')
check('...and states the reason in the label, because the host has no tooltip',
  renameEntry.label === 'rowmenu.rename (rowmenu.readonly)', renameEntry.label)
check('...while an enabled entry keeps its plain label',
  answered.find((e) => e.id === 'download').label === 'transfer.download')
const ttl = build()
ttl.state.policyAnswer = { readOnly: true }
await ttl.api.policyOf(CLAIM)
ttl.state.now += 30001
check('an answer older than 30 s is not trusted', ttl.api.cachedPolicyOf(CLAIM) === null)

// ---- registration is reentrant, and absent when unsupported ----------------

console.log('\n[one provider, or none]')
const twice = build()
const twiceMenus = fakeMenus()
const twiceHost = fakeCtx(twiceMenus)
const twiceModel = twice.api.rowMenuModel({ ctx: twiceHost.ctx, absPath: REMOTE_DIR, isDir: true, root: ROOT, sessionId: 's1' })
twice.api.openTreeMenu(twiceHost.ctx, twiceModel, value, 1, 2)
twice.api.openTreeMenu(twiceHost.ctx, twiceModel, value, 1, 2)
check('a second open does not register a second provider',
  twiceMenus.registrations.length === 1 && twiceMenus.disposed === 0)
const otherMenus = fakeMenus()
const otherHost = fakeCtx(otherMenus)
twice.api.openTreeMenu(otherHost.ctx, twiceModel, value, 1, 2)
check('...but a different service replaces the one it had',
  otherMenus.registrations.length === 1 && twiceMenus.disposed === 1)
check('...and publishes the icons once', twiceHost.icons.length === Object.keys(GLYPHS).length)
const plain = build()
const plainHost = fakeCtx(null)
const drawnPlain = plain.api.openTreeMenu(plainHost.ctx, hostModel, value, 3, 4)
check('a host without the service gets the plugin menu',
  drawnPlain !== null && plainHost.icons.length === 0)
check('...drawing one node per descriptor, in order',
  [...drawnPlain.nodes.keys()].join(',') === hostModel.map((e) => e.id).join(','))
check('...and one separator per rule',
  drawnPlain.el.children.filter((child) => child.separator === true).length === 2)
check('a get() that throws reads as "no service", not as a crash',
  plain.api.hostMenusOf({ get () { throw new Error('nope') } }) === null)
check('...and a service that is not an object reads the same way',
  plain.api.hostMenusOf({ get: () => 42 }) === null)
const noSlots = build()
const noSlotMenus = fakeMenus()
const noSlotHost = fakeCtx(noSlotMenus, { noSlots: true })
const drawnNoSlot = noSlots.api.openTreeMenu(noSlotHost.ctx, hostModel, value, 0, 0)
check('an icon slot that refuses does not stop the menu',
  drawnNoSlot === null && noSlotMenus.registrations.length === 1)

// ---- the dictionaries -------------------------------------------------------

console.log('\n[the two new strings]')
const locale = readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.locale.js'), 'utf8')
check("'menu.disabledReason' is defined in both dictionaries",
  (locale.match(/'menu\.disabledReason':/gu) ?? []).length === 2)
check("'menu.actionFailed' is defined in both dictionaries",
  (locale.match(/'menu\.actionFailed':/gu) ?? []).length === 2)
check('...and the template states the label and the reason in both',
  locale.includes("'{label}（{reason}）'") && locale.includes("'{label} ({reason})'"))
check('the gated verb list is the four write verbs',
  rowRun.api.POLICY_GATED_ROW_IDS.join(',') === 'new-file,new-folder,rename,delete')

console.log('\n=== ' + passed + ' passed, ' + failures.length + ' failed ===')
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const line of failures) console.log('  - ' + line)
  process.exitCode = 1
}
