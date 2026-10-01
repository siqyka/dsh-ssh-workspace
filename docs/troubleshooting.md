# 排查与常见问题

> 定位：出错时先看这里。

## 常见错误语义

文件工具在远端工作区报错时，错误码来自 `FsError`，与本地后端的语义对齐（`lib/remote-fs.js`）：

| 错误码 | 含义 | 常见触发 |
| --- | --- | --- |
| `FS_SANDBOX_DENIED` | 写入越出已挂载的远端工作区 | 目标路径不在任何已挂载根之下——例如向未挂载的 `ssh://` 路径写文件；先 `ssh_workspace_mount`。写入 / 删除前还会对目标父目录做一次服务器 `realpath` 裁决，**经符号链接的真实落点越界同样被拒** |
| `FS_NOT_FOUND` | 远端目标不存在 | 路径拼写错误、目录已被删除；也用于"不是合法远端路径"的输入 |
| `FS_PERMISSION_DENIED` | 远端账号权限不足 | SFTP 返回 Permission denied；挂载前可先用面板「测试连接」+ 目录浏览确认可写 |
| `FS_STALE_VERSION` / `FS_NOT_OBSERVED` | 并发修改 / 未读先写 | 读过后文件被改动再写回；或直接覆盖一个从未读过的既有文件（先 read 再 write） |
| `FS_AMBIGUOUS_EDIT` / `FS_EDIT_NOT_FOUND` | `edit` 的 `old_string` 匹配不唯一 / 未命中 | 提供更精确的 `old_string` 或 `replace_all: true`；未命中时先重新 read 确认内容 |
| `FS_NOT_TEXT` | 二进制或非法 UTF-8 | 读 / 编辑二进制文件被拒；改用 `ssh_workspace_exec` 配合远端命令处理 |
| `FS_TOO_LARGE` | 超过读取上限 | 文件过大，用远端命令查看而非整读 |
| `FS_NOT_REGULAR_FILE` / `FS_NOT_DIRECTORY` | 目标类型不符 | 对目录 read、对文件 listDir 等 |
| `FS_IO_ERROR` | 其它 SFTP 失败 | SFTP 服务端报错、连接中断等 |

## 连接问题

按以下顺序排查：

1. **面板「测试连接」**：先在「远程工作区」面板对目标主机实测一次，成功/失败会以顶部 toast 明示，是成本最低的定位手段。
2. **unknown SSH host**：别名既不在 `$DSH_HOME/dsh-ssh.json` 存储中，也没有对应的具体 `Host` 块——检查拼写；`~/.ssh/config` 的 `Include`、`Match`、通配块**不被解析**，请显式写出具体 `Host` 别名，或在面板中添加主机（见 [hosts.md](./hosts.md)）。
3. **认证失败**：key 认证先看主机行的「密钥未就绪」（`check-key`）标识——`keyPath` 在本机不存在或不可读；密码认证确认存储中的密码；agent 认证确认 `SSH_AUTH_SOCK`（或 `agentPath`）可用。密码与口令便于排查时可以临时改用本地 `ssh` 对照验证连通性。
4. **主机密钥不匹配**：连接被拒，错误信息为「the server presented a different host key than the one recorded on first connect」并列出 `recorded` / `presented` 两个指纹。含义：该主机本次出示的密钥与首次连接时记录的（`dsh-ssh.json` 的 `knownHosts` 段）不一致——可能是主机重装系统或合法轮换了密钥，也可能是中间人。**先与管理员核对新指纹**；确认可信后，在「远程工作区」面板对该主机执行「忘记主机密钥」，再重连（重新 TOFU 记录）。若没有预期的密钥变更，不要继续连接。
5. **jump host / ProxyCommand 被拒**：插件不支持跳板，`resolve` 会直接报错说明。改用无跳板的主机条目，或换用其它工具连接该主机。
6. **端口 / 网络**：确认 `host` 与 `port` 可达；本地 `ssh -p <port> user@host` 能连通的话，插件侧再查凭据与配置来源（store 覆盖 `~/.ssh/config`，同别名以 store 为准）。
7. **面板接口 403 / 请求被拒**：宿主路由只服务本机（回环地址且 `Host` 头为本机监听的 `localhost`/`127.0.0.1`/`[::1]` 拼写）。如果你通过反向代理或自定义域名访问 DSH 界面，这些请求会被拒——属预期行为（防 DNS rebinding），不是故障。

## 已知限制

设计边界，非故障：

- **远端搜索与变更追踪依赖远端工具**：glob / grep 在远端工作区调用远端主机的 ripgrep——远端未安装 `rg` 时命令以退出码 127 失败，stderr 带安装提示（如 `sudo apt install ripgrep` / `brew install ripgrep`）。「变更」（deliverables）面板使用远端 git——远端未安装 `git` 时该能力按「无仓库」降级（每回合一条带安装提示的 warn），不阻断会话；远端目录不是 git 仓库时与本地行为一致（只列文件工具改动）。
- **shell 命令落点由 `workdir` 决定**：`pwsh` / `bash` 工具的 `workdir` 为 `ssh://` 时命令在远端主机执行，按 POSIX shell 语义、不受本机文件沙箱约束（以远端登录用户权限运行）；本地 `workdir` 的命令仍在本机、仍受沙箱围栏。要跑到未挂载的路径上，或需要确认某条命令到底在哪台机器执行，用 `ssh_workspace_exec`。
- **变更监视是轮询式的**：SFTP 没有可移植的变更通知，文件树 / 预览的自动刷新靠轮询（stat / readdir 快照比对）——基础间隔约 2 秒，空闲目录会自适应退避到 5–10 秒，任一变更立即回到 2 秒（见 [architecture.md](./architecture.md) 的「远端变更监视」）；读路径另有 1.5 秒的元数据缓存，但变更检测直读服务器、不吃缓存。SFTP 元数据没有亚秒时间戳——同一秒内等长的连续改写可能**不触发**刷新（增、删、改名总能感知）；需要立即看到最新内容时重新打开或重新读取即可。无法继续的轮询故障会以一次 Error 回调上报（界面按既有的失效路径处理），不会静默挂死。
- **不支持 jump host / ProxyCommand**：见上节。
- **原子写的降级**：远端写入采用「同目录暂存文件 + rename 原子替换」。当 SFTP 服务端未广告 `posix-rename@openssh.com` 扩展时，先删除目标再重命名，存在极小的非原子窗口——写入内容不会损坏，但极短时间窗内该路径可能短暂不存在。
- **重启后需重新插上插头**：已登记（register）的 `ssh://` 工作区在重启后自动重新挂载（见 [architecture.md](./architecture.md) 的「工作区登记」）；但如果注册表记录已被清理而挂载仅存在于内存，需重新 `ssh_workspace_mount`。

## 相关

- [hosts.md](./hosts.md) — 主机与凭据配置
- [tools.md](./tools.md) — 工具参数与返回语义
- [protocol.md](./protocol.md) — 路径规范与写入围栏
