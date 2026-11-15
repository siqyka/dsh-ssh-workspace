# 远程工作区 Forge 面板误报「当前目录不是 Git 仓库」：诊断与修复

> 一句话定位：宿主 Forge 面板用 `env: { GIT_DIR: undefined, … }` 清掉继承的 Git 选择器，
> 本地 `spawn` 把 `undefined` 当作「不设置该变量」，而插件的远端桥把它序列化成
> `export GIT_DIR='undefined'`，远端 git 于是去读 `./undefined` 并以 128 退出——
> 面板把「git 说这里不是仓库」当成了「这里确实不是仓库」。本页记录证据、
> undefined env 修复 补丁（`lib/patch-subprocess.js`）与退役判据。

- 状态：已修复（2026-11-14）
- 影响面：所有 `ssh://` 远程工作区的**服务端** Forge 面板检查（本地工作区不受影响）
- 上游基线：`@shiqyka/dsh-ssh-workspace` v0.3.3（`0cd4caf`）；宿主 `@deepseek-ai/dsh` 0.2.2-rc.1
  [troubleshooting.md](./troubleshooting.md)、
  [upstream-workaround-pattern.md](./upstream-workaround-pattern.md)（退役模式）

## 1. 现象

在 DSH Web UI 里打开远程工作区 `ssh://910b-05/mnt/data/Codes/vllm-ascend`，
Forge 面板显示「当前目录不是 Git 仓库」，而该远端目录确实是 Git 仓库：

```console
$ ssh 910b-05 'cd /mnt/data/Codes/vllm-ascend && git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD'
/mnt/data/Codes/vllm-ascend
fix/rwkv7-api-compat
```

该中文串的唯一来源是宿主 Forge 面板的 `checkout.none` 文案
（`@deepseek-ai/dsh-experimental-client-ui-forge/lib/client.js:8450`）；
服务端用 `RemoteError('forgePanel/not-a-checkout')` 映射到它
（`…/dsh-experimental-client-ui-forge/lib/index.js:3082`，
客户端映射见 `client.js:6298`，渲染见 `client.js:8036-8038`）。
因此这条提示**只**来自 Forge 面板的 checkout 检查，与「本地变更」列表
（`dsh-workspace-changes`）的判空不是同一条路径。

## 2. 链路：哪条 git 调用、什么 spec

面板每次检查都走这段服务端代码：

1. `ForgePanel.inspectOnce()`（`dsh-experimental-client-ui-forge/lib/index.js:1739`）
   以 Session 的当前目录调用 `inspectCheckout()`；该目录就是会话 cwd 字符串
   `ssh://910b-05/mnt/data/Codes/vllm-ascend`。
2. `inspectCheckout()`（同文件 `:219`）先跑
   `git rev-parse --show-toplevel`，`exitCode !== 0` 且 stderr 匹配
   `NOT_A_CHECKOUT = /not a git repository|must be run in a work tree/i`
   （同文件 `:203`）时返回 `undefined`（`:221-223`）→ `checkout.state = "none"`
   （`:1741`）→ 客户端显示 `checkout.none`。
3. `gitIn()`（`:336`）→ `runGit()`（`:359`）用**Session 的沙箱策略**包装命令，
   再交给 `ctx.subprocess.spawn`（`:378-392`）。它显式传的环境是：

   ```js
   env: {
     ...GIT_ENV,                    // 16 个键，值全是 undefined
     GIT_CONFIG_COUNT: String(overrides.length),
     // …overrides 的 GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n
   }
   ```

   `GIT_ENV`（`:172-195`）由 `Object.fromEntries([…].map(key => [key, void 0]))`
   构造，`GIT_DIR`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_INDEX_FILE`、
   `GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES` 等 16 个键**存在但值为
   `undefined`**——注释写明用途是「清掉继承来的仓库/配置/替换引用选择器」。
4. `cwd` 是 `ssh://`，于是插件的 `ctx.subprocess` 接管生效
   （`lib/patch-subprocess.js:716-731`，只对 `isRemotePath(spec.cwd)` 分流），
   `buildScript()`（`:299`）把 spec 翻译成远端 shell 脚本。
   此前的 argv 剥离修复已保证 `[landlock-run, …grants, '--', git, …]` 被剥回逻辑 argv，
   所以命令确实在远端跑——这也解释了为什么报错从「桥拒跑 landlock-run」
   变成了「git 说不是仓库」。

## 3. 根因：`undefined` 环境值被序列化成字符串 `undefined`

Node 自己的 `child_process` 对 `env` 中值为 `undefined` 的项是**跳过**（等于不设置该变量），
所以本地工作区里这 16 个键不会到达 git：

```console
$ node -e 'const {spawnSync}=require("node:child_process");console.log(spawnSync(process.execPath,["-p","process.env.GIT_DIR"],{env:{...process.env,GIT_DIR:undefined}}).stdout.toString())'
undefined        # 打印的是字符串 "undefined"，即进程里根本没有 GIT_DIR
```

插件的远端半不是 `spawn`，而是 `export KEY=…`。修复前
`buildScript()` 的 env 循环（`lib/patch-subprocess.js:302-318`）只对**非字符串**值做
`String(value)`（`translateEnvValue`，`:269-271`），于是 `undefined` 变成字面量
`'undefined'` 导出：

```text
export GIT_DIR='undefined'; export GIT_WORK_TREE='undefined'; …; export LC_ALL='C'; …
cd '/mnt/data/Codes/vllm-ascend' && { …; exec 'git' … 'rev-parse' '--show-toplevel'; }
```

远端 git 把 `GIT_DIR=undefined` 当成相对于 cwd 的路径 `./undefined`，直接失败：

```console
$ ssh 910b-05 "cd /mnt/data/Codes/vllm-ascend && export GIT_DIR=undefined && git rev-parse --show-toplevel"
fatal: not a git repository: 'undefined'        # exit 128
```

（Forge 的 spec 还导出 `LC_ALL='C'`，所以面板侧看到的是英文
`fatal: not a git repository: 'undefined'`，正好命中 `NOT_A_CHECKOUT` 正则。）

一句话：**宿主用 `undefined` 表达「unset」，桥把它翻译成了「set 成字符串 undefined」**。
这不是 argv 剥离引入的回归，而是上游 v0.3.3 的桥在「本地 spawn 语义 ↔ 远端 shell 导出」
之间漏掉的一层语义；argv 剥离只是让它第一次有机会暴露成「不是 Git 仓库」。

## 4. 复现与证据

三层证据，从下到上：

### 4.1 远端事实（与会话无关）

```console
$ ssh 910b-05 'cd /mnt/data/Codes/vllm-ascend && git rev-parse --show-toplevel --absolute-git-dir --git-path objects; echo exit=$?'
/mnt/data/Codes/vllm-ascend
/mnt/data/Codes/vllm-ascend/.git
.git/objects
exit=0
```

### 4.2 桥生成的脚本（不连网也能看）

`tests/remote-git-env-smoke.mjs` 用 subprocess 服务替身 + engine 替身捕获
`record.client.exec()` 收到的脚本。回退 `lib/patch-subprocess.js:315` 的守卫再跑，
脚本里会出现 `export GIT_DIR='undefined' …` 且三条断言失败；
打上修复后脚本只剩已定义键（`GIT_CONFIG_COUNT` / `LC_ALL` / …）。

### 4.3 真实 SSH 端到端（本次诊断用的一次性 harness）

用同一个 `installRemoteSubprocess()`，把 `record.client.exec()` 换成真 `ssh -o BatchMode=yes 910b-05 <script>`
的通道替身，喂给桥的 spec 与 Forge `runGit()` 完全一致
（`argv = [git, --no-optional-locks, -c core.hooksPath=/dev/null, -c core.fsmonitor=false, rev-parse, --show-toplevel]`、
`cwd = ssh://910b-05/mnt/data/Codes/vllm-ascend`、`env = GIT_ENV + GIT_CONFIG_COUNT: '0'`）：

| | 桥脚本里的 GIT_DIR | 远端 exit | 面板结论 |
| --- | --- | --- | --- |
| 修复前 | `export GIT_DIR='undefined'` | 128，`fatal: not a git repository: 'undefined'` | `checkout.none`（当前目录不是 Git 仓库） |
| 修复后 | 不导出 | 0，stdout `/mnt/data/Codes/vllm-ascend` | checkout 就绪 |

修复后把 `inspectCheckout()` 需要的 7 条查询全部走桥跑一遍，全部命中允许的退出码：

```text
ok   rev-parse  exit=0 stdout="/mnt/data/Codes/vllm-ascend\n"
ok   common-dir exit=0 stdout="/mnt/data/Codes/vllm-ascend/.git\n"
ok   git-dir    exit=0 stdout="/mnt/data/Codes/vllm-ascend/.git\n"
ok   branch     exit=0 stdout="fix/rwkv7-api-compat\n"
ok   commit     exit=0 stdout="7f9fc618f\n"
ok   upstream   exit=0 stdout="origin/fix/rwkv7-api-compat\n"
ok   remote     exit=0 stdout="origin\thttps://github.com/TimeMobius/vllm-ascend.git (fetch)\n…"
```

## 5. 修复

`lib/patch-subprocess.js`（`buildScript()` 的 env 循环，`:302-318`）——只加一条「与本地语义对齐」
的守卫，外加注释和稳定 id：

```js
for (const [key, value] of Object.entries(env)) {
  if (!ENV_NAME_RE.test(key)) continue
  if (value === undefined) continue      // ← undefined env 修复：Node 的 unset 语义
  segments.push(`export ${key}=${shellQuote(translateEnvValue(key, value, parts.alias, mkdirs))}`)
}
```

边界与取舍：

- **只跳过 `undefined`**，不跳过 `null`：Node 对 `null` 会强转成字符串 `"null"`，
  桥保持一致（这是本地/远端行为等价，不是本次缺陷）。
- 不动 `translateEnvValue()`：是否**发出**这条 export 是 `buildScript` 的决定；
  `translateEnvValue` 仍负责路径翻译，行为不变。
- 不动此前 argv 剥离的 argv 剥离、不动 argv/cwd 翻译、不动 `lib/client.js`（该文件由
  `ws-flow-ui` 负责，本修复不需要它）。
- 本地工作区零影响：本地 spec 不进这个桥，`undefined` 仍由 Node 自己丢弃。

## 6. 验证

```console
$ node tests/remote-git-env-smoke.mjs
=== 16 passed, 0 failed ===

$ npm run lint
all 157 modules parse (lib, scripts, tests)

$ npm test
=== run.mjs: 78 passed, 0 partial, 6 skipped, 0 failed (84 suite(s)) ===
```

防回归测试 `tests/remote-git-env-smoke.mjs`（已登记进 `tests/run.mjs` 的 `SUITES`，
紧跟 `phase6`）钉住四件事：

1. Forge 形状的 spec 里 `undefined` 值不得出现在远端脚本中（`GIT_DIR=` 等一个都不许有）；
2. 已定义值仍原样导出（`GIT_CONFIG_COUNT`、`LC_ALL`、`GIT_TERMINAL_PROMPT`…）；
3. cwd / argv 翻译不受影响（`cd '<remotePath>'`、`exec 'git' …`）；
4. 反证：把 `:315` 的守卫删掉再跑同一套件 → `13 passed, 3 failed`，失败项正是上面第 1 条。

`docs/development.md` 的套件表与生成区（`scripts/doc-numbers.mjs`）已同步：
套件数 84、新增 `remote-git-env-smoke` 一行。

## 7. 注销判据（什么时候可以删这处修复）

满足**任一**即可删：

1. **上游版本修好**：上游 `lib/patch-subprocess.js` 的 `buildScript()` 在序列化 env 时
   不再导出 `undefined` 值（等价于本补丁的 `if (value === undefined) continue`），
   且发布的版本 ≥ 该修复版本。升级/rebasse 到该版本后：
   ```bash
   grep -n "value === undefined" node_modules/@shiqyka/dsh-ssh-workspace/lib/patch-subprocess.js
   ```
   命中即视为上游已包含；同时用上游代码跑一次反向复现（删掉测试的 fork 指向，
   把 `tests/remote-git-env-smoke.mjs` 的 import 临时指向上游包）确认脚本里没有
   `'undefined'` 导出。
2. **宿主侧不再用 `undefined` 表达 unset**：`dsh-experimental-client-ui-forge` 的
   `GIT_ENV` 改成不包含这些键（或改成显式空值并自行处理），且 `runGit()` 不再把
   `undefined` 交给 `ctx.subprocess`。该信号比上游修桥更弱——桥仍应正确处理
   `undefined`（任何宿主代码都可能在 spec 里用它表达 unset），所以优先等条件 1。

退役步骤：删 `lib/patch-subprocess.js:305-315`（注释 + 守卫）→ 删
`tests/remote-git-env-smoke.mjs` → 从 `tests/run.mjs` 的 `SUITES` 移除 →
从 `docs/development.md` 套件表删行 → `node scripts/doc-numbers.mjs` 重生成 →
`npm run lint && npm test`。

## 8. 残留风险与未处理项

1. **宿主进程需要加载新代码才生效**。`dsh web`（systemd `dsh-web.service`）在本机
   07:00:56 启动，而插件 host 端模块是在启动时 `import` 的；浏览器端 `lib/client.js`
   的 HMR 只更新客户端 bundle，管不到 host 端的 `lib/patch-subprocess.js`。
   本次任务约定不重启宿主，因此**验证时如果面板仍报旧结论**，说明当前进程还持有旧模块，
   需要重启 `dsh-web.service`（或宿主自身的插件热重载）后才看得到修复。
   判断依据：修复生效后该面板应显示分支 `fix/rwkv7-api-compat`、commit `7f9fc618f`、
   remote `origin/…`，而不是「当前目录不是 Git 仓库」。
2. **Forge 的「本地变更」卡片在远端工作区仍不可用（与本次缺陷无关）**。
   `localChanges()` 把后续 git 绑定到 `inspection.checkout.root`（`…/index.js:755-760`），
   而 `root` 来自 `ctx.fs.processPath()`，远端目标被剥成不带 `ssh://` 的
   `/mnt/data/Codes/vllm-ascend`（本插件 `lib/remote-fs.js:434-440`）；这样的 cwd 不满足
   桥的分流条件（`lib/patch-subprocess.js:728`），会落到本地 spawn 并失败，
   而 `localOf()` 把该错误吞掉（`…/index.js:1805-1811`），于是卡片直接不显示。
   checkout 信息（分支 / commit / remote）不受影响。
   → **已由 普通路径路由修复 处理**：普通路径在「唯一已挂载根」等三条约束下也会路由到远端，
   见 §10。
3. **`dsh-workspace-changes`（Changes 记录器）在远端工作区同样有路径形状问题**：
   `locateGitWorkspace()` 对 `git rev-parse --git-path objects` 的相对输出
   `.git/objects` 做 `resolve(cwd, line)`（`dsh-workspace-changes/lib/types/git.js:87`），
   `cwd` 是 `ssh://…`，于是得到一个宿主本地绝对路径，随后作为
   `GIT_ALTERNATE_OBJECT_DIRECTORIES` 传给远端 git；后续快照命令又以
   `workspace.root`（同样是不带 scheme 的远端路径）为 cwd 派发，无法被桥接管。
   这是宿主侧实现与「远端执行世界」之间的形状不匹配，插件内无法在不猜测
   alias 的前提下安全修复（同一路径可能存在于多台主机）；本补丁不扩大范围。
   → 该缺口与 Forge 卡片共用同一条「普通路径 cwd」通道，普通路径路由修复 一道覆盖；
   实测细节与「本部署里 `node:path` 桥通常仍会把它折回 `ssh://`」的差别见 §10.1。
4. **其它可能传 `undefined` 的宿主调用方**：修复对它们一律按 Node 语义「不导出」，
   不会比本地更宽松或更严格；数值/布尔等非字符串值仍按 `String()` 处理（与 v0.3.3 一致）。

## 9. 相关

- [troubleshooting.md](./troubleshooting.md)：远程工作区常见错误与限制
- [upstream-workaround-pattern.md](./upstream-workaround-pattern.md)：本补丁采用的退役模式
- [architecture.md](./architecture.md)：`ctx.subprocess` 接管与远端执行世界

## 10. 普通路径（不带 scheme）的 subprocess 路由

> 一句话：Forge 的「本地变更」卡片把 git 绑在 `ctx.fs.processPath()` 规范化后的
> **普通路径**（`/mnt/data/Codes/vllm-ascend`，没有 `ssh://`）上，而桥只按
> `isRemotePath(spec.cwd)` 分流，于是 `rev-parse` / `numstat` / `ls-files` 全部落回
> 本地 spawn、失败并被 `localOf()` 吞掉，卡片不显示。普通路径路由修复 只在
> **唯一已挂载根 + 主机可用 + 本机不存在同名路径** 三条同时成立时，才把普通路径
> 路由到远端；任何一条不成立都保持本地行为。

- 状态：已修复（本地补丁 `普通路径路由修复`，2026-11-14）
- 影响面：`ctx.subprocess` 的 `spawn()`（只允许 git / ripgrep），
  **不改变** `ctx.fs` 对普通路径的语义（fs 接缝继续只认 `ssh://`）
- 改动的文件 / 函数：
  - `lib/patch-subprocess.js`
    - `resolvePlainRemoteRoute()` —— 判定规则的全部实现（纯函数，可单测）
    - `translateArgv()` / `translateArgValue()` —— 仅对 git 的**路径位** argv 做
      `ssh:// → 远端路径` 翻译
    - `RemoteSubprocessRouter`：`plainRouteFor()`、`#hostRefusal()`、
      `#rememberPlainRoute()`、`spawn(spec, route)`
    - `installRemoteSubprocess()` 的 `spawn` 分流：`ssh://` 走原逻辑，普通路径先问
      `plainRouteFor()`，只有 `kind === 'remote'` 才交给远端半
  - `tests/local-changes-remote-smoke.mjs` —— 决策表 + 桥行为 + 真机调用形状
- 稳定标识：代码里用 `local fork runbook: docs/remote-git-diagnosis.md · id:
  普通路径路由修复` 标注；本节的注销判据是唯一权威。

### 10.1 普通路径为什么会掉出远端

两条宿主代码路径最终都变成「普通路径 cwd 交给 `ctx.subprocess`」：

1. **Forge「本地变更」卡片（用户看到的那张卡）**

   1. `ForgePanel.localChanges()` 用 `inspection.checkout.root` 构造 git runner
      （`dsh-experimental-client-ui-forge/lib/index.js:755-781`）。
   2. `inspectCheckout()` 先以 Session 的 `ssh://` cwd 跑 `git rev-parse --show-toplevel`
      （这条能过桥），随后用
      `ctx.fs.processPath(await ctx.fs.resolve(path, { cwd: directory }))`
      把 git 输出规范化成「进程路径」（`…/index.js:219-250`）。
   3. 本插件的 `RemoteFileSystem.processPath()` 对远端 target **故意返回不带 scheme 的
      远端绝对路径**（`lib/remote-fs.js:434-440`）——这是 fs 接缝的约定：`processPath`
      回答的是「进程世界里的路径」。于是 `checkout.root = /mnt/data/Codes/vllm-ascend`。
   4. `gitIn(ctx, config, session, root, signal)` → `runGit()` 把 `cwd: root` 交给
      `ctx.subprocess.spawn()`（`…/index.js:336-430`）。修复前桥的分流条件是
      `isRemotePath(spec.cwd)`（`lib/patch-subprocess.js` 的 install 包装），普通路径
      不匹配 → 本地 spawn。
   5. 本机不存在 `/mnt/data/Codes/vllm-ascend`，本地 spawn 直接失败；`localOf()` 的
      `catch { return null }`（`…/index.js:1805-1811`）把失败吞成「没有本地变更」，
      卡片于是被隐藏。

2. **`dsh-workspace-changes` 记录器（`workspace/changes` 事件）**

   `locateGitWorkspace()` 用 `resolve(cwd, line)` 把 git 的远端绝对 stdout 折成路径
   （`dsh-workspace-changes/lib/types/git.js:84-95`），之后所有快照命令都用
   `workspace.root` 当 cwd。**本部署的实测补充**（与 §8.3 的源码推断略有差别）：

   - 本插件的 `node:path` 桥（`lib/fs-shim.js` 的 `resolve` 补丁）在宿主进程里生效时，
     `resolve('ssh://h/mnt/x', '/mnt/x')` 会折回 `ssh://h/mnt/x`，
     `resolve('ssh://h/mnt/x', '.git/objects')` 折成
     `ssh://h/mnt/x/.git/objects`。所以记录器的 `root` 通常**仍是带 scheme 的**，
     `snapshotTree` / `diffTrees` 当时就走远端（已在 910b-05 上验证）。
   - 但只要哪一环把 target 规范化成进程路径（Forge 的 `processPath` 就是设计如此；
     或宿主/未来上游让 `node:path` 桥失效），`resolve` 就会给出普通路径、甚至
     `/root/Codes/多主机插件/ssh:/910b-05/...` 这种宿主本地绝对路径
     （实测：不装 path 桥时 `locateGitWorkspace` 得到的就是后者）。
   - 两种形状落进同一个缺口：**cwd 不是 `ssh://` 的 spec 一律本地 spawn**。普通路径路由修复
     覆盖普通远端路径；宿主本地绝对路径仍按本地语义走（它本来就不在任何已挂载根下）。

一句话：这不是某一张卡的私有 bug，而是「进程路径（plain）↔ 远端世界（`ssh://`）」
之间缺的一层映射。普通路径路由修复 只补 subprocess 这一条缝，因为 `ctx.fs` 的普通路径语义
是宿主与本地沙箱依赖的，不能动（见 §10.3）。

### 10.2 判定规则

**规则（一句话）：一个 POSIX 绝对普通路径，只有在它落在唯一一个已挂载远端根之下、
该根的主机仍可用、且本机不存在同名路径时，才路由到远端；否则一律保持本地行为。**

判定顺序（实现见 `resolvePlainRemoteRoute()`，`reason` 是诊断里用的稳定 id）：

| # | 条件 | 结果 | `reason` |
| --- | --- | --- | --- |
| 1 | cwd 不是字符串 / 空串 | 本地 | `not-a-path` |
| 2 | 不是 POSIX 绝对路径（相对路径、`C:\…`、`\\server\share`、`ssh://…`） | 本地 | `not-posix-absolute` |
| 3 | 词法规范化失败 | 本地 | `unparsable` |
| 4 | `fs.existsSync(规范化路径)` 为真（或探测抛错） | 本地 | `exists-locally` |
| 5 | 没有任何已挂载根的规范化路径包含它 | 本地 | `no-mounted-root` |
| 6 | 命中 **≥2 个不同的**（alias + 根路径） | 本地 + 诊断 | `ambiguous-root` |
| 7 | 主机不可用（无连接配置 / workspace 已 detach / 状态读不出） | 本地 + 诊断 | `host-unavailable` |
| 8 | 以上都不成立 | **远端** | — |

细节约定：

- **包含关系是词法的**（`isRemotePathUnder`，与插件其余身份判断一致）；
  根本身也算「落在根下」，因为 Forge 的 `checkout.root` 恰好等于挂载根。
- **同一个根的不同拼写只算一个**（尾斜杠 / `.` / `..` 规范化后相同），
  但**嵌套的两个根算两个**：`/a` 与 `/a/b` 都挂载时，`/a/b/x` 无法判断属于哪个
  工作区，宁可不路由。把嵌套挂载改成互不包含的路径即可恢复。
- **`ssh://` 不进这个函数**：调用方先按原逻辑处理，保持既有行为完全不变。
- **不做「学一次就记住」的路由缓存**：每次 spawn 都按当时的根集合、存在性、主机状态
  重新判定（`router.plainRoutes` 只是诊断记录，上限 128 条，不参与决策）。
- **`fs.existsSync` 为真就本地**：这是用户意图的最强信号（尤其目录）；代价是
  远端路径与本地同名时卡片依旧不可用——这是刻意的取舍，见 §10.7。

### 10.3 安全边界

1. **只影响 `ctx.subprocess.spawn()`**，而且只放行 git / ripgrep（原有白名单）。
   `ctx.fs`、`node:fs`、shell、terminal 全部不变：普通路径在 fs 接缝里仍然是本地路径。
2. **歧义即本地（fail closed）**：同一路径命中多个主机或根 → 不路由、`logger.warn` +
   engine diagnostics（`degraded`，`ssh_workspace_status` / 面板状态可见），绝不猜 alias。
3. **本地同名路径优先**：`fs.existsSync` 为真就不劫持；探测失败也按「存在」处理。
4. **破坏性命令和只读命令走同一道门**：桥无法安全地按子命令分类（`git add` 正是
   `dsh-workspace-changes` 需要的能力），所以 `git add` / `git gc` 与 `git status`
   的准入条件完全相同——都是上面三条。规则保守的收益是：只有「唯一根、主机可用、
   本地无同名」时，破坏性命令才可能到远端；否则留在本地（通常是失败），不会误伤。
5. **argv 只在路径位翻译**：仅对 git、且只对 `--` 之后的 pathspec、`-C` /
   `--git-dir` / `--work-tree` / `--namespace` 的操作数（分词或 `=` 形式）做
   `ssh:// → 远端路径`。其余 argv 逐字转发：`rg` 的 pattern 与路径混在一起，
   git 的 commit message / `grep` pattern 都可能是**数据**，改写它们会静默改变
   搜索结果或提交内容——比字面路径失败更糟。
6. **env 规则不变**：`ssh://` 值剥 scheme、宿主临时目录映射到远端 `/tmp` 镜像并
   `mkdir -p`（undefined 的 unset 语义也保留）；普通远端绝对路径原样导出
   （它本来就是远端世界里的路径）。
7. **stdout 不改写**：git 输出的远端绝对路径原样返回，宿主会把它们再作为
   cwd / env 传回来——这正是本规则要接住的下一次调用。
8. **权限不打折但也不扩大**：远端命令仍以远端登录用户的完整权限运行（与 shell 接缝
   一致）；普通路径路由不会让它比 ssh:// 路径多出任何能力，停用的 workspace
   依旧拒绝（`engine.isDisabledTarget`）。

### 10.4 验证

纯逻辑 + 桥行为（无真机即可，live 段 SKIP）：

```console
$ node tests/local-changes-remote-smoke.mjs
...
=== 42 passed, 0 failed ===   # 无 DSH_WS_TEST_ALIAS 时，live 段打印 SKIP
```

真机（910b-05）：

```console
$ DSH_WS_TEST_ALIAS=910b-05 \
  DSH_CORE_ROOT=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules \
  node tests/local-changes-remote-smoke.mjs
...
  PASS  plain-cwd rev-parse ran on the remote host (no local spawn)
  PASS  plain-cwd rev-parse returned the REMOTE absolute root
  PASS  plain-cwd rev-parse returned the remote git dir
  PASS  plain-cwd rev-parse printed the relative objects path unchanged
  PASS  the follow-up git status also ran remotely (still no local spawn)
  PASS  git add -n (dry run) runs remotely and reports the file
  PASS  the real checkout /mnt/data/Codes/vllm-ascend locates through a plain cwd
  PASS  a local repository path still runs locally
=== 60 passed, 0 failed ===
```

关键实测输出（`locateGitWorkspace()` 的调用形状，cwd 为**普通路径**）：

```text
plain rev-parse exit=0
  /tmp/dsh-ssh-workspace-test/.../local-changes-<pid>
  /tmp/dsh-ssh-workspace-test/.../local-changes-<pid>/.git
  .git/objects
localSpawns=0
plain status   exit=0  " M tracked.txt\n?? untracked.txt\n"
plain add -n   exit=0  "add 'untracked.txt'\n"   # 远端 index 未改动
real  repo     exit=0  "/mnt/data/Codes/vllm-ascend\n/mnt/data/Codes/vllm-ascend/.git\n.git/objects\n"
local repo     exit=0  "/root/Codes/多主机插件\n"   # 走本地 spawn（localCalls +1）
```

本地不回归的证据：

- 真机套件里 `git rev-parse`、`git status` 对 `/root/Codes/多主机插件` 仍走本地
  spawn，输出不变；`ssh://` cwd 的 42 条纯逻辑断言与既有行为一致。
- 既有套件全绿（`npm test` 中除 doc-numbers 之外全部通过；doc-numbers 的失败是
  「新套件尚未登记进 `tests/run.mjs` / 文档计数未重生成」，两处随本提交一并处理）。
- `npm run lint`：159 个模块可解析。

### 10.5 怎么确认（用户 / 验收）

1. **必须重启宿主**：本补丁在 `lib/patch-subprocess.js`（Host 侧），本 profile 的
   hmr 配置是 `root: []`，源码变化不进热重载；刷新浏览器不够。
   重启命令与上面相同（`systemctl restart dsh-web`，会中断现有会话，
   由用户/Lead 决定时机）。
2. 重启后打开远程工作区会话（`ssh://910b-05/mnt/data/Codes/vllm-ascend`），
   让 agent 改一个已在 git 里的文件，Forge 面板的「本地变更」卡片应出现并给出
   文件数 / 增删行数；分支、commit、remote 信息本来就正常。
3. 没有 GUI 时可用 `node tests/local-changes-remote-smoke.mjs`（带
   `DSH_WS_TEST_ALIAS=910b-05`）：它跑的就是卡片背后的调用形状，
   60 条断言全绿即说明桥接生效。
4. 诊断：如果某路径没被路由，`ssh_workspace_status` / 面板状态里会出现
   `degraded` 事件，文案带 `not routing plain path …` 与具体原因
   （`more than one mounted root` / `detached` / `not resolvable`）。

### 10.6 注销判据

满足**任一**即可删这处修复：

1. **上游插件自己会路由普通路径**：上游 `lib/patch-subprocess.js` 的 spawn 分流不再
   只看 `isRemotePath(spec.cwd)`，而是对「已挂载根下的普通路径」也做保守路由
   （等价于 `resolvePlainRemoteRoute` 的三条约束），且发布版本 ≥ 该版本。
   核对：
   ```bash
   grep -n "resolvePlainRemoteRoute\|ambiguous-root\|exists-locally" \
     node_modules/@shiqyka/dsh-ssh-workspace/lib/patch-subprocess.js
   ```
   命中后用上游代码跑 `node tests/local-changes-remote-smoke.mjs`（把 import 临时
   指向上游包）确认纯逻辑段仍全绿。
2. **宿主不再把远端 cwd 规范化成普通路径**：`ctx.fs.processPath()` 对远端 target
   返回 `ssh://` 拼写，或 Forge 的 `localChanges()` 改用 `displayPath` 绑定 git，
   或 `dsh-workspace-changes` 的所有 git 调用都保持远端拼写。此时普通路径不再
   出现在 `ctx.subprocess`，普通路径路由修复 是死代码。
3. **退役步骤**：删 `resolvePlainRemoteRoute` / `translateArgv` / `translateArgValue`
   与 `installRemoteSubprocess` 里的普通路径分支（连同 `普通路径路由修复` 注释）→ 删
   `tests/local-changes-remote-smoke.mjs` → 本节改为「已退役」记录 → 跑
   `npm run lint && npm test`。反向验证：不带 scheme 的 rev-parse 应再次落回本地
   （真机上表现为 `localSpawns` 增加、输出失败），即证明上游确实接住了这一层。

### 10.7 剩余风险与刻意不做的部分

1. **卡片里的未跟踪文件内容仍读不到**：Forge `untrackedFiles()` 用
   `ctx.fs.readBytes` 读未跟踪文件，而 cwd 是普通路径 → fs 接缝按本地路径处理 →
   ENOENT → Forge 把该文件**跳过**（`…/index.js:833-861` 的 `if (error instanceof
   FsError) continue`）。所以卡片能显示已跟踪文件的改动，未跟踪文件可能不出现。
   修复它需要放宽 `ctx.fs` 对普通路径的语义，正是本补丁明确不做的事（任务边界）。
   记录器的快照半不受影响（git 自己能看到未跟踪文件）。
2. **本地存在同名路径时卡片仍不可用**：这是安全取舍——用户可能真的在操作本地目录。
   换一个本机不存在的远端路径（或换主机）即可恢复。
3. **嵌套挂载导致歧义**：两个已挂载根互相包含时，交集内的所有路径都不路由。
   卸载其中一个（`ssh_workspace_unmount`）即可；这是有意的「不猜」。
4. **主机离线时命令会尝试连接再失败**，而不是立刻本地失败；两者都不改变卡片
   （Forge 仍吞错），但日志/诊断里会多一条连接失败。
5. **`rg` 的 argv 不翻译**：plain 路径本来就不需要翻译，`ssh://` 在 rg 里更可能是
   搜索文本而不是路径。搜索工具仍按原样把 argv 交给远端 rg。
6. **非 git/rg 可执行文件仍被同步拒绝**（原有白名单），不会因为 cwd 变成普通路径
   而放宽。
7. **不动 `tests/run.mjs` 与 `docs/development.md` 的登记/计数**：按分工由 Lead
   统一做；在那之前 `doc-numbers-smoke` 会报「新套件未登记 / 文档计数过期」，
   这是流程状态，不是 普通路径路由修复 的行为失败。
