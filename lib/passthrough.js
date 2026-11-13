/**
 * Local-path passthrough for the remote filesystem seam.
 *
 * A session whose workspace is `ssh://<alias>/<path>` runs in the remote world:
 * a bare absolute path is remote-absolute, exactly as `/etc/hosts` is
 * local-absolute in a local session. Chat uploads, however, are stored on the
 * machine running DSH and their model-facing handle is a HOST absolute path
 * (`$DSH_HOME/attachments/v1/files/...`). The remote router would turn that
 * spelling into `ssh://<alias>/$DSH_HOME/...` and fail over SFTP.
 *
 * This module makes a small, explicit set of host prefixes addressable in an
 * otherwise remote session. It is deliberately lexical: matching never stats,
 * resolves symlinks, or probes existence, so a path's world cannot silently
 * change depending on whether a file happens to exist at this instant. Only
 * paths that hit a configured prefix bypass the remote classification; every
 * other path keeps its previous meaning. There is no "exists locally, prefer it"
 * fallback.
 *
 * Defaults cover the two places the Host itself writes: chat attachments and
 * installed plugins. The whole `$DSH_HOME` is intentionally NOT a default (or
 * accepted prefix): it contains `dsh-ssh.json`, the SSH key, and session data.
 *
 * The same lexical rule also accepts host paths the USER explicitly named with
 * an `@` mention in a user message. The Host inserts such mentions as ordinary
 * prompt text; there is no metadata at the filesystem call to say "this came
 * from @". Adding every Windows drive path would expose the whole host, so the
 * matcher only accepts paths recorded from `user/message` events (see
 * {@link hostReferencePathsInText} and `addHostReference`). A path that was not
 * named by the user stays remote exactly as before.
 *
 * @module @shiqyka/dsh-ssh-workspace/passthrough
 */

import nodePath from 'node:path'
import { homedir } from 'node:os'

/** Prefixes that are local to this machine by default. */
export const DEFAULT_PASSTHROUGH = ['$DSH_HOME/attachments', '$DSH_HOME/plugins']

/** Upper bound on remembered @ host references; old ones are evicted first. */
const HOST_REFERENCE_CAP = 256

/**
 * A character that glues an `@` into a larger word, so it is not a mention.
 *
 * The Host inserts `@path` at a token boundary, but a person typing by hand
 * writes `读@F:\a.txt` or `see:@F:\a.txt`. Accepting any non-word character
 * before the `@` keeps those working while `x@F:\mail.txt` stays an address.
 */
const AT_GLUED_BEFORE_RE = /[A-Za-z0-9_.\-\\/]$/u

/** A leading `@` token, quoted form: `@"C:\path with spaces"`. */
const AT_QUOTED_RE = /@("[^"]*")/gu

/**
 * Full-width punctuation that ends an unquoted mention.
 *
 * Chinese prose rarely puts a space before a comma, so the token has to stop
 * there; ASCII punctuation is stripped after the match instead, because a path
 * may legitimately contain a `.` or a `-`.
 */
const AT_STOP_CHARS = '，。；：！？、）】》」』'

/** A leading `@` token, unquoted form: `@C:\path` (ends at whitespace or a stop). */
const AT_PLAIN_RE = new RegExp(`@([^\\s"${AT_STOP_CHARS}]+)`, 'gu')

/** ASCII punctuation that can follow an unquoted mention without being part of it. */
const AT_TRAILING_PUNCTUATION_RE = /[.,;!?)\]}]+$/u

/**
 * Matching is lexical and platform-aware, but `node:path.isAbsolute` must not be
 * used here: this plugin patches it so `ssh://` spellings answer true, and the
 * module load order during a hot reload is not a reliable explanation of which
 * copy of `isAbsolute` a caller captured.
 */
const POSIX_ABSOLUTE_RE = /^\/(?!\/)/u
const DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/u
const UNC_ABSOLUTE_RE = /^\\\\[^\\]/u
const DSH_HOME_TOKEN_RE = /\$(?:DSH_HOME(?![A-Za-z0-9_])|\{DSH_HOME\})/gu
const UNKNOWN_VAR_RE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/u

/**
 * Whether a spelling is a local absolute path by syntax alone.
 *
 * `ssh://` is never local, even on POSIX where it starts with no slash. This
 * intentionally accepts POSIX and Windows shapes on every platform: the
 * classification decides which WORLD a caller means, not which parser the
 * current OS would use.
 *
 * @param {unknown} spelling - candidate path.
 * @returns {boolean} true for a syntactically local absolute path.
 */
export function looksLocalAbsolute (spelling) {
  if (typeof spelling !== 'string' || spelling === '') return false
  if (spelling.startsWith('ssh://')) return false
  return POSIX_ABSOLUTE_RE.test(spelling) || DRIVE_ABSOLUTE_RE.test(spelling) || UNC_ABSOLUTE_RE.test(spelling)
}

/**
 * Whether a spelling can only name a Windows host path.
 *
 * A drive or UNC absolute cannot be a valid absolute path on the POSIX remote
 * hosts this plugin runs (its remote shell is always POSIX), so it is
 * unambiguous evidence that the caller means this machine. POSIX absolute
 * spellings are not included: `/tmp/x` is both a valid host and remote path and
 * stays governed by the explicit prefix list.
 *
 * @param {unknown} spelling - candidate path.
 * @returns {boolean} true for a Windows drive or UNC absolute spelling.
 */
export function isWindowsHostPath (spelling) {
  if (typeof spelling !== 'string' || spelling === '') return false
  if (spelling.startsWith('ssh://')) return false
  return DRIVE_ABSOLUTE_RE.test(spelling) || UNC_ABSOLUTE_RE.test(spelling)
}

/**
 * Extract host paths the user explicitly addressed with `@` in one message.
 *
 * The Host's file-reference grammar inserts these as ordinary prompt text, so
 * this is the only place the `@` intent survives. Only Windows drive/UNC
 * absolute paths are returned; `@src/a.js` and `@/tmp/x` remain workspace or
 * remote references, exactly as the Host's own prompt describes.
 *
 * @param {unknown} text - one user message's text.
 * @returns {string[]} host-path spellings, deduplicated in message order.
 */
export function hostReferencePathsInText (text) {
  if (typeof text !== 'string' || text === '') return []
  const found = []
  const seen = new Set()
  const remember = (raw) => {
    // A mention pasted from a directory listing often ends on the separator;
    // dropping it canonicalizes the spelling without changing what it names.
    const spelling = raw.trim().replace(/[\\/]+$/u, '')
    if (!isWindowsHostPath(spelling)) return
    const key = spelling.toUpperCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push(spelling)
  }
  // Quoted spellings first: they are the only ones that may contain a space, and
  // an unquoted pass would otherwise swallow the opening quote as part of a token.
  for (const match of text.matchAll(AT_QUOTED_RE)) remember((match[1] ?? '').slice(1, -1))
  for (const match of text.matchAll(AT_PLAIN_RE)) {
    const at = match.index + match[0].indexOf('@')
    if (at > 0 && AT_GLUED_BEFORE_RE.test(text.charAt(at - 1))) continue
    const token = (match[1] ?? '').replace(AT_TRAILING_PUNCTUATION_RE, '')
    remember(token)
  }
  return found
}
/**
 * Normalize one local spelling for comparison.
 *
 * Uses the native `node:path.normalize` (this plugin never patches
 * `normalize`), trims trailing separators except at a filesystem root, and
 * leaves case untouched; Windows case folding happens inside the matcher.
 *
 * @param {string} spelling - local path.
 * @returns {string} normalized spelling.
 */
export function normalizeLocalSpelling (spelling) {
  if (typeof spelling !== 'string' || spelling === '') return ''
  let normalized = nodePath.normalize(spelling)
  const root = nodePath.parse(normalized).root
  while (normalized.length > root.length && /[\\/]$/u.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

/**
 * Resolve `$DSH_HOME` the same way the rest of the plugin does.
 *
 * @param {object} options - expansion options.
 * @param {object} [options.env] - environment map.
 * @param {string} [options.home] - user's home directory.
 * @returns {string} absolute or caller-supplied DSH home.
 */
function dshHomeOf (options) {
  const env = options.env ?? process.env
  const configured = env?.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return nodePath.join(options.home ?? homedir(), '.dsh')
}

/**
 * Expand one configured prefix.
 *
 * `$DSH_HOME`, `${DSH_HOME}`, and a leading `~` are expanded. Any other
 * variable, a relative path, an `ssh://` spelling, or the whole `$DSH_HOME`
 * root is refused with a warning; nothing is guessed.
 *
 * @param {unknown} entry - one configuration entry.
 * @param {object} context - expansion context.
 * @param {string} context.dshHome - resolved DSH home.
 * @param {string} context.home - user's home directory.
 * @param {(message: string) => void} context.warn - warning sink.
 * @returns {string | undefined} normalized prefix, or undefined when refused.
 */
function expandPrefix (entry, context) {
  if (typeof entry !== 'string') {
    context.warn('localPassthrough entries must be strings; ignoring a non-string entry')
    return undefined
  }
  let value = entry.trim()
  if (value === '') {
    context.warn('localPassthrough contains an empty entry; ignoring it')
    return undefined
  }
  if (value.startsWith('~')) {
    if (value === '~') {
      value = context.home
    } else if (value.startsWith('~/') || value.startsWith('~\\')) {
      value = nodePath.join(context.home, value.slice(2))
    } else {
      context.warn(`localPassthrough: ignoring "${entry}": only a leading ~ or ~/ is supported`)
      return undefined
    }
  }
  value = value.replace(DSH_HOME_TOKEN_RE, () => context.dshHome)
  if (UNKNOWN_VAR_RE.test(value)) {
    context.warn(`localPassthrough: ignoring "${entry}": unsupported environment variable`)
    return undefined
  }
  if (!looksLocalAbsolute(value)) {
    context.warn(`localPassthrough: ignoring "${entry}": prefixes must be absolute local paths`)
    return undefined
  }
  const normalized = normalizeLocalSpelling(value)
  if (normalized === '') {
    context.warn(`localPassthrough: ignoring "${entry}": the path normalizes to empty`)
    return undefined
  }
  // The DSH home is the plugin's own configuration and secret directory. A
  // prefix equal to it would expose `dsh-ssh.json`, the SSH key, and stored
  // sessions; subdirectories such as `attachments` are the supported form.
  if (samePath(normalized, normalizeLocalSpelling(context.dshHome), context.platform)) {
    context.warn(`localPassthrough: refusing the whole DSH home "${entry}"; name a subdirectory instead`)
    return undefined
  }
  return normalized
}

/**
 * Compare two already-normalized paths under the current platform's case rules.
 *
 * @param {string} left - normalized path.
 * @param {string} right - normalized path.
 * @param {string} [platform] - platform whose case rules apply.
 * @returns {boolean} whether they name the same local path.
 */
function samePath (left, right, platform) {
  return compareSpelling(left, platform) === compareSpelling(right, platform)
}

/**
 * Case-fold only where the platform's filesystem is case-insensitive by default.
 *
 * The platform is a parameter because the matcher carries one: on this build the
 * two always agree, but a caller that pins a platform (tests, and the `@`
 * registry which is Windows-only) must get comparisons that follow that choice
 * instead of the process's.
 *
 * @param {string} spelling - normalized spelling.
 * @param {string} [platform] - platform whose case rules apply.
 * @returns {string} spelling used for comparison.
 */
function compareSpelling (spelling, platform = process.platform) {
  return platform === 'win32' ? spelling.toLowerCase() : spelling
}

/**
 * Whether a character separates path components in the platform's spelling.
 *
 * Windows accepts both separators in a path and its prefixes are written with
 * the backward one, while a matcher pinned to `win32` may run on a POSIX
 * process whose `node:path.sep` is the forward slash. Comparing on both keeps
 * a pinned matcher honest without loosening the component boundary: a sibling
 * such as `attachments2` still fails on its own character. The backward
 * separator is written as its char code so this file stays readable through
 * layers of escaping.
 *
 * @param {string} character - one character after the prefix.
 * @param {string} [platform] - platform whose separators apply.
 * @returns {boolean} whether it starts a new component.
 */
function isPathSeparator (character, platform = process.platform) {
  if (character === '/') return true
  return platform === 'win32' && character.charCodeAt(0) === 92
}

/**
 * Whether a candidate lies at or below a prefix, on a path-component boundary.
 *
 * `attachments2` must not match `attachments`, and a normalized `..` that leaves
 * the prefix must not match either. Roots (`/` or `C:\\`) are handled without
 * appending a second separator.
 *
 * @param {string} candidate - normalized candidate.
 * @param {string} prefix - normalized prefix.
 * @param {string} [platform] - platform whose case rules apply.
 * @returns {boolean} whether the candidate is inside the prefix.
 */
function isWithinPrefix (candidate, prefix, platform) {
  const left = compareSpelling(candidate, platform)
  const right = compareSpelling(prefix, platform)
  if (left === right) return true
  if (!left.startsWith(right)) return false
  // A root such as `/` or `C:\\` already ends on a boundary; appending another
  // separator there would demand `//x` and reject every real child.
  if (right !== '' && isPathSeparator(right.charAt(right.length - 1), platform)) return true
  return isPathSeparator(left.charAt(right.length), platform)
}

/**
 * Build the matcher from plugin configuration.
 *
 * @param {string | string[] | false} [value] - configured prefixes. `undefined`
 *   uses {@link DEFAULT_PASSTHROUGH}; `false` or `[]` disables passthrough.
 * @param {object} [options] - build options.
 * @param {object} [options.env] - environment map (defaults to `process.env`).
 * @param {string} [options.home] - user's home directory (defaults to `homedir()`).
 * @param {string} [options.platform] - host platform (defaults to `process.platform`).
 * @param {(message: string) => void} [options.warn] - warning sink.
 * @returns {{prefixes: string[], enabled: boolean, hostReferences: string[],
 *   matches: (spelling: unknown) => boolean, addHostReference: (spelling: unknown) => boolean}}
 *   the live matcher. `prefixes` are expanded absolute paths and are safe to
 *   log; `hostReferences` holds only paths the user explicitly named.
 */
export function buildPassthrough (value, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  let entries
  if (value === undefined) {
    entries = DEFAULT_PASSTHROUGH
  } else if (value === false) {
    entries = []
  } else if (typeof value === 'string') {
    entries = [value]
  } else if (Array.isArray(value)) {
    entries = value
  } else {
    warn('localPassthrough must be a string, an array of strings, or false; treating it as empty')
    entries = []
  }
  const dshHome = dshHomeOf(options)
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const prefixes = []
  for (const entry of entries) {
    const expanded = expandPrefix(entry, { dshHome, home, platform, warn })
    if (expanded !== undefined && !prefixes.includes(expanded)) prefixes.push(expanded)
  }
  const enabled = prefixes.length > 0
  const normalizedDshHome = normalizeLocalSpelling(dshHome)
  const hostReferences = []
  const hostReferenceKeys = new Set()
  return {
    prefixes,
    enabled,
    hostReferences,
    addHostReference (spelling) {
      // `@` mentions are only unambiguous on a Windows host: a POSIX host may
      // legitimately have a relative file named `F:\\x`, and the remote POSIX
      // world has no drive letters at all.
      if (!enabled || platform !== 'win32') return false
      if (!isWindowsHostPath(spelling)) return false
      const normalized = normalizeLocalSpelling(spelling)
      if (normalized === '') return false
      // The whole DSH home stays off even when explicitly named: it holds the
      // SSH key and stored host secrets, and @ is easy to paste from an
      // untrusted transcript. Its allowed subdirectories are still reachable
      // through the configured prefixes above.
      if (isWithinPrefix(normalized, normalizedDshHome, platform)) return false
      const key = compareSpelling(normalized, platform)
      if (hostReferenceKeys.has(key)) return false
      if (hostReferences.length >= HOST_REFERENCE_CAP) {
        const evicted = hostReferences.shift()
        hostReferenceKeys.delete(compareSpelling(evicted, platform))
      }
      hostReferenceKeys.add(key)
      hostReferences.push(normalized)
      return true
    },
    matches (spelling) {
      if (!enabled || typeof spelling !== 'string' || spelling === '') return false
      if (!looksLocalAbsolute(spelling)) return false
      const candidate = normalizeLocalSpelling(spelling)
      if (candidate === '') return false
      if (prefixes.some(prefix => isWithinPrefix(candidate, prefix, platform))) return true
      // A directory mention should make its contents readable too; applying
      // the same component-boundary test to a file's spelling is harmless
      // because `file/child` does not exist on the host.
      return hostReferences.some(reference => isWithinPrefix(candidate, reference, platform))
    },
  }
}
