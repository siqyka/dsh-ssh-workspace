/**
 * The shared host double: it must be smaller than Cordis, never looser.
 *
 * Every assertion here is a REFUSAL. A double that quietly answers `undefined`
 * for a missing service, or keeps accepting registrations after disposal, makes
 * a suite pass for the wrong reason — and that is the exact failure mode the
 * fourteen hand-written ctx literals had drifted into. So the suite drives the
 * refusals first, then the two behaviours that are supposed to work (deferred
 * injection, staged local writes).
 *
 * Run: node tests/plugin-host-smoke.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createHost, LocalBackend } from './support/plugin-host.mjs'

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS  ' + label) } else {
    failures += 1
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

console.log('\n=== plugin host smoke ===\n')

/** Run `body`, returning the thrown message (or null when nothing threw). */
function thrown (body) {
  try {
    body()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

console.log('[refusals]')
{
  const host = createHost()
  host.ctx.provide('alpha', 1)
  const duplicate = thrown(() => host.ctx.provide('alpha', 2))
  check('a second provide for one name throws', duplicate !== null && /already provided/u.test(duplicate), String(duplicate))
  check('...and the first value survives', host.ctx.get('alpha') === 1, String(host.ctx.get('alpha')))
  check('an unknown service reads as undefined, not a throw', host.ctx.get('nope') === undefined)
  const replace = thrown(() => host.ctx.set('alpha', 3))
  check('only the providing fiber may replace a service', replace !== null && /providing fiber/u.test(replace), String(replace))
  check('providing the same value twice is not a replacement', thrown(() => host.ctx.set('alpha', 1)) === null)

  host.ctx.tools.register({ name: 'probe', execute: async () => ({ ok: true }) })
  const dupeTool = thrown(() => host.ctx.tools.register({ name: 'probe', execute: async () => ({ ok: true }) }))
  check('a duplicate tool name is refused', dupeTool !== null && /already registered/u.test(dupeTool), String(dupeTool))
  const noExecute = thrown(() => host.ctx.tools.register({ name: 'broken' }))
  check('a tool without execute() is refused', noExecute !== null && /needs execute/u.test(noExecute), String(noExecute))
  const noName = thrown(() => host.ctx.tools.register({ execute: async () => ({}) }))
  check('a tool without a name is refused', noName !== null && /non-empty name/u.test(noName), String(noName))

  host.dispose()
  const afterDispose = thrown(() => host.ctx.get('alpha'))
  check('a disposed fiber refuses get()', afterDispose !== null && /disposed/u.test(afterDispose), String(afterDispose))
  const provideAfter = thrown(() => host.ctx.provide('beta', 1))
  check('a disposed fiber refuses provide()', provideAfter !== null && /disposed/u.test(provideAfter), String(provideAfter))
  const registerAfter = thrown(() => host.ctx.tools.register({ name: 'late', execute: async () => ({}) }))
  check('a disposed fiber refuses tools.register()', registerAfter !== null && /disposed/u.test(registerAfter), String(registerAfter))
  check('disposing twice is not an error', thrown(() => host.dispose()) === null)
}

console.log('\n[injection]')
{
  const host = createHost()
  const order = []
  host.ctx.inject(['fs'], () => { order.push('fs') })
  check('a body waiting on a missing service does not run', order.length === 0, JSON.stringify(order))
  host.ctx.provide('fs', {})
  check('...and runs the moment it is provided', JSON.stringify(order) === '["fs"]', JSON.stringify(order))

  const eager = []
  host.ctx.provide('shell', {})
  host.ctx.inject(['shell'], () => { eager.push('shell') })
  check('a body whose service is already there runs immediately', JSON.stringify(eager) === '["shell"]', JSON.stringify(eager))

  const pairHost = createHost()
  const both = []
  pairHost.ctx.inject(['left', 'right'], () => { both.push('pair') })
  pairHost.ctx.provide('left', {})
  check('a two-service body waits for both', both.length === 0, JSON.stringify(both))
  pairHost.ctx.provide('right', {})
  check('...and runs once when the second arrives', JSON.stringify(both) === '["pair"]', JSON.stringify(both))
  pairHost.dispose()
  host.dispose()
}

console.log('\n[effects]')
{
  const host = createHost()
  const closed = []
  host.ctx.effect(() => () => { closed.push('first') }, 'first')
  host.ctx.effect(() => () => { closed.push('second') }, 'second')
  check('no effect body has run yet', closed.length === 0, JSON.stringify(closed))
  host.dispose()
  check('disposal runs effects in reverse order', JSON.stringify(closed) === '["second","first"]', JSON.stringify(closed))

  const manual = createHost()
  const seen = []
  const stop = manual.ctx.effect(() => () => { seen.push('stop') }, 'manual')
  stop()
  check('an effect can be disposed on its own', JSON.stringify(seen) === '["stop"]', JSON.stringify(seen))
  stop()
  check('...and disposing it twice runs the disposer once', seen.length === 1, JSON.stringify(seen))
  manual.dispose()
  check('...and disposal does not run it again', seen.length === 1, JSON.stringify(seen))
}

console.log('\n[the local backend]')
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-host-'))
  const file = path.join(root, 'note.txt')
  fs.writeFileSync(file, 'hello', 'utf8')
  const backend = new LocalBackend({ cwd: root })

  const resolved = backend.resolve('note.txt')
  check('a relative path resolves against the cwd', resolved.targetKey === file, String(resolved.targetKey))
  check('a resolved target is an absolute spelling', path.isAbsolute(resolved.displayPath), String(resolved.displayPath))
  check('stat reports the size and a version', backend.stat(resolved).size === 5 && typeof backend.stat(resolved).version === 'string')
  check('readText returns the bytes', backend.readText(resolved) === 'hello')
  check('readByteRange slices', backend.readByteRange(resolved, { start: 1, end: 3 }).toString() === 'el')
  check('readBytes honours the cap', backend.readBytes(resolved, undefined, 2).toString() === 'he')
  check('contains accepts a child and rejects a sibling',
    backend.contains({ targetKey: root }, resolved) === true && backend.contains({ targetKey: root }, { targetKey: path.join(root, '..', 'elsewhere') }) === false)
  check('fileUrl is a file: URL', backend.fileUrl(resolved).startsWith('file:'), backend.fileUrl(resolved))
  const list = backend.listDir({ targetKey: root })
  check('listDir reports one file', list.length === 1 && list[0].name === 'note.txt' && list[0].type === 'file', JSON.stringify(list))

  const before = backend.stat(resolved).version
  const write = backend.writeText(resolved, 'goodbye', { kind: 'replaceIfVersion', version: before })
  check('a versioned write lands', fs.readFileSync(file, 'utf8') === 'goodbye')
  check('...and reports before/after versions', write.operation === 'update' && write.before === before && write.after !== before, JSON.stringify(write))
  check('...without leaving a staging file behind', fs.readdirSync(root).length === 1, JSON.stringify(fs.readdirSync(root)))

  const stale = thrown(() => backend.writeText(resolved, 'clobber', { kind: 'replaceIfVersion', version: before }))
  check('a stale version is refused with FS_STALE_VERSION', /changed since it was read/u.test(String(stale)), String(stale))
  check('...and the file keeps its current bytes', fs.readFileSync(file, 'utf8') === 'goodbye')

  const created = backend.writeText({ targetKey: path.join(root, 'new.txt') }, 'x', { kind: 'createIfAbsent' })
  check('createIfAbsent creates', created.operation === 'create' && fs.existsSync(path.join(root, 'new.txt')))
  const exists = thrown(() => backend.writeText({ targetKey: path.join(root, 'new.txt') }, 'y', { kind: 'createIfAbsent' }))
  check('createIfAbsent refuses an existing file', /already exists/u.test(String(exists)), String(exists))

  const edit = backend.editText(resolved, { oldText: 'good', newText: 'great' })
  check('an edit lands', fs.readFileSync(file, 'utf8') === 'greatbye', fs.readFileSync(file, 'utf8'))
  check('...and reports the update', edit.operation === 'update')
  const missing = thrown(() => backend.editText(resolved, { oldText: 'absent', newText: 'x' }))
  check('an edit whose target is absent is refused', /was not found/u.test(String(missing)), String(missing))
  const ambiguous = thrown(() => backend.editText({ targetKey: path.join(root, 'twice.txt') }, { oldText: 'a', newText: 'b' }))
  fs.writeFileSync(path.join(root, 'twice.txt'), 'aa', 'utf8')
  const ambiguous2 = thrown(() => backend.editText({ targetKey: path.join(root, 'twice.txt') }, { oldText: 'a', newText: 'b' }))
  check('an ambiguous edit is refused unless replaceAll is set', /more than once/u.test(String(ambiguous2)), String(ambiguous2 ?? ambiguous))
  check('...and replaceAll accepts it', backend.editText({ targetKey: path.join(root, 'twice.txt') }, { oldText: 'a', newText: 'b', replaceAll: true }).operation === 'update')

  const watch = thrown(() => backend.watch())
  check('watch is refused by name, not silently undefined', watch !== null && /does not implement watch/u.test(watch), String(watch))

  fs.rmSync(root, { recursive: true, force: true })
}

console.log('\n=== ' + passed + ' passed, ' + failures + ' failed ===')
process.exit(failures === 0 ? 0 : 1)
