# 架构与实现

> 定位：插件如何在不修改 DSH 源码的前提下，把 SFTP 远端接入 `ctx.fs` 与
> 界面。读者：想读源码或参与贡献的人。

## 总体结构

插件分两半，各自独立加载：

- **宿主半边**（`lib/*.js`）：一个普通的 Cordis ESM 插件，入口 `lib/index.js`
  （`name = 'ssh-workspace'`）。它不静态依赖 `fs` 服务——而是
  `ctx.inject(['fs'], …)` 在本地后端出现的那一刻执行接管；用
  `ctx.inject(['fs', 'workspaceRegistry'], …)` 恢复重启前登记的远端工作区；
  用 `ctx.inject(['fs', 'webServer'], …)` 注册浏览器半边的 HTTP 路由。
  三者都可以晚于本插件出现，安装顺序无关。
- **客户端半边**（`lib/client.js`）：单文件包，由 DSH 客户端的模块加载器
  （`window.__ModuleLoader__.load({ id, factory })`）直接执行，通过 `slots`
  服务挂载「远程工作区」面板与「添加工作区」菜单，并做工作区标记的 DOM 装饰。

一次远端读取的路径：模型 read 工具 → `ctx.fs.readText(target)`
（`target.targetKey` 形如 `ssh://alias/abs/path`）→ 被接管的 `ctx.fs`
（`lib/remote-fs.js` 的 `RemoteFileSystem`）按拼写分派 → 远端半边走 SFTP；
其余拼写原样转发给部署自己的本地后端。

## 接管 ctx.fs

Cordis 拒绝在同一作用域第二次 `provide('fs')`（实现按服务的隔离符号登记，
会撞键），`ctx.set('fs', …)` 也被拒（只有提供该服务的 fiber 能覆盖它的值）。
部署本身已经挂了本地后端，所以插件不重新注册服务，而是**给现存的那个
`ctx.fs` 实例打补丁**（`lib/patch-fs.js`）：

- 远端方法装成实例的**自有属性**（自有属性覆盖原型链，且对已注册的服务
  安装属性不会失败）；
- 其余方法**绑定原始 receiver** 转发给原后端——沙箱围栏、版本守卫等本地
  行为完全不变；
- 原型上的原始方法不动，卸载时删除自有属性即复原（并留有
  `Symbol.for('dsh-ssh-workspace.installed')` 安装标记）。

## node:fs 内建桥接

`ctx.fs` 之外仍有宿主子系统直接调内建模块，且发生在 agent 存在之前：
会话控制器创建会话前 `mkdir` 项目目录，工作区注册表 `realpath` + `stat`
会话 `cwd`，会话服务写 header 前用 `path.isAbsolute` 校验 `cwd`。
对 `ssh://` 拼写，这些调用会落到本机（Windows 会把 `ssh://…` 解析成
相对路径）并以 ENOENT 失败；`isAbsolute` 也把它判为相对。

`lib/fs-shim.js` 替换 `node:fs/promises` 的 `mkdir` / `stat` / `lstat` /
`realpath` 与 `node:path.isAbsolute` 的对应行为：只有 `ssh://` 拼写改走
SFTP（其余路径原样转发），然后 `module.syncBuiltinESMExports()` 同步到内建
模块的 ESM facade——已加载模块的
`import { mkdir } from 'node:fs/promises'` 命名绑定也因此生效。
`mkdir` 是写操作，同样受挂载围栏约束；`realpath` 返回词法规范化的
`ssh://` 拼写（不请求服务器 realpath），与会话 header、工作区登记保持一致。

## 工作区登记

`WorkspaceRegistry.create()` 内部用 `fs.realpath` 规范化路径，`ssh://` 永远
过不了。插件改用同一份持久化路径的 `createCanonical()`：保留完整的持久化与
顺序写入，只跳过宿主机 realpath 断言。浏览器半边的创建流程也是先
`POST /mount { register: true, title }` 预注册，再把路径交给 DSH 的接收链路。

被服务的工作区根（served-root 集）在内存里，而登记是持久的，因此重启后
`ctx.inject(['fs', 'workspaceRegistry'])` 会把 registry 里所有 `ssh://` 项
重新 `addRoot`——否则会出现「UI 里有、文件却打不开」的状态。

## 引擎与连接模型

`lib/engine.js`：每个别名一条 ssh2 长连接 + 一个 SFTP 通道，通道常开
（文件系统后端一次工具调用会发很多小操作）。主要默认值：

| 项 | 默认 |
| --- | --- |
| 连接超时 | 15s |
| keepalive | 15s |
| 空闲回收 | 30 分钟（sweeper 每 60s 扫一遍，有请求在飞不回收） |
| 主机变更 | `forget(alias)` 丢弃旧连接，下次操作按新配置重连 |

原始 ssh2 / SFTP 失败会被映射为稳定的 `FsError` 错误码
（`ENOENT` / `EACCES` / `EIO` 等），消费方只按码分支，不解析报错文本。

## peer 解析

`lib/peers.js` 的 `requirePeer` 依次尝试（结果按包名记忆化）：

1. 本包自己的 `node_modules`（profile 安装时即 profile 的依赖树）；
2. `DSH_PEER_ROOT`（可用路径分隔符列多个，测试或临时依赖树用）；
3. `DSH_PROFILE_DIR/node_modules`；
4. `$DSH_HOME/profiles/<DSH_PROFILE>/node_modules`，以及常见 profile 名
   `desktop` / `default` / `web`；
5. 部署自带树：`app.asar/dsh/node_modules`、`app.asar/node_modules`、
   `app.asar.unpacked/dsh/node_modules`（由 `process.resourcesPath` /
   `execPath` 推出；普通 Node 下这些路径不存在，探测即跳过）。

## 客户端半边

`lib/client.js` 是手写的单文件包（无构建步骤），由 DSH 客户端加载器执行：

- 通过 `slots` 挂「远程工作区」面板、「添加工作区」锚定菜单（以
  `priority: -100` 遮蔽原生 `directoryFlow` 双入口）与远端目录对话框；
- 工作区标记是 **DOM 装饰**：不删改 React 节点，隐藏原生文件夹图标、
  插入自有 `svg[data-sshwsp-mark]`，MutationObserver 自愈重扫；
- 与宿主通信走 8 条路由（前缀 `/api/dsh-ssh-workspace/`）：
  `hosts`、`hosts/save`、`hosts/delete`、`test`、`ls`、`status`、`mount`、
  `unmount`。

## 相关

- [protocol.md](./protocol.md)
- [development.md](./development.md)
- [根 README](../README.md)
