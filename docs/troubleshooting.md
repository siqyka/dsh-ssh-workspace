# 排查与常见问题

> 定位：出错时先看这里。

## 常见错误语义

文件工具在远端工作区报错时，错误码来自 `FsError`，与本地后端的语义对齐（`lib/remote-fs.js`）：

| 错误码 | 含义 | 常见触发 |
| --- | --- | --- |
| `FS_OUTSIDE_WORKSPACE` | 写入越出已挂载的远端工作区 | 目标路径既不在任何已挂载根之下、也不在该主机 `/tmp` 之下——例如向未挂载的 `ssh://` 路径写文件；先 `ssh_workspace_mount`。写入 / 删除前还会对目标父目录做一次服务器 `realpath` 裁决，**经符号链接的真实落点越界同样被拒**。`ssh_workspace_transfer` 的上传与浏览器面板的上传走同一对判定，且在发出任何字节之前判定 |
| `FS_SANDBOX_DENIED` | 本机沙箱模式不允许写入 | 会话处于 **`read-only`** 时对远端文件 write / edit。远端目标不会经过本机的 `SandboxedFileSystem.checkedTarget`，所以这条判定由插件自己补上，文案与本地一致。`workspace-write` 要求目标在**会话自己的**工作区之内（远端会话的 root 就是那个 `ssh://` 拼写，可直接比较）或该主机的 `/tmp` 之下；两者之外的目标同样返回此码，文案会点名会话工作区。**三个被认可的模式之外的任意模式字符串**（未来新增的名字、fold 损坏出的值）也返回此码，与本地一致——本地对读不懂的模式一律拒；那时的文案会列出被认可的三个模式，**不会**谎称这是你选的「仅可查看」。**策略解析失败同样返回此码**，但那时的文案会说明是接线问题而非你选的模式——切换模式不会有用 |
| `FS_NOT_FOUND` | 远端目标不存在 | 路径拼写错误、目录已被删除；也用于"不是合法远端路径"的输入 |
| `FS_PERMISSION_DENIED` | 远端账号权限不足 | SFTP 返回 Permission denied；挂载前可先用面板「测试连接」+ 目录浏览确认可写。**工作区被停用时也返回此码**，文案带 `the remote workspace is detached` |
| `FS_STALE_VERSION` / `FS_NOT_OBSERVED` | 并发修改 / 未读先写 | 读过后文件被改动再写回；或直接覆盖一个从未读过的既有文件（先 read 再 write） |
| `FS_AMBIGUOUS_EDIT` / `FS_EDIT_NOT_FOUND` | `edit` 的 `old_string` 匹配不唯一 / 未命中 | 提供更精确的 `old_string` 或 `replace_all: true`；未命中时先重新 read 确认内容 |
| `FS_NOT_TEXT` | 二进制或非法 UTF-8 | 读 / 编辑二进制文件被拒；改用 `ssh_workspace_exec` 配合远端命令处理 |
| `FS_TOO_LARGE` | 超过读取上限 | 文件过大，用远端命令查看而非整读 |
| `FS_NOT_REGULAR_FILE` / `FS_NOT_DIRECTORY` | 目标类型不符 | 对目录 read、对文件 listDir 等 |
| `FS_ABORTED` | 操作被中止 | 调用方 signal 被 abort（用户取消、超时、会话关闭）；不是故障，重试即可 |
| `FS_IO_ERROR` | 其它 SFTP 失败 | SFTP 服务端报错、连接中断等 |

### 一整个工作区都在报错？先看它是不是被停用了

`ssh_workspace_unmount`（以及面板里的卸载）默认是 **`detach` 模式**：工作区记录和会话都保留，
但该路径下的**一切**操作都会被拒绝——读写、列目录、变更监视、执行命令、开终端、glob / grep / git、传输，
无一例外。这是停用造成的，**不是远端文件不存在**。

判据是错误文案里带 `the remote workspace is detached`：

```
cannot access "ssh://myserver/home/user/project/src/app.ts": the remote workspace is detached
(re-enable it in the panel or with ssh_workspace_enable)
```

恢复方式：面板点该行的「启用」，或调 `ssh_workspace_enable`（默认同时把归档的会话恢复出来）。
只有 SSH 连接本身（`test`、目录浏览、端口转发）不受停用影响——这也是为什么「测试连接」还能成功却什么都读写不了：
连接活着，围栏关着。代码是 `FS_PERMISSION_DENIED`（不是 `FS_SANDBOX_DENIED`）：停用不是沙箱策略，
升权也解不开一个被关掉的工作区。

### 「仅可查看」真的会挡住写入——包括远端

会话切到 `read-only` 后，远端 write / edit 会以 `[sandbox: file access denied under read-only mode]`
被拒。这一点是**插件自己补上的**：本机沙箱只在 `ctx.fs` 的本地实现里生效，远端目标走的是插件的
SFTP 分支，从来不会经过它。

**同样被拒的还有命令执行**：`ssh_workspace_exec`、`ssh_workspace_shell`，以及 workdir 落在远端的
`bash` / `pwsh`。它们返回的不是 `[sandbox: …]` 标记，而是一句自述原因的文案——因为这里根本没有沙箱
可以围栏（本机内核边界跨不过 SSH），插件能做的是拒绝。文案里会写明「切到 workspace-write 或
danger-full-access」。读（`read` / `glob` / `grep`）不受影响。

> 这条曾经是真实缺口：`read-only` 会话跑 `ssh_workspace_exec { command: "rm …" }` 拿到 `[exit code: 0]`。
> 修的是「命令执行面从不看模式」，不是某一条命令的特判。

判据是错误码与文案：

| 你看到的 | 真实原因 | 怎么办 |
| --- | --- | --- |
| `[sandbox: … under read-only mode]` | 会话模式是仅可查看 | 切到 `workspace-write` / `danger-full-access`，或对单次调用升权 |
| `cannot run a remote command …: the session sandbox mode is "read-only"` | 同上，但目标是命令而非文件 | 切换会话模式；升级对这条不起作用，插件工具没有 `sandbox_permissions` 字段 |
| `FS_OUTSIDE_WORKSPACE` + `outside every mounted remote workspace` | 目标不在任何已挂载根下（也不在该主机 `/tmp` 下） | 先 `ssh_workspace_mount`；**升权没有用**，模式再宽也不会让目录变成已挂载 |
| `FS_PERMISSION_DENIED` + `the remote workspace is detached` | 工作区被停用 | 面板「启用」或 `ssh_workspace_enable` |

> 这三种失败过去都返回 `FS_SANDBOX_DENIED`，而宿主的工具层会把该码改写成
> `[sandbox: file access denied under <mode> mode]` 加一句「可升权重试」。于是围栏外写文件会得到
> 「在 danger-full-access 下被拒」这种自相矛盾的提示，模型接下来会去申请一个对「没挂载」毫无作用的升级。
> 拆成独立的码，是为了让这几句真话能原样到达模型眼前。

## 打开远端会话报「历史加载失败」

界面上出现：

```
历史加载失败：failed to project session "session-…": [ { "code": "custom", "path": [], "message": "Invalid input" } ]（gateway/internal）
```

**这不是会话损坏，也不用删缓存。** 它只发生在 `cwd` 是 `ssh://…` 的会话上，本地路径的会话不受影响。

原因在宿主的 `@deepseek-ai/dsh-working-directory`：它把会话目录注册成一个投影单元，schema 写成

```js
const directorySchema = z.string().min(1).refine(isAbsolute).nullable()
```

`refine(isAbsolute)` 传给 zod 的是**函数值**——模块 `import { isAbsolute } from "node:path"` 在服务构造那一刻持有的那个函数。插件随后替换 `node:path.isAbsolute` 并调用 `syncBuiltinESMExports()`，那只能让**读取绑定**的调用方（会话头校验、`fs-local` 等）看到补丁；已经被当作值捕获的 schema 仍在调用原始 `isAbsolute`，对 `ssh://host/path` 返回 `false`，于是校验失败。

插件的加载顺序永远晚于 `working-directory`（它在 roster 里排在前面），也**不应该**去改部署自带的 bundle，所以修复放在插件侧：`lib/patch-projection.js` 把该单元已注册的 `stateSchema` / `wire.viewSchema` 换成一个惰性判定（`ssh://` 直接放行，其余仍走原 schema）。这条判定覆盖了 `restore` / `viewCheckpoint` / `snapshot` / `cachedSnapshot` / `hydrate` 与变更推送全部读路径。

放宽的范围只有 `ssh://` 这一个形态：相对路径、空字符串照旧被拒，`null` 照旧通过，其它投影单元完全不动。

如果你在**没有**装这个插件（或插件未激活）的部署上看到这条报错，那说明该会话确实带着一个宿主无法解释的 `cwd`——此时才是真的需要修数据。

这条修复是**上游临时补丁**，登记为 `UPSTREAM-1-working-directory-isAbsolute`：DSH 把
`refine(isAbsolute)` 改成 `refine((value) => isAbsolute(value))` 之后它就不再需要，届时本插件
会在启动日志里打一行 `… is no longer needed …`，并停止打补丁。机制与删除步骤见
[upstream-workarounds.md](./upstream-workarounds.md)。

## 连接问题

**先看诊断历史**：环形缓冲的**容量是 40 条**（`lib/diagnostics.js` 的 `CAPACITY`），
但每个导出面只取最新的一部分：`ssh_workspace_status` 的 `events` 字段是 10 条，
面板 `/status` 路由、`diagnosticsText` 与「诊断报告」都是 20 条。容量与导出条数是两回事，
别把它们当成同一个数。它通常是「刚才发生了什么」最快的答案：一条 `disconnect`
带时间戳，比读日志快得多——何况这个部署里 `ctx.logger` 根本没有出口（宿主不装 console
exporter，`debug` 又被默认级别丢弃），见 [development.md](./development.md#日志与诊断)。

`degraded` 尤其值得注意，它表示功能悄悄降级了：

- `inotifywait watcher ended; fell back to polling` —— 文件树改为轮询，同一秒内等长的连续
  改写可能不再触发刷新；
- `stream channel unavailable` —— 大文件读取退回了共享 SFTP 通道，会拖慢同连接上的其它操作。

两者都不影响正确性，但会让"为什么没反应 / 为什么变慢了"有据可查。

### 断线之后没有反应？

连接掉线后会自动在后台重试，面板上那张主机卡片显示 `重连中（第 N 次，M 秒后）`。
不需要点任何按钮——笔记本合盖、Wi-Fi 切换、VPN 重连之后回到界面，等几秒就该恢复。

| 看到什么 | 含义 | 该做什么 |
| --- | --- | --- |
| `重连中（第 N 次，M 秒后）` | 后台循环在跑 | 不用动；急的话点「立即重连」跳过等待 |
| `重连中（第 N 次）` | 一次尝试正在进行（握手最长 15 秒） | 等这一轮结束 |
| `重连已停止` + 红字原因 | 已放弃：不可恢复的配置问题（别名不存在、私钥读不到、主机密钥不匹配），或这个主机已经没有消费者了 | 按红字修配置，再点「立即重连」 |
| `已断开` | 有连接记录但没人在重试——通常是主动断开，或该主机没有被任何东西使用 | 点「立即重连」，或打开该主机下的工作区 |

两条刻意的设计，看到时不要当成 bug：

- **没有消费者的主机不会被拨号**：卸载了该主机最后一个工作区、也没有「开启」状态的保存转发时，后台循环会停——
  否则关掉的工作区会一直把主机连回来。重新挂载或点「立即重连」即可。
- **「断开」是终态**：手动断开后不会自动重连，否则那个按钮就毫无意义。下一次操作（打开文件、跑命令）会按需连上。

`ssh_workspace_status` 的 `reconnecting` 字段给出同样的信息：`phase` 为 `waiting` / `connecting` / `gave-up`，
`attempts` 是次数，`nextAt` 是下一次尝试的毫秒时间戳。

按以下顺序排查：

1. **面板「测试连接」**：先在「远程工作区」面板对目标主机实测一次，成功/失败会以顶部 toast 明示，是成本最低的定位手段。
2. **unknown SSH host**：别名既不在 `$DSH_HOME/dsh-ssh.json` 存储中，也没有对应的具体 `Host` 块——检查拼写；`~/.ssh/config` 的 `Include`、`Match`、通配块**不被解析**，请显式写出具体 `Host` 别名，或在面板中添加主机（见 [hosts.md](./hosts.md)）。
3. **认证失败**：key 认证先看主机行的「密钥未就绪」（`check-key`）标识——`keyPath` 在本机不存在或不可读；密码认证确认存储中的密码；agent 认证确认 `SSH_AUTH_SOCK`（或 `agentPath`）可用。密码与口令便于排查时可以临时改用本地 `ssh` 对照验证连通性。存储中的密码/口令是加密的，若报 `cannot read the stored secret for host …`，说明 `$DSH_HOME/dsh-ssh.key` 缺失或被更换——在面板重新保存该主机（见 [hosts.md](./hosts.md)）。
4. **主机密钥不匹配**：连接被拒，错误信息为「the server presented a different host key than the one recorded on first connect」并列出 `recorded` / `presented` 两个指纹。含义：该主机本次出示的密钥与首次连接时记录的（`dsh-ssh.json` 的 `knownHosts` 段）不一致——可能是主机重装系统或合法轮换了密钥，也可能是中间人。**先与管理员核对新指纹**；确认可信后，在「远程工作区」面板对该主机执行「忘记主机密钥」，再重连（重新 TOFU 记录）。若没有预期的密钥变更，不要继续连接。
5. **jump host / ProxyCommand 被拒**：插件不支持跳板，`resolve` 会直接报错说明。改用无跳板的主机条目，或换用其它工具连接该主机。
6. **端口 / 网络**：确认 `host` 与 `port` 可达；本地 `ssh -p <port> user@host` 能连通的话，插件侧再查凭据与配置来源（store 覆盖 `~/.ssh/config`，同别名以 store 为准）。
7. **面板接口 403 / 请求被拒**：宿主路由只服务本机（回环地址且 `Host` 头为本机监听的 `localhost`/`127.0.0.1`/`[::1]` 拼写）。如果你通过反向代理或自定义域名访问 DSH 界面，这些请求会被拒——属预期行为（防 DNS rebinding），不是故障。

## 已知限制

设计边界，非故障：

- **远端搜索与变更追踪依赖远端工具**：glob / grep 在远端工作区调用远端主机的 ripgrep——远端未安装 `rg` 时命令以退出码 127 失败，stderr 带安装提示（如 `sudo apt install ripgrep` / `brew install ripgrep`）。「变更」（deliverables）面板使用远端 git——远端未安装 `git` 时该能力按「无仓库」降级（每回合一条带安装提示的 warn），不阻断会话；远端目录不是 git 仓库时与本地行为一致（只列文件工具改动）。
- **shell 命令落点由 `workdir` 决定**：`pwsh` / `bash` 工具的 `workdir` 为 `ssh://` 时命令在远端主机执行，按 POSIX shell 语义、不受本机文件沙箱约束（以远端登录用户权限运行）；本地 `workdir` 的命令仍在本机、仍受沙箱围栏。要跑到未挂载的路径上，或需要确认某条命令到底在哪台机器执行，用 `ssh_workspace_exec`。
- **变更监视：优先事件推送，否则轮询**：远端有 `inotifywait` 时，监视走 `inotifywait -m` 的事件流，变更即时上报，也不受元数据精度限制。没有该工具（或该路径无法被监视）时回落到轮询——SFTP 没有可移植的变更通知，文件树 / 预览的自动刷新靠 stat / readdir 快照比对，基础间隔约 2 秒，空闲目录会自适应退避到 5–10 秒，任一变更立即回到 2 秒（见 [architecture.md](./architecture.md) 的「远端变更监视」）；读路径另有 1.5 秒的元数据缓存，但变更检测直读服务器、不吃缓存。轮询模式下 SFTP 元数据没有亚秒时间戳——同一秒内等长的连续改写可能**不触发**刷新（增、删、改名总能感知）；需要立即看到最新内容时重新打开或重新读取即可。推送通道意外中断时会自动重新挂上轮询，不会静默失效；无法继续的监视故障会以一次 Error 回调上报（界面按既有的失效路径处理），不会静默挂死。
- **不支持 jump host / ProxyCommand**：见上节。
- **后台重连有上限，且需要「有人在用」**：重试间隔从 1 秒指数增长到 60 秒封顶，默认不限次数，
  但只在还有消费者时进行（已挂载工作区、已保存且开启的转发）。进程退出后没有后台循环，重启 DSH
  才会重新连接。策略可用插件配置 `engine.reconnect` 调整（见根 README 的配置表），
  设 `engine.reconnect: false` 可退回「只在操作时重连一次」的旧行为。
- **原子写的降级**：远端写入采用「同目录暂存文件 + rename 原子替换」。当 SFTP 服务端未广告 `posix-rename@openssh.com` 扩展时，先删除目标再重命名，存在极小的非原子窗口——写入内容不会损坏，但极短时间窗内该路径可能短暂不存在。
- **重启后需重新插上插头**：已登记（register）的 `ssh://` 工作区在重启后自动重新挂载（见 [architecture.md](./architecture.md) 的「工作区登记」）；但如果注册表记录已被清理而挂载仅存在于内存，需重新 `ssh_workspace_mount`。

## 相关

- [hosts.md](./hosts.md) — 主机与凭据配置
- [tools.md](./tools.md) — 工具参数与返回语义
- [protocol.md](./protocol.md) — 路径规范与写入围栏
