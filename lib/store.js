/**
 * Durable, editable host store.
 *
 * The format is the shared `$DSH_HOME/dsh-ssh.json` host list
 * (`{ version: 1, hosts: [...] }`), so DSH's SSH tooling can share one host
 * list instead of asking the user to configure the same machine twice.
 * Entries keep the `SshHostEntry` shape and unknown fields survive a
 * rewrite — the file is shared, not owned by this plugin. This plugin adds two
 * own sections to the same document: `knownHosts`, the trust-on-first-use
 * record of server host keys it has seen per alias, `secrets`, the
 * per-alias password / key passphrase, `forwards`, the saved local→remote
 * port mappings plus their on/off intent (see forward-persist.js), and
 * `workspaces`, the remote workspaces the user detached (see unmount-modes).
 *
 * Secrets are never written in plaintext. They are encrypted with AES-256-GCM
 * (see ./secrets.js) under a random key kept in `$DSH_HOME/dsh-ssh.key`, stored
 * in the `secrets` section, decrypted only to configure a connection, and never
 * sent back to the browser. Writes keep the file owner-only (0600, directory
 * 0700) on POSIX systems; on Windows the mode is inert but harmless.
 *
 * @module @shiqyka/dsh-ssh-workspace/store
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SecretCodec } from './secrets.js'

/** Absolute path of the shared host store. */
function storePath () {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, 'dsh-ssh.json')
}

/**
 * A store failure that carries WHY it failed, not just what to say.
 *
 * The routes have to answer with an HTTP status, and the status depends on
 * whether the caller can fix the request (a bad alias, a missing password:
 * 4xx) or whether the store itself is unusable (an unparsable file, an
 * unreadable secret: 5xx). Message text is for the user and must stay free to
 * change; the code is what the caller branches on.
 *
 * @param {string} message - the user-facing explanation.
 * @param {string} code - one of STORE_INVALID / STORE_CONFLICT / STORE_UNREADABLE.
 * @returns {Error} the error to throw.
 */
function storeError (message, code) {
  return Object.assign(new Error(message), { code })
}

/** The request asked for something the store cannot express. */
const STORE_INVALID = 'STORE_INVALID'
/** The request collides with what is already stored. */
const STORE_CONFLICT = 'STORE_CONFLICT'
/** The stored document itself cannot be used. */
const STORE_UNREADABLE = 'STORE_UNREADABLE'

/**
 * How long a lock may be held before another process may take it over.
 *
 * A writer only ever holds the lock for one re-read plus one write, so a lock
 * older than this belongs to a process that died mid-write (or a machine that
 * lost power) rather than to a live writer. Without the takeover a crash would
 * wedge every later save.
 */
const LOCK_STALE_MS = 10_000

/** How long to wait for a busy lock before falling back to an unlocked write. */
const LOCK_WAIT_MS = 2_000

/** Sleep helper for the lock retry loop. */
function sleepSync (ms) {
  // Atomics.wait blocks without spinning the CPU and without an async API, so
  // the store's writer stays synchronous like the rest of this module.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `write` while holding an exclusive cross-process lock on `path`.
 *
 * Two DSH instances editing the same `$DSH_HOME/dsh-ssh.json` would otherwise
 * race: each does read-modify-write, and the later rename silently discards the
 * other's section. `open(..., 'wx')` is the one primitive that is atomic across
 * processes on both POSIX and Windows, so the lock is a sibling file created
 * that way.
 *
 * Every failure path degrades to running `write` anyway. Refusing to save a
 * host because a lock file could not be created would turn a rare interleaving
 * into a guaranteed outage, and the write itself is still atomic (staging file
 * + rename), so the unlocked fallback is exactly the previous behaviour.
 *
 * @param {string} path - the store path the lock protects.
 * @param {() => void} write - the critical section.
 * @returns {void}
 */
function withFileLock (path, write) {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  let fd
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // The directory may be unwritable, or the name may be taken by
        // something that is not a lock file at all; neither is worth failing a
        // save over.
        write()
        return
      }
      // A lock left behind by a dead writer must not block forever.
      let stale = false
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
      } catch { /* vanished between open and stat: retry immediately */ }
      if (stale) {
        try { unlinkSync(lockPath) } catch { /* another writer won the race */ }
        continue
      }
      if (Date.now() >= deadline) {
        write()
        return
      }
      sleepSync(25)
    }
  }
  try {
    write()
  } finally {
    try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(lockPath) } catch { /* already removed */ }
  }
}

/** Aliases travel through paths and shells; keep them boring. */
const ALIAS_PATTERN = /^[^\s/\\*?"]+$/u

/**
 * Validate one alias.
 *
 * @param {unknown} alias - candidate alias.
 * @returns {string | undefined} the problem, or undefined when valid.
 */
function validateAlias (alias) {
  if (typeof alias !== 'string' || alias === '') return 'alias is required'
  if (alias.length > 64) return 'alias must be at most 64 characters'
  if (alias.startsWith('-')) return 'alias must not start with "-"'
  if (!ALIAS_PATTERN.test(alias)) return 'alias must not contain whitespace, slashes, quotes, or wildcards'
  return undefined
}

/**
 * Validate a complete store entry (after normalization).
 *
 * @param {object} entry - the candidate entry.
 * @returns {string[]} human-readable problems; empty when valid.
 */
function validateHostEntry (entry) {
  const problems = []
  const aliasError = validateAlias(entry?.alias)
  if (aliasError !== undefined) problems.push(aliasError)
  if (typeof entry?.host !== 'string' || entry.host.trim() === '') problems.push('host is required')
  if (!Number.isInteger(entry?.port) || entry.port < 1 || entry.port > 65535) problems.push('port must be an integer between 1 and 65535')
  if (typeof entry?.user !== 'string' || entry.user.trim() === '') problems.push('user is required')
  const auth = entry?.auth
  if (auth?.kind === 'key') {
    if (!isNonEmptyString(auth.keyPath)) problems.push('a private key path is required for key auth')
  } else if (auth?.kind !== 'password' && auth?.kind !== 'agent') {
    // Password auth carries no secret on the entry any more, so its presence is
    // checked where the secret is resolved (see requiredSecret).
    problems.push('auth kind must be one of key, password, agent')
  }
  for (const flag of ['agentForward', 'compress']) {
    if (entry?.[flag] !== undefined && typeof entry[flag] !== 'boolean') problems.push(`${flag} must be a boolean when present`)
  }
  return problems
}

/** True when the value is a string with content. */
function isNonEmptyString (value) {
  return typeof value === 'string' && value !== ''
}

/**
 * Normalize an auth patch into the stored shape.
 *
 * The shape is deliberately secret-free: `password` and `passphrase` live
 * encrypted in the document's `secrets` section, so an entry only records
 * *which* method a host uses and its non-secret inputs.
 *
 * @param {object | undefined} auth - editor-supplied auth record.
 * @returns {{kind: string, keyPath?: string, agentPath?: string}} stored auth.
 */
function normalizeAuthForStore (auth) {
  if (auth?.kind === 'key') return { kind: 'key', keyPath: String(auth.keyPath ?? '').trim() }
  if (auth?.kind === 'password') return { kind: 'password' }
  const normalized = { kind: 'agent' }
  if (isNonEmptyString(auth?.agentPath)) normalized.agentPath = auth.agentPath.trim()
  return normalized
}

/**
 * Resolve the secret one auth patch must store.
 *
 * A blank field means "keep what is already stored": the browser never
 * receives secrets back, so an untouched field always posts empty. Switching
 * to password auth cannot carry a secret across, so the new password is
 * required up front.
 *
 * @param {object | undefined} auth - editor-supplied auth record.
 * @param {{password?: string, passphrase?: string} | undefined} current - the stored secret.
 * @returns {{password?: string, passphrase?: string}} the secret to store (empty for agent auth).
 * @throws {Error} when password auth ends up without a password.
 */
function requiredSecret (auth, current) {
  if (auth?.kind === 'password') {
    const password = isNonEmptyString(auth.password) ? auth.password : current?.password
    if (!isNonEmptyString(password)) throw storeError('a password is required for password auth', STORE_INVALID)
    return { password }
  }
  if (auth?.kind === 'key') {
    const passphrase = isNonEmptyString(auth.passphrase) ? auth.passphrase : current?.passphrase
    return isNonEmptyString(passphrase) ? { passphrase } : {}
  }
  return {}
}

/** Build a fresh store entry from an editor payload. */
function buildEntry (payload) {
  const now = Date.now()
  const entry = {
    alias: String(payload?.alias ?? '').trim(),
    host: String(payload?.host ?? '').trim(),
    port: Number.isInteger(payload?.port) ? payload.port : 22,
    user: String(payload?.user ?? '').trim(),
    auth: normalizeAuthForStore(payload?.auth),
    proxyJump: [],
    tags: Array.isArray(payload?.tags) ? payload.tags.filter(tag => typeof tag === 'string') : [],
    createdAt: now,
    updatedAt: now,
  }
  const description = typeof payload?.description === 'string' ? payload.description.trim() : ''
  if (description !== '') entry.description = description
  // Transport options are opt-in: absent means the ssh2 default, so an entry
  // that never set them stays byte-identical to one written by an older version.
  if (payload?.agentForward === true) entry.agentForward = true
  if (payload?.compress === true) entry.compress = true
  return entry
}

/**
 * Merge an auth patch onto a stored auth record.
 *
 * Only the secret-free shape is merged here; the secret half is resolved
 * separately by {@link requiredSecret}, because it no longer lives on the
 * entry. A blank agent path is meaningful (use the default agent), so it clears.
 */
function mergeAuth (currentAuth, patch) {
  const kind = patch?.kind
  if (kind !== currentAuth?.kind) {
    if (kind === 'key' && !isNonEmptyString(patch.keyPath)) throw storeError('switching to key auth requires a key path', STORE_INVALID)
    return normalizeAuthForStore(patch)
  }
  if (kind === 'password') return { kind: 'password' }
  return normalizeAuthForStore(patch)
}

/** Merge an editor patch onto an existing entry, preserving unknown fields. */
function mergeEntry (current, patch) {
  const merged = { ...current }
  if (patch?.alias !== undefined) merged.alias = String(patch.alias).trim()
  if (patch?.host !== undefined) merged.host = String(patch.host).trim()
  if (Number.isInteger(patch?.port)) merged.port = patch.port
  if (patch?.user !== undefined) merged.user = String(patch.user).trim()
  if (patch?.auth !== undefined) merged.auth = mergeAuth(current.auth, patch.auth)
  if (patch?.description !== undefined) {
    const description = String(patch.description).trim()
    if (description === '') delete merged.description
    else merged.description = description
  }
  // The editor always posts a boolean, so an unchecked box clears the flag
  // rather than leaving the previous value behind.
  for (const flag of ['agentForward', 'compress']) {
    if (typeof patch?.[flag] === 'boolean') {
      if (patch[flag]) merged[flag] = true
      else delete merged[flag]
    }
  }
  return merged
}

/**
 * The `hosts` array of a document, filtered to usable entries.
 *
 * @param {object} document - the parsed store document.
 * @returns {Array<object>} stored host entries.
 */
function hostEntriesOf (document) {
  const hosts = document?.hosts
  if (!Array.isArray(hosts)) return []
  return hosts.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.alias === 'string' && entry.alias !== '')
}

/**
 * The `secrets` section of a document, as a plain object copy.
 *
 * @param {object} document - the parsed store document.
 * @returns {Record<string, object>} per-alias encrypted secrets.
 */
function secretsOf (document) {
  const section = document?.secrets
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return {}
  return { ...section }
}

/**
 * The `knownHosts` section of a document, as a plain object copy.
 *
 * @param {object} document - the parsed store document.
 * @returns {Record<string, object>} per-alias host-key records.
 */
function knownHostsOf (document) {
  const section = document?.knownHosts
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return {}
  return { ...section }
}

/** A port number a forward may name; 0 is not storable (it is a request, not a fact). */
function isStoredPort (value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * Normalize one stored forward entry, or `undefined` when it is unusable.
 *
 * A saved mapping names a concrete local port: persisting "whatever the OS gave
 * me" would make the saved URL wrong on the next start, so an entry without a
 * fixed local port is dropped rather than silently drifting.
 *
 * @param {unknown} candidate - the raw stored record.
 * @returns {object | undefined} the normalized entry.
 */
function normalizeForwardEntry (candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const alias = typeof candidate.alias === 'string' ? candidate.alias.trim() : ''
  if (id === '' || alias === '') return undefined
  if (!isStoredPort(candidate.remotePort) || !isStoredPort(candidate.localPort)) return undefined
  return {
    id,
    alias,
    remoteHost: typeof candidate.remoteHost === 'string' && candidate.remoteHost !== '' ? candidate.remoteHost : '127.0.0.1',
    remotePort: candidate.remotePort,
    localHost: typeof candidate.localHost === 'string' && candidate.localHost !== '' ? candidate.localHost : '127.0.0.1',
    localPort: candidate.localPort,
    enabled: candidate.enabled !== false,
    ...(Number.isFinite(candidate.createdAt) ? { createdAt: candidate.createdAt } : {}),
  }
}

/**
 * The `forwards` section of a document, normalized.
 *
 * Shape: `{ settings: { autoStart: boolean }, items: entry[] }`. Anything this
 * module cannot read degrades to the default empty section rather than throwing
 * — a damaged forward list must not make the host store unreadable.
 *
 * @param {object} document - the parsed store document.
 * @returns {{settings: {autoStart: boolean}, items: object[]}} the section.
 */
export function forwardsOf (document) {
  const section = document?.forwards
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return { settings: { autoStart: false }, items: [] }
  }
  const settings = section.settings !== null && typeof section.settings === 'object' && !Array.isArray(section.settings)
    ? section.settings
    : {}
  const items = Array.isArray(section.items)
    ? section.items.map(normalizeForwardEntry).filter(entry => entry !== undefined)
    : []
  return {
    settings: { autoStart: settings.autoStart === true },
    items,
  }
}

/**
 * Normalize one `ssh://` workspace path for the disabled list, or `undefined`
 * when it is not a remote workspace spelling.
 *
 * Only `ssh://` paths are accepted: this section exists to record remote
 * workspaces the user detached, and a local path here would be meaningless —
 * the plugin never mounts those.
 *
 * @param {unknown} candidate - the raw stored path.
 * @returns {string | undefined} the trimmed path.
 */
function normalizeDisabledPath (candidate) {
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  if (!trimmed.startsWith('ssh://') || trimmed.length <= 'ssh://'.length) return undefined
  return trimmed
}

/**
 * The `workspaces` section of a document, normalized.
 *
 * Shape: `{ disabled: string[] }` — the remote workspaces the user unloaded
 * while keeping their registration. Anything this module cannot read degrades
 * to the empty section: a damaged list must not make the host store
 * unreadable, and the safe answer to "was this disabled?" is "no", which only
 * costs a re-mount of a workspace the plugin had already mounted before.
 *
 * @param {object} document - the parsed store document.
 * @returns {{disabled: string[]}} the section.
 */
export function workspacesOf (document) {
  const section = document?.workspaces
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return { disabled: [] }
  const listed = Array.isArray(section.disabled) ? section.disabled : []
  const disabled = []
  const seen = new Set()
  for (const entry of listed) {
    const path = normalizeDisabledPath(entry)
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    disabled.push(path)
  }
  return { disabled }
}

/**
 * The editable host store behind `$DSH_HOME/dsh-ssh.json`.
 */
export class HostConfigStore {
  /**
   * @param {string} [path] - store file path override (tests).
   * @param {SecretCodec} [codec] - secret codec override (tests).
   */
  constructor (path, codec) {
    this.path = path ?? storePath()
    this.codec = codec ?? new SecretCodec()
  }

  /**
   * Every stored entry, in file order.
   *
   * @returns {Array<object>} store entries.
   * @throws {Error} when the file exists but cannot be read as a document.
   */
  load () {
    const document = this.#readDocument()
    const hosts = Array.isArray(document.hosts) ? document.hosts : []
    return hosts.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.alias === 'string' && entry.alias !== '')
  }

  /**
   * Find one entry by alias.
   *
   * @param {string} alias - host alias.
   * @returns {object | undefined} the entry, when stored.
   */
  find (alias) {
    return this.load().find(entry => entry.alias === alias)
  }

  /**
   * Create one entry.
   *
   * @param {object} payload - editor payload.
   * @returns {object} the stored entry.
   * @throws {Error} on validation failure or an alias collision.
   */
  create (payload) {
    const entry = buildEntry(payload)
    const problems = validateHostEntry(entry)
    if (problems.length > 0) throw storeError(problems.join('; '), STORE_INVALID)
    const secret = requiredSecret(payload?.auth, undefined)
    // The collision check and the append both run against the document as it
    // is under the lock, so a concurrent create in another process cannot be
    // overwritten by this one.
    this.#withDocumentLock((existing) => {
      const entries = hostEntriesOf(existing)
      if (entries.some(current => current.alias === entry.alias)) {
        throw storeError(`host ${JSON.stringify(payload?.alias)} already exists in the store`, STORE_CONFLICT)
      }
      return {
        hosts: [...entries, entry],
        secrets: this.#withSecret(secretsOf(existing), entry.alias, secret),
      }
    })
    return entry
  }

  /**
   * Update one entry.
   *
   * @param {string} alias - the current alias of the entry.
   * @param {object} patch - editor payload (complete form state).
   * @returns {object} the stored entry.
   * @throws {Error} when the entry is missing or the result is invalid.
   */
  update (alias, patch) {
    // Validated up front so a bad form fails before the lock is taken; the
    // list it is checked against is re-read under the lock below.
    const preview = this.load()
    const previewIndex = preview.findIndex(entry => entry.alias === alias)
    if (previewIndex === -1) {
      throw storeError(`host ${JSON.stringify(alias)} is not in the editable store (it may come from ~/.ssh/config)`, STORE_INVALID)
    }
    const merged = mergeEntry(preview[previewIndex], patch)
    const problems = validateHostEntry(merged)
    if (problems.length > 0) throw storeError(problems.join('; '), STORE_INVALID)
    const updated = { ...merged, updatedAt: Date.now() }
    const secret = patch?.auth === undefined
      ? (this.secretFor(alias) ?? {})
      : requiredSecret(patch.auth, this.secretFor(alias))

    this.#withDocumentLock((existing) => {
      const entries = hostEntriesOf(existing)
      const index = entries.findIndex(entry => entry.alias === alias)
      if (index === -1) {
        throw storeError(`host ${JSON.stringify(alias)} is no longer in the editable store`, STORE_CONFLICT)
      }
      if (merged.alias !== alias && entries.some((entry, i) => i !== index && entry.alias === merged.alias)) {
        throw storeError(`alias ${JSON.stringify(merged.alias)} is already taken`, STORE_CONFLICT)
      }
      const next = entries.slice()
      next[index] = updated
      // A blank secret field keeps what is stored; a rename moves the secret
      // with the entry so the old alias does not keep a copy behind.
      const section = secretsOf(existing)
      if (merged.alias !== alias) delete section[alias]
      return { hosts: next, secrets: this.#withSecret(section, merged.alias, secret) }
    })
    return updated
  }

  /**
   * Remove one entry.
   *
   * @param {string} alias - host alias.
   * @returns {boolean} true when an entry was removed.
   * @throws {Error} when the alias is not stored.
   */
  delete (alias) {
    this.#withDocumentLock((existing) => {
      const entries = hostEntriesOf(existing)
      const next = entries.filter(entry => entry.alias !== alias)
      if (next.length === entries.length) {
        throw storeError(`host ${JSON.stringify(alias)} is not in the editable store`, STORE_INVALID)
      }
      const secrets = secretsOf(existing)
      delete secrets[alias]
      return { hosts: next, secrets }
    })
    return true
  }

  /**
   * The decrypted secret stored for one alias, when there is one.
   *
   * @param {string} alias - host alias.
   * @returns {{password?: string, passphrase?: string} | undefined} the plaintext secret.
   * @throws {Error} when the stored value cannot be decrypted with the current key.
   */
  secretFor (alias) {
    const raw = this.#secretsSection()[alias]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const codec = this.codec
    /** @type {{password?: string, passphrase?: string}} */
    const secret = {}
    try {
      if (isNonEmptyString(raw.password)) secret.password = codec.decrypt(raw.password)
      if (isNonEmptyString(raw.passphrase)) secret.passphrase = codec.decrypt(raw.passphrase)
    } catch (error) {
      throw storeError(`cannot read the stored secret for host ${JSON.stringify(alias)}: ${error instanceof Error ? error.message : String(error)}`, STORE_UNREADABLE)
    }
    return Object.keys(secret).length > 0 ? secret : undefined
  }

  /**
   * Encrypt every secret still stored as plaintext on an entry (the format
   * before this module grew a codec) and move it into the `secrets` section.
   *
   * Runs once at startup, best-effort: a file this plugin cannot understand is
   * left alone rather than clobbered.
   *
   * @returns {number} how many hosts were migrated.
   */
  encryptStoredSecrets () {
    let migrated = 0
    this.#withDocumentLock((existing) => {
      const entries = hostEntriesOf(existing)
      const secrets = secretsOf(existing)
      const next = entries.map(entry => {
        const auth = entry.auth
        if (auth === null || typeof auth !== 'object') return entry
        const password = isNonEmptyString(auth.password) ? auth.password : undefined
        const passphrase = isNonEmptyString(auth.passphrase) ? auth.passphrase : undefined
        if (password === undefined && passphrase === undefined) return entry
        const secret = { ...(secrets[entry.alias] ?? {}) }
        if (password !== undefined) secret.password = password
        if (passphrase !== undefined) secret.passphrase = passphrase
        secrets[entry.alias] = secret
        migrated += 1
        return { ...entry, auth: normalizeAuthForStore(auth) }
      })
      // Nothing to migrate: skip the write so an already-migrated store keeps
      // its mtime and is not rewritten on every startup.
      if (migrated === 0) return undefined
      return { hosts: next, secrets: this.#encryptSection(secrets) }
    })
    return migrated
  }

  /**
   * Write the whole file atomically (staging file + rename).
   *
   * Replaces the host list with `entries`. The write itself is locked and
   * atomic, but the LIST comes from the caller: a caller that built it from an
   * earlier {@link load} can still overwrite a concurrent writer's entries,
   * because its read happened outside any lock. Use {@link mutateHosts} when
   * the intent is "add/change mine without disturbing theirs".
   *
   * @param {Array<object>} entries - the complete entry list.
   * @returns {void}
   */
  save (entries) {
    this.#writeDocument({ hosts: entries })
  }

  /**
   * Read, transform and write the host list inside one locked critical section.
   *
   * This is the cross-process-safe way to edit hosts: the snapshot handed to
   * `transform` is the one the lock protects, so two DSH instances adding a
   * host concurrently both survive. {@link save} cannot offer that, because its
   * `entries` argument was read before the lock was taken.
   *
   * @param {(entries: Array<object>) => Array<object>} transform - receives the current list, returns the next one.
   * @returns {Array<object>} the list that was written.
   */
  mutateHosts (transform) {
    let written = []
    this.#withDocumentLock((existing) => {
      const current = Array.isArray(existing.hosts) ? existing.hosts : []
      const next = transform(current.map(entry => ({ ...entry })))
      if (!Array.isArray(next)) throw new Error('mutateHosts: the transform must return an array')
      written = next
      return { hosts: next }
    })
    return written
  }

  /**
   * The stored host-key record for one alias, when one was recorded.
   *
   * @param {string} alias - host alias.
   * @returns {{host?: string, port?: number, keyType: string, fingerprint: string, recordedAt?: number} | undefined} the record.
   */
  knownHostKey (alias) {
    const record = this.#knownHostsSection()[alias]
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
    if (typeof record.fingerprint !== 'string' || record.fingerprint === '') return undefined
    return {
      ...(typeof record.host === 'string' && record.host !== '' ? { host: record.host } : {}),
      ...(Number.isInteger(record.port) ? { port: record.port } : {}),
      keyType: typeof record.keyType === 'string' && record.keyType !== '' ? record.keyType : 'unknown',
      fingerprint: record.fingerprint,
      ...(Number.isFinite(record.recordedAt) ? { recordedAt: record.recordedAt } : {}),
    }
  }

  /**
   * Record the host key observed on a first connection (TOFU).
   *
   * @param {string} alias - host alias.
   * @param {{host?: string, port?: number, keyType: string, fingerprint: string}} record - the presented key.
   * @returns {void}
   */
  rememberHostKey (alias, record) {
    const entry = {
      ...(typeof record?.host === 'string' && record.host !== '' ? { host: record.host } : {}),
      ...(Number.isInteger(record?.port) ? { port: record.port } : {}),
      keyType: typeof record?.keyType === 'string' && record.keyType !== '' ? record.keyType : 'unknown',
      fingerprint: String(record?.fingerprint ?? ''),
      recordedAt: Date.now(),
    }
    this.#withDocumentLock((existing) => {
      const section = knownHostsOf(existing)
      section[alias] = entry
      return { knownHosts: section }
    })
  }

  /**
   * Drop the recorded host key for one alias; the next connection re-records
   * (and thereby re-trusts) whatever the server presents.
   *
   * @param {string} alias - host alias.
   * @returns {boolean} whether a record was removed.
   */
  forgetHostKey (alias) {
    let removed = false
    this.#withDocumentLock((existing) => {
      const section = knownHostsOf(existing)
      if (section[alias] === undefined) return undefined
      delete section[alias]
      removed = true
      return { knownHosts: section }
    })
    return removed
  }

  /**
   * The saved port-forward section.
   *
   * Read failures degrade to the empty section: a store this plugin cannot
   * parse must not take the whole panel down with it, and the caller only ever
   * uses this to repopulate the UI.
   *
   * @returns {{settings: {autoStart: boolean}, items: object[]}} the section.
   */
  forwards () {
    try {
      return forwardsOf(this.#readDocument())
    } catch {
      return { settings: { autoStart: false }, items: [] }
    }
  }

  /**
   * Insert or replace one saved forward inside the locked critical section.
   *
   * Matching is by `id`, so a caller that edits a mapping's ports updates the
   * record it means instead of appending a duplicate.
   *
   * @param {object} entry - the entry to store (validated by the caller).
   * @returns {object[]} the list that was written.
   */
  putForward (entry) {
    const normalized = normalizeForwardEntry(entry)
    if (normalized === undefined) throw storeError('putForward: id, alias, localPort and remotePort are required', STORE_INVALID)
    const record = { ...normalized, createdAt: normalized.createdAt ?? Date.now() }
    let written = []
    this.#withDocumentLock((existing) => {
      const section = forwardsOf(existing)
      const index = section.items.findIndex(item => item.id === record.id)
      const items = section.items.slice()
      if (index === -1) items.push(record)
      else items[index] = { ...items[index], ...record }
      written = items
      return { forwards: { settings: section.settings, items } }
    })
    return written
  }

  /**
   * Remove one saved forward.
   *
   * @param {string} id - the forward id.
   * @returns {boolean} whether a record was removed.
   */
  deleteForward (id) {
    let removed = false
    this.#withDocumentLock((existing) => {
      const section = forwardsOf(existing)
      const items = section.items.filter(item => item.id !== id)
      if (items.length === section.items.length) return undefined
      removed = true
      return { forwards: { settings: section.settings, items } }
    })
    return removed
  }

  /**
   * Change the saved on/off intent of one forward.
   *
   * The intent is what the user asked for; whether a listener is actually
   * bound right now is runtime state owned by the ForwardManager. Keeping them
   * apart is what lets the panel show "open" only when a tunnel really exists.
   *
   * @param {string} id - the forward id.
   * @param {boolean} enabled - the intended state.
   * @returns {boolean} whether the entry existed.
   */
  setForwardEnabled (id, enabled) {
    let found = false
    this.#withDocumentLock((existing) => {
      const section = forwardsOf(existing)
      const index = section.items.findIndex(item => item.id === id)
      if (index === -1) return undefined
      found = true
      const items = section.items.slice()
      items[index] = { ...items[index], enabled: enabled === true }
      return { forwards: { settings: section.settings, items } }
    })
    return found
  }

  /**
   * Set the auto-start-tunnels preference.
   *
   * @param {boolean} autoStart - whether enabled forwards open on startup.
   * @returns {boolean} the stored value.
   */
  setForwardAutoStart (autoStart) {
    const value = autoStart === true
    this.#withDocumentLock((existing) => {
      const section = forwardsOf(existing)
      return { forwards: { settings: { ...section.settings, autoStart: value }, items: section.items } }
    })
    return value
  }

  /**
   * The `workspaces` section: which remote workspaces the user detached.
   *
   * Read failures degrade to the empty section. A store this plugin cannot
   * parse must not take the whole panel down with it, and "nothing is
   * disabled" is the safe fallback: the worst case is re-mounting a workspace
   * the user had unloaded, never losing access to one.
   *
   * @returns {{disabled: string[]}} the section.
   */
  workspaces () {
    try {
      return workspacesOf(this.#readDocument())
    } catch {
      return { disabled: [] }
    }
  }

  /**
   * Whether one workspace path is recorded as detached.
   *
   * @param {string} workspacePath - the `ssh://` path to look up.
   * @returns {boolean} whether the path is in the disabled list.
   */
  isWorkspaceDisabled (workspacePath) {
    const target = normalizeDisabledPath(workspacePath)
    if (target === undefined) return false
    return this.workspaces().disabled.includes(target)
  }

  /**
   * Add one workspace path to the disabled list.
   *
   * Idempotent and append-only, so a double click cannot record the same
   * workspace twice. The whole read-modify-write runs under the shared file
   * lock, so two DSH instances cannot discard each other's section.
   *
   * @param {string} workspacePath - the `ssh://` path to disable.
   * @returns {string[]} the list that was written.
   */
  disableWorkspace (workspacePath) {
    const target = normalizeDisabledPath(workspacePath)
    if (target === undefined) throw new Error(`disableWorkspace: not a remote workspace path: ${JSON.stringify(workspacePath)}`)
    let written = []
    this.#withDocumentLock((existing) => {
      const section = workspacesOf(existing)
      const disabled = section.disabled.includes(target) ? section.disabled : [...section.disabled, target]
      written = disabled
      if (disabled === section.disabled) return undefined
      return { workspaces: { disabled } }
    })
    if (written.length === 0) written = [...this.workspaces().disabled]
    return written
  }

  /**
   * Remove one workspace path from the disabled list.
   *
   * @param {string} workspacePath - the `ssh://` path to re-enable.
   * @returns {boolean} whether an entry was removed.
   */
  enableWorkspace (workspacePath) {
    const target = normalizeDisabledPath(workspacePath)
    if (target === undefined) return false
    let removed = false
    this.#withDocumentLock((existing) => {
      const section = workspacesOf(existing)
      const disabled = section.disabled.filter(entry => entry !== target)
      if (disabled.length === section.disabled.length) return undefined
      removed = true
      return { workspaces: { disabled } }
    })
    return removed
  }

  /**
   * Write the document atomically (staging file + rename), merging one patch
   * onto whatever the file currently holds so sections this plugin does not
   * own survive every rewrite.
   *
   * The whole read-modify-write runs under {@link withFileLock}, so two DSH
   * instances editing the same file serialize instead of one silently
   * discarding the other's section.
   *
   * @param {object} patch - top-level fields to merge in.
   * @returns {void}
   */
  #writeDocument (patch) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    // The re-read has to happen INSIDE the lock: merging onto a document read
    // before another process's write would discard that write even though the
    // rename itself is atomic.
    withFileLock(this.path, () => { this.#commit(patch) })
  }

  /**
   * Run a patch builder against the document as it exists under the lock.
   *
   * The builder receives the freshly read document and returns the patch to
   * merge onto it, which is what makes a caller's read-modify-write atomic
   * across processes rather than merely serialized at the rename. Returning
   * `undefined` skips the write entirely, so a caller with nothing to change
   * does not touch the file (and does not bump its mtime).
   *
   * @param {(existing: object) => object | undefined} buildPatch - maps the locked document to a patch, or undefined to skip.
   * @returns {void}
   */
  #withDocumentLock (buildPatch) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    withFileLock(this.path, () => {
      const patch = buildPatch(this.#readDocument())
      if (patch === undefined) return
      this.#commit(patch)
    })
  }

  /**
   * Merge one patch onto the on-disk document and replace it atomically.
   *
   * Callers own any locking; this only performs the staging-file write and the
   * rename that publishes it.
   *
   * @param {object} patch - top-level fields to merge in.
   * @returns {void}
   */
  #commit (patch) {
    const existing = this.#readDocument()
    const document = { ...existing, version: existing.version ?? 1, ...patch }
    // The staging name is random so a pre-created file or link at a guessable
    // name can never be the write target; the mode keeps the store owner-only.
    const tmp = `${this.path}.tmp-${randomBytes(6).toString('hex')}`
    try {
      writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.path)
      // The rename carries the staging mode onto a fresh file; an already
      // existing store keeps whatever mode it had, so tighten it once here.
      // Best-effort: win32 (and some network filesystems) may not honor it.
      try { chmodSync(this.path, 0o600) } catch { /* mode unsupported here */ }
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* never created or already gone */ }
      throw error
    }
  }

  /** The `knownHosts` section of the document, as a mutable copy. */
  #knownHostsSection () {
    const section = knownHostsOf(this.#readDocument())
    return { ...section }
  }

  /** The `secrets` section of the document, as a mutable copy. */
  #secretsSection () {
    const section = secretsOf(this.#readDocument())
    return { ...section }
  }

  /** Return a copy of a secrets section with one alias' plaintext secret set. */
  #withSecret (section, alias, secret) {
    const next = { ...section }
    if (Object.keys(secret).length === 0) delete next[alias]
    else next[alias] = secret
    return this.#encryptSection(next)
  }

  /**
   * Encrypt every plaintext value in a secrets section, leaving ciphertext
   * untouched (so a re-save cannot double-encrypt).
   */
  #encryptSection (section) {
    const next = {}
    for (const [alias, secret] of Object.entries(section)) {
      if (secret === null || typeof secret !== 'object' || Array.isArray(secret)) continue
      const encrypted = {}
      if (isNonEmptyString(secret.password)) encrypted.password = this.codec.encrypt(secret.password)
      if (isNonEmptyString(secret.passphrase)) encrypted.passphrase = this.codec.encrypt(secret.passphrase)
      if (Object.keys(encrypted).length > 0) next[alias] = encrypted
    }
    return next
  }

  /**
   * Read the raw document. A missing or empty file is an empty document; an
   * existing but unreadable one is an error, so a save can never silently
   * clobber content this plugin failed to understand.
   */
  #readDocument () {
    if (!existsSync(this.path)) return {}
    const raw = readFileSync(this.path, 'utf8')
    if (raw.trim() === '') return {}
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      throw storeError(`host store file ${this.path} is not valid JSON; fix or remove it before editing hosts here`, STORE_UNREADABLE)
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw storeError(`host store file ${this.path} does not contain a JSON object; fix or remove it before editing hosts here`, STORE_UNREADABLE)
    }
    return data
  }
}
