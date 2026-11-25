/**
 * Verify the upload/download SFTP mechanics against a real host, without DSH.
 *
 * The route family imports the host's filesystem seam and cannot load outside DSH,
 * but the write path it delegates to is plain ssh2 + the plugin's own
 * primitives. This reproduces that exact sequence — mkdirp the parent, write a
 * sibling staging file, rename onto the destination, clean up on failure — so
 * the mechanics can be proven on a live host without restarting the app.
 *
 * Usage:
 *   node scripts/verify-sftp.mjs <alias> [remoteDir]
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const alias = process.argv[2]
if (alias === undefined) {
  console.error('usage: node scripts/verify-sftp.mjs <alias> [remoteDir]')
  process.exit(2)
}
const remoteDir = (process.argv[3] ?? '/tmp').replace(/\/+$/u, '')
const dshHome = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
// The editable store moved into a plugin-private subdirectory; older installs
// still keep it at the $DSH_HOME root. Read the new path first, fall back to the
// legacy one so this script keeps working across the migration.
const newStorePath = path.join(dshHome, 'dsh-ssh-workspace', 'dsh-ssh.json')
const legacyStorePath = path.join(dshHome, 'dsh-ssh.json')
const storePath = existsSync(newStorePath) ? newStorePath : legacyStorePath
const store = JSON.parse(readFileSync(storePath, 'utf8'))
const hosts = Array.isArray(store.hosts) ? store.hosts : Object.values(store.hosts ?? {})
const host = hosts.find(h => h.alias === alias)
if (host === undefined) {
  console.error(`no host ${JSON.stringify(alias)}; known: ${hosts.map(h => h.alias).join(', ')}`)
  process.exit(2)
}

const ssh2Path = path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'ssh2')
if (!existsSync(ssh2Path)) { console.error(`ssh2 not found at ${ssh2Path}`); process.exit(2) }
const { Client } = await import(pathToFileURL(path.join(ssh2Path, 'lib', 'index.js')).href)

const config = { host: host.host, port: host.port ?? 22, username: host.user }
const auth = host.auth ?? {}
const secret = (store.secrets ?? {})[alias] ?? {}
if (auth.kind === 'key') {
  config.privateKey = readFileSync(auth.keyPath ?? secret.keyPath)
} else if (auth.kind === 'password') {
  config.password = secret.password ?? auth.password
}

const client = new Client()
const ready = new Promise((resolve, reject) => {
  client.once('ready', resolve)
  client.once('error', reject)
  client.connect(config)
})
await ready
const sftp = await new Promise((resolve, reject) => client.sftp((e, s) => (e ? reject(e) : resolve(s))))

let failed = 0
function check (label, ok, detail) {
  if (ok) console.log(`  PASS  ${label}`)
  else { failed += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
const call = (method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)))
})

/** The same parent computation the route performs. */
function remoteParentOf (remotePath) {
  const normalized = remotePath.replace(/\/+$/u, '')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return '/'
  return normalized.slice(0, index)
}

/** mkdir -p, tolerating an existing directory. */
async function mkdirp (target) {
  const parts = target.split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    try { await call('mkdir', current) } catch { /* already there */ }
  }
}

const stamp = Date.now().toString(36)

console.log(`\n=== verify SFTP mechanics against ${alias} (${host.host}) ===\n`)

try {
  // --- upload: mkdirp, stage, rename -------------------------------------
  const dest = `${remoteDir}/dsh-verify-${stamp}.txt`
  const payload = `verify ${stamp}`
  await mkdirp(remoteParentOf(dest))

  const staging = `${dest}.dsh-up-${stamp}`
  const handle = await call('open', staging, 'w')
  await call('write', handle, Buffer.from(payload), 0, payload.length, 0)
  await call('close', handle)
  await call('rename', staging, dest)
  check('a staged write renames onto the destination', true)

  const readBack = await new Promise((resolve, reject) => {
    const chunks = []
    const stream = sftp.createReadStream(dest)
    stream.on('data', c => chunks.push(c))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
  check('the staged bytes survive the rename', readBack === payload, JSON.stringify(readBack))

  const siblings = await call('readdir', remoteDir)
  check('no staging file is left behind',
    siblings.filter(e => e.filename.startsWith(`dsh-verify-${stamp}.txt.dsh-up-`)).length === 0)

  // --- download: stat then chunked read ---------------------------------
  const info = await call('stat', dest)
  check('stat reports the uploaded size', info.size === payload.length, String(info.size))
  const rh = await call('open', dest, 'r')
  const chunk = Buffer.alloc(256)
  const read = await new Promise((resolve, reject) => {
    sftp.read(rh, chunk, 0, chunk.length, 0, (err, n) => (err ? reject(err) : resolve(chunk.subarray(0, n))))
  })
  await call('close', rh)
  check('a chunked read returns the bytes', read.toString() === payload, JSON.stringify(read.toString()))

  // --- cleanup ----------------------------------------------------------
  await call('unlink', dest)
  check('the probe file is removed', true)
} catch (error) {
  failed += 1
  console.log(`  FAIL  ${error.message}`)
} finally {
  client.end()
}

console.log(`\n=== ${failed === 0 ? 'ok' : `${failed} failed`} ===`)
process.exit(failed === 0 ? 0 : 1)
