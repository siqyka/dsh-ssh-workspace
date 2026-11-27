/**
 * The host power switch: hard disable, not "hide the row".
 *
 * ## The rule
 *
 * Switching a host off must mean "this host does nothing, now". The doc for the
 * feature (docs/FF/11-fork-review-and-next-features.md, 功能 2) is explicit
 * that a switch which only greys a row would be a lie: a long-running command
 * would keep running, a persistent shell would keep its PTY, a saved tunnel
 * would keep its listener, and the next filesystem call would silently dial the
 * host again. So one switch-off is an ORCHESTRATION over every resource this
 * plugin holds for that alias:
 *
 *  - in-flight commands and channels are aborted (engine.hostAborts),
 *  - the pooled connection is dropped (engine.forget),
 *  - persistent shells close (ShellManager.close),
 *  - port forwards and saved tunnels close, in both directions,
 *  - change watchers stop (RemoteWatchRegistry.closeForAlias),
 *  - remote terminals terminate (RemoteTerminalRouter.closeForAlias),
 *  - and the admission gate is closed (engine.setHostDisabled), so nothing can
 *    quietly open a new connection afterwards.
 *
 * Order matters: persist the intent FIRST (a write failure must not tear
 * anything down), close the gate SECOND (so a reconnect loop or an in-flight
 * retry cannot win the race), then tear down. The pooled connection goes last,
 * because every teardown above may need it to say goodbye.
 *
 * ## What it cannot do
 *
 * A session or workspace that belongs to the host is not the plugin's to close:
 * the Host owns sessions, and closing one from here would discard the user's
 * conversation. The panel greys those rows instead (client.marks), and every
 * gesture that would reconnect is refused by the gate. That boundary is
 * documented in docs/features.md rather than papered over.
 *
 * @module @shiqyka/dsh-ssh-workspace/hosts/disable
 */

/**
 * The resources one alias currently holds.
 *
 * @typedef {object} HostResources
 * @property {number} connections - pooled connections (0 or 1).
 * @property {number} inFlight - commands/channels the engine opened for it.
 * @property {number} shells - persistent shells.
 * @property {number} forwards - live local-to-remote forwards.
 * @property {number} savedForwards - saved tunnels currently carrying traffic.
 * @property {number} reverseForwards - reverse (`ssh -R`) tunnels.
 * @property {number} watches - change watchers (0 or 1 per target).
 * @property {number} terminals - remote terminals this plugin opened.
 */

/**
 * One host's switch.
 *
 * Collaborators are injected rather than imported so a suite can drive the
 * orchestration with fakes, and so a deployment that lacks one seam (no
 * terminals, no watcher) still switches hosts off.
 */
export class HostDisabler {
  /**
   * @param {object} options - the collaborators.
   * @param {object} options.engine - the SSH engine.
   * @param {object} [options.store] - the host entry store (`entryStore`).
   * @param {object} [options.shells] - the persistent-shell manager.
   * @param {object} [options.forwards] - live forwards.
   * @param {object} [options.savedForwards] - saved tunnels.
   * @param {object} [options.reverseForwards] - reverse tunnels.
   * @param {object} [options.watches] - the change-watch registry (or a getter).
   * @param {object} [options.terminals] - the remote-terminal router (or a getter).
   * @param {object} [options.logger] - logger.
   */
  constructor (options = {}) {
    this.engine = options.engine
    this.store = options.store
    this.shells = options.shells
    this.forwards = options.forwards
    this.savedForwards = options.savedForwards
    this.reverseForwards = options.reverseForwards
    this.watches = options.watches
    this.terminals = options.terminals
    this.logger = options.logger
  }

  /** Resolve a collaborator that may be a getter (the terminal router is built later). */
  #resolve (value) {
    try {
      return typeof value === 'function' ? value() : value
    } catch {
      return undefined
    }
  }

  /** Whether the alias is an editable store entry (the only kind that has a switch). */
  isStoreHost (alias) {
    try {
      return this.store?.find?.(alias) !== undefined
    } catch {
      return false
    }
  }

  /**
   * What switching this host off would interrupt, right now.
   *
   * Read from the live managers, never from a cached copy: the confirm dialog's
   * whole value is that its numbers are about the moment of the click.
   *
   * @param {string} alias - host alias.
   * @returns {HostResources} the counts.
   */
  counts (alias) {
    const watches = this.#resolve(this.watches)
    const terminals = this.#resolve(this.terminals)
    const countIn = (list, field = 'alias') => {
      try {
        return (list ?? []).filter(entry => entry?.[field] === alias).length
      } catch {
        return 0
      }
    }
    const savedRows = (() => {
      try {
        return this.savedForwards?.list?.() ?? []
      } catch {
        return []
      }
    })()
    return {
      connections: this.engine?.pool?.has?.(alias) === true ? 1 : 0,
      inFlight: this.engine?.hostAborts?.get?.(alias)?.size ?? 0,
      shells: countIn(this.shells?.list?.()),
      forwards: countIn(this.forwards?.list?.()),
      savedForwards: countIn(savedRows),
      reverseForwards: countIn(this.reverseForwards?.list?.()),
      watches: countIn(watches?.targets?.()),
      terminals: (() => {
        if (terminals?.handles === undefined) return 0
        let count = 0
        for (const handle of terminals.handles) {
          if (handle?.alias === alias) count += 1
        }
        return count
      })(),
    }
  }

  /**
   * Switch one host off.
   *
   * @param {string} alias - host alias.
   * @returns {{alias: string, enabled: false, before: HostResources, closed: object}} the report.
   * @throws {Error} when the intent cannot be persisted (nothing is torn down then).
   */
  disable (alias) {
    const target = String(alias)
    const before = this.counts(target)
    // 1. Persist the intent. A failure here must fail the request: tearing the
    // host down and then failing to remember it would silently switch it back
    // on at the next start.
    this.store?.setHostEnabled?.(target, false)
    // 2. Close the gate before any teardown, so a background reconnect or an
    // in-flight retry cannot open a new connection between the steps.
    this.engine?.setHostDisabled?.(target, true)
    const closed = {
      aborted: 0,
      shells: 0,
      forwards: 0,
      reverseForwards: 0,
      watches: 0,
      terminals: 0,
      connection: false,
    }
    // 3. Abort in-flight commands/channels.
    try { closed.aborted = this.engine?.abortHost?.(target) ?? 0 } catch (error) { this.#warn('abort', target, error) }
    // 4. Persistent shells: their PTYs are remote processes.
    try { closed.shells = this.shells?.close?.(target) ?? 0 } catch (error) { this.#warn('shells', target, error) }
    // 5. Both directions of tunnelling. A saved tunnel must go through its own
    // manager (it also owns the stored intent), and the live one otherwise.
    try {
      closed.forwards = this.savedForwards !== undefined
        ? (this.savedForwards.closeAlias?.(target) ?? 0)
        : (this.forwards?.closeForAlias?.(target, 'host switched off') ?? 0)
    } catch (error) { this.#warn('forwards', target, error) }
    try { closed.reverseForwards = this.reverseForwards?.closeForAlias?.(target, 'host switched off') ?? 0 } catch (error) { this.#warn('reverse forwards', target, error) }
    // 6. Change watchers would otherwise keep a channel open (or reconnect).
    try { closed.watches = this.#resolve(this.watches)?.closeForAlias?.(target) ?? 0 } catch (error) { this.#warn('watchers', target, error) }
    // 7. Remote terminals are live command execution in a pane.
    try { closed.terminals = this.#resolve(this.terminals)?.closeForAlias?.(target) ?? 0 } catch (error) { this.#warn('terminals', target, error) }
    // 8. The socket last: every teardown above may need it to say goodbye.
    try {
      const pooled = this.engine?.pool?.has?.(target) === true
      this.engine?.forget?.(target)
      closed.connection = pooled
    } catch (error) { this.#warn('connection', target, error) }
    this.logger?.info?.(`ssh-workspace: host ${target} switched off (${closed.aborted} command(s), ${closed.shells} shell(s), ${closed.forwards + closed.reverseForwards} forward(s), ${closed.watches} watch(es), ${closed.terminals} terminal(s))`)
    return { alias: target, enabled: false, before, closed }
  }

  /**
   * Switch one host back on.
   *
   * Deliberately does NOT dial: the power switch is a permission, not a
   * connection. The host connects on first use, or when its own auto-connect
   * intent is set — the two existing routes keep that distinction.
   *
   * @param {string} alias - host alias.
   * @returns {{alias: string, enabled: true}} the report.
   */
  enable (alias) {
    const target = String(alias)
    this.store?.setHostEnabled?.(target, true)
    this.engine?.setHostDisabled?.(target, false)
    this.logger?.info?.(`ssh-workspace: host ${target} switched on`)
    return { alias: target, enabled: true }
  }

  #warn (what, alias, error) {
    this.logger?.warn?.(`ssh-workspace: switching ${alias} off could not close its ${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
