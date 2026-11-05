/**
 * Following `Include` directives in an OpenSSH config file.
 *
 * ## Why this is a module of its own
 *
 * `Include` is the one config keyword whose implementation is a FILE SYSTEM
 * operation, and every hazard in it is a hazard of reading files: a glob that
 * matches nothing, a pattern that expands to a directory, a symlink that points
 * back at the including file, two files that include each other. Getting any of
 * them wrong turns "read my SSH config" into an infinite loop or into silently
 * reading the wrong half of a configuration.
 *
 * It is therefore a pure function of a path and a file system interface: no
 * `HostStore`, no SSH, and every hazard can be executed in a test without
 * creating a real home directory.
 *
 * ## What OpenSSH actually does (and this reproduces)
 *
 *  - `Include` takes one or more arguments, split on whitespace. Each is a
 *    glob; `~` expands to the home directory, and a relative path is resolved
 *    against `$HOME/.ssh`, NOT against the including file's directory.
 *  - Included files are inserted AT THE POINT OF THE DIRECTIVE, which is why a
 *    `Host *` in an included file can be overridden by a `Host x` written after
 *    the `Include` line. This is the fact most implementations get wrong, and
 *    it changes which block wins.
 *  - A glob matching nothing is not an error: OpenSSH ignores it silently.
 *  - `Include` inside a `Match` block still applies (the whole file is read);
 *    this module follows that, because a conditional include that is not
 *    evaluated would otherwise silently drop hosts.
 *
 * ## Where it deliberately differs
 *
 * OpenSSH has no documented recursion limit and no cycle detection; a config
 * that includes itself loops until the stack runs out. Here the depth is capped
 * and a file already on the current include stack is skipped with a diagnostic,
 * because a plugin that hangs on a malformed config is worse than one that says
 * so.
 *
 * @module @shiqyka/dsh-ssh-workspace/include-chain
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** How deep `Include` nesting may go before it is treated as a mistake. */
export const MAX_INCLUDE_DEPTH = 8

/**
 * Expand a leading `~` and resolve a relative include against `~/.ssh`.
 *
 * @param {string} value - the path as written.
 * @param {string} sshDir - the directory relative paths are resolved against.
 * @returns {string} an absolute path.
 */
function resolveIncludePath (value, sshDir) {
  let text = String(value)
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2))
  return isAbsolute(text) ? text : resolve(sshDir, text)
}

/**
 * Expand one glob into the files it names, in a deterministic order.
 *
 * Deliberately a small, explicit implementation rather than `node:fs.glob`
 * (which is still experimental) and rather than a dependency: the supported
 * subset is `*`, `?` and `[...]` inside ONE path segment, which is what ssh
 * configurations actually use. `**` is NOT supported and is treated as a
 * literal, so a pattern relying on it matches nothing instead of silently
 * expanding to a depth the reader did not ask for.
 *
 * @param {string} pattern - an absolute path, possibly with glob segments.
 * @returns {string[]} matching regular files, sorted.
 */
export function expandGlob (pattern) {
  // Fast path: no glob characters at all.
  if (!/[*?[]/u.test(pattern)) return existsSync(pattern) ? [pattern] : []
  const segments = pattern.split(sep)
  // Walk from the root, expanding one segment at a time. Leading empty
  // segments come from an absolute path.
  let candidates = [segments[0] === '' ? sep : segments[0]]
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === '') continue
    if (!/[*?[]/u.test(segment)) {
      candidates = candidates.map(base => join(base, segment))
      continue
    }
    const regex = globSegmentToRegExp(segment)
    const next = []
    for (const base of candidates) {
      let entries
      try {
        if (!statSync(base).isDirectory()) continue
        entries = readdirSync(base)
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        if (regex.test(entry)) next.push(join(base, entry))
      }
    }
    candidates = next
  }
  // Only regular files: an Include that names a directory would otherwise be
  // read as if it were text, producing a parser error that points at the wrong
  // place.
  return candidates.filter((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

/**
 * Translate ONE glob segment (`*`, `?`, `[...]`) into a regular expression.
 *
 * @param {string} segment - the pattern.
 * @returns {RegExp} an anchored matcher.
 */
function globSegmentToRegExp (segment) {
  let source = ''
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (char === '*') { source += '.*'; continue }
    if (char === '?') { source += '.'; continue }
    if (char === '[') {
      const close = segment.indexOf(']', index + 1)
      if (close > index + 1) {
        const body = segment.slice(index + 1, close)
        // A leading `!` in a bracket expression negates, as in a shell.
        source += body.startsWith('!') ? `[^${escapeRegExp(body.slice(1))}]` : `[${body}]`
        index = close
        continue
      }
    }
    source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`, 'u')
}

/** Escape a literal for use inside a RegExp. */
function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Read a config file with every `Include` expanded in place.
 *
 * The return value is TEXT, not sections, on purpose: inserting the included
 * files' lines at the directive's position is what makes the resulting section
 * order — and therefore "which value wins" — identical to OpenSSH's. Returning
 * a list of files and letting the caller concatenate them would put every
 * included block AFTER the including file, which silently inverts precedence.
 *
 * @param {string} configPath - the file to read.
 * @param {object} [options] - overrides.
 * @param {number} [options.maxDepth] - nesting cap.
 * @param {string} [options.sshDir] - directory relative includes resolve against.
 * `problems` records four kinds: `missing` (an include naming a file that is
 * not there), `no-match` (a glob that expanded to nothing), `unreadable`, and
 * the two that a reader can act on — `cycle` (a file includes one of its own
 * ancestors) and `duplicate` (the same file reached twice, which would splice
 * its blocks in twice).
 *
 * @returns {{text: string, files: string[], problems: Array<{kind: string, detail: string}>}} the expanded text and what happened.
 * @throws {Error} when the CONFIG FILE ITSELF cannot be read (an included file
 *   that cannot be read is recorded in `problems` instead: one is the caller's
 *   subject, the other is a property of the configuration).
 */
export function readConfigWithIncludes (configPath, options = {}) {
  const maxDepth = typeof options.maxDepth === 'number' && options.maxDepth > 0 ? options.maxDepth : MAX_INCLUDE_DEPTH
  const sshDir = typeof options.sshDir === 'string' && options.sshDir !== '' ? options.sshDir : dirname(configPath)
  /** @type {string[]} */
  const files = []
  /** @type {Array<{kind: string, detail: string}>} */
  const problems = []
  /**
   * Real paths on the CURRENT include stack: an ancestor being re-entered.
   *
   * @type {Set<string>}
   */
  const onStack = new Set()
  /**
   * Real paths already expanded ANYWHERE.
   *
   * Separate from `onStack` because the two catch different mistakes. A file
   * that includes one of its own ancestors is an infinite walk, and stopping it
   * is about termination. A file included twice by SIBLINGS — `Include conf.d/*`
   * plus an explicit `Include conf.d/web.conf`, or the same file reached once
   * directly and once through a symlink — terminates on its own but produces two
   * copies of the same block. First-wins means the duplicate changes nothing,
   * so the only symptom is that the diagnosis is unavailable: the user sees a
   * host whose settings they cannot explain, and no message says why.
   *
   * @type {Set<string>}
   */
  const visited = new Set()

  /**
   * Read one file, expanding includes.
   *
   * @param {string} file - absolute path.
   * @param {number} depth - current nesting.
   * @returns {string} the expanded text.
   */
  function read (file, depth, topLevel = false) {
    let canonical
    try {
      // `realpathSync` is what makes cycle detection work through a symlink:
      // two different paths to the same file are the same file, and comparing
      // the written paths would miss exactly that case.
      canonical = realpathSync(file)
    } catch (error) {
      // The TOP-LEVEL file is the one the caller asked for. Failing to read it
      // is a real error and must reach them — degrading it to '' is precisely
      // how "your config is unreadable" became "you have no hosts". An INCLUDED
      // file is different: a stale `Include conf.d/*` naming a file that has
      // since been deleted is a fact about the config, not a failure of this
      // call, so it stays a recorded problem.
      if (topLevel) throw error
      problems.push({ kind: 'missing', detail: file })
      return ''
    }
    if (onStack.has(canonical)) {
      problems.push({ kind: 'cycle', detail: file })
      return ''
    }
    if (visited.has(canonical)) {
      // Not a loop, but still a mistake: the same block would appear twice.
      problems.push({ kind: 'duplicate', detail: file })
      return ''
    }
    if (depth > maxDepth) {
      problems.push({ kind: 'too-deep', detail: file })
      return ''
    }
    let text
    try {
      text = readFileSync(canonical, 'utf8')
    } catch (error) {
      if (topLevel) throw error
      problems.push({ kind: 'unreadable', detail: `${file}: ${error instanceof Error ? error.message : String(error)}` })
      return ''
    }
    files.push(file)
    onStack.add(canonical)
    visited.add(canonical)
    try {
      const lines = text.split(/\r?\n/u)
      const out = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!/^include\s/iu.test(trimmed)) {
          out.push(line)
          continue
        }
        const value = trimmed.replace(/^include\s+/iu, '').trim()
        if (value === '') continue
        // Quote-stripping: OpenSSH accepts `Include "~/.ssh/conf.d/*"`.
        const args = value.match(/"[^"]*"|\S+/gu) ?? []
        for (const rawArg of args) {
          const arg = rawArg.replace(/^"|"$/gu, '')
          const pattern = resolveIncludePath(arg, sshDir)
          const matched = expandGlob(pattern)
          if (matched.length === 0) {
            // Not an error, per OpenSSH: `Include conf.d/*` with an empty
            // directory is the normal state of a fresh machine.
            problems.push({ kind: 'no-match', detail: pattern })
            continue
          }
          for (const included of matched) out.push(read(included, depth + 1))
        }
      }
      return out.join('\n')
    } finally {
      onStack.delete(canonical)
    }
  }

  // A config that does not exist is the normal first-run state, not a failure.
  if (!existsSync(configPath)) return { text: '', files: [], problems }
  // `topLevel: true` propagates an unreadable file to the caller; everything
  // below it degrades to a recorded problem.
  return { text: read(configPath, 0, true), files, problems }
}
