# FF-08 任务书：文件树菜单改成「数据模型 + 宿主渲染」

> 一次性任务书。方案见 [08-tree-context-menu.md](./08-tree-context-menu.md)，**先读方案的 §3–§4**（设计 + 行为等价清单），这里只讲起点、顺序与判据。
> 一句话：先把两个菜单的"条目"抽成纯数据，再把渲染器换成「有 `ctx.contextMenus` 就交给宿主，没有就用现有自绘」。

## 起点状态（已核对，2026-11-22 23:05）

- 仓库 `F:\GitHub\dsh-ssh-workspace`，分支 `refactor/code-splitting`，HEAD `35a6f33`（`docs(ff): retire FF-06 and file the new-file task book`），`package.json` 版本 **0.3.6**。
- **工作树有 89 个未提交改动，不是干净起点**（这是另一路正在做的活，不是本任务的）。三件事混在一起：
  1. **FF-07 已实现**：`create-file` 路由（[routes.js:135](../../lib/routes/routes.js)）、`createFileRemoteEntry`（[entries.js:638](../../lib/routes/entries.js)）、`API.createFile`（[client.kernel.js:83](../../lib/client/client.kernel.js)）、`requestRowNewFile`（[client.js:2397](../../lib/client/client.js)）、菜单里的 `newFileItem` / `createFileItem`、`MENU_GLYPH_PATHS.newFile`、`EXPECTED_ROUTES = 37`。
  2. **测试套件合并**：`tests/run.mjs` 的套件数 **103 → 81**，22 个文件被删（`tree-blank-menu-smoke.mjs` 并入 `tree-gestures-smoke.mjs`、`forward-smoke`+`forward-persist-smoke` 合并、`zip-smoke`/`resume-smoke`/`verify-smoke`/`watch-*` 等各并入更大的套件），`tests/support/*` 与 8 个 `scripts/reverse-verify-*.mjs` 随之改路径。
  3. **编辑器引擎**：`editor-engine/` + `lib/client/client.editor-engine.js` + `lib/fs/read-window.js` 未跟踪，`package.json` 新增 `devDependencies`（CodeMirror 六个 `@codemirror/*` + `scripts/build-editor-engine.mjs`，`npm run check` 里多了 `check:editor`）。
- 开工前必须先问用户：**这 89 个改动是否已经落地/提交**。如果它们即将提交，等它们落地再从干净的 HEAD 开工；如果用户要并行，则只允许动 `lib/client/client.js` / `client.kernel.js` / `client.locale.js` / `tests/client-shape-smoke.mjs` / `tests/tree-gestures-smoke.mjs` / `tests/run.mjs` / `docs/*`，**禁止 `git add -A` / `git commit -a`**，只按路径提交。
  - 交叉风险最高的两个：`lib/client/client.locale.js`（本任务要加 `menu.disabledReason` / `menu.actionFailed` 两条文案，那一路也在加键）、`lib/client/client.styles.js`（本任务原则上不碰）。
- 宿主两套可用于验证：
  - 老宿主（**没有** `contextMenus`）：`DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules`（`0.2.1-rc.2`）。
  - 新宿主（**有** `contextMenus`）：`DSH_CORE_ROOT=F:/GitHub/.asar-rc5/dsh/node_modules`（`0.2.2-rc.5`，从 `app.asar` 解出）。
- 关键行号（**2026-11-22 实测，会漂，开工先 `grep -n` 复核**）：`closeTaskMenu` [client.js:2718](../../lib/client/client.js)、`createTransferItem` [:2764](../../lib/client/client.js)、`openMenuAt` [:2797](../../lib/client/client.js)、`openTaskMenu` [:2855](../../lib/client/client.js)、`openLocalBlankMenu` [:2997](../../lib/client/client.js)、三处触发 [:3294](../../lib/client/client.js) / [:3321](../../lib/client/client.js) / [:3353](../../lib/client/client.js)、右键守卫（`TASK_MENU_ATTR` 的 `closest`）在 `:3353` 之前的 `onContextMenu` 里、客户端 `inject` [:4007](../../lib/client/client.js)；`nextMenuIndex` [client.kernel.js:243](../../lib/client/client.kernel.js)、`TASK_MENU_ATTR` [:563](../../lib/client/client.kernel.js)、`mutationPolicyOf` [:2129](../../lib/client/client.kernel.js)、`MENU_GLYPH_PATHS` [:2262](../../lib/client/client.kernel.js)、`createMenuSeparator` [:2302](../../lib/client/client.kernel.js)。

## 任务 1 —— 抽模型（纯重构，行为零变化）

在 `lib/client/client.js` 里（菜单段旁边，不要新建 chunk：这里没有懒加载需求）：

```js
function rowMenuModel ({ ctx, absPath, isDir, root, sessionId, selection, policy, blank })
  -> [{ id, label, glyph, disabled, reason, danger, separatorBefore, run }]
function blankMenuModel ({ target, policy }) -> [ ... ]
```

要求：

1. **逐条搬**：`openTaskMenu` 与 `openLocalBlankMenu` 里每一个 `createTransferItem({...})` 都对应一条 descriptor，顺序、条件、分隔线位置、禁用条件与理由文本**一字不差**。现有数量是 `openTaskMenu` **8 处**（加入任务 / 下载 / 上传 / 复制路径 / **新建文件** / **新建文件夹** / 重命名 / 删除），`openLocalBlankMenu` **3 处**（新建文件 / 新建文件夹 / 复制路径），全文件合计 **11 处**——搬完用 `grep -c 'createTransferItem('` 对一遍，少一处就是漏了 FF-07 的 `new-file`。别顺手"改进"顺序或合并项。
2. `run` 直接复用现有函数（`addPathsToTask` / `downloadRows` / `uploadTreeRow` / `copyRowPath` / `requestRowNewFile` / `requestRowNewFolder` / `requestRowRename` / `requestRowDelete`），不重写动作。
3. **模型不发起请求**：`policy` 由调用方传入；`mutationPolicyOf` 仍在调用方（本次先保持"先画后禁用"的原行为，缓存放到任务 4）。
4. `id` 用短名（`add-to-task` / `download` / `upload` / `copy-path` / `new-folder` / `rename` / `delete`），全表唯一。
5. 两个 `open*Menu` 改成「建模型 → `renderMenuDom(model, x, y)`」，DOM 渲染器就是今天的 `openMenuAt` + `createTransferItem`，`reason` 仍写 `title`。

**这一步跑完，所有既有套件必须与改动前逐字相同**（`=== N passed, 0 failed ===` 的数字不变）。做不到就说明模型没抽干净，不要进入下一步。

## 任务 2 —— 宿主渲染器

新增（同一文件内，靠近菜单段）：

```js
function hostMenusOf (ctx) { try { return ctx.get?.('contextMenus') ?? null } catch { return null } }
function registerHostMenuProvider (ctx, menus)   // 幂等：已注册就 return
function openHostMenu (menus, model, value, x, y)
```

要求：

1. **不写进 `inject`**：`inject = ['slots', 'locale']` 保持不动。老宿主上没有这个服务，写进 inject 会让整个客户端插件不加载。
2. `register({ id: 'ssh-workspace.tree', target: 'ssh-workspace.files', order: 100, resolve })`；`resolve(value, signal)` **只调模型、不发请求**，把 descriptor 转成宿主条目：
   - `{ id, label, disabled, danger, separatorBefore }` 直传；
   - `label` 在 `disabled && reason` 时追加后缀，模板用新 key `menu.disabledReason`（`{label}（{reason}）` / `{label} ({reason})`）；
   - `icon: { key: 'ssh-workspace:<glyph>' }`；
   - `run: descriptor.run`；`failureLabel: translate('menu.actionFailed')`。
3. `open(target, point)` 的 `target = { kind: 'ssh-workspace.files', value }`，`value` 带上模型需要的一切：`{ blank, path, isDir, root, sessionId, selection }`。**不要**在 `resolve` 里回头读 DOM。
4. 注册必须可重入（HMR）：用模块级 `let hostProviderDisposed = null`，重装前先 `dispose()`。
5. 图标：把 `MENU_GLYPH_PATHS` 注册进 `contextMenu.icon`（`ctx.slots.inject('contextMenu.icon', function* () { … yield ctx.slots.register({ name: 'contextMenu.icon', key }, Icon) })`，`Icon` 由 `jsx('svg', …)` 现造）。**注册失败要吞掉并继续**（老宿主没这个 slot），图标不是验收条件。
6. 只有 `ctx.get('contextMenus')` 拿到对象时才注册 provider；拿不到就什么都不做，走 DOM 渲染器。

## 任务 3 —— 触发点与守卫

1. 三处入口改成统一的 `openTreeMenu(model, x, y)`：有 `menus` 走 `openHostMenu`，否则 `renderMenuDom`。
2. 右键守卫（[client.js:3240](../../lib/client/client.js) 一带）从 `target.closest('[data-sshwsp-taskmenu]')` 扩成"两个属性任一命中"，否则在宿主菜单里按右键会重开我们的菜单。
3. `closeTaskMenu()` 与 HMR dispose 里补 `menus?.close?.()`。
4. `tree-gestures-smoke` 里钉"调用了 `openTaskMenu`"的形状断言改成"调用了 `openTreeMenu`"。

## 任务 4 —— 只读策略缓存

`mutationPolicyOf` 每次都是一次 `fetchJson`，而宿主 `resolve` 只有 **1000 ms** 预算，缓存是必需的：

1. 加模块级 `Map`：键 `${sessionId}|${root}`，值 `{ policy, at }`，`TTL = 30_000`。
2. 三个现有调用点（[client.js:2968](../../lib/client/client.js) / [:3020](../../lib/client/client.js) / [:3388](../../lib/client/client.js)）统一走 `policyOf(claim)`（读缓存或发起）。
3. 宿主路径的 `resolve` **只读缓存**：未命中就返回"全部可用"的模型，并在后台 `void policyOf(...)` 填充；命中就把只读/本地根未知的三项禁用。

## 任务 5 —— 测试

1. **新增** `tests/tree-menu-model-smoke.mjs`（约 46 项，登记进 [tests/run.mjs](../../tests/run.mjs) 的 `SUITES`，放在 `'tree-gestures'` 之后）：
   - `rowMenuModel` 的顺序与分隔线位置；远端行 vs 本地行的条件项；多选时下载/删除作用于整个目标集；`id` 唯一。
   - **`new-file` 单独两条**：远端正目录行有、本地行没有；本地空白处有且与 `new-folder` 同组。
   - `policy` 三种状态：正常、`readOnly`（**四项**禁用：新建文件/新建文件夹/重命名/删除，理由正确）、`sessionFound: false` 且本地路径（同样禁用，理由不同）。
   - `blankMenuModel` **三项**与禁用条件（两个创建项被禁用、`copy-path` 永不禁用）。
   - 宿主路径用**假 `contextMenus`**：注册的 `target`/`id`；`resolve` 返回条目字段合法、禁用项 label 带后缀、`run` 是函数；**未提供 `contextMenus` 时不注册 provider**；`open` 收到的 `value` 与打开时的选择一致。
   - 断言 `resolve` 里**没有** `fetch`（它的源码片段不含 `fetchJson`）。
2. `tests/client-shape-smoke.mjs`（现 309 项）里钉菜单 DOM 的那 21 条：删掉逐项 `translate('rowmenu.*')` 的字符串扫描（模型套件已覆盖），保留/新增结构断言（两个渲染器都存在、`inject` 没有多一个名字）。**删一条必须补一条**。
3. `tests/tree-gestures-smoke.mjs`：它现在装着**两段**菜单断言——文件树手势段与 `=== tree blank menu smoke ===` 段（后者是原来的 `tests/tree-blank-menu-smoke.mjs` 并入的，含「本地空白菜单恰好三项」与 `requestRowNewFile` / `requestRowNewFolder` 的源码断言）。迁到模型后这两段一起改成读模型，别只改前半段。
3. 反向验证（评审动作，写完再跑，改坏源文件后必须逐字节还原）：
   - ① 能力探测改成恒真 → 老宿主断言必须红；
   - ② 去掉禁用项的 label 后缀 → 模型/宿主条目断言必须红；
   - ③ 把 `resolve` 改成 `await mutationPolicyOf(...)` → "resolve 不发请求"的断言必须红；
   - ④ 去掉 `[data-context-menu]` 守卫 → 守卫断言必须红。

## 任务 6 —— 文档

- `docs/ui.md` 的文件树菜单一节：写清"有宿主菜单服务时由宿主渲染，没有时自绘"，以及禁用项理由改成 label 后缀（不再有 tooltip）。
- `docs/architecture.md` 的客户端桥接一节：加一段"菜单模型 + 双渲染器"。
- `docs/development.md` 的套件表：新增 `tree-menu-model-smoke` 一行（N 项）；`tests/client-shape-smoke.mjs` 的数字若变了同步。
- `CHANGELOG.md` `## [未发布]`：`### 变更` 下一条（说清"外观/键盘交给宿主，老宿主行为不变"）。
- 完成后删除本文件与方案文件，`docs/FF/README.md` 表格移除 08 行、在「已完成的工作流」补一行；`docs/README.md` 里 `FF/README.md` 那行按当时的实际情况改（若 FF-07 那时也已提交，就该是"本目录现已为空"）。

## 硬要求

1. **不动后端**：不改 `lib/routes/**`、`lib/engine/**`、任何路由/工具/诊断形状。本任务只碰客户端菜单。
2. **不动选择与拖拽**：`reduceTree` / `applyTreeSelection` / 拖拽桥一行不改（右键当选择手势的调用点只是被搬到 `openTreeMenu` 之前，逻辑不变）。
3. **不新增依赖**：React 已在 bundle 里 `require`（[client.js:7](../../lib/client/client.js)），不要再 require 别的东西。
4. **必须保留 DOM 渲染器**：`peerDependencies` 写的是 `@deepseek-ai/dsh >= 0.2.0-rc.1`，老宿主还在支持范围内。
5. **不留迁移史注释**：按 `CONTRIBUTING.md`，写"做什么/为什么/危险处"，不写"原来是这样"。
6. 源码扫描锚点（`tests/*.mjs`、`scripts/reverse-verify-*.mjs`）在同一个 commit 内同步更新。
7. 建议两个 commit：`refactor(client): menu items as data` + `feat(client): render the tree menu with the host context menu`。

## 验收命令

```sh
node scripts/lint.mjs
node tests/tree-menu-model-smoke.mjs
node tests/client-shape-smoke.mjs
node tests/tree-gestures-smoke.mjs
node tests/selection-targets-smoke.mjs
node tests/mutations-smoke.mjs
node scripts/doc-numbers.mjs --assertions <新总数>
node scripts/doc-numbers.mjs --check
node scripts/check-doc-links.mjs
node scripts/client-map.mjs --check

# 老宿主（无 contextMenus）：DOM 路径，行为必须与改动前一致
DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules node tests/run.mjs
# 新宿主（有 contextMenus）：宿主路径
DSH_CORE_ROOT=F:/GitHub/.asar-rc5/dsh/node_modules node tests/run.mjs
```

> 注意：如果那时工作树里还压着别的未提交工作（比如编辑引擎那路），`run.mjs` 的失败要与那次改动的基线对齐后再判断——先记录基线，再比较，别把别人的红算到自己头上。

## 不做什么

- 不做多选、不做拖拽、不做"菜单项贡献给 `file` target"的实验（方案 §3.7 只是记账）。
- 不重写 `useMenuKeyboard` 的其他使用者，不删 `.sshwsp-flowmenu` 系列 CSS。
- 不改 `translate` 的 key 命名规则，不新增语言（只 zh + en）。
- 不因为迁移就改任何动作的语义（下载/上传/重命名/删除/新建文件夹的请求体、围栏、确认框都不动）。
- 不在本次抬高 `peerDependencies` 最低版本；删 DOM 渲染器是更后面的事。

## 完成判据

- [ ] 老宿主（`0.2.1-rc.2`）上右键菜单的行为与改动前**逐项一致**（含禁用项、分隔线、焦点归还、Esc/方向键）。
- [ ] 新宿主（`0.2.2-rc.5`）上菜单由宿主渲染：外观与宿主其他菜单一致，`Esc`/方向键/外部点击正常，图标在（或明确记录"图标未生效及原因"）。
- [ ] 只读时三项禁用，且**理由在 label 里可见**；宿主路径不因策略查询超时（不再出现宿主 1 s 超时的失败提示）。
- [ ] 右键点在自己菜单（宿主或自绘）内部不会重开菜单。
- [ ] 四条反向验证都真红，恢复后全绿；`git status --short` 与开工前相比只多出本任务的文件。
- [ ] 两套宿主下 `run.mjs` 都是 0 failed（或失败与本次改动无关且已说明）。

## 报告格式

按编号给：**期望 → 实际 → PASS/FAIL**。代码落点写 `文件:行`。测试结果给逐套件的
`=== N passed, M failed ===` 与两套宿主 `run.mjs` 的收尾行原样输出。最后一段写剩余风险：
至少要说清"老宿主上仍是自绘菜单"、"禁用项理由从 tooltip 变成 label 后缀"、
"策略缓存最长滞后 30 秒"这三条，以及在真实 GUI 里怎么手工验一遍（右键远端行 / 右键空白 / 只读会话）。
