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
check('downloads the row itself, not a guessed path',
  clientSource.includes('downloadTreeRow(absPath, isDir)'))
check('uploads beside the row',
  clientSource.includes('uploadTreeRow(absPath, isDir)'))
check('upload targets the row\'s own directory when it is one',
  clientSource.includes('isDir ? parts.remotePath : remoteDirOf(parts.remotePath)'))
// A directory download used to be DISABLED with "not supported yet", which was
// true of the browser and false of the agent's own tool. It is now a real
// action backed by the archive route, and the assertion says so rather than
// checking for an apology.
check('a directory download is a real action, not an apology',
  clientSource.includes("translate('transfer.downloadDir')") &&
    !clientSource.includes('downloadDirUnsupported'))
check('the browser reuses the streaming download route',
  clientSource.includes('fetch(`${API.download}?alias='))
check('a directory download goes to the archive route',
  clientSource.includes('fetch(`${API.downloadTree}?alias=') &&
    clientSource.includes('isDir ? API.downloadTree : API.download'))
check('the browser reuses the streaming upload route',
  clientSource.includes('API.upload}${query}'))

console.log('\n[file-panel header]')

check('an upload action is registered into DSH\'s file panel header',
  clientSource.includes("slots.inject('sidebar.right.tab.files.actions'"))
check('the header action reads the panel\'s own directory',
  clientSource.includes("typeof props?.absolutePath === 'string'"))
check('the header action renders nothing for a non-remote listing',
  clientSource.includes('if (remote === null) return null'))
check('the header uploads into the listed directory',
  clientSource.includes('sendTreeUpload(remote.alias, remote.remotePath, file)'))
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
