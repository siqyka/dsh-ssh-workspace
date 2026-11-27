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
import { resolveRemoteTarget } from './remote-target.js'
import { resolveLocalRead } from './local-bytes.js'
import { isRemotePath } from '../core/protocol.js'
import { readFile } from 'node:fs/promises'

/** How much of a document is served. Beyond this a preview is not worth it. */
const MAX_HTML_BYTES = 4 * 1024 * 1024

/** A URL that serves one file inline, with its real media type. */
function byteUrl (alias, path, sessionId) {
  const params = new URLSearchParams({ path, inline: '1' })
  if (alias !== '') params.set('alias', alias)
  else if (sessionId !== '') params.set('sessionId', sessionId)
  return `${ROUTES.download}?${params.toString()}`
}

/**
 * Build the HTML view route descriptors.
 *
 * @param {object} options - { engine, guard }.
 * @returns {object[]} route descriptors.
 */
export function viewRoutes ({ engine, guard, ctx }) {
  return [
    {
      kind: 'exact',
      path: ROUTES.html,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = (url.searchParams.get('alias') ?? '').trim()
        const rawPath = (url.searchParams.get('path') ?? '').trim()
        const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
        if (rawPath === '') {
          writeJson(res, 400, { error: 'path is required' })
          return
        }
        const remote = isRemotePath(rawPath) || alias !== ''
        const target = remote ? resolveRemoteTarget(alias, rawPath) : undefined
        if (remote && target === undefined) {
          writeJson(res, 400, { error: 'alias and path are required' })
          return
        }
        try {
          const local = remote ? undefined : await resolveLocalRead(ctx, { sessionId, path: rawPath })
          const { buffer, size } = remote
            ? await readRemoteSlice(engine, target.alias, target.remotePath, { offset: 0, length: MAX_HTML_BYTES })
            : { buffer: await readFile(local.absolute), size: local.size }
          if (size > MAX_HTML_BYTES) {
            writeJson(res, 413, {
              error: `document is ${size} bytes; the HTML view serves at most ${MAX_HTML_BYTES}`,
              code: 'HTML_TOO_LARGE',
            })
            return
          }
          const source = buffer.toString('utf8')
          const documentPath = remote ? target.remotePath : rawPath
          const documentAlias = remote ? target.alias : ''
          const html = rewriteHtmlReferences(source, documentPath, (url) => byteUrl(documentAlias, url, sessionId))
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
