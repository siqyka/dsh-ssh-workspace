/**
 * Behaviour checks for the error toast's model, copy and replay actions.
 *
 * The controller is lifted from the shipped bundle by the shared harness. The
 * first half drives the pure model (what a diagnostic block contains, and when
 * a retry is even legal); the second half drives the real DOM path, because
 * "the button is hidden" and "the node is rewritten in place" are properties of
 * the renderer, not of the model.
 *
 * Run: node tests/toast-smoke.mjs
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeToastDom } from './support/toast-dom.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const client = await readFile(path.join(pluginRoot, 'lib/client.js'), 'utf8')

const failures = []
let passed = 0
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`ok   ${label}`)
    return
  }
  const suffix = detail === undefined ? '' : ` — ${detail}`
  failures.push(`${label}${suffix}`)
  console.log(`FAIL ${label}${suffix}`)
}

/** Wait for one macrotask so an `await`-ed clipboard/retry settles. */
const settle = () => new Promise(resolve => setImmediate(resolve))

/**
 * Drive one toast through its real controller.
 *
 * @returns {{api: object, dom: object, root: () => object}}
 */
function makeToast () {
  const dom = makeToastDom()
  const api = dom.build(client)
  return {
    api,
    dom,
    root: () => dom.nodes[0],
  }
}

/** Click one action by dispatching a bubbling click at its button. */
function clickAction (api, root, name) {
  const button = root.querySelector(`[data-toast-action="${name}"]`)
  check(`the ${name} action exists`, button !== null)
  if (button !== null) root.emit('click', { target: button })
  return button
}

// =========================================================================
// Pure model
// =========================================================================

{
  const { api } = makeToast()
  const model = api.toastModel({ kind: 'err', text: 'connection failed', code: 'SSHWSP-E-HOST-TEST', detail: new Error('boom'), retry: async () => null })
  check('an error keeps its diagnostic code', model.code === 'SSHWSP-E-HOST-TEST', model.code)
  check('...and the raw Error stack, not just its message',
    model.detail.includes('boom') && model.detail.includes('Error'), model.detail.slice(0, 80))
  check('...and the retry function', typeof model.retry === 'function')
  check('the copy block names the code', api.toastCopyText(model).includes('[SSHWSP-E-HOST-TEST]'))
  check('...and carries the raw detail', api.toastCopyText(model).includes('boom'))
}

{
  const { api } = makeToast()
  const model = api.toastModel({ kind: 'err', text: 'no code supplied' })
  check('an error without a code gets the stable fallback', model.code === 'SSHWSP-E-UNEXPECTED', model.code)
}

{
  const { api } = makeToast()
  let called = 0
  const model = api.toastModel({ kind: 'ok', text: 'fine', code: 'SSHWSP-E-NOPE', retry: () => { called += 1 } })
  check('a success carries no code', model.code === '')
  check('a success cannot carry a retry', model.retry === null)
  check('...and its retry is never called', called === 0)
}

{
  const { api } = makeToast()
  check('a string is still a valid toast', api.toastModel('plain').text === 'plain')
  check('a string is neutral by default', api.toastModel('plain').kind === 'muted')
  check('a string passed with an explicit face uses it', api.toastModel('plain', 'err').kind === 'err')
  check('the diagnostic text of a plain object is JSON', api.toastDiagnosticText({ a: 1 }).includes('"a": 1'))
  check('an empty value has no diagnostic text', api.toastDiagnosticText(null) === '')
}

// =========================================================================
// Rendering, details, copy and focus
// =========================================================================

{
  const { api, dom, root } = makeToast()
  api.notifyUser({ kind: 'err', text: 'could not connect', code: 'SSHWSP-E-HOST-TEST', detail: new Error('socket went away'), retry: async () => null })
  const el = root()
  check('an error renders one node', dom.nodes.length === 1, String(dom.nodes.length))
  check('...with role="alert"', el.getAttribute('role') === 'alert')
  check('...focusable without taking focus', el.tabIndex === 0 && dom.document.activeElement === dom.document.body)
  check('...showing the headline', el.querySelector('.sshwsp-toast-line').textContent === 'could not connect')
  check('...with the code visible only after Details is opened', el.querySelector('.sshwsp-toast-detail').hidden === true)
  check('...whose trigger starts collapsed', el.querySelector('[data-toast-action="details"]').getAttribute('aria-expanded') === 'false')
  check('...and the raw detail is already in the node', el.querySelector('pre').textContent.includes('socket went away'))
  check('...with Retry offered because the action is replayable', el.querySelector('[data-toast-action="retry"]').hidden === false)
  check('...and Copy offered', el.querySelector('[data-toast-action="copy"]').hidden === false)

  const details = clickAction(api, el, 'details')
  check('Details opens the raw panel', el.querySelector('.sshwsp-toast-detail').hidden === false)
  check('...and flips aria-expanded', details.getAttribute('aria-expanded') === 'true')
  clickAction(api, el, 'details')
  check('Details closes it again', el.querySelector('.sshwsp-toast-detail').hidden === true)
  check('...and flips aria-expanded back', details.getAttribute('aria-expanded') === 'false')
  check('toggling Details does not dismiss the toast', dom.nodes.length === 1)
  check('toggling Details does not restart the clock', dom.timers.length === 1 && dom.live().length === 1)

  clickAction(api, el, 'copy')
  await settle()
  check('Copy puts the whole diagnostic block on the clipboard', dom.copies.length === 1)
  check('...including the code', dom.copies[0].includes('[SSHWSP-E-HOST-TEST]'))
  check('...including the raw error', dom.copies[0].includes('socket went away'))
  check('...and says so in place', el.querySelector('.sshwsp-toast-status').textContent === 'toast.copied')
  check('...without creating a second toast', dom.nodes.length === 1)
}

{
  // The fallback must be visible, not a silent no-op: the panel opens and the
  // raw text is selected, so Ctrl+C works where writeText was refused.
  const { api, dom, root } = makeToast()
  api.notifyUser({ kind: 'err', text: 'permission denied', code: 'SSHWSP-E-CLIPBOARD', detail: 'denied by policy' })
  const el = root()
  dom.clipboard.writeText = async () => { throw new Error('NotAllowedError') }
  clickAction(api, el, 'copy')
  await settle()
  check('a refused clipboard opens the detail', el.querySelector('.sshwsp-toast-detail').hidden === false)
  check('...marks the disclosure expanded', el.querySelector('[data-toast-action="details"]').getAttribute('aria-expanded') === 'true')
  check('...selects the whole diagnostic block (code + raw error)', dom.selection.ranges.length === 1 &&
    dom.selection.ranges[0].node === el.querySelector('.sshwsp-toast-detail') &&
    dom.selection.ranges[0].text.includes('[SSHWSP-E-CLIPBOARD]') &&
    dom.selection.ranges[0].text.includes('denied by policy'))
  check('...and says the text is selected', el.querySelector('.sshwsp-toast-status').textContent === 'toast.copyFallback')
  check('...without opening a second toast', dom.nodes.length === 1)
  check('...and without touching the clock', dom.timers.length === 1 && dom.live().length === 1)
  check('nothing was claimed to be copied', dom.copies.length === 0)
}

{
  const { api, dom, root } = makeToast()
  api.notifyUser({ kind: 'err', text: 'static failure', code: 'SSHWSP-E-STATIC' })
  const el = root()
  check('an unreplayable failure renders no Retry button', el.querySelector('[data-toast-action="retry"]').hidden === true)
  check('...and does not disguise it as a disabled button', el.querySelector('[data-toast-action="retry"]').disabled === false)
}

{
  const { api, dom, root } = makeToast()
  api.notifyUser('saved', 'ok')
  const el = root()
  check('a success is a status, not an alert', el.getAttribute('role') === 'status')
  check('a success has no error actions', el.querySelector('.sshwsp-toast-actions').hidden === true)
  check('a success keeps the plain line', el.querySelector('.sshwsp-toast-line').textContent === 'saved')
}

{
  // Closing a toast the user never entered must NOT move focus, even though
  // the toast remembers where focus was when it appeared.
  const { api, dom } = makeToast()
  const source = dom.document.createElement('button')
  dom.document.body.appendChild(source)
  source.focus()
  api.notifyUser({ kind: 'err', text: 'never entered', code: 'SSHWSP-E-FOCUS-2' })
  const el = dom.nodes.find(node => node.getAttribute('data-sshwsp-toast') === '1')
  const other = dom.document.createElement('button')
  dom.document.body.appendChild(other)
  other.focus()
  el.emit('click', { target: el })
  check('closing a notice the user never entered leaves focus alone', dom.document.activeElement === other)
}

{
  const { api, dom, root } = makeToast()
  api.notifyUser({ kind: 'err', text: 'focus test', code: 'SSHWSP-E-FOCUS' })
  check('showing a failure leaves focus where it was', dom.document.activeElement === dom.document.body)
  const el = root()
  el.querySelector('[data-toast-action="details"]').focus()
  el.emit('keydown', { key: 'Escape', target: el })
  check('dismissing from inside returns focus to the source', dom.document.activeElement === dom.document.body)
  check('...and removes the node', dom.nodes.length === 0)
}

// =========================================================================
// Retry: same node, same clock
// =========================================================================

{
  const { api, dom, root } = makeToast()
  let attempts = 0
  api.notifyUser({
    kind: 'err',
    text: 'first attempt failed',
    code: 'SSHWSP-E-RETRY',
    detail: 'raw reason',
    retry: async () => {
      attempts += 1
      return { kind: 'ok', text: 'second attempt worked' }
    },
  })
  const el = root()
  const timersBefore = dom.timers.length
  const retry = clickAction(api, el, 'retry')
  check('Retry starts disabled while working', retry.disabled === true)
  check('Retry shows progress in the same node', el.querySelector('.sshwsp-toast-status').textContent === 'toast.retrying')
  await settle()
  check('the replay produced exactly one attempt', attempts === 1)
  check('the result rewrote the SAME node', dom.nodes.length === 1 && dom.nodes[0] === el)
  check('...into a success', el.getAttribute('role') === 'status' && el.className.includes('sshwsp-toast-ok'))
  check('...with the new sentence', el.querySelector('.sshwsp-toast-line').textContent === 'second attempt worked')
  check('...and no error actions left visible', el.querySelector('.sshwsp-toast-actions').hidden === true)
  check('Retry did not restart the dismissal clock', dom.timers.length === timersBefore && dom.live().length === 1)
  check('...still seven seconds', dom.live()[0].ms === 7000, String(dom.live()[0]?.ms))
}

{
  const { api, dom, root } = makeToast()
  api.notifyUser({
    kind: 'err',
    text: 'first attempt failed',
    code: 'SSHWSP-E-RETRY-FAIL',
    retry: async () => { throw new Error('still down') },
  })
  const el = root()
  clickAction(api, el, 'retry')
  await settle()
  check('a throwing replay stays one node', dom.nodes.length === 1 && dom.nodes[0] === el)
  check('...rewrites the headline as a retry failure', el.querySelector('.sshwsp-toast-line').textContent === 'toast.retryFail')
  check('...keeps the original diagnostic code', el.querySelector('.sshwsp-toast-detail-code').textContent === '[SSHWSP-E-RETRY-FAIL]')
  check('...carries the new error in the detail', el.querySelector('pre').textContent.includes('still down'))
  check('...and still offers another retry', el.querySelector('[data-toast-action="retry"]').hidden === false)
}

// =========================================================================
// Hover pause
// =========================================================================

{
  const { api, dom, root } = makeToast()
  api.notifyUser({ kind: 'err', text: 'read me', code: 'SSHWSP-E-HOVER' })
  const el = root()
  check('one clock is armed at seven seconds', dom.live().length === 1 && dom.live()[0].ms === 7000)
  el.emit('mouseenter')
  check('resting on the toast cancels the clock', dom.live().length === 0)
  el.emit('mouseleave')
  check('leaving restarts the full window', dom.live().length === 1 && dom.live()[0].ms === 7000)
  check('...without a second timer', dom.timers.length === 2)
}

// =========================================================================
// Transfer notice: in flight, then the same node becomes the outcome
// =========================================================================

{
  const { api, dom } = makeToast()
  const handle = api.transferNotice('uploading report.zip')
  const el = dom.nodes[0]
  check('a transfer notice starts neutral', el.getAttribute('role') === 'status' && el.className.includes('sshwsp-toast-muted'))
  check('...with no clock while it is working', dom.live().length === 0)
  check('...and no error actions', el.querySelector('.sshwsp-toast-actions').hidden === true)
  handle.done('uploaded report.zip')
  check('the outcome rewrites the same node', dom.nodes.length === 1 && dom.nodes[0] === el)
  check('...turns green', el.className.includes('sshwsp-toast-ok'))
  check('...and starts the clock only now', dom.live().length === 1 && dom.live()[0].ms === 7000)
}

{
  const { api, dom } = makeToast()
  const handle = api.transferNotice('uploading report.zip')
  const el = dom.nodes[0]
  handle.failed({ text: 'upload failed', code: 'SSHWSP-E-TRANSFER-UPLOAD', detail: 'connection reset' })
  check('a failed transfer is an alert', el.getAttribute('role') === 'alert')
  check('...with a diagnostic code', el.querySelector('.sshwsp-toast-detail-code').textContent === '[SSHWSP-E-TRANSFER-UPLOAD]')
  check('...and no retry (the queue row owns that action)', el.querySelector('[data-toast-action="retry"]').hidden === true)
}

// =========================================================================
// Source invariants: the things a DOM double cannot prove
// =========================================================================

{
  const source = client.slice(client.indexOf('function armToast (el, returnFocus = null)'), client.indexOf('function notifyUser (input, kind)'))
  check('armToast never takes focus', !/el\.focus\(\)/u.test(source))
  check('the clock is not re-armed by copy or details', !/function copyToast[^]*?schedule\(/u.test(
    client.slice(client.indexOf('function copyToast'), client.indexOf('function toggleToastDetails'))))
  check('retry only renders when the model carries a function',
    client.includes("parts.retry.hidden = typeof model.retry !== 'function'"))
  check('a Toast model has one write path', client.includes('function renderToast (el, model)'))
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
