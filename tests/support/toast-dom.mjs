/**
 * Shared harness for the DOM-level toasts in `lib/client.js`.
 *
 * Suites need the REAL `notifyUser` / `transferNotice` rather than a retyped
 * copy — a copy proves nothing about the code that ships. The slice is
 * contiguous, from the timer binding to the end of `transferNotice`, which also
 * carries the model, the renderer, the actions and `armToast`, so the closure
 * under test is the shipped one.
 *
 * The fake DOM records timers as objects rather than as bare functions because
 * the questions these suites ask are "was it set to seven seconds", "can a
 * hover cancel it", and "does a copy fall back to a selection".
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
 * Lift the toast controller out of the browser bundle.
 *
 * @param {string} source - text of `lib/client.js`.
 * @returns {{ms: number, build: Function}} the shipped seven-second figure,
 *   and a factory that binds the helpers to a DOM, a clock and a window.
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
    'document', 'setTimeout', 'clearTimeout', 'TOAST_DISMISS_MS', 'navigator', 'window',
    `${body}; return { notifyUser, transferNotice, toastModel, toastCopyText, toastDiagnosticText }`,
  )
  return {
    ms,
    build: (document, setTimeout, clearTimeout, navigator, view) =>
      factory(document, setTimeout, clearTimeout, ms, navigator, view),
  }
}

/**
 * A DOM double that records nodes, children, removals, listeners and timers.
 *
 * The child tree is real enough for `contains()` and the action delegation:
 * the toast is no longer a single text node, and the focus rule asks whether
 * the active element is inside the root.
 *
 * @returns {object} the double.
 */
export function makeToastDom () {
  const nodes = []
  const timers = []
  const copies = []

  /** A single element double. */
  const makeNode = (tag = 'div') => {
    const listeners = new Map()
    const attributes = new Map()
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      text: '',
      hidden: false,
      disabled: false,
      type: '',
      tabIndex: -1,
      parent: null,
      removed: false,
      children: [],
      setAttribute (name, value) {
        attributes.set(name, String(value))
        if (name === 'data-sshwsp-toast') node['data-sshwsp-toast'] = String(value)
      },
      getAttribute (name) {
        return attributes.has(name) ? attributes.get(name) : null
      },
      addEventListener (name, handler) {
        const list = listeners.get(name) ?? []
        list.push(handler)
        listeners.set(name, list)
      },
      /**
       * Fire the handlers registered for one event name.
       *
       * `target` defaults to the node itself, which is what a click on the
       * root or on its line does; an action test passes the button.
       */
      emit (name, event = {}) {
        const payload = {
          target: node,
          preventDefault () {},
          stopPropagation () {},
          ...event,
        }
        for (const handler of listeners.get(name) ?? []) handler(payload)
        return payload
      },
      appendChild (child) {
        child.parent = node
        node.children.push(child)
        return child
      },
      contains (candidate) {
        let cursor = candidate
        while (cursor !== null && cursor !== undefined) {
          if (cursor === node) return true
          cursor = cursor.parent ?? null
        }
        return false
      },
      querySelector (selector) {
        const visit = (candidate) => {
          for (const child of candidate.children) {
            const matches = selector.startsWith('[data-toast-action="')
              ? child.getAttribute('data-toast-action') === selector.slice(20, -2)
              : selector.startsWith('.')
                ? child.className.split(/\s+/u).includes(selector.slice(1))
                : child.tagName === selector.toUpperCase()
            if (matches) return child
            const deeper = visit(child)
            if (deeper !== null) return deeper
          }
          return null
        }
        return visit(node)
      },
      focus () { document.activeElement = node },
      blur () { if (document.activeElement === node) document.activeElement = null },
      remove () {
        const at = nodes.indexOf(node)
        if (at >= 0) nodes.splice(at, 1)
        if (node.parent !== null) {
          const siblings = node.parent.children
          const index = siblings.indexOf(node)
          if (index >= 0) siblings.splice(index, 1)
        }
        node.removed = true
        if (document.activeElement === node) document.activeElement = null
      },
      get isConnected () {
        if (node.removed) return false
        let cursor = node
        while (cursor.parent !== null) cursor = cursor.parent
        return cursor === document.body || nodes.includes(cursor)
      },
      get textContent () {
        return node.text + node.children.map(child => child.textContent).join('')
      },
      set textContent (value) {
        node.text = String(value)
        node.children = []
      },
    }
    return node
  }

  const body = {
    tagName: 'BODY',
    parent: null,
    children: [],
    active: false,
    appendChild (node) {
      node.parent = body
      body.children.push(node)
      nodes.push(node)
      return node
    },
    contains (candidate) {
      let cursor = candidate
      while (cursor !== null && cursor !== undefined) {
        if (cursor === body) return true
        cursor = cursor.parent ?? null
      }
      return false
    },
    focus () { document.activeElement = body },
    remove () {},
  }

  const selection = {
    ranges: [],
    removeAllRanges () { selection.ranges = [] },
    addRange (range) { selection.ranges.push(range) },
    toString () { return selection.ranges.map(range => range.text).join('') },
  }

  const view = {
    getSelection: () => selection,
  }

  const document = {
    activeElement: body,
    body,
    createElement: (tag) => makeNode(tag),
    createRange: () => ({
      text: '',
      selectNodeContents (node) { this.text = node.textContent; this.node = node },
    }),
    querySelectorAll: (selector) => {
      if (selector === '.sshwsp-toast[data-sshwsp-toast]') {
        return nodes.filter(node => node.getAttribute('data-sshwsp-toast') === '1' && !node.removed)
      }
      return [...nodes]
    },
  }

  const clipboard = {
    async writeText (text) {
      copies.push(text)
    },
  }

  const navigator = { clipboard }

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
    window: view,
    selection,
    navigator,
    clipboard,
    copies,
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
    build: (source) => liftToasts(source).build(document, setTimeout, clearTimeout, navigator, view),
  }
}
