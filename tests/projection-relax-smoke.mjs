/**
 * Stored sessions whose cwd is an `ssh://` workspace must load again.
 *
 * The `workingDirectory` projection is validated on every history read
 * (`sessionProjections.restore` → `def.wire.viewSchema.parse`). Its schema is
 * built by `@deepseek-ai/dsh-working-directory` as
 *
 *     z.string().min(1).refine(isAbsolute).nullable()
 *
 * which captures the `isAbsolute` FUNCTION VALUE at construction time. This
 * plugin patches `node:path.isAbsolute` and republishes it with
 * `syncBuiltinESMExports()`, but that only moves the ESM BINDING — a schema that
 * already holds the old function keeps calling it, answers `false` for
 * `ssh://host/path`, and the browser shows
 * `历史加载失败：failed to project session "…" … Invalid input`.
 *
 * These checks pin the relaxation from both sides:
 *
 * - the schema still rejects a RELATIVE local path (the relaxation is not a
 *   blanket `z.any()`), still accepts `null`, and still runs the original rule
 *   for everything that is not remote;
 * - both load orders are covered, because the roster mounts `working-directory`
 *   before any third-party row but a reload or a harness may mount this plugin
 *   first;
 * - and the suite proves it would CATCH the bug: with the relaxation removed,
 *   the same `ssh://` value must fail.
 *
 * Run: node tests/projection-relax-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== projection relax smoke ===\n')

const {
  RELAXED_KEY,
  WORKAROUND_ID,
  UPSTREAM_FIX,
  DISABLE_ENV,
  PROBE,
  workaroundsDisabled,
  acceptsRemotePath,
  probeUpstream,
  relaxSchema,
  relaxDefinition,
  installProjectionRelaxation,
  uninstallProjectionRelaxation,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-projection.js')).href)

const SSH_CWD = 'ssh://qiyk/home/qiyk/test'
const LOCAL_CWD = path.resolve(pluginRoot)
const RELATIVE = 'relative/dir'

/**
 * A parser that reproduces the defect's SHAPE: it captures the predicate by
 * value, exactly as `.refine(isAbsolute)` does.
 *
 * Deliberately not zod. What matters is the semantics the Host relies on — a
 * `parse` that either returns the value or throws — and that the captured
 * predicate is the ORIGINAL `isAbsolute`, so patching the module binding
 * afterwards cannot help. A zod double would only add a dependency to the test.
 */
function capturedSchema (predicate) {
  return {
    kind: 'captured-string-schema',
    parse (value) {
      if (value === null) return value
      if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid input')
      if (!predicate(value)) throw new Error('Invalid input')
      return value
    },
  }
}

/** The predicate as the Host's module saw it at import time: no ssh:// support. */
const originalIsAbsolute = (candidate) => typeof candidate === 'string'
  && (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate))

/** A registry double with the surface `patch-projection.js` touches. */
function makeRegistry (definition) {
  const registrations = new Map()
  const registry = {
    registrations,
    registerCalls: 0,
    register (def) {
      this.registerCalls += 1
      registrations.set(def.key, { def, cells: new Map(), refs: 1 })
      return () => { registrations.delete(def.key) }
    },
  }
  if (definition !== undefined) registry.register(definition)
  return registry
}

/** The definition shape the Host's `working-directory` service registers. */
function directoryDefinition () {
  const schema = capturedSchema(originalIsAbsolute)
  return {
    key: RELAXED_KEY,
    stateVersion: 1,
    stateSchema: schema,
    init: (header) => header.cwd ?? null,
    apply: (state, event) => event.type === 'working-directory/change' ? event.data.cwd : state,
    wire: { viewSchema: schema, view: (state) => state },
  }
}

const ctxFor = (registry) => ({ get: (name) => name === 'sessionProjections' ? registry : undefined })

/**
 * Whether a schema ACCEPTS a value.
 *
 * Kept separate from a bare `.parse(...) === value` so a reverse check reports a
 * FAIL line instead of crashing the suite: when the fix is disabled, `parse`
 * throws, and an uncaught throw would hide the other assertions.
 *
 * @param {object} schema - the parser to probe.
 * @param {any} value - the value to parse.
 * @returns {boolean} true when `parse` returned the value.
 */
function accepts (schema, value) {
  try {
    return schema.parse(value) === value
  } catch {
    return false
  }
}

/**
 * Whether a schema REFUSES a value.
 *
 * The Host's contract is "return the value or throw", so a rejection is only
 * observable as a throw — comparing the result of `parse` would crash the suite
 * instead of reporting a failure.
 *
 * @param {object} schema - the parser to probe.
 * @param {any} value - the value to parse.
 * @returns {boolean} true when `parse` threw.
 */
function rejects (schema, value) {
  try {
    schema.parse(value)
    return false
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// 0. The bug reproduces: the captured schema rejects the remote spelling.
//    Without this the rest of the suite proves nothing.
// ---------------------------------------------------------------------------
{
  const definition = directoryDefinition()
  let message
  try {
    definition.wire.viewSchema.parse(SSH_CWD)
  } catch (error) {
    message = error.message
  }
  check('an unrelaxed schema rejects the ssh:// cwd (the reported bug)', message === 'Invalid input', message)
  check('...while the same schema accepts a local absolute path',
    definition.wire.viewSchema.parse(LOCAL_CWD) === LOCAL_CWD)
}
// ---------------------------------------------------------------------------
// 1. relaxSchema: exactly one value shape is widened.
// ---------------------------------------------------------------------------
{
  const schema = capturedSchema(originalIsAbsolute)
  const relaxed = relaxSchema(schema)

  check('a relaxed schema accepts the ssh:// cwd', accepts(relaxed, SSH_CWD))
  check('...still accepts a local absolute path', accepts(relaxed, LOCAL_CWD))
  check('...still accepts null', relaxed.parse(null) === null)
  check('...still REJECTS a relative local path (not a blanket pass)', rejects(relaxed, RELATIVE))
  check('...still rejects an empty string', rejects(relaxed, ''))
  check('the original schema is left rejecting the ssh:// cwd', rejects(schema, SSH_CWD))
  check('relaxing twice returns the same object (idempotent)', relaxSchema(relaxed) === relaxed)
  check('the relaxed schema inherits from the original', Object.getPrototypeOf(relaxed) === schema)
  check('the original schema kind is still reachable through the chain',
    relaxed.kind === 'captured-string-schema')
}

// ---------------------------------------------------------------------------
// 2. relaxSchema leaves non-schema inputs alone rather than inventing one.
// ---------------------------------------------------------------------------
{
  check('undefined passes through', relaxSchema(undefined) === undefined)
  check('null passes through', relaxSchema(null) === null)
  const notAParser = { key: 'x' }
  check('an object without parse() passes through unchanged', relaxSchema(notAParser) === notAParser)
}

// ---------------------------------------------------------------------------
// 3. relaxDefinition only touches the directory unit.
// ---------------------------------------------------------------------------
{
  const other = { key: 'sessionListMetadata', stateSchema: { parse: (v) => v } }
  check('another projection unit is returned unchanged', relaxDefinition(other) === other)

  const definition = directoryDefinition()
  const relaxed = relaxDefinition(definition)
  check('the directory unit gets a relaxed stateSchema', accepts(relaxed.stateSchema, SSH_CWD))
  check('...and a relaxed viewSchema', accepts(relaxed.wire.viewSchema, SSH_CWD))
  check('...while init and apply are carried over', relaxed.init === definition.init && relaxed.apply === definition.apply)
  check('...and the original definition object is not mutated', rejects(definition.stateSchema, SSH_CWD))
}

// ---------------------------------------------------------------------------
// 4. Production order: the unit registered BEFORE this plugin loaded.
// ---------------------------------------------------------------------------
{
  const registry = makeRegistry(directoryDefinition())
  const installed = installProjectionRelaxation(ctxFor(registry), {})

  check('installing finds the already-registered unit', installed?.relaxedInPlace === true)

  const registered = registry.registrations.get(RELAXED_KEY).def
  check('the registered viewSchema now accepts the ssh:// cwd',
    accepts(registered.wire.viewSchema, SSH_CWD))
  check('the registered stateSchema accepts it too',
    accepts(registered.stateSchema, SSH_CWD))
  check('...and the local rule is unchanged', accepts(registered.wire.viewSchema, LOCAL_CWD))
  check('...a relative path is still refused after relaxation', rejects(registered.wire.viewSchema, RELATIVE))

  uninstallProjectionRelaxation(ctxFor(registry))
}

// ---------------------------------------------------------------------------
// 5. Reload/harness order: the unit registers AFTER the plugin installed.
// ---------------------------------------------------------------------------
{
  const registry = makeRegistry()
  const installed = installProjectionRelaxation(ctxFor(registry), {})
  check('installing with no unit yet reports that it was not found in place',
    installed?.relaxedInPlace === false)

  registry.register(directoryDefinition())
  const registered = registry.registrations.get(RELAXED_KEY).def
  check('a unit registered afterwards is relaxed on arrival',
    accepts(registered.wire.viewSchema, SSH_CWD))
  check('...and its non-directory siblings are registered untouched', (() => {
    const other = { key: 'sessionListMetadata', stateSchema: capturedSchema(originalIsAbsolute), wire: { viewSchema: capturedSchema(originalIsAbsolute), view: (s) => s } }
    registry.register(other)
    return rejects(registry.registrations.get('sessionListMetadata').def.wire.viewSchema, SSH_CWD)
  })())

  uninstallProjectionRelaxation(ctxFor(registry))
}

// ---------------------------------------------------------------------------
// 6. Idempotence, disposal, and the "no registry" case.
// ---------------------------------------------------------------------------
{
  const registry = makeRegistry(directoryDefinition())
  const ctx = ctxFor(registry)
  const first = installProjectionRelaxation(ctx, {})
  const second = installProjectionRelaxation(ctx, {})
  check('a second install returns the same installation', first === second)

  uninstallProjectionRelaxation(ctx)
  check('uninstalling removes the register wrapper', Object.hasOwn(registry, 'register') === false)
  check('...but leaves the relaxed schema in place, so an open session keeps loading',
    accepts(registry.registrations.get(RELAXED_KEY).def.wire.viewSchema, SSH_CWD))

  check('a context without the service installs nothing',
    installProjectionRelaxation({ get: () => undefined }, {}) === undefined)
  check('uninstalling twice is harmless', (() => {
    uninstallProjectionRelaxation(ctx)
    return true
  })())
}

// ---------------------------------------------------------------------------
// 7. The relaxation is what fixes it: put the captured schema back and the
//    ssh:// cwd fails again. This is the reverse check — if someone deletes the
//    wrapper, this suite goes red instead of quietly passing.
// ---------------------------------------------------------------------------
{
  const definition = directoryDefinition()
  const capturedView = definition.wire.viewSchema
  const registry = makeRegistry(definition)
  const installed = installProjectionRelaxation(ctxFor(registry), {})
  const def = registry.registrations.get(RELAXED_KEY).def

  check('the installed unit parses the ssh:// cwd', accepts(def.wire.viewSchema, SSH_CWD))

  // Revert to the schema that captured the original predicate, exactly as if
  // the fix had never shipped.
  def.wire.viewSchema = capturedView
  check('reverting to the captured schema makes the ssh:// cwd fail again (reverse check)',
    rejects(def.wire.viewSchema, SSH_CWD), 'the relaxation is load-bearing')
  check('...and the installation object records that it found the unit in place',
    installed?.relaxedInPlace === true)
}

// ---------------------------------------------------------------------------
// 8. The workaround knows when it is obsolete.
//
//    This is the section that makes the marker in patch-projection.js more than
//    a comment. A Host release that reads the binding instead of capturing it
//    produces a schema that ALREADY accepts an ssh:// value; from that release
//    on this module must patch nothing at all and say so, so that "is it still
//    needed?" is answered by behaviour rather than by a version number.
// ---------------------------------------------------------------------------
{
  check('the workaround carries a stable, grep-able id',
    WORKAROUND_ID === 'UPSTREAM-1-working-directory-isAbsolute', WORKAROUND_ID)
  check('...and points at its runbook', /upstream-workarounds\.md$/u.test(UPSTREAM_FIX.runbook), UPSTREAM_FIX.runbook)

  // A schema shaped like the FIXED Host module: it reads the patched binding at
  // call time, so a remote spelling already validates.
  const fixed = {
    kind: 'fixed-string-schema',
    parse (value) {
      if (value === null) return value
      if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid input')
      if (!(path.isAbsolute(value) || /^ssh:\/\//iu.test(value))) throw new Error('Invalid input')
      return value
    },
  }

  check('a schema that already accepts ssh:// is detected as remote-aware', acceptsRemotePath(fixed) === true)
  check('...while the captured schema is not', acceptsRemotePath(capturedSchema(originalIsAbsolute)) === false)
  check('...and a non-parser is not mistaken for one', acceptsRemotePath({}) === false)
  check('...nor is an absent schema', acceptsRemotePath(undefined) === false)

  check('relaxSchema leaves a remote-aware schema untouched (identity, no wrapper)',
    relaxSchema(fixed) === fixed)

  const definition = {
    key: RELAXED_KEY,
    stateSchema: fixed,
    init: (header) => header.cwd ?? null,
    wire: { viewSchema: fixed, view: (state) => state },
  }
  check('relaxDefinition passes an already-fixed unit through unchanged',
    relaxDefinition(definition) === definition)

  const registry = makeRegistry(definition)
  const installed = installProjectionRelaxation(ctxFor(registry), {})
  check('installing against a fixed Host reports upstreamFixed', installed?.upstreamFixed === true)
  check('...and reports the probe state that proves it', installed?.probe === PROBE.fixed, installed?.probe)
  check('...and explains why in `detail`', typeof installed?.detail === 'string' && installed.detail !== '', installed?.detail)
  check('...and relaxes nothing in place', installed?.relaxedInPlace === false)
  check('...and does NOT wrap register (a fixed Host needs no interception)',
    Object.hasOwn(registry, 'register') === true && registry.registerCalls === 1)
  check('...while the unit keeps parsing the ssh:// cwd', accepts(registry.registrations.get(RELAXED_KEY).def.wire.viewSchema, SSH_CWD))

  uninstallProjectionRelaxation(ctxFor(registry))
}

// ---------------------------------------------------------------------------
// 8b. "I cannot see the Host" is NOT "the Host is fine", and NOT "the Host is
//     broken". These used to be the same `false`, which made a silent
//     regression possible: a Host that renamed `registrations` would stop being
//     patched, report nothing, and reproduce the bug the workaround exists to
//     prevent. Each state below is asserted separately for that reason.
// ---------------------------------------------------------------------------
{
  check('the probe vocabulary is the closed six-state set',
    JSON.stringify(Object.values(PROBE).sort()) ===
      JSON.stringify(['already', 'broken', 'disabled', 'fixed', 'pending', 'unprobeable']),
    JSON.stringify(Object.values(PROBE)))

  // A registry whose table is not a Map: this is what a future Host reshape
  // looks like from here (renamed field, private field, plain object).
  const opaque = { register () {}, registerCalls: 0 }
  const judged = probeUpstream(opaque)
  check('a registry without a registrations Map is UNPROBEABLE, not "still broken"',
    judged.state === PROBE.unprobeable, judged.state)
  check('...and the detail names what is missing', /registrations/u.test(judged.detail), judged.detail)
  check('...a null registry is unprobeable too', probeUpstream(null).state === PROBE.unprobeable)

  const installed = installProjectionRelaxation(ctxFor(opaque), {})
  check('installing on an unprobeable Host reports the state instead of pretending it judged',
    installed?.probe === PROBE.unprobeable, installed?.probe)
  check('...does not claim upstream is fixed', installed?.upstreamFixed === false)
  check('...and still wraps register as a precaution', Object.hasOwn(opaque, 'register') === true)
  uninstallProjectionRelaxation(ctxFor(opaque))

  // The normal production state: still broken.
  const broken = makeRegistry(directoryDefinition())
  const brokenInstalled = installProjectionRelaxation(ctxFor(broken), {})
  check('a still-broken Host is reported as broken (not as fixed, not as unprobeable)',
    brokenInstalled?.probe === PROBE.broken, brokenInstalled?.probe)
  uninstallProjectionRelaxation(ctxFor(broken))

  // The unit not being registered yet is its own state, not a judgement.
  const pending = makeRegistry(undefined)
  const pendingInstalled = installProjectionRelaxation(ctxFor(pending), {})
  check('an unregistered unit is pending, not judged', pendingInstalled?.probe === PROBE.pending, pendingInstalled?.probe)
  uninstallProjectionRelaxation(ctxFor(pending))
}

// ---------------------------------------------------------------------------
// 9. The operator switch: skip the workaround without editing code.
//
//    Its whole job is to answer "is this still load-bearing?" against a real
//    deployment, so what matters is that it (a) skips every patch and (b) is
//    off unless explicitly spelled.
// ---------------------------------------------------------------------------
{
  check(`${DISABLE_ENV} is off when unset`, workaroundsDisabled({}) === false)
  check('...off for an empty value', workaroundsDisabled({ [DISABLE_ENV]: '' }) === false)
  check('...off for "0"', workaroundsDisabled({ [DISABLE_ENV]: '0' }) === false)
  check('...on for "1" / "true" / "yes" / "on"',
    ['1', 'true', 'TRUE', 'yes', 'on'].every(value => workaroundsDisabled({ [DISABLE_ENV]: value })))

  const registry = makeRegistry(directoryDefinition())
  const installed = installProjectionRelaxation(ctxFor(registry), { env: { [DISABLE_ENV]: '1' } })
  check('a disabled workaround reports enabled: false', installed?.enabled === false)
  check('...and says so in its probe state', installed?.probe === PROBE.disabled, installed?.probe)
  check('...and does not relax the registered schema',
    rejects(registry.registrations.get(RELAXED_KEY).def.wire.viewSchema, SSH_CWD))
  check('...and does not wrap register', Object.hasOwn(registry, 'register') === true)

  uninstallProjectionRelaxation(ctxFor(registry))
}

// ---------------------------------------------------------------------------
// 10. A schema that accepts the probe ONLY because it captured OUR patched
//     predicate is NOT evidence that upstream fixed anything.
//
//     This is the regression the retirement signal shipped with: the bridge is
//     installed from this plugin's own `apply()`, and the `workingDirectory`
//     unit is constructed when its service is first touched — so on the real
//     Host the schema captures the PATCHED `isAbsolute`. It then accepts an
//     ssh:// value, a plain accept-check reports `fixed`, and the advice that
//     verdict prints is "delete the workaround" — on a Host whose source still
//     says `refine(isAbsolute)`.
//
//     The discriminator is whether the acceptance READS the binding. The
//     registry double below is paired with a fake bridge so both orders can be
//     reproduced without the real fs-shim (which would drag in the peers).
// ---------------------------------------------------------------------------
{
  const { BRIDGE } = await import(pathToFileURL(path.join(pluginRoot, 'lib/path-binding.js')).href)
  const originalIsAbsolute = path.isAbsolute
  /** A predicate that accepts ssh://, like the one fs-shim installs. */
  const patchedIsAbsolute = (candidate) => typeof candidate === 'string'
    && (originalIsAbsolute(candidate) || /^ssh:\/\//iu.test(candidate))

  /** Install/remove a fake bridge — BOTH the state and the real patch. */
  const withBridge = (fn) => {
    const prior = globalThis[BRIDGE]
    const priorIsAbsolute = path.isAbsolute
    globalThis[BRIDGE] = {
      pathPatches: [{ surface: path, isAbsolute: priorIsAbsolute, resolve: path.resolve, join: path.join, relative: path.relative }],
      republish: () => {},
    }
    path.isAbsolute = patchedIsAbsolute
    try {
      return fn()
    } finally {
      path.isAbsolute = priorIsAbsolute
      if (prior === undefined) delete globalThis[BRIDGE]
      else globalThis[BRIDGE] = prior
    }
  }

  // The Host's DEFECTIVE unit, built while the bridge is live: it captures
  // whatever `path.isAbsolute` is at construction — i.e. the patched one.
  const capturedAfterPatch = withBridge(() => {
    const captured = path.isAbsolute
    return capturedSchema(captured)
  })

  check('a schema that captured the PATCHED predicate does accept the ssh:// cwd',
    acceptsRemotePath(capturedAfterPatch) === true)
  check('...so a plain accept-check alone would call this Host fixed (the trap)',
    acceptsRemotePath(capturedAfterPatch) === true)

  const judged = withBridge(() => probeUpstream(makeRegistry({
    key: RELAXED_KEY,
    stateVersion: 1,
    stateSchema: capturedAfterPatch,
    init: (header) => header.cwd ?? null,
    apply: (state) => state,
    wire: { viewSchema: capturedAfterPatch, view: (state) => state },
  })))
  check('...but the probe reports BROKEN, not fixed: the capture is still a capture',
    judged.state === PROBE.broken, `${judged.state} — ${judged.detail}`)
  check('...and the detail says why, rather than claiming the Host rejects ssh://',
    /captured/u.test(judged.detail), judged.detail)

  // The genuinely fixed unit reads the binding at call time, so restoring the
  // original predicate makes it stop accepting — that is what proves the read.
  const readsBinding = withBridge(() => ({
    parse (value) {
      if (value === null) return value
      if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid input')
      if (!(path.isAbsolute(value) || /^ssh:\/\//iu.test(value))) throw new Error('Invalid input')
      return value
    },
  }))
  check('a schema that reads the binding is STILL reported fixed',
    withBridge(() => probeUpstream(makeRegistry({
      key: RELAXED_KEY,
      stateVersion: 1,
      stateSchema: readsBinding,
      init: (header) => header.cwd ?? null,
      apply: (state) => state,
      wire: { viewSchema: readsBinding, view: (state) => state },
    }))).state === PROBE.fixed)

  // No bridge at all (a bare harness, or a Host that never patched): an
  // acceptance cannot be this plugin's doing, so it is evidence.
  const loneFixed = {
    parse (value) {
      if (value === null) return value
      if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid input')
      if (!(originalIsAbsolute(value) || /^ssh:\/\//iu.test(value))) throw new Error('Invalid input')
      return value
    },
  }
  check('with no bridge installed, an accepting schema is still judged fixed',
    probeUpstream(makeRegistry({
      key: RELAXED_KEY,
      stateVersion: 1,
      stateSchema: loneFixed,
      init: (header) => header.cwd ?? null,
      apply: (state) => state,
      wire: { viewSchema: loneFixed, view: (state) => state },
    })).state === PROBE.fixed)

  // relaxSchema must keep wrapping the captured schema: it is a pure superset,
  // and skipping it here is what made the whole thing load-order dependent.
  check('relaxSchema still wraps a captured schema that happens to accept',
    withBridge(() => relaxSchema(capturedAfterPatch)) !== capturedAfterPatch)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
