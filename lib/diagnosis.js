/**
 * "Is anything wrong right now?" — the verdict behind the panel's status dot.
 *
 * ## Why this exists separately from the report
 *
 * The diagnostic report is a FACT SHEET: nine sections of what happened, with
 * no line anywhere that says whether that is good or bad (see
 * `support-bundle.js`, which assembles and never judges). That is the right
 * shape for a paste, and the wrong shape for the panel: a user opening the
 * plugin should not have to know the thresholds — that a `probe: 'fixed'`
 * patch means "delete it", that a host missing from the list means its
 * `~/.ssh/config` block was refused, that `generation 3` means the transport
 * died twice.
 *
 * So this module is the JUDGEMENT half, and it is deliberately narrow:
 *
 *  - it reads ONLY the fields the report already carries, so the dot and the
 *    paste can never disagree (the same rule `support-bundle.js` states for
 *    itself — "the report cannot report something the panel would deny");
 *  - it does not probe, connect, or read a file: a status poll must not
 *    become network activity or a disk walk;
 *  - it returns findings, not a score. "3 of 10 tools missing" is not a
 *    health percentage; it is three rows a user can act on.
 *
 * ## Three states, and why the dot is not two
 *
 * `ok` / `warn` / `unknown` — the same three-valued vocabulary
 * `capabilities.js` uses for a tool probe, for the same reason: "I could not
 * judge" must never render as "fine" (that is how a silent degradation ships)
 * nor as "broken" (that is how an unreachable host gets reported as missing
 * every tool it owns). The panel shows green / red / amber accordingly.
 *
 * `unknown` never wins over `warn`: if one thing is definitely wrong and
 * another could not be judged, the dot is red — the actionable fact is the
 * one that matters.
 *
 * ## Findings carry no identifying text
 *
 * Every `detail` is alias-free prose, and the alias travels as its own field.
 * The report masks it with `maskAlias` when rendering (the finding is written
 * once and rendered twice, with two different alias policies), while the
 * panel and the status tool show it verbatim. Putting the alias INSIDE the
 * detail string is exactly the leak `support-bundle.js` documents: masking has
 * to happen where the string is formed, so the string must not be formed with
 * the alias in it.
 *
 * @module @shiqyka/dsh-ssh-workspace/diagnosis
 */

import { selfCheck } from './capabilities.js'

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
 * @typedef {object} Diagnosis
 * @property {'ok'|'warn'|'unknown'} state - the aggregate verdict.
 * @property {number} warn - how many findings need action.
 * @property {number} unknown - how many could not be judged.
 * @property {Finding[]} findings - in a fixed order: security, then action, then state.
 */

/**
 * Judge the state of the plugin from facts it already has.
 *
 * @param {object} [input] - the same bag `buildSupportBundle` takes, plus the
 *   three fields the report gained alongside this module (`unpinnedHostKeys`,
 *   `hostsSkipped`, `storeError`).
 * @returns {Diagnosis} the verdict.
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
  const add = (id, state, detail, alias) => {
    findings.push(alias === undefined ? { id, state, detail } : { id, state, detail, alias })
  }

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

  // ---- per-host self-check: a missing tool degrades a feature, a warning
  // finding is a consequence the user can fix, an unknown probe is neither.
  for (const entry of arrayOf(source.capabilities)) {
    const report = selfCheck(entry.tools ?? {}, entry.environment ?? {})
    for (const row of report.rows) {
      if (row.state === 'absent') {
        add(`tool:${row.tool}`, STATE.warn, `${row.tool} is missing (${row.feature}): ${row.detail ?? ''}`.trimEnd(), entry.alias)
      } else if (row.state === 'unknown') {
        add(`tool:${row.tool}`, STATE.unknown, `${row.tool} could not be determined (${row.feature})`, entry.alias)
      }
    }
    for (const finding of report.findings) {
      if (finding.state === 'warn') add(`env:${finding.id}`, STATE.warn, finding.detail, entry.alias)
      else if (finding.state === 'unknown') add(`env:${finding.id}`, STATE.unknown, finding.detail, entry.alias)
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

  const warn = findings.filter(finding => finding.state === STATE.warn).length
  const unknown = findings.filter(finding => finding.state === STATE.unknown).length
  const state = warn > 0 ? STATE.warn : unknown > 0 ? STATE.unknown : STATE.ok
  return { state, warn, unknown, findings }
}

/**
 * Render a diagnosis as plain text.
 *
 * Used by the report's own section, so the pasted artifact opens with the
 * verdict instead of nine screens of facts, and by the status tool's text
 * form, so an agent reads the same sentence the panel's dot encodes.
 *
 * @param {Diagnosis} report - the diagnosis.
 * @param {(alias: string) => string} [mask] - alias masking; the report
 *   passes `maskAlias`, the panel's tool passes nothing.
 * @returns {string} the text.
 */
export function renderDiagnosis (report, mask = alias => String(alias ?? '?')) {
  const lines = []
  if (report.state === STATE.ok) {
    lines.push('verdict: ok — nothing needs attention')
    return lines.join('\n')
  }
  const parts = []
  if (report.warn > 0) parts.push(`${report.warn} need attention`)
  if (report.unknown > 0) parts.push(`${report.unknown} could not be judged`)
  lines.push(`verdict: ${report.state === STATE.warn ? 'needs attention' : 'could not judge'} — ${parts.join(', ')}`)
  for (const finding of report.findings) {
    const where = finding.alias === undefined ? '' : ` [${mask(finding.alias)}]`
    lines.push(`${finding.state === STATE.warn ? 'WARN' : 'UNKNOWN'} ${finding.id}${where}: ${finding.detail}`)
  }
  return lines.join('\n')
}
