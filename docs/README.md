# dsh-ssh-workspace 文档

[根 README](../README.md) 面向「快速了解、安装、能力概览」；本目录存放展开的
专题文档。内容已从 README 迁移并对照源码展开，当前为初稿状态——如发现与实现
不符之处，以源码为准并欢迎修订。

## 目录

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [architecture.md](./architecture.md) | 架构与实现要点：`ctx.fs` 接管、内建桥接、引擎与连接模型 | 初稿 |
| [protocol.md](./protocol.md) | `ssh://` 路径协议：语法、规范化、显示规则、`file:` URI | 初稿 |
| [hosts.md](./hosts.md) | 主机配置与认证：存储格式、`~/.ssh/config` 回退、面板管理 | 初稿 |
| [tools.md](./tools.md) | Agent 工具参考：五个 `ssh_workspace_*` 工具 | 初稿 |
| [ui.md](./ui.md) | 界面指南：面板、添加工作区双入口、远程工作区标记 | 初稿 |
| [development.md](./development.md) | 开发、调试与发布：源码结构、依赖解析、打包流程 | 初稿 |
| [troubleshooting.md](./troubleshooting.md) | 排查与常见问题：错误语义、连接问题、已知限制 | 初稿 |
| [_template.md](./_template.md) | 新建文档用模板 | — |

状态取值：骨架 = 结构与占位就位、内容待填；初稿 = 主要内容已成；完成 = 已校对。

## 写作约定

- 语言：简体中文；代码标识（文件、函数、字段、错误码）保留英文原文。
- 文件名：小写英文、连字符分词（如 `getting-started.md`），不加序号前缀。
- 结构：每页以「一句话定位」开头 → 概述 → 主题分节 → 「相关」链接。
- 引用：代码位置写 `lib/xxx.js:行号`；跨页引用一律相对链接。
- 图片：放在 `docs/assets/`，正文用 `./assets/<name>.png` 引用。
- 新增页面：从 [_template.md](./_template.md) 拷贝，并在本索引登记（含状态列）。
