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
  - **标题行就是折叠开关**：点「最近提交历史」标题，整块向下收到只剩这一行标题（`aria-expanded`
    同步、chevron 由向下旋转成向右、「仅显示最近的 20 条」与刷新按钮一并收起）；再点一次展开。
  - **折叠状态会被记住**：存在页面自己的 `localStorage`，键
    `dsh-ssh-workspace.commit-history.folded`（写 `'1'` / `'0'`）。重开 tab、刷新页面、重启宿主之后
    仍是上次的选择；只有 `'1'` 算折叠，其余值（缺失、`'0'`、被手改成别的）一律按展开——宁可多显示
    一次列表，也不要出现"提交历史莫名其妙不见了"。
  - 右上角一个刷新小按钮（加载中禁用）。
- 状态只有一行灰字，绝不报红、绝不弹 toast：
  - 加载中：`加载中…`
  - 空仓库：`没有提交记录`
  - 非 git 目录：`当前目录不是 Git 仓库`
  - 失败（SSH 断、超时、路由不可用等）：`提交历史暂不可用`，鼠标悬停时 tooltip 显示原因。
- tab 的标题、图标、顺序、tab 类型全部仍是官方的：**没有第二个 tab**，标题槽位没有被接管。

### 1.1 折叠是怎么做的

- 标题里放一个真正的 `button`（不是给 `h3` 挂 `onClick`）：Enter / Space 由平台处理，
  `aria-expanded` 描述状态，`:focus-visible` 有焦点框；
- 状态只有两个值 `collapsed` / 展开；**没有存储记录时默认展开**；折叠只影响这个区块，不写设置、
  不影响官方面板；
- 记住选择的是页面级 `localStorage`，不是宿主设置：值只是一个开关，没有要和 Host 同步或迁移的
  字段；读写在 `readHistoryFold()` / `writeHistoryFold()` 里各自吞掉异常（无存储的沙箱页、隐私模式
  拒绝访问、配额满），失败的方向是"回到展开"，绝不会因为存储出问题让点击失效或让 tab 崩掉；
- 视觉状态由一条样式规则承担：`[aria-expanded="false"]` 下 chevron `rotate(-90deg)`，
  两种状态共用同一个图形；`prefers-reduced-motion` 时关掉这段过渡；
- 显示什么由**一个**纯函数 `historyChrome(collapsed, truncated)` 决定（note / 刷新 / 正文），
  组件里不再分三处各写一遍 `collapsed ? …`；
- 折叠不改变数据流：请求照旧发出（展开时列表已在），收起刷新按钮也不会触发刷新。

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
    // 不声明 locale：官方文案的 t 座位从官方条目自己的命名空间绑定（见 2.3）
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
   `sshWorkspaceCtx` 外全部原样传递**，因此官方面板的变更请求、刷新、重连、滚动行为不变；
   `t` 是唯一的例外——它必须换成官方条目自己命名空间下的座位（见 2.3），透传我们的座位会让
   上半整块显示 i18n key。

### 2.3 t 座位取自官方条目自己的命名空间（本轮修复）

**先给结论：官方字典命名空间 ≠ 官方 TAB_ID。** 本部署实测，官方注册是
`name:'sidebar.right.pane.tab', key:TAB_ID, locale:NS`：`TAB_ID` 是包 id
（`@deepseek-ai/dsh-experimental-client-ui-forge`），`NS` 是另一份字典名（该包源码里
`export const NS = 'forgePanel'`）。渲染器按 `kit.t = localeSeat(face, entry.locale)` 合成
`t`，用的是**条目自己声明的那个命名空间**。

最初的实现按"同一个字符串"的假设，给自己的遮蔽注册也声明了包 id 作 `locale`，再把渲染器交给
我们的 `t` 透传给官方面板。后果是上半整块**原样显示 i18n key**（`checkout.project`、
`changes.local.title`、`changes.empty`、`changes.emptyHint`）：`bind('<包 id>')` 找不到字典，
按约定回退成 key 本身；而面板的功能一切正常——这正是"面板没坏、只是文案没了"的形态，容易被
当成官方样式。

现在的做法：

- 本插件的遮蔽注册**不声明任何 `locale`**（我们的文案全部走 `ourT`，不需要那个座位）；
- `officialTranslateSeat(ctx, entry)` 读 `entry.locale`（官方条目自己的字典名），调
  `ctx.locale.bind(ns)`，再把结果作为 `t` **覆盖**进官方面板的 props——覆盖在 props 里**排在最后**
  （`...officialProps` 与 `...split.rest` 之后），免得座位 kit 或官方注入面自己带的 `t` 又盖回去；
- `bind` 按命名空间记忆化、每次调用时解析当前语言，因此切语言不需要额外订阅；
- 官方条目没声明命名空间、或 locale 面绑不上时返回 `null`，此时**不做覆盖**——不会把
  `undefined` 塞进 props 把原本的座位弄没。

回归点：`tests/commit-history-smoke.mjs` 的 `[official copy seat]` 一节会把
`officialTranslateSeat` 切出来、用假 locale 面执行，断言绑的是 `forgePanel` 而不是包 id、占位符
原样透传、无命名空间时为 `null`、绑定抛错时降级为 `null`；另有一条静态断言要求覆盖排在
`...split.rest` **之后**（即 props 的最后一项）。

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

**这条边界不包含会话归属校验，也没有限流**，两点都写在这里以免被读成"有隔离"：

- `session` 是**调用方自报**的 id。路由不校验"这个会话是否属于当前窗口 / 当前用户"——
  单用户本机部署里没有第二个主体可校验，本插件也没有 GUI token 这一层。任何能打到
  `127.0.0.1:<port>` 且能通过 Host 头校验的调用方，都可以指定**任意**会话 id 读它 cwd 下的
  `git log`。真要有第二个主体（同一台机器的另一个 OS 用户、或转发进来的容器），
  它首先得能连上 loopback 端口；那是部署边界，不是这条路由的边界。
- **没有速率限制**。每次请求起一个 `git log` 子进程，上限 100 条、15 秒超时。GUI 只在展开
  与刷新时调用，实际频率低；但"能打到端口"就"能不限量打"，这一点在没有 GUI token 的部署
  里无法靠路由自身消除。

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
  5. 点标题行：「仅显示最近的 20 条」与刷新按钮消失、列表收起，只剩「最近提交历史」一行；
     再点一次恢复，chevron 从向右转回向下；
  6. **收起后刷新页面（F5）**：仍应保持收起（此时不需要重启宿主——折叠状态是页面存储，与 bundle
     版本无关）；再展开后刷新，应保持展开。DevTools → Application → Local Storage 里能看到
     `dsh-ssh-workspace.commit-history.folded` 在 `'1'` / `'0'` 之间切换；
  7. 换到一个非 git 目录的本地会话：下半显示「当前目录不是 Git 仓库」。
- 只想先验证路由（重启后、刷新前）：`curl 'http://127.0.0.1:52022/api/dsh-ssh-workspace/git-history?session=<id>&limit=20'`
  （该路由族仅接受 loopback / 本机地址与匹配的 Host 头）。

## 7. 验证记录

- `node --check` / `npm run lint`：全部模块通过。
- `node tests/commit-history-smoke.mjs`：**153 passed, 0 failed**（纯解析、假 subprocess 的
  路由分支、客户端结构断言、**selector-hook 形状的运行时行为测试**、**`officialTranslateSeat`
  的假 locale 面行为测试**、**`historyChrome` 折叠可见性矩阵**、**折叠状态的存储往返（真存取、
  `'1'`/`'0'`/垃圾值、读抛错、写抛错、完全没有 `localStorage`）**、本仓库真实 `git log` 解析）。
- **反向验证（实际执行，不是推断）**：五处变异各自只让对应的断言变红，改回后 `lib/client.js` 的
  sha256 与变异前逐字节一致 ——
  ① 把座位改回绑定包 id → `[official copy seat]` 里 5 条红（绑错命名空间 / 不是包 id /
  译文走错面 / 占位符 / 无命名空间时为 null）；
  ② 让 `note` 不再看 `collapsed` → `a folded strip shows nothing but the title` 红；
  ③ 去掉 `t: officialCopy` 覆盖 → `spread AFTER officialProps` 红；
  ④ 只读不写 / 把任何值都当折叠 / 挂载时写死为展开 → 分别是 2 / 2 / 1 条红；
  ⑤ 让存储异常逃出 `readHistoryFold` 或 `writeHistoryFold` → 各自恰好 1 条红
  （读抛错与写抛错必须分成两个 try，否则一条会盖在另一条的标签下——这条本身是写测试时踩出来的）。
- `node tests/client-shape-smoke.mjs`：**299 passed, 0 failed**（含 3.3 节所述断言的精确化）。
- 真机（`910b-05:/mnt/data/Codes/vllm-ascend`，分支 `fix/rwkv7-api-compat`）用与实际代码完全
  相同的 argv 实跑：21 条记录经 `parseGitLog(_, 20)` 得到 **20 行 + truncated=true**，首行
  `7f9fc618f`、末行 `a9fbe844a`，全部 sha 为 40 位十六进制、日期均为 `YYYY-MM-DD`。
- **2026-11-15 本轮全量**：裸检出 **79 passed / 1 partial / 6 skipped / 0 failed（86 suites，
  4260 项断言）**；装配树（`DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules`）
  **82 passed / 2 partial / 2 skipped / 0 failed（86 suites，4507 项断言）**。
- **未验证**：没有浏览器自动化，所以没有真实 DOM 渲染/视觉/滚动位置的截图级验证——折叠后的
  行高、chevron 旋转的观感、以及官方文案座位修复后的实际中文显示，都必须把 DSH 重启后按第 6 节
  逐条看一遍（客户端 bundle 只读启动时加载的那份文件，刷新页面不会重新读取）。

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

