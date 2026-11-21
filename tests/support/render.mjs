/**
 * Render one component out of `lib/client/client.js` without a DOM.
 *
 * ## Why this exists
 *
 * Most UI assertions in this repository grep the shipped bundle for a line of
 * source. That proves the line is still typed, never that it does anything: a
 * component wrapped in `if (false)` greps exactly like a live one. The suites
 * that need behaviour already slice a function out of the bundle and call it --
 * `toast-dom.mjs` and `tree-dom.mjs` proved the shape works. This module lifts
 * the common part out so a new suite does not grow its own third copy.
 *
 * ## What it is not
 *
 * It is NOT React and NOT a DOM. There is no reconciliation, no commit phase and
 * no re-render: `render()` calls the component once and hands back the element
 * tree that `jsx()` produced. A `setState` recorded by the stub therefore does
 * not change the tree -- assert on the setter call, not on a second render.
 * That limit is deliberate; a fake reconciler would be a second implementation
 * of React, and the assertions would then describe the fake.
 *
 * Effects are recorded but NOT run by default, because running them is a claim
 * about WHEN React runs them, which this harness cannot make. Pass
 * `runEffects: true` for the suites that need the effect body itself; the
 * cleanups it returns are then collected and can be driven by `cleanup()`.
 *
 * Nothing here introduces a dependency: the file is plain `node:` and the
 * component is compiled with `new Function`, exactly like the existing slices.
 */

/**
 * Index just past the `}` that closes the `{` at `open`.
 *
 * Raw brace counting. Safe on a function body by inspection only, so the caller
 * must slice a real function; the throw names the failure rather than returning
 * a truncated string that would compile into nonsense.
 *
 * @param {string} source - file text.
 * @param {number} open - index of the opening brace.
 * @returns {number} index one past the matching close.
 */
function endOfBlock (source, open) {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  throw new Error('render: unbalanced braces, the slice was truncated')
}

/**
 * Slice `function <name> (…) { … }` out of a source file.
 *
 * Both spellings in this repository (`function name (` and `function name(`)
 * are accepted. An arrow-function component is refused rather than guessed at:
 * a wrong slice compiles and then fails at call time with a message that blames
 * the component instead of the harness.
 *
 * @param {string} source - file text.
 * @param {string} name - the component's declared name.
 * @returns {string} the declaration, braces balanced.
 * @throws {Error} when the declaration is absent or is not a function.
 */
export function componentSource (source, name) {
  for (const marker of ['function ' + name + ' (', 'function ' + name + '(']) {
    const from = source.indexOf(marker)
    if (from < 0) continue
    // The body brace is the first `{` AFTER the parameter list closes. Taking
    // the first one outright cuts a destructured signature in half: the slice
    // then compiles to `function X ({ a, b }` and throws a syntax error that
    // blames the component.
    const paren = source.indexOf('(', from)
    if (paren < 0) throw new Error('render: ' + name + ' has no parameter list')
    let depth = 0
    let close = -1
    for (let index = paren; index < source.length; index += 1) {
      const char = source[index]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) { close = index; break }
      }
    }
    if (close < 0) throw new Error('render: ' + name + ' has an unbalanced parameter list')
    const open = source.indexOf('{', close)
    if (open < 0) throw new Error('render: ' + name + ' has no body')
    return source.slice(from, endOfBlock(source, open))
  }
  throw new Error('render: no `function ' + name + '` declaration in the bundle')
}

/**
 * A React-shaped hook stub that records what the component asked for.
 *
 * @param {object} [options] - harness knobs.
 * @param {boolean} [options.runEffects] - execute effect bodies once, in order.
 * @returns {{react: object, calls: object, cleanup: () => void}} the stub.
 */
export function createReactStub (options) {
  const config = options ?? {}
  const calls = { states: [], effects: [], cleanups: [], renders: 0, ids: 0 }
  let nextId = 0

  const record = (kind, body) => {
    const entry = { kind, index: calls.effects.length, ran: false }
    calls.effects.push(entry)
    if (config.runEffects !== true) return entry
    entry.ran = true
    const returned = body()
    if (typeof returned === 'function') {
      entry.cleanup = returned
      calls.cleanups.push(returned)
    }
    return entry
  }

  const react = {
    useState (initial) {
      const index = calls.states.length
      const value = typeof initial === 'function' ? initial() : initial
      calls.states.push({ index, initial: value, updates: [] })
      const set = next => { calls.states[index].updates.push(next) }
      return [value, set]
    },
    useReducer (reducer, initial) {
      const index = calls.states.length
      calls.states.push({ index, initial, updates: [] })
      const dispatch = action => { calls.states[index].updates.push(action) }
      return [initial, dispatch]
    },
    useRef (initial) { return { current: initial } },
    useEffect (body) { return record('effect', body) },
    useLayoutEffect (body) { return record('layout', body) },
    useCallback (fn) { return fn },
    useMemo (fn) { return fn() },
    useId () {
      calls.ids += 1
      nextId += 1
      return 'r' + nextId
    },
    createElement (type, props) { return { type, props: props ?? {} } },
    Fragment: 'Fragment',
  }

  const cleanup = () => {
    for (const fn of calls.cleanups.splice(0)) fn()
  }

  return { react, calls, cleanup }
}

/**
 * Compile one component out of a bundle into a callable.
 *
 * @param {string} source - bundle text.
 * @param {string} name - component name.
 * @param {object} options - `inject` names and the React stub.
 * @returns {Function} the component.
 */
export function compile (source, name, options) {
  const config = options ?? {}
  const inject = config.inject ?? {}
  const stub = config.react ?? createReactStub().react
  const reserved = ['React', 'jsx', 'jsxs', 'Fragment']
  for (const key of Object.keys(inject)) {
    if (reserved.includes(key)) {
      throw new Error('render: `' + key + '` is supplied by the harness and cannot be injected')
    }
  }
  const code = componentSource(source, name)
  const params = [...Object.keys(inject), 'React', 'jsx', 'jsxs', 'Fragment']
  const values = [...Object.values(inject), stub, jsx, jsxs, 'Fragment']
  return new Function(...params, code + '; return ' + name)(...values)
}

/**
 * The element shape `jsx()` produces, matching what the existing suites use.
 *
 * @param {unknown} type - element type.
 * @param {object|null} props - props, children included.
 * @param {unknown} [key] - React key.
 * @returns {{type: unknown, props: object, key?: unknown}} the element.
 */
export function jsx (type, props, key) {
  const element = { type, props: props ?? {} }
  if (key !== undefined) element.key = key
  return element
}

/** `jsxs` differs from `jsx` only in React's static-children fast path. */
export const jsxs = jsx

/**
 * Render a component out of a bundle, once.
 *
 * @param {string} source - bundle text.
 * @param {string} name - component name.
 * @param {object} props - props for the single render.
 * @param {object} [options] - `inject`, `react`, `runEffects`.
 * @returns {{element: unknown, calls: object, react: object, cleanup: () => void}} the render.
 */
export function render (source, name, props, options) {
  const config = options ?? {}
  const stub = config.react === undefined
    ? createReactStub({ runEffects: config.runEffects === true })
    : { react: config.react, calls: config.react.calls ?? { states: [], effects: [], cleanups: [] }, cleanup: () => {} }
  const component = compile(source, name, { inject: config.inject, react: stub.react })
  const element = component(props ?? {})
  stub.calls.renders = (stub.calls.renders ?? 0) + 1
  return { element, calls: stub.calls, react: stub.react, cleanup: stub.cleanup }
}

/**
 * Visit every element in a tree, depth first.
 *
 * Arrays and `props.children` are both descended into; strings and numbers are
 * leaves and are skipped, so a visitor only ever sees elements.
 *
 * @param {unknown} node - element, array or leaf.
 * @param {(element: object) => void} visit - called per element.
 * @returns {void}
 */
export function walk (node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  if (node.type === undefined) return
  visit(node)
  walk(node.props?.children, visit)
}

/**
 * Every element in the tree matching a predicate.
 *
 * @param {unknown} node - tree root.
 * @param {(element: object) => boolean} predicate - the test.
 * @returns {object[]} matches, in document order.
 */
export function findAll (node, predicate) {
  const found = []
  walk(node, element => { if (predicate(element)) found.push(element) })
  return found
}

/**
 * Every element of a given type.
 *
 * @param {unknown} node - tree root.
 * @param {unknown} type - element type to match.
 * @returns {object[]} matches, in document order.
 */
export function byType (node, type) {
  return findAll(node, element => element.type === type)
}

/**
 * The text content of a tree, concatenated.
 *
 * @param {unknown} node - element, array or leaf.
 * @returns {string} the text.
 */
export function textOf (node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

export default { componentSource, compile, createReactStub, jsx, jsxs, render, walk, findAll, byType, textOf }
