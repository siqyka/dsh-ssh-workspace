/**
 * Jump-host chains: parsing `ProxyJump` into hops this engine can build.
 *
 * ## What a jump chain is, and what it is not
 *
 * `ProxyJump bastion` means "reach the target through a TCP tunnel that leaves
 * from the bastion". OpenSSH's own implementation opens an SSH connection to
 * each hop in turn and forwards a channel toward the next one; the target sees
 * a connection from its immediate neighbour. This module reproduces exactly
 * that shape and nothing more:
 *
 *   - it NEVER builds a `ProxyCommand`, which is arbitrary local command
 *     execution. A config file is data; making the plugin run what a file says
 *     would turn "read my SSH config" into "run this program", and the file can
 *     come from a repository. `ProxyCommand` stays refused.
 *   - it does not carry one hop's credentials to the next: each hop resolves
 *     and authenticates as its own host, and each hop's host key is verified
 *     and pinned against its own record.
 *
 * ## Why the parsing lives in its own module
 *
 * The interesting failure modes are all textual — `a,b`, `user@a:2222`,
 * `none`, a trailing comma, a self-reference that would loop forever, a chain
 * that names its own target. None of them need a network to observe, and the
 * consequences are security-relevant (a chain silently collapsing to a direct
 * connection is the O-17 class of bug), so they are decided here, by a pure
 * function, and tested directly.
 *
 * @module @shiqyka/dsh-ssh-workspace/jump-chain
 */

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
 * @param {string | string[] | undefined | null} value - the keyword's value.
 * @returns {{kind: 'direct'} | {kind: 'chain', hops: JumpHop[]}} the parsed chain.
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
 * @param {{kind: string, hops?: JumpHop[]}} chain - a parsed chain.
 * @param {string} alias - the alias being connected.
 * @returns {{ok: true} | {ok: false, error: string}} the verdict.
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
 * @param {{kind: string, hops?: JumpHop[]}} chain - a parsed chain.
 * @returns {string} a human sentence.
 */
export function describeChain (chain) {
  if (chain?.kind !== 'chain' || chain.hops === undefined || chain.hops.length === 0) return 'direct connection'
  const hops = chain.hops.map(hop => `${hop.user === undefined ? '' : `${hop.user}@`}${hop.host}${hop.port === undefined ? '' : `:${hop.port}`}`)
  return `via ${hops.join(' → ')}`
}
