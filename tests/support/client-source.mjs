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

/** The browser half lives in its own directory; the Host serves a chunk from beside its owner. */
const CLIENT_DIR = path.join('lib', 'client')

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
  } catch {
    return []
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

export default { clientSource, clientChunkNames, clientPartSource }
