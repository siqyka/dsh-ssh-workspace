# 排查与常见问题

> 定位：出错时先看这里。

## 常见错误语义

文件工具在远端工作区报错时，错误码来自 `FsError`，与本地后端的语义对齐（`lib/remote-fs.js`）：

| 错误码 | 含义 | 常见触发 |
| --- | --- | --- |
| `FS_SANDBOX_DENIED` | 写入越出已挂载的远端工作区 | 目标路径不在任何已挂载根之下——例如向未挂载的 `ssh://` 路径写文件；先 `ssh_workspace_mount` |
| `FS_NOT_FOUND` | 远端目标不存在 | 路径拼写错误、目录已被删除；也用于"不是合法远端路径"的输入 |
| `FS_PERMISSION_DENIED` | 远端账号权限不足 | SFTP 返回 Permission denied；挂载前可先用面板「测试连接」+ 目录浏览确认可写 |
| `FS_STALE_VERSION` / `FS_NOT_OBSERVED` | 并发修改 / 未读先写 | 读过后文件被改动再写回；或直接覆盖一个从未读过的既有文件（先 read 再 write） |
| `FS_AMBIGUOUS_EDIT` / `FS_EDIT_NOT_FOUND` | `edit` 的 `old_string` 匹配不唯一 / 未命中 | 提供更精确的 `old_string` 或 `replace_all: true`；未命中时先重新 read 确认内容 |
| `FS_NOT_TEXT` | 二进制或非法 UTF-8 | 读 / 编辑二进制文件被拒；改用 `ssh_workspace_exec` 配合远端命令处理 |
| `FS_TOO_LARGE` | 超过读取上限 | 文件过大，用远端命令查看而非整读 |
| `FS_NOT_REGULAR_FILE` / `FS_NOT_DIRECTORY` | 目标类型不符 | 对目录 read、对文件 listDir 等 |
| `FS_IO_ERROR` | 其它 SFTP 失败 | 含"远端不支持 watch"（见「已知限制」）与连接中断 |

## 连接问题

按以下顺序排查：

1. **面板「测试连接」**：先在「远程工作区」面板对目标主机实测一次，成功/失败会以顶部 toast 明示，是成本最低的定位手段。
2. **unknown SSH host**：别名既不在 `$DSH_HOME/dsh-ssh.json` 存储中，也没有对应的具体 `Host` 块——检查拼写；`~/.ssh/config` 的 `Include`、`Match`、通配块**不被解析**，请显式写出具体 `Host` 别名，或在面板中添加主机（见 [hosts.md](./hosts.md)）。
3. **认证失败**：key 认证先看主机行的「密钥未就绪」（`check-key`）标识——`keyPath` 在本机不存在或不可读；密码认证确认存储中的密码；agent 认证确认 `SSH_AUTH_SOCK`（或 `agentPath`）可用。密码与口令便于排查时可以临时改用本地 `ssh` 对照验证连通性。
4. **jump host / ProxyCommand 被拒**：插件不支持跳板，`resolve` 会直接报错说明。改用无跳板的主机条目，或换用其它工具连接该主机。
5. **端口 / 网络**：确认 `host` 与 `port` 可达；本地 `ssh -p <port> user@host` 能连通的话，插件侧再查凭据与配置来源（store 覆盖 `~/.ssh/config`，同别名以 store 为准）。

## 已知限制

设计边界，非故障：

- **glob / grep 不搜索远端**：二者使用本机 ripgrep，对远端工作区**不会**命中远端内容；请用 `ssh_workspace_exec` 在远端跑 `grep` / `rg` / `find`。read / write / edit 才走远端文件系统。
- **shell 仍在本地**：`pwsh` / `bash` 工具总在本机执行；远端命令一律经 `ssh_workspace_exec`。
- **不支持变更监视**：`watch` 对远程路径报 `FS_IO_ERROR`（"remote change watch is not supported over SFTP"）。界面表现为文件树**静默降级**——不报错、不自动刷新，重新打开或重新读取即可看到最新内容。
- **不支持 jump host / ProxyCommand**：见上节。
- **原子写的降级**：远端写入采用「同目录暂存文件 + rename 原子替换」。当 SFTP 服务端未广告 `posix-rename@openssh.com` 扩展时，先删除目标再重命名，存在极小的非原子窗口——写入内容不会损坏，但极短时间窗内该路径可能短暂不存在。
- **重启后需重新插上插头**：已登记（register）的 `ssh://` 工作区在重启后自动重新挂载（见 [architecture.md](./architecture.md) 的「工作区登记」）；但如果注册表记录已被清理而挂载仅存在于内存，需重新 `ssh_workspace_mount`。

## 相关

- [hosts.md](./hosts.md) — 主机与凭据配置
- [tools.md](./tools.md) — 工具参数与返回语义
- [protocol.md](./protocol.md) — 路径规范与写入围栏
