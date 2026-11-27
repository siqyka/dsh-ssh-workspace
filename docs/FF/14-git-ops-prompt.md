# FF/14 · 远端 Git 操作闭环（stage / unstage / discard / commit）

> 状态：待实施。优先级 **P0**。复杂度：中高（约 4–5 天）。前置：无；建议排在 [FF/13](./13-capture-file-before-after-prompt.md) 之后（两者都动「变更请求」面板）。对应问题：无（新能力）。

## 背景

「变更请求」tab 下半的「最近提交」历史条（`lib/engine/git-history.js` + `lib/client/client.history.js`）是**刻意只读**的：固定 argv、`-z` 解析、工作目录只来自宿主 Session 记录。远端仓库因此能「看」不能「提交」——用户要暂存或提交必须切到终端。本地工作区由宿主自己的面板完成这一步，远端没有对等物。

## 目标

在历史条旁为远端工作区提供四个操作：**stage**（`git add`）、**unstage**（`git restore --staged`）、**discard**（`git restore`）、**commit**。全部经 `ctx.subprocess` 走已接管的 git 桥，argv 完全由代码构造。本轮**只做面板**，不新增 agent 工具。

## 复用

- `lib/engine/git-history.js`：固定 argv、超时（15 s）与终止契约（TERM → 2 s → 丢弃连接）、`notRepository` 作为成功答案的口径。
- `lib/patch/patch-subprocess.js`：git 白名单、`unwrapSandboxArgv`、scratch 镜像——`cwd` 为 `ssh://` 时 git 自动落远端，本地工作区自动落本机，**一处代码两套工作区**。
- `lib/core/mode-gate.js`：`writeModeRefusal` / `workspaceWriteScopeRefusal` / `assertRemoteCommandAllowed`。
- `lib/surface/tools.js` 的确认策略：`destructive` 规则集已含 `git checkout --` / `git reset --hard`；discard 的确认可复用其 `approval.request` 形状（面板侧走 HTTP，不复用工具代码，但文案与理由保持一致）。
- `lib/report/capabilities.js`：`git` 缺失时的安装提示。
- `lib/engine/command-log.js`：审计通道。

## 改造

1. **新模块 `lib/engine/git-ops.js`**
   - 操作枚举：`stage | unstage | discard | commit`；每个操作映射到固定 argv 模板：
     - `git --no-pager add -- <paths…>`
     - `git --no-pager restore --staged -- <paths…>`
     - `git --no-pager restore -- <paths…>`
     - `git --no-pager commit -m <message>`（**单文件 message 作为单个 argv**，不过 shell、不拼文件）
   - 路径参数：`normalizeRemotePath` 后必须落在该会话工作区根内（直接调用 `workspaceWriteScopeRefusal` 拿同一份答案），否则拒绝；数量上限 500，单个长度上限沿用 `MAX_NAME_LENGTH` 的口径。
   - message：去首尾空白、长度 1–500、允许换行、拒绝只含 `--` 开头的畸形值。
   - 超时 30 s；退出码非零 → 把 stderr 最后一行（截断 500 字符）作为 `detail` 返回，不抛到路由层。
2. **权限**：四个操作在 `read-only` 会话一律拒绝（文案与 `mode-gate.js` 一致，带出路）；`discard` 额外要求请求体带 `confirm: true`，且在 `rules` 确认策略命中 `destructive` 时要求二次确认标记。
3. **审计**：`channel: 'git'`，记录 `subcommand`、路径数量、是否 `refused`；stdout/stderr 不记。
4. **路由** `POST /api/dsh-ssh-workspace/git/ops`（走 `guard()` + JSON content-type），body `{ sessionId, op, paths[], message?, confirm? }`；工作目录只从宿主 Session 记录取（`workingDirectory` → header cwd），**不接受请求里的 path 作为 cwd**。
5. **客户端**：`client.history.js` 的历史条上方加一行工具条；四个按钮按 `/status` 的能力与模式置灰并带 `title` 理由；成功后就地刷新历史条与变更列表。
6. **能力**：远端无 git → 四个按钮 disabled，`title` 带 `capabilities` 表的安装提示。

## 实施步骤

1. `tests/git-ops-smoke.mjs`（纯逻辑）：argv 形状、路径围栏（越界 / 符号链接 / 停用工作区 / 另一主机根）、`read-only` 拒绝、message 校验、超时与终止。
2. `tests/routes-smoke.mjs` 加路由用例：415（非 JSON）、403（非回环）、409（停用 / 无 git）、200 形状。
3. 面板接线；`client-history` 相关套件加按钮与禁用态断言。
4. 真机：stage → commit → 历史条出现新提交；discard 后文件恢复；`read-only` 会话四类操作全拒。
5. 反向验证 ≥ 3 处；`npm run check` 全绿。

## 约束

- 不暴露 `push` / `reset --hard` / `clean` / `rebase`——保持「只读历史 + 四个最小写操作」的安全姿态。
- 不在远端 shell 里拼命令字符串；argv 数组直通 `ctx.subprocess`。
- commit 失败若是 `user.name/email` 缺失，错误文案要点明「在远端配置 git identity」，不得静默用默认值。
- 面板操作是**用户自己的动作**，不过模式闸门之外的 agent 策略；但 `read-only` 是会话属性，必须尊重。

## 验收标准

- 远端工作区可完成 stage → commit → 历史条立即出现新提交。
- `read-only` 会话四类操作全部被拒且文案说明出路。
- argv 中不出现任何未校验的用户文本（套件用带空格、引号、`;` 的路径与 message 验证）。
- 无 git 时按钮 disabled 并带安装提示；无仓库时 commit 返回 `notRepository: true` 而非 500。
- `npm run check` 全绿；CHANGELOG「新增」一条；`docs/features.md`「三、远端执行」加行；`docs/ui.md` 历史条一节扩展。

## 风险

- `discard` 不可逆：二次确认 + 审计是底线；不要在 UI 上把它放在 stage 旁边（误点）。
- 宿主变更面板自己也会在本地工作区提供类似按钮——要确认远端分支下宿主的那组按钮不出现或被遮蔽，否则两张脸（参考 08 的判定：同一手势只留一种长相）。
