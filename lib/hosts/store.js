/**
 * Durable, editable host store.
 *
 * The format is the shared `dsh-ssh.json` host list
 * (`{ version: 1, hosts: [...] }`), so DSH's SSH tooling can share one host
 * list instead of asking the user to configure the same machine twice.
 * Entries keep the `SshHostEntry` shape and unknown fields survive a
 * rewrite — the file is shared, not owned by this plugin. This plugin adds two
 * own sections to the same document: `knownHosts`, the trust-on-first-use
 * record of server host keys it has seen per alias, `secrets`, the
 * per-alias password / key passphrase, `forwards`, the saved local→remote
 * port mappings plus their on/off intent (see forward.js), and
 * `workspaces`, the remote workspaces the user detached (see docs/features.md),
 * `preferences`, the browser panel's own viewing preferences (where a clicked
 * file opens, and whether the composer hides while it is shown there), and
 * `autoConnect`, the aliases the user switched on for boot-time restore.
 *
 * Since 0.4.x the editable store and its key live in a plugin-private
 * subdirectory, `$DSH_HOME/dsh-ssh-workspace/`, alongside the command audit
 * file. Older versions kept them directly under `$DSH_HOME`; the legacy paths
 * remain readable so an existing install never loses its hosts or its key. The
 * first write goes to the new path. See {@link storePath} / {@link keyPath}.
 *
 * Secrets are never written in plaintext. They are encrypted with AES-256-GCM
 * (the bottom half of this file) under a random key kept in
 * `dsh-ssh.key`, stored in the `secrets` section, decrypted only to
 * configure a connection, and never sent back to the browser. Writes keep the file owner-only (0600, directory
 * 0700) on POSIX systems; on Windows the mode is inert but harmless.
 *
 * @module @shiqyka/dsh-ssh-workspace/store
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_PREFERENCES, FILE_VIEW_MODES, preferencesOf } from './preferences.js'
import { AUDIT_CAPACITY, AUDIT_MAX_CAPACITY, AUDIT_MIN_CAPACITY } from '../engine/audit-limits.js'

/**
 * Retention assumed when the store has never been written, or when what it holds
 * is not a number the ring accepts. The ring's own default, for one source.
 */
export const DEFAULT_AUDIT_RETENTION = AUDIT_CAPACITY

// Re-exported so callers keep reaching the preference rules through the store
// (they are one subject), while the rules themselves stay dependency-free for
// the HTTP route and the tests to import without the peer packages.
export { DEFAULT_PREFERENCES, FILE_VIEW_MODES, preferencesOf } from './preferences.js'

/**
 * The DSH home the store and its key file both live under.
 *
 * One resolver, because the two files must agree: a key written beside one
 * `$DSH_HOME` and read beside another is indistinguishable from a lost key, and
 * the error it produces ("does not match the key it was written with") sends the
 * reader looking for a key rotation that never happened.
 *
 */
function dshHome () {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
}

/**
 * The plugin-private subdirectory under `$DSH_HOME`.
 *
 * The editable store, its key and the command audit file all live here so they
 * sit together and stay out of the root `$DSH_HOME` namespace that DSH itself
 * owns. Created on first write; older installs that still keep their files in
 * the root are read through the legacy fallbacks below.
 */
function workspaceDir () {
  return join(dshHome(), 'dsh-ssh-workspace')
}

/**
 * Absolute path the host store is WRITTEN to (the new, private location).
 *
 * Reads also consult {@link legacyStorePath} so an install created by an older
 * version keeps working without a manual file move; the first write migrates
 * the document to this path.
 */
function storePath () {
  return join(workspaceDir(), 'dsh-ssh.json')
}

/** Absolute path the older releases kept the store at (read-only fallback). */
function legacyStorePath () {
  return join(dshHome(), 'dsh-ssh.json')
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
 * @param {{password?: string, passphrase?: string} | undefined} current - the stored secret.
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
    // Tags are a user-visible index, not free text: the panel's search box and
    // the agent tool both match against them, so `['prod ', 'prod']` must not
    // become two entries that show as one label. Trimmed, blank-dropped and
    // de-duplicated here — the save route normalizes too, and this is the half
    // that also covers a store file written by hand.
    tags: Array.isArray(payload?.tags)
      ? [...new Set(payload.tags.filter(tag => typeof tag === 'string').map(tag => tag.trim()).filter(tag => tag !== ''))]
      : [],
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
 */
function hostEntriesOf (document) {
  const hosts = document?.hosts
  if (!Array.isArray(hosts)) return []
  return hosts.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.alias === 'string' && entry.alias !== '')
}

/**
 * The `secrets` section of a document, as a plain object copy.
 *
 */
function secretsOf (document) {
  const section = document?.secrets
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return {}
  return { ...section }
}

/**
 * The `recent` section of a document: alias → last-used timestamp.
 *
 * A SEPARATE section rather than a field on each host entry, for one reason: an
 * ssh-config host has no entry to write to, and "recently used" is the one piece
 * of state that must apply to those too. Writing it onto store entries would
 * have made the feature silently store-only.
 *
 * Kept small on purpose (`MAX_RECENT`), because it grows with use and its only
 * consumer is a sort order.
 *
 * @returns {Record<string, number>} alias → epoch milliseconds.
 */
function recentOf (document) {
  const section = document?.recent
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return {}
  /** @type {Record<string, number>} */
  const out = {}
  for (const [alias, value] of Object.entries(section)) {
    if (alias === '') continue
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[alias] = value
  }
  return out
}

/** How many aliases the `recent` section keeps. */
const MAX_RECENT = 100

/**
 * The `autoConnect` section of a document: the aliases the user switched on.
 *
 * A top-level ARRAY, not a field on each host entry, for the same reason as
 * `recent`: an `~/.ssh/config` host has no editable entry to carry a flag, yet
 * it can be connected and must be restorable too. Kept as plain alias strings —
 * the intent is "keep this host connected", independent of whether the host is
 * store-backed or imported.
 *
 * Anything unreadable degrades to an empty list rather than throwing: a damaged
 * intent section must not make the host store unreadable.
 *
 * @returns {string[]} aliases, deduplicated, in stored order.
 */
function autoConnectHostsOf (document) {
  const section = document?.autoConnect
  if (!Array.isArray(section)) return []
  const out = []
  const seen = new Set()
  for (const candidate of section) {
    if (typeof candidate !== 'string') continue
    const alias = candidate.trim()
    if (alias === '' || seen.has(alias)) continue
    seen.add(alias)
    out.push(alias)
  }
  return out
}

/**
 * The `knownHosts` section of a document, as a plain object copy.
 *
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
 * The `passthrough` section of a document, normalized.
 *
 * Shape: `{ scheme: string, remoteMissFallback: boolean }`. This is the runtime
 * truth for the two local-passthrough settings: the panel writes here, and the
 * plugin reads here on every activation, so a saved choice outlives both a
 * restart and a plugin reload. Plugin configuration is only the FIRST default
 * (used when this section has never been written), which is why `scheme:
 * undefined` is preserved rather than being coerced to a value: the caller has
 * to be able to tell "the user chose local" from "the user never chose".
 *
 * Anything unreadable degrades to the empty section instead of throwing — a
 * damaged settings block must not make the host store (and with it the whole
 * host list) unreadable.
 *
 */
export function passthroughOf (document) {
  const section = document?.passthrough
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return { scheme: undefined, remoteMissFallback: undefined }
  }
  // The scheme is validated where it is USED (`normalizeScheme` in
  // passthrough.js), not here: the store keeps what was saved so a future
  // version that accepts a name this one rejects can still read it back.
  const scheme = typeof section.scheme === 'string' && section.scheme.trim() !== ''
    ? section.scheme.trim()
    : undefined
  return {
    scheme,
    remoteMissFallback: typeof section.remoteMissFallback === 'boolean' ? section.remoteMissFallback : undefined,
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
  constructor (path, codec) {
    // An explicit path (tests, alternate installs) is used verbatim with no
    // legacy fallback. Only the default location migrates from the old root.
    this.path = path ?? storePath()
    this.legacyPath = path === undefined ? legacyStorePath() : undefined
    this.codec = codec ?? new SecretCodec()
  }

  /**
   * Every stored entry, in file order.
   *
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
   * @returns {object | undefined} the entry, when stored.
   */
  find (alias) {
    return this.load().find(entry => entry.alias === alias)
  }

  /**
   * Create one entry.
   *
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
   * The alias → last-used map, newest first is NOT implied: callers sort.
   *
   * @returns {Record<string, number>} alias → epoch milliseconds.
   */
  recentHosts () {
    try {
      // `#readDocument()`, NOT `load()`: `load()` returns the entries ARRAY (it
      // is the host list), so reading the recent section through it silently
      // produced an empty map while the document held a perfectly good one.
      // That is the failure mode this accessor exists to avoid — "recent order
      // never applies" with nothing to point at.
      return recentOf(this.#readDocument())
    } catch {
      // An unreadable store must not break a listing that otherwise works; the
      // sort order degrades to "file order", which is what it was before this
      // feature existed.
      return {}
    }
  }

  /**
   * The aliases the user switched on, in stored order.
   *
   * Read through `#readDocument()` (not `load()`) so a damaged section degrades
   * to "restore nothing" instead of breaking the host listing.
   *
   * @returns {string[]} aliases with a persisted auto-connect intent.
   */
  autoConnectHosts () {
    try {
      return autoConnectHostsOf(this.#readDocument())
    } catch {
      return []
    }
  }

  /**
   * Set or clear one host's persisted auto-connect intent.
   *
   * A no-op (same value as stored) returns without writing, so polling the
   * switch does not touch the file's mtime. Renames call this twice — clear the
   * old alias and set the new one — in the same manner as other bookkeeping.
   *
   * @param {string} alias - host alias.
   * @param {boolean} enabled - true to persist the intent, false to clear it.
   * @returns {string[]} the resulting alias list.
   */
  setAutoConnect (alias, enabled) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return this.autoConnectHosts()
    /** @type {string[]} */
    let result = []
    this.#withDocumentLock((existing) => {
      const current = autoConnectHostsOf(existing)
      const has = current.includes(target)
      const want = enabled === true
      if (has === want) {
        result = current
        return undefined
      }
      const next = want ? [...current, target] : current.filter(name => name !== target)
      result = next
      return { autoConnect: next }
    })
    return result
  }

  /**
   * Whether one stored host is switched on.
   *
   * Absent means ON: the switch is opt-out, so a store written before this
   * feature existed keeps every host enabled (and a host whose entry vanished
   * answers "on", because the caller then has nothing to disable).
   *
   * @param {string} alias - host alias.
   * @returns {boolean} true unless the entry says `enabled: false`.
   */
  isHostEnabled (alias) {
    try {
      return this.find(alias)?.enabled !== false
    } catch {
      return true
    }
  }

  /**
   * Switch one stored host on or off.
   *
   * The flag is written as `enabled: false` and REMOVED when switching back on,
   * so an enabled entry stays byte-identical to one written before the switch
   * existed. Only store entries can be switched: a `~/.ssh/config` host is not
   * this plugin's to disable, and the route refuses it before reaching here.
   *
   * @param {string} alias - host alias.
   * @param {boolean} enabled - true to enable.
   * @returns {boolean} the stored value.
   * @throws {Error} when the alias is not in the editable store.
   */
  setHostEnabled (alias, enabled) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    const want = enabled === true
    let written = want
    this.#withDocumentLock((existing) => {
      const entries = hostEntriesOf(existing)
      const index = entries.findIndex(entry => entry.alias === target)
      if (index === -1) {
        throw storeError(`host ${JSON.stringify(target)} is not in the editable store (it may come from ~/.ssh/config)`, STORE_INVALID)
      }
      const current = entries[index]
      const isOn = current.enabled !== false
      if (isOn === want) {
        written = want
        return undefined
      }
      const entry = { ...current, updatedAt: Date.now() }
      if (want) delete entry.enabled
      else entry.enabled = false
      const next = entries.slice()
      next[index] = entry
      written = want
      return { hosts: next }
    })
    return written
  }

  /**
   * Note that a host was used, for the panel's "recent first" order.
   *
   * Deliberately not awaited by its callers: a connection that succeeded must
   * not fail because a bookkeeping write failed, and the sort order of a list
   * is not worth blocking a handshake on. A failure is swallowed for the same
   * reason — the alternative is a dialog about a timestamp.
   *
   */
  noteHostUsed (alias, at) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return
    const when = typeof at === 'number' && Number.isFinite(at) ? at : Date.now()
    try {
      this.#withDocumentLock((existing) => {
        const section = recentOf(existing)
        section[target] = when
        // Drop the oldest beyond the cap: this section exists to order a list,
        // and an unbounded map would grow for the life of the profile.
        const entries = Object.entries(section).sort((left, right) => right[1] - left[1])
        /** @type {Record<string, number>} */
        const next = {}
        for (const [name, value] of entries.slice(0, MAX_RECENT)) next[name] = value
        return { recent: next }
      })
    } catch { /* bookkeeping must never surface */ }
  }

  /**
   * Record the host key observed on a first connection (TOFU).
   *
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
   * The saved local-passthrough settings.
   *
   * Read failures degrade to the empty section, exactly like `forwards()`: the
   * caller then falls back to the plugin configuration defaults, which is the
   * behaviour of a store that has never been written to.
   *
   */
  passthroughSettings () {
    try {
      return passthroughOf(this.#readDocument())
    } catch {
      return { scheme: undefined, remoteMissFallback: undefined }
    }
  }

  /**
   * Store the local-passthrough settings.
   *
   * Only the keys the caller names are changed, so the panel can save the
   * scheme without touching the fallback flag (and the other way around). A
   * value equal to what is stored skips the write entirely — the lock section
   * returns undefined, which leaves the file's mtime alone.
   *
   */
  setPassthroughSettings (patch = {}) {
    let written = passthroughOf({})
    this.#withDocumentLock((existing) => {
      const current = passthroughOf(existing)
      const next = {
        scheme: patch?.scheme === undefined ? current.scheme : (typeof patch.scheme === 'string' && patch.scheme.trim() !== '' ? patch.scheme.trim() : undefined),
        remoteMissFallback: patch?.remoteMissFallback === undefined ? current.remoteMissFallback : patch.remoteMissFallback === true,
      }
      written = next
      if (next.scheme === current.scheme && next.remoteMissFallback === current.remoteMissFallback) return undefined
      return {
        passthrough: {
          ...(next.scheme !== undefined ? { scheme: next.scheme } : {}),
          ...(next.remoteMissFallback !== undefined ? { remoteMissFallback: next.remoteMissFallback } : {}),
        },
      }
    })
    return written
  }

  /**
   * The browser panel's viewing preferences.
   *
   * Read failures degrade to the defaults, exactly like `forwards()`: the
   * caller then behaves as a store that has never been written to, which is the
   * pre-feature behaviour.
   *
   * @returns {{fileView: 'sidebar'|'conversation', showFiles: boolean}} the settings.
   */
  preferences () {
    try {
      return preferencesOf(this.#readDocument())
    } catch {
      return { ...DEFAULT_PREFERENCES }
    }
  }

  /**
   * Store the viewing preferences.
   *
   * Only the keys the caller names are changed, so a panel that saves the
   * target does not rewrite the file-listing choice (and the other way around).
   * A value equal to what is stored skips the write entirely — the lock section
   * returns undefined, which leaves the file's mtime alone.
   *
   * Unknown keys are ignored here; the HTTP route rejects them before they get
   * this far (a stale browser must not be able to rewrite an unrelated section).
   *
   * @param {{fileView?: string, showFiles?: boolean}} [patch] - the settings to change.
   * @returns {{fileView: 'sidebar'|'conversation', showFiles: boolean}} the stored result.
   */
  setPreferences (patch = {}) {
    let written = { ...DEFAULT_PREFERENCES }
    this.#withDocumentLock((existing) => {
      const current = preferencesOf(existing)
      const next = {
        fileView: patch?.fileView === undefined
          ? current.fileView
          : (FILE_VIEW_MODES.includes(patch.fileView) ? patch.fileView : DEFAULT_PREFERENCES.fileView),
        showFiles: patch?.showFiles === undefined ? current.showFiles : patch.showFiles === true,
      }
      written = next
      if (next.fileView === current.fileView && next.showFiles === current.showFiles) return undefined
      return { preferences: next }
    })
    return written
  }

  /**
   * The `audit` section: how many commands the panel keeps.
   *
   * Read failures and nonsense degrade to the default capacity rather than
   * throwing: the audit is a convenience, and a store that cannot be parsed must
   * not stop the plugin from starting. The returned number is always inside the
   * bounds the ring accepts, so the two cannot disagree.
   *
   * @returns {{retention: number}} the section, normalized.
   */
  audit () {
    let retention = DEFAULT_AUDIT_RETENTION
    try {
      const section = this.#readDocument()?.audit
      const raw = section !== null && typeof section === 'object' ? section.retention : undefined
      if (Number.isInteger(raw) && raw >= AUDIT_MIN_CAPACITY && raw <= AUDIT_MAX_CAPACITY) retention = raw
    } catch { /* unreadable store → the default */ }
    return { retention }
  }

  /**
   * Store the audit retention.
   *
   * @param {number} retention - a whole number within the ring's bounds.
   * @returns {{retention: number}} the stored value.
   */
  setAudit (retention) {
    const next = Number.isInteger(retention) && retention >= AUDIT_MIN_CAPACITY && retention <= AUDIT_MAX_CAPACITY
      ? retention
      : DEFAULT_AUDIT_RETENTION
    this.#withDocumentLock((existing) => {
      const current = existing !== null && typeof existing === 'object' && existing.audit !== null && typeof existing.audit === 'object'
        ? existing.audit
        : {}
      if (current.retention === next) return undefined
      return { audit: { ...current, retention: next } }
    })
    return { retention: next }
  }

  /**
   * The `workspaces` section: which remote workspaces the user detached.
   *
   * Read failures degrade to the empty section. A store this plugin cannot
   * parse must not take the whole panel down with it, and "nothing is
   * disabled" is the safe fallback: the worst case is re-mounting a workspace
   * the user had unloaded, never losing access to one.
   *
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
    // Prefer the private path. Before the first write an older install keeps
    // its document in the legacy root location; reading it there (and writing
    // it to the new path on the first save) migrates without losing hosts.
    let readPath = this.path
    if (!existsSync(readPath) && this.legacyPath !== undefined && existsSync(this.legacyPath)) {
      readPath = this.legacyPath
    }
    if (!existsSync(readPath)) return {}
    const raw = readFileSync(readPath, 'utf8')
    if (raw.trim() === '') return {}
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      throw storeError(`host store file ${readPath} is not valid JSON; fix or remove it before editing hosts here`, STORE_UNREADABLE)
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw storeError(`host store file ${readPath} does not contain a JSON object; fix or remove it before editing hosts here`, STORE_UNREADABLE)
    }
    return data
  }
}

// ---------------------------------------------------------------------------
// At-rest encryption for the secrets this store holds
// ---------------------------------------------------------------------------
//
// The store is a shared JSON document, so a password sitting in it is exposed to
// every copy of that file — backups, sync folders, a pasted excerpt, a
// screenshot. Secrets are therefore encrypted with AES-256-GCM under a random
// 32-byte key kept in its own owner-only file next to the store
// (`dsh-ssh-workspace/dsh-ssh.key`), and decrypted only while a connection is being configured.
//
// The encryption writer and the key share one home (the new
// `$DSH_HOME/dsh-ssh-workspace/`, with the old `$DSH_HOME` root readable for
// migration): a key written beside one and read beside another is
// indistinguishable from a lost key. Keeping them together is what makes
// "secrets are never stored in plaintext" true.
//
// Ciphertext spelling: `enc:v1:<base64(iv | tag | ciphertext)>`. Any value
// without that prefix is passed through unchanged, which is what lets a legacy
// plaintext store (and the plaintext `password` keyword in `~/.ssh/config`)
// keep working while the startup migration re-writes it as ciphertext.
/** Ciphertext marker; bump the version when the layout changes. */
const PREFIX = 'enc:v1:'

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** Absolute path the secret key is WRITTEN to (sibling of the new store). */
export function keyPath () {
  return join(workspaceDir(), 'dsh-ssh.key')
}

/** Absolute path the older releases kept the key at (read-only fallback). */
function legacyKeyPath () {
  return join(dshHome(), 'dsh-ssh.key')
}

/**
 * True when a stored value carries this module's ciphertext spelling.
 *
 * @returns {boolean} true when it is ciphertext written by {@link SecretCodec#encrypt}.
 */
export function isEncrypted (value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/**
 * Encrypt / decrypt stored secrets under one key.
 *
 * The key is read once and cached for the process lifetime. A missing key file
 * is created on first use; an unreadable or wrongly sized one is an error
 * rather than a silent regeneration, because a fresh key would make every
 * already-stored ciphertext undecryptable.
 */
export class SecretCodec {
  constructor (options = {}) {
    this.path = options.path ?? keyPath()
    // Only the default location falls back to the old root key. An explicit
    // path (tests, foreign keys) is used verbatim.
    this.legacyPath = options.path === undefined ? legacyKeyPath() : undefined
    /** @type {Buffer | undefined} */
    this.key = undefined
  }

  /**
   * Encrypt one secret. Empty values and already-encrypted values pass through
   * (the latter so a re-save cannot double-encrypt).
   *
   * @returns {string | undefined} ciphertext, or undefined for an empty value.
   */
  encrypt (value) {
    if (typeof value !== 'string' || value === '') return undefined
    if (isEncrypted(value)) return value
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.#loadKey(), iv)
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
  }

  /**
   * Decrypt one stored secret. Plaintext (a legacy store, or an ssh-config
   * value) is returned as-is.
   *
   * @throws {Error} when the value is ciphertext this key cannot open.
   */
  decrypt (value) {
    if (typeof value !== 'string' || value === '') return undefined
    if (!isEncrypted(value)) return value
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
    if (raw.length <= IV_BYTES + TAG_BYTES) {
      throw new Error(`stored secret is not a valid ${PREFIX} value`)
    }
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const body = raw.subarray(IV_BYTES + TAG_BYTES)
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#loadKey(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    } catch {
      throw new Error(`cannot decrypt the stored secret: key file ${this.path} does not match the key it was written with`)
    }
  }

  /**
   * The process-wide key: read from disk, or generated and saved on first use.
   *
   * @returns {Buffer} the 32-byte key.
   */
  #loadKey () {
    if (this.key !== undefined) return this.key
    // Read the new key first; an older install keeps it in the legacy root.
    // Reading it there decrypts the migrated document's ciphertext. We never
    // copy or regenerate it here: a fresh key would make every already-stored
    // ciphertext undecryptable, so the legacy key stays the source of truth
    // until the user deliberately moves it.
    let readPath = this.path
    if (!existsSync(readPath) && this.legacyPath !== undefined && existsSync(this.legacyPath)) {
      readPath = this.legacyPath
    }
    if (existsSync(readPath)) {
      const key = Buffer.from(readFileSync(readPath, 'utf8').trim(), 'base64')
      if (key.length !== KEY_BYTES) {
        throw new Error(`secret key file ${readPath} does not hold a ${KEY_BYTES}-byte key; restore the original file, or delete it and re-save the affected hosts`)
      }
      this.key = key
      return key
    }
    const key = randomBytes(KEY_BYTES)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(this.path, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 })
    // The mode above only applies to a fresh file; tighten an existing one too.
    // Best-effort: win32 (and some network filesystems) may not honor it.
    try { chmodSync(this.path, 0o600) } catch { /* mode unsupported here */ }
    this.key = key
    return key
  }
}
