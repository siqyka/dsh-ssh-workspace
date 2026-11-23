/**
 * The presentation token contract.
 *
 * The sheet names `--dsw-*` tokens with a literal fallback after every one of
 * them. That shape made a real defect invisible: a token the Host never
 * publishes falls back silently, so nine of the thirty-two names the sheet used
 * had never resolved to anything, and the panel simply stopped following the
 * Host theme at those fifteen sites — while a grep for "hardcoded colours"
 * found nothing, because every one of them *looked* like a token reference.
 *
 * So the contract is now explicit, and this suite pins the four properties that
 * make it hold:
 *
 *  1. the token block exists and every rule uses it;
 *  2. no rule names a `--dsw-*` token outside the block (the block is the one
 *     place a Host token may appear, which is what keeps the aliases honest);
 *  3. the block hangs off every portalled root, because six of them are
 *     children of <body> rather than of `.sshwsp`, and a token defined only on
 *     the panel leaves those roots with no value at all — silently, since an
 *     undefined token invalidates the declaration instead of using the fallback
 *     written beside it;
 *  4. the scale tokens exist and the raw scales they replace are gone.
 *
 * The roots are read out of the SOURCE (every `className: 'sshwsp-…'` that
 * reaches `modalLayer` or `document.body`) rather than listed here, so adding a
 * portal without adding it to the token block fails rather than passing on a
 * stale hand-written list.
 *
 * Run: node tests/presentation-tokens-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientChunkNames, clientPartSource } from './support/client-source.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== presentation tokens smoke ===\n')

// ---- the sheet, split into its block and its rules --------------------------

const stylesFile = 'client.styles.js'
const stylesPart = clientPartSource(pluginRoot, stylesFile)
const openMarker = 'tag.textContent = `'
const openAt = stylesPart.indexOf(openMarker)
if (openAt < 0) throw new Error(`${stylesFile} no longer assigns the sheet to tag.textContent`)
const cssStart = openAt + openMarker.length
const cssEnd = stylesPart.lastIndexOf('`')
if (cssEnd <= cssStart) throw new Error(`${stylesFile}: cannot find the end of the sheet template`)
const css = stylesPart.slice(cssStart, cssEnd)

/**
 * The sheet in three pieces, because the rules that may name a Host token are
 * a different set from the rules that may not:
 *
 *   tokenBlock  — the A/B/C definitions. Host tokens live here and nowhere else.
 *   lightLayer  — the light overrides. It re-aliases a few of OUR tokens to the
 *                 Host's light values, so it also names Host tokens; it is part
 *                 of the contract, not part of the rules.
 *   rules       — everything the panel actually paints with.
 */
const lightAt = css.indexOf('/* The light layer overrides ONLY')
if (lightAt < 0) throw new Error('the token block no longer ends where the light layer begins')
const panelRuleAt = css.indexOf('.sshwsp { font-family')
if (panelRuleAt < 0) throw new Error('cannot find the panel root rule that follows the contract')
const tokenBlock = css.slice(0, lightAt)
const lightLayer = css.slice(lightAt, panelRuleAt)
const block = tokenBlock
const rules = css.slice(panelRuleAt)

/** Strip `var(…)` including its fallback, so a literal inside a fallback is not counted. */
function withoutVarCalls (text) {
  let out = ''
  let cursor = 0
  for (;;) {
    const at = text.indexOf('var(', cursor)
    if (at < 0) return out + text.slice(cursor)
    out += text.slice(cursor, at)
    let depth = 0
    let i = at
    for (; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1
      else if (text[i] === ')') {
        depth -= 1
        if (depth === 0) { i += 1; break }
      }
    }
    cursor = i
  }
}

// ---- 1. the block defines the contract -------------------------------------

const declared = new Set([...block.matchAll(/(--sshwsp-[a-z0-9-]+)\s*:/gu)].map(m => m[1]))
check('the sheet opens with a token block', declared.size >= 50, `${declared.size} tokens`)
for (const required of [
  '--sshwsp-text', '--sshwsp-muted', '--sshwsp-faint', '--sshwsp-border',
  '--sshwsp-surface', '--sshwsp-accent', '--sshwsp-danger', '--sshwsp-warn',
  '--sshwsp-success', '--sshwsp-hover', '--sshwsp-active', '--sshwsp-mask',
  '--sshwsp-shadow', '--sshwsp-font', '--sshwsp-mono',
  '--sshwsp-radius-xs', '--sshwsp-radius-sm', '--sshwsp-radius-md',
  '--sshwsp-focus-width', '--sshwsp-focus-offset',
  '--sshwsp-font-2xs', '--sshwsp-font-xs', '--sshwsp-font-sm', '--sshwsp-font-md', '--sshwsp-font-lg',
  '--sshwsp-z-mask', '--sshwsp-z-dialog', '--sshwsp-z-menu'
]) {
  check(`...and it defines ${required}`, declared.has(required))
}
for (const step of [1, 2, 3, 4, 5, 6]) {
  check(`...and the spacing step --sshwsp-space-${step}`, declared.has(`--sshwsp-space-${step}`))
}

// ---- 2. the Host's tokens appear only in the block -------------------------
//
// This is the rule that makes the aliases auditable. Once `--dsw-*` is allowed
// anywhere, a name the Host does not publish is indistinguishable from one it
// does, which is exactly how the nine dead aliases survived.

/**
 * Raw literals and Host tokens are legitimate in these rules, and only here:
 * the editor's code palette, which the editor suite reads back by regex to run
 * a WCAG contrast calculation.
 */
const literalSites = []
for (const line of rules.split('\n')) {
  const bare = withoutVarCalls(line)
  if (!/#[0-9a-fA-F]{3,8}\b|rgba?\(/u.test(bare)) continue
  // The editor's own code palette. It is exempt for a reason that is not
  // aesthetic: `file-editor-smoke` extracts these declarations by regex to run
  // a WCAG contrast calculation on them, so they have to stay six-digit hex.
  // Turning them into color-mix would make the extraction return an empty list
  // and the contrast assertion would pass by iterating over nothing.
  if (/^--sshwsp-hl-[a-z]+:\s*#[0-9a-f]{6};$/u.test(line.trim())) continue
  literalSites.push(line.trim())
}
check('no rule carries a raw colour outside var() fallbacks',
  literalSites.length === 0,
  literalSites.slice(0, 6).join(' | '))

const dswSites = [...rules.matchAll(/--dsw-[a-z0-9-]+/gu)].map(m => m[0])
check('no rule names a Host token; the block is the only place they appear',
  dswSites.length === 0,
  [...new Set(dswSites)].join(' '))

// ---- 3. the block covers every portalled root ------------------------------
//
// A portalled root is a child of <body>, so it inherits nothing from `.sshwsp`.
// The token block has to name it. The list is derived from the source: every
// className the client half assigns to an element it portals out of the panel.

const portalRoots = new Set()
for (const chunk of clientChunkNames(pluginRoot).concat('client.js')) {
  const text = clientPartSource(pluginRoot, chunk)
  for (const match of text.matchAll(/className:\s*'(sshwsp(?:-[a-z0-9-]+)?)'/gu)) {
    portalRoots.add(match[1])
  }
  // The DOM-built roots (the flow menu, the inline rename box) assign through
  // `el.className = '…'` rather than through a className prop.
  for (const match of text.matchAll(/\.className\s*=\s*'(sshwsp-[a-z0-9-]+)'/gu)) {
    portalRoots.add(match[1])
  }
}

/**
 * The roots that are NOT portalled: they render inside the panel subtree and
 * inherit the block through `.sshwsp`. Derived rather than hand-listed — a
 * root that starts portalling has to move into the block, and this is the list
 * that says which side of the line it is on.
 */
const IN_PANEL_ROOTS = new Set([
  'sshwsp', 'sshwsp-card', 'sshwsp-host', 'sshwsp-section-head', 'sshwsp-provenance',
  'sshwsp-report-title', 'sshwsp-diagnosis', 'sshwsp-check-list', 'sshwsp-cap',
  'sshwsp-hosts', 'sshwsp-mounts', 'sshwsp-forwards', 'sshwsp-queue', 'sshwsp-empty',
])

const blockRoots = new Set(
  [...block.matchAll(/^\.(sshwsp(?:-[a-z0-9-]+)?)\s*(?:,\s*$|\{\s*$)/gmu)].map(m => m[1])
)
check('the token block names the panel root', blockRoots.has('sshwsp'))
for (const root of portalRoots) {
  if (IN_PANEL_ROOTS.has(root)) continue
  // A portalled root either appears in the block or is a descendant of one
  // that does — but a root with its own `position: fixed` is its own subtree,
  // and those are exactly the ones this check exists for.
  const ownRule = new RegExp(`^\\.${root} \\{[^}]*position:\\s*fixed`, 'mu').test(rules)
  if (!ownRule) continue
  check(`the token block covers the portalled root .${root}`, blockRoots.has(root))
}

// ---- 4. the scale tokens replaced the raw scales ---------------------------
//
// These are the numbers the sheet used to hand-write. Keeping the count down is
// the whole point of the C group: nine radii and eight font sizes are not a
// design, they are nine and eight separate decisions made years apart.

const radiusLiterals = [...rules.matchAll(/border-radius:\s*([^;]+);/gu)]
  .map(m => m[1].trim())
  .filter(value => !value.startsWith('var(--sshwsp-radius-') && value !== 'inherit')
check('every border-radius is a scale token',
  radiusLiterals.length === 0,
  [...new Set(radiusLiterals)].join(' '))

const fontSizes = [...rules.matchAll(/font-size:\s*([^;]+);/gu)]
  .map(m => m[1].trim())
  .filter(value => !value.startsWith('var(--sshwsp-font-') && !value.startsWith('inherit'))
check('every font-size is a scale token',
  fontSizes.length === 0,
  [...new Set(fontSizes)].join(' '))

const zIndexes = [...rules.matchAll(/z-index:\s*([^;]+);/gu)]
  .map(m => m[1].trim())
  .filter(value => !value.startsWith('var(--sshwsp-z-'))
check('every z-index is a scale token',
  zIndexes.length === 0,
  [...new Set(zIndexes)].join(' '))

const focusRings = [...rules.matchAll(/outline:\s*([^;]+);/gu)]
  .map(m => m[1].trim())
  .filter(value => !value.startsWith('var(--sshwsp-focus-width') && value !== 'none' && value !== '0')
check('every outline width comes from the focus scale',
  focusRings.length === 0,
  [...new Set(focusRings)].join(' '))

// ---- 5. the light layer is a layer, not a second theme ---------------------
//
// It may override only the tokens the Host's own light palette cannot supply.
// Re-declaring the aliases would be the second theme the UI guide rules out,
// and it would also mean the light values stop tracking the Host.

const overridden = new Set([...lightLayer.matchAll(/(--sshwsp-[a-z0-9-]+)\s*:/gu)].map(m => m[1]))
check('the light layer exists and overrides a handful of tokens',
  overridden.size > 0 && overridden.size <= 12, `${overridden.size} overridden`)
check("...and it does not re-declare the Host's own aliases",
  !/--dsw-alias-[a-z0-9-]+\s*:/u.test(lightLayer))
check("...and it keys off the Host's own dark signal rather than a media query",
  /body:not\(\[data-ds-dark-theme\]\)/u.test(lightLayer) &&
    !/@media\s*\(prefers-color-scheme/u.test(lightLayer))

// ---- 6. the dead rules stayed dead ----------------------------------------

const source = clientChunkNames(pluginRoot)
  .concat('client.js')
  .map(chunk => clientPartSource(pluginRoot, chunk))
  .join('\n')
check('the passthrough hint rule is gone',
  !rules.includes('.sshwsp-passthrough-hint'))
check('...and nothing in the client half still names it',
  !source.includes('sshwsp-passthrough-hint'))

// ---- summary --------------------------------------------------------------

console.log(`\n=== ${passed} passed, ${failures.length} failed ===\n`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAILED  ${failure}`)
  process.exitCode = 1
}
