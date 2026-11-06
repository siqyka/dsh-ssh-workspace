/**
 * Shared harness for the DOM-level toasts in `lib/client.js`.
 *
 * Two suites need the REAL `notifyUser` / `transferNotice` rather than a
 * retyped copy — a copy proves nothing about the code that ships. The slice is
 * contiguous, from the timer binding to the end of `transferNotice`, which also
 * carries `armToast` and `focusedElement`, so the closure under test is the
 * shipped one.
 *
 * The fake DOM records timers as objects rather than as bare functions because
 * the question these suites ask is not "was a timer set" but "was it set to
 * seven seconds, and can a hover cancel it".
 */

/**
 * Index just past the `}` that closes the `{` at `open`.
 *
 * Raw brace counting, and safe here by inspection: the slice holds no brace
 * inside a string, a regex or a comment. Template literals in it are balanced
 * (`${…}` contributes exactly one pair).
 *
 * @param {string} source - file text.
 * @param {number} open - index of the opening brace.
 * @returns {number} index one past the matching close.
 */
export function endOfBlock (source, open) {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  throw new Error('unbalanced braces: the helper was pointed at a truncated slice')
}

/**
 * Lift `notifyUser` and `transferNotice` out of the browser bundle.
 *
 * @param {string} source - text of `lib/client.js`.
 * @returns {{ms: number, build: (document: object, setTimeout: Function, clearTimeout: Function) => {notifyUser: Function, transferNotice: Function}}}
 *   the shipped 7-second figure, and a factory that binds the helpers to a DOM
 *   and a clock.
 */
export function liftToasts (source) {
  const start = source.indexOf('let domToastTimer = null')
  if (start < 0) throw new Error('client.js no longer defines the DOM toast timer')
  const anchor = source.indexOf('function transferNotice (text) {', start)
  if (anchor < 0) throw new Error('client.js no longer defines transferNotice()')
  const end = endOfBlock(source, source.indexOf('{', anchor))
  const body = source.slice(start, end)
  const constant = /const TOAST_DISMISS_MS = (\d+)/u.exec(source)
  if (constant === null) throw new Error('client.js no longer defines TOAST_DISMISS_MS')
  const ms = Number(constant[1])
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'document', 'setTimeout', 'clearTimeout', 'TOAST_DISMISS_MS',
    `${body}; return { notifyUser, transferNotice }`,
  )
  return { ms, build: (document, setTimeout, clearTimeout) => factory(document, setTimeout, clearTimeout, ms) }
}

/**
 * A DOM double that records nodes, removals, listeners, focus and timers.
 *
 * `document.activeElement` is tracked because the expiry rule now depends on it:
 * an expiring failure must hand focus back instead of dropping it to `<body>`.
 *
 * @returns {object} the double.
 */
export function makeToastDom () {
  const nodes = []
  const timers = []

  const makeNode = () => {
    const listeners = new Map()
    const node = {
      className: '',
      textContent: '',
      tabIndex: -1,
      parent: null,
      removed: false,
      setAttribute (name, value) { node[name] = value },
      addEventListener (name, handler) {
        const list = listeners.get(name) ?? []
        list.push(handler)
        listeners.set(name, list)
      },
      /** Fire the handlers registered for one event name. */
      emit (name, event = {}) {
        for (const handler of listeners.get(name) ?? []) handler(event)
      },
      focus () { document.activeElement = node },
      blur () { if (document.activeElement === node) document.activeElement = null },
      remove () {
        const at = nodes.indexOf(node)
        if (at >= 0) nodes.splice(at, 1)
        node.removed = true
        if (document.activeElement === node) document.activeElement = null
      },
      get isConnected () { return !node.removed },
    }
    return node
  }

  const document = {
    activeElement: null,
    body: { appendChild (node) { nodes.push(node); node.parent = document.body } },
    createElement: () => makeNode(),
    querySelectorAll: () => [...nodes],
  }

  const setTimeout = (fn, ms) => {
    timers.push({ fn, ms, cancelled: false })
    return timers.length - 1
  }
  const clearTimeout = (id) => {
    const timer = timers[id]
    if (timer !== undefined) timer.cancelled = true
  }

  return {
    document,
    nodes,
    timers,
    /** Timers still armed. */
    live: () => timers.filter(timer => !timer.cancelled),
    /** Run every armed timer once, as a clock reaching its deadline would. */
    tick () {
      for (const timer of timers) {
        if (timer.cancelled) continue
        timer.cancelled = true
        timer.fn()
      }
    },
    build: (source) => liftToasts(source).build(document, setTimeout, clearTimeout),
  }
}
