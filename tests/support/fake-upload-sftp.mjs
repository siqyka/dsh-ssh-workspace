/**
 * An in-memory SFTP engine for the upload/download ROUTES.
 *
 * ## Why not `fake-sftp.mjs`
 *
 * `tests/support/fake-sftp.mjs` is a server: it enforces SFTP's rename-onto-
 * existing rule, advertises posix-rename, and answers ENOTDIR for a file used
 * as a parent. That is what the file-system backend needs. The routes sit one
 * level up and ask different questions — "which flags did the upload open the
 * staging file with", "at what offsets did the chunks land", "was the
 * connection pin held while the stream was open" — and they need a handle that
 * accumulates bytes so a `rename` can publish them.
 *
 * The two doubles therefore overlap on purpose and neither is the other's
 * replacement. What is NOT acceptable is the shape this file replaced: the same
 * engine copy-pasted inside one suite, where the next suite that needed it
 * could not reach it.
 *
 * ## The bugs this double has to be able to represent
 *
 * A double that cannot represent a defect cannot catch it, and every one of
 * these was a real shipped bug:
 *
 *  - writes that IGNORE the offset. The stub used to concatenate, so a route
 *    that wrote every chunk at offset 0 landed one 64 KiB chunk and still
 *    answered `ok: true`.
 *  - `r+` treated as read-only. The chunked transport reopens the staging file
 *    its predecessor closed; a read-only `r+` delivers only the first chunk.
 *  - `'w'` and `'wx'` not distinguished. The staging name is created with
 *    O_EXCL precisely so two concurrent uploads cannot share it.
 *  - a pin that is measured after the request returns instead of while the
 *    stream is open, which cannot tell "released" from "never taken".
 *
 * @module tests/support/fake-upload-sftp
 */

/**
 * Build the engine over a mutable path map.
 *
 * @param {Map<string, Buffer>} files - path to bytes; mutated by writes and renames.
 * @param {Set<string>} [directories] - paths that are directories.
 * @returns {object} an engine whose `state` records what the routes did.
 */
export function fakeUploadEngine (files, directories = new Set()) {
  const state = { opened: 0, closed: 0, renamed: [], unlinked: [], mkdirs: [], holds: 0, holdPeak: 0, inFlight: 0 }
  return {
    state,
    async withSftp (_alias, work) {
      // The record is passed to the callback the way the real engine passes it:
      // `holds` is the sweeper's long-lived-consumer counter, and a streaming
      // read pins it for as long as the generator is open (see openRemoteRead).
      const record = { holds: 0, idleAt: Date.now(), inFlight: 0 }
      state.record = record
      state.inFlight += 1
      try {
        return await work({
          stat (target, callback) {
            if (directories.has(target)) {
              callback(null, { size: 0, isDirectory: () => true, mode: 0o040755 })
              return
            }
            if (!files.has(target)) { callback(Object.assign(new Error('no such file'), { code: 2 })); return }
            const content = files.get(target)
            callback(null, { size: content.length, isDirectory: () => false, mode: 0o100644 })
          },
          open (target, flags, callback) {
            state.opened += 1
            // Record what the route actually asked for. The upload path opens
            // staging files with 'wx' (O_EXCL) so two concurrent uploads to one
            // destination cannot share a staging name — a double that only knows
            // 'w' would silently send that request down the READ branch, which is
            // how the old stub hid the flag change instead of verifying it.
            state.openFlags = [...(state.openFlags ?? []), { target, flags }]
            if (flags.includes('w')) {
              // Writes go to a buffer the handle accumulates; publish renames it.
              callback(null, { __content: Buffer.alloc(0), __write: true, __target: target })
              return
            }
            // `r+` is a WRITE open too — it keeps the bytes already there and
            // publishes them on close. The chunked upload transport depends on
            // exactly that: chunk N reopens the staging file its predecessor
            // closed, appends at an offset, and the last one renames it.
            if (flags.includes('r+')) {
              const existing = files.get(target)
              if (existing === undefined) { callback(Object.assign(new Error('no such file'), { code: 2 })); return }
              callback(null, { __content: existing, __write: true, __target: target })
              return
            }
            const content = files.get(target)
            if (content === undefined) { callback(Object.assign(new Error('no such file'), { code: 2 })); return }
            callback(null, { __content: content, __position: 0 })
          },
          write (handle, buffer, offset, length, position, callback) {
            // `position` is honoured, not appended — see the header.
            const start = typeof position === 'number' && position >= 0 ? position : handle.__content.length
            const end = start + length
            if (handle.__content.length < end) {
              const grown = Buffer.alloc(end)
              handle.__content.copy(grown, 0)
              handle.__content = grown
            }
            buffer.copy(handle.__content, start, offset, offset + length)
            state.writes = [...(state.writes ?? []), { position: start, length }]
            callback(null)
          },
          read (handle, buffer, offset, length, position, callback) {
            // The stream is live right now, so this is where the connection pin
            // must be observable. Recording it here (rather than after the
            // request returns) is the difference between "the hold was released"
            // and "the hold was never taken".
            state.holdsDuringStream = state.record?.holds ?? 0
            const slice = handle.__content.subarray(position, position + length)
            slice.copy(buffer, offset)
            callback(null, slice.length, buffer)
          },
          close (handle, callback) {
            state.closed += 1
            // A write handle publishes its bytes into the virtual filesystem on
            // close, which is what makes the following rename carry real content.
            // Without this the double loses every uploaded byte and the rename
            // publishes an empty file.
            if (handle?.__write === true && typeof handle.__target === 'string') {
              files.set(handle.__target, handle.__content ?? Buffer.alloc(0))
            }
            callback(null)
          },
          mkdir (target, callback) { state.mkdirs.push(target); callback(null) },
          // The upload fence walks the destination with `lstat` and asks the
          // server to `realpath` the deepest existing component. This double has
          // no symbolic links, so a resolved spelling is the spelling itself —
          // enough to let an in-roots upload pass and to keep the walk honest
          // about what exists.
          lstat (target, callback) {
            if (target === '/' || directories.has(target)) { callback(null, { mode: 0o040755, isDirectory: () => true }); return }
            if (files.has(target)) { callback(null, { mode: 0o100644, isDirectory: () => false }); return }
            callback(Object.assign(new Error('no such file'), { code: 2 }))
          },
          realpath (target, callback) {
            if (target === '/') { callback(null, '/'); return }
            if (!directories.has(target) && !files.has(target)) { callback(Object.assign(new Error('no such file'), { code: 2 }), null); return }
            callback(null, target)
          },
          rename (from, to, callback) {
            state.renamed.push([from, to])
            const content = files.get(from) ?? Buffer.alloc(0)
            files.delete(from)
            files.set(to, content)
            callback(null)
          },
          unlink (target, callback) { state.unlinked.push(target); files.delete(target); callback(null) },
        }, record)
      } finally {
        state.inFlight -= 1
      }
    },
  }
}

export default { fakeUploadEngine }
