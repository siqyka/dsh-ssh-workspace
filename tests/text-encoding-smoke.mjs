/**
 * Text encoding sniffing: which bytes are text, and which text is which encoding.
 *
 * `lib/routes/text-encoding.js` decides whether a previewed file is readable at
 * all, which encoding to decode it with, and — separately — whether a save can
 * put those bytes back. Each of those answers has a wrong version that looks
 * right from the outside, and three of them were actually shipped while this
 * module was being written:
 *
 *  1. a `catch {}` around a decode reads a thrown LABEL error as "the bytes are
 *     not in this encoding", so every CJK UTF-8 file came back as GB18030 with
 *     no error anywhere;
 *  2. `textRatio` alone calls four bytes of binary "UTF-16", because
 *     `00 01 02 03` decodes to two printable characters;
 *  3. an odd-length HEAD is not evidence that the FILE is odd, so a truncated
 *     sample of a 3-byte binary file was classified `binary` and the same three
 *     bytes read whole were classified UTF-16.
 *
 * A route-level test cannot pin these, because a route only ever shows the
 * final sentence and never which rule produced it. This suite calls the module
 * directly.
 *
 * Run: node tests/text-encoding-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const moduleUrl = pathToFileURL(path.join(pluginRoot, 'lib', 'routes', 'text-encoding.js')).href

const {
  PAGE_BYTES,
  SAMPLE_BYTES,
  WRITE_ENCODINGS,
  decodeBody,
  decodePage,
  decodeTruncated,
  encodeBody,
  fileFormatOf,
  isWritableEncoding,
} = await import(moduleUrl)

let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const bytes = (...values) => Buffer.from(values)
const format = (raw, options) => fileFormatOf(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw, options)

console.log('\n=== text encoding smoke ===\n')

// ---------------------------------------------------------------------------
// Proof: a byte order mark
// ---------------------------------------------------------------------------
{
  const le = Buffer.concat([bytes(0xFF, 0xFE), Buffer.from('hello\n', 'utf16le')])
  check('a UTF-16LE BOM is believed', format(le).encoding === 'utf16le' && format(le).bom === true, JSON.stringify(format(le)))
  check('...and the text comes out without the mark', decodeBody(le, 'utf16le') === 'hello\n',
    JSON.stringify(decodeBody(le, 'utf16le')))

  const be = Buffer.concat([bytes(0xFE, 0xFF), Buffer.from('hello\n', 'utf16le').swap16()])
  check('a UTF-16BE BOM is believed', format(be).encoding === 'utf16be' && format(be).bom === true, JSON.stringify(format(be)))
  check('...and the text comes out right', decodeBody(be, 'utf16be') === 'hello\n', JSON.stringify(decodeBody(be, 'utf16be')))

  const utf8Bom = Buffer.concat([bytes(0xEF, 0xBB, 0xBF), Buffer.from('héllo\n', 'utf8')])
  check('a UTF-8 BOM is reported rather than shown as a character',
    format(utf8Bom).bom === true && decodeBody(utf8Bom, 'utf8') === 'héllo\n',
    JSON.stringify(decodeBody(utf8Bom, 'utf8')))

  // UTF-32 first, because `FF FE 00 00` also satisfies the UTF-16LE test. Read as
  // UTF-16 it would be text full of NULs, which is worse than a refusal.
  const utf32 = Buffer.concat([bytes(0xFF, 0xFE, 0x00, 0x00), bytes(0x41, 0x00, 0x00, 0x00)])
  check('a UTF-32 file is refused rather than read as UTF-16',
    format(utf32).encoding === undefined && format(utf32).reason === 'not-utf8', JSON.stringify(format(utf32)))
}

// ---------------------------------------------------------------------------
// The NUL byte is a hint, not an answer
// ---------------------------------------------------------------------------
{
  // This is the file the feature exists for: a BOM-less UTF-16 config, which the
  // old rule called broken because half its bytes are NUL.
  const le = Buffer.from('api_key = 1\n', 'utf16le')
  check('a BOM-less UTF-16LE file is text, not binary', format(le).encoding === 'utf16le', JSON.stringify(format(le)))
  check('...and it decodes back to what was written', decodeBody(le, 'utf16le') === 'api_key = 1\n',
    JSON.stringify(decodeBody(le, 'utf16le')))

  const be = Buffer.from('api_key = 1\n', 'utf16le').swap16()
  check('a BOM-less UTF-16BE file is text too', format(be).encoding === 'utf16be', JSON.stringify(format(be)))

  // `00 01 02 03` reads as U+0100 U+0302 under UTF-16LE — two printable
  // characters — so a ratio test alone calls this binary file "text".
  // `laneLooksTextual` is what refuses it, and this is the only assertion that
  // proves the second condition is still there.
  check('four bytes of binary are not UTF-16 just because they are even',
    format(bytes(0x00, 0x01, 0x02, 0x03)).encoding === undefined, JSON.stringify(format(bytes(0x00, 0x01, 0x02, 0x03))))
  check('...and are called binary', format(bytes(0x00, 0x01, 0x02, 0x03)).reason === 'binary',
    JSON.stringify(format(bytes(0x00, 0x01, 0x02, 0x03))))

  check('a NUL with no plausible 16-bit reading is binary',
    format(bytes(0x41, 0x00, 0x00, 0x00, 0xFF)).reason === 'binary', JSON.stringify(format(bytes(0x41, 0x00, 0x00, 0x00, 0xFF))))
}

// ---------------------------------------------------------------------------
// Whole file versus head: the odd-length rule
// ---------------------------------------------------------------------------
{
  const odd = bytes(0x41, 0x00, 0x42)
  // Read whole, an odd length proves it is not BOM-less UTF-16.
  check('an odd-length file read whole is not UTF-16',
    format(odd, { truncated: false }).encoding !== 'utf16le', JSON.stringify(format(odd, { truncated: false })))
  check('...it is binary', format(odd, { truncated: false }).reason === 'binary', JSON.stringify(format(odd, { truncated: false })))
  // Read as a HEAD, the same three bytes can be three of an even-length file, so
  // length is no longer evidence and the 16-bit reading has to be considered.
  check('an odd-length HEAD is not evidence about the file',
    format(odd, { truncated: true }).encoding !== undefined, JSON.stringify(format(odd, { truncated: true })))
}

// ---------------------------------------------------------------------------
// UTF-8 is UTF-8, including the CJK that used to be misreported
// ---------------------------------------------------------------------------
{
  check('plain ASCII is UTF-8', format('hello\n').encoding === 'utf8' && format('hello\n').bom === false,
    JSON.stringify(format('hello\n')))
  check('accented UTF-8 is UTF-8', format('héllo\n').encoding === 'utf8', JSON.stringify(format('héllo\n')))
  // The regression that mattered: a label error swallowed by a catch reported
  // every CJK UTF-8 file as GB18030, and the only visible symptom was mojibake.
  const cjk = format('你好世界\n')
  check('CJK UTF-8 is UTF-8 and not GB18030', cjk.encoding === 'utf8', JSON.stringify(cjk))
  check('...and decodes to the characters that were written', decodeBody(Buffer.from('你好世界\n', 'utf8'), cjk.encoding) === '你好世界\n',
    JSON.stringify(decodeBody(Buffer.from('你好世界\n', 'utf8'), cjk.encoding)))
}

// ---------------------------------------------------------------------------
// GB18030 is read but not written
// ---------------------------------------------------------------------------
{
  const gbk = bytes(0xC4, 0xE3, 0xBA, 0xC3, 0x0A)
  check('GB18030 Chinese is readable', format(gbk).encoding === 'gb18030', JSON.stringify(format(gbk)))
  check('...and decodes to the right characters', decodeBody(gbk, 'gb18030') === '你好\n', JSON.stringify(decodeBody(gbk, 'gb18030')))
  check('...but a save cannot encode it', isWritableEncoding('gb18030') === false)
  check('...and asking anyway throws rather than writing UTF-8', (() => {
    try { encodeBody('你好', 'gb18030', false); return false } catch { return true }
  })())
  // GB18030 accepts nearly anything, so "it decoded" is not evidence. Without
  // the CJK gate a Latin-1 French file opens as mojibake instead of being
  // refused.
  const latin1 = Buffer.from('café au lait\n', 'latin1')
  check('a Latin-1 file is not accepted as GB18030 just because it decodes',
    format(latin1).encoding === undefined, JSON.stringify(format(latin1)))
  check('...it is refused as not text', format(latin1).reason === 'not-utf8', JSON.stringify(format(latin1)))
  // A single byte outside ASCII that GB18030 maps to a symbol rather than to a
  // CJK character: the decode succeeds, and the gate is what still refuses it.
  check('a byte GB18030 can decode but that yields no CJK text is refused',
    format(bytes(0x80)).reason === 'not-utf8', JSON.stringify(format(bytes(0x80))))
  check('a file that decodes as neither is refused', format(bytes(0xFF, 0xFF, 0x2E)).reason === 'not-utf8',
    JSON.stringify(format(bytes(0xFF, 0xFF, 0x2E))))
  // The mirror image, and the case that proves the gate is not simply rejecting
  // everything: `E4 E8 2E` really is 滂 in GB18030, so it is text.
  check('a sequence that really is GB18030 Chinese is read as such',
    format(bytes(0xE4, 0xE8, 0x2E)).encoding === 'gb18030', JSON.stringify(format(bytes(0xE4, 0xE8, 0x2E))))
}

// ---------------------------------------------------------------------------
// Saving: the bytes come back the way they were read
// ---------------------------------------------------------------------------
{
  const encoded16 = encodeBody('alpha\nbeta\n', 'utf16le', true)
  check('UTF-16LE is encoded with a BOM when asked', encoded16[0] === 0xFF && encoded16[1] === 0xFE,
    encoded16.subarray(0, 2).toString('hex'))
  check('...and round-trips through the decoder', decodeBody(encoded16, 'utf16le') === 'alpha\nbeta\n',
    JSON.stringify(decodeBody(encoded16, 'utf16le')))

  const encodedBe = encodeBody('alpha\n', 'utf16be', true)
  check('UTF-16BE is encoded big-endian', encodedBe[0] === 0xFE && encodedBe[1] === 0xFF,
    encodedBe.subarray(0, 2).toString('hex'))
  check('...and round-trips through the decoder', decodeBody(encodedBe, 'utf16be') === 'alpha\n',
    JSON.stringify(decodeBody(encodedBe, 'utf16be')))

  // The BOM must be added as bytes rather than encoded as a character: swapping
  // the pairs of an encoded U+FEFF produces U+FFFE, which is not a byte order
  // mark at all.
  check('the UTF-16BE BOM is not a swapped U+FEFF',
    encodedBe.readUInt16BE(0) === 0xFEFF && encodedBe.readUInt16BE(2) === 0x0061,
    encodedBe.subarray(0, 4).toString('hex'))

  const plain = encodeBody('alpha\n', 'utf8', false)
  check('UTF-8 without a BOM has no BOM', !(plain[0] === 0xEF && plain[1] === 0xBB && plain[2] === 0xBF),
    plain.subarray(0, 3).toString('hex'))
  check('...and UTF-8 with one has exactly one', (() => {
    const withBom = encodeBody('alpha\n', 'utf8', true)
    return withBom[0] === 0xEF && withBom[1] === 0xBB && withBom[2] === 0xBF &&
      decodeBody(withBom, 'utf8') === 'alpha\n'
  })())

  check('the writable set is exactly UTF-8 and the two UTF-16 orders',
    [...WRITE_ENCODINGS].sort().join(',') === 'utf16be,utf16le,utf8', [...WRITE_ENCODINGS].join(','))
}

// ---------------------------------------------------------------------------
// Truncated reads: a cut can land inside a character
// ---------------------------------------------------------------------------
{
  const cjk = Buffer.from('你好世界', 'utf8')
  // Every prefix of a multi-byte sequence must still decode, or a preview of a
  // large file fails on where the byte cap happened to fall.
  let allDecoded = true
  for (let cut = cjk.length; cut >= cjk.length - 3; cut -= 1) {
    try { decodeTruncated(cjk.subarray(0, cut), 'utf8') } catch { allDecoded = false }
  }
  check('a head cut inside a UTF-8 character still decodes', allDecoded)

  const utf16 = Buffer.from('hello world\n', 'utf16le')
  // One byte short of the whole file: the code unit it cuts in half is dropped,
  // and the rest still has to decode. What comes back is the text before the cut,
  // not the text after it — a truncated read describes a prefix.
  const oddCut = utf16.subarray(0, utf16.length - 1)
  check('a head cut between UTF-16 bytes still decodes', (() => {
    try { return decodeTruncated(oddCut, 'utf16le') === 'hello world' } catch { return false }
  })(), JSON.stringify((() => { try { return decodeTruncated(oddCut, 'utf16le') } catch (error) { return String(error) } })()))

  check('a whole file decodes through the same path', decodeTruncated(Buffer.from('alpha\n', 'utf8'), 'utf8') === 'alpha\n')
}

// ---------------------------------------------------------------------------
// A head cut at a byte count lands inside a character most of the time
// ---------------------------------------------------------------------------
{
  // Three bytes per character and an 8 192-byte sample: only one file in three
  // ends its head on a boundary. The other two used to be reported as GB18030 —
  // the leftover half character made strict UTF-8 refuse, and the same bytes
  // read as two-byte GBK characters, which is why the answer was wrong rather
  // than absent. A page cut has to survive the same thing.
  const cjk = '界'.repeat(4000)
  const raw = Buffer.from(cjk, 'utf8')
  const cut = raw.subarray(0, SAMPLE_BYTES)
  check('a head cut mid-character still says UTF-8, not GB18030',
    format(cut, { truncated: true }).encoding === 'utf8', JSON.stringify(format(cut, { truncated: true })))
  check('...and the same bytes read whole say UTF-8 too',
    format(raw.subarray(0, (SAMPLE_BYTES / 3 | 0) * 3), { truncated: false }).encoding === 'utf8')

  // The page seam: 128 KiB of three-byte characters is cut on a boundary only
  // once in three, so a page that assumed the cut was clean would garble the
  // last character of every page.
  const many = '界'.repeat(Math.ceil(PAGE_BYTES / 3) + 5)
  const manyRaw = Buffer.from(many, 'utf8')
  const page = decodePage(manyRaw.subarray(0, PAGE_BYTES), 'utf8', { first: true })
  check('a page cut mid-character ends on a real boundary',
    page.consumed === PAGE_BYTES - (PAGE_BYTES % 3), `${page.consumed} of ${PAGE_BYTES}`)
  check('...and it reports how much it consumed, so the next page starts where it stopped',
    page.text === '界'.repeat(page.consumed / 3), String(page.text.length))
  const rest = decodePage(manyRaw.subarray(page.consumed), 'utf8', { first: false })
  check('...and the pages add up to the file',
    page.text + rest.text === many, `${page.text.length}+${rest.text.length} vs ${many.length}`)

  const utf16 = Buffer.from('abcdefgh', 'utf16le')
  const oddPage = decodePage(utf16.subarray(0, 7), 'utf16le', { first: true })
  check('a UTF-16 page cut between bytes stops at the last whole unit',
    oddPage.consumed === 6 && oddPage.text === 'abc', JSON.stringify({ consumed: oddPage.consumed, text: oddPage.text }))

  // Only page one starts at the beginning of the file, so only page one can
  // start with a byte order mark. A U+FEFF in the middle is a character.
  const withBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('x', 'utf8')])
  check('a BOM is stripped from the first page',
    decodePage(withBom, 'utf8', { first: true }).text === 'x', JSON.stringify(decodePage(withBom, 'utf8', { first: true }).text))
  check('...but the same bytes later in the file are kept',
    decodePage(withBom, 'utf8', { first: false }).text === '\uFEFFx',
    JSON.stringify(decodePage(withBom, 'utf8', { first: false }).text))

  check('an encoding the decoder does not know is an error, not an empty page', (() => {
    try { decodePage(Buffer.from('a'), 'utf32', { first: true }); return false } catch (error) { return /unknown text encoding/u.test(String(error)) }
  })())
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
