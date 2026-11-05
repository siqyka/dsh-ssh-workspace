/**
 * Jump-chain parsing: textual, security-relevant, no network needed.
 *
 * The failure modes here are the O-17 class — a chain that silently collapses
 * into a direct connection bypasses the bastion the user's config requires.
 * Every case below is decided by a pure function and executed directly.
 *
 * Run: node tests/jump-chain-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { parseHop, parseJumpChain, checkJumpChain, describeChain, MAX_JUMPS } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib/jump-chain.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Run a function and report whether it threw, plus the message. */
function attempt (fn) {
  try {
    return { value: fn(), threw: false }
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) }
  }
}

console.log('\n=== jump chain smoke ===\n')

// ---------------------------------------------------------------------------
// 1. One hop
// ---------------------------------------------------------------------------
console.log('[1] a single hop')
{
  const bare = parseHop('bastion')
  check('a bare name carries no port', bare.host === 'bastion' && bare.port === undefined, JSON.stringify(bare))
  check('and carries no user', bare.user === undefined, JSON.stringify(bare))
  // The absence is load-bearing: the port belongs to the host entry. Defaulting
  // it to 22 dialed a port the user never mentioned on any bastion that runs
  // elsewhere, and the resulting ECONNREFUSED named no hop at all.
  check('so the entry\'s own port is inherited rather than assumed', !('port' in bare), JSON.stringify(bare))

  const withUser = parseHop('deploy@bastion')
  check('user@ is split off', withUser.user === 'deploy' && withUser.host === 'bastion', JSON.stringify(withUser))

  const withPort = parseHop('bastion:2222')
  check('the port is read', withPort.port === 2222 && withPort.host === 'bastion', JSON.stringify(withPort))

  const both = parseHop('deploy@bastion:2222')
  check('user and port together', both.user === 'deploy' && both.host === 'bastion' && both.port === 2222, JSON.stringify(both))

  // A user name containing '@' is not valid, but the LAST '@' is the separator,
  // so the parse stays deterministic instead of producing a nonsense host.
  const odd = parseHop('a@b@bastion')
  check('the last @ is the separator', odd.user === 'a@b' && odd.host === 'bastion', JSON.stringify(odd))
}

// ---------------------------------------------------------------------------
// 2. IPv6 literals keep their colons
// ---------------------------------------------------------------------------
console.log('\n[2] IPv6 literals')
{
  const bare = parseHop('[::1]')
  check('a bracketed literal keeps its address', bare.host === '::1', JSON.stringify(bare))
  check('and inherits the port too', bare.port === undefined, JSON.stringify(bare))
  const port = parseHop('[2001:db8::1]:2200')
  check('and its port', port.host === '2001:db8::1' && port.port === 2200, JSON.stringify(port))
  const user = parseHop('root@[::1]:22')
  check('with a user too', user.user === 'root' && user.host === '::1' && user.port === 22, JSON.stringify(user))
  check('brackets are not part of the address', !bare.host.includes('['), bare.host)
}

// ---------------------------------------------------------------------------
// 3. Malformed values are errors, never silent "direct"
// ---------------------------------------------------------------------------
console.log('\n[3] a malformed hop is an error, not a silent direct connection')
{
  const badPort = attempt(() => parseHop('bastion:ssh'))
  check('a non-numeric port throws', badPort.threw === true, JSON.stringify(badPort))
  check('and the message names the offending text',
    /not a port number/u.test(badPort.message ?? ''), badPort.message)

  const emptyHost = attempt(() => parseHop('user@'))
  check('an empty host throws', emptyHost.threw === true, JSON.stringify(emptyHost))

  const emptyUser = attempt(() => parseHop('@bastion'))
  check('an empty user throws', emptyUser.threw === true, JSON.stringify(emptyUser))

  const outOfRange = attempt(() => parseHop('bastion:70000'))
  check('an out-of-range port throws', outOfRange.threw === true, JSON.stringify(outOfRange))

  const zero = attempt(() => parseHop('bastion:0'))
  check('port 0 throws', zero.threw === true, JSON.stringify(zero))
}

// ---------------------------------------------------------------------------
// 4. `none` means "connect directly" and must not become a hop
// ---------------------------------------------------------------------------
console.log('\n[4] `none` turns the proxy off')
{
  for (const spelling of ['none', 'NONE', 'None', '  none  ']) {
    const chain = parseJumpChain(spelling)
    check(`${JSON.stringify(spelling)} is a direct connection`, chain.kind === 'direct', JSON.stringify(chain))
  }
  const mixed = attempt(() => parseJumpChain('bastion,none'))
  check('`none` inside a list throws instead of being skipped', mixed.threw === true, JSON.stringify(mixed))
  check('and says so', /none/u.test(mixed.message ?? ''), mixed.message)
}

// ---------------------------------------------------------------------------
// 5. Chains
// ---------------------------------------------------------------------------
console.log('\n[5] multi-hop chains')
{
  const chain = parseJumpChain('a,b:2222,c')
  check('three hops are parsed in order',
    chain.kind === 'chain' && chain.hops.length === 3, JSON.stringify(chain))
  check('order is preserved', chain.hops.map(h => h.host).join(',') === 'a,b,c',
    JSON.stringify(chain.hops.map(h => h.host)))
  check('the middle hop keeps its port', chain.hops[1].port === 2222, JSON.stringify(chain.hops[1]))

  const arrayValue = parseJumpChain(['a,b', 'c'])
  check('an array value (store shape) is flattened', arrayValue.hops?.length === 3, JSON.stringify(arrayValue))

  const spaces = parseJumpChain(' a , b ')
  check('whitespace around hops is trimmed', spaces.hops?.length === 2, JSON.stringify(spaces))

  const trailing = parseJumpChain('a,')
  check('a trailing comma does not create an empty hop', trailing.hops?.length === 1, JSON.stringify(trailing))

  const empty = parseJumpChain('')
  check('an empty value is direct', empty.kind === 'direct', JSON.stringify(empty))

  const undef = parseJumpChain(undefined)
  check('undefined is direct', undef.kind === 'direct', JSON.stringify(undef))

  const tooMany = attempt(() => parseJumpChain(Array.from({ length: MAX_JUMPS + 1 }, (_, i) => `h${i}`).join(',')))
  check(`more than ${MAX_JUMPS} hops throws`, tooMany.threw === true, JSON.stringify(tooMany))
}

// ---------------------------------------------------------------------------
// 6. Self-reference and duplicates are refused
// ---------------------------------------------------------------------------
console.log('\n[6] chains that cannot be or should not be built')
{
  const self = checkJumpChain(parseJumpChain('web,bastion'), 'web')
  check('a self-reference is refused', self.ok === false, JSON.stringify(self))
  check('and named', /itself/u.test(self.error ?? ''), self.error)

  const dup = checkJumpChain(parseJumpChain('a,a'), 'target')
  check('a duplicate hop is refused', dup.ok === false, JSON.stringify(dup))

  // `a` and `a:22` are the same machine; letting both through would
  // authenticate twice for one link while looking like two hops.
  const sameHost = checkJumpChain(parseJumpChain('a,a:2222'), 'target')
  check('the same host at two ports is still one host', sameHost.ok === false, JSON.stringify(sameHost))

  const ok = checkJumpChain(parseJumpChain('a,b'), 'target')
  check('a well-formed chain is accepted', ok.ok === true, JSON.stringify(ok))

  const direct = checkJumpChain(parseJumpChain('none'), 'target')
  check('a direct connection is accepted', direct.ok === true, JSON.stringify(direct))

  // Case-insensitive, because hostnames are.
  const mixedCase = checkJumpChain(parseJumpChain('WEB'), 'web')
  check('the self-reference check ignores case', mixedCase.ok === false, JSON.stringify(mixedCase))
}

// ---------------------------------------------------------------------------
// 7. The description says which route is used
// ---------------------------------------------------------------------------
console.log('\n[7] the description')
{
  check('direct', describeChain(parseJumpChain('none')) === 'direct connection',
    describeChain(parseJumpChain('none')))
  check('one hop', describeChain(parseJumpChain('bastion')) === 'via bastion',
    describeChain(parseJumpChain('bastion')))
  check('a user is shown', describeChain(parseJumpChain('deploy@bastion')) === 'via deploy@bastion',
    describeChain(parseJumpChain('deploy@bastion')))
  check('an explicit port is shown',
    describeChain(parseJumpChain('bastion:2200')) === 'via bastion:2200',
    describeChain(parseJumpChain('bastion:2200')))
  check('a chain is joined with arrows',
    describeChain(parseJumpChain('a,b')) === 'via a → b',
    describeChain(parseJumpChain('a,b')))
  check('a mixed chain shows only the ports that were written',
    describeChain(parseJumpChain('a,b:2222')) === 'via a → b:2222',
    describeChain(parseJumpChain('a,b:2222')))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
