/**
 * The support bundle: one self-contained, redacted answer to "what is going on
 * with this plugin?".
 *
 * ## Why a bundle and not more log lines
 *
 * Everything this plugin can observe is already reachable — through
 * `ssh_workspace_status`, the panel's status route, and the diagnostics ring.
 * That is fine for the person looking at the panel and useless for a bug report:
 * a reader of an issue needs the version, the Host version, which patches
 * installed, what the recent events were, and what the host configuration looks
 * like — from one paste, not from a conversation asking for each piece.
 *
 * The bundle therefore ASSEMBLES, it does not collect: every field comes from a
 * surface that already exists, so the bundle cannot drift into reporting
 * something the status tool would not.
 *
 * ## Redaction is the whole design constraint
 *
 * This is the one artifact users are expected to paste in public. It must be
 * useful and it must be safe, and the two pull in opposite directions:
 *
 *  - paths carry usernames and project names → home segments are masked;
 *  - aliases are often the machine's own name → shortened, consistently, so
 *    events from one host still correlate;
 *  - command lines carry tokens → recorded through `audit.js`, which redacts on
 *    write;
 *  - credentials are never in the bundle at all, by construction: the store's
 *    secrets are encrypted and the bundle reads the same secret-free rows the
 *    panel shows.
 *
 * There is no "raw" switch. A bundle with a raw mode is a bundle that gets pasted
 * in raw mode, and `SECURITY.md` is explicit that this plugin does not leak what
 * it is given.
 *
 * ## What it deliberately does not do
 *
 * It does not upload anywhere, and it does not read any file the plugin would
 * not otherwise read. The user decides where it goes — the same stance as
 * `SECURITY.md`, and the reason there is no telemetry in this plugin.
 *
 * @module @shiqyka/dsh-ssh-workspace/support-bundle
 */

import { SCHEMA_VERSION } from './diagnostics.js'
import { selfCheck, renderSelfCheck } from './capabilities.js'
import { summarizeAudit } from './config-audit.js'

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
 * @param {string} alias - the host alias.
 * @returns {string} the masked alias.
 */
export function maskAlias (alias) {
  const text = String(alias ?? '')
  if (text === '') return '?'
  // One character is not enough to hide a name: `w**` from `web` is a guess
  // away. Two-character aliases are therefore masked completely rather than
  // half-revealed — a short name is the one case where a prefix leak matters.
  if (text.length <= 3) return '*'.repeat(text.length)
  return `${text.slice(0, 2)}***${text.slice(-1)}`
}

/**
 * Mask the identifying part of a path while keeping its shape.
 *
 * Keeps the first segment and the extension so a reader can still tell
 * `/home/<user>/proj/src/index.ts` from `/home/<user>/proj/dist/app.js`, which
 * is the difference between a useful report and a useless one.
 *
 * @param {string} path - the path.
 * @returns {string} the masked path.
 */
export function maskPath (path) {
  return String(path ?? '')
    .replace(/(\/home\/)[^\s/]+/gu, '$1<user>')
    .replace(/(\/Users\/)[^\s/]+/gu, '$1<user>')
    .replace(/([A-Za-z]:\\Users\\)[^\s\\]+/gu, '$1<user>')
    // A login user in front of an address (`root@10.0.0.1:22`) is identifying
    // in exactly the way the host address is not. Masked only when the thing
    // after the `@` looks like host:port, so an email address in a message is
    // left alone — a rule that hits everything with an `@` would mangle text
    // without making it any safer.
    .replace(/([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+:\d+)/gu, '<user>@$2')
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
 * @property {Array<{seq: number, at: number, kind: string, message: string, alias?: string}>} [events] - recent diagnostics.
 * @property {Array<object>} [hosts] - secret-free host rows.
 * @property {Array<{alias: string, state: string, inFlight: number}>} [connections] - pooled connections.
 * @property {Array<object>} [reconnecting] - background retry rows.
 * @property {Array<object>} [capabilities] - `{alias, tools, environment}` triples.
 * @property {string[]} [mounted] - mounted workspace paths.
 * @property {string[]} [disabled] - detached workspace paths.
 * @property {Array<object>} [forwards] - live port forwards.
 * @property {Array<object>} [commands] - audit rows (already redacted at write time).
 * @property {string} [auditText] - fallback text, used only when no rows are given.
 */

/**
 * Build the bundle.
 *
 * Sections are ordered by what a reader needs first: identity, then the
 * plugin's own judgement of itself (patches), then state, then history. A
 * reader who stops after the first screen still knows which versions are
 * involved, which is the single most common cause of "it does not reproduce".
 *
 * @param {BundleInput} input - the gathered data.
 * @returns {string} the bundle text.
 */
export function buildSupportBundle (input) {
  const lines = []
  lines.push('# dsh-ssh-workspace support bundle')
  lines.push(`bundleVersion: ${BUNDLE_VERSION}`)
  lines.push(`generatedAt: ${new Date(input.generatedAt ?? Date.now()).toISOString()}`)
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
    lines.push('none installed (or the projection seam was unavailable at startup)')
  } else {
    for (const entry of workarounds) {
      lines.push(`${entry.id}: ${entry.probe}${entry.detail === '' || entry.detail === undefined ? '' : ` (${entry.detail})`}`)
    }
  }
  lines.push('')

  // ---- hosts: secret-free, because the store rows are secret-free
  const hosts = Array.isArray(input.hosts) ? input.hosts : []
  lines.push('## hosts')
  if (hosts.length === 0) lines.push('none')
  for (const host of hosts) {
    // The address keeps the port (it matters) and masks the user, because a
    // username is identifying and a hostname alone usually is not.
    lines.push(`${maskAlias(host.alias)}: <user>@${String(host.host ?? '?')}:${String(host.port ?? '?')} auth=${String(host.auth ?? '?')} key=${host.keyReady === false ? 'missing' : 'ok'} source=${String(host.source ?? '?')}`)
    for (const entry of Array.isArray(host.unsupported) ? host.unsupported : []) {
      lines.push(`  config: ${entry.keyword} (${entry.verdict}) — ${entry.detail}`)
    }
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
    lines.push(`${maskAlias(connection.alias)}: ${String(connection.state)} (in flight ${String(connection.inFlight)})`)
  }
  for (const retry of reconnecting) {
    // The phase matters more than the numbers for a bug report: "gave-up after
    // 40 attempts" and "waiting for attempt 2" describe different problems.
    lines.push(`${maskAlias(retry.alias)}: reconnect ${String(retry.phase)} (attempt ${String(retry.attempts)})${typeof retry.lastError === 'string' && retry.lastError !== '' ? ` last error: ${maskPath(retry.lastError)}` : ''}`)
  }
  lines.push('')

  // ---- forwards
  const forwards = Array.isArray(input.forwards) ? input.forwards : []
  lines.push('## port forwards')
  if (forwards.length === 0) lines.push('none')
  for (const forward of forwards) {
    lines.push(`${String(forward.localHost)}:${String(forward.localPort)} -> ${maskAlias(forward.alias)}:${String(forward.remoteHost)}:${String(forward.remotePort)} (${String(forward.connections)} active)`)
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
      // The command text is already redacted at write time by audit.js; the
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
 * @param {string} path - the `ssh://` path.
 * @returns {string} the masked path.
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
 * @param {Array<object>} entries - the audit.
 * @returns {string} the sentence.
 */
export { summarizeAudit }
