# 09 剩余工作与历史判定

> 2026-11-23：原 `docs/optimization-and-future03.md`（第三辑账本）里的未完成项迁到这里，账本随后删除。本文件是**可执行的工作流方案**，不是已完成功能说明；第 1 节完成一项就删掉对应小节，全部完成后按 `docs/FF/README.md` 的约定删除本文件与任务书。

## 0. 起点与硬约束

- 起点：`0.3.6`，分支 `refactor/code-splitting`；2026-11-23 全仓审查 R-01…R-08 中**已修五项**：R-01（下载绕过会话模式）、R-02（status 单 gather + provenance）、R-04（新建文件 mode 统一 0644 + chmod 拒绝入诊断）、R-05（写拒绝的机器可读形状）、R-06（JSON body 413），落点见 `CHANGELOG.md` 的「未发布」段；R-08 已修一半（过滤 + 幂等回收），剩时间窗。同批还合入：转发持有与连接关闭回收、abort 不拨号、hosts 渲染补 `skipped` / `storeError`、保存回包固化标签页、`apply` 期监听器回收、`saveText` 读上限、策略缓存真 LRU、行尾保存策略选择器、读屏可见性、`lineCount` 缓存。
- 三道写围栏（workspace root / 会话 workspace / sandbox mode）**不得放宽**；任何「为了让某个操作能做而放宽围栏」的改法不接受。
- 未明确要求时不改版本号、不发布；发布前 `npm run check` 必须全绿。
- 每项都要：加测试断言、跑 `node tests/run.mjs`、`npm run check:docs`、`npm run check:client-map`，并同步 `CHANGELOG.md` 与本文件。
- 行号会漂，按函数名/符号找，不要按本文件的行号硬定位。

## 1. 可开工项（建议按此顺序）

顺序原则：先做正确性的一致性收尾（R-09），再可观测性（R-08 剩余、R-03、R-07），性能项最后且 R-11 需要真机测量——没有 WAN 主机可跳过，不要盲改常量。

### 1.1 R-09 树上键盘手势的策略查询绕过了缓存

**现状**：`lib/client/client.js` 的树上键盘手势（F2 重命名 / Delete 删除）直连 `mutationPolicyOf({ root })`（搜 `void mutationPolicyOf({ root })`）——30 秒策略缓存与同 key 在途去重都在 `policyOf` 里，这条路径两者都不经过；同一棵树上先右键再按 Delete 就是两次完整的 `/mutation-policy` 往返，右键刚拿到的答案帮不了键盘。

**修法**：改走 `policyOf(claim)`；答案随之进缓存，右键菜单下一次打开直接命中（`policyKeyOf` 已支持无 sessionId 的 claim）。

**验收**：`tests/tree-menu-model-smoke.mjs` 补一条「键盘 claim 与菜单 claim 共享一个缓存键」（同一 root 连续两次只发一次请求）；F2 / Delete 的只读拒绝与本地根未知拒绝文案不变。

### 1.2 R-08（剩余半步）marks 观察器的时间窗

**现状（2026-11-23 复核）**：`mutationTouchesMarks` 过滤已把无关 mutation 挡在外面（流式 token 的 `characterData` 不命中 `MARKS_RELEVANT` 就不调度），观察器已幂等并随 `apply` 的 disposer 回收——本条原描述的「每个 mutation 全文档 7 次 `querySelectorAll`」已不成立。剩余成本在调度器本身：`scheduleRemoteMarks` 用 `requestAnimationFrame` 合并，60 fps 流式下每帧都可能跑一次 pass。

**修法**：rAF 合并换成 50–100 ms 尾部时间窗（复用同一个标志位，不新开第二个定时器）。

**验收**：连续 100 条命中 `MARKS_RELEVANT` 的 `characterData` 只产生 ≤ 2 次扫描（计数桩断言）；标记、拖拽、多选行为不变。

### 1.3 R-03 目录树上传的围栏与 mkdirp 去重

**现状**：`lib/transfer/transfer.js` 对**每个文件**都重付一次写围栏判定与全路径 `mkdirp` 往返（`lib/fs/remote-fs.js` 的 `ensureDir`/`mkdirp`）；500 个文件、5 层目录、50 ms 链路上约 2 分钟纯开销。

**修法**：目录树传输时按「目标目录」缓存「已确认存在」，walk 阶段先批量建目录，再并行传文件；每个文件的最终围栏判定不能省（防目录被换/符号链接），但可复用父目录的确认结果。

**验收**：fake transport 统计 `mkdir`/`realpath` 往返数：100 个文件同目录时目录创建 ≤ 1 次；越界目标仍在**任何字节发出前**被拒；失败重试语义不变。这是本组风险最高的一项，先补计数测试再改实现。

### 1.4 R-07 编辑器标签栏的键盘语义

**现状**：`lib/client/client.editor.js` 的标签栏是 `role="tablist"`，`role="tab"` 没有 `tabindex`，关闭按钮是 tab 的兄弟且仍在 tablist 内，全库没有 `tabpanel`/`aria-controls`；键盘用户无法在标签间移动。

**修法（二选一，倾向前者）**：

1. 降级为 `role="group"` + `aria-current="page"`，把关闭按钮移出 tablist 语义（最稳，不承诺 APG）。
2. 实现 APG：roving tabindex + ←/→/Home/End + `aria-controls` 指向编辑区。

**验收**：形状断言（role / tabindex / aria-current 或 aria-controls）；手工键盘走查 ←/→/Home/End 与关闭按钮 Tab 顺序；`tests/file-editor-smoke.mjs` 补断言。

### 1.5 R-10 预览的探测与正文读合并，小文件少四个串行往返

**现状**：铅笔按钮的探测是独立一次 `read-text?probe=1`，服务端是 `stat → open → read 8 KiB → close` 四次串行 SFTP 等待（`lib/routes/text.js` 的 `probeRemote`）；预览正文那次读是并行挂载的另一个请求。小文件（预览的大多数）的关键路径是**探测**那四个往返——正文早已到达，按钮还在等。

**修法**：预览的正读与探测共享同一次 `stat` + `open`。`read-text` 不带 `probe` 的回答已含 `size` / `encoding` / `truncated`，把 `editable` 判定（mode 门 + 形状规则）并进同一条路由回答；`probe=1` 端点保留给「正文还没被请求」的场景。`paged`（> 2 MiB）分支语义保持：探测只看头部，不改分页规则。

**验收**：fake SFTP 计数桩：一次预览 = 1 stat + 1 open + 正文块数 + 1 close（不再是两套串行往返）；`tests/file-editor-smoke.mjs` 的探测断言改读合并后的形状；WAN 语义由 `read-window-smoke` 的既有常量断言兜底（窗口不受影响）。

### 1.6 R-11 读窗口的 512 KiB A/B（需真机，可跳过）

**现状**：`READ_CHUNK_BYTES = 256 KiB × 4`（`lib/fs/read-window.js`），2 MiB 文件 = open + 2 次窗口等待 + close。512 KiB × 4 可把等待降到 1 次，但 SFTP 服务器对单次 READ 的实际上限因实现而异，盲改常量可能被服务器拆包反而变慢。

**修法**：先测量后改——在真机（WAN）上对同一文件跑 256 vs 512 的 A/B 计时，量出收益再改常量；没有真机就保留 256，**本条可整条跳过**。

**验收**：常量改动必须有实测数字写进 `read-window.js` 头部注释（现有格式已有先例）；`read-window-smoke` 的常量断言同步。顺带：压缩传输（主机卡片开关，默认关）实测 2 MiB 文本 12.2 s → 2.94 s（约 4×），比改任何代码便宜；慢链路上建议打开，`docs/features.md` 已有说明，不另立项。

## 2. 上游相关（本插件不能单方面完成）

| 条目 | 现状 | 触发 / 可退役条件 |
| --- | --- | --- |
| 终端 `request.cwd`（F-05 一部分） | `0.2.2-rc.5` 的 Agent 终端已认 `request.cwd`；用户终端仍只 `workingDirectory.ensure` | 用户终端也认 `request.cwd` 后，`patch-projection` 的放松键可评估退役；`patch-terminal` 的 cwd 重写仍需保留（宿主不保证远端可执行） |
| 宿主文件树选择/批量 API | 仍无 `selected` / `multiSelect` 语义，只有 `data-files-*` 装饰属性 | 宿主提供选择模型后，可退掉自绘多选桥 |
| 工具进度通道 | `ToolExecution` 仍无 `reportProgress` | 宿主提供后，F-02 的传输进度可进工具输出 |
| execution world / 配额 provider seam | `execution(agent)` 仍直接读三个 ctx，无替换点；只有每会话 Agent 终端数配额 | 宿主提供 seam 后，F-05 多工作区配额可退 |
| 远端会话归属记账 | 本机 `realpath` 失败仍会把旧会话写没 | 上游做到任一半：`mutate()` 不因 cwd 解析失败删账，或 `indexHeader()` 直接把与已登记工作区 path 相等的 cwd 认作成员 |

`0.2.2-rc.5` 新给的接缝（均尚未利用）：

- `working-directory/access` 事件：可在 `ensure` / `set` 里直接返回字符串，跳过本机 `ctx.fs.resolve` + `stat`，并让远端目录不存在时报自己的错。**现在就能用**，属加固 + 省一次往返；不能退役 projection 补丁（补丁修的是 schema，不是 fs 访问）。
- `preferredShells`：宿主可按家族名挑 shell；但 `dsh-terminal-panel.preferredShells` 默认空表，配成非空后才能退掉启动侧查表。
- `dsh-client-ui-context-menu` / `file-actions` / `file-drag`：行菜单定位、拖拽载荷将来可注册给宿主；前提是先核对宿主注册面是否接受「不对应本机真实路径的远端条目」。

## 3. 验证口径（不要重犯的坑）

- 默认门禁 `node tests/run.mjs`；套件数/断言数/模块数/路由数一律由 `scripts/doc-numbers.mjs` 生成到 `docs/development.md`，不要手写。
- 装配树：设 `DSH_CORE_ROOT` 后跑需要宿主包的套件；注意版本——旧解包（`0.2.1-rc.2`）只能证明「对着旧宿主还能装配」，当前宿主是 `0.2.2-rc.5`（从 `app.asar` 解出）。
- `run.mjs` 的 `partial` 第三态：整套里既有 pass 又有 skip 时不要记成整包 skipped。
- `scripts/reverse-verify-*.mjs` 是评审动作，不进 CI（会改写源文件）；判断标准是「必须变红的断言数」，不是「跑通」。
- 反向验证跑完必须 `git status --short lib` 为空（逐字节还原）。

## 4. 判定不做（保留理由，不重开）

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

## 5. 已闭环 ID 索引

代码注释里引用 `O-xx` / `F-xx` / `C-xx` 时查这里；细节看 `CHANGELOG.md` 与对应测试。

| ID | 主题 | 结论 / 落点 |
| --- | --- | --- |
| O-01 | 失败重放语义 | 已修：写类不重放，结果报“未知” |
| O-02 | watcher 降级句柄 | 已修：单一 live 句柄 |
| O-03 | 原始字节上传 CSRF | 已修：媒体类型门（415） |
| O-04 | 真机套件失效 | 已修：scratch 目录校验 + acceptance 参数 |
| O-05 | 前台/后台恢复时序 | 已修：`onRestored` 只在成功路径 |
| O-06 | shell 超时串输出 | 已修：屏障 + generation |
| O-07 | 暂存名与背压 | 已修：随机名 + drain/error 竞速 |
| O-08 | 首钥落盘失败 | 已修：degraded 诊断 + `unpinnedHostKeys` |
| O-09 | SFTP 重复打开 | 已修：single-flight（Promise 缓存 + `streamOpening`） |
| O-10 | 空列表与静默降级 | 已修：listing 三态 |
| O-11 | 可访问性 | 已修：`useDialogA11y` + `useMenuKeyboard`；C-01 补齐第四对话框与行 |
| O-12 | 客户端单文件拆分 | 已实施：C-02；宿主事实见 §6.1 |
| O-13 | 诊断形状 | 已修：`seq` / `SCHEMA_VERSION` / `exportText` 脱敏 |
| O-14 | 测试真实性 | 已关闭：假 SSH 服务器 + 三态汇总；CI 矩阵判定不做 |
| O-15 | 上游契约测试 | 已修：`upstream-contract.js` |
| O-16 | 文档数字可生成 | 已修：`scripts/doc-numbers.mjs` |
| O-17 | `Match` 是否终止 `Host` | 已修 |
| O-18 | 通配块里的身份字段 | 已修：LOST 报告 |
| O-19 | watcher 恢复闭环 | 已闭环：注册表 + 跨订阅去重 + 真 socket 断链 |
| O-20 | 容器化发布证据 | 判定不做；真机证据已建立（§4） |
| O-21 | CI 差异矩阵 | 并入 O-14 关闭 |
| O-22 | 性能基线 | 判定不做；`ls` 上限作为正确性修复独立落地 |
| C-01 | O-11 只闭合 2/3 | 已修 |
| C-02 | chunk 拆分的前提 | 已实施（§6.1） |
| C-03 | 脱敏漏点 | 已修 |
| C-04 | F-04 凭据后端 | 判定不做（§4） |
| F-01 | 断线后的语义 | 已做：分代 + watcher 重建 + 起始目录；环境恢复判为伪需求 |
| F-02 | 传输可靠性 | 已做：校验 / 冲突 / 续传 / 目录 zip / 排除 / 队列 / 暂停恢复重试；剩并发测量与工具进度（§2） |
| F-03 | 拓扑 | 已做：ProxyJump 多跳 + 反向转发；SOCKS 不做 |
| F-04 | 主机配置管理 | 已做：审计 / Include / Match / 标签 / 最近使用；凭据后端不做 |
| F-05 | 远端原生能力 | 上游阻塞（§2）；`preferredShells` 默认空表，仍靠 own-property 接管 `shells()` |
| F-06 | 能力探测 | 已做；容器端到端随 O-20 关闭 |
| F-07 | 可审计 | 已做：审计环 + 确认策略；真隔离不做 |
| F-08 | 界面 | 已做：多选 / 菜单收窄 / 批量下载 / 新建文件 / 新建文件夹 / 删除；终端 cwd 见 §2 |
| F-09 | 可观测性 | 已做；性能基线随 O-22 关闭 |
| F-10 | 配置兼容层 | 已收敛（§6.2） |
| F-11 | 恢复编排 | 触发未满足（§6.3） |
| R-01 | 下载绕过会话模式 | 已修：下载与上传同一套 mode + 落点围栏 |
| R-02 | status 双 gather / provenance | 已修：单次快照 + `provenance` + `oldestProbe` 上移 |
| R-04 | 新建文件 mode 不一致 | 已修：`DEFAULT_REMOTE_FILE_MODE` 0644 + chmod 拒绝入诊断 |
| R-05 | 写拒绝形状不统一 | 已修：`mutationFailure` + `writeModeDenialReason` + `mutation-policy` 带 `readOnlyReason` / `modeRecognised` |
| R-06 | JSON body 超限断连 | 已修：`BODY_TOO_LARGE` 哨兵 + 413 + 排空 |
| R-08 | marks 观察器成本 | 已修一半：过滤 + 幂等回收；剩时间窗（§1.2） |

## 6. 已完成工作流的宿主事实（原账本 §1.1–§1.3 摘要）

### 6.1 客户端 chunk 拆分（C-02）

宿主 `@deepseek-ai/dsh-client-modules`（`app.asar` 内）的真实能力：

| 通道 | 结论 |
| --- | --- |
| 同步 `require` 兄弟文件 | 不行：只查 seed / loadCache / factories，同步拆仍需构建或第二入口 |
| `require.async(spec)` | 可以懒加载同目录 chunk |
| chunk 命名 | `client.<name>.js`，由 `CLIENT_CHUNK` 正则校验 |
| 注册 | chunk 里 `load({ id, chunk: 'client.extra.js', factory })` |
| 取用 | 按插件目录同名文件取，不扫描、不预构建 |

**运维约束**：chunk 的 URL rev 来自主入口 `lib/client/client.js` 的文件元数据；改 chunk 不会改 rev，而宿主按精确 URL 缓存响应。所以只改 chunk 不生效，要重启或触碰主入口。

**实测**：主包 12,604 → 4,343 行、500,755 → 197,647 B（拆分收尾时）；`new Function` 编译 2.78 ms → 2.15 ms，每次页面加载省约 1.4 ms，热进程命中 V8 缓存会报 0.00 ms，必须新进程测。收益的理由是编辑时的阅读上下文，不是启动时间。

**拆分边界（踩过的坑）**：渲染期就要调用的纯函数留在主包；chunk 失败要自己包 `Suspense fallback: null`；遮蔽组件（`ForgeTabWithHistory`）不能进 chunk；`apply()` 期安装在 `document` 上的桥不能进 chunk；`apply` 可以是 async，但 `await` 之后一切都可能还没到；宿主无条件渲染的空洞要先判 `open`；启动 chunk 的名字要在 `loadBootChunks()` 末尾用 `republishBootNames()` 重发布（`Object.assign` 拷的是值，模块求值时还是占位符）。

### 6.2 配置解析的统一词法层（F-10）

已收敛，原前提不成立：只有一个 section 切分实现（`lib/hosts/ssh-config.js` 的 `sectionsOf`），`Match` 与 `Host` 共用 `patternMatches` / `matchSelects`；两个消费者（`lib/hosts/hosts.js` 与 `lib/report/report.js`）读同一套。指令词表只在 `lib/report/report.js` 维护。完整 OpenSSH 语义仍不做（§4）；将来要支持引号模式或续行，按窄修处理，不预先抽象。

### 6.3 资源恢复编排（F-11）

触发未满足：需要跨连接恢复的仍只有转发与 watcher 两类，二者各自已有幂等生命周期；上传续传是传输内部状态，连接本身是策略，持久 shell 刻意不跨进程恢复。出现第三类资源或两类需要共享恢复顺序/代次时再立项。**明确不做**：承诺断线后远端命令继续运行（§4）。

## 相关

- [features.md](../features.md)：每个能力“做什么、怎么用、缺依赖时怎么降级”。
- [tools.md](../tools.md)：11 个 Agent 工具的参数与行为。
- [development.md](../development.md)：源码结构、测试套件与生成数字。
- [upstream-workarounds.md](../upstream-workarounds.md)：单条上游补丁的登记模板、上游修法与删除步骤。
- [../CHANGELOG.md](../../CHANGELOG.md)：已发布版本的实际变更。
