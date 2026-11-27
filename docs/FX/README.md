# docs/FX —— 问题修复任务书

> 定位：**已确认的问题**（有代码证据或文档自述），每份是一份可直接交给实施者的任务书。
> 与 [FF](../FF/README.md) 的分工：FF 回答「下一步做什么功能」，FX 回答「现在哪里坏了、哪里脆、怎么修」。
> 一份 FX 可以引用多份 FF：当问题的唯一正解就是一个新功能时，这里只留一行指针，不重复写方案。
>
> 编号与 FF 同一套风格：`NN-<topic>-prompt.md`。文件头的「依赖」一节写清楚它必须排在哪个 FF / FX 之后。

## 问题总表

| # | 问题 | 证据 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| P1 | 逐文件变更捕获是远端盲区（`captureFile()` 走 `node:fs` 拿裸远端路径，两次 `ENOENT` 后整条记录丢弃） | `docs/features.md`「三、远端执行」的「逐文件文本对比是远端盲区」一行；`lib/fs/fs-shim.js` 的 `open` 只认 `ssh://` 拼写 | 功能：FF/13 | [13-capture-file-before-after](../FF/13-capture-file-before-after-prompt.md) |
| P2 | 对宿主内部形状依赖面宽：7 个接缝 + 内建桥 + 投影 schema 补丁依赖未公开的方法名、参数位、环境变量、注册表内部结构；`installSeam` 只能识别「方法不存在」，识别不了「方法在但签名变了」 | `lib/index.js` 的 `apply()`（各 `ctx.inject` 块）；`lib/core/upstream-contract.js` 只登记了 1 条 | 修复：FX/01 | [01-seam-contract](./01-seam-contract-prompt.md) |
| P3 | 客户端是手写的类模块系统：`republishBootNames()` 依赖「哪个 chunk 在 factory 期解构了哪个名字」的加载顺序，注释里记录了三次「静默 no-op」事故 | `lib/client/client.js` 的 `republishBootNames()` 及其上方注释；[FF/README.md](../FF/README.md)「客户端 chunk 的宿主事实」 | 修复：FX/02（与 P4 同一份） | [02-client-module-system](./02-client-module-system-prompt.md) |
| P4 | 客户端巨石：`client.js` 5471 行、`client.editor.js` 3112 行、`client.panel.js` 2609 行；chunk 边界由「是否碰到模块级 `let`」决定而非领域；渲染层无单测 | 文件行数；`CONTRIBUTING.md`「改完之后」承认客户端只能手点 | 修复：FX/02（与 P3 同一份） | 同上 |
| P5 | 能力表与实现漂移：`KNOWN_UNSUPPORTED.remoteforward` 仍写 "reverse tunnels are not supported"，但 0.4.0 已有 `ssh_workspace_reverse_forward`（只是不解析 ssh_config 里的 `RemoteForward`） | `lib/report/report.js` 的 `KNOWN_UNSUPPORTED`；`lib/surface/tools.js` 的 `reverse_forward` 工具 | 修复：FX/03（与 P9 同一份） | [03-hygiene-fixes](./03-hygiene-fixes-prompt.md) |
| P6 | 目录传输逐文件 SFTP，`rsync` / `tar` 明确「任何层级都未实现」；大目录在 WAN 上成本高 | `lib/report/capabilities.js` 的 `UNPROBED_CAPABILITIES`；`lib/transfer/transfer.js` 的 `uploadTree` | 功能：FF/15 | [15-packed-tree-transfer](../FF/15-packed-tree-transfer-prompt.md) |
| P7 | 变更监视只认 `inotifywait`，macOS / BSD 主机一律退化为 2–10 s 轮询 | `lib/fs/remote-watch.js` 的 `inotifywait === true ? startPushWatch : poll` 分叉 | 功能：FF/18 | [18-watch-backends](../FF/18-watch-backends-prompt.md) |
| P8 | 终端「不选 shell 直接开」不认远端默认登录 shell，按本机家族匹配 | `docs/architecture.md`「接管 `ctx.terminalController.shells()`」一节末尾的「已知残留」 | 功能：FF/20 | [20-default-login-shell](../FF/20-default-login-shell-prompt.md) |
| P9 | `lib/routes/routes.js` 从 `lib/engine/engine.js` 导入 `shellQuote`，而该函数实际在 `lib/core/shared.js`；路由层因此依赖引擎模块初始化（含 `requirePeer('ssh2')`） | `lib/routes/routes.js` 的 import；`lib/engine/engine.js` 顶部从 `../core/shared.js` 转发 | 修复：FX/03（与 P5 同一份） | [03-hygiene-fixes](./03-hygiene-fixes-prompt.md) |
| P10 | 测试分层导致「绿但坏」：裸检出下 peer 层与真实主机层 SKIP；仓库自述两次事故 | `CONTRIBUTING.md`「三种测试」的历史陷阱段 | 修复：FX/01（与 P2 同一份） | [01-seam-contract](./01-seam-contract-prompt.md) |
| P11 | 命令确认策略是浅匹配：子串 + 不锚定正则，易误报/漏报；文档承认 "shallow in what they promise" | `lib/surface/tools.js` 的 `RULE_SETS` 与其注释 | 功能：FF/16 | [16-command-allowlist](../FF/16-command-allowlist-prompt.md) |

## 为什么这样分组

- **P2 与 P10 写在一起**：两者回答同一个问题——「宿主升级后，我凭什么相信插件还活着」。接缝契约探测负责**运行时**给出 `failed`，CI 的 peer 树负责**提交前**给出红灯；分开写会出现两套互相不知道的宿主形状清单。
- **P3 与 P4 写在一起**：`republishBootNames()` 的问题是巨石拆分的**直接后果**（拆 chunk 时按「是否碰到模块级 `let`」切，而不是按依赖图切）；只修其一，另一个会把它拉回去。合在一起的任务书要求先立「显式依赖声明」，再按领域继续拆。
- **P5 与 P9 写在一起**：都是半天以内的小修，各自单独成文不值得，放同一份任务书里作为两个独立提交。
- **P1 / P6 / P7 / P8 / P11 不在 FX 写方案**：它们的正解就是一个功能，方案在对应 FF 里；这里只登记问题与指针，避免同一件事两处描述、日后不同步。

## 依赖关系

```
FX/01  接缝契约 + CI 信号          （无前置；越早越好，后面每个 FF 都受益）
FX/03  小修                       （无前置；随时可做）
FX/02  客户端模块系统               （无前置，但应在 FF/17 之前——它会新增一个 chunk）
FF/20  默认登录 shell              （无前置）
FF/13  逐文件变更捕获               （无前置）
FF/14  Git 操作闭环                 （无前置；建议在 FF/13 之后，两者都动「变更请求」面板）
FF/16  命令确认 allowlist           （无前置）
FF/15  目录传输加速                 （新增 engine.execStream，是 FF/17 的前置）
FF/17  后台任务面板                 （依赖 FF/15 的 execStream 与 FX/02 的 chunk 规范）
FF/18  监视后端抽象                 （无前置；排在性能项之后）
FF/19  非 POSIX 远端                （依赖 FX/01 的方言探测位；最后做）
```

## 完成后的约定

与 FF 相同：实施完成 → 把落点写回本页总表的「落点」列 → 任务书缩成指针页（或删除，若环境允许）。
