# 09 剩余工作 · 任务书

> 一次性任务书。读完 `docs/FF/09-remaining-work.md` 再动手；本文件只写起点、顺序和验收，不重复方案里的论证。

## 起点状态（2026-11-23 已核对）

- 仓库 `0.3.6`，分支 `refactor/code-splitting`；工作树里有一批未提交的审查修复，先看 `CHANGELOG.md` 的「未发布」段，不要重复实现 R-01（下载围栏）与行尾选择器。
- `docs/optimization-and-future03.md` 已删除，未做项与历史判定都在 `docs/FF/09-remaining-work.md`。
- 本机沙箱可能禁止 node 再 spawn：`tests/run.mjs` / `scripts/lint.mjs` 若全 EPERM 是环境问题，改用逐套件直跑（`DSH_CORE_ROOT` 用 Windows 路径）；不要因此改 runner。

## 任务

按 `09-remaining-work.md` 第 1 节的顺序做可开工项：R-09 → R-08 → R-03 → R-07 → R-10 → R-11。R-05 / R-06 / R-04 / R-02 已在起点批次修完，不要重做。

每一项：

1. 先读对应源码与现有测试，补一个**会失败**的断言（或计数桩），再改实现。
2. 修法以方案为准；涉及围栏、权限、协议字段的，先确认 `docs/protocol.md` / `docs/tools.md` / `docs/features.md` 的既有承诺，不要放宽任何写围栏。
3. 跑相关套件 + `node tests/run.mjs` + `npm run check:docs` + `npm run check:client-map`；全绿再进下一项。
4. 更新 `CHANGELOG.md` 的「未发布」段；从 `09-remaining-work.md` 删掉已完成小节，并在 `docs/FF/README.md` 的状态列里推进。
5. 不改版本号、不发布、不提交除非用户明确要求。

## 硬要求

- 不要重写 TypeScript、不要引入构建步骤、不要加新依赖。
- 不要照抄第三方「无围栏 fs 写路由」；三道写围栏是测试钉住的边界。
- R-03 先补往返计数测试再改实现；任何「省一次围栏」的优化都要证明越界目标仍在字节发出前被拒。
- R-11 没有真机（WAN SSH 主机）就整条跳过；改 `READ_CHUNK_BYTES` 必须带实测数字，盲改常量不算完成。
- R-10 合并探测时，`probe=1` 端点保留：文档预览以外的调用方（编辑器面板自己的探测）仍依赖独立探测的形状。
- R-07 若选 APG 方案，必须手工走查键盘；只加 ARIA 属性不算完成。
- 全部做完后按 `docs/FF/README.md` 的约定删除本任务书与方案文件，并把有价值的事实搬进 `docs/architecture.md` 或 `CHANGELOG.md`。

## 验收命令

```bash
node tests/run.mjs
npm run check:docs
npm run check:client-map
npm run check:editor
```

`npm run check` 是发布前门禁；本机跑不动 `lint` 时用逐文件 `node --check` 替代，并在结果里说明。
