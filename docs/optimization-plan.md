# 优化计划

> 定位：本页是 2026-10-01 安全扫描与代码审视后的修复 / 优化实施计划——按阶段列出改动点、做法、验收与顺序，供逐项执行与勾选；完成一项把 `[ ]` 改为 `[x]`。
>
> 状态（2026-10-01）：Phase 1 / 2 / 3 与 4.1 已实施——只留源码改动，改动文件均已 `node --check` 语法自检，未打包（打包需另行批准）；4.2 前置机制核对完成、按建议留待单独一轮。

## 概述

- **来源**：2026-10-01 全项目安全扫描（结论 0 高危 / 4 中危 / 2 低危）+ 代码级优化审视（7 条）。
- **范围**：安全修复与工程优化。功能性新点子（交互式终端、known_hosts 管理 UI 之外的新能力等）见 [roadmap.md](./roadmap.md)，不在本计划。
- **约束**：按项目现行交付口径——每阶段只留源码改动，不跑测试、不打包（打包需单独批准）；每个改动文件用 `node --check` 语法自检；不动已屏蔽的端口转发链路（`forward.js` 及其注释块）。
- **文档同步**：随各阶段改动同步对应专题页（见文末「文档同步」节）。

## Phase 1 — 安全修复（优先级最高）

### [x] 1.1 store 文件权限收紧（中危）

- 位置：`lib/store.js:262-274`（save）。
- 做法：`writeFileSync` 加 `{ mode: 0o600 }`（staging tmp 与正式文件都要）；`mkdirSync` 加 `{ mode: 0o700, recursive: true }`；已存在的旧文件补一次 `chmodSync(0o600)`（best-effort，try/catch 包裹——win32 上 mode 语义有限，不能因此报错阻断）。
- 顺带：tmp 文件名从可预测的 `*.tmp-<pid>` 改为 `crypto.randomBytes(6).toString('hex')` 后缀。
- 验收：POSIX 上新建 `$DSH_HOME/dsh-ssh.json` 权限为 `-rw-------`；Windows 行为不变。

### [x] 1.2 symlink 围栏绕过（中危）

- 位置：`lib/fs-shim.js:384`（putRemoteBytes / copyFile 落远端直写）、`lib/fs-shim.js:528,540`（rm / rm -rf）；`lib/remote-fs.js` 新增校验助手。
- 背景：写入围栏（`lib/protocol.js:113-118`、`lib/remote-fs.js:675-697`）为纯词法前缀判断，无远端 `realpath`——`..` / 大小写 / 编码已被 `normalizeRemotePath` 正确折叠，无绕过；但**中间目录或末级为符号链接**时词法判断与真实落点不一致。
- 做法：新增 `assertFencedRealpath(sftp, alias, remotePath, roots)`——写 / 删前对**目标父目录**做 `sftp.realpath`，结果必须仍在围栏内（词法前缀保留作快路径，realpath 作最终裁决）；realpath 失败按 `FS_NOT_FOUND` 语义处理。
- 边界：只对「写、删」加，读不加（读取本就不受围栏限制）；staging + rename 的 `#publish` 路径已天然免疫末级 symlink，只覆盖 copyFile 直写与 rm 两处。
- 验收：围栏内指向 `/etc/passwd` 的 symlink 文件被 copyFile 覆盖时返回 `FS_SANDBOX_DENIED`；中间目录为 symlink 的 rm 被拒绝。
- 实施注记（2026-10-01，相对计划的扩展）：除计划点名的 copyFile 直写与 rm 两处外，**原子替换（`#publish`）也接入了 `assertFencedRealpath`**——staging 文件与 rename 目标同在目标父目录内，若该父目录是（或途经）指向围栏外的符号链接，词法放行而真实落点越界，故一并做 realpath 裁决；如判断为过度收紧，删掉 `#publish` 内的这次调用即可回退（一处调用，无其他依赖）。

### [x] 1.3 路由 Host 头校验（中危；CSRF 为可选第二层）

- 位置：`lib/routes.js:34-37`（回环判定处）。
- 背景：现仅校验 `remoteAddress` 回环，无 Host 头校验、无鉴权、无 CSRF token——DNS rebinding 可从浏览器发起，枚举主机清单（含 user/keyPath）、改存已存主机的 host/port、`ls` 读远端目录、mount/unmount。
- 做法（第一层，低风险）：请求 Host 头必须 ∈ `{localhost:<port>, 127.0.0.1:<port>, [::1]:<port>}`，否则 403——单点改动即可堵死 rebinding 主路径。
- （可选第二层）CSRF token：插件启动生成随机 token，下发自家 client.js，写操作（hosts/save、hosts/delete、test、mount、unmount）要求带头校验；改动面涉及 client.js 全部 fetch 调用点，与第一层分开交付。
- 验收：伪造 `Host: evil.com` 的回环请求返回 403；面板全部功能不受影响。

### [x] 1.4 SSH 主机密钥 TOFU（中危，本阶段最大改动）

- 位置：`lib/engine.js:115-147`（connectConfig）、`lib/store.js`（新增存储段）。
- 背景：ssh2 配置未设 `hostVerifier` / `hostHash`，任何主机密钥都被接受 → 中间人可截获会话；password 认证可直接窃取密码。
- 做法：
  - ssh2 配 `hostVerifier`，对主机密钥算 SHA256 指纹；
  - 首次连接记录 `{alias, host, keyType, fingerprint}` 进 `dsh-ssh.json` 新段 `knownHosts`（沿用 1.1 的 0600 写入），放行（TOFU）；
  - 后续指纹匹配放行；**不匹配拒连**，错误信息含新旧指纹；
  - 面板主机卡片加「忘记主机密钥」次级按钮（`lib/routes.js` 加一条路由 + `lib/client.js` HostCard 一个按钮），主机重装系统后用户自助解锁。
- 已知取舍：升级后首连静默记录、无交互确认弹窗（在面板流程插确认对话框成本高，一期不做）；在错误信息与 `docs/hosts.md` 写清楚。
- 验收：手工改 knownHosts 记录后重连被拒且提示指纹差异；「忘记主机密钥」后可重连并重新记录。

### [x] 1.5 低危两项（顺手）

- `lib/fs-shim.js:436`：scratch 镜像写入 `fenced:false` 处加注释标注信任边界（纯注释）。
- 供应链一致性：`lib/patch-shell.js`、`lib/patch-subprocess.js`、`lib/forward.js`、`docs/roadmap.md` 处于 git 未跟踪状态但已打进 0.1.21 tarball——**提交入库需单独批准**，本计划只列清单。

## Phase 2 — 正确性与健壮性（bug 级）

### [x] 2.1 exec 输出 UTF-8 跨块乱码

- 位置：`lib/engine.js:390-401`（appendCapped）。
- 问题：每个 data chunk 独立 `chunk.toString('utf8')`，多字节字符跨 chunk 边界时变成两个替换符（乱码）；字节上限混用 `text.length`（UTF-16 码元）与 `chunk.length`（字节），上限不精确。
- 做法：每个 stream 配一个 `string_decoder.StringDecoder('utf8')`，`decoder.write(chunk)` 替代逐 chunk toString；截断上限统一按字节记账，截断点回退到完整字符边界。
- 同类排查：`lib/patch-shell.js` 的输出尾窗若同样逐 chunk toString，一并修（实现时确认）。
- 验收：中文 / emoji 输出的远端命令跨 chunk 边界不再出现 `�`。

### [x] 2.2 exec 断线重试

- 位置：`lib/engine.js:293`（exec）。
- 背景：`withSftp` 有 broken 后重连一次的机制，`exec` 没有——长命令期间连接死掉就直接失败。
- 做法：对齐 `withSftp` 语义——命令**尚未产生任何输出且** `record.broken` 时重连重试一次；已开始输出的命令不重试（避免副作用命令重放），直接结算为连接丢失错误。
- 验收：连接空闲被服务端踢掉后，首个 exec 自愈；有输出的命令不重放。

## Phase 3 — 性能

### [x] 3.1 SFTP 元数据短 TTL 缓存

- 位置：`lib/remote-fs.js`。
- 背景：文件树展开、预览、轮询 watch 每次都真实打 SFTP roundtrip；`remote-fs.js` 无任何元数据缓存。
- 做法：`stat` / `readdir` 结果按 `(alias, path)` 缓存，TTL 1.5s（略小于 watch 轮询周期 2s，避免轮询自己吃缓存导致失效感知变慢）；本插件自身的写 / 删操作与 watch 检测到变更时主动失效对应 path 及其父目录；mount / unmount 时清空该 alias 全部缓存。
- 边界：缓存只服务读路径（文件树、预览、`@` 索引）；写入围栏校验（1.2）永不走缓存。
- 验收：连续展开同一目录第二次无 SFTP roundtrip；写入后文件树立即可见新文件。

### [x] 3.2 watch 自适应轮询

- 位置：`lib/remote-fs.js`（startRemoteWatch）。
- 做法：有变更时保持 2s；连续 N 轮（如 15 轮 = 30s）无变更退避至 5s、上限 10s；检测到变更立即回到 2s。与 3.1 联动：退避周期即缓存 TTL 上限。
- 验收：空闲目录轮询频率下降；改动后仍约 2s 内感知。

## Phase 4 — 工程化（独立、可做可不做）

### [x] 4.1 package.json 元数据

- 补 `repository` / `homepage` / `bugs`（均指向 `github.com/siqyka/dsh-ssh-workspace`）；`files` 白名单不必显式加 `README.en.md`（npm 自动收录 README 变体，0.1.18 已验证）。

### [ ] 4.2 client.js 拆分（纯移动，零行为变化）

- 位置：`lib/client.js`（2190 行）→ 拆出 `lib/client/` 子目录：`marks.js`（Remote-workspace marks DOM 装饰）、`composer-bridge.js`（拖拽 / 右键进任务）、`panel.js` + `dialogs.js`（远程工作区面板、主机编辑、添加工作区对话框）、`styles.js`（集中 CSS 字符串）；`client.js` 保留 apply 接线与 locale。
- 风险：`package.json` 的 `exports['./client']` 指向不变（仍是 `lib/client.js`）；DSH client inject 机制对多文件 ESM 的加载方式需实现前用 `ref/` 树确认一次。
- 建议：放最后做、单独一轮交付（改动面大、纯重构无功能收益；近期若要打包验证功能可跳过）。
- **核对结论（2026-10-01，`ref/dsh/node_modules/@deepseek-ai/dsh-client-modules` 0.2.0-rc.2）**：多文件拆分在机制上可行，但形态受限——
  - 浏览器半边的同步 `require(spec)` 只解析 seed / loadCache / factories（按**包 id**）；相对路径文件**只能**经 `require.async('./client.<name>.js')` 异步加载（内部 `importChunk`），chunk 文件名须匹配 `client.*.js` 命名；
  - chunk 须自我注册 `window.__ModuleLoader__.load({ id: ownerId, chunk: fileName, factory })`；host 半边按需服务包目录下存在的任意 `client.*.js`（`text/javascript` + immutable cache）；
  - 即拆分后的形态是「入口 `client.js`（同步注册）+ 子模块 chunk（异步加载）」，子模块的材质化时机从同步变为异步——不是纯移动式的多文件 ESM；`exports['./client']` 指向不受影响。
- **本轮决定：不实施**（与「近期若要打包验证功能可跳过」一致）——当前先交付 1.x–3.x 的零功能变化改动；拆分留待单独一轮，按上述「入口 + chunk」模式落地。

## Phase 5 — 复查补充轮（2026-10-01，纯源码改动，未打包）

### [x] 5.1 POST 路由 Content-Type 校验（安全）

- 背景：Host 头校验挡住 DNS rebinding，但挡不住**无 JS 的跨站表单**——HTML 表单可向回环地址 POST `text/plain` 并伪造出合法 JSON 体，配合 `hosts/forget-key` → `hosts/save` 可把主机改指到攻击者（下次连接指纹 TOFU 记录、密码认证被中间人截取）。
- 做法：`lib/routes.js` 的守卫要求 POST 必须带 `content-type: application/json`（取分号前主类型比对），否则 415；浏览器半边 9 处 POST 均已带该头，零客户端改动。
- 验收：`curl` 表单形态 POST 得到 415；插件自身路径不受影响。

### [x] 5.2 冒烟测试脱敏入库 + 锁文件 + 最小 CI

- `tests/`（7 套件 + `run.mjs` 运行器）：原本地开发脚本（`plugin-boot-test.mjs` / `test-live.mjs` / `verify-plugin.mjs` / `tools/*`）并入仓库，且**全部脱敏**——不内置任何真实主机 / IP / 端口 / 用户名 / 本机路径：主机与目录改由 `DSH_WS_TEST_ALIAS` / `DSH_WS_TEST_DIR` 环境变量提供，DSH 依赖树由 `DSH_CORE_ROOT` 指向；未设置即 SKIP 并以 0 退出，裸检出只跑纯套件（CI 形态）。
- `package-lock.json`（仅 ssh2 运行时树，9 包；`npm audit` 0 漏洞）+ `.npmrc`（`legacy-peer-deps=true`，peer 由宿主提供）；`.github/workflows/ci.yml`（npm ci → node --check → tests/run.mjs → npm pack --dry-run）。
- 原本地脚本保留在 .gitignore 中（不入库），`tests/` 为脱敏后的正式版本。

### [x] 5.3 mirrorAliases 生命周期清理

- `patch-subprocess.js` 新增 `forgetMirrorAlias`：`rm` 移除 scratch 根（恰好一段）时删除学习到的别名映射，注册表不再随快照轮次增长；子路径删除不误删映射。`fs-shim.js` 的 `rmRemote` 在本地删除成功后调用。

### [x] 5.4 流式读取第二 SFTP 通道

- `engine.streamChannel(record)` 按需打开第二条 SFTP 通道，`streamText` 在其上传输：大文件读取期间统计 / 列表 / 变更监视不排队；开不出通道时退化为共用常开通道（流式能力不降级），`close` 事件自清理，`closeRecord` 一并关闭。

### [x] 5.5 连接参数可配

- `SshWorkspaceEngine` 构造接受 `idleTimeoutMs` / `connectTimeoutMs` / `keepaliveIntervalMs` / `sweepIntervalMs` 覆盖（非法值回落默认）；`lib/index.js` 把插件配置的 `engine` 段透传。README 配置表与 [architecture.md](./architecture.md) 已同步。

### [x] 5.6 文档同步

- README / README.en.md（配置表加 `engine.*` 四行）、architecture.md（第二通道、`engine.*` 表格、POST Content-Type）、development.md（「冒烟测试与 CI」节）。

## 实施顺序与依赖

```
Phase 1: 1.1 → 1.2 → 1.3(第一层) → 1.4 → 1.5      （1.4 依赖 1.1 的存储改动）
Phase 2: 2.1、2.2 互相独立，可并行
Phase 3: 3.1 → 3.2                                （3.2 依赖 3.1 的失效机制）
Phase 4: 4.1 随时；4.2 独立压轴
```

- 交付切分建议：Phase 1+2 可合并为一轮（都是小改动）；每轮完成后经用户批准再走打包流程（参考 [development.md](./development.md) 的 npm pack → file: → pnpm install → 重启）。
- 实施记录（2026-10-01）：Phase 1 → Phase 3 与 4.1 已同轮落地（纯源码改动，未打包，待批准后升版本打包）；文档同步已完成；4.2 见其条目的结论注记。
- 实施记录（2026-10-01，复查补充轮）：Phase 5 全部落地（5.1 安全、5.2 测试/锁文件/CI、5.3–5.5 引擎与桥接优化），4.2 经此前核对决定仍留待单独一轮；同为纯源码改动，未打包。
- 文档同步：1.4 → [hosts.md](./hosts.md)（knownHosts 段）与 [troubleshooting.md](./troubleshooting.md)（指纹不匹配错误条目）；1.2 / 1.3 → [architecture.md](./architecture.md)（围栏与路由节）；2.x / 3.x → architecture.md（引擎输出、变更监视节）。

## 相关

- [根 README](../README.md)（能力与限制口径）
- [architecture.md](./architecture.md)（`ctx.fs` 接管、围栏、引擎与连接模型）
- [hosts.md](./hosts.md)（主机存储与凭据策略）
- [roadmap.md](./roadmap.md)（功能性候选）
- [development.md](./development.md)（打包与发布流程）
