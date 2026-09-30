# 主机配置与认证

> 定位：主机从哪里来、如何存储、如何在面板中管理。

## 来源与优先级

两类来源，按优先级：

| 来源 | 位置 | 可编辑 |
| --- | --- | --- |
| 主机存储（优先） | `$DSH_HOME/dsh-ssh.json` | 是（面板增删改） |
| OpenSSH 配置（回退） | `~/.ssh/config` | 否（只读） |

与存储同名的主机以存储为准，列表里也只出现一次（呈现为存储条目）。
存储文件读不懂时按空列表降级（不阻塞 `~/.ssh/config` 的主机），但**编辑**
时会明确报错，避免把读不懂的内容覆盖掉。

## 存储格式

`dsh-ssh.json` 是共享格式（`{ "version": 1, "hosts": [...] }`），DSH 的 SSH
工具链共用这一份主机列表。插件写入时保留顶层与条目里**不认识的字段**；
写入是原子的（暂存文件 + rename）。

条目字段：

| 字段 | 含义 |
| --- | --- |
| `alias` | 别名（用于 `ssh://` 与工具参数） |
| `host` / `port` / `user` | 连接目标；默认端口 22 |
| `auth` | `{ kind: "key" \| "password" \| "agent", keyPath?, passphrase?, password?, agentPath? }` |
| `description` / `tags` | 备注与标签（`ssh_workspace_hosts` 可搜索） |
| `proxyJump` | 非空时解析明确拒绝（见下） |
| `createdAt` / `updatedAt` | 时间戳 |

## ~/.ssh/config 回退

只解析**具体的 `Host` 块**（含通配符的块忽略），读取 `hostname` / `port` /
`user` / `identityfile`（`%d` 展开为家目录）/ `password` / `identityagent`，
同键按 OpenSSH 的 first-wins 规则。`Include` / `Match` / 通配符块会被跳过
而不是猜着解析——目标是「够用的回退」，不是完整解析器。

## 认证与凭据

- 密码与私钥口令按共享格式**明文**保存在 `dsh-ssh.json`；
- **不会回传到浏览器**——面板编辑时密码/口令字段永远为空，留空表示保持原值；
- 切换认证方式（key ↔ password ↔ agent）时无法把旧凭据带过去，必须当场填新凭据；
- key 认证在主机的 keyPath 不存在时，主机列表会给出 `keyReady: false`
  提示（`check-key`）。

## 面板管理

「远程工作区」面板可添加 / 编辑 / 删除主机（写回 `dsh-ssh.json`）。
改动立即生效：对应别名的旧连接会被丢弃，下一次操作按新配置重连。
删除主机**不会**自动卸载已挂载的远端工作区，但那些工作区会因主机不存在
而无法访问。

## 不支持的连接方式

`proxyJump` / `ProxyCommand`（存储字段或 `~/.ssh/config` 里的
`ProxyJump` / `ProxyCommand`）：解析时**明确拒绝**并说明原因，而不是静默
按直连去试。需要跳板时请改用别的工具连接。

## 相关

- [ui.md](./ui.md)
- [troubleshooting.md](./troubleshooting.md)
