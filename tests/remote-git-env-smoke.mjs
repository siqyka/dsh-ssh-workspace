/**
 * Regression: a remote ssh:// subprocess must not export env values Node drops.
 *
 * The host's Forge panel clears inherited Git selectors by passing an `env`
 * whose keys hold `undefined` (`dsh-experimental-client-ui-forge/lib/index.js`
 * `GIT_ENV`). Node's own spawn treats such an entry as "leave the variable
 * unset", so a local git run is unaffected. The remote half of the subprocess
 * bridge instead serializes env into `export KEY=...` shell statements, where a
 * naive `String(undefined)` becomes the literal `undefined`. Remote git then
 * reads `GIT_DIR=undefined` as "./undefined", exits 128 with
 * "fatal: not a git repository", and the panel reports the checkout as non-Git
 * ("当前目录不是 Git 仓库"). See docs/remote-git-diagnosis.md.
 *
 * Runs without DSH_CORE_ROOT: the bridge only needs a subprocess service
 * double and an engine double, because nothing here opens a real SSH channel.
 * Run: node tests/remote-git-env-smoke.mjs
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { installRemoteSubprocess } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-subprocess.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** A channel double that reports one exit status and optionally some stdout. */
function fakeChannel (exitCode, output) {
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.signal = () => {}
  stream.close = () => {}
  stream.end = () => {
    if (output !== undefined) stream.emit('data', Buffer.from(output, 'utf8'))
    setImmediate(() => stream.emit('close', exitCode, undefined))
  }
  return stream
}

/**
 * Install the bridge on a fresh service double and capture the script it runs.
 *
 * @param {{exitCode?: number, output?: string}} [run] - what the remote command reports.
 * @returns {{service: object, scripts: string[], localSpawns: number}} the harness.
 */
function harness (run = {}) {
  const scripts = []
  const record = {
    inFlight: 0,
    idleAt: Date.now(),
    broken: false,
    client: {
      exec: (script, _optionsOrCb, maybeCb) => {
        scripts.push(script)
        const cb = typeof _optionsOrCb === 'function' ? _optionsOrCb : maybeCb
        cb(undefined, fakeChannel(run.exitCode ?? 0, run.output))
      },
    },
  }
  const engine = {
    acquire: async () => record,
    assertNotDisabled: () => {},
    closeRecord: () => {},
  }
  let localSpawns = 0
  const service = { spawn: () => { localSpawns += 1; throw new Error('unexpected local spawn') } }
  const ctx = {
    get: (name) => (name === 'subprocess' ? service : undefined),
    effect: (fn) => fn(),
  }
  installRemoteSubprocess(ctx, { engine, logger: undefined })
  return { service, scripts, localSpawns: () => localSpawns }
}

/** The Forge panel's GIT_ENV: every key present, every value undefined. */
const FORGE_GIT_ENV = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE',
  'GIT_ATTR_SOURCE',
].map(key => [key, undefined]))

/** The spec shape `runGit()` in the Forge panel hands to ctx.subprocess. */
function forgeSpec (extraEnv = {}) {
  return {
    argv: ['/usr/bin/git', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
    cwd: 'ssh://testhost/mnt/data/Codes/vllm-ascend',
    env: {
      ...FORGE_GIT_ENV,
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      LC_ALL: 'C',
      ...extraEnv,
    },
    graceMs: 1000,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1 << 20 },
      stderr: { maxBytes: 1 << 20 },
    },
  }
}

console.log('\n[remote-git-env] undefined env values')

{
  const { service, scripts, localSpawns } = harness({ output: '/mnt/data/Codes/vllm-ascend\n' })
  const handle = service.spawn(forgeSpec())
  const outcome = await handle.done
  const script = scripts[0] ?? ''

  check('the ssh:// spec is diverted to the remote bridge', localSpawns() === 0)
  check('one remote command ran', scripts.length === 1, String(scripts.length))
  check('the remote command succeeded after the fix', outcome.exitCode === 0, JSON.stringify(outcome))
  check('the remote stdout still reaches the caller',
    handle.collected.stdout.readFrom(0).text === '/mnt/data/Codes/vllm-ascend\n',
    JSON.stringify(handle.collected.stdout.readFrom(0).text))

  // The regression itself: no `GIT_DIR=undefined` (or any undefined export).
  check('no env value is exported as the literal undefined',
    !script.includes("'undefined'"), script)
  check('the undefined-valued git selectors are omitted, not exported',
    !script.includes('GIT_DIR=') && !script.includes('GIT_WORK_TREE=') &&
      !script.includes('GIT_COMMON_DIR=') && !script.includes('GIT_INDEX_FILE='),
    script)
  check('every undefined GIT_ENV key is absent from the script',
    Object.keys(FORGE_GIT_ENV).every(key => key === 'GIT_CONFIG_COUNT' || !script.includes(`${key}=`)),
    script)

  // Defined values must still be exported: the fix drops only undefined.
  check('a defined override is still exported',
    script.includes("export GIT_CONFIG_COUNT='0'"), script)
  check('a defined identifier is still exported', script.includes("export LC_ALL='C'"), script)
  check('a defined git selector is still exported',
    script.includes("export GIT_TERMINAL_PROMPT='0'"), script)

  // The rest of the translation is untouched.
  check('the remote workdir is still changed into', script.includes("cd '/mnt/data/Codes/vllm-ascend'"), script)
  check('the argv is still forwarded verbatim',
    script.includes("exec 'git' '--no-optional-locks' '-c' 'core.hooksPath=/dev/null' '-c' 'core.fsmonitor=false' 'rev-parse' '--show-toplevel'"),
    script)
}

console.log('\n[remote-git-env] defined-only env stays byte-identical in meaning')

{
  // The workspace-change tracker passes only string values; the fix must not
  // drop any of them.
  const { service, scripts } = harness()
  const spec = forgeSpec()
  spec.env = {
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    GIT_OBJECT_DIRECTORY: '/tmp/dsh-ws-abc/objects',
    GIT_INDEX_FILE: '/tmp/dsh-ws-abc/index/index',
  }
  const handle = service.spawn(spec)
  await handle.done
  const script = scripts[0] ?? ''
  check('GIT_CONFIG_COUNT survives', script.includes("export GIT_CONFIG_COUNT='0'"), script)
  check('GIT_TERMINAL_PROMPT survives', script.includes("export GIT_TERMINAL_PROMPT='0'"), script)
  check('GIT_OBJECT_DIRECTORY survives', script.includes('GIT_OBJECT_DIRECTORY='), script)
  check('GIT_INDEX_FILE survives', script.includes('GIT_INDEX_FILE='), script)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
