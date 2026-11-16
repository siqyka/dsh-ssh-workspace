# 实现任务书：远程工作区的「新建终端」按远端主机选择 shell

> 本文件是一次性任务书，交给一个**新的 Agent 会话**执行：读完之后直接改代码，不需要重新调研。
> 实现与验收通过后删除本文件，并同时移除 `docs/README.md` 里对应的一行索引。

## 0. 一句话目标

「远程工作区」面板里的**新建终端**菜单现在列的是**本机**的 zsh / bash / pwsh，选中后远端实际跑的是
`sh -l`——标签与行为不一致。本任务让菜单里的每一项都是**远端主机上真存在**的 shell，并且启动时
真的跑那一支；做不到就退回到今天的 `sh -l`，**不许出现「标签写 zsh、远端跑 sh」的假选项**。

## 1. 现状链（已逐段核对，不要重新推导）

### 1.1 UI 那一半是现成的

| 位置 | 事实 |
| --- | --- |
| `@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.js:69-72` | 菜单 items = `state.choices.shells.map(s => ({ id: s.path, label: s.name }))` |
| 同上 `:121` / `:125-137` | `Menu` 的 `selectedId` 取 `state.choices.selectedShell`；`onSelect(path)` 先 `selectShell(path)`，再 `openTab("terminal", { replaceTab: true, params: { shellPath: path } })` |
| 同上 `:469` | `loadShells: (signal) => ctx.webTerminals.launchShells(sessionId, signal)` |
| `dsh-api-terminal-controller/lib/client.js:1031-1040` | `launchShells` → `this.remote.shells(sessionId, signal)`，并把浏览器偏好 `preferredShell()` 命中的那一项标成 `selectedShell` |
| 同上 `:50` | 偏好 key `dsh.terminal.shell`，**全局单值**（不分主机） |
| 同上 `:246-249` | 无显式 shell 时 `path = shells.find(s => s.path === previous)?.path ?? shells[0]?.path` |
| 同上 `:265-277` | `create()` 把 `shellPath` 随 `terminal/create` 发出 |

所以**只改插件侧**即可，一行 UI 代码都不用动。

### 1.2 服务端那一半是错在「执行环境」这个概念上

| 位置 | 事实 |
| --- | --- |
| `dsh-api-terminal-controller/lib/index.js:771` | `super(ctx, "terminalController", { namespace: "terminal" })` |
| 同上 `:803-805` | `shells(agent, signal)` → `discoverShells(this.execution(agent).subprocess, this.config.shell, this.config.shellCandidates, signal)` |
| 同上 `:969-980` | `execution(agent)` 只 `agent.ctx.get` 出 `subprocess` / `sandboxPolicy` / `workingDirectory` 三个 provider |
| 同上 `:14-24` | `resolveShell`：`configured ?? profile(environment.defaultShell …)`，然后 `subprocess.resolveExecutable(shell.path, void 0, signal)` |
| 同上 `:26-32` | `profile(path)`：`args` 按 kind 给（`cmd` → `[]`、`pwsh`/`powershell` → `['-NoLogo']`、其余 → `['-i']`） |
| 同上 `:49-65` | `discoverShells`：`const preferred = await resolveShell(...)`（**没有 try/catch**），再逐个候选 `resolveShell`，按 `shellKind` 去重 |
| 同上 `:745-751` | `shellCandidates` 默认 `['zsh','bash','fish','pwsh','powershell','cmd']` |
| 同上 `:981-1000` | `spawn`：`:984` 无 `shellPath` 走 `resolveShell`，有则在 `this.shells()` 里 find；`:986-996` `subprocess.spawnTerminal({ argv: [shell.path, ...shell.args], … })` |
| `dsh-subprocess-local/lib/index.js:1523` / `:1609` | `resolveExecutable` 用**本机** `stat` + `X_OK`；`terminalEnvironment` 读**本机** `$SHELL` / ComSpec |

**病根一句话**：`execution(agent)` 拿到的 `ctx.subprocess` 确实是插件已包装的那个对象（因此 `spawn` /
`spawnTerminal` 会分流到远端），但插件**只包了这两个方法**：

- `lib/patch-subprocess.js:1200-1234` 包 `spawn`；
- `lib/patch-terminal.js:448-474` 包 `spawnTerminal`。

`terminalEnvironment` / `resolveExecutable` **一处都没有被包**（`lib/` 内 grep 命中 0）。于是
`resolveShell` 走完全部的本机路径，菜单天然与本机相关。

### 1.3 为什么不能只改菜单

只改菜单 = 标签换成远端 shell 名字、启动仍落 `sh -l`。那是一个**新的谎报**，比今天"静默降级到 sh"
更糟（用户会以为自己在 zsh 里，其实在 sh 里，`setopt`、`fish` 语法、`$ZSH_VERSION` 全部对不上）。
**发现与启动必须同一份事实**。

### 1.4 已经否掉的替代（不要重新讨论）

| 方案 | 否掉的理由 |
| --- | --- |
| 只改菜单（不改启动） | 见 §1.3 |
| 纯配置（给 `terminalController` 配 `shell: { path }`） | `shell` / `shellCandidates` 仍走本机 `stat`；而且 `discoverShells:50` 的 `resolveShell` 没有 try/catch，配一个远端才有的路径会让整个 `shells()` 抛错，菜单直接变「failed」 |
| 包装 `terminalEnvironment` / `resolveExecutable` | 这两个是**全局单例方法**，分不出"哪个会话"；`spawn` 里无 `shellPath` 时也会叫它们，改造面反而更大、且会污染本机会话 |
| 等上游加 provider seam | 已登记在 `docs/optimization-and-future03.md:115`；短期不可行 |

## 2. 交付内容（三件事）

### 2.1 新增 `lib/remote-shells.js`（发现）

**不是** `patch-*.js`：本任务不触发 `tests/upstream-contract-smoke.mjs` 的
「每个 patch 文件必须有契约」与「terminal patch 是最后一个 seam」两条断言，所以刻意用普通模块名。

**命名陷阱（会直接把 `upstream-contract-smoke` 弄红，务必按这里取名）**：该套件的安装顺序断言用
`index.indexOf(contract.installs)` 定位（`tests/upstream-contract-smoke.mjs:112-134`），
而 `PATCH-shell` 的 `installs` 是字符串 **`installRemoteShell`**（`lib/upstream-contract.js:73`）。
只要本模块的入口名**以** `installRemoteShell` **开头**（`installRemoteShells`、
`installRemoteShellDiscovery` 都算），且它的 import 行或调用点出现在
`./patch-shell.js` 那次调用**之前**，`PATCH-shell` 的位置就会被算到本模块上，
"fs before shell" 与 "terminal is the last seam" 两条会以看起来毫不相关的方式失败。
所以入口名一律用 **`installShellDiscovery` / `uninstallShellDiscovery`**（不以
`installRemoteShell` 开头），import 按现有顺序插在 `./protocol.js` 附近即可。

导出：

```js
export async function discoverRemoteShells (deps, alias, options = {}) // → Promise<ShellProfile[]>
export function parseShellSweep (stdout)                              // → {shells: [{kind, path}], complete: boolean}
export function shellArgsFor (path)                                   // → string[]
export function installShellDiscovery (ctx, options)                  // → router | undefined
export function uninstallShellDiscovery (target)                      // → void
```

规格：

- **返回形状必须只有三个字段**：`{ path, args, name }`，且都是可 JSON 序列化的字符串 /
  字符串数组。理由：`terminal/shells` 的严格 codec（`dsh-api-terminal-controller/lib/typert.host.js:562`
  起的 `result`，`jsonSchema` 里 `required: ["path","args","name"]`、`additionalProperties: true`）
  会编码整个返回值，客户端只用 `path`（当 id）与 `name`（当标签）；多塞主机名、`kind` 之类
  会让"两台主机同一个 shell 但 path 不同"的偏好匹配变复杂，而这两项值不值得。

- **一次往返**。用 `engine.exec(alias, script, { timeoutMs: 10_000, signal, replay: 'safe', channel: 'exec' })`。
  `replay: 'safe'` 是必须的：`command -v` 与读 `$SHELL` 是只读探测，与
  `probeCapabilities`（`lib/engine.js:1331` 起的 `exec` 契约）同类，断线后可安全重放一次。
- **脚本形态**照抄 `lib/engine.js:1219-1235` 的写法（`set +e`、每个标记只在成功时打印、末尾一个
  完成标记）。下面是**发到远端 shell 的最终文本**，不是 JS 源码——搬进模板字面量时换行要再按
  JS 转义一层（`\n` 写成两个字符）：

  ```
  set +e
  command -v zsh >/dev/null 2>&1 && printf 'dsh-shell:zsh:%s\n' "$(command -v zsh)"
  …
  printf 'dsh-shell:login:%s\n' "${SHELL:-}"
  printf 'dsh-shells-done\n'
  ```

  **候选名单**：优先 `target.config?.shellCandidates`（宿主自己的配置，用户加了 `nu` 就跟着问），
  否则插件默认 `['zsh','bash','fish','sh','dash','ksh','pwsh']`；两者都并上 `sh`（今天的
  `sh -l` 必须始终有对应项）。每个候选先过 `/^[A-Za-z0-9._+-]+$/u`，不合格的直接丢弃
  （名字会被拼进远端脚本，不许带空格 / 引号 / 分号），再 `shellQuote`（`lib/engine.js:1775`）。
- **三态诚实，与本仓库既有规矩一致**：没有 `dsh-shells-done` 或 `outcome.success !== true`（且
  `exitCode !== 0`）→ 判为**未知**，`discoverRemoteShells` **抛错**，并且**不写缓存**。
  理由：`shells()` 的契约是「transport failures reject」（`discoverShells` 的 JSDoc），
  菜单会显示「failed + 重试」；主机连不上时本来也开不出终端，此时给一份本机 shell 的列表才是谎报。
- **顺序**：`$SHELL` 解析出的那一支排第一（宿主的 `discoverShells` 也承诺 default first），
  其余按候选名单顺序；按 `shellKind`（basename，去 `.exe`，小写）去重，保留最早出现的。
- **args**：`cmd` → `[]`；`pwsh` / `powershell` → `['-NoLogo']`；其余 → `['-l']`。
  用 `-l` 而不是宿主 `profile()` 的 `-i`（`:26-32`）：PTY 上 stdin 就是终端，交互模式本来就会自动成立，
  而 `-l` 保持与今天 `exec sh -l` 的**登录 shell 语义**连续（远端 `~/.profile` / `~/.zprofile` 照旧加载，
  `PATH` 与 `ssh_workspace_exec` 看到的一致）。换成 `-i` 会让 `path_helper`（macOS）之类
  只在登录 shell 里跑的东西消失，是另一个 bug。
- **name**：basename 原样（`bash` / `zsh`），不要拼主机名——一个会话只属于一台主机，名字里带
  `@host` 只会让菜单变长；跨主机路径不一致由 §2.3 的回落兜住。
- **缓存**：`Map` 键 = `alias` + NUL + `engine.generationOf(alias).generation`
  （`lib/engine.js:362` 的 `generationOf`）。存**已 resolve 的 Promise**，让并发两次开菜单只探一次；
  reject 时立刻删键（与 `probeCapabilities` 只缓存"已确定"答案同一条道理）。重连后
  `generation` 改变，自然重探。

### 2.2 接管 `terminalController.shells()`（发现接进服务）

- 安装点在 `lib/index.js`，**紧跟现有终端注入块之后**（`:526-533` 那段 `ctx.inject(['subprocess'], …)`
  的下面，独立一个小节，用注释说明为什么不是塞进同一个 `inject`：那时
  `terminalController` 可能还没挂上）：

  ```js
  // 只需要 terminalController（被接管的对象）与 workingDirectory（判 ssh://）；
  // 不要写 'subprocess'——发现走 engine.exec，与 subprocess 服务无关，多一个依赖只会
  // 让安装时机被一个用不上的服务推迟。
  ctx.inject(['terminalController', 'workingDirectory'], (scoped) => {
    const shells = installShellDiscovery(scoped, { engine, logger: scoped.logger })
    if (shells === undefined) return
    scoped.effect(() => () => { uninstallShellDiscovery(scoped.get('terminalController')) }, 'ssh-workspace: remote shells')
  })
  ```

- **覆盖方式必须是 `Object.defineProperty`，不能赋值**。Cordis 的服务对象是 Proxy，
  `set` 陷阱会把赋值落到 shadow 上（`@deepseek-ai/cordis/lib/index.js:125-150`），
  而 `get` 用 `getPropertyDescriptor` **先查 target 自有属性**
  （`cordis/lib/index.js:75-81`），所以 own-property 覆盖对读取可见。照
  `lib/patch-terminal.js:466-471` 的写法：`INSTALLED` / `ORIGINAL` 两个 `Symbol.for`
  （命名空间沿用现有风格，例如 `@shiqyka/dsh-ssh-workspace/shells-installed`）。
- **包装体**（参数个数与顺序保持 `(agent, signal)`；虽然派发读的是原型上的 marker，
  见下，但保持一致更安全）：

  ```js
  // 顺序必须与 patch-terminal.js:453-458 一致：先取原始方法并 bind，再 defineProperty。
  // 反过来会把自己包住一次（自递归），症状是 shells() 栈溢出。
  const router = new RemoteShellsRouter({ engine, ctx: scoped, logger: scoped.logger })
  const originalShells = target.shells
  const localShells = originalShells.bind(target)
  // 闭包拿 ctx，不要用 `this`：网关是 `Reflect.apply(method, callReceiver, args)`
  // （dsh-api-gateway/lib/index.js:1213 + :1712），`this` 是那个 extend 过的 Context，
  // 不是 Service 实例。
  const shells = function (agent, signal) {
    const cwd = router.remoteCwdOf(agent)          // isRemotePath 判定，见下
    if (cwd === undefined) return localShells(agent, signal)
    engine.assertNotDisabled(cwd.alias, cwd.remotePath)   // 停用工作区：直接给 detach 文案，不浪费一次往返
    return router.discover(cwd.alias, { signal, candidates: target.config?.shellCandidates })
  }
  Object.defineProperty(target, 'shells', { value: shells, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(target, INSTALLED, { value: router, writable: false, configurable: true, enumerable: false })
  Object.defineProperty(target, ORIGINAL, { value: originalShells, writable: false, configurable: true, enumerable: false })
  ```

  `router.remoteCwdOf(agent)`：`ctx.get('workingDirectory').get(agent.session)`（`@deepseek-ai/dsh-working-directory/lib/index.js:25` 注册名是
  `workingDirectory`，`:76-78` 的 `get(session)` 是**同步、无 I/O**的投影读——正是宿主自己在
  `environment()`（`:787-791`）里用的那一条）。拿到的字符串再
  `agent.session.header.cwd` 兜一次；只有 `isRemotePath`（`lib/protocol.js:46`）为真时才走远端分支，
  `parseRemotePath`（`:30`）失败按本地处理（`lib/git-history.js:270` 的 `classifyCwd` 是同一个判据，可直接复用）。
- **为什么不会撞网关的 `ambiguous-endpoint`（必须写进代码注释）**：网关解析端点是
  `resolveDescriptor`（`dsh-api-gateway/lib/index.js:1224`）→
  `resolveSrcDescriptor`（`:1230`），其中 `collectSrcClaims`（`:895`）、
  `validateBinding`（`:1698`）、`readBinding`（`:1707`）、`methodParameterNames`（`:1715`）
  全部经 `originalOf(receiver)`（`:1711`）——即 `Symbol.for('…original')` 指向的**原始对象**——
  读**原型**上的 `REMOTE_METHOD_DESCRIPTOR`；我们只加了一个 own property，不新建
  `typertRemote`、不改命名空间、不改方法名。真正调用时是
  `Reflect.get(callReceiver, implementation)`（`:1212-1214`），`implementation === 'shells'`，
  own property 命中包装体。**这是替换既有端点的实现，不是新增端点**。
- **`spawn` 的间接收益**：`:984` 有 `shellPath` 时会在 `this.shells(agent, signal)` 里 find，
  现在拿到的是远端列表，所以 `terminal/create` 的 `shellPath` 校验也变正确了。
- 卸载：还原 `shells`（`ORIGINAL` 存在则 redefine，否则 `delete`），删掉 `INSTALLED`，
  与 `uninstallRemoteTerminal`（`lib/patch-terminal.js:482-493`）逐行同构。

### 2.3 `spawnTerminal` 采用 argv[0]（启动）——只在"已发现"集合内

改 `lib/patch-terminal.js:349` 那一行：

```js
const command = parts.remotePath === '/' ? `exec ${shellCommand}` : `cd ${quote(parts.remotePath)} && exec ${shellCommand}`
```

`shellCommand` 的决策：

1. `spec.argv` 是数组、`spec.argv[0]` 是非空字符串，且 `basename(argv[0])` 命中**本模块为这台主机
   发现过的 shell 集合**（由 §2.1 的 router 提供查表，键 `(alias, generation)`；查不到就是空集）→
   `shellCommand = [shellQuote(path), ...shellArgsFor(path)].join(' ')`；
   **args 用我们自己的规则，不用 `spec.argv.slice(1)`**（宿主的 `-i` / `-NoProfile`
   是它自己方言的产物，把它塞给远端 zsh 只会多一个陌生参数）。
2. 否则 → 今天的 `sh -l`，一个字节都不变。

这条规则是**白名单**，方向与 `lib/patch-subprocess.js:317` 的 `unwrapSandboxArgv` 一致：
只承认自己探到过的东西，其余一律回落，绝不猜测。

**一条必须写进注释的已知残留**：`spawn` 在 `request.shellPath === undefined` 时走的是
`resolveShell`（`:984`），拿到的仍是**本机**路径（`C:\…\pwsh.exe` 之类）。§2.3 的白名单会把它挡回去，
于是这类终端跑 `sh -l`——安全的降级，但意味着"没选 shell 直接开"的路径**不会**自动用远端默认 shell。
这是有意接受的：要修就得同时替换 `resolveShell` 的语义（那是宿主内部函数，不是端点），
收益只是一个默认值，成本是把本机路径塞进远端 argv 的风险。若日后要补，正确做法是在
`spawnTerminal` 侧补一条"argv[0] 是远端不存在的绝对路径 → 换成该主机 discovery 的首项"，
并单独加测试，不要在这里顺手改。

因此：

- `terminal_open`（`dsh-terminal-bash`，argv 为沙箱包装后的 `/bin/bash --noprofile --norc -i`，
  `dsh-terminal-bash/lib/index.js:965-972`）在远端**有** bash 时会跑 `bash -l`（更接近用户预期），
  在远端**没有** bash 时照旧 `sh -l`；
- `tests/terminal-smoke.mjs:105-106` 那条不变量（"pwsh argv → 仍 `sh -l`"）依然成立，
  因为 pwsh 不在远端发现集合里；
- 未发现过任何远端 shell（菜单没开过、或探测失败）→ 全体回落 `sh -l`，与今天完全一致。

## 3. 测试

### 3.1 新套件 `tests/remote-shells-smoke.mjs`

登记进 `tests/run.mjs` 的 `SUITES`，位置放在 `'terminal'` 之后。体例照抄现有套件（纯 ESM、
`check(name, ok, detail)` 累加、末行 `=== N passed, M failed ===`、失败退出码 1）。
用**假 engine + 假 terminalController**，不许连 SSH、不许碰 `~/.dsh`。

必要的分组断言：

1. 远端会话（`workingDirectory.get` 返回 `ssh://alpha/home/u/x`）→ 恰好**一次** `engine.exec`，
   脚本里对每个候选都有 `command -v`，并含 `dsh-shell:login` 与 `dsh-shells-done`。
2. 解析：`$SHELL` 那一支排第一；按 kind 去重（`/usr/bin/bash` 与 `/bin/bash` 只留一个）；
   候选名单顺序保持。
3. args：`zsh` / `bash` / `sh` → `['-l']`；`pwsh` → `['-NoLogo']`；`payload.exe` 之类非法候选被丢弃。
4. 本机会话（cwd `/home/u/proj`）→ 走 `localShells`，`engine.exec` **零次**。
5. 缓存：连续两次 `shells()` → 一次 exec；`generationOf` 返回新代次 → 再探一次。
6. 并发：两个未 resolve 的调用只产生一次 exec（共享同一个 in-flight promise）。
7. 探测失败（无完成标记 / 非零退出 / exec 抛错）→ **抛错**、不返回假列表、**不缓存**
   （紧接着重试会再 exec 一次）。
8. 停用工作区 → 抛 detach 文案且 `engine.exec` 零次。
9. 卸载还原：`uninstallShellDiscovery` 之后 `target.shells` 回到原实现（同
   `tests/terminal-smoke.mjs` 还原段的写法）。
10. `spawnTerminal` 采用 argv[0]：发现集合含 `/usr/bin/zsh` 且 `argv[0]` 为 `/usr/bin/zsh` →
    command 含 `zsh` 与 `-l`、**不含** `sh -l`；`argv[0]` 为 `pwsh.exe`（未发现）→ 仍 `sh -l`；
    发现集合为空 → 仍 `sh -l`。

### 3.2 必须一起改的既有测试 / 文档数字

- `tests/terminal-smoke.mjs`：现有 28 条里第 1 组（`:92-110`）断言「远端 PTY 一律 sh -l」。
  加 §3.1 第 10 条那三种用例后，`docs/development.md:259` 的行内断言数要同步
  （`npm run doc-numbers` 不数断言，`docs/development.md` 的断言列是真手写的，改完顺手核）。
- `docs/development.md`：新增 `remote-shells-smoke` 一行（照现有行的格式：套件名 / 依赖 / 断言数 / 覆盖点）。
- `tests/lifecycle-smoke.mjs:71` 的 `EXPECTED_ROUTES = 33` **不动**（本任务不加路由）；
  `lib/tools.js` 的工具数仍 11。
- `tests/upstream-contract-smoke.mjs` **不动**（见 §2.1：没有新的 `patch-*.js`）。

### 3.3 验证命令

```bash
node scripts/lint.mjs
node tests/remote-shells-smoke.mjs        # 新套件，逐条看
node tests/terminal-smoke.mjs             # 28+ 条，确认旧不变量还在
node tests/capabilities-smoke.mjs
node tests/capabilities-report-smoke.mjs
node tests/mode-gate-smoke.mjs
node tests/lifecycle-smoke.mjs
npm run doc-numbers                       # 重生成（会连带别的在改的线一起动，见 §5 第 3 条）
npm run check:docs
npm test                                  # 全量
```

**沙箱注意**：受限沙箱下 `spawnSync` 会 `EPERM`，`node tests/run.mjs` 会给出几十个假失败。
逐套件直跑 `node tests/<name>-smoke.mjs`，并在报告里注明哪几项是环境限制而非代码问题。

## 4. 文档与变更记录

- `docs/features.md:308-309`：`持久终端` 那行补一句「shell 由远端探测决定」；
  `方言不用本机的` 那行**改写**——它现在的措辞（"忽略宿主的 PowerShell argv"）在本任务后不再完整，
  应变成「宿主 argv 只在远端确实装了同名 shell 时被采用，否则回落 `sh -l`；宿主方言的
  `-NoProfile` / `-i` 一律丢弃」。
- `docs/architecture.md`：「能力探测与推送式变更监视」一节（`:479` 起）之后，用一小段说明
  `shells()` 的接管：为什么在插件侧、为什么用 own-property 而不是新端点、缓存键与失效条件、
  探测失败为什么必须抛错。
- `docs/ui.md`：终端相关段落补一句「新建终端的 shell 菜单列的是远端主机上真实存在的 shell」。
- `docs/troubleshooting.md`：`## 已知限制` 段加一条——浏览器偏好 `dsh.terminal.shell` 是**全局单值**，
  在两台路径布局不同的主机之间切换时会回落到该主机的默认 shell（这是宿主的行为，不是 bug）。
- `docs/optimization-and-future03.md:115`：「execution world / 配额没有 provider seam」那条补一句
  「插件目前以 own-property 接管 `terminalController.shells()` 实现远端 shell 发现；上游一旦提供
  provider seam，改为注册 provider 并删除该接管」。
- `CHANGELOG.md` 顶部 `## [未发布]` 的**修复**段追加一条（讲清"菜单列的是本机 shell、远端跑的是
  `sh -l`"这个不一致、以及修复后探测失败会显示 failed 而不是假列表）。
- `docs/README.md`：在 `verify/` 段按 `verify/pr6-review.md` 那行的格式加一行索引。

## 5. 硬约束

1. **不改宿主**：`node_modules/@deepseek-ai/**` 与 `F:\GitHub\.asar-full\**` 一字不动（后者是宿主包的完整解压镜像，`F:` 盘那份）
2. **不扩权**：不新增路由（`EXPECTED_ROUTES = 33`）、不新增 Agent 工具（仍 11 个）、
   不给 `ssh_workspace_status` 加字段（本任务不产生新的状态面）。
3. **不碰别人的改动**：工作树里已有未提交改动属于**另一条在改的线**（`ctx.sandbox.confine` 的
   workspaceRoot 本地化，以及 commit-history 那一串），开工前先跑 `git status --short` 自己确认，
   以当时的结果为准——本文写死清单会过时。已知涉及：
   `CHANGELOG.md` / `README.md` / `README.en.md` / `docs/commit-history.md` /
   `docs/development.md` / `docs/features.md` / `docs/architecture.md` /
   `docs/troubleshooting.md` / `lib/client.js` / `lib/index.js` / `lib/upstream-contract.js` /
   `tests/run.mjs` / `tests/commit-history-smoke.mjs`，未跟踪的 `lib/patch-sandbox.js` 与
   `tests/patch-sandbox-smoke.mjs`。只在需要追加的位置动，**不要回退**。
   注意 `lib/index.js`、`tests/run.mjs`、`docs/features.md`、`docs/architecture.md`、
   `docs/development.md`、`CHANGELOG.md` 两边都要改：新内容各自插在互不重叠的位置。
4. **不碰用户真实数据**：禁止卸载插件、禁止改 `~/.dsh/storages/*`、禁止删 `~/.dsh/sessions/`。
   要端到端验证就用 `DSH_HOME` 指向临时目录的 scratch 环境。
5. **诚实优先于可用**：探测不到就抛错让 UI 说 failed；**任何情况下都不许**返回一份未经验证的
   shell 列表。这条比"菜单总是能用"重要。
6. **不引入新的命令行面**：远端探测只跑 `command -v` 与 `printf`，不跑任何有副作用的命令。

## 6. 验收判据

- [ ] 新套件通过，且 §3.1 的 10 条断言各自有独立用例（不是一条大 `check`）。
- [ ] `terminal-smoke` 旧的「pwsh argv → `sh -l`」不变量仍绿，新增的「已发现 → 采用」用例绿。
- [ ] 手工验证（有可用主机时）：打开新建终端菜单，项数与远端 `command -v` 结果一致；
      选 zsh 后终端里 `echo $0` 显示 zsh；在**另一台**主机上打开菜单看到的是那台主机的列表。
- [ ] 断网 / 不可达主机：菜单显示 failed + 重试，**不显示本机 shell 名字**。
- [ ] `npm run check:docs` 在**本任务新增的位移之外**没有新的漂移
      （注意：`doc-numbers` 当前已因 §5 第 3 条那条在改的线报告 `modules 51→52`、`suites 86→87`；
      `npm run doc-numbers` 重生成即可，不要为了"修红"去回退别人的文件）。
- [ ] `node scripts/lint.mjs` 无新增警告。

## 7. 报告格式（实现完成后回给用户）

用下表逐条给结论，不要贴大段代码：

| 编号 | 期望 | 实际 | PASS/FAIL |
| --- | --- | --- | --- |

然后补三段：① 代码落点（`lib/xxx.js:行号`）；② 测试结果（套件名 + passed/failed + 是否有环境导致的
SKIP）；③ 剩余风险（至少写：探测缓存以 `generation` 为界，主机重装 shell 后要等重连或重启才刷新；
浏览器偏好是全局单值，跨主机切换会回落默认 shell；`terminal_open` 的 argv 采用会让远端 bash 用户
从 `sh` 变成 `bash`，这是一处**行为变化**，若因此发现 `dsh-terminal-bash` 的就绪协议对 bash 敏感，
应把 §2.3 白名单收窄为"仅浏览器终端"——用 `spec.env.DSH_SESSION_ID` 存在与否判断不了，
需要给 `spawnTerminal` 增加一条显式标记，届时另开任务）。
