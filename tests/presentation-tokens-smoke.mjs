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
import vm from 'node:vm'
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

// ---- 0. the sheet the runtime produces IS the sheet checked below -----------
//
// Everything after this point reads the CSS as TEXT, and text survives a broken
// template. A stray unescaped backtick inside the sheet — four of them shipped
// in the container-query comment — turns the template into a tagged template:
//
//     `.sshwsp` itself, so nothing here may style `.sshwsp`:
//
// parses as `` `...`.sshwsp`...` `` — legal JavaScript, so `node --check` passes,
// and `indexOf`/`lastIndexOf` still slice out the whole stylesheet, so every
// text-level assertion below passed while the panel did not render at all. The
// chunk threw `TypeError: "…".sshwsp is not a function` inside `injectStyles`,
// which the module system reported as a failed chunk load; the panel never
// registered and the sidebar came up empty.
//
// So the sheet is EXECUTED here, not merely sliced: the chunk runs in a vm
// against a stub `document`, its factory is called, `injectStyles()` runs, and
// the text it writes must be the text this suite validated. A check that only
// reads source cannot tell "the sheet is this CSS" from "the sheet is this CSS
// followed by a syntax error that throws before it is used".
const sheetRuntime = await (async () => {
  let registrations
  const written = []
  const tag = { dataset: {}, textContent: '' }
  const document = {
    querySelector: () => null,
    createElement: () => {
      written.push(tag)
      return tag
    },
    head: { appendChild: () => {} },
  }
  registrations = []
  const context = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    document,
    console,
    Symbol,
    Object,
  }
  vm.createContext(context)
  try {
    vm.runInContext(stylesPart, context, { filename: stylesFile })
    const registration = registrations[0]
    if (registration === undefined) throw new Error('the chunk registered nothing')
    const exported = registration.factory(() => {
      throw new Error('the stylesheet chunk must not require anything')
    })
    exported.injectStyles()
  } catch (error) {
    return { error }
  }
  return { text: tag.textContent }
})()

check('the sheet template evaluates, so injectStyles reaches the end',
  sheetRuntime.error === undefined,
  sheetRuntime.error === undefined ? undefined : `${sheetRuntime.error.name}: ${sheetRuntime.error.message}`)

// The escape sequences are the ONLY difference the template makes to the text,
// and the sheet uses exactly one kind (`` \` ``). Comparing unescaped-to-written
// keeps this honest if a second kind is ever introduced: it will show up as a
// mismatch here rather than as a stylesheet that silently differs from the one
// under test.
const sheetAsWritten = css.replace(/\\(.)/gsu, '$1')
check('...and what it writes is the sheet the checks below read',
  sheetRuntime.error !== undefined || sheetRuntime.text === sheetAsWritten,
  sheetRuntime.error !== undefined
    ? undefined
    : `written ${sheetRuntime.text.length} chars, checked ${sheetAsWritten.length}`)
// A bare backtick is the specific mistake, and it is worth naming directly:
// the failure mode above is a one-character edit whose symptom (a missing
// panel) points nowhere near the file that caused it. Escaped ones are the
// intended spelling, so the check counts backticks that are NOT preceded by an
// odd number of backslashes.
const bareBackticks = [...css.matchAll(/(?<!\\)(?:\\\\)*\u0060/gu)]
check('the sheet holds no bare backtick',
  bareBackticks.length === 0,
  'escape it as \\` — an unescaped one ends the template and turns the rest into a tagged template')

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

// The client source is read once, here, because the interaction check below
// needs to know which classes are rendered on the same element.
const source = clientChunkNames(pluginRoot)
  .concat('client.js')
  .map(chunk => clientPartSource(pluginRoot, chunk))
  .join('\n')

// ---- 5b. every clickable class answers the pointer and the keyboard -------
//
// The sheet itself says which classes are clickable: `cursor: pointer` is the
// declaration the user actually sees. So the list is derived, not hand-written,
// and a new interactive class cannot be added without its two states. Both are
// required because they fail differently: a missing hover makes the control
// look inert, a missing ring makes it invisible to a keyboard user, and the
// second one is the one nobody notices while clicking.
//
// The states are checked per ELEMENT, not per class, because an element carries
// several classes and any of them may supply the rule: `sshwsp-entry
// sshwsp-entry-dir` gets its hover from the second class and its ring from the
// first, and asking either class on its own would report a gap that the user
// never sees.

const escapeClass = (name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
// The pseudo may be qualified (`:hover:not(:disabled)`) or followed by an
// attribute selector, so it is not required to be followed by a separator.
const answers = (cls, pseudo) => new RegExp(`${escapeClass(cls)}${pseudo}(?![-a-z])`, 'u').test(rules)

/**
 * Classes that legitimately have no hover or ring of their own, with the reason.
 * Kept short on purpose: the assertion below fails if it grows, so an exemption
 * has to be argued for rather than appended.
 */
const stateExempt = new Map([
  // A <label> wrapping a native checkbox. The ring belongs to the checkbox,
  // which the browser draws; a ring on the label would draw a second one.
  ['.sshwsp-check', 'label around a native checkbox'],
  // A native <select>. The browser owns its states AND its dropdown, which is
  // why it cannot take a themed ring without also losing the native list.
  ['.sshwsp-select', 'native select'],
])

const clickable = new Set()
for (const rule of rules.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/gu)) {
  if (!/cursor:\s*pointer/u.test(rule[3])) continue
  for (const part of rule[2].split(',')) {
    const selector = part.trim()
    // Only a bare class is the element that receives the click. A descendant
    // selector's pointer belongs to its last compound, which is not this name.
    if (/^\.[a-z0-9-]+$/u.test(selector)) clickable.add(selector)
  }
}

/**
 * Every class set the source actually renders, so the states can be checked per
 * element. Both spellings are read: JSX passes `className:` a value, and the
 * DOM controller assigns `.className =` directly. Reading only the first one
 * reported the toast as unrendered — it is built by hand, not by JSX.
 */
const renderedGroups = [
  ...source.matchAll(/className:\s*'([^']*sshwsp[^']*)'/gu),
  ...source.matchAll(/\.className = '([^']*sshwsp[^']*)'/gu),
].map(match => match[1].split(/\s+/u).filter(name => name.startsWith('sshwsp')))
// `clickable` holds selectors, so it carries the leading dot; the rendered
// groups hold bare class names. Compare them in the same shape.
const coveredByAGroup = (selector) => {
  const name = selector.slice(1)
  return renderedGroups.some(group => group.includes(name))
}

const interactive = [...clickable].filter(cls => !stateExempt.has(cls))
const uncovered = interactive.filter(cls => !coveredByAGroup(cls))
check('every clickable class is rendered by the source',
  uncovered.length === 0, uncovered.join(' '))

/**
 * Does any element that carries `cls` get `pseudo` from one of its classes?
 *
 * The `cls` has to be part of the question. An earlier version asked "is there
 * any rendered class with a ring anywhere", which passed for every element as
 * soon as ONE ring existed in the sheet — a reverse-verification mutation that
 * deleted a single ring stayed green, which is how the hole was found.
 */
const elementAnswers = (cls, pseudo) => {
  const name = cls.slice(1)
  return renderedGroups
    .filter(group => group.includes(name))
    .some(group => group.some(member => answers(`.${member}`, pseudo)))
}

const noHover = interactive.filter(cls => !elementAnswers(cls, ':hover')).sort()
const noRing = interactive.filter(cls => !elementAnswers(cls, ':focus-visible')).sort()

check('the sheet still declares which classes are clickable',
  clickable.size >= 10, `${clickable.size} classes`)
check('the interactive-state exemptions stay few and argued',
  stateExempt.size <= 4, `${stateExempt.size} exemptions`)
check('every clickable element answers the pointer',
  noHover.length === 0, noHover.join(' '))
check('...and every clickable element answers the keyboard',
  noRing.length === 0, noRing.join(' '))

// ---- 5c. a native control does not repaint itself in the wrong theme ------
//
// `color-scheme: dark` on a <select> paints the browser's own dropdown chrome
// dark. In the light layer that produced a black list inside a white dialog,
// which no token can fix because the browser owns that surface. The document
// root already carries the resolved scheme, so the control inherits it.

check('the select does not pin its own color-scheme',
  !/color-scheme:\s*(?:dark|light)\s*;/u.test(rules))

// ---- 5d. every animation can be turned off -------------------------------
//
// `prefers-reduced-motion` is a request, not a hint: a user who sets it gets
// motion sickness from a sliding panel. The failure mode is an omission, not a
// mistake — the queue panel shared `sshwsp-menu-in` with the flow menu and was
// simply left out of the block — so the check is derived: every selector that
// declares an animation must also appear in a reduced-motion block, and every
// @keyframes must be reachable from one of those selectors.

/**
 * Split a captured selector group into its real selectors.
 *
 * The capture starts at the newline after the previous rule, so it can contain
 * a `/* … *​/` comment whose text includes commas, parentheses and even the word
 * "animation". Stripping comments first and THEN splitting is the only order
 * that works; splitting first produced fragments like "the overwrite policy)".
 */
const splitSelectors = (group) => group
  .replace(/\/\*[\s\S]*?\*\//gu, ' ')
  .split(',')
  .map(part => part.trim())
  .filter(part => part !== '' && !part.startsWith('@'))

const animatedSelectors = new Set()
for (const rule of rules.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/gu)) {
  if (!/animation:\s*(?!none)/u.test(rule[3])) continue
  for (const selector of splitSelectors(rule[2])) animatedSelectors.add(selector)
}
const reducedBlocks = [...rules.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/gu)]
  .map(match => match[1])
  .join('\n')
const uncoveredAnimations = [...animatedSelectors].filter(selector => !reducedBlocks.includes(selector))
check('the sheet still animates something, so this check has a subject',
  animatedSelectors.size > 0, `${animatedSelectors.size} animated selectors`)
check('every animated selector is turned off under reduced motion',
  uncoveredAnimations.length === 0, uncoveredAnimations.join(' | '))

const keyframeNames = [...rules.matchAll(/@keyframes ([a-z-]+)/gu)].map(match => match[1])
const orphanedKeyframes = keyframeNames.filter(name => !new RegExp(`animation:[^;]*${name}`, 'u').test(rules))
check('every @keyframes is used by an animation',
  orphanedKeyframes.length === 0, orphanedKeyframes.join(' '))

// ---- 5e. the scrollbars are ours, not the platform's ---------------------
//
// The panel paints its own scrollbars because the platform default is a light
// trough, which in a dark panel is the most visible place it stops looking
// like part of the app. The standard pair is the real mechanism; the webkit
// block is the fallback and must stay confined to it.

const scrollports = [...rules.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^}]*overflow(?:-[xy])?:\s*auto[^}]*)\}/gu)]
  .map(rule => splitSelectors(rule[2]))
  .flat()
  .filter(selector => selector.startsWith('.'))
const unpaintedScrollports = scrollports.filter(selector => {
  const body = new RegExp(`${escapeClass(selector)} \\{([^}]*)\\}`, 'u').exec(rules)?.[1] ?? ''
  return !/scrollbar-color:/u.test(body)
})
check('the panel still has scrollports to paint',
  scrollports.length >= 4, `${scrollports.length} scrollports`)
check('every scrollport names its own scrollbar colours',
  unpaintedScrollports.length === 0, unpaintedScrollports.join(' | '))
check('the scrollbar colour comes from the track token',
  /scrollbar-color: var\(--sshwsp-track\) transparent/u.test(rules))
check('the webkit fallback stays a fallback',
  // A ::-webkit-scrollbar selector outside the panel roots would style the
  // Host's own scrollbars too, which is not ours to paint.
  [...rules.matchAll(/[^{}\n]*::-webkit-scrollbar[^{]*\{/gu)]
    .every(match => /^\.sshwsp(?:-editor-panel)? /u.test(match[0].trim()) || /^\.sshwsp-editor-panel /u.test(match[0].trim())))

// ---- 5f. numbers that are compared down a column do not shift -------------
//
// Proportional digits change width between "8" and "10", so a column of file
// sizes or ports jitters as it updates. `tabular-nums` is what makes them line
// up. The set is derived from the rules that name a size/meta class, so a new
// one has to opt in rather than be remembered.

// `status` is deliberately absent: those chips hold words ("connected",
// "failed"), and tabular digits on prose just make it look mechanical.
const numericRule = /^\.sshwsp-(?:[a-z-]*-)?(?:meta|size|speed|count|gutter|sha|port|note|progress)$/u
const numericRules = [...rules.matchAll(/(^|\n)(\.[a-z0-9-]+)[^{}\n]*\{([^}]*)\}/gu)]
  .filter(rule => numericRule.test(rule[2]))
  .filter(rule => /font-size|font-family/u.test(rule[3]))
const withoutTabular = numericRules
  .filter(rule => !/font-variant-numeric:\s*tabular-nums/u.test(rule[3]))
  .map(rule => rule[2])
check('the numeric rules exist, so this check has a subject',
  numericRules.length >= 5, `${numericRules.length} rules`)
check('every numeric text rule uses tabular digits',
  withoutTabular.length === 0, [...new Set(withoutTabular)].join(' '))

// ---- 5g. the panel reflows on its own width, not the window's -------------
//
// The panel sits in a sidebar the user drags narrow, so the window can be wide
// while the panel is 300px. Only a container query reacts to that, and it
// reacts only to DESCENDANTS of the container — a rule inside the query that
// styles the container itself silently does nothing, which is a failure mode
// with no symptom.

check('the panel declares itself a container',
  /\.sshwsp \{[^}]*container-type: inline-size/u.test(rules))
check('...and gives the container a name, so a nested one cannot capture the query',
  /\.sshwsp \{[^}]*container-name: sshwsp-panel/u.test(rules))

const containerBlocks = [...rules.matchAll(/@container sshwsp-panel \(width < (\d+)px\) \{([\s\S]*?)\n\}/gu)]
check('the panel has narrow-width queries',
  containerBlocks.length >= 2, `${containerBlocks.length} blocks`)
check('...and none of them styles the container itself',
  containerBlocks.every(block => !/^\s*\.sshwsp\s*\{/mu.test(block[2])),
  'a container query cannot restyle its own container')
check('...and they are ordered narrow-last, so the tighter one wins',
  containerBlocks.every((block, index) =>
    index === 0 || Number(block[1]) < Number(containerBlocks[index - 1][1])))

// ---- 6. the dead rules stayed dead ----------------------------------------

check('the passthrough hint rule is gone',
  !rules.includes('.sshwsp-passthrough-hint'))
check('...and nothing in the client half still names it',
  !source.includes('sshwsp-passthrough-hint'))

// A rule with no producer is worse than no rule: it is evidence of a state the
// UI cannot reach, and the test that pins it makes the next reader believe the
// state exists. This is the second one found (the first was the passthrough
// hint), so the check is written to catch the class of problem rather than the
// instance: every `-busy`, `-loading` and `-pending` modifier must be produced
// somewhere in the source, or it does not belong in the sheet.
//
// The producer must be found OUTSIDE the stylesheet. Searching `source` alone
// found the rule's own class name and passed — which is exactly how the first
// version of this check reported a hole during reverse verification.
const producerSource = clientChunkNames(pluginRoot)
  .filter(chunk => chunk !== 'client.styles.js')
  .concat('client.js')
  .map(chunk => clientPartSource(pluginRoot, chunk))
  .join('\n')
const stateModifiers = [...new Set(
  [...rules.matchAll(/\.(sshwsp-[a-z0-9-]*-(?:busy|loading|pending|disabled))\b/gu)].map(match => match[1]),
)]
const unproducedModifiers = stateModifiers.filter(name => !producerSource.includes(name))
check('every busy/loading modifier in the sheet has a producer',
  unproducedModifiers.length === 0, unproducedModifiers.join(' '))

// ---- summary --------------------------------------------------------------

console.log(`\n=== ${passed} passed, ${failures.length} failed ===\n`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAILED  ${failure}`)
  process.exitCode = 1
}
