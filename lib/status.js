/**
 * The `ssh_workspace_status` tool's three halves, and the labels they share.
 *
 * ## Why these are one file
 *
 * The status answer is a contract, a rendering, and a set of honesty labels:
 *
 *  - {@link STATUS_OUTPUT_SCHEMA} — 375 lines of shape and no behaviour: every
 *    branch of the reply is described here and none of it is executed;
 *  - {@link renderStatus} — the wording, which is part of the contract: the
 *    panel and this renderer answer the same question, and a second phrasing of
 *    "is anything wrong?" is exactly the drift these files exist to prevent;
 *  - {@link statusProvenance} — which parts of that reply are live, which are
 *    cached, and which are the last thing that succeeded.
 *
 * They were four files (`status-schema`, `status-render`, `status-provenance`,
 * `tool-result`), each split out of the tool definition for a good reason: the
 * tool itself was becoming a 600-line function. But the split ended at the tool,
 * and what was left were four files that only ever change together — add a field
 * to the schema and you must render it and label it, or the answer is wrong in
 * one of three places. A field with no provenance label is a bug, not a field
 * that is "probably fine"; it is much easier to notice that when the schema, the
 * sentence and the label are within a screen of each other.
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
 * The problem this vocabulary names: `/status` mixes facts of three different
 * ages — the connection list is read from the pool at request time, the
 * capability probe is a cached result, the event scrollback is history by
 * definition. Rendering all three the same way tells the user, implicitly and
 * wrongly, that they were observed together, and "it says connected but the tree
 * is empty" is exactly the contradiction that makes someone stop trusting the
 * whole panel.
 *
 * @module @shiqyka/dsh-ssh-workspace/status
 */

// ---------------------------------------------------------------------------
// The shape: what `ssh_workspace_status` promises to return
// ---------------------------------------------------------------------------
/** What `ssh_workspace_status` promises to return. */
export const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mounted: { type: 'array', required: true, items: { type: 'string' } },
    disabled: { type: 'array', required: true, items: { type: 'string' } },
    connections: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string', required: true },
          state: { type: 'string', required: true },
          inFlight: { type: 'integer', required: true },
          generation: { type: 'integer', description: 'How many times this alias has connected in this session. A value above 1 means the transport died underneath at least one earlier operation.' },
          generationNote: { type: 'string', description: 'One sentence about continuity: what a generation above 1 means for work started earlier.' },
        },
      },
    },
    // Hosts the background loop is working on: a dropped connection that
    // nobody is currently operating on still recovers, and this is how a
    // reader learns it is in progress rather than dead. Present only when
    // there is something to report, so the common reply stays short.
    reconnecting: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          attempts: { type: 'integer', required: true },
          nextAt: { type: 'integer', required: true },
          lastError: { type: 'string', required: true },
          reason: { type: 'string', required: true },
        },
      },
    },
    forwards: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          alias: { type: 'string', required: true },
          localHost: { type: 'string', required: true },
          localPort: { type: 'integer', required: true },
          remoteHost: { type: 'string', required: true },
          remotePort: { type: 'integer', required: true },
          connections: { type: 'integer', required: true },
        },
      },
    },
    // Tunnels whose listener lives on the REMOTE host. Kept separate from
    // `forwards` rather than merged: the direction is the first thing a
    // reader needs, and one list with a flag field would make the common
    // local case carry a discriminator nobody reads.
    reverseForwards: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          alias: { type: 'string', required: true },
          localHost: { type: 'string', required: true },
          localPort: { type: 'integer', required: true },
          remoteHost: { type: 'string', required: true },
          remotePort: { type: 'integer', required: true },
          requestedRemotePort: { type: 'integer', required: true },
          exposed: { type: 'boolean', required: true },
          connections: { type: 'integer', required: true },
        },
      },
    },
    fsPatched: { type: 'boolean', required: true },
    shells: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string', required: true },
          session: { type: 'string', required: true },
          alive: { type: 'boolean', required: true },
          // The directory the session was STARTED in, not its current one:
          // the remote shell's cwd is not observable from here (see
          // shell.js). Declared so a caller that must know which tree a
          // session belongs to can see it instead of inferring from the
          // session name; `reopens` says whether this session has been
          // re-established, which changes what its state means.
          startedIn: { type: 'string', description: 'The remote directory the session was started in. Not its current directory, which is not observable.' },
          reopens: { type: 'integer', description: 'How many times this session had to be re-established after a dropped connection.' },
        },
      },
    },
    // Recent connection / watcher events, newest last. Present so a
    // failure can be explained without a log file: the Host exposes no
    // console exporter, so this is the only reachable history.
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // The monotonic event number. Declared because it is what makes
          // a ring buffer readable: the ring DROPS old entries, so without
          // `seq` two consecutive entries can look adjacent when a gap
          // means "the log lost something", and an outage can be neither
          // ordered nor identified. The producer (`diagnostics.js`) has
          // always emitted it; the schema simply never said so, and the
          // Host rejected the whole result for it.
          seq: { type: 'integer' },
          at: { type: 'integer', required: true },
          kind: { type: 'string', required: true },
          message: { type: 'string', required: true },
          alias: { type: 'string' },
        },
      },
    },
    // Upstream workarounds this process judged, one entry each. A separate
    // field rather than an event because the question it answers — "can
    // any of our patches be deleted now?" — must be answerable at a glance
    // on any startup, not only by whoever saw the event scroll by.
    upstreamWorkarounds: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          probe: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
    },
    // The other half of the same question, and a separate field for the
    // same reason: "has the Host moved on?" and "did my takeover land?"
    // produce identical quiet startups, so a reader needs both to tell a
    // clean deployment from a wrapper that never installed.
    seams: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          state: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
    },
    // The last session-ownership re-claim, as the in-memory snapshot the
    // status surfaces read. Present only when the compensation ran; a
    // status call must not LIST persisted sessions to answer this — a poll
    // that turned into disk traffic would make "how are things?" expensive
    // and observable, which is the rule this repository keeps for every
    // read path.
    // Remote skill discovery, as the provider sees it. Present ONLY when a
    // provider is registered: an absent field means the deployment has no
    // `skills` registry (a headless composition), which must not read as
    // "the feature is off" — that is `enabled: false` with an empty host
    // list. The two answers lead to different actions.
    remoteSkills: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', required: true },
        hosts: { type: 'array', required: true, items: { type: 'string' }, description: 'Allowlisted aliases. Empty while `enabled` is true means every lookup answers zero skills.' },
        last: {
          type: 'object',
          additionalProperties: false,
          description: 'The most recent completed pass. Absent until the first lookup, which is not the same as a pass that found nothing.',
          properties: {
            alias: { type: 'string', required: true },
            at: { type: 'integer', required: true },
            skills: { type: 'integer', required: true },
            skipped: { type: 'integer', required: true },
            complete: { type: 'boolean', required: true, description: 'False when a root or the deadline cut the pass short: the catalog keeps its previous contents rather than shrinking.' },
          },
        },
      },
    },
    ownership: {
      type: 'object',
      additionalProperties: false,
      properties: {
        at: { type: 'integer', required: true },
        updatedAt: {
          type: 'integer',
          required: true,
          description: 'When `stage` last changed: a stuck pass reads as its last stage instead of as a missing field.',
        },
        stage: {
          type: 'string',
          required: true,
          description: 'Where the pass is (`listing`, `rebuilding`, `claiming`, `done`). Every await in it is bounded, so a stage that never advances is a hang worth reporting rather than a silent nothing.',
        },
        scanned: { type: 'integer', required: true },
        reclaimed: { type: 'integer', required: true },
        pending: { type: 'integer', required: true, description: 'Sessions that still are not attached to their remote workspace, so they stay hidden from the sidebar.' },
        indexRebuilt: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          required: true,
          description: 'What the one-shot Host session-index rebuild answered (`reindexed`, `unsupported`, `empty`, `failed: …`), `skipped` when no session was missing so no re-index was needed, or null when the pass did not get that far.',
        },
        skipped: { type: 'array', required: true, items: { type: 'string' }, description: 'Detached remote workspaces: their sessions were NOT checked because the user turned the workspace off.' },
        published: {
          type: 'integer',
          required: true,
          description: 'Workspaces whose repaired membership was announced to connected clients, so their sessions appear without a page reload.',
        },
        publishError: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          required: true,
          description: 'Why the announcement failed, or null when it ran (or no rebuild made one necessary).',
        },
        degraded: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          required: true,
          description: 'Why the check could not run, or null when it did. With a reason, `pending` is 0 because the true number is unknown.',
        },
        failures: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              reason: { type: 'string', required: true },
            },
          },
        },
      },
    },
    // The exported event shape's version, and a redacted text form a
    // user can paste into a bug report. Both are additive: a reader that
    // ignores them keeps working, which is why they did not bump the
    // schema version.
    // The verdict behind the panel's status dot: `ok` / `warn` / `unknown`
    // plus one row per finding. Same module the report and `/status` use,
    // so an agent, the panel and a pasted report cannot tell three stories.
    diagnosis: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        version: { type: 'integer', required: true },
        state: { type: 'string', required: true, enum: ['ok', 'warn', 'unknown'] },
        warn: { type: 'integer', required: true },
        unknown: { type: 'integer', required: true },
        findings: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              state: { type: 'string', required: true, enum: ['warn', 'unknown'] },
              alias: { type: 'string' },
              detail: { type: 'string', required: true },
            },
          },
        },
        // The self-check, as advisory rows. Same shape, deliberately NOT
        // counted into `state` / `warn` / `unknown`: a host missing an
        // optional tool still works, and a dot that goes red for that is
        // a dot nobody reads.
        notes: {
          type: 'array',
          required: true,
          description: 'Advisory self-check rows (missing optional tools, environment warnings). Never counted into state, warn or unknown.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              state: { type: 'string', required: true, enum: ['warn', 'unknown'] },
              alias: { type: 'string' },
              detail: { type: 'string', required: true },
            },
          },
        },
        text: { type: 'string', required: true, description: 'The same verdict as one pasteable sentence block.' },
      },
    },
    diagnosticsSchemaVersion: { type: 'integer' },
    diagnosticsText: { type: 'string', description: 'Recent events as redacted plain text, safe to share: paths, usernames, key names and passwords are masked.' },
    // Present only when a host's key could not be pinned, so an empty
    // array is not required: absence means "nothing to report".
    unpinnedHostKeys: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string', required: true },
          keyType: { type: 'string', required: true },
          fingerprint: { type: 'string', required: true },
        },
      },
    },
    // What each probed host can actually do, and what its absence costs.
    // Separate from `capabilities` on the mount tool because that answer
    // is about ONE host at mount time, while this is the standing report.
    selfCheck: {
      type: 'array',
      description: 'Per-host capability self-check: which optional remote tools are present, and what their absence costs.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string', required: true },
          missing: { type: 'array', required: true, items: { type: 'string' } },
          // The structured rows travel too, because a model reading
          // `missing` alone cannot say WHY a tool matters — and "why"
          // is the whole point of the self-check.
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tool: { type: 'string', required: true },
                feature: { type: 'string', required: true },
                state: { type: 'string', required: true, enum: ['present', 'absent', 'unknown'] },
                detail: { type: 'string' },
                install: { type: 'string' },
              },
            },
          },
          text: { type: 'string', required: true, description: 'The rendered report, identical to the panel\'s wording.' },
        },
      },
    },
    // The bounded record of what this session actually ran on a host.
    // Not the same as `events`: events say what went wrong, commands say
    // what happened. Present only when something was run.
    commands: {
      type: 'array',
      description: 'Recent remote commands (redacted), oldest first. A refused entry means nothing ran.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'integer', required: true },
          at: { type: 'integer', required: true },
          alias: { type: 'string', required: true },
          command: { type: 'string', required: true },
          channel: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          outcomeUnknown: { type: 'boolean' },
          refused: { type: 'boolean' },
          cwd: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
    auditText: { type: 'string', description: 'The command audit as redacted plain text, safe to share.' },
    // The one artifact a user pastes into a bug report: versions, patch
    // verdicts, host configuration, self-check, commands, events — all
    // already redacted. Nothing is uploaded anywhere.
    supportBundle: { type: 'string', description: 'A complete redacted diagnostic report (versions, patches, hosts, self-check, recent commands and events). Safe to paste; it is never uploaded.' },
  },
}

// ---------------------------------------------------------------------------
// The block: the one shape every tool result takes
// ---------------------------------------------------------------------------
/**
 * Wrap text as the single content block these tools render.
 *
 */
export function text (value) {
  return [{ type: 'text', text: value }]
}

// ---------------------------------------------------------------------------
// The wording: rendered text for the status tool
// ---------------------------------------------------------------------------
/**
 * Render a status result as the single text block the tool returns.
 *
 * @param {object} value - a status result, already projected onto the schema.
 */
export function renderStatus (value) {
  const lines = [`fs serves remote paths: ${value.fsPatched ? 'yes' : 'no'}`]
  // The verdict leads, because it is the answer to the question the
  // caller actually asked. A tool that prints state and leaves the
  // reader to judge it is the shape this module exists to replace — the
  // report and the panel both answer "is anything wrong?", so the tool
  // does too, in the same words.
  if (value.diagnosis !== undefined) {
    for (const line of String(value.diagnosis.text ?? '').split('\n')) lines.push(line)
    lines.push('')
  }
  // Lead with the warning: a key that is trusted but not pinned means the
  // next connection will trust whatever the server presents again.
  for (const entry of value.unpinnedHostKeys ?? []) {
    lines.push(`WARNING: the host key for ${entry.alias} could not be saved (${entry.keyType} ${entry.fingerprint}) — it was accepted this time but is NOT pinned; the next connection will trust this key again on first use`)
  }
  lines.push(`mounted remote workspaces: ${value.mounted.length === 0 ? 'none' : ''}`)
  for (const root of value.mounted) lines.push(`  ${root}`)
  if ((value.disabled ?? []).length > 0) {
    lines.push('detached remote workspaces (not served; sessions kept and greyed):')
    for (const path of value.disabled) lines.push(`  ${path}`)
  }
  lines.push(`live SSH connections: ${value.connections.length === 0 ? 'none' : ''}`)
  for (const connection of value.connections) {
    lines.push(`  ${connection.alias}: ${connection.state} (in flight ${connection.inFlight})`)
    // Only a reconnect is worth a sentence. "generation 1" is the
    // ordinary case and saying it every call is noise; generation 2+
    // means work started earlier may still be running over there, and
    // that is exactly the fact a reader needs and cannot infer.
    if ((connection.generation ?? 1) > 1 && typeof connection.generationNote === 'string' && connection.generationNote !== '') {
      lines.push(`    ${connection.generationNote}`)
    }
  }
  // Only the hosts that are NOT connected need explaining; a healthy row
  // would make this section noise on every call.
  for (const retry of value.reconnecting ?? []) {
    if (retry.phase === 'gave-up') {
      lines.push(`reconnect STOPPED for ${retry.alias} after ${retry.attempts} attempt(s): ${retry.lastError}`)
    } else if (retry.phase === 'waiting') {
      const inSeconds = Math.max(0, Math.round((retry.nextAt - Date.now()) / 1000))
      lines.push(`reconnecting to ${retry.alias}: attempt ${retry.attempts} in ${inSeconds}s${retry.lastError === '' ? '' : ` (last error: ${retry.lastError})`}`)
    } else {
      lines.push(`reconnecting to ${retry.alias}: attempt ${retry.attempts} in progress`)
    }
  }
  lines.push(`port forwards: ${(value.forwards ?? []).length === 0 ? 'none' : ''}`)
  for (const forward of value.forwards ?? []) {
    lines.push(`  ${forward.id}: ${forward.localHost}:${forward.localPort} → ${forward.alias}:${forward.remoteHost}:${forward.remotePort} (${forward.connections} active)`)
  }
  if ((value.reverseForwards ?? []).length > 0) {
    lines.push('reverse port forwards (remote listeners → this machine):')
    for (const forward of value.reverseForwards) {
      lines.push(`  ${forward.id}: ${forward.alias}:${forward.remoteHost}:${forward.remotePort} → ${forward.localHost}:${forward.localPort} (${forward.connections} active)${forward.exposed ? ' [EXPOSED beyond the host]' : ''}`)
    }
  }
  if ((value.shells ?? []).length > 0) {
    lines.push('persistent remote shells:')
    for (const shell of value.shells) lines.push(`  ${shell.alias} [${shell.session}]: ${shell.alive ? 'live' : 'closed'}`)
  }
  // What each probed host can do. The rows come pre-rendered so the tool
  // and the panel cannot drift into two wordings for one fact; only the
  // hosts with something to say are printed, because "everything present"
  // on every status call is noise.
  for (const check of value.selfCheck ?? []) {
    if ((check.missing ?? []).length === 0 && !/UNKNOWN|WARN/u.test(check.text)) continue
    lines.push(`self-check for ${check.alias}:`)
    for (const line of check.text.split('\n')) lines.push(`  ${line}`)
  }
  // The command record. Only the failures and refusals get a line: a
  // successful `ls` is not news, while "this was refused" and "this
  // exited 1" are what a reader needs when reconstructing what happened.
  const noteworthy = (value.commands ?? []).filter(command => command.refused === true || command.outcomeUnknown === true || command.timedOut || (command.exitCode ?? 0) !== 0)
  if (noteworthy.length > 0) {
    lines.push('recent remote commands that failed or were refused:')
    for (const command of noteworthy.slice(-10)) {
      const status = command.refused === true
        ? 'REFUSED (nothing ran)'
        : command.outcomeUnknown === true
          ? 'outcome unknown (the connection died)'
          : command.timedOut
            ? 'timed out'
            : `exit ${command.exitCode}`
      lines.push(`  ${command.alias}: ${status} — ${command.command}`)
    }
  }
  // Only the states that need a human are spelled out; the normal ones
  // (`broken` = still load-bearing, `pending` = not registered yet) would
  // otherwise be noise on every single call.
  for (const workaround of value.upstreamWorkarounds ?? []) {
    if (workaround.probe === 'fixed') {
      lines.push(`upstream workaround OBSOLETE: ${workaround.id} — the Host no longer needs it, delete it (${workaround.detail})`)
    } else if (workaround.probe === 'unprobeable' || workaround.probe === 'disabled') {
      lines.push(`upstream workaround ${workaround.probe.toUpperCase()}: ${workaround.id} — ${workaround.detail}`)
    }
  }
  // A seam that did not install is the mirror image: the feature is gone
  // while everything else looks alive. `absent` is not printed — it means
  // the composition does not mount that service, which is a correct
  // deployment, not a symptom.
  for (const seam of value.seams ?? []) {
    if (seam.state === 'failed') {
      lines.push(`SEAM NOT INSTALLED: ${seam.id} — ${seam.detail}`)
    }
  }
  return text(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// The labels: live, cached, or the last thing that succeeded
// ---------------------------------------------------------------------------
/** The vocabulary, frozen so a typo cannot become a fourth kind. */
export const PROVENANCE = Object.freeze({
  live: 'live',
  cached: 'cached',
  stale: 'stale',
})

/**
 * A provenance label.
 *
 * @param {number} [at] - when the VALUE was read (for cached/stale), or when it
 *   was served (for live).
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
 * @param {boolean} [options.probeFailed] - the probe could not run this time.
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
