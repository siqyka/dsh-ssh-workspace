# FF-06 任务书：文件系统与编辑器的参照取舍

> 方案见 [06-fs-and-editor-reference.md](./06-fs-and-editor-reference.md)。
> 本文件是**可直接交给新会话执行**的任务书：起点状态已核对，不需要重新调研。

## 起点状态（已核对）

- 仓库 `F:\GitHub\dsh-ssh-workspace`，分支 `refactor/code-splitting`。
- 测试基线：`node tests/run.mjs` → **97 passed / 2 partial / 3 skipped / 0 failed（102 suites）**。
  （开工前实测；若数字不同，先弄清差的套件是哪来的，不要直接改期待值。）
- 需要 `DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules`，否则 `lib/core/peers.js` 在解析 DSH peer 时抛错。
- 全量门禁：`npm run check`（= lint + docs + client-map + test + pack）。
- 相关文件：
  - `lib/fs/remote-watch.js`（637 行，watcher 注册表）
  - `lib/fs/remote-fs.js`（1,914 行，SFTP 路由；`listDir` 在 `:862`，`publishRename` 在 `:1804`）
  - `lib/routes/text.js`（780 行，读/写/改三条路由）
  - `lib/routes/entries.js`（947 行，目录列表路由；`compareForTruncation` 在 `:100`）
  - `lib/client/client.editor.js`（957 行，编辑器 chunk）

## 本轮范围：只做前四项

按方案的 §6 顺序，**本轮只做 1–4**。第 5 项（编码）及之后各自独立成轮，不要顺手开始。

### 任务 1 —— 冲突基线分开存（缺陷 4）

**问题**：`lib/client/client.editor.js:657-666` 保存成功只推进 `baseVersion` / `baseRevision`，不保留「上次保存的字节」。`touch` / `git checkout` / 格式化工具重写出相同字节时，`revision` 变了而内容没变，用户被弹一个不存在的冲突。

**要求**：
- `state` 增加 `savedBytes`（上次 load 或 save 成功时的文本）。
- 收到 409 时，先重读当前文本：与 `savedBytes` **逐字节相同**（不要做行尾归一，参照的 `sameDocument` 在这里会误判——我们的 `eol` 已经由服务端管）→ 原地采纳新 `version` / `revision`、保留草稿、**不弹冲突框**、不消耗「覆盖」确认。
- 字节不同 → 走现有冲突流程，行为不变。
- 重读失败（网络/权限）→ 不要吞掉，退回现有冲突流程。

**不要做**：不要动服务端的 `FS_STALE_VERSION` 判定；不要加「强制覆盖」开关（现有 `overwrite` 已经是重读后再写，是正确的）。

### 任务 2 —— watcher 条数上限（缺陷 1）

**问题**：`lib/fs/remote-watch.js:71` 的 `this.watches = new Map()` 没有上限。展开几十个目录 = 几十条并发轮询。

**要求**：
- 新增常量 `WATCH_MAX_ENTRIES`，初值 64，写在现有五个常量旁并加注释说明「这是资源保护不是策略」。
- 超限时：**明确返回未能监视**（不是静默丢弃）。参照的措辞是「折叠任何一个目录就腾出一个槽位」，落到我们这里就是「关闭一个 watch 后新的才能进来」。
- 释放路径已存在（最后一个订阅者关闭时删除），确认它确实腾出槽位。
- 加断言：注册到上限后，再多注册一个必须拿到「未监视」的明确答复，且关闭一个后能成功注册。

**不要做**：不要改轮询间隔与退避常量；不要改成 LRU 静默淘汰（静默淘汰会让文件树默默停止刷新，正是这个插件最容易犯的错）。

### 任务 3 —— `beforeunload` 守卫（缺陷 5）

**问题**：`lib/client/client.editor.js:532` 的 dirty 检查只在点关闭按钮时触发；刷新页面丢草稿，且完全静默。

**要求**：
- 编辑器处于 dirty 时注册 `beforeunload`，`event.preventDefault()` 并设置 `returnValue`（两种写法都要，浏览器实现不一致）。
- dirty 转 clean（保存成功）或组件卸载时解绑。
- 复用现有的 `isDirty(text, baseText)`（`:133`），不要另算一份。

**不要做**：本轮不做 localStorage 持久化草稿。方案里已说明我们比参照容易（内联面板没有「宿主抢走标签页」的路径），`beforeunload` 够用。

### 任务 4 —— 排序确定性（优化 1 + 2）

**问题**：`lib/fs/remote-fs.js:874` 用 `localeCompare`，且没有目录优先；`lib/routes/entries.js:101` 有目录优先。两处不一致。

**要求**：
- `listDir` 的排序改为：**目录优先**，然后 `toLowerCase()` + 码点比较，最后用原始名做 tie-break（参照的 `compareEntries` 就是这个形状）。
- 实测应为 10k 名字 ~5ms（`localeCompare` 是 ~15ms），且顺序与 `localeCompare` 在这个命名集合上一致。
- 与 `lib/routes/entries.js` 的 `compareForTruncation` 语义对齐——两者都必须是「目录优先 + 确定性」。

**不要做**：不要动 `listDir` 的「只用 `entry.attrs`、缺失才回退 stat」结构。那是刻意的（1 readdir 而非 1+N）。

## 硬要求

1. **每个任务一个 commit**，代码与测试同一个 commit，结束时全绿。
2. **注释按 `CONTRIBUTING.md` 的约定**：总体写做什么，关键处写为什么，危险处多写，尽量精简；**不留迁移史**（不要写「以前这里是怎么做的」）。
3. **不要放宽任何围栏**。三个写围栏（workspace root / 会话 workspace / sandbox mode）是被测试钉住的。
4. **不要引入 CodeMirror 或任何新依赖。** 本包只有 `ssh2` 一个依赖，这是刻意的。
5. 改到测试按注释文本定位的锚点时（`tests/*.mjs` 里 493 处 comment-text `slice`/`indexOf`，`scripts/reverse-verify-*.mjs` 里 190 处 `find:`），**同一个 commit 内同步更新锚点**。
6. 新增/修改的常量与阈值，写进对应文件的常量区并带一行注释说明取值理由。

## 验收命令

```sh
# 单套（快）
node tests/text-routes-smoke.mjs
node tests/file-editor-smoke.mjs
node tests/watch-sharing-smoke.mjs
node tests/dirs-listing-smoke.mjs

# 全量（必跑，结束时必须 0 failed）
npm run check
```

`npm run check` 应输出：`all N modules parse` · `client-map: 1 map(s) describe 17 section(s)` · `=== run.mjs: 98 passed, 2 partial, 3 skipped, 0 failed (103 suite(s)) ===`。

> 注意：`scripts/reverse-verify-*.mjs` 不在 `npm test` 里，但改了对应代码要手动跑一次。目前已知 `reverse-verify-download-tree.mjs` 与 `reverse-verify-shell-cwd.mjs` 各有一条 **在 `main`（`9aac799`）上就已经失效**的锚点（`SKIP (pattern not present)`），不是本轮引入的，不要顺手修。

## 完成判据

- [ ] 任务 1：相同字节 + 新 `revision` 时**不弹**冲突框，草稿保留，后续保存成功；不同字节仍然弹。
- [ ] 任务 2：达到 `WATCH_MAX_ENTRIES` 后再注册得到明确答复；关闭一个后可再注册。
- [ ] 任务 3：dirty 时刷新页面被浏览器拦下；保存后不再拦。
- [ ] 任务 4：`listDir` 目录优先且顺序确定性（同一集合两次排序结果相同，且与码点序一致）。
- [ ] `npm run check` 全绿。
- [ ] 四个 commit，每个都能独立 revert。
- [ ] 完成后删除本文件与 `06-fs-and-editor-reference.md`，从 `docs/FF/README.md` 的表格移除该行、在「已完成的工作流」表补一行索引。

## 未纳入本轮（不要开始）

缺陷 2（UTF-16/GBK 读）· 缺陷 3（编码回写）· 缺陷 6（查找）· 优化 3（单例折叠）· 优化 4（分页读）。
它们各自需要独立一轮；理由与顺序见方案 §6。

## 进度（按用户指示扩到全清单后追加）

用户的口头指示是「先修缺陷，再做优化」，范围比本文件最初写的四个任务宽，所以按方案 §6 的完整清单推进。
到这里已完成：**缺陷 4（冲突基线）· 缺陷 1（监视上限）· 缺陷 5（卸载守卫）· 缺陷 2（编码读取）· 缺陷 3（编码回写）· 缺陷 6（文件内查找）· 优化 1（`listDir` 确定性排序 + 目录优先）· 优化 2（单例目录折叠）**。
缺陷 2 与 3 合成一轮做，因为它们必须共用同一份 `fileFormatOf`——读写分成两轮会让「读对了、写回去变了」这个最该防的失败正好落在两轮之间。
剩下只有 **优化 4（大文件分页读）**，方案里标的是「可选、中风险」，且它要改编辑器的上行契约（2 MiB 硬上限 → 分页预览），开工前应先定范围：只读分页预览，还是分页也能编辑。

用户选了**只读分页预览**（「分页也能编辑」要跨页维护令牌与编码的一致性，成本高一个数量级）。已按此完成：

- 服务端：读路由接受 `offset` / `encoding` / `eol`，一次一页 `PAGE_BYTES`（128 KiB），`decodePage` 丢掉尾部不完整字符并回 `nextOffset`；`probeShape` 对超限文件回 `{ editable: false, reason: 'too-large', paged: true }`；`revision` 为 `null`，所以协议层面无法保存。
- 顺带修掉一个**已上线**的判读缺陷：`fileFormatOf` 拿到的是按 8 192 字节切开的头部，三字节一个汉字时三分之一概率落在字符中间，严格 UTF-8 拒绝后同一批字节按 GBK 读出来正好是汉字，于是**任何大一点的 UTF-8 中文文件都被判成 GB18030**。改为只对截断样本「丢掉至多一个字符再判定」。
- 客户端：那一句拒绝变成可点的「只读分页查看（大小）」，点开 `FilePagerPanel`——按 `offset` 取页、`nextOffset` 前进、回传首页定下的 `encoding` / `eol`、正文 `readOnly`、**没有任何保存入口**。
- 套件：`text-encoding-smoke` 39 → 48、`text-routes-smoke` 88 → 102、`file-editor-smoke` 116 → 131（提交里只含本轮改动；工作区里另一路未提交的语法高亮工作另算）。

至此 FF-06 的六项缺陷与四项优化全部完成。
