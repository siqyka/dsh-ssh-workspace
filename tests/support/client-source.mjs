/**
 * The browser half's source text, wherever its parts currently live.
 *
 * The browser half lives in `lib/client/`: a main bundle `client.js` plus the
 * chunks beside it. The Host supports splitting it into chunks that sit beside
 * the owner (`client.<name>.js`, same directory, registered through
 * `require.async('./client.<name>.js')`, and served from `dirname(clientPath)`),
 * and the parts that are only needed once a dialog opens are the ones worth
 * moving there.
 *
 * A suite that asserts "the row menu offers rename" is asking about the client
 * half, not about a file. Reading the concatenation keeps that question intact
 * across the split — the same reason `route-source.mjs` exists for the HTTP
 * half, and the same reason hard-coding `lib/routes.js` made a refactor look
 * like five regressions at once.
 *
 * Reading the concatenation is deliberately NOT a substitute for a real import:
 * a suite that needs to know WHICH part holds something should say so, because
 * "this string exists somewhere in 13,000 lines" is a weaker claim than "this
 * module exports it". The strong form belongs to the suites that can compile a
 * component (`render.mjs`); this one is for the source-level checks.
 *
 * The order is stable — the main bundle first, then the chunks sorted by name —
 * so a byte offset into the result is reproducible within a run.
 *
 * @module tests/support/client-source
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { mentionedNames } from './free-names.mjs'

/** The browser half lives in its own directory; the Host serves a chunk from beside its owner. */
const CLIENT_DIR = path.join('lib', 'client')

/** The chunk that holds the stateless bottom layer. */
const KERNEL_CHUNK = 'client.kernel.js'

/** A chunk is `client.<something>.js` beside `client.js`, per the Host's CLIENT_CHUNK. */
const CHUNK_RE = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u

/**
 * Every client chunk's file name, sorted.
 *
 * @param {string} pluginRoot - the repository root.
 * @returns {string[]} chunk file names, main bundle excluded.
 */
export function clientChunkNames (pluginRoot) {
  let entries
  try {
    entries = readdirSync(path.join(pluginRoot, CLIENT_DIR))
  } catch (error) {
    // An empty chunk list would make every "this chunk does not borrow a name
    // from the bundle" claim vacuously true, so the absence has to be loud.
    throw new Error(
      `client-source: cannot list ${path.join(pluginRoot, CLIENT_DIR)} — every claim about "the chunks" would be answered "there are none" (${error.code ?? error.message})`
    )
  }
  return entries.filter(name => CHUNK_RE.test(name)).sort()
}

/**
 * The whole browser half's source, joined.
 *
 * @param {string} pluginRoot - the repository root.
 * @returns {string} the concatenated source, with CRLF normalized to LF.
 */
export function clientSource (pluginRoot) {
  const parts = [readFileSync(path.join(pluginRoot, CLIENT_DIR, 'client.js'), 'utf8')]
  for (const name of clientChunkNames(pluginRoot)) {
    parts.push(readFileSync(path.join(pluginRoot, CLIENT_DIR, name), 'utf8'))
  }
  return parts.join('\n').replace(/\r\n/gu, '\n')
}

/**
 * One client part's source.
 *
 * @param {string} pluginRoot - the repository root.
 * @param {string} [name] - a chunk file name; omitted means the main bundle.
 * @returns {string} that part's source, with CRLF normalized to LF.
 */
export function clientPartSource (pluginRoot, name = 'client.js') {
  return readFileSync(path.join(pluginRoot, CLIENT_DIR, name), 'utf8').replace(/\r\n/gu, '\n')
}

/**
 * The kernel chunk's DECLARATIONS, ready to splice into a lifted body.
 *
 * Suites lift a contiguous run out of the bundle and evaluate it with
 * `new Function` to drive the real code. That worked while the whole browser
 * half was one file; now a lifted run can call into the kernel, and a shell that
 * evaluates it alone throws `ReferenceError: toastModel is not defined`.
 *
 * Prepending this block fixes that without weakening the check: the code being
 * evaluated is still the shipped text, not a retyped copy. It is the same 4-space
 * indent as the bundle's factory body, so the two concatenate directly. The
 * `require(...)` lines and the trailing `Object.assign(exports, …)` are dropped —
 * a lifted body supplies its own `React`/`document` parameters and returns the
 * names it wants.
 *
 * @param {string} pluginRoot - the repository root.
 * @returns {string} the kernel's declaration text, or '' when it is absent.
 */
export function clientKernelBlock (pluginRoot) {
  let source
  try {
    source = clientPartSource(pluginRoot, KERNEL_CHUNK)
  } catch (error) {
    // '' here means "the lifted body gets no kernel declarations", which reads
    // downstream as `ReferenceError: toastModel is not defined` — an error that
    // names the lifted snippet instead of the missing chunk.
    throw new Error(
      `client-source: cannot read the kernel chunk ${path.join(pluginRoot, CLIENT_DIR, KERNEL_CHUNK)} — a lifted body would fail with a ReferenceError that names the wrong file (${error.code ?? error.message})`
    )
  }
  const afterRequires = source.indexOf("const { jsx, jsxs, Fragment } = require('react/jsx-runtime')")
  if (afterRequires < 0) return ''
  const bodyStart = source.indexOf('\n', afterRequires) + 1
  const exportsAt = source.lastIndexOf('// The surface.')
  const bodyEnd = exportsAt < 0 ? source.length : source.lastIndexOf('\n    // ---------------------------------------------------------------------------', exportsAt)
  return source.slice(bodyStart, bodyEnd < 0 ? source.length : bodyEnd).replace(/\s+$/u, '')
}

/**
 * Every top-level declaration in a text, mapped to the text that defines it.
 *
 * A declaration runs from its own line to the line where the next one starts.
 * That range carries the comments that follow it — a `// ----` rule, a section
 * banner, the next declaration's doc block — and leaving those in is deliberate:
 * they are comments, so they cost nothing when the text is evaluated, and trying
 * to decide which of them "belong" to which declaration is exactly the kind of
 * guess that silently drops half a function.
 *
 * @param {string} source - file text, 4-space factory indent.
 * @returns {Map<string, string>} name to definition, in file order.
 */
function declarationsOf (source) {
  const found = new Map()
  for (const m of source.matchAll(/^ {4}(?:async )?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gmu)) {
    if (!found.has(m[1])) found.set(m[1], m.index)
  }
  const starts = [...found.entries()].sort((a, b) => a[1] - b[1])
  const out = new Map()
  for (let i = 0; i < starts.length; i += 1) {
    const [name, at] = starts[i]
    const next = i + 1 < starts.length ? starts[i + 1][1] : source.length
    out.set(name, source.slice(at, next).replace(/\s+$/u, ''))
  }
  return out
}

/**
 * A region of the browser half, plus every declaration it reaches from the parts
 * that are no longer in the same file, ready to evaluate with `new Function`.
 *
 * The browser half used to be one file, so a suite could slice a run of code out
 * of it and evaluate that run in isolation. It is now a bundle plus twelve
 * chunks, and a run in the bundle routinely calls into `client.kernel.js`. The
 * isolated slice then throws `ReferenceError: toastModel is not defined` — not
 * because the code is broken, but because the harness took a bite that no longer
 * closes over itself.
 *
 * The alternative to this helper is re-typing the missing helpers in each suite,
 * which would replace "the shipped code works" with "a copy of it works". This
 * resolves the closure instead: take the region, find the top-level names it
 * mentions but does not declare, and emit their real definitions — transitively,
 * in dependency order — ahead of the region.
 *
 * A name that appears in no part is a parameter of the `new Function` or a
 * browser/Node global, and is left alone.
 *
 * @param {string} pluginRoot - the repository root.
 * @param {object} options - what to lift.
 * @param {string} options.start - marker that begins the region.
 * @param {string} options.end - marker that ends it.
 * @param {string} [options.text] - source to search, when not the main bundle.
 * @param {string[]} [options.exclude] - names the caller supplies as parameters.
 * @returns {string} the region with everything it needs, or '' if a marker is missing.
 */
export function clientRegion (pluginRoot, options) {
  const bundle = clientPartSource(pluginRoot, 'client.js')
  const text = options.text ?? bundle
  const start = text.indexOf(options.start)
  if (start < 0) return ''
  const end = text.indexOf(options.end, start + options.start.length)
  if (end < 0) return ''
  const region = text.slice(start, end)

  // One flat pool over every part, so it does not matter which file a helper
  // ended up in — that is the property this whole split keeps moving.
  const pool = new Map()
  for (const [name, body] of declarationsOf(clientKernelBlock(pluginRoot))) pool.set(name, body)
  for (const [name, body] of declarationsOf(bundle)) if (!pool.has(name)) pool.set(name, body)

  const supplied = new Set(options.exclude ?? [])
  // Indentation is NOT assumed: a caller's start marker may begin mid-indent, so
  // the region's first line often arrives without its leading spaces. Matching
  // any leading whitespace only widens what counts as "the region declares this",
  // and a wrong widen shows up as a loud ReferenceError rather than a quiet pass.
  for (const m of region.matchAll(/^[ \t]*(?:async )?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gmu)) supplied.add(m[1])

  // Post-order walk: emit a declaration only after everything it needs, so a
  // `const` never appears after the code that reads it.
  const emitted = []
  const done = new Set()
  const visit = (name, trail) => {
    if (done.has(name) || supplied.has(name) || !pool.has(name)) return
    if (trail.has(name)) return
    trail.add(name)
    const body = pool.get(name)
    for (const next of mentionedNames(body)) visit(next, trail)
    done.add(name)
    emitted.push(body)
  }
  for (const name of mentionedNames(region)) visit(name, new Set())

  return [...emitted, region].join('\n')
}

export default { clientSource, clientChunkNames, clientPartSource, clientKernelBlock, clientRegion }
