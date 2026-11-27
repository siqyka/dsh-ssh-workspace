# FF/15 · 目录传输加速：打包流式 + 增量跳过

> 状态：待实施。优先级 **P1**。复杂度：高（约 1 周）。前置：无。**它是 [FF/17](./17-jobs-panel-prompt.md) 的前置**（产出 `engine.execStream`）。对应问题：[FX P6](../FX/README.md)。

## 背景

目录传输今天只有一条路：`uploadTree` / 逐文件 `transferFile`（`lib/transfer/transfer.js`）。每个文件至少一次 `open` + 若干 `write` + `rename`，在 200–300 ms 的链路上，几千个文件的目录要几十分钟。`lib/report/capabilities.js` 的 `UNPROBED_CAPABILITIES` 明确写着 `tar` → "no code path shells out to tar"、`rsync` → "incremental sync is not implemented at any level"。

## 目标

两档加速，不改 `ssh_workspace_transfer` 的参数形状：

- **packed**：远端有 `tar` 时，目录上/下传各走**一条流**（上传：本机 tar 流 → SFTP 写远端暂存 → 远端 `tar -xf` 到暂存目录 → `mv`；下载：远端 `tar -cf -` → 流式写本机暂存 → 本机解包）。
- **incremental**：无 `tar` 时仍逐文件，但先用**一次** exec 批量取 `size + mtime`，与本地 `sourceIdentity` 比对，相同即 skip。

结果对象新增 `mode: 'packed' | 'incremental' | 'per-file'`、`skipped`、`bytes`。

## 复用

- `lib/transfer/transfer.js`：`transferFile` 的分块与暂存-发布、`uploadTree` 的名字排序、`DEFAULT_MAX_BYTES`。
- `lib/transfer/transfer-rules.js`：`sourceIdentity(stats)`、`treeFilter(rules)`、`decideConflict`、`planResume`。
- `lib/transfer/archive.js`：已有 zip / tar 的**本机**实现（`downloadTreeAsArchive`），可反向用于「下载流解包」与「上传流打包」。
- `lib/engine/engine.js` 的 `exec`：退出码判定、`StringDecoder`、断线不重试已产生输出的命令——新方法要沿用这些语义。
- `lib/report/capabilities.js`：把 `tar` 从 `UNPROBED` 移回 `TOOL_CAPABILITIES`（它真的会被执行了）。

## 改造

1. **`engine.execStream(alias, { command, signal, cwd })`** → `{ stdout: Readable, stderrTail: () => string, result(): Promise<{ exitCode }>, terminate() }`。
   - 退出码判定与 `exec` 完全一致：`undefined` / `null` 均 reject（连接丢失），非零 exit 是有效结果。
   - stdout 不设收集上限（流式消费方自己限），stderr 只留尾窗 16 KiB。
   - 连接 `holds` 在流结束或 `terminate` 后释放。
2. **packed 上传**：本机 `tar.create()` 流 → `transferFile` 的 SFTP 写路径写到远端 `<目标同级>/.dsh-up-<id>.tar` → `tar -xf <暂存> -C <暂存目录>` → `mv` 到目标（目标存在时按 `conflict` 策略处理，`refuse` 不动任何东西）→ 清理暂存。成员数上限 20 000，解包字节上限 `DEFAULT_MAX_BYTES × 4`，超出中止并清理。
3. **packed 下载**：`tar -cf - -C <根> .` → 本机暂存文件 → `archive.js` 解包到目标目录（目标存在时同上）。
4. **路径穿越**：解包前逐成员校验，规范化后以 `..` 开头或为绝对路径 → 整体中止、清理、返回 `EIMPORT`。
5. **incremental**：一次 exec 跑 `find <root> -type f -printf '%s %T@ %p\n'`（GNU）；输出形状不符（非 GNU、带错误行、路径非绝对）→ 回退 per-file，**不猜**（与 `dirsListingCommand` 同一原则）。本地侧用 `fs.stat` 取同字段；任一侧取不到就当「不同」。
6. 能力探测加 `tar`；结果经 `/status` 下发，客户端进度浮层按 `mode` 显示不同文案。

## 实施步骤

1. `tests/exec-stream-smoke.mjs`：流式读取、`terminate` 阶梯、断线 reject、`holds` 释放。
2. `tests/transfer-packed-smoke.mjs`（`tests/support/fake-ssh-server.mjs` 模拟 tar 流）：上传、下载、成员上限、路径穿越拒绝、`conflict` 四种策略。
3. `tests/transfer-incremental-smoke.mjs`：身份比对、skip 统计、非 GNU find 回退。
4. 真机 WAN（≥ 100 ms）1000 文件目录，三种模式各测一次，把数字写进 `docs/development.md` 新节「传输性能测量」。
5. 反向验证 ≥ 4 处；`npm run check` 全绿。

## 约束

- 不引入 `tar` / `rsync` 的 npm 依赖：本机侧用 `archive.js` 已有的实现；远端只调用系统 `tar`。
- 上传的暂存目录与目标**同级**（同一文件系统），`mv` 才是原子的；跨文件系统时退回逐文件。
- `verify: true` 在 packed 模式下仍要给出远端/本地 SHA 比对（对整个归档或逐文件均可，但结果里要说清是哪种）。
- 远端非 POSIX 主机（见 [FF/19](./19-non-posix-remote-prompt.md)）不在本轮范围。

## 验收标准

- 1000 文件目录、≥ 100 ms 链路：packed 耗时 ≤ per-file 的 1/5（有测量记录）；incremental 在二次传输时 skipped ≥ 95%。
- 无 `tar` 主机行为与今天逐字节一致（`mode: 'per-file'`）。
- 路径穿越用例被拒且目标目录无残留。
- `verify: true` 三种模式都给出比对结论或「unverified」。
- `npm run check` 全绿；CHANGELOG；`docs/features.md`「四、传输」与「九、降级矩阵」同步；`docs/tools.md` 结果字段更新。

## 风险

- tar 炸弹（成员数 / 解包字节双上限）；busybox `tar` 的 `printf` 不支持 → 探测时同时验 `tar --version`，不符就退 incremental。
- 流式中途断线：暂存文件必须清理；续传（`resume`）在 packed 模式下**不支持**，结果里明说，不要假装支持。
