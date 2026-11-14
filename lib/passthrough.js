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
 * An explicit scheme (`local:/abs/path`, name configurable) is the second door.
 * It is still strictly unlocked: a scheme spelling answers locally only when its
 * path is inside a configured prefix or was named by the user WITH that scheme.
 * A spelling nobody authorized is refused by the caller with a loud error
 * instead of being quietly rewritten, so a model cannot widen its own reach by
 * typing a scheme. The scheme never unlocks the bare spelling of the same path
 * (`@local:/a/b` does not make `/a/b` local).
 *
 * The only existence-dependent decision here is the opt-in
 * `remoteMissFallback`. With it ON, a bare POSIX path the user named with `@` is
 * read from the host after the REMOTE filesystem reports it missing. The
 * tradeoff is real — the same spelling can answer from a different world once
 * the remote file disappears, and a deleted remote file silently becomes the
 * host's file — which is why it is off by default, why only READ verbs consult
 * it, and why every fallbacked text read says so in its own output.
 *
 * @module @shiqyka/dsh-ssh-workspace/passthrough
 */

import nodePath from 'node:path'
import { homedir } from 'node:os'

/** Prefixes that are local to this machine by default. */
export const DEFAULT_PASSTHROUGH = ['$DSH_HOME/attachments', '$DSH_HOME/plugins']

/**
 * The scheme used when the user has not configured one.
 *
 * Only ONE scheme is accepted at a time, and it comes from settings. `file:` is
 * not built in on purpose: a second spelling would be a second truth about
 * which paths are local, and a user who wants `file:` can name it.
 */
export const DEFAULT_LOCAL_SCHEME = 'local'

/** Upper bound on remembered @ host references; old ones are evicted first. */
const HOST_REFERENCE_CAP = 256

/**
 * Scheme names that can never be the local scheme, each with the reason it is
 * taken.
 *
 * This table is the ONE record of the names in use: `normalizeScheme` refuses
 * from it, the status route hands it to the panel, and the tests iterate it, so
 * a new name is one row here rather than an edit in three places. Matching
 * happens after `trim().toLowerCase()`, which is why `FILE`, `File` and
 * ` file ` are all refused by the same entry.
 *
 * `reason` is quoted in the refusal text, so it must say WHY the name is taken
 * in terms a user can act on — "reserved" alone leaves them guessing.
 *
 * @type {ReadonlyArray<{name: string, group: string, reason: string}>}
 */
export const SCHEMES_IN_USE = Object.freeze([
  {
    name: 'ssh',
    group: 'remote syntax',
    // Not merely "taken": `ssh://` is classified before any local prefix is
    // considered, so accepting it would make the setting a silent no-op.
    reason: 'it is the remote workspace scheme and is classified before a local prefix is even considered',
  },
  {
    name: 'file',
    group: 'emitted by this plugin',
    // `formatRemoteFileUrl` writes `file:///srv/x` for a REMOTE path. If `file:`
    // were the local prefix, the same spelling would be read on this machine
    // while the tree shows it as remote — one spelling in two meanings.
    reason: 'this plugin writes file:/// URIs for remote paths, so the same spelling would mean two different machines',
  },
  {
    name: 'sftp',
    group: 'emitted by this plugin',
    // The most natural way for a user to spell a remote path. Stripping it
    // leaves `host` as the first path segment and quietly names a local
    // directory that may well exist.
    reason: 'sftp://host/path is the natural way to spell a remote path, and stripping it would silently name a local directory',
  },
  {
    name: 'dsh-app',
    group: 'emitted by this plugin',
    // The desktop shell's origin (`dsh-app://app/…`); stripped it becomes
    // `/app/…`, which can genuinely exist.
    reason: 'it is the desktop shell origin, and stripping it would leave /app/… as a real local path',
  },
  {
    name: 'http',
    group: 'URL scheme',
    reason: 'it is the scheme forwarded addresses and intranet services are written with',
  },
  {
    name: 'https',
    group: 'URL scheme',
    reason: 'it is the scheme every web address is written with',
  },
  {
    name: 'ws',
    group: 'URL scheme',
    reason: 'it is the scheme a WebSocket endpoint is written with',
  },
  {
    name: 'wss',
    group: 'URL scheme',
    reason: 'it is the scheme a secure WebSocket endpoint is written with',
  },
  {
    name: 'data',
    group: 'browser semantics',
    reason: 'it is a browser data URI and has no path after the scheme',
  },
  {
    name: 'blob',
    group: 'browser semantics',
    reason: 'it is a browser object URL and names nothing on disk',
  },
  {
    name: 'about',
    group: 'browser semantics',
    reason: 'it is a browser-internal scheme and names nothing on disk',
  },
  {
    name: 'javascript',
    group: 'browser semantics',
    // Security-adjacent: a scheme that executes must never be configurable
    // into a path prefix that the panel then prints back to the user.
    reason: 'it executes code in a browser and must never be claimed by a path setting',
  },
  {
    name: 'mailto',
    group: 'browser semantics',
    reason: 'it addresses a mail recipient, not a path',
  },
])

/** The names in {@link SCHEMES_IN_USE}, kept as a set for the hot refusal path. */
const RESERVED_SCHEMES = new Set(SCHEMES_IN_USE.map(entry => entry.name))

/**
 * How many characters a local prefix needs.
 *
 * Three, because the shortest spelling anyone reaches for by accident is a
 * Windows drive letter: `c:` is one character and `parseLocalScheme('c:/x','c')`
 * would strip it to `/x`, competing with `C:\\` for the same text. Two
 * characters (`ab:/x`) still read like a device name. At three, a drive letter
 * cannot match the syntax at all, so the collision is removed rather than
 * documented.
 */
export const MIN_SCHEME_LENGTH = 3

/**
 * RFC 3986 scheme syntax, published as a source string so the panel can build
 * the same expression instead of hardcoding a second copy of the rule.
 */
export const SCHEME_NAME_PATTERN = '^[a-z][a-z0-9+.-]*$'

/** A legal scheme name, lowercased at the door. */
const SCHEME_NAME_RE = new RegExp(SCHEME_NAME_PATTERN, 'u')

/**
 * A scheme-shaped token, matched only after a plain local shape has failed.
 *
 * The drive-letter form `C:\x` also fits this pattern (name `C`), which is why
 * the plain check runs first: a Windows absolute path is never a scheme.
 */
const SCHEME_TOKEN_RE = /^([A-Za-z][A-Za-z0-9+.-]*):(\/{0,3})([\s\S]*)$/u

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
 * Whether a spelling is an absolute path of the platform that has no drive
 * letters: a POSIX absolute that is not a Windows shape.
 *
 * Kept separate from {@link looksLocalAbsolute} because the two answer
 * different questions. That one asks "could this only mean the host machine?",
 * which is true of all three shapes on every platform; this one asks "is this
 * spelling at home on a POSIX host?", which is what decides whether a bare
 * `@/Volumes/…` mention is a reference at all.
 *
 * @param {unknown} spelling - candidate path.
 * @returns {boolean} true for a POSIX absolute path.
 */
export function isPosixHostPath (spelling) {
  return typeof spelling === 'string' && spelling !== '' && POSIX_ABSOLUTE_RE.test(spelling) && !spelling.startsWith('ssh://')
}

/**
 * Extract host paths the user explicitly addressed with `@` in one message.
 *
 * The Host's file-reference grammar inserts these as ordinary prompt text, so
 * this is the only place the `@` intent survives. Which spellings count is a
 * platform question, because the same text means different things on either
 * side of the fence:
 *
 * - on a Windows host, drive and UNC absolute paths are host references, while
 *   `@src/a.js` and `@/tmp/x` stay workspace or remote references;
 * - on a POSIX host, a POSIX absolute such as `@/Volumes/SSD/x.md` is the
 *   symmetric case, and a drive letter is meaningless there.
 *
 * Either way a reference only makes the path a CANDIDATE: on a POSIX host a bare
 * `@/…` mention is still read remotely first (see `remoteMissFallback`), because
 * `/tmp/x` is a real path in both worlds and the remote meaning is the one a
 * remote session promises.
 *
 * @param {unknown} text - one user message's text.
 * @param {object} [options] - extraction options.
 * @param {string} [options.platform] - host platform (defaults to the process's).
 * @param {string} [options.scheme] - the local scheme name (defaults to
 *   {@link DEFAULT_LOCAL_SCHEME}); a mention written with it is returned as
 *   typed, so the caller can tell the two doors apart.
 * @returns {string[]} host-path spellings, deduplicated in message order.
 */
export function hostReferencePathsInText (text, options = {}) {
  const platform = options.platform ?? process.platform
  const scheme = normalizeScheme(options.scheme) ?? DEFAULT_LOCAL_SCHEME
  const accepts = platform === 'win32' ? isWindowsHostPath : isPosixHostPath
  const acceptsEither = spelling => parseLocalScheme(spelling, scheme) !== undefined || accepts(spelling)
  if (typeof text !== 'string' || text === '') return []
  const found = []
  const seen = new Set()
  const remember = (raw) => {
    // A mention pasted from a directory listing often ends on the separator;
    // dropping it canonicalizes the spelling without changing what it names.
    const spelling = raw.trim().replace(/[\\/]+$/u, '')
    if (!acceptsEither(spelling)) return
    const key = platform === 'win32' ? spelling.toUpperCase() : spelling
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
 * Darwin is deliberately NOT folded, and that is a decision rather than an
 * omission. APFS is case-insensitive by default, so `@/Volumes/SSD/x.md` named
 * and then read as `/volumes/ssd/x.md` misses the fallback even though the file
 * exists. Folding there would fix that symptom and open a worse one: the same
 * code would let `/Volumes/SSD` authorize `/Volumes/ssd` on the case-SENSITIVE
 * volume a user may have formatted, which is a false pass-through instead of a
 * missing one. The failure direction here is "read did not happen, and the
 * message says to spell it with `local:`" — fail closed. Changing this needs a
 * real case-sensitivity probe, not a platform guess.
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
 * Decide whether one configured scheme name is usable, and why not when it is
 * not.
 *
 * The single place a scheme is accepted: the store, the route and the matcher
 * all call `normalizeScheme`, which is this function with the detail dropped —
 * so a name that is legal in the panel is legal everywhere, and the panel can
 * show the same reason the server would have thrown.
 *
 * The order of the tests is deliberate:
 *
 * 1. non-string / empty / syntax first, so `"!!"` reports "not a scheme" rather
 *    than "too short" (a length-first check would mask the real mistake);
 * 2. length next, so `"c"` reports "too short" — the structural reason it is
 *    refused — instead of "reserved", which would send the user looking at the
 *    reserved list for a name that is not on it;
 * 3. reserved names last, because that is the only test that needs the tables.
 *
 * @param {unknown} value - candidate scheme name.
 * @returns {{ok: true, scheme: string}
 *   | {ok: false, code: 'not-a-string'|'empty'|'invalid-syntax'|'too-short'|'reserved', message: string, name?: string}}
 *   the verdict; `name` is only set for a reserved name.
 */
export function schemeRefusal (value) {
  if (typeof value !== 'string') {
    return { ok: false, code: 'not-a-string', message: 'a scheme name must be a string' }
  }
  const candidate = value.trim().toLowerCase()
  if (candidate === '') return { ok: false, code: 'empty', message: 'a scheme name cannot be empty' }
  if (!SCHEME_NAME_RE.test(candidate)) {
    return {
      ok: false,
      code: 'invalid-syntax',
      message: 'only lowercase letters, digits and "+", "-", "." are allowed, and it must start with a letter',
    }
  }
  if (candidate.length < MIN_SCHEME_LENGTH) {
    return {
      ok: false,
      code: 'too-short',
      message: `at least ${MIN_SCHEME_LENGTH} characters are required (one character would collide with a Windows drive letter such as c:/x)`,
    }
  }
  if (RESERVED_SCHEMES.has(candidate)) {
    const entry = SCHEMES_IN_USE.find(item => item.name === candidate)
    return {
      ok: false,
      code: 'reserved',
      name: candidate,
      message: `"${candidate}" is already in use: ${entry.reason}`,
    }
  }
  return { ok: true, scheme: candidate }
}

/**
 * Validate one configured scheme name.
 *
 * A thin wrapper over {@link schemeRefusal} so the existing call sites keep
 * their `string | undefined` contract; every rule lives in one place.
 *
 * @param {unknown} value - candidate scheme name.
 * @returns {string | undefined} the lowercased name, or undefined when refused.
 */
export function normalizeScheme (value) {
  const refusal = schemeRefusal(value)
  return refusal.ok ? refusal.scheme : undefined
}

/**
 * The rules the panel needs to explain a refusal BEFORE it round-trips.
 *
 * Derived from the tables above rather than copied into the bundle: a second
 * description of what a scheme may be is a second truth, and the panel would
 * then reject names the server accepts (or the reverse).
 *
 * @param {string} [platform] - host platform whose path rule is published.
 * @returns {{minLength: number, pattern: string, caseInsensitiveName: boolean,
 *   caseInsensitivePath: boolean, reserved: ReadonlyArray<object>}} the rules.
 */
export function schemeRules (platform = process.platform) {
  return {
    minLength: MIN_SCHEME_LENGTH,
    pattern: SCHEME_NAME_PATTERN,
    // The scheme NAME is always folded (`Local:` is `local:` — see
    // `normalizeScheme`); the PATH behind it follows the platform, exactly as
    // `compareSpelling` does.
    caseInsensitiveName: true,
    caseInsensitivePath: platform === 'win32',
    reserved: SCHEMES_IN_USE,
  }
}

/**
 * Strip the local scheme from a spelling, if it has one.
 *
 * Accepted shapes are `<scheme>:<path>`, `<scheme>:/<path>`, and up to three
 * slashes (`file:`-style `scheme:///abs/path` is what most people type). The
 * scheme name is matched case-insensitively; the remainder must then look like
 * a local absolute path, otherwise this returns undefined and the spelling keeps
 * whatever meaning it had. No percent-decoding happens: a path with a space is
 * written with `@"..."` like every other mention.
 *
 * @param {unknown} spelling - the caller's path.
 * @param {unknown} scheme - the configured scheme name.
 * @returns {string | undefined} the local spelling, or undefined when this is not a scheme spelling.
 */
export function parseLocalScheme (spelling, scheme = DEFAULT_LOCAL_SCHEME) {
  if (typeof spelling !== 'string') return undefined
  const name = normalizeScheme(scheme) ?? DEFAULT_LOCAL_SCHEME
  if (spelling.length <= name.length || spelling.charAt(name.length) !== ':') return undefined
  if (spelling.slice(0, name.length).toLowerCase() !== name) return undefined
  let rest = spelling.slice(name.length + 1)
  let slashes = 0
  while (slashes < 3 && rest.charAt(slashes) === '/') slashes += 1
  rest = rest.slice(slashes)
  // One separator belongs to the scheme (`local:/x`); additional slashes are the
  // `file:///` habit. A drive letter or UNC that follows them is not a child of
  // `/`, so it keeps its own spelling instead of gaining a leading slash that
  // Windows `path.normalize` would later turn into `\F:\...`.
  if (slashes > 0 && !DRIVE_ABSOLUTE_RE.test(rest) && !UNC_ABSOLUTE_RE.test(rest)) rest = `/${rest}`
  return looksLocalAbsolute(rest) ? rest : undefined
}

/**
 * Build the matcher from plugin configuration.
 *
 * The matcher answers three separate questions, and keeping them apart is what
 * makes the two doors safe:
 *
 * - {@link matches} — "should this call go to the HOST backend right now?" True
 *   only for a configured prefix, a Windows drive/UNC path the user named with
 *   `@`, or a scheme spelling whose path the user authorized.
 * - {@link isNamed} — "did the user point at this path at all?" Covers every
 *   door, including a bare POSIX `@` mention that is still read remotely first.
 * - {@link localSpelling} — the host path to hand to the local backend, or
 *   undefined when the call is not a passthrough.
 *
 * @param {string | string[] | false} [value] - configured prefixes. `undefined`
 *   uses {@link DEFAULT_PASSTHROUGH}; `false` or `[]` disables passthrough.
 * @param {object} [options] - build options.
 * @param {object} [options.env] - environment map (defaults to `process.env`).
 * @param {string} [options.home] - user's home directory (defaults to `homedir()`).
 * @param {string} [options.platform] - host platform (defaults to `process.platform`).
 * @param {string} [options.scheme] - local scheme name (defaults to `local`).
 * @param {boolean} [options.remoteMissFallback] - read the host copy after a remote miss.
 * @param {(message: string) => void} [options.warn] - warning sink.
 * @returns {object} the live matcher.
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

  // Live settings. `configure` is the only writer after construction, and it
  // validates before it assigns, so a caller can never observe a half-applied
  // pair (a new scheme with the old fallback flag or the reverse).
  //
  // The configured default goes through the same refusal as everything else: a
  // profile row written by an older build (or by hand) may name `file` or `c`,
  // and silently USING it would hand the panel a prefix it cannot spell. The
  // fallback to `local` is announced through `warn` so a deployment cannot drift
  // into a scheme nobody noticed being replaced.
  let schemeName = DEFAULT_LOCAL_SCHEME
  if (options.scheme !== undefined) {
    const configured = normalizeScheme(options.scheme)
    if (configured === undefined) {
      warn(`localPassthrough: refusing configured scheme ${JSON.stringify(options.scheme)}; using "${DEFAULT_LOCAL_SCHEME}"`)
    } else {
      schemeName = configured
    }
  }
  let missFallback = options.remoteMissFallback === true

  // One table, one eviction order, and one extra bit per entry: HOW the user
  // named the path. That bit is what keeps the two doors apart. A bare Windows
  // drive mention already reads locally (it cannot be a remote path), while a
  // scheme mention is an explicit declaration about THIS spelling and must not
  // spill onto the bare one — `local:/etc/passwd` may not turn a later plain
  // `/etc/passwd` into a host read.
  const references = []
  const referenceKeys = new Set()
  const tableOf = (spelling, viaScheme) => {
    const normalized = normalizeLocalSpelling(spelling)
    if (normalized === '') return undefined
    if (isWithinPrefix(normalized, normalizedDshHome, platform)) return undefined
    const key = compareSpelling(normalized, platform)
    const existing = references.find(entry => entry.key === key)
    if (existing !== undefined) {
      // A bare mention of a path only named through the scheme upgrades the
      // entry: the user has now said the plain spelling too.
      if (existing.viaScheme && !viaScheme) existing.viaScheme = false
      return undefined
    }
    if (references.length >= HOST_REFERENCE_CAP) {
      const evicted = references.shift()
      referenceKeys.delete(evicted.key)
    }
    const entry = { key, spelling: normalized, viaScheme }
    references.push(entry)
    referenceKeys.add(key)
    return entry
  }
  const withinAny = (candidate, list) => list.some(entry => isWithinPrefix(candidate, entry.spelling, platform))
  /** Whether a candidate is covered by an entry the user named BARE. */
  const withinBare = candidate =>
    references.some(entry => entry.viaScheme !== true && isWithinPrefix(candidate, entry.spelling, platform))

  /** The host path a spelling names under the current platform's rules. */
  const localOf = (spelling) => {
    const parsed = parseLocalScheme(spelling, schemeName)
    if (parsed !== undefined) return parsed
    if (typeof spelling !== 'string' || spelling === '') return undefined
    if (platform === 'win32' ? !isWindowsHostPath(spelling) : !isPosixHostPath(spelling)) return undefined
    return spelling
  }

  const matcher = {
    prefixes,
    enabled,
    /** The bare door: Windows drive/UNC paths the user named with @. */
    get hostReferences () {
      return references.map(entry => entry.spelling)
    },
    /** The live scheme name. */
    get scheme () {
      return schemeName
    },
    /**
     * The platform whose path rules this matcher was built for.
     *
     * Exposed so the `@` extractor can apply the same rule the matcher does
     * instead of re-reading `process.platform`: a matcher pinned to another
     * platform (tests, and any future cross-host use) would otherwise accept a
     * mention it then refuses to route.
     */
    get platform () {
      return platform
    },
    /** Whether a remote miss may be retried against the host copy. */
    get remoteMissFallback () {
      return missFallback
    },
    /**
     * Record one `@` mention.
     *
     * The platform decides which bare spelling counts as a host path, because
     * the same text means different things on either side of the fence: a
     * POSIX host may have a relative file literally named `F:\\x`, and the
     * remote POSIX world has no drive letters at all. A scheme mention is
     * accepted on either platform — it carries its own intent.
     *
     * @param {unknown} spelling - the mention as the user typed it.
     * @returns {boolean} whether a new reference was recorded.
     */
    addHostReference (spelling) {
      if (!enabled || typeof spelling !== 'string' || spelling === '') return false
      const schemeSpelling = parseLocalScheme(spelling, schemeName)
      if (schemeSpelling !== undefined) return tableOf(schemeSpelling, true) !== undefined
      const accepted = platform === 'win32' ? isWindowsHostPath(spelling) : isPosixHostPath(spelling)
      if (!accepted) return false
      return tableOf(spelling, false) !== undefined
    },
    /**
     * Decide whether one call goes to the host backend.
     *
     * @param {unknown} spelling - the caller's path.
     * @returns {boolean} true when the local backend should answer.
     */
    matches (spelling) {
      if (!enabled || typeof spelling !== 'string' || spelling === '') return false
      const stripped = parseLocalScheme(spelling, schemeName)
      if (stripped !== undefined) {
        // The scheme door: authorized by a configured prefix, or by the user
        // having named this path with the scheme. A bare mention of the same
        // path never widens this in the other direction — see below.
        const candidate = normalizeLocalSpelling(stripped)
        if (candidate === '') return false
        if (prefixes.some(prefix => isWithinPrefix(candidate, prefix, platform))) return true
        return withinAny(candidate, references)
      }
      if (!looksLocalAbsolute(spelling)) return false
      const candidate = normalizeLocalSpelling(spelling)
      if (candidate === '') return false
      if (prefixes.some(prefix => isWithinPrefix(candidate, prefix, platform))) return true
      // The bare door answers only for the spelling family the platform treats
      // as unambiguous host evidence (drive/UNC on Windows). A bare POSIX path
      // is never local-on-sight even after a mention: it stays remote until the
      // remote miss fallback says otherwise.
      if (platform !== 'win32' || !isWindowsHostPath(spelling)) return false
      // ...and only what the user named BARE. A `local:F:\x` mention is a
      // declaration about that spelling, not a grant that turns a later plain
      // `F:\x` (or a plain `/etc/passwd`, via the scheme-stripped form) into a
      // host read.
      return withinBare(candidate)
    },
    /**
     * Whether the user pointed at this path at all, through any door.
     *
     * This is the ONLY gate the remote-miss fallback accepts: without it a
     * `read('/etc/passwd')` that missed remotely would probe the host, which is
     * exactly the self-authorization the lexical rule exists to prevent.
     *
     * @param {unknown} spelling - the caller's path.
     * @returns {boolean} true when the path was named by config or by the user.
     */
    isNamed (spelling) {
      if (!enabled || typeof spelling !== 'string' || spelling === '') return false
      // A scheme spelling naming an unauthorized path is not "named": the user
      // never pointed at it, they typed a prefix they were not granted.
      const candidate = normalizeLocalSpelling(localOf(spelling) ?? spelling)
      if (candidate === '') return false
      if (prefixes.some(prefix => isWithinPrefix(candidate, prefix, platform))) return true
      return withinAny(candidate, references)
    },
    /**
     * The host spelling to hand to the local backend, or undefined.
     *
     * A scheme spelling is stripped, so the backend never sees `local:`; a bare
     * reference is returned as typed.
     *
     * @param {unknown} spelling - the caller's path.
     * @returns {string | undefined} the local path, or undefined.
     */
    localSpelling (spelling) {
      if (matcher.matches(spelling) !== true) return undefined
      return parseLocalScheme(spelling, schemeName) ?? spelling
    },
    /**
     * Whether this spelling is written with the local scheme at all.
     *
     * Lets a caller tell "not a scheme spelling" (keep the remote meaning) from
     * "a scheme spelling nobody authorized" (refuse loudly instead of quietly
     * rewriting it into a remote path the caller never asked for).
     *
     * @param {unknown} spelling - the caller's path.
     * @returns {boolean} true when the spelling carries the scheme.
     */
    isSchemeSpelling (spelling) {
      return parseLocalScheme(spelling, schemeName) !== undefined
    },
    /**
     * Apply the settings the panel saved.
     *
     * Both values are validated before either is stored, so the three seams
     * never see a scheme from one setting and a flag from another. An invalid
     * scheme falls back to the default rather than keeping a value that no
     * longer parses.
     *
     * @param {object} patch - the new values.
     * @param {unknown} [patch.scheme] - scheme name.
     * @param {unknown} [patch.remoteMissFallback] - fallback flag.
     * @returns {{scheme: string, remoteMissFallback: boolean}} the applied settings.
     */
    configure (patch = {}) {
      const requested = patch?.scheme === undefined ? schemeName : normalizeScheme(patch.scheme)
      const nextScheme = requested ?? DEFAULT_LOCAL_SCHEME
      if (patch?.scheme !== undefined && requested === undefined) {
        warn(`localPassthrough: refusing scheme ${JSON.stringify(patch.scheme)}; falling back to "${DEFAULT_LOCAL_SCHEME}"`)
      }
      const nextFallback = patch?.remoteMissFallback === undefined ? missFallback : patch.remoteMissFallback === true
      schemeName = nextScheme
      missFallback = nextFallback
      return { scheme: schemeName, remoteMissFallback: missFallback }
    },
  }
  return matcher
}
