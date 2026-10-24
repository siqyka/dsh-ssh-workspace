window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')

    // =========================================================================
    // API client
    // =========================================================================
    const API = {
      hosts: '/api/dsh-ssh-workspace/hosts',
      hostSave: '/api/dsh-ssh-workspace/hosts/save',
      hostDelete: '/api/dsh-ssh-workspace/hosts/delete',
      hostForgetKey: '/api/dsh-ssh-workspace/hosts/forget-key',
      hostDisconnect: '/api/dsh-ssh-workspace/hosts/disconnect',
      hostReconnect: '/api/dsh-ssh-workspace/hosts/reconnect',
      test: '/api/dsh-ssh-workspace/test',
      ls: '/api/dsh-ssh-workspace/ls',
      status: '/api/dsh-ssh-workspace/status',
      mount: '/api/dsh-ssh-workspace/mount',
      unmount: '/api/dsh-ssh-workspace/unmount',
      enable: '/api/dsh-ssh-workspace/enable',
      unforward: '/api/dsh-ssh-workspace/unforward',
      forwardSave: '/api/dsh-ssh-workspace/forward/save',
      forwardToggle: '/api/dsh-ssh-workspace/forward/toggle',
      forwardDelete: '/api/dsh-ssh-workspace/forward/delete',
      forwardRemember: '/api/dsh-ssh-workspace/forward/remember',
      forwardProbe: '/api/dsh-ssh-workspace/forward/probe',
      forwardSettings: '/api/dsh-ssh-workspace/forward/settings',
      download: '/api/dsh-ssh-workspace/download',
      upload: '/api/dsh-ssh-workspace/upload',
    }

    async function fetchJson (url, init) {
      const res = await fetch(url, init)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let message = text || res.statusText
        try {
          const parsed = JSON.parse(text)
          if (typeof parsed?.error === 'string' && parsed.error !== '') message = parsed.error
        } catch { /* not a JSON error body */ }
        throw new Error(message)
      }
      return res.json()
    }

    // =========================================================================
    // Locale
    // =========================================================================
    const NS = 'dsh-ssh-workspace'
    const zh = {
      'entry.label': '远程工作区',
      'panel.title': '远程工作区',
      'panel.empty': '暂无已配置的 SSH 主机',
      'panel.loading': '加载中…',
      'hosts.title': 'SSH 主机',
      'hosts.keyReady': '就绪',
      'hosts.keyMissing': '密钥缺失',
      'hosts.test': '测试连接',
      'hosts.testing': '连接中…',
      'hosts.testOk': '连接成功 ({ms}ms)',
      'hosts.testFail': '连接失败',
      'hosts.browse': '浏览目录',
      'hosts.add': '添加主机',
      'hosts.edit': '编辑',
      'hosts.delete': '删除',
      'hosts.deleteConfirm': '确认删除',
      'hosts.deleteCancel': '取消',
      'hosts.deleteDesc': '删除后，该主机已挂载的工作区将无法继续访问。',
      'hosts.deleting': '删除中…',
      'hosts.deleteFail': '删除失败',
      'hosts.forgetKey': '忘记主机密钥',
      'hosts.forgetKeyConfirm': '确认忘记',
      'hosts.forgetKeyDesc': '仅在该主机确实重装系统或更换了密钥后使用。忘记后，下次连接将重新信任并记录对方出示的密钥（TOFU）；若不确定，请先与管理员核对指纹。',
      'hosts.forgetKeyOk': '已忘记记录的密钥，下次连接将重新记录',
      'hosts.forgetKeyFail': '忘记主机密钥失败',
      'hosts.disconnect': '断开',
      'hosts.disconnecting': '断开中…',
      'hosts.disconnectOk': '已断开连接',
      'hosts.disconnectOkForwards': '已断开连接，同时关闭 {n} 条端口转发',
      'hosts.disconnectFail': '断开连接失败',
      'hosts.disconnectBusy': '连接上有操作进行中，空闲后才能断开',
      'editor.title.create': '添加 SSH 主机',
      'editor.title.edit': '编辑 SSH 主机',
      'editor.alias': '别名',
      'editor.aliasHint': '工作区路径中 ssh://<别名>/… 的别名',
      'editor.aliasHintEdit': '改名后，已经以旧别名挂载的工作区将无法访问',
      'editor.host': '主机地址',
      'editor.port': '端口',
      'editor.user': '用户名',
      'editor.auth': '认证方式',
      'editor.authKind.key': '密钥文件',
      'editor.authKind.password': '密码',
      'editor.authKind.agent': 'SSH Agent',
      'editor.keyPath': '私钥路径',
      'editor.keyPathHint': '例如 ~/.ssh/id_ed25519',
      'editor.passphrase': '私钥口令（可选）',
      'editor.secretKeep': '留空保持不变',
      'editor.password': '密码',
      'editor.agentPath': 'Agent 地址（可选）',
      'editor.agentPathHint': '留空使用系统默认（SSH_AUTH_SOCK / pageant）',
      'editor.description': '备注（可选）',
      'editor.agentForward': '转发 ssh-agent',
      'editor.agentForwardHint': '让远端命令用本机的 ssh-agent 密钥认证（如远端 git push），私钥无需复制到远端',
      'editor.compress': '压缩传输',
      'editor.compressHint': '以 CPU 换带宽，慢链路（如跨国 / 移动网络）下明显更快',
      'editor.required': '请填写{field}',
      'editor.badPort': '端口必须是 1-65535 的整数',
      'editor.save': '保存',
      'editor.saving': '保存中…',
      'editor.cancel': '取消',
      'editor.saveFail': '保存失败',
      'dialog.close': '关闭',
      'browser.title': '浏览 {alias}',
      'browser.loading': '加载中…',
      'browser.empty': '空目录',
      'browser.error': '无法加载目录',
      'browser.parent': '返回上级',
      'browser.mount': '挂载此目录',
      'browser.mounting': '挂载中…',
      'browser.download': '下载到本机',
      'browser.downloadFail': '下载失败',
      'browser.upload': '上传文件',
      'browser.uploading': '上传中…',
      'browser.uploadFail': '上传失败',
      'browser.mountOk': '已挂载为 {path}',
      'browser.mountFail': '挂载失败',
      'caps.rg': '注意：该主机未安装 ripgrep（rg），glob / grep 会以退出码 127 失败。',
      'caps.git': '注意：该主机未安装 git，工作区变更追踪（diff / 变更面板）已关闭。',
      'caps.inotifywait': '注意：该主机未安装 inotifywait，文件树 / 预览自动刷新使用轮询（约数秒延迟）。',
      'mounted.title': '已挂载的工作区',
      'mounted.none': '暂无已挂载的工作区',
      'mounted.unmount': '卸载',
      'mounted.unmounting': '卸载中…',
      'mounted.detachHint': '未勾选「同时删除工作区记录」则工作区记录与会话都保留，左侧那一行仍在（置灰），随时可以重新启用；勾选则工作区记录被删除、会话归档',
      'mounted.confirmDetach': '确认卸载',
      'mounted.detachOkKeep': '已卸载，工作区与会话都保留',
      'mounted.detachOk': '已卸载并归档 {n} 个会话',
      'mounted.detachPartial': '已卸载，但 {n} 个会话未能归档',
      'mounted.detachFail': '卸载失败',
      'mounted.removeRecord': '同时删除工作区记录',
      'detached.title': '已停用的工作区',
      'detached.none': '暂无已停用的工作区',
      'detached.hint': '这些工作区已卸载：文件读写与命令执行均不可用，SSH 连接仍保留',
      'detached.badge': '已停用',
      'detached.enable': '启用',
      'detached.enabling': '启用中…',
      'detached.enableOk': '已重新挂载 {path}',
      'detached.enableFail': '启用失败',
      'connections.connected': '已连接',
      'connections.broken': '已断开',
      'connections.inFlight': '进行中: {n}',
      'connections.reconnecting': '重连中（第 {n} 次，{s} 秒后）',
      'connections.reconnectingNow': '重连中（第 {n} 次）',
      'connections.gaveUp': '重连已停止',
      'connections.retry': '立即重连',
      'connections.retrying': '连接中…',
      'connections.retryOk': '已恢复连接',
      'connections.retryFail': '重连失败',
      'shells.title': '持久远端会话',
      'shells.alive': '存活',
      'shells.closed': '已结束',
      'forwards.title': '端口转发',
      'forwards.none': '暂无端口转发',
      'forwards.remotePort': '远端端口',
      'forwards.localPort': '本地端口（可选）',
      'forwards.localPlaceholder': '默认同远端',
      'forwards.open': '打开',
      'forwards.close': '关闭',
      'forwards.connections': '活跃连接: {n}',
      'forwards.fail': '端口转发失败',
      'forwards.save': '保存并转发',
      'forwards.saving': '保存中…',
      'forwards.enable': '开启',
      'forwards.disable': '断开',
      'forwards.enabled': '已开启',
      'forwards.disabled': '已断开',
      'forwards.remember': '记住',
      'forwards.rememberHint': '把这个临时映射保存下来，下次启动可自动开启',
      'forwards.delete': '删除',
      'forwards.deleteConfirm': '确认删除',
      'forwards.busy': '处理中…',
      'forwards.autoStart': '启动时自动开启隧道',
      'forwards.autoStartHint': '仅对「已开启」的映射生效；关闭时全部保持断开，需要手动点开启',
      'forwards.portBusy': '本地端口被占用',
      'forwards.portReserved': '本地端口不可绑定（被系统保留或权限不足）',
      'forwards.portFree': '本地端口可用',
      'forwards.checking': '检查端口…',
      'forwards.lost': '连接已断开',
      'refresh': '刷新',
      // ---- add-workspace flow
      'add.local': '新建本地工作区',
      'add.localDesc': '在这台设备上编辑、运行和测试文件。',
      'add.remote': '新建远程工作区',
      'add.remoteDesc': '选择已连接 SSH 主机上的工作目录。',
      'remote.title': '新建远程工作区',
      'remote.name': '工作区名称',
      'remote.namePlaceholder': '输入工作区名称',
      'remote.host': '远程主机',
      'remote.dir': '工作目录',
      'remote.up': '返回上级',
      'remote.loading': '加载中…',
      'remote.empty': '空目录',
      'remote.loadError': '无法加载目录：{msg}',
      'remote.notWritable': '当前 SSH 账号对这个目录没有写入权限，Agent 无法在这里工作。请换一个可写目录，或在远程主机上授予权限后重试。',
      'remote.create': '创建工作区',
      'remote.creating': '创建中…',
      'remote.cancel': '取消',
      'remote.createFail': '创建失败：{msg}',
      'remote.hostsFail': '无法获取主机列表：{msg}',
      // ---- composer file bridge
      'mention.addToTask': '添加到任务',
      'mention.noComposer': '没有可插入的输入框',
      'mention.insertFail': '插入引用失败',
      'mention.unrepresentable': '该路径无法表示为引用',
      // ---- file tree transfers
      'transfer.download': '下载到本机',
      'transfer.upload': '上传文件到此目录',
      'transfer.downloadDirUnsupported': '暂不支持下载整个目录',
      'transfer.downloading': '正在下载 {name}…',
      'transfer.uploading': '正在上传…',
      'transfer.uploadingName': '正在上传 {name}…',
      'transfer.downloadFail': '下载失败',
      'transfer.uploadFail': '上传失败',
      'transfer.uploadOk': '已上传 {name}',
      'transfer.notRemote': '该文件不在远端工作区中',
    }
    const en = {
      'entry.label': 'Remote Workspace',
      'panel.title': 'Remote Workspaces',
      'panel.empty': 'No SSH hosts configured',
      'panel.loading': 'Loading…',
      'hosts.title': 'SSH Hosts',
      'hosts.keyReady': 'ready',
      'hosts.keyMissing': 'key missing',
      'hosts.test': 'Test',
      'hosts.testing': 'Connecting…',
      'hosts.testOk': 'Connected ({ms}ms)',
      'hosts.testFail': 'Connection failed',
      'hosts.browse': 'Browse',
      'hosts.add': 'Add host',
      'hosts.edit': 'Edit',
      'hosts.delete': 'Delete',
      'hosts.deleteConfirm': 'Confirm delete',
      'hosts.deleteCancel': 'Cancel',
      'hosts.deleteDesc': 'Workspaces already mounted on this host will stop being reachable.',
      'hosts.deleting': 'Deleting…',
      'hosts.deleteFail': 'Delete failed',
      'hosts.forgetKey': 'Forget key',
      'hosts.forgetKeyConfirm': 'Confirm forget',
      'hosts.forgetKeyDesc': 'Use this only after the host was reinstalled or its key genuinely changed. Forgetting makes the next connection trust and record whatever key the host presents (TOFU); when unsure, verify the fingerprint with the host owner first.',
      'hosts.forgetKeyOk': 'Recorded key forgotten — the next connection records it anew',
      'hosts.forgetKeyFail': 'Could not forget the host key',
      'hosts.disconnect': 'Disconnect',
      'hosts.disconnecting': 'Disconnecting…',
      'hosts.disconnectOk': 'Connection closed',
      'hosts.disconnectOkForwards': 'Connection closed, and {n} port forward(s) shut down with it',
      'hosts.disconnectFail': 'Could not disconnect',
      'hosts.disconnectBusy': 'The connection has operations in flight — disconnect again once it is idle',
      'editor.title.create': 'Add SSH host',
      'editor.title.edit': 'Edit SSH host',
      'editor.alias': 'Alias',
      'editor.aliasHint': 'The <alias> in ssh://<alias>/… workspace paths',
      'editor.aliasHintEdit': 'Renaming breaks workspaces already mounted under the old alias',
      'editor.host': 'Host',
      'editor.port': 'Port',
      'editor.user': 'User',
      'editor.auth': 'Authentication',
      'editor.authKind.key': 'Key file',
      'editor.authKind.password': 'Password',
      'editor.authKind.agent': 'SSH agent',
      'editor.keyPath': 'Private key path',
      'editor.keyPathHint': 'e.g. ~/.ssh/id_ed25519',
      'editor.passphrase': 'Key passphrase (optional)',
      'editor.secretKeep': 'Leave blank to keep',
      'editor.password': 'Password',
      'editor.agentPath': 'Agent endpoint (optional)',
      'editor.agentPathHint': 'Blank uses the system default (SSH_AUTH_SOCK / pageant)',
      'editor.description': 'Note (optional)',
      'editor.agentForward': 'Forward ssh-agent',
      'editor.agentForwardHint': 'Let remote commands authenticate with this machine\'s ssh-agent keys (e.g. a remote git push) without copying the private key to the host',
      'editor.compress': 'Compress transfer',
      'editor.compressHint': 'Trades CPU for bandwidth; noticeably faster on a slow link (cross-region or mobile)',
      'editor.required': '{field} is required',
      'editor.badPort': 'Port must be an integer between 1 and 65535',
      'editor.save': 'Save',
      'editor.saving': 'Saving…',
      'editor.cancel': 'Cancel',
      'editor.saveFail': 'Save failed',
      'dialog.close': 'Close',
      'browser.title': 'Browse {alias}',
      'browser.loading': 'Loading…',
      'browser.empty': 'Empty directory',
      'browser.error': 'Could not load directory',
      'browser.parent': 'Go up',
      'browser.mount': 'Mount this directory',
      'browser.mounting': 'Mounting…',
      'browser.download': 'Download to this machine',
      'browser.downloadFail': 'Download failed',
      'browser.upload': 'Upload file',
      'browser.uploading': 'Uploading…',
      'browser.uploadFail': 'Upload failed',
      'browser.mountOk': 'Mounted as {path}',
      'browser.mountFail': 'Mount failed',
      'caps.rg': 'Note: this host has no ripgrep (rg), so glob / grep will fail with exit code 127.',
      'caps.git': 'Note: this host has no git, so workspace change tracking (diff / changes panel) is off.',
      'caps.inotifywait': 'Note: this host has no inotifywait, so file tree / preview refresh falls back to polling (a few seconds behind).',
      'mounted.title': 'Mounted Workspaces',
      'mounted.none': 'No mounted workspaces',
      'mounted.unmount': 'Unmount',
      'mounted.unmounting': 'Unmounting…',
      'mounted.detachHint': 'Without "Also remove the workspace record" both the record and its sessions are kept — the sidebar row stays (greyed) and can be re-enabled at any time; with it the record is deleted and the sessions are archived',
      'mounted.confirmDetach': 'Confirm unmount',
      'mounted.detachOkKeep': 'Unmounted; the workspace and its sessions are both kept',
      'mounted.detachOk': 'Unmounted and archived {n} session(s)',
      'mounted.detachPartial': 'Unmounted, but {n} session(s) could not be archived',
      'mounted.detachFail': 'Unmount failed',
      'mounted.removeRecord': 'Also remove the workspace record',
      'detached.title': 'Detached Workspaces',
      'detached.none': 'No detached workspaces',
      'detached.hint': 'Unloaded: file access and command execution are refused, the SSH connection stays available',
      'detached.badge': 'off',
      'detached.enable': 'Enable',
      'detached.enabling': 'Enabling…',
      'detached.enableOk': 'Mounted {path} again',
      'detached.enableFail': 'Enable failed',
      'connections.connected': 'connected',
      'connections.broken': 'disconnected',
      'connections.inFlight': 'in flight: {n}',
      'connections.reconnecting': 'reconnecting (attempt {n}, in {s}s)',
      'connections.reconnectingNow': 'reconnecting (attempt {n})',
      'connections.gaveUp': 'reconnect stopped',
      'connections.retry': 'Reconnect now',
      'connections.retrying': 'Connecting…',
      'connections.retryOk': 'Connection restored',
      'connections.retryFail': 'Reconnect failed',
      'shells.title': 'Persistent Remote Shells',
      'shells.alive': 'live',
      'shells.closed': 'ended',
      'forwards.title': 'Port Forwards',
      'forwards.none': 'No port forwards',
      'forwards.remotePort': 'Remote port',
      'forwards.localPort': 'Local port (optional)',
      'forwards.localPlaceholder': 'same as remote',
      'forwards.open': 'Open',
      'forwards.close': 'Close',
      'forwards.connections': 'active connections: {n}',
      'forwards.fail': 'Port forward failed',
      'forwards.save': 'Save and forward',
      'forwards.saving': 'Saving…',
      'forwards.enable': 'Turn on',
      'forwards.disable': 'Turn off',
      'forwards.enabled': 'on',
      'forwards.disabled': 'off',
      'forwards.remember': 'Remember',
      'forwards.rememberHint': 'Save this ad-hoc mapping so it can be opened again after a restart',
      'forwards.delete': 'Delete',
      'forwards.deleteConfirm': 'Confirm delete',
      'forwards.busy': 'Working…',
      'forwards.autoStart': 'Open saved tunnels on startup',
      'forwards.autoStartHint': 'Applies to mappings whose state is "on"; when off, every tunnel stays down until you turn it on',
      'forwards.portBusy': 'the local port is already in use',
      'forwards.portReserved': 'the local port cannot be bound (reserved by the system or permission denied)',
      'forwards.portFree': 'the local port is available',
      'forwards.checking': 'Checking the port…',
      'forwards.lost': 'connection lost',
      'refresh': 'Refresh',
      // ---- add-workspace flow
      'add.local': 'New local workspace',
      'add.localDesc': 'Edit, run and test files on this device.',
      'add.remote': 'New remote workspace',
      'add.remoteDesc': 'Choose a working directory on a connected SSH host.',
      'remote.title': 'New Remote Workspace',
      'remote.name': 'Workspace name',
      'remote.namePlaceholder': 'Enter a workspace name',
      'remote.host': 'Remote host',
      'remote.dir': 'Working directory',
      'remote.up': 'Go up',
      'remote.loading': 'Loading…',
      'remote.empty': 'Empty directory',
      'remote.loadError': 'Could not load directory: {msg}',
      'remote.notWritable': 'The SSH account has no write permission on this directory, so the agent cannot work here. Choose a writable directory, or grant permission on the remote host and try again.',
      'remote.create': 'Create workspace',
      'remote.creating': 'Creating…',
      'remote.cancel': 'Cancel',
      'remote.createFail': 'Create failed: {msg}',
      'remote.hostsFail': 'Could not load hosts: {msg}',
      // ---- composer file bridge
      'mention.addToTask': 'Add to task',
      'mention.noComposer': 'No composer to insert into',
      'mention.insertFail': 'Could not insert the reference',
      'mention.unrepresentable': 'This path cannot be represented as a reference',
      // ---- file tree transfers
      'transfer.download': 'Download to this machine',
      'transfer.upload': 'Upload a file here',
      'transfer.downloadDirUnsupported': 'Downloading a whole directory is not supported yet',
      'transfer.downloading': 'Downloading {name}…',
      'transfer.uploading': 'Uploading…',
      'transfer.uploadingName': 'Uploading {name}…',
      'transfer.downloadFail': 'Download failed',
      'transfer.uploadFail': 'Upload failed',
      'transfer.uploadOk': 'Uploaded {name}',
      'transfer.notRemote': 'That file is not in a remote workspace',
    }

    /** Expand `{name}` placeholders; keys absent from params stay literal. */
    function applyParams (text, params) {
      if (!params) return text
      let out = text
      for (const [k, v] of Object.entries(params)) {
        out = out.replace(`{${k}}`, String(v))
      }
      return out
    }

    /** Simple translate with placeholder substitution. */
    function makeTranslate (dict) {
      return (key, params) => applyParams(dict[key] ?? key, params)
    }

    // =========================================================================
    // CSS (injected once at module load)
    // =========================================================================
    const CSS_ID = '@shiqyka/dsh-ssh-workspace/client.css'
    function injectStyles () {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@shiqyka/dsh-ssh-workspace'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = `
.sshwsp { font-family: var(--dsw-font-family, system-ui, sans-serif); color: var(--dsw-alias-label-primary, #e0e0e0); padding: 24px; overflow-y: auto; height: 100%; }
.sshwsp h2 { font-size: 18px; font-weight: 600; margin: 0 0 16px; letter-spacing: -0.01em; }
.sshwsp h3 { font-size: 12px; font-weight: 500; margin: 24px 0 12px; color: var(--dsw-alias-label-secondary, #999); letter-spacing: 0.02em; }
.sshwsp-card { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
.sshwsp-host { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sshwsp-host-info { flex: 1; min-width: 0; }
.sshwsp-host-alias { font-weight: 500; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.sshwsp-host-addr { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); font-family: var(--dsw-font-markdown-code-font-family, monospace); }
.sshwsp-host-meta { display: flex; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); margin-top: 2px; }
.sshwsp-host-desc { font-size: 12px; color: var(--dsw-alias-label-secondary, #999); margin-top: 2px; overflow-wrap: anywhere; }
.sshwsp-host-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.sshwsp-host-confirm { flex-basis: 100%; display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); padding-top: 8px; }
.sshwsp-host-confirm span { flex: 1; font-size: 12px; color: var(--dsw-alias-label-tertiary, #666); }
.sshwsp-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 24px 0 12px; }
.sshwsp-section-head h3 { margin: 0; }
.sshwsp-btn { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)); color: var(--dsw-alias-label-primary, #e0e0e0); border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; transition: background 120ms ease-out, transform 100ms ease-out; white-space: nowrap; }
.sshwsp-btn:hover { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.16)); }
.sshwsp-btn:active:not(:disabled) { transform: scale(0.98); }
.sshwsp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sshwsp-btn-primary { background: var(--dsw-alias-button-info-fill, #4a9eff); color: #fff; border-color: transparent; }
.sshwsp-btn-primary:hover { background: var(--dsw-alias-button-info-hover, #3d8ee6); }
.sshwsp-btn-danger { color: var(--dsw-alias-state-error-primary, #ff6b6b); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 35%, transparent); }
.sshwsp-btn-danger:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 12%, transparent); }
.sshwsp-btn:focus-visible, .sshwsp-icon-btn:focus-visible, .sshwsp-menuitem:focus-visible, .sshwsp-entry:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: 1px; }
.sshwsp-status { font-size: 11px; padding: 2px 6px; border-radius: 4px; }
.sshwsp-status-ok { color: var(--dsw-alias-state-success-primary, #4ade80); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #4ade80) 15%, transparent); }
.sshwsp-status-err { color: var(--dsw-alias-state-error-primary, #ff6b6b); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 15%, transparent); }
.sshwsp-status-warn { color: var(--dsw-alias-state-warn-primary, #fbbf24); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fbbf24) 15%, transparent); }
.sshwsp-toast { position: fixed; left: 50%; top: 40px; transform: translateX(-50%); z-index: 1100; box-sizing: border-box; max-width: min(480px, 90vw); padding: 9px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); background: var(--dsw-alias-bg-layer-3, #1a1a1a); box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); font-size: 12px; line-height: 1.5; cursor: pointer; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; animation: sshwsp-toast-in 160ms ease-out; }
.sshwsp-toast-ok { color: var(--dsw-alias-state-success-primary, #4ade80); }
.sshwsp-toast-err { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
@keyframes sshwsp-toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
.sshwsp-browser { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 8px; overflow: hidden; }
.sshwsp-browser-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06)); border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)); }
.sshwsp-browser-path { flex: 1; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-browser-list { max-height: 360px; overflow-y: auto; }
.sshwsp-entry { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 8px 14px; border: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background 100ms ease-out; }
.sshwsp-entry:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
.sshwsp-entry:last-child { border-bottom: none; }
.sshwsp-entry:disabled { opacity: 0.5; cursor: not-allowed; }
.sshwsp-entry-icon { width: 16px; height: 16px; color: var(--dsw-alias-label-secondary, #888); flex-shrink: 0; }
.sshwsp-entry-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-entry-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); font-family: var(--dsw-font-markdown-code-font-family, monospace); }
.sshwsp-mount { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 8px; padding: 10px 14px; margin-bottom: 6px; display: flex; align-items: center; gap: 12px; }
.sshwsp-mount-path { flex: 1; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A detached workspace row: dimmed but fully legible, and never given
   pointer-events:none — the whole point of the row is its Enable button. */
.sshwsp-mount-off { opacity: 0.62; }
.sshwsp-mount-off .sshwsp-mount-path { color: var(--dsw-alias-label-tertiary, #666); }
/* The "also remove the workspace record" opt-in inside an armed unmount row.
   It stays a checkbox rather than a second button because the two actions
   differ only in scope, and picking the wrong button here is unrecoverable
   for the row's visibility. */
.sshwsp-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #888); cursor: pointer; white-space: nowrap; }
.sshwsp-check input { margin: 0; cursor: pointer; }
/* Sidebar rows for detached workspaces. Set by passRemoteMarks; display-only,
   so a click still reaches DSH and the panel's Enable button stays the way
   back. Intercepting the host's own row click would break on its next
   redesign, which is a worse trade than a row that opens and shows an error. */
[data-sshwsp-disabled="1"] { opacity: 0.5; }
/* The power glyph marks the WORKSPACE header only. Applying it to every
   attribute carrier would stamp one on each session row too, which reads as
   "N separate switches" rather than "this workspace is off". */
[data-row-key^="workspace:"][data-sshwsp-disabled="1"]::after { content: "⏻"; margin-left: 6px; font-size: 10px; color: var(--dsw-alias-label-tertiary, #666); }
/* A detached workspace's row actions do nothing, so they are made inert rather
   than merely dimmed. pointer-events is used instead of a click interceptor:
   the buttons belong to DSH's own row, and patching its handlers breaks on the
   next redesign, while this rule survives any markup the row grows. The
   workspace HEADER stays clickable on purpose — expanding the group is how its
   sessions (kept per the detach contract) remain visible. */
[data-sshwsp-disabled="1"] button,
[data-sshwsp-disabled="1"] [role="button"] { pointer-events: none; opacity: 0.4; }
/* The sessions inside such a group are unreachable, row and all: the row
   itself IS the control that opens the session, so dimming only its buttons
   would leave the one action that matters. Keyed off the row key so this
   cannot reach the workspace header above, whose expand affordance is
   deliberately kept. The keyboard half is set by script; this is the mouse. */
[data-row-key^="session:"][data-sshwsp-disabled="1"] { pointer-events: none; cursor: not-allowed; }
/* Empty / loading / error placeholders. Every section renders one of these
   before it has rows, so this rule must exist even while the surrounding
   layout is being reworked: without it the placeholder collapses to an
   unstyled line and the panel looks half-loaded. */
.sshwsp-empty { text-align: center; padding: 32px 16px; color: var(--dsw-alias-label-tertiary, #666); font-size: 13px; }
/* Layout of the add-a-forward row: fixed footprint, not a stretched field.
   The host select is capped at 180px (half of the old 360px ceiling) and the
   two port boxes stay pinned to what a 7-digit port needs; leftover space on
   the right is simply empty. justify-content: flex-start keeps the row packed
   left instead of spreading the controls apart, and flex-wrap is the escape
   valve on a narrow panel — the row breaks rather than crushing the alias
   into an ellipsis.
   Scoping both rules under .sshwsp-forward-new is load-bearing, not cosmetic:
   .sshwsp-input sets width:100% with a single class, so a bare
   .sshwsp-input-port loses to it on source order however wide it declares
   itself. That is exactly what let every port box claim the full row and
   squeeze the select down to min-content.
   88px = 2px border + 16px padding + 70px of text: seven digits at 13px need
   ~51px, and the zh placeholder "默认同远端" (5 CJK glyphs, ~65px) fits. */
.sshwsp-forward-new { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-start; margin: 0 0 8px; }
.sshwsp-forward-new .sshwsp-select { flex: 0 1 180px; width: 180px; min-width: 90px; max-width: 180px; }
.sshwsp-forward-new .sshwsp-input-port { flex: 0 0 auto; width: 88px; padding-left: 8px; padding-right: 8px; font-variant-numeric: tabular-nums; appearance: textfield; -moz-appearance: textfield; }
.sshwsp-forward-new .sshwsp-btn { flex: 0 0 auto; }
/* The spinner steals ~15px of the box and pushes the placeholder into an
   ellipsis. A port is typed, not stepped (min/max/validation still apply):
   drop it. */
.sshwsp-forward-new .sshwsp-input-port::-webkit-outer-spin-button,
.sshwsp-forward-new .sshwsp-input-port::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.sshwsp-forward-row { flex-wrap: wrap; }
/* A saved mapping with no live listener is dimmed, but stays fully operable:
   the row must still be readable enough to decide whether to turn it on. */
.sshwsp-forward-off .sshwsp-mount-path { color: var(--dsw-alias-label-tertiary, #666); }
.sshwsp-forward-error { flex-basis: 100%; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The shared .sshwsp-check spreads label and box to opposite ends, which is
   right for a two-line row but wrong here: the box must sit beside the label
   it belongs to, not float away from it. Compounded so it outranks
   .sshwsp-check regardless of where this rule lands in the sheet.
   display/flex-direction are repeated here on purpose: .sshwsp-check declares
   neither, relying on the .sshwsp-field class for display:flex, and this label
   does not carry that class. Without them the row falls back to display:inline
   and the title drops onto its own line. */
.sshwsp-check.sshwsp-forward-autostart { display: flex; flex-direction: row; align-items: center; margin: 0 0 10px; padding: 8px 0 0; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); justify-content: flex-start; gap: 8px; }
.sshwsp-porthint { font-size: 11px; margin: -2px 0 8px; color: var(--dsw-alias-label-tertiary, #666); }
.sshwsp-porthint-busy { color: var(--dsw-alias-state-warn-primary, #fbbf24); }
.sshwsp-porthint-free { color: var(--dsw-alias-state-success-primary, #4ade80); }
/* Base size for a port box used outside the forward row (none today). Inside
   .sshwsp-forward-new the scoped rule above takes over, since a single class
   here would lose to .sshwsp-input's width:100%. */
.sshwsp-input-port { width: 88px; flex: none; }
/* A section with more than five rows becomes a scrolling viewport rather than
   a page-long column. CappedList sets max-height inline from the measured
   height of the first five rows; these rules only supply the flex column and,
   once it actually overflows, the scrolling.
   The gutter is reserved ALWAYS while scrolling (scrollbar-gutter: stable),
   because a scrollbar that appeared only on the sixth row would narrow the
   panel and reflow every row in it — a jump on the exact interaction that
   caused it. It is NOT reserved for a short list: those must render exactly
   as they did before the cap existed, with no 10px slot for an absent bar.
   overscroll-behavior keeps a flick at the end of a list from scrolling the
   whole panel behind it. */
.sshwsp-cap { display: flex; flex-direction: column; gap: 6px; }
.sshwsp-cap-scroll { overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding-right: 2px; }
/* Hosts and forwards are cards/rows that already bring their own bottom
   margin. Inside a flex column those margins stack ON TOP of the gap (they do
   not collapse), so a capped list would be spaced twice as loose as the same
   list uncapped. The cap owns the spacing; the rows drop theirs. */
.sshwsp-cap > .sshwsp-card, .sshwsp-cap > .sshwsp-mount { margin-bottom: 0; }
.sshwsp-conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 400; font-variant-numeric: tabular-nums; }
.sshwsp-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.sshwsp-dot-ok { background: var(--dsw-alias-state-success-primary, #4ade80); }
.sshwsp-dot-err { background: var(--dsw-alias-state-error-primary, #ff6b6b); }
.sshwsp-dot-warn { background: var(--dsw-alias-state-warning-primary, #fbbf24); }
.sshwsp-error { color: var(--dsw-alias-state-error-primary, #ff6b6b); font-size: 12px; margin-top: 4px; }
.sshwsp-backdrop { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.5)); display: flex; align-items: center; justify-content: center; z-index: 1000; animation: sshwsp-fade-in 120ms ease-out; }
.sshwsp-dialog { background: var(--dsw-alias-bg-layer-3, #1a1a1a); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 12px; width: 640px; max-width: 90vw; max-height: 80vh; display: flex; flex-direction: column; box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); animation: sshwsp-dialog-in 140ms ease-out; }
.sshwsp-dialog-narrow { width: 480px; }
.sshwsp-dialog-title { padding: 16px 20px; font-size: 16px; font-weight: 600; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); }
.sshwsp-dialog-body { padding: 0; overflow-y: auto; flex: 1; }
.sshwsp-dialog-footer { padding: 12px 20px; border-top: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); display: flex; justify-content: flex-end; gap: 8px; }
.sshwsp-form { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.sshwsp-form-row { display: flex; gap: 12px; }
.sshwsp-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.sshwsp-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #999); }
.sshwsp-field-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); }
.sshwsp-check { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; }
.sshwsp-check-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sshwsp-check input[type="checkbox"] { flex: 0 0 auto; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-button-info-fill, #4a9eff); cursor: pointer; }
.sshwsp-input { background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06)); border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)); border-radius: 6px; color: var(--dsw-alias-label-primary, #e0e0e0); padding: 6px 10px; font-size: 13px; font-family: inherit; width: 100%; box-sizing: border-box; }
.sshwsp-input:focus { outline: none; border-color: var(--dsw-alias-button-info-fill, #4a9eff); }
.sshwsp-input:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 30%, transparent); }
.sshwsp-select { cursor: pointer; color-scheme: dark; }
.sshwsp-dlg-head { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); }
.sshwsp-dlg-head h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
.sshwsp-icon-btn { background: none; border: 1px solid transparent; color: var(--dsw-alias-label-secondary, #999); border-radius: 6px; padding: 5px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 120ms ease-out, transform 100ms ease-out; }
.sshwsp-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-icon-btn:active:not(:disabled) { transform: scale(0.94); }
.sshwsp-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sshwsp-flowmenu { position: fixed; z-index: 1300; width: 300px; box-sizing: border-box; background: var(--dsw-alias-bg-layer-3, #1a1a1a); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 10px; box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); padding: 5px; animation: sshwsp-menu-in 120ms ease-out; }
.sshwsp-menuitem { display: flex; align-items: flex-start; gap: 10px; width: 100%; box-sizing: border-box; padding: 9px 10px; border: none; border-radius: 7px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sshwsp-menuitem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
.sshwsp-menuitem:disabled { opacity: 0.5; cursor: not-allowed; }
.sshwsp-menuitem-icon { display: inline-flex; margin-top: 1px; color: var(--dsw-alias-label-secondary, #999); flex-shrink: 0; }
.sshwsp-menuitem-text { flex: 1; min-width: 0; }
.sshwsp-menuitem-title { display: block; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-menuitem-desc { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary, #888); margin-top: 2px; line-height: 1.45; overflow-wrap: anywhere; }
.sshwsp-menusep { height: 1px; margin: 5px 8px; background: var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); }
.sshwsp-fileaction { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 12px; line-height: 1; white-space: nowrap; cursor: pointer; }
.sshwsp-fileaction:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-fileaction:disabled { opacity: 0.5; cursor: not-allowed; }
.sshwsp-pathbar { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06)); }
.sshwsp-pathbar-path { flex: 1; min-width: 0; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.sshwsp-warn { color: var(--dsw-alias-state-error-primary, #ff6b6b); font-size: 12px; line-height: 1.5; padding: 0 20px 12px; }
.sshwsp-dirlist { max-height: 260px; overflow-y: auto; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); }
@keyframes sshwsp-menu-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
@keyframes sshwsp-dialog-in { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
@keyframes sshwsp-fade-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .sshwsp-toast, .sshwsp-flowmenu, .sshwsp-dialog, .sshwsp-backdrop { animation: none; }
  .sshwsp-btn, .sshwsp-icon-btn, .sshwsp-entry { transition: none; }
}
      `
      document.head.appendChild(tag)
    }

    // =========================================================================
    // SVG Icons
    // =========================================================================
    // Two 45° chevrons facing each other — the remote-workspace mark. Geometry
    // traced 1:1 from the reference bitmap (29×28): right chevron apex
    // (16.5, 11.5) with arms to (20, 8)/(20, 15); left chevron apex
    // (16.5, 15.5) with arms to (12.5, 11.5)/(12.5, 19.5). The viewBox crops
    // to the drawn chevrons (plus a hair of padding) — the full 29×28 canvas
    // would render the mark tiny and thin at 16px.
    const REMOTE_MARK_VIEWBOX = '10.5 6.25 11.5 15'

    function RemoteMarkIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: REMOTE_MARK_VIEWBOX, width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M20 8 L16.5 11.5 L20 15' }),
        React.createElement('path', { d: 'M12.5 11.5 L16.5 15.5 L12.5 19.5' }),
      )
    }

    function ServerIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('rect', { x: 2, y: 2.5, width: 12, height: 4.5, rx: 1 }),
        React.createElement('rect', { x: 2, y: 9, width: 12, height: 4.5, rx: 1 }),
        React.createElement('circle', { cx: 4.5, cy: 4.75, r: 0.5, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: 4.5, cy: 11.25, r: 0.5, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function FolderIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M2 4.5v7a1.5 1.5 0 001.5 1.5h9a1.5 1.5 0 001.5-1.5v-5.5A1.5 1.5 0 0012.5 4.5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z' }),
      )
    }

    function FileIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M4 2h5.5L13 5.5V13a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z' }),
        React.createElement('path', { d: 'M9.5 2v3.5H13' }),
      )
    }

    function GlobeIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('circle', { cx: 8, cy: 8, r: 6 }),
        React.createElement('ellipse', { cx: 8, cy: 8, rx: 2.6, ry: 6 }),
        React.createElement('path', { d: 'M2 8h12' }),
      )
    }

    function ArrowLeftIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M12.5 8H3.5' }),
        React.createElement('path', { d: 'M7 4.5L3.5 8L7 11.5' }),
      )
    }

    function CloseIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M4 4l8 8' }),
        React.createElement('path', { d: 'M12 4l-8 8' }),
      )
    }

    // =========================================================================
    // Host card
    // =========================================================================
    function HostCard ({ host, t, conn, onTest, onBrowse, onEdit, onDelete, onForgetKey, onDisconnect, onReconnect, testState, deleteError, deleting }) {
      // null | 'delete' | 'forget' — only one confirmation row shows at a time.
      const [confirming, setConfirming] = React.useState(null)
      const [disconnecting, setDisconnecting] = React.useState(false)
      const [retrying, setRetrying] = React.useState(false)
      const testing = testState?.status === 'testing'
      const busy = (conn?.inFlight ?? 0) > 0
      // Only store entries are editable; ~/.ssh/config rows stay read-only.
      const editable = host.source === 'store'

      const actions = confirming === 'delete'
        ? [
            jsx('button', {
              key: 'confirm',
              className: 'sshwsp-btn sshwsp-btn-danger',
              disabled: deleting,
              onClick: () => onDelete(host.alias),
              children: deleting ? t('hosts.deleting') : t('hosts.deleteConfirm'),
            }),
            jsx('button', {
              key: 'cancel',
              className: 'sshwsp-btn',
              disabled: deleting,
              onClick: () => setConfirming(null),
              children: t('hosts.deleteCancel'),
            }),
          ]
        : confirming === 'forget'
          ? [
              jsx('button', {
                key: 'confirm',
                className: 'sshwsp-btn',
                onClick: () => { setConfirming(null); onForgetKey(host.alias) },
                children: t('hosts.forgetKeyConfirm'),
              }),
              jsx('button', {
                key: 'cancel',
                className: 'sshwsp-btn',
                onClick: () => setConfirming(null),
                children: t('hosts.deleteCancel'),
              }),
            ]
          : [
            jsx('button', {
              key: 'test',
              className: 'sshwsp-btn sshwsp-btn-primary',
              disabled: testing,
              onClick: () => onTest(host.alias),
              children: testing ? t('hosts.testing') : t('hosts.test'),
            }),
            conn && jsx('button', {
              key: 'disconnect',
              className: 'sshwsp-btn',
              disabled: busy || disconnecting,
              title: busy ? t('hosts.disconnectBusy') : undefined,
              onClick: async () => {
                setDisconnecting(true)
                try { await onDisconnect(host.alias) } finally { setDisconnecting(false) }
              },
              children: disconnecting ? t('hosts.disconnecting') : t('hosts.disconnect'),
            }),
            // Offered while a background retry is running or has stopped: the
            // loop may be waiting out a 60s backoff, and a user who just fixed
            // the network should not have to wait for it.
            (conn?.retry !== undefined) && jsx('button', {
              key: 'retry',
              className: 'sshwsp-btn',
              disabled: retrying,
              onClick: async () => {
                setRetrying(true)
                try { await onReconnect(host.alias) } finally { setRetrying(false) }
              },
              children: retrying ? t('connections.retrying') : t('connections.retry'),
            }),
            jsx('button', {
              key: 'browse',
              className: 'sshwsp-btn sshwsp-btn-primary',
              onClick: () => onBrowse(host.alias),
              children: t('hosts.browse'),
            }),
            editable && jsx('button', {
              key: 'edit',
              className: 'sshwsp-btn',
              onClick: () => onEdit(host),
              children: t('hosts.edit'),
            }),
            editable && jsx('button', {
              key: 'delete',
              className: 'sshwsp-btn sshwsp-btn-danger',
              onClick: () => setConfirming('delete'),
              children: t('hosts.delete'),
            }),
            // Offered for every host: keys are recorded per alias for store
            // and ~/.ssh/config hosts alike.
            jsx('button', {
              key: 'forget',
              className: 'sshwsp-btn',
              onClick: () => setConfirming('forget'),
              children: t('hosts.forgetKey'),
            }),
          ]

      // What the card can honestly say about this host. A background retry is
      // neither "connected" nor "just disconnected": it has an attempt number
      // and a next-attempt time, and the countdown must come from the server's
      // clock, not the browser's, or the two drift apart across a sleep.
      const now = Date.now()
      const retry = conn?.retry
      const retrySeconds = retry !== undefined && retry.nextAt > 0 && retry.phase === 'waiting'
        ? Math.max(0, Math.round((retry.nextAt - now) / 1000))
        : undefined
      const stateLabel = retry === undefined
        ? (conn === undefined ? undefined : t(`connections.${conn.state}`))
        : retry.phase === 'gave-up'
          ? t('connections.gaveUp')
          : retry.phase === 'connecting'
            ? t('connections.reconnectingNow', { n: retry.attempts })
            : t('connections.reconnecting', { n: retry.attempts, s: retrySeconds ?? 0 })
      const dotClass = retry !== undefined
        ? 'sshwsp-dot sshwsp-dot-warn'
        : conn === undefined
          ? ''
          : `sshwsp-dot ${conn.state === 'connected' ? 'sshwsp-dot-ok' : 'sshwsp-dot-err'}`

      return jsxs('div', { className: 'sshwsp-card sshwsp-host', children: [
        jsxs('div', { className: 'sshwsp-host-info', children: [
          jsxs('div', { className: 'sshwsp-host-alias', children: [
            jsx('span', { children: host.alias }),
            (conn !== undefined || retry !== undefined) && jsxs('span', { className: 'sshwsp-conn', children: [
              jsx('span', { className: dotClass }),
              jsx('span', {
                style: { color: retry !== undefined || conn.state !== 'connected' ? 'var(--dsw-alias-state-error-primary, #ff6b6b)' : 'var(--dsw-alias-state-success-primary, #4ade80)' },
                children: stateLabel,
              }),
              conn?.inFlight > 0 && jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary, #666)' }, children: t('connections.inFlight', { n: conn.inFlight }) }),
            ]}),
          ]}),
          retry !== undefined && retry.lastError !== '' && jsx('div', { className: 'sshwsp-error', children: retry.lastError }),
          jsx('div', { className: 'sshwsp-host-addr', children: `${host.user}@${host.host}:${host.port}` }),
          host.description && jsx('div', { className: 'sshwsp-host-desc', children: host.description }),
          jsxs('div', { className: 'sshwsp-host-meta', children: [
            jsx('span', { children: t(`hosts.auth.${host.auth}`) }),
            jsx('span', { children: '·' }),
            jsx('span', {
              className: host.keyReady ? 'sshwsp-status sshwsp-status-ok' : 'sshwsp-status sshwsp-status-warn',
              children: host.keyReady ? t('hosts.keyReady') : t('hosts.keyMissing'),
            }),
            jsx('span', { children: '·' }),
            jsx('span', { children: t(`hosts.source.${host.source === 'store' ? 'store' : 'sshConfig'}`) }),
          ]}),
          deleteError && jsx('div', { className: 'sshwsp-error', children: deleteError }),
        ]}),
        jsx('div', { className: 'sshwsp-host-actions', children: actions }),
        confirming !== null && jsx('div', { className: 'sshwsp-host-confirm', children:
          jsx('span', { children: confirming === 'delete' ? t('hosts.deleteDesc') : t('hosts.forgetKeyDesc') }),
        }),
      ]})
    }

    /**
     * Backdrop props that dismiss on a press which both STARTS and ENDS on the
     * backdrop itself.
     *
     * `click` alone is not enough: a click is targeted at the nearest common
     * ancestor of the press and the release, so dragging a text selection out of
     * the dialog and letting go over the backdrop dispatches a click whose target
     * IS the backdrop — the dialog vanishes mid-selection, which reads as "the
     * panel closed itself". The press target is the reliable signal.
     *
     * The flag is rewritten on every pointerdown and lives on the element, so a
     * press released outside the window (where no pointerup is delivered at all)
     * cannot leave a stale "pressed" behind: the next press — from inside the
     * dialog too, since events bubble here — overwrites it, and that press is
     * recorded as starting outside.
     *
     * Only the primary button arms it. `click` never fires for the secondary
     * button, so an ungated pointer handler would ADD a right-click dismissal to
     * dialogs that never had one, popping the context menu on top of it. The
     * release side stays ungated on purpose: touch and pen report `button` as -1
     * on pointerup in some engines, and gating there would break tap-to-dismiss.
     *
     * @param {() => void} close dismissal, already carrying its own busy guard.
     * @returns {object} the props to spread onto a `sshwsp-backdrop`.
     */
    function backdropDismiss (close) {
      return {
        onPointerDown: (event) => {
          event.currentTarget.__sshwspPressed =
            event.button === 0 && event.target === event.currentTarget
        },
        onPointerUp: (event) => {
          const pressed = event.currentTarget.__sshwspPressed === true
          event.currentTarget.__sshwspPressed = false
          if (pressed && event.target === event.currentTarget) close()
        },
      }
    }

    // =========================================================================
    // Host editor dialog (create / edit a store entry)
    // =========================================================================
    function HostEditor ({ host, t, onClose, onSaved }) {
      const editing = host !== null
      const [alias, setAlias] = React.useState(editing ? host.alias : '')
      const [hostName, setHostName] = React.useState(editing ? host.host : '')
      const [port, setPort] = React.useState(editing ? String(host.port ?? 22) : '22')
      const [user, setUser] = React.useState(editing ? host.user : '')
      const [authKind, setAuthKind] = React.useState(editing ? host.auth : 'key')
      const [keyPath, setKeyPath] = React.useState(editing && host.auth === 'key' ? (host.keyPath ?? '') : '')
      const [passphrase, setPassphrase] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [agentPath, setAgentPath] = React.useState(editing && host.auth === 'agent' ? (host.agentPath ?? '') : '')
      const [description, setDescription] = React.useState(editing && host.description ? host.description : '')
      const [agentForward, setAgentForward] = React.useState(editing && host.agentForward === true)
      const [compress, setCompress] = React.useState(editing && host.compress === true)
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState(null)

      // Secrets are never sent back to the browser, so an untouched field is
      // empty on edit — blank means "keep the stored one".
      const keepPassword = editing && host.auth === 'password'
      const keepPassphrase = editing && host.auth === 'key'

      const field = (label, hint, input) => jsxs('label', { className: 'sshwsp-field', children: [
        jsx('span', { className: 'sshwsp-field-label', children: label }),
        input,
        hint != null && jsx('span', { className: 'sshwsp-field-hint', children: hint }),
      ]})

      const input = (value, onChange, options = {}) => jsx('input', {
        className: 'sshwsp-input',
        value,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
        ...options,
      })

      // A checkbox row: label on the left, the box on the right, with an
      // optional hint underneath that explains the tradeoff.
      const checkbox = (label, hint, checked, onChange) => jsxs('label', { className: 'sshwsp-field sshwsp-check', children: [
        jsxs('span', { className: 'sshwsp-check-text', children: [
          jsx('span', { className: 'sshwsp-field-label', children: label }),
          hint != null && jsx('span', { className: 'sshwsp-field-hint', children: hint }),
        ]}),
        jsx('input', {
          type: 'checkbox',
          checked,
          onChange: (event) => onChange(event.target.checked),
        }),
      ]})

      const submit = async () => {
        if (!/^\d+$/u.test(port.trim())) { setError(t('editor.badPort')); return }
        const portNumber = Number.parseInt(port, 10)
        if (portNumber < 1 || portNumber > 65535) { setError(t('editor.badPort')); return }
        for (const [value, key] of [[alias, 'editor.alias'], [hostName, 'editor.host'], [user, 'editor.user']]) {
          if (value.trim() === '') { setError(t('editor.required', { field: t(key) })); return }
        }
        if (authKind === 'key' && keyPath.trim() === '') { setError(t('editor.required', { field: t('editor.keyPath') })); return }
        if (authKind === 'password' && password === '' && !keepPassword) { setError(t('editor.required', { field: t('editor.password') })); return }
        setSaving(true)
        setError(null)
        try {
          const result = await fetchJson(API.hostSave, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              originalAlias: editing ? host.alias : undefined,
              alias: alias.trim(),
              host: hostName.trim(),
              port: portNumber,
              user: user.trim(),
              auth: { kind: authKind, keyPath: keyPath.trim(), passphrase, password, agentPath: agentPath.trim() },
              description: description.trim(),
              agentForward,
              compress,
            }),
          })
          if (!result.ok) { setError(result.error ?? t('editor.saveFail')); return }
          onSaved?.()
        } catch (err) {
          setError(err.message)
        } finally {
          setSaving(false)
        }
      }

      // A save in flight must finish: unmounting here drops the request's only
      // feedback path while it is still writing to the host's store.
      const dismissBackdrop = () => { if (!saving) onClose() }

      return jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(dismissBackdrop), children: [
        jsxs('div', { className: 'sshwsp-dialog sshwsp-dialog-narrow', onClick: (event) => event.stopPropagation(), children: [
          jsx('div', { className: 'sshwsp-dialog-title', children: editing ? t('editor.title.edit') : t('editor.title.create') }),
          jsxs('div', { className: 'sshwsp-form', children: [
            field(t('editor.alias'), editing ? t('editor.aliasHintEdit') : t('editor.aliasHint'), input(alias, setAlias)),
            jsxs('div', { className: 'sshwsp-form-row', children: [
              field(t('editor.host'), null, input(hostName, setHostName)),
              jsxs('label', { className: 'sshwsp-field', style: { flex: '0 0 110px' }, children: [
                jsx('span', { className: 'sshwsp-field-label', children: t('editor.port') }),
                input(port, setPort, { inputMode: 'numeric' }),
              ]}),
            ]}),
            field(t('editor.user'), null, input(user, setUser)),
            field(t('editor.auth'), null,
              jsxs('select', {
                className: 'sshwsp-input',
                value: authKind,
                onChange: (event) => setAuthKind(event.target.value),
                children: [
                  jsx('option', { value: 'key', children: t('editor.authKind.key') }),
                  jsx('option', { value: 'password', children: t('editor.authKind.password') }),
                  jsx('option', { value: 'agent', children: t('editor.authKind.agent') }),
                ],
              })),
            authKind === 'key' && field(t('editor.keyPath'), t('editor.keyPathHint'), input(keyPath, setKeyPath)),
            authKind === 'key' && field(t('editor.passphrase'), keepPassphrase ? t('editor.secretKeep') : null, input(passphrase, setPassphrase, { type: 'password' })),
            authKind === 'password' && field(t('editor.password'), keepPassword ? t('editor.secretKeep') : null, input(password, setPassword, { type: 'password' })),
            authKind === 'agent' && field(t('editor.agentPath'), t('editor.agentPathHint'), input(agentPath, setAgentPath)),
            field(t('editor.description'), null, input(description, setDescription)),
            checkbox(t('editor.agentForward'), t('editor.agentForwardHint'), agentForward, setAgentForward),
            checkbox(t('editor.compress'), t('editor.compressHint'), compress, setCompress),
            error && jsx('div', { className: 'sshwsp-error', children: error }),
          ]}),
          jsxs('div', { className: 'sshwsp-dialog-footer', children: [
            jsx('button', { className: 'sshwsp-btn', onClick: onClose, disabled: saving, children: t('editor.cancel') }),
            jsx('button', { className: 'sshwsp-btn sshwsp-btn-primary', onClick: submit, disabled: saving, children: saving ? t('editor.saving') : t('editor.save') }),
          ]}),
        ]}),
      ]})
    }

    // =========================================================================
    // Directory browser dialog
    // =========================================================================
    function DirectoryBrowser ({ alias, onClose, onMount, t }) {
      // null until the first listing resolves — then the SSH login directory.
      const [path, setPath] = React.useState(null)
      const [entries, setEntries] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [mounting, setMounting] = React.useState(false)
      const [mountResult, setMountResult] = React.useState(null)
      // One transfer at a time: the entry name while it runs, so its row can
      // show progress and a second click cannot interleave two downloads.
      const [transferBusy, setTransferBusy] = React.useState(undefined)
      const [transferError, setTransferError] = React.useState(null)
      // Upload state is separate from download state: both can be idle at once,
      // and a failed upload must not clear a download's error or vice versa.
      const [uploadBusy, setUploadBusy] = React.useState(false)
      const [uploadError, setUploadError] = React.useState(null)
      const fileInputRef = React.useRef(null)
      const loadSeq = React.useRef(0)

      const loadDir = React.useCallback(async (p) => {
        const seq = ++loadSeq.current
        // Track the target immediately: the SSH round-trip must never leave the
        // displayed path (or the mount button) pointing at the previous directory.
        if (typeof p === 'string' && p !== '') setPath(p)
        setLoading(true)
        setError(null)
        setEntries(null)
        try {
          const query = typeof p === 'string' && p !== '' ? `&path=${encodeURIComponent(p)}` : ''
          const data = await fetchJson(`${API.ls}?alias=${encodeURIComponent(alias)}${query}`)
          if (seq !== loadSeq.current) return
          // Sort: directories first, then alphabetical.
          const sorted = (data.entries ?? []).sort((a, b) => {
            if (a.type === 'directory' && b.type !== 'directory') return -1
            if (a.type !== 'directory' && b.type === 'directory') return 1
            return a.name.localeCompare(b.name)
          })
          setEntries(sorted)
          if (typeof data.path === 'string' && data.path !== '') setPath(data.path)
        } catch (err) {
          if (seq === loadSeq.current) setError(err.message)
        } finally {
          if (seq === loadSeq.current) setLoading(false)
        }
      }, [alias])

      React.useEffect(() => { loadDir(null) }, [loadDir])

      const handleEntry = (entry) => {
        if (entry.type !== 'directory' || path == null) return
        const next = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`
        loadDir(next)
      }

      const handleUp = () => {
        if (path == null || path === '/') return
        const idx = path.lastIndexOf('/')
        const parent = idx <= 0 ? '/' : path.slice(0, idx)
        loadDir(parent)
      }

      /**
       * Send one local file into the directory currently being browsed.
       *
       * The bytes are posted as the raw request body (not multipart) so the
       * server can stream them straight into SFTP without a parser or a
       * temporary buffer; `path` is the directory already shown, so the file
       * lands where the user is looking rather than at a guessed root.
       */
      const handleUpload = async (file) => {
        if (path == null || file == null || uploadBusy) return
        setUploadBusy(true)
        setUploadError(null)
        try {
          const query = `?alias=${encodeURIComponent(alias)}&path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`
          const response = await fetch(`${API.upload}${query}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: file,
          })
          const text = await response.text().catch(() => '')
          let parsed
          try { parsed = JSON.parse(text) } catch { /* not JSON */ }
          if (!response.ok || parsed?.ok !== true) {
            throw new Error(parsed?.error ?? (text || `upload failed (${response.status})`))
          }
          await loadDir(path)
        } catch (err) {
          setUploadError(err.message)
        } finally {
          setUploadBusy(false)
        }
      }

      /** Open the hidden file picker, then upload whatever it returns. */
      const pickAndUpload = () => {
        if (path == null || uploadBusy) return
        const input = fileInputRef.current
        if (input == null) return
        input.value = ''
        input.click()
      }

      const handleFilePicked = (event) => {
        const file = event.target?.files?.[0]
        if (file !== undefined && file !== null) handleUpload(file)
      }

      /**
       * Pull one remote file down to the user's machine.
       *
       * The route streams the bytes back to this server, which hands them to the
       * browser as a blob so the ordinary download flow takes over. The bytes
       * never travel through the model, and `transferBusy` keeps one transfer at
       * a time so a second click cannot interleave progress with the first.
       */
      const handleDownload = async (entry) => {
        if (path == null || transferBusy) return
        const remotePath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`
        setTransferBusy(entry.name)
        setTransferError(null)
        try {
          const response = await fetch(`${API.download}?alias=${encodeURIComponent(alias)}&path=${encodeURIComponent(remotePath)}`)
          if (!response.ok) {
            const text = await response.text().catch(() => '')
            let message = text || `download failed (${response.status})`
            try {
              const parsed = JSON.parse(text)
              if (typeof parsed?.error === 'string' && parsed.error !== '') message = parsed.error
            } catch { /* not JSON */ }
            throw new Error(message)
          }
          const blob = await response.blob()
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = entry.name
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          URL.revokeObjectURL(url)
        } catch (err) {
          setTransferError(err.message)
        } finally {
          setTransferBusy(undefined)
        }
      }

      const handleMount = async () => {
        setMounting(true)
        setMountResult(null)
        try {
          const result = await fetchJson(API.mount, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias, remotePath: path, register: true }),
          })
          setMountResult(result)
          if (result.ok) onMount?.(result)
        } catch (err) {
          setMountResult({ ok: false, error: err.message })
        } finally {
          setMounting(false)
        }
      }

      const formatSize = (bytes) => {
        if (bytes == null) return ''
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
      }

      // A transfer in flight owns the dialog: dropping it here would hide the
      // only row that reports success or failure, on a request still running.
      const dismissBackdrop = () => {
        if (!mounting && !uploadBusy && transferBusy === undefined) onClose()
      }

      return jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(dismissBackdrop), children: [
        jsxs('div', { className: 'sshwsp-dialog', onClick: (e) => e.stopPropagation(), children: [
          jsx('div', { className: 'sshwsp-dialog-title', children: t('browser.title', { alias }) }),
          jsxs('div', { className: 'sshwsp-dialog-body', children: [
            jsxs('div', { className: 'sshwsp-browser', children: [
              jsxs('div', { className: 'sshwsp-browser-header', children: [
                jsx('button', {
                  className: 'sshwsp-btn',
                  disabled: path == null || path === '/',
                  onClick: handleUp,
                  children: t('browser.parent'),
                }),
                jsx('span', { className: 'sshwsp-browser-path', children: path ?? '…' }),
                jsx('button', {
                  className: 'sshwsp-btn',
                  disabled: path == null || uploadBusy,
                  title: t('browser.upload'),
                  onClick: pickAndUpload,
                  children: uploadBusy ? t('browser.uploading') : t('browser.upload'),
                }),
                jsx('input', {
                  ref: fileInputRef,
                  type: 'file',
                  style: { display: 'none' },
                  onChange: handleFilePicked,
                }),
              ]}),
              jsx('div', { className: 'sshwsp-browser-list', children:
                loading
                  ? jsx('div', { className: 'sshwsp-empty', children: t('browser.loading') })
                  : error
                    ? jsxs('div', { className: 'sshwsp-empty', children: [t('browser.error'), jsx('br', {}), jsx('span', { style: { fontSize: 11 }, children: error })] })
                    : entries?.length === 0
                      ? jsx('div', { className: 'sshwsp-empty', children: t('browser.empty') })
                      : entries?.map((entry) =>
                          jsxs('div', {
                            key: entry.name,
                            className: 'sshwsp-entry',
                            onClick: () => handleEntry(entry),
                            style: { cursor: entry.type === 'directory' ? 'pointer' : 'default' },
                            children: [
                              jsx('span', { className: 'sshwsp-entry-icon', children:
                                entry.type === 'directory'
                                  ? React.createElement(FolderIcon)
                                  : React.createElement(FileIcon),
                              }),
                              jsx('span', { className: 'sshwsp-entry-name', children: entry.name }),
                              entry.type !== 'directory' && jsx('span', { className: 'sshwsp-entry-meta', children: formatSize(entry.size) }),
                              entry.type !== 'directory' && jsx('button', {
                                className: 'sshwsp-icon-btn',
                                title: t('browser.download'),
                                'aria-label': t('browser.download'),
                                disabled: transferBusy !== undefined,
                                onClick: (event) => {
                                  event.stopPropagation()
                                  handleDownload(entry)
                                },
                                children: transferBusy === entry.name ? '…' : '↓',
                              }),
                            ],
                          })
                        )
              }),
            ]}),
            uploadError && jsxs('div', {
              className: 'sshwsp-status sshwsp-status-err',
              style: { marginTop: 8, padding: '8px 12px', borderRadius: 6 },
              children: [`${t('browser.uploadFail')}: `, uploadError],
            }),
            // A failed download names itself instead of vanishing into a toast
            // the user may miss while the dialog is open.
            transferError && jsxs('div', {
              className: 'sshwsp-status sshwsp-status-err',
              style: { marginTop: 8, padding: '8px 12px', borderRadius: 6 },
              children: [`${t('browser.downloadFail')}: `, transferError],
            }),
            mountResult && jsx('div', {
              className: mountResult.ok
                ? 'sshwsp-status sshwsp-status-ok'
                : 'sshwsp-status sshwsp-status-err',
              style: { marginTop: 12, padding: '8px 12px', borderRadius: 6 },
              children: mountResult.ok
                ? t('browser.mountOk', { path: mountResult.workspacePath })
                : `${t('browser.mountFail')}: ${mountResult.error ?? 'unknown'}`,
            }),
            // Capability advisories: only a tool the probe proved missing gets a
            // line, so an unprobeable host stays quiet instead of guessing.
            mountResult?.capabilities && jsxs('div', {
              style: { marginTop: 8, fontSize: 11, opacity: 0.8, display: 'flex', flexDirection: 'column', gap: 2 },
              children: capabilityNotes(mountResult.capabilities, t).map((note, index) => jsx('div', { key: index, children: note })),
            }),
          ]}),
          jsxs('div', { className: 'sshwsp-dialog-footer', children: [
            jsx('button', { className: 'sshwsp-btn', onClick: onClose, children: t('dialog.close') }),
            jsx('button', {
              className: 'sshwsp-btn sshwsp-btn-primary',
              disabled: mounting || path == null || mountResult?.ok === true,
              onClick: handleMount,
              children: mounting ? t('browser.mounting') : t('browser.mount'),
            }),
          ]}),
        ]}),
      ]})
    }

    // =========================================================================
    // Main panel
    // =========================================================================
    /** The local URL a forward is reachable at. */
    function forwardUrlOf (forward) {
      const host = forward.localHost === '0.0.0.0' || forward.localHost === '::' ? 'localhost' : forward.localHost
      return `http://${host}:${forward.localPort}`
    }

    /** How many rows a section shows before it starts scrolling. */
    const LIST_CAP = 5

    /** Layout effect when there is a DOM, plain effect otherwise. */
    const useLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

    /**
     * Cap a section at LIST_CAP visible rows and scroll the rest.
     *
     * A `slice(0, 5)` would silently drop rows, which for a control panel is
     * worse than a long list: a tunnel you cannot see is a tunnel you cannot
     * turn off. The cap is a viewport, not a truncation — every row stays
     * reachable by scrolling, so it never removes an action.
     *
     * The height is MEASURED, not assumed. Rows in these sections are not a
     * uniform height: a host card grows with its description and with a
     * confirmation row, a forward row grows when an error line appears, and
     * any row can wrap taller on a narrow panel. A hardcoded `5 * 64px` would
     * show four and a half rows on one row shape and only three on another.
     * We sum the first LIST_CAP rows plus the flex gap, then pin that as the
     * max height — the exact boundary where the 6th row starts to scroll.
     *
     * Re-measure is driven by the rows themselves (not the box): a width
     * change reflows the rows, their heights change, and the observer fires.
     * Observing the box instead would feed back into itself, since we are the
     * ones setting its height.
     */
    function CappedList ({ className, children }) {
      const ref = React.useRef(null)
      const [capHeight, setCapHeight] = React.useState(null)
      const rows = React.Children.toArray(children)

      useLayoutEffect(() => {
        const el = ref.current
        if (el === null || typeof ResizeObserver === 'undefined') return undefined
        const measure = () => {
          const items = Array.from(el.children)
          if (items.length <= LIST_CAP) {
            setCapHeight(null)
            return
          }
          const style = window.getComputedStyle(el)
          const gap = Number.parseFloat(style.rowGap || style.gap || '0') || 0
          let height = gap * (LIST_CAP - 1)
          for (const item of items.slice(0, LIST_CAP)) height += item.getBoundingClientRect().height
          // +1 rounds the fractional pixels up rather than down: a sub-pixel
          // short cap would clip the fifth row and show a scrollbar early.
          setCapHeight(Math.ceil(height) + 1)
        }
        measure()
        const observer = new ResizeObserver(measure)
        for (const item of Array.from(el.children)) observer.observe(item)
        return () => observer.disconnect()
      }, [rows.length])

      return jsx('div', {
        ref,
        className: capHeight === null ? `sshwsp-cap ${className}` : `sshwsp-cap sshwsp-cap-scroll ${className}`,
        style: capHeight === null ? undefined : { maxHeight: `${capHeight}px` },
        children: rows,
      })
    }

    /**
     * Advisory notes for a capability probe result.
     *
     * Mirrors the tool-side wording: a capability the probe could not
     * determine is omitted rather than reported as missing.
     */
    function capabilityNotes (capabilities, t) {
      const notes = []
      if (capabilities.rg === false) notes.push(t('caps.rg'))
      if (capabilities.git === false) notes.push(t('caps.git'))
      if (capabilities.inotifywait === false) notes.push(t('caps.inotifywait'))
      return notes
    }

    function RemoteWorkspacePanel ({ t }) {
      const [hosts, setHosts] = React.useState([])
      const [status, setStatus] = React.useState({ mounted: [], disabled: [], connections: [], forwards: [], forwardRows: [], forwardSettings: { autoStart: false } })
      const [testStates, setTestStates] = React.useState({})
      const [browserAlias, setBrowserAlias] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      // undefined = closed, null = create, a host row = edit that host.
      const [editorHost, setEditorHost] = React.useState(undefined)
      const [deletingAlias, setDeletingAlias] = React.useState(null)
      const [deleteErrors, setDeleteErrors] = React.useState({})
      const [toast, setToast] = React.useState(null)
      const [forwardAlias, setForwardAlias] = React.useState('')
      const [forwardRemotePort, setForwardRemotePort] = React.useState('')
      const [forwardLocalPort, setForwardLocalPort] = React.useState('')
      const [forwardBusy, setForwardBusy] = React.useState(false)
      // Which saved row is mid-toggle, so only that row's button shows progress.
      const [forwardRowBusy, setForwardRowBusy] = React.useState(null)
      const [forwardDeleteId, setForwardDeleteId] = React.useState(null)
      // Advisory local-port verdict for the form, keyed by "host:port".
      const [portCheck, setPortCheck] = React.useState(null)
      // Which workspace row has an armed unmount confirmation, and the mode it
      // would run with. Arming is separate state so the first click is
      // reversible and cannot unload a workspace by accident.
      const [unmountConfirm, setUnmountConfirm] = React.useState(null)
      const [unmountMode, setUnmountMode] = React.useState('detach')
      const [unmountBusy, setUnmountBusy] = React.useState(null)
      const [enableBusy, setEnableBusy] = React.useState(null)

      // Transient test-connection result: auto-dismiss after a few seconds,
      // click to dismiss early. A fresh object per toast restarts the timer.
      React.useEffect(() => {
        if (toast === null) return undefined
        const timer = setTimeout(() => setToast(null), 3500)
        return () => clearTimeout(timer)
      }, [toast])

      const refresh = React.useCallback(async () => {
        setLoading(true)
        try {
          const [hostsData, statusData] = await Promise.all([
            fetchJson(API.hosts),
            fetchJson(API.status),
          ])
          setHosts(hostsData.hosts ?? [])
          setStatus(statusData)
          syncRemoteWorkspaceMarks(statusData.workspaces, statusData.disabled)
        } catch { /* silent */ }
        finally { setLoading(false) }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      /**
       * Probe one host: connect, prove it works, then let the connection go.
       *
       * "Test" answers "does this host answer at all" — it is not a way to open
       * a session. The server releases the connection it just proved (unless an
       * open port forward pins it), so the panel's connection indicator does not
       * light up from a mere probe. The refresh below therefore reports what is
       * actually left rather than assuming the test left a connection behind.
       */
      const handleTest = async (alias) => {
        setTestStates((prev) => ({ ...prev, [alias]: { status: 'testing' } }))
        try {
          const result = await fetchJson(API.test, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          setTestStates((prev) => ({
            ...prev,
            [alias]: { status: result.ok ? 'ok' : 'failed', durationMs: result.durationMs, error: result.error },
          }))
          setToast(result.ok
            ? { kind: 'ok', text: t('hosts.testOk', { ms: result.durationMs }) }
            : { kind: 'err', text: `${t('hosts.testFail')}${result.error ? `: ${result.error}` : ''}` })
          // The probe released its connection, so the indicator must be
          // re-read rather than optimistically marked connected.
          const s = await fetchJson(API.status)
          setStatus(s)
        } catch (err) {
          setTestStates((prev) => ({
            ...prev,
            [alias]: { status: 'failed', error: err.message },
          }))
          setToast({ kind: 'err', text: `${t('hosts.testFail')}: ${err.message}` })
        }
      }

      const handleDelete = async (alias) => {
        setDeletingAlias(alias)
        setDeleteErrors((prev) => {
          const next = { ...prev }
          delete next[alias]
          return next
        })
        try {
          const result = await fetchJson(API.hostDelete, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            setDeleteErrors((prev) => ({ ...prev, [alias]: result.error ?? t('hosts.deleteFail') }))
          } else {
            await refresh()
          }
        } catch (err) {
          setDeleteErrors((prev) => ({ ...prev, [alias]: err.message }))
        } finally {
          setDeletingAlias(null)
        }
      }

      const handleForgetKey = async (alias) => {
        try {
          const result = await fetchJson(API.hostForgetKey, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            setToast({ kind: 'err', text: `${t('hosts.forgetKeyFail')}${result.error ? `: ${result.error}` : ''}` })
          } else {
            setToast({ kind: 'ok', text: t('hosts.forgetKeyOk') })
            // The pooled connection was dropped server-side; refresh so the
            // connection rows stop claiming it is still up.
            const s = await fetchJson(API.status)
            setStatus(s)
          }
        } catch (err) {
          setToast({ kind: 'err', text: `${t('hosts.forgetKeyFail')}: ${err.message}` })
        }
      }

      const handleDisconnect = async (alias) => {
        try {
          const result = await fetchJson(API.hostDisconnect, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            setToast({ kind: 'err', text: `${t('hosts.disconnectFail')}${result.error ? `: ${result.error}` : ''}` })
            return
          }
          // Report the tunnels too: they went away because the user asked for
          // it, and saying so is what keeps this from looking like the failure
          // the panel would otherwise show for a dropped connection.
          const closedForwards = Number(result.closedForwards ?? 0)
          setToast({
            kind: 'ok',
            text: closedForwards > 0
              ? t('hosts.disconnectOkForwards').replace('{n}', String(closedForwards))
              : t('hosts.disconnectOk'),
          })
          // The connection is gone server-side; refresh so the indicator follows.
          try {
            const s = await fetchJson(API.status)
            setStatus(s)
          } catch { /* best-effort refresh */ }
        } catch (err) {
          setToast({ kind: 'err', text: `${t('hosts.disconnectFail')}: ${err.message}` })
        }
      }

      /**
       * Skip the backoff and try now.
       *
       * Reports the real error rather than a hopeful "retrying": the background
       * loop already prints its own progress on the card, so a manual attempt
       * that failed must not look like it worked.
       */
      const handleReconnect = async (alias) => {
        try {
          const result = await fetchJson(API.hostReconnect, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            setToast({ kind: 'err', text: `${t('connections.retryFail')}${result.error ? `: ${result.error}` : ''}` })
            return
          }
          setToast({ kind: 'ok', text: t('connections.retryOk') })
          try {
            const s = await fetchJson(API.status)
            setStatus(s)
          } catch { /* best-effort refresh */ }
        } catch (err) {
          setToast({ kind: 'err', text: `${t('connections.retryFail')}: ${err.message}` })
        }
      }

      /**
       * Unload one workspace.
       *
       * Two steps on purpose. The first click only arms the row, because this
       * touches every session the workspace accounts for; the second click is
       * what actually runs it. The confirm text states what survives —
       * "archived" is not "deleted", and that distinction is the whole reason
       * this is reversible.
       *
       * Whether sessions are archived is decided by the mode, not sent as a
       * separate constant: keeping the workspace record (the default) means
       * the sidebar group and its sessions must stay, so archiving them would
       * empty the group the user chose to keep.
       */
      const handleUnmount = async (workspacePath, mode) => {
        setUnmountBusy(workspacePath)
        try {
          const effectiveMode = mode ?? 'detach'
          const result = await fetchJson(API.unmount, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspacePath, mode: effectiveMode }),
          })
          if (!result.ok) {
            setToast({ kind: 'err', text: `${t('mounted.detachFail')}${result.error ? `: ${result.error}` : ''}` })
          } else if ((result.archiveFailed ?? []).length > 0) {
            setToast({ kind: 'err', text: `${t('mounted.detachPartial')}: ${result.archiveFailed.length}` })
          } else if (effectiveMode === 'detach') {
            // No sessions were archived on purpose: the group stays populated.
            setToast({ kind: 'ok', text: t('mounted.detachOkKeep') })
          } else {
            setToast({ kind: 'ok', text: t('mounted.detachOk').replace('{n}', String((result.archived ?? []).length)) })
          }
          setUnmountConfirm(null)
          await refresh()
        } catch (err) {
          setToast({ kind: 'err', text: `${t('mounted.detachFail')}: ${err.message}` })
        } finally {
          setUnmountBusy(null)
        }
      }

      /** Mount a detached workspace again and unarchive its sessions. */
      const handleEnable = async (workspacePath) => {
        setEnableBusy(workspacePath)
        try {
          const result = await fetchJson(API.enable, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspacePath, unarchiveSessions: true }),
          })
          if (!result.ok) {
            setToast({ kind: 'err', text: `${t('detached.enableFail')}${result.error ? `: ${result.error}` : ''}` })
          } else {
            setToast({ kind: 'ok', text: t('detached.enableOk').replace('{path}', workspacePath) })
          }
          await refresh()
        } catch (err) {
          setToast({ kind: 'err', text: `${t('detached.enableFail')}: ${err.message}` })
        } finally {
          setEnableBusy(null)
        }
      }

      const handleForward = async () => {
        const remotePort = Number.parseInt(forwardRemotePort.trim(), 10)
        const localPortText = forwardLocalPort.trim()
        const localPort = localPortText === '' ? remotePort : Number.parseInt(localPortText, 10)
        const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535
        if (!validPort(remotePort) || !validPort(localPort)) {
          setToast({ kind: 'err', text: t('editor.badPort') })
          return
        }
        setForwardBusy(true)
        try {
          // A saved mapping pins its local port, so the form always sends one
          // (defaulting to the remote port) rather than asking for an ephemeral
          // port the store could not describe.
          const result = await fetchJson(API.forwardSave, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias: forwardAlias, remotePort, localPort }),
          })
          if (!result.ok) {
            setToast({ kind: 'err', text: `${t('forwards.fail')}: ${result.error ?? ''}` })
          } else {
            setForwardRemotePort('')
            setForwardLocalPort('')
            if (result.error !== undefined) setToast({ kind: 'err', text: `${t('forwards.fail')}: ${result.error}` })
          }
          await refresh()
        } catch (err) {
          setToast({ kind: 'err', text: `${t('forwards.fail')}: ${err.message}` })
        } finally {
          setForwardBusy(false)
          setPortCheck(null)
        }
      }

      /**
       * Check the local port the form would bind, before the user commits.
       *
       * Runs on blur rather than on every keystroke: a probe binds a real
       * listener, and doing that per character would both spam the OS and race
       * the user's typing. The verdict is advisory — the save path probes again
       * and the bind itself stays authoritative.
       */
      const checkForwardPort = async () => {
        const remotePort = Number.parseInt(forwardRemotePort.trim(), 10)
        const localPortText = forwardLocalPort.trim()
        const localPort = localPortText === '' ? remotePort : Number.parseInt(localPortText, 10)
        if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) { setPortCheck(null); return }
        const key = `127.0.0.1:${localPort}`
        setPortCheck({ key, state: 'checking' })
        try {
          const url = `${API.forwardProbe}?localHost=127.0.0.1&localPort=${localPort}`
          const result = await fetchJson(url)
          setPortCheck({ key, state: result.available === true ? 'free' : 'busy', code: result.code })
        } catch {
          // A probe that cannot run must not block the form: the save path is
          // the authority, and a failed probe says nothing about the port.
          setPortCheck(null)
        }
      }

      const handleForwardToggle = async (row) => {
        setForwardRowBusy(row.id)
        try {
          const result = await fetchJson(API.forwardToggle, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // The requested state comes from the runtime fact, not from the
            // stored intent: a row whose intent is on but whose tunnel died is
            // still showing "turn on".
            body: JSON.stringify({ id: row.id, enabled: row.live !== true }),
          })
          if (!result.ok) {
            setToast({ kind: 'err', text: `${t('forwards.fail')}: ${result.error ?? ''}` })
          }
          await refresh()
        } catch (err) {
          setToast({ kind: 'err', text: `${t('forwards.fail')}: ${err.message}` })
        } finally {
          setForwardRowBusy(null)
        }
      }

      const handleForwardRemember = async (id) => {
        setForwardRowBusy(id)
        try {
          const result = await fetchJson(API.forwardRemember, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          if (!result.ok) setToast({ kind: 'err', text: `${t('forwards.fail')}: ${result.error ?? ''}` })
          await refresh()
        } catch (err) {
          setToast({ kind: 'err', text: `${t('forwards.fail')}: ${err.message}` })
        } finally {
          setForwardRowBusy(null)
        }
      }

      const handleForwardDelete = async (id) => {
        setForwardRowBusy(id)
        try {
          await fetchJson(API.forwardDelete, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          setForwardDeleteId(null)
          await refresh()
        } catch { /* silent */ } finally {
          setForwardRowBusy(null)
        }
      }

      /** Persist the auto-start preference. Optimistic, rolled back on failure. */
      const handleAutoStart = async (next) => {
        setStatus((prev) => ({ ...prev, forwardSettings: { ...(prev.forwardSettings ?? {}), autoStart: next } }))
        try {
          const result = await fetchJson(API.forwardSettings, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoStart: next }),
          })
          if (!result.ok) {
            setStatus((prev) => ({ ...prev, forwardSettings: { ...(prev.forwardSettings ?? {}), autoStart: !next } }))
            setToast({ kind: 'err', text: result.error ?? '' })
          }
        } catch (err) {
          setStatus((prev) => ({ ...prev, forwardSettings: { ...(prev.forwardSettings ?? {}), autoStart: !next } }))
          setToast({ kind: 'err', text: err.message })
        }
      }

      const handleUnforward = async (id) => {
        try {
          await fetchJson(API.unforward, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          refresh()
        } catch { /* silent */ }
      }
      // Merge the background-retry rows onto the connection rows. A host that
      // dropped out of the pool entirely still has a retry entry, so keying off
      // `connections` alone would hide exactly the host the user needs to see.
      const connMap = new Map()
      for (const c of status.connections ?? []) connMap.set(c.alias, { ...c })
      for (const retry of status.reconnecting ?? []) {
        connMap.set(retry.alias, { ...(connMap.get(retry.alias) ?? { alias: retry.alias, state: 'broken', inFlight: 0 }), retry })
      }

      // While a retry is pending the countdown must move. The panel otherwise
      // only refreshes on user action, so "in 12s" would sit there frozen.
      // Skipped while the tab is hidden: a background tab polling a host that is
      // failing to connect is pure noise, and the first visible tick catches up.
      const retrying = (status.reconnecting ?? []).length > 0
      React.useEffect(() => {
        if (!retrying) return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden === true) return
          refresh()
        }, 5000)
        return () => clearInterval(timer)
      }, [retrying, refresh])

      return jsxs('div', { className: 'sshwsp', children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }, children: [
          jsx('h2', { style: { margin: 0 }, children: t('panel.title') }),
          jsx('button', { className: 'sshwsp-btn', onClick: refresh, disabled: loading, children: t('refresh') }),
        ]}),

        // ---- Hosts
        jsxs('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('hosts.title') }),
          jsx('button', { className: 'sshwsp-btn', onClick: () => setEditorHost(null), children: t('hosts.add') }),
        ]}),
        hosts.length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: loading ? t('panel.loading') : t('panel.empty') })
          : jsx(CappedList, {
              className: 'sshwsp-hosts',
              children: hosts.map((host) => jsx(HostCard, {
                key: host.alias,
                host,
                t,
                conn: connMap.get(host.alias),
                onTest: handleTest,
                onBrowse: setBrowserAlias,
                onEdit: (row) => setEditorHost(row),
                onDelete: handleDelete,
                onForgetKey: handleForgetKey,
                onDisconnect: handleDisconnect,
                onReconnect: handleReconnect,
                testState: testStates[host.alias],
                deleteError: deleteErrors[host.alias],
                deleting: deletingAlias === host.alias,
              })),
            }),

        // ---- Port forwards
        jsx('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('forwards.title') }),
        ]}),
        jsxs('div', { className: 'sshwsp-forward-new', children: [
          jsx('select', {
            className: 'sshwsp-input sshwsp-select',
            value: forwardAlias,
            disabled: forwardBusy || hosts.length === 0,
            onChange: (event) => setForwardAlias(event.target.value),
            children: [
              jsx('option', { value: '', children: t('remote.host') }),
              ...hosts.map((host) => jsx('option', { key: host.alias, value: host.alias, children: host.alias })),
            ],
          }),
          jsx('input', {
            className: 'sshwsp-input sshwsp-input-port',
            type: 'number',
            min: 1,
            max: 65535,
            // The box is deliberately narrow, so the placeholder is also the
            // only label: title keeps the full meaning reachable when the
            // text clips.
            placeholder: t('forwards.remotePort'),
            title: t('forwards.remotePort'),
            value: forwardRemotePort,
            disabled: forwardBusy,
            onChange: (event) => { setForwardRemotePort(event.target.value); setPortCheck(null) },
            onKeyDown: (event) => { if (event.key === 'Enter') handleForward() },
          }),
          jsx('input', {
            className: 'sshwsp-input sshwsp-input-port',
            type: 'number',
            min: 1,
            max: 65535,
            placeholder: t('forwards.localPlaceholder'),
            title: `${t('forwards.localPort')} — ${t('forwards.localPlaceholder')}`,
            value: forwardLocalPort,
            disabled: forwardBusy,
            onChange: (event) => { setForwardLocalPort(event.target.value); setPortCheck(null) },
            onBlur: checkForwardPort,
            onKeyDown: (event) => { if (event.key === 'Enter') handleForward() },
          }),
          jsx('button', {
            className: 'sshwsp-btn sshwsp-btn-primary',
            disabled: forwardBusy || forwardAlias === '' || forwardRemotePort.trim() === '',
            onClick: handleForward,
            children: forwardBusy ? t('forwards.saving') : t('forwards.save'),
          }),
        ]}),
        // The probe is advisory: it names the reason early, but the save path
        // probes again and the real bind stays the authority.
        portCheck !== null && jsx('div', {
          className: `sshwsp-porthint ${portCheck.state === 'busy' ? 'sshwsp-porthint-busy' : portCheck.state === 'free' ? 'sshwsp-porthint-free' : ''}`,
          children: portCheck.state === 'checking'
            ? t('forwards.checking')
            : portCheck.state === 'free'
              ? t('forwards.portFree')
              : portCheck.code === 'EADDRINUSE' ? t('forwards.portBusy') : t('forwards.portReserved'),
        }),
        jsx('label', {
          className: 'sshwsp-check sshwsp-forward-autostart',
          // The explanation is a hover tooltip rather than a permanent line:
          // it only matters the first time, and leaving it inline pushed the
          // saved-mapping list down on every render.
          title: t('forwards.autoStartHint'),
          // Checkbox first, label second: the box sits to the LEFT of the title.
          children: [
            jsx('input', {
              type: 'checkbox',
              checked: status.forwardSettings?.autoStart === true,
              onChange: (event) => handleAutoStart(event.target.checked),
            }),
            jsxs('span', { className: 'sshwsp-check-text', children: [
              jsx('span', { className: 'sshwsp-field-label', children: t('forwards.autoStart') }),
            ]}),
          ],
        }),
        (status.forwardRows ?? []).length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('forwards.none') })
          : jsx(CappedList, { className: 'sshwsp-forwards', children: (status.forwardRows ?? []).map((forward) => {
              const busy = forwardRowBusy === forward.id
              const live = forward.live === true
              const url = forwardUrlOf(forward)
              return jsxs('div', {
                key: forward.id,
                className: `sshwsp-mount sshwsp-forward-row${live ? '' : ' sshwsp-forward-off'}`,
                children: [
                  jsx('span', {
                    className: 'sshwsp-mount-path',
                    children: `${forward.localHost}:${forward.localPort} → ${forward.alias}:${forward.remoteHost}:${forward.remotePort}`,
                  }),
                  // The state chip reports the runtime fact; the stored intent
                  // only decides whether a tunnel comes back on startup.
                  jsx('span', {
                    className: `sshwsp-status ${live ? 'sshwsp-status-ok' : 'sshwsp-status-warn'}`,
                    children: live ? t('forwards.enabled') : t('forwards.disabled'),
                  }),
                  live && forward.connections > 0 && jsx('span', { className: 'sshwsp-entry-meta', children: t('forwards.connections', { n: forward.connections }) }),
                  !live && typeof forward.error === 'string' && forward.error !== '' && jsx('span', {
                    className: 'sshwsp-error sshwsp-forward-error',
                    title: forward.error,
                    children: forward.error.includes('connection') ? t('forwards.lost') : forward.error,
                  }),
                  live && jsx('a', {
                    className: 'sshwsp-btn',
                    href: url,
                    target: '_blank',
                    rel: 'noreferrer',
                    children: t('forwards.open'),
                  }),
                  forward.persisted === true
                    ? jsx('button', {
                        className: 'sshwsp-btn',
                        disabled: busy,
                        // Label follows the runtime fact, so a dead tunnel never
                        // shows "turn off".
                        onClick: () => handleForwardToggle(forward),
                        children: busy ? t('forwards.busy') : live ? t('forwards.disable') : t('forwards.enable'),
                      })
                    : jsxs(Fragment, { children: [
                        // A transient tunnel (opened by the agent tool) can be
                        // closed here too, but it has no stored row to toggle:
                        // it can only be closed or kept.
                        jsx('button', {
                          className: 'sshwsp-btn sshwsp-btn-danger',
                          disabled: busy,
                          onClick: () => handleUnforward(forward.id),
                          children: t('forwards.close'),
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn',
                          disabled: busy,
                          title: t('forwards.rememberHint'),
                          onClick: () => handleForwardRemember(forward.id),
                          children: busy ? t('forwards.busy') : t('forwards.remember'),
                        }),
                      ]}),
                  forward.persisted === true && forwardDeleteId === forward.id
                    ? jsxs(Fragment, { children: [
                        jsx('button', {
                          className: 'sshwsp-btn sshwsp-btn-danger',
                          disabled: busy,
                          onClick: () => handleForwardDelete(forward.id),
                          children: t('forwards.deleteConfirm'),
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn',
                          disabled: busy,
                          onClick: () => setForwardDeleteId(null),
                          children: t('editor.cancel'),
                        }),
                      ]})
                    : forward.persisted === true && jsx('button', {
                        className: 'sshwsp-btn sshwsp-btn-danger',
                        disabled: busy,
                        onClick: () => setForwardDeleteId(forward.id),
                        children: t('forwards.delete'),
                      }),
                  // A saved row that is not live but whose intent is on means
                  // the tunnel went away by itself — clarify that it will come
                  // back only when auto-start is on and the plugin restarts.
                  forward.persisted === true && !live && forward.enabled === true && jsx('span', {
                    className: 'sshwsp-entry-meta',
                    children: status.forwardSettings?.autoStart === true ? t('forwards.autoStart') : '',
                  }),
                ],
              })
            })}),

        // ---- Mounted workspaces
        jsx('h3', { children: t('mounted.title') }),
        (status.mounted ?? []).length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('mounted.none') })
          : jsx(CappedList, { className: 'sshwsp-mounts', children: (status.mounted ?? []).map((wsPath) => {
              const armed = unmountConfirm === wsPath
              const busy = unmountBusy === wsPath
              return jsxs('div', { key: wsPath, className: 'sshwsp-mount', children: [
                React.createElement(RemoteMarkIcon, { size: 16, className: 'sshwsp-entry-icon' }),
                jsx('span', { className: 'sshwsp-mount-path', children: wsPath }),
                armed
                  ? jsxs(Fragment, { children: [
                      jsx('label', {
                        className: 'sshwsp-check',
                        children: [
                          jsx('input', {
                            type: 'checkbox',
                            checked: unmountMode === 'deregister',
                            onChange: (event) => setUnmountMode(event.target.checked ? 'deregister' : 'detach'),
                          }),
                          jsx('span', { children: t('mounted.removeRecord') }),
                        ],
                      }),
                      jsx('button', {
                        className: 'sshwsp-btn sshwsp-btn-danger',
                        disabled: busy,
                        // Same tooltip as the unarmed button: this IS that button
                        // once armed, and the armed state is the moment the
                        // consequence matters most — dropping the hint here would
                        // hide it exactly when the click becomes irreversible.
                        title: t('mounted.detachHint'),
                        onClick: () => handleUnmount(wsPath, unmountMode),
                        children: busy ? t('mounted.unmounting') : t('mounted.confirmDetach'),
                      }),
                      jsx('button', {
                        className: 'sshwsp-btn',
                        disabled: busy,
                        onClick: () => { setUnmountConfirm(null); setUnmountMode('detach') },
                        children: t('editor.cancel'),
                      }),
                    ]})
                  : jsx('button', {
                      className: 'sshwsp-btn sshwsp-btn-danger',
                      disabled: busy,
                      title: t('mounted.detachHint'),
                      onClick: () => { setUnmountConfirm(wsPath); setUnmountMode('detach') },
                      children: t('mounted.unmount'),
                    }),
              ]})
            })}),

        // ---- Detached workspaces
        // Always rendered: an empty section is how the user learns that
        // "unmount" leaves something behind to re-enable, and where it went.
        jsx('h3', { children: t('detached.title') }),
        (status.disabled ?? []).length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('detached.none') })
          : jsxs(Fragment, { children: [
              jsx('div', { className: 'sshwsp-entry-meta', children: t('detached.hint') }),
              jsx(CappedList, { className: 'sshwsp-mounts', children: (status.disabled ?? []).map((wsPath) => {
                const busy = enableBusy === wsPath
                return jsxs('div', { key: wsPath, className: 'sshwsp-mount sshwsp-mount-off', children: [
                  jsx('span', { className: 'sshwsp-mount-path', children: wsPath }),
                  jsx('span', { className: 'sshwsp-entry-meta', children: t('detached.badge') }),
                  jsx('button', {
                    className: 'sshwsp-btn',
                    disabled: busy,
                    onClick: () => handleEnable(wsPath),
                    children: busy ? t('detached.enabling') : t('detached.enable'),
                  }),
                ]})
              })}),
            ]}),

        // ---- Persistent remote shells
        // Only shown once the agent has opened one: an empty section would
        // suggest a control this panel does not own.
        (status.shells ?? []).length > 0 && jsxs('div', { children: [
          jsx('h3', { children: t('shells.title') }),
          (status.shells ?? []).map((shell) => jsxs('div', {
            key: `${shell.alias}:${shell.session}`,
            className: 'sshwsp-mount',
            children: [
              jsx('span', { className: 'sshwsp-mount-path', children: `${shell.alias} [${shell.session}]` }),
              jsx('span', {
                className: 'sshwsp-entry-meta',
                children: shell.alive ? t('shells.alive') : t('shells.closed'),
              }),
            ],
          })),
        ]}),

        // ---- Browser dialog
        browserAlias !== null && jsx(DirectoryBrowser, {
          alias: browserAlias,
          onClose: () => setBrowserAlias(null),
          onMount: () => { refresh(); setBrowserAlias(null) },
          t,
        }),

        // ---- Host editor dialog
        editorHost !== undefined && jsx(HostEditor, {
          host: editorHost,
          t,
          onClose: () => setEditorHost(undefined),
          onSaved: () => { setEditorHost(undefined); refresh() },
        }),

        // ---- Test-result toast
        toast !== null && jsx('div', {
          className: `sshwsp-toast ${toast.kind === 'ok' ? 'sshwsp-toast-ok' : 'sshwsp-toast-err'}`,
          role: 'status',
          onClick: () => setToast(null),
          children: toast.text,
        }),
      ]})
    }

    // =========================================================================
    // Add-workspace flow (directoryFlow slot occupant)
    // =========================================================================
    // Built-in occupants (native / browse pickers) register at the default
    // priority. The slot core renders the entry with the *lowest* priority, so
    // a negative priority shadows them while leaving both installed.
    const FLOW_PRIORITY = -100

    /**
     * The native directory picker, mirroring the built-in occupant: the desktop
     * preload bridge when present, the uiWorkspace service otherwise.
     *
     * @returns {Promise<string|null>} picked path, or null when cancelled.
     */
    function makeLocalPicker (ctx) {
      return async () => {
        const desktop = globalThis.__DSH_DIRECTORY_PICKER__
        if (desktop !== undefined) return await desktop.pick()
        const uiWorkspace = ctx.get?.('uiWorkspace')
        if (uiWorkspace == null) throw new Error('no directory picker available on this platform')
        return await uiWorkspace.pickDirectory()
      }
    }

    // The trigger (the sidebar "+" button or the menu entry) is not handed to
    // flow occupants, so remember where the last button press landed and drop
    // the chooser next to it. Freshness-bounded: a stale press must not
    // teleport the menu after a keyboard-shortcut open.
    let lastTriggerRect = null

    function trackTriggerRects () {
      if (typeof document === 'undefined') return
      document.addEventListener('mousedown', (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const button = target.closest('button')
        if (button === null) return
        const rect = button.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return
        lastTriggerRect = { left: rect.left, right: rect.right, top: rect.top, at: Date.now() }
      }, true)
    }

    const FLOW_MENU_WIDTH = 300

    /** Fixed position for the chooser popover, next to the flow trigger. */
    function flowMenuPosition (anchorEl) {
      const viewportW = window.innerWidth
      const viewportH = window.innerHeight
      const trigger = lastTriggerRect !== null && Date.now() - lastTriggerRect.at < 3000 ? lastTriggerRect : null
      let base
      if (trigger !== null) {
        base = { left: trigger.right + 8, top: trigger.top }
      } else {
        const parentRect = anchorEl?.parentElement?.getBoundingClientRect?.()
        base = parentRect != null && parentRect.width > 0
          ? { left: parentRect.right + 8, top: parentRect.top + 56 }
          : { left: (viewportW - FLOW_MENU_WIDTH) / 2, top: 96 }
      }
      return {
        left: Math.min(Math.max(8, base.left), Math.max(8, viewportW - FLOW_MENU_WIDTH - 8)),
        top: Math.min(Math.max(8, base.top), Math.max(8, viewportH - 180)),
      }
    }

    function AddChooser ({ busy, picking, onLocal, onRemote, onCancel, t }) {
      const anchorRef = React.useRef(null)
      const popoverRef = React.useRef(null)
      const [pos, setPos] = React.useState(null)
      const disabled = busy || picking

      React.useLayoutEffect(() => {
        const place = () => setPos(flowMenuPosition(anchorRef.current))
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [])

      React.useEffect(() => {
        const onDown = (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          if (popoverRef.current?.contains(target) === true) return
          if (anchorRef.current?.contains(target) === true) return
          onCancel()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') onCancel()
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [onCancel])

      const rows = [
        {
          key: 'local',
          icon: FolderIcon,
          title: picking ? t('remote.loading') : t('add.local'),
          desc: t('add.localDesc'),
          onClick: onLocal,
        },
        {
          key: 'remote',
          icon: RemoteMarkIcon,
          title: t('add.remote'),
          desc: t('add.remoteDesc'),
          onClick: onRemote,
        },
      ]

      return jsxs(Fragment, { children: [
        jsx('span', { ref: anchorRef, style: { position: 'absolute', width: 0, height: 0, pointerEvents: 'none' } }),
        pos !== null && jsx('div', {
          ref: popoverRef,
          className: 'sshwsp-flowmenu',
          role: 'menu',
          style: { left: pos.left, top: pos.top },
          children: rows.map((row) =>
            jsxs('button', {
              key: row.key,
              type: 'button',
              role: 'menuitem',
              className: 'sshwsp-menuitem',
              disabled,
              onClick: row.onClick,
              children: [
                jsx('span', { className: 'sshwsp-menuitem-icon', children: React.createElement(row.icon, { size: 16 }) }),
                jsxs('span', { className: 'sshwsp-menuitem-text', children: [
                  jsx('span', { className: 'sshwsp-menuitem-title', children: row.title }),
                  jsx('span', { className: 'sshwsp-menuitem-desc', children: row.desc }),
                ]}),
              ],
            })
          ),
        }),
      ]})
    }

    /**
     * Remote branch: name + host + directory picker, then mount. The mount
     * route registers the workspace under the typed name *before* the owner
     * adopts the path, so adoption resolves the existing record instead of
     * creating a duplicate under a derived title.
     */
    function RemoteWorkspaceDialog ({ t, busy, onCancel, onCreated }) {
      const [hosts, setHosts] = React.useState(null)
      const [hostsError, setHostsError] = React.useState(null)
      const [alias, setAlias] = React.useState('')
      const [name, setName] = React.useState('')
      const [path, setPath] = React.useState(null)
      const [entries, setEntries] = React.useState(null)
      const [writable, setWritable] = React.useState(true)
      const [loading, setLoading] = React.useState(false)
      const [loadError, setLoadError] = React.useState(null)
      const [creating, setCreating] = React.useState(false)
      const [createError, setCreateError] = React.useState(null)
      const loadSeq = React.useRef(0)

      React.useEffect(() => {
        let cancelled = false
        fetchJson(API.hosts)
          .then((data) => {
            if (cancelled) return
            const list = data.hosts ?? []
            setHosts(list)
            if (list.length > 0) setAlias(list[0].alias)
          })
          .catch((err) => { if (!cancelled) setHostsError(err.message) })
        return () => { cancelled = true }
      }, [])

      const loadDir = React.useCallback(async (target) => {
        if (alias === '') return
        const seq = ++loadSeq.current
        if (typeof target === 'string') setPath(target)
        setLoading(true)
        setLoadError(null)
        try {
          const query = typeof target === 'string' && target !== '' ? `&path=${encodeURIComponent(target)}` : ''
          const data = await fetchJson(`${API.ls}?alias=${encodeURIComponent(alias)}${query}`)
          if (seq !== loadSeq.current) return
          // Directories only — a remote workspace must point at a directory.
          setEntries((data.entries ?? [])
            .filter((entry) => entry.type === 'directory')
            .sort((a, b) => a.name.localeCompare(b.name)))
          if (typeof data.path === 'string' && data.path !== '') setPath(data.path)
          setWritable(data.writable !== false)
        } catch (err) {
          if (seq === loadSeq.current) setLoadError(err.message)
        } finally {
          if (seq === loadSeq.current) setLoading(false)
        }
      }, [alias])

      React.useEffect(() => { loadDir(null) }, [loadDir])

      const handleEntry = (entry) => {
        if (path == null) return
        loadDir(path === '/' ? `/${entry.name}` : `${path}/${entry.name}`)
      }

      const handleUp = () => {
        if (path == null || path === '/') return
        const idx = path.lastIndexOf('/')
        loadDir(idx <= 0 ? '/' : path.slice(0, idx))
      }

      const handleCreate = async () => {
        setCreating(true)
        setCreateError(null)
        try {
          const result = await fetchJson(API.mount, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias, remotePath: path, title: name.trim(), register: true }),
          })
          if (!result.ok) throw new Error(result.error ?? 'unknown')
          // Fold the fresh registration into the mark source so the row DSH is
          // about to render already wears the remote mark.
          refreshRemoteWorkspaceMarks()
          // Stays disabled while the owner adopts the workspace.
          onCreated(result.workspacePath)
        } catch (err) {
          setCreateError(t('remote.createFail', { msg: err.message }))
          setCreating(false)
        }
      }

      const createDisabled = creating || busy || alias === '' || path == null || loading || loadError != null || !writable

      // The create POST must not be abandoned mid-flight; `busy` belongs to the
      // owner and covers the workspace it is adopting.
      const dismissBackdrop = () => { if (!creating && !busy) onCancel() }

      return jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(dismissBackdrop), children: [
        jsxs('div', { className: 'sshwsp-dialog', onClick: (e) => e.stopPropagation(), children: [
          jsxs('div', { className: 'sshwsp-dlg-head', children: [
            jsx('h2', { children: t('remote.title') }),
            jsx('button', {
              className: 'sshwsp-icon-btn',
              'aria-label': t('dialog.close'),
              onClick: onCancel,
              children: React.createElement(CloseIcon, { size: 14 }),
            }),
          ]}),
          jsxs('div', { className: 'sshwsp-dialog-body', children: [
            jsxs('div', { className: 'sshwsp-form', children: [
              jsxs('div', { className: 'sshwsp-field', children: [
                jsx('span', { className: 'sshwsp-field-label', children: t('remote.name') }),
                jsx('input', {
                  className: 'sshwsp-input',
                  value: name,
                  placeholder: t('remote.namePlaceholder'),
                  disabled: creating,
                  onChange: (e) => setName(e.target.value),
                }),
              ]}),
              jsxs('div', { className: 'sshwsp-field', children: [
                jsx('span', { className: 'sshwsp-field-label', children: t('remote.host') }),
                jsxs('div', { style: { position: 'relative', display: 'flex', alignItems: 'center' }, children: [
                  jsx('span', {
                    style: { position: 'absolute', left: 9, display: 'inline-flex', color: 'var(--dsw-alias-label-secondary, #999)', pointerEvents: 'none' },
                    children: React.createElement(GlobeIcon, { size: 14 }),
                  }),
                  jsx('select', {
                    className: 'sshwsp-input sshwsp-select',
                    style: { paddingLeft: 30 },
                    value: alias,
                    disabled: hosts == null || creating,
                    onChange: (e) => setAlias(e.target.value),
                    children: (hosts ?? []).map((host) => jsx('option', { key: host.alias, value: host.alias, children: host.alias })),
                  }),
                ]}),
              ]}),
              jsxs('div', { className: 'sshwsp-field', children: [
                jsx('span', { className: 'sshwsp-field-label', children: t('remote.dir') }),
                jsxs('div', { className: 'sshwsp-pathbar', children: [
                  jsx('button', {
                    className: 'sshwsp-icon-btn',
                    'aria-label': t('remote.up'),
                    disabled: path == null || path === '/' || creating,
                    onClick: handleUp,
                    children: React.createElement(ArrowLeftIcon, { size: 14 }),
                  }),
                  jsx('span', { className: 'sshwsp-pathbar-path', children: path ?? '…' }),
                ]}),
              ]}),
            ]}),
            path != null && !loading && loadError == null && !writable && jsx('div', { className: 'sshwsp-warn', children: t('remote.notWritable') }),
            createError != null && jsx('div', { className: 'sshwsp-warn', children: createError }),
            jsx('div', { className: 'sshwsp-dirlist', children:
              hostsError != null
                ? jsx('div', { className: 'sshwsp-empty', children: t('remote.hostsFail', { msg: hostsError }) })
                : hosts != null && hosts.length === 0
                  ? jsx('div', { className: 'sshwsp-empty', children: t('panel.empty') })
                  : loading
                    ? jsx('div', { className: 'sshwsp-empty', children: t('remote.loading') })
                    : loadError != null
                      ? jsx('div', { className: 'sshwsp-empty', children: t('remote.loadError', { msg: loadError }) })
                      : (entries?.length ?? 0) === 0
                        ? jsx('div', { className: 'sshwsp-empty', children: t('remote.empty') })
                        : entries.map((entry) =>
                            jsxs('button', {
                              key: entry.name,
                              type: 'button',
                              className: 'sshwsp-entry',
                              disabled: creating,
                              onClick: () => handleEntry(entry),
                              children: [
                                jsx('span', { className: 'sshwsp-entry-icon', children: React.createElement(FolderIcon) }),
                                jsx('span', { className: 'sshwsp-entry-name', children: entry.name }),
                              ],
                            })
                          )
            }),
          ]}),
          jsxs('div', { className: 'sshwsp-dialog-footer', children: [
            jsx('button', { className: 'sshwsp-btn', disabled: creating, onClick: onCancel, children: t('remote.cancel') }),
            jsx('button', {
              className: 'sshwsp-btn sshwsp-btn-primary',
              disabled: createDisabled,
              onClick: handleCreate,
              children: creating ? t('remote.creating') : t('remote.create'),
            }),
          ]}),
        ]}),
      ]})
    }

    /**
     * Occupant of `sidebar.workspaces.directoryFlow` and
     * `conversation.hero.workspace.directoryFlow`. Local defers to the native
     * picker; remote opens {@link RemoteWorkspaceDialog} and mounts the chosen
     * directory before handing the canonical `ssh://` path to the owner.
     */
    function AddWorkspaceFlow ({ open, busy, onPicked, onCancel, onError, pick, t }) {
      const [mode, setMode] = React.useState('choose')
      const [picking, setPicking] = React.useState(false)

      React.useEffect(() => {
        if (!open) {
          setMode('choose')
          setPicking(false)
        }
      }, [open])

      const handleLocal = async () => {
        setPicking(true)
        try {
          const picked = await pick()
          if (typeof picked === 'string' && picked !== '') onPicked(picked)
          else onCancel()
        } catch (err) {
          onError(err instanceof Error ? err.message : String(err))
        } finally {
          setPicking(false)
        }
      }

      if (!open) return null
      if (mode === 'remote') {
        return React.createElement(RemoteWorkspaceDialog, {
          t,
          busy,
          onCancel,
          onCreated: (workspacePath) => onPicked(workspacePath),
        })
      }
      return React.createElement(AddChooser, {
        t,
        busy,
        picking,
        onLocal: handleLocal,
        onRemote: () => setMode('remote'),
        onCancel,
      })
    }

    // =========================================================================
    // Panel icon (sidebar row glyph)
    // =========================================================================
    function RemoteWorkspaceIcon ({ size, active }) {
      return React.createElement(ServerIcon, { size, 'data-dsh-panel-entry': 'ssh-workspace' })
    }

    // =========================================================================
    // Panel page wrapper
    // =========================================================================
    function RemoteWorkspacePage ({ translate }) {
      return jsx('div', { 'data-dsh-plugin': 'ssh-workspace', style: { height: '100%' }, children:
        jsx(RemoteWorkspacePanel, { t: translate }),
      })
    }

    // =========================================================================
    // Remote-workspace marks (DOM decoration)
    // =========================================================================
    // DSH draws every workspace with its own folder glyph, and its slot ledger
    // has no seat for row icons, so SSH-backed workspaces get that glyph
    // swapped for the remote mark after the fact. The decoration stays
    // React-safe: React-owned nodes are never removed or re-parented — the
    // folder glyph is only hidden through an inline style React never rewrites
    // (no render sets `style` on those nodes), our own svg is inserted beside
    // it, and a MutationObserver re-applies the swap whenever React replaces
    // the nodes underneath.

    const MARK_ATTR = 'data-sshwsp-mark'
    const MARK_SELECTOR = `svg[${MARK_ATTR}]`
    const MARK_GLYPH_SELECTOR = `svg:not([${MARK_ATTR}])`
    // Identity sets rebuilt from the live workspaces store, or from /status
    // when that service is out of reach. Workspace rows match by id; menu
    // rows and the hero chip only carry the displayed title.
    const remoteMarks = { ids: new Set(), titles: new Set(), disabledIds: new Set(), disabledTitles: new Set(), disabledSessionIds: new Set() }
    let marksCtx = null
    /**
     * Detached workspace paths, as last reported by /status.
     *
     * Kept separately from the identity sets because `readLiveWorkspaces()`
     * re-collects identities from DSH's own store, which knows nothing about
     * this plugin's detached list; without this the grey marks would vanish on
     * the next mutation pass.
     */
    const knownDisabledPaths = new Set()

    /** Reset the identity sets from workspace-like records ({workspaceId|id, path, title}). */
    function collectRemoteWorkspaces (items, disabledPaths) {
      const disabled = new Set(Array.isArray(disabledPaths) ? disabledPaths : [])
      knownDisabledPaths.clear()
      for (const path of disabled) knownDisabledPaths.add(path)
      const ids = new Set()
      const titles = new Set()
      const disabledIds = new Set()
      const disabledTitles = new Set()
      const disabledSessionIds = new Set()
      for (const item of Array.isArray(items) ? items : []) {
        if (typeof item?.path !== 'string' || !item.path.startsWith('ssh://')) continue
        const id = item.workspaceId ?? item.id
        if (id !== undefined && id !== null && String(id) !== '') ids.add(String(id))
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (title !== '') titles.add(title)
        // The hero chip can fall back to the path basename while a fresh
        // session is still settling, so that spelling counts as identity too.
        const trimmedPath = item.path.replace(/[/\\]+$/, '')
        const segment = trimmedPath.slice(Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\')) + 1)
        if (segment !== '') titles.add(segment)
        // Detached identity is collected alongside, not derived later: the
        // sidebar row carries only the id or the title, and which one is
        // available differs per surface.
        if (!disabled.has(item.path)) continue
        if (id !== undefined && id !== null && String(id) !== '') disabledIds.add(String(id))
        if (title !== '') disabledTitles.add(title)
        if (segment !== '') disabledTitles.add(segment)
        // Session rows are keyed `session:<id>` and carry no workspace at all,
        // so membership has to be resolved here, while the workspace is still
        // in hand. Both sources can supply it: /status forwards the registry's
        // list, and DSH's own store exposes the same list per workspace view.
        for (const sessionId of Array.isArray(item.sessionIds) ? item.sessionIds : []) {
          if (sessionId !== undefined && sessionId !== null && String(sessionId) !== '') disabledSessionIds.add(String(sessionId))
        }
      }
      remoteMarks.ids = ids
      remoteMarks.titles = titles
      remoteMarks.disabledIds = disabledIds
      remoteMarks.disabledTitles = disabledTitles
      remoteMarks.disabledSessionIds = disabledSessionIds
    }

    /** Update the mark source from a /status reply (panel fetch, flow completion). */
    function syncRemoteWorkspaceMarks (entries, disabledPaths) {
      collectRemoteWorkspaces(entries, disabledPaths)
      scheduleRemoteMarks()
    }

    /** Fetch /status once and refresh the fallback mark source from it. */
    async function refreshRemoteWorkspaceMarks () {
      try {
        const data = await fetchJson(API.status)
        syncRemoteWorkspaceMarks(data.workspaces, data.disabled)
      } catch { /* status unavailable — keep the last known set */ }
    }

    /** The remote-mark svg for one glyph: same box, stroke, and class. */
    function createRemoteMarkNode (glyph) {
      const NS = 'http://www.w3.org/2000/svg'
      const mark = document.createElementNS(NS, 'svg')
      mark.setAttribute('viewBox', REMOTE_MARK_VIEWBOX)
      mark.setAttribute('width', glyph.getAttribute('width') ?? '16')
      mark.setAttribute('height', glyph.getAttribute('height') ?? '16')
      mark.setAttribute('fill', 'none')
      mark.setAttribute('stroke', 'currentColor')
      mark.setAttribute('stroke-width', '2')
      mark.setAttribute('stroke-linecap', 'round')
      mark.setAttribute('stroke-linejoin', 'round')
      mark.setAttribute('aria-hidden', 'true')
      const glyphClass = glyph.getAttribute('class')
      if (glyphClass !== null) mark.setAttribute('class', glyphClass)
      mark.setAttribute(MARK_ATTR, '1')
      for (const d of ['M20 8 L16.5 11.5 L20 15', 'M12.5 11.5 L16.5 15.5 L12.5 19.5']) {
        const path = document.createElementNS(NS, 'path')
        path.setAttribute('d', d)
        mark.appendChild(path)
      }
      return mark
    }

    /** Swap one host's folder glyph for the mark (idempotent). */
    function applyRemoteMark (host, glyph) {
      glyph.style.display = 'none'
      const existing = host.querySelector(MARK_SELECTOR)
      if (existing === null) {
        glyph.after(createRemoteMarkNode(glyph))
        return
      }
      if (existing.previousElementSibling !== glyph) glyph.after(existing)
    }

    /** Undo the swap inside one host (the workspace stopped being remote). */
    function clearRemoteMark (host) {
      for (const mark of host.querySelectorAll(MARK_SELECTOR)) mark.remove()
      const glyph = host.querySelector(MARK_GLYPH_SELECTOR)
      if (glyph !== null && glyph.style.display === 'none') glyph.style.display = ''
    }

    /** Decide one host: swap when matched, restore when the match is gone. */
    function markHost (host, glyph, matched) {
      if (glyph === null) return
      if (matched) applyRemoteMark(host, glyph)
      else if (host.querySelector(MARK_SELECTOR) !== null) clearRemoteMark(host)
    }

    /** Re-read the live workspaces store when reachable; /status stands otherwise. */
    function readLiveWorkspaces () {
      try {
        const items = marksCtx?.get?.('workspaces')?.list?.getSnapshot?.()?.items
        // The live store knows the registration but never the detached list —
        // that is this plugin's own state. Pass the last known list through so
        // a re-read cannot erase which rows are greyed.
        if (Array.isArray(items)) collectRemoteWorkspaces(items, currentDisabledPaths())
      } catch { /* service unavailable — the last known set stands */ }
    }

    /** The detached paths as last reported by /status. */
    function currentDisabledPaths () {
      return [...knownDisabledPaths]
    }

    /**
     * Make one element refuse interaction itself, or restore it.
     *
     * Used for session rows, where the row — not a button — is the control:
     * DSH opens the session from the row's own click and its `treeitem` role
     * makes it focusable, so disabling only the buttons inside would leave the
     * keyboard path to the session wide open. The exact prior attribute values
     * are remembered per element, including "was absent": DSH sets its own
     * `tabindex` on these rows, and deleting it on restore would be a silent
     * change to a row we only meant to pass through.
     *
     * @param {Element} element - the row.
     * @param {boolean} inert - true to refuse interaction.
     * @returns {void}
     */
    function setElementInert (element, inert) {
      if (inert) {
        if (element.hasAttribute('data-sshwsp-selfinert')) return
        const prior = {}
        for (const name of ['inert', 'tabindex', 'aria-disabled']) {
          prior[name] = element.hasAttribute(name) ? element.getAttribute(name) : null
        }
        element.setAttribute('data-sshwsp-selfinert', '1')
        element.setAttribute('inert', '')
        element.setAttribute('tabindex', '-1')
        element.setAttribute('aria-disabled', 'true')
        element.dataset.sshwspSelfInertPrior = JSON.stringify(prior)
        return
      }
      if (!element.hasAttribute('data-sshwsp-selfinert')) return
      let prior = {}
      try { prior = JSON.parse(element.dataset.sshwspSelfInertPrior ?? '{}') } catch { /* damaged: fall through to absent */ }
      for (const name of ['inert', 'tabindex', 'aria-disabled']) {
        const was = prior[name] ?? null
        if (was === null) element.removeAttribute(name)
        else element.setAttribute(name, was)
      }
      element.removeAttribute('data-sshwsp-selfinert')
      delete element.dataset.sshwspSelfInertPrior
    }

    /**
     * Make a workspace row's action buttons refuse interaction, or restore them.
     *
     * Why not intercept clicks: those buttons are DSH's own, and replacing its
     * handlers means depending on markup we do not own — the next redesign
     * breaks it silently. Why not CSS alone: `pointer-events: none` stops the
     * mouse but NOT the keyboard, so a row reached with Tab still fires its
     * actions on Enter. `inert` covers both.
     *
     * Every attribute this adds is remembered per element and put back exactly,
     * including "was absent". Blindly calling removeAttribute on restore would
     * delete a `tabindex` or `aria-disabled` DSH had set itself, which is a
     * silent behaviour change on a row we never meant to touch.
     *
     * The workspace header itself is left interactive: expanding the group is
     * how the user sees the sessions `detach` deliberately keeps. Its SESSION
     * rows are a different case and get setElementInert — see the marks pass.
     *
     * @param {Element} row - the sidebar row.
     * @param {boolean} inert - true to disable its actions.
     * @returns {void}
     */
    function setRowActionsInert (row, inert) {
      // A nested menu's own rows live in a portal outside this row, so this
      // never reaches into DSH's popup — only the row's own triggers.
      for (const control of row.querySelectorAll('button, [role="button"]')) {
        if (inert) {
          if (control.hasAttribute('data-sshwsp-inert')) continue
          const prior = {}
          for (const name of ['inert', 'tabindex', 'aria-disabled']) {
            prior[name] = control.hasAttribute(name) ? control.getAttribute(name) : null
          }
          control.setAttribute('data-sshwsp-inert', '1')
          control.setAttribute('inert', '')
          control.setAttribute('tabindex', '-1')
          control.setAttribute('aria-disabled', 'true')
          control.dataset.sshwspInertPrior = JSON.stringify(prior)
        } else if (control.hasAttribute('data-sshwsp-inert')) {
          let prior = {}
          try { prior = JSON.parse(control.dataset.sshwspInertPrior ?? '{}') } catch { /* damaged: fall through to absent */ }
          for (const name of ['inert', 'tabindex', 'aria-disabled']) {
            const was = prior[name] ?? null
            if (was === null) control.removeAttribute(name)
            else control.setAttribute(name, was)
          }
          control.removeAttribute('data-sshwsp-inert')
          delete control.dataset.sshwspInertPrior
        }
      }
    }

    /**
     * Display-only spelling of a remote workspace path: insert the alias `@`
     * separator (`ssh://alias/path` → `ssh://alias@/path`) so the string reads
     * as an SSH address. Returns null when the text is not a remote path or
     * already carries the separator. Only the rendered text changes — copy
     * actions and every functional consumer keep the real spelling.
     */
    function displayRemotePath (raw) {
      const match = /^(ssh:\/\/[^/@\s]+)(\/.*)$/.exec(raw)
      if (match === null) return null
      return `${match[1]}@${match[2]}`
    }

    /** Walk every place DSH draws a workspace folder glyph and reconcile it. */
    function passRemoteMarks () {
      if (typeof document === 'undefined') return
      readLiveWorkspaces()

      // Sidebar workspace rows, keyed `workspace:<workspaceId>`; the row text
      // (the group label) doubles as identity when the store's ids differ.
      for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
        const host = row.firstElementChild
        if (host === null) continue
        const id = (row.getAttribute('data-row-key') ?? '').slice('workspace:'.length)
        const title = (row.textContent ?? '').trim()
        markHost(host, host.querySelector(MARK_GLYPH_SELECTOR), remoteMarks.ids.has(id) || (title !== '' && remoteMarks.titles.has(title)))
        // A detached workspace's row is inert, not merely grey: its actions
        // must not fire. See setRowActionsInert for why this is `inert` on the
        // buttons rather than a click interceptor on the row.
        const detached = remoteMarks.disabledIds.has(id) || (title !== '' && remoteMarks.disabledTitles.has(title))
        if (detached) row.setAttribute('data-sshwsp-disabled', '1')
        else if (row.hasAttribute('data-sshwsp-disabled')) row.removeAttribute('data-sshwsp-disabled')
        setRowActionsInert(row, detached)
      }

      // Session rows inside those groups, keyed `session:<sessionId>`. A
      // detached workspace's sessions are archived, but "archived" is only a
      // visibility filter — the row is still a live session that resumes work
      // against a workspace whose whole I/O fence is shut. Greying the group
      // header while leaving every session under it fully usable says the
      // opposite of what the workspace state means.
      for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
        const id = (row.getAttribute('data-row-key') ?? '').slice('session:'.length)
        const detached = id !== '' && remoteMarks.disabledSessionIds.has(id)
        if (detached) row.setAttribute('data-sshwsp-disabled', '1')
        else if (row.hasAttribute('data-sshwsp-disabled')) row.removeAttribute('data-sshwsp-disabled')
        setRowActionsInert(row, detached)
        setElementInert(row, detached)
      }

      // Workspace picker menu rows: icon cell + label cell, identity by label.
      for (const button of document.querySelectorAll('[role="menu"] button[role="menuitem"]')) {
        if (button.closest('.sshwsp-flowmenu') !== null) continue
        const host = button.firstElementChild
        if (host === null) continue
        const glyph = host.querySelector(MARK_GLYPH_SELECTOR)
        if (glyph === null) continue
        const label = (host.nextElementSibling?.textContent ?? '').trim()
        markHost(host, glyph, label !== '' && remoteMarks.titles.has(label))
      }

      // Hero workspace chip: folder glyph before the label, chevron after it.
      for (const chip of document.querySelectorAll('button[aria-haspopup="menu"]')) {
        const kids = [...chip.children]
        const label = kids.find(el => el.tagName === 'SPAN' && el.textContent.trim() !== '')
        if (label === undefined) continue
        const before = kids.slice(0, kids.indexOf(label)).find(el => el.tagName === 'svg' && !el.hasAttribute(MARK_ATTR))
        const after = kids.slice(kids.indexOf(label) + 1).find(el => el.tagName === 'svg')
        if (before === undefined || after === undefined) continue
        const text = label.textContent.trim()
        markHost(chip, before, text !== '' && remoteMarks.titles.has(text))
      }

      // Workspace hover cards (sidebar): dress the displayed `ssh://` path
      // with the alias `@`. The class token is DSH's hover-card path cell.
      for (const pathEl of document.querySelectorAll('[class*="_hoverPath"]')) {
        const text = pathEl.firstChild
        if (text === null || text.nodeType !== 3) continue
        const rewritten = displayRemotePath(text.data)
        if (rewritten !== null) text.data = rewritten
      }

      // DSH's PathLabel cells (file panel header, document preview, deliverables):
      // the directory segment carries the remote path prefix; the complete path
      // lives in the native tooltip. Both read with the alias `@`.
      for (const label of document.querySelectorAll('[data-path-label]')) {
        const directory = label.querySelector('[class*="_directory"]')
        if (directory !== null) {
          const text = directory.firstChild
          if (text !== null && text.nodeType === 3) {
            const rewritten = displayRemotePath(text.data)
            if (rewritten !== null) text.data = rewritten
          }
        }
        const title = label.getAttribute('title')
        if (title !== null) {
          const rewrittenTitle = displayRemotePath(title)
          if (rewrittenTitle !== null) label.setAttribute('title', rewrittenTitle)
        }
      }

      // File-tree rows: flag the referenceable ones as HTML5 drag sources (the
      // non-React property survives re-renders and stays inert until dragged).
      for (const row of document.querySelectorAll(TREE_ROW_SELECTOR)) {
        const draggable = rowReferenceKind(row) !== null
        if (row.draggable !== draggable) row.draggable = draggable
      }
    }

    let markPassQueued = false

    /** Coalesce a mutation burst into one pass on the next frame. */
    function scheduleRemoteMarks () {
      if (markPassQueued || typeof window === 'undefined') return
      markPassQueued = true
      window.requestAnimationFrame(() => {
        markPassQueued = false
        try { passRemoteMarks() } catch { /* decoration must never break the app */ }
      })
    }

    const MARKS_RELEVANT = '[data-row-key], [role="menu"], button[aria-haspopup="menu"], [class*="_hoverPath"], [data-path-label], [data-files-entry]'

    /** Whether one mutation record touches a workspace-bearing host. */
    function mutationTouchesMarks (record) {
      if (record.type === 'characterData') {
        // In-place text updates: e.g. the hero chip swapping its label from
        // the placeholder to a workspace title without any structural change.
        const parent = record.target.parentElement
        return parent !== null && (parent.matches(MARKS_RELEVANT) || parent.closest(MARKS_RELEVANT) !== null)
      }
      for (const node of [record.target, ...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof Element)) continue
        if (node.matches(MARKS_RELEVANT) || node.closest(MARKS_RELEVANT) !== null) return true
        // Subtrees mount in one commit: the chip may arrive inside a wrapper
        // that itself matches nothing, so scan the added subtree once.
        if (node !== document.body && node.querySelector(MARKS_RELEVANT) !== null) return true
      }
      return false
    }

    /** Observe the app shell so the swap survives React re-renders. */
    function installRemoteWorkspaceMarks (ctx) {
      marksCtx = ctx
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
      const observer = new MutationObserver((records) => {
        if (records.some(mutationTouchesMarks)) scheduleRemoteMarks()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    }

    // =========================================================================
    // Composer file bridge (drag / right-click → @ reference)
    // =========================================================================
    // The file tree is DSH-owned DOM with no seat for plugin gestures, so drag
    // and right-click ride on delegated listeners: the marks pass flags
    // referenceable rows as drag sources, a drag carries only the custom MIME
    // below (never `text/plain`, so no editor double-inserts), and right-click
    // opens a plugin menu over the row. A reference is inserted exactly the way
    // the @ picker inserts one — through the session's `insert-reference`
    // event, with a span from the composer's own action face — so the chip,
    // its serialization, and its invalidation all behave as a picked mention.

    const DRAG_MIME = 'application/x-dsh-ssh-workspace-file'
    const TREE_ROW_SELECTOR = '[data-files-entry][data-files-path]'
    const COMPOSER_CARD_SELECTOR = '[data-composer-card]'
    const TASK_MENU_ATTR = 'data-sshwsp-taskmenu'

    /** Referenceable kind of one tree row (`file` | `directory`), or null. */
    function rowReferenceKind (row) {
      const kind = row.getAttribute('data-files-entry')
      return kind === 'file' || kind === 'directory' ? kind : null
    }

    /** The tree's workspace root as its own element reports it (session cwd). */
    function treeRootOf (row) {
      const value = row.closest('[data-files-state="tree"]')?.getAttribute('data-files-root')
      return value != null && value !== '' ? value : null
    }

    /** Slash-normalized, trailing-slash-free spelling used to compare roots. */
    function normalizeRoot (value) {
      return typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/+$/, '') : ''
    }

    /**
     * The @ token for one tree path: relative to `root`, `/`-separated, quoted
     * with the editor grammar's own rules. Returns null for a path the grammar
     * cannot represent.
     */
    function mentionToken (absPath, root, isDir) {
      let value = absPath.replace(/\\/g, '/')
      const base = normalizeRoot(root)
      if (base !== '' && value.startsWith(`${base}/`)) value = value.slice(base.length + 1)
      if (value === '') return null
      if (isDir) value += '/'
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(value)) return null
      if (!/\s/u.test(value)) return `@${value}`
      return isDir ? `@"${value}` : `@"${value}"`
    }

    /** The chip insert payload the @ picker would build for this path. */
    function referenceFor (absPath, mention, isDir) {
      const cut = absPath.replace(/[/\\]+$/, '')
      const slash = Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('\\'))
      const name = cut.slice(slash + 1)
      return {
        source: 'reference',
        ref: mention,
        label: isDir ? `${name}/` : name,
        appearance: isDir ? 'folder' : 'file',
        clipboardText: mention,
      }
    }

    /** The main session's composer face: its action channel and session scope. */
    function resolveComposerTarget (ctx) {
      try {
        const value = ctx.get?.('uiSession')?.adapter?.current?.getSnapshot?.()
        const actions = value?.props?.inputActions
        const actx = value?.ctx
        if (actions == null || actx == null) return null
        return { actions, actx, sessionId: value.key }
      } catch {
        return null
      }
    }

    /** The composer session's workspace root, when the sessions store answers. */
    function readComposerRoot (ctx, sessionId) {
      try {
        const byId = ctx.get?.('sessions')?.list?.getSnapshot?.()?.byId
        const cwd = sessionId === undefined || sessionId === null ? undefined : byId?.[sessionId]?.cwd
        return typeof cwd === 'string' ? cwd : null
      } catch {
        return null
      }
    }

    /**
     * Insert one tree path as an @ reference into the main composer. Follows
     * the pick path (`slash/input-insert-reference` with a pick-time span) and
     * degrades to plain text through the same action face when no listener
     * claims it.
     */
    function addPathToTask (ctx, absPath, isDir, root) {
      const target = resolveComposerTarget(ctx)
      if (target === null) {
        notifyUser(translate('mention.noComposer'), 'err')
        return false
      }
      // Relative only when the tree stands on the composer's own root; any
      // other spelling stays absolute, which the Host resolves as it stands.
      const rootKey = normalizeRoot(root)
      const base = rootKey !== '' && rootKey === normalizeRoot(readComposerRoot(ctx, target.sessionId)) ? root : null
      const mention = mentionToken(absPath, base, isDir)
      if (mention === null) {
        notifyUser(translate('mention.unrepresentable'), 'err')
        return false
      }
      const reference = referenceFor(absPath, mention, isDir)
      let applied = false
      try {
        const span = target.actions.captureInsertion()
        applied = target.actx.bail(target.actx, 'slash/input-insert-reference', { reference, span }) === true
      } catch {
        applied = false
      }
      if (!applied) {
        try {
          const span = target.actions.captureInsertion()
          applied = target.actions.insertText(`${mention} `, span) !== false
        } catch {
          applied = false
        }
      }
      if (!applied) {
        notifyUser(translate('mention.insertFail'), 'err')
        return false
      }
      focusSoleComposer()
      return true
    }

    /** Best-effort focus of the single visible composer after an insert. */
    function focusSoleComposer () {
      try {
        const cards = [...document.querySelectorAll(COMPOSER_CARD_SELECTOR)].filter((card) => {
          const rect = card.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })
        if (cards.length !== 1) return
        const input = cards[0].querySelector('[data-composer-input]')
        if (input == null) return
        input.focus({ preventScroll: true })
        // Lexical restores its stored selection (the chip's tail); the bare DOM
        // focus above alone would leave the caret at the document start.
        input.__lexicalEditor?.focus()
      } catch { /* best-effort */ }
    }

    let domToastTimer = null

    /** Toast for gestures with no React surface to report through. */
    function notifyUser (text, kind) {
      if (typeof document === 'undefined' || text == null) return
      for (const stale of document.querySelectorAll('.sshwsp-toast[data-sshwsp-toast]')) stale.remove()
      const el = document.createElement('div')
      el.setAttribute('data-sshwsp-toast', '1')
      el.className = `sshwsp-toast ${kind === 'ok' ? 'sshwsp-toast-ok' : 'sshwsp-toast-err'}`
      el.setAttribute('role', 'status')
      el.textContent = text
      el.addEventListener('click', () => el.remove())
      document.body.appendChild(el)
      clearTimeout(domToastTimer)
      domToastTimer = setTimeout(() => el.remove(), 3500)
    }

    // =========================================================================
    // Transfers from DSH's own file tree
    // =========================================================================
    //
    // The panel dialog above carries upload/download for the directories it
    // browses, but the files users actually work with are listed by DSH's own
    // "Files" panel, whose rows this plugin already hooks for @ references.
    // These helpers give those rows the same two transfers, so a remote file is
    // never left without a way in or out.

    /**
     * Split a tree row's `ssh://alias/abs/path` into its parts, or null.
     *
     * Mirrors `parseRemotePath` in protocol.js. That module is Node-side and is
     * not in the browser bundle's `require` set, so the grammar is restated here
     * — the same one the row attributes are written with, so the two cannot
     * disagree about what a remote path looks like.
     */
    function remoteTargetOf (absPath) {
      if (typeof absPath !== 'string' || !absPath.startsWith('ssh://')) return null
      const match = /^ssh:\/\/([^/]+)(\/.*)$/u.exec(absPath)
      if (match === null) return null
      const [, rawAlias, rawPath] = match
      const segments = []
      for (const segment of rawPath.split('/')) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') {
          segments.pop()
          continue
        }
        segments.push(segment)
      }
      return { alias: rawAlias, remotePath: `/${segments.join('/')}` }
    }

    /** POSIX dirname of a remote absolute path. */
    function remoteDirOf (remotePath) {
      const cut = remotePath.replace(/\/+$/u, '').lastIndexOf('/')
      return cut <= 0 ? '/' : remotePath.slice(0, cut)
    }

    /** Save a fetched blob under `name` through the browser's download flow. */
    function saveBlob (blob, name) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    }

    /**
     * Pull one remote tree row down to this machine.
     *
     * The route streams raw bytes (see `ROUTES.download`), so the blob is
     * assembled without the base64 penalty a JSON answer would pay, and the
     * bytes never travel through the model.
     */
    async function downloadTreeRow (absPath) {
      const parts = remoteTargetOf(absPath)
      if (parts === null) {
        notifyUser(translate('transfer.notRemote'), 'err')
        return
      }
      const name = parts.remotePath.replace(/\/+$/u, '').split('/').pop() ?? ''
      const label = name === '' ? parts.remotePath : name
      notifyUser(translate('transfer.downloading', { name: label }), 'ok')
      try {
        const query = `?alias=${encodeURIComponent(parts.alias)}&path=${encodeURIComponent(parts.remotePath)}`
        const response = await fetch(`${API.download}${query}`)
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          let message = text || `download failed (${response.status})`
          try {
            const parsed = JSON.parse(text)
            if (typeof parsed?.error === 'string' && parsed.error !== '') message = parsed.error
          } catch { /* not JSON */ }
          throw new Error(message)
        }
        saveBlob(await response.blob(), label)
      } catch (err) {
        notifyUser(`${translate('transfer.downloadFail')}: ${err.message}`, 'err')
      }
    }

    /**
     * Send one local file into the directory that holds `absPath`.
     *
     * Uploads land beside the row the user invoked it on. A directory row is
     * its own destination; a file row means its parent, which is what the user
     * is looking at.
     */
    function uploadTreeRow (absPath, isDir) {
      const parts = remoteTargetOf(absPath)
      if (parts === null) {
        notifyUser(translate('transfer.notRemote'), 'err')
        return
      }
      const dir = isDir ? parts.remotePath : remoteDirOf(parts.remotePath)
      const input = document.createElement('input')
      input.type = 'file'
      input.style.display = 'none'
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        input.remove()
        if (file === undefined || file === null) return
        void sendTreeUpload(parts.alias, dir, file)
      }, { once: true })
      document.body.appendChild(input)
      input.value = ''
      input.click()
    }

    /** POST one file's bytes to `dir` on `alias`, then report the outcome. */
    async function sendTreeUpload (alias, dir, file) {
      notifyUser(translate('transfer.uploadingName', { name: file.name }), 'ok')
      try {
        const query = `?alias=${encodeURIComponent(alias)}&path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`
        const response = await fetch(`${API.upload}${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        })
        const text = await response.text().catch(() => '')
        let parsed
        try { parsed = JSON.parse(text) } catch { /* not JSON */ }
        if (!response.ok || parsed?.ok !== true) {
          throw new Error(parsed?.error ?? (text || `upload failed (${response.status})`))
        }
        notifyUser(translate('transfer.uploadOk', { name: file.name }), 'ok')
        // The listing belongs to DSH's own panel; nudge it to re-read rather
        // than claiming the new file is on screen.
        refreshFilesPanel()
      } catch (err) {
        notifyUser(`${translate('transfer.uploadFail')}: ${err.message}`, 'err')
      }
    }

    /**
     * Ask DSH's file panel to re-list after an out-of-band write.
     *
     * Its own reload control carries `data-files-reload`; clicking it keeps the
     * listing authoritative instead of this plugin re-implementing a re-read.
     * The sibling `data-files-auto-refresh` button must NOT be used — that one
     * toggles auto-refresh and would silently turn a panel setting off.
     */
    function refreshFilesPanel () {
      try {
        for (const button of document.querySelectorAll('[data-files-reload]')) {
          if (button instanceof HTMLElement) button.click()
        }
      } catch { /* decoration must never break the app */ }
    }

    // =========================================================================
    // File-panel header actions
    // =========================================================================

    /**
     * Upload control for DSH's own "Files" panel header.
     *
     * The slot passes `absolutePath`, the directory currently listed, so the
     * upload lands exactly where the user is looking. When that directory is
     * not a remote target the component renders nothing at all — a local
     * listing has no other side to send bytes to, and a dead control there
     * would misstate what the panel can do.
     *
     * Only upload lives here: the header always names a *directory*, and a
     * directory cannot be pulled down as one file. Download is offered per
     * file in the row menu, where the target is unambiguous.
     */
    function FilePanelTransferActions (props) {
      const absolutePath = typeof props?.absolutePath === 'string' ? props.absolutePath : ''
      const t = props?.t ?? translate
      const remote = remoteTargetOf(absolutePath)
      // Hooks must run unconditionally, so the state is declared before the
      // early return; a non-remote listing simply renders nothing.
      const [busy, setBusy] = React.useState(false)
      if (remote === null) return null

      const pickAndUpload = () => {
        if (busy) return
        const input = document.createElement('input')
        input.type = 'file'
        input.style.display = 'none'
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          input.remove()
          if (file === undefined || file === null) return
          setBusy(true)
          void sendTreeUpload(remote.alias, remote.remotePath, file).finally(() => setBusy(false))
        }, { once: true })
        document.body.appendChild(input)
        input.value = ''
        input.click()
      }

      return jsx('button', {
        type: 'button',
        className: 'sshwsp-fileaction',
        disabled: busy,
        title: t('transfer.upload'),
        'aria-label': t('transfer.upload'),
        onClick: pickAndUpload,
        children: busy ? t('transfer.uploading') : t('transfer.upload'),
      })
    }

    let taskMenuEl = null
    let taskMenuDispose = null

    /** Tear the row menu down and detach its listeners. */
    function closeTaskMenu () {
      if (taskMenuEl !== null) {
        taskMenuEl.remove()
        taskMenuEl = null
      }
      if (taskMenuDispose !== null) {
        taskMenuDispose()
        taskMenuDispose = null
      }
    }

    /** The svg for one menu row, mirroring the page's own folder/file glyphs. */
    function createMenuIcon (isDir) {
      const SVG_NS = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.5')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      const paths = isDir
        ? ['M2 4.5v7a1.5 1.5 0 001.5 1.5h9a1.5 1.5 0 001.5-1.5v-5.5A1.5 1.5 0 0012.5 4.5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z']
        : ['M4 2h5.5L13 5.5V13a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z', 'M9.5 2v3.5H13']
      for (const d of paths) {
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', d)
        svg.appendChild(path)
      }
      return svg
    }

    /** A hairline rule between the reference action and the transfer actions. */
    function createMenuSeparator () {
      const rule = document.createElement('div')
      rule.className = 'sshwsp-menusep'
      rule.setAttribute('role', 'separator')
      return rule
    }

    /**
     * One transfer action in the row menu.
     *
     * A disabled row still explains itself: the reason lives in the description
     * rather than disappearing into a tooltip, which is what the panel needs
     * when an action is unavailable for a visible cause (a directory download).
     */
    function createTransferItem ({ label, desc, disabled = false, onSelect }) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'sshwsp-menuitem'
      item.setAttribute('role', 'menuitem')
      if (disabled) item.disabled = true
      const icon = document.createElement('span')
      icon.className = 'sshwsp-menuitem-icon'
      icon.appendChild(createMenuIcon(false))
      const textWrap = document.createElement('span')
      textWrap.className = 'sshwsp-menuitem-text'
      const title = document.createElement('span')
      title.className = 'sshwsp-menuitem-title'
      title.textContent = label
      const description = document.createElement('span')
      description.className = 'sshwsp-menuitem-desc'
      description.textContent = desc
      textWrap.append(title, description)
      item.append(icon, textWrap)
      if (!disabled) {
        item.addEventListener('click', () => {
          closeTaskMenu()
          onSelect()
        })
      }
      return item
    }

    /** Open the row menu at the pointer, clamped to the viewport. */
    function openTaskMenu (ctx, absPath, isDir, root, x, y) {
      closeTaskMenu()
      const mention = mentionToken(absPath, root, isDir)

      const el = document.createElement('div')
      el.className = 'sshwsp-flowmenu'
      el.setAttribute('role', 'menu')
      el.setAttribute(TASK_MENU_ATTR, '1')
      el.style.left = `${Math.min(Math.max(8, x), Math.max(8, window.innerWidth - FLOW_MENU_WIDTH - 8))}px`
      el.style.top = `${Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 120))}px`

      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'sshwsp-menuitem'
      item.setAttribute('role', 'menuitem')
      if (mention === null) item.disabled = true

      const icon = document.createElement('span')
      icon.className = 'sshwsp-menuitem-icon'
      icon.appendChild(createMenuIcon(isDir))
      const textWrap = document.createElement('span')
      textWrap.className = 'sshwsp-menuitem-text'
      const title = document.createElement('span')
      title.className = 'sshwsp-menuitem-title'
      title.textContent = translate('mention.addToTask')
      const desc = document.createElement('span')
      desc.className = 'sshwsp-menuitem-desc'
      desc.textContent = mention ?? translate('mention.unrepresentable')
      textWrap.append(title, desc)
      item.append(icon, textWrap)
      item.addEventListener('click', () => {
        closeTaskMenu()
        addPathToTask(ctx, absPath, isDir, root)
      })
      el.appendChild(item)

      // Transfers: only for rows that actually name a remote target. The same
      // panel can show a local workspace, where these routes have nothing to
      // talk to — offering the items there would promise a capability the row
      // does not have.
      const remote = remoteTargetOf(absPath)
      if (remote !== null) {
        el.appendChild(createMenuSeparator())
        el.appendChild(createTransferItem({
          label: translate('transfer.download'),
          desc: isDir ? translate('transfer.downloadDirUnsupported') : absPath,
          disabled: isDir,
          onSelect: () => { void downloadTreeRow(absPath) },
        }))
        el.appendChild(createTransferItem({
          label: translate('transfer.upload'),
          desc: isDir ? absPath : remoteDirOf(absPath),
          onSelect: () => uploadTreeRow(absPath, isDir),
        }))
      }

      document.body.appendChild(el)
      taskMenuEl = el

      const onDown = (event) => {
        const target = event.target
        if (target instanceof Node && el.contains(target)) return
        closeTaskMenu()
      }
      const onKey = (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        closeTaskMenu()
      }
      const onDisplace = () => closeTaskMenu()
      document.addEventListener('mousedown', onDown, true)
      document.addEventListener('keydown', onKey, true)
      document.addEventListener('scroll', onDisplace, true)
      window.addEventListener('resize', onDisplace)
      window.addEventListener('blur', onDisplace)
      taskMenuDispose = () => {
        document.removeEventListener('mousedown', onDown, true)
        document.removeEventListener('keydown', onKey, true)
        document.removeEventListener('scroll', onDisplace, true)
        window.removeEventListener('resize', onDisplace)
        window.removeEventListener('blur', onDisplace)
      }
    }

    let dragPayload = null
    let dropCard = null

    /**
     * Events already handled by an earlier materialization of this bundle.
     *
     * The module loader memoizes factories, but HMR drops the cache entry and
     * runs the body again: a fresh closure, a fresh `composerBridgesInstalled`,
     * and a second set of listeners on the same `document`. The old ones are
     * not collected with the old closure, so a single drop would be consumed
     * once per past materialization — observed as a composer filling with the
     * same chip a couple of dozen times.
     *
     * It therefore CANNOT live in this closure, which is exactly what gets
     * replaced. It is parked on the global under a namespaced key so every
     * materialization shares one set, and it is keyed on the event object —
     * the same instance reaches every listener, and the entry dies with the
     * event, so nothing leaks and no unmount bookkeeping is needed.
     */
    const GESTURE_CLAIMS_KEY = '__dshSshWorkspaceGestureClaims__'
    const handledGestures = (() => {
      if (typeof WeakSet !== 'function') return null
      const scope = typeof globalThis === 'object' && globalThis !== null ? globalThis : null
      if (scope === null) return new WeakSet()
      const existing = scope[GESTURE_CLAIMS_KEY]
      if (existing instanceof WeakSet) return existing
      const created = new WeakSet()
      try {
        Object.defineProperty(scope, GESTURE_CLAIMS_KEY, {
          value: created,
          configurable: true,
          writable: false,
          enumerable: false,
        })
      } catch {
        return created
      }
      return created
    })()

    /** True the first time ANY materialization sees `event`; false afterwards. */
    function firstClaim (event) {
      if (handledGestures === null) return true
      if (handledGestures.has(event)) return false
      handledGestures.add(event)
      return true
    }

    /** Highlight the composer card under a carried path (inline style; React never owns it). */
    function setDropCard (card) {
      if (dropCard === card) return
      if (dropCard !== null) {
        dropCard.style.removeProperty('outline')
        dropCard.style.removeProperty('outline-offset')
      }
      dropCard = card
      if (card !== null) {
        card.style.setProperty('outline', '2px dashed var(--dsw-alias-button-info-fill, #4a9eff)')
        card.style.setProperty('outline-offset', '2px')
      }
    }

    /**
     * Delegated drag listeners: tree rows out, the composer card in.
     *
     * Returns a detach function so `apply`'s disposer can unwind this
     * materialization; the shared claim set additionally covers instances that
     * were replaced without it ever running (HMR, a second window's factory).
     */
    function installTreeDragBridge (ctx) {
      if (typeof document === 'undefined') return () => {}

      const onDragStart = (event) => {
        if (!firstClaim(event)) return
        const target = event.target
        if (!(target instanceof Element)) return
        const row = target.closest(TREE_ROW_SELECTOR)
        const kind = row === null ? null : rowReferenceKind(row)
        if (row === null || kind === null) return
        const path = row.getAttribute('data-files-path')
        if (path === null || path === '') return
        dragPayload = { path, isDir: kind === 'directory', root: treeRootOf(row) }
        const transfer = event.dataTransfer
        if (transfer !== null) {
          transfer.setData(DRAG_MIME, path)
          transfer.effectAllowed = 'copy'
        }
      }

      const onDragOver = (event) => {
        if (!firstClaim(event)) return
        if (dragPayload === null) return
        const target = event.target
        const card = target instanceof Element ? target.closest(COMPOSER_CARD_SELECTOR) : null
        setDropCard(card)
        if (card === null) return
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      }

      const onDrop = (event) => {
        // Claimed before any state is touched: a stale instance's listener may
        // run first and clear its own payload, but only one materialization
        // gets to insert.
        if (!firstClaim(event)) return
        const payload = dragPayload
        dragPayload = null
        setDropCard(null)
        if (payload === null) return
        const target = event.target
        const card = target instanceof Element ? target.closest(COMPOSER_CARD_SELECTOR) : null
        if (card === null) return
        event.preventDefault()
        event.stopPropagation()
        addPathToTask(ctx, payload.path, payload.isDir, payload.root)
      }

      const onDragEnd = (event) => {
        // Not claimed: every instance must clear its own carried payload, and
        // clearing is idempotent.
        dragPayload = null
        setDropCard(null)
      }

      document.addEventListener('dragstart', onDragStart, true)
      document.addEventListener('dragover', onDragOver, true)
      document.addEventListener('drop', onDrop, true)
      document.addEventListener('dragend', onDragEnd, true)

      return () => {
        document.removeEventListener('dragstart', onDragStart, true)
        document.removeEventListener('dragover', onDragOver, true)
        document.removeEventListener('drop', onDrop, true)
        document.removeEventListener('dragend', onDragEnd, true)
      }
    }

    /** Delegated right-click listener: the row menu. Returns a detach function. */
    function installTreeMenuBridge (ctx) {
      if (typeof document === 'undefined') return () => {}
      const onContextMenu = (event) => {
        if (!firstClaim(event)) return
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest(`[${TASK_MENU_ATTR}]`) !== null) {
          closeTaskMenu()
          return
        }
        const row = target.closest(TREE_ROW_SELECTOR)
        const kind = row === null ? null : rowReferenceKind(row)
        if (row === null || kind === null) return
        const path = row.getAttribute('data-files-path')
        if (path === null || path === '') return
        event.preventDefault()
        event.stopPropagation()
        openTaskMenu(ctx, path, kind === 'directory', treeRootOf(row), event.clientX, event.clientY)
      }
      document.addEventListener('contextmenu', onContextMenu, true)
      return () => document.removeEventListener('contextmenu', onContextMenu, true)
    }

    let composerBridgesInstalled = false

    /**
     * Install the delegated drag / right-click gestures once per module body.
     *
     * The flag only guards repeat calls inside ONE materialization; a reloaded
     * module body gets a fresh flag, which is why the handlers also consult the
     * shared claim set. The returned disposer detaches this materialization.
     */
    function installComposerBridges (ctx) {
      if (composerBridgesInstalled) return () => {}
      composerBridgesInstalled = true
      const disposers = [installTreeDragBridge(ctx), installTreeMenuBridge(ctx)]
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* detach is best-effort */ }
        }
      }
    }

    // =========================================================================
    // Plugin apply
    // =========================================================================
    const PANEL_ID = 'ssh-workspace'
    const PANEL_ORDER = 45

    let translate = makeTranslate(zh)

    const inject = ['slots', 'locale']

    function apply (ctx) {
      injectStyles()
      trackTriggerRects()
      installRemoteWorkspaceMarks(ctx)
      const detachBridges = installComposerBridges(ctx)
      refreshRemoteWorkspaceMarks()

      // Register locale dictionaries, then bind the host seat for the active
      // language. Placeholder expansion is layered on top: the bound seat is
      // not guaranteed to expand `{name}` across hosts, and a re-apply must
      // not lose it when the namespace is already registered.
      //
      // The registration MUST go through ctx.effect so its disposer runs when
      // this apply instance is torn down. A bare register() leaves the previous
      // instance holding (NS, zh); the next materialize then throws on the
      // duplicate, the catch swallows it, and bind() keeps serving the OLD
      // dictionary — every key added since silently renders as a raw key name.
      // Releasing on teardown makes the re-registration succeed instead.
      const registerDictionaries = () => {
        try {
          return ctx.locale?.register?.(NS, { zh, en }) ?? (() => {})
        } catch {
          return () => {}
        }
      }
      // `ctx.effect` is the documented owner for a disposable side effect, but
      // this plugin targets several host builds; fall back to a direct call so a
      // host without `effect` still gets dictionaries (just without teardown).
      if (typeof ctx.effect === 'function') {
        ctx.effect(registerDictionaries, 'ssh-workspace: locale dictionaries')
      } else {
        registerDictionaries()
      }

      try {
        const bound = ctx.locale?.bind?.(NS)
        if (bound !== undefined) {
          // A bound seat can answer with the key itself when the active
          // language lacks an entry (or when it serves a stale dictionary).
          // Fall back to the local zh table so a missing key degrades to
          // readable Chinese instead of leaking the namespace path into the UI.
          translate = (key, params) => {
            const out = bound(key)
            return out === undefined || out === null || out === key
              ? applyParams(zh[key] ?? key, params)
              : applyParams(out, params)
          }
        }
      } catch { /* locale unavailable — keep the zh fallback */ }

      const slots = ctx.slots

      // Sidebar row.
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => translate('entry.label'),
      }, RemoteWorkspaceIcon))

      // Main page.
      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ translate }),
      }, RemoteWorkspacePage))

      // File-panel header actions. DSH hands this slot `absolutePath` — the
      // directory the panel is showing — so a remote listing gets upload and
      // download right where the files are, without guessing the location.
      slots.inject('sidebar.right.tab.files.actions', () => slots.register({
        name: 'sidebar.right.tab.files.actions',
        id: `${PANEL_ID}-transfers`,
        inject: () => ({ t: translate }),
      }, FilePanelTransferActions))

      // Add-workspace flow: shadow the built-in directory pickers so the entry
      // offers a local/remote choice. Registered into both holes through the
      // nested inject pattern — ui-workspace may declare them later or replace
      // their declarations, and `inject` waits for the declaration.
      const flowInject = () => ({ pick: makeLocalPicker(ctx), t: translate })
      slots.inject('conversation.hero.workspace.directoryFlow', () => slots.inject('sidebar.workspaces.directoryFlow', function* () {
        yield slots.register({
          name: 'conversation.hero.workspace.directoryFlow',
          priority: FLOW_PRIORITY,
          inject: flowInject,
        }, AddWorkspaceFlow)
        yield slots.register({
          name: 'sidebar.workspaces.directoryFlow',
          priority: FLOW_PRIORITY,
          inject: flowInject,
        }, AddWorkspaceFlow)
      }))

      // Cordis unmounts a plugin by calling the disposer `apply` returns. The
      // document-level gesture listeners are not owned by any ctx.effect, so
      // without this they would outlive the materialization that installed
      // them and every later one would stack on top.
      return () => {
        detachBridges()
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
