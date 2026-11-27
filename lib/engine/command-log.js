/**
 * The command audit on disk.
 *
 * The ring in `engine.js` answers "what ran on this machine since the plugin
 * started". A restart empties it, and a user who wants to know what was run on a
 * host last week has nothing to read. This module is the durable half: one small
 * JSON document beside the rest of the plugin's state, rewritten atomically when
 * the ring changes.
 *
 * Four bounds, because a log that can grow without one is a log that eventually
 * fills a disk or a support bundle:
 *
 *  - entries: the ring's own capacity (the retention setting, default 200);
 *  - fields: bounded at write time by the ring, not here — this file never sees
 *    an unbounded command, it only serializes what the ring already sanitized;
 *  - output: stdout/stderr are never recorded at all;
 *  - bytes: `MAX_LOG_BYTES`, enforced by dropping the OLDEST rows until the
 *    document fits. Old rows are the ones a reader is least likely to need.
 *
 * Failure is never the command's problem: every filesystem error is swallowed
 * after a warning, and a write that cannot happen leaves the previous file alone.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Directory under `$DSH_HOME` that holds this plugin's state. */
export const COMMAND_LOG_DIR = 'dsh-ssh-workspace'

/** File name within that directory. */
export const COMMAND_LOG_FILE = 'dsh-ssh-commands.json'

/** Hard ceiling for the serialized document. */
export const MAX_LOG_BYTES = 512 * 1024

/** Debounce window: a burst of commands writes once, not once per command. */
export const LOG_FLUSH_DELAY_MS = 500

/** The document's shape version; a reader that does not know it ignores the file. */
export const LOG_VERSION = 1

/**
 * Where the command log lives for one DSH home.
 *
 * @param {string|undefined} home - the DSH home directory, if the composition named one.
 * @returns {string|undefined} absolute path, or undefined when there is no home.
 */
export function commandLogPath (home) {
  if (typeof home !== 'string' || home.trim() === '') return undefined
  return path.join(home, COMMAND_LOG_DIR, COMMAND_LOG_FILE)
}

/**
 * Serialize entries into the on-disk document, trimming the oldest to fit.
 *
 * @param {object[]} entries - sanitized rows, oldest first.
 * @returns {{text: string, entries: object[]}} the document and what survived.
 */
export function serializeCommandLog (entries) {
  let rows = Array.isArray(entries) ? entries : []
  for (;;) {
    const text = JSON.stringify({ version: LOG_VERSION, entries: rows })
    if (Buffer.byteLength(text, 'utf8') <= MAX_LOG_BYTES || rows.length <= 1) return { text, entries: rows }
    // Drop a slice rather than one row at a time: a 400-char command is small,
    // and re-serializing half a megabyte per dropped row would be quadratic.
    rows = rows.slice(Math.max(1, Math.ceil(rows.length / 10)))
  }
}

/**
 * Parse a document back into rows.
 *
 * Unknown versions and malformed shapes are "no rows", not an error: the file is
 * a convenience, and a plugin that refuses to start because its log is damaged
 * has made the log more important than the feature.
 *
 * @param {string} text - file contents.
 * @returns {object[]} the rows, or an empty array.
 */
export function parseCommandLog (text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return []
    if (parsed.version !== LOG_VERSION) return []
    if (!Array.isArray(parsed.entries)) return []
    return parsed.entries
  } catch {
    return []
  }
}

/** The writer. */
export class CommandLog {
  /**
   * @param {object} options
   * @param {string|undefined} options.file - where to write; undefined disables it.
   * @param {{ list: (limit?: number) => object[], onChange?: Function }} options.audit - the ring.
   * @param {{ warn?: (message: string) => void }} [options.logger]
   * @param {number} [options.delayMs]
   */
  constructor (options) {
    this.file = options?.file
    this.audit = options?.audit
    this.logger = options?.logger
    this.delayMs = Number.isFinite(options?.delayMs) ? Math.max(0, options.delayMs) : LOG_FLUSH_DELAY_MS
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined
    /** The last text written, so an unchanged ring does not rewrite the file. */
    this.lastText = undefined
    this.disposed = false
    /** Most recent failure, kept for diagnostics rather than re-logged per flush. */
    this.lastError = undefined
  }

  /** Rows from disk, already validated only as far as "it is an array". */
  load () {
    if (this.file === undefined) return []
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      return parseCommandLog(text)
    } catch (error) {
      // ENOENT is the ordinary first run, not a problem worth a warning.
      if (error?.code !== 'ENOENT') this.warn(`could not read the command log: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /** Queue one debounced write. */
  schedule () {
    if (this.disposed || this.file === undefined || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.delayMs)
    // A pending flush must not keep the Host process alive on shutdown.
    this.timer.unref?.()
  }

  /** Write now, if the ring changed. */
  flush () {
    if (this.disposed || this.file === undefined || this.audit === undefined) return false
    try {
      const { text } = serializeCommandLog(this.audit.list())
      if (text === this.lastText) return false
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      // `pid`+`Date.now()` keep two writers from colliding when a reload runs
      // beside the outgoing instance.
      const temp = `${this.file}.${process.pid}.${Date.now().toString(36)}.tmp`
      try {
        fs.writeFileSync(temp, text, { mode: 0o600 })
        fs.renameSync(temp, this.file)
      } catch (error) {
        try { fs.unlinkSync(temp) } catch { /* the temp may not exist */ }
        throw error
      }
      try { fs.chmodSync(this.file, 0o600) } catch { /* best effort; mode came from the write */ }
      this.lastText = text
      this.lastError = undefined
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.warn(`could not write the command log: ${this.lastError}`)
      return false
    }
  }

  /** Cancel a pending flush, write what is there, and stop listening. */
  dispose () {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flush()
    this.disposed = true
  }

  warn (message) {
    try {
      this.logger?.warn?.(`ssh-workspace: ${message}`)
    } catch { /* logging never fails the caller */ }
  }
}
