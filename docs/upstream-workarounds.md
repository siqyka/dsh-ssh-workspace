# 上游临时补丁（workaround）登记

> 定位：本插件对**宿主自身缺陷**打的临时补丁的清单与退役步骤。
> 每一条都写了「上游原文」「一行修法」「怎么删」「怎么判断可以删」。

插件与宿主的关系是：宿主提供接缝（`ctx.fs` / `ctx.shell` / `ctx.subprocess` /
`sessionProjections` / `workspaceRegistry`），插件在这些接缝上接管行为。**接管**不需要
登记——它是插件存在的理由。**绕开宿主缺陷**才需要登记：那类改动随宿主升级失去意义，
留着只会变成没人敢删的历史包袱。

因此本页只收第二类。每条补丁都有：

- 一个**稳定 id**（形如 `UPSTREAM-1-working-directory-isAbsolute`），全仓库可 grep；
- 一段**代码内标记**，就在被改的那几行旁边；
- 一个**自动退役信号**：上游修好后补丁自己不再生效，并在状态接口里说出来；
- 一个**测试信号**：对应的套件在上游修好的那次升级上变红，红的意思是「删掉我」。

> 抽象成可复用方法的部分见 [upstream-workaround-pattern.md](./upstream-workaround-pattern.md)。本页是这个方法在本仓库唯一实例上的具体登记。

## 登记表

| id | 宿主包 | 症状 | 上游修法 | 退役判据 |
| --- | --- | --- | --- | --- |
| `UPSTREAM-1-working-directory-isAbsolute` | `@deepseek-ai/dsh-working-directory` | `cwd` 为 `ssh://` 的会话打开时报「历史加载失败 … Invalid input」 | `refine(isAbsolute)` → `refine((value) => isAbsolute(value))` | 已注册的 schema 接受的**同时**证明在读 `isAbsolute` 绑定（见「怎么判断可以删」） |

## UPSTREAM-1-working-directory-isAbsolute

### 上游原文

`node_modules/@deepseek-ai/dsh-working-directory/lib/index.js`：

```js
const directorySchema = z$1.string().min(1).refine(isAbsolute).nullable()
```

### 缺陷

`refine(isAbsolute)` 把谓词当**值**交给 zod——模块在服务构造那一刻持有的那个
`isAbsolute` 函数。插件的内建桥接（`lib/fs-shim.js`）替换 `node:path.isAbsolute`
并调用 `syncBuiltinESMExports()`，那只能更新 ESM **绑定**：

| 调用方 | 读绑定还是读值 | 补丁是否生效 |
| --- | --- | --- |
| 会话头校验（`dsh-session`）、`dsh-fs-local` | 调用时读绑定 | 生效 |
| 已构造好的 `directorySchema` | 构造时捕获的值 | **不生效** |

于是会话能建、能继续对话，但**重新加载历史**时
`sessionProjections.restore` 的 `viewSchema.parse(header.cwd)` 对 `ssh://host/path`
返回 false，zod 抛错，`session-query` 把它包成会话查询错误，gateway 再兜底成
`gateway/internal`，用户只看到 `Invalid input`。

### 上游修法（一行）

```js
const directorySchema = z$1.string().min(1).refine((value) => isAbsolute(value)).nullable()
```

改完之后每次校验都重新读绑定，补丁立刻对这个 schema 生效，本插件的整块 workaround
都不再需要。它对「把函数当值传进 refine」这一类写法都免疫。

### 插件侧补丁

`lib/patch-projection.js` 把**已注册**单元的两个 schema 换成惰性判定（`ssh://` 直接
放行，其余交还原 schema），并用一层 `register` 包装覆盖「插件先加载、单元后注册」的顺序。
放宽范围只有 `ssh://` 一种形态：相对路径、空字符串照旧被拒，`null` 照旧通过，
其它投影单元完全不动。安装点在 `lib/index.js` 的
`ctx.inject(['sessionProjections'], …)` 块（代码里有 `UPSTREAM WORKAROUND #1` 的框注）。

### 怎么判断可以删

**自动信号（首选）**：上游修好后，`installProjectionRelaxation` 会先用一个
`ssh://` 值探测已注册的 schema；能通过**并且证明它读的是绑定**，就**什么都不打**，返回
`upstreamFixed: true` 与 `probe: 'fixed'`。

> **为什么「能通过」不够。** 本插件的内建桥接是在自己的 `apply()` 里装的，而
> `workingDirectory` 单元是在它的服务第一次被访问时才构造——所以在真实部署里，
> schema 捕获到的是**已经被我们替换过的** `isAbsolute`。它当然接受 `ssh://`，
> 但源码里那行 `refine(isAbsolute)` 一个字都没变，缺陷原封不动。
>
> 只看「接受」就会把它报成 `fixed`，而 `fixed` 打印出的建议是「删掉它」——
> 于是一个**仍然承重**的补丁被这个误报劝退了。v0.2.8 之前的探测就有这个问题，
> 面板上的红灯（诊断判定把 `fixed` 报成「需处理」）正是它。
>
> 判别式因此是：探测时把 `node:path.isAbsolute` 换成一次性的记账包装，
> 看 schema 是否**调用了它**。捕获了函数值的 schema 永远不会碰这个属性；
> 真正读了绑定的才会。见 `lib/path-binding.js` 的 `acceptsByReadingBinding`。

这个结论**不走 `ctx.logger`**——本部署没有 console exporter，`info` 进一个无人读取的环形缓冲，
`debug` 更是低于所有默认级别。所以它落在两个真正能到达的地方：

```
ssh_workspace_status → upstreamWorkarounds[]   # 每次启动都重建的当前状态表
ssh_workspace_status → events[]                # 其中 kind: 'upstream' 的那条
面板 status 路由      → upstreamWorkarounds[]
```

状态工具会把这一条直接渲染成人话：

```
upstream workaround OBSOLETE: UPSTREAM-1-working-directory-isAbsolute — 上游 schema 已接受 ssh://，删掉它
```

看到这行就可以删了。本模块自己放宽过的 schema 带
`Symbol.for('dsh-ssh-workspace.projection.schema')` 标记，探测时先被排除（`already`）；
「捕获了我们的补丁」是另一回事，它由绑定读取来排除（`broken`）。

**"探不动"是独立的一种状态，不是"没修"**。如果宿主改了内部形状（例如
`registry.registrations` 不再是 `Map`），探测会返回 `probe: 'unprobeable'` 而不是静默当作缺陷仍在；
它同时进 `events`（`cannot judge this Host`）并在状态里显示。这种情况下补丁仍按保险装上，
但它已经无法判断自己在退役之后是否还有必要——**看到 `unprobeable` 要当成警告处理**，
回到本节重新判断即可。

完整状态集：`fixed`（可删）/ `broken`（仍承重）/ `pending`（单元还没注册，正常）/
`already`（本进程内已由另一次安装放宽）/ `unprobeable`（无法判断）/ `disabled`（被环境变量关掉）。

**测试信号**：`tests/projection-real-smoke.mjs` 第一节断言「缺陷仍然存在」（未放宽的
真实 schema 必须拒绝 `ssh://`）。上游修好后这一节变红——**红在这里表示「workaround
可以删了」，不是回归**，且失败信息里直接印着五步删除清单。`tests/projection-relax-smoke.mjs`
的对应断言同理。

**手工信号**（不装新版本也能验）：

```
DSH_SSH_WORKSPACE_DISABLE_UPSTREAM_WORKAROUNDS=1   # 重启 DSH
```

然后打开一个 `cwd` 是 `ssh://` 的存量会话：

| 结果 | 含义 |
| --- | --- |
| 历史正常加载 | 上游已修好，删掉 workaround |
| 报「历史加载失败」 | workaround 仍在承重，保留 |

这个开关只跳过上游 workaround，不影响插件的任何其它接管。跳过这个事实同样会出现在
`upstreamWorkarounds` 里（`probe: 'disabled'`），不会只写进一条没人读的日志。

### 删除步骤

1. `lib/index.js`：删掉带 `UPSTREAM WORKAROUND #1` 框注的
   `ctx.inject(['sessionProjections'], …)` 块，以及顶部 `patch-projection.js` 的 import；
2. 删 `lib/patch-projection.js`；
3. 删 `tests/projection-relax-smoke.mjs`、`tests/projection-real-smoke.mjs`，
   并从 `tests/run.mjs` 的 `SUITES` 里去掉 `projection-relax`、`projection-real`；
4. 删本页，并从 [docs/README.md](./README.md)、根 `README.md` / `README.en.md`
   的文档索引里去掉这一行；
5. 更新 `docs/architecture.md` 的「一处补丁打不到的地方：按值捕获的 schema」一节——
   该节描述的是缺陷本身，删掉补丁后可以整节移除，或改成「宿主已修复」的一行说明；
6. `lib/engine.js`：删掉 `upstreamWorkarounds` 字段与 `noteUpstreamWorkaround()`；
   `lib/tools.js` 的 status 输出与 `lib/routes.js` 的 status 路由去掉 `upstreamWorkarounds`，
   `lib/diagnostics.js` 去掉 `KINDS.upstream`（连同 `tests/diagnostics-smoke.mjs` 里对应的断言）；
7. [upstream-workaround-pattern.md](./upstream-workaround-pattern.md) 的「本仓库的现状」
   一节改成「当前没有登记在案的补丁」——**那一页不要删**，它讲的是方法，不是这个实例；
8. `CHANGELOG.md` 记一条「移除 UPSTREAM-1 临时补丁」。

第 2 步之前先确认第 1 步的 import 已删：ESM 对缺失文件是硬错误，不会静默。

### 为什么不做成「自动消失」

插件可以在探测到上游已修后跳过打补丁（现在就是这么做的），但**不能**自动删除自己的
代码。留着这段代码的成本是：每次读 `lib/index.js` 都会看到它。成本很低，而误删一个
仍在上游旧版本上承重的补丁，代价是所有存量远端会话打不开。所以策略是「自动停止生效 +
主动提示」，删除由人做。

## 相关

- [architecture.md](./architecture.md) — 内建桥接与投影校验的机制
- [troubleshooting.md](./troubleshooting.md) — 用户侧的「历史加载失败」排查
- [development.md](./development.md) — 测试套件与发布流程
