# dsh-ssh-workspace

English | [简体中文](./README.md)

Use a directory on an **SSH host as a DSH workspace**.

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

Topic docs (architecture & implementation, path protocol, host configuration, tool
reference, UI guide, development & release, troubleshooting): [docs/](./docs/README.md).

When a session's workspace is such a path, `read` / `write` / `edit` go straight over
SFTP to **read and write remote files directly** — no manual sync, no mount driver,
no third-party filesystem.

## The problem it solves

DSH routes all file operations through a single service abstraction, `ctx.fs`
(`@deepseek-ai/dsh-fs`). This plugin adds a "remote half" to that abstraction:

| Target path | Served by |
| --- | --- |
| `ssh://<alias>/<path>` | This plugin's SFTP backend |
| Everything else (`E:\...`, `/home/...`) | The deployment's original local (sandbox) backend, behavior fully unchanged |

So **everything about local workspaces stays as it was**, including the sandbox write
fence, version guards, and atomic writes; remote workspaces get the same tools and the
same error semantics.

## Installation

1. Open the official desktop client and go to the **Plugins** page under **Settings**
   (or the plugins entry in the left navigation bar);
2. In the plugin manager's install field, enter this repository's address
   `https://github.com/siqyka/dsh-ssh-workspace` and click Install;
3. Restart the client once installation finishes, and you're ready to go.

Host records live in `$DSH_HOME/dsh-ssh.json`; when that file is absent, the plugin
falls back to concrete `Host` blocks in `~/.ssh/config`. So **hosts you have already
configured need no re-entry**.

The "Remote Workspaces" panel can **add / edit / delete** hosts directly, writing back
to `$DSH_HOME/dsh-ssh.json` (atomic writes; fields the plugin doesn't recognize are
preserved). Hosts from `~/.ssh/config` are a **read-only fallback** — the panel never
modifies that file; when the same name exists in both, the store wins. Passwords / key
passphrases are stored **in plaintext** per that store format and are never sent back
to the browser; leaving them blank while editing keeps the current value. Deleting a
host does not automatically unmount its mounted workspaces, but those workspaces
become inaccessible since the host no longer exists. See
[docs/hosts.md](./docs/hosts.md) for the storage format, `~/.ssh/config` parsing
rules, and the credential policy.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `announceToAgent` | `false` | Whether to inject a capability description (a system-prompt section) into every agent |

## Agent tools

| Tool | Purpose |
| --- | --- |
| `ssh_workspace_hosts` | List available hosts (store + `~/.ssh/config` candidates) |
| `ssh_workspace_mount` | Register a remote directory as a workspace and return an `ssh://` path |
| `ssh_workspace_unmount` | Unregister a remote workspace |
| `ssh_workspace_status` | Current mount points and connection state |
| `ssh_workspace_exec` | Run a shell command **on the remote host** |

For tool parameters, return fields, and error semantics, see [docs/tools.md](./docs/tools.md).

## Capabilities and limitations

What it does:

- **Remote file read/write**: `read` / `write` / `edit` run entirely over SFTP, with
  the full error semantics — `FS_STALE_VERSION`, `FS_NOT_OBSERVED`,
  `FS_AMBIGUOUS_EDIT`, `FS_NOT_TEXT`, `FS_TOO_LARGE`, `FS_NOT_FOUND`, and so on.
- **Atomic writes**: a write first lands in a staging file in the same directory, then
  replaces the target. OpenSSH's `posix-rename@openssh.com` is preferred; when the
  server doesn't support it, the plugin degrades to "delete, then rename" (the
  replacement is no longer atomic in that case).
- **Line-ending fidelity**: editing a CRLF file won't rewrite it to LF.
- **Binary and encoding**: text reads reject NUL / invalid UTF-8; `readBytes` returns
  raw bytes.
- **Write fence**: remote writes may only land inside a mounted remote workspace;
  anything outside returns `FS_SANDBOX_DENIED`. Reads are unrestricted.
- **New sessions work**: the host's own `node:fs/promises` calls (the session
  controller's `mkdir`, the workspace registry's `realpath` / `stat`) also route
  `ssh://` paths over SFTP, and `node:path.isAbsolute` — used for session-header
  validation — treats `ssh://` spellings as absolute too. So you can create a session
  directly in a remote workspace: `ssh://...` is no longer `mkdir`-ed as a local path,
  nor judged as relative.
- **Automatic remount after restart**: registered `ssh://` workspaces are remounted
  from the persisted registry on next launch, so you never end up with "still in the
  UI, but the files won't open".
- **The "Workspace Files" sidebar works**: the sidebar file tree lists the remote
  directory directly, and text previews are read over SFTP. `fs.fileUrl` returns the
  canonical `file:` URI of the **remote execution world** per the `dsh-fs` contract
  (POSIX semantics, per-segment percent-encoding); the host only uses it to compute
  relative paths and never treats it as a local file.
- **Host management**: the "Remote Workspaces" panel adds / edits / deletes hosts (key
  paths, auth method, notes, …); changes take effect immediately and drop that alias's
  old connection. `~/.ssh/config` hosts are shown read-only. "Test connection" results
  appear as a toast at the top that auto-dismisses after a few seconds (click to close
  early).
- **"Add workspace" gets a remote entry**: DSH's "Add workspace" button becomes an
  anchored menu offering "New local workspace" (DSH's native directory picker) or
  "New remote workspace" (the plugin's remote-directory dialog: choose a host → browse
  the remote directory level by level → confirm the mount; unwritable directories
  produce a warning and refuse creation).
- **Remote workspaces wear a dedicated mark**: workspaces created by this plugin show
  the plugin's remote mark instead of the plain folder icon in sidebar rows, the
  workspace picker, and the session page's workspace button.
- **Connection reuse**: one long-lived connection + one SFTP channel per alias,
  recycled after 30 minutes idle.

Explicitly **not supported**:

- **Jump hosts / ProxyCommand**: the engine only connects directly to the target host
  (the `ssh2` client has no `proxyJump` wiring). Hosts with `proxyJump` /
  `ProxyCommand` are **explicitly rejected** at parse time with the reason stated,
  rather than silently attempted as direct connections; use another tool to connect
  when you need a jump host.
- **`glob` / `grep` don't search the remote.** These built-in tools spawn ripgrep
  locally against the session `cwd`, so they don't work for `ssh://` workspaces. Use
  `ssh_workspace_exec` in a remote workspace instead, for example:
  `grep -rn "TODO" /home/user/project --include='*.ts'`.
- **Shell tools still run locally.** `pwsh` / `bash` don't reach the remote host; use
  `ssh_workspace_exec` for remote commands.
- **No change watching (watch)**: SFTP has no portable change notification, so per the
  `dsh-fs` contract this returns "unsupported" instead of secretly polling; the
  sidebar file tree degrades silently — no error, it just doesn't auto-refresh.

## Implementation notes

- **No second `fs` service**: remote methods are installed directly onto the
  deployment's already-mounted `ctx.fs` instance as own properties, and all other
  methods forward unchanged to the original backend (bound to its original receiver).
  Installation order doesn't matter.
- **Bridging the host's built-in modules**: `node:fs/promises` `mkdir` / `stat` /
  `lstat` / `realpath` and `node:path.isAbsolute` special-case `ssh://` spellings
  (including `syncBuiltinESMExports`), so calls that happen before any agent exists —
  creating sessions, registering workspaces — also go over SFTP.
- **Workspace registration bypasses `realpath`**: it goes through
  `createCanonical()`, preserving full persistence and ordered writes while bypassing
  the host's `realpath` assertion.

For the full mechanics — the `ctx.fs` takeover, the validation chain the built-in
bridge covers, the engine and connection model, the peer-resolution order — see
[docs/architecture.md](./docs/architecture.md).
