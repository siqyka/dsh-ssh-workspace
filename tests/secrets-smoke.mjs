/**
 * Encrypted-secret checks: at-rest encryption of stored SSH secrets.
 *
 * The shared host store must never hold a password or key passphrase in
 * plaintext. This suite drives the store directly (no DSH tree, no SSH host):
 * it writes hosts with secrets, and inspects both the file on disk and what the
 * store hands back to the engine.
 *
 * Run: node tests/secrets-smoke.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { HostConfigStore } from '../lib/store.js'
import { HostStore } from '../lib/hosts.js'
import { SecretCodec, isEncrypted, keyPath } from '../lib/secrets.js'

console.log('\n=== secrets smoke ===\n')

const home = mkdtempSync(path.join(tmpdir(), 'dsh-secrets-'))
process.env.DSH_HOME = home
const storeFile = path.join(home, 'dsh-ssh.json')
const sshConfig = path.join(home, 'ssh_config')
writeFileSync(sshConfig, '', 'utf8')

const read = () => readFileSync(storeFile, 'utf8')
const parsed = () => JSON.parse(read())

let failures = 0
function check (label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function entry (alias, auth) {
  return { alias, host: `${alias}.example.com`, port: 22, user: 'root', auth }
}

try {
  const store = new HostConfigStore(storeFile)
  check('the key file is only created on demand', !existsSync(keyPath()))

  // -- create: the password reaches the file only as ciphertext -------------
  store.create(entry('alpha', { kind: 'password', password: 'hunter2' }))
  const alpha = parsed().hosts.find(item => item.alias === 'alpha')
  check('password is not written in plaintext', !read().includes('hunter2'))
  check('entry auth carries no secret field', alpha.auth.password === undefined && alpha.auth.kind === 'password', JSON.stringify(alpha.auth))
  check('ciphertext is stored under the plugin-owned section', isEncrypted(parsed().secrets?.alpha?.password))
  check('secretFor decrypts back to the original value', store.secretFor('alpha')?.password === 'hunter2', JSON.stringify(store.secretFor('alpha')))
  check('the key file exists once a secret is stored', existsSync(keyPath()))

  // -- key file ------------------------------------------------------------
  const rawKey = Buffer.from(readFileSync(keyPath(), 'utf8').trim(), 'base64')
  check('key file holds a 32-byte key', rawKey.length === 32, `length=${rawKey.length}`)
  if (process.platform !== 'win32') {
    check('key file is owner-only (0600)', (statSync(keyPath()).mode & 0o777) === 0o600, `mode=${(statSync(keyPath()).mode & 0o777).toString(8)}`)
  }

  // -- blank field keeps the stored secret ---------------------------------
  store.update('alpha', entry('alpha', { kind: 'password', password: '' }))
  check('a blank password keeps the stored secret', store.secretFor('alpha')?.password === 'hunter2')
  store.update('alpha', entry('alpha', { kind: 'password', password: 'hunter3' }))
  check('a new password replaces the stored secret', store.secretFor('alpha')?.password === 'hunter3')
  check('the replaced value is never written in plaintext', !read().includes('hunter3'))

  // -- create without a password is still rejected -------------------------
  let refused = false
  try {
    store.create(entry('nopass', { kind: 'password', password: '' }))
  } catch (error) {
    refused = /a password is required/u.test(String(error.message))
  }
  check('password auth without a password is rejected', refused)

  // -- non-password auth stores no secret ----------------------------------
  store.create(entry('gamma', { kind: 'agent' }))
  check('agent auth stores no secret entry', parsed().secrets?.gamma === undefined)
  check('secretFor is undefined without a secret', store.secretFor('gamma') === undefined)

  // -- rename moves the secret, delete drops it ----------------------------
  store.update('alpha', entry('beta', { kind: 'password', password: '' }))
  check('rename moves the secret to the new alias', parsed().secrets?.alpha === undefined && store.secretFor('beta')?.password === 'hunter3')
  store.delete('beta')
  check('delete drops the stored secret', parsed().secrets?.beta === undefined && parsed().hosts.every(item => item.alias !== 'beta'))

  // -- the engine-facing descriptor gets the decrypted value ---------------
  const hosts = new HostStore(sshConfig, store)
  store.create(entry('delta', { kind: 'password', password: 'open-sesame' }))
  check('resolve hands the decrypted password to the engine', hosts.resolve('delta').auth.password === 'open-sesame')

  // -- startup migration of legacy plaintext -------------------------------
  const legacy = {
    version: 1,
    hosts: [
      { alias: 'legacy', host: 'legacy.example.com', port: 22, user: 'root', auth: { kind: 'password', password: 'old-pass' } },
      { alias: 'legacykey', host: 'legacykey.example.com', port: 22, user: 'root', auth: { kind: 'key', keyPath: '/tmp/id_ed25519', passphrase: 'old-phrase' } },
      { alias: 'plain', host: 'plain.example.com', port: 22, user: 'root', auth: { kind: 'agent' } },
    ],
    knownHosts: { legacy: { fingerprint: 'SHA256:x' } },
  }
  writeFileSync(storeFile, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
  const legacyStore = new HostConfigStore(storeFile)
  const migrated = legacyStore.encryptStoredSecrets()
  check('migration reports both hosts', migrated === 2, `migrated=${migrated}`)
  check('migration leaves no plaintext behind', !read().includes('old-pass') && !read().includes('old-phrase'))
  check('migration preserves the decrypted secrets', legacyStore.secretFor('legacy')?.password === 'old-pass' && legacyStore.secretFor('legacykey')?.passphrase === 'old-phrase')
  check('migration drops the secret from the entry', parsed().hosts.find(item => item.alias === 'legacy').auth.password === undefined)
  check('migration keeps the unknown sections', parsed().knownHosts?.legacy?.fingerprint === 'SHA256:x')
  const stamp = statSync(storeFile).mtimeMs
  check('a second migration is a no-op', legacyStore.encryptStoredSecrets() === 0 && statSync(storeFile).mtimeMs === stamp)

  // -- a different key cannot open the store -------------------------------
  const otherKey = path.join(home, 'other.key')
  writeFileSync(otherKey, `${Buffer.alloc(32, 7).toString('base64')}\n`, 'utf8')
  const foreign = new HostConfigStore(storeFile, new SecretCodec({ path: otherKey }))
  let foreignError
  try {
    foreign.secretFor('legacy')
  } catch (error) {
    foreignError = String(error.message)
  }
  check('a foreign key fails loudly', typeof foreignError === 'string' && /cannot read the stored secret for host/u.test(foreignError), foreignError)

  // -- a plaintext secret from ~/.ssh/config still resolves ----------------
  writeFileSync(sshConfig, 'Host fromconfig\n  HostName 10.0.0.9\n  User deploy\n  Password mine\n', 'utf8')
  check('ssh-config plaintext keeps working', new HostStore(sshConfig, store).resolve('fromconfig').auth.password === 'mine')
  check('ssh-config is never rewritten as ciphertext', readFileSync(sshConfig, 'utf8').includes('Password mine'))
  check('the key file is only created on demand', existsSync(keyPath()))
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n=== ${failures === 0 ? 'all checks passed' : `${failures} failed`} ===`)
process.exit(failures === 0 ? 0 : 1)