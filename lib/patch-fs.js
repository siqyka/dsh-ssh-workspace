/**
 * Take over the live `ctx.fs` service so it serves both host and remote targets.
 *
 * Cordis refuses a second `provide('fs')` in one isolation scope (the
 * implementation store is keyed by a per-service isolation symbol and collides),
 * and the deployment's own local backend is already registered under that name.
 * `ctx.set('fs', …)` is refused too — only the providing fiber may overwrite a
 * service value.
 *
 * So instead of re-providing the service, this module patches the ONE service
 * instance that already exists: the remote-aware methods are installed as OWN
 * properties, every other method is forwarded to the surrounding backend bound
 * to the original receiver, and the untouched originals stay on the prototype.
 * Installing a property cannot fail on a service that is already registered,
 * works regardless of plugin mount order, and leaves the local path completely
 * unchanged — it still runs through the deployment's own sandbox fence.
 *
 * @module @shiqyka/dsh-ssh-workspace/patch-fs
 */

/** Methods the remote half implements itself and therefore takes over. */
const REMOTE_METHODS = [
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

/** Instance marker proving this module already patched the service. */
export const INSTALLED = Symbol.for('dsh-ssh-workspace.installed')

/**
 * Methods whose FIRST argument is a plain PATH STRING plus an options object
 * (`resolve(path, opts)`, `lstat(path, opts, signal)`) rather than a resolved
 * target. Routing these on `target.displayPath` would read a property that does
 * not exist, classifying every remote path as local — so they are routed on the
 * string itself, falling back to the options' `cwd`, which is how a RELATIVE
 * remote path inherits its remote identity.
 */
const PATH_METHODS = new Set(['resolve', 'lstat'])

/**
 * The path or target spelling a call should be routed on.
 *
 * @param {string} name - the method being routed.
 * @param {any[]} args - the call's arguments.
 * @returns {string} the spelling to test for the `ssh://` scheme.
 */
function routingSpelling (name, args) {
  const first = args[0]
  const cwd = args[1]?.cwd
  const cwdSpelling = typeof cwd === 'string' ? cwd : ''
  if (PATH_METHODS.has(name)) {
    // An explicit `ssh://` path is remote on its own.
    if (typeof first === 'string' && first.startsWith('ssh://')) return first
    // Otherwise the call is remote exactly when the cwd it resolves against is:
    // a bare relative name carries no scheme of its own.
    if (cwdSpelling !== '') return cwdSpelling
    return typeof first === 'string' ? first : ''
  }
  if (typeof first === 'string') return first
  return String(first?.targetKey ?? first?.displayPath ?? '')
}

/**
 * Build a forwarder that calls the surrounding backend's ORIGINAL method with
 * the original receiver, so its internal state (`this.config`, `this.locks`,
 * `this.ctx`, …) resolves exactly as it did before patching.
 *
 * @param {object} target - the live service instance.
 * @param {object} proto - its prototype.
 * @returns {(name: string) => Function | undefined} a method resolver.
 */
function originalMethodOf (target, proto) {
  const cache = new Map()
  return (name) => {
    if (cache.has(name)) return cache.get(name)
    const fn = proto?.[name]
    const bound = typeof fn === 'function' ? fn.bind(target) : undefined
    cache.set(name, bound)
    return bound
  }
}

/**
 * Install the remote-aware methods onto the live `ctx.fs` service.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} options - install options.
 * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live SSH engine.
 * @param {object} RemoteFileSystemClass - the router class to instantiate.
 * @returns {object | undefined} the router, or undefined when no `fs` service is mounted.
 * @throws {Error} when a required method is missing from the surrounding backend.
 */
export { routingSpelling, PATH_METHODS }
export function installRemoteFileSystem (ctx, options, RemoteFileSystemClass) {
  const target = ctx.get('fs')
  if (target === undefined || target === null) return undefined
  if (target[INSTALLED] !== undefined) return target[INSTALLED]

  const proto = Object.getPrototypeOf(target)
  if (proto === null) throw new Error('ssh-workspace: the mounted ctx.fs service has no prototype to wrap')

  const original = originalMethodOf(target, proto)
  const router = new RemoteFileSystemClass({
    engine: options.engine,
    base: target,
    baseProto: proto,
  })

  for (const name of REMOTE_METHODS) {
    const remote = router[name]
    if (typeof remote !== 'function') continue
    const local = original(name)
    if (local === undefined) {
      // The surrounding backend does not implement this primitive (for example
      // `watch` on a minimal backend). The remote half still answers for remote
      // targets, and a local call reports a programming error rather than
      // silently returning undefined.
      const fn = function (...args) {
        if (routingSpelling(name, args).startsWith('ssh://')) return remote.apply(router, args)
        throw new Error(`ssh-workspace: the mounted filesystem backend does not implement ${name}()`)
      }
      Object.defineProperty(target, name, { value: fn, writable: true, configurable: true, enumerable: false })
      continue
    }
    const fn = function (...args) {
      if (routingSpelling(name, args).startsWith('ssh://')) return remote.apply(router, args)
      return local.apply(null, args)
    }
    Object.defineProperty(target, name, { value: fn, writable: true, configurable: true, enumerable: false })
  }

  Object.defineProperty(target, INSTALLED, { value: router, writable: false, configurable: true, enumerable: false })
  return router
}

/**
 * Undo {@link installRemoteFileSystem}, restoring the original methods.
 *
 * @param {object | undefined} target - the patched service instance.
 * @returns {void}
 */
export function uninstallRemoteFileSystem (target) {
  if (target === undefined || target === null) return
  if (target[INSTALLED] === undefined) return
  for (const name of REMOTE_METHODS) {
    if (Object.hasOwn(target, name)) delete target[name]
  }
  delete target[INSTALLED]
}
