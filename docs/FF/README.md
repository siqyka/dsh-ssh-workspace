# docs/FF —— 五条工作流的方案与任务书

> 这个目录放的**不是已完成的功能说明**，而是**待实施的设计方案 + 可直接交给新会话执行的任务书**。
> 每一条工作流两份文件：`NN-<topic>.md` 是方案（为什么、做什么、验收判据、不做什么），
> `NN-<topic>-prompt.md` 是一次性任务书（起点状态、硬要求、顺序、验收命令）。
> 任务完成后删除对应文件，并从本表移除该行。

| # | 工作流 | 方案 | 任务书 | 状态 |
| --- | --- | --- | --- | --- |
| 01 | 测试骨架与代码整合（内存 SFTP + 插件宿主 + 渲染；清基线红） | — | — | **已实施**（`tests/support/`，`docs/development.md` 的「共享替身」一节） |
| 02 | 远端 Skills 发现（默认关闭 + 主机白名单 + 围栏 + 上限） | — | — | **已实施**（`lib/remote-skills.js`，`tests/remote-skills-smoke.mjs` 55 项；说明见 `docs/features.md` 五之三 与 `docs/architecture.md` 的「远端技能发现」一节） |
| 03 | 右侧文件树的文件编辑（远端 + 本地同一条路由；版本 + 哈希双校验 + 409 不覆盖 + 写围栏） | [03-remote-file-editing.md](./03-remote-file-editing.md) | [prompt](./03-remote-file-editing-prompt.md) | 方案 |
| 04 | 代码拆分（去重 + `tools` / `routes` / `remote-fs` 的 watch 集群 + `client.js` 的懒渲染边界） | [04-code-splitting.md](./04-code-splitting.md) | [prompt](./04-code-splitting-prompt.md) | 完成 |
| 05 | 同功能模块合并（16 组：`lib/` 83 → 57 个模块，含 `tar`+`zip` → `archive`、`match-eval` 并回 `ssh-config` 消环；不碰 `lib/routes/` 与 `lib/client/`） | [05-module-merges.md](./05-module-merges.md) | — | 方案（16 组已定；轨道 A 的 A1–A4 已提交，合并本体未开工） |

状态取值：方案 = 已定方向待评审；进行中 = 已开工；完成 = 已合入（此时应删除本目录对应文件）。

## 五条工作流之间的关系

- **01 是地基，且已完成**：02 和 03 的验收都依赖「裸检出上能跑远端读写」，那正是 01 补上的
  `tests/support/fake-sftp.mjs`（连同 `plugin-host.mjs` 与 `render.mjs`）。02 已经在用它，03 照着用即可。
- **02 已完成**：远端技能发现已落地，方案与任务书按约定删除；边界与实现见
  `docs/features.md` 五之三、`docs/architecture.md` 的「远端技能发现」一节。它立下的
  权限语汇（默认关闭、主机白名单、写围栏、审计不写内容）是 03 要复用的那一套。
- **03 与 02 互不依赖**，但复用同一套权限语汇：会话 mode（`lib/mode-gate.js`）、
  写围栏（`lib/remote-fs.js:2019/2040/2082`）、审计不写内容。
- **04 与它们都不同**：它不是新功能，而是把现有代码拆开，所以它**不改任何权限语汇**——
  围栏、mode 门禁、审计全部原样。它唯一的硬约束是「每步不新增红」，以及
  `client.js` 的 chunk 只能按**懒渲染边界**拆（段间依赖图里有一个 11 段强连通分量）。
  04 与 03 **建议串行**：两者在同一批文件里搬东西，并行会互相踩。
- **05 是 04 的延续**：04 的轨道 A 建了 `lib/text.js` / `lib/options.js` /
  `lib/forward-common.js` / `lib/shell-quote.js` 四个「给一行逻辑开一个文件」的模块，
  05 的第 1 组再把它们并成一个 `lib/shared.js`，然后按「其实是一件事」给出 16 组
  合文件方案（`lib/` 83 → 57 个模块，删 26 个文件）。两者都只搬代码、不改语义，
  但**都会动 `lib/` 的顶层文件名**，所以 05 与 04 的轨道 C/D 必须串行，
  且每一步都要重跑 `scripts/doc-numbers.mjs`（`modules under lib/` 会从 83 一路降到 57）。
  05 明确不碰 `lib/routes/` 与 `lib/client/`——那两块是用户特意拆的。
- 各份方案共有一条底线：**替身不得比真宿主宽松**、**远端内容按不可信处理**、
  **默认关闭而不是默认开启**；04 与 05 额外一条：**移动不改语义**。

## 阅读顺序

- 想知道「为什么要做」 → 方案的第 1–2 节（现状与诊断）
- 想直接开工 → 任务书（起点状态已核对，不需要重新调研）
- 想知道边界 → 方案的「不做什么」一节
