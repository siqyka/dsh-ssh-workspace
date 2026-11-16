# 浏览器终端（侧边栏 terminal）卡死：诊断与修复

> 一句话定位：`RemoteTerminalHandle.resize()` 在等一个 **ssh2 永远不会调用**的回调
> （`Channel.setWindow(rows, cols, height, width)` 根本没有 callback 参数），于是这个
> promise 永远 pending；而宿主 `dsh-api-terminal-controller` 把**该终端的每一个操作**
> （输出广播、屏幕写入、键盘输入、resize）都串在**同一条 `enqueue()` 链**上，
> 一个不落地的 promise 就把它整条链钉死——屏幕不再更新、按键不再被确认（无回显、
> 无报错）、之后的每次 attach 都拿不到 `snapshot`（面板永远「正在连接」）、
> `close()` 也永远不返回。

- 状态：已修复（2026-11-15）
- 影响面：**所有 `ssh://` 远程工作区的浏览器终端**（侧边栏 terminal / `dsh-api-terminal-controller`）；
  `terminal_open`/`terminal_send` 工具路径不受影响（它不经过那条操作队列，也不发 resize）
- 上游基线：`@shiqyka/dsh-ssh-workspace` v0.3.3（`0cd4caf`）；宿主 `@deepseek-ai/dsh` 0.2.2-rc.1
- 相关：[upstream-workaround-pattern.md](./upstream-workaround-pattern.md)（退役模式）

## 1. 现象（三个看似无关的报障，同一个根因）

| # | 用户看到 | 实际状态 |
| - | -------- | -------- |
| 1 | 终端空白，敲不进命令 | `attach` 的 `snapshot` 之后所有帧停摆；`writable` 仍为 true，但按键没有 ack |
| 2 | 能看到远端提示符，**输入任何字符都没反应**（无回显、无报错） | 远端输出（banner/提示符）在 resize 之前已经广播出去，之后的写命令排在卡死的 resize 后面，`consumeInput` 再也没轮到它 |
| 3 | 面板一直「正在连接…」 | 重新 attach 卡在 `BrowserTerminal.attach()` 的 `await this.enqueue(...)`，**连 `snapshot` 都发不出来，也不报错** |
| 附 | 关掉终端标签页后，该终端再也打不开（`terminal/unavailable` / 已在 list 里但 attach 说「closed」） | `close()` 卡在同一处：`closeProcess()` 等 `drained`，而 `drained`（`consume()`）正卡在队列里 → `owner.closedIds` 已写、`owner.terminals` 没删 |

## 2. 证据：用 WebSocket 直接按浏览器的顺序打 RPC

宿主的 Remote 端点：`POST /api/<namespace>/<method>`（unary）与
`WS /api/remote.mux`（stream），协议见
`dsh-api-gateway/lib/client.browser.js`（`open`/`item`/`end`/`cancel` 帧）
与 `dsh-client-connection/lib/client.browser.js`（`client-request` 信封）。
认证：`GET /?token=…` 换 `dsh-auth-<authority>` cookie，之后 `/api` 与 mux 都认这个 cookie。

复现脚本在 `/tmp/ws-resize-probe.mjs`（本页的日志即它跑出来的），步骤严格照抄浏览器：
`terminal/create` → `terminal/attach`（stream，读 `snapshot`/`output`）→
`{type:"resize"}` → `{type:"write"}` → 再开一条 `terminal/attach`。

```
0.26s <- terminal/attach #1 {"type":"snapshot", …, "writable":true, …}
2.21s <- terminal/attach #2 {"type":"output","sequence":1,"data":"\r\n\r\n"}
2.21s <- terminal/attach #3 {"type":"output",… "Welcome to 5.10.0-…"}      ← 输出链路正常
3.76s after resize: acks=[] stateFrames=0                                  ← resize 永远没有 ack
5.76s after write:  acks=[] echoed=false totalOutputFrames=2               ← 写也没被处理，输出也不再增加
8.26s attach#2: snapshot=false error=undefined -> stalled=true             ← 第二次 attach 连 snapshot 都没有
13.46s close -> "TIMEOUT"                                                  ← close 也卡住
```

同一时刻远端进程还活着（`ps` 能看到 `sh -l`），通道也没有 close —— 所以这不是
「PTY 死了」，而是**宿主里那条操作链死了**。

## 3. 根因：两个 ssh2 契约细节，插件都按「有回调」写了

`node_modules/ssh2/lib/Channel.js`：

```js
// ① 没有 callback 参数，返回 undefined —— 它永远不回报任何东西
setWindow(rows, cols, height, width) { … this._client._protocol.windowChange(…) }

// ② 通道不是 open 时，回调被「丢掉」而不是报错
_write(data, encoding, cb) {
  …
  if (outgoing.state !== 'open')
    return;            // ← cb 永远不会被调用
  …
  cb();
}
```

补丁前的 `lib/patch-terminal.js`：

```js
async resize (cols, rows) {
  await new Promise((resolve, reject) => {
    this.channel.setWindow(rows, cols, 0, 0, (error) => { … })   // ① 回调永不触发
  })
}
```

而宿主侧（`dsh-api-terminal-controller/lib/index.js`）把一切都串行化：

```js
enqueue(operation) { const pending = this.operations.then(operation); this.operations = pending.catch(() => {}); return pending }

// attach：拿 snapshot 也要排这条队
const baseline = await this.enqueue(() => { … return snapshot })
// 输出：每个 chunk 都排这条队
async output(data) { … await this.enqueue(async () => { await new Promise(r => this.screen.write(data, r)); … }) }
// 输入：写/改尺寸也排这条队
consumeInput: await this.enqueue(async () => { … await this.handle.write(...) / await this.handle.resize(...) })
```

于是 `resize` 的 promise 一 pending：`operations` 链断在这里，
后面排队的 snapshot / output / write 全部永不执行——**一个 promise 钉死整个终端**，
而且**不产生任何错误**（这正是「无回显、无报错」的来源）。

为什么只有浏览器终端中招：浏览器 xterm 挂载后 `FitAddon.proposeDimensions()` 会立刻发一次
`resize`（`TerminalScreen` 的 `ResizeObserver` + `fitScreen`），所以每次 attach 后几十毫秒内
必然触发；`terminal_open` / `terminal_send` 工具路径根本不发 resize，因此一直是好的。
这也解释了「pty 探针、handle 探针、xterm 探针全都正常」——它们都没走 resize。

### 3.1 同一个契约缺口的第三处：关闭

`handle.terminate()` 是宿主清理链上唯一被 await 的调用，之后它等输出流结束：

```js
closeProcess() { … await this.handle.terminate(); await this.drained; … }
```

补丁前的 `terminate()` 只 `channel.close()` 就返回，而 `output.end()`/`done` 要等
ssh2 的 `'close'` 事件——**该事件只在对端确认 CHANNEL_CLOSE 时才发出**
（`emitClose: false`，由客户端在收到对端 CLOSE 时手动 emit）。
对端安静时：`closeProcess()` 永久 pending → `owner.closedIds` 已写入、`owner.terminals`
没删除 → 这个终端 id 既不能 attach（`Terminal was closed in this Session`）
也不能重新 create（`requireOpen` 抛），远端 `sh -l` 还留着（取证时看到一个跑了 2 小时的）。
若此时 `consume()` 又正好卡在上面那条队列里（情况 3 的现场），`drained` 也永远不会结束——
两条根因会互相加固。

## 4. 修复（只动插件，不动官方包）

`lib/patch-terminal.js`：

1. **`resize()` 改为 fire-and-forget**：`setWindow(rows, cols, 0, 0)`（无回调、不 await）；
   通道已不是 `open` 时直接跳过并 trace；`setWindow` 抛错也只降级为一条日志
   （窗口尺寸是幂等建议值，不该让附件失败）。**永不返回 pending 的 promise**。
2. **`write()` 先验通道状态**：`channel.outgoing.state !== 'open'` 时**拒绝**
   （`terminal channel is no longer open`），而不是 await 一个会被 ssh2 丢弃的回调。
   这既避免了同一条队列被钉死，也让「接受不了」变成可见错误。
3. **`terminate()` 自己结算**：`channel.close()` 之后立刻 `output.end()` + `done`
   resolve(`{exitCode:null, signal:null}`)，不再等对端确认；再给对端 250ms 宽限，
   仍未确认就本地 `channel.destroy()` 释放 ssh2 的通道记录。
   宿主清理链因此必然收敛，`owner.closedIds`/`owner.terminals` 不会再分叉。
4. **失败不再 `output.destroy(error)`**：改为 `output.end()` + `done` reject。
   否则在「还没有读者」的窗口期（分配失败路径会在 emulator 存在前 terminate）
   PassThrough 的 `'error'` 事件会掀掉整个宿主进程；同时给 `done` 挂一个空 catch，
   避免没人监听时的 unhandled rejection 同样致命。失败信息仍在 `done` 上，语义不变。
5. **加 trace（写同一个 `/tmp/ssh-workspace-terminal.log`，`DSH_SSH_WORKSPACE_TRACE=0` 可关）**：
   `write`（长度、mode-gate 放行/拒绝+原因、通道状态）、`resize`（是否发出）、
   `terminate`（**调用栈**，用来区分「abort / 显式 close / 通道自身关闭」）、
   `#onClose`/`#fail`、以及 `spec.signal` abort 的调用栈。

## 5. 回归测试

新增 `tests/browser-terminal-smoke.mjs`（27 项）。它用**忠实复制 ssh2 契约**的假通道
（`setWindow` 无回调、`write` 在非 open 时丢弃回调、`close()` 不 emit `'close'`），
而不是旧套件里那个「主动调用回调」的宽松替身——正是那个宽松替身让这个 bug 一直绿着：

- resize 在「对端什么都不回」时也必须落地；
- 按控制器的串行队列复现 `resize → write → 下一个操作`，三者全部落地且字节到达通道；
- 通道非 open 时 `write` **抛错而不是挂起**；
- 对端不确认 close 时 `terminate()` 仍结算 `output`/`done`、释放 hold，并在宽限后本地 destroy；
- 对端确认 close 时**不**被额外 destroy，真实退出码仍由 close 事件给出；
- terminate 之后的 `write` 被拒、`resize` 静默落地；通道 `'error'` 只 reject `done`，不炸宿主。

## 6. 怎么验证（用户侧）

**必须重启 `dsh-web`**：插件是进程内 `link:` 加载的，`lib/` 里改的东西不重启不生效；
而且当前宿主进程里已经卡死的那些终端（操作链已断、`closedIds` 已写）也只有重启才能清掉。

重启后：

1. 打开远程工作区会话 → 侧边栏终端：应立刻出现提示符，**能输入、有回显**；
2. 拖大/拖小右侧栏（触发 resize）→ 输入仍然正常，`stty size` 跟着变；
3. 关掉终端标签页再开一个 → 新终端可用；
4. 想确认没有残留：`ssh <alias> 'ps -eo pid,tty,etime,cmd | grep "sh -l"'`，
   关闭终端后不应留下新的 `sh -l`；
5. 若要再看 trace：`tail -f /tmp/ssh-workspace-terminal.log`，
   正常的一次 attach 应能看到 `resize … sent=true` 与随后的 `write … accepted=true`。

宿主机上的 RPC 复核（无需浏览器，改完即可跑）：

```
COOKIE='dsh-auth-…=v1.…' SID=session-… node /tmp/ws-resize-probe.mjs
# 期望：after resize: acks=[{sequence:1}] / after write: echoed=true /
#       attach#2: snapshot=true / close 正常返回 ok
```

## 7. 剩余风险

- `resize` 变成 fire-and-forget 后，**窗口变更的失败不可见**（只有 trace/日志）。
  窗口尺寸是建议值，宿主也会同步自己的 emulator 尺寸，判断为可接受；
  ssh2 侧 `setWindow` 唯一会抛的情况是「server 模式」，实际不会发生。
- `terminate()` 不再等对端确认：远端进程是否真的退出由 sshd 的 SIGHUP 保证，
  但「本地已结算、远端还在跑」的窗口（≤250ms + 远端退出时间）理论上存在；
  宽限后的 `destroy()` 会打断通道，足以让远端 pty 收到 HUP。
- 上游 `ssh2` 若改变 `setWindow`/`_write` 的契约，本补丁的第 1、2 条就不再必要
  （但也不会错）。退役判据：`@shiqyka/dsh-ssh-workspace` 上游若把 resize 改成
  fire-and-forget 并给 write 加状态前置检查，即可删除这处修复的对应片段。
