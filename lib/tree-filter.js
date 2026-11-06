/**
 * Exclude / include rules for tree transfers.
 *
 * ## Why this is a module rather than a filter inside the walk
 *
 * `uploadTree` and `downloadTree` walk in two different directions (a local
 * `readdir` and an SFTP listing), and a rule set interpreted twice drifts: the
 * upload would skip `node_modules` while the download kept it, and the asymmetry
 * would be invisible until someone compared two trees. The matching therefore
 * lives here as a pure function over a relative path, and both walks call it.
 *
 * ## The rule language, and why it is small
 *
 * Deliberately NOT `.gitignore`: that format has ancestor rules, `**` anchoring
 * subtleties, negation ordering across files, and per-directory files — all of
 * which are a specification, not a treatment. What a transfer needs is:
 *
 *  - `node_modules`      — any path SEGMENT with that name (the common case: the
 *                          rule is written for a directory one level down);
 *  - `*.log`             — a segment matching a pattern with a wildcard;
 *  - `build/output`      — a pattern containing `/` matches from the tree root;
 *  - `tmp/`              — a trailing slash restricts the rule to directories;
 *  - `!keep.log`         — a leading `!` re-includes; the LAST matching rule
 *                          decides, so exceptions are written after the rule
 *                          they except, exactly as the reader expects.
 *
 * `*` matches within one segment, `**` crosses segments. Everything else is
 * literal, including `.` and `?` — a rule is not a regular expression, and
 * treating it as one is how `a.b` stops matching `a.b`.
 *
 * ## What it does not do
 *
 * It never expands a rule against the filesystem and never reads a rule from a
 * file: the caller supplies the list, so a transfer cannot start quietly
 * honouring something a previous project left in `.gitignore`.
 *
 * @module @shiqyka/dsh-ssh-workspace/tree-filter
 */

/**
 * Compile one rule into a predicate over a relative path.
 *
 * @param {string} rule - the rule text.
 * @returns {{test: (path: string, isDir: boolean) => boolean, include: boolean, source: string}} the matcher.
 */
function compileRule (rule) {
  const source = String(rule ?? '').trim()
  let body = source
  let include = false
  if (body.startsWith('!')) {
    include = true
    body = body.slice(1)
  }
  const dirOnly = body.endsWith('/')
  if (dirOnly) body = body.replace(/\/+$/u, '')
  // A leading `./` or `/` is how people spell "from the root"; both mean the
  // same thing here, and stripping them keeps `./build` and `build/` alike.
  body = body.replace(/^\.\//u, '').replace(/^\/+/u, '')
  const anchored = body.includes('/')
  const pattern = globToRegExp(body)
  return {
    include,
    source,
    test (path, isDir) {
      if (dirOnly && !isDir) return false
      const clean = String(path ?? '').replace(/^\/+/u, '').replace(/\/+$/u, '')
      if (anchored) {
        // Anchored rules match the path itself or any ancestor of it: excluding
        // `build/output` must also exclude the FILES under it, or the walk
        // would descend into an excluded directory and copy its contents.
        if (pattern.test(clean)) return true
        let cut = clean.lastIndexOf('/')
        while (cut > 0) {
          if (pattern.test(clean.slice(0, cut))) return true
          cut = clean.lastIndexOf('/', cut - 1)
        }
        return false
      }
      for (const segment of clean.split('/')) {
        if (pattern.test(segment)) return true
      }
      return false
    },
  }
}

/**
 * Translate a glob into an anchored regular expression.
 *
 * `**` crosses separators; a single `*` does not. Every other character is
 * escaped, so `.` is a dot and `?` is a question mark.
 *
 * @param {string} glob - the pattern body.
 * @returns {RegExp} the compiled pattern.
 */
export function globToRegExp (glob) {
  let out = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` also matches zero directories, which is what makes `**/dist`
        // match a top-level `dist`.
        if (glob[index + 2] === '/') {
          out += '(?:.*/)?'
          index += 2
        } else {
          out += '.*'
          index += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`^${out}$`, 'u')
}

/**
 * Build a matcher from a caller-supplied rule list.
 *
 * An empty or absent list yields a matcher that never excludes anything, so the
 * walk code can call it unconditionally instead of branching on "did the caller
 * pass rules" — a branch is one more thing each direction has to get right.
 *
 * @param {string[]|string|undefined} rules - the rules, or a single rule, or nothing.
 * @returns {{excluded: (path: string, isDir: boolean) => boolean, rules: string[]}} the matcher.
 */
export function treeFilter (rules) {
  const list = (Array.isArray(rules) ? rules : rules === undefined || rules === null ? [] : [rules])
    .map(rule => String(rule ?? '').trim())
    .filter(rule => rule !== '' && rule !== '!')
  const compiled = list.map(compileRule)
  return {
    rules: list,
    /**
     * Should this relative path be skipped?
     *
     * @param {string} path - path relative to the transfer root, `/`-separated.
     * @param {boolean} [isDir] - whether it is a directory.
     * @returns {boolean} true when the path is excluded.
     */
    excluded (path, isDir = false) {
      if (compiled.length === 0) return false
      // Last match wins, which is what makes `!keep.log` after `*.log` mean
      // "except this one" rather than "both, whichever ran first".
      let verdict
      for (const rule of compiled) {
        if (rule.test(path, isDir)) verdict = !rule.include
      }
      return verdict === true
    },
  }
}

/**
 * A path relative to the transfer root, with POSIX separators.
 *
 * `path.relative` on Windows returns backslashes, and a rule written with `/`
 * would then match nothing on exactly the platform where the transfer runs from
 * a drive letter. Converting here keeps that decision in one place.
 *
 * @param {string} root - the absolute root.
 * @param {string} absolute - the absolute path under it.
 * @returns {string} the relative path.
 */
export function relativeForRule (root, absolute) {
  const from = String(root).replace(/\\/gu, '/').replace(/\/+$/u, '')
  const to = String(absolute).replace(/\\/gu, '/')
  if (to === from) return ''
  if (!to.startsWith(`${from}/`)) return to.replace(/^\/+/u, '')
  return to.slice(from.length + 1)
}
