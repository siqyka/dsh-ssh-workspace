# FF-07 任务书：在右侧文件树里新建文件

> 本目录约定 `NN-<topic>.md` 是方案、`NN-<topic>-prompt.md` 是任务书。这一条范围太窄，不单独写方案，
> **本文件的 §1 兼作现状说明**。起点状态已核对，照着做，不要重新调研。

## 起点状态（已核对，2026-11-22）

- 仓库 `F:\GitHub\dsh-ssh-workspace`，分支 `refactor/code-splitting`，HEAD `aff64f2`。
- **工作树里另有一路未提交的语法高亮 / CodeMirror 工作**：`lib/client/client.editor.js`、
  `lib/client/client.editor-engine.js`（新）、`lib/client/client.styles.js`、`lib/client/client.locale.js`、
  `lib/fs/remote-fs.js`、`lib/routes/text.js`、`editor-engine/`（新）、`package.json`、`package-lock.json`、
  若干 `docs/` 与 `tests/`。开工前先 `git status --short`：
  - 若这些改动仍在，**先问用户**要不要等它提交或收走，**不要替用户 stash / reset / commit**。
    本任务唯一会碰到的交叉点是 `lib/client/client.locale.js`（只加键）。
  - 提交一律用显式路径（`git commit -- <paths>`），**永不用 `git add -A`**，否则会把那一路工作卷进来。
- 基线：`tests/mutations-smoke.mjs` **80 passed**（路由段需 `DSH_CORE_ROOT`，裸检出 SKIP）、
  `tests/tree-blank-menu-smoke.mjs` **40 passed**（Windows 上需 `TMP=/f/GitHub/.tmpdir TEMP='F:\GitHub\.tmpdir'`）、
  `tests/lifecycle-smoke.mjs:71` 的 `EXPECTED_ROUTES = 36`、`docs/development.md:14` 的 HTTP routes 也是 36。

## 1. 现状：为什么现在建不出文件

三条路全堵着，**这不是 UI 少一个按钮**：

1. **没有路由**。`lib/routes/routes.js:87-153` 的 `ROUTES` 共 36 条，与「建东西」有关的只有 `mkdir`（`:128`）。
   create-file / new-file / touch 在全仓库 grep 均 0 命中。
2. **`write-text` 写不了新文件，且不该被改成能写**。`lib/routes/text.js:664` 的 `saveText` 顺序是
   「先读当前文件 → 比 `version` → 比 `revision` → 才写」，`requireExpected(body)`（`:667`）必填；
   文件不存在时第一步就抛 `FS_NOT_FOUND`。这是有意的：编辑器协议只有「替换已知内容」一种操作，
   加一条「文件不存在也能写」等于给覆盖校验开后门。**新建必须是独立路由**。
3. **菜单里只有「新建文件夹」**。`lib/client/client.js:2865-2873` 的 `newFolderItem` 条件是
   `remote !== null && isDir`；本地空白处菜单 `openLocalBlankMenu`（`:2916-2950`）恰好两项；
   `lib/client/client.kernel.js:44-95` 的 `API` 表里没有对应路径。

顺带核对过的两点（省得再查一次）：

- **0 字节文件可编辑**：`fileFormatOf(Buffer.alloc(0))` 在 `lib/routes/text-encoding.js:193` 走
  `sample.every(byte => byte < 0x80)`，空数组为真 → `{encoding: 'utf8', bom: false}`；`describeRead` 回
  `text: ''`。所以建完空文件，预览里的铅笔按钮会出现、能编辑、能保存。
- **ssh2 支持独占创建**：`open(path, 'wx')` = `O_CREAT|O_EXCL`（`node_modules/ssh2/lib/protocol/SFTP.js:2536`），
  测试替身如实实现了它（`tests/support/fake-sftp.mjs:379-411`：已存在就失败）。

## 2. 任务 1 —— 服务端：`POST /create-file`

照 `mkdir` 那一对函数写，**不要发明新形状**：远端建目录在 `lib/routes/entries.js:486`（`mkdirRemoteEntry`）、
本地在 `:527`（`mkdirLocalEntry`）、路由登记在 `:958-970`。

### 契约

```
POST /api/dsh-ssh-workspace/create-file
{ "path": "ssh://qy/srv/proj"  或  "F:\\repo\\docs", "name": "notes.md",
  "root": "可选，仅用于识别会话", "sessionId": "可选" }

200 { ok: true, path: "ssh://qy/srv/proj/notes.md" 或 "F:\\repo\\docs\\notes.md", created: true }
```

`ROUTES` 里加 `createFile: '/api/dsh-ssh-workspace/create-file'`，紧接 `mkdir` 之后，注释写清
「`path` 是**父目录**，`name` 是**一个路径段**，与 `mkdir` 同形状；`path` 的拼写决定远端 / 本地分支」。

### 检查顺序（与 `mkdir` 逐条对齐，顺序本身就是契约）

1. `path` 必填，`isRemotePath` 决定分支（本地分支要 `requireLocalTarget`）。
2. `mutationNameRefusal(body?.name)` → `FS_INVALID`（400）。它已拒空串、纯空白、`.`、`..`、`/`、`\`、
   NUL、超 255（`lib/transfer/transfer-rules.js:525`），**`.gitignore` 这类点开头名字必须放行**。
3. 拼出完整目标：远端 `normalizeRemotePath(parent.remotePath + '/' + name)`，本地 `join(parent, name)`。
4. `assertMutationAllowed(ctx, body, child.displayPath, 'create a file')` —— mode 门禁 + 会话归属。
   本地分支必须用它返回的 `owner`，再 `localRootOf(owner)` 取根（`:711`）。
5. 远端：`assertRemoteFence(router, child)`（含 `assertEnabled`，停用工作区在这里被拒），然后
   `engine.withSftp(parent.alias, work, { kind: 'write' })` 内依次：
   - `assertRemoteParentFenced(sftp, router, child)`（`:415`，防软链父目录逃逸）
   - `sftpStatOrNull(sftp, parent.remotePath)`：`null` → `FS_NOT_FOUND`（404）；非目录 → `FS_NOT_DIRECTORY`（400）
   - `sftpLstatOrNull(sftp, childPath)` 非 `null` → `EEXIST`（409）
   - **`sftp.open(childPath, 'wx')` 然后 `sftp.close(handle)`** —— 独占创建是最后一道边界，
     预检只是为了让「已存在」得到 409 而不是把服务器的 EXCL 失败翻成 500。
6. 本地：lexical `isWithinLocalRoot(root, target)` 与 `isWithinLocalRoot(root, child)` 都要过；
   `realpath(root)` / `realpath(target)` 后再 containment 一次；`stat(target)` 必须是目录；
   `lstat(child)` 存在 → `EEXIST`；`open(child, 'wx')` + `handle.close()`。
7. 审计：`record(KINDS.write, message, { alias })`，message 是 `created <displayPath>`。
   **只记路径，永不记内容**（与 `lib/routes/text.js` 的 `auditWrite` 同一条理由）。

新增两个小助手放 `entries.js`（约 10 行一个，与 `sftpMkdirStrict` 并列）：
`openRemoteFile(sftp, path, flags, displayPath)` / `closeRemoteFile(sftp, handle)`。
注释写清为什么是 `'wx'`：先查再写之间有一个窗口，独占创建没有。
`entries.js` 顶部那条 `import { lstat, mkdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'`
（`:14`）要补上 `open`；`ssh2` 不用碰，`engine.withSftp` 已经给出会话。

- **不要改 `lib/routes/text.js` 的 `saveText`**；不要给 `write-text` 加 `create` 选项。
- **不要改 `lib/fs/remote-fs.js`**：它没有 create 语义，而且工作树里已有他人改动；
  `mkdir` / `rename` / `delete` 都是路由层直接 `engine.withSftp`，新建跟着它们走。
- 顺带把 `lib/routes/entries.js:1-16` 的模块头从「the mutations (rename, delete, mkdir)」补上 create-file。

## 3. 任务 2 —— 客户端：入口、对话框、图标

### 3.1 行菜单（远端目录行）

- `newFileItem`：条件与 `newFolderItem` 完全相同（`remote !== null && isDir`），**插在 `newFolderItem` 之前**
  （新建文件比新建目录常用），两者同属「创建」组。
- 加进 `:2899` 那个 `mutationPolicyOf` 的禁用循环（`[newFileItem, newFolderItem, renameItem, deleteItem]`），
  只读会话要让它在点击前就是灰的并带理由——「先答应再拒绝」不是禁用。
- **远端空白处自动就有了**：`openForBlank`（`:3221`）用的就是 `openTaskMenu(..., isDir = true)`，
  即「目录行的菜单」。不要为空白处第二套代码。

### 3.2 对话框

`requestRowNewFile(request)` 照 `requestRowNewFolder`（`:2336-2370`）写：一个文本框、同一个
`openRowActionDialog`、Enter 提交、Esc 取消、服务端拒绝把原因写在按钮旁；成功后
`refreshFilesPanel()` → `selectCreatedRow(data?.path, request)`（`:2396`）→ `notifyUser(translate('rowmenu.fileCreated'), 'ok')`。
失败整形 `describeNewFileFailure`：`/already exists|EEXIST/` → `rowmenu.targetExists`，其余
`rowmenu.createFileFail: <message>`。

名字校验复用同一套规则，但**把 `folderNameRefusal` 改名 `entryNameRefusal`**，并把三条文案改成
「名称不能…」而不是「文件夹名称不能…」（`lib/client/client.locale.js:382-384` 与英文 `:804-806`）：
文件对话框里说「文件夹名称」是假话，而规则本来就是一条。

### 3.3 本地空白处菜单

`openLocalBlankMenu`（`:2916-2950`）加第三项「新建文件」，走同一个对话框、同一条本地分支，
并同样进那个「只禁用创建、复制始终可用」的策略分支。注意 `tests/tree-blank-menu-smoke.mjs:296-304`
把「恰好两项」与「不含 rename/delete/upload/download」钉住了，**两条断言要同步改成三项**。

### 3.4 两处注册

- `lib/client/client.kernel.js:44-95` 的 `API` 表加 `createFile`，紧跟 `mkdir`。
- `MENU_GLYPH_PATHS`（`lib/client/client.kernel.js:2257-2292`）加 `newFile`：文件轮廓 + 加号，
  与 `newFolder` 同一视觉语言（`createMenuIcon` 会在缺项时回落成 `file`，回落不算实现）。

### 3.5 新文案（zh + en 各一份）

`rowmenu.newFile`（新建文件 / New file）、`rowmenu.newFileTitle`、`rowmenu.newFileHint`
（在当前目录中创建，Enter 提交，Esc 取消。/ Created here…）、`rowmenu.creatingFile`（创建中…）、
`rowmenu.fileCreated`（已创建文件）、`rowmenu.createFileFail`（新建文件失败）。
`tests/locale-register-smoke.mjs` 会查两本字典的键集与占位符，缺一边就是红的。

## 4. 任务 3 —— 测试

### 4.1 `tests/mutations-smoke.mjs`（80 → 约 94）

- **源码契约**（与 `:75-120` 那段并列）：路由表有 `create-file`；`createFileRemoteEntry` 栅栏的是**子项**
  （`assertMutationAllowed(..., 'create a file')` + `assertRemoteFence(router, child)`）；真的用 `'wx'`
  （`/sftp\.open\([^)]*'wx'/` 之类，但**别只断言字符串**——见 4.3）。
- **远端行为**（`engine.withSftp` 的内联替身 `:200-260` 需要补 `open` / `close`，语义照
  `tests/support/fake-sftp.mjs:379-411`；已存在时按 SFTP FAILURE 回错）：
  正常创建 200 且 0 字节；同名再建 409 且 `/already exists/`；父目录缺失 404；父目录是文件 400；
  挂载根外 403；名字带分隔符 400；只读会话 403；停用工作区 403。
- **本地行为**：工作区内创建；同名 409；根外 403；只读 403；点文件名 `.gitignore` 能建（点开头放行）。

### 4.2 `tests/tree-blank-menu-smoke.mjs`（40 → 约 44）

三项而不是两项；第三项是 `translate('rowmenu.newFile')` 且走 `requestRowNewFile`；「复制路径永远可用、
只禁用创建」的规则对两个创建项都成立。

### 4.3 反向验证（必做，否则绿灯不算证据）

1. 把 `'wx'` 改成 `'w'` → 「同名再建 409」与「已存在不被覆盖」的断言必须红（`'w'` 会截断已有文件，
   这是**真事故**的形态，值得一条专门的断言）。
2. 删掉 `assertRemoteFence(router, child)` → 挂载根外那条必须红。
3. 删掉 `sftpLstatOrNull` 的 409 分支 → 同名那条必须从 409 变 500 而你发现它变红。
4. 把 `refreshFilesPanel()` 那行删掉 → 客户端源码断言必须红。

## 5. 任务 4 —— 文档

- `docs/features.md`：`新建文件夹` 行（`:349`）后面加一行「新建文件」，写清「远端目录行与本地空白处、
  `POST /create-file`、父目录 + 单个路径段、0 字节、已存在 409、越界 / 只读 / 停用在写盘前拒绝、
  成功后选中新行但**不自动打开**（见 §6）」；`本地空白处菜单` 行（`:350`）从「恰好两项」改成三项；
  `行菜单收窄`（`:352`）把分组描述改成「新建文件 / 新建文件夹与重命名 / 删除各占一组」。
- `docs/ui.md:503`（本地空白处菜单两项 → 三项）与 `:783`（「新建文件夹只对远端目录出现」→ 两个新建项）。
- `docs/architecture.md:778` 那条路由清单：它现在写着「33 条路由」且漏了 `read-text` / `write-text` /
  `edit-text`（**已有陈旧，属顺带修**）。改成 **37 条**并把四个名字都补上。
- `docs/development.md:14` 的 HTTP routes 36 → 37；套件表里 `mutations-smoke`（`:269`）与
  `tree-blank-menu-smoke`（`:258`）的条数与描述同步。
- `tests/lifecycle-smoke.mjs:71` 的 `EXPECTED_ROUTES` 36 → 37（四条断言都读这一个常量）。
- `CHANGELOG.md` 的 `## [未发布]` 下已有 `### 新增` 一节，加一条：一句话说清「之前只能新建文件夹、建不了文件；
  现在远端目录行与本地空白处各有一条入口，走一条独立的 `POST /create-file`，独占创建、0 字节」，不要写实现史。
- 断言总数按实测重算：`node scripts/doc-numbers.mjs --assertions <求和>`，然后 `--check` 必须 up to date。

## 硬要求

1. **一个新路由，不新增工具**（工具数仍 11）、不新增诊断 kind、不改 `/status` 字段形状。
2. **不放宽任何围栏**。三条写围栏（workspace root / 会话 workspace / sandbox mode）照旧各自生效，
   顺序也照旧（参数 → 名字规则 → 会话归属与 mode → 挂载围栏 → 父目录 → 冲突 → 独占创建）。
3. **不引入新依赖**。本包只有 `ssh2` 一个依赖。
4. **注释按 `CONTRIBUTING.md`**：写做什么、关键处写为什么、危险处多写，**不留迁移史**。
5. 改到按注释文本 / 源码文本定位的锚点时（`tests/*.mjs` 与 `scripts/reverse-verify-*.mjs` 大量使用），
   **同一个 commit 内同步更新**，否则下一次全量门禁才红。
6. 两个 commit 即可：`feat(fs)` 服务端 + 测试，`feat(tree)` 客户端 + 测试；或者一个 commit 全包。
   **不回退、不掺入工作树里那一路语法高亮工作。**

## 验收命令

```sh
DSH_CORE_ROOT=/f/GitHub/.asar-full/dsh/node_modules node tests/mutations-smoke.mjs
TMP=/f/GitHub/.tmpdir TEMP='F:\GitHub\.tmpdir' node tests/tree-blank-menu-smoke.mjs
node tests/lifecycle-smoke.mjs
node scripts/lint.mjs
node scripts/check-doc-links.mjs
node scripts/doc-numbers.mjs --check
node scripts/client-map.mjs --check
DSH_CORE_ROOT=/f/GitHub/.asar-full/dsh/node_modules node tests/run.mjs   # 必须 0 failed
```

## 不做什么

- **不自动打开新文件**。编辑器按钮挂在预览头部（`lib/client/client.editor.js` 的 `FileEditAction`），
  插件没有「导航宿主预览」的门；唯一的办法是在宿主树上合成点击（先点行、再点我们自己的铅笔），
  那会把用户正在读的预览标签抢走，而两次合成手势都是对着别人的 DOM。**选中并聚焦新行就结束**。
- **不做「创建后填内容」**：不接收 `text`、不做模板 / 预设格式（`.md` 骨架之类）。空文件是唯一语义，
  内容交给编辑器。
- **不做嵌套路径一步创建**（`a/b/c.txt`）：与 `mkdir` 一致，一个路径段；要分层就先建目录。
- **不做多选批量新建**、不做拖拽新建、不做「重命名时不覆盖」之类顺带改动。
- **不动 `write-text` / `edit-text` 的语义**，哪怕让它们「顺便能创建」看起来更省事。

## 完成判据

- [ ] 远端目录行右键有「新建文件」，空白处同样有；本地空白处菜单也有，且是三项。
- [ ] 建出来是 0 字节文件，新行被选中并聚焦，树已刷新；预览能读到空文本、铅笔能编辑、能保存。
- [ ] 同名 409、根外 403、只读 403、停用 403、父目录缺失 404、父目录是文件 400、名字带分隔符 400。
- [ ] `.gitignore` 这种点开头名字能建。
- [ ] 四条反向验证都真红，恢复后全绿。
- [ ] 门禁全绿（含 `run.mjs` 0 failed），路由数 37 在文档与 `EXPECTED_ROUTES` 两处一致。
- [ ] 完成后删除本文件、从 `docs/FF/README.md` 的表格移除该行、在「已完成的工作流」表补一行索引，
      并把 `docs/README.md` 里 `FF/README.md` 那行的描述改回只提 06。

## 报告格式

按编号给：**期望 → 实际 → PASS/FAIL**。代码落点写 `文件:行`。测试结果给逐套件的
`=== N passed, M failed ===` 与门禁七条的原样输出。最后一段写剩余风险：
至少要说清「自动打开没做」与「本地新建只从空白处菜单进」这两条限制，以及在真实 GUI 里怎么手工验一遍。
