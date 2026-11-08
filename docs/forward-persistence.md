# 端口转发的持久化

> 一句话定位：把「远端端口映射到本机」从**一次性动作**变成**可保存、可开关、可选择开机自动恢复**的配置项。

相关：[architecture.md](./architecture.md)（连接模型）、[tools.md](./tools.md)（`ssh_workspace_forward`）、[features.md](./features.md)（停用 / 注销语义）。

---

## 一、要解决的问题

隧道本身的生命周期是**对的**，但用户意图的生命周期**不对**。

`ForwardManager` 的转发表是纯内存的（`lib/forward.js` 的 `this.forwards = new Map()`），并且刻意如此：一条 SSH 连接没了，骑在它上面的隧道就该一起拆掉，否则会留下一个指向死管道的 listener。

问题是用户不是这么想的。他为远端 dev server 映射了 `5173 → 5173`，重启 DSH 后希望**这个映射还在**，而不是重新输一遍端口。

于是必须把两件事分开：

| | 存放位置 | 生命周期 | 回答的问题 |
| --- | --- | --- | --- |
| **意图** | `dsh-ssh.json` 的 `forwards` 分区 | 持久 | 用户想要哪个映射、要不要开 |
| **事实** | `ForwardManager` 的内存表 | 随连接 | 现在有没有 listener 在监听 |

面板渲染两者的 join。这是整套设计的地基。

---

## 二、数据模型

`$DSH_HOME/dsh-ssh.json` 新增一个分区，与 `hosts` / `knownHosts` / `secrets` 并列：

```jsonc
{
  "forwards": {
    "settings": { "autoStart": false },
    "items": [
      {
        "id": "fwd-a1b2c3d4",        // 随机 id，不是进程内自增
        "alias": "qiyk",
        "remoteHost": "127.0.0.1",
        "remotePort": 5173,
        "localHost": "127.0.0.1",
        "localPort": 5173,
        "enabled": true,             // 用户意图
        "createdAt": 1792250000000
      }
    ]
  }
}
```

### 为什么 id 是随机的

原有运行时 id 是 `fwd-${counter}`（进程内自增）。这个 store 是**多个 DSH 实例共享**的，自增计数器会在不同进程间撞车。所以已存映射用 `randomBytes(4)` 生成 8 位十六进制。

### 为什么必须记 `localPort`

这是整份实现里最容易做错的一处。

原有的 `open()` 在没给 `localPort` 时，会先试远端同号，撞 `EADDRINUSE` 就**静默回退到内核分配的临时端口**。对一次性隧道这是友好行为；对**已存映射是错的**：

> 用户存的是 `5173 → 5173`，实际绑到 51234，存下来的 URL 就永久失真了。

所以已存映射走严格模式（`strictLocalPort: true`），端口被占用就报错，绝不漂移。相应地，`localPort` 为 0 的条目在读取时会被丢弃（`normalizeForwardEntry`）——0 是「随便给我一个」，不是一个可以持久化的事实。

---

## 三、按钮语义

**按钮文案由「事实」决定，不由「意图」决定。**

| 实际（listener） | 意图（`enabled`） | 按钮 | 说明 |
| --- | --- | --- | --- |
| 在监听 | — | **断开** | 附活跃连接数 |
| 没在监听 | true | **开启** | 若上次失败，行内显示原因 |
| 没在监听 | false | **开启** | 正常关闭状态 |
| 临时隧道（agent 开的，无存储记录） | — | **关闭** + **记住** | 记住 = 存成已存映射 |

反过来做（按钮跟 `enabled` 走）会出问题：重启后 listener 还没建立，`enabled` 仍是 true，按钮就显示「断开」——但并没有可断开的东西。那是谎报。

同理，一个「意图开、实际关」的行代表**隧道自己掉了**（连接断开）。此时行内显示「连接已断开」，而按钮仍是「开启」——用户看到的是一个可以点回来修复的状态，不是一个假装正常的按钮。

---

## 四、端口预检

新增 `probeLocalPort(host, port)`：临时 `createServer().listen()`，观察错误码。

| 错误码 | 提示 |
| --- | --- |
| `EADDRINUSE` | 本地端口 5173 已被占用 |
| `EACCES` | 本地端口不可绑定（被系统保留或权限不足） |
| `EADDRNOTAVAIL` | 本地地址不存在 |

### 预检是建议性的，不是权威的

预检关闭自己的 listener 与真正 bind 之间存在一个窗口（TOCTOU）。所以：

- 预检只负责**把报错说清楚**，省掉用户猜「为什么失败」
- **权威仍然是 bind 本身**：`open()` 仍然捕获 `EADDRINUSE` / `EACCES` 并给出可读错误
- 两条路都必须处理，不能只靠预检

UI 在输入框 `blur` 时触发预检，不是每次按键——每次按键都会真的 bind 一次 listener，既刷屏也抢跑用户的输入。

### 保存前先预检

`SavedForwardManager.create()` 在**写 store 之前**跑一次预检。端口被占用就抛错，条目根本不落盘。

为什么：如果一个不能绑定的映射被存下来，面板会长期显示一条 URL 永远打不开的记录，而下次自动启动还会在同一个错误上再失败一次。用户已经看见一次失败了，不该让它变成持久状态。

但保存之后、bind 之前仍可能被抢占。这条路径由 `openById()` 兜住：记录 `failures`，行仍存在并显示原因，用户可以重试而不必重输映射。

---

## 五、启动自动开启

### 优先级

```
settings.autoStart（UI 写入，运行时真相）
```

没有 config 覆盖层。`cordis.patch.yml` 不参与这个开关——它是用户偏好，不是部署策略。

### 时序

在 `apply()` 里用 `setTimeout(…, 0)` 排到下一轮，不在 `install()` 里跑（那时 `fs` 可能还没到）。

**绝不能让自动启动拖垮插件启动**：

- 整段包在 try/catch 里，任何失败只记日志
- 逐条**串行**开启（同一主机的多条隧道共用一个连接池，并发握手既慢又难归因）
- 失败的条目写进 `failures`，面板可见

单条失败不影响其余条目，整体不抛错。一个主机不可达不该让整个插件启动失败。

### 幂等

`open()` 已有的按 `(alias, remoteHost, remotePort)` 去重对自动启动不够用——它返回的是临时 id，UI 对不上。所以已存映射用**稳定 id**入表，`openById` 第二次调用会复用同一条目（测试里验证过：第二次 `autoStart` 报 `opened: 1` 但 listener 仍只有一个）。

---

## 六、连接与转发：两条方向都必须是单向的

转发与连接的关系在两个方向上都必须是**单向**的，这是本节的验收口径：

| 方向 | 规则 | 实现 |
| --- | --- | --- |
| 连接断 → 转发断 | **必须** | 主动断开走 `SavedForwardManager.closeAlias(alias)`，由 `hosts/disconnect` 路由在 `engine.forget()` 之前调用；连接意外掉线由 `ForwardManager` 自拆 |
| 转发断 → 连接断 | **绝不** | `#teardown` 只递减 `record.holds`，从不触碰 `client` |

### 连接断 → 转发断

连接自身会发 `close` 事件，`ForwardManager` 也订阅了它。但那**不是一条可靠的路径**：

- ssh2 的 client 被 `destroy()` 而不发事件时，事件不会到达；
- 连接被替换（重连、配置变更）时，旧记录上的监听器可能已无人持有；
- 测试替身通常根本不实现事件。

所以 `hosts/disconnect` 路由**先**按 alias 显式拆掉转发，再 `engine.forget()`：

```js
// 有已存映射：逐条 closeById，与端口行「断开」同一条路径
const closedForwards = savedForwards?.closeAlias?.(alias) ?? 0
// 未装配 SavedForwardManager：回退到旧路径（那时没有「意图」可关）
if (!savedForwards) forwards?.closeForAlias?.(alias, 'SSH connection closed')
engine.forget(alias)
```

返回值里的 `closedForwards` 让调用方能验证「断开确实带走了隧道」，而不是只能相信它发生了。

### 转发断 → 连接断

反向不成立，而且是**构造上**不成立：`#teardown` 只做三件事——关闭 listener、销毁 socket、递减 `record.holds`。它没有任何路径可以关闭 `client`。

这一条有测试守着，因为两个动作碰的是同一条 record，未来一次「顺手复用」的重构就可能把方向接反，而那种错误是静默的：关掉一个隧道会连带掐断整台主机的连接。

### 转发开启 → 连接建立

第三条相关规则：**开转发时若该主机未连接，就先连接**。`open()` 的第一步就是 `await this.engine.acquire(target)`，`acquire` 在池里没有可用记录时自行拨号。所以「开端口」本身就是一次连接动作。

对应的反向仍然成立：`close()` 不调用 `acquire`。

### 连接断开之后的留痕

连接一断，`ForwardManager` 整批拆除（`#teardownWhere(entry => entry.record === record)`），`closeForAlias` 是同一件事的显式版本。此时会出现「意图开、实际关」。

`ForwardManager` 新增 `onClosed` 回调，由 `SavedForwardManager.noteClosed()` 消费，把原因记进 `failures`。

只对两种原因留痕：

| 原因 | 是否留痕 | 为什么 |
| --- | --- | --- |
| `SSH connection closed` | ✅ | 连接意外掉线，用户没主动关，需要解释 |
| `plugin unloaded` | ✅ | 插件重载，重启后会按意图恢复 |
| 用户主动关闭（`closed by caller`） | ❌ | 用户知道自己做了什么，不需要「错误」提示 |

### 主动断开主机 ≠ 连接掉线

同一个「隧道没了」，两种成因必须落在**同一种行状态**上的一半，另一种必须分开：

| 触发 | 走的路径 | `enabled` | `failures` | 面板 |
| --- | --- | --- | --- | --- |
| 主机面板「断开」 | `SavedForwardManager.closeAlias(alias)` | `false` | 清除 | 已断开 + 开启，无红字 |
| 端口行「断开」 | `closeById(id)` | `false` | 清除 | 同上 |
| 连接意外掉线 | `ForwardManager.closeForAlias()` → `onClosed` | `true` | 记录 | 已断开 + 开启 **+ 红字「连接已断开」** |

前两行必须逐字段相同：用户点了「断开」却看到「连接已断开」的红字，等于把一次成功的操作报成故障，还会连带显示「启动时自动开启隧道」的提示——那条提示暗示隧道会在下次启动时自己回来，而用户刚刚明确关掉了它。

路由因此分岔：`hosts/disconnect` 优先走 `savedForwards.closeAlias(alias)`，只有未装配 `SavedForwardManager` 时才回退到 `closeForAlias()`。回退分支保留旧行为不是遗漏——那时没有已存映射的概念，也就没有「意图」可以关。

`closeAlias` 内部逐条调用 `closeById`，而不是自己写一遍关闭逻辑：两条路径若各写一次，就会在某个字段上悄悄分家，而分家的地方恰好是用户能看见的那一行。

自动重连**没有**实现。理由：自动重开会造成「用户以为关了，其实又开了」的意外流量。当前的语义是「显示原因，等用户点开启」，这是可预测的。

---

## 七、代码落点

| 文件 | 职责 |
| --- | --- |
| `lib/store.js` | `forwards` 分区的读写（`forwardsOf` / `putForward` / `deleteForward` / `setForwardEnabled` / `setForwardAutoStart`），全部走既有的 `withFileLock` |
| `lib/forward.js` | `open()` 支持稳定 `id` 与 `strictLocalPort`；导出 `probeLocalPort`、`joinForwards`；`onClosed` 钩子 |
| `lib/forward-persist.js` | `SavedForwardManager`：意图与事实的协调层 |
| `lib/routes.js` | 6 条新路由 + `/status` 增加 `forwardRows` / `forwardSettings` |
| `lib/index.js` | 装配 + 启动自动开启 |
| `lib/client.js` | 转发区重做（状态 chip、开关、删除二次确认、自动开启复选框、端口预检提示） |

### 路由

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/forward/save` | POST | 新建已存映射（可选立即开启） |
| `/forward/toggle` | POST | 按 `enabled` 开启或断开 |
| `/forward/delete` | POST | 忘记一条映射（先关 listener） |
| `/forward/remember` | POST | 把临时隧道存成映射 |
| `/forward/probe` | GET | 本地端口预检 |
| `/forward/settings` | POST | 存 `autoStart` |

原有的 `/forward` 与 `/unforward` **保留**：agent 工具仍在用它们开一次性隧道。

### `remember` 的一个细节

`remember` 不能只写一条记录——那样同一个隧道会在面板里出现两行（临时 id 一行、已存 id 一行）。正确做法是：

1. 用**实际绑定的端口**（不是用户没给的那个）写入 store
2. 关掉临时 listener
3. 用已存 id 重新 open

测试里验证了「记住后只剩一行」和「端口是实际绑定值」这两条。

---

## 八、测试

新增 `tests/forward-persist-smoke.mjs`，102 项断言，覆盖：

- store 分区的往返、原地更新、删除、与 `hosts` / `secrets` / 外来分区共存
- 损坏条目的降级（缺 localPort、端口 0、缺 id 都丢弃，不抛错）
- 端口预检三态
- create / open / close / remove 全链路，含字节真的穿过隧道
- **占用端口被拒绝且不落盘**；保存后 bind 失败仍留痕
- 自动开启：偏好关闭时不动、只开意图为开的、幂等、失败不抛错
- 连接断开：标记非 live、保留意图、留下原因、重开清除原因
- **主动断开主机与端口行「断开」逐字段一致**（`live` / `enabled` / `error` 三元组相同，见 §六）
- `remember` 保留实际端口、不产生重复行
- join 的意图/事实分离

另有 `tests/forward-smoke.mjs`（34 项，既有）覆盖隧道本身。

---

## 九、已知限制

1. **没有自动重连。** 连接断开后需要手动点开启（或重启 + autoStart）。这是有意的保守选择。
2. **预检与 bind 之间有竞态。** 预检说空闲、bind 仍可能失败，两条路都处理了。
3. **已存映射不支持 `localPort: 0`。** 这是设计：存「随便一个端口」没有意义。
4. **只在 Windows 本机验证过。** 端口预检的错误码在 Linux/macOS 上可能多出几种（如 `EADDRNOTAVAIL`），未逐一实测。
5. **未上真机。** 所有断言基于真实的本地 TCP，但远端侧用的是 `forwardOut` 替身；真实 SSH 隧道仍属 `live` 套件（需 `DSH_WS_TEST_ALIAS`）。
