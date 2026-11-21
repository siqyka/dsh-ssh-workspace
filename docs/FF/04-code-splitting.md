# FF-04 代码拆分：把五个「改一处要读半个文件」的地方拆开

> 状态：**已实施**（2026-11-21，分支 `refactor/code-splitting`）。实施记录与实测结论见 `docs/optimization-and-future03.md` §1.1 与 `CHANGELOG.md` 未发布段。
> 任务书见 [04-code-splitting-prompt.md](./04-code-splitting-prompt.md)
> 本辑回答：**哪些文件真的该拆、拆成什么样、每步怎么证明没拆坏**。
> 不做 GitHub issue（用户选择只落仓库文档）；技能模板的六节内容按本页的
> 「现状 / 方案 / 提交计划 / 决策 / 测试决策 / 不做什么」承载。

## 0. 一句话目标

把仓库里五个「单点过大」的位置拆成可独立阅读的模块，**行为、错误码、HTTP 状态码、
工具输出 schema、`ssh://` 围栏语义一律不变**；每拆一步都留下可机械验证的边界，
而不是靠人记住哪块该在哪。

## 1. 现状（全部为本轮实测数字）

| 位置 | 规模 | 结构 |
| --- | --- | --- |
| `lib/client.js` | **12,603 行 / 627,867 B** | 单 `window.__ModuleLoader__.load({id, factory})`；22 个 banner 段 |
| `lib/routes.js` | **3,765 行** | `makeRoutes`（`lib/routes.js:911`）单函数 **1,856 行**；33 条路由，全部 `kind: 'exact'` |
| `lib/tools.js` | 2,250 行 | `statusTool`（`lib/tools.js:850`）**606 行**；其余 10 个工具 92–186 行 |
| `lib/remote-fs.js` | 2,597 行 | `RemoteFileSystem` 类体 1,517 行，其中方法体合计 **976 行** |
| `lib/index.js` | 855 行 | `apply`（`lib/index.js:269`）**584 行**，占全文件 68% |
| `lib/patch-subprocess.js` | 1,298 行 | `RemoteSubprocessRouter.spawn`（`:998`）**237 行** |

`client.js` 的 22 段实测行数：

| 行范围 | 行数 | 段 |
| --- | --- | --- |
| 13–68 | 56 | Map of this file |
| 69–141 | 73 | API client |
| 142–971 | 830 | Locale |
| 972–1500 | 529 | CSS |
| 1501–1699 | 199 | SVG Icons |
| 1700–2164 | 465 | Host card |
| 2165–2314 | 150 | Host editor dialog |
| 2315–2777 | 463 | Directory browser dialog |
| 2778–2863 | 86 | Diagnostic report dialog |
| 2864–4451 | **1,588** | Main panel |
| 4452–5017 | 566 | Add-workspace flow |
| 5018–5024 | 7 | Panel icon |
| 5025–5033 | 9 | Panel page wrapper |
| 5034–5480 | 447 | Remote-workspace marks |
| 5481–6658 | **1,178** | Composer file bridge |
| 6659–8440 | **1,782** | Transfer queue |
| 8441–10071 | **1,631** | Transfers from DSH's own file tree |
| 10072–10986 | 915 | File-panel header actions |
| 10987–11637 | 651 | Host file tree multi-select |
| 11638–12225 | 588 | Change-request tab |
| 12226–12426 | 201 | Session list catch-up |
| 12427–12604 | 178 | Plugin apply |

### 1.1 已确认的硬约束（不要重新推导）

1. **`client.js` 只能有一个 `dsh.client` 入口。** `package.json` 的 `dsh.client.inject`
   已经声明了五个宿主包；宿主按 `exports['./client']` 取主 bundle，`clientPath` 的
   `dirname` 就是 chunk 的查找目录（`dsh-client-modules/lib/index.js:955`）。
2. **chunk 通道可用，且有宿主先例。** `require.async('./client.x.js')`
   （`dsh-client-modules/lib/client.js:839-845`）→ `importChunk`（`:849-874`）；
   chunk 文件里写 `load({ id: '<本插件 id>', chunk: 'client.x.js', factory })`
   （`:699-711`）。宿主自己就在用：`dsh-client-ui-sidebar-terminal` 有
   `lib/client.terminal.js`（13,517 行）由 `React.lazy` + `Suspense` 懒加载；
   `dsh-client-ui-sidebar-documentpreview` 有 `client.pdf.js` / `client.excel.js` /
   `client.frontmatter-fields.js` 三个 chunk。
3. **chunk 文件名受正则约束**：`CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`
   （`dsh-client-modules/lib/index.js:170`），且 `client.node.js` / `client.node.*` 被明确拒绝
   （`:940`）。chunk **必须与 `client.js` 同目录**（即 `lib/`），不能放子目录。
4. **chunk 的 URL rev 来自主入口的文件元数据**，改 chunk 本身不抬 rev；宿主按精确 URL
   缓存（`docs/optimization-and-future03.md` §1.1 已实测）。本地开发改 chunk 要么重启，
   要么触碰 `lib/client.js`。
5. **chunk 可以同步 `require` 本插件自己的 id**：`require('<plugin-id>')` 经
   `stripClientSuffix` 后命中 `factories`，走 `materialize(id)`（`client.js:836`）。
   这是 chunk 共享主 bundle 内核的**唯一**通道。**已实测成立**（E2：真机 + 
   `tests/client-chunk-smoke.mjs` 用真实 loader 在 `node:vm` 里验证，identity-equal）。
6. **chunk 之间不能互相 `require` 兄弟文件**：`client.js:833-841` 只查 seed /
   loadCache / factories，相对路径的同步 require 必然抛错。chunk 之间只经主 bundle 或 props 通信。
7. **`makeRoutes` 的 33 条路由全部是 `kind: 'exact'`**，handler 是闭包，捕获
   `guard` / `guardRaw` / `engine` / `router` / `ctx` / 各模块级 helper。
8. **测试对 bundle 是按文本切片耦合的**：`tests/` 下 **28 个套件**、**29 处**
   `readFileSync(... 'client.js')`，再按 `indexOf('function X (')` + 大括号配平切片
   （公共实现是 `tests/support/render.mjs:68` 的 `componentSource`）。拆文件会同时动到它们。
   已由 `tests/support/client-source.mjs`（E1）收敛为一个 resolver。
9. **`scripts/doc-numbers.mjs` 按路径写死**：`countRoutes` 只读 `lib/routes.js`
   （`:129`），`countTools` 只读 `lib/tools.js`（`:130`），`countModules` 只数
   `lib/*.js`（`:119`）。拆分会让这三个数字失真，**必须在搬代码之前先改计数器**。
10. **`lib/` 下新建子目录对现有扫描是透明的**：`upstream-contract-smoke.mjs:43`、
    `capabilities-report-smoke.mjs:117`、`local-passthrough-smoke.mjs:509` 都用
    `readdirSync(lib)` 非递归；`doc-numbers.countModules` 同理。路由模块放
    `lib/routes/` 子目录可以把爆炸半径压到最小；`client.*.js` 不能放子目录（见约束 3）。
11. **搬段之前，主 bundle 要用的名字必须先搬出那个段。** 实施主面板时踩到两次：
    `TOAST_DISMISS_MS` 与 `capabilityNotes` 都住在「Main panel」段里，但前者被
    `armToast`（合成器桥的 toast）读、后者被 dialogs chunk 读。段一搬，主 bundle
    就少两个绑定。这两次都是 `node --check` 通过、加载也通过，直到**点开那个对话框**
    才炸——和 E5 的 `fetchJson` 是同一类失败。
12. **宿主无条件渲染的空洞，懒组件必须挡在 `open` 之后。** `directoryFlow` 由
    `WorkspacePickFlow` 无条件渲染（`dsh-client-ui-workspace/lib/client.js:2672`
    `renderDirectoryFlow(flowOwner)`），而占用组件在关闭时返回 `null`。直接
    `React.lazy` 会让**每次页面加载**取 427 行去渲染一个 `null`。主包的 `FlowSlot`
    先判 `open`，再挂懒组件。
13. **`apply` 可以是 `async`，数据型段因此能搬走。** `cordis/lib/index.js` 的
    `_execute` 里 `else if ("then" in effect) return effect.then(safeCollect)`——apply
    返回 Promise 时被展开，解析值当 disposer 用；同部署的 `dsh-client-locale` 自己就
    是 `async function apply`。于是 `loadBootChunks()` 用一次 `Promise.all` 取回
    `client.locale.js` / `client.styles.js` / `client.icons.js`，填进各段的 `let`
    绑定，**之后**才注册第一个 slot。代价是首屏少 0.72 ms（0.32 + 0.31 + 0.09，
    全新进程实测）。反面的坑：`await` 之后一切名字都可能还没到，本包已经因此被
    用户抓到四次（`schemeRules`、`fetchJson`、`BROWSE_LIST_LIMIT`、
    `refreshRemoteWorkspaceMarks`）。
14. **三块数据的"叶子"身份要被断言，不能只靠人记得。** 它们不 destructure 主包任何
    名字，所以对它们要求"必须有 seam"是错的；但对借名字的 chunk 要求必须有 seam
    又是对的。`tests/support/free-names.mjs` 的 `bundleBorrows` 先剥掉 seam 语句
    再数外部名字，据此分两类，并在负向对照里验证过（让 `client.styles.js` 用一次
    `API`，两条断言同时变红）。

### 1.2 基线（本机实测，供拆完对照）

| 检查 | 结果 |
| --- | --- |
| `node scripts/check-doc-links.mjs` | 25 个 markdown 文件全部通过 |
| `node scripts/doc-numbers.mjs --check` | `docs/development.md` 是最新的 |
| `node --check lib/client.js`（逐文件） | 通过 |
| `node scripts/lint.mjs` | 179 个模块解析通过；**但它非递归，看不到 `lib/routes/`（见 2.3）** |
| `node tests/run.mjs`（设 `DSH_CORE_ROOT`） | **93 passed / 2 partial / 3 skipped / 0 failed**（98 套件） |
| 逐套件直跑（`DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules`） | `routes-smoke` 276/0、`remote-fs-smoke` 67/0、`transfer-smoke` 114/0、`tool-results-smoke` 33/0、`client-shape-smoke` **337/0** |

3 个 SKIP（`dirs-listing` / `live` / `acceptance`）与 2 个 PARTIAL 是缺
`DSH_WS_TEST_ALIAS`（真机主机），不是失败。**判据是 `0 failed`。**
（本页早先的版本记的是「本机跑不了 runner、有 2 条假红」——那是沙箱收紧时的结论；
策略放开后实测 0 failed，`client-shape-smoke` 是 337 条而非 335 条。）

## 2. 方案

五条轨道，**按风险从低到高排序**，前三条互不依赖。每条轨道内部按「先让边界可检查，
再搬代码」的顺序排提交。

### 2.1 轨道 A —— 去重（零行为风险，先做）

本轮扫出 10 组跨模块同名函数，其中 4 组是**逐字相同的复制**：

| 函数 | 位置 | 处置 |
| --- | --- | --- |
| `escapeRegExp` | `lib/include-chain.js:146`、`lib/shell.js:310`、`lib/ssh-config.js:174` | 新建 `lib/text.js` |
| `requirePort` | `lib/forward.js:28`、`lib/reverse-forward.js:45` | 新建 `lib/forward-common.js` |
| `normalizedHost` | `lib/forward.js:37`、`lib/reverse-forward.js:54` | 同上 |
| `positive` | `lib/reconnect.js:50`、`lib/watch-recovery.js:46` | 新建 `lib/options.js` |
| `quote` | `lib/patch-terminal.js:642`、`lib/shell.js:523` | 与 `engine.js:1846` 的 `shellQuote` 同体，统一到 `lib/shell-quote.js` |

`quote` 这一组要小心：`engine.js` 的 `shellQuote` 已被 6 个模块引用
（`fs-shim.js`、`patch-shell.js`、`patch-subprocess.js`、`remote-fs.js`、
`remote-shells.js`、`routes.js`、`verify.js`）。做法是**新建 `lib/shell-quote.js` 并把
`engine.js` 改成 re-export**——6 个既有 import 一行不动，`shell.js`（当前只依赖
`node:string_decoder`）也不必因此拉起 `engine.js` 的整条依赖链。

另有两个导出**全仓库零引用**（含 `tests/` 与 `scripts/`）：

- `capabilityKeys`（`lib/capabilities.js:161`）——只是 `probedTools()` 的别名；
- `resumeToken`（`lib/resume.js:169`）。

它们不在 `package.json` 的 `exports` 里，属内部 API，删除是纯减法。

**不删、只记录**的两个：`acceptsWithoutOurPatch`（`lib/path-binding.js:141`）与
`matchLimitation`（`lib/ssh-config.js:149`）零引用，但两者的注释都写着「审计需要它」
（「would still accept with this bridge removed」/「Why a `Match` section selected nobody」）。
这更像**该接未接的诊断**，而不是死代码；处置写进
`docs/optimization-and-future03.md` §1 作为待办，不在本辑里删。

### 2.2 轨道 B —— `tools.js`：把 `statusTool` 的三个部分分开

`statusTool` 606 行的内部骨架是齐整的三段：

| 行 | 内容 |
| --- | --- |
| 855–1233 | `output.schema`（纯数据，377 行） |
| 1234–1339 | `render: (_args, value) => …`（纯函数，106 行） |
| 1341–1452 | `async execute ()`（112 行） |

拆成 `lib/status-schema.js`（导出 `STATUS_OUTPUT_SCHEMA`）与 `lib/status-render.js`
（导出 `renderStatus`）后，`statusTool` 剩约 115 行，且 `defineTool({` 仍在 `tools.js`
里——`doc-numbers.countTools`（`scripts/doc-numbers.mjs:80`）的正则不受影响。

**注意**：`tests/client-shape-smoke.mjs:712` 断言
`/selfCheck: probedAliases\(engine\)/` 出现在 `lib/tools.js`。`execute` 留在 `tools.js`，
这条断言继续成立；若将来把 `execute` 也搬走，必须同 commit 改这条断言。

### 2.3 轨道 C —— `routes.js`：按资源域拆模块

`makeRoutes` 是 1,856 行的单函数，但它产出的东西形状极简单：一个
`{kind, path, handler}[]`（`lib/index.js:845` 逐个交给 `webServer.register`）。
所以拆法是「**handler 搬家，组合点留下**」：

1. `lib/routes/kit.js`：`writeJson`、`readJsonBody`、`statusForActionError`、
   `statusForDownloadError`、`isJsonContentType`、`isRawContentType`、`mediaTypeOf`、
   `queryParam`、`trimmedParam`、`parseLimit`、`codedError`、`accessRefusal` 与
   `guard` / `guardRaw` 的工厂。**围栏语义一行不改**，只换位置。
2. `lib/routes/hosts.js`（7 条：`hosts`、`hostSave`、`hostDelete`、`hostForgetKey`、
   `hostDisconnect`、`hostReconnect`、`test`）。
3. `lib/routes/transfers.js`（`transfer`、`download`、`downloadTree`、`upload`、`uploadChunk`）。
4. `lib/routes/workspaces.js`（`mount`、`unmount`、`enable`、`status`、`selfCheck`、
   `supportBundle`）。
5. `lib/routes/forwards.js`（`forward`、`unforward`、`forwardSave`、`forwardToggle`、
   `forwardDelete`、`forwardRemember`、`forwardProbe`、`forwardSettings`、
   `passthroughSettings`）。
6. `lib/routes/entries.js`（`ls`、`gitHistory`、`rename`、`deleteEntry`、`mkdir`、
   `mutationPolicy`）。

`makeRoutes` 最后只剩：建 kit、按固定顺序拼六个数组、返回。**`ROUTES` 表留在
`lib/routes.js` 并继续 re-export**，因为 `tests/routes-smoke.mjs:117`、
`tests/mutations-smoke.mjs:122`、`tests/lifecycle-smoke.mjs:78` 都从
`lib/routes.js` 取 `{ makeRoutes, ROUTES }`——保持这个入口，28 个套件里的
`routes.js` 文本断言（`client-shape-smoke:709`、`transfer-smoke:1146` 等）也继续有效。

路由模块放**子目录**是关键：`lib/*.js` 的三处非递归扫描
（`upstream-contract-smoke.mjs:43`、`capabilities-report-smoke.mjs:117`、
`local-passthrough-smoke.mjs:509`）与 `doc-numbers.countModules` 都不会看见它们，
`modules under lib/` 这个数字不变。

**但子目录有一个代价，必须一起处理**：`scripts/lint.mjs:41` 也是非递归的
（`readdirSync(path.join(root, directory), { withFileTypes: true })` 只取 `isFile()`），
所以放进 `lib/routes/` 的六个模块**不会被 `node --check` 检查**。实测：磁盘上 190 个
模块文件，lint 只看 179 个，已有 11 个 `tests/support/*.mjs` 从来没被语法检查过
（它们由套件运行时自然暴露，但 `lib/` 下的新文件没有这层兜底）。
CI 的 `npm run lint` 因此会「通过」而漏掉语法错误。

所以 C1 这一步要**先让 lint 递归**，再搬代码：`moduleFiles()` 改成递归遍历，
`DIRECTORIES` 语义不变。这条与「先改计数器再搬」是同一个原则——**先让边界可检查**。

**前置提交**：`scripts/doc-numbers.mjs` 的 `countRoutes` 先改成「读 `lib/routes.js`
加 `lib/routes/*.js`」，`doc-numbers-smoke` 补一条「写在子目录里的路由也会被数到」。
这一步在还没搬任何代码时落地，数字仍是 33，文档零变化。

### 2.4 轨道 D —— `remote-fs.js`：只搬 watch 集群

先说清一件事：`RemoteFileSystem` 的「大」**主要是注释**。2,597 行里类体 1,517 行，
方法体合计只有 976 行，最大方法 `#openSharedWatch`（`:1326`）131 行。按文件行数
去拆它，收益远小于看起来的样子。

真正自成一体的只有**共享 watch 集群**，约 540 行：

| 成员 | 位置 |
| --- | --- |
| `#watchShared` | `lib/remote-fs.js:1220` |
| `#waitForSharedStart` | `:1296` |
| `#openSharedWatch` | `:1326` |
| `#notifyShared` | `:1469` |
| `#stopSharedWatch` | `:1500` |
| `startRemoteWatch` | `:1793` |
| `startPushWatch` | `:1695` |

搬到 `lib/remote-watch.js` 作为一个协作者类，`RemoteFileSystem` 只保留委托。
**这是五条轨道里唯一「搬完行为可能真的变」的一块**（O-19 的跨订阅去重、断链重试、
恢复后重扫的先后顺序都在里面），因此给它一条硬闸门：`watch-sharing-smoke`（327 行）、
`watch-lifecycle-smoke`、`watch-recovery-smoke`、`remote-fs-smoke` 四套必须全绿，
且**必须在一个提交里完成**——不能留下中间态。

若一个提交内做不到全绿，本轨道**就地停止**，把结论写进
`docs/optimization-and-future03.md`，不硬推。

### 2.5 轨道 E —— `client.js`：按「渲染边界」拆 chunk

这是五块里唯一「拆完运行时真的会变」的。本轮做了段间依赖分析：先剥掉注释、字符串、
模板字符串与正则字面量（正则那一步不能省——`/[^/]/` 里的斜杠会把朴素的扫描器带偏，
第一版分析就因为漏掉它得出过「`Transfer queue` 是闭合的」这个错误结论），只算标识符
引用、排除属性访问。结论：

- 22 段里有 **1 个 11 段组成的强连通分量**：`Main panel`、`Directory browser dialog`、
  `Remote-workspace marks`、`Composer file bridge`、`Host file tree`、
  `File-panel header actions`、`Transfers from DSH's own file tree`、`Transfer queue`、
  `Add-workspace flow`、`Panel page wrapper`、`Plugin apply`。
- **唯一闭合的集合是内核叶子** `{API client, Locale, CSS, SVG Icons, Host card}`。
  其余每一个「想单独拆出去」的段都会反向依赖这个内核，或依赖强连通分量里的某一段。
- 被 2 段以上引用的「内核声明」14 个：`API`（7 段）、`useDialogA11y`（5）、`modalLayer`（4）、
  `translate`（4）、`TREE_ROW_SELECTOR`（4）、`treeContainerOf`（3）、`FolderIcon` / `CloseIcon` /
  `RemoteMarkIcon` / `NS` / `rowReferenceKind` / `OS_TREE_SELECTOR` / `treeSelectableRows` /
  `entryNameOf`（各 2）。

真实边（决定每个 chunk 必须拿到什么）：

| 段 | 引用了谁 |
| --- | --- |
| Host editor dialog | `API`、`useDialogA11y`、`modalLayer` |
| Directory browser dialog | `API`、`FolderIcon`、`useDialogA11y`、`modalLayer`、`capabilityNotes` |
| Diagnostic report dialog | `CloseIcon`、`useDialogA11y`、`modalLayer` |
| Change-request tab | `ChevronIcon`、`RefreshIcon` |
| Transfer queue | `API`、`UploadIcon`、`TransferProgressIcon`、`DownloadIcon`、`useDialogA11y`、`formatBytes`、`transferNotice`、`randomHexId`、`describeNetworkError`、`refreshFilesPanel`、`saveViaAnchor`、`identity`、`translate` |

所以**「按 banner 全量拆成 chunk」在技术上不成立**，而且比第一版分析更严格：
**连 `Transfer queue` 都不闭合**——它引用 `Composer file bridge` 的 `formatBytes` /
`transferNotice`、`Transfers from DSH's own file tree` 的四个 helper、以及
`Change-request tab` 的 `identity`。chunk 是异步加载的，这些同步函数必须已经可用。

本辑采用的边界因此不是「哪些段整体搬走」，而是**「哪些段可以被一个懒组件包住」**：
chunk 只导出**组件**，内核与所有同步 helper 留在主 bundle，经 props 或
`require('<本插件 id>')` 拿到。最初落地为三个 chunk，实施中又加了两个：

| chunk | 导出的组件 | 搬走的渲染代码 | 必须拿到的（留主 bundle） |
| --- | --- | --- | --- |
| `lib/client.locale.js` | `NS`、`zh`、`en`、`applyParams`、`makeTranslate`、`provenanceText`、`relativeTimeText` | 850 行 | **无**（叶子：不借主包任何名字） |
| `lib/client.styles.js` | `injectStyles`、`CSS_ID` | 546 行 | **无**（叶子） |
| `lib/client.icons.js` | 十四个图标工厂加 `TRAY_BASE_PATH` / `TRAY_ARROW_PATHS` | 228 行 | **无**（叶子，只 `require('react')`） |
| `lib/client.dialogs.js` | `HostEditor`、`DirectoryBrowser`、`ReportDialog` | 约 510 行 | `API`、`FolderIcon`、`CloseIcon`、`useDialogA11y`、`modalLayer`、`backdropDismiss`、`capabilityNotes`、目录选择器的纯 helper |
| `lib/client.panel.js` | `RemoteWorkspacePanel`、`HostCard` | 1,780 行 | `API`、`fetchJson`、`fetchReportText`、`RemoteMarkIcon`、`relativeTimeText`、`provenanceText`、`DialogSlot` 与三个对话框、`notifyUser`、`toastError`、`useTransferActionsSlot`、`syncRemoteWorkspaceMarks`、`capabilityNotes` |
| `lib/client.add-workspace.js` | `AddChooser`、`RemoteWorkspaceDialog`、`AddWorkspaceFlow` | 490 行 | `API`、`fetchJson`、`BROWSE_LIST_LIMIT`、`FLOW_MENU_WIDTH_ROOMY`、`flowMenuPosition`、四个图标、`backdropDismiss`、`modalLayer`、`useDialogA11y`、`useMenuKeyboard`、目录选择器的纯 helper、`refreshRemoteWorkspaceMarks` |
| `lib/client.transfer-queue.js` | `TransferQueuePanel` | 215 行 | `useTransferQueue`、`useDialogA11y`、`backdropDismiss`、队列的 14 个纯 helper |
| `lib/client.history.js` | `ForgeTabWithHistory` 的渲染体 | 243 行 | `ChevronIcon`、`RefreshIcon`、`ourT`（由 apply 注入） |

合计 **3,967 行**离开主包，`lib/client.js` 从 12,604 行降到 8,290 行（−34%，
500,755 → 386,314 B）。

三份数据 chunk 是**叶子**：它们不 destructure 主包任何名字。`apply` 因此必须是
`async`——开头 `await loadBootChunks()` 把三块取回并填进各段的 `let` 绑定，**之后**
才注册第一个 slot。机制见 §3 决策记录与 `docs/optimization-and-future03.md` §1.1
第 5 条。

主面板与添加工作区两条是实施中途加进来的，它们各自附带一条新约束（详见
§1.1 第 11、12 条）：`TOAST_DISMISS_MS` 与 `capabilityNotes` 原本住在主面板段里，
但主 bundle 与 dialogs chunk 在读它们，搬段之前必须先搬出去；`directoryFlow` 由
宿主无条件渲染，占用组件关闭时返回 `null`，所以主包留的 `FlowSlot` 先判 `open`
再挂懒组件——否则每次页面加载都会取 427 行去渲染一个 `null`。

`Remote-workspace marks` **不拆**：它是 apply 期安装的 `MutationObserver`（`installRemoteWorkspaceMarks`
`lib/client.js:4718`，8 行），没有渲染时机可用；它的渲染部分被 `Main panel` 与
`Composer file bridge` 双向引用，拆出去只会把内核拉进 chunk。

`Composer file bridge` 同样**不拆**：`installTreeDragBridge`（174 行）与
`installTreeMenuBridge`（188 行）在 `apply()` 里同步装在 `document` 上，它们的
同步调用图横跨 `Transfers`（12 个函数）、`Remote-workspace marks`（12）、
`Composer file bridge`（11）、`Host file tree`（8）、`File-panel header actions`（8）、
`Session list catch-up`（4）——任何一个被调函数进了 chunk，拖拽在 chunk 到达前
就是坏的，而 chunk 到达时机不确定。这是本轨最硬的一条边界。

调用点用宿主同款写法：

```js
const LoadedDialogs = React.lazy(async () => ({
  default: (await require.async('./client.dialogs.js')).Dialogs,
}))
```

chunk 文件里 `load({ id: '<本插件 id>', chunk: 'client.dialogs.js', factory })`，
`factory(require)` 里 `require('react')` / `require('react/jsx-runtime')` 走 seed 表，
内核要么经 `require('<本插件 id>')`（需 E2 探针先证明），要么按 props 传入。

**收益必须实测，不能靠直觉**。本轮实测（`new Function(...)` 编译整份源码，每个测量各起一个
新进程，因为预热过的进程会命中 V8 的编译缓存给出 0 ms）：

| 测量 | 值 |
| --- | --- |
| 编译整份 `client.js`（627,867 B） | **3.60 ms** |
| 编译砍掉三个 chunk 候选段之后的版本（−1,353 行 / −68,598 B） | **3.24 ms** |
| **净收益** | **0.36 ms / 次页面加载** |

三个 chunk 合计只占全文件 **10.7%** 的行数，而 V8 的解析成本近似线性于字节数。
所以：**这条轨道不省启动时间**（0.36 ms 在 `DOMContentLoaded=47ms` 面前测不出来），
它省的是**人读文件时的上下文**——也就是用户提的那个痛点（「改一处要读半个文件」）。
把它写成性能优化是不诚实的；方案里先前那句「收益是解析与求值」按此实测更正。

真正的运行时收益只有一处，且是负的：chunk 是**多一次 HTTP 往返**（C-02 实测
`startTime=289ms`、`duration=0.8ms`，发生在主界面可交互之后）。所以这条轨道的价值
完全在可维护性，验收标准也据此写（见 §5）。

如果 E2 探针证明 `require('<本插件 id>')` 不可用、内核只能按 props 传，
那么 `client.history.js` 性价比最低（只省 210 行却要传两个图标），可以放弃它，
只做前两个。

**实施结果（2026-11-21）**：八个 chunk 全部落地，`require('<本插件 id>')` 通道在真机与
`tests/client-chunk-smoke.mjs` 上都成立，所以 `client.history.js` 没有放弃。落地时
还补了两条方案里没预见到的边界，见 §1.1 第 11、12 条；末轮把字典 / 样式 / 图标
搬成启动期 chunk 又补了第 13 条（`apply` 可以是 async）。

**末轮（E10）的三条收获**：

1. **`apply` 返回 Promise 是被支持的**，不是本包的私招：`cordis/lib/index.js` 的
   `_execute` 里 `else if ("then" in effect) return effect.then(safeCollect)`——解析出的
   值当 disposer 用。同部署的 `dsh-client-locale` 自己就是 `async function apply`。
2. **三块数据没有 reverse 依赖**，所以它们是叶子：不 destructure 主包任何名字。
   这让接缝检查必须分两类——借名字的 chunk 必须走文档接缝，叶子被断言"不需要
   seam，也没长出 seam"（`tests/support/free-names.mjs` 的 `bundleBorrows`）。
   这条新规则当场抓出 `client.panel.js` 用了 `provenanceText` 却没 destructure。
3. **`HostCard` 跟着面板走**：它只有面板一个读者。搬的时候要先把名字从面板的
   seam 列表里删掉，否则同一文件里声明两次——`SyntaxError: Identifier 'HostCard'
   has already been declared`。

**map 与检查**：文件头那张 map（`lib/client.js:12-66`）现在有 `client-shape-smoke`
的强校验（解析 banner、要求内容与顺序都一致，`tests/client-shape-smoke.mjs:1286-1351`）。
拆成多文件后，这张 map 升格为**整个客户端半边的 part 表**，由新的
`scripts/client-map.mjs` 维护并检查三件事：每个 part 的 banner 都在表里、
表的顺序与文件顺序一致、每个 part 只引用表里声明的上游 part（chunk 闭合性）。
`client-shape-smoke` 的 map 断言改为调用这个脚本，不再自己解析。

### 2.6 提交计划（每步结束时仓库可用）

轨道内顺序即提交顺序。标 **⛔** 的提交必须同 commit 改测试，否则该步结束时是红的
（这是用户选定的档位：**代码与测试同 commit，提交末尾全绿**）。

**A 去重**

1. `refactor: one POSIX quoter for every remote command` —— 新建 `lib/shell-quote.js`；
   `engine.js` 改为 re-export；`shell.js:523`、`patch-terminal.js:642` 删本地 `quote`。
2. `refactor: one port and host validator for both forward directions` —— 新建
   `lib/forward-common.js`，`forward.js:28,37` 与 `reverse-forward.js:45,54` 改用它。
3. `refactor: one option-number coercion helper` —— 新建 `lib/options.js`，
   `reconnect.js:50` 与 `watch-recovery.js:46` 改用它。
4. `refactor: one regex escaper` —— 新建 `lib/text.js`，
   `include-chain.js:146`、`shell.js:310`、`ssh-config.js:174` 三处改用。
5. `chore: delete two exports nothing calls` —— 删 `capabilityKeys`、`resumeToken`。

**B tools**

6. `refactor(tools): move the status output schema beside the tool` —— 新建
   `lib/status-schema.js`；`statusTool` 606 → 约 230 行。
7. `refactor(tools): move the status renderer out of the tool body` —— 新建
   `lib/status-render.js`；`statusTool` → 约 115 行。

**C routes**

8. `chore(lint): walk every module, not just the top level` —— `scripts/lint.mjs` 的
   `moduleFiles()` 改成递归；覆盖数从 179 升到 190（补上 11 个 `tests/support/*.mjs`）。
   **必须在 C2 之前**，否则 `lib/routes/*.js` 永远不被语法检查。
9. `chore(doc-numbers): count routes across a route directory` —— `countRoutes` 读
   `lib/routes.js` + `lib/routes/*.js`；`doc-numbers-smoke` 补子目录用例。数字仍是 33。
10. `refactor(routes): one kit for the shared HTTP plumbing` —— 新建 `lib/routes/kit.js`；
    `routes.js` re-export 测试仍在用的符号。
11. `refactor(routes): move the host routes into their own module` —— 7 条。
12. `refactor(routes): move the transfer routes` —— 5 条。
13. `refactor(routes): move the workspace routes` —— 6 条。
14. `refactor(routes): move the forward routes` —— 9 条。
15. `refactor(routes): move the entry routes` —— 6 条；`makeRoutes` 降到约 60 行。

**D remote-fs**

16. `refactor(remote-fs): give the shared watch its own module` ⛔ —— 新建
    `lib/remote-watch.js`，一个提交内完成，四套 watch 相关套件必须全绿；做不到就停。

**E client**

16. `test(client): read the client half through one resolver` —— 新建
    `tests/support/client-source.mjs`（按 part 表拼接主 bundle + chunk），
    把 28 个套件的 29 处 `readFileSync(...client.js)` 换成它。**源码零改动，全绿。**
17. `chore(client): verify a chunk can require the main bundle` —— 加
    `lib/client.probe.js` 探针 + 一次 `require.async`，在真机确认
    `require('<本插件 id>')` 可取到主 bundle 导出（宿主 `client.js:836` 的
    `factories.has` 分支）。结论写进本页 §1.1 第 5 条。
18. `chore(client): remove the chunk probe` —— 回滚探针，只留结论。
19. `refactor(client): one declared part list, checked` ⛔ —— 新建
    `scripts/client-map.mjs`，接进 `npm run check`；`client-shape-smoke` 的 map
    断言改为调用它。
20. `refactor(client): load the dialogs from a chunk` ⛔ —— `lib/client.dialogs.js`（699 行）。
    三个渲染点（`:4424` `ReportDialog`、`:4432` `DirectoryBrowser`、`:4441` `HostEditor`）
    各包一层 `Suspense` + 带兜底的 `lazy`。
21. `refactor(client): split the transfer-queue state from its panel` —— 文件内切分：
    状态机（`useTransferQueue`、`enqueueUploads` 等）留在主 bundle，只把
    `TransferQueuePanel`（`:8375-8440`，66 行）的渲染剥出来。
22. `refactor(client): load the transfer-queue panel from a chunk` ⛔ ——
    `lib/client.transfer-queue.js`；渲染点 `:10176`。
23. `refactor(client): load the change-request tab from a chunk` ⛔ ——
    `lib/client.history.js`（588 行）。**E2 探针失败时可放弃这一步**：它只省 588 行，
    却要按 props 传两个图标，性价比最低；前两个 chunk 不受影响。
24. `docs: the client half is more than one file` —— 同步
    `docs/architecture.md:21,750`、`docs/development.md:25,62,119,120`、
    `docs/optimization-and-future03.md` §1.1（C-02 从「待批准」改为「已实施」）、
    `CHANGELOG.md` 的未发布段，并重跑 `node scripts/doc-numbers.mjs`。

**共 27 个提交**（A 5 + B 2 + C 8 + D 1 + E 9 + 实施中追加的 2 个 client chunk）。

## 3. 决策记录

- **先做零风险的 A，`client.js` 最后**：A 的每一步都能用一个套件证明，且不改变任何
  运行路径；`client.js` 的每一步都要同时改源码与 28 个套件的读取方式，放最后才不会
  让「拆分」和「去重」的回归混在一起。
- **路由模块放 `lib/routes/` 子目录**，而不是平铺进 `lib/`：三处 `readdirSync(lib)`
  的非递归扫描与 `countModules` 因此完全不用动。代价是 `scripts/lint.mjs` 也看不见
  它们——所以这一条**附带**一个前置条件：C1 先把 lint 改递归（见 §2.3 与 §3 风险表）。
- **`client.*.js` 必须平铺在 `lib/`**：chunk 由 `dirname(meta.clientPath)` 解析，
  与主 bundle 同目录是宿主契约，不是选择。
- **`client.js` 只按「懒渲染边界」拆，不按 banner 全量拆**：段间依赖图里有一个
  11 段强连通分量，全量拆必然要把内核搬进每个 chunk 或引入跨 chunk 同步依赖，
  而后者在宿主里根本不成立（`client.js:833-841`）。这不是偏好，是图算出来的结论。
- **内核（API / Locale / CSS / SVG Icons / Host card）留在主 bundle**：`API` 一个符号
  就被 7 段引用，`useDialogA11y` 被 5 段引用；搬走等于把「懒加载」变成「处处等待」——
  这正是 `docs/optimization-and-future03.md` §1.1 已经写下的拆分边界。
- **测试侧的读取收敛到一个 resolver**（提交 16），而不是逐个套件改路径：29 处
  `readFileSync` 分散在 28 个文件里，逐个改会在后续每次搬段时重复付成本。
- **`ROUTES` 与 `makeRoutes` 的入口不变**：三个套件从 `lib/routes.js` 取它们，
  保持这个入口意味着路由拆分的 8 个提交不需要碰任何 `import` 行。
- **`statusTool` 只拆 schema 与 render，`execute` 留在工具里**：`client-shape-smoke:712`
  对 `tools.js` 里有 `selfCheck: probedAliases(engine)` 有断言，`execute` 搬走就得
  同时改断言——收益不值。
- **两个「该接未接」的导出不删**：`acceptsWithoutOurPatch` 与 `matchLimitation` 的注释
  都说审计需要它们，零引用更可能是漏接。删除会把「功能缺口」伪装成「清理完成」。
- **不改错误码、HTTP 状态码、工具输出 schema、围栏函数**：全部五条轨道都是移动，
  唯一的语义改动是 chunk 的**加载时机**（交互后），这一点在提交 20/22/23 的验收里
  单独验证。
- **`scripts/lint.mjs` 先改递归再搬路由**：它是唯一能发现「语法错误」的检查，而它
  现在漏掉 11 个 `tests/support/*.mjs`。不先修，`lib/routes/*.js` 就是在无检查状态下
  落地的——这违背「先让边界可检查，再搬代码」。

## 4. 测试决策

**什么算好测试**：只断言外部行为——HTTP 状态码与响应体、工具输出 schema 校验、
`ssh://` 路径解析结果、`ctx.fs` 方法的可观察效果。不断言「函数在第几行」
「文件里有某个字符串」这类实现细节。仓库现有的文本切片断言是**已知的技术债**
（`docs/optimization-and-future03.md` O-14 记过同类问题），本辑不新增同类断言，
并在提交 19 把 map 检查从「解析源码字符串」升级为「调用 `scripts/client-map.mjs`」。

| 轨道 | 主要套件 | 现有断言数 |
| --- | --- | --- |
| A 去重 | `forward-smoke`、`reverse-forward-smoke`、`forward-persist-smoke`、`reconnect-smoke`、`watch-recovery-smoke`、`include-chain-smoke`、`ssh-config-smoke`、`shell-smoke`、`terminal-smoke`、`remote-shells-smoke` | — |
| B tools | `tool-schemas-smoke`、`tool-results-smoke`、`client-shape-smoke:712` | — |
| C routes | `routes-smoke`（**276**）、`mutations-smoke`、`lifecycle-smoke`、`host-listing-smoke`、`doc-numbers-smoke` | 276 |
| D remote-fs | `watch-sharing-smoke`、`watch-lifecycle-smoke`、`watch-recovery-smoke`、`remote-fs-smoke`（**67**） | 67 |
| E client | `client-shape-smoke`（**335**）、`render-smoke`、`tree-select-smoke`、`transfer-queue-smoke`、`commit-history-smoke`、其余 23 个切片套件 | 335 |

**先例**（写新测试时照抄这些）：
- 路由行为：`tests/routes-smoke.mjs` 用真 `http.createServer` + `fakeUploadEngine`，
  不 mock `makeRoutes`。
- 远端文件系统：`tests/support/fake-sftp.mjs` 是**按 SFTP 规范作答**的内存服务器，
  不是 mock；`tests/remote-fs-smoke.mjs` 用它驱动真实 `RemoteFileSystem`。
- 组件渲染：`tests/support/render.mjs` 从 bundle 切出真组件、用 React 形状的钩子渲染；
  `tests/render-smoke.mjs` 用真组件（`SelfCheckList`）并带负向对照。
- 计数与文档：`tests/doc-numbers-smoke.mjs` 用「加一条就 +1」证明计数器没有写死。

**跑法**：必须设 `DSH_CORE_ROOT`，否则 `lib/peers.js:146` 解析不到 peer 包。

```bash
export DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules
node tests/run.mjs        # 基线 93；现状 94 passed / 2 partial / 3 skipped / 0 failed
node scripts/lint.mjs     # 基线 179 modules；C1 之后 197，现状 215
```

## 5. 验收标准

1. 五条轨道全部完成后，`node tests/run.mjs` 是 **`0 failed`**（基线
   93 passed / 2 partial / 3 skipped / 0 failed；**现状 94 passed / 2 partial /
   3 skipped / 0 failed**，多出的 1 个是 E2 新增的 `client-chunk-smoke`）。
2. `node scripts/lint.mjs` 通过，且它**真的覆盖**新增的 `lib/routes/*.js`
   （C1 递归后从 179 变成 197，现状 215 个模块）与 `lib/client.*.js`。
3. `node scripts/check-doc-links.mjs` 与 `node scripts/doc-numbers.mjs --check` 通过；
   `docs/development.md` 的生成表里 `HTTP routes` 仍是 **33**、`model-facing tools`
   仍是 **11**，`modules under lib/` 的变化与实际文件数一致。
4. `npm pack --dry-run` 的产物包含 `lib/routes/*.js` 与 `lib/client.*.js`。
5. 真实宿主（浏览器）里：面板正常渲染；打开「新建远程工作区」、打开目录浏览器、
   打开诊断报告、打开传输队列、打开「变更请求」tab，各自首次点击后能加载对应 chunk
   （Network 面板出现 `client.<name>.js?rev=…` 的 200），且首屏 `DOMContentLoaded`
   **不比拆分前更慢**（主包编译 3.60 ms → 2.15 ms，见 §2.5 的实测表——这条是防回归，
   不是性能指标）。**本轮已实测**：八个 chunk 都在真机上加载，其中主面板与添加工作区
   两条拆完后由用户实测确认，并因此抓出三个缝合 bug（见 §7）；末轮三份数据 chunk
   由用户重启后确认面板、字典、图标全部正常。
6. 每个 chunk 在宿主上**加载失败时是隔离的**：改名一个 chunk 后刷新页面，主界面照常
   渲染，只有该功能不可用（宿主对 chunk 失败的处理与主 bundle 一致，C-02 已实测）。
   注意 C-02 实测的是**主 bundle 里一次 `require.async` 失败**（`failed: client-modules:
   bundle script … failed to load`，值是失败字符串）。`React.lazy` 那条路不一样：
   promise reject 会让 React **抛错到最近的 error boundary**，而本 bundle 目前
   **没有 error boundary，也没有 `Suspense`**（`lib/client.js` 全文 0 命中）。
   所以每个懒组件必须自带兜底：
   - `Suspense` 的 `fallback: null`（照抄 `dsh-client-ui-sidebar-terminal:174`）；
   - `React.lazy(() => require.async(…).then(m => ({default: m.X}), () => ({default: Fallback})))`
     —— 把 reject 变成「渲染一个说明不可用的组件」，照抄
     `dsh-client-ui-sidebar-documentpreview:1574` 的 `FrontmatterFallback` 写法。
   验收里那条「改名后主界面照常」要**逐个 chunk 实测**，不能靠 C-02 的结论外推。

## 6. 不做什么

| 不做 | 理由 |
| --- | --- |
| 引入构建步骤 / TypeScript | `docs/optimization-and-future03.md` §2 已判定：会打断七个运行时补丁与单入口 bundle；本辑所有拆分都是手写 ESM 与手写 chunk |
| 声明第二个 `dsh.client` 入口 | 宿主按 `exports['./client']` 取主 bundle，第二个入口会改变插件的组合方式；chunk 通道不需要它 |
| 按 22 个 banner 全量拆 chunk | 段间存在一个 11 段强连通分量，全量拆会把内核复制进每个 chunk 或引入跨 chunk 同步依赖（后者宿主不支持） |
| 拆 `RemoteFileSystem` 的非 watch 部分 | 2,597 行里方法体只有 976 行，其余是注释；按行数拆它是拿风险换可读性 |
| 拆 `lib/index.js` 的 `apply`（584 行） | 它是 Cordis 的注入编排，顺序本身是语义；拆成函数不减少阅读量，反而藏起顺序 |
| 动 `lib/patch-*.js` | 它们是上游补丁，一行对应一个宿主缺陷，`upstream-contract.js` 按文件登记退役判据；移动会打乱退役信号 |
| 删除 `acceptsWithoutOurPatch` / `matchLimitation` | 零引用更像「该接未接」；删除会把功能缺口伪装成清理完成 |
| 建 GitHub issue | 用户选择只落仓库文档 |

## 7. 风险

| 风险 | 触发点 | 处置 |
| --- | --- | --- |
| chunk 无法 `require` 主 bundle | 提交 17 的探针 | 退回「内核按 props 传入」；`client.dialogs.js` 只需 API / SVG Icons / Host card，改成 props 可行 |
| `React.lazy` 失败不隔离 | 提交 20 / 22 / 23 | 每个懒组件自带 `Suspense` + 带兜底的 `lazy`（见 §5 第 6 条）；C-02 的结论不能外推 |
| **chunk 漏解构一个名字** | 任何一次搬段之后 | 实际踩到三次：`fetchJson`、`BROWSE_LIST_LIMIT`、`schemeRules`（后者在服务端，同一类失败）。前两次都是「加载不报错、点开目录才炸」。处置不是靠人看，而是 `tests/support/free-names.mjs`：真 tokenizer（剥注释 / 字符串 / 正则，但**递归进模板 `${…}`**）+ 粗粒度作用域，把「主包声明过、chunk 用到、却既没解构也没自声明」的名字全报出来 |
| **搬段时把主包要用的名字一起搬走** | 搬主面板时 | 实际踩到两次：`TOAST_DISMISS_MS`（`armToast` 在读）与 `capabilityNotes`（dialogs chunk 在读）原本住在「Main panel」段里。段一搬，主包就少两个绑定——`node --check` 通过、加载通过，点开对话框才炸。处置：搬段前先算「这段声明了哪些名字、段外谁在用」，把有外部读者的先搬出去 |
| chunk 的 rev 缓存让本地改动不生效 | 提交 20 之后的本地开发 | 已在 §1.1 第 4 条写明：改 chunk 需重启或触碰 `lib/client.js` |
| `lib/routes/*.js` 逃过语法检查 | 提交 C2 之后 | C1 先把 `scripts/lint.mjs` 改递归；验收第 2 条要求覆盖数变成 190 |
| watch 集群一个提交内拆不完 | 提交 16 | 就地停止，结论写进 `optimization-and-future03.md`，不硬推 |
| 28 个切片套件在搬段时红一片 | 提交 16 之后 | 提交 16 先把读取收敛到 resolver；之后每次搬段只改 resolver 的 part 表 |
| `doc-numbers` 的三个数字失真 | 提交 9 / 20 / 22 / 23 | 计数器先改（提交 9），chunk 文件会进 `countModules`，故每次加 chunk 都重跑 `doc-numbers` |
| `client-shape-smoke` 的 map 断言随拆分发散 | 提交 19 | map 升格为 part 表并交给 `scripts/client-map.mjs`，套件只调用它 |

## 8. 实施顺序

```
A1 → A2 → A3 → A4 → A5            （去重，五步各自可回滚）
   → B1 → B2                       （tools，两步）
   → C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8   （routes，先改 lint 与计数器再搬）
   → D1                            （watch，一步，带硬闸门）
   → E1 → E2 → E3 → E4 → E5 → E6 → E7 → E8 → E9  （client，先收敛读取再搬）
```

A/B/C 三条轨道互不依赖，可以并行；D 与 E 都改 `lib/` 顶层文件，建议串行，
且 E 必须排在最后——它要动 28 个套件。

## 相关

- [optimization-and-future03.md](../optimization-and-future03.md) §1.1（chunk 通道的实测证据与运维约束）
- [architecture.md](../architecture.md)（`ctx.fs` 接管、客户端半边、map 的由来）
- [development.md](../development.md)（源码结构表、测试套件表、发布检查表）
- [04-code-splitting-prompt.md](./04-code-splitting-prompt.md)（一次性任务书）
