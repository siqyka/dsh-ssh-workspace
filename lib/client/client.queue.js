/**
 * The transfer queue's scheduler, as a pure state machine.
 *
 * This is the part of the queue that has no clock, no DOM, no `fetch` and no
 * translation, which is exactly why it is a module: `tests/transfer-queue-smoke`
 * used to slice it out of the bundle by two marker comments and run it, because
 * a retyped copy would prove nothing about the code users get. Moving it here
 * keeps that property and drops the slicing.
 *
 * What it is NOT: the store. `transferQueueState` (`let`, reassigned on every
 * change) and the workers that actually move bytes stay in `client.js`. They are
 * driven BY these rules, and the reducers below never read the store — every
 * one of them takes the state it should transition as an argument.
 *
 * The two ceilings are here rather than in the UI on purpose: a queue whose
 * width is decided by a widget has two widths the moment a second widget
 * appears.
 */

window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.queue.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ---- queue state machine (pure: no clock, no DOM, no translation)

    /** How many transfers may run at once, across every host. */
    const TRANSFER_QUEUE_LIMIT_TOTAL = 2

    /** How many transfers may run at once against ONE host. */
    const TRANSFER_QUEUE_LIMIT_PER_HOST = 1

    // Mirrors `DEFAULT_MAX_BYTES` in lib/transfer.js. This bundle cannot import
    // a Node module, so the number is restated — and `client-shape-smoke`
    // asserts the two agree, so a drift turns red here instead of surfacing as
    // a 413 after the last chunk of a file the picker should have refused.
    const TRANSFER_QUEUE_UPLOAD_LIMIT = 1024 * 1024 * 1024

    /**
     * The shortest interval two byte samples may span to become a rate.
     *
     * The progress reporter already throttles to one percent or 200 ms, so a
     * real pair is usually farther apart than this floor; a shorter pair (a
     * fast link) is folded into the next window instead of dividing by a
     * handful of milliseconds and printing a spike.
     */
    const TRANSFER_QUEUE_SPEED_MIN_WINDOW = 250

    /**
     * A gap longer than this is a stall, not a slow transfer.
     *
     * Averaging across the pause would report the pause as the rate, so the
     * measurement restarts and the row stops claiming a speed until bytes move
     * again. A number that decays to "0 B/s" on its own would be just as
     * misleading as the stale one it replaced.
     */
    const TRANSFER_QUEUE_SPEED_RESET_GAP = 5000

    /** How much of the newest sample the smoothed rate adopts (0..1). */
    const TRANSFER_QUEUE_SPEED_SMOOTHING = 0.4

    /** The statuses from which an item never moves again. */
    const TRANSFER_QUEUE_TERMINAL = ['done', 'failed', 'cancelled']

    /** Whether an item has settled. */
    function transferQueueIsTerminal (status) {
      return TRANSFER_QUEUE_TERMINAL.includes(status)
    }

    /**
     * Shorten a filename for a row, by CODEPOINT rather than by UTF-16 unit.
     *
     * `String.prototype.slice` would cut a surrogate pair in half and render a
     * replacement glyph; a name is user data, and displaying a different name
     * (or a broken one) in the very row that reports which file moved is a
     * defect, not cosmetics.
     *
     * @returns {string} the name, shortened with an ellipsis when needed.
     */
    function truncateTransferName (name, limit = 40) {
      const text = typeof name === 'string' ? name : String(name ?? '')
      const max = Math.max(0, Math.floor(Number(limit) || 0))
      if (max <= 0) return ''
      const points = Array.from(text)
      if (points.length <= max) return text
      if (max === 1) return '…'
      return `${points.slice(0, max - 1).join('')}…`
    }

    /**
     * Split picked files into what may be sent and what exceeds the limit.
     *
     * The point is to answer ONCE, before a byte is staged: a batch that lets
     * one oversized member fail after the other nine succeeded reports the
     * wrong total and spends the queue's turn on a doomed request. The caller
     * shows the list, so nothing is silently dropped.
     *
     */
    function splitOversizeFiles (files, limit = TRANSFER_QUEUE_UPLOAD_LIMIT) {
      const accepted = []
      const rejected = []
      for (const file of Array.isArray(files) ? files : []) {
        if (file === null || file === undefined) continue
        const size = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : null
        // An unknown size is not a reason to refuse: a File always has one, and
        // the route still enforces the same ceiling on the bytes it receives.
        if (size !== null && size > limit) rejected.push(file)
        else accepted.push(file)
      }
      return { accepted, rejected }
    }

    /**
     * Percentage 0..100 for a known total, or null when the total is unknown.
     *
     * Null is the honest answer for an archive: it is not 0%, and drawing an
     * empty bar would assert "nothing has arrived" for a stream that is already
     * moving.
     */
    function queueItemPercent (item) {
      if (item === null || typeof item !== 'object') return null
      const total = typeof item.bytesTotal === 'number' && Number.isFinite(item.bytesTotal) ? item.bytesTotal : null
      if (total === null || total <= 0) return null
      const done = typeof item.bytesDone === 'number' && Number.isFinite(item.bytesDone) ? item.bytesDone : 0
      return Math.max(0, Math.min(100, Math.floor((done / total) * 100)))
    }

    /**
     * The queue item currently transferring one download target.
     *
     * Identity is `alias` + `remotePath`, both carried by every download job:
     * that lets a listing row show the progress of ITS transfer while the queue
     * holds several, from different hosts. Matching by display name would
     * confuse two hosts that both have `src/`, which is the ordinary case here.
     *
     * The LAST matching item wins: a retried transfer is appended after the
     * stale one, and the newest intent is the one a row should reflect.
     */
    function downloadQueueItemFor (queue, alias, remotePath) {
      if (queue === null || typeof queue !== 'object' || !Array.isArray(queue.items)) return null
      for (let index = queue.items.length - 1; index >= 0; index -= 1) {
        const item = queue.items[index]
        if (item === null || typeof item !== 'object') continue
        if (item.direction !== 'download' || item.alias !== alias || item.remotePath !== remotePath) continue
        if (item.status !== 'running' && item.status !== 'queued') continue
        return item
      }
      return null
    }

    /**
     * Fold one byte sample into an item's rate estimate.
     *
     * Pure and clockless — the clock arrives in `at` — so the same action
     * sequence replays identically in a test, and the number a row prints is
     * the number the machine stored rather than a value a component guessed
     * from two frames of a bar it is animating.
     *
     * The first sample is a BASELINE, not an interval: it records where the
     * stream is, and the rate starts with the next window. That is also why a
     * fresh row shows bytes but no speed for a moment — claiming "0 B/s" on
     * the first frame reads as stalled.
     *
     * @param {number} done - the byte count this report establishes.
     * @param {number} at - the action clock, in milliseconds.
     */
    function transferQueueNextSpeed (item, done, at) {
      const measuredAt = typeof item.measuredAt === 'number' && Number.isFinite(item.measuredAt)
        ? item.measuredAt
        : null
      const measuredBytes = typeof item.measuredBytes === 'number' && Number.isFinite(item.measuredBytes)
        ? item.measuredBytes
        : 0
      if (measuredAt === null) {
        return { speed: null, measuredAt: at, measuredBytes: done }
      }
      const elapsed = at - measuredAt
      if (elapsed < TRANSFER_QUEUE_SPEED_MIN_WINDOW) {
        // Too close to divide the bytes by: keep the last rate AND the
        // baseline, so the eventual window covers everything since it began.
        return {
          speed: typeof item.speed === 'number' && Number.isFinite(item.speed) ? item.speed : null,
          measuredAt,
          measuredBytes,
        }
      }
      if (elapsed > TRANSFER_QUEUE_SPEED_RESET_GAP) {
        return { speed: null, measuredAt: at, measuredBytes: done }
      }
      const instant = ((done - measuredBytes) * 1000) / elapsed
      const previous = typeof item.speed === 'number' && Number.isFinite(item.speed) ? item.speed : null
      const smoothed = previous === null
        ? instant
        : previous * (1 - TRANSFER_QUEUE_SPEED_SMOOTHING) + instant * TRANSFER_QUEUE_SPEED_SMOOTHING
      return { speed: Math.max(0, Math.round(smoothed)), measuredAt: at, measuredBytes: done }
    }

    /** How many items are still moving (queued or running). */
    function transferQueueActiveCount (items) {
      return (Array.isArray(items) ? items : []).filter(item => !transferQueueIsTerminal(item?.status)).length
    }

    /**
     * One reading of the queue for the header entry.
     *
     * `percent` is weighted by BYTES, not averaged across items: a 10 MB file
     * and a 1 KB file must not move the ring by the same amount. Null means at
     * least one running transfer has no total (an archive), so the ring sweeps
     * rather than states a distance the browser cannot know. Nothing running
     * but something queued is 0 — blue and waiting is a state; idle is not.
     *
     * `direction` picks the mark for the running work; with nothing moving it
     * stays on the download mark, the verb this entry overwhelmingly reports.
     *
     */
    function transferQueueProgress (items) {
      const list = Array.isArray(items) ? items : []
      const running = []
      let active = 0
      let downloads = 0
      let uploads = 0
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue
        // Every queue entry carries a status; an object without one is not a
        // transfer (a malformed snapshot must not hold the entry blue).
        if (typeof item.status !== 'string') continue
        if (!transferQueueIsTerminal(item.status)) active += 1
        if (item.status !== 'running') continue
        running.push(item)
        if (item.direction === 'upload') uploads += 1
        else downloads += 1
      }
      let percent = null
      let live = false
      if (running.length > 0) {
        let done = 0
        let total = 0
        let known = true
        for (const item of running) {
          if (queueItemPercent(item) === null) {
            known = false
            break
          }
          done += typeof item.bytesDone === 'number' && Number.isFinite(item.bytesDone) ? item.bytesDone : 0
          total += item.bytesTotal
        }
        if (known && total > 0) {
          percent = Math.max(0, Math.min(100, Math.floor((done / total) * 100)))
        } else {
          live = true
        }
      } else if (active > 0) {
        percent = 0
      }
      return { active, percent, live, direction: uploads > downloads ? 'upload' : 'download' }
    }

    /**
     * The order the queue list paints: live entries first, settled ones below.
     *
     * The store keeps arrival order because that is the execution order — a
     * queued item must start before the one behind it. But arrival order is a
     * BAD reading order: rendered as-is, a new download is appended to the
     * bottom of a list that never auto-clears, and a panel with a few finished
     * transfers hides it below the fold. The user then reports "the download
     * never appeared in the queue" while the row exists all along.
     *
     * So the DISPLAY is reordered, not the store: everything still moving stays
     * in arrival order at the top (the first row is the next thing to happen),
     * and everything settled is newest-first below, so the transfer that just
     * finished is the first historical row rather than the last one off-screen.
     *
     */
    function orderedTransferQueueItems (items) {
      if (!Array.isArray(items)) return []
      const live = []
      const settled = []
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue
        if (transferQueueIsTerminal(item.status)) settled.push(item)
        else live.push(item)
      }
      return live.concat(settled.reverse())
    }

    /**
     * Mark queued items running while capacity allows.
     *
     * The scan restarts at the FRONT every time, so a same-host item blocked by
     * a busy host cannot be overtaken by a later item for that same host (the
     * per-host rule is checked, not assumed), while an item for a FREE host
     * further back still starts — which is what the cross-host ceiling is for.
     * A cancelled-but-still-running item keeps its slot until its worker
     * acknowledges the stop; releasing it early would let the next transfer
     * collide with one still writing. The same rule covers a `pausing` item:
     * the slot is released only when the worker reports that it has stopped,
     * never when the user simply asked it to.
     */
    function queueDrain (items, at) {
      const perHost = new Map()
      let running = 0
      for (const item of items) {
        if (item.status !== 'running' && item.status !== 'pausing') continue
        running += 1
        perHost.set(item.alias, (perHost.get(item.alias) ?? 0) + 1)
      }
      let touched = false
      const next = items.slice()
      for (let index = 0; index < next.length && running < TRANSFER_QUEUE_LIMIT_TOTAL; index += 1) {
        const item = next[index]
        if (item.status !== 'queued' || item.cancelRequested === true) continue
        if ((perHost.get(item.alias) ?? 0) >= TRANSFER_QUEUE_LIMIT_PER_HOST) continue
        next[index] = {
          ...item,
          status: 'running',
          startedAt: at,
          // A queued wait is not transfer time: the rate begins at the first
          // byte, not at the moment this item got its host slot.
          speed: null,
          measuredAt: null,
          measuredBytes: 0,
        }
        running += 1
        perHost.set(item.alias, (perHost.get(item.alias) ?? 0) + 1)
        touched = true
      }
      return touched ? next : items
    }

    /**
     * One transition. `action.at` is the clock, supplied by the driver, so the
     * same action sequence replays identically in a test.
     *
     * Returns the SAME state object when an action changes nothing, so a
     * subscriber is not woken by a late progress report or a duplicate cancel.
     *
     */
    function queueReduce (state, action) {
      const current = state !== null && typeof state === 'object' && Array.isArray(state.items)
        ? state
        : { items: [] }
      const at = typeof action?.at === 'number' ? action.at : 0
      const indexOf = (id) => current.items.findIndex(item => item.id === id)
      switch (action?.type) {
        case 'enqueue': {
          const incoming = Array.isArray(action.items) ? action.items : []
          if (incoming.length === 0) return state
          const added = incoming.map(item => ({
            ...item,
            status: 'queued',
            bytesDone: 0,
            bytesTotal: typeof item.bytesTotal === 'number' && Number.isFinite(item.bytesTotal)
              ? Math.max(0, item.bytesTotal)
              : null,
            cancelRequested: false,
            pauseRequested: false,
            // Set by resume: the staged prefix must be probed even though this
            // is still the item's first attempt.
            resumed: false,
            // Retry count, not a boolean: the first attempt and a resumed
            // attempt ask the route for different work (probe / verify).
            attempts: Number.isInteger(item.attempts) && item.attempts > 0 ? item.attempts : 0,
            error: null,
            note: null,
            speed: null,
            measuredAt: null,
            measuredBytes: 0,
            createdAt: at,
            startedAt: null,
            finishedAt: null,
          }))
          return { ...current, items: queueDrain(current.items.concat(added), at) }
        }
        case 'total': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (transferQueueIsTerminal(item.status)) return state
          const total = Number(action.bytesTotal)
          if (!Number.isFinite(total) || total <= 0) return state
          if (item.bytesTotal === total) return state
          const items = current.items.slice()
          items[index] = { ...item, bytesTotal: total, bytesDone: Math.min(item.bytesDone, total) }
          return { ...current, items }
        }
        case 'progress': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (item.status !== 'running') return state
          const bytes = Number(action.bytesDone)
          if (!Number.isFinite(bytes) || bytes <= item.bytesDone) return state
          const capped = item.bytesTotal === null ? bytes : Math.min(bytes, item.bytesTotal)
          if (capped <= item.bytesDone) return state
          const items = current.items.slice()
          const sample = transferQueueNextSpeed(item, capped, at)
          items[index] = { ...item, bytesDone: capped, ...sample }
          return { ...current, items }
        }
        case 'settle': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          // A worker that already finished when the user pressed pause is
          // allowed to report its outcome: the bytes are on disk, so calling
          // that paused would be a lie the next resume could not repair.
          if (item.status !== 'running' && item.status !== 'pausing') return state
          const done = action.status === 'done'
          // A cancellation that arrived before the worker noticed does not
          // rewrite a truth: if the bytes did land, the item is done. The other
          // outcomes honour the request.
          const status = done ? 'done' : item.cancelRequested === true ? 'cancelled' : 'failed'
          const bytes = Number(action.bytes)
          const items = current.items.slice()
          items[index] = {
            ...item,
            status,
            cancelRequested: false,
            pauseRequested: false,
            // A settled row reports bytes, not a rate: a final "0 B/s" would
            // read as a stall right where the transfer actually ended.
            speed: null,
            bytesDone: Number.isFinite(bytes) && bytes > item.bytesDone
              ? (item.bytesTotal === null ? bytes : Math.min(bytes, item.bytesTotal))
              : item.bytesDone,
            error: status === 'failed' ? String(action.error ?? '') : null,
            note: done && typeof action.note === 'string' ? action.note : null,
            // Only the anchor path sets this: the browser owns the save, so a
            // batch must not summarise those bytes as "transferred".
            started: done && action.started === true,
            finishedAt: at,
          }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'cancel': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (transferQueueIsTerminal(item.status)) return state
          const items = current.items.slice()
          if (item.status === 'queued' || item.status === 'paused') {
            items[index] = { ...item, status: 'cancelled', finishedAt: at, cancelRequested: false, pauseRequested: false }
            return { ...current, items: queueDrain(items, at) }
          }
          if (item.cancelRequested === true) return state
          items[index] = { ...item, cancelRequested: true }
          return { ...current, items }
        }
        case 'cancelled': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (transferQueueIsTerminal(item.status)) return state
          const items = current.items.slice()
          items[index] = { ...item, status: 'cancelled', cancelRequested: false, speed: null, finishedAt: at }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'pause': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (transferQueueIsTerminal(item.status)) return state
          const items = current.items.slice()
          // A queued item never grabbed a slot, so it is paused at once. A
          // running one keeps its slot until the worker acknowledges: the
          // write in flight is still writing, and starting the next transfer
          // beside it is exactly what the per-host limit exists to stop.
          if (item.status === 'queued') {
            items[index] = { ...item, status: 'paused', finishedAt: null }
            return { ...current, items }
          }
          if (item.status === 'running') {
            items[index] = { ...item, status: 'pausing', pauseRequested: true, speed: null }
            return { ...current, items }
          }
          return state
        }
        case 'pauseAck': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (item.status !== 'pausing') return state
          const items = current.items.slice()
          items[index] = { ...item, status: 'paused', pauseRequested: false, speed: null, finishedAt: null }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'resume': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (item.status !== 'paused') return state
          const items = current.items.slice()
          // createdAt is deliberately untouched: the drain scans from the
          // front, so an item paused early resumes ahead of one queued later.
          items[index] = {
            ...item,
            status: 'queued',
            cancelRequested: false,
            pauseRequested: false,
            resumed: true,
            speed: null,
            measuredAt: null,
            measuredBytes: 0,
            finishedAt: null,
          }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'retry': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (item.status !== 'failed') return state
          const items = current.items.slice()
          items[index] = {
            ...item,
            status: 'queued',
            // The attempt number is what tells the transport to probe the
            // staged prefix and verify the source at the end.
            attempts: (Number.isInteger(item.attempts) ? item.attempts : 0) + 1,
            bytesDone: 0,
            error: null,
            note: null,
            started: false,
            speed: null,
            measuredAt: null,
            measuredBytes: 0,
            cancelRequested: false,
            pauseRequested: false,
            resumed: false,
            finishedAt: null,
          }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'clear': {
          const items = current.items.filter(item => !transferQueueIsTerminal(item.status))
          if (items.length === current.items.length) return state
          return { ...current, items }
        }
        default:
          return state
      }
    }

    // ---------------------------------------------------------------------------
    // The pure surface. Everything here is a pure function of its arguments, so
    // the main bundle can call it without any boot ordering to respect.
    Object.assign(exports, {
      TRANSFER_QUEUE_LIMIT_TOTAL,
      TRANSFER_QUEUE_LIMIT_PER_HOST,
      TRANSFER_QUEUE_UPLOAD_LIMIT,
      downloadQueueItemFor,
      queueDrain,
      queueItemPercent,
      queueReduce,
      orderedTransferQueueItems,
      splitOversizeFiles,
      transferQueueActiveCount,
      transferQueueIsTerminal,
      transferQueueNextSpeed,
      transferQueueProgress,
      truncateTransferName,
    })
    return module.exports
  },
})
