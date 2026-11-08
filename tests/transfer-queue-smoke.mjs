/**
 * The transfer queue's scheduler, driven as a pure state machine.
 *
 * ## Why this suite lifts code out of the bundle
 *
 * `lib/client.js` is a single browser bundle with no build step: its parts are
 * not importable modules. The queue's interesting half was therefore written as
 * a pure reducer — no clock, no DOM, no translation, no `fetch` — and this
 * suite slices that region out of the SHIPPED file and runs it. A retyped copy
 * would prove nothing about the code users actually get, and that is the same
 * rule `client-shape-smoke` follows for the toasts.
 *
 * ## What is NOT covered here
 *
 * The workers (`runUploadJob`, `runDownloadJob`), the toast rewriting and the
 * popover are browser-side effects. They need a DOM, a `fetch` and a real
 * server, so the shape suite pins their wiring and this suite pins the rules
 * that decide what they are allowed to do.
 *
 * Run: node tests/transfer-queue-smoke.mjs
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const clientPath = path.join(packageRoot, 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

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

const START = '// ---- queue state machine (pure: no clock, no DOM, no translation)'
const END = '// ---- queue runtime (clock, workers, notices, subscriptions)'

/**
 * Lift the reducer and its helpers out of the shipped bundle.
 *
 * @returns {object} the pure API, bound to no DOM and no clock.
 */
function liftQueue () {
  const start = source.indexOf(START)
  if (start < 0) throw new Error('client.js no longer marks the pure queue state machine')
  const end = source.indexOf(END, start)
  if (end < 0) throw new Error('client.js no longer marks the queue runtime')
  const body = source.slice(start, end)
  // eslint-disable-next-line no-new-func
  const factory = new Function(`
    ${body}
    return {
      queueReduce,
      queueDrain,
      transferQueueIsTerminal,
      transferQueueActiveCount,
      queueItemPercent,
      transferQueueProgress,
      orderedTransferQueueItems,
      splitOversizeFiles,
      truncateTransferName,
      TRANSFER_QUEUE_LIMIT_TOTAL,
      TRANSFER_QUEUE_LIMIT_PER_HOST,
      TRANSFER_QUEUE_UPLOAD_LIMIT,
    }
  `)
  return factory()
}

let api
try {
  api = liftQueue()
} catch (error) {
  console.log(`\n  FAIL  the pure queue slice could not be lifted — ${error.message}`)
  process.exit(1)
}

const {
  queueReduce,
  transferQueueActiveCount,
  queueItemPercent,
  transferQueueProgress,
  orderedTransferQueueItems,
  splitOversizeFiles,
  truncateTransferName,
  TRANSFER_QUEUE_LIMIT_TOTAL,
  TRANSFER_QUEUE_LIMIT_PER_HOST,
  TRANSFER_QUEUE_UPLOAD_LIMIT,
} = api

const EMPTY = { items: [] }

/** The deterministic byte pattern makeFile exposes. */
function makeBytes (length) {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) % 256
  return bytes
}

/** A `File` double over bytes the real sender slices with `.slice().arrayBuffer()`. */
function makeFile (length, name = 'blob.bin') {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) % 256
  return {
    name,
    size: length,
    slice (start, end) {
      return { arrayBuffer: async () => bytes.slice(start, end).buffer }
    },
  }
}

/**
 * A fetch double whose requests are recorded and answered `{ok:true}`.
 *
 * `onRequest` may throw: that is how a transport death is simulated, and the
 * sender's retry/abort rules are what the assertions read back from `calls`.
 */
function recordingFetch (onRequest = null, answer = null) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body)
    calls.push(request)
    if (typeof onRequest === 'function') await onRequest(request, calls)
    const body = typeof answer === 'function'
      ? answer(request)
      : { ok: true, bytes: typeof request.data === 'string' && request.data !== '' ? Buffer.from(request.data, 'base64').length : 0 }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  return { calls, fetchImpl }
}

/**
 * One enqueue action for the given jobs, with a fixed clock.
 *
 * @param {object} state - the current store.
 * @param {object[]} jobs - id / alias / direction / name, optionally bytes.
 * @param {number} at - the action clock.
 * @returns {object} the next state.
 */
function enqueue (state, jobs, at = 1) {
  return queueReduce(state, {
    type: 'enqueue',
    at,
    items: jobs.map(job => ({
      direction: job.direction ?? 'upload',
      alias: job.alias ?? 'host-a',
      remotePath: job.remotePath ?? `/${job.id}`,
      name: job.name ?? job.id,
      bytesTotal: job.bytesTotal ?? null,
      id: job.id,
    })),
  })
}

/** The status of one id. */
function statusOf (state, id) {
  return state.items.find(item => item.id === id)?.status
}

/** The ids in one status. */
function idsIn (state, status) {
  return state.items.filter(item => item.status === status).map(item => item.id)
}

/**
 * Lift the queue DRIVER (state + workers + notices) out of the shipped bundle.
 *
 * The reducer is pure, but the interesting failure modes live one layer up:
 * does a settled item actually start the next one, does a cancel reach the
 * worker's context, and does a batch end as ONE merged sentence? Those are
 * driven here with a fake transport (a promise the test resolves) and a fake
 * toast that records every line it is given.
 *
 * @returns {object} the runtime API plus the toast log.
 */
function liftQueueRuntime () {
  const runtimeAborts = []
  const start = source.indexOf('// ---- queue runtime (clock, workers, notices, subscriptions)')
  if (start < 0) throw new Error('client.js no longer marks the queue runtime')
  const end = source.indexOf('// ---- uploads', start)
  if (end < 0) throw new Error('client.js no longer separates the runtime from upload jobs')
  const body = source.slice(start, end)
  const pure = liftQueue()
  const notices = []
  const translate = (key, params = {}) => {
    const text = {
      'transfer.uploadingName': 'Uploading {name}…',
      'transfer.downloading': 'Downloading {name}…',
      'transfer.dirDownloading': 'Packing {name}…',
      'transfer.batchQueued': 'Queue: {count}',
      'transfer.uploadFail': 'Upload failed',
      'transfer.downloadFail': 'Download failed',
      'transfer.doneUpload': 'Uploaded {name} ({size})',
      'transfer.doneDownload': 'Downloaded {name} ({size})',
      'queue.summaryDone': '{count} done ({size})',
      'queue.summaryStarted': 'Started {count} (browser decides)',
      'queue.summaryPartial': '{done} ok, {failed} failed',
      'queue.summaryPartialCancel': '{done} ok, {failed} failed, {cancelled} cancelled',
      'queue.summaryCancelled': '{done} ok, {cancelled} cancelled',
      'queue.summaryCancelledOnly': '{count} cancelled',
    }[key] ?? key
    let out = text
    for (const [name, value] of Object.entries(params)) out = out.split(`{${name}}`).join(String(value))
    return out
  }
  const transferNotice = (text) => {
    const node = {
      opening: text,
      lastLine: text,
      dones: [],
      models: [],
      text (line) { node.lastLine = line },
      done (input, kind) {
        // The shipped queue now hands the toast a MODEL (text + code + raw
        // detail), not a bare line, so the failure can be inspected.
        const line = typeof input === 'string' ? input : input.text
        node.models.push(input)
        node.dones.push([line, kind])
        node.lastLine = line
      },
      failed (line) { node.dones.push([line, 'err']); node.lastLine = line },
    }
    notices.push(node)
    return node
  }
  const formatBytes = (bytes) => `${Number(bytes) || 0}B`
  const runtime = new Function(
    'React', 'translate', 'formatBytes', 'transferNotice', 'queueReduce', 'transferQueueIsTerminal', 'postUploadChunk',
    `${body};
     return {
       enqueueTransferItems,
       cancelTransferQueueItem,
       pauseTransferQueueItem,
       resumeTransferQueueItem,
       retryTransferQueueItem,
       clearFinishedTransfers,
       transferQueueSnapshot,
       transferQueueDispatch,
     }`,
  )(
    { useSyncExternalStore: () => {} },
    translate,
    formatBytes,
    transferNotice,
    pure.queueReduce,
    pure.transferQueueIsTerminal,
    async (request) => { runtimeAborts.push(request); return { ok: true } },
  )
  return { ...runtime, notices, runtimeAborts }
}

/** Let the driver's promise chain run before asserting on its results. */
async function flushWorkers () {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

/** One upload item whose run() the test resolves by hand. */
function controllableItem (id, name, alias = 'host-a', bytesTotal = 10) {
  const pending = []
  const item = {
    direction: 'upload',
    alias,
    remotePath: `/${name}`,
    name,
    bytesTotal,
    run: (ctx) => new Promise((resolve, reject) => pending.push({ resolve, reject, ctx, id })),
  }
  return { item, pending }
}

console.log('\n=== transfer queue smoke ===')

// ---------------------------------------------------------------- constants
console.log('\n[concurrency]')
{
  check('one transfer may run per host', TRANSFER_QUEUE_LIMIT_PER_HOST === 1, String(TRANSFER_QUEUE_LIMIT_PER_HOST))
  check('two transfers may run across all hosts', TRANSFER_QUEUE_LIMIT_TOTAL === 2, String(TRANSFER_QUEUE_LIMIT_TOTAL))

  const oneHost = enqueue(EMPTY, [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }])
  check('a same-host batch starts exactly one item',
    idsIn(oneHost, 'running').length === 1 && idsIn(oneHost, 'queued').length === 2,
    JSON.stringify({ running: idsIn(oneHost, 'running'), queued: idsIn(oneHost, 'queued') }))
  check('...and the first item is the one that starts',
    statusOf(oneHost, 'a1') === 'running' && statusOf(oneHost, 'a2') === 'queued',
    JSON.stringify(oneHost.items.map(item => [item.id, item.status])))

  const crossHost = enqueue(EMPTY, [{ id: 'a1', alias: 'host-a' }, { id: 'b1', alias: 'host-b' }, { id: 'c1', alias: 'host-c' }])
  check('items for different hosts start up to the global ceiling',
    idsIn(crossHost, 'running').length === TRANSFER_QUEUE_LIMIT_TOTAL &&
      statusOf(crossHost, 'c1') === 'queued',
    JSON.stringify(crossHost.items.map(item => [item.id, item.status])))

  // Fairness: a blocked same-host item must not starve a later item whose host
  // is free. The scan has to look PAST the head of the queue. Two runners are
  // already busy here, so the only way this can hold is a third item starting
  // after one of them settles — with the same-host item before it still blocked.
  const twoBusy = enqueue(EMPTY, [{ id: 'a1', alias: 'host-a' }, { id: 'b1', alias: 'host-b' }])
  const skipped = enqueue(twoBusy, [{ id: 'b2', alias: 'host-b' }, { id: 'd1', alias: 'host-d' }])
  const afterFree = queueReduce(skipped, { type: 'settle', at: 2, id: 'a1', status: 'done', bytes: 1 })
  check('a free host further back starts while a busy host stays queued',
    statusOf(afterFree, 'd1') === 'running' && statusOf(afterFree, 'b2') === 'queued',
    JSON.stringify(afterFree.items.map(item => [item.id, item.status])))
  check('...without starting more than one per host',
    afterFree.items.filter(item => item.alias === 'host-b' && item.status === 'running').length === 1,
    'host-b got two runners')
}

// ---------------------------------------------------------------- progression
console.log('\n[progression]')
{
  const state = enqueue(EMPTY, [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }])
  const next = queueReduce(state, { type: 'settle', at: 2, id: 'a1', status: 'done', bytes: 10 })
  check('a settled item frees its host slot', statusOf(next, 'a2') === 'running', JSON.stringify(idsIn(next, 'running')))
  check('...and only the next same-host item starts', statusOf(next, 'a3') === 'queued', statusOf(next, 'a3'))

  const failed = queueReduce(state, { type: 'settle', at: 2, id: 'a1', status: 'failed', error: 'boom' })
  check('a FAILED item also frees its slot', statusOf(failed, 'a2') === 'running', statusOf(failed, 'a2'))
  check('...and carries the reason on the item',
    failed.items.find(item => item.id === 'a1')?.error === 'boom',
    String(failed.items.find(item => item.id === 'a1')?.error))

  const cancelled = queueReduce(state, { type: 'cancel', at: 2, id: 'a1' })
  check('cancelling a running item marks it as asked-to-stop',
    cancelled.items.find(item => item.id === 'a1')?.cancelRequested === true,
    'no flag')
  check('...but keeps its slot until the worker acknowledges',
    statusOf(cancelled, 'a2') === 'queued', statusOf(cancelled, 'a2'))
  const acked = queueReduce(cancelled, { type: 'cancelled', at: 3, id: 'a1' })
  check('...after which the next item starts',
    statusOf(acked, 'a1') === 'cancelled' && statusOf(acked, 'a2') === 'running',
    JSON.stringify(acked.items.map(item => [item.id, item.status])))

  // A cancellation that arrives too late must not rewrite a completed upload:
  // the bytes landed, and saying "cancelled" would hide a file that exists.
  const raced = queueReduce(cancelled, { type: 'settle', at: 3, id: 'a1', status: 'done', bytes: 10 })
  check('a completion racing a cancel is still recorded as done',
    statusOf(raced, 'a1') === 'done' && raced.items.find(item => item.id === 'a1')?.cancelRequested === false,
    statusOf(raced, 'a1'))
}

// ---------------------------------------------------------------- progress
console.log('\n[progress]')
{
  let state = enqueue(EMPTY, [{ id: 'a1', bytesTotal: 100 }, { id: 'a2' }])
  state = queueReduce(state, { type: 'progress', at: 2, id: 'a1', bytesDone: 50 })
  check('progress is stored for a running item',
    state.items.find(item => item.id === 'a1')?.bytesDone === 50, String(state.items[0]?.bytesDone))

  const rewound = queueReduce(state, { type: 'progress', at: 3, id: 'a1', bytesDone: 40 })
  check('a late, lower report does not rewind the counter',
    rewound.items.find(item => item.id === 'a1')?.bytesDone === 50 && rewound === state,
    String(rewound.items.find(item => item.id === 'a1')?.bytesDone))

  const over = queueReduce(state, { type: 'progress', at: 3, id: 'a1', bytesDone: 140 })
  check('a report past the known total is clamped to it',
    over.items.find(item => item.id === 'a1')?.bytesDone === 100,
    String(over.items.find(item => item.id === 'a1')?.bytesDone))

  const queuedReport = queueReduce(state, { type: 'progress', at: 3, id: 'a2', bytesDone: 9 })
  check('a queued item accepts no progress', queuedReport === state, 'state changed')

  const settled = queueReduce(state, { type: 'settle', at: 4, id: 'a1', status: 'done', bytes: 100 })
  const late = queueReduce(settled, { type: 'progress', at: 5, id: 'a1', bytesDone: 99 })
  check('a settled item accepts no progress', late === settled, 'state changed')
  const startedState = queueReduce(enqueue(EMPTY, [{ id: 's1', direction: 'download' }]), {
    type: 'settle', at: 3, id: 's1', status: 'done', bytes: 4, started: true,
  })
  check('a settlement carries the started flag onto the item',
    startedState.items[0]?.started === true, JSON.stringify(startedState.items[0]?.started))

  // A download learns its total from `content-length` AFTER the response is
  // open, so `total` has to arrive mid-flight without disturbing the bytes.
  const unknown = enqueue(EMPTY, [{ id: 'd1', direction: 'download' }])
  const withTotal = queueReduce(unknown, { type: 'total', at: 2, id: 'd1', bytesTotal: 200 })
  check('a total may arrive after the item started',
    withTotal.items.find(item => item.id === 'd1')?.bytesTotal === 200,
    String(withTotal.items.find(item => item.id === 'd1')?.bytesTotal))
  check('...and an invalid total is ignored',
    queueReduce(withTotal, { type: 'total', at: 3, id: 'd1', bytesTotal: 0 }) === withTotal,
    'zero total accepted')
}

// ---------------------------------------------------------------- speed
console.log('\n[speed]')
//
// The rate is measured inside the reducer from the same clock the action
// carries, so "1.9 MB/s" is replayable and cannot be a number the UI invented
// from two frames of a bar it is animating.
{
  let state = enqueue(EMPTY, [{ id: 's1', bytesTotal: 10000 }])
  const first = queueReduce(state, { type: 'progress', at: 100, id: 's1', bytesDone: 300 })
  const firstItem = first.items.find(item => item.id === 's1')
  check('the first sample is a baseline, not a rate',
    firstItem?.speed === null && firstItem?.measuredAt === 100,
    JSON.stringify({ speed: firstItem?.speed, at: firstItem?.measuredAt }))
  check('...and the baseline starts at the bytes that sample reported',
    firstItem?.measuredBytes === 300, String(firstItem?.measuredBytes))

  const second = queueReduce(first, { type: 'progress', at: 400, id: 's1', bytesDone: 900 })
  check('two samples 300 ms apart yield a rate over that interval',
    second.items.find(item => item.id === 's1')?.speed === 2000,
    String(second.items.find(item => item.id === 's1')?.speed))

  const third = queueReduce(second, { type: 'progress', at: 700, id: 's1', bytesDone: 1800 })
  check('the rate is smoothed rather than the last interval verbatim',
    third.items.find(item => item.id === 's1')?.speed === 2400,
    String(third.items.find(item => item.id === 's1')?.speed))

  const tooSoon = queueReduce(third, { type: 'progress', at: 750, id: 's1', bytesDone: 1900 })
  const tooSoonItem = tooSoon.items.find(item => item.id === 's1')
  check('a report closer than the sampling window keeps the last rate and baseline',
    tooSoonItem?.speed === 2400 && tooSoonItem?.measuredAt === 700,
    JSON.stringify({ speed: tooSoonItem?.speed, at: tooSoonItem?.measuredAt }))

  const stalled = queueReduce(third, { type: 'progress', at: 7000, id: 's1', bytesDone: 2000 })
  check('a gap longer than the stall threshold claims no rate',
    stalled.items.find(item => item.id === 's1')?.speed === null,
    String(stalled.items.find(item => item.id === 's1')?.speed))

  const resumed = queueReduce(stalled, { type: 'progress', at: 7300, id: 's1', bytesDone: 2300 })
  check('...and the stream re-baselines after the stall',
    resumed.items.find(item => item.id === 's1')?.speed === 1000,
    String(resumed.items.find(item => item.id === 's1')?.speed))

  const settled = queueReduce(resumed, { type: 'settle', at: 7400, id: 's1', status: 'done', bytes: 2300 })
  check('a settled row drops the rate',
    settled.items.find(item => item.id === 's1')?.speed === null,
    String(settled.items.find(item => item.id === 's1')?.speed))

  // The rate and the percentage are separate claims: an archive has no total
  // (so no percentage) but bytes still arrive at a measurable pace.
  let archive = enqueue(EMPTY, [{ id: 'd1', direction: 'download' }])
  archive = queueReduce(archive, { type: 'progress', at: 10, id: 'd1', bytesDone: 1024 })
  archive = queueReduce(archive, { type: 'progress', at: 310, id: 'd1', bytesDone: 4096 })
  check('an archive with no total still has a rate',
    archive.items.find(item => item.id === 'd1')?.speed === 10240,
    String(archive.items.find(item => item.id === 'd1')?.speed))
  check('...without inventing a percentage for it',
    queueItemPercent(archive.items.find(item => item.id === 'd1')) === null,
    'a percentage appeared for an unknown total')
}

// ---------------------------------------------------------------- cancelling queued / clearing
console.log('\n[cancel and clear]')
{
  const state = enqueue(EMPTY, [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }])
  const cancelledQueued = queueReduce(state, { type: 'cancel', at: 2, id: 'a2' })
  check('a queued item is cancelled immediately',
    statusOf(cancelledQueued, 'a2') === 'cancelled', statusOf(cancelledQueued, 'a2'))
  check('...and a duplicate cancel is a no-op',
    queueReduce(cancelledQueued, { type: 'cancel', at: 3, id: 'a2' }) === cancelledQueued,
    'state changed on a terminal item')

  const settled = queueReduce(queueReduce(state, { type: 'settle', at: 2, id: 'a1', status: 'done', bytes: 1 }),
    { type: 'settle', at: 3, id: 'a2', status: 'failed', error: 'nope' })
  const cleared = queueReduce(settled, { type: 'clear', at: 4 })
  check('clear removes settled items only',
    cleared.items.length === 1 && statusOf(cleared, 'a3') === 'running',
    JSON.stringify(cleared.items.map(item => [item.id, item.status])))
  check('clearing nothing is a no-op',
    queueReduce(cleared, { type: 'clear', at: 5 }) === cleared, 'state changed')
  check('the active count is what the badge shows',
    transferQueueActiveCount(cleared.items) === 1, String(transferQueueActiveCount(cleared.items)))
}

// ---------------------------------------------------------------- purity / no-op identity
console.log('\n[state identity]')
{
  check('an empty enqueue does not wake subscribers',
    queueReduce(EMPTY, { type: 'enqueue', at: 1, items: [] }) === EMPTY, 'state replaced')
  check('an unknown action does not wake subscribers',
    queueReduce(EMPTY, { type: 'no-such-action', at: 1 }) === EMPTY, 'state replaced')
  const state = enqueue(EMPTY, [{ id: 'a1' }])
  check('a progress report on an unknown id does not wake subscribers',
    queueReduce(state, { type: 'progress', at: 2, id: 'ghost', bytesDone: 3 }) === state, 'state replaced')
}

// ---------------------------------------------------------------- oversize pre-check
console.log('\n[oversize pre-check]')
{
  const limit = 100
  const files = [
    { name: 'small.txt', size: 1 },
    { name: 'exact.txt', size: limit },
    { name: 'big.bin', size: limit + 1 },
    { name: 'bigger.bin', size: limit * 4 },
    { name: 'unknown.bin' },
  ]
  const split = splitOversizeFiles(files, limit)
  check('the boundary size is accepted',
    split.accepted.some(file => file.name === 'exact.txt'), 'exact size rejected')
  check('files past the limit are collected, not dropped one at a time',
    split.rejected.length === 2 &&
      split.rejected[0].name === 'big.bin' && split.rejected[1].name === 'bigger.bin',
    JSON.stringify(split.rejected.map(file => file.name)))
  check('an unknown size is left to the server, not refused here',
    split.accepted.some(file => file.name === 'unknown.bin'), 'unknown size rejected')
  check('the split keeps input order', split.accepted.map(file => file.name).join(',') === 'small.txt,exact.txt,unknown.bin',
    split.accepted.map(file => file.name).join(','))
  check('the browser limit is the server\'s 1 GiB', TRANSFER_QUEUE_UPLOAD_LIMIT === 1024 * 1024 * 1024, String(TRANSFER_QUEUE_UPLOAD_LIMIT))
}

// ---------------------------------------------------------------- names
console.log('\n[name truncation]')
{
  check('a name that fits is returned unchanged', truncateTransferName('short.txt', 10) === 'short.txt', 'changed')
  check('a long ASCII name is shortened with one ellipsis',
    truncateTransferName('abcdefghijklmnop', 10) === 'abcdefghi…', truncateTransferName('abcdefghijklmnop', 10))
  check('a CJK name is measured by codepoint, not by UTF-16 unit',
    truncateTransferName('文件名文件名文件名', 4) === '文件名…', truncateTransferName('文件名文件名文件名', 4))
  check('an emoji at the cut is not split into half a surrogate pair',
    [...truncateTransferName('😀😀😀😀😀', 3)].every(char => char.codePointAt(0) > 0xFFFF || char === '…'),
    truncateTransferName('😀😀😀😀😀', 3))
  check('a one-codepoint limit is just an ellipsis', truncateTransferName('abc', 1) === '…', truncateTransferName('abc', 1))
  check('a zero limit renders nothing', truncateTransferName('abc', 0) === '', truncateTransferName('abc', 0))
}

// ---------------------------------------------------------------- percent
console.log('\n[percentage honesty]')
{
  check('an unknown total yields null, not 0%', queueItemPercent({ bytesDone: 4, bytesTotal: null }) === null, 'not null')
  check('a zero total yields null', queueItemPercent({ bytesDone: 0, bytesTotal: 0 }) === null, 'not null')
  check('a known total yields a whole percentage',
    queueItemPercent({ bytesDone: 50, bytesTotal: 100 }) === 50,
    String(queueItemPercent({ bytesDone: 50, bytesTotal: 100 })))
  check('a value past the total clamps to 100',
    queueItemPercent({ bytesDone: 300, bytesTotal: 100 }) === 100, 'not clamped')
  check('a negative counter clamps to 0',
    queueItemPercent({ bytesDone: -5, bytesTotal: 100 }) === 0, 'not clamped')
  check('the percentage floors rather than rounds up (99.9% is still not done)',
    queueItemPercent({ bytesDone: 999, bytesTotal: 1000 }) === 99,
    String(queueItemPercent({ bytesDone: 999, bytesTotal: 1000 })))
}

// -------------------------------------------------------- queue entry reading
console.log('\n[one reading for the header entry]')
{
  const progressOf = items => transferQueueProgress(items)
  const item = (overrides) => ({
    id: 't', direction: 'download', status: 'running',
    bytesDone: 0, bytesTotal: 100, ...overrides,
  })

  check('an empty or malformed queue is an idle entry',
    progressOf([]).active === 0 && progressOf(null).active === 0 &&
      progressOf([null, {}, 7]).active === 0,
    'a junk item counted as work')
  check('...and nothing moved, so the mark stays on downloads',
    progressOf([]).percent === null && progressOf([]).live === false &&
      progressOf([null]).direction === 'download')

  check('queued work is blue and waiting at zero, not idle',
    progressOf([item({ status: 'queued' })]).active === 1 &&
      progressOf([item({ status: 'queued' })]).percent === 0 &&
      progressOf([item({ status: 'queued' })]).live === false,
    'a queued transfer looked like an idle entry')
  check('settled rows stop counting as work',
    progressOf(['done', 'failed', 'cancelled'].map(status => item({ status }))).active === 0,
    'a finished row still held the entry active')

  check('the percentage is weighted by bytes, not averaged per item',
    progressOf([
      item({ bytesDone: 900, bytesTotal: 1000 }),
      item({ id: 'small', bytesDone: 0, bytesTotal: 100 }),
    ]).percent === 81,
    'a 100-byte file moved the ring as much as a 1000-byte one')
  check('one known total alone is that percentage',
    progressOf([item({ bytesDone: 250, bytesTotal: 1000 })]).percent === 25 &&
      progressOf([item({ bytesDone: 1000, bytesTotal: 1000 })]).percent === 100)

  check('one running archive without a total makes the ring sweep',
    progressOf([
      item({ bytesDone: 500, bytesTotal: 1000 }),
      item({ id: 'tar', bytesDone: 1024, bytesTotal: null }),
    ]).percent === null &&
      progressOf([
        item({ bytesDone: 500, bytesTotal: 1000 }),
        item({ id: 'tar', bytesDone: 1024, bytesTotal: null }),
      ]).live === true,
    'two half-known transfers were added up into a false distance')
  check('a total that arrives later stops the sweep',
    progressOf([item({ bytesDone: 500, bytesTotal: 1000, direction: 'upload' })]).live === false)

  check('the mark follows the busier direction',
    progressOf([
      item({ id: 'u1', direction: 'upload' }),
      item({ id: 'u2', direction: 'upload' }),
      item({ id: 'd1', direction: 'download' }),
    ]).direction === 'upload' &&
      progressOf([
        item({ id: 'u1', direction: 'upload' }),
        item({ id: 'd1', direction: 'download' }),
      ]).direction === 'download',
    'the direction mark no longer reflects the running work')
  check('queued items alone keep the download mark',
    progressOf([item({ status: 'queued', direction: 'upload' })]).direction === 'download')
}

// ---------------------------------------------------------------- chunked sender
console.log('\n[chunked sender: progress and cancellation]')
{
  // The sender references `isNetworkFailure` and the cancelled sentinel, which
  // live outside its slice. They are lifted from the same file — not retyped —
  // so the test drives the shipped definitions rather than a copy.
  const senderSource = source
  const helperOf = (name) => {
    const start = senderSource.indexOf(`function ${name} (`)
    if (start < 0) throw new Error(`client.js no longer defines ${name}()`)
    const end = senderSource.indexOf('\n    }', start)
    if (end < 0) throw new Error(`client.js: ${name}() is not closed where expected`)
    return senderSource.slice(start, end + 6)
  }
  const isNetworkFailure = new Function(`${helperOf('isNetworkFailure')}; return isNetworkFailure`)()
  const transferCancelledError = new Function(`${helperOf('transferCancelledError')}; return transferCancelledError`)()
  const transferPausedError = new Function(`${helperOf('transferPausedError')}; return transferPausedError`)()
  const bind = (fetchImpl) => {
    const start = senderSource.indexOf('const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024')
    const chunkStart = senderSource.indexOf('async function postFileInChunks', start)
    const end = senderSource.indexOf('\n    /**', chunkStart)
    const body = senderSource.slice(start, end)
    // eslint-disable-next-line no-new-func
    return new Function(
      'fetch', 'API', 'isNetworkFailure', 'transferCancelledError', 'transferPausedError',
      `${body}\nreturn { postFileInChunks }`,
    )(fetchImpl, { uploadChunk: '/api/dsh-ssh-workspace/upload-chunk' }, isNetworkFailure, transferCancelledError, transferPausedError)
  }

  {
    const file = makeFile(4 * 1024 * 1024 + 300 * 1024)
    const transport = recordingFetch()
    const progress = []
    const { postFileInChunks } = bind(transport.fetchImpl)
    const { parsed } = await postFileInChunks('qiyk', '/tmp/queue', file, { onProgress: (bytes) => progress.push(bytes) })
    check('the sender splits a file into 2 MiB chunks',
      JSON.stringify(transport.calls.map(call => call.offset)) === JSON.stringify([0, 2 * 1024 * 1024, 4 * 1024 * 1024]),
      JSON.stringify(transport.calls.map(call => call.offset)))
    check('only the last chunk is final',
      transport.calls.filter(call => call.final === true).length === 1 && transport.calls.at(-1)?.final === true,
      JSON.stringify(transport.calls.map(call => call.final)))
    check('progress is reported after every accepted chunk, ending at the real size',
      JSON.stringify(progress) === JSON.stringify([2 * 1024 * 1024, 4 * 1024 * 1024, file.size]),
      JSON.stringify(progress))
    check('the last answer carries the byte count the server reported',
      parsed?.bytes === file.size - 4 * 1024 * 1024, String(parsed?.bytes))
  }

  {
    // A cancel between chunks must become an ABORT request, not a silent stop:
    // the staging file is on the remote host and only the server can remove it.
    const file = makeFile(5 * 1024 * 1024)
    const transport = recordingFetch()
    const { postFileInChunks } = bind(transport.fetchImpl)
    let outcome
    try {
      await postFileInChunks('qiyk', '/tmp/queue', file, {
        isCancelled: () => transport.calls.filter(call => call.abort !== true).length >= 1,
      })
      outcome = 'resolved'
    } catch (error) {
      outcome = error?.cancelled === true ? 'cancelled' : `error:${error.message}`
    }
    check('a cancel between chunks rejects with the cancelled sentinel', outcome === 'cancelled', String(outcome))
    const abort = transport.calls.find(call => call.abort === true)
    check('...and sends an abort request for the same upload id and name',
      abort !== undefined && abort.offset === 0 && abort.data === '' && abort.final === false,
      JSON.stringify(abort))
    check('...without sending a final chunk that would publish the truncation',
      transport.calls.filter(call => call.final === true).length === 0,
      JSON.stringify(transport.calls.map(call => call.final)))
  }

  {
    // Cancel before the first byte: nothing is staged, but the abort is still
    // sent, because "nothing was staged" is the server's state to explain.
    const transport = recordingFetch()
    const { postFileInChunks } = bind(transport.fetchImpl)
    await postFileInChunks('qiyk', '/tmp/queue', makeFile(10), { isCancelled: () => true }).catch(() => {})
    check('a cancel before the first chunk sends only the abort',
      transport.calls.length === 1 && transport.calls[0].abort === true,
      JSON.stringify(transport.calls.map(call => [call.offset, call.abort])))
  }

  {
    const transport = recordingFetch()
    const { postFileInChunks } = bind(transport.fetchImpl)
    await postFileInChunks('qiyk', '/tmp/queue', makeFile(0), {})
    check('a zero-byte file still sends exactly one final chunk',
      transport.calls.length === 1 && transport.calls[0].final === true && transport.calls[0].data === '',
      JSON.stringify(transport.calls))
  }

  {
    // A final chunk is never retried (replaying a lost response after a
    // successful publish would report failure for a file that landed). A
    // non-final chunk retries once, because it is idempotent at its offset.
    let failed = 0
    const transport = recordingFetch((request) => {
      if (request.final === true && failed === 0) {
        failed = 1
        throw new Error('Failed to fetch')
      }
    })
    const { postFileInChunks } = bind(transport.fetchImpl)
    await postFileInChunks('qiyk', '/tmp/queue', makeFile(1024), {}).catch(() => {})
    check('a final-chunk transport death is not replayed',
      transport.calls.filter(call => call.final === true).length === 1,
      JSON.stringify(transport.calls.map(call => call.final)))
    // A retry needs the staged prefix, so a wire failure keeps it. Only a
    // cancel sends the abort request that removes it.
    check('...and keeps the staged prefix for a retry',
      transport.calls.some(call => call.abort === true) === false,
      JSON.stringify(transport.calls.map(call => call.abort)))
  }

  {
    // A retry probes first and starts where the host says the staged prefix
    // ended, instead of resending (and truncating) the whole file.
    const file = makeFile(4 * 1024 * 1024 + 300 * 1024)
    const transport = recordingFetch(null, (request) => request.probe === true
      ? { ok: true, bytes: 2 * 1024 * 1024, offset: 2 * 1024 * 1024, resume: true }
      : { ok: true, bytes: request.offset + (request.data === '' ? 0 : Buffer.from(request.data, 'base64').length) })
    const { postFileInChunks } = bind(transport.fetchImpl)
    const progress = []
    const result = await postFileInChunks('qiyk', '/tmp/queue', file, {
      uploadId: 'c'.repeat(32),
      identity: `${file.size}:123`,
      attempt: 1,
      onProgress: (bytes) => progress.push(bytes),
    })
    check('a retry asks the host for the staged prefix first',
      transport.calls[0]?.probe === true && transport.calls[0]?.uploadId === 'c'.repeat(32) &&
        transport.calls[0]?.identity === `${file.size}:123` && transport.calls[0]?.totalBytes === file.size,
      JSON.stringify(transport.calls[0]))
    check('...and resumes at the offset the host reported',
      transport.calls[1]?.offset === 2 * 1024 * 1024 && transport.calls[1]?.probe !== true,
      JSON.stringify(transport.calls.map(call => call.offset)))
    check('...reporting the resumed prefix as already done',
      progress[0] === 2 * 1024 * 1024,
      JSON.stringify(progress))

    const expected = createHash('sha256').update(makeBytes(file.size)).digest('hex')
    const final = transport.calls.at(-1)
    check('the final chunk carries the source SHA-256 for a two-sided check',
      final?.sha256 === expected && final?.verify === true,
      String(final?.sha256))
    check('...and the sender reports no restart when the prefix was accepted',
      result.restarted === null, String(result.restarted))
  }

  {
    // A changed source cannot be continued from stale bytes: the host refuses
    // the prefix and says why, and the sender restarts at zero with that
    // sentence kept for the row's own note.
    const file = makeFile(3 * 1024 * 1024)
    const reason = 'the source changed since the staged bytes were written — start the upload again'
    const transport = recordingFetch(null, (request) => request.probe === true
      ? { ok: true, bytes: 1024, offset: 0, resume: false, discarded: true, reason }
      : { ok: true, bytes: request.offset + (request.data === '' ? 0 : Buffer.from(request.data, 'base64').length) })
    const { postFileInChunks } = bind(transport.fetchImpl)
    const result = await postFileInChunks('qiyk', '/tmp/queue', file, {
      uploadId: 'd'.repeat(32),
      identity: `${file.size}:123`,
      attempt: 1,
    })
    check('a refused prefix restarts from offset zero',
      transport.calls[1]?.offset === 0 && transport.calls[1]?.probe !== true,
      JSON.stringify(transport.calls.map(call => call.offset)))
    check('...and the refusal sentence is returned, not swallowed',
      result.restarted === reason, String(result.restarted))
  }

  {
    // THE pause contract: a pause must interrupt the chunk in flight, not wait
    // for it to finish. The fetch below never resolves unless its signal
    // aborts, so a sender that only checks between chunks would hang here.
    const file = makeFile(3 * 1024 * 1024)
    let paused = false
    const calls = []
    const fetchImpl = async (url, init) => {
      const request = JSON.parse(init.body)
      calls.push(request)
      return new Promise((resolve, reject) => {
        const signal = init.signal
        if (signal !== undefined) {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }
      })
    }
    const { postFileInChunks } = bind(fetchImpl)
    const promise = postFileInChunks('qiyk', '/tmp/queue', file, {
      uploadId: 'e'.repeat(32),
      identity: `${file.size}:123`,
      isPaused: () => paused,
    })
    for (let index = 0; index < 20 && calls.length === 0; index += 1) await Promise.resolve()
    check('the first chunk is in flight before the pause is asked for',
      calls.length === 1 && calls[0]?.offset === 0, JSON.stringify(calls))
    paused = true
    const outcome = await Promise.race([
      promise.then(() => 'resolved').catch((error) => (error?.paused === true ? 'paused' : 'other')),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 2500)),
    ])
    check('a pause interrupts the in-flight chunk instead of waiting it out',
      outcome === 'paused', String(outcome))
    check('...and keeps the staged prefix (no abort request)',
      calls.every(call => call.abort !== true), JSON.stringify(calls.map(call => call.abort)))
  }
}

// ---------------------------------------------------------------- pause / resume / retry
console.log('\n[pause / resume / retry: the state machine]')
{
  const state = enqueue(EMPTY, [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], 1)
  check('pausing a running item keeps its slot until it acknowledges',
    statusOf(queueReduce(state, { type: 'pause', id: 'a1', at: 2 }), 'a1') === 'pausing' &&
      statusOf(queueReduce(state, { type: 'pause', id: 'a1', at: 2 }), 'a2') === 'queued',
    JSON.stringify(queueReduce(state, { type: 'pause', id: 'a1', at: 2 }).items.map(item => [item.id, item.status])))
  const ack = queueReduce(queueReduce(state, { type: 'pause', id: 'a1', at: 2 }), { type: 'pauseAck', id: 'a1', at: 3 })
  check('the acknowledgement parks the item and frees its host slot',
    statusOf(ack, 'a1') === 'paused' && statusOf(ack, 'a2') === 'running',
    JSON.stringify(ack.items.map(item => [item.id, item.status])))

  const queuedPaused = queueReduce(state, { type: 'pause', id: 'a2', at: 2 })
  check('a queued item pauses without waiting for a worker',
    statusOf(queuedPaused, 'a2') === 'paused' && statusOf(queuedPaused, 'a1') === 'running',
    JSON.stringify(queuedPaused.items.map(item => [item.id, item.status])))

  const resumed = queueReduce(ack, { type: 'resume', id: 'a1', at: 4 })
  check('resuming while the host is busy requeues, and the earlier arrival wins',
    statusOf(resumed, 'a1') === 'queued' && statusOf(resumed, 'a2') === 'running' &&
      resumed.items.find(item => item.id === 'a1').createdAt === 1,
    JSON.stringify(resumed.items.map(item => [item.id, item.status, item.createdAt])))
  const afterFree = queueReduce(resumed, { type: 'settle', id: 'a2', at: 5, status: 'done', bytes: 1 })
  check('the resumed item starts ahead of the later queued items',
    statusOf(afterFree, 'a1') === 'running' && statusOf(afterFree, 'a3') === 'queued',
    JSON.stringify(afterFree.items.map(item => [item.id, item.status])))

  const failed = queueReduce(enqueue(EMPTY, [{ id: 'f1' }], 1), { type: 'settle', id: 'f1', at: 2, status: 'failed', error: 'wire died' })
  const retried = queueReduce(failed, { type: 'retry', id: 'f1', at: 3 })
  const retryItem = retried.items.find(item => item.id === 'f1')
  check('retrying a failed item clears its error and counts the attempt',
    statusOf(retried, 'f1') === 'running' && retryItem.attempts === 1 &&
      retryItem.error === null && retryItem.bytesDone === 0,
    JSON.stringify([retryItem.status, retryItem.attempts, retryItem.error, retryItem.bytesDone]))
  const pausedOne = queueReduce(enqueue(EMPTY, [{ id: 'p1' }], 1), { type: 'pause', id: 'p1', at: 2 })
  check('a paused item is still work in progress, not a settled row',
    transferQueueActiveCount(pausedOne.items) === 1,
    String(transferQueueActiveCount(pausedOne.items)))
}

// ---------------------------------------------------------------- driver + notices
console.log('\n[driver: one batch, one notice, one sentence]')
{
  {
    const runtime = liftQueueRuntime()
    const first = controllableItem('a1', 'a.bin')
    const second = controllableItem('a2', 'b.bin')
    runtime.enqueueTransferItems([first.item, second.item])
    await flushWorkers()
    check('a batch opens ONE notice for both items', runtime.notices.length === 1, `${runtime.notices.length} notice(s)`)
    check('...and reports the queue count, not a file at a time',
      runtime.notices[0].opening === 'Queue: 2', runtime.notices[0].opening)
    check('only the first same-host item starts',
      first.pending.length === 1 && second.pending.length === 0,
      `${first.pending.length}/${second.pending.length} workers`)
    check('...with the same item reaching the worker context',
      first.pending[0].id === 'a1', String(first.pending[0].id))

    first.pending[0].resolve({ bytes: 10, note: 'Uploaded a.bin (10B)' })
    await flushWorkers()
    check('a finished item starts the next one', second.pending.length === 1, `${second.pending.length} worker(s)`)
    check('...while the same notice becomes the queue count',
      runtime.notices[0].lastLine === 'Queue: 1', runtime.notices[0].lastLine)

    second.pending[0].resolve({ bytes: 10, note: 'Uploaded b.bin (10B)' })
    await flushWorkers()
    const finished = runtime.notices[0].dones
    check('the batch ends as ONE merged sentence', finished.length === 1, JSON.stringify(finished))
    check('...naming the total of both files', finished[0]?.[0] === '2 done (20B)', JSON.stringify(finished[0]))
    check('...and as a success, not an alarm', finished[0]?.[1] === 'ok', String(finished[0]?.[1]))
  }

  {
    // A cancel must reach the worker's context, and the queue must keep the
    // slot until that worker acknowledges — then start the next item.
    const runtime = liftQueueRuntime()
    const first = controllableItem('c1', 'c.bin')
    const second = controllableItem('c2', 'd.bin')
    runtime.enqueueTransferItems([first.item, second.item])
    await flushWorkers()
    const storeId = runtime.transferQueueSnapshot().items[0]?.id
    runtime.cancelTransferQueueItem(storeId)
    check('a cancel reaches the running worker context', first.pending[0].ctx.isCancelled() === true, 'not visible to the worker')
    check('...and marks the store item as asked-to-stop',
      runtime.transferQueueSnapshot().items.find(item => item.id === storeId)?.cancelRequested === true,
      'flag missing')
    check('...without freeing the slot early', second.pending.length === 0, `${second.pending.length} worker(s)`)

    const cancelled = new Error('transfer cancelled')
    cancelled.cancelled = true
    first.pending[0].reject(cancelled)
    await flushWorkers()
    check('the worker cancellation is recorded as cancelled',
      runtime.transferQueueSnapshot().items.find(item => item.id === storeId)?.status === 'cancelled',
      runtime.transferQueueSnapshot().items.find(item => item.id === storeId)?.status)
    check('...which starts the next item', second.pending.length === 1, `${second.pending.length} worker(s)`)
    second.pending[0].resolve({ bytes: 10, note: 'Uploaded d.bin (10B)' })
    await flushWorkers()
    check('a cancelled batch still ends with a readable result', runtime.notices[0].dones.length === 1,
      JSON.stringify(runtime.notices[0].dones))
  }

  {
    // A mixed batch must be one sentence that names the failure — and it takes
    // the alarm face, because the user must not read it as all-clear.
    const runtime = liftQueueRuntime()
    const first = controllableItem('m1', 'm1.bin')
    const second = controllableItem('m2', 'm2.bin')
    runtime.enqueueTransferItems([first.item, second.item])
    await flushWorkers()
    first.pending[0].resolve({ bytes: 10, note: 'Uploaded m1.bin (10B)' })
    await flushWorkers()
    second.pending[0].reject(new Error('remote said no'))
    await flushWorkers()
    const done = runtime.notices[0].dones
    check('a failure in a batch is merged into the same sentence',
      done.length === 1 && done[0][0] === '1 ok, 1 failed', JSON.stringify(done))
    check('...and takes the alarm face', done[0]?.[1] === 'err', String(done[0]?.[1]))
  }

  {
    // Progress has to reach the store (and thus both views), while a small
    // report is coalesced so the overlay is not re-rendered per chunk.
    const runtime = liftQueueRuntime()
    const big = controllableItem('p1', 'big.bin', 'host-a', 1_000_000)
    runtime.enqueueTransferItems([big.item])
    await flushWorkers()
    big.pending[0].ctx.progress(700_000)
    await flushWorkers()
    check('a large progress report reaches the store',
      runtime.transferQueueSnapshot().items[0]?.bytesDone === 700_000,
      String(runtime.transferQueueSnapshot().items[0]?.bytesDone))
    check('...so both views read the same number',
      queueItemPercent(runtime.transferQueueSnapshot().items[0]) === 70,
      String(queueItemPercent(runtime.transferQueueSnapshot().items[0])))
    big.pending[0].resolve({ bytes: 1_000_000, note: 'Uploaded big.bin (1000000B)' })
    await flushWorkers()
    check('the final count comes from the outcome, not the last throttled report',
      runtime.transferQueueSnapshot().items[0]?.bytesDone === 1_000_000,
      String(runtime.transferQueueSnapshot().items[0]?.bytesDone))
  }

  {
    // The anchor path hands bytes to the browser, which owns the save. A batch
    // that used it must not summarise those bytes as "transferred".
    const runtime = liftQueueRuntime()
    const first = controllableItem('s1', 's1.zip', 'host-a', 10)
    const second = controllableItem('s2', 's2.zip', 'host-a', 10)
    runtime.enqueueTransferItems([first.item, second.item])
    await flushWorkers()
    first.pending[0].resolve({ bytes: 10, note: 'Download started', started: true })
    await flushWorkers()
    second.pending[0].resolve({ bytes: 10, note: 'Download started', started: true })
    await flushWorkers()
    check('an anchor-path batch ends as "started", not "transferred"',
      runtime.notices[0].dones[0]?.[0] === 'Started 2 (browser decides)',
      JSON.stringify(runtime.notices[0].dones))
  }
}

// ------------------------------------------------------------- display order
console.log('\n[display order]')
{
  const store = [
    { id: 'done-1', status: 'done' },
    { id: 'live-1', status: 'running' },
    { id: 'failed-1', status: 'failed' },
    { id: 'queued-1', status: 'queued' },
    { id: 'cancelled-1', status: 'cancelled' },
    { id: 'done-2', status: 'done' },
  ]
  const ordered = orderedTransferQueueItems(store)
  check('live rows paint above settled rows',
    ordered.slice(0, 2).map(item => item.id).join() === 'live-1,queued-1',
    ordered.map(item => item.id).join())
  check('settled rows paint newest first',
    ordered.slice(2).map(item => item.id).join() === 'done-2,cancelled-1,failed-1,done-1',
    ordered.map(item => item.id).join())
  check('display ordering never mutates the store',
    store[0].id === 'done-1' && store.length === 6)
  check('the popover paints the ordered list, not arrival order',
    source.includes(': orderedTransferQueueItems(queue.items).map(item => jsx(TransferQueueRow'))
  check('malformed rows are skipped rather than crashing paint',
    orderedTransferQueueItems([null, 'x', { id: 'ok', status: 'done' }]).map(item => item.id).join() === 'ok')
}

// ---------------------------------------------------------------- summary count
console.log('\n[active count]')
{
  const state = enqueue(EMPTY, [{ id: 'a1' }, { id: 'a2' }])
  check('queued and running both count as active',
    transferQueueActiveCount(state.items) === 2, String(transferQueueActiveCount(state.items)))
  const settled = queueReduce(state, { type: 'settle', at: 2, id: 'a1', status: 'done', bytes: 1 })
  check('a settled item stops counting when it finishes', transferQueueActiveCount(settled.items) === 1,
    String(transferQueueActiveCount(settled.items)))
}


// ---------------------------------------------------------------- pause / retry: the driver
console.log('\n[pause / resume / retry: the driver]')
{
  const pausedError = () => {
    const error = new Error('transfer paused')
    error.paused = true
    return error
  }

  {
    const runtime = liftQueueRuntime()
    // Same host, so the per-host limit makes the second item wait. A pause
    // must release that slot only after the worker acknowledges.
    const a1 = controllableItem('a1', 'a.bin', 'host-a', 100)
    a1.item.uploadId = 'a'.repeat(32)
    a1.item.dir = '/tmp/queue'
    const a2 = controllableItem('a2', 'b.bin', 'host-a', 200)
    const [id1, id2] = runtime.enqueueTransferItems([a1.item, a2.item])
    await flushWorkers()
    check('the first item runs while the same-host second item waits',
      statusOf(runtime.transferQueueSnapshot(), id1) === 'running' &&
        statusOf(runtime.transferQueueSnapshot(), id2) === 'queued',
      JSON.stringify(runtime.transferQueueSnapshot().items.map(item => [item.id, item.status])))

    runtime.pauseTransferQueueItem(id1)
    check('pause marks the running row as pausing, still holding its slot',
      statusOf(runtime.transferQueueSnapshot(), id1) === 'pausing' &&
        statusOf(runtime.transferQueueSnapshot(), id2) === 'queued' &&
        a1.pending[0].ctx.isPaused() === true,
      JSON.stringify(runtime.transferQueueSnapshot().items.map(item => [item.id, item.status])))

    a1.pending[0].reject(pausedError())
    await flushWorkers()
    check('the worker acknowledgement parks the row and frees the slot for the waiter',
      statusOf(runtime.transferQueueSnapshot(), id1) === 'paused' &&
        statusOf(runtime.transferQueueSnapshot(), id2) === 'running',
      JSON.stringify(runtime.transferQueueSnapshot().items.map(item => [item.id, item.status])))

    runtime.resumeTransferQueueItem(id1)
    await flushWorkers()
    check('resume requeues the paused row behind the running waiter',
      statusOf(runtime.transferQueueSnapshot(), id1) === 'queued' &&
        runtime.transferQueueSnapshot().items.find(item => item.id === id1)?.resumed === true,
      String(statusOf(runtime.transferQueueSnapshot(), id1)))

    await a2.pending[0].resolve({ bytes: 200 })
    await flushWorkers()
    check('the resumed row starts once its slot frees, with the resume flag set',
      statusOf(runtime.transferQueueSnapshot(), id1) === 'running' &&
        a1.pending.length === 2 &&
        a1.pending[1].ctx.resume === true &&
        a1.pending[1].ctx.attempts === 0,
      JSON.stringify({ status: statusOf(runtime.transferQueueSnapshot(), id1), runs: a1.pending.length, ctx: a1.pending[1] && [a1.pending[1].ctx.resume, a1.pending[1].ctx.attempts] }))

    runtime.pauseTransferQueueItem(id1)
    a1.pending[1].reject(pausedError())
    await flushWorkers()
    runtime.cancelTransferQueueItem(id1)
    await flushWorkers()
    check('cancelling a paused upload sends the abort that removes its staged part',
      runtime.runtimeAborts.length === 1 && runtime.runtimeAborts[0].abort === true &&
        runtime.runtimeAborts[0].uploadId === 'a'.repeat(32),
      JSON.stringify(runtime.runtimeAborts))
    check('...and the row settles as cancelled',
      statusOf(runtime.transferQueueSnapshot(), id1) === 'cancelled',
      String(statusOf(runtime.transferQueueSnapshot(), id1)))
  }

  {
    const runtime = liftQueueRuntime()
    const f1 = controllableItem('f1', 'f.bin', 'host-a', 100)
    const [id] = runtime.enqueueTransferItems([f1.item])
    await flushWorkers()
    f1.pending[0].reject(new Error('the wire died'))
    await flushWorkers()
    check('a failed row keeps its reason for the retry button',
      statusOf(runtime.transferQueueSnapshot(), id) === 'failed',
      String(statusOf(runtime.transferQueueSnapshot(), id)))
    runtime.retryTransferQueueItem(id)
    await flushWorkers()
    const state = runtime.transferQueueSnapshot()
    check('retry starts a new worker with the next attempt number',
      statusOf(state, id) === 'running' &&
        f1.pending.length === 2 &&
        f1.pending[1].ctx.attempts === 1,
      JSON.stringify({ status: statusOf(state, id), runs: f1.pending.length, attempts: f1.pending[1]?.ctx.attempts }))
  }
}

console.log('\n[pause wiring in the shipped bundle]')
{
  const pausedRethrows = (source.match(/if \(err\?\.paused === true\) throw err/gu) ?? []).length
  check('both job wrappers let the paused sentinel through', pausedRethrows === 2, String(pausedRethrows))
  check('page-side download streams stop on pause, not only cancel',
    /streamIntoHandle\([^\n]*ctx\.isPaused\(\)/u.test(source) &&
      /readResponseBlob\([^\n]*ctx\.isPaused\(\)/u.test(source),
    'a handle/anchor download would ignore the pause button')
}

if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
process.exit(failures.length === 0 ? 0 : 1)
