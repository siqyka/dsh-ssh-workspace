/**
 * Host-key pinning: a key that could not be saved must not look pinned.
 *
 * The plugin trusts a server's host key on first use and records it, so a later
 * key that differs is refused. The recording can fail — a read-only `DSH_HOME`,
 * a full disk, a locked store — and the old code handled that by logging a
 * warning and connecting anyway. In this deployment `ctx.logger` reaches a ring
 * buffer nothing reads, so the warning was observationally identical to nothing
 * happening: the user believed the key was pinned, while every subsequent
 * connection silently trusted whatever the server presented.
 *
 * The rule asserted here: the connection still succeeds (refusing to connect
 * over a persistence failure would be worse), but the weakened trust state is
 * recorded where the status surfaces can show it.
 *
 * Run: node tests/host-key-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * A raw public-key blob: `string algorithm-name` + `string key-data`.
 *
 * The verifier parses exactly this framing to derive the type and fingerprint,
 * so the fixture must produce a real one rather than a bare Buffer.
 */
function keyBlob (algorithm, body = 'key-material') {
  const name = Buffer.from(algorithm, 'utf8')
  const data = Buffer.from(body, 'utf8')
  return Buffer.concat([
    Buffer.from([0, 0, 0, name.length]), name,
    Buffer.from([0, 0, 0, data.length]), data,
  ])
}

/** An engine whose store can be made to fail on write. */
function engineWith ({ recordFails = false, known = undefined } = {}) {
  const engine = new SshWorkspaceEngine({ reconnect: false })
  const writes = []
  engine.store = {
    knownHostKey: () => known,
    rememberHostKey: (alias, value) => {
      if (recordFails) throw new Error('EACCES: cannot write the host store')
      writes.push({ alias, value })
    },
  }
  return { engine, writes }
}

/**
 * The verifier the engine hands to ssh2, plus the state it records a refusal on.
 *
 * `verifierForTest` is the engine's own seam: `#connect` builds the verifier
 * inside a private method that also opens a socket, so this is the only way to
 * exercise the trust decision without faking ssh2. The state object is the same
 * one the real connect path passes, which is why a refusal's details are
 * observable here.
 */
function verifierOf (engine, alias = 'h') {
  const state = { mismatch: undefined }
  return { verify: engine.verifierForTest(alias, { state }), state }
}

console.log('\n[1] a first-use key is recorded when the store accepts it')
{
  const { engine, writes } = engineWith()
  const { verify } = verifierOf(engine)
  const blob = keyBlob('ssh-ed25519')
  check('the key is accepted', verify(blob) === true, 'refused')
  check('the key was written to the store', writes.length === 1, `${writes.length} writes`)
  check('the stored fingerprint is the OpenSSH SHA256 form',
    /^SHA256:[A-Za-z0-9+/]+$/u.test(writes[0]?.value?.fingerprint ?? ''), String(writes[0]?.value?.fingerprint))
  check('the stored key type was parsed from the blob',
    writes[0]?.value?.keyType === 'ssh-ed25519', String(writes[0]?.value?.keyType))
  check('nothing is reported as unpinned', engine.unpinnedHostKeyRows().length === 0,
    JSON.stringify(engine.unpinnedHostKeyRows()))
}

console.log('\n[2] THE DEFECT: a key that cannot be saved is accepted but marked')
{
  const { engine } = engineWith({ recordFails: true })
  const { verify } = verifierOf(engine)
  const blob = keyBlob('ssh-ed25519')
  check('the connection is NOT refused over a persistence failure', verify(blob) === true, 'refused')
  check('the unpinned state is recorded on the engine',
    engine.unpinnedHostKeyRows().length === 1, JSON.stringify(engine.unpinnedHostKeyRows()))
  check('the recorded row names the host',
    engine.unpinnedHostKeyRows()[0]?.alias === 'h', JSON.stringify(engine.unpinnedHostKeyRows()))
  check('the recorded row carries the fingerprint that was trusted',
    /^SHA256:/u.test(engine.unpinnedHostKeyRows()[0]?.fingerprint ?? ''), JSON.stringify(engine.unpinnedHostKeyRows()))
  // The warning must reach a surface a user actually reads: `ctx.logger` does
  // not, which is why this went unnoticed.
  check('the failure is recorded in the diagnostics log',
    engine.diagnostics.list().some(entry => /host key NOT pinned/u.test(entry.message)),
    JSON.stringify(engine.diagnostics.list()))
  check('the diagnostic explains the consequence',
    engine.diagnostics.list().some(entry => /next connection will trust this key again/u.test(entry.message)),
    JSON.stringify(engine.diagnostics.list()))
}

console.log('\n[3] a key that is already pinned is never reported as unpinned')
{
  const known = { fingerprint: 'SHA256:already-pinned', keyType: 'ssh-ed25519' }
  const { engine } = engineWith({ known })
  const { verify } = verifierOf(engine)
  const blob = keyBlob('ssh-ed25519', 'same-material')
  // The fingerprint will differ from the recorded one, so this refuses — the
  // point is only that no unpinned row appears for a REFUSAL.
  verify(blob)
  check('a mismatch does not create an unpinned row',
    engine.unpinnedHostKeyRows().length === 0, JSON.stringify(engine.unpinnedHostKeyRows()))
}

console.log('\n[4] a later successful pin clears the warning')
{
  const { engine } = engineWith({ recordFails: true })
  const { verify } = verifierOf(engine)
  const blob = keyBlob('ssh-ed25519')
  verify(blob)
  check('the warning exists after the failed write', engine.unpinnedHostKeyRows().length === 1)

  // Now the store works and the key is on record: the warning is obsolete.
  const fingerprint = engine.unpinnedHostKeyRows()[0].fingerprint
  engine.store = {
    knownHostKey: () => ({ fingerprint, keyType: 'ssh-ed25519' }),
    rememberHostKey: () => {},
  }
  const second = verifierOf(engine)
  check('a matching pinned key is accepted', second.verify(blob) === true, 'refused')
  check('the unpinned warning was cleared', engine.unpinnedHostKeyRows().length === 0,
    JSON.stringify(engine.unpinnedHostKeyRows()))
}

console.log('\n[5] a different key is still refused, pinned or not')
{
  const { engine } = engineWith({ recordFails: true })
  const { verify, state } = verifierOf(engine)
  verify(keyBlob('ssh-ed25519', 'first'))
  // Record what the first connect trusted, then present something else.
  const trusted = engine.unpinnedHostKeyRows()[0].fingerprint
  engine.store = { knownHostKey: () => ({ fingerprint: trusted, keyType: 'ssh-ed25519' }), rememberHostKey: () => {} }
  const second = verifierOf(engine)
  check('a changed key is refused', second.verify(keyBlob('ssh-ed25519', 'second')) === false, 'accepted')
  check('the refusal carries both sides', second.state.mismatch !== undefined,
    JSON.stringify(second.state.mismatch))
  check('the refusal names the recorded fingerprint',
    /SHA256:/u.test(second.state.mismatch?.recorded?.fingerprint ?? ''), JSON.stringify(second.state.mismatch))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
