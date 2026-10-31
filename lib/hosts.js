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
import { auditConfigText } from './config-audit.js'

/** Absolute path of the user's OpenSSH client config. */
function sshConfigPath () {
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
 * Does one Host pattern select this alias?
 *
 * `Host` takes a list of patterns, and OpenSSH matches them with globs, so a
 * catch-all `Host *` applies to every host in the file. Only `*` and `?` are
 * honoured here; a `!` prefix is a negation and is handled by the caller.
 *
 * @param {string} pattern - one Host pattern.
 * @param {string} alias - the alias being resolved.
 * @returns {boolean} whether the pattern selects the alias.
 */
function hostPatternMatches (pattern, alias) {
  const source = pattern
    .split('*').map(part => part.split('?').map(escapeRegExp).join('.')).join('.*')
  return new RegExp(`^${source}$`, 'u').test(alias)
}

/** Escape a literal for embedding in a RegExp source. */
function escapeRegExp (text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Collect the proxy-transport keywords that apply to one alias.
 *
 * ## Why this is a separate scan
 *
 * `readSshConfigBlock` deliberately reads only an EXACT `Host <alias>` block,
 * so a catch-all `Host *` block never contributes to a host's identity —
 * `HostName`, `User` and `IdentityFile` stay the ones the user wrote for that
 * host. But proxy transport is not identity: `Host *` is where a jump host is
 * normally declared, and a `ProxyJump bastion` sitting there applies to every
 * host the file mentions. Ignoring wildcard blocks therefore turned "this host
 * must be reached through a bastion" into "connect to it directly" — the same
 * class of silent, unsafe downgrade the exact-match shape bug caused, one
 * level further out.
 *
 * OpenSSH resolves a keyword by first-obtained-value-wins across all blocks
 * that match, in file order, so that rule is applied here: earlier blocks win
 * (a `Host *` placed at the top outranks a later specific block), and a later
 * `ProxyJump none` cancels an earlier one. Negated patterns (`!name`) exclude
 * the alias from that block, as in OpenSSH.
 *
 * @param {string} file - config file path.
 * @param {string} alias - the alias being resolved.
 * @returns {{proxyjump?: string, proxycommand?: string}} the applicable values.
 */
function readSshConfigProxy (file, alias) {
  if (!existsSync(file)) return {}
  /** @type {{proxyjump?: string, proxycommand?: string}} */
  const props = {}
  let applies = false
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9]*)[\s=]+(.+)$/u.exec(line)
    if (match === null) continue
    const [, keyword, value] = match
    if (keyword.toLowerCase() === 'host') {
      const patterns = value.trim().split(/\s+/u)
      const positive = patterns.filter(pattern => !pattern.startsWith('!'))
      const negative = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
      applies = positive.some(pattern => hostPatternMatches(pattern, alias)) &&
        !negative.some(pattern => hostPatternMatches(pattern, alias))
      continue
    }
    if (!applies) continue
    const key = keyword.toLowerCase()
    if (key !== 'proxyjump' && key !== 'proxycommand') continue
    // First wins, per OpenSSH — over wildcard blocks as well as exact ones.
    if (!(key in props)) props[key] = value.trim()
  }
  return props
}

/**
 * True when a transport this engine cannot honor (jump host or
 * ProxyCommand) is configured.
 *
 * The two callers hand this different shapes, and the first one was silently
 * wrong: a store entry keeps `proxyJump` as an ARRAY, while an ssh-config block
 * keeps `proxyjump` as the raw STRING the file said. Accepting only arrays meant
 * a `ProxyJump bastion` block read as "no jump host", so the host was listed and
 * connected DIRECTLY — ignoring the bastion the user's config requires, which is
 * both wrong and unsafe. Both shapes are therefore accepted.
 *
 * `none` is not a value, it is the keyword that TURNS THE PROXY OFF: OpenSSH
 * documents `ProxyJump none` / `ProxyCommand none` as "do not use a proxy",
 * and the common override idiom is a `Host *` block carrying the jump host
 * with a per-host `ProxyJump none` cancelling it. Reading `none` as a hop
 * therefore refused hosts the user had explicitly configured to connect
 * DIRECTLY — the mirror image of the string/array bug, and equally wrong.
 * Both keywords are checked for it, symmetrically.
 *
 * @param {string | string[] | undefined} jumpValue - ProxyJump as stored or as parsed.
 * @param {string | undefined} commandValue - ProxyCommand.
 * @returns {boolean} true when a hop or a command is actually configured.
 */
function needsProxyTransport (jumpValue, commandValue) {
  /** `none` (any case) and blank both mean "no proxy configured". */
  const isOff = (value) => {
    const text = String(value ?? '').trim().toLowerCase()
    return text === '' || text === 'none'
  }
  const jumps = Array.isArray(jumpValue)
    ? jumpValue
    : (typeof jumpValue === 'string' ? [jumpValue] : [])
  return jumps.some(jump => typeof jump === 'string' && !isOff(jump)) || !isOff(commandValue)
}

/**
 * Interpret an OpenSSH yes/no keyword.
 *
 * OpenSSH accepts `yes`/`no` (case-insensitive); anything else — including a
 * bare keyword with no value, which the parser never records — is not a yes.
 *
 * @param {string | undefined} value - the keyword's value.
 * @returns {boolean} true only for an explicit `yes`.
 */
function configYes (value) {
  return String(value ?? '').trim().toLowerCase() === 'yes'
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
    // Opt-in transport flags. Absent means "use the ssh2 default", which is
    // also what an entry written by an older version means.
    agentForward: entry.agentForward === true,
    compress: entry.compress === true,
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
    // Proxy transport is read from EVERY matching block, wildcards included —
    // the exact block alone would miss a `Host *` jump host. See
    // readSshConfigProxy for why identity keywords stay exact-only.
    const proxy = readSshConfigProxy(this.configPath, alias)
    if (needsProxyTransport(proxy.proxyjump, proxy.proxycommand)) {
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
      // OpenSSH spellings, normalized to the same booleans the store carries.
      agentForward: configYes(fromConfig.forwardagent),
      compress: configYes(fromConfig.compression),
      source: 'ssh-config',
    }
  }

  /**
   * Secret-free rows for the agent surface: editable store entries first,
   * then ~/.ssh/config blocks. An alias defined in both appears once, as the
   * store entry — the same precedence `resolve` applies.
   *
   * ## Why this also reports what it could not show
   *
   * Every skipped entry used to be a bare `catch {}`, and a failed store read
   * degraded to `[]`. Both surfaced as "you have no hosts" — the same screen as
   * a genuinely empty configuration — so the user had nothing to act on and no
   * way to tell a typo in `~/.ssh/config` from a broken store file. The skipped
   * entries are therefore collected and served alongside the rows.
   *
   * @returns {{rows: Array<object>, skipped: Array<{alias?: string, reason: string}>, storeError?: string}} the listing plus its gaps.
   */
  listing () {
    const rows = []
    const skipped = []
    const shadowed = new Set()
    for (const entry of this.#storeEntries(skipped)) {
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
          agentForward: resolved.agentForward === true,
          compress: resolved.compress === true,
        })
      } catch (error) {
        // Unsupported (jump host) or unusable entries are skipped rather than
        // surfaced as broken rows — but they still shadow ssh-config, and the
        // REASON is now reported so "my host vanished" has an answer.
        skipped.push({ alias: entry.alias, reason: error instanceof Error ? error.message : String(error) })
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
          agentForward: resolved.agentForward === true,
          compress: resolved.compress === true,
          // What this host's config says that the plugin does not act on. A
          // row is only pushed when it resolved, so `unsupported` here means
          // "usable, but with settings that had no effect" — the `lost`
          // verdict. A `refused` host never becomes a row at all; it lands in
          // `skipped` with its reason.
          ...(() => {
            const audit = this.configAudit(alias)
            return audit.length === 0 ? {} : { unsupported: audit }
          })(),
        })
      } catch (error) {
        // An unusable block (bad port, no host, proxy transport) is skipped,
        // never surfaced as a broken row — and the reason is reported.
        skipped.push({ alias, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { rows, skipped, ...(this.storeError === undefined ? {} : { storeError: this.storeError }) }
  }

  /**
   * What one ssh-config host declares that this plugin does not act on.
   *
   * Reported per host rather than as a global note because the consequence is
   * per host: a `LocalForward` in a `Host *` block applies to every host the
   * file mentions, while a `ProxyJump` in one specific block applies to that
   * host alone. Reading the file once per alias is the cheap, obvious choice
   * here — the file is small, this runs when a list is rendered, and caching it
   * would introduce the very staleness the audit exists to expose.
   *
   * Never throws: an unreadable config yields an empty audit, because the
   * caller already reports the read failure separately (`storeError`) and
   * doubling it here would report one problem twice.
   *
   * @param {string} alias - host alias.
   * @returns {import('./config-audit.js').AuditEntry[]} the audit.
   */
  configAudit (alias) {
    let text
    try {
      text = readFileSync(this.configPath, 'utf8')
    } catch {
      return []
    }
    try {
      return auditConfigText(text, alias)
    } catch {
      return []
    }
  }

  /**
   * The same rows, for callers that only want the list.
   *
   * @returns {Array<object>} host rows.
   */
  rows () {
    return this.listing().rows
  }

  /**
   * Store entries, recording a read failure instead of hiding it.
   *
   * A store that cannot be read is NOT an empty store: the difference is
   * whether the user has no hosts or cannot see the ones they have.
   *
   * @param {Array<{reason: string}>} [skipped] - collects the failure reason.
   * @returns {Array<object>} the entries, or an empty list when unreadable.
   */
  #storeEntries (skipped) {
    try {
      this.storeError = undefined
      return this.entryStore.load()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.storeError = reason
      skipped?.push({ reason: `the host store could not be read: ${reason}` })
      return []
    }
  }

  /**
   * Concrete `Host` aliases declared in the user's OpenSSH config.
   *
   * A config file that cannot be read is recorded in `storeError` rather than
   * thrown. `listing()` used to guard only the entry store, so a broken
   * `~/.ssh/config` (a directory in place of the file, a permissions problem,
   * a half-written file being replaced) escaped the reporting path entirely and
   * crashed the caller — the very "empty vs. unreadable" distinction O-10
   * exists to make, left half-done.
   *
   * @returns {string[]} alias list in file order, wildcards excluded.
   */
  sshConfigAliases () {
    if (!existsSync(this.configPath)) return []
    let text
    try {
      text = readFileSync(this.configPath, 'utf8')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Do not overwrite a store error: the store is the primary source, and
      // reporting the first failure is what the caller can act on.
      if (this.storeError === undefined) this.storeError = `the ssh config could not be read: ${reason}`
      return []
    }
    const aliases = []
    for (const rawLine of text.split(/\r?\n/u)) {
      const match = /^\s*Host\s+(.+)$/iu.exec(rawLine)
      if (match === null) continue
      for (const pattern of match[1].trim().split(/\s+/u)) {
        // A negation (`!name`) names no host; a wildcard (`*`, `?`) names a
        // SET of hosts, not one row. Both are skipped here, but a wildcard
        // block is still consulted for proxy transport by readSshConfigProxy.
        if (pattern === '' || pattern.startsWith('!') || pattern.includes('*') || pattern.includes('?')) continue
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
function normalizeAuth (auth) {
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
