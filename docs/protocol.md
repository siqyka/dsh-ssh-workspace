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
远端工作区之内，越界返回 `FS_SANDBOX_DENIED`；**读取不受限**。

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
