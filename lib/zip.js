/**
 * Write a ZIP archive, one entry at a time, into a stream of Buffers.
 *
 * ## Why a zip writer lives beside the tar one
 *
 * `GET /download-tree` answered every directory download with a `.tar`, and
 * that is the shape a browser can receive — but not the shape most people can
 * OPEN. Windows has no built-in `.tar` handler, and the platforms that do
 * understand it treat it as an archive of last resort. The user asked for a
 * directory, pressed download, and got a file their machine could not open
 * without extra software. ZIP is the format every desktop OS opens natively,
 * so it is the default; tar stays as the fallback (see `transfer.js`).
 *
 * ## Why hand-written instead of a dependency
 *
 * The subset needed is small and frozen: stored and deflated entries, no
 * encryption, no spanning, no comments. A dependency would add readers,
 * writers, crypto and a streaming API that would have to be adapted back into
 * this generator shape anyway. The two hazards of hand-writing it — the
 * endianness of every field, and the CRC-32 that a reader verifies before it
 * will show the user anything — are the things the tests pin down, including
 * against a real `zipfile` reader rather than another hand-written parser.
 *
 * ## Streaming, and what that costs
 *
 * Entry data is pulled lazily, so a caller can walk a remote tree while the
 * archive is being written: memory holds one file's current chunk, never the
 * tree. Because each entry's CRC and compressed size are unknown when its
 * local header is written, every file entry sets the data-descriptor flag
 * (bit 3) and states the real values after the data. Readers take those from
 * the central directory, which is written last.
 *
 * That has one consequence worth naming: the central directory is accumulated
 * in memory. It is ~50 bytes plus the entry name per file — 8 MB for a
 * hundred thousand files — which is bounded by the tree's file COUNT rather
 * than its size, and there is no way to write it incrementally.
 *
 * ## What it deliberately does not do
 *
 *  - No symlinks, no hard links, no sparse files. The caller skips symlinks
 *    and reports them: an entry pointing at `/` would turn "download this
 *    folder" into an archive that overwrites someone's machine on extraction.
 *  - No encryption, no multi-disk archives, no archive comments.
 *  - No ownership. Unix modes are recorded as plain 0644/0755, because the
 *    archive is for the person who asked for it, not for restoring a system.
 *
 * @module @shiqyka/dsh-ssh-workspace/zip
 */

import { createDeflateRaw } from 'node:zlib'

/** Local file header signature. */
const LOCAL_SIG = 0x04034b50
/** Central directory header signature. */
const CENTRAL_SIG = 0x02014b50
/** End-of-central-directory signature. */
const EOCD_SIG = 0x06054b50
/** Zip64 end-of-central-directory record signature. */
const ZIP64_EOCD_SIG = 0x06064b50
/** Zip64 end-of-central-directory locator signature. */
const ZIP64_LOCATOR_SIG = 0x07064b50
/** Data descriptor signature (optional per spec, written for observability). */
const DESCRIPTOR_SIG = 0x08074b50

/** The 32-bit "see the zip64 field" sentinel. */
const U32_MAX = 0xffffffff
/** "Sizes and CRC follow the data" — required when streaming. */
const FLAG_DESCRIPTOR = 0x0008
/** Entry name is UTF-8. Set unconditionally: modern tools all read it. */
const FLAG_UTF8 = 0x0800

/** Stored (no compression). */
const METHOD_STORE = 0
/** Deflate. */
const METHOD_DEFLATE = 8

/** Version needed for a plain entry. */
const VERSION_DEFAULT = 20
/** Version needed once a zip64 field appears. */
const VERSION_ZIP64 = 45

/**
 * CRC-32 lookup table, built once.
 *
 * `zlib.crc32` exists only from Node 20.15 / 22.2, and this package supports
 * `>=20`, so the table is local. It is the standard reflected polynomial.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * Fold one chunk into a running CRC-32.
 *
 * The value passed in is the value returned by the previous call (0 for the
 * first), which is why the XOR happens at both ends: that is what makes the
 * checksum incremental across chunks instead of per-chunk.
 *
 * @param {number} crc - running checksum, 0 to start.
 * @param {Buffer} chunk - the next bytes.
 * @returns {number} the updated checksum.
 */
export function crc32Update (crc, chunk) {
  let value = (crc ^ 0xffffffff) >>> 0
  for (let index = 0; index < chunk.length; index += 1) {
    value = (CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8)) >>> 0
  }
  return (value ^ 0xffffffff) >>> 0
}

/**
 * Convert epoch seconds into the MS-DOS date and time a zip header stores.
 *
 * ZIP has no time zone field: the two 16-bit values are understood as LOCAL
 * wall-clock time by every reader. This converts in UTC, deliberately — the
 * alternative makes the bytes depend on the machine that wrote the archive,
 * so the same tree would produce different archives (and different tests) on
 * two machines. A timestamp before the format's 1980 epoch is clamped to it,
 * because the field cannot represent it and a wrapped date reads as 2107.
 *
 * @param {number} epochSeconds - seconds since 1970-01-01T00:00:00Z.
 * @returns {{time: number, date: number}} the two header fields.
 */
export function dosDateTime (epochSeconds) {
  const seconds = Number.isFinite(epochSeconds) ? Math.trunc(epochSeconds) : 0
  const when = new Date(Math.max(0, seconds) * 1000)
  const year = when.getUTCFullYear()
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
  }
}

/**
 * Build the zip64 extra field for a central-directory entry.
 *
 * The spec fixes the order of the 8-byte values, and only the ones whose fixed
 * field was replaced by {@link U32_MAX} may appear. Emitting a value the
 * reader is not expecting shifts every following field, which is why the order
 * here is spelled out rather than derived from the object.
 *
 * @param {{uncompressed?: number, compressed?: number, offset?: number}} values
 *   the real values, each present only when its fixed field overflowed.
 * @returns {Buffer} the extra field, or an empty buffer when nothing overflowed.
 */
export function zip64Extra (values) {
  const parts = []
  if (values.uncompressed !== undefined) {
    const field = Buffer.alloc(8)
    field.writeBigUInt64LE(BigInt(values.uncompressed), 0)
    parts.push(field)
  }
  if (values.compressed !== undefined) {
    const field = Buffer.alloc(8)
    field.writeBigUInt64LE(BigInt(values.compressed), 0)
    parts.push(field)
  }
  if (values.offset !== undefined) {
    const field = Buffer.alloc(8)
    field.writeBigUInt64LE(BigInt(values.offset), 0)
    parts.push(field)
  }
  if (parts.length === 0) return Buffer.alloc(0)
  const body = Buffer.concat(parts)
  const header = Buffer.alloc(4)
  header.writeUInt16LE(0x0001, 0)
  header.writeUInt16LE(body.length, 2)
  return Buffer.concat([header, body])
}

/**
 * Build one local file header.
 *
 * When `descriptor` is true the CRC and both sizes are written as zero and the
 * real values follow the data: that is the streaming shape, and it is what
 * bit 3 in the flags announces.
 *
 * @param {object} options - what the header describes.
 * @param {Buffer} options.name - the entry name, UTF-8, already normalized.
 * @param {boolean} options.directory - whether this is a directory entry.
 * @param {boolean} options.descriptor - whether CRC/sizes follow the data.
 * @param {boolean} options.zip64 - whether the entry declares zip64 capability.
 * @param {number} options.mtime - epoch seconds.
 * @returns {Buffer} the header, without the name.
 */
export function localHeader (options) {
  const header = Buffer.alloc(30)
  const { time, date } = dosDateTime(options.mtime)
  header.writeUInt32LE(LOCAL_SIG, 0)
  header.writeUInt16LE(options.zip64 === true ? VERSION_ZIP64 : VERSION_DEFAULT, 4)
  header.writeUInt16LE(FLAG_UTF8 | (options.descriptor === true ? FLAG_DESCRIPTOR : 0), 6)
  header.writeUInt16LE(options.directory === true ? METHOD_STORE : METHOD_DEFLATE, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  // CRC and both sizes stay zero: bit 3 says the truth arrives later. Writing
  // the KNOWN uncompressed size here and leaving the compressed one zero would
  // be a header that contradicts itself, and readers disagree about which half
  // to believe.
  header.writeUInt32LE(0, 14)
  header.writeUInt32LE(0, 18)
  header.writeUInt32LE(0, 22)
  header.writeUInt16LE(options.name.length, 26)
  // No local zip64 field: with bit 3 set the sizes here are placeholders, so
  // there is nothing to extend. The real 8-byte values live in the central
  // directory's zip64 field, which is what every reader consults.
  header.writeUInt16LE(0, 28)
  return header
}

/**
 * Build the data descriptor that follows one entry's bytes.
 *
 * @param {number} crc - the entry's CRC-32.
 * @param {number} compressed - bytes of compressed data written.
 * @param {number} uncompressed - bytes of source data read.
 * @param {boolean} zip64 - whether the sizes are 8 bytes wide.
 * @returns {Buffer} the descriptor.
 */
export function dataDescriptor (crc, compressed, uncompressed, zip64) {
  const header = Buffer.alloc(zip64 === true ? 24 : 16)
  header.writeUInt32LE(DESCRIPTOR_SIG, 0)
  header.writeUInt32LE(crc >>> 0, 4)
  if (zip64 === true) {
    header.writeBigUInt64LE(BigInt(compressed), 8)
    header.writeBigUInt64LE(BigInt(uncompressed), 16)
  } else {
    header.writeUInt32LE(compressed >>> 0, 8)
    header.writeUInt32LE(uncompressed >>> 0, 12)
  }
  return header
}

/**
 * Build one central-directory record.
 *
 * This is the authority a reader actually uses: it carries the real CRC and
 * sizes (with the zip64 field when a fixed field overflowed) and the offset of
 * the local header.
 *
 * @param {object} entry - the recorded entry.
 * @param {Buffer} entry.name - the entry name.
 * @param {number} entry.crc - CRC-32.
 * @param {number} entry.compressed - compressed byte count.
 * @param {number} entry.uncompressed - uncompressed byte count.
 * @param {number} entry.offset - offset of the local header.
 * @param {boolean} entry.directory - whether this is a directory.
 * @param {boolean} entry.zip64 - whether any fixed field overflowed.
 * @returns {Buffer} the record, including the name and the extra field.
 */
export function centralHeader (entry) {
  const overflowUncompressed = entry.uncompressed >= U32_MAX
  const overflowCompressed = entry.compressed >= U32_MAX
  const overflowOffset = entry.offset >= U32_MAX
  const extra = zip64Extra({
    uncompressed: overflowUncompressed ? entry.uncompressed : undefined,
    compressed: overflowCompressed ? entry.compressed : undefined,
    offset: overflowOffset ? entry.offset : undefined,
  })
  const header = Buffer.alloc(46)
  // Every offset below is +4 from the "version made by" field, because the
  // record starts with a 4-byte signature. Writing the fields at their
  // intuitive positions — version made by at 0 — produces a file whose central
  // directory begins with `0x0314` instead of `PK\x01\x02`, and a reader
  // reports "Bad magic number for central directory" without naming the field.
  header.writeUInt32LE(CENTRAL_SIG, 0)
  // `version made by` high byte 3 is Unix, so the mode in the external
  // attributes is read as a POSIX mode rather than as DOS attributes only.
  header.writeUInt16LE((3 << 8) | VERSION_ZIP64, 4)
  header.writeUInt16LE(entry.zip64 === true ? VERSION_ZIP64 : VERSION_DEFAULT, 6)
  header.writeUInt16LE(FLAG_UTF8 | (entry.directory === true ? 0 : FLAG_DESCRIPTOR), 8)
  header.writeUInt16LE(entry.directory === true ? METHOD_STORE : METHOD_DEFLATE, 10)
  const { time, date } = dosDateTime(entry.mtime)
  header.writeUInt16LE(time, 12)
  header.writeUInt16LE(date, 14)
  header.writeUInt32LE(entry.crc >>> 0, 16)
  header.writeUInt32LE(overflowCompressed ? U32_MAX : (entry.compressed >>> 0), 20)
  header.writeUInt32LE(overflowUncompressed ? U32_MAX : (entry.uncompressed >>> 0), 24)
  header.writeUInt16LE(entry.name.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt16LE(0, 32) // comment length
  header.writeUInt16LE(0, 34) // disk number
  header.writeUInt16LE(0, 36) // internal attributes
  // Unix mode in the high 16 bits, plus the low DOS bit for tools that read
  // only that half (0x10 = directory, 0x00 = plain file).
  header.writeUInt32LE(entry.directory === true ? ((0o40755 << 16) | 0x10) >>> 0 : ((0o100644 << 16) >>> 0), 38)
  header.writeUInt32LE(overflowOffset ? U32_MAX : (entry.offset >>> 0), 42)
  return Buffer.concat([header, entry.name, extra])
}

/**
 * Stream one file's bytes through deflate, folding a CRC-32 as they pass.
 *
 * The pump runs as its own promise because a Transform is push/pull: something
 * has to write while the consumer reads. Errors from the SOURCE are kept so
 * they can be rethrown after the transform unwinds — otherwise the caller sees
 * a generic premature-close from zlib instead of the SFTP failure that caused
 * it, which is the difference between "the remote file went away" and "the
 * archive writer is broken".
 *
 * ## Why the CRC is folded HERE
 *
 * A zip reader verifies the entry's CRC before it will show the user anything,
 * and the checksum covers the UNCOMPRESSED bytes. Those bytes exist exactly
 * once, inside this loop, as they are handed to deflate — they cannot be
 * recovered from the compressed output. So the running values are reported
 * back through `state` rather than returned: a generator's return value is not
 * available to a `for await` consumer.
 *
 * @param {AsyncIterable<Buffer>} source - the file's bytes.
 * @param {{crc: number, read: number}} state - mutated as the bytes pass.
 * @returns {AsyncGenerator<Buffer>} the deflated bytes.
 */
async function * deflateChunks (source, state) {
  const deflate = createDeflateRaw()
  let failure
  const pump = (async () => {
    try {
      for await (const chunk of source) {
        if (chunk.length === 0) continue
        // Folded BEFORE the write, on the raw bytes: this is the only moment
        // they are visible in their original form.
        state.crc = crc32Update(state.crc, chunk)
        state.read += chunk.length
        if (!deflate.write(chunk)) await new Promise((resolve) => { deflate.once('drain', resolve) })
      }
      deflate.end()
    } catch (error) {
      failure = error
      deflate.destroy()
    }
  })()
  try {
    for await (const chunk of deflate) yield chunk
  } catch (error) {
    if (failure === undefined) throw error
  } finally {
    deflate.destroy()
    await pump.catch(() => {})
  }
  if (failure !== undefined) throw failure
}

/**
 * Turn a sequence of entries into a zip byte stream.
 *
 * Entries are pulled lazily, so a caller can walk a remote tree as the archive
 * is being written. Each entry's `chunks` is an async iterable of Buffers
 * whose total length MUST equal `size` — a mismatch is a corrupt archive, so
 * it throws rather than silently emitting a short entry.
 *
 * @param {AsyncIterable<{path: string, size?: number, mtime?: number, type?: '0'|'5', chunks?: AsyncIterable<Buffer>}>} entries
 *   the entries, in archive order.
 * @returns {AsyncGenerator<Buffer>} the archive bytes.
 */
export async function * zipStream (entries) {
  /** @type {Array<object>} */
  const central = []
  let total = 0
  // Every byte goes out through here so the local-header offsets cannot drift
  // from what was actually written.
  const emit = async function * (buffer) {
    total += buffer.length
    yield buffer
  }

  for await (const entry of entries) {
    const isDirectory = entry.type === '5'
    const path = isDirectory && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path
    const name = Buffer.from(path, 'utf8')
    const offset = total
    const mtime = entry.mtime ?? 0

    if (isDirectory) {
      yield * emit(localHeader({ name, directory: true, descriptor: false, zip64: false, mtime }))
      yield * emit(name)
      central.push({ name, crc: 0, compressed: 0, uncompressed: 0, offset, directory: true, zip64: false, mtime })
      continue
    }

    const declared = typeof entry.size === 'number' && entry.size > 0 ? entry.size : 0
    // A single file past 4 GiB needs zip64 in BOTH the local header (so the
    // reader knows to expect the 8-byte descriptor) and the central record.
    const zip64 = declared >= U32_MAX
    yield * emit(localHeader({ name, directory: false, descriptor: true, zip64, mtime }))
    yield * emit(name)

    let crc = 0
    let read = 0
    let compressed = 0
    if (entry.chunks !== undefined && declared > 0) {
      // The CRC and the byte count come back through `state`: they cover the
      // SOURCE bytes, which exist only on the way in to deflate.
      const state = { crc: 0, read: 0 }
      for await (const chunk of deflateChunks(entry.chunks, state)) {
        compressed += chunk.length
        yield * emit(chunk)
      }
      crc = state.crc
      read = state.read
    }

    // Checked against the declared size the same way `tarStream` does: a short
    // entry is a corrupt archive, and it would put every following header at
    // the wrong offset.
    if (read !== declared) {
      throw new Error(`zip entry ${path} produced ${read} bytes but declared ${declared}`)
    }
    // The descriptor states the CRC and sizes the central directory repeats.
    yield * emit(dataDescriptor(crc, compressed, declared, zip64))
    central.push({ name, crc, compressed, uncompressed: declared, offset, directory: false, zip64, mtime })
  }

  // ---- central directory
  const start = total
  for (const entry of central) {
    const record = centralHeader(entry)
    yield * emit(record)
  }
  const directorySize = total - start

  const needsZip64 = central.length >= 0xffff || start >= U32_MAX || directorySize >= U32_MAX
  if (needsZip64) {
    const eocd64Offset = total
    const record = Buffer.alloc(56)
    record.writeUInt32LE(ZIP64_EOCD_SIG, 0)
    // Size of the remaining record, which is fixed: 56 - 12.
    record.writeBigUInt64LE(44n, 4)
    record.writeUInt16LE((3 << 8) | VERSION_ZIP64, 12)
    record.writeUInt16LE(VERSION_ZIP64, 14)
    record.writeUInt32LE(0, 16)
    record.writeUInt32LE(0, 20)
    record.writeBigUInt64LE(BigInt(central.length), 24)
    record.writeBigUInt64LE(BigInt(central.length), 32)
    record.writeBigUInt64LE(BigInt(directorySize), 40)
    record.writeBigUInt64LE(BigInt(start), 48)
    yield * emit(record)

    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0)
    locator.writeUInt32LE(0, 4)
    locator.writeBigUInt64LE(BigInt(eocd64Offset), 8)
    locator.writeUInt32LE(1, 16)
    yield * emit(locator)
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(needsZip64 ? 0xffff : central.length, 8)
  eocd.writeUInt16LE(needsZip64 ? 0xffff : central.length, 10)
  eocd.writeUInt32LE(needsZip64 ? U32_MAX : directorySize, 12)
  eocd.writeUInt32LE(needsZip64 ? U32_MAX : start, 16)
  eocd.writeUInt16LE(0, 20)
  yield * emit(eocd)
}
