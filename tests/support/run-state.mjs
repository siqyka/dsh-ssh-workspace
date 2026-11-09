/**
 * Classify one smoke-suite run from its exit status and captured output.
 *
 * The runner used to decide "pass or skip" solely by the presence of a line
 * beginning with SKIP. That made a suite that ran its assertions and then
 * skipped one environment-dependent section indistinguishable from a suite
 * that never ran at all. This module keeps the judgement in one place so the
 * seven outcomes below can be executed by a test rather than inferred from a
 * process exit code.
 *
 * The summary line is the only proof that a suite reached its own assertions;
 * a missing summary is therefore a failure, not a skip. The `partial` state is
 * reserved for a non-zero number of passing assertions plus a SKIP line.
 *
 * @param {{status: number|null|undefined, output?: string}} input
 * @returns {{state: 'pass'|'partial'|'skip'|'fail', passed: number, failed: number, skipLines: string[]}}
 */
export function classifySuite ({ status, output }) {
  const text = typeof output === 'string' ? output : ''
  const lines = text.split(/\r?\n/u)
  const skipLines = lines.filter(line => /^\s*SKIP\s/u.test(line))

  // A suite's own summary is the last line shaped `=== ... N passed, M failed
  // [..., K suite(s) skipped] ===`. The optional prefix admits the one suite
  // that names itself (`=== zip smoke: 237 passed, 0 failed ===`).
  const summaryLines = lines.filter(line => /^\s*===.*?(\d+)\s+passed,\s*(\d+)\s+failed.*?===\s*$/iu.test(line))
  const summary = summaryLines.length === 0 ? null : summaryLines[summaryLines.length - 1]
  const counts = summary === null
    ? null
    : /(\d+)\s+passed,\s*(\d+)\s+failed/iu.exec(summary)

  if (status !== 0 || counts === null) {
    return { state: 'fail', passed: 0, failed: 0, skipLines }
  }

  const passed = Number.parseInt(counts[1], 10)
  const failed = Number.parseInt(counts[2], 10)
  if (failed > 0) return { state: 'fail', passed, failed, skipLines }
  if (passed > 0) return { state: skipLines.length > 0 ? 'partial' : 'pass', passed, failed, skipLines }
  // Zero passing assertions is not evidence of a passing suite. A suite that
  // announces only a skip is a real skip; one that announces nothing is fail.
  return { state: skipLines.length > 0 ? 'skip' : 'fail', passed, failed, skipLines }
}
