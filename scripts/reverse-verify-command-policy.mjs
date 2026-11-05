/**
 * Reverse verification for F-07's confirmation policy.
 *
 * Run: node scripts/reverse-verify-command-policy.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITES = ['tests/command-policy-smoke.mjs', 'tests/command-confirm-smoke.mjs']

const MUTATIONS = [
  {
    name: 'the default policy is ON (nobody asked for it)',
    file: 'lib/command-policy.js',
    find: "  mode: 'off',\n  /** When mode is 'rules', which rule sets apply. */",
    replace: "  mode: 'all',\n  /** When mode is 'rules', which rule sets apply. */",
  },
  {
    name: 'a policy naming no usable rule stays "on"',
    file: 'lib/command-policy.js',
    find: "  if (rules.length === 0) return { mode: 'off', rules: [...DEFAULT_POLICY.rules] }",
    replace: "  if (rules.length === 0) return { mode: 'rules', rules: [] }",
  },
  {
    name: 'a malformed regex disables the whole rule',
    file: 'lib/command-policy.js',
    find: "    } catch {\n      // A malformed rule must not silently disable the rest of the policy.\n      continue\n    }",
    replace: "    } catch {\n      return undefined\n    }",
  },
  {
    name: '"all" mode is ignored',
    file: 'lib/command-policy.js',
    find: "  if (policy?.mode === 'all') {",
    replace: "  if (false) {",
  },
  {
    name: 'an unanswerable confirmation proceeds instead of refusing',
    file: 'lib/command-policy.js',
    find: "    return approvalUnavailableMessage('unavailable', verdict)\n  }\n  let outcome",
    replace: "    return undefined\n  }\n  let outcome",
  },
  {
    name: 'a rejected approval runs the command anyway',
    file: 'lib/command-policy.js',
    find: "  return `the remote command was not approved, so it did not run (${verdict.reason})`",
    replace: "  return undefined",
  },
  {
    name: 'the exec tool drops the confirmation gate',
    file: 'lib/tools.js',
    find: "      const refusal = await confirmRemoteCommand({\n        approval: approvalOf?.(),\n        policyFor: () => confirmationPolicyOf(ctx),\n        command,\n        exec,\n        action: 'run a remote command',",
    replace: "      const refusal = undefined; void ({\n        approval: approvalOf?.(),\n        policyFor: () => confirmationPolicyOf(ctx),\n        command,\n        exec,\n        action: 'run a remote command',",
  },
  {
    name: 'the persistent shell drops the confirmation gate',
    file: 'lib/tools.js',
    find: "        const refusal = await confirmRemoteCommand({\n          approval: approvalOf?.(),\n          policyFor: () => confirmationPolicyOf(ctx),\n          command,\n          exec,\n          action: 'run a command in a remote shell',",
    replace: "        const refusal = undefined; void ({\n          approval: approvalOf?.(),\n          policyFor: () => confirmationPolicyOf(ctx),\n          command,\n          exec,\n          action: 'run a command in a remote shell',",
  },
]

function run () {
  let failed = 0
  for (const suite of SUITES) {
    const result = spawnSync(process.execPath, [suite], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const match = /=== (\d+) passed, (\d+) failed ===/u.exec(output)
    failed += match === null ? 1 : Number(match[2])
  }
  return { failed }
}

let allGood = true
for (const mutation of MUTATIONS) {
  const file = path.join(root, mutation.file)
  const original = readFileSync(file, 'utf8')
  if (!original.includes(mutation.find)) {
    console.log(`  SKIP  ${mutation.name}\n        (pattern no longer present)`)
    allGood = false
    continue
  }
  writeFileSync(file, original.replace(mutation.find, mutation.replace))
  try {
    const { failed } = run()
    if (failed > 0) console.log(`  RED   ${mutation.name} → ${failed} failed`)
    else { allGood = false; console.log(`  GREEN ${mutation.name} → THE SUITE DID NOT NOTICE`) }
  } finally {
    writeFileSync(file, original)
  }
}

const restored = run()
console.log(`\nrestored: ${restored.failed === 0 ? 'suite green again' : 'SUITE STILL RED'}`)
if (restored.failed !== 0 || !allGood) process.exit(1)
