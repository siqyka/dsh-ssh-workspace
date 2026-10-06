# 开发、调试与发布

> 定位：从源码到装进 profile 生效的完整流程。

## 源码结构

纯 loader 插件，无构建步骤：宿主半边是原生 ESM，浏览器半边是手写的单文件 bundle（`lib/client.js`，由 DSH 前端的 `window.__ModuleLoader__.load({id, factory})` 约定直接加载，不经打包器）。

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：`name` / `inject` 声明、引擎装配、`ctx.inject(['fs'])` 接管时序、工具与路由注册、系统提示公告 |
| `lib/engine.js` | SSH 引擎：按别名维护持久连接与 SFTP 通道、连接池、空闲回收、`exec` 远端命令 |
| `lib/remote-fs.js` | SFTP 文件系统后端：实现 `ctx.fs` 的远端方法（stat / 读写 / 列目录 / 原子写 / 流式读 / 轮询式 watch 等），`FsError` 语义与本地后端对齐 |
| `lib/protocol.js` | `ssh://` 路径：解析、规范化、`file:` URI、前缀判定、basename / dirname |
| `lib/patch-fs.js` | `ctx.fs` 接管：把远端方法装到部署已有的后端实例上，其余方法原样转发 |
| `lib/patch-shell.js` | `ctx.shell` 接管：`workdir` 为 `ssh://` 的 spec 改在远端执行（复用引擎连接），其余原样转发给本地执行器；实现 seam 的 handle 契约（`done` / `result` / `observed` / `kill` / `onExpiry` / `signal`） |
| `lib/patch-subprocess.js` | `ctx.subprocess` 接管：`cwd` 为 `ssh://` 的 spawn 在远端执行（rg/git 白名单、POSIX 脚本组装、seam handle 契约、TERM→KILL 阶梯）；scratch 镜像注册表（env 改写 + 远端 `mkdir -p`），供 fs 桥的 `rm`/`copyFile` 联动 |
| `lib/fs-shim.js` | 内建桥接：`node:fs/promises` 的 `mkdir`/`stat`/`lstat`/`realpath`/`readdir`/`copyFile`/`open`/`rm` 与 `node:path` 的 `isAbsolute`/`resolve`/`join`/`relative` 对 `ssh://` 拼写单独处理（含 `syncBuiltinESMExports`）；变更追踪的 SFTP 读句柄与 scratch 镜像落盘/联动，`readdir` 服务 `@` 补全 |
| `lib/hosts.js` | 主机解析：存储优先、`~/.ssh/config` 回退、行渲染 |
| `lib/store.js` | `$DSH_HOME/dsh-ssh.json` 存储：校验、合并（保留未知字段）、原子写 |
| `lib/routes.js` | 浏览器半边的 8 条 HTTP 路由（hosts / save / delete / test / ls / status / mount / unmount） |
| `lib/tools.js` | 5 个 `ssh_workspace_*` Agent 工具（schema / 渲染 / 执行） |
| `lib/peers.js` | 宿主依赖（`@deepseek-ai/*`、`ssh2`）的定位与加载 |
| `lib/client.js` | 浏览器半边：面板、添加工作区流程、标记装饰、全部样式与中英文案 |

## 依赖解析

`ssh2` 是本包的直接依赖（随 `npm install` 安装）；`@deepseek-ai/cordis`、`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-tools` 声明为 peer，插件运行时由 `lib/peers.js` 按以下顺序定位（每处先找 `node_modules/<pkg>`，再直接按包名 require；结果按目录记忆化）：

1. 本包自身依赖树（总是先试，覆盖一切其它来源）；
2. 环境变量 `DSH_PEER_ROOT`（支持多路径，以 PATH 分隔符分隔）；
3. `DSH_PROFILE_DIR`（profile 目录）/ `DSH_PROFILE`（profile 名）；
4. `$DSH_HOME/profiles/<name>/node_modules`，profile 名依次取 `desktop`、`default`、`web`；
5. 应用内回退：`process.resourcesPath` 与 `process.execPath` 下的 `resources/app.asar/dsh/node_modules`、`resources/app/dsh/node_modules` 等，兼容 Electron 打包布局。

profile 安装（`pnpm install`）会让第 1 步命中 profile 内的解析链；直接从源码检出处加载时，依赖不在本包树下，需显式给 `DSH_PEER_ROOT` 指向加载器的 `node_modules`。

## 调试

两个半边都无编译步骤，"改完即所测"：

- **宿主半边**（`lib/*.js`，除 client）与 `client.js` 的**样式/文案**：改动进入已安装位置后重启 DSH 生效。调试源码检出的宿主半边可用 DSH 自带的 Electron 运行时：以 `ELECTRON_RUN_AS_NODE=1` 运行宿主源码脚本，并设 `DSH_PEER_ROOT` 指向 DSH 安装目录的 `node_modules`（参考 [architecture.md](./architecture.md) 的「peer 解析」顺序）。
- **浏览器半边**：`client.js` 由 DSH 前端按单文件包加载，改动需重装进 profile 并重启 DSH，再重载页面；文件头注释里写明其加载协议，无独立构建管线。

日志走 Cordis logger（`ctx.logger`），前缀 `ssh-workspace:`；面向模型的能力公告见 `lib/index.js` 的 `SSH_WORKSPACE_GUIDANCE`。

## 冒烟测试与 CI

`tests/` 下是一组按依赖分层的冒烟套件；`node tests/run.mjs` 依次以子进程运行
全部套件（也可 `node tests/run.mjs live acceptance` 只跑指定套件）：

| 套件 | 前置 | 覆盖 |
| --- | --- | --- |
| `protocol-smoke` | 无 | `ssh://` 语法、规范化、前缀判定、basename / dirname、`file:` URI |
| `client-shape-smoke` | 无 | package.json 的 `dsh.client` / `exports` / `files` 与 client bundle 装载约定 |
| `lifecycle-smoke` | `DSH_CORE_ROOT` | 真实 Cordis 下 5 种服务装配顺序的接管 / 路由 / 工具注册 |
| `boot-smoke` | `DSH_CORE_ROOT`（远端段另需 `DSH_WS_TEST_ALIAS`） | 生产顺序引导、`ctx.fs` 接管与还原、工具端到端 |
| `tool-schemas-smoke` | `DSH_CORE_ROOT` | 工具 schema 过真实 `assertSupportedJsonSchema` + render 冒烟 |
| `live-smoke` | `DSH_WS_TEST_ALIAS`（peers 可解析） | 远端 SFTP 全量契约、写围栏、错误语义、原子写、symlink |
| `acceptance-smoke` | `DSH_CORE_ROOT` + `DSH_WS_TEST_ALIAS` | 经补丁后 `ctx.fs` 的端到端验收（挂载 → 读写 → 围栏 → 卸载） |

环境变量（全部可选；未设置时对应套件 SKIP 并以 0 退出）：

- `DSH_CORE_ROOT`：含 `@deepseek-ai/*` 与 `ssh2` 的 `node_modules` 树（可从已安装应用组装）。套件从中取真 Cordis / dsh-fs / dsh-tools，并把同一路径转告 `DSH_PEER_ROOT` 供插件解析 peers。
- `DSH_WS_TEST_ALIAS`：存储 / `~/.ssh/config` 里可用的主机别名（不内置任何真实主机）。
- `DSH_WS_TEST_DIR`：远端暂存父目录（默认 `/tmp/dsh-ssh-workspace-test`）。

裸检出（无任何环境变量）`node tests/run.mjs` 只跑纯套件——这正是 CI 的形态。
CI（`.github/workflows/ci.yml`）在 push / PR 上执行：`npm ci --ignore-scripts`
（`.npmrc` 的 `legacy-peer-deps` 使锁文件只含 ssh2 运行时树，`@deepseek-ai/*`
peer 由宿主提供）→ `node --check` 全部 `lib/*.js` → `node tests/run.mjs` →
`npm pack --dry-run`。

## 打包与安装

```
npm pack                                    # 生成 shiqyka-dsh-ssh-workspace-<version>.tgz
# 编辑 profile 的 package.json：@shiqyka/dsh-ssh-workspace 的依赖改为 file:<tgz 绝对路径>，并同步版本号
# 在 profile 目录执行 pnpm install             # 解包进 profile 的 node_modules
# 重启 DSH
```

要点：

- 包内容由 `package.json` 的 `files` 白名单控制：`lib/`、`cordis.patch.yml`、`README.md`。
- 每批改动**升一个 patch 版本号**，tgz 文件名随之变化，profile 依赖指向也要同步。
- 客户端接管依赖 `dsh.bundle.patch`（`cordis.patch.yml`）与 `dsh.client.platform: web` 声明，改动这些元数据同样需要重装。
- 不打包、不安装时，源码改动不影响已安装副本——已安装版本始终以 profile 内 `node_modules` 为准。

## 相关

- [architecture.md](./architecture.md) — 机制与 peer 解析细节
- [根 README](../README.md) — 安装与能力概览
