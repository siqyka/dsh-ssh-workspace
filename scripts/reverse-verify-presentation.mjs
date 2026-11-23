#!/usr/bin/env node
/**
 * Reverse verification for the presentation guards.
 *
 * A guard that only ever runs against correct code proves nothing. The
 * interaction checks in `presentation-tokens-smoke.mjs` are the kind that fail
 * silently: an assertion asking "is there any focus ring in the sheet" is
 * satisfied by every element the moment ONE ring exists. That is not a
 * hypothetical — it is exactly what the first version of those checks did, and
 * this script is what found it. Deleting one ring left the suite green.
 *
 * So every mutation here removes one thing the presentation work added, and the
 * suite must go red for each. A mutation that stays green is a hole, and the
 * script exits non-zero.
 *
 *   node scripts/reverse-verify-presentation.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHEET = path.join(root, 'lib', 'client', 'client.styles.js')
const SUITE = path.join(root, 'tests', 'presentation-tokens-smoke.mjs')

/** Each mutation names one edit and the failure it should cause. */
const MUTATIONS = [
  {
    what: 'a filled button loses its focus ring',
    from: '.sshwsp-toast:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: var(--sshwsp-focus-offset); }\n',
    to: '',
  },
  {
    what: 'the file action loses its focus ring',
    from: '.sshwsp-fileaction:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: var(--sshwsp-focus-offset); }\n',
    to: '',
  },
  {
    what: 'the tab label loses its hover',
    from: '.sshwsp-editor-tab-name:hover { color: var(--sshwsp-text); }\n',
    to: '',
  },
  {
    what: 'the history refresh loses its focus ring',
    from: '.sshwsp-cr-history-refresh:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: var(--sshwsp-focus-offset); }\n',
    to: '',
  },
  {
    what: 'the disclosure head loses its hover',
    from: '.sshwsp-check-head:hover:not(:disabled) { color: var(--sshwsp-text); }\n',
    to: '',
  },
  {
    what: 'a native select pins its own dark chrome again',
    from: '.sshwsp-select { cursor: pointer; }',
    to: '.sshwsp-select { cursor: pointer; color-scheme: dark; }',
  },
  {
    what: 'a rule carries a raw colour again',
    from: '.sshwsp-status { font-size: var(--sshwsp-font-2xs); padding: 2px 6px;',
    to: '.sshwsp-status { color: #4a9eff; font-size: var(--sshwsp-font-2xs); padding: 2px 6px;',
  },
  {
    what: 'a rule reads a Host token directly again',
    from: '.sshwsp-status { font-size: var(--sshwsp-font-2xs); padding: 2px 6px;',
    to: '.sshwsp-status { color: var(--dsw-alias-label-primary); font-size: var(--sshwsp-font-2xs); padding: 2px 6px;',
  },
  {
    what: 'a font size escapes the scale',
    from: '.sshwsp-status { font-size: var(--sshwsp-font-2xs);',
    to: '.sshwsp-status { font-size: 11px;',
  },
  {
    what: 'the queue panel drops out of the reduced-motion block',
    from: '  .sshwsp-toast, .sshwsp-flowmenu, .sshwsp-queuepanel, .sshwsp-dialog, .sshwsp-backdrop { animation: none; }',
    to: '  .sshwsp-toast, .sshwsp-flowmenu, .sshwsp-dialog, .sshwsp-backdrop { animation: none; }',
  },
  {
    what: 'a scrollport loses its scrollbar colours',
    from: 'overflow-y: auto; list-style: none; display: flex; flex-direction: column; gap: 2px; font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); line-height: 18px; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent;',
    to: 'overflow-y: auto; list-style: none; display: flex; flex-direction: column; gap: 2px; font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); line-height: 18px; scrollbar-width: thin;',
  },
  {
    what: 'a numeric rule loses its tabular digits',
    from: 'font-family: var(--sshwsp-mono); font-variant-numeric: tabular-nums; }',
    to: 'font-family: var(--sshwsp-mono); }',
  },
  {
    what: 'an unreachable busy modifier comes back into the sheet',
    from: '.sshwsp-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }',
    to: '.sshwsp-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }\n.sshwsp-icon-btn-busy:disabled { opacity: 1; cursor: default; }',
  },
  {
    what: 'a container query restyles its own container',
    from: '  .sshwsp-host { gap: 8px; }',
    to: '  .sshwsp { padding: 16px; }\n  .sshwsp-host { gap: 8px; }',
  },
  {
    what: 'the panel stops declaring itself a container',
    from: 'container-type: inline-size; container-name: sshwsp-panel; ',
    to: '',
  },
  {
    what: 'a portal root is dropped from the token block',
    // The queue panel is the last root before the one that closes the list, so
    // removing its line leaves the selector list syntactically valid — which is
    // the whole point: a forgotten root is not a syntax error, it is a panel
    // that silently loses every token.
    from: '.sshwsp-queuepanel,\n',
    to: '',
  },
  {
    what: 'a bare backtick ends the sheet template early',
    // This is the one that shipped. The sheet lives in a template literal, so an
    // unescaped backtick inside a CSS comment closes the string and turns the
    // remainder into a TAGGED template: `…`.sshwsp`…` parses fine, `node --check`
    // passes, `indexOf`/`lastIndexOf` still slice out the whole sheet, and every
    // text-level assertion stays green — while the chunk throws
    // `TypeError: "…".sshwsp is not a function` the moment `injectStyles` runs,
    // so the panel never registers and the sidebar comes up empty.
    from: '/* The container is .sshwsp itself',
    to: '/* The container is `.sshwsp` itself',
  },
]

const original = readFileSync(SHEET, 'utf8')
let caught = 0
let holes = 0

console.log('\npresentation guards — reverse verification\n')
for (const mutation of MUTATIONS) {
  if (!original.includes(mutation.from)) {
    console.log(`  SETUP   ${mutation.what} — anchor not found, cannot test`)
    holes++
    continue
  }
  writeFileSync(SHEET, original.split(mutation.from).join(mutation.to))
  let red = false
  try {
    execFileSync(process.execPath, [SUITE], { stdio: 'pipe' })
  } catch {
    red = true
  }
  console.log(`  ${red ? 'RED  ' : 'GREEN'}  ${mutation.what}`)
  if (red) caught++
  else holes++
}

writeFileSync(SHEET, original)
console.log(`\n=== ${caught}/${MUTATIONS.length} mutations caught, ${holes} hole(s) ===\n`)
if (holes > 0) process.exitCode = 1
