# FF/13 · 逐文件变更捕获补全（before / after 文本）

> 状态：待实施。优先级 **P0**。复杂度：中（约 2–3 天）。前置：无。对应问题：[FX P1](../FX/README.md)。

## 背景

宿主「变更请求」面板的逐文件文本对比由 `@deepseek-ai/dsh-workspace-changes` 的 `captureFile()` 完成：它用 `node:fs` 打开 `ctx.fs.processPath(target)` 的结果。对远端目标，`processPath` 给的是**裸远端路径**（`/home/dev/proj/a.ts`），而 `lib/fs/fs-shim.js` 的 `open` / `stat` / `readFile` 只认 `ssh://` 拼写与已学习的 scratch 镜像——于是两次捕获都 `ENOENT` → `{ kind: 'absent' }` → `sameCapture()` 判等 → **整条记录被丢弃**。插件目前只能在首次远端写入时记一条 `degraded` 诊断（`docs/features.md`「逐文件文本对比是远端盲区」）。

结果：远端工作区的变更面板只有 git 给出的文件列表，没有 before/after 文本，与本地体验不一致。

## 目标

让 `fs-shim.js` 对「已学习的裸远端路径」也走 SFTP，使 `captureFile()` 在远端会话里拿到真实内容；同时**不**违反「身份探针不得拨号」（`docs/architecture.md` 同名一节）。

## 复用

- `lib/fs/fs-shim.js`：`fs.open(path, 'r')` 已有只读 SFTP `FileHandle`（单次读封顶 256 KiB）；scratch 镜像的「first-learn-wins」注册表是现成的样板。
- `lib/patch/patch-subprocess.js`：scratch 镜像登记点，以及 `alias` 的来源。
- `lib/fs/remote-fs.js` 导出的 `sftpOpenHandle` / `sftpReadHandle` / `sftpCloseHandle`。
- `lib/engine/engine.js` 的 `withSftp(alias, fn, { kind: 'read' })` 与 `pool`（判活）。

## 改造

1. **学习表**（新，放 `fs-shim.js` 内或 `lib/core/` 一个小模块）：`Map<alias, Set<remotePathPrefix>>`。登记点两处：`patch-shell.js` 与 `patch-subprocess.js` 在 `cwd` 为 `ssh://` 且别名已解析时，记下 `alias` 与 `remotePath`（以及其父目录，供 `captureFile` 读到工作区根下的兄弟文件）。first-learn-wins，与 scratch 一致。
2. **shim 分支**：`open` / `stat` / `lstat` / `readFile` 在「非 `ssh://`、非本机 scratch」分支之前，先对路径做最长前缀匹配：
   - 命中且 `engine.pool` 有该别名活连接 → 走 SFTP；
   - 命中但无活连接 → `stat` 给合成目录答案（沿用现有规则），`open` 直接 `ENOENT`（不为捕获拨号）；
   - 未命中 → 原样交本机。
3. **挂载根校验**：命中后仍要求路径落在某个已挂载根内（`isWithinRemoteRoots`），停用工作区按既有停用围栏拒绝。读不受写围栏限制，口径不变。
4. **大小上限**：超过 256 KiB 的文件 `open` 成功但 `readFile` 抛 `EFBIG` 风格错误——宿主会按 absent 处理，而不是拿半截内容做 diff。
5. **诊断**：`degraded` 记录改为「学习表为空时才记」；学习表非空但路径未命中时记一条 `debug` 级（进诊断环，不进事件）。

## 实施步骤

1. 新套件 `tests/capture-bridge-smoke.mjs`（用 `tests/support/fake-sftp.mjs` 与 `tests/support/plugin-host.mjs`）：先复现「裸远端路径两次 `ENOENT`」，跑红。
2. 实现学习表与 shim 分支，跑绿。
3. 断言 `acquire()` 调用次数为 0（沿用 `tests/probe-smoke.mjs` 的计数写法）；断言本地路径逐字节等价（`fs-shim` 的回归底线）。
4. 真机：远端会话 `write` 一个文件 → 变更面板该行可展开看到 before/after；诊断环不再出现 `captureFile` 的 `degraded`。
5. 反向验证：注释掉新分支，套件至少 4 条变红。
6. `npm run check` 全绿。

## 约束

- 不修改宿主包。
- 读路径不扩大权限：命中学习表**不**等于授权；仍受挂载根与停用围栏约束。
- 学习表只增不减（连接代次上升时清空该别名），避免一次错误前缀永久污染。

## 验收标准

- 远端会话写入后，变更面板出现 before/after 文本；`ssh_workspace_status` 的事件里不再有 `captureFile` 的 `degraded`。
- 无活连接时任何捕获都不触发拨号（`probe-smoke` 全绿）。
- 本地工作区与 `ssh://` 拼写的行为逐字节不变。
- `npm run check` 全绿；CHANGELOG「修复」一条；`docs/features.md`「逐文件文本对比」一行改写；`docs/architecture.md` 内建桥接表加一行。

## 风险

- **路径二义**：同一裸路径字符串可能对应不同主机。用「最近一次以该前缀为 cwd 的会话」消歧，并在读前比对会话 cwd；跨主机误判会把别台机器的文件读进 diff——宁可 `ENOENT` 不可读错。
- `captureFile()` 的调用时机可能在 `patch-shell` 登记之前（会话刚创建、尚未执行命令）——此时学习表为空，行为与今天一致，不会更坏。
