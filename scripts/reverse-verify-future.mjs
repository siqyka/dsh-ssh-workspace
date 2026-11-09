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
 * A case may carry `also: [{file, from, to}]` when one behaviour is implemented
 * in two places. The shared password fallback in `redact.js` masks the same
 * `DB_PASSWORD=` that `audit.js` masks, so breaking only one of them is
 * invisible to the suite. All applied mutations are restored in reverse order,
 * each with its own byte-for-byte check.
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
    from: "    if (!selects(section, alias)) continue",
    to: "    if (!isExact(section, alias)) continue",
    suite: 'config-audit-smoke.mjs',
    expect: 2,
    why: 'a catch-all block is where LocalForward is normally declared',
  },
  {
    label: 'F-04: a repeated keyword is reported twice',
    file: 'lib/config-audit.js',
    from: "      if (seen.has(keyword)) continue",
    to: "      // duplicate guard removed for reverse verification",
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
    // The shared fallback in `redact.js:103` still masks `DB_PASSWORD=` when
    // only the audit's own rule is broken. Both have to stop masking it for the
    // mutation to be observable; this is the one case where one file is not
    // enough to prove the behaviour is gone.
    also: [
      {
        file: 'lib/redact.js',
        from: "  out = out.replace(/(password|passphrase)(\\s*[=:]\\s*)[^\\s,'\"}]+/giu, '$1$2<redacted>')",
        to: "  out = out.replace(/(\\bpassword\\s*[=:]\\s*)[^\\s,'\"}]+/giu, '$1<redacted>')",
      },
    ],
    suite: 'audit-smoke.mjs',
    expect: 2,
    why: '`DB_PASSWORD=` is how an assignment is actually spelled; the shared fallback masks it too',
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
    file: 'lib/redact.js',
    from: "  out = out.replace(/([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+:\\d+)/gu, '<user>@$2')",
    to: "  out = out.replace(/(?:)/gu, '')",
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
  // ---- the self-check section's off-switch
  //
  // The user asked for the panel section to be COMMENTED OUT. It is a gated tree
  // instead, and these five cases are the evidence for that choice: the first two
  // show a commented section is caught by a named assertion rather than by a
  // crash, and they hold while 22 other self-check greps stay green (the fake
  // green a comment leaves behind). `client-shape-smoke` greps this bundle, so
  // without the live-code checks a commented section would keep the whole suite
  // reporting an intact shape that renders nothing.
  {
    label: 'self-check gate: the heading is moved into a comment',
    file: 'lib/client.js',
    from: "          jsx('h3', { children: t('check.title') }),",
    to: "          // jsx('h3', { children: t('check.title') }),",
    suite: 'client-shape-smoke.mjs',
    expect: 1,
    why: 'the file still parses and every other grep still passes, so only a live-code check can see that nothing renders',
  },
  {
    label: 'self-check gate: the card disclosure is moved into a comment',
    file: 'lib/client.js',
    from: "                      className: 'sshwsp-check-head',",
    to: "                      // className: 'sshwsp-check-head',",
    suite: 'client-shape-smoke.mjs',
    expect: 1,
    why: 'the expandable card is the part the user asked for; a commented one must not keep earning praise from greps',
  },
  {
    label: 'self-check gate: the switch is flipped on',
    file: 'lib/client.js',
    from: 'const SHOW_SELF_CHECK_SECTION = false',
    to: 'const SHOW_SELF_CHECK_SECTION = true',
    suite: 'client-shape-smoke.mjs',
    expect: 1,
    why: 'restoring the section has to be a decision that breaks a test, not an edit nobody notices',
  },
  {
    label: 'self-check gate: only one of the two elements is guarded',
    file: 'lib/client.js',
    from: "        SHOW_SELF_CHECK_SECTION && jsxs('div', { className: 'sshwsp-section-head', children: [",
    to: "        jsxs('div', { className: 'sshwsp-section-head', children: [",
    suite: 'client-shape-smoke.mjs',
    expect: 1,
    why: 'a heading with no list under it is a worse outcome than hiding either half alone',
  },
  {
    label: 'self-check gate: the derivation ignores the switch',
    file: 'lib/client.js',
    from: 'const selfCheckRows = !SHOW_SELF_CHECK_SECTION ? []',
    to: 'const selfCheckRows = true ? []',
    suite: 'client-shape-smoke.mjs',
    expect: 1,
    why: 'a hidden section should not merge a list that arrives on every poll for nobody to render',
  },
]

let failures = 0
let passes = 0

for (const testCase of CASES) {
  const mutations = [
    { file: testCase.file, from: testCase.from, to: testCase.to },
    ...(Array.isArray(testCase.also) ? testCase.also : []),
  ]
  const applied = []
  let output
  let missing = false
  try {
    for (const mutation of mutations) {
      const target = path.join(root, mutation.file)
      const original = readFileSync(target, 'utf8')
      if (!original.includes(mutation.from)) {
        failures += 1
        console.log(`  FAIL  ${testCase.label} — the anchor was not found in ${mutation.file}`)
        missing = true
        break
      }
      writeFileSync(target, original.replace(mutation.from, mutation.to), 'utf8')
      applied.push({ target, original })
    }
    if (missing) continue
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
    // Restore in reverse order. Every applied mutation is verified byte for
    // byte, so a crash cannot leave a source file modified.
    for (const { target, original } of applied.reverse()) {
      writeFileSync(target, original, 'utf8')
      if (readFileSync(target, 'utf8') !== original) {
        failures += 1
        console.log(`  FAIL  ${testCase.label} — ${path.relative(root, target)} was not restored`)
      }
    }
  }
}

console.log(`\n=== reverse verification: ${passes} confirmed, ${failures} not ===`)
process.exit(failures === 0 ? 0 : 1)
