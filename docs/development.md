# 开发、调试与发布

> 定位：从源码到装进 profile 生效的完整流程。

## 源码结构

纯 loader 插件，无构建步骤：宿主半边是原生 ESM，浏览器半边是手写的单文件 bundle（`lib/client.js`，由 DSH 前端的 `window.__ModuleLoader__.load({id, factory})` 约定直接加载，不经打包器）。

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：`name` / `inject` 声明、引擎装配、`ctx.inject(['fs'])` 接管时序、工具与路由注册、系统提示公告 |
| `lib/engine.js` | SSH 引擎：按别名维护持久连接与 SFTP 通道、连接池、空闲回收、`exec` 远端命令 |
| `lib/remote-fs.js` | SFTP 文件系统后端：实现 `ctx.fs` 的远端方法（stat / 读写 / 列目录 / 原子写等），`FsError` 语义与本地后端对齐 |
| `lib/protocol.js` | `ssh://` 路径：解析、规范化、`file:` URI、前缀判定、basename / dirname |
| `lib/patch-fs.js` | `ctx.fs` 接管：把远端方法装到部署已有的后端实例上，其余方法原样转发 |
| `lib/fs-shim.js` | `node:fs/promises` 与 `node:path.isAbsolute` 的 `ssh://` 桥接（含 `syncBuiltinESMExports`） |
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

## 打包与安装

```
npm pack                                    # 生成 dsh-community-dsh-ssh-workspace-<version>.tgz
# 编辑 profile 的 package.json：@dsh-community/dsh-ssh-workspace 的依赖改为 file:<tgz 绝对路径>，并同步版本号
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
