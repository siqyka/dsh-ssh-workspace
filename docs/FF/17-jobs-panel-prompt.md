# FF/17 · 远端后台任务面板

> 状态：待实施。优先级 **P1**。复杂度：中（约 3 天）。前置：[FF/15](./15-packed-tree-transfer-prompt.md)（`engine.execStream`）、[FX/02](../FX/02-client-module-system-prompt.md)（新 chunk 的声明规范）。

## 背景

插件能在远端起三类「在后台跑着」的东西：`ssh_workspace_exec` 的 `run_in_background`、`ssh_workspace_shell` 里的 `&` 作业、面板里触发的远端命令。它们的状态今天分散在工具返回值、宿主自己的 jobs 注册表（`patch-shell.js` 把前台超时的命令提升为后台 job）和持久 shell 的通道里——**没有一个地方能回答「这台主机上现在替我跑着什么」**，更不能从界面上停掉。`hostAborts`（硬停用时批量 abort）已经证明引擎知道自己在飞的操作，只是没暴露。

## 目标

新增一个只读 + 可终止的「后台任务」面板（面板第五个 tab 或主机卡片展开区）：

- 列出插件自己开的远端通道：类型（`exec` / `background` / `shell-job`）、主机、开始时间、命令（脱敏、截断 400）、状态（`running` / `done` / `aborted` / `unknown`）；
- 每行可「看输出尾窗」（最后 8 KiB）与「终止」；
- **不**接管宿主自己的 jobs 注册表，只展示插件自己登记的通道，避免两套真相。

## 复用

- `engine.hostAborts`（`Map<alias, Set<AbortController>>`）与 `engine.exec` 的 `onExpiry` / abort 路径。
- `ShellManager`（`lib/surface/shell.js`）的 PTY 通道与 `run()`。
- `command-log.js` 的脱敏器（`redactCommand`）、字段上界。
- `client.transfer-queue.js` 的浮层模式与 `queueItemPercent` 一类纯函数的写法（无钟、无 DOM 的规则放 kernel）。
- `routes/kit.js` 的 `guard()` / `writeJson()` / `abortOnClientGone()`。

## 改造

1. **注册表**：`engine.jobs = new Map()`，项 `{ id, alias, kind, command, startedAt, abort, outputTail, state }`。登记点：`engine.exec`（`run_in_background` 分支）、`ShellManager.run`（作业形态）、`patch-shell.js` 提升为后台时。连接关闭 / `forget` / 硬停用时把该别名所有项置 `unknown` / `aborted` 并保留 60 s 后清除。
2. **路由**：`GET /jobs?alias=`、`POST /jobs/terminate { id }`（guard + JSON）。终止走 abort → TERM → 5 s → 丢弃连接（与 `patch-shell.js` 的 kill 阶梯一致）。
3. **审计**：`terminated` 事件记一条（`refused: false`、`exitCode: null`），沿用「结果未知」语义。
4. **客户端**：新 chunk `client.jobs.js`（按 [FX/02](../FX/02-client-module-system-prompt.md) 写 `borrows/provides`）；面板 tab 只渲染选中 pane；2 s 轮询 `/jobs`，页面隐藏时停。
5. **文案**：`unknown` 必须写成「连接已断，结果未知」，不得写成「已停止」——沿用「不承诺断线后恢复运行中命令」的判定。

## 实施步骤

1. `tests/jobs-registry-smoke.mjs`：登记、状态迁移（连接断开 → `unknown`）、硬停用 → `aborted`、60 s 清理。
2. `tests/routes-smoke.mjs` 加两条路由。
3. 面板 chunk + 套件（渲染、轮询暂停、终止按钮置灰条件）。
4. 真机：起一个 `sleep 300` 的后台 exec，面板能看到、能停；拔网线后状态变 `unknown`。
5. 反向验证 ≥ 3 处；`npm run check` 全绿。

## 约束

- 只展示插件登记的通道；宿主 jobs 不合并、不代理。
- 命令文本走 `redactCommand`，输出尾窗只保留最后 8 KiB 且**不落盘**。
- 终止是用户动作，不过模式闸门；但 `read-only` 会话里不会有新任务可列（它们本来就起不来）。

## 验收标准

- 面板能看到并终止一个 `run_in_background` 的 exec；终止后审计有记录。
- 硬停用主机后面板列表清空且每项 `aborted`；连接掉线后状态 `unknown`。
- 页面隐藏时 `/jobs` 轮询停止（网络面板可见）。
- `npm run check` 全绿；CHANGELOG；`docs/features.md`「三、远端执行」加行；`docs/ui.md` 加节；`docs/architecture.md` 加「后台任务注册表」一节。

## 风险

- 持久 shell 里的 `&` 作业没有独立退出通道，状态只能靠标记行近似——与 `ShellManager` 取退出码同一局限，文案要标「近似」。
- 注册表若忘记清理会泄漏；用「连接代次」作为清理边界，与 shell 发现缓存同一思路。
