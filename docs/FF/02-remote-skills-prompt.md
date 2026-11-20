# 任务书：远端 Skills 发现（带权限控制）

> 本文件是一次性任务书，交给一个**新的 Agent 会话**执行：读完之后直接改代码，不需要重新调研。
> 实现与验收通过后删除本文件，并同时移除 [README.md](./README.md) 里对应的一行索引。
> 背景与取舍见 [02-remote-skills.md](./02-remote-skills.md)。

## 0. 一句话目标

让远程工作区里的 `<root>/.dsh/skills` 与 `<root>/.agents/skills` 被发现并可加载，
**默认关闭、按主机白名单开启、路径过围栏、内容按不可信处理、有界、可撤销**。

## 1. 关键前提（已从 asar 核对，不要重新推导）

宿主的 `@deepseek-ai/dsh-skill-filesystem` 在解析技能文件时**优先走 `ctx.get('fs')`**：

```js
function optionalFileSystem(ctx) { return ctx.get("fs") }
async function readSkillText(ctx, path, signal, trustedHost = false) {
  const fs = optionalFileSystem(ctx)
  if (fs !== void 0 && !trustedHost) return await readSkillTextFromFileSystem(ctx, fs, path, signal)
  // 否则退回 node:fs
}
```

本项目已经通过 `lib/patch-fs.js` 接管了 `ctx.fs`（`REMOTE_METHODS` 见 `lib/patch-fs.js:22-38`），
所以**不需要另写一套 SFTP 读取**：把 `ssh://host/path` 作为根的 `path` 喂给发现逻辑即可。

注册面：

```js
ctx.skills.registerProvider(({ signal, invalidate }) => ({
  name: 'ssh-workspace-remote-skills',
  async list(options) { return { candidates, complete } },
  async get(candidate) { return candidate.locator },
}))
```

- `create` 是**同步**工厂，不能 `await`；远端初始化只能放在 `list()` 里。
- `signal` 在插件销毁时 abort，挂起的发现必须响应。
- `list()` 可返回数组或 `{ candidates, complete }`；**`complete: false` 不会被缓存**
  ——断连时用它保留上次结果，不要返回空数组。

## 2. 候选形状（照抄宿主的 `discoverRoot`）

```js
{
  name, description, whenToUse,              // name/description 必填，缺则 warn 后丢弃
  invocation: { modelInvocable, userInvocable },
  provider: 'ssh-workspace-remote-skills',
  source: 'remote',
  rank: 250,
  locator: { path: '<root>/x/SKILL.md', directory: '<root>/x' },
  resourceBase: { kind: 'directory', path: locator.directory },
  path,
  metadata,
}
```

发现规则（与本地一致）：目录 → `<dir>/SKILL.md`；平铺 `.md` → 文件本身；其他类型跳过；
frontmatter 缺字段或名字非法 → `ctx.logger.warn` 后丢弃，**不抛错**。

## 3. 权限控制（五层，缺一层都不许合并）

### 3.1 默认关闭 + 主机白名单

配置（插件配置，不是 workspace 文件）：

```json
{
  "remoteSkills": {
    "enabled": false,
    "hosts": {
      "baseframecs": { "roots": [".dsh/skills", ".agents/skills"], "maxSkills": 32, "maxBytes": 65536 }
    }
  }
}
```

- `enabled: false` 时 `list()` **连目录都不列**，直接返回 `{ candidates: [], complete: true }`。
- `hosts` **不支持通配符**。新增一台主机不等于自动信任它。
- `roots` 是相对工作区根的路径，必须过围栏（§3.3）。

### 3.2 只用已挂载的根

- 根取自当前会话已挂载的远程工作区根，不接受用户随手写的绝对路径；
- 每个候选路径过 `isWithinRemoteRoots(roots, parts)`（`lib/remote-fs.js:1988`）；
- 读正文前过 `assertFencedRealpath(sftp, alias, remotePath, roots, options)`（`lib/remote-fs.js:2082`），
  防软链逃逸；
- 只读会话允许**发现**（读操作），任何写入/缓存到远端的动作先过 `writeModeRefusal`
  （`lib/mode-gate.js:120`）。

### 3.3 有界

| 上限 | 默认 |
| --- | --- |
| 每根列出的条目数 | 200（与 `LS_MAX_LIMIT` 一致） |
| 候选技能数 | 32 |
| 单个 SKILL.md | 64 KiB（超过则跳过并记诊断，**不截断**） |
| 发现超时 | 5 s（超时返回 `complete: false`） |
| 缓存 TTL | 5 min，只失效不轮询 |

### 3.4 内容不可信

- 不执行任何东西；正文只是文本，附属文件由模型按需读，读取同样走 `ctx.fs` 与围栏。
- **不用 `name` 拼路径**，定位一律用 `locator`。
- 审计（`lib/audit.js`）与诊断（`lib/diagnostics.js`）**不记录正文**，只记主机、根、条数、跳过原因。

### 3.5 可见可撤销

- 面板显示「远端技能：N 条（来自 <alias>）」；
- 关闭开关 → `invalidate()` → 下一次 `list()` 为空；
- 断连 → `complete: false` + 上次结果，**不许**返回 0 条。

## 4. rank = 250

本地项目级是 100 / 200，用户级是 400 / 500。远端取 250：本地项目技能同名时赢，远端压过全局用户技能。
这个数字要写进代码注释与文档，说明「同名时谁赢」。

## 5. 明确不做

- 不做远端 `AGENTS.md`（常驻提示词面，风险更高，留待本辑跑熟后再评估）；
- 不做远端技能自动安装 / 更新（只读发现）；
- 不做跨主机聚合（只用当前会话那台）；
- 技能不得改变 mode、不得绕过写围栏。

## 6. 测试要求

用 `tests/support/fake-sftp.mjs`（若尚未存在，先做 FF-01 的第 3 节）在裸检出上跑通全链路：

1. 默认关闭时**零 SSH 请求**（用 `fake-ssh-server` 的连接计数断言，不是断言返回值）；
2. 未点名的主机返回 0 条；
3. 软链逃逸被拒且诊断有记录；
4. 超限条目被跳过而非截断；
5. 断连返回 `complete: false` 且保留上次结果；
6. `invalidate()` 后下一次 `list()` 立即为空；
7. 本地同名技能仍生效；
8. 审计/诊断不含正文。

## 7. 验收

```bash
npm run lint
npm test
npm run check:docs
```

外加 [02-remote-skills.md](./02-remote-skills.md) §6 的 9 条判据逐条对照。

## 8. 完成后

1. 删除本文件与对应索引行；
2. `CHANGELOG.md` 的 `## [未发布]` 段写一条（写清「默认关闭 + 白名单 + 围栏 + 上限」）；
3. `docs/features.md` 增一节，`docs/architecture.md` 的接管点表补 `ctx.skills` 一行。
