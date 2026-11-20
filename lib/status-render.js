/**
 * The rendered text of the status tool.
 *
 * Split out of the tool definition for the same reason the schema was: the
 * renderer is wording, and every branch of it is a sentence about a fact in
 * the result. Keeping it beside the tool made one function out of what is
 * really a contract, a renderer and a gatherer.
 *
 * The wording is part of the contract: the panel and this renderer answer the
 * same question, and a second phrasing of "is anything wrong?" is exactly the
 * drift this module exists to prevent.
 *
 * @module @shiqyka/dsh-ssh-workspace/status-render
 */

import { text } from './tool-result.js'

/**
 * Render a status result as the single text block the tool returns.
 *
 * @param {object} value - a status result, already projected onto the schema.
 * @returns {Array<{type: string, text: string}>} the content block.
 */
export function renderStatus (value) {
  const lines = [`fs serves remote paths: ${value.fsPatched ? 'yes' : 'no'}`]
  // The verdict leads, because it is the answer to the question the
  // caller actually asked. A tool that prints state and leaves the
  // reader to judge it is the shape this module exists to replace — the
  // report and the panel both answer "is anything wrong?", so the tool
  // does too, in the same words.
  if (value.diagnosis !== undefined) {
    for (const line of String(value.diagnosis.text ?? '').split('\n')) lines.push(line)
    lines.push('')
  }
  // Lead with the warning: a key that is trusted but not pinned means the
  // next connection will trust whatever the server presents again.
  for (const entry of value.unpinnedHostKeys ?? []) {
    lines.push(`WARNING: the host key for ${entry.alias} could not be saved (${entry.keyType} ${entry.fingerprint}) — it was accepted this time but is NOT pinned; the next connection will trust this key again on first use`)
  }
  lines.push(`mounted remote workspaces: ${value.mounted.length === 0 ? 'none' : ''}`)
  for (const root of value.mounted) lines.push(`  ${root}`)
  if ((value.disabled ?? []).length > 0) {
    lines.push('detached remote workspaces (not served; sessions kept and greyed):')
    for (const path of value.disabled) lines.push(`  ${path}`)
  }
  lines.push(`live SSH connections: ${value.connections.length === 0 ? 'none' : ''}`)
  for (const connection of value.connections) {
    lines.push(`  ${connection.alias}: ${connection.state} (in flight ${connection.inFlight})`)
    // Only a reconnect is worth a sentence. "generation 1" is the
    // ordinary case and saying it every call is noise; generation 2+
    // means work started earlier may still be running over there, and
    // that is exactly the fact a reader needs and cannot infer.
    if ((connection.generation ?? 1) > 1 && typeof connection.generationNote === 'string' && connection.generationNote !== '') {
      lines.push(`    ${connection.generationNote}`)
    }
  }
  // Only the hosts that are NOT connected need explaining; a healthy row
  // would make this section noise on every call.
  for (const retry of value.reconnecting ?? []) {
    if (retry.phase === 'gave-up') {
      lines.push(`reconnect STOPPED for ${retry.alias} after ${retry.attempts} attempt(s): ${retry.lastError}`)
    } else if (retry.phase === 'waiting') {
      const inSeconds = Math.max(0, Math.round((retry.nextAt - Date.now()) / 1000))
      lines.push(`reconnecting to ${retry.alias}: attempt ${retry.attempts} in ${inSeconds}s${retry.lastError === '' ? '' : ` (last error: ${retry.lastError})`}`)
    } else {
      lines.push(`reconnecting to ${retry.alias}: attempt ${retry.attempts} in progress`)
    }
  }
  lines.push(`port forwards: ${(value.forwards ?? []).length === 0 ? 'none' : ''}`)
  for (const forward of value.forwards ?? []) {
    lines.push(`  ${forward.id}: ${forward.localHost}:${forward.localPort} → ${forward.alias}:${forward.remoteHost}:${forward.remotePort} (${forward.connections} active)`)
  }
  if ((value.reverseForwards ?? []).length > 0) {
    lines.push('reverse port forwards (remote listeners → this machine):')
    for (const forward of value.reverseForwards) {
      lines.push(`  ${forward.id}: ${forward.alias}:${forward.remoteHost}:${forward.remotePort} → ${forward.localHost}:${forward.localPort} (${forward.connections} active)${forward.exposed ? ' [EXPOSED beyond the host]' : ''}`)
    }
  }
  if ((value.shells ?? []).length > 0) {
    lines.push('persistent remote shells:')
    for (const shell of value.shells) lines.push(`  ${shell.alias} [${shell.session}]: ${shell.alive ? 'live' : 'closed'}`)
  }
  // What each probed host can do. The rows come pre-rendered so the tool
  // and the panel cannot drift into two wordings for one fact; only the
  // hosts with something to say are printed, because "everything present"
  // on every status call is noise.
  for (const check of value.selfCheck ?? []) {
    if ((check.missing ?? []).length === 0 && !/UNKNOWN|WARN/u.test(check.text)) continue
    lines.push(`self-check for ${check.alias}:`)
    for (const line of check.text.split('\n')) lines.push(`  ${line}`)
  }
  // The command record. Only the failures and refusals get a line: a
  // successful `ls` is not news, while "this was refused" and "this
  // exited 1" are what a reader needs when reconstructing what happened.
  const noteworthy = (value.commands ?? []).filter(command => command.refused === true || command.outcomeUnknown === true || command.timedOut || (command.exitCode ?? 0) !== 0)
  if (noteworthy.length > 0) {
    lines.push('recent remote commands that failed or were refused:')
    for (const command of noteworthy.slice(-10)) {
      const status = command.refused === true
        ? 'REFUSED (nothing ran)'
        : command.outcomeUnknown === true
          ? 'outcome unknown (the connection died)'
          : command.timedOut
            ? 'timed out'
            : `exit ${command.exitCode}`
      lines.push(`  ${command.alias}: ${status} — ${command.command}`)
    }
  }
  // Only the states that need a human are spelled out; the normal ones
  // (`broken` = still load-bearing, `pending` = not registered yet) would
  // otherwise be noise on every single call.
  for (const workaround of value.upstreamWorkarounds ?? []) {
    if (workaround.probe === 'fixed') {
      lines.push(`upstream workaround OBSOLETE: ${workaround.id} — the Host no longer needs it, delete it (${workaround.detail})`)
    } else if (workaround.probe === 'unprobeable' || workaround.probe === 'disabled') {
      lines.push(`upstream workaround ${workaround.probe.toUpperCase()}: ${workaround.id} — ${workaround.detail}`)
    }
  }
  // A seam that did not install is the mirror image: the feature is gone
  // while everything else looks alive. `absent` is not printed — it means
  // the composition does not mount that service, which is a correct
  // deployment, not a symptom.
  for (const seam of value.seams ?? []) {
    if (seam.state === 'failed') {
      lines.push(`SEAM NOT INSTALLED: ${seam.id} — ${seam.detail}`)
    }
  }
  return text(lines.join('\n'))
}
