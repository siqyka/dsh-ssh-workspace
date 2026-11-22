# 优化项与 Future（第三辑）

> 本页是**唯一的前瞻账本**：前两辑已合并到这里并从仓库删除，只保留仍在桌上的事、判定不做的理由、上游阻塞的现状与验证证据的缺口。

**合并说明（2026-11-08）**

- `optimization-and-future.md`（第一辑，O-01…O-16 与 F-01…F-09）与 `optimization-and-future02.md`（第二辑，O-17…O-22、C-01…C-04、F-10/F-11）已删除。它们的结论按「仍要做 / 判定不做 / 上游卡住 / 已完成」拆进本页，已完成条目只留 ID 与落点（第 5 节），不再重述论证过程。
- 同一轮删除的专题页（`unmount-modes.md`、`trigger-gates.md`、`acceptance-prompts.md`、`prompt-dead-keys-and-host-recheck.md`）也不再单独成页；它们描述的行为以代码与测试断言为准，本页不搬推理过程。
- 本页不替代 `CHANGELOG.md`：已发布版本里发生了什么，看 CHANGELOG；这里只回答「下一步还能做什么、为什么不做某件事」。

## 1. 仍未做

> **本节现在没有成立的工作项**：1.1 已实施、1.2 已收敛（原前提不成立）、1.3 触发条件未满足、1.5 是已完成清单；**1.4 缺号**是早期跳号，故意不补（补了会和 FF-04 撞名）。编号保持不动，因为 `O-12` / `C-02` / `F-10` / `F-11` 这些引用都指向它们；1.1 与 1.2 留在本节是因为它们记录的**宿主事实**（chunk 通道、配置词法层）仍有参考价值，不是因为还没做。

### 1.1 客户端 chunk 拆分（C-02；原 O-12 的“不做”已被推翻）

**状态**：**已实施**（2026-11-21，分支 `refactor/code-splitting`）。主包拆出五个按需 chunk：`lib/client/client.dialogs.js`、`lib/client/client.panel.js`、`lib/client/client.add-workspace.js`、`lib/client/client.transfer-queue.js`、`lib/client/client.history.js`；随后又拆出六份**启动期**chunk（`lib/client/client.locale.js`、`lib/client/client.styles.js`、`lib/client/client.icons.js`、`lib/client/client.queue.js`、`lib/client/client.selection.js`、`lib/client/client.marks.js`），由 `apply` 开头的 `await loadBootChunks()` 统一取回；最后按**层**切出第七份启动期 chunk `lib/client/client.kernel.js`（2,950 行、117 个导出），它先单独取回，其余六份才并发。**不要**再引用 O-12 那句“必须声明第二个 `dsh.client` 入口或引入构建步骤”——它只对了一半。

宿主 `@deepseek-ai/dsh-client-modules`（`app.asar` 内）的真实能力：

| 通道 | 位置 | 结论 |
| --- | --- | --- |
| 同步 `require` 兄弟文件 | `:833-841` 只查 seed / loadCache / factories | **不行**，同步拆仍需要构建或第二入口 |
| `require.async(spec)` | `:842-847`，相对路径转 `importChunk` | **可以**懒加载同目录 chunk |
| chunk 命名 | `:600` `CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` | `client.extra.js` 合法 |
| 注册 | `:704` 校验 `registration.chunk` | chunk 里写 `load({ id, chunk: 'client.extra.js', factory })` |
| 取用 | `:852-877` `chunkUrl(...)` + `loadBundle` | 按插件目录同名文件取，不扫描、不预构建 |

**最小验证（2026-11-09 已做，探针已回滚）**：新增只含 `load({ id, chunk: 'client.probe.js', factory })` 的 `lib/client/client.probe.js`（141 B / 5 行），并在主 bundle 末尾调一次 `require.async('./client.probe.js')`。实测宿主（`127.0.0.1:14419`，PID 5228）返回：

- `GET /plugins/@shiqyka/dsh-ssh-workspace/client.probe.js?rev=6b5903a36189` → **200** `text/javascript`；资源计时 `startTime=289ms`、`duration=0.8ms`，而导航 `DOMContentLoaded=47ms` / `load=537ms`——chunk 在主界面可交互之后才加载，**未阻塞首屏**；
- 页面内表达式 `window.__SSHWSP_CHUNK_PROBE__` → **`chunk-ok`**；没有 `duplicate factory registration`，也没有 `bundle … loaded without registering`；探针期间主 bundle 498,632 B / 10,013 行（含探针钩子；回滚后 498,178 B / 10,000 行），chunk 原始 141 B / 5 行（宿主组合包装后的响应体 185 B）；
- 负对照：把 chunk 改名为 `client.probe.off.js` 后仅刷新页面仍返回缓存的 200（宿主 `chunkResponse` 按精确 URL 缓存）。改为主 bundle `touch` 抬升 rev 到 `d89372bf3d03` 再刷新，得到 **404**（`transferSize=300`、`encodedBodySize=0`），探针值变成 `failed: client-modules: bundle script plugins/@shiqyka/dsh-ssh-workspace/client.probe.js?rev=d89372bf3d03 failed to load`，主界面照常渲染——失败是隔离的，不会阻塞主 bundle；
- 回滚：`git checkout -- lib/client/client.js`、删除 `lib/client/client.probe.js`，`git status` 干净。

**拆分的运维约束**：chunk 的 URL rev 来自主入口 `lib/client/client.js` 的文件元数据（`artifactRevision`），chunk 自己的修改**不会**改变这个 rev；宿主又按精确 URL 缓存响应。因此运行中的进程里只改 chunk 文件不会生效——要么重启，要么触碰主入口改变 rev。发布包不受影响（新进程会读新文件），但本地开发必须记住这一点。

**go/no-go**：通道 **GO**（无需构建、无需第二个 `dsh.client` 入口）。真实拆分已于 2026-11-21 落地。下面是**第一轮（八个 chunk）**的中途数字：八个 chunk 合计 3,967 行离开主包（12,604 → 8,290 行，−34%，500,755 → 386,314 B）——收尾到十二个 chunk 的数字在 §1.5，两者不矛盾，只是同一晚的两个时点。每个都包在 `Suspense fallback: null` 里，chunk 取不到只损失它自己。chunk 回连主包的通道（`require('<插件 id>')` 拿到主包 exports）由 `tests/client-chunk-smoke.mjs` 在真实 loader 上证明，不再靠推断。三份数据 chunk 没有 reverse 依赖，是**叶子**：它们不 destructure 主包任何名字，该套件对叶子的要求是“不需要 seam 却也没长出 seam”。

**实测收益（别再夸大）**：`new Function(...)` 编译主包，8,290 行 / 386,314 B → **2.15 ms**（全新进程，三次同值）；拆前的 9,939 行 / 500,755 B 是 2.78 ms，最初的 12,604 行是 3.60 ms。**每次页面加载省约 1.4 ms**，热进程命中 V8 编译缓存会报 **0.00 ms**，所以每次都要新进程测。注意：这不是“少下载”，懒 chunk 只在用到时才取；量级仍是毫秒，所以这条线的理由是**编辑时的阅读上下文**，不是启动时间。

**拆分边界**：只拆交互后才渲染的部分；被多处同步引用的顶层工具函数不能拆——那会把“懒加载”变成“处处等待”。实测踩到的六条：

1. **渲染期就要调用的纯函数必须留在主包**。目录选择器的 `directoryPath` / `directoryDraft` / `narrowDirectoryEntries` / `childDirectoryPath` / `usePathDraftPreview` 被面板自己的路径预览与「添加工作区」流程在 render 里调用，只能由 chunk 反向 import。
2. **失败隔离要自己给**。`React.lazy` 的 reject 抛给最近的 error boundary，而本包一个都没有；不包 `Suspense fallback: null` 的话 chunk 失败会连累整个面板。
3. **遮蔽组件不能进 chunk**。更改请求页的 `ForgeTabWithHistory` 是“渲染官方面板”的遮蔽层，它失败就等于整个标签页空白——正是遮蔽要防的事。所以移走的是它下面的页脚，不是它。
4. **apply 期安装的东西不能进 chunk**。文件树的拖拽 / 右键 / 多选桥在 `apply()` 里同步装在 `document` 上，它们的同步调用图横跨 `Transfers`、`Composer file bridge`、`Host file tree`、`File-panel header actions` 共 27 个函数——任何一个挪进 chunk，拖拽在 chunk 到达前就是坏的。同理 `flowMenuPosition` 虽然只有选择器调用，却读 `lastTriggerRect`（apply 期的 `mousedown` 监听器写的），复制进 chunk 会读到空的模块级绑定。
5. **`apply` 可以是 async，这就是数据能搬走的原因**。`cordis/lib/index.js` 的 `_execute` 里 `else if ("then" in effect) return effect.then(safeCollect)`——apply 返回 Promise 时被展开，解析出的值当 disposer 用，和返回函数一样。于是 `loadBootChunks()` 可以 `await Promise.all([localeModule(), stylesModule(), iconsModule()])`，**再做任何 slot 注册**。实测代价：主包 2.15 ms，三份 chunk 合计 0.72 ms（0.32 + 0.31 + 0.09），都在首屏注册前串行付出——换来的是主包里少 830 行字典 + 529 行 CSS + 199 行图标。反面的坑要记住：`await` 之后一切都可能还没到，本包已经因为这个坑被用户抓到四次（`schemeRules`、`fetchJson`、`BROWSE_LIST_LIMIT`、`refreshRemoteWorkspaceMarks`）。
6. **宿主无条件渲染的空洞要自己挡一层**。`directoryFlow` 由工作区选择器无条件渲染，而占用组件在关闭时返回 `null`——直接 `React.lazy` 会让页面一加载就取 427 行去渲染一个 `null`。主包留的 `FlowSlot` 先判 `open`，再挂懒组件。
7. **启动 chunk 的名字要在 `apply` 里重发布一次**。`Object.assign(exports, …)` 拷的是**值**，而它在模块求值时就执行了——那时三块数据还没取回，导出里全是 `() => null` 这类占位。chunk 只解构一次，拿到占位符就永远是占位符，画面空白且**零报错**。所以 `loadBootChunks()` 末尾必须调 `republishBootNames()` 重新拷那十二个名字。这条是末轮自己写出来的 bug，靠"真跑一次 `apply` 再渲染导出的图标"才抓到：静态 grep 看不出"值被拷早了"。

**触发条件**：`lib/client/client.js` 继续增长到影响启动、内存或编辑体验时；或下一次本来就要大改界面时顺手做。

### 1.2 配置解析的统一词法层（F-10）

**状态：已收敛，原前提不成立（2026-11-09 复核；2026-11-22 按当前行号校正）。** 现在只有一个 section 切分实现：`lib/hosts/ssh-config.js:72` 的 `sectionsOf`；`selects`（`:116`）使用同一文件的 `patternMatches`（`:103`），`Match` 判定在 `:127` 委托同一文件底部的 `matchSelects`（`:276`），后者又把 `host` / `originalhost` 的模式交回 `patternMatches`。**这两个半以前是两个文件、互相 import，是 `lib/` 里唯一的功能环；现在合成一个文件，环消失了。**两个真实消费者读的是同一套：`lib/hosts/hosts.js:55` 与 `lib/report/report.js:67` 都 import `sectionsOf` / `isExact` / `selects`，`lib/hosts/hosts.js:518` 与 `lib/report/report.js:250` 都调用它们（`report.js` 的前身是 `config-audit.js`，两者已合成一个模块）。

逐条核对剩下的“差异”：

| 看似第二套规则 | 实际 | 是否会在同一输入上给出不同结论 |
| --- | --- | --- |
| `lib/hosts/hosts.js:87` 的 `expandGlob` | 展开 **文件路径**（`*` / `?` / `[...]`，按路径段），且只在 `Include` 上调用 | 否：输入是文件路径，不是 Host 模式 |
| `lib/hosts/ssh-config.js:224` 的 `parseMatchConditions` | 解析 `criterion value` 条件语法；host 模式仍走 `patternMatches` | 否：条件语法与模式匹配是两层，不竞争同一输入 |
| `Host` 与 `Match` 的引号 / token 化 | 两者都从 `sectionsOf` 拿同一份 `patterns`，因此内部消费者一致；`sectionsOf` 不做引号内空格合并，是**单实现相对 OpenSSH 的缺口** | 否（内部一致）；这是窄修，不是三处同步问题 |

`lib/hosts/hosts.js:174` 的 `readConfigWithIncludes` 返回展开后的**文本**，不是第二套 section；`configTextOf`（`:471`）把它交给 `sectionsOf`。因此“新增一条指令必须同步改三处”没有真实样例：指令词表只在 `lib/report/report.js` 的 `SUPPORTED_KEYWORDS` / `KNOWN_UNSUPPORTED` 维护，读取侧只有 `lib/hosts/hosts.js` 一处。

目标中的完整词法层不再立项；若将来要支持引号模式或续行，按窄修处理，不预先抽象。完整 OpenSSH 语义仍明确不做（见第 2 节）。

### 1.3 资源恢复编排（F-11）

**状态：触发未满足（2026-11-09 复核，2026-11-22 按当前行号复校——结论不变）。**

现有可恢复资源及各自的责任边界：

| 资源 | 现有实现 | 是否需要统一登记表 |
| --- | --- | --- |
| 持久端口转发 | `lib/forward/forward.js` 的 `SavedForwardManager`：意图与事实分离、失败原因按 id 记在内部 Map、启动时自动开启 | 需要，但已在原处有幂等生命周期 |
| 文件 watcher | `lib/engine/reconnect.js:375` 的 `watchFailureVerdict` + `:400` 的退避；断链重试、恢复后重扫由引擎接线（O-19） | 需要，但已按连接健康与重连代次判定 |
| 上传续传 | `lib/transfer/transfer-rules.js:220` 的 `planResume`、`:252` 的 `resumeRecord`：暂存文件 + sidecar，按源身份决定续不续 | 否：是传输内部状态，不跨连接恢复编排 |
| 连接本身 | `lib/engine/reconnect.js:77` 的 `ReconnectScheduler`：按 alias 维护 entry / 退避 / 放弃态 | 否：是连接策略，不是被恢复的资源 |
| 持久 shell | `lib/surface/shell.js:326` 的 `ShellManager`；dispose 时全部关闭 | 否：刻意不跨进程恢复（见第 2 节“承诺断线后恢复运行中命令”） |

需要统一编排的仍只有**转发与 watcher 两类**；另外三类要么是传输内部状态，要么是连接策略，要么明确不可恢复。O-19 已经把 watcher 的注册表、责任边界与跨订阅去重收口，转发也有自己的持久化。没有出现第三类真实恢复需求，因此不建 `{ type, target, generation, recover, close }` 登记表；恢复顺序“先重扫、再监听”也留在 watcher 的现有实现里。

**触发条件**：出现第三类需要跨连接恢复的资源，或现有两类需要共享同一个恢复顺序 / 代次。**明确不做**：承诺断线后远端命令继续运行（见第 2 节第 5 条）。

### 1.5 曾列为待办、现已完成（防止重复开工）

- 0.3.1 已完成本地提交、远端推送、`v0.3.1` tag 与 npm 发布；0.3.2 / 0.3.3 / 0.3.4 沿用同一条链路（提交 → `npm version` → `git push --follow-tags` → CI 发布），`origin/main` 与 npm latest 跟最新 tag 走。
- 27 个零引用 i18n 键已删除（335 → 308），包括两个边界键的配套改动；`transfer.uploadingName` / `queue.cancelling` / `queue.cancelItem` / `queue.cancelled` 未误伤。
- `scripts/reverse-verify-archive.mjs` 的 7 条漂移锚点已随源码更新，现在 **20/20 全 RED**（2026-11-08 实测，exit 0，源文件 sha256 与跑前一致）。
- P2 队列暂停/重试、P3 toast 详情/复制/重试、P4 远端新建文件夹、P5 批量删除/下载均已落地（`resolveTargets`、`enqueueDownloadsInto`；旧 `handleBatchDownload` 与 `rm -rf` 均为 0 命中）。
- 拖拽落点插入已完成：`dragover`/`drop` 从 `caretRangeFromPoint` 映射到 composer 的 detect 偏移，第一个 chip 落在指针处；视觉光标、映射退化与测试见 `docs/ui.md` 与 `tests/composer-drop-point-smoke.mjs`。
- 系统文件拖入远端「文件」树上传已完成（2026-11-11）：`osDropPlan` 用宿主 `li` 嵌套回答目标目录，`splitDroppedFolders` 只跳过文件夹、不递归，树内 capture 拦住宿主附件、树外保持宿主行为；共享 `queueTreeUploads` 入队，测试见 `tests/tree-os-drop-smoke.mjs`。
- 2026-11-09 门禁收口：`run.mjs` 增加 `partial` 第三态（`tests/support/run-state.mjs` + `run-state-smoke`），默认 71 passed / 6 skipped、装配树 74 passed / 1 partial / 2 skipped；`reverse-verify-future` 19/0；F-10 判定收敛、F-11 触发未满足（见 §1.2 / §1.3）。
- 本机路径直通（`localPassthrough`，issue #4）已落地（2026-11-13）：`lib/fs/passthrough.js` 做词法前缀匹配（默认 `$DSH_HOME/attachments` / `plugins`），`ctx.fs.resolve` / `lstat` 与 `node:path.resolve` 在远端分类前直通本机；剥离 cwd 防递归，未命中路径仍远端，不做 `stat`，写围栏不变；测试见 `tests/local-passthrough-smoke.mjs`。
- 显式本机 scheme 与「`@` 裸 POSIX 远端优先、miss 回退本机」已落地（2026-11-14，随 0.3.4 发布）：scheme 名与回退开关只存 `passthrough.settings` 一处，解析 / `fs-shim` 折叠 / `@` 提取三缝读同一个值；回退只覆盖点名路径与读动词。规则（≥ 3 字符、保留名表、两个大小写字段）由 `/status.passthrough.schemeRules` 下发，客户端不留第二份。测试见 `tests/local-passthrough-smoke.mjs`（231 项）与 `scripts/reverse-verify-passthrough.mjs`（43 条变异）。
- C-02 chunk 通道探针已通过并回滚（见 §1.1）；真实拆分已于 2026-11-21 落地成十二个 chunk：五个按需（`lib/client/client.dialogs.js`、`lib/client/client.panel.js`、`lib/client/client.add-workspace.js`、`lib/client/client.transfer-queue.js`、`lib/client/client.history.js`），七个启动期由 `apply` 的 `await loadBootChunks()` 取回（`lib/client/client.kernel.js` 先单独取，然后 `lib/client/client.locale.js`、`lib/client/client.styles.js`、`lib/client/client.icons.js`、`lib/client/client.queue.js`、`lib/client/client.selection.js`、`lib/client/client.marks.js` 并发）。主包 12,604 → 4,343 行（−66%），500,755 → 197,647 B（**拆分收尾时**的数字；此后主包继续变化，现在 4,330 行，目录里还多了后来拆出的 `client.editor.js` / `client.editor-engine.js`——想知道准数就 `ls lib/client/*.js` 与 `wc -l lib/client/client.js`，别信本页的绝对值）。

**版本约定**：未明确说“更新版本 / 发布 / 打 tag”时，不改版本号、不发布；发布前按 README 的发布检查表走（`npm run check` 必须全绿）。

## 2. 判定不做

| 方向 | 理由 | 何时可重开 |
| --- | --- | --- |
| 整体重写为 TypeScript / 引入构建 | 会打断七个运行时补丁（`lib/patch/patch-*.js`）与单入口 bundle；类型收益可以先用 JSDoc + 局部 `// @ts-check` 拿，不值得一次性翻修 | 模块拆分后补丁只剩一两处时 |
| 自实现完整 `ssh_config` 语义 | 语义面大，错误解析比不支持更危险；采用“明确子集 + 显式报告/审计” | 上游提供可依赖的解析库，或用户能接受“解析不了就拒绝”的硬失败 |
| 远端命令沙箱 | 需要远端内核能力（namespace / seccomp 等），插件无法从一条 SSH 连接里证明隔离；假装沙箱比不提供更危险 | 宿主提供 execution world 边界（见第 3 节第 4 条） |
| 盲目缓存 / 并发预取 | 没测量前加缓存只会让失效更难推理；O-22 的测量工具未校准 | 先有可复现的延迟测量，再谈缓存 |
| 承诺断线后恢复运行中命令 | 远端进程去向不可知（可能仍在跑），正确语义是“结果未知 / 可能已生效”；写类命令不重放 | 不重开；这是语义边界，不是能力缺口 |
| 容器化的发布证据（O-20） | 假 SSH 服务器只证明协议，不证明 OpenSSH/SFTP/POSIX/PTY；2026-11-07 已在真机（`qiyk`，Ubuntu 24.10 / OpenSSH 9.7p1）与 306 包装配树上建立证据，用户决定不再投入一次性容器夹具 | CI 需要可重复的真机环境时 |
| CI 差异矩阵（O-21） | 并入 O-14 关闭；CI 仍只跑 Ubuntu + Node 20 单格，避免用矩阵掩盖“本机可过”的假绿 | 出现只在特定平台复现的 bug |
| 全量性能基线（O-22） | 2026-11-07 判定不做，测量工具未校准；但 `ls` 条数上限已作为**正确性**修复独立落地（默认 500、封顶 2000、非法值 400、截断返回真实总数、码点序） | 有明确的性能回归需要判定时，单独立项 |
| 系统钥匙串凭据后端（F-04） | 2026-11-08 判定不做。现状 AES-256-GCM，密钥在 `$DSH_HOME/dsh-ssh.key`（owner-only，首次生成）；边界写清：不防整个 `$DSH_HOME` 被拷走、不保管 `keyPath` 指向的私钥或口令文件；钥匙串只换密钥位置，挡不住整目录拷贝，还多一个平台依赖 | 宿主提供统一的凭据服务时 |
| SOCKS / 动态转发（F-03） | 需求未出现；ProxyJump 多跳与反向转发已经做，SOCKS 需要另一套协议面与测试夹具 | 真实需求 + 引擎测试夹具 |
| 照抄「无围栏的 fs 写路由」 | 第三方 side-bar 类实现自 v0.23.0 起明确不做 workspace 包含检查，并在自己的 README 里把「能读写宿主用户可达的任何路径」列为已知限制。本插件的三道写围栏（workspace root / 会话 workspace / sandbox mode）是被 `tests/text-routes-smoke.mjs` 与 `tests/routes-smoke.mjs` 的越界用例钉住的边界：**任何「为了让某个操作能做而放宽围栏」的方案都不接受**。远端多一道：SFTP 上的逐项 `stat` 是 N 次往返而不是「顺手并发」，所以列表只消费 `readdir` 自带的条目属性（见 `docs/architecture.md` 的 `listDir` 一节） | 不重开 |

## 3. 上游阻塞

复核对象：**从 `E:/software/DSH/resources/app.asar` 里解出的 `0.2.2-rc.5`**（2026-11-22 逐行核对；解包副本 `F:/GitHub/.asar-rc5/dsh/node_modules/@deepseek-ai`）。注意两条旧解包 —— `F:/GitHub/.test-deps` 与 `F:/GitHub/.asar-full` —— 都还停在 `0.2.1-rc.2`，**别再拿它们复核**：rc.5 的 asar 表里 `@deepseek-ai` 有 338 个包目录（旧解包只有 306 个），`dsh-api-terminal-controller` 从 1,025 行重写成 1,601 行，并把原来的 `spawn` 拆成 `userLaunch` / `agentLaunch` / `spawn` 三段。复核方式是直接解析 `app.asar` 的头部表取文件，不依赖任何旧解包。

五条的判决：**4 条仍卡，1 条松了一半**（终端 cwd 现在对 Agent 终端生效）。另外 rc.5 新给了两个可以退役本插件补丁的接缝，外加一组可复用的客户端能力，见 §3.1。

| 条目 | 宿主现状（0.2.2-rc.5） | 上游解决后本插件可退什么 |
| --- | --- | --- |
| 终端 backend 丢弃 `request.cwd`（**Agent 终端已修，用户终端未修**） | `dsh-api-terminal-controller/lib/index.js:1213` `openForAgent(agent, request, signal)` → `:1449 agentLaunch(...)`，其中 `:1451 const cwd = await workingDirectory.ensure(agent, signal)` 已变成 `const cwd = request.cwd ?? await workingDirectory.ensure(agent, signal)`；`AgentTerminalRequest` 现在带可选 `cwd` 与 `preferredShells`（类型声明 `lib/typert.host.js:806`）。工具层一直正确下传：`dsh-tool-terminal/lib/index.js:303-307` `const cwd = await ctx.workingDirectory.ensure(owner, exec.signal)`、`cwd: args.cwd === void 0 ? cwd : resolve(cwd, args.cwd)`。**没变的**：用户终端 `:1427 userLaunch` 仍只 `:1429 workingDirectory.ensure(...)`；`environment()` `:1147-1155` 仍读 `workingDirectory.get` | 只能退**一半**：`request.cwd` 让「宿主别把自己的 cwd 强加给我」变成公开契约。但只要工具仍先调 `ensure()`（`:303`），`lib/patch/patch-projection.js:90` 的 `RELAXED_KEY` 就还是承重的；`lib/patch/patch-terminal.js:317-356` 的 cwd 重写也仍需要——宿主只保证「用哪个 cwd」，不保证「这个 cwd 在远端跑得起来」 |
| 宿主文件树没有选择/批量 API | `dsh-client-ui-sidebar-files/lib/client.js` 在 rc.5 是**单行压缩包**（2 行）：`selected` / `selection` / `multiSelect` **0 命中**；`ctrlKey` / `shiftKey` / `metaKey` 各 2 命中，但两处都是「带修饰键就直接 return」的拒绝守卫（Escape 关面板、上下键沿行移动），不是多选手势。宿主仍输出 `data-files-entry`（3 处）/ `data-files-path`（5 处）/ `data-files-search`（9 处）/ `data-files-navigator-toggle`（1 处），装饰式桥接可以继续挂在这些属性上 | `.sshwsp-tree-row-selected` + `aria-selected` + roving tabindex + document 捕获监听 + `selectReduce` 的手势拆分。宿主迭代到压缩单行之后，桥接必须按**当前 DOM** 复核，不能信行号 |
| 工具上下文没有 cwd / world / 进度通道 | `dsh-tool-cordis/lib/types/api-catalog.js:10086` `ToolExecutionInput { callId; rootCallId?; name; schema?; arguments; agent?; toolSet?; parent?; signal }`、`:10078` `ToolExecution`、`:10067` `ToolDefinition.execute(args, exec: ToolRunContext)`：**仍然没有进度通道**（`dsh-tool-cordis/lib/types/` 里 `reportProgress` / `onProgress` / `progress(` 0 命中）。rc.5 新增的 `dsh-tool-executor-native` / `dsh-tool-executor-ptc` 是**工具执行器**的登记面，不是给工具上报进度的通道。插件只能用 `exec.signal`（`lib/surface/tools.js:1385-1387`） | F-02 的「传输进度进入工具输出」仍只能查自己的队列；前台工具仍只能显示终态 |
| execution world / 配额没有 provider seam | `:1543 execution(agent)` 仍是三个 `agent.ctx.get`（`subprocess` / `sandboxPolicy` / `workingDirectory`）直接返回，没有可替换的 provider；`shells()` `:1164` 内部仍走 `subprocess.resolveExecutable`（`dsh-subprocess-local/lib/index.js:1537`）与 `terminalEnvironment`（`:1623`），这两个方法同样没有 seam，插座只包了 `spawn` 与 `spawnTerminal`。配额只多了**每会话 Agent 终端数**：`:1113 maxAgentTerminals: z.number().step(1).min(1).default(4)`；连接 / 传输配额抽象仍然没有 | F-05 的「多工作区配额」仍得自己维护计数器。但 rc.5 的 `preferredShells` 让远端 shell 发现有机会退成「只接管 `shells()`」，见 §3.1 |
| 远端会话的归属记账会因为本机解析不了 cwd 而被真删 | 机制**一字未改**，只是行号漂移：`:363 invalidSessionPaths`、`:367 candidateMatches: (id, path) => this.sessionPaths.get(id) === path \|\| this.missingSessionPaths.has(id)`（**不含** `invalidSessionPaths`）；`indexHeader()`（`:881`）在本机 `stat` 失败时 `:892` 只写 `invalidSessionPaths.set(header.id, "cwd '…' is not a directory")`；`mutate()`（`:173`）的 `:178 sessionIds.filter((id) => this.host.candidateMatches(id, changed.path))` 照样把「解析不了」的旧会话写没；`bootstrap()`（`:764`）仍只在注册表从未初始化时跑 | `lib/surface/ownership.js` 的启动补偿，以及 `engine.ownership` 快照 / `workspace-ownership` finding / `KINDS.ownership` 事件这一整条可观测链。上游做到任一半即可退役：① `mutate()` 不因 cwd 本机解析不了而删账；② `indexHeader()` 对「字符串与某个已登记工作区 path 完全相等」的 cwd 直接认作成员（URI 语义），不必先过 `realpath` |

### 3.1 rc.5 新给的接缝与可复用能力（均尚未利用）

- **`working-directory/access` 事件**：`dsh-working-directory/lib/index.js:111`（`ensure`）与 `:143`（`set`）都先走 `ctx.waterfall("working-directory/access", { agent, path: string | null, signal }, next)`。监听器**可以直接返回一个字符串替换解析结果**，跳过 `ctx.fs.resolve` / `ctx.fs.stat`、"目录不存在就回退原目录"那一整段。宿主自己的 `dsh-experimental-worktree/lib/index.js:36-46` 就是这么用的（对正在删除的 worktree 加独占锁）。
  **它不能退役 `patch-projection`**：那个补丁修的是 projection **schema**（`dsh-working-directory/lib/index.js:51` `const directorySchema = z.string().min(1).refine(isAbsolute).nullable()`——rc.5 仍把谓词当**值**捕获，所以 UPSTREAM-1 的缺陷原样存在，补丁自己也还在判定是否该退役），而这个接缝包住的是 `ensure` / `set` 的**文件系统访问**，两者不在同一层。
  它真正的用处有三个：① `ssh://` 时直接返回，跳过本机 `ctx.fs.resolve` + `ctx.fs.stat`（每次开终端、每次工具调用 `ensure` 都少一次经 SFTP 的 stat）；② 远端目录确实不存在时给出我们自己的错误，而不是让宿主走"回退到原始目录 + 提交一次 cwd 变更 + 注入 notice"（对远端工作区这条副作用很意外）；③ `set()`（cd 工具）同样过这个钩子。属**加固 + 省一次往返**，不是删补丁。
- **`preferredShells`**：`dsh-api-terminal-controller/lib/index.js:1512 agentShell(agent, preferred, signal)` 按**家族名**在 `this.shells()` 里找，找到就直接用它的 `path` + `args` 起进程（`:1452`），不再回落 `sh -l`；`preferred` 来自 `dsh-terminal-panel` 的配置（`lib/index.js:439`，`:468` 默认 `[]`）。→ 远端 shell 发现可以退成「只接管 `shells()`，让宿主自己挑家族」，把 `lib/patch/patch-terminal.js` 里启动侧的查表删掉。**条件**：`dsh-terminal-panel.preferredShells` 配成非空（默认空表，且这是宿主配置，不是插件能改的），所以现在还不能退。
- 另外 rc.5 新增了 `dsh-client-ui-context-menu`（插件可注册的类型化右键菜单）、`dsh-client-ui-file-actions`（原件保存 / 图片剪贴板）、`dsh-client-ui-file-drag`（应用内文件拖拽传输）。行菜单的定位与焦点收口、拖拽载荷有朝一日可以从自己实现改成注册进宿主；**前提是先核对宿主注册面是否接受「远端条目」这种不对应本机真实路径的条目**，没核对完不要先删。


## 4. 验证证据的缺口与口径

- **默认门禁**：`node tests/run.mjs`。套件数、断言数、模块数、路由数、工具数、补丁数一律由 `scripts/doc-numbers.mjs` 生成到 `docs/development.md`，**不要手写**；本页不再重复这些会漂移的绝对值（曾经写死在这里，两个月后全错）。跑动的 `passed / partial / skipped` 随环境变化，以那一次运行的最后一行汇总为准。
- **装配树口径**：设 `DSH_CORE_ROOT=<某个宿主 node_modules>` 后多跑 `boot` / `projection-real` 等需要宿主包的套件；不设时它们是 SKIP。**注意版本**：`F:/GitHub/.asar-full` 与 `F:/GitHub/.test-deps` 都是 `0.2.1-rc.2`，而线上宿主已经是 `0.2.2-rc.5`（见第 3 节）——拿旧树当 `DSH_CORE_ROOT` 只能证明「插件对着旧宿主还能装配」，不能证明对当前宿主成立。要从 `app.asar` 解出当前版本再跑：`F:/GitHub/.asar-rc5/dsh/node_modules`。
- **2026-11-22 第一次对着 `0.2.2-rc.5` 装配**：`boot-smoke` **30/30**（插件能装上、11 个工具全注册、`teardown` 把标记与原型方法都还原干净）——说明这七个补丁的目标面（`ctx.fs` 的一整套方法、`ctx.sandbox.confine`、`ctx.shell.execute`、`ctx.subprocess.spawn` + `spawnTerminal`、`ctx.ptcRuntime.resolve`、客户端 `ctx.slots`、`terminalController.shells`）在 rc.5 上仍然都在。整套 `run.mjs` 当天的计数**不要引用**：工作树里还压着另一路未提交的编辑引擎改动，`tests/ssh-config-smoke.mjs` / `tests/archive-smoke.mjs` 在跑的过程中就被改写了（同一批套件在 rc.5 与 rc.2 下报同一个错，根因是临时目录与重复 import，不是宿主升级）。要拿门禁数字，先等那一路落地。
- **`run.mjs` 的跳过判定（已修）**：`tests/run.mjs:186-189` 先前只要输出里出现行首 `SKIP` 就把整套记为 skipped，没有看「跑了几项」。默认口径下 `tests/boot-smoke.mjs:32` 因 `DSH_CORE_ROOT` 未设置而打印 SKIP 并以 `0 passed` 退出，因此早先的 `76 passed / 6 skipped` 没有高估；设 `DSH_CORE_ROOT` 后 boot 真的跑 30 项（`tests/boot-smoke.mjs:198` 只是内部 remote-host 段 SKIP），旧 runner 却把整套记为 skipped。第三态 `partial` 已由 `tests/support/run-state.mjs` 与 `tests/run-state-smoke.mjs` 引入。
- **`scripts/reverse-verify-archive.mjs`**：20 个变异全部 RED（2026-11-08 实测），跑前备份、跑后逐字节还原。它是评审动作，**不进 CI**——它会改写源文件。
- **`scripts/reverse-verify-tree-drag.mjs`：17 confirmed / 0 not（2026-11-09 实测，exit 0）**：本轮三个行为各配一组变异——本地空白菜单（解析最近目录 / 根内栅栏 / 行按钮不算空白 / 展开目录的子列表算空白 / 远端根不进入 / 项目数 / 只读只禁用新建）、多选拖入（载荷退回单路径 / 只插第一项 / 行菜单退回单行 / 每项各聚焦一次 / 去掉去重 / 中途失败即中止 / 丢掉接收卡）、本地 mkdir 分支（边界改读请求 / 跳过 realpath 父目录检查 / 接受远端工作区）。同样是评审动作、不进 CI。
- **`scripts/reverse-verify-passthrough.mjs`：20 confirmed / 0 not（2026-11-13 实测，exit 0）**：本机路径直通的 20 个变异，覆盖三段——matcher 段（默认前缀丢掉 attachments / 未知变量被展开 / 前缀匹配忽略分量边界 / 整 `$DSH_HOME` 被接受 / 非 win32 也认盘符 / 非盘符拼写进引用表 / 引用表不设上限 / 命中不了自己 / 引号形式不提取 / 提取放过 POSIX 绝对路径）、路由段（剥 cwd 改成原样透传 / 不再认直通拼写 / `path.resolve` 无视 matcher / `path.relative` 不再原样返回 / 热重载留旧 matcher / 安装点漏传 matcher / 内建桥漏传 matcher）、接线段（监听器把事件当消息 / 恢复的会话不再重扫 / 提示词丢掉边界段）。修变异时还发现并补了四处测试空洞：POSIX 拼写即使平台是 win32 也不能进引用表、提示词必须写明「只覆盖经过 ctx.fs」、消息提取器的 role / block 判定要真跑一遍、监听器必须把 `event.data` 而不是 `event` 交给提取器。**同样不进 CI**——它会改写源文件。
- **`scripts/reverse-verify-future.mjs`：19 confirmed / 0 not（2026-11-09 复跑，exit 0）**：四条漂移均已落位——
  - F-04 wildcard：破坏点改为 `lib/report/report.js:256` 的 `selects(section, alias)` → `isExact(...)`，实测 2 红；
  - F-04 repeated：删除 `lib/report/report.js:263` 的 `seen.has(keyword)` 守卫，实测 1 红；
  - F-07 environment assignment：`lib/engine/engine.js:2004` 与 `lib/core/diagnostics.js` 的 `maskText` 两处同时破坏（脚本新增 `also` 多文件变异），实测 2 红；
  - F-09 login user：锚点移到 `lib/core/diagnostics.js` 里 `maskText` 的登录用户正则，实测 1 红。
  脚本现在对每个已写文件逐字节还原并按相反顺序收尾；跑后 `git status --short lib` 为空。
- **判断标准**：反向验证的 `expect` 是“必须变红的断言数”；少于它说明套件没有钉住行为，多于它说明变异破坏了别的东西，数字不再是证据。`expect: 0` 的变异允许以**崩溃**记数（`F-06` 那条就是这样：套件解引用它期望的环境），但这只证明“行为变了”，不能证明是哪条断言抓住的——复跑时仍要看崩溃点。

## 5. 已完成条目索引

代码注释里引用 `O-xx` / `F-xx` / `C-xx` 时先查这里；需要细节时看 CHANGELOG 与对应测试。

| ID | 主题 | 结论 / 落点 |
| --- | --- | --- |
| O-01 | 失败重放语义 | 已修：写类不重放，结果报“未知” |
| O-02 | watcher 降级句柄 | 已修：单一 live 句柄 |
| O-03 | 原始字节上传 CSRF | 已修：媒体类型门（415） |
| O-04 | 真机套件失效 | 已修：scratch 目录校验 + acceptance 参数 |
| O-05 | 前台/后台恢复时序 | 已修：`onRestored` 只在成功路径 |
| O-06 | shell 超时串输出 | 已修：屏障 + generation |
| O-07 | 暂存名与背压 | 已修：随机名 + drain/error 竞速 |
| O-08 | 首钥落盘失败 | 已修：degraded 诊断 + `unpinnedHostKeys` |
| O-09 | SFTP 重复打开 | 已修：single-flight（Promise 缓存 + `streamOpening`） |
| O-10 | 空列表与静默降级 | 已修：listing 三态 |
| O-11 | 可访问性 | 已修：`useDialogA11y` + `useMenuKeyboard`；C-01 补齐第四对话框与行 |
| O-12 | 客户端单文件拆分 | 见 C-02 / §1.1：“不可拆”的结论已推翻 |
| O-13 | 诊断形状 | 已修：`seq` / `SCHEMA_VERSION` / `exportText` 脱敏 |
| O-14 | 测试真实性 | 已关闭：假 SSH 服务器 + 三态汇总；CI 矩阵判定不做 |
| O-15 | 上游契约测试 | 已修：`upstream-contract.js` |
| O-16 | 文档数字可生成 | 已修：`scripts/doc-numbers.mjs` |
| O-17 | `Match` 是否终止 `Host` | 已修 |
| O-18 | 通配块里的身份字段 | 已修：LOST 报告 |
| O-19 | watcher 恢复闭环 | 已闭环：注册表 + 跨订阅去重 + 真 socket 断链 |
| O-20 | 容器化发布证据 | 判定不做；真机证据已建立（§2） |
| O-21 | CI 差异矩阵 | 并入 O-14 关闭 |
| O-22 | 性能基线 | 判定不做；`ls` 上限作为正确性修复独立落地 |
| C-01 | O-11 只闭合 2/3 | 已修 |
| C-02 | chunk 拆分的前提 | 见 §1.1 |
| C-03 | 脱敏漏点 | 已修 |
| C-04 | F-04 凭据后端 | 判定不做（§2） |
| F-01 | 断线后的语义 | 已做：分代 + watcher 重建 + 起始目录；环境恢复判为伪需求 |
| F-02 | 传输可靠性 | 已做：校验 / 冲突 / 续传 / 目录 zip / 排除 / 队列 / 暂停恢复重试；剩并发测量与工具进度（§3） |
| F-03 | 拓扑 | 已做：ProxyJump 多跳 + 反向转发；SOCKS 不做 |
| F-04 | 主机配置管理 | 已做：审计 / Include / Match / 标签 / 最近使用；凭据后端不做 |
| F-05 | 远端原生能力 | 上游阻塞（§3）。0.2.2-rc.5 起 `AgentTerminalRequest.preferredShells` 让宿主自己按家族挑 shell（§3.1），但它的默认值是空表，所以现在仍靠 own-property 接管 `shells()` |
| F-06 | 能力探测 | 已做；容器端到端随 O-20 关闭 |
| F-07 | 可审计 | 已做：审计环 + 确认策略；真隔离不做 |
| F-08 | 界面 | 已做：多选 / 菜单收窄 / 批量下载 / 新建文件夹 / 删除；终端 cwd：Agent 终端宿主已认 `request.cwd`（§3），用户终端仍不认；**缺新建文件**（方案见 `docs/FF/07-new-file-prompt.md`，未实施） |
| F-09 | 可观测性 | 已做；性能基线随 O-22 关闭 |
| F-10 | 配置兼容层 | 见 §1.2 |
| F-11 | 恢复编排 | 见 §1.3 |

## 相关

- [features.md](./features.md)：每个能力“做什么、怎么用、缺依赖时怎么降级”。
- [tools.md](./tools.md)：11 个 Agent 工具的参数与行为。
- [development.md](./development.md)：源码结构、测试套件与生成数字。
- [upstream-workarounds.md](./upstream-workarounds.md)：单条上游补丁的登记模板、上游修法与删除步骤；本页第 3 节写的是五条阻塞**各自**的退役条件。
- [../CHANGELOG.md](../CHANGELOG.md)：已发布版本的实际变更。
