# 界面指南

> 定位：插件在 DSH 界面中的全部出入口与交互。

## 「远程工作区」面板

侧边栏面板，注册在 `sidebar.panellist` 插槽，入口图标为服务器图标（`ServerIcon`），标题「远程工作区」。

主机卡片逐条展示存储与 `~/.ssh/config` 回退的全部主机，字段为别名、`user@host:port`、认证方式、来源（store / ssh-config），以及「密钥未就绪」提示（key 认证且 `keyPath` 在本机不存在时）。每张卡片提供：

- **测试连接**：调用 `POST /api/dsh-ssh-workspace/test` 实连一次。结果以页面顶部 toast 呈现——成功后数秒（约 3.5 s）自动消失，点击可提前关闭；失败消息同样处理。
- **浏览目录**：目录浏览入口目前屏蔽（代码保留在 `lib/client.js`，去掉注释即可恢复），远端目录选择已并入「新建远程工作区」对话框。
- **编辑 / 删除**：编辑打开主机表单；删除为就地确认，删除只影响存储条目，不会自动卸载已挂载的工作区。

表单要点：密码与密钥口令**从不回传浏览器**，编辑时留空表示保留原值（见 [hosts.md](./hosts.md) 的「认证与凭据」）；切换认证方式时必须重新填写新凭据。

## 添加工作区双入口

插件占用两个 directoryFlow 插槽：侧边栏的 `sidebar.workspaces.directoryFlow` 与会话页的 `conversation.hero.workspace.directoryFlow`，以负优先级（`-100`）遮蔽部署自带的本地选择器——插槽核心渲染优先级**最低**的占用者，负优先级因此胜出，且不卸载内建实现。

触发后弹出锚定菜单（宽约 300px），包含两行：

- **本地**（FolderIcon）：转交 DSH 原生目录选择器——桌面端走 preload 桥 `__DSH_DIRECTORY_PICKER__`，否则走 `uiWorkspace.pickDirectory()`。
- **远程**（远程标记图标）：打开「新建远程工作区」对话框。

锚定机制：触发按钮不传给插槽占用者，因此插件在捕获阶段监听 `mousedown` 记住最近一次按钮位置（3 秒内有效，避免键盘快捷键打开时菜单"瞬移"），弹出层定位在按钮右侧 8px 处，并钳制在视口内；窗口 resize 时重新定位。点击菜单外部或按 Esc 关闭。

## 新建远程工作区对话框

一次完成"选主机 → 选目录 → 命名 → 挂载"：

1. 拉取主机列表，默认选中第一台；主机列表为空或出错时给出对应空态。
2. 目录浏览：`GET /api/dsh-ssh-workspace/ls?alias=…&path=…` 逐级浏览远端目录，只列目录、按名称排序；提供「返回上级」、加载中 / 空目录 / 无法加载三种状态。
3. **可写探测**：`/ls` 同时回报 `writable`。目录不可写时显示红色警告（"当前 SSH 账号对这个目录没有写入权限……"）并禁止创建——写入能力是 Agent 工作的前提。
4. 创建：`POST /api/dsh-ssh-workspace/mount`，携带 `{alias, remotePath, title, register: true}`。**先注册、后接纳**：挂载路由在宿主接纳该路径之前就按所填名称登记工作区，宿主随后解析到既有记录，避免以派生标题重复建条目。成功后刷新标记数据源，把路径交还吸附链路；对话框在接纳期间保持禁用，背景点击可取消（创建中除外）。

## 远程工作区标记

远程工作区不以文件夹图标示人，而是显示 SSH 标记。DSH 的行图标没有插件插槽，实现为 **DOM 装饰**（`lib/client.js` 的 "Remote-workspace marks" 段），三条原则：

- **React 安全**：从不删除或搬迁 React 拥有的节点——仅通过内联 `style` 隐藏文件夹字形（React 不会重写这些节点的 `style`），在旁插入自带 `data-sshwsp-mark` 的 svg。
- **自愈**：`MutationObserver` 监听 `document.body`，React 重建行节点后自动重新施加替换；工作区不再远程时同样自动还原。
- **身份匹配**：从 live `workspaces` store 的 `getSnapshot()` 取 id / title 集合（服务不可达时退回 `/status` 的 `workspaces` 数组）。侧栏行按工作区 **id** 匹配；选择器菜单行与会话页 hero 工作区按钮只有标题，按 **title** 匹配，hero 在会话刚建立时可能显示路径 basename，故 basename 也计入标题集合。

装饰同时覆盖三处展示：侧栏工作区行、侧栏选择器菜单行、会话页 hero 工作区按钮。

## 路径的展示拼写

两处纯展示的替换，把 `ssh://alias/path` 显示为 `ssh://alias@/path`（读起来像 SSH 地址）：

- 工作区悬停卡片（hover card）中的路径；
- DSH `PathLabel` 单元格：文件面板头部、文档预览标题、交付物列表。

只改渲染文本，复制行为与所有功能消费方保持真实拼写。规则细节见 [protocol.md](./protocol.md) 的「显示规则」。

## 文件面板与文档预览

「工作区文件」侧边栏与文档预览无需插件改动——它们经 `ctx.fs` 读取，远程工作区下自然由 SFTP 提供（列目录、读文本、写回均同本地工具一致）。

已知差异：远端**不支持变更监视**，`watch` 对远程路径以 `FS_IO_ERROR` 拒绝，界面表现为不自动刷新——不报错，重新打开或重新读取即可看到最新内容。

## 相关

- [hosts.md](./hosts.md) — 主机与凭据在面板中的管理语义
- [protocol.md](./protocol.md) — 展示拼写与路径规范
- [troubleshooting.md](./troubleshooting.md) — 界面报错对应的排查
