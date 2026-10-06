/**
 * Resolution of the DSH peer packages this plugin builds on.
 *
 * The plugin is a Cordis plugin loaded by the DSH host, so `@deepseek-ai/dsh-fs`
 * and `@deepseek-ai/dsh-tools` are supplied by the running host rather than by
 * this package.
 *
 * Under CommonJS that just works: `require` walks up from this file into the
 * profile's `node_modules`. ESM does not consult `NODE_PATH` and will not walk
 * into a sibling package tree, so this module additionally retries through a
 * require rooted at each candidate root. That keeps the plugin loadable both
 * from a profile-installed copy and from a source checkout that only has the
 * DSH installation to borrow from.
 *
 * @module @shiqyka/dsh-ssh-workspace/peers
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localRequire = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

/**
 * Candidate `node_modules` roots to search, most specific first.
 *
 * @returns {string[]} existing directories only.
 */
function profileRoots () {
  const roots = []
  // This package's own ancestor tree first. In production the plugin lives
  // inside the profile, so this IS the profile's node_modules; in a source
  // checkout it lets a one-time dependency install satisfy the peers.
  roots.push(join(here, '..', 'node_modules'))
  // Then an explicit test/scratch tree: a path-delimiter-separated list is
  // accepted so a harness can point at several roots.
  const explicit = process.env.DSH_PEER_ROOT
  if (typeof explicit === 'string' && explicit !== '') {
    for (const root of explicit.split(delimiter)) {
      if (root !== '') roots.push(root)
    }
  }
  // Then the installed DSH profiles.
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') roots.push(join(profileDir, 'node_modules'))
  const profile = process.env.DSH_PROFILE
  if (typeof profile === 'string' && profile !== '') roots.push(join(dshHome, 'profiles', profile, 'node_modules'))
  // A few conventional profile names, so an unset environment still resolves.
  for (const name of ['desktop', 'default', 'web']) {
    roots.push(join(dshHome, 'profiles', name, 'node_modules'))
  }
  // Finally the deployment's own bundled tree. DSH ships its core packages
  // inside `app.asar`; under Electron that root resolves transparently, and
  // under plain Node these candidates simply do not exist.
  for (const resources of resourcesRoots()) {
    roots.push(join(resources, 'app.asar', 'dsh', 'node_modules'))
    roots.push(join(resources, 'app.asar', 'node_modules'))
    roots.push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules'))
  }
  return roots.filter(root => existsSync(root))
}

/**
 * Candidate Electron `resources` directories of the running deployment.
 *
 * @returns {string[]} existing directories only.
 */
function resourcesRoots () {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(process.resourcesPath)
  }
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    candidates.push(join(dirname(process.execPath), 'resources'))
  }
  return candidates.filter(root => existsSync(root))
}

/** Memoized per-specifier resolution, so a hot path pays the search once. */
const cache = new Map()

/**
 * Require a DSH peer package.
 *
 * @param {string} specifier - package specifier to load.
 * @returns {any} the loaded module.
 * @throws {Error} when neither this package nor any DSH profile supplies it.
 */
export function requirePeer (specifier) {
  if (cache.has(specifier)) return cache.get(specifier)
  try {
    const direct = localRequire(specifier)
    cache.set(specifier, direct)
    return direct
  } catch (directError) {
    const attempts = []
    for (const root of profileRoots()) {
      try {
        const requireFromRoot = createRequire(join(root, 'noop.cjs'))
        const loaded = requireFromRoot(specifier)
        cache.set(specifier, loaded)
        return loaded
      } catch (error) {
        attempts.push(`${root}: ${error.code ?? error.message}`)
      }
    }
    const detail = attempts.length === 0 ? 'no candidate node_modules root exists' : attempts.join('; ')
    throw new Error(`ssh-workspace: cannot resolve the DSH peer package ${JSON.stringify(specifier)} (${detail})`, { cause: directError })
  }
}
