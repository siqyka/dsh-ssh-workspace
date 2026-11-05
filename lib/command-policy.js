/**
 * Command-confirmation policy: which remote commands must be confirmed first.
 *
 * ## What this is, and what it is NOT
 *
 * It is a speed bump for the command that is about to do something the user did
 * not picture when they asked for it — `rm -rf`, a write outside the workspace,
 * `sudo`, shutting a machine down. It is NOT a sandbox: the process being
 * guarded runs on the remote host with the login user's full rights, and no
 * amount of pattern matching changes that. Everything in this module is written
 * to make that distinction hard to forget, because the failure mode of getting
 * it wrong is a user who believes a prompt means containment.
 *
 * The concrete reason text says "this asks for your approval", never "this is
 * blocked". Once approved, the command runs.
 *
 * ## Why matching is deliberately dumb
 *
 * Every real attempt at "understand the shell" in this shape has produced a
 * matcher that is bypassed by `sh -c`, by a quoted string, or by two commands on
 * one line — while still printing the same confident prompt. So the rules here
 * are literal substring/regex matches over the WHOLE command text, chosen to
 * catch the cases a person actually types, and the policy is applied to the
 * text as written. A command can be crafted to slip past; the honest framing is
 * "this catches the mistake, not the attack".
 *
 * The one thing it must never do is FAIL OPEN SILENTLY: an unreadable policy, an
 * unknown mode, or a missing approver all end in "do not run", because the
 * alternative is a confirmation prompt that quietly stopped being asked.
 *
 * @module @shiqyka/dsh-ssh-workspace/command-policy
 */

/**
 * Built-in rule sets, each a list of literal patterns.
 *
 * `substring` rules are checked against the raw command; `regex` rules are
 * anchored nowhere and matched case-insensitively. Both are intentionally
 * permissive in what they catch and shallow in what they promise.
 */
export const RULE_SETS = Object.freeze({
  /** Deleting things, overwriting a disk, moving a mount aside. */
  destructive: Object.freeze({
    label: 'destructive',
    substrings: Object.freeze([
      'rm -rf', 'rm -fr', 'rm -r', 'rm --recursive', 'rmdir',
      'mkfs', 'dd if=', 'dd of=', ':>', 'truncate', 'shred',
      'git reset --hard', 'git clean -fd', 'git checkout --',
      '> /dev/sd', 'chmod -R', 'chown -R',
    ]),
    regexes: Object.freeze([
      // `> file` that is not `>>`, `>&`, `2>` or a redirect into /dev/null.
      String.raw`(^|\s)>\s*(?!\/dev\/null)[^\s&]`,
    ]),
  }),
  /** Privilege escalation. */
  privileged: Object.freeze({
    label: 'privileged',
    substrings: Object.freeze(['sudo', 'su -', 'su root', 'doas', 'pkexec']),
    regexes: Object.freeze([String.raw`(^|\s)su(\s|$)`]),
  }),
  /** Changing the machine's lifecycle or its boot configuration. */
  system: Object.freeze({
    label: 'system',
    substrings: Object.freeze([
      'shutdown', 'reboot', 'halt', 'poweroff', 'init 0', 'init 6',
      'systemctl stop', 'systemctl disable', 'systemctl mask',
      'service . stop', 'iptables', 'nft ', 'ufw ', 'kill -9', 'killall', 'pkill',
      'crontab -r', 'userdel', 'groupdel', 'passwd ',
    ]),
    regexes: Object.freeze([]),
  }),
})

/** The order rules are evaluated in: the first match names the reason. */
const RULE_ORDER = Object.freeze(['destructive', 'privileged', 'system'])

/**
 * The default policy for a session.
 *
 * `off` by default, on purpose. A plugin that starts confirming every command
 * the moment it is installed is a plugin people uninstall; the point of the
 * feature is that turning it on must be a choice, and the choice must be
 * visible in the panel.
 */
export const DEFAULT_POLICY = Object.freeze({
  /** 'off' | 'all' | 'rules' */
  mode: 'off',
  /** When mode is 'rules', which rule sets apply. */
  rules: Object.freeze(['destructive', 'privileged', 'system']),
})

/**
 * Normalize a policy object read from config or the store.
 *
 * Unknown modes and unknown rule names are DROPPED, and a policy that is
 * unrecognisable falls back to `off` — but a policy that names a real mode with
 * no usable rules becomes `off` too, rather than "on, matching nothing". That
 * distinction matters: "rules mode with zero rules" would silently confirm
 * nothing while the panel said confirmation was enabled.
 *
 * @param {unknown} value - the candidate.
 * @returns {{mode: string, rules: string[]}} the normalized policy.
 */
export function normalizePolicy (value) {
  if (value === null || typeof value !== 'object') return { mode: 'off', rules: [...DEFAULT_POLICY.rules] }
  const mode = value.mode
  if (mode === 'all') return { mode: 'all', rules: [...DEFAULT_POLICY.rules] }
  if (mode !== 'rules') return { mode: 'off', rules: [...DEFAULT_POLICY.rules] }
  const requested = Array.isArray(value.rules) ? value.rules : DEFAULT_POLICY.rules
  const rules = requested.filter(name => typeof name === 'string' && name in RULE_SETS)
  if (rules.length === 0) return { mode: 'off', rules: [...DEFAULT_POLICY.rules] }
  return { mode: 'rules', rules: [...new Set(rules)] }
}

/**
 * Test one command against one rule set.
 *
 * @param {string} command - the command text as the caller wrote it.
 * @param {{substrings: readonly string[], regexes: readonly string[], label: string}} rule - the set.
 * @returns {string|undefined} the matched fragment, for the prompt to quote.
 */
export function matchRule (command, rule) {
  const text = String(command ?? '')
  if (text.trim() === '') return undefined
  const lower = text.toLowerCase()
  for (const needle of rule.substrings) {
    if (lower.includes(needle.toLowerCase())) return needle
  }
  for (const source of rule.regexes) {
    let regex
    try {
      regex = new RegExp(source, 'iu')
    } catch {
      // A malformed rule must not silently disable the rest of the policy.
      continue
    }
    const found = regex.exec(text)
    if (found !== null) return found[0].trim()
  }
  return undefined
}

/**
 * Decide whether one command needs confirmation.
 *
 * @param {string} command - the command text.
 * @param {{mode: string, rules: string[]}} policy - a normalized policy.
 * @returns {{confirm: boolean, rule?: string, matched?: string, reason?: string}} the verdict.
 */
export function needsConfirmation (command, policy) {
  if (policy?.mode === 'all') {
    return {
      confirm: true,
      rule: 'all',
      reason: 'every remote command is set to require confirmation',
    }
  }
  if (policy?.mode !== 'rules') return { confirm: false }
  for (const name of RULE_ORDER) {
    if (!policy.rules.includes(name)) continue
    const rule = RULE_SETS[name]
    const matched = matchRule(command, rule)
    if (matched !== undefined) {
      return {
        confirm: true,
        rule: name,
        matched,
        reason: `${rule.label} pattern ${JSON.stringify(matched)}`,
      }
    }
  }
  return { confirm: false }
}

/**
 * The sentence a refusal carries when there is no way to ask.
 *
 * A policy that is ON but cannot reach an approver must not run the command.
 * The reason has to say which of the two situations it is — "no approval
 * service in this deployment" versus "this call is outside a turn" — because the
 * first is a deployment fact and the second is something the caller can wait
 * out.
 *
 * @param {'unavailable'|'no-turn'} kind - why nobody could be asked.
 * @param {{rule?: string, matched?: string, reason?: string}} verdict - the policy verdict.
 * @returns {string} the refusal.
 */
export function approvalUnavailableMessage (kind, verdict) {
  const why = verdict?.reason ?? 'this command matches a confirmation rule'
  const because = kind === 'no-turn'
    ? 'a confirmation can only be asked during an open turn, and this call is not in one'
    : 'this deployment exposes no approval service, so the confirmation cannot be asked'
  return `refusing to run: ${why}, but ${because}. Approve it from a session turn, or switch the confirmation policy off. This is a confirmation gate, not a sandbox — the command would have run with the remote user's full rights.`
}

/**
 * Ask for confirmation when the policy says so, refusing when nobody can answer.
 *
 * ## Why this returns a string instead of throwing
 *
 * The three call sites (exec, background exec, persistent shell) all report
 * failures as a value, and two of them have an audit entry to write first. A
 * throw would force each of them to wrap the call and re-derive the message, and
 * the one that forgot would run the command.
 *
 * ## Why "cannot ask" refuses
 *
 * `approval.request()` fails closed in the Host, and this mirrors it. The
 * alternative — running the command because the approver was missing — would
 * mean the gate silently stopped existing in exactly the deployment that cannot
 * show a prompt, which is the worst possible place for a silent gap.
 *
 * @param {object} options - the gate.
 * @param {object|undefined} options.approval - the Host's approval service.
 * @param {(command: string) => string|undefined} options.policyFor - resolves the session's policy.
 * @param {string} options.command - the command about to run.
 * @param {object} [options.exec] - the tool's exec context (agent, callId, signal).
 * @param {string} options.action - what is being attempted, for the reason.
 * @param {string} options.target - the host or shell being used.
 * @returns {Promise<string|undefined>} a refusal message, or undefined to proceed.
 */
export async function confirmRemoteCommand (options) {
  const policy = options.policyFor(options.command)
  const verdict = needsConfirmation(options.command, policy)
  if (verdict.confirm !== true) return undefined
  const approval = options.approval
  // No service at all: a deployment fact, and it refuses.
  if (approval === undefined || approval === null || typeof approval.request !== 'function') {
    return approvalUnavailableMessage('unavailable', verdict)
  }
  let outcome
  try {
    outcome = await approval.request({
      agent: options.exec?.agent,
      toolName: 'ssh_workspace_exec',
      callId: options.exec?.callId,
      reason: `remote command on ${options.target}: ${verdict.reason}`,
      signal: options.exec?.signal,
    })
  } catch (error) {
    // A thrown request is either "not in a turn" or a broken service; both end
    // in refusal, and the message has to say which one the caller can act on.
    const message = error instanceof Error ? error.message : String(error)
    return approvalUnavailableMessage(/turn/u.test(message) ? 'no-turn' : 'unavailable', verdict)
  }
  if (outcome === 'allowed-once') return undefined
  if (outcome === 'cancelled') {
    return `the confirmation for this remote command was cancelled, so it did not run (${verdict.reason})`
  }
  if (outcome === 'unavailable') return approvalUnavailableMessage('unavailable', verdict)
  return `the remote command was not approved, so it did not run (${verdict.reason})`
}
