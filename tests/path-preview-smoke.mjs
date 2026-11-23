/**
 * The directory list follows the path being typed.
 *
 * ## The bug this suite guards
 *
 * Both pickers (`DirectoryBrowser` and the remote-workspace chooser) used to
 * ignore the path input until Enter: typing `/home/me/pro` left the login
 * directory's rows on screen, so the only way to find a directory was to type
 * the whole path blind and press Enter to find out whether it existed.
 *
 * They now share `usePathDraftPreview`, which makes the list follow the draft
 * without asking the host on every keystroke:
 *
 *   - a draft that is still completing a name in the directory on screen only
 *     NARROWS the rows (case-insensitive), at frame speed;
 *   - a draft that names another directory lists it after a short pause;
 *   - a draft that spells a listed name in full only NARROWS to that row: a
 *     trailing slash (or Enter / a double click) is the explicit way inside.
 *
 * ## Why the real hook, not a grep
 *
 * The interesting part is a pair of React hooks and a debounce timer. A grep
 * can see `usePathDraftPreview` and cannot see whether it schedules a listing,
 * whether it narrows without one, or whether the settled state re-lists its
 * parent forever. So the shipped helpers and the shipped hook are lifted out of
 * `lib/client/client.js` by brace matching and driven by a minimal hooks runtime with
 * a fake clock. The assertions are about the calls the hook makes, and the
 * negative control proves the calls section can fail.
 *
 * ## And the dialogs are rendered
 *
 * The hook being right is not the same as the dialogs using it right, so both
 * shipped components are rendered too, with a `fetchJson` stub answering one
 * small tree. That covers the wiring a grep would miss: the initial directory,
 * the rows after narrowing, the mount button's target, the error branch, and
 * dropping the previous host's path when the remote chooser switches hosts.
 *
 * Run: node tests/path-preview-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { endOfBlock } from './support/toast-dom.mjs'
import { clientSource } from './support/client-source.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const source = clientSource(pluginRoot)

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

console.log('\n=== path preview smoke ===\n')

// ---- lift the shipped pieces -------------------------------------------------

/** The source of one top-level `function name (…) { … }` declaration. */
function liftFunction (name) {
  const start = source.indexOf(`function ${name} (`)
  if (start < 0) throw new Error(`client.js no longer defines ${name}()`)
  const close = /\)\s*\{/u.exec(source.slice(start))
  if (close === null) throw new Error(`${name}() has no body`)
  const open = start + close.index + close[0].length - 1
  return source.slice(start, endOfBlock(source, open))
}

const debounceMatch = /const PATH_PREVIEW_DEBOUNCE_MS = (\d+)/u.exec(source)
if (debounceMatch === null) throw new Error('client.js no longer defines PATH_PREVIEW_DEBOUNCE_MS')
const DEBOUNCE = Number(debounceMatch[1])

const HELPERS = ['draftDirectoryTarget', 'directoryPath', 'directoryDraft', 'narrowDirectoryEntries', 'childDirectoryPath']
const HOOK = liftFunction('usePathDraftPreview')

/**
 * Build the shipped helpers and the shipped hook with a fake React and clock.
 *
 * @param {string} [targetOverride] - replacement source for `draftDirectoryTarget`,
 *   used by the negative control.
 * @returns {Function} the factory.
 */
function buildFactory (targetOverride) {
  const helpers = HELPERS.map((name) => (name === 'draftDirectoryTarget' && targetOverride !== undefined
    ? targetOverride
    : liftFunction(name)))
  // eslint-disable-next-line no-new-func
  return new Function(
    'React', 'setTimeout', 'clearTimeout', 'PATH_PREVIEW_DEBOUNCE_MS',
    `${helpers.join('\n')}\n${HOOK}\nreturn { usePathDraftPreview, ${HELPERS.join(', ')} }`,
  )
}

/**
 * A hooks runtime small enough to read, and enough for this hook.
 *
 * Slots are allocated by call order, exactly like React's, so a lifted function
 * that calls its hooks in a different order between renders throws instead of
 * silently reading someone else's state.
 *
 * The clock is injected into the lifted hook by the factory, not here; this
 * runtime only has to allocate slots and run effects in React's order.
 *
 * @returns {object} the runtime's guts and its React.
 */
function makeHooks () {
  const slots = []
  let cursor = 0
  let dirty = false
  let effects = []

  const sameDeps = (previous, next) => previous !== undefined &&
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]))

  function useState (initial) {
    const slot = cursor++
    if (!(slot in slots)) slots[slot] = { kind: 'state', value: initial }
    if (slots[slot].kind !== 'state') throw new Error(`hook order changed at slot ${slot}`)
    const set = (next) => {
      const value = typeof next === 'function' ? next(slots[slot].value) : next
      if (Object.is(value, slots[slot].value)) return
      slots[slot].value = value
      dirty = true
    }
    return [slots[slot].value, set]
  }

  function useCallback (fn, deps) {
    const slot = cursor++
    const previous = slots[slot]
    if (previous === undefined || !sameDeps(previous.deps, deps)) {
      if (previous !== undefined && previous.kind !== 'callback') throw new Error(`hook order changed at slot ${slot}`)
      slots[slot] = { kind: 'callback', fn, deps }
    }
    return slots[slot].fn
  }

  function useEffect (fn, deps) {
    const slot = cursor++
    const previous = slots[slot]
    if (previous !== undefined && previous.kind !== 'effect') throw new Error(`hook order changed at slot ${slot}`)
    if (previous === undefined || !sameDeps(previous.deps, deps)) {
      effects.push({ slot, fn, deps, previous })
    }
  }

  function useRef (initial) {
    const slot = cursor++
    if (!(slot in slots)) slots[slot] = { kind: 'ref', current: initial }
    return slots[slot]
  }

  function beginRender () {
    cursor = 0
    effects = []
    dirty = false
  }

  /** Clean up superseded effects first, then run the new ones, like React. */
  function runEffects () {
    const queue = effects
    effects = []
    for (const effect of queue) {
      if (typeof effect.previous?.cleanup === 'function') effect.previous.cleanup()
    }
    for (const effect of queue) {
      const cleanup = effect.fn()
      slots[effect.slot] = {
        kind: 'effect',
        deps: effect.deps,
        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
      }
    }
  }

  return {
    React: {
      useState,
      useCallback,
      useEffect,
      useRef,
      createElement: (type, props) => ({ type, props: props ?? {} }),
    },
    beginRender,
    runEffects,
    isDirty: () => dirty,
    unmount () {
      for (const slot of slots) {
        if (typeof slot?.cleanup === 'function') slot.cleanup()
      }
    },
  }
}

/**
 * Drive the shipped hook like the pickers do.
 *
 * The component-shaped wrapper owns the three inputs the real components own
 * (draft, current directory, its listing) and a `loadDir` that records instead
 * of fetching; the test delivers answers with `deliver()`, which is what the
 * component does when `fetchJson` resolves.
 *
 * @param {object} options - the scenario.
 * @param {Function} options.factory - `buildFactory()`'s return value.
 * @param {string} options.dir - starting directory.
 * @param {Array<object>} options.rows - starting listing.
 * @returns {object} the driver.
 */
function makePicker ({ factory, dir, rows }) {
  let now = 0
  let timerId = 0
  let timers = []

  const setTimeout = (fn, ms) => {
    timerId += 1
    timers.push({ id: timerId, fn, at: now + ms })
    return timerId
  }
  const clearTimeout = (id) => { timers = timers.filter((timer) => timer.id !== id) }

  const hooks = makeHooks()
  // One bound hook for the picker's lifetime, like a component's own closure;
  // the factory returns the whole shipped bundle of helpers.
  const { usePathDraftPreview } = factory(hooks.React, setTimeout, clearTimeout, DEBOUNCE)

  const loads = []
  let exposed = {}
  let fragment = ''

  const settledDraft = dir === '/' ? '/' : `${dir}/`

  function Picker () {
    const [currentDir, setDir] = hooks.React.useState(dir)
    const [listing, setListing] = hooks.React.useState(rows)
    const [draft, setDraft] = hooks.React.useState(settledDraft)
    const loadDir = hooks.React.useCallback((target) => { loads.push(target) }, [])
    exposed = { setDir, setListing, setDraft }
    fragment = usePathDraftPreview({ draft, currentDir, listing, loadDir })
  }

  function pump (limit = 20) {
    let rounds = 0
    do {
      hooks.beginRender()
      Picker()
      hooks.runEffects()
      rounds += 1
      if (rounds > limit) throw new Error('the preview hook did not settle: an effect keeps re-scheduling')
    } while (hooks.isDirty())
    return fragment
  }

  const api = {
    fragment: () => fragment,
    loads,
    pump,
    pendingTimers: () => timers.length,
    set (patch) {
      if ('draft' in patch) exposed.setDraft(patch.draft)
      if ('dir' in patch) exposed.setDir(patch.dir)
      if ('listing' in patch) exposed.setListing(patch.listing)
      return pump()
    },
    deliver (nextDir, nextRows) {
      exposed.setDir(nextDir)
      exposed.setListing(nextRows)
      return pump()
    },
    advance (ms) {
      now += ms
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)
      timers = timers.filter((timer) => timer.at > now)
      for (const timer of due) timer.fn()
      return pump()
    },
    unmount () { hooks.unmount() },
  }

  pump()
  return api
}

/**
 * Render one picker dialog through the shipped component.
 *
 * Both dialogs are rendered with the shipped body, the shipped preview hook and
 * a `fetchJson` stub that answers one small tree (`/home/me` holding
 * `Documents` and `projects`, `projects` holding `src`, `/home/me/nope`
 * failing). Nothing about the component's state, effects or JSX is retyped, so
 * a hook-order mistake, a stale state name or a broken branch is a failed
 * assertion rather than a blank dialog nobody noticed.
 *
 * @param {object} options - the scenario.
 * @param {string} options.name - `DirectoryBrowser` or `RemoteWorkspaceDialog`.
 * @param {object} options.props - the props the owner passes.
 * @returns {object} the driver.
 */
function makeDialog ({ name, props }) {
  const hooks = makeHooks()
  const clock = makeClock()
  const requests = []
  // POST bodies, so "what did the button actually send" is observable rather than
  // inferred from the rendered state.
  const posts = []
  // What the server answers for `dirs=1`: directories only. A file in here would
  // be a fixture the real route cannot produce.
  const HOME_ROWS = [{ name: 'Documents', type: 'directory' }, { name: 'projects', type: 'directory' }]
  let tree = null

  const jsx = (type, nodeProps) => ({ type, props: nodeProps ?? {} })
  const stubs = {
    modalLayer: (node) => node,
    backdropDismiss: () => ({}),
    useDialogA11y: () => ({ props: {}, titleId: 'dialog-title', bodyRef: { current: null } }),
    t: (key) => key,
    API: { ls: '/ls', mount: '/mount', hosts: '/hosts' },
    BROWSE_LIST_LIMIT: 2000,
    FolderIcon: function FolderIcon () {},
    GlobeIcon: function GlobeIcon () {},
    ArrowLeftIcon: function ArrowLeftIcon () {},
    CloseIcon: function CloseIcon () {},
    capabilityNotes: () => [],
    refreshRemoteWorkspaceMarks: () => {},
    fetchJson: async (url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(init.body))
        return { ok: true, workspacePath: 'ssh://box/home/me' }
      }
      if (url.endsWith('/hosts')) return { hosts: [{ alias: 'box' }, { alias: 'other' }] }
      requests.push(url)
      const match = /[?&]path=([^&]*)/u.exec(url)
      const target = match === null ? '/home/me' : decodeURIComponent(match[1])
      if (target === '/home/me/nope') throw new Error('No such file')
      return {
        path: target,
        entries: target === '/home/me/projects' ? [{ name: 'src', type: 'directory' }] : HOME_ROWS,
        total: 1,
        truncated: false,
        writable: true,
      }
    },
  }

  const parts = [...HELPERS, 'usePathDraftPreview', name].map(liftFunction)
  // eslint-disable-next-line no-new-func
  const Component = new Function(
    'React', 'setTimeout', 'clearTimeout', 'jsx', 'jsxs', 'PATH_PREVIEW_DEBOUNCE_MS', ...Object.keys(stubs),
    `${parts.join('\n')}\nreturn ${name}`,
  )(hooks.React, clock.setTimeout, clock.clearTimeout, jsx, jsx, DEBOUNCE, ...Object.values(stubs))

  function pump (limit = 40) {
    let rounds = 0
    do {
      hooks.beginRender()
      tree = Component(props)
      hooks.runEffects()
      rounds += 1
      if (rounds > limit) throw new Error(`${name} did not settle: an effect keeps re-scheduling`)
    } while (hooks.isDirty())
    return tree
  }

  /** Let the fetch stubs' microtasks land, then render again — a few times, so
   *  the hosts fetch → alias → listing chain completes. */
  async function settle (passes = 3) {
    pump()
    for (let index = 0; index < passes; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve))
      pump()
    }
    return tree
  }

  function findAll (node, out = []) {
    if (Array.isArray(node)) {
      for (const child of node) findAll(child, out)
      return out
    }
    if (node === null || node === undefined || typeof node !== 'object') return out
    out.push(node)
    findAll(node.props?.children, out)
    return out
  }

  const input = () => findAll(tree).find((node) => node.type === 'input' && String(node.props.className).includes('sshwsp-path-input'))
  const rows = () => findAll(tree)
    .filter((node) => node.type === 'button' && String(node.props.className).includes('sshwsp-entry-dir'))
    .map((node) => node.props.children[1].props.children)
  const texts = () => findAll(tree)
    .flatMap((node) => (Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]))
    .filter((child) => typeof child === 'string')

  return {
    requests,
    posts,
    pump,
    settle,
    input,
    rows,
    texts,
    find: (predicate) => findAll(tree).find(predicate),
    rowNode: (name) => findAll(tree).find((node) => node.type === 'button' &&
      String(node.props.className).includes('sshwsp-entry-dir') && node.props.children[1].props.children === name),
    /** One pointer click on a row: `detail` 1 is a mouse click, 0 a keyboard one. */
    clickRow (name, detail = 1) {
      const node = findAll(tree).find((candidate) => candidate.type === 'button' &&
        String(candidate.props.className).includes('sshwsp-entry-dir') && candidate.props.children[1].props.children === name)
      node.props.onClick({ detail })
      return pump()
    },
    enterRow (name) {
      const node = findAll(tree).find((candidate) => candidate.type === 'button' &&
        String(candidate.props.className).includes('sshwsp-entry-dir') && candidate.props.children[1].props.children === name)
      node.props.onDoubleClick()
      return pump()
    },
    mountButton: () => findAll(tree).find((node) => node.type === 'button' && String(node.props.className).includes('sshwsp-btn-primary')),
    tree: () => tree,
    setDraft (value) {
      input().props.onChange({ target: { value } })
      return pump()
    },
    press (key) {
      input().props.onKeyDown({ key, preventDefault () {} })
      return pump()
    },
    advance (ms) {
      clock.advance(ms)
      return pump()
    },
  }
}

/**
 * A fake clock, so the hook's debounce is a number the test steps over rather
 * than a wall-clock sleep.
 *
 * @returns {object} the clock.
 */
function makeClock () {
  let now = 0
  let nextId = 0
  let timers = []
  return {
    setTimeout (fn, ms) {
      nextId += 1
      timers.push({ id: nextId, fn, at: now + ms })
      return nextId
    },
    clearTimeout (id) { timers = timers.filter((timer) => timer.id !== id) },
    pending: () => timers.length,
    advance (ms) {
      now += ms
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)
      timers = timers.filter((timer) => timer.at > now)
      for (const timer of due) timer.fn()
    },
  }
}

const shipped = buildFactory()
const { draftDirectoryTarget, directoryPath, directoryDraft, narrowDirectoryEntries, childDirectoryPath } = shipped({}, () => {}, () => {}, DEBOUNCE)

// ---- the pure reading of a draft --------------------------------------------

console.log('[draft → target]')

const target = (draft, currentDir) => JSON.stringify(draftDirectoryTarget(draft, currentDir))

check('a prefix inside the shown directory narrows it, without a listing',
  target('/home/me/pro', '/home/me') === JSON.stringify({ dir: '/home/me', fragment: 'pro', refresh: false }))
check('a trailing slash names the typed directory itself',
  target('/home/me/projects/', '/home/me') === JSON.stringify({ dir: '/home/me/projects', fragment: '', refresh: true }))
check('...and is settled when that is the directory already shown',
  target('/home/me/projects/', '/home/me/projects') === JSON.stringify({ dir: '/home/me/projects', fragment: '', refresh: false }),
  'a typed trailing slash would re-list the directory on screen')
check('a draft without the slash is a fragment of the parent',
  target('/home/me/projects', '/home/me/projects') === JSON.stringify({ dir: '/home/me', fragment: 'projects', refresh: true }),
  'deleting the slash must go back up, not stay inside')
check('...even when the echoed path carries the slash',
  target('/home/me/projects', '/home/me/projects/') === JSON.stringify({ dir: '/home/me', fragment: 'projects', refresh: true }),
  'the echo of a typed trailing slash is not a different directory')
check('a pasted complete path is split into parent + last segment',
  target('/home/me/projects', '/') === JSON.stringify({ dir: '/home/me', fragment: 'projects', refresh: true }))
check('the settled state asks for nothing — and it is spelled with the slash',
  target('/home/me/', '/home/me') === JSON.stringify({ dir: '/home/me', fragment: '', refresh: false }),
  'navigation would re-list the parent on every render')
check('a first-level directory filters the root',
  target('/home', '/home/me') === JSON.stringify({ dir: '/', fragment: 'home', refresh: true }))
check('`/` lists the root', target('/', '/home/me') === JSON.stringify({ dir: '/', fragment: '', refresh: true }))
check('slashes only are the root', target('///', '/') === JSON.stringify({ dir: '/', fragment: '', refresh: false }))
check('surrounding whitespace is not part of the path',
  target('  /home/me/p  ', '/home/me') === JSON.stringify({ dir: '/home/me', fragment: 'p', refresh: false }))
check('a relative draft names nothing', draftDirectoryTarget('home/me', '/home/me') === null)
check('an empty draft names nothing', draftDirectoryTarget('', '/home/me') === null)
check('a `~` draft names nothing (no shell expansion is pretended)', draftDirectoryTarget('~/p', '/home/me') === null)

// ---- narrowing ---------------------------------------------------------------

console.log('[narrowing]')

const HOME = [
  { name: 'Documents', type: 'directory' },
  { name: 'Downloads', type: 'directory' },
  { name: 'projects', type: 'directory' },
]

const names = (rows) => (rows ?? []).map((row) => row.name).join(',')
check('an empty fragment shows the whole listing',
  narrowDirectoryEntries(HOME, '') === HOME, 'the untouched listing must not be copied')
check('a fragment keeps only the names that start with it',
  names(narrowDirectoryEntries(HOME, 'doc')) === 'Documents')
check('matching ignores case, and the row keeps the host spelling',
  names(narrowDirectoryEntries(HOME, 'PROJ')) === 'projects')
check('a fragment that matches nothing yields an empty listing',
  names(narrowDirectoryEntries(HOME, 'zzz')) === '')
check('a missing listing stays missing', narrowDirectoryEntries(null, 'x') === null)

// ---- child paths -------------------------------------------------------------

console.log('[child paths]')

check('a path loses its trailing slash for identity', directoryPath('/home/me/') === '/home/me')
check('...but the root stays the root', directoryPath('/') === '/')
check('a directory is spelled for the input WITH the slash',
  directoryDraft('/home/me') === '/home/me/' && directoryDraft('/home/me/') === '/home/me/' &&
    directoryDraft('/') === '/')
check('a child of the root has one slash', childDirectoryPath('/', 'etc') === '/etc')
check('a child of a directory is joined with one slash', childDirectoryPath('/home/me', 'x') === '/home/me/x')
check('a trailing slash on the parent does not double', childDirectoryPath('/home/me/', 'x') === '/home/me/x')

// ---- the hook: the list is live but not chatty ------------------------------

console.log('[the hook]')

{
  const picker = makePicker({ factory: shipped, dir: '/home/me', rows: HOME })
  check('the settled state asks for no listing at all', picker.loads.length === 0 && picker.pendingTimers() === 0,
    `loads=${picker.loads.length} timers=${picker.pendingTimers()}`)

  const fragment = picker.set({ draft: '/home/me/pro' })
  check('typing a prefix filters immediately', fragment === 'pro', `fragment=${JSON.stringify(fragment)}`)
  check('...without asking the host', picker.loads.length === 0 && picker.pendingTimers() === 0,
    `loads=${picker.loads.length} timers=${picker.pendingTimers()}`)

  picker.set({ draft: '/home/me/proj' })
  check('...and each further letter still costs nothing', picker.loads.length === 0 && picker.pendingTimers() === 0,
    `loads=${picker.loads.length} timers=${picker.pendingTimers()}`)
}

{
  const picker = makePicker({ factory: shipped, dir: '/home/me', rows: HOME })
  picker.set({ draft: '/home/me/projects/' })
  check('a trailing slash schedules one listing', picker.pendingTimers() === 1, `timers=${picker.pendingTimers()}`)
  picker.advance(DEBOUNCE - 1)
  check('...not before the typing pause', picker.loads.length === 0, `loads=${picker.loads.join()}`)
  picker.advance(1)
  check('...and exactly one, for the typed directory',
    picker.loads.length === 1 && picker.loads[0] === '/home/me/projects', picker.loads.join())

  const fragment = picker.deliver('/home/me/projects', [{ name: 'src', type: 'directory' }])
  check('the answer clears the filter and settles on that directory',
    fragment === '' && picker.loads.length === 1, picker.loads.join())
  check('...and the settled state does not re-list it',
    picker.pendingTimers() === 0 && picker.loads.length === 1,
    `timers=${picker.pendingTimers()} loads=${picker.loads.join()}`)

  picker.unmount()
}

{
  const picker = makePicker({ factory: shipped, dir: '/home/me', rows: HOME })
  const fragment = picker.set({ draft: '/home/me/projects' })
  check('a fully typed name narrows to a single row', fragment === 'projects', `fragment=${JSON.stringify(fragment)}`)
  picker.advance(DEBOUNCE * 2)
  check('...and does NOT open it — entering is not something the input does on its own',
    picker.loads.length === 0 && picker.pendingTimers() === 0,
    `loads=${picker.loads.join()} timers=${picker.pendingTimers()}`)
  picker.set({ draft: '/home/me/projects/' })
  picker.advance(DEBOUNCE)
  check('...while the trailing slash lists it',
    picker.loads.length === 1 && picker.loads[0] === '/home/me/projects', picker.loads.join())
  const settled = picker.deliver('/home/me/projects', [{ name: 'src', type: 'directory' }])
  check('...settling there without another listing',
    settled === '' && picker.loads.length === 1 && picker.pendingTimers() === 0,
    `fragment=${settled} loads=${picker.loads.join()} timers=${picker.pendingTimers()}`)
}

{
  const picker = makePicker({ factory: shipped, dir: '/home/me', rows: HOME })
  picker.set({ draft: '/home/me/documents' })
  picker.advance(DEBOUNCE)
  check('a case-insensitive near-match does not enter the directory',
    picker.loads.length === 0, picker.loads.join())
}

{
  const picker = makePicker({ factory: shipped, dir: '/home/me', rows: HOME })
  picker.set({ draft: '/home/me/projects/' })
  picker.advance(DEBOUNCE)
  picker.deliver('/home/me/projects', [{ name: 'src', type: 'directory' }])
  const before = picker.loads.length
  picker.set({ draft: '/home/me/projects' })
  picker.advance(DEBOUNCE)
  check('deleting the trailing slash lists the parent again (the way back up)',
    picker.loads.length === before + 1 && picker.loads[picker.loads.length - 1] === '/home/me',
    picker.loads.join())
  const narrowed = picker.deliver('/home/me', HOME)
  check('...and filters it by the last segment',
    narrowed === 'projects', JSON.stringify(narrowed))
}

{
  const picker = makePicker({ factory: shipped, dir: '/home/me', rows: HOME })
  picker.set({ draft: '/home/me/pro' })
  picker.set({ draft: 'home/me' })
  check('a non-absolute draft narrows nothing and keeps the list',
    picker.fragment() === '' && picker.loads.length === 0 && picker.pendingTimers() === 0,
    `fragment=${JSON.stringify(picker.fragment())} loads=${picker.loads.length}`)
}

{
  const picker = makePicker({ factory: shipped, dir: '/home/me', rows: HOME })
  picker.set({ draft: '/home/me/typo/' })
  picker.advance(DEBOUNCE)
  const afterFailure = picker.loads.length
  picker.advance(DEBOUNCE * 5)
  check('a path that fails to list is asked for once, not in a retry loop',
    afterFailure === 1 && picker.loads.length === 1,
    `loads=${picker.loads.join()}`)
}

{
  const picker = makePicker({ factory: shipped, dir: '/home/me', rows: HOME })
  picker.set({ draft: '/home/me/projects/' })
  check('a pending pause holds a timer', picker.pendingTimers() === 1)
  picker.unmount()
  picker.advance(DEBOUNCE)
  check('...and leaving the dialog cancels it', picker.loads.length === 0, picker.loads.join())
}

// ---- the two dialogs, rendered ---------------------------------------------

console.log('[the dialogs]')

{
  const dialog = makeDialog({
    name: 'DirectoryBrowser',
    props: { alias: 'box', onClose () {}, onMount () {}, ctx: {}, t: (key) => key },
  })
  await dialog.settle()
  check('the browser dialog opens on the login directory, spelled as a directory',
    dialog.input()?.props.value === '/home/me/', String(dialog.input()?.props.value))
  check('...with that directory\'s rows',
    dialog.rows().join() === 'Documents,projects', dialog.rows().join())
  check('...after exactly one listing', dialog.requests.length === 1, dialog.requests.join())
  check('...and the listing asked the server for directories only',
    dialog.requests.every(url => /[?&]dirs=1(&|$)/u.test(url)) &&
      !dialog.requests.some(url => /[?&]all=1(&|$)/u.test(url)),
    dialog.requests.join())

  dialog.setDraft('/home/me/pro')
  check('typing a prefix narrows the rendered rows immediately',
    dialog.rows().join() === 'projects', dialog.rows().join())
  check('...without a request', dialog.requests.length === 1, dialog.requests.join())

  dialog.setDraft('/home/me/projects')
  dialog.advance(DEBOUNCE)
  await dialog.settle()
  check('a fully typed name only narrows the rows',
    dialog.rows().join() === 'projects' && dialog.requests.length === 1,
    `${dialog.rows().join()} / ${dialog.requests.join()}`)
  check('...and the text stays in the box', dialog.input()?.props.value === '/home/me/projects',
    String(dialog.input()?.props.value))

  dialog.setDraft('/home/me/projects/')
  dialog.advance(DEBOUNCE)
  await dialog.settle()
  check('a trailing slash lists that directory',
    dialog.requests.length === 2 && dialog.requests[1].includes('path=%2Fhome%2Fme%2Fprojects'),
    dialog.requests.join())
  check('...and renders its contents', dialog.rows().join() === 'src', dialog.rows().join())
  check('...leaving the typed text in the box',
    dialog.input()?.props.value === '/home/me/projects/', String(dialog.input()?.props.value))
  check('the mount button names the directory it will mount',
    dialog.mountButton()?.props.title === '/home/me/projects',
    String(dialog.mountButton()?.props.title))

  // The reported bug: deleting the slash kept showing the directory's contents.
  dialog.setDraft('/home/me/projects')
  dialog.advance(DEBOUNCE)
  await dialog.settle()
  check('deleting the trailing slash returns to the filtered parent',
    dialog.requests.length === 3 && dialog.requests[2].includes('path=%2Fhome%2Fme') &&
      dialog.rows().join() === 'projects',
    `${dialog.requests.join()} / ${dialog.rows().join()}`)
  check('...and the input keeps the slash-free spelling it was given',
    dialog.input()?.props.value === '/home/me/projects', String(dialog.input()?.props.value))

  dialog.setDraft('/home/me/nope')
  dialog.press('Enter')
  await dialog.settle()
  check('Enter on a path that does not exist reports the failure',
    dialog.texts().includes('browser.error'), dialog.texts().join(' | ').slice(0, 200))
}

{
  const dialog = makeDialog({
    name: 'RemoteWorkspaceDialog',
    props: { t: (key) => key, busy: false, onCancel () {}, onCreated () {} },
  })
  await dialog.settle(4)
  check('the remote chooser resolves the host and its login directory',
    dialog.input()?.props.value === '/home/me/', String(dialog.input()?.props.value))
  check('...and renders that directory\'s rows',
    dialog.rows().join() === 'Documents,projects', dialog.rows().join())
  check('...with creation allowed on a writable directory',
    dialog.mountButton()?.props.disabled === false, String(dialog.mountButton()?.props.disabled))

  dialog.setDraft('/home/me/pro')
  check('it narrows rows exactly like the browser dialog', dialog.rows().join() === 'projects', dialog.rows().join())

  dialog.setDraft('/home/me/projects')
  const select = dialog.find((node) => node.type === 'select')
  select.props.onChange({ target: { value: 'other' } })
  dialog.pump()
  check('switching host drops the previous host\'s path at once',
    dialog.input()?.props.value === '', String(dialog.input()?.props.value))
  await dialog.settle(4)
  check('...and adopts the new host\'s login directory',
    dialog.input()?.props.value === '/home/me/', String(dialog.input()?.props.value))
}

// ---- the negative control ----------------------------------------------------

console.log('[negative control]')

{
  // The shipped target always decides whether `dir` is already listed. Force
  // that answer to "yes, already listed" and the same trailing-slash scenario
  // must stop asking — proving the load assertions above can fail.
  const mutantSource = liftFunction('draftDirectoryTarget')
    .replace('return { dir, fragment: trimmed.slice(cut + 1), refresh: dir !== current }',
      'return { dir, fragment: trimmed.slice(cut + 1), refresh: false }')
    .replace('refresh: dir !== current }', 'refresh: false }')
  check('the mutant is a different program', mutantSource !== liftFunction('draftDirectoryTarget'))
  const mutant = buildFactory(mutantSource)
  const picker = makePicker({ factory: mutant, dir: '/home/me', rows: HOME })
  picker.set({ draft: '/home/me/projects/' })
  picker.advance(DEBOUNCE * 2)
  check('with the schedule removed the harness sees no listing', picker.loads.length === 0,
    `loads=${picker.loads.join()}`)
}

// ---- the two dialogs are wired to it ----------------------------------------

console.log('[wiring]')

const live = source
  .replace(/\/\*[\s\S]*?\*\//gu, ' ')
  .replace(/\/\/[^\n]*/gu, ' ')

check('both pickers run the preview hook',
  (live.match(/usePathDraftPreview\(\{/gu) ?? []).length === 2,
  `${(live.match(/usePathDraftPreview\(\{/gu) ?? []).length} of 2 pickers call it`)
check('...and render the narrowed rows, not the raw listing',
  (live.match(/narrowDirectoryEntries\(listing, fragment\)/gu) ?? []).length === 2)
check('neither picker resets the draft when the input loses focus',
  !/onBlur: \(\) => setPathDraft/u.test(live),
  'a blur reset un-filters the list between the two clicks of a double click')
check('the cross-directory branch debounces its listing (the fragment branch never asks)',
  (live.match(/\}, PATH_PREVIEW_DEBOUNCE_MS\)/gu) ?? []).length === 1)
check('a debounced listing is cancelled when the draft moves on',
  (live.match(/clearTimeout\(timer\)/gu) ?? []).length >= 2)
check('the pause is a short human-scale delay, not a second',
  Number.isInteger(DEBOUNCE) && DEBOUNCE > 0 && DEBOUNCE <= 500, String(DEBOUNCE))

// ---- picking a row is what the verb acts on ---------------------------------

// A single click used to do nothing here, so acting on a subdirectory meant
// entering it first. It now PICKS the row, and the pick is the target the dialog
// sends: these assertions run the shipped components and read the POST body, so
// a pick that is only paint (or a button still sending the listed directory)
// fails here rather than in the user's workspace list.
console.log('[picking a row]')

{
  const browser = makeDialog({
    name: 'DirectoryBrowser',
    props: { alias: 'box', onClose () {}, onMount () {}, ctx: {}, t: (key) => key },
  })
  await browser.settle()
  check('nothing is picked before a click',
    browser.rows().length === 2 && browser.rowNode('projects').props['aria-current'] === undefined,
    String(browser.rows().length))
  browser.clickRow('projects')
  check('a single click picks the row, it does not enter it',
    browser.input().props.value === '/home/me/' &&
      browser.rowNode('projects').props['aria-current'] === 'true',
    String(browser.input().props.value))
  check('...and the pick is painted',
    String(browser.rowNode('projects').props.className).includes('sshwsp-entry-picked') &&
      !String(browser.rowNode('Documents').props.className).includes('sshwsp-entry-picked'))
  check('...and the dialog says which directory it will mount',
    browser.find((node) => String(node.props?.className).includes('sshwsp-picked')) !== undefined,
    'the visible path and the acted-on path can disagree with no word about it')
  browser.mountButton().props.onClick()
  await browser.settle()
  check('mounting sends the PICKED directory, not the listed one',
    browser.posts.length === 1 && browser.posts[0].remotePath === '/home/me/projects',
    JSON.stringify(browser.posts[0]))
  check('...with the same host the dialog was opened for',
    browser.posts[0].alias === 'box', String(browser.posts[0].alias))
}

{
  const chooser = makeDialog({
    name: 'RemoteWorkspaceDialog',
    props: { t: (key) => key, busy: false, onCancel () {}, onCreated () {} },
  })
  await chooser.settle(4)
  chooser.clickRow('projects')
  chooser.mountButton().props.onClick()
  await chooser.settle(4)
  check('creating a workspace sends the picked directory too',
    chooser.posts.length === 1 && chooser.posts[0].remotePath === '/home/me/projects',
    JSON.stringify(chooser.posts[0]))
}

{
  // The pick names a row in the listing that was on screen when it was made.
  // Entering another directory replaces that listing, so the pick must go with
  // it — otherwise the mount button keeps acting on a directory the user can no
  // longer see. Picking Documents and then entering projects makes the two
  // answers differ, which is the only way this is observable.
  const browser = makeDialog({
    name: 'DirectoryBrowser',
    props: { alias: 'box', onClose () {}, onMount () {}, ctx: {}, t: (key) => key },
  })
  await browser.settle()
  browser.clickRow('Documents')
  browser.enterRow('projects')
  await browser.settle()
  check('entering a directory drops the pick with the listing that named it',
    browser.rowNode('src') !== undefined &&
      browser.rowNode('src').props['aria-current'] === undefined &&
      browser.find((node) => String(node.props?.className).includes('sshwsp-picked'))?.props.children !== undefined,
    'the pick outlived the listing it was made in')
  browser.mountButton().props.onClick()
  await browser.settle()
  check('...so the button mounts the directory now on screen, not the stale pick',
    browser.posts.length === 1 && browser.posts[0].remotePath === '/home/me/projects',
    JSON.stringify(browser.posts[0]))
}

{
  const browser = makeDialog({
    name: 'DirectoryBrowser',
    props: { alias: 'box', onClose () {}, onMount () {}, ctx: {}, t: (key) => key },
  })
  await browser.settle()
  browser.clickRow('projects', 0)
  check('a keyboard activation picks as well',
    browser.rowNode('projects').props['aria-current'] === 'true')
  browser.clickRow('projects', 0)
  await browser.settle()
  check('...and a second one enters the picked row',
    browser.input().props.value === '/home/me/projects/',
    String(browser.input().props.value))
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
