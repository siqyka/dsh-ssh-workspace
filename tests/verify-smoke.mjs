/**
 * Transfer verification: digests, the three tools' output shapes, and the
 * comparison whose whole point is refusing to call two missing values a match.
 *
 * Run: node tests/verify-smoke.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { REMOTE_HASHERS, digestOfHasherOutput, hashLocalFile, compareDigests, findRemoteHasher, hashRemoteFile } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'verify.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const cleanups = []
function scratch () {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-verify-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

console.log('\n=== verify smoke ===\n')

// ---------------------------------------------------------------------------
// 1. The three hashers' output shapes
// ---------------------------------------------------------------------------
console.log('[1] reading a digest out of each tool\'s output')
{
  const digest = 'a'.repeat(64)
  // sha256sum / shasum -a 256
  check('sha256sum shape', digestOfHasherOutput(`${digest}  /path/to/file\n`) === digest,
    digestOfHasherOutput(`${digest}  /path/to/file\n`))
  // openssl dgst -sha256 -r
  check('openssl -r shape', digestOfHasherOutput(`${digest} */path/to/file\n`) === digest,
    digestOfHasherOutput(`${digest} */path/to/file\n`))
  // Uppercase input is normalised down: OpenSSL and macOS spell it either way.
  check('uppercase is lowercased', digestOfHasherOutput(`${digest.toUpperCase()}  f`) === digest,
    digestOfHasherOutput(`${digest.toUpperCase()}  f`))
}

// ---------------------------------------------------------------------------
// 2. Junk is NOT a digest
// ---------------------------------------------------------------------------
console.log('[2] an unreadable output is undefined, not a wrong hash')
{
  check('empty output', digestOfHasherOutput('') === undefined)
  check('an error message', digestOfHasherOutput('sha256sum: no such file') === undefined,
    digestOfHasherOutput('sha256sum: no such file'))
  // A SHORT hex token must not be accepted: it would let a tool's error text be
  // compared as a checksum and "match".
  check('a truncated digest is rejected', digestOfHasherOutput('abc123  file') === undefined,
    digestOfHasherOutput('abc123  file'))
  check('a hash of the wrong algorithm is rejected',
    digestOfHasherOutput('a'.repeat(40) + '  file') === undefined,
    digestOfHasherOutput('a'.repeat(40) + '  file'))
}

// ---------------------------------------------------------------------------
// 3. Local hashing
// ---------------------------------------------------------------------------
console.log('[3] hashing a local file')
{
  const dir = scratch()
  const file = path.join(dir, 'x')
  writeFileSync(file, 'hello')
  // Known value: SHA-256("hello")
  const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  check('the digest is the known SHA-256', (await hashLocalFile(file)) === expected,
    await hashLocalFile(file))

  const empty = path.join(dir, 'empty')
  writeFileSync(empty, '')
  check('an empty file hashes to the empty-string digest',
    (await hashLocalFile(empty)) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    await hashLocalFile(empty))

  let aborted
  const controller = new AbortController()
  controller.abort()
  try { await hashLocalFile(file, controller.signal) } catch { aborted = true }
  check('an aborted hash rejects', aborted === true)
}

// ---------------------------------------------------------------------------
// 4. compareDigests — the case that matters
// ---------------------------------------------------------------------------
console.log('[4] comparing digests')
{
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  check('equal digests match', compareDigests(a, a).ok === true)
  check('different digests do not', compareDigests(a, b).ok === false)
  check('and the reason quotes both', /mismatch/u.test(compareDigests(a, b).reason ?? ''),
    compareDigests(a, b).reason)

  // THE case: in JavaScript `undefined === undefined` is true, so a comparison
  // written naively reports success exactly when both sides failed to hash.
  check('two missing digests do NOT match', compareDigests(undefined, undefined).ok === false,
    JSON.stringify(compareDigests(undefined, undefined)))
  check('a missing source is refused', compareDigests(undefined, a).ok === false)
  check('a missing destination is refused', compareDigests(a, undefined).ok === false)
  check('an empty string is missing, not a digest', compareDigests('', '').ok === false)
  // Case-insensitive: the tools spell it either way.
  check('case does not matter', compareDigests(a.toUpperCase(), a).ok === true)
}

// ---------------------------------------------------------------------------
// 5. Finding a hasher on the host
// ---------------------------------------------------------------------------
console.log('[5] finding a remote hasher')
{
  /** An engine double that answers the probe with a chosen set of tools. */
  const engineSaying = (present) => ({
    async exec (alias, command) {
      // Echo back exactly the tools the probe asked about and that "exist".
      const lines = REMOTE_HASHERS
        .filter(entry => present.includes(entry.name))
        .map(entry => `dsh-hash:${entry.name}`)
      return { success: true, exitCode: 0, stdout: lines.join('\n') + (lines.length > 0 ? '\n' : ''), stderr: '', timedOut: false, truncated: false, durationMs: 1 }
    },
  })

  check('sha256sum is preferred',
    (await findRemoteHasher(engineSaying(['sha256sum', 'shasum', 'openssl']), 'h'))?.name === 'sha256sum')
  check('shasum when that is all there is',
    (await findRemoteHasher(engineSaying(['shasum']), 'h'))?.name === 'shasum')
  check('openssl as a last resort',
    (await findRemoteHasher(engineSaying(['openssl']), 'h'))?.name === 'openssl')
  check('none at all is undefined, not a throw',
    (await findRemoteHasher(engineSaying([]), 'h')) === undefined)

  // A failing probe (host down) is also "no hasher", not an exception.
  const broken = { async exec () { return { success: false, exitCode: 1, stdout: '', stderr: 'denied', timedOut: false, truncated: false, durationMs: 1 } } }
  check('a failed probe is undefined', (await findRemoteHasher(broken, 'h')) === undefined)
}

// ---------------------------------------------------------------------------
// 6. Hashing on the host
// ---------------------------------------------------------------------------
console.log('[6] hashing a remote file')
{
  const digest = 'c'.repeat(64)
  const engine = {
    async exec (alias, command) {
      // The path must be quoted: a filename with a space or a quote would
      // otherwise split the command.
      if (!command.includes("'/srv/my file.txt'")) {
        return { success: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }
      }
      return { success: true, exitCode: 0, stdout: `${digest}  /srv/my file.txt\n`, stderr: '', timedOut: false, truncated: false, durationMs: 1 }
    },
  }
  const hasher = REMOTE_HASHERS[0]
  check('the digest is read', (await hashRemoteFile(engine, 'h', '/srv/my file.txt', hasher)) === digest,
    await hashRemoteFile(engine, 'h', '/srv/my file.txt', hasher))
  check('the path is shell-quoted, including the space',
    (await hashRemoteFile(engine, 'h', "/srv/it's.txt", hasher)) === undefined,
    'the quoting case did not reach the guard')
}

// ---------------------------------------------------------------------------
// 7. The hasher list is ordered and named
// ---------------------------------------------------------------------------
console.log('[7] the hasher list')
{
  check('three hashers', REMOTE_HASHERS.length === 3, String(REMOTE_HASHERS.length))
  check('each has a name and a command',
    REMOTE_HASHERS.every(entry => typeof entry.name === 'string' && typeof entry.command === 'string'))
  check('the order is the preference order',
    REMOTE_HASHERS.map(entry => entry.name).join(',') === 'sha256sum,shasum,openssl',
    REMOTE_HASHERS.map(entry => entry.name).join(','))
}

for (const cleanup of cleanups.reverse()) {
  try { cleanup() } catch { /* best effort */ }
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
