/**
 * A minimal DOM double, just large enough to drive the host-tree bridges.
 *
 * The tree in DSH's Files panel is host-owned, so the only way this plugin can
 * prove its gestures work is by running the REAL bridge against a DOM shaped
 * like the host's. `jsdom` is not a dependency and must not become one, so this
 * file implements exactly the surface the bridges touch: attribute get/set,
 * `classList`, `closest`, `querySelector(All)`, descendant `contains`, event
 * dispatch, focus, and `getBoundingClientRect`.
 *
 * Selector support is deliberately narrow: tag names, `[attr]`, `[attr="v"]`,
 * compounds of those, and comma-separated lists. That covers every selector the
 * bridges use; anything else matches nothing rather than throwing, and the
 * suite asserts on the node count so an unsupported selector shows up as a
 * failure rather than as a gesture test that silently never ran.
 */

/** Parse one compound selector such as `li[data-files-entry][data-files-path]`. */
function parsePart (part) {
  const trimmed = part.trim()
  const tag = /^[a-zA-Z][\w-]*/u.exec(trimmed)?.[0]?.toLowerCase() ?? null
  const attrs = []
  const attrRe = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/gu
  for (const match of trimmed.matchAll(attrRe)) {
    attrs.push({ name: match[1], value: match[2] ?? match[3] ?? null })
  }
  return { tag, attrs }
}

/** Compile a selector into its comma-separated alternatives. */
function parseSelector (selector) {
  return String(selector).split(',').map(parsePart)
}

/** Whether one element satisfies one compound alternative. */
function matchPart (el, part) {
  if (part.tag !== null && el.tagName.toLowerCase() !== part.tag) return false
  for (const attr of part.attrs) {
    const value = el.getAttribute(attr.name)
    if (value === null) return false
    if (attr.value !== null && value !== attr.value) return false
  }
  return true
}

/** Whether one element satisfies a whole selector. */
export function matchesSelector (el, selector) {
  return parseSelector(selector).some(part => matchPart(el, part))
}

/** One element. */
function makeElement (tagName, document) {
  const attributes = new Map()
  let classes = new Set()
  const children = []
  const listeners = new Map()

  const el = {
    tagName: tagName.toUpperCase(),
    ownerDocument: document,
    parentNode: null,
    hidden: false,
    style: {},
    children,
    offsetHeight: 34,
    removed: false,

    classList: {
      add (name) { classes.add(name) },
      remove (name) { classes.delete(name) },
      contains (name) { return classes.has(name) },
      toggle (name, force) {
        const want = force === undefined ? !classes.has(name) : force === true
        if (want) classes.add(name)
        else classes.delete(name)
        return want
      },
      get value () { return [...classes].join(' ') },
    },
    get className () { return [...classes].join(' ') },
    set className (value) { classes = new Set(String(value).split(/\s+/u).filter(Boolean)) },

    getAttribute (name) { return attributes.has(name) ? attributes.get(name) : null },
    setAttribute (name, value) { attributes.set(name, String(value)) },
    hasAttribute (name) { return attributes.has(name) },
    removeAttribute (name) { attributes.delete(name) },

    appendChild (child) {
      child.parentNode = el
      children.push(child)
      return child
    },
    append (...nodes) { for (const node of nodes) el.appendChild(node) },
    get firstElementChild () { return children[0] ?? null },
    get lastElementChild () { return children[children.length - 1] ?? null },
    get childElementCount () { return children.length },
    get nextElementSibling () {
      const siblings = el.parentNode?.children ?? []
      const at = siblings.indexOf(el)
      return at >= 0 ? siblings[at + 1] ?? null : null
    },
    remove () {
      const siblings = el.parentNode?.children
      if (siblings !== undefined) {
        const at = siblings.indexOf(el)
        if (at >= 0) siblings.splice(at, 1)
      }
      el.removed = true
      el.parentNode = null
    },

    contains (node) {
      if (node === el) return true
      return children.some(child => child.contains(node))
    },
    closest (selector) {
      let node = el
      while (node !== null) {
        if (matchesSelector(node, selector)) return node
        node = node.parentNode
      }
      return null
    },
    matches (selector) { return matchesSelector(el, selector) },
    querySelectorAll (selector) {
      const out = []
      const walk = (node) => {
        for (const child of node.children) {
          if (matchesSelector(child, selector)) out.push(child)
          walk(child)
        }
      }
      walk(el)
      return out
    },
    querySelector (selector) { return el.querySelectorAll(selector)[0] ?? null },

    addEventListener (name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
    },
    removeEventListener (name, handler) {
      const list = listeners.get(name) ?? []
      const at = list.indexOf(handler)
      if (at >= 0) list.splice(at, 1)
    },
    /** Fire this element's own handlers (the host's row behaviour). */
    emit (name, event = {}) {
      for (const handler of listeners.get(name) ?? []) handler(event)
    },
    click () {
      // A real `button.click()` dispatches a click that bubbles through the
      // document, so capture listeners see it. Routing it the same way is what
      // makes the Enter-opens-a-row path observable: the bridge must let that
      // click through instead of reading it as a new selection gesture.
      if (typeof document.clickFrom === 'function') return document.clickFrom(el)
      const event = { type: 'click', target: el, defaultPrevented: false, preventDefault () { event.defaultPrevented = true } }
      el.emit('click', event)
      return event
    },

    focus () { document.activeElement = el },
    blur () { if (document.activeElement === el) document.activeElement = null },
    /**
     * Select the whole field, the way an `<input>` does.
     *
     * The rename editor focuses and selects its buffer on mount, so a double
     * without `select` would make every test of that editor throw — and the
     * failure would look like a product bug rather than a missing method.
     */
    select () { el.selectionStart = 0; el.selectionEnd = String(el.value ?? '').length },
    getBoundingClientRect () {
      return { left: 1000, right: 1280, top: 100, bottom: 500, width: 280, height: 400, x: 1000, y: 100 }
    },

    get textContent () {
      if (children.length === 0) return el._text ?? ''
      return children.map(child => child.textContent).join('')
    },
    set textContent (value) {
      children.length = 0
      el._text = String(value)
    },
  }
  return el
}

/**
 * A document double whose capture listeners are what the bridges register.
 *
 * @returns {object} `{ document, window, make, raf, dispatch }`.
 */
export function makeTreeDom () {
  const document = {
    activeElement: null,
    listeners: new Map(),
    /** Every node created, so a test can find the batch bar. */
    created: [],
    body: null,
    /**
     * Capture dispatch, modelled the way the browser does it: the document's
     * capture handlers run BEFORE the target's own, and `stopPropagation`
     * there prevents the target's handler from running at all. That ordering
     * is the whole reason the bridge is allowed to suppress navigation.
     */
    addEventListener (name, handler) {
      const list = document.listeners.get(name) ?? []
      list.push(handler)
      document.listeners.set(name, list)
    },
    removeEventListener (name, handler) {
      const list = document.listeners.get(name) ?? []
      const at = list.findIndex(entry => entry === handler)
      if (at >= 0) list.splice(at, 1)
    },
    /** Run a capture dispatch for one event type; returns the event. */
    dispatch (name, event) {
      event.stopped = false
      event.preventDefault = () => { event.defaultPrevented = true }
      event.stopPropagation = () => { event.stopped = true }
      event.defaultPrevented = false
      for (const handler of document.listeners.get(name) ?? []) handler(event)
      if (!event.stopped && typeof event.target?.emit === 'function') event.target.emit(name, event)
      return event
    },
    createElement (tagName) {
      const el = makeElement(tagName, document)
      document.created.push(el)
      return el
    },
    /** Every descendant of <body> matching one selector. */
    querySelectorAll (selector) {
      const out = []
      const walk = (node) => {
        for (const child of node.children) {
          if (matchesSelector(child, selector)) out.push(child)
          walk(child)
        }
      }
      walk(document.body)
      return out
    },
    querySelector (selector) { return document.querySelectorAll(selector)[0] ?? null },
    /** The one path a programmatic click takes, so capture sees it. */
    clickFrom (el) {
      return document.dispatch('click', { type: 'click', target: el })
    },
    /**
     * Deliver one mutation record to every registered MutationObserver.
     *
     * The real bridge is driven by React committing nodes; the double has no
     * scheduler, so the harness says explicitly when "the host re-rendered".
     * Without this the suite could not distinguish "the bridge prunes removed
     * rows" from "the harness never told it".
     */
    notifyMutation (record) {
      for (const observer of document.observers ?? []) observer.deliver(record)
    },
    observers: [],
    contains (node) {
      let current = node
      while (current !== null && current !== undefined) {
        if (current === document.body) return true
        current = current.parentNode
      }
      return false
    },
  }
  const body = document.createElement('body')
  document.body = body

  /**
   * A MutationObserver double that records what it observes.
   *
   * Constructed with `new`, like the real one, and each instance registers
   * itself so `notifyMutation` can deliver a record to it.
   */
  class MutationObserverDouble {
    constructor (callback) {
      this.callback = callback
      this.disconnected = false
      document.observers.push(this)
    }

    observe () {}

    disconnect () { this.disconnected = true }

    /** Deliver one record, unless this observer was disconnected. */
    deliver (record) {
      if (!this.disconnected) this.callback([record])
    }
  }
  document.MutationObserver = MutationObserverDouble

  let frameId = 0
  const frames = []
  const window = {
    requestAnimationFrame (fn) {
      frameId += 1
      frames.push({ id: frameId, fn })
      return frameId
    },
    cancelAnimationFrame (id) {
      const at = frames.findIndex(entry => entry.id === id)
      if (at >= 0) frames.splice(at, 1)
    },
    addEventListener () {},
    removeEventListener () {},
  }

  const builder = {
    document,
    window,
    /** Flush every queued animation frame once. */
    raf () {
      const pending = frames.splice(0, frames.length)
      for (const entry of pending) entry.fn()
    },
    /** Build one element tree from a small declarative description. */
    make (description) {
      const el = document.createElement(description.tag)
      if (description.attrs !== undefined) {
        for (const [name, value] of Object.entries(description.attrs)) el.setAttribute(name, value)
      }
      if (description.text !== undefined) el.textContent = description.text
      for (const child of description.children ?? []) el.appendChild(builder.make(child))
      return el
    },
  }
  builder.MutationObserver = MutationObserverDouble
  /** Deliver one mutation record, as the host's DOM commit would. */
  builder.notifyMutation = (record) => document.notifyMutation(record)
  return builder
}
