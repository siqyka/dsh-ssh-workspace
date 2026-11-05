/**
 * `Match` conditions: which ones this plugin can evaluate, and what it does
 * with the rest.
 *
 * ## Why this is not "support Match"
 *
 * OpenSSH's `Match` is a small expression language over connection facts. Three
 * of its criteria are decidable from data this plugin already has:
 *
 *  - `host` / `originalhost` — the alias being resolved, globbed like `Host`.
 *  - `all` — unconditionally true, used to end a Match block.
 *
 * One is decidable but NOT wanted:
 *
 *  - `exec` — runs an arbitrary local command and uses its exit status. A config
 *    file can arrive from a repository; making the resolver execute what it says
 *    would turn "read my SSH config" into "run this program". It is refused, and
 *    a `Match exec` body selects NOBODY — the safe direction, because the
 *    alternative is silently applying settings meant for a condition that was
 *    never checked.
 *
 * The rest depend on facts that do not exist until a connection does (`user`,
 * `localuser`, `address`, `localaddress`, `port`, `final`). They cannot be
 * decided while listing hosts, so a block whose condition mentions them selects
 * nobody, and the audit says which condition stopped it.
 *
 * ## Why the refusals matter more than the acceptances
 *
 * `Match` is the construct that made O-10 a security bug: a `Match` body used to
 * be absorbed into the preceding `Host` block, so `Match host db` handed `web`
 * the `User`, `Port` and `IdentityFile` written for `db`, and a `ProxyJump none`
 * in that body cancelled the `Host *` bastion that should have refused the host.
 * Every unknown criterion therefore has ONE safe answer — "selects nobody" — and
 * this module is written so that answer is the default rather than a branch
 * someone has to remember to add.
 *
 * @module @shiqyka/dsh-ssh-workspace/match-eval
 */

import { patternMatches as globMatches } from './ssh-config.js'

/** Criteria decided from the alias alone. */
export const EVALUABLE_CRITERIA = Object.freeze(new Set(['host', 'originalhost', 'all']))

/**
 * Criteria that are deliberately refused rather than evaluated.
 *
 * Kept separate from "not decidable yet" because the reason differs and so does
 * the message: `exec` could be evaluated and must not be, `address` cannot be
 * evaluated here at all.
 */
export const REFUSED_CRITERIA = Object.freeze(new Set(['exec']))

/** Criteria that need a live connection, so listing cannot decide them. */
export const DEFERRED_CRITERIA = Object.freeze(new Set([
  'user',
  'localuser',
  'address',
  'localaddress',
  'port',
  'final',
]))

/**
 * One parsed condition.
 *
 * @typedef {object} MatchCondition
 * @property {string} criterion - lowercase criterion name.
 * @property {string[]} [patterns] - for `host` / `originalhost`.
 * @property {string} [value] - for criteria that carry one value.
 * @property {boolean} [negated] - a leading `!`.
 */

/**
 * Parse the arguments of one `Match` line.
 *
 * The grammar is `criterion [negation] value...`, repeated; a value may be
 * quoted. `Match all` takes no value. OpenSSH also accepts the comma-separated
 * shorthand `Match host a,b`, which is split here.
 *
 * @param {string[]} tokens - the section's patterns, as `sectionsOf` produced them.
 * @returns {{conditions: MatchCondition[], problems: string[]}} parsed conditions and any complaints.
 */
export function parseMatchConditions (tokens) {
  /** @type {MatchCondition[]} */
  const conditions = []
  /** @type {string[]} */
  const problems = []
  let index = 0
  while (index < tokens.length) {
    const token = String(tokens[index])
    // A criterion name is a bare word; a value belonging to the previous
    // criterion is consumed inside its own branch, so anything reaching here
    // must be a criterion.
    const criterion = token.toLowerCase()
    index += 1
    if (criterion === 'all') {
      conditions.push({ criterion: 'all' })
      continue
    }
    if (!EVALUABLE_CRITERIA.has(criterion) && !REFUSED_CRITERIA.has(criterion) && !DEFERRED_CRITERIA.has(criterion)) {
      problems.push(`unknown Match criterion ${JSON.stringify(token)}`)
      // Skip to the next token that could be a criterion: an unknown criterion
      // makes the whole block undecidable anyway, so the parse only needs to
      // stay honest, not recover a usable condition list.
      continue
    }
    const values = []
    while (index < tokens.length) {
      const candidate = String(tokens[index])
      if (EVALUABLE_CRITERIA.has(candidate.toLowerCase())
        || REFUSED_CRITERIA.has(candidate.toLowerCase())
        || DEFERRED_CRITERIA.has(candidate.toLowerCase())) break
      values.push(candidate)
      index += 1
    }
    if (criterion === 'host' || criterion === 'originalhost') {
      const patterns = values.flatMap(value => value.split(',').map(part => part.trim()).filter(Boolean))
      if (patterns.length === 0) problems.push(`Match ${criterion} has no pattern`)
      conditions.push({ criterion, patterns })
      continue
    }
    conditions.push({ criterion, value: values.join(' ') })
  }
  return { conditions, problems }
}

/**
 * Decide whether a `Match` line's conditions hold for one alias.
 *
 * Returns a REASON as well as a verdict, because "this block does not apply" and
 * "I could not decide whether it applies" have to be distinguishable: the first
 * is normal, the second is what the audit reports to the user.
 *
 * @param {string[]} tokens - the section's patterns.
 * @param {string} alias - the alias being resolved.
 * @returns {{selects: boolean, undecidable?: string, refused?: string}} the verdict.
 */
export function matchSelects (tokens, alias) {
  const { conditions, problems } = parseMatchConditions(tokens)
  if (problems.length > 0) return { selects: false, undecidable: problems[0] }
  if (conditions.length === 0) return { selects: false, undecidable: 'the Match line has no condition' }
  for (const condition of conditions) {
    if (condition.criterion === 'all') continue
    if (REFUSED_CRITERIA.has(condition.criterion)) {
      return { selects: false, refused: `Match ${condition.criterion} would run a local command, which this plugin does not do` }
    }
    if (DEFERRED_CRITERIA.has(condition.criterion)) {
      return { selects: false, undecidable: `Match ${condition.criterion} needs a live connection` }
    }
    // `host` and `originalhost` are the same fact here: this plugin never
    // rewrites the alias, so the name the user typed IS the original host.
    const patterns = condition.patterns ?? []
    const negative = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
    const positive = patterns.filter(pattern => !pattern.startsWith('!'))
    const matched = positive.some(pattern => globMatches(pattern, alias))
    if (!matched || negative.some(pattern => globMatches(pattern, alias))) return { selects: false }
  }
  return { selects: true }
}


