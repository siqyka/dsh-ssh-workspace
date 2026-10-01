# 路线图

> 定位：本页是插件的功能候选清单——每项记录动机、当前缺口（源码位置）与验收要点，供挑选实现与认领；勾选状态由实现进度维护。

## 概述

已完成的能力见[根 README](../README.md)；本页只列尚未提供或待修的事项。按价值/成本分三档：第一梯队（缺口明确、收益直接）、第二梯队（体验增强）、大工程（需专门投入）。第一、第二梯队已全部落地（2026-10-01），第一梯队最后两项共享同一个实现杠杆，见「共同机制」。

## 第一梯队

- [x] **bash 工具远程化**（已完成 · 一期）
  - 动机：会话工作区在远端时，bash/pwsh 工具曾在本机执行，模型必须知道并改用 `ssh_workspace_exec`。
  - 实现：`lib/patch-shell.js` 接管 `ctx.shell` 的 `execute`——`workdir` 为 `ssh://` 的 spec 在远端主机执行（复用引擎连接池），其余原样转发给部署自己的执行器。`onExpiry`（超时自 arm / 交给 jobs 层）、`signal`（中止）、增量 `observed` 读取、输出尾窗与 `done`/`result()` 契约均按 seam 约定实现；公告已写明远端命令按 POSIX shell 语义执行、不受本机沙箱约束。
  - 一期范围：只接管 `ctx.shell` seam（一次性命令与经 jobs 的调用都走它）；交互式/常驻终端仍见「大工程」。

- [x] **glob / grep 远端搜索**（已完成 · 2026-10-01）
  - 动机：远端工作区上搜索曾不可用，只能改用 shell 命令跑 `rg`/`find`。
  - 实现：`lib/patch-subprocess.js` 接管 `ctx.subprocess`——`spec.cwd` 为 `ssh://` 时经 `engine.acquire(alias)` 复用连接、`client.exec()` 开通道，其余 spec 绑定原始 receiver 原样转发。`argv[0]` 按 basename 翻译（`rg.exe`／`*-rg[.exe]` → `rg`，`git.exe` → `git`；其余本机可执行文件**同步抛**「无法在远端运行本机可执行文件」，报错由工具层转为 `SEARCH_FAILED`）。脚本 = `export`（spec.env + `$HOME/.local/bin:$HOME/bin` 前缀）→ 镜像 `mkdir -p` → `cd <workdir> &&` → `command -v <命令> || { echo 安装提示; exit 127; }` → 引号化 argv。handle 契约与本地一致：`done`（reject = 提供方失败；连接掉线而进程未报状态也走 reject）、`collected.stdout/stderr.readFrom/finalize` 字节尾窗（丢整 chunk 的 `lossy`/`truncated` 与 OutputCollector 对齐）、`stdin: 'ignore' | {data}`、`terminate()` = TERM → `graceMs` → KILL 阶梯 + 5s 未关即断连兜底结算；`pipe`/`inherit`/`control` 同步抛不支持。接线：`ctx.inject(['subprocess'], …)` 安装 + 卸载。
  - 边界：全 asar 扫描确认 cwd 可能为 `ssh://` 的消费方只有 `dsh-tool-fs-search`（rg）与 `dsh-workspace-changes`（git）——白名单恰好只放这两个命令；本机打包的 rg 只作 argv 标记，不上传二进制。
  - 前提：远端需安装 ripgrep；缺失时退出 127 + 安装提示（工具层呈现为带提示的失败）。
  - 验收：已按 `dsh-tool-fs-search` 的 `runRipgrep` 源码逐项核对 spawn/handle 形状；路由层冒烟测试通过（脚本组装、镜像 env、TERM→KILL 阶梯、lossy 尾窗、同步校验）。

- [x] **git 支持（`ssh://` 工作区）**（已完成 · 2026-10-01）
  - 动机：远端工作区的「变更」（deliverables）面板曾不工作。
  - 实现（三步均已落地，前两步复用上方路由层）：
    - **1 · ssh 拼写路径层**（`lib/fs-shim.js`）：`node:path` 的 `resolve/join/relative` 仅在参数含 `ssh://` 时接管（其余零改动）——`resolve(ssh://a/p, '/r')` → `ssh://a/r`、相对段追加（`--git-path objects` 这类相对输出折叠回规范拼写）、Windows 绝对参数复位回本机世界；`relative` 同别名返回 POSIX 相对段（`display` 就是工作区相对路径），混合操作数返回右操作数（判为「不在内部」）。用于折叠 `workspace-changes` 的 `resolve(cwd, git 输出)` 仓库根/gitDir/objects。
    - **2 · fs 桥扩展**（同文件）：`copyFile`（ssh 源经 SFTP 读；目标为本机 scratch 时另镜像写远端）、`open`（只读 SFTP FileHandle：`stat/read/readFile/close`，单次读封顶 256KB，`inFlight` 钉住连接防止空闲回收）、`rm`（ssh 目标围栏内远端删除；已学习的镜像目录 → 远端 `rm -rf` 尽力而为 + 本机清理）。错误按 errno 映射（`FS_NOT_FOUND` → `ENOENT`），供消费方 `.catch(isMissing)` 判定。
    - **3 · 快照目录镜像**（`lib/patch-subprocess.js`）：recorder 把本机 `mkdtemp(tmpdir())` 的快照目录经 `GIT_OBJECT_DIRECTORY`／`GIT_INDEX_FILE` 交给 git（远端 git 看不到本机路径）——路由层把这类本机临时路径值改写成远端 `/tmp` 下同后缀镜像并 `mkdir -p`（objects 建自身、index 建父目录），`ssh://` 值（`GIT_ALTERNATE_OBJECT_DIRECTORIES` = `resolve(cwd, …)` 的结果）翻译为裸远端路径；注册表按 scratch 首段记忆别名（first-learn-wins），供 fs 桥的 `rm`/`copyFile` 联动。
  - 降级：远端非 git 仓库 → 与本地一致（只列文件工具改动）；远端未装 git → 退出 127 + 安装提示，追踪按「无仓库」降级（每回合一条 warn，不阻断会话）。
  - 验收：已按 asar 内真实消费方源码（`dsh-workspace-changes` 的 `GitRunner`/`locateGitWorkspace`/`snapshotTree`/`captureFile`、`paths.js` 的 `canonicalPath`/`isInside`）逐项核对 env/stdio/copyFile/open/rm 形状；镜像改写与 rm/copyFile 联动冒烟测试通过。

### 共同机制（剩余两项共享）

把 `ctx.subprocess` 按照 [`ctx.fs` 接管](./architecture.md) 同样的做法加一层路由：调用方的工作目录/目标是 `ssh://` 时，改在远端主机执行（复用引擎的 SSH 连接），并对上层伪装成普通子进程（`done`、`collected`、退出码、`graceMs`、`signal`）。接管写法参照 `lib/patch-fs.js`（`lib/patch-shell.js` 是其在 shell seam 上的已落地实例）。

bash 一期已验证：`ctx.shell` 是官方能力 seam（基类契约 + 工具侧消费形状见 `lib/patch-shell.js` 头注）。

`ctx.subprocess` 契约已核对源码（2026-10-01，`@deepseek-ai/dsh-subprocess` 与 `dsh-subprocess-local`）：`spawn` **同步**返回 handle，`validateSubprocessSpec` 同步校验（`graceMs`、已中止 signal、`argv[0]`）；handle 的 `done` 可 reject（提供方失败），输出经 `collected.stdout/stderr.readFrom(from)` 以整段字节坐标返回 `{text, lossy}`。全 asar 扫描确认：cwd 可能为 `ssh://` 的消费方只有 `dsh-tool-fs-search`（rg）与 `dsh-workspace-changes`（git）——`dsh-bash-local`／`dsh-pwsh-local` 同样经 `ctx.subprocess`，但其 `ssh://` 调用已被 `ctx.shell` 层的 patch-shell 拦截，互不冲突；其余包 cwd 永不为 `ssh://`，原样直通。建议交付顺序：A（glob/grep + 路由层）→ B（git + 路径层 + 镜像），A 落地的路由层即 B 的基座。

**已落地（2026-10-01）**：路由层即 `lib/patch-subprocess.js`（A、B 共用）；A、B 两项均已完成并接线（`ctx.inject(['subprocess'], …)` 安装/卸载），验收记录见上方两条。

## 第二梯队

- [x] **远程变更监听（轮询式）**（已完成 · 2026-10-01）
  - 动机：远端文件被改动后界面不刷新（文件树/预览需手动重开）。
  - 实现：`lib/remote-fs.js` 的 `startRemoteWatch` 取代原先「remote change watch is not supported over SFTP」的拒绝路径——每 2 秒一次观察（文件目标 = 一次 stat；目录目标 = 一次 readdir 快照），与上一快照比对，语义对齐本地 depth-0 watcher：目录报任一直接子项增/改/删，文件目标（含不存在的路径，观察创建）只报该路径；变更回调无参，无法继续轮询的故障以 Error 参数上报一次后停止。目录在 stat 与 readdir 之间消失按「变更」而非故障处理；每轮经 `withSftp`，轮询间隙连接可正常回收；计时器 `unref`，不钉住进程。（2026-10-01 迭代：轮询改为自适应退避——基础 2 秒，连续 15 轮无变更退至 5 秒、30 轮至 10 秒（上限），任一变更立即回到 2 秒；另配元数据缓存失效，见 [optimization-plan.md](./optimization-plan.md) 的 3.1 / 3.2。）
  - 验收：桩冒烟通过（目录增/改/删/消失各通知一次且无参、文件创建与版本变化、故障上报 Error 后停止、消费者抛错不停轮询、abort 停止/预中止 reject、本地路径透传，6 项）。已知限制：SFTP 无亚秒时间戳，依赖 mtime 的比对精度为秒级——同一秒内等长的连续改写可能不触发刷新（readdir 快照对增删改仍敏感）。
  - 顺带修复：`watch` 改为 `async` 方法，预中止 signal 与 `fs-local` 一致地以 rejected promise 呈现，而非同步抛出。

- [x] **大文件流式读写**（已完成 · 2026-10-01）
  - 动机：大日志/二进制目前整块进内存。
  - 实现：`lib/remote-fs.js` 的 `streamText` 改为惰性分块生成器——SFTP 句柄逐 256 KiB 读取、增量严格 UTF-8 解码（跨块多字节安全）、首 8 KiB 做 NUL 抽样（对齐本地语义，非文本抛 `FS_NOT_TEXT`）；消费方提前停止（预览切页）经 `return()` 释放句柄，全程 `inFlight` 钉住连接。预览与 read 工具（按 `streamMinSize` 选择流式的既有逻辑）因此不再整读大文件；写入仍是既有原子发布（临时文件 + rename）。
  - 验收：桩冒烟通过（3 字节级读下的跨块多字节解码、2.5 MiB 多块顺序、NUL/非法 UTF-8 拒绝且句柄已关、提前 return 只读部分并释放、中止 `FS_ABORTED`、缺失/非普通文件分类、本地路径透传，8 项）。

- [x] **`@` 远程文件引用**（已完成 · 2026-10-01）
  - 动机：远程工作区的会话里输入 `@` 列不出任何远端文件——DSH 自带的 file-reference provider 直接 `readdir` 宿主文件系统。
  - 实现：`lib/fs-shim.js` 增加 `readdir` 桥（`lib/remote-fs.js` 导出既有 SFTP 助手为 `sftpReaddir`）。provider（`@deepseek-ai/dsh-file-reference-local`）不走 `ctx.fs`，用 `node:fs/promises` 的 `readdir`/`lstat` 扫描 `agent.session.header.cwd`；其中 `lstat` 与 `node:path` 拼写层早已被桥覆盖，缺的只是 `readdir`。桥对 `ssh://` 拼写走 SFTP 并复刻两种返回形态：名字数组（含 `encoding: 'buffer'`）与 `withFileTypes` 的 `Dirent`——类型判别取条目自身属性，符号链接既非文件也非目录，与本地「目录符号链接不跟随」语义一致；`recursive` 明确 `ENOTSUP`（无消费方）。选中的 `@相对路径` 由模型 `read` 经 `ctx.fs` 读远端，链路已通。
  - 验收：`node --check` 通过；装机后输入 `@` 应列出远端候选（待动态验证）。

- [x] **文件进任务：拖拽 / 右键「添加到任务」**（已完成 · 2026-10-01）
  - 动机：往任务里引用文件此前只能手输 `@路径` 或走 `@` 补全键盘路径；文件树里的文件缺一个指针手势直达输入框。
  - 实现（`lib/client.js` 的 "Composer file bridge" 段，纯 DOM 桥）：文件树行（`li[data-files-entry]`，文件与文件夹）在 DOM 装饰同一趟 pass 里标记 `draggable`；拖拽只写自定义 MIME、不写 `text/plain`（避开编辑器文本插入与 attachment 的「拖入文件」浮层）；文档级 capture 监听 `dragover`/`drop`，命中 `[data-composer-card]` 时以虚线 outline 高亮并接收投放；右键在行上弹出「添加到任务」菜单。插入复用 `@` 补全管线：主会话 composer 的 `captureInsertion()` 跨度 + 会话作用域 `slash/input-insert-reference` 事件（`uiSession.adapter.current` → `props.inputActions` / `ctx.bail`），失败降级为 `insertText` 纯文本，输入框缺失/路径不可表示时 toast。拼写与补全一致：树根等于会话 cwd 时相对路径，否则绝对拼写；含空格按引号语法（目录保留开引号），控制字符/双引号拒绝。
  - 验收：`node --check` 通过；装机后拖拽与右键均应插入与 `@` 选中一致的 chip（待动态验证）。

## 大工程

- [ ] **交互式远端终端**（价值高 · 成本高）
  - 动机：一次性 `exec` 代替不了长驻交互（长命令、REPL、sudo 提示）。
  - 验收：稳定的交互式 shell，支持窗口尺寸变化与断线重连。

## 小修

- [x] **工具描述与公告对齐**：`lib/tools.js` 模块注释与 mount / exec 工具描述原先称 glob/grep 在远端工作区可用（over SFTP），与 `lib/index.js:59-60` 公告矛盾——已随远程 shell 一并对齐（glob/grep 不落远端；mount 后 read/write/edit 与 shell 命令落远端）。

## 仓库与交付

- [ ] npm 发布（已决定暂缓，待重新评估）

## 相关

- [根 README](../README.md)
- [architecture.md](./architecture.md)（`ctx.fs` 接管与连接模型，「共同机制」的模板）
- [development.md](./development.md)（打包与发布流程）
- [tools.md](./tools.md)（工具面）
- [troubleshooting.md](./troubleshooting.md)（已知限制）
