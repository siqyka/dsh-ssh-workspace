# 更新日志

本文件记录 dsh-ssh-workspace 的版本变更。0.1.16 之前的版本为未公开的本地迭代，未收录。

## [未发布]

- **修复：图片/音视频/PDF 也会被会话接管**：点击判定原来只看文本白名单，于是 `logo.png` / `clip.mp4` / `manual.pdf` 在「会话中查看」模式下仍然落到宿主右栏，媒体查看器根本进不去。判定改为跟随 `viewerOf`——只要插件有查看器就接管，未知二进制（`zip`/`bin`）仍留给宿主。`file-preview-smoke` 145 项（新增 9 条「哪类文件被接管」）。

- **阅读列加宽到 1240px，模式按钮与正文右缘对齐**：会话里的 Markdown 预览与源码模式共用一条更宽的列（文字 1240px、含 22px 侧距共 1284px），窄窗口仍先压缩自己；「代码 / 预览」两个按钮从面板右缘移到这条列的右缘，按钮右边与正文右边落在同一条竖线上。

- **HTML 页面与媒体在会话里预览**：文件查看器按类型分派（`viewerOf`）——Markdown 仍渲染、HTML 走**沙箱 iframe**（脚本默认禁用，条上有「允许脚本」的显式开关并说明代价）、图片/音视频/PDF 走 `inline=1` 的字节路由、文本走源码、其它类型给信息卡。字节路由新增 **Range**（`bytes=a-b` / `a-` / `-n`，单区间；越界、倒序、多区间答 416）与真实 media type，视频可以拖动、PDF 可以内嵌；下载在 `inline` 之外仍保留体积围栏。HTML 的相对引用（`src`/`href`/`poster` 与内联 `url(...)`）由服务端改写成绝对字节路由 URL——本宿主注册表只有精确路径匹配，做不了 path 形状端点，改写拿到了同样的「相对资源天然可用」。新增无依赖模块 `lib/routes/byte-range.js` 与 `lib/routes/html-rewrite.js`（都可单测），路由 42→43、模块 69→72，`file-preview-smoke` 135 项。
- **代码块有了颜色和工具条，文件面板有了自己的关闭按钮**：围栏代码按语言上了色（注释灰斜体、字符串绿、关键字强调色、数字警示色；未标注语言时只做语言无关的三类，未知语言不会乱涂），语言名显示在卡片顶部的条上，右侧是换行与复制两个按钮。着色是「一本小词表」而不是完整语法：shell / js / ts / python / json / css 六族，够 README 阅读。另外标签被收进宿主的「更多视图」菜单时，标签条上没有 × 可点，所以文件面板顶部加了文件名与关闭按钮（与 Esc 等价）。


- **文档预览的排版对齐右侧预览，远端图片会显示**：会话里渲染 `.md` 改用插件自己的渲染器配一套照宿主抄的字阶（正文 14px/1.72、标题 32/16 间距、无边框代码卡、行内代码胶囊、引用竖条、表格只留横线）。**没有借宿主的 `MarkdownText`**：它的外观来自宿主自己 `import` 的 CSS module（哈希类名），插件 chunk 拿不到，渲染出来是无样式的裸 HTML——上一版正是因此「看着还是不好看」。**令牌作用域也补齐了**：文件面板不在 `.sshwsp` 面板根之下，`var(--sshwsp-*)` 原本全部解析失败（于是颜色、底色、边框、表格线都消失）；现在深色与浅色两处令牌块都带上 `.sshwsp-filepane`，面板与文档共用同一套字体与颜色。图片走 `imgSrc`：按文档目录解析相对路径，再用既有的 `download` 字节路由取图（流式、可取消、有体积上限），别名未就绪时仍是带 alt 的占位而不是坏图。`client.marks.js` 顺带维护会话→别名索引（`aliasOfSession`）。`file-preview-smoke` 103 项。

- **文件视图拆成独立 chunk**：上一版把会话里的文件视图全塞进了主包，`client.js` 涨到 6000 行。现在 `conversation.view` 的每文件注册、会话 roster（离开会话只注销不遗忘）、标签条装饰与点击切换、Markdown 文档面板、复用编辑器的内联编辑、合成器隐藏都搬进新 chunk `lib/client/client.fileview.js`（`apply` 里就取回，不等手势——第一次点击可能早于一次懒加载）；主包只留**同步**才需要的部分：扩展名白名单、文档判定、标签 id 与名字、以及文件树桥的取用（这些谓词由 `installFileView(host)` 注入 chunk，因为桥必须在 chunk 到达前回答点击）。`client.js` 6033 → 4983 行，手写 chunk 13 → 15 个。`file-preview-smoke` 96 → 97 项（纯判定仍从主包 lift；新增断言：chunk 从 host 取谓词而不是自带一份）。
- **文件标签排到所有内置视图之后**：`conversation.view` 的注册补上了 `order: 100`。宿主的标签条按这个数排序（「对话」0、「轨迹」10、「Lineage / Stats」40），而**没有 `order` 的条目会被当成 0**——上一版因此把文件标签插在了「对话」和「轨迹」之间。文件是从文件树随手打开的附页，不该混进主视图里，现在它总是排在行末，开一个、开十个都在最后。`file-preview-smoke` 96 → 97 项（新增：注册必须带 order 且大于内置视图的最大值）。

- **Markdown 文档在会话里有了排版预览**：`.md` / `.markdown` / `.mdown` / `.mkd` 与无扩展名的 `README` / `CHANGELOG` 现在打开就是**渲染后的文档**，右上角一颗胶囊形「预览 / 源码」二段切换（带眼睛与 `</>` 图标，选中段用强调色底），默认预览、一键回源码编辑。渲染器是插件自己的独立 chunk（`lib/client/client.markdown.js`，第一次打开文档才取）：标题分级、代码块、引用、有序 / 无序 / 嵌套 / 任务列表、表格（按分隔行取每列对齐）、分隔线、行内代码与强调都在；frontmatter 原样框在正文上方，原始 HTML 当文本（不执行），相对路径与 `javascript:` 链接只留文字，图片渲染成带 alt 的占位（远端图片没有可用 URL）。**有未保存改动时不允许切到预览**——预览读的是磁盘内容，切过去就会和标签不一致，细栏里直接说明原因。超过 400 KiB 只渲染开头并提示完整内容在源码里。`.mdx` 仍按源码打开（它带 JSX）。新增 `tests/markdown-smoke.mjs`（52 项：解析树的逐条断言——围栏嵌套、setext、列表嵌套与起始号、表格对齐与空单元格、行内优先级、链接白名单、HTML 不执行、图片占位——加上接线断言：独立 chunk、默认预览、脏状态阻断、同一条读路由、渲染上限、样式与双语键）。`tests/run.mjs` 套件数 87 → 88。

- **行号与正文之间留出了空隙**：行号右对齐、位数从 1 位变到 6 位，而主题里 `.cm-gutterElement` 的右内边距只有 6px，三位数就已经顶到正文第一个字符（读起来像 `12foo`）。现在右内边距 14px、行号栏左侧再收 8px，正文自己不再额外缩进——数字左长、空隙不变。`file-editor-smoke` 228 → 229 项（新增：生成物里这三个数值都在，改了主题忘了重新生成会红）。

- **切回工作区，文件标签还在**：上一版把标签按会话记账了，但切换**工作区**时整个会话壳会被换掉——地标 `[data-conversation-session]` 是随着一棵新子树一次性插入的，只听属性变化的观察器永远收不到，于是回到原来的工作区时标签再也不会注册回来。现在观察器同时盯子树重建（按 `requestAnimationFrame` 合帧，名单为空时零开销，地标元素缓存复用）；另外切换工作区可能让宿主**重新声明 `conversation.view`** 座位、连带 dispose 掉里面注册的条目，所以座位回收时改成「只丢句柄、不丢名单」——`deregisterFileTabs()` 只清当前注册，`sessionOpenFiles` 与每个会话最后打开的文件都留着，新座位或下次回到该会话时原样注册回来。`file-preview-smoke` 92 → 96 项（新增：重建的会话壳也要认出来、一次判定只读缓存的地标、没开过文件时不扫、座位重声明只丢句柄不丢名单）。

- **不自动换行时，长行不再压在行号上**：CodeMirror 的行号栏是 `position: sticky` 钉在左边、正文从它底下横向滚过去的，而主题里行号栏的底色一直是 `transparent`，于是关掉「自动换行」横向滚动时，长行会直接从行号上压过去、两行字叠在一起。现在行号栏取 `--sshwsp-gutter-bg`（右侧面板里是 `--sshwsp-surface`，会话内联时是会话底色 `--sshwsp-bg`），不透明地挡住下面的正文。`file-editor-smoke` 227 → 228 项（新增：行号栏底色不透明，且两个落点各自的取值来源都在样式表里）。

- **底栏钉住、标签跟着会话走**：编辑器底部那条「行数 / 自动 (LF) / 自动换行 / 保存」原本会被会话的滚动条带走——宿主在会话活跃时给视图区写的是 `flex: 1 0 auto`，视图被内容撑高，整列跟着 `.scrollBody` 一起滚。现在文件视图**按滚动区定高**：量滚动容器，高度取到**输入框那条带子的上沿**为止（先认座位 `[data-composer-seat]`，认不到退回输入卡 `[data-composer-card]`，都不可见才用整个 `clientHeight`），所以输入框显示时文件视图停在它上面、收起时占满整列；正文自己内部滚，底栏永远停在面板底部。`ResizeObserver` + `window.resize` 重算，隐藏 / 显示输入框时由设置那一侧直接回调重测（它不改变滚动容器尺寸，观察器抓不到）。文件标签现在**属于打开它的那个会话**：`conversation.view` 是插件级注册表，之前在一个会话打开的文件会出现在所有会话的标签条上；现在插件按会话记账（`sessionOpenFiles`），切换会话时把上一个会话的注册全部注销、把新会话开过的文件重新注册回来——**注销不是关闭**，切回来还是同样那几个标签、还是原来那个文件。会话地标 `[data-conversation-session]` 用属性观察器盯着，标签条整棵重建时补一次判定。隐藏输入框的座位现在优先认宿主自己的 `[data-composer-seat]` 标记，认不到才退回「最近的 sticky/fixed 祖先」。`file-preview-smoke` 84 → 92 项（新增：面板按滚动区定高、按输入框带子上沿收边、显隐输入框触发重测、座位按宿主标记定位、文件按会话记账、离开会话只注销不遗忘、地标靠观察而不是轮询、根节点重建仍落在正确会话、关闭同时清掉各会话的同名记录）。

- **文件标签排得下一行、`.md` 也能进来、输入框可以收**：文件标签统一**固定宽度**（132px，其中 22px 留给 `×`），`×` 改成绝对定位钉在标签右侧——手加的 `×` 原本会把标签撑成两行（名字一行、`×` 一行），名字长短不一时整条标签行还会抖。`.md` / `.markdown` / `.mdx` 与无扩展名的 `README` / `CHANGELOG` 现在也由会话里的文件视图打开（按文本、可编辑、带语法高亮），不再跳去右侧的排版预览；图片、PDF、二进制与未知后缀仍归宿主。`preferences` 新增 `hideComposer`（默认**开**）与设置「文件查看」里的「文件标签页里隐藏输入框」：输入框是视图区下方的一条 sticky 座位、**不属于任何视图**，所以文件标签开着时它本来会留在最底部——打开时把整条输入区（卡片 + 渐隐遮罩 + 内边距）收起，关掉就保留输入框边看文件边对话；改开关立刻生效，关掉文件或切回「对话」时恢复。座位由「从 `[data-composer-card]` 往上找最近的 `position: sticky|fixed` 祖先」定位，样式按 `[data-sshwsp-composer-off]` 收起，宿主改 CSS module 类名不影响。`file-preview-smoke` 79 → 84 项（新增：`.md` 与无扩展名 README 被接管、`×` 固定在右侧且标签固定宽度、`hideComposer` 的默认 / 归一化 / 单独保存、座位隐藏只在文件视图且尊重开关、卸载时恢复）。
- **每文件一个标签，且看起来是原生视图**：会话窗里的文件不再共用一个「文件预览」标签——**每点开一个文本文件就多一个同名标签**（`app.ts` 的标签就叫 `app.ts`，保留大小写、去掉查询串与尾部斜杠），可同时开多个、点标签在它们之间切换，各自的滚动位置 / 草稿 / 未保存状态按「会话 + 文件」分开记；关掉一个只收它自己的标签、落在仍开着的那个文件上，关掉最后一个时会话才回到「对话」，同一个文件再点不会开出第二个。面板也不再是盖在会话上的一层浮层：`FileEditorPanel` 新增 inline 模式（不量矩形、不 `position: fixed`、不进 `modalLayer` portal，`flex: 1 1 auto` 铺满宿主 `.viewArea`，背景透明、无边框 / 圆角 / 阴影，不再重复文件名与路径，也没有「取消」按钮），与「对话」视图读起来是同一屏。宿主的标签 DOM 既没有 data-id 也没有关闭按钮，所以插件按「同名标签里的第 n 个」认领并打 `data-sshwsp-tab-path`，再用 MutationObserver 往标签尾部注入 `×`；`Esc` 与 `×` 等价（有未保存改动先确认），窗口太窄标签被收进「更多」菜单时由插件打开菜单再点同名项。切回「右侧文件树」偏好会一次性收起全部文件标签。`preview.tabLabel` / `preview.empty` / `preview.close` 三条文案退场，新增 `preview.tabClose`；`fileview.hint` 改成「每点开一个文本文件多一个同名标签」。`file-preview-smoke` 66 → 79 项（含反向验证：每文件一注册、按文件 dispose、同名不串台、关一个落回另一个、inline 渲染与 in-flow 布局、inline 不再重复标签已有的标头），`presentation-tokens-smoke` 78 项（新增 `--sshwsp-radius-none` 令牌，规则体里不再写裸 `0` 圆角）。
- **主机硬停用（电源开关）**：存储主机卡片左侧新增 `role="switch"` 开关。关＝**立刻**关闸并拆掉这台主机上的一切——引擎准入（`HOST_DISABLED`）、在途命令与通道、池化连接、持久 shell、正/反向转发、变更监视、远端终端；顺序是「先持久化 `enabled:false`，再关闸，再拆」，持久化失败则什么都不动。开启只写回并开闸，**不拨号**。关之前确认框按 `/hosts` 刚读到的实时计数列出会被打断的资源，并写明工作区与会话不会被删除（它们属于宿主，插件只按 `/status.disabledHosts` 置灰，真去用时由路由 409 说明原因）。`~/.ssh/config` 主机没有开关（没有记录可写），`/hosts/test` 与 `/hosts/reconnect` 对停用主机回 409；`/hosts` 每行新增 `resources`。新路由 `POST /hosts/toggle`（路由 39 → 40），新模块 `lib/hosts/disable.js`，新 `host-disable-smoke` 49 项；`browser-rows-smoke` 28 项、`file-preview-smoke` 66 项、`repo-checks-smoke` 141 项。
- **目录选择器可列出文件**：面板「设置」→「文件查看」新增「同时列出目录里的文件」（默认关）。打开后两个 picker 的 `/ls` 不再带 `dirs=1`，改走一次往返的全量列目录（目录优先、同一套截断），文件行是**纯展示的 div**——不可点、不可双击、不参与「选中的目录」，只回答「这个目录里有什么」；目录行的单击 / 双击 / 键盘语义不变。`preferences` 节新增 `showFiles`（`POST /preferences` 校验布尔、坏值落回默认）。
- **命令审计落盘**：内存里的审计环现在同时写到 `$DSH_HOME/dsh-ssh-workspace/dsh-ssh-commands.json`（`{version:1, entries:[…]}`）。变更后 500 ms 防抖、暂存文件 + rename 原子替换、0600 / 目录 0700、内容未变不重写；重启时读回并按容量裁剪，读回的行与实时行走**同一个清洗器**（脱敏、字段上界一致）。四条上界：保留条数、字段（命令 400 / 错误 200 / session 64）、无 stdout/stderr、文档 512 KB（超了丢最旧的行）。写入失败只 warn，绝不让一份日志弄失败它描述的那条命令。新模块 `lib/engine/command-log.js`。
- **终端击键进入审计（近似）**：远端终端里敲的命令也进审计（`channel: 'terminal'`）。`RemoteTerminalHandle.write()` 在通道**接受之后**把字节喂给一个按字节的状态机：可打印字符累积、退格 / Ctrl-U 删、Ctrl-C 丢弃该行、回车成条，方向键 / 功能键的 CSI、SS3 与 OSC 序列整体跳过。不模拟行编辑器，所以 Tab 补全、历史展开、多行 here-doc 只是近似；`exitCode` 记 null，`sessionId` 取自 `spec.env.DSH_SESSION_ID`。新模块 `lib/patch/terminal-typing.js`。
- **审计 tab 与保留条数**：面板第四个 tab「审计」按时间倒序列出全部保留命令（时间 / 主机 / 通道 / 状态 / 命令 / 错误），可按工作区过滤（用 `/status` 的 `sessionIds` 本地投影）并可手动刷新；空态区分「还没有记录」与「这个工作区还没有」。保留条数 1–2000（默认 200）就在这张表上方改，改小立刻裁剪已记录的行。行的数据来自新 `GET /audit`（不挤进每 2 秒一次的 `/status`），写入走新 `POST /audit/settings`（先落 store 再改环）。新套件 `command-log-smoke` 78 项；路由 40 → 42、`lib/` 模块 64 → 67、套件 86 → 87。

- **连接意图持久化 + 失败可见性**（借鉴 fork 2f570b3）：面板每台主机新增「开机自动连接」勾选框，**它只是标记，不操作连接**——勾选与取消都走 `POST /hosts/intent`，只写 `dsh-ssh.json` 顶层 `autoConnect` 别名数组：勾上不拨号，取消也不断开当前会话（要连用「立即重连」、要断用「断开」）。勾选态只读意图、不读 socket：连着但从未勾过的主机显示未勾选，勾过而当前没连的主机仍显示勾选。别名既不在存储、也没有对应 `Host` 块时路由回 404，免得每次启动去拨一个没人定义的主机。改名带走意图、删除一并清除；下次启动稍后的 tick 上**串行**用 `acquire`（非 `retryNow`，不违背「自动开隧道」总开关）连回，单个失败记诊断不中断其余。同一意图登记为引擎的 `addWantedCheck`（掉线后台重拨）与 `addKeepAliveCheck`（空闲 30 分钟回收豁免），否则自动连回的连接会被回收。`engine.failures` 记住每个别名最后一次连接失败（成功 / 主动断开清除），`/status` 与 `ssh_workspace_status` 新增 `autoConnect` / `connecting` / `failures`，卡片在 fatal 失败（不武装重连器）时显示红点 +「连接失败」与原因——此前这种失败除了诊断环没有任何用户可见痕迹。`connection-intent-smoke` 23 项、`host-card-smoke` 52 项、`routes-smoke` 311 项。
- **主机配置迁入插件私有目录**：可编辑的 `dsh-ssh.json` 与加密密钥从 `$DSH_HOME` 根目录移到 `$DSH_HOME/dsh-ssh-workspace/`。旧位置仍可读，首次写盘自动迁移整个文档（保留主机、密钥密文与未知段），不丢数据、无需手工搬文件；显式传入路径的调用（测试 / 备用安装）不受影响。`secrets-smoke` +10（26 → 36）。
- **点击文件在会话窗查看**：右侧文件树的文本类文件现在开在**会话顶部标签条**里（与「对话 / 轨迹 / Git 图谱 / billion 上下文」同排），内容占满整个会话区，**不新增按钮**——面板「设置」→「文件查看」二段式切换，默认「右侧文件树」即现行为，升级零变化。标签懒注册：第一次打开文件才出现，关掉最后一个时自身消失；标头是文件名 + 完整路径 + `×`，`Esc` 与 `×` 等价。`.md`（后来也改由会话内打开，见上）、图片、二进制与带修饰键的点击仍走宿主右侧预览（`Ctrl/Cmd+click` 是逃生口），普通单击由既有的树捕获桥在捕获阶段接管，读取复用 `read-text`（远端 / 本地同一条路）。**会话里的这份视图后来可编辑了**：复用右侧预览同一套 `FileEditorPanel`（CodeMirror 6 + 语法高亮、行尾 / BOM 保真），按 `version` + `revision` 双令牌经 `write-text` 就地保存，别人改过给冲突条（重载优先、覆盖二次确认）；编辑器矩形以会话容器自己量取、与右侧面板按 `session × surface` 分开持有（同开不互关、草稿共享），未保存时 `×` / `Esc` 先确认。`file-preview-smoke` 增至 72 项。偏好写进 `dsh-ssh.json` 的 `preferences` 节（`POST /api/dsh-ssh-workspace/preferences` 写、`/status` 下发，坏值读入时落回默认），与 `forwards` / `passthrough` 同一条 store 通道。**旧落点与它的第一版设置已移除**：`conversation.input.dock` 上方的面板与 `[data-composer-card]` 隐藏规则随旧落点一起删掉；`preferences.hideComposer` 当时退役，后又在「文件标签页里隐藏输入框」名下回来了（见本节第一条），因为输入框本来就不属于任何视图。

## [0.4.0] - 2026-11-24

这一版整版重构：浏览器端文件编辑、客户端分层拆 chunk、`lib/` 按能力域重组，并修掉一批围栏、并发与可访问性问题。

### 新增

- **浏览器里编辑远端与本地文件**：预览头部铅笔打开就地覆盖正文的编辑器，远端与本地共用 `read-text` / `write-text` / `edit-text`（路由 33 → 36）；`version` + `revision` 双令牌，409 默认重载、覆盖二次确认，无 `force`；行尾 / BOM 原样写回，2 MiB 上限，审计不带正文。
- **编辑器内核、标签与查找**：按需加载 CodeMirror 6（15 种语言），取不到回落 `textarea`；窗口化语法高亮层（输入法 / 换行 / >512 KiB 时关闭）；多标签草稿按 buffer 保存；`Ctrl/Cmd+F` 字面量查找、`Esc` 先关查找条；行尾策略选择器，`beforeunload` 防丢草稿。
- **更多文本能读能写**：`lib/routes/text-encoding.js` 按 BOM → NUL 提示 → 严格 UTF-8 → 严格 GB18030 嗅探；修掉 WHATWG 标签被 `catch {}` 吞掉导致中文 UTF-8 误报 GB18030 的 bug；UTF-16 按原编码写回、GB18030 只读；>2 MiB 按 128 KiB 只读分页；仅 mtime 变化的 409 比摘要后重发一次。
- **慢链路读文件快一个数量级**：`lib/fs/read-window.js` 用 256 KiB × 4 并发窗口读（2 MiB 从 49.7 s 降到 6–8 s），修掉中段短读被当 EOF 的截断 bug；本地 probe 只读 8 KiB 样本。
- **文件树与停用行的新动作**：新建文件走 `POST /create-file`（0 字节、不自动打开）；不可编辑时铅笔改 `aria-disabled` + 红点 + `title` 理由；「已停用」每行可两步确认删除（`deregister`，会话归档）。
- **目录选择器：单击选中、双击进入**：两个 picker（浏览目录 / 新建远程工作区）的目录行左键单击改成**选中**（高亮 + `aria-current`），双击仍进入下一级；键盘第一次激活选中、再按一次进入。挂载与创建改用**选中的目录**，没有选中时用正在浏览的目录，并新增一行「将挂载 / 将创建：<path>」与按钮 `title` 说明目标；选中随列表刷新清空，`client-shape-smoke` +5、`path-preview-smoke` 74 → 85（真实渲染两个对话框，断言 POST 里的 `remotePath`，含反向验证）、`browser-rows-smoke` 19 → 23、`presentation-tokens-smoke` 75 → 78（后者学会读三元类名，否则新类会被误判为「未渲染」）。
- **删除工作区时分开问两件事**：已挂载与已停用两段列表每行都有「删除」，确认行里两个勾选框分别决定「删除工作区」（勾上走 `deregister`，不勾只 `detach`）与「删除会话」（归档，不删文件），两个都不勾时确认按钮禁用；「卸载」则不再带任何选项，固定保留记录与会话，`client-shape-smoke` +19。
- **面板三个 tab**：主机 / 工作区 / 设置，只渲染选中 pane，APG 键盘语义、模块级记住选中项、720px 居中列。
- **目录选择器跟随输入**：同目录前缀本地收窄，尾斜杠停顿 200 ms 只列一次目录；`GET /ls` 的 `dirs=1` 一轮往返、上限在远端、形状不符回退 SFTP，单子目录链折叠最多 16 层、软链不折。
- **远端技能发现（默认关闭）**：`.dsh/skills` / `.agents/skills` 由 `skill` 工具 rank 250 发现，规范化远端路径 + 自写 frontmatter 子集 + 读取过围栏；主机白名单、有界（200/32/64 KiB/5 s），读失败标 `complete: false`。
- **主机删掉后工作区标记已废**：行首红感叹号（`.sshwsp-hostgone`），仅当 `/hosts` 完整读过仍找不到 alias 时标，拉取失败不标；删除后 `refresh()` 立即生效，`client-shape-smoke` +10。

### 变更

- **右键菜单一份模型**：`rowMenuModel` / `blankMenuModel` + `renderMenuDom`，宿主 `ctx.contextMenus` 优先、否则自绘；只读策略按会话 + 根缓存 30 秒、上限 32；诊断报告按行着色；停用行只灰化 + SVG 电源标记，`republishBootNames()` / `installMarkWakeups()` 同步刷新，不再需要重载。
- **浏览器半边按层拆 chunk（主包 12,604 → 4,343 行）**：五个懒加载 chunk + 七个启动期 chunk，顺序 kernel → 图标 → 其余（marks 在 factory 期解构常量）；碰到模块级 `let` 的声明留主包；借名字走 `require('<插件 id>')` 接缝，叶子块无 seam。
- **`lib/` 按能力域重组**：八个域（`core` 零出边、环 5），`routes.js` / `patch-*.js` 各进子目录；四处「读不到答 0」改显式报错；注释 27,457 → 25,905 行。

### 修复

- **传输与写入围栏**：下载受 `ctx.sandboxPolicy` 约束（fail closed），写流错误不再吞掉发布截断文件；R-02…R-10（status provenance、mode 0644、JSON 413、统一拒绝形状、上传只 mkdirp 一次、键盘共用策略缓存、小文件 preload 等）。
- **转发与连接**：反向转发加 hold / close 钩子；保存转发按 id 复用；abort 在拨号前检查并释放监听；监视上限 64（`FS_TOO_MANY`）。
- **主机表单里可以先测再存**：底栏「取消 / 测试 / 保存」，`POST /test` 新增 `form` 分支——按屏幕上未保存的字段构造描述符（`store.descriptorForForm`，编辑时空口令沿用已存凭据）并 `engine.probeDescriptor` 真拨一次，成功即 `destroy()`：**不写存储**（主机记录与 `knownHosts` 都不动；主机密钥只比对不 pin，TOFU 仍由真正的连接完成）、不入连接池、不启动重连。保存与测试共用同一个 `buildPayload()` / `validate()`，结果以 `role="status"` 就地显示，表单任一字段改动后旧结果立刻失效；`engine` 抽出 `#dial()` 让探针与真实连接走同一握手路径，`fake-transport-smoke` 43 → 55（含「存储文件逐字节不变」）、`routes-smoke` 297 → 303、`client-shape-smoke` 402 → 417。
- **主机卡片的元信息行改成「就绪」打头**：`密钥/密码/agent · 就绪 · 来源` → `就绪 · 密钥 · ~/.ssh/config`。就绪是这行里唯一能让连接直接失败的事实，原来夹在中间，密钥缺失时卡片先念「密钥」再把警告推到余光里；`host-card-smoke` 34 → 38 钉住顺序。
- **与 `~/.ssh/config` 同名的主机不再能删或改**：存储记录若与某个 `Host` 块同别名，`listing()` 带上 `configAlias: true`，面板不给编辑 / 删除并打印 `hosts.configShadow`（删掉存储条目只会露出那个块、主机「自己回来」；改它会让本机其它 ssh 客户端解析到的东西悄悄变样）；`POST /hosts/delete` 与 `POST /hosts/save` 都改成先查配置别名并答 409，改名到空闲别名仍放行，`host-listing-smoke` 57 → 61、`host-card-smoke` 30 → 34、`routes-smoke` 290 → 297。
- **嵌套工作区停用不再误伤父目录**：围栏判据改为 `isDetachedTarget`（落在停用根下且不被任何在服务的根覆盖才拒绝），`protocol-smoke` 27 → 36、`detach-smoke` 加真实嵌套用例。
- **启用、标记与编辑器细节**：启用不再 `createCanonical` 新建记录；`ssh_workspace_hosts` 三态；保存回包固化 `savingPath`；文件大小守卫改 `EDIT_MAX_BYTES + 1`；`apply()` 的两处监听并入 disposer。

### 测试

- 内存 SFTP / 宿主 / 引擎 / 渲染替身收敛，裸检出可跑远端读写成功路径；三条长期红清除，partial 逐个打印跳过段。
- `text-encoding` 39 项与 10 个反向变异；`doc-numbers-smoke` 26 → 42；`dirs-listing` 改问同一 shell 的 `pwd -P`。
- 套件合并 104 → 81（13 组、断言不减），此后又新增表现层守卫等套件至 83；当前裸检出 73 passed / 3 partial / 7 skipped / 0 failed（5838 断言），lint / check:editor / check:docs / check:client-map 全绿。

## [0.3.6] - 2026-11-19

### 变更

- `lib/` 顶层模块 62 → 36、总数 83 → 57：十六个模块按「一件事一个文件」合并，逐组独立提交；套件 / 路由（33）/ 工具（11）/ 补丁（7）数不变，import 环 6 → 5。
- `escapeRegExp` / `positive` / `shellQuote` 并成 `lib/core/shared.js`，`tar` + `zip` 并成 `lib/transfer/archive.js`，`ssh-config` + `match-eval` 合一；`capabilities` / 七个 patch / `mode-gate` 与 `command-policy` 不合并。
- 合并带出两处真缺陷：`store.js` 两个 `dshHome()`（写 A 读 B）、`shell.js` 的 `quote` / `shellQuote` 并存（`ReferenceError`），均已修。

### 修复

- 「新建终端」菜单列本机 shell、远端跑 `sh -l`：新增 `lib/remote-shells.js` 接管 `shells()`，`ssh://` 一次 `command -v` 探测（`$SHELL` 优先、按家族去重），失败抛错可重试，按主机 + 代次缓存；启动侧用探测到的绝对路径 + `-l`。
- 沙箱 launcher（`landlock-run` / `bwrap` / Windows ACL runner）先剥再判 shell 家族。
- 新增 `modalLayer()`，五个弹窗 portal 到 `document.body`，滚轮可达；对话框表单固定、列表独滚动；`GET /ls` 加 `dirs=1`。
- `injectStyles()` 复用既有 `<style>` 改写，只改 CSS 不再需整页刷新。

### 测试

- 新增 `remote-shells-smoke`（49 项），`terminal-smoke` 40 → 43 项。

### 文档

- `features.md` seam 6 → 7，`architecture.md` 新增接管 `shells()` 一节，其余文档同步。

## [0.3.5] - 2026-11-19

### 新增

- `seams[]`：`installSeam()` 统一六个 patch 与 shell 接管，`installed` / `absent` / `failed` 三态由状态工具、`/status`、诊断给出。
- `lib/patch-sandbox.js` 把 `ctx.sandbox.confine()` 的远端 `workspaceRoot` 换成本机替身目录；`lib/patch-ptc.js` 接管 `ctx.ptcRuntime.resolve` 只换远端 cwd。
- `unwrapSandboxArgv` 多认打包版 exe 与 runner 形状；普通远端路径按三条判据路由到 git。
- 提交历史遮蔽官方 tab 下半 slot，`GET git-history` 只读、可折叠并记住状态。
- 「添加工作区」两段式（本地 / 远端）；会话归属自动补偿，重建索引后补 `attachSession`；侧栏分组与行自动回来，省掉「禁用 → 重启 → 启用」后的重启。

### 修复

- 浏览器终端按 `ssh2@1.17.0` 修三处（`setWindow` 无回调、`_write` 非 open return、`terminate()` 不等 close）；补 `inspectActivity`；按白名单选 shell。
- 「变更请求」上半显示 i18n key：`officialTranslateSeat()` 绑定官方条目 locale；`--namespace` 逐字保留；移除终端常驻 trace；内容采集失败记 `degraded`。
- 接缝装不上改记 `failed` 不让插件下线；`ownership` 统一由 `ownershipSnapshotCopy()` 拷贝、面板 `/status` 也带；补偿跳过 `subagent`、无条件重建、各 await 有预算。

### 测试

- `terminal-smoke` 23 → 38、`diagnostics-smoke` 49 → 65；新增八个套件（ownership 153、session-catchup 58、commit-history 158 等）；反向验证 50+ 处转红。裸检出 91 套件 4632 项。

### 文档

- `architecture.md` 新增三节、`troubleshooting.md` 新增四条，套件数统一为 91 / 4632 / 4882。

## [0.3.4] - 2026-11-14

### 新增

- 显式本机 scheme（默认 `local:`）：`local:/…` / `local:F:\…` 无条件本机读，存 `dsh-ssh.json`、保存即生效，未启用前缀明确拒绝。
- `@` 裸 POSIX 路径远端优先、miss 回退本机（默认关，仅读动词，附 `[ssh-workspace]`）；新增路由 `POST /passthrough/settings` 与 `/status.passthrough`。

### 变更

- scheme 规则服务端下发：前缀 ≥3 字符、`SCHEMES_IN_USE` 保留名表；存量不可用值降级并给出可见提示。

### 修复

- 空白处右键作用域收窄到 `[data-files-page]`；反向验证脚本先落备份、恢复挂信号；恒真大小写断言改为 `win32` / `darwin` 成对断言。

### 测试

- `local-passthrough-smoke` 88 → 231、`client-shape-smoke` 307 → 324、`tree-blank-menu-smoke` 16 → 40；裸检出 83 套件 4259 项。

### 文档

- `ui.md` / `protocol.md` / `troubleshooting.md` / `features.md` / `architecture.md` 与两个 README 同步。

## [0.3.3] - 2026-11-13

### 修复

- `ssh://` 会话读不到聊天框附件：新增 `localPassthrough`（默认 attachments / plugins），远端分支前做词法前缀直通，整目录 `$DSH_HOME` 被拒。
- `@F:\…` 引用：从会话历史恢复 `@` 引用，只认 Windows 盘符 / UNC，上限 256。
- `LOCAL_PASSTHROUGH_GUIDANCE` 写明直通只覆盖 `ctx.fs`。

### 测试

- 新增 `local-passthrough-smoke`（88 项），反向验证 20 confirmed / 0 not。

### 文档

- README 新增「本机路径直通」，`features.md` / `troubleshooting.md` / `architecture.md` 同步。

## [0.3.2] - 2026-11-11

### 新增

- 系统文件拖入远端「文件」树上传：落点决定目录，只收文件，复用 `enqueueUploads`。
- 本地树空白处菜单（新建文件夹 / 复制路径），`POST /mkdir` 按拼写分支、`realpath` 防逃逸。
- 多选整批拖入输入框；`caretRangeFromPoint` 按落点插入引用，不可映射时回退追加。

### 修复

- 新增 `lib/core/tool-schema.js`，`defineTool` 按 schema 投影返回值并记丢弃，`tool-results-smoke` 真跑 `execute` 断言丢弃为空。
- 同名工作区误标：本地 / 远端标题都存在时不标任何一方。
- 拖动插入后光标落在 chip 之后。

### 测试

- 新增五个套件（tree-blank-menu 16、tree-drag 24、tree-os-drop 60、composer-drop-point 42、tool-results 33）；裸检出 82 套件 3759 项。

### 文档

- README / `ui.md` / `protocol.md` / `tools.md` / `development.md` 同步。

## [0.3.1] - 2026-11-08

> **版本归属注**：`v0.3.0` tag（2026-11-06）发布时，本文件顶部仍是 `[Unreleased]`，其中已包含断点续传、目录下载、传输校验、状态来源、`ProxyJump` 建链、反向转发、`Include` / `Match`、命令确认策略、最近使用等条目；随后发 `0.3.1` 时整段被标成了 `0.3.1`，本文件因此没有单列 `0.3.0` 段。也就是说下面这些条目里有一部分实际在 `0.3.0` 就已交付。当时的原始记录见 `git show v0.3.0:CHANGELOG.md`。这里保留原段落结构、不拆分重写，是因为两版条目并非一一对应（多项在 0.3.1 时被重写或合并），硬拆反而会把 0.3.1 真正新增的条目（树多选、批量下载、行内重命名等）误归到 0.3.0。

### 新增

- 宿主「文件」树多选（Ctrl/Cmd 切换、Shift 区间、按会话 + 根记忆）；菜单文案固定，`resolveTargets` 唯一决定目标。
- 批量下载只问一次位置；行内重命名 / 新建 / 删除（`POST /rename` / `delete` / `mkdir`）；行右键菜单 220px 收窄。
- 统一传输队列（主机 1 / 全局 2，五态、重试补分片 + 双校）；速度与聚合进度环；`POST /upload-chunk` 分块、断点续传、目录下载（默认 zip、`?format=tar`）。
- `ProxyJump` 逐跳建链（`ProxyCommand` 仍拒绝）；反向转发、Include 跟随、Match 求值、命令确认策略、最近使用、状态 live / cached / stale。

### 修复

- 同一路径监视两次：按 `alias + 规范化路径` 建注册表、引用计数；错误提示统一 7 秒窗口可重试；分块 JSON / RFC 6266 / 2 小时超时；断线仅在有重连循环时重试、shell 记住起始目录；虚构能力移入 `UNPROBED_CAPABILITIES`。

### 移除 / 变更

- 清理 27 个零引用 i18n 键（335 → 308）；「浏览目录」只保留浏览挂载；关对话框不中断传输；唯一上传通道是 `POST /upload-chunk`。

### 测试

- 新增 `selection-targets-smoke`（77）、`toast-smoke`（87）、`watch-sharing-smoke`（36）、`transfer-retry-smoke`；裸检出 76 套件 3759 项。

### 文档

- 三辑优化文档合并为 `optimization-and-future03.md`，删三篇临时专题。

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
- **补丁的宿主契约成表**（O-15）：新增 `lib/core/upstream-contract.js`，每个 `patch-*.js` 声明它碰的宿主符号与退役判据。

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
