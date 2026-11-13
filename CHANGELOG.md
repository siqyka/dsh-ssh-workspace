# 更新日志

本文件记录 dsh-ssh-workspace 的版本变更。0.1.16 之前的版本为未公开的本地迭代，未收录。

## [0.3.3] - 2026-11-13

### 修复

- **`ssh://` 会话读不到聊天框上传的附件**（[#4](https://github.com/siqyka/dsh-ssh-workspace/issues/4)）：远端会话把所有裸绝对路径当成远端，本机 `$DSH_HOME/attachments/…` 被拼成 `ssh://<alias>/…` 走 SFTP。新增 `localPassthrough`（默认 `$DSH_HOME/attachments`、`$DSH_HOME/plugins`），在 `ctx.fs.resolve` / `lstat` 与 `node:path.resolve` 的远端分支**之前**做词法前缀直通；未命中前缀的路径仍按远端解释，不做存在性探测。交给本地后端时剥离远端 `cwd` 以免递归回自身；写围栏不变，整目录 `$DSH_HOME` 被拒绝。
- **`@F:\…` 形式的本机路径引用变成远端路径**：宿主把 `@` 提插成普通提示词文本，文件系统调用处没有元数据可查。插件改为从 `session/created` 的历史与 `session/event` 的 `user/message` 恢复引用，只接受 Windows 盘符 / UNC 并交给同一个 matcher（先进先出，上限 256 条）；`@src/a.js`、`@/tmp/x` 仍是工作区 / 远端路径。
- **提示词不再承诺直通管不到的东西**：直通只覆盖经过 `ctx.fs` 的调用，dsh-ops 的 `inspect_local_file` / `read_files` / `glob` / `grep` 与宿主 `glob` / `grep` 绕过它，`ssh://` cwd 下分别报 `EXECUTOR_UNAVAILABLE`（`only git and ripgrep`）与 `invalid workdir`。`LOCAL_PASSTHROUGH_GUIDANCE` 写明这条边界与替代入口，不再让模型空转重试。

### 测试

- 新增 `local-passthrough-smoke`（88 项）；`scripts/reverse-verify-passthrough.mjs` 20 confirmed / 0 not。

### 文档

- README 中英新增「本机路径直通（`localPassthrough`）」；`docs/features.md` 补规则表与「直通的边界就是 `ctx.fs`」；`docs/troubleshooting.md` 新增「直通了，为什么还是读不到」；`docs/architecture.md` 说明直通先于远端分类、`@` 引用是同一 matcher 的第二类输入。

## [0.3.2] - 2026-11-11

### 新增

**文件与选择**

- **系统文件拖入远端「文件」树上传**：落点决定目标目录——目录行（折叠或展开）是自身，文件与 `other` 行是父目录，展开目录内的嵌套空白归属该目录（宿主的子列表就在同一个 `li` 内），树体空白与树头 / 路径标签归树根；不自动展开目录。只接收文件：拖入文件夹整批跳过（前三个名字 + 省略号，不递归、不入队），与文件混合时跳过说明搭在同一条批次提示的结果句上而不再另开一条会互相覆盖的 toast，只拖文件夹时才单独提示；本地工作区的树明确拒绝，不静默变成 composer 附件。监听在 document capture 阶段，树内 `preventDefault + stopPropagation` 拦住宿主附件，树外不拦截、DSH 原有拖入行为不变；内部「树行 → 输入框」拖拽只带自定义 MIME，仍走原落点插入分支。上传复用同一个 `enqueueUploads` 队列与同一句超限提示，成功后的刷新仍由队列负责。
- **本地工作区「文件」树的空白处菜单**：空白处右键恰好两项——「新建文件夹」「复制路径」。目标目录是空白处所属的那一个（落在已展开目录的嵌套列表里就是那个目录，否则是树根），必须在树根之内；只读会话只禁用新建，复制始终可用。`POST /mkdir` 因此按 `path` 的拼写分支，本地分支的边界只取自会话/策略（请求里的 `root` 只用于识别会话），`realpath` 父目录防符号链接逃逸。远端工作区保留原有空白处菜单，远端目录行的「新建文件夹」保持不变。
- **多选整批拖入输入框**：`dragstart` 用 `resolveTargets` + `treeSelectedItems` 取整批目标，载荷是版本化 JSON；`drop` 一次调用同一个插入助手，按树中顺序逐条插入、重复路径只插一次；行菜单「添加到任务」用同一目标集合。

**输入框**

- **拖入时按指针落点插入引用**：`dragover`/`drop` 用浏览器 `caretRangeFromPoint` 把指针位置映射成 composer 的 detect 偏移；文本按 `data.length`、chip 按 1、managed `<br>` 按 0、段落之间按一个换行累计。拖动期间在输入框内画一条单例竖向光标，第一个 chip 插在落点、后续 chip 依次跟随。多张可见输入卡、指针在卡片内边距、边界不可映射或浏览器不给 caret 时一律回退到旧的追加行为，映射失败不影响投放。

### 修复

- **工具返回值被 DSH 0.2.2-rc.1 拒绝**（[#3](https://github.com/siqyka/dsh-ssh-workspace/issues/3)）：宿主开始真正校验 `output.schema`，`ssh_workspace_status` 的 `events[].seq` 一直在产生却没被声明，`ssh_workspace_hosts` 直接把带未声明键（含 `undefined`）的存储行交给宿主，整次调用被判成不可无损 JSON。修的是**这一类**而不是这两个字段：新增 `lib/tool-schema.js` 的 `projectValue` / `validateValue`，`defineTool` 按各工具自己的 schema 投影返回值并把丢弃记进 `drainProjectionDrops()`；顺带修掉 `ShellManager.list()` 的 `startedIn: start?.cwd`，以及 `projectValue` 自己漏报「未声明且值为 `undefined`」的键。新增 `tests/tool-results-smoke.mjs` 真跑 `execute` 并**对丢弃记录断言为空**——schema 必须跟上生产者，而不是靠投影悄悄吃掉信息。
- **同名工作区误标**：标题是弱身份，本地工作区与远程工作区可以合法同名（本仓库本身就是）。此前标记与停用置灰只按标题匹配，同名的**本地**行会被换成远程标记、甚至被置灰成不可点。现在同时收集本地标题，两边都有的标签不标识任何一方；标题规则也只在完整读过 DSH 自己的 store 之后生效，`/status` 回退时只做 id 匹配。
- **拖动插入后光标落在错误位置**：插入后只聚焦一次，且聚焦的是接住投放的那张输入卡（不再受「唯一可见 composer」这条歧义规则影响）；拖动结束清掉树行里残留的文本选区，光标落在 chip 之后而不是行名上。

### 测试

- 新增 `tree-blank-menu-smoke`（16 项）、`tree-drag-smoke`（24 项）、`tree-os-drop-smoke`（60 项）、`composer-drop-point-smoke`（42 项）、`tool-results-smoke`（33 项）；`client-shape-smoke` 275 → 298、`mutations-smoke` 62 → 80、`transfer-queue-smoke` 135 → 138、`caret-after-insert-smoke` 17 → 19。
- 裸检出 **76 passed / 6 skipped / 0 failed（82 套件，3759 项断言）**；真实装配树 **79 passed / 1 partial / 2 skipped（4003 项断言）**。反向验证 `reverse-verify-tree-drag`：17 confirmed / 0 not。

### 文档

- README 中英文同步系统文件拖入、本地空白处菜单与本地 `/mkdir` 分支；`docs/ui.md` 记录落点映射、退化矩阵与两种「文件夹」；`docs/protocol.md` 补 `/mkdir` 的两个分支；`docs/tools.md` 补 `hosts` 的可选字段与 `status` 的 `events[].seq` / `shells[].startedIn`；`docs/development.md` 与 `docs/optimization-and-future03.md` 同步套件数与闭环状态。

## [0.3.1] - 2026-11-08

### 新增

**文件与选择**

- **宿主「文件」树多选**：Ctrl/Cmd 切换、Shift 选区间；普通单击仍打开，修饰键点目录只选不进；选择按会话 + 根记忆，重挂载后仍可续选。
- **菜单文案固定，作用范围随选择**：删除始终「删除」、下载始终「下载到本机」，不再有「删除所选（N 项）」「下载所选（N 项）」两套文案；目标由 `resolveTargets(clickedRow, selection)` 唯一决定，收敛发生在菜单弹出前。数量移到删除确认框与下载目标对话框：确认框先出现、数字后到，递归计数上限 200，本地未知与列目录失败分别说明。
- **批量下载只问一次位置**：超过一项先确认再选目录，依次回落浏览器 `showDirectoryPicker`、preload 桥、`uiWorkspace.pickDirectory`、逐项保存；取消即取消整批；混选时本地行被跳过并说明。
- **行内重命名 / 新建文件夹 / 删除**：F2 或行菜单原位输入；新增 `POST /rename`、`POST /delete`、`POST /mkdir`，越界、根目录、只读 / 停用状态拒绝，软链只动链接本体，目录删除逐项 lstat。
- **行右键菜单收窄**：220px 单行、24px 行高、最多 8 项、三组分隔线，各动作独立图标。

**传输**

- **统一传输队列与进度**：浏览器上传共用一份队列（主机 1 / 全局 2），五态、可单独取消、可暂停 / 恢复、失败可重试；重试重新判冲突、补缺失分片并双侧 SHA-256 校验。
- **速度与聚合进度环**：运行行显示百分比、速度、字节；速率 250ms 采样平滑，停顿 5s 归零；头部入口按字节加权聚合。
- **分块上传 / 断点续传 / 目录下载**：2 MiB 分片经 `POST /upload-chunk`；暂存名由目标派生、sidecar 记源；`downloadTree` 默认 zip、`?format=tar` 可回退，跳过 symlink 并列出。

**连接与配置**

- **`ProxyJump` 真建链**：按 `ssh -J` 逐跳建独立连接，目标只看到直接邻居；`ProxyCommand` 仍拒绝。
- **反向转发 `ssh -R`、`Include` 跟随与 `Match` 求值、命令确认策略、主机最近使用、`ssh://` 路径菜单、状态来源 live / cached / stale**。
- **远端「新建文件夹」** 与 **宿主文件树右键菜单**（复制 `ssh://` 路径、设为工作区根）共用同一套围栏。

### 修复

- **同一路径被监视两次、事件双发**：按 `alias + 规范化路径` 建注册表，同目标只留一只底层 watcher，事件逐消费者各扇出一次，关闭按引用计数；真实 SSH socket 硬断并自动重连后计数始终为 1。
- **错误提示只有一句话，看不见原因也无法重试**：统一 7 秒窗口、悬停暂停；错误就地提供详情 / 复制 / 重试，只在可安全重放的动作上渲染重试；所有反馈改写同一节点。
- **传输在桌面端、非 ASCII 文件名与长请求上的三处断点**：分块 JSON 替代 `File` 请求体、RFC 6266 / 5987 文件名、读取期 2 小时超时；「已下载」改为先选目标再写入。
- **断线后监视永久停止 / 持久 shell 回到登录目录**：只在链路不通且有重连循环时重试，恢复后补扫；shell 按会话记住起始目录。
- **能力表虚构、配置指纹漏检、单文件上限只对一条门成立**：虚构能力移入 `UNPROBED_CAPABILITIES`，配置指纹改用内容哈希，上限从 `transfer.js` 导出并在上传 / 下载两侧判定。

### 移除

- **清理 27 个零引用 i18n 键**：中英各删 27 行，335 → 308 键；与活键同前缀的旧键整行精确删除。
- **「浏览目录」只保留浏览与挂载**：逐行下载与上传入口退场。

### 变更

- 关闭目录对话框不再中断传输；浏览器唯一上传通道是 `POST /upload-chunk`；面板不再渲染「远程环境自检」。

### 测试

- 新增 `selection-targets-smoke`（77 项）、`toast-smoke`（87 项）、`watch-sharing-smoke`（36 项）、`transfer-retry-smoke`；`transfer-queue-smoke` 覆盖队列顺序与速度，选择套件覆盖连续 Shift 与零打开。
- 裸检出 **70 passed / 6 skipped / 0 failed（76 套件）**；真实装配树 **73 / 3 / 0**。反向验证：菜单带 N、去收敛、计数错位、删重试门控、去 watcher 注册表均真红。

### 文档

- 三辑合并：删除 `docs/optimization-and-future.md` 与 `docs/optimization-and-future02.md`，内容收进 `docs/optimization-and-future03.md`；删除 `unmount-modes.md`、`trigger-gates.md`、`acceptance-prompts.md` 三篇临时专题，修正索引与死链。
- README 中英文同步多选、浏览收窄、ProxyJump 限制、11 个工具与反向上游转发；`docs/ui.md` 记录确认框先出现、菜单固定文案。

## [0.2.8] - 2026-10-31

### 新增

- **上游补丁的探测能区分「读的是绑定」与「读的是快照」**：新增 `lib/path-binding.js`，探测期间把 `path.isAbsolute` 换成记账包装，捕获了函数值的 schema 永远不碰它。
- **诊断判定与状态灯**：新增 `lib/diagnosis.js`，只读报告已打印的字段给出 `ok` / `warn` / `unknown` 三态（不探测、不连接、不读文件）。`/status` 与 `ssh_workspace_status` 新增 `diagnosis`。
- **报告补上三处漏掉的事实**：`## host keys`、被跳过的主机、连接代次。
- **断线后自动重连**：后台指数退避（1 秒起、60 秒封顶），面板卡片显示重连状态，`POST /hosts/reconnect` 跳过等待。
- **重连后恢复已存隧道**：该主机 `enabled` 的保存转发自动重开，普通首次连接不会重开用户关掉的隧道。
- **`engine.reconnect` 配置**：`baseDelayMs` / `maxDelayMs` / `maxAttempts` / `jitter`，传 `false` 退回旧行为。
- **菜单可用键盘操作**：方向键环绕移动、`Home` / `End` 跳首尾并跳过禁用项、`Tab` 关闭菜单。
- **诊断文本可导出**：`ssh_workspace_status` 新增 `diagnosticsSchemaVersion` 与 `diagnosticsText`，纯文本、默认脱敏，可直接贴进 issue。
- **主机列表能区分「空」与「读不出来」**：`ssh_workspace_hosts` 与状态接口返回 `skipped` / `storeError`。
- **文档数字从源码生成**：新增 `scripts/doc-numbers.mjs`，已接入 `npm run check:docs`。
- **远程环境自检**（F-06）：7 项工具与 4 项环境事实在一次往返内问完，三态 `present` / `absent` / `unknown`。新增 `GET /self-check` 与 `selfCheck` 字段。
- **`~/.ssh/config` 审计**（F-04）：新增 `lib/config-audit.js`，`ignored` / `lost` / `refused` 三种判定不合并，结果挂在 `HostStore.listing()` 每行的 `unsupported` 上。
- **远端命令审计**（F-07）：新增 `lib/audit.js`，容量 200 的有界环，脱敏在写入时发生。
- **一键支持包**（F-09）：新增 `lib/support-bundle.js` + `GET /support-bundle` + 面板「复制支持包」，组装而非采集，不做自动上传。
- **连接分代**（F-01）：`engine.generations` 记录每个 alias 的成功连接次数，第 2 代起说明「重连前启动的远端进程可能仍在运行」。
- **补丁的宿主契约成表**（O-15）：新增 `lib/upstream-contract.js`，每个 `patch-*.js` 声明它碰的宿主符号与退役判据。

### 修复

- **上游补丁把自己误判成「可以删除」**：探测曾报 `fixed` 并建议删掉 workaround，而宿主源码仍是 `refine(isAbsolute)`。现在要求证明 schema 读的是绑定，否则如实报 `broken`。
- **面板状态文案显示原始键名**：`connections.connected` / `connections.broken` 从未定义，已补齐中英文案。
- **失败重放会重复执行写操作**：写类 SFTP 操作不再重放，改标 `outcome: 'unknown'`；命令重放改为显式 `replay: 'safe'`。
- **推送式监视降级后轮询句柄泄漏**：`watch()` 改用单一可变句柄，轮询初始化失败也不再被静默吞掉。
- **原始字节上传绕开了 CSRF 前提**：`/upload` 要求 `application/octet-stream`，`/download` 走同一守卫。
- **跳板机主机被直连**：`ProxyJump bastion` 曾被判为「没有跳板机」并直连目标；现在字符串与数组都接受，按 first-wins 处理 `Host *` 与 `!name` 排除。
- **持久 shell 超时后下一条命令读到上一条的输出**：下一条 `run` 先发隔断屏障并丢弃之前输出；解码改用 `StringDecoder`。
- **传输暂存名可能碰撞**：加 16 位随机十六进制并用 `wx` 打开；下载侧改为与 `error` 竞速，写流出错不再永久挂起。
- **首次主机密钥落盘失败仍静默连**：现在记 `degraded` 诊断并在状态输出 `unpinnedHostKeys`，后来固定成功时自动清除。
- **并发首读开两条第二通道**：`streamChannel` 加 single-flight，元数据缓存改为缓存进行中的 Promise。
- **对话框缺键盘与读屏契约**：抽出共享的 `useDialogA11y`。
- **能力探测用子串匹配判断工具存在**：`stdout.includes('rg')` 会把路径里含工具名的情况误报为已装，现在走独立前缀行并整行匹配。
- **勾选「转发 ssh-agent」后目录浏览不可用**：该字段曾被塞进连接级 config，没有 agent 时 `connect()` 直接抛错；现在只在 exec / shell 通道表达。
- **本机没有 ssh-agent 时，认证失败被报成「取不到 agent 身份」**：现在连接前先用 `getIdentities` 问一次（2 秒超时）。
- **服务器禁止转发时，勾选该选项会让整条命令失败**：识别出这一种拒绝后重试一次不带该标志，结果带 `forwardingRefused`。
- **同一会话并发打开会泄漏一个 PTY**（O-06）：按会话名做 single-flight，失败不缓存，`dispose` 期间到达的会话自行关闭。
- **超过 30 分钟的下载会被空闲回收器摘掉连接**（O-07）：`inFlight` 在回调返回时减一，而下载的真正读取发生在之后；现在流一开就 `holds += 1`。
- **失败被答成 200**（O-10）：失败一律非 2xx，状态码由 `STORE_INVALID` / `STORE_CONFLICT` / `STORE_UNREADABLE` 决定。不是失败的业务结局仍是 200。
- **面板把「读不出主机列表」显示成「暂无主机」**（O-10 的另一半）：空态按事实分句，且缺口在列表非空时也显示。

### 测试

- 新增 `replay-smoke`、`watch-lifecycle-smoke`、`scratch-safety-smoke`、`host-key-smoke`、`host-listing-smoke` 五个套件。
- `shell-smoke` 新增 13 项：并发 `open` 只建一条通道、失败不入缓存、`dispose` 期间到货的通道被关闭。
- `routes-smoke` 新增 12 项：下载期间连接被 pin 住且流结束即释放；失败契约（409 / 400 / 502 / 404 / 200）。
- `client-shape-smoke` 新增 19 项：列表缺口与存储失败各自的措辞、对话框键盘契约。
- 汇总输出改为 PASS / SKIP / FAIL 三态，不再把 SKIP 当 PASS。

### 文档

- `architecture.md` 新增「后台重连」；`troubleshooting.md` 新增排查表；`features.md` 新增能力表；`ui.md` 记录卡片状态与诊断报告一节。
- 新增 `docs/optimization-and-future.md`：16 项优化的审阅、推进结果与反向验证、9 个能力方向（该卷已删除，内容并入 `docs/optimization-and-future03.md`）。
- 两个 README 的配置表补上 `engine.reconnect`，版本示例更新为 npm 上的 `latest`。
- 全量文档审阅：路由清单补齐 `hosts/reconnect` / `self-check` / `support-bundle`，源码结构表补上 8 个模块，套件表补上 7 个缺行，各处套件与断言计数统一为实测值（裸检出 44 套件 / 1733 项、真实装配树 1956 项）。
- 诊断环的容量与各导出面的条数分开写清（容量 40，`events` 取 10，`/status`、`diagnosticsText` 与诊断报告取 20）。
- 两篇既有文档补登索引：`docs/trigger-gates.md`、`docs/acceptance-prompts.md`（两页已删除）。

## [0.2.7] - 2026-10-24

### 新增

- **连接事件可查**：`ssh_workspace_status` 与面板 status 路由新增 `events`，记录最近的连接 / 断连 / 重连 / 降级事件。
- **统一命令入口**：新增 `npm test` / `npm run lint` / `npm run check:docs` / `npm run check`，CI 与发布流程改用同一组命令。
- **贡献者与安全说明**：新增 `CONTRIBUTING.md`、`SECURITY.md`。
- **退役模式单独成文**：新增 [docs/upstream-workaround-pattern.md](docs/upstream-workaround-pattern.md)，写明上游补丁该在什么信号出现时撤掉。

### 修复

- **退役信号只写进无人读取的日志**：上游补丁的退役信号原先只进 `ctx.logger`，本部署无人读；现在经状态接口的 `upstreamWorkarounds` 字段与一条 `upstream` 事件暴露。
- **「探不到宿主」被当成「宿主仍有缺陷」**：上游补丁的探测从布尔改为六态，两者不再混为一谈。
- **断言失败只说结论**：`projection-real-smoke` 中「缺陷仍然存在」的失败信息现在直接给出删除补丁的步骤。
- **加载失败的 peer 包被静默跳过**：检测器新增 `broken`（解析到但加载失败），套件失败而非跳过，且不再被报成「没装」。
- **真包与替身并存被报成「真包」**：整树判定要求所查的每个包都是真的，并存时报 `mixed`。
- **`boot-smoke` 自己维护一份 peer 检测**：现在统一走检测器。
- **两个 stub 缺少 `__dshStub` 标记**：`dsh-tools` 与 `cordis` 的替身已补上。
- **`ssh2` 缺失被说成「宿主 peer 包」**：现在按角色区分，本包依赖缺失给出 `npm ci`。

### 测试

- 新增 `tests/peer-mode-smoke.mjs`，用四态合成树驱动检测器自身。

### 文档

- [docs/upstream-workarounds.md](docs/upstream-workarounds.md) 的退役判据改按状态集说明，删除步骤补齐相关字段。
- `development.md` 新增「日志与诊断」一节，并校正套件与断言计数。
- `troubleshooting.md` 的连接排查改为先看 `events`。

## [0.2.6] - 2026-10-21

### 修复

- **`ssh://` 会话打不开**：`cwd` 为 `ssh://` 的会话打开时报「历史加载失败」，删缓存也无效；现在能正常打开。
- **npm 装出第二份私有宿主**：安装本插件时 npm 会另装一份私有宿主副本，插件随之加载到第二份 `dsh-fs` / Cordis（服务实例分裂）；现已不再发生。
- **版本约束从未生效**：`package.json` 里写在 `dsh.engines` 下的版本要求不被读取，已删除，改由 `peerDependencies` 声明。

### 清理

- 删除 `patch-terminal.js` 中从未被调用的 `remoteTargetOf`。
- 13 个只在本文件内使用的 `export` 收回为内部定义。
- 去掉 `routes.js` 未使用的 import，以及两条没有调用方的客户端 API 映射。
- 删除 16 个没有任何引用的界面文案键（中英词典同步，现为 163 定义 / 163 引用）。
- 删除 `scripts/verify-sftp.mjs` 中的死代码，以及仓库根目录遗留的 `.peer-stubs/`。

### 文档

- 新增 [docs/upstream-workarounds.md](docs/upstream-workarounds.md)：登记绕开宿主缺陷的临时补丁，含退役信号与删除步骤。
- 根 README 的「快速开始」补上从源码仓库使用的步骤：`git clone` 后必须先 `npm ci` 再重启客户端，否则插件不会加载（`ssh2` 是直接依赖，不随 clone 到位）。
- 根 README 的版本号示例更新为 npm 上当前的 `latest`。
- 校正 `development.md` 等文档中的套件与断言计数。

## [0.2.5] - 2026-10-19

### 修复

- **文件上传可以落到远端工作区之外**：`ssh_workspace_transfer` 与面板上传此前只做模式与范围判定，缺少挂载根与符号链接判定，同一路径 `write` 会拒绝而上传照常落下。现在上传与 `write` 共用同一道判定，递归上传对每个创建的目录逐一判定。
- **远端 `workspace-write` 拒绝写 `/tmp`**：本地允许的暂存目录在远端被判成工作区外，导致远端构建全部失败。现在会话范围与挂载围栏都认该主机的 `/tmp`，且只对已有挂载根的主机生效。
- **读不懂的沙箱模式在远端等于放行**：三个被认可的模式之外的任意字符串会同时跳过模式围栏与范围围栏，命令面更是按最宽模式执行。现在写入与命令一律拒绝，文案不再把它说成用户选的「仅可查看」。
- **范围拒绝的文案指向一条一定会再失败的出路**：补上「目标还须在某个已挂载工作区内，否则先挂载」。
- **「仅可查看」没能挡住远端写入**：会话切到 `read-only` 后 `write` / `edit` 仍能改写远端文件且无任何提示，而模型的系统提示要求它先试。现在按会话模式拒绝。
- **围栏外写入被报成「在 danger-full-access 下被拒，可升权重试」**：挂载围栏与停用围栏改用各自的错误码，真实原因能直达模型。
- **`ssh_workspace_transfer` 的上传不受模式约束**：`read-only` 会话能上传而同一会话的 `write` 已被拒。现在上传同样受模式门禁约束，下载不受影响。
- **命令执行完全不看模式**：`ssh_workspace_exec`、`ssh_workspace_shell` 与 `workdir` 为 `ssh://` 的 `bash` / `pwsh` 在 `read-only` 会话下照常执行（含 `rm`）。现在统一拒绝；`close` 与读取类操作不受影响。
- **终端同样不受模式约束**：`terminal_open` 与内建侧边栏终端在 `read-only` 下照常开 shell；会话在运行中被切成 `read-only` 后仍继续接受命令。现在开 PTY 与逐次写入都要判定，控制字节（SIGINT、关闭）保留例外。
- **`workspace-write` 没有收窄到会话自己的工作区**：可以写同一主机的兄弟根，也能写另一台主机的已挂载根。现在与本地一致。
- **策略解析失败被说成「用户选了仅可查看」**：文案改为说明这是接线问题、切换模式无用。
- **拒绝文案不再假装能升权**：这一族工具没有 `sandbox_permissions` 参数，改为给出「切换模式」这条真实出路。
- **在对话框里拖选文字会关掉整个流程**（[#1](https://github.com/siqyka/dsh-ssh-workspace/issues/1)）：遮罩的关闭判据改为「按下与松开都落在遮罩上」，只认主键，忙碌时拒绝关闭。

### 文档

- 补全命令执行面受模式约束的说明，并修正多处与实现相反的描述（「浏览目录」被说成已屏蔽、文件右键菜单遗漏上传与下载、路由与列表计数错误）。
- 补全错误码表（新增远端专用的 `FS_OUTSIDE_WORKSPACE`，补上 `FS_ABORTED`）。
- 两个 README 的全部仓库内链接与头图改为绝对 GitHub URL，修复 npm 页面上 12 个链接与头图失效。
- 新增 `scripts/check-doc-links.mjs`，校验文档链接、锚点与仓库内绝对 URL。

## [0.2.4] - 2026-10-18

> 0.2.3 的 tag 已推送，但该版本从未出现在 npm 上，因此 0.2.3 与 0.2.4 的全部改动都在本版首次发布。

### 修复

- **CI 在 Node 20 上崩溃**：代码用了 Node 22 才有的 `Promise.withResolvers()`，而 `engines.node` 声明 `>= 20`、CI 也按 Node 20 跑。0.2.3 因此完全没有发布出去。现在改为自带的等价实现。
- **客户端 bundle 语法错误也能全绿通过**：测试把 bundle 当文本读，一个解析不过的文件照样满足全部断言。现在增加语法解析检查。
- **向输入框拖入一个文件会生成约 22 个同样的 chip**：模块重复加载时监听器叠加。现在一次派发只消费一次。
- **空态 / 加载中 / 错误占位符失去内边距与居中**：一条样式规则被误删，已恢复。
- **`forget` 模式只清清单、不清围栏**：留下「面板里已无这一行、运行时却仍拒绝一切操作」的工作区，用户无从恢复。

### 新功能

- **端口转发持久化**：映射写入 `dsh-ssh.json`，面板可开启 / 断开 / 删除单条映射，并有「启动时自动开启隧道」总开关。已存映射强制严格端口模式，本地端口被占用就报错而非静默漂移。
- **面板列表滚动**：主机、端口转发、已挂载工作区、已停用工作区四个列表超过 5 条时改为滚动视口。
- **工作区停用 / 启用**：卸载改为可逆。默认保留工作区记录与会话（侧栏那一行仍在、置灰），可随时重新启用。
- **停用即全局停机**：停用的工作区对除 SSH 连接外的一切操作都被拒绝——读、写、列目录、变更监视、执行命令、开终端、glob / grep / git、文件传输。
- **`ssh_workspace_enable`**：新增工具与路由，重新挂载并取消归档；启用前会验证远端目录仍存在。

### 变更

- `ssh_workspace_unmount` 默认改为 `detach`（原为 `deregister`），新增 `mode` 与 `archiveSessions` 参数。
- `forget` 归一化为 `deregister`，旧拼写仍被接受。
- 「同时删除工作区记录」现在会同时清掉持久清单与运行时围栏。
- 断开主机与手动断开端口现在行为一致：映射保留、不留下任何可解释为故障的提示。
- `POST /test` 改为探测后释放连接；被端口转发钉住的连接不释放。
- `POST /hosts/disconnect` 连带拆除该主机的端口转发。

### 文档

- 新增 [docs/features.md](./docs/features.md)：按能力域列出完整功能清单，每项写清做什么、依赖什么、缺依赖时退化成什么样。
- 删除 `docs/optimization-plan.md`、`docs/roadmap.md`、`docs/_template.md` 三篇内部流程文档。

## [0.2.3] - 2026-10-17

### 新功能

- **远端 PTY 终端**：终端在 `ssh://` 工作目录上开在远端，补齐了此前唯一的能力缺口。启动的是远端自己的交互式 `sh`，不复用本机方言的命令行。
- **浏览器端下载**：文件选择对话框的每个文件行新增下载按钮，经 `GET /download` 流式取回字节并交给浏览器保存。

## [0.2.2] - 2026-10-17

### 新功能

- **端口转发恢复**：远端 dev server 映射到本机 `http://localhost:<port>`，映射随 SSH 连接存活，断开即关闭。
- **持久远端会话**：新增 `ssh_workspace_shell`，`cd`、导出的变量与后台任务跨调用保留。
- **本机 ↔ 远端传输**：新增 `ssh_workspace_transfer`，经 SFTP 双向拷贝，分块流式、不经对话内容；上传先写暂存名再 rename 发布。
- **`ssh_workspace_exec` 支持后台任务**：`run_in_background` 返回 job id，可用 `job_output` / `job_kill` 收集与终止。

### 变更

- **推送式变更监视**：远端有 `inotifywait` 时改用事件推送，变更即时上报；否则回落到自适应退避的轮询。
- **能力探测**：挂载时一次性探测 `rg` / `git` / `inotifywait`，缺失项提前给出提示。
- **每主机传输选项**：新增 `agentForward`（私钥不落到远端）与 `compress`，`~/.ssh/config` 中的对应项同样被识别。

## [0.2.1] - 2026-10-16

### 修复

- **`exec` 断连被误判为正常完成**：通道关闭时既无退出码也无信号，不再当成命令成功。
- **rename 回退误删目标**：远端不支持原子改名时，删除目标前先确认其存在，避免失败时误删无关文件。
- **`listDir` 串行 N+1 往返**：目录列举从 1+N 次降为 1 次。
- **主机存储的跨进程写入**：加入兄弟锁文件，读改写整体进入临界区。
- **`StreamTail` 重复拼接**：缓存拼接结果。

## [0.2.0] - 2026-10-14

### 新功能

- 新增 `POST /api/dsh-ssh-workspace/hosts/disconnect`：关闭指定别名的连接；仍有在途操作时返回提示而不是强行断开。主机卡片内联展示「已连接」状态。

### 变更

- HTTP 路由增至 10 条。

## [0.1.24] - 2026-10-06

### 变更

- 包名由 `@dsh-community/dsh-ssh-workspace` 改为 `@shiqyka/dsh-ssh-workspace`，以便发布到 npm。

### 安全

- 存储中的密码与私钥口令改为加密保存；`dsh-ssh.json` 不再出现明文。
- 启动时自动把老版本留下的明文凭据加密回写。
- 密钥文件缺失或被更换时，连接明确报错并提示重新保存该主机，而不是静默认证失败。

## [0.1.23] - 2026-10-01

### 修复

- 会话中 `@` 远端文件引用点击后预览报「读取失败：Maximum call stack size exceeded」：远端根下的裸路径会在路由与插件之间无限互相委派。

## [0.1.22] - 2026-10-01

### 安全

- 主机密钥 TOFU：首次连接记录指纹，之后不符即拒绝连接；新增「忘记主机密钥」入口。
- HTTP 路由增加 Host 头校验（仅接受回环地址）与 POST `Content-Type` 校验。
- 凭据存储文件与目录收紧权限，写路径接入符号链接围栏校验。

### 修复

- `exec` 输出跨块 UTF-8 解码安全，按字节截断不再切坏字符。
- `exec` 连接断开且无输出时自动重连重试一次。

### 性能

- SFTP 元数据短 TTL 缓存（仅读路径）。
- 远端变更监视自适应退避。
- `streamText` 按需启用第二条 SFTP 通道，大文件流式读取不占用共用通道。

### 工程

- 新增冒烟测试套件与运行器、GitHub Actions CI、锁文件。
- 引擎连接参数可配（空闲超时 / 连接超时 / keepalive / 回收扫描间隔）。

## [0.1.21] - 2026-10-01

### 变更

- 端口转发功能整体屏蔽，相关文档同步移除，本阶段不发布该功能。

## [0.1.20] - 2026-10-01

### 新增

- `@` 文件引用支持远端工作区：输入 `@` 即可搜索并插入远端文件路径。
- 文件进任务：侧边栏文件树支持拖拽到对话框，或右键「添加到任务」，以 `@` 引用形式插入。

## [0.1.19] - 2026-10-01

### 修复

- 0.1.18 引入的工作区向上探测崩溃（报 `not a remote workspace path: "ssh://<别名>"`）。

## [0.1.18] - 2026-10-01

### 新增

- 终端命令远程化：会话工作目录为 `ssh://` 时，命令以 POSIX shell 语义在远端执行。
- 远端文件搜索（ripgrep）与 git 变更追踪在远端执行。
- 远端变更监视（轮询式）。
- 大文件流式读取。
- 端口转发（本地监听 → 远端目标；0.1.21 起屏蔽）。

## [0.1.17] - 2026-10-01

### 新增

- 远程路径以 `@` 形式显示：`ssh://<别名>@/<路径>`（仅显示层，功能拼写不变）。

### 变更

- 发布文件脱敏：示例主机名与用户名替换为占位符；移除已废弃的第三方插件引用。

## [0.1.16] - 2026-10-01

### 修复

- 界面文案参数（如 `{ms}`）不再原样输出。
- 对话页工作区按钮标记匹配修复。
- 连接测试结果 toast 调整为顶部居中显示。

### 变更

- 远程工作区标记图标放大并按图标边界裁剪。
- 界面细节打磨：控件悬停 / 按下与焦点态、菜单与对话框入场动画（尊重 `prefers-reduced-motion`）、空 / 加载态、数字等宽排版。
