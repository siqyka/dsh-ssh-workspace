/**
 * Reading a byte range out of an SFTP handle, with more than one request in flight.
 *
 * Isolated from `remote-fs.js` because it needs no position metadata, no fences
 * and no peer modules: it is a loop over `sftp.read` and nothing else, so a suite
 * can drive it against a fake handle with no assembled DSH tree.
 *
 * The shape of the problem is a round trip per request. SFTP answers one READ
 * per round trip, so a file costs `bytes / request size` waits, and on a WAN
 * link that is exactly what "opening the file is slow" means: 2 MiB at 256 KiB
 * a request is eight waits, which is seconds at half a second of latency, and
 * the panel shows nothing until the last one lands. Several requests in flight
 * keep the same bytes-per-round-trip while shrinking the number of waits, and
 * because every request names its own offset the pieces still assemble in file
 * order regardless of which answer arrives first.
 *
 * @module @shiqyka/dsh-ssh-workspace/fs/read-window
 */

/**
 * Bytes one READ request asks for.
 *
 * Measured on a WAN host at ~170–200 KiB/s with 0.5–2.5 s per round trip: the
 * same 2 MiB file took 49.7 s in 64 KiB requests, 20.9 s in 256 KiB ones, and
 * 6–8 s in 256 KiB requests with four of them in flight. Bigger requests win
 * because per-request wait dominates; the window wins because the transfer
 * itself still overlaps. 64 KiB × 8 lost to plain 256 KiB requests, which is why
 * the unit grew rather than the count.
 */
export const READ_CHUNK_BYTES = 256 * 1024

/**
 * Requests in flight for one file. Bounds the occupied memory at window × chunk
 * (1 MiB), which is the same order as the 2 MiB file cap the editor already has.
 */
export const READ_WINDOW = 4

/**
 * The error a read failure should be reported as. `remote-fs` passes its own
 * wrapper so an SFTP failure keeps the path and the `read` verb in it; the
 * default is for callers that only need the underlying error.
 *
 * @param {unknown} error
 * @param {string} displayPath
 * @returns {Error}
 */
function identityError (error) {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Fill one buffer from `at` onward.
 *
 * A server may answer a READ with fewer bytes than it was asked for even in the
 * middle of a file, so a short answer is NOT end-of-file: the rest of the
 * request is issued again from where the answer stopped. Only zero bytes means
 * the file ended, and only then does the buffer come back short.
 *
 * @param {any} sftp - an object with `read(handle, buffer, offset, length, position, callback)`.
 * @param {any} handle - the open file handle.
 * @param {number} at - absolute file offset.
 * @param {number} want - bytes to collect.
 * @param {string} displayPath - caller-facing path, for the error.
 * @param {(error: unknown, displayPath: string) => Error} wrapError - maps a raw error.
 * @returns {Promise<Buffer>} exactly `want` bytes, or fewer at end-of-file.
 */
function readFilling (sftp, handle, at, want, displayPath, wrapError) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.allocUnsafe(want)
    const step = (filled) => {
      sftp.read(handle, buffer, filled, want - filled, at + filled, (error, read) => {
        if (error !== undefined && error !== null) {
          reject(wrapError(error, displayPath))
          return
        }
        const got = read ?? 0
        if (got === 0) {
          resolve(buffer.subarray(0, filled))
          return
        }
        const next = filled + got
        if (next >= want) resolve(buffer.subarray(0, next))
        else step(next)
      })
    }
    step(0)
  })
}

/**
 * Read from a handle, several requests at a time.
 *
 * @param {any} sftp - see {@link readFilling}.
 * @param {any} handle - the open file handle.
 * @param {number} offset - starting byte.
 * @param {number | undefined} length - byte cap, or undefined for the whole file.
 * @param {string} displayPath - caller-facing path, for the error.
 * @param {(error: unknown, displayPath: string) => Error} [wrapError] - error mapper.
 * @returns {Promise<Buffer>} the bytes read, in file order.
 */
export async function readHandle (sftp, handle, offset, length, displayPath, wrapError = identityError) {
  const chunks = []
  let position = offset
  let remaining = length
  let ended = false
  while (!ended) {
    const batch = []
    for (let index = 0; index < READ_WINDOW; index += 1) {
      const want = remaining === undefined
        ? READ_CHUNK_BYTES
        : Math.min(READ_CHUNK_BYTES, remaining)
      if (want <= 0) { ended = true; break }
      batch.push({ at: position, want })
      position += want
      if (remaining !== undefined) remaining -= want
    }
    if (batch.length === 0) break
    // Each request reports its own outcome so one failure cannot leave its
    // neighbours as unhandled rejections; the first error is thrown as-is.
    const results = await Promise.all(batch.map(async (item) => {
      try {
        return { want: item.want, buffer: await readFilling(sftp, handle, item.at, item.want, displayPath, wrapError) }
      } catch (error) {
        return { want: item.want, error }
      }
    }))
    for (const result of results) {
      if (result.error !== undefined) throw result.error
      chunks.push(result.buffer)
      // Short means this request reached end-of-file, so the rest of the window
      // (and every later batch) holds nothing.
      if (result.buffer.length < result.want) ended = true
    }
  }
  return Buffer.concat(chunks)
}
