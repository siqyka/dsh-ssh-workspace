/**
 * Behaviour checks for the transfers the plugin adds to DSH's own file tree.
 *
 * The panel dialog has its own upload/download, but the files users actually
 * work with are listed by DSH's "Files" panel, whose rows this plugin already
 * hooks for @ references. Those rows carry full `ssh://alias/abs/path`
 * spellings, so the transfer helpers have to split them back into an alias and
 * a POSIX path before any route can act.
 *
 * The client bundle is a plain script (no module system of its own), so this
 * suite lifts the two pure helpers out of the source and runs them directly:
 * a wrong split would silently write to the wrong remote directory, which no
 * structural check would catch.
 *
 * Run: node tests/tree-transfer-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

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

console.log('\n=== tree transfer smoke ===\n')

const clientSource = readFileSync(path.join(pluginRoot, 'lib/client.js'), 'utf8')

/**
 * Pull one top-level `function name (...) { ... }` out of the client source by
 * brace matching, and evaluate it. The helpers under test are deliberately
 * dependency-free so they can run here unchanged.
 */
function extractFunction (name) {
  const start = clientSource.indexOf(`function ${name} (`)
  if (start < 0) throw new Error(`client.js does not define ${name}()`)
  const open = clientSource.indexOf('{', start)
  let depth = 0
  for (let i = open; i < clientSource.length; i += 1) {
    const ch = clientSource[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return clientSource.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}()`)
}

// eslint-disable-next-line no-new-func
const remoteTargetOf = new Function(`${extractFunction('remoteTargetOf')}; return remoteTargetOf`)()
// eslint-disable-next-line no-new-func
const remoteDirOf = new Function(`${extractFunction('remoteDirOf')}; return remoteDirOf`)()

console.log('[remoteTargetOf]')

const target = remoteTargetOf('ssh://web/home/deploy/app.tar.gz')
check('a tree row splits into alias and POSIX path',
  target?.alias === 'web' && target?.remotePath === '/home/deploy/app.tar.gz',
  JSON.stringify(target))

const atRoot = remoteTargetOf('ssh://web/')
check('a root row keeps the absolute root', atRoot?.remotePath === '/', JSON.stringify(atRoot))

const rootFile = remoteTargetOf('ssh://web/probe.txt')
check('a file at the root keeps its leading slash', rootFile?.remotePath === '/probe.txt', JSON.stringify(rootFile))

const dotted = remoteTargetOf('ssh://web/a/../b/./c.txt')
check('dot segments are resolved lexically', dotted?.remotePath === '/b/c.txt', JSON.stringify(dotted))

const escaping = remoteTargetOf('ssh://web/../../etc/passwd')
check('a path cannot climb above the remote root', escaping?.remotePath === '/etc/passwd', JSON.stringify(escaping))

check('a local path is not a remote target', remoteTargetOf('/home/me/file.txt') === null)
check('a malformed remote spelling is refused', remoteTargetOf('ssh://no-path') === null)
check('a non-string is refused', remoteTargetOf(undefined) === null)
check('an empty string is refused', remoteTargetOf('') === null)

const spacedAlias = remoteTargetOf('ssh://web-prod/home/app dir/x.txt')
check('a path with spaces survives intact',
  spacedAlias?.remotePath === '/home/app dir/x.txt', JSON.stringify(spacedAlias))

console.log('\n[remoteDirOf]')

check('a file resolves to its parent directory', remoteDirOf('/home/deploy/app.tar.gz') === '/home/deploy')
check('a top-level file resolves to the root', remoteDirOf('/probe.txt') === '/')
check('a trailing slash is ignored', remoteDirOf('/srv/tree/') === '/srv')
check('the root is its own parent', remoteDirOf('/') === '/')

console.log('\n[wire-up]')

check('the row menu offers a download action', clientSource.includes("translate('transfer.download')"))
check('the row menu offers an upload action', clientSource.includes("translate('transfer.upload')"))
check('transfers are gated on a remote row', clientSource.includes('remoteTargetOf(absPath)'))
// The menu now hands its resolved targets to one gesture entry; a single
// remote row still reaches the per-file save dialog, so "download THIS file"
// and "download these rows" share a decision point instead of a code path.
check('downloads the row itself, not a guessed path',
  clientSource.includes('await downloadTreeRow(chosen[0].path, chosen[0].isDir === true)'))
check('uploads beside the row',
  clientSource.includes('uploadTreeRow(absPath, isDir)'))
check('upload targets the row\'s own directory when it is one',
  clientSource.includes('isDir ? parts.remotePath : remoteDirOf(parts.remotePath)'))
// A directory download used to be DISABLED with "not supported yet", which was
// true of the browser and false of the agent's own tool. It is now a real
// action backed by the archive route, and the assertion says so rather than
// checking for an apology.
//
// The menu label is now FIXED ("下载到本机") for a file and for a directory: the
// scope is stated by the destination dialog, not by a second verb that changed
// its wording with the row kind.
check('a directory download is a real action, not an apology',
  clientSource.includes("label: translate('transfer.download')") &&
    !clientSource.includes("translate('transfer.downloadDir')") &&
    !clientSource.includes('downloadDirUnsupported'))
check('the browser reuses the streaming download route',
  clientSource.includes('const route = isDir ? API.downloadTree : API.download') &&
    clientSource.includes('fetch(`${route}${query}`)'))
check('a directory download goes to the archive route',
  clientSource.includes('const route = isDir ? API.downloadTree : API.download') &&
    clientSource.includes('isDir ? API.downloadTree : API.download'))
check('the browser reuses the chunked upload route',
  clientSource.includes('postFileInChunks(alias, dir, file, {') &&
    clientSource.includes('fetch(API.uploadChunk'))

console.log('\n[file-panel header]')

check('a transfer-queue action is registered into DSH\'s file panel header',
  clientSource.includes("slots.inject('sidebar.right.tab.files.actions'"))
check('the header action reads the panel\'s own directory',
  clientSource.includes("typeof props?.absolutePath === 'string'"))
// The header used to hold an upload button too, competing with the one
// control that has to stay reachable. The slice is the component itself: the
// same keys legitimately appear in the row menu and the directory browser,
// and only here is their absence the point.
const headerSlice = clientSource.slice(
  clientSource.indexOf('function FilePanelTransferActions (props)'),
  clientSource.indexOf('let taskMenuEl = null'))
check('the header no longer offers an upload button',
  headerSlice.length > 0 &&
    !headerSlice.includes("t('transfer.upload')") &&
    !headerSlice.includes('enqueueUploads('),
  'upload from the header is the control this change removed')
check('...nor keeps the uploadability probe for a button that is gone',
  headerSlice.length > 0 &&
    !headerSlice.includes('uploadable') &&
    !headerSlice.includes('API.ls'),
  'a listing request whose verdict no remaining control consumes is dead work')
check('the progress entry is not gated on a transfer being in flight',
  headerSlice.length > 0 &&
    !headerSlice.includes('queue.items.length > 0 &&') &&
    !headerSlice.includes('if (remote === null && queue.items.length === 0) return null'),
  'hiding the entry when the queue drains is what made it look broken')
check('...and the entry belongs to a remote listing only',
  headerSlice.length > 0 &&
    headerSlice.includes('if (remote === null) return null') &&
    headerSlice.includes('remoteTargetOf(absolutePath)'),
  'a local directory has no host to transfer to, so the header keeps DSH\'s own controls')
check('...and still publishes the directory for the empty-space menu',
  headerSlice.includes("'data-sshwsp-dir': remote.remotePath") &&
    headerSlice.includes("'data-sshwsp-alias': remote.alias"),
  'the blank-area right-click would answer nothing again')
check('the header offers no directory download',
  !clientSource.includes('downloadHere'))
check('the post-upload refresh clicks the reload control, not auto-refresh',
  clientSource.includes("querySelectorAll('[data-files-reload]')"))
check('the auto-refresh toggle is never clicked',
  !clientSource.includes("querySelector('[data-files-auto-refresh]')"))

// Both languages must carry every transfer key, or one locale shows raw keys.
const transferKeys = [...clientSource.matchAll(/'transfer\.([A-Za-z]+)':/g)].map(m => m[1])
const uniqueKeys = [...new Set(transferKeys)]
for (const key of uniqueKeys) {
  const occurrences = transferKeys.filter(k => k === key).length
  check(`locale coverage for transfer.${key}`, occurrences >= 2, `${occurrences} definition(s)`)
}

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
