# 更新日志

本文件记录 dsh-ssh-workspace 的版本变更。0.1.16 之前的版本为未公开的本地迭代，未收录。

## [未发布]

### 新增

- **测试骨架与基线治理（`tests/support/`，零依赖）**：裸检出上「远端读写」长期没有可跑的覆盖——`writeText` / `editText` / `listDir` / 原子发布 / 版本冲突这些**成功路径**只在 `live` 套件里跑，而它需要一台真主机。本轮补的是替身与收敛，不是「优化测试」：
  - **内存 SFTP（`fake-sftp.mjs`）**：按**服务器**的行为作答而不是当 mock——`rename` 撞已有目标必须失败（SFTP 规范如此，否则 `publishRename` 的回退分支永远测不到）、默认通告 `posix-rename`（关掉才走非原子回退）、父目录缺失给 ENOENT、`stat` 的 mtime 每次改动推进（`freezeMtime` 复现「同大小同秒改写」）。配套的 `remote-fs-smoke`（67 项）把原子发布、写一半断线后目标不动、`FS_STALE_VERSION` / `FS_NOT_OBSERVED`、三种围栏拒绝、软链逃逸、`editText` 的换行与二进制判定全部搬到裸检出上跑。
  - **共享宿主替身（`plugin-host.mjs`）**：19 处手搓 `ctx` 字面量收敛到一处。替身**可以比 Cordis 小，绝不能比它松**——重复 `provide`、已销毁 fiber 的读写、同名工具注册在这里同样被拒，否则套件测的是替身。
  - **引擎替身收敛**：`fakeEngine` 定义处 8 → 3，且三处都只是指向 `tests/support/` 里一份实现的别名；`forward-smoke` 与 `forward-persist-smoke` 两份字节级重复的引擎合成 `fake-forward-engine.mjs`，路由层的上传引擎抽成 `fake-upload-sftp.mjs`（它能表示「写入忽略 offset」「`r+` 当只读」「`w` / `wx` 不区分」这三个真出过的 bug）。
  - **组件渲染骨架（`render.mjs`）**：从 bundle 里按大括号切出真组件、用 React 形状的钩子桩渲染一次，`render-smoke` 用**真组件**（`SelfCheckList`）驱动并带负向对照（改坏过滤条件后树必须变）。effect 默认不执行——执行等于替 React 断言它何时跑。
  - **三条长期红清除**：①`transfer-retry` / `transport` 在裸检出上从「失败」变成显式 SKIP 或真跑（缺的是 `ssh2` 本身，不是 `DSH_CORE_ROOT`）；②`workspace-ownership-smoke` 的硬编码 LF marker 改为读入后 `replace(/\r\n/g,'\n')`，CRLF 检出不再红；③新增 `.gitattributes`（`* text=auto eol=lf`）让行尾不再随检出漂移。
  - **partial 变成待办清单**：`run.mjs` 收尾逐个打印 partial 套件的 SKIP 行，`docs/development.md` 的套件表新增「跳过段」一列，写清跳的是哪一段、缺什么条件。
- **远端技能发现（`lib/remote-skills.js`，默认关闭）**：远端工作区里的 `.dsh/skills` 与 `.agents/skills` 现在能被 `skill` 工具发现和加载，rank 250（夹在项目级与用户级之间）。三条不能复用宿主代码的理由都落在实现里：宿主的 `discoverRoot` 用 `node:path.join` 拼 `SKILL.md`，在 Windows 上把 `ssh://box/data/proj` 拼成 `.\ssh:\box\...`——既不是远端路径也不报错，目录型候选会被静默丢弃，所以发现循环自建、路径全程 `normalizeRemotePath` / `formatRemotePath`（测试钉住 locator 里不出现反斜杠）；宿主的 frontmatter 解析是私有函数，本插件只依赖 `ssh2`，故自写子集解析（标量 / 布尔 / 一层嵌套 / 块标量），认不出的行跳过、旧拼写 `modelInvocable` 等直接判定不是技能；宿主的 `validateCandidate` 在 `provider.list()` 的 `try` 之外且是 `throw`，一个非法候选会让整个会话的技能目录读取失败、本地技能一起消失，所以非法名字 / 空描述 / 非法 `invocation` 在返回前就滤掉。**读也过围栏**：`remote-fs.js` 的 `assertWithinRemoteRoots` 只被 `#assertWritable` 调用，读取不判围栏，因此 `get()` 每次加载正文前自己调一次 `assertFencedRealpath`，远端种下的符号链接不会把读取带出工作区。**默认关闭 + 主机白名单**：技能描述一被读到就进模型上下文，与「模型主动打开一个文件」是不同风险等级；`*` / `bo?x` 这类通配别名被拒绝并记警告。有界（每根 200 条 / 每主机 32 个 / 单文件 64 KiB / 5 秒）且**不完整不等于空**——某个根读失败时 `complete: false` 并保留已读到的候选，宿主据此不缓存，一次断线不会被写成「这台主机没有技能」。状态工具与面板 `/status` 增加 `remoteSkills` 块，诊断只记数量与别名。
- **目录列表跟随输入（两个 picker）**：路径栏以前只有回车才生效——键入 `/home/me/pro` 时列表还停在登录目录，找目录只能盲打整条路径再按回车试。现在两个对话框共用 `usePathDraftPreview`：同一目录内的前缀**只本地收窄**（大小写不敏感、保留主机真实拼写、零往返零定时器）；带尾斜杠的路径（`/home/me/` 明确表示这是目录）在输入停顿 `PATH_PREVIEW_DEBOUNCE_MS`（200 ms）之后**只发一次**列目录请求；整条拼全的真实目录名只收窄成一行、**不自动进入**——进目录永远是补尾斜杠、回车或双击。**尾斜杠就是「在目录里」**：导航后草稿写成 `/raid/`，删掉斜杠即回父目录并按 `raid` 收窄，两个状态不再共用同一个字符串。预览请求不写输入框、不先清空列表（失败时旧行还在），并且**只在主机答完后**才把 `path` 指向该目录，所以「挂载此目录」不会指向还在拼写的路径。输入框**删掉了 `onBlur` 复位**：双击的第一下会先 blur，复位会让行在两次点击之间移位。
- **列目录从「逐条 stat」改成一轮往返**：`sftp.readdir` 每个条目都带 attrs，服务器要为每一条做一次 `lstat`——共享 `/tmp` 这种几万条的目录在 300 ms 链路上 30 s 都不返回，而同机 `ls` 只要 44 ms。选择器**只要名字**，于是 `GET /ls` 新增两条快路径：`dirs=1` 与 `all=1` 各跑一次 `engine.exec`（`ls -1ap` 过一层 `awk`），**上限在远端就生效**（25 000 条的目录最多只传 `limit` 个名字），同一轮里 `pwd -P` 解析登录目录、`test -w` 报可写性。stdout 只走名字、stderr 只走一行标记（目录名可以和状态行一模一样，所以不能共用流）；任何形状不符——非 POSIX 登录 shell、缺 `awk`、目录不可读、退出码非 0、计数不自洽、脚本自认 `fallback`——一律**回退到 SFTP**，这是优化而不是第二套实现。这条 exec 带 `audit: false`：它是一次界面读取，和 `readdir` 同性质，记进审计环只会让面板每敲一个键多出一条多行脚本。
### 修复

- **「新建远程工作区」的滚轮根本到不了对话框**：这个弹窗由 `WorkspacePickFlow` **内联渲染**在侧栏里，是 `SidebarRoot` 的 `.scrollArea` 的 DOM 后代；宿主在那上面绑了 `passive: false` 的 wheel 监听，把每一次滚轮都 `preventDefault()` 之后手动写给它自己的视口。`position: fixed` 只改变绘制、不改变冒泡，所以对话框体一个 `scroll` 事件都收不到——前两次改的都是对话框内部的滚动容器尺寸，改得再对也没用（浏览目录弹窗从我们自己的插槽打开，不在那棵子树里，因此一直正常）。新增 `modalLayer()`，五个弹窗统一 `createPortal` 到 `document.body`；顺带躲开 `.composerSeat` 的 `will-change: transform` 把 `position: fixed` 的包含块从视口改写掉。宿主对 composer 内的浮层有同样的约定（`ConversationRoot.module.css`）。
- **表单固定在顶部，只有目录列表滚动**：整个 body 一起滚同样不行——用户挑目录时看不见自己填的工作区名（截图里正是这样）。现在 `.sshwsp-dialog-body` 是不滚动的 flex 列，`.sshwsp-form` 与路径栏 `flex: 0 0 auto`，剩余高度全归列表；`.sshwsp-dialog-fill` 给出 `height: min(88vh, 760px)` 并把 `max-height` 抬到 `88vh`（只有上限时内容撑不到上限、`flex: 1` 分不出空间；低于基类 `80vh` 又会被悄悄裁掉）。窗口矮于 620px / 500px 时压的是外壳——间距收紧、`calc(100vh - 12px)`、隐藏提示行——而不是继续挤列表：380px 高时标题栏加表单加提示加底栏会把列表压到 23px。实测 1300×620 / 1000×450 / 900×380 / 800×340 四档，表单均不滚动、列表均能滚到最后一行。
- **「新建远程工作区」的目录列表在小窗口里滑不动**：列表自带 `max-height: min(40vh, 320px)` 与独立滚动，被 `dialog-body` 的 `overflow-y: auto` 裁掉下半截——1300×620 下 40 行目录只有 142px 可见，900×380 下列表整条落在可视区之外（滚轮落在底部按钮上），滚到底也永远看不到最后一行。现在列表不再自带高度上限，整个对话框只有一个滚动容器；浏览目录弹窗的路径栏同时改成 `position: sticky`（`.sshwsp-browser` 因此必须是 `overflow: clip` 而不是 `hidden`，否则 sticky 黏在一个从不滚动的框上等于没生效）。5 档视口 × 40 / 2000 行实测：最后一行全部可达。
- **两个目录对话框改成双击进入下一级**：单击进入在多选、误触和「只想看一眼」时太容易触发；现在单击只选中，双击才进入。键盘激活（`Enter` / `Space` 产生的 `detail === 0` 点击）仍然进入，没有鼠标也能用。两个弹窗各自加了一行「双击目录进入」的提示，`RemoteWorkspaceDialog` 的目录行补上 `sshwsp-entry-dir`，指针光标与浏览弹窗一致。
- **两个目录对话框的行分成两种**：目录行是按钮（双击进入，键盘激活同样进入），文件行是不可点的上下文（`sshwsp-entry-file`，没有 `onClick` / `onDoubleClick`）——它回答「这个目录里有什么」，但既不能进入也没有下载，做成按钮就是用户会去点的一半控件。请求从 `dirs=1` 改为 `all=1`：服务端把目录排在前面、**上限也先花在目录上**，所以文件再多也挤不掉一个目录。`dirs=1` 保留（只列目录的调用方仍然用它），两者互斥、非 `1` 一律 400。
- **只改 CSS 的改动不再需要整页刷新**：`injectStyles()` 原本在发现已有 `<style>` 标签时直接 `return`，而 client-HMR 重建模块会重新执行它——于是 JS 换了新代码、页面留着上一版样式表，CSS-only 的修复「看起来已生效」其实一条规则都没进去。现在复用既有标签改写 `textContent`，注入仍是单份，页面里的表恒等于 bundle 里的表。

## [0.3.5] - 2026-11-19

### 新增

- **接缝接管的结果可查（`seams[]`）**：六个 `patch-*.js` 统一走 `installSeam()`，`installed` / `absent` / `failed` 三态由状态工具、面板 `/status` 与诊断报告同时给出；`absent` 不算问题，`failed` 把状态胶囊变红并记一条 `seam` 事件。与 `upstreamWorkarounds` 互补：一个问宿主是否已不需要这条补丁，一个问这次接管到底装上没有。
- **远端工作区里命令能起来**：宿主每条命令通路都先跑 `ctx.sandbox.confine()`，它按主机路径解析 `ssh://…` → `ENOENT` → `SANDBOX_PREPARATION_FAILED`，接缝一次都没被问到。新增 `lib/patch-sandbox.js`，只把 policy 里远端 `workspaceRoot` 换成本机固定名的替身目录（随机名会每条命令泄一个 ACE），`mode` / `sessionId` 原样带过；**不改 `sandboxPolicy.resolve`**，`mode-gate.js` 的会话级收窄正靠那个拼写。真正执行远端命令的仍是 `patch-shell` / `patch-subprocess` / `patch-terminal`。
- **`run_code`（`ops-ptc` 预设）不再报 `cannot run "…DeepSeek Harness.exe" with a remote cwd`**：PTC worker 是本机进程，cwd 默认成 `ssh://` 根，先被 subprocess 白名单拒，放行也会 `process.chdir('ssh://…')` 失败。新增 `lib/patch-ptc.js` 接管 `ctx.ptcRuntime.resolve`，只换返回 spec 里远端的 `cwd`，本地 spec 按引用原样返回；程序调用的工具仍在远端执行。
- **官方「变更请求」面板不再整块空白**：`workspace-write` / `read-only` 下 Windows 把 argv 包成 `[<runner.js> …flags, '--', git, …]`，前置是打包版桌面 exe 而不是 `node`。`unwrapSandboxArgv` 多认「与本进程 `process.execPath` 同名同身份的可执行文件」与「front 是 node 且前缀带 runner namespace 标记」两种真实形状，剥离边界仍在 `--` 之前，用户自己的 `git -- status` 原样保留。
- **普通远端路径的 subprocess 路由**：宿主「本地变更」卡片经 `ctx.fs.processPath` 把 `ssh://` 剥成裸绝对路径再调 git。判据从「有 scheme」变成三条同时成立（落在唯一已挂载远端根、该根主机可用、本机无同名路径），不成立则保持本地 spawn 并把原因记进 `PLAIN_ROUTE_REASONS`；路由前先判 `routesToRemoteCommand`，挂载根下的 `bash` / `node` 不再从本地 ENOENT 变成宿主内部同步抛错。
- **「变更请求」tab 下半的最近提交历史**：按官方 tab key 遮蔽该 slot 条目，官方组件留在上方、只读提交条渲染在下方，不加新 tab。数据来自只读路由 `GET /api/dsh-ssh-workspace/git-history`：只接受 `session` 与 `limit`（1..100，默认 20），cwd 只从会话自己的 `workingDirectory` 取，argv 固定，带 `GIT_TERMINAL_PROMPT=0` / `GIT_OPTIONAL_LOCKS=0` / `LC_ALL=C`，15s 超时与 1MB / 16KB 输出上限；非仓库与未出生 HEAD 是 200，`-n limit+1` 用来判断截断。
- **提交历史可折叠，折叠状态被记住**：点标题行整体收起，`aria-expanded` 同步、chevron 旋转 90°、文案不带数字、标题里是真正的 `button`。可见性由唯一纯函数 `historyChrome(collapsed, truncated)` 决定；折叠值写页面 `localStorage`（`dsh-ssh-workspace.commit-history.folded`，只认 `'1'`），缺失 / 垃圾值 / 读写抛错 / 无存储一律按展开。
- **「添加工作区」改成两段式**：先选「新建本地工作区 / 新建远端工作区」。本地支直接渲染已安装的目录浏览面板本身（同一组件、同一份 locale 与列目录调用，没有内置浏览器才回落 `pickDirectory()`），远端支仍是选主机 → 逐级浏览 → 确认挂载。
- **会话归属自动补偿**（`lib/ownership.js`）：宿主用 `realpath(cwd)` 校验会话，插件缺席时 `ssh://` 必然失败，该 id 两个名单都不入，此后任一次 `mutate()` 都会把这份名单写回磁盘——会话文件都在，丢的是归属记账。现在每次激活、远端根挂好**之后**（顺序不能反）无条件重建一次宿主会话索引（`listStoredHeaders()` → `replaceHeaderIndex()` → `indexLiveSessions()`，实测约 340 ms / 60 个持久会话），再只对记录里真没有的 id `attachSession` 并回读 `sessionIds` 验证；只在规范化后完全相等时认领，`subagent` 子会话不算候选，失败只算一条 `pending`。
- **侧栏分组与分组里的行都能自己回来**：重建索引改的是索引、不发 `domain/changed`，所以重建成功后还要按宿主自己的发射形状把每个工作区的筛选后视图重新广播一次（`makeWorkspaceRepublisher`，失败只降级不中断补偿）。分组**里的行**来自页面连上时那一次 `session.list`，于是补偿跑完后浏览器那一半再要一次会话基线（`sessions.refresh()`）：只在 `stage === 'done'` 且这次真动过东西时触发，缺行重试最多 3 次（400 ms 起、×1.6 封顶 2 s、整趟 150 s 封顶），一个页面实例只跑一趟。「禁用 → 重启 → 启用」之后不必再重启 DSH。

### 修复

- **浏览器终端的操作链会被一个永不落地的操作冻住**：宿主的 `write` / `resize` / `attach` / `close` 全排进一条串行队列，一个 promise 不 settle 就冻住整个终端。三处成因已对照真库核过并修掉——`ssh2@1.17.0` 的 `setWindow` 没有回调、`Channel._write` 在非 open 时直接 return、`terminate()` 等对端 CHANNEL_CLOSE 而 ssh2 永不 emit `close`。现在 resize 发完即落地、非 open 的 write 明确拒绝而不是挂起、`terminate()` 先结算 `output` / `done` 再宽限 250 ms（`TERMINATE_RELEASE_MS`）后本地 `channel.destroy()`。
- **`RemoteTerminalHandle` 缺 `inspectActivity`**：宿主在 `create()` 的 catch 里无条件绑定，缺方法就是 TypeError、能带走宿主进程。补上后按字节活动答 `busy` / `unknown`，退出后 `idle`——不猜 `idle` 去杀跑长命令的终端。
- **远端终端不认用户选的 shell 家族**：此前一律 `exec sh -l`，标签写 zsh 实际跑 sh。现在取 `argv[0]` 的 basename、去 `.exe`、小写后查 `{bash,zsh,fish,ksh,tcsh,csh}` 白名单，命中出 `if command -v <name> >/dev/null 2>&1; then exec <name> -l; else exec sh -l; fi`，未命中（含 pwsh / cmd）保持 `exec sh -l`；名字只来自白名单、不插值。
- **官方「变更请求」面板上半整块显示 i18n key**：遮蔽注册原先声明官方**包 id** 作 `locale`，而渲染器按**条目自己声明**的命名空间合成 `t`——包 id 不是字典名。现在本插件的座位**不声明** `locale`，官方面板的 `t` 由新增 `officialTranslateSeat()` 从官方条目自己的 `entry.locale` 绑定后覆盖进 props，绑不上返回 `null` 且不覆盖。
- **`--namespace` 被当成路径选项**：它命名的是 ref namespace 而不是目录，远端翻译会把 ref 前缀改写成远端路径。已从 `GIT_PATH_OPTIONS` 移除，出现在 argv 里时逐字保留。
- **终端路径上的常驻 trace 已移除**：此前每次 open / close 同步写一行到 `/tmp/ssh-workspace-terminal.log`，`write` 更是每一击键一行。整条移除后模块内不再有任何同步文件 I/O，`terminal-smoke` 钉住这一点（含环境变量与文件名都不得出现）。
- **宿主侧内容采集的静默失败现在可观测**：`dsh-workspace-changes` 的 `captureFile` 走 node:fs，远端路径在本机打不开 → `kind: 'absent'`，被 git 忽略的改动画不出 diff 且不报错。首次远端写入时记一条 `degraded` 诊断（`#captureLimitNoted`，每次激活一次）。
- **接缝装不上不再升级成插件激活异常**：`installRemoteSandbox` / `installRemotePtc` 等在宿主换掉方法形状时是 `throw` 的，而它们跑在 `ctx.inject` 回调里——一个上游改名会让整个插件下线，而不是只丢掉它支撑的那一个功能。现在统一经 `installSeam()` 捕获并记成 `failed`。
- **状态面把快照字段弄丢，连带让整个 status 结果被宿主拒收**：`stage` / `updatedAt` 加进了快照与宿主的输出 schema，但结果里的 `ownership` 仍是**手写字段清单**的拷贝，于是 `ssh_workspace_status` 以 `missing required property "value.ownership.updatedAt"` 失败、HTTP `/status` 里那个字段读成 `null`。现在三处出口统一返回 `ownershipSnapshotCopy()` 的结构化拷贝，不再有第二份字段清单可以漂移。
- **面板的 `/status` 也带 `ownership` 快照**：之前只有状态工具与诊断报告读它，排查「启用后会话没回来」时只能靠猜。字段缺失仍表示「还没测量过」，与测得 0 区分开。
- **归属补偿把子会话算成丢失**：`subagent` 子会话继承父会话的 `cwd`、每次都成为候选，可它不是侧栏行也 attach 不上，于是 `pending` 永远至少是 1，那条警告永远清不掉。`reclaimCandidates` 现在跳过 `origin === 'subagent'` 的头部（以及带 `subagent` 字段的旧形状）。
- **补偿不再「先量症状」**：闸门用 `entity.sessionIds` 判断有多少会话没被记账，而它是**已筛选**视图，于是「索引是好的」与「索引是插件缺席时建的」读出完全相同的零，判成无需重建。改为无条件重建一次；每个 await 都有预算（清单 10 s、重建 45 s、单条认领 10 s、整趟 60 s），超时写成 `pending` 的理由而不是无声挂起，空清单返回 `empty` 并放弃——**绝不**拿空表重建。

### 测试

- `terminal-smoke` 23 → 38、`diagnostics-smoke` 49 → 65；`insert-once-smoke` 的 teardown 断言改为钉**停止清单**本身（新增一个需在卸载时停掉的东西本就该改这里）。
- 新增八个套件：`workspace-ownership-smoke` 153、`session-catchup-smoke` 58、`commit-history-smoke` 158、`local-changes-remote-smoke` 70（设 `DSH_CORE_ROOT` 时再多 6）、`patch-sandbox-smoke` 51（再多 3）、`patch-ptc-smoke` 36、`browser-terminal-smoke` 27（用**忠实复制 ssh2 契约**的假通道复现宿主那条串行队列——旧套件的宽松替身主动调回调，正是这个 bug 一直绿着的原因）、`remote-git-env-smoke` 16。
- 反向验证累计 **50 处以上实际转红**（归属与 catch-up 各 13、patch-sandbox 10、patch-ptc 6、`lib/client.js` 5 等），改回后相关文件的 sha256 与变异前逐字节一致。
- 裸检出 **83 passed / 2 partial / 6 skipped / 0 failed（91 suites，4632 项断言）**；装配树 `DSH_CORE_ROOT=F:/GitHub/.asar-full/dsh/node_modules` **87 passed / 2 partial / 2 skipped / 0 failed（91 suites，4882 项断言）**。

### 文档

- `docs/architecture.md` 新增「接管 ctx.sandbox.confine」「接管 ctx.ptcRuntime.resolve」与「接缝接管的结果表（`seams`）」三节，subprocess 一节补「运行器包装先剥掉」（三种真实包装形状、为什么打包版 exe 必须按身份识别）。
- `docs/troubleshooting.md` 新增四条（`workspace and temp directory resolution failed`、`cannot run "…DeepSeek Harness.exe" with a remote cwd` 两条、卸载过插件后侧栏少了会话），侧栏那节按**两层**写（工作区分组走订阅流、分组里的行走连接时的那次 `session.list`）。
- `docs/commit-history.md` 新增「折叠是怎么做的」、重写 2.3（原结论「官方命名空间就是 TAB_ID」是错的）；`docs/features.md` 改写方言一行、补逐文件文本对比的远端盲区 / `seams[]` / 会话归属补偿三行；`docs/tools.md` 补 `seams[]` 与 `seam` 事件。
- `docs/README.md` 目录表补齐五篇此前未进索引的文档；`docs/optimization-and-future03.md` 上游阻塞表补第五条并写明本补偿的退役条件；套件与断言数统一为 91 / 4632 / 4882。

## [0.3.4] - 2026-11-14

### 新增

**文件引用**

- **显式本机 scheme（默认 `local:`，面板可改）**：`local:/Volumes/SSD/a.md`、`local:F:\123.txt` 这类拼写无条件按本机读取，路径部分是去掉前缀后的绝对路径；名字存 `dsh-ssh.json` 的 `passthrough.scheme`，在面板「文件引用设置」里保存即写穿 live matcher（不必重启），`config.localPassthroughScheme` 只是首次默认。未启用的前缀**明确拒绝**（`FS_PERMISSION_DENIED`）——静默转远端会让用户以为前缀生效，交给本机后端则等于让模型给自己授权（`local:/etc/passwd` 会真的读出来）。
- **`@` 裸 POSIX 拼写远端优先、miss 回退本机（勾选项，默认关）**：`@/Volumes/SSD/PARAMS.md` 在 POSIX 主机上先进引用表，读远端报不存在且开关打开，才试一次本机同名文件，并在返回文本末尾附 `[ssh-workspace]` 来源说明（`readBytes` 只记日志，避免破坏图片魔数嗅探）。只对点名路径、只挂在读动词上；写、`glob`、`grep`、`listDir` 绝不回退，方向永远是远端先。
- 新增第 32 条路由 `POST /api/dsh-ssh-workspace/passthrough/settings` 与 `/status.passthrough` 字段；`lib/passthrough-settings.js` 是这两个设置的唯一写入者。

### 变更

- **scheme 规则收成一份，并由服务端下发**：前缀名**至少 3 个字符**（1 个字符会与 Windows 盘符抢 `c:/x` 这段文本）；保留名从 `ssh` 扩成 `SCHEMES_IN_USE` 冻结表（`ssh` / `file` / `sftp` / `dsh-app` / 常见 URL scheme），每条带理由且理由原样进拒绝文案——`file` 尤其不能配，因为 `formatRemoteFileUrl` 为**远端**路径写 `file:///srv/x`，同一个拼写会在两台机器之间换含义。`/status.passthrough.schemeRules` 下发最短长度、语法、两个大小写字段与整张表，客户端不再保存第二份正则与 `=== 'ssh'`。
- **存量不可用值：静默降级改为降级 + 可见提示**：`file` / `c` 这类上一版合法的名字，读回仍降级到默认且不回写用户文件，但 `activate()` 记 `warn`，`/status.passthrough.schemeWarning` 给出存储值、生效值与原因，面板顶部渲染一行提示，只有重新保存才写穿 store。
- **面板直通一区改为两级标题**：「文件引用设置」（`h3`）压「显式文件引用 scheme」（`h4`）；`passthrough.scheme` 仍是输入框的可访问名，改区标题不连带改字段名。

### 修复

- **空白处右键越出文件面板**：查找范围原一路放宽到 `document`，会话正文里右键会借到第一块文件面板的目录菜单，本地与远端面板并排时也会互相借。现在作用域就是指针所在的 `[data-files-page]`，页面以外一律交还浏览器；行菜单不加这层门禁，预览标签里的行照旧可弹。
- **反向验证脚本被打断会把变异留在源码里**：两个脚本原来只在 `finally` 里还原，管道被截断（EPIPE）、Ctrl-C 或崩溃都走不到。现在先落 `<file>.reverse-backup` 再改文件，恢复挂到 `exit` 与 `SIGINT` / `SIGTERM` / `SIGHUP` / `SIGBREAK` 上，下一轮用遗留备份自愈。
- **一条恒真的大小写断言**：`local-passthrough-smoke` 收尾的 `check(..., true)` 等于在 Windows 以外的所有主机上什么都没测。改成把 `win32` 与 `darwin` 各自 pin 进 matcher并**成对**断言（同一 fixture、相反答案）。行为未变，是补测。

### 测试

- `local-passthrough-smoke` 88 → 231、`client-shape-smoke` 307 → 324、`tree-blank-menu-smoke` 16 → 40 项；新增 `scripts/reverse-verify-blank-menu.mjs`，`reverse-verify-passthrough` 37 → 43 条变异全部转红。
- 0.3.4 的第一次 CI 跑红在 `local-passthrough-smoke`：Windows 形状的夹具没有钉平台，而提取器与默认前缀都按进程平台分派，于是断言只在 Windows 检出上成立。夹具改为显式 `platform: 'win32'` 与显式前缀，产品行为不变。
- 裸检出 **77 passed / 6 skipped / 0 failed（83 套件，4259 项断言）**；真实装配树 **80 passed / 1 partial / 2 skipped**。

### 文档

- `docs/ui.md` 新增「面板：文件引用设置」一节；`docs/protocol.md` 补 scheme 规则与 `schemeWarning`；`docs/troubleshooting.md` 补「配的 `file:` 突然不生效」与「macOS 上 `@` 点了读不到本机同名文件」两条；`docs/features.md`、`docs/architecture.md` 与两个 README 同步 scheme、回退的两道门与空白菜单作用域。

## [0.3.3] - 2026-11-13

### 修复

- **`ssh://` 会话读不到聊天框上传的附件**（[#4](https://github.com/siqyka/dsh-ssh-workspace/issues/4)）：远端会话把所有裸绝对路径当成远端，本机 `$DSH_HOME/attachments/…` 被拼成 `ssh://<alias>/…` 走 SFTP。新增 `localPassthrough`（默认 `$DSH_HOME/attachments`、`$DSH_HOME/plugins`），在 `ctx.fs.resolve` / `lstat` 与 `node:path.resolve` 的远端分支**之前**做词法前缀直通；未命中前缀的路径仍按远端解释，不做存在性探测。交给本地后端时剥离远端 `cwd` 以免递归回自身；写围栏不变，整目录 `$DSH_HOME` 被拒绝。
- **`@F:\…` 形式的本机路径引用变成远端路径**：宿主把 `@` 提插成普通提示词文本，文件系统调用处没有元数据可查。插件改为从 `session/created` 的历史与 `session/event` 的 `user/message` 恢复引用，只接受 Windows 盘符 / UNC 并交给同一个 matcher（先进先出，上限 256 条）；`@src/a.js`、`@/tmp/x` 仍是工作区 / 远端路径。
- **提示词不再承诺直通管不到的东西**：直通只覆盖经过 `ctx.fs` 的调用，dsh-ops 的 `inspect_local_file` / `read_files` / `glob` / `grep` 与宿主 `glob` / `grep` 绕过它，`ssh://` cwd 下分别报 `EXECUTOR_UNAVAILABLE`（`only git and ripgrep`）与 `invalid workdir`。`LOCAL_PASSTHROUGH_GUIDANCE` 写明这条边界与替代入口，不再让模型空转重试。

### 测试

- 新增 `local-passthrough-smoke`（88 项）；`scripts/reverse-verify-passthrough.mjs` 20 confirmed / 0 not。

### 文档

- README 中英新增「本机路径直通（`localPassthrough`）」；`docs/features.md` 补规则表与「直通的边界就是 `ctx.fs`」；`docs/troubleshooting.md` 新增「直通了，为什么还是读不到」；`docs/architecture.md` 说明直通先于远端分类、`@` 引用是同一 matcher 的第二类输入。

## [0.3.2] - 2026-11-11

### 新增

**文件与选择**

- **系统文件拖入远端「文件」树上传**：落点决定目标目录——目录行（折叠或展开）是自身，文件与 `other` 行是父目录，展开目录内的嵌套空白归属该目录（宿主的子列表就在同一个 `li` 内），树体空白与树头 / 路径标签归树根；不自动展开目录。只接收文件：拖入文件夹整批跳过（前三个名字 + 省略号，不递归、不入队），与文件混合时跳过说明搭在同一条批次提示的结果句上而不再另开一条会互相覆盖的 toast，只拖文件夹时才单独提示；本地工作区的树明确拒绝，不静默变成 composer 附件。监听在 document capture 阶段，树内 `preventDefault + stopPropagation` 拦住宿主附件，树外不拦截、DSH 原有拖入行为不变；内部「树行 → 输入框」拖拽只带自定义 MIME，仍走原落点插入分支。上传复用同一个 `enqueueUploads` 队列与同一句超限提示，成功后的刷新仍由队列负责。
- **本地工作区「文件」树的空白处菜单**：空白处右键恰好两项——「新建文件夹」「复制路径」。目标目录是空白处所属的那一个（落在已展开目录的嵌套列表里就是那个目录，否则是树根），必须在树根之内；只读会话只禁用新建，复制始终可用。`POST /mkdir` 因此按 `path` 的拼写分支，本地分支的边界只取自会话/策略（请求里的 `root` 只用于识别会话），`realpath` 父目录防符号链接逃逸。远端工作区保留原有空白处菜单，远端目录行的「新建文件夹」保持不变。
- **多选整批拖入输入框**：`dragstart` 用 `resolveTargets` + `treeSelectedItems` 取整批目标，载荷是版本化 JSON；`drop` 一次调用同一个插入助手，按树中顺序逐条插入、重复路径只插一次；行菜单「添加到任务」用同一目标集合。

**输入框**

- **拖入时按指针落点插入引用**：`dragover`/`drop` 用浏览器 `caretRangeFromPoint` 把指针位置映射成 composer 的 detect 偏移；文本按 `data.length`、chip 按 1、managed `<br>` 按 0、段落之间按一个换行累计。拖动期间在输入框内画一条单例竖向光标，第一个 chip 插在落点、后续 chip 依次跟随。多张可见输入卡、指针在卡片内边距、边界不可映射或浏览器不给 caret 时一律回退到旧的追加行为，映射失败不影响投放。

### 修复

- **工具返回值被 DSH 0.2.2-rc.1 拒绝**（[#3](https://github.com/siqyka/dsh-ssh-workspace/issues/3)）：宿主开始真正校验 `output.schema`，`ssh_workspace_status` 的 `events[].seq` 一直在产生却没被声明，`ssh_workspace_hosts` 直接把带未声明键（含 `undefined`）的存储行交给宿主，整次调用被判成不可无损 JSON。修的是**这一类**而不是这两个字段：新增 `lib/tool-schema.js` 的 `projectValue` / `validateValue`，`defineTool` 按各工具自己的 schema 投影返回值并把丢弃记进 `drainProjectionDrops()`；顺带修掉 `ShellManager.list()` 的 `startedIn: start?.cwd`，以及 `projectValue` 自己漏报「未声明且值为 `undefined`」的键。新增 `tests/tool-results-smoke.mjs` 真跑 `execute` 并**对丢弃记录断言为空**——schema 必须跟上生产者，而不是靠投影悄悄吃掉信息。
- **同名工作区误标**：标题是弱身份，本地工作区与远程工作区可以合法同名（本仓库本身就是）。此前标记与停用置灰只按标题匹配，同名的**本地**行会被换成远程标记、甚至被置灰成不可点。现在同时收集本地标题，两边都有的标签不标识任何一方；标题规则也只在完整读过 DSH 自己的 store 之后生效，`/status` 回退时只做 id 匹配。
- **拖动插入后光标落在错误位置**：插入后只聚焦一次，且聚焦的是接住投放的那张输入卡（不再受「唯一可见 composer」这条歧义规则影响）；拖动结束清掉树行里残留的文本选区，光标落在 chip 之后而不是行名上。

### 测试

- 新增 `tree-blank-menu-smoke`（16 项）、`tree-drag-smoke`（24 项）、`tree-os-drop-smoke`（60 项）、`composer-drop-point-smoke`（42 项）、`tool-results-smoke`（33 项）；`client-shape-smoke` 275 → 298、`mutations-smoke` 62 → 80、`transfer-queue-smoke` 135 → 138、`caret-after-insert-smoke` 17 → 19。
- 裸检出 **76 passed / 6 skipped / 0 failed（82 套件，3759 项断言）**；真实装配树 **79 passed / 1 partial / 2 skipped（4003 项断言）**。反向验证 `reverse-verify-tree-drag`：17 confirmed / 0 not。

### 文档

- README 中英文同步系统文件拖入、本地空白处菜单与本地 `/mkdir` 分支；`docs/ui.md` 记录落点映射、退化矩阵与两种「文件夹」；`docs/protocol.md` 补 `/mkdir` 的两个分支；`docs/tools.md` 补 `hosts` 的可选字段与 `status` 的 `events[].seq` / `shells[].startedIn`；`docs/development.md` 与 `docs/optimization-and-future03.md` 同步套件数与闭环状态。

## [0.3.1] - 2026-11-08

### 新增

**文件与选择**

- **宿主「文件」树多选**：Ctrl/Cmd 切换、Shift 选区间；普通单击仍打开，修饰键点目录只选不进；选择按会话 + 根记忆，重挂载后仍可续选。
- **菜单文案固定，作用范围随选择**：删除始终「删除」、下载始终「下载到本机」，不再有「删除所选（N 项）」「下载所选（N 项）」两套文案；目标由 `resolveTargets(clickedRow, selection)` 唯一决定，收敛发生在菜单弹出前。数量移到删除确认框与下载目标对话框：确认框先出现、数字后到，递归计数上限 200，本地未知与列目录失败分别说明。
- **批量下载只问一次位置**：超过一项先确认再选目录，依次回落浏览器 `showDirectoryPicker`、preload 桥、`uiWorkspace.pickDirectory`、逐项保存；取消即取消整批；混选时本地行被跳过并说明。
- **行内重命名 / 新建文件夹 / 删除**：F2 或行菜单原位输入；新增 `POST /rename`、`POST /delete`、`POST /mkdir`，越界、根目录、只读 / 停用状态拒绝，软链只动链接本体，目录删除逐项 lstat。
- **行右键菜单收窄**：220px 单行、24px 行高、最多 8 项、三组分隔线，各动作独立图标。

**传输**

- **统一传输队列与进度**：浏览器上传共用一份队列（主机 1 / 全局 2），五态、可单独取消、可暂停 / 恢复、失败可重试；重试重新判冲突、补缺失分片并双侧 SHA-256 校验。
- **速度与聚合进度环**：运行行显示百分比、速度、字节；速率 250ms 采样平滑，停顿 5s 归零；头部入口按字节加权聚合。
- **分块上传 / 断点续传 / 目录下载**：2 MiB 分片经 `POST /upload-chunk`；暂存名由目标派生、sidecar 记源；`downloadTree` 默认 zip、`?format=tar` 可回退，跳过 symlink 并列出。

**连接与配置**

- **`ProxyJump` 真建链**：按 `ssh -J` 逐跳建独立连接，目标只看到直接邻居；`ProxyCommand` 仍拒绝。
- **反向转发 `ssh -R`、`Include` 跟随与 `Match` 求值、命令确认策略、主机最近使用、`ssh://` 路径菜单、状态来源 live / cached / stale**。
- **远端「新建文件夹」** 与 **宿主文件树右键菜单**（复制 `ssh://` 路径、设为工作区根）共用同一套围栏。

### 修复

- **同一路径被监视两次、事件双发**：按 `alias + 规范化路径` 建注册表，同目标只留一只底层 watcher，事件逐消费者各扇出一次，关闭按引用计数；真实 SSH socket 硬断并自动重连后计数始终为 1。
- **错误提示只有一句话，看不见原因也无法重试**：统一 7 秒窗口、悬停暂停；错误就地提供详情 / 复制 / 重试，只在可安全重放的动作上渲染重试；所有反馈改写同一节点。
- **传输在桌面端、非 ASCII 文件名与长请求上的三处断点**：分块 JSON 替代 `File` 请求体、RFC 6266 / 5987 文件名、读取期 2 小时超时；「已下载」改为先选目标再写入。
- **断线后监视永久停止 / 持久 shell 回到登录目录**：只在链路不通且有重连循环时重试，恢复后补扫；shell 按会话记住起始目录。
- **能力表虚构、配置指纹漏检、单文件上限只对一条门成立**：虚构能力移入 `UNPROBED_CAPABILITIES`，配置指纹改用内容哈希，上限从 `transfer.js` 导出并在上传 / 下载两侧判定。

### 移除

- **清理 27 个零引用 i18n 键**：中英各删 27 行，335 → 308 键；与活键同前缀的旧键整行精确删除。
- **「浏览目录」只保留浏览与挂载**：逐行下载与上传入口退场。

### 变更

- 关闭目录对话框不再中断传输；浏览器唯一上传通道是 `POST /upload-chunk`；面板不再渲染「远程环境自检」。

### 测试

- 新增 `selection-targets-smoke`（77 项）、`toast-smoke`（87 项）、`watch-sharing-smoke`（36 项）、`transfer-retry-smoke`；`transfer-queue-smoke` 覆盖队列顺序与速度，选择套件覆盖连续 Shift 与零打开。
- 裸检出 **70 passed / 6 skipped / 0 failed（76 套件）**；真实装配树 **73 / 3 / 0**。反向验证：菜单带 N、去收敛、计数错位、删重试门控、去 watcher 注册表均真红。

### 文档

- 三辑合并：删除 `docs/optimization-and-future.md` 与 `docs/optimization-and-future02.md`，内容收进 `docs/optimization-and-future03.md`；删除 `unmount-modes.md`、`trigger-gates.md`、`acceptance-prompts.md` 三篇临时专题，修正索引与死链。
- README 中英文同步多选、浏览收窄、ProxyJump 限制、11 个工具与反向上游转发；`docs/ui.md` 记录确认框先出现、菜单固定文案。

## [0.2.8] - 2026-10-31

### 新增

- **上游补丁的探测能区分「读的是绑定」与「读的是快照」**：新增 `lib/path-binding.js`，探测期间把 `path.isAbsolute` 换成记账包装，捕获了函数值的 schema 永远不碰它。
- **诊断判定与状态灯**：新增 `lib/diagnosis.js`，只读报告已打印的字段给出 `ok` / `warn` / `unknown` 三态（不探测、不连接、不读文件）。`/status` 与 `ssh_workspace_status` 新增 `diagnosis`。
- **报告补上三处漏掉的事实**：`## host keys`、被跳过的主机、连接代次。
- **断线后自动重连**：后台指数退避（1 秒起、60 秒封顶），面板卡片显示重连状态，`POST /hosts/reconnect` 跳过等待。
- **重连后恢复已存隧道**：该主机 `enabled` 的保存转发自动重开，普通首次连接不会重开用户关掉的隧道。
- **`engine.reconnect` 配置**：`baseDelayMs` / `maxDelayMs` / `maxAttempts` / `jitter`，传 `false` 退回旧行为。
- **菜单可用键盘操作**：方向键环绕移动、`Home` / `End` 跳首尾并跳过禁用项、`Tab` 关闭菜单。
- **诊断文本可导出**：`ssh_workspace_status` 新增 `diagnosticsSchemaVersion` 与 `diagnosticsText`，纯文本、默认脱敏，可直接贴进 issue。
- **主机列表能区分「空」与「读不出来」**：`ssh_workspace_hosts` 与状态接口返回 `skipped` / `storeError`。
- **文档数字从源码生成**：新增 `scripts/doc-numbers.mjs`，已接入 `npm run check:docs`。
- **远程环境自检**（F-06）：7 项工具与 4 项环境事实在一次往返内问完，三态 `present` / `absent` / `unknown`。新增 `GET /self-check` 与 `selfCheck` 字段。
- **`~/.ssh/config` 审计**（F-04）：新增 `lib/config-audit.js`，`ignored` / `lost` / `refused` 三种判定不合并，结果挂在 `HostStore.listing()` 每行的 `unsupported` 上。
- **远端命令审计**（F-07）：新增 `lib/audit.js`，容量 200 的有界环，脱敏在写入时发生。
- **一键支持包**（F-09）：新增 `lib/support-bundle.js` + `GET /support-bundle` + 面板「复制支持包」，组装而非采集，不做自动上传。
- **连接分代**（F-01）：`engine.generations` 记录每个 alias 的成功连接次数，第 2 代起说明「重连前启动的远端进程可能仍在运行」。
- **补丁的宿主契约成表**（O-15）：新增 `lib/upstream-contract.js`，每个 `patch-*.js` 声明它碰的宿主符号与退役判据。

### 修复

- **上游补丁把自己误判成「可以删除」**：探测曾报 `fixed` 并建议删掉 workaround，而宿主源码仍是 `refine(isAbsolute)`。现在要求证明 schema 读的是绑定，否则如实报 `broken`。
- **面板状态文案显示原始键名**：`connections.connected` / `connections.broken` 从未定义，已补齐中英文案。
- **失败重放会重复执行写操作**：写类 SFTP 操作不再重放，改标 `outcome: 'unknown'`；命令重放改为显式 `replay: 'safe'`。
- **推送式监视降级后轮询句柄泄漏**：`watch()` 改用单一可变句柄，轮询初始化失败也不再被静默吞掉。
- **原始字节上传绕开了 CSRF 前提**：`/upload` 要求 `application/octet-stream`，`/download` 走同一守卫。
- **跳板机主机被直连**：`ProxyJump bastion` 曾被判为「没有跳板机」并直连目标；现在字符串与数组都接受，按 first-wins 处理 `Host *` 与 `!name` 排除。
- **持久 shell 超时后下一条命令读到上一条的输出**：下一条 `run` 先发隔断屏障并丢弃之前输出；解码改用 `StringDecoder`。
- **传输暂存名可能碰撞**：加 16 位随机十六进制并用 `wx` 打开；下载侧改为与 `error` 竞速，写流出错不再永久挂起。
- **首次主机密钥落盘失败仍静默连**：现在记 `degraded` 诊断并在状态输出 `unpinnedHostKeys`，后来固定成功时自动清除。
- **并发首读开两条第二通道**：`streamChannel` 加 single-flight，元数据缓存改为缓存进行中的 Promise。
- **对话框缺键盘与读屏契约**：抽出共享的 `useDialogA11y`。
- **能力探测用子串匹配判断工具存在**：`stdout.includes('rg')` 会把路径里含工具名的情况误报为已装，现在走独立前缀行并整行匹配。
- **勾选「转发 ssh-agent」后目录浏览不可用**：该字段曾被塞进连接级 config，没有 agent 时 `connect()` 直接抛错；现在只在 exec / shell 通道表达。
- **本机没有 ssh-agent 时，认证失败被报成「取不到 agent 身份」**：现在连接前先用 `getIdentities` 问一次（2 秒超时）。
- **服务器禁止转发时，勾选该选项会让整条命令失败**：识别出这一种拒绝后重试一次不带该标志，结果带 `forwardingRefused`。
- **同一会话并发打开会泄漏一个 PTY**（O-06）：按会话名做 single-flight，失败不缓存，`dispose` 期间到达的会话自行关闭。
- **超过 30 分钟的下载会被空闲回收器摘掉连接**（O-07）：`inFlight` 在回调返回时减一，而下载的真正读取发生在之后；现在流一开就 `holds += 1`。
- **失败被答成 200**（O-10）：失败一律非 2xx，状态码由 `STORE_INVALID` / `STORE_CONFLICT` / `STORE_UNREADABLE` 决定。不是失败的业务结局仍是 200。
- **面板把「读不出主机列表」显示成「暂无主机」**（O-10 的另一半）：空态按事实分句，且缺口在列表非空时也显示。

### 测试

- 新增 `replay-smoke`、`watch-lifecycle-smoke`、`scratch-safety-smoke`、`host-key-smoke`、`host-listing-smoke` 五个套件。
- `shell-smoke` 新增 13 项：并发 `open` 只建一条通道、失败不入缓存、`dispose` 期间到货的通道被关闭。
- `routes-smoke` 新增 12 项：下载期间连接被 pin 住且流结束即释放；失败契约（409 / 400 / 502 / 404 / 200）。
- `client-shape-smoke` 新增 19 项：列表缺口与存储失败各自的措辞、对话框键盘契约。
- 汇总输出改为 PASS / SKIP / FAIL 三态，不再把 SKIP 当 PASS。

### 文档

- `architecture.md` 新增「后台重连」；`troubleshooting.md` 新增排查表；`features.md` 新增能力表；`ui.md` 记录卡片状态与诊断报告一节。
- 新增 `docs/optimization-and-future.md`：16 项优化的审阅、推进结果与反向验证、9 个能力方向（该卷已删除，内容并入 `docs/optimization-and-future03.md`）。
- 两个 README 的配置表补上 `engine.reconnect`，版本示例更新为 npm 上的 `latest`。
- 全量文档审阅：路由清单补齐 `hosts/reconnect` / `self-check` / `support-bundle`，源码结构表补上 8 个模块，套件表补上 7 个缺行，各处套件与断言计数统一为实测值（裸检出 44 套件 / 1733 项、真实装配树 1956 项）。
- 诊断环的容量与各导出面的条数分开写清（容量 40，`events` 取 10，`/status`、`diagnosticsText` 与诊断报告取 20）。
- 两篇既有文档补登索引：`docs/trigger-gates.md`、`docs/acceptance-prompts.md`（两页已删除）。

## [0.2.7] - 2026-10-24

### 新增

- **连接事件可查**：`ssh_workspace_status` 与面板 status 路由新增 `events`，记录最近的连接 / 断连 / 重连 / 降级事件。
- **统一命令入口**：新增 `npm test` / `npm run lint` / `npm run check:docs` / `npm run check`，CI 与发布流程改用同一组命令。
- **贡献者与安全说明**：新增 `CONTRIBUTING.md`、`SECURITY.md`。
- **退役模式单独成文**：新增 [docs/upstream-workaround-pattern.md](docs/upstream-workaround-pattern.md)，写明上游补丁该在什么信号出现时撤掉。

### 修复

- **退役信号只写进无人读取的日志**：上游补丁的退役信号原先只进 `ctx.logger`，本部署无人读；现在经状态接口的 `upstreamWorkarounds` 字段与一条 `upstream` 事件暴露。
- **「探不到宿主」被当成「宿主仍有缺陷」**：上游补丁的探测从布尔改为六态，两者不再混为一谈。
- **断言失败只说结论**：`projection-real-smoke` 中「缺陷仍然存在」的失败信息现在直接给出删除补丁的步骤。
- **加载失败的 peer 包被静默跳过**：检测器新增 `broken`（解析到但加载失败），套件失败而非跳过，且不再被报成「没装」。
- **真包与替身并存被报成「真包」**：整树判定要求所查的每个包都是真的，并存时报 `mixed`。
- **`boot-smoke` 自己维护一份 peer 检测**：现在统一走检测器。
- **两个 stub 缺少 `__dshStub` 标记**：`dsh-tools` 与 `cordis` 的替身已补上。
- **`ssh2` 缺失被说成「宿主 peer 包」**：现在按角色区分，本包依赖缺失给出 `npm ci`。

### 测试

- 新增 `tests/peer-mode-smoke.mjs`，用四态合成树驱动检测器自身。

### 文档

- [docs/upstream-workarounds.md](docs/upstream-workarounds.md) 的退役判据改按状态集说明，删除步骤补齐相关字段。
- `development.md` 新增「日志与诊断」一节，并校正套件与断言计数。
- `troubleshooting.md` 的连接排查改为先看 `events`。

## [0.2.6] - 2026-10-21

### 修复

- **`ssh://` 会话打不开**：`cwd` 为 `ssh://` 的会话打开时报「历史加载失败」，删缓存也无效；现在能正常打开。
- **npm 装出第二份私有宿主**：安装本插件时 npm 会另装一份私有宿主副本，插件随之加载到第二份 `dsh-fs` / Cordis（服务实例分裂）；现已不再发生。
- **版本约束从未生效**：`package.json` 里写在 `dsh.engines` 下的版本要求不被读取，已删除，改由 `peerDependencies` 声明。

### 清理

- 删除 `patch-terminal.js` 中从未被调用的 `remoteTargetOf`。
- 13 个只在本文件内使用的 `export` 收回为内部定义。
- 去掉 `routes.js` 未使用的 import，以及两条没有调用方的客户端 API 映射。
- 删除 16 个没有任何引用的界面文案键（中英词典同步，现为 163 定义 / 163 引用）。
- 删除 `scripts/verify-sftp.mjs` 中的死代码，以及仓库根目录遗留的 `.peer-stubs/`。

### 文档

- 新增 [docs/upstream-workarounds.md](docs/upstream-workarounds.md)：登记绕开宿主缺陷的临时补丁，含退役信号与删除步骤。
- 根 README 的「快速开始」补上从源码仓库使用的步骤：`git clone` 后必须先 `npm ci` 再重启客户端，否则插件不会加载（`ssh2` 是直接依赖，不随 clone 到位）。
- 根 README 的版本号示例更新为 npm 上当前的 `latest`。
- 校正 `development.md` 等文档中的套件与断言计数。

## [0.2.5] - 2026-10-19

### 修复

- **文件上传可以落到远端工作区之外**：`ssh_workspace_transfer` 与面板上传此前只做模式与范围判定，缺少挂载根与符号链接判定，同一路径 `write` 会拒绝而上传照常落下。现在上传与 `write` 共用同一道判定，递归上传对每个创建的目录逐一判定。
- **远端 `workspace-write` 拒绝写 `/tmp`**：本地允许的暂存目录在远端被判成工作区外，导致远端构建全部失败。现在会话范围与挂载围栏都认该主机的 `/tmp`，且只对已有挂载根的主机生效。
- **读不懂的沙箱模式在远端等于放行**：三个被认可的模式之外的任意字符串会同时跳过模式围栏与范围围栏，命令面更是按最宽模式执行。现在写入与命令一律拒绝，文案不再把它说成用户选的「仅可查看」。
- **范围拒绝的文案指向一条一定会再失败的出路**：补上「目标还须在某个已挂载工作区内，否则先挂载」。
- **「仅可查看」没能挡住远端写入**：会话切到 `read-only` 后 `write` / `edit` 仍能改写远端文件且无任何提示，而模型的系统提示要求它先试。现在按会话模式拒绝。
- **围栏外写入被报成「在 danger-full-access 下被拒，可升权重试」**：挂载围栏与停用围栏改用各自的错误码，真实原因能直达模型。
- **`ssh_workspace_transfer` 的上传不受模式约束**：`read-only` 会话能上传而同一会话的 `write` 已被拒。现在上传同样受模式门禁约束，下载不受影响。
- **命令执行完全不看模式**：`ssh_workspace_exec`、`ssh_workspace_shell` 与 `workdir` 为 `ssh://` 的 `bash` / `pwsh` 在 `read-only` 会话下照常执行（含 `rm`）。现在统一拒绝；`close` 与读取类操作不受影响。
- **终端同样不受模式约束**：`terminal_open` 与内建侧边栏终端在 `read-only` 下照常开 shell；会话在运行中被切成 `read-only` 后仍继续接受命令。现在开 PTY 与逐次写入都要判定，控制字节（SIGINT、关闭）保留例外。
- **`workspace-write` 没有收窄到会话自己的工作区**：可以写同一主机的兄弟根，也能写另一台主机的已挂载根。现在与本地一致。
- **策略解析失败被说成「用户选了仅可查看」**：文案改为说明这是接线问题、切换模式无用。
- **拒绝文案不再假装能升权**：这一族工具没有 `sandbox_permissions` 参数，改为给出「切换模式」这条真实出路。
- **在对话框里拖选文字会关掉整个流程**（[#1](https://github.com/siqyka/dsh-ssh-workspace/issues/1)）：遮罩的关闭判据改为「按下与松开都落在遮罩上」，只认主键，忙碌时拒绝关闭。

### 文档

- 补全命令执行面受模式约束的说明，并修正多处与实现相反的描述（「浏览目录」被说成已屏蔽、文件右键菜单遗漏上传与下载、路由与列表计数错误）。
- 补全错误码表（新增远端专用的 `FS_OUTSIDE_WORKSPACE`，补上 `FS_ABORTED`）。
- 两个 README 的全部仓库内链接与头图改为绝对 GitHub URL，修复 npm 页面上 12 个链接与头图失效。
- 新增 `scripts/check-doc-links.mjs`，校验文档链接、锚点与仓库内绝对 URL。

## [0.2.4] - 2026-10-18

> 0.2.3 的 tag 已推送，但该版本从未出现在 npm 上，因此 0.2.3 与 0.2.4 的全部改动都在本版首次发布。

### 修复

- **CI 在 Node 20 上崩溃**：代码用了 Node 22 才有的 `Promise.withResolvers()`，而 `engines.node` 声明 `>= 20`、CI 也按 Node 20 跑。0.2.3 因此完全没有发布出去。现在改为自带的等价实现。
- **客户端 bundle 语法错误也能全绿通过**：测试把 bundle 当文本读，一个解析不过的文件照样满足全部断言。现在增加语法解析检查。
- **向输入框拖入一个文件会生成约 22 个同样的 chip**：模块重复加载时监听器叠加。现在一次派发只消费一次。
- **空态 / 加载中 / 错误占位符失去内边距与居中**：一条样式规则被误删，已恢复。
- **`forget` 模式只清清单、不清围栏**：留下「面板里已无这一行、运行时却仍拒绝一切操作」的工作区，用户无从恢复。

### 新功能

- **端口转发持久化**：映射写入 `dsh-ssh.json`，面板可开启 / 断开 / 删除单条映射，并有「启动时自动开启隧道」总开关。已存映射强制严格端口模式，本地端口被占用就报错而非静默漂移。
- **面板列表滚动**：主机、端口转发、已挂载工作区、已停用工作区四个列表超过 5 条时改为滚动视口。
- **工作区停用 / 启用**：卸载改为可逆。默认保留工作区记录与会话（侧栏那一行仍在、置灰），可随时重新启用。
- **停用即全局停机**：停用的工作区对除 SSH 连接外的一切操作都被拒绝——读、写、列目录、变更监视、执行命令、开终端、glob / grep / git、文件传输。
- **`ssh_workspace_enable`**：新增工具与路由，重新挂载并取消归档；启用前会验证远端目录仍存在。

### 变更

- `ssh_workspace_unmount` 默认改为 `detach`（原为 `deregister`），新增 `mode` 与 `archiveSessions` 参数。
- `forget` 归一化为 `deregister`，旧拼写仍被接受。
- 「同时删除工作区记录」现在会同时清掉持久清单与运行时围栏。
- 断开主机与手动断开端口现在行为一致：映射保留、不留下任何可解释为故障的提示。
- `POST /test` 改为探测后释放连接；被端口转发钉住的连接不释放。
- `POST /hosts/disconnect` 连带拆除该主机的端口转发。

### 文档

- 新增 [docs/features.md](./docs/features.md)：按能力域列出完整功能清单，每项写清做什么、依赖什么、缺依赖时退化成什么样。
- 删除 `docs/optimization-plan.md`、`docs/roadmap.md`、`docs/_template.md` 三篇内部流程文档。

## [0.2.3] - 2026-10-17

### 新功能

- **远端 PTY 终端**：终端在 `ssh://` 工作目录上开在远端，补齐了此前唯一的能力缺口。启动的是远端自己的交互式 `sh`，不复用本机方言的命令行。
- **浏览器端下载**：文件选择对话框的每个文件行新增下载按钮，经 `GET /download` 流式取回字节并交给浏览器保存。

## [0.2.2] - 2026-10-17

### 新功能

- **端口转发恢复**：远端 dev server 映射到本机 `http://localhost:<port>`，映射随 SSH 连接存活，断开即关闭。
- **持久远端会话**：新增 `ssh_workspace_shell`，`cd`、导出的变量与后台任务跨调用保留。
- **本机 ↔ 远端传输**：新增 `ssh_workspace_transfer`，经 SFTP 双向拷贝，分块流式、不经对话内容；上传先写暂存名再 rename 发布。
- **`ssh_workspace_exec` 支持后台任务**：`run_in_background` 返回 job id，可用 `job_output` / `job_kill` 收集与终止。

### 变更

- **推送式变更监视**：远端有 `inotifywait` 时改用事件推送，变更即时上报；否则回落到自适应退避的轮询。
- **能力探测**：挂载时一次性探测 `rg` / `git` / `inotifywait`，缺失项提前给出提示。
- **每主机传输选项**：新增 `agentForward`（私钥不落到远端）与 `compress`，`~/.ssh/config` 中的对应项同样被识别。

## [0.2.1] - 2026-10-16

### 修复

- **`exec` 断连被误判为正常完成**：通道关闭时既无退出码也无信号，不再当成命令成功。
- **rename 回退误删目标**：远端不支持原子改名时，删除目标前先确认其存在，避免失败时误删无关文件。
- **`listDir` 串行 N+1 往返**：目录列举从 1+N 次降为 1 次。
- **主机存储的跨进程写入**：加入兄弟锁文件，读改写整体进入临界区。
- **`StreamTail` 重复拼接**：缓存拼接结果。

## [0.2.0] - 2026-10-14

### 新功能

- 新增 `POST /api/dsh-ssh-workspace/hosts/disconnect`：关闭指定别名的连接；仍有在途操作时返回提示而不是强行断开。主机卡片内联展示「已连接」状态。

### 变更

- HTTP 路由增至 10 条。

## [0.1.24] - 2026-10-06

### 变更

- 包名由 `@dsh-community/dsh-ssh-workspace` 改为 `@shiqyka/dsh-ssh-workspace`，以便发布到 npm。

### 安全

- 存储中的密码与私钥口令改为加密保存；`dsh-ssh.json` 不再出现明文。
- 启动时自动把老版本留下的明文凭据加密回写。
- 密钥文件缺失或被更换时，连接明确报错并提示重新保存该主机，而不是静默认证失败。

## [0.1.23] - 2026-10-01

### 修复

- 会话中 `@` 远端文件引用点击后预览报「读取失败：Maximum call stack size exceeded」：远端根下的裸路径会在路由与插件之间无限互相委派。

## [0.1.22] - 2026-10-01

### 安全

- 主机密钥 TOFU：首次连接记录指纹，之后不符即拒绝连接；新增「忘记主机密钥」入口。
- HTTP 路由增加 Host 头校验（仅接受回环地址）与 POST `Content-Type` 校验。
- 凭据存储文件与目录收紧权限，写路径接入符号链接围栏校验。

### 修复

- `exec` 输出跨块 UTF-8 解码安全，按字节截断不再切坏字符。
- `exec` 连接断开且无输出时自动重连重试一次。

### 性能

- SFTP 元数据短 TTL 缓存（仅读路径）。
- 远端变更监视自适应退避。
- `streamText` 按需启用第二条 SFTP 通道，大文件流式读取不占用共用通道。

### 工程

- 新增冒烟测试套件与运行器、GitHub Actions CI、锁文件。
- 引擎连接参数可配（空闲超时 / 连接超时 / keepalive / 回收扫描间隔）。

## [0.1.21] - 2026-10-01

### 变更

- 端口转发功能整体屏蔽，相关文档同步移除，本阶段不发布该功能。

## [0.1.20] - 2026-10-01

### 新增

- `@` 文件引用支持远端工作区：输入 `@` 即可搜索并插入远端文件路径。
- 文件进任务：侧边栏文件树支持拖拽到对话框，或右键「添加到任务」，以 `@` 引用形式插入。

## [0.1.19] - 2026-10-01

### 修复

- 0.1.18 引入的工作区向上探测崩溃（报 `not a remote workspace path: "ssh://<别名>"`）。

## [0.1.18] - 2026-10-01

### 新增

- 终端命令远程化：会话工作目录为 `ssh://` 时，命令以 POSIX shell 语义在远端执行。
- 远端文件搜索（ripgrep）与 git 变更追踪在远端执行。
- 远端变更监视（轮询式）。
- 大文件流式读取。
- 端口转发（本地监听 → 远端目标；0.1.21 起屏蔽）。

## [0.1.17] - 2026-10-01

### 新增

- 远程路径以 `@` 形式显示：`ssh://<别名>@/<路径>`（仅显示层，功能拼写不变）。

### 变更

- 发布文件脱敏：示例主机名与用户名替换为占位符；移除已废弃的第三方插件引用。

## [0.1.16] - 2026-10-01

### 修复

- 界面文案参数（如 `{ms}`）不再原样输出。
- 对话页工作区按钮标记匹配修复。
- 连接测试结果 toast 调整为顶部居中显示。

### 变更

- 远程工作区标记图标放大并按图标边界裁剪。
- 界面细节打磨：控件悬停 / 按下与焦点态、菜单与对话框入场动画（尊重 `prefers-reduced-motion`）、空 / 加载态、数字等宽排版。
