# FF-01 测试骨架与代码整合

> 状态：方案（未实施）· 2026-11-20 · 任务书见 [01-test-harness-and-code-consolidation-prompt.md](./01-test-harness-and-code-consolidation-prompt.md)
> 这一辑只回答三件事：**现在的测试为什么会在真出问题时仍然绿**、**要补哪三块骨架**、**哪些代码可以合并**。

## 0. 一句话目标

把「91 个套件 / 4882 条断言」这个数字，换成「**任何一条失败都指向真实缺陷**」这个性质：补上缺失的
内存 SFTP 与插件宿主骨架，让现在只能靠 live 主机验证的写入 / 列表 / 传输成功分支在裸检出上也能跑；
消灭 22 处各自手搓的 fake ctx；把 3 条长期基线红与 4 条 partial 变成明确的绿或明确的跳过。

## 1. 现状（数字均取自仓库当前源码）

| 事实 | 出处 |
| --- | --- |
| 91 个套件，按固定顺序各跑一个子进程 | `tests/run.mjs:56` 起的 `SUITES` 数组 |
| 94 个 `tests/*.mjs` 文件 | `tests/` 目录 |
| 4882 条断言（2026-11-18 采样） | `docs/development.md:9-21` 的 doc-numbers 生成区 |
| 共享骨架只有 5 个 | `tests/support/`：`fake-ssh-server.mjs`(447 行)、`peer-mode.mjs`、`run-state.mjs`、`toast-dom.mjs`(271 行)、`tree-dom.mjs`(336 行) |
| 4 个 partial、3 个既有 fail | `npm test` 当前输出 |

`tests/support/fake-ssh-server.mjs` 的头注释自己写清了边界：

> **Not a filesystem.** The SFTP subsystem accepts the channel and answers OPEN/CLOSE/STAT with
> fixed values; it never emulates a directory tree. A test that needs real files belongs in the
> live suite against a real host.

它已经把**连接层**做得很好（direct-tcpip、tcpip-forward、`rejectNext`、`dropAll`、`setHostKey`、
`peerPorts`、`forwardSourcePorts`），缺的是**文件层**。

## 2. 诊断：三个具体的漏

### 2.1 文件层缺失，写入路径只剩 live 验证

`readText` / `writeText` / `editText` / `listDir` / `stat` 是 `lib/patch-fs.js` 接管 `ctx.fs` 的
核心方法（`REMOTE_METHODS` 在 `lib/patch-fs.js:22-38`）。成功分支今天只能在 `DSH_WS_TEST_ALIAS`
指向真主机时跑。后果不是「少测一点」，而是**失败面错位**：写围栏（`writeFenceRoots`
`lib/remote-fs.js:2019`、`assertWithinRemoteRoots` `:2040`、`assertFencedRealpath` `:2082`）
是安全边界，却主要靠 review 而不是靠断言守住。

### 2.2 22 处手搓替身，宿主契约一变就一起漂

自己组装 ctx 的 14 个套件：`batch-target`、`local-changes-remote`、`local-passthrough`、
`mode-gate`、`mutations`、`patch-ptc`、`patch-sandbox`、`phase6`、`remote-git-env`、
`session-catchup`、`terminal`、`tool-results`、`transfer`、`transport`。

自己定义 `fakeEngine` / `fakeCtx` 的 8 个文件（行号为函数定义处）：

| 文件 | 位置 | 形状 |
| --- | --- | --- |
| `tests/archive-smoke.mjs` | :305 | `fakeEngine(tree)` |
| `tests/forward-smoke.mjs` | :43 | `fakeEngine(farSidePort)` |
| `tests/forward-persist-smoke.mjs` | :45 | `fakeEngine(farSidePort)`（与上一条几乎同形） |
| `tests/routes-smoke.mjs` | :164 | `fakeEngine(files, directories)` |
| `tests/shell-smoke.mjs` | :124 | `fakeEngine(channels)` |
| `tests/terminal-smoke.mjs` | :74 | `fakeEngine()` |
| `tests/transfer-smoke.mjs` | :184 | `fakeEngine(sftp)` |
| `tests/patch-ptc-smoke.mjs` | :81 | `fakeCtx(service)` |

同一份宿主契约被 22 处各自理解一次：宿主换了 `ctx.tools.register` 的返回形状、`ctx.fs` 的
`FsVersion` 表示、或 `ctx.effect` 的销毁语义，这 22 处不会同时报错，只会**同时继续绿**。

### 2.3 噪声把绿色信号稀释掉了

- **行尾假红**：没有 `.gitattributes`，`core.autocrlf` 未设，索引 LF / 工作区 CRLF 混用，
  `workspace-ownership-smoke` 在开发工作区稳定失败、在干净 worktree 稳定通过（153 passed / 0 failed）。
  这不是测试问题，是**仓库配置问题**，却每天占用一次「这是已知失败」的解释成本。
- **`DSH_CORE_ROOT` 基线红**：`transfer-retry-smoke` 与 `transport-smoke` 在未设该变量时失败，
  而 `tests/run.mjs:157-161` 的设计意图是「没有真实装配树就生成 stub 根，让套件**运行**而不是跳过」。
  两者行为与设计不一致，属于骨架的 bug，不是环境的错。
- **partial 语义**：`patch-sandbox` / `reverse-forward` / `watch-sharing` / `local-changes-remote`
  四条长期 partial。`tests/support/run-state.mjs:39` 把「N>0 且有 SKIP 行」判为 partial —— 判定是对的，
  但**没有一条断言在盯着「哪一段被跳过了」**，于是 partial 可以无限期停留而不被追问。

## 3. 方案

### 3.1 `tests/support/fake-sftp.mjs`（新，内存文件树）

给 `fake-ssh-server.mjs` 的 SFTP 子系统接一棵内存树，保留它现有的连接层控制。

- 接口：`createFakeSftp({ files, dirs })` 返回 `{ sftp, tree, snapshot() }`；`sftp` 实现
  `open/close/read/write/fstat/stat/lstat/readdir/rename/unlink/rmdir/mkdir/realpath` 中
  本项目实际调用的子集（以 `lib/remote-fs.js` 的调用点为准，先 grep 再定接口，不照抄上游）。
- 必须能表达**错误**：`ENOENT`、`EACCES`、`ENOTDIR`、`ENOSPC`、以及「写一半断线」
  （配合 `dropAll`）。这些是写围栏与重试逻辑的分支来源。
- 必须能表达**版本**：`stat` 返回带 mtime+size 的 `FsVersion`，让 `writeText(expected)` 的
  冲突分支可测。
- 硬约束：**不许**引入新依赖；不许把它做成通用 SFTP 模拟器——只实现本项目会调用的方法，
  未实现的方法显式抛错（比静默返回 `undefined` 好）。

### 3.2 `tests/support/plugin-host.mjs`（新，组装真 ctx）

一个最小但**真的** Cordis 宿主：`ctx.fs`（本地实现，接 `node:fs`）、`ctx.tools`（记录注册表）、
`ctx.shell`、`ctx.subprocess`、`ctx.effect`、`ctx.logger`、`ctx.get`/`ctx.set`，
以及 `apply` 与销毁。

- 目标：让 14 个手搓套件改成 `const host = await createHost({ remote: fakeSftp })` 两行。
- 目标：让 8 个 `fakeEngine` 收敛成 `createHost({ engine: fakeEngine({...}) })` 一个入口，
  各套件只声明自己关心的那部分能力。
- 反面要求：宿主替身**不许**比真宿主宽松。真宿主拒绝的调用（重复 `provide`、已销毁的 fiber、
  非法 schema）在替身里也要拒绝，否则套件测的是替身。

### 3.3 `tests/support/render.mjs`（新，组件渲染）

本项目已有 `toast-dom.mjs`(271) 与 `tree-dom.mjs`(336) 两套自建 DOM，说明这条路已经走通一半。
把它抽成公共的 `render(component, props, { inject })`，让 `client-shape-smoke`（335 项）里
靠**正则切片源码**做的断言逐步换成**渲染后断言**。

- 顺序：先只服务新增测试，不动既有 335 项（那些断言是防回归的，重写要单独一轮）。
- 判据：一个断言如果读的是「源码里有没有这行字」，而行为可以用一次渲染证明，就该迁移。

### 3.4 套件与基线治理（先做，成本最低，收益立刻可见）

1. 新增 `.gitattributes`：`* text=auto eol=lf`，并把已知二进制（`docs/assets/**` 里的 png 等）
   标 `-text`。这一步让 `workspace-ownership-smoke` 在任何工作区都稳定绿。
2. 修 `tests/run.mjs` 的 stub 根逻辑，使 `transfer-retry-smoke` 与 `transport-smoke` 在没有
   `DSH_CORE_ROOT` 时走 stub 而不是失败；若确实无法 stub，改成**显式 SKIP 并说明缺什么**，
   不允许「失败但大家都知道」。
3. 给 partial 加**追踪**：`run-state.mjs` 已能拿到 `skipLines`，在 `run.mjs` 的收尾里把
   每条 SKIP 行按套件名打出来，并给 `docs/development.md` 的套件表加一列「跳过段」。
   partial 从「一种状态」变成「一份待办清单」。
4. 合并重叠套件：先按 `grep -l` 找出引用同一模块的套件组，同组内若前置条件相同就并成一个文件，
   项数相加。**判据是前置条件相同**，不是名字像。

### 3.5 代码整合（在骨架之后做，否则重构没有安全网）

- 三个格式化函数收敛：`lib/client.js` 的 `formatBytes`（:5869）是现在唯一保留的字节格式化器
  （`formatSize` 已在上一次 dirs-only 改动中删除），确认没有第四份。
- `lib/routes.js` 的参数解析：`queryParam`(:508)、`parseLimit`(:558) 已抽取，
  逐路由检查是否还有手写的 `Number(url.searchParams.get(...))`。
- 模块合并候选：`lib/forward.js` + `lib/forward-persist.js` + `lib/reverse-forward.js`
  是否共享同一份「映射表 + 预检 + 生命周期」；`lib/patch-*.js` 七个补丁模块是否共享同一套
  「安装 / 已安装标记 / 卸载」样板。**先 grep 出重复块再决定，不要凭印象合并。**

发现命令（复制即用）：

```bash
# 近重复函数名
grep -rhoE '^\s*(async )?function [a-zA-Z0-9_]+' lib/*.js | sort | uniq -c | sort -rn | head -30
# 手写参数解析
grep -n "searchParams.get" lib/routes.js | grep -v queryParam
# 同一模块被哪些套件引用
grep -ln "remote-fs" tests/*.mjs
```

## 4. 验收标准

| # | 判据 |
| --- | --- |
| 1 | `workspace-ownership-smoke` 在**任意**工作区（LF 或 CRLF 检出）都是 0 failed |
| 2 | `npm test` 的 failed 数为 0；partial 数下降且每条 partial 在 `docs/development.md` 有对应「跳过段」说明 |
| 3 | 至少 6 个原 live-only 场景在裸检出上跑通：写文本、编辑文本、列目录、stat、重命名、上传分块 |
| 4 | 手搓 ctx 的套件数从 14 降到 ≤ 2（剩下的必须写明为什么不能共用） |
| 5 | `fakeEngine` 定义处从 8 降到 ≤ 3，且剩下的都在 `tests/support/` 里 |
| 6 | 断言总数不低于当前 4882（合并套件不得靠删断言变绿） |
| 7 | `npm run lint` 与 `npm run check:docs` 全绿；`docs/development.md` 的套件表与 `tests/run.mjs` 的 `SUITES` 逐一对得上 |

## 5. 不做什么

- **不引入 jsdom / vitest / mocha / playwright**。本项目零测试依赖是刻意选择，`tree-dom.mjs` 的头注释
  已经写明理由。新增骨架一律纯 `node:` 模块。
- **不追求覆盖率数字**。判据是「失败指向真实缺陷」，不是行覆盖率。
- **不重写既有 335 项 client-shape 断言**，只做增量迁移。
- **不动 `tests/support/fake-ssh-server.mjs` 的连接层**，只在它旁边加文件层。

## 6. 顺序与风险

1. `.gitattributes` + stub 根修复（半天，立刻消除噪声）
2. `fake-sftp.mjs` + 3 个写入类套件改用它（主菜）
3. `plugin-host.mjs` + 逐套件迁移（机械但量大，一次迁 2–3 个，每批跑全量）
4. `render.mjs` + 新测试先用
5. 代码整合（有骨架兜底之后）

最大风险是**替身比真宿主宽松**：迁移过程中每个套件迁完必须确认「原本会失败的用例仍然失败」
（负向对照），否则就是换了个更舒服的假绿。
