/**
 * Verify the zip writer against a REAL reader.
 *
 * The lesson from `tar.js` is repeated here because it applies twice over: a
 * hand-written writer whose verification is another hand-written parser proves
 * only that the two agree. The first tar writer wrote its size field in decimal,
 * every byte-level assertion passed, and every real archiver rejected the
 * result. A zip has MORE of those traps — the endianness of every field, the
 * CRC-32 that readers check before they will show any content, the data
 * descriptor that only matters because we stream.
 *
 * So this script builds archives with `lib/zip.js` and then opens them with
 * Python's `zipfile`, which is an independent implementation that verifies CRCs
 * on read. If Python is unavailable the script still checks structure, and says
 * loudly that the real-reader half did not run.
 *
 * Run: node tests/zip-smoke.mjs
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { crc32Update, dosDateTime, zipStream, localHeader, centralHeader } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib', 'zip.js')).href
)

let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Collect a whole archive into one buffer. */
async function collect (entries) {
  const parts = []
  for await (const chunk of zipStream(entries())) parts.push(chunk)
  return Buffer.concat(parts)
}

/** An async iterable of the given buffers. */
async function * chunksOf (parts) {
  for (const part of parts) yield part
}

/** One file entry with real bytes. */
function fileEntry (name, parts, mtime = 1700000000) {
  const size = parts.reduce((total, part) => total + part.length, 0)
  return { path: name, size, mtime, type: '0', chunks: chunksOf(parts) }
}

console.log('\n=== zip smoke ===\n')

// ------------------------------------------------------------------- CRC-32
console.log('[CRC-32]')
// The canonical check value for "123456789" is 0xCBF43926. A wrong polynomial
// or a missing final XOR produces a plausible-looking but wrong number, which
// is exactly why this constant is quoted in the CRC literature.
check('crc32("123456789") === 0xCBF43926', crc32Update(0, Buffer.from('123456789')) === 0xcbf43926)
check('crc32("") === 0', crc32Update(0, Buffer.alloc(0)) === 0)
// Incremental across chunk boundaries must equal one-shot: the writer folds the
// checksum chunk by chunk as the bytes stream, so this is load-bearing.
{
  const whole = Buffer.from('the quick brown fox jumps over the lazy dog')
  const once = crc32Update(0, whole)
  let rolling = 0
  for (let index = 0; index < whole.length; index += 7) {
    rolling = crc32Update(rolling, whole.subarray(index, index + 7))
  }
  check('CRC folded per chunk equals one-shot', rolling === once, `${rolling} vs ${once}`)
}

// --------------------------------------------------------------- DOS datetime
console.log('\n[DOS date and time]')
{
  // 1980-01-01T00:00:00Z is the format's epoch: date = year<<9 | month<<5 | day.
  const epoch = dosDateTime(Date.UTC(1980, 0, 1) / 1000)
  check('1980-01-01 encodes as month 1 day 1 year 0', epoch.date === ((1 << 5) | 1), String(epoch.date))
  check('1980-01-01 has a zero time field', epoch.time === 0)
  // A time before the epoch cannot be represented and must NOT wrap around into
  // a future date, which is what a raw subtraction would do.
  const ancient = dosDateTime(Date.UTC(1970, 0, 1) / 1000)
  check('pre-1980 clamps to the epoch instead of wrapping', ancient.date === ((1 << 5) | 1) && ancient.time === 0)
  // Seconds are stored in units of two, so 58 becomes 29.
  const timed = dosDateTime(Date.UTC(2020, 5, 15, 12, 30, 58) / 1000)
  check('seconds are stored divided by two', (timed.time & 0x1f) === 29, String(timed.time & 0x1f))
}

// ---------------------------------------------------------- header structure
console.log('\n[header structure]')
{
  const header = localHeader({ name: Buffer.from('a.txt'), directory: false, descriptor: true, zip64: false, mtime: 0 })
  check('local header is 30 bytes', header.length === 30, String(header.length))
  check('local signature is PK\\x03\\x04', header.readUInt32LE(0) === 0x04034b50)
  // Bit 3 is the whole streaming premise: without it a reader expects the CRC
  // and sizes in this header, finds zeros, and treats the entry as empty.
  check('descriptor flag (bit 3) is set', (header.readUInt16LE(6) & 0x0008) !== 0)
  check('UTF-8 flag (bit 11) is set', (header.readUInt16LE(6) & 0x0800) !== 0)

  const dir = localHeader({ name: Buffer.from('d/'), directory: true, descriptor: false, zip64: false, mtime: 0 })
  check('a directory entry uses method 0 (stored)', dir.readUInt16LE(8) === 0)
}

// ------------------------------------------------------- against a real reader
console.log('\n[against Python zipfile]')
const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-zip-'))
let pythonAvailable = true
try {
  execFileSync('python', ['-c', 'import zipfile'], { stdio: 'pipe' })
} catch {
  try { execFileSync('python3', ['-c', 'import zipfile'], { stdio: 'pipe' }) } catch { pythonAvailable = false }
}

if (!pythonAvailable) {
  console.log('  SKIP  no Python with zipfile — the real-reader half did NOT run')
} else {
  // A tree with the shapes that break archives: a nested directory, an empty
  // file, a file whose name needs UTF-8, and a file large enough to span more
  // than one deflate block.
  const big = Buffer.alloc(700_000)
  for (let index = 0; index < big.length; index += 1) big[index] = index % 251
  const archive = await collect(async function * () {
    yield { path: 'project/', type: '5', mtime: 1700000000 }
    yield fileEntry('project/readme.txt', [Buffer.from('hello archive\n')])
    yield fileEntry('project/empty.txt', [])
    yield fileEntry('project/子目录/数据.bin', [big.subarray(0, 300_000), big.subarray(300_000)])
    yield fileEntry('project/nested/deep/file.txt', [Buffer.from('deep\n')])
  })
  const archivePath = path.join(scratch, 'tree.zip')
  await writeFile(archivePath, archive)
  console.log(`  (built a ${archive.length}-byte archive)`)

  const script = `
import json, sys, zipfile
path = sys.argv[1]
result = {"names": [], "errors": [], "contents": {}}
with zipfile.ZipFile(path) as archive:
    bad = archive.testzip()
    if bad is not None:
        result["errors"].append("CRC mismatch in " + bad)
    for info in archive.infolist():
        result["names"].append(info.filename)
        if not info.is_dir():
            data = archive.read(info.filename)
            result["contents"][info.filename] = {"len": len(data), "crc": info.CRC}
print(json.dumps(result))
`
  const scriptPath = path.join(scratch, 'inspect.py')
  await writeFile(scriptPath, script)
  const python = (() => {
    try { execFileSync('python', ['-c', 'pass'], { stdio: 'pipe' }); return 'python' } catch { return 'python3' }
  })()
  let parsed
  let readError
  try {
    const output = execFileSync(python, [scriptPath, archivePath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    parsed = JSON.parse(output)
  } catch (error) {
    readError = String(error.stderr ?? error.message)
  }

  check('a real reader opens the archive', readError === undefined, readError)
  if (parsed !== undefined) {
    check('no entry fails its CRC check', parsed.errors.length === 0, parsed.errors.join('; '))
    check('every entry is present', parsed.names.length === 5, parsed.names.join(','))
    check('directory entry keeps its trailing slash', parsed.names.includes('project/'))
    check('nested UTF-8 name survives', parsed.names.includes('project/子目录/数据.bin'), parsed.names.join(','))
    check('small file has the right length', parsed.contents['project/readme.txt']?.len === 14, JSON.stringify(parsed.contents['project/readme.txt']))
    check('empty file is a real zero-length entry', parsed.contents['project/empty.txt']?.len === 0)
    check('700 KB file survives the round trip', parsed.contents['project/子目录/数据.bin']?.len === 700_000)
    // The CRC the READER reports must equal the one this writer computed over
    // the source bytes. Python already verified it on read (testzip), but
    // comparing the numbers catches a writer that reports a right CRC for the
    // wrong bytes.
    const readerCrc = parsed.contents['project/readme.txt']?.crc
    check('reader CRC matches the source bytes', readerCrc === crc32Update(0, Buffer.from('hello archive\n')), `${readerCrc}`)
  }
}

// ------------------------------------------------------------- stored vs deflate
console.log('\n[compression]')
{
  // Highly compressible input must actually get smaller, or "deflate" is a lie
  // and the archive is a stored one wearing method 8.
  const repeat = Buffer.from('a'.repeat(200_000))
  const archive = await collect(async function * () {
    yield fileEntry('a.txt', [repeat])
  })
  check('compressible data is deflated', archive.length < 5_000, `${archive.length} bytes`)
  // A deflate stream can expand slightly on incompressible input; what must NOT
  // happen is silent truncation. The bytes have to be genuinely random for this
  // to mean anything: the first version of this check used `(i * 37) % 256`,
  // which is periodic and deflates to 2 KB — it passed the "deflated" assertion
  // and told us nothing about the incompressible case.
  const incompressible = randomBytes(120_000)
  const packing = await collect(async function * () {
    yield fileEntry('b.bin', [incompressible])
  })
  check('incompressible data is preserved, not truncated', packing.length >= incompressible.length, `${packing.length} vs ${incompressible.length}`)
}

// ------------------------------------------------------------ declared size
console.log('\n[declared size enforcement]')
{
  // A source that delivers fewer bytes than it declared is a corrupt archive,
  // not a short entry: every following header would land at the wrong offset.
  let threw
  try {
    const bad = { path: 'short.bin', size: 100, mtime: 0, type: '0', chunks: chunksOf([Buffer.alloc(10)]) }
    await collect(async function * () { yield bad })
  } catch (error) {
    threw = error
  }
  check('a short entry throws instead of emitting a corrupt archive', threw !== undefined)

  let overThrew
  try {
    const over = { path: 'long.bin', size: 10, mtime: 0, type: '0', chunks: chunksOf([Buffer.alloc(500)]) }
    await collect(async function * () { yield over })
  } catch (error) {
    overThrew = error
  }
  check('an over-long entry throws too', overThrew !== undefined)
}

// ------------------------------------------------------------------- cleanup
await rm(scratch, { recursive: true, force: true })

console.log(`\n=== zip smoke: ${passed} passed, ${failures.length} failed ===\n`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exit(1)
}
