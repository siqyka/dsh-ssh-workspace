/**
 * Validate every tool definition this plugin publishes against the REAL
 * `@deepseek-ai/dsh-tools` JSON-Schema assertions and argument validator.
 *
 * The boot/lifecycle suites register the tools through a stub registry, which
 * checks shape but NOT the enforced raw-JSON-Schema subset. The real registry
 * calls `assertSupportedJsonSchema` on every output schema and validates model
 * arguments through `validateArgs`, so a schema the subset rejects would only
 * fail inside DSH. This suite closes that gap, and smoke-tests every output
 * `render()` against a realistic value shape (a throwing render breaks the
 * tool RESULT rather than the call).
 *
 * Requires an assembled DSH dependency tree; SKIPs when DSH_CORE_ROOT is unset.
 * Run: DSH_CORE_ROOT=/path/to/node_modules node tests/tool-schemas-smoke.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { skipWithoutRealPeers } from './support/peer-mode.mjs'

const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== tool schemas smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs the real @deepseek-ai/dsh-tools)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
// The whole point of this suite is the host's ENFORCED schema subset and its
// argument validator; a stub that skips both would report a green suite that
// verified nothing. Skip instead. Only `dsh-tools` is required — this suite never
// boots Cordis, so a tree that has dsh-tools but not cordis still runs it.
skipWithoutRealPeers('tool schemas smoke', 'the real @deepseek-ai/dsh-tools (schema subset and argument validator)', {
  requires: ['@deepseek-ai/dsh-tools'],
})
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromCore = createRequire(path.join(coreRoot, 'noop.cjs'))
const { assertSupportedJsonSchema } = requireFromCore('@deepseek-ai/dsh-tools')

const passes = []
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log(`\n=== tool schema validation (${pluginRoot}) ===\n`)

const { workspaceTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/tools.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href)

const engine = new SshWorkspaceEngine({})
const router = new RemoteFileSystem({ engine })
const forwards = { list: () => [], open: async () => ({}), close: () => false }
const shells = { list: () => [], run: async () => ({}), close: () => 0 }
const tools = workspaceTools({ get: () => undefined }, engine, router, forwards, shells)

for (const tool of tools) {
  console.log(`\n[${tool.name}]`)

  // The registry's own preconditions (dsh-tools register()).
  check('declares a name', typeof tool.name === 'string' && tool.name.length > 0)
  check('declares a description', typeof tool.description === 'string' && tool.description.length > 20)
  check('declares output.render()', typeof tool.output?.render === 'function')
  check('declares execute()', typeof tool.execute === 'function')
  check('does not use the reserved name run_code', tool.name !== 'run_code')

  // Output schema must be inside the enforced raw JSON Schema subset.
  try {
    assertSupportedJsonSchema(tool.output.schema)
    check('output schema is inside the supported JSON Schema subset', true)
  } catch (error) {
    check('output schema is inside the supported JSON Schema subset', false, error.message)
  }

  // `defineTool` has ALREADY compiled the author-facing parameter spec into raw
  // JSON Schema on the returned definition, so the compiled form is what to
  // validate — and it is validated with the same assertion the registry uses.
  try {
    assertSupportedJsonSchema(tool.parameters)
    check('compiled parameter schema is inside the supported JSON Schema subset', true)
  } catch (error) {
    check('compiled parameter schema is inside the supported JSON Schema subset', false, error.message)
  }

  const properties = tool.parameters?.properties ?? {}
  const required = tool.parameters?.required ?? []
  console.log(`         parameters: ${Object.keys(properties).join(', ') || '(none)'}`)
  console.log(`         required  : ${required.join(', ') || '(none)'}`)

  // Every declared property must be a primitive with a description: the author
  // parameter compiler rejects nested object/array types outright.
  const SUPPORTED_PRIMITIVES = new Set(['string', 'integer', 'number', 'boolean'])
  for (const [name, spec] of Object.entries(properties)) {
    check(`parameter ${name} is a supported primitive type`,
      SUPPORTED_PRIMITIVES.has(spec.type),
      `type=${JSON.stringify(spec.type)}`)
    check(`parameter ${name} declares a description`,
      typeof spec.description === 'string' && spec.description.length > 0)
  }
  for (const name of required) {
    check(`required parameter ${name} is declared in properties`, name in properties)
  }
}

// The RESULT schema is the other half, and it was wrong: `transfer`'s
// recursive branch has always returned `skippedFiles` / `skippedLinks` while its
// `output.schema` declared neither, under `additionalProperties: false`. A host
// that validates results therefore either stripped them or refused the call —
// and the caller never learned which files were skipped, which is the one piece
// of information a tree transfer exists to report.
//
// This check is deliberately a SOURCE scan: the tools are built by
// `defineTool(...)` inside a factory that needs the assembled host, so their
// return values cannot be executed here. The scan therefore compares the keys
// each `execute` RETURNS against the keys the sibling schema DECLARES.
console.log('\n[returned keys are declared in the output schema]')
{
  const source = readFileSync(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')

  /**
   * Slice out a balanced `{ … }` starting at `open`.
   *
   * A tool body contains nested objects, so a regex that stops at the first `}`
   * would cut it in half — and a half body reports fewer returned keys, which
   * reads as a pass.
   */
  function balanced (text, open) {
    let depth = 0
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') {
        depth -= 1
        if (depth === 0) return text.slice(open, i + 1)
      }
    }
    return text.slice(open)
  }

  let checkedTools = 0
  for (const match of source.matchAll(/defineTool\(\{/gu)) {
    // `match[0]` already ends in `{`, so the body opens at its LAST character.
    // `indexOf('{', match.index)` finds that same brace, but a later version of
    // this scan used `indexOf('{')` from a shifted offset and silently measured
    // the NEXT tool — which is how a check can report "all declared" while never
    // looking at the tool it names.
    const body = balanced(source, match.index + match[0].length - 1)
    const nameMatch = /^\s*name: '([^']+)'/mu.exec(body)
    if (nameMatch === null) continue
    const name = nameMatch[1]

    // The declared keys are the property names directly under
    // `output.properties`, i.e. indented exactly ten spaces.
    const outputAt = body.indexOf('output: {')
    if (outputAt < 0) continue
    const outputBody = balanced(body, body.indexOf('{', outputAt))
    const propertiesAt = outputBody.indexOf('properties: {')
    if (propertiesAt < 0) continue
    const propertiesBody = balanced(outputBody, outputBody.indexOf('{', propertiesAt))
    const declared = new Set([...propertiesBody.matchAll(/^\s+(\w+): \{/gmu)].map(entry => entry[1]))
    if (declared.size === 0) continue

    // The returned keys come from the tool's OWN `execute` body only. Scanning
    // the whole tool would also catch `render:` closures and nested helper
    // objects, whose keys are not part of the result.
    const executeAt = body.indexOf('async execute (')
    if (executeAt < 0) continue
    const executeBody = balanced(body, body.indexOf('{', executeAt))
    const returned = new Set()
    for (const ret of executeBody.matchAll(/return \{/gu)) {
      const object = balanced(executeBody, executeBody.indexOf('{', ret.index))
      for (const key of topLevelKeys(object)) returned.add(key)
      // Conditional fields are written as a spread, and their keys are part of
      // the result:
      //   `...(result.skipped === 0 ? {} : { skippedFiles: result.skipped })`
      // They are collected in a SEPARATE pass because a spread contains its own
      // braces and brackets, which the top-level walk correctly treats as
      // nested. This is the shape the three undeclared fields had, so a scan
      // that ignored spreads could never have caught them — which it did not.
      for (const spread of object.matchAll(/\.\.\.[\s\S]*?\{ ([^}]*)\}/gu)) {
        for (const key of spread[1].matchAll(/(?:^|,)\s*(\w+)\s*:/gu)) returned.add(key[1])
      }
    }
    if (returned.size === 0) continue
    checkedTools += 1
    const undeclared = [...returned].filter(key => !declared.has(key) && key !== 'ok')
    check(`${name}: every returned key is declared in its output schema`,
      undeclared.length === 0,
      `undeclared: ${JSON.stringify(undeclared)}`)
  }
  check('the scan actually found tool schemas to compare', checkedTools > 0, `${checkedTools} tool(s)`)
}

/**
 * The keys directly inside an object literal, ignoring anything nested.
 *
 * A regex cannot do this: `{ a: { b: 1 } }` matches `b` at the same "indent" as
 * `a` unless depth is tracked, and reporting a nested key as a returned one
 * produces a failure that is not real — which is worse than no check, because
 * the next person silences it.
 *
 * @param {string} object - an object literal INCLUDING its braces.
 * @returns {string[]} the top-level property names.
 */
function topLevelKeys (object) {
  const keys = []
  let depth = 0
  let inString = false
  let quote = ''
  /** Recorders for the current top-level slot: the text since the last `,`. */
  let slot = ''
  for (let i = 0; i < object.length; i += 1) {
    const char = object[i]
    if (inString) {
      if (char === '\\') { slot += char; i += 1; slot += object[i] ?? ''; continue }
      if (char === quote) inString = false
      slot += char
      continue
    }
    if (char === '\'' || char === '"' || char === '`') { inString = true; quote = char; slot += char; continue }
    if (char === '{' || char === '[' || char === '(') {
      depth += 1
      if (depth === 1) { slot = ''; continue }
      slot += char
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
      depth -= 1
      if (depth === 0) { record(slot, keys); return keys }
      slot += char
      continue
    }
    if (char === ',' && depth === 1) { record(slot, keys); slot = ''; continue }
    if (depth === 1) slot += char
  }
  record(slot, keys)
  return keys
}

/** Add one slot's key (if it has one) to the list, ignoring comments. */
function record (slot, keys) {
  const trimmed = slot.trim()
  // A SPREAD is how a conditional field is written here:
  // `...(result.skipped === 0 ? {} : { skippedFiles: result.skipped })`.
  // The keys inside it reach the result, so they are returned keys — and
  // skipping them (the first version of this scan did) made the check blind to
  // exactly the three fields it was written to catch.
  if (trimmed.startsWith('...')) {
    for (const nested of trimmed.matchAll(/\{\s*(\w+)\s*:/gu)) keys.push(nested[1])
    return
  }
  const match = /^(\w+)\s*:/u.exec(trimmed)
  if (match !== null) keys.push(match[1])
}

// The render path must not throw on a realistic value shape, because a
// throwing render breaks the tool RESULT rather than the call.
console.log('\n[render smoke tests]')
const renderCases = [
  ['ssh_workspace_hosts', { hosts: [{ alias: 'a', host: 'h', port: 22, user: 'u', auth: 'key', keyReady: true, source: 'store', tags: [] }] }],
  ['ssh_workspace_hosts', { hosts: [] }],
  ['ssh_workspace_mount', { ok: true, workspacePath: 'ssh://a/b', title: 'b', registered: true, entryCount: 3 }],
  ['ssh_workspace_mount', { ok: false, workspacePath: '', title: '', registered: false, error: 'boom' }],
  ['ssh_workspace_unmount', { ok: true, mode: 'detach', wasMounted: true, deregistered: false, archived: ['s1'] }],
  ['ssh_workspace_unmount', { ok: true, mode: 'detach', wasMounted: true, deregistered: false, archived: [], archiveFailed: [{ sessionId: 's2', error: 'the session is active (turn)' }] }],
  ['ssh_workspace_unmount', { ok: false, mode: 'detach', wasMounted: false, deregistered: false, archived: [], error: 'boom' }],
  ['ssh_workspace_enable', { ok: true, workspacePath: 'ssh://a/b', registered: true, unarchived: ['s1'] }],
  ['ssh_workspace_enable', { ok: false, workspacePath: '', registered: false, unarchived: [], error: 'boom' }],
  ['ssh_workspace_status', { mounted: ['ssh://a/b'], disabled: [], connections: [{ alias: 'a', state: 'connected', inFlight: 0 }], fsPatched: true }],
  ['ssh_workspace_status', { mounted: [], disabled: ['ssh://a/b'], connections: [], fsPatched: true }],
  ['ssh_workspace_status', { mounted: [], disabled: [], connections: [], fsPatched: true }],
  ['ssh_workspace_exec', { success: true, exitCode: 0, timedOut: false, stdout: 'out', stderr: '', truncated: false, durationMs: 5 }],
  ['ssh_workspace_exec', { success: false, exitCode: null, timedOut: true, stdout: '', stderr: '', truncated: false, durationMs: 9, error: 'timeout' }],
]
for (const [name, value] of renderCases) {
  const tool = tools.find(candidate => candidate.name === name)
  try {
    const blocks = tool.output.render({}, value)
    const okText = Array.isArray(blocks) && blocks.length > 0 && blocks.every(block => typeof block.text === 'string')
    check(`${name} renders ${value.ok === false || value.success === false ? 'a failure' : 'a success'}`, okText)
  } catch (error) {
    check(`${name} renders ${JSON.stringify(value).slice(0, 40)}`, false, error.message)
  }
}

engine.dispose()
console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
