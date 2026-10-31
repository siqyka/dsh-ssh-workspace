/**
 * What this plugin reads out of `~/.ssh/config`, and what it deliberately does
 * not — reported per host instead of silently dropped.
 *
 * ## Why an audit instead of a bigger parser
 *
 * The plugin reads an OpenSSH config as a FALLBACK so an already-configured
 * machine needs no duplication. It does not try to be OpenSSH: `Include`,
 * `Match`, `ProxyCommand`, `CanonicalizeHostname` and the whole forwarding
 * family are out of scope, and implementing them would mean reimplementing a
 * client — a much larger surface than the feature needs, with a much worse
 * failure mode (a wrong parse looks exactly like a right one).
 *
 * The problem was never "unsupported" — it was "unsupported and invisible". A
 * user whose config says `ProxyJump bastion` got a host row that connected
 * DIRECTLY, or a host that vanished from the list with a reason buried in
 * `skipped`. A user whose config says `LocalForward 5432 localhost:5432`
 * expected a tunnel and got none, with no sentence anywhere.
 *
 * So the answer is not a bigger parser. It is an honest declaration: this table
 * names every keyword the plugin acts on, and everything else is reported with
 * what it means for the user — ignored, or actively refused.
 *
 * ## Three verdicts, because the consequences differ
 *
 *  - `ignored`   — the plugin does not read it, and nothing breaks. A different
 *                  keepalive interval, a log level, a `ServerAliveCountMax`.
 *  - `lost`      — the plugin does not read it, and a feature the user expects
 *                  is therefore missing. `LocalForward` is the archetype: no
 *                  tunnel will exist, and no error will say so.
 *  - `refused`   — the plugin cannot honour it and REFUSES the host rather
 *                  than connecting in a way the user did not ask for.
 *                  `ProxyJump` and `ProxyCommand` are the archetypes: connecting
 *                  around a bastion is both wrong and unsafe.
 *
 * Collapsing `lost` into `ignored` is how "my port forward never worked" stays
 * unattributable; collapsing `refused` into `ignored` is how a host connects
 * around its bastion.
 *
 * @module @shiqyka/dsh-ssh-workspace/config-audit
 */

/**
 * Keywords the plugin actually acts on.
 *
 * Anything outside this set is audited rather than applied. The set is
 * deliberately small and matches what `hosts.js` reads, so a keyword added to
 * the resolver without being added here shows up as a false `ignored` — which
 * the contract suite catches, because it asserts the two lists against the
 * source that reads them.
 *
 * @type {ReadonlySet<string>}
 */
export const SUPPORTED_KEYWORDS = Object.freeze(new Set([
  'hostname',
  'user',
  'port',
  'identityfile',
  'identityagent',
  'forwardagent',
  'compression',
  // Read only to REFUSE the host: a proxy transport is not honoured (see
  // needsProxyTransport in hosts.js). Listed as supported so the audit does not
  // report it twice — the refusal itself is the report.
  'proxyjump',
  'proxycommand',
  'password',
]))

/**
 * How a keyword the plugin does not act on affects the user.
 *
 * @typedef {'ignored'|'lost'|'refused'} Verdict
 */

/**
 * The keywords worth a sentence, with the sentence.
 *
 * A keyword that is not listed here and not in {@link SUPPORTED_KEYWORDS} is
 * reported as `ignored` with a generic line: the audit must cover everything,
 * but only the interesting entries deserve hand-written prose.
 *
 * @type {Readonly<Record<string, {verdict: Verdict, detail: string}>>}
 */
export const KNOWN_UNSUPPORTED = Object.freeze({
  // ---- would change where the connection goes
  proxyjump: { verdict: 'refused', detail: 'a jump host is not supported; the host is refused rather than connected directly' },
  proxycommand: { verdict: 'refused', detail: 'ProxyCommand is not supported; the host is refused rather than connected directly' },
  canonicalizehostname: { verdict: 'lost', detail: 'host-name canonicalisation is not applied, so the HostName is used exactly as written' },
  hostkeyalias: { verdict: 'lost', detail: 'the host key is recorded under the alias, not the HostKeyAlias' },
  // ---- would change how the connection is authenticated
  certificatefile: { verdict: 'lost', detail: 'certificate authentication is not used; only key, password and agent are' },
  identitiesonly: { verdict: 'ignored', detail: 'the agent offers every key it holds, not only the listed ones' },
  addkeysToagent: { verdict: 'ignored', detail: 'keys are never added to the agent by this plugin' },
  pkcs11provider: { verdict: 'lost', detail: 'PKCS#11 / smartcard keys are not supported' },
  // ---- would change the tunnel behaviour the user expects
  localforward: { verdict: 'lost', detail: 'no local tunnel is created; use the panel\'s port-forwarding section or the ssh_workspace_forward tool' },
  remoteforward: { verdict: 'lost', detail: 'reverse tunnels are not supported' },
  dynamicforward: { verdict: 'lost', detail: 'SOCKS forwarding is not supported' },
  // ---- would change connection lifecycle
  controlmaster: { verdict: 'ignored', detail: 'this plugin keeps its own pooled connection and does not share a control socket' },
  controlpath: { verdict: 'ignored', detail: 'see ControlMaster — no control socket is used' },
  controlpersist: { verdict: 'ignored', detail: 'see ControlMaster — no control socket is used' },
  serveraliveinterval: { verdict: 'ignored', detail: 'the plugin sets its own keepalive interval (engine option keepaliveIntervalMs)' },
  serveralivecountmax: { verdict: 'ignored', detail: 'see ServerAliveInterval' },
  connecttimeout: { verdict: 'ignored', detail: 'the plugin sets its own connect timeout (engine option connectTimeoutMs)' },
  // ---- would change what is read at all
  include: { verdict: 'lost', detail: 'Include is not followed, so hosts defined in included files are not listed' },
  match: { verdict: 'lost', detail: 'Match blocks are not evaluated; their settings never apply' },
  // ---- harmless here
  loglevel: { verdict: 'ignored', detail: 'the plugin has its own diagnostics ring' },
  requesttty: { verdict: 'ignored', detail: 'a PTY is requested per call, not per host' },
  setenv: { verdict: 'ignored', detail: 'environment variables are sent per command by the shell tools, not from this file' },
  strictHostKeyChecking: { verdict: 'ignored', detail: 'this plugin always verifies the host key (trust on first use, then pinned)' },
  userknownhostsfile: { verdict: 'ignored', detail: 'known hosts are recorded in the DSH host store, not in this file' },
  'strict-host-key-checking': { verdict: 'ignored', detail: 'this plugin always verifies the host key (trust on first use, then pinned)' },
})

/**
 * The verdict for one keyword, whether or not it is hand-listed.
 *
 * @param {string} keyword - lowercase keyword.
 * @returns {{verdict: Verdict, detail: string}} the verdict.
 */
export function verdictFor (keyword) {
  const known = KNOWN_UNSUPPORTED[keyword]
  if (known !== undefined) return known
  return {
    verdict: 'ignored',
    detail: 'not read by this plugin; it has no effect on a remote workspace',
  }
}

/**
 * One audited keyword.
 *
 * @typedef {object} AuditEntry
 * @property {string} keyword - lowercase keyword.
 * @property {string} value - the raw value, truncated.
 * @property {Verdict} verdict - what it costs.
 * @property {string} detail - one sentence.
 */

/**
 * Audit the keywords that apply to one alias.
 *
 * Follows the same matching rules the resolver does — every block that selects
 * the alias, wildcards included, first value wins — so the audit reports exactly
 * the lines that WOULD have applied. Reporting a keyword from a block that does
 * not select the alias would be noise, and reporting only the exact block would
 * miss the `Host *` case that matters most (`LocalForward` is almost always
 * declared in a catch-all block).
 *
 * A line whose keyword appears twice is reported once: the first value is the
 * one OpenSSH would use, so the second is not a separate decision.
 *
 * @param {string} text - the config file contents.
 * @param {string} alias - the alias being resolved.
 * @returns {AuditEntry[]} entries in file order, deduplicated by keyword.
 */
export function auditConfigText (text, alias) {
  const seen = new Set()
  const entries = []
  let applies = false
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9]*)[\s=]+(.+)$/u.exec(line)
    if (match === null) continue
    const [, keyword, value] = match
    const lower = keyword.toLowerCase()
    if (lower === 'host') {
      const patterns = value.trim().split(/\s+/u)
      const positive = patterns.filter(pattern => !pattern.startsWith('!'))
      const negative = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
      applies = positive.some(pattern => patternMatches(pattern, alias)) &&
        !negative.some(pattern => patternMatches(pattern, alias))
      continue
    }
    if (!applies) continue
    if (SUPPORTED_KEYWORDS.has(lower)) continue
    if (seen.has(lower)) continue
    seen.add(lower)
    const verdict = verdictFor(lower)
    entries.push({
      keyword: lower,
      // Values can be long (a ProxyCommand, a path); the audit is a summary and
      // the user can read their own file for the rest.
      value: value.length > 80 ? `${value.slice(0, 77)}...` : value,
      verdict: verdict.verdict,
      detail: verdict.detail,
    })
  }
  return entries
}

/**
 * Does one Host pattern select this alias?
 *
 * A local copy of the resolver's rule (`*` and `?` only, anchored). Kept here
 * rather than imported so this module stays dependency-free and can be tested
 * without the store — the contract suite asserts the two agree.
 *
 * @param {string} pattern - one Host pattern.
 * @param {string} alias - the alias being resolved.
 * @returns {boolean} whether the pattern selects the alias.
 */
function patternMatches (pattern, alias) {
  const source = pattern
    .split('*').map(part => part.split('?').map(escapeRegExp).join('.')).join('.*')
  return new RegExp(`^${source}$`, 'u').test(alias)
}

/** Escape a literal for embedding in a RegExp source. */
function escapeRegExp (text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * The audit's one-line summary, for the panel and the status tool.
 *
 * @param {AuditEntry[]} entries - the audit.
 * @returns {string} a sentence, or '' when there is nothing to say.
 */
export function summarizeAudit (entries) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const refused = entries.filter(entry => entry.verdict === 'refused')
  if (refused.length > 0) {
    return `${refused.map(entry => entry.keyword).join(', ')} is not supported, so this host is refused rather than connected in a way you did not ask for`
  }
  const lost = entries.filter(entry => entry.verdict === 'lost')
  if (lost.length > 0) {
    return `${lost.map(entry => entry.keyword).join(', ')} ${lost.length === 1 ? 'is' : 'are'} not applied; the settings they carry have no effect here`
  }
  return `${entries.length} keyword${entries.length === 1 ? '' : 's'} in this host's block ${entries.length === 1 ? 'is' : 'are'} ignored by this plugin`
}
