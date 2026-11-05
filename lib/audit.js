/**
 * A bounded record of what this plugin actually ran on a remote host.
 *
 * ## Why "audit" and not "sandbox"
 *
 * The plugin cannot confine a remote command: the process runs as the remote
 * login user with that user's full permissions, and nothing on this side of an
 * SSH channel is a kernel boundary (see mode-gate.js for the long version). So
 * the honest middle layer is not prevention but a RECORD — enough to answer
 * "what did this session do on that host, and when" after the fact.
 *
 * That is also the only layer that survives being wrong: a command filter that
 * misclassifies `sh -c 'rm -rf ~'` is worse than no filter, while a log that
 * records it is simply a log.
 *
 * ## What makes this different from the diagnostics ring
 *
 * `diagnostics.js` holds notable EVENTS — connect, disconnect, degrade. It
 * answers "what went wrong". This holds COMMANDS — what was run, how it ended,
 * how long it took — and answers "what happened here". They are separate rings
 * because they have different retention needs: an outage produces a burst of
 * events and no commands, while a busy session produces hundreds of commands and
 * one connect. Sharing one bounded ring would let either flush the other.
 *
 * ## Redaction is not optional
 *
 * A command line routinely carries a token (`curl -H "Authorization: Bearer …"`),
 * a password in an assignment, or an absolute path containing the local
 * username. The log is meant to be readable and exportable, so every entry is
 * redacted on WRITE, not on export: a raw copy that only gets masked at the
 * boundary is a raw copy that can leak through any other reader.
 *
 * ## What is deliberately not recorded
 *
 * Output. A command's stdout can be megabytes and can contain anything; the
 * record keeps the command, its exit status and its duration. A reader who
 * needs the output has the tool result, and a log that stores output is a log
 * that has to answer "how much of it".
 *
 * @module @shiqyka/dsh-ssh-workspace/audit
 */

import { maskText } from './redact.js'

/** Entries kept. Enough for a session's worth of work, small enough to export. */
export const AUDIT_CAPACITY = 200

/** Longest command retained; the rest is truncated with a marker. */
const MAX_COMMAND_CHARS = 400

/** Longest error string retained. */
const MAX_ERROR_CHARS = 200

/**
 * Strip the things a command line routinely carries that must not travel.
 *
 * Deliberately the same family as `diagnostics.js` redaction, plus the patterns
 * that only appear in COMMAND LINES:
 *
 *  - an explicit password/passphrase assignment;
 *  - an `Authorization` header or a bearer token;
 *  - a `--password` / `-p` style flag value;
 *  - a token-shaped query parameter (`?token=…`, `&access_token=…`).
 *
 * The regexes are conservative on purpose: over-redacting a command makes the
 * log useless ("what did I run?"), while under-redacting leaks. Where the two
 * trade off, this errs toward keeping the shape of the command and masking only
 * the value.
 *
 * @param {string} command - the command line.
 * @returns {string} the command with secret values masked.
 */
export function redactCommand (command) {
  let text = String(command ?? '')
  // An explicit assignment, quoted or not. The name is matched with its
  // PREFIX intact (`DB_PASSWORD`, `GITHUB_TOKEN`) because a `\b` before
  // `password` does not fire after an underscore — which is exactly how an
  // environment-variable assignment is spelled, and the first version of this
  // regex let `DB_PASSWORD=...` through untouched.
  text = text.replace(
    /([A-Za-z0-9_-]*(?:password|passwd|passphrase|secret|token|api[_-]?key))(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;|&]+)/giu,
    (_match, name, separator) => `${name}${separator}<redacted>`,
  )
  // A flag whose next token is the value.
  text = text.replace(
    /(--?(?:password|passwd|passphrase|token|api-key|apikey)[=\s])(?:"[^"]*"|'[^']*'|[^\s;|&]+)/giu,
    (_match, flag) => `${flag}<redacted>`,
  )
  // An Authorization header. `Bearer <token>` is handled BEFORE the generic
  // header rule, because the generic rule's "one word" value would consume the
  // scheme and leave the token in plain sight — which is what the first
  // version did.
  text = text.replace(
    /(authorization\s*:\s*)(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]+/giu,
    (_match, header) => `${header}<redacted>`,
  )
  text = text.replace(
    /(authorization\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s;|&]+)/giu,
    (_match, header) => `${header}<redacted>`,
  )
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gu, 'Bearer <redacted>')
  // A token-shaped query parameter.
  text = text.replace(
    /([?&](?:token|access_token|api_key|apikey|key|signature|sig)=)[^&\s]+/giu,
    (_match, prefix) => `${prefix}<redacted>`,
  )
  // Home directories, which carry the local or remote username.
  // The shared rule, so a path is masked identically here, in the diagnostics
  // text and in the support bundle. This module used to repeat the three
  // home-directory patterns verbatim; a fourth copy is how one surface ends up
  // masking a path the other three print.
  return maskText(text)
}

/**
 * Cut a string to a bound, marking that it was cut.
 *
 * @param {string} value - the text.
 * @param {number} limit - maximum characters.
 * @returns {string} the bounded text.
 */
function bounded (value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 3)}...`
}

/**
 * One audited command.
 *
 * @typedef {object} AuditEntry
 * @property {number} seq - monotonic id; survives ring eviction.
 * @property {number} at - epoch ms when the run STARTED.
 * @property {string} alias - host alias.
 * @property {string} command - redacted, bounded command line.
 * @property {string} [cwd] - remote working directory, when given.
 * @property {'exec'|'shell'|'terminal'|'background'} channel - how it ran.
 * @property {number} durationMs - wall clock.
 * @property {number|null} exitCode - the status, or null when unknown.
 * @property {boolean} timedOut - whether the budget expired.
 * @property {boolean} [outcomeUnknown] - the connection died; it may have run.
 * @property {string} [error] - redacted failure text.
 * @property {boolean} [refused] - the mode gate refused it, so nothing ran.
 */

/**
 * The audit ring.
 *
 * Same discipline as the diagnostics ring: bounded, infallible, plain objects.
 * `record()` never throws, because every call site is inside a command path and
 * a log that can fail the command it describes is worse than no log.
 */
export class CommandAudit {
  /** @param {number} [capacity] - entries to keep. */
  constructor (capacity = AUDIT_CAPACITY) {
    /** @type {AuditEntry[]} */
    this.entries = []
    this.capacity = Number.isInteger(capacity) && capacity > 0 ? capacity : AUDIT_CAPACITY
    /**
     * Monotonic counter, kept OUTSIDE the array so `seq` keeps increasing after
     * old entries fall off — a reader can tell a gap from a repeat.
     */
    this.sequence = 0
  }

  /**
   * Append one command.
   *
   * @param {object} entry - the run.
   * @returns {AuditEntry | undefined} the stored entry (tests read it back).
   */
  record (entry) {
    try {
      this.sequence += 1
      const stored = {
        seq: this.sequence,
        at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
        alias: String(entry?.alias ?? ''),
        command: bounded(redactCommand(entry?.command), MAX_COMMAND_CHARS),
        channel: entry?.channel === 'shell' || entry?.channel === 'terminal' || entry?.channel === 'background' ? entry.channel : 'exec',
        durationMs: Number.isFinite(entry?.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0,
        exitCode: typeof entry?.exitCode === 'number' ? entry.exitCode : null,
        timedOut: entry?.timedOut === true,
      }
      if (typeof entry?.cwd === 'string' && entry.cwd !== '') stored.cwd = bounded(redactCommand(entry.cwd), 200)
      if (entry?.outcomeUnknown === true) stored.outcomeUnknown = true
      if (entry?.refused === true) stored.refused = true
      if (typeof entry?.error === 'string' && entry.error !== '') stored.error = bounded(redactCommand(entry.error), MAX_ERROR_CHARS)
      this.entries.push(stored)
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
      return stored
    } catch {
      return undefined
    }
  }

  /**
   * The retained entries, oldest first.
   *
   * @param {number} [limit] - keep the newest N.
   * @returns {AuditEntry[]} copies, so a caller cannot mutate the log.
   */
  list (limit) {
    const all = this.entries.map(entry => ({ ...entry }))
    if (typeof limit === 'number' && limit > 0) return all.slice(-limit)
    return all
  }

  /**
   * Rows for one host only.
   *
   * @param {string} alias - host alias.
   * @param {number} [limit] - keep the newest N.
   * @returns {AuditEntry[]} copies.
   */
  listFor (alias, limit) {
    const rows = this.entries.filter(entry => entry.alias === alias).map(entry => ({ ...entry }))
    if (typeof limit === 'number' && limit > 0) return rows.slice(-limit)
    return rows
  }

  /**
   * A portable text form for the diagnostic report.
   *
   * Every field is already redacted at write time, so this is a formatter, not a
   * second redaction pass — two passes would drift.
   *
   * @param {number} [limit] - newest N entries.
   * @returns {string} the report.
   */
  exportText (limit = 50) {
    const entries = this.list(limit)
    if (entries.length === 0) return 'no remote commands recorded'
    const lines = [`commands: ${entries.length} of ${this.sequence} recorded`, '']
    for (const entry of entries) {
      const when = new Date(entry.at).toISOString()
      const status = entry.refused === true
        ? 'refused'
        : entry.outcomeUnknown === true
          ? 'outcome unknown'
          : entry.timedOut
            ? 'timed out'
            : `exit ${entry.exitCode === null ? 'null' : entry.exitCode}`
      const where = entry.cwd === undefined ? '' : ` (cwd ${entry.cwd})`
      lines.push(`#${entry.seq} ${when} ${entry.alias} ${entry.channel} ${status} ${entry.durationMs}ms${where}`)
      lines.push(`  ${entry.command}`)
      if (entry.error !== undefined) lines.push(`  error: ${entry.error}`)
    }
    return lines.join('\n')
  }

  /** Drop everything. */
  clear () {
    this.entries.length = 0
  }
}
