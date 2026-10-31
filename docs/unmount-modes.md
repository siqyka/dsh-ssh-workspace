# 工作区卸载：停用、归档与重新启用

> 状态：**已实施**（见 CHANGELOG 的 0.2.4 段落）。本文描述的 `detach` /
> `enable` 两条路径、归档语义与全局停机围栏均已落地并通过测试。

一句话定位：**「卸载」不删除任何东西——它让工作区停用（读写执行全停），
默认连工作区记录和会话一起保留，随时可以一键启用回来。**

---

## 一、结论先行

| 问题 | 答案 |
| --- | --- |
| 卸载做了什么？ | 摘挂载 + 标记停用（`detach` 到此为止） |
| 会话被删了吗？ | **没有**。`deregister` 才归档，且归档只是从会话列表隐藏，文件与工作区记账位置都保留 |
| 工作区记录还在吗？ | 默认在（`detach` 模式），所以侧边栏那一行仍然可见（置灰） |
| 卸载后还能连上远程吗？ | SSH 连接保留（主机面板、`ssh_workspace_exec` 不带 cwd 仍可用）；**工作区内的读写、列目录、命令、终端、子进程、传输全部拒绝** |
| 重启后会不会自己复活？ | 不会。停用清单持久化在 store 里，启动恢复循环会跳过 |
| 用到了别的插件吗？ | 没有。归档走 DSH 原生 `workspaceRegistry.archiveSession()` |

---

## 二、两种模式的语义

`POST /api/dsh-ssh-workspace/unmount` 与 `ssh_workspace_unmount` 工具共用同一套模式：

| 模式 | 摘挂载 | 停用标记 | 工作区记录 | 侧栏那一行 | 面板那一行 | 会话 | 可恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `detach`（默认） | ✅ | ✅ | **保留** | 保留，置灰**且按钮不可点** | 保留，可「启用」 | **保留，不归档** | ✅ 一键启用 |
| `deregister` | ✅ | **清除** | 删除 | **消失** | **消失** | 归档 | 会话可取消归档，记录需重新挂载 |

默认是 `detach`，因为它是唯一「一次点击就能回来」的模式。请求体里的
`deregister: true` 仍被识别为 `deregister` 模式，避免旧调用方静默降级。
`forget` 作为旧拼写被接受，**归一化**为 `deregister`——两者做的是同一件事，保留一个
近乎重复的第三种模式，正是「面板能为一台已不存在的记录提供启用按钮」这个缺陷的成因。

### 归档跟随「删除记录」，不是一个独立开关

这是本文最容易搞反的一条，也是实际返工过的地方。

`detach` **保留**工作区记录，所以侧边栏那个分组仍在。分组里的东西就是它的会话——把
会话归档等于把用户**特意保留**的那个分组清空：行还在，点开却是空的。这不叫「保留」，
比直接删掉更让人困惑。因此：

| 请求 | 归档 | 理由 |
| --- | --- | --- |
| `detach`（默认） | 否 | 记录与会话一起保留，分组保持原样 |
| `deregister` | 是 | 记录已删，分组即将消失，会话不再有任何归属处 |
| 显式 `archiveSessions: true/false` | 按给定值 | 显式意图优先，允许「保留记录但隐藏会话」这类少见组合 |

旧实现把默认值写成 `archiveSessions !== false`（即默认归档），于是不勾选「同时删除工作区
记录」也会把会话藏起来。测试已经把这条钉死：`detach archives nothing, so the kept group
stays populated`，反向验证过去掉默认值后该断言变红。

### `deregister` 必须两边一起删

「同时删除工作区记录」的验收口径是：**侧栏那一行与面板那一行都必须消失**。

- 删掉工作区记录 → 侧栏那一行消失（这是 DSH 自己的行为）；
- 面板的「已停用」分区由**持久化的停用标记**驱动 → 标记不清，这一行就还在。

只删记录、不清标记会留下一个「面板里挂着启用按钮、实际任何地方都不存在」的工作区，
而这个路径的运行时围栏又拒绝一切操作——用户将无从恢复。所以 `deregister` 会同时清掉
**持久清单**与**运行时围栏**两处标记。这一条有回归测试（`routes-smoke`，含反向验证：
把清除逻辑去掉后 4 条断言变红）。

---

## 三、卸载时到底发生了什么

### 1. 摘挂载 + 打停用标记

```js
// lib/routes.js unmount handler
const wasMounted = router.disableRoot(workspacePath)
engine.store.entryStore.disableWorkspace(workspacePath)
```

`disableRoot` 做两件事（`lib/remote-fs.js`）：

- 从 `roots` 集合里删掉 → 不再受写围栏保护
- 加入 `engine.disabledWorkspaces` → 进入**全操作停用围栏**

顺序是刻意的：如果先打停用标记再摘根，两步之间会存在一个「既在服务又已停用」
的窗口，围栏答案取决于检查顺序。`disableRoot` 一次做完，不留中间态。

### 2. 归档会话（仅 `deregister`）

`detach` 到此为止，**不进行这一步**——它保留了工作区分组，所以会话必须留下。

```js
// lib/routes.js archiveWorkspaceSessions
for (const sessionId of entity.sessionIds ?? []) {
  await registry.archiveSession(sessionId)
}
```

用的是 DSH 原生 `WorkspaceRegistry.archiveSession()`，语义（读自宿主实现）：

- 会话 id 进入 **registry 全局的 `archivedSessionIds`**，从所有会话分组界面消失
- 会话文件**原封不动**
- 工作区记账槽位（`sessionIds`）**不清理**，所以 `unarchiveSession` 能把会话放回原位
- 同一笔写入里顺带清掉置顶（归档与置顶互斥）
- 有正在跑的工作时默认**拒绝**并抛 `WorkspaceActiveSessionError`，`activity` 里写明
  是 turn / subagent / job / schedule 哪一类

最后一条决定了实现细节：**逐个归档、失败不中断**。

```js
} catch (error) {
  failed.push({ sessionId, error: ... })
}
```

一个正在跑回合的会话被拒绝，不应该让整批归档失败。路由把成功的放进 `archived`，
失败的放进 `archiveFailed` 并逐条带原因，面板会把失败数量单独提示。

**为什么不传 `stopActivity: true`**：那会强停用户正在跑的回合。卸载工作区不等于
要求中止正在进行的对话，所以这里保守——拒绝、报告、让用户自己决定。

### 3. 可选地删除工作区记录

```js
if (mode !== 'detach') {
  await registry.delete(entity.id)
  // 两边标记一起清，见 §二
  router.enableRoot(workspacePath)
  engine.store.entryStore.enableWorkspace(workspacePath)
}
```

`registry.delete()` 的文档明确写着 **"retaining its directory and every session log"**，
所以它只删登记，不碰会话文件。这也是为什么本插件**没有**「删除会话」这个选项：
DSH 没有公开的会话删除 API，绕过服务层直接 unlink 会话日志会留下孤儿数据
（用户的磁盘上已经有 7 个这种孤儿了）。

---

## 四、停用围栏：除 SSH 连接外全部不可用

### 为什么不能只挡住写

停用状态用一个集合表示（`engine.disabledWorkspaces`），任何**位于其中的路径**
都被拒绝。这里区分三种"不可用"：

```
路径在 stopped workspace 内  →  全部拒绝（读、写、列目录、监视、命令、传输）
路径在已挂载 workspace 内    →  允许（写还额外受 mounted-root 围栏）
路径不在任何 workspace 内    →  保持历史行为（可读，写在围栏外被拒）
```

第三种是刻意保留的：挂载之前用 `ssh_workspace_exec` 探查远程目录是插件的核心
工作流，把它也封掉会让「先看看再挂载」变成不可能。停用标记与这个场景是两回事。

### 检查点（全部在连接之前）

| 层面 | 位置 | 覆盖 |
| --- | --- | --- |
| `ctx.fs` | `remote-fs.js` `#assertEnabled` | `stat` / `lstat` / `readText` / `streamText` / `readBytes` / `readByteRange` / `listDir` / `watch` / `writeText` / `editText` |
| 内建 fs 桥 | `fs-shim.js` `assertNotDetached` | `readdir` / `open` / `mkdir` / `rm` / `copyFile` 目标 |
| shell | `patch-shell.js` | 任何 `ssh://` workdir |
| subprocess | `patch-subprocess.js` | glob / grep / git |
| terminal | `patch-terminal.js` | `spawnTerminal` |
| HTTP | `routes.js` | `transfer` / `download` / `upload` |
| 工具 | `tools.js` | `ssh_workspace_transfer`、`ssh_workspace_exec` 的 cwd |

`streamText` 与 `watch` 返回 Promise，所以拒绝走 `Promise.reject` 而不是同步抛出，
与 `fs-local` 的行为一致。

### 为什么 `stat`/`lstat`/`realpath` 在桥里不挡

这三条在 `fs-shim` 里是**故意放行**的，理由不是遗漏：

DSH 的 workspace registry 用它们做**身份探针**——它对每个会话的 cwd 做 `realpath`
和 `stat`，据此判断会话是否仍属于它的工作区。如果这里失败（而不是明确 miss），
registry 会把会话从工作区记账里**剪掉**。

> 卸载一个工作区，不应该顺手改写它的会话归属。

所以桥里只挡**读内容**和**改东西**的操作，身份探针照常。`ctx.fs` 层的 `stat`
仍然是拒绝的（那是内容访问的入口），两者面向的调用方不同。

### 明确不拦的：SSH 连接本身

- 主机面板：连接、测试、断开、`ls` 目录浏览
- `ssh_workspace_exec` **不带 cwd** 或 cwd 在工作区之外
- 端口转发（它绑定的是连接，不是工作区路径）

这是"除 SSH 连接外"的字面实现：连接是资源，工作区是授权。

---

## 五、置灰与启用

### 侧边栏置灰

复用现成的 `passRemoteMarks()`（`lib/client.js`）——它本来就在遍历
`[data-row-key^="workspace:"]` 做图标替换：

```js
const detached = remoteMarks.disabledIds.has(id) || remoteMarks.disabledTitles.has(title)
if (detached) row.setAttribute('data-sshwsp-disabled', '1')
else if (row.hasAttribute('data-sshwsp-disabled')) row.removeAttribute('data-sshwsp-disabled')
```

**会话行也必须一起标记**，这是曾经漏掉的一半。会话行是
`[data-row-key^="session:<id>"]`，**它不携带任何工作区信息**——只有会话 id。
所以成员关系必须在还持有工作区时解析：

```js
for (const sessionId of Array.isArray(item.sessionIds) ? item.sessionIds : []) {
  disabledSessionIds.add(String(sessionId))
}
```

服务端 `/status` 因此必须带 `sessionIds`（`lib/routes.js`），否则客户端拿到的工作区
条目没有成员列表，只能把标题那一行置灰，而它下面的每个会话仍然完全可点——工作区
的 I/O 围栏已关，会话却是活的，这是最糟的组合。

配套 CSS 分两层，作用域按行键区分：

```css
/* 通用层：任何被标记的行都变暗 */
[data-sshwsp-disabled="1"] { opacity: 0.5; }
/* 电源图标只给工作区标题：给每行会话都盖一个，读起来像"N 个开关" */
[data-row-key^="workspace:"][data-sshwsp-disabled="1"]::after { content: "⏻"; ... }
/* 工作区标题的按钮失效，但标题本身仍可点 */
[data-sshwsp-disabled="1"] button,
[data-sshwsp-disabled="1"] [role="button"] { pointer-events: none; opacity: 0.4; }
/* 会话行整行不可达：行本身就是"打开会话"那个控件 */
[data-row-key^="session:"][data-sshwsp-disabled="1"] { pointer-events: none; cursor: not-allowed; }
```

**工作区标题不拦点击**。拦截 DSH 自己的行点击处理器属于和宿主抢控制权，它一改版就崩。
展开标题仍然可用——那是用户看清「停用保留了哪些会话」的唯一途径。真正的入口是插件
面板里的「启用」按钮。

**会话行整行拦**，因为这里的情况不同：行本身就是点击目标，只把里面的按钮置灰会把
唯一要紧的动作留着。键盘路径由 `setElementInert()` 补上（`pointer-events` 只挡鼠标）。

身份匹配需要 id 与标题两套集合，因为不同界面给的信息不同。这里有个容易踩的坑：
`readLiveWorkspaces()` 会从 DSH 自己的 store 重新收集身份，而那个 store **不知道**
本插件的停用清单。所以停用路径单独存在 `knownDisabledPaths` 里，每次重新收集时
传回去，否则置灰会在下一次变更回调时消失。会话成员列表同理——DSH 的 store 里
每个工作区视图都带 `sessionIds`，重新收集时一并取，不会丢。

### 启用

`POST /api/dsh-ssh-workspace/enable`（或 `ssh_workspace_enable`）：

```
1. 校验远端目录仍然存在（否则启用会得到一个「看起来在服务、实际 ENOENT」的工作区）
2. router.addRoot()          → 重新挂载，顺带清掉停用标记
3. store.enableWorkspace()   → 持久清单里删掉这一条
4. registry 有同 path 的实体就复用，没有就 createCanonical
5. 逐条 unarchiveSession()
```

第 5 步与归档对称：失败的逐条报告，不整体失败。

---

## 六、持久化

停用清单写在**共享的** `$DSH_HOME/dsh-ssh.json` 的 `workspaces` 分区：

```jsonc
{
  "version": 1,
  "hosts": [...],
  "knownHosts": {...},
  "secrets": {...},
  "forwards": { "settings": {...}, "items": [...] },
  "workspaces": {
    "disabled": ["ssh://qiyk/home/qiyk/test"]
  }
}
```

几个约束：

- **只接受 `ssh://` 路径**（`normalizeDisabledPath`）。本地路径进这个清单没有意义，
  插件从不挂载本地目录，接受它只会让清单变成垃圾场。
- **去重、幂等**。双击「卸载」不会写入两条。
- **读坏了退化成空清单**。`workspacesOf()` 对任何脏数据返回 `{disabled: []}`——
  最坏后果是重新挂载一个用户原本停用的工作区，而不是整个主机列表读不出来。
- **沿用 `withFileLock`**。和其它分区一样走共享文件锁，两个 DSH 实例不会互相覆盖。

启动时（`lib/index.js`）清单**在最前面**读入，不等 registry：

```js
detachedWorkspaces = engine.store.entryStore.workspaces().disabled
engine.setDisabledWorkspaces(detachedWorkspaces)
```

放在 registry 注入里就太晚了——shell / subprocess / terminal 三条缝不等 registry，
它们会在那之前就已经能跑命令了。之后 registry 注入时用同一份清单跳过重新挂载：

```js
if (detachedSet.has(path)) continue
```

没有这一行，用户点「卸载」→ 重启 → 工作区自己活了。

---

## 七、测试

新套件 `tests/detach-smoke.mjs`（**73 项**）覆盖：

| 分组 | 内容 |
| --- | --- |
| store 分区 | 新增/去重/删除/本地路径拒绝/脏数据退化/跨分区不互相覆盖 |
| 包含判定 | 自身、子路径、前缀相似的兄弟目录、别的 alias、父目录、畸形条目 |
| `ctx.fs` 围栏 | 10 个方法逐个断言被拒 + 错误信息点名"detached" |
| 重新启用 | `enableRoot` 与 `addRoot` 都能清掉标记 |
| 命令缝 | shell / terminal 被拒，且**没有任何连接被打开** |
| 边界 | 工作区外的 cwd、别的 alias 必须照常可用 |
| 自反性 | 启用 / 重新挂载**不得**经过围栏探测（见下） |

最后一条记录了一个真实的实现陷阱：`ssh_workspace_mount` 与 `ssh_workspace_enable`
都要先确认远端目录存在，最自然的写法是用 `engine.fs.stat()`——但 `engine.fs`
**正是那层围栏**，它会拒绝停用工作区内的任何读取，于是「启用」在结构上永远失败。
两处都改为走原始连接（`engine.withSftp`）直接 `stat`，与 HTTP 路由的做法一致。

`routes-smoke` 现在 **176 项**（本组增加 22 项：模式默认值、`detach` 不归档而
`deregister` 归档、显式 `archiveSessions` 优先于模式、归档成功/失败上报、
`deregister: true` 兼容、启用流程、两条新路由的回环围栏；此后下载失败的状态码
修复又加了 3 项），其中 3 项钉住 `/status`
必须下发 `sessionIds`：成员列表原样透传、强制转成字符串（会话行按文本匹配 id）、
缺字段退化为空数组而不是 `undefined`（旧宿主可能整个省略）。

`client-shape-smoke` 另加一组**行为**测试，而不只是字符串匹配：它把真正的
`collectRemoteWorkspaces` 抽出来运行，断言停用工作区的会话进入 `disabledSessionIds`、
在服务中的工作区会话**不**进入、缺 `sessionIds` 的工作区不抛错。原来的 bug 是漏了
一条赋值，不是漏了一个名字——grep 名字抓不到它。

同一套件还新增**语法检查**：所有其它断言都把 bundle 当**文本**读，所以一个根本
解析不过的文件照样能让它们全绿——这真的发生过（CSS 模板字符串里一个游离的反引号
提前结束了字面量）。`node --check` 只解析不执行，保持零依赖。

`client-shape-smoke` 新增一组覆盖「置灰的行必须真的不可操作」：`pointer-events`
规则存在、选择器是通用的 `button`（那些按钮是 DSH 画的）、工作区标题本身仍可点击
（否则 `detach` 保留的会话就没法看清有哪些）、会话行整行不可点、键盘路径也被摘掉
（`inert` + `tabindex`）、以及撤销时恢复原有属性值而不是一律删除。

同一套件还钉住**悬停提示**这个唯一的说明渠道：中文提示必须同时写出「未勾选 → 记录与
会话都保留」和「勾选 → 记录删除、会话归档」两个分支；英文提示按**自身文本**校验
（`archived` 在别的键里也出现，按整包 grep 会让「只写了可逆那半」的英文提示蒙混过关）；
提示必须同时挂在「卸载」与「确认卸载」两个按钮上（后者出现时前者的 `title` 已经不在
视野里）；且不得在行内另起一行重复同一句话。三条都反向验证过：放回旧文案后 2 条变红，
把常驻行加回去后「not duplicated」变红。

全套：`node tests/run.mjs` 当前 **44/44** 套件。裸检出（无环境变量）下 38 个套件运行、
合计 **1733** 项断言（实测 2026-10-31）；`lifecycle` / `boot` / `tool-schemas` / `projection-real` 与
`live` / `acceptance` 共 6 个套件需要 `DSH_CORE_ROOT` 或真实主机，未提供时明确 SKIP
（`DSH_CORE_ROOT` 指向真实装配树时这 6 个跑起 4 个，合计 **1956** 项；只剩 `live` / `acceptance` 两个套件真正未跑，但 `boot-smoke` 会为它自己那段需真机的远端检查打一行 SKIP，而 runner 是按“有没有 SKIP 行”判定套件状态的，所以尾行会写成“41 passed, 3 skipped”；「跳过套件数」与「SKIP 行数」是两个不同的量，见 [development.md](./development.md)）。
（其中 `tool-schemas` 单独是 160 项 schema 断言，`lifecycle` 16 项、`boot` 29 项——别把这几个套件当成「合计 160 项」。）本组相关的 `probe-smoke` 20 项、`detach-smoke` 73 项。

---

## 八、相关

- [forward-persistence.md](./forward-persistence.md) — 端口转发的持久化，同一套
  「意图 vs 事实」模式
- [architecture.md](./architecture.md) — 各条缝的接管点
- [tools.md](./tools.md) — `ssh_workspace_unmount` / `ssh_workspace_enable` 的参数
