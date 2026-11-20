/**
 * The pickers' one-round-trip directory listing, against a REAL shell.
 *
 * Two shapes live here: `dirsListingCommand` (subdirectories only) and
 * `entriesListingCommand` (directories first, then files — what the pickers
 * actually request, so the folder they are about to mount can be read).
 *
 * ## Why the listing stopped using `sftp.readdir`
 *
 * It is the correct primitive and it is slow for the one thing the pickers do:
 * every entry comes back with its ATTRIBUTES, which the server produces with a
 * per-entry `lstat`. A shared `/tmp` with tens of thousands of entries became a
 * listing that never finished (measured on a ~300 ms link: 25 000 entries did
 * not come back in 30 s), while one `ls` on the same host takes 44 ms. The
 * pickers only need NAMES, so `dirsListingCommand` pipes `ls` through an `awk`
 * filter that applies the cap on the REMOTE side — a 25 000-entry directory
 * sends at most `limit` names — and reports the directory's total and the
 * account's writability on stderr in the same round trip.
 *
 * ## Why this suite runs a shell instead of stubbing one
 *
 * The command is the feature. A stubbed `exec` would prove the parser against a
 * string this suite also wrote, which is exactly the class of test that passes
 * while the shipped script is broken (the tar writer's lesson). So the real
 * command is spawned with `sh` against a temporary directory built here, and
 * the shipped parser reads its answer. What that exercises, and what it does
 * not, is stated in each assertion rather than implied.
 *
 * The pickers fall back to the SFTP route for any answer that is not exactly
 * this shape; `routes-smoke` owns that half.
 *
 * ## Windows
 *
 * The command is POSIX shell, so this suite needs a `sh` — Git Bash or MSYS
 * provides one, and a checkout without it SKIPs rather than fails. Where one is
 * present the paths are handed over in the shell's own spelling (`/c/Users/...`
 * for `C:\Users\...`) and the echoed path is compared against both. The
 * permission cases (an unreadable directory, a directory nobody may write) are
 * skipped there: chmod on Windows does not produce those states, so asserting
 * them would assert the platform, not the command.
 *
 * Run: node tests/dirs-listing-smoke.mjs
 */

import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== dirs listing smoke ===\n')

const isWindows = process.platform === 'win32'
const hasShell = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
if (!hasShell) {
  console.log('  SKIP  needs a POSIX shell (this suite runs `sh`)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}

/**
 * The path as the POSIX shell sees it.
 *
 * The command under test is shipped to a remote host, where the path is already
 * POSIX. Locally it has to be translated, or `sh` reads `C:\Users\me` as a
 * relative name with a colon in it. Only the Windows spelling changes; a POSIX
 * checkout gets its own path back untouched.
 *
 * @param {string} target - a native absolute path.
 * @returns {string} the same path in shell spelling.
 */
function shellPath (target) {
  if (!isWindows) return target
  return target
    .replace(/\\/gu, '/')
    .replace(/^([A-Za-z]):/u, (_match, drive) => `/${drive.toLowerCase()}`)
}

/**
 * Whether the path the shell echoed back names the directory we asked for.
 *
 * @param {string} echoed - the path from the parsed listing.
 * @param {string} native - the native path it should name.
 * @returns {boolean} true when they are the same directory.
 */
function samePath (echoed, native) {
  return echoed === native || echoed === shellPath(native)
}

// routes.js imports the fence helpers from remote-fs.js, which needs the Host
// peers at load time. A bare checkout has none, so build the same stub root
// tests/run.mjs builds and point the resolver at it BEFORE the import —
// otherwise this suite would skip in CI and prove nothing.
if (!process.env.DSH_CORE_ROOT && process.env.DSH_NO_PEER_STUBS !== '1') {
  const { installPeerStubs } = await import(pathToFileURL(path.join(pluginRoot, 'tests', 'peer-stubs.mjs')).href)
  process.env.DSH_CORE_ROOT = installPeerStubs(path.join(pluginRoot, 'tests', '.peer-stubs'))
}
// DSH_CORE_ROOT alone is not enough for this import chain: peers.js searches
// DSH_PEER_ROOT and the installed profiles, but never DSH_CORE_ROOT, so a stub
// tree would be built and then ignored.
if (process.env.DSH_CORE_ROOT) {
  process.env.DSH_PEER_ROOT = [process.env.DSH_CORE_ROOT, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)
}

const { dirsListingCommand, parseDirsListing, entriesListingCommand, parseEntriesListing } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib', 'routes.js')).href
)

/**
 * Run the shipped command through a real `sh` and hand its answer to the
 * shipped parser.
 *
 * @param {string} dir - absolute directory, or '' for the login directory.
 * @param {number} limit - the cap the command is built with.
 * @param {string} [cwd] - the shell's working directory (`path === ''`).
 * @returns {{parse: object|null, result: object, command: string}} the parsed answer and the raw run.
 */
function list (dir, limit, cwd) {
  const command = dirsListingCommand(dir === '' ? '' : shellPath(dir), limit)
  const result = spawnSync('sh', ['-c', command], {
    cwd: cwd ?? pluginRoot,
    encoding: 'utf8',
  })
  const outcome = { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  return { command, result: outcome, parse: parseDirsListing(outcome, limit) }
}

/**
 * The all-entries variant: directories AND files, directories first.
 *
 * @param {string} dir - absolute directory, or '' for the login directory.
 * @param {number} limit - the cap the command is built with.
 * @param {string} [cwd] - the shell's working directory (`path === ''`).
 * @returns {{parse: object|null, result: object, command: string}} the parsed answer and the raw run.
 */
function listAll (dir, limit, cwd) {
  const command = entriesListingCommand(dir === '' ? '' : shellPath(dir), limit)
  const result = spawnSync('sh', ['-c', command], {
    cwd: cwd ?? pluginRoot,
    encoding: 'utf8',
  })
  const outcome = { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  return { command, result: outcome, parse: parseEntriesListing(outcome, limit) }
}

const root = await mkdtemp(path.join(tmpdir(), 'dsh-dirs-listing-'))
try {
  for (const name of ['alpha', 'beta', '.hidden', 'with space', '-dash', 'locked', 'noread']) {
    await mkdir(path.join(root, name))
  }
  await mkdir(path.join(root, 'alpha', 'inner'))
  await writeFile(path.join(root, 'notes.txt'), 'x')
  // Symlinks need a privilege Windows does not grant by default. Their point
  // here is that `ls -p` never marks one as a directory; a plain file covers
  // that too, so the two extra names are only asserted where they exist.
  let symlinks = true
  try {
    await symlink('alpha', path.join(root, 'linkdir'))
    await symlink('/nonexistent', path.join(root, 'dangling'))
  } catch {
    symlinks = false
  }
  const DIRS = '-dash,.hidden,alpha,beta,locked,noread,with space'
  const FILES = symlinks ? 'dangling,linkdir,notes.txt' : 'notes.txt'
  const ALL = symlinks ? 10 : 8
  // chmod does not deny access on Windows, so these two states cannot be built
  // there and the assertions that need them say so instead of failing.
  const permissions = !isWindows
  if (permissions) {
    await chmod(path.join(root, 'locked'), 0o555)
    await chmod(path.join(root, 'noread'), 0o300)
  }

  // ---- the real command ------------------------------------------------------

  console.log('[the shipped command]')
  {
    const { parse, result } = list(root, 500)
    check('the command answers with the subdirectories',
      parse !== null && parse.names.join() === DIRS,
      parse === null ? result.stderr.trim() : parse.names.join())
    check('...counted once each, files and symlinks excluded',
      parse !== null && parse.total === 7 && !parse.names.includes('notes.txt') &&
        !parse.names.includes('linkdir') && !parse.names.includes('dangling'),
      JSON.stringify(parse))
    check('...with names that keep their real spelling (space, leading dash, dot)',
      parse !== null && parse.names.includes('with space') && parse.names.includes('-dash') &&
        parse.names.includes('.hidden'))
    check('...and the account can write there', parse?.writable === true, String(parse?.writable))
    check('...echoing the directory it listed',
      parse !== null && samePath(parse.path, root), `${String(parse?.path)} vs ${root}`)
    check('the shell reports the true total on stderr, not on stdout',
      result.stderr.includes('__dsh_ssh_ws_dirs__ 7 1 ') && !result.stdout.includes('__dsh_ssh_ws_dirs__'),
      result.stderr.trim())
  }

  {
    const { parse } = list(root, 3)
    check('the cap is applied remotely: three names for a seven-directory tree',
      parse !== null && parse.names.length === 3 && parse.total === 7,
      JSON.stringify({ names: parse?.names, total: parse?.total }))
    check('...and the three that survive are the first in C order',
      parse?.names.join() === '-dash,.hidden,alpha', parse?.names.join())
  }

  {
    const { parse } = list('', 500, root)
    check('an empty path lists and resolves the login directory in one round trip',
      parse !== null && samePath(parse.path, realpathSync(root)) && parse.names.length === 7,
      JSON.stringify({ path: parse?.path, names: parse?.names.length }))
  }

  {
    const quoted = path.join(root, "odd 'name")
    await mkdir(quoted)
    const { parse } = list(quoted, 10)
    check('a directory whose name carries a quote is quoted, not interpolated',
      parse !== null && parse.total === 0 && samePath(parse.path, quoted), JSON.stringify(parse))
    await rm(quoted, { recursive: true, force: true })
  }

  {
    const { parse } = list(`${root}/`, 10)
    check('a trailing slash is echoed as given and still lists',
      parse !== null && samePath(parse.path, `${root}/`) && parse.total === 7, JSON.stringify(parse))
  }

  // ---- the all-entries variant ------------------------------------------------

  console.log('[directories and files]')
  {
    const { parse, result } = listAll(root, 500)
    check('the all-entries command lists directories first, then files',
      parse !== null &&
        parse.names.slice(0, 7).join() === DIRS &&
        parse.names.slice(7).sort().join() === FILES,
      parse === null ? result.stderr.trim() : parse.names.join())
    check('...typing the leading names by position, not a per-name column',
      parse?.dirCount === 7 && parse?.total === ALL, JSON.stringify(parse))
    check('...and the account can write there', parse?.writable === true, String(parse?.writable))
  }

  {
    const { parse } = listAll(root, 3)
    check('the all-entries cap spends on directories first',
      parse?.names.length === 3 && parse?.dirCount === 3 && parse?.total === ALL &&
        parse.names.every(name => ['-dash', '.hidden', 'alpha'].includes(name)),
      JSON.stringify(parse))
  }

  {
    const { parse } = listAll(root, ALL - 1)
    // One slot short of the whole directory: every directory keeps its place
    // and the files fill what is left, in name order.
    const files = FILES.split(',')
    check('...and only then lets files into the remaining room',
      parse?.names.length === ALL - 1 && parse?.dirCount === 7 &&
        parse.names.slice(7).join() === files.slice(0, files.length - 1).join(),
      JSON.stringify(parse))
  }

  {
    const { parse } = listAll(path.join(root, 'nope'), 10)
    check('a missing directory is a fallback for the all-entries listing too',
      parse === null, JSON.stringify(parse))
  }

  {
    const all = { exitCode: 0, stdout: 'd\nf\n', stderr: '__dsh_ssh_ws_all__ 2 1 1 /x\n' }
    check('the all-entries parser reads the expected shape',
      parseEntriesListing(all, 2)?.names.join() === 'd,f' && parseEntriesListing(all, 2)?.dirCount === 1)
    check('...and refuses a non-zero exit', parseEntriesListing({ ...all, exitCode: 1 }, 2) === null)
    check('...a missing marker',
      parseEntriesListing({ exitCode: 0, stdout: 'd\n', stderr: '' }, 2) === null)
    check('...the script\'s fallback line',
      parseEntriesListing({ exitCode: 0, stdout: '', stderr: '__dsh_ssh_ws_all__ fallback\n' }, 2) === null)
    check('...a name count that is not min(total, limit)',
      parseEntriesListing({ ...all, stdout: 'd\n' }, 2) === null)
    check('...more directories than the total says',
      parseEntriesListing({ exitCode: 0, stdout: 'd\nf\n', stderr: '__dsh_ssh_ws_all__ 2 3 1 /x\n' }, 2) === null)
  }

  // ---- the shapes the caller must NOT trust ---------------------------------

  console.log('[refusals and fallback]')
  {
    const { parse } = list(path.join(root, 'nope'), 10)
    check('a missing directory is a fallback, never an empty listing', parse === null, JSON.stringify(parse))
  }
  {
    const { parse } = list(path.join(root, 'notes.txt'), 10)
    check('a file is a fallback too (only directories are listed)', parse === null, JSON.stringify(parse))
  }
  if (permissions && typeof process.getuid === 'function' && process.getuid() !== 0) {
    const { parse } = list(path.join(root, 'noread'), 10)
    check('an unreadable directory is a fallback, so SFTP can report the real error',
      parse === null, JSON.stringify(parse))
    check('a writable-by-nobody directory reports writable:false',
      list(path.join(root, 'locked'), 10).parse?.writable === false)
  } else {
    console.log(permissions
      ? '  SKIP  running as root: the permission cases cannot be exercised'
      : '  SKIP  Windows: chmod cannot deny access, so the permission cases have no state to build')
  }

  // ---- the parser is strict about the shape it accepts ----------------------

  console.log('[the parser]')
  const good = { exitCode: 0, stdout: 'a\nb\n', stderr: '__dsh_ssh_ws_dirs__ 2 1 /home/dev\n' }
  check('the expected shape parses', parseDirsListing(good, 2)?.names.join() === 'a,b')
  check('a non-zero exit is refused',
    parseDirsListing({ ...good, exitCode: 1 }, 2) === null)
  check('the script\'s fallback line is refused',
    parseDirsListing({ exitCode: 0, stdout: '', stderr: '__dsh_ssh_ws_dirs__ fallback\n' }, 2) === null)
  check('a missing marker is refused',
    parseDirsListing({ exitCode: 0, stdout: 'a\n', stderr: 'ls: Permission denied\n' }, 2) === null)
  check('the marker is read from a later stderr line (ls noise before it)',
    parseDirsListing({ exitCode: 0, stdout: 'a\n', stderr: `warning\n__dsh_ssh_ws_dirs__ 1 1 /x\n` }, 2)?.total === 1)
  check('more names than the cap is refused',
    parseDirsListing({ exitCode: 0, stdout: 'a\nb\nc\n', stderr: '__dsh_ssh_ws_dirs__ 3 1 /x\n' }, 2) === null)
  check('more names than the total is refused (a newline in a name looks like this)',
    parseDirsListing({ exitCode: 0, stdout: 'a\nb\nc\n', stderr: '__dsh_ssh_ws_dirs__ 2 1 /x\n' }, 5) === null)
  check('the root is a legal directory (its echoed path is a bare `/`)',
    parseDirsListing({ exitCode: 0, stdout: '', stderr: '__dsh_ssh_ws_dirs__ 0 0 /\n' }, 5)?.path === '/')
  check('a non-absolute echoed path is refused',
    parseDirsListing({ exitCode: 0, stdout: '', stderr: '__dsh_ssh_ws_dirs__ 0 1 relative/path\n' }, 5) === null)
  check('a blank stdout line is not a name',
    parseDirsListing({ exitCode: 0, stdout: '\n', stderr: '__dsh_ssh_ws_dirs__ 0 1 /x\n' }, 5)?.names.length === 0)
} finally {
  // Restore search permission first: `noread` has to be traversable to be removed.
  await chmod(path.join(root, 'noread'), 0o700).catch(() => {})
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
