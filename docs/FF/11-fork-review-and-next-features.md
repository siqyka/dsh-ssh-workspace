# 11 —— Fork 近期提交借鉴 + 待建功能调查

> 性质：**调查文档**，不是已实施功能的说明书。本文钉住 2026-11-24 对 `InitializeQwQ/dsh-ssh-workspace` 最近 5 个提交的审阅结论，以及对用户提出的五项新功能（①展示文件 ②主机硬停用 ③会话命令行审查含审计落盘 ④面板审计 tab ⑤可配置保留条数）的现状 / 可行性调查。方案与任务书按 `docs/FF/README.md` 的约定在实施完成后删除，落点写回索引。
> 基线：本地 `@shiqyka/dsh-ssh-workspace` v0.4.0（`f31dacd`）；fork `@initializeqwq/dsh-ssh-workspace` 0.3.11 时代。
> 行号会漂，按这里的**文件名 + 小节 / 标识符**找，不要按行号定位。

---

## 一、Fork 最近 5 个提交审阅

来源：[commits/main](https://github.com/InitializeQwQ/dsh-ssh-workspace/commits/main/) 与 [fork CHANGELOG（0.3.11 快照）](https://raw.githubusercontent.com/InitializeQwQ/dsh-ssh-workspace/e488673e8ee78723c2a843aac6be215208aa3b4f/CHANGELOG.md)。本地比 fork 领先两个小版本，因此多数提交是**平行演进**，不是缺功能。

| Commit（均 2026-11-20） | 内容 | 与本地的关系 |
| --- | --- | --- |
| `2f570b3` 优化添加和启用服务器体验 | autoConnect 意图持久化到 `dsh-ssh.json`；新主机添加即打开意图并拨号；`engine.failures` 记录最后一次连接失败（成功 / 忘记时清除）；`/status` 增加 `autoConnect` / `connecting` / `failures`；主机菜单统一 4 项；新增 `lib/host-intent.js`（`acquire` 串行恢复、`pendingAliases`、single-flight）；keepAlive 探活并豁免空闲回收；**删除** per-host `enabled` 开关 | 核心思路本地没有，值得借鉴（见下） |
| `c8cb813` 优化 ui | 引入同一套 host-intent；**删除** git-endpoint 过滤 | git 过滤本地从未引入；host-intent 同上 |
| `e488673` 修改 ui | 0.3.11 正式版，git 过滤仍在 | 无本地缺口 |
| `f49416c` 给服务器添加开关 | 0.3.10：每台主机启停开关 + `POST /hosts/toggle` + `enabled` 字段 | 与本文第二节直接相关：这是用户要求的功能，但 fork 最终**自我回滚**了它 |
| `a57f7fc` | 纯文档 | 无参考值 |

注意两次**自我回滚**：0.3.10 的 `enabled` 开关到 `2f570b3` 被彻底删除（连字段一起），0.3.11 的 git 主机过滤到 `c8cb813` 也被删除。fork 最终的方向是「连接意图 + 失败可见性」，而不是「主机开关」。这个历史是第二节决策的关键背景。

### 值得借鉴（按优先级）

1. **连接失败的可见性** — 本地 fatal 失败被重连器明确排除（`lib/engine/engine.js` 的 `error?.fatal !== true` 守卫），`/status` 只有 `events` / `diagnostics`，没有「某别名最后一次连接失败原因、成功即清除」的字段。fork 的 `engine.failures` map 正好补这个盲区：失败时写、成功与 `forget` 时清，经 `/status` 与 `ssh_workspace_hosts` 暴露。成本很低。
2. **autoConnect 持久化意图 + 启动串行恢复** — 意图存顶层 JSON，用 `acquire` 而非 `retryNow` 恢复（关键：自动启动关闭时不会反而重开用户手动关掉的隧道），single-flight 防重入，`pendingAliases` 让 `/status` 第一轮就显示 `connecting`。本地只有转发层 `autoStart`（`lib/forward/forward.js` 的 `autoStart()`），主机连接本身没有意图层。
3. **keepAlive 主机豁免空闲回收 + 掉线重拨** — 本地有断线重连（`lib/engine/reconnect.js`），但没有「标记的主机从回收扫描中豁免」这层，长会话仍可能被摘连接。
4. **UX 原则：开关反映意图而非 socket 状态** — 握手期间不要显示「按钮关闭」的假象。适用于本文第二节的电源按钮设计。

### 明确不借鉴

- `usePathDraftPreview` / `dirs=1` 一次 exec 列目录：本地已有（`lib/client/client.kernel.js`、`tests/path-preview-smoke.mjs` 85 项）。
- `all=1` 把文件列进目录对话框：本地刻意否决，`tests/browser-rows-smoke.mjs` 明确断言**不得**出现 `all=1`，只列目录、单击选中即目标。fork 自己的 0.3.9→0.3.7 也是反复改，方向不稳定。→ 但本文第二节的第 1 项功能正是「可选地展示文件」，见那里的重新评估。
- git-endpoint 过滤与 per-host enabled 开关：fork 自己最终都删了；本地面板走 unmount/detach 模型。
- 包名改 `@initializeqwq`：本地是 `@shiqyka`，不适用。

---

## 二、功能 1：设置中新增「展示文件」勾选

### 需求原文

> 设置中添加一个设置 — 展示文件；勾选则在浏览目录和新建远程工作区时展示文件，但不可选。

### 现状调查

**两个对话框共用一条列目录路径**（这是本功能最大的杠杆）：

- `lib/client/client.add-workspace.js` 的 `RemoteWorkspaceDialog` 与 `lib/client/client.dialogs.js` 的 `DirectoryBrowser` 都调用 `usePathDraftPreview`（`lib/client/client.kernel.js` 定义，`lib/client/client.js` 暴露），两者的 `loadDir` 都请求 `GET /api/dsh-ssh-workspace/ls?…&limit=${BROWSE_LIST_LIMIT}&dirs=1`。
- 服务端 `lib/routes/entries.js` 的 `/ls` 路由：`dirs=1` 走一次 exec 的 `dirsListingCommand`（只列目录、远端先过滤再截断），失败回退 SFTP 时 `.filter(entry => dirsOnly !== '1' || entry.type === 'directory')` 再过滤一层。未带 `dirs=1` 的完整列表本来就返回文件（`type` 为 `file` / `symlink`）——**服务端不需要新能力，只需让开关控制 `dirs=1` 是否附加**。
- 客户端行渲染：`tests/browser-rows-smoke.mjs` 钉住目录行是 `button`（双击进入 / 单击选中），且 bundle 里不得出现 `sshwsp-entry-file` 或 `FileIcon`。开启展示文件后需要新增**不可选的文件行**：普通 `div`（不是按钮、无 onClick、无 aria-current），带文件图标与名字，位置在目录行之后；`tests/path-preview-smoke.mjs` 的 `narrowDirectoryEntries` 按名字收窄时不能把文件行过滤掉。
- 设置落点：`lib/client/client.panel.js` 的 `paneSettings` 已有「端口转发自动启动」与「文件引用设置（scheme + 回退）」两组勾选；`/status` 由 `lib/routes/workspaces.js` 组装，转发设置来自 `savedForwards.settings()`，passthrough 来自 `passthroughSettings.settings()`。新设置可复用 PassthroughSettings 那套「顶层 JSON 一节 + `/status` 下发 + POST 写穿」的模式（存 store 的新 section，如 `preferences.showFiles`，默认 `false`）。

### 设计约束（调查结论）

1. **默认关闭**：与本地既有决定一致；开启是显式意图，不改变现有对话框行为。
2. **文件行绝不可选 / 不可进入**：`handleEntry` 只挂在目录行上；文件行是纯展示 `div`，不参与 `picked` 状态、不成为挂载 / 创建目标、不可下载（保持「浏览对话框是只读的」）。这是 fork `all=1` 反复回滚的教训——只要文件行能点，就会变成半控件。
3. **截断语义要对**：开启后 `total` / `truncated` 必须统计「目录 + 文件」的全部条目，且**目录优先**（远端 `ls` 脚本先给目录，`limit` 先花在目录上），否则文件多时把目录挤出列表，用户反而找不到要进的目录。fork 0.3.9 的 `entriesListingCommand` 可作为 `dirsListingCommand` 的扩展参考，但要保留本地的 `audit: false` / `replay: 'safe'` / 形状不对回退 SFTP 三原则。
4. **失败回退一致性**：`dirsListingCommand` 答不出形状时回退 SFTP，回退分支必须按同一个开关决定是否保留文件行，不能出现「快速路径有文件、回退没文件」的分裂。
5. **测试要让开关真的生效**：`browser-rows-smoke` 现有断言是「两个 picker 都必须带 `dirs=1` 且不得带 `all=1`」——新功能下这条要改为「默认两个都带 `dirs=1`」（默认行为不变），另加开关打开时的渲染测试：文件行是 `div`、无处理、目录行仍是按钮、挂载目标仍是选中的目录。反向验证：关掉开关时文件行消失；把文件行做成按钮则红。

### 改动面预估

`lib/hosts/store.js`（新 section + 归一化）→ `lib/routes/*`（设置读写路由 + `/status` 下发）→ `lib/client/client.panel.js`（勾选 UI）→ `lib/client/client.add-workspace.js` 与 `lib/client/client.dialogs.js`（按设置决定是否带 `dirs=1`、渲染文件行）→ `lib/routes/entries.js`（可选：扩展一次 exec 的列表脚本以含文件）→ `tests/browser-rows-smoke.mjs` / `tests/path-preview-smoke.mjs` / `tests/routes-smoke.mjs` → 文档 `docs/ui.md`、`docs/features.md`、`docs/protocol.md`、`docs/development.md`、`CHANGELOG.md`。

---

## 三、功能 2：每台主机单独启用 / 停用（电源按钮）

### 需求原文

> 每台主机可以单独启用 / 停用：「远程工作区」面板每张存储型主机卡片的左侧新增开关（电源样式按钮）；**停用 = 停止这台主机当前的一切，并挡住后续一切**——现有连接、持久 shell、终端、端口转发（正向 / 反向）、变更监视、在途命令全部打断；测试 / 浏览 / 断开 / 编辑对这些主机一并拒绝；与该主机相关的工作区、会话都置灰。点击停用时必须先提示用户将发生什么。

### 语义澄清（2026-11-24 用户确认，推翻本节初稿）

本节初稿按 fork 0.3.10 理解成「仅挡新建、展示置灰、不动运行中的连接」。用户明确纠正：**停用是硬停止**，不是软隐藏。两条硬约束：

1. **停用立即打断该主机的一切活动**，而不只是界面置灰。
2. **停用后该主机不可再用**，直到重新启用；点击停用时必须给出确认提示，说明会中断什么。

这与 fork 0.3.10 的 `f49416c` 只影响「创建工作区时的选择」、并明确「已挂载工作区、现有连接、测试 / 浏览 / 断开 / 编辑都不受影响」**语义相反**。fork 随后在 `2f570b3` 把开关整个删掉、改用 autoConnect 意图——因此这次是**带着 fork 的负面证据、做 fork 没做的硬版本**，更要先把"停止一切"的能力边界钉清楚。

### 现状调查：停止一台主机需要动哪些资源

按别名逐一调查现有能力（这是本功能最大的工作量，不是画一个开关）：

| 资源 | 现有按别名清理能力 | 缺口 |
| --- | --- | --- |
| 池化 SSH 连接 | `engine.forget(alias)`（`lib/engine/engine.js`）→ `reconnector.cancel(alias)` + `closeRecord`；`closeRecord` 同时关 sftp、streamSftp、client 与 **ProxyJump 的跳板机连接**（`jumpChain.close()`） | 无缺口；这是"停止一切"的核心 |
| 持久 shell | `shells.close(alias)`（`lib/surface/shell.js`）关掉该别名**全部**会话并清 `starts` | 无缺口 |
| 正向 / 已存端口转发 | `forward.closeForAlias(alias, reason)`（live）与 `savedForwards.closeAlias(alias)`（deliberate：意图关、不记失败） | 无缺口；停用应走 deliberate 路径，不要伪装成"连接丢失" |
| 反向转发 | `reverseForwards.closeForAlias(alias, reason)`（`lib/forward/forward.js`） | 无缺口 |
| 变更监视 | `RemoteWatchRegistry`（`lib/fs/remote-watch.js`）按 `<alias>\0<path>` 存 `watches`，最后消费者关闭时 `#stopSharedWatch` | **无按别名批量关闭 API**；需新增 `closeForAlias(alias)` 遍历 `watches` 停掉 `entry.parts.alias === alias` 的项 |
| 在途命令 / exec | `exec` 用调用方 `AbortSignal` → 远端 `KILL`（`lib/engine/engine.js`）；无按别名登记表 | 关连接会让在途操作失败，但**不是干净取消**；需加按别名的 AbortController 登记表，停用逐项 abort |
| 终端（PTY） | `RemoteTerminalHandle`（`lib/patch/patch-terminal.js`）由宿主 `terminalController` 持有；插件只在 `spawnTerminal` 开通道时挂钩 | **无按别名的终端句柄表**；要么在 patch 里登记并新增批量关闭，要么在文档中把"终端不受停用影响"列为已知限制（不推荐，违背需求） |
| DSH 侧会话（侧栏行） | 插件只持有 `sessionIds` 用于置灰（`lib/client/client.marks.js`），会话本体在宿主 | 插件**不能关闭宿主的会话**，只能置灰 + 挡住后续命令；"停止会话"对持久 shell 是真关，对 DSH 会话是"停止其命令能力并置灰"——须在实现时明确这条边界 |
| 准入闸门 | `engine.assertNotDisabled(alias, remotePath)` 只针对 detached 工作区路径（`lib/engine/engine.js`） | **没有按别名的禁用集合**；需新增 `disabledHosts: Set<alias>` 与 `assertHostEnabled(alias)`，接到 exec / shell / terminal spawn / fs 路由 / 所有 `/hosts/*` 动作上 |

### 设计约束（调查结论）

1. **作用域：仅存储型主机卡片**。`ssh-config` 主机是只读回退，无处保存标记（fork 0.3.10 也跳过），始终视为启用；其卡片不显示电源按钮。
2. **停用是硬动作，必须走一个编排入口**：`POST /hosts/toggle`（或直接 `disable`/`enable`）在服务端**一次请求内**完成：写 `enabled: false` → 打 abort 表 → `assertHostEnabled` 闸门置位 → 关 watch / shell / 两类转发 → `engine.forget(alias)`。顺序要能让并发请求立刻看到禁用态；部分失败要记录、不回滚已停掉的资源（停掉的资源不会因回滚自动回来）。
3. **不复用 `/hosts/save`**：toggle 只翻 `dsh-ssh.json` 里的一个布尔（停用写 `enabled: false`，启用删字段），不碰认证、不需要整张表单。老记录缺省视为启用。启用是"重新允许"，**不自动重连**——重连仍按需触发（沿用 fork 2f570b3「意图不等于 socket」的原则）。
4. **点击停用前确认**：面板弹确认框，列出会被中断的具体资源（按 `/status` 实时统计：连接数、shell 数、转发数、监视数），并说明"该主机上的会话会被置灰、命令会被拒绝，直到重新启用"。取消不改动任何状态。
5. **开关反映意图而非 socket**（fork 2f570b3 的 UX 原则）：`role="switch"` + `aria-checked` 以存储值为权威；点击后立刻翻转并显示 busy，不等清理完成。连接状态另行用现有徽标表达。
6. **准入闸门是硬停用的另一半**：`engine.disabledHosts` 必须在每个按别名进入的口子上检查——`exec`、`openChannel` / `spawnTerminal`、`shells.open`、`/ls` 等 fs 路由、`/hosts/test`、`/hosts/browse`、`/hosts/disconnect`、`/hosts/reconnect`、`/hosts/save`；否则"停用后一切拒绝"只是界面说法。
7. **下拉与空态**：`RemoteWorkspaceDialog` 和端口转发下拉都按 `enabled !== false` 过滤；一台都没启用时渲染「先回面板启用主机」而不是空 `<select>`；`GET /hosts` 带出 `enabled`（默认 true），面板与下拉共用同一份事实。
8. **置灰管线接到 `client.marks.js`**：`/status` 增加「被停用主机及其工作区 / 会话」清单，客户端把对应的 `disabledIds` / `disabledTitles` / `disabledSessionIds` 并入现有集合。保留同名本地工作区排除（`localTitles`），否则会误伤。
9. **测试**：`tests/host-card-smoke.mjs`（现 38 项）加开关 / `aria-checked` / 确认框 / 置灰 / 在途禁用 / ssh-config 无开关；`tests/host-listing-smoke.mjs`（现 61 项）加 enabled 归一化与 store 往返；`tests/routes-smoke.mjs` 加 toggle 的 200 / 非布尔 / 缺别名 / 非存储别名，以及"停用后 exec / test / ls 都被拒"的闸门断言；新增一个资源编排套件（用假 engine + 假 shell / forward / watch 登记）断言**停用一次调用关掉了全部登记资源、且闸门置位**，正向对照（不调用编排 → 有资源泄漏）与反向对照（漏掉某一类资源 → 红）。

### 改动面预估

`lib/hosts/store.js`（主机 enabled + setEnabled）→ `lib/hosts/hosts.js`（listing 带 enabled）→ `lib/engine/engine.js`（`disabledHosts` + `assertHostEnabled` + 按别名 abort 登记表）→ `lib/fs/remote-watch.js`（`closeForAlias`）→ `lib/patch/patch-terminal.js`（终端按别名登记 + 批量关闭，或列为限制）→ `lib/routes/hosts.js`（toggle + 确认统计 + 各动作闸门）→ `lib/routes/routes.js` + `lib/client/client.kernel.js`（API 常量）→ `lib/client/client.panel.js`（电源按钮 + 确认框 + 下拉）→ `lib/client/client.add-workspace.js`（下拉过滤 + 空态）→ `lib/routes/workspaces.js` + `lib/client/client.marks.js`（`/status` 下发与置灰）→ 对应测试 → 文档 `docs/ui.md`、`docs/features.md`、`docs/protocol.md`、`docs/development.md`、`CHANGELOG.md`。

### 与 fork 的分歧及理由

fork 0.3.10 的开关是**软开关**（只挡新建，不动运行中的连接），并在 2f570b3 被删除。本需求明确要**硬开关**（停止一切 + 准入闸门），这是有意的反向选择，理由：用户要的是"这台主机现在不许再有任何活动"，而不是"从下拉里藏起来"。代价是编排面大得多——必须新增按别名的资源清理与闸门，不能照抄 fork 的 `enabled` 布尔就完事。实施时他处可借鉴 fork 的只有两点：`role="switch"` 的最小形态、toggle 不复用 `/hosts/save` 的理由。

---

## 四、建议的下一步

1. 先做 fork 审阅里的「连接失败可见性」——独立、低风险、纯增量，可作为 `engine.failures` 的最小改动先行。
2. 功能 1（展示文件）、功能 2（主机开关）、功能 3（会话命令行审查）都触及多条链，建议各开一个 FF 任务书（`NN-<topic>-prompt.md`）再实施；本文只作调查与边界钉子。
3. 实施前注意：当前工作树已有另一条**无关**的在途改动（`docs/ui.md`、`lib/client/client.panel.js`、`tests/host-card-smoke.mjs` 的「元信息胶囊前置」），不要覆盖或顺手提交它。

---

## 五、功能 3：会话命令行的审查（可行性调查）

### 需求范围（用户 2026-11-24 确认）

用户选了两项，均属「执行后」而非「执行前审批」：

- **A. 执行后审计留痕 + 按会话归属**：每条命令记下它属于哪个会话，可在面板按会话查看 / 回放历史。
- **B. 终端 PTY 命令捕获**：浏览器 / 内建终端里手敲的命令当前完全不进审计，需要捕获并记录。

现有的「执行前确认策略」（`needsConfirmation` / `confirmRemoteCommand`，默认 `off`）不在本次范围；它是 speed bump 不是沙箱，本文不改它。

### 现状：已有的命令审计体系

- **命令审计环** `CommandAudit`（`lib/engine/engine.js` 底部）：容量 200、`seq` 单调、写入时脱敏（`redactCommand`）、不记 stdout。字段见 `AuditEntry`：`seq/at/alias/command/cwd/channel/durationMs/exitCode/timedOut`，可选 `outcomeUnknown/refused/error`。**没有 session 字段**。
- **三条写入路径**：
  - `engine.exec()`（`lib/engine/engine.js` 约 1460）：`channel` 取 `options.channel ?? 'exec'`，shell 探活传 `'exec'`、后台任务继承默认 `'exec'`；`audit: false` 只用于目录选择器（一次性读，不进审计）。
  - 模式 / 确认拒绝（`lib/surface/tools.js` 约 999、1037）：`refused: true`，但 `channel` 硬编码 `'exec'`，**shell 工具的拒绝也被记成 exec**。
  - `/status`、`ssh_workspace_status`、`supportBundle` 把 `audit.list()` / `exportText()` 下发（`lib/routes/workspaces.js`、`lib/surface/tools.js`、`lib/surface/status.js`）。
- **会话归属的来源**：工具侧 `exec.agent.session` 就是会话 id（`sessionSandboxPolicy(ctx, exec)` → `sessionPolicyOf(ctx, exec?.agent?.session)`，`lib/surface/tools.js:1204`、`lib/core/mode-gate.js:228`）。DSH 侧 `workspaceRegistry.list()` 的每项带 `sessionIds[]`（`lib/routes/workspaces.js:84`），面板已用它做置灰（`lib/client/client.marks.js`）。两条线目前**没有 join**。
- **面板现状**（`lib/client/client.panel.js:1759`）：只画失败 / 拒绝 / 未知 / 超时的命令（`slice(-10)`），成功命令不显示，完整记录在诊断报告里。没有按会话过滤的概念。

### 可行性结论 A：审计 + 会话归属

| 环节 | 可行性 | 做法与注意 |
| --- | --- | --- |
| 在 `AuditEntry` 加 `sessionId` | **高** | `record()` 多收一个可选字段并脱敏拷贝（它已是纯对象）；老条目无该字段，读端按可选处理。`channel` 也应允许 `'shell'` / `'background'` 真实标注（现在后台任务继承 exec）。 |
| 从工具层传 session | **高** | `exec` 工具 `execute(args, exec)` 已有 `exec.agent.session`；`engine.exec` 加 `sessionId` 选项一路透传到 `record()`，或在 tools.js 的包装层补记。**注意**：现有 exec 审计写在 `engine.exec` 内部（约 1460），而 `engine.exec` 被内部探活 / 监视 / 列表调用，它们没有会话——字段必须可选，不能强求。 |
| 持久 shell 命令审计 | **中** | `shells.run()`（`lib/surface/shell.js:181`）直接 `channel.write(script)`，**完全不经过 engine.exec、不进审计**。需在 `ShellManager.run` 或工具的 `ssh_workspace_shell.execute`（`lib/surface/tools.js:1502`）里补一条 `audit.record({channel:'shell', command, sessionId})`，`durationMs` / `exitCode` 从 `result` 取。拒绝路径的 `channel:'exec'` 硬编码要一并改为传入真实 channel。 |
| 后台任务命令审计 | **中** | `startBackgroundExec`（`lib/surface/tools.js:1110`）的 `jobs.start().run` 里调 `engine.exec`，**会自动进审计**（同一次，channel exec）；但要标 `background` 与 session，需透传 `options.channel='background'` 与 sessionId。注意 degrade 到 inline 的分支也会记，别重复记。 |
| 按会话查看 / 回放 | **高** | `CommandAudit` 加 `listForSession(sessionId, limit)`（镜像已有 `listFor(alias, limit)`）；`/status` 下发时附 `commandsBySession` 或让面板本地按 `sessionId` 过滤。面板加一个会话选择 / 过滤控件，复用现有 `.sshwsp-audit-row` 渲染，**成功命令也要能显示**（把"只显示失败"的过滤做成可切换）。 |
| sessionId → 可读会话名 | **低优先** | 审计里存 id 即可；id→标题的映射 DSH 侧有，但插件只在 registry 的 `sessionIds[]` 见到 id，没有标题表。可先显示 id，后续再接 DSH 的 session 信息。 |

**A 的结论：可行，且改动集中在审计环 + tools/shell 包装 + 面板过滤，无新机制。** 主要工作量是补齐"持久 shell 命令不进审计"和"现有记录没有 session 维度"两处缺口；审计环本身已是为这类扩展设计的（纯对象、可选字段、镜像方法 `listFor` 可直接照抄）。

### 可行性结论 B：终端 PTY 命令捕获

这是三项里**最难、最需要明确边界**的一项。

| 环节 | 可行性 | 做法与注意 |
| --- | --- | --- |
| 捕获终端里的输入 | **中** | `RemoteTerminalHandle.write(data)`（`lib/patch/patch-terminal.js:332`）是唯一的写入口，可以在这里拿到用户敲下的字节。但 `data` 是**原始 PTY 字节**，逐击键到达：一个 `ls\n` 会是 `l`、`s`、`\r` 多次 `write`。需要按回车（且排除控制序列 M-C 字节 `0x00–0x1f`）才收成一条命令。 |
| 把字节还原成命令行 | **中偏低** | 回显与编辑键混在输入流里（退格 `0x7f`、方向键转义序列、Ctrl-C `0x03`），`write` 收到的是"发给远端的内容"，不等于"用户最终执行的命令行"。一个可靠做法：累加可打印字符、遇 `0x7f` 退一格、遇控制字节清空当前行、遇 `\r`/`\n` 成条。这能覆盖常见交互，但对多行 heredoc、粘贴块、shell 提示符里的复杂编辑仍会失真——**只能做到"近似重建"，不能保证与远端真实执行的命令一致**。 |
| 归属到会话 | **中** | `RemoteTerminalHandle` 构造时（`lib/patch/patch-terminal.js:566` 附近 `spawnTerminal`）有 `spec.env.DSH_SESSION_ID`（`sessionOfSpec` / `specModeOf` 已在该文件用），可拿到 sessionId 与 alias。写入捕获时可带上。 |
| 记入审计环 | **中** | 捕获到的命令行经同一 `engine.audit.record()` 写入，`channel:'terminal'`。`AuditEntry.channel` 已预留 `'terminal'` 枚举值（见 2063 行），**审计环天生支持终端通道，只是从来没人往里写**——这降低了接入成本。 |
| 与"执行后"语义对齐 | **需决策** | `write` 只记录"用户敲了什么"，无法知道这条命令的退出码 / 耗时（PTY 输出流里没有逐命令的完成标记，除非像持久 shell 那样注入 marker，但那会污染终端显示）。建议终端条目只记 `command/sessionId/at/channel='terminal'`，`exitCode: null`，并在面板上以"已输入（结果未知）"呈现，与 exec 的执行结果区分。 |

**B 的结论：技术上可行，但只能交付"尽力而为的输入重建"，不是精确审计。** 有几个必须写进文档 / 产品确认的边界：

1. **重建可能失真**：PTY 输入是击键流 + 编辑控制序列，"用户敲的"与"shell 真正执行的"在 heredoc、粘贴、行编辑等场景会不一致。一个会误判的审计比没有审计更糟——但这里的语境是"事后留痕"，不是"拦截"，误记一条命令的代价可接受，前提是界面注明"终端命令为按键重建，可能不完整"。
2. **没有退出码 / 耗时**：终端条目只能记输入，不记执行结果，必须与 exec/shell 条目在 UI 上区分。
3. **控制字节不能误记**：`Ctrl-C`（SIGINT）、关闭等控制字节是"停止"语义（`write` 里 `controlOnly` 分支已有此判断，patch-terminal.js:334），不能当成命令记录，否则会记出一堆 `^C`。
4. **不侵入现有语义**：捕获必须只挂在 `write` 的旁路，不改变 `channel.write` 的调用与错误契约（patch-terminal.js:341-356 的回调 / 状态判断很敏感，曾被未 settle 的 promise 冻住整个终端队列）。绝不能让审计写入阻塞或抛错影响输入——沿用 `CommandAudit.record()` "永不抛"的纪律。
5. **测试策略**：`tests/browser-terminal-smoke.mjs`（用忠实复制 ssh2 契约的假通道）是天然落点——加一组"逐击键 write → 回车成条 → Ctrl-C 不成条 → 审计里出现 channel=terminal 且带 sessionId"的断言；反向验证：删掉 `write` 里的捕获钩子必须转红。

### 综合结论

- **A（审计 + 会话归属）优先做**：低风险、无新机制、审计环本就为扩展设计。最小闭环 = `AuditEntry` 加 `sessionId` + 持久 shell 补记 + 面板按 session 过滤 + `listForSession`。
- **B（终端捕获）可作为第二阶段**：技术上能做，但要接受"近似重建 + 无退出码"的诚实边界，并在产品上确认这种留痕是否够用。若产品要求"终端命令必须与 shell 真正执行的一致且带结果"，则**不可行**——那需要在远端 PTY 里注入命令边界标记（会污染终端）或替换用户 shell（违反"跑远端自己的 shell"的设计），两者都超出插件边界。
- 两项都**不改执行前确认策略**、不改模式门禁，保持"记录而非沙箱"的定位（engine.js:1958 的设计原则）。

### 审计落盘（2026-11-24 新增）

当前 `CommandAudit` 是**纯内存 ring，从不落盘**，进程退出即消失。落盘是全新设计。

**落在哪**：`$DSH_HOME/dsh-ssh-workspace/dsh-ssh-commands.json`——在 `$DSH_HOME` 下**单独建一层 `dsh-ssh-workspace/` 目录**，与 `dsh-ssh.json`、`dsh-ssh.key` 分开（不并排放在根下）。`$DSH_HOME` 与 `dshHome()` 同源（`lib/hosts/store.js:39`，`process.env.DSH_HOME ?? ~/.dsh`）。因为多了一层目录，写入前必须 `mkdirSync(dirname(path), { recursive: true, mode: 0o700 })` 确保它存在（照 `store.js:1044` 的模式），而不是假设父目录已存在。不碰宿主自己的 session log（`lib/routes/workspaces.js:338–340` 明确"不伸手 unlink session logs"）。

**什么格式**：单个有界 JSON 文档，不是 append-only 日志：
`{"version":1,"entries":[{"seq":1,"at":…,"alias":"prod","sessionId":"s-1","command":"ls -la","channel":"terminal",…}]}`。
写入沿用 `lib/hosts/store.js:1059–1075` 的原子模式：随机暂存名 → `mode 0o600` → `renameSync` 发布 → `chmodSync` 收紧；跨进程复用 `withFileLock`。启动时读回 ring，形状不对 / 读不出降级为空，读入再裁到容量。不建议 JSONL + 轮转（半行、轮转窗口、多文件读取，且违背仓库"单文档 + 原子替换"惯例）。

**如何保证文件大小（构造上保证，不靠事后清理）**：

| 层 | 界 | 出处 |
| --- | --- | --- |
| 条数 | `AUDIT_CAPACITY = 200`，超出淘汰最旧 | `lib/engine/engine.js:1977` |
| 命令行 | 400 字符，超出标 `...` | `lib/engine/engine.js:1980` |
| cwd / error | 各 200 字符 | `lib/engine/engine.js:2109–2112` |
| stdout | **完全不记** | `lib/engine/engine.js:1973–1974` |
| 脱敏 | 写入时 `redactCommand()` | `lib/engine/engine.js:2099–2103` |

按此界单条约 1.4 KB（命令 JSON 转义最坏翻倍），200 条约 **280 KB 硬顶**；用紧凑 JSON（不缩进）即可稳住。**落盘前必须补两个无上限字段的裁剪**，否则保证是假的：`alias`（`record()` 里 `String(entry?.alias ?? '')` 无限制，按 `validateAlias` 的 64 字符裁）、新增的 `sessionId`（同样裁 64）。再加兜底：序列化后若超 `MAX_AUDIT_FILE_BYTES`（建议 512 KB），丢最旧条目直到达标。

**取舍**：全量原子重写意味着每条命令重写整个约 280 KB 文档，忙会话几十 MB 写入但可接受。节流（如 2 秒合并）会丢崩溃前最后几条——对"审查留痕"最糟，故先做全量原子写，实测有性能问题再谈。持久化必须异步、旁路、永不抛（`record()` 现有纪律），不能阻塞命令路径。

### 功能 4：远程工作区面板新增「审计」tab

需求：面板加一个审计 tab 页，里面**按工作区审计**；初始 200 条，以设置中的保留条数为准（见功能 5）。

**现状调查**：

- 面板 tab 是 `lib/client/client.panel.js` 的 `PANEL_TABS = ['hosts', 'workspaces', 'settings']` + `PANEL_TAB_KEYS` + `panes` 对象 + `role="tablist"` 的下划线按钮（:309–319、:1895–1939）。加第 4 个 tab 要动四处列表并加 `paneAudit`。
- **测试把 tab 集合钉死了**：`tests/client-shape-smoke.mjs:1260` 断言四个 locale key 恰好出现两次、:1269 断言 `PANEL_TABS = ['hosts', 'workspaces', 'settings']` 字面量、:1214 断言 `visiblePane` 逻辑。加审计 tab 必须同步改这三处断言（否则红），并给新 tab 加 `panel.tabAudit` 中英文案（`client.locale.js`）。
- 面板现有「最近的远端命令」区（`client.panel.js:1759–1789`）只画失败/拒绝/未知/超时的命令、`slice(-10)`，是 settings 页里的一个 section。审计 tab 是它的扩展：**要显示成功命令、要能按工作区过滤**。
- **"按工作区审计"有个归属缺口**：DSH 工作区是 `ssh://alias/path`，而 `AuditEntry` 只有 `alias` + `cwd`（cwd 是命令执行目录，不是工作区 root），**没有 workspace id**。精确按工作区分组要靠功能 3A 的 `sessionId` → `workspaceRegistry[].sessionIds[]`（`lib/routes/workspaces.js:84`）反查：一个工作区持有一组 session，审计条目记 sessionId，tab 侧按 session 归属归到工作区。若只按 alias 分组则简单但不精确（一个 alias 可挂多个 path）——**这是实施前要产品确认的语义点**，建议按 sessionId→工作区反查，与功能 3A 复用同一机制。
- 数据来源：`/status` 已下发 `commands: audit.list(50)`（`lib/routes/workspaces.js`、`lib/surface/tools.js:804`）；审计 tab 需要下发**全量可配上限**的命令（见功能 5），并附 workspace→sessionIds 映射（`/status` 的 `workspaces[].sessionIds` 已有）。

**设计约束**：tab 是纯展示，不改审计/确认语义；空态（无记录）、按工作区下拉过滤、条数上限提示都要有；命令文本已是脱敏后写入的，tab 直接显示，不做二次脱敏。

### 功能 5：设置中可配置审计保留条数

需求：设置里加一项，配置审计保留多少条；tab 与审计环**以设置值为准**，默认 200。

**现状调查**：

- 容量现在是构造时固定的：`AUDIT_CAPACITY = 200`，`new CommandAudit()`（`lib/engine/engine.js:158`）无参，`constructor(capacity = AUDIT_CAPACITY)`（:2081），`record()` 用 `this.capacity` 裁剪（:2114）。`tests/audit-smoke.mjs:109–110` 钉住默认等于 `AUDIT_CAPACITY`。
- 设置持久化有现成模式可照抄：`lib/hosts/store.js` 的 `passthroughOf()`（:435）+ `setPassthroughSettings()`（:924）+ `#withDocumentLock()`（:1043 原子写）。新增 `auditOf(document)` section（如 `{"audit":{"retention":200}}`）+ `setAuditSettings(patch)`。
- 下发/写入链：passthrough 经 `lib/routes/forwards.js:279`（POST 设置路由）+ `lib/routes/workspaces.js:119`（`/status` 下发）+ `lib/client/client.panel.js:1036`（面板保存）+ `lib/client/client.kernel.js:68`（API 常量）。审计设置照此加一条 POST `/audit/settings`。

**设计约束**：

1. **动态改容量**：改设置不能只改配置文件——运行中的 ring 必须跟着变。给 `CommandAudit` 加 `setCapacity(n)`：更新 `this.capacity` 并立刻裁掉多余旧条目。构造时读设置值（而非写死 200），缺省 200。
2. **范围钳制**：retention 必须是正整数、有上下界（建议 1–2000，与文件 512 KB 兜底对齐——2000 条 × 约 1.4 KB 已超 512 KB，故上界要按兜底反推，或把兜底随 retention 调整）。非法值降级到 200，不写回用户文件。
3. **"以设置中的为准"的影响面**：审计环 `capacity`、审计 tab 显示上限、落盘文件裁剪都以同一个设置值为唯一事实，不能各存一份。三处读同一个 `retention`。
4. **测试**：`tests/audit-smoke.mjs` 加 `setCapacity` 裁剪、非法值钳制、设置往返；新增 store 往返断言（retention 落盘 / 缺省 200）；路由测试 200 / 非整数 / 越界 / 缺字段。反向验证：改容量后旧条目必须被裁掉。

### 改动面预估（功能 3–5 合计）

A：`lib/engine/engine.js`（AuditEntry + record + `listForSession` + `setCapacity` + 落盘读写）→ `lib/surface/tools.js`（exec / shell / 后台任务透传 sessionId 与真实 channel）→ `lib/surface/shell.js`（`run` 补记 shell 命令）→ `lib/hosts/store.js`（audit settings section）→ `lib/routes/forwards.js` 或新路由（设置 POST）+ `lib/routes/workspaces.js` + `lib/surface/status.js`（下发 + schema）→ `lib/client/client.panel.js` + `client.locale.js`（审计 tab、会话/工作区过滤、设置项）→ `lib/client/client.kernel.js`（API 常量）→ 测试（`audit-smoke`、`tool-results-smoke`、`client-shape-smoke`、`browser-terminal-smoke`）。
B：`lib/patch/patch-terminal.js`（`RemoteTerminalHandle` 构造取 sessionId、`write` 旁路捕获成条）→ `lib/engine/engine.js`（`channel:'terminal'` 已是合法值，无需改枚举）→ `tests/browser-terminal-smoke.mjs`（捕获断言 + 反向验证）→ 文档注明近似性与边界。
顺序建议：设置项（5）→ 动态容量 + 落盘 → 审计 + sessionId（3A）→ 面板审计 tab（4）→ 终端捕获（3B，最后，边界最不确定）。
