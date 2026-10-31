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
  check('all four lists are capped (hosts, forwards, mounted, detached)', capped === 4, `found ${capped} wrappers`)
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
  check('both dialogs use the hook',
    count(/useDialogA11y\(\{/gu) === 2, `${count(/useDialogA11y\(\{/gu)} call site(s)`)
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
}


console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
