<div align="center">

<img src="https://raw.githubusercontent.com/siqyka/dsh-ssh-workspace/main/docs/assets/header.png" alt="dsh-ssh-workspace header" width="640" />

# dsh-ssh-workspace

**Use a directory on an SSH host as a DSH workspace.**

Go straight over SFTP to read and write remote files —
no manual sync, no mount driver, no third-party filesystem.

[![version](https://img.shields.io/github/package-json/v/siqyka/dsh-ssh-workspace)](https://github.com/siqyka/dsh-ssh-workspace)
[![license](https://img.shields.io/github/license/siqyka/dsh-ssh-workspace)](https://github.com/siqyka/dsh-ssh-workspace/blob/main/LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)
![dsh](https://img.shields.io/badge/DSH-%3E%3D%200.2.0--rc.1-blue)
![ssh2](https://img.shields.io/badge/ssh2-%5E1.17.0-lightgrey)

[简体中文](https://github.com/siqyka/dsh-ssh-workspace/blob/main/README.md) · **English**

</div>

---

<table>
<tr>
<td align="center" width="33%">

**Direct SFTP**

Reads, writes and edits run over SFTP
with full error semantics and atomic writes

</td>
<td align="center" width="33%">

**Remote execution**

Shell, ripgrep and git
all run on the remote host

</td>
<td align="center" width="33%">

**UI integration**

File tree, `@` references, drag-to-task
and a host management panel out of the box

</td>
</tr>
</table>

## Contents

- [Overview](#overview)
- [Quick start](#quick-start)
- [Host management](#host-management)
- [Configuration](#configuration)
  - [LAN deployments (`allowLan`)](#lan-deployments-allowlan)
- [Agent tools](#agent-tools)
- [Capabilities](#capabilities)
  - [Remote files](#remote-files)
  - [Remote execution](#remote-execution)
  - [UI integration](#ui-integration)
  - [Selection, rename and delete](#selection-rename-and-delete)
  - [Connection model](#connection-model)
- [Limitations](#limitations)
- [Implementation notes](#implementation-notes)
- [Documentation index](#documentation-index)
- [License](#license)

## Overview

Workspace path syntax:

```
ssh://<alias>/<remote-absolute-path>
e.g.   ssh://myserver/home/user/project
```

In the UI these paths are **displayed** as `ssh://<alias>@/<remote-absolute-path>`
(an `@` is inserted after the alias, so it reads like an SSH address) — that is how
they appear on sidebar workspace-row hover cards, the right sidebar's "Files" panel
header, document-preview headers, and elsewhere. Copying and every functional use
(mounting, file operations, tool calls) still use the real spelling
`ssh://<alias>/<remote-absolute-path>`.

### The problem it solves

DSH routes all file operations through a single service abstraction, `ctx.fs`
(`@deepseek-ai/dsh-fs`). This plugin adds a "remote half" to that abstraction:

```
        DSH tool layer (read / write / edit / bash / glob / grep / Changes panel)
                                   │
                              ctx.fs router
                                   │
            ┌──────────────────────┴──────────────────────┐
            │                                             │
   ssh://<alias>/<path>                    everything else (E:\…, /home/…)
            │                                             │
   This plugin's SFTP backend ──► SSH host   The deployment's original local
                                            (sandbox) backend
```

So **everything about local workspaces stays as it was**, including the sandbox write
fence, version guards, and atomic writes; remote workspaces get the same tools and the
same error semantics.

## Quick start

1. **Install**: open the official desktop client and go to the **Plugins** page under
   **Settings** (or the plugins entry in the left navigation bar);
2. **Enter the source**: in the plugin manager's install field, use either of these and
   click Install:
   - **npm package** (distributed via npm, version pinning supported):
     `@shiqyka/dsh-ssh-workspace`, or pin a version
     `@shiqyka/dsh-ssh-workspace@0.3.6`
     ([npm page](https://www.npmjs.com/package/@shiqyka/dsh-ssh-workspace));
   - **repository address** (latest code from Git):
     `https://github.com/siqyka/dsh-ssh-workspace`
     (the plugin manager installs its dependencies for you; only a manual clone
     linked into a profile needs the next section)
3. **Restart**: restart the client once installation finishes, and you're ready to go.

From there:

```
Confirm your hosts in the "Remote Workspaces" panel (add one if needed)
        │
        ▼
"Add workspace → New remote workspace": pick a host, browse the remote directory, mount
        │
        ▼
Create a session in that workspace — file I/O, shell, search and change tracking
all land on the remote host automatically
```

### Using a source checkout

```bash
git clone https://github.com/siqyka/dsh-ssh-workspace.git
cd dsh-ssh-workspace
npm ci          # ssh2 is a direct dependency and does not arrive with a clone
```

Then restart the client.

## Host management

Host records live in `$DSH_HOME/dsh-ssh.json`; when that file is absent, the plugin
falls back to concrete `Host` blocks in `~/.ssh/config`. So **hosts you have already
configured need no re-entry**.

The "Remote Workspaces" panel can **add / edit / delete** hosts directly, writing back
to `$DSH_HOME/dsh-ssh.json` (atomic writes; fields the plugin doesn't recognize are
preserved). Hosts from `~/.ssh/config` are a **read-only fallback** — the panel never
modifies that file; when the same name exists in both, the store wins. Passwords / key
passphrases are **encrypted** in that store's `secrets` section (AES-256-GCM, key in
`$DSH_HOME/dsh-ssh.key`, owner-only) and are never sent back to the browser; leaving them
blank while editing keeps the current value. Deleting a
host does not automatically unmount its mounted workspaces, but those workspaces
become inaccessible since the host no longer exists.

> See [docs/hosts.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/hosts.md) for the storage format, `~/.ssh/config` parsing
> rules, and the credential policy.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `announceToAgent` | `false` | Whether to inject a capability description (a system-prompt section) into every agent |
| `localPassthrough` | `['$DSH_HOME/attachments', '$DSH_HOME/plugins']` | **Host absolute prefixes** that keep their local meaning inside an `ssh://` session; `false` / `[]` disables it. Matching is lexical only, and the whole `$DSH_HOME` root is refused |
| `localPassthroughScheme` | `local` | Scheme name for explicitly naming a host path (`local:/abs/path`). At least **3 characters**; lowercase letters, digits and `+ - .`; `ssh` / `file` / `sftp` / `dsh-app` and the common URL schemes are reserved (the list is published by `/status`); **only one prefix at a time**, saving another replaces it; the name is case-insensitive while the path follows the platform. **First default only** — once saved in the panel, the store wins |
| `localPassthroughFallback` | `false` | Whether an `@`-named POSIX absolute path falls back to the host copy after the remote reports it absent. Also a first default only |
| `allowLan` | `false` | LAN deployment: the browser HTTP routes accept private-network source addresses (IPv4 RFC1918, IPv6 ULA/link-local) |
| `allowedHosts` | `[]` | Extra `Host` values to admit (with `allowLan`), e.g. when the panel is reached by a LAN hostname |
| `engine.idleTimeoutMs` | `1800000` | Recycle a connection after it stays idle this long (ms) |
| `engine.connectTimeoutMs` | `15000` | Per-connect SSH handshake budget (ms) |
| `engine.keepaliveIntervalMs` | `15000` | Keepalive heartbeat interval (ms) |
| `engine.sweepIntervalMs` | `60000` | How often idle connections are swept (ms) |
| `engine.reconnect` | see below | Background reconnect after a drop; `false` restores the old "retry once inside the operation" behaviour |
| `engine.reconnect.baseDelayMs` | `1000` | Wait before the first retry (ms); doubles per attempt |
| `engine.reconnect.maxDelayMs` | `60000` | Ceiling for a single wait (ms) |
| `engine.reconnect.maxAttempts` | `0` | Attempt limit; `0` means unlimited |
| `engine.reconnect.jitter` | `0.2` | Downward-only jitter ratio, so several hosts do not reconnect in lockstep; never exceeds the ceiling |

> All `engine` entries are optional (invalid values fall back to the defaults) and rarely need tuning.

> The full rules for the `localPassthrough` fields above (prefix matching, `@` references, explicit schemes, remote-first fallback, and the "`ctx.fs` boundary") are in [docs/features.md → "Host-path passthrough"](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#本机路径直通localpassthrough).

### LAN deployments (`allowLan`)

By default only the **loopback interface** may call the browser routes
(`127.0.0.1` / `::1` / `localhost`). When the webserver binds `0.0.0.0` and the
browser sits on another LAN machine, requests are refused with
`forbidden: loopback-only` — that is the anti-DNS-rebinding fence, not a
malfunction. With `allowLan: true`:

- the source address may be any **private-network** address (IPv4 `10/8`,
  `172.16/12`, `192.168/16`; IPv6 ULA `fc00::/7` and link-local `fe80::/10`);
  public addresses are still refused;
- the `Host` header must name one of **this machine's own listening
  addresses** (each interface address plus the port; loopback spellings always
  work), and a mismatching Host still gets
  `forbidden: unexpected Host header …` — the anti-rebinding semantics carry
  over unchanged;
- if the panel is reached by a name the machine's interfaces do not know (a
  LAN hostname, a reverse-proxy spelling), add it to `allowedHosts` (case and
  surrounding whitespace insensitive, with or without a port);
- the JSON content-type check on POST and the 405/415 handling are unchanged.

See [SECURITY.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/SECURITY.md) for the full security discussion.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `ssh_workspace_hosts` | List available hosts (store + `~/.ssh/config` candidates) |
| `ssh_workspace_mount` | Register a remote directory as a workspace and return an `ssh://` path |
| `ssh_workspace_unmount` | Detach a remote workspace (the record and its sessions are kept by default, so it is reversible; opting into "also remove the record" archives the sessions and deletes the record) |
| `ssh_workspace_enable` | Mount a detached workspace again and unarchive its sessions |
| `ssh_workspace_status` | Mounted / detached lists, connections, forwards, and persistent sessions |
| `ssh_workspace_exec` | Run a shell command **on the remote host** (optionally `run_in_background`) |
| `ssh_workspace_shell` | Run a command in a **persistent** remote shell; state survives between calls |
| `ssh_workspace_transfer` | Copy a file between this machine and the host (SFTP, bytes never enter the conversation) |
| `ssh_workspace_forward` | Map a remote port to this machine and return an openable URL |
| `ssh_workspace_reverse_forward` | Make the remote host listen on a port and forward connections back to this machine (`ssh -R`), so a remote browser or colleague can reach a local service |
| `ssh_workspace_unforward` | Close a port mapping and release the local port (forward and reverse) |

> For tool parameters, return fields, and error semantics, see [docs/tools.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/tools.md).

## Capabilities

> The complete inventory by domain (dependencies, degradation, limits included) is in [docs/features.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md); UI details are in [docs/ui.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md).

### Remote files

See [features.md → II. File reads and writes](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#二文件读写)

- **Full error semantics** — `read` / `write` / `edit` run entirely over SFTP, with explicit codes for stale versions, type errors, out-of-root writes, and so on
- **Atomic writes** — A staging file in the same directory is replaced in place; `posix-rename@openssh.com` is preferred, degrading to delete-then-rename where unsupported
- **Line-ending fidelity** — Editing a CRLF file won't rewrite it to LF
- **Binary and encoding** — Text reads reject NUL / invalid UTF-8; `readBytes` returns raw bytes
- **Write fence** — Writes may only land inside a mounted remote workspace; read-only sessions block writes too, reads are unrestricted
- **Large files stream** — Previews and `read` stream in 256 KiB chunks instead of loading the whole file
- **Host-path passthrough** — Host-absolute paths such as chat attachments keep their local meaning in an `ssh://` session; other absolute paths stay remote and existence is never probed
- **Remote changes auto-refresh** — inotifywait push events are preferred; without it polling runs about every 2 s and backs off while idle

### Remote execution

See [features.md → III. Remote execution](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#三远端执行)

- **Shell commands follow the workspace** — `pwsh` / `bash` run on the remote host under POSIX semantics in an `ssh://` session
- **glob / grep search the remote** — They invoke ripgrep on the remote host and fail clearly with an install hint when it is absent
- **Change tracking goes remote** — Remote git provides snapshots and diffs, and turns itself off when git is not installed
- **PTC / `run_code` works** — The program runs in a host-side worker while every tool call it makes still executes remotely

### UI integration

See [features.md → VI. UI integration](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#六界面集成) and [ui.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md)

- **New sessions work** — The host's `node:fs/promises` routes `ssh://` paths over SFTP, so a session can be created directly in a remote workspace
- **Automatic remount after restart** — Registered workspaces are restored from the persisted registry on next launch
- **Sidebar groups repaired in place** — Disable → restart → enable needs no second restart to see the sessions
- **The "Workspace Files" sidebar works** — The tree lists the remote directory directly and previews are read over SFTP
- **Editing a file in the browser** — The preview header's pencil opens an in-place editor with two-token conflict protection, multiple tabs that keep drafts, and a 2 MiB cap
- **`@` file references work remotely** — Completion candidates come from the remote tree and a selection inserts `@relative/path`
- **Drag or right-click a file onto the task** — Tree rows can be dragged onto the chat input or added via right-click, equivalent to an `@` selection
- **Drop system files onto the tree** — The drop point decides the target directory; folders and local trees are refused
- **"Add workspace" gets a remote entry** — A two-step local/remote menu; the remote branch picks a host, browses directories, and mounts
- **Recent commit history under the change-request tab** — A read-only history strip is appended to the official panel's lower half, collapsible by clicking the title with the state remembered
- **Remote workspaces wear a dedicated mark** — Sidebar rows, the picker, and the session's workspace button show the remote mark
- **Host management panel** — Add / edit / delete hosts, test connection with a 7-second toast, inline connection state, and forwards torn down on disconnect
- **Directory browser dialog** — Walk the remote tree level by level and mount in place; browse and mount only
- **Row menu: new folder / rename / delete** — Remote and local rows can be renamed or deleted; remote directory rows also offer "New folder"
- **Blank-space menu (local workspaces)** — Exactly two items, "New folder" and "Copy path", targeting the directory the blank space belongs to
- **Uploads / downloads from the file panel** — Upload lives in the remote row menu; the panel header's tray icon opens the progress popover

### Selection, rename and delete

Multi-select lives directly in the host's own "Files" tree — no extra dialog or tab. Selected rows get a background fill and cursor outline; there are no checkboxes, no "selection mode" switch and no batch bar, and menu labels stay fixed while their scope follows the selection. The full gesture set (click, Ctrl/Cmd, Shift, right-click, arrow keys, F2/Delete) and the `resolveTargets` rule are in [ui.md → interaction details](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md#交互细节) and [features.md → VI. UI integration](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#六界面集成).

### Connection model

One long-lived connection per alias — an always-open SFTP channel plus exec channels for shell commands — recycled after 30 minutes idle, never mid-operation. The first connection records the host-key fingerprint (TOFU); a later mismatch is refused, and a legitimate reinstall re-trusts via "Forget host key" in the panel. See [features.md → VII. Hosts and security](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#七主机与安全).

## Limitations

Explicitly **not supported**:

- **`ProxyCommand` (this one only)**: still refused — it is arbitrary local command
  execution, and a config file is data, not a program to run. `ProxyJump` is
  supported: independent connections are built hop by hop in the shape of `ssh -J`
  (up to 8 hops), so the target only sees its immediate neighbour; `none` forces a
  direct connection. Hosts with `ProxyCommand` are **explicitly rejected** at parse
  time with the reason stated, rather than silently attempted as a direct connection.
- **Where a shell command runs follows `workdir`.** With an `ssh://` session workspace,
  `pwsh` / `bash` commands run on the remote host — POSIX shell semantics, outside the
  local file sandbox (full permissions of the remote login user); local `workdir`
  commands stay on this machine inside the sandbox. For unmounted paths or host
  inspection, keep using `ssh_workspace_exec`.

## Implementation notes

The six core paths in one line each; the full mechanics are in [docs/architecture.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/architecture.md).

- **No second `fs` service** — Remote methods are installed onto the already-mounted `ctx.fs`; everything else forwards unchanged
- **Bridging the host's built-in modules** — `node:fs/promises` and `node:path` special-case `ssh://` so calls made before any agent exists also go over SFTP
- **Taking over `ctx.subprocess`** — Subprocesses whose `cwd` is `ssh://` run remotely (ripgrep / git) with the same handle contract as local ones
- **Localizing the sandbox root** — Only the remote root `confine` receives is swapped for a real local directory; the session-scope fence is untouched
- **Localizing the PTC worker** — Only the cwd returned by `ptcRuntime.resolve` changes; the tools the program calls still run remotely
- **Workspace registration bypasses `realpath`** — It goes through `createCanonical()`, preserving persistence and ordered writes

## Documentation index

| Doc | Contents |
| --- | --- |
| [features.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md) | **Feature reference**: the complete capability inventory by domain (workspaces / files / execution / transfer / forwarding / UI / security / config / degradation matrix / limits) |
| [architecture.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/architecture.md) | Architecture & implementation: the `ctx.fs` / `ctx.shell` / `ctx.subprocess` takeovers, change watching & streaming, built-in bridges, engine & connection model |
| [protocol.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/protocol.md) | The `ssh://` path protocol: syntax, normalization, display rules, `file:` URIs, the write fence and the detached fence |
| [hosts.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/hosts.md) | Host configuration & auth: storage format, `~/.ssh/config` fallback, panel management |
| [tools.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/tools.md) | Agent tool reference: the 11 `ssh_workspace_*` tools (including `reverse_forward`) |
| [ui.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md) | UI guide: the panel, the dual "Add workspace" entry, remote-workspace marks, the port-forward and persistent-shell sections, the file-reference section |
| [development.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/development.md) | Development, debugging & release: source layout, dependency resolution, packaging |
| [upstream-workarounds.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/upstream-workarounds.md) | Upstream workaround register: host defects, the one-line fix, the self-retiring signal, and the removal steps |
| [upstream-workaround-pattern.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/upstream-workaround-pattern.md) | **The retirement pattern for upstream workarounds**: when it applies, the seven pieces, tri-state probing, a reachable notification channel, anti-patterns, and its cost boundary |
| [troubleshooting.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/troubleshooting.md) | Troubleshooting & FAQ: error semantics, connection issues, known limitations |
| [FF/README.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/FF/README.md) | **Completed-workflow index**: designs and task briefs for 01–10 were removed per convention; the index points to their final homes and keeps the client-chunk host facts and the explicit non-goals |
| [CONTRIBUTING.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/CONTRIBUTING.md) | Contributing: environment, the three test tiers, code conventions, before you ship |
| [SECURITY.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/SECURITY.md) | Security policy: how credentials are stored, host-key verification, known boundaries, reporting |
| [CHANGELOG.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/CHANGELOG.md) | Changelog: additions, fixes and changes per version |

---

## License

<div align="center">

**[MIT](https://github.com/siqyka/dsh-ssh-workspace/blob/main/LICENSE) © 2026 siqyka**

<sub>SSH distance, local feel.</sub>

</div>





