/**
 * Structural checks on the package manifest and the browser half.
 *
 * The client bundle is loaded by DSH's own front end through the
 * `window.__ModuleLoader__.load(...)` convention (no bundler), and the
 * discovery path depends entirely on package.json metadata — `dsh.client`,
 * `exports["./client"]` and `dsh.bundle.patch`. A wrong field silently keeps
 * the panel out of the boot graph, so this suite pins the shape that
 * discovery relies on. Pure Node, no dependencies: CI-safe.
 *
 * Run: node tests/client-shape-smoke.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

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

console.log('\n=== client shape smoke ===\n')
console.log(`[package root: ${packageRoot}]`)

const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

check('package is ESM', pkg.type === 'module', String(pkg.type))
check('main points at lib/index.js', pkg.main === 'lib/index.js', String(pkg.main))

console.log('\n[dsh.client]')
check('dsh.client is declared', typeof pkg.dsh?.client === 'object' && pkg.dsh.client !== null)
check('platform is web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('inject lists the client-side peers',
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0
    && pkg.dsh.client.inject.every(entry => typeof entry === 'string' && entry.startsWith('@deepseek-ai/')),
  JSON.stringify(pkg.dsh?.client?.inject))

console.log('\n[dsh.bundle.patch]')
check('bundle patch is declared', typeof pkg.dsh?.bundle?.patch === 'string', String(pkg.dsh?.bundle?.patch))
const patchPath = path.join(packageRoot, String(pkg.dsh?.bundle?.patch ?? ''))
check('the patch file exists', existsSync(patchPath), patchPath)
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  check('the patch inserts the plugin row by package name',
    patch.includes(pkg.name),
    patch.slice(0, 120))
}

console.log('\n[exports]')
const clientExport = pkg.exports?.['./client']
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('exports["./client"] resolves to a string path', typeof clientRel === 'string', JSON.stringify(clientExport))
check('the client bundle exists', typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel)), String(clientRel))
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const clientPath = path.join(packageRoot, clientRel)
  check('the client bundle is non-empty', statSync(clientPath).size > 0, String(statSync(clientPath).size))
  const client = readFileSync(clientPath, 'utf8')
  check('the first line uses the __ModuleLoader__ convention', client.split('\n', 1)[0].includes('__ModuleLoader__'),
    client.split('\n', 1)[0].slice(0, 100))
  check('the bundle exports apply()', client.includes('exports.apply'), '(marker not found)')
} else {
  check('the client bundle is non-empty', false, 'bundle missing')
  check('the first line uses the __ModuleLoader__ convention', false, 'bundle missing')
  check('the bundle exports apply()', false, 'bundle missing')
}

console.log('\n[host half]')
check('lib/index.js exists', existsSync(path.join(packageRoot, 'lib/index.js')))
check('lib/client.js is excluded from the host entry points',
  pkg.exports?.['.']?.default !== './lib/client.js', JSON.stringify(pkg.exports?.['.']))

console.log('\n[five-row list cap]')
// Each long list is a scrolling viewport, not a truncation: dropping rows
// would hide a row's controls (a tunnel you cannot see is one you cannot turn
// off). The four sections the cap applies to are pinned here, because losing
// one of the wrappers silently brings back a panel that scrolls for pages.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  check('LIST_CAP is 5', /const LIST_CAP = 5\b/.test(client))
  check('CappedList is defined', /function CappedList \(/.test(client))
  const capped = (client.match(/jsx\(CappedList, \{/g) ?? []).length
  // The four original sections (hosts, forwards, mounted, detached) plus the
  // two the Future work added (self-check, command audit). The assertion is a
  // FLOOR rather than an exact count: adding a section is not a regression,
  // while dropping the cap from one is — so the meaningful check is that every
  // list-like section goes through CappedList at all, which the named list below
  // makes explicit.
  check('every list section is capped (hosts, forwards, mounted, detached, self-check, audit)', capped >= 6, `found ${capped} wrappers`)
  check('the sections that must be capped still are',
    ['sshwsp-hosts', 'sshwsp-forwards', 'sshwsp-mounts', 'sshwsp-check', 'sshwsp-audit'].every(className => client.includes(`className: '${className}'`)),
    JSON.stringify(['sshwsp-hosts', 'sshwsp-forwards', 'sshwsp-mounts', 'sshwsp-check', 'sshwsp-audit'].filter(className => !client.includes(`className: '${className}'`))))
  check('the cap is measured, not assumed from a fixed row height',
    /getBoundingClientRect\(\)\.height/.test(client) && !/LIST_CAP \* \d+px/.test(client))
  check('a short list renders without a reserved scrollbar slot',
    /\.sshwsp-cap \{[^}]*\}/.test(client) && !/\.sshwsp-cap \{[^}]*overflow-y/.test(client),
    'an unconditional overflow-y reserves a gutter on lists that never scroll')
  check('overflow scrolls only once capped', /\.sshwsp-cap-scroll \{[^}]*overflow-y: auto/.test(client))
  check('capped rows drop their own bottom margin (flex does not collapse it)',
    /\.sshwsp-cap > \.sshwsp-card, \.sshwsp-cap > \.sshwsp-mount \{ margin-bottom: 0; \}/.test(client))
}

console.log('\n[stylesheet covers the classes the bundle renders]')
// A class can be rendered without ever being declared. That is invisible until
// someone reads the DOM: the layout pass that added the list cap deleted the
// `.sshwsp-empty` rule as collateral, and every empty / loading / error
// placeholder silently lost its padding and centring. Nothing failed, because
// no test compared what the bundle renders against what the sheet declares.
// Each entry below is a class the panel depends on for MEANING, not decoration.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  for (const className of ['sshwsp-empty', 'sshwsp-mount', 'sshwsp-mount-path', 'sshwsp-entry-meta', 'sshwsp-btn', 'sshwsp-input', 'sshwsp-mount-off', 'sshwsp-check']) {
    // Rendered either as its own class token or inside a multi-class list
    // ("sshwsp-mount sshwsp-mount-off"); the declaration is what this pins.
    check(`.${className} is rendered and declared`,
      client.includes(className) && new RegExp(`\\.${className}\\s*[,{]`).test(client),
      'used in the UI but missing from the injected stylesheet')
  }
} else {
  check('the client bundle is inspectable for declared classes', false, 'bundle missing')
}

console.log('\n[detached rows refuse interaction, not just attention]')
// A detached workspace's row must not only LOOK off — its buttons must stop
// responding. The mark alone is decoration; the pointer-events rule is what
// actually refuses the click, and it is easy to delete without noticing because
// the row still renders, merely greyed.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  check('a detached row declares its actions inert',
    /\[data-sshwsp-disabled="1"\]\s+button[^{]*\{[^}]*pointer-events:\s*none/.test(client),
    'a greyed row whose buttons still fire is a lie the user only discovers by clicking')
  check('...and the selector is generic, because those buttons belong to DSH',
    client.includes('[data-sshwsp-disabled="1"] button'),
    'naming our own class here would miss the sidebar row entirely')
  // The workspace HEADER must stay clickable: expanding it is how the sessions
  // a `detach` deliberately keeps stay reachable. Its own rule must therefore
  // not carry pointer-events. The session rows inside it are the opposite case
  // — the row IS the control that opens the session — and they are scoped by
  // the row key so the two can never be confused for one another.
  check('...while the workspace header itself stays clickable, so its group expands',
    !/(^|,)\s*\[data-sshwsp-disabled="1"\]\s*\{[^}]*pointer-events:\s*none/m.test(client),
    'disabling the header would hide which sessions the detach kept')
  check('...but a detached workspace\'s session rows are fully unreachable',
    /\[data-row-key\^="session:"\]\[data-sshwsp-disabled="1"\]\s*\{[^}]*pointer-events:\s*none/.test(client),
    'the row is the control that opens the session; dimming only its buttons leaves that action live')

  // CSS alone is not enough: `pointer-events: none` blocks the mouse but a row
  // reached with Tab still fires its actions on Enter. The keyboard path needs
  // `inert`, and the undo has to restore what was there rather than assuming
  // nothing was — DSH may have set its own tabindex or aria-disabled.
  check('the detached row also removes its buttons from the tab order',
    client.includes("control.setAttribute('inert', '')") && client.includes("control.setAttribute('tabindex', '-1')"),
    'a keyboard user could still trigger a disabled action')
  check('the undo remembers what it overwrote',
    client.includes('sshwspInertPrior') && /if \(was === null\) control\.removeAttribute\(name\)/.test(client),
    'blindly removing attributes would delete values DSH set itself')
}

console.log('\n[detached workspaces mark their sessions, not just their header]')
// A row keyed `session:<id>` carries no workspace at all, so the membership has
// to be resolved while the workspace is in hand. Greying only the group header
// leaves every session under it a live, clickable session whose workspace I/O
// fence is shut — the exact state the user reports as "sessions aren't greyed".
// This runs the real collector rather than grepping for a string, because the
// bug was a missing assignment, not a missing name.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const start = client.indexOf('function collectRemoteWorkspaces')
  const end = client.indexOf('/** Update the mark source', start)
  check('the collector is extractable for a behaviour test', start !== -1 && end > start, 'collector not found')
  if (start !== -1 && end > start) {
    const sandbox = { remoteMarks: {}, knownDisabledPaths: new Set() }
    const factory = new Function('remoteMarks', 'knownDisabledPaths',
      `${client.slice(start, end)}; return collectRemoteWorkspaces;`)
    const collect = factory(sandbox.remoteMarks, sandbox.knownDisabledPaths)
    collect([
      { id: 'ws-off', path: 'ssh://box/srv/off', title: 'off', sessionIds: ['s1', 's2'] },
      { id: 'ws-on', path: 'ssh://box/srv/on', title: 'on', sessionIds: ['s3'] },
      { id: 'ws-bare', path: 'ssh://box/srv/bare', title: 'bare' },
    ], ['ssh://box/srv/off'])
    check('a detached workspace\'s sessions are collected as disabled',
      JSON.stringify([...sandbox.remoteMarks.disabledSessionIds].sort()) === JSON.stringify(['s1', 's2']),
      JSON.stringify([...sandbox.remoteMarks.disabledSessionIds]))
    check('...a served workspace\'s sessions are not',
      !sandbox.remoteMarks.disabledSessionIds.has('s3'),
      'greyed a session whose workspace is still mounted')
    check('...and a workspace without a membership list does not throw',
      sandbox.remoteMarks.disabledSessionIds instanceof Set,
      'an older host may omit sessionIds entirely')
  }
}

console.log('\n[the unmount hint states BOTH outcomes, and only in the tooltip]')
// The two unmount modes have opposite consequences, so the hint has to name both
// rather than reassure about one: "the record and its sessions are kept" is true
// only while the checkbox is clear, and a user who ticks it and reads that line
// has been told the opposite of what will happen. It also lives in the tooltip
// alone — an always-on line under the row would have to be rewritten as the
// checkbox flips, and a second copy of the same sentence drifts from the first.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const hints = [...client.matchAll(/'mounted\.detachHint': '([^']*)'/g)].map(match => match[1])
  const [zhHint = '', enHint = ''] = hints
  check('both locales define the unmount hint', hints.length === 2, `${hints.length} definition(s)`)
  check('the unmount hint names what happens WITHOUT the checkbox',
    /未勾选/.test(zhHint) && /保留/.test(zhHint),
    zhHint)
  check('...and what happens WITH it',
    /勾选/.test(zhHint) && /归档/.test(zhHint),
    zhHint)
  // The English hint is asserted on its own text, not on the bundle at large:
  // "archived" appears in unrelated keys, so a bundle-wide regex would pass even
  // if this one hint still described only the reversible branch.
  check('...in English too, so the two locales cannot diverge in meaning',
    /without/i.test(enHint) && /archived/i.test(enHint) && /deleted/i.test(enHint),
    enHint)
  check('the hint is carried by the unmount button',
    /title: t\('mounted\.detachHint'\),\s*\n\s*onClick: \(\) => \{ setUnmountConfirm\(wsPath\)/
      .test(client),
    'the button that starts the flow lost its explanation')
  check('...and by the confirm button, which replaces it once armed',
    /title: t\('mounted\.detachHint'\),\s*\n\s*onClick: \(\) => handleUnmount\(wsPath, unmountMode\)/
      .test(client),
    'the tooltip vanishes at the exact moment the click becomes irreversible')
  check('the hint is not duplicated as a standing line in the row',
    !/sshwsp-entry-meta', children: t\('mounted\.detachHint'\)/.test(client),
    'a second copy of the same sentence drifts from the tooltip')
}

console.log('\n[a deliberate disconnect looks like closing the tunnel by hand]')
// The user's requirement: disconnecting the SSH host while a tunnel is open must
// look and read exactly like closing that tunnel from the forward row. The two
// differences that matter are observable: the toast names the tunnels it shut
// down, and no "connection lost" failure line is left behind for a shutdown the
// user asked for. The panel's failure line is driven by the row's `error`, which
// is set only by the unplanned-drop path.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const toasts = [...client.matchAll(/'hosts\.disconnectOkForwards': '([^']*)'/g)].map(match => match[1])
  const [zhToast = '', enToast = ''] = toasts
  check('both locales define the disconnect-with-forwards toast', toasts.length === 2, `${toasts.length} definition(s)`)
  check('the toast states how many tunnels went down',
    /\{n\}/.test(zhToast) && /转发/.test(zhToast), zhToast)
  check('...in English too', /\{n\}/.test(enToast) && /forward/i.test(enToast), enToast)
  check('the disconnect toast is chosen by the count the host reported',
    /closedForwards > 0\s*\n\s*\? t\('hosts\.disconnectOkForwards'\)\.replace\('\{n\}', String\(closedForwards\)\)/
      .test(client),
    'the toast would say the same thing whether or not tunnels were shut down')
  check('a disconnect with no tunnels keeps the plain message',
    /: t\('hosts\.disconnectOk'\)/.test(client),
    'one tunnel-free disconnect would otherwise announce "0 port forwards"')
}

console.log('\n[the bundles parse]')
// Every other check in this file reads the bundle as TEXT, so a file that does
// not even parse still passes them all: the string it greps for is present in a
// broken file just as readily. That happened for real — a stray backtick inside
// a CSS template literal ended the literal early and the whole client bundle
// became a syntax error, while this suite reported against it successfully.
// `node --check` is a parse, not an execution, so it stays dependency-free.
{
  const { spawnSync } = await import('node:child_process')
  const targets = [pkg.main, clientRel, pkg.dsh?.bundle?.patch]
    .filter(entry => typeof entry === 'string' && entry.endsWith('.js'))
  for (const target of targets) {
    const file = path.join(packageRoot, target)
    if (!existsSync(file)) continue
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    check(`${target} parses`, result.status === 0,
      (result.stderr ?? '').split('\n').find(line => line.trim() !== '') ?? `exit ${result.status}`)
  }
}

console.log('\n[publish whitelist]')
const files = pkg.files ?? []
check('lib/ ships in the tarball', files.includes('lib/'), JSON.stringify(files))
check('cordis.patch.yml ships in the tarball', files.includes('cordis.patch.yml'), JSON.stringify(files))
check('tests are not shipped in the tarball', !files.some(entry => String(entry).startsWith('tests')), JSON.stringify(files))

console.log('\n[a11y: the dialog contract]')

// The dialogs already had Esc, aria-labels on icon buttons and focus rings.
// What they lacked is the half that decides whether a keyboard or screen-reader
// user can operate them: dialog semantics, focus moved in on open, focus
// returned to the trigger on close, and a trap so Tab cannot walk behind the
// backdrop into the page.
{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const count = (re) => (source.match(re) ?? []).length
  check('the shared hook exists once, not per dialog',
    count(/function useDialogA11y /gu) === 1, `${count(/function useDialogA11y /gu)} definition(s)`)
  check('the dialog role and modal flag are set',
    /role: 'dialog'/u.test(source) && /'aria-modal': 'true'/u.test(source), 'missing role or aria-modal')
  check('the dialog is labelled by its own title element',
    /'aria-labelledby': titleId/u.test(source) && /id: dialog\.titleId/u.test(source), 'title not wired')
  check('focus moves INTO the dialog on open',
    /focusables\[0\]\.focus\(\)/u.test(source), 'no initial focus')
  check('focus returns to the opener on close',
    /opener\.focus\(\)/u.test(source) && /document\.contains\(opener\)/u.test(source), 'no focus return')
  check('Tab wraps from the last control to the first',
    /document\.activeElement === last/u.test(source) && /first\.focus\(\)/u.test(source), 'no forward wrap')
  check('Shift+Tab wraps from the first control to the last',
    /document\.activeElement === first/u.test(source) && /last\.focus\(\)/u.test(source), 'no backward wrap')
  check('the trap is a capture-phase listener, so it wins over inner handlers',
    /addEventListener\('keydown', onKeyDown, true\)/u.test(source), 'not capture phase')
  check('Esc is ignored while a request is in flight',
    /if \(busyRef\.current\) return/u.test(source), 'Esc not gated on busy')
  check('every dialog uses the hook',
    count(/useDialogA11y\(\{/gu) === 3, `${count(/useDialogA11y\(\{/gu)} call site(s)`)
}

console.log('\n[a11y: the menu contract]')

// The menu had `role="menu"` / `role="menuitem"` and Esc, which is what a
// screen reader needs. It had no keyboard half: opening left focus on the
// trigger, so ArrowDown did nothing and Tab walked out of the popover.
//
// The index arithmetic is EXTRACTED from the source and executed here rather
// than grepped for. A grep for `'ArrowDown'` passes whether the wrapping is
// right or the modulo is wrong — and this repository has already shipped
// assertions of exactly that kind (see O-14 in optimization-and-future.md).
{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const count = (re) => (source.match(re) ?? []).length

  // The client is a Host factory (`window.__ModuleLoader__.load({...})`), so it
  // cannot be imported; the function is self-contained and pure, so slicing it
  // out and evaluating it exercises the real code instead of a copy that can drift.
  const match = source.match(/function nextMenuIndex \(key, current, count\) \{([\s\S]*?)\n {4}\}/u)
  check('the menu index helper is a pure, extractable function', match !== null, 'nextMenuIndex not found')

  if (match !== null) {
    // eslint-disable-next-line no-new-func
    const nextMenuIndex = new Function('key', 'current', 'count', match[1])
    const cases = [
      // [key, current, count, expected]
      ['ArrowDown', 0, 2, 1],
      ['ArrowDown', 1, 2, 0], // wraps past the last item
      ['ArrowUp', 0, 2, 1], // wraps before the first item
      ['ArrowUp', 1, 2, 0],
      ['ArrowDown', -1, 2, 0], // focus still on the trigger
      ['ArrowUp', -1, 2, 1],
      ['Home', 1, 3, 0],
      ['End', 0, 3, 2],
      ['Enter', 0, 2, null], // not a navigation key
      ['Escape', 0, 2, null],
      ['ArrowDown', 0, 0, null], // no items: nothing to focus
      ['ArrowUp', 0, 0, null],
    ]
    for (const [key, current, itemCount, expected] of cases) {
      const actual = nextMenuIndex(key, current, itemCount)
      check(`${key} from ${current} of ${itemCount} goes to ${expected}`,
        actual === expected, `got ${actual}`)
    }
  }

  check('the menu takes focus when it opens',
    /enabledItems\(\)\[0\]\?\.focus\?\.\(\)/u.test(source), 'no initial focus')
  check('focus-on-open is gated on the popover actually being open',
    /if \(!options\.open\) return/u.test(source), 'not gated on open')
  check('disabled items are skipped by the arrow walk',
    /menuitem"\]:not\(\[disabled\]\)/u.test(source), 'disabled items not excluded')
  check('the menu handler is a capture-phase listener',
    /addEventListener\('keydown', onKeyDown, true\)/u.test(source), 'not capture phase')
  check('the menu claims a key only when it owns focus',
    /document\.activeElement !== menuRef\.current/u.test(source), 'claims keys globally')
  check('Tab closes the menu instead of walking into the page behind it',
    /if \(event\.key === 'Tab'\)/u.test(source) && /closeRef\.current\(\)/u.test(source), 'Tab not handled')
  check('the hook is defined once',
    count(/function useMenuKeyboard /gu) === 1, `${count(/function useMenuKeyboard /gu)} definition(s)`)
  check('the menu is wired to the hook',
    count(/useMenuKeyboard\(\{/gu) === 1, `${count(/useMenuKeyboard\(\{/gu)} call site(s)`)
  // A screen reader announces "item N of M" only when BOTH attributes are
  // present; `role="menu"` alone leaves the count to the reader's guess. The
  // position must be derived from the row's index, not written per item, or it
  // drifts the moment a row is added.
  check('each menu item states the set size',
    /'aria-setsize': rows\.length/u.test(source), 'aria-setsize not derived from the row list')
  check('each menu item states its own 1-based position',
    /'aria-posinset': index \+ 1/u.test(source), 'aria-posinset not derived from the row index')
  check('the position is taken from the map callback',
    /rows\.map\(\(row, index\)/u.test(source), 'index not available to the item')
}

// ---------------------------------------------------------------------------
// The panel's empty state: "nothing configured" vs "could not read it"
//
// The route has always shipped `skipped` and `storeError`; the tools and the
// diagnostic report render them. The panel did not, so an unreadable store and
// an empty one produced the same sentence — and that sentence ("no SSH hosts
// configured") is the one a user cannot act on. Rendering the gaps is the
// other half of O-10, not a cosmetic addition.
// ---------------------------------------------------------------------------
{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  check('the panel keeps the listing gaps from the hosts response',
    /setListingGaps\(\{ skipped: hostsData\.skipped \?\? \[\], storeError: hostsData\.storeError \}\)/u.test(source),
    'the response gaps are dropped')
  check('an unreadable store gets its own sentence, not the empty-state one',
    /listingGaps\.storeError !== undefined \? t\('panel\.storeError'\) : t\('panel\.empty'\)/u.test(source),
    'store failure rendered as "empty"')
  check('the store error itself is shown, not just announced',
    /children: String\(listingGaps\.storeError\)/u.test(source), 'the reason is not displayed')
  check('skipped entries are counted in the panel',
    /t\('panel\.skipped'\)\.replace\('\{n\}', String\(listingGaps\.skipped\.length\)\)/u.test(source),
    'skipped entries invisible')
  // Gaps must survive a PARTIAL listing too: a host that exists but cannot be
  // used is exactly the one the user is looking for, and it used to disappear
  // because the rows that did load rendered over it.
  check('gaps are shown alongside rows, not only when the list is empty',
    (source.match(/listingGaps\.skipped\.length > 0 &&/gu) ?? []).length === 2,
    `${(source.match(/listingGaps\.skipped\.length > 0 &&/gu) ?? []).length} render site(s)`)
  check('the empty-state detail has its own style',
    /\.sshwsp-empty-detail \{/u.test(source), 'no style for the detail line')
}

// ---------------------------------------------------------------------------
// The panel renders the self-check as ADVISORY, not as findings
//
// A missing optional tool is a property of the host (often not even changeable
// there), not a malfunction of this session. When the panel listed it among the
// findings, the dot went red on healthy machines and the light stopped being
// read — so the separation has to be visible in the rendering, not only in the
// verdict arithmetic.
// ---------------------------------------------------------------------------
{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  check('the panel renders the advisory rows', /\(diagnosis\.notes \?\? \[\]\)\.length > 0/u.test(source),
    'notes are not rendered at all')
  check('...under their own heading', /t\('diagnosis\.notes', \{ n: /u.test(source),
    'no label separating notes from findings')
  check('...collapsed behind a disclosure, not competing with the findings',
    /jsxs\('details', \{ className: 'sshwsp-diagnosis-notes'/u.test(source), 'notes rendered as a plain block')
  check('...and the two lists are read from different fields',
    /\(diagnosis\.findings \?\? \[\]\)/u.test(source) && /\(diagnosis\.notes \?\? \[\]\)/u.test(source),
    'one of the two lists is missing')
  check('the advisory rows carry no severity badge',
    // The findings row renders a badge; the notes row deliberately does not,
    // because a badge is what makes a row read as a verdict.
    !/sshwsp-diagnosis-notes[\s\S]{0,600}?diagnosis\.warnLabel/u.test(source),
    'notes wear a severity badge')
  check('the advisory block has its own style',
    /\.sshwsp-diagnosis-notes \{/u.test(source), 'no style for the advisory block')
}

// ---------------------------------------------------------------------------
// The diagnostic report: opened in the panel, copied from inside the window.
//
// This section pins the SHAPE of the fix, not "there is a button": the failure
// being prevented is the new-window path, which looks correct in a browser and
// does nothing in the Desktop shell.
// ---------------------------------------------------------------------------
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')

  // Slice the report section out of the panel so the assertions below cannot be
  // satisfied by an unrelated `window.open` elsewhere in the file. Matched
  // without a trailing line ending: the bundle's line endings are not part of
  // what this pins, and a CRLF checkout would otherwise break the slice.
  const start = client.indexOf('// ---- Diagnostic report')
  const end = client.indexOf('// ---- Diagnostic report dialog', start)
  const section = start >= 0 && end > start ? client.slice(start, end) : ''
  const countIn = (re) => (section.match(re) ?? []).length
  check('the report section is locatable', section.length > 0, 'section markers missing')

  check('the "open" control is not an anchor with a target window',
    !/jsx\('a', \{[\s\S]{0,200}?href: API\.supportBundle/u.test(section),
    'a relative href resolves against dsh-app:// and is denied by the window-open policy')
  check('nothing in the report section opens a window',
    !/window\.open\(/u.test(section) && !/target: '_blank'/u.test(section),
    'a new window cannot carry the Host session and cannot be admitted by the Desktop shell')
  check('the report section renders the open control as a single button',
    countIn(/jsx\('button', \{/gu) === 1,
    `${countIn(/jsx\('button', \{/gu)} button(s) — copy moved into the dialog`)

  // The dialog is the mechanism that replaces the window, so it has to exist,
  // be mounted from the panel, and be dismissible like every other dialog.
  check('a report dialog component exists',
    /function ReportDialog \(\{ text, onClose, onCopy, t \}\) \{/u.test(client), 'ReportDialog not defined')
  check('the panel mounts it from fetched text, not from a URL',
    /reportText !== null && jsx\(ReportDialog, \{/u.test(client), 'dialog not mounted')
  check('the report text comes from a fetch of the route',
    /await fetch\(API\.supportBundle\)/u.test(client), 'no fetch of the report route')
  check('the dialog shows the text in a read-only, selectable field',
    /readOnly: true/u.test(client) && /spellCheck: false/u.test(client),
    'a plain <pre> is not selectable enough to copy from by hand')

  // Wrapping replaced sideways scrolling: a report is read line by line, and
  // dragging horizontally to finish a sentence is the step that makes it unread.
  check('the dialog wraps long lines instead of scrolling sideways',
    /wrap: 'soft'/u.test(client) &&
      /\.sshwsp-report-text \{[^}]*white-space: pre-wrap/u.test(client) &&
      /\.sshwsp-report-text \{[^}]*overflow-x: hidden/u.test(client),
    'sideways scrolling makes the reader drag to finish a sentence')

  // Copying moved from the section's toolbar into the report window itself.
  check('the dialog carries its own copy control',
    /onClick: handleCopy/u.test(client) && /children: t\('support\.copy'\)/u.test(client),
    'copy must be reachable from the open report window')
  check('the dialog copies the text already on screen, not a fresh fetch',
    /const copyOpenReport = async \(\) => \{[\s\S]{0,400}?writeText\(reportText\)/u.test(client),
    'a re-fetch could return a different report than the one displayed')
  check('the copy label is the short form, since it sits inside the report',
    /'support\.copy': '复制'/u.test(client) && /'support\.copy': 'Copy'/u.test(client),
    'the dialog button needs no noun — the dialog already says what it is')

  // Opening must NOT select all: the whole report flashes selected while the
  // user is still reading, and any keystroke replaces the selection. Sliced to
  // the component and COUNTED, because a pattern like "no `area.select()` on
  // mount" is trivially satisfied by writing `areaRef.current?.select()`.
  const dlgStart = client.indexOf('function ReportDialog (')
  const dlgEnd = client.indexOf('// Main panel', dlgStart)
  const dlg = dlgStart >= 0 && dlgEnd > dlgStart ? client.slice(dlgStart, dlgEnd) : ''
  const selectSites = (dlg.match(/\.select\(/gu) ?? []).length
  const handleCopyAt = dlg.indexOf('const handleCopy = async () => {')
  const selectAt = dlg.indexOf('.select(')
  check('the report dialog is locatable', dlg.length > 0, 'component not found')
  check('the text is not auto-selected when the dialog opens',
    selectSites === 1 && handleCopyAt >= 0 && selectAt > handleCopyAt,
    `${selectSites} select() call(s) — the only one may be the copy fallback`)
  // ...but a FAILED copy does select it: the user pressed "copy" and must be
  // able to finish it by hand.
  check('a failed clipboard write selects the text for a manual copy',
    /if \(\(await onCopy\(\)\) === true\) return[\s\S]{0,400}?\.select\(\)/u.test(dlg),
    'the copy button would silently do nothing without clipboard permission')

  // One fetch spelling. Asserting the CALL COUNT would just re-state the
  // handlers; the thing worth pinning is that the route is fetched in exactly
  // one place, so no handler can drift in its error handling.
  const fetchSites = (client.match(/fetch\(API\.supportBundle\)/gu) ?? []).length
  check('the report route is fetched in exactly one place',
    /function fetchReportText \(\)/u.test(client) && fetchSites === 1,
    `${fetchSites} fetch site(s) — a second fetch spelling drifts`)

  // ---- the status dot
  //
  // The dot is the one thing the report section could not say before. What is
  // pinned here is the SHAPE of the verdict's rendering, not "a dot exists":
  // a dot that is always green is worse than no dot at all, because it
  // asserts health it never checked.
  check('the report title carries a status dot',
    /className: 'sshwsp-report-title'/u.test(section) && /sshwsp-dot sshwsp-dot-/u.test(section),
    'the verdict needs a mark beside the title, not another sentence')
  check('the dot distinguishes all three states',
    /\$\{diagnosis\.state === 'ok' \? 'ok' : diagnosis\.state === 'warn' \? 'err' : 'warn'\}/u.test(section),
    'ok / warn / unknown must not collapse into two colours — "could not judge" is neither')
  check('the dot is not hardcoded to a single state',
    !/className: 'sshwsp-dot sshwsp-dot-ok'/u.test(section),
    'a literal green dot asserts health nothing checked')
  check('the dot has a role and a label for screen readers',
    /role: 'img'/u.test(section) && /'aria-label': diagnosis\.state === 'ok'/u.test(section),
    'colour alone carries no information for a reader who cannot see it')
  // A red dot that names nothing is a puzzle: the findings must be reachable
  // in the panel, not only inside the pasted report. Asserting only that the
  // class name and `finding.detail` appear is not enough — disabling the list
  // (`.length > 99`) leaves both in the source and the section still renders.
  // So the GUARD is what gets pinned.
  check('the findings are listed in the panel',
    /\(diagnosis\.findings \?\? \[\]\)\.length > 0 && jsxs\('div', \{ className: 'sshwsp-diagnosis'/u.test(section) &&
      /finding\.detail/u.test(section),
    'the dot must be actionable without opening the report')
  check('...and the list is not truncated to nothing',
    !/\(diagnosis\.findings \?\? \[\]\)\.slice\(0, 0\)/u.test(section) &&
      !/\(diagnosis\.findings \?\? \[\]\)\.length > [2-9][0-9]/u.test(section),
    'a list that renders nothing is the same as no list')
  // The verdict is computed on the server from the same fields the report
  // prints, so the two cannot disagree.
  check('the dot reads the server verdict rather than deriving its own',
    /const diagnosis = status\.diagnosis/u.test(client),
    'a client-side re-derivation is a second implementation of the same judgement')

  // The hint no longer claims anything about uploading. It is a statement of
  // what the text CONTAINS; the report's own closing note is where the
  // no-upload stance lives, and saying it twice made it read like a disclaimer.
  check('the panel hint describes the contents only',
    /'support\.hint': '版本、补丁状态/u.test(client) &&
      !/support\.hint': '[^']*不会上传/u.test(client),
    'the hint still carries the upload promise')
}


console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
