# FF/20 · 远端默认登录 shell

> 状态：待实施。优先级 **P2**。复杂度：低（约半天）。前置：无。对应问题：[FX P8](../FX/README.md)。

## 背景

`docs/architecture.md`「接管 `ctx.terminalController.shells()`」一节末尾的「已知残留」：宿主在请求没有 `shellPath` 时自己走 `resolveShell`，拿到的是**本机**路径；`patch-terminal.js` 的查表按**家族**匹配，所以本机默认 shell 是 bash 时会启动远端的 bash——即使远端用户的 `$SHELL` 是 fish 或 zsh。用户「不选 shell 直接开」得到的不是远端的默认登录 shell。

作者留作独立议题的理由是：要替换 `resolveShell` 的语义，而那是宿主内部函数、不是端点。本任务书**不碰 `resolveShell`**，只在插件已有的查表层解决。

## 目标

`spawnTerminal` 的远端分支在 `spec.shellPath` 缺席（或指向本机路径）时，优先使用该主机探测结果里的 `$SHELL`；探测为空才回退现有的家族匹配；家族也不命中再回落 `sh -l`。

## 复用

- `lib/surface/shell.js`：探测结果已把 `$SHELL` 排在候选第一位，并按「主机 + 连接代次」缓存。
- `lib/patch/patch-terminal.js`：启动侧的同步只读查表（「开一个终端不该顺带发一次往返」的原则不变）。
- `tests/remote-shells-smoke.mjs`、`tests/terminal-smoke.mjs`。

## 改造

1. 探测结果里显式保留 `loginShell` 字段（若当前只保留去重后的家族列表，补这一个字段）。
2. `patch-terminal.js` 查表顺序改为：`spec.shellPath` 命中已发现集合 → 按发现路径启动；**未命中或缺席 → 取 `loginShell`**；无 `loginShell` → 现有家族匹配 → `sh -l`。
3. `spec.shellPath` 是本机路径（含盘符或 `\`）时视同缺席。
4. 诊断：选择了 `loginShell` 时不记事件（正常路径）；回退到 `sh -l` 时记一条 `debug`。

## 实施步骤

1. `remote-shells-smoke.mjs` 加用例：探测到 `loginShell=/usr/bin/fish`、本机默认 bash、请求无 `shellPath` → 启动 `fish -l`；请求带本机 `shellPath` → 同样 `fish -l`；探测为空 → 旧行为。
2. 实现；`terminal-smoke` 回归。
3. 真机手点：远端 `$SHELL` 为 fish，不选直接开 → 得到 fish；`echo $SHELL` 正确。
4. 反向验证 1 处；`npm run check` 全绿。

## 约束

- 只影响远端分支；本地终端逐字节不变。
- 启动侧仍不发往返：没有探测过就是「没命中」。
- 不改宿主 `resolveShell`。

## 验收标准

- 远端 `$SHELL=/usr/bin/fish`、本机默认 bash 时，不选直接开得到 fish。
- 本地终端与 `ssh://` 会话里显式选择 shell 的行为不变。
- `npm run check` 全绿；CHANGELOG「修复」一条；`docs/architecture.md` 该节的「已知残留」段落改写为「已处理：未指定时取探测到的 `$SHELL`」；`docs/features.md`「shell 菜单与启动一致」一行末句同步。

## 风险

- 宿主可能对「`shellPath` 缺席」有自己的语义（例如总是用本机默认并在 UI 上如此显示）——若真机发现 UI 显示与实际启动不一致，以**实际启动**为准并在卡片上标注「远端默认」。
