# 优化项与 Future（第三辑）

> 本页是**唯一的前瞻账本**：前两辑已合并到这里并从仓库删除，只保留仍在桌上的事、判定不做的理由、上游阻塞的现状与验证证据的缺口。

**合并说明（2026-11-08）**

- `optimization-and-future.md`（第一辑，O-01…O-16 与 F-01…F-09）与 `optimization-and-future02.md`（第二辑，O-17…O-22、C-01…C-04、F-10/F-11）已删除。它们的结论按「仍要做 / 判定不做 / 上游卡住 / 已完成」拆进本页，已完成条目只留 ID 与落点（第 5 节），不再重述论证过程。
- 同一轮删除的专题页（`unmount-modes.md`、`trigger-gates.md`、`acceptance-prompts.md`、`prompt-dead-keys-and-host-recheck.md`）也不再单独成页；它们描述的行为以代码与测试断言为准，本页不搬推理过程。
- 本页不替代 `CHANGELOG.md`：已发布版本里发生了什么，看 CHANGELOG；这里只回答「下一步还能做什么、为什么不做某件事」。

## 1. 仍未做

### 1.1 客户端 chunk 拆分（C-02；原 O-12 的“不做”已被推翻）

**状态**：通道已验证（2026-11-09）；可拆，待用户批准排期。**不要**再引用 O-12 那句“必须声明第二个 `dsh.client` 入口或引入构建步骤”——它只对了一半。

宿主 `@deepseek-ai/dsh-client-modules`（`app.asar` 内）的真实能力：

| 通道 | 位置 | 结论 |
| --- | --- | --- |
| 同步 `require` 兄弟文件 | `:833-841` 只查 seed / loadCache / factories | **不行**，同步拆仍需要构建或第二入口 |
| `require.async(spec)` | `:842-847`，相对路径转 `importChunk` | **可以**懒加载同目录 chunk |
| chunk 命名 | `:600` `CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` | `client.extra.js` 合法 |
| 注册 | `:704` 校验 `registration.chunk` | chunk 里写 `load({ id, chunk: 'client.extra.js', factory })` |
| 取用 | `:852-877` `chunkUrl(...)` + `loadBundle` | 按插件目录同名文件取，不扫描、不预构建 |

**最小验证（2026-11-09 已做，探针已回滚）**：新增只含 `load({ id, chunk: 'client.probe.js', factory })` 的 `lib/client.probe.js`（141 B / 5 行），并在主 bundle 末尾调一次 `require.async('./client.probe.js')`。实测宿主（`127.0.0.1:14419`，PID 5228）返回：

- `GET /plugins/@shiqyka/dsh-ssh-workspace/client.probe.js?rev=6b5903a36189` → **200** `text/javascript`；资源计时 `startTime=289ms`、`duration=0.8ms`，而导航 `DOMContentLoaded=47ms` / `load=537ms`——chunk 在主界面可交互之后才加载，**未阻塞首屏**；
- 页面内表达式 `window.__SSHWSP_CHUNK_PROBE__` → **`chunk-ok`**；没有 `duplicate factory registration`，也没有 `bundle … loaded without registering`；探针期间主 bundle 498,632 B / 10,013 行（含探针钩子；回滚后 498,178 B / 10,000 行），chunk 原始 141 B / 5 行（宿主组合包装后的响应体 185 B）；
- 负对照：把 chunk 改名为 `client.probe.off.js` 后仅刷新页面仍返回缓存的 200（宿主 `chunkResponse` 按精确 URL 缓存）。改为主 bundle `touch` 抬升 rev 到 `d89372bf3d03` 再刷新，得到 **404**（`transferSize=300`、`encodedBodySize=0`），探针值变成 `failed: client-modules: bundle script plugins/@shiqyka/dsh-ssh-workspace/client.probe.js?rev=d89372bf3d03 failed to load`，主界面照常渲染——失败是隔离的，不会阻塞主 bundle；
- 回滚：`git checkout -- lib/client.js`、删除 `lib/client.probe.js`，`git status` 干净。

**拆分的运维约束**：chunk 的 URL rev 来自主入口 `lib/client.js` 的文件元数据（`artifactRevision`），chunk 自己的修改**不会**改变这个 rev；宿主又按精确 URL 缓存响应。因此运行中的进程里只改 chunk 文件不会生效——要么重启，要么触碰主入口改变 rev。发布包不受影响（新进程会读新文件），但本地开发必须记住这一点。

**go/no-go**：通道 **GO**（无需构建、无需第二个 `dsh.client` 入口）；真实拆分 **NO-GO until approval**——本轮只验证通道，未动产品代码。

**拆分边界**：只拆交互后才渲染的部分（对话基座、面板分区、文件浏览器）；被多处同步引用的顶层工具函数不能拆——那会把“懒加载”变成“处处等待”。

**触发条件**：`lib/client.js` 继续增长到影响启动、内存或编辑体验时；或下一次本来就要大改界面时顺手做。

### 1.2 配置解析的统一词法层（F-10）

**状态：已收敛，原前提不成立（2026-11-09 复核）。** 现在只有一个 section 切分实现：`lib/ssh-config.js:71` 的 `sectionsOf`；`selects`（`:119`）使用同一文件的 `patternMatches`（`:104`），`Match` 判定在 `:130` 委托 `lib/match-eval.js:139` 的 `matchSelects`，后者又把 `host` / `originalhost` 的模式交回 `patternMatches`（import 在 `lib/match-eval.js:40`）。两个真实消费者读的是同一套：`lib/hosts.js:19-20` 与 `lib/config-audit.js:51` 都 import `sectionsOf` / `isExact` / `selects`，`lib/hosts.js:95`、`:143` 与 `lib/config-audit.js:235-236` 都调用它们。

逐条核对剩下的“差异”：

| 看似第二套规则 | 实际 | 是否会在同一输入上给出不同结论 |
| --- | --- | --- |
| `lib/include-chain.js:76` 的 `expandGlob` | 展开 **文件路径**（`*` / `?` / `[...]`，按路径段），且只在 `Include` 上调用 | 否：输入是文件路径，不是 Host 模式 |
| `lib/match-eval.js:84` 的 `parseMatchConditions` | 解析 `criterion value` 条件语法；host 模式仍走 `patternMatches` | 否：条件语法与模式匹配是两层，不竞争同一输入 |
| `Host` 与 `Match` 的引号 / token 化 | 两者都从 `sectionsOf` 拿同一份 `patterns`，因此内部消费者一致；`sectionsOf` 不做引号内空格合并，是**单实现相对 OpenSSH 的缺口** | 否（内部一致）；这是窄修，不是三处同步问题 |

`lib/include-chain.js:174` 的 `readConfigWithIncludes` 返回展开后的**文本**，不是第二套 section；`lib/hosts.js:45-55` 把它交给 `sectionsOf`。因此“新增一条指令必须同步改三处”没有真实样例：指令词表只在 `lib/config-audit.js` 的 `SUPPORTED_KEYWORDS` / `KNOWN_UNSUPPORTED` 维护，读取侧只有 `lib/hosts.js` 一处。

目标中的完整词法层不再立项；若将来要支持引号模式或续行，按窄修处理，不预先抽象。完整 OpenSSH 语义仍明确不做（见第 2 节）。

### 1.3 资源恢复编排（F-11）

**状态：触发未满足（2026-11-09 复核）。**

现有可恢复资源及各自的责任边界：

| 资源 | 现有实现 | 是否需要统一登记表 |
| --- | --- | --- |
| 持久端口转发 | `lib/forward-persist.js:68` 的 `SavedForwardManager`：意图与事实分离、失败原因按 id 记在 `:86` 的 Map、启动时自动开启 | 需要，但已在原处有幂等生命周期 |
| 文件 watcher | `lib/watch-recovery.js:63` 的 `watchFailureVerdict` + `:91` 的退避；断链重试、恢复后重扫由引擎接线（O-19） | 需要，但已按连接健康与重连代次判定 |
| 上传续传 | `lib/resume.js:89` 的 `planResume`、`:126` 的 `resumeRecord`：暂存文件 + sidecar，按源身份决定续不续 | 否：是传输内部状态，不跨连接恢复编排 |
| 连接本身 | `lib/reconnect.js:73` 的 `ReconnectScheduler`：按 alias 维护 entry / 退避 / 放弃态 | 否：是连接策略，不是被恢复的资源 |
| 持久 shell | `lib/shell.js:322` 的 `ShellManager`；dispose 时全部关闭 | 否：刻意不跨进程恢复（见第 2 节“承诺断线后恢复运行中命令”） |

需要统一编排的仍只有**转发与 watcher 两类**；另外三类要么是传输内部状态，要么是连接策略，要么明确不可恢复。O-19 已经把 watcher 的注册表、责任边界与跨订阅去重收口，转发也有自己的持久化。没有出现第三类真实恢复需求，因此不建 `{ type, target, generation, recover, close }` 登记表；恢复顺序“先重扫、再监听”也留在 watcher 的现有实现里。

**触发条件**：出现第三类需要跨连接恢复的资源，或现有两类需要共享同一个恢复顺序 / 代次。**明确不做**：承诺断线后远端命令继续运行（见第 2 节第 5 条）。

### 1.5 曾列为待办、现已完成（防止重复开工）

- 0.3.1 已完成本地提交、远端推送、`v0.3.1` tag 与 npm 发布；0.3.2 沿用同一条链路（提交 → `npm version` → `git push --follow-tags` → CI 发布），`origin/main` 与 npm latest 跟最新 tag 走。
- 27 个零引用 i18n 键已删除（335 → 308），包括两个边界键的配套改动；`transfer.uploadingName` / `queue.cancelling` / `queue.cancelItem` / `queue.cancelled` 未误伤。
- `scripts/reverse-verify-archive.mjs` 的 7 条漂移锚点已随源码更新，现在 **20/20 全 RED**（2026-11-08 实测，exit 0，源文件 sha256 与跑前一致）。
- P2 队列暂停/重试、P3 toast 详情/复制/重试、P4 远端新建文件夹、P5 批量删除/下载均已落地（`resolveTargets`、`enqueueDownloadsInto`；旧 `handleBatchDownload` 与 `rm -rf` 均为 0 命中）。
- 拖拽落点插入已完成：`dragover`/`drop` 从 `caretRangeFromPoint` 映射到 composer 的 detect 偏移，第一个 chip 落在指针处；视觉光标、映射退化与测试见 `docs/ui.md` 与 `tests/composer-drop-point-smoke.mjs`。
- 系统文件拖入远端「文件」树上传已完成（2026-11-11）：`osDropPlan` 用宿主 `li` 嵌套回答目标目录，`splitDroppedFolders` 只跳过文件夹、不递归，树内 capture 拦住宿主附件、树外保持宿主行为；共享 `queueTreeUploads` 入队，测试见 `tests/tree-os-drop-smoke.mjs`。
- 2026-11-09 门禁收口：`run.mjs` 增加 `partial` 第三态（`tests/support/run-state.mjs` + `run-state-smoke`），默认 71 passed / 6 skipped、装配树 74 passed / 1 partial / 2 skipped；`reverse-verify-future` 19/0；F-10 判定收敛、F-11 触发未满足（见 §1.2 / §1.3）。
- C-02 chunk 通道探针已通过并回滚（见 §1.1）；真实拆分仍待批准。

**版本约定**：未明确说“更新版本 / 发布 / 打 tag”时，不改版本号、不发布；发布前按 README 的发布检查表走（`npm run check` 必须全绿）。

## 2. 判定不做

| 方向 | 理由 | 何时可重开 |
| --- | --- | --- |
| 整体重写为 TypeScript / 引入构建 | 会打断五个运行时补丁与单入口 bundle；类型收益可以先用 JSDoc + 局部 `// @ts-check` 拿，不值得一次性翻修 | 模块拆分后补丁只剩一两处时 |
| 自实现完整 `ssh_config` 语义 | 语义面大，错误解析比不支持更危险；采用“明确子集 + 显式报告/审计” | 上游提供可依赖的解析库，或用户能接受“解析不了就拒绝”的硬失败 |
| 远端命令沙箱 | 需要远端内核能力（namespace / seccomp 等），插件无法从一条 SSH 连接里证明隔离；假装沙箱比不提供更危险 | 宿主提供 execution world 边界（见第 3 节第 4 条） |
| 盲目缓存 / 并发预取 | 没测量前加缓存只会让失效更难推理；O-22 的测量工具未校准 | 先有可复现的延迟测量，再谈缓存 |
| 承诺断线后恢复运行中命令 | 远端进程去向不可知（可能仍在跑），正确语义是“结果未知 / 可能已生效”；写类命令不重放 | 不重开；这是语义边界，不是能力缺口 |
| 容器化的发布证据（O-20） | 假 SSH 服务器只证明协议，不证明 OpenSSH/SFTP/POSIX/PTY；2026-11-07 已在真机（`qiyk`，Ubuntu 24.10 / OpenSSH 9.7p1）与 306 包装配树上建立证据，用户决定不再投入一次性容器夹具 | CI 需要可重复的真机环境时 |
| CI 差异矩阵（O-21） | 并入 O-14 关闭；CI 仍只跑 Ubuntu + Node 20 单格，避免用矩阵掩盖“本机可过”的假绿 | 出现只在特定平台复现的 bug |
| 全量性能基线（O-22） | 2026-11-07 判定不做，测量工具未校准；但 `ls` 条数上限已作为**正确性**修复独立落地（默认 500、封顶 2000、非法值 400、截断返回真实总数、码点序） | 有明确的性能回归需要判定时，单独立项 |
| 系统钥匙串凭据后端（F-04） | 2026-11-08 判定不做。现状 AES-256-GCM，密钥在 `$DSH_HOME/dsh-ssh.key`（owner-only，首次生成）；边界写清：不防整个 `$DSH_HOME` 被拷走、不保管 `keyPath` 指向的私钥或口令文件；钥匙串只换密钥位置，挡不住整目录拷贝，还多一个平台依赖 | 宿主提供统一的凭据服务时 |
| SOCKS / 动态转发（F-03） | 需求未出现；ProxyJump 多跳与反向转发已经做，SOCKS 需要另一套协议面与测试夹具 | 真实需求 + 引擎测试夹具 |

## 3. 上游阻塞

复核对象：`F:/GitHub/.test-deps/node_modules/@deepseek-ai`，相关包 `0.2.1-rc.2`（2026-11-08 逐行核对）。四条都**仍卡**。行号以该副本为准；`app.asar` 内版本可能不同步，复核时先确认版本。

| 条目 | 宿主现状 | 上游解决后本插件可退什么 |
| --- | --- | --- |
| 终端 backend 丢弃 `request.cwd` | `dsh-api-terminal-controller/lib/index.js:981` `spawn(agent, owner, request, signal)`；`:983` `const cwd = await workingDirectory.ensure(agent, signal)`；`:986-996` 把该 `cwd` 传给 `subprocess.spawnTerminal(...)`；`:1001` `info.cwd` 同值。`request.cwd` 在函数内 **0 次读取**。工具层其实已经正确下传：`dsh-tool-terminal/lib/index.js:303-307` `const cwd = await ctx.workingDirectory.ensure(owner, exec.signal)`，`cwd: args.cwd === void 0 ? cwd : resolve(cwd, args.cwd)` | `lib/patch-terminal.js:317-356` 的 cwd 补丁与 `lib/patch-projection.js:90` 的 `RELAXED_KEY`。两者现在都承重：`ssh://` cwd 能进终端全靠它们 |
| 宿主文件树没有选择/批量 API | `dsh-client-ui-sidebar-files/lib/client.js`（0.2.1-rc.2，1,025 行）：`selected` / `selection` 0 命中；`ctrlKey` / `shiftKey` / `metaKey` 0 命中（只有命令快捷键的 `modifiers`）。宿主仍输出 `data-files-entry` / `data-files-path`（`:498-499` 目录、`:522-523` 文件、`:542-543` other，`:667` 声明），本插件的装饰式桥接依赖它们 | `.sshwsp-tree-row-selected` + `aria-selected` + roving tabindex + document 捕获监听 + `selectReduce` 的手势拆分。注意：宿主已从 2,251 行缩到 1,025 行，桥接必须按当前 DOM 重新复核一遍 |
| 工具上下文没有 cwd / world / 进度通道 | `dsh-tool-cordis/lib/types/api-catalog.js:8172` `ToolExecutionInput { callId; rootCallId?; name; schema?; arguments; agent?; parent?; signal }`；`:8244` `ToolRunContext extends ToolExecution { deferContext(context: UserMessage): void; concludeTurn(): void }`。插件只能用 `exec.signal`（`lib/tools.js:1385-1387`） | F-02 的“传输进度进入工具输出”可以接宿主进度通道，而不是现在的查队列；前台工具也能显示进度，而不是只有终态 |
| execution world / 配额没有 provider seam | `dsh-api-terminal-controller/lib/index.js:969-980` `execution(agent)` 只 `agent.ctx.get` `subprocess` / `sandboxPolicy` / `workingDirectory`，没有可替换的 provider。上限仍只有每会话终端数：`:753` `maxTerminals: z.number().step(1).min(1).default(8)`、`:843` `terminal/limit-reached`；没有连接/传输配额抽象 | F-05 的“多工作区配额”可以交给宿主，插件不必自己维护计数器；远端命令沙箱也才有讨论的前提 |

## 4. 验证证据的缺口与口径

- **默认门禁**：`node tests/run.mjs`，最近一次实测 `76 passed, 6 skipped, 0 failed`（82 套件，3759 项断言）。套件数与断言数由 `scripts/doc-numbers.mjs` 生成到 `docs/development.md`，**不要手写**。
- **装配树口径**：设 `DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules` 后为 `79 passed, 1 partial, 2 skipped, 0 failed`（82 套件，4003 项断言）；`boot` 为 `partial`（已跑 30 项，内部 remote-host 段仍 SKIP），`live` / `acceptance` 仍 SKIP。默认不在门禁内的 6 个按环境套件是 `projection-real` / `lifecycle` / `boot` / `tool-schemas` / `live` / `acceptance`。
- **`run.mjs` 的跳过判定（已修）**：`tests/run.mjs:186-189` 先前只要输出里出现行首 `SKIP` 就把整套记为 skipped，没有看「跑了几项」。默认口径下 `tests/boot-smoke.mjs:32` 因 `DSH_CORE_ROOT` 未设置而打印 SKIP 并以 `0 passed` 退出，因此早先的 `76 passed / 6 skipped` 没有高估；设 `DSH_CORE_ROOT` 后 boot 真的跑 30 项（`tests/boot-smoke.mjs:198` 只是内部 remote-host 段 SKIP），旧 runner 却把整套记为 skipped。第三态 `partial` 已由 `tests/support/run-state.mjs` 与 `tests/run-state-smoke.mjs` 引入。
- **`scripts/reverse-verify-archive.mjs`**：20 个变异全部 RED（2026-11-08 实测），跑前备份、跑后逐字节还原。它是评审动作，**不进 CI**——它会改写源文件。
- **`scripts/reverse-verify-tree-drag.mjs`：17 confirmed / 0 not（2026-11-09 实测，exit 0）**：本轮三个行为各配一组变异——本地空白菜单（解析最近目录 / 根内栅栏 / 行按钮不算空白 / 展开目录的子列表算空白 / 远端根不进入 / 项目数 / 只读只禁用新建）、多选拖入（载荷退回单路径 / 只插第一项 / 行菜单退回单行 / 每项各聚焦一次 / 去掉去重 / 中途失败即中止 / 丢掉接收卡）、本地 mkdir 分支（边界改读请求 / 跳过 realpath 父目录检查 / 接受远端工作区）。同样是评审动作、不进 CI。
- **`scripts/reverse-verify-future.mjs`：19 confirmed / 0 not（2026-11-09 复跑，exit 0）**：四条漂移均已落位——
  - F-04 wildcard：破坏点改为 `lib/config-audit.js:236` 的 `selects(section, alias)` → `isExact(...)`，实测 2 红；
  - F-04 repeated：删除 `lib/config-audit.js:243` 的 `seen.has(keyword)` 守卫，实测 1 红；
  - F-07 environment assignment：`lib/audit.js:81` 与 `lib/redact.js:103` 两处同时破坏（脚本新增 `also` 多文件变异），实测 2 红；
  - F-09 login user：锚点移到 `lib/redact.js:99` 的 `maskText` 登录用户正则，实测 1 红。
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
| F-05 | 远端原生能力 | 上游阻塞（§3） |
| F-06 | 能力探测 | 已做；容器端到端随 O-20 关闭 |
| F-07 | 可审计 | 已做：审计环 + 确认策略；真隔离不做 |
| F-08 | 界面 | 已做：多选 / 菜单收窄 / 批量下载 / 新建文件夹 / 删除；终端 cwd 上游阻塞 |
| F-09 | 可观测性 | 已做；性能基线随 O-22 关闭 |
| F-10 | 配置兼容层 | 见 §1.2 |
| F-11 | 恢复编排 | 见 §1.3 |

## 相关

- [features.md](./features.md)：每个能力“做什么、怎么用、缺依赖时怎么降级”。
- [tools.md](./tools.md)：11 个 Agent 工具的参数与行为。
- [development.md](./development.md)：源码结构、测试套件与生成数字。
- [upstream-workarounds.md](./upstream-workarounds.md)：第 3 节四个补丁的退役条件与删除步骤。
- [../CHANGELOG.md](../CHANGELOG.md)：已发布版本的实际变更。
