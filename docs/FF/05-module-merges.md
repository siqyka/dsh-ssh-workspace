# FF-05 同功能模块合并：把「其实是一件事」的几个文件并成一个

> 状态：方案（未实施；2026-11-20 按 `refactor/code-splitting` 分支实测核对）
> 本辑回答：**哪几个 `lib/*.js` 功能相近到该合成一个文件、合并的实际代价是什么、怎么证明没合坏**。
> 不做 GitHub issue（沿用 FF-04 的决定：只落仓库文档）。

## 0. 一句话目标

把 `lib/` 里几组「拆开之后读者要多跳一次、却没有任何独立理由」的模块合并，
**行为、导出名、错误文案、HTTP 状态码、门禁数字口径一律不变**；每合一组都留下
可机械验证的边界（脚本的变异表、套件的 import 路径、源码扫描的排除名），
而不是靠人记住哪两块属于同一个东西。

## 1. 现状（全部为本轮实测）

`lib/` 下 **60 个 `.js`**（`ls lib/*.js | wc -l`，写这行时的值——见 §8 为什么这个数字会变，
别把它当常量引用）。其中四个是轨道 A 新拆出来的：`lib/shell-quote.js` 23 行、
`lib/options.js` 31 行、`lib/forward-common.js` 52 行、`lib/text.js` 25 行。
规模差得极远：`lib/client.js` 12,603 行，而 `lib/shell-quote.js` 只有 23 行。

### 1.1 已经算过、但没做的去重（轨道 A）

`docs/FF/04-code-splitting.md` §2.1 已经扫出 10 组跨模块同名函数，其中 5 组逐字相同。
**本轮核对的现状**：

| 函数 | 位置（合并前） | 状态（HEAD `77ffb00`） |
| --- | --- | --- |
| `quote` / `shellQuote` | `lib/engine.js:1846`、`lib/shell.js:523`、`lib/patch-terminal.js:642` | **已提交** `b6f2e2d`：新建 `lib/shell-quote.js`（23 行），`engine.js` 改 re-export，另两处改 import |
| `requirePort` + `normalizedHost` | `lib/forward.js:28`/`:37`、`lib/reverse-forward.js:45`/`:54` | **已提交** `f2f8554`：新建 `lib/forward-common.js`（52 行），两个文件各 −25 行 |
| `positive` | `lib/reconnect.js:50`、`lib/watch-recovery.js:46` | **已提交** `77ffb00`：新建 `lib/options.js`（31 行）；`engine.js` 的 `tuningOf` 改成 `const tuningOf = positive`，`reconnect.js` 改 `export { positive }`，`watch-recovery.js` 改 re-export |
| `escapeRegExp` | `lib/include-chain.js:146`、`lib/shell.js:311`、`lib/ssh-config.js:174` | 未做，三份函数体逐字相同（`value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')`，只有形参名不同） |

### 1.2 import 图里只有一条环

对 60 个模块的出边做 DFS，**唯一一个环**是：

```
lib/ssh-config.js:46  →  ./match-eval.js
lib/match-eval.js:40  →  ./ssh-config.js
```

（`ssh-config.js` 用 `matchSelects` 求 `Match` 条件；`match-eval.js` 用
`patternMatches` 做 glob。两者解析的是同一件事，互相引用只是拆文件时没切干净。）

### 1.3 被引用次数决定了合并的爆炸半径

| 模块 | 行数 | 被谁 import（`lib/` 内） |
| --- | --- | --- |
| `lib/tar.js` | 178 | `transfer`（仅此一处） |
| `lib/zip.js` | 465 | `transfer`（仅此一处） |
| `lib/match-eval.js` | 162 | `ssh-config`（仅此一处） |
| `lib/ssh-config.js` | 176 | `config-audit`、`hosts`、`match-eval` |
| `lib/tree-filter.js` | 175 | `transfer`（仅此一处） |
| `lib/verify.js` | 161 | `routes`、`transfer` |
| `lib/resume.js` | 171 | `routes`、`transfer` |
| `lib/conflict-policy.js` | 125 | `routes`、`transfer` |
| `lib/reverse-forward.js` | 278（A4 之前 301） | `index`（仅此一处） |
| `lib/forward-persist.js` | 469 | `index`（仅此一处） |
| `lib/forward.js` | 383（A4 之前 406） | `forward-persist`、`index`、`routes` |
| `lib/include-chain.js` | 289 | `hosts`（仅此一处） |
| `lib/jump-chain.js` | 190 | `engine`、`hosts` |
| `lib/config-audit.js` | 284 | `hosts`、`support-bundle` |
| `lib/diagnostics.js` | 228 | **9 个模块**（engine / forward / ownership / reconnect / remote-fs / remote-skills / reverse-forward / support-bundle / tools） |
| `lib/diagnosis.js` | 332 | `routes`、`support-bundle`、`tools` |

## 2. 方案

按「收益 / 代价」从高到低排四组。前三组互不依赖。

### 2.1 组一：`tar.js` + `zip.js` → `lib/archive.js`（推荐先做）

**为什么是同一件事**：`lib/zip.js` 的文件头第一句就是
「Why a zip writer lives **beside** the tar one」，两者是同一个决策的两半——
`GET /download-tree` 要交给浏览器一个文件，ZIP 是各桌面系统都能直接打开的形状，
tar 退为兜底（`lib/transfer.js:857`：`format === 'tar' ? tarStream(...) : zipStream(...)`）。

| 项 | 事实 |
| --- | --- |
| 合计行数 | 178 + 465 = **643** |
| 相互依赖 | **没有**。`tar.js` 零依赖；`zip.js` 只用 `node:zlib` 的 `createDeflateRaw` |
| 导出形状 | 同一套：`async function * tarStream(entries)` / `async function * zipStream(entries)`，都按条目产出 `Buffer` |
| 唯一消费者 | `lib/transfer.js:29-30` 两行 import，一次三元选择 |

**三处硬阻力（一处都不能漏）**：

1. **`scripts/reverse-verify-archive.mjs` 的变异表按文件路径定位**。
   `file: 'lib/tar.js'` 出现 4 次（`:47` 十进制 size、`:54` 十进制 mtime、
   `:61` 短条目不拒、`:68` 超 100 字节静默截断）；`:254` 还有一份完整性清单
   `after = ['lib/tar.js', 'lib/tree-filter.js', 'lib/transfer.js', 'lib/client.js']`，
   用来证明变异跑完后源码没被 UTF-8 破坏。合并后这 5 处全部要改成 `lib/archive.js`，
   否则脚本会说「变异没生效」——而真正的原因是文件已经不叫这个名字了。
2. **套件按路径动态 import**：`tests/archive-smoke.mjs:35` 从 `lib/tar.js` 取
   5 个导出，`tests/zip-smoke.mjs:30` 从 `lib/zip.js` 取 6 个。两处改成 `archive.js`。
   `tests/run.mjs` 里的套件名（`'archive'`、`'zip'`，见 `:104-105`）**不改**。
3. **最容易漏的一处**：`tests/capabilities-report-smoke.mjs:118` 的源码扫描是

   ```js
   .filter(name => name.endsWith('.js') && name !== 'capabilities.js' && name !== 'tar.js')
   ```

   排除 `tar.js` 的理由写在注释里：它**自己写**归档格式，因此
   「`tar` 这个词出现在源码里」不等于「插件在调用 `tar` 命令」。
   合并后文件名变了，排除名必须跟着改成 `archive.js`。**这一条已经实测会红**：
   把两份源码拼起来跑同一段判定，第一个命中是
   `` `path too long for a tar entry (ustar allows 155+100 bytes)` ``，
   也就是 `lib/tar.js:64` 那句——能力表会以
   「unprobed tool 'tar' is never invoked」失败，错误信息完全指错方向。

**建议形状**：一个文件、两段 `// ─── tar ───` / `// ─── zip ───` 分隔，
保留两份文件头里「为什么手写」「为什么不引依赖」的论证（它们是这两百多行存在的理由），
导出名不变，`transfer.js` 的 import 合成一行。

### 2.2 组二：`ssh-config.js` + `match-eval.js` → `lib/ssh-config.js`

**为什么是同一件事**：两者解析的是同一个 `Match` 行。
`ssh-config.js` 负责把文件切成 `Host` / `Match` 段（`sectionsOf` / `selects` / `isExact`），
`match-eval.js` 负责把 `Match` 的条件求值（`parseMatchConditions` / `matchSelects`）。
拆开之后它们互相 import，形成 §1.2 那条唯一的环——**合并顺手把环消掉**。

| 项 | 事实 |
| --- | --- |
| 合计行数 | 176 + 162 = **338** |
| 合并后消费者 import 是否要改 | **不用**。`hosts.js:20`、`config-audit.js:64` 都是从 `ssh-config.js` 取，`match-eval` 的导出搬进同一文件后它们看不到差别 |
| 要改的 | `lib/ssh-config.js:46` 删掉那条 import，改成同文件内调用；`lib/match-eval.js:40` 随文件消失 |

**代价**：`tests/match-eval-smoke.mjs:18-19` 从 `lib/match-eval.js` / `lib/ssh-config.js`
两个路径分别取导出，前一处改成 `ssh-config.js`。`tests/include-chain-smoke.mjs:20`
与 `tests/ssh-config-smoke.mjs:32` 本来就指向 `ssh-config.js`，不用动。
套件名 `'match-eval'` / `'ssh-config'`（`tests/run.mjs:66`、`:123`）不变。

**文档要一起改**：`docs/hosts.md:58` 写「`lib/match-eval.js` 的 `matchSelects`」，
`docs/optimization-and-future03.md:51` 写「`lib/match-eval.js:84` 的 `parseMatchConditions`」——
后者是行号级引用，合并后行号会变，得重算。

### 2.3 组三：传输侧的四个纯判定 → `lib/transfer-rules.js`（可选）

`verify.js`(161) + `resume.js`(171) + `conflict-policy.js`(125) + `tree-filter.js`(175)
= **632 行**，共同点很硬：**四个都不碰 sftp、不碰 engine，全是纯函数**，
而且消费者只有两个（`lib/routes.js:64-66`、`lib/transfer.js:27-32`）。

| 退出理由（不建议合并的理由） |
| --- |
| 每个都有自己的专属套件按路径 import：`tests/verify-smoke.mjs:16`、`tests/resume-smoke.mjs:20`、`tests/transfer-smoke.mjs:494/539/595`、`tests/conflict-policy-smoke.mjs:18`、`tests/archive-smoke.mjs:36` |
| `scripts/reverse-verify-archive.mjs` 有 3 条变异钉在 `lib/tree-filter.js`（`:75`/`:82`/`:89`） |
| 四者的「为什么单独一个模块」注释各自讲了不同的危险（续传的暂存名确定性、冲突策略的「skip 是结果不是错误」、排除规则的「两个方向共用一份匹配」），合并后这些论证会被压成一个标题 |

**结论**：收益是「文件数 -3」，代价是 6 处套件路径 + 3 条变异 + 4 段论证。
**除非同时要动传输逻辑，否则不划算**；如果要做，先做组一、组二。

### 2.4 组四：端口转发三件套（不做）

`forward.js`(383) + `reverse-forward.js`(278) + `forward-persist.js`(469) = **1,130 行**
（A4 之前是 406 + 301 + 469 = 1,176；抽走 `requirePort` / `normalizedHost` 共省下 46 行，
多出的 52 行落在 `lib/forward-common.js`）。
表面上「都是把端口接起来」，但三者的生命周期不同：正向是本地 listener → `forwardOut`，
反向是远端 listener → 本地服务，持久化是「意图（`enabled`）与事实（`live`）分离」的存储层。
而且 `requirePort` / `normalizedHost` 的重复用 §2.5 的办法就能消掉，不需要合并文件。

不做，理由同 FF-04 的「不做什么」：`forward-persist` 被 `tests/reconnect-smoke.mjs:424`
按源码断言，`forward.js` 在 `tests/diagnostics-smoke.mjs:159` 的源码扫描名单里，
合并会让「意图与事实分离」这条设计变得不可见，而它正是这个文件的全部价值。

### 2.5 顺手做：把 4 组重复函数收进共享模块

比合文件便宜得多，且是合文件的前置条件（合并后如果还有三份 `escapeRegExp`，只是换了个地方重复）。

| 函数 | 去处 | 要改的 import |
| --- | --- | --- |
| `escapeRegExp` | 新建 `lib/text.js` | `include-chain.js`、`shell.js`、`ssh-config.js` 三处删本地函数、加 import |
| `positive` | 新建 `lib/options.js` | `reconnect.js`、`watch-recovery.js` |
| `requirePort` + `normalizedHost` | **已完成**：`lib/forward-common.js` | `forward.js`、`reverse-forward.js` |
| `quote` / `shellQuote` | **已完成**：`lib/shell-quote.js` | `engine.js`（re-export）、`shell.js`、`patch-terminal.js` |

`quote` 这一组的做法值得沿用：**实现搬到新模块，被广泛引用的旧位置改 re-export**。
`lib/engine.js:1846` 的 `shellQuote` 有 6 个模块在 import
（`fs-shim`、`patch-shell`、`patch-subprocess`、`remote-fs`、`remote-shells`、`routes`、`verify`），
re-export 让这 6 行一行都不用动；同时 `shell.js`（原本只依赖 `node:string_decoder`）
不必为了一个引号函数去拉起 engine 的整条依赖链（连接池、诊断环、peer 加载器）。

## 3. 提交计划（每步结束时仓库可用）

| # | 提交 | 内容 | 结束时应绿的门 |
| --- | --- | --- | --- |
| A1 | `refactor(shell-quote): one home for the POSIX quoting rule` | **已提交** `b6f2e2d` | `lint`、`run.mjs` |
| A2 | `refactor(text): one escapeRegExp` | **已提交** `d217f5c`（新建 `lib/text.js` 25 行） | `lint`、`include-chain-smoke`、`ssh-config-smoke` |
| A3 | `refactor(options): one positive()` | **已提交** `75aaaa7`（新建 `lib/options.js` 31 行） | `lint`、`reconnect-smoke`、`watch-recovery-smoke` |
| A4 | `refactor(forward): one requirePort / normalizedHost` | **已提交** `f2f8554` | `lint`、`forward-smoke`、`reverse-forward-smoke` |
| M1 | `refactor(archive): merge the tar and zip writers` | 组一（含 3 处脚本/测试同步） | `archive-smoke`、`zip-smoke`、`capabilities-report-smoke`、`reverse-verify-archive` |
| M2 | `refactor(ssh-config): fold match-eval into the config parser` | 组二（消环） | `ssh-config-smoke`、`match-eval-smoke`、`include-chain-smoke`、`host-listing-smoke`（套件名是 `'host-listing'`，`tests/run.mjs:65`；没有 `hosts-smoke` 这个套件） |
| M3 | `docs: the module count moved` | `doc-numbers` 重生成 + 源码结构表 | `doc-numbers-smoke`、`check-doc-links` |

A1–A4 各自可独立回滚；M1、M2 也互不依赖，但**都要过 M3 的门**。

## 4. 决策记录

| 决策 | 依据 |
| --- | --- |
| 先合并 `tar`/`zip`，不先动传输四件套 | 前者消费者只有 1 处、762→643 行同族代码；后者要改 6 处套件 + 3 条变异，而收益只是文件数 |
| `match-eval` 并进 `ssh-config`，不反过来 | `ssh-config` 的消费者有 3 个（含 `hosts`），`match-eval` 只有 1 个（就是 `ssh-config` 自己）；反向合并会逼 `hosts` 改 import |
| 环必须由合并消除，而不是靠「先取后 import」 | ES 模块的循环引用在真机上能跑，但任何一方改为顶层求值（例如把 `patternMatches` 的调用提前到模块初始化）就会 `undefined is not a function`；这个仓库的 `escapeRegExp` 与静态表都在模块顶层 |
| 不合并 `diagnostics.js` 与 `diagnosis.js` | 名字像、职责相反。前者只记录事实（环形缓冲、容量 40、`KINDS`），后者只下判断（`STATE`、`diagnose()`、`renderDiagnosis()`）；`lib/support-bundle.js` 的文件头明确写着「assembles and never judges」这条分工。且 `diagnostics` 被 9 个模块引用，`diagnosis` 只 3 个——合成一个会把判断逻辑拖进引擎、转发、重连全链路 |
| 不合并 `mode-gate.js` 与 `command-policy.js` | 一个是**围栏**（沙箱模式；判错等于越权写远端），一个是**减速带**（`rm -rf` 前要确认）。`mode-gate` 被 5 个模块引用（含三个 `patch-*`），`command-policy` 只被 `tools` 引用；合并会让补丁模块平白依赖确认策略 |
| 七个 `lib/patch-*.js` 一律不参与合并 | `lib/upstream-contract.js` 按**文件**登记每个补丁的退役判据，`scripts/doc-numbers.mjs` 也按 `lib/patch-*.js` 统计补丁数（现 7）。移动会同时打乱退役信号与门禁数字 |
| 同名但语义不同的三对不合 | `typeOf`（`remote-fs.js` vs `tool-schema.js`）、`CHUNK_BYTES`（`remote-fs.js` vs `transfer.js`）、`onAbort`（`patch-shell.js:296` 调 `kill()`，`patch-subprocess.js:1144` 调 `requestTermination(true)`） |

## 5. 测试决策

这四组合并**不新增功能**，所以不新增套件，只改既有套件的 import 路径与脚本的定位名。
但有两处必须当场验证，否则等于没做完：

1. **变异仍然咬得住**。M1 之后必须跑一次
   `node scripts/reverse-verify-archive.mjs`，确认 19 条变异全部「红→恢复→绿」
   （分布：`lib/tar.js` 4 条、`lib/tree-filter.js` 3 条、`lib/transfer.js` 4 条、
   `lib/client.js` 9 条）；
   M2 之后至少手工验证 `match-eval-smoke` 里的三态断言（`host` / `originalhost` / `all`）
   仍能区分——把 `parseMatchConditions` 改成永远返回空数组，该套件必须变红。
2. **能力表那条排除名真的生效**。M1 之后跑
   `node tests/capabilities-report-smoke.mjs`：如果排除名没改对，会以
   「unprobed tool 'tar' is never invoked」失败（§2.1 第 3 点，已实测）。

**合并前后必须一致的四个数字**（`scripts/doc-numbers.mjs` 从源码生成）：

| 数字 | 现在 | 说明 |
| --- | --- | --- |
| `modules under lib/` | 写这行时 **60** | 每合一组减 1（`tar`+`zip` 减 1、`match-eval` 减 1）；这是唯一会因合并而变的数字，重跑 `doc-numbers.mjs` 就会重算 |
| `upstream patch modules` | 7 | **合并不得改变**（不许动 `patch-*.js`） |
| `HTTP routes` | 33 | 不得改变 |
| `model-facing tools` | 11 | 不得改变 |

合并后重跑 `node scripts/doc-numbers.mjs --assertions <实测值>`，它会重写
`docs/development.md` 的生成表；**散文里的口径也要一起改**——`docs/README.md:5`
的「冒烟套件 98 个」不受影响（套件数没变），但 `docs/development.md` 的「源码结构」表
少了行的话，那张表本身就在撒谎（它现在只覆盖 35 个模块，本来就不全，合并后更不能更少）。

## 6. 不做什么

| 不做 | 理由 |
| --- | --- |
| 合并 `lib/patch-*.js` | 上游契约按文件登记退役判据，`doc-numbers` 按 `lib/patch-*.js` 计补丁数 |
| 合并 `diagnostics` / `diagnosis`、`mode-gate` / `command-policy` | 见 §4 决策表 |
| 把 `support-bundle` 并进 `diagnosis` | 同属「报告」，但后者 import 前者；合成 700 行只会让「谁在判断」更难看见 |
| 顺手重构合并后的实现 | 本辑只搬文件，不改语义；`git diff` 里应该只有 import 行、导出行与文件头注释 |
| 建 GitHub issue | 沿用 FF-04 的决定：用户选择只落仓库文档 |

## 7. 验收标准

1. `node scripts/lint.mjs` 全绿（模块数从 181 起会变，但不得有解析失败）。
2. `node scripts/doc-numbers.mjs --check` = up to date，且表里 `modules under lib/` 等于实测文件数。
3. `node scripts/check-doc-links.mjs` 全绿（合并若改了文档里的 `lib/*.js` 路径，链接得跟着改）。
4. `node scripts/reverse-verify-archive.mjs` 19/19 变异有效、跑完源码字节一致。
5. `node tests/run.mjs`：合并不会让任何套件从 passed 变 partial/skipped；
   `archive-smoke`、`zip-smoke`、`capabilities-report-smoke`、`ssh-config-smoke`、
   `match-eval-smoke`、`include-chain-smoke` 逐个断言数与合并前**相同**。
6. `grep -rn "lib/tar.js\|lib/zip.js\|lib/match-eval.js" .` 在 M1/M2 之后除
   `CHANGELOG.md` 的历史条目外**零命中**。

## 8. 起点状态（开工前自己核对，不要重新推导）

**轨道 A 正在被逐条实施，所以「现在几个模块」「哪条提交了」都会在你读到之前变。
本节按提交锚点写，不按模块数字写**——开工前跑一次 `git log --oneline` 对一下。

| 步骤 | 状态 |
| --- | --- |
| A1 `quote` → `lib/shell-quote.js` | **已提交** `b6f2e2d refactor: one POSIX quoter for every remote command` |
| A3 `positive` → `lib/options.js` | **已提交** `77ffb00 refactor: one option-number coercion helper`（提交号在不同克隆里可能不同，认标题） |
| A4 `requirePort` + `normalizedHost` → `lib/forward-common.js` | **已提交** `f2f8554 refactor: one port and host validator for both forward directions` |
| A2 `escapeRegExp` → `lib/text.js` | **已提交** `d217f5c refactor: one regex escaper`（`lib/text.js` 25 行；`include-chain.js` / `shell.js` 改 import，`ssh-config.js` 改 re-export） |
| M1 `tar`+`zip` → `lib/archive.js` | 未开工 |
| M2 `match-eval` 并回 `ssh-config` | 未开工 |

- 分支 `refactor/code-splitting`。
- 每次合并/去重后 `scripts/doc-numbers.mjs` 的 `modules under lib/` 会变，
  **必须重跑 `node scripts/doc-numbers.mjs --assertions <实测值>`**，
  否则 `doc-numbers-smoke` 直接红（本辑写到一半时就红过一次）。
- 行尾：`lib/reconnect.js` 是 CRLF，`git diff` 会提示「CRLF will be replaced by LF」。
  **改动必须保持 CRLF**，否则这条提交会顺带重写整个文件的每一行。
- 本轮实测的门禁状态：`lint` = all 181 modules parse；`doc-numbers --check` = up to date；
  `run.mjs` = 87 passed / 2 partial / 6 skipped / **3 failed**，三条都不属于本辑范围：
  - `doc-numbers-smoke`：`docs/development.md` 没跟着模块数更新（属本辑范围内的机械修复）
  - `audit-smoke`：单跑 58/0 全绿，runner 内 exit 1，属沙箱下 `spawn` 的限制
  - `dirs-listing-smoke`：「empty path resolves the login directory」在 Windows 上取到
    `cwd` 而不是登录目录，是既有的环境依赖失败
  改之前先复跑确认这三条**本来就红**，别把已有的红算到合并头上。

## 相关

- [04-code-splitting.md](./04-code-splitting.md) §2.1（轨道 A 的原始去重清单）、§6（不做什么）
- [../development.md](../development.md#规模)（生成的门禁数字）、套件表
