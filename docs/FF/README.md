# docs/FF —— 待实施工作流的方案与任务书

> 这个目录放的**不是已完成的功能说明**，而是**待实施的设计方案 + 可直接交给新会话执行的任务书**。
> 每一条工作流两份文件：`NN-<topic>.md` 是方案（为什么、做什么、验收判据、不做什么），
> `NN-<topic>-prompt.md` 是一次性任务书（起点状态、硬要求、顺序、验收命令）。
> 任务完成后删除对应文件，并从本表移除该行。

| # | 工作流 | 方案 | 任务书 | 状态 |
| --- | --- | --- | --- | --- |
| 01 | 测试骨架与代码整合（内存 SFTP + 插件宿主 + 渲染；清基线红） | — | — | **已实施**（`tests/support/`，`docs/development.md` 的「共享替身」一节） |
| 02 | 远端 Skills 发现（默认关闭 + 主机白名单 + 围栏 + 上限） | — | — | **已实施**（`lib/surface/remote-skills.js`，`tests/remote-skills-smoke.mjs` 55 项；说明见 `docs/features.md` 五之三 与 `docs/architecture.md` 的「远端技能发现」一节） |
| 03 | 右侧文件树的文件编辑（远端 + 本地同一条路由；版本 + 哈希双校验 + 409 不覆盖 + 写围栏） | — | — | **已实施**（`lib/routes/text.js` + `lib/client/client.editor.js`，`tests/text-routes-smoke.mjs` 69 项与 `tests/file-editor-smoke.mjs` 53 项；说明见 `docs/ui.md` 的「文件编辑」一节） |
| 08 | 文件树菜单改成「数据模型 + 宿主渲染」（有 `ctx.contextMenus` 时由宿主画，老宿主保留自绘；菜单条目变成纯数据，便于加项） | [08-tree-context-menu.md](./08-tree-context-menu.md) | [08-tree-context-menu-prompt.md](./08-tree-context-menu-prompt.md) | 方案 |

状态取值：方案 = 已定方向待评审；进行中 = 已开工；完成 = 已合入（此时应删除本目录对应文件）。

**07 与 08 的关系（2026-11-22 核对）**：07 **已实现**并已从本目录删除（改动仍在工作树里：`create-file` 路由、`API.createFile`、菜单里的新建文件项、`EXPECTED_ROUTES = 37`），索引见下表。所以现在只剩 08 要做，而且 08 是把**已经存在的**菜单项搬进模型，不需要等 07 再改一遍。

## 已完成的工作流（文件已删，留一行索引）

| # | 工作流 | 落点 |
| --- | --- | --- |
| 03 | 右侧文件树的文件编辑（读/写/改三条路由、`version` + `revision` 双校验、远端与本地同一条路由、复用 mode 门禁与写围栏） | `docs/ui.md` 的「文件编辑」一节（为什么是按钮 + 对话框、为什么两个令牌、行尾与 BOM 的往返、截断即不可写）；`docs/features.md` 二之「在浏览器里编辑」 |
| 04 | 代码拆分（去重、`statusTool` 三段分离、`routes` 按资源域拆模块、watch 集群独立、`client.js` 按懒渲染边界拆 chunk） | `CHANGELOG.md` 的 0.3.6「变更」一节；client chunk 的宿主能力实测与七条拆分边界在 `docs/optimization-and-future03.md` §1.1 |
| 05 | 同功能模块合并（16 组，`lib/` 83 → 57 个模块） | `CHANGELOG.md` 的 0.3.6「变更」一节（含合并带出的两处真缺陷）；「搬家会让检查静默变松」的四处修正见未发布段的「修复」 |
| 06 | 文件系统与编辑器的参照取舍（对照第三方 side-bar 实现：4 条必做缺陷、4 条纯优化、5 条明确不做） | `CHANGELOG.md` 的 `## [未发布]` 各条（冲突基线、watcher 上限、`beforeunload`、编码读写、文件内查找、确定性排序、单例折叠、只读分页）；`docs/ui.md` 的「文件编辑」一节；「不照抄无围栏写路由」的判定进了 `docs/optimization-and-future03.md` §2 |
| 07 | 右侧文件树的「新建文件」（远端目录行 + 远端空白处 + 本地空白处；`POST /create-file` 独占创建，0 字节，不自动打开） | `docs/features.md` 的「新建文件」一行、`docs/ui.md` 的行菜单与空白处菜单两节；`CHANGELOG.md` 的 `## [未发布]` 新增条；`tests/mutations-smoke.mjs` 与 `tests/tree-gestures-smoke.mjs` |

已完成各条（01–07）的方案与任务书已按本目录的约定删除——它们记录的是「要做什么」，
做完之后唯一还有价值的部分（实测数字、边界、踩过的坑）已经搬进上面每个落点。

## 与 03 的关系

- **01 是地基，且已完成**：03 的验收依赖「裸检出上能跑远端读写」，那正是 01 补上的
  `tests/support/fake-sftp.mjs`（连同 `plugin-host.mjs` 与 `render.mjs`）。
- **02 已完成**，它立下的权限语汇（默认关闭、主机白名单、写围栏、审计不写内容）
  正是 03 复用的那一套：会话 mode（`lib/core/mode-gate.js`）、
  写围栏（`lib/fs/remote-fs.js`）、审计不写内容（`lib/engine/engine.js` 底部）。
- **03 已完成**，没有并行项。

## 阅读顺序

- 想知道「为什么要做」 → 方案的第 1–2 节（现状与诊断）
- 想直接开工 → 任务书（起点状态已核对，不需要重新调研）
- 想知道边界 → 方案的「不做什么」一节
- 想知道 03 / 04 / 05 做过什么 → 本页上面的「已完成的工作流」表
