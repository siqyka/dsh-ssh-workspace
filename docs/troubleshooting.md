# 排查与常见问题

> 定位：出错时先看这里。

## 常见错误语义

文件工具在远端工作区报错时，错误码来自 `FsError`，与本地后端的语义对齐（`lib/remote-fs.js`）：

| 错误码 | 含义 | 常见触发 |
| --- | --- | --- |
| `FS_OUTSIDE_WORKSPACE` | 写入越出已挂载的远端工作区 | 目标路径既不在任何已挂载根之下、也不在该主机 `/tmp` 之下——例如向未挂载的 `ssh://` 路径写文件；先 `ssh_workspace_mount`。写入 / 删除前还会对目标父目录做一次服务器 `realpath` 裁决，**经符号链接的真实落点越界同样被拒**。`ssh_workspace_transfer` 的上传与浏览器面板的上传走同一对判定，且在发出任何字节之前判定 |
| `FS_SANDBOX_DENIED` | 本机沙箱模式不允许写入 | 会话处于 **`read-only`** 时对远端文件 write / edit。远端目标不会经过本机的 `SandboxedFileSystem.checkedTarget`，所以这条判定由插件自己补上，文案与本地一致。`workspace-write` 要求目标在**会话自己的**工作区之内（远端会话的 root 就是那个 `ssh://` 拼写，可直接比较）或该主机的 `/tmp` 之下；两者之外的目标同样返回此码，文案会点名会话工作区。**三个被认可的模式之外的任意模式字符串**（未来新增的名字、fold 损坏出的值）也返回此码，与本地一致——本地对读不懂的模式一律拒；那时的文案会列出被认可的三个模式，**不会**谎称这是你选的「仅可查看」。**策略解析失败同样返回此码**，但那时的文案会说明是接线问题而非你选的模式——切换模式不会有用 |
| `FS_NOT_FOUND` | 远端目标不存在 | 路径拼写错误、目录已被删除；也用于"不是合法远端路径"的输入 |
| `FS_PERMISSION_DENIED` | 远端账号权限不足 | SFTP 返回 Permission denied；挂载前可先用面板「测试连接」+ 目录浏览确认可写。**工作区被停用时也返回此码**，文案带 `the remote workspace is detached` |
| `FS_STALE_VERSION` / `FS_NOT_OBSERVED` | 并发修改 / 未读先写 | 读过后文件被改动再写回；或直接覆盖一个从未读过的既有文件（先 read 再 write） |
| `FS_AMBIGUOUS_EDIT` / `FS_EDIT_NOT_FOUND` | `edit` 的 `old_string` 匹配不唯一 / 未命中 | 提供更精确的 `old_string` 或 `replace_all: true`；未命中时先重新 read 确认内容 |
| `FS_NOT_TEXT` | 二进制或非法 UTF-8 | 读 / 编辑二进制文件被拒；改用 `ssh_workspace_exec` 配合远端命令处理 |
| `FS_TOO_LARGE` | 超过读取上限 | 文件过大，用远端命令查看而非整读 |
| `FS_NOT_REGULAR_FILE` / `FS_NOT_DIRECTORY` | 目标类型不符 | 对目录 read、对文件 listDir 等 |
| `FS_ABORTED` | 操作被中止 | 调用方 signal 被 abort（用户取消、超时、会话关闭）；不是故障，重试即可 |
| `FS_IO_ERROR` | 其它 SFTP 失败 | SFTP 服务端报错、连接中断等 |

### 执行命令报 `windows-acl … workspace and temp directory resolution failed`

在远端工作区里**一执行命令就失败**，且文案是这一句：

```
sandbox-local: windows-acl workspace and temp directory resolution failed: Error: ENOENT:
no such file or directory, realpath 'C:\Users\…\ssh:\qiyk\home\qiyk\test\dsh-ssh-workspace'.
The command did not run; check that the current user can change permissions on the workspace and
temp directories, or run with danger-full-access.
```

看那个 `realpath '…\ssh:\…'`——被解析的是一个 `ssh://` 拼写，而它**不是本机路径**。
Windows 把它当驱动器相对路径拼到进程 cwd 上，自然 ENOENT。这不是 ACL 权限问题
（那会是 `EPERM` / Access denied），所以去改目录权限或提权都不会有用。

原因在宿主的命令通路上：`ctx.sandboxPolicy.resolve()` 对远端会话原样返回
`session.header.cwd` 的 `ssh://` 拼写，而 `ctx.sandbox.confine()` 在本插件接管
`ctx.subprocess` / `ctx.shell` **之前**就跑了，把那个拼写当主机路径 realpath。

**0.3.5 起由 `lib/patch-sandbox.js` 修掉**：交接给沙箱提供方之前，把 policy 里的
远端根换成一个真实存在的本机替身目录，其余字段（模式、会话 id）原样带过。
如果你在更新的宿主上仍然看到这句话，说明插件的这个补丁没装上——查
`ssh_workspace_status` 与启动日志里有没有
`ssh-workspace: took over ctx.sandbox.confine`。

临时绕过：把会话切到 `danger-full-access`（该模式下 `confine()` 直接返回原 argv，
不碰 realpath），或改用 `ssh_workspace_exec`（它不经过本机沙箱）。

### 一整个工作区都在报错？先看它是不是被停用了

`ssh_workspace_unmount`（以及面板里的卸载）默认是 **`detach` 模式**：工作区记录和会话都保留，
但该路径下的**一切**操作都会被拒绝——读写、列目录、变更监视、执行命令、开终端、glob / grep / git、传输，
无一例外。这是停用造成的，**不是远端文件不存在**。

判据是错误文案里带 `the remote workspace is detached`：

```
cannot access "ssh://myserver/home/user/project/src/app.ts": the remote workspace is detached
(re-enable it in the panel or with ssh_workspace_enable)
```

恢复方式：面板点该行的「启用」，或调 `ssh_workspace_enable`（默认同时把归档的会话恢复出来）。
只有 SSH 连接本身（`test`、目录浏览、端口转发）不受停用影响——这也是为什么「测试连接」还能成功却什么都读写不了：
连接活着，围栏关着。代码是 `FS_PERMISSION_DENIED`（不是 `FS_SANDBOX_DENIED`）：停用不是沙箱策略，
升权也解不开一个被关掉的工作区。

### 「仅可查看」真的会挡住写入——包括远端

会话切到 `read-only` 后，远端 write / edit 会以 `[sandbox: file access denied under read-only mode]`
被拒。这一点是**插件自己补上的**：本机沙箱只在 `ctx.fs` 的本地实现里生效，远端目标走的是插件的
SFTP 分支，从来不会经过它。

**同样被拒的还有命令执行**：`ssh_workspace_exec`、`ssh_workspace_shell`，以及 workdir 落在远端的
`bash` / `pwsh`。它们返回的不是 `[sandbox: …]` 标记，而是一句自述原因的文案——因为这里根本没有沙箱
可以围栏（本机内核边界跨不过 SSH），插件能做的是拒绝。文案里会写明「切到 workspace-write 或
danger-full-access」。读（`read` / `glob` / `grep`）不受影响。

> 这条曾经是真实缺口：`read-only` 会话跑 `ssh_workspace_exec { command: "rm …" }` 拿到 `[exit code: 0]`。
> 修的是「命令执行面从不看模式」，不是某一条命令的特判。

判据是错误码与文案：

| 你看到的 | 真实原因 | 怎么办 |
| --- | --- | --- |
| `[sandbox: … under read-only mode]` | 会话模式是仅可查看 | 切到 `workspace-write` / `danger-full-access`，或对单次调用升权 |
| `cannot run a remote command …: the session sandbox mode is "read-only"` | 同上，但目标是命令而非文件 | 切换会话模式；升级对这条不起作用，插件工具没有 `sandbox_permissions` 字段 |
| `FS_OUTSIDE_WORKSPACE` + `outside every mounted remote workspace` | 目标不在任何已挂载根下（也不在该主机 `/tmp` 下） | 先 `ssh_workspace_mount`；**升权没有用**，模式再宽也不会让目录变成已挂载 |
| `FS_PERMISSION_DENIED` + `the remote workspace is detached` | 工作区被停用 | 面板「启用」或 `ssh_workspace_enable` |

> 这三种失败过去都返回 `FS_SANDBOX_DENIED`，而宿主的工具层会把该码改写成
> `[sandbox: file access denied under <mode> mode]` 加一句「可升权重试」。于是围栏外写文件会得到
> 「在 danger-full-access 下被拒」这种自相矛盾的提示，模型接下来会去申请一个对「没挂载」毫无作用的升级。
> 拆成独立的码，是为了让这几句真话能原样到达模型眼前。

## 打开远端会话报「历史加载失败」

界面上出现：

```
历史加载失败：failed to project session "session-…": [ { "code": "custom", "path": [], "message": "Invalid input" } ]（gateway/internal）
```

**这不是会话损坏，也不用删缓存。** 它只发生在 `cwd` 是 `ssh://…` 的会话上，本地路径的会话不受影响。

原因在宿主的 `@deepseek-ai/dsh-working-directory`：它把会话目录注册成一个投影单元，schema 写成

```js
const directorySchema = z.string().min(1).refine(isAbsolute).nullable()
```

`refine(isAbsolute)` 传给 zod 的是**函数值**——模块 `import { isAbsolute } from "node:path"` 在服务构造那一刻持有的那个函数。插件随后替换 `node:path.isAbsolute` 并调用 `syncBuiltinESMExports()`，那只能让**读取绑定**的调用方（会话头校验、`fs-local` 等）看到补丁；已经被当作值捕获的 schema 仍在调用原始 `isAbsolute`，对 `ssh://host/path` 返回 `false`，于是校验失败。

插件的加载顺序永远晚于 `working-directory`（它在 roster 里排在前面），也**不应该**去改部署自带的 bundle，所以修复放在插件侧：`lib/patch-projection.js` 把该单元已注册的 `stateSchema` / `wire.viewSchema` 换成一个惰性判定（`ssh://` 直接放行，其余仍走原 schema）。这条判定覆盖了 `restore` / `viewCheckpoint` / `snapshot` / `cachedSnapshot` / `hydrate` 与变更推送全部读路径。

放宽的范围只有 `ssh://` 这一个形态：相对路径、空字符串照旧被拒，`null` 照旧通过，其它投影单元完全不动。

如果你在**没有**装这个插件（或插件未激活）的部署上看到这条报错，那说明该会话确实带着一个宿主无法解释的 `cwd`——此时才是真的需要修数据。

这条修复是**上游临时补丁**，登记为 `UPSTREAM-1-working-directory-isAbsolute`：DSH 把
`refine(isAbsolute)` 改成 `refine((value) => isAbsolute(value))` 之后它就不再需要，届时本插件
会在启动日志里打一行 `… is no longer needed …`，并停止打补丁。机制与删除步骤见
[upstream-workarounds.md](./upstream-workarounds.md)。

## ssh:// 会话里附件读不到（ENOENT）

在远端工作区会话里让模型读聊天框上传的非图片附件，得到类似：

```
cannot read "ssh://myserver/Users/me/.dsh/attachments/v1/files/…": not found
```

路径被拼成了 `ssh://<alias>/<本机绝对路径>`，说明它被当成远端路径去 SFTP 查了。聊天附件
实际存放在运行 DSH 的本机 `$DSH_HOME/attachments`；在 `ssh://` 会话里需要**本机路径直通**。

默认已经放行 `$DSH_HOME/attachments` 与 `$DSH_HOME/plugins`。检查三件事：

1. 路径是否确实以本机 `$DSH_HOME` 开头（Windows 上是 `C:\Users\…\.dsh\…`；不要把它写成
   `/Users/…` 除非那真是本机路径）。
2. 如果配置过 `localPassthrough`，确认前缀没有写成相对路径、`ssh://` 拼写或未知变量；
   `false` / `[]` 会关闭直通。改完需要重启 DSH。
3. `$DSH_HOME` 本身不会被接受（避免暴露 `dsh-ssh.json` 与 SSH 密钥）；请用它的子目录。

直通是词法匹配，不会因为本机存在同名文件而自动放行未配置的路径；也不 `realpath`，符号链接
逃逸不在这条修复范围内。远端文件仍按远端路径读取，不受影响。

**用 `@` 引用的本机盘符路径**：`@F:\123.txt` 这类拼写不是 attachments 副本，宿主只把它当
**路径文本**插进提示词。插件从 `user/message` 事件里恢复这些引用，只接受 Windows 盘符 / UNC，
并且整个 `$DSH_HOME` 即使被点名也拒绝。若仍报 not found：

- 确认拼写确实是盘符或 UNC（`F:\x`、`\\server\share\x`）；`@/tmp/x` 与 `@src/a.js` 按设计
  仍是远端 / 工作区路径。
- 确认消息是在**插件激活之后**发出的（热重载会重新扫一次历史，但一条从未进过事件的文本
  无从恢复）。
- 引用表上限 256 条且先进先出；一个会话里点名过大量互不相关的本机文件后，最早的会被挤掉。

**Windows 主机上 `@/home/me/x.md` 读不到**：这类拼写从一开始就没进引用表——`@` 引用只收
**该主机上**有本机含义的拼写（Windows 上收盘符与 UNC，POSIX 上收 POSIX 绝对路径，见
「`@` 引用的规则」），所以它始终按远端解释，面板里的回退开关对它也不生效：回退只服务
**被收进引用表**的拼写，而这条从未进表。这不是回退失效，是引用表按平台收窄的结果。
想在 Windows 上读本机文件，写盘符（`@F:\x`）、UNC（`@\\server\share\x`），或加 `local:`
前缀——但前缀剥掉后仍必须是本机绝对路径，`local:/home/me/x.md` 在 Windows 上同样找不到。

**POSIX 主机上 `@/Volumes/SSD/x.md` 读不到**：这类拼写两边都合法，所以默认按**远端**解释，
报的多半是 `ssh://<alias>/Volumes/SSD/x.md` 不存在。两种修法：

- 显式点名本机：写成 `local:/Volumes/SSD/x.md`（前缀名是面板「文件引用设置」一区 →「显式文件引用
  scheme」里的「本机路径前缀」，默认 `local`）。路径部分就是去掉前缀后的绝对路径；前缀大小写不敏感，
  0–3 个 `/` 都收。
- 或者勾上面板同一区里的「远端不存在时回退本机同名文件」：这样 `@/Volumes/SSD/x.md` 仍**先**按远端
  解析，只有远端确实报不存在时才试一次本机，回退来的内容末尾会带一行
  `[ssh-workspace] 注意：远端不存在 …`。开关默认关闭。

排查时注意：**未启用的前缀会被明确拒绝**，报 `FS_PERMISSION_DENIED`（文案提示把它加进
`localPassthrough` 或用 `@` 点过名），而不是悄悄按远端去找——看到这个错误说明拼写对、授权不对。
回退只覆盖读（`read` / `read_image` / `streamText` / `lstat`）；写、`glob`、`grep` 与列目录
永远只走远端，所以「搜索找不到本机文件」是预期行为，不是回退失效。

**两种 not found 文案要分清**（同是 `FS_NOT_FOUND`，下一步动作完全不同）：

- 「…the host copy "<path>" is missing as well…」——回退**试过**了，两边都没有。再试本机毫无
  意义；只有显式 `${scheme}:<绝对路径>` 才能钉住一次本机读。
- 「…this path was read on the remote host only…」——回退**没资格**试（开关没开，或这条拼写
  根本没进引用表）。文案会给出 scheme 写法；POSIX 主机上还会多一句「或者勾上面板的回退开关」，
  **Windows 主机上没有这句**，因为裸 POSIX 拼写在 Windows 上永远进不了表，建议它等于骗人。

一个容易被当成 bug 的细节：**装饰过的 not found 多半到不了模型眼前**。宿主 `read` 工具先
`resolve` 再 `stat`，`stat` 一返回 undefined 就抛它自己的
`cannot read "<displayPath>": not found`——插件的文案只在这条 stat 之后的读（大文件
`streamText`、`read_image` 的 `readBytes`、预览的 `readText`）与插件的 `lstat` 上可见。
所以「报错里没有那句提示」不代表插件没做判断。

## 直通了，为什么还是读不到

读到 `EXECUTOR_UNAVAILABLE` 时最容易误判的一条：**直通有边界，而且边界不在本插件手里**。

直通只在 `ctx.fs` 这一层接管路径——宿主官方 `read` / `write` / `edit` / `read_image`
以及 `node:fs` 都经过它。任何**不经过 `ctx.fs`** 的读取都碰不到直通，这不是直通失效，
也不是授权拒绝。实测（`ssh://` 会话 + `@F:\123.txt`）：

| 入口 | 结果 |
| --- | --- |
| `ctx.fs.resolve` → `readText` | 落到本机后端，读到 `"test\n"` |
| `ctx.fs` 的 `stat` / `readBytes` / `streamText` / `listDir` / `contains` | 全部落到本机后端 |
| dsh-ops 的 `inspect_local_file` / `read_files` / `glob` / `grep` | `EXECUTOR_UNAVAILABLE: … only git and ripgrep (rg) are supported over the remote subprocess bridge` |
| 带 `workdir` 的 `ops_bash` | `invalid workdir: must be an existing directory` |

**为什么**：dsh-ops 把会话 cwd 原样交给本机的 `dsh-ops-worker.exe`（`lib/execution/files.js`
的 `exchange(subprocess, { argv, cwd, … })`），而 `lib/patch-subprocess.js:223`
的远端桥只放行 `git` 与 `rg`。worker 是本地 Windows 可执行文件，它的
`Path::new(root).is_absolute()` + `canonicalize` 也消化不了 `ssh://` 拼写——**这不是拼写
问题，是「本地进程 + 远端根」的结构性错配**，且它不走 `ctx.fs`，所以直通管不到。

**所以：**

- 换入口，不要重试同一个工具。读远端用 `ssh_workspace_exec` / `ssh_workspace_shell`；
  读本机文件用 `ssh_workspace_transfer` 上传到该主机的 `/tmp` 再读（走 SFTP，本机侧读
  文件不受会话 cwd 限制；落点必须在该主机已挂载根或 `/tmp` 下）。
- 不要用另一个本机 shell 去绕（`ops_bash` 没有可用 cwd，`working_directory` 也切不到本机）。
- 这不影响远端侧的 `read` / `glob` / `grep`：它们在 ssh 会话里本来就该走远端。

### 我配的 `file:` 突然不生效了

上一版允许 `file` / `sftp` / `dsh-app` 以及 1–2 个字符的名字作为本机前缀，这一版全部拒绝：
`file:///` 正是本插件为**远端**路径写出的 URI，`c:` 会和 Windows 盘符抢同一段文本。
**存量的旧值不会被悄悄丢掉，也不会被悄悄改写**：读回时降级到默认前缀，但面板「文件引用设置」
一区顶部会出现一行

> 已保存的前缀 `file` 现在不可用（…），当前生效的是 `local`；请重新保存以确认。

这行来自 `/status` 的 `passthrough.schemeWarning`（`{stored, effective, code, message}`），
同时日志里有一条 `warn`。在输入框里重新保存一个合法的名字（至少 3 个字符）即完成迁移——
只有重新保存才写穿 `dsh-ssh.json`。**注意换名字之后**，之前写下的旧前缀拼写
（例如 `file:/x`）既不是本机也不是远端工作区路径，会按远端相对路径解释，需要一起改。

### macOS 上 `@` 点了却读不到本机同名文件

症状：文件确实在本机，`@` 也点了名，回退开关也打开，但读取仍在远端，或报本机回退没有尝试。
原因是**大小写**：macOS 的 APFS 默认大小写不敏感，但插件在 darwin 上**不折叠**路径大小写——
`@/Volumes/SSD/x.md` 被点名，模型写 `/volumes/ssd/x.md` 时两者不是同一个引用，回退闸门判
false。这是已决定保留的取舍（折叠会让大小写敏感的 APFS 卷上出现误放行），失败方向是
fail closed。**自救**：用显式前缀拼出真实大小写，`local:/Volumes/SSD/x.md`；或者把 `@` 点名的
拼写改成与文件一致的大小写。见 [features.md](./features.md) 的「本机路径直通」。

## 变更请求面板在远端工作区报 `cannot run "…DeepSeek Harness.exe" with a remote cwd`

**现象**：远端会话里打开官方的「变更请求」（·Forge）标签页，下半部「最近提交历史」空白或只停在旧数据，上半部「本地变更」空白，
工具结果里出现这句拒绝。这不是你输入的命令问题，也不是远端少了 git。

**根因**：Forge 面板的每一次测量都是 `runGit()` ——它先把命令交给
`ctx.sandbox.confine()`，再用 `ctx.subprocess.spawn()` 启动。`workspace-write` / `read-only`
下封闭性的 Windows 实现把 argv 包成
`[<runner.js> …, '--', git, …]`，而前缀是 `windowsAclRunnerInvocation()` 给出的
`process.execPath`——打包版里就是 `DeepSeek Harness.exe`，**不是 `node`**。远端桥的
`unwrapSandboxArgv` 以前只认 `node*` / POSIX launcher，于是这条命令没被剥掉包装、
直接碍在白名单上（白名单只开放 `git` / `rg`，而 `argv[0]` 是桌面应用）。

**修复**：`lib/patch-subprocess.js` 的前缀识别多了第三种真实形状——与本进程
`process.execPath` **同名同身份**的打包可执行文件（另加 `electron` / `electron.exe` 用于未打包
的 Electron 开发版）。识别的边界不变：**必须在 `--` 之前看到沙箱命名空间**才当包装。
因此用户自己的 `git -- status`、`node script.js -- git …` 不会被误剥，名字取巧的
其他 `.exe` 也不能参与这个角色。

**仍会被拒**：真正不支持的命令（bash / 非 git、rg 的可执行文件）照旧同步拒绝；PTC
worker 的 `[<本机可执行文件>, <bootstrap>]` 前面没有沙箱命名空间，照旧不被剥、走下一节的
`resolve` 修复。

> 服务端改动（`lib/`），**必须重启 DSH**；刷新页面不会加载新的桥代码。重启后回到工作区，
「变更请求」面板应当恢复。

## `run_code` / PTC 报 `cannot run "…DeepSeek Harness.exe" with a remote cwd`

`ops-ptc` 这类「程序化工具调用」预设不直接调用工具，而是让模型写一段 TypeScript 交给宿主的
Node worker 执行。worker 是**本机进程**（打包版里它就是 `DeepSeek Harness.exe` 自己），而提供方
把它的 cwd 默认成会话的 `ssh://` 工作区根，于是卡在两处：

1. `ctx.subprocess.spawn` 的远端桥按白名单只放行 `git` / `rg`，宿主可执行文件被拒绝——工具结果
   里看到的就是这句 `cannot run "…DeepSeek Harness.exe" with a remote cwd`；
2. **即便放行也跑不成**：每次求值宿主都会把 `spec.cwd` 经控制通道发给子进程并
   `process.chdir(cwd)`；Windows 把 `ssh://qiyk/…` 当相对路径（`<cwd>\ssh:\qiyk\…`），而文件名
   里不允许 `:`，程序会以 chdir 的 ENOENT 结束。

修复点是 `ctx.ptcRuntime.resolve()` 返回的 `spec.cwd`：`lib/patch-ptc.js` 把它换成本机替身目录
（与沙箱那层是同一个替身根），spawn 与每次求值前的 chdir 一起修好。程序里**调用的工具仍
在远端执行**——工具拿的是会话的远端目录，不是 worker 的 cwd。

**代价（要知道）**：程序**自身**的文件访问解析的是那个本机 scratch 目录——`process.cwd()`、
相对 `import()`、直接 `node:fs` 读相对路径都碰不到远端工作区。在远端会话里写程序时，把路径显式
交给工具（例如 `tools.read({ path: '…' })`）。这是改动前它根本不跑的情况下唯一可行的做法：
worker 的 bootstrap 在宿主包里，远端主机既没有它、也不一定有 Node。

> 这是服务端改动（`lib/`），**必须重启 DSH** 才生效，刷新页面不够。

## 卸载过插件后，侧栏少了远程工作区的会话

**症状**：`ssh://` 工作区那一行还在，点开却只有新会话；旧的会话在别处打不开，`~/.dsh/sessions/`
下对应的 `session.v4.jsonl.zstd` 文件也都还在。

**判据**：文件没丢，丢的是**归属记账**。宿主的 `@deepseek-ai/dsh-workspace` 用 `realpath(cwd)` 校验
每个会话的 cwd；插件不在时 `ssh://` 的 `realpath` 必然失败，该 id 只进 `invalidSessionPaths`，
既不入 `sessionPaths` 也不入 `missingSessionPaths`，因此不匹配任何工作区。更糟的是这个"解析不了"
的名单会被 `mutate()` **写回磁盘**——只要在那之后改过一次标题、attach 或 detach，归属就被真删。

**处置**：不用手动修，也不用手改 `workspace.json`。插件**每次激活**都会补偿，顺序固定：远端根挂好
之后**先重建一次宿主的会话索引**（`listStoredHeaders()` → `replaceHeaderIndex()` →
`indexLiveSessions()`），让 `ssh://` 的 cwd 重新解析得开；再读每个工作区当前的记账（`sessionIds`
是**筛选后**的视图），重建已经算回来的一律**不** attach（宿主对记录里已有的 id 会短路，发了也只是
空转），只把**记录里真的没有**的 id 逐个 `attachSession` 并**回读 `sessionIds` 验证**。

为什么不再「先量症状」：实体的 `sessionIds` getter 就是
`record.sessionIds.filter(id => candidateMatches(id, path))`，原始记录又不在实体的公开面上，于是
「索引是好的、本来就没事」与「索引是在插件缺席时建的、30 个 id 全被筛掉」读出**同一个零**——闸门会
判定"无需重建"，会话继续藏着，只能靠重启让宿主重新 `init()`。实测重建代价约 **340 ms**（60 个持久
会话、3 个 `ssh://` 根），每次激活一次。看结果的两处地方：

- `ssh_workspace_status` 的 `ownership` 字段，以及面板 `/status` 的同名字段（浏览器那一半也读它）：
  `stage`（走到哪一步：`listing` / `rebuilding` / `claiming` / `done`；`updatedAt` 是它最后一次变化的时间——**卡在某一站**与**字段为 `null`** 是两种
  完全不同的故障）、`reclaimed`（本次新算进来多少）、`pending`（仍挂不回去的）、`skipped`（被停用的
  工作区，不参与）、`degraded`（会话清单读不到、重建也没答案，因此没查）、`indexRebuilt`
  （`reindexed` / `skipped` / `unsupported` / `empty` / `failed: …`）、`failures[]`（哪个工作区、
  哪个会话、为什么——理由已去掉别名，路径显示为 `<workspace>`）；
- 诊断（面板的状态点 / `/status` 的 `diagnosis.findings`）：`pending > 0` 时出现
  `workspace-ownership` 的 warn；`reclaimed > 0` 时事件环里有一条 `ownership` 事件。

还有一个**已经打开的页面**的问题，它有**两层**，缺一层症状就不同：

1. **工作区分组**走订阅流（`workspace.follow`）：订阅时收一次基线，之后只在 `domain/changed` 推增量
   时刷新；而重建索引改的是**索引**、不是工作区记录，一条事件都不会发。于是页面在插件启用之前就
   订阅的话，会一直握着那份空 `sessionIds`。重建成功后补偿会按宿主自己的发射形状把每个工作区的
   **筛选后**视图重新广播一遍（`published` = 广播了几个工作区），这层就补上了。
2. **分组里的会话行**不来自那条流，而是来自 `session.list`——页面连上时**拉一次**的基线。冷会话
   （不在宿主活会话表里）没有任何可推送的事件，宿主也就永远补不上这几行。所以只补第 1 层会得到
   「分组回来了、但每个分组下面空着」。

因此补偿跑完之后，浏览器那一半会**再要一次会话基线**：读到 `/status` 的 `ownership`，只有
`stage === 'done'` 且这一次确实动过东西（`indexRebuilt === 'reindexed'`，或 `reclaimed > 0`，
或 `published > 0`）才调一次 `sessions.refresh()`（宿主 `refreshList()` 的公开入口，与重连时走的
是同一条路，自带 single-flight 与 `mergeOrderedBaseline`，能把缺失的行按顺序插回去）。拉完再看
`workspaces` × `sessions` 两份快照里 ssh 分组还缺几条，缺就重试，**最多 3 次**；第一次看 `/status`
在 400 ms 后，之后按 ×1.6 退避到 2 s，整趟 150 s 封顶。一个页面实例只跑一趟。

于是「禁用 → 启用」当场就该看到会话，**不必重启 DSH**。仍然空着时依次看：`publishError` 非空
（广播没成功，`ctx.emit` 缺席或抛出，刷新一次页面即可，不影响 `reclaimed` / `pending` 的判定）；
`ownership.stage` 没到 `done`（补偿还在跑或卡住，上面几种情形见下文）；宿主没有 `sessions` 服务或
它没有 `refresh`（catch-up 报「没问」，静默跳过，刷新页面仍能补上）。

三种情形补偿救不回来，也都是**说得出来**的：工作区被停用（根刻意没挂，只算 `skipped`）、远端目录
已被删除（`realpath` 仍失败，进 `failures` 且 `reason` 带 `ENOENT`）、会话清单不可读（
`degraded` 非空、`pending` 记 0 而不是虚报）。前两种可以先 `ssh_workspace_enable` 恢复工作区、
确认远端目录存在后重启 DSH 再试一次。

> 同样是服务端改动（`lib/ownership.js`）。**重新启用插件不必再重启一次**：补偿每次激活都先无条件
> 重建一次宿主会话索引（结果写在 `ownership.indexRebuilt`，正常是 `reindexed`），重建后回读记账即算
> 恢复。只有重建被判为 `unsupported`（宿主换了这几个方法名）或 `failed: …` 时，才需要**重启 DSH**。
> 刷新页面**不会**重跑补偿（它只重跑浏览器那一半的 catch-up，而 catch-up 读的是补偿已经写下的结果）。
> 补偿里每个 await 都有预算（会话清单 10 s、重建 45 s、单条认领 10 s、整趟认领 60 s），"卡住"于是会
> 以 `pending` 的理由出现，而不是让副作用栏一直空着。

## 连接问题

**先看诊断历史**：环形缓冲的**容量是 40 条**（`lib/diagnostics.js` 的 `CAPACITY`），
但每个导出面只取最新的一部分：`ssh_workspace_status` 的 `events` 字段是 10 条，
面板 `/status` 路由、`diagnosticsText` 与「诊断报告」都是 20 条。容量与导出条数是两回事，
别把它们当成同一个数。它通常是「刚才发生了什么」最快的答案：一条 `disconnect`
带时间戳，比读日志快得多——何况这个部署里 `ctx.logger` 根本没有出口（宿主不装 console
exporter，`debug` 又被默认级别丢弃），见 [development.md](./development.md#日志与诊断)。

`degraded` 尤其值得注意，它表示功能悄悄降级了：

- `inotifywait watcher ended; fell back to polling` —— 文件树改为轮询，同一秒内等长的连续
  改写可能不再触发刷新；
- `stream channel unavailable` —— 大文件读取退回了共享 SFTP 通道，会拖慢同连接上的其它操作。

两者都不影响正确性，但会让"为什么没反应 / 为什么变慢了"有据可查。

### 断线之后没有反应？

连接掉线后会自动在后台重试，面板上那张主机卡片显示 `重连中（第 N 次，M 秒后）`。
不需要点任何按钮——笔记本合盖、Wi-Fi 切换、VPN 重连之后回到界面，等几秒就该恢复。

| 看到什么 | 含义 | 该做什么 |
| --- | --- | --- |
| `重连中（第 N 次，M 秒后）` | 后台循环在跑 | 不用动；急的话点「立即重连」跳过等待 |
| `重连中（第 N 次）` | 一次尝试正在进行（握手最长 15 秒） | 等这一轮结束 |
| `重连已停止` + 红字原因 | 已放弃：不可恢复的配置问题（别名不存在、私钥读不到、主机密钥不匹配），或这个主机已经没有消费者了 | 按红字修配置，再点「立即重连」 |
| `已断开` | 有连接记录但没人在重试——通常是主动断开，或该主机没有被任何东西使用 | 点「立即重连」，或打开该主机下的工作区 |

两条刻意的设计，看到时不要当成 bug：

- **没有消费者的主机不会被拨号**：卸载了该主机最后一个工作区、也没有「开启」状态的保存转发时，后台循环会停——
  否则关掉的工作区会一直把主机连回来。重新挂载或点「立即重连」即可。
- **「断开」是终态**：手动断开后不会自动重连，否则那个按钮就毫无意义。下一次操作（打开文件、跑命令）会按需连上。

`ssh_workspace_status` 的 `reconnecting` 字段给出同样的信息：`phase` 为 `waiting` / `connecting` / `gave-up`，
`attempts` 是次数，`nextAt` 是下一次尝试的毫秒时间戳。

按以下顺序排查：

1. **面板「测试连接」**：先在「远程工作区」面板对目标主机实测一次，成功/失败会以顶部 toast 明示，是成本最低的定位手段。
2. **unknown SSH host**：别名既不在 `$DSH_HOME/dsh-ssh.json` 存储中，也没有对应的具体 `Host` 块——检查拼写；`~/.ssh/config` 的 `Include`、`Match`、通配块**不被解析**，请显式写出具体 `Host` 别名，或在面板中添加主机（见 [hosts.md](./hosts.md)）。
3. **认证失败**：key 认证先看主机行的「密钥未就绪」（`check-key`）标识——`keyPath` 在本机不存在或不可读；密码认证确认存储中的密码；agent 认证确认 `SSH_AUTH_SOCK`（或 `agentPath`）可用。密码与口令便于排查时可以临时改用本地 `ssh` 对照验证连通性。存储中的密码/口令是加密的，若报 `cannot read the stored secret for host …`，说明 `$DSH_HOME/dsh-ssh.key` 缺失或被更换——在面板重新保存该主机（见 [hosts.md](./hosts.md)）。
4. **主机密钥不匹配**：连接被拒，错误信息为「the server presented a different host key than the one recorded on first connect」并列出 `recorded` / `presented` 两个指纹。含义：该主机本次出示的密钥与首次连接时记录的（`dsh-ssh.json` 的 `knownHosts` 段）不一致——可能是主机重装系统或合法轮换了密钥，也可能是中间人。**先与管理员核对新指纹**；确认可信后，在「远程工作区」面板对该主机执行「忘记主机密钥」，再重连（重新 TOFU 记录）。若没有预期的密钥变更，不要继续连接。
5. **jump host / ProxyCommand 被拒**：插件不支持跳板，`resolve` 会直接报错说明。改用无跳板的主机条目，或换用其它工具连接该主机。
6. **端口 / 网络**：确认 `host` 与 `port` 可达；本地 `ssh -p <port> user@host` 能连通的话，插件侧再查凭据与配置来源（store 覆盖 `~/.ssh/config`，同别名以 store 为准）。
7. **面板接口 403 / 请求被拒**：宿主路由只服务本机（回环地址且 `Host` 头为本机监听的 `localhost`/`127.0.0.1`/`[::1]` 拼写）。如果你通过反向代理或自定义域名访问 DSH 界面，这些请求会被拒——属预期行为（防 DNS rebinding），不是故障。

## 已知限制

设计边界，非故障：

- **远端搜索与变更追踪依赖远端工具**：glob / grep 在远端工作区调用远端主机的 ripgrep——远端未安装 `rg` 时命令以退出码 127 失败，stderr 带安装提示（如 `sudo apt install ripgrep` / `brew install ripgrep`）。「变更」（deliverables）面板使用远端 git——远端未安装 `git` 时该能力按「无仓库」降级（每回合一条带安装提示的 warn），不阻断会话；远端目录不是 git 仓库时与本地行为一致（只列文件工具改动）。
- **shell 命令落点由 `workdir` 决定**：`pwsh` / `bash` 工具的 `workdir` 为 `ssh://` 时命令在远端主机执行，按 POSIX shell 语义、不受本机文件沙箱约束（以远端登录用户权限运行）；本地 `workdir` 的命令仍在本机、仍受沙箱围栏。要跑到未挂载的路径上，或需要确认某条命令到底在哪台机器执行，用 `ssh_workspace_exec`。
- **变更监视：优先事件推送，否则轮询**：远端有 `inotifywait` 时，监视走 `inotifywait -m` 的事件流，变更即时上报，也不受元数据精度限制。没有该工具（或该路径无法被监视）时回落到轮询——SFTP 没有可移植的变更通知，文件树 / 预览的自动刷新靠 stat / readdir 快照比对，基础间隔约 2 秒，空闲目录会自适应退避到 5–10 秒，任一变更立即回到 2 秒（见 [architecture.md](./architecture.md) 的「远端变更监视」）；读路径另有 1.5 秒的元数据缓存，但变更检测直读服务器、不吃缓存。轮询模式下 SFTP 元数据没有亚秒时间戳——同一秒内等长的连续改写可能**不触发**刷新（增、删、改名总能感知）；需要立即看到最新内容时重新打开或重新读取即可。推送通道意外中断时会自动重新挂上轮询，不会静默失效；无法继续的监视故障会以一次 Error 回调上报（界面按既有的失效路径处理），不会静默挂死。
- **不支持 jump host / ProxyCommand**：见上节。
- **后台重连有上限，且需要「有人在用」**：重试间隔从 1 秒指数增长到 60 秒封顶，默认不限次数，
  但只在还有消费者时进行（已挂载工作区、已保存且开启的转发）。进程退出后没有后台循环，重启 DSH
  才会重新连接。策略可用插件配置 `engine.reconnect` 调整（见根 README 的配置表），
  设 `engine.reconnect: false` 可退回「只在操作时重连一次」的旧行为。
- **原子写的降级**：远端写入采用「同目录暂存文件 + rename 原子替换」。当 SFTP 服务端未广告 `posix-rename@openssh.com` 扩展时，先删除目标再重命名，存在极小的非原子窗口——写入内容不会损坏，但极短时间窗内该路径可能短暂不存在。
- **重启后需重新插上插头**：已登记（register）的 `ssh://` 工作区在重启后自动重新挂载（见 [architecture.md](./architecture.md) 的「工作区登记」）；但如果注册表记录已被清理而挂载仅存在于内存，需重新 `ssh_workspace_mount`。

## 相关

- [hosts.md](./hosts.md) — 主机与凭据配置
- [tools.md](./tools.md) — 工具参数与返回语义
- [protocol.md](./protocol.md) — 路径规范与写入围栏
