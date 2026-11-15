/**
 * Regression checks for the recent-commit strip under the change-request tab.
 *
 * Three layers, because the feature spans three of them and each can fail
 * silently on its own:
 *
 *  1. `lib/git-history.js` — the fixed argv, the record parser, the git failure
 *     classifier, the Session-directory resolution and the structured results.
 *     Pure Node, always runs.
 *  2. `lib/routes.js` — the HTTP door: the loopback/method fence it shares with
 *     every other route, the query validation, and the 200-vs-400 split. Driven
 *     with a fake `ctx` and a fake subprocess; no server, no SSH host. Importing
 *     routes.js needs the DSH peer packages, so this suite builds the same
 *     `tests/.peer-stubs` tree the runner does when DSH_CORE_ROOT is unset.
 *  3. `lib/client.js` — the slot registration and the strip's structure. There
 *     is no browser in this environment, so these are source assertions: the
 *     shadow uses the official tab's key and a lower priority, it registers no
 *     tab TYPE and no title entry (there is exactly one tab, with the official
 *     chip), the renderer receives the official component, and the failure copy
 *     is a grey line rather than an error colour.
 *
 * A real `git log` (this checkout) is parsed at the end when git is available;
 * when it is not, that section says SKIP rather than pretending to have run.
 *
 * Run: node tests/commit-history-smoke.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  GIT_HISTORY_DEFAULT_LIMIT,
  GIT_HISTORY_MAX_LIMIT,
  GIT_LOG_FIELD_SEPARATOR,
  GIT_LOG_RECORD_SEPARATOR,
  classifyCwd,
  classifyGitFailure,
  gitLogArgv,
  normalizeGitHistoryLimit,
  parseGitLog,
  readGitHistory,
} from '../lib/git-history.js'
import { installPeerStubs } from './peer-stubs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

let passed = 0
let failed = 0
function check (label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log('\n=== commit history smoke ===\n')

// ---------------------------------------------------------------------------
// argv: fixed, and the only request-derived part is a clamped integer
// ---------------------------------------------------------------------------
console.log('[argv]')
{
  const argv = gitLogArgv(20)
  check('git is argv[0]', argv[0] === 'git')
  check('the pager can never turn this into an interactive read', argv.includes('--no-pager'))
  check('records are NUL-separated (-z), so a subject cannot split one',
    argv.includes('-z') && argv.at(-1) === '--')
  check('the limit is a fixed -n <limit+1> pair',
    argv[argv.indexOf('-n') + 1] === '21',
    JSON.stringify(argv.slice(-4)))
  check('the format is the machine shape, not the human default',
    argv.some(part => part.startsWith('--pretty=format:') && part.includes('%H') && part.includes('%s')))
  check('the two separators are the ones the parser splits on',
    argv.some(part => part.includes('%x1f')) && argv.includes('-z'))
  check('a limit above the ceiling is clamped', gitLogArgv(10_000).at(-2) === String(GIT_HISTORY_MAX_LIMIT + 1))
  check('a non-finite limit still yields a legal count (no literal NaN)',
    gitLogArgv(Number.NaN).at(-2) === String(GIT_HISTORY_DEFAULT_LIMIT + 1),
    JSON.stringify(gitLogArgv(Number.NaN)))
  check('a non-numeric limit cannot leak into argv',
    !gitLogArgv('20; rm -rf /').some(part => part.includes('rm -rf')),
    JSON.stringify(gitLogArgv('20; rm -rf /')))
}

// ---------------------------------------------------------------------------
// limit normalization
// ---------------------------------------------------------------------------
console.log('\n[limit query parameter]')
{
  check('no limit means the default', normalizeGitHistoryLimit(undefined) === GIT_HISTORY_DEFAULT_LIMIT)
  check('an empty limit means the default', normalizeGitHistoryLimit('') === GIT_HISTORY_DEFAULT_LIMIT)
  check('a positive integer passes through', normalizeGitHistoryLimit('5') === 5)
  check('zero is refused', normalizeGitHistoryLimit('0') === undefined)
  check('a negative number is refused', normalizeGitHistoryLimit('-3') === undefined)
  check('a decimal is refused', normalizeGitHistoryLimit('2.5') === undefined)
  check('arbitrary text is refused', normalizeGitHistoryLimit('20; rm -rf /') === undefined)
  check('a huge limit is clamped, not refused', normalizeGitHistoryLimit('9999') === GIT_HISTORY_MAX_LIMIT)
}

// ---------------------------------------------------------------------------
// parser: real shape from 910b-05, then synthetic edge cases
// ---------------------------------------------------------------------------
console.log('\n[parser]')
{
  // Captured from `910b-05:/mnt/data/Codes/vllm-ascend` (branch
  // fix/rwkv7-api-compat) with the exact command this feature runs. Kept as
  // field arrays so the separators are not hidden inside invisible control
  // characters in this source file.
  const REAL_910B = [
    ['7f9fc618fec4df4af85e4753751732d972a12851', '7f9fc618f', '2026-10-22', 'diannaojiang', "Merge branch 'feat/rwkv7-standalone-support' into fix/rwkv7-api-compat"],
    ['e6cde0195493b3d9f05b5c0cbb72079a4818ca36', 'e6cde0195', '2026-10-22', 'diannaojiang', 'fix(rwkv7): make MRV2 TP piecewise compilation correct'],
    ['63ce07b9d7f513e52077e291bee7094eec858b0a', '63ce07b9d', '2026-10-20', 'diannaojiang', "Merge branch 'feat/rwkv7-standalone-support' into fix/rwkv7-api-compat"],
    ['ff0637e93cbbce3db83953be0c8f8a09cf3be576', 'ff0637e93', '2026-10-20', 'diannaojiang', 'fix(rwkv7): avoid broken TP piecewise compile under MRV2'],
  ]
  const realOutput = REAL_910B
    .map(fields => fields.join(GIT_LOG_FIELD_SEPARATOR))
    .join(GIT_LOG_RECORD_SEPARATOR)
  const real = parseGitLog(realOutput, 20)
  check('the real 910b-05 shape parses into rows', real.commits.length === 4, String(real.commits.length))
  check('the first row is the checked-out commit',
    real.commits[0].sha === '7f9fc618fec4df4af85e4753751732d972a12851' &&
      real.commits[0].shortSha === '7f9fc618f' &&
      real.commits[0].date === '2026-10-22' &&
      real.commits[0].author === 'diannaojiang', JSON.stringify(real.commits[0]))
  check('a subject with quotes and parentheses survives whole',
    real.commits[0].subject === REAL_910B[0][4])
  check('four records are not truncated by a 20-row limit', real.truncated === false)

  const makeRecord = (index) => {
    const sha = index.toString(16).padStart(8, '0').repeat(5)
    return [sha, sha.slice(0, 7), '2026-01-02', 'dev', `subject ${index}`].join(GIT_LOG_FIELD_SEPARATOR)
  }
  const many = Array.from({ length: 21 }, (_, index) => makeRecord(index)).join(GIT_LOG_RECORD_SEPARATOR)
  const capped = parseGitLog(many, 20)
  check('21 records for a 20-row limit yields 20 rows', capped.commits.length === 20, String(capped.commits.length))
  check('...and reports truncation', capped.truncated === true)
  const exact = parseGitLog(Array.from({ length: 20 }, (_, index) => makeRecord(index)).join(GIT_LOG_RECORD_SEPARATOR), 20)
  check('exactly 20 records are not reported as truncated', exact.commits.length === 20 && exact.truncated === false)

  check('empty stdout is an empty history, not a crash', parseGitLog('', 20).commits.length === 0)
  check('a trailing record separator does not invent a row',
    parseGitLog(`${makeRecord(1)}${GIT_LOG_RECORD_SEPARATOR}`, 20).commits.length === 1)
  check('a subject containing the field separator is joined back, not truncated',
    parseGitLog([
      'a'.repeat(40), 'aaaaaaa', '2026-01-01', 'dev', `before${GIT_LOG_FIELD_SEPARATOR}after`,
    ].join(GIT_LOG_FIELD_SEPARATOR), 20).commits[0].subject === `before${GIT_LOG_FIELD_SEPARATOR}after`)
  check('a record without five fields is dropped',
    parseGitLog(['a'.repeat(40), 'aaaaaaa', '2026-01-01', 'dev'].join(GIT_LOG_FIELD_SEPARATOR), 20).commits.length === 0)
  check('a record whose sha is not hex is dropped',
    parseGitLog(['zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'zzzzzzz', '2026-01-01', 'dev', 'x'].join(GIT_LOG_FIELD_SEPARATOR), 20).commits.length === 0)
}

// ---------------------------------------------------------------------------
// failure classification (LC_ALL=C is part of the spawn environment)
// ---------------------------------------------------------------------------
console.log('\n[git failure classification]')
{
  check('not-a-repository is the English message under LC_ALL=C',
    classifyGitFailure('fatal: not a git repository (or any of the parent directories): .git').kind === 'not-repository')
  check('an unborn HEAD is "no commits", not a failure',
    classifyGitFailure("fatal: your current branch 'master' does not have any commits yet").kind === 'no-commits')
  check('older git spells the same state "bad default revision"',
    classifyGitFailure("fatal: bad default revision 'HEAD'").kind === 'no-commits')
  check('anything else is a real failure with its first line kept',
    classifyGitFailure('fatal: detected dubious ownership in repository\nmore') .kind === 'failed' &&
      classifyGitFailure('fatal: detected dubious ownership in repository\nmore').message === 'fatal: detected dubious ownership in repository')
  check('empty stderr still classifies as a failure', classifyGitFailure('').kind === 'failed')
}

// ---------------------------------------------------------------------------
// working-directory classification
// ---------------------------------------------------------------------------
console.log('\n[working directory classification]')
{
  check('a mounted remote workspace is remote', classifyCwd('ssh://910b-05/mnt/data/Codes/vllm-ascend') === 'remote')
  check('an ordinary absolute path is local', classifyCwd('/root/Codes/多主机插件') === 'local')
  check('a relative path is refused', classifyCwd('relative/dir') === 'invalid')
  check('an empty path is refused', classifyCwd('') === 'invalid')
  check('an ssh:// spelling without an absolute remote path is refused', classifyCwd('ssh://910b-05') === 'invalid')
  check('a non-string is refused', classifyCwd(null) === 'invalid')
}

/**
 * A subprocess double: records the spec, answers with canned collected output.
 *
 * @param {object} result - `{exitCode, stdout, stderr, lossy, throw}`.
 */
function fakeSubprocess (result = {}) {
  const calls = []
  const handle = {
    collected: {
      stdout: { readFrom: () => ({ text: result.stdout ?? '', lossy: result.lossy === true }) },
      stderr: { readFrom: () => ({ text: result.stderr ?? '', lossy: false }) },
    },
    done: result.throw === undefined
      ? Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null })
      : Promise.reject(result.throw),
  }
  return {
    calls,
    spawn (spec) {
      calls.push(spec)
      return handle
    },
  }
}

/** The services a route handler resolves through `ctx.get()`. */
function servicesFor (overrides = {}) {
  const session = { id: 'session-abc', header: { cwd: 'ssh://910b-05/mnt/data/Codes/vllm-ascend' } }
  return {
    session,
    subprocess: fakeSubprocess(),
    sessions: { get: (id) => (id === session.id ? session : undefined) },
    workingDirectory: { get: () => 'ssh://910b-05/mnt/data/Codes/vllm-ascend' },
    sessionQuery: undefined,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// readGitHistory: the seam between the route and git
// ---------------------------------------------------------------------------
console.log('\n[readGitHistory]')
{
  const services = servicesFor()
  const result = await readGitHistory(services, { sessionId: 'session-abc', limit: '5' })
  check('a successful read is ok', result.ok === true, JSON.stringify(result))
  check('it reports the world it ran in', result.world === 'remote', String(result.world))
  check('it reports the directory it read', result.cwd === 'ssh://910b-05/mnt/data/Codes/vllm-ascend')
  const spec = services.subprocess.calls[0]
  check('the spec carries the Session cwd verbatim (the bridge routes ssh://)', spec.cwd === 'ssh://910b-05/mnt/data/Codes/vllm-ascend')
  check('the argv is exactly gitLogArgv(5)', JSON.stringify(spec.argv) === JSON.stringify(gitLogArgv(5)), JSON.stringify(spec.argv))
  check('stdin is closed: git log must never wait for input', spec.stdin === undefined && spec.stdio.stdin === 'ignore')
  check('both streams are collected with a byte ceiling',
    spec.stdio.stdout.maxBytes > 0 && spec.stdio.stderr.maxBytes > 0)
  check('a termination grace is declared', Number.isFinite(spec.graceMs) && spec.graceMs > 0)
  check('a cancellation signal is declared', spec.signal !== undefined)
  check('the language is pinned so git diagnostics are the English ones classified above',
    spec.env.LC_ALL === 'C' && spec.env.LANGUAGE === 'C')
  check('a host-level git config cannot change the output shape', spec.env.GIT_CONFIG_COUNT === '0')
  check('the read never prompts and never takes an optional lock',
    spec.env.GIT_TERMINAL_PROMPT === '0' && spec.env.GIT_OPTIONAL_LOCKS === '0')
  check('a limit above the ceiling is clamped into the argv', JSON.stringify(services.subprocess.calls[0].argv) !== JSON.stringify(gitLogArgv(999)))

  const notRepo = servicesFor({ subprocess: fakeSubprocess({ exitCode: 128, stderr: 'fatal: not a git repository (or any parent up to mount point /)' }) })
  const notRepoResult = await readGitHistory(notRepo, { sessionId: 'session-abc' })
  check('a non-repository is a successful, empty answer', notRepoResult.ok === true && notRepoResult.notRepository === true && notRepoResult.commits.length === 0, JSON.stringify(notRepoResult))
  check('...that is not a failure code', notRepoResult.code === undefined)

  const empty = servicesFor({ subprocess: fakeSubprocess({ exitCode: 128, stderr: "fatal: your current branch 'master' does not have any commits yet" }) })
  const emptyResult = await readGitHistory(empty, { sessionId: 'session-abc' })
  check('an empty repository is an empty history, not "not a repository"',
    emptyResult.ok === true && emptyResult.notRepository === undefined && emptyResult.commits.length === 0, JSON.stringify(emptyResult))

  const broken = servicesFor({ subprocess: fakeSubprocess({ exitCode: 128, stderr: 'fatal: detected dubious ownership in repository' }) })
  const brokenResult = await readGitHistory(broken, { sessionId: 'session-abc' })
  check('a real git failure is a structured error, not a throw', brokenResult.ok === false && brokenResult.code === 'git-failed', JSON.stringify(brokenResult))
  check('...and carries the stderr line for the tooltip', String(brokenResult.message).includes('dubious ownership'), brokenResult.message)

  const lossy = servicesFor({ subprocess: fakeSubprocess({ exitCode: 0, stdout: 'x', lossy: true }) })
  const lossyResult = await readGitHistory(lossy, { sessionId: 'session-abc' })
  check('a lossy stdout is reported as truncated even for one row', lossyResult.ok === true && lossyResult.truncated === true, JSON.stringify(lossyResult))

  check('a missing subprocess service degrades to a structured error',
    (await readGitHistory({}, { sessionId: 'session-abc' })).code === 'subprocess-unavailable')
  check('an unknown Session is a structured error',
    (await readGitHistory(servicesFor(), { sessionId: 'session-nope' })).code === 'session-unavailable')
  check('a shell-shaped session id is refused before any spawn',
    (await readGitHistory(servicesFor(), { sessionId: 'session-abc; rm -rf /' })).code === 'bad-session')
  check('a relative working directory is refused before any spawn',
    (await readGitHistory(servicesFor({ workingDirectory: { get: () => 'relative/dir' } }), { sessionId: 'session-abc' })).code === 'invalid-cwd')
  check('a bad limit is refused before any spawn',
    (await readGitHistory(servicesFor(), { sessionId: 'session-abc', limit: '0' })).code === 'bad-limit')

  // A spawn that throws synchronously (invalid spec / whitelist refusal) must
  // become a value, never an unhandled rejection.
  const throwing = servicesFor({ subprocess: { spawn () { throw new Error('ssh-workspace: rejected') } } })
  const thrown = await readGitHistory(throwing, { sessionId: 'session-abc' })
  check('a synchronous spawn failure is a structured error', thrown.ok === false && thrown.code === 'spawn-failed' && String(thrown.message).includes('rejected'), JSON.stringify(thrown))

  const rejecting = servicesFor({ subprocess: { spawn: () => ({ collected: {}, done: Promise.reject(new Error('transport dropped')) }) } })
  const rejected = await readGitHistory(rejecting, { sessionId: 'session-abc' })
  check('a rejected done (transport failure) is a structured error', rejected.ok === false && rejected.code === 'spawn-failed' && String(rejected.message).includes('transport dropped'), JSON.stringify(rejected))

  // The header is the fallback when the projection is unavailable, and the
  // project directory is the only thing that ever comes from the Session.
  const headerOnly = servicesFor({ workingDirectory: { get: () => { throw new Error('projection unavailable') } } })
  const headerResult = await readGitHistory(headerOnly, { sessionId: 'session-abc' })
  check('an unavailable projection falls back to the Session header cwd', headerResult.ok === true && headerResult.cwd === 'ssh://910b-05/mnt/data/Codes/vllm-ascend')
  const queryOnly = servicesFor({
    sessions: { get: () => undefined },
    sessionQuery: { listSessions: async () => [{ header: { id: 'session-abc', cwd: '/srv/project' } }] },
  })
  const queryResult = await readGitHistory(queryOnly, { sessionId: 'session-abc' })
  check('a persisted-but-unattached Session is still resolvable through sessionQuery',
    queryResult.ok === true && queryResult.cwd === '/srv/project' && queryResult.world === 'local', JSON.stringify(queryResult))

  // Timeout: AbortSignal.timeout is replaced for this one case so the branch
  // runs for real instead of being skipped.
  const originalTimeout = AbortSignal.timeout
  const controller = new AbortController()
  AbortSignal.timeout = () => controller.signal
  try {
    const hanging = servicesFor({
      subprocess: {
        spawn () {
          return {
            collected: {},
            done: new Promise((resolve, reject) => {
              setTimeout(() => {
                controller.abort(new Error('timeout'))
                reject(new Error('aborted'))
              }, 0)
            }),
          }
        },
      },
    })
    const timedOut = await readGitHistory(hanging, { sessionId: 'session-abc' })
    check('an aborted read reports a timeout, not a generic spawn failure',
      timedOut.ok === false && timedOut.code === 'timeout', JSON.stringify(timedOut))
  } finally {
    AbortSignal.timeout = originalTimeout
  }
}

// ---------------------------------------------------------------------------
// route layer: same fence and response conventions as the rest of the family
// ---------------------------------------------------------------------------
console.log('\n[route]')
if (!process.env.DSH_CORE_ROOT) {
  try {
    process.env.DSH_CORE_ROOT = installPeerStubs(path.join(here, '.peer-stubs'))
    console.log(`  [peer stubs: ${process.env.DSH_CORE_ROOT}]`)
  } catch (error) {
    console.log(`  [warn: could not build the peer stub root: ${error instanceof Error ? error.message : String(error)}]`)
  }
}
process.env.DSH_PEER_ROOT = [process.env.DSH_CORE_ROOT, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

let routesModule = null
try {
  routesModule = await import(pathToFileURL(path.join(pluginRoot, 'lib/routes.js')).href)
} catch (error) {
  console.log(`  SKIP  the route checks need the DSH peer tree (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`)
}

if (routesModule !== null) {
  const { makeRoutes, ROUTES } = routesModule
  check('the route path is the documented one', ROUTES.gitHistory === '/api/dsh-ssh-workspace/git-history', ROUTES.gitHistory)

  /** A response double recording status, headers and body. */
  function fakeRes () {
    const state = { status: undefined, headers: undefined, body: '' }
    return {
      state,
      res: {
        removeHeader () {},
        writeHead (status, headers) { state.status = status; state.headers = headers },
        end (chunk) { if (chunk !== undefined) state.body += String(chunk) },
        on () {},
      },
    }
  }

  /** A request double with loopback defaults. */
  function fakeReq (options = {}) {
    return {
      method: options.method ?? 'GET',
      url: options.url ?? '/',
      headers: { host: options.host ?? 'localhost:4074', ...(options.headers ?? {}) },
      socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1', localPort: 4074 },
      on () {},
    }
  }

  function routesFor (services) {
    return makeRoutes({
      engine: {},
      router: {},
      forwards: { list: () => [] },
      ctx: { get: (name) => services[name] },
    })
  }

  const route = routesFor(servicesFor()).find(entry => entry.path === ROUTES.gitHistory)
  check('the route is registered exactly once', route !== undefined)

  const successServices = servicesFor({ subprocess: fakeSubprocess({ exitCode: 0, stdout: `${'a'.repeat(40)}${GIT_LOG_FIELD_SEPARATOR}aaaaaaa${GIT_LOG_FIELD_SEPARATOR}2026-01-01${GIT_LOG_FIELD_SEPARATOR}dev${GIT_LOG_FIELD_SEPARATOR}hello` }) })
  {
    const { res, state } = fakeRes()
    await routesFor(successServices).find(entry => entry.path === ROUTES.gitHistory)
      .handler(fakeReq({ url: `${ROUTES.gitHistory}?session=session-abc` }), res)
    check('a valid read answers 200', state.status === 200, String(state.status))
    const body = JSON.parse(state.body)
    check('...with one parsed commit', body.commits.length === 1 && body.commits[0].subject === 'hello', state.body.slice(0, 160))
    check('...and the truncation flag as a boolean', body.truncated === false)
    check('...and the resolved directory', body.cwd === 'ssh://910b-05/mnt/data/Codes/vllm-ascend')
  }

  {
    const { res, state } = fakeRes()
    await routesFor(servicesFor()).find(entry => entry.path === ROUTES.gitHistory)
      .handler(fakeReq({ url: `${ROUTES.gitHistory}?session=session-abc&limit=500` }), res)
    check('a huge limit is clamped server-side, not rejected', state.status === 200, String(state.status))
  }

  {
    const { res, state } = fakeRes()
    await routesFor(servicesFor()).find(entry => entry.path === ROUTES.gitHistory)
      .handler(fakeReq({ url: `${ROUTES.gitHistory}?limit=20` }), res)
    check('a missing session is refused with 400', state.status === 400, String(state.status))
    check('...and the reason is a readable JSON error', typeof JSON.parse(state.body).error === 'string')
  }

  {
    const { res, state } = fakeRes()
    await routesFor(servicesFor()).find(entry => entry.path === ROUTES.gitHistory)
      .handler(fakeReq({ url: `${ROUTES.gitHistory}?session=session-abc&limit=0` }), res)
    check('an invalid limit is refused with 400', state.status === 400, String(state.status))
    check('...and carries the module\'s error code', JSON.parse(state.body).code === 'bad-limit', state.body)
  }

  {
    const { res, state } = fakeRes()
    await routesFor(servicesFor({ subprocess: fakeSubprocess({ exitCode: 128, stderr: 'fatal: not a git repository (or any parent up to mount point /)' }) }))
      .find(entry => entry.path === ROUTES.gitHistory)
      .handler(fakeReq({ url: `${ROUTES.gitHistory}?session=session-abc` }), res)
    check('a non-repository answers 200 with notRepository', state.status === 200 && JSON.parse(state.body).notRepository === true, state.body)
  }

  {
    const { res, state } = fakeRes()
    await routesFor(servicesFor()).find(entry => entry.path === ROUTES.gitHistory)
      .handler(fakeReq({ url: `${ROUTES.gitHistory}?session=session-abc`, remoteAddress: '10.1.2.3' }), res)
    check('a non-loopback caller is refused with 403', state.status === 403, String(state.status))
  }

  {
    const { res, state } = fakeRes()
    await routesFor(servicesFor()).find(entry => entry.path === ROUTES.gitHistory)
      .handler(fakeReq({ url: `${ROUTES.gitHistory}?session=session-abc`, headers: { host: 'evil.example:4074' } }), res)
    check('a rebinding Host header is refused with 403', state.status === 403, String(state.status))
  }

  {
    const { res, state } = fakeRes()
    await routesFor(servicesFor()).find(entry => entry.path === ROUTES.gitHistory)
      .handler(fakeReq({ url: `${ROUTES.gitHistory}?session=session-abc`, method: 'POST' }), res)
    check('a write method is refused with 405', state.status === 405, String(state.status))
  }

  {
    // The route must not accept a cwd (or any other path) from the caller: the
    // only accepted query names are session and limit.
    const source = readFileSync(path.join(pluginRoot, 'lib/routes.js'), 'utf8')
    const start = source.indexOf('path: ROUTES.gitHistory')
    const end = source.indexOf('// ---- mount status', start)
    const block = start < 0 || end < 0 ? '' : source.slice(start, end)
    check('the route handler reads only `session` and `limit` from the query',
      block !== '' && !/queryParam\(url, '(?:path|cwd|dir)'\)/u.test(block), 'a path query parameter appeared')
    check('...and resolves its services lazily and defensively',
      block.includes('const service = (name) =>') &&
      /service\('subprocess'\)/u.test(block) &&
      /service\('workingDirectory'\)/u.test(block))
  }
}

// ---------------------------------------------------------------------------
// client: the slot shadow and the strip's structure (no browser here)
// ---------------------------------------------------------------------------
console.log('\n[client structure]')
{
  const client = readFileSync(path.join(pluginRoot, 'lib/client.js'), 'utf8')
  check('the API map exposes the read route',
    /gitHistory: '\/api\/dsh-ssh-workspace\/git-history'/u.test(client))
  check('the shadow uses the official forge TAB_ID as its cell key',
    client.includes("const FORGE_TAB_KEY = '@deepseek-ai/dsh-experimental-client-ui-forge'") &&
      /key: FORGE_TAB_KEY,/u.test(client))
  check('...at a LOWER priority than the shipped registration (the lowest wins)',
    /const FORGE_TAB_SHADOW_PRIORITY = -100/u.test(client) &&
      /priority: FORGE_TAB_SHADOW_PRIORITY,/u.test(client))
  check('...and declares the official locale namespace, because it renders the official props',
    /const FORGE_TAB_LOCALE = FORGE_TAB_KEY/u.test(client) && /locale: FORGE_TAB_LOCALE,/u.test(client))
  check('exactly one right-sidebar pane-tab registration body exists',
    (client.match(/name: 'sidebar\.right\.pane\.tab'/gu) ?? []).length === 1,
    String((client.match(/name: 'sidebar\.right\.pane\.tab'/gu) ?? []).length))
  check('the title seat is NOT shadowed (one tab, official chip)',
    !client.includes("name: 'sidebar.right.pane.tab.title'"))
  check('the wrapper renders the official component with the official props',
    /jsx\(official\.component,/u.test(client) &&
      /\.\.\.officialProps,/u.test(client) &&
      /\.\.\.split\.rest,/u.test(client))
  check('the official injected face is reused rather than rebuilt',
    client.includes('entry.inject(sessionId)') && client.includes('forgeFaceCache'))
  check('the official hook sources are handed over as selector hooks, not snapshot values',
    client.includes('function forgeHookFor') &&
      client.includes('usePanel = forgeHookFor(split?.hooks.panel)') &&
      client.includes('React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)') &&
      /typeof selector === 'function' \? selector : identity/u.test(client))
  check('the strip shows at most 20 rows', /const HISTORY_ROW_LIMIT = 20/u.test(client))
  check('the strip asks only for its own Session and the row limit',
    client.includes('encodeURIComponent(sessionId)}&limit=${HISTORY_ROW_LIMIT}'))
  check('loading, empty, non-repository and failure are one grey line each',
    ['history.loading', 'history.empty', 'history.notRepository', 'history.failed']
      .every(key => client.includes(`'${key}':`)))
  check('the failure line carries the reason in its tooltip, not in red text',
    /title: state\.message === '' \? undefined : state\.message,/u.test(client))
  check('the strip is inside its own scrolling body, not the official scrollport',
    /\.sshwsp-cr-official \{[^}]*overflow: hidden/u.test(client) &&
      /\.sshwsp-cr-history-list \{[^}]*overflow-y: auto/u.test(client))
  check('the history state line is not painted with the error colour',
    (() => {
      const rule = /\.sshwsp-cr-history-state \{[^}]*\}/u.exec(client)
      return rule !== null && !/state-error/u.test(rule[0])
    })())
  check('a shadow left by a previous module instance is not mistaken for the official panel',
    client.includes('sshwspForgeShadow === true') && client.includes('ForgeTabWithHistory.sshwspForgeShadow = true'))
  check('a face missing a required hook source is not rendered blind',
    client.includes('function isUsableForgeSplit') && /isUsableForgeSplit\(split\)/u.test(client))
  check('the fail-safe withdraws the shadow after the grace',
    /const FORGE_TAB_GRACE_MS = 5000/u.test(client) &&
      /forgeTabShadowDispose = null/u.test(client) &&
      /dispose\(\)/u.test(client))
  check('a refresh control exists and is disabled while loading',
    client.includes("className: 'sshwsp-cr-history-refresh'") &&
      /disabled: state\.phase === 'loading'/u.test(client))
  check('every history string exists in both dictionaries',
    ['history.title', 'history.refresh', 'history.loading', 'history.empty', 'history.notRepository', 'history.failed', 'history.truncated']
      .every(key => (client.match(new RegExp(`'${key.replace(/\./gu, '\\.')}':`, 'gu')) ?? []).length === 2))
}

// ---------------------------------------------------------------------------
// hook shape: the official panel receives SELECTOR HOOKS, not snapshot values
// ---------------------------------------------------------------------------
// This is the one contract a source grep cannot prove and a wrong reading
// silently breaks: the renderer's `observableHook` hands an entry a hook
// function, and the panel calls `usePanel((current) => current)`. Handing over
// the snapshot instead compiles, renders a normal-looking component — and then
// the panel throws on its first call. The helpers are extracted and driven with
// a minimal React stand-in so the call shape itself is executed here.
console.log('\n[hook shape]')
{
  const client = readFileSync(path.join(pluginRoot, 'lib/client.js'), 'utf8')
  const start = client.indexOf('function splitForgeFace (face)')
  const end = client.indexOf('    /**\n     * The official change-request body', start)
  const block = start < 0 || end < 0 ? '' : client.slice(start, end)
  check('the helper block is extractable for a behaviour test', block !== '', 'splitForgeFace/forgeHookFor not found')
  if (block !== '') {
    const hookCalls = []
    const ReactStub = {
      useSyncExternalStore (subscribe, getSnapshot) {
        hookCalls.push({ subscribe, getSnapshot })
        return getSnapshot()
      },
    }
    let helpers = null
    try {
      // eslint-disable-next-line no-new-func
      helpers = new Function('React', `${block}; return { splitForgeFace, isUsableForgeSplit, forgeHookFor, absentForgeHook }`)(ReactStub)
    } catch (error) {
      check('the helper block evaluates', false, error instanceof Error ? error.message : String(error))
    }
    if (helpers !== null) {
      const source = { getSnapshot: () => ({ value: 7 }), subscribe: () => () => {} }
      const usePanel = helpers.forgeHookFor(source)
      check('a source is handed over as a FUNCTION, not its snapshot',
        typeof usePanel === 'function', typeof usePanel)
      check('...which applies the selector exactly as the panel calls it',
        usePanel((current) => current.value) === 7)
      check('...and returns the whole snapshot when no selector is passed',
        usePanel().value === 7)
      check('...through a real external-store subscription',
        hookCalls.length > 0 && typeof hookCalls[0].getSnapshot === 'function')
      check('the hook identity is stable per source (no resubscribe per render)',
        helpers.forgeHookFor(source) === usePanel)
      check('a different source gets a different hook',
        helpers.forgeHookFor({ getSnapshot: () => null, subscribe: () => () => {} }) !== usePanel)
      check('an absent source still yields a callable hook returning undefined',
        typeof helpers.absentForgeHook === 'function' && helpers.absentForgeHook((value) => value) === undefined)

      const split = helpers.splitForgeFace({
        hooks: { panel: source, host: source, locale: source },
        reconnect: () => {},
        refresh: async () => {},
      })
      check('the face split keeps the plain callbacks in `rest`',
        split !== null && typeof split.rest.reconnect === 'function' && typeof split.rest.refresh === 'function')
      check('...and keeps `hooks` out of the plain props',
        split !== null && split.rest.hooks === undefined && split.hooks.panel === source)
      check('a complete face is usable', helpers.isUsableForgeSplit(split) === true)
      check('a face missing a required hook source is NOT usable',
        helpers.isUsableForgeSplit(helpers.splitForgeFace({ hooks: { panel: source } })) === false)
      check('a keyedHooks face is refused instead of guessed',
        helpers.splitForgeFace({ hooks: { panel: source }, keyedHooks: { panel: () => {} } }) === null)
    }
  }
}

// ---------------------------------------------------------------------------
// real git, when the checkout has one
// ---------------------------------------------------------------------------
console.log('\n[real git log]')
{
  try {
    const output = execFileSync('git', gitLogArgv(5).slice(1), {
      cwd: pluginRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parsed = parseGitLog(output, 5)
    check('this checkout\'s real git log parses', parsed.commits.length > 0, String(parsed.commits.length))
    check('...every row carries sha / short sha / date / author / subject',
      parsed.commits.every(commit =>
        /^[0-9a-f]{40}$/u.test(commit.sha) &&
        /^[0-9a-f]{7,}$/u.test(commit.shortSha) &&
        /^\d{4}-\d{2}-\d{2}$/u.test(commit.date) &&
        typeof commit.author === 'string' &&
        typeof commit.subject === 'string'))
    check('...at most the requested number of rows', parsed.commits.length <= 5)
  } catch (error) {
    console.log(`  SKIP  real git log (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`)
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed === 0 ? 0 : 1)
