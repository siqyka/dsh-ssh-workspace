/**
 * Reverse verification for the Future-work batch.
 *
 * Each case breaks ONE decision and asserts the suites go red. Run:
 *
 *     node scripts/reverse-verify-future.mjs
 *
 * The point is not that the suites pass — it is that they FAIL when the
 * behaviour they describe is removed. A suite that cannot fail is documentation
 * with a green checkmark, which is what this repository spent a round removing
 * (O-14).
 *
 * Every mutation is applied to a COPY of the file's text, restored in a
 * `finally`, and verified byte-identical afterwards, so a crash cannot leave the
 * tree modified.
 *
 * `expect` is the number of assertions that must go red. Getting FEWER means the
 * suite is not pinning the behaviour; getting MORE means the mutation broke
 * something else and the number is no longer evidence.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CASES = [
  {
    label: 'F-06: "unknown" is treated as "present"',
    file: 'lib/capabilities.js',
    from: "    if (value === true) {\n      rows.push({ tool: spec.tool, feature: spec.feature, state: 'present' })\n      continue\n    }",
    to: "    if (value !== undefined) {\n      rows.push({ tool: spec.tool, feature: spec.feature, state: 'present' })\n      continue\n    }",
    suite: 'capabilities-report-smoke.mjs',
    expect: 5,
    why: 'a host the probe could not reach would read as fully equipped',
  },
  {
    label: 'F-06: an absent capability loses its install hint',
    file: 'lib/capabilities.js',
    from: "        install: spec.install,",
    to: "        install: undefined,",
    suite: 'capabilities-report-smoke.mjs',
    expect: 1,
    why: 'a report that says "missing" without saying how to fix it is a red mark, not an answer',
  },
  {
    label: 'F-06: the probe goes back to a substring test',
    file: 'lib/engine.js',
    from: "      for (const tool of probedTools()) result[tool] = present.has(tool)",
    to: "      for (const tool of probedTools()) result[tool] = outcome.stdout.includes(tool)",
    suite: 'capabilities-report-smoke.mjs',
    expect: 2,
    why: 'a name appearing inside a value must not count as present',
  },
  {
    label: 'F-06: the environment facts stop travelling with the probe',
    file: 'lib/engine.js',
    from: "      this.environments.set(alias, environment)",
    to: "      this.environments.delete(alias)",
    suite: 'capabilities-report-smoke.mjs',
    // A crash counts: the suite dereferences the environment it expects.
    expect: 0,
    why: 'the self-check cannot warn about a locale or a watch limit it never kept',
  },
  {
    label: 'F-04: "lost" collapses into "ignored"',
    file: 'lib/config-audit.js',
    from: "  const known = KNOWN_UNSUPPORTED[keyword]\n  if (known !== undefined) return known",
    to: "  const known = KNOWN_UNSUPPORTED[keyword]\n  if (known !== undefined) return { verdict: 'ignored', detail: known.detail }",
    suite: 'config-audit-smoke.mjs',
    expect: 4,
    why: 'flattening "lost" into "ignored" is how "my tunnel never worked" stays unattributable',
  },
  {
    label: 'F-04: the audit stops following wildcard blocks',
    file: 'lib/config-audit.js',
    from: "      applies = positive.some(pattern => patternMatches(pattern, alias)) &&",
    to: "      applies = positive.some(pattern => pattern === alias) &&",
    suite: 'config-audit-smoke.mjs',
    expect: 2,
    why: 'a catch-all block is where LocalForward is normally declared',
  },
  {
    label: 'F-04: a repeated keyword is reported twice',
    file: 'lib/config-audit.js',
    from: "    if (seen.has(lower)) continue\n    seen.add(lower)",
    to: "    seen.add(lower)",
    suite: 'config-audit-smoke.mjs',
    expect: 1,
    why: 'OpenSSH uses the first value; the second is not a separate decision',
  },
  {
    label: 'F-07: a refused command is not recorded by the exec tool',
    file: 'lib/tools.js',
    from: "        engine.audit?.record({\n          at: Date.now(),\n          alias,\n          command,\n          channel: 'exec',\n          durationMs: 0,\n          refused: true,",
    to: "        void ({\n          at: Date.now(),\n          alias,\n          command,\n          channel: 'exec',\n          durationMs: 0,\n          refused: true,",
    suite: 'audit-smoke.mjs',
    expect: 1,
    why: 'the one case where "did anything run?" has a definite answer',
  },
  {
    label: 'F-07: redaction stops masking an Authorization header',
    file: 'lib/audit.js',
    from: "  text = text.replace(\n    /(authorization\\s*:\\s*)(?:bearer|basic|token)\\s+[A-Za-z0-9._~+/=-]+/giu,\n    (_match, header) => `${header}<redacted>`,\n  )",
    to: "  void (/(authorization\\s*:\\s*)(?:bearer|basic|token)\\s+[A-Za-z0-9._~+/=-]+/giu)",
    suite: 'audit-smoke.mjs',
    expect: 2,
    why: 'the header rule is what keeps a bearer token out of a shared log',
  },
  {
    label: 'F-07: redaction stops masking an environment assignment',
    file: 'lib/audit.js',
    from: "    /([A-Za-z0-9_-]*(?:password|passwd|passphrase|secret|token|api[_-]?key))(\\s*=\\s*)(?:\"[^\"]*\"|'[^']*'|[^\\s;|&]+)/giu,",
    to: "    /(\\bpassword\\s*=\\s*)(?:\"[^\"]*\"|'[^']*'|[^\\s;|&]+)/giu,",
    suite: 'audit-smoke.mjs',
    expect: 2,
    why: '`DB_PASSWORD=` is how an assignment is actually spelled',
  },
  {
    label: 'F-09: the bundle falls back to pre-formatted audit text',
    file: 'lib/support-bundle.js',
    from: "  const commands = Array.isArray(input.commands) ? input.commands : []",
    to: "  const commands = []",
    suite: 'support-bundle-smoke.mjs',
    expect: 4,
    why: 'formatting from rows is what masks the alias the audit text carries raw',
  },
  {
    label: 'F-09: the bundle stops masking a login user',
    file: 'lib/support-bundle.js',
    from: "    .replace(/([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+:\\d+)/gu, '<user>@$2')",
    to: "    .replace(/(?:)/gu, '')",
    suite: 'support-bundle-smoke.mjs',
    expect: 1,
    why: '`root@host:22` names the account; the address alone does not',
  },
  {
    label: 'F-01: a later generation is described as the first',
    file: 'lib/engine.js',
    from: "      return state.generation === 1\n        ? 'connected (first generation)'",
    to: "      return state.generation >= 1\n        ? 'connected (first generation)'",
    suite: 'support-bundle-smoke.mjs',
    expect: 3,
    why: 'a reconnect that reads as the first connection hides work started earlier',
  },
  {
    label: 'F-01: generationOf reads the record instead of the map',
    file: 'lib/engine.js',
    from: "    const generation = this.generations.get(alias) ?? 0",
    to: "    const generation = record?.generation ?? 0",
    suite: 'support-bundle-smoke.mjs',
    expect: 2,
    why: 'the record is replaced on reconnect, so a per-record counter resets to 1',
  },
]

let failures = 0
let passes = 0

for (const testCase of CASES) {
  const target = path.join(root, testCase.file)
  const original = readFileSync(target, 'utf8')
  if (!original.includes(testCase.from)) {
    failures += 1
    console.log(`  FAIL  ${testCase.label} — the anchor was not found in ${testCase.file}`)
    continue
  }
  try {
    writeFileSync(target, original.replace(testCase.from, testCase.to), 'utf8')
    let output
    try {
      output = execFileSync(process.execPath, [path.join(root, 'tests', testCase.suite)], { encoding: 'utf8' })
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    const red = (output.match(/^  FAIL /gmu) ?? []).length
    const crashed = output.includes('TypeError') || output.includes('ReferenceError')
    if (testCase.expect === 0) {
      // No numeric expectation: the suite must go red or crash. A mutation that
      // leaves everything green is the finding this script exists to produce.
      if (red === 0 && !crashed) {
        failures += 1
        console.log(`  FAIL  ${testCase.label} — the suite stayed green`)
        console.log(`        ${testCase.why}`)
      } else {
        passes += 1
        console.log(`  PASS  ${testCase.label} — ${crashed ? 'crashed' : `${red} assertion(s) went red`}`)
      }
      continue
    }
    if (red === testCase.expect) {
      passes += 1
      console.log(`  PASS  ${testCase.label} — ${red} assertion(s) went red`)
    } else {
      failures += 1
      console.log(`  FAIL  ${testCase.label} — expected ${testCase.expect} red, saw ${red}${crashed ? ' (crash)' : ''}`)
      console.log(`        ${testCase.why}`)
    }
  } finally {
    writeFileSync(target, original, 'utf8')
    if (readFileSync(target, 'utf8') !== original) {
      failures += 1
      console.log(`  FAIL  ${testCase.label} — the file was not restored`)
    }
  }
}

console.log(`\n=== reverse verification: ${passes} confirmed, ${failures} not ===`)
process.exit(failures === 0 ? 0 : 1)
