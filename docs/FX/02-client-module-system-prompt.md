# FX/02 · 客户端显式依赖声明 + 按领域继续拆 chunk（P3 + P4）

> 状态：待实施。优先级 P2（中期，但须在 FF/17 之前）。复杂度：中高（约 1 周）。前置：无。

## 问题

**P3 — 手写的类模块系统。** `lib/client/client.js` 是无构建的手写主包，12 个 chunk 经 `require.async` 懒加载，借名字走 `require('<插件 id>')` 接缝。`republishBootNames()` 的注释记录了三次真实事故，形态完全一样：

> 某 chunk 在**自己的 factory 执行期间**就 destructure 了主包 `exports` 上的名字；主包在模块求值时先用 `Object.assign(exports, …)` 发布了占位符；chunk 加载时拿到的是占位符的**拷贝**，之后主包再赋值真值，chunk 永远看不到——**静默 no-op，没有任何报错**。

为了压住它，现在的做法是：加载顺序分三批（kernel → 图标 → 其余），并在 `loadBootChunks()` 末尾手工重发布一串名字。这条链每一环都靠人记：新加一个 chunk、新借一个名字，都要同步改顺序表和重发布表，漏一处就是静默失效。

**P4 — 巨石与边界。** 拆分后主包仍 5471 行；`client.editor.js` 3112 行、`client.panel.js` 2609 行。chunk 的切分依据是「从声明出发遍历引用，碰到模块级 `let` 就留下」（见 `docs/architecture.md`「总体结构」），这是**技术边界**而非领域边界，所以面板、编辑器、传输队列各自仍是大块。渲染层没有单测，`CONTRIBUTING.md` 要求改 `client.js` 后必须在浏览器里手点。

## 目标

1. **显式依赖声明**：每个 chunk 在文件头声明 `borrows: ['API', 'fetchJson', 'TREE_ROW_SELECTOR']` 与 `provides: [...]`；主包在 `loadBootChunks()` 时按声明**校验**：借的名字必须已经发布为非占位符，否则 `console.error` 一次并在面板诊断里记一条（可见，而非静默）。
2. **删掉 `republishBootNames()` 的手工清单**：改为「按 `provides` 声明自动重发布」。名字清单只剩一处真相（chunk 自己的声明）。
3. **一个最小测试**：`tests/client-chunk-smoke.mjs` 增加对声明的静态检查——每个 chunk 的 `borrows` 必须能在某个启动期 chunk 或主包的 `provides` 里找到，且加载顺序拓扑可解；不可解 → 红。
4. **按领域再拆一刀**（只做一件，不贪多）：把 `client.panel.js` 里的「审计 tab」与「端口转发区」各自拆成按需 chunk，验证新机制在**真实新增 chunk** 时不需要手工维护顺序表。

不在本轮：引入打包器、TypeScript、把所有 chunk 重写——[FF/README.md](../FF/README.md)「判定不做」已有结论，本轮不翻案。

## 复用

- `window.__ModuleLoader__.load({ id, chunk, factory })` 约定与 `require.async`（宿主事实见 [FF/README.md](../FF/README.md)「客户端 chunk 的宿主事实」）。
- `scripts/client-map.mjs` 的 `clientParts()`——它已经是「有哪些 chunk」的唯一真相，声明校验挂在它上面。
- `tests/client-chunk-smoke.mjs`（已有 chunk 形状断言）。

## 改造点

1. 每个 `lib/client/client.*.js` 文件头加一段可被正则抽取的声明（不引入构建，所以用注释 + 一个导出常量双写，静态检查读注释，运行时读常量）：
   ```js
   /** @chunk client.panel
    * borrows: API, fetchJson, orderedTransferQueueItems
    * provides: mountPanel, refreshPanel
    */
   export const CHUNK = { name: 'client.panel', borrows: [...], provides: [...] }
   ```
2. `client.js` 的 `loadBootChunks()`：改为「按 `borrows` 求拓扑序 → 逐批加载 → 每批后按 `provides` 重发布」，删除手写的三批顺序与 `republishBootNames()` 列表；`Object.defineProperty` 把占位符改成 getter 也可以，但只能作为兜底，不能替代声明。
3. 借名字失败时：`console.error('[ssh-workspace] chunk client.x borrowed API before it was provided')`，并 `fetchJson(API.status)` 之外的通道——面板诊断环是宿主半边的，客户端暂时只做 console + 一个 `data-sshwsp-chunk-error` 属性供手测发现。
4. `scripts/client-map.mjs`：增加 `--check-deps`，拓扑不可解或有未声明借用 → 退出 1，并入 `npm run check:client-map`。
5. 拆审计 tab 与转发区各成一个 chunk，用新机制加载，确认零手工顺序表。
6. 文档：`docs/architecture.md`「总体结构」把「分三批」那段改写成「按声明拓扑排序」；`CONTRIBUTING.md`「代码约定」加一句「新 chunk 必须写 borrows/provides」。

## 约束

- 仍然**不引入构建步骤**；声明用注释 + 常量，静态检查用正则，与 `scripts/lint.mjs` 同一路数。
- 不能改变现有 chunk 的**懒加载边界**（哪些是启动期、哪些按需）——这一轮只改「怎么知道顺序」，不改「哪些该拆」之外的事。
- 遮蔽组件（`ForgeTabWithHistory`）、`apply()` 期安装在 `document` 上的桥不能进 chunk（宿主事实，已踩过）。
- 命名 `client.<name>.js` 与 `CLIENT_CHUNK` 正则约束不变。

## 验收

- `node scripts/client-map.mjs --check-deps` 对当前 12 个 chunk 全部通过。
- 人为把 `client.marks.js` 的 `borrows` 里加一个不存在的名字 → `check:client-map` 红，且错误文案指出 chunk 与名字。
- 把 `client.kernel.js` 从启动期顺序里挪到后面（模拟顺序错）→ 新套件红；恢复后绿。
- 拆出的两个新 chunk 在浏览器里实际点一遍（审计 tab、转发区），无 console 报错。
- `npm run check` 全绿；`client.js` 行数下降并记录在 CHANGELOG（与 0.4.0 的「12,604 → 4,343」同一口径）。

## 风险

- 拓扑排序可能暴露**已经存在的循环借用**（A 借 B、B 借 A）。那就先解循环（把共享的名字下沉到 kernel），不要用「把它当启动期」绕过。
- 注释与常量双写会漂——静态检查以常量为准，注释只给人读；若 lint 发现两者不一致直接红。
