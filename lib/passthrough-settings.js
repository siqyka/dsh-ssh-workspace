/**
 * The two editable local-passthrough settings.
 *
 * There are exactly two knobs: the scheme name that spells a host path inside
 * an `ssh://` session (`local:` by default), and whether a bare `@`-mentioned
 * POSIX path may fall back to the host copy after the remote side says it does
 * not exist.
 *
 * One source of truth, three consumers: the panel writes here, this class
 * validates and persists, and the live matcher (`passthrough.js`) is the object
 * every filesystem seam already holds. Because the seams read the matcher (not a
 * copied value), applying a change here is live — no reinstall, no restart.
 *
 * The store is the runtime truth and plugin configuration is only the FIRST
 * default. That distinction is why `scheme: undefined` survives in the store
 * section: "the user chose the default" and "the user has never chosen" must
 * not collapse, or upgrading the configured default would silently un-change a
 * user's explicit choice.
 *
 * @module @shiqyka/dsh-ssh-workspace/passthrough-settings
 */

import { DEFAULT_LOCAL_SCHEME, normalizeScheme, schemeRefusal } from './passthrough.js'

/**
 * A refusal the panel can show, carrying the code the route maps to a status.
 *
 * @param {string} message - the user-facing explanation.
 * @returns {Error} the error to throw.
 */
function settingsError (message) {
  return Object.assign(new Error(message), { code: 'STORE_INVALID' })
}

/**
 * Controller for the saved local-passthrough settings.
 */
export class PassthroughSettings {
  /**
   * @param {object} options - controller options.
   * @param {import('./store.js').HostConfigStore} options.store - the editable store.
   * @param {object} options.matcher - the live matcher from `buildPassthrough`.
   * @param {object} [options.defaults] - the values to use until the panel saves.
   * @param {string} [options.defaults.scheme] - the configured default scheme.
   * @param {boolean} [options.defaults.remoteMissFallback] - the configured default flag.
   * @param {object} [options.logger] - Cordis logger, when available.
   */
  constructor (options) {
    this.store = options.store
    this.matcher = options.matcher
    this.logger = options.logger
    this.defaults = {
      scheme: normalizeScheme(options.defaults?.scheme) ?? DEFAULT_LOCAL_SCHEME,
      remoteMissFallback: options.defaults?.remoteMissFallback === true,
    }
  }

  /**
   * The settings in force, as the panel should render them.
   *
   * A store that cannot be read degrades to the configured defaults rather
   * than throwing: the panel would otherwise lose the whole status view over a
   * damaged optional section.
   *
   * @returns {{scheme: string, remoteMissFallback: boolean, enabled: boolean}} the settings.
   */
  settings () {
    let stored
    try {
      stored = this.store.passthroughSettings()
    } catch (error) {
      this.logger?.warn?.(`ssh-workspace: could not read the local-passthrough settings: ${error instanceof Error ? error.message : String(error)}`)
      stored = { scheme: undefined, remoteMissFallback: undefined }
    }
    return {
      scheme: normalizeScheme(stored.scheme) ?? this.matcher?.scheme ?? this.defaults.scheme,
      remoteMissFallback: stored.remoteMissFallback ?? this.matcher?.remoteMissFallback ?? this.defaults.remoteMissFallback,
      enabled: this.matcher?.enabled === true,
    }
  }

  /**
   * Apply the settings back to the live matcher at activation time.
   *
   * Called once per plugin activation, BEFORE any seam is installed, so the
   * first filesystem call already sees the saved values rather than the
   * configured ones.
   *
   * @returns {{scheme: string, remoteMissFallback: boolean, enabled: boolean}} the applied settings.
   */
  activate () {
    const current = this.settings()
    this.matcher?.configure?.({ scheme: current.scheme, remoteMissFallback: current.remoteMissFallback })
    // A value saved by an older build — or edited by hand — may no longer be
    // legal. It is degraded (the matcher keeps the last usable name) but never
    // silently: the log line and the status field both carry the stored value
    // and the one actually in force, so "my prefix stopped working" has a
    // findable cause.
    const stale = this.warning()
    if (stale !== null) {
      this.logger?.warn?.(`ssh-workspace: the saved local scheme ${JSON.stringify(stale.stored)} is not usable (${stale.code}); "${stale.effective}:" is in force until it is saved again`)
    }
    return current
  }

  /**
   * The saved-but-unusable value, when there is one.
   *
   * Reading never rewrites the store: the user's file is theirs, and a
   * downgrade that fixes itself on the next read would hide the very change the
   * user needs to confirm. Only a save writes through, which is why the panel
   * asks for one.
   *
   * @returns {{stored: string, effective: string, code: string, message: string} | null} the warning.
   */
  warning () {
    let stored
    try {
      stored = this.store.passthroughSettings()
    } catch {
      return null
    }
    const name = stored.scheme
    // No stored value means nothing was chosen; a usable one means nothing is
    // wrong. `passthroughOf` has already dropped non-strings, so a string here
    // is the only shape that can be stale.
    if (typeof name !== 'string') return null
    if (normalizeScheme(name) !== undefined) return null
    const refusal = schemeRefusal(name)
    return {
      stored: name,
      effective: this.matcher?.scheme ?? this.defaults.scheme,
      code: refusal.ok ? 'unusable' : refusal.code,
      message: refusal.ok ? 'the saved prefix is no longer usable' : refusal.message,
    }
  }

  /**
   * Validate, persist, then apply.
   *
   * The order is deliberate: an invalid scheme is refused before anything is
   * written, and a write that fails leaves the live matcher untouched — so the
   * panel can never show a value the seams are not actually using.
   *
   * @param {{scheme?: unknown, remoteMissFallback?: unknown}} patch - the requested values.
   * @returns {{scheme: string, remoteMissFallback: boolean, enabled: boolean}} the applied settings.
   * @throws {Error} with code STORE_INVALID when the scheme is not usable.
   */
  apply (patch = {}) {
    const next = {}
    if (patch?.scheme !== undefined) {
      // The refusal text is the one the panel would have shown, generated from
      // the same tables `schemeRules` publishes to it: length, reserved names and
      // syntax are described once, in passthrough.js.
      const refusal = schemeRefusal(patch.scheme)
      if (!refusal.ok) {
        throw settingsError(`"${typeof patch.scheme === 'string' ? patch.scheme.trim() : String(patch.scheme)}" is not a usable local scheme: ${refusal.message}`)
      }
      next.scheme = refusal.scheme
    }
    if (patch?.remoteMissFallback !== undefined) next.remoteMissFallback = patch.remoteMissFallback === true
    if (Object.keys(next).length === 0) return this.settings()
    this.store.setPassthroughSettings(next)
    const applied = this.matcher?.configure?.(next) ?? { scheme: this.defaults.scheme, remoteMissFallback: this.defaults.remoteMissFallback }
    return { ...applied, enabled: this.matcher?.enabled === true }
  }
}
