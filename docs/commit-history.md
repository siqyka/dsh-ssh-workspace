# 「变更请求」tab 下半的「最近提交历史」

> 目标（用户原话）：在官方「变更请求」tab 里，**上半是原变更请求面板，下半是新加的「最近提交历史」**，
> 并且要"注入式"，不改官方包。
>
> 状态：已实现，客户端 + 宿主路由都是本仓库源码（`lib/`，无构建步骤）。本文记录接入方式、
> 槽位遮蔽原理、数据流、失效/回落策略、注销判据，以及**尚未验证**的部分。

## 1. 用户看到什么

- 右侧栏官方「变更请求」tab 打开后：上半仍是完整的官方面板（checkout 信息、本地变更卡片、
  变更请求列表、刷新/重连/合并等全部行为），下半多出一条分隔线与「最近提交历史」：
  - 每行：短 hash（等宽）、标题、第二行日期（YYYY-MM-DD）+ 作者；最多 20 行，超出时标题栏右侧
    显示「仅显示最近的 20 条」；
  - 该区块自己滚动（`max-height: 45%`），**不动**官方面板的滚动位置；
  - 右上角一个刷新小按钮（加载中禁用）。
- 状态只有一行灰字，绝不报红、绝不弹 toast：
  - 加载中：`加载中…`
  - 空仓库：`没有提交记录`
  - 非 git 目录：`当前目录不是 Git 仓库`
  - 失败（SSH 断、超时、路由不可用等）：`提交历史暂不可用`，鼠标悬停时 tooltip 显示原因。
- tab 的标题、图标、顺序、tab 类型全部仍是官方的：**没有第二个 tab**，标题槽位没有被接管。

## 2. 接入方式：同 key、更低优先级的槽位遮蔽

官方包把面板注册在**键控槽位** `sidebar.right.pane.tab` 上：

```js
// @deepseek-ai/dsh-experimental-client-ui-forge/lib/client.js:11667
ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
  name: "sidebar.right.pane.tab",
  key: TAB_ID,            // "@deepseek-ai/dsh-experimental-client-ui-forge"
  locale: NS,
  inject: tabFace,
}, ForgeTab));
```

同一份代码里 `TAB_ID` 同时是 `sidebarRightTabs.register({ id: TAB_ID, kind: "forge-panel", ... })`
的 tab 类型 id；侧边栏渲染 tab 体时按 `entryKey = definition.id ?? tab.kind` 派发
（`dsh-client-ui-sidebar-right/lib/client.js:1578`、`bodiesFor`/`titlesFor`），也就是派发到
`sidebar.right.pane.tab` 的 key `TAB_ID`。

我们的注册（`lib/client.js` 末尾 `apply()` 内）：

```js
slots.inject('sidebar.right.pane.tab', () => {
  const dispose = slots.register({
    name: 'sidebar.right.pane.tab',
    key: FORGE_TAB_KEY,                 // 与官方相同的 TAB_ID
    priority: FORGE_TAB_SHADOW_PRIORITY, // -100
    locale: FORGE_TAB_LOCALE,            // 官方命名空间（见 2.3）
    inject: () => ({ ourT: translate, sshWorkspaceCtx: ctx }),
  }, ForgeTabWithHistory)
  ...
})
```

### 2.1 为什么同 key 的更「低」优先级会赢

本部署的槽位核心（`dsh-web-frontend` 里的 `SlotCore`）对每一个 cell 保留所有注册，渲染时：

- 普通/键控槽位先按 `(priority ?? 0)` **升序**排序（bundle 中的比较器：
  `(f.options.priority??0)-(h.options.priority??0)`，错误文案亦写明
  *"register at a different priority to shadow it (lowest renders)"*）；
- `entriesOfSlot(key)` 取每个 cell 中**第一个仍存活的条目**（同 key 先出现者胜）。

官方注册没有写 `priority`（即 0），我们写 `-100`，于是：

- 官方条目**仍然存活**、仍可被 `ctx.slots.entries('sidebar.right.pane.tab')` 读到；
- 渲染我们的组件，官方组件由我们渲染（见 2.2）；
- 本仓库已有同样的先例：本插件的添加工作区流程用 `priority: -100` 遮蔽官方 `directoryFlow` occupant
  （`resolveBrowseFlow`，`lib/client.js`），原理、风险与写法一致。

> 注意：任务简报里写的是"更高优先级"，与本部署实测相反；以本部署 `SlotCore` 的排序为准：
> **数值更低者优先**。`-100` 两侧都安全（既低于 0，也不可能与后续动态注册的负优先级撞车到同值
> 之外）。

### 2.2 原样复用官方面板：从原始条目取 `component` + `inject`

官方条目被遮蔽后并没有消失。`ForgeTabWithHistory` 在每次渲染时：

1. `resolveForgeTab(ctx)` 用 `ctx.slots.entries('sidebar.right.pane.tab')` 找到同 key、非本组件、
   仍存活的原始条目（`entries()` 是原始注册视图，不是遮蔽后的 `entriesOfSlot`）；
2. `forgeFaceOf(entry, sessionId)` 调 `entry.inject(sessionId)` 拿到官方注入面
   `{ hooks: { panel, host, locale }, reconnect, refresh, remove, markReady, merge, ... }`，
   并按 (entry × sessionId) 用 `WeakMap` 缓存——官方 `tabFace()` 每次调用都产生新的回调身份，
   面板的流订阅绑定在这些身份上，逐次渲染重取会重启订阅；
3. `splitForgeFace()` 把 `hooks` 与普通 props 分开。关键细节：渲染器（`dsh-client-ui-renderer`
   的 `bindInjectSources` / `observableHook`）交给条目组件的**不是快照值，而是 selector hook
   函数**——官方面板自己会写 `usePanel((current) => current)`。所以这里由 `forgeHookFor()`
   按 `hooks` 源缓存并交出同形状的函数（内部 `useSyncExternalStore` + 选择器），而不是把快照当
   prop 传过去；`reconnect` / `refresh` / `merge` 等普通属性原样透传；
4. 渲染 `<div class="sshwsp-cr-official"><官方组件 {...官方应得的 props} /></div>`：
   props 是我们从槽位拿到的 session kit（`sessionId`、`useSessions`、…）+ 该槽位自己的注入
   （`useTabInfo` 等）+ owner props，加上第 3 步的官方注入。**除我们自己的 `ourT` /
   `sshWorkspaceCtx` 外全部原样传递**，因此官方面板的变更请求、刷新、重连、滚动行为不变。

### 2.3 为什么必须声明官方的 locale 命名空间

`t` 是渲染器交给条目的标准 prop，按 `entry.locale` 从 locale 服务绑定。官方面板的全部文案都
属于 `@deepseek-ai/dsh-experimental-client-ui-forge` 命名空间，所以我们这条注册也声明
`locale: FORGE_TAB_LOCALE`（常量值 = 官方 TAB_ID），把官方 `t` 透传给官方组件；插件自己的文案
另走 `ourT`（本插件 `dsh-ssh-workspace` 命名空间），两者互不混用。`ctx.locale.bind(ns)` 对未知
命名空间也只是回退成 key，不会抛异常；而本部署装有官方面板，它的字典在 boot 时已注册。

### 2.4 没有接管标题槽位

`sidebar.right.pane.tab.title` 的同 key 注册仍归官方（`ForgeTabTitle`）：chip 的图标与
「变更请求」文字不变，也不会出现两个同名 tab。接管标题在技术上同样可行，但没有必要——本功能
不改变 tab 的语义，只在其 body 里追加一段。

## 3. 数据流（Host 侧）

```
CommitHistorySection (client)
  GET /api/dsh-ssh-workspace/git-history?session=<id>&limit=20
    └─ routes.js  gitHistory（沿用该路由族的 loopback/Host 围栏与 writeJson 约定）
        └─ git-history.js readGitHistory()
            ├─ 解析会话工作目录（见 3.1）
            ├─ ctx.subprocess.spawn({
            │     argv: ['git','--no-pager','log','-z','--date=short',
            │            '--pretty=format:%H%x1f%h%x1f%ad%x1f%an%x1f%s',
            │            '-n', '<limit+1>', '--'],
            │     cwd, stdio:{stdin:'ignore',stdout:{maxBytes},stderr:{maxBytes}},
            │     graceMs, signal: AbortSignal.timeout(15000),
            │     env:{GIT_CONFIG_COUNT:'0',GIT_TERMINAL_PROMPT:'0',
            │          GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C',LANGUAGE:'C'} })
            ├─ 解析 stdout（NUL 分记录、0x1f 分字段）
            └─ 分类 stderr（非仓库 / 空仓库 / 真失败）
```

### 3.1 会话工作目录从哪来（安全边界）

只接受 `session` 与 `limit` 两个查询参数，**没有 path 参数**；目录一律取自宿主自己的会话记录：

1. `ctx.sessions.get(sessionId)` + `ctx.workingDirectory.get(session)`（权威值，会话 `cd` 过也正确）；
2. 取不到投影时回退 `session.header.cwd`；
3. 会话未 attach（例如宿主重启后仅持久化）时，`ctx.sessionQuery.listSessions()` 里按
   `header.id` 找 `header.cwd`；
4. 仍找不到 → `400 { code: 'session-unavailable' }`。

工作目录再分类：`ssh://<alias>/<abs>`（remote，走插件已接管的 `ctx.subprocess` 桥，在远端执行）
或绝对本机路径（local，本地执行），其它一律 `400 { code: 'invalid-cwd' }`。

因此命令执行面是封闭的：`argv[0]` 固定 `git`；唯一的变量是 `-n <被夹到 1..100 的整数>`；
`cwd` 只可能来自该会话自己的记录。路由族原有的 loopback / Host 头 / 方法围栏（403/405）照旧，
POST 一律 405。

### 3.2 解析契约

- `-z`：git 用 NUL 分隔记录；`--pretty=format:` 里的 `%x1f` 分隔 5 个字段
  （`%H` `%h` `%ad` `%an` `%s`）。subject 里出现 0x1f 时把剩余字段 join 回去，不截断标题；
  记录字段不足 5 个或全 sha 不是十六进制 → 丢弃该记录（不误渲染）。
- `-n limit+1`：多取一条即可判断"还有更多"，无需第二条命令；返回 `truncated`。
- `LC_ALL=C` / `LANGUAGE=C` 是**协议的一部分**：错误分类按英文短语匹配，而远端主机可能是中文
  locale（实测 910b-05 默认中文，`git log` 的 `fatal: 不是 git 仓库` 会让英文匹配失效）。
- 非 git 仓库、空仓库都算**成功**的空结果（`notRepository: true` / `commits: []`），不是错误。

### 3.3 响应形状

| 情况 | HTTP | body |
| --- | --- | --- |
| 有提交 | 200 | `{ commits:[{sha,shortSha,date,author,subject}], truncated, cwd, world }` |
| 非 git 仓库 | 200 | `{ commits:[], truncated:false, notRepository:true, cwd, world }` |
| 空仓库 | 200 | `{ commits:[], truncated:false, cwd, world }` |
| 参数/session/目录非法、git 失败、spawn 失败 | 400 | `{ error, code }` |
| 非 loopback / Host 头不符 / 非 GET | 403 / 403 / 405 | 与路由族其它端点一致 |

## 4. 失效与回落策略

| 失效点 | 行为 |
| --- | --- |
| 宿主还没重启（新路由未注册） | `fetch` 得到 404，客户端显示一行灰字「提交历史暂不可用」；官方面板完全正常 |
| 官方 ForgeTab 条目不存在（forge 未安装 / 改 key） | 不渲染官方面板，只显示灰字「官方面板不可用」+ 历史条；见第 5 节的注销判据 |
| 官方条目存在但注入面含 `keyedHooks`（形状变了） | 视为不支持，不猜测怎么传，同样进入第 5 节流程 |
| 非 git 目录 / 空仓库 | 200 + 空结果，一行灰字，不报错 |
| SSH 断、超时（15s）、工作目录消失 | 400 + 原因 → 一行灰字（tooltip 带原因），**不重试**、不弹 toast |
| 远端未装 git | 远端桥返回 exit 127 + 安装提示 → 400 `git-failed` → 灰字 |
| 工作区被 detach | 远端桥 `assertNotDisabled` 抛错 → 400 `spawn-failed` → 灰字 |
| 官方面板自身崩溃 | 我们的条目会因渲染错误被槽位边界"让位"（abdicate），官方条目重新成为该 cell 的赢家：tab 回到原样，历史条消失。这是安全方向 |

## 5. 注销判据（什么时候删掉这个遮蔽）

**注销判据（任一成立即删）**：

1. 官方包为 ForgeTab 增加正式的扩展槽位（例如面板内声明 children slot 供第三方注册区块）——
   那就直接注册进去，删掉整个遮蔽与 `resolveForgeTab` / `forgeHookFor`；
2. 槽位核心提供"让位给下一个 occupant / 组合多个 occupant"的公开 API——用官方语义表达
   "官方面板 + 追加区块"，不再手工渲染官方组件；
3. 官方 ForgeTab 的注册 key、`locale` 或注入面形状改变（尤其是出现 `keyedHooks`、`hooks` 改名、
   inject 不再返回 `hooks`）——本实现的兼容层会失效。**升级后自检**：打开「变更请求」tab，
   若看到「官方面板不可用」一行 → 说明兜底已触发；5 秒后若遮蔽自动撤掉、tab 恢复成官方样子，
   说明注销判据 3 命中，应删除本功能而不是修补猜测。
4. 本插件不再需要「变更请求」语义（例如用户明确要求移除该注入）。

兜底本身也是注销路径：`ForgeTabWithHistory` 在**无法渲染官方面板**时启动 5 秒宽限
（`FORGE_TAB_GRACE_MS`）；宽限到点仍找不到可用的官方条目（或形状不可用），就调用
`forgeTabShadowDispose` **注销我们自己的注册**，把 cell 交还官方 occupant / 侧边栏的
"nothing can view this" 提示。boot 顺序不需要这个宽限（两个注册都远早于用户能打开 tab），
它只用于真正升级后形状变化的场景。

## 6. 怎么生效、用户怎么确认

- **必须重启宿主**：新增的是 Host 侧路由（`lib/routes.js` + `lib/git-history.js`）。本部署
  Host 的 hmr `root: []`，`systemctl restart dsh-web` 后新路由才存在（本次交付**没有**重启，
  以免打断会话）。
- 重启后**刷新页面**即可（客户端 bundle 由 host 按文件内容重算 rev；`lib/client.js` 的改动刷新
  即生效，不需要清缓存）。
- 确认步骤：
  1. 打开一个远程工作区会话（如 `ssh://910b-05/mnt/data/Codes/vllm-ascend`）；
  2. 打开右侧栏「变更请求」tab；
  3. 上半应看到官方 checkout / 变更请求内容（与之前完全一致），下半出现「最近提交历史」，
     首行应为 `7f9fc618f  Merge branch 'feat/rwkv7-standalone-support' into fix/rwkv7-api-compat`
     以及 `2026-10-22 · diannaojiang`；
  4. 标题栏右侧应有「仅显示最近的 20 条」；点刷新按钮列表重新加载；
  5. 换到一个非 git 目录的本地会话：下半显示「当前目录不是 Git 仓库」。
- 只想先验证路由（重启后、刷新前）：`curl 'http://127.0.0.1:52022/api/dsh-ssh-workspace/git-history?session=<id>&limit=20'`
  （该路由族仅接受 loopback / 本机地址与匹配的 Host 头）。

## 7. 验证记录

- `node --check` / `npm run lint`：全部模块通过。
- `node tests/commit-history-smoke.mjs`：**122 passed, 0 failed**（纯解析、假 subprocess 的
  路由分支、客户端结构断言、**selector-hook 形状的运行时行为测试**、本仓库真实 `git log` 解析）。
- `node tests/client-shape-smoke.mjs`：**299 passed, 0 failed**（含 3.3 节所述断言的精确化）。
- 真机（`910b-05:/mnt/data/Codes/vllm-ascend`，分支 `fix/rwkv7-api-compat`）用与实际代码完全
  相同的 argv 实跑：21 条记录经 `parseGitLog(_, 20)` 得到 **20 行 + truncated=true**，首行
  `7f9fc618f`、末行 `a9fbe844a`，全部 sha 为 40 位十六进制、日期均为 `YYYY-MM-DD`。
- `npm test`：在**本次提交的父提交**上是 77 passed / 0 partial / 6 skipped / **1 failed**
  （84 suites），唯一失败是 `doc-numbers-smoke`——`docs/development.md` 的生成区还没跟上本次
  新增（HTTP 路由 31→32、`lib/` 模块 49→50），且新套件尚未登记进 `tests/run.mjs`。两处随本提交一并处理：
  `commit-history` 已登记进 `tests/run.mjs`，并用 `node scripts/doc-numbers.mjs` 重新生成后
  实测 **79 passed / 1 partial / 6 skipped / 0 failed（86 suites）**，其中 partial 是 live-gated
  套件的跳过，不是失败。
- **未验证**：没有浏览器自动化，所以没有真实 DOM 渲染/视觉/滚动位置的截图级验证；新路由在
  **运行中的宿主**上的端到端调用（需重启后按第 6 节确认）；远端桥接这条具体 argv 的实跑
  （同一桥已被 `workspace-changes` 的 git 调用验证，argv 均为纯 ASCII 固定形状）。

### 7.1 关于 `client-shape-smoke` 断言的精确化（不是绕过测试）

`tests/client-shape-smoke.mjs` 原先有一条历史断言：

```js
check('the plugin no longer registers a right-sidebar tab type',
  !/sidebarRightTabs/u.test(source) && !/sidebar\.right\.pane\.tab/u.test(source), ...)
```

它是当年"删掉本插件自己的右侧文件浏览器 tab"时立的锚点，**意图**是防止"本插件又注册一个
tab 类型 / 自造 cell"。新需求必须在**同一个同 key 的 cell** 里遮蔽官方条目，字面上必然出现
`sidebar.right.pane.tab`，所以整句禁止会与需求直接冲突。改法是保留原意图、把两件事拆开：

- `(a)` 仍禁止 `sidebarRightTabs`——本插件不得注册自己的 tab 类型；
- `(b)` 只允许**恰好一个** `sidebar.right.pane.tab` 注册体，且其 `key` 必须是官方 forge 的
  `FORGE_TAB_KEY`（即官方 `TAB_ID`）。

这不是把断言删空或注释掉，而是把它拆成"tab 类型"与"已有 cell 的遮蔽者"两条更精确的检查；
`docs/commit-history.md`（本文）就是给后来者的解释：**如果未来有人把 (b) 放宽成"任意 key"，
那就是真的绕过了这条回归锚点**。

## 8. 文件与登记

| 文件 | 作用 |
| --- | --- |
| `lib/git-history.js` | 固定 argv、解析、错误分类、会话目录解析、结构化结果（可单测，无 Host 依赖） |
| `lib/routes.js` | `GET /api/dsh-ssh-workspace/git-history`（复用该路由族的围栏与响应约定） |
| `lib/client.js` | 槽位遮蔽、官方面板复用、历史区块与样式、locale 文案 |
| `tests/commit-history-smoke.mjs` | 三层回归：纯解析 / 路由（假 subprocess）/ 客户端结构 + 真实 git |
| `docs/commit-history.md` | 本文 |

