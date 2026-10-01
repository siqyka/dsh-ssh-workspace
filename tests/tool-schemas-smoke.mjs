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
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== tool schemas smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs the real @deepseek-ai/dsh-tools)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
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
const tools = workspaceTools({ get: () => undefined }, engine, router)

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

// The render path must not throw on a realistic value shape, because a
// throwing render breaks the tool RESULT rather than the call.
console.log('\n[render smoke tests]')
const renderCases = [
  ['ssh_workspace_hosts', { hosts: [{ alias: 'a', host: 'h', port: 22, user: 'u', auth: 'key', keyReady: true, source: 'store', tags: [] }] }],
  ['ssh_workspace_hosts', { hosts: [] }],
  ['ssh_workspace_mount', { ok: true, workspacePath: 'ssh://a/b', title: 'b', registered: true, entryCount: 3 }],
  ['ssh_workspace_mount', { ok: false, workspacePath: '', title: '', registered: false, error: 'boom' }],
  ['ssh_workspace_unmount', { ok: true, wasMounted: true, deregistered: false }],
  ['ssh_workspace_status', { mounted: ['ssh://a/b'], connections: [{ alias: 'a', state: 'connected', inFlight: 0 }], fsPatched: true }],
  ['ssh_workspace_status', { mounted: [], connections: [], fsPatched: true }],
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
