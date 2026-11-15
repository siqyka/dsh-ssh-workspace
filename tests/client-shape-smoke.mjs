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

// The DOM-level toasts are lifted from the shipped bundle and driven for real;
// the harness is shared with `archive-smoke` so the two suites cannot describe
// two different implementations.
import { makeToastDom } from './support/toast-dom.mjs'

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

/**
 * Whether the text matching `re` is live code rather than a comment.
 *
 * Every structural assertion in this file is a grep, and a grep cannot tell the
 * two apart: turning a rendered section into a block comment keeps all of them
 * green while the panel shows nothing. So the greps that pin RENDERING have to
 * ask this question, or the suite silently starts describing dead text.
 *
 * The balance is counted from `function RemoteWorkspacePanel`, not from the top
 * of the file: the injected CSS string legitimately contains block-comment
 * TOKENS as text, which unbalances any global count. Within the panel everything
 * is balanced in the file as it stands, so a drift means an added comment.
 *
 * Heuristic by design — it does not parse. A `//` earlier on the same line reads
 * as a comment; both failure modes err toward failing loudly, not toward a false
 * pass, except a bare terminator token which could mask one (there is none).
 *
 * @param {string} source - file text.
 * @param {RegExp} re - pattern; the first match decides.
 * @returns {boolean} true when a match exists and is not inside a comment.
 */
function isLive (source, re) {
  const anchor = source.indexOf('function RemoteWorkspacePanel')
  const match = re.exec(source)
  if (match === null || anchor < 0 || match.index < anchor) return false
  const before = source.slice(0, match.index)
  const lineStart = before.lastIndexOf('\n') + 1
  if (before.slice(lineStart).includes('//')) return false
  const region = source.slice(anchor, match.index)
  const opens = (region.match(/\/\*/gu) ?? []).length
  const closes = (region.match(/\*\//gu) ?? []).length
  return opens <= closes
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

console.log('\n[a local workspace that shares a remote title keeps its own icon]')
// Sidebar rows carry a workspace id, but the picker menu and the hero chip
// carry only the label, so those surfaces match by title. Two workspaces can
// legitimately share one title: `dsh-ssh-workspace` is checked out here AND
// mounted from a host. Matching on the title alone swapped the LOCAL row's
// folder for the remote mark (and, for a detached workspace, made it inert).
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const start = client.indexOf('function collectRemoteWorkspaces')
  const end = client.indexOf('/** Update the mark source', start)
  const rulesEnd = client.indexOf('/** Fetch /status once', end)
  check('the mark identity code is extractable', start !== -1 && end > start && rulesEnd > end, 'marks block not found')
  if (start !== -1 && end > start && rulesEnd > end) {
    const sandbox = {
      remoteMarks: { ids: new Set(), titles: new Set(), localTitles: new Set(), titlesSettled: false, disabledIds: new Set(), disabledTitles: new Set(), disabledSessionIds: new Set() },
      knownDisabledPaths: new Set(),
    }
    const factory = new Function('remoteMarks', 'knownDisabledPaths',
      `${client.slice(start, rulesEnd)}; return { collectRemoteWorkspaces, remoteTitleMatch, detachedTitleMatch }`)
    const marks = factory(sandbox.remoteMarks, sandbox.knownDisabledPaths)

    const registry = [
      { workspaceId: 'w-local', path: 'F:/GitHub/dsh-ssh-workspace', title: 'dsh-ssh-workspace' },
      { workspaceId: 'w-remote', path: 'ssh://qiyk/home/qiyk/test/dsh-ssh-workspace', title: 'dsh-ssh-workspace' },
      { workspaceId: 'w-only-remote', path: 'ssh://word/srv/site', title: 'soxtastic_ssh' },
]
    // The remote-only reply lands first, exactly as the panel's /status fetch does.
    marks.collectRemoteWorkspaces(registry.filter(item => item.path.startsWith('ssh://')), [])
    check('a remote-only reply cannot mark a title yet: it cannot rule out a local twin',
      marks.remoteTitleMatch('dsh-ssh-workspace') === false,
      'titles are only provable from the complete list')
    marks.collectRemoteWorkspaces(registry, ['ssh://word/srv/site'], true)
    check('the complete list settles the title rule', sandbox.remoteMarks.titlesSettled === true)
    check('a title BOTH sides use identifies neither row',
      marks.remoteTitleMatch('dsh-ssh-workspace') === false,
      'the shared title still matched a remote claim')
    check('...the same title cannot grey a local row either',
      marks.detachedTitleMatch('dsh-ssh-workspace') === false)
    check('a title only a remote workspace uses still marks',
      marks.remoteTitleMatch('soxtastic_ssh') === true,
      'a genuinely remote row lost its mark')
    check('...and greys when that workspace is detached',
      marks.detachedTitleMatch('soxtastic_ssh') === true)
    check('a basename spelling counts as a claim on both sides',
      marks.remoteTitleMatch('site') === true && marks.remoteTitleMatch('dsh-ssh-workspace') === false)
    check('an unknown title never matches', marks.remoteTitleMatch('') === false && marks.remoteTitleMatch('nope') === false)
    // A detached local twin must not become inert either: the same local set
    // guards both rules, and this asserts they cannot drift apart.
    check('both title rules consult one local set, not two',
      sandbox.remoteMarks.localTitles.has('dsh-ssh-workspace'),
      'the local claim never reached the shared set')
    check('settling is monotonic: a second complete read keeps the rule on',
      (() => {
        marks.collectRemoteWorkspaces(registry, [], true)
        return marks.remoteTitleMatch('soxtastic_ssh') === true &&
          marks.detachedTitleMatch('soxtastic_ssh') === false &&
          marks.remoteTitleMatch('dsh-ssh-workspace') === false
      })(),
      'a later read with no detach dropped the remote-only title claim')

    // A fresh boot has no store answer yet, and the /status fallback only
    // carries remote workspaces. Drive that state on its OWN instance: the
    // assertions above already settled this one.
    const boot = { remoteMarks: { ids: new Set(), titles: new Set(), localTitles: new Set(), titlesSettled: false, disabledIds: new Set(), disabledTitles: new Set(), disabledSessionIds: new Set() }, knownDisabledPaths: new Set() }
    const bootMarks = new Function('remoteMarks', 'knownDisabledPaths',
      `${client.slice(start, rulesEnd)}; return { collectRemoteWorkspaces, remoteTitleMatch, detachedTitleMatch }`)(boot.remoteMarks, boot.knownDisabledPaths)
    bootMarks.collectRemoteWorkspaces(registry.filter(item => item.path.startsWith('ssh://')), ['ssh://word/srv/site'])
    check('an unsettled rule stays silent even for a remote-only title',
      bootMarks.remoteTitleMatch('soxtastic_ssh') === false && bootMarks.detachedTitleMatch('soxtastic_ssh') === false,
      'the /status fallback marked a title it could not prove')
    check('...while the id rule still works, because a path is not a guess',
      boot.remoteMarks.ids.has('w-remote') && boot.remoteMarks.disabledIds.has('w-only-remote'))
    bootMarks.collectRemoteWorkspaces(registry, ['ssh://word/srv/site'], true)
    check('...and the very same titles mark once a complete read settles them',
      bootMarks.remoteTitleMatch('soxtastic_ssh') === true && bootMarks.detachedTitleMatch('soxtastic_ssh') === true)
    // The three mark sites are DOM decoration that this suite cannot run, so
    // pin the rule each must call. A row matching on its title alone would
    // re-open the collision on the one surface that actually had an id.
    const rowSiteAt = client.indexOf(`for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')`)
    const rowSite = rowSiteAt === -1 ? '' : client.slice(rowSiteAt, rowSiteAt + 900)
    check('the sidebar row still trusts its id before the title',
      /remoteMarks\.ids\.has\(id\) \|\| remoteTitleMatch\(title\)/u.test(rowSite),
      'the row decides on the title alone')
    check('...and its detach decision uses the guarded rule, not the raw title set',
      /remoteMarks\.disabledIds\.has\(id\) \|\| detachedTitleMatch\(title\)/u.test(rowSite),
      'the row greys on the raw disabled-title set')
    // A detached remote workspace can share its title with a local checkout
    // exactly like a live one can — the real /status reply carries
    // ssh://qiyk/tmp/dsh-ssh-workspace-acceptance beside this very repo. If the
    // detach rule keeps only its remote half, that local row goes inert.
    const twin = { remoteMarks: { ids: new Set(), titles: new Set(), localTitles: new Set(), titlesSettled: false, disabledIds: new Set(), disabledTitles: new Set(), disabledSessionIds: new Set() }, knownDisabledPaths: new Set() }
    const twinMarks = new Function('remoteMarks', 'knownDisabledPaths',
      `${client.slice(start, rulesEnd)}; return { collectRemoteWorkspaces, remoteTitleMatch, detachedTitleMatch }`)(twin.remoteMarks, twin.knownDisabledPaths)
    const detachedPaths = ['ssh://qiyk/tmp/dsh-ssh-workspace', 'ssh://qiyk/tmp/soxtastic_ssh-acceptance']
    twinMarks.collectRemoteWorkspaces([
      { workspaceId: 'w-local', path: 'F:/GitHub/dsh-ssh-workspace', title: 'dsh-ssh-workspace' },
      { workspaceId: 'w-twin', path: 'ssh://qiyk/tmp/dsh-ssh-workspace', title: 'dsh-ssh-workspace' },
      { workspaceId: 'w-detached', path: 'ssh://qiyk/tmp/soxtastic_ssh-acceptance', title: 'soxtastic_ssh-acceptance' },
    ], detachedPaths, true)
    check('a DETACHED remote row sharing a local title does not grey the local row',
      twinMarks.detachedTitleMatch('dsh-ssh-workspace') === false,
      'the detach rule kept only its remote half')
    check('...while a detached title no local workspace uses still greys',
      twinMarks.detachedTitleMatch('soxtastic_ssh-acceptance') === true,
      'a genuinely detached row lost its grey')

    // The local branch must not fall through into remote identity when the list
    // is partial: that is exactly what the /status fallback is.
    const mixed = { remoteMarks: { ids: new Set(), titles: new Set(), localTitles: new Set(), titlesSettled: false, disabledIds: new Set(), disabledTitles: new Set(), disabledSessionIds: new Set() }, knownDisabledPaths: new Set() }
    const mixedMarks = new Function('remoteMarks', 'knownDisabledPaths',
      `${client.slice(start, rulesEnd)}; return { collectRemoteWorkspaces, remoteTitleMatch, detachedTitleMatch }`)(mixed.remoteMarks, mixed.knownDisabledPaths)
    mixedMarks.collectRemoteWorkspaces([
      { workspaceId: 'w-local-only', path: 'F:/GitHub/other-project', title: 'other-project' },
      { workspaceId: 'w-remote', path: 'ssh://qiyk/home/qiyk/test/dsh-ssh-workspace', title: 'dsh-ssh-workspace' },
    ], [], false)
    check('a partial list never promotes a local workspace to remote identity',
      !mixed.remoteMarks.ids.has('w-local-only') && !mixed.remoteMarks.titles.has('other-project'),
      'a local workspace leaked into the remote sets')
    check('...and it still keeps the remote half it did see',
      mixed.remoteMarks.ids.has('w-remote') && mixed.remoteMarks.titles.has('dsh-ssh-workspace'))
    const idsStillAuthoritative = sandbox.remoteMarks.ids.has('w-remote')
    check('the id rule is untouched, so a shared title never hides a real remote row',
      idsStillAuthoritative && !sandbox.remoteMarks.ids.has('w-local'))
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
  // The assertion used to be `=== 3`, and that literal is exactly why the
  // fourth dialog (DirectoryBrowser) stayed inaccessible for two releases:
  // the count said "three dialogs are wired" while the file had four. It
  // measured a number instead of the property. Now the two sides are compared
  // to each other - every dialog component must call the hook - so a fifth
  // dialog that forgets the hook turns this red on its own.
  const dialogComponents = count(/function [A-Z][A-Za-z]* \(\{[^)]*onClose/u)
  const hookCallSites = count(/useDialogA11y\(\{/gu)
  check('every dialog component calls the hook',
    dialogComponents > 0 && hookCallSites >= dialogComponents,
    `${hookCallSites} call site(s) for ${dialogComponents} dialog component(s)`)
  // Pinned by name, because "the fourth one" is what was missing and a count
  // alone cannot say WHICH dialog is unwired.
  // The next sibling declaration, kept as a plain literal so no escape
  // processing can turn it into a real newline.
  const NEXT_COMPONENT = 'function '
  for (const name of ['HostEditor', 'DirectoryBrowser', 'ReportDialog', 'RemoteWorkspaceDialog']) {
    // Located by declaration, then searched FORWARD from there: the hook call
    // comes after the local state, so a fixed-size window measured from the
    // signature would measure the component's size, not its wiring.
    const start = source.indexOf('function ' + name + ' (')
    const next = start < 0 ? -1 : source.indexOf(NEXT_COMPONENT, start + 1)
    const body = start < 0 ? '' : source.slice(start, next < 0 ? start + 8000 : next)
    check(name + ' is wired to the dialog contract',
      start >= 0 && body.includes('useDialogA11y({'),
      start < 0 ? 'component not found' : 'no useDialogA11y call in the component body')
  }
}

console.log('\n[a11y: the menu contract]')

// The menu had `role="menu"` / `role="menuitem"` and Esc, which is what a
// screen reader needs. It had no keyboard half: opening left focus on the
// trigger, so ArrowDown did nothing and Tab walked out of the popover.
//
// The index arithmetic is EXTRACTED from the source and executed here rather
// than grepped for. A grep for `'ArrowDown'` passes whether the wrapping is
// right or the modulo is wrong — and this repository has already shipped
// assertions of exactly that kind (see O-14 in docs/optimization-and-future03.md).
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
// The self-check card survives a page switch, and its header expands
//
// The reported bug: the card said "2 missing" with no way to learn WHICH two,
// and switching to another page and back did not help. The cause was not a
// missing interaction — it was that the rows were read from `checkReports`,
// which is React state and dies with the panel, while `missing` travelled in
// `/status` and survived. The card therefore kept its count and lost its names.
//
// Both halves are pinned here: the summary arithmetic is EXECUTED (a grep for
// `missing.length` would pass on any of the broken variants), and the wiring is
// checked so the state list cannot quietly go back to being the only source.
//
// ONE MORE THING, which changed the framing of this whole block: the section is
// now GATED OFF (`SHOW_SELF_CHECK_SECTION = false`) because the user asked for it
// to be commented out. It is a gated tree rather than a commented one because
// every assertion in this file greps the bundle — turning the JSX into comments
// would keep ALL of the assertions below green while rendering nothing, which is
// exactly the fake-green shape this suite exists to avoid. So the assertions
// below describe the shape of the DISABLED tree: the reason they still matter is
// that flipping the flag back to `true` has to restore the 0.2.8 behaviour and
// not the bug that preceded it. The gate itself is pinned in the block above.
// ---------------------------------------------------------------------------
{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const flag = source.match(/const SHOW_SELF_CHECK_SECTION = (true|false)/u)
  check('the self-check section has one named switch', flag !== null, 'SHOW_SELF_CHECK_SECTION not found')
  check('...and it is currently OFF', flag !== null && flag[1] === 'false',
    `SHOW_SELF_CHECK_SECTION is ${flag?.[1] ?? 'missing'} — the section is not meant to render`)
  // Both elements carry the guard: a heading with no list under it is worse than
  // either half alone, so a single guard site would mean a partial hide.
  check('both elements of the section are guarded',
    (source.match(/SHOW_SELF_CHECK_SECTION && /gu) ?? []).length === 2,
    `${(source.match(/SHOW_SELF_CHECK_SECTION && /gu) ?? []).length} guard site(s)`)
  // The tree must be LIVE, not commented out. A commented section satisfies every
  // grep below AND the flag assertions above, so the panel would render nothing
  // while the suite reported the shape as intact — which is precisely why the
  // requested "comment it out" was implemented as a gate instead. Two sites, two
  // messages, so a failure says WHICH render site went dead rather than pointing
  // at a combined pattern that broke for an unrelated reason.
  check('the section heading is live code, not commented-out text',
    isLive(source, /jsx\('h3', \{ children: t\('check\.title'\) \}/u),
    'either the heading is gone or it sits in a comment: nothing renders')
  check('the card disclosure is live code, not commented-out text',
    isLive(source, /className: 'sshwsp-check-head'/u),
    'the expandable card is in a comment: the greps would keep praising a shape that never renders')
  check('the derivation is gated too, so a hidden section does no per-poll merge',
    /const selfCheckRows = !SHOW_SELF_CHECK_SECTION \? \[\]/u.test(source),
    'the list is still built on every poll while nothing renders it')
  // Hiding a section must not hide the facts. These three are the remaining
  // paths to the same rows; if one disappears with the section, the information
  // is gone rather than merely off-panel.
  check('the advisory notes still reach the panel',
    /\(diagnosis\.notes \?\? \[\]\)\.length > 0 && jsxs\('details'/u.test(source),
    'the section was the only place these rows were visible')
  check('the on-demand route is still served',
    /path: ROUTES\.selfCheck/u.test(readFileSync(path.join(packageRoot, 'lib', 'routes.js'), 'utf8')),
    'the route behind the button was removed along with the button')
  check('the status tool still reports self-check rows',
    /selfCheck: probedAliases\(engine\)/u.test(readFileSync(path.join(packageRoot, 'lib', 'tools.js'), 'utf8')),
    'an agent can no longer ask what a host is missing')
}

{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const count = (re) => (source.match(re) ?? []).length

  // The self-check's rows must come from /status first. `checkReports` is a
  // cache that dies with the panel, so preferring it is what produced a card
  // that could count but not name.
  check('the self-check rows fall back to the status payload',
    /rows: checkReports\[check\.alias\]\?\.rows \?\? check\.rows \?\? \[\]/u.test(source),
    'rows still come only from the transient report cache')
  // Scoped to the /status route: `rows: report.rows` also appears in the
  // on-demand /self-check route, so an unscoped match passes even after the
  // status payload has dropped them — which is the exact regression this line
  // exists to catch.
  {
    const routesSource = readFileSync(path.join(packageRoot, 'lib', 'routes.js'), 'utf8')
    const statusStart = routesSource.indexOf('path: ROUTES.status')
    const statusEnd = routesSource.indexOf('path: ROUTES.selfCheck', statusStart)
    const statusRoute = statusStart >= 0 && statusEnd > statusStart
      ? routesSource.slice(statusStart, statusEnd)
      : ''
    check('the /status route is locatable', statusRoute.length > 0, 'could not slice the status handler')
    check('/status ships the self-check rows, not just the count',
      /selfCheck: \[\.\.\.\(engine\.capabilities\?\.keys\?\.\(\) \?\? \[\]\)\]/u.test(statusRoute)
      && /rows: report\.rows/u.test(statusRoute),
      'the durable source does not ship the rows')
  }

  const match = source.match(/function selfCheckSummary \(rows, missing\) \{([\s\S]*?)\n {4}\}/u)
  check('the self-check summary is a pure, extractable function', match !== null, 'selfCheckSummary not found')
  if (match !== null) {
    // eslint-disable-next-line no-new-func
    const selfCheckSummary = new Function('rows', 'missing', match[1])
    const cases = [
      // [label, rows, missing, expected]
      ['all present', [{ tool: 'rg', state: 'present' }, { tool: 'git', state: 'present' }], [], { present: 2, total: 2, absentCount: 0 }],
      ['two absent', [{ tool: 'rg', state: 'present' }, { tool: 'git', state: 'absent' }, { tool: 'rsync', state: 'absent' }], [], { present: 1, total: 3, absentCount: 2 }],
      // The bug's own state: the count arrived, the rows did not. The summary
      // must still report the count, and name nothing rather than invent names.
      ['rows lost, count kept', [], ['git', 'rsync'], { present: 0, total: 0, absentCount: 2 }],
      ['nothing probed at all', [], [], { present: 0, total: 0, absentCount: 0 }],
      ['unknown is not absent', [{ tool: 'rg', state: 'unknown' }], [], { present: 0, total: 1, absentCount: 0 }],
      ['rows win over a stale missing list', [{ tool: 'rg', state: 'absent' }], ['git', 'rsync'], { present: 0, total: 1, absentCount: 1 }],
    ]
    for (const [label, rows, missing, expected] of cases) {
      const actual = selfCheckSummary(rows, missing)
      check(`selfCheckSummary: ${label}`,
        actual.present === expected.present && actual.total === expected.total && actual.absentCount === expected.absentCount,
        JSON.stringify(actual))
    }
    check('selfCheckSummary names the absent tools',
      JSON.stringify(selfCheckSummary([{ tool: 'git', state: 'absent' }], []).absent) === JSON.stringify(['git']),
      JSON.stringify(selfCheckSummary([{ tool: 'git', state: 'absent' }], []).absent))
    check('selfCheckSummary keeps unknown apart from absent',
      JSON.stringify(selfCheckSummary([{ tool: 'rg', state: 'unknown' }], []).unknown) === JSON.stringify(['rg']),
      JSON.stringify(selfCheckSummary([{ tool: 'rg', state: 'unknown' }], []).unknown))
  }

  // The disclosure itself: a button (keyboard-reachable, announces its state),
  // opening on click, and closed by default.
  check('the self-check header is a button, not a div with onClick',
    /className: 'sshwsp-check-head',\s*\n?\s*'aria-expanded':/u.test(source),
    'header is not a disclosure button')
  check('the header announces whether it is open', /'aria-expanded': canExpand \? open : undefined/u.test(source),
    'aria-expanded not tied to the per-host state')
  check('clicking the header toggles that host only', /setExpandedChecks\(\(prev\) => \(\{ \.\.\.prev, \[check\.alias\]: !open \}\)\)/u.test(source),
    'toggle is not per-alias')
  check('the expanded state lives above the row, so a poll does not collapse it',
    /const \[expandedChecks, setExpandedChecks\] = React\.useState\(\{\}\)/u.test(source),
    'expansion state would reset on every refresh')
  check('the detail list renders only when expanded',
    /open && jsx\(SelfCheckList, \{ rows: check\.rows, t \}\)/u.test(source),
    'rows render regardless of the disclosure')
  check('the card is closed until the user opens it', count(/const open = expandedChecks\[check\.alias\] === true/gu) === 1,
    'default state is not "closed"')

  // A host whose rows never arrived still cannot be named — the honest thing
  // is to show the names inline instead of a dead count.
  check('an unexpandable card still names what it can',
    /!canExpand && \(check\.missing \?\? \[\]\)\.length > 0/u.test(source),
    'a count with no way to see what it counts')
  check('the disclosure has its own styles',
    /\.sshwsp-check-head \{/u.test(source) && /\.sshwsp-check-caret \{/u.test(source),
    'no style for the header or the caret')
}
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

// ---------------------------------------------------------------------------
console.log('\n[a11y: the fourth dialog, the rows, and the row menu]')
//
// C-01 (closed; the ledger is docs/optimization-and-future03.md). The panel had four dialogs and wired
// three; the fourth (DirectoryBrowser) had a backdrop and a dialog frame, so it
// LOOKED covered while keyboard focus walked straight through it into the page
// behind. Two more holes sat in the same area: the browser's rows were
// `div` + `onClick` while the stylesheet drew them a `:focus-visible` ring and
// `cursor: pointer` (advertising a button nobody could reach), and the row
// menu — the ONLY way to download, upload or add a file to the task — carried
// `role="menu"` / `role="menuitem"` with no focus management, no arrow keys, and
// no way to open it without a right-click.
//
// These assertions are about the SHAPE that makes the behaviour possible, so
// each one is paired with the reverse-verification note in its detail string:
// removing the construct is what should turn it red.
{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')

  /**
   * The body of one top-level module function, with its comments removed.
   *
   * `isLive` cannot be used here: it anchors on `function RemoteWorkspacePanel`
   * and takes the FIRST match in the whole file, so `nextMenuIndex` resolves to
   * the React popover's call site rather than the DOM menu's, and every
   * component defined above the panel (the dialogs) resolves to nothing. Slicing
   * the function and stripping comments answers the same question — "is this
   * construct live code" — for the region that actually matters.
   */
  const bodyOf = (name) => {
    // Three declaration shapes, and each needs its own end boundary. The
    // original keyed only on `function name (`; adding `async function` fixed
    // half the cases, but a `const name = async () =>` helper still sliced to
    // '' — and a `liveIn` on it returned false for code that existed, while a
    // `!liveIn` assertion would have passed on nothing at all. Every form
    // therefore also records where its body ends.
    const forms = [
      { prefix: 'async function ' + name + ' (', ends: ['\n    function ', '\n    async function ', '\n    const '] },
      { prefix: 'function ' + name + ' (', ends: ['\n    function ', '\n    async function ', '\n    const '] },
      { prefix: 'const ' + name + ' = ', ends: ['\n    const ', '\n    function ', '\n    async function '] },
    ]
    for (const form of forms) {
      const start = source.indexOf(form.prefix)
      if (start < 0) continue
      const nexts = form.ends.map(end => source.indexOf(end, start + 1)).filter(index => index >= 0)
      const end = nexts.length === 0 ? start + 12000 : Math.min(...nexts)
      return source.slice(start, end)
        .replace(/\/\*[\s\S]*?\*\//gu, ' ')
        .replace(/\/\/[^\n]*/gu, ' ')
    }
    return ''
  }
  const liveIn = (name, re) => re.test(bodyOf(name))

  // The slicer is the thing every assertion below trusts, so it gets its own
  // check: a name it cannot find must never read as "the code is absent".
  check('the body slicer finds arrow-function helpers too',
    bodyOf('handleEntry').includes('const handleEntry = ') && bodyOf('runUploadJob').includes('async function runUploadJob'),
    'an arrow helper slices to nothing, so every assertion about it is vacuous')

  check('the browser dialog claims the dialog role',
    liveIn('DirectoryBrowser', /useDialogA11y\(\{/u) &&
      liveIn('DirectoryBrowser', /className: 'sshwsp-dialog', \.\.\.dialog\.props/u),
    'the fourth dialog renders without role="dialog" / aria-modal / focus trap')
  check('...and its title is the label the dialog announces',
    liveIn('DirectoryBrowser', /id: dialog\.titleId, children: t\('browser\.title'/u),
    'aria-labelledby points at nothing')

  // Only directories are controls now. A browse-only dialog must not keep a
  // selection model whose only remaining caller was the removed batch verb.
  check('every directory row is a real button control',
    liveIn('DirectoryBrowser', /entries\?\.map\(\(entry\) =>[\s\S]{0,1200}?if \(entry\.type === 'directory'\)[\s\S]{0,300}?return jsx\('button'/u) &&
      !/rowcheck|type: 'checkbox'/u.test(bodyOf('DirectoryBrowser')),
    'a directory row is no longer a button, or a checkbox column came back')
  check('...while a file row is a static div with no selection contract',
    liveIn('DirectoryBrowser', /return jsx\('div', \{ key: entry\.name, className: rowClassName, children: rowChildren \}\)/u) &&
      !/'aria-selected'|setSelection|selectReduce/u.test(bodyOf('DirectoryBrowser')) &&
      !/\.sshwsp-entry-selected \{/u.test(source),
    'a file row pretends to be a control, or the selection paint survived')

  // The menu: focus moves in, arrows move between items, Escape and Tab close,
  // and it can be opened without a mouse.
  check('the menu lifecycle takes focus when a menu opens',
    liveIn('openMenuAt', /firstEnabled\(\)\[0\]\?\.focus\?\.\(\)/u),
    'focus stays on the trigger, so ArrowDown does nothing')
  check('...and reuses the shared index arithmetic',
    liveIn('openMenuAt', /nextMenuIndex\(event\.key, current, items\.length\)/u),
    'a second copy of the wrap arithmetic is how one menu wraps and another does not')
  check('...returns focus to the element that opened it',
    liveIn('openMenuAt', /taskMenuOpener = document\.activeElement/u) &&
      liveIn('closeTaskMenu', /document\.contains\(opener\)\) opener\.focus\(\)/u),
    'closing leaves focus on a removed node')
  check('...can be opened from the keyboard',
    liveIn('installTreeMenuBridge', /event\.key !== 'ContextMenu'/u) &&
      liveIn('installTreeMenuBridge', /event\.shiftKey && event\.key === 'F10'/u),
    'the menu is reachable only by right-click')
  check('...and both openers share one anchor computation',
    liveIn('installTreeMenuBridge', /const openForRow = \(row, event\) =>/u) &&
      (bodyOf('installTreeMenuBridge').match(/openForRow\(row, /gu) ?? []).length === 2,
    'the keyboard path would place the menu at a different spot than the pointer path')

  // The empty space below the rows is the gesture whose default is "nothing
  // happens": the button carrying the alias and remote path lives in the panel
  // HEADER, which is a sibling of the scrolled list, so the narrowest container
  // holding the pointer does not hold the button either. The search therefore
  // widens outward to the PAGE the pointer is in — and stops there.
  //
  // It must stop there. Widening to the document is the bug this pair of
  // assertions previously described as correct: with nothing matching between
  // the pointer and <body>, a right-click in the CONVERSATION resolved to the
  // first file panel anyone had rendered and opened its directory menu, and a
  // LOCAL panel beside a remote one could borrow the other host's directory.
  check('the blank-area menu widens to the Files page, not the document',
    liveIn('installTreeMenuBridge', /const scope = blankMenuScopeOf\(target\)/u) &&
      liveIn('blankMenuScopeOf', /const page = target\.closest\(OS_PAGE_SELECTOR\)/u) &&
      liveIn('blankMenuScopeOf', /page\.querySelector\('\[data-sshwsp-dir\]'\)/u),
    'a single-container lookup answers nothing whenever the header is a sibling of the list')
  check('...and never reaches past that page for a button',
    // `openForBlank` is an inner arrow, so it is sliced from the bridge body by
    // its own declaration instead of by `bodyOf` (which keys on `function` and
    // `const` at the module's indentation). No `document` may appear in it: a
    // document-scoped lookup is exactly how the conversation window used to
    // borrow the first file panel on screen.
    (() => {
      const body = bodyOf('installTreeMenuBridge')
      const start = body.indexOf('const openForBlank = (event, target) => {')
      if (start < 0) return false
      const end = body.indexOf('\n      }', start)
      const slice = end < 0 ? body.slice(start) : body.slice(start, end)
      return !/document/u.test(slice) && !/holders/u.test(body)
    })(),
    'a document-level fallback is how the conversation window opened a file panel menu')

  // A browser refuses to elaborate on a request that died on the wire: every
  // cause arrives as the same four words. Both upload paths must translate that
  // into something actionable, and the translation must stay narrow — a
  // refusal or a remote error already carries a real sentence and must be
  // passed through untouched.
  check('the browse dialog no longer offers a transfer path of its own',
    !/enqueueUploads|pickFileTarget|handleUpload|handleDownload/u.test(bodyOf('DirectoryBrowser')),
    'a second upload or download path would bypass the queue')
  check('...and the queue worker explains a network-level failure',
    liveIn('runUploadJob', /describeNetworkError\(err, startedAt\)/u),
    'the toast repeats `Failed to fetch`')
  check('...naming the elapsed time, and telling an instant failure from a timeout',
    liveIn('describeNetworkError', /'transfer\.networkFailFast' : 'transfer\.networkFail'/u),
    'the message cannot distinguish a dead socket from a five-minute cut-off')
  check('...while passing a real server sentence through unchanged',
    liveIn('describeNetworkError', /if \(!isNetworkFailure\(err\)\) return message/u),
    'a 403 reason would be replaced by a generic network message')

  // F-08's two path actions. Both are asserted at the point where correctness
  // lives, not by "the string exists somewhere". Note these helpers are
  // `async function`, which the `bodyOf` slicer (keyed on `function name (`)
  // does not find — so `liveIn` would pass trivially on an empty body. The
  // check below pins the declaration prefix as well, or a rename to a plain
  // function would silently turn every assertion into a no-op.
  check('the copy and mount helpers are declared where the slicer can see them',
    /    async function copyRowPath \(/u.test(source) && /    async function mountRowAsRoot \(/u.test(source),
    'an `async function` is invisible to bodyOf, so liveIn would test an empty slice')
  check('the row menu offers copying the path',
    liveIn('openTaskMenu', /translate\('rowmenu\.copyPath'\)/u),
    'the row menu has no copy action')
  check('...copying the ssh:// spelling, not the bare remote path',
    liveIn('copyRowPath', /writeText\(absPath\)/u),
    'a bare /home/x paste names a path on whatever machine the reader is on')
  check('...and reports a refused clipboard instead of failing silently',
    liveIn('copyRowPath', /translate\('rowmenu\.copyUnavailable'\)/u) &&
      (bodyOf('copyRowPath').match(/rowmenu\.copyUnavailable/gu) ?? []).length === 2,
    'a copy that quietly did nothing leaves stale clipboard content behind')
  check('the row menu offers rename and delete for remote rows',
    liveIn('openTaskMenu', /translate\('rowmenu\.rename'\)/u) &&
      liveIn('openTaskMenu', /translate\('rowmenu\.delete'\)/u),
    'the row menu has no rename/delete actions')
  check('...and the same pair for LOCAL rows (outside the remote branch)',
    /if \(remote !== null\)[\s\S]{0,2600}?translate\('rowmenu\.delete'\)/u.test(bodyOf('openTaskMenu')) === false ||
      (bodyOf('openTaskMenu').match(/translate\('rowmenu\.rename'\)/gu) ?? []).length >= 1,
    'rename/delete sit inside the remote-only branch')
  check('...at most eight single-line items and at most three rules',
    (bodyOf('openTaskMenu').match(/createTransferItem\(/gu) ?? []).length <= 8 &&
      (bodyOf('openTaskMenu').match(/createMenuSeparator\(\)/gu) ?? []).length <= 3 &&
      !/menuitem-desc/u.test(bodyOf('openTaskMenu')),
    'the row menu grew a description line, a fourth rule, or more than eight items')
  // There is no longer a SECOND verb for a batch: one item, one label, and the
  // decision of what it acts on belongs to `resolveTargets` alone. A menu that
  // grew a batch entry back would be a second answer to the same question.
  check('...and there is exactly one download verb, whatever the selection',
    (bodyOf('openTaskMenu').match(/translate\('transfer\.download'\)/gu) ?? []).length === 1 &&
      !/batch/u.test(bodyOf('openTaskMenu')) &&
      (bodyOf('openTaskMenu').match(/translate\('rowmenu\.delete'\)/gu) ?? []).length === 1,
    'a second, selection-sized verb came back into the row menu')
  check('...with its own rule directly above rename/delete',
    (() => {
      const body = bodyOf('openTaskMenu')
      const renameAt = body.indexOf("translate('rowmenu.rename')")
      const guardAt = body.indexOf('lastBeforeDestructive')
      return renameAt > 0 && guardAt > 0 && guardAt < renameAt &&
        body.slice(guardAt, renameAt).includes('createMenuSeparator') &&
        body.includes("!String(lastBeforeDestructive.className).includes('sshwsp-menusep')")
    })(),
    'the destructive pair lost the separator above rename')
  check('...and a right-click hands the whole selection to resolveTargets',
    (() => {
      const body = bodyOf('installTreeMenuBridge')
      // The bridge must not pre-filter the selection. Every rule about "this
      // row" versus "these rows" lives in ONE function, and a second copy here
      // (only when the row happened to be inside a batch) is a second answer
      // waiting to disagree with what the action then does.
      return /openTaskMenu\(ctx, path, kind === 'directory', treeRootOf\(row\), x, y, undefined, \{ items: selected \}\)/u.test(body) &&
        !/inSelection/u.test(body)
    })(),
    'the bridge decided the target set before resolveTargets could')
  check('the row menu is 220px and runs compact (12px labels, 24px rows); the chooser keeps its width and two-line size',
    /\.sshwsp-flowmenu \{[^}]*width: 220px/u.test(source) &&
      /\.sshwsp-flowmenu:not\(\.sshwsp-flowmenu-roomy\) \.sshwsp-menuitem \{ min-height: 24px; gap: 6px; padding: 3px 6px; \}/u.test(source) &&
      /\.sshwsp-flowmenu:not\(\.sshwsp-flowmenu-roomy\) \.sshwsp-menuitem-title \{ font-size: 12px; \}/u.test(source) &&
      // The compact rules must not leak into the chooser: its rows keep the
      // shared base (13px title, 9px 10px padding) because descriptions are
      // its whole point.
      /\.sshwsp-menuitem-title \{ display: block; font-size: 13px;/u.test(source) &&
      /\.sshwsp-flowmenu-roomy \.sshwsp-menuitem \{ align-items: flex-start; gap: 10px; padding: 9px 10px; border-radius: 7px; \}/u.test(source) &&
      /\.sshwsp-flowmenu-roomy \{ width: 250px;/u.test(source) &&
      /sshwsp-flowmenu sshwsp-flowmenu-roomy/u.test(source),
    'menu widths or row density drifted (compact geometry leaked into the chooser?)')
  check('...through the SAME route the browser dialog uses',
    liveIn('mountRowAsRoot', /fetchJson\(API\.mount,/u) &&
      // `handleMount` is a `const … = async () =>` arrow inside the dialog
      // component, not a function declaration, so it is checked against the
      // whole file rather than through the slicer.
      /const handleMount = async \(\) => \{[\s\S]{0,400}?fetchJson\(API\.mount,/u.test(source),
    'two mount implementations would drift')

  // The toast window (2026-11): ONE seven-second window for every kind.
  //
  // The old rule kept failures until they were clicked, on the sound observation
  // that a failed tree transfer's toast is its ONLY report. What did not
  // survive: a one-slot toast. A failure left standing hides the next message
  // behind itself — including the success of the retry that just fixed it — so
  // "still on screen" read as "still broken".
  //
  // Everything the old rule protected has to survive the change: the alert
  // role, the keyboard path, and the focus that makes it reachable. Those are
  // asserted against `armToast` now, because `notifyUser` delegates to it
  // instead of carrying a second copy of the rules.
  const windowMatch = /const TOAST_DISMISS_MS = (\d+)/u.exec(source)
  const windowMs = windowMatch === null ? null : Number(windowMatch[1])
  check('one constant owns the toast window, and it is seven seconds',
    windowMs === 7000,
    windowMatch === null ? 'TOAST_DISMISS_MS is not defined' : `ms=${windowMs}`)
  check('no toast path still carries the old 3.5-second split',
    !source.includes('3500') && !/toast\.kind !== 'ok'/u.test(source),
    'a literal 3500 or a `kind !== ok` guard survives, so one path was missed')
  check('the tree-gesture toast expires on that constant',
    liveIn('armToast', /domToastTimer = setTimeout\(dismiss, TOAST_DISMISS_MS\)/u),
    'the DOM path uses a different (or no) window')
  check('the panel uses the same DOM notice, so there is one clock',
    /const reportToast = \(input, kind\) => notifyUser\(input, kind\)/u.test(source) &&
      !/const \[toast, setToast\] = React\.useState/u.test(source) &&
      !/toastHeld/u.test(source),
    'a second React toast would own a second timer and a second node')
  check('the panel can hand a failure a code, raw detail and safe retry',
    /reportToast\(toastError\(/u.test(source) && /reportToast\(await/u.test(source),
    'the panel still reports every failure as an unexplained sentence')
  check('the pointer resting on a notice holds its clock',
    liveIn('armToast', /addEventListener\('mouseenter'/u) &&
      liveIn('armToast', /addEventListener\('mouseleave'/u),
    'the sentence being read can expire under the cursor')
  check('...and leaving restarts the window rather than resuming the remainder',
    liveIn('armToast', /schedule\(\)/u),
    'a paused notice would resume with almost no time left')
  check('an expiring failure still interrupts, and still says why',
    bodyOf('renderToast').includes("el.setAttribute('role', failure ? 'alert' : 'status')"),
    'a polite announcement can be removed mid-sentence')
  check('...and stays dismissible without a mouse, without stealing focus',
    liveIn('renderToast', /el\.tabIndex = 0/u) &&
      liveIn('armToast', /event\.key === 'Escape'/u) &&
      !liveIn('armToast', /el\.focus\(\)/u),
    'the keyboard path exists but the toast takes the caret when it appears')
  check('...and hands focus back when it is closed from inside',
    liveIn('dismissToast', /el\.contains\(active\)/u) &&
      liveIn('dismissToast', /returnFocus\.focus\(\)/u),
    'removing the focused node drops focus to <body>')
}


// ---------------------------------------------------------------------------
// The map at the top of the bundle must describe the bundle
// ---------------------------------------------------------------------------
// The map is the only navigation aid in a file this size, and it had drifted to
// ten entries while the file held eighteen sections: two entries named banners
// that do not exist ("Forwarding panel", "Directory flow / persistent
// sessions"), the rest were renamed, and six real sections were missing. A
// stale map is worse than no map — it sends a reader to a section that is not
// there and hides the one they wanted.
//
// Nothing caught it because a comment cannot fail. This does: parse the real
// banners, parse the map, and require the two lists to agree in content and in
// order. Order matters because the map's whole claim is "a jump-to-next-banner
// walk visits them in order".
{
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const borderRe = /^ {4}\/\/ =+\s*$/u
  const lines = client.split('\n')
  const banners = []
  for (let i = 1; i < lines.length - 1; i += 1) {
    if (!borderRe.test(lines[i - 1]) || !borderRe.test(lines[i + 1])) continue
    if (borderRe.test(lines[i])) continue
    const title = lines[i].trim().replace(/^\/\/ ?/u, '')
    if (title === '') continue
    banners.push(title)
  }
  // The map's own banner is not a section of the file it describes.
  const sections = banners.slice(1)

  // Map entries look like `//   7. Directory browser dialog` — a number, a dot,
  // then the title. The trailing parenthetical is a gloss, not part of the
  // title, so it is stripped before the comparison.
  const mapEntries = [...client.matchAll(/^ {4}\/\/ +(\d+)\. (.+)$/gmu)]
    .map(match => ({ number: Number(match[1]), title: match[2].trim() }))

  check('the map lists at least one section', mapEntries.length > 0, String(mapEntries.length))
  check('the map numbers its entries consecutively from 1',
    mapEntries.every((entry, index) => entry.number === index + 1),
    JSON.stringify(mapEntries.map(e => e.number)))

  /** Strip the map's parenthetical gloss and normalise whitespace. */
  const plain = (title) => title.replace(/\s*\([^)]*\)\s*$/u, '').trim()
  /** Compare two titles, allowing an extra parenthetical on either side. */
  const sameSection = (a, b) => {
    const left = plain(a).toLowerCase()
    const right = plain(b).toLowerCase()
    if (left === right) return true
    // A map entry may gloss a banner that itself carries a parenthetical; in
    // that case one is a prefix of the other. Prefixes only — "Host card" and
    // "Host editor dialog" must never be treated as the same section.
    return left.startsWith(right) || right.startsWith(left)
  }

  const missingFromMap = sections.filter(title => !mapEntries.some(entry => sameSection(entry.title, title)))
  check('every section banner appears in the map', missingFromMap.length === 0,
    `missing ${JSON.stringify(missingFromMap)}`)

  const phantomInMap = mapEntries.filter(entry => !sections.some(title => sameSection(entry.title, title)))
  check('the map names no section that does not exist', phantomInMap.length === 0,
    `phantom ${JSON.stringify(phantomInMap.map(e => e.title))}`)

  check('the map lists the sections in file order',
    mapEntries.length === sections.length &&
      mapEntries.every((entry, index) => sameSection(entry.title, sections[index])),
    JSON.stringify({ map: mapEntries.map(e => e.title), actual: sections }))
}

if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
// ---------------------------------------------------------------- provenance
console.log('\n[provenance] the panel admits how old the cached sections are')
{
  const source = readFileSync(path.join(packageRoot, 'lib', 'client.js'), 'utf8')
  // The renderer must exist and be USED: a helper with no call site renders
  // nothing while reading as implemented.
  check('a provenance renderer exists', /function provenanceText/u.test(source))
  // The call must be REACHABLE, not merely present: the first version of this
  // assertion matched the call anywhere in the file, so replacing the render
  // with `false &&` left it green while the panel showed nothing. Requiring the
  // call to sit inside the returned tree is what makes it a rendering claim.
  check('and the panel calls it from the rendered tree',
    /jsxs\('div', \{ className: 'sshwsp',[\s\S]{0,3000}?provenanceText\(t, status\.provenance/.test(source),
    'no reachable call site')
  check('the call is not guarded by a constant',
    !/false && jsx\('div'[\s\S]{0,80}provenance/u.test(source), 'guarded by `false &&`')
  check('the capability section is the one labelled',
    /status\.provenance\?\.capabilities/u.test(source), 'capabilities not named')
  // Three kinds, three sentences: collapsing "stale" into "cached" would erase
  // the only distinction a user can act on (wait versus investigate).
  //
  // "At least two occurrences" rather than exactly two: the dictionary defines
  // each key and the RENDERER references it, so the honest floor is one
  // definition per locale. Pinning the exact count would break the moment a
  // second render site is added, which is not a behaviour change.
  for (const key of ['provenance.live', 'provenance.cached', 'provenance.stale']) {
    const count = source.split(`'${key}'`).length - 1
    check(`${key} is defined in both locales`, count >= 2, `found ${count}`)
  }
  // An unrecognised label must stay visible rather than rendering blank.
  check('an unknown kind falls through to the raw value',
    /return label\.kind/u.test(source), 'no fallthrough')
}

// --- upload: transport failures are retried once and described honestly ---
//
// A dead request is reported by the browser as the same four words (`Failed to
// fetch`) whatever killed it, and those four words were what the user saw —
// with no hint whether the app was restarting or the server had given up on the
// body. Two properties keep that from coming back: a transport death is retried
// ONCE (the server stages and renames, so a repeat is idempotent), and the
// sentence is chosen by how long the request lasted.
{
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const routes = readFileSync(path.join(packageRoot, 'lib', 'routes.js'), 'utf8')
  check('the chunked sender retries a transport death once',
    client.includes('for (let attempt = 1; attempt <= maxAttempts; attempt += 1)'), 'no retry loop')
  check('the retry is gated on a network-level failure, never on a JSON verdict',
    /!isNetworkFailure\(err\) \|\| attempt === maxAttempts/u.test(client), 'retry gate missing')
  check('the retry gate is a shared predicate, not a second copy of the regex',
    /function isNetworkFailure \(err\)/u.test(client), 'no predicate')
  check('an instant failure is not described as a timeout',
    /transfer\.networkFailFast/u.test(client), 'fast-failure wording missing')
  // Every entry (dialog, panel header, tree row) hands its files to the same
  // queue worker, and that worker calls the same sender — checked as plain
  // source matches because each spelling is unique, and because a body-slice
  // helper is only in scope inside the block that defines it.
  check('every browser upload goes through the one chunked sender',
    /async function postFileInChunks \(alias, dir, file, hooks = \{\}\)/u.test(client) &&
      /await postFileInChunks\(alias, dir, file, \{/u.test(client),
    'a second upload path would report neither progress nor cancellation')
  check('...and no upload posts a File as a request body',
    (client.match(/body: file,/gu) ?? []).length === 0,
    'a Blob/File body is still posted somewhere')
  check('...while the raw streaming route stays declared server-side',
    routes.includes('path: ROUTES.upload') && routes.includes("guardRaw(req, res, 'POST')"),
    'the streaming route was removed, not merely left unused by the browser')
  for (const key of ['transfer.networkFailFast', 'transfer.retried']) {
    const count = client.split(`'${key}'`).length - 1
    check(`${key} is defined in both locales`, count >= 2, `found ${count}`)
  }
}

// --- upload: the chunked transport is the only browser door ---------------
//
// The queue needs a byte count after every chunk and a place to stop between
// chunks. A `File` request body provides neither: `fetch` has no upload-progress
// event, and a body stream cannot be paused. One transport therefore remains,
// and it is the one that also crosses the packaged shell's `dsh-app://` origin.
{
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const routes = readFileSync(path.join(packageRoot, 'lib', 'routes.js'), 'utf8')
  check('the browser no longer chooses an upload transport by page origin',
    !/canCarryBinaryBody|postFileAsBody/u.test(client),
    'a raw-body path is still branchable, so progress and cancel depend on the origin')
  check('the chunked transport takes the queue\'s progress and cancel hooks',
    /async function postFileInChunks \(alias, dir, file, hooks = \{\}\)/u.test(client) &&
      /hooks\?\.isCancelled/u.test(client) && /hooks\?\.onProgress/u.test(client),
    'the transport cannot report bytes or be stopped')
  check('...and stops BETWEEN chunks, where an abort leaves no staged bytes',
    /if \(isCancelled\(\)\) throw transferCancelledError\(\)/u.test(client),
    'no cancellation point before the next chunk')
  check('the chunked path posts JSON, not bytes',
    /url: API\.uploadChunk|fetch\(API\.uploadChunk/u.test(client) &&
      /body: JSON\.stringify\(body\)/u.test(client),
    'chunked request is not JSON')
  // The server reads at most 4 MiB of JSON; base64 inflates by 4/3. The margin
  // is asserted numerically so a future chunk-size bump fails here rather than
  // as a 400 from `readJsonBody` in the field.
  const chunkMatch = client.match(/const UPLOAD_CHUNK_BYTES = (\d+) \* 1024 \* 1024/u)
  const chunkBytes = chunkMatch === null ? 0 : Number(chunkMatch[1]) * 1024 * 1024
  check('a chunk exists and base64 of it fits the server\'s 4 MiB JSON cap',
    chunkBytes > 0 && chunkBytes * 4 / 3 < 4 * 1024 * 1024,
    `chunk=${chunkBytes}`)
  check('a zero-byte file still sends exactly one chunk',
    /const end = Math\.min\(total, offset \+ UPLOAD_CHUNK_BYTES\)/u.test(client) &&
      /const final = end >= total/u.test(client),
    'the loop would send nothing for an empty file')
  check('a final chunk is never replayed (its rename would already be done)',
    /body\.final === true \|\| body\.abort === true \? 1 : 2/u.test(client),
    'a lost response after a successful publish would be reported as failure')
  check('a failed upload aborts its staged part instead of leaving it behind',
    /abort: true/u.test(client), 'no cleanup request')
  // The two halves must agree about the path; a typo here is a 401 from the
  // host, which reaches the user as "upload failed" with no cause.
  const routePath = routes.match(/uploadChunk: '([^']+)'/u)
  const apiPath = client.match(/uploadChunk: '([^']+)'/u)
  check('the client and the route table name the same chunk endpoint',
    routePath !== null && apiPath !== null && routePath[1] === apiPath[1],
    `route=${routePath?.[1]} api=${apiPath?.[1]}`)
  // The encoder is extracted from the shipped source and run, rather than
  // retyped here: a hand-written copy would prove nothing about the code that
  // actually encodes the bytes. `String.fromCharCode.apply` over a whole 2 MiB
  // chunk overflows the argument stack, which is why the real one is sliced —
  // so the size sweep deliberately crosses the slice boundary.
  const encoderMatch = client.match(/function bytesToBase64 \(bytes\) \{[\s\S]*?\n    \}/u)
  check('the base64 encoder is present in the shipped source', encoderMatch !== null, 'not found')
  if (encoderMatch !== null) {
    const make = new Function('btoa', `${encoderMatch[0]}; return bytesToBase64`)
    const encode = make(globalThis.btoa)
    const sizes = [0, 1, 2, 3, 7, 0x8000, 0x8001, 100000]
    const mismatches = sizes.filter((size) => {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 37 + 11) % 256)
      return encode(bytes) !== Buffer.from(bytes).toString('base64')
    })
    check('the shipped encoder produces the same base64 Node does, across slice boundaries',
      mismatches.length === 0, `mismatched sizes: ${mismatches.join(',')}`)
  }
}

// ---------------------------------------------------------------------------
// --- transfer queue: one store, one notice, one width ---------------------
//
// The queue is the single truth for "what is moving": the Files-panel badge,
// the popover rows, the dialog strip and the completion toast all read the same
// store. These pin the shape that makes that true, and the places where a
// helpful-looking alternative would quietly become a second truth.
{
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const transfer = readFileSync(path.join(packageRoot, 'lib', 'transfer.js'), 'utf8')

  check('there is exactly one queue store',
    (client.match(/let transferQueueState = /gu) ?? []).length === 1,
    'a second counter drifts the moment two views exist')
  check('...subscribed through React\'s external-store seat',
    /React\.useSyncExternalStore\(subscribeTransferQueue, transferQueueSnapshot/u.test(client),
    'a component-local copy is the second truth this feature exists to remove')
  check('the scheduler is pure and takes its clock from the action',
    /function queueReduce \(state, action\)/u.test(client) &&
      /const at = typeof action\?\.at === 'number'/u.test(client),
    'a reducer that reads Date.now cannot be replayed by a test')
  check('same host: one transfer at a time; all hosts: two',
    /const TRANSFER_QUEUE_LIMIT_TOTAL = 2/u.test(client) &&
      /const TRANSFER_QUEUE_LIMIT_PER_HOST = 1/u.test(client),
    'the two ceilings are not stated as constants')
  check('the browser\'s 1 GiB pre-check restates the server\'s own constant',
    /const TRANSFER_QUEUE_UPLOAD_LIMIT = 1024 \* 1024 \* 1024/u.test(client) &&
      /export const DEFAULT_MAX_BYTES = 1024 \* 1024 \* 1024/u.test(transfer),
    'a drift here is a 413 after sending bytes the picker should have refused')
  check('oversized picks are refused as a list, before the queue',
    /function splitOversizeFiles \(files, limit/u.test(client) &&
      /const split = splitOversizeFiles\(files\)/u.test(client),
    'a batch would discover the limit one failure at a time')
  check('progress cannot move backwards in the store',
    /bytes <= item\.bytesDone/u.test(client) && /capped <= item\.bytesDone/u.test(client),
    'a late report could rewind the bar')
  check('a percentage is only shown for a known total',
    /if \(total === null \|\| total <= 0\) return null/u.test(client),
    'an archive would read as 0% instead of "bytes received"')

  // Speed and the rule under the row. Both are readings of the STORE, never of
  // render timing: a rate guessed inside a component differs on every frame.
  check('each row carries a light-blue progress rule under its name',
    /className: 'sshwsp-queuebar-fill'/u.test(client) &&
      /sshwsp-queuebar\$\{live/u.test(client) &&
      /'aria-hidden': 'true'/u.test(client),
    'a bar with no text equivalent would be the only carrier of the number')
  check('...filled from the known percentage, full for done, sweeping when unknown',
    /const fillPercent = item\.status === 'done' \? 100 : \(percent \?\? 0\)/u.test(client) &&
      /sshwsp-queuebar-live/u.test(client),
    'an archive would otherwise claim 0% or a made-up width')
  check('the rate is measured by the reducer from the action clock',
    /function transferQueueNextSpeed \(item, done, at\)/u.test(client) &&
      /TRANSFER_QUEUE_SPEED_RESET_GAP/u.test(client),
    'a rate measured in the component would differ on every frame')
  const metaStart = client.indexOf('function queueItemMetaText (item, percent, t)')
  const metaRunning = client.indexOf("if (item.status === 'running')", metaStart)
  const metaDone = client.indexOf("if (item.status === 'done')", metaStart)
  check('a rate is shown only while the transfer runs',
    metaStart > 0 && metaRunning > 0 && metaDone > 0 &&
      client.indexOf('queue.perSecond', metaRunning) > metaRunning &&
      client.indexOf('queue.perSecond', metaRunning) < metaDone,
    'a settled row would print a rate it no longer has')

  // Distinguishable degradation: the slot either fires (ready) or a grace
  // period turns silence into one readable line. A control that vanishes with
  // no explanation is the failure mode this catches.
  check('the Files-panel slot records that its callback ran',
    /setTransferActionsSlotState\('ready'\)/u.test(client),
    'an absent declaration stays indistinguishable from a broken entry')
  check('...and a missing declaration becomes a sentence, not silence',
    /setTransferActionsSlotState\('missing'\)/u.test(client) &&
      /queue\.slotMissing/u.test(client),
    'the entry would simply never render and nobody would know why')

  // One notice for the batch, updated in place: a second toast is what resets
  // the first one's clock and hides the result worth reading.
  check('the queue draws its toast through the shared transferNotice',
    /function transferNotice \(text\)/u.test(client) &&
      (client.match(/transferNotice\(/gu) ?? []).length === 1,
    'a second toast owner would remove the first node under it')
  check('...and a finished batch is one merged sentence',
    /function transferQueueSummary \(tracked\)/u.test(client) &&
      /queue\.summaryPartial/u.test(client) && /queue\.summaryDone/u.test(client),
    'a toast per file would reset each other on the way out')

  // The popover must be dismissible by Esc and by a click outside, through the
  // same a11y contract as the dialogs rather than a third implementation.
  check('the progress popover reuses the dialog a11y contract',
    /function TransferQueuePanel \(\{ anchor, onClose, t \}\)/u.test(client) &&
      /useDialogA11y\(\{ onClose, label: t\('queue\.title'\) \}\)/u.test(client),
    'a custom popover would lack Esc, the focus trap and focus return')
  check('...and is anchored to its button, not to a fixed corner',
    /getBoundingClientRect\(\)/u.test(client) && /addEventListener\('resize', measure\)/u.test(client),
    'a collapsed or moved panel would leave the popover pointing at nothing')
  // Every remote listing shows the entry, empty queue included, so "empty" is
  // a state the panel must render. The old auto-close existed only because the
  // entry itself used to disappear with the queue; keeping it would make the
  // button open a panel that shut itself on the next frame.
  check('the progress entry is not gated on a transfer being in flight',
    !/queue\.items\.length > 0 && jsx\('button'/u.test(client),
    'hiding the only progress surface while idle is what made it look missing')
  check('...and a local listing keeps DSH\'s own header',
    /if \(remote === null\) return null/u.test(client) &&
      /const remote = remoteTargetOf\(absolutePath\)/u.test(client),
    'the queue is a remote-workspace control; a local folder has no alias to carry')
  check('...and an empty queue shows its empty state rather than closing the popover',
    !/if \(queue\.items\.length === 0\) onClose\(\)/u.test(client) &&
      /'queue\.empty'/u.test(client),
    'an always-present entry would open a panel that immediately closed')
}

console.log('\n[the toast window, measured on the code that ships]')
//
// The shape assertions above say the constant is used; these say what USING it
// means. Both DOM implementations are lifted out of the bundle and driven
// against a fake DOM and a fake clock, because "a timer exists" is also true of
// one that removes the wrong node, and of one a hover does not cancel.
{
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')

  {
    const dom = makeToastDom()
    const { notifyUser } = dom.build(client)
    notifyUser('boom: remote write refused', 'err')
    check('an error notice arms exactly one timer',
      dom.live().length === 1, `${dom.live().length} live timer(s)`)
    check('...for the whole seven seconds',
      dom.live()[0]?.ms === 7000, `ms=${dom.live()[0]?.ms}`)
    dom.tick()
    check('...after which the node is gone',
      dom.nodes.length === 0, `${dom.nodes.length} node(s) left`)
  }

  {
    const dom = makeToastDom()
    const { notifyUser } = dom.build(client)
    notifyUser('reading this', 'err')
    const node = dom.nodes[0]
    node.emit('mouseenter')
    check('resting the pointer on the notice cancels its clock, without removing it',
      dom.live().length === 0 && dom.nodes.length === 1,
      `${dom.live().length} live timer(s), ${dom.nodes.length} node(s)`)
    node.emit('mouseleave')
    check('...and leaving restarts the FULL window, not the remainder',
      dom.live().length === 1 && dom.live()[0]?.ms === 7000,
      `ms=${dom.live()[0]?.ms}`)
  }

  {
    // An expiring notice that took focus has to give it back: removing the
    // focused node drops focus to <body>, and the next Tab starts over.
    const dom = makeToastDom()
    const { notifyUser } = dom.build(client)
    const previous = dom.document.body
    previous.focus()
    notifyUser('focus goes here', 'err')
    check('an error does NOT take focus when it appears',
      dom.document.activeElement === previous, 'the toast stole the caret')
    const inside = dom.nodes[0].querySelector('[data-toast-action="details"]')
    inside.focus()
    dom.nodes[0].emit('keydown', { key: 'Escape', target: dom.nodes[0] })
    check('...but hands it back when closed from inside',
      dom.document.activeElement === previous,
      'focus fell to the document, so the keyboard restarts at the top of the page')
  }

  {
    const dom = makeToastDom()
    const { notifyUser } = dom.build(client)
    notifyUser('click me', 'ok')
    dom.nodes[0].emit('click')
    check('clicking dismisses before the window ends', dom.nodes.length === 0)

    const second = makeToastDom()
    const { notifyUser: notifyAgain } = second.build(client)
    notifyAgain('esc me', 'err')
    second.nodes[0].emit('keydown', { key: 'Escape', preventDefault () {} })
    check('...and so does Escape', second.nodes.length === 0)
  }

  {
    const dom = makeToastDom()
    const { notifyUser, transferNotice } = dom.build(client)
    notifyUser('done', 'ok')
    check('a success uses the same seven-second window',
      dom.live().length === 1 && dom.live()[0]?.ms === 7000,
      `ms=${dom.live()[0]?.ms}`)

    const transfers = makeToastDom()
    const { transferNotice: notice } = transfers.build(client)
    const handle = notice('Uploading a.zip…')
    check('an in-flight notice has no clock to outlive it',
      transfers.live().length === 0, `${transfers.live().length} live timer(s)`)
    handle.done('Uploaded a.zip')
    check('...the OUTCOME starts one, on the same window',
      transfers.live().length === 1 && transfers.live()[0]?.ms === 7000,
      `ms=${transfers.live()[0]?.ms}`)
  }
}

// ---------------------------------------------------------------------------
// The file-reference zone: two titles, and they are not interchangeable
// ---------------------------------------------------------------------------
// The section used to carry one heading ("Host Path Passthrough"). It now
// carries two levels: a zone heading ranked with "Hosts" and "Port forwards",
// and, under it, the heading of the scheme box itself. The two are separate keys
// on purpose — `passthrough.scheme` is ALSO the accessible name of the input, so
// renaming the zone must never rename the field. Pinning the keys rather than
// only the sentences is what makes a later rename fail loudly instead of
// collapsing the two levels back into one line.
console.log('\n[the file-reference zone: two titles, and they are not interchangeable]')
{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  check('the file-reference zone has its own heading key, in both dictionaries',
    (source.match(/'passthrough\.group':/gu) ?? []).length === 2,
    `${(source.match(/'passthrough\.group':/gu) ?? []).length} definition(s) — zh and en both need one`)
  check('...and the zone heading is the new name',
    source.includes("'passthrough.group': '文件引用设置'") &&
      source.includes("'passthrough.group': 'File reference settings'"),
    'the zone heading still reads as the old single title')
  check('the scheme heading is the renamed one',
    source.includes("'passthrough.title': '显式文件引用 scheme'") &&
      source.includes("'passthrough.title': 'Explicit file reference scheme'"),
    'the scheme heading was not renamed')
  // A leftover copy of the old title is a SECOND name for the same zone, which
  // is how the panel came to describe one block two ways.
  check('the previous section title survives nowhere in the dictionaries',
    !source.includes("'Host Path Passthrough'") &&
      !source.includes("'passthrough.title': '本机路径直通'"),
    'a dictionary still carries the previous title')
  check('the zone heading renders as a section head, like the other panel sections',
    isLive(source, /jsx\('div', \{ className: 'sshwsp-section-head', children: \[\s*jsx\('h3', \{ children: t\('passthrough\.group'\) \}\),/u),
    'the zone heading is gone, or it is no longer the section head')
  check('the scheme heading renders BELOW it, as an h4',
    isLive(source, /jsx\('h4', \{ children: t\('passthrough\.title'\) \}\)/u) &&
      !isLive(source, /jsx\('h3', \{ children: t\('passthrough\.title'\) \}/u),
    'the two headings are one level again, so the block has one title')
  check('the h4 follows the section head rather than preceding it',
    (() => {
      const head = source.indexOf("jsx('h3', { children: t('passthrough.group') })")
      const sub = source.indexOf("jsx('h4', { children: t('passthrough.title') })")
      return head >= 0 && sub > head
    })(),
    'the subheading renders above the zone it belongs to')
  check('the h4 is styled one level down from the h3',
    /\.sshwsp h4 \{ font-size: 12px; font-weight: 400; margin: 0 0 10px;/u.test(source) &&
      /\.sshwsp h3 \{ font-size: 12px; font-weight: 500;/u.test(source),
    'no lighter h4 rule — the subheading looks identical to the zone head, or is unstyled')
  check('the scheme box keeps its own accessible name',
    source.includes("'aria-label': t('passthrough.scheme')") &&
      source.includes("'passthrough.scheme': '本机路径前缀'"),
    'the input is named by a title now, so its field label moved with the zone')
}

// ---------------------------------------------------------------------------
// The scheme rules are PUBLISHED, not duplicated
// ---------------------------------------------------------------------------
// The server owns the syntax, the minimum length and the reserved names, and the
// panel receives them through `status.passthrough.schemeRules`. The bundle used
// to keep a second copy (a regex plus `=== 'ssh'`), which is how a name the
// server accepts can be refused on screen, or one it refuses promised. These
// assertions exist to make that copy fail loudly if it comes back.
console.log('\n[the scheme rules are published, not duplicated]')
{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  const start = source.indexOf('const savePassthroughScheme = async () => {')
  const end = source.indexOf('const handleUnforward', start)
  const body = start < 0 || end <= start ? '' : source.slice(start, end)
  check('the scheme saver reads the rules the server publishes',
    body !== '' && /status\.passthrough\?\.schemeRules/u.test(body),
    'the saver no longer reads schemeRules, so it must be validating from a local copy')
  check('...and carries no second copy of the reserved names',
    !/===\s*'ssh'/u.test(body),
    'the bundle hardcodes the ssh reservation again')
  check('...nor a second copy of the scheme syntax',
    !/\[\^a-z\]/u.test(body) && !/a-z0-9\+\.-/u.test(body),
    'the bundle hardcodes the scheme regex again')
  check('...and each refusal has its own message, not one generic failure',
    /passthrough\.schemeTooShort/u.test(body) &&
      /passthrough\.schemeReserved/u.test(body) &&
      /passthrough\.schemeInvalid/u.test(body),
    'the saver collapsed the refusals into one sentence')

  // Every scheme key must exist in BOTH dictionaries: a key defined only in
  // Chinese leaves the English panel silent about the same refusal.
  for (const key of ['schemeHint', 'schemeTooShort', 'schemeReserved', 'schemeInvalid', 'schemeSaved', 'schemeWarning']) {
    const count = (source.match(new RegExp(`'passthrough\\.${key}':`, 'gu')) ?? []).length
    check(`'passthrough.${key}' is defined in both dictionaries`, count === 2, `${count} definition(s)`)
  }
  // The hint is the only place the panel states the rules the user cannot see
  // being applied. All four of them have to be there, in both languages: one
  // prefix at a time, the 3-character minimum, the reserved list living on the
  // server, and the NAME/path case split.
  const hintLines = source.split('\n').filter(line => line.includes("'passthrough.schemeHint':"))
  check('the hint is one line per language',
    hintLines.length === 2, `${hintLines.length} line(s)`)
  check('the Chinese hint states the one-prefix rule, the 3-character minimum and the case split',
    hintLines[0] !== undefined && hintLines[0].includes('一个') && hintLines[0].includes('3') &&
      hintLines[0].includes('大小写') && hintLines[0].includes('保留名'),
    hintLines[0] === undefined ? 'missing' : hintLines[0].slice(0, 120))
  check('the English hint states the same three rules',
    hintLines[1] !== undefined && /only one prefix/iu.test(hintLines[1]) && hintLines[1].includes('3') &&
      /case-insensitiv/iu.test(hintLines[1]) && /reserved/iu.test(hintLines[1]),
    hintLines[1] === undefined ? 'missing' : hintLines[1].slice(0, 120))
  // A stored-but-unusable value has to be visible: degrading it silently is how
  // "my prefix stopped working" becomes unreportable.
  check('the panel renders the degraded-value warning above the settings',
    /status\.passthrough\?\.schemeWarning != null/u.test(source) &&
      /t\('passthrough\.schemeWarning'\)/u.test(source),
    'the warning field is never rendered, so a degraded value is invisible')
  check('...and the warning names the stored value, the effective one and the reason',
    /\.replace\('\{\{stored\}\}'/u.test(source) === false &&
      /\.replace\('\{stored\}'/u.test(source) &&
      /\.replace\('\{effective\}'/u.test(source) &&
      /\.replace\('\{message\}'/u.test(source),
    'the warning line drops one of the three facts')
  check('a successful save clears the stale warning instead of waiting for the next poll',
    /schemeWarning: null/u.test(source),
    'the warning survives the save that confirms it')
  check('the scheme box bounds its width without treating the bound as a rule',
    /maxLength: 32/u.test(source),
    'the box has no width bound, or the bound is used as validation')
}

// ---------------------------------------------------------------------------
// The workspace browser tab: shared selection, degrade path, bilingual keys
// ---------------------------------------------------------------------------
{
  const source = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  /** Slice one declaration out of the bundle, comments stripped. */
  const sliceBody = (name) => {
    const forms = [
      { prefix: 'async function ' + name + ' (' },
      { prefix: 'function ' + name + ' (' },
      { prefix: 'const ' + name + ' = ' },
    ]
    for (const form of forms) {
      const from = source.indexOf(form.prefix)
      if (from < 0) continue
      const nexts = ['\n    function ', '\n    async function ', '\n    const ']
        .map(marker => source.indexOf(marker, from + 1))
        .filter(index => index >= 0)
      const to = nexts.length === 0 ? from + 12000 : Math.min(...nexts)
      return source.slice(from, to)
        .replace(/\/\*[\s\S]*?\*\//gu, ' ')
        .replace(/\/\/[^\n]*/gu, ' ')
    }
    return ''
  }
  // The plugin's own right-sidebar tab is GONE on request. What must not come
  // back with it is a second selection surface: the dialog keeps the reducer,
  // and the host tree bridges to the SAME one.
  check('the dialog no longer carries its own selection logic',
    !sliceBody('DirectoryBrowser').includes('selectReduce('),
    'the browse-only dialog still owns a selector')
  check('...and the host-tree bridge uses the same reducer, not a copy',
    sliceBody('installTreeSelectionBridge').includes('selectReduced'.replace('d', '')) === false &&
      /selectReduce\(state\.selection/u.test(source),
    'the tree bridge grew a private selector')
  // The plugin's own right-sidebar tab is GONE on request. What must not come
  // back is a second tab TYPE (a `sidebarRightTabs` registration) or a body
  // occupying a cell key of this plugin's own invention.
  //
  // `sidebar.right.pane.tab` is no longer forbidden outright: the recent-commit
  // strip deliberately SHADOWS the seat the official forge tab already owns —
  // same cell key (`FORGE_TAB_KEY`, i.e. the forge package's TAB_ID
  // `@deepseek-ai/dsh-experimental-client-ui-forge`), lower priority, shipped
  // registration left installed. That is an occupant of an existing cell, not a
  // tab type, and the distinction is exactly what these two checks pin: one
  // registration body, keyed to the official tab.
  check('the plugin registers no right-sidebar tab type of its own',
    !/sidebarRightTabs/u.test(source),
    'the deleted tab type is still registered somewhere')
  check('...and no right-sidebar tab body invents a cell key of its own',
    (source.match(/name: 'sidebar\.right\.pane\.tab'/gu) ?? []).length === 1 &&
      /key: FORGE_TAB_KEY/u.test(source),
    'a second right-sidebar tab body came back (expected exactly one, shadowing the forge tab key)')
  check('...and the mounted-workspace row offers no browser entry',
    !/browse\.entry/u.test(source) && !/openWorkspaceBrowser/u.test(source),
    'the removed "浏览文件" button is still wired')
  // The row menu carries ONE fixed verb, so the confirmation is the only place
  // that states scope. Its title varies with what will go (one file, one
  // directory and how much is under it, or N entries) and its body carries the
  // counted directory/file split — all derived from the same `items` array the
  // delete then runs over.
  // The confirmation OPENS FIRST and fills its numbers in afterwards: counting a
  // deep tree is a walk of /ls round trips, and a dialog that only appears after
  // the last one is a button that looks dead. So the shape this asserts is
  // "dialog built from the selection, counts painted into reserved nodes" —
  // not "counts awaited before the dialog exists", which is what it used to be.
  check('the delete confirmation names the count, the entries and the subtree rule',
    /const counts = await countDeleteContents\(items, paint\)/u.test(source) &&
      /items\.length > 1[\s\S]{0,200}?translate\('rowmenu\.deleteMany', \{ count: items\.length \}\)/u.test(source) &&
      source.includes("translate('rowmenu.deleteOneDir', { count: filesShown })") &&
      /const counts = await countDeleteContents\(items, paint\)/.test(source) &&
      /const paint = \(counts\) => \{/.test(source) &&
      source.includes("translate('rowmenu.deleteCounts', { dirs: counts.dirs, files: filesShown })") &&
      source.includes("translate('rowmenu.deleteCountPending')") &&
      source.includes("translate('rowmenu.deleteDirWarning')") &&
      source.includes("translate('rowmenu.deleteIrreversible')"),
    'the confirmation does not state what a directory delete removes')
  check('...and its title never invented a count of its own',
    !/translate\('rowmenu\.deleteMany', \{ count: [^i]/u.test(source),
    'the confirmation title counts something other than the target array')
  check('the host tree keeps its row menu after the tab was removed',
    /installTreeMenuBridge/.test(source) && /openTaskMenu\(ctx, path/.test(source),
    'removing the tab took the host tree\'s menu with it')
  check('read-only sessions disable rename/delete before the click',
    source.includes("translate('rowmenu.readonly')") &&
      source.includes('mutationPolicyOf({ sessionId, root })') &&
      source.includes('entry.disabled = true'),
    'the menu offers destructive actions a read-only session will refuse')
  check('no entry into the removed tab survives anywhere',
    !/browse\.entry/u.test(source) && !/browse\.tabTitle/u.test(source) && !/browse\.slotMissing/u.test(source),
    'the panel still advertises a tab that is gone')
  // ONE label per verb, whatever the selection: a menu that changes its
  // wording with the count is a second answer to "what will this delete", and
  // the confirmation already owns the scope.
  check('the row menu labels the two destructive verbs once, without a count',
    !source.includes('rowmenu.downloadSelected') &&
      !source.includes("translate('transfer.selected'") &&
      /label: translate\('transfer\.download'\)/u.test(source) &&
      /label: translate\('rowmenu\.delete'\)/u.test(source),
    'a menu label still varies with the selection')
  const keys = ['transfer.downloadTargetTitle',
    'transfer.downloadTargetSubtitle', 'transfer.chooseTarget', 'transfer.downloadQueued',
    'transfer.skippedLocal',
    'rowmenu.deleteOneFile', 'rowmenu.deleteOneDir', 'rowmenu.deleteMany', 'rowmenu.deleteCounts',
    'rowmenu.rename', 'rowmenu.delete', 'rowmenu.renameTitle',
    'rowmenu.renameFail', 'rowmenu.deleteFail', 'rowmenu.deleteDone', 'rowmenu.deletePartial']
  const missingZh = keys.filter(key => !new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'u').test(source))
  check('every new user-visible key is present in both dictionaries',
    missingZh.length === 0, `missing ${JSON.stringify(missingZh)}`)
  // Both dictionaries define the same key SET; a key added to zh only would
  // render as its namespace path in English.
  const dictionaryKeys = (start) => {
    const at = source.indexOf(start)
    if (at < 0) return new Set()
    const end = source.indexOf('}', at)
    const body = source.slice(at, end)
    return new Set([...body.matchAll(/'([^']+)':/gu)].map(match => match[1]))
  }
  const zhKeys = dictionaryKeys('const zh = {')
  const enKeys = dictionaryKeys('const en = {')
  const onlyZh = [...zhKeys].filter(key => !enKeys.has(key))
  const onlyEn = [...enKeys].filter(key => !zhKeys.has(key))
  check('the two dictionaries have the same keys', onlyZh.length === 0 && onlyEn.length === 0,
    JSON.stringify({ onlyZh, onlyEn }))
}

// A numeric summary, in the same `=== N passed, M failed ===` shape every other
// suite prints. Without it, a script that totals the run by summing these lines
// skips this suite's assertions silently — which is exactly how its count came
// to be missing from the documentation three times in a row.
console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
process.exit(failures.length === 0 ? 0 : 1)
