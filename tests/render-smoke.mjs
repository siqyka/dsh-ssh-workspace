/**
 * `tests/support/render.mjs` itself, exercised against a real component.
 *
 * ## What this suite is for
 *
 * A harness that only gets used by tests it was written for proves nothing:
 * both halves can be wrong together. So this suite renders a component that
 * already ships -- `SelfCheckList` in `lib/client/client.js`, which turns a capability
 * probe into the panel's advisory rows -- and asserts on the ELEMENT TREE the
 * real function produced. No grep of the source is involved in the behavioural
 * checks.
 *
 * ## The negative control
 *
 * The last group re-renders from a MUTATED copy of the bundle (the `present`
 * filter flipped) and requires the tree to change. Without that, a harness that
 * silently returned `null` for every component would pass every assertion above
 * it -- the classic way a render suite goes green while rendering nothing.
 *
 * ## What it deliberately does not do
 *
 * No DOM, no reconciliation, no second render: `render()` calls the component
 * once. `CappedList` is therefore NOT covered -- it needs `React.Children`,
 * `ResizeObserver` and `getBoundingClientRect`, and faking those would be
 * testing the fake. Its behaviour is covered by `client-shape-smoke`.
 *
 * Run: node tests/render-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { componentSource, compile, createReactStub, render, findAll, byType, textOf } from './support/render.mjs'
import { clientSource } from './support/client-source.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const source = clientSource(pluginRoot)

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

const t = key => `T:${key}`

console.log('\n=== render harness smoke ===\n')

// ---- the slice is a real declaration, not a guess ---------------------------

const slice = componentSource(source, 'SelfCheckList')
check('the harness finds a component that ships',
  slice.startsWith('function SelfCheckList ('),
  'componentSource did not return the declaration')
check('...and the slice ends on the component, not mid-body',
  slice.endsWith('\n    }') || slice.endsWith('}'),
  `the slice ends with ${JSON.stringify(slice.slice(-20))}`)
check('a component that does not exist is refused by name',
  (() => {
    try {
      componentSource(source, 'NoSuchComponentAnywhere')
      return false
    } catch (error) {
      return /no `function NoSuchComponentAnywhere`/.test(error.message)
    }
  })(),
  'a missing component must throw, not return an empty string')
check('an injected name the harness owns is refused',
  (() => {
    try {
      compile(source, 'SelfCheckList', { inject: { React: {} } })
      return false
    } catch (error) {
      return /supplied by the harness/.test(error.message)
    }
  })(),
  'injecting `React` would shadow the stub')

// ---- the real component, rendered -----------------------------------------

const EMPTY = render(source, 'SelfCheckList', { rows: [], t })
check('no rows renders nothing at all',
  EMPTY.element === null,
  'an empty capability list must not draw an empty box')
check('a missing rows prop renders nothing',
  render(source, 'SelfCheckList', { rows: undefined, t }).element === null,
  'rows must be validated, not assumed')
check('a non-array rows prop renders nothing',
  render(source, 'SelfCheckList', { rows: 'nope', t }).element === null,
  'a string has a length and would render as rows')

const rows = [
  { tool: 'git', state: 'present' },
  { tool: 'rg', state: 'absent', detail: 'no ripgrep', install: 'apt install ripgrep' },
  { tool: 'inotifywait', state: 'unknown' },
]
const full = render(source, 'SelfCheckList', { rows, t })
check('the header counts what is present out of what was probed',
  textOf(full.element).includes(`1/3 ${t('check.present')}`),
  `header read ${JSON.stringify(textOf(full.element).slice(0, 40))}`)
check('only the non-present rows are listed',
  findAll(full.element, el => el.props?.className === 'sshwsp-check-row sshwsp-check-present').length === 0,
  'a present tool must not take a row: the list is advisory')
check('...one row per advisory tool',
  findAll(full.element, el => typeof el.props?.className === 'string' && el.props.className.startsWith('sshwsp-check-row')).length === 2,
  'two of the three rows are advisory')
check('an absent tool is warned about, not hidden',
  findAll(full.element, el => el.props?.className === 'sshwsp-check-row sshwsp-check-absent').length === 1,
  'the absent row lost its state class')
check('an undetermined tool is neither present nor absent',
  findAll(full.element, el => el.props?.className === 'sshwsp-check-row sshwsp-check-unknown').length === 1,
  'a probe that could not answer must still be listed as unknown')
check('the status word follows the state',
  textOf(full.element).includes(t('check.absent')) && textOf(full.element).includes(t('check.unknown')),
  'the state words did not reach the tree')
check('an absent tool keeps the warning colour',
  findAll(full.element, el => el.props?.className === 'sshwsp-status sshwsp-status-warn').length === 1,
  'absent must be warn, not the neutral colour')
check('the detail line is rendered verbatim',
  textOf(full.element).includes('no ripgrep'),
  'the probe detail was dropped')
check('the install hint only appears where one exists',
  findAll(full.element, el => el.props?.children === `${t('check.install')}apt install ripgrep`).length === 1,
  'the install line is not gated on the field')
check('a row without a detail renders an empty string, not "undefined"',
  !textOf(full.element).includes('undefined'),
  'a missing detail leaked into the UI')
check('every tool name reaches the tree',
  ['rg', 'inotifywait'].every(tool => textOf(full.element).includes(tool)) && !textOf(full.element).includes('git'),
  'the listed tool names do not match the advisory set')

// ---- the tree helpers -----------------------------------------------------

const elements = findAll(full.element, () => true)
// root div + header div + 2 row divs + 4 spans in the absent row (tool,
// status, detail, install) + 3 in the unknown row = 11.
check('walk visits elements and skips leaves',
  elements.length === 11,
  `expected 11 elements, saw ${elements.length}`)
check('byType narrows to one element type',
  byType(full.element, 'span').length === 7,
  `expected 7 spans, saw ${byType(full.element, 'span').length}`)
check('textOf concatenates nested children in order',
  textOf({ type: 'div', props: { children: ['a', { type: 'b', props: { children: 'c' } }, 3] } }) === 'ac3',
  'text extraction lost a leaf or reordered it')

// ---- effects are recorded, not run ---------------------------------------

const recorded = createReactStub()
let ran = false
recorded.react.useEffect(() => { ran = true })
check('an effect body does not run unless asked',
  ran === false && recorded.calls.effects.length === 1,
  'the default must not claim to know when React runs effects')
const executed = createReactStub({ runEffects: true })
let cleaned = false
executed.react.useEffect(() => () => { cleaned = true })
executed.cleanup()
check('an effect runs, and its cleanup is collectable, when asked',
  cleaned === true && executed.calls.cleanups.length === 0,
  'cleanup must run once and be consumed')

// ---- negative control: a mutated bundle must change the tree --------------

const mutated = source.replace(
  'const rest = rows.filter(row => row.state !== \'present\')',
  'const rest = rows.filter(() => true)',
)
check('the mutation actually landed in the copy',
  mutated !== source,
  'the negative control no longer matches the shipped line -- update it')
const broken = render(mutated, 'SelfCheckList', { rows, t })
check('...and the present row appears once the filter is broken',
  textOf(broken.element).includes('git'),
  'the assertions above cannot see this defect, so they prove nothing')
check('...while the header is unchanged by that defect',
  textOf(broken.element).includes(`1/3 ${t('check.present')}`),
  'the header count must not depend on the row filter')

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('')
  for (const failure of failures) console.log(`  FAILED  ${failure}`)
  process.exitCode = 1
}
