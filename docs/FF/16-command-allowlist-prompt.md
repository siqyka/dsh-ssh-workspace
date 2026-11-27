# FF/16 · 命令确认策略 v2：允许清单 + 会话级记忆

> 状态：待实施。优先级 **P1**。复杂度：中（约 3 天）。前置：无。对应问题：[FX P11](../FX/README.md)。

## 背景

`lib/surface/tools.js` 底部的确认策略有三个模式：`off`（默认）/ `all` / `rules`。`rules` 是**子串 + 不锚定正则**的浅匹配（`'rm -rf'`、`'sudo'`、`(^|\s)>\s*…`），注释自己承认 "intentionally permissive in what they catch and shallow in what they promise"。企业场景需要的是中间态：「这台主机只允许跑只读/构建类命令，其余逐条确认」——现在没有，只能 `all` 或 `off`。

## 目标

在 `off / all / rules` 之上增加 **`allowlist`** 模式：

- 按主机配置一组**结构化规则**（`argv[0] + 子命令`，如 `git status`、`npm test`、`ls`），命中直接放行并审计；
- 未命中 → 按 `rules` 的三组规则判定是否弹确认；
- 确认框提供「本会话内不再询问此规则」，写回**会话级临时表**（不落盘，会话结束即失效）。

默认值仍为 `off`，不改。

## 复用

- `tools.js`：`needsConfirmation` / `matchRule` / `RULE_SETS` / `normalizePolicy` / `approval.request` 的形状与 fail-closed 语义。
- `lib/hosts/store.js`：主机文档节（新增 `commandPolicy`，与 `forwards` / `passthrough` 同一条 store 通道，保留未知字段）。
- `lib/engine/command-log.js`：审计记录加 `policy` 命中信息。
- 面板「设置」tab（`client.panel.js`）：加一个规则编辑器。

## 改造

1. **规则形状**：`{ program: 'git', subcommand?: 'status' | 'log' | 'diff' … }`，大小写不敏感，`program` 不允许是解释器（`sh` / `bash` / `zsh` / `python*` / `node` / `perl` / `eval` / `xargs`），否则等于关掉策略。
2. **tokenizer**：`tokenizeCommand(text)` 做**保守切分**——识别 `;`、`&&`、`||`、`|`、`&` 为分隔，识别单/双引号但不做变量展开。切分后每一段独立过规则；**任一段未命中即整条不命中**（`git status; rm -rf x` 必须被拒）。解释器形态（段首为 `sh -c` 等）一律不命中。
3. **模式归一化**：`normalizePolicy` 加 `allowlist`；`rules` 为空或全是非法名 → 回落 `off`（沿用现有「不做成匹配空集」原则）。
4. **会话级记忆**：`tools.js` 内 `Map<sessionId, Set<ruleKey>>`，`approval` 返回 `allow-for-session` 时写入；`ctx.on('session/…')` 的销毁事件里删。
5. **审计**：命中 allowlist 的记录 `policy: 'allowlist', rule: <key>`；会话级放行的记录 `policy: 'session-remembered'`。
6. **路由与面板**：`GET/POST /hosts/...` 的主机文档已带 `commandPolicy`；设置 tab 加「每主机允许清单」编辑器（一行一条，`program [subcommand]`），保存即生效、无需重启。
7. **系统提示**：`announceToAgent` 段落加一句「本会话启用了允许清单，未命中的命令会弹确认」。

## 实施步骤

1. `tests/command-policy-smoke.mjs`（纯逻辑）：tokenizer 用例（引号、`;`、`|`、`$(...)`、换行）、解释器拒绝、多段全命中才放行、`normalizePolicy` 回落。
2. `tests/command-approval-smoke.mjs` 扩展：allowlist 命中不弹框、未命中弹框、会话级记忆第二次不弹、`read-only` 会话仍被 `mode-gate` 拒绝。
3. 路由 + 面板 + 文案（`client.locale.js` 两条语言）。
4. 真机：对一台主机配 `git status`，跑 `git status` 不弹、`git status; rm x` 弹、`read-only` 拒。
5. 反向验证 ≥ 3 处；`npm run check` 全绿。

## 约束

- **这是提示，不是沙箱**：文案、文档、系统提示三处都要继续写明；不得因为引入 allowlist 而弱化 `mode-gate`。
- 解释器一律不进清单，包括 `env`、`nice`、`time`、`nohup` 这类前缀命令——它们后面跟的才是真命令，要递归剥前缀后再判。
- 会话级记忆只在内存；不写 store、不跨会话。
- 默认 `off` 不变；现有 `rules` 用户升级零感知。

## 验收标准

- `allowlist` 模式下 `git status` 直接执行并出现在审计（`policy: 'allowlist'`）。
- `git status; rm -rf x`、`sh -c "git status"`、`bash git status`（伪造）均不被 allowlist 放行。
- 勾选「本会话不再询问」后第二次同规则不弹；换会话重新弹。
- `read-only` 会话在任何策略下都被 `mode-gate` 拒绝（策略与模式无关）。
- `npm run check` 全绿；CHANGELOG；`docs/features.md`「命令执行」一节加「确认策略」；`docs/ui.md` 设置 tab 加节；`SECURITY.md` 加一句边界声明。

## 风险

- tokenizer 越聪明越危险：本轮只做分隔符切分，不做 shell 语义解析；任何解析不了的形态按「不命中」处理（fail-closed）。
- 每主机清单与全局策略并存时的优先级要在文档里写清：**主机清单 > 全局 `rules` > 全局 `all`**；无主机清单时回落全局。
