# 10 前端表现层重构 · 任务书

> 一次性任务书。读完 `docs/FF/10-client-presentation.md` 再动手；本文件只写起点、顺序和验收，不重复方案里的论证。
> 风格参照 `dsh-opencode-go`，但**只抄它的令牌契约与视觉语言**，不抄它的构建链（方案 §2）。

## 起点状态（2026-11-23 已核对）

- 仓库 `0.3.6`，分支 `refactor/client-presentation`，从 `refactor/code-splitting` 的 `f27ef37` 切出，工作树干净。
- 样式表全部在 `lib/client/client.styles.js`（738 行 / 66 135 B，其中 CSS 文本 64 149 B / 295 条规则行），由 `injectStyles()` 注入。它必须继续是**叶子 chunk**。
- 实测数据（规模、9 个假 token、62 个色字面量、圆角/字号/间距/z-index 的散乱程度、15 条 hover、2 条死规则）都在方案 §1，**不要重新调研**。
- 宿主令牌清单在本机可核对：`D:\Software\DSH\resources\app.asar` 里能 grep 到全部 `--dsw-*` 名；本机已抽出一份临时清单（`dsw-tokens.txt`，见下「可用的核对手段」）。**不要把 asar 路径写进代码或测试**——测试用一份固定的名字清单。
- 本机沙箱可能禁止 node 再 spawn：`tests/run.mjs` / `scripts/lint.mjs` 若全 EPERM 是环境问题，把会话切到 `danger-full-access` 再跑；不要因此改 runner。

## 任务

按方案 §4 的 P1 → P6 顺序做。**每一阶段跑完 `npm run check` 再进下一阶段**，不要把 6 个阶段攒成一次大改——测试有 68 处规则体断言，一次改完会分不清哪条红是哪条引起的。

### P1 契约落地（不动规则体）

1. 在 `client.styles.js` 的 CSS 文本**最前面**加令牌块，根选择器列表按方案 §3.1 一次写全（7 个根）。
2. 按 §3.2 定义 A / B / C 三组令牌。A 组的 fallback 是**唯一**允许出现字面量的地方。
3. 把 §1.2 表里 9 个假 token（15 处）换成宿主真名。
4. 删 `.sshwsp-passthrough-hint`（死规则，无生产者）。
5. 同步改 `tests/download-icon-smoke.mjs` 的 4 处颜色断言（`:325` `:327` `:330` `:333`）——它们钉的是**旧 token 名**，P1 一换就红，这是预期内的红。
6. 跑 `npm run check`，全绿再进 P2。

### P2 规则改写

1. 295 条规则里的 `#hex` / `rgba(` / `var(--dsw-…)` 全部换成 `--sshwsp-*`。**白名单只有三处**：`--sshwsp-hl-*` 那 22 行（保持 6 位 hex，`file-editor-smoke:840` 用正则抽它算对比度）、令牌块本身、`.sshwsp-btn-primary { color: var(--dsw-alias-label-on-color, #fff) }`。
2. 圆角 9 种 → 4 个令牌；字号 8 种 → 5 个令牌；`z-index` 8 种 → 刻度令牌（**保持"遮罩 < 对话框 < 菜单"的相对序**，`client-shape-smoke` 有行为断言）。
3. 同步更新 68 处规则体断言里被改动的那部分（几何类断言的值**不要改**，见方案 §7 第三条风险）。
4. 加守卫测试（新建 `tests/presentation-tokens-smoke.mjs`）：令牌块之外不出现 `#hex` / `rgba(` / `--dsw-`（白名单除外）。

### P3 交互态

补齐 `.sshwsp-btn-primary` / `.sshwsp-btn-danger` 自己的 hover / active / disabled / focus-visible（现在完全没有，靠 `.sshwsp-btn` 一条兜）；行、菜单项、图标按钮统一。焦点环全部走 `--sshwsp-focus-width` / `-offset`。
守卫测试：每个可点类都有 hover + focus-visible 各至少一条。

### P4 结构与密度

按方案 §3.4 重画卡片 / 区块 / 行的解剖；间距换 `--sshwsp-space-*`；数字加 `tabular-nums`。
**`@media (max-height: 620px)` 与 `(max-height: 500px)` 那两组几何契约不变**——`client-shape-smoke:1079–1093` 钉着 `height: min(88vh, 760px)`、`overflow: clip`、`.sshwsp-dirlist-hint { display: none }`。要改先改行为，再改断言。

### P5 主题与无障碍

1. 浅色层（方案 §3.3）：只覆盖必须改的 7 个令牌，判定用 `body:not([data-ds-dark-theme])`。**不要**给面板加 JS 监听、不要动 `--sshwsp-hl-*` 那套已有的 `data-ds-theme-source` 链。
2. 滚动条统一自绘（面板 / 对话框列表 / 编辑器三处），`@supports` 回退 webkit。
3. `.sshwsp` 加 `container-type: inline-size` + `@container (width < 420px)` 的窄面板适配。**只在面板根上加**。
4. 6 个 `@keyframes` 全部进 `prefers-reduced-motion: reduce`（现在只有 3 处覆盖）。

### P6 测试、死规则与文档

1. **`.sshwsp-icon-btn-busy:disabled` 必须二选一**：要么在 `client.transfer-queue.js` 给队列图标按钮补 `busy` 生产者（busy 时 `disabled` 且环保持 `opacity: 1`），要么删规则 + 删 `download-icon-smoke:340` 的断言。**不允许继续留一条无生产者却被测试保护的规则**——那条测试证明的是"规则存在"，不是"行为正确"。
2. 新建守卫测试的四条：零假 token（固定名字清单）、零游离字面量、根列表完整（从源码抽 portal 根类名比对 CSS 列表）、刻度收敛。
3. `docs/ui.md` 加「表现层令牌契约」一节（写清为什么用 CSS 根选择器而不是运行时 `style`、为什么浅色只覆盖 7 个令牌、高亮调色板为什么是例外）。
4. `npm run doc-numbers` 同步 `docs/development.md` 的数字（新增测试套件会改 suite / assertion 总数）。
5. 更新 `CHANGELOG.md` 的「未发布」段。
6. 真机走查（方案 §5 第 7 条）：浅色/深色 × 面板/浏览器对话框/编辑器/传输队列/右键菜单/toast，加窄侧栏。**客户端渲染没有单测覆盖，这一步不能省**；走查结果写进 `docs/ui.md` 那一节。

## 硬要求

- 不要引入构建步骤、CSS modules、构建期 hash 类名、新依赖、TypeScript。
- 不要改任何 `sshwsp-` 类名（86 处测试断言 + 宿主 DOM 约定钉着）。
- 不要拆 `client.styles.js` 成多个 chunk。
- 不要为了让测试变绿而放宽断言；预期内的红要改断言的值来源，不是改断言本身。
- 不要覆盖宿主的 `--dsw-*` 语义，只在自己的令牌里映射它。
- 不要碰写围栏、会话 mode、协议字段、编辑器引擎（`client.editor-engine.js` 是 CodeMirror 打包产物）。
- 不改版本号、不发布、不提交除非用户明确要求。
- 全部做完后按 `docs/FF/README.md` 的约定删除本任务书与方案文件，把有价值的事实搬进 `docs/ui.md` 与 `CHANGELOG.md`。

## 验收命令

```bash
npm run check            # 发布前门禁，必须全绿
node tests/run.mjs       # 全量套件（本机 EPERM 时切 danger-full-access）
npm run check:client-map # 17 section 的 map 必须仍与 banner 一致
npm run check:docs       # doc-numbers 与链接
npm run check:editor     # 编辑器产物校验
```

## 可用的核对手段

- 宿主令牌清单：`app.asar` 里 grep `--dsw-[a-z0-9-]+`，本机已抽过一份 475 个名的清单；**只用于核对，不写进仓库**。测试里用一份固定的名字清单（把本仓库实际用到的名字钉住，宿主升级后若有名字消失，测试会红——这正是想要的）。
- 参照实现：`~/.dsh/profiles/desktop/node_modules/dsh-opencode-go`（`lib/client.js` 是压缩产物，只能读 `lib/types/client/*.d.ts` 与 `docs/development.md`）。
- 现状实测：方案 §1 的表格可直接引用，不要重复测量。
