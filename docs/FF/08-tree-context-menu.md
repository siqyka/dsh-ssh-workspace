# FF-08 方案：文件树菜单改成「数据模型 + 宿主渲染」

> 状态：**方案**（2026-11-22 定稿）。任务书见 [08-tree-context-menu-prompt.md](./08-tree-context-menu-prompt.md)。
> 一行结论：把右侧文件树的右键菜单从「直接拼 DOM」改成「先产出条目模型，再由渲染器画」，渲染器有两个——宿主 `contextMenus`（rc.5 起可用）与现有的自绘实现（老宿主）。

## 0. 先说清楚收益，别夸大

这一项**不会**让代码变少。只要 `peerDependencies` 还写着 `@deepseek-ai/dsh >= 0.2.0-rc.1`，我们就必须保留自绘菜单作为老宿主的降级路径，两条渲染器并存比今天多。真正删掉自绘路径的那一天，是"最低宿主版本抬到 `0.2.2-rc.5`"的那一天。

那为什么还做：

1. **菜单变成数据**之后，加一项是加一条 descriptor，而不是再拼五个 DOM 节点、再补一条 CSS、再改一条源码扫描断言。`FF-07`（新建文件）正好要加三项，写在旧结构上等于把同一个菜单写两遍。
2. **外观与键盘行为跟宿主一致**：宿主菜单自带 portal、焦点陷阱、方向键、子菜单、外部点击关闭、`Esc` 归还焦点。自绘版本能跑，但每次 DSH 改菜单样式我们都落后一版。
3. **失败提示有统一出口**：宿主在 `run` 返回的 Promise 拒绝时用 `failureLabel` 出提示，不必每个动作自己接。
4. 为"将来把菜单项贡献给别的 target"留好位置（`file` target 已由 `dsh-client-ui-file-actions` 占着，见 §5.7 的实验项）。

## 1. 现状（2026-11-22 实测行号）

三处入口，一个渲染器：

| 入口 | 位置 | 现在的行为 |
| --- | --- | --- |
| 行菜单（右键行） | [client.js:3294](../../lib/client/client.js) `openTaskMenu(ctx, path, kind === 'directory', treeRootOf(row), x, y, undefined, { items: selected })` | 先把右键当**选择手势**喂 `reduceTree` 的 `point`，再取 `treeSelectedItems` |
| 远端空白处（面板目录） | [client.js:3321](../../lib/client/client.js) `openTaskMenu(ctx, absPath, true, scope.root, event.clientX, event.clientY)` | 目录来自面板头部按钮解析出的 alias+dir |
| 本地空白处 | [client.js:3353](../../lib/client/client.js) `openLocalBlankMenu(local, event.clientX, event.clientY)` | **三项**：新建文件、新建文件夹、复制路径（新建文件是刚落地、尚未提交的 FF-07） |

> 菜单里已经有「新建文件」（FF-07 在**工作树里**已实现，见 §8）：行菜单只在远端目录行给，空白处三项都给。抽模型时它必须一起搬，不能漏。

渲染器与生命周期：`createTransferItem`（[:2764](../../lib/client/client.js)）造 `button.sshwsp-menuitem`；`openMenuAt`（[:2797](../../lib/client/client.js)）负责定位夹取、`role="menu"`、首个可用项聚焦、方向键（`nextMenuIndex`，[client.kernel.js:243](../../lib/client/client.kernel.js)）、`Esc`/`Tab` 关闭、外部点击/滚动/resize/blur 关闭；`closeTaskMenu`（[:2718](../../lib/client/client.js)）把焦点还给开启者。菜单元素带 `data-sshwsp-taskmenu`（`TASK_MENU_ATTR`，[client.kernel.js:563](../../lib/client/client.kernel.js)），右键守卫靠它判断"点在自己菜单上"。

两个必须平移的**行为契约**：

- **禁用项带理由**：`createTransferItem({ disabled, reason })` 把理由写进 `title`（tooltip）。只读时「新建文件/新建文件夹/重命名/删除」被禁用并给 `rowmenu.readonly`；本地根未知时给 `rowmenu.localRootUnknown`；不可下载时给 `transfer.notRemote`；不可加入任务时给 `mention.unrepresentable`。
- **只读策略是异步查的**：`mutationPolicyOf`（[client.kernel.js:2124](../../lib/client/client.kernel.js)）每次 `fetchJson(API.mutationPolicy)`，**没有缓存**。现在菜单先画、策略回来再禁用（`void ... .then()`）。

样式：[client.styles.js:384-390](../../lib/client/client.styles.js) 的 `.sshwsp-flowmenu` / `.sshwsp-menuitem*`（含 `-roomy` 变体与 `sshwsp-menu-in` 动画）。

测试现状：`tests/client-shape-smoke.mjs` 约有 21 条**源码扫描**断言钉这套 DOM 实现（[`:1099-1236`](../../tests/client-shape-smoke.mjs) 一带：首个可用项聚焦、`nextMenuIndex`、条目数量上限、分隔线数量、CSS 尺寸）；`tests/tree-gestures-smoke.mjs` 与 `tests/selection-targets-smoke.mjs` 各钉了触发路径的少量形状。**没有** `tree-blank-menu-smoke` —— FF-07 任务书里引用的那个套件不存在，空白菜单的覆盖在 `tree-gestures-smoke`。

## 2. 宿主能力（`0.2.2-rc.5`，从 `app.asar` 解出核对）

宿主客户端 `@deepseek-ai/dsh-client-ui-context-menu` 提供 `ctx.contextMenus`：

```js
register({ id, target, order?, observe?, resolve }): () => void
open(target, point, options?)        // target = { kind, value }, point = { x, y }
resolve(target)                      // 调试用
notify(message, ok?)                 // 菜单上的一条成功/失败提示
close()
```

- `target.kind` 是**字符串种类**（运行时不校验，宿主自己的类型里由 `ContextMenuTargetMap` 声明合并；已有先例 `'file'`，值为 `{ sessionId, path }`）。
- `resolve(value, signal)` 可以返回 Promise，宿主给 **1000 ms**（`resolutionTimeoutMs` 默认 `1e3`）后中止并提示失败。
- **条目字段**（构造于 `menuEntries`）：`{ id, label, disabled?, danger?, icon?: { key }, children?, separatorBefore?, commandId? }`；另有 `run?()` 与 `failureLabel?`，宿主在点击时执行 `run`，Promise 拒绝就用 `failureLabel` 出提示。**没有 `title`/`description` 字段**。
- 图标走 slot：`renderSlot('contextMenu.icon', { icon })`。宿主自己的做法（`file-actions`）是 `ctx.slots.inject('contextMenu.icon', function*(){ … yield ctx.slots.register({ name: 'contextMenu.icon', key }, Icon) })`，`Icon` 是 React 组件——我们的 bundle 已经 `require('react')`（[client.js:7](../../lib/client/client.js)），能照做。
- 菜单 DOM 带 `[data-context-menu]`（宿主用它判断焦点是否在菜单里）。
- **宿主文件树自己没有接菜单**：`dsh-client-ui-sidebar-files/lib/client.js` 里 `contextMenu` / `onContextMenu` / `dragstart` / `dataTransfer` 全部 0 命中。也就是说"注册 provider"只在一件事上生效——**我们自己调用 `open()`**。这是本方案的关键前提：迁移的是渲染器，不是"让宿主给我们一个菜单钩子"。

## 3. 设计

### 3.1 模型（Phase A，与渲染器无关）

把两个 `open*Menu` 里"决定有哪些项"的部分抽成纯函数，返回 descriptor 数组：

```js
rowMenuModel({ ctx, absPath, isDir, root, sessionId, selection, policy })
  -> [{ id, label, glyph, disabled?, reason?, danger?, separatorBefore?, run? }]
blankMenuModel({ target, policy }) -> [...]
```

- `id` 用稳定短名（`add-to-task` / `download` / `upload` / `copy-path` / `new-file` / `new-folder` / `rename` / `delete`），宿主会把它们拼成 `providerId/id` 做去重键。
- `run` 保持**现有实现原样**（`addPathsToTask` / `downloadRows` / `uploadTreeRow` / `copyRowPath` / `requestRowNewFolder` / `requestRowRename` / `requestRowDelete`）；本方案不动这些动作，只搬运它们。
- 顺序、分隔线、条件项（`if (remote !== null)`）原样搬进模型，**逐条对照 §4 的等价清单**。
- `policy` 由调用方传入，模型本身不发起请求（可测）。

### 3.2 两个渲染器

- **DOM 渲染器**（默认、老宿主）：`renderMenuDom(model, x, y)` = 今天的 `openMenuAt` + `createTransferItem`，只是输入从"回调里 append"改成"读模型"。`reason` 继续写 `title`，所以老宿主上行为一字不变。
- **宿主渲染器**（`ctx.get('contextMenus') !== undefined`）：注册一个 provider（`id: 'ssh-workspace.tree'`，`target: 'ssh-workspace.files'`，`order: 100`），`open()` 时把 `{ kind, path, isDir, root, sessionId, blank, selection }` 作为 `value` 传进去；`resolve` 里调同一个模型函数再**转成宿主条目**（`glyph → icon.key`、`reason + disabled → label 后缀`、`onSelect → run`）。

能力探测**不要写进 `inject` 列表**（那是硬依赖，老宿主上会让我们整个客户端插件不加载）：[client.js:3918](../../lib/client/client.js) 的 `inject = ['slots', 'locale']` 保持不动，用 `ctx.get('contextMenus')` 在调用点取，取不到就走 DOM 渲染器。

### 3.3 触发点改造

三处入口只改"把模型交给谁"：

```js
openTreeMenu(model, x, y)   // = menus !== null ? openHost(model, x, y) : renderMenuDom(model, x, y)
```

此外：

- 右键守卫 `target.closest('[data-sshwsp-taskmenu]')`（[:3240](../../lib/client/client.js)）要改成"`[data-sshwsp-taskmenu]` **或** `[data-context-menu]`"，否则在宿主菜单里点右键会重新打开我们的菜单。
- 卸载/热重载收尾：`closeTaskMenu()` 之外增加 `menus?.close?.()`（宿主菜单是 portal，不 close 会留在 DOM 里）。
- 键盘路径（`openMenuAt` 之后的 `useMenuKeyboard` 那一路）不变：它调用的还是 `openForRow` / `openForBlank`。

### 3.4 图标

优先做：注册 `MENU_GLYPH_PATHS`（[client.kernel.js:2257](../../lib/client/client.kernel.js)）到 `contextMenu.icon`，key 形如 `ssh-workspace:newFolder`。一个工厂就够：

```js
const iconComponent = paths => function SshwspMenuIcon () {
  return jsx('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
    paths.map((d, index) => jsx('path', { key: index, d })))
}
```

若注册失败（老宿主没有这个 slot），条目只是**没有图标**，不报错、不阻塞——所以图标不是验收条件。

### 3.5 禁用理由与失败反馈（本方案唯一的观感取舍）

宿主条目没有 tooltip。三条处理：

1. **禁用项**：理由写进 label 后缀，形如 `新建文件夹（只读）`。理由文本复用现有 key（`rowmenu.readonly` / `rowmenu.localRootUnknown`），后缀模板新增一个 key（`menu.disabledReason`，zh/en 各一条）。这是唯一丢失不自明的信息，所以必须补。
2. **启用项的 `reason`**：直接丢弃。它今天是路径预览（`copyPath` 的目标、`upload` 的目的目录），不是必须项——上传目的目录在后续对话框副标题里还会出现一次。
3. **动作失败**：仍然由动作自己处理（我们有自己的 toast 与详情面板）；`failureLabel` 只作为兜底文案（`menu.actionFailed`），防止某个动作 reject 后静默。

### 3.6 只读策略缓存（必须做，否则菜单会卡 1 秒）

`resolve` 有 1000 ms 预算，而 `mutationPolicyOf` 是一次网络请求且**无缓存**。新增一个模块级缓存：

- 键 `sessionId|root`，值 `{ policy, at }`，TTL 30 s；
- 三个现有调用点（[:2968](../../lib/client/client.js)、[:3020](../../lib/client/client.js)、[:3388](../../lib/client/client.js)）统一走缓存读取；
- `resolve` **只读缓存**，未命中时返回"全部可用"的模型，并在后台发起一次填充（下一次右键就准了）；
- 模式变化（用户在 DSH 里切 sandbox mode）不在本次监听范围——TTL 到期即可，最坏情况是一次点击被服务端拒绝，边界仍是服务端。

### 3.7 与 `file` target 的关系（不做，只记一笔）

`dsh-client-ui-file-actions` 往 `target: 'file'` 注册了「保存原件 / 复制图片」。理论上我们的行菜单可以 `open({ kind: 'file', value: { sessionId, path } })` 从而白拿这两项，但它的 `resolve` 会用 `ctx.remote.workspaceFiles.stat(sessionId, path)` 取绝对路径，**远端会话下这条链路没有验证过**。本方案不混入，另立实验项。

## 4. 行为等价清单（迁移后逐条对照）

| # | 行为 | 现在的实现 | 迁移后 |
| --- | --- | --- | --- |
| 1 | 行菜单第一项「加入任务」，选择不可表示时禁用并说明 | `mentionToken` / `addable` | 模型里同一判断，禁用理由进 label |
| 2 | 分隔线：第一项之后一条 | `createMenuSeparator` | `separatorBefore` |
| 3 | 「下载」恒在，非远端时禁用并说明 | `downloadable.length === 0` | 同上 |
| 4 | 远端行才有「上传」「复制路径」 | `if (remote !== null)` | 模型条件项 |
| 5 | 破坏性一组之前再一条分隔线 | `lastBeforeDestructive` 判断 | 模型里 `separatorBefore` 显式给 |
| 6 | 「新建文件夹」只在远端目录行 | `remote !== null && isDir` | 同 |
| 7 | 只读/本地根未知时禁用四项（新建文件/新建文件夹/重命名/删除）并说明 | `mutationPolicyOf().then` | 缓存 + label 后缀 |
| 8 | 远端面板空白处 = **目录行的完整菜单**（`isDir: true`，下载/上传/复制路径/新建文件夹/重命名/删除都在） | `openForBlank` → `openTaskMenu(…, true, …)` | 同一个模型，只多一个 `blank: true` 标记 |
| 9 | 本地空白处 = 新建文件夹 + 复制路径 | `openLocalBlankMenu` | `blankMenuModel` |
| 10 | `Esc` / 方向键 / 外部点击 / 焦点归还 | `openMenuAt` + `closeTaskMenu` | 宿主 `Menu` 自带；DOM 路径保持 |
| 11 | 右键在选择上的行：先合并选择再开菜单 | `reduceTree({type:'point'})` | 不变（在触发点，不在模型） |
| 12 | 点自己菜单内部不再触发右键菜单 | `[data-sshwsp-taskmenu]` | 加 `[data-context-menu]` |
| 13 | 「新建文件」只在远端目录行出现（本地行由宿主树负责） | `remote !== null && isDir` | 同 |
| 14 | 本地空白处三项：新建文件、新建文件夹、复制路径 | `openLocalBlankMenu` | 同，且两个创建项共用一条策略禁用规则 |

> 第 8 条的准确形状以 `openTaskMenu` 的现有分支为准：空白处传的是"目录本身"（`isDir` 为真、`remote !== null`），所以下载、上传、复制路径、新建文件夹、重命名、删除**都会出现**。迁移时必须逐项复现，不能凭本表简化。

## 5. 测试策略

原则：**把"扫描源码找字符串"的断言换成"跑模型看数据"的断言**，只在渲染器自己的套件里保留少量 DOM 断言。

- 新增 `tests/tree-menu-model-smoke.mjs`（约 40 项）：`rowMenuModel` / `blankMenuModel` 的顺序、条件项、禁用与理由、`id` 唯一性、`policy` 生效（只读 / 本地根未知）、选择集（多选时下载/删除作用于整个目标集）。
- `tests/client-shape-smoke.mjs` 的 21 条：保留"存在 `openTreeMenu` 且两个渲染器都注册"这类结构断言，删掉逐项 `translate('rowmenu.copyPath')` 的字符串扫描（模型套件已经钉住它们）。
- `tests/tree-gestures-smoke.mjs`：右键触发的形状断言改成"调用了 `openTreeMenu`"，不再要求 `openMenuAt`。
- 新增宿主路径断言（在 `tree-menu-model-smoke` 里用假 `contextMenus` 对象）：provider 注册的 `target`/`id`；`resolve` 返回条目字段合法（`id`/`label` 必有，`separatorBefore` 位置正确，`run` 是函数）；禁用项 label 带理由后缀；**未提供 `contextMenus` 时不注册、且走 DOM 路径**。
- 反向验证 4 条（改坏必须变红）：① 把能力探测改成恒真（老宿主上应红）；② 去掉 label 理由后缀；③ 把 `resolve` 改成 `await mutationPolicyOf(...)`（应被"resolve 不发起请求"的断言抓住）；④ 去掉 `[data-context-menu]` 守卫。

## 6. 不做什么

- 不动多选、拖拽、路由与任何服务端代码（FF-07 的 §2 与本方案无关）。
- 不迁移 `useMenuKeyboard` 的其他使用者（`client.add-workspace.js` 等），只迁文件树的三个入口。
- 不把菜单项贡献给宿主的 `file` target（§3.7 的实验项）。
- 不引入新依赖、不做构建步骤（React 已经在 bundle 里 `require` 过）。
- 不因为迁移就删 CSS：DOM 路径还在用，删 CSS 要等最低宿主版本抬上去。

## 7. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 宿主菜单 API 在后续 rc 变动（字段/超时/notify） | 全部访问集中在 `openHostMenu` 一个函数里；字段转换逐项断言 |
| `ctx.get('contextMenus')` 在老宿主返回 `undefined` 但抛错（strict 模式） | 用 `try { ctx.get(...) } catch { null }`，且**不**写进 `inject` |
| 宿主菜单拦截右键导致我们的守卫打架 | 守卫同时认 `[data-context-menu]`，另加一条套件断言 |
| 策略缓存导致只读状态滞后 30 s | 点击仍由服务端拒绝；刷新面板或重开菜单可强制（TTL 到期） |
| 观测不到宿主菜单（无 DOM 钩子）导致行为测试退化 | 行为断言全部落在模型层与假 `contextMenus` 上，不依赖真实宿主 |

回滚：入口处一个开关（`const HOST_MENUS = ...`）即可退回 DOM 渲染器；模型层可独立保留。

## 8. 与 FF-07 的关系（FF-07 已经在工作树里落地了）

核对结果：FF-07 **已实现但尚未提交**（2026-11-22 实测）——`lib/routes/routes.js:135` 有 `createFile: '/api/dsh-ssh-workspace/create-file'`，`lib/routes/entries.js:638` 是 `createFileRemoteEntry`，`lib/client/client.kernel.js:83` 有 `API.createFile`，`lib/client/client.js:2397` 是 `requestRowNewFile`，行菜单 `newFileItem` 与空白处 `createFileItem` 都在，`MENU_GLYPH_PATHS` 有 `newFile`，locale 两本字典共 10 处 `rowmenu.new*`，`tests/lifecycle-smoke.mjs:71` 的 `EXPECTED_ROUTES` 已改成 **37**。

所以：

- **不存在"先 08 还是先 07"的排序问题**：08 只是把已经存在的菜单项搬进模型，`newFile` 与 `newFolder` 、`rename`、`delete` 一起搬，一行不能少。
- **07 的任务书不要再去改**。它写的 `tests/tree-blank-menu-smoke.mjs`（"恰好两项"→三项）在 HEAD 上确实存在（`git show HEAD:tests/tree-blank-menu-smoke.mjs:297` 就是 `length === 2`），而工作树里那个套件已被并入 `tests/tree-gestures-smoke.mjs`（同一段，现在断言三项）。07 提交后按惯例删掉 `07-new-file-prompt.md`、`docs/FF/README.md` 里把 07 行移到「已完成」，把 08 提成唯一待实施项。
- 08 的模型套件因此要把「新建文件」的两条（远端目录行 / 本地空白处）单独钉住，避免以后有人只搬旧项、漏掉这一条。

## 9. 验收判据

1. 模型套件与既有套件全绿；`client-shape` 里被删掉的断言都有对应的模型断言顶上（删一条补一条，不能净少）。
2. 在 `0.2.1-rc.2`（无 `contextMenus`）与 `0.2.2-rc.5`（有）两套宿主下各跑一次 `run.mjs`：前者走 DOM 路径且行为不变，后者走宿主路径。
3. 反向验证 4 条全部按期望变红。
4. 文档：`docs/ui.md` 的菜单一节、`docs/architecture.md` 的客户端桥接一节、`docs/development.md` 的套件表（新增套件的断言数）、`CHANGELOG.md` 未发布段。
