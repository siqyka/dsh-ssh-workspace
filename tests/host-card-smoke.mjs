/**
 * The host card may only offer "断开" on a connection that exists.
 *
 * ## The bug this suite exists for
 *
 * The disconnect button was guarded by `conn && …` — "the panel knows of a
 * connection record". That record also exists for a `broken` socket (which the
 * card next to it labels "已断开") and for the retry row the panel synthesises
 * from the reconnector's state. The card therefore offered to disconnect a host
 * it had just reported as disconnected, on the same row, in the same frame.
 *
 * ## Why the whole component, rendered
 *
 * The guard lives inside an array of conditionals spread across 60 lines;
 * pinning it with a grep would stay green if the array were reordered so that
 * the "断开" branch rendered under another condition. So this suite lifts the
 * SHIPPED `HostCard` (brace-matched), binds `React.useState` to inert cells,
 * and inspects the returned element tree for buttons keyed `disconnect` /
 * `retry`. The states under test are exactly the ones the status route can
 * produce: connected, connected-with-in-flight, broken, reconnecting, and "no
 * record at all".
 *
 * Run: node tests/host-card-smoke.mjs
 */

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

console.log('\n=== host card smoke ===\n')

// ---- lift the shipped component ---------------------------------------------

const CARD_MARKER = 'function HostCard ({ host, t, conn'
const cardAt = source.indexOf(CARD_MARKER)
if (cardAt < 0) throw new Error('client.js no longer defines HostCard')
const signatureEnd = source.indexOf(') {', cardAt)
if (signatureEnd < 0) throw new Error('HostCard no longer takes a destructured props object')
const bodyEnd = endOfBlock(source, signatureEnd + 2)
const cardSource = source.slice(cardAt, bodyEnd)
if (!cardSource.startsWith('function HostCard') || !cardSource.endsWith('}')) {
  throw new Error('the HostCard slice is not a complete function')
}

/**
 * Render one card with inert hooks and recording element stubs.
 *
 * @param {object} conn - what the panel's conn map holds for this alias.
 * @param {object} [overrides] - host / props overrides.
 * @returns {object} the element tree the card returned.
 */
function renderCard (conn, overrides = {}) {
  const host = {
    alias: 'alpha',
    user: 'deploy',
    host: 'example.test',
    port: 2222,
    auth: 'key',
    keyReady: true,
    source: 'store',
    description: '',
    tags: [],
    ...overrides.host,
  }
  const jsx = (type, props) => ({ type, props })
  const jsxs = jsx
  const React = {
    // HostCard only reads state during this render; every setter is reached
    // from an onClick that this suite never fires.
    useState: (initial) => [initial, () => {}],
    createElement: (type, props) => ({ type, props }),
  }
  const t = (key) => key
  const relativeTimeText = () => 'now'
  // eslint-disable-next-line no-new-func
  const factory = new Function('React', 'jsx', 'jsxs', 't', 'relativeTimeText',
    `${cardSource}; return HostCard`)
  const HostCard = factory(React, jsx, jsxs, t, relativeTimeText)
  return HostCard({
    host,
    t,
    conn,
    onTest: () => {},
    onBrowse: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onForgetKey: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
    onSetIntent: () => {},
    ...overrides.handlers,
    testState: undefined,
    deleteError: '',
    deleting: false,
  })
}

/** Yield every element in the tree, depth first. */
function * elementsOf (node) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    for (const item of node) yield * elementsOf(item)
    return
  }
  if (typeof node !== 'object' || node.type === undefined) return
  yield node
  yield * elementsOf(node.props?.children)
}

/** The card's action buttons, keyed as the code keys them. */
function actionsOf (tree) {
  return [...elementsOf(tree)].filter(node => node.type === 'button')
}
function actionKeyed (tree, key) {
  return actionsOf(tree).find(node => node.props.key === key)
}

/** The text of the first span whose child is that exact string. */
function hasText (tree, text) {
  return [...elementsOf(tree)].some(node => node.type === 'span' && node.props?.children === text)
}

/** The connection badge span, if this card has one. */
function badgeOf (tree) {
  return [...elementsOf(tree)].find(node => node.type === 'span' && (node.props?.className ?? '').includes('sshwsp-conn'))
}

const connected = { alias: 'alpha', state: 'connected', inFlight: 0 }
const broken = { alias: 'alpha', state: 'broken', inFlight: 0 }
function retryRow (phase, extra = {}) {
  return { alias: 'alpha', state: 'broken', inFlight: 0, retry: { phase, attempts: 2, nextAt: Date.now() + 60000, lastError: '', ...extra } }
}

// ---- the card itself ---------------------------------------------------------

const neverConnected = renderCard(undefined)
check('the card renders as a host card', neverConnected.type === 'div' &&
  neverConnected.props.className === 'sshwsp-card sshwsp-host')
check('a host with no record offers no disconnect and no retry',
  actionKeyed(neverConnected, 'disconnect') === undefined &&
  actionKeyed(neverConnected, 'retry') === undefined)
check('a host with no record carries no connection badge',
  badgeOf(neverConnected) === undefined)
check('the ordinary actions survive the guard',
  ['test', 'browse', 'edit', 'delete', 'forget'].every(key => actionKeyed(neverConnected, key) !== undefined))

// ---- connected ---------------------------------------------------------------

const connectedCard = renderCard(connected)
const connectedDisconnect = actionKeyed(connectedCard, 'disconnect')
check('a live connection offers the disconnect button', connectedDisconnect !== undefined)
check('a live idle connection leaves the button enabled',
  connectedDisconnect?.props.disabled === false)
check('a live connection has no retry button', actionKeyed(connectedCard, 'retry') === undefined)
check('a live connection is labelled as connected', hasText(connectedCard, 'connections.connected'))
check('a live connection paints the ok dot',
  [...elementsOf(connectedCard)].some(node => node.props?.className === 'sshwsp-dot sshwsp-dot-ok'))

const busyCard = renderCard({ ...connected, inFlight: 3 })
check('an in-flight operation disables the disconnect button',
  actionKeyed(busyCard, 'disconnect')?.props.disabled === true)
check('the disabled button explains itself',
  actionKeyed(busyCard, 'disconnect')?.props.title === 'hosts.disconnectBusy')
check('the badge reports the in-flight count', hasText(busyCard, 'connections.inFlight'))

// ---- not connected -----------------------------------------------------------

const brokenCard = renderCard(broken)
check('a broken connection does NOT offer the disconnect button',
  actionKeyed(brokenCard, 'disconnect') === undefined,
  'the card would offer to disconnect a host it labels 已断开')
check('a broken connection without a retry loop offers no retry either',
  actionKeyed(brokenCard, 'retry') === undefined)
check('a broken connection is labelled as disconnected', hasText(brokenCard, 'connections.broken'))
check('a broken connection paints the error dot',
  [...elementsOf(brokenCard)].some(node => node.props?.className === 'sshwsp-dot sshwsp-dot-err'))

const waitingCard = renderCard(retryRow('waiting'))
check('a reconnecting connection does NOT offer the disconnect button',
  actionKeyed(waitingCard, 'disconnect') === undefined)
check('a reconnecting connection offers the retry button',
  actionKeyed(waitingCard, 'retry') !== undefined)
check('a waiting retry is labelled with its next attempt', hasText(waitingCard, 'connections.reconnecting'))
check('a waiting retry paints the warning dot, not the error dot',
  [...elementsOf(waitingCard)].some(node => node.props?.className === 'sshwsp-dot sshwsp-dot-warn'))

check('a connecting retry is labelled as connecting',
  hasText(renderCard(retryRow('connecting')), 'connections.reconnectingNow'))
check('a gave-up retry is labelled as stopped',
  hasText(renderCard(retryRow('gave-up')), 'connections.gaveUp'))

const failingCard = renderCard(retryRow('waiting', { lastError: 'authentication failed' }))
check('a retry that carries an error prints it',
  [...elementsOf(failingCard)].some(node => node.props?.children === 'authentication failed'))

// ---- connection intent (autoConnect switch + connecting/failed badges) ------

// The checkbox is a MARKER for the persisted intent, not a switch for the
// socket. It must not read as "connected": a live host the user never ticked is
// off, and ticking it neither dials nor drops anything.
const checkboxOf = (tree) => [...elementsOf(tree)].find(node => node.type === 'input' && node.props?.type === 'checkbox')
check('every host card carries an auto-connect checkbox', checkboxOf(neverConnected) !== undefined)
check('a host with no intent leaves the box unchecked', checkboxOf(neverConnected)?.props.checked === false)
check('a live host with no intent still leaves the box unchecked',
  checkboxOf(connectedCard)?.props.checked === false)
const liveIntended = renderCard({ ...connected, autoConnect: true })
check('a live host with the intent checked shows the box checked',
  checkboxOf(liveIntended)?.props.checked === true)
const intentOnly = renderCard({ alias: 'alpha', state: 'broken', inFlight: 0, autoConnect: true })
check('a switched-on host with no socket still checks the box',
  checkboxOf(intentOnly)?.props.checked === true)
check('a marked host with no socket offers no disconnect (there is nothing to close)',
  actionKeyed(intentOnly, 'disconnect') === undefined)

// Ticking the box only writes the intent: it must reach onSetIntent and never
// the reconnect/disconnect handlers, which are the buttons' job.
{
  const calls = []
  const recorded = renderCard(connected, {
    handlers: {
      onSetIntent: (alias, enabled) => calls.push(['intent', alias, enabled]),
      onReconnect: (alias) => calls.push(['reconnect', alias]),
      onDisconnect: (alias) => calls.push(['disconnect', alias]),
    },
  })
  const box = checkboxOf(recorded)
  await box.props.onChange({ target: { checked: true } })
  await box.props.onChange({ target: { checked: false } })
  check('ticking the box records the intent only',
    JSON.stringify(calls) === JSON.stringify([['intent', 'alpha', true], ['intent', 'alpha', false]]),
    JSON.stringify(calls))
  check('the box is not gated on socket activity (it never touches the socket)',
    checkboxOf(renderCard({ ...connected, inFlight: 3 }))?.props.disabled === false)
}
// The power switch is a button too, so "the action set is unchanged" is no
// longer the same question as "no extra button exists": the switch must be
// OUTSIDE the keyed action set. Every card carries one — a store host keeps the
// flag in its entry, a ~/.ssh/config host in the store's `disabledAliases`
// list — and its title has to say which, because "switch off" is when someone
// wonders whether their ssh config was edited.
const powerSwitches = (tree) => [...elementsOf(tree)].filter(node => node.type === 'button' && node.props?.role === 'switch')
check('the auto-connect checkbox is not counted as an action button',
  ['test', 'browse', 'edit', 'delete', 'forget'].every(key => actionKeyed(neverConnected, key) !== undefined) &&
  powerSwitches(neverConnected).every(node => node.props?.key === undefined || !['test', 'browse', 'edit', 'delete', 'forget'].includes(node.props.key)))
check('a store host carries the power switch, checked while enabled',
  powerSwitches(neverConnected).length === 1 &&
  powerSwitches(neverConnected)[0].props['aria-checked'] === true &&
  powerSwitches(neverConnected)[0].props['data-sshwsp-power-source'] === 'store' &&
  powerSwitches(neverConnected)[0].props.title === 'hosts.powerOn')
check('...and a switched-off host shows it unchecked',
  powerSwitches(renderCard(undefined, { host: { enabled: false } }))[0]?.props['aria-checked'] === false)
check('an ssh-config host carries the switch too, and its title promises the file is untouched',
  (() => {
    const switches = powerSwitches(renderCard(undefined, { host: { source: 'ssh-config', enabled: true } }))
    return switches.length === 1 &&
      switches[0].props['aria-checked'] === true &&
      switches[0].props['data-sshwsp-power-source'] === 'ssh-config' &&
      switches[0].props.title === 'hosts.powerOnConfig'
  })())

// "connecting" is the boot dial: the switch is already on, only the handshake
// is outstanding. It must not render as the neutral "disconnected".
const connectingCard = renderCard({ alias: 'alpha', state: 'broken', inFlight: 0, autoConnect: true, connecting: true })
check('a connecting host is labelled connecting, not disconnected',
  hasText(connectingCard, 'connections.connecting') && !hasText(connectingCard, 'connections.broken'))
check('a connecting host paints the warning dot',
  [...elementsOf(connectingCard)].some(node => node.props?.className === 'sshwsp-dot sshwsp-dot-warn'))

// A fatal failure arms no retry row; `conn.failure` is the only channel that
// can say "connection failed" instead of the neutral "disconnected".
const failedConnect = renderCard({ alias: 'alpha', state: 'broken', inFlight: 0, failure: 'handshake failed' })
check('a failed connect is labelled connection failed',
  hasText(failedConnect, 'connections.failed') && !hasText(failedConnect, 'connections.broken'))
check('a failed connect paints the error dot',
  [...elementsOf(failedConnect)].some(node => node.props?.className === 'sshwsp-dot sshwsp-dot-err'))
check('a failed connect prints the reason even with no retry row',
  [...elementsOf(failedConnect)].some(node => node.props?.children === 'handshake failed'))

// ---- edges the status map can produce ---------------------------------------

// The panel synthesises this row for a reconnector entry whose host is not in
// `status.connections` at all — the record it builds defaults to `broken`.
check('a synthesised record (retry-only) is treated as not connected',
  actionKeyed(renderCard(retryRow('waiting')), 'disconnect') === undefined)

const sshConfigCard = renderCard(connected, { host: { source: 'ssh-config' } })
check('an ssh-config host hides edit and delete, but keeps disconnect',
  actionKeyed(sshConfigCard, 'edit') === undefined &&
  actionKeyed(sshConfigCard, 'delete') === undefined &&
  actionKeyed(sshConfigCard, 'disconnect') !== undefined)

// A store record whose alias ALSO has a Host block is half-owned: the panel used
// to offer both buttons because it only looked at `source`, so deleting the
// record uncovered the block (the host came back) and editing it shadowed the
// file for every other ssh client. `configAlias` is what the listing route adds
// for exactly this overlap; the card must honour it and say why.
const shadowedCard = renderCard(connected, { host: { source: 'store', configAlias: true } })
check('a store record that shadows a config alias hides edit and delete',
  actionKeyed(shadowedCard, 'edit') === undefined &&
  actionKeyed(shadowedCard, 'delete') === undefined)
check('...and it still offers the actions that do not rewrite the host',
  actionKeyed(shadowedCard, 'test') !== undefined &&
  actionKeyed(shadowedCard, 'browse') !== undefined)
check('...and it says where the host actually lives',
  [...elementsOf(shadowedCard)].some(node => node.props?.children === 'hosts.configShadow'))
check('a plain store record is still editable',
  actionKeyed(neverConnected, 'edit') !== undefined && actionKeyed(neverConnected, 'delete') !== undefined)

// ---- the meta row asks for interpolated keys --------------------------------
//
// The card builds both of these by interpolation — `t(`hosts.auth.${host.auth}`)`
// and `t(`hosts.source.${…}`)` — so the source contains no `t('hosts.auth.key')`
// anywhere. That is exactly why a sweep that only greps for literal keys read the
// whole family as unused and deleted it (f7e89a8), after which every card painted
// `hosts.auth.key` / `hosts.source.store` as literal text on screen.
//
// This suite can prove the half it owns: which key the card ASKS for, for every
// value the host record can carry. `locale-register-smoke` proves the other half —
// that both dictionaries answer each of them with real text.
const metaOf = (tree) => [...elementsOf(tree)].find(node => node.props?.className === 'sshwsp-host-meta')
function metaTexts (conn, overrides) {
  const meta = metaOf(renderCard(conn, overrides))
  if (meta === undefined) throw new Error('the card no longer renders a meta row')
  return [...elementsOf(meta)].filter(node => node.type === 'span').map(node => node.props?.children)
}

// Readiness leads the meta row. A missing key is the one fact there that can
// stop a connection from working, and it used to sit in the middle — after the
// auth method, before the source — so a card whose key is absent opened with
// "密钥" and pushed the warning into the reader's peripheral vision.
{
  const ready = metaTexts(undefined, { host: { keyReady: true, source: 'store' } })
  check('the meta row leads with the readiness pill', ready[0] === 'hosts.keyReady', JSON.stringify(ready))
  const missingKey = metaTexts(undefined, { host: { keyReady: false, source: 'store' } })
  check('...a missing key leads with the warning instead',
    missingKey[0] === 'hosts.keyMissing', JSON.stringify(missingKey))
  check('...and the pill still carries a status class',
    [...elementsOf(renderCard(undefined))].some(node =>
      node.props?.className === 'sshwsp-status sshwsp-status-ok' && node.props?.children === 'hosts.keyReady'))
  check('...with the auth method and the source after it',
    ready[2] === 'hosts.auth.key' && ready[4] === 'hosts.source.store', JSON.stringify(ready))
}

for (const kind of ['key', 'password', 'agent']) {
  check(`the meta row asks for hosts.auth.${kind} by interpolation`,
    metaTexts(undefined, { host: { auth: kind } }).includes(`hosts.auth.${kind}`),
    JSON.stringify(metaTexts(undefined, { host: { auth: kind } })))
}
// `source` arrives as `store` or `ssh-config`; the panel spells the second one
// `sshConfig`, and that spelling is the dictionary key — not the record's value.
check('a store host asks for hosts.source.store',
  metaTexts(undefined, { host: { source: 'store' } }).includes('hosts.source.store'),
  JSON.stringify(metaTexts(undefined, { host: { source: 'store' } })))
check('...and an ssh-config host asks for hosts.source.sshConfig, not the raw value',
  metaTexts(undefined, { host: { source: 'ssh-config' } }).includes('hosts.source.sshConfig') &&
  !metaTexts(undefined, { host: { source: 'ssh-config' } }).includes('hosts.source.ssh-config'),
  JSON.stringify(metaTexts(undefined, { host: { source: 'ssh-config' } })))

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
