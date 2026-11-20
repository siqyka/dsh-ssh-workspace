/**
 * A minimal but honest Cordis host for suites that need a `ctx`.
 *
 * Fourteen suites used to build their own object literal with a `get` that
 * answered exactly one name. Each one drifted independently: some had `effect`,
 * some did not, none refused a call after disposal, and a suite that forgot a
 * service read `undefined` instead of failing the way the real Host does. This
 * module is the one place those shapes are defined.
 *
 * "Honest" means this host may be SMALLER than Cordis but never LOOSER:
 *
 * - a second `provide` for one name throws (Cordis keys the implementation
 *   store by a per-service isolation symbol, so a duplicate is a hard error);
 * - every accessor throws after `dispose()` (a disposed fiber cannot be read,
 *   written or used to install an effect);
 * - `tools.register` validates the definition and refuses a duplicate name;
 * - a method the local backend does not implement throws BY NAME instead of
 *   returning `undefined`, so a suite cannot pass because the call went
 *   nowhere. That failure mode is the whole reason this file exists.
 *
 * The local filesystem half runs on real `node:fs`. The remote half is the
 * plugin's own `RemoteFileSystem`, installed onto the local half by
 * `patch-fs.js` — so a suite exercises the real routing, the real fences and
 * the real publish sequence rather than a copy of them.
 *
 * Zero dependencies: plain `node:` modules only, like the rest of `tests/`.
 *
 * @module tests/support/plugin-host
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { installRemoteFileSystem, uninstallRemoteFileSystem } from '../../lib/patch-fs.js'

/** Methods a dsh-fs backend is expected to answer. */
const BACKEND_METHODS = [
  'resolve',
  'processPath',
  'processPathFromHostPath',
  'fileUrl',
  'contains',
  'stat',
  'lstat',
  'readText',
  'streamText',
  'readBytes',
  'readByteRange',
  'listDir',
  'writeText',
  'editText',
  'watch',
]

/** The spelling a target object or a plain path string stands for. */
function spellingOf (target) {
  if (typeof target === 'string') return target
  const key = target?.targetKey ?? target?.displayPath
  if (typeof key !== 'string') throw new Error('plugin-host: a target must carry targetKey or displayPath')
  return key
}

/** A version token shaped like the one `remote-fs.js` computes. */
function versionOf (stats) {
  const ino = typeof stats.ino === 'number' ? stats.ino : 0
  return String(ino) + ':' + String(stats.size) + ':' + String(Math.floor(stats.mtimeMs))
}

/**
 * The local (host) filesystem backend, over real `node:fs`.
 *
 * It implements the part of the dsh-fs contract the plugin's routing touches,
 * and nothing else: `watch` throws because a poller here would be a second
 * implementation of a feature the plugin already owns, and the suites that
 * need change observation drive their own watcher.
 */
export class LocalBackend {
  constructor (options = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.sandboxMode = options.sandboxMode ?? 'workspace-write'
    /** Every mutating call, in order — a suite can assert it never ran. */
    this.writes = []
  }

  resolve (target, opts) {
    const spelling = spellingOf(target)
    const base = typeof opts?.cwd === 'string' ? opts.cwd : this.cwd
    const absolute = path.isAbsolute(spelling) ? spelling : path.resolve(base, spelling)
    return { targetKey: absolute, displayPath: absolute }
  }

  processPath (target) {
    return spellingOf(target)
  }

  processPathFromHostPath (hostPath) {
    return hostPath
  }

  fileUrl (target) {
    return pathToFileURL(spellingOf(target)).href
  }

  contains (parent, child) {
    const outer = spellingOf(parent)
    const inner = spellingOf(child)
    const relative = path.relative(outer, inner)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  stat (target) {
    const stats = fs.statSync(spellingOf(target))
    return { version: versionOf(stats), type: stats.isDirectory() ? 'directory' : 'file', size: stats.size }
  }

  lstat (target) {
    const stats = fs.lstatSync(spellingOf(target))
    const type = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file'
    return { version: versionOf(stats), type, size: stats.size }
  }

  readText (target) {
    return fs.readFileSync(spellingOf(target), 'utf8')
  }

  async * streamText (target) {
    yield fs.readFileSync(spellingOf(target), 'utf8')
  }

  readBytes (target, _signal, maxBytes) {
    const buffer = fs.readFileSync(spellingOf(target))
    return typeof maxBytes === 'number' ? buffer.subarray(0, maxBytes) : buffer
  }

  readByteRange (target, range) {
    const buffer = fs.readFileSync(spellingOf(target))
    const start = typeof range?.start === 'number' ? range.start : 0
    const end = typeof range?.end === 'number' ? range.end : buffer.length
    return buffer.subarray(start, end)
  }

  listDir (target) {
    const dir = spellingOf(target)
    return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const absolute = path.join(dir, entry.name)
      const stats = fs.lstatSync(absolute)
      const type = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file'
      return { name: entry.name, type, size: stats.size, version: versionOf(stats) }
    })
  }

  writeText (target, content, expected) {
    const file = spellingOf(target)
    const before = fs.existsSync(file) ? versionOf(fs.statSync(file)) : null
    if (expected?.kind === 'createIfAbsent' && before !== null) {
      const error = new Error('the file already exists: ' + file)
      error.code = 'FS_NOT_OBSERVED'
      throw error
    }
    if (expected?.kind === 'replaceIfVersion' && before !== expected.version) {
      const error = new Error('the file changed since it was read: ' + file)
      error.code = 'FS_STALE_VERSION'
      throw error
    }
    // Staged publication, like the remote half: a reader never sees a partial
    // file, and a suite asserting "the old bytes survive a failed write" has
    // something real to assert against.
    const staging = file + '.plugin-host-' + String(process.pid) + '-' + String(this.writes.length) + '.tmp'
    fs.writeFileSync(staging, content, 'utf8')
    fs.renameSync(staging, file)
    this.writes.push({ file, bytes: Buffer.byteLength(content) })
    const after = versionOf(fs.statSync(file))
    return { operation: before === null ? 'create' : 'update', version: after, before, after }
  }

  editText (target, edit, expected) {
    const file = spellingOf(target)
    const text = fs.readFileSync(file, 'utf8')
    const before = versionOf(fs.statSync(file))
    if (expected?.kind === 'replaceIfVersion' && before !== expected.version) {
      const error = new Error('the file changed since it was read: ' + file)
      error.code = 'FS_STALE_VERSION'
      throw error
    }
    if (edit?.replaceAll !== true && text.split(edit.oldText).length > 2) {
      const error = new Error('the edit target appears more than once')
      error.code = 'FS_STALE_VERSION'
      throw error
    }
    const next = edit?.replaceAll === true ? text.split(edit.oldText).join(edit.newText) : text.replace(edit.oldText, edit.newText)
    if (next === text) {
      const error = new Error('the edit target was not found')
      error.code = 'FS_NOT_OBSERVED'
      throw error
    }
    return this.writeText(target, next)
  }

  watch () {
    throw new Error('plugin-host: the local backend does not implement watch(); drive your own watcher')
  }
}

/** A refusal for a method the double deliberately does not have. */
function unimplemented (what) {
  throw new Error('plugin-host: ' + what + ' is not implemented by this host')
}

/**
 * Build one host.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] - the local backend's cwd.
 * @param {object} [options.services] - services to provide up front, by name.
 * @param {object} [options.local] - options for {@link LocalBackend}.
 * @param {object} [options.remote] - `{ engine, RemoteFileSystem, passthrough }`;
 *   when given, the remote half is installed onto `ctx.fs`.
 * @param {(line: string) => void} [options.onLog] - receives each logger line.
 * @returns {object} the host handle.
 */
export function createHost (options = {}) {
  const logs = []
  const tools = new Map()
  const services = new Map()
  const listeners = new Map()
  /** Pending `inject` bodies, waiting for a service. */
  const pending = []
  /** Every effect disposer, oldest first; disposed in reverse. */
  const effects = []
  let disposed = false

  const log = (level, message) => {
    const line = '[' + level + '] ' + String(message)
    logs.push(line)
    options.onLog?.(line)
  }

  const assertLive = (what) => {
    if (disposed) throw new Error('plugin-host: the fiber is disposed; ' + what + ' is refused')
  }

  const logger = {
    debug: (message) => log('debug', message),
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
    error: (message) => log('error', message),
  }

  /** Run every `inject` body whose services are now present. */
  const settle = () => {
    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index]
      if (!entry.deps.every((name) => services.has(name))) continue
      pending.splice(index, 1)
      index -= 1
      entry.body(ctx)
    }
  }

  const provide = (name, value) => {
    assertLive('provide(' + name + ')')
    if (services.has(name)) throw new Error('plugin-host: service "' + name + '" is already provided')
    services.set(name, value)
    settle()
    return value
  }

  const ctx = {
    get (name) {
      assertLive('get(' + name + ')')
      return services.get(name)
    },
    set (name, value) {
      assertLive('set(' + name + ')')
      if (services.has(name) && services.get(name) !== value) {
        throw new Error('plugin-host: only the providing fiber may replace "' + name + '"')
      }
      services.set(name, value)
      settle()
      return value
    },
    provide,
    inject (deps, body) {
      assertLive('inject(' + deps.join(', ') + ')')
      const list = Array.isArray(deps) ? deps : [deps]
      if (list.every((name) => services.has(name))) {
        body(ctx)
        return
      }
      pending.push({ deps: list, body })
    },
    effect (body, label) {
      assertLive('effect(' + String(label ?? 'anonymous') + ')')
      const dispose = body()
      const entry = { label, dispose: typeof dispose === 'function' ? dispose : () => {} }
      effects.push(entry)
      return () => {
        const index = effects.indexOf(entry)
        if (index === -1) return
        effects.splice(index, 1)
        entry.dispose()
      }
    },
    on (event, handler) {
      assertLive('on(' + event + ')')
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index !== -1) current.splice(index, 1)
      }
    },
    emit (event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    logger,
    config: options.config ?? {},
    tools: {
      register (tool) {
        assertLive('tools.register()')
        if (tool === null || typeof tool !== 'object') throw new Error('plugin-host: a tool definition must be an object')
        if (typeof tool.name !== 'string' || tool.name === '') throw new Error('plugin-host: a tool needs a non-empty name')
        if (typeof tool.execute !== 'function') throw new Error('plugin-host: tool "' + tool.name + '" needs execute()')
        if (tools.has(tool.name)) throw new Error('plugin-host: tool "' + tool.name + '" is already registered')
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name) }
      },
      list () { return [...tools.values()] },
      get (name) { return tools.get(name) },
    },
  }

  const host = {
    ctx,
    logs,
    services,
    effects,
    tools,
    local: new LocalBackend(options.local),
    /** Install the plugin's remote half onto the local backend. */
    installRemote (remote) {
      if (remote?.RemoteFileSystem === undefined) throw new Error('plugin-host: installRemote needs a RemoteFileSystem class')
      provide('fs', host.local)
      const router = installRemoteFileSystem(ctx, { engine: remote.engine, passthrough: remote.passthrough }, remote.RemoteFileSystem)
      ctx.effect(() => () => { uninstallRemoteFileSystem(ctx.get('fs')) }, 'plugin-host: remote fs')
      host.router = router
      return router
    },
    /** Run a plugin's `apply()` against this host. */
    apply (applyFn, config) {
      assertLive('apply()')
      return applyFn(ctx, config)
    },
    dispose () {
      if (disposed) return
      disposed = true
      for (let index = effects.length - 1; index >= 0; index -= 1) effects[index].dispose()
      effects.length = 0
      pending.length = 0
      listeners.clear()
      tools.clear()
    },
  }

  for (const [name, value] of Object.entries(options.services ?? {})) services.set(name, value)

  return host
}

/** Every method name a local backend is expected to answer. */
export { BACKEND_METHODS, unimplemented }
