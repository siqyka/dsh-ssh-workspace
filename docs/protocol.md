# 路径协议

> 定位：`ssh://` 拼写的完整规范——语法、规范化、显示改写与 `file:` URI。
> 读者：使用者与二次开发者。

## 语法

```
ssh://<主机别名>/<远端绝对路径>
例如  ssh://myserver/home/user/project
```

- 别名是 DNS 式标签、**不能含 `/`**，所以别名与路径的切分没有歧义；
- 远端路径必须绝对（以 `/` 开头）。
- 别名另有校验规则（写入主机存储时）：非空、最长 64 字符、不以 `-` 开头、
  不含空白、斜杠、引号或通配符。
- `parseRemotePath()` 对「以 `ssh://` 开头但别名为空或路径非绝对」的拼写
  **抛错**（这是调用方错误，不该静默）；对不是 `ssh://` 的拼写返回
  `undefined`（表示与本插件无关，交给本地后端）。

## 规范化

`normalizeRemotePath()` 纯词法地折叠 `//` 与 `.`、弹掉 `..`，保留开头的
`/`——**不请求服务器 realpath**。目标身份（`targetKey`）用的就是
`ssh://别名` + 规范化路径，所以 `ssh://a/x/../y` 与 `ssh://a/y` 是同一条目标。

## 写入围栏判定

`isRemotePathUnder(parent, child)` 在规范化后做词法前缀比较（根 `/` 特判）。
远端**写入**（writeText / editText / mkdir / 原子替换）只允许落在已挂载的
远端工作区之内、或该主机的 `/tmp` 之下，其余越界返回 `FS_OUTSIDE_WORKSPACE`；**读取不受限**。
`/tmp` 之所以可达，是因为本地 `writableRoots(policy)` 除 `workspaceRoot` 外还列了常量 `/tmp`；
不跟上就会出现「远端构建写不了暂存文件、本地同一份正常」的偏差。该放宽只对**已有挂载根的主机**
生效，且只作用于**写围栏**（读探针、`node:fs` 桥、停用围栏仍按原始挂载根作答）。

### `/mkdir` 的两个分支

`POST /mkdir` 是同一组围栏下的唯一写入路由，`path` 的拼写决定走哪一半：

| 分支 | 判定 | 边界来源 | 额外检查 |
| --- | --- | --- | --- |
| 远端 | `path` 是 `ssh://` 拼写 | 已挂载根 + 该主机 `/tmp`，且工作区已启用 | `assertRemoteFence` 栅栏子项（不是父目录） |
| 本地 | `path` 不是 `ssh://` 且是绝对路径 | **只取自会话/策略**（`workspaceRoot` 或会话 `header.cwd`），请求里的 `root` 仅用于识别会话 | `realpath(root)` + `realpath(target)` 词法包含，防符号链接逃逸；目标必须是目录；子项用非递归 `mkdir`，已存在答复 409 |

两半都先过 `mutationNameRefusal`（单个路径段、拒绝 `.` `..` 与分隔符）与 `assertMutationAllowed`（`read-only` → `FS_SANDBOX_DENIED`；会话无法识别 → `FS_PERMISSION_DENIED`），再碰文件系统。会话工作区是远端时，本地路径直接 403——本地路径不可能属于一个远端工作区。

这道围栏之外还有两道**独立的**围栏：

1. **沙箱模式**（`read-only` / `workspace-write` / `danger-full-access`）。`read-only` 拒绝一切远端写入，
   返回 `FS_SANDBOX_DENIED`——与本地同一套语义。模式由每次调用的 `sandboxPolicy`（第五个参数）带入；
   缺席时回落到后端 `sandboxMode`（部署默认），而不是「不限制」。三个被认可的模式**之外**的任意字符串
   （未来新增的名字、fold 损坏出的值）同样**拒绝**（写入与命令都是），与本地一致：本地后端对读不懂的
   模式走 containment 分支且 `writableRoots` 返回 `[]`，即一律拒；远端若跳过模式与范围两道围栏就会
   「同一输入本地收紧、远端放开」。拒绝文案不谎称这是「仅可查看」，而是点名列出三个被认可的模式。
   `workspace-write` **比较会话自己的 workspace root**：本地后端用 `writableRoots(policy)` 判定，第一项
   就是 `policy.workspaceRoot`，远端给出同样的答案。这个 root 由 `SandboxPolicyService.resolve` 返回
   `session.header.cwd` 原样得到——远端会话就是那个 `ssh://` 拼写，可以直接比较（实测确认，见
   `docs/features.md` 的「工作区内的修改算不算数」）。落在会话工作区**且 `/tmp` 之外**的目标是
   `FS_SANDBOX_DENIED`，文案点名会话工作区与出路。挂载围栏是另一道：它问的是「这个目录被服务吗」。
   **命令执行面**（`ssh_workspace_exec` / 持久 shell / workdir 为 `ssh://` 的 bash、pwsh / cwd 为
   `ssh://` 的终端）另走 `lib/mode-gate.js`：`read-only` 与**任何读不懂的模式**下直接拒绝，不做围栏尝试——本机内核边界跨不过
   SSH，没有可交给它的 `workspaceRoot`。终端的判定分两处时机：开 PTY 时拒绝（不建通道），以及此后
   **每次写入**重新判定（已开着的终端在切成 `read-only` 后停止接受命令，控制字节与关闭除外）。
   `workspace-write` 下命令**不会**被收窄到会话工作区：限制一个**进程**需要内核边界，而它跨不过 SSH。
   这是如实的限制，不是遗漏——文件写入被收窄，命令没有被收窄。
2. **工作区停用**（`detach`）。其下**读写都拒**，返回 `FS_PERMISSION_DENIED`，文案带
   `the remote workspace is detached`。用权限码而非沙箱码，是因为宿主的工具层会把每个
   `FS_SANDBOX_DENIED` 改写成「在 <mode> 模式下被拒 + 可升权重试」，而对一个被关掉的工作区升权毫无作用。

三者判定时机不同——停用最先作答，随后是模式，最后是挂载根；且停用对
`ssh_workspace_exec` / 持久 shell / glob / grep / git / 传输一并生效
（判据是 `engine.isDisabledTarget`）。详见 [features.md](./features.md) 的「工作区」一节。

## 显示规则

界面显示时，别名后插入一个 `@`：

```
实际拼写（复制与一切功能使用）  ssh://myserver/home/user/project
显示拼写（仅界面展示）          ssh://myserver@/home/user/project
```

出现位置：侧栏工作区行的悬停卡片、右侧栏「文件」面板头部、文档预览头部。
改写是纯显示层的行为——复制按钮与所有消费者拿到的仍是实际拼写。

## file: URI

`formatRemoteFileUrl()` 返回**远端执行世界**（POSIX）的规范 `file:` URI：
分隔符保持字面量，其余保留字符与非 ASCII 逐段百分号编码。
不能在本机（例如 Windows）用 `pathToFileURL` 得到盘符拼写——宿主只用它
换算相对路径（`new URL(url).pathname`），POSIX 拼写才能得到 `/` 连接的答案。

## 与会话 / cwd 校验的关系

会话 header 要求 `cwd` 通过 `path.isAbsolute` 校验，而任何平台解析器都不把
裸 `ssh://` 拼写当绝对路径（win32 视作缺冒号的两字母伪盘符，posix 视作普通
相对段）。插件把 `node:path.isAbsolute` 对 `ssh://` 拼写改为返回 `true`
（见 [architecture.md](./architecture.md) 的「内建桥接（node:fs / node:path）」），
`realpath` 也返回词法规范拼写——会话 header 与工作区登记两处的拼写因此
永远一致，并可以在远端工作区里直接新建会话。

## 相关

- [architecture.md](./architecture.md)
- [hosts.md](./hosts.md)
