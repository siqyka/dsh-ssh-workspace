/**
 * Reverse verification for F-02's resumable upload.
 *
 * Run: node scripts/reverse-verify-resume.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MUTATIONS = [
  {
    name: 'a source that changed is resumed anyway',
    file: 'lib/resume.js',
    find: "  if (options.recordedIdentity !== options.currentIdentity) {",
    replace: '  if (false) {',
    suites: ['tests/resume-smoke.mjs'],
  },
  {
    name: 'a partial bigger than the source is resumed',
    file: 'lib/resume.js',
    find: '  if (partial > total) {',
    replace: '  if (false) {',
    suites: ['tests/resume-smoke.mjs'],
  },
  {
    name: 'a fully-staged file is treated as "nothing staged"',
    file: 'lib/resume.js',
    find: '  if (partial === total) {',
    replace: '  if (false) {',
    suites: ['tests/resume-smoke.mjs'],
  },
  {
    name: 'a sidecar with no identity is trusted',
    file: 'lib/resume.js',
    find: "  if (typeof value.identity !== 'string' || value.identity === '') return undefined",
    replace: '  if (false) return undefined',
    suites: ['tests/resume-smoke.mjs'],
  },
  {
    name: 'the staging name is randomised again (nothing to resume into)',
    file: 'lib/resume.js',
    find: '  return `${String(target).replace(/\\/+$/u, \'\')}.dsh-up-partial`',
    replace: '  return `${String(target)}.dsh-up-partial-${Math.random().toString(36).slice(2)}`',
    suites: ['tests/resume-smoke.mjs'],
  },
  {
    name: 'the resumed tail is written at offset 0 (overwrites the prefix)',
    file: 'lib/transfer.js',
    find: '          await sftpWriteHandle(sftp, handle, chunk, remotePath, written)',
    replace: '          await sftpWriteHandle(sftp, handle, chunk, remotePath)',
    suites: ['tests/transfer-smoke.mjs'],
  },
  {
    name: 'the upload ignores the resume flag',
    file: 'lib/transfer.js',
    find: '  const resumable = request.resume === true',
    replace: '  const resumable = false',
    suites: ['tests/transfer-smoke.mjs'],
  },
  {
    name: 'a failed resumable attempt throws its partial away',
    file: 'lib/transfer.js',
    find: '      if (!resumable) {\n        try { await sftpUnlink(sftp, staging) } catch { /* staging never created */ }\n      }',
    replace: '      try { await sftpUnlink(sftp, staging) } catch { /* staging never created */ }',
    suites: ['tests/transfer-smoke.mjs'],
  },
]

function run (suites) {
  let failed = 0
  for (const suite of suites) {
    const result = spawnSync(process.execPath, [suite], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, DSH_CORE_ROOT: path.join(root, 'tests/.peer-stubs') },
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const match = /=== (\d+) passed, (\d+) failed(?:, \d+ suite skipped)? ===/u.exec(output)
    if (match === null) { failed += 1; continue }
    failed += Number(match[2])
  }
  return failed
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
    const failed = run(mutation.suites)
    if (failed > 0) console.log(`  RED   ${mutation.name} → ${failed} failed`)
    else { allGood = false; console.log(`  GREEN ${mutation.name} → THE SUITE DID NOT NOTICE`) }
  } finally {
    writeFileSync(file, original)
  }
}

const restored = run(['tests/resume-smoke.mjs', 'tests/transfer-smoke.mjs'])
console.log(`\nrestored: ${restored === 0 ? 'suites green again' : `STILL ${restored} RED`}`)
if (restored !== 0 || !allGood) process.exit(1)
