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
  - [局域网部署（`allowLan`）](#局域网部署allowlan)
- [Agent 工具](#agent-工具)
- [能力一览](#能力一览)
  - [远端文件](#远端文件)
  - [远端执行](#远端执行)
  - [界面集成](#界面集成)
  - [多选、重命名与删除](#多选重命名与删除)
  - [连接模型](#连接模型)
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
     `@shiqyka/dsh-ssh-workspace@0.3.6`
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

> `localPassthrough` 三项的完整规则（前缀匹配、`@` 引用、显式 scheme、远端优先回退、以及「直通边界是 `ctx.fs`」）见 [docs/features.md 的「本机路径直通」](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#本机路径直通localpassthrough)。

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
| `ssh_workspace_reverse_forward` | 让远端监听一个端口并转发回本机（`ssh -R`），远端浏览器或同事可访问你本机服务 |
| `ssh_workspace_unforward` | 关闭端口映射并释放本地端口（含反向映射） |

> 工具的参数、返回字段与错误语义详见 [docs/tools.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/tools.md)。

## 能力一览

> 按域的完整清单（含依赖、降级与边界）见 [docs/features.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md)；界面细节见 [docs/ui.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md)。

### 远端文件

详见 [features.md → 二、文件读写](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#二文件读写)

- **完整错误语义**：`read` / `write` / `edit` 全程走 SFTP，含版本冲突、类型、越界等明确错误码
- **原子写入**：同目录暂存再替换，优先 `posix-rename@openssh.com`，不支持时退化为先删后改名
- **换行符保真**：编辑 CRLF 文件不会改成 LF
- **二进制与编码**：文本读取拒绝 NUL / 非法 UTF-8；`readBytes` 原样返回字节
- **写入围栏**：写入仅限已挂载远端工作区内；「仅可查看」同样挡写，读取不受限
- **大文件流式读取**：预览与 `read` 按 256 KiB 分块，不整文件进内存
- **本机路径直通**：聊天附件等本机绝对路径在 `ssh://` 会话仍按本机解析，其余按远端解释、不探测存在性
- **远端变更自动刷新**：优先 inotifywait 推送，未装则约 2 秒轮询并空闲退避

### 远端执行

详见 [features.md → 三、远端执行](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#三远端执行)

- **shell 命令远端化**：`ssh://` 会话的 `pwsh` / `bash` 在远端以 POSIX 语义执行
- **glob / grep 远端搜索**：调用远端 ripgrep，未装时带安装提示明确失败
- **变更追踪远端化**：用远端 git 做快照与 diff，未装时自动关闭
- **PTC / `run_code` 可用**：程序在本机 worker 运行，工具调用仍在远端

### 界面集成

详见 [features.md → 六、界面集成](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#六界面集成)、[ui.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md)

- **新建会话可用**：宿主的 `node:fs/promises` 对 `ssh://` 同样走 SFTP，可直接在远端新建会话
- **重启后自动重新挂载**：已登记工作区下次启动时从 registry 恢复
- **侧栏分组自动补齐**：停用 → 重启 → 启用后无需再重启即见会话
- **「工作区文件」侧边栏**：文件树直列远端目录，预览经 SFTP 读取
- **在浏览器里编辑文件**：预览头部铅笔就地打开编辑器，双令牌防覆盖，多标签保留草稿，上限 2 MiB
- **`@` 远程文件引用**：补全候选来自远端目录，选中插入 `@相对路径`
- **拖拽 / 右键把文件加入任务**：文件树行可拖到输入框或右键加入，等同 `@` 补全
- **系统文件拖入远端文件树**：落点决定目标目录，文件夹与本地树被拒绝
- **「添加工作区」远程入口**：本地 / 远程两步菜单，远程选主机 → 浏览目录 → 挂载
- **「变更请求」tab 的最近提交历史**：官方面板下半追加只读历史条，点标题折叠，状态跨重开保留
- **远程工作区专用标记**：侧栏、选择器与会话按钮显示远端标记
- **主机管理面板**：增删改主机、测试连接（7 秒 toast）、状态内联、断开连带拆转发
- **浏览目录对话框**：逐级浏览并可就地挂载，只浏览 / 挂载
- **行菜单：新建文件夹 / 重命名 / 删除**：远端与本地行均可改名删除，远端目录另有新建
- **文件树空白处右键（本地工作区）**：新建文件夹 / 复制路径两项，目标为所属目录
- **文件面板 / 上传 / 下载**：上传仅在远端行右键，面板头部托盘图标开进度浮层

### 多选、重命名与删除

多选就做在宿主「文件」标签那棵树里，不另开对话框或标签。选中行高亮加描边，无复选框、无「选择模式」开关、无批量条；菜单文案固定、作用范围由选择决定。单击 / Ctrl / Shift / 右键 / 方向键 / F2 / Delete 的完整手势与 `resolveTargets` 规则见 [ui.md → 交互细节](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md#交互细节) 与 [features.md → 六、界面集成](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#六界面集成)。

### 连接模型

每别名一条长连接（常开 SFTP 通道 + shell 的 exec 通道），空闲 30 分钟回收、有操作在飞不回收；首连记录主机密钥指纹（TOFU），变更即拒绝连接，重装后可在面板「忘记主机密钥」重新信任。详见 [features.md → 七、主机与安全](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md#七主机与安全)。

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

六条核心路径各一句话；完整机制见 [docs/architecture.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/architecture.md)。

- **不注册第二个 `fs` 服务**：远端方法装到已挂载的 `ctx.fs` 上，其余原样转发
- **桥接宿主内建模块**：`node:fs/promises` / `node:path` 对 `ssh://` 单独处理，让 agent 之前的调用也走 SFTP
- **接管 `ctx.subprocess`**：`cwd` 为 `ssh://` 的子进程在远端执行（ripgrep / git），handle 契约与本地一致
- **沙箱 root 本机化**：只把 `confine` 收到的远端根换成本机替身目录，不动会话级收窄
- **PTC worker 本机化**：只改 `ptcRuntime.resolve` 返回的 cwd，程序调用的工具仍在远端
- **工作区登记绕过 `realpath`**：走 `createCanonical()`，保留持久化与顺序写入

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [features.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/features.md) | **功能说明**：按能力域列出的完整功能清单（工作区 / 文件 / 执行 / 传输 / 转发 / 界面 / 安全 / 配置 / 降级矩阵 / 边界） |
| [architecture.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/architecture.md) | 架构与实现：`ctx.fs` / `ctx.shell` / `ctx.subprocess` 接管、变更监视与流式读取、内建桥接、引擎与连接模型 |
| [protocol.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/protocol.md) | `ssh://` 路径协议：语法、规范化、显示规则、`file:` URI、写入围栏与停用围栏 |
| [hosts.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/hosts.md) | 主机配置与认证：存储格式、`~/.ssh/config` 回退、面板管理 |
| [tools.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/tools.md) | Agent 工具参考：11 个 `ssh_workspace_*` 工具（含 `reverse_forward`） |
| [ui.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/ui.md) | 界面指南：面板、添加工作区双入口、远程工作区标记、端口转发与持久会话区、文件引用设置 |
| [development.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/development.md) | 开发、调试与发布：源码结构、依赖解析、打包流程 |
| [upstream-workarounds.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/upstream-workarounds.md) | 上游临时补丁登记：宿主缺陷、一行修法、自动退役信号与删除步骤 |
| [upstream-workaround-pattern.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/upstream-workaround-pattern.md) | **上游补丁的退役模式**：可复用的方法——适用判定、七件套、三态探测、可达的信号通道、反模式与成本边界 |
| [troubleshooting.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/troubleshooting.md) | 排查与常见问题：错误语义、连接问题、已知限制 |
| [FF/README.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/docs/FF/README.md) | **已完成工作流索引**：01–10 的方案与任务书均已按约定删除，索引指向最终落点；保留 client chunk 宿主事实与「不再做」判定摘要 |
| [CONTRIBUTING.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/CONTRIBUTING.md) | 参与开发：环境、三种测试、代码约定、改完之后 |
| [SECURITY.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/SECURITY.md) | 安全策略：凭据如何存储、主机密钥校验、已知边界、漏洞报告 |
| [CHANGELOG.md](https://github.com/siqyka/dsh-ssh-workspace/blob/main/CHANGELOG.md) | 更新日志：各版本的新增、修复与变更 |

---

## 许可证

<div align="center">

**[MIT](https://github.com/siqyka/dsh-ssh-workspace/blob/main/LICENSE) © 2026 siqyka**

<sub>用 SSH 的距离，换来本地的手感。</sub>

</div>





