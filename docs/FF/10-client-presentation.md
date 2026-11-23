# 10 前端表现层重构（令牌契约 + 视觉语言）

> 本文件是**可执行的工作流方案**，不是已完成功能说明。做完按 `docs/FF/README.md` 的约定删除本文件与任务书。
> 起点：分支 `refactor/client-presentation`（从 `refactor/code-splitting` 的 `f27ef37` 切出，工作树干净），版本 `0.3.6`。
> 参照对象：`dsh-opencode-go` v0.4.7 的表现层做法（本机 `~/.dsh/profiles/desktop/node_modules/dsh-opencode-go`）。

## 0. 起点与硬约束

- **无构建步骤**：不引入打包器、不引入 CSS modules / 构建期 hash 类名、不加新依赖、不重写 TypeScript。参照对象用 esbuild + lightningcss 把 CSS 编译成 hash 类名，那套**不能抄**；能抄的是它的令牌契约与视觉语言。
- 样式表仍是 `lib/client/client.styles.js` 里的**一段模板字符串**，由 `injectStyles()` 写进 `<style data-plugin-css="@shiqyka/dsh-ssh-workspace/client.css">`。它必须继续是一个**叶子 chunk**（不向主包借任何名字），`client-map` 的 17 个 section 不受影响。
- 三道写围栏、会话 mode、协议字段一律不碰；本次只改表现层（CSS + 必要的 className 增补）。
- 未明确要求时不改版本号、不发布；`npm run check` 全绿才算完成。
- 行号会漂，按选择器 / 函数名找。

## 1. 现状（2026-11-23 实测）

### 1.1 规模

| 项 | 数值 |
| --- | --- |
| CSS 字节 | 64 149 |
| 规则行 | 295 |
| 选择器（去重类名） | 219 个 `.sshwsp-*` 类 |
| 类族占比 | editor 16.8%、cr 6.1%、fileaction 4.4%、toast 4.0%、dialog 3.7%、check 3.7%、其余 ≤3% |
| 内联 `style:` 对象 | 21 处（panel 5 / dialogs 5 / add-workspace 5 / editor 4 / queue 1 / client.js 1） |

### 1.2 颜色：token 看起来有，其实有 9 个是假的

- 295 条规则里 **158 条**带原始色字面量，**162 条**写的是 `var(--dsw-…, fallback)`，**0 条**完全脱离 token。表面看"已经全走 token 了"。
- 但把本仓库用到的 32 个 `--dsw-*` 名去宿主的 `app.asar` 里核对，**9 个名字宿主根本没有**，共 15 处：

| 我们写的（不存在） | 次数 | 宿主实际有的 |
| --- | --- | --- |
| `--dsw-alias-label-warning` | 4 | `--dsw-alias-state-warn-label` |
| `--dsw-alias-state-warning-primary` | 2 | `--dsw-alias-state-warn-primary` |
| `--dsw-alias-text-secondary` | 2 | `--dsw-alias-label-secondary` |
| `--dsw-alias-bg-warning` | 2 | 无直接对应，用 `color-mix(state-warn-primary 12%, transparent)` |
| `--dsw-alias-fill-secondary` | 1 | `--dsw-alias-fill-l2` |
| `--dsw-alias-label-info` | 1 | `--dsw-alias-label-primary-bluish` |
| `--dsw-alias-border-secondary` | 1 | `--dsw-alias-border-l3` |
| `--dsw-alias-border-accent` | 1 | `--dsw-alias-button-info-fill` |
| `--dsw-alias-label-danger` | 1 | `--dsw-alias-label-error` |

  这 15 处**永远**落在 fallback 上——面板在那 15 个位置其实没跟随宿主主题，只是碰巧 fallback 的深色值看起来还行。浅色主题下这些位置会明显错色。**这是本次最重要的一条实测缺陷**：它不是"没做 token"，是"做了假 token"，而假 token 让审计也看不出问题。
- 共 **62 个不同色字面量**（43 个 hex + 19 个 rgba），最高频：`#4a9eff`×24、`#e0e0e0`×21、`#666`×17、`#888`×16、`#999`×13、`#ff6b6b`×12。
- 落在 `var()` 之外的字面量只有 36 行，其中 22 行是编辑器高亮调色板（`--sshwsp-hl-*`，深浅各一套）、1 行 `.sshwsp-btn-primary { color: #fff }`、1 行 `box-shadow: 0 8px 28px rgba(0,0,0,0.28)`、1 行 `::selection` 的 `rgba(74,158,255,0.28)`。**高亮调色板是有意的例外**（见 §3.5）。

### 1.3 尺度：没有刻度

| 维度 | 现状 | 宿主有 |
| --- | --- | --- |
| 圆角 | 手写 9 种：6px×10、4px×7、8px×6、50%×3、2px×2、5px×2、7/10/12/999px 各 1 | `--dsw-radius-xs:4px` / `sm:8px` / `md:12px` / `lg:16px` / `xl:20px` / `panel:28px`；**本仓库 0 处使用** |
| 字号 | 8 种：12px×39、11px×24、13px×9、10px×3、18/16/15/14px 各 1 | `--dsw-font-xxxs-11-font-size` … `--dsw-font-xl-24-font-size`；0 处使用 |
| 间距 | 44 种 padding 简写、9 种 gap、46 个不同 px 值 | 无 token，但需要自建刻度 |
| 焦点 | 12 条 `:focus-visible`，各自手写 `2px solid` | `--dsw-focus-ring-width: 2px` + `--dsw-focus-ring-color`；0 处使用 |
| z-index | 0 / 1 / 40 / 1000×2 / 1001 / 1100 / 1300 / 1400 | 无刻度，需要自建 |
| 阴影 | `--dsw-elevation-prominent` 4 处 + 1 处手写 `rgba(0,0,0,0.28)` | `--dsw-elevation-panel` / `-soft` / `-stroke` 未用 |

### 1.4 交互态：295 条规则里 15 条 hover、12 条 focus-visible

- `.sshwsp-btn-primary` 与 `.sshwsp-btn-danger` **没有自己的 `:focus-visible`**，靠 `.sshwsp-btn` 那一条覆盖；`-primary` / `-danger` 的 hover 也不存在，按下时只有 `transform`。
- `disabled` 只有 3 条规则；`[aria-pressed="true"]` 1 条；`[aria-expanded]` 2 条。
- 9 条 `transition` 声明、6 个 `@keyframes`、3 处 `prefers-reduced-motion`。

### 1.5 主题：只有编辑器有浅色

- `--sshwsp-hl-*` 有完整两套调色板，判定链是 `[data-ds-theme-source="light"]` → `[data-ds-theme-source="system"] + @media (prefers-color-scheme: light)` → `html:not([data-ds-theme-source]):not([data-theme])` 回退。
- 面板其余 90% 完全依赖宿主 `--dsw-*`，**自己没有浅色适配**——在假 token 那 15 处会错色（§1.2）。
- 宿主真正发布的权威信号是 **`body[data-ds-dark-theme]`**（布尔属性，已在 asar 里确认；`data-ds-theme-source` 是它的来源标记）。参照对象正是认这个属性 + `MutationObserver`。

### 1.6 死规则与假断言

- `.sshwsp-passthrough-hint`（`client.styles.js:280`）：**没有任何生产者**，纯死规则。
- `.sshwsp-icon-btn-busy:disabled`（`client.styles.js:376`）：同样**没有生产者**（全仓无 `icon-btn-busy` 字样），但 `tests/download-icon-smoke.mjs:340` 断言了这条规则。于是这条测试**证明的是"规则存在"，不是"行为正确"**——它保护了一条永远不会被任何元素命中的规则。**P6 已处置：删除规则 + 把断言反过来**（现在断言这个类名不再出现），并把检查提升为类别级：样式表里任何 `-busy` / `-loading` / `-pending` / `-disabled` 修饰符都必须在**样式表之外**找到生产者，否则算死规则。生产者必须排除 `client.styles.js` 本身——第一版检查在 `source` 里搜索，命中了规则自己的类名，反向验证把这个洞抓了出来。

### 1.7 测试对表现层的耦合（必须同步改）

- 4 个套件里有 **68 处**正则断言直接钉住规则体（`/\.sshwsp-x \{[^}]*…/`），另有 **86 处**引用 `\.sshwsp-` 选择器、25 处只提到选择器。
- 其中 **4 处钉住了颜色文本**，改 token 就会红：
  - `tests/download-icon-smoke.mjs:325` `.sshwsp-fileaction-queue`（`var(--dsw-alias-label-primary, #e0e0e0)`）
  - `:327` `.sshwsp-fileaction-queue-active:hover`（`var(--dsw-alias-button-info-fill, #4a9eff)`）
  - `:330` `.sshwsp-queueicon`（`var(--dsw-alias-label-secondary, #999)`）
  - `:333` `.sshwsp-dlring-track`（`color-mix(… var(--dsw-alias-label-tertiary, #888) 55% …)`）
- `tests/file-editor-smoke.mjs:840` 用正则从样式里抽 `--sshwsp-hl-([a-z]+):\s*(#[0-9a-f]{6});` 做 WCAG 对比度计算，**高亮调色板必须保持 6 位 hex 字面量**，否则这条断言会静默失效（抽出空数组 → 循环 0 次 → 假绿）。
- `tests/client-shape-smoke.mjs` 有 35 处规则体断言，含 `.sshwsp-dialog-fill { height: min(88vh, 760px) }`、`@media (max-height: 620px)` 等**几何**约束——这些是行为契约（滚动只有一个、头部不 sticky），改写时必须保留语义。

## 2. 参照 dsh-opencode-go：抄什么、不抄什么

**抄**：

1. **一套自有前缀的令牌契约**（它是 `--go-*`，约 45 个），规则里只出现自己的令牌，宿主令牌只在契约定义处出现一次。
2. **令牌分三组**：`native`（映射宿主 `--dsw-alias-*` 并带中性 fallback）/ 派生（`color-mix` 算出的 sunken、border-subtle、accent-soft、track 等）/ 自有刻度（radius、focusWidth、type、space、z）。
3. **深浅判定认 `body[data-ds-dark-theme]`**，不认 `prefers-color-scheme` 单独作主判据。
4. **视觉语言**：卡片 = `border 1px + radius + surface + shadow`；正文 12–13px / 行高 1.5–1.6；三级文字色（text / muted / muted-soft）；统一焦点环 `outline: var(--x-focus-width) solid var(--x-accent); outline-offset: 2–3px`；自绘滚动条；`prefers-reduced-motion` 全局关动画；数字用 `tabular-nums`。

**不抄**：

1. 构建期 hash 类名与 CSS modules —— 我们没有构建步骤，类名必须保持可读、可被测试正则断言。
2. `themeStyle(tokens)` 运行时用 `style` 属性挂令牌 —— 它需要每个根节点调用一次，而我们的根分散在 6 个文件、其中 5 个是 portal。**CSS 选择器能做到同一件事，而且不需要 JS、不需要 MutationObserver**（见 §3.1）。这比参照对象更省。
3. 依赖宿主 `@deepseek-ai/dsh-client-ui-primitives` —— 该包在本机不可解析（symlink 指向不存在的 `app.asar.unpacked` 路径），继续手写。
4. 它 `classic` 主题那套独立暖纸/衬线皮肤 —— 与"跟随宿主主题"的既有承诺（`docs/ui.md` 的「主题不新增第二份」）冲突。

## 3. 方案：一套 `--sshwsp-*` 契约

### 3.1 契约挂在哪里（关键设计）

面板根是 `.sshwsp`，但**另外 5 类根是 portal 到 `document.body` 的**，它们不是 `.sshwsp` 的后代：

| 根 | 生产处 |
| --- | --- |
| `.sshwsp` | `client.panel.js` 面板根 |
| `.sshwsp-backdrop` | `client.dialogs.js` ×3、`client.add-workspace.js` |
| `.sshwsp-editor-panel` | `client.editor.js:2753`、`:3096` |
| `.sshwsp-flowmenu` | `client.js:3332`（`el.className` 赋值） |
| `.sshwsp-inline-rename` | `client.js:2189` |
| `.sshwsp-popbackdrop` / `.sshwsp-queuepanel` | `client.transfer-queue.js:186` / `:188` |
| `.sshwsp-toast` | `client.js`（`document.body.appendChild`） |

所以令牌**定义在一个共享的根选择器列表上**，一次写全：

```css
.sshwsp,
.sshwsp-backdrop,
.sshwsp-editor-panel,
.sshwsp-flowmenu,
.sshwsp-inline-rename,
.sshwsp-popbackdrop,
.sshwsp-queuepanel,
.sshwsp-toast { /* 契约 */ }
```

好处：纯 CSS、无 JS、无重渲染、HMR 换样式表即生效；`apply` 期不需要额外接线。代价：**新增一个 portal 根时必须记得加进这个列表**——这条要有测试兜底（§5）。

### 3.2 令牌清单

**A 组：跟随宿主（值来自 `--dsw-*`，fallback 只在这里出现一次）**

| 令牌 | 值 |
| --- | --- |
| `--sshwsp-bg` | `var(--dsw-alias-bg-base, #0f0f0f)` |
| `--sshwsp-surface` | `var(--dsw-alias-bg-layer-1, #161616)` |
| `--sshwsp-surface-2` | `var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))` |
| `--sshwsp-surface-3` | `var(--dsw-alias-bg-layer-3, #1a1a1a)` |
| `--sshwsp-border` | `var(--dsw-alias-border-l2, rgba(127,127,127,0.2))` |
| `--sshwsp-border-strong` | `var(--dsw-alias-border-l3, rgba(127,127,127,0.25))` |
| `--sshwsp-text` | `var(--dsw-alias-label-primary, #e0e0e0)` |
| `--sshwsp-muted` | `var(--dsw-alias-label-secondary, #999)` |
| `--sshwsp-faint` | `var(--dsw-alias-label-tertiary, #666)` |
| `--sshwsp-accent` | `var(--dsw-alias-button-info-fill, #4a9eff)` |
| `--sshwsp-accent-hover` | `var(--dsw-alias-button-info-hover, #4a9eff)` |
| `--sshwsp-danger` | `var(--dsw-alias-state-error-primary, #ff6b6b)` |
| `--sshwsp-danger-text` | `var(--dsw-alias-label-error, #e5534b)` |
| `--sshwsp-warn` | `var(--dsw-alias-state-warn-primary, #fbbf24)` |
| `--sshwsp-warn-text` | `var(--dsw-alias-state-warn-label, #d9a227)` |
| `--sshwsp-success` | `var(--dsw-alias-state-success-primary, #4ade80)` |
| `--sshwsp-hover` | `var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1))` |
| `--sshwsp-active` | `var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.16))` |
| `--sshwsp-mask` | `var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.5))` |
| `--sshwsp-shadow` | `var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4))` |
| `--sshwsp-font` | `var(--dsw-font-family, system-ui, sans-serif)` |
| `--sshwsp-mono` | `var(--dsw-font-markdown-code-font-family, monospace)` |

**B 组：派生（`color-mix`，跟随 A 组自动变色）**

`--sshwsp-sunken`（bg 上压暗）、`--sshwsp-border-subtle`、`--sshwsp-accent-soft`、`--sshwsp-danger-soft`、`--sshwsp-warn-soft`、`--sshwsp-track`（`color-mix(in srgb, var(--sshwsp-text) 18%, transparent)`）、`--sshwsp-selection`。

**C 组：自有刻度**

| 令牌 | 值 | 取代 |
| --- | --- | --- |
| `--sshwsp-radius-xs` | `var(--dsw-radius-xs, 4px)` | 2px / 4px / 5px |
| `--sshwsp-radius-sm` | `var(--dsw-radius-sm, 8px)` | 6px / 7px / 8px |
| `--sshwsp-radius-md` | `var(--dsw-radius-md, 12px)` | 10px / 12px |
| `--sshwsp-radius-pill` | `999px` | 999px / 50% 的胶囊用途 |
| `--sshwsp-focus-width` | `var(--dsw-focus-ring-width, 2px)` | 12 处手写 `2px` |
| `--sshwsp-focus-offset` | `2px` | 1px / 2px 混用 |
| `--sshwsp-font-2xs` | `var(--dsw-font-xxxs-11-font-size, 11px)` | 10px / 11px |
| `--sshwsp-font-xs` | `var(--dsw-font-xxs-12-font-size, 12px)` | 12px |
| `--sshwsp-font-sm` | `var(--dsw-font-xs-13-font-size, 13px)` | 13px |
| `--sshwsp-font-md` | `var(--dsw-font-s-14-font-size, 14px)` | 14px / 15px |
| `--sshwsp-font-lg` | `var(--dsw-font-m-18-font-size, 18px)` | 16px / 18px |
| `--sshwsp-space-1` … `-6` | `2 / 4 / 6 / 8 / 12 / 16px` | 44 种 padding 简写 |
| `--sshwsp-z-base` … `-top` | `0 / 1 / 10 / 40 / 100 / 200 / 300` | 0/1/40/1000/1001/1100/1300/1400 |

z 刻度映射：编辑器内部 `0/1`、宿主树覆盖层 `40`、遮罩 `100`、对话框与面板 `200`、菜单与浮层 `300`（toast 与菜单同层，靠出现顺序）。**必须保持"遮罩 < 对话框 < 菜单"这个既有相对序**，`tests/client-shape-smoke.mjs` 对弹窗层级有行为断言。

### 3.3 深浅色

```css
/* 默认（深）：A 组 fallback 即深色值 */
body[data-ds-dark-theme] .sshwsp, … { /* 显式深色：A 组不变 */ }
body:not([data-ds-dark-theme]) .sshwsp, … { /* 浅色：只覆盖少数需要压深的令牌 */ }
```

浅色层只覆盖**必须**改的那几个：`--sshwsp-text` / `-muted` / `-faint` / `-border*` / `--sshwsp-sunken` / `--sshwsp-track` / `--sshwsp-shadow`。其余交给宿主 `--dsw-*`（宿主在浅色下自己会给不同值）。这样既修好 §1.2 的 15 处错色，又不违反"主题不新增第二份"。

**不引入 JS 监听**：属性选择器天然随 DOM 属性变化重算，比参照对象的 `MutationObserver` 少一份状态。现有 `data-ds-theme-source` 那套链只保留给高亮调色板（它是自己的配色，不是宿主令牌）。

### 3.4 视觉语言（对齐参照对象）

- **区块**：`.sshwsp h3` 段落标题保持 12px + `letter-spacing .02em` + `--sshwsp-faint`；每个 section 之间用 `--sshwsp-space-6` 的固定间距，不再靠 margin 塌陷。
- **卡片**：`.sshwsp-card` 改成 `background: var(--sshwsp-surface); border: 1px solid var(--sshwsp-border); border-radius: var(--sshwsp-radius-md); box-shadow: var(--sshwsp-shadow)`；host 卡片与 mount 卡片共用。
- **行**：行高 1.5–1.6；行内 meta 一律 `--sshwsp-font-2xs` + `--sshwsp-faint`；数字（字节数、百分比、端口、行号）统一 `font-variant-numeric: tabular-nums`。
- **按钮**：`.sshwsp-btn` / `-primary` / `-danger` 各自补 `:hover` / `:active` / `:disabled` / `:focus-visible` 四态；焦点环统一走 `--sshwsp-focus-*`。
- **滚动条**：面板、对话框列表、编辑器三处统一自绘（`scrollbar-width: thin` + `scrollbar-color`，`@supports` 回退 webkit），颜色取 `--sshwsp-track`。
- **窄面板**：面板会被挤到很窄（侧栏），对 `.sshwsp` 加 `container-type: inline-size`，在 `@container (width < 420px)` 下把 host 卡片的动作区换行、把 meta 行折叠。**只在面板根上加**，不碰宿主的容器查询。

### 3.5 有意的例外

- `--sshwsp-hl-*`（22 行）保持 6 位 hex 字面量：`file-editor-smoke` 用正则抽它做 WCAG 对比度计算，改成 `color-mix` 会让抽取静默失败。它是一套**代码配色**，不是主题令牌。
- `.sshwsp-btn-primary { color: #fff }`：主按钮上的文字色是"在品牌色之上"的颜色，宿主没有对应令牌；改为 `var(--dsw-alias-label-on-color, #fff)`。
- 编辑器 `::selection` 的 `rgba(74,158,255,0.28)` 改为 `var(--sshwsp-selection)`。

## 4. 分阶段实施

**P1 契约落地**：加 §3.1 的根列表 + §3.2 的 A/B/C 三组令牌；把 9 个假 token 换成真 token（§1.2 表）；删 `.sshwsp-passthrough-hint`；处理 `.sshwsp-icon-btn-busy:disabled`（见 P6）。此阶段**不改任何规则体**，只加令牌定义 + 换 9 个名字。验收：`npm run check` 全绿（4 处颜色断言要同步改成新名字）。

**P2 规则改写**：295 条规则里的字面量与 `var(--dsw-…)` 全部换成 `--sshwsp-*`（高亮调色板除外）；圆角/字号/焦点/z-index 换成刻度令牌。验收：新增守卫测试「令牌块之外不出现 `#hex` / `rgba(` / `--dsw-`」通过；68 处规则体断言同步更新。

**P3 交互态**：补齐 `-primary` / `-danger` / 行 / 菜单项的 hover、active、disabled、focus-visible；`.sshwsp-btn` 系列统一焦点环。验收：每个可点类至少有 hover 与 focus-visible 各一条（守卫测试）。

**P4 结构与密度**：卡片/区块/行的解剖按 §3.4 重画；间距换刻度；数字加 `tabular-nums`。验收：`@media (max-height: 620px/500px)` 那几条几何契约不变（`client-shape-smoke` 会拦）。

**P5 主题与无障碍**：浅色层（§3.3）；滚动条；`@container` 窄面板；补 `prefers-reduced-motion` 到所有动画（现在 3 处，6 个 keyframes）。验收：假 token 清零；浅色下 15 处错色位置有断言。

**P6 测试与文档**：把 4 处钉颜色的断言改成钉令牌名；`.sshwsp-icon-btn-busy:disabled` **已按"删规则"处置**：补生产者是错的方向，因为忙碌态现在由进度环表达，让按钮在 `:disabled` 下保持满不透明度会和旁边真实的禁用按钮冲突；删规则、把断言反过来，并把检查提升为类别级（任何 `-busy`/`-loading`/`-pending`/`-disabled` 修饰符都必须在样式表之外有生产者）；同步 `docs/ui.md`（新增「表现层令牌契约」一节）与 `docs/development.md` 的模块数字（`npm run doc-numbers`）。

## 5. 验收判据

1. `npm run check` 全绿（lint + check:editor + check:docs + check:client-map + test + pack --dry-run）。
2. **零假 token**：本仓库出现的每个 `--dsw-*` 名都能在宿主 `app.asar` 里找到（守卫测试按一份固定清单核对，清单进测试而不是进运行时）。
3. **零游离字面量**：令牌块之外不出现 `#hex`、`rgba(`、`--dsw-`（高亮调色板白名单）。
4. **根列表完整**：每个 `className: 'sshwsp-…'` 的 portal 根都出现在 §3.1 的令牌根列表里（守卫测试：从源码抽 portal 根的类名，与 CSS 里的列表比对）。
5. **刻度收敛**：`border-radius` 只出现 4 个令牌、`font-size` 只出现 5 个、`z-index` 只出现刻度令牌（守卫测试）。
6. **交互态覆盖**：每个可点类都有 hover + focus-visible。
7. 真机走查：浅色与深色各看一遍面板、浏览器对话框、编辑器、传输队列、右键菜单、toast；窄侧栏（<420px）看一遍面板。**客户端没有单测覆盖渲染，这一步不能省。**

## 6. 不做什么

- 不改任何 `--dsw-*` 的**语义**（只换名字与取值来源），不覆盖宿主令牌。
- 不改类名（86 处测试断言 + 宿主 DOM 约定都钉着 `sshwsp-` 前缀）。
- 不引入构建步骤、CSS modules、新依赖、TypeScript。
- 不动 chunk 边界：`client.styles.js` 仍是叶子 chunk，不拆成多份（拆了会让 `injectStyles` 的"重写已有 style 标签"契约变复杂，收益不足）。
- 不重写 `client.panel.js` 那 1382 行组件（27 个 useState）——本次只改表现层，结构重构另立工作流。
- 不做动画体系、不引入 spring/过渡编排。
- 不碰编辑器引擎（`client.editor-engine.js` 是 CodeMirror 打包产物，改它要重新 `npm run build:editor`）。

## 7. 风险与代价

- **最大风险是测试**：68 处规则体断言、4 处钉颜色、1 处抽 hex 做对比度。P1 换 token 名就会红 4 条，这是**预期内的红**，要一次改到位，不要靠放宽断言通过。
- **第二风险是浅色**：本机默认深色，浅色层没有真机对照容易写成"看起来对"。§3.3 只覆盖必须改的 7 个令牌，就是为了把这个面压小。
- **第三风险是几何契约**：对话框高度、`overflow` 归属那几条是行为契约不是审美，P4 动间距时容易碰坏。`client-shape-smoke` 的 35 条规则体断言是护栏，不要为了"更好看"改掉它们断言的值——要改先改行为。
- 收益：假 token 清零（浅色下 15 处错色修好）、颜色字面量 62 → 0（令牌块内除外）、圆角 9 → 4、字号 8 → 5、间距 44 → 6、z-index 8 → 7 档刻度、交互态从 15/295 提到全覆盖、死规则 2 → 0、主题从"只有编辑器"到"面板也有"。
