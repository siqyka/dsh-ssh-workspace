/**
 * The HTML view route: one remote document, ready for an `<iframe>`.
 *
 * A preview of HTML cannot be the raw bytes: `./style.css` and `../img/x.png`
 * are relative to the DOCUMENT, and an iframe pointed at a query-string URL
 * would resolve them against that URL instead. Two designs exist for this —
 * serve the file from a path-shaped URL so the browser resolves relatives
 * itself (what Better Sidebar does), or rewrite every relative reference to an
 * absolute byte-route URL before handing the document over. The path-shaped
 * route needs a prefix-matching endpoint, and this host's route registry is
 * exact-path only; the rewrite keeps the same outcome on the surface we have.
 *
 * What the rewrite covers: `src`, `href` and `poster` attributes, and `url(...)`
 * inside inline styles. Absolute URLs, protocol-relative URLs and fragments are
 * left alone. Scripts are NOT run by default — the iframe is sandboxed — so a
 * document that builds its own URLs at runtime still works when the user
 * chooses to unlock scripts.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/view
 */

import { ROUTES } from './routes.js'
import { writeJson } from './kit.js'
import { readRemoteSlice } from './transfer-bytes.js'
import { rewriteHtmlReferences } from './html-rewrite.js'

/** How much of a document is served. Beyond this a preview is not worth it. */
const MAX_HTML_BYTES = 4 * 1024 * 1024

/** A URL that serves one remote file inline, with its real media type. */
function byteUrl (alias, remotePath) {
  const params = new URLSearchParams({ alias, path: remotePath, inline: '1' })
  return `${ROUTES.download}?${params.toString()}`
}

/**
 * Build the HTML view route descriptors.
 *
 * @param {object} options - { engine, guard }.
 * @returns {object[]} route descriptors.
 */
export function viewRoutes ({ engine, guard }) {
  return [
    {
      kind: 'exact',
      path: ROUTES.html,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = (url.searchParams.get('alias') ?? '').trim()
        const remotePath = (url.searchParams.get('path') ?? '').trim()
        if (alias === '' || remotePath === '') {
          writeJson(res, 400, { error: 'alias and path are required' })
          return
        }
        try {
          const { buffer, size } = await readRemoteSlice(engine, alias, remotePath, {
            offset: 0,
            length: MAX_HTML_BYTES,
          })
          if (size > MAX_HTML_BYTES) {
            writeJson(res, 413, {
              error: `document is ${size} bytes; the HTML view serves at most ${MAX_HTML_BYTES}`,
              code: 'HTML_TOO_LARGE',
            })
            return
          }
          const source = buffer.toString('utf8')
          const html = rewriteHtmlReferences(source, remotePath, (target) => byteUrl(alias, target))
          const body = Buffer.from(html, 'utf8')
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(body.length),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          res.end(body)
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          writeJson(res, 404, { error: text })
        }
      },
    },
  ]
}
