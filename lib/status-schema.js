/**
 * The output schema of the status tool.
 *
 * Split out of the tool definition because it is 375 lines of shape and no
 * behaviour: every branch of the answer is described here, and none of it is
 * executed. Keeping it beside the tool made a 606-line function out of what is
 * really a 115-line tool plus a contract.
 *
 * @module @shiqyka/dsh-ssh-workspace/status-schema
 */

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
