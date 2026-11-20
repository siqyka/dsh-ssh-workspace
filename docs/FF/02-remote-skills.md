# FF-02 远端 Skills 发现（带权限控制）

> 状态：**已实施**（`lib/remote-skills.js`，`tests/remote-skills-smoke.mjs` 53 项）· 2026-11-20 · 任务书见 [02-remote-skills-prompt.md](./02-remote-skills-prompt.md)
> 这一辑回答：**远端仓库里的 `.agents/skills` 怎么进模型上下文**、**凭什么相信它**、**怎么在不可信内容
> 与「接管 ctx.fs」之间划清边界**。

## 0. 一句话目标

让远程工作区里的 `<root>/.dsh/skills` 与 `<root>/.agents/skills` 像本地一样被发现、被 `skill` 工具加载，
但**默认关闭、按主机白名单开启、路径必须落在已挂载的远程根内、内容按不可信输入处理**。

## 1. 为什么这件事对本项目特别划算

本项目已经接管了 `ctx.fs`（`lib/patch-fs.js` 把 14 个方法装成 own property，`ssh://` 目标走 SFTP）。
宿主的 skill 发现链路（`@deepseek-ai/dsh-skill-filesystem`）在解析技能文件时优先走
**`ctx.get('fs')`**：

```js
function optionalFileSystem(ctx) { return ctx.get("fs") }
async function readSkillText(ctx, path, signal, trustedHost = false) {
  const fs = optionalFileSystem(ctx)
  if (fs !== void 0 && !trustedHost) return await readSkillTextFromFileSystem(ctx, fs, path, signal)
  // 否则退回 node:fs
}
```

也就是说：**只要把 `ssh://host/path` 这样的根喂进去，读取会自动经过我们的补丁**。不需要另写一套
SFTP 读取，也不需要复制宿主的 frontmatter 解析。这是本项目相对「自带工具集」路线最大的结构优势。

## 2. 宿主契约（已从 asar 核对，直接照做）

### 2.1 注册

`ctx.skills.registerProvider(create)`，`create` 是**同步**工厂，拿到 `{ signal, invalidate }`：

```js
registerProvider(create) {
  const lifecycle = new AbortController()
  const control = { signal: lifecycle.signal, invalidate: () => { /* 让目录缓存失效 */ } }
  provider = create(control)          // 同步，不能 await
  // provider.name 必须唯一，且不能是 RUNTIME_PROVIDER 那个保留名
}
```

要点：

- **同步注册，异步发现**。远端连接不能在 `apply` 里等，只能等到 `list()` 被调用时才拨号/复用连接。
- 注册发生在 `apply` 里，随 fiber 销毁自动注销；`signal` 在销毁时 abort，任何挂起的发现必须响应它。
- 返回值是 Cordis effect disposer，复合 effect 要 yield 它以保证销毁顺序。

### 2.2 provider 接口

```js
{
  name: 'ssh-workspace-remote-skills',
  async list(options) {           // options: { scope, cwd, signal }
    return { candidates: [...], complete: true }   // 也可以直接返回数组
  },
  async get(candidate) { return candidate.locator } // 加载正文
}
```

`list()` 的返回值两种形状都接受：候选数组，或 `{ candidates, complete }`。
**`complete: false` 的观察不会被缓存**——这正是「远端暂时连不上」应有的语义：保留上次的好结果，
下次请求边界再试，而不是把「没连上」缓存成「没有技能」。

### 2.3 候选形状（照抄 `dsh-skill-filesystem` 的 `discoverRoot`）

```js
{
  name,                    // 必须匹配 isSkillName，否则宿主 warn 后丢弃
  description,             // 必填，空则丢弃
  whenToUse,               // 可选
  invocation,              // { modelInvocable, userInvocable }
  provider: '<我们的 name>',
  source: 'remote',        // 显示用的来源标签
  rank,                    // 见 §4
  locator: { path: '<root>/x/SKILL.md', directory: '<root>/x' },
  resourceBase: { kind: 'directory', path: locator.directory },
  path,
  metadata,                // 可选
}
```

发现规则（与本地一致，别自创）：

- 目录项 → `<dir>/SKILL.md`；平铺 `.md` 文件 → 文件本身。
- 其他类型（软链、其他后缀）跳过。
- frontmatter 缺 `name` 或 `description` → `logger.warn` 后丢弃，不报错。
- 名字非法 → warn 后丢弃。

## 3. 权限控制（本辑的重点）

远端技能 = **由远端主机内容决定的、会进系统提示词的文本**。它和「远端文件内容」不是同一类风险：
文件内容要模型主动去读，技能描述**默认就会被拼进上下文**。因此按下面五层设防，缺一层都不许上线。

### 3.1 第一层：默认关闭，按主机显式开启

配置形状（写进 `~/.dsh/...` 的插件配置，不进 workspace）：

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

- `enabled` 默认 `false`：不开启时 `list()` 直接返回 `{ candidates: [], complete: true }`，
  连目录都不列——不列目录就不会泄露「远端有哪些目录」。
- 只有 `hosts` 里点名的别名才生效。**不允许通配符 `*`**：通配会让「连上一台新主机」等于
  「自动信任它的提示词」。
- `roots` 是**相对工作区根**的路径，且必须经过 §3.3 的围栏校验。

### 3.2 第二层：只读已挂载的根

发现只在**当前会话已挂载的远程工作区根**之下进行：

- 根来自 `ctx.get('fs')` 里该会话的 workspace root，不是用户随手写的路径；
- 每个候选路径必须过 `isWithinRemoteRoots(roots, parts)`（`lib/remote-fs.js:1988`）；
- 读取正文前再过一次 `assertFencedRealpath`（`lib/remote-fs.js:2082`）——防软链把
  `<root>/.agents/skills/x` 指到 `/etc`。
- 会话的 mode 由 `sessionModeOf`（`lib/mode-gate.js:151`）判定；只读会话照样可以**发现**技能
  （发现是读操作），但任何「写入 / 缓存到远端」的动作都必须先过 `writeModeRefusal`
  （`lib/mode-gate.js:120`）。

### 3.3 第三层：有界

| 上限 | 建议默认 | 理由 |
| --- | --- | --- |
| 每个根列出的条目数 | 200 | 与 `LS_MAX_LIMIT` 一致，避免目录巨大时卡死 |
| 候选技能数 | 32 | 技能目录会进系统提示词，无上限等于让远端决定上下文大小 |
| 单个 SKILL.md 字节数 | 64 KiB | 超过就跳过并记一条诊断，不截断（截断的 frontmatter 会解析失败） |
| 发现超时 | 5 s | 超时按 `complete: false` 返回，不阻塞会话 |
| 缓存 TTL | 5 min | 只失效不轮询；不在后台定时拨号 |

### 3.4 第四层：内容按不可信处理

- **不执行任何东西**。技能正文只是文本；`resourceBase` 指向的文件由模型按需读取，
  读取同样走 `ctx.fs`（因此同样过围栏）。
- **名字与描述不参与路径拼接**。宿主用 `locator` 定位，我们不要根据 `name` 拼路径。
- **诊断里不写正文**。`lib/audit.js` 记录「发现了几条、来自哪个根、跳过几条及原因」，
  不记录 frontmatter 内容。
- **不进 `system` 的固定前缀**：远端技能排在本地之后（§4 的 rank），保证本地技能同名优先。

### 3.5 第五层：可见与可撤销

- 面板里显示「远端技能：N 条（来自 baseframecs）」；关闭开关立刻 `control.invalidate()`，
  下一次 `list()` 返回空。
- 每次发现写一条诊断（沿用 `lib/diagnostics.js` 的环形缓冲），用户能看到「哪台主机、
  哪个根、几条、跳过了几条」。
- 断连时返回 `complete: false` + 上一次的好结果；**不许**把断连写成「0 条技能」，
  否则用户会以为技能被删了。

## 4. rank 取值

宿主的层与 rank（`~/.dsh/AGENTS.md` 与 `dsh-skill` 一致）：

| 层 | 路径 | rank |
| --- | --- | --- |
| 项目级 | `<项目根>/.dsh/skills` | 100 |
| 项目级 | `<项目根>/.agents/skills` | 200 |
| 自定义 | `customSkillDirs` | 300 |
| 用户级 | `~/.dsh/skills` | 400 |
| 用户级 | `~/.agents/skills` | 500 |
| 内置 | `app.asar` | 600 |

远端技能建议 **rank 250**：低于本地项目级的两档（同名的本地项目技能赢），高于用户级
（远端工作区自带的约定应当压过全局约定）。这个数字要在方案评审时确认一次，
因为它决定「同名时谁赢」，而这件事**没有第二次机会**——用户只会看到最终生效的那一条。

## 5. 与 `AGENTS.md` 的关系

远端 `AGENTS.md` 是同一类需求（远端约定进上下文），但风险更高：它是**常驻**指令段。
本辑**不做** AGENTS.md，理由：

- 技能是「按需加载」（目录 + 描述进上下文，正文靠 `skill` 工具取），AGENTS.md 是常驻；
- 常驻内容一旦被远端控制，等于把提示词注入面长期打开；
- 先做技能，把开关、围栏、上限、诊断这四件套跑熟，再考虑 AGENTS.md 是否需要同样的开关。

## 6. 验收标准

| # | 判据 |
| --- | --- |
| 1 | `remoteSkills.enabled=false`（默认）时，`list()` 不发起任何 SSH 请求（用 fake-ssh-server 的连接计数断言） |
| 2 | 未在 `hosts` 里点名的主机，即使已连接也返回 0 条 |
| 3 | 软链逃逸（`<root>/.agents/skills/evil` → `/etc`）被 `assertFencedRealpath` 拒绝，且诊断里有一条 |
| 4 | 超过 `maxSkills` / `maxBytes` 的条目被跳过而不是截断，诊断里计数正确 |
| 5 | 断连时返回 `complete: false` 且保留上次结果；恢复后不重复拨号 |
| 6 | 关闭开关后下一次 `list()` 立即为空（`invalidate` 生效） |
| 7 | 本地同名技能仍然生效（rank 250 低于 100/200），并有断言证明 |
| 8 | 审计与诊断里不出现技能正文 |
| 9 | 裸检出（无真主机）上，用 `fake-sftp` 就能跑通「发现 → 加载」全链路 |

## 7. 不做什么

- **不做远端 `AGENTS.md`**（见 §5）。
- **不做远端技能自动安装 / 自动更新**：只发现，不写远端。
- **不做跨主机的技能聚合**：一次只用当前会话那台主机，避免「A 主机的技能在 B 主机上生效」。
- **不给远端技能提升权限**：技能不能改变 mode、不能绕过写围栏。
