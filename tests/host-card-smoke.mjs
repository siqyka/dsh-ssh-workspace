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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { endOfBlock } from './support/toast-dom.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

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

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
