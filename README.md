<div align="center">
<img src="./docs/assets/header.png" alt="dsh-ssh-workspace header" width="840" />

# dsh-ssh-workspace

**把一台 SSH 主机上的目录，当作 DSH 工作区使用。**

`read` / `write` / `edit` 通过 SFTP 直接读写远端文件——
不需要手动同步、不需要挂载驱动、不需要装任何第三方文件系统。

[![version](https://img.shields.io/github/package-json/v/siqyka/dsh-ssh-workspace)](https://github.com/siqyka/dsh-ssh-workspace)
[![license](https://img.shields.io/github/license/siqyka/dsh-ssh-workspace)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)
![dsh](https://img.shields.io/badge/DSH-%3E%3D%200.2.0--rc.1-blue)
![ssh2](https://img.shields.io/badge/ssh2-%5E1.17.0-lightgrey)

**简体中文** · [English](./README.en.md)

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
2. **输入地址**：在插件管理界面的安装输入框中输入本仓库地址
   `https://github.com/siqyka/dsh-ssh-workspace`，点击安装；
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

## 主机管理

主机记录存放在 `$DSH_HOME/dsh-ssh.json`；没有该文件时，会退回到读取
`~/.ssh/config` 里具体的 `Host` 块。因此**已经配好的主机无需重复配置**。

「远程工作区」面板里可以直接**添加 / 编辑 / 删除**主机，写回
`$DSH_HOME/dsh-ssh.json`（原子写入，保留文件里本插件不认识的字段）。
`~/.ssh/config` 中的主机是**只读回退**，面板不会修改那个文件；
与存储同名的主机以存储为准。密码 / 私钥口令按该存储格式**明文保存**，
且不会回传到浏览器，编辑时留空表示保持原值。
删除主机不会自动卸载已挂载的工作区，但那些工作区会因主机不存在而无法访问。

> 存储格式、`~/.ssh/config` 解析规则与凭据策略细节见 [docs/hosts.md](./docs/hosts.md)。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `announceToAgent` | `false` | 是否向每个 agent 注入能力说明（系统提示词段落） |
| `engine.idleTimeoutMs` | `1800000` | 连接空闲超过该时长后回收（毫秒） |
| `engine.connectTimeoutMs` | `15000` | 单次 SSH 连接握手超时（毫秒） |
| `engine.keepaliveIntervalMs` | `15000` | keepalive 心跳间隔（毫秒） |
| `engine.sweepIntervalMs` | `60000` | 空闲连接的扫描周期（毫秒） |

> `engine` 下四项均为可选（非法值回落默认），通常无需配置。

## Agent 工具

| 工具 | 用途 |
| --- | --- |
| `ssh_workspace_hosts` | 列出可用主机（store + `~/.ssh/config` 候选） |
| `ssh_workspace_mount` | 把一个远端目录登记为工作区，返回 `ssh://` 路径 |
| `ssh_workspace_unmount` | 注销远端工作区 |
| `ssh_workspace_status` | 当前挂载点与连接状态 |
| `ssh_workspace_exec` | **在远端**执行 shell 命令 |

> 工具的参数、返回字段与错误语义详见 [docs/tools.md](./docs/tools.md)。

## 能力一览

### 远端文件

| 能力 | 说明 |
| --- | --- |
| 完整错误语义 | `read` / `write` / `edit` 全程走 SFTP，含 `FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`FS_AMBIGUOUS_EDIT`、`FS_NOT_TEXT`、`FS_TOO_LARGE`、`FS_NOT_FOUND` 等 |
| 原子写入 | 先落同目录暂存文件再替换；优先 `posix-rename@openssh.com`，服务器不支持时退化为「先删后改名」（此时不再原子） |
| 换行符保真 | 编辑 CRLF 文件不会把它改成 LF |
| 二进制与编码 | 文本读取拒绝 NUL / 非法 UTF-8；`readBytes` 原样返回字节 |
| 写入围栏 | 远端写入只允许落在已挂载的远端工作区内，越界返回 `FS_SANDBOX_DENIED`；读取不受限制 |
| 大文件流式读取 | 预览与 `read` 按块（256 KiB）流式读取，不再整文件进内存 |
| 远端变更自动刷新 | 侧栏文件树与预览以轮询感知远端改动并自动刷新——基础约 2 秒一次，空闲目录自适应退避（连续 15 轮无变更退至 5 秒、30 轮至 10 秒封顶），任一变更立即回到 2 秒；SFTP 元数据无亚秒时间戳，同一秒内等长的连续改写可能不触发刷新，增、删、改名总能感知 |

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
| 「添加工作区」远程入口 | 「添加工作区」按钮替换为锚定菜单：「新建本地工作区」（DSH 原生选择器）或「新建远程工作区」（选主机 → 逐级浏览远端目录 → 确认挂载；目录不可写时警告并拒绝创建） |
| 远程工作区专用标记 | 本插件创建的远程工作区在侧栏行、工作区选择器与会话页工作区按钮处显示远端标记图标，而不是普通文件夹图标 |
| 主机管理面板 | 添加 / 编辑 / 删除主机（私钥路径、认证方式、备注等），改动立即生效并丢弃该别名旧连接；`~/.ssh/config` 主机只读展示；「测试连接」结果以顶部 toast 弹出，数秒自动消失（点击可提前关闭） |

### 连接模型

每个别名一条长连接——一个常开 SFTP 通道，shell 命令在同一条连接上另开
exec 通道；空闲 30 分钟回收（有操作在飞的连接不回收）。

首次连接记录服务器主机密钥指纹（TOFU），之后指纹变更会被**拒绝连接**并提示
新旧指纹——防止中间人攻击；主机重装后可在面板里「忘记主机密钥」重新信任。

## 限制

明确**不支持**的：

- **跳板机 / ProxyCommand**：引擎只直连目标主机（`ssh2` 客户端未接 `proxyJump`）。
  带 `proxyJump` / `ProxyCommand` 的主机会在解析时被**明确拒绝**并说明原因，
  而不是悄悄按直连去试；需要跳板时请改用别的工具连接。
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
| [architecture.md](./docs/architecture.md) | 架构与实现：`ctx.fs` / `ctx.shell` / `ctx.subprocess` 接管、变更监视与流式读取、内建桥接、引擎与连接模型 |
| [protocol.md](./docs/protocol.md) | `ssh://` 路径协议：语法、规范化、显示规则、`file:` URI |
| [hosts.md](./docs/hosts.md) | 主机配置与认证：存储格式、`~/.ssh/config` 回退、面板管理 |
| [tools.md](./docs/tools.md) | Agent 工具参考：五个 `ssh_workspace_*` 工具 |
| [ui.md](./docs/ui.md) | 界面指南：面板、添加工作区双入口、远程工作区标记 |
| [development.md](./docs/development.md) | 开发、调试与发布：源码结构、依赖解析、打包流程 |
| [troubleshooting.md](./docs/troubleshooting.md) | 排查与常见问题：错误语义、连接问题、已知限制 |
| [roadmap.md](./docs/roadmap.md) | 功能路线图：候选功能、动机与验收 |
| [CHANGELOG.md](./CHANGELOG.md) | 更新日志：各版本的新增、修复与变更 |

---

<div align="center">

**[MIT](./LICENSE) © 2026 siqyka**

<sub>用 SSH 的距离，换来本地的手感。</sub>

</div>
