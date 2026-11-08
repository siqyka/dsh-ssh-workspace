# dsh-ssh-workspace 文档

[根 README](../README.md) 面向「快速了解、安装、能力概览」；本目录存放展开的
专题文档。内容已从 README 迁移并对照源码展开，**数字与清单均按当前源码核对**
（路由 31 条、Agent 工具 11 个、冒烟套件 76 个）。如发现与实现不符之处，
以源码为准并欢迎修订。

## 目录

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [features.md](./features.md) | 功能说明：按能力域列出的完整功能清单——每项写清做什么、怎么用、依赖什么、缺依赖时如何降级 | 完成 |
| [architecture.md](./architecture.md) | 架构与实现要点：`ctx.fs` / `ctx.shell` / `ctx.subprocess` 接管、变更监视与流式读取、内建桥接、引擎与连接模型 | 完成 |
| [protocol.md](./protocol.md) | `ssh://` 路径协议：语法、规范化、显示规则、`file:` URI、写入围栏与停用围栏 | 完成 |
| [hosts.md](./hosts.md) | 主机配置与认证：存储格式、`~/.ssh/config` 回退、面板管理 | 完成 |
| [tools.md](./tools.md) | Agent 工具参考：11 个 `ssh_workspace_*` 工具（含 `ssh_workspace_reverse_forward`） | 完成 |
| [ui.md](./ui.md) | 界面指南：面板、添加工作区双入口、远程工作区标记、端口转发与持久会话区 | 完成 |
| [forward-persistence.md](./forward-persistence.md) | 端口转发的持久化：已存映射、开关语义、端口预检、启动自动开启 | 完成 |
| [development.md](./development.md) | 开发、调试与发布：源码结构、依赖解析、测试套件、打包流程 | 完成 |
| [upstream-workarounds.md](./upstream-workarounds.md) | 上游临时补丁登记：宿主缺陷、一行修法、自动退役信号与删除步骤 | 完成 |
| [upstream-workaround-pattern.md](./upstream-workaround-pattern.md) | **上游补丁的退役模式**：可复用的方法——适用判定、七件套、三态探测、可达的信号通道、四条反模式与成本边界 | 完成 |
| [troubleshooting.md](./troubleshooting.md) | 排查与常见问题：错误语义、停用围栏、连接问题、已知限制 | 完成 |
| [optimization-and-future03.md](./optimization-and-future03.md) | **优化项与 Future（第三辑 · 唯一账本）**：仍未做、判定不做、上游阻塞、验证缺口与已完成 ID 索引；前两辑已合并到这里 | 完成 |

状态取值：初稿 = 主要内容已成；完成 = 已校对。

## 阅读顺序

- **想确认某功能有没有** → [features.md](./features.md)
- **想用起来** → 根 README 的快速开始 → [ui.md](./ui.md) → [tools.md](./tools.md)
- **想改代码** → [architecture.md](./architecture.md) → [development.md](./development.md)
- **想规划下一步** → [optimization-and-future03.md](./optimization-and-future03.md)
- **出问题了** → [troubleshooting.md](./troubleshooting.md)

## 写作约定

- 语言：简体中文；代码标识（文件、函数、字段、错误码）保留英文原文。
- 文件名：小写英文、连字符分词（如 `getting-started.md`），不加序号前缀。
- 结构：每页以「一句话定位」开头 → 概述 → 主题分节 → 「相关」链接。
- 引用：代码位置写 `lib/xxx.js:行号`；跨页引用一律相对链接。
- 图片：放在 `docs/assets/`，正文用 `./assets/<name>.png` 引用。
- 新增页面：写好后在本索引登记，并补进根 README 与 `README.en.md` 的文档索引。
