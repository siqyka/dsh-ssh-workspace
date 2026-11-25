/**
 * DSH remote-workspace plugin — host half.
 *
 * Publishes a `ctx.fs` that serves ordinary host paths from the deployment's
 * own (sandboxed) local backend and `ssh://<alias>/<abs-path>` targets over
 * SFTP, so a folder on a remote machine can be registered as a DSH workspace
 * and used by the ordinary file tools. The Host's own builtin calls for the
 * same targets — `node:fs/promises` operations and `node:path` spellings —
 * are bridged too (see fs-shim.js), because creating a session and attaching
 * it to its workspace happen before any agent exists. Commands against a
 * remote workspace travel through the two execution seams, both patched onto
 * the live services: `ctx.shell` for the pwsh/bash tools (patch-shell.js) and
 * `ctx.subprocess` for the file tools' helpers — remote glob/grep via
 * ripgrep, and change tracking via git (patch-subprocess.js).
 *
 * Agent tools: ssh_workspace_hosts, ssh_workspace_mount, ssh_workspace_unmount,
 * ssh_workspace_status, ssh_workspace_exec, ssh_workspace_forward,
 * ssh_workspace_unforward.
 *
 * @module @shiqyka/dsh-ssh-workspace
 */

import { homedir } from 'node:os'

import { SshWorkspaceEngine } from './engine/engine.js'
import { RemoteFileSystem } from './fs/remote-fs.js'
import { buildPassthrough, hostReferencePathsInText } from './fs/passthrough.js'
import { PassthroughSettings } from './fs/passthrough.js'
import { ForwardManager, ReverseForwardManager, SavedForwardManager } from './forward/forward.js'
import { installShellDiscovery, ShellManager, uninstallShellDiscovery } from './surface/shell.js'
import { installRemoteFileSystem, uninstallRemoteFileSystem } from './patch/patch-fs.js'
import { installRemoteSandbox, uninstallRemoteSandbox } from './patch/patch-sandbox.js'
import { installRemoteShell, uninstallRemoteShell } from './patch/patch-shell.js'
import { installRemoteSubprocess, uninstallRemoteSubprocess } from './patch/patch-subprocess.js'
import { installRemotePtc, uninstallRemotePtc } from './patch/patch-ptc.js'
import { installRemoteTerminal, uninstallRemoteTerminal } from './patch/patch-terminal.js'
import { installBuiltinBridge, uninstallBuiltinBridge } from './fs/fs-shim.js'
import { installProjectionRelaxation, uninstallProjectionRelaxation } from './patch/patch-projection.js'
import { RemoteSkillsProvider } from './surface/remote-skills.js'
import { isRemotePath, parseRemotePath } from './core/protocol.js'
import { emptyOwnershipSnapshot, failureReason, makeIndexRebuilder, makeSessionHeaderReader, makeWorkspaceRepublisher, reclaimOwnership } from './surface/ownership.js'
import { workspaceTools } from './surface/tools.js'
import { makeRoutes } from './routes/routes.js'

/** Stable Cordis plugin name. */
export const name = 'ssh-workspace'

/**
 * Services required before the surfaces can mount.
 *
 * Note `fs` is deliberately NOT listed here: a profile applies its patch layer
 * after its bundles, so the filesystem backend may not exist yet at plugin
 * load. It is injected on the service BODY instead (see {@link apply}), which
 * runs as soon as the backend appears and re-runs across reloads.
 *
 * `systemPrompt` (agent guidance) is optional and read with `ctx.get()`, so a
 * deployment without it still activates. `webServer` is optional too: the HTTP
 * routes for the browser half wait for it in a second injection, so the plugin
 * is equally usable headless (agent tools only) and in the Web GUI.
 */
export const inject = ['tools']

/** Relative order of the announcement section inside the tool-guidance band. */
const SECTION_ORDER = 155

/**
 * Stop scanning stored session history for `@` references once this many are
 * known.
 *
 * The scan exists for one reason: a session restored after a restart must keep
 * working with the host paths the user already pointed at. It is not a search —
 * the matcher is a bounded list, and a profile whose history names hundreds of
 * unrelated host files gains nothing from reading all of them. The limit is
 * well below the matcher's own cap so a long history cannot spend the budget
 * before a fresh message is seen.
 */
const HOST_REFERENCE_SCAN_LIMIT = 32

/** Model-facing announcement describing the remote-workspace capability. */
export const SSH_WORKSPACE_GUIDANCE = [
  '本机已安装 dsh-ssh-workspace 插件（远程工作区）：可以把一台 SSH 主机上的目录当作 DSH 工作区使用。',
  '',
  '工作区路径语法：`ssh://<主机别名>/<远端绝对路径>`，例如 `ssh://myserver/home/user/project`。',
  '当会话工作区是这种路径时，read / write / edit 会通过 SFTP 直接读写远端文件，无需手动同步。',
  '',
  '工具：ssh_workspace_hosts（列出主机）、ssh_workspace_mount（挂载远端目录为工作区）、',
  'ssh_workspace_unmount（卸载工作区，默认 `detach` 可逆：保留工作区记录与会话，只是停用）、',
  'ssh_workspace_enable（重新启用被停用的工作区）、ssh_workspace_status（查看当前状态）、',
  'ssh_workspace_exec（在远端执行命令）、ssh_workspace_shell（在远端开持久会话，cd 与变量跨调用保留）、',
  'ssh_workspace_transfer（本机与远端之间传文件，不经对话内容）、',
  'ssh_workspace_forward / ssh_workspace_unforward（把远端端口映射到本机 / 关闭映射）。',
  '主机列表在「远程工作区」面板中管理（添加 / 编辑 / 删除），写入 $DSH_HOME/dsh-ssh.json；~/.ssh/config 为只读回退。',
  '',
  '远端工作区的能力与限制（重要）：',
  '- read / write / edit / glob / grep 都在远端生效：glob / grep 会调用远端主机上的 ripgrep（rg）搜索远端内容，',
  '  返回的是远端路径；远端未安装 rg 时会得到明确的安装提示（退出码 127）。',
  '- 工作区变更追踪（diff / 变更面板）使用远端 git，需要远端主机安装 git；未安装时该功能自动关闭。',
  '- 远端变更监视（文件树 / 预览自动刷新）优先使用远端 inotifywait 推送事件（即时、不受 mtime 精度限制）；',
  '  未安装时回退到轮询（约 2 秒一次，同一秒内等长的连续改写可能不触发刷新）。',
  '- 端口转发：ssh_workspace_forward 把远端端口映射到本机（例如远端 dev server 的 5173），返回可打开的',
  '  http://localhost:<port> 地址；映射随 SSH 连接存活，连接断开即自动关闭，可再次调用重新打开；',
  '  ssh_workspace_unforward 主动关闭并释放本地端口。注意远端应用可能有自己的 host / 回调白名单校验',
  '  （如 Vite 的 server.allowedHosts、Next 的 allowedDevOrigins、OAuth 的 redirect URI），需要一并放行 localhost。',
  '- 会话工作区是 ssh:// 时，pwsh / bash 工具的 workdir 会落到远端，命令在远端主机上以 POSIX shell（bash/sh）语义执行；',
  '  请按远端环境写命令（如 ls / cat / grep，而非 PowerShell 的 Get-ChildItem / Get-Content / Select-String）。',
  '- 远端命令不受本机文件沙箱约束，以远端登录用户的完整权限运行；本机沙箱策略（sandbox_permissions）不适用于远端命令。',
  '- 因此**会话处于「仅可查看」（read-only）时，所有远端写入与命令执行都被拒绝**：write / edit、',
  '  ssh_workspace_transfer 的上传、ssh_workspace_exec、ssh_workspace_shell、workdir 落在远端的',
  '  bash / pwsh 调用，以及 cwd 为 ssh:// 的终端（terminal_open；内建侧边栏终端同样受限），都会返回一条说明',
  '  （本机沙箱无法限制远端进程，所以只能拒绝，不能只围栏）。已经开着的远端终端在切成 read-only 后也会停止',
  '  接受输入——只有控制字节（SIGINT、关闭）例外。',
  '  读取不受影响（read / glob / grep 走 SFTP，不需要执行命令）。要执行命令，把会话切到',
  '  workspace-write 或 danger-full-access。',
  '- 文件写入另有两条围栏：必须落在已挂载的工作区根之内、或该主机的 /tmp 之下（与本地一致：本地的可写根',
  '  集合除工作区外还含 /tmp，所以远端构建能写暂存文件），越界返回 `FS_OUTSIDE_WORKSPACE`；',
  '  工作区被停用时返回 `FS_PERMISSION_DENIED`，文案带 `the remote workspace is detached`。',
  '  这两条扩展权限也解不开，先挂载 / 先启用。ssh_workspace_transfer 的上传与面板上传同样过这两条围栏，',
  '  且在任何字节发出之前判定——write 会拒绝的落点，上传同样拒绝。',
  '- workspace-write 下写入还要求落在**本会话自己的工作区**之内（与本地同一条规则）：写兄弟目录或另一台',
  '  主机的已挂载根会返回 `FS_SANDBOX_DENIED`，文案会点名会话工作区（该主机的 /tmp 除外）。命令执行做不到这一层收窄——',
  '  限制进程需要内核边界，而它跨不过 SSH——所以 workspace-write 下的远端命令仍以远端登录用户权限运行。',
  '- 被停用（unmount `detach`）的工作区对除 SSH 连接外的一切操作都被拒绝：读写、列目录、变更监视、执行命令、',
  '  开终端、glob / grep / git、传输都会失败。这是停用造成的，不是远端文件不存在；用 ssh_workspace_enable 恢复。',
  '- 端口转发的**已存映射**（面板里保存的那些）有独立的「意图」状态：连接断开时映射保留、',
  '  下次可一键重开，不会被当成故障；由 ssh_workspace_forward 临时打开的隧道则随连接消失。',
  '- 大文件读取按块流式传输（预览 / read 不会把整个文件读进内存）；写入采用「暂存文件 + 原子替换」。',
].join('\n')

/**
 * Extra model guidance appended only while local-path passthrough is enabled.
 *
 * Exported so a suite can pin the wording: this text is the only thing that
 * tells the model where passthrough stops, and a silently emptied paragraph
 * would leave it retrying a call that can never work.
 */
export const LOCAL_PASSTHROUGH_GUIDANCE = [
  '本机路径直通：聊天框上传的非图片附件保存在本机 $DSH_HOME/attachments，',
  '在 ssh:// 会话中可用本机绝对路径直接读取（read 与 node:fs），不要把它当成远端路径。',
  '用户在消息里用 `@` 显式引用的本机绝对路径同样按本机读取：Windows 盘符或 UNC（例如 `@F:\\123.txt`）',
  '一律本机；POSIX 形态（例如 `@/Volumes/SSD/a.md`）先按远端理解，远端确实不存在时才回退到本机同名文件，',
  '回退的内容末尾会附一行 `[ssh-workspace]` 说明来源。其它绝对路径仍是远端路径。',
  '',
  '要**确定**读本机而不是远端，给路径加设置里的本机 scheme 前缀（默认 `local:`），例如 `local:/Volumes/SSD/a.md`、',
  '`local:F:\\123.txt`。这个前缀是意图声明，不是路径的一部分；只有设置里启用的前缀能被直通，',
  '未启用的前缀会被明确拒绝（FS_PERMISSION_DENIED），不会悄悄变成远端路径。',
  '',
  '**直通的边界（重要）**：只覆盖经过 ctx.fs 的文件系统调用（宿主 write / edit / read_image、node:fs，',
  '以及 ops 预设下未被替换时的 read）。不经过 ctx.fs 的读取仍可能读不到——这不是直通失效，也不是授权拒绝：',
  'dsh-ops 的 inspect_local_file / read_files / glob / grep 会带着会话 cwd 启动本机子进程，cwd 是 ssh:// 时',
  '必然失败（EXECUTOR_UNAVAILABLE，文案带 only git and ripgrep；带 workdir 的 ops_bash 报 invalid workdir）。',
  'ops 预设把 read 换成了 inspect_local_file，所以那条路上的本机文件读不到，属预期。',
  '不要重试，也不要换别的本机 shell 去绕：读远端用 ssh_workspace_exec / ssh_workspace_shell，',
  '读本机文件用 ssh_workspace_transfer 上传到该主机的 /tmp 之后再读。',
].join('\n')

/**
 * Collect `@` host references from one message's text blocks.
 *
 * The Host inserts a picked `@` mention as ordinary prompt text — there is no
 * metadata on the filesystem call that says "this came from @". The message is
 * therefore the only place the user's intent survives, which is why the
 * matcher is fed from messages rather than guessing from the spelling alone.
 *
 */
function hostReferencesInMessage (message, options = {}) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return []
  const found = []
  for (const block of message.content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    found.push(...hostReferencePathsInText(block.text, options))
  }
  return found
}

/**
 * Look up a service that may not be composed in this deployment.
 *
 * Both a throwing `ctx.get(name)` and a missing property mean "absent" here:
 * session-ownership compensation depends on optional services
 * (`sessionQuery`, `sessionPersistence`), and a deployment without either must
 * degrade to "nothing to do" rather than fail activation.
 *
 * @returns {object | undefined} the service, when composed.
 */
function optionalService (ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch { /* not injected here — fall through */ }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * Record every `@` host reference already present in a live session.
 *
 * A restored session's messages were written before this plugin activated, and
 * a hot reload must not forget what the user already asked for. Re-scanning the
 * derived history is cheap (user messages only) and idempotent — the matcher
 * deduplicates.
 *
 */
function recordSessionHostReferences (passthrough, session) {
  if (typeof passthrough?.addHostReference !== 'function') return
  let messages
  try {
    messages = session?.deriveMessages?.() ?? []
  } catch {
    return
  }
  // The matcher owns both the platform rule and the live scheme name, so the
  // extractor is driven by the same values the router later applies.
  const options = { platform: passthrough.platform, scheme: passthrough.scheme }
  for (const message of messages) {
    for (const spelling of hostReferencesInMessage(message, options)) passthrough.addHostReference(spelling)
  }
}

/**
 * Mount the SSH workspace engine, the `ctx.fs` router, and the agent tools.
 *
 * @param {boolean} [config.enabled] - master switch (default true).
 * @param {string[]|false} [config.localPassthrough] - local absolute prefixes
 *   that keep their local meaning inside an `ssh://` session. Defaults to
 *   `['$DSH_HOME/attachments', '$DSH_HOME/plugins']`; `false` or `[]` disables
 *   passthrough. The whole `$DSH_HOME` root is refused because it holds the
 *   host store and SSH key.
 * @param {string} [config.localPassthroughScheme] - the scheme name that spells
 *   a host path explicitly (default `local`, e.g. `local:/Volumes/SSD/a.md`).
 *   Lowercase letters, digits, `+`, `-`, `.`; `ssh` is reserved. This is only
 *   the FIRST default — once the panel saves a value the store wins, so the
 *   profile row cannot silently override a choice the user made.
 * @param {boolean} [config.localPassthroughFallback] - whether a bare
 *   `@`-mentioned POSIX path may fall back to the host copy after the remote
 *   side reports it absent (default false). Same first-default rule as above.
 * @param {boolean} [config.allowLan] - serve the browser half to LAN clients:
 *   the HTTP routes then accept private-network remote addresses (IPv4
 *   RFC1918, IPv6 ULA/link-local) and require the `Host` header to name one of
 *   this machine's own addresses on the listening port, keeping the
 *   DNS-rebinding fence. Default false — loopback only, unchanged behaviour.
 * @param {string[]} [config.allowedHosts] - extra `Host` header values accepted
 *   beside the machine's own addresses (with `allowLan`); e.g. a LAN hostname.
 * @param {object} [config.engine] - connection tuning overrides:
 *   `idleTimeoutMs`, `connectTimeoutMs`, `keepaliveIntervalMs`,
 *   `sweepIntervalMs`, and `reconnect` (background-retry policy, or `false`);
 *   see {@link SshWorkspaceEngine}.
 */
export function apply (ctx, config = {}) {
  if (config.enabled === false) return

  // Built once per plugin activation and passed to every installed seam below;
  // a reload updates the live matcher instead of keeping stale prefixes.
  const passthrough = buildPassthrough(config.localPassthrough, {
    env: process.env,
    home: homedir(),
    scheme: config.localPassthroughScheme,
    remoteMissFallback: config.localPassthroughFallback === true,
    warn: message => ctx.logger?.warn?.(message),
  })
  if (passthrough.enabled) {
    ctx.logger?.info?.(`ssh-workspace: local passthrough enabled for ${passthrough.prefixes.join(', ')}`)
  }

  const engine = new SshWorkspaceEngine({ logger: ctx.logger, ...(config.engine ?? {}) })

  /**
   * Install one Host seam, and record what happened.
   *
   * Every `patch-*.js` takes over a live service the Host mounted, and each has
   * three possible fates that used to be indistinguishable from the outside:
   *
   * - the service is not mounted at all → `absent`, ordinary in a composition
   *   that simply does not use that capability;
   * - the service is there and the wrapper is installed → `installed`;
   * - the service is there but no longer has the method we wrap → the install
   *   `throw`s. Left alone, that throw escapes the `ctx.inject` callback and
   *   becomes a plugin ACTIVATION error, so one renamed Host method takes the
   *   whole plugin down instead of costing the one feature it backs.
   *
   * So the call is wrapped: a throw is recorded as `failed` (which is the state
   * worth an event, and the one `diagnose()` turns into a finding) and degrades
   * to the same `undefined` an absent service returns. Everything else keeps
   * behaving exactly as before.
   *
   * @param {string} absent - one sentence for "this composition does not have it".
   * @returns {object|undefined} the router, or undefined when nothing was installed.
   */
  const installSeam = (id, absent, install) => {
    try {
      const router = install()
      if (router === undefined) {
        engine.noteSeam(id, 'absent', absent)
        return undefined
      }
      engine.noteSeam(id, 'installed')
      return router
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      engine.noteSeam(id, 'failed', detail)
      ctx.logger?.warn?.(`ssh-workspace: ${id} could not be installed: ${detail}`)
      return undefined
    }
  }

  // The detached-workspace list is loaded up front, not in the registry
  // injection below: the shell, subprocess and terminal halves never wait for
  // the registry, and a workspace that stays runnable until a later activation
  // step would be "off" only in the file panel.
  let detachedWorkspaces = []
  try {
    detachedWorkspaces = engine.store.entryStore.workspaces().disabled
    engine.setDisabledWorkspaces(detachedWorkspaces)
  } catch (error) {
    ctx.logger?.warn?.(`ssh-workspace: could not read the detached-workspace list: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Secrets written by older versions sit in the shared store as plaintext;
  // move them into the encrypted section once, best-effort, so a store this
  // plugin cannot understand is left alone instead of clobbered.
  try {
    const encrypted = engine.store.entryStore.encryptStoredSecrets()
    if (encrypted > 0) {
      ctx.logger?.info?.(`ssh-workspace: encrypted ${encrypted} host secret(s) that were still stored in plaintext`)
    }
  } catch (error) {
    ctx.logger?.warn?.(`ssh-workspace: could not encrypt stored host secrets: ${error instanceof Error ? error.message : String(error)}`)
  }
  // The two editable passthrough settings. Configuration is only the FIRST
  // default: once the panel has saved a value the store is the truth, so a
  // restart or a reload keeps the user's choice instead of silently snapping
  // back to whatever the profile row happens to say.
  const passthroughSettings = new PassthroughSettings({
    store: engine.store.entryStore,
    matcher: passthrough,
    defaults: {
      scheme: config.localPassthroughScheme,
      remoteMissFallback: config.localPassthroughFallback === true,
    },
    logger: ctx.logger,
  })
  // Applied before any seam is installed below, so the very first filesystem
  // call already sees the saved values.
  const appliedPassthrough = passthroughSettings.activate()
  if (passthrough.enabled) {
    ctx.logger?.info?.(`ssh-workspace: local scheme "${appliedPassthrough.scheme}:", remote-miss fallback ${appliedPassthrough.remoteMissFallback ? 'on' : 'off'}`)
  }

  // Local listeners mapped to remote ports ride the pooled connections; their
  // lifecycle follows the engine (see forward.js). The saved half sits on top:
  // the store holds which mappings the user wants, and this manager joins that
  // intent onto the listeners that actually exist.
  const forwards = new ForwardManager({ engine, logger: ctx.logger })
  const savedForwards = new SavedForwardManager({ forwards, store: engine.store.entryStore, logger: ctx.logger })
  forwards.onClosed = (entry, reason) => { savedForwards.noteClosed(entry, reason) }
  // Reverse tunnels (`ssh -R`) get their own manager for one structural reason:
  // their listeners live on the REMOTE host, so they are server-side state that
  // must be cancelled explicitly rather than a socket that goes away with the
  // process. Folding them into ForwardManager would make every teardown path
  // branch on which kind of listener it is holding.
  const reverseForwards = new ReverseForwardManager({ engine, logger: ctx.logger })
  // A background reconnect has to put back what the dead socket took with it.
  // The filesystem seam and the shells recover on first use (they re-acquire),
  // but a saved tunnel's listener was torn down by the close, so without this
  // its "enabled" intent would sit there with no listener and no reason.
  engine.onReconnected = (alias) => {
    if (typeof savedForwards.reopenEnabled !== 'function') return
    savedForwards.reopenEnabled(alias).catch((error) => {
      ctx.logger?.warn?.(`ssh-workspace: could not restore port forwards for ${alias} after reconnecting: ${error instanceof Error ? error.message : String(error)}`)
    })
    // A reverse tunnel died with the socket that carried its remote listener.
    // There is nothing to reopen automatically — the remote port may now belong
    // to something else, and silently claiming it back would be worse than
    // saying it is gone — so the row is torn down instead of left asserting a
    // forward that no longer exists.
    reverseForwards.closeForAlias(alias, 'SSH connection closed')
  }
  // A saved tunnel's listener dies with its connection, so after the drop its
  // `holds` no longer pins anything — but its intent is still "on", and that is
  // what makes the host worth redialing. Without this the background loop would
  // give up on exactly the host whose tunnels the user expects it to restore.
  engine.addWantedCheck(alias => savedForwards.hasEnabled(alias))
  // A host the user switched on is "wanted" (redial after a drop) AND exempt
  // from the idle sweep (a boot-restored connection must not be reclaimed after
  // thirty quiet minutes). Both read the persisted intent, never a cached copy.
  const intentStore = engine.store.entryStore
  const hasHostIntent = (alias) => {
    try {
      return intentStore?.autoConnectHosts?.().includes(alias) === true
    } catch {
      return false
    }
  }
  engine.addWantedCheck(hasHostIntent)
  engine.addKeepAliveCheck(hasHostIntent)
  // Persistent remote shells hold their own connections and keep their state;
  // they close with the plugin.
  const shells = new ShellManager({ engine, logger: ctx.logger })

  // `@` mentions the user typed are ordinary prompt text by the time the model
  // calls `read`, so the intent is recovered from the message log: a restored
  // session is scanned once at creation, and every later user message is folded
  // in as it is appended. Without this a drive-letter path the user explicitly
  // referenced would stay remote and fail over SFTP (the ENOENT this covers).
  if (passthrough.enabled) {
    const noteSession = (session) => {
      if (passthrough.hostReferences.length > HOST_REFERENCE_SCAN_LIMIT) return
      recordSessionHostReferences(passthrough, session)
    }
    ctx.on('session/created', session => { noteSession(session) }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'user/message') return
      const options = { platform: passthrough.platform, scheme: passthrough.scheme }
      for (const spelling of hostReferencesInMessage(event.data, options)) passthrough.addHostReference(spelling)
    }, { global: true })
    try {
      for (const session of ctx.sessions?.list?.() ?? []) noteSession(session)
    } catch (error) {
      ctx.logger?.warn?.(`ssh-workspace: could not scan existing sessions for @ references: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Register system prompt guidance if requested and available
  if (config.announceToAgent === true) {
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt) {
        ctx.effect(
          () => systemPrompt.section({
            name: 'plugin:dsh-ssh-workspace',
            order: SECTION_ORDER,
            text: passthrough.enabled
              ? `${SSH_WORKSPACE_GUIDANCE}\n\n${LOCAL_PASSTHROUGH_GUIDANCE}`
              : SSH_WORKSPACE_GUIDANCE,
          }),
          'ssh-workspace: guidance',
        )
      }
    } catch {
      // systemPrompt not available, skip guidance
    }
  }

  /**
   * The router installed onto the live `ctx.fs`, shared with the route half.
   *
   * @type {import('./fs/remote-fs.js').RemoteFileSystem | undefined}
   */
  let router

  /**
   * Take over the live `ctx.fs` once it exists.
   *
   * @param {import('@deepseek-ai/cordis').Context} scoped - the context the
   *   injected service body runs in (owns the effects below).
   */
  const install = (scoped) => {
    // The deployment already mounted its own local backend under this name, so
    // the remote methods are installed onto that ONE live instance rather than
    // re-provided (Cordis refuses a second provide('fs')).
    router = installSeam(
      'PATCH-fs',
      'ctx.fs is not mounted in this composition; the remote workspace cannot be served',
      () => installRemoteFileSystem(scoped, { engine, passthrough }, RemoteFileSystem),
    )
    if (router === undefined) {
      scoped.logger?.warn?.('ssh-workspace: the remote workspace cannot be served')
      return
    }
    engine.attachFileSystem(router)

    // The Host's own builtin calls do not travel through `ctx.fs`, and several
    // run on a new session's cwd before its agent exists — the Session
    // controller's `mkdir`, the Workspace registry's `realpath`/`stat`, and the
    // Session service's `path.isAbsolute` header check — so both builtins are
    // bridged for `ssh://` targets too.
    installBuiltinBridge({ engine, router, logger: scoped.logger, passthrough })

    scoped.effect(() => () => {
      // Drop the patch before the engine goes away so a late call cannot reach a
      // disposed connection pool; shells and forwards close first among the
      // engine's consumers so their channels are gone before the connections drop.
      uninstallBuiltinBridge()
      uninstallRemoteFileSystem(scoped.get('fs'))
      shells.dispose()
      // Before `engine.dispose()` and before the pool drops: a reverse forward
      // must send its cancel request while the connection can still carry it,
      // or the remote host keeps the port bound until the whole session ends.
      reverseForwards.dispose()
      forwards.dispose()
      engine.dispose()
    }, 'ssh-workspace: fs patch')

    scoped.effect(
      () => {
        const installed = workspaceTools(ctx, engine, router, forwards, shells, reverseForwards, remoteSkills).map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of installed) dispose() }
      },
      'ssh-workspace: tools',
    )
  }

  // Opening saved tunnels at startup is opt-in (the `autoStart` preference in
  // the store, written by the panel). It runs on a later tick and never throws:
  // an unreachable host must not delay or fail the plugin's own activation, and
  // a mapping that cannot bind is reported in the panel like any other failure
  // rather than taking the profile down.
  const startSavedForwards = () => {
    setTimeout(() => {
      savedForwards.autoStart().catch((error) => {
        ctx.logger?.warn?.(`ssh-workspace: could not auto-open saved port forwards: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 0)
  }
  startSavedForwards()

  // Reconnect the hosts the user switched on. Runs on a later tick, serially,
  // and never throws — exactly like saved-tunnel auto-start: an unreachable host
  // must not delay plugin activation, and one failure must not stop the rest.
  // Deliberately `acquire` (not the scheduler's `retryNow`): `retryNow` runs the
  // restore hook, which would re-open saved tunnels even when the panel's
  // "auto-open tunnels" preference is off. A host being connected and its
  // tunnels being restored are two separate choices.
  const restoreAutoConnect = () => {
    setTimeout(() => {
      let aliases = []
      try {
        aliases = intentStore?.autoConnectHosts?.() ?? []
      } catch { /* an unreadable store restores nothing */ }
      if (aliases.length === 0) return
      for (const alias of aliases) engine.autoConnectPending.add(alias)
      ;(async () => {
        let connected = 0
        for (const alias of aliases) {
          // The list was captured at pass start; a host switched off behind a
          // slow earlier dial must not be connected by this pass.
          if (!hasHostIntent(alias)) {
            engine.autoConnectPending.delete(alias)
            continue
          }
          try {
            await engine.acquire(alias)
            connected += 1
          } catch (error) {
            // A fatal descriptor error arms no background loop; record a
            // diagnostic so the host does not silently never come back. The
            // reconnect loop handles retryable failures via acquire's noteLost.
            try {
              engine.diagnostics?.record?.('reconnect', `could not reconnect ${alias} on startup: ${error instanceof Error ? error.message : String(error)}`, { alias })
            } catch { /* diagnostics must never fail the restore */ }
          } finally {
            engine.autoConnectPending.delete(alias)
          }
        }
        if (connected > 0) {
          ctx.logger?.info?.(`ssh-workspace: reconnected ${connected} host(s) the user had switched on`)
        }
      })().catch((error) => {
        ctx.logger?.warn?.(`ssh-workspace: auto-connect restore failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 0)
  }
  restoreAutoConnect()

  // Remote skill discovery is registered unconditionally and is DISABLED unless
  // the profile opts in: a provider that does not exist cannot be enabled from
  // the panel later, while a provider that exists and answers nothing costs one
  // branch per lookup. `skills` is optional, so this is its own injection rather
  // than part of `install`: a headless composition without the registry must
  // still serve the filesystem seam.
  //
  // Built BEFORE the `fs` injection below: `install` runs synchronously when the
  // backend is already mounted, and it hands this instance to the tools.
  const remoteSkills = new RemoteSkillsProvider({
    engine: () => engine,
    roots: () => router?.listRoots?.() ?? [],
    config: config.remoteSkills,
    logger: ctx.logger,
    diagnostics: engine.diagnostics,
  })
  // `ctx.inject` runs `install` immediately when `fs` is already available and
  // otherwise as soon as it is provided — which is what makes the takeover
  // independent of where this plugin sits relative to the backend in the
  // profile's entry list.
  ctx.inject(['fs'], install)

  ctx.inject(['skills'], (scoped) => {
    try {
      scoped.skills.registerProvider((registration) => {
        remoteSkills.attach(registration)
        return remoteSkills
      })
    } catch (error) {
      // A Host without the provider registry, or with a different signature, is
      // a deployment fact rather than a failure of this plugin: the remote
      // workspace keeps working and the feature is simply absent.
      scoped.logger?.warn?.('ssh-workspace: remote skills are not registered: ' + (error instanceof Error ? error.message : String(error)))
      return
    }
    // The registration's own abort signal is the Host's to fire; clearing the
    // cache here is the part this plugin owns.
    scoped.effect(() => () => { remoteSkills.invalidate() }, 'ssh-workspace: remote skills')
  })

  // ┌─ UPSTREAM WORKAROUND #1 — delete this block when upstream fixes it ──────
  // │ Reading a STORED session's history re-validates every projection value,
  // │ and the unit carrying a session's directory captured `path.isAbsolute` as
  // │ a function VALUE before this plugin could patch it — so an `ssh://` cwd
  // │ fails its schema and the browser reports "历史加载失败". Relaxing that one
  // │ schema is what makes those sessions openable again.
  // │
  // │ Upstream fix (one line, in @deepseek-ai/dsh-working-directory lib/index.js):
  // │   refine(isAbsolute)  →  refine((value) => isAbsolute(value))
  // │
  // │ Removal: delete this block, lib/patch-projection.js, the two
  // │ projection-*-smoke suites, and docs/upstream-workarounds.md.
  // │ You do not have to watch for the release: installProjectionRelaxation
  // │ probes the registered schema and, once it accepts an ssh:// value on its
  // │ own, patches nothing and reports `probe: 'fixed'` — the workaround retires
  // │ itself. That verdict is recorded on the engine (NOT in ctx.logger, which
  // │ nothing in this deployment reads): look for it in ssh_workspace_status →
  // │ upstreamWorkarounds, or an `upstream` event. tests/projection-real-smoke.mjs
  // │ goes RED on that release, which is the second signal. To check a deployment
  // │ by hand, restart DSH with DSH_SSH_WORKSPACE_DISABLE_UPSTREAM_WORKAROUNDS=1
  // │ and open a stored ssh:// session: it loads → the workaround is obsolete.
  // │ Runbook: docs/upstream-workarounds.md · id: UPSTREAM-1-working-directory-isAbsolute
  // └──────────────────────────────────────────────────────────────────────────
  ctx.inject(['sessionProjections'], (scoped) => {
    const installed = installProjectionRelaxation(scoped, { logger: scoped.logger })
    if (installed === undefined) {
      scoped.logger?.warn?.('ssh-workspace: sessionProjections was not available; stored ssh:// sessions may fail to load')
      return
    }
    // The verdict has to land somewhere a user can reach. `ctx.logger` cannot
    // carry it (no console exporter; debug is below every level), so it goes on
    // the engine, which serves it through the status tool and the panel route.
    engine.noteUpstreamWorkaround(installed.id, { probe: installed.probe, detail: installed.detail })
    scoped.effect(() => () => { uninstallProjectionRelaxation(scoped) }, 'ssh-workspace: projection schema')
  })

  // Every command path runs the LOCAL sandbox provider's `confine()` before it
  // reaches the seam patched below — and that provider resolves
  // `policy.workspaceRoot` as a HOST path, while `sandboxPolicy.resolve()`
  // returns a remote session's `ssh://` spelling verbatim. On Windows the ACL
  // provider then realpaths that spelling and fails closed with
  // "workspace and temp directory resolution failed", so no remote command
  // ever starts. Installing here rewrites only the host paths in the policy
  // (see patch-sandbox.js) and leaves the remote spelling — and every mode
  // gate that compares against it — untouched.
  ctx.inject(['sandbox'], (scoped) => {
    const sandboxRouter = installSeam(
      'PATCH-sandbox',
      'ctx.sandbox is not mounted in this composition; there is no provider to localize, and nothing to fix',
      () => installRemoteSandbox(scoped, { logger: scoped.logger }),
    )
    if (sandboxRouter === undefined) {
      scoped.logger?.info?.('ssh-workspace: workspace-root localization for remote sessions is not installed')
      return
    }
    scoped.effect(() => () => { uninstallRemoteSandbox(scoped.get('sandbox')) }, 'ssh-workspace: sandbox patch')
  })

  // The shell seam allows ONE executor per context and the deployment's local
  // executor is already mounted, so the remote half is installed onto that
  // live instance too (see patch-shell.js): a spec whose workdir is an
  // `ssh://` target runs on the host, everything else through the original
  // local executor unchanged.
  ctx.inject(['shell'], (scoped) => {
    const shellRouter = installSeam(
      'PATCH-shell',
      'ctx.shell is not mounted in this composition; remote command execution is disabled',
      () => installRemoteShell(scoped, { engine, logger: scoped.logger }),
    )
    if (shellRouter === undefined) {
      scoped.logger?.warn?.('ssh-workspace: remote command execution is disabled')
      return
    }
    scoped.effect(() => () => { uninstallRemoteShell(scoped.get('shell')) }, 'ssh-workspace: shell patch')
  })

  // The file tools' helpers spawn short-lived child processes through
  // ctx.subprocess, and two of them can legitimately carry a remote workspace
  // as cwd — the search tool's ripgrep and the change tracker's git. The
  // remote half is installed onto that live service the same way (see
  // patch-subprocess.js): specs whose cwd is an `ssh://` target run on the
  // remote machine, everything else through the original spawn unchanged.
  ctx.inject(['subprocess'], (scoped) => {
    const subprocessRouter = installSeam(
      'PATCH-subprocess',
      'ctx.subprocess is not mounted in this composition; remote glob/grep and git support are disabled',
      () => installRemoteSubprocess(scoped, { engine, logger: scoped.logger }),
    )
    if (subprocessRouter === undefined) {
      scoped.logger?.warn?.('ssh-workspace: remote glob/grep and git support are disabled')
      return
    }
    scoped.effect(() => () => { uninstallRemoteSubprocess(scoped.get('subprocess')) }, 'ssh-workspace: subprocess patch')
  })

  // Programmatic tool calling runs a small Node worker on the HOST and hands
  // it the session's working directory, so a remote session gives it an
  // `ssh://` spelling: the subprocess bridge refuses a non-git executable there,
  // and the worker could never chdir into the spelling anyway. Localizing the
  // spec's cwd (see patch-ptc.js) is the one point both the spawn and every
  // evaluation read from; the tools the program calls still run remotely.
  ctx.inject(['ptcRuntime'], (scoped) => {
    const ptcRouter = installSeam(
      'PATCH-ptc',
      'ctx.ptcRuntime is not mounted in this composition; program execution for remote sessions is not localized',
      () => installRemotePtc(scoped, { logger: scoped.logger }),
    )
    if (ptcRouter === undefined) {
      scoped.logger?.info?.('ssh-workspace: program execution for remote sessions is not localized')
      return
    }
    scoped.effect(() => () => { uninstallRemotePtc(scoped.get('ptcRuntime')) }, 'ssh-workspace: ptc patch')
  })

  // A persistent terminal is the same seam one layer up: the harness's terminal
  // backend asks `ctx.subprocess.spawnTerminal` for a PTY, which is a LOCAL
  // primitive. Without this, a persistent shell whose cwd is an ssh:// workspace
  // either fails or starts a local shell against a path that only exists on the
  // host. Installing here makes the harness's own terminal tools work remotely.
  ctx.inject(['subprocess'], (scoped) => {
    const terminalRouter = installSeam(
      'PATCH-terminal',
      'ctx.subprocess is not mounted in this composition; remote terminals are disabled',
      () => installRemoteTerminal(scoped, { engine, logger: scoped.logger }),
    )
    if (terminalRouter === undefined) {
      scoped.logger?.warn?.('ssh-workspace: remote terminals are disabled')
      return
    }
    scoped.effect(() => () => { uninstallRemoteTerminal(scoped.get('subprocess')) }, 'ssh-workspace: terminal patch')
  })

  // The picker half of the same story. `terminalController.shells()` enumerates
  // shells through `subprocess.resolveExecutable`, which this plugin does NOT
  // wrap — so a remote workspace offered local paths, and a shell only the host
  // has could never be selected. Answer ssh:// sessions from the host instead.
  //
  // Separate `inject` on purpose: only `terminalController` (the service being
  // patched) and `workingDirectory` (the ssh:// test) are needed. Discovery goes
  // through `engine.exec`, so declaring `subprocess` would delay this install
  // behind a service it never touches.
  ctx.inject(['terminalController', 'workingDirectory'], (pickerCtx) => {
    const shells = installSeam(
      'PATCH-shell-discovery',
      'ctx.terminalController is not mounted in this composition; the shell picker stays local',
      () => installShellDiscovery(pickerCtx, { engine, logger: pickerCtx.logger }),
    )
    if (shells === undefined) return
    pickerCtx.effect(() => () => { uninstallShellDiscovery(pickerCtx.get('terminalController')) }, 'ssh-workspace: shell discovery patch')
  })

  // The served-root set lives in memory while the workspace registration is
  // durable, so without this a restart would leave ssh:// workspaces listed in
  // the UI but unserved — and their writes fenced off. Re-mount whatever the
  // registry still lists; like the route injection below, this also installs
  // the patch itself when it happens to activate first.
  //
  // Two phases, and the ORDER is the whole point: a startup can index the
  // session table before this plugin mounts its roots, which leaves every
  // `ssh://` session unaccounted (the Host's `realpath(cwd)` cannot resolve the
  // scheme with the bridge absent). Re-attaching them needs the same
  // `realpath`/`stat` the seam only serves for a MOUNTED root, so the
  // compensation below must run after the loop above — see `lib/ownership.js`
  // for the mechanism and the failure modes.
  let ownershipClaimStarted = false
  ctx.inject(['fs', 'workspaceRegistry'], (scoped) => {
    const activeRouter = router ?? installRemoteFileSystem(scoped, { engine, passthrough }, RemoteFileSystem)
    if (activeRouter === undefined) return
    const registry = scoped.get('workspaceRegistry')
    if (typeof registry?.list !== 'function') return
    // Workspaces the user detached: their registration survives so the row
    // stays visible and re-enableable, but the plugin must NOT re-mount them —
    // that would make "off" last only until the next restart.
    const detached = detachedWorkspaces
    const detachedSet = new Set(detached)
    let restored = 0
    for (const entity of registry.list()) {
      const path = String(entity?.path ?? '')
      if (!isRemotePath(path)) continue
      if (detachedSet.has(path)) continue
      try {
        const parts = parseRemotePath(path)
        activeRouter.addRoot(parts.alias, parts.remotePath)
        restored += 1
      } catch (error) {
        scoped.logger?.warn?.(`ssh-workspace: could not re-mount "${path}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (restored > 0) scoped.logger?.info?.(`ssh-workspace: re-mounted ${restored} remote workspace(s) from the registry`)
    if (detachedSet.size > 0) scoped.logger?.info?.(`ssh-workspace: ${detachedSet.size} detached remote workspace(s) left unserved`)

    // Phase two. Once per activation, off the injection's synchronous path:
    // the callback is not awaited, so the scan runs as a detached promise whose
    // every failure is caught (a compensation must never fail activation).
    if (ownershipClaimStarted) return
    ownershipClaimStarted = true
    // The snapshot is installed BEFORE the pass and mutated by it, so a slow
    // dial or a stuck claim reads as `stage: 'rebuilding'` rather than as a
    // status surface that is simply empty (see `emptyOwnershipSnapshot`).
    const snapshot = emptyOwnershipSnapshot()
    engine.ownership = snapshot
    void (async () => {
      try {
        await reclaimOwnership({
          registry,
          detached: [...detachedSet],
          readHeaders: makeSessionHeaderReader({
            sessionQuery: optionalService(ctx, 'sessionQuery'),
            sessionPersistence: optionalService(ctx, 'sessionPersistence'),
          }),
          diagnostics: engine.diagnostics,
          snapshot,
          // Rebuilds the Host session index BEFORE any claim: a startup that
          // indexed while this plugin was off marks every `ssh://` cwd invalid,
          // and `attachSession` short-circuits on an id the record already holds,
          // so only a re-index can prove the membership again — see
          // `makeIndexRebuilder`. The cost is one store listing plus one
          // `realpath`/`stat` per stored session, all bounded by a deadline.
          rebuildIndex: makeIndexRebuilder(registry),
          // After a successful rebuild the registry already answers with the
          // repaired membership, but the workspace feed only re-reads it on a
          // table change — so a client that subscribed while the index was
          // stale would keep showing empty workspaces until the page reloads.
          // Announcing the repaired view is what makes the repair live.
          republish: makeWorkspaceRepublisher(scoped, registry),
        })
        // The event log carries the counts; this line is for the deployments
        // whose logger is reachable. Neither one includes a path or an alias.
        if (snapshot.reclaimed > 0) {
          scoped.logger?.info?.(`ssh-workspace: re-claimed ${snapshot.reclaimed} session(s) for their remote workspace(s)`)
        }
        if (snapshot.pending > 0 && snapshot.indexRebuilt !== 'reindexed') {
          scoped.logger?.warn?.(`ssh-workspace: the Host session index was not rebuilt (${String(snapshot.indexRebuilt ?? 'not attempted')}); a DSH restart is required to bring the sessions back`)
        }
        if (snapshot.degraded !== null) {
          scoped.logger?.warn?.(`ssh-workspace: session ownership was not checked — ${snapshot.degraded}`)
        }
      } catch (error) {
        // Reaching here means the module itself was surprised. Report the fact
        // through the same snapshot the status surfaces read, so the failure is
        // visible rather than a silently empty field.
        engine.ownership = {
          ...emptyOwnershipSnapshot(),
          skipped: [...detachedSet],
          degraded: `the ownership re-claim failed: ${failureReason(error)}`,
        }
        engine.ownership.stage = 'done'
        scoped.logger?.warn?.(`ssh-workspace: session ownership re-claim failed: ${failureReason(error)}`)
      }
    })().catch(() => {})
  })

  // The browser half. Its routes need BOTH the filesystem (to mount through)
  // and the deployment's web server, and either may appear after this plugin
  // loads — so wait for both instead of giving up on a first look. A deployment
  // without a web server simply never gets the HTTP surface, while the agent
  // tools above still work.
  ctx.inject(['fs', 'webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined || webServer === null) return
    // The fs injection normally got here first; installing is idempotent, so
    // this also covers the reverse activation order.
    const activeRouter = router ?? installRemoteFileSystem(scoped, { engine, passthrough }, RemoteFileSystem)
    if (activeRouter === undefined) return
    scoped.effect(
      () => {
        const routes = makeRoutes({
          engine,
          router: activeRouter,
          forwards,
          reverseForwards,
          savedForwards,
          passthroughSettings,
          shells,
          remoteSkills,
          ctx: scoped,
          allowLan: config.allowLan === true,
          allowedHosts: Array.isArray(config.allowedHosts) ? config.allowedHosts : [],
        })
        const disposers = routes.map(route => webServer.register(route))
        scoped.logger?.info?.(`ssh-workspace: registered ${routes.length} HTTP routes for the browser half`)
        return () => { for (const dispose of disposers) dispose() }
      },
      'ssh-workspace: routes',
    )
  })
}

export { SshWorkspaceEngine, RemoteFileSystem }
export { formatRemotePath, parseRemotePath, isRemotePath, normalizeRemotePath } from './core/protocol.js'
