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
  // Then `DSH_CORE_ROOT`, the name every suite and `tests/run.mjs` already
  // speak: it is the node_modules directory a test harness assembles, and a
  // suite that publishes it must have it honoured here too. Without this a
  // suite would build a stub root, set the variable, and still be told the peer
  // is missing — which is how a stub tree can look like a broken checkout.
  const coreRoot = process.env.DSH_CORE_ROOT
  if (typeof coreRoot === 'string' && coreRoot !== '') roots.push(coreRoot)
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
 * How a missing package is described, and what the user can do about it.
 *
 * The wording is not cosmetic: a peer is supplied by the running DSH host and a
 * dependency by whichever package manager installed this one, so the two
 * failures have different fixes. Reporting a missing `ssh2` as a "peer" sends
 * the reader to the manifest's `peerDependencies`, where nothing is wrong and
 * nothing can be fixed.
 *
 * @type {Record<string, {subject: string, advice: string}>}
 */
const ROLES = {
  peer: {
    subject: 'the DSH peer package',
    advice: 'The running DSH host supplies this package; check that this plugin is installed into a DSH profile whose Host ships it.',
  },
  dependency: {
    subject: "this plugin's own dependency",
    advice: 'This plugin\'s package manager installs this package; run "npm ci" (or "npm install") in the directory holding this plugin, or reinstall the plugin.',
  },
}

/**
 * Require a DSH peer package or one of this plugin's own dependencies.
 *
 * @param {'peer' | 'dependency'} [options.kind] - who is responsible for the
 *   package: the Host (`'peer'`, the default) or this plugin's install
 *   (`'dependency'`). Only the failure message differs.
 * @throws {Error} when neither this package nor any DSH profile supplies it.
 */
export function requirePeer (specifier, { kind = 'peer' } = {}) {
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
    const role = ROLES[kind] ?? ROLES.peer
    const detail = attempts.length === 0 ? 'no candidate node_modules root exists' : attempts.join('; ')
    throw new Error(`ssh-workspace: cannot resolve ${role.subject} ${JSON.stringify(specifier)} (${detail}). ${role.advice}`, { cause: directError })
  }
}
