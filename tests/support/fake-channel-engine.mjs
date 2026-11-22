/**
 * An engine double that hands out one prepared channel per `open`.
 *
 * ## Why this is shared
 *
 * `terminal-smoke`'s two sections (shell and terminal) each grew this same
 * pre-built channels, `openChannel` popping one per call, and a log of what was
 * asked for. The two copies were byte-identical in shape and had already drifted
 * once -- the terminal copy grew `abortedAtOpen` because a signal that fires
 * after the open must not be visible inside it, and the shell copy did not, so
 * nothing proved the shell path was handed the same snapshot.
 *
 * What is NOT shared is the channel itself. A shell channel speaks the
 * marker protocol (`\r\n<marker><code><marker>\r\n`); a terminal channel is a
 * raw PTY with window resizes. Those are two different servers, and forcing
 * them into one factory would make every assertion describe the factory.
 *
 * @module tests/support/fake-channel-engine
 */

/**
 * Build the engine double.
 *
 * Two shapes, because the two suites genuinely ask for different things:
 *
 *  - an ARRAY of prepared channels, each handed out in turn (and the last one
 *    repeated). The shell suite needs this: its channels answer a marker
 *    protocol, so the reply depends on which command the channel was built for.
 *  - a FACTORY, called once per open. The terminal suite needs this: every
 *    terminal gets its own PTY and the assertions read the state of whichever
 *    one was opened.
 *
 * A prepared channel may carry `state` alongside `channel`; it is copied onto
 * the open record so a suite can assert against the channel it was given
 * without threading a second array through its own code.
 *
 * @param {Array<object> | (() => object)} channels - prepared channels or a factory.
 * @returns {{engine: object, opens: object[]}} the engine and its open log.
 */
export function fakeChannelEngine (channels) {
  const factory = typeof channels === 'function' ? channels : undefined
  const prepared = Array.isArray(channels) ? channels : []
  const opens = []
  const engine = {
    /** No workspace is detached in the suites that use this double. */
    assertNotDisabled () {},
    async openChannel (alias, command, options) {
      const next = factory === undefined ? (prepared[opens.length] ?? prepared.at(-1)) : factory()
      if (next === undefined) {
        throw new Error('fake-channel-engine: openChannel called with no prepared channel')
      }
      opens.push({
        alias,
        command,
        options,
        state: next.state,
        // Snapshot the abort state the caller handed to the open. A signal that
        // fires later must not be visible here, and a pre-aborted one must be;
        // reading `options.signal.aborted` at assertion time answers neither.
        abortedAtOpen: options?.signal?.aborted === true,
      })
      return { channel: next.channel, release: next.release ?? (() => {}) }
    },
  }
  // `opened` is the same array as `opens`: the shell suite already reads
  // `engine.opened`, and a second name for one log is cheaper than rewriting
  // every assertion in a suite that is not otherwise being changed.
  engine.opened = opens
  return { engine, opens }
}


/**
 * A channel double standing in for an ssh2 PTY channel.
 *
 * `close` is triggered explicitly (or by the router's `terminate`) so the exit
 * settlement is deterministic instead of depending on a timer.
 *
 * @returns {{channel: object, state: object}} the channel and its recorded state.
 */
export function fakePtyChannel () {
  const handlers = new Map()
  const state = { writes: [], window: undefined, closed: false, released: 0 }
  const channel = {
    stderr: { on () {} },
    on (event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    once (event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    emit (event, ...args) { for (const handler of handlers.get(event) ?? []) handler(...args) },
    write (data, callback) { state.writes.push(data); callback?.() },
    end () {},
    setWindow (rows, cols, height, width, callback) {
      state.window = { rows, cols }
      callback?.()
    },
    close () {
      if (state.closed) return
      state.closed = true
      channel.emit('close', 0, null)
    },
  }
  return { channel, state }
}

/**
 * The engine over a fresh PTY per open.
 *
 * The release hook is wired to the channel's own counter, which is what makes
 * "the connection hold was given back" measurable rather than inferred.
 *
 * @returns {{engine: object, opens: object[]}} the engine and its open log.
 */
export function fakePtyEngine () {
  return fakeChannelEngine(() => {
    const { channel, state } = fakePtyChannel()
    return { channel, state, release: () => { state.released += 1 } }
  })
}

export default { fakeChannelEngine, fakePtyChannel, fakePtyEngine }
