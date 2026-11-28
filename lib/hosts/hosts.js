/**
 * Host records: where they come from, how config is read, how a jump chain is
 * parsed. The answer: editable records live in the shared `$DSH_HOME/dsh-ssh.json`
 * store (see `store.js`); `~/.ssh/config` `Host` blocks are a read-only fallback,
 * so a configured machine needs no duplication. A store entry shadows a config
 * block of the same alias. Three pieces of work produce it:
 *
 *  - **`Include` is followed** (`readConfigWithIncludes`). Its hazards are all
 *    filesystem ones: a glob matching nothing, a pattern hitting a directory, a
 *    symlink back to the including file, two files including each other. Get one
 *    wrong and "read my config" becomes an infinite loop or half a config.
 *    Included files splice AT THE DIRECTIVE, not appended — precedence is
 *    first-value-wins across the merged text, so appending inverts which block
 *    wins. This is the fact most implementations get wrong.
 *  - **`ProxyJump` is parsed** (`parseJumpChain`) into hops. Never a
 *    `ProxyCommand`: that is arbitrary local execution, and a config file is
 *    data (it can come from a repository). Failure modes are textual (`a,b`,
 *    `user@a:2222`, `none`, self-reference, a chain naming its own target) and
 *    security-relevant: a chain silently collapsing to direct is the O-17 bug
 *    class.
 *  - **The records** (`HostStore`) join the store and the config blocks, with
 *    the audit on each row.
 *
 * Why one file: these were three (`hosts`, `include-chain`, `jump-chain`), each
 * a text-decided, network-free extraction. But both parsers have one consumer,
 * `HostStore`, which must know their order — expand includes, section the merged
 * text, resolve a block to hops — and that order was invisible in three files
 * each opening with "why this is its own module".
 *
 * @module @shiqyka/dsh-ssh-workspace/hosts
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { auditConfigText } from '../report/report.js'
import { escapeRegExp } from '../core/shared.js'
import { isExact, sectionsOf, selects } from './ssh-config.js'
import { HostConfigStore } from './store.js'

// ---------------------------------------------------------------------------
// Include: following `Include` directives in an OpenSSH config file
// ---------------------------------------------------------------------------

/** How deep `Include` nesting may go before it is treated as a mistake. */
export const MAX_INCLUDE_DEPTH = 8

/**
 * Expand a leading `~` and resolve a relative include against `~/.ssh`.
 *
 */
function resolveIncludePath (value, sshDir) {
  let text = String(value)
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2))
  return isAbsolute(text) ? text : resolve(sshDir, text)
}

/**
 * Expand one glob into the files it names, in a deterministic order.
 *
 * Deliberately a small, explicit implementation rather than `node:fs.glob`
 * (which is still experimental) and rather than a dependency: the supported
 * subset is `*`, `?` and `[...]` inside ONE path segment, which is what ssh
 * configurations actually use. `**` is NOT supported and is treated as a
 * literal, so a pattern relying on it matches nothing instead of silently
 * expanding to a depth the reader did not ask for.
 *
 */
export function expandGlob (pattern) {
  // Fast path: no glob characters at all.
  if (!/[*?[]/u.test(pattern)) return existsSync(pattern) ? [pattern] : []
  const segments = pattern.split(sep)
  // Walk from the root, expanding one segment at a time. Leading empty
  // segments come from an absolute path.
  let candidates = [segments[0] === '' ? sep : segments[0]]
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === '') continue
    if (!/[*?[]/u.test(segment)) {
      candidates = candidates.map(base => join(base, segment))
      continue
    }
    const regex = globSegmentToRegExp(segment)
    const next = []
    for (const base of candidates) {
      let entries
      try {
        if (!statSync(base).isDirectory()) continue
        entries = readdirSync(base)
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        if (regex.test(entry)) next.push(join(base, entry))
      }
    }
    candidates = next
  }
  // Only regular files: an Include that names a directory would otherwise be
  // read as if it were text, producing a parser error that points at the wrong
  // place.
  return candidates.filter((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

/**
 * Translate ONE glob segment (`*`, `?`, `[...]`) into a regular expression.
 *
 */
function globSegmentToRegExp (segment) {
  let source = ''
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (char === '*') { source += '.*'; continue }
    if (char === '?') { source += '.'; continue }
    if (char === '[') {
      const close = segment.indexOf(']', index + 1)
      if (close > index + 1) {
        const body = segment.slice(index + 1, close)
        // A leading `!` in a bracket expression negates, as in a shell.
        source += body.startsWith('!') ? `[^${escapeRegExp(body.slice(1))}]` : `[${body}]`
        index = close
        continue
      }
    }
    source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`, 'u')
}

/**
 * Read a config file with every `Include` expanded in place.
 *
 * The return value is TEXT, not sections, on purpose: inserting the included
 * files' lines at the directive's position is what makes the resulting section
 * order — and therefore "which value wins" — identical to OpenSSH's. Returning
 * a list of files and letting the caller concatenate them would put every
 * included block AFTER the including file, which silently inverts precedence.
 *
 * @param {string} [options.sshDir] - directory relative includes resolve against.
 * `problems` records four kinds: `missing` (an include naming a file that is
 * not there), `no-match` (a glob that expanded to nothing), `unreadable`, and
 * the two that a reader can act on — `cycle` (a file includes one of its own
 * ancestors) and `duplicate` (the same file reached twice, which would splice
 * its blocks in twice).
 *
 * @throws {Error} when the CONFIG FILE ITSELF cannot be read (an included file
 *   that cannot be read is recorded in `problems` instead: one is the caller's
 *   subject, the other is a property of the configuration).
 */
export function readConfigWithIncludes (configPath, options = {}) {
  const maxDepth = typeof options.maxDepth === 'number' && options.maxDepth > 0 ? options.maxDepth : MAX_INCLUDE_DEPTH
  const sshDir = typeof options.sshDir === 'string' && options.sshDir !== '' ? options.sshDir : dirname(configPath)
  /** @type {string[]} */
  const files = []
  /** @type {Array<{kind: string, detail: string}>} */
  const problems = []
  /**
   * Real paths on the CURRENT include stack: an ancestor being re-entered.
   *
   * @type {Set<string>}
   */
  const onStack = new Set()
  /**
   * Real paths already expanded ANYWHERE.
   *
   * Separate from `onStack` because the two catch different mistakes. A file
   * that includes one of its own ancestors is an infinite walk, and stopping it
   * is about termination. A file included twice by SIBLINGS — `Include conf.d/*`
   * plus an explicit `Include conf.d/web.conf`, or the same file reached once
   * directly and once through a symlink — terminates on its own but produces two
   * copies of the same block. First-wins means the duplicate changes nothing,
   * so the only symptom is that the diagnosis is unavailable: the user sees a
   * host whose settings they cannot explain, and no message says why.
   *
   * @type {Set<string>}
   */
  const visited = new Set()

  /**
   * Read one file, expanding includes.
   *
   */
  function read (file, depth, topLevel = false) {
    let canonical
    try {
      // `realpathSync` is what makes cycle detection work through a symlink:
      // two different paths to the same file are the same file, and comparing
      // the written paths would miss exactly that case.
      canonical = realpathSync(file)
    } catch (error) {
      // The TOP-LEVEL file is the one the caller asked for. Failing to read it
      // is a real error and must reach them — degrading it to '' is precisely
      // how "your config is unreadable" became "you have no hosts". An INCLUDED
      // file is different: a stale `Include conf.d/*` naming a file that has
      // since been deleted is a fact about the config, not a failure of this
      // call, so it stays a recorded problem.
      if (topLevel) throw error
      problems.push({ kind: 'missing', detail: file })
      return ''
    }
    if (onStack.has(canonical)) {
      problems.push({ kind: 'cycle', detail: file })
      return ''
    }
    if (visited.has(canonical)) {
      // Not a loop, but still a mistake: the same block would appear twice.
      problems.push({ kind: 'duplicate', detail: file })
      return ''
    }
    if (depth > maxDepth) {
      problems.push({ kind: 'too-deep', detail: file })
      return ''
    }
    let text
    try {
      text = readFileSync(canonical, 'utf8')
    } catch (error) {
      if (topLevel) throw error
      problems.push({ kind: 'unreadable', detail: `${file}: ${error instanceof Error ? error.message : String(error)}` })
      return ''
    }
    files.push(file)
    onStack.add(canonical)
    visited.add(canonical)
    try {
      const lines = text.split(/\r?\n/u)
      const out = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!/^include\s/iu.test(trimmed)) {
          out.push(line)
          continue
        }
        const value = trimmed.replace(/^include\s+/iu, '').trim()
        if (value === '') continue
        // Quote-stripping: OpenSSH accepts `Include "~/.ssh/conf.d/*"`.
        const args = value.match(/"[^"]*"|\S+/gu) ?? []
        for (const rawArg of args) {
          const arg = rawArg.replace(/^"|"$/gu, '')
          const pattern = resolveIncludePath(arg, sshDir)
          const matched = expandGlob(pattern)
          if (matched.length === 0) {
            // Not an error, per OpenSSH: `Include conf.d/*` with an empty
            // directory is the normal state of a fresh machine.
            problems.push({ kind: 'no-match', detail: pattern })
            continue
          }
          for (const included of matched) out.push(read(included, depth + 1))
        }
      }
      return out.join('\n')
    } finally {
      onStack.delete(canonical)
    }
  }

  // A config that does not exist is the normal first-run state, not a failure.
  if (!existsSync(configPath)) return { text: '', files: [], problems }
  // `topLevel: true` propagates an unreadable file to the caller; everything
  // below it degrades to a recorded problem.
  return { text: read(configPath, 0, true), files, problems }
}

// ---------------------------------------------------------------------------
// Jump chains: parsing `ProxyJump` into hops this engine can build
// ---------------------------------------------------------------------------

/** OpenSSH accepts at most this many hops (`-J a,b,c`); we match it. */
export const MAX_JUMPS = 8

/**
 * One hop in a parsed chain.
 *
 * @typedef {object} JumpHop
 * @property {string} [user] - explicit `user@`, absent when inherited.
 * @property {string} host - the host or alias to resolve.
 * @property {number} [port] - explicit `:port`, absent when inherited.
 *
 * An absent field comes from the RESOLVED host entry, never from a default:
 * `ProxyJump bastion` names a host whose port lives in the store or in
 * `~/.ssh/config`, and inventing 22 dials a port the user never mentioned. That
 * is not a cosmetic default — it is the difference between a working chain and
 * `ECONNREFUSED` against a machine nobody configured.
 */

/**
 * Parse one hop token (`[user@]host[:port]`).
 *
 * OpenSSH writes an IPv6 literal in brackets (`[::1]:22`); the brackets are
 * part of the SYNTAX, not of the address, so they are stripped here rather than
 * left for the resolver to misread as a hostname.
 *
 * @param {string} token - one comma-separated element.
 * @returns {JumpHop | undefined} the hop, or undefined when the token is empty.
 * @throws {Error} when the port or the shape is not parseable.
 */
export function parseHop (token) {
  const text = String(token).trim()
  if (text === '') return undefined
  let user
  let rest = text
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
    if (user === '') throw new Error(`invalid jump hop ${JSON.stringify(text)}: the user part is empty`)
  }
  let host = rest
  /** @type {number | undefined} */
  let port
  // An IPv6 literal keeps its colons inside brackets; split on the LAST colon
  // only when it is not inside them.
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/u.exec(rest)
  if (bracket !== null) {
    host = bracket[1]
    if (bracket[2] !== undefined) port = Number.parseInt(bracket[2], 10)
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon >= 0) {
      host = rest.slice(0, colon)
      const portText = rest.slice(colon + 1)
      if (!/^\d+$/u.test(portText)) {
        throw new Error(`invalid jump hop ${JSON.stringify(text)}: ${JSON.stringify(portText)} is not a port number`)
      }
      port = Number.parseInt(portText, 10)
    }
  }
  if (host === '') throw new Error(`invalid jump hop ${JSON.stringify(text)}: the host part is empty`)
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw new Error(`invalid jump hop ${JSON.stringify(text)}: port ${port} is out of range`)
  }
  return { host, ...(port === undefined ? {} : { port }), ...(user === undefined ? {} : { user }) }
}

/**
 * Parse a `ProxyJump` value into the chain this engine should build.
 *
 * The three shapes OpenSSH accepts all mean the same thing:
 *
 *   - `ProxyJump none` (any case) - no proxy, connect directly. This is an
 *     explicit instruction, and the common idiom is a `Host *` jump host
 *     cancelled per host, so treating it as "no value" would connect through
 *     the bastion the user just turned off.
 *   - `ProxyJump a` - one hop.
 *   - `ProxyJump a,b` - several, applied in order.
 *
 * @throws {Error} when the value is malformed, too long, or self-referential.
 */
export function parseJumpChain (value) {
  if (value === undefined || value === null) return { kind: 'direct' }
  // A store entry keeps an ARRAY; ssh-config keeps the raw STRING. Accepting
  // only one of the two is exactly how a jump host once got read as "none".
  const tokens = Array.isArray(value)
    ? value.flatMap(item => String(item).split(','))
    : String(value).split(',')
  const trimmed = tokens.map(token => token.trim()).filter(token => token !== '')
  if (trimmed.length === 0) return { kind: 'direct' }
  if (trimmed.length === 1 && trimmed[0].toLowerCase() === 'none') return { kind: 'direct' }
  if (trimmed.length > MAX_JUMPS) {
    throw new Error(`ProxyJump lists ${trimmed.length} hops, more than the ${MAX_JUMPS} this plugin supports`)
  }
  /** @type {JumpHop[]} */
  const hops = []
  for (const token of trimmed) {
    // `none` mixed into a chain is not a hop, and silently skipping it would
    // change the route without saying so.
    if (token.toLowerCase() === 'none') {
      throw new Error('ProxyJump mixes `none` into a list of hops; `none` must be the whole value')
    }
    const hop = parseHop(token)
    if (hop !== undefined) hops.push(hop)
  }
  if (hops.length === 0) return { kind: 'direct' }
  return { kind: 'chain', hops }
}

/**
 * Check a parsed chain against the alias it is being used for.
 *
 * Two refusals, both for the same reason — a chain that repeats itself cannot
 * terminate, and one that names its own target is a configuration mistake whose
 * only honest report is an error:
 *
 *   - a self-reference (`web` jumping through `web`);
 *   - a duplicate hop (`a,a`), which would authenticate twice for one link.
 *
 * The last hop being the target itself is NOT a duplicate of the target check:
 * `ssh -J bastion bastion` is legitimate and is how a user reaches a host they
 * can only enter through itself in another role.
 *
 */
export function checkJumpChain (chain, alias) {
  if (chain?.kind !== 'chain') return { ok: true }
  const target = String(alias).toLowerCase()
  const seen = new Set()
  for (const hop of chain.hops) {
    // Keyed on the HOST alone: `a` and `a:22` name the same machine, and a
    // check that let both through would authenticate twice for one link.
    const key = hop.host.toLowerCase()
    if (hop.host.toLowerCase() === target) {
      return { ok: false, error: `host ${JSON.stringify(alias)} lists itself as a ProxyJump hop, which cannot terminate` }
    }
    if (seen.has(key)) {
      return { ok: false, error: `host ${JSON.stringify(alias)} lists ${JSON.stringify(hop.host)} twice in its ProxyJump chain` }
    }
    seen.add(key)
  }
  return { ok: true }
}

/**
 * A one-line description of a chain, for diagnostics and the panel.
 *
 */
export function describeChain (chain) {
  if (chain?.kind !== 'chain' || chain.hops === undefined || chain.hops.length === 0) return 'direct connection'
  const hops = chain.hops.map(hop => `${hop.user === undefined ? '' : `${hop.user}@`}${hop.host}${hop.port === undefined ? '' : `:${hop.port}`}`)
  return `via ${hops.join(' → ')}`
}

// ---------------------------------------------------------------------------
// The records: the editable store first, OpenSSH config as fallback
// ---------------------------------------------------------------------------

/**
 * The config file's text, with every `Include` expanded in place.
 *
 * Real configs put a few lines in `~/.ssh/config` and the rest in `conf.d/*.conf`;
 * a reader that does not follow `Include` sees an almost empty file. Before this
 * the audit reported `Include` as `lost` and every host in an included file did
 * not exist — the user's own config listed hosts the panel had never heard of.
 *
 * Expansion happens BEFORE sections are computed, as a text splice not a file
 * list: OpenSSH precedence is first-value-wins across the merged text, so
 * appending included files would invert which block wins (see the `Include`
 * section at the top).
 *
 * Failures are not thrown: unreadable config has a `storeError` path, and an
 * unfollowable include is a property of the config, not an error here.
 *
 * @returns {string} the expanded text, or '' when unreadable.
 */
export function configTextOf (file) {
  try {
    return readConfigWithIncludes(file).text
  } catch {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
}

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
 * parser. `Include` is not followed and `Match` blocks are not evaluated rather
 * than mis-resolved.
 *
 * ## Why `Match` must END the block, not be skipped in place
 *
 * This used to reset `inBlock` only on a `Host` line, so a `Match` body kept the
 * previous `Host`'s selection state and its keywords were collected as that
 * host's. `Match host db` after `Host web` handed `web` the `User`, `Port` and
 * `IdentityFile` written for `db`: the host name stayed right while the
 * credentials came from another machine. The section rule now lives in
 * ssh-config.js, shared with the proxy scanner and the audit, so "which block is
 * this line in" has exactly one answer.
 *
 */
function readSshConfigBlock (file, alias) {
  if (!existsSync(file)) return {}
  const props = {}
  for (const section of sectionsOf(configTextOf(file))) {
    // Identity keywords come only from a block that names the alias LITERALLY:
    // a wildcard block would otherwise rewrite a host's identity from `Host *`,
    // which this plugin has never done. What that costs is reported by the
    // audit (see report.js), not silently adopted here.
    if (!isExact(section, alias)) continue
    for (const { keyword, value } of section.entries) {
      // First wins, per OpenSSH.
      if (!(keyword in props)) props[keyword] = value
    }
  }
  return props
}

/**
 * Collect the proxy-transport keywords that apply to one alias.
 *
 * A separate scan because `readSshConfigBlock` reads only an EXACT `Host <alias>`
 * block, so a `Host *` never contributes identity (`HostName`, `User`,
 * `IdentityFile` stay as written). But proxy transport is not identity: `Host *`
 * is where a jump host is normally declared, and `ProxyJump bastion` there
 * applies to every host. Ignoring wildcards turned "reach via bastion" into
 * "connect directly" — the same silent, unsafe downgrade as the exact-match
 * shape bug, one level out.
 *
 * OpenSSH uses first-value-wins across matching blocks in file order: earlier
 * wins (a top `Host *` outranks a later specific block), a later `ProxyJump none`
 * cancels it, and `!name` excludes the alias — all replicated here.
 *
 * `Match` sections are never scanned (conditions are not evaluated): the
 * security-critical half of O-17 — a `ProxyJump none` under `Match host db` used
 * to cancel the `Host *` bastion for an unrelated host.
 *
 */
function readSshConfigProxy (file, alias) {
  if (!existsSync(file)) return {}
  /** @type {{proxyjump?: string, proxycommand?: string}} */
  const props = {}
  for (const section of sectionsOf(configTextOf(file))) {
    if (!selects(section, alias)) continue
    for (const { keyword, value } of section.entries) {
      if (keyword !== 'proxyjump' && keyword !== 'proxycommand') continue
      // First wins, per OpenSSH — over wildcard blocks as well as exact ones.
      if (!(keyword in props)) props[keyword] = value
    }
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
 * @returns {boolean} true only for an explicit `yes`.
 */
function configYes (value) {
  return String(value ?? '').trim().toLowerCase() === 'yes'
}

/**
 * Turn a store entry into a connect descriptor.
 *
 * @param {{password?: string, passphrase?: string}} [secret] - the entry's decrypted secret, when the store holds one.
 * @throws {Error} when the entry needs a transport this engine cannot honor.
 */
function storeDescriptor (entry, secret) {
  // `ProxyCommand` stays refused: it is arbitrary local command execution, and
  // a config file that can arrive from a repository must not become one.
  // `ProxyJump` is now built for real (see `jumpChain`).
  if (needsProxyTransport([], entry.proxyCommand)) {
    throw new Error(`host ${JSON.stringify(entry.alias)} is configured with a ProxyCommand, which dsh-ssh-workspace will not run — it is arbitrary local command execution. Use ProxyJump instead, or remove it`)
  }
  const jump = parseJumpChain(entry.proxyJump)
  const jumpVerdict = checkJumpChain(jump, entry.alias)
  if (jumpVerdict.ok !== true) throw new Error(jumpVerdict.error)
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
    jump,
    source: 'store',
  }
}

/**
 * The host store: editable records from the shared dsh-ssh.json store plus
 * read-only fallback records parsed from ~/.ssh/config.
 */
export class HostStore {
  constructor (configPath, entryStore) {
    this.configPath = configPath ?? sshConfigPath()
    this.entryStore = entryStore ?? new HostConfigStore()
  }

  /**
   * A fingerprint of the OpenSSH config file, for detecting an edit.
   *
   * ## Why this exists
   *
   * `resolve()` already re-reads the file on every call, so a host ADDED or
   * EDITED through the panel is picked up immediately — the save route even
   * calls `engine.forget(alias)` to drop the stale socket. The gap is the user
   * who edits `~/.ssh/config` in an editor: nothing tells the engine, so the
   * pooled connection keeps using the descriptor it read at connect time. The
   * user changes `Port 22` to `Port 2222`, the panel still shows the old
   * session, and the only cure is toggling the workspace or restarting.
   *
   * An engine cannot watch every file a deployment might consult, and hashing
   * one small file per operation is cheap next to a network round trip.
   *
   * ## Why the CONTENT, not mtime and size
   *
   * The first version of this used `ino:size:mtimeMs`, reasoning that mtime
   * catches an edit and `ino` catches an editor's write-temp-then-rename. Both
   * halves were measured wrong on NTFS: an in-place same-length rewrite left
   * `ino` unchanged AND `mtimeMs` identical to the microsecond, because the
   * write landed within the filesystem's timestamp tick. The test that caught
   * it asserted the edit WOULD be seen, and it was not — a stale connection
   * surviving exactly the edit it was supposed to catch.
   *
   * Stat metadata is a cache of "probably unchanged", not a proof. A config
   * file is a few kilobytes and is already read once per `resolve()`, so the
   * honest answer is to hash it and stop guessing. The hash also covers the
   * cases stat-only schemes miss for free: a rewrite that restores the original
   * size, an edit inside one mtime tick, and a file replaced by another with
   * the same metadata.
   *
   * @returns {string} a stamp that changes whenever the file's bytes change.
   */
  configStamp () {
    try {
      return createHash('sha256').update(readFileSync(this.configPath)).digest('hex')
    } catch {
      // A missing config is a stable state, not an error: hosts from the
      // editable store never read this file, and "no file" must compare equal
      // to "no file" or every acquire would reconnect.
      return 'absent'
    }
  }

  /**
   * One entry from the editable store, when present. Read failures degrade to
   * "no entry" so a malformed store file never blocks ssh-config hosts.
   *
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
   */
  rememberHostKey (alias, record) {
    this.entryStore.rememberHostKey(alias, record)
  }

  /**
   * Drop the recorded host key for one alias.
   *
   * @returns {boolean} whether a record was removed.
   */
  forgetHostKey (alias) {
    return this.entryStore.forgetHostKey(alias)
  }

  /**
   * Resolve one host to a connect configuration. The editable store wins;
   * ~/.ssh/config is the fallback for aliases the store does not define.
   *
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
    if (needsProxyTransport([], proxy.proxycommand)) {
      throw new Error(`host ${JSON.stringify(alias)} is configured with a ProxyCommand, which dsh-ssh-workspace will not run — it is arbitrary local command execution. Use ProxyJump instead, or remove it from ${this.configPath}`)
    }
    const jump = parseJumpChain(proxy.proxyjump)
    const jumpVerdict = checkJumpChain(jump, alias)
    if (jumpVerdict.ok !== true) throw new Error(jumpVerdict.error)
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
      jump,
      source: 'ssh-config',
    }
  }

  /**
   * The descriptor an editor payload WOULD connect with, without saving it.
   *
   * The host form's 「测试」 button answers about the fields on screen, and those
   * are not in the store yet: testing by alias would describe the address that
   * is SAVED, and "save first, then test" is exactly what the button exists to
   * avoid. So this builds the same descriptor `save` → `resolve` would build,
   * from the same payload shape, minus the write.
   *
   * A blank secret means "keep the stored one", exactly as it does on save —
   * which is why `originalAlias` matters: an empty password box in edit mode is
   * not a host without a password.
   *
   * @param {object} form - the editor payload (`alias` … `compress`).
   * @returns {object} a descriptor for `engine.probeDescriptor`.
   * @throws {Error} when the payload names a transport or credential this engine cannot honor.
   */
  descriptorForForm (form) {
    const auth = form?.auth !== null && typeof form?.auth === 'object' ? form.auth : { kind: 'agent' }
    const entry = {
      // An unsaved host has no alias yet. The descriptor only uses it in error
      // messages, so a placeholder is honest — and it never becomes a record.
      alias: String(form?.alias ?? '').trim() || '(unsaved host)',
      host: String(form?.host ?? '').trim(),
      port: Number.isInteger(form?.port) ? form.port : 22,
      user: String(form?.user ?? '').trim(),
      auth,
      agentForward: form?.agentForward === true,
      compress: form?.compress === true,
      // The editor has no jump-host field; an empty chain is what it means.
      proxyJump: [],
    }
    const posted = {
      ...(typeof auth.password === 'string' && auth.password !== '' ? { password: auth.password } : {}),
      ...(typeof auth.passphrase === 'string' && auth.passphrase !== '' ? { passphrase: auth.passphrase } : {}),
    }
    const originalAlias = typeof form?.originalAlias === 'string' ? form.originalAlias.trim() : ''
    const stored = originalAlias === ''
      ? undefined
      : (() => {
          try {
            return this.entryStore?.secretFor?.(originalAlias) ?? undefined
          } catch {
            // An unreadable secret is the store's failure, and the probe will
            // report the same "no password" the real connect would. Not a
            // reason to refuse to build the descriptor.
            return undefined
          }
        })()
    return storeDescriptor(entry, { ...stored, ...posted })
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
   */
  listing () {
    const rows = []
    const skipped = []
    const shadowed = new Set()
    // Read once, not per row: this is a small map and a listing can hold
    // hundreds of hosts.
    const recent = (() => {
      try {
        return this.entryStore?.recentHosts?.() ?? {}
      } catch {
        return {}
      }
    })()
    // Read once for the same reason, and for one more: a store row has to
    // report whether the SAME alias is also defined in ~/.ssh/config. That is
    // what makes it non-editable in the panel — deleting the store record would
    // only fall back to the Host block (the host "comes back"), and editing it
    // would shadow what every other ssh client on this machine resolves.
    //
    // Read AFTER the store: `#storeEntries` clears `storeError` before loading,
    // so calling this first would let a broken ssh config be recorded and then
    // wiped — the unreadable-config report this very field exists for.
    const entries = this.#storeEntries(skipped)
    const configAliases = new Set(this.sshConfigAliases())
    for (const entry of entries) {
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
          // Whether the panel's power switch is on. Always spelled out for a
          // store row, because the switch needs "the value the store holds" —
          // absent means on, and a card must not have to guess that.
          enabled: entry.enabled !== false,
          // Present only when this alias ALSO has a Host block in
          // ~/.ssh/config: the panel uses it to keep edit/delete off a record
          // it would only half-own. Absent (not `false`) keeps the row shape
          // small, and "no key" already means "not shadowed".
          ...(configAliases.has(resolved.alias) ? { configAlias: true } : {}),
          // Omitted rather than set to `undefined`: a key that EXISTS with an
          // undefined value is not representable in JSON at all, so the Host
          // rejects the whole result as "not lossless JSON" before it can check
          // any property. Absence and "no description" mean the same thing to a
          // reader, so absence is the honest encoding.
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
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
    for (const alias of configAliases) {
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
          // The same field the store branch spells out, because the panel's
          // switch renders for every card now. For a config host the value
          // comes from the document-level `disabledAliases` list — this plugin
          // cannot put a flag into ~/.ssh/config and does not try.
          enabled: this.entryStore?.isHostEnabled?.(alias) !== false,
          // Absent, not `undefined`: see the store branch above.
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
    // Attach the timestamp here rather than in each row literal: the two row
    // shapes (store and ssh-config) are built in different places and a field
    // added to one of them would silently be missing from the other.
    for (const row of rows) {
      const at = recent[row.alias]
      if (typeof at === 'number' && Number.isFinite(at)) row.lastUsedAt = at
    }
    // Recent first, then never-used hosts in file order. `sort` is stable, so
    // equal timestamps keep the order the files declared — which is the order
    // the user wrote, and the only other thing they might expect.
    rows.sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0))
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
   */
  configAudit (alias) {
    const text = configTextOf(this.configPath)
    if (text === '') return []
    try {
      return auditConfigText(text, alias)
    } catch {
      return []
    }
  }

  /**
   * The same rows, for callers that only want the list.
   *
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
   */
  sshConfigAliases () {
    if (!existsSync(this.configPath)) return []
    let text
    try {
      // NOT `configTextOf`: that helper degrades to '' on any failure, and this
      // is the one caller whose job is to REPORT the failure. Swallowing it here
      // turned "your config is unreadable" into "you have no hosts" — the exact
      // empty-vs-unreadable conflation the storeError field exists to fix.
      text = readConfigWithIncludes(this.configPath).text
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
