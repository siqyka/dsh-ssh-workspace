/**
 * Status provenance: which parts of a status payload are LIVE, which are cached,
 * and which are the last thing that succeeded.
 *
 * ## The problem this names
 *
 * The panel polls `/status`, and that one reply mixes facts of three different
 * ages: the connection list is read from the pool at request time, the
 * capability probe is a cached result that may be hours old, and the scrollback
 * of events is history by definition. Rendering all three the same way tells the
 * user, implicitly and wrongly, that they were observed together — and "it says
 * connected but the tree is empty" is exactly the kind of contradiction that
 * makes someone stop trusting the whole panel.
 *
 * ## Why provenance is computed here and not in the browser
 *
 * The age of a cached probe is known only where the cache lives. A client that
 * tried to infer "this is stale" from a timestamp would be guessing at TTLs it
 * does not own, and the two would drift the first time a TTL changed. So every
 * fact travels with its own `{kind, at}` label and the panel only RENDERS it.
 *
 * ## The three kinds
 *
 *  - `live` — read from the running system while answering this request.
 *  - `cached` — a stored result, with the time it was STORED (not the time it
 *    was served).
 *  - `stale` — a cached result that could not be refreshed: the last thing that
 *    worked, which is still worth showing as long as it is labelled as such.
 *
 * A field with no label at all is a bug in this module, not a field that is
 * "probably fine" — the panel's job is to never show an unlabelled age.
 *
 * @module @shiqyka/dsh-ssh-workspace/status-provenance
 */

/** The vocabulary, frozen so a typo cannot become a fourth kind. */
export const PROVENANCE = Object.freeze({
  live: 'live',
  cached: 'cached',
  stale: 'stale',
})

/**
 * A provenance label.
 *
 * @param {'live'|'cached'|'stale'} kind - how the value was obtained.
 * @param {number} [at] - when the VALUE was read (for cached/stale), or when it
 *   was served (for live).
 * @returns {{kind: string, at: number}} the label.
 */
export function provenance (kind, at) {
  const when = typeof at === 'number' && Number.isFinite(at) ? at : Date.now()
  if (kind !== PROVENANCE.live && kind !== PROVENANCE.cached && kind !== PROVENANCE.stale) {
    throw new Error(`unknown provenance kind ${JSON.stringify(kind)}`)
  }
  return { kind, at: when }
}

/**
 * How many milliseconds a provenance label describes.
 *
 * Negative ages are clamped to zero: clock skew between a cached timestamp and
 * `now` must not render as "in the future", which reads as a bug in the panel
 * rather than as a fact about the value.
 *
 * @param {{kind: string, at: number}} label - the label.
 * @param {number} [now] - current time (tests).
 * @returns {number} age in milliseconds.
 */
export function ageOf (label, now) {
  const current = typeof now === 'number' ? now : Date.now()
  const at = typeof label?.at === 'number' ? label.at : current
  return Math.max(0, current - at)
}

/**
 * The provenance for a capability probe that may predate this request.
 *
 * `probeCapabilities` caches per host and is only refreshed on demand, so a
 * status reply routinely contains verdicts from before the user installed `rg`
 * on the host. Reporting that as `live` is the specific lie this module exists
 * to prevent.
 *
 * @param {{at?: number}|undefined} cached - the engine's cached probe, if any.
 * @returns {{kind: string, at: number}} the label.
 */
export function probeProvenance (cached) {
  if (cached === undefined || cached === null || typeof cached.at !== 'number') {
    // Never probed: there is no value to describe, and saying `stale` would
    // imply one was once obtained.
    return provenance(PROVENANCE.live)
  }
  return provenance(PROVENANCE.cached, cached.at)
}

/**
 * The provenance for a fact that was observed but could not be refreshed.
 *
 * The distinction from `cached` is not cosmetic: a cached value is one the
 * system believes; a stale one is a value the system FAILED to update. The panel
 * renders them differently because the user's next action differs — wait versus
 * investigate.
 *
 * @param {number} at - when the old value was read.
 * @returns {{kind: string, at: number}} the label.
 */
export function staleProvenance (at) {
  return provenance(PROVENANCE.stale, at)
}

/**
 * Attach provenance to a whole status payload.
 *
 * A single place that decides the age of each section, rather than each route
 * inventing its own — two routes disagreeing about whether a probe is live is
 * how a user learns that the labels mean nothing.
 *
 * @param {object} options - the inputs.
 * @param {number} [options.now] - request time (tests).
 * @param {object} [options.probe] - `{at}` for the capability cache, per alias.
 * @param {boolean} [options.probeFailed] - the probe could not run this time.
 * @returns {{sections: Record<string, {kind: string, at: number}>}} the labels.
 */
export function statusProvenance (options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const probeAt = options.probe?.at
  const sections = {
    // Read from the pool while answering: genuinely live.
    connections: provenance(PROVENANCE.live, now),
    forwards: provenance(PROVENANCE.live, now),
    shells: provenance(PROVENANCE.live, now),
    // The probe is a cache, and a failed refresh means the last good value is
    // being shown rather than a fresh one.
    capabilities: options.probeFailed === true && typeof probeAt === 'number'
      ? staleProvenance(probeAt)
      : probeProvenance(typeof probeAt === 'number' ? { at: probeAt } : undefined),
    // History by construction; its age is the age of its newest entry.
    events: provenance(PROVENANCE.live, now),
  }
  return { sections }
}
