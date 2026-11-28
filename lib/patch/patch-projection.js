/**
 * UPSTREAM WORKAROUND #1 — keep the `workingDirectory` projection readable for
 * an `ssh://` cwd.
 *
 * WHAT UPSTREAM DOES (and the one-line fix that ends this module's life):
 * `@deepseek-ai/dsh-working-directory` builds its projection schema as
 *
 * ```js
 * const directorySchema = z.string().min(1).refine(isAbsolute).nullable()
 * ```
 *
 * `refine(isAbsolute)` hands zod the FUNCTION VALUE the `node:path` import held
 * at construction. Our builtin bridge (fs-shim.js) swaps `node:path.isAbsolute`
 * and calls `syncBuiltinESMExports()`; modules that READ the binding at call time
 * see the patch, but a schema that captured the value keeps the original
 * `isAbsolute`, which answers `false` for `ssh://host/path`. One-line upstream
 * fix — read the binding, not the value:
 *
 * ```js
 * const directorySchema = z.string().min(1).refine((value) => isAbsolute(value)).nullable()
 * ```
 *
 * HOW TO REMOVE (see docs/upstream-workarounds.md): on the DSH release carrying
 * that fix, delete (1) the `ctx.inject(['sessionProjections'], …)` block in
 * lib/index.js, (2) this file, (3) tests/projection-relax-smoke.mjs and
 * tests/projection-real-smoke.mjs, (4) docs/upstream-workarounds.md + index rows.
 *
 * No need to notice the release yourself: {@link installProjectionRelaxation}
 * probes the schema with an `ssh://` value; if it already accepts one, it
 * installs NOTHING and reports `probe: 'fixed'` — a self-announcing no-op, not a
 * silent double-relaxation. But "accepts" alone is not the test: a schema the
 * Host builds AFTER our bridge captures OUR predicate and accepts `ssh://` while
 * the defect remains (production order: bridge in `apply()`, unit built on first
 * service touch). So the probe also needs proof the schema READS the binding at
 * call time (see `observePathBindingReads`); otherwise a load-bearing workaround
 * would retire itself and recommend its own deletion.
 *
 * The report does NOT go through `ctx.logger` (no console exporter here — INFO
 * lands in an unread ring buffer, see diagnostics.js). It is the `probe`/`detail`
 * pair, recorded by lib/index.js into the engine's bounded diagnostics log and
 * served by `ssh_workspace_status` (`upstream` event / `upstreamWorkarounds`).
 * A second signal: `tests/projection-real-smoke.mjs` asserts the defect
 * REPRODUCES, so it goes RED on the fixing release — that means "delete this",
 * not "regression".
 *
 * Nothing beyond `ssh://` is loosened: relative local paths still rejected,
 * `null` still passes, other schema members reachable via the prototype chain.
 * The binding probe — {@link observePathBindingReads} and its case builders —
 * lives at the bottom of this file, beside its only caller.
 *
 * @module @shiqyka/dsh-ssh-workspace/patch-projection
 */

import { isRemotePath } from '../core/protocol.js'

/**
 * Stable id for this workaround.
 *
 * Grep-able on purpose: it appears in this file's banner, in the lib/index.js
 * installation block, in docs/upstream-workarounds.md and in the CHANGELOG, so
 * `grep -rn UPSTREAM-1-working-directory-isAbsolute .` lists every place that
 * has to be touched when the workaround is deleted.
 */
export const WORKAROUND_ID = 'UPSTREAM-1-working-directory-isAbsolute'

/** Projection unit whose schema captured `path.isAbsolute` as a value. */
export const RELAXED_KEY = 'workingDirectory'

/**
 * Everything needed to judge, later, whether this workaround is still load-
 * bearing: where the defect lives, what the fix is, and what proves it landed.
 */
export const UPSTREAM_FIX = Object.freeze({
  id: WORKAROUND_ID,
  package: '@deepseek-ai/dsh-working-directory',
  file: 'lib/index.js',
  defect: 'const directorySchema = z$1.string().min(1).refine(isAbsolute).nullable()',
  fix: 'const directorySchema = z$1.string().min(1).refine((value) => isAbsolute(value)).nullable()',
  reason: 'refine(isAbsolute) captures the predicate as a VALUE; the plugin patches the ESM BINDING only',
  removeWhen: 'the registered schema accepts an ssh:// value on its own (this module then installs nothing)',
  runbook: 'docs/upstream-workarounds.md',
})

/**
 * Environment switch that disables every upstream workaround in this plugin.
 *
 * Exists so an operator can verify "is the workaround still needed?" against a
 * real deployment without editing code: set it, restart DSH, and open a stored
 * `ssh://` session. It loads → upstream is fixed and the workaround can be
 * deleted. It reports `历史加载失败` → the workaround is still load-bearing.
 *
 * @type {string}
 */
export const DISABLE_ENV = 'DSH_SSH_WORKSPACE_DISABLE_UPSTREAM_WORKAROUNDS'

/** Marks a schema this module already relaxed (idempotence). */
const RELAXED_SCHEMA = Symbol.for('dsh-ssh-workspace.projection.schema')

/** Holds the live installation on the registry it patched. */
const RELAXED_REGISTRY = Symbol.for('dsh-ssh-workspace.projection.registry')

/**
 * A value only a remote-aware schema accepts.
 *
 * Deliberately not a real host: the probe must never depend on which aliases
 * exist, only on the schema's spelling rule.
 */
const REMOTE_PROBE = 'ssh://upstream-probe/absolute/path'

/**
 * Whether the environment asks this plugin to skip its upstream workarounds.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] - the
 *   environment to read (defaults to `process.env`).
 * @returns {boolean} true when {@link DISABLE_ENV} holds a truthy spelling.
 */
export function workaroundsDisabled (env = process.env) {
  const raw = env?.[DISABLE_ENV]
  if (raw === undefined || raw === null) return false
  return /^(?:1|true|yes|on)$/iu.test(String(raw).trim())
}

/**
 * Whether a schema accepts a remote spelling on its own — the probe behind "is
 * the workaround still needed?": a fixed Host schema answers `true`, the
 * defective one throws (`Invalid input`).
 *
 * An accept is NOT proof: if this plugin patched `node:path.isAbsolute` before
 * the Host built its schema, the schema captured OUR predicate and accepts for
 * that reason. Callers deciding "is upstream fixed?" must use
 * {@link probeUpstream}; this answers only its narrow question.
 *
 * @returns {boolean} true when `parse(REMOTE_PROBE)` returned without throwing.
 */
export function acceptsRemotePath (schema) {
  if (schema === null || typeof schema !== 'object') return false
  if (typeof schema.parse !== 'function') return false
  try {
    schema.parse(REMOTE_PROBE)
    return true
  } catch {
    return false
  }
}

/**
 * Whether an accepting schema accepts because it READS the `isAbsolute` binding —
 * the discriminator the retirement signal needs over a plain accept-check:
 *
 * | acceptance | binding read | accepts w/o our patch | means |
 * | --- | --- | --- | --- |
 * | yes | yes | — | upstream reads binding → genuinely fixed |
 * | yes | no | yes | upstream spells the scheme out → genuinely fixed |
 * | yes | **no** | **no** | captured OUR predicate → defect still there |
 * | no | — | — | defect plainly still there |
 *
 * Row 3 used to be reported `fixed`. It is the production order here (bridge
 * installed from this plugin's `apply()`, `workingDirectory` unit built lazily),
 * so a naive accept-check retires a still-needed patch and its "delete it"
 * advice removes a load-bearing fix.
 *
 * Two proofs, because "reads the binding" alone would call a wholesale upstream
 * fix (one validating the scheme directly) broken; the safe direction is "still
 * broken" — keeping the workaround costs a pure superset of the original rule.
 *
 * @returns {boolean} true when the acceptance survives removing our patch.
 */
function acceptsByReadingBinding (schema) {
  let accepted = false
  const observed = observePathBindingReads(() => {
    try {
      accepted = schema.parse(REMOTE_PROBE) === REMOTE_PROBE
    } catch {
      accepted = false
    }
  })
  // No bridge to observe: nothing was patched in this process, so the
  // acceptance cannot be an artifact of our own patch.
  if (observed === undefined) return accepted
  return accepted && observed
}

/**
 * Whether this module (or a previous install of it) relaxed a schema.
 *
 * Used to tell "upstream fixed this" apart from "we already relaxed it": both
 * accept an `ssh://` value, and only the first means the workaround is obsolete.
 *
 * @returns {boolean} true when the relaxation marker is present.
 */
function isRelaxed (schema) {
  return schema !== null && typeof schema === 'object' && schema[RELAXED_SCHEMA] === true
}

/**
 * The outcomes of asking "is this workaround still load-bearing?".
 *
 * A CLOSED set of six, not a boolean, because "the Host still has the defect"
 * and "I could not look at the Host" are different facts that used to collapse
 * into the same `false`. That collapse is the failure mode worth designing
 * against: the plugin silently stopped patching, the Host silently changed
 * shape, and the symptom the workaround exists to prevent came back with no
 * signal anywhere. Every one of these states is now reported on its own.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PROBE = Object.freeze({
  /** The Host's own schema accepts an `ssh://` value: the workaround is obsolete. */
  fixed: 'fixed',
  /** The Host's schema still rejects it: the workaround is doing its job. */
  broken: 'broken',
  /** The unit has not registered yet — normal on a reload; `register` will catch it. */
  pending: 'pending',
  /** This plugin already relaxed the schema in another context of this process. */
  already: 'already',
  /** The registry does not look the way this probe needs. It CANNOT judge. */
  unprobeable: 'unprobeable',
  /** The operator asked for the workarounds to be skipped. */
  disabled: 'disabled',
})

/**
 * Wrap one schema so a remote spelling validates without losing the original
 * rule for local paths.
 *
 * Returns the input unchanged — no wrapper at all — when the schema already
 * accepts an `ssh://` value on its own. That is the self-retiring path: after an
 * upstream fix there is nothing to relax, and the caller reports it.
 *
 * The wrapper inherits from the original schema, so anything the Host reads off
 * it (`_def`, refinements, `instanceof` checks) is still there; only `parse` is
 * replaced. The original `parse` keeps its own receiver, so its internals — and
 * any `this`-dependent behaviour — resolve exactly as before.
 *
 * @returns {object | undefined | null} the relaxed schema, or the input unchanged
 *   when it is already relaxed, absent, not a parser, or already remote-aware.
 */
export function relaxSchema (schema) {
  if (schema === undefined || schema === null) return schema
  if (schema[RELAXED_SCHEMA] === true) return schema
  if (typeof schema.parse !== 'function') return schema
  // Upstream genuinely reads the binding at call time: leave it alone.
  //
  // "It accepts an ssh:// value" is NOT the same test. A schema the Host built
  // after this plugin patched `node:path` captured OUR predicate and accepts
  // the probe for that reason, so skipping on acceptance alone would leave the
  // workaround inert and make the whole thing depend on load order. The
  // relaxation is a pure superset of the original rule, so wrapping a captured
  // schema is harmless even when it was already accepting.
  if (acceptsRemotePath(schema) && acceptsByReadingBinding(schema)) return schema
  const relaxed = Object.create(schema)
  Object.defineProperty(relaxed, RELAXED_SCHEMA, { value: true, enumerable: false })
  Object.defineProperty(relaxed, 'parse', {
    value: function parse (value) {
      // The same predicate fs-shim.js patches `path.isAbsolute` with, so both
      // halves of the plugin agree on what "absolute" means for a remote target.
      if (isRemotePath(value)) return value
      return schema.parse(value)
    },
    writable: true,
    configurable: true,
    enumerable: false,
  })
  return relaxed
}

/**
 * Copy one projection definition with its two schemas relaxed.
 *
 * Returns the definition object itself when nothing had to change — the case
 * that matters after an upstream fix, so a registration is passed through
 * byte-identically rather than cloned for no reason.
 *
 * @returns {object} the definition, relaxed when it is the directory unit and
 *   its schemas still capture the predicate.
 */
export function relaxDefinition (definition) {
  if (definition === null || typeof definition !== 'object') return definition
  if (definition.key !== RELAXED_KEY) return definition
  const wire = definition.wire
  const hasWire = wire !== null && typeof wire === 'object'
  const stateSchema = relaxSchema(definition.stateSchema)
  const viewSchema = hasWire ? relaxSchema(wire.viewSchema) : undefined
  const stateChanged = stateSchema !== definition.stateSchema
  const wireChanged = hasWire && viewSchema !== wire.viewSchema
  if (!stateChanged && !wireChanged) return definition
  return {
    ...definition,
    stateSchema,
    wire: hasWire ? { ...wire, viewSchema } : wire,
  }
}

/**
 * The registered definition of the directory unit, when the registry exposes it.
 *
 * `registrations` is a Map of `{ def, cells, refs }` on the Host's
 * `SessionProjectionRegistry`; `def` is the erased copy every read path parses
 * through.
 *
 * @returns {object | undefined} the definition, or undefined when not found.
 */
function registeredDefinition (registry) {
  const table = registry?.registrations
  if (!(table instanceof Map)) return undefined
  const def = table.get(RELAXED_KEY)?.def
  return def !== null && typeof def === 'object' ? def : undefined
}

/**
 * Judge what the Host looks like right now, without touching it.
 *
 * Separated from {@link installProjectionRelaxation} on purpose: the judgement
 * must be reportable even when it says "I cannot tell", which is exactly the
 * case that used to be indistinguishable from "the defect is still there".
 *
 * @returns {{state: string, detail: string}} the probe result and a short
 *   human-readable reason, suitable for a log line or a status field.
 */
export function probeUpstream (registry) {
  const table = registry?.registrations
  if (!(table instanceof Map)) {
    return {
      state: PROBE.unprobeable,
      detail: 'the projection registry exposes no `registrations` Map, so the workingDirectory schema cannot be inspected',
    }
  }
  const def = registeredDefinition(registry)
  if (def === undefined) {
    return {
      state: PROBE.pending,
      detail: 'the workingDirectory unit is not registered yet; the register wrapper will relax it on arrival',
    }
  }
  const wire = def.wire
  const candidates = [def.stateSchema, wire !== null && typeof wire === 'object' ? wire.viewSchema : undefined]
    .filter(schema => schema !== undefined && schema !== null)
  if (candidates.length === 0) {
    return {
      state: PROBE.unprobeable,
      detail: 'the registered workingDirectory unit carries neither a stateSchema nor a viewSchema',
    }
  }
  // Ours, not upstream's: a schema this module relaxed also accepts the probe,
  // so it must be recognised before the accept-check can mean anything.
  if (candidates.some(isRelaxed)) {
    return { state: PROBE.already, detail: 'this process already relaxed the workingDirectory schema' }
  }
  // Acceptance alone is NOT the retirement signal: a schema the Host built
  // AFTER this plugin patched `node:path` captured OUR predicate, so it accepts
  // `ssh://` while the defect is intact. Only a schema that READS the binding
  // at call time is genuinely fixed — see acceptsByReadingBinding().
  if (candidates.every(schema => acceptsRemotePath(schema) && acceptsByReadingBinding(schema))) {
    return {
      state: PROBE.fixed,
      detail: 'the Host\'s own workingDirectory schema accepts an ssh:// value and reads the isAbsolute binding at call time',
    }
  }
  const stillCaptured = candidates.filter(schema => acceptsRemotePath(schema)).length
  if (stillCaptured > 0) {
    return {
      state: PROBE.broken,
      detail: 'the workingDirectory schema accepts an ssh:// value only because it captured this plugin\'s patched isAbsolute; it still holds the predicate as a value, so the defect remains',
    }
  }
  return {
    state: PROBE.broken,
    detail: 'the Host\'s workingDirectory schema still rejects an ssh:// value',
  }
}

/**
 * Relax the already-registered unit in place, if the registry exposes its table.
 *
 * The definition object is the registry's own erased copy (`def`), and every
 * read path parses through `def.stateSchema` / `def.wire.viewSchema`, so
 * replacing those two members covers `restore`, `viewCheckpoint`, `snapshot`,
 * `cachedSnapshot`, `hydrate`, and the change feed at once.
 *
 * @returns {boolean} whether a registered unit was found.
 */
function relaxRegistered (registry) {
  const def = registeredDefinition(registry)
  if (def === undefined) return false
  const stateSchema = relaxSchema(def.stateSchema)
  if (stateSchema !== def.stateSchema) def.stateSchema = stateSchema
  const wire = def.wire
  if (wire !== null && typeof wire === 'object') {
    const viewSchema = relaxSchema(wire.viewSchema)
    if (viewSchema !== wire.viewSchema) wire.viewSchema = viewSchema
  }
  return true
}

/**
 * Install the relaxation on the live projection registry.
 *
 * The installation always carries `probe` ({@link PROBE}) + a readable `detail` —
 * the honest and ONLY answer to "is this workaround still needed?": a
 * `logger.info` line reaches a ring buffer nothing reads (diagnostics.js), so no
 * log line is mistaken for a notification. Callers must surface `probe`/`detail`
 * through a reachable channel; the engine records them in its bounded log.
 *
 * Outcomes by `probe`:
 * - `fixed` — Host schema already accepts `ssh://`: NOTHING patched, obsolete.
 * - `broken` — production order: unit registered before this plugin, relaxed in
 *   place (`relaxedInPlace`).
 * - `pending` — unit not registered yet; `register` wrapped to relax on arrival.
 * - `unprobeable` — registry lacks the probe's shape; the `register` wrapper is
 *   still installed (free, covers later arrival) but the caller MUST report: a
 *   silent `unprobeable` means a Host reshape disables the workaround with no
 *   symptom until a user cannot open a stored ssh:// session.
 * - `already` / `disabled` — another install, or the operator switch; no patch.
 *
 * Idempotent per process: a second call returns the existing installation.
 *
 * @param {object} [options.logger] - a Cordis logger, when available (best-effort
 *   only; see the note above about its reachability).
 * @param {Record<string, string | undefined>} [options.env] - environment to
 *   read {@link DISABLE_ENV} from (defaults to `process.env`).
 * @returns {{id: string, enabled: boolean, relaxedInPlace: boolean,
 *   upstreamFixed: boolean, probe: string, detail: string,
 *   dispose: () => void} | undefined} the installation, or undefined when no
 *   projection registry is mounted.
 */
export function installProjectionRelaxation (ctx, { logger, env = process.env } = {}) {
  const registry = ctx?.get?.('sessionProjections') ?? ctx?.sessionProjections
  if (registry === undefined || registry === null) return undefined
  const existing = registry[RELAXED_REGISTRY]
  if (existing !== undefined) return existing

  const installed = {
    id: WORKAROUND_ID,
    enabled: false,
    relaxedInPlace: false,
    upstreamFixed: false,
    probe: PROBE.disabled,
    detail: '',
    dispose: () => {},
  }

  Object.defineProperty(registry, RELAXED_REGISTRY, {
    value: installed,
    writable: false,
    configurable: true,
    enumerable: false,
  })

  if (workaroundsDisabled(env)) {
    installed.probe = PROBE.disabled
    installed.detail = `skipped by ${DISABLE_ENV}`
    logger?.warn?.(`ssh-workspace: ${WORKAROUND_ID} is disabled by ${DISABLE_ENV}; a stored ssh:// session will fail to load its history`)
    return installed
  }

  installed.enabled = true

  // Judge first, patch second. Retiring before patching matters: once the schema
  // is relaxed a re-probe would see OUR value, so the judgement is only
  // meaningful on the untouched Host object.
  const judged = probeUpstream(registry)
  installed.probe = judged.state
  installed.detail = judged.detail

  if (judged.state === PROBE.fixed) {
    installed.upstreamFixed = true
    logger?.info?.(`ssh-workspace: ${WORKAROUND_ID} is no longer needed — ${judged.detail}, so nothing was patched; this workaround can be deleted (see ${UPSTREAM_FIX.runbook})`)
    return installed
  }

  installed.relaxedInPlace = relaxRegistered(registry)

  const originalRegister = registry.register
  if (typeof originalRegister === 'function') {
    const wrapped = function register (definition) {
      return originalRegister.call(this, relaxDefinition(definition))
    }
    Object.defineProperty(registry, 'register', {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    installed.dispose = () => {
      if (registry.register === wrapped) delete registry.register
    }
  }

  if (judged.state === PROBE.unprobeable) {
    // The worst state to leave silent: nothing was relaxed AND the reason the
    // probe failed is invisible from the outside. A WARN is emitted for anyone
    // who does have a console, but the caller is expected to surface
    // `probe`/`detail` through the reachable channel; an unprobeable Host plus a
    // stored ssh:// session now reproduces the original bug.
    logger?.warn?.(`ssh-workspace: ${WORKAROUND_ID} could not judge this Host (${judged.detail}); the relaxation was installed as a precaution, but re-check it after the next DSH upgrade`)
  } else if (installed.relaxedInPlace) {
    logger?.info?.(`ssh-workspace: relaxed the ${RELAXED_KEY} projection schema so an ssh:// cwd validates (${WORKAROUND_ID})`)
  } else if (typeof originalRegister === 'function') {
    // Not a failure: the unit may simply not be mounted yet, and the register
    // wrapper above still catches it whenever it arrives.
    logger?.debug?.(`ssh-workspace: ${RELAXED_KEY} is not registered yet; its schema will be relaxed when it is`)
  }
  return installed
}

/**
 * Undo {@link installProjectionRelaxation}.
 *
 * The relaxed schemas themselves are left in place: they are a pure superset of
 * the original rule, so restoring the stricter parser would re-break a session
 * that is already open. Only the `register` wrapper is removed.
 *
 */
export function uninstallProjectionRelaxation (ctx) {
  const registry = ctx?.get?.('sessionProjections') ?? ctx?.sessionProjections
  const installed = registry?.[RELAXED_REGISTRY]
  if (installed === undefined) return
  installed.dispose()
  delete registry[RELAXED_REGISTRY]
}

// ---------------------------------------------------------------------------
// Reading the binding: the retirement probe's instrument
// ---------------------------------------------------------------------------
//
// The predicates below are the retirement probe's other half — the part that
// answers "does this schema READ `isAbsolute`, or did it capture our patched
// predicate as a value?" — and they have one caller, this module.
//
// They stay dependency-free: importing `fs-shim.js` (the module that INSTALLS
// the bridge) would pull in `remote-fs.js` and the peer resolution behind it,
// which a probe must not need. That is why the state is read off a global
// symbol rather than from the installer.

/**
 * Process-wide bridge state, so a reload rebinds instead of double-patching.
 *
 * Shared with fs-shim.js, which installs the state under this key.
 */
export const BRIDGE = Symbol.for('dsh-ssh-workspace.fs-shim')

/**
 * Run `run` with `node:path.isAbsolute` instrumented, reporting whether it was
 * read through the module binding during the call.
 *
 * @param {() => void} run - the probe body; must be synchronous.
 * @returns {boolean | undefined} true when the binding was read, false when a
 *   bridge exists and it was not, undefined when no bridge is installed (in
 *   which case nothing was ever patched, so an acceptance cannot be its doing).
 */
export function observePathBindingReads (run) {
  const state = globalThis[BRIDGE]
  const patches = state === undefined ? [] : (Array.isArray(state.pathPatches) ? state.pathPatches : [])
  let observed = false
  const restore = []
  for (const entry of patches) {
    const surface = entry.surface
    if (surface === undefined || surface === null) continue
    const current = surface.isAbsolute
    if (typeof current !== 'function') continue
    restore.push({ surface, current })
    surface.isAbsolute = function isAbsolute (candidate) {
      observed = true
      return current(candidate)
    }
  }
  // No observable patch: still run the probe (its answer is the caller's whole
  // point) and report `undefined` — "nobody patched anything here", which is a
  // different fact from "it accepted without reading the binding".
  if (restore.length === 0) {
    run()
    return undefined
  }
  try {
    if (typeof state.republish === 'function') state.republish()
    run()
  } finally {
    for (const { surface, current } of restore) surface.isAbsolute = current
    if (typeof state.republish === 'function') state.republish()
  }
  return observed
}

/**
 * Run `run` with this bridge's `isAbsolute` patches REMOVED.
 *
 * Answers a different question than {@link observePathBindingReads}: not "did
 * it read the binding?" but "would it still accept if we had never patched
 * anything?". A schema with its own scheme rule (an upstream that fixed the bug
 * by spelling `ssh://` out instead of reading the binding) answers yes; one that
 * merely captured our patched predicate answers no.
 *
 * @param {() => void} run - the probe body; must be synchronous.
 */
export function withOriginalPathBindings (run) {
  const state = globalThis[BRIDGE]
  const patches = state === undefined ? [] : (Array.isArray(state.pathPatches) ? state.pathPatches : [])
  const restore = []
  for (const entry of patches) {
    const surface = entry.surface
    if (surface === undefined || surface === null) continue
    if (typeof entry.isAbsolute !== 'function') continue
    restore.push({ surface, patched: surface.isAbsolute })
    surface.isAbsolute = entry.isAbsolute
  }
  try {
    if (typeof state?.republish === 'function') state.republish()
    run()
  } finally {
    for (const { surface, patched } of restore) surface.isAbsolute = patched
    if (typeof state?.republish === 'function') state.republish()
  }
}

/**
 * Whether an accepting parser would still accept with this bridge removed.
 *
 * @param {object} schema - a parser that already accepts the remote probe.
 * @returns {boolean} true when the acceptance does not depend on our patch.
 */
export function acceptsWithoutOurPatch (schema, remoteProbe) {
  let accepted = false
  withOriginalPathBindings(() => {
    try {
      accepted = schema.parse(remoteProbe) === remoteProbe
    } catch {
      accepted = false
    }
  })
  return accepted
}
