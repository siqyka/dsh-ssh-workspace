# 实现任务书：远程工作区会话归属的自动认领与防复发诊断

> 本文件是一次性任务书，交给一个**新的 Agent 会话**执行：读完之后直接改代码，不需要重新调研。
> 实现与验收通过后删除本文件，并同时移除 `docs/README.md` 里对应的一行索引。

## 0. 一句话目标

插件缺席运行过一段时间之后，`ssh://` 工作区的会话在侧栏里永久消失（文件还在）。本任务在**插件侧**加一段启动补偿，把这些会话重新挂回它们的工作区，并把"还有多少没挂回去"变成可观测的状态，而不是静默。

## 1. 必须先理解的根因（已核对，不要重新推导）

会话文件没有丢，丢的是**归属记账**。宿主的 `@deepseek-ai/dsh-workspace`（本机 `0.2.1-rc.2`，入口
`lib/index.js`，共 953 行）用 `fs.realpath` / `fs.stat` 校验每个会话的 cwd，两条链路叠加成"静默作废"：

1. **索引层**：`indexHeader()`（`@deepseek-ai/dsh-workspace/lib/index.js:875-895`）里
   `realpathNormalize(header.cwd)` 失败 → 该 id 进 `invalidSessionPaths`，**既不入** `sessionPaths`，
   **也不入** `missingSessionPaths`。而成员判定是
   `candidateMatches: (id, path) => this.sessionPaths.get(id) === path || this.missingSessionPaths.has(id)`
   （`:367`）。插件不在时 `ssh://` 的 `realpath` 必然失败（本插件的内建桥接没装），于是这些会话
   **不匹配任何工作区**，被 `get sessionIds()`（`:102-104`）直接过滤掉。
2. **持久化层**：过滤结果会被写真。`mutate()`（`:173-191`）里
   `const sessionIds = changed.sessionIds.filter((id) => this.host.candidateMatches(id, changed.path))`
   之后 `table.update` 落盘。任何一次对该工作区的 `attachSession` / `setTitle` / `detachSession`
   都会把当时"解析不了"的旧会话从记录里真删。

**宿主没有重新认领路径**：`bootstrap()`（`:758-810`）只在注册表**从未初始化**时跑一次
（`[Service.init]` `:379-396`：`if (!this.state.initialized) {…await this.bootstrap(headers)}`），
之后头索引只在 `readSessionHeader` 未命中时重建（`:916-929`）。重装插件只恢复"工作区行 + 文件系统
服务"，救不回会话归属。

**为什么补偿能成功**：`attachSession`（`:111-129`）的三重校验是
`realpathNormalize(header.cwd)` → `stat(cwd).isDirectory()` → `cwd !== record.path`。
本插件的内建桥接（`lib/fs-shim.js:934` `installBuiltinBridge`，由 `lib/index.js:410` 在
`ctx.inject(['fs'])` 里安装）会替换 `node:fs/promises.realpath` 与 `node:path.isAbsolute`：
`realpathRemote`（`lib/fs-shim.js:417-425`）只要 `liveRecord(...) !== undefined ||
coversMountedRoot(state, parts)` 就返回 `parts.displayPath`（词法规范拼写），`statRemote`
（`:361-370`）在无连接但覆盖挂载根时返回 `assumedDirectoryStats`。所以**只要该根已经被
`router.addRoot()` 挂上**，这三重校验就能通过——这正是本任务的实现前提。

**本机真实数据（动机，不要拿来当测试数据）**：`~/.dsh/storages/workspace.json` 里三条 `ssh://` 记录，
对应磁盘 `~/.dsh/sessions/` 下分别有 1 / 25 / 3 个会话文件，而记录只认 1 / 2 / 1；即孤儿 23 + 2 + 0。
逐目录：`--ssh-qiyk-home-qiyk-test--` 25 disk / 2 accounted；`--ssh-qiyk-home-qiyk-test-dsh-ssh-workspace--`
3 / 1；`--ssh-123-home-qiyk-sox--` 1 / 0；`--ssh-qiyk-home-qiyk-have_been--` 1 / 0。

**会继续恶化**：只要某次启动时注册表建索引早于插件桥接（bundle 顺序决定这是常态），在该工作区
新建会话或改标题就会把当时未解析的旧会话继续筛掉并写盘。

## 2. 交付内容（三件事）

### 2.1 启动补偿：重新认领

在 `lib/index.js:540` 那段 `ctx.inject(['fs', 'workspaceRegistry'], …)` 里改造成**两阶段**，
并新增一个模块承载可测逻辑（建议 `lib/ownership.js`，纯函数 + 显式依赖注入，不直接摸 `ctx`）：

- **阶段一（已有）**：对每个 `registry.list()` 里 `isRemotePath(path)` 且不在 `detachedSet` 的记录
  做 `activeRouter.addRoot(parts.alias, parts.remotePath)`（现状 `lib/index.js:557`）。
- **阶段二（新增）**：根挂好之后再逐个记录做认领。**顺序不能反**——`attachSession` 依赖
  `coversMountedRoot`，根没挂上时 `realpathRemote` 会抛 `notFoundError('realpath', path)`。

阶段二规格：

```
for each entity where isRemotePath(entity.path) && !detachedSet.has(entity.path):
  path = entity.path
  headers = 会话头列表（见下）
  candidates = headers.filter(h => canonicalRemote(h.cwd) === path && !entity.sessionIds.includes(h.id))
  candidates.sort((a, b) => b.createdAt - a.createdAt)   // 新→旧，attachSession 是前插
  for each candidate: await entity.attachSession(candidate.id)  // 逐个 try/catch
```

- **会话头来源**，按顺序降级，任一不可用就跳过并记一条 `degraded`，**不要抛**：
  1. `ctx.get('sessionQuery')?.listSessions()` —— 返回 `[{ header, live, persisted }]`，
     `header` 是 `structuredClone` 过的快照，live 优先（`@deepseek-ai/dsh-session-query/lib/index.js:95-121`）。
  2. `ctx.get('sessionPersistence')?.list()` —— 返回 `[{ header, formatStatus, revision, sizeBytes }]`
     （`@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:2603`）。
  3. 都没有：本次不认领，记 `degraded` 说明"没有可读的会话清单"。
- **cwd 判据是精确相等，禁止前缀匹配**：会话 cwd 是子目录时它本来就不属于任何工作区（宿主只在
  "规范化后字符串完全相等"时认账）。比较前对 `ssh://` 拼写做词法规范化
  （`parseRemotePath` + `formatRemotePath`，`lib/protocol.js:30/:82`），对非 `ssh://` 拼写保持原样比较。
- **绝不创建、移动、删除工作区**：只用已存在的记录，只调 `attachSession`。不调 `detachSession`，
  不调 `createCanonical`，不碰宿主 `node_modules`。
- **整段 `try/catch` + 成败记账**：单个会话失败不影响其余；整段失败只记一条 `degraded`，
  绝不让插件激活失败。注入回调不是 `await` 的，用 `void (async () => {…})().catch(…)` 之类，
  别让未处理的 rejection 冒出来。
- **只跑一次/激活**：模块内用一次性的 `started` 布尔守住（插件 reload 会重新激活，重跑一次是安全的，
  但同一激活里不许重复扫）。天然幂等：`attachSession` 对已在账上的 id 会走 `mutate` 的 no-op 分支。
- **不扫 detach 的工作区**：它们的根没被 `addRoot`，`realpath` 必然失败，扫了只会产生假失败。
  把它们计成 `skipped`，不进 `failures`。

### 2.2 防复发：把"没挂回去多少"变成可观测状态

不要每次 status 轮询都去读会话持久化——本仓库有一条硬规矩：状态面是**读**，
"一次状态轮询不得变成磁盘遍历或网络活动"（见 `lib/diagnosis.js:1-40` 的模块注释、
`lib/routes.js:962` 的注释）。所以：

- 认领结束时把一份**快照**挂到 engine 上（沿用 `engine.upstreamWorkarounds` / `engine.audit`
  这类既有字段的写法）：

  ```js
  engine.ownership = {
    at: Date.now(),          // 本次扫描时间
    scanned: n,              // 扫过的工作区数
    reclaimed: n,            // 成功认领的会话数
    pending: n,              // 仍未挂回、且确实存在的会话数（= 失败数）
    skipped: [path, …],      // 被跳过的 detach 工作区
    failures: [{ path, sessionId, reason }],   // reason 是不含别名的人读短句
  }
  ```

  字段名可以改，但**必须同时满足**：`reclaimed` / `pending` 是数字，`failures` 带得动
  "哪个工作区、哪个会话、为什么"，且不含主机别名拼进字符串（诊断详情的规矩见
  `lib/diagnosis.js:38-50`：别名单独成字段，报告侧统一遮蔽）。

- **新诊断事件 kind**：`lib/diagnostics.js:45-58` 的 `KINDS` 里加 `ownership`（封闭集合，
  加完要一起改测试，见 §3.2）。只有"确实发生了"才记：`reclaimed > 0` 记一条
  `KINDS.ownership`（例如 `reclaimed 23 session(s) for 2 remote workspace(s)`），`pending > 0`
  记一条 `KINDS.degraded` 说明还有多少没挂回去。全 0 时**什么都不记**，免得正常启动变成噪音。
- **判定项（finding）**：`lib/diagnosis.js` 的 `diagnose()` 里加一段，读 `source.ownership`：
  `pending > 0` → `add('workspace-ownership', STATE.warn, '…n session(s) …are not attached to their
  remote workspace, so they are hidden from the sidebar')`。`pending === 0` 不产出 finding
  （只有问题才进 findings，见 `:126-138` 的 `add`/`note` 分工）。这条是**可行动**的，
  不是可选工具缺失，所以进 findings 而非 notes。
- **接入两处状态面**（同一份数据，两处渲染）：
  - `lib/tools.js:801` `statusBundleInput()` 的返回对象加 `ownership: engine.ownership`；
    `lib/tools.js:1000` 起的 `diagnosis` 输出 schema 与 `:1100+` 的 render 只加**必要**字段
    ——渲染一行只在 `pending > 0` 时出现，形如
    `N session(s) are stored under this remote workspace but are not attached; they are hidden from the sidebar`；
    另需在 `ssh_workspace_status` 的 `output.schema` 里声明新增的 `ownership` 对象
    （`additionalProperties: false` 的 schema 会拒收未声明字段，这是本仓库踩过的坑：
    `events[].seq` 就是漏声明导致整个结果被拒，见 `tests/tool-results-smoke.mjs:15` 的注释）。
  - `lib/routes.js:962` `diagnosisInput()` 同样加 `ownership: engine.ownership`。
- **不要**给状态面加任何新的磁盘读、连接或探测。

### 2.3 上游根治（只写文本，不改宿主）

在 `docs/optimization-and-future03.md` 的账本里登记一条"上游阻塞"项，写清两处应改的上游行为，
供日后提 issue 或等上游修好后删除本任务的补偿：

- `mutate()` 不该因为 cwd 在本机解析不了就删账（应保留，或降级为 `missingSessionPaths` 语义）；
- `indexHeader()` 对"字符串与某个已登记工作区 path 完全相等的 cwd"应直接认作成员（URI 语义），
  不必先过 `realpath`。

**不要**去改 `node_modules` 里的宿主包，也不要修 `.asar-full` 那份拷贝。

## 3. 测试

### 3.1 新套件 `tests/workspace-ownership-smoke.mjs`

登记进 `tests/run.mjs` 的 `SUITES`（`:56` 起，固定顺序数组；不登记就永远不跑），
位置放在 `'diagnosis'` 附近、live 套件之前。体例照抄现有套件：纯 ESM、`check(name, ok)` 累加、
末行打印 `=== N passed, M failed ===` 并以退出码表达结果。

用**假 registry / 假 entity / 假 sessionQuery**（不要碰真实 `~/.dsh`，也不要连 SSH）。
必要断言：

1. 精确匹配的未记账会话被 `attachSession`，且调用顺序为新→旧（`createdAt` 降序）。
2. 子目录 cwd（`…/sub`）不被认领；另一台主机同路径不被认领；非 `ssh://` 的本地 cwd 不被认领。
3. 已在 `sessionIds` 里的 id 不重复 attach。
4. detach 的工作区被跳过且计入 `skipped`，**不**计入 `failures`。
5. 单个 `attachSession` 抛错时其余继续，`pending` / `failures` 数字与内容正确。
6. 会话清单两个来源都不可用时：不抛错，`pending` 不虚报（0 或明确"未检查"），并有一条 degraded 事件。
7. 连跑两次：第二次不再 attach（幂等）。
8. `reclaimed` / `pending` 快照数字与夹具一致；`failures[].reason` 内不含别名。
9. `diagnose({ ownership })` 在 `pending > 0` 时产出 `workspace-ownership` 的 `warn` finding，
   `pending === 0` 时不产出。

### 3.2 必须一起改的既有测试

- `tests/diagnostics-smoke.mjs:149-157` 断言"`KINDS` 里每个 kind 都在
  `engine.js` / `remote-fs.js` / `forward.js` 源码里被 `KINDS.<name>` 实际使用"。
  新增 `KINDS.ownership` 后，把**真正记录它的那个文件**加进这份源码清单
  （若记录点在 `lib/ownership.js`，就加它），否则该断言必红。
- `tests/tool-schemas-smoke.mjs:279-281` 的 `ssh_workspace_status` 夹具：
  新增 `ownership` 后确认这三条仍然通过；如字段设为必填，需要同步补进夹具。
- `tests/lifecycle-smoke.mjs:71` 的 `EXPECTED_ROUTES` **不动**（本任务不加路由）。
  工具数量仍是 11，`docs/development.md` 的 tools 计数不变。

### 3.3 验证命令

```bash
node scripts/lint.mjs
node tests/workspace-ownership-smoke.mjs       # 新套件，逐条看
node tests/diagnostics-smoke.mjs
node tests/diagnosis-smoke.mjs
node tests/tool-results-smoke.mjs
node tests/tool-schemas-smoke.mjs
npm run doc-numbers                            # 重生成之后
npm run check:docs                             # 链接 + 数字 --check
npm test                                       # 全量（会起子进程）
```

**沙箱注意**：如果当前会话处于受限沙箱，`test` 里的子进程会 `EPERM`，
`node tests/run.mjs` 会得到几十个假失败。此时逐套件直跑 `node tests/<name>-smoke.mjs`，
并在报告里注明哪几项是环境限制而非代码问题。

## 4. 文档与变更记录

- `CHANGELOG.md` 顶部 `## [未发布]` 的**修复**段追加一条，风格照该段现有条目：
  讲清"会话文件没丢、丢的是归属记账"、补偿时机（每次激活、根挂好之后）、
  以及"认领失败会在 `ssh_workspace_status` / 面板报出来，不再静默"。
- `docs/features.md`：在"工作区"能力域补一小段——远程工作区会话的归属会在插件激活后自动补齐；
  仍不可恢复的情形（工作区被 detach、远端目录已删除、会话清单不可读）与对应的可观测信号。
- `docs/troubleshooting.md`：加一条症状 → 判据 → 处置（"卸载过插件后侧栏少了远程会话"），
  指向 `ssh_workspace_status` 的 `ownership` 与诊断事件。
- `docs/optimization-and-future03.md`：按 §2.3 登记上游阻塞项 + 本补偿的删除条件。
- 若新增了 `lib/ownership.js`：`docs/development.md` 的 `modules under lib/` 计数由
  `npm run doc-numbers` 自动重算，别手改。
- `docs/README.md`：删除本任务书时同时删掉它的索引行（见文首说明）。

## 5. 硬约束

1. **不改宿主**：`node_modules/@deepseek-ai/**` 与 `F:\GitHub\.asar-full\**` 一字不动。
2. **不扩权**：不新增路由、不新增 Agent 工具、不改 `EXPECTED_ROUTES = 33`、
   不新增 `ssh_workspace_*` 工具（工具数仍 11）。
3. **不碰别人的改动**：工作树里现有 `M CHANGELOG.md / README.md / README.en.md /
   docs/commit-history.md / docs/development.md / docs/features.md / lib/client.js /
   tests/commit-history-smoke.mjs` 属于另一条在改的线，只在你需要追加的位置动，不要回退。
4. **不碰用户真实数据**：禁止卸载插件、禁止改 `~/.dsh/storages/workspace.json`、
   禁止删 `~/.dsh/sessions/`。要做端到端验证就用 `DSH_HOME` 指向一个临时目录的 scratch 环境。
5. **状态面保持只读**：任何新的状态字段都必须来自内存快照，不得在读路径上引入磁盘遍历或网络探测。
6. **失败方向是"不做事并说出来"**：认领是补偿，不是关键路径；任何异常都必须被兜住并留痕。

## 6. 验收判据

- [ ] 新套件通过，且 §3.1 的 9 条断言都有对应用例（不是一条大 `check`）。
- [ ] `diagnostics-smoke` / `diagnosis-smoke` / `tool-results-smoke` / `tool-schemas-smoke` 全绿。
- [ ] 全量 `npm test` 的结果与文档记录一致（套件数 +1；`npm run doc-numbers` 后 `check:docs` 通过）。
- [ ] 手工构造一次"宿主先建索引、插件后接管"的场景（scratch `DSH_HOME` + 假 registry 或真宿主），
      验证三个数字：认领前 `sessionIds` 少、认领后相等、`engine.ownership.reclaimed` 等于差额。
- [ ] 把该工作区设为 detach 后重启：不产生假失败，`skipped` 里出现该路径。
- [ ] `ssh_workspace_status` 在 `pending > 0` 时能读到一行 warn；面板 `/status` 的
      `diagnosis.findings` 里有同一个 `workspace-ownership` 条目（两处不许给出两个故事）。

## 7. 报告格式（实现完成后回给用户）

用下表逐条给结论，不要贴大段代码：

| 编号 | 期望 | 实际 | PASS/FAIL |
| --- | --- | --- | --- |

然后补三段：① 代码落点（`lib/xxx.js:行号`）；② 测试结果（套件名 + passed/failed + 是否有环境导致的 SKIP）；
③ 剩余风险（至少写：认领顺序若被后续改动打乱会静默失效、`ownership` 快照只反映最近一次激活）。
