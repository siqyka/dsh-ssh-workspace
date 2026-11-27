/**
 * Rewrite the relative references of an HTML preview.
 *
 * A preview of HTML cannot be the raw bytes: `./style.css` and `../img/x.png`
 * are relative to the DOCUMENT, and an iframe pointed at a query-string URL
 * resolves them against that URL instead. Serving the file from a path-shaped
 * URL lets the browser resolve relatives itself; this host's route registry is
 * exact-path only, so the references are rewritten to absolute byte-route URLs
 * before the document is handed over.
 *
 * Dependency-free on purpose: the route supplies `byteUrl`, and the rule can be
 * tested without an SSH engine.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/html-rewrite
 */

import { posix } from 'node:path'

/** Remote directory of a path, POSIX rules. */
export function remoteDirOf (path) {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

/**
 * Rewrite relative references so an iframe can find them.
 *
 * Covers `src`, `href` and `poster` attributes plus `url(...)` inside inline
 * styles. A scheme, a protocol-relative URL (so a `data:` URI) and a fragment
 * are left alone; a root-relative path is resolved against the remote root,
 * which is where the browser would have looked.
 *
 * @param {string} html - document source.
 * @param {string} documentPath - absolute remote path of the document.
 * @param {(remotePath: string) => string} byteUrl - builds the URL of one file.
 * @returns {string} the document with absolute URLs.
 */
export function rewriteHtmlReferences (html, documentPath, byteUrl) {
  const source = String(html ?? '')
  const baseDir = remoteDirOf(String(documentPath ?? '/'))
  const resolve = (value) => {
    const reference = String(value ?? '').trim()
    if (reference === '') return value
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(reference)) return value
    if (reference.startsWith('/')) return byteUrl(posix.normalize(reference))
    const joined = posix.normalize(posix.join(baseDir, reference))
    return byteUrl(joined.startsWith('/') ? joined : `/${joined}`)
  }
  return source
    .replace(
      /\b(src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu,
      (whole, attribute, doubleQuoted, singleQuoted) => {
        const value = doubleQuoted ?? singleQuoted ?? ''
        const next = resolve(value)
        return next === value ? whole : `${attribute}="${next}"`
      },
    )
    .replace(
      /url\(\s*(['"]?)([^'")]+)\1\s*\)/giu,
      (whole, quote, value) => {
        const next = resolve(value)
        return next === value ? whole : `url(${quote}${next}${quote})`
      },
    )
}
