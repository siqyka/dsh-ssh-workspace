/**
 * The byte-moving helpers behind the transfer routes.
 *
 * These are not routes: they are the four things a route has to do once it
 * has decided to move bytes — stage a write, publish it by rename, bound it,
 * and stream a read back with the headers a browser needs to save it. They
 * live beside the routes that call them because every one of them exists to
 * satisfy a constraint those routes share: never let a reader observe a
 * half-written destination, and never let a failure inherit the promises of
 * the success it replaced.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/transfer-bytes
 */

import { DEFAULT_MAX_BYTES, fenceUploadTarget, oversizeMessage, remoteParentOf, sftpUnlink, stagingNameOf } from '../transfer.js'
import { isWithinLocalRoot } from '../transfer-rules.js'
import {
  compareDigests, decideConflict, findRemoteHasher, hashRemoteFile,
  normalizeConflictPolicy, parseResumeRecord, planResume, resumeRecord, resumeSidecarName,
} from '../transfer-rules.js'
import { sftpCloseHandle, sftpMkdirp, sftpOpenHandle, sftpPublishRename, sftpReadHandle, sftpStatOrNull, sftpWriteHandle } from '../remote-fs.js'
import { codedError } from './kit.js'
/**
 * Stream a request body into one remote file.
 *
 * The bytes go straight from the HTTP request into SFTP without buffering the
 * whole body: an upload can be far larger than what a JSON body limit allows,
 * and holding it in memory would defeat the point of streaming.
 *
 * Publication matches the filesystem half: write a sibling staging name, then
 * rename. A reader therefore never observes a half-written destination.
 *
 * @param {object} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} remotePath - absolute destination path.
 * @param {import('node:http').IncomingMessage} req - the request carrying the bytes.
 * @param {object} [router] - the filesystem router: the detached fence and the
 *   served-root set an upload is fenced against.
 * @returns {Promise<number>} how many bytes were written.
 */
export async function writeRemoteFromRequest (engine, alias, remotePath, req, router) {
  router?.assertEnabled?.(alias, remotePath)
  // The same limit the agent's tool applies, applied before any byte is staged.
  //
  // Two layers on purpose. A declared `content-length` is the cheap check and
  // gives the user an immediate answer; it is also CLIENT-SUPPLIED, so a
  // chunked or lying request would sail past it. The running total below is the
  // one that actually bounds the write. Checking only the header would be the
  // "looks enforced, is not" shape this repository keeps finding.
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > DEFAULT_MAX_BYTES) {
    throw codedError(oversizeMessage('upload', declared), 'FS_TOO_LARGE')
  }
  return await engine.withSftp(alias, async (sftp) => {
    // The same reachability fence `write` and the transfer tool apply, run
    // before a single byte is staged. The browser panel reaches this route
    // directly, so without it a path outside every mounted workspace — or one
    // whose parent is a symlink escaping them — would land here while the model's
    // own `write` was refused. Policy (mode / session scope) is deliberately not
    // decided here: this is a user action on a directory the panel is showing,
    // and the mounted-root fence is the answer it owes.
    await fenceUploadTarget(sftp, alias, remotePath, router?.roots)
    await sftpMkdirp(sftp, remoteParentOf(remotePath), remotePath)
    // The SAME staging name the agent's transfer tool uses, for the same reason
    // (see `stagingNameOf` in transfer.js): the old spelling here was
    // `pid-Date.now().toString(36)`, so two browser uploads to one destination
    // started in the same millisecond shared a staging path, opened it `'w'`,
    // interleaved their bytes, and the loser's cleanup deleted the file the
    // winner was still writing — the exact accident O-07 fixed on the tool path
    // while this route kept it. Random suffix makes a collision improbable;
    // `'wx'` turns a rare one into a retry instead of corruption.
    const staging = stagingNameOf(remotePath, 'up')
    let handle
    let written = 0
    try {
      handle = await sftpOpenHandle(sftp, staging, 'wx', remotePath)
      for await (const chunk of req) {
        // The offset this chunk belongs at, taken BEFORE the counter advances.
        //
        // `sftpWriteHandle` defaults `startAt` to 0, and the loop used to omit
        // it — so every chunk was written to offset 0 of the staging file and
        // each one OVERWROTE the last. A 700 MB upload landed as one 64 KiB
        // chunk while the route still reported `{ok: true, bytes: 734003200}`
        // and published that fragment under the destination name: silent
        // truncation, with a success response. Measured against a real host —
        // the file on disk was 65536 bytes.
        const offset = written
        written += chunk.length
        // The authoritative bound: a request that under-declared its size (or
        // declared nothing) stops HERE, mid-stream, rather than filling the
        // host's disk. The staging file is removed by the catch below, so a
        // refused upload leaves the destination untouched.
        if (written > DEFAULT_MAX_BYTES) throw codedError(oversizeMessage('upload', written), 'FS_TOO_LARGE')
        await sftpWriteHandle(sftp, handle, chunk, remotePath, offset)
      }
      await sftpCloseHandle(sftp, handle)
      handle = undefined
      await sftpPublishRename(sftp, staging, remotePath, remotePath)
      return written
    } catch (error) {
      if (handle !== undefined) { try { await sftpCloseHandle(sftp, handle) } catch { /* already gone */ } }
      try { await sftpUnlink(sftp, staging) } catch { /* staging never created */ }
      throw error
    }
  }, { kind: 'write' })
}

/**
 * Append one decoded chunk to a staged upload, and publish it on the last one.
 *
 * The staging name is DETERMINISTIC (it carries the client's `uploadId`), which
 * is the whole reason this survives the request boundary: no chunk has to find
 * server-side state from a previous one. Two concurrent uploads get different
 * ids and therefore different staging files; the same id restarted at offset 0
 * truncates what a previous attempt left, which is the only honest meaning of
 * "start over".
 *
 * Every later chunk opens `r+` rather than `w`. That is not cosmetic: `w` would
 * discard the prefix the earlier chunks already wrote, and a staging file that
 * vanished (a lost session, a cleaned tmp) must fail loudly here instead of
 * producing a destination that silently begins mid-file.
 *
 * @param {object} engine - live engine.
 * @param {object} router - the filesystem router, for the detached fence.
 * @param {object} request - one chunk.
 * @param {string} request.alias - host alias.
 * @param {string} request.remotePath - absolute destination path.
 * @param {string} request.uploadId - the client's upload identity (hex).
 * @param {number} request.offset - where these bytes belong.
 * @param {Buffer} request.bytes - the decoded chunk.
 * @param {boolean} request.final - publish after this chunk.
 * @param {boolean} request.abort - discard the staging file instead.
 * @returns {Promise<object>} what the client needs to continue.
 */
export async function writeUploadChunk (engine, router, request) {
  const { alias, remotePath, uploadId, offset, bytes, final, abort } = request
  router?.assertEnabled?.(alias, remotePath)
  if (request.probe !== true && offset + bytes.length > DEFAULT_MAX_BYTES) {
    throw codedError(oversizeMessage('upload', offset + bytes.length), 'FS_TOO_LARGE')
  }
  const staging = `${remotePath.replace(/\/+$/u, '')}.dsh-up-${uploadId}`
  const sidecar = resumeSidecarName(staging)
  const hasIdentity = typeof request.identity === 'string' && request.identity !== ''
  const outcome = await engine.withSftp(alias, async (sftp) => {
    // The same fence the raw route applies, before anything is staged: this is
    // a second door to the same write, so it owes the same refusal.
    await fenceUploadTarget(sftp, alias, remotePath, router?.roots)
    if (request.probe === true) {
      // A probe is the only request that may run before a byte is sent. It
      // answers where a previous attempt stopped, and it discards a staged
      // prefix the caller cannot prove belongs to the source it is sending now.
      const staged = await sftpStatOrNull(sftp, staging)
      const record = parseResumeRecord(await readUploadText(sftp, sidecar))
      const plan = planResume({
        partialBytes: staged?.size ?? 0,
        recordedIdentity: record?.identity,
        currentIdentity: request.identity,
        totalBytes: Number.isInteger(request.totalBytes) ? request.totalBytes : 0,
      })
      if (plan.resume !== true && (staged?.size ?? 0) > 0) {
        try { await sftpUnlink(sftp, staging) } catch { /* already gone */ }
        try { await sftpUnlink(sftp, sidecar) } catch { /* already gone */ }
      }
      return {
        bytes: plan.resume === true ? plan.offset : 0,
        offset: plan.resume === true ? plan.offset : 0,
        resume: plan.resume === true,
        reason: plan.reason,
        ...(plan.resume === true ? {} : { discarded: (staged?.size ?? 0) > 0 }),
      }
    }
    if (abort === true) {
      try { await sftpUnlink(sftp, staging) } catch { /* nothing was staged */ }
      try { await sftpUnlink(sftp, sidecar) } catch { /* nothing was staged */ }
      return { aborted: true }
    }
    await sftpMkdirp(sftp, remoteParentOf(remotePath), remotePath)

    // Before the FIRST byte of an attempt (and again before publication), the
    // destination's current state decides what "overwrite" means. A retry that
    // starts at a staged offset still runs this check at publication, because
    // the destination may have changed while the transfer was paused.
    const decide = async () => await decideConflict({
      policy: normalizeConflictPolicy(request.onConflict),
      exists: (await sftpStatOrNull(sftp, remotePath)) !== null,
      destination: remotePath,
      existsAt: async candidate => (await sftpStatOrNull(sftp, candidate)) !== null,
    })
    if (offset === 0) {
      const decision = await decide()
      if (decision.action === 'skip') return { bytes: 0, skipped: true, note: decision.note }
      if (decision.action === 'refuse') throw new Error(decision.note ?? 'the destination already exists')
    }

    if (offset > 0) {
      // The staged prefix must be EXACTLY the bytes the caller believes are
      // there: a missing file is a restart, and a length mismatch means the
      // caller's offset would either duplicate or skip a region.
      const info = await sftpStatOrNull(sftp, staging)
      if (info === null) throw codedError(`${remotePath}.dsh-up-${uploadId} has gone — start the upload again`, 'FS_NOT_FOUND')
      if (typeof info.size === 'number' && info.size !== offset) {
        throw codedError(`the staged upload holds ${info.size} bytes, not ${offset} — start the upload again`, 'FS_CONFLICT')
      }
      if (hasIdentity) {
        const record = parseResumeRecord(await readUploadText(sftp, sidecar))
        if (record === undefined) throw codedError('the staged upload has no identity record — start the upload again', 'FS_NOT_FOUND')
        if (record.identity !== request.identity) {
          // The prefix is from another source; appending this attempt's tail
          // would produce a right-length file with wrong content.
          try { await sftpUnlink(sftp, staging) } catch { /* already gone */ }
          try { await sftpUnlink(sftp, sidecar) } catch { /* already gone */ }
          throw codedError('the source changed since the staged bytes were written — start the upload again', 'FS_CONFLICT')
        }
      }
    }

    if (hasIdentity) {
      await writeUploadText(sftp, sidecar, JSON.stringify({
        ...resumeRecord({
          identity: request.identity,
          totalBytes: Number.isInteger(request.totalBytes) ? request.totalBytes : 0,
          source: remotePath,
        }),
        ...(typeof request.sha256 === 'string' && request.sha256 !== '' ? { sha256: request.sha256 } : {}),
      }))
    }

    if (bytes.length > 0 || offset === 0) {
      // A zero-byte file still has to EXIST after its single chunk, so offset 0
      // always opens the staging file even when it carries no bytes.
      const handle = await sftpOpenHandle(sftp, staging, offset === 0 ? 'w' : 'r+', remotePath)
      try {
        if (bytes.length > 0) await sftpWriteHandle(sftp, handle, bytes, remotePath, offset)
      } finally {
        await sftpCloseHandle(sftp, handle)
      }
    } else {
      // A later chunk of empty data: nothing to write. The stat above already
      // proved the prefix is there and at the expected offset.
    }
    if (final !== true) return { bytes: offset + bytes.length }

    // Publication re-decides the conflict, so a destination that appeared or
    // changed during a pause is handled by the CURRENT policy, not the one in
    // force when staging began.
    const decision = await decide()
    if (decision.action === 'skip') {
      try { await sftpUnlink(sftp, staging) } catch { /* already gone */ }
      try { await sftpUnlink(sftp, sidecar) } catch { /* already gone */ }
      return { bytes: offset + bytes.length, skipped: true, note: decision.note }
    }
    if (decision.action === 'refuse') throw new Error(decision.note ?? 'the destination already exists')
    const publishTo = decision.path ?? remotePath
    if (publishTo !== remotePath) await fenceUploadTarget(sftp, alias, publishTo, router?.roots)
    await sftpPublishRename(sftp, staging, publishTo, remotePath)
    try { await sftpUnlink(sftp, sidecar) } catch { /* already gone */ }
    return {
      bytes: offset + bytes.length,
      published: true,
      remotePath: publishTo,
      // Verification runs AFTER this sftp callback returns: hashing the remote
      // file needs an exec channel, and holding a write channel while opening
      // another one is a needless constraint on the engine's pool.
      ...(request.verify === true && typeof request.sha256 === 'string' && request.sha256 !== ''
        ? { verifyDigest: request.sha256, verifyPath: publishTo }
        : {}),
    }
  }, { kind: 'write' })

  const { verifyDigest, verifyPath, ...result } = outcome
  if (typeof verifyDigest !== 'string') return result
  const hasher = await findRemoteHasher(engine, alias)
  if (hasher === undefined) {
    return { ...result, verified: false, verification: 'no sha256 tool (sha256sum / shasum / openssl) on the host, so the copy could not be verified' }
  }
  const actual = await hashRemoteFile(engine, alias, verifyPath, hasher)
  const verdict = compareDigests(verifyDigest, actual)
  return verdict.ok
    ? { ...result, verified: true }
    : { ...result, verified: false, verification: verdict.reason }
}

/**
 * Read a small remote text file (the resumable-upload sidecar), or null.
 *
 * @param {object} sftp - SFTP channel.
 * @param {string} remotePath - the text file.
 * @returns {Promise<string|null>} its contents.
 */
export async function readUploadText (sftp, remotePath) {
  const info = await sftpStatOrNull(sftp, remotePath)
  if (info === null) return null
  const handle = await sftpOpenHandle(sftp, remotePath, 'r', remotePath)
  try {
    const chunks = []
    let position = 0
    for (;;) {
      const chunk = await sftpReadHandle(sftp, handle, position, 64 * 1024, remotePath)
      if (chunk.length === 0) break
      chunks.push(chunk)
      position += chunk.length
      if (position > 1024 * 1024) break
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await sftpCloseHandle(sftp, handle)
  }
}

/**
 * Write a small remote text file, replacing it.
 *
 * @param {object} sftp - SFTP channel.
 * @param {string} remotePath - the text file.
 * @param {string} body - its contents.
 * @returns {Promise<void>} resolves once written.
 */
export async function writeUploadText (sftp, remotePath, body) {
  const handle = await sftpOpenHandle(sftp, remotePath, 'w', remotePath)
  try {
    await sftpWriteHandle(sftp, handle, Buffer.from(body, 'utf8'), remotePath)
  } finally {
    await sftpCloseHandle(sftp, handle)
  }
}


/**
 * Open one remote file for chunked reading.
 *
 * @param {object} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} remotePath - absolute remote path.
 * @param {object} [router] - the filesystem router, used for the detached fence.
 * @returns {Promise<{size: number, chunks: AsyncGenerator<Buffer>}>} the size and a chunk stream.
 */
export async function openRemoteRead (engine, alias, remotePath, router) {
  router?.assertEnabled?.(alias, remotePath)
  return await engine.withSftp(alias, async (sftp, record) => {
    const info = await sftpStatOrNull(sftp, remotePath)
    if (info === null) throw codedError(`remote file does not exist: ${remotePath}`, 'FS_NOT_FOUND')
    if (typeof info.isDirectory === 'function' && info.isDirectory()) {
      throw codedError(`not a file: ${remotePath}`, 'FS_NOT_REGULAR_FILE')
    }
    const size = typeof info.size === 'number' ? info.size : 0
    // Pin the connection for as long as the stream is open.
    //
    // `withSftp` tracks its callback with `inFlight`, which is decremented when
    // the callback RETURNS — but this callback returns a generator, so the read
    // happens afterwards. Between those two moments the record looked idle, and
    // a download slower than `engine.idleTimeoutMs` (30 minutes by default)
    // would have its connection reaped mid-transfer: the remaining chunks come
    // from a closed SFTP channel. `holds` is the sweeper's long-lived-consumer
    // counter, the same one open port forwards and persistent shells use, so
    // pinning here is the existing mechanism rather than a new one.
    let held = record !== undefined && record !== null && typeof record.holds === 'number'
    if (held) {
      record.holds += 1
      record.idleAt = Date.now()
    }
    const releaseHold = () => {
      if (!held) return
      held = false
      record.holds = Math.max(0, record.holds - 1)
      record.idleAt = Date.now()
    }
    let handle
    try {
      handle = await sftpOpenHandle(sftp, remotePath, 'r', remotePath)
    } catch (error) {
      // Nothing is streaming, so the hold has nothing left to protect.
      releaseHold()
      throw error
    }
    let position = 0
    let closed = false
    const closeOnce = async () => {
      if (closed) return
      closed = true
      try { await sftpCloseHandle(sftp, handle) } catch { /* already gone */ }
      releaseHold()
    }
    async function * generate () {
      try {
        for (;;) {
          const chunk = await sftpReadHandle(sftp, handle, position, 256 * 1024, remotePath)
          if (chunk.length === 0) break
          position += chunk.length
          yield chunk
        }
      } finally {
        await closeOnce()
      }
    }
    return { size, chunks: generate(), close: closeOnce }
  })
}

/** The final path segment, for the downloaded filename. */
export function basenameOf (remotePath) {
  const trimmed = String(remotePath).replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  return (index < 0 ? trimmed : trimmed.slice(index + 1)).replaceAll('"', '_') || 'download'
}

/**
 * A `Content-Disposition` value that node will actually accept.
 *
 * Header values are Latin-1 at most (RFC 7230 §3.2), while a remote file name
 * is UTF-8. Putting the name straight into the header made `res.writeHead`
 * throw `ERR_INVALID_CHAR ("Invalid character in header content")` — and since
 * that throw happens AFTER the status and length were prepared, the caller saw
 * a 500 whose body claimed the file was missing bytes. Every download of a file
 * whose name was not ASCII failed this way: measured on a real
 * `dzfp_…_戚盈凯_….pdf`, 149 605 bytes, which never left the host.
 *
 * The portable form is two halves (RFC 6266 §4.2 + RFC 5987): an ASCII fallback
 * every client understands, and the real name percent-encoded in `filename*`
 * for the clients that do. The fallback is not decoration — it is what keeps
 * the header valid at all.
 *
 * Control characters are replaced rather than removed: a `\r\n` smuggled into a
 * remote name must never become a header line, but deleting it would also run
 * the two halves of the name together — `evil\r\nx.txt` becoming `evilx.txt`
 * silently misnames the file. A placeholder keeps its shape.
 *
 * @param {'attachment'|'inline'} type - the disposition kind.
 * @param {string} name - the file name to offer.
 * @returns {string} a header value that is pure ASCII.
 */
export function contentDispositionValue (type, name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/gu, '_')
  // `"` and `\` cannot survive inside the quoted-string form, and anything
  // above printable ASCII cannot survive in a header at all.
  const fallback = clean.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_') || 'download'
  // ASCII names keep their exact previous spelling, so nothing that already
  // worked changes shape.
  if (fallback === clean) return `${type}; filename="${fallback}"`
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(clean)}`
}

/**
 * RFC 5987 `value-chars`: percent-encoded UTF-8, over the `attr-char` set.
 *
 * `encodeURIComponent` already covers the encoding; the four characters it
 * leaves bare that the RFC does not allow in `attr-char` are escaped here.
 *
 * A lone surrogate (possible when a remote name round-trips through a decoder
 * that kept half a pair) makes `encodeURIComponent` throw `URIError`, which
 * would turn a download into the same 500 this helper exists to prevent. Such
 * code units are replaced rather than propagated — the extended name loses one
 * character, the download works.
 *
 * @param {string} value - the raw file name.
 * @returns {string} a header-safe percent-encoding.
 */
export function encodeRfc5987 (value) {
  let encoded
  try {
    encoded = encodeURIComponent(value)
  } catch {
    encoded = encodeURIComponent(value.replace(/[\ud800-\udfff]/gu, '_'))
  }
  return encoded.replace(/['()*]/gu, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}
