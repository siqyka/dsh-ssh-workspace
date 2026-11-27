# FX/01 · 接缝契约探测 + CI 宿主形状信号（P2 + P10）

> 状态：待实施。优先级 P1（中期第一批）。复杂度：中（约 3 天）。前置：无。

## 问题

**P2 — 对宿主内部形状依赖面宽。** `lib/index.js` 的 `apply()` 用 `installSeam()` 装了 7 个接缝，另有内建桥（`lib/fs/fs-shim.js`）与一条上游补丁（`lib/patch/patch-projection.js`）。它们依赖的都是宿主**未公开**的形状：

| 依赖的形状 | 位置 | 宿主改了会怎样 |
| --- | --- | --- |
| `ctx.fs.writeText / editText` 的**第 5 个参数**是 `sandboxPolicy` | `lib/fs/remote-fs.js` | 参数位变了 → 模式判定回落到部署默认，`read-only` 会话可能放开写（静默） |
| `spec.env.DSH_SESSION_ID` 两个终端调用方都会写 | `lib/patch/patch-terminal.js` | 改名 → 门禁取不到会话，fail-closed 拒绝（吵但安全） |
| `registry.registrations` 是 `Map`、单元带 `stateSchema / wire.viewSchema` | `lib/patch/patch-projection.js` | 已有 `unprobeable` 状态，但其它接缝没有同款 |
| `argv[0]` 运行器形状（`landlock-run` / `bwrap` / 打包 exe） | `lib/patch/patch-subprocess.js` 的 `unwrapSandboxArgv` | 新运行器 → 白名单拒绝，带文案 |
| `sandbox.confine` 返回 `{ argv, enforcement, denialSignatures, runnerFailureRules }` 且同步/异步形态 | `lib/patch/patch-sandbox.js` | 字段缺失 → 调用方判定失效 |

`installSeam()` 现在只能区分「服务缺席 / 已装 / 方法不存在」（`lib/index.js` 的 `installSeam`）。**「方法在、但签名或语义变了」它会报 `installed`**——这是最危险的一格，因为状态面会说一切正常。

**P10 — 测试分层导致「绿但坏」。** `CONTRIBUTING.md`「三种测试」自述：peer 层与真实主机层在裸检出下 SKIP，仓库出过两次「测试全绿但功能坏了」。`tests/support/peer-mode.mjs` 已把 `broken` 变成失败，但 stub 树只验证「能加载」，不验证形状。

## 目标

1. 每个接缝在**安装时**做一次形状探测（arity、关键参数位置、返回值字段），结论进 `engine.seams` 的 `detail`，形状不符按 `failed` 处理（而不是 `installed`）。
2. 把「宿主形状清单」从代码里抽成一张表（`lib/core/host-shapes.js`），接缝探测与 CI 的 peer 树检查**读同一张表**。
3. CI：当 `DSH_CORE_ROOT` 指向真实宿主树时，逐项断言形状；stub 树（`tests/peer-stubs.mjs`）按同一张表**生成**，而不是手写——加一条形状，stub 自动跟上，且「stub 不验证形状」这句话变成假的。

## 复用

- `installSeam()` 的三态与诊断事件（`lib/index.js`）。
- `lib/patch/patch-projection.js` 的探测写法：`fixed / broken / pending / unprobeable`——把「探不动」当成独立状态的思路直接搬过来。
- `tests/support/peer-mode.mjs` 的四态检测器、`tests/peer-stubs.mjs` 的 stub 树。
- `lib/core/upstream-contract.js` 的 `CONTRACTS` 表（它是「grep id 能列出全部位置」的先例）。

## 改造点

1. 新建 `lib/core/host-shapes.js`：
   ```js
   export const HOST_SHAPES = Object.freeze({
     'fs.writeText.arity': { probe: (fs) => fs.writeText?.length, expect: (n) => n >= 5, seam: 'PATCH-fs',
       detail: 'ctx.fs.writeText must accept sandboxPolicy as its 5th argument' },
     // …每个接缝一条，字段：probe / expect / seam / detail
   })
   ```
2. `installSeam(id, absent, install)` 增加第四个参数 `shapes`（该接缝的形状键列表），`installed` 之前逐条跑；任一不符 → `noteSeam(id, 'failed', detail)` 并**卸载刚装的包装**（否则是一个半装的接缝）。
3. `tests/peer-stubs.mjs` 改为从 `HOST_SHAPES` 生成 stub 的方法签名（至少 arity），并新增 `tests/host-shapes-smoke.mjs`：对每个 `probe` 用「错误形状」喂一次，断言 `failed`。
4. `tests/support/peer-mode.mjs` 在 `real` 模式下追加一次形状断言，结果进套件输出（真实树不符 → 红，不是 SKIP）。
5. 文档：`docs/architecture.md`「接缝接管的结果表」加「形状探测」一列；`CONTRIBUTING.md` 的「三种测试」表把「stub 不验证宿主形状」那句改掉；`docs/troubleshooting.md` 加一条「seam failed: shape …」怎么读。

## 约束

- 探测必须是**纯读**：不能为了探测调用一次真实方法（`writeText` 探测只看 `.length`，不写文件）。
- 探测失败不得让插件激活失败——沿用 `installSeam` 的「抛错 → 记录 → 退化」路径。
- 不要把形状表做成「所有宿主版本的并集」：一张表只描述**当前支持的最小形状**；版本差异由 `peerDependencies` 范围表达。
- 不新增运行时依赖。

## 验收

- `tests/host-shapes-smoke.mjs`：每条形状键各有「符合 → installed」「不符 → failed 且包装已卸载」「探不动 → failed 且 detail 带 unprobeable」三个用例。
- 反向验证：把 `ctx.fs.writeText` 的 arity 探测删掉，套件至少 3 条变红。
- 手工：用 `DSH_CORE_ROOT` 指向真实宿主树跑 `npm test`，输出里能看到每条形状的判定。
- `npm run check` 全绿；CHANGELOG「修复」一条；`docs/development.md` 套件表加新套件。

## 风险

- 宿主方法若用 rest 参数或默认值，`.length` 不可靠——此时 `probe` 改为读 `Function.prototype.toString()` 的参数文本，或改为「调用一次带哨兵参数的 dry-run」。优先前者，后者只在必要时。
- stub 按 arity 生成后，`tests/` 里依赖 stub 具体行为的套件可能变红；那是预期的，逐个修。
