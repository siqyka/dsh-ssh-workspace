/**
 * Deciding "text or binary" from bytes, never from the file name.
 *
 * The suffix is a hint at best: `cts`, `bat`, `gitconfig` and extensionless
 * files like `LICENSE-APACHE` are plainly text, while a `.log` can hold a
 * compressed blob. A registry that only knows names therefore keeps missing
 * real text, and every new extension is a new release.
 *
 * The rule here is the one the ecosystem converged on: decode by encoding
 * first — a BOM, then a bomless UTF-16 shape — and only when none of those
 * apply does a NUL byte mean binary. That ordering matters in practice:
 * Windows writes `.reg` and some `.bat` files as UTF-16, and a blunt
 * `includes(0)` check would call every one of them binary.
 *
 * Deliberately dependency-free so it can be unit-tested without a DSH host.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/text-sniff
 */

/** How many leading bytes decide the question. */
export const SNIFF_BYTES = 4096

const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Uint8Array.from([0xff, 0xfe])
const UTF16BE_BOM = Uint8Array.from([0xfe, 0xff])
const UTF32LE_BOM = Uint8Array.from([0xff, 0xfe, 0x00, 0x00])
const UTF32BE_BOM = Uint8Array.from([0x00, 0x00, 0xfe, 0xff])

/**
 * Whether `bytes` starts with `prefix`.
 *
 * @param {Uint8Array} bytes - buffer to test.
 * @param {Uint8Array} prefix - expected lead.
 * @returns {boolean} true when the prefix matches.
 */
function startsWith (bytes, prefix) {
  if (bytes.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  return true
}

/**
 * A bomless UTF-16 guess, the same shape editors use.
 *
 * UTF-16 text has a NUL in roughly every other byte while ASCII runs dominate;
 * prose in CJK does not, so the test only counts bytes INSIDE the high half of
 * each code unit. Both orders are tried and the stronger signal wins, so a
 * little-endian file with a few odd characters is not mistaken for
 * big-endian — or for binary.
 *
 * @param {Uint8Array} bytes - leading bytes.
 * @returns {'utf16le' | 'utf16be' | undefined} the guessed order.
 */
export function bomlessUtf16 (bytes) {
  if (bytes.length < 4) return undefined
  let evenZero = 0
  let oddZero = 0
  const pairs = Math.floor(bytes.length / 2)
  for (let index = 0; index < pairs; index += 1) {
    if (bytes[index * 2] === 0) evenZero += 1
    if (bytes[index * 2 + 1] === 0) oddZero += 1
  }
  // A third of the high halves being zero is already implausible for a text
  // encoding; requiring it on ONE side only is what separates the two orders.
  const threshold = Math.max(2, Math.floor(pairs / 3))
  if (oddZero >= threshold && evenZero < threshold) return 'utf16le'
  if (evenZero >= threshold && oddZero < threshold) return 'utf16be'
  return undefined
}

/**
 * Try a `TextDecoder` in fatal mode: a successful decode is evidence.
 *
 * @param {string} label - encoding passed to `TextDecoder`.
 * @param {Uint8Array} bytes - bytes to decode.
 * @returns {string | undefined} the text, or undefined when undecodable.
 */
function tryDecode (label, bytes) {
  try {
    const decoder = new TextDecoder(label, { fatal: true })
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Classify a leading byte window.
 *
 * @param {Uint8Array} bytes - the first {@link SNIFF_BYTES} bytes (or fewer).
 * @returns {{kind: 'text' | 'binary', encoding: string}} the verdict and the
 *   encoding that proved it.
 */
export function sniffTextBytes (bytes) {
  if (startsWith(bytes, UTF32LE_BOM)) return { kind: 'text', encoding: 'utf32le-bom' }
  if (startsWith(bytes, UTF32BE_BOM)) return { kind: 'text', encoding: 'utf32be-bom' }
  if (startsWith(bytes, UTF8_BOM)) return { kind: 'text', encoding: 'utf8-bom' }
  if (startsWith(bytes, UTF16LE_BOM)) return { kind: 'text', encoding: 'utf16le-bom' }
  if (startsWith(bytes, UTF16BE_BOM)) return { kind: 'text', encoding: 'utf16be-bom' }

  const wide = bomlessUtf16(bytes)
  if (wide !== undefined) return { kind: 'text', encoding: wide }

  // Only now does a NUL mean "not text": every encoding that legitimately
  // carries one has already been ruled out above.
  for (const byte of bytes) {
    if (byte === 0) return { kind: 'binary', encoding: 'binary' }
  }

  if (tryDecode('utf-8', bytes) !== undefined) return { kind: 'text', encoding: 'utf8' }
  // A legacy CJK file is still text. Node ships the full ICU data, so this is
  // a real decoder rather than a byte-for-byte guess.
  if (tryDecode('gb18030', bytes) !== undefined) return { kind: 'text', encoding: 'gb18030' }
  // Undecodable but NUL-free: replacement characters are still readable, and
  // calling it binary would send the reader to a hex dump for a text file.
  return { kind: 'text', encoding: 'utf8' }
}
