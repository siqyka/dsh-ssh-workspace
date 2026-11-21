# 任务书：代码拆分（五条轨道）

> 本文件是一次性任务书，交给一个**新的 Agent 会话**执行：读完之后直接改代码，不需要重新调研。
> 实现与验收通过后删除本文件，并同时移除 [README.md](./README.md) 里对应的一行索引。
> 背景、取舍与提交计划的完整说明见 [04-code-splitting.md](./04-code-splitting.md)。

## 0. 一句话目标

把 `lib/client/client.js`（12,603 行）、`lib/routes.js` 的 `makeRoutes`（1,856 行单函数）、
`lib/tools.js` 的 `statusTool`（606 行）、`lib/remote-fs.js` 的 watch 集群，以及四处
逐字重复的小工具函数拆开；**行为、错误码、HTTP 状态码、工具输出 schema、`ssh://`
围栏语义一律不变**。

## 1. 起点状态（已核对，不要重新推导）

| 事实 | 值 |
| --- | --- |
| `lib/client/client.js` | 12,603 行 / 627,867 B，22 个 banner 段，单 `factory` |
| `lib/routes.js` | 3,765 行；`makeRoutes`（`:911`）1,856 行；33 条路由全 `kind: 'exact'` |
| `lib/tools.js` | 2,250 行；`statusTool`（`:850`）606 行，内部三段：schema 855–1233、render 1234–1339、execute 1341–1452 |
| `lib/remote-fs.js` | 2,597 行；`RemoteFileSystem` 61 个方法、方法体合计 976 行 |
| `lib/index.js` | 855 行；`apply`（`:269`）584 行 |
| 测试 | 101 个套件文件，98 个在 `tests/run.mjs` 的 `SUITES`；**28 个套件**、**29 处**读 `lib/client/client.js` |
| 文档计数器 | `scripts/doc-numbers.mjs`：`countRoutes` 只读 `lib/routes.js`（`:129`），`countTools` 只读 `lib/tools.js`（`:130`），`countModules` 只数 `lib/*.js`（`:119`） |

**环境**：必须设 `DSH_CORE_ROOT`，否则 `lib/peers.js:146` 解析不到 peer 包：

```bash
DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules node tests/run.mjs
```

三个 SKIP（`dirs-listing` / `live` / `acceptance`）与两个 PARTIAL 是缺
`DSH_WS_TEST_ALIAS`（真机主机），不是失败。**本机现在能跑全量，判据是 0 failed。**

**基线（2026-11-20 实测，沙箱已解除后的真实数字）**：

| 检查 | 结果 |
| --- | --- |
| `node tests/run.mjs` | **93 passed / 2 partial / 3 skipped / 0 failed**（98 套件） |
| `node scripts/lint.mjs` | 179 个模块解析通过（**但它看不到 `lib/routes/`**，见 §2 第 6 条） |
| `node scripts/check-doc-links.mjs` | 25 个 markdown 文件通过 |
| `node scripts/doc-numbers.mjs --check` | `docs/development.md` 最新 |
| `routes-smoke` | 276 passed / 0 failed |
| `remote-fs-smoke` | 67 passed / 0 failed |
| `transfer-smoke` | 114 passed / 0 failed |
| `tool-results-smoke` | 33 passed / 0 failed |
| `client-shape-smoke` | **337 passed / 0 failed** |

判据因此从「相对基线不新增红」收紧为**「0 failed」**：本机现在能跑全量。
`DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules` 仍需设置，否则 `lib/peers.js:146`
解析不到 peer。3 个 SKIP 与 2 个 PARTIAL 是缺 `DSH_WS_TEST_ALIAS`（真机），不是失败。

## 2. 硬要求

1. **不改行为。** 错误码、HTTP 状态码、工具 `output.schema`、围栏函数
   （`writeFenceRoots` / `assertWithinRemoteRoots` / `assertFencedRealpath`）、
   `ssh://` 解析与回退语义全部原样保留。五条轨道都是「移动」，唯一的语义变化是
   chunk 的**加载时机**（交互后），它单独验收。
2. **代码与测试同 commit。** 结构性移动允许在同一个提交里改源码和对应测试，
   但**该提交结束时不得新增红**（相对 §1 的基线）。标 ⛔ 的提交尤其如此。
3. **先让边界可检查，再搬代码。** 路由轨道先改 `doc-numbers` 计数器（提交 C1），
   客户端轨道先把 29 处 `readFileSync` 收敛到 resolver（提交 E1）。
4. **不新增「文件里有某个字符串」式断言。** 仓库现有的文本切片断言是已知技术债
   （`docs/optimization-and-future03.md` O-14 记过同类问题），本辑不添新的。
5. **chunk 必须与主包同目录。** 宿主按 `dirname(meta.clientPath)` 解析 chunk
   （`dsh-client-modules/lib/index.js:955`），且文件名须匹配
   `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`（`:170`），`client.node.js` 被明确拒绝（`:940`）。
   所以**目录只能整块搬**：把主包换到 `lib/client/client.js` 并把
   `exports["./client"]` 指过去之后，chunk 才跟得进去（宿主从 `exports["./client"]`
   推 `clientPath`，不需要服务端改动）。平铺在 `lib/` 里也行，但那样 `lib/` 顶部
   堆九个 `client.*.js`；现状是前者。
6. **路由模块放 `lib/routes/`，浏览器半边放 `lib/client/`。** 三处
   `readdirSync(lib)` 的非递归扫描（`upstream-contract-smoke.mjs:43`、
   `capabilities-report-smoke.mjs:117`、`local-passthrough-smoke.mjs:509`）与
   `doc-numbers.countModules` **原本不用动**，但两个子目录都出现之后必须改成递归
   ——否则那三处会静默漏掉子目录里的模块，而 `doc-numbers` 的数字会莫名从
   63 跳到 79（顶层只剩 63 个）。共用的递归遍历在 `tests/support/lib-modules.mjs`。
   **`scripts/lint.mjs:41` 也是非递归的**，所以 C1 必须先把它改成递归，
   否则子目录里的模块永远不被 `node --check` 检查（当时 190 个模块只查 179 个）。
7. **`ROUTES` 与 `makeRoutes` 继续从 `lib/routes.js` 导出。** 三个套件从这里取它们
   （`routes-smoke.mjs:117`、`mutations-smoke.mjs:122`、`lifecycle-smoke.mjs:78`）。
8. **chunk 之间不得互相 `require` 兄弟文件。** 宿主只查 seed / loadCache / factories
   （`dsh-client-modules/lib/client.js:833-841`），相对路径的同步 require 必然抛错。
9. **不改 `lib/patch-*.js` 的文件边界。** 它们按文件在 `upstream-contract.js` 里登记
   退役判据，移动会打乱信号。
10. **版本号不动。** 除非明确说「发版」，否则不 `npm version`、不发布。

## 3. 顺序（每步结束仓库可用）

### 轨道 A —— 去重（零行为风险，先做）

| # | 提交 | 内容 |
| --- | --- | --- |
| A1 | `refactor: one POSIX quoter for every remote command` | 新建 `lib/shell-quote.js`；`lib/engine.js:1846` 的 `shellQuote` 改为 re-export（6 个既有 import 一行不动）；删 `lib/shell.js:523` 与 `lib/patch-terminal.js:642` 的本地 `quote` |
| A2 | `refactor: one port and host validator for both forward directions` | 新建 `lib/forward-common.js`；`lib/forward.js:28,37` 与 `lib/reverse-forward.js:45,54` 改用它 |
| A3 | `refactor: one option-number coercion helper` | 新建 `lib/options.js`；`lib/reconnect.js:50` 与 `lib/watch-recovery.js:46` 的 `positive` 改用 |
| A4 | `refactor: one regex escaper` | 新建 `lib/text.js`；`lib/include-chain.js:146`、`lib/shell.js:310`、`lib/ssh-config.js:174` 三处 `escapeRegExp` 改用 |
| A5 | `chore: delete two exports nothing calls` | 删 `lib/capabilities.js:161` 的 `capabilityKeys` 与 `lib/resume.js:169` 的 `resumeToken`（全仓库含 tests/scripts 零引用） |

**不要删** `lib/path-binding.js:141` 的 `acceptsWithoutOurPatch` 与
`lib/ssh-config.js:149` 的 `matchLimitation`：零引用但注释写着审计需要它们，属「该接未接」，
处置写进 `docs/optimization-and-future03.md` §1。

轨道 A 的验证套件：`forward-smoke`、`reverse-forward-smoke`、`forward-persist-smoke`、
`reconnect-smoke`、`watch-recovery-smoke`、`include-chain-smoke`、`ssh-config-smoke`、
`shell-smoke`、`terminal-smoke`、`remote-shells-smoke`。

### 轨道 B —— tools

| # | 提交 | 内容 |
| --- | --- | --- |
| B1 | `refactor(tools): move the status output schema beside the tool` | 新建 `lib/status-schema.js` 导出 `STATUS_OUTPUT_SCHEMA`；`statusTool` 606 → 约 230 行 |
| B2 | `refactor(tools): move the status renderer out of the tool body` | 新建 `lib/status-render.js` 导出 `renderStatus`；`statusTool` → 约 115 行 |

**`execute` 必须留在 `lib/tools.js`**：`tests/client-shape-smoke.mjs:712` 断言
`/selfCheck: probedAliases\(engine\)/` 出现在 `lib/tools.js` 里。
`defineTool({` 也必须留在 `tools.js`：`scripts/doc-numbers.mjs:80` 的 `countTools`
按它计数。

验证套件：`tool-schemas-smoke`、`tool-results-smoke`、`client-shape-smoke`。

### 轨道 C —— routes

| # | 提交 | 内容 |
| --- | --- | --- |
| C1 | `chore(lint): walk every module, not just the top level` | `scripts/lint.mjs` 的 `moduleFiles()` 改递归；覆盖 179 → 190 个模块。**必须在 C2 之前** |
| C2 | `chore(doc-numbers): count routes across a route directory` | `countRoutes` 读 `lib/routes.js` + `lib/routes/*.js`；`doc-numbers-smoke` 补「写在子目录里的路由也被数到」；数字仍是 **33** |
| C3 | `refactor(routes): one kit for the shared HTTP plumbing` | 新建 `lib/routes/kit.js`：`writeJson`、`readJsonBody`、`statusForActionError`、`statusForDownloadError`、`isJsonContentType`、`isRawContentType`、`mediaTypeOf`、`queryParam`、`trimmedParam`、`parseLimit`、`codedError`、`accessRefusal`，以及 `guard` / `guardRaw` 工厂。围栏语义一行不改 |
| C4 | `refactor(routes): move the host routes into their own module` | `lib/routes/hosts.js`：`hosts`、`hostSave`、`hostDelete`、`hostForgetKey`、`hostDisconnect`、`hostReconnect`、`test` |
| C5 | `refactor(routes): move the transfer routes` | `lib/routes/transfers.js`：`transfer`、`download`、`downloadTree`、`upload`、`uploadChunk` |
| C6 | `refactor(routes): move the workspace routes` | `lib/routes/workspaces.js`：`mount`、`unmount`、`enable`、`status`、`selfCheck`、`supportBundle` |
| C7 | `refactor(routes): move the forward routes` | `lib/routes/forwards.js`：`forward`、`unforward`、`forwardSave`、`forwardToggle`、`forwardDelete`、`forwardRemember`、`forwardProbe`、`forwardSettings`、`passthroughSettings` |
| C8 | `refactor(routes): move the entry routes` | `lib/routes/entries.js`：`ls`、`gitHistory`、`rename`、`deleteEntry`、`mkdir`、`mutationPolicy`；`makeRoutes` 降到约 60 行 |

路由形状（每条都一样，照抄）：

```js
{
  kind: 'exact',
  path: ROUTES.<key>,
  handler: async (req, res) => { … },
}
```

验证套件：`routes-smoke`（**276 条，这是主要安全网**）、`mutations-smoke`、
`lifecycle-smoke`、`host-listing-smoke`、`doc-numbers-smoke`。

### 轨道 D —— remote-fs 的 watch 集群

| # | 提交 | 内容 |
| --- | --- | --- |
| D1 ⛔ | `refactor(remote-fs): give the shared watch its own module` | 新建 `lib/remote-watch.js`，搬 `#watchShared`（`:1220`）、`#waitForSharedStart`（`:1296`）、`#openSharedWatch`（`:1326`）、`#notifyShared`（`:1469`）、`#stopSharedWatch`（`:1500`）、`startRemoteWatch`（`:1793`）、`startPushWatch`（`:1695`）；`RemoteFileSystem` 只留委托 |

**必须一个提交内完成，不得留中间态。** 四套必须全绿：
`watch-sharing-smoke`、`watch-lifecycle-smoke`、`watch-recovery-smoke`、`remote-fs-smoke`。
**一个提交内做不到全绿就就地停止**，把结论写进 `docs/optimization-and-future03.md`，不要硬推。

### 轨道 E —— client（最后做）

| # | 提交 | 内容 |
| --- | --- | --- |
| E1 ⛔ | `test(client): read the client half through one resolver` | 新建 `tests/support/client-source.mjs`（按 part 表拼接主 bundle + chunk）；把 28 个套件的 29 处 `readFileSync(...client.js)` 换成它。**源码零改动，基线不变** |
| E2 | `chore(client): verify a chunk can require the main bundle` | 加 `lib/client/client.probe.js` 探针 + 一次 `require.async`，在真机确认 `require('<本插件 id>')` 能取到主 bundle 导出（宿主 `dsh-client-modules/lib/client.js:836` 的 `factories.has` 分支）。结论写进方案 §1.1 第 5 条 |
| E3 | `chore(client): remove the chunk probe` | 回滚探针，只留结论 |
| E4 ⛔ | `refactor(client): one declared part list, checked` | 新建 `scripts/client-map.mjs`，接进 `npm run check`；`tests/client-shape-smoke.mjs:1286-1351` 的 map 断言改为调用它 |
| E5 ⛔ | `refactor(client): load the dialogs from a chunk` | 新建 `lib/client/client.dialogs.js`，导出 `HostEditor` / `DirectoryBrowser` / `ReportDialog`（约 699 行） |
| E6 | `refactor(client): split the transfer-queue state from its panel` | 文件内切分：`useTransferQueue` 等状态留在主 bundle，只把 `TransferQueuePanel`（`:8375-8440`，66 行）的渲染剥出来（为 E7 准备） |
| E7 ⛔ | `refactor(client): load the transfer-queue panel from a chunk` | 新建 `lib/client/client.transfer-queue.js`，导出 `TransferQueuePanel` |
| E8 ⛔ | `refactor(client): load the change-request tab from a chunk` | 新建 `lib/client/client.history.js`，导出 `ForgeTabWithHistory` 的渲染体（约 588 行） |
| E9 | `docs: the client half is more than one file` | 同步 `docs/architecture.md:21,750`、`docs/development.md:25,62,119,120`、`docs/optimization-and-future03.md` §1.1（C-02 改为「已实施」）、`CHANGELOG.md` 未发布段，并重跑 `node scripts/doc-numbers.mjs` |

E8 可以在 E2 探针失败时放弃：它只省 588 行，却要按 props 传两个图标，性价比最低。
E5 / E7 不受影响。

chunk 的写法（宿主同款，照抄 `dsh-client-ui-sidebar-terminal`）：

```js
// 主 bundle 里
const LoadedDialogs = React.lazy(async () => ({
  default: (await require.async('./client.dialogs.js')).Dialogs,
}))

// lib/client/client.dialogs.js 里
window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.dialogs.js',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    // …组件…
    module.exports.Dialogs = Dialogs
    return module.exports
  },
})
```

**`client.js` 只按「懒渲染边界」拆，不按 banner 全量拆**：段间依赖图里有一个 **11 段**
强连通分量（`Main panel`、`Directory browser dialog`、`Remote-workspace marks`、
`Composer file bridge`、`Host file tree`、`File-panel header actions`、
`Transfers from DSH's own file tree`、`Transfer queue`、`Add-workspace flow`、
`Panel page wrapper`、`Plugin apply`）。**唯一闭合的集合是内核**
`{API client, Locale, CSS, SVG Icons, Host card}`；其余每一段都反向依赖内核或分量里的某一段，
所以「整段搬走」一个都做不到，只能把**组件**包进 `React.lazy`。

三个 chunk 的边界与各自必须拿到的：

| chunk | 导出 | 原行数 | 必须拿到（留主 bundle） |
| --- | --- | --- | --- |
| `lib/client/client.dialogs.js` | `HostEditor`、`DirectoryBrowser`、`ReportDialog` | ~699 | `API`、`FolderIcon`、`CloseIcon`、`useDialogA11y`、`modalLayer`、`backdropDismiss`、`capabilityNotes` |
| `lib/client/client.transfer-queue.js` | `TransferQueuePanel` | ~66（`:8375-8440`） | `useTransferQueue`、`useDialogA11y`、`backdropDismiss`、`transferQueueBody` |
| `lib/client/client.history.js` | `ForgeTabWithHistory` 渲染体 | ~588 | `ChevronIcon`、`RefreshIcon`、apply 注入的 `t` |

`Remote-workspace marks` **不拆**：它是 apply 期装的 `MutationObserver`（`installRemoteWorkspaceMarks`
`:5471`），没有渲染时机可用。

**内核（API client / Locale / CSS / SVG Icons / Host card）留在主 bundle**：`API` 一个符号
就被 7 段引用、`useDialogA11y` 被 5 段引用，搬走等于把「懒加载」变成「处处等待」。

**apply 期同步安装的必须留在主 bundle**：`installComposerBridges`（`:11626`，内含
`installTreeDragBridge` 174 行 / `installTreeMenuBridge` 188 行）、`installRemoteWorkspaceMarks`
（`:5471`）、`createSessionCatchUp`（`:12359`）、`trackTriggerRects`（`:4551`）、
`injectStyles`（`:975`）。它们没有「渲染前」这个时机可用。

**收益要说清（实测，别猜）**：编译整份 `client.js` 是 **3.60 ms**，砍掉三个 chunk 候选段
（−1,353 行 / −68,598 B，占 10.7%）后是 **3.24 ms**——**净收益 0.36 ms / 次页面加载**。
所以这条轨道**不省启动时间**，它省的是**人读文件的上下文**。不要把它写成性能优化，
也不要为了「更快」而多拆几块：每多一个 chunk 就多一次 HTTP 往返。
测量方法：`new Function(...)` 编译整份源码，每次测量各起一个新进程（预热进程会命中
V8 编译缓存给出 0 ms）。

## 4. 验收命令

```bash
export DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules
node tests/run.mjs                     # 判据：0 failed
node scripts/lint.mjs                  # C1 之后应为 190 个模块
node scripts/check-doc-links.mjs
node scripts/doc-numbers.mjs --check
npm pack --dry-run
```

**判据**：`0 failed`，且 `docs/development.md` 的生成表里
`HTTP routes` 仍是 **33**、`model-facing tools` 仍是 **11**。

## 5. 真机验收（E 轨道）

1. 面板正常渲染，首屏 `DOMContentLoaded` 不因拆 chunk 变慢。
2. 打开「新建远程工作区」、目录浏览器、诊断报告、传输队列、「变更请求」tab，
   各自首次点击后 Network 出现 `client.<name>.js?rev=…` 的 **200**。
3. **逐个 chunk** 改名后刷新：主界面照常渲染，只有该功能不可用。
   `React.lazy` 的 promise reject 会抛到最近的 error boundary，而本 bundle **没有
   error boundary 也没有 `Suspense`**（`lib/client/client.js` 全文 0 命中）。所以每个懒组件
   必须自己兜底，两件事一起做：
   - `Suspense` 的 `fallback: null`（照抄 `dsh-client-ui-sidebar-terminal:174`）；
   - `React.lazy(() => require.async(…).then(m => ({default: m.X}), () => ({default: Fallback})))`
     —— 把 reject 变成「渲染一个说明不可用的组件」，照抄
     `dsh-client-ui-sidebar-documentpreview:1574` 的 `FrontmatterFallback` 写法。
   C-02 实测的是主 bundle 里一次 `require.async` 失败（值变成失败字符串），
   **不能**据此推断 `lazy` 也隔离。

## 6. 不要做

- 不引入构建步骤 / TypeScript（`docs/optimization-and-future03.md` §2 已判定）。
- 不声明第二个 `dsh.client` 入口。
- 不按 22 个 banner 全量拆 chunk。
- 不拆 `RemoteFileSystem` 的非 watch 部分（方法体只 976 行，其余是注释）。
- 不拆 `lib/index.js` 的 `apply`（注入顺序本身就是语义）。
- 不动 `lib/patch-*.js` 的文件边界。
- 不删 `acceptsWithoutOurPatch` / `matchLimitation`。
- 不建 GitHub issue。
- 不改版本号、不发布。
