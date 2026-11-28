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
 * ## Two things live here, and they belong together
 *
 * The ring records facts; the redaction rule at the bottom of this file decides
 * what may be recorded or exported. They are one concern with two halves — an
 * event and the same event after masking must not be able to disagree, and the
 * way they disagreed before was that three surfaces each had their own copy of
 * the rule. The bundle and the audit export import the masking from here now.
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
  /**
   * The fate of one host SEAM the plugin takes over (`lib/patch-*.js`).
   *
   * Distinct from `upstream` on purpose: `upstream` answers "can this workaround
   * be deleted?", which is a question about the HOST having moved on. This one
   * answers "did the takeover actually happen?", which is a question about THIS
   * plugin — and the two failure modes look nothing alike. A seam that was
   * absent (`ctx.sandbox` is not mounted in an unsandboxed composition) is
   * ordinary; a seam whose install threw (the Host renamed the method we wrap)
   * silently disables a documented feature while `ctx.logger` swallows the
   * complaint, which is exactly the case worth an event.
   */
  seam: 'seam',
  /**
   * The outcome of the session-ownership compensation (see `ownership.js`).
   *
   * Its own kind because it is neither a connection event nor a degradation:
   * `attachSession` succeeded, sessions that had been silently dropped from a
   * remote workspace's accounting are back in the sidebar. That is a REPAIR,
   * and repairs are invisible — nobody notices the sessions that returned only
   * because nothing was said. The failure half stays in `degraded`, where a
   * stranded session belongs.
   */
  ownership: 'ownership',
  /**
   * One completed remote-skills discovery pass.
   *
   * Its own kind because the count is the only place a user can see that a
   * remote host's skills were found at all: the catalog is otherwise invisible
   * (the Host renders it, this plugin never does), and "0 skills from box" is a
   * very different answer from "the root does not exist" — both of which look
   * like an empty list everywhere else.
   */
  remoteSkills: 'remote-skills',
  /**
   * One save from the browser's file editor.
   *
   * Its own kind because it is the only record that a PERSON, not an agent,
   * changed a file through this plugin. The message carries the path, the byte
   * count and the outcome; it never carries the text. A log that quoted the
   * file it wrote would put a second copy of every saved secret into the
   * support bundle.
   */
  write: 'write',
})

/**
 * A fixed-capacity event log.
 *
 * Deliberately not an EventEmitter: nothing subscribes, the log is read on
 * demand by the status surfaces, and an emitter would imply listeners that do
 * not exist.
 */

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
      const where = entry.alias === undefined ? '' : ` [${redact ? maskAlias(entry.alias) : entry.alias}]`
      lines.push(`#${entry.seq} ${new Date(entry.at).toISOString()} ${entry.kind}${where}`)
      lines.push(`  ${redact ? maskText(entry.message) : entry.message}`)
    }
    return lines.join('\n')
  }

  /** Drop everything (tests and a manual "clear" action). */
  clear () {
    this.entries.length = 0
  }
}

// ---------------------------------------------------------------------------
// The one redaction rule
// ---------------------------------------------------------------------------
//
// Every user-facing text this plugin emits passes through here before it is
// stored or pasted: the ring above, the support bundle and the audit export.
// One rule in one place: surfaces that grew their own masking disagreed, so
// "the bundle masks it" quietly became a reason to paste raw diagnostics.
// It sits beside the ring because the ring is the surface it guards.

/**
 * File names whose presence names a credential rather than a project.
 *
 * Matched as a path segment, so `~/.ssh/id_ed25519` and
 * `/srv/acme/prod.key` are both caught while `keyboard.ts` is not.
 *
 * @type {RegExp}
 */
const KEY_FILE = /([\\/][^\s'"]*[\\/])(?:id_(?:rsa|ed25519|ecdsa|dsa)|[^\s/'"\\]*\.(?:pem|key|p12|pfx|ppk))(?![\w-])/giu

/**
 * Mask one alias for a shared report, consistently everywhere.
 *
 * The alias is often the user's own machine name. A short stable prefix keeps
 * events from the same host correlatable while removing the name itself. Short
 * aliases are masked COMPLETELY rather than half-revealed: `w**` from `web` is
 * a guess away, and a short name is the one case where a prefix leak matters.
 *
 */
export function maskAlias (alias) {
  const text = String(alias ?? '')
  if (text === '') return '?'
  if (text.length <= 3) return '*'.repeat(text.length)
  return `${text.slice(0, 2)}***${text.slice(-1)}`
}

/**
 * Mask the identifying parts of a path or message while keeping its shape.
 *
 * The single rule every surface applies. Exported under the name the bundle has
 * always used, because callers already import it.
 *
 */
export function maskPath (text) {
  return maskText(text)
}

/**
 * Mask identifying parts of arbitrary text.
 *
 * Order matters: the home-directory rules run before the generic key-file rule,
 * so `/home/alice/.ssh/id_rsa` becomes `/home/<user>/<key>` rather than
 * `<key>` with the user still bare.
 *
 */
export function maskText (text) {
  let out = String(text ?? '')
  // Home directories carry the local username.
  out = out.replace(/(\/home\/)[^\s/]+/gu, '$1<user>')
  out = out.replace(/(\/Users\/)[^\s/]+/gu, '$1<user>')
  out = out.replace(/([A-Za-z]:\\Users\\)[^\s\\]+/gu, '$1<user>')
  // A login user in front of an address (`root@10.0.0.1:22`). Only when what
  // follows looks like host:port, so an email address is left alone.
  out = out.replace(/([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+:\d+)/gu, '<user>@$2')
  // Credential-looking file names, wherever they live.
  out = out.replace(KEY_FILE, '$1<key>')
  // An explicit password or passphrase in an assignment.
  out = out.replace(/(password|passphrase)(\s*[=:]\s*)[^\s,'"}]+/giu, '$1$2<redacted>')
  return out
}

/**
 * Mask a value the caller is about to put on ONE line of a report.
 *
 * Line breaks are collapsed as well: a message with a newline would otherwise
 * split a `seq N: ...` line in two and make the report unparseable, which is a
 * correctness problem rather than a cosmetic one.
 *
 */
export function maskLine (text) {
  return maskText(String(text ?? '').replace(/\r?\n/gu, ' '))
}

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
