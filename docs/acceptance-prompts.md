# 验收 Prompt：dsh-ssh-workspace 权限围栏三项决定

> 把本文件整段（或下面的「给 Agent 的指令」一节）交给一个运行在 DSH 里、工作区为 `ssh://` 远端的 Agent 会话执行。
> 每条用例给出：**操作 → 必须看到的结果 → 通过判据**。判据全部用远端**实际效果**核验，不看工具自述。

---

## 给 Agent 的指令（可直接粘贴）

你是验收执行者。本插件的远端写权限围栏刚做了三项行为变更，你要在**真实远端主机**上逐条核验它们是否生效。

规则：
1. 每跑一条用例，先记录「我切换到了哪个沙箱模式」和「会话工作区根是什么」，再执行操作。
2. 判定「是否写入成功」**一律用远端文件系统的实际状态**（`read` 文件内容、或 `glob` 文件是否存在），不要只凭工具返回值下结论。
3. 判定「是否被拒」要**同时贴出错误码**（如 `FS_SANDBOX_DENIED`）和**完整拒绝文案**。
4. 任何一条与「期望」不符，标记 `FAIL` 并写出实际观察到的内容；不要猜测原因后继续。
5. 全部跑完，输出一张 `编号 / 期望 / 实际 / PASS|FAIL` 的表，再给一句总结论。

前置：把下面 `{{...}}` 占位符换成真实值再执行。需要一个**与 `{{ALIAS}}` 不同的、也已挂载的主机别名** `{{OTHER_ALIAS}}`。

### 关于「错误码」的说明（先读再判定）

两条写路径的拒绝**呈现形态不同**，判定时别搞错：

| 路径 | 拒绝如何呈现 |
| --- | --- |
| `write` / `edit`（宿主路由） | **抛出** `FsError`，能看到 `FS_SANDBOX_DENIED` / `FS_OUTSIDE_WORKSPACE` / `FS_PERMISSION_DENIED` 错误码 |
| `ssh_workspace_transfer` 上传（工具层） | **返回** `{ok:false, error:"<文案>"}` 文本，**不带错误码**（刻意的：这样宿主不会追加「切换沙箱模式」的升权提示） |

因此：**A 组以文案为准判定**，`FS_OUTSIDE_WORKSPACE` 等错误码只在 B/D 组（走 `write`/`edit`）核对。
另有一条通用反证：无论哪条路径，判定「写入是否发生」一律看远端落盘结果。

### 围栏顺序（多条围栏同时适用时，哪条先说话）

```
停用(detach) → 模式(mode) → 范围(scope) → 挂载根(词法) → 挂载根(realpath)
```

- `workspace-write` 写一个**未挂载且根外**的路径：先命中**范围**围栏（`file access denied under workspace-write mode`），**不会**走到挂载围栏——这是正确行为，别当成 BUG。
- 只有 `danger-full-access` 才跳过范围围栏、暴露挂载围栏。
- 动词陷阱：**挂载词法围栏的文案固定是 `cannot write ...`**，即使触发它的是上传；`cannot upload ...` 只出现在模式围栏和 realpath 逃逸围栏里。核对文案时以实际动词为准。

### 占位符

- `{{ALIAS}}`：本会话所在远端主机别名（如 `qiyk`）
- `{{SESSION_ROOT}}`：本会话工作区，如 `ssh://{{ALIAS}}/home/{{USER}}/test`
- `{{INSIDE}}`：会话根内一个可写文件，如 `{{SESSION_ROOT}}/probe.txt`
- `{{SIBLING}}`：同一主机、会话根**之外**的已挂载路径，如 `ssh://{{ALIAS}}/home/{{USER}}/other-probe.txt`（需另一已挂载根或根父目录下的文件）
- `{{TMPFILE}}`：`ssh://{{ALIAS}}/tmp/dsh-accept-probe.txt`
- `{{OUTSIDE_UNMOUNTED}}`：同主机、**未挂载**的路径，如 `ssh://{{ALIAS}}/etc/dsh-accept-should-not-exist.txt`
- `{{OTHER_HOST}}`：`ssh://{{OTHER_ALIAS}}/{{USER}}/accept-probe.txt`（另一台主机上的路径）

---

## A 组 — 决定①：上传**不允许**越出挂载根

> 工具：`ssh_workspace_transfer`，`direction: "upload"`。这是新加的两道围栏（挂载根 + realpath）。

### A1 上传到会话根内 —— 应成功
操作：`upload` → `{{INSIDE}}`
期望：`{"ok":true}`；随后 `read {{INSIDE}}` 能看到源文件内容。

### A2 上传到同主机会话根外的已挂载路径 —— `workspace-write` 下应被拒
切到 `workspace-write`，会话根为 `{{SESSION_ROOT}}`。
操作：`upload` → `{{SIBLING}}`
期望（文本形态，无错误码）：
`cannot write "{{SIBLING}}": file access denied under workspace-write mode — the session workspace is "{{SESSION_ROOT}}", and workspace-write only permits writing inside it. Switch this session to danger-full-access for paths elsewhere on the host — but only a path that is also inside a MOUNTED workspace becomes writable then; ...`
**判据**：证明上传与 `write` 走的是**同一条范围规则**（`workspaceWriteScopeRefusal`）——把同一路径改用 `write` 试一次，两者拒绝理由必须一致。
补充：若 `{{SIBLING}}` 其实未挂载，则应先命中 A3 的挂载围栏；此时换一个确实已挂载的兄弟根再测 A2。

### A3 上传到**未挂载**路径 —— 任何模式都应被拒（决定①核心）
切到 `danger-full-access`（最宽模式，验证「更宽也拦不住越界」）。
操作：`upload` → `{{OUTSIDE_UNMOUNTED}}`
期望：错误码 `FS_OUTSIDE_WORKSPACE`，文案为
`cannot upload "{{OUTSIDE_UNMOUNTED}}": outside every mounted remote workspace (mount it first with ssh_workspace_mount)`。
**判据**：错误码**不是** `FS_SANDBOX_DENIED`——这条是挂载围栏，不是模式拒绝，宿主不会给它追加「切换沙箱模式」的升权提示（升权对未挂载目录无效）。
反证判据：`glob {{OUTSIDE_UNMOUNTED}}` 必须**不存在**——即围栏在经 SFTP 写出任何字节之前就拦下。

### A4 跨主机上传 —— `danger-full-access` 下若未挂载仍被拒
切到 `danger-full-access`。
操作：`upload` → `{{OTHER_HOST}}`（且 `{{OTHER_ALIAS}}` 上**没有**覆盖该路径的挂载根）
期望：`FS_OUTSIDE_WORKSPACE` + `outside every mounted remote workspace (mount it first with ssh_workspace_mount)`（挂载围栏，先于一切）。

### A5 递归上传先建越界目录 —— 应被拒且不落空目录
切到 `danger-full-access`。
操作：`upload` `recursive: true`，远端目标为 `{{OUTSIDE_UNMOUNTED}}.dir/sub`
期望：被拒；`glob` 确认 `{{OUTSIDE_UNMOUNTED}}.dir` **没有被创建**（每个创建的目录都判定，空树也不先落下越界空目录）。

---

## B 组 — 决定②：`/tmp` **放进**可写集合

> 只对**已有挂载根的主机**放宽；什么都没挂的主机仍不可达。

### B1 `workspace-write` 写 `/tmp` —— 应成功
切到 `workspace-write`，会话根为 `{{SESSION_ROOT}}`（`/tmp` 在根外）。
操作：`write` → `{{TMPFILE}}`，内容 `tmp-probe`
期望：通过；`read {{TMPFILE}}` 得 `tmp-probe`。

### B2 `workspace-write` 写他机 `/tmp` —— 应被拒（别名先行）
操作：`write` → `ssh://{{OTHER_ALIAS}}/tmp/x.txt`
期望：`FS_SANDBOX_DENIED`，文案含 `this session's workspace is on host "{{ALIAS}}", not on "{{OTHER_ALIAS}}"`。
（`/tmp` 放宽只对会话所在主机生效。）

### B3 上传到同主机 `/tmp` —— 应成功（走 writeFenceRoots）
切到 `workspace-write`。
操作：`upload` → `{{TMPFILE}}2`（`/tmp` 下）
期望：`{"ok":true}`。

### B4 什么都没挂的主机，其 `/tmp` —— 仍不可达
操作：对一个**没有任何已挂载根**的主机别名 `upload`/`write` 其 `/tmp/y.txt`
期望：拒绝（先挂载这一条没放松）。

### B5 `danger-full-access` 写 `/tmp` —— 应成功（一并受益）
操作：`write` → `{{TMPFILE}}3`
期望：通过。

---

## C 组 — 决定③：未知模式按 containment 收紧

> 未知模式 = 不在 `{read-only, workspace-write, danger-full-access}` 之列，且非空串。
> `undefined` / `null` / `""` 是「策略服务缺席」= 不受限，仍放行——这条也要测。

### C1 未知模式写文件 —— 应被拒
把会话模式置为一个无法识别的值（通过测试夹具或 `sandbox_permissions` 传入非法值触发；若 GUI 只能选三种，用单测形态验证）。
期望文案：
```
the session sandbox mode is "<未知值>", which this plugin does not recognise — ... the local sandbox treats any mode outside {read-only, workspace-write, danger-full-access} as the strictest answer. This is not a mode you can switch to fix it; set the session to one of the three recognised modes.
```
错误码：`FS_SANDBOX_DENIED`。
**判据**：文案**不谎称 `read-only`**，且明确列出三个被认可模式。

### C2 未知模式跑远端命令 —— 应被拒（命令面最严）
操作：`ssh_workspace_exec { alias: "{{ALIAS}}", command: "echo hi" }`
期望：拒绝文案
`cannot run a remote command on ssh://{{ALIAS}}: the session sandbox mode is "<未知值>", which this plugin does not recognise — ... the local sandbox confines any mode outside {read-only, workspace-write, danger-full-access} rather than treating it as full access. Set the session to one of the three recognised modes. Reading still works through read / glob / grep / ops_*.
**判据**：命令**未到达主机**（远端没有 `dsh` 进程痕迹；`echo` 的输出不出现）；且若改用 `ssh_workspace_shell` / 远端终端，同样被拒（同一 `assertRemoteCommandAllowed`）。

### C3 空串 / 缺失策略 —— 放行（不受限，非拒绝）
操作：在无 sandbox policy 的形态下 `write` 会话根内文件、`exec` 命令
期望：**通过**（`undefined`/`null`/`""` = 未受限，与本地一致）。

---

## D 组 — 文案归因（P1：范围拒绝不再指向死路）

### D1 根外路径的拒绝文案含「挂载」出路提示
切到 `workspace-write`，操作：`write` → `{{SIBLING}}`
期望：拒绝文案里包含 `but only a path that is also inside a MOUNTED workspace becomes writable then; if this one is not mounted, switching will not help (mount it with ssh_workspace_mount).`
**判据**：验证模型不会被引向一条「切 `danger-full-access` 后仍撞挂载围栏」的死路。

### D2 `read-only` 拒绝的文案指向「切模式」
切到 `read-only`，操作：`write` → `{{INSIDE}}`
期望：`cannot write "{{INSIDE}}": file access denied under read-only mode`；错误码 `FS_SANDBOX_DENIED`；SFTP **触碰次数为 0**（在任何 I/O 之前判定）。

---

## 快速回归（可选，若配了 `DSH_WS_TEST_ALIAS`）

```bash
node tests/run.mjs                 # 期望 44/44 套件、1782 项断言全绿（裸检出：38 运行 / 6 SKIP）
DSH_CORE_ROOT=<assembled 树> node tests/run.mjs   # 期望含 tool-schemas / mode-gate / transfer / routes
```

真机 live-smoke 应包含新断言：**写 `/tmp` 成功** + **`/etc` 拒 `FS_OUTSIDE_WORKSPACE`**。

---

## 结果表模板

| 编号 | 期望 | 实际（错误码 + 关键文案 / 落盘效果） | 结论 |
|---|---|---|---|
| A1 | ok + 落盘 | | |
| A2 | FS_SANDBOX_DENIED + inside it | | |
| A3 | FS_OUTSIDE_WORKSPACE + 文件不存在 | | |
| A4 | FS_OUTSIDE_WORKSPACE | | |
| A5 | 拒绝 + 目录未创建 | | |
| B1 | 通过 + /tmp 可读 | | |
| B2 | FS_SANDBOX_DENIED + host ... not on ... | | |
| B3 | ok | | |
| B4 | 拒绝 | | |
| B5 | 通过 | | |
| C1 | FS_SANDBOX_DENIED + 不谎称 read-only | | |
| C2 | 命令拒绝 + Reading still works | | |
| C3 | 通过 | | |
| D1 | 文案含「not mounted switching will not help」 | | |
| D2 | FS_SANDBOX_DENIED + SFTP 0 次 | | |

**总结论**：三项决定 A/B/C 是否全部生效 + D 文案是否正确归因。任一 FAIL 需附实际观察，不得以「可能是环境问题」略过。
