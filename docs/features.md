# 功能说明

> 定位：把插件提供的**全部功能**按能力域列成一张可核对的清单——每项写清「做什么、
> 怎么用、依赖什么、缺依赖时退化成什么样」。想快速了解看[根 README](../README.md)，
> 想知道某项具体参数看对应专题页。

## 概述

插件把一台 SSH 主机上的目录变成 DSH 工作区，使 DSH 原有的文件、搜索、命令、变更
追踪、终端与界面能力**原样作用于远端**，再补上远端特有的主机管理、端口转发与文件
传输。

规模：

| 项 | 数值 |
| --- | --- |
| Agent 工具 | 10 个 `ssh_workspace_*` |
| 浏览器 HTTP 路由 | 25 条（前缀 `/api/dsh-ssh-workspace/`，仅回环 + Host 头校验） |
| 接管的服务 seam | 4 个：`ctx.fs`、`ctx.shell`、`ctx.subprocess`、`ctx.subprocess.spawnTerminal` |
| 桥接的宿主内建模块 | 2 个：`node:fs/promises`、`node:path` |
| 冒烟测试套件 | 44 个（裸检出活跃 38 个、合计 1733 项断言；6 个需真实主机 / 完整 DSH 树则 SKIP） |

设计前提：**不注册第二个 fs 服务**。远端方法装在部署已挂载的那一个 `ctx.fs` 实例上，
`ssh://` 路径走 SFTP，其余路径原样转发给原后端——因此本地工作区的一切行为不受影响。

## 一、工作区

| 功能 | 说明 |
| --- | --- |
| 挂载远端目录 | 把一个远端绝对目录登记为 DSH 工作区，返回 `ssh://<别名>/<路径>` 供会话使用；挂载前 `stat` 验证目录真实存在且是目录 |
| 持久登记 | 登记进 DSH 工作区 registry，出现在侧栏工作区列表；登记失败仍保留进程内挂载并回报原因 |
| 重启自动重挂 | 已登记的 `ssh://` 工作区在下次启动时从持久化 registry 恢复挂载 |
| 停用（可逆） | 默认 `detach`：保留工作区记录（侧栏那一行仍在、置灰），**会话也不归档**——保留分组却归档内容等于留一个点开是空的标题 |
| 注销 | `deregister`：删除工作区记录并归档会话；归档走 DSH 原生 `archiveSession`，会话文件与记账槽位都不动，可 `unarchiveSession` 放回 |
| 重新启用 | 再挂载并取消归档；启用前用**原始连接**（绕开围栏）`stat` 验证远端目录仍存在，避免得到一个「看着在服务、实际 ENOENT」的工作区 |
| 停用即全局停机 | 停用后该工作区**除 SSH 连接外的一切操作**都被拒绝：读写、列目录、变更监视、执行命令、开终端、glob / grep / git、文件传输。围栏挂在 `engine.disabledWorkspaces`，在 `ctx.fs`、内建 fs 桥、`ctx.shell`、`ctx.subprocess`、终端接管层与三条传输路由（`transfer` / `download` / `upload`）里同时生效，且都在**建立连接之前**拒绝 |
| 刻意保留的例外 | 内建桥的 `stat` / `lstat` / `realpath` 不挡——DSH 的 registry 用它们做会话身份探针，在那里制造失败会让它把会话从工作区记账里剪掉 |

详见 [unmount-modes.md](./unmount-modes.md)。

## 二、文件读写

会话工作区是 `ssh://` 时，`read` / `write` / `edit` 经 SFTP 直接读写远端文件。

| 功能 | 说明 |
| --- | --- |
| 完整错误语义 | 与本地同一套 `FS_*` 码，另加一个远端专用的 `FS_OUTSIDE_WORKSPACE`（详见下文与 [troubleshooting.md](./troubleshooting.md)） |
| 原子写入 | 先落**同目录**暂存文件再 `rename` 发布；优先 `posix-rename@openssh.com`，服务器不支持时退化为「先删后改名」（此时不再原子） |
| 符号链接裁决 | 写入围栏在词法前缀之外补一次**父目录 `realpath`** 裁决，堵住「中间目录或末级是 symlink 指向围栏外」的绕过；读取不加此限制 |
| 换行符保真 | 编辑 CRLF 文件不会把它改写成 LF |
| 二进制检测 | 文本读写先采样前 8 KiB，含 NUL 即拒绝（`FS_NOT_TEXT`）；非法 UTF-8 用 `TextDecoder(fatal)` 判定 |
| 字节原样读写 | `readBytes` 不做文本判定，原样返回字节 |
| 大文件流式读取 | 预览与 `read` 按 **256 KiB** 分块流式读取，不再整文件进内存；超出调用方 `maxBytes` 时报 `FS_TOO_LARGE` |
| 变更自动刷新 | 优先走远端 `inotifywait` 推送事件（即时、不受 mtime 精度限制）；未安装时回退轮询 |
| 轮询自适应退避 | 基础 **2 s**；连续 **15** 轮无变更退至 **5 s**，**30** 轮退至 **10 s** 封顶；任一变更立即回到 2 s |
| 元数据缓存 | 读路径元数据缓存 TTL **1.5 s**、上限 **1024** 条（刻意低于轮询间隔，避免把缓存快照当成新快照） |
| 轮询的已知盲区 | SFTP 元数据无亚秒时间戳，同一秒内**等长**的连续改写可能不触发刷新；增、删、改名总能感知 |

详见 [architecture.md](./architecture.md) 的「接管 ctx.fs」。

### 写入的两道围栏是两件事

| 围栏 | 回答的问题 | 拒绝时的码 |
| --- | --- | --- |
| 沙箱模式 | 「这个会话允许写吗」——`read-only` / `workspace-write` / `danger-full-access` | `FS_SANDBOX_DENIED`（宿主会改写成 `[sandbox: …]` 标记 + 升权提示） |
| 挂载根 | 「这个目录被服务吗」——目标是否在某个已挂载 `ssh://` 根之下 | `FS_OUTSIDE_WORKSPACE`（原文直达模型） |

**为什么要在远端重做模式判定**：本机沙箱的实现是 `SandboxedFileSystem.checkedTarget`，一个原型方法；
插件用同名自有属性接管了 `writeText` / `editText`，远端分支根本不调用它。所以不加这一步，`read-only`
会话照样能改远端文件，且全程无任何提示——模型的系统提示还明确要求它「不要仅凭策略就拒绝，先试」，
于是它试成功了，从模型视角看完全合规。

**工作区内的修改算不算数？** 算。`workspace-write` 要求目标落在**会话自己的**工作区之内，
与本地同一条规则（本地是 `writableRoots(policy)`，第一项为 `policy.workspaceRoot`）。
这个 root 不是「本机上的路径」——实测 `SandboxPolicyService.resolve({ session })` 返回的是
`session.header.cwd` 原样，远端会话拿到的就是 `ssh://qiyk/home/dev/proj` 这种拼写，可以直接
比较。此前文档说「不比较，因为那是本机路径」，是**错的**；不比较的后果是一个会话能写同一
主机上的兄弟根、甚至另一台主机上的已挂载根，而本地会话做不到这些。

| 目标 | `workspace-write` 的结果 |
| --- | --- |
| 会话工作区内 | 允许 |
| **该主机的 `/tmp`**（会话工作区外） | **允许**——与本地一致，见下 |
| 同一主机的兄弟目录（即使已挂载） | 拒绝，`FS_SANDBOX_DENIED`，文案点名会话工作区 |
| 另一台主机的已挂载根 | 拒绝，文案点名两个主机 |
| 未挂载路径（`/tmp` 之外） | 拒绝，`FS_OUTSIDE_WORKSPACE`（挂载围栏，另一道） |

**为什么远端也允许 `/tmp`**：本地的 `writableRoots(policy)` 除 `workspaceRoot` 外还列了常量
`/tmp` 与 `os.tmpdir()`（`dsh-sandbox/lib/index.js`，注释明写「漏掉它就会拒绝这个模式本来承诺
允许的写入」）。远端此前把 `/tmp` 判成「工作区外」而拒绝，于是**远端构建全部写不了暂存文件，而本地
同一份构建正常**——这正是本地注释里点名的那种偏差。现在 `/tmp` 与它的子目录算作可达，判定仍是
词法的（不探测 `$TMPDIR`），且**只对已经有挂载根的主机生效**：只知别名、什么都没挂载的主机仍然
不可达，「先挂载」这条没有变松。`danger-full-access` 同样受益——否则会出现「更宽的模式反而更窄」
的非单调结果。

**模式读不懂时按最严格处理**：`read-only` / `workspace-write` / `danger-full-access` 之外的任何
字符串（未来新增的模式名、fold 损坏出的值）现在**拒绝**，写入与命令都是。本地后端对同样的输入走的
是 containment 分支且 `writableRoots` 返回 `[]`，即一律拒绝；远端此前会同时跳过模式围栏与范围围栏，
只剩挂载根——同一个输入「本地收紧、远端放开」。拒绝文案**不会**谎称这是你选的「仅可查看」：切换模式
修不好一个读不懂的字符串，文案会列出被认可的三个模式。策略服务**完全缺席**仍是「不受限」而非拒绝，
这条没有变。

**命令则不然**：`workspace-write` 下远端命令仍以远端登录用户权限运行，无法收窄到工作区——
限制**进程**需要内核边界，而它跨不过 SSH。文件写入被收窄，命令没有被收窄，这个差别是
如实的，不是遗漏。

**一条隐含依赖，必须知道**：上面说的「会话 root 可以直接比较」依赖 `fs-shim.js` 对
`node:path.isAbsolute` 的补丁（让 `ssh://…` 读作绝对路径）。`SandboxPolicyService.resolve`
会对 `session.header.cwd` 调用它，缺了这个补丁就会抛
`workspace root must be an absolute execution-world path`，于是**每个远端会话**的策略解析
都失败。插件对这种失败的做法是 fail-closed（拒绝），但拒绝文案会明确说这是**接线问题**、
切换模式无用，并引述底层错误——不会谎称你选了「仅可查看」。这条依赖的脆弱性已实测确认：
裸 `node:path` 下 `isAbsolute('ssh://qiyk/home/qiyk/test')` 为 `false`，打上补丁后为 `true`。

`node:fs` 桥接（`fs-shim.js`）**不看模式**，这是刻意的：它服务的是宿主自己的记账调用
（新建会话 cwd 的 `mkdir`、注册表的 `stat`/`realpath`、变更追踪的快照拷贝），本地同一批调用同样不受
`ctx.fs` 沙箱约束。而且它只看得到部署默认模式、看不到会话级覆盖，按它判定会得出错误结论。
模型面向的写路径走 `ctx.fs` 与插件自己的工具，那条路上模式是生效的。插件自己的工具不经 `ctx.fs`，
所以它们**各自解析** `ctx.sandboxPolicy.resolve({ session })`：`ssh_workspace_transfer` 的上传
（写入远端）在 `read-only` 下被拒，下载（只读远端）照常可用。上传现在**四条围栏全部与 `write` / `edit`
一致**——模式（`writeModeRefusal`）、工作区范围（`workspaceWriteScopeRefusal`）、挂载根
（`assertWithinRemoteRoots`）、符号链接真实落点（`assertFencedRealpath`），所以两条写路径不会分叉：
一个 `write` 会拒绝的落点，上传同样拒绝，且**在写入任何字节之前**拒绝。此前上传缺后两条围栏，实测能
把字节落到未挂载的 `/etc/cron.d/…`（而 `write` 到同一拼写报 `FS_OUTSIDE_WORKSPACE`）——那正是
「两条写路径不会分叉」这句话当时的反例，现已由 `transfer-smoke` 的失败反证钉死。策略服务
缺席＝不受限，但**策略解析失败按拒绝处理**——拒绝一次可重试的上传，好过在「仅可查看」会话里静默写入；
文案会区分这两种情况。浏览器面板的上传/下载走 HTTP 路由，是**用户自己的动作**，只受挂载根与停用围栏
约束，**不受会话模式约束**（与本地文件面板同理：模式管的是 agent，不是用户）。


### 命令执行是另一条独立的写路径

只堵文件写入是不够的。插件有**六条**改远端的路，它们不共享调用链：

| 表面 | 到达远端的方式 | 模式的判定位置 |
| --- | --- | --- |
| `write` / `edit` | `ctx.fs` 路由 | `remote-fs.js`（每次调用带 policy） |
| `ssh_workspace_transfer` | SFTP 暂存 + 原子改名 | 工具自己解析 policy |
| `ssh_workspace_exec` | `engine.exec` | `mode-gate.js` |
| `ssh_workspace_shell` | PTY 通道 | `mode-gate.js` |
| `bash` / `pwsh`（workdir 为 `ssh://`） | `ctx.shell` → `patch-shell.js` | 读 spec 上的 `sandboxPolicy` |
| `terminal_open` / `terminal_send`（cwd 为 `ssh://`） | `ctx.subprocess.spawnTerminal` | `patch-terminal.js`：开 PTY 时拒绝，且**每次写入**重新判定 |

这六条读的是**同一个** `sandboxPolicy.mode`，而且模式判定本身**共用同一份代码**：`write` / `edit`
与 `ssh_workspace_transfer` 的上传都调用 `mode-gate.js` 的 `writeModeRefusal`，四条命令表面共用同一模块
的 `assertRemoteCommandAllowed`。分歧的风险因此只剩下「模式取自哪里」——六条的主判据都是会话级策略
（`write` / `edit` 用宿主传入的第五个参数 `sandboxPolicy`，其余五条自己 `resolve({ session })`）；
只有 `write` / `edit` 在策略缺席时回落到部署默认，那是无 agent 的调用，本地后端对同样的调用也用部署默认。
（`FS_SANDBOX_DENIED` 由宿主改写成 `[sandbox: …]`，与本地一致。）


这不是预防性设计：曾有一个 `read-only` 会话执行
`ssh_workspace_exec { command: "rm /home/qiyk/test/test.py" }` 并拿到 `[exit code: 0]`，而同会话的
`write` 是会被拒的。

**为什么是「拒绝」而不是「过滤」**：本机沙箱回答「这条命令能不能写」的方式，是把**进程**用内核边界
（bwrap / seatbelt / 受限 ACL 令牌）限制在工作区根内。这些机制一个也跨不过 SSH——远端命令以远端登录
用户的完整权限运行。没有哪个 seam 能接收一个 `workspaceRoot`，而用文本匹配去猜一条命令是否会写也不是
边界：`sh -c 'rm -rf ~'`、`find -delete`、`python -c ...` 读起来都像纯文本。

所以只有两个选项：允许任意远端命令、让模式成为一句空话；或者拒绝、让模式说真话。插件选后者，并在
拒绝文案里写明原因与出路（切到 `workspace-write` / `danger-full-access`），因为一条模型没预料到的拒绝
会被当成 bug 反复重试。

**读不受影响**：`read` / `glob` / `grep` / `ops_*` 走 SFTP，不需要执行命令。代价是失去任意命令执行
（远端 `git status`、构建），这需要用户显式切换模式来解锁。

**终端为什么有两道判定**：`ctx.subprocess.spawnTerminal` 的 spec 里没有 owner（只有 `cwd` / `argv` /
`env`），所以门禁不能装在那里；而它也不是单一入口——宿主有**两条**路会走到它：

| 路径 | 经过 |
| --- | --- |
| `terminal_open` / `terminal_send` | `ctx.terminals.spawn` → `dsh-terminal-bash` → `spawnTerminal` |
| 侧边栏的内建终端（`dsh-api-terminal-controller`） | **直接**调用 `spawnTerminal`，完全不经过 `ctx.terminals` |

因此把门禁装在 `ctx.terminals` 上会漏掉第二条——而只测工具路径的用例仍会通过。门禁装在
`patch-terminal.js` 的路由里（两条路唯一的汇合点），会话身份取自 `spec.env.DSH_SESSION_ID`
（两个调用方都会写它），再用 `ctx.get('agents').get(id)` 换成 session。

判定分**两半**，因为只拒「打开」只能保护本来就处于 `read-only` 的会话：

- 开 PTY 时拒绝，且**没有任何通道被打开**；
- handle 的每次 `write` 重新读一次模式——在 `workspace-write` 下开的 shell 被切成 `read-only` 后
  立刻停止接受命令。这是实际更常见的顺序：先开终端干活，再收窄模式。

控制字节是例外：SIGINT（`\x03`）与关闭路径必须继续可用，否则「仅可查看」会变成「连你已经启动的
命令都停不掉」。

`node:fs` 桥接（`fs-shim.js`）同样**不看模式**，原因见上：它服务宿主自己的记账调用，本地同一批调用也不受
`ctx.fs` 沙箱约束，而且它看不到会话级覆盖。

## 三、远端执行

| 功能 | 说明 |
| --- | --- |
| `pwsh` / `bash` 远端化 | 会话工作区是 `ssh://` 时，这两个工具的命令**在远端以 POSIX shell 语义执行**；一次性命令、后台任务、超时与中止都按 DSH 的进程契约工作；本地 `workdir` 的命令仍在本机沙箱内 |
| 无沙箱约束 | 远端命令以远端登录用户的**完整权限**运行，不受本机文件沙箱限制——正因如此，`read-only` 会话的命令执行由插件**直接拒绝**（见上节「命令执行是另一条独立的写路径」），而不是尝试围栏 |
| `ssh_workspace_exec` | 不依赖挂载即可在远端跑命令（主机巡检、挂载根之外的路径、装机脚本），支持 `run_in_background` 与 `timeoutMs` |
| `ssh_workspace_shell` | **持久**远端 shell：`cd`、导出的变量、后台任务跨调用保留，像一直开着的一个终端；可按名字并存多个会话；PTY 通道，退出码由命令行末尾的标记行取回 |
| glob / grep 远端化 | 调用**远端主机上的 ripgrep**，返回真实远端路径；`rg` 缺失时以退出码 **127** + 安装提示失败 |
| 命令白名单 | `cwd` 为 `ssh://` 的子进程只放行 `git` 与 `rg`（全 asar 扫描确认只有搜索工具与变更追踪两个消费方）；其余本机可执行文件**同步抛**错，不上传二进制 |
| 变更追踪远端化 | 「变更」面板用**远端 git** 做回合快照与 diff，远端 shell 改的文件也会出现在列表（+N/−N、可看 diff）；未装 git 时按「无仓库」降级，每回合一条 warn，不阻断会话 |
| 快照目录镜像 | 本机 `mkdtemp` 的 git 快照目录（`GIT_OBJECT_DIRECTORY` / `GIT_INDEX_FILE`）改写成远端 `/tmp` 下同后缀并 `mkdir -p`——远端 git 看不到本机路径 |
| 持久终端 | 接管 `ctx.subprocess.spawnTerminal`：`cwd` 为 `ssh://` 时开 SSH PTY 通道而非本地进程，handle 满足宿主的 `output` / `write` / `resize` / `done` / `inspectForeground` / `signalForeground` / `terminate` 契约；默认 **80×24**，按 spec 调整 |
| 方言不用本机的 | 远端 PTY 启动远端自己的交互式 POSIX shell，**忽略**宿主的 PowerShell argv——把 PowerShell 命令行丢给 POSIX 主机会以「像插件 bug」的方式失败 |
| `inspectForeground` 的取舍 | 本地 handle 靠本机进程表回答，单条 SSH 通道无法廉价等价；宁可回答「未知」也不猜（错误答案会让宿主以为还有前台进程、白等整个超时） |
| UTF-8 跨块正确性 | 输出用 `StringDecoder` 拼接，多字节字符跨 chunk 边界不再变成两个替换符；截断按**字节**记账并回退到完整字符边界 |

详见 [architecture.md](./architecture.md) 与 [tools.md](./tools.md)。

## 四、本机 ↔ 远端传输

| 功能 | 说明 |
| --- | --- |
| `ssh_workspace_transfer` | 经 SFTP 双向拷贝，字节**不经过对话内容**；适合推构建产物、拉日志 |
| 目录树上传 | `recursive: true` 上传整个本地目录树（仅 upload） |
| 上传原子发布 | 先写同级暂存名再 `rename`；目标在被替换前读到的始终是旧内容或完整新内容，不会是半截文件；失败清暂存并保留原内容 |
| 下载读至 EOF | 不依赖 stat 时的长度，因此传输期间变长的文件会被完整取回 |
| 分块流式 | 每块 **256 KiB**，大文件只占有限内存 |
| 单文件上限 | **1 GiB**（超出直接拒绝，不静默截断） |
| 浏览器内上传 / 下载 | 三处入口：文件面板头部的「上传文件到此目录」按钮、文件树行的右键菜单（「下载到本机」/「上传文件到此目录」）、目录浏览器对话框里的逐行下载。下载走 `GET /download` 把字节**直接写进响应**（不是 JSON，避免膨胀与被 body 上限截断），上传走 `POST /upload` 以 `application/octet-stream` 发原始字节（单文件一请求，省掉客户端里的 multipart 解析器） |
| 下载失败带真实状态码 | 响应头未发出时按 `FsError` 码答复（`FS_NOT_FOUND` → 404、权限类 → 403、类型不符 → 400、其余 → 500）；**不能答 200**——浏览器只认状态码，2xx 的 JSON 错误体会被存成文件 |
| 上传的路径加固 | 文件名必须**单个路径段**（含 `/`、`\`、`.`、`..` 一律 400），否则一个请求就能跳出用户正在看的目录 |
| 下载目录不支持 | 「暂不支持下载整个目录」——需要整棵树时用工具版的 `recursive` 上传或 `ssh_workspace_exec` 打包 |

## 五、端口转发

| 功能 | 说明 |
| --- | --- |
| 正向映射 | 等价 `ssh -L`：远端 dev server 变成可打开的 `http://localhost:<port>` |
| 骑在连接池上 | 映射复用池化的 SSH 连接；连接断开即自动关闭，再次调用可重开 |
| 重复映射去重 | 同一目标再次映射返回已有条目，不叠加 listener |
| 监听地址可选 | 默认 `127.0.0.1`（仅本机）；`0.0.0.0` 暴露到局域网 |
| 拨号目标可选 | `remoteHost` 默认 `127.0.0.1`（远端服务自身），可指向远端可达的其他主机 |
| 持久化 | 映射写入 `dsh-ssh.json` 的 `forwards` 分区，重启后仍在列表里 |
| 意图与事实分离 | `enabled`（用户想要什么）与 `live`（当前是否真有 listener）分开存：按钮文案由事实决定，启动行为由意图决定——否则重启后连接未建立、按钮却写着「断开」就是谎报 |
| 已存映射严格端口 | 本地端口被占用就报错，**不静默漂移**到临时端口，否则保存的 URL 下次启动就失真 |
| 启动自动开启 | 面板有总开关（`autoStart`）；在稍后的 tick 上执行、从不抛出——不可达的主机不该拖慢或拖垮插件自身的激活 |
| 端口预检 | `GET /forward/probe` 提前告知 `EADDRINUSE` / `EACCES` 及不同文案；但**权威仍是 `open()` 抛出的绑定错误**，预检只是提前说明原因 |
| 断开两条路径一致 | 端口行「断开」与主机「断开连接」走同一个 `closeAlias()`：映射保留、意图置 `false`、**不记失败原因**——主动断开不是故障，面板不该亮红字 |
| 远端应用白名单 | 远端应用可能自带 host / 回调校验（Vite `server.allowedHosts`、Next `allowedDevOrigins`、OAuth redirect URI），需一并放行 localhost |

详见 [forward-persistence.md](./forward-persistence.md)。

## 五之二、断线与重连

| 功能 | 说明 |
| --- | --- |
| 后台重连 | 连接意外断开后自动重试，不需要用户先做一次操作；1 秒起指数退避、60 秒封顶、默认不限次数 |
| 只在有人用时重试 | 判定依据是「已挂载工作区 / `holds > 0` / 有 `enabled` 的保存转发」，全都没有就停——关掉的工作区不会在后台被拨回来 |
| 「断开」是终态 | 手动断开与改配置都会取消后台循环：按钮说了断，就真的不再拨号 |
| 不可恢复的错误立即停 | 未知别名、读不到私钥、主机密钥不匹配标记为 fatal，不每分钟重复同一个失败 |
| 恢复保存的转发 | 只由后台重连触发（前台首次连接不触发），重开该主机 `enabled` 的映射；关掉的映射不会被重新打开 |
| 状态可读 | 面板主机卡片显示「重连中（第 N 次，M 秒后）」/「重连已停止」+ 原因；`ssh_workspace_status` 的 `reconnecting` 给出同样的字段 |
| 立即重试 | `POST /hosts/reconnect` 跳过等待；失败时返回真实错误，而不是乐观的「正在重试」 |
| 事件有节制 | 前 3 次、之后每 5 次以及结束那次写 `reconnect` 事件，长时间断网不会冲掉 40 条环形缓冲里的其它信息 |
| 可关闭 | `engine.reconnect: false` 退回旧的「只在操作时重连一次」 |

实现见 [architecture.md](./architecture.md#后台重连libreconnectjs)。

## 六、界面集成

| 功能 | 说明 |
| --- | --- |
| 「远程工作区」面板 | 注册在 `sidebar.panellist`，标题「远程工作区」，服务器图标 |
| 主机增删改 | 面板内添加 / 编辑 / 删除主机，写回 `$DSH_HOME/dsh-ssh.json`（原子写入，保留不认识的字段），改动立即生效并丢弃该别名旧连接 |
| 测试连接 | 实连一次**然后释放**——「测试」回答的是「是否可达」，不是「替我连上」；结果以顶部 toast 呈现（附往返毫秒数）、约 3.5 s 自动消失、点击可提前关闭 |
| 连接指示 | 「已连接」状态内联在主机名之后；连接上有操作在飞时「断开」按钮禁用并给出提示 |
| 列表滚动视口 | 主机、端口转发、已挂载工作区、已停用工作区**四个**列表超过 **5** 条即改为滚动；上限高度按**前 5 行实测高度**求和，不写死行高（行高会随描述、错误行、确认行与面板宽度变化）；无溢出时不预留滚动条位置 |
| 添加工作区双入口 | 占用两个 `directoryFlow` 插槽（侧栏与会话页 hero），以负优先级 `-100` 遮蔽部署自带的本地选择器而不卸载它 |
| 锚定菜单 | 「本地」（转交 DSH 原生选择器）与「远程」（新建远程工作区对话框）两行 |
| 新建远程工作区 | 选主机 → 逐级浏览远端目录 → 命名 → 挂载，一次完成；**先注册、后接纳**，避免以派生标题重复建条目 |
| 浏览目录对话框 | 主机卡片的「浏览目录」打开 `DirectoryBrowser`：逐级浏览、上传文件到当前目录、逐行下载文件、「挂载此目录」；成功后附能力提示。与「新建远程工作区」（`RemoteWorkspaceDialog`）是**两个组件**——后者只列目录、只为选路径 |
| 可写探测 | `/ls` 同时回报 `writable`，目录不可写时红色警告并**禁止创建**——写入能力是 Agent 工作的前提 |
| 远程工作区标记 | 侧栏行、工作区选择器、会话页工作区按钮显示远端标记图标而非普通文件夹 |
| 停用置灰 | `/status` 下发 `workspaces[].sessionIds`，停用工作区的**会话行**也一并置灰且整行不可点（`pointer-events: none` + `setElementInert`）；工作区标题行只让按钮失效、标题本身仍可展开——那是看清「保留了哪些会话」的唯一途径 |
| 文件树与预览 | 「工作区文件」侧栏直接列出远端目录，文本预览经 SFTP 读取 |
| `@` 远程引用 | 补全候选来自**远端**目录（递归索引 + 模糊排名，含 `/` 逐级下钻，目录符号链接不跟随），选中插入 `@相对路径` |
| 拖拽 / 右键进任务 | 文件与文件夹可直接拖到聊天输入框（悬停虚线高亮，松开插入引用 chip），或右键「添加到任务」 |
| 持久远端会话区 | 只读列出当前打开的持久 shell；列表为空时整区不渲染 |
| HMR 幂等 | 拖入一个文件只生成一个 chip：已处理事件集合挂在全局并以事件对象为键，一次派发只被消费一次 |

详见 [ui.md](./ui.md)。

## 七、主机与安全

| 功能 | 说明 |
| --- | --- |
| 主机来源 | `$DSH_HOME/dsh-ssh.json` 优先，缺失时回退读取 `~/.ssh/config` 的具体 `Host` 块；已配好的主机无需重复配置 |
| `~/.ssh/config` 只读 | 面板不改写 `~/.ssh/config`；与存储同名的主机以存储为准；带 `proxyJump` / `ProxyCommand` 的主机在解析时**明确拒绝**并说明原因 |
| 认证方式 | `key`（含 `keyPath` 与口令）/ `password` / `agent`（含 `agentPath`） |
| 凭据加密 | 密码与私钥口令存进 `dsh-ssh.json` 的 `secrets` 段，AES-256-GCM，密钥为 `$DSH_HOME/dsh-ssh.key`（仅本用户可读）；**从不回传浏览器**，编辑时留空表示保留原值 |
| 明文迁移 | 老版本留在共享存储里的明文凭据在启动时一次性搬进加密段，best-effort——读不懂的存储原样放过而不是覆盖 |
| 主机密钥 TOFU | 首连记录服务器主机密钥 SHA256 指纹；之后指纹变更**拒绝连接**并提示新旧指纹，防中间人；主机重装后在面板「忘记主机密钥」重新信任 |
| 文件权限 | 存储文件 0600、目录 0700（POSIX）；旧文件补一次 `chmod`（best-effort，win32 上 mode 语义有限，不能因此阻断） |
| 并发写 | `mutateHosts` 原子读改写 + 零依赖文件锁，避免面板与工具同时改存储时丢更新 |
| 路由加固 | 仅回环来源 + `Host` 头必须是本端口的回环拼写（堵 DNS rebinding）+ 写操作要求 JSON `Content-Type`；`/download` `/upload` 另行各自施加双重校验 |
| 连接复用与回收 | 每别名一条长连接；空闲 **30 分钟**回收，有操作在飞的连接不回收；握手超时 **15 s**、keepalive **15 s**、扫描周期 **60 s** |
| 能力探测 | 挂载时一次往返探测 `rg` / `git` / `inotifywait`，只把**已知缺失**的项报成提示（探测不出来不算失败）；经**原始连接**探测，绕开停用围栏 |

详见 [hosts.md](./hosts.md) 与 [protocol.md](./protocol.md)。

## 八、配置项

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时插件完全不安装 |
| `announceToAgent` | `false` | 是否向每个 agent 注入能力说明（系统提示词段落） |
| `engine.idleTimeoutMs` | `1800000` | 连接空闲超过该时长后回收（毫秒） |
| `engine.connectTimeoutMs` | `15000` | 单次 SSH 握手超时（毫秒） |
| `engine.keepaliveIntervalMs` | `15000` | keepalive 心跳间隔（毫秒） |
| `engine.sweepIntervalMs` | `60000` | 空闲连接扫描周期（毫秒） |
| `engine.reconnect` | 见下 | 断线后的后台重连策略；`false` 关闭 |
| `engine.reconnect.baseDelayMs` | `1000` | 首次重试等待（毫秒），之后按 2 的幂增长 |
| `engine.reconnect.maxDelayMs` | `60000` | 单次等待上限（毫秒） |
| `engine.reconnect.maxAttempts` | `0` | 最多尝试次数；`0` 表示不限次数 |
| `engine.reconnect.jitter` | `0.2` | 向下抖动比例（不会超过上限） |

`engine` 下各项均为可选，非法值回落默认，通常无需配置。

面板里另有 `forwards.autoStart`（启动时自动开启已存隧道），写在存储里而非插件配置。

## 九、依赖与降级矩阵

远端主机**不需要**装任何本插件的东西，但有三项工具决定部分能力是否满血：

| 远端依赖 | 影响的能力 | 缺失时的表现 |
| --- | --- | --- |
| `ripgrep`（`rg`） | `glob` / `grep` | 命令以退出码 **127** 失败，附安装提示（`sudo apt install ripgrep` / `brew install ripgrep`）；工具层呈现为带提示的失败 |
| `git` | 「变更」面板的回合快照与 diff | 按「无仓库」降级：只列文件工具改动，每回合一条 warn，**不阻断会话** |
| `inotifywait` | 文件树 / 预览的变更自动刷新 | 回退到轮询（基础 2 s，空闲退避至 10 s），几秒延迟 |
| `posix-rename@openssh.com`（服务器扩展） | 原子写入 | 退化为「先删后改名」，此时写入不再原子 |

前三项在挂载时探测，缺失项在挂载结果与面板里直接提示。全部**本地**工作区不受任何影响。

## 十、明确的边界

不支持的，以及为什么：

| 边界 | 说明 |
| --- | --- |
| 跳板机 / `ProxyCommand` | 引擎只直连目标主机（`ssh2` 未接 `proxyJump`）。带 `proxyJump` / `ProxyCommand` 的主机在解析时**明确拒绝并说明原因**，而不是悄悄按直连去试 |
| 文件名编码 | SFTP 只给字节，`readdir` 默认按 UTF-8 解出名字；传 `encoding: 'buffer'` 或具体编码时按该编码转换。非 UTF-8 文件名（如 GBK 主机的历史文件）在所有显示路径上都按 UTF-8 解读，可能出现乱码 |
| 远端命令的沙箱 | 远端命令以远端登录用户权限运行，**本机沙箱策略不适用**——这是设计取舍，不是缺口 |
| 下载整个目录 | 浏览器端只支持单文件下载；整棵树用 `recursive` 上传或 `ssh_workspace_exec` 打包 |
| 读取不受围栏限制 | 写入围栏只约束写与删；读取任何路径都允许（与部署本地后端的口径一致） |
| `inspectForeground` 精度 | 远端 PTY 无法廉价读等价信息，宁可答「未知」也不猜 |

## 相关

- [architecture.md](./architecture.md) — 这些功能是怎么实现的
- [tools.md](./tools.md) — 十个工具的参数与返回
- [ui.md](./ui.md) — 界面上的出入口与交互
- [hosts.md](./hosts.md) — 主机配置与认证
- [troubleshooting.md](./troubleshooting.md) — 出问题时怎么查
- [根 README](../README.md)
