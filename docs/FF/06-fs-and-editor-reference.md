# FF-06 文件系统与编辑器的参照取舍

> 参考项目：<https://github.com/omdsh-dev/DSH-better-sidebar>（下称「参照」）。
> 本文回答一个问题：**它的文件系统与编辑实现，哪些能搬、哪些不能、哪些是我们已有的缺陷。**
> 结论先给：能搬的是**做法**，不能搬的是**架构前提**；其中 6 条是已确认的缺陷或缺口，4 条是纯优化。

## 1. 先说清根本差异（这一节决定后面所有判断）

| | 参照 | 本插件 |
| --- | --- | --- |
| 文件系统在哪 | 本机 `node:fs/promises` 直调 | 远端，经 SFTP（`lib/fs/remote-fs.js`） |
| 谁实现 | 自己实现整棵树 + 全部写操作 | 借用宿主 `ctx.fs`；远端分支自己接（`lib/fs/remote-fs.js`） |
| 写围栏 | **无**。README 明写 v0.23.0 起 fs 路由不做 workspace 包含检查 | 三道：workspace root（`lib/fs/remote-fs.js` `#writeModeOf` / `#writeFence`）、会话 workspace（`lib/routes/text.js` `assertRemoteTextFence`）、宿主 sandbox mode |
| 编辑器 | CodeMirror 6（`src/client/TextEditor.tsx`） | `<textarea>`（`lib/client/client.editor.js`） |
| 文件树更新 | `fs.watch` 每目录一个 OS 句柄 | 轮询 + `inotifywait` 推送（`lib/fs/remote-watch.js`） |

**一句话**：它把一个本地 IDE 搬进侧栏；我们是给远端主机做一层透传，所有成本模型都是「每次读都是一次网络往返」。

## 2. 不能搬的（照抄会倒退）

### 2.1 无围栏的 fs 写路由

参照的核心设计之一，README 里作为已知限制列出：

> ⚠️ **Since v0.23.0 the fs routes do no workspace-containment check**：can read/write any path the host user can reach (OS permissions only) — callers must not treat these routes as fenced

本插件的三道围栏是被测试钉住的（`tests/text-routes-smoke.mjs`、`tests/routes-smoke.mjs` 里的越界用例）。这一条没有任何讨论空间。

### 2.2 每行并发 `stat`

参照的 `probeSymlinkTargets` / `probeCompactRows` 对每个目录行的子项并发发 `stat` / `opendir`，上限 32，理由是「本地 syscall 太便宜，不并发反而慢」。

在 SFTP 上这不是优化而是事故：N 个并发 `stat` = N 次往返。我们的 `listDir`（`lib/fs/remote-fs.js:862`）刻意用 `entry.attrs`（SFTP `readdir` 自带属性）避开逐条 `stat`，注释里写明了「a directory of N children used to cost 1 readdir + N serial stats」。**这条设计要守住。**

### 2.3 `fs.watch` 目录监视

参照一个展开目录一个 OS 句柄，上限 64（`MAX_WATCHES`）。我们没有本地目录可 watch，只有 `inotifywait` 推送与轮询两种实现，已经在 `lib/fs/remote-watch.js` 里做完了。

### 2.4 Windows rename 竞争重试

参照的 `renameIntoPlace` 对 `EPERM` / `EACCES` / `EBUSY` 重试，预算 10，附了一整张实测表（8 方竞争 5 次够、32 方竞争 5 次不够而 10 次够）。

这是 NTFS 本地语义。SFTP 的 `rename` 失败形态是协议错误而非瞬时锁竞争，且我们已经有更强的机制：`publishRename`（`lib/fs/remote-fs.js:1804`）优先走 `posix-rename@openssh.com` 扩展。

### 2.5 选择弹窗 / 引用芯片 / git gutter

参照的 `useSelectionPopup`、`quote-flash`、`selection-payload`、`editor-git-gutter` 全部建立在 CodeMirror 的 view 坐标与 selection API 上。

我们 `lib/client/client.editor.js:483` 的注释已经记录了为什么选 `<textarea>`：

> 选择、撤销、IME、双击、词移动 —— 已经是对的

换成 CodeMirror 等于把这一整套重新实现一遍，而且 `<textarea>` 的 IME 行为在中文输入下是浏览器原生的。

### 2.6 滚动位置记忆

参照需要 `PREVIEW_SCROLL_CAP = 64` 的两张滚动记忆表，因为**宿主的标签页常驻挂载**，切走再切回会 detach/re-attach 导致 `scrollTop` 归零。

我们是内联面板，挂载即显示，没有这个问题。加了就是无用的复杂度。

## 3. 已确认的缺陷（要修）

### 缺陷 1：watcher 注册表没有条数上限

`lib/fs/remote-watch.js` 的 `RemoteWatchRegistry.watches` 是一个**无上限的 `Map`**：

```js
// lib/fs/remote-watch.js:71
this.watches = new Map()
```

文件里现有的常量只有时间与退避相关的五个：

```
WATCH_POLL_INTERVAL_MS = 2000
WATCH_SLOW_INTERVAL_MS = 5000
WATCH_MAX_INTERVAL_MS  = 10_000
WATCH_START_MAX_RETRIES = 5
WATCH_QUIET_ROUNDS     = 15
```

**没有任何 `MAX_WATCHES`。** 一个会话里展开几十个目录就是几十条并发轮询（每条 2s 起），且 `WATCH_QUIET_ROUNDS` 只在单条上退避，管不了条数。

参照的对应常量与理由：

> `MAX_WATCHES = 64` —— 一个连接可持有的目录 watcher 数。这个上限是资源保护，不是策略：展开超过这么多目录的读者只是不再获得新 watcher，折叠任何一个目录就腾出一个槽位。

**做法**：加条数上限，超限时明确返回「未能监视」（不要静默丢弃），并在折叠/卸载时释放。这是唯一一条「我们已经错了」的文件系统缺陷。

### 缺陷 2：UTF-16 文件被判为二进制

我们的判定只有两条（`lib/routes/text.js`）：

```js
// :102
function looksBinary (buffer) { return buffer.subarray(0, SAMPLE_BYTES).includes(0) }
// :381
decodeUtf8(bom ? raw.subarray(3) : raw, 'read', '')
```

实测后果：

| 输入 | 我们的判定 | 应该 |
| --- | --- | --- |
| UTF-16LE 的 `hello world config` | `binary` | 可编辑 |
| GBK 的「你好」 | `not-utf8` | 可编辑 |

**后果**：Windows 上典型的配置文件（UTF-16 带 BOM，或 CP936）在这个插件里**打不开**，用户只看到 "binary" 或 "not UTF-8"。

参照为此写了完整的 `src/text-encoding.ts`：BOM 嗅探（UTF-8 / UTF-16 ×2 / UTF-32 ×2）· 无 BOM UTF-16 的判别（双字节 lane + 要求 90% 是文本单元，否则 16 位采样表会被误判）· GB18030 四字节序列识别 · **截断尾部不得当作编码证据**（`hasIncompleteUtf8Tail`）。

**做法**：只做**读**。能打开、能正确显示，写留到下一步——写错编码的破坏性远大于显示错。

### 缺陷 3：保存时的格式回写不完整

我们保存时发 `eol: 'auto'` 与 `bom`（`lib/client/client.editor.js:639-640`），服务端 `EOL_POLICIES = new Set(['auto','LF','CRLF'])`。**UTF-8 世界里的这部分是对的**（客户端从不自己拼 `\r\n`）。

缺的是编码维度：`encodeText` 只写 UTF-8（`lib/routes/text.js:236`）。配合缺陷 2，一个 GBK 文件即便能显示，保存后也会变成 UTF-8。

参照的做法是**每次保存前重新嗅探磁盘**（`fileFormatOf()`），返回 `{encoding, eol}`，然后 `encodeText(restoreEol(text, eol), encoding)`。它点名了 issue #871：少了这一步，一次单行修改会在 CRLF 文件里变成全文件 diff。

**做法**：与缺陷 2 打包，读和写共用同一个 `fileFormatOf`。

### 缺陷 4：冲突把「只改了 mtime」也当成内容冲突

`lib/client/client.editor.js:657-666` 保存成功后：

```js
setState(current => ({
  ...current,
  baseText: sent,
  baseVersion: String(reply.data.version ?? ''),
  baseRevision: String(reply.data.revision ?? ''),
}))
```

只有 `baseVersion` / `baseRevision` 两个令牌，**没有保留「上次保存的字节」**。于是 `touch` / `git checkout` / 格式化工具重写出**完全相同的字节**时，`revision` 变了而文本没变，用户被弹一个「文件已被修改」的冲突对话框——而实际上内容一个字都没变。

参照把两个基线分开存：`mtimeRef`（时间戳）与 `savedTextRef`（字节），并据此做原地解决：

> 一个 reload 的字节与 baseline **相同**，就只动 baseline 并保留草稿。一个真正不同的文档才交给显式的 reload。既不问「要不要丢弃编辑」（并没有丢弃），也不陷入 #1059 那个 touch-only 改动的无限冲突循环。

**做法**：加一个 `savedBytes` 基线，冲突时先比字节：相同则原地采纳新令牌、保留草稿、不弹框；不同才走现有冲突流程。改动集中在 `save()` 与 409 分支，可单测。

### 缺陷 5：刷新页面丢草稿

`lib/client/client.editor.js:532` 的 dirty 检查只在**点关闭按钮**时触发：

```js
if (dirty && typeof window.confirm === 'function') {
  if (window.confirm(t('edit.unsavedPrompt')) !== true) return
}
```

实测 `beforeunload` 在这个文件里出现 **0 次**。刷新 / 关标签页 / 导航离开 → 草稿静默丢失。

参照为什么要用 localStorage 而不是 `beforeunload` 拦住，理由值得记下来：

- 宿主关闭标签页走 `registerCloseHandler`，它是**同步清理回调**（失败才能保住标签页），不能弹确认，throw 会被记成 `Sidebar tab close failed:` 并从 `replaceTab` 逃出去；
- Desktop shell 的 Cmd+Q 在 Electron main 里被拦截，页面**收不到可取消的退出事件**。

**我们的情况比它简单**：我们是内联面板而不是宿主标签页，没有「宿主抢走」的路径，所以 `beforeunload` 能直接生效。这是少数我们比参照容易的地方。

**做法**：`beforeunload` 拦一层（同步确认即可）；是否再加 localStorage 持久化草稿，取决于是否接受「面板被宿主卸载」这一种情况。

### 缺陷 6：没有查找

实测 `find` 在 `lib/client/client.editor.js` 里出现 **0 次**；`execCommand` 6 次全部用于 Tab 缩进。

参照有 `openSearchPanel(view)` + `cmSearchExtensions()`，并留了一条顺序约束：

> 搜索键位要在编辑器自己的 keymap **之前**注册，否则 Escape（编辑器的 `simplifySelection` 也占这个键）会被抢走。

我们有同样的坑：`Escape` 已被用来关闭编辑器（`lib/client/client.editor.js:694`），加查找时搜索面板必须先吃掉它。

**做法**：`<textarea>` 上的查找只能自己做（浏览器原生查找作用于整个页面，会命中侧栏外的文本）。最小可用：输入框 + 匹配计数 + 上一个/下一个 + 高亮用 `<textarea>` 不可行时改为滚动到命中行并选中。

## 4. 纯优化（可做可不做）

### 优化 1：`listDir` 的排序用 `toLowerCase()` 而不是 `localeCompare`

`lib/fs/remote-fs.js:874`：

```js
for (const entry of entries.slice().sort((left, right) => left.filename.localeCompare(right.filename))) {
```

实测 10,000 个名字：

```
localeCompare  15.46 ms
toLowerCase     5.26 ms     3× 快，顺序完全一致
```

**比性能更重要的是确定性**：`localeCompare` 走 ICU collator，同一份代码在不同 ICU 版本 / 进程 locale 下可能给出不同顺序。我们 `lib/routes/entries.js:100` 的 `compareForTruncation` 已经想通了这件事，注释写着：

> 截断点必须每台机器一样，一个 500 条里第 500 条取决于 ICU 构建的列表等于随机藏一个文件。

但 `remote-fs.js:874` 这条路径没跟上。

### 优化 2：`listDir` 缺「目录优先」

`lib/routes/entries.js:101` 的 `compareForTruncation` 目录永远在前，但 `lib/fs/remote-fs.js:874` 只按名字排。两处不一致，取决于面板信谁。

### 优化 3：单例目录折叠（`compact`）

`a/b/c` 只有一个子目录时折成一行（VSCode 的 compact folders）。我们完全不支持——`remote-fs.js` 里 `singleton` / `compact` 零命中。

远端反而更有价值：折叠后少一层展开 = 少一次往返。

**坑**（参照踩过并写进注释）：**符号链接子项永远不折叠**，否则自引用链会无限折。同理隐藏项与 exclude 命中的项也不计入。

### 优化 4：大文件分页读

我们的 `EDIT_MAX_BYTES = 2 MiB` 是硬上限，超了直接 `too-large`。参照用 `PAGE_BYTES = 128 KiB` 分页，`MAX_EDITABLE_BYTES = 5 MiB` 以上降级为只读分页预览。

它踩过的坑：**第二页单独嗅探会嗅成 UTF-8，拼起来是乱码**——所以 `decodeTextAs()` 必须带着第一页定下的编码解后续页。我们如果做分页会一样遇到。

## 5. 不做什么

- **不换编辑器。** 不引入 CodeMirror。`<textarea>` 的选择 / 撤销 / IME 是浏览器原生且正确，换掉等于重写这套并自己承担中文输入法的行为。
- **不引入无围栏的写路由。** 任何「为了让某个操作能做而放宽围栏」的方案都不接受。
- **不在 `listDir` 里对每个子项发 `stat`。** 只用 `entry.attrs`；缺失时才回退。
- **不为滚动位置做持久化。** 内联面板没有参照的那个问题。
- **不搬 Windows rename 重试。** 我们的失败形态不同，且已有 `posix-rename` 路径。

## 6. 建议顺序

| 顺序 | 项 | 理由 | 风险 |
| --- | --- | --- | --- |
| 1 | 缺陷 4（冲突基线分开存） | **已存在的错误行为**，用户被迫点「覆盖」而覆盖提示被消耗一次；改动集中在 `save()` 一处，可单测 | 低 |
| 2 | 缺陷 1（watcher 上限） | 唯一的文件系统真缺陷；只加约束不改语义 | 低 |
| 3 | 缺陷 5（`beforeunload`） | 丢数据完全静默 | 低 |
| 4 | 优化 1 + 2（排序） | 几行，顺带修掉歧义 | 低 |
| 5 | 缺陷 2 + 3（编码） | 工作量大；**只做读**，写单独一轮 | 中 |
| 6 | 缺陷 6（查找） | 新功能 | 中 |
| 7 | 优化 3（折叠） | 改变列表语义 | 中 |
| 8 | 优化 4（分页） | 可选 | 中 |

前四项可以一轮做完并保持 `npm run check` 绿。5 及之后建议各自独立成轮。
