# 优化项与 Future（第二辑：2026-11-04 复审）

一句话定位：第一辑（[optimization-and-future.md](./optimization-and-future.md)）记录的是首次全量审阅与它的推进结果；**本辑只记录其后的第二轮复审**——新发现的问题、对第一辑若干结论的更正，以及由这些更正派生出的可验收工作。

- 基线：`v0.2.8` 之后的提交 `1110c98`。
- 方法：只读源码与文档；对能用纯函数或临时伪造配置验证的结论，一律**实跑**而不是推断；临时目录在 `finally` 里删除。
- 边界：**没有修改实现、没有连接任何真实 SSH 主机、没有性能剖析**。凡"实测"都指本机跑出的返回值或源码结构，不指真实连接行为。
- 与第一辑的关系：第一辑的 O-01 … O-16 与 F-01 … F-09 **保持 2026-10-31 的历史状态未改写**。本辑对其中三条（O-11、O-12、O-13）的更正写在本辑的「对第一辑条目的更正」一节，尚未回写到第一辑。
- 结论先行：本轮没有推翻架构方向，但推翻了一条上一轮自己写下的"不做"结论（O-12），并发现一处**会让跳板机保护被静默关掉**的配置边界错误（O-17，P0）。

## 本轮结论与顺序

| 顺序 | 项 | 级别 | 本轮判断 | 完成判据 |
| --- | --- | --- | --- | --- |
| 1 | O-17 `Match` 块边界 | P0 · S | **已修**（2026-11-05）：`Match` 现在终止 section，三个消费者共用 `lib/ssh-config.js` | 不支持的 `Match` 整段被跳过；代理反例必须拒绝连接 ✅ |
| 2 | O-18 通配块与审计口径 | P1 · M | **已修**（2026-11-05）：非精确块的身份字段报 `lost`；词表三个死键已规范化 | 实际未采用的设置一定显示为 `lost`，解析与审计共用同一 section 边界 ✅ |
| 3 | C-01 O-11 第 4 个对话框与条目键盘 | P1 · S | **已修**（2026-11-05）：对话框、条目、右键菜单、错误 toast 四处；断言改为逐组件点名 | 每个对话框都满足同一组断言；纯键盘可进入目录 ✅ |
| 4 | C-03 O-13 脱敏漏点 | P1 · S | **已修**（2026-11-05）：脱敏抽成 `lib/redact.js`，三处共用；`user@host:port` 与凭据文件名已补 | 两条真实字符串的输出不含用户名/内网主机名；两份产物口径一致 ✅ |
| 5 | O-19 重连后的 watcher 恢复 | P1 · M | F-01 的剩余项；保存的转发会恢复，watcher 的恢复责任仍未闭环 | 真断链后文件树恢复刷新，且同一目标始终只有一个活动 watcher |
| 6 | O-20 一次性 OpenSSH 真机验收 | P1 · M | 发布与 CI 仍没有真实主机证据；`live` / `acceptance` 无环境时跳过 | 容器主机上跑通发布清单，失败清理与 SKIP 都可审计 |
| 7 | O-21 最小跨平台 CI | P2 · S | 当前只有 Ubuntu + Node 20；项目声明 Node `>=20`，主要使用面又包括 Windows | Ubuntu / Windows 覆盖 Node 20 与 24 的纯套件，lint/docs/pack 只跑一次 |
| 8 | O-22 性能基线先于规模优化 | P2 · M | F-09 的剩余项；没有数据时不应新增缓存、预取或传输并发 | 冷启动、首字节、目录列举、传输与多工作区都有可重复基线 |
| 9 | C-02 O-12 拆分可行性更正 | P2 · M | 原"必须加第二入口或引构建"被证伪；宿主 `require.async` + `client.<name>.js` chunk 可懒加载拆分，无构建 | chunk 在无构建仓库中被宿主加载，同步路径仍单入口 |

排序依据是"错误结果 > 安全边界 > 证据缺口 > 工程效率"。O-17 与 C-01/C-03 都是 S 级复杂度、可直接改，因此排在最前。

## 新增优化项

### O-17 `Match` 必须终止当前 `Host` 块

**级别**：P0 · **复杂度**：S · **位置**：`lib/hosts.js:43-66`、`lib/hosts.js:115-141`、`lib/config-audit.js:161-195`

> **推进结果（2026-11-05）**：已修。新增 `lib/ssh-config.js` 作为唯一的 section 切分实现（`sectionsOf` / `selects` / `isExact` / `patternMatches`），精确块、代理扫描与审计全部改从它读；`Match` 整段不进入任何结果。新增 `tests/ssh-config-smoke.mjs`（43 项），含三组对照与「`Match` 名字恰好等于 alias 时仍不得取消跳板机」这条最刁钻的用例。反向验证：让 `Match` 行退回普通关键字 → 3 红；让 `selects()` 放行 `match` 段 → 2 红。

三个扫描器都只在新 `Host` 行重置 `inBlock` / `applies`，遇到 `Match` 却继续沿用前一个 `Host` 的选择状态。这与文件头"`Match` 被忽略"的设计不一致：实际行为不是"忽略整个 `Match` 段"，而是"忽略 `Match` 这一行的关键字，却可能采用它后面的配置"。

身份字段会被误读。例如 `Host web` 后面的 `Match host db` 本不应作用于 `web`，但其后的 `User` / `IdentityFile` 仍会进入 `readSshConfigBlock(file, 'web')` 的结果。本轮实测证实了这一点：对

```sshconfig
Host web
  HostName web.example

Match host db
  User evil
  IdentityFile ~/.ssh/evil
  Port 2222
```

`HostStore.resolve('web')` 返回的是 `{ host: 'web.example', user: 'evil', port: 2222, auth: { kind: 'key', keyPath: '<home>/.ssh/evil' } }`。**主机名是对的，凭据、端口和用户名却是另一台机器的**——这比"某个设置没生效"严重：它会用错误的身份连到正确的主机。

更严重的是代理反例：

```sshconfig
Host web
  HostName web.example

Match host db
  ProxyJump none

Host *
  ProxyJump bastion
```

`readSshConfigProxy` 会先在仍被误判为适用的 `Match` 段记下 `ProxyJump none`，后面的全局 `bastion` 再因 first-wins 被跳过；`needsProxyTransport` 最终把主机视为可直连。按 OpenSSH 语义，不匹配的 `Match host db` 不应产生这个 `none`，后面的全局跳板机仍应适用，而本插件当前正确行为应是**拒绝连接**。

本轮已用上述内容写入一份临时伪造配置，并以不读取真实主机存储的替身调用真实 `HostStore.resolve('web')`：它返回了 `host: 'web.example'`、`source: 'ssh-config'` 的描述符，**没有抛出跳板机拒绝**。临时目录随后删除；该探测只证明解析结果，没有发起网络连接。

**三组对照最能说明危害**（同一份代码、同样不读取真实存储，临时文件用完删除）：

| 配置 | 期望 | 实测 |
| --- | --- | --- |
| 仅 `Host *` 里写 `ProxyJump bastion` | 拒绝 | **拒绝** ✅ |
| 同上，但在前面插入不匹配的 `Match host db` + `ProxyJump none` | 拒绝 | **放行** ❌ |
| 精确块 `ProxyJump none` + `Host *` 里 `bastion` | 放行（用户显式关闭） | 放行 ✅ |

第二行是关键：保护本身是有效的，但**只要配置文件里先出现一个与目标无关的 `Match` 段，这条保护就被静默关掉**。用户不需要写错任何与自己主机有关的东西——`Match host db` 看起来与 `web` 毫无关系。

**建议**：

1. 最小修复不是实现 `Match`，而是在三个扫描器中遇到 `Match` 就关闭当前 section，直到下一个 `Host`；段内所有关键字都不得进入结果。
2. 保留"`Match` 不支持"的可见提示，但不得一面声称未采用、一面把段内设置合并进描述符。
3. 把 section 切分抽成共享迭代器，精确块、代理扫描和审计都从它读取，避免只修一处。完整求值属于 F-10，不在这次最小修复里顺带实现。

**验收**：

- 非匹配 `Match` 中的 `User` / `IdentityFile` 不改变 `HostStore.resolve(alias)`。
- 上面的 `ProxyJump none` 反例必须进入 `skipped`，不得返回可直连描述符。
- `Match` 后的下一个普通 `Host` 仍能解析；原有 `Host *`、否定通配、`ProxyJump none` 与 first-wins 用例全部保留。
- 反向验证：只在代理解析器里恢复旧的"不终止 section"行为，安全反例必须变红。

### O-18 通配块中的“支持字段”也会静默丢失

**级别**：P1 · **复杂度**：M · **位置**：`lib/hosts.js:53-64`、`lib/hosts.js:93-103`、`lib/hosts.js:296-330`、`lib/config-audit.js:54-68`、`lib/config-audit.js:144-194`

> **推进结果（2026-11-05）**：已修。新增 `EXACT_ONLY_KEYWORDS`，审计按「这一行所在 section 是否被 resolver 采用」判定，非精确块里的身份字段逐字段报 `lost`；精确块里的同一关键字保持沉默（不制造假警告）。词表三个死键已规范化，并加一条遍历整张表的可达性断言。反向验证：去掉 `EXACT_ONLY_KEYWORDS` 分支 → 4 红；把 `addkeystoagent` 改回混合大小写 → 3 红。

身份解析刻意只读精确 `Host <alias>` 块；代理与配置审计却会扫描通配块。这个差异本身可以是有意的子集限制，但审计在扫描到 `Host *` 中的 `User` / `IdentityFile` / `ForwardAgent` 等字段时，会因为它们位于 `SUPPORTED_KEYWORDS` 而直接跳过。结果是：解析器没有采用，审计也没有报告。

本轮用纯函数实际探测了下面的输入，`auditConfigText(text, 'web')` 返回 `[]`：

```sshconfig
Host *
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  ForwardAgent yes
Host web
  HostName web.example
```

因此用户可能以本机默认用户和 agent 连接，却看不到"配置里的用户、密钥与 agent 转发没有生效"。`config-audit.js:147-152` 所称"与 resolver 相同的匹配规则"目前只对"不支持的字段"成立，不对"支持但仅限精确块的字段"成立。

另有一个小型契约缺口：`verdictFor` 接收小写关键字，而 `KNOWN_UNSUPPORTED` 中仍有 `addkeysToagent`、`strictHostKeyChecking` 这样的混合大小写键，手写判据实际上命中不到。应加一条"词表键全部规范化"的测试，而不是靠阅读发现。本轮实测确认了两条退化路径，还发现第三条：

- `verdictFor('addkeysToagent')` 与 `verdictFor('stricthostkeychecking')` 都返回兜底文案，即词表里那条专门说明**永远读不到**；
- 词表里还有一条 `'strict-host-key-checking'`（带连字符）。解析用的正则是 `/^([A-Za-z][A-Za-z0-9]*)[\s=]+(.+)$/u`，字符类里没有 `-`，所以这行**连作为关键字被识别都不可能**，是一条死键。

同一轮实测也证实了这条：`Host *` 里的 `StrictHostKeyChecking no` 与 `AddKeysToAgent yes` **确实被报告了出来**（不是漏报），但两者的 `detail` 都是兜底文案「not read by this plugin; it has no effect on a remote workspace」，而不是各自手写的「本插件始终校验主机密钥」「不会由本插件向 agent 添加密钥」。也就是说这两个键的特化说明是死代码。影响是措辞变差，不是漏检——因此定级为 P1 条目下的小型缺口，不单列一项。

**建议**：

- 短期保持身份字段 exact-only，但在非精确匹配块中遇到这些字段时报告 `lost`，说明"仅在具体 `Host` 块读取"；不要改报 `ignored`。
- 更完整的方案是实现 OpenSSH first-wins 的通配身份继承，但那会改变现有连接行为，应单独作为 F-10，并配迁移说明与兼容性测试。
- 审计表按"这个 section 是否被 resolver 采用"驱动，而不是只按全局关键字集合驱动；规范化所有词表键。

**验收**：通配块中的每个身份字段都有逐字段 `lost`；精确块中的相同字段不产生误报；`Host *` 的 `LocalForward` 与 `ProxyJump` 既有行为不回归；词表中每个键都能被 `verdictFor` 实际命中（一条遍历 `KNOWN_UNSUPPORTED` 的断言即可，本轮已证明现有三条例外键都命中不到）。

### O-19 把 watcher 恢复责任闭环，而不只是恢复连接

**级别**：P1 · **复杂度**：M · **位置**：`lib/index.js:162-176`、`lib/remote-fs.js:844-881`、`lib/remote-fs.js:1200-1230`

当前重连成功钩子只恢复已存端口转发。push watcher 断掉后会降级到轮询，这是已有保障；但轮询在观察失败时会 `stop()` 并调用 `changed(error)`，随后按 seam 合同由调用方关闭。插件没有 watcher 注册表或重建设入口，因此 F-01 中"重连后重建变更监视并重新扫描"仍是未完成项。

这不等于断言所有宿主版本都必然失效：调用方也可能在收到错误后自行重建。当前缺的是**可验证的责任归属与真实断链证据**。不能简单在 `startRemoteWatch` 内吞掉错误并无权重试，那会违反"错误后调用方关闭"的合同，并可能叠加 watcher。

**建议**：先确认宿主消费端的错误处理，再二选一：由宿主消费端重建；或由插件登记目标、代数与关闭句柄，在重连后幂等重建。恢复后先做一次全量快照，再发"离线期间可能发生变化"的事件。保存转发、watcher、持久 shell 不应共用一个含义不清的"已恢复"标志。

**验收**：用真实 socket 在 push 与 poll 两种模式下各断一次；重连后远端变更能再次刷新文件树，同一目标活动 watcher 数恒为 1，关闭工作区后不再重连。

### O-20 用一次性 OpenSSH 容器补齐发布证据

**级别**：P1 · **复杂度**：M · **位置**：`tests/live-smoke.mjs`、`tests/acceptance-smoke.mjs`、`tests/support/fake-ssh-server.mjs`、`.github/workflows/release.yml:19-42`

假 SSH 服务器已经证明真实 socket 的断连与主机密钥路径，但它不是 OpenSSH，也不覆盖宿主 `rg` / `git` / `inotifywait`、SFTP 实现差异、POSIX 工具输出与真实 PTY。当前 CI 与 Release 都只执行无真机环境下的 `npm test`；相关套件可以合法 SKIP，因此"发布绿"不等于这些路径运行过。

**建议**：增加一次性容器主机夹具，密钥由测试生成，不接生产主机。先作为发布前手动命令，稳定后再决定是否进 CI。运行现有 `live` / `acceptance`，再覆盖最小 OpenSSH 差异矩阵：有无 `inotifywait`、有无 `rg`、非默认 POSIX shell、密钥变更、上传中断。清理继续使用 `tests/scratch.mjs` 的白名单，不为了自动化放宽它。

**验收**：同一提交在全新容器上得到一份带环境版本、PASS / SKIP / FAIL、清理结果的发布记录；任何必需用例 SKIP 都使发布验收不通过，而不是被汇总成全绿。

### O-21 采用最小但有意义的跨平台 CI

**级别**：P2 · **复杂度**：S · **位置**：`.github/workflows/ci.yml:8-34`、`package.json:14-23`

当前只有 Ubuntu + Node 20。旧 O-14 对"矩阵只是重复纯测试"的保留意见仍然适用于盲目堆版本，但不适用于完全缺少 Windows 与当前 Node 的情况：项目声明 Node `>=20`，开发与主要使用环境包含 Windows，路径、换行、Pageant 分支和进程行为都不是 Ubuntu 单格能证明的。

**建议**：测试矩阵只做 **Ubuntu / Windows × Node 20 / 24**；`lint`、`check:docs`、`npm pack --dry-run` 保留在 Ubuntu + Node 20 单格。真机容器按 O-20 独立分层，不把普通 PR 矩阵变成依赖外部服务的 flaky 门禁。Node 22 可以后续加，不是第一优先级。

**验收**：四个组合都实际打印套件与 SKIP 汇总；Windows 失败不能被 `continue-on-error` 吞掉；总时长与缓存命中率有记录，若成本过高再缩减而不是无声取消平台覆盖。

### O-22 先建立性能基线，再决定传输与规模化方案

**级别**：P2 · **复杂度**：M · **位置**：第一辑的 F-02 / F-05 / F-09、`lib/engine.js:865-912`（streamChannel）、`lib/transfer.js:41`（`CHUNK_BYTES`）

第二条 SFTP 通道、元数据 single-flight、背压与暂存唯一性已经解决了明确的结构性问题。下一步不应凭直觉增加预取、缓存或全局并发。F-02 的断点续传、目录下载、传输队列，F-05 的多工作区配额，都需要先知道瓶颈在 SSH 往返、SFTP 包大小、远端磁盘还是本机渲染。

**建议**：把基线脚本与原始结果一起存档，至少覆盖：冷启动建连、首个 SFTP 字节、1000 文件目录列举、1 GiB 上下行、10 个工作区空闲与并发操作；记录 RTT、吞吐、RSS、活动连接/通道数和错误率。传输大文件使用生成数据，不把真实项目内容写进报告。

**验收**：同一容器与同一数据集各重复三次，报告中位数与离散程度；后续每个性能 PR 都引用基线并给出前后对比。没有基线前，不新增"自适应并发"之类策略旋钮。

## 对第一辑条目的更正

下面三条不是新问题，而是**第一辑已记"完成/不做"但本轮实测认为没有闭合的条目**。第一辑正文保持原样，这里给出更正后的判断；回写第一辑应单独做，并同时更新其中的推进状态说明。

### C-01 O-11 只闭合了三分之二，而且测试把缺陷固化成了"预期"

**级别**：P1 · **复杂度**：S · **对应**：[O-11 可访问性：对话框与菜单](./optimization-and-future.md#o-11-可访问性对话框与菜单)

> **推进结果（2026-11-05）**：已修（本条列出的六处缺口全部处理）。`DirectoryBrowser` 接入 `useDialogA11y`；条目行的目录项改为真正的 `<button>`；右键菜单补上打开即聚焦、`nextMenuIndex` 方向键、Esc/Tab 关闭与焦点归还，并新增 Shift+F10 / 菜单键入口；错误 toast 不再自动消失且改用 `role="alert"`。**测试的写法也改了**：`=== 3` 换成「每个对话框组件都必须调用」并逐个点名，这正是本条指出的「断言形式与要保证的内容不匹配」。反向验证四处各真红 1–4 条。`ls` 的条数上限（本条附带发现）未做，属性能项，留待 O-22 有基线后再定。

**第 4 个对话框漏接钩子**。文件里共有四个对话框，`HostEditor`（`:1396`）、`ReportDialog`（`:1764`）、`RemoteDialog`（`:3352`）都用了 `useDialogA11y`，但 **`DirectoryBrowser`（`:1446`）没有**：它有 backdrop、有 `sshwsp-dialog` 样式，却没有 `role="dialog"`、没有 `aria-modal`、不移动焦点、不归还焦点、也没有 Esc（全文 Escape 只有 `:1140` 对话框钩子、`:3210` 菜单、`:4433` 任务菜单三处）。

**测试反而保护了这个缺陷**：`tests/client-shape-smoke.mjs:354` 断言 `count(/useDialogA11y\(\{/gu) === 3`。这个数字写死成 3，所以**第四个对话框漏接时测试依然通过**——它检查的是"调用次数等于 3"这个形式，而不是"每个对话框都接上了"这个内容。这与 O-14 批评过的"检查形式与要保证内容不匹配"是同一个毛病。

**文件浏览器条目无法用键盘操作**。`:1660-1686` 的条目渲染成 `jsxs('div', { onClick })`，没有 `tabIndex`、没有 `role="button"`、没有 keydown。而样式层（`:595` 的 `.sshwsp-entry:focus-visible` 焦点环、`:626` 的 `cursor:pointer`、`:629` 的 `:disabled`）**在假装它是个按钮**。键盘用户无法进入任何目录——而这恰好又是唯一没接 a11y 钩子的那个对话框，两个缺口叠在同一处。

**`ls` 路由无条数上限**（顺带发现，属性能而非 a11y）：`lib/routes.js:1000-1015` 的 `sftp.readdir` 全量返回，没有 cap、没有分页，客户端 `:1660` 直接 `entries.map` 全量渲染、无虚拟化（`LIST_CAP` 只用于面板分区）。1000+ 文件的目录会同步阻塞渲染。F-09 把"1000 文件目录列举"当作性能基线项，但没把它标成 UI 风险。

**右键任务菜单的 `role` 是装饰性的**：`openTaskMenu`（`:4374`）设 `role="menu"`、`:4382` 设 `role="menuitem"`，但整段（`:4368-4460`）没有焦点管理、没有方向键、没有 Home/End，也没有接 `useMenuKeyboard`；触发方式只有 `contextmenu`（`:4611`），键盘用户打不开。**虚假语义比没有语义更糟**——读屏器会宣告"菜单"，用户却进不去。而它恰是"下载 / 上传 / 加入任务"的唯一入口。

**错误提示 3.5 秒后自行消失，且无重试**：`:2050` 与 `:4072` 都是 `setTimeout(..., 3500)`，传输失败只经 toast 告知（`:4158`、`:4211`），3.5 秒后连错误文本一起消失，没有重试按钮、没有详情留存、不能复制。错误用 `role="status"`（polite）而不是 `alert`，读屏可能还没读完就被移除。

**建议**：把 `client-shape-smoke:354` 的 `=== 3` 改成"每个对话框组件都必须调用钩子"的枚举断言（或直接断 `count(对话框组件) === count(useDialogA11y 调用点)`），这样第 5 个对话框漏接也会红；给条目行加 `tabIndex={0}`、`role="button"` 与 Enter/Space 处理；`DirectoryBrowser` 接入 `useDialogA11y`；右键菜单接入键盘（复用 `nextMenuIndex` 的索引算术，DOM 版需抽出共享计算）；`ls` 加 `limit` + `offset` 并在超阈值时给出"已截断"提示；错误 toast 不自动消失或延长到可读完，并提供重试。

**验收**：`DirectoryBrowser` 满足与其余三个对话框相同的断言；纯键盘能在文件浏览器里进入目录、下载文件、关闭对话框并回到触发元素；右键菜单可用键盘打开并选择；`ls` 超限时有明确提示；错误 toast 在用户操作前不消失；断言 `useDialogA11y` 的调用点数与对话框组件数相等，而不是等于一个字面量。

### C-02 O-12 的"前提不成立"只对了一半，第三选项确实存在

**级别**：P2 · **复杂度**：M · **对应**：[O-12 客户端单文件过大，建议绞杀式拆分](./optimization-and-future.md#o-12-客户端单文件过大建议绞杀式拆分) · **状态下调为：可做，待排期**

第一辑写"要多文件就得声明第二个 `dsh.client` 入口，或引入构建步骤"，并据此标记为**不做**。这句话**不准确**。核对宿主 `@deepseek-ai/dsh-client-modules`（`app.asar` 内 `dsh/node_modules/.../lib/client.js`，本轮已从归档中解出并逐行确认）：

| 宿主能力 | 位置 | 含义 |
| --- | --- | --- |
| 同步 `require` 兄弟文件 | `:833-841` 只查 seed / loadCache / factories | **不行**——这正是原来那句成立的一半 |
| `require.async(spec)` | `:842-847`，相对路径转 `importChunk` | **可以**异步加载同目录兄弟 chunk |
| chunk 命名 | `:600` `CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` | `client.extra.js` 合法 |
| 注册 | `:704` 校验 `registration.chunk` | chunk 里写 `load({ id, chunk: 'client.extra.js', factory })` |
| 取用 | `:852-877` `chunkUrl(...)` + `loadBundle` | 宿主按插件目录下的同名文件取，**不扫描、不预构建** |

所以真正的结论是：**不能同步拆，但可以按 `require.async` 的懒加载边界拆，且不需要构建步骤**。它与"纯 loader、无构建、单入口"三者都不冲突。可拆的是只在交互后才渲染的部分（对话基座、面板分区、文件浏览器），不能拆的是被多处同步引用的顶层工具函数——这恰好就是绞杀式拆分的形状。

**证据边界（诚实标注）**：上面是**静态证据链**——已从归档中解出宿主源码并确认了 `require.async`、`CLIENT_CHUNK`、`registration.chunk`、`importChunk` 与磁盘读取逻辑，但**没有实机验证 chunk 真的被加载**（那需要新增一个 `lib/client.*.js` 并观察 `/plugins/` 请求，属于改动仓库，超出本轮范围）。若要落地，最小实验是：加一个只含 `load({ id, chunk, factory })` 的 `client.probe.js`，在主 bundle 里 `require.async('./client.probe.js')` 一次，确认宿主返回 200 且注册成功。

**顺带修正第一辑的职责地图**（`lib/client.js:11-44`）：那张图有三类错误，与"行号会漂移"不同，属于内容错误。

- **有两个条目对应的分节根本不存在**：地图第 7 条"Forwarding panel"——转发面板实际在主面板（`// Main panel`，`:1817`）之内，没有独立 banner；第 9 条"Directory flow / persistent sessions"——实际分节叫 `// Add-workspace flow (directoryFlow slot occupant)`（`:3104`）。
- **顺序错了**：地图把 Locale 排在 CSS 之后，实际 `// Locale`（`:105`）在 `// CSS`（`:548`）之前。
- **漏列**：文件内共有 18 个带标题的分节（`// ====` 分隔线 37 处，含成对边框与段内说明），地图只列 10 个，漏了 SVG Icons（`:801`）、Host card（`:891`）、Host editor dialog（`:1304`）、Directory browser dialog（`:1443`）、Diagnostic report dialog（`:1731`）、Composer file bridge（`:3908`）、Transfers（`:4075`）、File-panel header actions（`:4231`）等。

**验收**：地图条目数等于实际带标题分节数，且每个条目能在文件中唯一定位到对应 banner 标题；若排期做 chunk 拆分，`client.extra.js` 能在无构建仓库中被宿主按 `require.async('./client.extra.js')` 加载，同步路径仍只依赖单入口，`client-shape` 与手工冒烟通过，拆出的 chunk 不引入对顶层共享函数的依赖。

### C-03 O-13 的脱敏仍有两个真实漏点

**级别**：P1 · **复杂度**：S · **对应**：[O-13 诊断事件缺少稳定的对外形状](./optimization-and-future.md#o-13-诊断事件缺少稳定的对外形状)

> **推进结果（2026-11-05）**：已修。新增 `lib/redact.js`，`diagnostics` / `support-bundle` / `audit` 三处共用一套规则（前两者原本各有一份且互相矛盾）。补 `user@host:port` 与凭据样式的文件名。新增 `tests/redact-smoke.mjs`（29 项），断言用真实字符串与真实函数，并额外钉住幂等性与三处产物的口径一致。反向验证：删掉 `user@host:port` 规则 → 6 红；把 `diagnostics` 退回旧规则 → 2 红。

第一辑说 `exportText()` "默认脱敏…可直接贴进 issue"。实测不成立。`redactSecrets`（`lib/diagnostics.js:94-105`）只覆盖家目录、私钥文件名与显式口令三类：

```
connected to alice@prod-db-01.internal.corp:22        ← 用户名 + 内网主机名全裸
reading /srv/acme-secret/prod.key and /opt/internal/… ← 非家目录绝对路径全裸
key at <key> password=<redacted>                      ← 这三类确实挡住了
```

第一行最要紧：它是 `lib/engine.js:800` 在**每条正常连接**时都会记的事件，所以任何一份"可直接贴进 issue"的诊断文本都会带着登录用户名和内网主机名。

而且规则本身就不一致：`lib/support-bundle.js:92-104` 的 `maskPath` **有** `user@host:port` 规则（注释还专门解释了为何只匹配 `host:port` 形态、以免误伤邮箱），`diagnostics.js` 却没有同一条。同一个字符串在支持包里被脱敏、在 `diagnosticsText` 里不被脱敏——两份对外产物，两套口径。

**建议**：把脱敏规则抽成一个模块，`diagnostics`、`support-bundle`、`audit` 共用；补 `user@host:port` 与"任意绝对路径中疑似的凭据/密钥文件名"，并对 `/srv`、`/opt`、`/var` 下的用户目录同样处理。

**验收**：用上面三条真实字符串断言输出不含 `alice`、`prod-db-01.internal.corp`、`acme-secret`；`support-bundle` 与 `diagnosticsText` 对同一输入给出相同结果。

## Future 补充

### F-10 从“多次扫描配置”演进为可验证的兼容层

O-17 与 O-18 的共同根因不是支持字段太少，而是同一份配置被三套扫描逻辑以不同 section 规则解释。长期方向是分两层：

1. **词法与 section 层**：统一识别 `Host` / `Match`、通配与否定、first-wins、注释和续行；不支持的语法必须保留边界与来源行号。
2. **语义层**：身份、代理、转发和审计分别声明自己支持的子集；任何"没有采用"都能追溯到具体行与原因。

`Include` 可以在这层之后加入，带递归深度、总文件数与循环上限；`Match` 先支持可证明的子集，不能用字符串包含或正则猜测条件。目标不是重写 OpenSSH，而是让"支持什么、拒绝什么、忽略了什么"由同一份解析结果回答。

### F-11 从单个恢复钩子演进为资源恢复编排

第一辑的 F-01 已给出连接代次，已存转发也有幂等恢复。下一步可把"插件拥有的可恢复资源"显式登记：资源类型、目标、所属连接代次、恢复函数、关闭函数与最近结果。watcher、转发和持久 shell 分别声明语义：

- 转发可以恢复原意图；
- watcher 必须先重扫描再恢复通知；
- shell 只能开新代并尽力恢复已知 cwd，不能声称旧进程与环境仍在。

恢复失败要进入现有诊断环，且异步恢复必须可被等待和测试；当前同步 `try/catch` 包住的钩子只适合同步工作，不能直接扩展成一组未跟踪 Promise。该方向依赖 O-19 的责任划分，不应先造一个通用框架再寻找用途。

### 更新后的 Future 触发顺序

1. **先修配置正确性**：O-17 / O-18；F-10 在回归矩阵稳定后推进。
2. **再恢复与验证**：O-19 / O-20；F-11 只在出现第二类真实恢复需求时抽象。
3. **工程证据并行**：O-21 可立即做，O-22 为 F-02 与 F-05 提供测量前提。
4. **原有能力扩展保持第一辑的顺序**：F-02（传输）、F-03（多跳）、F-04（配置与凭据）、F-05（上游原生 execution world）、F-07（策略确认）仍是产品能力主线；本辑不把已被否决的完整 TypeScript 重写、通用缓存或"远端沙箱"重新包装成新 Future。

## 本轮实测记录（可复现）

下面这些不是推测，是在 `1110c98` 上实际跑出来的。除标注外都不需要网络、也不碰真实主机；临时目录都在 `finally` 里删除。

| 验证 | 方法 | 结果 |
| --- | --- | --- |
| 全套件 | `node tests/run.mjs` | 44 套件：**38 通过 / 6 跳过 / 0 失败**；跳过项为 `projection-real`、`lifecycle`、`boot`、`tool-schemas`、`live`、`acceptance` |
| 文档一致性 | `npm run check:docs` | 全部 markdown 文件的链接与锚点通过；`docs/development.md` 数字表一致 |
| O-01 重放策略 | 读 `lib/engine.js:808-854`、`:1058-1134` + `replay-smoke` | `withSftp` 的 `replayable = options.kind !== 'write'`；非重放时记 `outcome: 'unknown'` 并写明 "remote outcome is unknown"；`exec` 需显式 `replay: 'safe'` 才重放。34 项通过 |
| O-17 代理绕过 | 三份临时 ssh config + `HostStore.resolve('web')` | 只有 `Host *` 的 `bastion` → **拒绝**；前面插一个不匹配的 `Match host db` + `ProxyJump none` → **放行**；精确块 `none` 覆盖 `Host *` → 放行（预期） |
| O-17 身份污染 | 同上，读返回的描述符 | `user: 'evil'`、`port: 2222`、`auth: { kind: 'key', keyPath: '.../.ssh/evil' }`，而 `host` 仍是 `web.example` |
| O-18 通配身份 | `auditConfigText(text, 'web')` | `Host *` 里的 `User` / `IdentityFile` / `ForwardAgent` → **`[]`**（既不报 `lost` 也不报 `ignored`） |
| O-18 词表死键 | 遍历 `KNOWN_UNSUPPORTED` + `verdictFor` | `addkeysToagent`、`strictHostKeyChecking` 退化为兜底文案；`strict-host-key-checking` 连解析正则都匹配不上 |
| C-03 脱敏 | `Diagnostics.exportText()` | 私钥路径 → `<key>`、`password=...` → `<redacted>`；`user@host:port` 与非家目录绝对路径原样输出；`tools.js:1027` 是唯一用户可达调用点，只传 `{ limit }`，没有 `redact: false` 出口 |
| O-06 隔断屏障 | `node tests/shell-smoke.mjs` | 35 项通过，含"CJK 字符跨块解码完整、无替换符" |
| O-07 暂存与背压 | 读 `lib/transfer.js` + `transfer-smoke` | 随机暂存名 + `'wx'` 独占打开；下载 `drain` 与 `error` 竞速。套件因缺装配树 SKIP |
| O-19 恢复范围 | 读 `lib/index.js:162-176` 并搜索 | `onReconnected` 只调 `savedForwards.reopenEnabled`；无 watcher 注册表/重建入口 |
| 假 SSH 服务器 | `node tests/fake-transport-smoke.mjs` | **32 项通过**（第一辑早先写的 23 项是首版数字） |
| 其他 ssh_config 语义 | 同上，逐个临时配置 | `Include` **不被跟随**（主文件的 `HostName` 生效，被包含文件被忽略）；重复 `Host` 块 first-wins（取 `first`）；`Host WEB` 查 `web` → 拒绝（大小写敏感，与 OpenSSH 一致）；单独 `ProxyCommand` → 拒绝；`Host * !web` 的 `ProxyJump` **不**作用于 `web`（否定模式正确） |
| C-01 第 4 个对话框 | 读 `lib/client.js` + `tests/client-shape-smoke.mjs:354` | 4 个对话框只有 3 个调用 `useDialogA11y`，`DirectoryBrowser`（`:1446`）没有；测试断言 `=== 3`，所以漏接恒通过 |
| C-01 条目与菜单 | 读 `:1661-1686`、`:4374`、`:4368-4460` | 条目是 `div`+`onClick`，无 `tabIndex`/`role`/keydown；右键菜单有 `role="menu"` 但该区间 `Arrow`/`focus` 命中 0 |
| C-01 错误 toast | 读 `:2050`、`:4072` | 两处 `setTimeout(..., 3500)`，失败原因 3.5 秒后消失，无重试 |
| C-02 职责地图 | 读 `:11-44` 与实际 banner 标题 | 地图 10 条中，"Forwarding panel" 与 "Directory flow" **无对应分节**；Locale 实际在 CSS 之前；实际 18 个带标题分节，漏列 8 个 |
| C-02 chunk 通道 | 从 `app.asar` 解出 `dsh-client-modules` 并读源码 | `:600` `CLIENT_CHUNK`、`:704` `registration.chunk`、`:842-847` `require.async`、`:852-877` `importChunk` 均在；**未实机验证加载** |
| F-08 词典守卫 | `node tests/locale-register-smoke.mjs` | 21 项通过，含"没有 key 原样渲染"；文件浏览器内 `multiple`/`onDrop`/`selected`/`checkbox` 命中 0 |

结论：**除 `Match` 段边界外，其余已实现的 ssh_config 语义与 OpenSSH 一致**。这也说明 O-17 不是"整体解析器不可靠"，而是一处局部边界错误——修复面应该按 O-17 的建议收敛在 section 切分上，不要顺带重写其他部分。

关于那 6 个 SKIP：本轮确认它们在本机**无法**被强行跑通，而不是被跳过省事。`DSH_CORE_ROOT` 需要一个装着 `@deepseek-ai/cordis`、`dsh-fs`、`dsh-tools` 的 `node_modules` 目录，而本仓库没有这个依赖树（`node_modules/@deepseek-ai` 不存在），DSH 的实现又是打包在 `app.asar` 里的归档、无法直接当作 `node_modules` 指过去。**要让这 6 个套件真正运行，必须先有一个装配好的环境**——这正是 O-20 / O-21 要解决的问题，也是为什么"发布绿"目前不等于"这些路径跑过"。

## 判断依据与局限

- 本辑所有 P0/P1 判断都能在源码里指到具体行；涉及"时序""可能"的，均给出触发条件，未做真机验证。
- **证据形态是返回值与源码结构**，不是真实连接行为：O-17 的解析结果、O-18 的审计输出、C-03 的脱敏文本都是本机调用真实模块得到的，但没有发起任何网络连接。
- **没有性能数据**：O-22 因此只提出"先测再改"，不给任何具体并发/缓存参数。
- 本轮**未改动任何实现**：新增与更正都只落在文档；临时配置与临时目录已删除。

## 相关

- [optimization-and-future.md](./optimization-and-future.md)：第一辑，首次全量审阅的 16 项优化、明确不做的事与 9 个能力方向
- [architecture.md](./architecture.md)：接管点与连接模型的现状
- [development.md](./development.md)：套件、环境变量与发布流程
- [upstream-workarounds.md](./upstream-workarounds.md)、[upstream-workaround-pattern.md](./upstream-workaround-pattern.md)：补丁登记与退役方法
- [troubleshooting.md](./troubleshooting.md)：用户侧的症状与判据
