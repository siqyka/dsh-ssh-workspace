/**
 * Pure protocol checks: the `ssh://` path grammar every other layer builds on.
 *
 * Imports only `lib/protocol.js`, which has no dependencies at all — this
 * suite runs anywhere, including CI without the DSH peers installed.
 *
 * Run: node tests/protocol-smoke.mjs
 */

import { parseRemotePath, isRemotePath, normalizeRemotePath, formatRemotePath, formatRemoteFileUrl, isRemotePathUnder, remoteBasename, remoteDirname } from '../lib/protocol.js'

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
const json = (value) => JSON.stringify(value)

console.log('\n=== protocol smoke ===\n')

console.log('[parseRemotePath]')
check('splits alias and absolute path',
  json(parseRemotePath('ssh://myhost/srv/app/file.txt')) === json({ alias: 'myhost', remotePath: '/srv/app/file.txt' }),
  json(parseRemotePath('ssh://myhost/srv/app/file.txt')))
check('normalizes .. segments in the remote path',
  parseRemotePath('ssh://myhost/a/b/../c')?.remotePath === '/a/c',
  parseRemotePath('ssh://myhost/a/b/../c')?.remotePath)
check('accepts the alias root as /', parseRemotePath('ssh://myhost/')?.remotePath === '/')
check('rejects a bare local path', parseRemotePath('/srv/app') === undefined)
check('rejects a non-string', parseRemotePath(undefined) === undefined)
let bareAlias
try {
  parseRemotePath('ssh://myhost')
} catch (error) {
  bareAlias = error
}
check('throws for the ssh:// scheme with no path', bareAlias instanceof Error, String(bareAlias))

console.log('\n[isRemotePath]')
check('true for any ssh:// spelling', isRemotePath('ssh://myhost/x') === true)
check('true even for an invalid spelling (prefix test)', isRemotePath('ssh://') === true)
check('false for a Windows path', isRemotePath('E:/work/file.txt') === false)
check('false for a POSIX path', isRemotePath('/home/user/file.txt') === false)

console.log('\n[normalizeRemotePath]')
check('collapses duplicate and dot segments', normalizeRemotePath('/a//b/./c') === '/a/b/c')
check('resolves ..', normalizeRemotePath('/a/b/../../c') === '/c')
check('keeps / for the root', normalizeRemotePath('///') === '/')
let relative
try {
  normalizeRemotePath('a/b')
} catch (error) {
  relative = error
}
check('rejects a relative path', relative instanceof Error, String(relative))

console.log('\n[formatRemotePath]')
check('round-trips through parseRemotePath',
  json(parseRemotePath(formatRemotePath('myhost', '/srv/app/../app/file.txt'))) === json({ alias: 'myhost', remotePath: '/srv/app/file.txt' }),
  formatRemotePath('myhost', '/srv/app/../app/file.txt'))

console.log('\n[formatRemoteFileUrl]')
check('percent-encodes spaces and non-ASCII, keeps separators',
  formatRemoteFileUrl('/srv/my app/文件.txt') === 'file:///srv/my%20app/%E6%96%87%E4%BB%B6.txt',
  formatRemoteFileUrl('/srv/my app/文件.txt'))
check('a plain path is unchanged apart from the scheme',
  formatRemoteFileUrl('/srv/app/file.txt') === 'file:///srv/app/file.txt',
  formatRemoteFileUrl('/srv/app/file.txt'))

console.log('\n[isRemotePathUnder]')
check('accepts descendants', isRemotePathUnder('/a/b', '/a/b/c/d') === true)
check('accepts the path itself', isRemotePathUnder('/a/b', '/a/b') === true)
check('rejects a name-prefix sibling', isRemotePathUnder('/a/b', '/a/bc') === false)
check('rejects the parent', isRemotePathUnder('/a/b', '/a') === false)
check('root contains everything absolute', isRemotePathUnder('/', '/anything') === true)

console.log('\n[basename / dirname]')
check('basename of a file', remoteBasename('/srv/app/file.txt') === 'file.txt')
check('basename of the root is /', remoteBasename('/') === '/')
check('dirname of a file', remoteDirname('/srv/app/file.txt') === '/srv/app')
check('dirname one level deep is /', remoteDirname('/file.txt') === '/')
check('dirname of the root is /', remoteDirname('/') === '/')

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
