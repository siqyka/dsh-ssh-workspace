/**
 * One reader for the SHAPE of an OpenSSH config file — where a block starts,
 * what it declares, and where it ends — shared by every consumer.
 *
 * ## Why this exists
 *
 * Three separate scanners used to walk `~/.ssh/config`: one for identity
 * keywords, one for proxy transport, one for the audit. They agreed on `Host`
 * and DISAGREED on everything else, and the disagreement was not academic:
 *
 *  - A `Match` line only reset `inBlock` / `applies` in none of them. Each
 *    scanner kept the previous `Host` block's selection state and went on
 *    collecting the `Match` body as if it belonged to that host. `Match host db`
 *    after `Host web` therefore handed `web` the `User`, `Port` and
 *    `IdentityFile` written for `db` — the host name stayed right while the
 *    credentials came from another machine — and a `ProxyJump none` in that body
 *    silently cancelled the `Host *` bastion that should have refused the host.
 *  - The audit walked the same lines with its own copy of the matching rule, so
 *    "supported" was decided by a global keyword set rather than by "did the
 *    resolver actually adopt this line".
 *
 * The fix for both is not a bigger parser: it is ONE section boundary that every
 * consumer reads, so "which block is this line in" has a single answer.
 *
 * ## The rules encoded here
 *
 *  - A `Host` or `Match` line starts a new section. Nothing else does.
 *  - `Match` sections are not evaluated (that is a documented limitation), so
 *    their bodies belong to NO host. They are still returned, as their own
 *    section kind, so a consumer can report them instead of silently absorbing
 *    them into the previous block.
 *  - Lines before the first `Host` / `Match` form a `top` section that selects
 *    no host. (OpenSSH would apply them globally; this plugin has never done
 *    that, and changing it is F-10, not this fix.)
 *  - A line that does not look like `keyword value` (a bare keyword, a stray
 *    brace) is not an entry. The keyword charset is `[A-Za-z][A-Za-z0-9]*`,
 *    which is why a hyphenated spelling such as `strict-host-key-checking` can
 *    never appear as an entry — a fact the vocabulary test pins.
 *
 * @module @shiqyka/dsh-ssh-workspace/ssh-config
 */

/** A config line that declares a keyword. Group 1: keyword, group 2: value. */
export const CONFIG_LINE = /^([A-Za-z][A-Za-z0-9]*)[\s=]+(.+)$/u

import { matchSelects } from './match-eval.js'

/**
 * One entry inside a section.
 *
 * @typedef {object} ConfigEntry
 * @property {string} keyword - lowercase keyword.
 * @property {string} value - trimmed value.
 */

/**
 * One `Host` / `Match` block, or the lines before the first one.
 *
 * @typedef {object} ConfigSection
 * @property {'top'|'host'|'match'} kind - what started it.
 * @property {string[]} patterns - the `Host` / `Match` arguments, in order.
 * @property {ConfigEntry[]} entries - the block body, in file order.
 */

/**
 * Split a config file into sections.
 *
 * @param {string} text - the config file contents.
 * @returns {ConfigSection[]} sections in file order, `top` first.
 */
export function sectionsOf (text) {
  /** @type {ConfigSection} */
  let current = { kind: 'top', patterns: [], entries: [] }
  const sections = [current]
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = CONFIG_LINE.exec(line)
    if (match === null) continue
    const keyword = match[1].toLowerCase()
    if (keyword === 'host' || keyword === 'match') {
      // A new section. `Match` bodies are NOT appended to the previous `Host`,
      // which is the whole point: their settings belong to no host here.
      current = { kind: keyword, patterns: match[2].trim().split(/\s+/u).filter(Boolean), entries: [] }
      sections.push(current)
      continue
    }
    current.entries.push({ keyword, value: match[2].trim() })
  }
  return sections
}

/**
 * Does one `Host` pattern select this alias?
 *
 * OpenSSH matches `Host` arguments as globs, so `Host *` applies to every host
 * in the file. Only `*` and `?` are honoured; a `!` prefix is a negation and is
 * handled by {@link selects}.
 *
 * @param {string} pattern - one pattern.
 * @param {string} alias - the alias being resolved.
 * @returns {boolean} whether the pattern selects the alias.
 */
export function patternMatches (pattern, alias) {
  const source = pattern
    .split('*').map(part => part.split('?').map(escapeRegExp).join('.')).join('.*')
  return new RegExp(`^${source}$`, 'u').test(alias)
}

/**
 * Does a `Host` section select this alias, negations included?
 *
 * The rule OpenSSH uses: any positive pattern matches AND no `!pattern` does.
 *
 * @param {ConfigSection} section - a `host` section.
 * @param {string} alias - the alias being resolved.
 * @returns {boolean} whether the section selects the alias.
 */
export function selects (section, alias) {
  // A `Match` section is evaluated, not ignored. Ignoring it was safe but made
  // the construct useless: a configuration organised with `Match host` was read
  // as if every Match body applied to nobody, which for `Host`-only files is
  // the same answer and for real ones is wrong in the SILENT direction.
  //
  // `matchSelects` decides the subset: `host` / `originalhost` / `all` are
  // evaluated; `exec` is refused (it would run a local command from a file that
  // can arrive from a repository); everything that needs a live connection
  // selects nobody and reports why. That last default is the safety property —
  // an undecided conjunction is never true.
  if (section.kind === 'match') return matchSelects(section.patterns, alias).selects
  if (section.kind !== 'host') return false
  const positive = section.patterns.filter(pattern => !pattern.startsWith('!'))
  const negative = section.patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  return positive.some(pattern => patternMatches(pattern, alias)) &&
    !negative.some(pattern => patternMatches(pattern, alias))
}

/**
 * Why a `Match` section selected nobody, when it is worth saying.
 *
 * The audit needs this: "this block did not apply" is normal, and "I could not
 * decide whether it applies" is a fact the user has to see, because the settings
 * inside it silently did nothing.
 *
 * @param {ConfigSection} section - a section.
 * @param {string} alias - the alias being resolved.
 * @returns {{undecidable?: string, refused?: string}|undefined} the reason, if any.
 */
export function matchLimitation (section, alias) {
  if (section.kind !== 'match') return undefined
  const verdict = matchSelects(section.patterns, alias)
  if (verdict.undecidable === undefined && verdict.refused === undefined) return undefined
  return { ...(verdict.undecidable === undefined ? {} : { undecidable: verdict.undecidable }), ...(verdict.refused === undefined ? {} : { refused: verdict.refused }) }
}

/**
 * Is this section an EXACT declaration of the alias?
 *
 * The resolver reads identity keywords only from a block that names the alias
 * literally, never through a wildcard. That is a deliberate subset of OpenSSH,
 * and the audit has to report what it costs rather than call the line
 * "supported" — so the distinction lives here, next to the section rule, and
 * both consumers read the same answer.
 *
 * @param {ConfigSection} section - a section.
 * @param {string} alias - the alias being resolved.
 * @returns {boolean} true when a pattern is literally the alias.
 */
export function isExact (section, alias) {
  return section.kind === 'host' && section.patterns.includes(alias)
}

/** Escape a literal for embedding in a RegExp source. */
function escapeRegExp (text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
