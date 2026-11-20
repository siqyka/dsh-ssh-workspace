# FF-03 右侧文件树的文件编辑（远端与本地）

> 状态：方案（未实施，2026-11-20 修订）· 任务书见 [03-remote-file-editing-prompt.md](./03-remote-file-editing-prompt.md)
> 本辑回答：**宿主的文件面板为什么只能看不能改**、**编辑能力该挂在哪**、**怎么保证改的是用户看到的那一版**、
> **本地与远端为什么必须是同一条路**。

## 0. 一句话目标

让右侧 Sidebar 文件预览里打开的**文本文件可以直接编辑并保存**——远端 `ssh://` 路径与本地绝对路径走**同一条路由**，
保存带版本校验（别人改过就 409，默认不覆盖），写入走既有 mode 门禁与写围栏，不新增第二套文件树、不加前端依赖。

## 1. 现状：面板是「只读」的，而且不是我们的选择

| 事实 | 出处 |
| --- | --- |
| 文件页正文由宿主注册，key 为 `@deepseek-ai/dsh-client-ui-sidebar-files` | `sidebar.right.pane.tab` slot |
| 预览正文由 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 注册，kind `text`，档位 `fallback` | 同上 |
| 宿主文件服务**不提供修改操作** | `@deepseek-ai/dsh-api-workspace-files` README：「本服务不提供修改操作」 |
| 该服务的方法只有 stat / read / readBytes / list / search / changes | 同上 |
| 读取走 `ctx.fs` | 服务用 Session 文件系统解析路径，本项目已接管 `ctx.fs` |
| 预览头部**已声明**一个动作位 | `sidebar.right.tab.document.actions`，`kind: list`、`scope: session`、owner 为 `{ absolutePath }` |

所以：**读**这条链已经通了（远端文件能在预览里正常显示），**写**这条链宿主根本没有出口。
这不是宿主缺陷，是它有意的边界——写要经过 sandbox policy 与版本校验，那是 Agent 工具的事。

## 2. 我们已经有的写能力（不要重写）

| 能力 | 位置 |
| --- | --- |
| `ctx.fs.writeText(target, content, expected, signal, sandboxPolicy)` | `lib/remote-fs.js:1070` |
| `ctx.fs.editText(target, edit, expected, signal, sandboxPolicy)` | `lib/remote-fs.js:1104` |
| 版本冲突语义（`expected.kind === 'replaceIfVersion'` 不匹配即 `FS_STALE_VERSION`） | `lib/remote-fs.js:1079-1084` / `:1114-1116` |
| 原子发布（同目录暂存 → chmod → rename，失败清理） | `#publish` `lib/remote-fs.js:1621`、`publishRename` `:2479` |
| 写围栏 | `writeFenceRoots` `:2019`、`assertWithinRemoteRoots` `:2040`、`assertFencedRealpath` `:2082` |
| mode 门禁 | `writeModeRefusal` `lib/mode-gate.js:120`、`sessionModeOf` `:151`、`sessionPolicyOf` `:215` |
| 行尾工具（CRLF/LF 归一与还原） | `normalizeLineEndings` `lib/remote-fs.js:2209`、`detectLineEndings` `:2214`、`restoreLineEndings` `:2221` |
| 严格 UTF-8 解码（非法即 `FS_NOT_TEXT`） | `decodeUtf8` `lib/remote-fs.js:2189` |
| 读取原语 | `stat` `:711`（返回 `{version, type, size}`）、`readText` `:772`、`readBytes` `:881`、`readByteRange` `:908` |

**关键缺口：本项目没有任何「读文件内容」的 HTTP 路由。** `lib/routes.js` 的 `ROUTES`（`:97-157`，33 条）里
`readFileSync` 只用来读 `package.json` 的版本号；预览能读是因为它走宿主的 `ctx.fs`，不是走我们的路由。
所以编辑器要**三条**路由，而不是两条：**读文本（带版本）、整文件写、字面替换**。

## 3. 参考实现：flymysql/dsh-remote 做对了什么

它（v1.2.1，`lib/remote-write.js` 51 行 + `lib/routes-fs.js` 287 行）与我们要做的事高度重叠，四条可借：

1. **版本用内容 SHA-256，不用 mtime+size。** 它的注释与测试都说清了原因：同一秒内、大小不变的外部改动，
   `mtime+size` 查不出来。它的 `checkExpectedRevision` 还同时接受 `expectedMtime` 以兼容旧客户端。
2. **写前复核、写后复核。** 暂存文件写完 → 复核 `stat(size/mtime)` 与 `realpath` 未变 → 再复核**字节内容相等**
   → 才 `renameOverwrite`。冲突抛 409 + `REMOTE_FILE_CONFLICT`，`finally` 里删暂存文件。
   （我们的 `#publish` 已经是原子发布，但**没有写前的内容复核**——见 §4.3。）
3. **编辑器保持原生 `<textarea>` 作为输入层**，上面盖一层 `aria-hidden` 的 `<pre>` 画高亮，`transform` 同步滚动，
   行号 gutter 单独一层；超过 300000 字符或 10000 行时关掉高亮与 gutter。缩进用 `document.execCommand('insertText')`
   保住浏览器撤销栈。**这个结构值得照抄，但高亮不抄**（见「不做什么」）。
4. **草稿模型**：`draftKey → { text, baseText, baseMtime, baseRevision, baseEol }` 存在内存里；
   保存成功时若用户已经继续输入，**只推进 baseline，不重载编辑器**（重载会吞掉用户刚打的字）；
   409 时保留草稿并禁用保存按钮，等用户选「重新加载」或「覆盖」。
   它为此写了 4 个专门测试：`remote-write`、`file-save-integrity`（同大小同秒改动 → 409 且远端内容不变）、
   `editor-save-lifecycle`（保存期间继续输入）、`desktop-fs`。

**不照抄**：它的本地分支是「本地镜像工作区」，写的是镜像；我们的本地分支写的是真实本地文件，
门禁语义完全不同（见 §4.5）。它的 `atomicRemoteWrite` 也不用照搬——我们的 `#publish` 已经更强。

## 4. 方案

### 4.1 服务端：三条路由

```
GET  /api/dsh-ssh-workspace/read-text?sessionId=…&path=…
  → 200 { path, text, eol, revision, version, size, bom, truncated: false }
  → 200 { path, text, eol, revision, version, size, bom, truncated: true }   // 超过上限只回头部
  → 400 { error }        // 缺参、非绝对路径、非文本（FS_NOT_TEXT）
  → 403 { error }        // 会话无法识别 / 目标不在会话工作区内
  → 404 { error }        // 文件不存在
  → 413 { error }        // 超过硬上限且不允许截断读取

POST /api/dsh-ssh-workspace/write-text
  { sessionId, path, text, eol?: 'auto'|'LF'|'CRLF', bom?: boolean, expected: { version, revision } }
  → 200 { path, version, revision, bytes }
  → 400 { error }        // 缺 expected、参数类型错、路径非法
  → 403 { error }        // writeModeRefusal 的文案 / 会话无法识别
  → 404 { error }        // 文件不存在（expected 指向一个已消失的文件）
  → 409 { error: 'stale', current: { version, revision } }
  → 413 { error }        // 文本超过上限

POST /api/dsh-ssh-workspace/edit-text
  { sessionId, path, edit: { oldText, newText, replaceAll? }, expected: { version, revision } }
  → 与 write-text 同形
```

硬要求：

1. **必须能定位会话**：`mutationContextOf(ctx, body)`（`lib/routes.js:2632`）是唯一入口——
   `body.sessionId` → `sessions.get(id)`，否则 `body.root` → `sessions.list().find(sameWorkspaceRoot)`。
   workspace root **永不取自请求**，请求里的 root 只是选择器。
2. `expected` **缺失即 400**，不允许无校验覆盖。
3. `ssh://` 与本地绝对路径**共用同一条路由**，分支写法照抄 `ROUTES.rename`（`lib/routes.js:2536-2551`：
   `isRemotePath(body?.path) ? renameRemoteEntry : renameLocalEntry`）。
4. 响应**不回显整份文件内容**（`write-text` 只回 `bytes`、新版本与新哈希）。
5. 与既有路由同样只监听回环、校验 `Host` 头（沿用 `guard`/`guardRaw`）。
6. 错误码走 `codedError`（`:3410`）+ `statusForActionError`（`:424`）；`FS_STALE_VERSION` 需**新增**映射到 409
   （当前 `:424-453` 没有这个 case，会落到 fallback 500）。

### 4.2 读路由的围栏：读也要证明归属

`read-text` 能返回任意文件内容，必须比预览更严，而不是更松：

| 目标 | 围栏 |
| --- | --- |
| `ssh://alias/path` | 解析出 parts → `assertRemoteFence(router, parts)`（已挂载根 + 可达性）→ `assertFencedRealpath` 防软链逃逸 |
| 本地绝对路径 | `localRootOf(owner)`（`:3074`）→ `isWithinLocalRoot` → `realpath` 后 `assertLocalParentInside`（`:3087`） |

**读不查 mode**（`read-only` 会话必须能读），但**必须查会话归属**：无法识别会话即 403。
这与 `assertMutationAllowed`（`:2691`）的差别只有「不调 `writeModeRefusal`」这一条，其余共用。

### 4.3 版本从哪来：`version` + `revision` 双令牌

`versionOf(stats)`（`lib/remote-fs.js:117`）是 `ino:size:mtime`，SFTP 没有亚秒字段。
用它单独当版本，就正好漏掉 dsh-remote 已经踩过的那个坑：**同一秒、同样大小的外部改动**。
但每次保存都做全文件哈希比对也不是白拿的——所以分两级：

1. **快检**：`stat` 出来的 `version` 与 `expected.version` 不等 → 立刻 409，**不读字节**。
2. **慢检**：`version` 相等时，读出当前字节算 SHA-256，与 `expected.revision` 不等 → 409。
3. 两者都过才写。

`read-text` 返回的 `revision` 就是它读到的字节的 SHA-256（`node:crypto`，不引依赖）。
上限内（≤ 2 MiB）这次额外读取是毫秒级，且只在保存时发生。

**行尾**：`read-text` 把内容归一成 LF 交给浏览器（`normalizeLineEndings`），同时回一个 `eol`。
`write-text` 收到 LF 文本后按 `eol` 还原：`'auto'` 表示「沿用磁盘上当前的风格」
（服务端 `detectLineEndings` 现有字节），显式传 `'LF'`/`'CRLF'` 则以传入为准。
**不要**让客户端自己拼 `\r\n`——那是把行尾策略复制到浏览器里，迟早与 `editText` 的还原逻辑打架。

### 4.4 客户端：编辑按钮 + 编辑器

**不新增文件树，不改宿主的树。** 两个候选挂点，选前者：

| 挂点 | 可行性 | 判断 |
| --- | --- | --- |
| `sidebar.right.tab.document.actions`（预览头部动作位，owner `{ absolutePath }`） | 宿主已声明；我们已在用同族的 `sidebar.right.tab.files.actions`（`lib/client.js:12237`） | **采用** |
| `sidebar.files.tree` 的行 `accessory` | 需要接管宿主整棵树（host-owned，`tests/support/tree-dom.mjs` 头注释就是在说这件事） | 否，成本高且与宿主实现耦合 |

具体：

- 注册一个「编辑」按钮（`slots.inject('sidebar.right.tab.document.actions', …)`），
  **仅当** `owner.absolutePath` 存在、能定位会话、`read-text` 探测为文本且 ≤ 2 MiB 时渲染；
- 点击打开大尺寸对话框，**必须用 `modalLayer` 包裹**（`lib/client.js` 的 portal 助手，
  见 `docs/ui.md`「三个对话框的遮罩关闭」与弹窗一节：侧栏 `.scrollArea` 的 wheel hand-off 会吞掉滚轮，
  `.composerSeat` 的 `will-change: transform` 会改写 `position: fixed` 的包含块）；
- 布局复用 `.sshwsp-dialog-fill`：头部（文件名 + 状态）与工具条 `flex: 0 0 auto`，
  正文 `<textarea>` 是**唯一滚动容器**（`overflow-y: auto`、`min-height: 0`）；
- 正文用原生 `<textarea>` + 等宽字体 + 行号列。**不做语法高亮**（会引入 CodeMirror/Monaco 依赖，
  与「零前端依赖」冲突），但保留行号与「未保存」标记；
- 409：显示「文件已被修改」+ 两个按钮——**「重新加载」是默认动作**，「覆盖」是次要动作且需要再确认一次；
  「覆盖」的实现是**先 `read-text` 取新 `{version, revision}`，再 `write-text`**——
  服务端始终校验，**不提供 `force` 开关**（一个跳过校验的参数迟早会被别处调用）。
- 保存成功后清「未保存」标记并推进本地 baseline；若用户在保存期间继续输入，**只推进 baseline，不重载正文**。

### 4.4.1 键盘：哪些白拿，哪些必须自己接

正文是**原生 `<textarea>`**，所以绝大部分编辑手势是浏览器给的，不写一行代码：
全选（`Ctrl/Cmd+A`）、复制粘贴剪切、撤销重做（`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`）、
按词移动与按词选中（`Ctrl+←/→`）、`Home`/`End`/`Ctrl+Home`/`Ctrl+End`、`Shift+方向`、
双击选词、三击选段、IME 中文输入。**这正是不用 `contenteditable` 的理由**——自己实现一套
选区/撤销/输入法，等于重写浏览器已经做对的东西。

需要显式接的只有三个，其中一个是**坑**：

| 键 | 处理 | 注意 |
| --- | --- | --- |
| `Ctrl/Cmd+S` | `preventDefault()` 后保存 | 不拦截会触发浏览器「另存网页」。已确认本项目**没有**其它 `Ctrl+S` 绑定，不冲突 |
| `Esc` | 复用 `useDialogA11y`（`lib/client.js:1961`） | 它在**捕获阶段**统一处理 Esc 与焦点环；`busyRef` 会在保存中屏蔽 Esc，正好符合「保存中不许关」。**不要再挂一个自己的 Esc**，否则会与它抢 |
| `Tab` | **必须在 textarea 的 `onKeyDown` 里拦** | `useDialogA11y` 把 Tab 绑成了焦点环（`lib/client.js:1997-2010`）：不拦的话在正文里按 Tab 会**跳出编辑器**，无法输入缩进。写代码按 Tab 缩进是刚需 |

`Tab` 的拦法（保住撤销栈，与 dsh-remote 同款）：

```js
onKeyDown: (event) => {
  if (event.key !== 'Tab') return
  event.preventDefault()
  // execCommand 而不是自己拼字符串：只有它能把这次插入压进浏览器撤销栈。
  // 直接 setText(value + '  ') 会让 Ctrl+Z 跳过这一笔。
  document.execCommand('insertText', false, '  ')
  // execCommand 之后从 DOM 读回真实值再同步 React state，不要用拼出来的副本。
  setText(event.currentTarget.value)
}
```

`Shift+Tab` 反缩进（行首去掉最多两个前导空格）属于**可选**：不做也能用，做了要保证撤销栈同样成立。
多行选中整体缩进**不做**（要自己管选区的行列映射，收益不抵复杂度）。

**不做查找/替换**：`edit-text` 路由（`{oldText, newText, replaceAll}`）已预留，但没有对应 UI。
浏览器自带 `Ctrl+F` 在 `<textarea>` 里行为不一致（有的找页面文字、有的不找），
真要做必须在对话框内自己实现一个面板——这一辑不做。

### 4.5 本地分支：同一条路由，两套围栏

`rename` / `delete` 已经确立了「**拼写决定分支**」：`ssh://` 走 SFTP，绝对本地路径走 `node:fs`，
而 `mutationContextOf` + `localRootOf` + `assertLocalParentInside` 保证本地写只落在会话自己的 workspace 内。
文件编辑照抄这一套，**不新增第三种权限语汇**：

- 本地写用 `node:fs` 的 `writeFile` 到同目录临时文件再 `rename`（与 `renameLocalEntry` 同风格），
  或直接用 `fs/promises` 的 `writeFile` + 事后 `stat` 复核；
- 本地 `revision` 同样是 SHA-256，`version` 用 `ino:size:mtime`（`fs.Stats` 在多数平台上 `mtimeMs` 有毫秒精度，
  但仍然不要只靠它）；
- 软链：`realpath` 后必须仍在 `realRoot` 内，否则 `FS_OUTSIDE_WORKSPACE`（与 `deleteLocalEntry` 一致）。

这样「不管远端本地都可以编辑」不是两条实现，而是**一条路由的两个分支**，与面板里
`absolutePath` 的语义天然对齐：宿主 `@deepseek-ai/dsh-api-workspace-files` 用
`this.ctx.fs.processPath(target)` 生成这个字段，远端目标得到的就是 `ssh://alias/path` 拼写。

### 4.6 权限（不新增例外）

| 层 | 规则 |
| --- | --- |
| 会话 mode | 只读会话不渲染编辑按钮；服务端 `writeModeRefusal` 403（双保险） |
| 会话归属 | 无法识别会话 → 403；workspace root 只从会话读 |
| 写围栏 | 远端：已挂载根 + `assertFencedRealpath`；本地：`localRootOf` + `realpath` 防软链 |
| 大小上限 | `EDIT_MAX_BYTES = 2 * 1024 * 1024`；读可截断（`truncated: true`），写超限 413 |
| 二进制 | 前 8192 字节含 NUL → `FS_NOT_TEXT`，按钮不渲染 |
| 审计 | 每次保存一条（路径 + 字节数 + 结果），**不写内容**；读不审计 |

### 4.7 编码：能编辑什么，不能编辑什么

**判定看内容，不看扩展名**：前 `BINARY_SAMPLE_BYTES = 8192` 字节（`lib/remote-fs.js:37`）含 NUL 即二进制。

| 类别 | 能否编辑 | 原因 |
| --- | --- | --- |
| 纯文本 / Markdown / 配置（`.md` `.txt` `.json` `.yaml` `.toml` `.ini` `.env`） | ✅ | |
| 源码（`.js` `.ts` `.py` `.sh` `.go` `.rs` `.java` `.c` …） | ✅ | **没有语法高亮**（见「不做什么」） |
| 数据文本（`.csv` `.log` `.diff` `.patch`） | ✅ | 2 MiB 上限对日志偏小，超限只读 |
| `.svg` | ✅ | 它是文本——所以**没有扩展名黑名单**是对的 |
| 图片 / 音视频 / 压缩包 / Office / 字体 / 可执行文件 / sqlite | ❌ | `FS_NOT_TEXT`（前 8192 字节含 NUL） |
| **非 UTF-8 文本**（GBK、GB18030、UTF-16、latin-1） | ❌ | `decodeUtf8`（`lib/remote-fs.js:2189`）是 strict 模式，解码失败即 `FS_NOT_TEXT` |
| 超过 2 MiB 的文本 | ❌ | 按钮置灰；读路由可截断并标 `truncated: true`，但不能保存 |

**非 UTF-8 是国内项目的真实痛点**，必须在第一版就说清楚而不是让用户点开才发现：按钮不渲染时，
`title` 要写「此文件不是 UTF-8 文本（检测到非 UTF-8 字节），当前版本不支持编辑」。
**不做编码转换**：把 GBK 猜成 GB18030 再猜错一次，比直接拒绝坏得多——那会静默改坏文件。
要支持就单开一辑，做显式编码选择 + 保存时二次确认。

**BOM**：`decodeUtf8` 不剥 BOM，而 `normalizeLineEndings` 也不碰它。所以读到的第一个字符可能是 `\uFEFF`。
实施时必须显式二选一，**不允许默认丢掉**：

1. 保留：读路由检测到 BOM 时回 `bom: true`，写路由按 `bom` 决定是否重新前置 `\uFEFF`；
2. 拒绝：读路由直接 400，文案说明「带 BOM 的文件当前不支持编辑」。

推荐 1——BOM 在 Windows 项目里常见，直接拒绝等于把一批文件排除在外；而 `bom` 只是一个布尔字段。

## 5. 验收标准

| # | 判据 |
| --- | --- |
| 1 | 远端文本文件在预览头部出现「编辑」，点击可打开并显示完整内容 |
| 2 | 保存成功后重新打开，内容是新的；`stat` 的 `version` 已变 |
| 3 | 打开后由另一路径（如 Agent 的 `write` 工具）改动文件，再保存 → 409，提示「文件已被修改」，**文件未被覆盖** |
| 4 | 同大小、同一秒内的外部改动也能被 409 拦住（`revision` 生效） |
| 5 | 只读会话：按钮不渲染，且直接 POST 该路由返回 403 |
| 6 | 路径逃逸（`../`、软链）被拒，返回 4xx，文件未被写入 |
| 7 | 二进制文件与超限文件不出现编辑按钮；直接请求读路由得 400/413 |
| 8 | 未保存就按 Esc → 二次确认；取消则磁盘内容不变 |
| 9 | 本地文件（非 `ssh://`）走同一条路由也能读、能存 |
| 10 | CRLF 文件保存后仍是 CRLF（`eol: 'auto'`），LF 文件仍是 LF |
| 11 | 审计有一条且不含文件内容 |
| 12 | 409 的默认动作是「重新加载」，不是「覆盖」 |
| 13 | `Ctrl/Cmd+A` / `Ctrl+Z` / `Ctrl+C` / `Ctrl+V` 在正文里是浏览器原生行为，不被对话框拦截 |
| 14 | 在正文里按 `Tab` **插入两个空格**而不是跳出编辑器；插入后 `Ctrl+Z` 能撤销这一笔 |
| 15 | `Ctrl/Cmd+S` 保存且**不**触发浏览器「另存网页」 |
| 16 | 保存进行中按 `Esc` 不关闭对话框（`busyRef` 生效） |
| 17 | 非 UTF-8 文件：按钮不渲染且 `title` 说明原因；直接请求读路由得 400 |
| 18 | 带 BOM 的文件保存后 BOM 仍在（若采用保留方案）或读路由明确拒绝（若采用拒绝方案） |

## 6. 不做什么

- **不接管宿主的文件树**（`sidebar.files.tree`）：host-owned 组件，接管成本远大于收益。
- **不引入编辑器依赖**（CodeMirror / Monaco / highlight.js）：与零前端依赖冲突。
  将来若要高亮，先单独评估包体积与 CSP；dsh-remote 的 `<pre>` 覆盖方案是唯一可考虑的零依赖路线。
- **不做实时协同 / 不自动刷新编辑器内容**（会吞掉正在输入的文字）。远端变化只通过「保存时 409」暴露。
- **不做多文件标签页**：一次一个文件，够用且状态简单。
- **不新增 Agent 工具**：模型已有 `write` / `edit` 走 `ctx.fs`，不需要第二条路。
- **不提供 `force` 覆盖参数**：覆盖只能由客户端「重新读再写」完成，服务端不做无校验写入。
- **不做编码转换**（GBK / GB18030 / UTF-16 → UTF-8）：猜错一次就是静默改坏文件。非 UTF-8 直接拒绝，
  要支持就单开一辑做显式编码选择。
- **不做查找/替换面板**：`edit-text` 路由已预留，但没有 UI；浏览器自带 `Ctrl+F` 在 `<textarea>` 里行为不一致。
- **不做多行整体缩进 / 语法高亮 / 自动补全**：都要自己管选区与渲染，收益不抵复杂度。

## 7. 风险

| 风险 | 处理 |
| --- | --- |
| 大文件把浏览器拖死 | 2 MiB 上限 + 二进制探测 + 读路由可截断 |
| 覆盖别人刚写的改动 | `version` + `revision` 双令牌 + 409 + 默认不覆盖 |
| 用户以为保存了其实没有 | 保存成功后才清「未保存」；失败保留正文并显式报错 |
| 编辑对话框又踩「滚轮被侧栏吞掉」 | 复用 `modalLayer`（portal 到 `document.body`） |
| BOM / 非 UTF-8 文本被静默改坏 | `decodeUtf8` 已经 strict；BOM 目前不剥离，**首次保存会丢 BOM** —— 按 §4.7 显式处理（保留或明确拒绝），**不允许默认丢掉** |
| `Tab` 被 `useDialogA11y` 的焦点环吃掉 | 在 textarea 的 `onKeyDown` 里 `preventDefault()` 并用 `execCommand('insertText')` 插入，见 §4.4.1 |
| 用户以为能编辑 GBK 文件，点开才发现不行 | 按钮不渲染时就给 `title` 说明「不是 UTF-8」，不要等到点开才报错 |
| 本地写与远端写行为漂移 | 两条分支共用同一组测试用例（同一份 fixture，两种路径拼写） |

## 8. 实施顺序

1. `routes.js`：`ROUTES` 加三条 + `FS_STALE_VERSION → 409` 映射 + `EDIT_MAX_BYTES`；
2. 服务端三个处理函数（读/写/改），先远端分支，再本地分支；
3. 裸检出测试（用 `tests/support/fake-sftp.mjs` 的内存 SFTP，FF-01 已交付）；
4. 客户端按钮 + 对话框（`modalLayer` + `.sshwsp-dialog-fill`）；
5. 源码级客户端断言；
6. 文档与 CHANGELOG。

## 相关

- [../development.md](../development.md) 的「共享替身」一节：`tests/support/fake-sftp.mjs` 是本辑测试的前置（原 FF-01 任务书已随交付删除）
- [../ui.md](../ui.md)：弹窗与 `modalLayer`、`sidebar.right.tab.files.actions` 的既有用法
- [../protocol.md](../protocol.md)：`ssh://` 语法与写入围栏
- [../architecture.md](../architecture.md)：`ctx.fs` 接管与 `remote-fs.js` 的分层
