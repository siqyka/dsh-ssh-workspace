/**
 * What a remote host can actually do, and what that costs the user.
 *
 * ## Why this is its own module
 *
 * The probe started as three booleans inside `engine.probeCapabilities` — rg,
 * git, inotifywait — because those were the three tools whose absence changed
 * behaviour silently. That list was always incomplete in the same direction:
 * every one of them degrades a FEATURE, and a feature that degrades without a
 * sentence is a bug report nobody can file ("my edits stopped refreshing").
 *
 * Growing the list inside the engine had two costs. The engine grew a second
 * responsibility (interpreting the answer, not just fetching it), and every new
 * capability needed edits in four places that each spelled the wording
 * differently: the mount tool, the panel, the status tool, the diagnostics.
 *
 * So the split is: `engine.probeCapabilities` runs ONE round trip and returns
 * raw facts; this module owns the vocabulary — what each fact enables, what its
 * absence costs, and how a user installs it — and every surface renders from
 * that one table.
 *
 * ## The rule that keeps the report honest
 *
 * A capability the probe could not determine is `undefined`, never `false`.
 * The report therefore distinguishes three states and never collapses them:
 *
 *   present    → nothing to say (the feature works)
 *   absent     → the affected feature is degraded, and here is how to fix it
 *   unknown    → the probe could not tell (unreachable host, odd shell)
 *
 * `unknown` must not become a warning. A host the user cannot reach right now
 * would otherwise be reported as missing every tool it has.
 *
 * ## What is NOT here
 *
 * Nothing in this module executes, installs or writes. F-06's "do not install
 * anything automatically" is a property of the whole plugin, not a promise this
 * file makes: there is no code path here that can run a command.
 *
 * @module @shiqyka/dsh-ssh-workspace/capabilities
 */

/**
 * Every probed tool, with what it is for.
 *
 * `needs` is the user-facing consequence, phrased as "what stops working".
 * `install` is a hint, never executed: the panel shows it, the user decides.
 * Keeping the install hint beside the consequence is what makes the report
 * actionable instead of a list of red marks.
 *
 * @typedef {object} CapabilitySpec
 * @property {string} tool - the executable name, as probed with `command -v`.
 * @property {string} feature - the plugin feature that depends on it.
 * @property {string} whenMissing - what the user loses, in one sentence.
 * @property {string} install - a hint (shown, never run).
 * @property {string} [fallback] - what happens instead, when there is a fallback.
 */

/** @type {ReadonlyArray<CapabilitySpec>} */
export const TOOL_CAPABILITIES = Object.freeze([
  {
    tool: 'rg',
    feature: 'glob / grep',
    whenMissing: 'glob and grep fail with exit 127 on this host',
    install: 'apt install ripgrep  |  brew install ripgrep',
  },
  {
    tool: 'git',
    feature: 'change tracking',
    whenMissing: 'the diff / changes panel is disabled for this workspace',
    install: 'apt install git  |  brew install git',
  },
  {
    tool: 'sha256sum',
    feature: 'transfer verification',
    whenMissing: 'transfers still move the bytes, but the copy cannot be verified against its source',
    fallback: 'shasum -a 256 or openssl dgst -sha256, when either is present; otherwise the transfer reports itself as unverified rather than successful',
    install: 'apt install coreutils  |  brew install coreutils',
  },
  {
    tool: 'inotifywait',
    feature: 'change watching',
    whenMissing: 'file-tree and preview refresh fall back to polling',
    fallback: 'polling, a few seconds behind; two same-size rewrites within one mtime tick can be missed',
    install: 'apt install inotify-tools  |  brew install inotify-tools',
  },
])

/**
 * Tools this table deliberately does NOT list, and why.
 *
 * ## The rule
 *
 * A row here is a promise about BEHAVIOUR: "if this tool is missing, that
 * feature degrades, and here is what you lose". The report is only honest if
 * the feature actually exists and actually depends on the tool. So the test
 * for membership is `grep` — if removing every mention of the tool from `lib/`
 * outside this file changes nothing, the row is fiction and belongs here
 * instead.
 *
 * ## What was removed, and the check that removed it
 *
 * Four rows used to sit in the table above: `sha256sum` ("transfer
 * verification"), `tar` ("directory transfer"), `rsync` ("incremental sync")
 * and `tput` ("terminal handling"). Measured, the reference count of each
 * across `lib/*.js` outside this file was:
 *
 *     sha256sum → 0    tar → 0    rsync → 0    tput → 1 (a comment)
 *
 * None of them was ever executed, so each described a degradation of a feature
 * that had only one state. `tar` and `rsync` still are not invoked anywhere:
 * directory upload walks the tree with `uploadTree`, per-file SFTP, always.
 *
 * `sha256sum` has since been IMPLEMENTED (`lib/verify.js`) and is probed again:
 * an upload or download with `verify: true` hashes both sides and compares, and
 * on a host with none of `sha256sum` / `shasum` / `openssl` it reports the copy
 * as unverified instead of claiming success. The row moved back into the table
 * because the feature behind it now exists — which is the same test that put it
 * here in the first place.
 *
 * The cost of leaving them in was not cosmetic. `capabilities-report-smoke`
 * asserted the four were PROBED, which passed, because probing them really did
 * happen — `command -v` ran on the host. The assertion tested the probe loop
 * (derived from this table, so true by construction) and never the claim. A
 * user reading "install coreutils to get transfer verification" would install
 * coreutils and get nothing, and the panel would have told them so confidently.
 *
 * `tput` is a different case and is kept out for the same reason: the single
 * reference is the sentence in `diagnosis.js` explaining that a missing `tput`
 * turns a dot red. That sentence is about a dot, not about terminal sizing —
 * nothing queries the terminal through `tput`.
 *
 * @type {ReadonlyArray<{tool: string, feature: string, why: string}>}
 */
export const UNPROBED_CAPABILITIES = Object.freeze([
  { tool: 'tar', feature: 'directory transfer', why: 'uploadTree always walks file by file; no code path shells out to tar' },
  { tool: 'rsync', feature: 'incremental sync', why: 'incremental sync is not implemented at any level' },
  { tool: 'tput', feature: 'terminal handling', why: 'terminal geometry comes from the host terminal channel, never from tput' },
])

/**
 * The tool names the probe asks about, in report order.
 *
 * Derived from the table so the probe script and the report cannot drift: a
 * capability added to {@link TOOL_CAPABILITIES} is probed automatically.
 *
 * @returns {string[]} tool names.
 */
export function probedTools () {
  return TOOL_CAPABILITIES.map(spec => spec.tool)
}

/**
 * The capability keys that are plain booleans, for schema construction.
 *
 * The three original keys come first so an existing reader that only knows
 * about them keeps seeing the same shape at the front of the object.
 *
 * @returns {string[]} boolean capability keys.
 */
export function capabilityKeys () {
  return probedTools()
}

/**
 * One row of the self-check: a tool and its verdict.
 *
 * @typedef {object} SelfCheckRow
 * @property {string} tool - the executable.
 * @property {string} feature - what depends on it.
 * @property {'present'|'absent'|'unknown'} state - the verdict, three-valued.
 * @property {string} [detail] - what the user loses, or what happens instead.
 * @property {string} [install] - the hint, present only when absent.
 */

/**
 * Turn one probe result into self-check rows.
 *
 * A missing key and an `undefined` value both mean "unknown": the probe never
 * writes `undefined` deliberately, but a cached result from an older shape can
 * lack a key entirely, and that must not read as "absent".
 *
 * @param {Record<string, boolean|undefined>} capabilities - the probe result.
 * @returns {SelfCheckRow[]} one row per probed tool.
 */
export function selfCheckRows (capabilities) {
  const rows = []
  for (const spec of TOOL_CAPABILITIES) {
    const value = capabilities?.[spec.tool]
    if (value === true) {
      rows.push({ tool: spec.tool, feature: spec.feature, state: 'present' })
      continue
    }
    if (value === false) {
      rows.push({
        tool: spec.tool,
        feature: spec.feature,
        state: 'absent',
        detail: spec.fallback === undefined ? spec.whenMissing : `${spec.whenMissing} — ${spec.fallback}`,
        install: spec.install,
      })
      continue
    }
    rows.push({
      tool: spec.tool,
      feature: spec.feature,
      state: 'unknown',
      // Deliberately NOT the whenMissing text: "unknown" is not "missing", and
      // reusing the warning would turn one unreachable probe into a page of
      // red marks about a host that may be perfectly equipped.
      detail: 'the probe could not determine this (the host may be unreachable, or its shell answered oddly)',
    })
  }
  return rows
}

/**
 * The environment facts the probe collects alongside the tools.
 *
 * These are strings and numbers rather than booleans because each one answers
 * a question whose answer is not yes/no: which shell runs the commands, which
 * locale decides how output is encoded, how much disk the workspace has, and
 * whether the watch limit is high enough to matter.
 *
 * @typedef {object} RemoteEnvironment
 * @property {string} [shell] - `$SHELL` as the remote login saw it.
 * @property {string} [locale] - the effective locale (`LC_ALL` / `LC_CTYPE` / `LANG`).
 * @property {number} [diskFreeKb] - free blocks (KiB) on the filesystem holding the cwd.
 * @property {number} [inotifyWatches] - `fs.inotify.max_user_watches`, when readable.
 */

/**
 * Environment-level findings, each with the consequence a user cares about.
 *
 * @param {RemoteEnvironment} env - the probed environment.
 * @returns {Array<{id: string, state: 'ok'|'warn'|'unknown', detail: string}>} findings.
 */
export function environmentFindings (env) {
  const findings = []
  const shell = typeof env?.shell === 'string' ? env.shell.trim() : ''
  if (shell === '') {
    findings.push({ id: 'shell', state: 'unknown', detail: 'the login shell could not be determined; commands still run under a POSIX shell' })
  } else if (/\/csh$|\/tcsh$|\/fish$/u.test(shell)) {
    // A non-POSIX login shell is a real hazard: the plugin writes POSIX
    // (`cd … && …`, `printf`, `$?`), and csh/fish reject that syntax. Saying so
    // up front beats a syntax error the user reads as "the plugin is broken".
    findings.push({ id: 'shell', state: 'warn', detail: `the login shell is ${shell}, which is not POSIX; commands are sent to \`sh\` explicitly and shell syntax must stay POSIX` })
  } else {
    findings.push({ id: 'shell', state: 'ok', detail: `login shell: ${shell}` })
  }
  const locale = typeof env?.locale === 'string' ? env.locale.trim() : ''
  if (locale === '') {
    findings.push({ id: 'locale', state: 'unknown', detail: 'the locale could not be determined; output encoding may vary' })
  } else if (!/UTF-?8/iu.test(locale)) {
    // A non-UTF-8 locale is the classic source of mojibake in captured output:
    // the plugin decodes with a UTF-8 StringDecoder, so a Latin-1 host mangles
    // every accented byte and there is nothing to fix on our side.
    findings.push({ id: 'locale', state: 'warn', detail: `the locale is ${locale}, which is not UTF-8; captured output may show replacement characters` })
  } else {
    findings.push({ id: 'locale', state: 'ok', detail: `locale: ${locale}` })
  }
  if (typeof env?.diskFreeKb === 'number' && Number.isFinite(env.diskFreeKb)) {
    const mb = Math.round(env.diskFreeKb / 1024)
    // Below ~100 MB, an atomic write (stage + rename) is likely to fail, and
    // the failure arrives as ENOSPC mid-transfer rather than as "low disk".
    findings.push({
      id: 'disk',
      state: env.diskFreeKb < 100 * 1024 ? 'warn' : 'ok',
      detail: env.diskFreeKb < 100 * 1024
        ? `only ${mb} MB free where the workspace lives; a staged write (temp file + rename) may fail with ENOSPC`
        : `${mb} MB free where the workspace lives`,
    })
  } else {
    findings.push({ id: 'disk', state: 'unknown', detail: 'free space could not be read (no df, or the shell refused)' })
  }
  if (typeof env?.inotifyWatches === 'number' && Number.isFinite(env.inotifyWatches)) {
    // The default is 8192 on many distributions, and a large monorepo plus a
    // recursive watch exhausts it: inotifywait then fails with a limit error
    // that looks like "the watcher died for no reason".
    findings.push({
      id: 'inotify',
      state: env.inotifyWatches < 8192 ? 'warn' : 'ok',
      detail: `fs.inotify.max_user_watches = ${env.inotifyWatches}${env.inotifyWatches < 8192 ? ' (low: a recursive watch on a large tree may hit the limit)' : ''}`,
    })
  } else {
    findings.push({ id: 'inotify', state: 'unknown', detail: 'fs.inotify.max_user_watches is not readable on this host' })
  }
  return findings
}

/**
 * The whole self-check: rows plus environment findings.
 *
 * @param {Record<string, boolean|undefined>} capabilities - probe result.
 * @param {RemoteEnvironment} [env] - probed environment facts.
 * @returns {{rows: SelfCheckRow[], findings: Array<object>, missing: string[]}} the report.
 */
export function selfCheck (capabilities, env) {
  const rows = selfCheckRows(capabilities)
  return {
    rows,
    findings: environmentFindings(env ?? {}),
    missing: rows.filter(row => row.state === 'absent').map(row => row.tool),
  }
}

/**
 * Render the self-check as plain text.
 *
 * Used by the status tool and the diagnostic report, so both say the same thing.
 * Absent tools are the only rows that get an install hint, and `unknown` rows
 * are printed as unknown rather than omitted: a reader must be able to tell
 * "nothing to report" from "this was not checked".
 *
 * @param {{rows: SelfCheckRow[], findings: Array<object>}} report - the self-check.
 * @returns {string} the text.
 */
export function renderSelfCheck (report) {
  const lines = []
  for (const row of report.rows) {
    if (row.state === 'present') continue
    const mark = row.state === 'absent' ? 'MISSING' : 'UNKNOWN'
    lines.push(`${mark} ${row.tool} (${row.feature}): ${row.detail ?? ''}`.trimEnd())
    if (row.install !== undefined) lines.push(`  install: ${row.install}`)
  }
  if (lines.length === 0) lines.push('all probed tools are present')
  for (const finding of report.findings ?? []) {
    if (finding.state === 'ok') continue
    lines.push(`${finding.state === 'warn' ? 'WARN' : 'UNKNOWN'} ${finding.id}: ${finding.detail}`)
  }
  return lines.join('\n')
}
