# Agent 工具参考

> 定位：十一个 `ssh_workspace_*` 工具的用途、参数与返回。

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
`description`、`tags`，以及下列可选字段：

| 字段 | 说明 |
| --- | --- |
| `agentForward` | 是否转发 agent。它是**安全相关的授权**，所以明说出来而不是隐藏 |
| `compress` | 是否开启 SSH 压缩 |
| `lastUsedAt` | 上次成功使用的时间（epoch 毫秒）；从未用过则**缺席** |
| `unsupported[]` | 该主机 ssh-config 块里声明了、但插件**不处理**的关键字：`{ keyword, value, verdict, detail }`，`verdict` 为 `lost` / `refused` / `ignored` |

`description`、`lastUsedAt`、`unsupported` 在「没有内容」时**整个字段缺席**，而不是取值
`undefined`——后者在 JSON 里不可表示，DSH 0.2.2-rc.1 起会把整个返回值判为
"not lossless JSON" 并拒绝调用。`description` 缺席与「用户没写描述」在语义上相同，所以缺席
是更诚实的编码。

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

停用一个已挂载的远端目录。**默认不删除任何东西**：工作区记录保留（侧边栏那一行
仍在，置灰且按钮不可点），会话也**保留不归档**——记录还在，那个分组就还在，把会话藏起来
等于把用户特意保留的分组清空。

停用后该工作区内的**所有操作都被拒绝**——读文件、列目录、写、变更监视、执行命令、
开终端、跑 glob / grep / git、传输文件；SSH 连接本身保留（主机面板、
不带 cwd 的 `ssh_workspace_exec`、端口转发都照常可用）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `workspacePath` | 是 | `ssh_workspace_mount` 返回的 `ssh://` 路径 |
| `mode` | 否 | `detach`（默认，保留工作区记录）或 `deregister`（同时删除记录） |
| `archiveSessions` | 否 | 是否归档会话。**默认跟随模式**：`detach` 为 `false`，`deregister` 为 `true`。显式传值优先 |

返回 `ok`、`mode`、`wasMounted`、`deregistered`、`archived[]`（成功归档的会话 id）、
`archiveFailed[{ sessionId, error }]`、`error`。

**两个模式的作用范围**（这是最容易搞错的一点）：

| 模式 | 工作区记录 | 侧栏那一行 | 面板「已停用」那一行 | 会话 |
| --- | --- | --- | --- | --- |
| `detach`（默认） | 保留 | 保留，置灰且按钮不可点 | 保留，可「启用」 | **保留，不归档** |
| `deregister` | 删除 | 消失 | **消失** | 归档 |

「保留记录却不保留会话」是自相矛盾的：`detach` 留住侧栏那个分组，就是为了让用户还能
点开它；归档等于把分组内容清空——行还在，点开却是空的，比删掉更让人困惑。所以归档
跟随「删除记录」，而不是一个独立开关。

`deregister` 会同时清掉**持久停用清单**与**运行时围栏**两处标记。只删记录而不清
标记，会留下一个「面板里还挂着启用按钮、实际任何地方都不存在」的工作区，而这个
路径的运行时围栏又拒绝一切操作——用户无从恢复。`forget` 作为旧拼写被接受并归一化
为 `deregister`，两者不会各自漂移。

**归档是逐个进行的，失败不中断**：有正在跑回合 / 子智能体 / 后台任务的会话会被
registry 拒绝（这是它的文档化行为，本工具不传 `stopActivity`，因为卸载工作区不等于
要求中止正在进行的对话）。被拒的会话留在列表里，并逐条出现在 `archiveFailed`。

> 本工具**没有**「删除会话」选项。DSH 没有公开的会话删除 API，绕过服务层直接
> unlink 会话日志会留下孤儿数据，所以归档是这里能给出的最强且可恢复的语义。

## ssh_workspace_enable

把一个被停用的工作区重新挂载，并取消归档它的会话。这是 `detach` 的逆操作。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `workspacePath` | 是 | 之前停用的 `ssh://` 路径 |
| `unarchiveSessions` | 否 | 是否取消归档会话（默认 `true`） |

返回 `ok`、`workspacePath`、`registered`、`unarchived[]`、
`unarchiveFailed[{ sessionId, error }]`、`error`。

启用前会先 `stat` 验证远端目录仍然存在——否则会得到一个「看起来在服务、实际
ENOENT」的工作区。工作区记录若已被 `deregister` 模式删掉，会重新
`createCanonical` 建一条。

## ssh_workspace_status

无参数。返回当前挂载点 `mounted[]`、**已停用**的工作区 `disabled[]`、活动连接
`connections[{ alias, state, inFlight }]`（`state` 为 `connected` / `broken`）、
打开中的端口转发 `forwards[]`、持久会话 `shells[{ alias, session, alive, startedIn?, reopens }]`、
最近的诊断事件 `events[{ seq, at, kind, message, alias? }]`，
以及 `fsPatched`（远端服务是否在役）。

`mounted` 与 `disabled` 是互斥的两个集合：停用会把路径从前者移到后者。

`events` 是最多 10 条、最新的在后的状态转换记录（`kind` 为 `connect` / `disconnect` /
`reconnect` / `degraded` / `forward` / `upstream`）。它存在的理由是这个部署里 `ctx.logger` 没有出口：
宿主不装 console exporter，`debug` 级别又低于所有 exporter 的默认级别，所以**这是唯一
能被用户读到的连接历史**。排查「为什么刚才断了」「为什么文件树不刷新」先看这里——
`degraded` 表示 `inotifywait` 推送失效退回轮询，或大文件读取退回了共享 SFTP 通道。

`seq` 是环形缓冲区的自增序号。它必须出现在返回值里，因为**环会淘汰旧条目**：没有 `seq`，
两条相邻的记录看起来就是连续的，而实际的「中间漏掉了几条」正是判读一次断线所依据的信息。
（这个字段一直由 `lib/diagnostics.js` 产生，只是最初的 schema 没声明它——DSH 0.2.2-rc.1
开始真正校验工具返回值，于是整个 status 调用被拒。）

`shells[].startedIn` 是会话**启动时**所在的目录，不是当前目录（远端 shell 的当前目录从这里
观测不到，叫 `cwd` 会被误读）；启动记录已随会话关闭而消失时该字段**缺席**，而不是取值
`undefined`——后者在 JSON 里不可表示，会让整个返回值被判为 "not lossless JSON"。`reopens`
是该会话被重开的次数。

### 连接代次

每条连接带 `generation`（本次会话里该主机成功连接过几次）与 `generationNote`（一句
说明）。第 1 代是常态，`generationNote` 只说「first generation」；**第 2 代起**说的是：

> connected (generation N); anything started before the reconnect may still be running on the host

这是这个插件唯一能诚实给出的「恢复」语义。远端进程在 TCP 断开后通常继续运行（取决于
`nohup` / 会话），插件看不到；它能恢复的是自己拥有的东西（连接池、已存隧道、监视器），
不能恢复它只是**启动过**的东西。所以它报告代次，而不是声称连续。

### 自检、命令与诊断报告

`selfCheck[]`：每台被探测过的主机一条 `{ alias, missing[], rows[], text }`。`rows` 是三态
（`present` / `absent` / `unknown`），`text` 与面板渲染的是同一份措辞。**只有 `absent` 带
`install` 提示**——给 `unknown` 也加提示，等于请用户去装一个他可能早有的工具。

`commands[]`：最近 20 条远端命令（已脱敏），字段 `seq / at / alias / command / channel /
durationMs / exitCode / timedOut`，以及可选的 `outcomeUnknown`、`refused`、`cwd`、`error`。
`refused: true` 是唯一确定「没跑」的条目。渲染时只列失败、超时、结果未知与被拒绝的，因为
一条成功的 `ls` 不是新闻。

`auditText`：同一份记录的可粘贴文本。`supportBundle`：完整诊断报告（面板与文档里叫「诊断
报告」，字段名沿用 `supportBundle` 不变）——开头是 `## diagnosis` 判定，然后是版本、补丁
判定、主机密钥、主机配置（含 `~/.ssh/config` 里未被采用的条目与被跳过的条目）、工作区、
连接（含代次）、转发、每主机自检、命令与事件，路径与凭据已脱敏。

`diagnosis`：面板状态灯的判定，`{ version, state, warn, unknown, findings[], notes[], text }`。
`state` 三值——`ok` / `warn` / `unknown`——且**只有需要处理的事项才进 `findings`**，所以
`findings` 为空恰好等价于 `state: 'ok'`。判定只读上面这些字段，不探测、不连接、不读文件。
它和报告、面板是同一个模块（`lib/diagnosis.js`），三处不会讲三个故事。

`notes`：自检的观察结果，**不计入判定**。缺 `rg`、非 UTF-8 locale、watch 上限偏低这类
事实属于「那台主机就是这样」，不是「这个会话出了事」——它们往往在主机侧改不了，混进
`findings` 只会让圆点在健康的机器上变红。行与 `findings` 同形状（`id` / `state` / 可选的
`alias` / `detail`），所以渲染可以复用；但 `state` / `warn` / `unknown` 只从 `findings` 算。
`text` 里它们出现在 `advisory (not counted in the verdict):` 一节，标记为 `NOTE`。

## ssh_workspace_exec

**在远端**执行 shell 命令，不依赖工作区挂载：主机巡检、挂载前查看目录、
会话工作区之外的路径都走它（工作区内的日常命令直接用 pwsh / bash 工具，
`ssh://` workdir 已被路由到远端）。

每次调用是一个**全新进程**：`cd`、导出的变量、后台任务都不会保留。需要保留
状态时用 `ssh_workspace_shell`。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `alias` | 是 | 主机别名 |
| `command` | 是 | 远端 shell 命令 |
| `cwd` | 否 | 远端工作目录 |
| `timeoutMs` | 否 | 超时毫秒（默认 60000）；`run_in_background` 时忽略 |
| `run_in_background` | 否 | 作为后台任务启动，立即返回 job id |

返回 `success`、`exitCode`（整数或 null）、`timedOut`、`stdout`、`stderr`、
`truncated`、`durationMs`、`error`；后台模式下额外返回 `jobId`，用
`job_output` / `job_kill` 收集与终止。部署没有 `ctx.jobs`（或该 owner 无控制器）
时自动内联执行，不会返回无人能读的 id。

**`cwd` 落在已停用的工作区内时调用被拒绝**；不带 `cwd`（登录目录）或 cwd 在工作区
之外照常执行——这正是「停用工作区但保留 SSH 连接」的含义。

## ssh_workspace_shell

在**持久**的远端 shell 里执行命令：同一 (主机, 会话名) 上维持一个 POSIX `sh`，
`cd`、导出的变量与后台任务跨调用保留，等同于一直使用同一个终端。

远端 shell **固定是 POSIX `sh`**，即使本机是 Windows 也请写 POSIX 语法。
部署自带的 persistent bash / pwsh 工具按本机方言构造命令行（Windows 上是
PowerShell），无法驱动远端主机，因此本插件单独提供这个工具而不是接管它们。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `alias` | 是 | 主机别名 |
| `command` | 否 | POSIX shell 命令；`close: true` 时可省 |
| `session` | 否 | 会话名（默认 `default`），不同名字互不干扰 |
| `close` | 否 | 关闭该会话并释放，而不是执行命令 |
| `timeoutMs` | 否 | 等待命令结束的毫秒（默认 60000） |

返回 `ok`、`output`、`exitCode`、`session`、`reused`（本次调用是否复用了已有
会话）；关闭时返回 `closed`（关闭的会话数）。

退出码通过命令行末尾追加的标记行取回：PTY 没有独立退出通道，`$?` 被立即
捕获并随标记一起打印，因此输出里的标记行不会混进 `output`。

## ssh_workspace_transfer

在**本机与远端**之间经 SFTP 双向拷贝文件，字节不经过对话内容。适合推送构建
产物、拉取日志；**不**用于编辑文件（挂载工作区里的 read / write / edit 已经
直接读写远端）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `alias` | 是 | 主机别名 |
| `direction` | 是 | `upload`（本机 → 远端）或 `download`（远端 → 本机） |
| `localPath` | 是 | 本机绝对路径（上传的源 / 下载的目标） |
| `remotePath` | 是 | 远端绝对路径（上传的目标 / 下载的源） |
| `recursive` | 否 | 整个目录树，任方向都支持（下载时树内的 symlink 只列出不跟随） |
| `exclude` | 否 | 目录树传输要跳过的路径，**两个方向共用**；逗号或换行分隔。裸名匹配任意路径段（`node_modules`），`*` 不跨 `/` 而 `**` 跨，含 `/` 的规则从树根锚定（`build/output`），尾随 `/` 只匹配目录（`tmp/`），`!` 反选且**最后匹配的一条说了算**。不是 `.gitignore`，没有逐目录规则文件 |

返回 `ok`、`bytes`、`files`（递归时）、`skippedFiles`、`skippedLinks`、`error`。

上传**先写同级暂存名再 rename 发布**：目标文件在被替换之前，读到的始终是旧
内容或完整新内容，不会是半截文件。上传失败会清掉暂存文件并保留目标原内容。
下载读至 EOF 而非依赖 stat 时的长度，因此传输期间变长的文件会被完整取回。
单文件上限 1 GiB，**对工具与浏览器两条路由是同一个数**（`transfer.js` 导出、`routes.js`
引用；超限回答 413 而不是 500）。

上传的落点与 `write` 工具受**同一套**围栏约束，且在任何字节发出之前判定：

| 判定 | 依据 | 结果 |
| --- | --- | --- |
| 沙箱模式 | `mode-gate.js` 的 `writeModeRefusal`（与 `write` / `edit` 同一份代码） | `read-only` 与任何读不懂的模式一律拒绝 |
| 会话范围 | `workspaceWriteScopeRefusal`（同一份） | `workspace-write` 只允许会话工作区内（或该主机 `/tmp`） |
| 挂载根 | `assertWithinRemoteRoots`（同一份） | 未挂载路径拒绝 |
| 符号链接落点 | `assertFencedRealpath`（同一份） | 父目录经 symlink 逃逸到挂载根外时拒绝 |

也就是说：`write` 会拒绝的落点，上传同样拒绝，措辞与错误码一致。此前上传缺后两道，
实测能把字节写到未挂载的 `/etc/cron.d/…`，而 `write` 到同一拼写报
`FS_OUTSIDE_WORKSPACE`——那个分叉已经不存在。递归上传（`recursive: true`）对**每一个
创建的目录**也做同样判定，所以一个空目录树也不会先落下一个越界的空目录。
`roots` 未提供时围栏跳过：那意味着调用方无法回答「本部署服务哪些目录」，此时按
纯字节搬运对待（单元测试用的就是这一形态）；生产调用方（工具与浏览器上传路由）都
传 `router.roots`。

浏览器端另有 `GET /download?alias=&path=` 流式路由：文件选择对话框里每个文件行
有下载按钮，走这条路由把字节直接写进响应（不是 JSON），交给浏览器保存。它自行
施加回环来源与 `Host` 头双重校验，只接受 GET。
浏览器面板的**上传**走 `POST /upload-chunk`（JSON + base64 分片）：它是唯一同时能给出逐块进度
与块间取消的通道，桌面壳的 `dsh-app://` 也承载不了 Blob 请求体。它过挂载根与符号链接落点两道
围栏（与 `write` 相同的判定），但**不过**会话模式与范围——那是用户自己在面板上的动作，模式约束的是
agent。用户把会话切成「仅可查看」不会让面板的上传按钮失效，这与本地文件面板不受
`ctx.fs` 沙箱约束是同一件事。

`POST /upload` 的原始字节路由仍保留给非浏览器调用者与既有契约（同样的围栏、上限与原子发布），
只是浏览器不再使用它：`fetch` 的原始字节体既报不了进度，也不能在块间暂停。浏览器的下载同样进队列，
单文件有 `content-length` 才画百分比，目录归档只报已传字节。

## ssh_workspace_forward

把远端端口映射到本机（等价 `ssh -L`）：远端 dev server 变成可打开的
`http://localhost:<port>`。映射骑在连接池里的 SSH 连接上，连接断开即自动关闭；
重复映射同一目标返回已有条目。注意远端应用可能有自己的 host / 回调白名单
（Vite 的 `server.allowedHosts`、Next 的 `allowedDevOrigins`、OAuth 的
redirect URI），需要一并放行 localhost。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `alias` | 是 | 主机别名 |
| `remotePort` | 是 | 远端端口 |
| `localPort` | 否 | 本地端口，默认同远端；被占用时自动另选，传 0 由系统分配 |
| `remoteHost` | 否 | SSH 服务端拨号的目标（默认 `127.0.0.1`） |
| `localHost` | 否 | 本地监听地址（默认 `127.0.0.1`，仅本机；`0.0.0.0` 暴露到局域网） |

## ssh_workspace_reverse_forward

让**远端主机**监听一个端口，并把每条连接转发回**本机**的端口（等价 `ssh -R`）：
远端浏览器、构建或同事可以访问你本机运行的服务。它是 `ssh_workspace_forward`
的镜像。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `alias` | 是 | 主机别名 |
| `localPort` | 是 | 本机端口——把连接交给本机的哪个服务 |
| `remotePort` | 是 | 远端监听端口；传 `0` 由远端挑选空闲端口（推荐），实际端口在 `remotePort` 返回 |
| `remoteHost` | 否 | 远端绑定接口（默认 `127.0.0.1`，仅环回）；`0.0.0.0` 会把隧道暴露给任何能路由到该主机的一方，返回里会带警告 |
| `localHost` | 否 | 本机拨号地址（默认 `127.0.0.1`） |

返回 `ok`、`id`、`alias`、`localHost`、`localPort`、`remoteHost`、`remotePort`
（实际绑定端口）、`requestedRemotePort`（原样回显，`0` 表示由远端分配）、
`exposed`（非环回绑定时为 `true`）、`error`。

隧道随 SSH 连接存活：连接断开时远端监听器一并消失，需要重新打开。关闭用
`ssh_workspace_unforward`（与正向转发共用 `id`）。

## ssh_workspace_unforward

关闭一条端口转发并释放监听端口（`ssh_workspace_forward` 与
`ssh_workspace_reverse_forward` 共用）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 来自 `ssh_workspace_forward`、`ssh_workspace_reverse_forward` 或 `ssh_workspace_status` |

## 通用约定

- 路径一律使用 `ssh://` 实际拼写（不含显示用的 `@`）；
- 错误语义与 `ctx.fs` 同一套（`FS_*` 码，另加远端专用的 `FS_OUTSIDE_WORKSPACE`），
  写入围栏对工具触发的写同样生效；`read-only` 会话会拒绝远端 `write` / `edit`
  （`FS_SANDBOX_DENIED`），`ssh_workspace_transfer` 的**上传同样是写入**，也受该模式约束
  （工具自己从会话解析 `sandboxPolicy`，因为它不经 `ctx.fs`）；下载只读远端、写本机，
  因此在 `read-only` 下照常可用；
- **命令执行同样受模式约束**：`ssh_workspace_exec`、`ssh_workspace_shell` 在 `read-only`
  下直接拒绝（返回 `success: false` / `ok: false`，文案自述原因与出路），因为本机沙箱跨不过
  SSH，没有可用的围栏手段。`ssh_workspace_shell` 的 `close: true` 不受限——关闭不改变远端任何东西。
  这三处与 `write` / `edit` / 上传共用 `lib/mode-gate.js` 的判定，不会各自漂移；
- glob / grep 在远端工作区调用**远端主机的 ripgrep**（需远端已安装 `rg`，
  缺失时命令以退出码 127 失败并附安装提示）；工作区变更追踪用**远端 git**
  （未安装时该功能自动降级，不阻断会话）。本地工作区不受影响。
- 挂载时探测 `rg` / `git` / `inotifywait`，缺失项在挂载结果与面板里直接提示；
  远端有 `inotifywait` 时变更监视走事件推送，否则回落到轮询。
- **已停用的工作区**对所有读写 / 命令 / 传输一律拒绝，错误信息会点名
  "the remote workspace is detached"；详见 [features.md](./features.md) 的「工作区」一节。

## 相关

- [protocol.md](./protocol.md)
- [features.md](./features.md)
- [根 README](../README.md)
