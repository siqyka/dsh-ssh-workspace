# Agent 工具参考

> 定位：五个 `ssh_workspace_*` 工具的用途、参数与返回。

这些工具都不复制文件能力：文件内容由 `ctx.fs`（SFTP）服务，`read` / `write` /
`edit` 已经能在远端工作区工作；会话工作区为 `ssh://` 时，pwsh / bash 工具的
命令也由本插件路由到远端执行，glob / grep 的 ripgrep 与工作区变更追踪的 git
同样（走 `ctx.subprocess` 接管）。工具补齐的是主机发现、挂载/卸载、状态，
以及**不依赖挂载的远端命令执行**。

## ssh_workspace_hosts

列出可用主机：存储条目 + `~/.ssh/config` 的具体 Host 块。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `query` | 否 | 大小写不敏感，匹配 alias / host / user / description / tags |

返回 `hosts[]`，每项含 `alias`、`host`、`port`、`user`、`auth`
（`key` / `password` / `agent`）、`keyReady`、`source`（`store` / `ssh-config`）、
`description`、`tags`。

## ssh_workspace_mount

把远端目录挂载为工作区。挂载前会先 `stat` 验证目录**真实存在且是目录**，
失败返回明确错误（`no such directory on <alias>: <path>`）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `alias` | 是 | 来自 `ssh_workspace_hosts` |
| `remotePath` | 是 | 远端绝对目录路径，如 `/home/user/project` |
| `title` | 否 | 工作区显示名（默认取目录名） |
| `register` | 否 | 是否同时登记为持久工作区（默认 `true`） |

返回 `ok`、`workspacePath`（`ssh://` 拼写，可直接用作会话工作区）、`title`、
`registered`、`workspaceId`、`entryCount`、`error`。
登记失败时仍挂载在进程内，`error` 给出登记失败的原因。

## ssh_workspace_unmount

停止服务一个已挂载的远端目录，并在登记过时删除工作区记录
（活动中的会话保留自己持有的路径副本）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `workspacePath` | 是 | `ssh_workspace_mount` 返回的 `ssh://` 路径 |
| `deregister` | 否 | 是否同时删除持久工作区记录（默认 `true`） |

返回 `ok`、`wasMounted`、`deregistered`、`error`。

## ssh_workspace_status

无参数。返回当前挂载点 `mounted[]`、活动连接
`connections[{ alias, state, inFlight }]`（`state` 为 `connected` / `broken`）、
以及 `fsPatched`（远端服务是否在役）。

## ssh_workspace_exec

**在远端**执行 shell 命令，不依赖工作区挂载：主机巡检、挂载前查看目录、
会话工作区之外的路径都走它（工作区内的日常命令直接用 pwsh / bash 工具，
`ssh://` workdir 已被路由到远端）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `alias` | 是 | 主机别名 |
| `command` | 是 | 远端 shell 命令 |
| `cwd` | 否 | 远端工作目录 |
| `timeoutMs` | 否 | 超时毫秒（默认 60000） |

返回 `success`、`exitCode`（整数或 null）、`timedOut`、`stdout`、`stderr`、
`truncated`、`durationMs`、`error`。

## 通用约定

- 路径一律使用 `ssh://` 实际拼写（不含显示用的 `@`）；
- 错误语义与 `ctx.fs` 同一套（`FS_*` 码），写入围栏对工具触发的写同样生效；
- glob / grep 在远端工作区调用**远端主机的 ripgrep**（需远端已安装 `rg`，
  缺失时命令以退出码 127 失败并附安装提示）；工作区变更追踪用**远端 git**
  （未安装时该功能自动降级，不阻断会话）。本地工作区不受影响。

## 相关

- [protocol.md](./protocol.md)
- [根 README](../README.md)
