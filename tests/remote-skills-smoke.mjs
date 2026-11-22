/**
 * Remote skill discovery: what it finds, what it refuses, and what it must never
 * do.
 *
 * ## Why this suite exists
 *
 * The feature reads text that the REMOTE host controls, and the Host puts a
 * skill's description into the model's catalog as soon as discovery runs. That
 * makes three properties load-bearing, and each one fails silently on its own:
 *
 *  - **off means off**: a disabled provider must not open a connection. The
 *    assertion counts SSH operations rather than reading the return value,
 *    because an empty array is also what a working-but-empty host returns.
 *  - **no fence, no read**: `remote-fs.js` fences WRITES only
 *    (`assertWithinRemoteRoots` is consulted by `#assertWritable` alone), so a
 *    symlink planted on the remote host would be followed by an ordinary read.
 *    `get()` re-verifies before every body load, and this suite drives that with
 *    a locator that escapes the mounted root.
 *  - **a broken pass is not an empty catalog**: `complete: false` is what stops
 *    the Host from caching "this host has no skills" over a dropped connection.
 *
 * The SFTP double below is a real tree, not a stub of the calls: discovery's
 * whole job is path arithmetic over `readdir` results, and a double that answers
 * per-path would hide exactly the joining bug this module exists to avoid
 * (Windows `node:path.join` turns an `ssh://` spelling into `.\\ssh:\\box\\...`).
 *
 * Run: node tests/remote-skills-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// remote-skills.js imports the fence helpers from remote-fs.js, which needs the
// Host peers at load time. A bare checkout has none, so build the same stub root
// tests/run.mjs builds and point the resolver at it BEFORE the import — otherwise
// this suite would skip in CI and prove nothing.
if (!process.env.DSH_CORE_ROOT && process.env.DSH_NO_PEER_STUBS !== '1') {
  const { installPeerStubs } = await import(pathToFileURL(path.join(pluginRoot, 'tests', 'peer-stubs.mjs')).href)
  process.env.DSH_CORE_ROOT = installPeerStubs(path.join(pluginRoot, 'tests', '.peer-stubs'))
}
// DSH_CORE_ROOT alone is not enough for this import chain: peers.js searches
// DSH_PEER_ROOT and the installed profiles, but never DSH_CORE_ROOT, so a stub
// tree would be built and then ignored. (tests/live-smoke.mjs and
// tests/commit-history-smoke.mjs wire the same bridge for the same reason.)
if (process.env.DSH_CORE_ROOT) {
  process.env.DSH_PEER_ROOT = [process.env.DSH_CORE_ROOT, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)
}

const skills = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'surface', 'remote-skills.js')).href)
const { RemoteSkillsProvider, normalizeRemoteSkillsConfig, parseFrontmatter, parseMapping, parseSkillText, REMOTE_SKILL_RANK, PROVIDER_NAME } = skills

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS  ' + label) } else {
    failures += 1
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

/**
 * A remote filesystem, in memory.
 *
 * Entries are `{type: 'file', text}`, `{type: 'dir'}` or `{type: 'link', to}`.
 * Every SFTP call the provider makes is implemented and COUNTED, so "no
 * connection" can be asserted as "zero operations" rather than inferred.
 */
function fakeSftp (tree) {
  const calls = []
  const lookup = (target) => {
    if (target === '/') return { type: 'dir' }
    const direct = tree[target]
    if (direct !== undefined) return direct
    const prefix = target + '/'
    return Object.keys(tree).some(key => key.startsWith(prefix)) ? { type: 'dir' } : null
  }
  const resolve = (target, seen) => {
    const node = lookup(target)
    if (node === null) return null
    if (node.type === 'link') {
      if ((seen ?? 0) > 8) return null
      return resolve(node.to, (seen ?? 0) + 1)
    }
    return target
  }
  const statOf = (target, seen) => {
    const node = lookup(target)
    if (node === null) return null
    if (node.type === 'link') {
      if ((seen ?? 0) > 8) return null
      return statOf(node.to, (seen ?? 0) + 1)
    }
    return {
      size: node.type === 'file' ? Buffer.byteLength(node.text, 'utf8') : 0,
      isFile: () => node.type === 'file',
      isDirectory: () => node.type === 'dir',
      isSymbolicLink: () => false,
    }
  }
  const handles = new Map()
  let nextHandle = 1
  const failNext = { code: undefined }
  const guard = () => {
    if (failNext.code === undefined) return
    const code = failNext.code
    failNext.code = undefined
    const error = new Error('injected failure ' + code)
    error.code = code
    throw error
  }
  const absent = () => Object.assign(new Error('no such file'), { code: 2 })
  const sftp = {
    stat (target, callback) {
      calls.push('stat ' + target)
      try { guard() } catch (error) { callback(error); return }
      const value = statOf(target)
      callback(value === null ? absent() : undefined, value)
    },
    lstat (target, callback) {
      calls.push('lstat ' + target)
      try { guard() } catch (error) { callback(error); return }
      const node = lookup(target)
      if (node === null) { callback(absent()); return }
      const isLink = node.type === 'link'
      callback(undefined, {
        size: isLink || node.type === 'dir' ? 0 : Buffer.byteLength(node.text, 'utf8'),
        isFile: () => node.type === 'file',
        isDirectory: () => node.type === 'dir',
        isSymbolicLink: () => isLink,
      })
    },
    realpath (target, callback) {
      calls.push('realpath ' + target)
      const resolved = resolve(target)
      if (resolved === null) callback(absent())
      else callback(undefined, resolved)
    },
    readdir (target, callback) {
      calls.push('readdir ' + target)
      try { guard() } catch (error) { callback(error); return }
      if (lookup(target) === null) { callback(absent()); return }
      const prefix = target === '/' ? '/' : target + '/'
      const names = new Set()
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        names.add(rest.split('/')[0])
      }
      callback(undefined, [...names].sort().map((name) => {
        const child = lookup(prefix + name)
        const isDir = child?.type === 'dir'
        return { filename: name, attrs: { isFile: () => !isDir, isDirectory: () => isDir, size: 0 } }
      }))
    },
    open (target, flags, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      calls.push('open ' + target)
      try { guard() } catch (error) { callback(error); return }
      const node = lookup(target)
      if (node === null || node.type !== 'file') { callback(absent()); return }
      const handle = Buffer.from('h' + nextHandle)
      nextHandle += 1
      handles.set(handle.toString('hex'), node.text)
      callback(undefined, handle)
    },
    read (handle, buffer, offset, length, position, callback) {
      calls.push('read ' + handle.toString('hex'))
      const text = handles.get(handle.toString('hex'))
      if (text === undefined) { callback(absent()); return }
      const bytes = Buffer.from(text, 'utf8')
      const slice = bytes.subarray(position, position + length)
      slice.copy(buffer, offset)
      callback(undefined, slice.length)
    },
    close (handle, callback) {
      calls.push('close ' + handle.toString('hex'))
      handles.delete(handle.toString('hex'))
      callback(undefined)
    },
  }
  return { sftp, calls, failNext }
}

const ROOT = 'ssh://box/data/proj'
const SKILL_MD = [
  '---',
  'name: deploy-notes',
  'description: How this host deploys',
  'whenToUse: When asked about deploys',
  '---',
  '',
  'Run make deploy.',
].join('\n')

function providerFor (tree, options) {
  // The trees below are written with ssh:// spellings because that is how a
  // reader thinks about them; SFTP speaks remote paths, so strip the host part
  // once, here, instead of in every fixture.
  const remoteTree = {}
  for (const [key, value] of Object.entries(tree)) {
    remoteTree[key.startsWith('ssh://box') ? key.slice('ssh://box'.length) : key] = value
  }
  const { sftp, calls, failNext } = fakeSftp(remoteTree)
  const engine = {
    async withSftp (alias, operation) {
      calls.push('connect ' + alias)
      return await operation(sftp)
    },
  }
  const provider = new RemoteSkillsProvider({
    engine: () => engine,
    roots: () => (options?.roots ?? [ROOT]),
    config: options?.config ?? { enabled: true, hosts: { box: {} } },
    logger: options?.logger,
    diagnostics: options?.diagnostics,
  })
  return { provider, calls, failNext }
}

console.log('\n=== remote skills ===\n')

{
  console.log('[config]')
  const normalized = normalizeRemoteSkillsConfig({ enabled: false, hosts: { box: { roots: ['.agents/skills'] } } })
  check('disabled stays disabled', normalized.enabled === false)
  check('an allowlisted host keeps its roots', JSON.stringify(normalized.hosts.get('box').roots) === JSON.stringify(['.agents/skills']))
  check('limits fall back rather than widen', normalizeRemoteSkillsConfig({ hosts: { box: { maxSkills: 0, maxBytes: -5 } } }).hosts.get('box').maxSkills === 32)
  const wildcard = normalizeRemoteSkillsConfig({ hosts: { '*': {}, 'bo?x': {}, box: {} } })
  check('a wildcard alias is refused, not expanded', wildcard.hosts.has('*') === false && wildcard.hosts.has('bo?x') === false)
  check('...and the exact alias beside it still works', wildcard.hosts.has('box') === true)
}

{
  console.log('\n[frontmatter]')
  const parsed = parseFrontmatter(SKILL_MD)
  check('frontmatter splits from the body', parsed !== undefined && parsed.body.trim() === 'Run make deploy.')
  check('a quoted scalar loses its quotes', parseMapping('name: "x"').name === 'x')
  check('...and yes becomes a boolean', parseMapping('a: yes').a === true)
  check('a nested mapping stays a mapping', typeof parseMapping('metadata:\n  owner: ops').metadata === 'object')
  check('a block scalar keeps its newlines', parseMapping('body: |\n  one\n  two').body === 'one\ntwo')
  check('a file without frontmatter is not a skill', parseFrontmatter('no frontmatter here') === undefined)
  const legacy = parseSkillText('---\nname: x\ndescription: d\nmodelInvocable: true\n---\nbody', 'ssh://box/x', undefined)
  check('a legacy invocation key is rejected, not interpreted', legacy === undefined)
  const badName = parseSkillText('---\nname: Bad Name\ndescription: d\n---\nbody', 'ssh://box/x', undefined)
  check('an invalid skill name is rejected', badName === undefined)
  const ok = parseSkillText(SKILL_MD, 'ssh://box/x', undefined)
  check('a valid skill parses with both invocation flags on', ok !== undefined && ok.invocation.modelInvocable === true && ok.invocation.userInvocable === true)
}

{
  console.log('\n[off means off]')
  const tree = {}
  tree[ROOT + '/.agents/skills/deploy-notes/SKILL.md'] = { type: 'file', text: SKILL_MD }
  const { provider, calls } = providerFor(tree, { config: { enabled: false, hosts: { box: {} } } })
  const observation = await provider.list({ cwd: ROOT })
  check('a disabled provider answers an empty, complete catalog', observation.candidates.length === 0 && observation.complete === true)
  check('...without opening a single SSH operation', calls.length === 0, calls.length + ' operation(s)')
}

{
  console.log('\n[allowlist]')
  const { provider, calls } = providerFor({}, { config: { enabled: true, hosts: { other: {} } } })
  const observation = await provider.list({ cwd: ROOT })
  check('an unnamed host answers nothing', observation.candidates.length === 0 && observation.complete === true)
  check('...and is never dialled', calls.length === 0)
  const unmounted = providerFor({}, { roots: ['ssh://box/elsewhere'] })
  const outside = await unmounted.provider.list({ cwd: ROOT })
  check('a cwd outside every mounted root answers nothing', outside.candidates.length === 0 && outside.complete === true)
  check('...also without dialling', unmounted.calls.length === 0)
  const localCwd = await provider.list({ cwd: '/home/someone/project' })
  check('a local cwd is not a remote session', localCwd.candidates.length === 0 && localCwd.complete === true)
}

{
  console.log('\n[discovery]')
  const tree = {}
  tree[ROOT + '/.agents/skills/deploy-notes/SKILL.md'] = { type: 'file', text: SKILL_MD }
  tree[ROOT + '/.agents/skills/flat-skill.md'] = { type: 'file', text: '---\nname: flat-skill\ndescription: A flat one\n---\nbody' }
  tree[ROOT + '/.agents/skills/not-a-skill/README.md'] = { type: 'file', text: 'no frontmatter' }
  tree[ROOT + '/.agents/skills/ignored.txt'] = { type: 'file', text: 'not markdown' }
  const { provider, calls } = providerFor(tree)
  const observation = await provider.list({ cwd: ROOT })
  const names = observation.candidates.map(candidate => candidate.name).sort()
  check('a directory bundle is found', names.includes('deploy-notes'))
  check('a flat .md skill is found', names.includes('flat-skill'))
  check('a non-markdown file is skipped', names.includes('ignored.txt') === false)
  check('a bundle without a parsable SKILL.md is skipped', observation.candidates.some(candidate => candidate.name === 'README') === false)
  check('discovery completed', observation.complete === true)
  check('every candidate declares this provider', observation.candidates.every(candidate => candidate.provider === PROVIDER_NAME))
  check('every candidate carries the documented rank', observation.candidates.every(candidate => candidate.rank === REMOTE_SKILL_RANK))
  check('the rank sits between project and user roots', REMOTE_SKILL_RANK > 200 && REMOTE_SKILL_RANK < 400)
  check('a candidate locator is an ssh:// spelling', observation.candidates.every(candidate => candidate.locator.displayPath.startsWith('ssh://box/')))
  check('a candidate resource base is the skill directory', observation.candidates.every(candidate => candidate.resourceBase.kind === 'directory'))
  check('discovery opened at least one connection', calls.some(call => call.startsWith('connect box')))
  // The Windows trap: node:path.join on an ssh:// spelling produces a
  // backslash-riddled string that is not a remote path. Every locator must
  // therefore be a pure POSIX join, and this is the assertion that catches a
  // regression — the failure mode is a silently empty catalog on Windows only.
  check(
    'no locator contains a backslash',
    observation.candidates.every(candidate => !candidate.locator.displayPath.includes('\\')),
    observation.candidates.map(candidate => candidate.locator.displayPath).join(' | '),
  )
}

{
  console.log('\n[limits]')
  const many = {}
  for (let index = 0; index < 6; index += 1) {
    many[ROOT + '/.agents/skills/skill-' + index + '/SKILL.md'] = { type: 'file', text: '---\nname: skill-' + index + '\ndescription: d' + index + '\n---\nbody' }
  }
  const capped = providerFor(many, { config: { enabled: true, hosts: { box: { maxSkills: 3 } } } })
  const cappedObservation = await capped.provider.list({ cwd: ROOT })
  check('maxSkills caps the catalog', cappedObservation.candidates.length === 3, String(cappedObservation.candidates.length))

  const big = 'x'.repeat(70 * 1024)
  const huge = {}
  huge[ROOT + '/.agents/skills/huge/SKILL.md'] = { type: 'file', text: '---\nname: huge\ndescription: d\n---\n' + big }
  const oversized = providerFor(huge, { config: { enabled: true, hosts: { box: { maxBytes: 4096 } } } })
  const oversizedObservation = await oversized.provider.list({ cwd: ROOT })
  check('an oversized SKILL.md is skipped, never truncated', oversizedObservation.candidates.length === 0)

  const binary = {}
  binary[ROOT + '/.agents/skills/bin/SKILL.md'] = { type: 'file', text: '---\nname: bin\ndescription: d\n---\n' + String.fromCharCode(0, 1) }
  const binaryObservation = await providerFor(binary).provider.list({ cwd: ROOT })
  check('a SKILL.md with NUL bytes is not read as text', binaryObservation.candidates.length === 0)
}

{
  console.log('\n[incompleteness is not emptiness]')
  const tree = {}
  tree[ROOT + '/.agents/skills/deploy-notes/SKILL.md'] = { type: 'file', text: SKILL_MD }
  const { provider, failNext } = providerFor(tree)
  const first = await provider.list({ cwd: ROOT })
  check('a healthy pass finds the skill', first.candidates.length === 1 && first.complete === true)
  // The second pass fails on the second root: the answer keeps what it read and
  // says it is incomplete, which is what stops the Host caching a short catalog.
  failNext.code = 'FS_PERMISSION_DENIED'
  provider.invalidate()
  const second = await provider.list({ cwd: ROOT })
  check('a failing root makes the observation incomplete', second.complete === false)
  check('...without discarding what was readable', second.candidates.length >= 1)

  const empty = providerFor({})
  const noRoots = await empty.provider.list({ cwd: ROOT })
  check('an absent root is a complete empty answer', noRoots.candidates.length === 0 && noRoots.complete === true)
}

{
  console.log('\n[cache and invalidation]')
  const tree = {}
  tree[ROOT + '/.agents/skills/deploy-notes/SKILL.md'] = { type: 'file', text: SKILL_MD }
  const { provider, calls } = providerFor(tree)
  await provider.list({ cwd: ROOT })
  const afterFirst = calls.length
  await provider.list({ cwd: ROOT })
  check('a repeated lookup is served from the cache', calls.length === afterFirst, (calls.length - afterFirst) + ' new operation(s)')
  provider.invalidate()
  await provider.list({ cwd: ROOT })
  check('invalidate() forces a fresh pass', calls.length > afterFirst)
}

{
  console.log('\n[get re-verifies the fence]')
  const tree = {}
  tree[ROOT + '/.agents/skills/deploy-notes/SKILL.md'] = { type: 'file', text: SKILL_MD }
  tree['/etc/evil.md'] = { type: 'file', text: '---\nname: evil\ndescription: escaped\n---\nbody' }
  tree[ROOT + '/.agents/skills/escape'] = { type: 'link', to: '/etc' }
  const refusals = []
  const { provider } = providerFor(tree, { diagnostics: { record: (kind, message) => refusals.push({ kind, message }) } })
  const observation = await provider.list({ cwd: ROOT })
  const good = observation.candidates.find(candidate => candidate.name === 'deploy-notes')
  check('the legitimate skill is discovered', good !== undefined)
  const loaded = good === undefined ? undefined : await provider.get(good, {})
  check('...and its body loads through the fence', loaded !== undefined && loaded.content === 'Run make deploy.')
  check('the loaded body names this provider', loaded?.provider === PROVIDER_NAME)
  check('the loaded body is marked remote', loaded?.source === 'remote')

  // A locator that escapes by symlink must be REFUSED, and refused before any
  // body is read: the read path in remote-fs.js has no write fence.
  const escaped = {
    name: 'evil',
    description: 'escaped',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'remote',
    rank: REMOTE_SKILL_RANK,
    locator: { alias: 'box', remotePath: '/etc/evil.md', displayPath: 'ssh://box/etc/evil.md', directoryDisplay: 'ssh://box/etc', maxBytes: 65536 },
    resourceBase: { kind: 'directory', path: 'ssh://box/etc' },
    path: 'ssh://box/etc/evil.md',
  }
  const refused = await provider.get(escaped, {})
  check('a locator outside every mounted root is refused', refused === undefined)
  // A refusal that leaves no trace is indistinguishable from a skill the user
  // deleted; the diagnostic is the only place a human can see why it vanished.
  check(
    '...and the refusal is diagnosed',
    refusals.some(entry => entry.kind === 'degraded' && entry.message.includes('ssh://box/etc/evil.md')),
    JSON.stringify(refusals),
  )
  check('...without echoing the escaped body', refusals.every(entry => !entry.message.includes('escaped')))
}

{
  console.log('\n[diagnostics never carry the body]')
  const recorded = []
  const tree = {}
  tree[ROOT + '/.agents/skills/deploy-notes/SKILL.md'] = { type: 'file', text: SKILL_MD }
  const { provider } = providerFor(tree, { diagnostics: { record: (kind, message, detail) => recorded.push({ kind, message, detail }) } })
  await provider.list({ cwd: ROOT })
  check('a completed pass is recorded', recorded.length === 1)
  check('...under its own kind', recorded[0]?.kind === 'remote-skills')
  check('...and the body is nowhere in it', recorded.every(entry => !entry.message.includes('make deploy')))
  check('...and neither is the description', recorded.every(entry => !entry.message.includes('How this host deploys')))
  const described = provider.describe()
  check('describe() reports the allowlist', described.enabled === true && described.hosts.length === 1)
  check('describe() carries the last pass, not the bodies', described.last?.skills === 1 && JSON.stringify(described.last).includes('deploy') === false)
}

console.log('\n=== remote skills: ' + passed + ' passed, ' + failures + ' failed ===\n')
process.exit(failures === 0 ? 0 : 1)
