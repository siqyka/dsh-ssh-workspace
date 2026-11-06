/**
 * Write a POSIX tar archive, one entry at a time, into a stream of Buffers.
 *
 * ## Why a tar writer lives in this plugin
 *
 * `downloadTree` already copies a remote directory to a path on THIS machine,
 * which is the right answer for the agent and the wrong one for the browser: a
 * browser cannot be handed a local directory, so "download this folder" from the
 * panel had no implementation at all and the row menu said so. The browser CAN
 * be handed one file, and a tar stream is that file — assembled as the bytes
 * arrive, without staging a copy on disk first.
 *
 * ## Why hand-written instead of a dependency
 *
 * The format this needs is a small, frozen subset: ustar headers with a plain
 * octal size, regular files and directories, 512-byte blocking. A dependency
 * would bring readers, links, pax extensions and sparse files that nothing here
 * produces. The one hazard of hand-writing it — the header checksum — is the
 * thing the tests pin down with a byte-level fixture.
 *
 * ## What it deliberately does not do
 *
 *  - No symlinks. They are skipped by the caller, which reports them: a tar
 *    entry pointing at `/` would turn "download this folder" into an archive
 *    someone else explodes later.
 *  - No hard links, no sparse files, no pax long names beyond ustar's 155+100
 *    split (a path that does not fit is refused by name, not truncated).
 *  - No ownership. uid/gid are 0 and names are empty, because the archive is
 *    for the person who asked for it, not for restoring permissions.
 *
 * @module @shiqyka/dsh-ssh-workspace/tar
 */

/** One 512-byte block, the unit everything here is rounded to. */
export const BLOCK = 512

/** The end-of-archive marker: two zero blocks. */
const END_OF_ARCHIVE = Buffer.alloc(BLOCK * 2)

/**
 * Split a path into ustar's `prefix` and `name` fields.
 *
 * ustar gives 100 bytes to `name` and 155 to `prefix`, and a reader joins them
 * with a slash. A path that fits neither is REFUSED: truncating an entry name
 * silently produces an archive that explodes into the wrong files.
 *
 * @param {string} path - the entry path, POSIX separators.
 * @returns {{prefix: string, name: string}} the two fields.
 * @throws {Error} when the path cannot be represented.
 */
export function splitTarName (path) {
  const name = Buffer.byteLength(path, 'utf8')
  if (name <= 100) return { prefix: '', name: path }
  // Longest prefix that still leaves a `name` of at most 100 bytes, splitting
  // at a separator so the joined result is the original path.
  for (let index = path.lastIndexOf('/', Math.min(path.length - 1, 155)); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index)
    const rest = path.slice(index + 1)
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(rest, 'utf8') <= 100) {
      return { prefix, name: rest }
    }
    if (index <= 1) break
  }
  throw new Error(`path too long for a tar entry (ustar allows 155+100 bytes): ${path}`)
}

/**
 * Build one ustar header block.
 *
 * @param {object} entry - what the header describes.
 * @param {string} entry.path - the entry path.
 * @param {number} [entry.size] - byte length; 0 for a directory.
 * @param {number} [entry.mode] - permission bits.
 * @param {number} [entry.mtime] - seconds since the epoch.
 * @param {'0'|'5'} [entry.type] - regular file or directory.
 * @returns {Buffer} the 512-byte block.
 */
export function tarHeader (entry) {
  const { prefix, name } = splitTarName(entry.path)
  const header = Buffer.alloc(BLOCK, 0)
  header.write(name, 0, 100, 'utf8')
  // Every numeric field is OCTAL, seven or eleven digits then NUL. Writing the
  // decimal digits instead is the trap this format has: `size 100` spelled
  // "00000000100" is octal 64, so a 100-byte file declares 64 bytes and the
  // archive reads as corrupt from that entry onward. Measured — the first
  // version of this file did exactly that, and only unpacking with a real tar
  // (not a hand-written checker) showed it.
  writeOctal(header, 100, 8, (entry.mode ?? 0o644) & 0o7777)
  writeOctal(header, 108, 8, 0) // uid
  writeOctal(header, 116, 8, 0) // gid
  writeOctal(header, 124, 12, Math.max(0, Math.trunc(entry.size ?? 0)))
  writeOctal(header, 136, 12, Math.max(0, Math.trunc(entry.mtime ?? 0)))
  header.write(entry.type ?? '0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write(prefix, 345, 155, 'utf8')
  // The checksum is computed with the field itself holding spaces, then written
  // as six octal digits, NUL, space — the one byte layout every reader agrees on.
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  const checksum = sum.toString(8).padStart(6, '0')
  header.write(`${checksum}\0 `, 148, 8, 'ascii')
  return header
}

/**
 * Write one octal numeric field, NUL-terminated.
 *
 * @param {Buffer} header - the block being built.
 * @param {number} offset - field offset.
 * @param {number} width - field width INCLUDING the terminator.
 * @param {number} value - the number.
 */
function writeOctal (header, offset, width, value) {
  const digits = Math.max(0, Math.trunc(value)).toString(8)
  const padded = digits.padStart(width - 1, '0').slice(-(width - 1))
  header.write(padded, offset, width - 1, 'ascii')
  header.writeUInt8(0, offset + width - 1)
}

/**
 * Pad a byte count up to the next 512-byte boundary.
 *
 * @param {number} bytes - the count.
 * @returns {number} how many padding bytes a tar entry needs.
 */
export function tarPadding (bytes) {
  const remainder = bytes % BLOCK
  return remainder === 0 ? 0 : BLOCK - remainder
}

/**
 * Turn a sequence of entries into a tar byte stream.
 *
 * Entries are pulled lazily, so a caller can walk a remote tree as the archive
 * is being written: memory holds one file's current chunk, never the tree.
 * Each entry's `chunks` is an async iterable of Buffers whose total length MUST
 * equal `size` — a mismatch is a corrupt archive, so it throws rather than
 * silently emitting a short entry.
 *
 * @param {AsyncIterable<{path: string, size?: number, mode?: number, mtime?: number, type?: '0'|'5', chunks?: AsyncIterable<Buffer>}>} entries
 *   the entries, in archive order.
 * @returns {AsyncGenerator<Buffer>} the archive bytes.
 */
export async function * tarStream (entries) {
  for await (const entry of entries) {
    const isDirectory = entry.type === '5'
    const size = isDirectory ? 0 : (entry.size ?? 0)
    yield tarHeader({
      path: isDirectory && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path,
      size,
      mode: entry.mode ?? (isDirectory ? 0o755 : 0o644),
      mtime: entry.mtime,
      type: entry.type ?? '0',
    })
    if (isDirectory || size === 0) continue
    let written = 0
    if (entry.chunks !== undefined) {
      for await (const chunk of entry.chunks) {
        if (chunk.length === 0) continue
        written += chunk.length
        if (written > size) {
          throw new Error(`tar entry ${entry.path} produced more bytes than its declared size ${size}`)
        }
        yield chunk
      }
    }
    if (written !== size) {
      // A short entry would make every following header land at the wrong
      // offset, which a reader reports as a corrupt archive with no clue why.
      throw new Error(`tar entry ${entry.path} produced ${written} bytes but declared ${size}`)
    }
    const padding = tarPadding(size)
    if (padding > 0) yield Buffer.alloc(padding, 0)
  }
  yield END_OF_ARCHIVE
}
