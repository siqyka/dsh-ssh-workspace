# 任务书：右侧文件树里编辑文件（远端 + 本地，版本校验 + 写围栏）

> 本文件是一次性任务书，交给一个**新的 Agent 会话**执行：读完之后直接改代码，不需要重新调研。
> 实现与验收通过后删除本文件，并同时移除 [README.md](./README.md) 里对应的一行索引。
> 背景与取舍见 [03-remote-file-editing.md](./03-remote-file-editing.md)。

## 0. 一句话目标

在右侧 Sidebar 的文件预览头部加一个「编辑」按钮，让**文本文件可以直接改并保存**——
`ssh://` 远端路径与本地绝对路径走**同一条路由**；保存带 `version` + `revision` 双令牌校验
（别人改过就 409，默认不覆盖），写入走既有 mode 门禁与写围栏；不新增文件树、不加前端依赖。

## 1. 起点事实（已核对，不要重新推导）

| 位置 | 事实 |
| --- | --- |
| `@deepseek-ai/dsh-api-workspace-files` README | 「**本服务不提供修改操作**」；方法只有 stat / read / readBytes / list / search / changes |
| 同上，`statOf()` | `absolutePath: this.ctx.fs.processPath(target)` —— 远端目标在这里就是 `ssh://alias/path` 拼写，本地目标是本地绝对路径。**同一个字段** |
| `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` `contract.ts` | `sidebar.right.tab.document.actions` 是已声明的 `kind: 'list'`、`scope: 'session'` 子 slot，owner 为 `{ absolutePath: string }`，渲染在预览自有控件之后 |
| `lib/client.js:12237` | 我们已在 `sidebar.right.tab.files.actions` 注册过组件（`FilePanelTransferActions`），注册写法照抄 |
| `lib/client.js` `modalLayer(children)` | portal 到 `document.body` 的助手；**不 portal 会被侧栏 `.scrollArea` 的 wheel hand-off 吞掉滚轮** |
| `lib/client.js` `.sshwsp-dialog-fill` | 已有布局：头部与表单 `flex: 0 0 auto`，正文是唯一滚动容器 |
| `lib/remote-fs.js:1070` | `async writeText (target, content, expected, signal, sandboxPolicy)` |
| `lib/remote-fs.js:1104` | `async editText (target, edit, expected, signal, sandboxPolicy)` |
| `lib/remote-fs.js:117` | `versionOf(stats)` 返回 `FsVersion('ino:size:mtime')` —— **没有亚秒精度**，同秒同大小改动查不出来 |
| `lib/remote-fs.js:711 / :772 / :881` | `stat` 返回 `{version, type, size}`；`readText` 返回解码文本；`readBytes` 受 `maxBytes` 限制 |
| `lib/remote-fs.js:2189 / :2209 / :2214 / :2221` | `decodeUtf8`（strict）/ `normalizeLineEndings` / `detectLineEndings` / `restoreLineEndings` |
| `lib/remote-fs.js:2019 / :2040 / :2082` | `writeFenceRoots` / `assertWithinRemoteRoots` / `assertFencedRealpath` |
| `lib/mode-gate.js:120 / :151 / :215` | `writeModeRefusal` / `sessionModeOf` / `sessionPolicyOf` |
| `lib/routes.js:2632` | `mutationContextOf(ctx, body)` —— 会话归属的**唯一**入口；root 永不取自请求 |
| `lib/routes.js:2691` | `assertMutationAllowed(ctx, body, target, verb)` |
| `lib/routes.js:3074 / :3087` | `localRootOf(owner)` / `assertLocalParentInside(realRoot, target)` |
| `lib/routes.js:424` | `statusForActionError(error, fallback)` —— **当前没有 `FS_STALE_VERSION` 的 case**，需补 409 |
| `lib/routes.js:2536-2551` | `ROUTES.rename` 的「`isRemotePath(body?.path)` ? 远端 : 本地」分支写法，照抄 |
| `lib/routes.js:97-157` | `ROUTES` 表（33 条），新增三条放这里 |

**关键缺口**：本项目**没有任何读文件内容的 HTTP 路由**。所以要做三条，不是两条。

## 2. 服务端：三条路由

```js
// lib/routes.js 的 ROUTES 表
readText:  '/api/dsh-ssh-workspace/read-text',
writeText: '/api/dsh-ssh-workspace/write-text',
editText:  '/api/dsh-ssh-workspace/edit-text',
```

请求 / 返回：

| 路由 | 请求 | 成功 | 失败 |
| --- | --- | --- | --- |
| `GET read-text` | query: `sessionId`(或 `root`)、`path`、`maxBytes?` | `200 { path, text, eol, revision, version, size, bom, truncated }` | 400 非文本/缺参；403 会话不明或越界；404 不存在；413 超硬上限 |
| `POST write-text` | `{ sessionId, path, text, eol?: 'auto'\|'LF'\|'CRLF', expected: { version, revision } }` | `200 { path, version, revision, bytes }` | 400 缺 `expected`/参数错；403 mode 或归属；404 文件消失；409 `{ error:'stale', current:{ version, revision } }`；413 超限 |
| `POST edit-text` | `{ sessionId, path, edit: { oldText, newText, replaceAll? }, expected }` | 同上 | 同上 + 400 `oldText` 未命中 |

硬要求：

1. **`expected` 缺失即 400**，不允许无校验覆盖；**不提供 `force` 参数**。
2. `ssh://` 与本地绝对路径**共用一条路由**，分支写法照抄 `ROUTES.rename`。
3. 响应**不回显整份文件内容**（`write-text` 只回 `bytes` + 新 `version` + 新 `revision`）。
4. 只监听回环、校验 `Host` 头（沿用 `guard`/`guardRaw`）。
5. `statusForActionError`（`lib/routes.js:424`）**新增** `case 'FS_STALE_VERSION': return 409`。
6. 每次保存写一条审计（路径 + 字节数 + 结果），**不写内容**；读不审计。

### 2.1 校验顺序（不可调换）

```
1. 参数形状（path 非空且绝对、text 是 string、expected 两个字段都是 string）
2. mutationContextOf → 会话归属；无法识别即 403
3. 分支：isRemotePath(path) ? 远端 : 本地
4. 围栏：远端 assertRemoteFence + assertFencedRealpath；本地 localRootOf + isWithinLocalRoot + realpath 后 assertLocalParentInside
5. mode：writeModeRefusal(sessionModeOf(...), path, 'write')  → 403
6. 大小：Buffer.byteLength(text) > EDIT_MAX_BYTES → 413
7. 快检 version：stat 的 version !== expected.version → 409（**不读字节**）
8. 慢检 revision：读当前字节算 sha256，!== expected.revision → 409
9. 写：远端 ctx.fs 的 writeText（`#publish` 已是原子发布）；本地同目录临时文件 + rename
10. 回包：新 version + 新 revision（写完再 stat + 读回算哈希）
```

第 2 步必须在第 4 步之前：围栏要用会话自己的 root，而不是请求里声明的 root。

### 2.2 行尾

- 读：`normalizeLineEndings` 归一成 LF 交给浏览器，同时回 `eol: detectLineEndings(raw)`；
- 写：`eol === 'auto'` 时用**磁盘当前**风格（服务端 `detectLineEndings`），否则用传入值，
  再 `restoreLineEndings` 后落盘；
- **BOM**：`decodeUtf8` 不剥 BOM。实施时必须显式决定：要么原样保留并在响应里标 `bom: true`，
  要么在读路由直接拒绝。**不允许静默丢掉 BOM**——那会让第一次保存就改坏文件。

## 3. 客户端：按钮 + 编辑器

### 3.1 按钮

```js
slots.inject('sidebar.right.tab.document.actions', () => slots.register({
  name: 'sidebar.right.tab.document.actions',
  id: `${PANEL_ID}-edit`,
  inject: () => ({ t: translate, ctx }),
}, FileEditAction))
```

- 只在 `props.absolutePath` 存在、能定位会话、`read-text` 探测为文本且 ≤ 2 MiB 时渲染；
- 探测失败（404/403/400/413）不渲染，**但不要静默**：在按钮位留一个 `title` 说明原因；
- 文案走 i18n（新增键，中英各一条；`locale-register-smoke` 的键集相等断言必须过）。

### 3.2 编辑器对话框

- **必须用 `modalLayer` 包裹**（否则滚轮被侧栏吞掉——这个坑已经修过一次，见 `docs/ui.md`）；
- 布局复用 `.sshwsp-dialog-fill`：头部（文件名 + 未保存标记）与工具条 `flex: 0 0 auto`，
  正文 `<textarea>` 是**唯一滚动容器**（`overflow-y: auto`、`min-height: 0`）；
- 原生 `<textarea>` + 等宽字体 + 行号列；**不引入任何编辑器依赖**，**不做语法高亮**；
- 保存成功后清「未保存」并推进 baseline；**若用户在保存期间继续输入，只推进 baseline，不重载正文**；
- 409：显示「文件已被修改」，给「重新加载」（默认动作）与「覆盖」（次要，再确认一次）。
  「覆盖」的实现是**先 `read-text` 拿新 `{version, revision}`，再 `write-text`**——服务端始终校验。

### 3.2.1 键盘（三个必须显式接，其余白拿）

原生 `<textarea>` 已经给了：`Ctrl/Cmd+A` 全选、复制粘贴剪切、`Ctrl+Z`/`Ctrl+Shift+Z`/`Ctrl+Y` 撤销重做、
按词移动与选中、`Home`/`End`/`Ctrl+Home`/`Ctrl+End`、双击选词、三击选段、IME 中文输入。
**不要**把这些自己实现一遍，也不要改成 `contenteditable`。

必须自己接的三个：

| 键 | 做法 |
| --- | --- |
| `Ctrl/Cmd+S` | `event.preventDefault()` 后保存；不拦截会弹浏览器「另存网页」。已确认项目里没有别的 `Ctrl+S` 绑定 |
| `Esc` | **不要自己挂**。复用 `useDialogA11y`（`lib/client.js:1961`），它在捕获阶段处理 Esc 与焦点环，`busyRef` 会在保存中屏蔽 Esc |
| `Tab` | **必须在 textarea 的 `onKeyDown` 里拦**，否则 `useDialogA11y` 的焦点环（`lib/client.js:1997-2010`）会让 Tab 跳出编辑器 |

`Tab` 的正确写法（保住浏览器撤销栈）：

```js
onKeyDown: (event) => {
  if (event.key !== 'Tab') return
  event.preventDefault()
  const indent = '  '   // 两个空格
  document.execCommand('insertText', false, indent)
  setText(event.currentTarget.value)   // execCommand 之后读 value，不要自己拼
}
```

直接 `setText(value + indent)` 会让 `Ctrl+Z` 跳过这一笔。`Shift+Tab` 反缩进可选，多行整体缩进不做。

### 3.2.2 编码与 BOM

- 判定看内容不看扩展名：前 8192 字节含 NUL → 二进制 → 按钮不渲染。
- `decodeUtf8` 是 strict（`lib/remote-fs.js:2189`）：GBK / GB18030 / UTF-16 / latin-1 一律 `FS_NOT_TEXT`。
  按钮不渲染时 `title` 必须说明「不是 UTF-8 文本」，**不要等点开才报错**。
- **不做编码转换**（猜错就静默改坏文件）。
- **BOM 必须显式处理**：读路由检测到 BOM 回 `bom: true`，写路由按 `bom` 决定是否重新前置 `\uFEFF`
  （推荐）；或在读路由直接 400 拒绝。**不允许默认丢掉**。

### 3.3 状态

```js
{ text, baseText, baseVersion, baseRevision, eol, saving, conflict, error }
```

`dirty = text !== baseText`。回到 `baseText` 时不算脏，但 `baseVersion/baseRevision` 不倒退。

## 4. 权限（不新增例外）

- 只读会话：按钮不渲染 + 服务端 403（双保险）；
- 会话归属：无法识别会话 → 403；root 只从会话读；
- 写围栏：远端已挂载根 + `assertFencedRealpath`；本地 `localRootOf` + `realpath` 防软链；
- 大小上限 `EDIT_MAX_BYTES = 2 * 1024 * 1024`；读可截断并标 `truncated: true`，写超限 413；
- 二进制（前 8192 字节含 NUL）→ `FS_NOT_TEXT`，按钮不渲染；
- 审计不写内容。

## 5. 测试要求

服务端（裸检出可跑，用 `tests/support/fake-sftp.mjs`；若不存在先做 FF-01 §3）：

1. 读：正常返回 text + eol + version + revision；CRLF 文件读出来是 LF 且 `eol === 'CRLF'`；
2. 读：二进制 → 400 `FS_NOT_TEXT`；超 `maxBytes` → `truncated: true`；
3. 写：`expected` 缺失 → 400；
4. 写：`version` 不匹配 → 409 且**文件未被修改**（写完再读一次断言是旧内容）；
5. 写：**同大小、同一秒**的外部改动（`version` 相同但内容不同）→ 409（`revision` 生效）；
6. 写：只读会话 → 403；
7. 写：路径逃逸（`../`、软链）→ 4xx 且文件未写；
8. 写：CRLF 文件保存后仍是 CRLF；LF 文件仍是 LF；
9. 本地分支：同一组用例换成本地绝对路径跑一遍（读 + 写 + 409 + 逃逸）；
10. 审计有一条且不含内容。

客户端（`client-shape-smoke` 风格，源码断言即可）：

11. 按钮注册在 `sidebar.right.tab.document.actions`；
12. 编辑对话框用 `modalLayer` 包裹；
13. 正文是唯一滚动容器（`overflow-y: auto`），头部/工具条 `flex: 0 0 auto`；
14. 409 分支存在，且默认动作是「重新加载」而不是「覆盖」；
15. 源码里**没有** `force` / `skipExpected` 之类的绕过参数；
16. textarea 的 `onKeyDown` 拦了 `Tab` 且用 `execCommand('insertText')` 插入（源码断言：同时出现
    `event.key !== 'Tab'`、`preventDefault`、`insertText`，且**不出现** `setText(value + indent)` 这类手拼）；
17. 对话框**没有**自己再挂一个 `Escape` 的 `keydown`（`useDialogA11y` 已经在捕获阶段处理）；
18. `Ctrl/Cmd+S` 分支调用 `preventDefault`；
19. 读路由的响应含 `bom` 字段（或明确返回 400 拒绝带 BOM 的文件，二选一，不许两者都没有）；
20. 非 UTF-8 时按钮的 `title` 有对应文案键（i18n 中英各一条，`locale-register-smoke` 键集相等）。

## 6. 验收

```bash
npm run lint
npm test
npm run check:docs
```

外加 [03-remote-file-editing.md](./03-remote-file-editing.md) §5 的 18 条判据逐条对照。

## 7. 明确不做

- 不接管宿主的 `sidebar.files.tree`；
- 不引入 CodeMirror / Monaco / highlight.js；
- 不做实时协同、不做远端变化自动刷新编辑器内容；
- 不做多文件标签页；
- 不新增 Agent 工具；
- 不提供 `force` 覆盖参数；
- 不做编码转换（非 UTF-8 直接拒绝，不猜）；
- 不做查找/替换面板；
- 不做多行整体缩进、语法高亮、自动补全；
- 不把 textarea 换成 contenteditable（会丢掉原生选区、撤销栈与 IME）。

## 8. 完成后

1. 删除本文件与 `docs/FF/README.md` 里对应索引行；
2. `CHANGELOG.md` 的 `## [未发布]` 段写一条（版本 + 哈希双校验、409 不覆盖、远端与本地同一条路由、写围栏）；
3. `docs/ui.md` 增一节「文件编辑」；`docs/features.md` 的表格补一行；
4. `docs/development.md` 的 routes-smoke / client-shape-smoke 项数同步；
5. `docs/README.md` 移除对应行。
