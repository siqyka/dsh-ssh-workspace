/**
 * Reconstruct what was TYPED into a remote terminal.
 *
 * A PTY carries bytes in both directions, and the harness only shows them. The
 * audit records commands it issued itself, so without this a user's terminal work
 * — the one channel where a person types arbitrary commands — would be the only
 * activity with no record at all.
 *
 * This is a **best-effort approximation**, and it is deliberately simple, because
 * the alternative is an emulator. It sees keystrokes, not the remote shell's
 * line editor: arrow keys, tab completion, history expansion and a paste of a
 * here-document all produce input that does not equal the command that ran. What
 * it does reproduce well is the ordinary case the audit exists for — someone
 * types a command and presses Enter.
 *
 * The rules:
 *
 *  - printable characters accumulate;
 *  - Backspace and Ctrl-U remove from the buffer;
 *  - Ctrl-C abandons the line (nothing ran);
 *  - Enter commits the trimmed line when it is non-empty;
 *  - any other control byte is ignored, so arrow keys cannot inject `^[[A` into
 *    a recorded command.
 *
 * Nothing here may throw or block: it runs inside `write()`, on the path every
 * keystroke takes.
 */

/** Longest line kept; a paste that would be longer is truncated, not dropped. */
export const TYPED_LINE_CHARS = 400

/** Bytes that end a line. A terminal sends CR; a paste may carry both. */
const ENTER = new Set(['\r', '\n'])

/** Bytes that remove the previous character. */
const BACKSPACE = new Set(['\u007f', '\b'])

/** Ctrl-U: the line editor's "delete everything before the cursor". */
const KILL_LINE = '\u0015'

/** Ctrl-C: abandon this line; nothing about it will run. */
const INTERRUPT = '\u0003'

/** Escape: the start of a sequence (arrows, function keys), not a character. */
const ESCAPE = '\u001b'

/**
 * One terminal's line buffer.
 */
export class TerminalTyping {
  /**
   * @param {object} options
   * @param {(line: string) => void} options.onCommit - called with one finished line.
   */
  constructor (options) {
    this.onCommit = options?.onCommit
    this.buffer = ''
    /**
     * Escape-sequence state: 0 = typing, 1 = just saw ESC, 2 = inside a CSI/SS3
     * sequence, 3 = inside an OSC string.
     *
     * A byte-at-a-time machine rather than "skip until a non-parameter": the
     * bracketed introducer `[` is itself in the 0x40–0x7E range a final byte
     * comes from, so a rule based on ranges alone ends the sequence on the `[`
     * and types the `A` of an arrow key into the command.
     */
    this.escape = 0
  }

  /**
   * Feed one chunk of input bytes.
   *
   * @param {Buffer|string} chunk - raw terminal input.
   */
  feed (chunk) {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
      for (const char of text) this.#char(char)
    } catch { /* capture never fails the keystroke it describes */ }
  }

  #char (char) {
    if (this.escape !== 0) {
      if (this.escape === 1) {
        if (char === '\u001b') return
        if (char === '[' || char === 'O') { this.escape = 2; return }
        if (char === ']') { this.escape = 3; return }
        this.escape = 0
        return
      }
      if (this.escape === 2) {
        const code = char.charCodeAt(0)
        if (code >= 0x40 && code <= 0x7e) this.escape = 0
        return
      }
      // OSC: runs until BEL, or until ST (ESC then anything).
      if (char === '\u0007') { this.escape = 0; return }
      if (char === '\u001b') { this.escape = 1; return }
      return
    }
    if (char === ESCAPE) {
      this.escape = 1
      return
    }
    if (ENTER.has(char)) {
      const line = this.buffer.trim()
      this.buffer = ''
      if (line !== '' && typeof this.onCommit === 'function') {
        try { this.onCommit(line.slice(0, TYPED_LINE_CHARS)) } catch { /* a log error is not a keystroke error */ }
      }
      return
    }
    if (BACKSPACE.has(char)) {
      this.buffer = this.buffer.slice(0, -1)
      return
    }
    if (char === KILL_LINE || char === INTERRUPT) {
      this.buffer = ''
      return
    }
    const code = char.charCodeAt(0)
    // C0 controls (and DEL, handled above) are commands to the emulator, not text.
    if (code < 0x20) return
    if (this.buffer.length < TYPED_LINE_CHARS) this.buffer += char
  }

  /** Drop the pending line (the terminal ended). */
  reset () {
    this.buffer = ''
    this.escape = 0
  }
}
