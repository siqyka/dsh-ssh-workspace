# 打磨记录 · 远程工作区面板方向初稿

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

## 认得出测试

三版配色完全相同，所以差异全在骨架：Ledger（线清单）、Panels（衬底卡片）、Rail（侧轨导航）。并排看不会认成同一版；与最近项目也不撞（外观账本为空）。
