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
 * ## Why the section rule is imported, not re-implemented
 *
 * This module used to carry its own copy of the `Host` matching loop. It agreed
 * with the resolver on wildcards and disagreed on `Match`, so the audit and the
 * resolver could describe different blocks of the same file. The boundary now
 * comes from ssh-config.js — the same one the resolver reads — so "which block
 * is this line in" has one answer for every consumer.
 *
 * @module @shiqyka/dsh-ssh-workspace/config-audit
 */

import { isExact, sectionsOf, selects } from './ssh-config.js'

/**
 * Keywords the plugin actually acts on, from any block that selects the host.
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
  // `proxyjump` is BUILT now (lib/jump-chain.js, lib/engine.js): the chain is
  // part of the descriptor, each hop authenticates and pins its own key. It is
  // listed here because the resolver really does read it.
  'proxyjump',
  // `proxycommand` is read only to REFUSE the host: it is arbitrary local
  // command execution, and a config file can arrive from a repository. Listed
  // as supported so the audit does not report it twice — the refusal is the
  // report.
  'proxycommand',
  'password',
  // `Include` is FOLLOWED now (lib/include-chain.js), so it is adopted rather
  // than reported as lost: hosts defined in an included file are real hosts.
  'include',
]))

/**
 * Keywords the resolver adopts ONLY from an exact `Host <alias>` block.
 *
 * These are supported — the resolver really does read them — but a copy sitting
 * in `Host *` never reaches a host's identity, because identity is deliberately
 * exact-only. Reporting such a line as "supported, nothing to say" was the O-18
 * gap: the parser did not adopt it and the audit did not mention it either, so
 * a user connecting as the wrong user had no way to find out why.
 *
 * @type {ReadonlySet<string>}
 */
export const EXACT_ONLY_KEYWORDS = Object.freeze(new Set([
  'hostname',
  'user',
  'port',
  'identityfile',
  'identityagent',
  'forwardagent',
  'compression',
  'password',
  // NOT `proxyjump`: it is read from every matching block (a `Host *` bastion
  // applies to everyone), so a wildcard copy is not inert.
]))

/**
 * The sentence for a keyword the resolver adopts only from an exact block.
 *
 * @type {string}
 */
const EXACT_ONLY_DETAIL = 'read only from an exact `Host <alias>` block, so this line in a wildcard block has no effect'

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
 * ## Every key is lowercase and hyphen-free
 *
 * {@link verdictFor} is looked up with the keyword the config parser produced,
 * which is always lowercase and can only contain `[a-z0-9]` (see `CONFIG_LINE`
 * in ssh-config.js). Two keys used to violate that — `addkeysToagent` and
 * `strictHostKeyChecking` — so their hand-written sentences were unreachable
 * and silently degraded to the generic fallback, and a third
 * (`strict-host-key-checking`) could never be matched by the parser at all.
 * The vocabulary test now walks this table and fails on any key `verdictFor`
 * cannot reach, so the next misspelling is caught rather than shipped.
 *
 * @type {Readonly<Record<string, {verdict: Verdict, detail: string}>>}
 */
export const KNOWN_UNSUPPORTED = Object.freeze({
  // ---- would change where the connection goes
  proxycommand: { verdict: 'refused', detail: 'ProxyCommand is not supported; the host is refused rather than connected directly' },
  canonicalizehostname: { verdict: 'lost', detail: 'host-name canonicalisation is not applied, so the HostName is used exactly as written' },
  hostkeyalias: { verdict: 'lost', detail: 'the host key is recorded under the alias, not the HostKeyAlias' },
  // ---- would change how the connection is authenticated
  certificatefile: { verdict: 'lost', detail: 'certificate authentication is not used; only key, password and agent are' },
  identitiesonly: { verdict: 'ignored', detail: 'the agent offers every key it holds, not only the listed ones' },
  addkeystoagent: { verdict: 'ignored', detail: 'keys are never added to the agent by this plugin' },
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
  match: { verdict: 'lost', detail: 'Match blocks are not evaluated; their settings never apply' },
  // ---- harmless here
  loglevel: { verdict: 'ignored', detail: 'the plugin has its own diagnostics ring' },
  requesttty: { verdict: 'ignored', detail: 'a PTY is requested per call, not per host' },
  setenv: { verdict: 'ignored', detail: 'environment variables are sent per command by the shell tools, not from this file' },
  stricthostkeychecking: { verdict: 'ignored', detail: 'this plugin always verifies the host key (trust on first use, then pinned)' },
  userknownhostsfile: { verdict: 'ignored', detail: 'known hosts are recorded in the DSH host store, not in this file' },
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
 * Follows the same section rule the resolver does — every `Host` block that
 * selects the alias, wildcards included, first value wins — so the audit reports
 * exactly the lines that WOULD have applied. Reporting a keyword from a block
 * that does not select the alias would be noise, and reporting only the exact
 * block would miss the `Host *` case that matters most (`LocalForward` is almost
 * always declared in a catch-all block).
 *
 * ## Two different reasons a line has no effect
 *
 *  - the plugin does not read the keyword at all → its `KNOWN_UNSUPPORTED`
 *    verdict (`lost` / `refused` / `ignored`);
 *  - the plugin reads it, but only from an exact block, and this line is in a
 *    wildcard block → `lost`, with {@link EXACT_ONLY_DETAIL}.
 *
 * The second case is why the audit consults {@link isExact} rather than only
 * {@link SUPPORTED_KEYWORDS}: "supported" is a property of the keyword, while
 * "adopted for this host" is a property of the line's section.
 *
 * `Match` bodies are skipped entirely: their conditions are not evaluated, so
 * nothing inside them applies to anyone — reporting them as adopted would be
 * the mirror of the bug that used to merge them into the previous `Host`.
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
  for (const section of sectionsOf(text)) {
    if (!selects(section, alias)) continue
    // `Match` never selects anyone (see ssh-config.js), so this guard is
    // belt-and-braces: it keeps a future change to `selects` from quietly
    // making un-evaluated conditions count as adopted.
    if (section.kind === 'match') continue
    const exact = isExact(section, alias)
    for (const { keyword, value } of section.entries) {
      if (seen.has(keyword)) continue
      const supported = SUPPORTED_KEYWORDS.has(keyword)
      // A supported keyword in an exact block really is adopted: nothing to say.
      if (supported && exact) continue
      // A supported keyword that is NOT exact-only (ProxyJump, ProxyCommand)
      // is read from every matching block, so a wildcard copy does apply.
      if (supported && !EXACT_ONLY_KEYWORDS.has(keyword)) continue
      seen.add(keyword)
      const verdict = supported
        ? { verdict: /** @type {Verdict} */ ('lost'), detail: EXACT_ONLY_DETAIL }
        : verdictFor(keyword)
      entries.push({
        keyword,
        // Values can be long (a ProxyCommand, a path); the audit is a summary and
        // the user can read their own file for the rest.
        value: value.length > 80 ? `${value.slice(0, 77)}...` : value,
        verdict: verdict.verdict,
        detail: verdict.detail,
      })
    }
  }
  return entries
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
