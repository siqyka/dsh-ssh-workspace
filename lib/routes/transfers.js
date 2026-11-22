/**
 * The routes that move bytes: transfer, download, download tree, upload.
 *
 * Five routes, one subject, and the one place in this plugin where a request
 * carries or returns more than a JSON body. They live together because the
 * decisions they share are not obvious from any single one of them: the size
 * cap has to be applied before the response headers go out, an abandoned
 * request has to abort the walk rather than finish it into a socket nobody
 * reads, and the upload route has to join the host deadline window instead of
 * raising it a second time.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/transfers
 */

import { sftpStatOrNull } from '../fs/remote-fs.js'
import { DEFAULT_MAX_BYTES, archiveNameOf, downloadTree, downloadTreeAsArchive, oversizeMessage, transferFile, uploadTree } from '../transfer/transfer.js'
import { abortOnClientGone, codedError, readJsonBody, statusForActionError, statusForDownloadError, trimmedParam, writeJson } from './kit.js'
import { basenameOf, contentDispositionValue, openRemoteRead, readUploadText, writeRemoteFromRequest, writeUploadChunk, writeUploadText } from './transfer-bytes.js'
import { ROUTES } from './routes.js'

/**
 * Build the transfer route descriptors.
 *
 * @param {Function} deps.guardRaw - the raw-bytes guard from the route kit.
 */
export function transferRoutes ({ engine, router, guard, guardRaw, openUploadWindow }) {
  return [
    // ---- move a file between this machine and a host
    {
      kind: 'exact',
      path: ROUTES.transfer,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const direction = body?.direction === 'download' ? 'download' : body?.direction === 'upload' ? 'upload' : ''
        const localPath = typeof body?.localPath === 'string' ? body.localPath.trim() : ''
        const remotePath = typeof body?.remotePath === 'string' ? body.remotePath.trim() : ''
        if (alias === '') { writeJson(res, 400, { error: 'alias is required' }); return }
        if (direction === '') { writeJson(res, 400, { error: 'direction must be upload or download' }); return }
        if (localPath === '') { writeJson(res, 400, { error: 'localPath is required' }); return }
        if (remotePath === '') { writeJson(res, 400, { error: 'remotePath is required' }); return }
        try {
          router.assertEnabled(alias, remotePath)
          // `recursive` means "the whole tree", in BOTH directions: it already
          // walked a local tree up, and it now walks a remote tree down. The
          // asymmetry existed only because the browser had no way to name a
          // destination directory — it wrote through a `FileSystemDirectoryHandle`
          // or fell back to one save dialog per file. With a real destination
          // path in hand (the host's own folder chooser), a directory row
          // becomes a FOLDER on this machine, which is what "download this
          // folder into there" means everywhere else.
          const recursive = body?.recursive === true
          // A cancelled request must stop the WALK, not just the answer: the
          // client's abort closes the connection, and without a signal here the
          // route would keep pulling a whole tree from the host into a folder
          // nobody is waiting for any more.
          const signal = abortOnClientGone(res)
          if (recursive && direction === 'download') {
            const result = await downloadTree(engine, {
              alias,
              localPath,
              remotePath,
              signal,
              onConflict: body?.onConflict,
            })
            writeJson(res, 200, {
              ok: true,
              bytes: result.bytes,
              files: result.files,
              ...(result.skipped === 0 ? {} : { skippedFiles: result.skipped }),
              ...(result.excluded === 0 ? {} : { excludedPaths: result.excluded }),
              ...(result.links.length === 0 ? {} : { skippedLinks: result.links }),
            })
            return
          }
          const result = recursive && direction === 'upload'
            ? await uploadTree(engine, { alias, localPath, remotePath, roots: router.roots, onConflict: body?.onConflict })
            : await transferFile(engine, {
              alias,
              direction,
              localPath,
              remotePath,
              roots: router.roots,
              signal,
              onConflict: body?.onConflict,
              verify: body?.verify === true,
              resume: body?.resume === true,
            })
          writeJson(res, 200, {
            ok: true,
            bytes: result.bytes,
            ...(result.files !== undefined ? { files: result.files } : {}),
            ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
            ...(result.path === undefined ? {} : { path: result.path }),
            ...(result.note === undefined ? {} : { note: result.note }),
            ...(result.verified === undefined ? {} : { verified: result.verified }),
            ...(result.verification === undefined ? {} : { verification: result.verification }),
          })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- stream one remote file to the browser
    //
    // Separate from `transfer` on purpose: that route moves a file to a path on
    // THIS machine (a tool-shaped, JSON answer), while the browser needs the
    // bytes themselves. Streaming them out keeps a download from being decoded
    // into a JSON string, which would inflate it and cap it at the body limit.
    {
      kind: 'exact',
      path: ROUTES.download,
      handler: async (req, res) => {
        if (!guardRaw(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = trimmedParam(url, 'alias')
        const remotePath = trimmedParam(url, 'path')
        if (alias === '' || remotePath === '') {
          writeJson(res, 400, { error: 'alias and path are required' })
          return
        }
        try {
          const { size, chunks, close } = await openRemoteRead(engine, alias, remotePath, router)
          // The same limit the tool and the upload route apply. Without it the
          // panel could stream a file the agent's own `download` refuses, and
          // the refusal has to happen BEFORE `writeHead` — once the status line
          // is out, a 200 with an error body is indistinguishable from content.
          if (size > DEFAULT_MAX_BYTES) {
            await close()
            writeJson(res, 413, { error: oversizeMessage('download', size) })
            return
          }
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(size),
            'content-disposition': contentDispositionValue('attachment', basenameOf(remotePath)),
          })
          // Backpressure and cancellation, both of which the old loop ignored.
          //
          // `write()` returning false means the kernel buffer is full: carrying
          // on would queue the whole file in memory for a slow client. Waiting
          // for 'drain' keeps memory bounded to one chunk.
          //
          // A closed connection (the user cancelled the download, or closed the
          // tab) must stop the REMOTE read too, or the host keeps streaming a
          // file nobody will receive. `req` is the right event for that: it is
          // the request's own lifecycle.
          let cancelled = false
          const onClose = () => { cancelled = true }
          req.once?.('close', onClose)
          res.once?.('close', onClose)
          try {
            for await (const chunk of chunks) {
              if (cancelled) break
              if (!res.write(chunk)) {
                await new Promise((resolve) => {
                  const done = () => { res.off?.('drain', done); resolve() }
                  res.once('drain', done)
                  // A response that closes while we wait must not hang here.
                  res.once('close', done)
                })
              }
            }
          } finally {
            req.off?.('close', onClose)
            res.off?.('close', onClose)
            // Closing the read is what releases the connection hold. The
            // generator's own `finally` does this too when the loop ends
            // normally or breaks; `close` is idempotent, so calling it here
            // covers the paths where the generator is never entered at all
            // (an abort between the open and the first chunk) and guarantees
            // the hold cannot outlive the request.
            await close()
          }
          res.end()
        } catch (error) {
          if (!res.headersSent) {
            // A failure must not look like a download. Answering 200 here used
            // to make the browser save the JSON error body under the remote
            // file's name: the client keys on `response.ok`, and a 200 blob of
            // `{"error":"..."}` is indistinguishable from file content once the
            // headers are gone. The status is the only channel the browser's
            // download flow respects, so it carries the failure.
            writeJson(res, statusForDownloadError(error), { error: error instanceof Error ? error.message : String(error) })
            return
          }
          res.end()
        }
      },
    },
    // ---- stream a whole remote DIRECTORY to the browser as one archive
    //
    // The panel's folder row used to say "downloading a whole directory is not
    // supported yet" while the agent's own tool could do it: the capability was
    // true of the model and false of the person clicking. A browser cannot be
    // handed a directory, so the shape that works is an archive — one file, one
    // download flow, produced as it is read rather than staged on disk first.
    //
    // ZIP is the default because it is what the downloading machine can open
    // without extra software; `?format=tar` asks for the tar stream instead.
    {
      kind: 'exact',
      path: ROUTES.downloadTree,
      handler: async (req, res) => {
        if (!guardRaw(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = trimmedParam(url, 'alias')
        const remotePath = trimmedParam(url, 'path')
        if (alias === '' || remotePath === '') {
          writeJson(res, 400, { error: 'alias and path are required' })
          return
        }
        const exclude = url.searchParams.getAll('exclude').flatMap(value => value.split(','))
        // Anything other than an explicit `tar` is zip: the format that works
        // by default on the machine doing the downloading, so a request with no
        // opinion gets the one the user can act on.
        const format = url.searchParams.get('format') === 'tar' ? 'tar' : 'zip'
        try {
          router?.assertEnabled?.(alias, remotePath)
          // The directory has to exist and has to BE a directory before the
          // status line: once headers are out, "that was a file" can only be
          // signalled by a truncated archive, which a reader reports as corrupt.
          const kind = await engine.withSftp(alias, async (sftp) => {
            const info = await sftpStatOrNull(sftp, remotePath)
            if (info === null) throw codedError(`remote path does not exist: ${remotePath}`, 'FS_NOT_FOUND')
            return typeof info.isDirectory === 'function' && info.isDirectory() ? 'directory' : 'file'
          }, { kind: 'read' })
          if (kind !== 'directory') {
            writeJson(res, 400, { error: `not a directory: ${remotePath} — use /download for a single file` })
            return
          }
          const archive = await downloadTreeAsArchive(engine, { alias, remotePath, exclude, format })
          res.writeHead(200, {
            'content-type': archive.format === 'tar' ? 'application/x-tar' : 'application/zip',
            // No `content-length`: the archive is streamed as the tree is read,
            // so its size is unknown until the last entry. Chunked is the honest
            // answer, and the browser's progress is then "indeterminate" — which
            // the client states instead of drawing a fake percentage.
            'content-disposition': contentDispositionValue('attachment', archiveNameOf(remotePath, archive.format)),
            'cache-control': 'no-store',
          })
          let cancelled = false
          const onClose = () => { cancelled = true }
          req.once?.('close', onClose)
          res.once?.('close', onClose)
          try {
            for await (const chunk of archive.stream) {
              if (cancelled) break
              if (!res.write(chunk)) {
                await new Promise((resolve) => {
                  const done = () => { res.off?.('drain', done); res.off?.('close', done); resolve() }
                  res.once('drain', done)
                  res.once('close', done)
                })
              }
            }
          } finally {
            req.off?.('close', onClose)
            res.off?.('close', onClose)
          }
          res.end()
        } catch (error) {
          if (!res.headersSent) {
            writeJson(res, statusForDownloadError(error), { error: error instanceof Error ? error.message : String(error) })
            return
          }
          // Headers are out, so the only honest signal left is a cut stream: the
          // browser saves a truncated archive and the reader reports it as
          // corrupt. `res.destroy` is what says that, rather than a clean `end`
          // pretending the archive is complete.
          res.destroy?.(error instanceof Error ? error : new Error(String(error)))
        }
      },
    },
    // ---- receive one CHUNK of a file, as JSON
    //
    // The desktop shell serves this plugin's pages from `dsh-app://app/`, and a
    // request whose body is a `File`/`Blob` never reaches a handler there: the
    // network service fails the load with `net::ERR_UNEXPECTED` — the message
    // the panel showed as `上传失败: 请求在 0 秒后中断` — before any handler runs,
    // which is why the failure looks instantaneous and why the server logged
    // nothing. A JSON body is the transport every other action in this plugin
    // already uses and it demonstrably survives that scheme, so the same bytes
    // travel base64-encoded, a bounded chunk per request.
    //
    // Deliberately STATELESS: the client names its own upload (`uploadId`) and
    // the staging path is derived from it, so a chunk may arrive on any
    // connection without a server-side table — the pool is free to hand each
    // request a different SFTP channel.
    {
      kind: 'exact',
      path: ROUTES.uploadChunk,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const dir = typeof body?.path === 'string' ? body.path.trim() : ''
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        const uploadId = typeof body?.uploadId === 'string' ? body.uploadId.trim() : ''
        const offset = body?.offset
        const data = typeof body?.data === 'string' ? body.data : ''
        // A probe asks "what does the staging file already hold?" without
        // sending bytes; every other field is shared with a real chunk so the
        // two shapes stay one protocol rather than two.
        const probe = body?.probe === true
        const identity = typeof body?.identity === 'string' ? body.identity.trim() : ''
        const totalBytes = body?.totalBytes
        const sha256 = typeof body?.sha256 === 'string' ? body.sha256.trim().toLowerCase() : ''
        if (alias === '' || dir === '' || name === '') {
          writeJson(res, 400, { error: 'alias, path and name are required' })
          return
        }
        if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          writeJson(res, 400, { error: 'name must be a single path segment' })
          return
        }
        // The id becomes a path segment, so it is held to a shape that cannot
        // spell anything but itself.
        if (!/^[0-9a-f]{16,48}$/u.test(uploadId)) {
          writeJson(res, 400, { error: 'uploadId must be 16-48 hexadecimal characters' })
          return
        }
        if (identity !== '' && (identity.length > 160 || !/^[0-9A-Za-z:._-]+$/u.test(identity))) {
          writeJson(res, 400, { error: 'identity must be a short source identity string' })
          return
        }
        if (sha256 !== '' && !/^[0-9a-f]{64}$/u.test(sha256)) {
          writeJson(res, 400, { error: 'sha256 must be 64 hexadecimal characters' })
          return
        }
        if (probe) {
          if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > DEFAULT_MAX_BYTES) {
            writeJson(res, 400, { error: 'probe requires totalBytes within the size limit' })
            return
          }
        } else {
          if (!Number.isInteger(offset) || offset < 0 || offset > DEFAULT_MAX_BYTES) {
            writeJson(res, 400, { error: 'offset must be a non-negative integer within the size limit' })
            return
          }
          // Base64 only, checked before decoding: `Buffer.from(x,'base64')`
          // silently DROPS anything it does not recognise, so a corrupted request
          // would otherwise become a shorter file that still reports success.
          if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
            writeJson(res, 400, { error: 'data must be base64' })
            return
          }
        }
        const bytes = data === '' ? Buffer.alloc(0) : Buffer.from(data, 'base64')
        const remotePath = dir === '/' ? `/${name}` : `${dir.replace(/\/+$/u, '')}/${name}`
        try {
          const result = await writeUploadChunk(engine, router, {
            alias,
            remotePath,
            uploadId,
            offset: probe ? 0 : offset,
            bytes,
            final: body?.final === true,
            abort: body?.abort === true,
            probe,
            identity,
            totalBytes: Number.isInteger(totalBytes) ? totalBytes : undefined,
            sha256,
            verify: body?.verify === true,
            onConflict: body?.onConflict,
          })
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- receive one file from the browser and write it to the host
    //
    // The browser posts the raw bytes as the request body (application/
    // octet-stream) rather than multipart: one file per request keeps the
    // streaming simple and avoids a multipart parser in the bundler-loaded
    // client. `path` names the remote directory, `name` the file inside it.
    {
      kind: 'exact',
      path: ROUTES.upload,
      handler: async (req, res) => {
        // The raw-bytes guard: loopback + Host + method + the octet-stream
        // media type, so a cross-site form cannot reach this write path.
        if (!guardRaw(req, res, 'POST')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = trimmedParam(url, 'alias')
        const dir = trimmedParam(url, 'path')
        const name = trimmedParam(url, 'name')
        if (alias === '' || dir === '' || name === '') {
          writeJson(res, 400, { error: 'alias, path and name are required' })
          return
        }
        // A name is one path segment: a slash would let a request escape the
        // directory the user is looking at.
        if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          writeJson(res, 400, { error: 'name must be a single path segment' })
          return
        }
        const remotePath = dir === '/' ? `/${name}` : `${dir.replace(/\/+$/u, '')}/${name}`
        // The host receives this request under its own whole-request deadline,
        // which is five minutes by default and was measured closing the socket
        // at 315 s. An upload is the one request whose duration is decided by
        // the network rather than by the work: 1 GiB takes longer than that on
        // any link below ~3.4 MB/s, and the browser reports the cut-off as
        // `Failed to fetch` — a message that names neither the size nor the
        // deadline. The window is opened around the body read only, and closed
        // again as soon as it ends, so no other route inherits it.
        const releaseWindow = openUploadWindow(res)
        try {
          const written = await writeRemoteFromRequest(engine, alias, remotePath, req, router)
          writeJson(res, 200, { ok: true, bytes: written, remotePath })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        } finally {
          releaseWindow()
        }
      },
    },
  ]
}
