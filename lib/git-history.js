/**
 * Recent commit history for one Session's working directory.
 *
 * This is the data half of the "recent commits" strip the browser half renders
 * under the official change-request panel, and it is deliberately a *read*:
 *
 *  - the only inputs are a Session id and a row limit — there is no `path`
 *    parameter, so a caller cannot point git at a directory of their choosing;
 *  - the argv is fixed here (`git --no-pager log` with a machine-shaped
 *    `--pretty` format), never assembled from request text;
 *  - the working directory comes from the Host's own Session record
 *    (`workingDirectory` first, then the Session header), never from the
 *    request.
 *
 * The command runs through `ctx.subprocess`, which is the seam this plugin
 * already took over for `ssh://` working directories (see
 * lib/patch-subprocess.js): a remote workspace therefore runs `git` on the SSH
 * host, a local workspace runs it locally, and neither is spelled differently
 * here. A directory that is not a git repository is a *successful* answer
 * (`notRepository: true`), not an error — the strip says so in one grey line
 * instead of reporting a failure.
 *
 * Parsing contract: `-z` makes git separate records with NUL, and `%x1f`
 * separates the five fields inside one record. A subject can contain almost
 * anything except NUL, so the record separator is the robust one; a record
 * that does not yield five fields or whose full sha is not hex is dropped
 * rather than mis-rendered.
 *
 * @module @shiqyka/dsh-ssh-workspace/git-history
 */

import { isAbsolute } from 'node:path'
import { isRemotePath, parseRemotePath } from './protocol.js'

/** Rows the strip asks for when the caller names no limit. */
export const GIT_HISTORY_DEFAULT_LIMIT = 20

/** Hard ceiling for one request. The UI never asks for more than the default. */
export const GIT_HISTORY_MAX_LIMIT = 100

/** How long one `git log` may take before the read is abandoned. */
export const GIT_HISTORY_TIMEOUT_MS = 15_000

/** Grace between a termination request and dropping the transport. */
export const GIT_HISTORY_TERMINATE_GRACE_MS = 2_000

/** Captured stdout ceiling. 100 rows of %s cannot approach this in practice. */
const GIT_LOG_MAX_BYTES = 1024 * 1024

/** Captured stderr ceiling — only the last line is ever surfaced. */
const GIT_STDERR_MAX_BYTES = 16 * 1024

/** Field separator inside one record (matches `%x1f` in the format below). */
export const GIT_LOG_FIELD_SEPARATOR = '\u001f'

/** Record separator git uses with `-z`. */
export const GIT_LOG_RECORD_SEPARATOR = '\u0000'

/** One record: full sha, short sha, date, author name, subject. */
export const GIT_LOG_FORMAT = [
  '%H',
  '%h',
  '%ad',
  '%an',
  '%s',
].join('%x1f')

/**
 * Session ids this route accepts. DSH brands them as `session-<uuid>` in
 * practice; the pattern admits any ordinary opaque id while refusing values
 * that could only be an attempt to smuggle something else into the request.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u

/**
 * The fixed argv for one history read. Never contains request text: `limit`
 * is a clamped integer, so the only variable part is `-n <count>`.
 *
 * `-n limit+1` is how truncation is detected without a second command: one
 * extra record proves there is more history than the strip will show.
 *
 * @param {number} limit - clamped row limit (1…{@link GIT_HISTORY_MAX_LIMIT}).
 * @returns {string[]} argv with `git` at index 0.
 */
export function gitLogArgv (limit) {
  // Defense in depth: the route normalizes `limit` first, and this function is
  // also called by tests with a number. A non-finite value must still produce a
  // legal argv rather than the literal string "NaN".
  const asked = Number.isFinite(limit) ? Math.trunc(limit) : GIT_HISTORY_DEFAULT_LIMIT
  const count = Math.min(Math.max(1, asked), GIT_HISTORY_MAX_LIMIT)
  return [
    'git',
    '--no-pager',
    'log',
    '-z',
    '--date=short',
    `--pretty=format:${GIT_LOG_FORMAT}`,
    '-n',
    String(count + 1),
    '--',
  ]
}

/**
 * Normalize a request's `limit`.
 *
 * @param {unknown} raw - query text, or nothing.
 * @returns {number|undefined} the clamped limit, or undefined when the text is
 *   not a positive integer (the route answers 400 rather than guessing).
 */
export function normalizeGitHistoryLimit (raw) {
  if (raw === undefined || raw === null || raw === '') return GIT_HISTORY_DEFAULT_LIMIT
  const text = String(raw)
  if (!/^\d+$/u.test(text)) return undefined
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 1) return undefined
  return Math.min(value, GIT_HISTORY_MAX_LIMIT)
}

/**
 * Parse the output of {@link gitLogArgv}.
 *
 * Defensive on purpose: a subject may contain a stray field separator, and a
 * future git version could spell a record differently. A record is kept only
 * when it has the five fields and a hex full sha; everything else is skipped.
 *
 * @param {string} text - raw stdout.
 * @param {number} limit - the same limit the command was given.
 * @returns {{commits: Array<{sha: string, shortSha: string, date: string, author: string, subject: string}>, truncated: boolean}}
 */
export function parseGitLog (text, limit) {
  const asked = Number.isFinite(limit) ? Math.trunc(limit) : GIT_HISTORY_DEFAULT_LIMIT
  const max = Math.min(Math.max(1, asked), GIT_HISTORY_MAX_LIMIT)
  const commits = []
  let truncated = false
  if (typeof text !== 'string' || text === '') return { commits, truncated }
  for (const record of text.split(GIT_LOG_RECORD_SEPARATOR)) {
    if (record === '') continue
    const fields = record.split(GIT_LOG_FIELD_SEPARATOR)
    if (fields.length < 5) continue
    const [sha, shortSha, date, author] = fields
    // A subject containing the field separator is joined back rather than
    // truncating the title: the first four fields are unambiguous.
    const subject = fields.slice(4).join(GIT_LOG_FIELD_SEPARATOR)
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/iu.test(sha)) continue
    commits.push({
      sha,
      shortSha: typeof shortSha === 'string' && shortSha !== '' ? shortSha : sha.slice(0, 7),
      date: typeof date === 'string' ? date : '',
      author: typeof author === 'string' ? author : '',
      subject,
    })
    if (commits.length > max) {
      truncated = true
      break
    }
  }
  if (commits.length > max) commits.length = max
  return { commits, truncated }
}

/**
 * Classify git's stderr when `git log` exited nonzero.
 *
 * `LC_ALL=C` is part of the spawn environment precisely so these English
 * phrases are the ones git prints; a localized host would otherwise turn "not
 * a git repository" into words this function cannot know. Two of the answers
 * are normal states of a directory — it is not a repository, or the repository
 * has no commits yet — and must not be shown as failures.
 *
 * @param {string} stderr - captured stderr text.
 * @returns {{kind: 'not-repository'|'no-commits'|'failed', message: string}}
 */
export function classifyGitFailure (stderr) {
  const text = typeof stderr === 'string' ? stderr : ''
  if (/not a git repository/iu.test(text)) return { kind: 'not-repository', message: '' }
  if (/does not have any commits yet/iu.test(text)) return { kind: 'no-commits', message: '' }
  if (/bad default revision/iu.test(text)) return { kind: 'no-commits', message: '' }
  return { kind: 'failed', message: firstLine(text) }
}

/** First non-empty line, bounded — an ssh banner can be long. */
function firstLine (text) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.slice(0, 300)
  }
  return ''
}

/**
 * Normalize the collected-output seam into text plus a lossy flag.
 *
 * Collect-mode readers are offset-based (`readFrom(0)`), but the shape is
 * provider-owned; a provider without readers is treated as "no output" rather
 * than crashing the route.
 *
 * @param {unknown} reader - `handle.collected.stdout` / `.stderr`.
 * @returns {{text: string, lossy: boolean}} collected text and truncation flag.
 */
function collectedText (reader) {
  if (reader === null || reader === undefined) return { text: '', lossy: false }
  try {
    if (typeof reader.readFrom === 'function') {
      const window = reader.readFrom(0)
      return {
        text: typeof window?.text === 'string' ? window.text : '',
        lossy: window?.lossy === true,
      }
    }
    if (typeof reader.text === 'string') return { text: reader.text, lossy: false }
  } catch { /* reader unavailable — report no output */ }
  return { text: '', lossy: false }
}

/**
 * Resolve one Session's effective working directory without a filesystem call.
 *
 * Order matters: the live Session plus the `workingDirectory` projection is the
 * authoritative value (a Session may have `cd`-ed since its header was
 * written). The header is the second answer, and `sessionQuery` can still name
 * a persisted Session that this Host process has not attached — after a
 * restart, for instance.
 *
 * @param {{sessions?: object, workingDirectory?: object, sessionQuery?: object}} deps - optional services.
 * @param {string} sessionId - Session identity.
 * @returns {Promise<{cwd: string}|{error: {code: string, message: string}}>} the directory or a structured refusal.
 */
export async function resolveSessionCwd (deps, sessionId) {
  const { sessions, workingDirectory, sessionQuery } = deps ?? {}
  let session
  try {
    session = sessions?.get?.(sessionId)
  } catch {
    session = undefined
  }
  if (session !== undefined && session !== null) {
    try {
      const cwd = workingDirectory?.get?.(session)
      if (typeof cwd === 'string' && cwd !== '') return { cwd }
    } catch { /* projection unavailable — fall through to the header */ }
    const headerCwd = session.header?.cwd
    if (typeof headerCwd === 'string' && headerCwd !== '') return { cwd: headerCwd }
  }
  if (sessionQuery !== undefined && sessionQuery !== null && typeof sessionQuery.listSessions === 'function') {
    try {
      const records = await sessionQuery.listSessions()
      for (const record of Array.isArray(records) ? records : []) {
        if (record?.header?.id !== sessionId) continue
        const headerCwd = record.header?.cwd
        if (typeof headerCwd === 'string' && headerCwd !== '') return { cwd: headerCwd }
      }
    } catch { /* query unavailable — report the Session as unreadable below */ }
  }
  return {
    error: {
      code: 'session-unavailable',
      message: `Session ${JSON.stringify(sessionId)} has no readable working directory on this Host`,
    },
  }
}

/**
 * Classify a working directory into the execution world it belongs to.
 *
 * @param {unknown} cwd - the Session directory.
 * @returns {'remote'|'local'|'invalid'} the world, or `invalid` when the value
 *   is neither an `ssh://` path nor an absolute host path.
 */
export function classifyCwd (cwd) {
  if (typeof cwd !== 'string' || cwd === '') return 'invalid'
  if (isRemotePath(cwd)) {
    try {
      parseRemotePath(cwd)
      return 'remote'
    } catch {
      return 'invalid'
    }
  }
  return isAbsolute(cwd) ? 'local' : 'invalid'
}

/** One message from an unknown thrown value. */
function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one Session's recent commits.
 *
 * Every failure is a structured value, never a throw: the route answers with a
 * status code and the browser half shows one quiet line. The success shape is
 * `{ok: true, cwd, world, commits, truncated}` plus `notRepository` when the
 * directory simply is not a repository.
 *
 * @param {object} deps - Host services; all optional so the route can degrade.
 * @param {object} [deps.subprocess] - `ctx.subprocess` (the patched seam).
 * @param {object} [deps.sessions] - `ctx.sessions`.
 * @param {object} [deps.workingDirectory] - `ctx.workingDirectory`.
 * @param {object} [deps.sessionQuery] - `ctx.sessionQuery`.
 * @param {object} request - `{sessionId, limit}`; neither is a path.
 * @returns {Promise<object>} structured result.
 */
export async function readGitHistory (deps, request) {
  const { subprocess, sessions, workingDirectory, sessionQuery } = deps ?? {}
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, code: 'bad-session', message: 'session must be a Session id' }
  }
  const limit = normalizeGitHistoryLimit(request?.limit)
  if (limit === undefined) {
    return { ok: false, code: 'bad-limit', message: `limit must be a positive integer, at most ${GIT_HISTORY_MAX_LIMIT}` }
  }
  if (subprocess === null || subprocess === undefined || typeof subprocess.spawn !== 'function') {
    return {
      ok: false,
      code: 'subprocess-unavailable',
      message: 'this Host composes no subprocess service, so git cannot be run',
    }
  }
  const resolved = await resolveSessionCwd({ sessions, workingDirectory, sessionQuery }, sessionId)
  if (resolved.error !== undefined) return { ok: false, ...resolved.error }
  const cwd = resolved.cwd
  const world = classifyCwd(cwd)
  if (world === 'invalid') {
    return {
      ok: false,
      code: 'invalid-cwd',
      message: `the Session working directory is not an absolute path: ${JSON.stringify(cwd)}`,
    }
  }

  const timeout = AbortSignal.timeout(GIT_HISTORY_TIMEOUT_MS)
  let handle
  try {
    handle = subprocess.spawn({
      argv: gitLogArgv(limit),
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: GIT_LOG_MAX_BYTES },
        stderr: { maxBytes: GIT_STDERR_MAX_BYTES },
      },
      graceMs: GIT_HISTORY_TERMINATE_GRACE_MS,
      signal: timeout,
      // The panel needs one language: git's diagnostics are matched by text
      // (see classifyGitFailure), and the SSH host may well be non-English.
      // GIT_CONFIG_COUNT=0 keeps a host-level config from changing the output
      // shape, and the prompt/lock switches keep a read from waiting on or
      // touching the repository.
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        LANGUAGE: 'C',
      },
    })
  } catch (error) {
    return { ok: false, code: 'spawn-failed', message: messageOf(error), cwd, world }
  }

  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    if (timeout.aborted) {
      return { ok: false, code: 'timeout', message: `git log timed out after ${GIT_HISTORY_TIMEOUT_MS} ms`, cwd, world }
    }
    return { ok: false, code: 'spawn-failed', message: messageOf(error), cwd, world }
  }
  if (timeout.aborted) {
    return { ok: false, code: 'timeout', message: `git log timed out after ${GIT_HISTORY_TIMEOUT_MS} ms`, cwd, world }
  }

  const stdout = collectedText(handle.collected?.stdout)
  const stderr = collectedText(handle.collected?.stderr)
  if (outcome?.exitCode === 0) {
    const parsed = parseGitLog(stdout.text, limit)
    return {
      ok: true,
      cwd,
      world,
      commits: parsed.commits,
      // A lossy stdout means the answer is incomplete even when git itself had
      // more to say, so the strip must say "showing recent commits" too.
      truncated: parsed.truncated || stdout.lossy,
    }
  }
  const failure = classifyGitFailure(stderr.text)
  if (failure.kind === 'not-repository') {
    return { ok: true, cwd, world, commits: [], truncated: false, notRepository: true }
  }
  if (failure.kind === 'no-commits') {
    return { ok: true, cwd, world, commits: [], truncated: false }
  }
  return {
    ok: false,
    code: 'git-failed',
    message: `git log failed (exit ${outcome?.exitCode ?? 'null'})${failure.message === '' ? '' : `: ${failure.message}`}`,
    cwd,
    world,
  }
}
