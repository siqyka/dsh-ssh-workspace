/**
 * Find names a chunk borrows from the main bundle without carrying them across.
 *
 * The split made one class of bug cheap to write and expensive to notice: a name
 * lives in the main bundle, a chunk uses it, and the seam that is supposed to
 * hand it over does not list it. Two shipped that way — `fetchJson` and
 * `BROWSE_LIST_LIMIT` — and both failed the same way: the chunk registered, the
 * panel rendered, and the ReferenceError waited for a user to open a dialog,
 * because an undeclared identifier only throws when the line runs.
 *
 * The question is deliberately narrow. It is NOT "is this chunk correct" (that
 * needs a real parser and a real scope analysis, and a wrong answer here means a
 * red test on correct code, which is how a check like this gets deleted). It is
 * only: **does the chunk use a name that the main bundle declares, without
 * either destructuring it from the bundle or declaring it itself?** That is
 * precisely the bug, and every part of it is answerable without guessing.
 *
 * The two false-positive guards are generous on purpose: a name the chunk
 * declares anywhere suppresses the check for that name, even if the declaration
 * is in a nested scope that does not actually cover the use. That can only hide
 * a bug, never invent one.
 *
 * @module tests/support/free-names
 */

/**
 * Names that are always available, so a chunk using them is not a bug.
 *
 * Generous by design — see the module comment.
 */
const GLOBALS = new Set(`
  globalThis undefined null true false NaN Infinity this super new typeof void
  delete in instanceof await async function class const let var return if else
  for while do switch case break continue try catch finally throw yield import
  export default from as of extends static get set
  React JSON Math Object Array String Number Boolean Symbol Promise Map Set
  WeakMap WeakSet Date RegExp Error TypeError RangeError SyntaxError
  ReferenceError AggregateError Intl BigInt parseInt parseFloat isNaN isFinite
  encodeURIComponent decodeURIComponent encodeURI decodeURI structuredClone
  queueMicrotask setTimeout clearTimeout setInterval clearInterval setImmediate
  clearImmediate console process Buffer URL URLSearchParams TextEncoder
  TextDecoder AbortController AbortSignal Event EventTarget fetch Headers
  Request Response FormData Blob File crypto performance global navigator
  localStorage sessionStorage document window module exports require
  __dirname __filename arguments
`.trim().split(/\s+/u))

/** Punctuation that may precede a regular-expression literal. */
const BEFORE_REGEX = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*',
  '%', '<', '>', '~', '^', '=>', '==', '===', '!=', '!==', '&&', '||', '??',
  '+=', '-=', '*=', '/=', '%=', '&&=', '||=', '??=', '...', 'return', 'typeof',
  'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await',
])

/**
 * Split source into tokens, skipping comments.
 *
 * Handles the three things a naive scanner gets wrong on this codebase:
 * template literals with `${}` nesting, regex literals containing quotes and
 * slashes, and division that looks like a regex (decided by the previous
 * significant token, which is the same rule the language uses).
 *
 * @param {string} source - the file text.
 * @returns {Array<{type: string, value: string, at: number}>} tokens.
 */
export function tokenize (source) {
  const tokens = []
  let at = 0
  const n = source.length

  /** Read a template literal, including any `${...}` expressions. */
  function readTemplate () {
    const start = at
    const inner = []
    at += 1
    while (at < n) {
      const c = source[at]
      if (c === '\\') { at += 2; continue }
      if (c === '`') { at += 1; break }
      if (c === '$' && source[at + 1] === '{') {
        // The expression inside is code, and it is where a name like
        // `BROWSE_LIST_LIMIT` hides: an opaque template token would make every
        // `${…}` invisible to the check. Tokenize it recursively and splice the
        // result in, so a use inside a template counts as a use.
        const exprStart = at + 2
        at += 2
        let depth = 1
        while (at < n && depth > 0) {
          const inner = source[at]
          if (inner === '\\') { at += 2; continue }
          if (inner === '{') depth += 1
          else if (inner === '}') { depth -= 1; if (depth === 0) break }
          else if (inner === '`') {
            at += 1
            let d2 = 0
            while (at < n) {
              const c2 = source[at]
              if (c2 === '\\') { at += 2; continue }
              if (c2 === '`' && d2 === 0) { at += 1; break }
              if (c2 === '$' && source[at + 1] === '{') { d2 += 1; at += 2; continue }
              if (c2 === '}' && d2 > 0) d2 -= 1
              at += 1
            }
            continue
          } else if (inner === "'" || inner === '"') {
            const quote = inner
            at += 1
            while (at < n) {
              if (source[at] === '\\') { at += 2; continue }
              if (source[at] === quote) { at += 1; break }
              at += 1
            }
            continue
          }
          at += 1
        }
        inner.push(...tokenize(source.slice(exprStart, at)))
        at += 1
        continue
      }
      at += 1
    }
    return { type: 'template', value: source.slice(start, at), at: start, inner }
  }

  while (at < n) {
    const c = source[at]
    const next = source[at + 1]

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { at += 1; continue }

    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', at)
      at = end < 0 ? n : end
      continue
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2)
      at = end < 0 ? n : end + 2
      continue
    }

    if (c === "'" || c === '"') {
      const start = at
      at += 1
      while (at < n) {
        if (source[at] === '\\') { at += 2; continue }
        if (source[at] === c) { at += 1; break }
        at += 1
      }
      tokens.push({ type: 'string', value: source.slice(start, at), at: start })
      continue
    }

    if (c === '`') {
      // A template literal's `${…}` expressions are code, so their tokens are
      // spliced into the stream in place. Everything else about the template is
      // opaque — its text is data, not identifiers.
      const template = readTemplate()
      tokens.push({ type: 'template', value: template.value, at: template.at })
      for (const inner of template.inner) tokens.push(inner)
      continue
    }

    if (c === '/') {
      const before = tokens[tokens.length - 1]
      const regexAllowed = before === undefined ||
        before.type === 'punct' ||
        BEFORE_REGEX.has(before.value)
      if (regexAllowed) {
        const start = at
        at += 1
        let inClass = false
        while (at < n) {
          const r = source[at]
          if (r === '\\') { at += 2; continue }
          if (r === '[') inClass = true
          else if (r === ']') inClass = false
          else if (r === '/' && !inClass) { at += 1; break }
          else if (r === '\n') break
          at += 1
        }
        while (at < n && /[a-z]/iu.test(source[at])) at += 1
        tokens.push({ type: 'regex', value: source.slice(start, at), at: start })
        continue
      }
    }

    if (/[0-9]/u.test(c) || (c === '.' && /[0-9]/u.test(next ?? ''))) {
      const start = at
      while (at < n && /[0-9a-fA-FxXoObBeE._n]/u.test(source[at])) {
        if ((source[at] === 'e' || source[at] === 'E') && (source[at + 1] === '+' || source[at + 1] === '-')) at += 1
        at += 1
      }
      tokens.push({ type: 'number', value: source.slice(start, at), at: start })
      continue
    }

    if (/[A-Za-z_$\u00A0-\uFFFF]/u.test(c)) {
      const start = at
      while (at < n && /[A-Za-z0-9_$\u00A0-\uFFFF]/u.test(source[at])) at += 1
      tokens.push({ type: 'ident', value: source.slice(start, at), at: start })
      continue
    }

    const three = source.slice(at, at + 3)
    const two = source.slice(at, at + 2)
    if (three === '...' || three === '===' || three === '!==' || three === '**=' || three === '&&=' || three === '||=' || three === '??=') {
      tokens.push({ type: 'punct', value: three, at })
      at += 3
      continue
    }
    if (['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'].includes(two)) {
      tokens.push({ type: 'punct', value: two, at })
      at += 2
      continue
    }
    tokens.push({ type: 'punct', value: c, at })
    at += 1
  }

  return tokens
}

/**
 * The identifiers a source mentions as bare names, not as property access.
 *
 * "Bare" is what matters: `a.b` and `a?.b` name a property, `{ key: v }` names
 * a key, and neither is a reference to a binding. Strings, comments and regexes
 * are already gone — the tokenizer removed them.
 *
 * @param {string} source - the file text.
 * @returns {Set<string>} mentioned names.
 */
export function mentionedNames (source) {
  const tokens = tokenize(source)
  const names = new Set()
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type !== 'ident') continue
    const before = tokens[i - 1]
    const after = tokens[i + 1]
    if (before !== undefined && before.type === 'punct' && (before.value === '.' || before.value === '?.')) continue
    if (after !== undefined && after.type === 'punct' && after.value === ':' &&
        before !== undefined && before.type === 'punct' && (before.value === '{' || before.value === ',')) continue
    names.add(token.value)
  }
  return names
}

/**
 * The names a chunk pulls out of the main bundle.
 *
 * The seam is one destructuring statement whose right-hand side is
 * `require('<this package>')`; the bundle's own header documents it and
 * `client-chunk-smoke` pins it.
 *
 * @param {string} source - the chunk's text.
 * @returns {Set<string>} bound names.
 */
export function seamNames (source) {
  const match = /const \{([\s\S]*?)\} = require\('@shiqyka\/dsh-ssh-workspace'\)/u.exec(source)
  const bound = new Set()
  if (match === null) return bound
  for (const line of match[1].split('\n')) {
    const name = line.replace(/\/\/.*$/u, '').trim().replace(/,$/u, '')
    if (/^[A-Za-z_$][\w$]*$/u.test(name)) bound.add(name)
  }
  return bound
}

/**
 * The names a chunk declares for itself.
 *
 * Deliberately coarse: a declaration anywhere in the file counts, including one
 * in a nested scope that does not actually cover the use. Over-approximating
 * here can only hide a bug, and a check that cries wolf gets deleted.
 *
 * @param {string} source - the chunk's text.
 * @returns {Set<string>} locally declared names.
 */
export function localNames (source) {
  const declared = new Set()
  const tokens = tokenize(source)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type !== 'ident') continue
    const before = tokens[i - 1]
    const after = tokens[i + 1]

    // `function name`, `class Name`
    if (before !== undefined && before.type === 'ident' && (before.value === 'function' || before.value === 'class')) {
      declared.add(token.value)
      continue
    }
    // `const name`, `let name`, `var name`
    if (before !== undefined && before.type === 'ident' && ['const', 'let', 'var'].includes(before.value)) {
      declared.add(token.value)
      continue
    }
    // Any identifier inside a destructuring pattern that is a binding target.
    if (before !== undefined && before.type === 'punct' && (before.value === '{' || before.value === ',' || before.value === '...')) {
      const isKey = after !== undefined && after.type === 'punct' && after.value === ':'
      if (!isKey) declared.add(token.value)
    }
    // `catch (e)`, `(a, b) =>`, `function f (a, b)` and method shorthand:
    // a parameter is an ident followed by `,` `)` `=` or `:`.
    if (before !== undefined && before.type === 'punct' && before.value === '(') {
      if (after !== undefined && after.type === 'punct' && [',', ')', '=', ':'].includes(after.value)) {
        declared.add(token.value)
      }
    }
  }
  return declared
}

/**
 * The names the main bundle makes available to its chunks.
 *
 * Two sources, both of them real: every name in the `Object.assign(exports, …)`
 * block (the documented seam), and every top-level declaration (a chunk that
 * reaches for one of those without the block listing it is exactly the bug —
 * `BROWSE_LIST_LIMIT` shipped that way).
 *
 * @param {string} bundleSource - `lib/client.js`.
 * @returns {Set<string>} available names.
 */
export function bundleNames (bundleSource) {
  const names = new Set()
  const assign = /Object\.assign\(exports, \{([\s\S]*?)\n {4}\}\)/u.exec(bundleSource)
  for (const line of (assign?.[1] ?? '').split('\n')) {
    const name = line.replace(/\/\/.*$/u, '').trim().replace(/,$/u, '')
    if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name)
  }
  for (const match of bundleSource.matchAll(/^ {4}(?:export )?(?:async )?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gmu)) {
    names.add(match[1])
  }
  return names
}

/**
 * The names a chunk uses from the bundle without carrying them across.
 *
 * @param {string} chunkSource - the chunk's text.
 * @param {Set<string>} available - from {@link bundleNames}.
 * @returns {string[]} sorted offending names.
 */
export function unboundBorrows (chunkSource, available) {
  const bound = seamNames(chunkSource)
  const local = localNames(chunkSource)
  const mentioned = mentionedNames(chunkSource)
  const offenders = []
  for (const name of available) {
    if (bound.has(name) || local.has(name) || GLOBALS.has(name)) continue
    if (mentioned.has(name)) offenders.push(name)
  }
  return offenders.sort()
}
