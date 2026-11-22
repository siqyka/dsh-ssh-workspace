/**
 * Which text encoding a file is in, and how to decode and re-encode it.
 *
 * The editor used to assume UTF-8 and nothing else: a NUL byte in the sample
 * meant "binary" and a fatal UTF-8 decode meant "not text". That made two very
 * common Windows files impossible to open — a UTF-16 config with a BOM, and a
 * CP936 (GB18030) file with Chinese in it.
 *
 * Detection is a sniff of the head, in this order, because the order is what
 * keeps the answers honest:
 *
 *  1. a byte order mark is proof, and it is checked first;
 *  2. a NUL byte is NOT proof of a binary file. UTF-16LE ASCII is half NULs,
 *     so a BOM-less UTF-16 file is tested for well-formedness before the "this
 *     is binary" answer is given;
 *  3. strict UTF-8, then strict GB18030, each of which throws if the bytes are
 *     not valid in that encoding;
 *  4. otherwise it is not a text file we can show.
 *
 * The GB18030 step is deliberately conservative for a reason worth stating: it
 * accepts almost any byte sequence, so "it decoded" is not evidence. On top of
 * a strict decode it also requires that the text actually contains a CJK
 * character — a Latin-1 file of French text must keep being refused rather than
 * open as mojibake.
 *
 * Saving is a narrower set than reading ({@link WRITE_ENCODINGS}). Node can
 * encode UTF-8 and UTF-16 but has no GB18030 encoder and this plugin carries no
 * conversion table, so a GB18030 file is READ-ONLY rather than "openable but
 * quietly rewritten as UTF-8 on the first save". Reporting that at the probe is
 * what stops the editor from offering an edit it cannot perform safely.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/text-encoding
 */

/** Encodings a save can produce bytes in. */
export const WRITE_ENCODINGS = new Set(['utf8', 'utf16le', 'utf16be'])

/**
 * The name `TextDecoder` knows each internal encoding by.
 *
 * Kept as a map rather than as the internal names themselves because the two
 * conventions disagree: `utf16le` is this module's name and `utf-16le` is
 * WHATWG's, and `new TextDecoder('utf16le')` throws `ERR_ENCODING_NOT_SUPPORTED`
 * — which a `try/catch` around a DECODE call would swallow as "the bytes are
 * not in this encoding", i.e. the wrong answer with no error to notice.
 */
const DECODER_LABELS = {
  utf8: 'utf-8',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  gb18030: 'gb18030',
}

/** How much of the head the binary / encoding sniff looks at. */
export const SAMPLE_BYTES = 8192

/**
 * Bytes in one page of a file too large to open whole.
 *
 * Larger moves more per round trip and makes each page slower to decode; smaller
 * makes scrolling a very large file feel like a slideshow. 128 KiB is roughly
 * 2 000 lines of source, which fits a screenful with room to scroll.
 */
export const PAGE_BYTES = 128 * 1024

/**
 * How many bytes a single character can occupy in each encoding, used to find a
 * boundary after a page was cut at a fixed byte count.
 */
const UNIT_BYTES = { utf8: 4, gb18030: 4, utf16le: 2, utf16be: 2 }

const BOM_UTF8 = Buffer.from([0xEF, 0xBB, 0xBF])
const BOM_UTF16LE = Buffer.from([0xFF, 0xFE])
const BOM_UTF16BE = Buffer.from([0xFE, 0xFF])
const BOM_UTF32LE = Buffer.from([0xFF, 0xFE, 0x00, 0x00])
const BOM_UTF32BE = Buffer.from([0x00, 0x00, 0xFE, 0xFF])

/**
 * Share of code units that must look like text for a BOM-less UTF-16 guess.
 *
 * A 16-bit read of an 8-bit file produces mostly control characters, so a high
 * ratio is what separates "this really is UTF-16" from "these bytes happen to
 * be even in number". The reference implementation uses the same 90%.
 */
const UTF16_TEXT_RATIO = 0.9

/**
 * One character that counts as evidence of a CJK-encoded file.
 *
 * Used only to license the GB18030 fallback: the decoding succeeding is not
 * enough, because GB18030 accepts byte sequences that Latin-1 files contain.
 */
const CJK = /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/u

/** Whether the buffer opens with exactly these bytes. */
function startsWith (buffer, prefix) {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix)
}

/**
 * Decode strictly: an invalid sequence throws instead of storing U+FFFD.
 *
 * An UNKNOWN label also throws, and the two must not be confused — see
 * {@link tryDecode}, which is what the sniffer uses and which rethrows the
 * second one on purpose.
 */
function decodeStrict (buffer, encoding, options = {}) {
  const label = DECODER_LABELS[encoding]
  if (label === undefined) throw new Error(`unknown text encoding: ${encoding}`)
  // `TextDecoder` swallows a leading BOM by default. That is right for page one,
  // where the mark is a fact about the file, and wrong for a later page, where
  // the same bytes are a character the file really contains.
  return new TextDecoder(label, { fatal: true, ignoreBOM: options.keepBom === true }).decode(buffer)
}

/**
 * Decode, answering `undefined` for bytes that are not valid in this encoding.
 *
 * Only a DATA error is swallowed. Every other failure is rethrown, because this
 * function is called inside `catch`-heavy sniffing code where a swallowed
 * programming mistake reads as "the file is not in this encoding" — which is
 * exactly what happened while writing this: `decodeStrict(sample, 'utf-8')`
 * passed a WHATWG label to a lookup keyed by internal names, threw
 * `ERR_ENCODING_NOT_SUPPORTED`, and the `catch` reported every CJK UTF-8 file
 * as GB18030. The bug is invisible from the outside; only the answer is wrong.
 */
function tryDecode (buffer, encoding) {
  try {
    return decodeStrict(buffer, encoding)
  } catch (error) {
    if (isInvalidData(error)) return undefined
    throw error
  }
}

/**
 * Whether a decoded string is mostly text rather than coincidental code units.
 *
 * A newline, a tab and anything at or above the first printable character
 * counts. U+FFFD is excluded, which only matters for a decoder that substitutes
 * rather than throws — a caller relying on this must decode fatally anyway, so
 * it is belt and braces on purpose.
 */
function textRatio (text) {
  if (text.length === 0) return 1
  let text_units = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code === 0xFFFD) continue
    if (code >= 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) text_units += 1
  }
  return text_units / [...text].length
}

/**
 * Identify a file's encoding from its head.
 *
 * `truncated` says whether `raw` is the WHOLE file or only its head. It matters
 * for one rule: a BOM-less UTF-16 file is an even number of bytes, so an
 * odd-length buffer cannot be one — but an odd-length HEAD can, because the cut
 * can land anywhere. Without the flag a three-byte binary file (`41 00 42`)
 * reads as UTF-16 and reports a character nobody wrote.
 *
 * @param {Buffer} raw
 * @param {{truncated?: boolean}} [options]
 * @returns {{encoding: string, bom: boolean} | {reason: 'binary'|'not-utf8'}}
 *   The encoding and whether it carries a BOM, or why the bytes are not text
 *   this feature can display.
 */
export function fileFormatOf (raw, options) {
  const truncated = options?.truncated === true
  const sample = raw.subarray(0, SAMPLE_BYTES)
  const holdsWholeFile = truncated !== true && raw.length <= SAMPLE_BYTES

  // UTF-32 before UTF-16: `FF FE 00 00` also satisfies the UTF-16LE BOM test,
  // and reading a UTF-32 file as UTF-16 yields text full of NULs. Neither is
  // readable here, and saying so is better than showing that.
  if (startsWith(sample, BOM_UTF32LE) || startsWith(sample, BOM_UTF32BE)) return { reason: 'not-utf8' }
  if (startsWith(sample, BOM_UTF16LE)) return { encoding: 'utf16le', bom: true }
  if (startsWith(sample, BOM_UTF16BE)) return { encoding: 'utf16be', bom: true }
  if (startsWith(sample, BOM_UTF8)) return { encoding: 'utf8', bom: true }

  if (sample.includes(0)) {
    // A NUL used to be the whole answer. It is now only a hint, because UTF-16
    // ASCII is half NULs — so the two 16-bit readings are tested for
    // well-formedness before the file is called binary.
    if (holdsWholeFile && sample.length % 2 !== 0) return { reason: 'binary' }
    const guessed = guessBomlessUtf16(sample)
    if (guessed !== undefined) return { encoding: guessed, bom: false }
    return { reason: 'binary' }
  }

  if (sample.every(byte => byte < 0x80)) return { encoding: 'utf8', bom: false }

  // A head cut at a fixed byte count usually ends in the middle of a character,
  // and a strict decoder refuses a half character. Judging THAT as "not this
  // encoding" is how a large UTF-8 file with CJK in it was reported as GB18030:
  // 8 192 bytes of three-byte characters ends on a boundary only once in three,
  // and the leftover bytes decode perfectly well as GBK — while the file is
  // still UTF-8. A sample that is a PREFIX gets its tail trimmed before the
  // verdict; one that is the whole file does not, because there its tail is
  // real data.
  //
  // `truncated` alone does not answer that: it says whether the READ stopped at
  // its limit, but `sample` is also a prefix whenever the file is simply larger
  // than SAMPLE_BYTES. Using the flag by itself kept the bug alive on the
  // whole-file path — the probe (which passes `truncated`) said "UTF-8, open
  // it", and the very next read of the same file refused it as "neither UTF-8
  // nor GB18030", because that read handed over the complete buffer and
  // therefore declared it untruncated while still inspecting only its head.
  const sampleIsPrefix = truncated === true || raw.length > SAMPLE_BYTES
  const readSample = sampleIsPrefix ? tryDecodeHead : tryDecode

  if (readSample(sample, 'utf8') !== undefined) return { encoding: 'utf8', bom: false }

  // GB18030 accepts a great deal, so a successful decode is not enough on its
  // own: require that CJK characters actually came out of it. Without this a
  // Latin-1 file opens as nonsense instead of being refused.
  const decoded = readSample(sample, 'gb18030')
  if (decoded !== undefined && CJK.test(decoded)) return { encoding: 'gb18030', bom: false }

  return { reason: 'not-utf8' }
}

/**
 * Decode a head that may end mid-character, dropping at most one character.
 *
 * Only for a sample known to be a PREFIX of a longer file: the bytes dropped are
 * the start of the next character on disk, not damage in the file.
 */
function tryDecodeHead (buffer, encoding) {
  const budget = encoding === 'utf8' || encoding === 'gb18030' ? 3 : 1
  for (let trim = 0; trim <= budget; trim += 1) {
    const candidate = buffer.subarray(0, Math.max(0, buffer.length - trim))
    const decoded = tryDecode(candidate, encoding)
    if (decoded !== undefined) return decoded
  }
  return undefined
}

/**
 * Test a NUL-carrying sample as BOM-less UTF-16 in both byte orders.
 *
 * Both readings are tried because the byte order is exactly what a missing BOM
 * withholds. A whole `-1` length is skipped rather than rounded down: a UTF-16
 * file is always an even number of bytes, and the odd one here would be the
 * last byte of a truncated head, not evidence of anything.
 *
 * Two conditions, because the first one alone is not enough:
 *
 *  - `textRatio` — most decoded code units are printable. This is the test the
 *    reference implementation describes as 90%-text, and it rejects a 16-bit
 *    read of an 8-bit file, which yields mostly control characters;
 *  - `laneLooksTextual` — the LOW byte of each code unit is printable. This is
 *    what catches the case `textRatio` misses: bytes `00 01 02 03` decode as
 *    U+0100 and U+0302 under UTF-16LE, two perfectly printable characters, so a
 *    ratio test alone calls four bytes of binary "text". The low byte is where
 *    a real UTF-16 code unit carries its character, so a control character
 *    there is the giveaway.
 */
function guessBomlessUtf16 (sample) {
  const usable = sample.subarray(0, sample.length - (sample.length % 2))
  if (usable.length < 2) return undefined
  for (const encoding of ['utf16le', 'utf16be']) {
    if (!laneLooksTextual(usable, encoding)) continue
    try {
      const decoded = decodeStrict(usable, encoding)
      if (textRatio(decoded) >= UTF16_TEXT_RATIO) return encoding
    } catch { /* try the other byte order */ }
  }
  return undefined
}

/**
 * Whether the low byte of every code unit is a character a text file can hold.
 *
 * The low byte is the one that carries the character in UTF-16, so a NUL or an
 * unprintable control there means these bytes were never text. Tab, newline and
 * carriage return are allowed because a text file contains them.
 */
function laneLooksTextual (sample, encoding) {
  const lowIndex = encoding === 'utf16le' ? 0 : 1
  for (let index = lowIndex; index < sample.length; index += 2) {
    const byte = sample[index]
    if (byte === 0x09 || byte === 0x0A || byte === 0x0D) continue
    if (byte < 0x20 || byte === 0x7F) return false
  }
  return true
}

/**
 * Decode a whole file body that {@link fileFormatOf} already classified.
 *
 * The BOM is stripped, because it is a fact about the file rather than a
 * character in it: leaving U+FEFF in the text would put it in front of the
 * first line in the editor and write it back a second time.
 */
export function decodeBody (raw, encoding) {
  let body = raw
  if (startsWith(body, BOM_UTF8) && encoding === 'utf8') body = body.subarray(3)
  else if (startsWith(body, BOM_UTF16LE) && encoding === 'utf16le') body = body.subarray(2)
  else if (startsWith(body, BOM_UTF16BE) && encoding === 'utf16be') body = body.subarray(2)
  return decodeStrict(body, encoding)
}

/**
 * Decode the head of a file that was cut at the byte limit.
 *
 * A cut can land inside a character, and every decoder here is fatal, so the
 * last such character would turn a readable file into "invalid UTF-8". Dropping
 * trailing bytes until it decodes finds the boundary. Only used for a truncated
 * read, which is never saveable, so the small licence taken cannot reach a
 * write.
 */
export function decodeTruncated (raw, encoding) {
  // A 16-bit encoding needs an even length, and the BOM may already be gone.
  const body = raw.subarray(0, raw.length - (encoding === 'utf8' || encoding === 'gb18030' ? 0 : raw.length % 2))
  const budget = encoding === 'utf8' || encoding === 'gb18030' ? 4 : 2
  for (let trim = 0; trim <= budget; trim += 1) {
    const candidate = encoding === 'utf8' || encoding === 'gb18030'
      ? body.subarray(0, Math.max(0, body.length - trim))
      : body.subarray(0, Math.max(0, body.length - trim * 2))
    try {
      return decodeBody(candidate, encoding)
    } catch (error) {
      if (trim === budget) throw error
    }
  }
  return ''
}

/**
 * Decode one slice of a file that is too large to open whole.
 *
 * Two mistakes this exists to prevent, both of which the reference
 * implementation made first:
 *
 *  - re-sniffing the encoding per page. A page taken from the middle of a file
 *    has no BOM and can be valid UTF-8 by accident while the file is GB18030, so
 *    the encoding is decided ONCE from the first page and passed in for every
 *    later one.
 *  - assuming the cut is a character boundary. A page ends at a fixed byte
 *    count, so the last character is usually split; dropping tail bytes until
 *    the strict decoder is satisfied is what finds the real boundary. The bytes
 *    dropped are NOT lost — they are the start of the next page, which is why
 *    the return value says how much was consumed instead of leaving the caller
 *    to assume the whole buffer was used.
 *
 * `first` decides whether a leading BOM is stripped: only page one starts at the
 * beginning of the file, and a U+FEFF written in the middle of a file is a
 * character rather than a byte order mark.
 *
 * @param {Buffer} raw - bytes read at the page's offset.
 * @param {string} encoding - the encoding decided from the first page.
 * @param {{first: boolean}} [options]
 * @returns {{text: string, consumed: number}}
 */
export function decodePage (raw, encoding, options = {}) {
  const first = options.first === true
  const wide = encoding === 'utf16le' || encoding === 'utf16be'
  // A 16-bit encoding can only end on an even byte. A stray final byte is the
  // first byte of the next page, not damage, so it is left for that page.
  const body = wide ? raw.subarray(0, raw.length - (raw.length % 2)) : raw
  const unit = wide ? 2 : 1
  const decodeOnce = (buffer) => (first
    ? decodeBody(buffer, encoding)
    : decodeStrict(buffer, encoding, { keepBom: true }))
  // At most one character can be cut: 4 bytes in UTF-8 or GB18030, 2 code units
  // in UTF-16 (a surrogate pair).
  const budget = UNIT_BYTES[encoding] ?? 4
  for (let trim = 0; trim <= budget; trim += unit) {
    const candidate = body.subarray(0, Math.max(0, body.length - trim))
    try {
      return { text: decodeOnce(candidate), consumed: candidate.length }
    } catch (error) {
      if (!isInvalidData(error)) throw error
    }
  }
  throw new Error(`a page of this file does not line up with ${encoding} character boundaries`)
}

/**
 * Whether a decode failure means "these bytes are not valid in this encoding",
 * as opposed to a programming error such as an unknown encoding label. The
 * distinction is the one that once made every Chinese UTF-8 file report as
 * GB18030, so it is a named predicate rather than a bare `catch`.
 */
function isInvalidData (error) {
  return error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
}

/**
 * Encode text back into the bytes that will land on disk.
 *
 * Only the encodings in {@link WRITE_ENCODINGS} can be produced; a caller that
 * asks for another one is a bug, so it throws rather than guessing UTF-8 and
 * silently converting the file.
 */
export function encodeBody (text, encoding, bom) {
  if (!WRITE_ENCODINGS.has(encoding)) {
    throw new Error(`cannot encode text as ${encoding}: no encoder is available for it`)
  }
  if (encoding === 'utf8') {
    return Buffer.from(bom === true ? `\uFEFF${text}` : text, 'utf8')
  }
  // UTF-16 is encoded as LE and the byte pairs are swapped for BE. Doing the
  // BOM separately keeps U+FEFF from being swapped into U+FFFE, which is not a
  // byte order mark at all.
  const body = Buffer.from(text, 'utf16le')
  if (encoding === 'utf16le') {
    return bom === true ? Buffer.concat([BOM_UTF16LE, body]) : body
  }
  const swapped = Buffer.from(body)
  for (let index = 0; index + 1 < swapped.length; index += 2) {
    const first = swapped[index]
    swapped[index] = swapped[index + 1]
    swapped[index + 1] = first
  }
  return bom === true ? Buffer.concat([BOM_UTF16BE, swapped]) : swapped
}

/**
 * Whether a detected encoding can be written back without changing it.
 *
 * One question with two askers — the probe decides whether to draw the edit
 * button, and the save route refuses — so the answer lives here rather than
 * being spelled out twice.
 */
export function isWritableEncoding (encoding) {
  return WRITE_ENCODINGS.has(encoding)
}
