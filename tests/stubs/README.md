# Peer stubs

`tests/peer-stubs.mjs` generates a minimal `node_modules` tree standing in for the
DSH peer packages this plugin borrows at load time:

| package | what the stub provides |
| --- | --- |
| `@deepseek-ai/cordis` | `Context` / `Service` / `Fiber` whose constructors throw — real Cordis cannot be stood in for |
| `@deepseek-ai/dsh-fs` | `FsError` (with `code`), `FsTargetKey`, `FsVersion`, `FileSystem` |
| `@deepseek-ai/dsh-tools` | `defineTool` (shape-checking pass-through) |
| `ssh2` | `Client` whose constructor throws — it never pretends to speak SSH |

**Every stub exports `__dshStub: true`.** That marker is the only thing separating
"the host's own package" from "a shape-only stand-in", and the detector trusts it.
A stub that forgets the marker is reported as REAL — a stub can then make a run
*worse* than having none, because the suite believes it verified the host.

`tests/run.mjs` builds it automatically when `DSH_CORE_ROOT` is unset, so a bare
checkout exercises `routes.js` and `remote-fs.js` instead of skipping them.

## Why this exists

`routes.js` imports `remote-fs.js`, which resolves `@deepseek-ai/dsh-fs` at module
load. Without that package the suite SKIPPED — and a skipped suite cannot fail.
One such skip is how an upload handler that called two unimported helpers shipped
green. The stub root closes that hole for the plugin's own logic.

## What the stubs deliberately do NOT cover

These suites need the host's real framework and still skip without it:

| suite | needs | why a stub cannot help |
| --- | --- | --- |
| `lifecycle` | `cordis`, `dsh-fs`, `dsh-tools` | exercises real service ordering and re-injection |
| `boot` | `cordis`, `dsh-fs`, `dsh-tools` | boots a real Cordis application |
| `tool-schemas` | `dsh-tools` | the enforced JSON-Schema subset and argument validator |
| `projection-real` | `cordis` + the ESM host modules + `zod` | resolves the real schema the defect lives in |

Each calls `skipWithoutRealPeers()` (`tests/support/peer-mode.mjs`) and **declares
only the packages it actually needs**, so a tree missing an unrelated peer still
runs the suites that could have run.

The detector reports one of four states per package. The two that matter:

- **`absent`** — nothing resolved at that specifier. The suite SKIPs (exit 0).
- **`broken`** — the package resolved from disk but threw while loading, usually
  because one of its own peers is missing. The suite **FAILS** (exit 1) and prints
  that error. Skipping here is how a damaged dependency tree ships green, and
  reporting it as "not installed" (the old ad-hoc check in `boot-smoke`) sends the
  reader to install a package that is already there.

`live` and `acceptance` likewise skip without `DSH_WS_TEST_ALIAS` — no stub can
fake an SSH server.

A **real** in-process SSH server does exist, for transport-level tests:
`tests/support/fake-ssh-server.mjs` (used by `fake-transport-smoke`). It is not a
stub and deliberately does not live here — it speaks the real protocol over a
real socket, which is exactly what the `ssh2` stub above cannot do. It needs a
genuine `ssh2`, so `fake-transport-smoke` skips when only the stub is resolvable.

## Opting out

```
DSH_NO_PEER_STUBS=1 node tests/run.mjs
```

The generated tree lives at `tests/.peer-stubs/` and is not published
(`package.json` ships only `lib/`, `cordis.patch.yml` and `README.md`).
