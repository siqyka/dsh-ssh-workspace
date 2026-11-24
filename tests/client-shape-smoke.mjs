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
import { routeSource } from './support/route-source.mjs'
import { clientPartSource, clientSource } from './support/client-source.mjs'
import { compareClientMap } from '../scripts/client-map.mjs'

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
  // The module id is how the Host looks this bundle up, and it is the PACKAGE
  // NAME — not a free label. A rename that misses this line leaves a plugin
  // that installs, activates on the host, and paints nothing, with no error
  // anywhere: the Host asks for a module id that never registered.
  check('the module id is the package name',
    client.includes(`id: '${pkg.name}'`), `expected id: '${pkg.name}'`)
} else {
  check('the client bundle is non-empty', false, 'bundle missing')
  check('the first line uses the __ModuleLoader__ convention', false, 'bundle missing')
  check('the bundle exports apply()', false, 'bundle missing')
}

console.log('\n[host half]')
check('lib/index.js exists', existsSync(path.join(packageRoot, 'lib/index.js')))
check('the browser bundle is excluded from the host entry points',
  pkg.exports?.['.']?.default !== pkg.exports?.['./client']?.default, JSON.stringify(pkg.exports?.['.']))

console.log('\n[five-row list cap]')
// Each long list is a scrolling viewport, not a truncation: dropping rows
// would hide a row's controls (a tunnel you cannot see is one you cannot turn
// off). The four sections the cap applies to are pinned here, because losing
// one of the wrappers silently brings back a panel that scrolls for pages.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = clientSource(packageRoot)
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
  const client = clientSource(packageRoot)
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

console.log('\n[detached rows are dimmed, never disabled]')
// Detach is a STATE, not a lock. The row dims so the state is visible, and
// every click still reaches DSH: the session opens, the row actions fire, and
// whatever the host refuses reports itself where the user is looking. The
// assertions below pin that down by their ABSENCE — an earlier version paired
// the dimming with pointer-events and `inert`, which silently made the sidebar
// swallow clicks, and a failure like that is felt by the user long before it is
// seen by anyone reading the code.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = clientSource(packageRoot)
  check('a detached row is dimmed',
    /\[data-sshwsp-disabled="1"\]\s*\{[^}]*opacity/.test(client),
    'without the dimming the state is invisible and the attribute is pointless')
  check('...but nothing under the mark takes the pointer away',
    !/\[data-sshwsp-disabled="1"\][^{]*\{[^}]*pointer-events/.test(client),
    'pointer-events: none is the exact rule that made the row unclickable')
  check('...including the session rows the mark reaches',
    !/\[data-row-key\^="session:"\]\[data-sshwsp-disabled="1"\]\s*\{[^}]*pointer-events/.test(client),
    'a session row is the control that opens the session; blocking it blocks the feature')
  // CSS alone never covered the keyboard: `inert` plus a forced tabindex did,
  // and the pair is easy to reintroduce "for consistency". Both must stay gone,
  // because either one alone is enough to make a focusable row unreachable.
  check('...and the mark script writes no inert/tabindex of its own',
    !/data-sshwsp-selfinert|data-sshwsp-inert|sshwspSelfInertPrior|sshwspInertPrior/.test(client),
    'an inert row cannot be focused or clicked, whatever the stylesheet says')
  check('the mark is still just one attribute, set and cleared',
    client.includes("setAttribute('data-sshwsp-disabled', '1')") && client.includes("removeAttribute('data-sshwsp-disabled')"),
    'the whole treatment rides on this one attribute; both directions must exist or a re-enable never clears')
}

console.log('\n[detached workspaces mark their sessions, not just their header]')
// A row keyed `session:<id>` carries no workspace at all, so the membership has
// to be resolved while the workspace is in hand. Greying only the group header
// leaves every session under it a live, clickable session whose workspace I/O
// fence is shut — the exact state the user reports as "sessions aren't greyed".
// This runs the real collector rather than grepping for a string, because the
// bug was a missing assignment, not a missing name.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = clientSource(packageRoot)
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
  const client = clientSource(packageRoot)
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

console.log('\n[the unmount hint says what unmount does — and where deleting lives]')
// Unmount and delete are now two buttons, so this hint has exactly one job: say
// that unmounting keeps everything and stays reversible, and point at the row's
// other button for the destructive half. It must NOT describe an archive: that
// branch belonged to the old "unmount with a checkbox" flow, and a leftover
// sentence about archiving would tell the user unmount might take their sessions
// when it never does.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = clientSource(packageRoot)
  const hints = [...client.matchAll(/'mounted\.detachHint': '([^']*)'/g)].map(match => match[1])
  const [zhHint = '', enHint = ''] = hints
  check('both locales define the unmount hint', hints.length === 2, `${hints.length} definition(s)`)
  check('the hint says the record and the sessions are both kept',
    /保留/.test(zhHint) && /工作区记录/.test(zhHint),
    zhHint)
  check('...that the row stays and can be re-enabled',
    /置灰/.test(zhHint) && /启用/.test(zhHint),
    zhHint)
  check('...and points at the row\'s delete for the destructive half',
    /删除/.test(zhHint),
    'a hint that only reassures leaves the user guessing where deletion went')
  // The English hint is asserted on its own text, not on the bundle at large:
  // "archived" appears in unrelated keys, so a bundle-wide regex would pass even
  // if this one hint still described the old branch.
  check('...in English too, so the two locales cannot diverge in meaning',
    /kept/i.test(enHint) && /re-enabled/i.test(enHint) && /Delete/.test(enHint),
    enHint)
  check('...and neither locale still promises an archive on unmount',
    !/归档/.test(zhHint) && !/archiv/i.test(enHint),
    'unmount never archives now, so describing it would be a leftover branch')
  check('the hint is carried by the unmount button',
    /title: t\('mounted\.detachHint'\),\s*\n\s*onClick: \(\) => \{ setUnmountConfirm\(wsPath\); setDiscardConfirm\(null\) \}/.test(client),
    'the button that starts the flow lost its explanation')
  check('...and by the confirm button, which replaces it once armed',
    /title: t\('mounted\.detachHint'\),\s*\n\s*onClick: \(\) => handleUnmount\(wsPath\)/.test(client),
    'the tooltip vanishes at the exact moment the click becomes irreversible')
  // Unmount has no options left: the mode is a constant, and the old state that
  // let the row choose between detach and deregister must be gone, not merely
  // unused — a surviving `unmountMode` would be a second way to decide.
  check('unmount always detaches, with no mode to choose',
    /body: JSON\.stringify\(\{ workspacePath, mode: 'detach' \}\)/.test(client),
    'unmount must be the reversible half every time')
  check('...and the mode state that used to vary it is gone',
    !/unmountMode/.test(client),
    'a leftover mode selector is a second, silent answer to the same question')
  check('the hint is not duplicated as a standing line in the row',
    !/sshwsp-entry-meta', children: t\('mounted\.detachHint'\)/.test(client),
    'a second copy of the same sentence drifts from the tooltip')
  // Unmount cannot delete anything any more, so it must not wear the danger
  // styling: two adjacent red buttons would tell the user both are destructive
  // and teach them to distrust the colour that does mark the one that is.
  check('the reversible half is not painted as the destructive one',
    /className: 'sshwsp-btn',\s*\n\s*disabled: busy,\s*\n\s*title: t\('mounted\.detachHint'\)/.test(client),
    'danger styling on a reversible action dilutes the action that is not')
  check('...while delete keeps it',
    /className: 'sshwsp-btn sshwsp-btn-danger',\s*\n\s*disabled: busy \|\| \(!discardRecord && !discardSessions\)/.test(client),
    'the destructive button must be the one that looks destructive')
}

console.log('\n[a workspace whose host is gone says so before it fails]')
// Deleting a host does not delete the workspaces registered on it: they stay in
// both lists and fail later, one operation at a time, with an unknown-alias
// error that names the alias but not the cause. The red mark is that cause,
// stated once, where the user is already looking.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = clientSource(packageRoot)
  const texts = [...client.matchAll(/'workspace\.hostMissing': '([^']*)'/g)].map(match => match[1])
  const [zhText = '', enText = ''] = texts
  check('both locales define the missing-host message', texts.length === 2, `${texts.length} definition(s)`)
  check('...and it names the host with a placeholder', /\{alias\}/.test(zhText) && /\{alias\}/.test(enText), zhText)
  check('...saying the workspace cannot connect, not merely that it is greyed',
    /连不上/.test(zhText) && /cannot connect/i.test(enText), zhText)
  // The alias must come from the path prefix, never from a substring search:
  // `ssh://a/b/c` and a host literally named `b` would otherwise collide.
  check('the alias is parsed out of the ssh:// prefix',
    /function workspaceAliasOf \(workspacePath\)/.test(client) && /\^ssh:\\\/\\\/\(\[\^\/\]\+\)\\\//.test(client),
    'guessing the alias by substring would mark the wrong rows')
  // A listing that could not be read must not be read as "every host is gone":
  // three separate ways of not knowing, all of which must suppress the mark.
  check('an unread listing never marks anything',
    /if \(!listingComplete\) return null/.test(client),
    'a red mark on every row after one failed fetch is worse than no mark')
  check('...and the listing counts as read only after a successful fetch',
    /setHostListingLoaded\(true\)/.test(client) && /const hostListingComplete = hostListingLoaded &&/.test(client),
    'an empty list is legitimate, so the difference is whether the fetch succeeded')
  check('...with an unreadable store or skipped entries also suppressing it',
    /listingGaps\.storeError === undefined && \(listingGaps\.skipped \?\? \[\]\)\.length === 0/.test(client),
    'a partial listing would turn "could not look" into "it is gone"')
  // Both lists, because a detached workspace of a deleted host is the one the
  // user will try to re-enable.
  const marks = (client.match(/jsx\(MissingHostMark,/g) ?? []).length
  check('the mark is rendered in the mounted list and the detached one', marks === 2, `${marks} use(s)`)
  check('the mark is an accessible image with a tooltip, not a bare glyph',
    /role: 'img'/.test(client) && /'aria-label': label/.test(client) && /title: label/.test(client),
    'a keyboard user gets nothing from a title attribute on a span')
  check('the badge is red and uses the danger tokens',
    /\.sshwsp-hostgone \{[^}]*var\(--sshwsp-danger\)/.test(client),
    'a warning that looks like every other dimmed row will not be seen')
}

console.log('\n[delete asks two questions, in both lists]')
// "Unmount" is the reversible half: the record survives, so the row survives and
// the panel offers Enable. "Delete" is the other half, and it is the only place
// the two destructive questions are asked — whether the workspace goes, and
// whether its sessions go with it. Both lists offer it because a workspace the
// user is done with may be in either one, and the answers must be the same
// request with the same meaning: mode follows the record box, archiveSessions
// follows the sessions box, and neither is baked in.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = clientSource(packageRoot)
  const hints = [...client.matchAll(/'workspace\.deleteHint': '([^']*)'/g)].map(match => match[1])
  const [zhHint = '', enHint = ''] = hints
  check('both locales define the delete hint', hints.length === 2, `${hints.length} definition(s)`)
  check('the hint says the two boxes decide what happens',
    /勾选框/.test(zhHint) && /工作区/.test(zhHint) && /会话/.test(zhHint),
    zhHint)
  check('...in English too, so neither locale can quietly promise a deletion',
    /box/i.test(enHint) && /workspace/i.test(enHint) && /sessions/i.test(enHint),
    enHint)
  // "Delete the sessions" is an archive, and the checkbox's own tooltip has to
  // say so: the files stay on disk, DSH has no session-delete API, and a word
  // that promises unlinking would be a lie the plugin cannot keep.
  const sessionHints = [...client.matchAll(/'workspace\.deleteSessionsHint': '([^']*)'/g)].map(match => match[1])
  const [zhSessions = '', enSessions = ''] = sessionHints
  check('both locales define the sessions hint', sessionHints.length === 2, `${sessionHints.length} definition(s)`)
  check('the sessions box says ARCHIVE, not delete',
    /归档/.test(zhSessions) && /不是删文件/.test(zhSessions),
    zhSessions)
  check('...in English too',
    /archiv/i.test(enSessions) && /not deleted/i.test(enSessions),
    enSessions)
  // The record box is the irreversible one, so its hint must name Enable.
  const recordHints = [...client.matchAll(/'workspace\.deleteRecordHint': '([^']*)'/g)].map(match => match[1])
  const [zhRecord = '', enRecord = ''] = recordHints
  check('the record box says Enable cannot bring it back',
    /启用也救不回来/.test(zhRecord) && /Enable cannot bring it back/i.test(enRecord),
    zhRecord)
  // Both rows arm, both can be backed out of: a single click that cannot be
  // undone is one click too few.
  const armCount = (client.match(/onClick: \(\) => \{\s*\n\s*setDiscardConfirm\(wsPath\)/g) ?? []).length
  check('both lists arm a confirmation instead of deleting on the first click',
    armCount === 2,
    `${armCount} arming button(s)`)
  const cancelCount = (client.match(/onClick: \(\) => setDiscardConfirm\(null\)/g) ?? []).length
  check('...and both armed rows can still be backed out of',
    cancelCount === 2,
    'an armed row with no cancel turns a misclick into a deletion')
  // Two boxes, rendered by one component used in two places — one implementation,
  // so the two lists cannot drift into asking different questions.
  const choiceUses = (client.match(/jsx\(DiscardChoices, \{/g) ?? []).length
  check('the same two-box component is used by both lists', choiceUses === 2, `${choiceUses} use(s)`)
  const boxes = (client.slice(
    client.indexOf('function DiscardChoices'),
    client.indexOf('How many rows a section shows', client.indexOf('function DiscardChoices')),
  ).match(/type: 'checkbox'/g) ?? []).length
  check('...and it renders exactly the two checkboxes', boxes === 2, `${boxes} checkbox(es)`)
  check('both boxes start ticked, because that is what "delete" means',
    (client.match(/setDiscardRecord\(true\)[;\s]+setDiscardSessions\(true\)/g) ?? []).length === 2,
    'one list arming with different defaults is a different action')
  check('with both cleared there is nothing to do, so confirm is disabled',
    (client.match(/disabled: busy \|\| \(!discardRecord && !discardSessions\)/g) ?? []).length === 2,
    'a confirm button that quietly does one of the two is the bug this prevents')
  // The request: the record box picks the mode, the sessions box picks archiving.
  // Asserted as a pair so a refactor cannot wire one box to the other's field.
  check('the record box picks deregister or detach',
    /mode: record === true \? 'deregister' : 'detach'/.test(client),
    'a fixed mode would make one of the two boxes a decoration')
  check('...and the sessions box picks archiving, independently',
    /archiveSessions: sessions === true/.test(client),
    'keeping a workspace but clearing its sessions is a real answer')
  check('deleting reuses the unmount endpoint, not a second route',
    /API\.unmount/.test(client) && !/API\.discard|API\.deleteWorkspace/.test(client),
    'a second endpoint would be a second set of semantics to keep in step')
  // Three outcomes, and the toast must not claim sessions were archived when the
  // user cleared that box.
  check('the success toast reports how many sessions were archived',
    /t\('workspace\.deleteOk'\)\.replace\('\{n\}', archived\)/.test(client),
    'the user needs to know the action touched sessions at all')
  check('...and has a separate message when the sessions were kept',
    /t\('workspace\.deleteOkKeepSessions'\)/.test(client),
    'one message for both answers would report an archive that did not happen')
  check('a failed delete offers no retry, because it can partially succeed',
    /toastError\(t\('workspace\.deleteFail'\), result\.error, 'SSHWSP-E-DISCARD'\)/.test(client),
    'replaying a half-finished deregister is not a repeat of one action')
  check('the disabled row still offers Enable alongside Delete',
    /onClick: \(\) => handleEnable\(wsPath\)/.test(client) && /children: t\('workspace\.delete'\)/.test(client),
    'delete must not have replaced the reversible action')
  check('the mounted row offers both, so neither half is hidden',
    /children: t\('mounted\.unmount'\)/.test(client) && /children: t\('workspace\.delete'\)/.test(client),
    'a mounted workspace is exactly the one that may need deleting')
  // Two boxes plus two buttons are wider than a narrow panel row, so the row must
  // be allowed to wrap: squeezing the confirm button out of view hides the very
  // click this flow exists to make explicit.
  check('...and the armed row wraps instead of pushing a button out of view',
    /\.sshwsp-mount \{[^}]*flex-wrap: wrap/.test(client),
    'a row that cannot wrap clips the confirm button in a narrow panel')
}

console.log('\n[a deliberate disconnect looks like closing the tunnel by hand]')
// The user's requirement: disconnecting the SSH host while a tunnel is open must
// look and read exactly like closing that tunnel from the forward row. The two
// differences that matter are observable: the toast names the tunnels it shut
// down, and no "connection lost" failure line is left behind for a shutdown the
// user asked for. The panel's failure line is driven by the row's `error`, which
// is set only by the unplanned-drop path.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = clientSource(packageRoot)
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
  // Every entry `package.json` names must be checked. Skipping an absent one
  // would make "the shipped files parse" a claim about whichever subset happens
  // to be on disk — and the entry most likely to be missing is the one that
  // moved, which is exactly the one whose syntax error nobody would see.
  const targets = [pkg.main, clientRel, pkg.dsh?.bundle?.patch]
    .filter(entry => typeof entry === 'string' && entry.endsWith('.js'))
  check('package.json names at least one JavaScript entry', targets.length > 0, JSON.stringify(targets))
  for (const target of targets) {
    const file = path.join(packageRoot, target)
    if (!existsSync(file)) {
      check(`${target} exists`, false, `package.json names ${target} but it is not in the tree`)
      continue
    }
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

// The icon is metadata, not code: Plugin Manager reads it without activating the
// plugin, and a missing or malformed one is silently replaced by the panel's
// default artwork. Nothing else would notice either failure, so it is checked
// here rather than left to a visual pass.
console.log('\n[publish whitelist: the plugin icon]')
const iconField = pkg.icon
check('package.json names an icon', typeof iconField === 'string' && iconField !== '', String(iconField))
if (typeof iconField === 'string' && iconField !== '') {
  const iconFile = path.join(packageRoot, iconField)
  check('the icon file exists', existsSync(iconFile), iconFile)
  check('the icon ships in the tarball', files.includes(iconField), JSON.stringify(files))
  // `files` does not filter a linked checkout, so the tarball assertion above
  // and this size check are the only things standing between a 300 KiB icon and
  // a silent fallback in every installed panel.
  if (existsSync(iconFile)) {
    const iconBytes = statSync(iconFile).size
    check('the icon is within the 256 KiB the Host accepts', iconBytes <= 256 * 1024, `${iconBytes} bytes`)
    const icon = readFileSync(iconFile, 'utf8')
    // The Host turns the file into a data URL and renders it as an image, so
    // anything that needs a document to interpret is dead weight at best: a
    // script or an external reference is a self-containment bug.
    check('the icon is self-contained SVG geometry',
      !/<script|<foreignObject|<style|<image|externalResourcesRequired|\son[a-z]+=/iu.test(icon),
      (icon.match(/<script|<foreignObject|<style|<image|\son[a-z]+=/iu) ?? ['clean'])[0])
    check('the icon declares the 36-unit frame the artwork rules ask for',
      /viewBox="0 0 36 36"/u.test(icon), (icon.match(/viewBox="[^"]*"/u) ?? ['none'])[0])
  }
}

console.log('\n[a11y: the dialog contract]')

// The dialogs already had Esc, aria-labels on icon buttons and focus rings.
// What they lacked is the half that decides whether a keyboard or screen-reader
// user can operate them: dialog semantics, focus moved in on open, focus
// returned to the trigger on close, and a trap so Tab cannot walk behind the
// backdrop into the page.
{
  const source = clientSource(packageRoot)
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
// assertions of exactly that kind (O-14, closed: fake SSH server + tri-state summary).
{
  const source = clientSource(packageRoot)
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
  const source = clientSource(packageRoot)
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
  const source = clientSource(packageRoot)
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
  // A badge takes the colour of what it says: WARN is a warning (yellow), and
  // red is reserved for the findings whose own text names something broken.
  // Before this, every WARN finding wore the danger tone, so "needs attention"
  // and "this is failing" were the same red.
  check('a finding badge is yellow for a warning and red for a broken thing',
    /function findingToneOf \(finding\) \{/u.test(source) &&
      source.includes(String.raw`\bfailed\b|NOT PINNED|could not be saved`) &&
      /findingToneOf\(finding\) === 'bad' \? 'sshwsp-status-err'/u.test(source) &&
      /: findingToneOf\(finding\) === 'warn' \? 'sshwsp-status-warn'/u.test(source),
    'the badge must agree with the report line for the same finding')
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
  const source = clientSource(packageRoot)
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
    /path: ROUTES\.selfCheck/u.test(routeSource(packageRoot)),
    'the route behind the button was removed along with the button')
  check('the status tool still reports self-check rows',
    /selfCheck: probedAliases\(engine\)/u.test(readFileSync(path.join(packageRoot, 'lib', 'surface', 'tools.js'), 'utf8')),
    'an agent can no longer ask what a host is missing')
}

{
  const source = clientSource(packageRoot)
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
    const routesSource = routeSource(packageRoot)
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
  const client = clientSource(packageRoot)
  // The dialogs moved into their own chunk; these assertions are about them.
  const dialogs = clientPartSource(packageRoot, 'client.dialogs.js')

  // Slice the report section out of the panel so the assertions below cannot be
  // satisfied by an unrelated `window.open` elsewhere in the file. Matched
  // without a trailing line ending: the bundle's line endings are not part of
  // what this pins, and a CRLF checkout would otherwise break the slice.
  const start = client.indexOf('// ---- Diagnostic report')
  // The pane arrays end just before the return, so the report section runs from
  // its marker to the first line after the diagnostics pane — ending it at the
  // dialog marker would swallow the head and tab bar that now sit between them.
  const end = client.indexOf('const panes = {', start)
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
    /reportText !== null && jsx\(DialogSlot, \{[\s\S]{0,120}?component: ReportDialog/u.test(client), 'dialog not mounted')
  check('the report text comes from a fetch of the route',
    /await fetch\(API\.supportBundle\)/u.test(client), 'no fetch of the report route')
  check('the dialog renders the report as one selectable element per line',
    /className: 'sshwsp-report-body'/u.test(client) &&
      /role: 'document'/u.test(client) &&
      /lines\.map\(\(line, index\) =>/u.test(client),
    'a single text field cannot carry a tone per line')

  // Wrapping replaced sideways scrolling: a report is read line by line, and
  // dragging horizontally to finish a sentence is the step that makes it unread.
  check('the dialog wraps long lines instead of scrolling sideways',
    /\.sshwsp-report-body \{[^}]*white-space: pre-wrap/u.test(client) &&
      /\.sshwsp-report-body \{[^}]*overflow-x: hidden/u.test(client),
    'sideways scrolling makes the reader drag to finish a sentence')

  // The tones are the reason the report is not a wall of one colour. They are
  // derived from the leading word the report already prints, so the assertion
  // is on the derivation, not on a hand-maintained list of lines.
  check('a line is toned by its own first word',
    /function reportLineTone \(line\) \{/u.test(client) &&
      /\^WARN\\b/u.test(client) && /\^UNKNOWN\\b/u.test(client) && /\^NOTE\\b/u.test(client),
    'the tone must come from the text, never from a second source of truth')
  check('a warning is yellow and a broken thing is red',
    /\^WARN\\b[\s\S]{0,120}?return 'warn'/u.test(client) &&
      /NOT PINNED\|\^store error:/u.test(client) &&
      /\.sshwsp-report-line-warn \{ color: var\(--sshwsp-warn\)/u.test(client) &&
      /\.sshwsp-report-line-bad \{ color: var\(--sshwsp-danger\)/u.test(client),
    'the two tones a reader acts on must not be the same colour as the prose')

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
  // ReportDialog is the last component in the chunk, so the slice runs to the
  // export block rather than to a following banner.
  const dlgStart = dialogs.indexOf('function ReportDialog (')
  const dlgEnd = dialogs.indexOf('    exports.HostEditor', dlgStart)
  const dlg = dlgStart >= 0 && dlgEnd > dlgStart ? dialogs.slice(dlgStart, dlgEnd) : ''
  const selectSites = (dlg.match(/addRange\(/gu) ?? []).length
  const handleCopyAt = dlg.indexOf('const handleCopy = async () => {')
  const selectAt = dlg.indexOf('addRange(')
  check('the report dialog is locatable', dlg.length > 0, 'component not found')
  check('the text is not auto-selected when the dialog opens',
    selectSites === 1 && handleCopyAt >= 0 && selectAt > handleCopyAt,
    `${selectSites} addRange() call(s) — the only one may be the copy fallback`)
  // ...but a FAILED copy does select it: the user pressed "copy" and must be
  // able to finish it by hand, on the very lines they are reading.
  check('a failed clipboard write selects the text for a manual copy',
    /if \(\(await onCopy\(\)\) === true\) return[\s\S]{0,400}?addRange\(range\)/u.test(dlg) &&
      /range\.selectNodeContents\(body\)/u.test(dlg),
    'the copy button would silently do nothing without clipboard permission')

  // One fetch spelling. Asserting the CALL COUNT would just re-state the
  // handlers; the thing worth pinning is that the route is fetched in exactly
  // one place, so no handler can drift in its error handling.
  const fetchSites = (client.match(/fetch\(API\.supportBundle\)/gu) ?? []).length
  check('the report route is fetched in exactly one place',
    /function fetchReportText \(\)/u.test(client) && fetchSites === 1,
    `${fetchSites} fetch site(s) — a second fetch spelling drifts`)

  // ---- panel tabs
  //
  // Three tabs, and the property worth pinning is the MAPPING rather than the
  // markup: a section that lands in two panes is rendered twice with the same
  // element ids, and one that lands in none disappears while the panel still
  // looks complete. So the sections are counted per pane instead of trusting
  // the tab list to be exhaustive.
  const PANE_NAMES = ['Hosts', 'Workspaces', 'Settings']
  const paneStarts = PANE_NAMES.map(name => client.indexOf(`const pane${name} = [`))
  const paneBodies = paneStarts.map((at, index) => {
    const next = index + 1 < paneStarts.length
      ? paneStarts[index + 1]
      : client.indexOf('const panes = {', at)
    return at >= 0 && next > at ? client.slice(at, next) : ''
  })
  check('the panel declares its three panes in tab order',
    paneBodies.every(body => body.length > 0) &&
      client.includes("const PANEL_TABS = ['hosts', 'workspaces', 'settings']"),
    paneBodies.map(body => (body.length > 0 ? 'ok' : 'missing')).join(' '))
  const PANEL_SECTIONS = [
    '// ---- Hosts',
    '// ---- Port forwards',
    '// ---- Mounted workspaces',
    '// ---- Detached workspaces',
    '// ---- Persistent remote shells',
    '// ---- File references',
    '// ---- Remote environment self-check',
    '// ---- Recent remote commands',
    '// ---- Diagnostic report',
  ]
  const doubleParked = PANEL_SECTIONS.filter(marker =>
    paneBodies.filter(body => body.includes(marker)).length !== 1)
  check('every section lives in exactly one pane',
    doubleParked.length === 0,
    doubleParked.join(' | '))
  // The grouping itself: workspaces = mounted + detached; settings = the three
  // areas that used to be tabs of their own (forwards + sessions, file
  // references, and the diagnostic report with the command history above it).
  // Merging them is only correct if all three really moved — a leftover
  // forwards section still rendered by a deleted tab would simply vanish.
  check('the panes group the sections the way the tabs promise',
    paneBodies[1].includes('// ---- Mounted workspaces') && paneBodies[1].includes('// ---- Detached workspaces') &&
      paneBodies[2].includes('// ---- Port forwards') && paneBodies[2].includes('// ---- Persistent remote shells') &&
      paneBodies[2].includes('// ---- File references') &&
      paneBodies[2].includes('// ---- Recent remote commands') &&
      paneBodies[2].includes('// ---- Diagnostic report'),
    'a tab shows a section another tab already owns')
  // Only the selected pane renders. A `display: none` over all five would keep
  // every section mounted, which is how a panel ends up running five sections'
  // effects at once.
  check('only the selected pane is rendered',
    /const visiblePane = panes\[panelTab\] \?\? paneHosts/u.test(client) &&
      /children: visiblePane/u.test(client),
    'all panes mounted at once')
  check('the tab row is a real tablist',
    /className: 'sshwsp-tabs',\s*\n?\s*role: 'tablist'/u.test(client) &&
      /role: 'tab',/u.test(client) &&
      /'aria-selected': id === panelTab \? 'true' : 'false'/u.test(client) &&
      /'aria-controls': PANEL_TABPANEL_ID/u.test(client) &&
      /tabIndex: id === panelTab \? 0 : -1/u.test(client) &&
      /role: 'tabpanel'/u.test(client) &&
      /'aria-labelledby': panelTabIdOf\(panelTab\)/u.test(client),
    'missing roving tabindex, selection state, or the panel association')
  check('arrow keys move between tabs and the move takes focus with it',
    /event\.key === 'ArrowRight'/u.test(client) && /event\.key === 'Home'/u.test(client) &&
      /selectPanelTab\(PANEL_TABS\[next\]\)/u.test(client) &&
      /if \(button instanceof HTMLElement\) button\.focus\(\)/u.test(client),
    'a keyboard user could select a tab they cannot see the focus on')
  // The host unmounts the panel on every return to the conversation, so a
  // component-local tab would reset to "hosts" each time. The choice is module
  // state for exactly that reason.
  check('the selected tab survives the panel remounting',
    /let panelTabChoice = 'hosts'/u.test(client) &&
      /React\.useState\(panelTabChoice\)/u.test(client) &&
      /panelTabChoice = id/u.test(client),
    'a per-mount tab resets on every re-entry')
  check('switching tabs puts the new pane back at the top',
    /scroller\.scrollTop = 0/u.test(client) && /closest\('\.sshwsp'\)/u.test(client),
    'switching halfway down a section lands halfway down the next one')
  // The column: the panel used to paint edge to edge. Centred content with side
  // whitespace is what the Host's own page does, and it is the reason the panel
  // stops looking like a settings dump once docked wide.
  const stylesText = clientPartSource(packageRoot, 'client.styles.js')
  check('the panel content sits in a centred, width-capped column',
    /\.sshwsp \{[^}]*padding: 0;/u.test(stylesText) &&
      /\.sshwsp-panel-inner \{[^}]*max-width: 980px/u.test(stylesText) &&
      /\.sshwsp-panel-inner \{[^}]*margin: 0 auto/u.test(stylesText) &&
      /\.sshwsp-panel-inner \{[^}]*padding: 72px 24px 40px/u.test(stylesText),
    'the column either lost its cap or its side padding')
  // A percentage padding resolves against the containing block, so centring a
  // 720px box with `calc(50% - 360px)` eats the whole column on a wide page and
  // the panel renders as a strip of vertical text. Centring is margin's job.
  check('the centred column is sized by its cap, never by percentage padding',
    !/\.sshwsp-panel-inner \{[^}]*padding:[^;}]*%/u.test(stylesText) &&
      !/\.sshwsp-panel-inner \{[^}]*padding:[^;}]*calc\(50%/u.test(stylesText),
    'a percentage padding resolves against the container, not the capped box')
  check('the tab labels exist in both dictionaries',
    ['panel.tabHosts', 'panel.tabWorkspaces', 'panel.tabSettings', 'panel.tabsLabel']
      .every(key => (client.match(new RegExp(`'${key.replace(/\./gu, '\\.')}':`, 'gu')) ?? []).length === 2),
    'a tab without a label renders as its key in one language')
  // The list is ids, not records. Dereferencing a field off a string yields
  // `undefined`, and the whole row degrades silently in a way that still
  // "renders five tabs": every label folds to an empty string, every id becomes
  // `sshwsp-tab-undefined`, and every click selects the same pane. Nothing
  // throws, so only this shape pins it down.
  check('the tab row iterates the id list rather than record fields',
    /const PANEL_TABS = \['hosts', 'workspaces', 'settings'\]/u.test(client) &&
      /PANEL_TABS\.map\(id => jsx\('button'/u.test(client) &&
      /children: t\(PANEL_TAB_KEYS\[id\]\)/u.test(client),
    'an id list read as records renders empty labels and one shared pane')

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
// C-01 (closed). The panel had four dialogs and wired
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
  const source = clientSource(packageRoot)

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
      liveIn('DirectoryBrowser', /className: 'sshwsp-dialog sshwsp-dialog-fill', \.\.\.dialog\.props/u),
    'the fourth dialog renders without role="dialog" / aria-modal / focus trap')
  check('...and its title is the label the dialog announces',
    liveIn('DirectoryBrowser', /id: dialog\.titleId, children: t\('browser\.title'/u),
    'aria-labelledby points at nothing')

  // Every row is a directory row, and it is the only row kind. The dialog used
  // to branch — a file was a static `div`, a directory a `button` — and then
  // briefly rendered both again; a file row is a thing this picker can neither
  // enter nor act on, so it is gone along with its glyph and its class. A
  // directory row is the control, and a type test has no business in the map:
  // the request (`dirs=1`) already guarantees what arrives.
  check('a directory row is a real button control',
    liveIn('DirectoryBrowser', /return jsx\('button', \{[\s\S]{0,600}?className: isPicked[\s\S]{0,160}?'sshwsp-entry sshwsp-entry-dir'/u) &&
      !/rowcheck|type: 'checkbox'/u.test(bodyOf('DirectoryBrowser')),
    'a directory row is no longer a button, or a checkbox column came back')
  check('...and no file row survives anywhere',
    !/sshwsp-entry-file|function FileIcon/u.test(source) &&
      !/entry\.type !== 'directory'[\s\S]{0,80}?sshwsp-entry/u.test(bodyOf('DirectoryBrowser')),
    'a file row, its glyph or its branch is back in a picker that only lists directories')
  // One picked row, not a selection set: this picker has exactly one verb, and a
  // set would only exist to serve a batch action that is not here.
  check('...and the picker holds one picked row, not a selection set',
    liveIn('DirectoryBrowser', /const \[picked, setPicked\] = React\.useState\(null\)/u) &&
      liveIn('DirectoryBrowser', /setPicked\(full\)/u) &&
      !/rowClassName|rowChildren|selectReduce/u.test(bodyOf('DirectoryBrowser')) &&
      !/new Set\(|new Map\(/u.test(bodyOf('DirectoryBrowser')),
    'a batch selection set came back to a picker with one verb')
  check('...and both pickers ask for directories only',
    (source.match(/limit=\$\{BROWSE_LIST_LIMIT\}&dirs=1/gu) ?? []).length === 2 &&
      !/BROWSE_LIST_LIMIT\}&all=1/u.test(source),
    'a picker asks for files it can neither enter nor act on')

  // A single click PICKS a row and a double click ENTERS it. A single click used
  // to enter, which made the listing impossible to read; it then did nothing at
  // all, which meant the only way to act on a subdirectory was to enter it first.
  // Picking separates "which one" from "go there". Keyboard activation arrives
  // as a click carrying `detail === 0`; it picks too, and pressing it again on
  // the picked row enters — otherwise the pickers would be mouse-only again.
  check('a single click picks a row and a double click enters it',
    liveIn('DirectoryBrowser', /onDoubleClick: \(\) => handleEntry\(entry\)/u) &&
      liveIn('DirectoryBrowser', /if \(event\.detail === 0 && isPicked\) \{ handleEntry\(entry\); return \}/u) &&
      liveIn('DirectoryBrowser', /setPicked\(full\)/u),
    'a single click navigates again, or a keyboard user cannot pick and then enter')
  check('...and the remote workspace picker uses the same gesture',
    liveIn('RemoteWorkspaceDialog', /onDoubleClick: \(\) => handleEntry\(entry\)/u) &&
      liveIn('RemoteWorkspaceDialog', /if \(event\.detail === 0 && isPicked\) \{ handleEntry\(entry\); return \}/u) &&
      liveIn('RemoteWorkspaceDialog', /setPicked\(full\)/u),
    'the two directory pickers disagree about how a row is picked and entered')
  // The pick has to be the thing the verb acts on, or it is decoration.
  check('the mount target is the picked row, else the listed directory',
    liveIn('DirectoryBrowser', /const target = picked \?\? path/u) &&
      liveIn('DirectoryBrowser', /remotePath: target,/u),
    'the pick is decoration: the request still mounts the listed directory')
  check('...and creating a workspace uses the same rule',
    liveIn('RemoteWorkspaceDialog', /const target = picked \?\? path/u) &&
      liveIn('RemoteWorkspaceDialog', /remotePath: target,/u),
    'a workspace would be created at the listed directory no matter which row was picked')
  // A refresh can remove the row the pick named. The pick must go with it, or the
  // button keeps acting on a directory that is no longer on screen.
  check('...and a new listing drops the pick',
    liveIn('DirectoryBrowser', /setPicked\(null\)/u) &&
      liveIn('RemoteWorkspaceDialog', /setPicked\(null\)/u),
    'an invisible target survives a refresh')
  check('the picked row is painted and announced',
    /\.sshwsp-entry-picked \{[^}]*box-shadow/u.test(source) &&
      (source.match(/'aria-current': isPicked \? 'true' : undefined/gu) ?? []).length === 2,
    'a pick with no visible state is a pick the user cannot verify')
  // Both buttons name their target, and the dialog says it in words: the path bar
  // keeps showing the LISTED directory, so a pick that only changes a tooltip
  // leaves the user reading one path while the click uses another.
  check('the target is stated in words, not only in a tooltip',
    /t\('browser\.picked', \{ path: target \}\)/u.test(source) &&
      /t\('remote\.picked', \{ path: target \}\)/u.test(source) &&
      /title: target \?\? undefined/u.test(source) &&
      (source.match(/'browser\.picked': '[^']*'|'remote\.picked': '[^']*'/gu) ?? []).length === 4,
    'the visible path and the acted-on path can disagree without a word about it')

  // ONE scrollport per dialog, and it is the LIST — not the body. Both listings
  // used to carry a max-height of their own inside a body that ALSO scrolled;
  // the body then clipped the list at a point the list had already scrolled
  // past, and the rows below that point could never be reached. Handing the
  // whole body the scroll instead is the opposite failure: the form and the
  // path bar slide away while the user is picking a directory. So the body is a
  // flex column that never scrolls, and the list takes the leftover height.
  check('the directory list is the dialog\'s one scrollport',
    /\.sshwsp-browser-list \{[^}]*overflow-y: auto/u.test(source) &&
      /\.sshwsp-dirlist \{[^}]*overflow-y: auto/u.test(source) &&
      !/\.sshwsp-browser-list \{[^}]*max-height/u.test(source) &&
      !/\.sshwsp-dirlist \{[^}]*max-height/u.test(source),
    'a list caps its own height or stopped scrolling, so the dialog has two scrollers or none')
  check('...and the dialog body is a flex column, never a second scroller',
    /\.sshwsp-dialog-body \{[^}]*overflow: hidden/u.test(source) &&
      /\.sshwsp-dialog-body \{[^}]*display: flex/u.test(source) &&
      !/\.sshwsp-dialog-body \{[^}]*overflow-y: auto/u.test(source),
    'the body scrolls too, so the form slides out of view while the list is being read')
  check('...and the fixed head of each list dialog does not shrink away',
    /\.sshwsp-form \{[^}]*flex: 0 0 auto/u.test(source) &&
      /\.sshwsp-browser-header \{[^}]*flex: 0 0 auto/u.test(source) &&
      !/\.sshwsp-browser-header \{[^}]*position: sticky/u.test(source),
    'the form or the path bar is still a flex-shrinking or sticky element of a list that no longer scrolls under it')
  check('...which needs a height, not just a cap, for flex to divide',
    /\.sshwsp-dialog-fill \{[^}]*height: min\(88vh, 760px\)/u.test(source) &&
      /\.sshwsp-dialog-fill \{[^}]*max-height: 88vh/u.test(source) &&
      (source.match(/className: 'sshwsp-dialog sshwsp-dialog-fill'/gu) ?? []).length === 2,
    'a max-height-only dialog shrinks to its content, so the list never scrolls; a height under the base 80vh cap is silently clipped back')
  check('...and the form above the list never becomes a scroller of its own',
    /\.sshwsp-form \{[^}]*box-sizing: border-box/u.test(source) &&
      !/\.sshwsp-form \{[^}]*overflow-y: auto/u.test(source),
    'a scrolling form hides the field the user is typing into, right next to a scrolling list')
  check('...and a short window tightens the chrome instead of squeezing the list',
    /@media \(max-height: 620px\) \{\s*\.sshwsp-form \{ padding: 10px 20px/u.test(source) &&
      /@media \(max-height: 500px\) \{[^}]*\.sshwsp-dialog-fill \{ height: calc\(100vh - 12px\)/u.test(source) &&
      /@media \(max-height: 500px\) \{[\s\S]{0,400}?\.sshwsp-dirlist-hint \{ display: none/u.test(source),
    'the dialog keeps its 88vh height and full padding at 380px, so the title bar and form leave the listing 23 pixels')
  check('...and the browser frame is not a scroll container either',
    /\.sshwsp-browser \{[^}]*overflow: clip/u.test(source),
    "overflow: hidden makes the frame a scroll container whose sticky child never sticks")

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
    liveIn('rowMenuModel', /translate\('rowmenu\.copyPath'\)/u),
    'the row menu has no copy action')
  check('...copying the ssh:// spelling, not the bare remote path',
    liveIn('copyRowPath', /writeText\(absPath\)/u),
    'a bare /home/x paste names a path on whatever machine the reader is on')
  check('...and reports a refused clipboard instead of failing silently',
    liveIn('copyRowPath', /translate\('rowmenu\.copyUnavailable'\)/u) &&
      (bodyOf('copyRowPath').match(/rowmenu\.copyUnavailable/gu) ?? []).length === 2,
    'a copy that quietly did nothing leaves stale clipboard content behind')
  check('the row menu offers rename and delete for remote rows',
    liveIn('rowMenuModel', /translate\('rowmenu\.rename'\)/u) &&
      liveIn('rowMenuModel', /translate\('rowmenu\.delete'\)/u),
    'the row menu has no rename/delete actions')
  check('...and both are appended to every menu, not only inside the remote branch',
    /const destructive = \[\]/u.test(bodyOf('rowMenuModel')) &&
      /return \[\.\.\.items, \.\.\.destructive\]/u.test(bodyOf('rowMenuModel')),
    'rename/delete sit inside the remote-only branch')
  check('...at most eight descriptors, and ONE renderer that draws them',
    (bodyOf('rowMenuModel').match(/id: '/gu) ?? []).length <= 8 &&
      (source.match(/createTransferItem\(/gu) ?? []).length === 1 &&
      (source.match(/createMenuSeparator\(\)/gu) ?? []).length === 1 &&
      !/menuitem-desc/u.test(bodyOf('rowMenuModel')),
    'a second renderer, a description line, or more than eight items came back')
  // There is no longer a SECOND verb for a batch: one item, one label, and the
  // decision of what it acts on belongs to `resolveTargets` alone. A menu that
  // grew a batch entry back would be a second answer to the same question.
  check('...and there is exactly one download verb, whatever the selection',
    (bodyOf('rowMenuModel').match(/translate\('transfer\.download'\)/gu) ?? []).length === 1 &&
      !/batch/u.test(bodyOf('rowMenuModel')) &&
      (bodyOf('rowMenuModel').match(/translate\('rowmenu\.delete'\)/gu) ?? []).length === 1,
    'a second, selection-sized verb came back into the row menu')
  check('...with its own rule directly above the destructive group',
    /destructive\[0\]\.separatorBefore = true/u.test(bodyOf('rowMenuModel')) &&
      /if \(entry\.separatorBefore === true\) menu\.appendChild\(createMenuSeparator\(\)\)/u.test(bodyOf('renderMenuDom')),
    'the group rule is sniffed off the last child again, or the destructive group lost it')
  check('...and a right-click hands the whole selection to the model',
    (() => {
      const body = bodyOf('installTreeMenuBridge')
      // The bridge must not pre-filter the selection. Every rule about "this
      // row" versus "these rows" lives in ONE function, and a second copy here
      // (only when the row happened to be inside a batch) is a second answer
      // waiting to disagree with what the action then does.
      return /openTaskMenu\(ctx, path, kind === 'directory', treeRootOf\(row\), x, y, undefined, \{ items: selected \}\)/u.test(body) &&
        !/inSelection/u.test(body) &&
        /resolveTargets\(clickedRow, selection\?\.items\)/u.test(bodyOf('rowMenuModel'))
    })(),
    'the bridge decided the target set before resolveTargets could')
  check('the fallback menu wears the Host context menu metrics, and the chooser keeps its two-line size',
    // The plugin sheet is what draws when the Host has no context-menu service —
    // and what draws when the Host refuses to open one. It stands in for the
    // Host's own menu, so it has to measure like it: content-sized between 144px
    // and 360px, a 16px sheet radius, 34px rows at 6px 8px padding with a 12px
    // item radius, and a .5px rule inset by 8px. It used to run 24px rows at a
    // 12px label inside a fixed 220px sheet, which read as a different menu.
    /\.sshwsp-flowmenu \{[^}]*width: max-content; min-width: min\(144px, calc\(100vw - 24px\)\); max-width: min\(360px, calc\(100vw - 24px\)\)/u.test(source) &&
      /\.sshwsp-flowmenu \{ position: fixed;[^}]*border-radius: var\(--sshwsp-radius-lg\)/u.test(source) &&
      /\.sshwsp-menuitem \{[^}]*min-height: 34px;[^}]*padding: 6px 8px;[^}]*border-radius: var\(--sshwsp-radius-md\)/u.test(source) &&
      /\.sshwsp-menusep \{ height: 0\.5px; margin: 3px 8px;/u.test(source) &&
      // The chooser keeps its own geometry: two-line rows are its whole point,
      // so it is the one sheet that is fixed-width and lets the label wrap.
      /\.sshwsp-flowmenu-roomy \{ width: 250px; max-width: none;/u.test(source) &&
      /\.sshwsp-flowmenu-roomy \.sshwsp-menuitem \{ align-items: flex-start; gap: 10px; min-height: 0; padding: 9px 10px; \}/u.test(source) &&
      /\.sshwsp-flowmenu-roomy \.sshwsp-menuitem-text \{ overflow: visible; white-space: normal; \}/u.test(source) &&
      /sshwsp-flowmenu sshwsp-flowmenu-roomy/u.test(source),
    'the fallback menu stopped matching the Host menu it stands in for, or the chooser lost its two-line rows')
  check('...and a content-sized sheet is measured, not assumed',
    // The companion to the rule above: the old clamp subtracted a fixed 220px,
    // which would slide a 360px menu off the right edge. It has to read the
    // mounted element — and keep the constant only as the not-yet-laid-out
    // fallback.
    /const sheetWidth = el\.getBoundingClientRect\(\)\.width/u.test(source) &&
      /el\.appendChild|document\.body\.appendChild\(el\)[\s\S]{0,600}?getBoundingClientRect\(\)\.width/u.test(source) &&
      !/window\.innerWidth - FLOW_MENU_WIDTH - 8/u.test(source),
    'the clamp went back to a fixed width, so a wide menu can overflow')
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
// The rule itself lives in `scripts/client-map.mjs` so `npm run check` can
// enforce it on every run, and so it still means something once the bundle has
// more than one part. This suite reports it as assertions.
{
  const verdict = compareClientMap()
  const described = verdict.parts.filter(part => part.entries.length > 0)
  check('the map lists at least one section', described.length > 0 && described.every(part => part.sections.length > 0),
    JSON.stringify(verdict.parts.map(part => ({ name: part.name, sections: part.sections.length }))))
  for (const part of verdict.parts) {
    if (part.entries.length === 0) continue
    check(`${part.name}: the map numbers its entries consecutively from 1`, part.numbersOk)
    check(`${part.name}: every section banner appears in the map`, part.missingFromMap.length === 0,
      `missing ${JSON.stringify(part.missingFromMap)}`)
    check(`${part.name}: the map names no section that does not exist`, part.phantomInMap.length === 0,
      `phantom ${JSON.stringify(part.phantomInMap)}`)
    check(`${part.name}: the map lists the sections in file order`, part.orderOk,
      JSON.stringify({ map: part.entries, actual: part.sections }))
    check(`${part.name}: no banner describes an empty section`, part.emptySections.length === 0,
      JSON.stringify(part.emptySections))
  }
}

if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
// ---------------------------------------------------------------- provenance
console.log('\n[provenance] the panel admits how old the cached sections are')
{
  const source = clientSource(packageRoot)
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
  const client = clientSource(packageRoot)
  const routes = routeSource(packageRoot)
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
    // The route moved into lib/routes/transfers.js; the claim is unchanged —
    // the raw endpoint still exists and is still behind the raw guard.
    readFileSync(path.join(packageRoot, 'lib', 'routes', 'transfers.js'), 'utf8').includes('path: ROUTES.upload') &&
      readFileSync(path.join(packageRoot, 'lib', 'routes', 'transfers.js'), 'utf8').includes("guardRaw(req, res, 'POST')"),
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
  const client = clientSource(packageRoot)
  const routes = routeSource(packageRoot)
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
  const client = clientSource(packageRoot)
  const transfer = readFileSync(path.join(packageRoot, 'lib', 'transfer', 'transfer.js'), 'utf8')

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
  const client = clientSource(packageRoot)

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
  const source = clientSource(packageRoot)
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
    // Same SIZE as the zone head so the block still reads as one unit, lighter
    // WEIGHT so it reads as one level down. The sizes are scale tokens now, so
    // the assertion pins the relationship rather than the number: a rewrite
    // that made h4 the same weight would be the regression, and it is the one
    // that actually made the subheading look like a second title.
    /\.sshwsp h4 \{ font-size: var\(--sshwsp-font-xs\); font-weight: 400; margin: 0 0 10px;/u.test(source) &&
      /\.sshwsp h3 \{ font-size: var\(--sshwsp-font-xs\); font-weight: 500;/u.test(source),
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
  const source = clientSource(packageRoot)
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
  const source = clientSource(packageRoot)
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
      source.includes('policyOf(claim)') &&
      source.includes('node.disabled = true') &&
      source.includes('policyGate(policy, remoteTargetOf(absPath) === null)'),
    'the menu offers destructive actions a read-only session will refuse')
  check('no entry into the removed tab survives anywhere',
    !/browse\.entry/u.test(source) && !/browse\.tabTitle/u.test(source) && !/browse\.slotMissing/u.test(source),
    'the panel still advertises a tab that is gone')
  // The menu has ONE renderer, and it is this plugin's. Handing the model to
  // the host's context-menu service is what made the same right-click look like
  // the host in a local tree and like the plugin in a remote one.
  check('the tree menu is drawn by this plugin and nothing else',
    /function renderMenuDom \(model, x, y\)/u.test(source) &&
      /function openTreeMenu \(model, x, y\) \{\s*return renderMenuDom\(model, x, y\)/u.test(source) &&
      !/hostMenuEntries|openHostMenu|registerHostMenuProvider|hostMenusOf/u.test(source),
    'a second renderer is back, or openTreeMenu stopped drawing')
  check('...and the client still asks the host for nothing extra',
    /const inject = \['slots', 'locale'\]/u.test(source) &&
      !/\.get\??\.\('contextMenus'\)/u.test(source),
    'the menu grew a host service dependency')
  check('...while a right-click inside a host menu is still not a menu gesture',
    /target\.closest\(`\[\$\{TASK_MENU_ATTR\}\], \[\$\{CONTEXT_MENU_ATTR\}\]`\)/u.test(source),
    'right-clicking inside a menu reopens ours over it')
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

// The marks observer is the one listener that sees EVERY streamed token, so its
// cost is a property of the module, not of a component. These three assertions
// are the observable half of "a burst must not scan the document per token".
{
  const marksSource = readFileSync(path.join(here, '..', 'lib', 'client', 'client.marks.js'), 'utf8')
  check('the marks observer does not retain the replaced text of every token',
    /characterDataOldValue:\s*false/u.test(marksSource), 'characterDataOldValue is not disabled')
  check('...and coalesces passes behind a minimum interval',
    /const MARKS_MIN_INTERVAL_MS = \d+/u.test(marksSource) && /lastMarkPassAt/u.test(marksSource),
    'no interval gate, so a token burst still schedules a pass per frame')
  check('...whose pending timer is cleared when the module is uninstalled',
    /clearTimeout\(markPassTimer\)/u.test(marksSource), 'a queued pass survives dispose')
}

// A numeric summary, in the same `=== N passed, M failed ===` shape every other
// suite prints. Without it, a script that totals the run by summing these lines
// skips this suite's assertions silently — which is exactly how its count came
// to be missing from the documentation three times in a row.
console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
process.exit(failures.length === 0 ? 0 : 1)
