/**
 * Text helpers shared across modules.
 *
 * @module @shiqyka/dsh-ssh-workspace/text
 */

/**
 * Escape a literal for embedding in a RegExp source.
 *
 * Three modules had this, character for character, because three places build
 * a pattern out of user-controlled text: the `Include` glob expander, the
 * shell's completion marker, and the `Host` / `Match` pattern matcher. The
 * character class below is the standard one — every character that means
 * something to a RegExp parser outside a character class, plus the backslash.
 *
 * The `u` flag is on the class so that the pattern itself is validated as a
 * Unicode pattern; it does not change which characters are matched, and it
 * cannot, because the class is ASCII-only.
 *
 * @param {string} value - the literal text.
 * @returns {string} the same text, safe to interpolate into a RegExp source.
 */
export function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
