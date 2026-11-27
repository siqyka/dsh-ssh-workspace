# FF/18 · 变更监视后端抽象（macOS / BSD 推送式刷新）

> 状态：待实施。优先级 **P2**。复杂度：中低（约 2 天）。前置：无。对应问题：[FX P7](../FX/README.md)。

## 背景

`lib/fs/remote-watch.js` 的 `watch` 是二分叉：`engine.capabilities` 里 `inotifywait === true` 走 `startPushWatch`，否则轮询（2 s 起、退避到 10 s）。`inotifywait` 只在 Linux 存在，于是 macOS / BSD / 部分 WSL 远端一律轮询，文件树与预览刷新慢几秒。

## 目标

把二分叉改成**后端链**：`inotifywait`（Linux）→ `fswatch`（macOS / 可装于 BSD）→ 轮询。首个「探测存在 + 建立成功」的后端胜出；建立期失败静默降级、运行期断掉经 `onError` 上报——两条降级语义与今天完全一致。

## 复用

- `remote-watch.js`：`startPushWatch` 的「建立期静默回落 / 运行期 onError」、`-r` 只对目录、`stat` 判类型、监视上限 64（`FS_TOO_MANY`）。
- `lib/report/capabilities.js`：`TOOL_CAPABILITIES` 加 `fswatch` 一行（`whenMissing` / `install` / `fallback`），探测脚本与报告自动派生。
- `engine.probeCapabilities`：一次往返探测多个工具的既有机制。

## 改造

1. 抽接口 `WatchBackend { name, available(capabilities), start(alias, target, { recursive }, onError) → { stop() }, parseLine(line) }`。
2. 实现 `InotifywaitBackend`（搬现有代码）与 `FswatchBackend`（`fswatch -0 --event created --event updated --event removed --event renamed <target>`，按 NUL 分隔解析；`-r` 行为由 `fswatch` 默认递归，文件目标用 `--file`）。
3. `watch()` 改为按链选择；探测结果里两者都 `true` 时优先 `inotifywait`（Linux 主机同时装了 fswatch 的情况）。
4. 诊断：后端选择与降级各记一条 `debug`（进环不进事件）。

## 实施步骤

1. `tests/watch-backends-smoke.mjs`（fake-ssh 模拟两种事件流）：解析、建立期失败回落、运行期断开 onError、上限 64。
2. 实现 + `capabilities-smoke` 加 `fswatch` 探测断言。
3. 真机 macOS：刷新 < 1 s；卸载 fswatch 后回退轮询且面板提示安装命令。
4. 反向验证 ≥ 2 处；`npm run check` 全绿。

## 约束

- 不新增远端依赖的自动安装（F-06 原则：只提示）。
- 轮询路径的退避参数不变。
- 文件目标与目录目标的 `-r` 语义沿用现有判定。

## 验收标准

- macOS 主机有 `fswatch` 时文件树刷新 < 1 s；缺失时回退轮询且自检提示 `brew install fswatch`。
- Linux 行为逐字节不变（`watch-smoke` 全绿）。
- `npm run check` 全绿；CHANGELOG；`docs/features.md`「九、降级矩阵」加行；`docs/architecture.md`「能力探测与推送式变更监视」一节改写。

## 风险

- `fswatch` 输出格式随版本变化（`-0` 与 `--event` 在旧版可能不存在）→ 建立期探测一次，不行就回落，不猜。
- BSD 上 `kqueue` 后端本轮不做，留空位即可。
