/**
 * Host record lookup: the editable store first, OpenSSH config as fallback.
 *
 * Editable records live in the shared `$DSH_HOME/dsh-ssh.json` store (see
 * store.js); concrete `Host` blocks in `~/.ssh/config` are read as a
 * read-only fallback so an already-configured machine needs no duplication.
 * A store entry shadows an ssh-config block with the same alias.
 *
 * @module @shiqyka/dsh-ssh-workspace/hosts
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HostConfigStore } from './store.js'

/** Absolute path of the user's OpenSSH client config. */
export function sshConfigPath () {
  return join(homedir(), '.ssh', 'config')
}

/** Expand a leading `~` in a path. */
export function expandHome (path) {
  const value = String(path ?? '')
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Read one value from an OpenSSH config file, following the first-wins rule
 * OpenSSH itself uses for most keywords.
 *
 * Kept deliberately small: the goal is a usable fallback, not a full config
 * parser. `Include`, `Match`, and wildcard blocks are ignored rather than
 * mis-resolved.
 *
 * @param {string} file - config file path.
 * @param {string} alias - the Host alias to look up.
 * @returns {Record<string, string>} lowercase keyword → value for that block.
 */
function readSshConfigBlock (file, alias) {
  if (!existsSync(file)) return {}
  const props = {}
  let inBlock = false
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9]*)[\s=]+(.+)$/u.exec(line)
    if (match === null) continue
    const [, keyword, value] = match
    if (keyword.toLowerCase() === 'host') {
      // A new Host line ends the previous block. Only an exact, non-wildcard
      // pattern selects the requested alias.
      const patterns = value.trim().split(/\s+/u)
      inBlock = patterns.some(pattern => pattern === alias)
      continue
    }
    if (!inBlock) continue
    const key = keyword.toLowerCase()
    // First wins, per OpenSSH.
    if (!(key in props)) props[key] = value.trim()
  }
  return props
}

/**
 * True when a transport this engine cannot honor (jump host or
 * ProxyCommand) is configured.
 */
function needsProxyTransport (jumpValue, commandValue) {
  const jumps = Array.isArray(jumpValue) ? jumpValue.filter(value => typeof value === 'string' && value.trim() !== '') : []
  const command = String(commandValue ?? '').trim().toLowerCase()
  return jumps.length > 0 || (command !== '' && command !== 'none')
}

/**
 * Turn a store entry into a connect descriptor.
 *
 * @param {object} entry - a store entry.
 * @param {{password?: string, passphrase?: string}} [secret] - the entry's decrypted secret, when the store holds one.
 * @returns {object} a normalized connect descriptor.
 * @throws {Error} when the entry needs a transport this engine cannot honor.
 */
function storeDescriptor (entry, secret) {
  if (needsProxyTransport(entry.proxyJump, entry.proxyCommand)) {
    throw new Error(`host ${JSON.stringify(entry.alias)} is configured with a jump host or ProxyCommand, which dsh-ssh-workspace cannot honor — remove it from the host or connect with a different tool`)
  }
  return {
    alias: entry.alias,
    host: typeof entry.host === 'string' && entry.host !== '' ? entry.host : entry.alias,
    port: Number.isInteger(entry.port) ? entry.port : 22,
    user: typeof entry.user === 'string' && entry.user !== '' ? entry.user : 'root',
    // The decrypted secret wins; a plaintext value still on the entry is the
    // pre-migration fallback and keeps working until the startup migration
    // moves it into the encrypted section.
    auth: normalizeAuth({ ...entry.auth, ...(secret ?? {}) }),
    source: 'store',
  }
}

/**
 * The host store: editable records from the shared dsh-ssh.json store plus
 * read-only fallback records parsed from ~/.ssh/config.
 */
export class HostStore {
  /**
   * @param {string} [configPath] - ssh config path override (tests).
   * @param {HostConfigStore} [entryStore] - editable store override (tests).
   */
  constructor (configPath, entryStore) {
    this.configPath = configPath ?? sshConfigPath()
    this.entryStore = entryStore ?? new HostConfigStore()
  }

  /**
   * One entry from the editable store, when present. Read failures degrade to
   * "no entry" so a malformed store file never blocks ssh-config hosts.
   *
   * @param {string} alias - host alias.
   * @returns {object | undefined} the store entry.
   */
  entry (alias) {
    try {
      return this.entryStore.find(alias)
    } catch {
      return undefined
    }
  }

  /**
   * The recorded host key (TOFU fingerprint) for one alias, when present.
   * Read failures degrade to "nothing recorded", exactly as {@link entry}.
   *
   * @param {string} alias - host alias.
   * @returns {{host?: string, port?: number, keyType: string, fingerprint: string, recordedAt?: number} | undefined} the record.
   */
  knownHostKey (alias) {
    try {
      return this.entryStore.knownHostKey(alias)
    } catch {
      return undefined
    }
  }

  /**
   * Record the host key observed on a first connection (trust on first use).
   *
   * @param {string} alias - host alias.
   * @param {{host?: string, port?: number, keyType: string, fingerprint: string}} record - the presented key.
   * @returns {void}
   */
  rememberHostKey (alias, record) {
    this.entryStore.rememberHostKey(alias, record)
  }

  /**
   * Drop the recorded host key for one alias.
   *
   * @param {string} alias - host alias.
   * @returns {boolean} whether a record was removed.
   */
  forgetHostKey (alias) {
    return this.entryStore.forgetHostKey(alias)
  }

  /**
   * Resolve one host to a connect configuration. The editable store wins;
   * ~/.ssh/config is the fallback for aliases the store does not define.
   *
   * @param {string} alias - host alias.
   * @returns {object} a normalized connect descriptor.
   * @throws {Error} when the alias is unknown or needs an unsupported transport.
   */
  resolve (alias) {
    const stored = this.entry(alias)
    if (stored !== undefined) return storeDescriptor(stored, this.entryStore.secretFor(stored.alias))
    const fromConfig = readSshConfigBlock(this.configPath, alias)
    if (Object.keys(fromConfig).length === 0) {
      throw new Error(`unknown SSH host ${JSON.stringify(alias)}: no entry in the host store and no matching Host block in ${this.configPath}`)
    }
    if (needsProxyTransport(fromConfig.proxyjump, fromConfig.proxycommand)) {
      throw new Error(`host ${JSON.stringify(alias)} is configured with a jump host or ProxyCommand, which dsh-ssh-workspace cannot honor — remove it from ${this.configPath} or connect with a different tool`)
    }
    const host = fromConfig.hostname ?? alias
    const user = fromConfig.user ?? process.env.USER ?? process.env.USERNAME ?? 'root'
    const port = fromConfig.port === undefined ? 22 : Number.parseInt(fromConfig.port, 10)
    /** @type {object} */
    let auth = { kind: 'agent' }
    if (fromConfig.identityfile !== undefined) {
      // `%d` is OpenSSH's home placeholder.
      const keyPath = expandHome(fromConfig.identityfile.replace(/%d/gu, homedir()))
      auth = { kind: 'key', keyPath }
    } else if (fromConfig.password !== undefined) {
      auth = { kind: 'password', password: fromConfig.password }
    } else if (fromConfig.identityagent !== undefined && fromConfig.identityagent.toLowerCase() !== 'none') {
      auth = { kind: 'agent', agentPath: expandHome(fromConfig.identityagent) }
    }
    return {
      alias,
      host,
      port: Number.isInteger(port) ? port : 22,
      user,
      auth,
      source: 'ssh-config',
    }
  }

  /**
   * Secret-free rows for the agent surface: editable store entries first,
   * then ~/.ssh/config blocks. An alias defined in both appears once, as the
   * store entry — the same precedence `resolve` applies.
   *
   * @returns {Array<object>} host rows.
   */
  rows () {
    const rows = []
    const shadowed = new Set()
    for (const entry of this.#storeEntries()) {
      shadowed.add(entry.alias)
      try {
        const resolved = storeDescriptor(entry)
        const auth = resolved.auth
        rows.push({
          alias: resolved.alias,
          host: resolved.host,
          port: resolved.port,
          user: resolved.user,
          auth: auth.kind,
          keyReady: auth.kind !== 'key' || existsSync(expandHome(auth.keyPath ?? '')),
          source: 'store',
          description: typeof entry.description === 'string' ? entry.description : undefined,
          tags: Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string') : [],
        })
      } catch {
        // Unsupported (jump host) or unusable entries are skipped, never
        // surfaced as a broken row — but they still shadow ssh-config.
      }
    }
    for (const alias of this.sshConfigAliases()) {
      if (shadowed.has(alias)) continue
      try {
        const resolved = this.resolve(alias)
        const auth = resolved.auth
        rows.push({
          alias,
          host: resolved.host,
          port: resolved.port,
          user: resolved.user,
          auth: auth.kind,
          keyReady: auth.kind !== 'key' || existsSync(expandHome(auth.keyPath ?? '')),
          source: 'ssh-config',
          description: undefined,
          tags: [],
        })
      } catch {
        // An unusable block (bad port, no host, proxy transport) is skipped,
        // never surfaced as a broken row.
      }
    }
    return rows
  }

  /** Store entries, degrading to an empty list on read failure. */
  #storeEntries () {
    try {
      return this.entryStore.load()
    } catch {
      return []
    }
  }

  /**
   * Concrete `Host` aliases declared in the user's OpenSSH config.
   *
   * @returns {string[]} alias list in file order, wildcards excluded.
   */
  sshConfigAliases () {
    if (!existsSync(this.configPath)) return []
    const aliases = []
    for (const rawLine of readFileSync(this.configPath, 'utf8').split(/\r?\n/u)) {
      const match = /^\s*Host\s+(.+)$/iu.exec(rawLine)
      if (match === null) continue
      for (const pattern of match[1].trim().split(/\s+/u)) {
        if (pattern === '' || pattern.includes('*') || pattern.includes('?')) continue
        if (!aliases.includes(pattern)) aliases.push(pattern)
      }
    }
    return aliases
  }
}

/**
 * Normalize an auth descriptor into a consistent shape.
 *
 * @param {object | undefined} auth - auth record from config.
 * @returns {{kind: string, keyPath?: string, password?: string, passphrase?: string, agentPath?: string}} normalized auth.
 */
export function normalizeAuth (auth) {
  if (auth === undefined || auth === null || typeof auth !== 'object') return { kind: 'agent' }
  const kind = auth.kind === 'key' || auth.kind === 'password' || auth.kind === 'agent' ? auth.kind : 'agent'
  return {
    kind,
    ...(typeof auth.keyPath === 'string' && auth.keyPath !== '' ? { keyPath: expandHome(auth.keyPath) } : {}),
    ...(typeof auth.password === 'string' ? { password: auth.password } : {}),
    ...(typeof auth.passphrase === 'string' && auth.passphrase !== '' ? { passphrase: auth.passphrase } : {}),
    ...(typeof auth.agentPath === 'string' && auth.agentPath !== '' ? { agentPath: expandHome(auth.agentPath) } : {}),
  }
}
