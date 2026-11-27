# docs/FF —— 已完成工作流的索引

> 这个目录原先放的是**待实施的设计方案 + 一次性任务书**：`NN-<topic>.md` 是方案，`NN-<topic>-prompt.md` 是任务书。
> 01–10 全部完成后，按约定**方案与任务书均已删除**；本页只留一行索引，指向每个工作流最终沉淀下来的文档位置。
> 11、12 是**调查文档**（11 = fork 审阅 + 待建功能调查；12 = 会话窗查看文件 + 两个设置项）。两份都已实施，11 的 ①–⑤ 与 12 的全部内容都落在下表与各文档里；按本页约定，方案页在实施后删除——**两份指针页已于 2026-11-27 删除**，落点只由下表给出。
> **13–20 是待实施的功能任务书**（2026-11-27 架构审查产出，每份自带背景、复用、改造、步骤、约束、验收、风险）。与它们配套的**问题**任务书在 [docs/FX](../FX/README.md)；两边的依赖关系见 FX 索引的「依赖关系」一节。实施完成后同样按约定把落点写回本表。
> 行号会漂，按这里给出的文档与小节找，不要按旧任务书里的行号定位。

## 已完成的工作流

| # | 工作流 | 落点 |
| --- | --- | --- |
| 01 | 裸检出上能跑远端读写（测试支撑） | `tests/support/fake-sftp.mjs`、`tests/support/plugin-host.mjs`、`tests/support/render.mjs`；03 的验收基线 |
| 02 | 权限语汇（默认关闭、主机白名单、写围栏、审计不写内容） | `lib/core/mode-gate.js`、`lib/fs/remote-fs.js`、`lib/engine/engine.js` 底部 |
| 03 | 右侧文件树的文件编辑（读/写/改三条路由、`version` + `revision` 双校验、远端与本地同一条路由） | `docs/ui.md` 的「文件编辑」一节；`docs/features.md` 二之「在浏览器里编辑」 |
| 04 | 代码拆分（去重、`statusTool` 三段分离、`routes` 按资源域拆模块、watch 集群独立、`client.js` 按懒渲染边界拆 chunk） | `CHANGELOG.md` 的 `[未发布]`「变更」一节（client.js 拆 chunk、`lib/` 按能力域重组）；client chunk 的宿主能力（同步 `require` 不可、`require.async` 可用、命名 `client.<name>.js`、`load` 注册、按插件目录同名文件取）与拆分边界见下方「客户端 chunk 的宿主事实」 |
| 05 | 同功能模块合并（16 组，`lib/` 83 → 57 个模块） | `CHANGELOG.md` 的 0.3.6「变更」一节（含合并带出的两处真缺陷）；「搬家会让检查静默变松」的四处修正见未发布段的「修复」 |
| 06 | 文件系统与编辑器的参照取舍（对照第三方 side-bar 实现：4 条必做缺陷、4 条纯优化、5 条明确不做） | `CHANGELOG.md` 的 `## [未发布]` 各条（冲突基线、watcher 上限、`beforeunload`、编码读写、文件内查找、确定性排序、单例折叠、只读分页）；`docs/ui.md` 的「文件编辑」一节 |
| 07 | 右侧文件树的「新建文件」（远端目录行 + 远端空白处 + 本地空白处；`POST /create-file` 独占创建，0 字节，不自动打开） | `docs/features.md` 的「新建文件」一行、`docs/ui.md` 的行菜单与空白处菜单两节；`CHANGELOG.md` 的 `## [未发布]` 新增条；`tests/mutations-smoke.mjs` 与 `tests/tree-gestures-smoke.mjs` |
| 08 | 文件树菜单改成「数据模型 + 宿主渲染」——**已否决**：同一份模型交给宿主画之后，本地工作区的右键长着宿主的壳、远端工作区长着插件的，同一个手势两张脸。最终选择是删掉宿主那条渲染器，只留自绘 | `docs/ui.md` 的「行菜单、重命名与删除」一节；`docs/architecture.md` 的客户端半边；`CHANGELOG.md` 的 `## [未发布]` 修复条 |
| 09 | 剩余工作（2026-11-23 全仓审查） | R-01…R-10 已修 / 已落地，落点在 `CHANGELOG.md` 的 `## [未发布]` 与 `docs/development.md` 的套件表；R-11（读窗口 512 KiB A/B）需真机 WAN 测量，按方案约定不盲改常量，保留 `lib/fs/read-window.js` 的 256 KiB；「不再做」判定见下方 |
| 10 | 前端表现层重构（`--sshwsp-*` 令牌契约 + 视觉语言，风格参照 dsh-opencode-go；修掉 9 个假 token、62 个游离色字面量、散乱的圆角/字号/间距/z-index、缺失的交互态与浅色层） | `docs/ui.md` 的「表现层：一套令牌契约」一节；`docs/development.md` 的 `presentation-tokens-smoke` 套件说明与反向验证一节；`tests/presentation-tokens-smoke.mjs`、`scripts/reverse-verify-presentation.mjs`；真机视觉走查清单在 `docs/manual-test-checklist.md` 的「表现层 / 视觉」组 |
| 11 | **已实施（①–⑤ 全部）**：①设置「展示文件」（开关控制两个目录对话框是否显示不可选的文件行）：`preferences.showFiles`（`POST /preferences` + `/status`），两个 picker 按开关决定是否带 `dirs=1`，文件行是纯展示 `div`；②每台存储型主机电源开关（硬停用）：`POST /hosts/toggle`、`lib/hosts/disable.js`、引擎 `disabledHosts` 闸门、`/hosts` 每行 `resources`、`/status.disabledHosts` 置灰、确认框列实时资源；③会话命令行审查：`sessionId` 随 exec/background/shell/terminal 四条通道进入审计环，持久 shell 由 `ShellManager.run` 自记，终端 PTY 按键重建（近似，标注边界），审计落盘 `$DSH_HOME/dsh-ssh-workspace/dsh-ssh-commands.json`（`lib/engine/command-log.js`）+ 四层硬上界；④面板「审计」tab（`GET /audit`、按工作区过滤、手动刷新）；⑤可配置保留条数（默认 200，1–2000；ring / tab / 落盘以 `setCapacity` 为唯一事实，`POST /audit/settings`） | `docs/features.md` 的「展示文件」「主机硬停用」「命令审计」「终端击键捕获」「审计落盘」「保留条数与审计 tab」六行；`docs/ui.md` 的「文件行只是『这里有什么』」「卡片左侧的电源开关」「第四个 tab：审计是一张表，不是一个开关」三节；`docs/architecture.md` 的「主机硬停用」与「命令审计的落盘与终端捕获」；`CHANGELOG.md` 的 `## [未发布]` 五条；`tests/host-disable-smoke.mjs`（49 项）与 `tests/command-log-smoke.mjs`（78 项） |
| 12 | **已实施（落点已改版）**：右侧文件树点击文件在**会话窗**查看——**每个文件占一个同名 `conversation.view` 标签**（会话顶部标签条，与「对话 / 轨迹 / …」同排，可多个并存、懒注册、关掉即消失），标签固定宽度、`×` 绝对定位在右侧，内容以 inline 模式铺满会话区（不是浮层，且按滚动区定高、底栏不随滚动条走）；标签**属于打开它的会话**（切走即消失、切回原样复现，只注销不关闭）；设置项是「查看文件」二段式切换（会话 / 右侧文件树）+「文件标签页里隐藏输入框」（`hideComposer`，默认开）+「目录选择器里显示文件」（`showFiles`），控件在插件面板「设置」tab，值走插件 store 的 `preferences` 节（`/status` 下发 + `POST .../preferences`）；点击经既有捕获桥接管（`.md` 等 Markdown 也算文本），读取复用 `read-text`；关闭 = 标签末尾 `×`（MutationObserver 注入）/ `Esc`；默认 `sidebar`。初版落点 `conversation.input.dock` 已移除 | `docs/features.md` 的「会话窗查看文件」一行；`docs/ui.md` 的「会话窗里的文件预览」一节；`CHANGELOG.md` 的 `## [未发布]` 新增条；`tests/file-preview-smoke.mjs`（96 项）与 `lib/hosts/preferences.js` |

## 待实施的功能任务书（13–20）

| # | 工作流 | 优先级 / 复杂度 | 前置 | 任务书 |
| --- | --- | --- | --- | --- |
| 13 | 逐文件变更捕获补全：让 `fs-shim` 识别「已学习的裸远端路径」，变更面板在远端也有 before / after 文本 | P0 / 中 | 无 | [13-capture-file-before-after-prompt.md](./13-capture-file-before-after-prompt.md) |
| 14 | 远端 Git 操作闭环：stage / unstage / discard / commit，固定 argv、路径过围栏、只做面板 | P0 / 中高 | 无（建议在 13 之后） | [14-git-ops-prompt.md](./14-git-ops-prompt.md) |
| 15 | 目录传输加速：`engine.execStream` + 远端 `tar` 单流打包 / 无 `tar` 时按 size+mtime 增量跳过 | P1 / 高 | 无（是 17 的前置） | [15-packed-tree-transfer-prompt.md](./15-packed-tree-transfer-prompt.md) |
| 16 | 命令确认策略 v2：每主机 `allowlist`（argv 结构化匹配）+ 会话级「不再询问」 | P1 / 中 | 无 | [16-command-allowlist-prompt.md](./16-command-allowlist-prompt.md) |
| 17 | 远端后台任务面板：列出插件自己开的远端通道、看输出尾窗、终止 | P1 / 中 | 15、[FX/02](../FX/02-client-module-system-prompt.md) | [17-jobs-panel-prompt.md](./17-jobs-panel-prompt.md) |
| 18 | 变更监视后端抽象：`inotifywait` → `fswatch` → 轮询 | P2 / 中低 | 无 | [18-watch-backends-prompt.md](./18-watch-backends-prompt.md) |
| 19 | 非 POSIX 远端（Windows OpenSSH）：只做挂载 / 列目录 / `pwsh` 终端 / 读写 | P3 / 高 | [FX/01](../FX/01-seam-contract-prompt.md)、18 | [19-non-posix-remote-prompt.md](./19-non-posix-remote-prompt.md) |
| 20 | 远端默认登录 shell：未指定 shellPath 时取探测到的 `$SHELL` | P2 / 低 | 无 | [20-default-login-shell-prompt.md](./20-default-login-shell-prompt.md) |

路线图口径：**近期** 13、14、20（+ [FX/03](../FX/03-hygiene-fixes-prompt.md) 小修）；**中期** 15、16、17（+ [FX/01](../FX/01-seam-contract-prompt.md)、[FX/02](../FX/02-client-module-system-prompt.md)）；**远期** 18、19。

## 客户端 chunk 的宿主事实（04 的方案摘要）

宿主 `@deepseek-ai/dsh-client-modules`（`app.asar` 内）的真实能力：

| 通道 | 结论 |
| --- | --- |
| 同步 `require` 兄弟文件 | 不行：只查 seed / loadCache / factories，同步拆仍需构建或第二入口 |
| `require.async(spec)` | 可以懒加载同目录 chunk |
| chunk 命名 | `client.<name>.js`，由 `CLIENT_CHUNK` 正则校验 |
| 注册 | chunk 里 `load({ id, chunk: 'client.extra.js', factory })` |
| 取用 | 按插件目录同名文件取，不扫描、不预构建 |

**运维约束**：chunk 的 URL rev 来自主入口 `lib/client/client.js` 的文件元数据；改 chunk 不会改 rev，而宿主按精确 URL 缓存响应。所以只改 chunk 不生效，要重启或触碰主入口。

**拆分边界（踩过的坑）**：渲染期就要调用的纯函数留在主包；chunk 失败要自己包 `Suspense fallback: null`；遮蔽组件（`ForgeTabWithHistory`）不能进 chunk；`apply()` 期安装在 `document` 上的桥不能进 chunk；`apply` 可以是 async，但 `await` 之后一切都可能还没到；宿主无条件渲染的空洞要先判 `open`；启动 chunk 的名字要在 `loadBootChunks()` 末尾用 `republishBootNames()` 重发布（`Object.assign` 拷的是值，模块求值时还是占位符）。

## 判定不做（09 的方案摘要，保留理由，不重开）

| 方向 | 理由 | 何时可重开 |
| --- | --- | --- |
| 整体重写 TypeScript / 引入构建 | 会打断七个运行时补丁与单入口 bundle；类型收益可先用 JSDoc + 局部 `@ts-check` | 模块拆分后补丁只剩一两处时 |
| 自实现完整 `ssh_config` 语义 | 错误解析比不支持更危险；采用「明确子集 + 显式报告」 | 上游有可依赖解析库，或接受硬失败 |
| 远端命令沙箱 | 需要远端内核能力，一条 SSH 连接证明不了隔离 | 宿主提供 execution world 边界 |
| 盲目缓存 / 并发预取 | 没测量前加缓存只会让失效更难推理 | 先有可复现延迟测量 |
| 承诺断线后恢复运行中命令 | 远端进程去向不可知，正确语义是「未知/可能已生效」 | 不重开 |
| 容器化发布证据 | 假 SSH 服务器只证明协议；真机证据已建立 | CI 需要可重复真机环境时 |
| CI 差异矩阵 | 并入 O-14 关闭，避免用矩阵掩盖假绿 | 出现只在特定平台复现的 bug |
| 全量性能基线 | 测量工具未校准；`ls` 上限已作为正确性修复独立落地 | 有明确回归需要判定时 |
| 系统钥匙串凭据后端 | 只换密钥位置，挡不住整目录拷贝，还多平台依赖 | 宿主提供统一凭据服务 |
| SOCKS / 动态转发 | 需求未出现；ProxyJump 与反向转发已做 | 真实需求 + 测试夹具 |
| 照抄「无围栏 fs 写路由」 | 三道写围栏是测试钉住的边界 | 不重开 |
| `working-directory/access` 短路 `resolve`/`stat` | 复核 `0.2.2-rc.5`：`set()` 的 `commit()` 在默认 `next()` 内，短路会丢提交；`ensure()` 短路会丢「恢复原目录」；`resolve` 对 `ssh://` 本来就是本地解析，唯一往返 `stat` 省不掉 | 宿主把 `commit` 移出 `next`，或提供不牺牲恢复语义的校验入口 |

## 与 01–03 的关系

- **01 是地基**：03 的验收依赖「裸检出上能跑远端读写」，那正是 01 补上的测试支撑。
- **02 立下的权限语汇**（默认关闭、主机白名单、写围栏、审计不写内容）正是 03 复用的那一套：会话 mode（`lib/core/mode-gate.js`）、写围栏（`lib/fs/remote-fs.js`）、审计不写内容（`lib/engine/engine.js` 底部）。
- **03 已完成**，没有并行项。

## 阅读顺序

- 想知道「为什么要做」 / 边界 / 不做什么 → 上面各落点的文档与 `CHANGELOG.md`。
- 想知道 04 / 09 做过什么 → 本页的摘要段。
