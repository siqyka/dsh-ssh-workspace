<div align="center">

<img src="https://raw.githubusercontent.com/siqyka/dsh-ssh-workspace/main/docs/assets/header.png" alt="dsh-ssh-workspace header" width="640" />

# dsh-ssh-workspace

**Use a directory on an SSH host as a DSH workspace.**

`read` / `write` / `edit` go straight over SFTP to read and write remote files —
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
- [Agent tools](#agent-tools)
- [Capabilities](#capabilities)
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
     `@shiqyka/dsh-ssh-workspace@0.2.8`
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

> All four `engine` entries are optional (invalid values fall back to the defaults) and rarely need tuning.

### Host-path passthrough (`localPassthrough`)

An `ssh://` session treats every absolute path as **remote-absolute**. Chat attachments, however,
live on the machine running DSH, so their handle path needs an exception:

```yaml
# The defaults; usually no need to write this out
localPassthrough:
  - $DSH_HOME/attachments
  - $DSH_HOME/plugins
```

- Only **host absolute prefixes** are accepted. `$DSH_HOME`, `${DSH_HOME}`, and a leading `~`
  are expanded; any other variable, a relative path, or an `ssh://` prefix is warned about and
  ignored.
- A matching path goes through the host backend; an unmatched absolute path stays remote, even
  when a same-named file happens to exist locally (there is no `stat` / existence probe).
- Matching is lexical: `attachments/../dsh-ssh.json` normalizes out of the prefix and does not
  match; symlinks are not resolved.
- **The write fence is unchanged**: passthrough chooses a world, it does not add the prefix to any
  local writable root; `read-only` / `workspace-write` still apply.
- Do not add the whole `$DSH_HOME` — it holds `dsh-ssh.json`, `dsh-ssh.key`, and session data; the
  plugin refuses that prefix. If the remote host has the same prefix, the local passthrough wins;
  this trade-off is deliberate.
- **A host path you name with `@` also passes through**: writing `@F:\123.txt` or
  `@"C:\Users\me\a b.txt"` in a message records that spelling in the plugin's reference
  table (shared by the sessions of this DSH process), so the model reads it locally. Only
  **Windows drive / UNC** spellings are accepted (a POSIX remote has no drive letters, so there is
  no ambiguity); `@src/a.js` and `@/tmp/x` remain workspace or remote references. The table is
  capped at 256 entries, oldest evicted first. The whole `$DSH_HOME` stays refused even when
  named with `@` (it holds the SSH key and stored host secrets).
- **Naming a host path explicitly with a scheme**: `local:/Volumes/SSD/a.md` (POSIX) and
  `local:F:\123.txt` (Windows) always read on this machine; the path is the absolute path
  after the prefix. The prefix name is `localPassthroughScheme` and is edited in the panel's
  "File reference settings" zone, in its "Explicit file reference scheme" block (the input's own
  accessible name stays "Host scheme"), taking effect on save (no restart). A scheme you did not
  enable is **refused loudly** (`FS_PERMISSION_DENIED`) rather than quietly retried as a
  remote path; `ssh:` is reserved and cannot be configured. **Only one prefix can be configured
  at a time**: saving a different name replaces it wholesale, and the old one stops working
  immediately — the two are never listed side by side. The name needs at least **3 characters**
  (one character would compete with a Windows drive letter such as `c:/x`); `file:`, `sftp:`,
  `dsh-app:` and the common URL schemes are reserved as well (`file:///` is the URI this plugin
  writes for *remote* paths, so one spelling cannot mean both machines). The prefix NAME is
  case-insensitive; the path after the colon follows the platform (case-insensitive on Windows,
  case-sensitive on macOS/Linux). The prefix unlocks the spellings
  it names and the `@` references — it never turns a bare `F:\123.txt` or `/tmp/x` into a host
  read.
- **Remote first, host copy on a miss (optional)**: with "fall back to this machine when the
  remote lacks it" checked, a POSIX absolute path such as `@/Volumes/SSD/PARAMS.md` still
  resolves remotely first. Only when the remote **really reports it absent** does the plugin
  try the host copy once, appending a `[ssh-workspace]` note that names the source. The
  fallback covers reads only (`read` / `read_image` / `streamText` / `lstat`); writes, `glob`,
  `grep` and directory listings **never** fall back. Unchecking it restores "every POSIX
  absolute path is remote".
- `false` or `[]` disables it; restart DSH after changing it. The defaults follow `$DSH_HOME`
  (`~/.dsh` when unset).
- **Passthrough has a boundary, and the boundary is `ctx.fs`**: the host's official
  `read` / `write` / `edit` / `read_image` and `node:fs` go through that seam, so they pass.
  **Reads that do not go through `ctx.fs` still fail.** In this deployment dsh-ops'
  `inspect_local_file` / `read_files` / `glob` / `grep` spawn a host worker process with the
  session cwd, so an `ssh://` cwd fails every time (`EXECUTOR_UNAVAILABLE`, text mentions
  `only git and ripgrep`; `ops_bash` with a `workdir` reports `invalid workdir`); the host's
  `glob` / `grep` spawn `rg` directly and stay remote. Under the ops preset `read` is replaced
  by `inspect_local_file`, so a host file is unreadable on that path — that is expected. This
  is a structural upstream mismatch, not an authorization denial, and retrying does not help:
  switch entry points — read remote content with `ssh_workspace_exec` / `ssh_workspace_shell`,
  and read a host file by uploading it to that host's `/tmp` with `ssh_workspace_transfer` and
  reading it there. See
  [troubleshooting.md](./docs/troubleshooting.md#直通了为什么还是读不到).

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
| `ssh_workspace_unforward` | Close a port mapping and release the local port |

> For tool parameters, return fields, and error semantics, see [docs/tools.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/tools.md).

## Capabilities

> The complete inventory by domain (dependencies, degradation, limits included) is in [docs/features.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md).

### Remote files

| Capability | Details |
| --- | --- |
| Full error semantics | `read` / `write` / `edit` run entirely over SFTP, with `FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_AMBIGUOUS_EDIT`, `FS_NOT_TEXT`, `FS_TOO_LARGE`, `FS_NOT_FOUND`, and so on |
| Atomic writes | A write first lands in a staging file in the same directory, then replaces the target. OpenSSH's `posix-rename@openssh.com` is preferred; when the server doesn't support it, the plugin degrades to "delete, then rename" (no longer atomic in that case) |
| Line-ending fidelity | Editing a CRLF file won't rewrite it to LF |
| Binary and encoding | Text reads reject NUL / invalid UTF-8; `readBytes` returns raw bytes |
| Write fence | Remote writes may only land inside a mounted remote workspace; anything outside returns `FS_OUTSIDE_WORKSPACE`. **The `read-only` mode also blocks remote writes** (`FS_SANDBOX_DENIED`). Reads are unrestricted |
| Large files stream | Previews and `read` stream remote files in 256 KiB chunks instead of loading the whole file into memory |
| Host-path passthrough | Host-absolute paths — such as non-image chat attachments — keep their local meaning inside an `ssh://` session (`read` / `read_image` / `node:fs`). By default only `$DSH_HOME/attachments` and `$DSH_HOME/plugins` pass through; every other absolute path stays remote, and matching never probes existence. A Windows drive/UNC path the user names with `@` in a message also passes through, and an explicit `local:/abs/path` names this machine (the prefix name is configurable); a scheme you did not enable is refused rather than guessed at |
| Remote changes auto-refresh | Remote `inotifywait` push events are preferred (immediate, not bound by mtime precision); without it the plugin falls back to polling — about every 2 seconds, backing off while idle (after 15 quiet rounds to 5 s, after 30 to 10 s) and snapping back to 2 s on any change. On the polling path SFTP metadata has no sub-second timestamps, so consecutive rewrites of equal size within the same second may not trigger a refresh; additions, removals, and renames always do |

### Remote execution

| Capability | Details |
| --- | --- |
| Shell commands follow the workspace | With an `ssh://` session workspace, the `pwsh` / `bash` tools run on the remote host under POSIX shell semantics — one-shot commands, background jobs, timeouts, and cancellation all work through DSH's process contract; local `workdir` commands are unaffected |
| glob / grep search the remote | They invoke **ripgrep (`rg`) on the remote host** and return real remote results; when ripgrep isn't installed there, the command fails clearly with an install hint (exit code 127) |
| Change tracking goes remote | The "Changes" (deliverables) panel uses **remote git** for per-turn snapshots and diffs — files changed by remote shell commands show up too (+N/−N, click through to the diff); when git isn't installed remotely this capability quietly turns itself off and nothing else is affected |

### UI integration

| Capability | Details |
| --- | --- |
| New sessions work | The host's own `node:fs/promises` calls (the session controller's `mkdir`, the workspace registry's `realpath` / `stat`) also route `ssh://` paths over SFTP, and `node:path.isAbsolute` treats `ssh://` spellings as absolute — so you can create a session directly in a remote workspace |
| Automatic remount after restart | Registered `ssh://` workspaces are remounted from the persisted registry on next launch |
| The "Workspace Files" sidebar works | The file tree lists the remote directory directly and text previews are read over SFTP; `fs.fileUrl` returns the canonical `file:` URI of the **remote execution world** per the `dsh-fs` contract |
| `@` file references work remotely | The chat input's `@` completion draws candidates from the **remote** tree (recursive index + fuzzy ranking; queries containing `/` browse level by level; directory symlinks are never followed). A selection inserts `@relative/path`, and the model's `read` opens exactly that remote file |
| Drag or right-click a file onto the task | Files and folders in the tree can be **dragged straight onto the chat input** (dashed highlight while hovering; releasing inserts the reference chip) or picked via **right-click → "Add to task"** — both produce exactly what an `@` completion selection would |
| Drop system files onto the tree | Dragging files from the OS file manager onto a **remote** Files tree uploads them; the drop point decides the target directory (a directory row is itself, a file / `other` row means its parent, blank space inside an expanded directory belongs to that directory, while tree body and header / path label mean the root). Folders are refused with one notice and never walked; a local tree refuses explicitly, and a drop outside the tree keeps DSH's own attachment behavior. See [ui.md](docs/ui.md#从系统拖入文件上传) |
| "Add workspace" gets a remote entry | DSH's "Add workspace" button becomes an anchored menu offering "New local workspace" (DSH's native picker) or "New remote workspace" (choose a host → browse the remote directory level by level → confirm the mount; unwritable directories produce a warning and refuse creation) |
| Remote workspaces wear a dedicated mark | Workspaces created by this plugin show the plugin's remote mark instead of the plain folder icon in sidebar rows, the workspace picker, and the session page's workspace button |
| Host management panel | Add / edit / delete hosts (key paths, auth method, notes, …); changes take effect immediately and drop that alias's old connection. `~/.ssh/config` hosts are shown read-only. "Test connection" only probes reachability (it releases the connection it opened, so a probe never doubles as "connect") and reports as a toast at the top that expires after 7 seconds (click / Esc closes early; hovering pauses the clock). An error can expand its diagnostic code and raw message, copy the whole report, and — because a probe is safe to replay — retry in place. Connection state is shown inline after the host name, and dropping a connection also tears down that host's port forwards |
| Directory browser dialog | A host card's "Browse directory" walks the remote tree level by level and can "Mount this directory" in place; **browse and mount only** — no upload, download, or inline queue (transfers live in the tree row menu and the file panel header) |
| The "Workspace files" sidebar | DSH's own file tree lists the remote directory; text previews are read over SFTP; `fs.fileUrl` returns a canonical `file:` URI in the remote execution world |
| Row menu: new folder / rename / delete | DSH's tree row menu provides rename and delete: remote rows AND **local rows** can be renamed (rename only, never a move) and deleted (a directory goes with its subtree, after a confirmation); an existing target is refused; a failure leaves the row untouched; F2 / Delete invoke the same action. A **remote directory row** also offers "New folder", backed by `POST /mkdir` (parent path plus a single-segment name; out-of-root, read-only, detached and duplicate targets are refused before any write); success re-lists the directory and selects the new row. A local directory row does not: local creation goes through the blank-space menu below, so the two entries never overlap. The row menu is 220px, single-line, at most eight items and three rules (task | transfer/copy | download-to-machine | new-folder/rename/delete). Labels are fixed and carry no count: delete is always "Delete" and download is always "Download to this machine"; how many rows the action covers is decided by `resolveTargets`, and the count appears in the delete confirmation and the download destination dialog |
| Blank-space menu (local workspaces) | Right-clicking empty space in a local workspace's Files tree opens a menu with exactly two items: "New folder" and "Copy path". The target is the directory that empty space belongs to — the expanded directory whose nested list contains it, otherwise the tree root — and it must be inside that root. Creating uses the same `POST /mkdir` local branch (a single-segment name; out-of-root, read-only and duplicate targets are refused before any write) and selects the new row afterwards; "Copy path" is always available, and a read-only session disables only creation. Remote workspaces keep their own blank-space menu. |
| Uploads / downloads from the file panel | Uploading is offered only by the file tree's row menu ("Upload a file here", remote rows only). The "Workspace Files" panel header keeps a single tray-arrow icon entry that stays visible even with an empty queue — **only while the panel shows a remote `ssh://` workspace**; a local listing keeps DSH's own header — idle it is the bare mark, and while a transfer is queued or running it turns blue and wears an aggregate progress ring (the count lives in its accessible name), opening the progress popover (per-item progress, speed and a progress bar, cancel, clear finished; running items first, settled newest first). The host's own right-hand tree stays the host's component — the plugin does not touch its JSX, it only layers multi-select on top (see below) |

### Selection, rename and delete

**Entry**: multi-select lives directly in the host's own "Files" tab — no dialog, no plugin tab. The plugin does not take over that tree (it is the host's DOM) — it only adds classes of its own and delegates clicks and keys at the document level, so highlight, Ctrl/Shift, arrow keys and right-click semantics work *in the host's tree*.

| Gesture | Result |
| --- | --- |
| Click a directory | Enter it and clear the selection and anchor |
| Click a file | **Select it AND open it** (navigation passes through; only a modified click swallows it) |
| Ctrl/Cmd+click | Toggle the row; **a directory is selected, never entered** |
| Shift+click | Range from the anchor to the row; **the first Shift seeds the anchor**, so two consecutive Shift+clicks select a range without a preceding ordinary click (which would open a file preview); **a directory is selected, never entered**; the anchor does not move |
| Ctrl/Cmd+Shift+click | Append that range to the existing selection |
| Right-click (outside the selection) | Collapse the selection to that row, then open the menu; never opens the file |
| Right-click (inside the selection) | Keep the whole selection; the label stays the same, the scope is the batch |
| Ctrl/Cmd+right-click | Toggle that row, then open the menu |
| Shift+right-click | Extend the range from the anchor, then open the menu |
| Click empty space / Esc | Clear the selection (Esc keeps the keyboard cursor) |
| Ctrl/Cmd+A | Select all, directories included |
| ↑/↓, Home/End | Move the cursor and select; Shift extends; Ctrl+↑/↓ moves the cursor only |
| Enter | Enter the directory under the cursor |
| F2 / Delete | Rename / delete the cursor row or the selected rows |

Selected rows are painted with a background fill and the cursor row with an outline; **no row renders a checkbox and there is no "selection mode" switch, and no batch bar floats under the tree**. Right-clicking inside a multi-row selection keeps the batch, but the menu label does not change with the count — the scope follows the selection, and it reuses the one transfer queue instead of growing a second one. With more than one target the item first confirms (stating how many items will be downloaded) and then **asks for the destination directory once** before enqueuing the whole batch: the directory comes from the browser's directory handle, else the host's directory picker, else per-file save dialogs — cancelling the picker cancels the batch rather than degrading into N dialogs. The new "Rename" and "Delete" items work for remote rows AND **local workspace rows**: a rename happens **inline on the row** (the name becomes an input; Enter commits, Esc cancels, a refused name keeps the field open and marked invalid), never moves an entry and refuses an existing target; deleting a directory removes its subtree after a confirmation that names the count, the first few entries and the irreversibility; a failure is not optimistically rendered — the list keeps its old state and the reason is shown.

### Connection model

One long-lived connection per alias — one always-open SFTP channel, with shell
commands opening exec channels on the same connection; recycled after 30 minutes idle
(never while an operation is in flight).

The first connection records the server's host-key fingerprint (trust on first use);
a later key that differs is **refused** with both fingerprints in the message — a guard
against man-in-the-middle attacks. After a legitimate host reinstall, "Forget host key"
in the panel re-trusts on next connect.

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

<details>
<summary><b>Expand: the four core implementation paths</b> (no second fs service, bridging host built-ins, taking over ctx.subprocess, workspace registration bypassing realpath)</summary>

<br>

- **No second `fs` service**: remote methods are installed directly onto the
  deployment's already-mounted `ctx.fs` instance as own properties, and all other
  methods forward unchanged to the original backend (bound to its original receiver).
  Installation order doesn't matter.
- **Bridging the host's built-in modules**: `node:fs/promises` `mkdir` / `stat` /
  `lstat` / `realpath` / `readdir` and `node:path.isAbsolute` special-case `ssh://`
  spellings (including `syncBuiltinESMExports`), so calls that happen before any agent
  exists — creating sessions, registering workspaces — also go over SFTP. `node:path`
  `resolve` / `join` / `relative` understand `ssh://` too (change tracking folds git's
  repository paths with them), `copyFile` / `open` / `rm` serve snapshots and
  captures, and `readdir` serves `@` completion's remote directory scans.
- **Taking over `ctx.subprocess`**: subprocesses whose `cwd` is `ssh://` run on the
  remote host — glob / grep's ripgrep and change tracking's git both take this route
  (every other spawn forwards unchanged); the command whitelist, POSIX script
  assembly, and handle contract (`done` / `collected` / `terminate` ladder) match the
  local runtime.
- **Workspace registration bypasses `realpath`**: it goes through
  `createCanonical()`, preserving full persistence and ordered writes while bypassing
  the host's `realpath` assertion.

</details>

## Documentation index

| Doc | Contents |
| --- | --- |
| [features.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md) | **Feature reference**: the complete capability inventory by domain (workspaces / files / execution / transfer / forwarding / UI / security / config / degradation matrix / limits) |
| [architecture.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/architecture.md) | Architecture & implementation: the `ctx.fs` / `ctx.shell` / `ctx.subprocess` takeovers, change watching & streaming, built-in bridges, engine & connection model |
| [protocol.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/protocol.md) | The `ssh://` path protocol: syntax, normalization, display rules, `file:` URIs, the write fence and the detached fence |
| [hosts.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/hosts.md) | Host configuration & auth: storage format, `~/.ssh/config` fallback, panel management |
| [tools.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/tools.md) | Agent tool reference: the 11 `ssh_workspace_*` tools (including `reverse_forward`) |
| [ui.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md) | UI guide: the panel, the dual "Add workspace" entry, remote-workspace marks, the port-forward and persistent-shell sections, the file-reference section |
| [forward-persistence.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/forward-persistence.md) | Port-forward persistence: intent vs. fact, the two disconnect paths agreeing, auto-start |
| [development.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/development.md) | Development, debugging & release: source layout, dependency resolution, packaging |
| [upstream-workarounds.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/upstream-workarounds.md) | Upstream workaround register: host defects, the one-line fix, the self-retiring signal, and the removal steps |
| [upstream-workaround-pattern.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/upstream-workaround-pattern.md) | **The retirement pattern for upstream workarounds**: when it applies, the seven pieces, tri-state probing, a reachable notification channel, anti-patterns, and its cost boundary |
| [troubleshooting.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/troubleshooting.md) | Troubleshooting & FAQ: error semantics, connection issues, known limitations |
| [optimization-and-future03.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/optimization-and-future03.md) | **Optimization items & future work (volume 3, the single ledger)**: what is still open, explicit non-goals, upstream blockers, verification gaps, and an index of closed IDs; volumes 1 and 2 were merged here |
| [CONTRIBUTING.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/CONTRIBUTING.md) | Contributing: environment, the three test tiers, code conventions, before you ship |
| [SECURITY.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/SECURITY.md) | Security policy: how credentials are stored, host-key verification, known boundaries, reporting |
| [CHANGELOG.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/CHANGELOG.md) | Changelog: additions, fixes and changes per version |

---

## License

<div align="center">

**[MIT](https://github.com/siqyka/dsh-ssh-workspace/blob/main/LICENSE) © 2026 siqyka**

<sub>SSH distance, local feel.</sub>

</div>
