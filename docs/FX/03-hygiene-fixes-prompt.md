# FX/03 · 两处小修：能力表文案 + 路由层依赖方向（P5 + P9）

> 状态：待实施。优先级 P2（近期顺手做）。复杂度：低（合计约半天）。前置：无。
> 两件事互不相关，各一个提交。

## P5 — `KNOWN_UNSUPPORTED.remoteforward` 文案已过时

**问题。** `lib/report/report.js` 的 `KNOWN_UNSUPPORTED` 对 ssh_config 关键字 `remoteforward` 写的是：

> `reverse tunnels are not supported`

但 0.4.0 起插件已有 `ssh_workspace_reverse_forward`（`lib/surface/tools.js`），也支持从面板开反向映射。真实情况是：**插件不解析 `~/.ssh/config` 里的 `RemoteForward` 行**，但反向隧道本身是支持的。自检报告（`ssh_workspace_hosts` 的 `unsupported` 字段与面板）会把这句谎话念给用户。

**修法。** 把 `detail` 改成与 `localforward` 同一口径：

```
remoteforward: { verdict: 'lost', detail: 'the RemoteForward line in this file is not applied; open reverse tunnels from the panel or the ssh_workspace_reverse_forward tool' }
```

不改 `verdict`（`lost` 仍准确：那一行确实没生效）。

**验收。** `tests/ssh-config-smoke.mjs` 或 `capabilities-smoke.mjs` 里若有钉住旧文案的断言，一并改；新增一条断言：`verdictFor('remoteforward').detail` 不含 "not supported" 字样，且提到 `ssh_workspace_reverse_forward`。反向验证：改回旧文案 → 红。

## P9 — `routes.js` 从引擎模块导入工具函数

**问题。** `lib/routes/routes.js` 顶部：

```js
import { shellQuote } from '../engine/engine.js'
```

而 `shellQuote` 的定义在 `lib/core/shared.js`，`engine.js` 只是从那里 import 后被外部转引。后果不是功能性的，是依赖方向：路由层（`routes/`）本应只依赖 `core/` 与各 surface，现在却因为一个字符串工具而**加载整个引擎模块**——引擎模块在求值期就 `requirePeer('ssh2', { kind: 'dependency' })`，并把 `HostStore`、`ReconnectScheduler`、审计等全部拉进来。`tests/` 里凡是只想测路由的套件，都被迫需要 peer stub 树能提供 `ssh2`。

同类转引若还有（例如 `routes/*.js` 从 `engine.js` 导入其它 `core/shared.js` 的名字），一并改。

**修法。** `routes.js` 与其它 `routes/*.js` 改为 `from '../core/shared.js'`；`engine.js` 是否继续 re-export 由 `scripts/lint.mjs` 之外的一个 grep 守卫决定——建议在 `scripts/lint.mjs` 里加一条：`lib/routes/**` 不得 import `lib/engine/engine.js`（`engine` 的导出类型 `SshWorkspaceEngine` 以外的任何名字都算违规），把这次的修正钉住。

**验收。** 新增 lint 规则对当前树通过；人为在 `routes/hosts.js` 加一行 `import { shellQuote } from '../engine/engine.js'` → `npm run lint` 红并指出文件。`routes-smoke` 在**不提供 ssh2 stub** 的最小 peer 树下仍能跑（这是本次修正的真正收益，用一个 SKIP 条件的放宽数来证明）。

## 收尾

- CHANGELOG「修复」两条（各自一句话：原来坏在哪、现在怎么样）。
- `docs/development.md` 若列了 lint 规则清单，加一行新规则。
- `npm run check` 全绿。
