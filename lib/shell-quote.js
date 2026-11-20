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
