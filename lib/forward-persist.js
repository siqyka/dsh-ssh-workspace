/**
 * Saved port forwards: the durable half of the tunnel surface.
 *
 * `ForwardManager` (forward.js) owns listeners and nothing else — its table is
 * memory-only, because a tunnel that outlived its SSH connection would be a
 * dead pipe. That is the right lifetime for the tunnel, but it is the wrong
 * lifetime for the *intent*: a user who maps 5173→5173 for a dev server wants
 * that mapping back after a restart.
 *
 * This module keeps the two apart:
 *
 *   store (dsh-ssh.json `forwards`)   the intent: which mapping, which ports,
 *                                     and whether the user wants it on
 *   ForwardManager                    the fact: is a listener bound right now
 *
 * The panel renders the join of the two, so a button never lies: "close" is
 * shown only when a listener exists, "open" only when it does not.
 *
 * @module @shiqyka/dsh-ssh-workspace/forward-persist
 */

import { randomBytes } from 'node:crypto'
import { joinForwards, probeLocalPort } from './forward.js'

/** Why a saved forward's listener went away, for the panel to explain. */
const REASON_CONNECTION = 'SSH connection closed'
const REASON_DISPOSED = 'plugin unloaded'

/**
 * Mint an id for a new saved mapping.
 *
 * Random rather than sequential on purpose: the store is shared by every DSH
 * instance, and a per-process counter would collide across them.
 *
 * @returns {string} a fresh id.
 */
function newForwardId () {
  return `fwd-${randomBytes(4).toString('hex')}`
}

/**
 * Validate a port a user typed for a saved mapping.
 *
 * A saved mapping must name a concrete local port. 0 means "give me any free
 * one", which is meaningless to persist — the stored URL would point at the
 * wrong port on the next start — so it is rejected here rather than silently
 * resolved into something the user did not ask for.
 *
 * @param {unknown} value - the candidate.
 * @param {string} label - field name for the error.
 * @returns {number} the port.
 * @throws {Error} when out of range or not an integer.
 */
function requireSavedPort (value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return value
}

/**
 * The saved-forward controller.
 *
 * Every method that changes the store re-reads it under the store's own
 * cross-process lock (store.js), so two DSH instances editing the same forward
 * list cannot clobber each other.
 */
export class SavedForwardManager {
  /**
   * @param {object} options - controller options.
   * @param {import('./forward.js').ForwardManager} options.forwards - the live manager.
   * @param {import('./store.js').HostConfigStore} options.store - the editable store.
   * @param {object} [options.logger] - Cordis logger, when available.
   */
  constructor (options) {
    this.forwards = options.forwards
    this.store = options.store
    this.logger = options.logger
    /**
     * Why each saved forward's listener last disappeared. Cleared on a
     * successful open; surfaced in the panel so "connection lost" is not
     * indistinguishable from "you turned it off".
     *
     * @type {Map<string, string>}
     */
    this.failures = new Map()
    this.autoStaring = false
  }

  /** Every forward row: saved mappings joined with live listeners. */
  list () {
    let saved
    try {
      saved = this.store.forwards()
    } catch (error) {
      this.logger?.warn?.(`ssh-workspace: could not read saved forwards: ${error instanceof Error ? error.message : String(error)}`)
      saved = { settings: { autoStart: false }, items: [] }
    }
    const rows = joinForwards(saved, this.forwards.list())
    return rows.map((row) => {
      const failure = this.failures.get(row.id)
      return failure === undefined ? row : { ...row, error: failure }
    })
  }

  /** The saved preferences. @returns {{autoStart: boolean}} the settings. */
  settings () {
    try {
      return this.store.forwards().settings
    } catch {
      return { autoStart: false }
    }
  }

  /**
   * Store the auto-start preference.
   *
   * @param {boolean} autoStart - whether enabled mappings open on startup.
   * @returns {{autoStart: boolean}} the stored settings.
   */
  setAutoStart (autoStart) {
    return { autoStart: this.store.setForwardAutoStart(autoStart === true) }
  }

  /**
   * Save a new mapping, optionally opening it immediately.
   *
   * The local port is checked before anything is written: a mapping that cannot
   * bind should not be left in the store looking healthy.
   *
   * @param {object} input - the requested mapping.
   * @param {string} input.alias - host alias.
   * @param {number} input.remotePort - remote port.
   * @param {number} input.localPort - local port.
   * @param {string} [input.remoteHost] - host the SSH server dials.
   * @param {string} [input.localHost] - local interface to bind.
   * @param {boolean} [input.open] - open the tunnel now (default true).
   * @returns {Promise<object>} the stored entry plus its runtime state.
   * @throws {Error} when the mapping is invalid or the local port is busy.
   */
  async create (input) {
    const alias = typeof input?.alias === 'string' ? input.alias.trim() : ''
    if (alias === '') throw new Error('alias is required')
    const remotePort = requireSavedPort(input?.remotePort, 'remotePort')
    const localPort = requireSavedPort(input?.localPort, 'localPort')
    const entry = {
      id: newForwardId(),
      alias,
      remoteHost: typeof input?.remoteHost === 'string' && input.remoteHost.trim() !== '' ? input.remoteHost.trim() : '127.0.0.1',
      remotePort,
      localPort,
      localHost: typeof input?.localHost === 'string' && input.localHost.trim() !== '' ? input.localHost.trim() : '127.0.0.1',
      enabled: input?.open !== false,
      createdAt: Date.now(),
    }
    // The local port is checked BEFORE anything is written. A mapping that
    // cannot bind must not reach the store looking healthy: the panel would
    // then show a saved row whose URL never worked, and the next auto-start
    // would fail on a mistake the user already saw fail.
    //
    // The probe is advisory (the port can be taken between the check and the
    // bind); the authoritative refusal is the one the bind itself raises, which
    // is why `openById` still handles it below.
    const probe = await probeLocalPort(entry.localHost, entry.localPort)
    if (!probe.ok) {
      throw new Error(probe.code === 'EADDRINUSE'
        ? `local port ${entry.localPort} on ${entry.localHost} is already in use`
        : `local port ${entry.localPort} on ${entry.localHost} cannot be bound (${probe.code ?? 'unknown error'})`)
    }
    // Saved first, opened second: if the open fails the row still exists with
    // `enabled` set, so the panel shows it and the user can retry instead of
    // retyping the mapping.
    this.store.putForward(entry)
    if (entry.enabled) {
      try {
        await this.openById(entry.id, { strict: true })
      } catch (error) {
        this.failures.set(entry.id, error instanceof Error ? error.message : String(error))
      }
    }
    return this.rowById(entry.id)
  }

  /**
   * Open one saved mapping's listener.
   *
   * @param {string} id - the saved id.
   * @param {object} [options] - open options.
   * @param {boolean} [options.strict] - refuse an ephemeral fallback (default true).
   * @returns {Promise<object>} the resulting row.
   * @throws {Error} when the mapping is missing or the listener cannot bind.
   */
  async openById (id, options = {}) {
    const entry = this.#savedEntry(id)
    if (entry === undefined) throw new Error(`saved forward ${JSON.stringify(id)} does not exist`)
    try {
      await this.forwards.open(entry.alias, {
        id: entry.id,
        remotePort: entry.remotePort,
        remoteHost: entry.remoteHost,
        localHost: entry.localHost,
        localPort: entry.localPort,
        // A saved mapping pins its local port: the stored URL names it.
        strictLocalPort: options.strict !== false,
      })
      this.failures.delete(entry.id)
      this.store.setForwardEnabled(entry.id, true)
    } catch (error) {
      this.failures.set(entry.id, error instanceof Error ? error.message : String(error))
      throw error
    }
    return this.rowById(entry.id)
  }

  /**
   * Close one saved mapping's listener but keep the mapping and its `enabled`
   * flag as the user set it.
   *
   * Closing a saved forward means "stop the tunnel", not "forget it"; the panel
   * has a separate delete for the latter.
   *
   * @param {string} id - the saved id.
   * @returns {object} the resulting row.
   */
  closeById (id) {
    const entry = this.#savedEntry(id)
    if (entry === undefined) throw new Error(`saved forward ${JSON.stringify(id)} does not exist`)
    this.forwards.close(entry.id)
    this.store.setForwardEnabled(entry.id, false)
    this.failures.delete(entry.id)
    return this.rowById(entry.id)
  }

  /**
   * Turn off every tunnel on one host the way the panel's own row button does.
   *
   * A host disconnect is a deliberate user action, so the tunnels it takes down
   * must be left in the state a manual close leaves them in: intent off, no
   * recorded failure. Reaching for `ForwardManager.closeForAlias()` instead
   * keeps the intent on and records "SSH connection closed", which the panel
   * renders as a red "connection lost" line — telling the user something broke
   * when they asked for it. The two paths stay distinct because the difference
   * is the point: an unplanned drop is explained, a deliberate one is not.
   *
   * Transient tunnels (opened by the agent tool) have no stored intent to
   * clear, so closing their listener is all there is to do.
   *
   * @param {string} alias - the host whose tunnels go away.
   * @returns {number} how many live tunnels were closed.
   */
  closeAlias (alias) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return 0
    let closed = 0
    // Snapshot up front: `closeById` rewrites the very list this walks.
    for (const row of this.list()) {
      if (row.alias !== target) continue
      if (row.persisted !== true) {
        // A transient tunnel has no stored intent; closing its listener is the
        // whole of the action.
        if (this.forwards.close(row.id) === true) closed += 1
        continue
      }
      const wasLive = row.live === true
      try {
        // Goes through the same method the panel's "close" button uses, so the
        // two paths cannot drift apart.
        this.closeById(row.id)
      } catch { /* the row vanished between list() and close */ }
      if (wasLive) closed += 1
    }
    return closed
  }

  /**
   * Forget a saved mapping, closing its listener first.
   *
   * @param {string} id - the saved id.
   * @returns {boolean} whether a mapping was removed.
   */
  remove (id) {
    this.forwards.close(String(id))
    this.failures.delete(String(id))
    return this.store.deleteForward(String(id))
  }

  /**
   * Save an already-live transient forward under a new mapping.
   *
   * The agent tools open tunnels with ephemeral ids and no local port of their
   * own choosing. Persisting one takes the port the OS actually bound, so the
   * saved row describes the tunnel that exists rather than a guess.
   *
   * @param {string} liveId - the runtime id.
   * @returns {object} the stored row.
   * @throws {Error} when the id names no live forward.
   */
  remember (liveId) {
    const live = this.forwards.list().find(entry => entry.id === String(liveId))
    if (live === undefined) throw new Error(`forward ${JSON.stringify(liveId)} is not open`)
    const entry = {
      id: newForwardId(),
      alias: live.alias,
      remoteHost: live.remoteHost,
      remotePort: live.remotePort,
      localHost: live.localHost,
      localPort: live.localPort,
      enabled: true,
      createdAt: Date.now(),
    }
    this.store.putForward(entry)
    // The listener keeps running under its runtime id; the saved row is a
    // separate identity, so the panel would show two rows for one tunnel.
    // Re-open under the saved id and drop the transient one instead.
    this.forwards.close(String(liveId))
    void this.openById(entry.id, { strict: true }).catch((error) => {
      this.failures.set(entry.id, error instanceof Error ? error.message : String(error))
    })
    return this.rowById(entry.id)
  }

  /**
   * Open every saved mapping whose intent is "on".
   *
   * Runs serially and never throws: a startup that failed because one host is
   * unreachable would be worse than a tunnel that did not come back. Each
   * failure is recorded for the panel and logged once.
   *
   * @returns {Promise<{opened: number, failed: Array<{id: string, error: string}>}>} the outcome.
   */
  async autoStart () {
    if (this.autoStaring) return { opened: 0, failed: [] }
    const settings = this.settings()
    if (settings.autoStart !== true) return { opened: 0, failed: [] }
    let saved
    try {
      saved = this.store.forwards()
    } catch {
      return { opened: 0, failed: [] }
    }
    const wanted = saved.items.filter(entry => entry.enabled)
    if (wanted.length === 0) return { opened: 0, failed: [] }
    this.autoStaring = true
    let opened = 0
    const failed = []
    try {
      // Serial on purpose: several tunnels to the same host share one pooled
      // connection, and a burst of concurrent handshakes is both slower and
      // harder to attribute when one fails.
      for (const entry of wanted) {
        try {
          await this.openById(entry.id, { strict: true })
          opened += 1
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failed.push({ id: entry.id, error: message })
          this.logger?.warn?.(`ssh-workspace: could not auto-open forward ${entry.id} (${entry.alias}:${entry.remotePort}): ${message}`)
        }
      }
    } finally {
      this.autoStaring = false
    }
    if (opened > 0) this.logger?.info?.(`ssh-workspace: auto-opened ${opened} saved port forward(s)`)
    return { opened, failed }
  }

  /**
   * Whether one host has a saved tunnel whose intent is still "on".
   *
   * Read by the engine's reconnect loop: the listener died with the connection,
   * so nothing pins the host any more, but the stored intent says the user still
   * wants that tunnel — which is the definition of "worth redialing".
   *
   * @param {string} alias - host alias.
   * @returns {boolean} true when at least one enabled mapping names this host.
   */
  hasEnabled (alias) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return false
    try {
      return this.store.forwards().items.some(entry => entry.alias === target && entry.enabled)
    } catch {
      return false
    }
  }

  /**
   * Re-open the saved tunnels of one host whose listener died with its
   * connection, keeping each row's stored intent.
   *
   * Called after a background reconnect. Without it the SSH link would come
   * back while every saved mapping still showed "connection lost" until the user
   * clicked each one — the reconnect would have fixed the transport and nothing
   * they were actually using.
   *
   * Only rows whose intent is still "on" are opened, serial like `autoStart`
   * (several tunnels share one pooled connection), and a failure is recorded on
   * the row rather than thrown: the connection itself is up and must stay up.
   *
   * @param {string} alias - the host that just reconnected.
   * @returns {Promise<{opened: number, failed: Array<{id: string, error: string}>}>} the outcome.
   */
  async reopenEnabled (alias) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return { opened: 0, failed: [] }
    let saved
    try {
      saved = this.store.forwards()
    } catch {
      return { opened: 0, failed: [] }
    }
    const wanted = saved.items.filter(entry => entry.alias === target && entry.enabled)
    if (wanted.length === 0) return { opened: 0, failed: [] }
    const open = this.forwards.list()
    let opened = 0
    const failed = []
    for (const entry of wanted) {
      // A listener that survived (it was already back, or never died) must not
      // be reopened: `ForwardManager.open` would treat it as the same target and
      // return the existing one, but skipping is clearer and cheaper.
      if (open.some(live => live.id === entry.id)) continue
      try {
        await this.openById(entry.id, { strict: true })
        opened += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failed.push({ id: entry.id, error: message })
      }
    }
    if (opened > 0) this.logger?.info?.(`ssh-workspace: restored ${opened} port forward(s) on ${target} after reconnecting`)
    return { opened, failed }
  }

  /**
   * Record that a listener disappeared on its own, so the panel can explain it.
   *
   * Wired to `ForwardManager`'s `onClosed`: a connection drop is the one case
   * where the stored intent stays "on" while no tunnel exists, and the user
   * needs to see why.
   *
   * @param {object} entry - the torn-down forward entry.
   * @param {string} reason - why it went away.
   * @returns {void}
   */
  noteClosed (entry, reason) {
    if (reason !== REASON_CONNECTION && reason !== REASON_DISPOSED) return
    try {
      if (this.store.forwards().items.some(item => item.id === entry.id)) {
        this.failures.set(entry.id, reason)
      }
    } catch { /* an unreadable store cannot be annotated */ }
  }

  /** One saved entry straight from the store, or undefined. */
  #savedEntry (id) {
    const target = typeof id === 'string' ? id.trim() : ''
    if (target === '') return undefined
    try {
      return this.store.forwards().items.find(entry => entry.id === target)
    } catch {
      return undefined
    }
  }

  /** One joined row, or a bare row when the store no longer holds it. */
  rowById (id) {
    return this.list().find(row => row.id === String(id)) ?? { id: String(id), persisted: false, live: false }
  }
}
