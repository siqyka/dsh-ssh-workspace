/**
 * The ONE redaction rule, shared by every user-facing text this plugin emits.
 *
 * ## Why this is a module and not a function per caller
 *
 * Three surfaces produce text meant to be pasted in public: the diagnostics ring
 * (`diagnostics.js`), the support bundle (`support-bundle.js`) and the audit
 * export (`audit.js`). Each grew its own masking, and they disagreed — the same
 * string was masked in the bundle and left bare in `exportText()`. That is worse
 * than a missing rule, because "the support bundle masks it" is exactly the
 * reason a user pastes `exportText()` without reading it.
 *
 * The concrete leak that motivated this: `lib/engine.js` records
 * `connected to alice@prod-db-01.internal.corp:22` on EVERY successful
 * connection. The bundle's `maskPath` had a `user@host:port` rule; the
 * diagnostics one did not, so any copied diagnostics text carried the login
 * name and an internal hostname.
 *
 * ## What is masked, and what is deliberately not
 *
 * Masked: the login user in front of an address, the user segment of a home
 * directory, private-key file names, and an explicit `password=` / `passphrase=`
 * assignment. Kept: the path's SHAPE (a reader must still be able to tell
 * `/home/<user>/proj/src/index.ts` from `.../dist/app.js`), the host address
 * itself, ports and key kinds.
 *
 * Not masked: a bare absolute path outside a home directory. It is tempting to
 * mask every `/srv`, `/opt` and `/var` path, but a diagnostic whose paths are
 * all `<path>` is unreadable, and the useful half of the report is which tree
 * failed. What IS masked is any of those paths whose LAST segment looks like a
 * key file — that is the part that names a credential rather than a project.
 *
 * An `@` is masked only when what follows looks like `host:port`, so an email
 * address in a message is left alone: a rule that hits every `@` mangles text
 * without making it any safer.
 *
 * @module @shiqyka/dsh-ssh-workspace/redact
 */

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
 * @param {string} alias - the host alias.
 * @returns {string} a stable, shortened form.
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
 * @param {string} text - a path, or any text containing paths and addresses.
 * @returns {string} the masked text.
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
 * @param {string} text - the text to mask.
 * @returns {string} the masked text.
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
 * @param {string} text - the text.
 * @returns {string} one masked line.
 */
export function maskLine (text) {
  return maskText(String(text ?? '').replace(/\r?\n/gu, ' '))
}
