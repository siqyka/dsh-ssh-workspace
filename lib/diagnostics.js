/**
 * A small, bounded record of what the SSH half has been doing.
 *
 * ## Why this exists at all
 *
 * The obvious way to make a plugin observable is `ctx.logger.debug(...)`. That
 * is a dead end in this deployment, and it took a measurement to notice:
 *
 *  - the Host installs no console exporter, so `ctx.logger` calls reach a
 *    ring buffer (`LoggerService.buffer`) that nothing in the tree ever reads
 *    — verified by searching every shipped package for a reader;
 *  - `debug` is level 3 and every exporter default is level 1, so it is
 *    dropped before it even reaches that buffer.
 *
 * A `debug()` line therefore looks like observability in review and is
 * observationally identical to a comment. What a user can actually reach is the
 * `ssh_workspace_status` tool and the panel's status route, so the events are
 * kept where those two surfaces can serve them.
 *
 * ## Shape
 *
 * Bounded on purpose: a long-lived session that reconnects for days must not
 * grow without limit. Old entries fall off the front. Every entry is a plain
 * object of primitives so it can travel through the tool's output schema and a
 * JSON HTTP response without a custom serializer.
 *
 * @module @shiqyka/dsh-ssh-workspace/diagnostics
 */

/** Entries kept. Enough to explain "what just happened", small enough to print. */
export const CAPACITY = 40

/**
 * The version of the exported event shape.
 *
 * Bumped when a field is renamed or removed, NOT when one is added: a reader
 * that ignores unknown fields keeps working across additive changes, and
 * forcing a bump for those would make the number meaningless. Consumers can
 * compare it to decide whether their parser is still adequate.
 */
export const SCHEMA_VERSION = 1

/** Event kinds, kept as a closed set so a typo shows up in one place. */
export const KINDS = Object.freeze({
  connect: 'connect',
  disconnect: 'disconnect',
  reconnect: 'reconnect',
  degraded: 'degraded',
  forward: 'forward',
  /**
   * The fate of an upstream workaround (see patch-projection.js). Exists as its
   * own kind because it is the ONE signal whose whole purpose is to be noticed:
   * "upstream fixed it, delete the patch" is a message that must not be lost,
   * and `ctx.logger` cannot deliver it in this deployment.
   */
  upstream: 'upstream',
})

/**
 * A fixed-capacity event log.
 *
 * Deliberately not an EventEmitter: nothing subscribes, the log is read on
 * demand by the status surfaces, and an emitter would imply listeners that do
 * not exist.
 */

/**
 * Redact one alias for a shared report.
 *
 * The alias is often the user's own machine name, which is identifying. A short
 * stable prefix keeps events from the same host correlatable while removing the
 * name itself.
 *
 * @param {string} alias - the host alias.
 * @returns {string} a stable, shortened form.
 */
function redactAlias (alias) {
  if (typeof alias !== 'string' || alias === '') return '?'
  if (alias.length <= 3) return alias[0] + '*'.repeat(alias.length - 1)
  return `${alias.slice(0, 2)}***${alias.slice(-1)}`
}

/**
 * Strip the things an error message routinely carries that must not travel.
 *
 * Error strings from this plugin contain absolute paths (a private key, a
 * remote project directory), usernames, and occasionally a password echoed by a
 * remote command. The report is meant to be pasted into an issue, so the
 * redaction is the default and there is no "raw" switch on any user-facing path.
 *
 * @param {string} message - the event message.
 * @returns {string} the message with paths and secrets masked.
 */
function redactSecrets (message) {
  let text = String(message)
  // Home directories, which carry the local username.
  text = text.replace(/(\/home\/)[^\s/]+/gu, '$1<user>')
  text = text.replace(/(\/Users\/)[^\s/]+/gu, '$1<user>')
  text = text.replace(/([A-Za-z]:\\Users\\)[^\s\\]+/gu, '$1<user>')
  // Private keys: keep the kind, drop the tree.
  text = text.replace(/((?:\/|\\)[^\s'"]*?)(?:id_(?:rsa|ed25519|ecdsa|dsa))(\b)/gu, '<key>$2')
  // An explicit password or passphrase in an assignment.
  text = text.replace(/(password|passphrase)(\s*[=:]\s*)[^\s,'"}]+/giu, '$1$2<redacted>')
  return text
}

export class Diagnostics {
  /** @param {number} [capacity] - entries to keep (tests use a small one). */
  constructor (capacity = CAPACITY) {
    /** @type {Array<{seq: number, at: number, kind: string, message: string, alias?: string}>} */
    this.entries = []
    this.capacity = Number.isInteger(capacity) && capacity > 0 ? capacity : CAPACITY
    /**
     * Monotonic event number.
     *
     * Kept OUTSIDE the array on purpose: `seq` must keep increasing after the
     * ring drops old entries, so "events 41..44 happened after event 39" stays
     * true even when 39 has fallen off the front. A reader can therefore order
     * an outage's events, and tell a gap (entries dropped) from a repeat.
     */
    this.sequence = 0
  }

  /**
   * Append one event.
   *
   * Never throws: a diagnostic that can fail the operation it is describing is
   * worse than no diagnostic, and every call site is inside a failure path.
   *
   * @param {string} kind - one of {@link KINDS}.
   * @param {string} message - short, human-readable, no secrets.
   * @param {object} [detail] - optional fields; `alias` is the common one.
   * @returns {void}
   */
  record (kind, message, detail = {}) {
    try {
      this.sequence += 1
      const entry = { seq: this.sequence, at: Date.now(), kind: String(kind), message: String(message) }
      if (typeof detail.alias === 'string' && detail.alias !== '') entry.alias = detail.alias
      this.entries.push(entry)
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    } catch { /* a diagnostic must never be the reason something fails */ }
  }

  /**
   * The retained entries, oldest first.
   *
   * @param {number} [limit] - return at most this many, keeping the newest.
   * @returns {Array<object>} copies, so a caller cannot mutate the log.
   */
  list (limit) {
    const all = this.entries.map(entry => ({ ...entry }))
    if (typeof limit === 'number' && limit > 0) return all.slice(-limit)
    return all
  }

  /**
   * A portable snapshot a user can copy into a bug report.
   *
   * Deliberately plain text, and deliberately redacted: the ring holds aliases
   * and error strings, and an error string can carry a private-key path or a
   * full remote path. Nothing is uploaded anywhere — `SECURITY.md` is explicit
   * that this plugin does not phone home, and a "copy diagnostics" button must
   * not become the exception.
   *
   * @param {{limit?: number, redact?: boolean}} [options] - how much, and whether to redact.
   * @returns {string} the report text.
   */
  exportText (options = {}) {
    const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : CAPACITY
    const redact = options.redact !== false
    const entries = this.list(limit)
    const lines = [
      `schemaVersion: ${SCHEMA_VERSION}`,
      `entries: ${entries.length} of ${this.sequence} recorded`,
      '',
    ]
    for (const entry of entries) {
      const where = entry.alias === undefined ? '' : ` [${redact ? redactAlias(entry.alias) : entry.alias}]`
      lines.push(`#${entry.seq} ${new Date(entry.at).toISOString()} ${entry.kind}${where}`)
      lines.push(`  ${redact ? redactSecrets(entry.message) : entry.message}`)
    }
    return lines.join('\n')
  }

  /** Drop everything (tests and a manual "clear" action). */
  clear () {
    this.entries.length = 0
  }
}
