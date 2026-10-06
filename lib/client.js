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
      test: '/api/dsh-ssh-workspace/test',
      ls: '/api/dsh-ssh-workspace/ls',
      status: '/api/dsh-ssh-workspace/status',
      mount: '/api/dsh-ssh-workspace/mount',
      unmount: '/api/dsh-ssh-workspace/unmount',
      forward: '/api/dsh-ssh-workspace/forward',
      unforward: '/api/dsh-ssh-workspace/unforward',
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
      'hosts.source.store': '配置',
      'hosts.source.sshConfig': '~/.ssh/config',
      'hosts.auth.key': '密钥',
      'hosts.auth.password': '密码',
      'hosts.auth.agent': 'Agent',
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
      'hosts.forgetKeyBusy': '处理中…',
      'hosts.forgetKeyDesc': '仅在该主机确实重装系统或更换了密钥后使用。忘记后，下次连接将重新信任并记录对方出示的密钥（TOFU）；若不确定，请先与管理员核对指纹。',
      'hosts.forgetKeyOk': '已忘记记录的密钥，下次连接将重新记录',
      'hosts.forgetKeyFail': '忘记主机密钥失败',
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
      'browser.mountOk': '已挂载为 {path}',
      'browser.mountFail': '挂载失败',
      'mounted.title': '已挂载的工作区',
      'mounted.none': '暂无已挂载的工作区',
      'mounted.unmount': '卸载',
      'mounted.unmounting': '卸载中…',
      'connections.title': '活跃连接',
      'connections.none': '无活跃连接',
      'connections.connected': '已连接',
      'connections.broken': '已断开',
      'connections.inFlight': '进行中: {n}',
      'forwards.title': '端口转发',
      'forwards.none': '暂无端口转发',
      'forwards.remotePort': '远端端口',
      'forwards.localPort': '本地端口（可选）',
      'forwards.localPlaceholder': '默认同远端',
      'forwards.add': '转发',
      'forwards.adding': '转发中…',
      'forwards.open': '打开',
      'forwards.close': '关闭',
      'forwards.connections': '活跃连接: {n}',
      'forwards.fail': '端口转发失败',
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
    }
    const en = {
      'entry.label': 'Remote Workspace',
      'panel.title': 'Remote Workspaces',
      'panel.empty': 'No SSH hosts configured',
      'panel.loading': 'Loading…',
      'hosts.title': 'SSH Hosts',
      'hosts.source.store': 'config',
      'hosts.source.sshConfig': '~/.ssh/config',
      'hosts.auth.key': 'key',
      'hosts.auth.password': 'password',
      'hosts.auth.agent': 'agent',
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
      'hosts.forgetKeyBusy': 'Working…',
      'hosts.forgetKeyDesc': 'Use this only after the host was reinstalled or its key genuinely changed. Forgetting makes the next connection trust and record whatever key the host presents (TOFU); when unsure, verify the fingerprint with the host owner first.',
      'hosts.forgetKeyOk': 'Recorded key forgotten — the next connection records it anew',
      'hosts.forgetKeyFail': 'Could not forget the host key',
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
      'browser.mountOk': 'Mounted as {path}',
      'browser.mountFail': 'Mount failed',
      'mounted.title': 'Mounted Workspaces',
      'mounted.none': 'No mounted workspaces',
      'mounted.unmount': 'Unmount',
      'mounted.unmounting': 'Unmounting…',
      'connections.title': 'Active Connections',
      'connections.none': 'No active connections',
      'connections.connected': 'connected',
      'connections.broken': 'broken',
      'connections.inFlight': 'in flight: {n}',
      'forwards.title': 'Port Forwards',
      'forwards.none': 'No port forwards',
      'forwards.remotePort': 'Remote port',
      'forwards.localPort': 'Local port (optional)',
      'forwards.localPlaceholder': 'same as remote',
      'forwards.add': 'Forward',
      'forwards.adding': 'Forwarding…',
      'forwards.open': 'Open',
      'forwards.close': 'Close',
      'forwards.connections': 'active connections: {n}',
      'forwards.fail': 'Port forward failed',
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
.sshwsp-host-alias { font-weight: 500; font-size: 14px; }
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
.sshwsp-forward-new { display: flex; gap: 6px; align-items: center; margin: 0 0 8px; }
.sshwsp-forward-new .sshwsp-select { flex: 1; min-width: 0; }
.sshwsp-input-port { width: 96px; flex: none; }
.sshwsp-empty { text-align: center; padding: 32px 16px; color: var(--dsw-alias-label-tertiary, #666); font-size: 13px; }
.sshwsp-conn { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0; font-variant-numeric: tabular-nums; }
.sshwsp-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.sshwsp-dot-ok { background: var(--dsw-alias-state-success-primary, #4ade80); }
.sshwsp-dot-err { background: var(--dsw-alias-state-error-primary, #ff6b6b); }
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

    function ChevronUpIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M4 10l4-4 4 4' }),
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
    function HostCard ({ host, t, onTest, onBrowse, onEdit, onDelete, onForgetKey, testState, deleteError, deleting }) {
      // null | 'delete' | 'forget' — only one confirmation row shows at a time.
      const [confirming, setConfirming] = React.useState(null)
      const testing = testState?.status === 'testing'
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
            // ---- 浏览目录入口（已屏蔽，代码保留：需要时去掉注释即可恢复）
            // jsx('button', {
            //   key: 'browse',
            //   className: 'sshwsp-btn sshwsp-btn-primary',
            //   onClick: () => onBrowse(host.alias),
            //   children: t('hosts.browse'),
            // }),
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

      return jsxs('div', { className: 'sshwsp-card sshwsp-host', children: [
        jsxs('div', { className: 'sshwsp-host-info', children: [
          jsx('div', { className: 'sshwsp-host-alias', children: host.alias }),
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

      return jsxs('div', { className: 'sshwsp-backdrop', onClick: onClose, children: [
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

      return jsxs('div', { className: 'sshwsp-backdrop', onClick: onClose, children: [
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
                            ],
                          })
                        )
              }),
            ]}),
            mountResult && jsx('div', {
              className: mountResult.ok
                ? 'sshwsp-status sshwsp-status-ok'
                : 'sshwsp-status sshwsp-status-err',
              style: { marginTop: 12, padding: '8px 12px', borderRadius: 6 },
              children: mountResult.ok
                ? t('browser.mountOk', { path: mountResult.workspacePath })
                : `${t('browser.mountFail')}: ${mountResult.error ?? 'unknown'}`,
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

    function RemoteWorkspacePanel ({ t }) {
      const [hosts, setHosts] = React.useState([])
      const [status, setStatus] = React.useState({ mounted: [], connections: [], forwards: [] })
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
          syncRemoteWorkspaceMarks(statusData.workspaces)
        } catch { /* silent */ }
        finally { setLoading(false) }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

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
          // Refresh status to show the new connection.
          if (result.ok) {
            const s = await fetchJson(API.status)
            setStatus(s)
          }
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

      const handleUnmount = async (workspacePath) => {
        try {
          await fetchJson(API.unmount, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspacePath, deregister: true }),
          })
          refresh()
        } catch { /* silent */ }
      }

      const handleForward = async () => {
        const remotePort = Number.parseInt(forwardRemotePort.trim(), 10)
        const localPortText = forwardLocalPort.trim()
        const localPort = localPortText === '' ? undefined : Number.parseInt(localPortText, 10)
        const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535
        if (!validPort(remotePort) || (localPort !== undefined && !validPort(localPort))) {
          setToast({ kind: 'err', text: t('editor.badPort') })
          return
        }
        setForwardBusy(true)
        try {
          const result = await fetchJson(API.forward, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias: forwardAlias, remotePort, ...(localPort !== undefined ? { localPort } : {}) }),
          })
          if (!result.ok) {
            setToast({ kind: 'err', text: `${t('forwards.fail')}: ${result.error ?? ''}` })
          } else {
            setForwardRemotePort('')
            setForwardLocalPort('')
          }
          await refresh()
        } catch (err) {
          setToast({ kind: 'err', text: `${t('forwards.fail')}: ${err.message}` })
        } finally {
          setForwardBusy(false)
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

      const connMap = new Map()
      for (const c of status.connections ?? []) connMap.set(c.alias, c)

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
          : hosts.map((host) => {
              const conn = connMap.get(host.alias)
              return jsxs(Fragment, { key: host.alias, children: [
                jsx(HostCard, {
                  host,
                  t,
                  onTest: handleTest,
                  onBrowse: setBrowserAlias,
                  onEdit: (row) => setEditorHost(row),
                  onDelete: handleDelete,
                  onForgetKey: handleForgetKey,
                  testState: testStates[host.alias],
                  deleteError: deleteErrors[host.alias],
                  deleting: deletingAlias === host.alias,
                }),
                conn && jsxs('div', { className: 'sshwsp-conn', style: { paddingLeft: 16, paddingBottom: 4 }, children: [
                  jsx('span', { className: `sshwsp-dot ${conn.state === 'connected' ? 'sshwsp-dot-ok' : 'sshwsp-dot-err'}` }),
                  jsx('span', { style: { color: conn.state === 'connected' ? 'var(--dsw-alias-state-success-primary, #4ade80)' : 'var(--dsw-alias-state-error-primary, #ff6b6b)' }, children: t(`connections.${conn.state}`) }),
                  conn.inFlight > 0 && jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary, #666)' }, children: t('connections.inFlight', { n: conn.inFlight }) }),
                ]}),
              ]})
            }),

        // ---- Port forwards（已屏蔽，代码保留：需要时去掉注释即可恢复）
        // jsx('div', { className: 'sshwsp-section-head', children: [
        //   jsx('h3', { children: t('forwards.title') }),
        // ]}),
        // jsxs('div', { className: 'sshwsp-forward-new', children: [
        //   jsx('select', {
        //     className: 'sshwsp-input sshwsp-select',
        //     value: forwardAlias,
        //     disabled: forwardBusy || hosts.length === 0,
        //     onChange: (event) => setForwardAlias(event.target.value),
        //     children: [
        //       jsx('option', { value: '', children: t('remote.host') }),
        //       ...hosts.map((host) => jsx('option', { key: host.alias, value: host.alias, children: host.alias })),
        //     ],
        //   }),
        //   jsx('input', {
        //     className: 'sshwsp-input sshwsp-input-port',
        //     type: 'number',
        //     min: 1,
        //     max: 65535,
        //     placeholder: t('forwards.remotePort'),
        //     value: forwardRemotePort,
        //     disabled: forwardBusy,
        //     onChange: (event) => setForwardRemotePort(event.target.value),
        //     onKeyDown: (event) => { if (event.key === 'Enter') handleForward() },
        //   }),
        //   jsx('input', {
        //     className: 'sshwsp-input sshwsp-input-port',
        //     type: 'number',
        //     min: 1,
        //     max: 65535,
        //     placeholder: t('forwards.localPlaceholder'),
        //     value: forwardLocalPort,
        //     disabled: forwardBusy,
        //     onChange: (event) => setForwardLocalPort(event.target.value),
        //     onKeyDown: (event) => { if (event.key === 'Enter') handleForward() },
        //   }),
        //   jsx('button', {
        //     className: 'sshwsp-btn sshwsp-btn-primary',
        //     disabled: forwardBusy || forwardAlias === '' || forwardRemotePort.trim() === '',
        //     onClick: handleForward,
        //     children: forwardBusy ? t('forwards.adding') : t('forwards.add'),
        //   }),
        // ]}),
        // (status.forwards ?? []).length === 0
        //   ? jsx('div', { className: 'sshwsp-empty', children: t('forwards.none') })
        //   : (status.forwards ?? []).map((forward) => jsxs('div', { key: forward.id, className: 'sshwsp-mount', children: [
        //       jsx('span', { className: 'sshwsp-mount-path', children: `${forward.localHost}:${forward.localPort} → ${forward.alias}:${forward.remoteHost}:${forward.remotePort}` }),
        //       forward.connections > 0 && jsx('span', { className: 'sshwsp-entry-meta', children: t('forwards.connections', { n: forward.connections }) }),
        //       jsx('a', {
        //         className: 'sshwsp-btn',
        //         href: forwardUrlOf(forward),
        //         target: '_blank',
        //         rel: 'noreferrer',
        //         children: t('forwards.open'),
        //       }),
        //       jsx('button', {
        //         className: 'sshwsp-btn sshwsp-btn-danger',
        //         onClick: () => handleUnforward(forward.id),
        //         children: t('forwards.close'),
        //       }),
        //     ]})),

        // ---- Mounted workspaces（已屏蔽，代码保留：需要时去掉注释即可恢复）
        // jsx('h3', { children: t('mounted.title') }),
        // (status.mounted ?? []).length === 0
        //   ? jsx('div', { className: 'sshwsp-empty', children: t('mounted.none') })
        //   : (status.mounted ?? []).map((wsPath) =>
        //       jsxs('div', { key: wsPath, className: 'sshwsp-mount', children: [
        //         React.createElement(RemoteMarkIcon, { size: 16, className: 'sshwsp-entry-icon' }),
        //         jsx('span', { className: 'sshwsp-mount-path', children: wsPath }),
        //         jsx('button', {
        //           className: 'sshwsp-btn sshwsp-btn-danger',
        //           onClick: () => handleUnmount(wsPath),
        //           children: t('mounted.unmount'),
        //         }),
        //       ]})
        //     ),

        // ---- Browser dialog（已屏蔽，代码保留：需要时去掉注释即可恢复）
        // browserAlias !== null && jsx(DirectoryBrowser, {
        //   alias: browserAlias,
        //   onClose: () => setBrowserAlias(null),
        //   onMount: () => { refresh(); setBrowserAlias(null) },
        //   t,
        // }),

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

      return jsxs('div', { className: 'sshwsp-backdrop', onClick: () => { if (!creating && !busy) onCancel() }, children: [
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
    const remoteMarks = { ids: new Set(), titles: new Set() }
    let marksCtx = null

    /** Reset the identity sets from workspace-like records ({workspaceId|id, path, title}). */
    function collectRemoteWorkspaces (items) {
      const ids = new Set()
      const titles = new Set()
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
      }
      remoteMarks.ids = ids
      remoteMarks.titles = titles
    }

    /** Update the mark source from a /status reply (panel fetch, flow completion). */
    function syncRemoteWorkspaceMarks (entries) {
      collectRemoteWorkspaces(entries)
      scheduleRemoteMarks()
    }

    /** Fetch /status once and refresh the fallback mark source from it. */
    async function refreshRemoteWorkspaceMarks () {
      try {
        const data = await fetchJson(API.status)
        syncRemoteWorkspaceMarks(data.workspaces)
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
        if (Array.isArray(items)) collectRemoteWorkspaces(items)
      } catch { /* service unavailable — the last known set stands */ }
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

    /** Delegated drag listeners: tree rows out, the composer card in. */
    function installTreeDragBridge (ctx) {
      if (typeof document === 'undefined') return

      document.addEventListener('dragstart', (event) => {
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
      }, true)

      document.addEventListener('dragover', (event) => {
        if (dragPayload === null) return
        const target = event.target
        const card = target instanceof Element ? target.closest(COMPOSER_CARD_SELECTOR) : null
        setDropCard(card)
        if (card === null) return
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      }, true)

      document.addEventListener('drop', (event) => {
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
      }, true)

      document.addEventListener('dragend', () => {
        dragPayload = null
        setDropCard(null)
      }, true)
    }

    /** Delegated right-click listener: the row menu. */
    function installTreeMenuBridge (ctx) {
      if (typeof document === 'undefined') return
      document.addEventListener('contextmenu', (event) => {
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
      }, true)
    }

    let composerBridgesInstalled = false

    /** Install the delegated drag / right-click gestures once. */
    function installComposerBridges (ctx) {
      if (composerBridgesInstalled) return
      composerBridgesInstalled = true
      installTreeDragBridge(ctx)
      installTreeMenuBridge(ctx)
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
      installComposerBridges(ctx)
      refreshRemoteWorkspaceMarks()

      // Register locale dictionaries, then bind the host seat for the active
      // language. Placeholder expansion is layered on top: the bound seat is
      // not guaranteed to expand `{name}` across hosts, and a re-apply must
      // not lose it when the namespace is already registered.
      try { ctx.locale?.register?.(NS, { zh, en }) } catch { /* already registered */ }
      try {
        const bound = ctx.locale?.bind?.(NS)
        if (bound !== undefined) translate = (key, params) => applyParams(bound(key), params)
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
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
