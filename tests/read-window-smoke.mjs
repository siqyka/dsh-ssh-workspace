/**
 * Reading a byte range with several SFTP requests in flight.
 *
 * The two properties here cannot be seen on a fast host. A window of one would
 * still return the right bytes, and a server that always answers a full READ
 * hides the bug this module was written to fix: the old loop treated a short
 * answer as end-of-file, so a single partial READ truncated the file. A LAN
 * round trip rarely short-reads; a WAN one does, and then the editor showed a
 * file that ended in the middle of a line.
 *
 * The constants are pinned, not just sanity-checked. They were chosen from
 * measurements on a slow host (2 MiB: 49.7 s at 64 KiB/request, 20.9 s at
 * 256 KiB, 6–8 s at 256 KiB with four windows), so a later "optimisation" that
 * quietly drops back to small requests has to face this suite and the comment
 * that records why.
 *
 * Run: node tests/read-window-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== read window smoke ===\n')

const { READ_CHUNK_BYTES, READ_WINDOW, readHandle } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib', 'fs', 'read-window.js')).href
)

// A shape-compatible double: ssh2's `sftp.read(handle, buffer, offset, length,
// position, callback)`. It answers asynchronously so overlap is observable, and
// it can answer short or fail on purpose.
function fakeHandle (bytes, options = {}) {
  const stats = { requests: 0, inFlight: 0, peak: 0, positions: [], sizes: [] }
  const answerCap = options.answerCap
  const failAt = options.failAt
  const delay = options.delay ?? 1
  const sftp = {
    read (handle, buffer, offset, length, position, callback) {
      stats.requests += 1
      stats.inFlight += 1
      stats.peak = Math.max(stats.peak, stats.inFlight)
      stats.positions.push(position)
      stats.sizes.push(length)
      const finish = (error, read) => {
        stats.inFlight -= 1
        if (error !== undefined && error !== null) callback(error)
        else callback(null, read)
      }
      setTimeout(() => {
        if (failAt !== undefined && position === failAt) {
          finish(new Error('read failed'))
          return
        }
        const available = Math.max(0, Math.min(length, bytes.length - position))
        if (available === 0) {
          finish(null, 0)
          return
        }
        const size = answerCap === undefined ? available : Math.min(available, answerCap)
        bytes.copy(buffer, offset, position, position + size)
        finish(null, size)
      }, delay)
    },
  }
  return { sftp, stats }
}

/** Bytes with no zero run, so a truncated tail is recognisable. */
const source = Buffer.alloc(40 * 1024)
for (let index = 0; index < source.length; index += 1) source[index] = index % 251

// ---------------------------------------------------------------------------
// [1] A short answer is a partial read, not the end of the file
// ---------------------------------------------------------------------------
{
  const { sftp } = fakeHandle(source, { answerCap: 4096, delay: 0 })
  const data = await readHandle(sftp, 7, 0, source.length, 'ssh://box/srv/app/x.txt')
  check('a server that never answers more than 4 KiB still yields the whole file',
    data.equals(source), `${data.length}/${source.length}`)
  check('...so the old "short means EOF" truncation cannot come back',
    data.length === source.length)
}

// ---------------------------------------------------------------------------
// [2] The window really overlaps, and stays inside its bound
// ---------------------------------------------------------------------------
{
  const big = Buffer.alloc(READ_CHUNK_BYTES * 6 + 1024, 7)
  const { sftp, stats } = fakeHandle(big, { delay: 5 })
  const data = await readHandle(sftp, 1, 0, big.length, 'ssh://box/srv/app/big.txt')
  check('a file larger than one window is read whole', data.equals(big))
  check('...with more than one request in flight', stats.peak > 1, `peak=${stats.peak}`)
  check('...and never more than the declared window', stats.peak <= READ_WINDOW, `peak=${stats.peak}`)
  check('...filling the window completely', stats.peak === READ_WINDOW, `peak=${stats.peak}`)
  check('every request asks for at most one chunk',
    stats.sizes.every(size => size > 0 && size <= READ_CHUNK_BYTES),
    [...new Set(stats.sizes)].join(','))
  check('...and they tile the file in order',
    stats.positions.every((position, index) => index === 0 || position > stats.positions[index - 1]))
}

// ---------------------------------------------------------------------------
// [3] Ranges: an offset and a length, not just "the file"
// ---------------------------------------------------------------------------
{
  const { sftp, stats } = fakeHandle(source, { delay: 0 })
  const slice = await readHandle(sftp, 1, 1000, 5000, 'ssh://box/srv/app/x.txt')
  check('a range read returns exactly that range', slice.equals(source.subarray(1000, 6000)),
    `${slice.length} bytes`)
  check('...without touching anything before it', stats.positions.every(position => position >= 1000))
  const past = await readHandle(sftp, 1, source.length - 100, 4096, 'ssh://box/srv/app/x.txt')
  check('a range crossing the end returns what exists and stops', past.equals(source.subarray(source.length - 100)),
    `${past.length} bytes`)
  const empty = await readHandle(sftp, 1, 10, 0, 'ssh://box/srv/app/x.txt')
  check('a zero-length range issues no request at all',
    empty.length === 0 && stats.requests === 3, `requests=${stats.requests}`)
}

// ---------------------------------------------------------------------------
// [4] Failures keep the caller's path and verb, and do not leak rejections
// ---------------------------------------------------------------------------
{
  const { sftp, stats } = fakeHandle(source, { failAt: 0, delay: 0 })
  const wrap = (error, displayPath) => new Error(`${displayPath}: read: ${error.message}`)
  const error = await readHandle(sftp, 1, 0, 8192, 'ssh://box/srv/app/x.txt', wrap)
    .then(() => null, (caught) => caught)
  check('a failed request is reported with the path and the read verb',
    error?.message === 'ssh://box/srv/app/x.txt: read: read failed', error?.message)
  check('...and the failed window drains instead of leaving requests hanging',
    stats.inFlight === 0, `in flight=${stats.inFlight}`)
  const quiet = await new Promise((resolve) => {
    process.once('unhandledRejection', () => resolve(false))
    setTimeout(() => resolve(true), 50)
  })
  check('...with no unhandled rejection from the requests that did finish', quiet)
}

// ---------------------------------------------------------------------------
// [5] The module numbers, and the seam it was extracted from
// ---------------------------------------------------------------------------
{
  check('one request carries a quarter of a megabyte',
    READ_CHUNK_BYTES === 256 * 1024, String(READ_CHUNK_BYTES))
  check('...and four of them are allowed in flight',
    READ_WINDOW === 4, String(READ_WINDOW))
  check('...so one file occupies at most 1 MiB of buffers',
    READ_CHUNK_BYTES * READ_WINDOW === 1024 * 1024)

  const remoteFs = readFileSync(path.join(pluginRoot, 'lib', 'fs', 'remote-fs.js'), 'utf8')
  check('remote-fs reads through the window module instead of its own loop',
    remoteFs.includes("from './read-window.js'") && !/function readFilling/u.test(remoteFs))
  check('...and still exports the adapter the fs shim calls',
    remoteFs.includes('async function sftpReadHandle') && remoteFs.includes('sftpReadHandle,'))

  const textRoute = readFileSync(path.join(pluginRoot, 'lib', 'routes', 'text.js'), 'utf8')
  check('the local probe reads a bounded prefix, never a readFile of the target',
    !textRoute.includes('readFile(target)') &&
      textRoute.includes('info.size <= PRELOAD_MAX_BYTES ? info.size : SAMPLE_BYTES'))
  check('...and a whole-file read is nowhere in the probe',
    /if \(wanted > 0\) \{\s*const handle = await open\(target, 'r'\)/u.test(textRoute))
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
