# PR #6 评审记录：远端工作区改进

> 评审对象：GitHub PR #6（`feat/remote-workspace-improvements`），**head `91d9fa5d`**，
> 单一 squashed 提交 `feat: remote subprocess routing, terminal signal lifetime, two-step add-workspace, recent-commit strip`；
> 基线 `5bb3ff94`（v0.3.4）。本地评审分支 `verify/PR1`，合并提交 `1e860b3`
> （`--no-ff`，跟基线逐文件核对为 18 个文件、+3873/−45）。
>
> **行号口径**：本文所有 file:line 都指 **PR head `91d9fa5d`**。本地分支在合并之后又
> 追加了 7 个修复提交（见第 8 节），因此工作树里的行号会比本文若干处更大；引用本文时
> 请以 `git show 91d9fa5d:<file>` 为准。
>
> 评审方式：阶段一**只观察**（不改源码、不改测试），跑全量套件并逐项核对；
> 阶段二把发现的问题拆成 7 个独立提交；阶段三即本文。**未 push、未打 tag、未发布**，
> 版本号仍是 `0.3.4`。

## 1. 总体判定

**结论：接受合并，但必须先并入 4 个阻断级修复（P1 两项、P2 两项），其余为跟进项。**
PR 的四个功能方向（远端 subprocess 路由、终端信号生命周期、两步「添加工作区」、最近提交条）
方向正确、边界大体清楚；问题集中在**推测式路由的降级语义**与**调试残留**，而不是功能本身。

| 维度 | 判定 | 依据 |
| --- | --- | --- |
| 功能完整度 | 通过 | 四类功能在代码里各自可定位、可测试（第 2、3 节） |
| 安全面（新增路由） | 通过 | `git-history` 只读、只接受 `session` + `limit`，目录从 Session 记录取（第 4 节） |
| 降级语义 | **不通过 → 已修** | plain path 路由把非白名单命令从「本地 spawn」变成同步抛错（2.3） |
| 调试/清洁度 | **不通过 → 已修** | 终端模块把每次开/关写到 `/tmp` 的固定文件（2.2） |
| 代码卫生 | 小问题 → 已修 | `--namespace` 被当作路径选项（2.4） |
| 测试 | 通过 | 新增 3 套件（第 6 节）；与任务给定期望值的两处差异已逐条对账（第 7 节） |
| 文档 | 有漂移 → 已修 | 路由/套件/断言数手写值过期（第 8 节 F3） |

## 2. 四类修复逐条判定

PR 的修复主张可以归为四类。下表先给判定，随后逐条给证据与残余风险。

| # | 修复 | 判定 | 残余 |
| --- | --- | --- | --- |
| 2.1 | `undefined` env 值不再序列化成字符串 `"undefined"` | ✅ 成立 | 无（有反向证据） |
| 2.2 | `spawnTerminal` 的 `spec.signal` 只约束**分配**，不再关闭已开的 PTY | ✅ 成立，但**带调试残留** | 残留已删（F1b） |
| 2.3 | plain path（去 scheme）的 subprocess 路由 | ⚠️ 规则成立，**降级语义有回归** | 已修（F2b） |
| 2.4 | 沙箱 argv 前缀剥离（既有修复的延续） | ⚠️ **只覆盖 POSIX**，Windows 有缺口 | 已修（F1） |

### 2.1 `undefined` env 序列化（成立）

症状是 Forge 面板把远端仓库判成「不是 Git 仓库」。根因链：Forge 用
`env: { GIT_DIR: undefined, … }` 清继承的选择器 → 本地 `spawn` 把 `undefined` 当 unset →
插件的远端桥生成 `export GIT_DIR='undefined'` → 远端 git 读 `./undefined` 以 128 退出。
修复点：`lib/patch-subprocess.js:567` `if (value === undefined) continue`（远端脚本只导出已定义的键）。
反向证据在 `docs/remote-git-diagnosis.md`（本 PR 自带）：修复前远端 exit 128 / 修复后 exit 0。

### 2.2 终端信号生命周期（成立；调试残留已删）

`lib/patch-terminal.js` 在开启阶段引入 `const opening = new AbortController()`（`:379`）
并把 `spec.signal` 转接过去，只用于「分配」：宿主浏览器终端传的是**按请求**的信号
（`dsh-api-terminal-controller` 的 `create(agent, request, signal)`），RPC 一结束就 abort，
把该信号交给 `openChannel()` 会让 PTY 立刻关闭，面板显示空终端——`terminal_open`
（长信号）不受影响，所以症状是「浏览器终端空白、工具能开」。
**问题**：同一次改动还带进了 `traceTerminal()`（`:82`），固定写
`process.env.DSH_SSH_WORKSPACE_TRACE_FILE ?? '/tmp/ssh-workspace-terminal.log'`（`:85`），
每开/关/失败一行（`:386` 起 6 处调用）。这是把用户磁盘当作调试输出目录：文件永久增长、
在 Windows 上路径还是 POSIX 写法（写不到 `/tmp` 时静默吞掉异常）、并且**没有开关**
（`DSH_SSH_WORKSPACE_TRACE=0` 只是「别写」，默认是写）。
处置：整段删除（提交 `997ccf3`），并为 `terminal-smoke` 增加两条静态守卫
（模块内不得出现同步文件 I/O；文件路径与两个环境变量名不得回来），断言数 26 → 28。

### 2.3 plain path 路由（规则成立，降级语义有回归）

规则只在「**规范化后落在唯一已挂载远端根** + **该根主机可用** + **本机不存在同名路径**」
三条同时成立时把 scheme 去掉的 POSIX 绝对路径路由到远端：
`lib/patch-subprocess.js:331` `resolvePlainRemoteRoute`，三条分别裁在
`:341-346`（POSIX 绝对路径判定）、`:357-362`（`existsLocally` 为真即保持本地，
探测抛错也按「存在」处理，绝不放宽）、`:363-400`（根匹配与歧义/停机）。动机合理：
Forge 经 `ctx.fs.processPath()` 拿到的就是这种无 scheme 路径。

**回归**：安装的包装器在 plain 分支上无条件接管——`:1107` 取判定，`:1108`
`if (decision.kind === 'remote') return router.spawn(spec, decision)`，白名单判定
（`remoteCommandFor`，`:253` 的 `cannot run … only git and ripgrep`）在接管**之后**才执行。
于是 `bash -lc …` / `node …` 这种 spec 在「plain 且命中挂载根」的 cwd 上，
从「普通本地 spawn（本机无此路径时是 ENOENT）」变成**宿主 `spawn()` 内部的同步抛出**：
调用方无法降级，错误类型也变了。`ssh://` cwd 则不同——本地进程根本无法 chdir 进去，
在那里大声拒绝是正确行为。
处置（`f1599cb`）：只接管远端**能回答**的命令——新增 `routesToRemoteCommand(argv)`
（先 `unwrapSandboxArgv` 再试 `remoteCommandFor`，不抛），plain 分支改成
`:1107/1108` 的 `decision.kind === 'remote' && routesToRemoteCommand(spec.argv)`；
`ssh://` 分支保持无条件拒绝。测试把「同一条 plain 路径上 bash→本地、git→远端」
以及「ssh:// 上 bash 仍拒绝」三种并存断言清楚；旧断言
`the git/ripgrep whitelist still applies to a plain-path route` 编码的正是这个回归，
已改写为「回落到本地 spawn」，并保留「判定仍被记录进 `plainRoutes`」的第二条断言。

### 2.4 argv 前缀剥离（只覆盖 POSIX；Windows 缺口已补）

`:841` 只认 `landlock-run` / `bwrap` / `sandbox-exec` 三种 POSIX 前缀。
Windows 上宿主的 `dsh-sandbox-windows-acl` 会把命令包成
`["C:\Program Files\nodejs\node.exe", "...\dsh-sandbox-windows-acl\lib\runner.js", "--workspace", …,
"--mode", "workspace-write", "--", "git", "status", "--porcelain"]`，
这段前缀不被剥离，`argv[0]` 就成了 node.exe——远端 git 调用要么被当成「非白名单」拒绝，
要么被当作本地可执行文件送错方向。处置（`5d1716d`）：新增
`unwrapSandboxArgv(argv)`（Windows 分支要求**解释器在前 + 标记出现在 `--` 之前**才认，
不是看到 `--` 就切）；标记集 `SANDBOX_RUNNER_MARKERS` 覆盖 windows-acl / sandbox-local / `dsh-sandbox/`。
证据是真实的：宿主 `@deepseek-ai/dsh-sandbox-local` 在真 Cordis 里产出的包装 argv
（`WorkspaceSandboxService.confine`）喂给补丁后的桥，对真主机 `qiyk` 拿到 exit 0 与
`" M tracked.txt"`，本地 spawn 计数 0；同一包装里的 `bash` 仍被明确拒绝。

### 2.5 顺带发现（已修，见第 8 节）

- `--namespace` 被 `GIT_PATH_OPTIONS` 当作「下一项是路径」的 git 选项（`:430`），
  但 `--namespace` 命名的是 **ref namespace**，不是目录；远端翻译会把它改写成远端路径
  （修复提交 `c67f018` 只改集合本身，并补了两条「同一 argv 里真路径选项仍翻译」的断言）。
- 本轮 F1 顺手引入的死常量 `REMOTE_COMMANDS`（自引入起从未被引用，F2b 已删）。
- Changes 面板的**逐文件文本对比**对远端编辑永远拿不到：宿主 `dsh-workspace-changes`
  的 `captureFile()` 用 `node:fs` 打开 `ctx.fs.processPath(target)`，远端目标拿到的是远端路径，
  两次捕获都 ENOENT → `{kind:'absent'}` → `sameCapture()` 判等 → 整条被丢。
  这不是本 PR 引入的，但 plain path 路由让更多编辑落进这条路；处置是**不让它静默**
  （`5aa1463`：首次远端写入记一条 `degraded` 诊断，写清机制与「git 仍会列出文件」）。

## 3. 两个 UI 槽位重写

两处都是「**遮蔽官方槽位条目，而不是另注册一套**」——这是本插件既有的约束（宿主升级后
官方条目仍在，插件只是覆盖显示）。

### 3.1 「添加工作区」两步流程（directoryFlow 槽位）

`lib/client.js:4042` 起是 `directoryFlow` 的占位者。要点：

- `FLOW_PRIORITY = -100`（`:4046`）：槽位核心渲染**最低**优先级，因此插件条目压过原生
  入口，但双方注册都还在；
- 两步：先弹「新建本地工作区 / 新建远程工作区」，再走各自流程；本地路径直接渲染
  **已安装的 browse 面板组件本身**（同一个组件、同一套 locale 与列目录调用），
  没有应用内浏览器时回落 `pickDirectory()`（`:4053-4064`）；
- 取 browse 组件走**注册表原始 entries**（`resolveBrowseFlow`，`:4104-4130`）而不是宿主服务：
  宿主没有「委托给下一个占位者」的 API，而 browse 只注册了 flow 组件、没暴露 picker 服务；
  该函数对缺失/改形的注册表返回 `null`（不允许在添加工作区流程里崩）。

风险：`FLOW_PRIORITY` 与官方占位者同格竞争，宿主改优先级语义或改槽位名时会在**视觉上**
静默回到原生入口（功能退化而非报错）。缓解：`client-shape-smoke` 有对应的形状断言。

### 3.2 「变更请求」tab 的最近提交条（forge tab 同 key 遮蔽）

`lib/client.js:11187` `const FORGE_TAB_SHADOW_PRIORITY = -100`；`:11182-11210` 取官方 tab 的
`TAB_ID`（`@deepseek-ai/dsh-experimental-client-ui-forge`）作为 `FORGE_TAB_KEY`；
`:11220-11243` 用同一 cell key 注册自己的 tab **body**（官方组件保留在上半、提交条在下半）；
`:11399-11435` 渲染提交条并在卸载时 dispose（`forgeTabShadowDispose`，`:11200`）。
PR 同时改了 `client-shape-smoke` 里一条旧断言（原来禁止一切
`sidebar.right.pane.tab` 与 `sidebarRightTabs`）：现在拆成
「不得再注册**自己的** tab 类型」+「**恰好一个** body 且 key 必须是 `FORGE_TAB_KEY`」。
这条改动有解释、方向正确：遮蔽既有 cell 与新增 tab 类型是两件事，旧断言会把这个功能
永久挡在门外。残余：宿主若改 `TAB_ID` 常量，遮蔽会静默失效（面板少一条提交条，无报错）。

## 4. git-history 新路由的安全面

| 关注点 | 结论 | 证据（PR head） |
| --- | --- | --- |
| 只读 | 是 | `lib/routes.js:1392-1438`，`guard(req,res,'GET')` 后只有 `readGitHistory`，无写路径 |
| 页面能否传任意 path | **不能** | 路由只读两个查询参数 `session`（`:1416`）与 `limit`（`:1417`）；目录由 `resolveSessionCwd()` 从 Session 记录解析（`lib/git-history.js:230-252`：live Session → `workingDirectory.get()` → 头部 cwd → `sessionQuery` 回查） |
| argv 是否可注入 | 否 | `gitLogArgv(limit)`（`lib/git-history.js:82-103`）是固定 argv，唯一变量是钳制后的整数 `-n`；format 用 `%x1f` 字段分隔 + `-z` 记录分隔，解析端把含分隔符的 subject 拼回（`:123-152`） |
| 资源上限 | 有 | 行数 `GIT_HISTORY_MAX_LIMIT = 100`（`:39`，钳制 `:89-90`/`:132-133`）、超时 15 s（`:42`）、stdout 1 MiB（`:48`）、stderr 16 KiB（`:51`）、`graceMs` 2 s（`:45`）、env 清到固定五项（`GIT_CONFIG_COUNT=0` 等，`:352-366`） |
| 状态而非错误 | 是 | 非仓库 / 未出生 HEAD 是 200 的 `notRepository` / 空列表（`lib/git-history.js:176`、`:391`），与面板灰行一致 |
| 回环与 Host 头 | 复用 | `guard()`（同族路由共用，含 loopback + Host 精确校验） |

残余风险（低）：`sessionQuery` 回查会解析**已持久化但未附加**的 Session 的 header cwd——
这是有意的（重启后仍能看到提交条），但意味着「任何有 Session 记录的工作目录」都会被读一次
`git log`；该路由只在回环可达，且只读，风险可接受。另：`SESSION_ID_PATTERN`
（`lib/git-history.js:73`）拒绝怪形状 id，但**接受任意合法 id**——即本机任意 Session 的
工作目录都可被枚举；这与宿主其它 Session 作用域接口的信任模型一致，不额外扩大。

## 5. 必须修的问题表

| 级别 | 问题 | 位置（PR head） | 状态 |
| --- | --- | --- | --- |
| **P1** | plain path 路由把非白名单命令从本地 spawn 变成宿主 spawn 内同步抛错 | `lib/patch-subprocess.js:1107-1108`、`:253` | ✅ 已修 `f1599cb` |
| **P1** | 终端模块把调试 trace 写死到 `/tmp` 固定文件（默认开启） | `lib/patch-terminal.js:82-90`、6 处调用、`:379-386` | ✅ 已修 `997ccf3` |
| **P2** | 沙箱前缀剥离只覆盖 POSIX；Windows runner 前缀不剥离 | `lib/patch-subprocess.js:841` | ✅ 已修 `5d1716d` |
| **P2** | `--namespace` 被当作路径选项，ref namespace 被改写成远端路径 | `lib/patch-subprocess.js:430` | ✅ 已修 `c67f018` |
| P3 | Changes 面板逐文件文本对比对远端编辑永久缺失且静默 | 上游 `dsh-workspace-changes/lib/index.js` 的 `captureFile()`（本仓库不可修） | ✅ 已观测化 `5aa1463`（诊断 + 文档） |
| P3 | 死常量 `REMOTE_COMMANDS`（**本轮 F1 引入**，非 PR 带入） | `lib/patch-subprocess.js`（F1 引入、从未引用） | ✅ 已删（随 `f1599cb`） |
| P3 | 宿主 `TAB_ID` / 槽位优先级变化会静默使遮蔽失效（无报错，只少功能） | `lib/client.js:11187`、`:4046` | 已在 `client-shape-smoke` 有形状断言；不另行处理 |
| P3 | `doc-numbers` 只管生成表，表外手写数字漂移（31 路由 / 83 套件 / 44/44） | `docs/development.md`、`docs/architecture.md`、`docs/README.md`、`docs/features.md`、`docs/optimization-and-future03.md` | ✅ 已修 `a83be34`（F3） |

## 6. 测试与数字

阶段一（PR head，`DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules`）：

```
node tests/run.mjs → 81 passed, 2 partial, 2 skipped, 1 failed (86 suite(s))
```

- 唯一的失败组是 `lifecycle-smoke` 的三条旧断言（`exactly 32 HTTP routes registered — 33` 等）：
  PR 增加了第 33 条路由 `git-history`，**代码是对的、断言是旧的**。F0 先用运行时快照证明
  注册数确实是 33（33 个唯一路径、`kind: 'exact'`、`missing: []`、`extra: []`），再把断言
  pin 到 33 并补三条「表 ↔ 注册集」漂移断言（含一条 `git-history` 显式端点断言）。
  反向验证：把该描述符的 path 改成 `ROUTES.status`，计数断言仍绿、三条集合断言变红——
  这正是「只改数字不够」的证据。
- 跳过/部分：`live-smoke`、`acceptance-smoke`（缺 `DSH_WS_TEST_ALIAS`）；
  `boot-smoke` 远端段、`local-changes-remote-smoke` live 段为 `partial`。

阶段三（合并 + 7 个修复后，同一棵树）：

```
node tests/run.mjs → 82 passed, 2 partial, 2 skipped, 0 failed (86 suite(s))，4476 项断言
```

- 裸检出（无环境变量）：`79 passed, 1 partial, 6 skipped, 0 failed`，**4229 项**。
  两者之差正好是 `lifecycle 19 + tool-schemas 180 + projection-real 18 + boot 30`。
- `npm run check:docs` exit 0（21 个 md 链接、doc-numbers 与 4476 采样一致）。
- `node --check` 全部 `lib/*.js` 通过。
- 版本文件未动：`git diff 5bb3ff94 -- package.json package-lock.json | grep '^[+-].*version'` 为空。

## 7. 与任务给定期望值的对账

| 套件 | 期望 | 实测 | 说明 |
| --- | --- | --- | --- |
| `remote-git-env-smoke` | 16/0 | 16/0 | 一致 |
| `terminal-smoke` | 26/0 | 26/0（修后 28） | F1b 新增 2 条静态守卫 |
| `local-changes-remote-smoke` | 42/0 partial | 42/0 partial（修后 70） | F1 +14、F2a +2、F2b +8、F2c +6、断言改写 |
| `lifecycle-smoke` | 13/3（预期红） | 13/3 | 3 红全是「32 vs 33」，F0 后 19/0 |
| `commit-history-smoke` | 119/0 | **122/0** | 多出的 3 条是 `tests/commit-history-smoke.mjs:629` 的 `spawnSync git` 用例：上一轮沙箱里被 EPERM 跳过，本轮全权限下真的执行（119+3） |
| `client-shape-smoke` | 323/2 | **325/0** | 那 2 条 `exit null` 是 `spawnSync(process.execPath, ['--check', file])`（`tests/client-shape-smoke.mjs:438-444`）在上一轮沙箱里被拒；本轮通过（323+2） |

两处差异都是**严格更多覆盖**，不构成回归，也不需要改断言。

## 8. 本轮修复清单

全部在 `verify/PR1` 上，一个修复一个提交，均带「为什么」的提交说明：

| 提交 | 内容 |
| --- | --- |
| `52efff4` | **F0** `test(lifecycle)`：pin 33 条路由 + 表/注册集漂移 + git-history 显式端点（19/0） |
| `5d1716d` | **F1** `fix(subprocess)`：`unwrapSandboxArgv` 覆盖 Windows sandbox runner（real-Cordis 真机证据；14 条新断言，套件 42→56） |
| `997ccf3` | **F1b** `fix(terminal)`：删除临时 trace（含 `appendFileSync`、6 处调用、空 close 监听）+ 2 条静态守卫 |
| `c67f018` | **F2a** `fix(subprocess)`：`--namespace` 不再当路径选项（反向验证：加回 → 恰好 2 红） |
| `f1599cb` | **F2b** `fix(subprocess)`：plain 路径只接管 bridge 能回答的命令（bash→本地、git→远端、ssh:// 仍拒；删 `REMOTE_COMMANDS`） |
| `5aa1463` | **F2c** `fix(remote-fs)`：远端写入时把「宿主整文件捕获读不到远端路径」记一条 `degraded` 诊断（一次/激活；本地写不记）+ README ×2 / features 说明 |
| `a83be34` | **F3** `docs`：路由 31→33、套件 83→86、15 个套件断言数、两种运行口径与采样 4476 全部按实测改写 |

合并提交 `1e860b3`，其后 7 个修复，最后是本文件（阶段三文档提交）。

## 9. 未验证项与建议

1. **未上真机/浏览器的是 UI 部分**：`directoryFlow` 两步菜单的视觉、提交条在官方 tab 下半的
   布局、以及宿主升级后的槽位遮蔽，只有 `client-shape-smoke` 的**形状**断言。
   建议合并后在真机各点一次（并核对中英文案与 24px 行高）。
2. **`F2c` 的观测点**：诊断环是唯一可达面（本部署 `ctx.logger` 无 exporter、`debug` 被丢）。
   若后续升级宿主给 `workspace-changes` 增加 `ctx.fs` 读内容的能力，应把这条诊断改为
   真读内容或直接删除（判据写进了代码注释）。
3. **F1 的 Windows 证据建立在本机宿主版本上**（`@deepseek-ai/dsh-sandbox-windows-acl` 的
   runner 前缀形状）。宿主换 runner 时 `SANDBOX_RUNNER_MARKERS` 需要复核，
   `local-changes-remote-smoke` 的 `[sandbox wrapper]` 组会给出第一个信号。
4. **未 push、未打 tag、未发布**：7 个修复与本文都只在本地分支。是否合并回 `main`
   由作者决定；合并时建议 `--no-ff` 保留「合并 → 修复序列」的可读性。
