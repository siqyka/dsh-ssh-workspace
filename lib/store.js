/**
 * Durable, editable host store.
 *
 * The format is the shared `$DSH_HOME/dsh-ssh.json` host list
 * (`{ version: 1, hosts: [...] }`), so DSH's SSH tooling can share one host
 * list instead of asking the user to configure the same machine twice.
 * Entries keep the `SshHostEntry` shape and unknown fields survive a
 * rewrite — the file is shared, not owned by this plugin.
 *
 * Secrets (password, key passphrase) live in this file in plaintext, exactly
 * as the shared format stores them; they are never sent back to the browser.
 *
 * @module @dsh-community/dsh-ssh-workspace/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Absolute path of the shared host store. */
export function storePath () {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, 'dsh-ssh.json')
}

/** Aliases travel through paths and shells; keep them boring. */
const ALIAS_PATTERN = /^[^\s/\\*?"]+$/u

/**
 * Validate one alias.
 *
 * @param {unknown} alias - candidate alias.
 * @returns {string | undefined} the problem, or undefined when valid.
 */
export function validateAlias (alias) {
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
export function validateHostEntry (entry) {
  const problems = []
  const aliasError = validateAlias(entry?.alias)
  if (aliasError !== undefined) problems.push(aliasError)
  if (typeof entry?.host !== 'string' || entry.host.trim() === '') problems.push('host is required')
  if (!Number.isInteger(entry?.port) || entry.port < 1 || entry.port > 65535) problems.push('port must be an integer between 1 and 65535')
  if (typeof entry?.user !== 'string' || entry.user.trim() === '') problems.push('user is required')
  const auth = entry?.auth
  if (auth?.kind === 'key') {
    if (!isNonEmptyString(auth.keyPath)) problems.push('a private key path is required for key auth')
  } else if (auth?.kind === 'password') {
    if (!isNonEmptyString(auth.password)) problems.push('a password is required for password auth')
  } else if (auth?.kind !== 'agent') {
    problems.push('auth kind must be one of key, password, agent')
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
 * @param {object | undefined} auth - editor-supplied auth record.
 * @returns {{kind: string, keyPath?: string, passphrase?: string, password?: string, agentPath?: string}} stored auth.
 */
export function normalizeAuthForStore (auth) {
  if (auth?.kind === 'key') {
    const normalized = { kind: 'key', keyPath: String(auth.keyPath ?? '').trim() }
    if (isNonEmptyString(auth.passphrase)) normalized.passphrase = auth.passphrase
    return normalized
  }
  if (auth?.kind === 'password') {
    return { kind: 'password', ...(isNonEmptyString(auth.password) ? { password: auth.password } : {}) }
  }
  const normalized = { kind: 'agent' }
  if (isNonEmptyString(auth?.agentPath)) normalized.agentPath = auth.agentPath.trim()
  return normalized
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
  return entry
}

/**
 * Merge an auth patch onto a stored auth record.
 *
 * Blank password / passphrase mean "keep the stored secret": the browser
 * never receives secrets back, so an untouched field always posts empty.
 * Switching the auth kind cannot carry a secret across, so the new one is
 * required up front.
 */
function mergeAuth (currentAuth, patch) {
  const kind = patch?.kind
  if (kind !== currentAuth?.kind) {
    if (kind === 'password' && !isNonEmptyString(patch.password)) throw new Error('switching to password auth requires a password')
    if (kind === 'key' && !isNonEmptyString(patch.keyPath)) throw new Error('switching to key auth requires a key path')
    return normalizeAuthForStore(patch)
  }
  if (kind === 'key') {
    const auth = { kind: 'key', keyPath: String(patch.keyPath ?? '').trim() }
    const passphrase = isNonEmptyString(patch.passphrase) ? patch.passphrase : currentAuth?.passphrase
    if (isNonEmptyString(passphrase)) auth.passphrase = passphrase
    return auth
  }
  if (kind === 'password') {
    const password = isNonEmptyString(patch.password) ? patch.password : currentAuth?.password
    if (!isNonEmptyString(password)) throw new Error('a password is required for password auth')
    return { kind: 'password', password }
  }
  // Agent: a blank path is meaningful (use the default agent), so it clears.
  const auth = { kind: 'agent' }
  if (isNonEmptyString(patch?.agentPath)) auth.agentPath = patch.agentPath.trim()
  return auth
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
  return merged
}

/**
 * The editable host store behind `$DSH_HOME/dsh-ssh.json`.
 */
export class HostConfigStore {
  /**
   * @param {string} [path] - store file path override (tests).
   */
  constructor (path) {
    this.path = path ?? storePath()
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
    const entries = this.load()
    if (entries.some(entry => entry.alias === payload?.alias?.trim?.())) {
      throw new Error(`host ${JSON.stringify(payload?.alias)} already exists in the store`)
    }
    const entry = buildEntry(payload)
    const problems = validateHostEntry(entry)
    if (problems.length > 0) throw new Error(problems.join('; '))
    this.save([...entries, entry])
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
    const entries = this.load()
    const index = entries.findIndex(entry => entry.alias === alias)
    if (index === -1) {
      throw new Error(`host ${JSON.stringify(alias)} is not in the editable store (it may come from ~/.ssh/config)`)
    }
    const merged = mergeEntry(entries[index], patch)
    const problems = validateHostEntry(merged)
    if (problems.length > 0) throw new Error(problems.join('; '))
    if (merged.alias !== alias && entries.some((entry, i) => i !== index && entry.alias === merged.alias)) {
      throw new Error(`alias ${JSON.stringify(merged.alias)} is already taken`)
    }
    const updated = { ...merged, updatedAt: Date.now() }
    const next = entries.slice()
    next[index] = updated
    this.save(next)
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
    const entries = this.load()
    const next = entries.filter(entry => entry.alias !== alias)
    if (next.length === entries.length) {
      throw new Error(`host ${JSON.stringify(alias)} is not in the editable store`)
    }
    this.save(next)
    return true
  }

  /**
   * Write the whole file atomically (staging file + rename).
   *
   * @param {Array<object>} entries - the complete entry list.
   * @returns {void}
   */
  save (entries) {
    const existing = this.#readDocument()
    const document = { ...existing, version: existing.version ?? 1, hosts: entries }
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.path)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* never created or already gone */ }
      throw error
    }
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
      throw new Error(`host store file ${this.path} is not valid JSON; fix or remove it before editing hosts here`)
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`host store file ${this.path} does not contain a JSON object; fix or remove it before editing hosts here`)
    }
    return data
  }
}
