/**
 * The three leaf helpers every other module can reach for.
 *
 * ## Why one file
 *
 * Each of these was its own module for a while — `lib/text.js` 25 lines,
 * `lib/options.js` 31, `lib/shell-quote.js` 23 — and each existed because of
 * the same refactor: a function implemented three or four times in different
 * files got pulled out so a bug in it could only be fixed once. That was the
 * right move; giving each extraction its own file was the step too far. A
 * 23-line module with one export costs a reader a directory entry, an import
 * line and a jump for nothing.
 *
 * They belong together because they are the same *kind* of thing: stateless,
 * dependency-free, single-expression, and called from three or more modules.
 *
 * ## The boundary, which is the only way this becomes a junk drawer
 *
 * **Only stateless, dependency-free, single-expression functions that three or
 * more modules already call.** A helper that is used by one module stays in
 * that module; a helper that needs a `ctx`, a logger, a clock or a config
 * object is not a leaf and does not belong here. If a candidate fails the
 * second condition it stays where it is, even when it looks generic.
 *
 * @module @shiqyka/dsh-ssh-workspace/shared
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

/**
 * A positive finite number, or the fallback.
 *
 * Every tuning value in this plugin comes from a JSON config file the user
 * edits by hand, so every one of them can be absent, a string, `null`, `NaN`
 * (which JSON cannot express but a JavaScript caller can), or negative. The
 * rule everywhere is the same: a value that is not usable falls back to the
 * documented default rather than being clamped into range, because clamping
 * turns a typo into a silently different policy.
 *
 * Delays and timeouts use this. Zero is rejected on purpose: a zero base delay
 * means "retry immediately", which for a reconnect loop is a busy-wait against
 * a server that just refused us.
 *
 * Two callers had byte-identical copies of this — the reconnect scheduler and
 * the watcher's retry policy — which is one copy too many for a rule that
 * decides how hard the plugin hammers a failing host.
 *
 * @param {unknown} value - the configured value.
 * @param {number} fallback - used when the value is not a positive finite number.
 * @returns {number} the effective value.
 */
export function positive (value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The one POSIX single-quoting implementation.
 *
 * Every remote command this plugin builds is assembled by string concatenation
 * and then handed to a shell on the far side of an SSH connection, so a value
 * that is not quoted is not "a path", it is shell source. This was implemented
 * four times before (in `engine.js`, `shell.js`, `patch-terminal.js` and, in
 * effect, wherever a caller inlined the same expression); a single copy means a
 * quoting bug can only be fixed once.
 *
 * The rule: wrap in single quotes, and close-reopen around each embedded single
 * quote. Single quotes are the only POSIX quoting form with no escape character
 * at all, which is why the literal `'` has to be spelled `'\''` — that is
 * `'…'` + `\'` + `'…'`, three tokens that the shell concatenates back into one
 * word. Nothing inside the quotes is interpreted: `$`, backticks, `\`, `;`,
 * newlines and globs are all literal.
 *
 * @param {unknown} value - anything; it is stringified with `String`.
 * @returns {string} a single shell word, safe to concatenate into a command.
 */
export function shellQuote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
