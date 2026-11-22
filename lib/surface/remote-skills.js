/**
 * Remote skill discovery, exposed through the Host's `ctx.skills` provider registry.
 *
 * ## Why this is not `dsh-skill-filesystem` pointed at an `ssh://` root
 *
 * The obvious shortcut — hand `ssh://alias/path/.agents/skills` to the Host's own
 * filesystem provider — does not survive contact with Windows. That provider
 * builds child paths with `node:path.join` (`discoverRoot`), and on a Windows
 * host `join('ssh://box/data/proj/.agents/skills/x', 'SKILL.md')` returns
 * `.\\ssh:\\box\\data\\proj\\.agents\\skills\\x\\SKILL.md`. That string fails
 * `isRemotePath()`, so the read falls through to the local backend, misses, and
 * the candidate is dropped with no message at all. Directory bundles would vanish
 * silently while flat `.md` files (whose locator is the entry path, unjoined)
 * survived — a bug that looks like "the remote host has almost no skills".
 *
 * So discovery is done here, over SFTP, with `normalizeRemotePath` and
 * `formatRemotePath` only. Nothing in this module touches `node:path`.
 *
 * ## What it is not
 *
 * - Not a write path: discovery only reads, and `get()` re-verifies the fence.
 * - Not a parser of arbitrary YAML: the frontmatter subset is documented on
 *   {@link parseMapping}, and anything outside it is skipped rather than guessed.
 * - Not enabled by default. A remote skill's DESCRIPTION is prompt-visible the
 *   moment the catalog is read, which is a different risk class from a file the
 *   model has to choose to open. Hence the allowlist below.
 *
 * @module @shiqyka/dsh-ssh-workspace/remote-skills
 */

import { KINDS } from '../core/diagnostics.js'
import { formatRemotePath, normalizeRemotePath, parseRemotePath } from '../core/protocol.js'
import { assertFencedRealpath, isWithinRemoteRoots } from '../fs/remote-fs.js'
import { sftpCloseHandle, sftpOpenHandle, sftpReaddir, sftpReadHandle, sftpStatOrNull } from '../fs/remote-fs.js'

/** Provider name registered on `ctx.skills`; also the `provider` field of every candidate. */
export const PROVIDER_NAME = 'ssh-workspace-remote-skills'

/**
 * Precedence rank for remote skills.
 *
 * Lower wins a same-name collision inside one layer. The Host's own roots are
 * project-dsh 100, project-agents 200, custom 300, user-dsh 400, user-agents 500,
 * bundled 600 — so 250 sits between project and user: a local project skill beats
 * a remote one, and a remote one beats a globally installed user skill. 250 is
 * also `RUNTIME_RANK`; runtime registrations are ordered ahead of providers at
 * equal rank, which is the behaviour we want (an in-process registration is more
 * deliberate than a file on another machine).
 */
export const REMOTE_SKILL_RANK = 250

/** Skill-name grammar, copied from the Host so a candidate cannot be rejected there. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Defaults for one allowlisted host. */
export const REMOTE_SKILL_LIMITS = Object.freeze({
  roots: Object.freeze(['.dsh/skills', '.agents/skills']),
  /** Entries listed per root. Far below `LS_MAX_LIMIT` (2000): a skill root is small. */
  maxEntries: 200,
  /** Candidates kept across every root of one host. */
  maxSkills: 32,
  /** Bytes of one SKILL.md; larger files are skipped, never truncated. */
  maxBytes: 64 * 1024,
  /** Wall clock for one discovery pass. */
  timeoutMs: 5000,
  /** How long a completed discovery is reused. Expiry only; nothing polls. */
  ttlMs: 5 * 60 * 1000,
})

/**
 * Normalize the `remoteSkills` plugin config.
 *
 * Wildcards are refused rather than expanded: "connect to a new host" must not
 * mean "trust its prompt text". An entry that is not a plain alias is dropped
 * with a warning, because silently keeping it would be the same trust expansion
 * with no trace.
 *
 * @param {object} [options.logger] - Cordis logger for refusals.
 */
export function normalizeRemoteSkillsConfig (raw, options = {}) {
  const hosts = new Map()
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const configured = source.hosts !== null && typeof source.hosts === 'object' ? source.hosts : {}
  for (const [alias, value] of Object.entries(configured)) {
    if (alias === '' || alias === '*' || /[*?]/u.test(alias)) {
      options.logger?.warn?.(`ssh-workspace: remoteSkills host ${JSON.stringify(alias)} ignored — wildcards would auto-trust every host`)
      continue
    }
    const entry = value !== null && typeof value === 'object' ? value : {}
    const roots = Array.isArray(entry.roots) && entry.roots.length > 0
      ? entry.roots.filter(root => typeof root === 'string' && root.trim() !== '').map(root => root.trim())
      : [...REMOTE_SKILL_LIMITS.roots]
    hosts.set(alias, {
      alias,
      roots,
      maxEntries: positiveInteger(entry.maxEntries, REMOTE_SKILL_LIMITS.maxEntries),
      maxSkills: positiveInteger(entry.maxSkills, REMOTE_SKILL_LIMITS.maxSkills),
      maxBytes: positiveInteger(entry.maxBytes, REMOTE_SKILL_LIMITS.maxBytes),
      timeoutMs: positiveInteger(entry.timeoutMs, REMOTE_SKILL_LIMITS.timeoutMs),
    })
  }
  return { enabled: source.enabled === true, hosts }
}

/**
 * A positive integer, or the default.
 *
 * A limit is a bound, so a nonsense value must not widen it: `0`, `-1` and
 * `'many'` all fall back instead of becoming "no limit".
 *
 * @param {number} fallback - value to use when the input is not usable.
 */
function positiveInteger (value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Parse the YAML subset a SKILL.md frontmatter block is allowed to use.
 *
 * Supported, and nothing else: `key: scalar` (optionally quoted), booleans
 * (`true/false/yes/no/on/off`), one level of nested mapping, and the block
 * scalars `|` / `>`. That is exactly the shape the Host documents for skill
 * metadata; anything more would mean shipping a YAML parser, and a hand-rolled
 * one that silently mis-reads a nested list is worse than not supporting it.
 *
 * Unrecognized lines are skipped rather than fatal, because a single odd key in
 * a third-party SKILL.md must not hide the skill's name and description.
 *
 */
export function parseMapping (text) {
  const lines = text.split('\n').map(line => line.replace(/\r$/u, ''))
  const result = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1
      continue
    }
    const entry = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/u.exec(line)
    if (entry === null) {
      index += 1
      continue
    }
    const key = entry[1]
    const inline = entry[2] === undefined ? '' : entry[2].trim()
    index += 1
    const indented = []
    while (index < lines.length && (lines[index].trim() === '' || /^[ \t]/u.test(lines[index]))) {
      indented.push(lines[index])
      index += 1
    }
    if (/^[|>][-+]?$/u.test(inline)) {
      const folded = inline.startsWith('>')
      const kept = indented.map(item => item.replace(/^[ \t]+/u, ''))
      while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
      result[key] = folded ? kept.join(' ').replace(/[ \t]+/gu, ' ').trim() : kept.join('\n')
      continue
    }
    if (inline === '' && indented.length > 0) {
      result[key] = parseMapping(indented.join('\n'))
      continue
    }
    result[key] = scalarOf(inline)
  }
  return result
}

/**
 * One scalar from a frontmatter value.
 *
 */
function scalarOf (raw) {
  if (raw === '') return ''
  const quoted = /^(['"])(.*)\1$/u.exec(raw)
  if (quoted !== null) return quoted[2]
  const lowered = raw.toLowerCase()
  if (lowered === 'true' || lowered === 'yes' || lowered === 'on') return true
  if (lowered === 'false' || lowered === 'no' || lowered === 'off') return false
  return raw
}

/**
 * Split a SKILL.md into frontmatter data and body.
 *
 * @returns {{data: Record<string, unknown>, body: string} | undefined} undefined when
 *   the file has no frontmatter block.
 */
export function parseFrontmatter (raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  let closing
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      closing = { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
      break
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  if (closing === undefined) return undefined
  return { data: parseMapping(raw.slice(firstLineEnd + 1, closing.start)), body: raw.slice(closing.bodyStart) }
}

/**
 * The invocation policy a frontmatter block declares.
 *
 * Mirrors the Host: `disable-model-invocation` and `user-invocable`, with the
 * legacy spellings REJECTED rather than interpreted — a skill written against
 * the old keys would otherwise silently invert its own visibility.
 *
 * @throws {Error} when a legacy key or a non-boolean value is present.
 */
function invocationOf (data) {
  for (const [legacy, canonical] of [['disableModelInvocation', 'disable-model-invocation'], ['modelInvocable', 'disable-model-invocation'], ['userInvocable', 'user-invocable']]) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
  const disableModel = booleanField(data, 'disable-model-invocation')
  const userInvocable = booleanField(data, 'user-invocable')
  return { modelInvocable: disableModel !== true, userInvocable: userInvocable !== false }
}

/**
 * A frontmatter boolean, accepting the YAML spellings the Host accepts.
 *
 * @returns {boolean | undefined} undefined when the key is absent.
 * @throws {TypeError} when the key is present but not a boolean.
 */
function booleanField (data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/**
 * One parsed skill file.
 *
 * @typedef {object} ParsedSkill
 * @property {string} name - validated kebab-case name.
 * @property {string} description - non-empty description.
 * @property {string} [whenToUse] - optional routing hint.
 * @property {{modelInvocable: boolean, userInvocable: boolean}} invocation - policy.
 * @property {string} content - body with the frontmatter removed.
 */

/**
 * Parse one SKILL.md body into a skill, or explain why it cannot be one.
 *
 * @returns {ParsedSkill | undefined} undefined when the file is not a usable skill.
 */
export function parseSkillText (raw, displayPath, logger) {
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) {
    logger?.warn?.(`ssh-workspace: remote skill ${displayPath} ignored: missing YAML frontmatter`)
    return undefined
  }
  const name = parsed.data.name
  const description = parsed.data.description
  if (typeof name !== 'string' || typeof description !== 'string' || description === '') {
    logger?.warn?.(`ssh-workspace: remote skill ${displayPath} ignored: frontmatter requires name and description`)
    return undefined
  }
  if (!SKILL_NAME.test(name)) {
    logger?.warn?.(`ssh-workspace: remote skill ${displayPath} ignored: invalid skill name ${JSON.stringify(name)}`)
    return undefined
  }
  let invocation
  try {
    invocation = invocationOf(parsed.data)
  } catch (error) {
    logger?.warn?.(`ssh-workspace: remote skill ${displayPath} ignored: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const whenToUse = typeof parsed.data.whenToUse === 'string' && parsed.data.whenToUse !== '' ? parsed.data.whenToUse : undefined
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation,
    content: parsed.body.trim(),
  }
}

/**
 * Read one remote text file, refusing anything above the byte cap.
 *
 * The size check happens on the STAT, before a single byte is transferred, and
 * the read itself is capped at `maxBytes + 1` so a file that grew between the
 * two calls is still refused instead of silently truncated (a truncated
 * frontmatter block parses as garbage).
 *
 * @param {number} maxBytes - inclusive cap.
 * @returns {Promise<string | undefined>} text, or undefined when it is too large or not text.
 */
async function readTextCapped (sftp, remotePath, displayPath, maxBytes) {
  const stats = await sftpStatOrNull(sftp, remotePath)
  if (stats === null) return undefined
  if (typeof stats.size === 'number' && stats.size > maxBytes) return undefined
  const handle = await sftpOpenHandle(sftp, remotePath, 'r', displayPath)
  try {
    const buffer = await sftpReadHandle(sftp, handle, 0, maxBytes + 1, displayPath)
    if (buffer.length > maxBytes) return undefined
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return undefined
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      return undefined
    }
  } finally {
    await sftpCloseHandle(sftp, handle)
  }
}

/**
 * Join one path segment onto an absolute remote path.
 *
 * `node:path` is deliberately not used — see the module header.
 *
 */
function joinRemotePath (base, name) {
  if (name.startsWith('/')) return normalizeRemotePath(name)
  return normalizeRemotePath(`${base}/${name}`)
}

/**
 * The remote-skills provider.
 *
 * One instance per plugin activation. `list()` is called on the Host's request
 * boundary, so it must be cheap when nothing changed (TTL cache) and honest when
 * something failed (`complete: false`, never an empty array that reads as
 * "these skills were deleted").
 */
export class RemoteSkillsProvider {
  constructor (options) {
    const normalized = normalizeRemoteSkillsConfig(options.config, { logger: options.logger })
    /** @type {string} */
    this.name = PROVIDER_NAME
    /** @type {boolean} */
    this.enabled = normalized.enabled
    /** @type {Map<string, object>} */
    this.hosts = normalized.hosts
    this.engineOf = options.engine
    this.rootsOf = options.roots
    this.logger = options.logger
    this.diagnostics = options.diagnostics
    /** @type {Map<string, {at: number, candidates: object[], complete: boolean}>} */
    this.cache = new Map()
    /** @type {{alias: string, at: number, skills: number, skipped: number, complete: boolean} | undefined} */
    this.lastDiscovery = undefined
    /** @type {object | undefined} */
    this.control = undefined
  }

  /**
   * Take the registration's control handle, so `invalidate()` can be forwarded.
   *
   */
  attach (control) {
    this.control = control
    control?.signal?.addEventListener?.('abort', () => { this.cache.clear() }, { once: true })
  }

  /**
   * Drop every cached discovery and ask the Host to rebuild its catalog.
   *
   */
  invalidate () {
    this.cache.clear()
    try {
      this.control?.invalidate?.()
    } catch { /* a disposed registry has nothing to invalidate */ }
  }

  /**
   * Discover remote skill summaries for one lookup.
   *
   */
  async list (options = {}) {
    if (!this.enabled) return { candidates: [], complete: true }
    const cwd = typeof options.cwd === 'string' ? options.cwd : ''
    const parts = parseRemotePath(cwd)
    if (parts === undefined) return { candidates: [], complete: true }
    const host = this.hosts.get(parts.alias)
    if (host === undefined) return { candidates: [], complete: true }
    // The session's cwd must sit inside a mounted root. An unmounted path is not
    // a failure — the user may have opened a session without this plugin serving
    // the workspace — so it is an empty, complete answer.
    if (!isWithinRemoteRoots(new Set(this.rootsOf()), parts)) return { candidates: [], complete: true }
    const key = `${parts.alias} ${cwd}`
    const cached = this.cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < REMOTE_SKILL_LIMITS.ttlMs) {
      return { candidates: cached.candidates, complete: cached.complete }
    }
    try {
      const candidates = await this.#discover(host, parts, options.signal)
      const complete = candidates.complete
      this.cache.set(key, { at: Date.now(), candidates: candidates.list, complete })
      this.lastDiscovery = { alias: parts.alias, at: Date.now(), skills: candidates.list.length, skipped: candidates.skipped, complete }
      this.diagnostics?.record?.(KINDS.remoteSkills, `remote skills: ${candidates.list.length} from ${parts.alias}, ${candidates.skipped} skipped`, { alias: parts.alias })
      return { candidates: candidates.list, complete }
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      // Never cache a failed pass and never answer "zero": the Host keeps the
      // previous good catalog when the observation is incomplete, which is what
      // a dropped connection should look like.
      this.diagnostics?.record?.(KINDS.degraded, `remote skills unavailable: ${error instanceof Error ? error.message : String(error)}`, { alias: parts.alias })
      this.lastDiscovery = { alias: parts.alias, at: Date.now(), skills: 0, skipped: 0, complete: false }
      return { candidates: [], complete: false }
    }
  }

  /**
   * Load one candidate's body, re-verifying the fence first.
   *
   * The read path in `remote-fs.js` has NO write fence (`assertWithinRemoteRoots`
   * is consulted only by `#assertWritable`), so a symlink planted on the remote
   * host would otherwise be followed out of the workspace by a plain read. This
   * is where that is prevented, not in the discovery pass: discovery reads only
   * the candidate's own SKILL.md, and `get()` is what a model can trigger.
   *
   * @returns {Promise<object | undefined>} the full skill, or undefined.
   */
  async get (candidate, options = {}) {
    const locator = candidate?.locator
    if (locator === undefined || locator === null) return undefined
    const engine = this.engineOf()
    if (engine === undefined || typeof engine.withSftp !== 'function') return undefined
    const roots = new Set(this.rootsOf())
    try {
      return await engine.withSftp(locator.alias, async (sftp) => {
        await assertFencedRealpath(sftp, locator.alias, locator.remotePath, roots, { verb: 'read', includeLeaf: true })
        const raw = await readTextCapped(sftp, locator.remotePath, locator.displayPath, locator.maxBytes)
        if (raw === undefined) return undefined
        const parsed = parseSkillText(raw, locator.displayPath, this.logger)
        if (parsed === undefined) return undefined
        return {
          name: parsed.name,
          description: parsed.description,
          ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
          invocation: parsed.invocation,
          source: 'remote',
          provider: PROVIDER_NAME,
          resourceBase: { kind: 'directory', path: locator.directoryDisplay },
          path: locator.displayPath,
          content: parsed.content,
        }
      }, { kind: 'read' })
    } catch (error) {
      // A refusal here is the ordinary outcome for a locator that escaped, and
      // for a host that went away between discovery and load. The Host treats a
      // missing skill body as "this candidate is gone", which is right in both
      // cases; throwing would take down the whole catalog read instead.
      this.diagnostics?.record?.(KINDS.degraded, `remote skill ${locator.displayPath} unavailable: ${error instanceof Error ? error.message : String(error)}`, { alias: locator.alias })
      return undefined
    }
  }

  /**
   * One discovery pass over every configured root of one host.
   *
   */
  async #discover (host, parts, signal) {
    const engine = this.engineOf()
    if (engine === undefined || typeof engine.withSftp !== 'function') return { list: [], skipped: 0, complete: true }
    const deadline = Date.now() + host.timeoutMs
    const collected = []
    let skipped = 0
    let complete = true
    for (const root of host.roots) {
      if (signal?.aborted === true) throw signal.reason
      if (Date.now() > deadline) {
        complete = false
        break
      }
      if (collected.length >= host.maxSkills) break
      const rootDisplay = formatRemotePath(parts.alias, joinRemotePath(parts.remotePath, root))
      const rootParts = parseRemotePath(rootDisplay)
      if (rootParts === undefined) continue
      try {
        const found = await engine.withSftp(parts.alias, async (sftp) => {
          return await this.#scanRoot({ sftp, host, rootDisplay, rootParts, remaining: host.maxSkills - collected.length, signal, deadline })
        }, { kind: 'read' })
        collected.push(...found.list)
        skipped += found.skipped
        if (!found.complete) complete = false
      } catch (error) {
        if (signal?.aborted === true) throw error
        complete = false
        this.logger?.warn?.(`ssh-workspace: remote skill root ${rootDisplay} skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { list: collected.slice(0, host.maxSkills), skipped, complete }
  }

  /**
   * Scan one skill root for directory bundles and flat Markdown files.
   *
   */
  async #scanRoot (options) {
    const { sftp, host, rootDisplay, rootParts, remaining, signal, deadline } = options
    let entries
    try {
      entries = await sftpReaddir(sftp, rootParts.remotePath, rootDisplay)
    } catch (error) {
      // A root that does not exist is the ordinary case: a workspace that has
      // never had remote skills. Every other failure is real and surfaces.
      if (isAbsent(error)) return { list: [], skipped: 0, complete: true }
      throw error
    }
    const list = []
    let skipped = 0
    let complete = true
    for (const entry of entries.slice(0, host.maxEntries).sort((left, right) => String(left.filename).localeCompare(String(right.filename)))) {
      if (signal?.aborted === true) throw signal.reason
      if (list.length >= remaining) break
      if (Date.now() > deadline) {
        complete = false
        break
      }
      const name = String(entry.filename ?? '')
      if (name === '' || name.startsWith('.')) continue
      const isDirectory = entry.attrs?.isDirectory?.() === true
      const isFile = entry.attrs?.isFile?.() === true
      if (!isDirectory && !isFile) continue
      if (!isDirectory && !name.endsWith('.md')) continue
      const entryRemote = joinRemotePath(rootParts.remotePath, name)
      const fileRemote = isDirectory ? joinRemotePath(entryRemote, 'SKILL.md') : entryRemote
      const directoryRemote = isDirectory ? entryRemote : rootParts.remotePath
      const displayPath = formatRemotePath(rootParts.alias, fileRemote)
      const directoryDisplay = formatRemotePath(rootParts.alias, directoryRemote)
      let raw
      try {
        raw = await readTextCapped(sftp, fileRemote, displayPath, host.maxBytes)
      } catch (error) {
        if (isAbsent(error)) {
          // A directory without a SKILL.md is not a skill; a flat file that
          // vanished between readdir and read is a race, not a failure.
          skipped += 1
          continue
        }
        throw error
      }
      if (raw === undefined) {
        skipped += 1
        continue
      }
      const parsed = parseSkillText(raw, displayPath, this.logger)
      if (parsed === undefined) {
        skipped += 1
        continue
      }
      list.push({
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: parsed.invocation,
        provider: PROVIDER_NAME,
        source: 'remote',
        rank: REMOTE_SKILL_RANK,
        locator: {
          alias: rootParts.alias,
          remotePath: fileRemote,
          displayPath,
          directoryDisplay,
          maxBytes: host.maxBytes,
        },
        resourceBase: { kind: 'directory', path: directoryDisplay },
        path: displayPath,
      })
    }
    if (entries.length > host.maxEntries) complete = false
    return { list, skipped, complete }
  }

  /**
   * A snapshot for the status surfaces.
   *
   */
  describe () {
    return {
      enabled: this.enabled,
      hosts: [...this.hosts.keys()].sort(),
      ...(this.lastDiscovery === undefined ? {} : { last: { ...this.lastDiscovery } }),
    }
  }
}

/**
 * Whether an SFTP error means "this path is not there".
 *
 * Mirrors the codes `remote-fs.js` maps to `FS_NOT_FOUND`, plus the raw
 * `ssh2` code for a channel that has not been through that mapping.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true when the path is simply absent.
 */
function isAbsent (error) {
  const code = error?.code
  return code === 'FS_NOT_FOUND' || code === 'FS_NOT_DIRECTORY' || code === 2
}
