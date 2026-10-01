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
  ripgrep 与变更追踪的 git）；
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

### 写入围栏与符号链接裁决

词法围栏（`isRemotePathUnder`，规范化后做前缀比较）只是快路径；写 / 删
操作在落盘前还做一次**服务器 `realpath` 裁决**（`assertFencedRealpath`，
`lib/remote-fs.js`）：目标**父目录**经 `sftp.realpath` 解析后必须仍落在已
挂载根内，否则 `FS_SANDBOX_DENIED`。没有这一步时，围栏内一个指向外部的
符号链接（或中间目录为符号链接）会让词法判断与真实落点不一致，写入 / 删除
即可越界。覆盖点为所有写、删入口——原子替换（`#publish`）、`copyFile` 直写
与 `rm` 桥、`mkdir`；realpath 读取失败按 `FS_NOT_FOUND` 语义处理。
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

命令组装为 `export <env/dshEnv>; cd '<远端路径>' && <命令>`，由远端登录 shell
按 POSIX 语义执行——远端不是 PowerShell，公告已向模型说明。**沙箱边界**：
本机文件沙箱不跨 SSH，spec 上的 `sandboxPolicy` 对远端 workdir 不适用，远端
命令以远端登录用户的完整权限运行。

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
| `fs.mkdir` / `stat` / `lstat` / `realpath` | 走 SFTP；`mkdir` 是写操作、受挂载围栏约束；`realpath` 返回词法规范化的 `ssh://` 拼写（不请求服务器 realpath），与会话 header、工作区登记保持一致 |
| `fs.readdir` | 走 SFTP；名字数组与 `withFileTypes` 的 `Dirent` 两种形态都复刻——类型判别取条目自身属性，符号链接既非文件也非目录（`@` 补全因此不会下钻目录符号链接）；`recursive` 明确 `ENOTSUP`。`@` 补全的远端扫描即此路径 |
| `fs.copyFile` | ssh 源经 SFTP 读（错误按 errno 映射，`FS_NOT_FOUND` → `ENOENT`）；目标为本机 scratch 时另镜像写远端（`GIT_INDEX_FILE` 指向的文件必须真在远端） |
| `fs.open(path, 'r')` | 只读 SFTP FileHandle（`stat` / `read` / `readFile` / `close`；单次读封顶 256KB），`inFlight` 钉住连接防止空闲回收；写模式同步 `EINVAL` |
| `fs.rm` | ssh 目标围栏内远端 `rm -rf`；已学习的 scratch 镜像 → 远端删除（尽力而为）+ 本机清理 |
| `path.isAbsolute` | `ssh://` 恒真 |
| `path.resolve` / `join` | 含 `ssh://` 时折叠为规范拼写——绝对 POSIX 参数替换远端路径、相对段追加、Windows 绝对参数复位回本机；左侧参数被绝对参数吞掉，与 node 语义一致 |
| `path.relative` | 同别名返回 POSIX 相对段（变更面板的 `display` 即工作区相对路径）；混合操作数返回右操作数，`isInside` 因此判「不在内部」 |

`node:path` 的补丁覆盖默认导出与 `win32` / `posix` 命名空间（同一对象去重），
卸载时逐项复原；非 `ssh://` 调用必须逐字节等价于原实现，这是该层的回归底线。

## 工作区登记

`WorkspaceRegistry.create()` 内部用 `fs.realpath` 规范化路径，`ssh://` 永远
过不了。插件改用同一份持久化路径的 `createCanonical()`：保留完整的持久化与
顺序写入，只跳过宿主机 realpath 断言。浏览器半边的创建流程也是先
`POST /mount { register: true, title }` 预注册，再把路径交给 DSH 的接收链路。

被服务的工作区根（served-root 集）在内存里，而登记是持久的，因此重启后
`ctx.inject(['fs', 'workspaceRegistry'])` 会把 registry 里所有 `ssh://` 项
重新 `addRoot`——否则会出现「UI 里有、文件却打不开」的状态。

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
- 与宿主通信走 9 条路由（前缀 `/api/dsh-ssh-workspace/`）：
  `hosts`、`hosts/save`、`hosts/delete`、`hosts/forget-key`、`test`、`ls`、
  `status`、`mount`、`unmount`。路由只服务**回环请求**：除 `remoteAddress`
  回环外，还要求 `Host` 头精确为本机监听端口的 `localhost` / `127.0.0.1` /
  `[::1]` 三种拼写之一，否则 403——仅凭回环地址挡不住 DNS rebinding（页面
  可把自己的域名解析到 127.0.0.1 从而同源访问），Host 校验把这条路堵死；
  反向代理 / 自定义域名访问会被一并拒绝（预期行为）。
- POST 路由（`hosts/save`、`hosts/delete`、`hosts/forget-key`、`test`、
  `mount`、`unmount`）额外要求 `content-type: application/json`，否则 415：
  跨站 HTML 表单只能发 `text/plain` / `urlencoded` / `multipart`，且
  `text/plain` 可伪造出合法 JSON 体，靠内容类型就能把整类跨站写请求挡在
  门外（浏览器半边始终携带该头，不受影响）。

## 相关

- [protocol.md](./protocol.md)
- [development.md](./development.md)
- [根 README](../README.md)
