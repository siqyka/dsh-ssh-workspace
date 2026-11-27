# FF/19 · 非 POSIX 远端主机（Windows OpenSSH）

> 状态：待实施。优先级 **P3**。复杂度：高（约 1.5–2 周）。前置：[FX/01](../FX/01-seam-contract-prompt.md)（方言探测位）、建议在 [FF/18](./18-watch-backends-prompt.md) 之后。对应问题：无（新能力）。

## 背景

插件对远端的全部假设都是 POSIX：

| 假设 | 位置 |
| --- | --- |
| 登录 shell 是 `sh` / `bash` 家族，`sh -l` 可用 | `lib/surface/shell.js` 的 `DEFAULT_SHELL_CANDIDATES`、`lib/patch/patch-terminal.js` |
| 目录列举用 `ls -1ap` + `awk`，`pwd -P`，`test -w` | `lib/routes/entries.js` 的 `dirsListingCommand` |
| 能力探测用 `command -v` | `lib/engine/engine.js` 的 `probeCapabilities` |
| 命令组装 `export …; cd '<path>' && <cmd>` | `lib/patch/patch-shell.js` |
| 变更监视 `inotifywait` | `lib/fs/remote-watch.js` |
| 传输校验 `sha256sum` / `shasum` / `openssl` | `lib/transfer/transfer-rules.js` 的 `REMOTE_HASHERS` |

`patch-terminal.js` 已经对 `pwsh` / `powershell` / `cmd` 做了「只有在主机报告过时才可启动」的方言判断，说明作者考虑过这个方向但没展开。企业内网的 Windows Server（OpenSSH）今天是完全不可用的。

## 目标（**刻意收窄**）

只做三件事：**挂载 + 列目录 + 开 `pwsh` 终端**，外加 read / write 正常。watch、git、传输校验在 Windows 远端**不承诺**，面板如实标「不支持」。

## 复用

- `lib/report/capabilities.js` 的 `RemoteEnvironment`（已采集登录 shell / locale）：加 `os: 'posix' | 'windows'`。
- `lib/patch/patch-terminal.js` 的方言判断与白名单。
- `lib/surface/shell.js` 候选表里的 `pwsh` 与 `-NoLogo` 参数。
- `lib/routes/entries.js`：`dirsListingCommand` 已有「形状不符一律回退 SFTP」的兜底——Windows 远端直接走 SFTP 列目录即可，不必写 PowerShell 版。

## 改造

1. **OS 探测**：`probeCapabilities` 的脚本开头加一次 `uname -s 2>/dev/null || echo Windows`（Windows OpenSSH 的默认 shell 可能是 cmd 或 pwsh，脚本本身要能在 `sh` 不存在时不挂——探测失败按 `unknown`，不按 `posix`）。结果进 `environments`，经 `/status` 下发。
2. **方言层** `lib/core/dialect.js`：`{ isPosix(env), shellCommand(cmd), quotePath(p), existsTool(name) }`，先只放 POSIX 与 PowerShell 两个实现。
3. **接入点**（只改这三处）：
   - `patch-shell.js` 的命令组装：Windows 用 `pwsh -NoLogo -NonInteractive -Command "<cmd>"`，`cd` 用 `Set-Location -LiteralPath`；
   - `patch-terminal.js`：`os === 'windows'` 时默认启动 `pwsh -NoLogo`（无需探测过）；
   - `entries.js`：`os === 'windows'` 时跳过 `dirsListingCommand` 快路径，直接 SFTP `readdir`。
4. **系统提示**：`SSH_WORKSPACE_GUIDANCE` 按 `os` 下发不同段落（Windows 远端写 PowerShell 语法）。
5. **面板**：主机卡片显示 OS 徽标；watch / git / 校验在 Windows 远端置灰并带 `title` 理由。
6. **能力探测**：`command -v` 在 Windows 远端改用 `Get-Command -ErrorAction SilentlyContinue`；或者直接把 rg / git / inotifywait / sha256sum 标为 `unknown` 并说明原因——二选一，任务书实施者按真机结果定。

## 实施步骤

1. `tests/dialect-smoke.mjs`：两个实现的 `shellCommand` / `quotePath` 输出（含带空格、中文、`'` 的路径）。
2. fake-ssh 提供 Windows 应答（`uname` 失败、`Get-Command` 输出），`remote-shells-smoke` / `terminal-smoke` 加 Windows 用例。
3. 真机 Windows Server + OpenSSH：挂载 → 列目录 → `read` / `write` → 开 `pwsh` 终端 → 跑 `Get-ChildItem`。
4. Linux 回归：全部既有套件绿，系统提示不变。
5. `npm run check` 全绿。

## 约束

- **不做** watch / git / 打包传输 / 增量传输的 Windows 版；面板如实标「不支持」，不静默。
- 不在远端安装任何东西。
- `SFTP` 路径在 Windows OpenSSH 下是 `/C:/Users/...` 形态——路径协议（`lib/core/protocol.js`）是否接受这种拼写要先确认，必要时只在显示层处理。
- 范围蔓延守门：任何「顺便把 git 也支持一下」的改动另开任务书。

## 验收标准

- Windows 远端可挂载、可列目录、可开 `pwsh` 终端、`read` / `write` 正常、`bash` 工具的命令在远端以 PowerShell 语义执行。
- Linux 远端行为逐字节不变；系统提示对两类主机下发不同段落。
- 能力报告对 Windows 主机不出现 `rg: absent` 误报（要么探测正确，要么 `unknown` 带原因）。
- `npm run check` 全绿；CHANGELOG；`docs/features.md`「十、明确的边界」改写「远端主机需为 POSIX」相关行；`docs/hosts.md` 加 Windows 主机一节；`README` 两个语言版本各一句。

## 风险

- Windows OpenSSH 的默认 shell 可能在注册表里配置（`DefaultShell`），`sh -l` 可能可用也可能不可用——探测必须对两种情况都诚实。
- 路径拼写（盘符、反斜杠、大小写不敏感）是最大的坑；本轮只保证 SFTP 路径按 OpenSSH 的 `/C:/…` 形态工作。
