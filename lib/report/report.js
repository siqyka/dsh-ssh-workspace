/**
 * The diagnostic report and the judgement it carries: what is going on, and
 * whether it is wrong.
 *
 * ## The division of labour, which is the reason these are one file
 *
 * The bundle ASSEMBLES, it does not collect: every field comes from a surface
 * that already exists (`ssh_workspace_status`, the status route, the diagnostics
 * ring, the host config audit), so it cannot drift into reporting something the
 * status tool would not. What it deliberately does not do is judge — a report
 * that also decides would let the panel and the report disagree about whether
 * anything is wrong.
 *
 * `diagnose` is the judgement half, and its whole claim is that it reads ONLY
 * the fields the report is already printing: no probing, no connecting, no
 * files. Three states (`ok` / `warn` / `unknown`) that are not folded into two,
 * because "I could not tell" and "it is fine" are different facts. A certain
 * bad beats an uncertain one when aggregating.
 *
 * The config audit is the third piece: what this plugin READ out of
 * `~/.ssh/config`, what it deliberately does not support, and — the distinction
 * that matters — whether a keyword was `ignored`, `lost`, or `refused`. Those
 * three are not merged, because they call for different actions from the user.
 *
 * ## Why one file
 *
 * These were three (`support-bundle`, `diagnosis`, `config-audit`), and the split
 * had a real motive: the assembly is 350 lines of formatting and the judgement is
 * 330 lines of rules, and neither wants to be read to understand the other. But
 * the contract between them is the reason the split hurt: "the report cannot
 * report a fact the panel would deny" and "the judgement cannot invent a fact the
 * report does not print" are properties of the PAIR. Enforced across two files by
 * discipline, they are enforced here by adjacency.
 *
 * ## The self-check is ADVISORY, not a finding
 *
 * A missing `rg` is not a malfunction: the plugin degrades exactly as documented,
 * every affected tool still runs, and the user may not be able to change that
 * host at all (no root, a locked-down image). Folding it into `findings` made the
 * dot red on a perfectly healthy machine that merely lacked one optional tool,
 * which is the "too loud" failure the suites guard against. A dot that goes red
 * for a normal configuration is a dot nobody reads — and once ignored, it stops
 * carrying the facts that DO need action (an unpinned host key, a store nobody
 * can read).
 *
 * So the self-check is reported separately, in `notes`: visible, naming what
 * degrades and why, but never choosing the colour. `notes` may be `warn` /
 * `unknown` per row; the verdict counts only `findings`.
 *
 * ## Redaction is the whole design constraint of the bundle
 *
 * This is the one artifact users are expected to paste in public. It must be
 * useful and it must be safe, and the two pull in opposite directions: paths
 * carry usernames and project names, aliases are often the machine's own name,
 * command lines carry tokens, credentials must never be in it at all. There is
 * no "raw" switch — a bundle with a raw mode is a bundle that gets pasted in raw
 * mode.
 *
 * @module @shiqyka/dsh-ssh-workspace/report
 */

// `diagnose`, `renderDiagnosis` and `DIAGNOSIS_VERSION` are defined further down
// in this file — the judgement half used to be `diagnosis.js`. Only the schema
// version and the redaction primitives still come from the fact ring.
import { maskAlias as maskAliasShared, maskText, SCHEMA_VERSION } from '../core/diagnostics.js'
import { renderSelfCheck, selfCheck } from './capabilities.js'
import { isExact, sectionsOf, selects } from '../hosts/ssh-config.js'

// ---------------------------------------------------------------------------
// The config audit: what this plugin read, and what it deliberately does not
// ---------------------------------------------------------------------------

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
  // `proxyjump` is BUILT now (lib/hosts.js, lib/engine.js): the chain is
  // part of the descriptor, each hop authenticates and pins its own key. It is
  // listed here because the resolver really does read it.
  'proxyjump',
  // `proxycommand` is read only to REFUSE the host: it is arbitrary local
  // command execution, and a config file can arrive from a repository. Listed
  // as supported so the audit does not report it twice — the refusal is the
  // report.
  'proxycommand',
  'password',
  // `Include` is FOLLOWED now (lib/hosts.js), so it is adopted rather
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

// ---------------------------------------------------------------------------
// The judgement: does the report describe something wrong?
// ---------------------------------------------------------------------------

/** The version of the findings' shape, for the tool schema and the report. */
export const DIAGNOSIS_VERSION = 1

/**
 * The three states a finding — and the whole verdict — can be in.
 *
 * @type {Readonly<Record<string, 'ok'|'warn'|'unknown'>>}
 */
export const STATE = Object.freeze({
  ok: 'ok',
  warn: 'warn',
  unknown: 'unknown',
})

/**
 * @typedef {object} Finding
 * @property {string} id - stable identity (`upstream:<patch>`, `host-key`, …).
 * @property {'warn'|'unknown'} state - never `ok`: only problems are listed.
 * @property {string} [alias] - the host, kept separate so the report can mask it.
 * @property {string} detail - alias-free prose.
 */

/**
 * A self-check observation: the same shape as a finding, but ADVISORY.
 *
 * Rendered beside the findings and in the report, never counted into the
 * verdict. Kept as a separate list rather than a flag on `Finding` because the
 * aggregate rule reads `findings` directly — a flag would make "count the
 * actionable ones" a filter every caller has to remember, and the one that
 * forgets turns the dot red for a missing `tput`.
 *
 * @typedef {Finding} Note
 */

/**
 * @typedef {object} Diagnosis
 * @property {'ok'|'warn'|'unknown'} state - the aggregate verdict, from `findings` only.
 * @property {number} warn - how many findings need action.
 * @property {number} unknown - how many findings could not be judged.
 * @property {Finding[]} findings - in a fixed order: security, then action, then state.
 * @property {Note[]} notes - self-check observations; advisory, never counted.
 */

/**
 * Judge the state of the plugin from facts it already has.
 *
 * @param {object} [input] - the same bag `buildSupportBundle` takes, plus the
 *   three fields the report gained alongside this module (`unpinnedHostKeys`,
 *   `hostsSkipped`, `storeError`).
 */
export function diagnose (input) {
  // A default parameter only covers `undefined`. A `null` or a non-object
  // reaching this module is a caller bug, not a reason to throw out of a
  // status route, so the shape is normalised once here rather than defended
  // at every field.
  const source = typeof input === 'object' && input !== null ? input : {}
  const arrayOf = (value) => (Array.isArray(value) ? value.filter(entry => typeof entry === 'object' && entry !== null) : [])
  /** @type {Finding[]} */
  const findings = []
  /** @type {Note[]} */
  const notes = []
  const push = (list, id, state, detail, alias) => {
    list.push(alias === undefined ? { id, state, detail } : { id, state, detail, alias })
  }
  const add = (id, state, detail, alias) => push(findings, id, state, detail, alias)
  const note = (id, state, detail, alias) => push(notes, id, state, detail, alias)

  // ---- identity: the single most common cause of "it does not reproduce"
  const pluginVersion = String(source.pluginVersion ?? '')
  if (pluginVersion === '' || pluginVersion === 'unknown') {
    add('version', STATE.unknown, 'the plugin version could not be read, so a report cannot be matched to a release')
  }

  // ---- upstream patches: `fixed` is the one state that demands an action
  for (const entry of arrayOf(source.upstreamWorkarounds)) {
    if (entry.probe === 'fixed') {
      add(`upstream:${entry.id}`, STATE.warn, 'this workaround is obsolete — the Host no longer needs it, so it should be deleted')
    } else if (entry.probe === 'unprobeable') {
      add(`upstream:${entry.id}`, STATE.unknown, 'the Host could not be judged; re-check after the next upgrade')
    }
    // `broken` (still load-bearing), `pending` (not registered yet) and
    // `already` (relaxed in another context) are the normal startup states.
    // `disabled` is the operator's own choice. None of them is a problem.
  }

  // ---- host seams: did this plugin's own takeovers land?
  //
  // The other half of the "which patches are still needed" question. An
  // `upstream: fixed` entry is good news with a cleanup task; a seam that is
  // `failed` is a documented feature that is silently gone — the Host renamed
  // the method we wrap, the install threw, and the plugin degraded instead of
  // dying, which is exactly the state nobody notices without being told.
  //
  // `absent` is not reported: a composition that does not mount `ctx.sandbox` at
  // all has no sandbox to localize, and calling that a finding would put the dot
  // red on a perfectly correct deployment.
  for (const entry of arrayOf(source.seams)) {
    if (entry.state === 'failed') {
      add(`seam:${entry.id}`, STATE.warn,
        `this Host seam could not be taken over, so the feature it backs is disabled: ${String(entry.detail ?? 'no reason given')}`)
    }
  }

  // ---- session ownership: did the re-claim actually take?
  //
  // The files are not lost when the Host drops `ssh://` sessions from a
  // workspace's accounting — only the membership row is. The sessions are then
  // hidden from the sidebar with no other symptom, which is exactly the shape
  // this report exists to make visible. `pending` counts the sessions the last
  // activation could not re-attach; it is read from the in-memory snapshot, so a
  // status poll never turns into a session-list read.
  //
  // A degraded run (no readable session list) is NOT reported here: there are
  // zero KNOWN misses, and turning "I could not look" into a finding would put
  // the dot red on a deployment that is merely missing an optional service.
  const ownership = source.ownership
  if (ownership !== null && ownership !== undefined && typeof ownership === 'object' && Number(ownership.pending) > 0) {
    // A failed rebuild means this process cannot repair the membership on its
    // own — the Host only rebuilds its session index at startup — so the report
    // names the one action that fixes it, instead of leaving the user to
    // rediscover "restart DSH" from a bare count.
    const rebuilt = typeof ownership.indexRebuilt === 'string' ? ownership.indexRebuilt : ''
    const hint = rebuilt === 'reindexed'
      ? ''
      : '; a DSH restart rebuilds the Host session index and brings them back'
    add('workspace-ownership', STATE.warn,
      `${Number(ownership.pending)} session(s) are stored under a remote workspace but are not attached, so they are hidden from the sidebar${hint}`)
  }

  // ---- host keys: the security fact the report used to omit entirely
  for (const entry of arrayOf(source.unpinnedHostKeys)) {
    add('host-key', STATE.warn,
      `the host key was accepted but could not be pinned (${String(entry.keyType ?? '?')} ${String(entry.fingerprint ?? '?')}), so the next connection will trust whatever it is shown`,
      entry.alias)
  }

  // ---- hosts that exist in a config file but cannot be used
  if (typeof source.storeError === 'string' && source.storeError !== '') {
    add('host-store', STATE.warn, `the host store could not be read: ${source.storeError}`)
  }
  for (const entry of arrayOf(source.hostsSkipped)) {
    add('host-skipped', STATE.warn,
      `this host is configured but cannot be used: ${String(entry.reason ?? 'no reason given')}`,
      entry.alias)
  }

  // ---- connections
  //
  // A broken record that something is retrying is TRANSIENT — the panel says
  // "reconnecting in 8s" and the dot must not contradict it. Only a retry
  // loop that has stopped, or a broken record nothing is watching, is a
  // standing problem.
  const retrying = new Set((arrayOf(source.reconnecting)).map(entry => String(entry.alias)))
  for (const entry of arrayOf(source.connections)) {
    if (entry.state === 'broken' && !retrying.has(String(entry.alias))) {
      add('connection', STATE.warn, 'the connection is broken and nothing is retrying it', entry.alias)
    }
  }
  for (const entry of arrayOf(source.reconnecting)) {
    if (entry.phase === 'gave-up') {
      add('reconnect', STATE.warn,
        `background reconnect stopped after ${String(entry.attempts ?? '?')} attempt(s)${typeof entry.lastError === 'string' && entry.lastError !== '' ? `: ${entry.lastError}` : ''}`,
        entry.alias)
    }
  }

  // ---- port forwards: a saved mapping that failed to open
  for (const row of arrayOf(source.forwardRows)) {
    if (typeof row.error === 'string' && row.error !== '') {
      add('forward', STATE.warn, `a saved port forward is not open: ${row.error}`, row.alias)
    }
  }

  // ---- per-host self-check: ADVISORY, never a verdict input
  //
  // A missing tool degrades a documented feature on a host the user configured;
  // it is not a malfunction of this session, and often not even changeable on
  // that host. Reporting it as a finding made the dot red on healthy machines
  // that merely lacked an optional binary, which is how a status light stops
  // being read at all. The rows are passed through as notes, under the same
  // ids and wording, so the panel and the report still say what degrades.
  for (const entry of arrayOf(source.capabilities)) {
    const report = selfCheck(entry.tools ?? {}, entry.environment ?? {})
    for (const row of report.rows) {
      if (row.state === 'absent') {
        note(`tool:${row.tool}`, STATE.warn, `${row.tool} is missing (${row.feature}): ${row.detail ?? ''}`.trimEnd(), entry.alias)
      } else if (row.state === 'unknown') {
        note(`tool:${row.tool}`, STATE.unknown, `${row.tool} could not be determined (${row.feature})`, entry.alias)
      }
    }
    for (const finding of report.findings) {
      if (finding.state === 'warn') note(`env:${finding.id}`, STATE.warn, finding.detail, entry.alias)
      else if (finding.state === 'unknown') note(`env:${finding.id}`, STATE.unknown, finding.detail, entry.alias)
    }
  }

  // ---- recent commands
  //
  // A non-zero exit is NOT listed: `grep` that found nothing and `test -e` on
  // a path that does not exist both exit non-zero, and that is the correct
  // answer to the question that was asked. What does count is a command whose
  // outcome is unknown (the transport died mid-flight — it may or may not
  // have run) and one that hung until the timeout.
  for (const command of arrayOf(source.commands)) {
    if (command.outcomeUnknown === true) {
      add('command', STATE.warn, 'a remote command was cut off by a dead connection: it may or may not have run', command.alias)
    } else if (command.timedOut === true) {
      add('command', STATE.warn, 'a remote command timed out', command.alias)
    }
  }

  // The verdict counts FINDINGS ONLY. Notes are carried alongside so the panel
  // and the report can still say what the self-check saw; they never move the
  // dot, which is the whole point of separating them.
  const warn = findings.filter(finding => finding.state === STATE.warn).length
  const unknown = findings.filter(finding => finding.state === STATE.unknown).length
  const state = warn > 0 ? STATE.warn : unknown > 0 ? STATE.unknown : STATE.ok
  return { state, warn, unknown, findings, notes }
}

/**
 * Render a diagnosis as plain text.
 *
 * Used by the report's own section, so the pasted artifact opens with the
 * verdict instead of nine screens of facts, and by the status tool's text
 * form, so an agent reads the same sentence the panel's dot encodes.
 *
 * @param {(alias: string) => string} [mask] - alias masking; the report
 *   passes `maskAlias`, the panel's tool passes nothing.
 */
export function renderDiagnosis (report, mask = alias => String(alias ?? '?')) {
  const lines = []
  const notes = Array.isArray(report.notes) ? report.notes : []
  if (report.state === STATE.ok) {
    lines.push('verdict: ok — nothing needs attention')
  } else {
    const parts = []
    if (report.warn > 0) parts.push(`${report.warn} need attention`)
    if (report.unknown > 0) parts.push(`${report.unknown} could not be judged`)
    lines.push(`verdict: ${report.state === STATE.warn ? 'needs attention' : 'could not judge'} — ${parts.join(', ')}`)
    for (const finding of report.findings) {
      const where = finding.alias === undefined ? '' : ` [${mask(finding.alias)}]`
      lines.push(`${finding.state === STATE.warn ? 'WARN' : 'UNKNOWN'} ${finding.id}${where}: ${finding.detail}`)
    }
  }
  // Notes are printed under their own heading and marked as advisory, so a
  // reader cannot mistake a missing optional tool for the reason the verdict is
  // red. An `ok` verdict with notes is the normal, healthy case: the plugin
  // works, and here is what it degrades on that host.
  if (notes.length > 0) {
    lines.push('')
    lines.push('advisory (not counted in the verdict):')
    for (const note of notes) {
      const where = note.alias === undefined ? '' : ` [${mask(note.alias)}]`
      lines.push(`${note.state === STATE.warn ? 'NOTE' : 'UNKNOWN'} ${note.id}${where}: ${note.detail}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The report: one self-contained, redacted answer to "what is going on?"
// ---------------------------------------------------------------------------

/**
 * The version of the bundle's own layout.
 *
 * Bumped when a section is renamed or removed, not when one is added — same
 * rule as `diagnostics.SCHEMA_VERSION`, and for the same reason.
 */
export const BUNDLE_VERSION = 1

/**
 * Shorten an alias for a shared report, consistently.
 *
 * Deliberately the same rule `diagnostics.js` uses, so an alias reads
 * identically in an event and in the bundle. Two different masking rules for
 * the same string is how a report stops being correlatable.
 *
 */
export function maskAlias (alias) {
  return maskAliasShared(alias)
}

/**
 * Mask the identifying part of a path while keeping its shape.
 *
 * Keeps the first segment and the extension so a reader can still tell
 * `/home/<user>/proj/src/index.ts` from `/home/<user>/proj/dist/app.js`, which
 * is the difference between a useful report and a useless one.
 *
 */
export function maskPath (path) {
  return maskText(path)
}

/**
 * Everything the bundle needs, gathered by the caller.
 *
 * Deliberately a plain bag rather than live services: assembling from plain data
 * makes the bundle testable without a Host, and keeps this module from
 * acquiring a dependency on the engine's internals.
 *
 * @typedef {object} BundleInput
 * @property {string} pluginVersion - this package's version.
 * @property {string} [hostVersion] - the DSH version, when readable.
 * @property {string} [nodeVersion] - `process.version`.
 * @property {string} [platform] - `process.platform` and arch.
 * @property {Array<{id: string, probe: string, detail: string}>} [upstreamWorkarounds] - patch verdicts.
 * @property {Array<{id: string, state: string, detail: string}>} [seams] - one row per Host seam this process took over.
 * @property {Array<{seq: number, at: number, kind: string, message: string, alias?: string}>} [events] - recent diagnostics.
 * @property {Array<object>} [hosts] - secret-free host rows.
 * @property {Array<{alias: string, state: string, inFlight: number}>} [connections] - pooled connections.
 * @property {Array<object>} [reconnecting] - background retry rows.
 * @property {Array<object>} [capabilities] - `{alias, tools, environment}` triples.
 * @property {string[]} [mounted] - mounted workspace paths.
 * @property {string[]} [disabled] - detached workspace paths.
 * @property {Array<object>} [forwards] - live port forwards.
 * @property {Array<object>} [forwardRows] - SAVED forwards joined with live state, `error` when one failed.
 * @property {Array<object>} [commands] - audit rows (already redacted at write time).
 * @property {string} [auditText] - fallback text, used only when no rows are given.
 * @property {Array<{alias: string, keyType: string, fingerprint: string}>} [unpinnedHostKeys] - keys accepted but not pinned.
 * @property {Array<{alias?: string, reason: string}>} [hostsSkipped] - config entries that cannot be used.
 * @property {string} [storeError] - why the host store could not be read.
 * @property {number} [generation] - the highest connection generation seen, for the continuity note.
 */

/**
 * Build the bundle.
 *
 * Sections are ordered by what a reader needs first: identity, then the
 * plugin's own judgement of itself (patches), then state, then history. A
 * reader who stops after the first screen still knows which versions are
 * involved, which is the single most common cause of "it does not reproduce".
 *
 */
export function buildSupportBundle (input) {
  const lines = []
  lines.push('# dsh-ssh-workspace diagnostic report')
  lines.push(`bundleVersion: ${BUNDLE_VERSION}`)
  lines.push(`diagnosisVersion: ${DIAGNOSIS_VERSION}`)
  lines.push(`generatedAt: ${new Date(input.generatedAt ?? Date.now()).toISOString()}`)
  lines.push('')

  // ---- the verdict, first
  //
  // The report used to open with versions and end with events, and never
  // answer its own question. A reader who pastes it knows what happened; a
  // reader who OPENS it wants to know whether anything is wrong. The verdict
  // is derived from the same fields the sections below print (see
  // the judgement half below), so it cannot contradict them — and it comes first so the
  // answer is not nine screens down.
  lines.push('## diagnosis')
  lines.push(renderDiagnosis(diagnose(input), maskAlias))
  lines.push('')

  lines.push('## versions')
  lines.push(`plugin: ${String(input.pluginVersion ?? 'unknown')}`)
  lines.push(`host: ${String(input.hostVersion ?? 'unknown')}`)
  lines.push(`node: ${String(input.nodeVersion ?? 'unknown')}`)
  lines.push(`platform: ${String(input.platform ?? 'unknown')}`)
  lines.push(`diagnosticsSchema: ${SCHEMA_VERSION}`)
  lines.push('')

  // ---- patches: the plugin's judgement of the Host it is running on
  const workarounds = Array.isArray(input.upstreamWorkarounds) ? input.upstreamWorkarounds : []
  lines.push('## upstream patches')
  if (workarounds.length === 0) {
    // One sentence for two different facts used to be the failure: "the
    // patches are not needed" and "I could not look at the Host" read
    // identically. The projection seam reports `disabled` when the operator
    // skipped them, so that case is now said out loud instead of folded into
    // the silence.
    lines.push('no patch reported a verdict (the projection seam was unavailable at startup, or no patch module registered)')
  } else {
    for (const entry of workarounds) {
      lines.push(`${entry.id}: ${entry.probe}${entry.detail === '' || entry.detail === undefined ? '' : ` (${entry.detail})`}`)
    }
  }
  lines.push('')

  // ---- seams: the OTHER half of "are the patches in place"
  //
  // The section above answers "has the Host moved on?"; this one answers "did my
  // takeover land?". Both have to be in the report or a reader cannot tell a
  // Host that needs no workaround from a wrapper that never installed — the two
  // produce the same quiet startup.
  const seams = Array.isArray(input.seams) ? input.seams : []
  lines.push('## host seams')
  if (seams.length === 0) {
    lines.push('no seam reported a verdict (the plugin did not reach its install sites)')
  } else {
    for (const entry of seams) {
      lines.push(`${entry.id}: ${entry.state}${entry.detail === '' || entry.detail === undefined ? '' : ` (${entry.detail})`}`)
    }
  }
  lines.push('')

  // ---- host keys: the security fact the report did not carry at all
  //
  // A key that was accepted but never pinned is the one piece of state where
  // "the report says nothing" and "the report says everything is fine" were
  // the same screen. It belongs above the host table: it is a standing risk,
  // not a configuration detail.
  const unpinned = Array.isArray(input.unpinnedHostKeys) ? input.unpinnedHostKeys : []
  lines.push('## host keys')
  if (unpinned.length === 0) {
    lines.push('every key seen this session is pinned')
  } else {
    for (const entry of unpinned) {
      lines.push(`${maskAlias(entry.alias)}: NOT PINNED — ${String(entry.keyType ?? '?')} ${String(entry.fingerprint ?? '?')} was accepted but could not be saved; the next connection will trust whatever it is shown`)
    }
  }
  lines.push('')

  // ---- hosts: secret-free, because the store rows are secret-free
  const hosts = Array.isArray(input.hosts) ? input.hosts : []
  const skippedHosts = Array.isArray(input.hostsSkipped) ? input.hostsSkipped : []
  lines.push('## hosts')
  if (hosts.length === 0 && skippedHosts.length === 0) lines.push('none')
  for (const host of hosts) {
    // The address keeps the port (it matters) and masks the user, because a
    // username is identifying and a hostname alone usually is not.
    lines.push(`${maskAlias(host.alias)}: <user>@${String(host.host ?? '?')}:${String(host.port ?? '?')} auth=${String(host.auth ?? '?')} key=${host.keyReady === false ? 'missing' : 'ok'} source=${String(host.source ?? '?')}`)
    for (const entry of Array.isArray(host.unsupported) ? host.unsupported : []) {
      lines.push(`  config: ${entry.keyword} (${entry.verdict}) — ${entry.detail}`)
    }
  }
  // A host that exists in `~/.ssh/config` and cannot be used does not appear
  // as a row at all — which is how "I configured it and it is not there" had
  // no answer anywhere in the report.
  for (const entry of skippedHosts) {
    lines.push(`skipped: ${entry.alias === undefined ? '?' : maskAlias(entry.alias)} — ${maskPath(String(entry.reason ?? 'no reason given'))}`)
  }
  if (typeof input.storeError === 'string' && input.storeError !== '') {
    lines.push(`store error: ${maskPath(input.storeError)}`)
  }
  lines.push('')

  // ---- workspaces
  const mounted = Array.isArray(input.mounted) ? input.mounted : []
  const disabled = Array.isArray(input.disabled) ? input.disabled : []
  lines.push('## workspaces')
  lines.push(`mounted: ${mounted.length}`)
  for (const path of mounted) lines.push(`  ${maskRemotePath(path)}`)
  if (disabled.length > 0) {
    lines.push(`detached (registered but not served): ${disabled.length}`)
    for (const path of disabled) lines.push(`  ${maskRemotePath(path)}`)
  }
  lines.push('')

  // ---- connections
  const connections = Array.isArray(input.connections) ? input.connections : []
  const reconnecting = Array.isArray(input.reconnecting) ? input.reconnecting : []
  lines.push('## connections')
  if (connections.length === 0 && reconnecting.length === 0) lines.push('none')
  for (const connection of connections) {
    // The generation is what turns "connected" into a statement about
    // CONTINUITY: generation 3 is not the session an earlier operation
    // started in, and a remote process from generation 2 may still be
    // running. Without it, "it dropped once" and "it has never worked" read
    // identically here.
    const generation = Number.isInteger(connection.generation) && connection.generation > 1
      ? ` (generation ${connection.generation}: work started before the reconnect may still be running)`
      : ''
    lines.push(`${maskAlias(connection.alias)}: ${String(connection.state)} (in flight ${String(connection.inFlight)})${generation}`)
  }
  for (const retry of reconnecting) {
    // The phase matters more than the numbers for a bug report: "gave-up after
    // 40 attempts" and "waiting for attempt 2" describe different problems.
    lines.push(`${maskAlias(retry.alias)}: reconnect ${String(retry.phase)} (attempt ${String(retry.attempts)})${typeof retry.lastError === 'string' && retry.lastError !== '' ? ` last error: ${maskPath(retry.lastError)}` : ''}`)
  }
  lines.push('')

  // ---- forwards
  const forwards = Array.isArray(input.forwards) ? input.forwards : []
  const forwardRows = Array.isArray(input.forwardRows) ? input.forwardRows : []
  lines.push('## port forwards')
  if (forwards.length === 0 && forwardRows.length === 0) lines.push('none')
  for (const forward of forwards) {
    lines.push(`${String(forward.localHost)}:${String(forward.localPort)} -> ${maskAlias(forward.alias)}:${String(forward.remoteHost)}:${String(forward.remotePort)} (${String(forward.connections)} active)`)
  }
  // A SAVED mapping is an intent, and a failed one is invisible in the live
  // list: "the tunnel is off" and "the tunnel failed to open" looked the same
  // until the panel started carrying `error` per row.
  for (const row of forwardRows) {
    if (typeof row.error !== 'string' || row.error === '') continue
    lines.push(`${maskAlias(row.alias)}: saved forward ${String(row.localHost ?? '?')}:${String(row.localPort ?? '?')} -> :${String(row.remotePort ?? '?')} is NOT open — ${maskPath(row.error)}`)
  }
  lines.push('')

  // ---- self-check per host
  const capabilities = Array.isArray(input.capabilities) ? input.capabilities : []
  lines.push('## remote self-check')
  if (capabilities.length === 0) lines.push('no host was probed (mount one, or run ssh_workspace_status)')
  for (const entry of capabilities) {
    lines.push(`### ${maskAlias(entry.alias)}`)
    const report = selfCheck(entry.tools ?? {}, entry.environment ?? {})
    lines.push(renderSelfCheck(report))
  }
  lines.push('')

  // ---- audit
  //
  // Rendered here from the ROWS rather than accepted as pre-formatted text.
  // The first version took the audit's own `exportText()` output verbatim, and
  // that leaked the one thing the bundle exists to hide: the audit text carries
  // the alias unmasked, because it is written for a local reader. Masking has
  // to happen where the string is FORMED, so the bundle formats its own.
  lines.push('## recent commands')
  const commands = Array.isArray(input.commands) ? input.commands : []
  if (commands.length === 0) {
    lines.push(input.auditText === undefined ? 'no remote commands recorded' : String(input.auditText))
  } else {
    for (const command of commands) {
      const status = command.refused === true
        ? 'refused'
        : command.outcomeUnknown === true
          ? 'outcome unknown'
          : command.timedOut === true
            ? 'timed out'
            : `exit ${command.exitCode === null || command.exitCode === undefined ? 'null' : command.exitCode}`
      lines.push(`#${String(command.seq)} ${new Date(command.at).toISOString()} ${maskAlias(command.alias)} ${String(command.channel)} ${status} ${String(command.durationMs)}ms${command.cwd === undefined ? '' : ` (cwd ${maskPath(command.cwd)})`}`)
      // The command text is already redacted at write time by the command audit
      // path masking is applied again because an absolute path in a command is
      // a DIFFERENT string from the same path in a cwd field.
      lines.push(`  ${maskPath(command.command)}`)
      if (command.error !== undefined) lines.push(`  error: ${maskPath(command.error)}`)
    }
  }
  lines.push('')

  // ---- events
  const events = Array.isArray(input.events) ? input.events : []
  lines.push('## recent events')
  if (events.length === 0) lines.push('none')
  for (const event of events) {
    const where = event.alias === undefined ? '' : ` [${maskAlias(event.alias)}]`
    lines.push(`#${String(event.seq)} ${new Date(event.at).toISOString()} ${String(event.kind)}${where}`)
    lines.push(`  ${maskPath(event.message)}`)
  }
  lines.push('')
  lines.push('## note')
  lines.push('Paths, usernames and credentials are masked. Nothing was uploaded: you decide where this goes.')
  return lines.join('\n')
}

/**
 * Mask a remote workspace path, keeping the host and the shape.
 *
 * `ssh://alias/remote/path` — the alias is masked and the remote home segment
 * too, so `/home/<user>/proj` stays recognisable without naming anyone.
 *
 */
export function maskRemotePath (path) {
  const text = String(path ?? '')
  if (!text.startsWith('ssh://')) return maskPath(text)
  const rest = text.slice('ssh://'.length)
  const separator = rest.indexOf('/')
  if (separator < 0) return `ssh://${maskAlias(rest)}`
  return `ssh://${maskAlias(rest.slice(0, separator))}${maskPath(rest.slice(separator))}`
}

/**
 * The one-line summary of an audit, re-exported for convenience.
 *
 */
