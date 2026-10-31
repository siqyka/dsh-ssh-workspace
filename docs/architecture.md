# 架构与实现

> 定位：插件如何在不修改 DSH 源码的前提下，把 SFTP 远端接入 `ctx.fs` 与
> 界面。读者：想读源码或参与贡献的人。

## 总体结构

插件分两半，各自独立加载：

- **宿主半边**（`lib/*.js`）：一个普通的 Cordis ESM 插件，入口 `lib/index.js`
  （`name = 'ssh-workspace'`）。它不静态依赖 `fs` 服务——而是
  `ctx.inject(['fs'], …)` 在本地后端出现的那一刻执行接管；用
  `ctx.inject(['shell'], …)` 同样接管 `ctx.shell`（远程命令执行）；
  `ctx.inject(['subprocess'], …)` 接管 `ctx.subprocess`（远端 glob/grep 的
  ripgrep 与变更追踪的 git），并在同一服务上接管 `spawnTerminal`（远端 PTY
  终端）；
  用 `ctx.inject(['fs', 'workspaceRegistry'], …)` 恢复重启前登记的远端工作区；
  用 `ctx.inject(['fs', 'webServer'], …)` 注册浏览器半边的 HTTP 路由。
  这些注入都可以晚于本插件出现，安装顺序无关。
- **客户端半边**（`lib/client.js`）：单文件包，由 DSH 客户端的模块加载器
  （`window.__ModuleLoader__.load({ id, factory })`）直接执行，通过 `slots`
  服务挂载「远程工作区」面板与「添加工作区」菜单，并做工作区标记的 DOM 装饰。

一次远端读取的路径：模型 read 工具 → `ctx.fs.readText(target)`
（`target.targetKey` 形如 `ssh://alias/abs/path`）→ 被接管的 `ctx.fs`
（`lib/remote-fs.js` 的 `RemoteFileSystem`）按拼写分派 → 远端半边走 SFTP；
其余拼写原样转发给部署自己的本地后端。

## 接管 ctx.fs

Cordis 拒绝在同一作用域第二次 `provide('fs')`（实现按服务的隔离符号登记，
会撞键），`ctx.set('fs', …)` 也被拒（只有提供该服务的 fiber 能覆盖它的值）。
部署本身已经挂了本地后端，所以插件不重新注册服务，而是**给现存的那个
`ctx.fs` 实例打补丁**（`lib/patch-fs.js`）：

- 远端方法装成实例的**自有属性**（自有属性覆盖原型链，且对已注册的服务
  安装属性不会失败）；
- 其余方法**绑定原始 receiver** 转发给原后端——沙箱围栏、版本守卫等本地
  行为完全不变；
- 原型上的原始方法不动，卸载时删除自有属性即复原（并留有
  `Symbol.for('dsh-ssh-workspace.installed')` 安装标记）。

`resolve` 与 `lstat` 的第一实参是**路径字符串**而非已解析 target，路由因此
看拼写本身：路径自带 `ssh://` 时按远端；否则看 `opts.cwd`——会话工作区根为
`ssh://` 时，裸**相对**名继承远端根（`@` 引用与 `@` 补全插入的正是工作区
相对路径，README「`@` 远程文件引用」），裸**绝对 POSIX** 名落到远端主机根
（与 `node:path` 桥接「绝对参数替换远端路径」一致）。远端半边的 `resolve`
与 `lstat` 都必须自己消化这两种裸拼写：把远端 cwd 下的裸路径转发给本地后端，
会被同一 cwd 再次判为远端，形成无限互相委派（表现为预览点击后
`Maximum call stack size exceeded`）。

### 写入围栏、沙箱模式与符号链接裁决

**沙箱模式与挂载根是两件事**，回答的问题不同，因此用不同的错误码：

| 围栏 | 问题 | 拒绝码 | 宿主如何处理 |
| --- | --- | --- | --- |
| 沙箱模式 | 这个会话允许写吗（`read-only`，或任何读不懂的模式） | `FS_SANDBOX_DENIED` | 改写成 `[sandbox: …]` 标记 + 升权提示 |
| 挂载根（含该主机的 `/tmp`） | 这个目录被服务吗 | `FS_OUTSIDE_WORKSPACE` | 原文直达模型 |
| 工作区停用 | 用户把它关了吗 | `FS_PERMISSION_DENIED` | 原文直达模型 |

写围栏问「被服务吗」时用的是 `writeFenceRoots`：原始挂载根**加上该主机的 `/tmp`**，与本地
`writableRoots` 列出常量 `/tmp` 保持一致。放宽只在写围栏生效，且只对已有挂载根的主机生效；
读探针、`node:fs` 桥、停用围栏继续按原始挂载根作答，所以 `stat ssh://host/tmp` 一类的身份
探针不会因为这道放宽而多出一批可答的路径。

模式判定必须在远端重做一次，因为本机的实现（`SandboxedFileSystem.checkedTarget`，见
`@deepseek-ai/dsh-fs-sandbox`）是**原型上一个本地方法**：插件的同名自有属性覆盖了
`writeText` / `editText`，远端分支从不调用它。少了这一步，`read-only` 会话照样能改写
远端文件，且没有任何提示——而模型的系统提示恰好要求它「不要仅凭策略就拒绝，先试」，
于是这次越权在它看来是完全合规的成功。

模式取自 `writeText` / `editText` 的**第五个参数** `sandboxPolicy`（宿主的 `write` /
`edit` 工具都会传），缺席时回落到后端 `sandboxMode`（部署默认）——缺席不等于「不限制」，
它表示一次无 agent 的调用，本地后端对同样的调用也用部署默认。

`workspace-write` 在远端**比较会话自己的 workspace root**，与本地一致：本地后端用
`writableRoots(policy)` 判定，第一项是 `policy.workspaceRoot`。这个值由
`SandboxPolicyService.resolve` 返回 `session.header.cwd` 原样得到——远端会话就是那个
`ssh://` 拼写，可以直接与目标比较。落在会话工作区之外（且不在该主机 `/tmp` 之下）的写入返回
`FS_SANDBOX_DENIED`，文案点名会话工作区与出路；跨主机的已挂载根同样被拒。

`workspace-write` / `danger-full-access` **之外**的任意模式字符串一律拒绝，与本地一致：本地对读不懂的
模式走 containment 分支且 `writableRoots` 返回 `[]`。此前远端会跳过模式与范围两道围栏，同一个输入
「本地收紧、远端放开」。`undefined`（策略服务完全缺席）仍是「不受限」而非拒绝。

（此前这里写的是「不比较，因为那台机器的路径对远端无意义」。那句话是错的：实测
`resolve()` 返回的就是远端拼写，可用；而且不比较会让一个会话能写同一主机上的兄弟根，
甚至另一台主机的根——本地做不到的事。）

约束不了的是**命令**：限制一个进程需要内核边界，它跨不过 SSH，所以 `workspace-write`
下远端命令不会被收窄到工作区。这是如实记录的限制。

`node:fs` 桥（`fs-shim.js`）刻意不看模式：它服务宿主自己的记账调用（新建会话 cwd 的
`mkdir`、注册表的 `stat`/`realpath`、变更追踪的快照拷贝），本地同一批调用同样的不受
`ctx.fs` 沙箱约束；而且它只看得到部署默认、看不到会话级覆盖，据此判定会给出错误结论。
模型面向的写路径走 `ctx.fs` 与插件自己的工具，那条路上模式是生效的——但插件工具不经
`ctx.fs`，所以它们各自解析 `ctx.sandboxPolicy.resolve({ session })`（见 `tools.js` 的
`sessionSandboxPolicy`，它是 `mode-gate.js` 里 `sessionPolicyOf` 的薄适配器，好让
「解析失败」这个原因随策略一起传下去）：`ssh_workspace_transfer` 的上传被门禁，下载不被门禁。
上传现在四道围栏与 `write` / `edit` 完全同步——模式（`writeModeRefusal`）、范围
（`workspaceWriteScopeRefusal`）、挂载根与符号链接落点（`fenceUploadTarget`），此前缺的后两道
实测能把字节落到未挂载的 `/etc`，正是「两条写路径不会分叉」的反例。浏览器面板的上传路由同样过
后两道围栏，但**不过模式与范围**——那是用户自己的动作，模式管的是 agent。

词法围栏（`isRemotePathUnder`，规范化后做前缀比较）只是快路径；写 / 删
操作在落盘前还做一次**服务器 `realpath` 裁决**（`assertFencedRealpath`，
`lib/remote-fs.js`）：目标**父目录**经 `sftp.realpath` 解析后必须仍落在已
挂载根内，否则 `FS_OUTSIDE_WORKSPACE`。没有这一步时，围栏内一个指向外部的
符号链接（或中间目录为符号链接）会让词法判断与真实落点不一致，写入 / 删除
即可越界。覆盖点为所有写、删入口——原子替换（`#publish`）、`copyFile` 直写
与 `rm` 桥、`mkdir`，以及 `ssh_workspace_transfer` 的上传与浏览器面板的上传路由
（`transfer.js` 的 `fenceUploadTarget`：挂载根 + realpath 两道一起，在任何字节落盘之前）；
realpath 读取失败按 `FS_NOT_FOUND` 语义处理。
**读取不受围栏限制**，因此不做此校验；元数据缓存（见下）同样永不服务围栏
校验与写路径。

### 远端变更监视与流式读取

- **`watch`（轮询式，自适应退避）**：SFTP 没有可移植的变更通知，
  `RemoteFileSystem.watch` 以快照比对对齐本地 depth-0 watcher 的语义：文件
  目标一次 `stat`（不存在的路径也观察创建），目录目标一次 `readdir` 快照；
  任一直接子项增/改/删即无参回调通知，无法继续轮询的故障以 Error 参数回调
  一次后停止（消费者抛错不停轮询）。基础间隔约 2 秒；连续 15 轮无变更退避
  至 5 秒、30 轮至 10 秒（上限），**任一变更立即回到 2 秒**。检测到变更先
  失效该路径与其父目录的元数据缓存，再回调。目录在 `stat` 与 `readdir` 之间
  消失按「变更」而非故障处理；每轮经 `withSftp`，轮询间隙连接可正常回收，
  计时器 `unref`。`watch` 是 `async` 方法——预中止 signal 以 rejected
  promise 呈现，与 `fs-local` 一致。快照版本为 `ino:size:mtime`，SFTP 元
  数据无亚秒时间戳，同一秒内等长的连续改写可能不触发刷新。
- **元数据短 TTL 缓存**：`stat` / `lstat` / `readdir` 的**读路径**按
  `(别名, 类型, 规范化路径)` 缓存 1.5 秒（略小于最小轮询间隔），失败不缓存；
  插件自身的写 / 删 / `mkdir`、watch 检测到变更、mount / unmount 都会主动
  失效对应条目。写前的版本校验、围栏裁决与 watch 轮询直读服务器，永不吃
  缓存——缓存只用来省掉「文件树展开、预览、`@` 索引」的重复 SFTP roundtrip。
- **`listDir` 直接消费 readdir 的条目属性**：SFTP 的 `readdir` 响应本就为每个
  条目带回 `attrs`（ssh2 `Stats`），因此类型 / 版本 / 大小全部由它推导，不再
  对每个子项补一次 `stat`——N 条目目录由 1 + N 次**串行**往返降为 1 次
  readdir（加缓存未命中时的一次父目录 `stat`）。仅在服务器未返回 `attrs`
  时才逐条回退 `#statCached`。watch 快照一直按同一方式消费 `attrs`。
- **`streamText`（惰性分块）**：SFTP 句柄逐 256 KiB 读取，增量严格 UTF-8
  解码（跨块多字节安全），首 8 KiB 做 NUL 抽样（非文本抛 `FS_NOT_TEXT`）。
  消费方提前 `.return()`（预览切页）即关闭句柄；`inFlight` 全程钉住连接。
  预览与 `read` 工具按既有的 `streamMinSize` 选择本方法，大文件不再整块
  进内存。

## 接管 ctx.shell（远程命令执行）

`ctx.shell` 与 `ctx.fs` 是同一种 seam：部署已挂了本地执行器（Windows 上是
`dsh-pwsh-sandbox` 包着 `PwshLocalExecutor`），且每上下文只允许一个实现。
`lib/patch-shell.js` 用与 `patch-fs.js` 相同的手法接管 `execute`：`workdir`
以 `ssh://` 开头时改在远端执行，其余 spec 原样转发——本地命令仍走部署自己
的沙箱围栏。`resolve` 无需包装（它原样透传 `workdir`，而 `node:path.isAbsolute`
的桥接已让 `ssh://` 通过宿主的「绝对路径」校验）。

远端半边复用引擎的连接池（`engine.acquire()`，与 SFTP 同一条 ssh2 连接，另
开 exec 通道），返回的 handle 按 seam 约定实现：`status` / `exitCode` /
`signal` 活字段、`observed` 增量读取器（jobs 输出拉取走它）、永不 reject 的
`done`、`kill()`、以及 `result()` 的前景投影（`timedOut` / `aborted` / 输出
尾窗 `truncated`）。`onExpiry: 'kill'` 时执行器自 arm 截止时间；`'none'` 时
超时归 jobs 注册表（前台调用超时后被提升为后台 job）。kill 先发通道信号并
关闭通道，5 秒宽限后仍未 close 就丢弃整条连接，保证 handle 不会挂死。

**退出状态的判定**（`patch-shell.js` 的 close 处理器）：ssh2 的通道退出码初始
为 `undefined`，只有收到 `exit-signal` 才置 `null`，因此「传输层断开且未收到
任何 exit-status」以 `close(undefined)` 呈现。两种拼写都表示**命令从未上报
状态**，必须走 `fail(...)` 报连接丢失——只判 `=== null` 会把断连当成
`status: 'completed'` 的正常完成（`lib/engine.js` 用 `typeof code !== 'number'`、
`patch-subprocess.js` 用显式双判，语义一致）。真正的非零退出码（如 `exit 1`）
是有效结果，仍按 completed 结算并保留 `exitCode`。

命令组装为 `export <env/dshEnv>; cd '<远端路径>' && <命令>`，由远端登录 shell
按 POSIX 语义执行——远端不是 PowerShell，公告已向模型说明。**沙箱边界**：
本机文件沙箱不跨 SSH，spec 上的 `sandboxPolicy` 对远端 workdir 不适用，远端
命令以远端登录用户的完整权限运行。

> **文件写入与命令执行不同**：`ctx.fs` 的远端分支**会**读取 `sandboxPolicy.mode`
> （见「沙箱模式与挂载根是两件事」）。这里的「不适用」只指 `ctx.shell` /
> `ctx.subprocess` 的 spec，不适用于 read / write / edit。

引擎的 `exec` 输出按 **UTF-8 流式解码**（每流一个 `StringDecoder`），多字节
字符跨 chunk 边界不再乱码；输出上限按**字节**记账，截断回退到完整字符边界
并标注 `…[output truncated]`。**断线重试**：命令尚未产生任何输出、且未超时 /
未中止时，若发现连接已断（`record.broken`，ssh2 在通道关闭事件之前同步置位）
就丢弃旧连接重试一次；已产生输出的命令不重试（避免副作用命令重放），按连接
丢失结算。

## 接管 ctx.subprocess（远端搜索与变更追踪）

`ctx.subprocess` 是文件工具两个助手启动短命子进程的 seam：glob/grep 的
ripgrep 与变更追踪的 git，二者都从会话 header 取 cwd，因此远端工作区上
spec 里是 `ssh://` 拼写、本机运行时无法使用。`lib/patch-subprocess.js` 用与
patch-fs/patch-shell 相同的手法接管 `spawn`：`spec.cwd` 为 `ssh://` 时经
`engine.acquire()` 复用连接、`client.exec()` 在远端执行；其余 spec 绑定原始
receiver 原样转发。

- **命令白名单**：`argv[0]` 按 basename 翻译（`rg.exe`／`*-rg[.exe]` →
  `rg`，`git` → `git`）；其余可执行文件**同步抛错**——静默在本机跑会给远端
  cwd 一个悄悄错误的答案。本机打包的 rg 路径只作 argv 标记，不上传二进制。
- **脚本组装**：`export <spec.env>; export PATH=$HOME/.local/bin:$HOME/bin:$PATH;
  [mkdir -p <镜像目录>;] cd <远端路径> && { command -v <命令> >/dev/null 2>&1 ||
  { echo <安装提示> >&2; exit 127; }; exec <引号化 argv>; }`；`rg` 缺失的提示
  带安装命令，工具层以 `SEARCH_FAILED` 呈现。
- **handle 契约**：与本地子进程一致——`done`（resolve 退出码/signal；提供方
  失败才 reject，连接掉线而进程未报状态同样 reject）、`collected.stdout/stderr`
  的 `readFrom/finalize` 字节尾窗（丢整 chunk 的 `lossy`/`truncated`，与
  OutputCollector 对齐）、`stdin: 'ignore' | {data}`、`terminate()` 走
  TERM → `graceMs` → KILL 阶梯，5 秒未关即丢弃整条连接并结算，保证 handle
  不挂死；`pipe`/`inherit`/`control` 一期同步抛不支持。
- **scratch 镜像**：变更追踪把本机 `mkdtemp(tmpdir())` 的快照目录通过
  `GIT_OBJECT_DIRECTORY` / `GIT_INDEX_FILE` 交给 git，远端 git 看不到本机
  路径。路由层把这些值改写成远端 `/tmp` 下的同后缀镜像（`mkdir -p` 先行），
  并把 `ssh://` 值（`GIT_ALTERNATE_OBJECT_DIRECTORIES`）翻译为裸远端路径；
  注册表按 scratch 首段记住所属别名（first-learn-wins 防跨主机误删），供
  fs 桥的 `rm` / `copyFile` 联动（见下节）。

## 内建桥接（node:fs / node:path）

`ctx.fs` 之外仍有宿主子系统直接调内建模块，且发生在 agent 存在之前：
会话控制器创建会话前 `mkdir` 项目目录，工作区注册表 `realpath` + `stat`
会话 `cwd`，会话服务写 header 前用 `path.isAbsolute` 校验 `cwd`；变更追踪
还用 `node:path` 折叠 git 输出的仓库路径、用 `copyFile`/`open`/`rm` 处理
快照与捕获；`@` 文件补全的 provider 用 `readdir` 扫描会话 `cwd`。对 `ssh://`
拼写，这些调用会落到本机（Windows 会把 `ssh://…` 解析成相对路径）并以 ENOENT
失败；`isAbsolute` 也把它判为相对。

`lib/fs-shim.js` 替换对应行为：只有 `ssh://` 拼写（及上节已学习的 scratch
镜像）改走远端，其余路径原样转发；然后 `module.syncBuiltinESMExports()`
同步到内建模块的 ESM facade——已加载模块的
`import { mkdir } from 'node:fs/promises'` 命名绑定也因此生效。覆盖面：

| 桥 | 行为 |
| --- | --- |
| `fs.mkdir` | 走 SFTP；写操作、受挂载围栏约束 |
| `fs.stat` / `lstat` / `realpath` | **身份探针**，见下节——有活连接时走 SFTP 取真实属性，无连接时对本插件挂载过的路径给出词法 / 合成答案，**绝不因探测而拨号** |
| `fs.readdir` | 走 SFTP；名字数组与 `withFileTypes` 的 `Dirent` 两种形态都复刻——类型判别取条目自身属性，符号链接既非文件也非目录（`@` 补全因此不会下钻目录符号链接）；`recursive` 明确 `ENOTSUP`。`@` 补全的远端扫描即此路径 |
| `fs.copyFile` | ssh 源经 SFTP 读（错误按 errno 映射，`FS_NOT_FOUND` → `ENOENT`）；目标为本机 scratch 时另镜像写远端（`GIT_INDEX_FILE` 指向的文件必须真在远端） |
| `fs.open(path, 'r')` | 只读 SFTP FileHandle（`stat` / `read` / `readFile` / `close`；单次读封顶 256KB），`inFlight` 钉住连接防止空闲回收；写模式同步 `EINVAL` |
| `fs.rm` | ssh 目标围栏内远端 `rm -rf`；已学习的 scratch 镜像 → 远端删除（尽力而为）+ 本机清理 |
| `path.isAbsolute` | `ssh://` 恒真 |
| `path.resolve` / `join` | 含 `ssh://` 时折叠为规范拼写——绝对 POSIX 参数替换远端路径、相对段追加、Windows 绝对参数复位回本机；左侧参数被绝对参数吞掉，与 node 语义一致 |
| `path.relative` | 同别名返回 POSIX 相对段（变更面板的 `display` 即工作区相对路径）；混合操作数返回右操作数，`isInside` 因此判「不在内部」 |

### 身份探针不得拨号

`stat` / `lstat` / `realpath` 是被**宿主主动**调用的，而且发生在用户操作之前：
`WorkspaceRegistry` 在 `init` 阶段对每个会话 header 的 cwd 做
`realpath` + `stat`（`indexHeader`），侧边栏渲染时还会问每个工作区的状态。
这三条原本都经 `engine.withSftp()` → `engine.acquire()`，而 `acquire()` **就是建立连接**。

后果是：**只要启动 DSH，所有已挂载工作区涉及的主机都会被连上**。用户离开时是全断开
状态，重启后却发现每条连接都活着——连接状态没能按原样恢复，而是被自己的元数据查询
反向"打开"了。

现在的规则按"有没有活连接"分岔，而判活用的是 `engine.pool` 而不是 `acquire()`：

| 情况 | 行为 |
| --- | --- |
| 已有活连接 | 走 SFTP 取**真实**属性（`stat` 仍能报出"远端已删除"） |
| 无活连接，路径在已挂载根内 | `stat`/`lstat` 给出合成的目录 `Stats`；`realpath` 直接返回词法规范拼写 |
| 无活连接，路径在挂载根外 | `ENOENT` |

中间一行是刻意的：DSH 用这些探针判断**会话是否仍属于某个工作区**，在那里抛错（而不是
明确 miss）会让 registry 把会话从记账里剪掉——卸载一个工作区不该顺手改写它的会话归属。
合成答案只声称"是目录"，不谎报大小或时间戳；挂载那一刻插件已经确认过它确实是目录。

回归测试在 `tests/probe-smoke.mjs`（15 项），断言直接数 `withSftp` / `acquire` 的调用
次数：把判活改回 `acquire()` 后 6 条变红。


`node:path` 的补丁覆盖默认导出与 `win32` / `posix` 命名空间（同一对象去重），
卸载时逐项复原；非 `ssh://` 调用必须逐字节等价于原实现，这是该层的回归底线。

### 一处补丁打不到的地方：按值捕获的 schema

`syncBuiltinESMExports()` 更新的是 ESM **绑定**，所以「在调用时读绑定」的代码都会看到补丁。
但 `@deepseek-ai/dsh-working-directory` 把谓词当**值**交给了 zod：

```js
const directorySchema = z.string().min(1).refine(isAbsolute).nullable()
```

这个 schema 在服务构造函数里建好，而 `working-directory` 在 roster 中排在插件之前，所以它
捕获的永远是原始 `isAbsolute`。后果是：会话头校验能过（`dsh-session` 读绑定），但**读历史**时
`sessionProjections.restore` 的 `viewSchema.parse(header.cwd)` 会失败，浏览器显示
`历史加载失败：failed to project session … Invalid input（gateway/internal）`——错误链一路
穿透到 gateway，提示里看不出真正原因。

插件不去改部署自带的 bundle（升级即失效），而是在 `lib/patch-projection.js` 里把**已注册**的那个
单元的两个 schema 换成惰性判定：`ssh://` 直接放行，其余原样交给原 schema。因为每个读路径都经
`def.stateSchema.parse` / `def.wire.viewSchema.parse`，替换这两个成员即覆盖 `restore`、
`viewCheckpoint`、`snapshot`、`cachedSnapshot`、`hydrate` 与变更推送。`register` 同时被包一层，
以覆盖「插件先加载、单元后注册」的重载/测试顺序。

放宽只有 `ssh://` 一种形态：相对路径与空串照旧被拒，`null` 照旧通过，其它投影单元不动。
回归测试是 `tests/projection-relax-smoke.mjs`（66 项，逻辑）与 `tests/projection-real-smoke.mjs`
（18 项，真实 `SessionProjectionRegistry` + `WorkingDirectoryService` + 真实 zod，按生产顺序
装配）。两者的反向验证都做过：禁用修复后分别有 9 条与 3 条断言变红。

这是一条**上游临时补丁**（`UPSTREAM-1-working-directory-isAbsolute`），不是插件的能力：
上游把 `refine(isAbsolute)` 改成 `refine((value) => isAbsolute(value))` 后它就该消失。
补丁会自己发现这一点——安装时先用一个 `ssh://` 值探测已注册的 schema，把结论记成一个显式状态
（`fixed` / `broken` / `pending` / `already` / `unprobeable` / `disabled`），而**不是**一个布尔：
"探不到宿主" 与 "宿主仍然是坏的" 必须能区分开，否则补丁静默失效时没有任何信号。

结论经引擎的 `noteUpstreamWorkaround()` 落到 `ssh_workspace_status` 的 `upstreamWorkarounds`
与一条 `upstream` 事件上——**不走 `ctx.logger`**，因为本部署没有 console exporter，
写进 logger 等于写进注释（见 [diagnostics.js](../lib/diagnostics.js) 的模块说明）。
登记与删除步骤见 [upstream-workarounds.md](./upstream-workarounds.md)，
模式本身见 [upstream-workaround-pattern.md](./upstream-workaround-pattern.md)。

## 工作区登记

`WorkspaceRegistry.create()` 内部用 `fs.realpath` 规范化路径，`ssh://` 永远
过不了。插件改用同一份持久化路径的 `createCanonical()`：保留完整的持久化与
顺序写入，只跳过宿主机 realpath 断言。浏览器半边的创建流程也是先
`POST /mount { register: true, title }` 预注册，再把路径交给 DSH 的接收链路。

被服务的工作区根（served-root 集）在内存里，而登记是持久的，因此重启后
`ctx.inject(['fs', 'workspaceRegistry'])` 会把 registry 里所有 `ssh://` 项
重新 `addRoot`——否则会出现「UI 里有、文件却打不开」的状态。

## 持久远端 shell

两条并存的通路，服务不同的调用方：

### 1. 独立工具 `ssh_workspace_shell`

`lib/shell.js`：`ShellManager` 按 `(别名, 会话名)` 维持一个 `sh -l` 的 SSH PTY
通道（`client.exec('sh -l', { pty: { cols, rows, term } })`），由
`ssh_workspace_shell` 工具驱动。通道经 `engine.openChannel` 建立，因此
`record.holds` 会钉住连接，空闲回收器不会在会话存活期间收走连接。

**退出码的取回**：PTY 没有独立的退出通道，所以每条命令后追加一行
`printf '\n<marker>%s<marker>\n' "$?"`，`$?` 在命令结束后立即捕获。接收端用
`<marker>(-?\d+)<marker>` 匹配"标记夹数字"，而不是 `lastIndexOf(marker)`——终端
会回显携带标记的那行 `printf`（其中是字面 `%s`），只有真正执行完的那一行才有
数字。收集到的正文开头是命令自身的回显，按首个换行截掉，避免模型把自己的输入
读回成输出。

**超时定时器不 `unref`**：它是"标记永不到达"时的唯一兜底；`unref` 之后进程空闲
时它可以永远不触发，调用方就一直挂着——正是它要防的故障。

**关闭**：`release` 被包装成幂等——引擎的 `openChannel` 在通道 close 时也会释放
一次，双重释放会让 `holds` 计数下溢。

### 2. 接管 `ctx.subprocess.spawnTerminal`

`lib/patch-terminal.js`：部署自带的持久 bash/pwsh 工具（`dsh-terminal-bash` 后端）
最终经 `ctx.subprocess.spawnTerminal(spec)` 要一个 PTY，而那是**本机原语**。不接管
时，`ssh://` 的 cwd 会让它要么失败、要么在本机对着一个只存在于远端的路径启动
shell。接管后，`spec.cwd` 是 `ssh://` 就改开 SSH PTY 通道，返回满足后端契约的
句柄（`output` / `write` / `resize` / `done` / `inspectForeground` /
`signalForeground` / `terminate`），其余 cwd 原样交给本机原语。

两个刻意的取舍：

- **`argv` 不复用**。`dsh-terminal-bash` 按**本机方言**构造命令行（Windows 上是
  PowerShell），远端 POSIX 主机无法执行。接管层改启动远端自己的交互式 `sh`——
  这正是上一版不做接管的理由，但缺口比方言问题更严重：不接管时持久工具在远端
  工作区上根本不可用。启动远端 `sh` 让宿主的工具链可用，代价是远端始终是 POSIX
  方言（工具描述里已写明）。
- **`inspectForeground` 返回 `undefined`**。本机句柄从进程表读前台进程组；一条
  SSH 通道拿不到等价信息，而给一个错误答案更糟——上层会把"前台仍在运行"当真，
  等满整个超时。返回 `undefined` 选择其文档化的「输出静默」兜底判定，正确且只是
  略不精确。`signalForeground` 则按 PTY 语义写 `\x03`（SIGINT）/ `\x1c`（SIGQUIT），
  无法用 PTY 表达的信号直接拒绝而不是静默忽略。

## 本机 ↔ 远端传输

`lib/transfer.js`：`transferFile` 双向分块（256 KiB）流式拷贝，字节不经过对话。
上传**先写同级暂存名 `<目标>.dsh-up-<pid>-<ts>`，成功后 `publishRename` 发布**，
因此目标在被替换前始终是旧内容或完整新内容；失败路径清掉暂存文件并按需保留
目标原内容。下载读至 EOF 而不是依赖 stat 时的长度（传输期间变长的文件会被完整
取回），本机同样先写暂存再 `rename`。`uploadTree` 递归上传本地目录，按名字排序
保证进度顺序稳定。

单文件上限 1 GiB（`DEFAULT_MAX_BYTES`），超限直接拒绝而不是尝试分配。

浏览器端另有一条 `GET /download` 流式路由（`lib/routes.js`），把字节直接写进响应
而不是编码成 JSON：base64 会放大三分之一、且受 4 MiB 请求体上限约束，而下载的
文件本来就可能远大于此。因为它不回答 JSON，所以不复用共享的 `guard()`，而是自己
重新施加回环来源 + `Host` 头双重校验，并只接受 GET。

## 能力探测与推送式变更监视

`engine.probeCapabilities(alias)` 用一次 `command -v` 往返探测 `rg` / `git` /
`inotifywait`，每个标记只在工具存在时打印，末尾打一个完成标记——**没有完成标记
的应答一律按"未知"处理**，不会把一次异常应答误报成"工具缺失"。结果按别名缓存
在 `engine.capabilities`，连接关闭（`closeRecord`）时失效，所以重连后会重新探测。
只有"至少一项已确定"的结果才入缓存，避免一次坏探测污染整个会话。

`remote-fs.js` 的 `watch` 先看探测结果：`inotifywait === true` 时走
`startPushWatch`（`inotifywait -m [-r] -e create,modify,delete,move,attrib`），否则
走原有轮询。推送路径的两条降级：

- **建立期就结束**（无该工具、路径被拒）：静默回落到轮询，不报错；
- **运行期断掉**（连接丢失、监视进程被杀）：通过 `onError` 上报，调用方重新挂上
  轮询——一条失效的通知通道降级，而不是静默沉默。

目录目标加 `-r`（与本地递归 watcher 对齐），文件目标不加（`inotifywait` 对文件
加 `-r` 会被拒绝），因此先 stat 判断目标是文件还是目录。

## 引擎与连接模型

`lib/engine.js`：每个别名一条 ssh2 长连接 + 一个 SFTP 通道（常开）——文件
系统后端一次工具调用会发很多小操作；远程命令在同一连接上另开 exec 通道。
大文件流式读取（`streamText`，预览与 read 工具）走**按需打开的第二条 SFTP
通道**（`engine.streamChannel`），传输期间统计、目录列表与变更监视仍走常开
通道、互不排队；第二条通道开不出来时退化为共用常开通道（流式能力不受影响）。
主要默认值（均可在插件配置的 `engine` 段覆盖，见根 README 配置表）：

| 项 | 默认 | 配置键 |
| --- | --- | --- |
| 连接超时 | 15s | `engine.connectTimeoutMs` |
| keepalive | 15s | `engine.keepaliveIntervalMs` |
| 空闲回收 | 30 分钟（sweeper 每 60s 扫一遍，有请求在飞不回收） | `engine.idleTimeoutMs` / `engine.sweepIntervalMs` |
| 主机变更 | `forget(alias)` 丢弃旧连接，下次操作按新配置重连 | — |
| 主动断开 | `hosts/disconnect` 先 `savedForwards.closeAlias(alias)`（逐条走 `closeById`，与端口行「断开」同一条路径）再 `forget(alias)`，响应 `closedForwards` 报告拆了几条隧道 | — |
| 测试连接 | `test` 连一次即 `forget(alias)` 释放（被转发的 `holds` 钉住时不释放） | — |
| 后台重连 | 1s 起指数退避、60s 封顶、默认不限次数 | `engine.reconnect.baseDelayMs` / `maxDelayMs` / `maxAttempts` / `jitter`（`false` 关闭） |

### 后台重连（`lib/reconnect.js`）

每个别名一台小状态机，由**连接意外关闭**驱动，不依赖「下一次操作」：

- **触发**：`client` 的 `close` 事件发现该记录**仍在池中**就武装（所有主动路径——`forget`、
  `sweep`、被替换的记录——都先摘池再 `end()`，所以「还在池里」等价于「不是我们关的」）。
  前台操作连接失败时也会把别名交给它，这是合盖唤醒后最常见的路径。
- **停止规则比延迟阶梯更重要**：每次尝试前重新问 `#isWanted(alias)`——已挂载根、
  `holds > 0`、或注册的额外谓词（`addWantedCheck`，目前是「该主机有 `enabled` 的保存转发」）。
  三者皆无就停，所以卸载最后一个工作区不会被后台拨号。不可恢复的错误（未知别名、
  读不到私钥、主机密钥不匹配）标记 `fatal` 后立刻停止，不每分钟重复同一个失败。
- **恢复消费者**：`onReconnected` 只由后台循环调用（前台 `acquire` 不调用，否则每次首次连接
  都像一次恢复而重开用户关掉的隧道），当前用途是重开该主机 `enabled` 的保存转发；文件系统
  seam 与持久 shell 在下次使用时自行重连。
- **可观测**：每轮写 `reconnect` 事件（前 3 次、之后每 5 次、以及结束那次，避免一下午的断网
  冲掉 40 条环形缓冲），状态经 `ssh_workspace_status` 的 `reconnecting` 字段与面板卡片暴露；
  `POST /hosts/reconnect` 跳过等待立即尝试。

**连接与转发的方向性是单向的**，且两个方向都有测试守着：

- 连接断 → 转发断（显式拆除，不依赖 ssh2 的 `close` 事件；主动断开走
  `savedForwards.closeAlias`，连接意外掉线才走 `ForwardManager.closeForAlias`）；
- 转发断 → 连接**不**断（`#teardown` 只递减 `holds`，构造上无法关闭 client）；
- 开转发时主机未连接 → 先连接（`open()` 首步 `engine.acquire()`）。

原始 ssh2 / SFTP 失败会被映射为稳定的 `FsError` 错误码
（`ENOENT` / `EACCES` / `EIO` 等），消费方只按码分支，不解析报错文本。
每次连接握手都做**主机密钥校验**：首次 TOFU 记录 SHA256 指纹到共享存储的
`knownHosts` 段，之后指纹不一致直接拒绝连接（详见 [hosts.md](./hosts.md)
的「主机密钥校验」）。

## peer 解析

`lib/peers.js` 的 `requirePeer` 依次尝试（结果按包名记忆化）：

1. 本包自己的 `node_modules`（profile 安装时即 profile 的依赖树）；
2. `DSH_PEER_ROOT`（可用路径分隔符列多个，测试或临时依赖树用）；
3. `DSH_PROFILE_DIR/node_modules`；
4. `$DSH_HOME/profiles/<DSH_PROFILE>/node_modules`，以及常见 profile 名
   `desktop` / `default` / `web`；
5. 部署自带树：`app.asar/dsh/node_modules`、`app.asar/node_modules`、
   `app.asar.unpacked/dsh/node_modules`（由 `process.resourcesPath` /
   `execPath` 推出；普通 Node 下这些路径不存在，探测即跳过）。

## 客户端半边

`lib/client.js` 是手写的单文件包（无构建步骤），由 DSH 客户端加载器执行：

- 通过 `slots` 挂「远程工作区」面板、「添加工作区」锚定菜单（以
  `priority: -100` 遮蔽原生 `directoryFlow` 双入口）与远端目录对话框；
- 工作区标记是 **DOM 装饰**：不删改 React 节点，隐藏原生文件夹图标、
  插入自有 `svg[data-sshwsp-mark]`，MutationObserver 自愈重扫；
- 与宿主通信走 25 条路由（前缀 `/api/dsh-ssh-workspace/`）：
  `hosts`、`hosts/save`、`hosts/delete`、`hosts/forget-key`、
  `hosts/disconnect`、`test`、`ls`、`status`、`mount`、`unmount`、`enable`、
  `forward`、`unforward`、`forward/save`、`forward/toggle`、`forward/delete`、
  `forward/remember`、`forward/probe`、`forward/settings`、`transfer`、
  `download`、`upload`。
  路由只服务**回环请求**：除 `remoteAddress`
  回环外，还要求 `Host` 头精确为本机监听端口的 `localhost` / `127.0.0.1` /
  `[::1]` 三种拼写之一，否则 403——仅凭回环地址挡不住 DNS rebinding（页面
  可把自己的域名解析到 127.0.0.1 从而同源访问），Host 校验把这条路堵死；
  反向代理 / 自定义域名访问会被一并拒绝（预期行为）。
- POST 路由（`hosts/save`、`hosts/delete`、`hosts/forget-key`、
  `hosts/disconnect`、`test`、`mount`、`unmount`、`enable`、转发七条、
  `transfer`）额外要求
  `content-type: application/json`，否则 415：
  跨站 HTML 表单只能发 `text/plain` / `urlencoded` / `multipart`，且
  `text/plain` 可伪造出合法 JSON 体，靠内容类型就能把整类跨站写请求挡在
  门外（浏览器半边始终携带该头，不受影响）。
  `upload` 是唯一例外：它按 `application/octet-stream` 接收原始字节，因此另行
  自行施加回环与 `Host` 双重校验（`download` / `upload` 都不走 `guard`）。
- **停用围栏**横跨所有缝：`engine.disabledWorkspaces` 是唯一真相，
  `ctx.fs`、内建 fs 桥、`ctx.shell`、`ctx.subprocess`、终端接管层与
  `transfer` / `download` / `upload` 在建立连接之前统一拒绝。
  详见 [unmount-modes.md](./unmount-modes.md)。

## 相关

- [protocol.md](./protocol.md)
- [development.md](./development.md)
- [根 README](../README.md)
