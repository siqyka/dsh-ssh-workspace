# 任务书：补测试骨架（内存 SFTP + 插件宿主 + 渲染），并整合重叠套件

> 本文件是一次性任务书，交给一个**新的 Agent 会话**执行：读完之后直接改代码，不需要重新调研。
> 实现与验收通过后删除本文件，并同时移除 [README.md](./README.md) 里对应的一行索引。
> 背景与取舍见 [01-test-harness-and-code-consolidation.md](./01-test-harness-and-code-consolidation.md)。

## 0. 一句话目标

让「写入 / 列表 / 传输」的成功分支在**没有 SSH 主机**的裸检出上也能跑，并把 22 处手搓的宿主替身
收敛到 `tests/support/` 下的一处；同时清掉 3 条长期基线红与行尾假红。

## 1. 起点状态（已核对，不要重新推导）

| 位置 | 事实 |
| --- | --- |
| `tests/run.mjs:56` | `SUITES` 数组，91 个套件名，固定顺序，每个套件一个子进程 |
| `tests/run.mjs:157-161` | 设计意图：未设 `DSH_CORE_ROOT` 时生成 stub 根，让套件**运行**而不是跳过 |
| `tests/support/fake-ssh-server.mjs` | 447 行，真 `ssh2.Server` + 真 TCP；**SFTP 不是文件系统**（头注释明写），OPEN/CLOSE/STAT 返回固定值 |
| `tests/support/run-state.mjs:39` | `N>0 且存在 SKIP 行` → `partial`；判定正确，但没人盯「跳过了哪一段」 |
| `lib/patch-fs.js:22-38` | `REMOTE_METHODS`：resolve / processPath / stat / lstat / readText / streamText / readBytes / readByteRange / listDir / writeText / editText / watch |
| `lib/remote-fs.js:711` | `async stat (target, signal)` |
| `lib/remote-fs.js:772` | `async readText (target, signal)` |
| `lib/remote-fs.js:926` | `async listDir (target, signal)` |
| `lib/remote-fs.js:1070` | `async writeText (target, content, expected, signal, sandboxPolicy)` |
| `lib/remote-fs.js:1104` | `async editText (target, edit, expected, signal, sandboxPolicy)` |
| `lib/remote-fs.js:1154` | `async watch (target, changed, signal)` |
| `lib/remote-fs.js:2019 / :2040 / :2082` | 写围栏三件套：`writeFenceRoots` / `assertWithinRemoteRoots` / `assertFencedRealpath` |

手搓 ctx 的 14 个套件：`batch-target`、`local-changes-remote`、`local-passthrough`、`mode-gate`、
`mutations`、`patch-ptc`、`patch-sandbox`、`phase6`、`remote-git-env`、`session-catchup`、
`terminal`、`tool-results`、`transfer`、`transport`。

自建 `fakeEngine` / `fakeCtx` 的 8 处：`tests/archive-smoke.mjs:305`、`tests/forward-smoke.mjs:43`、
`tests/forward-persist-smoke.mjs:45`、`tests/routes-smoke.mjs:164`、`tests/shell-smoke.mjs:124`、
`tests/terminal-smoke.mjs:74`、`tests/transfer-smoke.mjs:184`、`tests/patch-ptc-smoke.mjs:81`。

## 2. 先做的两件事（不要跳过，成本最低）

### 2.1 `.gitattributes`

新增文件，内容至少包含：

```
* text=auto eol=lf
*.png binary
*.jpg binary
*.gif binary
*.ico binary
*.pdf binary
```

然后 `git add --renormalize .` 并检查 `git status` 只出现行尾变化。这一步之后
`workspace-ownership-smoke` 必须在**当前工作区**（不是干净 worktree）也是 0 failed。

### 2.2 修 `tests/run.mjs` 的 stub 根

`transfer-retry-smoke` 与 `transport-smoke` 现在在未设 `DSH_CORE_ROOT` 时失败，与
`run.mjs:157-161` 的设计意图不符。二选一，**并在文件头注释里写清选了哪个、为什么**：

- 让 stub 根覆盖它们需要的 peer（优先）；
- 或让它们显式打印 `SKIP <缺什么>` 并以 0 退出（次选，但必须写清缺哪个包、怎么装）。

验收：干净环境下 `node tests/run.mjs transfer-retry transport` 不出现 failed。

## 3. `tests/support/fake-sftp.mjs`

新建。要求：

1. 导出 `createFakeSftp({ files, dirs })`，返回 `{ sftp, tree, snapshot() }`。
2. `sftp` 只实现 `lib/remote-fs.js` 实际调用的方法（先 grep 调用点，再定接口）。
3. `stat` / `lstat` 返回带 mtime 与 size 的版本信息，使 `writeText(expected)` 的冲突分支可测。
4. 能注入错误：`ENOENT`、`EACCES`、`ENOTDIR`、`ENOSPC`；能配合 `fake-ssh-server` 的
   `dropAll()` 模拟「写一半断线」。
5. 未实现的方法**显式抛错**，不要静默返回 `undefined`。
6. 零新依赖。

改造三个套件先验证骨架可用：`transfer`、`mutations`、`patch-sandbox`。每个套件改完跑：

```bash
node tests/transfer-smoke.mjs      # 期望项数不降，failed 0
```

## 4. `tests/support/plugin-host.mjs`

新建。要求：

1. 导出 `createHost({ engine, remote, config })`，组装 `ctx.fs`、`ctx.tools`、`ctx.shell`、
   `ctx.subprocess`、`ctx.effect`、`ctx.logger`、`ctx.get` / `ctx.set`，能 `apply` 与销毁。
2. `ctx.fs` 的本地实现走真 `node:fs`，`ssh://` 目标交给 `remote`（`fake-sftp` 或真引擎）。
3. **替身不得比真宿主宽松**：重复 `provide`、已销毁 fiber、非法 schema 都必须拒绝。
4. 迁移顺序（每批 2–3 个，每批后跑全量 `npm test`）：
   `mutations` → `mode-gate` → `patch-ptc` → `patch-sandbox` → `transfer` → `terminal` →
   `transport` → `tool-results` → `session-catchup` → `remote-git-env` → `phase6` →
   `local-passthrough` → `local-changes-remote` → `batch-target`。
5. 8 处 `fakeEngine` 收敛成 `createHost({ engine: ... })`；`forward-smoke` 与
   `forward-persist-smoke` 的同形 `fakeEngine` 必须合并成一个。
6. **负向对照**：每迁完一个套件，确认它原本会失败的用例仍然失败（临时把被断言的值改坏一次，
   看断言是否变红，再改回）。不允许只跑绿。

## 5. `tests/support/render.mjs`

新建，把 `toast-dom.mjs`(271 行) 与 `tree-dom.mjs`(336 行) 的能力抽成 `render(component, props, { inject })`。
只服务**新增**测试；既有 `client-shape-smoke` 的 335 项一条都不要动。

## 6. partial 追踪

`tests/support/run-state.mjs` 已经返回 `skipLines`。在 `tests/run.mjs` 的收尾里：

- 对每个 `partial` 套件打印它的 SKIP 行（缩进一层，带套件名）；
- 在 `docs/development.md` 的套件表加一列「跳过段」，写明跳过的是哪一段、缺什么条件。

当前 4 条：`patch-sandbox`、`reverse-forward`、`watch-sharing`、`local-changes-remote`。

## 7. 代码整合（在骨架之后）

按方案 §3.5 的发现命令先产出清单，再决定合并。硬要求：

- `lib/client.js` 只保留一份字节格式化器（当前是 `formatBytes`，`:5869`）；
- `lib/routes.js` 里不得再有绕过 `queryParam`(:508) / `parseLimit`(:558) 的手写参数解析；
- 任何合并都必须让断言总数**不下降**。

## 8. 验收

```bash
npm run lint
npm test                      # failed 必须为 0
npm run check:docs
node scripts/doc-numbers.mjs --assertions <新的加总数>
```

并逐条对照方案 §4 的 7 条判据。断言总数不得低于 4882。

## 9. 完成后

1. 删除本文件，并从 [README.md](./README.md) 移除对应索引行；
2. 在 `CHANGELOG.md` 的 `## [未发布]` 段写一条（测试骨架 + 基线治理，不写成「优化测试」这种空话，
   要写清补了哪块、消除了哪几条长期红）；
3. `docs/development.md` 的套件表、项数、`SUITES` 三者对齐，跑 `npm run check:docs`。
