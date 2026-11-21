# FF-05 同功能模块合并：把「其实是一件事」的几个文件并成一个

> 状态：**已全部实施**（16 组 16 个提交，2026-11-21 完成；§9 是完工记录，最初写方案时的起点状态留在 §9.2）。
> 轨道 A（四组重复函数收进共享模块）此前已提交（`b6f2e2d` / `f2f8554` / `75aaaa7` / `d217f5c`），
> 本辑把它们**再并一层**，并按用户指定的边界（不碰 `lib/routes/`、不碰 `lib/client/`）合并其余模块。
> 结果：`lib/` 的模块数 **83 → 57**，import 环 **6 → 5**（剩下的全是 `lib/routes/routes.js ↔ lib/routes/*.js`），
> 套件数、路由数、工具数、补丁数一个没动。
> 本辑回答：**哪几个 `lib/*.js` 其实是一件事、合并后长什么样、每一组会撞到哪几处钉在文件名上的断言、按什么顺序做**。
> 不做 GitHub issue（沿用 FF-04 的决定：只落仓库文档）。

## 0. 一句话目标

把 `lib/` 里功能同族、拆开之后读者要多跳一次却没有任何独立理由的模块合并，
**行为、导出名、错误文案、HTTP 状态码、工具输出 schema、门禁数字口径一律不变**；
每合一组都留下可机械验证的边界（变异脚本的定位名、套件 import 路径、源码扫描的排除名），
而不是靠人记住哪两块属于同一个东西。

## 1. 方案起点（写方案那一刻的实测，保留以供回溯）

> 下面这一节的数字是**写方案时**的基线（HEAD `ac720fa`）。合并全部做完之后的样子见 §9.2：
> 模块 57、环 5、其余数字不变。这一节不改写，因为「为什么当初判断这组合适」只能从当时的
> 数据读出来。

| 项 | 实测值 | 取法 |
| --- | --- | --- |
| 模块总数 | **83** | `git ls-tree -r HEAD lib/ --name-only \| grep -c '\.js$'` |
| 其中 `lib/*.js`（顶层）| 63 | 同上，`^lib/[^/]*\.js$` |
| 其中 `lib/client/*.js` | 13 | 1 个主包 + 12 个 chunk；**本方案不动** |
| 其中 `lib/routes/*.js` | 8 | `routes`（组合点 + `ROUTES` 表）/ `entries` / `forwards` / `hosts` / `kit` / `transfer-bytes` / `transfers` / `workspaces`；**本方案不动** |
| 代码行数 | **44,691** | 逐文件 `git show HEAD:<f> \| wc -l` 求和（顶层 27,280 + client 13,869 + routes 3,542） |
| import 图的环 | **6** | 对 83 个模块的出边做 DFS |
| 门禁模块数 | 83（与 HEAD 一致，`countModules` 已改成递归）| `node scripts/doc-numbers.mjs --check` |

6 个环里 **只有 1 个是功能环**，另外 5 个都是 `lib/routes/routes.js`（路由族的组合点）与它的子模块互相 `import`：

```
lib/ssh-config.js -> lib/match-eval.js -> lib/ssh-config.js      ← 功能环，本方案第 3 组消掉
lib/routes/routes.js -> lib/routes/hosts.js -> lib/routes/routes.js          ┐
lib/routes/routes.js -> lib/routes/entries.js -> lib/routes/routes.js        │ 用户指定拆分的
lib/routes/routes.js -> lib/routes/transfers.js -> lib/routes/routes.js      │ 5 个环，本方案不动
lib/routes/routes.js -> lib/routes/workspaces.js -> lib/routes/routes.js     │
lib/routes/routes.js -> lib/routes/forwards.js -> lib/routes/routes.js       ┘
```

> **起点提示**：写这份方案时，浏览器半边刚好拆完并**搬进了自己的目录**（`0c3dc23` /
> `5e3c768` / `3ee03eb` / `7d2536e` / `630588f` / `14a8508` / `ac720fa`），HEAD 上是
> `lib/client/` 下 **1 个主包 + 12 个 chunk**。所以本文所有数字都是 `HEAD` 上的实测值
> （`git ls-tree -r HEAD lib/`），不依赖工作树状态。
> **`lib/client/` 整块排除在本方案之外**——那是用户特意拆的、且刚拆完，
> 动它会让 `tests/client-shape-smoke.mjs` / `tests/client-chunk-smoke.mjs` 两套断言同时失效，
> 而且 chunk 文件名与目录都被宿主正则与 `scripts/client-map.mjs` 钉住。
>
> 两个计数口径同一次改动一起变了，开工前先认下来：`scripts/doc-numbers.mjs` 的
> `countModules()` 已改成**递归**（`lib/client/` 与 `lib/routes/` 都算），
> `tests/support/lib-modules.mjs` 的 `modulePaths()` 同理。所以「顶层 63」不再是门禁数字，
> **83 才是**；本方案的 16 组只动顶层文件，合并后应为 **83 − 26 = 57**。

### 1.1 轨道 A 已经做完的部分（不要再做一遍）

| 函数 | 现在的位置 | 提交 |
| --- | --- | --- |
| `quote` / `shellQuote` | `lib/shared.js`（组 1 已并入） | `b6f2e2d` |
| `requirePort` + `normalizedHost` | `lib/forward.js`（组 11 已并入） | `f2f8554` |
| `positive` | `lib/shared.js`（组 1 已并入） | `75aaaa7` |
| `escapeRegExp` | `lib/shared.js`（组 1 已并入） | `d217f5c` |

这些文件是**上一轮去重的产物**，每个都不足 55 行、只导出 1–2 个符号，
但仍各有 3 处以上的外部 `import` 站点。本方案第 1 组把其中三个并成 `lib/shared.js`——
不是「再抽一层」，而是承认「为 25 行开一个文件」这件事本身是多余的。
（`forward-common.js` 不走这条路：它有两个导出、语义是「端口与主机校验」，
属第 11 组，跟着方向那两件一起进 `forward.js`。）

### 1.2 三个已死的 `re-export`（合并顺手删）

| 位置 | 内容 | 现状 |
| --- | --- | --- |
| `lib/ssh-config.js:175` | `export { escapeRegExp }` | 全仓库零命中 |
| `lib/reconnect.js:51` | `export { positive }` | 全仓库零命中 |
| `lib/watch-recovery.js:54` | `export { positive }` | 全仓库零命中 |

三处都是上一轮「实现搬走、旧位置留 re-export 以免改 import」的残留；
当 `ssh-config.js`（第 3 组）与 `reconnect.js` / `watch-recovery.js`（第 5 组）合并时，
它们自然消失，不需要单独一次提交。**不要**因此去删 `lib/engine.js:1855` 的
`export { shellQuote }`——那一条还有 8 个模块在用（`fs-shim` / `patch-shell` /
`patch-subprocess` / `remote-watch` / `routes` / `verify` / `remote-shells` / `routes/entries`）。

### 1.3 被引用次数决定了合并的爆炸半径

合并的代价几乎全部来自「**别的文件按名字引用它**」。三种引用方式各不相同，落地时都要查：

1. **ES `import`**——最常见，改路径即可。
2. **套件与脚本里的文件名字符串**——`path.join(pluginRoot, 'lib', 'tar.js')` 或
   `'lib/match-eval.js'`，`scripts/reverse-verify-*.mjs` 的 `file:` 字段属于这一类。
   这类**不会因为改 import 而报错**：脚本会安静地变异一个已经不存在的文件，
   然后报告「变异没有生效」。
3. **源码扫描的排除名**——`tests/capabilities-report-smoke.mjs:124` 的
   `.filter(name => !/^(?:capabilities|tar)\.js$/u.test(name))`、`tests/diagnostics-smoke.mjs:159` 的
   `['engine.js', 'remote-fs.js', 'forward.js', 'ownership.js', 'remote-skills.js']`。
   这类最危险：**改名之后断言仍然会跑，只是结论反了**。
   注意这两处的读取方式不同：前者用 `modulePaths()` 递归走 `lib/`（`lib/client/` 与
   `lib/routes/` 都在范围内），后者是**按顶层文件名逐个 `readFileSync`**——
   后者对「文件被搬进子目录」是静默失明的，动顶层文件时才需要看它。

## 2. 方案：16 组

**目标名的规则**（本方案统一遵守，避免每组都重新讨论）：

- 组里有一个成员被外部引用明显最多 → **沿用它的文件名**（`engine` / `tools` / `hosts` /
  `store` / `shell` / `forward` / `passthrough` / `ssh-config` / `reconnect` / `diagnostics` /
  `patch-projection`）。这样绝大多数外部 `import` 一行都不用改。
- 没有枢纽（引用数并列）→ **起一个说清「这一族是什么」的新名**（`shared` / `archive` /
  `status` / `transfer-rules` / `report`）。名字必须是**功能名**，不是 `utils`。
- 唯一例外：`patch-projection.js` 必须保留原名——`lib/upstream-contract.js:50` 按文件登记
  它的退役判据，`scripts/doc-numbers.mjs` 又按 `lib/patch/patch-*.js` 数补丁数（现 7）。

汇总表（「外引」= 组外 `import` 语句条数 / 涉及文件数；「变异」= 钉在组内文件名上的变异条数；
「测试」= 按文件名引用组内成员的套件与脚本数）：

| # | 合并为 | 成员（行数） | 合并后 | 减文件 | 外引 | 变异 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `shared.js` | `text`(25) + `options`(31) + `shell-quote`(23) | 79 | 2 | 9 / 7 | 0 | 0 |
| 2 | `archive.js` | `tar`(178) + `zip`(465) | 643 | 1 | 2 / 1 | 4 | 3 / 1 |
| 3 | `ssh-config.js` | `ssh-config`(175) + `match-eval`(162) | 337 | 1 | 2 / 2 | 4 | 3 / 1 |
| 4 | `status.js` | `status-schema`(389) + `status-render`(129) + `status-provenance`(141) + `tool-result`(19) | 678 | 3 | 5 / 3 | 5 | 3 / 1 |
| 5 | `reconnect.js` | `reconnect`(331) + `watch-recovery`(103) | 434 | 1 | 2 / 2 | 4 | 2 / 1 |
| 6 | `store.js` | `store`(1193) + `secrets`(137) | 1,330 | 1 | 1 / 1 | 5 | 13 / 2 |
| 7 | `passthrough.js` | `passthrough`(903) + `passthrough-settings`(167) | 1,070 | 1 | 4 / 3 | 19 | 1 / 1 |
| 8 | `transfer-rules.js` | `verify`(161) + `resume`(158) + `conflict-policy`(125) + `tree-filter`(175) + `mutations`(112) | 731 | 4 | 13 / 4 | 16 | 7 / 3 |
| 9 | `hosts.js` | `hosts`(624) + `include-chain`(285) + `jump-chain`(190) | 1,099 | 2 | 2 / 1 | 16 | 14 / 3 |
| 10 | `report.js` | `support-bundle`(368) + `diagnosis`(332) + `config-audit`(284) | 984 | 2 | 7 / 4 | 4 | 7 / 1 |
| 11 | `forward.js` | `forward`(383) + `forward-common`(52) + `reverse-forward`(278) + `forward-persist`(469) | 1,182 | 3 | 5 / 3 | 6 | 6 / 1 |
| 12 | `shell.js` | `shell`(517) + `remote-shells`(493) | 1,010 | 1 | 3 / 2 | 5 | 3 / 1 |
| 13 | `engine.js` | `engine`(1933) + `audit`(256) | 2,189 | 1 | 9 / 9 | 11 | 24 / 2 |
| 14 | `tools.js` | `tools`(1770) + `command-policy`(253) | 2,023 | 1 | 1 / 1 | 9 | 15 / 3 |
| 15 | `patch-projection.js` | `patch-projection`(558) + `path-binding`(151) | 709 | 1 | 2 / 2 | 0 | 3 / 0 |
| 16 | `diagnostics.js` | `diagnostics`(228) + `redact`(119) | 347 | 1 | 12 / 11 | 2 | 6 / 1 |

合计：**83 → 57 个模块**（顶层 63 → 37，`lib/client/` 13 与 `lib/routes/` 8 不动），删掉 **26** 个文件，
16 个合并文件共 **14,845 行**。全部做完后 import 图的环从 **6 降到 5**——剩下的正好是
用户指定不动的 5 个 `routes` 环，功能环消失。

### 2.1 第 1 组：`text` + `options` + `shell-quote` → `lib/shared.js`（79 行）

三个文件都是**给一行逻辑开一个文件**的产物：`escapeRegExp` 一行、`positive` 三行、
`shellQuote` 一行（其余是注释）。

| 项 | 事实 |
| --- | --- |
| 相互依赖 | 没有 |
| 导出名 | `escapeRegExp`、`positive`、`shellQuote`，无重名 |
| 外引站点（9 条 / 7 文件） | `text`：`include-chain.js:45`、`shell.js:26`、`ssh-config.js:47`；`options`：`engine.js:29`、`reconnect.js:38`、`watch-recovery.js:39`；`shell-quote`：`engine.js:28`、`patch-terminal.js:75`、`shell.js:25` |
| 套件 / 脚本 | **零** |

**注意**：9 条里有 8 条落在**本方案其他组的成员**里（`shell`=12、`ssh-config`=3、
`engine`=13、`reconnect`=5）。所以这一组**先做**最省事：先改这 9 条，后面那些组再合并时
这些 import 已经指向 `shared.js`，不会重复改。

`lib/shared.js` 的文件头必须写清边界（这是它唯一可能变成垃圾抽屉的地方）：
**只收「无状态、无依赖、单行实现、被三处以上引用」的纯函数；第二个条件不满足就留在原处**。

### 2.2 第 2 组：`tar` + `zip` → `lib/archive.js`（643 行）

`lib/zip.js` 的文件头第一句就是「Why a zip writer lives **beside** the tar one」；
唯一消费者 `lib/transfer.js` 在 `:857` 用一次三元选择（`format === 'tar' ? tarStream(...) : zipStream(...)`）。

| 项 | 事实 |
| --- | --- |
| 相互依赖 | 没有。`tar.js` 零依赖；`zip.js` 只用 `node:zlib` 的 `createDeflateRaw` |
| 外引 | `lib/transfer.js:29`（tar）、`:30`（zip）→ 合成一行 |
| 变异 | `scripts/reverse-verify-archive.mjs`：`lib/tar.js` **4 条**（`:47` 十进制 size、`:54` 十进制 mtime、`:61` 短条目不拒、`:68` 超 100 字节静默截断）+ `:254` 的 `after = ['lib/tar.js', 'lib/tree-filter.js', 'lib/transfer.js', 'lib/client/client.js']` |
| 套件 | `tests/archive-smoke.mjs:36`（从 `tar.js` 取 5 个导出）、`tests/zip-smoke.mjs:30`（从 `zip.js` 取 5 个导出）、`tests/capabilities-report-smoke.mjs` |
| 文档 | `docs/FF/05-module-merges.md`（本文件） |

**这一组有一个必须当场处理的陷阱**：`tests/capabilities-report-smoke.mjs:123-124`

```js
const sources = modulePaths(libDir)
  .filter(name => !/^(?:capabilities|tar)\.js$/u.test(name))
```

排除 `tar.js` 的理由写在 `:114-117`：它**自己写**归档格式，所以「源码里出现 `tar`」
不等于「插件在跑 `tar` 命令」。合并成 `archive.js` 之后排除名必须同步改成 `archive`
（即 `!/^(?:capabilities|archive)\.js$/u`），否则 `:165` 那条
`unprobed tool 'tar' is never invoked in lib/` 会以
`` `path too long for a tar entry (ustar allows 155+100 bytes)` ``（`lib/tar.js:64`）为第一条命中而失败，
错误信息完全指错方向。**本机已实测**：把 `tar.js` 与 `zip.js` 的源码拼成 `archive.js`
放进递归模块表后跑同一段判定，`tar` 判为「被调用」，`rsync` / `tput` 仍是「未调用」——
即失败点唯一，指的就是这一组。

同一段扫描现在用 `modulePaths()`（`tests/support/lib-modules.mjs`）**递归**遍历 `lib/`，
所以 `lib/client/` 与 `lib/routes/` 也在扫描范围内；这也意味着 `archive.js` 必须继续被排除，
否则它会以「源码里出现了 tar」的形式污染整个判定。

`tests/run.mjs` 里的套件名（`'archive'`、`'zip'`）**不改**——套件名与文件名是两件事。

### 2.3 第 3 组：`ssh-config` + `match-eval` → `lib/ssh-config.js`（337 行）

两者解析同一个 `Match` 行：前者把配置切成 `Host` / `Match` 段，后者把条件求值。
拆开之后它们互相 import，就是 §1 里那条唯一的功能环——**合并顺手消环**。

| 项 | 事实 |
| --- | --- |
| 要删的内部边 | `lib/ssh-config.js:46` → `match-eval.js`；`lib/match-eval.js:40` → `ssh-config.js` |
| 外引 | `lib/config-audit.js:51`、`lib/hosts.js:20`——**不用改**，它们本来就从 `ssh-config.js` 取 |
| 套件 | `tests/match-eval-smoke.mjs:18`（`match-eval.js`）+ `:19`（`ssh-config.js`）→ 前一处改路径；`tests/ssh-config-smoke.mjs:32`、`tests/include-chain-smoke.mjs:20` 不动 |
| 变异 | `scripts/reverse-verify-config-subset.mjs:64/71/78`（`match-eval.js` 3 条）+ `:85`（`ssh-config.js` 1 条） |
| 文档 | `docs/hosts.md:58`（「`lib/match-eval.js` 的 `matchSelects`」）、`docs/optimization-and-future03.md:51`（**行号级**引用 `lib/match-eval.js:84`，合并后要重算） |

### 2.4 第 4 组：状态面的四个文件 → `lib/status.js`（678 行）

`status-schema`（工具输出的形状）+ `status-render`（把状态渲染成给人看的文本）+
`status-provenance`（每个字段的来源记账）+ `tool-result`（19 行的结果信封）。
四者合成「status 这一张脸」。

| 项 | 事实 |
| --- | --- |
| 内部边 | `lib/status-render.js:16` → `tool-result.js` |
| 外引（5 条 / 3 文件） | `lib/tools.js:27`（schema）、`:28`（render）、`:29`（text）；`lib/routes/routes.js:33`（provenance）；`lib/routes/workspaces.js:16`（provenance） |
| 套件 | `tests/workspace-ownership-smoke.mjs:749/804/836`（`status-schema.js`）、`tests/diagnostics-smoke.mjs:217/287`（`status-render.js`）、`tests/status-provenance-smoke.mjs:17` |
| 变异 | `scripts/reverse-verify-status-provenance.mjs:17/24/31/38/45`（5 条） |
| 文档 | 无（`docs/` 里没有引用这四个文件名的地方） |

**必须保住的两条源码断言**：`tests/diagnostics-smoke.mjs:217` 读 `status-render.js` 的源码断言
`/OBSOLETE/u`、`:287` 断言 `/SEAM NOT INSTALLED/u`。合并后这两句要仍留在 `status.js` 里，
且该套件的读取路径改成 `lib/status.js`。

### 2.5 第 5 组：`reconnect` + `watch-recovery` → `lib/reconnect.js`（434 行）

两者回答同一个问题：**连接掉线之后怎么办**——`reconnect` 是重连调度，
`watch-recovery` 是「监视降级成轮询之后怎么恢复」。

| 项 | 事实 |
| --- | --- |
| 外引 | `lib/engine.js:26`（`ReconnectScheduler`）、`lib/remote-watch.js:32`（`watchFailureVerdict` / `watchRecoveryDelay`） |
| **导出重名** | `positive`：`lib/reconnect.js:51` 与 `lib/watch-recovery.js:54` **各自 re-export 一次**，且都是死代码（§1.2）→ 合并后只留一个 `import { positive } from './shared.js'`，两条 re-export 都删 |
| 套件 | `tests/reconnect-smoke.mjs:34/415`、`tests/watch-recovery-smoke.mjs:49` |
| 变异 | `scripts/reverse-verify-watch-recovery.mjs:22/28/34/40`（4 条） |
| 文档 | `docs/architecture.md`、`docs/development.md`、`docs/optimization-and-future03.md` |

### 2.6 第 6 组：`store` + `secrets` → `lib/store.js`（1,330 行）

`secrets.js` 是 store 里一类记录（密钥）的加解密视图，`store.js:28` 是它唯一的消费者。

| 项 | 事实 |
| --- | --- |
| 外引 | `lib/hosts.js:16`（唯一的静态 `import`）；另有 `lib/forward-persist.js:72` 与 `lib/passthrough-settings.js:41` 是 JSDoc `import('./store.js').HostConfigStore` 类型引用 |
| 套件（13 个 / 17 处） | `detach:51`、`fake-transport:82`、`forward-persist:32`、`jump-transport:65`、`local-passthrough:47`、`recent-hosts:18`、`reverse-forward:75`、`routes:1102/1271/1476/1855`、`secrets:16` + `:18`（`secrets.js`）、`store-lock:18/76/101`、`transfer-retry:36`、`transport:53`、`watch-sharing:262` |
| 变异 | `scripts/reverse-verify-recent-hosts.mjs:18/30/36/48`（`store.js` 4 条）+ `scripts/reverse-verify-passthrough.mjs:259`（1 条） |
| 文档 | `docs/development.md` |

这一组外部**静态** import 只有 1 条（`hosts.js:16`；另外两处是 JSDoc 类型引用），但**套件按路径引用最多**（13 个），
因为它是几乎所有套件造测试状态的地方。改法是机械的：`'lib/store.js'` 一律不动，
只把引用 `secrets.js` 的 `tests/secrets-smoke.mjs:18` 改成 `store.js`。

### 2.7 第 7 组：`passthrough` + `passthrough-settings` → `lib/passthrough.js`（1,070 行）

直通策略与它的持久化设置，一个判「这条路径怎么处理」、一个存「用户把哪些扩展名放行」。

| 项 | 事实 |
| --- | --- |
| 内部边 | `lib/passthrough-settings.js:23` → `passthrough.js` |
| 外引 | `lib/index.js:27` + `:28`（两条并一条）、`lib/routes/routes.js:32`、`lib/routes/workspaces.js:20` |
| 套件 | `tests/local-passthrough-smoke.mjs:46` + `:48`（后者是 settings） |
| **变异最密的一组** | `scripts/reverse-verify-passthrough.mjs`：`passthrough.js` **17 条**（`:38`–`:92`）+ `passthrough-settings.js` **2 条**（`:251`、`:297`），另有完整性清单 `:158/166/173/270/276/285/291` |
| 文档 | `docs/architecture.md`、`docs/development.md`、`docs/features.md`、`docs/optimization-and-future03.md`、`docs/protocol.md`、`CHANGELOG.md` |

19 条变异全部靠 `file:` 字段定位，改文件名时**每一条都要改**，改完必须重跑该脚本确认
「红→恢复→绿」。这是本方案里唯一一处「漏一条就静默失效」的地方。

### 2.8 第 8 组：传输侧的五个纯判定 → `lib/transfer-rules.js`（731 行）

`verify`（哈希校验）+ `resume`（续传判定）+ `conflict-policy`（冲突怎么算）+ `tree-filter`（排除规则）
+ `mutations`（变更集）。共同点很硬：**五个都不碰 sftp、不碰 engine，全是纯函数**，
消费者只有 `lib/routes/routes.js`、`lib/transfer.js` 与 `lib/routes/` 的 4 个文件。

| 项 | 事实 |
| --- | --- |
| 外引（13 条 / 4 文件） | `lib/routes/routes.js:54`(conflict)/`:55`(resume)/`:56`(verify)/`:65`(mutations)；`lib/transfer.js:27`/`:28`/`:31`/`:32` + `:509`（JSDoc `@link import('./tree-filter.js')` 类型引用）；`lib/routes/transfer-bytes.js:16`(mutations)/`:17`(verify)/`:18`(conflict)/`:19`(resume)；`lib/routes/entries.js:19`(mutations) |
| 套件（7 个） | `verify-smoke:16`、`resume-smoke:20`、`transfer-smoke:494/539/595`、`conflict-policy-smoke:18`、`archive-smoke:37`（`tree-filter.js`）、`mutations-smoke:21`、`capabilities-report-smoke:83`（注释里提到 `lib/verify.js`） |
| 变异（16 条 / 3 脚本） | `reverse-verify-transfer-integrity`（`verify` 4 + `conflict-policy` 4）、`reverse-verify-resume`（5）、`reverse-verify-archive`（`tree-filter` 3 + `:254` 清单） |
| 文档 | `docs/features.md`（`tree-filter.js`）、`docs/optimization-and-future03.md`（`resume.js`） |

`lib/transfer.js:509` 是**注释里的 JSDoc 类型引用**（`{@link import('./tree-filter.js').treeFilter}`），
`grep '^import'` 抓不到它，`git grep` 的默认大小写也照不到——改路径时最容易漏的一条。
真正的动态 import 在 `lib/transfer.js:31` 那条静态 `import` 之外不存在：`tree-filter` 只有这一个 import 站点。

### 2.9 第 9 组：`hosts` + `include-chain` + `jump-chain` → `lib/hosts.js`（1,099 行）

三段连成一条解析链：**include 展开 → `Host` 段匹配 → Jump 主机链**。
三者都是「从 `~/.ssh/config` 读出主机」，消费者几乎只有彼此。

| 项 | 事实 |
| --- | --- |
| 内部边 | `lib/hosts.js:18` → `jump-chain.js`、`:19` → `include-chain.js`、`:20` → `ssh-config.js` |
| 外引 | `lib/engine.js:24`（`HostStore`）、`lib/engine.js:21`（`checkJumpChain`） |
| 套件（14 个） | `config-audit:33`、`fake-transport:83`、`host-listing:25`、`jump-transport:66`、`live:66`、`local-changes-remote:860`、`recent-hosts:19`、`reverse-forward:76`、`secrets:17`、`ssh-config:33`、`transfer-retry:37`、`watch-sharing:263`、`include-chain:19`、`jump-chain:16` |
| 变异（16 条 / 3 脚本） | `reverse-verify-jump-chain`（`jump-chain` 6 + `hosts` 2）、`reverse-verify-config-subset`（`include-chain` 6）、`reverse-verify-recent-hosts`（`hosts` 2） |
| 文档 | `docs/development.md`、`docs/hosts.md`、`docs/optimization-and-future03.md` |

### 2.10 第 10 组：报告面三个文件 → `lib/report.js`（984 行）

组装（`support-bundle`）→ 判断（`diagnosis`）→ 配置审计（`config-audit`）。
三者合成「这一份报告怎么拼出来、怎么下判断、怎么读用户的 ssh config」。

| 项 | 事实 |
| --- | --- |
| 内部边 | `support-bundle.js:51` → `config-audit.js`、`:52` → `diagnosis.js`；`diagnosis.js:69` → `capabilities.js`（留在组外） |
| 外引（7 条 / 4 文件） | `lib/routes/routes.js:58/59`、`lib/tools.js:16/17`、`lib/routes/workspaces.js:18/19`、`lib/hosts.js:17`（另有 `hosts.js:522` 是 JSDoc `import('./config-audit.js')` 类型引用）。`capabilities.js` 留在组外，所以它那三条不是本组的外引 |
| **导出重名** | `summarizeAudit`：`config-audit.js:273` 定义、`support-bundle.js:368` re-export（零外部引用）→ 合并后只留定义，删 re-export |
| 套件（7 个） | `diagnosis-smoke:5/6/29/32`、`diagnostics-smoke:246/289`、`redact-smoke:33`、`support-bundle-smoke:35`、`config-audit-smoke:32`、`ssh-config-smoke:34`、`workspace-ownership-smoke:38`（`capabilities-report-smoke:38` 读的是留在组外的 `capabilities.js`，不算本组） |
| 变异（4 条 / 1 脚本） | `scripts/reverse-verify-future.mjs`：`config-audit` 3（`:75/84/93`）、`support-bundle` 1（`:140`）。同脚本里 `capabilities` 那 2 条（`:38/47`）**不在本组**——`capabilities.js` 留在组外，它的 `file:` 字段不用动 |

**为什么 `capabilities.js` 留在组外**（本方案里唯一一处「看着该合、实际不能合」）：

`tests/capabilities-report-smoke.mjs` 的两次源码扫描都**精确排除**拥有词汇表的那一个文件
（`:124` 的 `!/^(?:capabilities|tar)\.js$/u`）。把 `capabilities.js` 并进 `report.js` 之后只有两条路：

- 把排除名改成 `report.js`——**等于把 984 行的报告面从两次扫描里整体摘出去**，检查被削弱到没有意义；
- 改写扫描——那是在改测试的语义，超出「移动不改语义」的范围。

而且实测确认它会红：`capabilities.js:138` 的 `why: '… never from tput'` 是一个**包含** `tput`
的长字符串（不是恰好等于 `'tput'` 的字面量），扫描器只剥「恰好是工具名」的字符串，
所以合并后 `tput` 会被判成「被调用」。**已用合并后的源码跑过同一段判定**：把排除名从 `capabilities.js` 换成 `report.js` 后，`tput` 与 `tar` **两条**都判成「被调用」，断言必红——`tput` 来自 `capabilities.js:138` 那句 `why`，`tar` 来自同一张表的 `:136`（`no code path shells out to tar`）。

### 2.11 第 11 组：端口转发四件套 → `lib/forward.js`（1,182 行）

正向（本地 listener → `forwardOut`）、反向（远端 listener → 本地服务）、
持久化（意图 `enabled` 与事实 `live` 分离）、以及三者共用的校验器 `forward-common`。
FF-04 时代这条被写成「不做」，理由是生命周期不同；本轮重算后**可以合**——
`forward-common` 已经是它们的公共底座，分开只会让「端口校验规则」与「端口怎么接」各占一个文件。

| 项 | 事实 |
| --- | --- |
| 内部边 | `forward.js:17` 与 `reverse-forward.js:34` → `forward-common.js`；`forward-persist.js:23` → `forward.js` |
| 外引（5 条 / 3 文件） | `lib/index.js:29/30/31`、`lib/routes/routes.js:52`、`lib/routes/forwards.js:14`（另有 `lib/routes/routes.js:290/291/292` 与 `lib/tools.js:278/1567` 是 JSDoc `import('./…')` 类型引用，改路径后要一起改） |
| 套件（6 个） | `forward-smoke:26`、`forward-persist-smoke:31/32/33`、`routes-smoke:1098/1099/1477/1614`、`reverse-forward-smoke:47/78`、`diagnostics-smoke:159`（源码扫描名单里含 `forward.js`）、`reconnect-smoke:425` |
| 变异 | `scripts/reverse-verify-reverse-forward.mjs:20/26/32/38/44/50`（6 条） |
| 文档 | `docs/development.md`、`docs/optimization-and-future03.md` |

`tests/diagnostics-smoke.mjs:159` 的 `['engine.js', 'remote-fs.js', 'forward.js', 'ownership.js', 'remote-skills.js']`
是「每个 `KINDS.*` 都必须有真实生产者」的扫描名单。`reverse-forward.js` 现在也在往里记
（`lib/reverse-forward.js:33` 导入 diagnostics），合并后这个名单仍然只需要 `forward.js` 一项——
**少一项比多一项安全**，但要确认 `reverse-forward` 产生的 `KINDS` 也在 `forward.js` 里真的写了。

### 2.12 第 12 组：`shell` + `remote-shells` → `lib/shell.js`（1,010 行）

「命令去哪台机器跑」（`ShellManager`）与「那台机器上有哪些 shell」（`RemoteShellsRouter`）
是同一件事的两端——后者产出的列表就是前者的启动菜单。

| 项 | 事实 |
| --- | --- |
| 外引（3 条 / 2 文件） | `lib/index.js:32`（`ShellManager`）+ `lib/index.js:39`（`installShellDiscovery`）、`lib/patch/patch-terminal.js:74`（另有 `lib/tools.js:279` 与 `patch-terminal.js:153/506` 是 JSDoc `import('./…')` 类型引用） |
| 套件 | `shell-smoke:28`、`tool-results-smoke:59`、`remote-shells-smoke:34` |
| 变异 | `scripts/reverse-verify-shell-cwd.mjs:21/27/33/39/45`（5 条） |
| 文档 | `docs/architecture.md`（含「3. 接管 `ctx.terminalController.shells()`」一节）、`docs/features.md`、`docs/ui.md`、`docs/optimization-and-future03.md`、`CHANGELOG.md` |

**不能顺手把 `shell-quote` / `text` 也拉进来**（这是实测的成环点，见 §3.2）。

### 2.13 第 13 组：`engine` + `audit` → `lib/engine.js`（2,189 行）

`audit.js` 是引擎的命令账本（环形缓冲 + 脱敏），`engine.js:23` 是它唯一的构造点。

| 项 | 事实 |
| --- | --- |
| 外引 | **9 条静态 `import` / 9 个文件**（`fs-shim:54`、`index:25`、`patch-shell:35`、`patch-subprocess:75`、`remote-shells:40`、`remote-watch:30`、`routes:31`、`routes/entries:22`、`verify:36`），另有 **15 个文件**通过 JSDoc `import('./engine.js')` 引用它的类型。目标名沿用 `engine.js`，所以这些一条都不用改 |
| 套件（24 个） | 见 `tests/run.mjs`；`capabilities-report-smoke`、`diagnostics-smoke`、`transport-smoke`、`watch-sharing-smoke` 等都在读它的源码或构造真实引擎 |
| 变异（11 条 / 2 脚本） | `reverse-verify-jump-transport`（5 条，全部在 `engine.js`）、`reverse-verify-future`（`engine` 4 + `audit` 2） |
| 文档 | `docs/architecture.md`、`docs/development.md`、`docs/upstream-workarounds.md` |

这一组的价值不在「省一个文件」，而在**把「命令怎么跑」与「命令跑过什么」放在一起**：
现在读 `audit.js` 的人必须先知道 `engine.js:23` 怎么构造它。

### 2.14 第 14 组：`tools` + `command-policy` → `lib/tools.js`（2,023 行）

`command-policy` 判「这条远端命令要不要人确认」，唯一消费者是 `tools.js:23` 的
`confirmRemoteCommand` / `normalizePolicy`。

| 项 | 事实 |
| --- | --- |
| 外引 | `lib/index.js:45`（只有 1 条，且是 `tools.js`） |
| 套件（15 个） | `audit:222`、`client-shape:715`、`command-policy:232`、`command-confirm:25/171`、`detach:254/299`、`diagnostics:216/286`、`doc-numbers:33`、`host-listing:338`、`mode-gate:56`、`routes:992`、`tool-results:54/195`、`tool-schemas:58/129`、`transfer:201/371/392`、`transport:56`、`workspace-ownership:748/834` |
| 变异（9 条 / 2 脚本） | `reverse-verify-command-policy`：`command-policy.js` **6 条**（`:18/24/30/36/42/48`）+ `tools.js` **2 条**（`:54`、`:60`）；`reverse-verify-future.mjs:102` 再来 1 条 `tools.js` |
| 门禁耦合 | `scripts/doc-numbers.mjs:156/167` 读 `lib/tools.js` 源码用 `defineTool({ name: '…'` 数工具数（现 11）；`tests/doc-numbers-smoke.mjs:33` 也读它 |
| 文档 | `docs/architecture.md`、`docs/development.md`、`docs/upstream-workarounds.md` |

**代价注意**：`command-policy` 是「减速带」，`lib/mode-gate.js` 是「围栏」，两者**不合**（§3.1）。
合进 `tools.js` 之后，注释里要明确「确认策略只作用于工具发起的命令，围栏在 mode-gate」。

### 2.15 第 15 组：`patch-projection` + `path-binding` → `lib/patch/patch-projection.js`（709 行）

`path-binding.js` 就是 `patch-projection.js` 的**退役探针**：后者问「上游修好没有」，
前者读上游的注册表来判断「这条补丁还需不需要装」。两者原本就是一对。

| 项 | 事实 |
| --- | --- |
| 内部边 | `lib/patch/patch-projection.js:77` → `path-binding.js` |
| 外引 | `lib/index.js:41`（`installProjectionRelaxation`）、`lib/patch/patch-subprocess.js:76`（`BRIDGE`） |
| 套件（3 个 / 4 处） | `projection-real-smoke:76`（+ `:90/91/127` 是注释与文案）、`projection-relax-smoke:65` + `:455`（`path-binding.js` 的 `BRIDGE`）、`upstream-contract-smoke:97`；`diagnostics-smoke:167` 只是注释提到这个名字，不用改 |
| 变异 | **零** |
| **必须保留文件名** | `lib/upstream-contract.js:50` 的 `file: 'patch/patch-projection.js'`（§9.6 之后带目录）；`tests/upstream-contract-smoke.mjs:56-61` 双向断言「每个 patch 文件都有契约 / 每个契约都对应真实文件」，且 `scripts/doc-numbers.mjs` 按 `lib/patch/patch-*.js` 数补丁数（7 不变） |

### 2.16 第 16 组：`diagnostics` + `redact` → `lib/diagnostics.js`（347 行）

`redact.js` 只服务一件事：**诊断事实在进入环形缓冲或报告之前先脱敏**。
合并后「记什么」与「记之前怎么抹掉敏感信息」在同一个文件里，这是它该有的样子。

| 项 | 事实 |
| --- | --- |
| 内部边 | `lib/diagnostics.js:30` → `redact.js` |
| 外引（12 条 / 11 文件） | `diagnostics`：`engine:22`、`forward:16`、`ownership:39`、`reconnect:37`、`remote-fs:29`、`remote-skills:31`、`remote-watch:31`、`reverse-forward:33`、`support-bundle:49`、`tools:14`；`redact`：`audit:43`、`support-bundle:53` |
| 套件 | `diagnostics-smoke:26`、`reconnect-smoke:37`、`redact-smoke:31/32/33`、`support-bundle-smoke:37`、`tool-results-smoke:57`、`workspace-ownership-smoke:39` |
| 变异 | `scripts/reverse-verify-future.mjs:18/129/149`（`redact.js` 2 条 + 清单） |
| 文档 | `docs/architecture.md`、`docs/development.md`、`docs/tools.md`、`docs/troubleshooting.md`、`docs/upstream-workarounds.md` |

`tests/redact-smoke.mjs` 同时 import 三个模块（`redact` / `diagnostics` / `support-bundle` / `audit`），
合并后它会是「从 `diagnostics.js` 取两样、从 `report.js` 取一样、从 `engine.js` 取一样」——
这个套件的 import 段落要整段重写，而不是只换一个字符串。

## 3. 不做 / 已实测不可行

### 3.1 明确不做

| 不做 | 理由 |
| --- | --- |
| `lib/routes/` 八个文件 | 用户指定「特意拆分」，且 `ROUTES` 常量在 `lib/routes/routes.js:86`、五个子模块反向 `import { ROUTES } from './routes.js'` 造成 5 个环，处理它需要额外一次「把 `ROUTES` 搬进 `routes/kit.js`」——不在本方案范围内 |
| `lib/client/` 13 个文件（1 主包 + 12 chunk）| 用户指定「client.js 相关的」不动；它刚从顶层搬进这个目录（`0c3dc23` 起 7 个提交），两套 client 断言、chunk 文件名正则与 `scripts/client-map.mjs` 都钉在当前形状上（§1 起点提示） |
| 七个 `lib/patch/patch-*.js` 互并 | `lib/upstream-contract.js` 按**文件**登记退役判据，`scripts/doc-numbers.mjs` 按 `lib/patch/patch-*.js` 数补丁数（7）。合并会同时打乱退役信号与门禁数字 |
| `lib/index.js` | `tests/upstream-contract-smoke.mjs:112-134` 用 `indexOf('installRemote…')` 钉安装顺序，而 `installRemoteShell` 会先命中 `lib/index.js:38` 的 import 行；动这个文件等于动那条顺序断言 |
| `diagnostics` 与 `diagnosis` 互并 | 名字像、职责相反：前者只记事实（环形缓冲、`KINDS`），后者只下判断（`STATE`、`diagnose()`）。前者被 10 个模块引用、后者 3 个，合并会把判断逻辑拖进引擎/转发/重连全链路。本方案里它们分属第 16 组与第 10 组，各合各的 |
| `mode-gate` 与 `command-policy` 互并 | 一个是**围栏**（判错等于越权写远端），一个是**减速带**（`rm -rf` 前要确认）。`mode-gate` 被 5 个模块引用（含 3 个 `patch-*`），合并会让补丁模块平白依赖确认策略 |
| `remote-fs` / `transfer` / `fs-shim` / `remote-watch` / `remote-skills` / `ownership` / `git-history` / `tool-schema` / `peers` / `upstream-contract` / `protocol` | 各自承担一条完整链路（`remote-fs` 5 个入边、`transfer` 只被 routes 用但 1,016 行自成体系、`fs-shim` 是替代实现、`protocol` 17 个入边）。没有「同族第二个文件」可合 |
| 同名不同语义的三对 | `typeOf`（`remote-fs.js` vs `tool-schema.js`）、`CHUNK_BYTES`（`remote-fs.js` vs `transfer.js`）、`onAbort`（`patch-shell.js:296` 调 `kill()`，`patch-subprocess.js:1144` 调 `requestTermination(true)`） |

### 3.2 已实测会成新环的组合（别再试）

用「把成员并成单一节点后重算 83 个模块的 import 图、与基线 6 环做差」逐条跑过：

| 组合 | 产生的环 |
| --- | --- |
| `shell` + `remote-shells` + `shell-quote` + `text` | `shell.js → engine.js → hosts.js → include-chain.js → shell.js`（另有 `ssh-config.js → shell.js → engine.js → hosts.js → ssh-config.js`） |
| `engine` + `audit` + `diagnostics` + `redact` | `engine.js → reconnect.js → engine.js` |
| `hosts` + `include-chain` + `jump-chain` + `ssh-config` + `match-eval` | `config-audit.js → hosts.js → config-audit.js` |
| `fs-shim` + `patch-projection` + `path-binding` | `fs-shim.js → patch-subprocess.js → fs-shim.js` |
| `remote-watch` + `reconnect` + `watch-recovery` | `engine.js → remote-watch.js → engine.js` |

## 4. 提交计划

分四波，每波结束时仓库可用、可回滚。同一波内的组互不依赖。

| 波 | 组 | 为什么放这一波 |
| --- | --- | --- |
| 1 | 1（`shared`）、15（`patch-projection`）、16（`diagnostics`） | 变异 0 / 0 / 2 条，外引少，先把「改 import + 改套件路径 + 重生成门禁」这套流程跑通 |
| 2 | 3（`ssh-config`）、5（`reconnect`）、2（`archive`） | 第 3 组消掉唯一的功能环；第 2 组要同时改 `capabilities-report-smoke` 的排除名（不改必红） |
| 3 | 4（`status`）、8（`transfer-rules`）、11（`forward`）、6（`store`）、7（`passthrough`） | 多文件组，变异集中（8 号 16 条、7 号 19 条），需要专注跑 `reverse-verify-*` |
| 4 | 9（`hosts`）、10（`report`）、12（`shell`）、14（`tools`）、13（`engine`） | 枢纽组：外引 2–9 条、套件引用 8–24 个，最后做，前面的组已经把它们的内部边改干净 |

建议的提交粒度：**一组一个提交**，提交信息形如
`refactor(archive): merge the tar and zip writers`，提交体写清三件事——
删了哪个文件、改了哪几处文件名引用、跑了哪些脚本。26 个文件的删除分散在 16 个提交里，
任何一步出问题都只需要 revert 一个提交。

实际执行**完全按这个顺序**，波次没有调整（逐组的提交号与文件数见 §9.1）。
唯一一处与计划的偏差：第 10 组 `report` 里 `capabilities.js` 留在组外这个决定，
计划时是用「合并后扫描器会误判」推出来的，落地时又实测确认了一遍（§2.10）。

每批收尾固定四条命令（缺一条就不算做完）：

```bash
node scripts/lint.mjs
node tests/run.mjs                                   # 或逐套件直跑，见 §5
node scripts/doc-numbers.mjs --assertions <实测值>
node scripts/check-doc-links.mjs
```

## 5. 决策记录

| 决策 | 依据 |
| --- | --- |
| 目标名优先沿用「被外部引用最多的成员」 | 外引站点是合并的主要成本。`engine` 9 条静态 import 加 15 个文件的 JSDoc 类型引用、`hosts` 只有 2 条但 14 个套件、`store` 只有 1 条但 13 个套件——沿用原名能把改动压到「删成员 + 改内部 import」 |
| 没有枢纽才起新名，且必须是功能名 | `shared` / `archive` / `status` / `transfer-rules` / `report`。起 `utils.js` 会让下一个人往里丢任何东西 |
| `capabilities.js` 不进第 10 组 | `tests/capabilities-report-smoke.mjs:124` 精确排除「拥有词汇表的那个文件」；并进 984 行的报告面等于把检查削弱到无意义，且实测 `tput` / `tar` 会误判为「被调用」（§2.10） |
| `patch-projection.js` 保留原名 | `lib/upstream-contract.js:50` 的 `file:` 字段 + `scripts/doc-numbers.mjs` 的补丁计数（7）；§9.6 的搬家只改了目录，basename 没动 |
| `hosts` 三件套一起合，而不是只合两件 | include 展开与 Jump 链都以 `Host` 段为输入，只合两件会把第三件留成「既像解析器又像使用者」的中间态 |
| 第 1 组先做 | 它 9 条外引里有 8 条落在本方案其他组的成员里（§2.1）；先做等于把后面 5 个组的内部 import 一次性理顺 |
| 「移动不改语义」 | 本方案只搬文件、改 import 与文件名引用。`git diff` 里除了被移动的代码本体，应该只有 import/export 行、文件头注释、以及被重命名后的路径字符串。任何顺手重构都不属于本方案 |

## 6. 测试决策

这 16 组合并**不新增功能**，所以**不新增套件**，只改既有套件的 import 路径、
脚本的定位名与源码扫描的名单。但有三类必须当场验证，否则等于没做完：

### 6.1 变异仍然咬得住

每一组做完，跑一次钉在它上面的 `scripts/reverse-verify-*.mjs`，确认「红 → 恢复 → 绿」全过：

| 组 | 要跑的脚本 | 条数 |
| --- | --- | --- |
| 2 | `reverse-verify-archive` | `tar` 4（+ `tree-filter` 3 属第 8 组） |
| 3 | `reverse-verify-config-subset` | `match-eval` 3 + `ssh-config` 1 |
| 4 | `reverse-verify-status-provenance` | 5 |
| 5 | `reverse-verify-watch-recovery` | 4 |
| 6 | `reverse-verify-recent-hosts` / `reverse-verify-passthrough` | 4 / 1 |
| 7 | `reverse-verify-passthrough` | 17 + 2 |
| 8 | `reverse-verify-transfer-integrity` / `-resume` / `-archive` | 8 / 5 / 3 |
| 9 | `reverse-verify-jump-chain` / `-config-subset` / `-recent-hosts` | 8 / 6 / 2 |
| 10 | `reverse-verify-future` | `config-audit` 3 + `support-bundle` 1（`capabilities` 2 条不在本组） |
| 11 | `reverse-verify-reverse-forward` | 6 |
| 12 | `reverse-verify-shell-cwd` | 5 |
| 13 | `reverse-verify-jump-transport` / `reverse-verify-future` | 5 / 6 |
| 14 | `reverse-verify-command-policy` | 7 |
| 16 | `reverse-verify-future` | `redact` 2 |

**「脚本说变异没有生效」是本方案最典型的失败**：它不报错、不崩溃，
只是安静地变异了一个不存在的文件。所以每条 `file:` 字段都要人工对一遍。

### 6.2 源码扫描的名单与排除名

这三处是「改名之后断言仍然会跑、只是结论反了」的地方：

| 位置 | 现状 | 合并后 |
| --- | --- | --- |
| `tests/capabilities-report-smoke.mjs` | 递归 `modulePaths(libDir)` + 两条按 basename 的排除（`/(?:^\|\/)capabilities\.js$/`、`/(?:^\|\/)archive\.js$/`），并**先断言这两个文件真的被找到**。合并时曾是 `!/^(?:capabilities\|tar)\.js$/u`，`132fb8e` 把它拆成两条（理由不同：前者拥有被检查的词表，后者自己写归档格式），§9.5 又把它改成 basename 锚定 | 已随 §9.5 收紧，无待办 |
| `tests/diagnostics-smoke.mjs:159` | `['engine.js', 'remote-fs.js', 'forward.js', 'ownership.js', 'remote-skills.js']` | 名单不变（`reverse-forward` 并进 `forward.js` 后仍只列 `forward.js`） |
| `tests/diagnostics-smoke.mjs:160` | 逐文件读源码找 `KINDS.<name>` | 同上 |

另外 `tests/client-shape-smoke.mjs` / `tests/client-chunk-smoke.mjs` 会读 `lib/tools.js`、
`lib/routes/*.js` 与 client chunk——`tools.js` 保留原名，理论上不受影响，
但 `tools.js` 变成 2,023 行之后，若其中某条断言匹配「整个文件里恰好出现几次」就需要复核。

### 6.3 门禁数字

`scripts/doc-numbers.mjs` 从源码生成 `docs/development.md` 的规模表：

| 数字 | 现在 | 全部合并后 | 说明 |
| --- | --- | --- | --- |
| `modules under lib/` | 83 | **57** | 唯一会因合并而变的数字（递归计数，含 `lib/client/` 13 与 `lib/routes/` 8），每合一组都要重跑 |
| `test suites` | 99 | **99** | 不变（套件没增删） |
| `upstream patch modules` | 7 | **7** | 不变（`patch-projection.js` 保留原名；§9.6 搬家只改目录，生成表的来源列自己跟着变成了 `lib/patch/patch-*.js`） |
| `HTTP routes` | 33 | **33** | 不变 |
| `model-facing tools` | 11 | **11** | 不变 |

`node scripts/doc-numbers.mjs --assertions <N>` 会连带重写「sampled」那行的实测时间戳；
`N` 取自 `node tests/run.mjs` 的收尾行加总（口径见 `docs/development.md` 的统计一节，
注意逐行数 `PASS` 会少算——两者差 87 项）。

`docs/development.md` 的「源码结构」表在写方案时是 **47 行**覆盖 83 个模块（只覆盖一部分，且带子目录路径），
合并完成后是 **44 行**覆盖 57 个模块——被删掉的文件若有对应行，内容并进了目标名那一行而不是删行
（少了 `path-binding` / `secrets` / `match-eval` 三行，多了 `ssh-config` 一行）。

## 7. 不做什么

| 不做 | 理由 |
| --- | --- |
| 顺手重构合并后的实现 | 本方案只搬文件。`git diff` 里应该只有 import/export 行、文件头注释与路径字符串 |
| 新增套件、修改断言语义 | 合并是重构，不改行为。改断言语义就分不清「合并坏了」还是「断言改了」 |
| 为了少一个文件而改动 `lib/index.js` 的安装顺序 | 那条顺序被 `tests/upstream-contract-smoke.mjs:112-134` 钉住 |
| 碰 `lib/routes/` 与 `lib/client/` | 用户指定 |
| 建 GitHub issue | 沿用 FF-04：只落仓库文档 |

## 8. 验收标准

1. `node scripts/lint.mjs` 全绿（模块总数会变，写这时是 218 个文件 parse，含 `scripts/` 与 `tests/`）。
2. `node scripts/doc-numbers.mjs --check` = up to date，且表里 `modules under lib/` 等于
   `git ls-tree -r HEAD lib/ --name-only | grep -c '^lib/[^/]*\.js$'`。
3. `node scripts/check-doc-links.mjs` 全绿（合并改了文档里的文件路径，链接与行号引用要跟着改）。
4. 每组的 `reverse-verify-*` 全过，且脚本跑完源码字节一致（完整性清单会证明这一点）。
5. `node tests/run.mjs`：合并**不得**让任何套件从 `passed` 变 `partial` / `skipped`。
   受影响套件的断言数与合并前**逐个相同**。
6. 全树 grep 只剩历史记录：
   `git grep -n "lib/tar.js\|lib/zip.js\|lib/match-eval.js\|lib/path-binding.js"` 除
   `CHANGELOG.md` 的历史条目与 `docs/FF/` 本文件外**零命中**。
7. import 图的环从 6 降到 5，且剩下 5 个全部是 `lib/routes/routes.js ↔ lib/routes/*.js`。

## 9. 实施记录

### 9.1 16 组 16 个提交（全部完成）

一组一个提交，任何一步出问题只回滚一个提交。顺序即实际执行顺序（四波）。

| # | 组 | 提交 | 文件数 | 合并后 | 该组的实测标记 |
| --- | --- | --- | --- | --- | --- |
| 1 | `shared` | `2c43d33` | 14 | `lib/shared.js` 96 行 | 9 条外引一次改完，后面 5 个组直接受益 |
| 15 | `patch-projection` | `50f3b56` | 9 | 688 行 | 新增 `scripts/graph-cycles.mjs`，环数不变 |
| 16 | `diagnostics` | `d11725d` | 9 | 281 行 | `reverse-verify-future` 两处 `file:` 改指 |
| 3 | `ssh-config` | `dacb90d` | 7 | 321 行 | 功能环消失，环 6 → 5 |
| 5 | `reconnect` | `e43714f` | 7 | 434 行 | 两个死 re-export 一并删 |
| 2 | `archive` | `132fb8e` | 8 | 626 行 | `capabilities-report-smoke` 的排除名改成「分开处理」 |
| 4 | `status` | `43d102a` | 12 | 670 行 | `lib/tools.js` 三条 import 合成一条 |
| 8 | `transfer-rules` | `a23dd65` | 24 | 657 行 | `lib/transfer.js:508` 的 JSDoc `{@link import()}` 也要改 |
| 11 | `forward` | `7987627` | 15 | 1163 行 | 重复 `KINDS` import 折叠、`randomBytes` 提升 |
| 6 | `store` | `375b448` | 4 | 1335 行 | 两个 `dshHome()` 合成一个 |
| 7 | `passthrough` | `741afde` | 7 | 1070 行 | 只有一处外引 |
| 9 | `hosts` | `a0b053f` | 12 | 1081 行 | `HostConfigStore` import 误删被 `host-listing-smoke` 抓住 |
| 10 | `report` | `c63c31a` | 19 | 889 行 | `capabilities.js` 按 §2.10 留在组外 |
| 12 | `shell` | `5dea723` | 9 | 1000 行 | 同时修掉 `quote` / `shellQuote` 双名 |
| 14 | `tools` | `c72c391` | 6 | 2003 行 | 7 条变异改指 `lib/tools.js` |
| 13 | `engine` | `2897a21` | 9 | 2173 行 | 9 条静态 import 一条没改（目标名不变） |

### 9.2 完工时的实测

| 项 | 值 |
| --- | --- |
| 模块数 | `lib/` **57**（方案起点 83，删 26 个文件、新建 1 个 `lib/shared.js`） |
| 其中顶层 | 36（方案起点 62 + `lib/shared.js`） |
| import 环 | **5**，全部是 `lib/routes/routes.js ↔ lib/routes/<subject>.js`（方案起点 6，含唯一的功能环） |
| 套件 | 99，不变 |
| 断言 | 装配树 5368 / 裸检出 5057（合并本身逐个套件相同；四天后 §9.5 的四处收紧各加了断言，见该节） |
| 门禁 | `lint` 198 模块解析通过；`doc-numbers --check` 绿（modules 57 / suites 99 / routes 33 / tools 11 / patches 7）；`check-doc-links` 24 个 markdown 全过 |
| 位置 | 分支 `refactor/code-splitting`，方案基线 `ac720fa` 之后 17 个提交（含 `9657264` 把 `lib/routes.js` 搬进目录） |

### 9.3 实施中发现的、方案里没预料到的四件事

1. **`lib/routes.js` 先搬进了目录**（`9657264`，用户单独要求的）。这不影响任何一组
   ——`lib/routes/` 本来就在「不碰」清单里——但它改了 `scripts/doc-numbers.mjs` 与
   `tests/support/route-source.mjs` 的读法（整目录排序读，而不是单读组合点）。
2. **`tests/capabilities-report-smoke.mjs` 的排除名不能只换文件名。** 原写法用一条正则
   同时排除 `capabilities.js` 与 `tar.js`，两个排除的理由却不同：前者拥有被检查的词表，
   后者自己写归档格式、错误文案里带 `tar entry`。只把 `tar` 改成 `archive` 会把 626 行
   整块从**两次**扫描里摘掉；正确做法是分开处理（见 `132fb8e` 的提交信息）。
3. **`lib/shell.js` 合并时暴露了 `quote` / `shellQuote` 两个名字并存**。前者是
   `shell.js` 自己的别名、后者是 discovery 那半从 `engine.js` 拿的本名，合并后一个文件里
   两种拼法都出现，直接 `ReferenceError`。统一成 `shellQuote`。
4. **`HostConfigStore` 的 import 在删 import 块时被连带删掉**，`ReferenceError` 只在
   `host-listing-smoke`（真的构造 `HostStore`）里炸，只在做解析的套件里看不出来。
   这类错误正是「受影响套件的断言数与合并前逐个相同」这条验收标准的用处。
5. **「已经递归了」不等于「已经诚实了」**：`countModules()` 在合并期间就改成了递归，
   但同一个脚本里另外两个计数（`countTools` / `countPatches`）仍然是「读不到就是 0」。
   合并本身没踩到，因为没人在合并期间搬顶层文件；一旦真去分文件夹就会踩到。详见 §9.5。

### 9.4 写方案时的起点状态（历史，仅供回溯）

| 项 | 值 |
| --- | --- |
| 分支 | `refactor/code-splitting` |
| 基线提交 | `ac720fa fix(client): publish the icon names as they arrive, not at the end of boot` |
| 已提交的轨道 A | `b6f2e2d`(quote) / `f2f8554`(requirePort) / `75aaaa7`(positive) / `d217f5c`(escapeRegExp) |
| `package.json` 版本 | `0.3.6` |
| 门禁现状 | `lint` 223 文件解析通过；`doc-numbers --check` 绿（表里 modules 83，`recursive listing`）；`suites` 99；`check-doc-links` 24 个 markdown 全过 |

### 9.5 搬家前的四处收紧（在评估「`lib/` 能不能再分文件夹」时发现并修掉）

十六组合并完成后，问题变成「剩下的 36 个顶层文件要不要按能力域分文件夹」。量成本时发现：
**真正贵的不是搬，而是搬完之后有四个检查会静默变松**——它们都不报错，只是把「找不到」
答成 0 或让空集成立，而结果会进文档。四处的形状是同一个：

| 位置 | 原来的形状 | 搬家后会怎样 | 现在 |
| --- | --- | --- | --- |
| `scripts/doc-numbers.mjs` 的 `countTools()` | `countTools(readOrEmpty(path.join(root,'lib','tools.js')))`，`readOrEmpty` 遇 ENOENT 返回 `''` | 工具数变 **0**，并被当作正确结果写进 `docs/development.md` | `readRequired()` 抛错点名文件；新增 `findModule(name)` 按 basename 在递归清单里定位，**0 个或 2 个都抛错** |
| `countPatches()` | `readdirSync(path.join(root,'lib'))`，非递归 | `lib/patch/` 里的补丁数成 **0** | 与 `countModules()` 共用新增的递归 `moduleFiles()`（返回相对路径，两个目录可能同名） |
| `tests/upstream-contract-smoke.mjs:43` | 扁平 `readdirSync(lib)` 找补丁 | `patchFiles` 空集 → 「每个 `patch-*.js` 都有契约」**在空集上成立**（绿灯），而 `missingFiles` 让 7 条契约全 stale，错误信息指向契约表而不是停止查找的那次列目录 | 走递归 `modulePaths()`，**先断言补丁模块确实被找到**，再断言数量与契约表相等 |
| `tests/capabilities-report-smoke.mjs` | `!/^(?:capabilities\|archive)\.js$/u` 这种**顶层锚定** | 排除名失配 → 词表主人被自己的检查扫描，每一行都能自证 | 按 basename 匹配（`/(?:^|\/)capabilities\.js$/`），并**先断言两个被排除的文件真的被找到** |

`routeSources()` 与 `suiteNames()` 也一并从 `readOrEmpty` 换成 `readRequired`：读不到
`tests/run.mjs` 时「0 个套件」与「0 条路由」都不是事实，而它们都会进表。

`tests/doc-numbers-smoke.mjs` 从 26 项加到 42 项，其中新增的 §7 共 16 条断言钉住这些行为
（临时目录造模块树验证递归与相对路径、验证读不到的目录抛错且点名、验证 `findModule` 的两种
失败、验证补丁族按名字被走查找到且生成表的 `source` 列跟着实际位置走、并断言三个真实数字在
收紧之后仍是正数——收紧检查最容易的失败方式是把它变成一条只能红的检查）。
变异验证：把 `moduleFiles()` 的 `catch` 改回 `return []`，§7 立刻红两条。

**结论没变**：即使四处都收紧，全量按能力域分文件夹仍不值得（约 740 处引用点，收益只是
平铺的 36 个名字）；唯一值得的一组仍是 7 个 `patch-*.js` → `lib/patch/`，成本 12 条对外
import + 7 处套件锚点 + **0 条变异锚点** + 30 处文档引用。收紧只是让「搬完之后绿灯」这件事
本身有意义。

### 9.6 七个补丁搬进 `lib/patch/`（§9.5 之后唯一值得的一组）

四处收紧落地后（`c0b0471`），按 §9.5 的结论只搬了这一组：七个 `patch-*.js` 进 `lib/patch/`，
**basename 一个都没改**——`lib/upstream-contract.js` 按文件登记退役判据、`docs/upstream-workarounds.md`
按文件名认人，改名会打乱退役信号，而这里要的只是「补丁族有自己的目录」。

| 项 | 实际改动 |
| --- | --- |
| 移动 | `git mv` 七个文件 → `lib/patch/`，内容除 import 行与 JSDoc 类型路径外**一字未动** |
| 组内 import | 3 条同族引用保持 `./patch-*.js`（`patch-ptc` → `patch-sandbox`、`patch-subprocess` → `patch-projection`、`patch-terminal` → `patch-subprocess`） |
| 对外 import | 8 条：`lib/index.js` 7 条 + `lib/fs-shim.js` 1 条，`./patch-*.js` → `./patch/patch-*.js` |
| JSDoc 类型路径 | 15 条（`import('../engine.js')` 之类）跟着上一层目录走 |
| 契约表 | `lib/upstream-contract.js` 的 7 个 `file:` 改成 `'patch/patch-*.js'`——契约的路径与递归清单同形，否则 `missingFiles()` 会把 7 条全判 stale |
| 套件锚点 | 14 个套件 / 18 处路径；两种拼写都存在（`'lib/patch-x.js'` 与 `'lib', 'patch-x.js'`），脚本两种都覆盖 |
| 变异锚点 | **0 条**（这是这组便宜的根本原因） |
| 文档 | 39 处 `lib/patch-*.js` 路径引用 + 5 处族级拼写 `lib/patch-*.js` → `lib/patch/patch-*.js` |
| 门禁数字 | `modules under lib/` 仍 **57**（搬家不改数量）；`upstream patch modules` 仍 **7**，但生成表的 `source` 列自己变成 `lib/patch/patch-*.js`——§9.5 的 `patchModules()` 让它跟着实际位置走，没有手改 |

**这一步就是 §9.5 的验收**：`doc-numbers --check` 第一次跑出的差异只有 `source` 列那一格
（数字没变、路径变了），`upstream-contract-smoke` 49 项、`capabilities-report-smoke` 60 项
全绿，`graph-cycles` 仍是 5 个环（全部是 `lib/routes/` 那族）。如果没有 §9.5，同样这次搬家会
得到「补丁数 0」「契约全 stale」「排除规则失配」三种**不会指出搬家**的红，以及一个更糟的
情况——契约检查在空集上绿灯通过。

**没有搬别的**：顶层还有 29 个文件（36 − 7），按能力域再分 5–8 个目录约 740 处引用点，
收益只是「平铺的名字少一些」；而每个新目录都要回答「这个文件属于哪个域」，`engine.js`
（2,173 行）同时是连接池、命令通道、审计环与快照，分不清就是分错。结论与 §9.5 相同。

## 相关

- [04-code-splitting.md](./04-code-splitting.md) §2.1（轨道 A 的原始去重清单）、§6（不做什么）
- [../development.md](../development.md#规模)（生成的门禁数字）、套件表
