# 打磨记录 · 远程工作区面板方向初稿

> **本目录已清理**：方向稿 HTML（`dir-*.html`）、生成脚本（`build_*.py`）、`directions.md` 以及全部截图（`shot-*.png`、`review/*.png`，共 122 张）均已删除，只留成稿 `../远程工作区面板-美化版.html` 与本记录。下文提到的这些文件不再存在，保留文字仅为记录当时的判断。
>
> `design_lint.py` 的截图/对比需要 Python 版 playwright，本机未安装，已跳过；改用 Chrome headless 直接截原生尺寸图（`shot-*.png`），逐张肉眼审视。

## 第 1 轮（第一轮三版，发现问题并修掉）

1. 截图整体发白：`.pane` 的淡入动画在无头截图里被定格在半透明帧，状态色读不准 → 移除入场动画。
2. 「细节 980px」深链用 query string 未生效 → 改为 hash 深链 `#<tab>-wide`。
3. 主操作与危险操作在窄栏里层级接近 → 主操作实心强调、危险操作只描边红字。

## 第 2 轮（同 Rams 配色的三版骨架）

三版使用**逐字相同**的 Rams 配色 token，只改骨架。逐张看过截图：

- **Ledger**（`shot-dir-rams-ledger.png` / `-hosts.png` / `-set.png`）：发丝线清单，密度最高；左侧索引刻度给了扫读起点，蓝色地址链接感强。小屏下按钮左对齐不挤。看出的问题：4 台主机一字排开时，操作按钮与信息在同一行，宽视图里右侧略空——这是刻意的「清单」形状，不改。
- **Panels**（`shot-dir-rams-panels.png` / `-hosts.png` / `-set.png`）：衬底面板 + 独立小卡，呼吸最大；卡片内发丝线分隔信息与操作。看出的问题：窄栏里卡片左右边距偏大（28px），但换来的是「每台主机一块」的清晰分组，保留。
- **Rail**（`shot-dir-rams-rail.png` / `-hosts.png` / `-set.png`）：左竖排 tab + 右侧内容，选中项左侧竖条 + 浅底；窄屏（<620px）已验证自动回落成顶部横向 tab（`shot-dir-rams-rail.png` 是 480px 宽的真实回落形态），侧栏里无副作用。看出的问题：宽视图左侧导航列在内容很短时显空——这是导航常驻的代价，可接受。

## 第 3 轮（用户定稿：按 Rams，补区分与缺失界面）

用户逐字：「按rams来，但是设置的功能区看起来不够区分，还有浏览目录、下载面板等的界面没有做」。

交付正式版 `F:\GitHub\dsh-ssh-workspace\ui\远程工作区面板-美化版.html`，仍是 Rams 配色（token 与 dir-1-rams 逐字相同），单文件含 6 个界面：

1. **主面板**：主机 / 工作区 / 设置 三个 tab（APG tablist）。
2. **设置页功能区区分**：不再是一长条，改成 4 个各自带 `01`–`04` 编号标题栏的 `settings-block`（灰衬底标题 + 白正文）：01 端口转发 / 02 持久远端会话 / 03 文件引用设置 / 04 诊断报告。截图 `preview-panel-set.png`（已逐屏看过，四个区块一眼能分开）。
3. **浏览目录**对话框：路径头、筛选提示、单击选中双击进入、底部「挂载此目录」。
4. **新建工作区**对话框：名称 + 主机 + 目录树，不可写目录标红，命名与创建。
5. **传输队列**浮层（即用户说的「下载面板」）：400px 宽，进度按字节加权；目录归档无总量、只报已传字节并用扫描动画代替百分比；含等待 / 失败（带 SSHWSP-E-TRANSFER-UPLOAD 错误码与文案）。
6. **文件行菜单**：远端行含「下载到本机 / 上传文件到此目录」（带机制副标题），本地行只有「添加到任务」。
7. **文件编辑器**：盖在预览上的窄浮动编辑器，行号 + LF/CRLF + BOM + 保存；讲解 version/revision 双令牌与冲突处理。

截图核对时发现并修掉的问题：JS 里局部函数 `toast` 遮蔽了同名的 DOM 元素变量，导致 toast 永远不显示 → 重命名为 `toastEl` / `showToast`；`node --check` 验证内联脚本语法通过。所有截图逐张看过（主面板三个 tab、浏览目录、新建工作区、传输队列、行菜单、编辑器），无发白、无错位。

## 第 4 轮（用户指出主面板宽度不对）

用户：「主面板的宽度是不是不对」。核对 `client.styles.js:183/199` 与 `docs/ui.md:28` 后确认：真实面板是**铺满侧栏的滚动视口 + 内部 `margin:0 auto; max-width:980px; padding:72px 24px 40px` 的限宽居中列**，并有 `@container sshwsp-panel (width<420px / <320px)` 的窄栏回落；我原先做成了固定 420px 的悬浮卡，模型错了。

修正：正式版 `#s-panel` 改为 `width:100%` 的视口，内部 `.dw .panel-inner` 用真实的 `max-width:980px; margin:0 auto; padding:72px 24px 40px`；`.dw` 加 `resize:horizontal` 可拖右下角模拟侧栏变宽窄，并补了与真实一致的 `@container dw (width<420px / <320px)` 回落规则。

用 380 / 700 / 1200px 三档截图核对：1200px 时正文居中 980px、两侧留白均分，与 `.sshwsp-panel-inner` 契约一致；窄栏时行会 wrap。注意 headless Chrome 有约 500px 的最小视口，`--window-size=380` 实际渲染仍约 485px，所以 `<420px` 的容器规则在截图里看不到完整效果，但规则本身已按真实断点写好。

## 第 5 轮（用户四点微调）

用户：「主机区域的按钮放右下角 / 工作区的按钮居中靠右 / 设置中端口转发的提示，当鼠标放前面红灯时提示 / 设置中的功能划分风格保持和工作区的一致，功能区直接间距可以适当加大原来区分」。

1. **主机按钮右下角**：`.card.host` 改为纵向 flex，`.host-main` 占满宽，`.actions` 用 `align-self:flex-end; margin-top:9px` 落到卡片右下。截图 `verify-hosts.png` 核对通过。
2. **工作区按钮居中靠右**：`.mount` 内信息包进 `.mount-info{flex:1}`，按钮组 `.actions{margin-left:auto; justify-content:center}` —— 垂直居中、水平靠右。截图 `verify-work.png` 核对通过。
3. **红灯悬停提示**：端口转发第三条原本常驻的红字「连接已断开 · 保留开启意图，可一键恢复」改成红灯 `.dot-hint` 上的 hover/focus tooltip（`.dot-tip`，深色气泡 + 小箭头，`tabindex=0` + `aria-label` 兼顾键盘）。第一版气泡以中心定位，在左边缘被裁掉 → 改成左对齐 `left:-4px`、箭头 `left:8px`，强制显示后截图 `tipcheck2.png` 确认气泡完整落在卡片内。
4. **设置风格向工作区对齐 + 加大间距**：`.settings-block` 从「灰标题栏 + 白正文」的独立样式，改成与工作区卡片一致的描边 + `radius + padding:12px 14px`，标题栏改为无底色、仅底部一道发丝线（同 `.mount` 的语言）；块间距从 16px 加大到 24px，靠留白区分。截图 `verify-set.png` 核对通过。

四处均逐屏截图看过；`node --check` 通过。

## 第 6 轮（用户三点再修正）

用户用红框截图指出（m00686/688）：1) 主机按钮要在箭头指的右侧区域，按钮下方与「最近使用」文字同一条线；2) 工作区状态标识和文字太近；3) 设置风格仍没和工作区统一，「端口转发」类标题的字号/颜色不对，功能区整体不要框起来。

1. **主机按钮与文字同线**：上一轮把主机卡片改成纵向 flex、按钮独占一行落在最下，按钮底边比「最近使用」低一截。改为 `.card.host{display:flex; align-items:flex-end}`、`.host-main{flex:1}`、`.actions{align-self:flex-end}`，信息与按钮同处一行、按钮底边贴着卡片底边，和「最近使用」对齐。截图 `v3-hosts.png` 核对通过。
2. **工作区标识与文字间距**：上一轮为了居中把 `.mount-title` 写成 `display:inline`，标识与文字之间没了 gap。新增 `.mount-titlerow{display:flex; align-items:center; gap:10px}`，把 mark / hostgone / 标题包进标题行。截图 `v3-work.png` 核对通过。
3. **设置去框、标题同工作区**：彻底删掉 `.settings-block`（描边大框 + 自带标题栏），设置页改成和工作区完全一样的 `.section-head`（小号 12px muted 标题 + 右侧按钮/勾选）+ 独立行卡片（`.fwd` / `.session` / 表单 / findings），功能区之间靠 `.section-head` 的 22px 上边距分隔，不再整体套框。红灯 hover 提示保留。截图 `v3-set.png` 核对通过。

三处均逐屏截图看过；`node --check` 通过。

## 第 7 轮（用户：三处常驻提示改为悬停提示标志）

用户：① 「已停用的工作区」后加提示标志，把「这些工作区已卸载：文件读写与命令执行不可用；SSH 连接仍保留。」放到鼠标悬停提示上；② 「在 ssh:// 会话里用这个名字明确表示……同一时间只能配置一个前缀。」放到「显式文件引用 scheme · 本机路径前缀」标签的悬停提示；③ 「只对你在消息里用 @ 点名的路径生效……」放到「远端不存在时回退本机同名文件」的悬停提示。

- 新增通用 `.hint-mark`（小号 `?` 圆标）+ `.hint-tip`（深色气泡，`left:-6px; top:100%+8px`，箭头 `bottom:100%`），`:hover / :focus / :focus-within` 显示，`tabindex=0` + `aria-label` 兼顾键盘与读屏。
- 三处应用：工作区「已停用的工作区」标题、`field-label`「显式文件引用 scheme · 本机路径前缀」、`checkrow`「远端不存在时回退本机同名文件」；同时删掉三条常驻的 `.hint` / `.field-hint` 段落。
- 强制显示 tooltip 截图 `hint-work.png` / `hint-set.png` 核对气泡内容与位置；干净态 `clean-set.png` 确认 `?` 就位、布局清爽。设置页两个提示气泡在 720px 宽下会纵向叠在一起（因为两个 `?` 上下相邻且强制同时展开），实际使用一次只显示一个，无问题。

`node --check` 通过。

## 第 8 轮（用户：传输队列图标保持居中）

用户用红框圈出传输队列的图标列，要求「保持居中」——之前图标在每行顶部（与文件名同高），而多行行（logs/ 目录归档、old-assets.zip 失败行）的图标偏上。

把 `.qrow` 改成 `display:flex; align-items:center`，每行拆成「图标列 + `.qbody` 内容列」，图标 `align-self:center` 垂直居中；进度条与说明文字的 `margin-left:26px` 去掉（改由 `.qbody` 承担缩进）。截图 `queue-check.png` 核对：四行的上传/下载箭头都落在各自行的垂直中线，多行行也居中。`node --check` 通过。

## 第 9 轮（用户：行菜单改成项目当前使用的样子）

用户：「文件树行右键菜单 感觉还是现在的好看 我是说现在项目使用的」。

按真实实现（`lib/client/client.styles.js:630-645` + `lib/client/client.js:2862-2937` + `lib/client/client.kernel.js:2263-2300`）重画菜单：
- 尺寸：内容定宽（min 144 / max 360px）、整体圆角 16px、内边距 4px；每项单行、最小行高 34px、圆角 12px、图标 14px、标题 13px/20px 行高；分隔线左右各缩进 8px。
- 去掉了原型自创的第二行机制副标题，原因改放 `title` 悬停提示（如上传项 title=「/home/qiyk/projects · 同名覆盖」）。
- 每项换成项目真实 glyph 路径（addToTask 对话框+号、download/upload 托盘箭头、copy 双矩形、rename 铅笔、delete 垃圾桶），删除项红字。
- 项列表按真实 `rowMenuModel`：添加到任务 / 下载到本机 / 上传文件到此目录 / 复制路径 / 分隔 / 重命名 / 删除。
截图 `menu-check.png` 核对通过；`node --check` 通过。

## 第 10 轮（用户：整体颜色保持和 DSH 的白色）

用户：「项目整体颜色还是保存和dsh的白色吧」。

从 DSH 宿主 `E:\software\DSH\resources\app.asar` 里取出真实浅色 token 值：
- `--dsw-alias-bg-base` / `bg-layer-1` → `#fff`（白色底），`label-primary` → `#0f1115`，`label-secondary` → `#61666b`，`border-l2` → `#0000001a`，`button-info-fill` → `#4176e6`（DeepSeek 蓝）。
- 把 `:root` 调色板从 Rams 的暖灰（#e9eae7/#f7f7f5、#1a5fb4 蓝）换成 DSH 白色系：stage #f9fafb / bg #fff / 文本 #0f1115 / 次要 #61666b / 边框 #0000001a / 强调 #4176e6；语义色也换成 DSH 的 red/green/amber 值；圆角用宿主 6/8/12px。
- 同步改标题栏标签为「DSH 白色主题 · 全界面」。
截图 `dsh-white-panel.png` 核对：白色背景、白色卡片、DeepSeek 蓝按钮，与 DSH 浅色一致。

## 第 11 轮（用户：文件树行右键菜单怎么是透明的）

用户：「文件树行右键菜单 怎么是透明的」。

原因：切白色主题时把 `--surface-3` 从 Rams 的不透明色改成了 `rgba(15,17,21,.06)`（仅 6% 不透明度），而 `.menu` 背景正好用的 `var(--surface-3)`，于是菜单几乎全透明。
修正：`.menu` 背景改用 `var(--card)`（实心 `#ffffff`）。`.entry.picked` / `.qbar` 仍用半透明 `--surface-3` 作浅填充，属预期，无需改。
截图 `dsh-white-menu.png` 核对：菜单为白底、带边框与阴影，不再透明。
（截图时整页发白是 `.surface.active` 的 0.18s 淡入动画被无头浏览器定格在中间帧，非菜单问题；加 `--virtual-time-budget=2000` 后正常。）

## 第 12 轮（用户：忘记主机密钥按钮怎么是透明的）

用户：「忘记主机密钥 按钮怎么是透明的」。

原因：原型给该按钮用了 `.btn-quiet`（`background:transparent;border-color:transparent`），所以看起来没有边框和底色。
核对真实实现：`lib/client/client.panel.js:2137-2141` 用的是普通 `sshwsp-btn`，和「编辑」同级，并非弱化样式。
修正：去掉 `.btn-quiet`，改成普通 `.btn`。截图 `dsh-white-hostbtn.png` 核对：忘记主机密钥已是与其他按钮一致的描边按钮。
（`.btn-quiet` 仍保留给传输队列的关闭 ×，那与真实编辑器 tab 关闭按钮风格一致。）

## 第 13 轮（用户：主机添加「开机自动连接」按钮，做成勾选）

用户：「主机添加了一个 开机自动连接 功能，添加上按钮界面，做成勾选」。

真实实现：`lib/client/client.panel.js:2061-2079` 用 `role="switch"` 的 `sshwsp-btn`，文案 `hosts.autoConnect`=「开机自动连接」（`client.locale.js:217`），title 为「已开启/关闭自动连接」（218/219）。
原型实现：
- 新增 `.auto-toggle`：描边小按钮内嵌 14px 勾选框，勾选态蓝底白勾；`aria-checked` 切换。
- 四台主机各加一个，示例状态：qiyk/nas-old 关、macmini/cloud-prod 开。
- JS 点击切换 aria-checked、更新 title 并 toast「已开启/关闭自动连接」。
截图 `dsh-white-autoconnect.png` 核对：勾选框清晰、与其他按钮同排；`node --check` 通过。

## 第 14 轮（用户：开机自动连接放右上角）

用户：「放右上角吧」。

把 `.auto-toggle` 从底部 `.actions` 按钮行移到 `.host-alias` 标题行内，用 `margin-left:auto` 推到行末（即卡片右上角）。四台主机同步调整。此前试过 `position:absolute;top:9px;right:13px` + `padding-right:132px` 预留空间，但窄栏下会挤压主机名（名称被挤成竖排），故放弃，改用标题行内 margin-left:auto 方案，宽窄视图都自然。
截图 `dsh-white-autoconnect.png`（宽）与 `dsh-white-autoconnect-narrow.png`（窄）核对通过。

## 第 15 轮（用户：没有在右上角 — 修正）

用户：「没有在右上角」。

上一版 `margin-left:auto` 只把勾选推到了信息列右边缘，不是卡片真正的右上角（右侧按钮行仍占位）。
修正：`.card.host{position:relative}` + `.auto-toggle{position:absolute;top:10px;right:13px}`，并给 `.host-alias{padding-right:124px}` 预留勾选宽度避免重叠；窄栏 `@container <420px` 里 `.host-alias{padding-right:0}` 让名称不被挤压。
截图 `dsh-white-autoconnect.png`（宽）/ `dsh-white-autoconnect-narrow.png`（窄）核对：勾选框固定在卡片右上角。

## 第 16 轮（用户：主面板中所有勾选控件改成图中 iOS 拨动开关）

用户发图（黑色胶囊轨道 + 白色圆形滑块，即 iOS switch）：「主面板中勾选的都修改为这种控件」。

- 新增 `.ios-toggle`：34×20px 胶囊轨道（关 #c7cace / 开 #0f1115）+ 16px 白色滑块，`transform:translateX(14px)` 切换，0.16s 过渡。
- 应用范围（仅主面板）：4 张主机卡片的「开机自动连接」（span.ios-toggle，状态跟随父 `aria-checked`）、设置页「启动时自动开启隧道」与「远端不存在时回退本机同名文件」（原生 `<input type=checkbox class=ios-toggle>`）。编辑器里的 BOM 勾选不在主面板，保持不变。
- 踩坑：初版类名用了 `.sw`，与顶部界面切换器容器 `<div class="sw" id="switcher">` 撞名，导致切换器被渲染成竖排开关条。已把拨动开关统一改名为 `.ios-toggle`，切换器恢复。
截图 `dsw-toggle-hosts.png` / `dsw-toggle-set.png` 核对：拨动开关为深色轨道 + 白滑块，开/关状态清晰；`node --check` 通过。

## 第 17 轮（用户：开关太大了，小一点）

用户：「开关太大了，小一点」。

把 `.ios-toggle` 从 34×20px（滑块 16px、位移 14px）缩小到 26×15px（滑块 11px、位移 11px），所有拨动开关（主机卡片 + 设置页）统一生效。截图 `dsw-toggle-hosts.png` / `dsw-toggle-set.png` 核对：开关尺寸更精致，与 12px 文案协调。

## 第 18 轮（用户：大一点点）

用户：「大一点点」。把 `.ios-toggle` 从 26×15px（滑块 11px、位移 11px）调到 30×17px（滑块 13px、位移 13px），介于之前 34×20 与 26×15 之间。截图 `dsw-toggle-hosts.png` 核对通过。

## 第 19 轮（按 docs/FF/12-file-preview-in-conversation.md 加两个设置控件）

用户引用 `docs/FF/12-file-preview-in-conversation.md`，要求加上文中几个 UI 改动。多选确认后仅做「设置页加两个控件」（`fileView` 二段式切换 + `hideComposer` 开关），不做会话预览界面（用户未选）。
按文档第四节 4 项定案：
- 新增「会话中查看文件」section-head，下面两行：
  - 「查看文件的位置」→ `.segmented` 二段式切换「会话中查看 / 右侧文件树」，默认高亮「右侧文件树」（= sidebar 默认值，升级零变化）。
  - 「查看文件时隐藏输入框」→ `.ios-toggle` 开关，fileView=sidebar 时整行置灰（opacity .5）并注明「仅在会话中查看时有效」。
- JS：点二段按钮切换 active，conversation 时解除置灰、sidebar 时置灰并禁用勾选，附 toast。
截图 `dsw-fileview-set.png` 核对：两个控件在设置页文件引用设置下方，二段切换与置灰状态正确；`node --check` 通过。

## 第 20 轮（按 docs/FF/11-fork-review-and-next-features.md 加界面）

用户引用 `docs/FF/11-fork-review-and-next-features.md`，要求加界面。多选确认：功能1（展示文件）、功能2（主机电源开关）、功能4（审计 tab），并要求「审计条数设置也在审计面板」。不做功能3（会话命令行审查后端）。
按文档定案实现：
- **功能1 展示文件**（文档二节）：设置页「浏览对话框」加 `.ios-toggle`「展示文件」（默认关）；开启给 body 挂 `data-sshwsp-show-files="1"`，显示 `.entry-file`（普通 div、无 onClick、无选中态、文件图标+大小），目录行仍是 button。浏览目录与新建工作区两个对话框各加 2 条文件行。
- **功能2 主机硬停用**（文档三节）：每张存储型主机卡片左侧加 `.power-btn` 电源按钮；点击弹确认框 `#disable-modal`（列出会中断的连接/shell/转发/监视/在途命令 + 警告"不可再用直到重新启用，启用不自动重连"）；确认后卡片 `.disabled` 置灰、禁止其按钮，再点电源直接启用。
- **功能4 审计 tab**（文档功能4/5）：面板加第 4 个 tab「审计」（同步 deep-link map audit:3）；审计面板含按工作区下拉过滤（含空态）、条数提示、「审计保留条数」数字输入（默认 200，1–2000，保存按钮）+ 8 条示例记录（成功/拒绝/未知/超时按会话归属）。命令在写入时脱敏的说明与终端近似性提示都在。
截图核对：`ff11-audit.png` / `ff11-hosts.png` / `ff11-set.png` / `ff11-modal.png`（确认框）/ `ff11-showfiles.png`（文件行）；`node --check` 通过。

## 界面审查（用户：对各个界面进行审查，看布局是否合理）

用 audit + critique 双镜审查 9 个界面 × 3 视口（desktop 1280 / tablet 768 / mobile 390，实际截图在 `ui/design-demos/review/`），另强制 `.dw=380px` 测真实 `<420px` 容器回落（`narrow-*.png`）。审查为只读，未改代码，等用户批准后再改。

**截图方法学重要发现**：headless Chrome 强制最小视口 500px（诊断注入实测 `win=500, dw=500, cq420=false`），所以 `--window-size=390` 的"mobile"截图实际是 500px 宽、`<420px` 容器查询未触发。真正的窄栏结论来自强制 `#dw{width:380px}` 的 `narrow-*.png`。

| 优先级 | 界面 / 位置 | 现状 | 建议 | 原因 |
| --- | --- | --- | --- | --- |
| 高 | 窄栏主机卡（`narrow-panel-hosts`） | macmini 的 pill「重连中（第3次，18秒后）」被挤成竖排字（每字一行），因为 `.host-alias` 是 flex、pill 被压缩 | 给 `.pill` 加 `white-space:nowrap; flex:none`，并允许 `.host-alias` 在窄栏 `flex-wrap:wrap`，pill 换行而非压扁 | 竖排字不可读，是明显的布局破损 |
| 高 | 窄栏审计行（`narrow-panel-audit`） | 命令与元信息挤在一行，命令被 `rg "audi…"` 截断、元信息也挤，8 行全这样 | 窄栏下把 `.audit-row` 改为两行布局（命令一行、元信息一行），或隐藏元信息只留命令 | 现在两败俱伤，都读不全 |
| 高 | 窄栏设置页端口转发卡（`narrow-panel-set`） | `.fwd` 里主信息 + 状态徽标 + 按钮组挤成 3 行，按钮组虽然 wrap 但顺序乱 | 窄栏给 `.fwd` 明确两行：第一行（点+路径），第二行（徽标+活动数+按钮组右对齐） | 提升扫描性 |
| 中 | 全部界面 demo chrome | 顶部切换器在最窄视口横向溢出（最后一个 tab「文件编辑器」被裁），`.topbar` 无 wrap 滚动容器 | 给切换器加 `overflow-x:auto` / 隐藏滚动条，或窄栏缩小按钮 padding | 用户可能需要在窄视口切换到最后一个界面 |
| 中 | `.entry-file` 文件行图标 | 用自绘 path，与其他 SVG 图标同源但描边风格略不同 | 统一 stroke-width / viewBox，保持图标语言一致 | 细节一致性 |
| 低 | 窄栏工作区卡 | `.mount` 按钮组在窄栏被推到下一行左对齐，尚可 | 可选：保持现有 wrap，无需改 | 已经可接受 |
| 低 | 无 `prefers-reduced-motion` | `.surface.active` 淡入、开关/提示过渡、扫描动画在 reduced-motion 下未降级 | 加一条 `@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}` | a11y 标准项（原型可忽略，正式实现应加） |
| 低 | 审计 tab 计数 | 用 `显示 8 / 200 条`，非 tabular-nums | 数字段加 `font-variant-numeric:tabular-nums` | 与其他数字（传输速度）一致 |

**通过项**：桌面与平板全部 9 个界面布局合理、留白充足、层级清晰；主机卡的电源按钮 + 标题行开关 + 底部操作按钮三者不重叠；对话框在桌面/平板居中、表单-列表-底栏结构清楚；行菜单位置与尺寸稳定；文件行不可选语义清晰（div + 无 hover）；确认框层级正确、遮罩与警告色合理。
**Craft Report** — Checked: a11y（focus-visible、键盘 tab 列表、颜色非唯一状态信号）+ responsive（三视口 + 380px 强制窄栏）+ performance（仅 transform/opacity 动画、无 transition:all）；Passed: 桌面/平板 9 界面、对话框、菜单、确认框；Changed: 无（审查只读，等批准）；Verdict: 桌面/平板合格，窄栏三处高优先需修（pill 竖排、审计行、转发卡），其余为 quick wins。下一步：`/polish` 应用修复。

## 用户第三批修改（审查后）
1. 主机电源按钮：改 `align-self:center`（上下居中）；停用态 `.card.host.disabled .power-btn` 改红边/红底/红字（`--danger-line/soft/danger`），整卡 opacity 从 .55 提到 .7 让按钮可读。截图确认停用后电源图标红色、垂直居中。
2. 审计 tab 从「设置」后移到「设置」前（主机/工作区/审计/设置）；深链映射同步改 `{hosts:0,work:1,audit:2,set:3}`。
3. 审计保留条数：输入框默认 200、范围 1–2000（环与审计 tab、落盘共用）；去掉提示文案与「保存」按钮，`blur` 失焦即保存并 clamp 到 1–2000，越界 toast 提示。
4. 审计列表补足到 36 条示例，`.audit-list` 改 `overflow-y:auto;max-height:710px`（行高实测 35.5px × 20 条 = 710px，即恰好显示 20 条，其余滚动），计数显示「显示 36 / 200 条」。audit-20.png 确认。
5. 「展示文件」的说明（浏览目录与新建工作区时显示文件（不可选））收进名字后的 `?` 悬停标志；section 标题「会话中查看文件」改为「文件查看」；「查看文件时隐藏输入框」去掉后缀说明，开关放文字左边；该行只在选中「会话中查看」时出现，选「右侧文件树」时整行隐藏（不再置灰），新增 `syncFileView()` 联动。截图 fv-conversation / fv-sidebar 两态确认。
- `node --check` 抽取的内联脚本通过；三张截图（final-panel / final-set / final-audit）核对无异常。

## 审计 tab 专项审查（critique 镜，只读）

截 1280 / 强制 380 窄栏 / 过滤后 / 空态 / 焦点五态（`c-desktop.png`、`c-narrow.png`、`c-filtered.png`、`c-empty.png`、`c-focus.png`）。只读，未改代码。CRAFT_LEVEL≈7：报 Critical + Major，Minor 标可选。

| 优先级 | 现状 | 建议 | 原因 |
| --- | --- | --- | --- |
| P0 | 窄栏 `.audit-row` 单行 flex，`.acmd` 与 `.ameta` 抢宽度，命令只剩 `git stat…`/`rg "audi…`/`pnpm…` | `@container dw (width<420px)` 下改 grid：首行 tag+命令（允许 2 行换行），次行元信息整行 | 审计的全部价值是"看清跑了什么"，现在丢了 |
| P0 | 36 行里 20+ 个绿底「成功」药丸，整页绿墙 | 成功态改中性（灰点或 `--muted` 无底色），只给 拒绝/超时/未知 上色 | 常态着高饱和色 = 注意力均匀分布，异常反而不突出 |
| P1 | `.ameta` 右对齐、宽度随内容变，左边缘来回摆约 140px | 拆三列：host 定宽左对齐 84px / workspace flex / time 右对齐 56px + tabular-nums | 竖扫"哪台机器出问题"时每行都要重新找起点 |
| P1 | 工具栏三行三种对齐：`命令审计+刷新` / `过滤+select+计数badge` / `保留条数+200`（右侧整片空） | 收成一行：左 `[工作区▾]`，右 `保留 [200] 条` + `刷新`；计数移到列表内 | 三行像三个不相干的东西，200 孤零零像漏做的表单 |
| P1 | badge「显示 36 / 200 条」把"筛出 36"和"上限 200"塞进一个斜杠 | 「共 16 条」跟列表；上限进工具条「保留 200 条」 | 一个 badge 两个量级不同的数，必须停下来解析 |
| P2 | 无列头 | 列表顶部 11px `--faint` 列头：状态 / 命令 / 主机·工作区 / 时间 | 字段固定的多行数据，列头是最便宜的扫描加速器 |
| P2 | 行无 hover、无动作 | hover 右侧浮出复制图标（复用 rowmenu `copy` glyph）+ toast；窄栏点整行复制 | 日志的主路径是"看到跑过什么→我也要跑/核对"，复制缺失 |
| P2 | 保留条数裸数字 `200`，无单位、失焦静默保存无回声 | 输入框加「条」后缀；保存时边框 200ms 高亮 + ✓ 1.5s | 无单位 + 静默保存，用户会怀疑存没存 |
| P3 | `.ameta`/`.badge` 比例数字，时间列轻微抖动 | `font-variant-numeric:tabular-nums` | 一行 CSS |
| P3 | 窄栏「审计保留条数」标签折成两行 | 窄栏文案缩短为「保留条数」 | 折行把一行控件读成两行字 |

**签名细节建议**：主机色带——行首 2px 竖线按主机分组（4 台 4 个极低饱和色），纵向一眼看出"这台机器连续跑了这些"，且不制造彩色噪音；比换色标签更"设计过"。
**通过项**：连续 36 行滚动结构稳定；空态有独立虚线框 + 居中提示；`刷新` 焦点环清晰（c-focus）；状态色语义正确（绿/红/黄都对应真实含义）；底部脱敏说明到位。
**Craft Report** — Checked: Anti-Slop / Craft Test / Hierarchy / Clarity / Signature / 响应式，CRAFT_LEVEL≈7；Passed: 空态、焦点环、行高节奏、状态色语义、动效克制；Changed: 无（只读）；Verdict: 桌面结构可用但有三处结构性欠账（窄栏截断、彩色药丸噪音、工具栏三行无基线），修完这三条即达"设计过"的门槛。

## 其余界面专项审查（critique 镜，只读）

截图：`p-{panel-hosts,panel-work,panel-set,browser,newworkspace,queue,menu,editor}.png`（1280）、`n-panel-{hosts,work,set}.png`（强制 380 面板）、`dn-{browser,newworkspace,editor}.png`（对话框压到 340px）。只读，未改代码。
注意：`n-queue.png`/`n-browser.png` 与桌面版**字节相同**——队列浮层与对话框不在 `#dw` 里，强制面板宽度对它们无效，窄栏结论改用 `dn-*.png`（直接压 `.dialog` 到 340px）得出。

| 优先级 | 页面 | 现状 | 建议 | 原因 |
| --- | --- | --- | --- | --- |
| P0 | 主机 | 380px 下 `.auto-toggle`（绝对定位 top:10/right:13）压住 cloud-prod 的「已连接」药丸；macmini 的开关孤零零浮在第一行上方，主机名被挤到第二行 | 窄栏容器查询里改回文档流：`.auto-toggle{position:static;margin-left:auto}`，标题行 `.host-title{display:flex;flex-wrap:wrap;gap:8px}` | 开关与状态标签重叠 = 信息不可读 |
| P0 | 设置 | 端口转发行 `.fwd` 在 380px 塌成 4 行：状态点孤零零一行、路径一行、徽标+活跃数一行、按钮一行 | 窄栏 grid：第1行 `[dot][path]`，第2行 `[pill][活跃]`，第3行按钮右对齐 | 点与它描述的对象被拆散，扫读断裂 |
| P1 | 传输队列 | 目录归档那条满宽灰线（「8.2 MB 已传」）长得像卡在 0% 的进度条；失败行下面那条深色线同样易误读 | 要么做真实扫描动画（`background-size:40%` 左右跑），要么这条线整体去掉只留文本 | 一半像进度条一半不像，最糟 |
| P1 | 传输队列 | 失败项除了红字没有任何动作，唯一操作是点文件名 | 行 hover 出「重试」；失败行常显「重试」链接 | 失败态是死胡同 |
| P1 | 新建工作区 | 「不可写」目录行只是红字，仍可选中；「创建工作区」按钮不随选择禁用 | 行加禁用态（opacity .55 + not-allowed + 不可选），选中不可写时主按钮 disabled 并说明原因 | 提示与行为不一致，用户会撞墙 |
| P1 | 新建工作区 | 名称与主机两个控件拉满 590px | 表单区 `max-width:320px` | 单行输入拉满是最典型的模板感来源 |
| P1 | 文件编辑器 | 无「已修改」状态：保存按钮常亮、头部无脏标记；文案里提到冲突「重新加载」但界面没有该动作 | 改动后头部加 ·，无改动时保存 disabled；冲突态给「重新加载」 | 编辑器最关键的两个状态没画出来 |
| P2 | 浏览目录 | `.dialog{height:min(86vh,720px)}` 固定高度，5 行内容下方留约 300px 空白 | `height:auto;max-height:min(86vh,720px)`，列表 `min-height:280px` | 空白让对话框显得没做完 |
| P2 | 浏览目录 | `drwxr-xr-x` 每行重复，无信息增量 | 只在不可写时显示红色「只读」徽标，或 hover 才显示权限串 | 每行重复同一串字符是纯噪音 |
| P2 | 浏览目录 | 提示说「输入即筛选」，界面上没有输入框 | 列表上方加真实筛选输入（带 ⌕） | 隐藏交互没有可见入口 |
| P2 | 新建工作区 | 「工作目录路径：输入绝对路径…」与「输入即筛选…」两句灰字前后脚出现 | 合并成一条提示条，放在列表顶部 | 连续两句操作说明互相稀释 |
| P2 | 工作区 | 挂载图标 14px 下读起来像字母「S」 | 换更简单的字形或放大到 16px | 图标被误读成文字 |
| P2 | 工作区 | 已挂载卡按钮底部对齐、已停用卡按钮垂直居中，两种卡节奏不同 | 统一底部对齐 | 同类卡片应同构 |
| P2 | 文件行菜单 | 下载/上传两个托盘箭头在 14px 下几乎无法区分 | 拉开箭头方向差异或改描边粗细 | 方向是这个菜单唯一的关键差异 |
| P3 | 主机 | 窄栏按钮组落到下一行且左对齐，与「按钮放右下角」的意图不符 | 窄栏 wrap 时保持右对齐（`margin-left:auto` 配合 `width:100%`） | 细节一致性 |
| P3 | 编辑器 | 头部只有完整 `ssh://` 路径，没有文件名主标题 | 首行 `notes.md` 为主、路径次之可截断 | 编辑器先认文件名 |
| P3 | 编辑器 | 行尾选择器文案「自动（LF/CRLF）」把模式与取值混在一起 | 「行尾：自动 ▾」+ 选项 自动 / LF / CRLF | 一个下拉塞了两个概念 |

**通过项**：桌面 8 个界面结构与层级稳定；每屏一个主按钮（添加主机/添加工作区/挂载此目录/创建工作区/保存）；按钮命中区 ≥28px；菜单与对话框阴影层级正确；焦点环清晰；传输队列 400px 宽度与目录归档不画百分比的规则都对；行菜单顺序与真实实现一致。
**Craft Report** — Checked: Anti-Slop / Craft Test / Hierarchy / Clarity / Signature / 响应式（1280 + 380 + 340 对话框），CRAFT_LEVEL≈7；Passed: 桌面全部、对话框结构、菜单尺寸与层级、传输队列规格遵循；Changed: 无（只读）；Verdict: 桌面可用，窄栏两处碰撞（主机开关压状态、转发卡塌行）必须先修，其余为状态表达欠账（编辑器脏态、队列失败动作、不可写目录语义）。

## 按审查落地（用户：按审查的修改）

### 主面板·主机
- 窄栏改两列网格：`.dw .card.host{display:grid;grid-template-columns:auto minmax(0,1fr)}`，电源按钮 `grid-row:1/span 2`，信息与按钮在右列。
- `.auto-toggle` 窄栏 `position:static;margin-left:auto`（原先绝对定位，`cloud-prod` 的「已连接」药丸被开关压住）；`.host-alias` 允许换行、`.pill` 加 `white-space:nowrap;flex:none` 防挤压。
- 关键坑：`@container` 块在样式表里位于 `.card.host{align-items:flex-end}` **之前**，同权重会被后者覆盖 → 必须写 `.dw .card.host`（0,3,0）才生效。曾以为改了但截图字节相同，就是这条。
- 另一个坑：flex-wrap 换行按"假设主尺寸"计算，`host-main` 的 max-content 过大会被折到第二行，导致电源按钮独占首行、标题下沉 52px；改 grid 后消失。诊断靠注入 `getComputedStyle` 打点（cardAI/aliasTop 等）。

### 主面板·工作区
- `.mark` 从「S 字母小方块」换成 15px 文件夹描边 SVG（`aria-hidden`），三处工作区卡同步。
- 已停用卡的「已停用」徽标从 `.mount-title` 内移到 titlerow 同级，两种卡结构一致。

### 主面板·设置（窄栏）
- `.fwd` 窄栏改三行网格：`[点][路径]` / `[徽标][活跃数]` / `[按钮右对齐]`（`grid-row` 显式指定，避免自动放置错位）。

### 审计
- 表格化：`.audit-head` + `.audit-row` 共用 `grid-template-columns:52px minmax(0,1.7fr) 84px minmax(0,1fr) 62px`，五列 状态/命令/主机/工作区/时间。
- 成功态去色（`--faint` + `--surface-3` 底），只有 拒绝/超时/未知 保留红/黄；`tabular-nums` 上到时间与计数。
- 行 hover 出复制按钮（`.audit-copy`），点击写剪贴板并 toast；窄栏按钮常显但改为无边框小图标。
- 行数据改由 JS 数组渲染（36 条，`[类别,标签,命令,主机,工作区,时间]`），`.ameta{display:contents}` 让三个子 span 在宽屏直接成为网格项，窄栏再 `display:flex` 合并成第二行。
- 工具条：标题行右侧 `保留 [200] 条 + 刷新`，下一行 `[工作区▾] + 共 N 条`；计数只说"共 N 条"，不再把筛出数与上限混在一个斜杠里。
- 未加"保存成功微反馈"：用户此前明确要求去掉提示与保存按钮，保持失焦静默保存。

### 传输队列
- 目录归档行 `扫描中 · 8.2 MB 已传`（配合既有 scan 动画，避免被读成卡 0% 的进度条）。
- 失败行删掉误导性的 62% 灰条，换成 `重试 / 移除` 两个按钮（`.qactions`）。

### 浏览目录 / 新建工作区
- `.dialog` 改 `height:auto;max-height:min(86vh,720px)`，短列表不再留 300px 空白。
- 权限串 `drwxr-xr-x` 全删，只有不可写目录显示红色「只读」/「不可写」。
- 新增 `.browser-filter` 真实筛选输入框（把"输入即筛选"变成可见入口），JS 按 `.nm` 过滤；`双击进入下一级` 挪到该行右侧。
- 新建工作区：`.dlg-fields{max-width:320px}`，两句灰字合并成一句；`readonly-share` 行加 `.entry.disabled`（opacity .55 + `pointer-events:none` + `aria-disabled`），点击被忽略。
- 路径条 `/home/qiyk/` 从 span 改成真实 `input.path`（无边框、聚焦时下划线），让"可直接输入绝对路径"这句话成立。
- 选中目录联动：点击 entry 更新 `.picked-line b`（用 `closest('.dialog')` 找，不是 `.browser` 的 parentNode——后者拿不到兄弟节点）。

### 文件编辑器
- 头部：`notes.md` 主标题 + 完整 `ssh://` 路径次之（可截断）+ `· 未保存` 脏标记。
- 保存按钮无改动时 `disabled`，`.code` 改 `contenteditable`，输入即置脏。
- 新增 `.ed-conflict` 冲突条 + 「重新加载」；`.legend` 里加「预览冲突态」按钮演示。坑：`.ed-conflict{display:flex}` 会盖掉 `hidden` 属性，需补 `.ed-conflict[hidden]{display:none}`。
- 行尾选择器文案「自动（LF/CRLF）」→「自动」，选项 自动 / LF / CRLF。

### 未采纳
- 行菜单 下载/上传 图标：原型用的是真实实现 `lib/client/client.icons.js` 的 `TRAY_ARROW_PATHS`（同一组 path，托盘 U 形 + 箭头方向区分），改形状就与真实客户端不一致，故保留原样。

### 工作区图标改用项目自带的 remote mark
- 用户发来项目里的图标小图并要求「工作区的图标换成我们常用的」。
- 取真实定义：`lib/client/client.icons.js` 的 `REMOTE_MARK_VIEWBOX='10.5 6.25 11.5 15'` 与 `RemoteMarkIcon` 两条 path `M20 8 L16.5 11.5 L20 15` / `M12.5 11.5 L16.5 15.5 L12.5 19.5`（两个 45° 对向 chevron，stroke-width 2、圆头圆角）；`lib/client/client.marks.js` 的 `createRemoteMarkNode` 用同一组值把 DSH 的文件夹 glyph 换成这个 mark。
- 原型里 `.mark` 换成同一个 SVG（15px、`stroke:currentColor`、`stroke-width:2`、round），三处工作区卡（含已停用）统一。

## 认得出测试

三版配色完全相同，所以差异全在骨架：Ledger（线清单）、Panels（衬底卡片）、Rail（侧轨导航）。并排看不会认成同一版；与最近项目也不撞（外观账本为空）。
