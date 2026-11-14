<div align="center">
<img src="https://raw.githubusercontent.com/siqyka/dsh-ssh-workspace/main/docs/assets/header.png" alt="dsh-ssh-workspace header" width="840" />

# dsh-ssh-workspace

**把一台 SSH 主机上的目录，当作 DSH 工作区使用。**

`read` / `write` / `edit` 通过 SFTP 直接读写远端文件——
不需要手动同步、不需要挂载驱动、不需要装任何第三方文件系统。

[![version](https://img.shields.io/github/package-json/v/siqyka/dsh-ssh-workspace)](https://github.com/siqyka/dsh-ssh-workspace)
[![license](https://img.shields.io/github/license/siqyka/dsh-ssh-workspace)](https://github.com/siqyka/dsh-ssh-workspace/blob/main/LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)
![dsh](https://img.shields.io/badge/DSH-%3E%3D%200.2.0--rc.1-blue)
![ssh2](https://img.shields.io/badge/ssh2-%5E1.17.0-lightgrey)

**简体中文** · [English](https://github.com/siqyka/dsh-ssh-workspace/blob/main/README.en.md)

</div>

---

<table>
<tr>
<td align="center" width="33%">

**SFTP 直通**

读写编辑全程走 SFTP，
完整错误语义 + 原子写入

</td>
<td align="center" width="33%">

**远端执行**

shell / ripgrep / git
都落在远端主机上跑

</td>
<td align="center" width="33%">

**界面集成**

文件树、`@` 引用、拖拽进任务、
主机管理面板，开箱即用

</td>
</tr>
</table>

## 目录

- [概览](#概览)
- [快速开始](#快速开始)
- [主机管理](#主机管理)
- [配置](#配置)
- [Agent 工具](#agent-工具)
- [能力一览](#能力一览)
- [限制](#限制)
- [实现要点](#实现要点)
- [文档索引](#文档索引)
- [许可证](#许可证)

## 概览

工作区路径语法：

```
ssh://<主机别名>/<远端绝对路径>
例如  ssh://myserver/home/user/project
```

界面里这类路径**显示**为 `ssh://<主机别名>@/<远端绝对路径>`（别名后插入 `@`，
读起来像 SSH 地址）——侧栏工作区行的悬停卡片、右侧栏「文件」面板头部、
文档预览头部等处都是这种显示；复制与一切功能（挂载、文件操作、工具调用）
使用的仍是实际拼写 `ssh://<主机别名>/<远端绝对路径>`。

### 它解决什么问题

DSH 的所有文件操作都走 `ctx.fs`（`@deepseek-ai/dsh-fs`）这一个服务抽象。
本插件在这个抽象上增加了一个「远端半边」：

```
        DSH 工具层（read / write / edit / bash / glob / grep / 变更面板）
                                   │
                              ctx.fs 路由
                                   │
            ┌──────────────────────┴──────────────────────┐
            │                                             │
   ssh://<alias>/<path>                        其他任何路径（E:\…、/home/…）
            │                                             │
   本插件的 SFTP 后端 ──► SSH 主机              部署原有的本地（沙箱）后端
```

因此**本地工作区的一切照旧**，包括沙箱写入围栏、版本守卫、原子写入；
远端工作区则获得同一套工具和同一套错误语义。

## 快速开始

1. **安装**：打开官方桌面客户端，进入「设置」中的「插件」页面（或左侧导航栏的插件入口）；
2. **输入来源**：在插件管理界面的安装输入框中二选一，点击安装：
   - **npm 包**（走 npm 分发，支持锁定版本）：
     `@shiqyka/dsh-ssh-workspace`，或指定版本
     `@shiqyka/dsh-ssh-workspace@0.2.8`
     （[npm 页面](https://www.npmjs.com/package/@shiqyka/dsh-ssh-workspace)）；
   - **仓库地址**（从 Git 取最新代码）：
     `https://github.com/siqyka/dsh-ssh-workspace`
     （这种方式由插件管理器代为安装依赖；手动 clone 后 link 进 profile 才需要看下一节）
3. **重启**：安装完成后重启客户端，即可开始使用。

之后的使用流程：

```
「远程工作区」面板确认主机（首次可添加）
        │
        ▼
「添加工作区 → 新建远程工作区」选主机、浏览远端目录并挂载
        │
        ▼
在该工作区里新建会话 —— 文件读写、shell、搜索、变更追踪自动落到远端
```

### 从源码仓库使用

```bash
git clone https://github.com/siqyka/dsh-ssh-workspace.git
cd dsh-ssh-workspace
npm ci          # ssh2 是直接依赖，不随 clone 到位
```

装完重启客户端即可。

## 主机管理

主机记录存放在 `$DSH_HOME/dsh-ssh.json`；没有该文件时，会退回到读取
`~/.ssh/config` 里具体的 `Host` 块。因此**已经配好的主机无需重复配置**。

「远程工作区」面板里可以直接**添加 / 编辑 / 删除**主机，写回
`$DSH_HOME/dsh-ssh.json`（原子写入，保留文件里本插件不认识的字段）。
`~/.ssh/config` 中的主机是**只读回退**，面板不会修改那个文件；
与存储同名的主机以存储为准。密码 / 私钥口令**加密保存**在 `dsh-ssh.json` 的
`secrets` 段（AES-256-GCM，密钥是 `$DSH_HOME/dsh-ssh.key`，仅本用户可读），
且不会回传到浏览器，编辑时留空表示保持原值。
删除主机不会自动卸载已挂载的工作区，但那些工作区会因主机不存在而无法访问。

> 存储格式、`~/.ssh/config` 解析规则与凭据策略细节见 [docs/hosts.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/hosts.md)。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `announceToAgent` | `false` | 是否向每个 agent 注入能力说明（系统提示词段落） |
| `localPassthrough` | `['$DSH_HOME/attachments', '$DSH_HOME/plugins']` | 在 `ssh://` 会话中保留本机语义的**本机绝对前缀**；`false` / `[]` 关闭。只做词法前缀匹配，不接受整目录 `$DSH_HOME` |
| `localPassthroughScheme` | `local` | 显式点名本机路径的 scheme 名（`local:/abs/path`）。**≥ 3 个字符**，小写字母、数字与 `+ - .`；`ssh` / `file` / `sftp` / `dsh-app` 与常见 URL scheme 是保留名（清单由 `/status` 下发）；**一次只能配一个**，换名字即整体替换；前缀名不区分大小写、路径按平台。**只是首次默认**，面板里存过之后以存储为准 |
| `localPassthroughFallback` | `false` | `@` 点名的 POSIX 绝对路径先按远端解析，远端**确实不存在**时是否回退读本机同名文件（只读）；同样只是首次默认，面板里保存过之后以 `dsh-ssh.json` 为准 |
| `allowLan` | `false` | 局域网部署：浏览器的 HTTP 路由接受私网来源地址（IPv4 RFC1918、IPv6 ULA/链路本地） |
| `allowedHosts` | `[]` | 额外放行的 `Host` 值（配合 `allowLan`，如面板经局域网主机名访问时） |
| `engine.idleTimeoutMs` | `1800000` | 连接空闲超过该时长后回收（毫秒） |
| `engine.connectTimeoutMs` | `15000` | 单次 SSH 连接握手超时（毫秒） |
| `engine.keepaliveIntervalMs` | `15000` | keepalive 心跳间隔（毫秒） |
| `engine.sweepIntervalMs` | `60000` | 空闲连接的扫描周期（毫秒） |
| `engine.reconnect` | 见下 | 断线后的后台重连策略；传 `false` 退回「只在操作时重连一次」 |
| `engine.reconnect.baseDelayMs` | `1000` | 首次重试的等待（毫秒），之后按 2 的幂增长 |
| `engine.reconnect.maxDelayMs` | `60000` | 单次等待的上限（毫秒） |
| `engine.reconnect.maxAttempts` | `0` | 最多尝试次数；`0` 表示不限次数 |
| `engine.reconnect.jitter` | `0.2` | 向下抖动的比例，用来避免多主机同时重连；不会超过上限 |

> `engine` 下各项均为可选（非法值回落默认），通常无需配置。

### 本机路径直通（`localPassthrough`）

`ssh://` 会话默认把所有绝对路径当成**远端绝对路径**。聊天框上传的附件却存在运行 DSH 的这台
机器上，所以它的句柄路径需要一个例外：

```yaml
# 默认值；通常不用写
localPassthrough:
  - $DSH_HOME/attachments
  - $DSH_HOME/plugins
```

- 只接受**本机绝对路径前缀**；`$DSH_HOME`、`${DSH_HOME}` 和开头 `~` 会被展开，其它变量、
  相对路径、`ssh://` 前缀会告警并忽略。
- **`@` 显式引用的本机路径**同样直通：你在消息里用 `@F:\123.txt` / `@"C:\a b.txt"` 点名一个
  Windows 盘符或 UNC 路径（`@` 必须在行首或空白之后），它按本机路径读取，即使没写进上面的前缀。
  这个例外只认盘符与 UNC——POSIX 远端没有盘符，拼写因此无歧义；`@src/a.js`、`@/tmp/x` 仍是
  远端引用。登记表进程内共享、上限 256 条（先进先出），重启后按会话历史重新登记，所以恢复的
  会话照样能读到；整目录 `$DSH_HOME` 即使被 `@` 点名也拒绝（那里有 SSH 私钥）。
- **显式 scheme 点名**：`local:/Volumes/SSD/a.md`（POSIX）与 `local:F:\123.txt`（Windows）
  无条件按本机读取，路径部分是去掉前缀后的绝对路径。前缀名就是 `localPassthroughScheme`，
  在面板「文件引用设置」一区的「显式文件引用 scheme」里改（输入框的可访问名仍是「本机路径前缀」），
  保存即生效（不必重启）。未启用的前缀**明确拒绝**
  （`FS_PERMISSION_DENIED`），不会悄悄变成远端路径去试；`ssh:` 是保留名，配不上。
  **同一时间只能配一个前缀**：换名字就是整体替换，旧前缀立刻失效，两个不会并列。
  名字至少 **3 个字符**（1 个字符会与 Windows 盘符抢同一段文本，如 `c:/x`）；
  `file:` / `sftp:` / `dsh-app:` 与常见 URL scheme 也被保留（`file:///` 是本插件为远端路径写出的
  URI，同一拼写不能两头都占）。前缀名本身不区分大小写，冒号后的路径部分按平台
  （Windows 不区分、macOS/Linux 区分）。
  这个前缀只对匹配的前缀与 `@` 点名的路径有效——它不会把裸的 `F:\123.txt` 或 `/tmp/x`
  变成本机读。
- **远端优先、miss 再回退（可选）**：勾上「远端不存在时回退本机同名文件」后，`@/Volumes/SSD/PARAMS.md`
  这类 POSIX 绝对路径仍先按远端解析；只有远端**确实报不存在**时，才试一次本机同名文件，并在
  返回内容末尾附 `[ssh-workspace]` 说明来源。回退只发生在读（`read` / `read_image` /
  `streamText` / `lstat`），写、`glob`、`grep` 与目录列表**从不回退**；关掉这个开关即恢复
  「POSIX 绝对路径全是远端」。
- 命中前缀的路径在本会话里走本机后端；未命中的绝对路径仍是远端，不会因为本机恰好存在同名
  文件而改判（没有 `stat` / 存在性探测）。
- 匹配是词法的：`attachments/../dsh-ssh.json` 归一化后不匹配；不解析符号链接。
- **写围栏不变**：直通只决定“哪个世界”，不把前缀加入本地可写根；`read-only` /
  `workspace-write` 的本地限制照旧。
- 不要把整个 `$DSH_HOME` 加进来——那里有 `dsh-ssh.json`、`dsh-ssh.key` 和会话数据；插件
  会拒绝这个前缀。远端若存在同名前缀，按本机直通优先，文档明确接受这一取舍。
- `false` 或 `[]` 关闭直通；设置后需重启 DSH 生效。默认值跟随 `$DSH_HOME`（未设置时是
  `~/.dsh`）。
- **直通有边界，边界是 `ctx.fs`**：宿主官方 `read` / `write` / `edit` / `read_image` 与
  `node:fs` 走这条缝，直通对它们生效；**不经过 `ctx.fs` 的读取仍然读不到**。本部署里
  dsh-ops 的 `inspect_local_file` / `read_files` / `glob` / `grep` 会带着会话 cwd 启动本机
  worker 进程，`ssh://` cwd 下必然失败（`EXECUTOR_UNAVAILABLE`，文案带
  `only git and ripgrep`；带 `workdir` 的 `ops_bash` 报 `invalid workdir`）。这是上游的结构性
  错配，不是授权拒绝，重试无用——换入口：读远端用 `ssh_workspace_exec` / `ssh_workspace_shell`，
  读本机文件用 `ssh_workspace_transfer` 上传到该主机 `/tmp` 再读。详见
  [troubleshooting.md](./docs/troubleshooting.md#直通了为什么还是读不到)。

### 局域网部署（`allowLan`）

默认只接受**本机回环**访问（`127.0.0.1` / `::1` / `localhost`）。webserver 绑定
`0.0.0.0`、浏览器从局域网另一台机器访问时，请求会被 `forbidden: loopback-only`
拒绝——这是防 DNS-rebinding 的围栏，不是故障。设 `allowLan: true` 后：

- 来源地址放宽到**私网地址**（IPv4 `10/8`、`172.16/12`、`192.168/16`；IPv6 ULA
  `fc00::/7` 与链路本地 `fe80::/10`），公网地址仍被拒绝；
- `Host` 头必须命名**本机真实监听地址**（由本机各网卡地址 + 端口拼出，回环拼写
  始终有效），不匹配的 Host 仍以 `forbidden: unexpected Host header …` 拒绝——
  防 rebinding 语义原样保留；
- 若面板经一个本机网卡不知道的名字访问（局域网主机名、反代拼写），把它加进
  `allowedHosts`（大小写与首尾空白不敏感，可带端口也可不带）；
- POST 的 JSON content-type 校验、405/415 等其余防护不变。

安全语义的完整说明见 [SECURITY.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/SECURITY.md)。

## Agent 工具

| 工具 | 用途 |
| --- | --- |
| `ssh_workspace_hosts` | 列出可用主机（store + `~/.ssh/config` 候选） |
| `ssh_workspace_mount` | 把一个远端目录登记为工作区，返回 `ssh://` 路径 |
| `ssh_workspace_unmount` | 停用远端工作区（默认保留记录与会话，可逆；勾选「同时删除记录」才归档会话并删除记录） |
| `ssh_workspace_enable` | 重新挂载被停用的工作区并取消归档其会话 |
| `ssh_workspace_status` | 当前挂载 / 停用列表、连接、转发与持久会话状态 |
| `ssh_workspace_exec` | **在远端**执行 shell 命令（可 `run_in_background`） |
| `ssh_workspace_shell` | 在**持久**远端 shell 里执行命令，状态跨调用保留 |
| `ssh_workspace_transfer` | 本机 ↔ 远端传文件（SFTP，不经对话内容） |
| `ssh_workspace_forward` | 把远端端口映射到本机，返回可打开的 URL |
| `ssh_workspace_unforward` | 关闭端口映射并释放本地端口 |

> 工具的参数、返回字段与错误语义详见 [docs/tools.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/tools.md)。

## 能力一览

> 完整的按域清单（含依赖、降级与边界）见 [docs/features.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md)。

### 远端文件

| 能力 | 说明 |
| --- | --- |
| 完整错误语义 | `read` / `write` / `edit` 全程走 SFTP，含 `FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`FS_AMBIGUOUS_EDIT`、`FS_NOT_TEXT`、`FS_TOO_LARGE`、`FS_NOT_FOUND` 等 |
| 原子写入 | 先落同目录暂存文件再替换；优先 `posix-rename@openssh.com`，服务器不支持时退化为「先删后改名」（此时不再原子） |
| 换行符保真 | 编辑 CRLF 文件不会把它改成 LF |
| 二进制与编码 | 文本读取拒绝 NUL / 非法 UTF-8；`readBytes` 原样返回字节 |
| 写入围栏 | 远端写入只允许落在已挂载的远端工作区内，越界返回 `FS_OUTSIDE_WORKSPACE`；**「仅可查看」模式同样会挡住远端写入**（`FS_SANDBOX_DENIED`）。读取不受限制 |
| 大文件流式读取 | 预览与 `read` 按块（256 KiB）流式读取，不再整文件进内存 |
| 本机路径直通 | 聊天框上传的非图片附件等**本机绝对路径**在 `ssh://` 会话里仍按本机路径解析（`read` / `read_image` / `node:fs`）；默认只放行 `$DSH_HOME/attachments` 与 `$DSH_HOME/plugins`，其余绝对路径仍按远端解释，**不做存在性探测**。消息里用 `@` 点名的 Windows 盘符 / UNC 路径同样直通；`local:/abs/path` 这类显式前缀点名本机（前缀名可改），未启用的前缀明确拒绝而不是猜 |
| 远端变更自动刷新 | 优先用远端 `inotifywait` 推送事件（即时、不受 mtime 精度限制）；未安装时回退到轮询——基础约 2 秒一次，空闲目录自适应退避（连续 15 轮无变更退至 5 秒、30 轮至 10 秒封顶），任一变更立即回到 2 秒；轮询路径下 SFTP 元数据无亚秒时间戳，同一秒内等长的连续改写可能不触发刷新，增、删、改名总能感知 |

### 远端执行

| 能力 | 说明 |
| --- | --- |
| shell 命令远端化 | 会话工作区是 `ssh://` 时，`pwsh` / `bash` 工具在远端以 POSIX shell 语义执行——一次性命令、后台任务、超时与中止都按 DSH 的进程契约工作；本地 `workdir` 的命令不受影响 |
| glob / grep 远端搜索 | 调用**远端主机上的 ripgrep（`rg`）**返回真实远端结果；远端未安装 ripgrep 时得到带安装提示的明确失败（退出码 127） |
| 变更追踪远端化 | 「变更」（deliverables）面板用**远端 git** 做回合快照与 diff——远端 shell 改的文件也会出现在变更列表（+N/−N、点开看 diff）；远端未装 git 时自动降级关闭，其余功能不受影响 |

### 界面集成

| 能力 | 说明 |
| --- | --- |
| 新建会话可用 | 宿主机自带的 `node:fs/promises`（会话控制器 `mkdir`、注册表 `realpath` / `stat`）对 `ssh://` 路径同样走 SFTP，`node:path.isAbsolute` 判为绝对路径——可直接在远端工作区新建会话 |
| 重启后自动重新挂载 | 已登记的 `ssh://` 工作区在下次启动时从持久化 registry 恢复挂载 |
| 「工作区文件」侧边栏 | 文件树直接列出远端目录，文本预览经 SFTP 读取；`fs.fileUrl` 按契约返回远端执行世界的规范 `file:` URI |
| `@` 远程文件引用 | 聊天输入框的 `@` 补全候选来自**远端**目录（递归索引 + 模糊排名，含 `/` 逐级下钻，目录符号链接不跟随），选中插入 `@相对路径`，模型 `read` 读取的正是所选远端文件 |
| 拖拽 / 右键把文件加入任务 | 文件树的文件与文件夹可**直接拖到聊天输入框**（悬停显示虚线高亮，松开插入引用 chip），或**右键「添加到任务」**——与 `@` 补全选中效果完全一致 |
| 系统文件拖入远端文件树 | 从系统文件管理器把文件拖到**远端**「文件」树即可上传；落点决定目标目录（目录行自身、文件行父目录、展开目录内的空白归该目录、树体空白归根），文件夹与本地工作区会被明确拒绝，树外仍走 DSH 原有附件行为。详见 [ui.md](docs/ui.md#从系统拖入文件上传) |
| 「添加工作区」远程入口 | 「添加工作区」按钮替换为锚定菜单，两步完成：「新建本地工作区」/「新建远程工作区」二选一，再走各自流程。本地直接渲染**已安装的 browse 面板本身**（同一个组件、同一套 locale 与列目录调用；没有应用内浏览器的部署回落到 `pickDirectory()`）；远程是「选主机 → 逐级浏览远端目录 → 确认挂载」（目录不可写时警告并拒绝创建） |
| 「变更请求」tab 的最近提交历史 | 官方 Forge 面板的下半部分追加一条只读的最近提交条（同一个 tab，不新增页签）：插件按官方 tab 的 key 遮蔽该槽位，上半仍渲染官方组件、下半渲染自建历史区块；宿主新增只读路由 `GET /api/dsh-ssh-workspace/git-history`，只接受会话自己的工作目录，用固定 argv 的 `git log` 取数。详见 [commit-history.md](docs/commit-history.md) |
| 远程工作区专用标记 | 本插件创建的远程工作区在侧栏行、工作区选择器与会话页工作区按钮处显示远端标记图标，而不是普通文件夹图标 |
| 主机管理面板 | 添加 / 编辑 / 删除主机（私钥路径、认证方式、备注等），改动立即生效并丢弃该别名旧连接；`~/.ssh/config` 主机只读展示；「测试连接」只探测可达性（连上即释放，不会留下连接），结果以顶部 toast 弹出，7 秒自动消失（点击 / Esc 可提前关闭，悬停暂停）；错误可就地展开诊断码与原始错误、复制整段诊断，测试连接可安全重放所以带「重试」；「已连接」状态内联在主机名后，断开时连带拆除该主机的端口转发 |
| 浏览目录对话框 | 主机卡片的「浏览目录」逐级浏览远端目录，并可就地「挂载此目录」；**只浏览 / 挂载**，不提供上传、下载或内联队列（传输入口在文件树行菜单与文件面板头部） |
| 行菜单：新建文件夹 / 重命名 / 删除 | 宿主文件树行菜单提供重命名与删除：远端行与**本地行**都可重命名（只改名、不换目录）与删除（目录连同子目录、需确认）；目标已存在时拒绝；失败保持原样；F2 / Delete 触发同一动作。**远端目录行**另有「新建文件夹」，走 `POST /mkdir`（父目录 + 单个路径段名称，越界 / 只读 / 停用 / 重名在写盘前拒绝）；成功后重新列目录并选中新行。本地目录行的这一项不提供——本地新建走空白处菜单（见下一行），两条入口不重复。行菜单收窄为 220px 单行、最多 8 项、最多三组分隔线（「加入任务」｜「传输/复制」｜「下载到本机」｜「新建文件夹 / 重命名/删除」）。菜单文案固定、不带数字：删除永远是「删除」，下载永远是「下载到本机」；选几行由 `resolveTargets` 判决，数量写在删除确认框与下载目标对话框里 |
| 文件树空白处右键（本地工作区） | 在本地工作区「文件」树的空白处右键，弹出恰好两项的菜单：「新建文件夹」与「复制路径」。目标目录是**空白处所属的那一个**——落在某个已展开目录的子列表里就是这个目录，否则是树根；两者都必须在该树根之内。新建走同一个 `POST /mkdir` 的本地分支（单个路径段名称，越界 / 只读 / 重名在写盘前拒绝），成功后重新列目录并选中新行；「复制路径」始终可用，只读会话只禁用新建。远端工作区保留原来的空白处菜单，不混用。 |
| 文件面板 / 上传 / 下载 | 上传入口只有文件树行右键菜单「上传文件到此目录」（仅远端行）；「工作区文件」面板头部只留一个托盘箭头图标入口（**仅当面板显示的是 `ssh://` 远程工作区时出现**；本地目录沿用宿主自己的头部；在远端列表里它不随队列清空而隐藏），空闲是裸图标、有排队或运行中的传输时变蓝并套上聚合进度环（数量放在无障碍名称里），点开是进度浮层（逐项进度、速度与进度条、取消、清除已完成；进行中在上，已结算最新在前）。右侧文件树本身仍是宿主组件——插件不改它的 JSX，只在它上面叠加多选（见下节） |

### 多选、重命名与删除

**入口**：多选就做在右侧「文件」标签那棵树里——不需要先打开任何对话框。插件不接管那棵树（它是宿主的 DOM），只给它加自有类、并用文档级监听接管点击与键盘。

| 手势 | 结果 |
| --- | --- |
| 单击目录 | 进入该目录，并清空选择、重置锚点 |
| 单击文件 | **既选中它，也照常打开**（导航放行；只有带修饰键的单击才吃掉导航） |
| Ctrl/Cmd+单击 | 切换该行；**命中目录只选中、不进入** |
| Shift+单击 | 从锚点到该行的连续区间；**第一次 Shift 会直接播种锚点**，所以连续两次 Shift+单击就能连选，不需要先普通点击（普通点击文件会打开预览）；**命中目录只选中、不进入**；锚点不变 |
| Ctrl/Cmd+Shift+单击 | 把该区间追加进现有选择 |
| 右键（选择之外） | 选择收拢到该行再出菜单；不打开 |
| 右键（选择之内） | 保留整批选择；菜单文案不变，目标是整批 |
| Ctrl/Cmd+右键 | 切换该行后出菜单 |
| Shift+右键 | 从锚点扩区间后出菜单 |
| 单击空白 / Esc | 清空选择（Esc 保留键盘光标） |
| Ctrl/Cmd+A | 全选（含目录） |
| ↑/↓、Home/End | 移动光标并选中；Shift 扩展区间；Ctrl+↑/↓ 只移光标 |
| Enter | 打开光标所在目录 |
| F2 / Delete | 重命名 / 删除光标或选中行 |

选中行是背景高亮加光标行描边，**任何行都不渲染复选框，也没有“选择模式”开关，树的下方也不再浮出批量条**。选中一行以上后在选中行上右键，菜单仍然是同一个「下载到本机」——文案不随选择数变化，作用范围由选择决定；它复用同一个传输队列，不另开一套。目标超过一项时先确认（写明将下载多少项），再**只选一次目标目录**，随后整批入队逐个下载——目标目录依次回落到浏览器目录句柄、宿主目录选择器、单文件保存框，取消选择即取消整批。行菜单里新增的「重命名」「删除」对远端行与**本地工作区行**都可用：重命名是**行内改名**（文件名原位变输入框，Enter 提交、Esc 取消、被拒绝时保持打开并标红），只改名、不换目录，目标已存在时直接拒绝；删除目录会连同子目录一起删，并先给出数量、名称与「不可恢复」的确认；失败不乐观更新，列表保持原样并给出原因。

### 连接模型

每个别名一条长连接——一个常开 SFTP 通道，shell 命令在同一条连接上另开
exec 通道；空闲 30 分钟回收（有操作在飞的连接不回收）。

首次连接记录服务器主机密钥指纹（TOFU），之后指纹变更会被**拒绝连接**并提示
新旧指纹——防止中间人攻击；主机重装后可在面板里「忘记主机密钥」重新信任。

## 限制

明确**不支持**的：

- **`ProxyCommand`（仅此一项）**：仍然拒绝——它是任意本地命令执行，而配置文件
  是数据，不能变成「读配置 = 执行程序」。`ProxyJump` 已支持：按 `ssh -J` 的
  形状逐跳建独立连接（最多 8 跳），目标只看到直接邻居；`none` 表示强制直连。
  带 `ProxyCommand` 的主机会在解析时被**明确拒绝**并说明原因，而不是悄悄按
  直连去试。
- **shell 命令的落点由 `workdir` 决定**。会话工作区为 `ssh://` 时，
  `pwsh` / `bash` 的命令在远端主机执行——按 POSIX shell 语义、不受本机文件
  沙箱约束（以远端登录用户的完整权限运行）；本地 `workdir` 的命令仍在本机
  沙箱内。未挂载的路径、主机巡检等场景仍用 `ssh_workspace_exec`。

## 实现要点

<details>
<summary><b>展开查看：四条核心实现路径</b>（不注册第二个 fs 服务、桥接宿主内建模块、接管 ctx.subprocess、工作区登记绕过 realpath）</summary>

<br>

- **不注册第二个 `fs` 服务**：直接给部署已挂载的 `ctx.fs` 实例装上远端方法
  （自有属性），其余方法原样转发给原后端（绑定原始 receiver），安装顺序无关。
- **桥接宿主内建模块**：`node:fs/promises` 的 `mkdir` / `stat` / `lstat` /
  `realpath` / `readdir` 与 `node:path.isAbsolute` 对 `ssh://` 拼写单独处理（含
  `syncBuiltinESMExports`），让创建会话、登记工作区等发生在 agent 之前的调用也走 SFTP；
  `node:path` 的 `resolve` / `join` / `relative` 同样理解 `ssh://`（变更追踪用
  它们折叠 git 输出的仓库路径），`copyFile` / `open` / `rm` 服务快照与捕获，
  `readdir` 服务 `@` 补全的远端目录扫描。
- **接管 `ctx.subprocess`**：`cwd` 为 `ssh://` 的子进程在远端执行——glob / grep
  的 ripgrep 与变更追踪的 git 都走这条路（其余 spawn 原样转发）；命令白名单、
  POSIX 脚本组装、handle 契约（`done` / `collected` / `terminate` 阶梯）与本地一致。
- **工作区登记绕过 `realpath`**：走 `createCanonical()`，保留完整的持久化与
  顺序写入，绕过宿主机 `realpath` 断言。

</details>

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [features.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md) | **功能说明**：按能力域列出的完整功能清单（工作区 / 文件 / 执行 / 传输 / 转发 / 界面 / 安全 / 配置 / 降级矩阵 / 边界） |
| [architecture.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/architecture.md) | 架构与实现：`ctx.fs` / `ctx.shell` / `ctx.subprocess` 接管、变更监视与流式读取、内建桥接、引擎与连接模型 |
| [protocol.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/protocol.md) | `ssh://` 路径协议：语法、规范化、显示规则、`file:` URI、写入围栏与停用围栏 |
| [hosts.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/hosts.md) | 主机配置与认证：存储格式、`~/.ssh/config` 回退、面板管理 |
| [tools.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/tools.md) | Agent 工具参考：11 个 `ssh_workspace_*` 工具（含 `reverse_forward`） |
| [ui.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md) | 界面指南：面板、添加工作区双入口、远程工作区标记、端口转发与持久会话区、文件引用设置 |
| [forward-persistence.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/forward-persistence.md) | 端口转发持久化：意图与事实的分离、两条断开路径的一致性、自动开启 |
| [development.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/development.md) | 开发、调试与发布：源码结构、依赖解析、打包流程 |
| [upstream-workarounds.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/upstream-workarounds.md) | 上游临时补丁登记：宿主缺陷、一行修法、自动退役信号与删除步骤 |
| [upstream-workaround-pattern.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/upstream-workaround-pattern.md) | **上游补丁的退役模式**：可复用的方法——适用判定、七件套、三态探测、可达的信号通道、反模式与成本边界 |
| [troubleshooting.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/troubleshooting.md) | 排查与常见问题：错误语义、连接问题、已知限制 |
| [optimization-and-future03.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/optimization-and-future03.md) | **优化项与 Future（第三辑 · 唯一账本）**：仍未做、判定不做、上游阻塞、验证缺口与已完成 ID 索引；前两辑已合并到这里 |
| [CONTRIBUTING.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/CONTRIBUTING.md) | 参与开发：环境、三种测试、代码约定、改完之后 |
| [SECURITY.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/SECURITY.md) | 安全策略：凭据如何存储、主机密钥校验、已知边界、漏洞报告 |
| [CHANGELOG.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/CHANGELOG.md) | 更新日志：各版本的新增、修复与变更 |

---

## 许可证

<div align="center">

**[MIT](https://github.com/siqyka/dsh-ssh-workspace/blob/main/LICENSE) © 2026 siqyka**

<sub>用 SSH 的距离，换来本地的手感。</sub>

</div>
