window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')

    // =========================================================================
    // Map of this file
    // =========================================================================
    //
    // This is ONE bundle because the Host's client-module system takes exactly
    // one `factory(require)` per `dsh.client` entry: `window.__ModuleLoader__
    // .load({ id, factory })` is the contract, and a second sibling module is
    // not reachable through it without adding a second `dsh.client` entry —
    // which the plugin's `package.json` does not declare, and which would
    // change how the Host composes this plugin. Splitting into `client/*.js`
    // files therefore needs a build step, and this plugin deliberately has none
    // (a loader-only plugin: no bundler, no TypeScript).
    //
    // So the maintainability problem ("keep a very large context in mind while
    // editing") is addressed INSIDE the file, by keeping one section per
    // responsibility and listing them here. Every section starts with the same
    // `// ====` banner, so a jump-to-next-banner walk visits them in order.
    //
    //   1. API client
    //   2. Locale
    //   3. CSS (injected once at module load)
    //   4. SVG Icons
    //   5. Host card
    //   6. Host editor dialog
    //   7. Directory browser dialog
    //   8. Diagnostic report dialog
    //   9. Main panel
    //  10. Add-workspace flow (directoryFlow slot occupant)
    //  11. Panel icon (sidebar row glyph)
    //  12. Panel page wrapper
    //  13. Remote-workspace marks (DOM decoration)
    //  14. Composer file bridge (drag / right-click → @ reference)
    //  15. Transfer queue (batch uploads, progress overlay, cancellation)
    //  16. Transfers from DSH's own file tree (row rename / delete)
    //  17. File-panel header actions
    //  18. Host file tree: Windows-style multi-select
    //  19. Plugin apply
    //
    // No line numbers, on purpose. The previous map carried them, and they were
    // stale in every single entry — editing the map itself shifts every number
    // below it, so the act of correcting the map re-broke it. The banner text
    // is the stable address; search for it.
    //
    // The map is also CHECKED. It had drifted to ten entries describing
    // sections that no longer existed under those names (a "Forwarding panel"
    // that is part of the main panel, a "persistent sessions" section that was
    // never a banner) while six real sections were missing. Nothing caught it
    // because nothing was looking: a comment cannot fail. `client-shape-smoke`
    // now parses the banner list out of this file and asserts that the two
    // lists agree in content and order, so the map can be wrong only while the
    // suite is red.
    //
    // =========================================================================

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
      // The two local-passthrough settings: the scheme name that spells a host
      // path explicitly, and whether a bare `@` POSIX path may fall back to the
      // host copy when the remote side reports it absent.
      passthroughSettings: '/api/dsh-ssh-workspace/passthrough/settings',
      download: '/api/dsh-ssh-workspace/download',
      downloadTree: '/api/dsh-ssh-workspace/download-tree',
      upload: '/api/dsh-ssh-workspace/upload',
      uploadChunk: '/api/dsh-ssh-workspace/upload-chunk',
      // The JSON-body door the queue uses for "download into a local folder":
      // the host writes the bytes, so the page never carries them.
      transfer: '/api/dsh-ssh-workspace/transfer',
      rename: '/api/dsh-ssh-workspace/rename',
      deleteEntry: '/api/dsh-ssh-workspace/delete',
      mkdir: '/api/dsh-ssh-workspace/mkdir',
      mutationPolicy: '/api/dsh-ssh-workspace/mutation-policy',
      selfCheck: '/api/dsh-ssh-workspace/self-check',
      supportBundle: '/api/dsh-ssh-workspace/support-bundle',
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

    /**
     * Read the diagnostic report's bytes.
     *
     * Separate from the copy/open handlers because BOTH need the same text and
     * the same failure path, and a second `fetch` spelling would drift: the
     * report route answers `text/plain`, not JSON, so `fetchJson` cannot be
     * reused and its error extraction has to be repeated here.
     *
     * @returns {Promise<string>} the report text.
     */
    async function fetchReportText () {
      const res = await fetch(API.supportBundle)
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || res.statusText)
      return await res.text()
    }

    // =========================================================================
    // Locale
    // =========================================================================
    const NS = 'dsh-ssh-workspace'
    const zh = {
      'entry.label': '远程工作区',
      'panel.title': '远程工作区',
      'panel.empty': '暂无已配置的 SSH 主机',
      'panel.storeError': '读不出主机存储，原因：',
      'panel.skipped': '另有 {n} 个条目无法使用（原因见诊断报告）',
      'panel.loading': '加载中…',
      'provenance.live': '实时',
      'provenance.cached': '缓存于 {ago}',
      'provenance.stale': '无法刷新，最后一次成功是 {ago}',
      'provenance.selfCheck': '主机工具探测',
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
      'hosts.lastUsed': '最近使用',
      'hosts.lastUsed.justNow': '刚刚',
      'hosts.lastUsed.minutes': '{n} 分钟前',
      'hosts.lastUsed.hours': '{n} 小时前',
      'hosts.lastUsed.days': '{n} 天前',
      'editor.tags': '标签（可选，逗号分隔）',
      'editor.tagsHint': '搜索框会匹配标签，例如 prod, db',
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
      'browser.truncated': '目录项过多：只显示前 {shown} 项（共 {total} 项），其余未列出',
      'browser.parent': '返回上级',
      'browser.mount': '挂载此目录',
      'browser.mounting': '挂载中…',
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
      'check.title': '远程环境自检',
      'check.none': '尚未探测任何主机；挂载一个工作区或点「自检」后生成报告',
      'check.run': '自检',
      'check.running': '探测中…',
      'check.present': '已安装',
      'check.absent': '缺失',
      'check.unknown': '未确定',
      'check.install': '安装：',
      'check.fail': '自检失败',
      'support.title': '诊断报告',
      'support.copy': '复制',
      'support.copied': '已复制到剪贴板',
      'support.open': '打开诊断报告',
      'support.fail': '无法生成诊断报告',
      'support.noClipboard': '当前环境没有剪贴板权限，请手动选择报告文本复制',
      'support.opened': '已打开诊断报告',
      'support.hint': '版本、补丁状态、主机配置、自检、最近命令与事件，路径与凭据已脱敏',
      'toast.details': '详情',
      'toast.copy': '复制',
      'toast.retry': '重试',
      'toast.copied': '已复制',
      'toast.copyFallback': '剪贴板不可用，已选中诊断文本，可按 Ctrl+C 复制',
      'toast.copyFallbackUnselected': '剪贴板不可用，且无法选中诊断文本，请手动展开详情复制',
      'toast.retrying': '正在重试…',
      'toast.retryFail': '重试失败',
      'toast.noDetail': '没有更多诊断信息',
      'check.done': '自检完成',
      'forwards.autoStartFail': '无法保存自动开启设置',
      // The status dot beside the section title. Three states, because
      // "could not judge" must not read as "fine" (a silent degradation ships
      // that way) nor as "broken" (an unreachable host is not a missing tool).
      'diagnosis.ok': '未发现问题',
      'diagnosis.warn': '{n} 项需要处理',
      'diagnosis.unknown': '{n} 项无法判断',
      'diagnosis.warnLabel': '需处理',
      'diagnosis.unknownLabel': '无法判断',
      'diagnosis.notes': '自检提示（{n} 项，不计入状态）',
      'audit.title': '最近的远端命令',
      'audit.refused': '被拒绝（未执行）',
      'audit.unknown': '结果未知（连接中断）',
      'audit.timedOut': '超时',
      'audit.more': '仅显示最近 {n} 条',
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
      // ---- local passthrough (host paths inside an ssh:// session)
      // Two levels: the zone the controls live in, and what the scheme box is.
      // They are separate keys because only the second one is also the input's
      // accessible name — renaming the zone must not rename the field.
      'passthrough.group': '文件引用设置',
      'passthrough.title': '显式文件引用 scheme',
      'passthrough.scheme': '本机路径前缀',
      'passthrough.schemeHint': '在 ssh:// 会话里用这个名字明确表示「这是本机路径」，例如 local:/Volumes/SSD/a.md。同一时间只能配置一个前缀：换名字即整体替换，旧前缀立刻失效，两个不能并列。至少 3 个字符（1 个字符会与 Windows 盘符冲突，例如 c:/x）。保留名（ssh、file、sftp、dsh-app 与常见 URL scheme）不能用，完整清单由服务端下发。前缀名不区分大小写（Local: 等价于 local:），而冒号后面的路径部分按平台：Windows 不区分大小写，macOS/Linux 区分。',
      'passthrough.schemePlaceholder': 'local',
      'passthrough.schemeSave': '保存',
      'passthrough.schemeInvalid': '只允许小写字母、数字与 + - .，且必须以字母开头',
      'passthrough.schemeTooShort': '前缀至少要 3 个字符；1 个字符会与 Windows 盘符（如 c:/x）冲突',
      'passthrough.schemeReserved': '{scheme} 已被占用：{reason}',
      'passthrough.schemeFail': '无法保存本机路径前缀',
      'passthrough.schemeSaved': '本机路径前缀已改为 {scheme}:，其它前缀已同时失效',
      'passthrough.schemeWarning': '已保存的前缀 {stored} 现在不可用（{message}），当前生效的是 {effective}；请重新保存以确认。',
      'passthrough.fallback': '远端不存在时回退本机同名文件',
      'passthrough.fallbackHint': '只对你在消息里用 @ 点名的路径生效，且只在远端确实报不存在之后才试一次本机；回退的内容末尾会附一行来源说明。POSIX 主机收例如 @/Volumes/SSD/a.md 的拼写，Windows 主机收 @F:\\123.txt 这类盘符与 UNC——Windows 上 @/home/… 这种 POSIX 拼写不会进引用表，回退对它不生效，必须本机时请直接加前缀。',
      'passthrough.fallbackFail': '无法保存回退设置',
      'passthrough.disabled': '本机直通当前已关闭（localPassthrough 为空），这两个设置不会生效。',
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
      'remote.truncated': '该目录共 {total} 项，超过一次列出的上限，下面的目录可能不全',
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
      'mention.addedPartly': '已插入 {added} 项，{failed} 项未插入：{names}',
      // ---- file tree transfers
      'transfer.download': '下载到本机',
      'transfer.upload': '上传文件到此目录',
      // The menu label is fixed; how many rows it will actually move is stated
      // by the dialog that asks for a destination, because a label carrying a
      // count made one verb read as two different actions.
      'transfer.downloadTargetTitle': '下载到本机',
      'transfer.downloadTargetSubtitle': '将下载 {count} 项到本机',
      'transfer.chooseTarget': '选择目标目录',
      'transfer.downloadQueued': '已加入队列 {count} 项',
      'transfer.downloadQueuedSkipped': '已加入队列 {count} 项，已跳过 {skipped} 个本地文件',
      'transfer.skippedLocal': '已跳过 {count} 个本地文件',
      'transfer.downloading': '正在下载 {name}…',
      'transfer.uploadingName': '正在上传 {name}…',
      'transfer.downloadFail': '下载失败',
      'transfer.uploadFail': '上传失败',
      // A browser refuses to elaborate on a request that died on the wire:
      // every cause arrives as the same four words. Naming the elapsed time is
      // the one fact the page can still contribute — the host drops a request
      // it has been receiving for five minutes, while a second means a dead
      // socket — so the message carries it instead of repeating the browser.
      'transfer.networkFail': '请求在 {seconds} 秒后中断：链路断开，或服务端在接收请求体时停止了等待',
      // An instant failure is not a timeout. Saying so is the difference
      // between "the app is restarting" and "your file is too big".
      'transfer.networkFailFast': '请求没能到达服务端（{seconds} 秒内即失败）：应用可能正在重启，或该请求被浏览器扩展拦截',
      'transfer.retried': '（已自动重试一次）',
      'transfer.notRemote': '该文件不在远端工作区中',
      // A folder drop is refused as a whole: walking it would turn one gesture
      // into an unbounded number of queue items. The sentence names what was
      // refused and offers the two paths that do work.
      'osdrop.folders': '暂不支持拖入文件夹（{names}）；请拖文件或使用上传按钮',
      // When the same drop also carried files, the refusal rides on the batch
      // toast instead of opening a second one: two toasts replace each other and
      // the sentence that matters disappears first.
      'osdrop.foldersSkipped': '已跳过文件夹：{names}',
      'osdrop.local': '本地工作区不能接收系统文件；请把文件拖到远端工作区',
      // A cancel has no other visible trace on the batch paths, so it gets a
      // line of its own instead of the failure wording.
      'transfer.pickCanceled': '已取消：没有选择目标文件夹',
      // ---- completion notices
      //
      // A transfer that finishes silently is indistinguishable from one that
      // finished while the user was looking somewhere else — and the tree rows
      // are the case where nothing else changes on screen, because the listing
      // belongs to DSH's own panel. The size is part of the message: "downloaded
      // 4.2 KB" and "downloaded 4.2 GB" are different news.
      'transfer.doneDownload': '已下载 {name}（{size}）',
      'transfer.doneUpload': '已上传 {name}（{size}）',
      // The fallback wording. Without the File System Access API the bytes are
      // handed to the browser's own download flow and nothing reports back
      // whether the user chose a folder — so this line says what is known
      // (the bytes left, and their size) and not what is guessed.
      'transfer.downloadStarted': '已开始下载 {name}（{size}），保存位置由浏览器决定',
      'transfer.dirDownloading': '正在打包 {name}…',
      'transfer.batchQueued': '传输队列：{count} 项…',
      // ---- transfer queue / progress
      //
      // The queue reports in two places: the icon entry in the Files panel
      // header, and a strip inside the directory dialog. Both draw from one
      // store, so the counted words have to describe the same object — "items"
      // here always means queue entries, never files. The header mark no longer
      // prints a word or a badge, so its accessible name carries the count.
      'queue.title': '传输进度',
      'queue.open': '查看传输进度',
      'queue.openCount': '查看传输进度（{count} 项）',
      'queue.empty': '暂无传输',
      'queue.queued': '等待中',
      'queue.cancelling': '取消中…',
      'queue.pausing': '暂停中…',
      'queue.paused': '已暂停',
      'queue.pauseItem': '暂停此项传输',
      'queue.resumeItem': '恢复此项传输',
      'queue.retryItem': '重试此项传输',
      'queue.verified': 'SHA-256 校验通过',
      'queue.unverified': '未校验：{reason}',
      'queue.unverifiedNoReason': '未校验（宿主没有 SHA-256 工具）',
      'queue.restarted': '源已变化，已从头重传（{reason}）',
      'queue.perSecond': '{size}/s',
      'queue.cancelItem': '取消此项传输',
      'queue.done': '已完成',
      'queue.failed': '失败',
      'queue.cancelled': '已取消',
      'queue.clear': '清除已完成',
      'queue.overwrite': '同名覆盖',
      'queue.refreshNote': '刷新或关闭页面会中断传输',
      'queue.oversize': '超过 {limit} 的文件不会被上传：{names}',
      'queue.summaryDone': '已传输 {count} 项（{size}）',
      'queue.summaryStarted': '已开始 {count} 项传输，保存位置由浏览器决定',
      'queue.summaryPartial': '{done} 项完成，{failed} 项失败',
      'queue.summaryPartialCancel': '{done} 项完成，{failed} 项失败，{cancelled} 项已取消',
      'queue.summaryCancelled': '{done} 项完成，{cancelled} 项已取消',
      'queue.summaryCancelledOnly': '{count} 项已取消',
      'queue.slotMissing': '此宿主版本没有提供右侧文件面板的动作栏，上传与传输进度入口已隐藏。',
      // ---- row menu: path actions (F-08)
      'rowmenu.copyPath': '复制路径',
      'rowmenu.copied': '路径已复制到剪贴板',
      'rowmenu.copyUnavailable': '此环境不允许访问剪贴板；请手动选中路径复制',
      'rowmenu.mountOk': '已挂载为 {path}',
      'rowmenu.mountFail': '挂载失败',
      // ---- row menu: rename / delete (remote and local)
      'rowmenu.rename': '重命名',
      'rowmenu.delete': '删除',
      'rowmenu.newFolder': '新建文件夹',
      'rowmenu.newFolderTitle': '新建文件夹',
      'rowmenu.newFolderHint': '在当前目录中创建，Enter 提交，Esc 取消。',
      'rowmenu.creating': '创建中…',
      'rowmenu.created': '已创建文件夹',
      'rowmenu.createFail': '新建文件夹失败',
      'rowmenu.createEmpty': '文件夹名称不能为空',
      'rowmenu.createInvalid': '文件夹名称不能是 “.” 或 “..”',
      'rowmenu.createSeparator': '文件夹名称不能包含 / 或 \\',
      'rowmenu.renameTitle': '重命名',
      'rowmenu.renameHint': '只改名，不移动目录。Enter 提交，Esc 取消。',
      'rowmenu.deleteIrreversible': '此操作不可恢复。',
      'rowmenu.deleteDirWarning': '选中的目录会连同其子目录一起删除。',
      'rowmenu.deleteMore': '…以及另外 {count} 项',
      'rowmenu.deleteOneFile': '删除该文件？',
      'rowmenu.deleteOneEmptyDir': '删除该空目录？',
      'rowmenu.deleteOneDir': '删除该目录及其下 {count} 个文件？',
      'rowmenu.deleteOneDirAll': '删除该目录及其下的全部内容？',
      'rowmenu.deleteMany': '删除 {count} 项？',
      'rowmenu.deleteCounts': '含 {dirs} 个目录、{files} 个文件',
      'rowmenu.deleteCountTruncated': '只统计了前 {limit} 项，实际可能更多',
      'rowmenu.deleteCountLocal': '本地目录的内容无法预先统计',
      'rowmenu.deleteCountFailed': '部分目录无法读取，实际范围可能更大',
      'rowmenu.deleteCountPending': '正在统计目录内容…',
      'rowmenu.renaming': '重命名中…',
      'rowmenu.renamed': '已重命名',
      'rowmenu.renameEmpty': '名称不能为空',
      'rowmenu.renameInvalid': '名称不能是 “.” 或 “..”',
      'rowmenu.renameSeparator': '名称不能包含 / 或 \\',
      'rowmenu.deleting': '删除中…',
      'rowmenu.renameFail': '重命名失败',
      'rowmenu.deleteFail': '删除失败',
      'rowmenu.deleteDone': '已删除 {count} 项',
      'rowmenu.deletePartial': '已删除 {done} 项，{failed} 项失败',
      'rowmenu.targetExists': '目标已存在',
      'rowmenu.readonly': '只读会话：重命名与删除已禁用',
      'rowmenu.localRootUnknown': '无法确定该路径所属的会话工作区：本地的重命名与删除已禁用',
      // ---- workspace file browser tab
    }
    const en = {
      'entry.label': 'Remote Workspace',
      'panel.title': 'Remote Workspaces',
      'panel.empty': 'No SSH hosts configured',
      'panel.storeError': 'Could not read the host store:',
      'panel.skipped': '{n} further entry(ies) cannot be used (see the diagnostic report)',
      'panel.loading': 'Loading…',
      'provenance.live': 'live',
      'provenance.cached': 'cached {ago}',
      'provenance.stale': 'could not refresh; last good {ago}',
      'provenance.selfCheck': 'host tool probe',
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
      'hosts.lastUsed': 'last used',
      'hosts.lastUsed.justNow': 'just now',
      'hosts.lastUsed.minutes': '{n} min ago',
      'hosts.lastUsed.hours': '{n} h ago',
      'hosts.lastUsed.days': '{n} d ago',
      'editor.tags': 'Tags (optional, comma separated)',
      'editor.tagsHint': 'The search box matches tags, for example prod, db',
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
      'browser.truncated': 'Too many entries: showing the first {shown} of {total}, the rest are not listed',
      'browser.parent': 'Go up',
      'browser.mount': 'Mount this directory',
      'browser.mounting': 'Mounting…',
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
      'check.title': 'Remote environment self-check',
      'check.none': 'No host has been probed yet — mount a workspace or press Self-check to produce a report',
      'check.run': 'Self-check',
      'check.running': 'Probing…',
      'check.present': 'present',
      'check.absent': 'missing',
      'check.unknown': 'undetermined',
      'check.install': 'install: ',
      'check.fail': 'Self-check failed',
      'support.title': 'Diagnostic report',
      'support.copy': 'Copy',
      'support.copied': 'Copied to the clipboard',
      'support.open': 'Open diagnostic report',
      'support.fail': 'Could not build the diagnostic report',
      'support.noClipboard': 'This environment grants no clipboard access; select the report text and copy it manually',
      'support.opened': 'Diagnostic report opened',
      'support.hint': 'Versions, patch verdicts, host configuration, self-check, recent commands and events, with paths and credentials masked',
      'toast.details': 'Details',
      'toast.copy': 'Copy',
      'toast.retry': 'Retry',
      'toast.copied': 'Copied',
      'toast.copyFallback': 'Clipboard unavailable — diagnostic text selected; press Ctrl+C to copy',
      'toast.copyFallbackUnselected': 'Clipboard unavailable and the text could not be selected; open details and copy manually',
      'toast.retrying': 'Retrying…',
      'toast.retryFail': 'Retry failed',
      'toast.noDetail': 'No further diagnostic detail',
      'check.done': 'Self-check complete',
      'forwards.autoStartFail': 'Could not save the auto-start setting',
      'diagnosis.ok': 'No problems found',
      'diagnosis.warn': '{n} need attention',
      'diagnosis.unknown': '{n} could not be judged',
      'diagnosis.warnLabel': 'needs attention',
      'diagnosis.unknownLabel': 'could not judge',
      'diagnosis.notes': 'Self-check notes ({n}, not counted in the status)',
      'audit.title': 'Recent remote commands',
      'audit.refused': 'refused (nothing ran)',
      'audit.unknown': 'outcome unknown (connection lost)',
      'audit.timedOut': 'timed out',
      'audit.more': 'showing the last {n}',
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
      // ---- local passthrough (host paths inside an ssh:// session)
      'passthrough.group': 'File reference settings',
      'passthrough.title': 'Explicit file reference scheme',
      'passthrough.scheme': 'Host scheme',
      'passthrough.schemeHint': 'Name a path with this prefix to read it on THIS machine, e.g. local:/Volumes/SSD/a.md. Only one prefix can be configured at a time: saving a different name replaces it wholesale and the old one stops working immediately — the two are never listed side by side. At least 3 characters (a one-character name would collide with a Windows drive letter such as c:/x). Reserved names (ssh, file, sftp, dsh-app and the common URL schemes) cannot be used; the exact list is published by the server. The prefix name is case-insensitive (Local: equals local:), while the path after the colon follows the platform: case-insensitive on Windows, case-sensitive on macOS/Linux.',
      'passthrough.schemePlaceholder': 'local',
      'passthrough.schemeSave': 'Save',
      'passthrough.schemeInvalid': 'Lowercase letters, digits and + - . only, starting with a letter',
      'passthrough.schemeTooShort': 'A prefix needs at least 3 characters; one character would collide with a Windows drive letter such as c:/x',
      'passthrough.schemeReserved': '{scheme} is already in use: {reason}',
      'passthrough.schemeFail': 'Could not save the host scheme',
      'passthrough.schemeSaved': 'Host scheme changed to {scheme}: — any other prefix has stopped working',
      'passthrough.schemeWarning': 'The saved prefix {stored} is no longer usable ({message}); {effective} is in effect now — save again to confirm.',
      'passthrough.fallback': 'Fall back to this machine when the remote lacks it',
      'passthrough.fallbackHint': 'Applies only to paths you name with @ in a message, and only after the remote side really reports the path absent; the fallback content ends with a note saying where it came from. A POSIX host accepts spellings such as @/Volumes/SSD/a.md; a Windows host accepts drive and UNC spellings such as @F:\\123.txt. On Windows a POSIX spelling like @/home/me/x.md never enters the reference table, so the fallback cannot apply to it — add the prefix when you need this machine for certain.',
      'passthrough.fallbackFail': 'Could not save the fallback setting',
      'passthrough.disabled': 'Local passthrough is off (localPassthrough is empty), so neither setting has any effect.',
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
      'remote.truncated': 'This directory has {total} entries, more than one listing returns — some directories may be missing below',
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
      'mention.addedPartly': 'Inserted {added} reference(s); {failed} could not be inserted: {names}',
      // ---- file tree transfers
      'transfer.download': 'Download to this machine',
      'transfer.upload': 'Upload a file here',
      'transfer.downloadTargetTitle': 'Download to this machine',
      'transfer.downloadTargetSubtitle': 'Download {count} item(s) to this machine',
      'transfer.chooseTarget': 'Choose destination folder',
      'transfer.downloadQueued': '{count} item(s) added to the queue',
      'transfer.downloadQueuedSkipped': '{count} item(s) added to the queue; skipped {skipped} local file(s)',
      'transfer.skippedLocal': 'Skipped {count} local file(s)',
      'transfer.downloading': 'Downloading {name}…',
      'transfer.uploadingName': 'Uploading {name}…',
      'transfer.downloadFail': 'Download failed',
      'transfer.uploadFail': 'Upload failed',
      'transfer.networkFail': 'the request was cut off after {seconds}s: the link dropped, or the server stopped waiting for the body',
      'transfer.networkFailFast': 'the request never reached the server (it failed within {seconds}s): the app may be restarting, or an extension blocked it',
      'transfer.retried': ' (retried once)',
      'transfer.notRemote': 'That file is not in a remote workspace',
      // Folder drops are refused as a whole: walking one would turn a single
      // gesture into an unbounded number of queue items.
      'osdrop.folders': 'Folders cannot be dropped yet ({names}); drop files or use the upload button',
      // When the same drop also carried files, the refusal rides on the batch
      // toast instead of opening a second one: two toasts replace each other and
      // the sentence that matters disappears first.
      'osdrop.foldersSkipped': 'Skipped folders: {names}',
      'osdrop.local': 'A local workspace cannot take files from the system; drop them into a remote workspace',
      'transfer.pickCanceled': 'Cancelled: no destination folder was chosen',
      'transfer.doneDownload': 'Downloaded {name} ({size})',
      'transfer.doneUpload': 'Uploaded {name} ({size})',
      'transfer.downloadStarted': 'Download started: {name} ({size}) — the browser chooses where to save it',
      'transfer.dirDownloading': 'Packing {name}…',
      'transfer.batchQueued': 'Transfer queue: {count} item(s)…',
      // ---- transfer queue / progress
      'queue.title': 'Transfer progress',
      'queue.open': 'Show transfer progress',
      'queue.openCount': 'Show transfer progress ({count} item(s))',
      'queue.empty': 'No transfers',
      'queue.queued': 'queued',
      'queue.cancelling': 'cancelling…',
      'queue.pausing': 'pausing…',
      'queue.paused': 'paused',
      'queue.pauseItem': 'Pause this transfer',
      'queue.resumeItem': 'Resume this transfer',
      'queue.retryItem': 'Retry this transfer',
      'queue.verified': 'SHA-256 verified',
      'queue.unverified': 'Unverified: {reason}',
      'queue.unverifiedNoReason': 'Unverified (no SHA-256 tool on the host)',
      'queue.restarted': 'The source changed, so it restarted from zero ({reason})',
      'queue.perSecond': '{size}/s',
      'queue.cancelItem': 'Cancel this transfer',
      'queue.done': 'done',
      'queue.failed': 'failed',
      'queue.cancelled': 'cancelled',
      'queue.clear': 'Clear finished',
      'queue.overwrite': 'overwrites a name that exists',
      'queue.refreshNote': 'Reloading or closing the page stops every transfer',
      'queue.oversize': 'Files over {limit} are not uploaded: {names}',
      'queue.summaryDone': 'Transferred {count} item(s) ({size})',
      'queue.summaryStarted': 'Started {count} transfer(s); the browser decides where each one is saved',
      'queue.summaryPartial': '{done} finished, {failed} failed',
      'queue.summaryPartialCancel': '{done} finished, {failed} failed, {cancelled} cancelled',
      'queue.summaryCancelled': '{done} finished, {cancelled} cancelled',
      'queue.summaryCancelledOnly': '{count} cancelled',
      'queue.slotMissing': 'This host build does not provide the Files panel action bar, so the upload and transfer-progress entries are hidden.',
      // ---- row menu: path actions (F-08)
      'rowmenu.copyPath': 'Copy path',
      'rowmenu.copied': 'Path copied to the clipboard',
      'rowmenu.copyUnavailable': 'This environment grants no clipboard access; select the path and copy it manually',
      'rowmenu.mountOk': 'Mounted as {path}',
      'rowmenu.mountFail': 'Mount failed',
      // ---- row menu: rename / delete (remote and local)
      'rowmenu.rename': 'Rename',
      'rowmenu.delete': 'Delete',
      'rowmenu.newFolder': 'New folder',
      'rowmenu.newFolderTitle': 'New folder',
      'rowmenu.newFolderHint': 'Creates the folder in the current directory. Enter submits, Esc cancels.',
      'rowmenu.creating': 'Creating…',
      'rowmenu.created': 'Folder created',
      'rowmenu.createFail': 'Could not create the folder',
      'rowmenu.createEmpty': 'The folder name cannot be empty',
      'rowmenu.createInvalid': 'The folder name cannot be "." or ".."',
      'rowmenu.createSeparator': 'The folder name cannot contain / or \\',
      'rowmenu.renameTitle': 'Rename',
      'rowmenu.renameHint': 'Renames without moving the entry. Enter submits, Esc cancels.',
      'rowmenu.deleteIrreversible': 'This cannot be undone.',
      'rowmenu.deleteDirWarning': 'Selected directories are removed together with their subdirectories.',
      'rowmenu.deleteMore': '…and {count} more',
      'rowmenu.deleteOneFile': 'Delete this file?',
      'rowmenu.deleteOneEmptyDir': 'Delete this empty folder?',
      'rowmenu.deleteOneDir': 'Delete this folder and the {count} file(s) inside it?',
      'rowmenu.deleteOneDirAll': 'Delete this folder and everything inside it?',
      'rowmenu.deleteMany': 'Delete {count} item(s)?',
      'rowmenu.deleteCounts': '{dirs} folder(s) and {files} file(s)',
      'rowmenu.deleteCountTruncated': 'only the first {limit} item(s) were counted; there may be more',
      'rowmenu.deleteCountLocal': 'a local folder cannot be counted in advance',
      'rowmenu.deleteCountFailed': 'some folders could not be read, so the real scope may be larger',
      'rowmenu.deleteCountPending': 'Counting what is inside…',
      'rowmenu.renaming': 'Renaming…',
      'rowmenu.renamed': 'Renamed',
      'rowmenu.renameEmpty': 'The name cannot be empty',
      'rowmenu.renameInvalid': 'The name cannot be "." or ".."',
      'rowmenu.renameSeparator': 'The name cannot contain / or \\',
      'rowmenu.deleting': 'Deleting…',
      'rowmenu.renameFail': 'Rename failed',
      'rowmenu.deleteFail': 'Delete failed',
      'rowmenu.deleteDone': 'Deleted {count} item(s)',
      'rowmenu.deletePartial': 'Deleted {done}, {failed} failed',
      'rowmenu.targetExists': 'The target already exists',
      'rowmenu.readonly': 'Read-only session: rename and delete are disabled',
      'rowmenu.localRootUnknown': 'Cannot determine which session workspace owns this path: local rename and delete are disabled',
      // ---- workspace file browser tab
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

/**
 * Render one provenance label as a sentence.
 *
 * The panel does not decide freshness — the server does, because only the
 * server knows when a cached value was stored. This function's whole job is to
 * put that decision into words, and to leave an unknown label VISIBLE rather
 * than silently blank: a section with an age the panel cannot describe is a
 * section the user should not be shown as current.
 *
 * @param {(key: string, vars?: object) => string} t - the translator.
 * @param {{kind: string, at: number}|undefined} label - the server's label.
 * @param {number} [now] - override for tests.
 * @returns {string|undefined} the sentence, or undefined when there is no label.
 */
function provenanceText (t, label, now) {
  if (label === undefined || label === null || typeof label.kind !== 'string') return undefined
  if (label.kind === 'live') return t('provenance.live')
  const ago = relativeTimeText(t, label.at, now)
  if (label.kind === 'stale') return t('provenance.stale', { ago })
  if (label.kind === 'cached') return t('provenance.cached', { ago })
  // An unrecognised kind is shown as-is: it is a bug, and hiding it would make
  // the panel look certain about something it does not understand.
  return label.kind
}

/**
 * A coarse, translated "how long ago" for a host card.
 *
 * Deliberately coarse — minutes, hours, days — and never an absolute date. The
 * question the card answers is "is this the one I was just using?", and a
 * timestamp would make the reader do the subtraction. Past a few days the answer
 * stops being useful for that question, so days is where it stops counting.
 *
 * `now` is injectable so a test can drive it without waiting.
 *
 * @param {(key: string, vars?: object) => string} t - the translator.
 * @param {number} at - epoch milliseconds.
 * @param {number} [now] - override for tests.
 * @returns {string} the phrase.
 */
function relativeTimeText (t, at, now) {
  const current = typeof now === 'number' ? now : Date.now()
  const seconds = Math.max(0, Math.round((current - at) / 1000))
  if (seconds < 60) return t('hosts.lastUsed.justNow')
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return t('hosts.lastUsed.minutes', { n: minutes })
  const hours = Math.max(1, Math.round(minutes / 60))
  if (hours < 24) return t('hosts.lastUsed.hours', { n: hours })
  return t('hosts.lastUsed.days', { n: Math.max(1, Math.round(hours / 24)) })
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
/* A subheading under a section head: same size as the h3 so the zone still
   reads as one block, but lighter and dimmer so it is visibly one level down.
   The top margin stays 0 on purpose — it inherits the section head's bottom
   margin through margin collapsing, and a second 12px would open a gap that
   separates a title from the controls it names. */
.sshwsp h4 { font-size: 12px; font-weight: 400; margin: 0 0 10px; color: var(--dsw-alias-label-tertiary, #666); letter-spacing: 0.02em; }
.sshwsp-card { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
.sshwsp-host { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sshwsp-host-info { flex: 1; min-width: 0; }
.sshwsp-host-alias { font-weight: 500; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.sshwsp-host-addr { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); font-family: var(--dsw-font-markdown-code-font-family, monospace); }
.sshwsp-host-meta { display: flex; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); margin-top: 2px; }
.sshwsp-host-desc { font-size: 12px; color: var(--dsw-alias-label-secondary, #999); margin-top: 2px; overflow-wrap: anywhere; }
.sshwsp-host-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sshwsp-host-lastused { font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); margin-top: 4px; }
.sshwsp-provenance { font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); margin-bottom: 8px; }
.sshwsp-host-tag {
  font-size: 11px;
  line-height: 1.4;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #999);
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.16));
  overflow-wrap: anywhere;
}
.sshwsp-host-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.sshwsp-host-confirm { flex-basis: 100%; display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); padding-top: 8px; }
.sshwsp-host-confirm span { flex: 1; font-size: 12px; color: var(--dsw-alias-label-tertiary, #666); }
.sshwsp-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 24px 0 12px; }
.sshwsp-section-head h3 { margin: 0; }
/* The report title carries the verdict dot. inline-flex so the dot sits on
   the text's optical centre rather than its baseline, and the gap keeps it
   from touching the last glyph. */
.sshwsp-report-title { display: inline-flex; align-items: center; gap: 7px; }
.sshwsp-diagnosis { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px; }
.sshwsp-diagnosis-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 1.5; }
.sshwsp-diagnosis-detail { color: var(--dsw-alias-label-secondary, #a0a0a0); }
/* Advisory rows: collapsed by default and quieter than the findings, because
   they are context, not a verdict. They still have to be READABLE when opened —
   a self-check the user cannot read is the same as no self-check. */
.sshwsp-diagnosis-notes { margin: 0 0 12px; font-size: 12px; line-height: 1.5; }
.sshwsp-diagnosis-notes > summary { cursor: pointer; color: var(--dsw-alias-label-tertiary, #888); }
.sshwsp-diagnosis-notes > .sshwsp-diagnosis-row { padding-left: 12px; }
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
/* Neutral chip for "undetermined": it is not a warning (nothing is known to be
   wrong) and it is not success (nothing is known to be right). Grey is the only
   colour that says neither. */
.sshwsp-status-off { color: var(--dsw-alias-label-tertiary, #666); background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #666) 15%, transparent); }
.sshwsp-check-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.sshwsp-check-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12px; }
.sshwsp-check-tool { font-family: var(--dsw-font-markdown-code-font-family, monospace); font-weight: 600; }
/* A self-check card: the header is the disclosure control, so the card stacks
   instead of flowing the way .sshwsp-mount (a one-line mount row) does. */
.sshwsp-mount-col { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
.sshwsp-check-head { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; padding: 0; border: none; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sshwsp-check-head:disabled { cursor: default; }
.sshwsp-check-head:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: 2px; border-radius: 4px; }
.sshwsp-check-caret { flex: 0 0 auto; width: 10px; color: var(--dsw-alias-label-tertiary, #888); font-size: 10px; }
.sshwsp-check-spacer { flex: 1; }
.sshwsp-check-inline { font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; color: var(--dsw-alias-state-warning-primary, #f0a020); overflow-wrap: anywhere; }
.sshwsp-audit-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12px; padding: 2px 0; }
.sshwsp-audit-command { font-family: var(--dsw-font-markdown-code-font-family, monospace); overflow-wrap: anywhere; }
.sshwsp-toast { position: fixed; left: 50%; top: 40px; transform: translateX(-50%); z-index: 1100; box-sizing: border-box; max-width: min(480px, 90vw); padding: 9px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); background: var(--dsw-alias-bg-layer-3, #1a1a1a); box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); font-size: 12px; line-height: 1.5; cursor: pointer; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; animation: sshwsp-toast-in 160ms ease-out; }
.sshwsp-toast-ok { color: var(--dsw-alias-state-success-primary, #4ade80); }
.sshwsp-toast-err { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.sshwsp-toast-muted { color: var(--dsw-alias-text-secondary, #9aa0a6); }
/* The toast is a fixed frame with an action row and a collapsible detail
   block. Buttons live BELOW the message rather than replacing it, so the
   sentence that says what failed survives every action. */
.sshwsp-toast-line { display: block; }
.sshwsp-toast-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 7px; }
.sshwsp-toast-action { appearance: none; padding: 1px 0; border: 0; background: none; color: inherit; font: inherit; font-size: 11px; line-height: 1.4; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; opacity: 0.9; }
.sshwsp-toast-action:hover { opacity: 1; }
.sshwsp-toast-action:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 2px; }
.sshwsp-toast-action:disabled { cursor: progress; opacity: 0.55; }
.sshwsp-toast-action[hidden] { display: none; }
.sshwsp-toast-status { display: block; margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
.sshwsp-toast-status:empty { display: none; }
.sshwsp-toast-detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); color: var(--dsw-alias-label-secondary, #aaa); cursor: text; }
.sshwsp-toast-detail[hidden] { display: none; }
.sshwsp-toast-detail-code { display: block; margin-bottom: 4px; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 10px; letter-spacing: 0.02em; opacity: 0.85; }
.sshwsp-toast-detail pre { margin: 0; max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 11px; line-height: 1.45; color: var(--dsw-alias-text-secondary, #9aa0a6); user-select: text; cursor: text; }
@keyframes sshwsp-toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
.sshwsp-browser { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 8px; overflow: hidden; }
.sshwsp-browser-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06)); border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)); }
.sshwsp-browser-path { flex: 1; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-browser-list { max-height: 360px; overflow-y: auto; }
.sshwsp-entry { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 8px 14px; border: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); background: none; color: inherit; font: inherit; text-align: left; cursor: default; transition: background 100ms ease-out; }
.sshwsp-entry-dir { cursor: pointer; }
.sshwsp-entry:focus-visible { outline: 1px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -1px; }
.sshwsp-entry-dir:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
/* Host file tree (DSH's own Files tab): selection is painted onto the host's
   rows through classes of our own. Nothing here targets a host class name, so a
   restyle upstream cannot silently drop the highlight — and a selected row is
   still the host's row, with the host's handlers, underneath. */
.sshwsp-tree-row-selected { background: color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 14%, transparent) !important; }
.sshwsp-tree-row-selected > button { background: transparent; }
.sshwsp-tree-row-cursor > button { outline: 1px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -1px; border-radius: 4px; }
/* The in-place rename editor. It is PORTALED to <body>, so it is positioned
   against the viewport from the row's name span; nothing here may assume it is
   a descendant of the row it edits. */
.sshwsp-inline-rename { position: fixed; z-index: 1400; box-sizing: border-box; padding: 0 4px; border: 1px solid var(--dsw-alias-button-info-fill, #4a9eff); border-radius: 4px; background: var(--dsw-alias-bg-layer-3, #1a1a1a); color: var(--dsw-alias-label-primary, #e0e0e0); font: inherit; font-size: 13px; outline: none; }
.sshwsp-inline-rename[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary, #ff6b6b); }

.sshwsp-entry:last-child { border-bottom: none; }
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
/* The reason behind an empty section: smaller, left-aligned, and NOT centred —
   it is a diagnosis, not a placeholder, and centring it would read as decoration. */
.sshwsp-empty-detail { margin-top: 6px; font-size: 12px; line-height: 1.5; word-break: break-word; opacity: 0.85; }
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
/* The host-scheme box and its Save button. Same trap as the forward row: the
   bare .sshwsp-input declares width:100%, so the field is scoped here rather
   than styled by the shared class alone. The box is capped instead of
   stretched — a scheme name is short, and a full-width field would suggest it
   takes a path. */
.sshwsp-passthrough-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-start; margin: 0 0 8px; }
.sshwsp-passthrough-row .sshwsp-input { flex: 0 1 160px; width: 160px; min-width: 90px; max-width: 160px; }
.sshwsp-passthrough-row .sshwsp-btn { flex: 0 0 auto; }
/* Both settings are meaningless while localPassthrough is empty, and saying so
   is the only way a user learns why the controls do nothing. Left-aligned and
   small: this is a diagnosis, not a placeholder or a title. */
.sshwsp-passthrough-off { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary, #fbbf24); }
.sshwsp-passthrough-hint { margin: -2px 0 10px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #666); }
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
/* The report is monospaced text that keeps its own line breaks but WRAPS: a
   report is read line by line, and horizontal scrolling makes the reader drag
   sideways to finish a sentence. 'pre-wrap' preserves the report's own newlines
   and its leading indentation while letting long lines flow. */
.sshwsp-report-text { display: block; box-sizing: border-box; width: 100%; min-height: 360px; max-height: 60vh; margin: 0; padding: 14px 18px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06)); color: var(--dsw-alias-label-primary, #e0e0e0); border: 0; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; overflow-y: auto; overflow-x: hidden; resize: none; }
.sshwsp-report-text:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -2px; }
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
/* A busy icon is not a dead icon: its ring must stay legible while the button
   refuses a duplicate download of the same path. */
.sshwsp-icon-btn-busy:disabled { opacity: 1; cursor: default; }
/* The row menu: one line per item, 220px wide. It used to carry a second
   description line per action (the full path, the overwrite policy), which made
   a five-item menu read like a settings page and pushed it past six items once
   rename/delete arrived. A row already names the file it belongs to, so the
   path was repeating the row, not explaining the action. The add-workspace
   chooser is the one menu that keeps descriptions — they are its reason to
   exist — under the roomy modifier below. */
.sshwsp-flowmenu { position: fixed; z-index: 1300; width: 220px; box-sizing: border-box; background: var(--dsw-alias-bg-layer-3, #1a1a1a); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 8px; box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); padding: 4px; animation: sshwsp-menu-in 120ms ease-out; }
.sshwsp-menuitem { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 28px; box-sizing: border-box; padding: 5px 8px; border: none; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sshwsp-menuitem:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -2px; }
.sshwsp-menuitem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
.sshwsp-menuitem:disabled { opacity: 0.5; cursor: not-allowed; }
.sshwsp-menuitem-icon { display: inline-flex; align-self: center; color: var(--dsw-alias-label-secondary, #999); flex-shrink: 0; }
.sshwsp-menuitem-text { flex: 1; min-width: 0; }
.sshwsp-menuitem-title { display: block; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-menuitem-desc { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary, #888); margin-top: 2px; line-height: 1.45; overflow-wrap: anywhere; }
/* The right-click row menu is a quick action list, so it runs tighter than the
   add-workspace chooser: a 12px label on a 24px row. Scoped with
   :not(.sshwsp-flowmenu-roomy) because the chooser's two-line rows need the
   shared 13px / 28px base; an unscoped override would shrink both. */
.sshwsp-flowmenu:not(.sshwsp-flowmenu-roomy) .sshwsp-menuitem { min-height: 24px; gap: 6px; padding: 3px 6px; }
.sshwsp-flowmenu:not(.sshwsp-flowmenu-roomy) .sshwsp-menuitem-title { font-size: 12px; }
/* Roomier variant: the add-workspace chooser. Descriptions are its whole
   point, so it keeps the old two-line geometry and a slightly wider sheet. */
.sshwsp-flowmenu-roomy { width: 250px; padding: 5px; }
.sshwsp-flowmenu-roomy .sshwsp-menuitem { align-items: flex-start; gap: 10px; padding: 9px 10px; border-radius: 7px; }
.sshwsp-menusep { height: 1px; margin: 5px 8px; background: var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); }
.sshwsp-fileaction { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 12px; line-height: 1; white-space: nowrap; cursor: pointer; }
.sshwsp-fileaction:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-fileaction:disabled { opacity: 0.5; cursor: not-allowed; }
/* The transfer-queue entry: one glyph, not the word "Transfer". The tray
   arrow is the same mark the rows use, so the header reads as "downloads"
   before any text does. Idle it takes the primary label colour — the
   reference toolbar's near-black mark, not the muted grey of a secondary
   action — because this is the one control in that strip that must stay
   reachable while work is moving. While something is queued or running the
   mark turns the queue's blue and carries the aggregate ring; hover must not
   repaint it as a generic label, since a control that loses its blue on
   hover reads as "the transfer stopped". The count the mark no longer prints
   lives in its accessible name. */
.sshwsp-fileaction-queue { gap: 0; padding: 0 6px; color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-fileaction-queue-active { color: var(--dsw-alias-button-info-fill, #4a9eff); border-color: color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 40%, transparent); }
.sshwsp-fileaction-queue-active:hover { color: var(--dsw-alias-button-info-fill, #4a9eff); }
/* The popover's backdrop is deliberately transparent: this panel is anchored
   to a button, not a decision that should dim the page. It still covers the
   viewport so a click outside closes what the click opened. */
.sshwsp-popbackdrop { position: fixed; inset: 0; z-index: 1000; }
.sshwsp-queuepanel { position: fixed; z-index: 1001; width: 400px; max-width: calc(100vw - 16px); max-height: 320px; display: flex; flex-direction: column; box-sizing: border-box; background: var(--dsw-alias-bg-layer-3, #1a1a1a); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 10px; box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); animation: sshwsp-menu-in 120ms ease-out; }
.sshwsp-queue-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); }
.sshwsp-queue-title { flex: 1; font-size: 13px; font-weight: 600; }
.sshwsp-queue-list { overflow-y: auto; min-height: 0; flex: 1; }
.sshwsp-queue-foot { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); }
.sshwsp-queue-foot .sshwsp-entry-meta { flex: 1; line-height: 1.4; }
.sshwsp-queuerow { display: flex; align-items: flex-start; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); font-size: 12px; line-height: 1.45; }
.sshwsp-queuerow:last-child { border-bottom: none; }
.sshwsp-queuerow-failed { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 6%, transparent); }
.sshwsp-queueicon { flex: 0 0 auto; display: inline-flex; align-items: center; width: 16px; color: var(--dsw-alias-label-secondary, #999); }
.sshwsp-queueicon-active { color: var(--dsw-alias-button-info-fill, #4a9eff); }
.sshwsp-queuebody { flex: 1; min-width: 0; }
.sshwsp-queue-line { display: flex; align-items: baseline; gap: 8px; }
.sshwsp-queuename { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-queuemeta { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); font-family: var(--dsw-font-markdown-code-font-family, monospace); font-variant-numeric: tabular-nums; }
.sshwsp-queueerror { margin-top: 2px; color: var(--dsw-alias-state-error-primary, #ff6b6b); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
.sshwsp-queuenote { margin-top: 2px; color: var(--dsw-alias-label-secondary, #999); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
/* The download mark inside its ring: the tray arrow carries the verb
   ("download"), the ring carries the distance. One control, two readings — a
   percentage-only ring would lose the verb and a bare icon would lose the
   progress, which is the same pairing the reference toolbar shows. The grey
   track belongs to the same hue family as the blue arc and as the row's own
   bar, so one transfer never presents two competing meters. */
.sshwsp-dlring { display: inline-flex; }
.sshwsp-dlring-active { color: var(--dsw-alias-button-info-fill, #4a9eff); }
.sshwsp-dlring-track { stroke: color-mix(in srgb, var(--dsw-alias-label-tertiary, #888) 55%, transparent); }
.sshwsp-dlring-arc { transform-box: view-box; transform-origin: 50% 50%; transform: rotate(-90deg); }
/* Unknown total: a spinning 30% arc. An archive has moved bytes before it can
   know how many, and an arc parked at 0% would claim a stall it is not in. A
   known total instead fills, so each redraw states a fact, not a heartbeat. */
.sshwsp-dlring-live .sshwsp-dlring-arc { animation: sshwsp-dlring-spin 1.1s linear infinite; }
@keyframes sshwsp-dlring-spin { from { transform: rotate(-90deg); } to { transform: rotate(270deg); } }
/* A light-blue rule under each row. The row's text already states the number,
   so the bar only visualises it (aria-hidden) — a bar is not readable and a
   progress number is not glanceable, and either one alone would be a worse row.
   The track is a tint of the same hue as the fill, not a second colour: this
   panel already has an error red and a success green, and a third hue here
   would compete with both. */
.sshwsp-queuebar { position: relative; height: 3px; margin-top: 5px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 12%, transparent); }
.sshwsp-queuebar-fill { height: 100%; width: 0; border-radius: inherit; background: color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 78%, transparent); transition: width 160ms ease-out; }
/* No total: sweep the fill across the track. A determinate bar at an invented
   width is indistinguishable from a stuck one, which is exactly the reading
   this row must not invite. */
.sshwsp-queuebar-live .sshwsp-queuebar-fill { width: 38%; animation: sshwsp-queuebar-sweep 1.3s ease-in-out infinite; }
@keyframes sshwsp-queuebar-sweep { from { transform: translateX(-105%); } to { transform: translateX(285%); } }
/* Settled without success: the bar stops asserting a direction. The row's own
   state text is the fact; the fill only says how far the bytes got. */
.sshwsp-queuerow-failed .sshwsp-queuebar-fill, .sshwsp-queuerow-cancelled .sshwsp-queuebar-fill { background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #888) 55%, transparent); }
@media (prefers-reduced-motion: reduce) {
  .sshwsp-queuebar-live .sshwsp-queuebar-fill { animation: none; width: 60%; opacity: 0.7; }
  .sshwsp-queuebar-fill { transition: none; }
  .sshwsp-dlring-live .sshwsp-dlring-arc { animation: none; }
}
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

    /**
     * Shared geometry for the tray-and-arrow mark, in the 16-unit box.
     *
     * One tray, two arrows: the page's React icons and the row menu's DOM-built
     * svg draw the same mark, so a re-tune of these numbers moves both. The tray
     * is a U — two rails and a rounded base — rather than a rule, because at
     * 16px a lone rule under an arrow reads as "save to disk" only on a second
     * glance.
     */
    const TRAY_BASE_PATH = 'M3.2 8.9v2.5a1.2 1.2 0 001.2 1.2h7.2a1.2 1.2 0 001.2-1.2v-2.5'
    const TRAY_ARROW_PATHS = {
      download: ['M8 2.6v6.7', 'M5.4 6.6L8 9.3l2.6-2.7', TRAY_BASE_PATH],
      upload: ['M8 11.2v-5.4', 'M5.4 8.4L8 5.8l2.6 2.6', TRAY_BASE_PATH],
    }

    /**
     * Down arrow into a tray: the download mark.
     *
     * Drawn from the toolbar reference, not as the '↓' character: a font glyph
     * changes weight with every shell theme and cannot be outlined into the
     * same geometry as the progress ring. The character it replaces also said
     * "down", never the noun "download".
     */
    function DownloadIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      }, TRAY_ARROW_PATHS.download.map((d, index) => React.createElement('path', { key: index, d })))
    }

    /**
     * Up arrow out of a tray: the upload mark, the download mark mirrored.
     *
     * The queue prints both directions in one column, so the two glyphs are the
     * same drawing with the arrow flipped — anything less and that column reads
     * as two unrelated symbols at 16px.
     */
    function UploadIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      }, TRAY_ARROW_PATHS.upload.map((d, index) => React.createElement('path', { key: index, d })))
    }

    /**
     * The transfer mark inside a progress ring.
     *
     * Percent is the arc's length; an unknown total (`percent` null) turns a
     * fixed 30% arc instead. The two readings are deliberately different: a
     * filled arc states how far the transfer got, while a parked 0% arc would
     * claim a stall that an archive download is not in. A known total is
     * clamped just under 100, because a full ring's round caps would meet and
     * leave a visible seam.
     *
     * The ring wraps the mark instead of replacing it, which is what lets one
     * control carry both the verb and the distance. `direction` keeps that
     * verb honest: the header entry speaks for a queue that may be moving
     * either way, while the listing and queue rows are downloads and take the
     * default. The circle radius (7.2 of 16) leaves the tray clear of the
     * stroke at every size.
     */
    function TransferProgressIcon ({ size = 16, direction = 'download', percent = null, live = false, ...props }) {
      const known = typeof percent === 'number' && Number.isFinite(percent)
        ? Math.min(99.5, Math.max(0, percent))
        : null
      const paths = TRAY_ARROW_PATHS[direction] ?? TRAY_ARROW_PATHS.download
      const classes = 'sshwsp-dlring sshwsp-dlring-active' + (live ? ' sshwsp-dlring-live' : '')
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props, className: classes,
      },
        React.createElement('circle', { key: 'track', className: 'sshwsp-dlring-track', cx: 8, cy: 8, r: 7.2, strokeWidth: 1.3 }),
        React.createElement('circle', {
          key: 'arc', className: 'sshwsp-dlring-arc', cx: 8, cy: 8, r: 7.2, strokeWidth: 1.3,
          pathLength: 100,
          strokeDasharray: known === null ? (live ? '30 100' : '0 100') : `${known} 100`,
        }),
        React.createElement('g', { key: 'mark', transform: 'translate(2.6 2.6) scale(0.675)', strokeWidth: 1.9 },
          paths.map((d, index) => React.createElement('path', { key: index, d }))),
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
            // Only a LIVE connection can be closed. A `broken` record (and the
            // retry row built from one) is not connected — the badge beside it
            // already reads "已断开" — so offering "断开" claimed a state the
            // host was not in. Reconnecting rows get "立即重连" instead.
            (conn?.state === 'connected') && jsx('button', {
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
          // Tags are what the search box already matches on (routes.js filters
          // alias, host, user, description AND tags), so showing them is what
          // makes a tag-driven search result explicable: without this, typing
          // "prod" narrows the list to hosts whose cards never mention "prod".
          Array.isArray(host.tags) && host.tags.length > 0 && jsx('div', {
            className: 'sshwsp-host-tags',
            children: host.tags.map(tag => jsx('span', { key: tag, className: 'sshwsp-host-tag', children: tag })),
          }),
          // The list is ordered recent-first, so a card that never says WHY it
          // sits at the top makes the order look arbitrary, and a card with no
          // marker makes "the one I used ten minutes ago" indistinguishable
          // from one that has never been connected to.
          typeof host.lastUsedAt === 'number' && jsx('div', {
            className: 'sshwsp-host-lastused',
            children: `${t('hosts.lastUsed')} · ${relativeTimeText(t, host.lastUsedAt)}`,
          }),
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


    /**
     * The keyboard and screen-reader contract every dialog in this panel shares.
     *
     * The dialogs already had `aria-label` on their icon buttons, Esc handling
     * and focus rings, but not the half that decides whether a keyboard user can
     * operate them at all: no `role="dialog"` / `aria-modal`, no focus moved into
     * the dialog on open, no focus returned to the trigger on close, and no
     * trap — so Tab walked out of the dialog into the page behind it.
     *
     * Written once and used by both dialogs rather than three times separately,
     * because the interesting part is the focus lifecycle, and a copy per dialog
     * is how one of them ends up subtly different.
     *
     * `aria-modal` is claimed only because the trap is real: the panel renders
     * its dialogs above a backdrop, so the rest of the page genuinely is inert.
     *
     * @param {{onClose: () => void, label: string, busy?: boolean}} options - dialog wiring.
     * @returns {{props: object, bodyRef: object}} backdrop props plus a ref for the dialog body.
     */
    function useDialogA11y (options) {
      const bodyRef = React.useRef(null)
      const titleId = React.useId()
      // The element that opened the dialog is where focus must go back to.
      const openerRef = React.useRef(null)
      const closeRef = React.useRef(options.onClose)
      closeRef.current = options.onClose
      const busyRef = React.useRef(options.busy === true)
      busyRef.current = options.busy === true

      React.useEffect(() => {
        openerRef.current = document.activeElement
        const body = bodyRef.current
        // Move focus INTO the dialog: the first focusable control, or the body
        // itself so a screen reader announces the dialog rather than the page.
        const focusables = focusableWithin(body)
        if (focusables.length > 0) focusables[0].focus()
        else body?.focus?.()
        return () => {
          // Return focus on close, unless the opener is gone (a row that was
          // deleted while its dialog was open, or a re-render that replaced it).
          const opener = openerRef.current
          if (opener !== null && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
        }
      }, [])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            // A dialog that is mid-request must not be dismissed by Esc: the
            // POST would continue with nothing on screen to explain it.
            if (busyRef.current) return
            event.stopPropagation()
            closeRef.current()
            return
          }
          if (event.key !== 'Tab') return
          // The trap: Tab from the last control wraps to the first, Shift+Tab
          // from the first wraps to the last.
          const focusables = focusableWithin(bodyRef.current)
          if (focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [])

      return {
        bodyRef,
        props: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': options.label,
          'aria-labelledby': titleId,
        },
        titleId,
      }
    }

    /**
     * The focusable descendants of one node, in tab order.
     *
     * Selector-based rather than a tree walk: the panel's dialogs are small and
     * their controls are standard, so the platform's own definition of
     * focusable is the one to use.
     *
     * @param {Element|null|undefined} node - the container.
     * @returns {Element[]} focusable elements.
     */
    function focusableWithin (node) {
      if (node === null || node === undefined || typeof node.querySelectorAll !== 'function') return []
      const selector = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
      ].join(',')
      return [...node.querySelectorAll(selector)].filter(element => element.offsetParent !== null || element === document.activeElement)
    }

    /**
     * Where a menu key moves focus, given the current item and the item count.
     *
     * Split out from `useMenuKeyboard` so the arithmetic can be executed rather
     * than pattern-matched in a test: an assertion that only greps for
     * `'ArrowDown'` in the source passes whether or not the index maths is
     * right, which is the failure mode this repository keeps hitting.
     *
     * `current < 0` means focus is not on an item yet (it is still on the
     * trigger): ArrowDown enters at the top, ArrowUp at the bottom.
     *
     * @param {string} key - `KeyboardEvent.key`.
     * @param {number} current - index of the focused item, or -1.
     * @param {number} count - number of enabled items.
     * @returns {number|null} the index to focus, or null when the key is not a
     *   navigation key.
     */
    function nextMenuIndex (key, current, count) {
      if (count <= 0) return null
      switch (key) {
        case 'ArrowDown': return current < 0 ? 0 : (current + 1) % count
        case 'ArrowUp': return current < 0 ? count - 1 : (current - 1 + count) % count
        case 'Home': return 0
        case 'End': return count - 1
        default: return null
      }
    }

    /**
     * The keyboard contract for a `role="menu"` popover.
     *
     * The menu already had `role="menu"` / `role="menuitem"` and Esc-to-close,
     * which is the half a screen reader needs. What it did not have is the half
     * a keyboard user needs: opening left focus on the trigger, so ArrowDown
     * did nothing and the only way to reach an item was Tab — which walked out
     * of the popover into the page behind it. The WAI-ARIA menu pattern is
     * explicit here: a menu takes focus when it opens, arrows move between
     * items, Home/End jump to the ends.
     *
     * Wrapping is deliberate: on a two-item menu a non-wrapping ArrowDown on
     * the last item is a no-op, which reads as "broken" rather than "at the end".
     *
     * Disabled items are skipped rather than merely unfocusable: `disabled` on
     * a `<button>` already drops it from the tab order, but the arrow walk has
     * its own list and would otherwise land on it and stall.
     *
     * @param {{open: boolean, items: number, onClose: () => void}} options -
     *   `open` matters because the popover is positioned by a layout effect and
     *   therefore renders one commit late; focusing on mount alone would find
     *   no items. `items` re-runs the focus when the row set changes (the local
     *   branch flips between enabled and disabled while the picker runs).
     * @returns {object} the ref to put on the `role="menu"` element.
     */
    function useMenuKeyboard (options) {
      const menuRef = React.useRef(null)
      const closeRef = React.useRef(options.onClose)
      closeRef.current = options.onClose

      /** The enabled menu items currently in the popover, in visual order. */
      const enabledItems = () => {
        const menu = menuRef.current
        if (menu === null || typeof menu.querySelectorAll !== 'function') return []
        return [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')]
      }

      React.useEffect(() => {
        // Focus the first item on open, so the menu is usable without Tab.
        // Guarded on `open`: the popover is only rendered once its position is
        // known, so the mount-time effect would otherwise find nothing to focus.
        if (!options.open) return
        enabledItems()[0]?.focus?.()
      }, [options.open, options.items])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          const items = enabledItems()
          if (items.length === 0) return
          const current = items.indexOf(document.activeElement)
          // Only claim a key when the menu actually owns focus, or when focus
          // has not reached an item yet; otherwise the panel's own handlers
          // (and any other popover) keep working.
          if (current < 0 && document.activeElement !== menuRef.current) return
          if (event.key === 'Tab') {
            // Tab is not part of the menu pattern: it leaves the popover, which
            // is exactly how focus used to escape into the page behind it.
            // Close instead of letting focus wander.
            event.preventDefault()
            closeRef.current()
            return
          }
          const next = nextMenuIndex(event.key, current, items.length)
          if (next === null) return
          event.preventDefault()
          items[next].focus()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [])

      return menuRef
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
      // Tags live in the store and drive the panel's own filtering, but had no
      // UI: a user could only get them by editing dsh-ssh.json by hand. Kept as
      // the raw comma string the field shows, so typing "prod, db" does not
      // collapse into "prod,db" between keystrokes while the user is still
      // typing the space.
      const [tags, setTags] = React.useState(editing ? (host.tags ?? []).join(', ') : '')
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
              // Split on commas, trim, drop blanks, de-duplicate — the same
              // normalization the store applies, done here so the saved entity
              // and the reopened editor agree without a round trip.
              tags: [...new Set(tags.split(',').map(tag => tag.trim()).filter(tag => tag !== ''))],
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
      const dialog = useDialogA11y({
        onClose,
        busy: saving,
        label: editing ? t('editor.title.edit') : t('editor.title.create'),
      })

      return jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(dismissBackdrop), children: [
        jsxs('div', { className: 'sshwsp-dialog sshwsp-dialog-narrow', ...dialog.props, ref: dialog.bodyRef, tabIndex: -1, onClick: (event) => event.stopPropagation(), children: [
          jsx('div', { className: 'sshwsp-dialog-title', id: dialog.titleId, children: editing ? t('editor.title.edit') : t('editor.title.create') }),
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
            field(t('editor.tags'), t('editor.tagsHint'), input(tags, setTags)),
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
    function DirectoryBrowser ({ alias, onClose, onMount, ctx, t }) {
      // null until the first listing resolves — then the SSH login directory.
      const [path, setPath] = React.useState(null)
      const [entries, setEntries] = React.useState(null)
      // Set when the server capped the listing. Kept beside the entries rather
      // than derived from them: "500 rows" is not evidence of truncation, and a
      // dialog that guessed would cry wolf on every large-but-complete
      // directory.
      const [truncation, setTruncation] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [mounting, setMounting] = React.useState(false)
      const [mountResult, setMountResult] = React.useState(null)
      // This dialog only NAVIGATES and MOUNTS. Transfers — upload, single
      // download, batch download — live in the Files panel's row menu and the
      // transfer queue. Offering a second set of them here meant two answers
      // to "how do I get this file?", and the dialog's answer could not show
      // the queue's progress once the modal closed. Keeping one surface also
      // means the listing holds no selected state: it has no batch verb left
      // to serve.
      const loadSeq = React.useRef(0)

      const loadDir = React.useCallback(async (p) => {
        const seq = ++loadSeq.current
        // Track the target immediately: the SSH round-trip must never leave the
        // displayed path (or the mount button) pointing at the previous directory.
        if (typeof p === 'string' && p !== '') setPath(p)
        setLoading(true)
        setError(null)
        setEntries(null)
        setTruncation(null)
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
          // The server's own verdict, not a guess from the row count: it knows
          // how many entries the directory actually has, and this dialog must
          // not tell the user "that is everything" when it is not.
          setTruncation(data.truncated === true
            ? { shown: sorted.length, total: typeof data.total === 'number' ? data.total : sorted.length }
            : null)
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

      // This dialog only navigates and mounts, so Escape has nothing to clear
      // first: it closes. Transfers keep running in the queue, which the Files
      // panel continues to report after the modal is gone.
      const dismissBackdrop = () => {
        if (!mounting) onClose()
      }
      const dialog = useDialogA11y({
        onClose: dismissBackdrop,
        busy: mounting,
        label: t('browser.title', { alias }),
      })

      return jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(dismissBackdrop), children: [
        jsxs('div', { className: 'sshwsp-dialog', ...dialog.props, ref: dialog.bodyRef, tabIndex: -1, onClick: (e) => e.stopPropagation(), children: [
          jsx('div', { className: 'sshwsp-dialog-title', id: dialog.titleId, children: t('browser.title', { alias }) }),
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
              jsx('div', {
                className: 'sshwsp-browser-list',
                children:
                loading
                  ? jsx('div', { className: 'sshwsp-empty', children: t('browser.loading') })
                  : error
                    ? jsxs('div', { className: 'sshwsp-empty', children: [t('browser.error'), jsx('br', {}), jsx('span', { style: { fontSize: 11 }, children: error })] })
                    : entries?.length === 0
                      ? jsx('div', { className: 'sshwsp-empty', children: t('browser.empty') })
                      : entries?.map((entry) => {
                        const rowClassName = 'sshwsp-entry'
                          + (entry.type === 'directory' ? ' sshwsp-entry-dir' : '')
                        const rowChildren = [
                          jsx('span', { className: 'sshwsp-entry-icon', children:
                            entry.type === 'directory'
                              ? React.createElement(FolderIcon)
                              : React.createElement(FileIcon),
                          }),
                          jsx('span', { className: 'sshwsp-entry-name', children: entry.name }),
                          entry.type !== 'directory' && jsx('span', { className: 'sshwsp-entry-meta', children: formatSize(entry.size) }),
                        ]
                        // Only a directory is a control in a browse-only
                        // dialog: a file row that acted on click would promise
                        // the download that no longer lives here. The `return`
                        // is load-bearing — with a block body a bare element
                        // expression is evaluated and discarded, so every row
                        // becomes undefined and the listing renders blank while
                        // `entries` is non-empty.
                        if (entry.type === 'directory') {
                          return jsx('button', {
                            key: entry.name,
                            type: 'button',
                            className: rowClassName,
                            onClick: () => handleEntry(entry),
                            children: rowChildren,
                          })
                        }
                        return jsx('div', { key: entry.name, className: rowClassName, children: rowChildren })
                      })
              }),
            ]}),
            // The cap is announced where the list is, not in a footer the eye
            // skips: a user who cannot find a directory in this listing must be
            // able to tell "it is not here" from "it is past the cut-off".
            truncation && jsx('div', {
              className: 'sshwsp-status sshwsp-status-warn',
              style: { marginTop: 8, padding: '8px 12px', borderRadius: 6 },
              role: 'status',
              children: t('browser.truncated', { shown: truncation.shown, total: truncation.total }),
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
    // Diagnostic report dialog
    // =========================================================================
    /**
     * The diagnostic report, rendered as wrapped, selectable text.
     *
     * This dialog exists because the report's own URL cannot be opened as a
     * window in the Desktop app (see `openSupportBundle`), and because the one
     * thing a user needs from it — getting the text onto the clipboard — has to
     * work even where `navigator.clipboard` is unavailable. So the text is
     * shown in a `<textarea readonly>` rather than a `<pre>`: a read-only
     * textarea is selectable, keeps the original whitespace and line breaks
     * without any CSS guesswork, and still lets the user copy by hand when the
     * programmatic path is denied.
     *
     * The text WRAPS (`wrap="soft"`, `white-space: pre-wrap`). It used to keep
     * `wrap="off"` and scroll sideways so a long masked path stayed on one line,
     * but a report read for its content is scanned line by line; sideways
     * scrolling forces the reader to drag horizontally to finish a sentence, and
     * the line is still one logical line either way. Wrapping costs nothing that
     * the report relies on — the monospace font keeps its alignment.
     *
     * The text is NOT selected on open. Selecting all on mount looks helpful
     * until it does not: every keystroke afterwards replaces the selection, the
     * whole report flashes selected while the user is still reading it, and a
     * browser that has already lost focus leaves a selection nobody asked for.
     * Copying is a button in the footer instead, which is also where a keyboard
     * user reaches it without a mouse.
     *
     * No busy state: the dialog only exists once the text has arrived, so there
     * is nothing in flight to abandon.
     */
    function ReportDialog ({ text, onClose, onCopy, t }) {
      const dialog = useDialogA11y({ onClose, label: t('support.title') })
      const areaRef = React.useRef(null)
      /**
       * The footer's copy button.
       *
       * On success there is nothing else to do. On failure — no clipboard
       * permission, a non-secure context — the text is selected so that
       * Ctrl/Cmd+C still works: the user pressed "copy", so the selection is
       * the recovery they asked for. That is the ONLY place this dialog selects
       * anything; on open it must not, or the whole report flashes selected
       * while the user is still reading it.
       */
      const handleCopy = async () => {
        if ((await onCopy()) === true) return
        const area = areaRef.current
        if (area === null || typeof area.select !== 'function') return
        area.focus()
        area.select()
      }
      return jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(onClose), children: [
        jsxs('div', { className: 'sshwsp-dialog', ...dialog.props, ref: dialog.bodyRef, tabIndex: -1, onClick: (e) => e.stopPropagation(), children: [
          jsxs('div', { className: 'sshwsp-dlg-head', children: [
            jsx('h2', { id: dialog.titleId, children: t('support.title') }),
            jsx('button', {
              className: 'sshwsp-icon-btn',
              'aria-label': t('dialog.close'),
              onClick: onClose,
              children: React.createElement(CloseIcon, { size: 14 }),
            }),
          ]}),
          jsxs('div', { className: 'sshwsp-dialog-body', children: [
            jsx('textarea', {
              ref: areaRef,
              className: 'sshwsp-report-text',
              readOnly: true,
              spellCheck: false,
              wrap: 'soft',
              'aria-label': t('support.title'),
              value: text,
            }),
          ]}),
          jsxs('div', { className: 'sshwsp-dialog-footer', children: [
            jsx('button', { className: 'sshwsp-btn', onClick: onClose, children: t('dialog.close') }),
            jsx('button', {
              className: 'sshwsp-btn sshwsp-btn-primary',
              onClick: handleCopy,
              children: t('support.copy'),
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

    /**
     * How long a transient notice stays on screen — every kind, successes and
     * failures alike.
     *
     * ## Why a failure expires too
     *
     * The old rule let successes expire at 3.5 s while failures stayed until
     * clicked, on the sound observation that a failure is the ONLY report a
     * failed transfer produces. The conclusion did not survive the slot it is
     * drawn in: the panel has exactly ONE toast, so a failure left standing
     * silently hides the next message behind itself — including the success of
     * the retry that just fixed it. "Still on screen" read as "still broken".
     *
     * 7 seconds is the compromise: long enough to read two lines and decide
     * whether to act, short enough that the next notice is visible. Everything
     * the old rule protected stays: the failure wording, `role="alert"`, the
     * focusability, Esc/Enter and click. Only its permanence changes.
     *
     * ## Why the pointer holds it
     *
     * "Vanished while I was reading it" is the failure mode an expiry rule is
     * accused of, and it is a real one. So a pointer resting on the notice
     * stops its clock (the same DOM notice serves the panel and the tree code),
     * and leaving restarts the full window rather than resuming the remainder —
     * a reader who just came back needs the same chance to finish.
     */
    const TOAST_DISMISS_MS = 7000

    /**
     * Whether the panel renders its own "Remote environment self-check" section.
     *
     * Turned off on request: one section per probed host, plus a button, for
     * information that is advisory at best — a missing `rg` is a property of that
     * machine, not of this session.
     *
     * It is a gated-off TREE, not a deleted or commented-out one, for a specific
     * reason. Every assertion in `client-shape-smoke` greps this file, so a block
     * turned into comments would keep all of them green while rendering nothing:
     * the suite would describe a section that does not exist. Gating keeps the
     * tree parseable and makes "is it on" a single named value that the suite
     * pins. Flipping it back to `true` restores the section exactly as it was,
     * including the per-card disclosure and the `/status`-first rows.
     *
     * Nothing is lost by hiding it. The same rows remain reachable through the
     * advisory block under the status dot, the diagnostic report
     * (`advisory (not counted in the verdict):`), `GET /self-check`, and the
     * `selfCheck` field of `ssh_workspace_status`. No fact became invisible; the
     * panel just stopped repeating one it had no verdict attached to.
     *
     * @type {boolean}
     */
    const SHOW_SELF_CHECK_SECTION = false

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

    /**
     * Summarise one host's self-check rows.
     *
     * Split out as a pure function so it can be EXECUTED by the suite rather
     * than grepped for: the interesting cases are the ones a screenshot never
     * shows — no rows at all (a card that must say "not probed" instead of
     * rendering nothing), and rows whose `missing` list disagrees with them
     * (which is exactly the state the panel used to get stuck in after a page
     * switch: it kept the count and lost the names).
     *
     * @param {Array<{tool: string, state: string}>} rows - the probed rows.
     * @param {string[]} [missing] - the server's own absent list, used when rows are absent.
     * @returns {{absent: string[], unknown: string[], present: number, total: number, absentCount: number}} the summary.
     */
    function selfCheckSummary (rows, missing) {
      const list = Array.isArray(rows) ? rows : []
      const absent = list.filter(row => row.state === 'absent').map(row => row.tool)
      const unknown = list.filter(row => row.state !== 'present' && row.state !== 'absent').map(row => row.tool)
      // A host whose rows have not arrived yet still knows how many are missing:
      // the count travels in `/status` on its own. Reporting the count without
      // the names is the honest intermediate state, and naming them is what the
      // expanded view is for.
      const absentCount = list.length === 0 && Array.isArray(missing) ? missing.length : absent.length
      return {
        absent,
        unknown,
        present: list.filter(row => row.state === 'present').length,
        total: list.length,
        absentCount,
      }
    }

    /**
     * Render one host's self-check rows.
     *
     * Present rows are collapsed into a count: a report that lists seven
     * installed tools buries the two that are missing, and the missing ones are
     * the entire reason the report exists. Unknown rows stay visible (they are
     * not "fine", they are "not known"), but they carry no install hint — the
     * hint belongs to a fact, not to an absence of one.
     */
    function SelfCheckList ({ rows, t }) {
      if (!Array.isArray(rows) || rows.length === 0) return null
      const present = rows.filter(row => row.state === 'present')
      const rest = rows.filter(row => row.state !== 'present')
      return jsxs('div', { className: 'sshwsp-check-list', children: [
        jsx('div', { className: 'sshwsp-entry-meta', children: `${present.length}/${rows.length} ${t('check.present')}` }),
        rest.map((row) => jsxs('div', {
          key: row.tool,
          className: `sshwsp-check-row sshwsp-check-${row.state}`,
          children: [
            jsx('span', { className: 'sshwsp-check-tool', children: row.tool }),
            jsx('span', {
              className: `sshwsp-status ${row.state === 'absent' ? 'sshwsp-status-warn' : 'sshwsp-status-off'}`,
              children: row.state === 'absent' ? t('check.absent') : t('check.unknown'),
            }),
            jsx('span', { className: 'sshwsp-entry-meta', children: row.detail ?? '' }),
            row.install !== undefined && jsx('span', { className: 'sshwsp-entry-meta', children: `${t('check.install')}${row.install}` }),
          ],
        })),
      ]})
    }

    /**
     * The panel page.
     *
     * `ctx` is threaded explicitly from the apply-time container (see the
     * `main` slot registration) because the directory browser's batch download
     * asks the HOST's own folder chooser for a destination. The browser dialog
     * reads it only when a batch actually runs, but the identifier must exist
     * in this scope either way: a missing binding is a ReferenceError thrown
     * during render, which unmounts the whole slot and leaves a blank page —
     * exactly what "click 浏览目录 and the page goes white" looked like.
     */
    function RemoteWorkspacePanel ({ t, ctx }) {
      const [hosts, setHosts] = React.useState([])
      // What the listing could NOT show, kept apart from "nothing configured".
      //
      // The route has always returned `skipped` and `storeError`, and the tools
      // and the report render them; the panel did not, so an unreadable store
      // and an empty one produced the same sentence ("no SSH hosts configured")
      // — the one message a user cannot act on. Empty state is the absence of
      // both facts, not the absence of rows.
      const [listingGaps, setListingGaps] = React.useState({ skipped: [], storeError: undefined })
      const [status, setStatus] = React.useState({ mounted: [], disabled: [], connections: [], forwards: [], forwardRows: [], forwardSettings: { autoStart: false }, passthrough: { scheme: 'local', remoteMissFallback: false, enabled: false } })
      const [testStates, setTestStates] = React.useState({})
      const [browserAlias, setBrowserAlias] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      // undefined = closed, null = create, a host row = edit that host.
      const [editorHost, setEditorHost] = React.useState(undefined)
      const [deletingAlias, setDeletingAlias] = React.useState(null)
      const [deleteErrors, setDeleteErrors] = React.useState({})
      // Whether this host build rendered the Files panel action bar at all.
      // A slot the host never declares is otherwise silent, so the panel says
      // so instead of letting the upload entry disappear without a reason.
      const transferActionsSlot = useTransferActionsSlot()
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
      // The scheme box is a draft, not a mirror of `status.passthrough.scheme`:
      // the panel refreshes on a timer, and a refresh landing mid-typing would
      // otherwise overwrite the half-typed name with the stored one. `null`
      // means "untouched, show the stored value"; the input clears it on every
      // keystroke and the save handler re-seeds it from the server's answer.
      const [passthroughScheme, setPassthroughScheme] = React.useState(null)
      const [passthroughBusy, setPassthroughBusy] = React.useState(false)
      // What the box shows: the draft while there is one, the stored name
      // otherwise. Deriving it here rather than seeding state from `status`
      // keeps a timer refresh from resurrecting a name the user just erased.
      const passthroughSchemeValue = passthroughScheme ?? status.passthrough?.scheme ?? 'local'
      // Self-check: which alias is being probed, and the last report per alias.
      // Kept per alias rather than as one "last report" so switching hosts in
      // the panel does not silently show another host's verdicts.
      const [checkBusy, setCheckBusy] = React.useState(null)
      const [checkReports, setCheckReports] = React.useState({})
      /**
       * Which host's self-check card is expanded.
       *
       * Keyed by alias and kept here rather than inside the card, because
       * `CappedList` re-creates the rows on every poll (the panel refreshes on a
       * timer) — state living inside a row would collapse itself every few
       * seconds, which is a worse bug than the one this replaces.
       *
       * @type {[Record<string, boolean>, Function]}
       */
      const [expandedChecks, setExpandedChecks] = React.useState({})
      const [supportBusy, setSupportBusy] = React.useState(false)
      // null = the report dialog is closed; a string = its text is on screen.
      const [reportText, setReportText] = React.useState(null)

      // ONE notice implementation for the panel and the tree/transfer code.
      // A string keeps the old call shape; an object can add a diagnostic
      // code, raw detail and a retry action. Nothing here holds React state:
      // the DOM node owns its own timer and is rewritten in place.
      const reportToast = (input, kind) => notifyUser(input, kind)

      const refresh = React.useCallback(async () => {
        setLoading(true)
        try {
          const [hostsData, statusData] = await Promise.all([
            fetchJson(API.hosts),
            fetchJson(API.status),
          ])
          setHosts(hostsData.hosts ?? [])
          setListingGaps({ skipped: hostsData.skipped ?? [], storeError: hostsData.storeError })
          setStatus(statusData)
          syncRemoteWorkspaceMarks(statusData.workspaces, statusData.disabled)
        } catch { /* silent */ }
        finally { setLoading(false) }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      /**
       * Run the self-check for one host.
       *
       * Reports into `checkReports` rather than into `status`, because a
       * self-check is a deliberate, expensive action (it opens a connection and
       * runs a command) while `status` is refreshed on a timer. Mixing them
       * would mean a refresh either overwrites the report or re-probes a host
       * on every tick.
       *
       * The report is then MERGED into the rendered list, so a host that has
       * a fresh report shows it and a host that has only the cached probe still
       * shows what the server knows.
       */
      const selfCheckAction = async (alias) => {
        if (typeof alias !== 'string' || alias === '') return null
        setCheckBusy(alias)
        try {
          const report = await fetchJson(`${API.selfCheck}?alias=${encodeURIComponent(alias)}`)
          setCheckReports((prev) => ({ ...prev, [alias]: report }))
          await refresh()
          return { kind: 'ok', text: t('check.done') }
        } catch (err) {
          return toastError(t('check.fail'), err, 'SSHWSP-E-SELF-CHECK', () => selfCheckAction(alias))
        } finally {
          setCheckBusy(null)
        }
      }

      /**
       * Run the self-check and report the outcome.
       *
       * A success is already visible in the report card, so the direct path
       * does not raise a toast. A failure does, and it can replay the probe
       * from the same node; the replay's success is shown because the user
       * pressed a button and needs to see that it worked.
       */
      const runSelfCheck = async (alias) => {
        const result = await selfCheckAction(alias)
        if (result !== null && result.kind === 'err') reportToast(result)
      }

      /**
       * Copy the report that is already on screen.
       *
       * The dialog's own button, and the panel's only copy path. It copies the
       * string the dialog is showing rather than re-fetching: the user is
       * looking at one particular report, and a second request could return a
       * different one (another host connected, a command finished) — the text
       * on screen and the text on the clipboard have to be the same text.
       *
       * Resolves to whether the clipboard write actually happened, so the
       * dialog can fall back to selecting the text for a manual copy.
       * `navigator.clipboard` needs a secure context, which a loopback GUI
       * normally has; a rejection (permission denied, non-secure context) is
       * reported as `false` rather than thrown, because the caller decides what
       * to show.
       */
      const copyOpenReport = async () => {
        if (reportText === null) return false
        if (navigator.clipboard?.writeText === undefined) {
          reportToast(toastError(t('support.noClipboard'), 'navigator.clipboard.writeText is unavailable', 'SSHWSP-E-CLIPBOARD'))
          return false
        }
        try {
          await navigator.clipboard.writeText(reportText)
          reportToast({ kind: 'ok', text: t('support.copied') })
          return true
        } catch (err) {
          reportToast(toastError(t('support.noClipboard'), err, 'SSHWSP-E-CLIPBOARD'))
          return false
        }
      }

      /**
       * Show the diagnostic report inside the panel.
       *
       * The report is served as `text/plain` at its own URL, and the obvious
       * implementation — an `<a target="_blank">` on that URL — is the one that
       * does not work in the Desktop app. There the document origin is
       * `dsh-app://app/`, so a relative `href` resolves against that scheme
       * instead of the Host's HTTP address; the window's open handler only
       * admits `http:`/`https:` and denies everything else, so the click does
       * nothing at all. Even when the scheme were admitted, the system browser
       * it would be handed to carries no Host session and answers 401.
       *
       * Fetching the same bytes and rendering them in a dialog sidesteps both:
       * one request, through the panel's own credentials, and the text lands
       * where the user can select it.
       */
      const supportBundleAction = async () => {
        setSupportBusy(true)
        setReportText(null)
        try {
          const text = await fetchReportText()
          setReportText(text)
          return { kind: 'ok', text: t('support.opened') }
        } catch (err) {
          return toastError(t('support.fail'), err, 'SSHWSP-E-SUPPORT-BUNDLE', () => supportBundleAction())
        } finally {
          setSupportBusy(false)
        }
      }

      /**
       * Open the report; a failure can be replayed from the toast.
       */
      const openSupportBundle = async () => {
        const result = await supportBundleAction()
        if (result.kind === 'err') reportToast(result)
      }

      /**
       * Probe one host: connect, prove it works, then let the connection go.
       *
       * "Test" answers "does this host answer at all" — it is not a way to open
       * a session. The server releases the connection it just proved (unless an
       * open port forward pins it), so the panel's connection indicator does not
       * light up from a mere probe. The refresh below therefore reports what is
       * actually left rather than assuming the test left a connection behind.
       */
      const testAction = async (alias) => {
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
          // The probe released its connection, so the indicator must be
          // re-read rather than optimistically marked connected. A failed
          // status read must not turn a successful probe into a failure.
          try {
            const s = await fetchJson(API.status)
            setStatus(s)
          } catch { /* best-effort refresh */ }
          if (!result.ok) {
            return toastError(t('hosts.testFail'), result.error, 'SSHWSP-E-HOST-TEST', () => testAction(alias))
          }
          return { kind: 'ok', text: t('hosts.testOk', { ms: result.durationMs }) }
        } catch (err) {
          setTestStates((prev) => ({
            ...prev,
            [alias]: { status: 'failed', error: err.message },
          }))
          return toastError(t('hosts.testFail'), err, 'SSHWSP-E-HOST-TEST', () => testAction(alias))
        }
      }

      const handleTest = async (alias) => {
        reportToast(await testAction(alias))
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
            // No retry: forgetting a key changes the trust anchor, and a
            // replay after a partial failure would be a policy change, not a
            // repeat of a safe read.
            reportToast(toastError(t('hosts.forgetKeyFail'), result.error, 'SSHWSP-E-HOST-KEY-FORGET'))
          } else {
            reportToast({ kind: 'ok', text: t('hosts.forgetKeyOk') })
            // The pooled connection was dropped server-side; refresh so the
            // connection rows stop claiming it is still up.
            const s = await fetchJson(API.status)
            setStatus(s)
          }
        } catch (err) {
          reportToast(toastError(t('hosts.forgetKeyFail'), err, 'SSHWSP-E-HOST-KEY-FORGET'))
        }
      }

      const disconnectAction = async (alias) => {
        try {
          const result = await fetchJson(API.hostDisconnect, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            return toastError(t('hosts.disconnectFail'), result.error, 'SSHWSP-E-HOST-DISCONNECT', () => disconnectAction(alias))
          }
          // Report the tunnels too: they went away because the user asked for
          // it, and saying so is what keeps this from looking like the failure
          // the panel would otherwise show for a dropped connection.
          const closedForwards = Number(result.closedForwards ?? 0)
          // The connection is gone server-side; refresh so the indicator follows.
          try {
            const s = await fetchJson(API.status)
            setStatus(s)
          } catch { /* best-effort refresh */ }
          return {
            kind: 'ok',
            text: closedForwards > 0
              ? t('hosts.disconnectOkForwards').replace('{n}', String(closedForwards))
              : t('hosts.disconnectOk'),
          }
        } catch (err) {
          return toastError(t('hosts.disconnectFail'), err, 'SSHWSP-E-HOST-DISCONNECT', () => disconnectAction(alias))
        }
      }

      const handleDisconnect = async (alias) => {
        reportToast(await disconnectAction(alias))
      }

      /**
       * Skip the backoff and try now.
       *
       * Reports the real error rather than a hopeful "retrying": the background
       * loop already prints its own progress on the card, so a manual attempt
       * that failed must not look like it worked.
       */
      const reconnectAction = async (alias) => {
        try {
          const result = await fetchJson(API.hostReconnect, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            return toastError(t('connections.retryFail'), result.error, 'SSHWSP-E-HOST-RECONNECT', () => reconnectAction(alias))
          }
          try {
            const s = await fetchJson(API.status)
            setStatus(s)
          } catch { /* best-effort refresh */ }
          return { kind: 'ok', text: t('connections.retryOk') }
        } catch (err) {
          return toastError(t('connections.retryFail'), err, 'SSHWSP-E-HOST-RECONNECT', () => reconnectAction(alias))
        }
      }

      const handleReconnect = async (alias) => {
        reportToast(await reconnectAction(alias))
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
            // No retry: unmount can partially succeed (the workspace may be
            // detached while session archiving failed), so replaying it is not
            // a safe repeat of one action.
            reportToast(toastError(t('mounted.detachFail'), result.error, 'SSHWSP-E-UNMOUNT'))
          } else if ((result.archiveFailed ?? []).length > 0) {
            reportToast(toastError(t('mounted.detachPartial'), result.archiveFailed, 'SSHWSP-E-UNMOUNT-ARCHIVE'))
          } else if (effectiveMode === 'detach') {
            // No sessions were archived on purpose: the group stays populated.
            reportToast({ kind: 'ok', text: t('mounted.detachOkKeep') })
          } else {
            reportToast({ kind: 'ok', text: t('mounted.detachOk').replace('{n}', String((result.archived ?? []).length)) })
          }
          setUnmountConfirm(null)
          await refresh()
        } catch (err) {
          reportToast(toastError(t('mounted.detachFail'), err, 'SSHWSP-E-UNMOUNT'))
        } finally {
          setUnmountBusy(null)
        }
      }

      /** Mount a detached workspace again and unarchive its sessions. */
      const enableAction = async (workspacePath) => {
        setEnableBusy(workspacePath)
        try {
          const result = await fetchJson(API.enable, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspacePath, unarchiveSessions: true }),
          })
          if (!result.ok) {
            return toastError(t('detached.enableFail'), result.error, 'SSHWSP-E-ENABLE', () => enableAction(workspacePath))
          }
          return { kind: 'ok', text: t('detached.enableOk').replace('{path}', workspacePath) }
        } catch (err) {
          return toastError(t('detached.enableFail'), err, 'SSHWSP-E-ENABLE', () => enableAction(workspacePath))
        } finally {
          setEnableBusy(null)
          await refresh()
        }
      }

      /** Mount a detached workspace again and unarchive its sessions. */
      const handleEnable = async (workspacePath) => {
        reportToast(await enableAction(workspacePath))
      }

      const handleForward = async () => {
        const remotePort = Number.parseInt(forwardRemotePort.trim(), 10)
        const localPortText = forwardLocalPort.trim()
        const localPort = localPortText === '' ? remotePort : Number.parseInt(localPortText, 10)
        const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535
        if (!validPort(remotePort) || !validPort(localPort)) {
          reportToast(toastError(t('editor.badPort'), `remotePort=${forwardRemotePort.trim()} localPort=${localPortText}`, 'SSHWSP-E-BAD-PORT'))
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
            reportToast(toastError(t('forwards.fail'), result.error, 'SSHWSP-E-FORWARD-SAVE'))
          } else {
            setForwardRemotePort('')
            setForwardLocalPort('')
            if (result.error !== undefined) reportToast(toastError(t('forwards.fail'), result.error, 'SSHWSP-E-FORWARD-SAVE'))
          }
          await refresh()
        } catch (err) {
          reportToast(toastError(t('forwards.fail'), err, 'SSHWSP-E-FORWARD-SAVE'))
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
            reportToast(toastError(t('forwards.fail'), result.error, 'SSHWSP-E-FORWARD-TOGGLE'))
          }
          await refresh()
        } catch (err) {
          reportToast(toastError(t('forwards.fail'), err, 'SSHWSP-E-FORWARD-TOGGLE'))
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
          if (!result.ok) reportToast(toastError(t('forwards.fail'), result.error, 'SSHWSP-E-FORWARD-REMEMBER'))
          await refresh()
        } catch (err) {
          reportToast(toastError(t('forwards.fail'), err, 'SSHWSP-E-FORWARD-REMEMBER'))
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
            reportToast(toastError(t('forwards.autoStartFail'), result.error, 'SSHWSP-E-AUTOSTART'))
          }
        } catch (err) {
          setStatus((prev) => ({ ...prev, forwardSettings: { ...(prev.forwardSettings ?? {}), autoStart: !next } }))
          reportToast(toastError(t('forwards.autoStartFail'), err, 'SSHWSP-E-AUTOSTART'))
        }
      }

      /**
       * Persist one local-passthrough setting.
       *
       * Not optimistic, unlike the auto-start box: the server validates the
       * scheme name and is the only writer of the live matcher, so echoing the
       * requested value first would briefly show a scheme the filesystem seams
       * are not using. The answer carries the stored settings, which is what
       * the panel then renders.
       */
      const savePassthrough = async (patch, failureKey, code) => {
        setPassthroughBusy(true)
        try {
          const result = await fetchJson(API.passthroughSettings, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (!result.ok) {
            reportToast(toastError(t(failureKey), result.error, code))
            return
          }
          if (result.settings !== undefined) {
            // A save is what confirms the degraded value, so the stale warning
            // goes with it. The next status poll would clear it too, but until
            // then the panel would keep telling the user to do the thing they
            // just did.
            setStatus((prev) => ({
              ...prev,
              passthrough: {
                ...(prev.passthrough ?? {}),
                ...result.settings,
                ...(patch.scheme === undefined ? {} : { schemeWarning: null }),
              },
            }))
            if (typeof result.settings.scheme === 'string') setPassthroughScheme(result.settings.scheme)
          }
          if (patch.scheme !== undefined) reportToast({ kind: 'ok', text: t('passthrough.schemeSaved').replace('{scheme}', result.settings?.scheme ?? patch.scheme) })
        } catch (err) {
          reportToast(toastError(t(failureKey), err, code))
        } finally {
          setPassthroughBusy(false)
        }
      }

      /**
       * Save the scheme box.
       *
       * The name is lowercased before it is validated, exactly as the host
       * does, so typing "Local" is accepted rather than bounced with a rule
       * the user cannot see being applied.
       *
       * The rules themselves come from the server (`status.passthrough
       * .schemeRules`), which publishes them from the same tables
       * `schemeRefusal` enforces. This bundle deliberately carries NO copy of
       * the syntax, the minimum length or the reserved list: a copy can
       * disagree with what the server accepts, and then the panel either
       * refuses a name the host would take or promises one it would refuse. The
       * check is still done here so "that is not a name" is answered without a
       * round trip; when the status reply predates the rules (an older server)
       * only the empty case is caught locally and the server's own refusal
       * text is the answer for everything else.
       */
      const savePassthroughScheme = async () => {
        const requested = String(passthroughSchemeValue).trim().toLowerCase()
        const rules = status.passthrough?.schemeRules
        if (requested === '') {
          reportToast(toastError(t('passthrough.schemeInvalid'), requested, 'SSHWSP-E-PASSTHROUGH-SCHEME'))
          return
        }
        // Same order as `schemeRefusal`: syntax, then length, then the reserved
        // list — so the toast names the rule the server would have named.
        if (typeof rules?.pattern === 'string' && rules.pattern !== '') {
          let syntaxOk = true
          try { syntaxOk = new RegExp(rules.pattern, 'u').test(requested) } catch { syntaxOk = true }
          if (!syntaxOk) {
            reportToast(toastError(t('passthrough.schemeInvalid'), requested, 'SSHWSP-E-PASSTHROUGH-SCHEME'))
            return
          }
        }
        if (rules !== undefined && requested.length < (rules.minLength ?? 3)) {
          reportToast(toastError(t('passthrough.schemeTooShort'), requested, 'SSHWSP-E-PASSTHROUGH-SCHEME'))
          return
        }
        const taken = (rules?.reserved ?? []).find(entry => entry?.name === requested)
        if (taken !== undefined) {
          reportToast(toastError(
            t('passthrough.schemeReserved')
              .replace('{scheme}', requested)
              .replace('{reason}', String(taken.reason ?? '')),
            requested,
            'SSHWSP-E-PASSTHROUGH-SCHEME',
          ))
          return
        }
        await savePassthrough({ scheme: requested }, 'passthrough.schemeFail', 'SSHWSP-E-PASSTHROUGH-SCHEME')
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

      /**
       * Save the remote-miss fallback box.
       *
       * Same non-optimistic path as the scheme: the flag is read by the live
       * matcher on every remote read, so the panel shows what the host applied
       * rather than what was clicked.
       */
      const savePassthroughFallback = async (next) => {
        await savePassthrough({ remoteMissFallback: next }, 'passthrough.fallbackFail', 'SSHWSP-E-PASSTHROUGH-FALLBACK')
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

      // The server's verdict for the report section: `state` plus one row per
      // finding. Derived from the same fields `/support-bundle` prints, so the
      // dot and the paste cannot disagree — which is why it is computed on the
      // server and shipped here rather than re-derived in the browser.
      const diagnosis = status.diagnosis ?? { version: 0, state: 'unknown', warn: 0, unknown: 0, findings: [] }

      // The self-check list the panel renders: the server's cached probe for
      // each host, overlaid with any report this panel fetched on demand. The
      // overlay is per alias, so a fresh report for one host never replaces
      // another host's cached verdicts.
      // The rows come from `/status` FIRST, and that ordering is the whole bug
      // fix: `checkReports` is React state, so it dies with the panel. Switching
      // to another page and back left this list holding only `missing` (which
      // travels in `/status`) and no `rows` at all — the card kept saying
      // "2 missing" and could not name a single one. `/status` re-derives the
      // same rows from the server's probe cache on every poll, so it is both
      // the durable source and an equally fresh one; a report fetched here by
      // pressing Self-check wins when it exists, because it may be newer than
      // the last poll.
      // Empty while the section is gated off, so a hidden section does no merge
      // work on a list that arrives on every poll — and still an array, so
      // nothing that reads it has to know about the flag.
      const selfCheckRows = !SHOW_SELF_CHECK_SECTION ? []
        : ((status.selfCheck ?? []).length > 0
        ? (status.selfCheck ?? []).map((check) => ({
            alias: check.alias,
            missing: check.missing ?? [],
            rows: checkReports[check.alias]?.rows ?? check.rows ?? [],
          }))
        : Object.entries(checkReports).map(([alias, report]) => ({
            alias,
            missing: report.missing ?? [],
            rows: report.rows ?? [],
          })))

      return jsxs('div', { className: 'sshwsp', children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }, children: [
          jsx('h2', { style: { margin: 0 }, children: t('panel.title') }),
          jsx('button', { className: 'sshwsp-btn', onClick: refresh, disabled: loading, children: t('refresh') }),
        ]}),
        // The one place the panel admits an age. It says nothing about the
        // connection list (read live) and everything about the probe rows
        // (a cache that can be older than the user's last change to the host),
        // because that section is the one a user reads as "current".
        provenanceText(t, status.provenance?.capabilities) !== undefined && jsx('div', {
          className: 'sshwsp-provenance',
          children: `${t('provenance.selfCheck')} · ${provenanceText(t, status.provenance?.capabilities)}`,
        }),

        // ---- Hosts
        jsxs('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('hosts.title') }),
          jsx('button', { className: 'sshwsp-btn', onClick: () => setEditorHost(null), children: t('hosts.add') }),
        ]}),
        hosts.length === 0
          ? jsxs('div', { className: 'sshwsp-empty', children: [
              // "Nothing configured" and "I could not read the configuration"
              // are different facts and must not share a sentence: only the
              // second one is actionable, and it was previously invisible.
              jsx('div', { children: loading
                ? t('panel.loading')
                : listingGaps.storeError !== undefined ? t('panel.storeError') : t('panel.empty') }),
              listingGaps.storeError !== undefined &&
                jsx('div', { className: 'sshwsp-empty-detail', children: String(listingGaps.storeError) }),
              listingGaps.skipped.length > 0 &&
                jsx('div', { className: 'sshwsp-empty-detail', children: t('panel.skipped').replace('{n}', String(listingGaps.skipped.length)) }),
            ]})
          : jsxs('div', { children: [
              jsx(CappedList, {
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
              // Gaps stay visible even when some rows DID load: a host that
              // exists but cannot be used is the one the user is looking for.
              listingGaps.storeError !== undefined &&
                jsx('div', { className: 'sshwsp-empty-detail', children: `${t('panel.storeError')}: ${listingGaps.storeError}` }),
              listingGaps.skipped.length > 0 &&
                jsx('div', { className: 'sshwsp-empty-detail', children: t('panel.skipped').replace('{n}', String(listingGaps.skipped.length)) }),
            ]}),

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

        // ---- File references (host paths inside an ssh:// session)
        // TWO titles, and they are not interchangeable. The `h3` names the zone
        // ("File reference settings") exactly like the other panel sections; the
        // `h4` names what the controls in it do ("Explicit file reference
        // scheme"). Collapsing them into one line lost the distinction between
        // "where these controls live" and "what this particular control is",
        // and the scheme box's own accessible name is a third string again —
        // renaming a title must never rename the field.
        //
        // Both controls write straight through to the live matcher, so there is
        // no Apply button: the scheme box saves on Enter or on Save, and the
        // checkbox saves on click. The zone renders even when passthrough is
        // off (empty localPassthrough) because the settings still persist for
        // when it is switched on — the notice says they have no effect now.
        jsx('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('passthrough.group') }),
        ]}),
        jsx('h4', { children: t('passthrough.title') }),
        !loading && status.passthrough?.enabled === false &&
          jsx('div', { className: 'sshwsp-passthrough-off', children: t('passthrough.disabled') }),
        // A value saved by an older build may no longer be legal (`file`, or a
        // one-character name). It is degraded rather than rewritten — the
        // store is the user's file — so the panel has to say which value is
        // stored, which one is actually in force, and that only a save confirms
        // the change. Without this line the prefix just "stops working" with no
        // visible cause.
        !loading && status.passthrough?.schemeWarning != null &&
          jsx('div', {
            className: 'sshwsp-passthrough-off sshwsp-passthrough-stale',
            children: (() => {
              const warning = status.passthrough.schemeWarning
              return t('passthrough.schemeWarning')
                .replace('{stored}', String(warning.stored))
                .replace('{effective}', String(warning.effective))
                .replace('{message}', String(warning.message))
            })(),
          }),
        jsxs('div', { className: 'sshwsp-passthrough-row', children: [
          jsx('input', {
            className: 'sshwsp-input',
            type: 'text',
            // Not `spellCheck: false` alone: the box holds a scheme name, and
            // both autocorrect and the OS credential/password manager offer to
            // "help" with a one-word field, which is never what is wanted here.
            autoComplete: 'off',
            spellCheck: false,
            value: passthroughSchemeValue,
            placeholder: t('passthrough.schemePlaceholder'),
            // A scheme name has no reason to be long. The limit is a comfort
            // bound, not a rule: the server publishes the real minimum and the
            // real syntax through `schemeRules`, and nothing here rejects on
            // width.
            maxLength: 32,
            'aria-label': t('passthrough.scheme'),
            title: t('passthrough.schemeHint'),
            disabled: passthroughBusy,
            onChange: (event) => setPassthroughScheme(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') savePassthroughScheme() },
          }),
          jsx('button', {
            className: 'sshwsp-btn',
            disabled: passthroughBusy,
            title: t('passthrough.schemeHint'),
            onClick: () => savePassthroughScheme(),
            children: t('passthrough.schemeSave'),
          }),
        ]}),
        jsx('label', {
          className: 'sshwsp-check sshwsp-passthrough-fallback',
          // The rule is long enough that leaving it inline would push the whole
          // panel down; the tooltip carries it and the state stays one line.
          title: t('passthrough.fallbackHint'),
          children: [
            jsx('input', {
              type: 'checkbox',
              checked: status.passthrough?.remoteMissFallback === true,
              disabled: passthroughBusy,
              onChange: (event) => savePassthroughFallback(event.target.checked),
            }),
            jsxs('span', { className: 'sshwsp-check-text', children: [
              jsx('span', { className: 'sshwsp-field-label', children: t('passthrough.fallback') }),
            ]}),
          ],
        }),

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

        // ---- Remote environment self-check
        // Rendered even when empty: the section is how a user DISCOVERS that a
        // missing remote tool is the reason a feature is degraded, and an
        // always-empty section teaches that it exists.
        //
        // Gated off for now — see SHOW_SELF_CHECK_SECTION. Both elements of the
        // section carry the guard, because they are one section: a heading with
        // no list under it would be worse than either half alone.
        SHOW_SELF_CHECK_SECTION && jsxs('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('check.title') }),
          jsx('button', {
            className: 'sshwsp-btn',
            disabled: checkBusy !== null || hosts.length === 0,
            onClick: () => runSelfCheck(hosts[0]?.alias),
            children: checkBusy !== null ? t('check.running') : t('check.run'),
          }),
        ]}),
        SHOW_SELF_CHECK_SECTION && (selfCheckRows.length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('check.none') })
          : jsx(CappedList, {
              className: 'sshwsp-check',
              children: selfCheckRows.map((check) => {
                const summary = selfCheckSummary(check.rows, check.missing)
                const open = expandedChecks[check.alias] === true
                // Expandable even with nothing missing: "which tools were
                // checked" is the question a green row raises, and a card that
                // cannot answer it is a card the user learns to ignore.
                const canExpand = summary.total > 0 || summary.absentCount > 0
                return jsxs('div', {
                  key: check.alias,
                  className: 'sshwsp-mount sshwsp-mount-col',
                  children: [
                    // A real button, not a div with onClick: the disclosure has
                    // to be reachable by keyboard and has to announce whether it
                    // is open, and both come free with the element.
                    jsxs('button', {
                      type: 'button',
                      className: 'sshwsp-check-head',
                      'aria-expanded': canExpand ? open : undefined,
                      disabled: !canExpand,
                      onClick: () => setExpandedChecks((prev) => ({ ...prev, [check.alias]: !open })),
                      children: [
                        jsx('span', { className: 'sshwsp-check-caret', 'aria-hidden': 'true', children: canExpand ? (open ? '▾' : '▸') : '·' }),
                        jsx('span', { className: 'sshwsp-mount-path', children: check.alias }),
                        summary.absentCount > 0 && jsx('span', {
                          className: 'sshwsp-status sshwsp-status-warn',
                          children: `${summary.absentCount} ${t('check.absent')}`,
                        }),
                        summary.unknown.length > 0 && jsx('span', {
                          className: 'sshwsp-status sshwsp-status-off',
                          children: `${summary.unknown.length} ${t('check.unknown')}`,
                        }),
                        // The names, inline, when the list cannot be expanded —
                        // a count with no way to see what it counts is the
                        // puzzle this whole section exists to avoid.
                        !canExpand && (check.missing ?? []).length > 0 && jsx('span', {
                          className: 'sshwsp-check-inline',
                          children: (check.missing ?? []).join(', '),
                        }),
                        jsx('span', { className: 'sshwsp-check-spacer' }),
                        summary.total > 0 && jsx('span', {
                          className: 'sshwsp-entry-meta',
                          children: `${summary.present}/${summary.total} ${t('check.present')}`,
                        }),
                      ],
                    }),
                    open && jsx(SelfCheckList, { rows: check.rows, t }),
                  ],
                })
              }),
            })),

        // ---- Recent remote commands
        // Only failures, refusals and unknown outcomes are listed: a successful
        // command is not news, and a list of every `ls` would bury the one line
        // that matters. The full record is in the diagnostic report.
        (status.commands ?? []).filter(command => command.refused === true || command.outcomeUnknown === true || command.timedOut || (command.exitCode ?? 0) !== 0).length > 0 && jsxs('div', { children: [
          jsx('h3', { children: t('audit.title') }),
          jsx(CappedList, {
            className: 'sshwsp-audit',
            children: (status.commands ?? [])
              .filter(command => command.refused === true || command.outcomeUnknown === true || command.timedOut || (command.exitCode ?? 0) !== 0)
              .slice(-10)
              .map((command) => jsxs('div', {
                key: command.seq,
                className: 'sshwsp-audit-row',
                children: [
                  jsx('span', { className: 'sshwsp-entry-meta', children: command.alias }),
                  jsx('span', {
                    className: `sshwsp-status ${command.refused === true ? 'sshwsp-status-warn' : 'sshwsp-status-err'}`,
                    children: command.refused === true
                      ? t('audit.refused')
                      : command.outcomeUnknown === true
                        ? t('audit.unknown')
                        : command.timedOut
                          ? t('audit.timedOut')
                          : `exit ${command.exitCode}`,
                  }),
                  jsx('span', { className: 'sshwsp-audit-command', children: command.command }),
                ],
              })),
          }),
        ]}),

        // ---- Diagnostic report
        // The one artifact meant to be pasted in public. The hint states what
        // it contains (and that it is already masked), because "copy my
        // diagnostics" is a request a careful user should be able to refuse
        // with full information.
        //
        // The dot beside the title is the verdict: green when the server
        // judged everything fine, red when something needs attention, amber
        // when something could not be judged. It is derived server-side from
        // the same fields the report prints, so the dot and the paste cannot
        // disagree — and it is the ONE thing this section could not say
        // before: the report is a fact sheet with no verdict anywhere in it.
        //
        // "Copy" lives inside the report window, not here: copying only makes
        // sense once there is a report to copy, and a button that silently
        // produces a dialog instead of a clipboard entry (the no-clipboard
        // fallback) is a button whose label promised the wrong thing.
        jsxs('div', { className: 'sshwsp-section-head', children: [
          jsxs('h3', { className: 'sshwsp-report-title', children: [
            jsx('span', { children: t('support.title') }),
            diagnosis !== undefined && jsx('span', {
              className: `sshwsp-dot sshwsp-dot-${diagnosis.state === 'ok' ? 'ok' : diagnosis.state === 'warn' ? 'err' : 'warn'}`,
              role: 'img',
              title: diagnosis.state === 'ok'
                ? t('diagnosis.ok')
                : diagnosis.state === 'warn'
                  ? t('diagnosis.warn', { n: diagnosis.warn })
                  : t('diagnosis.unknown', { n: diagnosis.unknown }),
              'aria-label': diagnosis.state === 'ok'
                ? t('diagnosis.ok')
                : diagnosis.state === 'warn'
                  ? t('diagnosis.warn', { n: diagnosis.warn })
                  : t('diagnosis.unknown', { n: diagnosis.unknown }),
            }),
          ]}),
          // A button, not an `<a href>`: the panel may run under the Desktop
          // app's `dsh-app://` origin, where a relative href resolves against
          // that scheme and the window-open policy denies it. `openSupportBundle`
          // fetches the same bytes through the panel's own credentials and
          // renders them in a dialog, which works in both shells.
          jsx('button', {
            className: 'sshwsp-btn',
            disabled: supportBusy,
            title: t('support.hint'),
            onClick: openSupportBundle,
            children: supportBusy ? t('check.running') : t('support.open'),
          }),
        ]}),
        jsx('div', { className: 'sshwsp-entry-meta', children: t('support.hint') }),
        transferActionsSlot === 'missing' && jsx('div', {
          className: 'sshwsp-status sshwsp-status-warn',
          style: { marginTop: 8, padding: '8px 12px', borderRadius: 6, display: 'inline-block' },
          role: 'status',
          children: t('queue.slotMissing'),
        }),
        // The findings, in the panel, so a red dot is actionable without
        // opening anything: a dot that says "something is wrong" and names
        // nothing is a puzzle, not a report.
        (diagnosis.findings ?? []).length > 0 && jsxs('div', { className: 'sshwsp-diagnosis', children: [
          ...(diagnosis.findings ?? []).slice(0, 8).map(finding => jsxs('div', {
            key: `${finding.id}:${finding.alias ?? ''}:${finding.detail}`,
            className: 'sshwsp-diagnosis-row',
            children: [
              jsx('span', {
                className: `sshwsp-status ${finding.state === 'warn' ? 'sshwsp-status-err' : 'sshwsp-status-warn'}`,
                children: finding.state === 'warn' ? t('diagnosis.warnLabel') : t('diagnosis.unknownLabel'),
              }),
              finding.alias !== undefined && jsx('span', { className: 'sshwsp-entry-meta', children: finding.alias }),
              jsx('span', { className: 'sshwsp-diagnosis-detail', children: finding.detail }),
            ],
          })),
          (diagnosis.findings ?? []).length > 8 && jsx('div', { className: 'sshwsp-entry-meta', children: t('audit.more', { n: diagnosis.findings.length }) }),
        ]}),

        // Advisory rows: the self-check's own observations, rendered BESIDE the
        // findings and visually quieter. A missing optional tool degrades one
        // feature and is often not even changeable on that host, so it must not
        // read as the reason the dot is a colour — which is exactly what listing
        // it as a finding used to do.
        (diagnosis.notes ?? []).length > 0 && jsxs('details', { className: 'sshwsp-diagnosis-notes', children: [
          jsx('summary', { children: t('diagnosis.notes', { n: (diagnosis.notes ?? []).length }) }),
          ...(diagnosis.notes ?? []).slice(0, 12).map(note => jsxs('div', {
            key: `${note.id}:${note.alias ?? ''}:${note.detail}`,
            className: 'sshwsp-diagnosis-row',
            children: [
              note.alias !== undefined && jsx('span', { className: 'sshwsp-entry-meta', children: note.alias }),
              jsx('span', { className: 'sshwsp-diagnosis-detail', children: note.detail }),
            ],
          })),
          (diagnosis.notes ?? []).length > 12 && jsx('div', { className: 'sshwsp-entry-meta', children: t('audit.more', { n: diagnosis.notes.length }) }),
        ]}),

        // ---- Diagnostic report dialog
        reportText !== null && jsx(ReportDialog, {
          text: reportText,
          onClose: () => setReportText(null),
          onCopy: copyOpenReport,
          t,
        }),

        // ---- Browser dialog
        browserAlias !== null && jsx(DirectoryBrowser, {
          alias: browserAlias,
          onClose: () => setBrowserAlias(null),
          onMount: () => { refresh(); setBrowserAlias(null) },
          ctx,
          t,
        }),

        // ---- Host editor dialog
        editorHost !== undefined && jsx(HostEditor, {
          host: editorHost,
          t,
          onClose: () => setEditorHost(undefined),
          onSaved: () => { setEditorHost(undefined); refresh() },
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

    const FLOW_MENU_WIDTH = 220
    /** The add-workspace chooser keeps descriptions, so it keeps more room. */
    const FLOW_MENU_WIDTH_ROOMY = 250

    /** Fixed position for the chooser popover, next to the flow trigger. */
    function flowMenuPosition (anchorEl, sheetWidth = FLOW_MENU_WIDTH) {
      const width = Number.isFinite(sheetWidth) ? sheetWidth : FLOW_MENU_WIDTH
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
        left: Math.min(Math.max(8, base.left), Math.max(8, viewportW - width - 8)),
        top: Math.min(Math.max(8, base.top), Math.max(8, viewportH - 180)),
      }
    }

    function AddChooser ({ busy, picking, onLocal, onRemote, onCancel, t }) {
      const anchorRef = React.useRef(null)
      const [pos, setPos] = React.useState(null)
      const disabled = busy || picking

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

      // One ref serves both the outside-click test and the keyboard walk.
      const popoverRef = useMenuKeyboard({ open: pos !== null, items: rows.length, onClose: onCancel })

      React.useLayoutEffect(() => {
        const place = () => setPos(flowMenuPosition(anchorRef.current, FLOW_MENU_WIDTH_ROOMY))
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
      }, [onCancel, popoverRef])

      return jsxs(Fragment, { children: [
        jsx('span', { ref: anchorRef, style: { position: 'absolute', width: 0, height: 0, pointerEvents: 'none' } }),
        pos !== null && jsx('div', {
          ref: popoverRef,
          className: 'sshwsp-flowmenu sshwsp-flowmenu-roomy',
          role: 'menu',
          style: { left: pos.left, top: pos.top },
          children: rows.map((row, index) =>
            jsxs('button', {
              key: row.key,
              type: 'button',
              role: 'menuitem',
              // A screen reader announces "item 1 of 3" only when the set size
              // and the position are both stated. `role="menu"` alone makes
              // assistive tech guess, and it guesses from whatever is currently
              // rendered — which for a popover is easy to get wrong. Both
              // attributes are 1-based; `aria-setsize` is the whole list, not
              // the number of enabled items.
              'aria-setsize': rows.length,
              'aria-posinset': index + 1,
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
      // Set when the server capped the listing, so the chooser can admit that
      // the directory the user wants may simply not be in the list.
      const [truncation, setTruncation] = React.useState(null)
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
        setTruncation(null)
        try {
          const query = typeof target === 'string' && target !== '' ? `&path=${encodeURIComponent(target)}` : ''
          const data = await fetchJson(`${API.ls}?alias=${encodeURIComponent(alias)}${query}`)
          if (seq !== loadSeq.current) return
          // Directories only — a remote workspace must point at a directory.
          setEntries((data.entries ?? [])
            .filter((entry) => entry.type === 'directory')
            .sort((a, b) => a.name.localeCompare(b.name)))
          // Truncation matters MORE here than in the browser dialog: this list
          // is how the user picks the workspace root, and a directory missing
          // from it is a workspace they cannot create.
          setTruncation(data.truncated === true
            ? { total: typeof data.total === 'number' ? data.total : 0 }
            : null)
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

      const dialog = useDialogA11y({ onClose: onCancel, busy: creating || busy, label: t('remote.title') })
      return jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(dismissBackdrop), children: [
        jsxs('div', { className: 'sshwsp-dialog', ...dialog.props, ref: dialog.bodyRef, tabIndex: -1, onClick: (e) => e.stopPropagation(), children: [
          jsxs('div', { className: 'sshwsp-dlg-head', children: [
            jsx('h2', { id: dialog.titleId, children: t('remote.title') }),
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
            truncation != null && jsx('div', { className: 'sshwsp-warn', role: 'status', children: t('remote.truncated', { total: truncation.total }) }),
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
    function RemoteWorkspacePage ({ translate, ctx }) {
      return jsx('div', { 'data-dsh-plugin': 'ssh-workspace', style: { height: '100%' }, children:
        jsx(RemoteWorkspacePanel, { t: translate, ctx }),
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
    // `localTitles` is the other half of the title rule: a label a LOCAL
    // workspace also uses cannot identify a remote one (see remoteTitleMatch).
    const remoteMarks = {
      ids: new Set(),
      titles: new Set(),
      localTitles: new Set(),
      // Title-only surfaces are marked only once a COMPLETE list has proven
      // which labels are already taken. `/status` carries remote workspaces
      // alone, so on its own it can never tell a remote title from a local
      // one that merely reads the same.
      titlesSettled: false,
      disabledIds: new Set(),
      disabledTitles: new Set(),
      disabledSessionIds: new Set(),
    }
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
    function collectRemoteWorkspaces (items, disabledPaths, complete = false) {
      const disabled = new Set(Array.isArray(disabledPaths) ? disabledPaths : [])
      knownDisabledPaths.clear()
      for (const path of disabled) knownDisabledPaths.add(path)
      const ids = new Set()
      const titles = new Set()
      const localTitles = new Set()
      const disabledIds = new Set()
      const disabledTitles = new Set()
      const disabledSessionIds = new Set()
      for (const item of Array.isArray(items) ? items : []) {
        if (typeof item?.path !== 'string' || item.path === '') continue
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        // The hero chip can fall back to the path basename while a fresh
        // session is still settling, so that spelling counts as identity too.
        const trimmedPath = item.path.replace(/[/\\]+$/, '')
        const segment = trimmedPath.slice(Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\')) + 1)
        if (!item.path.startsWith('ssh://')) {
          // A local workspace claims its own label. Only a complete list (DSH's
          // own store, which holds every workspace) can prove that claim; the
          // /status fallback carries remote workspaces alone, so it must not
          // erase what the store already told us.
          if (!complete) continue
          if (title !== '') localTitles.add(title)
          if (segment !== '') localTitles.add(segment)
          continue
        }
        const id = item.workspaceId ?? item.id
        if (id !== undefined && id !== null && String(id) !== '') ids.add(String(id))
        if (title !== '') titles.add(title)
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
      if (complete) {
        remoteMarks.localTitles = localTitles
        remoteMarks.titlesSettled = true
      }
      remoteMarks.ids = ids
      remoteMarks.titles = titles
      remoteMarks.disabledIds = disabledIds
      remoteMarks.disabledTitles = disabledTitles
      remoteMarks.disabledSessionIds = disabledSessionIds
    }

    /**
     * Whether one displayed title identifies a REMOTE workspace.
     *
     * Sidebar rows carry a workspace id, but the picker menu and the hero chip
     * carry nothing but the label, so those surfaces have to match by title.
     * A title a local workspace also uses cannot decide anything: the same
     * directory name exists on both sides (`dsh-ssh-workspace` checked out here
     * and mounted from a host), and matching it hands the local row the remote
     * mark — or, for a detached workspace, makes that local row inert.
     */
    function remoteTitleMatch (text) {
      if (!remoteMarks.titlesSettled) return false
      return text !== '' && remoteMarks.titles.has(text) && !remoteMarks.localTitles.has(text)
    }

    /** Whether one displayed title identifies a DETACHED remote workspace. */
    function detachedTitleMatch (text) {
      if (!remoteMarks.titlesSettled) return false
      return text !== '' && remoteMarks.disabledTitles.has(text) && !remoteMarks.localTitles.has(text)
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
        // `complete`: this store holds every workspace, local ones included, so
        // it is the only source that can prove which titles a LOCAL workspace
        // already claims (see remoteTitleMatch).
        if (Array.isArray(items)) collectRemoteWorkspaces(items, currentDisabledPaths(), true)
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
        markHost(host, host.querySelector(MARK_GLYPH_SELECTOR), remoteMarks.ids.has(id) || remoteTitleMatch(title))
        // A detached workspace's row is inert, not merely grey: its actions
        // must not fire. See setRowActionsInert for why this is `inert` on the
        // buttons rather than a click interceptor on the row.
        const detached = remoteMarks.disabledIds.has(id) || detachedTitleMatch(title)
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
        markHost(host, glyph, remoteTitleMatch(label))
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
        markHost(chip, before, remoteTitleMatch(text))
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
    // The whole Files tree, whether its root is local or remote. A system-file
    // drop is intercepted only inside this element; outside it the host's own
    // attachment handler keeps the gesture.
    const OS_TREE_SELECTOR = '[data-files-state="tree"]'
    // The file panel that owns the tree. Its header/path label lives outside
    // the tree but is still the panel's root drop target; dialogs are excluded
    // in osDropPlan.
    const OS_PAGE_SELECTOR = '[data-files-page]'
    // Marks the one element an OS drag currently highlights. The attribute is
    // document-wide so a materialization replaced by HMR can still clear the
    // outline its predecessor painted.
    const OS_DROP_ATTR = 'data-sshwsp-osdrop'
    const COMPOSER_CARD_SELECTOR = '[data-composer-card]'
    const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'
    const COMPOSER_CHIP_SELECTOR = '[data-composer-chip]'
    const DROP_CARET_ID = 'sshwsp-drop-caret'
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

    /**
     * The live host row for one `ssh://alias/path` spelling, or null.
     *
     * The row menu is opened from a gesture that already had the row in hand,
     * but its actions run later — after a re-render, the node may be gone. The
     * lookup is therefore done at ACT time, and a null answer is a supported
     * outcome: the rename falls back to the modal, which needs no row.
     */
    function rowOfPath (absPath) {
      const parts = remoteTargetOf(absPath)
      const wanted = parts === null ? absPath : parts.remotePath
      for (const row of document.querySelectorAll(TREE_ROW_SELECTOR)) {
        const path = row.getAttribute('data-files-path')
        if (path === wanted || path === absPath) return row
      }
      return null
    }

    /** Slash-normalized, trailing-slash-free spelling used to compare roots. */
    function normalizeRoot (value) {
      return typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/+$/, '') : ''
    }

    /** Whether a local spelling names the root itself or a descendant. */
    function localPathWithin (root, value) {
      const base = normalizeRoot(root)
      const path = normalizeRoot(value)
      return base !== '' && (path === base || path.startsWith(base + '/'))
    }

    /**
     * The local directory a blank right-click in the Files tree belongs to.
     *
     * The target is the nearest expanded directory row (its nested list lives
     * inside that row) and otherwise the tree root. It must be inside the root,
     * and the root must be a local session cwd: a remote ssh:// tree keeps its
     * own header-button path and is deliberately not resolved here.
     */
    function localBlankTargetOf (target) {
      if (!(target instanceof Element)) return null
      // The host nests a directory row's children INSIDE that same li, so
      // blank space below the children still has a row ancestor. Only the
      // row button is the row gesture; a nested list (or the row body) is
      // blank space for the directory that owns it.
      const ownRow = target.closest(TREE_ROW_SELECTOR)
      if (ownRow !== null) {
        const ownButton = ownRow.querySelector('button')
        if (ownButton !== null && ownButton.contains(target)) return null
        // Any non-directory row (the host also emits `other`) is that row's own
        // gesture, not blank space; only a directory row can own the space below it.
        if (ownRow.getAttribute('data-files-entry') !== 'directory') return null
      }
      const body = target.closest('[data-files-body]')
      const tree = target.closest('[data-files-state="tree"]')
      if (body === null || tree === null) return null
      const root = tree.getAttribute('data-files-root')
      if (root === null || root === '' || remoteTargetOf(root) !== null) return null
      const container = treeContainerOf(body)
      if (container === null) return null
      const dirRow = target.closest('li[data-files-entry="directory"][data-files-path]')
      const dir = dirRow === null ? root : dirRow.getAttribute('data-files-path')
      if (dir === null || dir === '' || !localPathWithin(root, dir)) return null
      return { dir, root, sessionId: treeSessionOfContainer(container), container }
    }

    /**
     * The Files panel a blank right-click belongs to, or null.
     *
     * The PANEL is the boundary, never the document. The header — the only
     * element carrying the alias and the remote path — and the scrolled list
     * are SIBLINGS inside `[data-files-page]`, so the narrowest container that
     * holds the pointer need not hold the button and the search has to widen to
     * the page. It must stop there: a document-wide fallback answers with the
     * first panel anyone rendered, so a right-click in the conversation — or on
     * a LOCAL panel sitting beside a remote one — borrowed a REMOTE directory
     * and offered to upload to a host the user was not looking at.
     *
     * A local panel renders no `[data-sshwsp-dir]` button at all, and that is
     * the correct answer here: the caller returns false and the browser's own
     * menu appears, which is what `localBlankTargetOf` already decided for it.
     *
     * @param {Element|null} target - element the right-click landed on.
     * @returns {{page: Element, tree: Element, alias: string, dir: string,
     *   root: string|null}|null} null when the pointer is not inside a panel
     *   this plugin has a remote directory for.
     */
    function blankMenuScopeOf (target) {
      if (!(target instanceof Element)) return null
      // No page ancestor means the pointer is outside every Files panel — the
      // conversation, another sidebar tab, a dialog. Nothing to offer, and the
      // browser's menu keeps the gesture.
      const page = target.closest(OS_PAGE_SELECTOR)
      if (page === null) return null
      const inTree = target.closest(OS_TREE_SELECTOR)
      const tree = inTree ?? page.querySelector(OS_TREE_SELECTOR)
      if (tree === null || !page.contains(tree)) return null
      // Same page as the tree, or the menu names a directory the panel beside
      // this one is showing.
      const button = page.querySelector('[data-sshwsp-dir]')
      if (button === null) return null
      const alias = button.getAttribute('data-sshwsp-alias')
      const dir = button.getAttribute('data-sshwsp-dir')
      if (alias === null || alias === '' || dir === null || dir === '') return null
      const rootValue = tree.getAttribute('data-files-root')
      return { page, tree, alias, dir, root: rootValue != null && rootValue !== '' ? rootValue : null }
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
     * Insert every path in one gesture as an @ reference into the composer.
     *
     * This is the ONLY insertion path: a single row, a multi-selection drop and
     * the row-menu verb all arrive here, so "which targets" and "what chip"
     * cannot drift between gestures. The target set is resolved once, the
     * composer target is resolved once, and focus is requested once after the
     * last chip — not once per item, which would move the caret between chips.
     *
     * @param {object} ctx - plugin context.
     * @param {Array<{path: string, isDir?: boolean}>} items - resolved targets.
     * @param {string|null} root - the tree root the paths are spelled against.
     * @param {Element|null} [card] - the composer card that received the drop.
     * @param {number|null} [at] - optional detect offset for the first insertion.
     * @returns {boolean} true when at least one reference was inserted.
     */
    function addPathsToTask (ctx, items, root, card = null, at = null) {
      const target = resolveComposerTarget(ctx)
      if (target === null) {
        notifyUser(toastError(translate('mention.noComposer'), 'no visible composer input', 'SSHWSP-E-MENTION-COMPOSER'))
        return false
      }
      // Relative only when the tree stands on the composer's own root; any
      // other spelling stays absolute, which the Host resolves as it stands.
      const rootKey = normalizeRoot(root)
      const base = rootKey !== '' && rootKey === normalizeRoot(readComposerRoot(ctx, target.sessionId)) ? root : null
      const seen = new Set()
      const wanted = []
      for (const item of Array.isArray(items) ? items : []) {
        if (item === null || typeof item !== 'object' || typeof item.path !== 'string' || item.path === '') continue
        if (seen.has(item.path)) continue
        seen.add(item.path)
        wanted.push({ path: item.path, isDir: item.isDir === true })
      }
      if (wanted.length === 0) return false
      // A drag can name the caret position it wants for the FIRST reference.
      // The first successful (or at least attempted) chip consumes it; later
      // chips use the live caret, which the host puts after the previous chip.
      // Zero is a real position (empty draft / line start), so only null means
      // "no requested position".
      let pendingAt = at !== null && Number.isInteger(at) && at >= 0 ? at : null
      let added = 0
      const failures = []
      for (const item of wanted) {
        const mention = mentionToken(item.path, base, item.isDir)
        if (mention === null) {
          failures.push({ name: entryNameOf(item.path), reason: 'unrepresentable' })
          continue
        }
        const reference = referenceFor(item.path, mention, item.isDir)
        let baseSpan = null
        try {
          baseSpan = target.actions.captureInsertion()
        } catch {
          baseSpan = null
        }
        // Only the first attempt consumes `at`. The span must be built once and
        // reused by the text fallback: re-capturing after a rejected chip would
        // read the post-drag caret (the document end) and quietly undo the point.
        const span = pendingAt === null || baseSpan === null
          ? baseSpan
          : { draftRev: baseSpan.draftRev, start: pendingAt, end: pendingAt }
        const usedAt = pendingAt !== null
        let applied = false
        try {
          applied = target.actx.bail(target.actx, 'slash/input-insert-reference', { reference, span }) === true
        } catch {
          applied = false
        }
        if (!applied) {
          try {
            applied = target.actions.insertText(`${mention} `, span) !== false
          } catch {
            applied = false
          }
        }
        if (usedAt) pendingAt = null
        if (applied) added += 1
        else failures.push({ name: entryNameOf(item.path), reason: 'insert' })
      }
      if (added > 0) focusSoleComposer(card)
      if (failures.length === 0) return true
      const names = failures.slice(0, 3).map(item => item.name).join('、')
      if (added === 0) {
        const unrepresentable = failures.every(item => item.reason === 'unrepresentable')
        notifyUser(toastError(
          translate(unrepresentable ? 'mention.unrepresentable' : 'mention.insertFail'),
          names,
          unrepresentable ? 'SSHWSP-E-MENTION-PATH' : 'SSHWSP-E-MENTION-INSERT',
        ))
        return false
      }
      notifyUser(translate('mention.addedPartly', { added, failed: failures.length, names }), 'muted')
      return true
    }

    /**
     * Best-effort focus of the composer that received the insert.
     *
     * `card` is the composer card the drop landed on. It exists because there
     * can be more than one visible composer (the main one plus a session card);
     * the old helper refused to guess between them and therefore left the
     * caret wherever the browser had put it. The insertion target is known at
     * the call site, so focus it directly and only fall back to the "sole
     * visible composer" rule when no card was supplied.
     *
     * ORDER IS THE WHOLE CONTRACT, and the two calls do different jobs:
     *
     *   editor.focus()  model selection -> DOM. Lexical clones its stored
     *                   selection and the commit writes the DOM range, so the
     *                   caret materialises at the insertion point (after the
     *                   chip). It does NOT focus the element.
     *   input.focus()   the actual HTML focus. A browser preserves a selection
     *                   that already sits inside the element, so this is the
     *                   step that activates the box without moving anything.
     *
     * Swapping them looked equivalent and was not. A plain `input.focus()` on a
     * contenteditable whose internal selection was lost (dragging from the tree
     * blurs the composer) leaves the browser putting the caret at the document
     * start; Lexical's `selectionchange` handler adopts that as a user move and
     * overwrites the model selection, and the subsequent `editor.focus()` then
     * faithfully "restores" the already-moved caret. The observable result was
     * the reported one: the chip is appended at the end of the draft while the
     * caret sits at its beginning, so the next character typed lands BEFORE the
     * path instead of after it.
     */
    function focusSoleComposer (card = null) {
      try {
        // A drop names the card it landed on; without one, fall back to the
        // sole visible composer. The card is the authority when two panels are
        // open: focusing "the only" composer would silently skip the one that
        // actually received the reference.
        const target = card !== null && card !== undefined && typeof card.querySelector === 'function'
          ? card.querySelector('[data-composer-input]')
          : soleComposerInput()
        if (target === null) return
        const editor = target.__lexicalEditor
        // Write the caret first, then give the box the HTML focus.
        if (typeof editor?.focus === 'function') editor.focus()
        target.focus({ preventScroll: true })
      } catch { /* best-effort */ }
    }

    /** The composer input element when exactly one is visible, else null. */
    function soleComposerInput () {
      const cards = [...document.querySelectorAll(COMPOSER_CARD_SELECTOR)].filter((card) => {
        const rect = card.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      if (cards.length !== 1) return null
      return cards[0].querySelector(COMPOSER_INPUT_SELECTOR)
    }

    /** A DOM text node, without assuming the global `Node` exists. */
    function composerTextNode (node) {
      return node !== null && typeof node === 'object' && node.nodeType === 3
    }

    /** A DOM element, without assuming the global `Element` exists. */
    function composerElement (node) {
      return node !== null && typeof node === 'object' && node.nodeType === 1
    }

    /** Attribute presence on real and fake nodes alike. */
    function composerHasAttribute (node, name) {
      try {
        if (typeof node.hasAttribute === 'function') return node.hasAttribute(name)
        if (typeof node.getAttribute === 'function') return node.getAttribute(name) !== null
      } catch { /* best-effort */ }
      return false
    }

    /** Children as an array, whether the DOM hands back a NodeList or a fake array. */
    function composerChildren (node) {
      const kids = node?.childNodes ?? node?.children
      return kids === null || kids === undefined ? [] : Array.from(kids)
    }

    /** Is `node` inside (or exactly) `root`? */
    function composerContains (root, node) {
      let current = node
      while (current !== null && current !== undefined) {
        if (current === root) return true
        current = current.parentNode ?? null
      }
      return false
    }

    /**
     * The chip host around a boundary, if the boundary is inside a chip.
     *
     * Chips are atomic in the host's detect projection: one U+FFFC no matter
     * what the decorator portal rendered inside the host span. Descending into
     * that portal would count the visible label and put the caret in the wrong
     * paragraph, so this stops at the `data-composer-chip` element.
     */
    function composerChipOf (node) {
      let current = node
      while (current !== null && current !== undefined) {
        if (composerElement(current) && composerHasAttribute(current, 'data-composer-chip')) return current
        current = current.parentNode ?? null
      }
      return null
    }

    /** Detect length of one rendered node (text; atomic chip; managed br; recurse). */
    function composerRenderedLength (node) {
      if (node === null || node === undefined) return 0
      if (composerTextNode(node)) return String(node.data ?? '').length
      if (!composerElement(node)) return 0
      if (composerHasAttribute(node, 'data-composer-chip')) return 1
      const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
      if (tag === 'BR') {
        // Lexical's empty-block placeholder. It renders a line box but contributes
        // nothing to the detect projection; counting it would add a phantom
        // character to every empty paragraph.
        return composerHasAttribute(node, 'data-lexical-managed-linebreak') ? 0 : 1
      }
      let at = 0
      for (const child of composerChildren(node)) at += composerRenderedLength(child)
      return at
    }

    /** Detect length of the children before `offset` in one element. */
    function composerChildPrefix (element, offset) {
      const kids = composerChildren(element)
      const raw = Number(offset)
      const limit = Number.isFinite(raw) ? Math.max(0, Math.min(Math.trunc(raw), kids.length)) : 0
      let at = 0
      for (let index = 0; index < limit; index += 1) at += composerRenderedLength(kids[index])
      return at
    }

    /**
     * Detect length from the start of `block` to just before `node`.
     *
     * Walks the sibling chains up to `block`, so a boundary inside a nested
     * `<span>`/`<strong>` still counts everything that precedes it. Returns
     * null when `node` does not belong to `block`.
     */
    function composerLengthBeforeNode (block, node) {
      if (block === node) return 0
      if (!composerContains(block, node)) return null
      let at = 0
      let current = node
      while (current !== null && current !== undefined && current !== block) {
        let previous = current.previousSibling
        while (previous !== null && previous !== undefined) {
          at += composerRenderedLength(previous)
          previous = previous.previousSibling
        }
        current = current.parentNode ?? null
      }
      return current === block ? at : null
    }

    /**
     * Detect length from the block start to the boundary.
     *
     * The boundary can be the block itself (element + child index), a text
     * node (offset inside the string), a chip (atomic; the pointer's half of
     * the chip decides before/after), a managed/normal `<br>`, or an element
     * boundary. Returns null when the boundary is not inside the block.
     */
    function composerLengthBefore (block, boundaryNode, boundaryOffset, clientX) {
      if (block === null || block === undefined || boundaryNode === null || boundaryNode === undefined) return null
      if (!composerContains(block, boundaryNode)) return null
      const chip = composerChipOf(boundaryNode)
      if (chip !== null) {
        const before = composerLengthBeforeNode(block, chip)
        if (before === null) return null
        let rect = null
        try {
          if (typeof chip.getBoundingClientRect === 'function') rect = chip.getBoundingClientRect()
        } catch { /* no geometry: use the left half */ }
        const middle = rect === null ? 0 : Number(rect.left ?? 0) + Number(rect.width ?? 0) / 2
        return before + (Number(clientX) > middle ? 1 : 0)
      }
      if (boundaryNode === block) {
        if (composerTextNode(block)) {
          return Math.min(Math.max(0, Number(boundaryOffset) || 0), String(block.data ?? '').length)
        }
        return composerChildPrefix(block, boundaryOffset)
      }
      const before = composerLengthBeforeNode(block, boundaryNode)
      if (before === null) return null
      if (composerTextNode(boundaryNode)) {
        return before + Math.min(Math.max(0, Number(boundaryOffset) || 0), String(boundaryNode.data ?? '').length)
      }
      if (composerElement(boundaryNode)) return before + composerChildPrefix(boundaryNode, boundaryOffset)
      return before
    }

    /** The top-level block (paragraph) containing `node`, or null. */
    function composerBlockOf (input, node) {
      if (input === null || input === undefined || node === null || node === undefined) return null
      let block = node
      while (block !== null && block !== undefined && block !== input) {
        const parent = block.parentNode ?? null
        if (parent === null) return null
        if (parent === input) return block
        block = parent
      }
      return null
    }

    /**
     * Detect offset of a DOM boundary in the whole composer.
     *
     * Host layout: each top-level block contributes its own text, and one
     * newline separates neighboring blocks. The newline is not a DOM node,
     * so it is added here once per block after the first.
     */
    function composerOffsetOf (input, boundaryNode, boundaryOffset, clientX) {
      if (input === null || input === undefined || boundaryNode === null || boundaryNode === undefined) return null
      const block = composerBlockOf(input, boundaryNode)
      if (block === null) return null
      const blocks = Array.from(input.children ?? input.childNodes ?? [])
      let at = 0
      for (let index = 0; index < blocks.length; index += 1) {
        if (index > 0) at += 1
        if (blocks[index] === block) {
          const within = composerLengthBefore(block, boundaryNode, boundaryOffset, clientX)
          return within === null ? null : at + within
        }
        at += composerRenderedLength(blocks[index])
      }
      return null
    }

    /** A collapsed Range at a viewport point, or null when the browser cannot answer. */
    function caretRangeAt (x, y) {
      try {
        if (typeof document === 'undefined' || document === null) return null
        if (typeof document.caretRangeFromPoint === 'function') return document.caretRangeFromPoint(x, y)
        if (typeof document.caretPositionFromPoint === 'function') {
          const position = document.caretPositionFromPoint(x, y)
          if (position === null || position === undefined) return null
          const range = document.createRange()
          range.setStart(position.offsetNode, position.offset)
          return range
        }
      } catch { /* best-effort; the drop falls back to append */ }
      return null
    }

    /**
     * Map a dragover/drop event to both a detect offset and the visual range.
     *
     * Every degradation returns null rather than throwing: a failed mapping
     * must never make the drag insertion itself fail. The offset is recomputed
     * on drop instead of cached from dragover, because HMR can leave two
     * materializations seeing different events.
     */
    function dropPointFromEvent (event, card) {
      try {
        if (event === null || event === undefined || card === null || card === undefined) return null
        if (typeof card.querySelector !== 'function') return null
        const input = card.querySelector(COMPOSER_INPUT_SELECTOR)
        if (input === null || input === undefined) return null
        if (input !== soleComposerInput()) return null
        const target = event.target
        if (!composerElement(target) || !composerContains(input, target)) return null
        const range = caretRangeAt(event.clientX, event.clientY)
        if (range === null || range.startContainer === null || range.startContainer === undefined) return null
        if (!composerContains(input, range.startContainer)) return null
        const at = composerOffsetOf(input, range.startContainer, range.startOffset, event.clientX)
        if (at === null) return null
        return { at, range, input }
      } catch {
        return null
      }
    }

    /** The detect offset for a drop event, or null to use the old append behavior. */
    function dropOffsetFromEvent (event, card) {
      const point = dropPointFromEvent(event, card)
      return point === null ? null : point.at
    }

    /** The one visual drop caret, reused across HMR materializations. */
    function dropCaretElement () {
      try {
        if (typeof document === 'undefined' || document.body === null || document.body === undefined) return null
        const existing = typeof document.getElementById === 'function' ? document.getElementById(DROP_CARET_ID) : null
        if (existing !== null && existing !== undefined) return existing
        const node = document.createElement('div')
        node.id = DROP_CARET_ID
        node.setAttribute('aria-hidden', 'true')
        node.style.position = 'fixed'
        node.style.width = '2px'
        node.style.pointerEvents = 'none'
        node.style.zIndex = '1000'
        node.style.background = 'var(--dsw-alias-state-business-primary, #4a9eff)'
        node.style.display = 'none'
        document.body.appendChild(node)
        return node
      } catch {
        return null
      }
    }

    /** Range rectangle, falling back to the block's line box for all-zero rects. */
    function dropCaretRect (point) {
      let rect = null
      try {
        if (typeof point.range.getBoundingClientRect === 'function') rect = point.range.getBoundingClientRect()
      } catch { /* no geometry */ }
      if (rect === null || rect === undefined) return null
      if (Number(rect.width) === 0 && Number(rect.height) === 0 &&
          Number(rect.left) === 0 && Number(rect.top) === 0) {
        const block = composerBlockOf(point.input, point.range.startContainer)
        try {
          if (block !== null && typeof block.getBoundingClientRect === 'function') rect = block.getBoundingClientRect()
        } catch { /* keep the zero rect */ }
      }
      return rect
    }

    /** Draw the caret at the drop point, clamped to the input's box. */
    function showDropCaret (point) {
      const node = dropCaretElement()
      if (node === null) return
      const rect = dropCaretRect(point)
      if (rect === null) {
        hideDropCaret()
        return
      }
      let inputRect = { top: 0, bottom: 0, height: 0 }
      try {
        if (typeof point.input.getBoundingClientRect === 'function') inputRect = point.input.getBoundingClientRect()
      } catch { /* keep the fallback box */ }
      const inputTop = Number(inputRect.top) || 0
      const inputHeight = Number(inputRect.height) || 0
      const rawBottom = Number(inputRect.bottom)
      const inputBottom = Number.isFinite(rawBottom) && rawBottom > inputTop ? rawBottom : inputTop + inputHeight
      const rectTop = Number(rect.top) || 0
      const rectHeight = Number(rect.height) || 2
      const top = Math.min(Math.max(rectTop, inputTop), Math.max(inputTop, inputBottom - 2))
      const height = Math.max(2, Math.min(rectHeight, Math.max(2, inputBottom - top)))
      node.style.left = `${Number(rect.left) || 0}px`
      node.style.top = `${top}px`
      node.style.height = `${height}px`
      node.style.display = 'block'
    }

    /** Hide the visual drop caret without removing the single shared node. */
    function hideDropCaret () {
      try {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return
        const node = document.getElementById(DROP_CARET_ID)
        if (node !== null && node !== undefined && node.style !== null && node.style !== undefined) {
          node.style.display = 'none'
        }
      } catch { /* best-effort */ }
    }

    /**
     * Format a byte count for a completion notice.
     *
     * Separate from the browser dialog's `formatSize` (which rounds to one
     * decimal for a file listing) because this one is read ONCE, in a sentence,
     * after the fact: "4.2 MB" there, "4.2 MB" here. Reusing the listing's
     * helper would be the honest choice except that it lives inside the
     * DirectoryBrowser component and is not reachable from the tree-row code —
     * so it is a module-level function both can call.
     *
     * @param {number} bytes - the count.
     * @returns {string} a short human form.
     */
    function formatBytes (bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
      return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
    }

    /**
     * The one dismissal timer for the DOM-level toast.
     *
     * Shared on purpose: `notifyUser` and `transferNotice` both draw into the
     * same slot (each removes the previous node), so two independent timers
     * would let a stale notice's expiry remove the node that replaced it.
     */
    let domToastTimer = null
    /** The node the shared timer currently belongs to. */
    let domToastOwner = null
    /** Monotonic id for detail panels (`aria-controls` needs a real id). */
    let toastIdSeq = 0

    /**
     * Turn whatever a failure carried into text a reader can copy.
     *
     * Routes report some failures as strings, some as `Error`s and some as
     * plain objects; a toast must not lose the difference between "the route
     * said no" and "the socket died". `stack` is preferred over `message`
     * because the first line of a stack still contains the message and the
     * rest is what a bug report needs.
     *
     * @param {unknown} value - anything a catch clause or route produced.
     * @returns {string} copyable text, empty when there is nothing to say.
     */
    function toastDiagnosticText (value) {
      if (value === undefined || value === null || value === '') return ''
      if (typeof value === 'string') return value
      if (value instanceof Error) return value.stack || value.message || String(value)
      if (typeof value === 'object' && typeof value.message === 'string') {
        return value.stack || value.message
      }
      try {
        const json = JSON.stringify(value, null, 2)
        return json === undefined ? String(value) : json
      } catch {
        return String(value)
      }
    }

    /**
     * Normalise the shapes callers already speak into one toast model.
     *
     * Strings keep working, because most successes are one translated line.
     * `kind` may be passed separately (the old `notifyUser(text, kind)` call
     * shape) or live on the object. Only an error can carry a diagnostic code
     * and a retry function; both are dropped from successes so a local check
     * cannot turn a green toast into an offer to replay something.
     *
     * @param {string|object|null} input - text or `{ kind, text, code, detail, error, retry }`.
     * @param {'ok'|'err'|'muted'} [kind] - explicit face, when the caller uses the old signature.
     * @returns {{kind: 'ok'|'err'|'muted', text: string, code: string, detail: string, retry: null|Function}}
     */
    function toastModel (input, kind) {
      const source = typeof input === 'string' ? { text: input } : (input ?? {})
      const requested = kind ?? source.kind
      const normalized = requested === 'err' || requested === 'ok' || requested === 'muted' ? requested : 'muted'
      const text = String(source.text ?? source.headline ?? '')
      const code = normalized === 'err'
        ? String(source.code != null && source.code !== '' ? source.code : 'SSHWSP-E-UNEXPECTED')
        : ''
      const detail = normalized === 'err' ? toastDiagnosticText(source.detail ?? source.error) : ''
      const retry = normalized === 'err' && typeof source.retry === 'function' ? source.retry : null
      return { kind: normalized, text, code, detail, retry }
    }

    /**
     * The exact block the copy button puts on the clipboard.
     *
     * The code is included even though it is also on screen: a copied report
     * is read by someone who was not looking at the toast, and a code without
     * its sentence (or a sentence without its code) is half a clue.
     *
     * @param {object|string} input - a toast model, or a string.
     * @returns {string} headline, diagnostic code, blank line, raw detail.
     */
    function toastCopyText (input) {
      const model = toastModel(input)
      const lines = [model.text]
      if (model.code !== '') lines.push(`[${model.code}]`)
      if (model.detail !== '') lines.push('', model.detail)
      return lines.join('\n')
    }

    /** Build an error model without repeating the field list at every call site. */
    function toastError (text, detail, code, retry) {
      return { kind: 'err', text, detail, code, retry }
    }

    /** A translated toast label, or the key itself outside the app shell. */
    function toastLabel (key) {
      try {
        return typeof translate === 'function' ? translate(key) : key
      } catch {
        return key
      }
    }

    /** The element that currently holds focus, when the platform has one. */
    function focusedElement () {
      if (typeof document === 'undefined') return null
      const active = document.activeElement
      return typeof active === 'object' && active !== null ? active : null
    }

    /**
     * The action button owned by `target`, walking up to the toast root.
     *
     * Delegation rather than per-button listeners keeps a retry that rewrites
     * the same node from stacking another set of listeners on every attempt.
     *
     * @param {EventTarget|null} target - the event target.
     * @returns {Element|null} the button carrying `data-toast-action`.
     */
    function toastActionOf (target) {
      let node = target
      while (node !== null && node !== undefined) {
        if (typeof node.getAttribute === 'function' && node.getAttribute('data-toast-action') !== null) return node
        node = node.parent === undefined ? null : node.parent
      }
      return null
    }

    /** One action button inside the toast's action row. */
    function toastActionButton (action) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'sshwsp-toast-action'
      button.setAttribute('data-toast-action', action)
      button.textContent = toastLabel(`toast.${action}`)
      return button
    }

    /**
     * Build (once) the fixed child structure every toast shares.
     *
     * A retry can turn one failure into a success in place. If the node had
     * only ever contained a text node, the rewrite would have to replace the
     * element, which is exactly the "second toast" the requirement forbids.
     * Creating the line, actions, detail and status once means every later
     * update is a property write on a node already on screen.
     *
     * @param {HTMLElement} el - the toast root.
     * @returns {object} the named children.
     */
    function toastParts (el) {
      if (el.__sshwspToastParts !== undefined) return el.__sshwspToastParts
      const line = document.createElement('span')
      line.className = 'sshwsp-toast-line'
      const actions = document.createElement('div')
      actions.className = 'sshwsp-toast-actions'
      const details = toastActionButton('details')
      const copy = toastActionButton('copy')
      const retry = toastActionButton('retry')
      details.setAttribute('aria-expanded', 'false')
      const panel = document.createElement('div')
      panel.className = 'sshwsp-toast-detail'
      panel.hidden = true
      panel.id = `sshwsp-toast-detail-${toastIdSeq += 1}`
      details.setAttribute('aria-controls', panel.id)
      const code = document.createElement('span')
      code.className = 'sshwsp-toast-detail-code'
      code.hidden = true
      const pre = document.createElement('pre')
      panel.appendChild(code)
      panel.appendChild(pre)
      const status = document.createElement('span')
      status.className = 'sshwsp-toast-status'
      status.setAttribute('aria-live', 'polite')
      actions.appendChild(details)
      actions.appendChild(copy)
      actions.appendChild(retry)
      el.appendChild(line)
      el.appendChild(actions)
      el.appendChild(panel)
      el.appendChild(status)
      const parts = { line, actions, details, copy, retry, panel, code, pre, status }
      el.__sshwspToastParts = parts
      return parts
    }

    /**
     * Paint one model onto one existing toast node.
     *
     * This is the ONLY write path: first show, retry result, and transfer
     * outcome all come through here. That is what makes "feedback rewrites the
     * same node" true rather than a comment.
     *
     * @param {HTMLElement} el - the toast root.
     * @param {object} model - output of `toastModel`.
     */
    function renderToast (el, model) {
      const parts = toastParts(el)
      const failure = model.kind === 'err'
      el.className = `sshwsp-toast sshwsp-toast-${failure ? 'err' : model.kind === 'ok' ? 'ok' : 'muted'}`
      el.setAttribute('role', failure ? 'alert' : 'status')
      el.setAttribute('data-toast-kind', model.kind)
      el.tabIndex = 0
      parts.line.textContent = model.text
      parts.actions.hidden = !failure
      const hasDetail = model.code !== '' || model.detail !== ''
      parts.details.hidden = !failure || !hasDetail
      parts.copy.hidden = !failure
      // No safe replay, no button. A disabled Retry would still tell the user
      // the action is somehow retryable and merely unavailable right now.
      parts.retry.hidden = typeof model.retry !== 'function'
      parts.retry.disabled = false
      parts.details.setAttribute('aria-expanded', 'false')
      parts.panel.hidden = true
      parts.code.textContent = model.code === '' ? '' : `[${model.code}]`
      parts.code.hidden = model.code === ''
      parts.pre.textContent = model.detail === '' ? toastLabel('toast.noDetail') : model.detail
      parts.status.textContent = ''
      el.__sshwspToastModel = model
      el.__sshwspToastRetrying = false
      el.__sshwspToastDismissed = false
    }

    /** Select the whole detail block (code + raw error) for a manual copy. */
    function selectToastDetail (panel) {
      try {
        if (typeof document.createRange !== 'function') return false
        if (typeof window === 'undefined' || window === null || typeof window.getSelection !== 'function') return false
        const selection = window.getSelection()
        if (selection === null || typeof selection.addRange !== 'function') return false
        const range = document.createRange()
        range.selectNodeContents(panel)
        if (typeof selection.removeAllRanges === 'function') selection.removeAllRanges()
        selection.addRange(range)
        return true
      } catch {
        return false
      }
    }

    /**
     * Copy the whole diagnostic block, or fall back to selecting it.
     *
     * The clipboard is asynchronous and permission-gated; a rejected write is
     * not a reason to say nothing. Opening the detail and selecting it keeps
     * the feedback in this node and leaves a real manual path.
     *
     * @param {HTMLElement} el - the toast root.
     */
    async function copyToast (el) {
      const parts = toastParts(el)
      const model = el.__sshwspToastModel
      let clipboard = null
      try {
        if (typeof navigator !== 'undefined' && navigator !== null) clipboard = navigator.clipboard
      } catch {
        clipboard = null
      }
      try {
        if (clipboard === undefined || clipboard === null || typeof clipboard.writeText !== 'function') {
          throw new Error('clipboard unavailable')
        }
        await clipboard.writeText(toastCopyText(model))
        parts.status.textContent = toastLabel('toast.copied')
      } catch {
        // Reveal the panel BEFORE selecting: a Selection inside a hidden
        // subtree is created but never painted, so the user would see a
        // "selected, press Ctrl+C" message with nothing visibly selected.
        parts.details.setAttribute('aria-expanded', 'true')
        parts.panel.hidden = false
        const selected = selectToastDetail(parts.panel)
        parts.status.textContent = selected
          ? toastLabel('toast.copyFallback')
          : toastLabel('toast.copyFallbackUnselected')
      }
    }

    /** Toggle the raw diagnostic panel. The clock is deliberately untouched. */
    function toggleToastDetails (el) {
      const parts = toastParts(el)
      const opening = parts.panel.hidden === true
      parts.panel.hidden = !opening
      parts.details.setAttribute('aria-expanded', opening ? 'true' : 'false')
    }

    /**
     * Replay the failed action and rewrite the same node with its result.
     *
     * Only a model whose `retry` is a function reaches here, and the button is
     * not rendered otherwise — a disabled "Retry" would claim an offer the
     * action cannot honour. The dismissal clock is not restarted: a user who
     * retries must not earn a second full window.
     *
     * @param {HTMLElement} el - the toast root.
     */
    async function retryToast (el) {
      if (el.__sshwspToastRetrying === true) return
      const model = el.__sshwspToastModel
      if (model === undefined || typeof model.retry !== 'function') return
      const parts = toastParts(el)
      el.__sshwspToastRetrying = true
      parts.retry.disabled = true
      parts.status.textContent = toastLabel('toast.retrying')
      try {
        const next = await model.retry()
        if (el.__sshwspToastDismissed === true) return
        if (next === null || next === undefined) {
          parts.status.textContent = ''
          return
        }
        renderToast(el, toastModel(next))
      } catch (err) {
        if (el.__sshwspToastDismissed === true) return
        renderToast(el, toastModel(toastError(toastLabel('toast.retryFail'), err, model.code, model.retry)))
      } finally {
        el.__sshwspToastRetrying = false
        if (el.__sshwspToastDismissed !== true) {
          const current = toastParts(el)
          current.retry.disabled = false
        }
      }
    }

    /**
     * Remove the toast, returning focus only when it was actually inside.
     *
     * "The toast appeared without taking focus" and "closing it gives focus
     * back" are both required; checking `activeElement` is what makes the two
     * consistent. A toast the user never entered must not move their caret.
     *
     * @param {HTMLElement} el - the toast root.
     * @param {Element|null} returnFocus - where focus was before the toast existed.
     */
    function dismissToast (el, returnFocus) {
      if (el.__sshwspToastDismissed === true) return
      el.__sshwspToastDismissed = true
      if (domToastOwner === el) {
        if (domToastTimer !== null) clearTimeout(domToastTimer)
        domToastTimer = null
        domToastOwner = null
      }
      if (typeof document !== 'undefined') {
        const active = document.activeElement
        const inside = active === el || (typeof el.contains === 'function' && el.contains(active))
        if (inside) {
          if (returnFocus !== null && returnFocus !== undefined &&
              typeof returnFocus.focus === 'function' && returnFocus.isConnected !== false) {
            returnFocus.focus()
          } else if (typeof el.blur === 'function') {
            el.blur()
          }
        }
      }
      el.remove()
    }

    /**
     * Turn a toast node into a dismissible, self-expiring notice.
     *
     * Resting on the toast stops its clock and leaving restarts the full
     * window, so "it vanished while I was reading it" is not a failure mode.
     * A failure no longer takes focus when it appears: a seven-second timer
     * must not move the caret out of whatever the user was typing into. It
     * still expires, announces via `role="alert"`, and can be reached with
     * Tab; when it closes it hands focus back only if the user had entered it.
     *
     * @param {HTMLElement} el - the notice node, already in the document.
     * @param {Element|null} [returnFocus] - where focus was before it existed.
     */
    function armToast (el, returnFocus = null) {
      const parts = toastParts(el)
      el.__sshwspToastReturnFocus = returnFocus
      const dismiss = () => dismissToast(el, returnFocus)
      const schedule = () => {
        if (domToastTimer !== null) clearTimeout(domToastTimer)
        domToastOwner = el
        domToastTimer = setTimeout(dismiss, TOAST_DISMISS_MS)
      }

      el.addEventListener('click', (event) => {
        const action = toastActionOf(event.target)
        if (action !== null) {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          const name = action.getAttribute('data-toast-action')
          if (name === 'details') toggleToastDetails(el)
          else if (name === 'copy') copyToast(el)
          else if (name === 'retry') retryToast(el)
          return
        }
        if (event.target === el || event.target === parts.line) dismiss()
      })
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          dismiss()
          return
        }
        // Enter belongs to the root only: a button inside handles its own
        // Enter by producing a click, which the branch above routes by action.
        if (event.key === 'Enter' && event.target === el) {
          event.preventDefault()
          dismiss()
        }
      })
      el.addEventListener('mouseenter', () => {
        if (domToastOwner === el && domToastTimer !== null) {
          clearTimeout(domToastTimer)
          domToastTimer = null
        }
      })
      el.addEventListener('mouseleave', () => {
        if (el.__sshwspToastDismissed === true) return
        schedule()
      })
      schedule()
    }

    /**
     * Toast for every gesture, including the React panel.
     *
     * The message is on screen for `TOAST_DISMISS_MS`, can be dismissed early
     * by click, Esc or Enter, and holds its clock while the pointer rests on
     * it. `input` accepts a string (the old shape) or a model carrying a
     * diagnostic code and an optional retry function.
     *
     * @param {string|object} input - what to say.
     * @param {'ok'|'err'|'muted'} [kind] - success, failure, or neither.
     */
    function notifyUser (input, kind) {
      if (typeof document === 'undefined' || input == null) return
      const model = toastModel(input, kind)
      if (model.text === '' && model.detail === '') return
      const active = focusedElement()
      let returnFocus = active
      for (const stale of document.querySelectorAll('.sshwsp-toast[data-sshwsp-toast]')) {
        const inside = active !== null &&
          (active === stale || (typeof stale.contains === 'function' && stale.contains(active)))
        if (inside) {
          const oldReturn = stale.__sshwspToastReturnFocus
          if (oldReturn !== null && oldReturn !== undefined &&
              typeof oldReturn.focus === 'function' && oldReturn.isConnected !== false) {
            returnFocus = oldReturn
            oldReturn.focus()
          } else {
            returnFocus = null
          }
        }
        stale.remove()
      }
      const el = document.createElement('div')
      el.setAttribute('data-sshwsp-toast', '1')
      el.className = 'sshwsp-toast'
      renderToast(el, model)
      document.body.appendChild(el)
      armToast(el, returnFocus)
    }

    /**
     * A transfer in flight, shown as ONE toast that later becomes the result.
     *
     * "Uploading foo.zip…" followed by "Uploaded foo.zip" is two toasts, and
     * the first one resets the second one's dismissal timer — so the window
     * starts from the wrong moment, and the notice the user must actually read
     * can disappear first. It is also a flicker: the message is removed and
     * immediately re-added.
     *
     * So the in-flight notice and its outcome are the same element, edited in
     * place. The element is returned rather than the text, because the transfer
     * decides what the outcome says and when it says it.
     *
     * @param {string} text - the opening line.
     * @returns {{text: (line: string) => void, done: (line: string|object, kind?: 'ok'|'err') => void, failed: (line: string) => void}}
     *   the live handle.
     */
    function transferNotice (text) {
      const inert = { text: () => {}, done: () => {}, failed: () => {} }
      if (typeof document === 'undefined' || text == null) return inert
      for (const stale of document.querySelectorAll('.sshwsp-toast[data-sshwsp-toast]')) stale.remove()
      const el = document.createElement('div')
      el.setAttribute('data-sshwsp-toast', '1')
      el.className = 'sshwsp-toast'
      renderToast(el, toastModel({ kind: 'muted', text }))
      document.body.appendChild(el)
      let closed = false
      const turnInto = (input, kind) => {
        if (closed) return
        closed = true
        if (el.isConnected === false) return
        const fallback = typeof input === 'string' ? 'ok' : undefined
        const model = toastModel(input, kind ?? fallback)
        renderToast(el, model)
        armToast(el, model.kind === 'err' ? focusedElement() : null)
      }
      return {
        text: (line) => { if (!closed && line != null) el.__sshwspToastParts.line.textContent = String(line) },
        done: (input, kind) => turnInto(input, kind),
        failed: (input) => turnInto(input, 'err'),
      }
    }

    // =========================================================================
    // Transfer queue (batch uploads, progress overlay, cancellation)
    // =========================================================================
    //
    // ## Why one queue owns every browser-side transfer
    //
    // The panel used to start a transfer directly from the gesture that asked
    // for it: a click began a fetch, a notice reported the outcome, and a second
    // click was either ignored (a busy flag swallowed it) or silently overlapped
    // (the file tree's fire-and-forget row menu). Three
    // problems followed, and they are one problem seen from three angles: no
    // object represented "a transfer in flight", so nothing could report
    // progress, nothing could be queued behind something else, and nothing
    // could be cancelled.
    //
    // The browser half therefore has ONE store now. Uploads and downloads are
    // enqueued as items and drained by a scheduler with two rules: at most ONE
    // transfer per host (a transfer holds one SFTP channel and one pooled
    // connection, and two to the same host contend for both), and at most TWO
    // across all hosts (a page that opens six sessions at once competes with
    // itself and with the agent busy doing something else). Those are constants
    // below, not UI state, because a queue whose width is decided by a widget is
    // a queue with two widths the moment a second widget appears.
    //
    // ## What is deliberately pure
    //
    // `queueReduce` is a transition over a plain object: no clock, no DOM, no
    // translation, no `fetch`. That is what lets tests lift this slice out of
    // the shipped file and drive real actions through it. The driver below owns
    // the clock and the side effects, and must never grow a second copy of a
    // rule — the two rules above exist once, in `queueDrain`.
    //
    // ## What the progress UI may claim
    //
    // A percentage appears only when the total is known: an upload knows the
    // local file's size, a single-file download carries `content-length`, and a
    // directory archive does not know its own total until the tree has been
    // read. The archive row reports bytes received and NO percentage. That is
    // `transferNotice`'s honesty rule applied to a bar: a bar filled to an
    // invented percentage cannot be told apart from a stuck one.
    //
    // ## Cancellation
    //
    // Queued items are cancelled by leaving the queue. A running item sets a
    // flag its worker checks between chunks; the worker then sends the upload
    // route's `abort` request (which removes the staged part) before reporting
    // `cancelled`. The in-flight POST is not aborted with an AbortController on
    // purpose: the request may already have landed, and the staging file needs
    // a live connection to clean up. One extra chunk is the price of a cleanup
    // that does not depend on a race.

    // ---- selection state machine (pure: no DOM, no translation)
    /**
     * The ONE selection model, shared by the directory dialog and the sidebar
     * browser tab.
     *
     * Pure and DOM-free on purpose: the gesture rules are the interesting part,
     * and they are exactly what a component tends to re-invent (usually as
     * "click a row" plus three modifiers, which then disagrees between the two
     * surfaces). The reducer takes the visible rows and one action and answers
     * a complete next state plus, when a plain click landed on a directory, the
     * row the CALLER should navigate to.
     *
     * The rules, in the order they matter:
     * - plain click on a directory activates (enters) it and clears the
     *   selection; a modifier click on a directory NEVER activates it —
     *   selection outranks navigation whenever Ctrl/Cmd or Shift is held;
     * - plain click on a file selects only it AND leaves the caller's
     *   activation intact, because "click a file to look at it" is the panel's
     *   oldest gesture and must keep working;
     * - a right-click (`point`) never activates anything: it picks the row
     *   alone, unless that row is already part of the selection, which is kept;
     * - Ctrl/Cmd toggles one row and sets the anchor;
     * - Shift selects the range from the anchor to the row and does NOT move
     *   the anchor (that is what makes a second Shift-click widen from the same
     *   origin instead of from the row just reached);
     * - Ctrl/Cmd+Shift appends the range to the existing selection;
     * - keyboard moves the cursor; Ctrl+Arrow moves it without selecting;
     *   Shift+Arrow extends from the anchor; Home/End jump; Enter "opens" the
     *   cursor row (the caller decides what opening means).
     *
     * Selection identity is the row NAME: the dialog lists one directory at a
     * time, and the tab lists one directory at a time, so a name is unique in
     * the only scope the selection lives in. Navigation resets it — carrying
     * names across directories would silently include rows the user never saw.
     */
    const SELECTION_EMPTY = Object.freeze({ ids: Object.freeze([]), anchor: null, cursor: null, navigate: null })

    /** Clamp one row index, or -1 when there is no row to point at. */
    function selectionIndex (rows, index) {
      if (!Array.isArray(rows) || rows.length === 0) return -1
      const n = Number.isInteger(index) ? index : 0
      return Math.min(Math.max(0, n), rows.length - 1)
    }

    /** Every name in one inclusive range of visible rows. */
    function selectionRange (rows, from, to) {
      const a = selectionIndex(rows, from)
      const b = selectionIndex(rows, to)
      if (a < 0 || b < 0) return []
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      const ids = []
      for (let i = lo; i <= hi; i += 1) ids.push(rows[i].name)
      return ids
    }

    /** Toggle one name without mutating the previous list. */
    function selectionToggle (ids, name) {
      const next = ids.slice()
      const at = next.indexOf(name)
      if (at >= 0) next.splice(at, 1)
      else next.push(name)
      return next
    }

    /** Union while keeping the receiver's order (stable for tests and renders). */
    function selectionUnion (ids, extra) {
      const next = ids.slice()
      for (const name of extra) if (!next.includes(name)) next.push(name)
      return next
    }

    /**
     * Apply one selection action.
     *
     * @param {object} state - `{ids, anchor, cursor}`.
     * @param {object} action - `{type, rows, ...}`.
     * @returns {object} the next state, with `navigate` naming a row index or null.
     */
    function selectReduce (state, action) {
      const current = state === undefined || state === null ? SELECTION_EMPTY : state
      const ids = Array.isArray(current.ids) ? current.ids : []
      const rows = Array.isArray(action?.rows) ? action.rows : []
      const none = { ids, anchor: current.anchor ?? null, cursor: current.cursor ?? null, navigate: null }
      switch (action?.type) {
        case 'row': {
          const index = selectionIndex(rows, action.index)
          if (index < 0) return SELECTION_EMPTY
          const row = rows[index]
          const shift = action.shift === true
          const ctrl = action.ctrl === true
          if (shift) {
            // Shift never moves the anchor. Without an anchor there is no
            // origin to widen from, so the click selects the row it landed on
            // (or appends just that row) rather than inventing a range.
            const append = action.append === true || ctrl
            if (current.anchor === null || current.anchor === undefined) {
              // A Shift click with no anchor SEEDS one at the row it landed
              // on, instead of selecting that row and leaving the anchor empty.
              // Without the seed, "Shift+click A, then Shift+click B" never
              // grows into a range: the second click is still a first click,
              // so selecting a run of files needed an ordinary click first —
              // and on a file that ordinary click opens the preview.
              const one = [row.name]
              return {
                ids: append ? selectionUnion(ids, one) : one,
                anchor: index,
                cursor: index,
                navigate: null,
              }
            }
            const range = selectionRange(rows, current.anchor, index)
            return {
              ids: append ? selectionUnion(ids, range) : range,
              anchor: current.anchor,
              cursor: index,
              navigate: null,
            }
          }
          if (ctrl) {
            return {
              ids: selectionToggle(ids, row.name),
              anchor: index,
              cursor: index,
              navigate: null,
            }
          }
          if (row.isDir === true) {
            // Navigation wins only for a PLAIN click on a directory. Clear the
            // selection and the anchor, because the next directory is a new
            // set of rows.
            return { ids: [], anchor: null, cursor: index, navigate: index }
          }
          // A plain click on a file SELECTS it and still lets the platform's
          // own activation run: "click a file to look at it" is the panel's
          // oldest gesture, and taking it away to make room for a selection
          // model would trade one surprise for a worse one. `navigate` is
          // therefore "let this row's own handler fire", not only "enter this
          // directory" — the dialog ignores it for a file, the host tree opens
          // the preview.
          return { ids: [row.name], anchor: index, cursor: index, navigate: index }
        }
        case 'point': {
          // A RIGHT-click: never activates anything, and follows the same
          // collapse rule every file manager uses — a row outside the current
          // selection becomes the whole selection, a row inside it keeps the
          // batch. Ctrl/Cmd toggles that one row, Shift extends from the
          // anchor, so the mouse's secondary button is not a second dialect.
          const index = selectionIndex(rows, action.index)
          if (index < 0) return none
          const row = rows[index]
          const shift = action.shift === true
          const ctrl = action.ctrl === true
          if (shift) {
            const append = action.append === true || ctrl
            if (current.anchor === null || current.anchor === undefined) {
              // A Shift click with no anchor SEEDS one at the row it landed
              // on, instead of selecting that row and leaving the anchor empty.
              // Without the seed, "Shift+click A, then Shift+click B" never
              // grows into a range: the second click is still a first click,
              // so selecting a run of files needed an ordinary click first —
              // and on a file that ordinary click opens the preview.
              const one = [row.name]
              return {
                ids: append ? selectionUnion(ids, one) : one,
                anchor: index,
                cursor: index,
                navigate: null,
              }
            }
            const range = selectionRange(rows, current.anchor, index)
            return {
              ids: append ? selectionUnion(ids, range) : range,
              anchor: current.anchor,
              cursor: index,
              navigate: null,
            }
          }
          if (ctrl) {
            return {
              ids: selectionToggle(ids, row.name),
              anchor: index,
              cursor: index,
              navigate: null,
            }
          }
          if (ids.includes(row.name)) {
            // Right-clicking INSIDE the selection keeps it, so the batch verb
            // in the menu still addresses every row the user picked.
            return { ids, anchor: current.anchor ?? index, cursor: index, navigate: null }
          }
          return { ids: [row.name], anchor: index, cursor: index, navigate: null }
        }
        case 'blank':
          return SELECTION_EMPTY
        case 'escape':
          // The cursor stays: Escape cancels a selection, it does not move the
          // keyboard focus the user was using.
          return { ids: [], anchor: null, cursor: current.cursor ?? null, navigate: null }
        case 'selectAll':
          if (rows.length === 0) return SELECTION_EMPTY
          return { ids: rows.map(row => row.name), anchor: 0, cursor: rows.length - 1, navigate: null }
        case 'move': {
          if (rows.length === 0) return SELECTION_EMPTY
          const base = current.cursor ?? (action.delta > 0 ? -1 : rows.length)
          const next = selectionIndex(rows, base + (action.delta ?? 0))
          const focusOnly = action.focusOnly === true
          const extend = action.extend === true
          if (focusOnly) {
            // Ctrl+Arrow moves the cursor and changes nothing else.
            return { ids, anchor: current.anchor ?? null, cursor: next, navigate: null }
          }
          if (extend) {
            if (current.anchor === null || current.anchor === undefined) {
              // Same seeding rule as the pointer gestures: the first extending
              // keypress establishes the origin it extends from next time.
              return { ids: [rows[next].name], anchor: next, cursor: next, navigate: null }
            }
            return {
              ids: selectionRange(rows, current.anchor, next),
              anchor: current.anchor,
              cursor: next,
              navigate: null,
            }
          }
          return { ids: [rows[next].name], anchor: next, cursor: next, navigate: null }
        }
        case 'to': {
          if (rows.length === 0) return SELECTION_EMPTY
          const target = action.end === true ? rows.length - 1 : 0
          const extend = action.extend === true
          const focusOnly = action.focusOnly === true
          if (focusOnly) return { ids, anchor: current.anchor ?? null, cursor: target, navigate: null }
          if (extend) {
            const origin = current.anchor ?? current.cursor ?? target
            // Seed the anchor at the resolved origin, so a first Shift+Home /
            // Shift+End followed by another extending press grows from here
            // rather than starting over.
            return { ids: selectionRange(rows, origin, target), anchor: origin, cursor: target, navigate: null }
          }
          return { ids: [rows[target].name], anchor: target, cursor: target, navigate: null }
        }
        case 'open': {
          const cursor = selectionIndex(rows, current.cursor)
          if (cursor < 0) return none
          return { ids, anchor: current.anchor ?? null, cursor, navigate: cursor }
        }
        default:
          return none
      }
    }

    // ---- queue state machine (pure: no clock, no DOM, no translation)

    /** How many transfers may run at once, across every host. */
    const TRANSFER_QUEUE_LIMIT_TOTAL = 2

    /** How many transfers may run at once against ONE host. */
    const TRANSFER_QUEUE_LIMIT_PER_HOST = 1

    // Mirrors `DEFAULT_MAX_BYTES` in lib/transfer.js. This bundle cannot import
    // a Node module, so the number is restated — and `client-shape-smoke`
    // asserts the two agree, so a drift turns red here instead of surfacing as
    // a 413 after the last chunk of a file the picker should have refused.
    const TRANSFER_QUEUE_UPLOAD_LIMIT = 1024 * 1024 * 1024

    /**
     * The shortest interval two byte samples may span to become a rate.
     *
     * The progress reporter already throttles to one percent or 200 ms, so a
     * real pair is usually farther apart than this floor; a shorter pair (a
     * fast link) is folded into the next window instead of dividing by a
     * handful of milliseconds and printing a spike.
     */
    const TRANSFER_QUEUE_SPEED_MIN_WINDOW = 250

    /**
     * A gap longer than this is a stall, not a slow transfer.
     *
     * Averaging across the pause would report the pause as the rate, so the
     * measurement restarts and the row stops claiming a speed until bytes move
     * again. A number that decays to "0 B/s" on its own would be just as
     * misleading as the stale one it replaced.
     */
    const TRANSFER_QUEUE_SPEED_RESET_GAP = 5000

    /** How much of the newest sample the smoothed rate adopts (0..1). */
    const TRANSFER_QUEUE_SPEED_SMOOTHING = 0.4

    /** The statuses from which an item never moves again. */
    const TRANSFER_QUEUE_TERMINAL = ['done', 'failed', 'cancelled']

    /** Whether an item has settled. */
    function transferQueueIsTerminal (status) {
      return TRANSFER_QUEUE_TERMINAL.includes(status)
    }

    /**
     * Shorten a filename for a row, by CODEPOINT rather than by UTF-16 unit.
     *
     * `String.prototype.slice` would cut a surrogate pair in half and render a
     * replacement glyph; a name is user data, and displaying a different name
     * (or a broken one) in the very row that reports which file moved is a
     * defect, not cosmetics.
     *
     * @param {string} name - the remote or local name.
     * @param {number} [limit] - maximum code points.
     * @returns {string} the name, shortened with an ellipsis when needed.
     */
    function truncateTransferName (name, limit = 40) {
      const text = typeof name === 'string' ? name : String(name ?? '')
      const max = Math.max(0, Math.floor(Number(limit) || 0))
      if (max <= 0) return ''
      const points = Array.from(text)
      if (points.length <= max) return text
      if (max === 1) return '…'
      return `${points.slice(0, max - 1).join('')}…`
    }

    /**
     * Split picked files into what may be sent and what exceeds the limit.
     *
     * The point is to answer ONCE, before a byte is staged: a batch that lets
     * one oversized member fail after the other nine succeeded reports the
     * wrong total and spends the queue's turn on a doomed request. The caller
     * shows the list, so nothing is silently dropped.
     *
     * @param {File[]} files - what the picker returned.
     * @param {number} [limit] - the per-file ceiling.
     * @returns {{accepted: File[], rejected: File[]}} the split, in order.
     */
    function splitOversizeFiles (files, limit = TRANSFER_QUEUE_UPLOAD_LIMIT) {
      const accepted = []
      const rejected = []
      for (const file of Array.isArray(files) ? files : []) {
        if (file === null || file === undefined) continue
        const size = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : null
        // An unknown size is not a reason to refuse: a File always has one, and
        // the route still enforces the same ceiling on the bytes it receives.
        if (size !== null && size > limit) rejected.push(file)
        else accepted.push(file)
      }
      return { accepted, rejected }
    }

    /**
     * Percentage 0..100 for a known total, or null when the total is unknown.
     *
     * Null is the honest answer for an archive: it is not 0%, and drawing an
     * empty bar would assert "nothing has arrived" for a stream that is already
     * moving.
     */
    function queueItemPercent (item) {
      if (item === null || typeof item !== 'object') return null
      const total = typeof item.bytesTotal === 'number' && Number.isFinite(item.bytesTotal) ? item.bytesTotal : null
      if (total === null || total <= 0) return null
      const done = typeof item.bytesDone === 'number' && Number.isFinite(item.bytesDone) ? item.bytesDone : 0
      return Math.max(0, Math.min(100, Math.floor((done / total) * 100)))
    }

    /**
     * The queue item currently transferring one download target.
     *
     * Identity is `alias` + `remotePath`, both carried by every download job:
     * that lets a listing row show the progress of ITS transfer while the queue
     * holds several, from different hosts. Matching by display name would
     * confuse two hosts that both have `src/`, which is the ordinary case here.
     *
     * The LAST matching item wins: a retried transfer is appended after the
     * stale one, and the newest intent is the one a row should reflect.
     */
    function downloadQueueItemFor (queue, alias, remotePath) {
      if (queue === null || typeof queue !== 'object' || !Array.isArray(queue.items)) return null
      for (let index = queue.items.length - 1; index >= 0; index -= 1) {
        const item = queue.items[index]
        if (item === null || typeof item !== 'object') continue
        if (item.direction !== 'download' || item.alias !== alias || item.remotePath !== remotePath) continue
        if (item.status !== 'running' && item.status !== 'queued') continue
        return item
      }
      return null
    }

    /**
     * Fold one byte sample into an item's rate estimate.
     *
     * Pure and clockless — the clock arrives in `at` — so the same action
     * sequence replays identically in a test, and the number a row prints is
     * the number the machine stored rather than a value a component guessed
     * from two frames of a bar it is animating.
     *
     * The first sample is a BASELINE, not an interval: it records where the
     * stream is, and the rate starts with the next window. That is also why a
     * fresh row shows bytes but no speed for a moment — claiming "0 B/s" on
     * the first frame reads as stalled.
     *
     * @param {object} item - the previous item (its `speed` is the smoothing input).
     * @param {number} done - the byte count this report establishes.
     * @param {number} at - the action clock, in milliseconds.
     * @returns {{speed: number|null, measuredAt: number|null, measuredBytes: number}} the fields to store.
     */
    function transferQueueNextSpeed (item, done, at) {
      const measuredAt = typeof item.measuredAt === 'number' && Number.isFinite(item.measuredAt)
        ? item.measuredAt
        : null
      const measuredBytes = typeof item.measuredBytes === 'number' && Number.isFinite(item.measuredBytes)
        ? item.measuredBytes
        : 0
      if (measuredAt === null) {
        return { speed: null, measuredAt: at, measuredBytes: done }
      }
      const elapsed = at - measuredAt
      if (elapsed < TRANSFER_QUEUE_SPEED_MIN_WINDOW) {
        // Too close to divide the bytes by: keep the last rate AND the
        // baseline, so the eventual window covers everything since it began.
        return {
          speed: typeof item.speed === 'number' && Number.isFinite(item.speed) ? item.speed : null,
          measuredAt,
          measuredBytes,
        }
      }
      if (elapsed > TRANSFER_QUEUE_SPEED_RESET_GAP) {
        return { speed: null, measuredAt: at, measuredBytes: done }
      }
      const instant = ((done - measuredBytes) * 1000) / elapsed
      const previous = typeof item.speed === 'number' && Number.isFinite(item.speed) ? item.speed : null
      const smoothed = previous === null
        ? instant
        : previous * (1 - TRANSFER_QUEUE_SPEED_SMOOTHING) + instant * TRANSFER_QUEUE_SPEED_SMOOTHING
      return { speed: Math.max(0, Math.round(smoothed)), measuredAt: at, measuredBytes: done }
    }

    /** How many items are still moving (queued or running). */
    function transferQueueActiveCount (items) {
      return (Array.isArray(items) ? items : []).filter(item => !transferQueueIsTerminal(item?.status)).length
    }

    /**
     * One reading of the queue for the header entry.
     *
     * `percent` is weighted by BYTES, not averaged across items: a 10 MB file
     * and a 1 KB file must not move the ring by the same amount. Null means at
     * least one running transfer has no total (an archive), so the ring sweeps
     * rather than states a distance the browser cannot know. Nothing running
     * but something queued is 0 — blue and waiting is a state; idle is not.
     *
     * `direction` picks the mark for the running work; with nothing moving it
     * stays on the download mark, the verb this entry overwhelmingly reports.
     *
     * @param {Array<object>} items - the queue's items.
     * @returns {{active: number, percent: number|null, live: boolean, direction: 'download'|'upload'}} the entry's state.
     */
    function transferQueueProgress (items) {
      const list = Array.isArray(items) ? items : []
      const running = []
      let active = 0
      let downloads = 0
      let uploads = 0
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue
        // Every queue entry carries a status; an object without one is not a
        // transfer (a malformed snapshot must not hold the entry blue).
        if (typeof item.status !== 'string') continue
        if (!transferQueueIsTerminal(item.status)) active += 1
        if (item.status !== 'running') continue
        running.push(item)
        if (item.direction === 'upload') uploads += 1
        else downloads += 1
      }
      let percent = null
      let live = false
      if (running.length > 0) {
        let done = 0
        let total = 0
        let known = true
        for (const item of running) {
          if (queueItemPercent(item) === null) {
            known = false
            break
          }
          done += typeof item.bytesDone === 'number' && Number.isFinite(item.bytesDone) ? item.bytesDone : 0
          total += item.bytesTotal
        }
        if (known && total > 0) {
          percent = Math.max(0, Math.min(100, Math.floor((done / total) * 100)))
        } else {
          live = true
        }
      } else if (active > 0) {
        percent = 0
      }
      return { active, percent, live, direction: uploads > downloads ? 'upload' : 'download' }
    }

    /**
     * The order the queue list paints: live entries first, settled ones below.
     *
     * The store keeps arrival order because that is the execution order — a
     * queued item must start before the one behind it. But arrival order is a
     * BAD reading order: rendered as-is, a new download is appended to the
     * bottom of a list that never auto-clears, and a panel with a few finished
     * transfers hides it below the fold. The user then reports "the download
     * never appeared in the queue" while the row exists all along.
     *
     * So the DISPLAY is reordered, not the store: everything still moving stays
     * in arrival order at the top (the first row is the next thing to happen),
     * and everything settled is newest-first below, so the transfer that just
     * finished is the first historical row rather than the last one off-screen.
     *
     * @param {object[]} items - the queue store's items.
     * @returns {object[]} the same items in reading order.
     */
    function orderedTransferQueueItems (items) {
      if (!Array.isArray(items)) return []
      const live = []
      const settled = []
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue
        if (transferQueueIsTerminal(item.status)) settled.push(item)
        else live.push(item)
      }
      return live.concat(settled.reverse())
    }

    /**
     * Mark queued items running while capacity allows.
     *
     * The scan restarts at the FRONT every time, so a same-host item blocked by
     * a busy host cannot be overtaken by a later item for that same host (the
     * per-host rule is checked, not assumed), while an item for a FREE host
     * further back still starts — which is what the cross-host ceiling is for.
     * A cancelled-but-still-running item keeps its slot until its worker
     * acknowledges the stop; releasing it early would let the next transfer
     * collide with one still writing. The same rule covers a `pausing` item:
     * the slot is released only when the worker reports that it has stopped,
     * never when the user simply asked it to.
     */
    function queueDrain (items, at) {
      const perHost = new Map()
      let running = 0
      for (const item of items) {
        if (item.status !== 'running' && item.status !== 'pausing') continue
        running += 1
        perHost.set(item.alias, (perHost.get(item.alias) ?? 0) + 1)
      }
      let touched = false
      const next = items.slice()
      for (let index = 0; index < next.length && running < TRANSFER_QUEUE_LIMIT_TOTAL; index += 1) {
        const item = next[index]
        if (item.status !== 'queued' || item.cancelRequested === true) continue
        if ((perHost.get(item.alias) ?? 0) >= TRANSFER_QUEUE_LIMIT_PER_HOST) continue
        next[index] = {
          ...item,
          status: 'running',
          startedAt: at,
          // A queued wait is not transfer time: the rate begins at the first
          // byte, not at the moment this item got its host slot.
          speed: null,
          measuredAt: null,
          measuredBytes: 0,
        }
        running += 1
        perHost.set(item.alias, (perHost.get(item.alias) ?? 0) + 1)
        touched = true
      }
      return touched ? next : items
    }

    /**
     * One transition. `action.at` is the clock, supplied by the driver, so the
     * same action sequence replays identically in a test.
     *
     * Returns the SAME state object when an action changes nothing, so a
     * subscriber is not woken by a late progress report or a duplicate cancel.
     *
     * @param {{items: object[]}} state - the current store.
     * @param {object} action - the event.
     * @returns {{items: object[]}} the next store.
     */
    function queueReduce (state, action) {
      const current = state !== null && typeof state === 'object' && Array.isArray(state.items)
        ? state
        : { items: [] }
      const at = typeof action?.at === 'number' ? action.at : 0
      const indexOf = (id) => current.items.findIndex(item => item.id === id)
      switch (action?.type) {
        case 'enqueue': {
          const incoming = Array.isArray(action.items) ? action.items : []
          if (incoming.length === 0) return state
          const added = incoming.map(item => ({
            ...item,
            status: 'queued',
            bytesDone: 0,
            bytesTotal: typeof item.bytesTotal === 'number' && Number.isFinite(item.bytesTotal)
              ? Math.max(0, item.bytesTotal)
              : null,
            cancelRequested: false,
            pauseRequested: false,
            // Set by resume: the staged prefix must be probed even though this
            // is still the item's first attempt.
            resumed: false,
            // Retry count, not a boolean: the first attempt and a resumed
            // attempt ask the route for different work (probe / verify).
            attempts: Number.isInteger(item.attempts) && item.attempts > 0 ? item.attempts : 0,
            error: null,
            note: null,
            speed: null,
            measuredAt: null,
            measuredBytes: 0,
            createdAt: at,
            startedAt: null,
            finishedAt: null,
          }))
          return { ...current, items: queueDrain(current.items.concat(added), at) }
        }
        case 'total': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (transferQueueIsTerminal(item.status)) return state
          const total = Number(action.bytesTotal)
          if (!Number.isFinite(total) || total <= 0) return state
          if (item.bytesTotal === total) return state
          const items = current.items.slice()
          items[index] = { ...item, bytesTotal: total, bytesDone: Math.min(item.bytesDone, total) }
          return { ...current, items }
        }
        case 'progress': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (item.status !== 'running') return state
          const bytes = Number(action.bytesDone)
          if (!Number.isFinite(bytes) || bytes <= item.bytesDone) return state
          const capped = item.bytesTotal === null ? bytes : Math.min(bytes, item.bytesTotal)
          if (capped <= item.bytesDone) return state
          const items = current.items.slice()
          const sample = transferQueueNextSpeed(item, capped, at)
          items[index] = { ...item, bytesDone: capped, ...sample }
          return { ...current, items }
        }
        case 'settle': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          // A worker that already finished when the user pressed pause is
          // allowed to report its outcome: the bytes are on disk, so calling
          // that paused would be a lie the next resume could not repair.
          if (item.status !== 'running' && item.status !== 'pausing') return state
          const done = action.status === 'done'
          // A cancellation that arrived before the worker noticed does not
          // rewrite a truth: if the bytes did land, the item is done. The other
          // outcomes honour the request.
          const status = done ? 'done' : item.cancelRequested === true ? 'cancelled' : 'failed'
          const bytes = Number(action.bytes)
          const items = current.items.slice()
          items[index] = {
            ...item,
            status,
            cancelRequested: false,
            pauseRequested: false,
            // A settled row reports bytes, not a rate: a final "0 B/s" would
            // read as a stall right where the transfer actually ended.
            speed: null,
            bytesDone: Number.isFinite(bytes) && bytes > item.bytesDone
              ? (item.bytesTotal === null ? bytes : Math.min(bytes, item.bytesTotal))
              : item.bytesDone,
            error: status === 'failed' ? String(action.error ?? '') : null,
            note: done && typeof action.note === 'string' ? action.note : null,
            // Only the anchor path sets this: the browser owns the save, so a
            // batch must not summarise those bytes as "transferred".
            started: done && action.started === true,
            finishedAt: at,
          }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'cancel': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (transferQueueIsTerminal(item.status)) return state
          const items = current.items.slice()
          if (item.status === 'queued' || item.status === 'paused') {
            items[index] = { ...item, status: 'cancelled', finishedAt: at, cancelRequested: false, pauseRequested: false }
            return { ...current, items: queueDrain(items, at) }
          }
          if (item.cancelRequested === true) return state
          items[index] = { ...item, cancelRequested: true }
          return { ...current, items }
        }
        case 'cancelled': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (transferQueueIsTerminal(item.status)) return state
          const items = current.items.slice()
          items[index] = { ...item, status: 'cancelled', cancelRequested: false, speed: null, finishedAt: at }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'pause': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (transferQueueIsTerminal(item.status)) return state
          const items = current.items.slice()
          // A queued item never grabbed a slot, so it is paused at once. A
          // running one keeps its slot until the worker acknowledges: the
          // write in flight is still writing, and starting the next transfer
          // beside it is exactly what the per-host limit exists to stop.
          if (item.status === 'queued') {
            items[index] = { ...item, status: 'paused', finishedAt: null }
            return { ...current, items }
          }
          if (item.status === 'running') {
            items[index] = { ...item, status: 'pausing', pauseRequested: true, speed: null }
            return { ...current, items }
          }
          return state
        }
        case 'pauseAck': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (item.status !== 'pausing') return state
          const items = current.items.slice()
          items[index] = { ...item, status: 'paused', pauseRequested: false, speed: null, finishedAt: null }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'resume': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (item.status !== 'paused') return state
          const items = current.items.slice()
          // createdAt is deliberately untouched: the drain scans from the
          // front, so an item paused early resumes ahead of one queued later.
          items[index] = {
            ...item,
            status: 'queued',
            cancelRequested: false,
            pauseRequested: false,
            resumed: true,
            speed: null,
            measuredAt: null,
            measuredBytes: 0,
            finishedAt: null,
          }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'retry': {
          const index = indexOf(action.id)
          if (index < 0) return state
          const item = current.items[index]
          if (item.status !== 'failed') return state
          const items = current.items.slice()
          items[index] = {
            ...item,
            status: 'queued',
            // The attempt number is what tells the transport to probe the
            // staged prefix and verify the source at the end.
            attempts: (Number.isInteger(item.attempts) ? item.attempts : 0) + 1,
            bytesDone: 0,
            error: null,
            note: null,
            started: false,
            speed: null,
            measuredAt: null,
            measuredBytes: 0,
            cancelRequested: false,
            pauseRequested: false,
            resumed: false,
            finishedAt: null,
          }
          return { ...current, items: queueDrain(items, at) }
        }
        case 'clear': {
          const items = current.items.filter(item => !transferQueueIsTerminal(item.status))
          if (items.length === current.items.length) return state
          return { ...current, items }
        }
        default:
          return state
      }
    }

    // ---- queue runtime (clock, workers, notices, subscriptions)

    /** The one store. Replaced wholesale, so a snapshot reference is stable. */
    let transferQueueState = { items: [] }
    let transferQueueSeq = 0
    const transferQueueListeners = new Set()
    /** id -> the live handle the UI uses to ask a worker to stop. */
    const transferQueueWorkers = new Map()
    /** The live toast for the current batch, if one is on screen. */
    let transferQueueNotice = null
    /** Upload success re-lists DSH's panel, at most this often. */
    let transferQueueRefreshTimer = null

    /** Current store, for `useSyncExternalStore`. */
    function transferQueueSnapshot () {
      return transferQueueState
    }

    /**
     * Subscribe to queue changes.
     *
     * @param {() => void} listener - called after every store change.
     * @returns {() => void} unsubscribe.
     */
    function subscribeTransferQueue (listener) {
      if (typeof listener !== 'function') return () => {}
      transferQueueListeners.add(listener)
      return () => { transferQueueListeners.delete(listener) }
    }

    /** The React seat: one snapshot, one subscription, no local counters. */
    function useTransferQueue () {
      return React.useSyncExternalStore(subscribeTransferQueue, transferQueueSnapshot, transferQueueSnapshot)
    }

    function transferQueueEmit (next) {
      if (next === transferQueueState) return
      transferQueueState = next
      for (const listener of transferQueueListeners) {
        try { listener() } catch { /* a subscriber must not break the queue */ }
      }
      syncTransferQueueNotice()
    }

    function transferQueueDispatch (action) {
      transferQueueEmit(queueReduce(transferQueueState, action))
      pumpTransferQueue()
    }

    function nextTransferId () {
      transferQueueSeq += 1
      return `transfer-${transferQueueSeq}`
    }

    /** The opening sentence for one item. */
    function transferQueueOpeningText (item) {
      if (item.direction === 'upload') return translate('transfer.uploadingName', { name: item.name })
      if (item.isDir === true) return translate('transfer.dirDownloading', { name: item.name })
      return translate('transfer.downloading', { name: item.name })
    }

    /** The failure sentence for one item: the direction names the verb. */
    function transferQueueFailureText (item) {
      const prefix = item.direction === 'upload' ? translate('transfer.uploadFail') : translate('transfer.downloadFail')
      return item.error === null || item.error === undefined || item.error === ''
        ? prefix
        : `${prefix}: ${item.error}`
    }

    /**
     * The closing sentence for a finished batch.
     *
     * A single item keeps the sentence the single-transfer surfaces used, so a
     * one-file upload reads the same as it did before the queue existed. A
     * batch is merged into ONE sentence — a toast per file would reset each
     * other's dismissal clock, and the result most worth reading would be the
     * one that vanished first.
     */
    function transferQueueSummary (tracked) {
      const done = tracked.filter(item => item.status === 'done')
      const failed = tracked.filter(item => item.status === 'failed')
      const cancelled = tracked.filter(item => item.status === 'cancelled')
      if (tracked.length === 1) {
        const item = tracked[0]
        if (item.status === 'done') {
          return { line: typeof item.note === 'string' && item.note !== '' ? item.note : transferQueueOpeningText(item), kind: 'ok' }
        }
        if (item.status === 'failed') {
          return {
            line: transferQueueFailureText(item),
            kind: 'err',
            code: item.direction === 'upload' ? 'SSHWSP-E-TRANSFER-UPLOAD' : 'SSHWSP-E-TRANSFER-DOWNLOAD',
            detail: item.error,
          }
        }
        return { line: translate('queue.summaryCancelledOnly', { count: 1 }), kind: 'ok' }
      }
      const bytes = tracked.reduce((sum, item) => sum + (Number.isFinite(item.bytesDone) ? item.bytesDone : 0), 0)
      if (failed.length > 0) {
        return {
          line: cancelled.length > 0
            ? translate('queue.summaryPartialCancel', { done: done.length, failed: failed.length, cancelled: cancelled.length })
            : translate('queue.summaryPartial', { done: done.length, failed: failed.length }),
          kind: 'err',
          code: 'SSHWSP-E-TRANSFER-BATCH',
          detail: failed.map(item => ({ name: item.name, error: item.error })),
        }
      }
      if (cancelled.length > 0) {
        return { line: translate('queue.summaryCancelled', { done: done.length, cancelled: cancelled.length }), kind: 'ok' }
      }
      // Any anchor-path item means the page handed bytes over but cannot see
      // whether they were saved. A batch that included one cannot claim the
      // rest were "transferred" either.
      if (done.some(item => item.started === true)) {
        return { line: translate('queue.summaryStarted', { count: done.length }), kind: 'ok' }
      }
      return { line: translate('queue.summaryDone', { count: done.length, size: formatBytes(bytes) }), kind: 'ok' }
    }

    /** Start (or extend) the one toast for the current batch. */
    function openTransferQueueNotice (items, opening, note) {
      const first = items[0]
      const tail = typeof note === 'string' ? note : ''
      if (transferQueueNotice !== null) {
        for (const item of items) transferQueueNotice.ids.add(item.id)
        // A second enqueue while the batch is still running adds its own note
        // instead of replacing the earlier one: both refer to the same gesture
        // and the result sentence is the only place either of them is read.
        if (tail !== '') {
          transferQueueNotice.note = transferQueueNotice.note === ''
            ? tail
            : `${transferQueueNotice.note} · ${tail}`
        }
        return
      }
      // `opening` is the caller's own sentence when the count has a subject:
      // "已加入队列 3 项" says which verb accepted them, where the generic queue
      // line would leave the reader to work that out from the rows below.
      const line = typeof opening === 'string' && opening !== ''
        ? opening
        : items.length === 1
          ? transferQueueOpeningText(first)
          : translate('transfer.batchQueued', { count: items.length })
      transferQueueNotice = { handle: transferNotice(line), ids: new Set(items.map(item => item.id)), line, note: tail }
    }

    /** Rewrite the batch toast while it is running; turn it into the result. */
    function syncTransferQueueNotice () {
      const notice = transferQueueNotice
      if (notice === null) return
      const tracked = transferQueueState.items.filter(item => notice.ids.has(item.id))
      const active = tracked.filter(item => !transferQueueIsTerminal(item.status))
      if (active.length > 0) {
        const line = tracked.length === 1 ? transferQueueOpeningText(tracked[0]) : translate('transfer.batchQueued', { count: active.length })
        if (line !== notice.line) {
          notice.line = line
          notice.handle.text(line)
        }
        return
      }
      transferQueueNotice = null
      const summary = transferQueueSummary(tracked)
      // The refusal that rode in on the same gesture is part of the result, not
      // a toast of its own: the batch sentence is what stays on screen.
      notice.handle.done({
        kind: summary.kind,
        text: notice.note === '' ? summary.line : `${summary.line} · ${notice.note}`,
        code: summary.code,
        detail: summary.detail,
      }, summary.kind)
    }

    /**
     * Queue items and start whatever fits.
     *
     * The notice opens BEFORE the dispatch so the first state change already
     * has a node to rewrite; the driver then flips it to the result when the
     * last tracked item settles.
     *
     * @param {object[]} items - queue items; each needs `run(ctx)`.
     * @param {string} [opening] - the caller's own opening sentence.
     * @param {string} [note] - a sentence appended to the batch result.
     * @returns {string[]} the ids, in order.
     */
    function enqueueTransferItems (items, opening, note) {
      if (!Array.isArray(items) || items.length === 0) return []
      const prepared = items.map(item => ({ ...item, id: nextTransferId() }))
      openTransferQueueNotice(prepared, opening, note)
      transferQueueDispatch({ type: 'enqueue', items: prepared, at: Date.now() })
      return prepared.map(item => item.id)
    }

    /**
     * Start every running item that has no worker yet.
     *
     * A worker is tracked by id rather than by promise chaining so `cancel` can
     * reach the one transfer it names — and removed as soon as it settles, so a
     * later dispatch cannot start it twice.
     */
    function pumpTransferQueue () {
      for (const item of transferQueueState.items) {
        if (item.status !== 'running' || transferQueueWorkers.has(item.id)) continue
        if (typeof item.run !== 'function') continue
        // A cancellation recorded before this worker got its first turn is
        // still a cancellation: start it already flagged, so the first chunk
        // check stops an upload the user retired while it was queued.
        const worker = { cancelRequested: item.cancelRequested === true, pauseRequested: false }
        transferQueueWorkers.set(item.id, worker)
        const ctx = {
          isCancelled: () => worker.cancelRequested,
          isPaused: () => worker.pauseRequested,
          resume: item.resumed === true,
          // A retry is not the first attempt: the transport probes the staged
          // prefix and asks the host to verify the source hash at the end.
          attempts: Number.isInteger(item.attempts) && item.attempts > 0 ? item.attempts : 0,
          progress: makeTransferProgressReporter(item.id),
          setTotal: (bytesTotal) => transferQueueDispatch({ type: 'total', id: item.id, bytesTotal, at: Date.now() }),
        }
        Promise.resolve()
          .then(() => item.run(ctx))
          .then((result) => {
            transferQueueWorkers.delete(item.id)
            transferQueueDispatch({ type: 'settle', id: item.id, status: 'done', bytes: result?.bytes, note: result?.note, started: result?.started === true, at: Date.now() })
          })
          .catch((err) => {
            transferQueueWorkers.delete(item.id)
            if (err?.cancelled === true) {
              transferQueueDispatch({ type: 'cancelled', id: item.id, at: Date.now() })
              return
            }
            if (err?.paused === true) {
              // The worker stopped between chunks and left the staged part in
              // place. A cancel that arrived while it was pausing wins: the
              // chunk sender already sent the abort in that case.
              if (worker.cancelRequested) {
                transferQueueDispatch({ type: 'cancelled', id: item.id, at: Date.now() })
                return
              }
              transferQueueDispatch({ type: 'pauseAck', id: item.id, at: Date.now() })
              return
            }
            const message = err instanceof Error ? err.message : String(err)
            transferQueueDispatch({ type: 'settle', id: item.id, status: 'failed', error: message, at: Date.now() })
          })
      }
    }

    /**
     * Throttle progress reports to the store.
     *
     * A streaming read produces a chunk every few kilobytes; dispatching all of
     * them would re-render the overlay dozens of times a second for a number
     * that changes by one pixel. One percent of a known total (with a 64 KiB
     * floor) or 200 ms is enough for a bar and a byte count.
     */
    function makeTransferProgressReporter (id) {
      let lastBytes = 0
      let lastAt = 0
      return (bytesDone) => {
        if (!Number.isFinite(bytesDone)) return
        const now = Date.now()
        const item = transferQueueState.items.find(entry => entry.id === id)
        if (item === undefined) return
        const total = typeof item.bytesTotal === 'number' && Number.isFinite(item.bytesTotal) ? item.bytesTotal : null
        const step = total === null || total <= 0 ? 256 * 1024 : Math.max(total / 100, 64 * 1024)
        if (bytesDone - lastBytes < step && now - lastAt < 200) return
        lastBytes = bytesDone
        lastAt = now
        transferQueueDispatch({ type: 'progress', id, bytesDone, at: now })
      }
    }

    /**
     * Ask one item to stop.
     *
     * A queued item is cancelled immediately. A running item is flagged, and
     * its worker sends the upload route's abort request before reporting the
     * cancellation — so a cancelled upload does not leave a `.dsh-up-*` part
     * beside the user's directory.
     */
    function cancelTransferQueueItem (id) {
      const item = transferQueueState.items.find(entry => entry.id === id)
      if (item === undefined || transferQueueIsTerminal(item.status)) return
      if (item.status === 'running' || item.status === 'pausing') {
        const worker = transferQueueWorkers.get(id)
        if (worker !== undefined) worker.cancelRequested = true
      }
      // A paused upload has no live worker to send the abort, and its staged
      // part is still on the host. Remove it here so cancelling a paused row
      // does not leave a .dsh-up-* file behind.
      if (item.status === 'paused' && item.direction === 'upload' && typeof item.uploadId === 'string') {
        void postUploadChunk({
          alias: item.alias,
          path: typeof item.dir === 'string' ? item.dir : '',
          name: item.name,
          uploadId: item.uploadId,
          offset: 0,
          data: '',
          final: false,
          abort: true,
        }).catch(() => { /* best effort, like a cancelled worker */ })
      }
      transferQueueDispatch({ type: 'cancel', id, at: Date.now() })
    }

    /**
     * Ask a running item to stop at the next chunk boundary.
     *
     * A queued item pauses immediately; a running one is only flagged here and
     * releases its slot when its worker acknowledges, so a paused row is not
     * reported before the write in flight has actually stopped.
     */
    function pauseTransferQueueItem (id) {
      const item = transferQueueState.items.find(entry => entry.id === id)
      if (item === undefined || transferQueueIsTerminal(item.status) || item.status === 'paused' || item.status === 'pausing') return
      if (item.status === 'running') {
        const worker = transferQueueWorkers.get(id)
        if (worker !== undefined) worker.pauseRequested = true
      }
      transferQueueDispatch({ type: 'pause', id, at: Date.now() })
    }

    /** Put a paused item back in the queue, in its original arrival order. */
    function resumeTransferQueueItem (id) {
      transferQueueDispatch({ type: 'resume', id, at: Date.now() })
    }

    /** Queue a failed item again; the retry re-runs the conflict decision. */
    function retryTransferQueueItem (id) {
      transferQueueDispatch({ type: 'retry', id, at: Date.now() })
    }

    /** Drop every settled item; running ones stay. */
    function clearFinishedTransfers () {
      transferQueueDispatch({ type: 'clear', at: Date.now() })
    }

    // ---- uploads

    /**
     * Queue local files into one remote directory.
     *
     * Returns the split instead of showing a refusal itself: the dialog renders
     * it inline next to its other upload errors, while the file panel and the
     * tree row have no such surface and use `notifyUser`. Computing the split in
     * one place is what keeps the two from disagreeing about which file was
     * refused.
     *
     * @param {string} alias - host alias.
     * @param {string} dir - remote directory.
     * @param {File[]} files - picked files, any number.
     * @param {string} [note] - a sentence appended to the batch result.
     * @returns {{accepted: File[], rejected: File[]}} the split.
     */
    function enqueueUploads (alias, dir, files, note) {
      const split = splitOversizeFiles(files)
      if (split.accepted.length === 0) return split
      enqueueTransferItems(split.accepted.map(file => {
        // One id for the whole item, not one per attempt: the staged part is
        // named after it, so a pause and a retry can find the bytes already
        // sent. The identity is the source's own signature (size + mtime); the
        // host refuses a prefix written for a different file.
        const uploadId = randomHexId(32)
        const identity = `${Number(file.size) || 0}:${Math.trunc(Number(file.lastModified) || 0)}`
        return {
          direction: 'upload',
          alias,
          remotePath: dir === '/' ? `/${file.name}` : `${dir}/${file.name}`,
          name: file.name,
          dir,
          uploadId,
          identity,
          bytesTotal: typeof file.size === 'number' ? file.size : null,
          isDir: false,
          file,
          run: (ctx) => runUploadJob({ alias, dir, file, ctx, uploadId, identity }),
        }
      }), undefined, note)
      return split
    }

    /** One upload, over the chunked transport that can report and stop. */
    async function runUploadJob ({ alias, dir, file, ctx, uploadId, identity }) {
      const startedAt = Date.now()
      try {
        const { parsed, restarted } = await postFileInChunks(alias, dir, file, {
          uploadId,
          identity,
          attempt: ctx.attempts,
          resume: ctx.resume === true,
          onProgress: (bytes) => ctx.progress(bytes),
          isCancelled: () => ctx.isCancelled(),
          isPaused: () => ctx.isPaused(),
        })
        // The SERVER's byte count, not the local file's: it is what actually
        // landed, so a short write cannot be reported as a full upload.
        const landed = typeof parsed?.bytes === 'number' && Number.isFinite(parsed.bytes) ? parsed.bytes : file.size
        nudgeFilesPanel()
        const verdict = transferVerificationNote(parsed)
        const base = translate('transfer.doneUpload', { name: file.name, size: formatBytes(landed) })
        // A retry that found a changed source restarted from zero; say so,
        // because the byte count alone would look like a normal upload.
        const restartNote = typeof restarted === 'string' && restarted !== ''
          ? translate('queue.restarted', { reason: restarted })
          : null
        const parts = [base, restartNote, verdict].filter(part => part !== null)
        return {
          bytes: landed,
          note: parts.join(' · '),
        }
      } catch (err) {
        if (err?.cancelled === true) {
          // The page-side streaming helpers only know "stop"; the queue knows
          // whether that stop was a pause or a cancel.
          if (ctx.isPaused() && !ctx.isCancelled()) throw transferPausedError()
          throw err
        }
        // A pause is a state change, not a failed transfer: wrapping it would
        // turn the acknowledgement into a failure row the resume button
        // cannot reach.
        if (err?.paused === true) throw err
        // A death on the wire is described by WHEN it died, not by the
        // browser's four words; a refusal the server answered is already a
        // sentence and passes through unchanged.
        throw new Error(describeNetworkError(err, startedAt))
      }
    }


    /** Ask DSH's file panel to re-read, coalescing a batch into one reload. */
    function nudgeFilesPanel () {
      if (transferQueueRefreshTimer !== null) return
      transferQueueRefreshTimer = setTimeout(() => {
        transferQueueRefreshTimer = null
        refreshFilesPanel()
      }, 500)
    }

    // ---- downloads

    /**
     * Queue one download.
     *
     * The destination was already chosen by the caller: the picker needs the
     * click's transient activation, and the first network await spends it.
     *
     * @param {object} job - alias / remotePath / suggestedName / isDir and the
     *   picked target (`{kind:'handle'}` or `{kind:'unsupported'}`).
     * @returns {string|undefined} the queue id.
     */
    function enqueueDownloadJob (job) {
      return enqueueDownloadJobs([job])[0]
    }

    /**
     * Queue several downloads into one chosen directory.
     *
     * One enqueue call for the whole batch, so the overlay shows every selected
     * row as queued at once instead of revealing them one frame at a time as
     * each predecessor settles.
     */
    function enqueueDownloadJobs (jobs, opening) {
      if (!Array.isArray(jobs) || jobs.length === 0) return []
      return enqueueTransferItems(jobs.map(job => ({
        direction: 'download',
        alias: job.alias,
        remotePath: job.remotePath,
        name: job.suggestedName,
        bytesTotal: null,
        isDir: job.isDir === true,
        run: (ctx) => runDownloadJob({ ...job, ctx }),
      })), opening)
    }

    /**
     * Queue several downloads that all land in ONE chosen folder.
     *
     * This is the whole point of the batch verb: the destination is asked for
     * once, at the gesture, and every item inherits it. Before this, a batch
     * with no File System Access API opened one save dialog PER FILE — ten
     * rows, ten dialogs, ten chances to cancel the wrong one — because the
     * per-file fallback was the only path the queue knew.
     *
     * @param {Array<{alias: string, remotePath: string, suggestedName: string, isDir: boolean}>} items
     * @param {{kind: 'handle', handle: object}|{kind: 'path', path: string}|{kind: 'unsupported'}} folder
     * @returns {string[]} the queue ids.
     */
    function enqueueDownloadsInto (items, folder, opening) {
      if (!Array.isArray(items) || items.length === 0) return []
      return enqueueDownloadJobs(items.map(item => ({
        alias: item.alias,
        remotePath: item.remotePath,
        suggestedName: item.suggestedName,
        isDir: item.isDir === true,
        // Exactly one of the three travels: the handle path writes through the
        // page, the path path writes on the host, and "unsupported" leaves the
        // per-item save dialog as the only honest fallback.
        folder: folder?.kind === 'handle' ? folder.handle : null,
        localDir: folder?.kind === 'path' ? folder.path : null,
        target: folder?.kind === 'handle' || folder?.kind === 'path' ? null : { kind: 'unsupported' },
      })), opening)
    }

    /**
     * One download: file or directory archive, into a handle or the browser's
     * own flow.
     *
     * The response's `content-length` is the only total a file download has;
     * `download-tree` deliberately sends none (the archive is produced as the
     * tree is read), so an archive reports bytes only.
     */
    async function runDownloadJob ({ alias, remotePath, suggestedName, isDir, target = null, folder = null, localDir = null, ctx }) {
      const startedAt = Date.now()
      try {
        // A plain local directory is the simplest destination there is: the
        // HOST writes the bytes, so nothing has to travel to the page and back,
        // and one chosen folder serves the whole batch. It is preferred over
        // the handle path because it is the only one that works in a browser
        // without the File System Access API.
        if (typeof localDir === 'string' && localDir !== '') {
          const localPath = joinLocalPath(localDir, suggestedName)
          const payload = {
            alias,
            direction: 'download',
            localPath,
            remotePath,
            // A directory row means "copy the whole folder here", which the
            // route now supports in both directions.
            ...(isDir ? { recursive: true } : {}),
            // A pause keeps the partial file and its sidecar; resuming asks
            // the host to continue from the recorded prefix and to verify
            // only when this is a retry.
            ...(isDir ? {} : { resume: true, verify: ctx.attempts > 0, onConflict: 'overwrite' }),
          }
          // The route answers when the LAST byte has landed, so progress is
          // indeterminate: the queue states bytes-free "working" rather than
          // drawing a bar it cannot justify.
          //
          // Cancellation has to be POLLED, not checked afterwards. This path
          // awaits one promise that settles only when the whole tree is on
          // disk, so checking `isCancelled()` after it returns would mean the
          // user's stop button did nothing until the copy it was cancelling had
          // finished — the exact failure the queue exists to prevent. Aborting
          // the request is also what makes the HOST stop: the route ties its
          // own signal to the connection (see `abortOnClientGone`).
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          const stop = () => { try { controller?.abort() } catch { /* already gone */ } }
          let pausedByUser = false
          const poll = typeof setInterval === 'function'
            ? setInterval(() => {
                if (ctx.isCancelled()) stop()
                else if (ctx.isPaused()) { pausedByUser = true; stop() }
              }, 150)
            : null
          let parsed
          try {
            parsed = await fetchJson(API.transfer, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
              ...(controller === null ? {} : { signal: controller.signal }),
            })
          } catch (err) {
            if (controller !== null && controller.signal.aborted) {
              throw pausedByUser ? transferPausedError() : transferCancelledError()
            }
            throw err
          } finally {
            if (poll !== null) clearInterval(poll)
          }
          if (ctx.isCancelled()) throw transferCancelledError()
          if (ctx.isPaused()) throw transferPausedError()
          const bytes = typeof parsed?.bytes === 'number' && Number.isFinite(parsed.bytes) ? parsed.bytes : 0
          ctx.progress(bytes)
          nudgeFilesPanel()
          const verdict = transferVerificationNote(parsed)
          const base = translate('transfer.doneDownload', { name: suggestedName, size: formatBytes(bytes) })
          return {
            bytes,
            note: verdict === null ? base : `${base} · ${verdict}`,
          }
        }
        const route = isDir ? API.downloadTree : API.download
        const query = `?alias=${encodeURIComponent(alias)}&path=${encodeURIComponent(remotePath)}`
        const response = await fetch(`${route}${query}`)
        if (!response.ok) throw new Error(await responseErrorText(response))
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > 0) ctx.setTotal(declared)
        if (folder !== null && folder !== undefined) {
          const handle = await folder.getFileHandle(suggestedName, { create: true })
          const bytes = await streamIntoHandle(handle, response, (count) => ctx.progress(count), () => ctx.isCancelled() || ctx.isPaused())
          return { bytes, note: translate('transfer.doneDownload', { name: suggestedName, size: formatBytes(bytes) }) }
        }
        if (target !== null && target !== undefined && target.kind === 'handle') {
          const bytes = await streamIntoHandle(target.handle, response, (count) => ctx.progress(count), () => ctx.isCancelled() || ctx.isPaused())
          return { bytes, note: translate('transfer.doneDownload', { name: suggestedName, size: formatBytes(bytes) }) }
        }
        const blob = await readResponseBlob(response, (count) => ctx.progress(count), () => ctx.isCancelled() || ctx.isPaused())
        saveViaAnchor(blob, suggestedName)
        // The browser owns the save from here on, so the claim stops at "started".
        return {
          bytes: blob.size,
          started: true,
          note: translate('transfer.downloadStarted', { name: suggestedName, size: formatBytes(blob.size) }),
        }
      } catch (err) {
        if (err?.cancelled === true) {
          // The page-side streaming helpers only know "stop"; the queue knows
          // whether that stop was a pause or a cancel.
          if (ctx.isPaused() && !ctx.isCancelled()) throw transferPausedError()
          throw err
        }
        // A pause is a state change, not a failed transfer: wrapping it would
        // turn the acknowledgement into a failure row the resume button
        // cannot reach.
        if (err?.paused === true) throw err
        throw new Error(describeNetworkError(err, startedAt))
      }
    }

    /** Join a host-supplied directory with a filename, either separator. */
    function joinLocalPath (dir, name) {
      const base = String(dir).replace(/[\\/]+$/u, '')
      const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
      return `${base}${sep}${name}`
    }

    /** Read a failed response's JSON error, or the raw text, in one place. */
    async function responseErrorText (response) {
      const text = await response.text().catch(() => '')
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed?.error === 'string' && parsed.error !== '') return parsed.error
      } catch { /* not JSON */ }
      return text || `download failed (${response.status})`
    }

    /**
     * Read a response body into a blob, reporting progress and honouring a
     * cancellation between chunks.
     *
     * The anchor path needs the whole blob before it can hand it to the browser,
     * so it cannot stream to disk — but it can still count the bytes as they
     * arrive instead of pretending they do not exist until the end.
     */
    async function readResponseBlob (response, onProgress, isCancelled) {
      if (response.body === null || typeof response.body.getReader !== 'function') {
        const buffer = await response.arrayBuffer()
        onProgress?.(buffer.byteLength)
        return new Blob([buffer])
      }
      const reader = response.body.getReader()
      const parts = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done === true) break
          if (isCancelled?.() === true) {
            try { await reader.cancel() } catch { /* already gone */ }
            throw transferCancelledError()
          }
          parts.push(value)
          total += value.byteLength
          onProgress?.(total)
        }
      } catch (err) {
        try { await reader.cancel() } catch { /* already gone */ }
        throw err
      }
      return new Blob(parts)
    }

    /** The sentinel a worker throws when the user cancelled it. */
    function transferCancelledError () {
      const error = new Error('transfer cancelled')
      error.cancelled = true
      return error
    }

    /** The sentinel a worker throws when the user paused it. */
    function transferPausedError () {
      const error = new Error('transfer paused')
      error.paused = true
      return error
    }

    /**
     * The verification sentence appended to a success note.
     *
     * A retry re-reads the bytes it already sent and compares them with the
     * source, so its success line says which of the two outcomes happened
     * instead of silently claiming a verified copy.
     */
    function transferVerificationNote (parsed) {
      if (parsed?.verified === true) return translate('queue.verified')
      if (parsed?.verified !== false) return null
      const reason = typeof parsed.verification === 'string' && parsed.verification !== '' ? parsed.verification : null
      return reason === null ? translate('queue.unverifiedNoReason') : translate('queue.unverified', { reason })
    }

    // ---- shared picker

    /**
     * Open a multi-file picker and hand back every chosen file.
     *
     * One helper for the three entry points: the same `multiple`, the same
     * cleanup, the same "no files means no work" rule. The dialog keeps its own
     * rendered input because its ref lives inside the component tree, but the
     * behaviour is this one.
     */
    function pickLocalFiles (onFiles) {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.style.display = 'none'
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? [])
        input.remove()
        if (files.length === 0) return
        onFiles(files)
      }, { once: true })
      document.body.appendChild(input)
      input.value = ''
      input.click()
    }

    /** The one-sentence refusal for files the picker should not have accepted. */
    function oversizeTransferText (rejected) {
      return translate('queue.oversize', {
        limit: formatBytes(TRANSFER_QUEUE_UPLOAD_LIMIT),
        names: rejected.map(file => (file?.name ?? '?')).join(', '),
      })
    }

    // ---- progress UI

    function queueItemMetaText (item, percent, t) {
      if (item.status === 'queued') {
        return item.bytesTotal === null ? t('queue.queued') : `${t('queue.queued')} · ${formatBytes(item.bytesTotal)}`
      }
      if (item.status === 'running') {
        if (item.cancelRequested === true) return t('queue.cancelling')
        // The rate is measured by the reducer and claimed only after two
        // samples cover real time; bytes and percentage are still shown when
        // it is unknown, because bytes ALREADY moved.
        const speed = typeof item.speed === 'number' && Number.isFinite(item.speed) && item.speed > 0
          ? t('queue.perSecond', { size: formatBytes(item.speed) })
          : null
        const bytes = formatBytes(item.bytesDone)
        if (percent === null) return speed === null ? bytes : `${speed} · ${bytes}`
        return speed === null ? `${percent}% · ${bytes}` : `${percent}% · ${speed} · ${bytes}`
      }
      if (item.status === 'pausing') return t('queue.pausing')
      if (item.status === 'paused') return item.bytesTotal === null ? t('queue.paused') : `${t('queue.paused')} · ${formatBytes(item.bytesDone)}`
      if (item.status === 'done') return `${t('queue.done')} · ${formatBytes(item.bytesDone)}`
      if (item.status === 'failed') return t('queue.failed')
      return t('queue.cancelled')
    }

    /** One queue row: direction, name, progress or bytes, cancel. */
    function TransferQueueRow ({ item, t }) {
      const percent = queueItemPercent(item)
      const meta = queueItemMetaText(item, percent, t)
      const active = !transferQueueIsTerminal(item.status)
      const paused = item.status === 'paused'
      const pausing = item.status === 'pausing'
      // The bar is decoration of the row's own text, never its only carrier
      // (`aria-hidden`): a known total fills to its percentage, a finished row
      // is full, and an archive with no total sweeps instead of asserting 0%
      // or 100% for a stream that is actually moving.
      const live = item.status === 'running' && percent === null
      const fillPercent = item.status === 'done' ? 100 : (percent ?? 0)
      return jsxs('div', { className: `sshwsp-queuerow sshwsp-queuerow-${item.status}`, children: [
        // Running transfers turn blue; a download also wears its own ring so
        // the queue row and the listing row that started it show one number. A
        // finished or failed row keeps the plain mark: blue there would read
        // as "still going".
        jsx('span', {
          className: 'sshwsp-queueicon' + (item.status === 'running' ? ' sshwsp-queueicon-active' : ''),
          'aria-hidden': 'true',
          children: item.direction === 'upload'
            ? React.createElement(UploadIcon)
            : item.status === 'running'
              ? React.createElement(TransferProgressIcon, { size: 16, percent, live: percent === null })
              : React.createElement(DownloadIcon),
        }),
        jsxs('div', { className: 'sshwsp-queuebody', children: [
          jsxs('div', { className: 'sshwsp-queue-line', children: [
            jsx('span', { className: 'sshwsp-queuename', title: item.name, children: truncateTransferName(item.name, 38) }),
            jsx('span', { className: 'sshwsp-queuemeta', children: meta }),
          ]}),
          jsx('div', {
            className: `sshwsp-queuebar${live ? ' sshwsp-queuebar-live' : ''}`,
            'aria-hidden': 'true',
            children: jsx('div', {
              className: 'sshwsp-queuebar-fill',
              style: live ? undefined : { width: `${fillPercent}%` },
            }),
          }),
          item.status === 'failed' && typeof item.error === 'string' && item.error !== '' && jsx('div', {
            className: 'sshwsp-queueerror',
            title: item.error,
            children: item.error,
          }),
          // A retry's verdict (and the restart reason) lives in the row's own
          // note; the toast that opens the batch is gone by then.
          item.status === 'done' && typeof item.note === 'string' && item.note !== '' && jsx('div', {
            className: 'sshwsp-queuenote',
            title: item.note,
            children: item.note,
          }),
        ]}),
        (item.status === 'running' || item.status === 'queued' || pausing) && jsx('button', {
          type: 'button',
          className: 'sshwsp-icon-btn',
          title: t('queue.pauseItem'),
          'aria-label': t('queue.pauseItem'),
          disabled: pausing,
          style: pausing ? undefined : { opacity: 0.72 },
          onClick: () => pauseTransferQueueItem(item.id),
          children: '❚❚',
        }),
        paused && jsx('button', {
          type: 'button',
          className: 'sshwsp-icon-btn',
          title: t('queue.resumeItem'),
          'aria-label': t('queue.resumeItem'),
          onClick: () => resumeTransferQueueItem(item.id),
          children: '▶',
        }),
        item.status === 'failed' && jsx('button', {
          type: 'button',
          className: 'sshwsp-icon-btn',
          title: t('queue.retryItem'),
          'aria-label': t('queue.retryItem'),
          onClick: () => retryTransferQueueItem(item.id),
          children: '↻',
        }),
        active && jsx('button', {
          type: 'button',
          className: 'sshwsp-icon-btn',
          title: t('queue.cancelItem'),
          'aria-label': t('queue.cancelItem'),
          onClick: () => cancelTransferQueueItem(item.id),
          children: '×',
        }),
      ]})
    }

    /** The list + footer shared by the popover and the dialog's inline seat. */
    function transferQueueBody (queue, t) {
      const terminal = queue.items.filter(item => transferQueueIsTerminal(item.status)).length
      return jsxs(Fragment, { children: [
        jsx('div', { className: 'sshwsp-queue-list', children: queue.items.length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('queue.empty') })
          // Live first, then the most recent result: see
          // `orderedTransferQueueItems` for why the store's arrival order is
          // the wrong thing to paint.
          : orderedTransferQueueItems(queue.items).map(item => jsx(TransferQueueRow, { key: item.id, item, t })) }),
        jsxs('div', { className: 'sshwsp-queue-foot', children: [
          jsx('span', { className: 'sshwsp-entry-meta', children: t('queue.refreshNote') }),
          jsx('button', {
            type: 'button',
            className: 'sshwsp-btn',
            disabled: terminal === 0,
            onClick: () => clearFinishedTransfers(),
            children: t('queue.clear'),
          }),
        ]}),
      ]})
    }

    /**
     * The popover anchored to the Files panel's queue button.
     *
     * Rendered only while open, so `useDialogA11y` moves focus IN on open
     * rather than on the button's mount (a hook that runs once cannot move
     * focus into a panel that does not exist yet).
     */
    function TransferQueuePanel ({ anchor, onClose, t }) {
      const queue = useTransferQueue()
      const dialog = useDialogA11y({ onClose, label: t('queue.title') })
      return jsxs('div', { className: 'sshwsp-popbackdrop', ...backdropDismiss(onClose), children: [
        jsxs('div', {
          className: 'sshwsp-queuepanel',
          ...dialog.props,
          ref: dialog.bodyRef,
          tabIndex: -1,
          style: { top: `${anchor.top}px`, right: `${anchor.right}px` },
          onClick: (event) => event.stopPropagation(),
          children: [
            jsxs('div', { className: 'sshwsp-queue-head', children: [
              jsx('span', { className: 'sshwsp-queue-title', id: dialog.titleId, children: t('queue.title') }),
              jsx('button', {
                type: 'button',
                className: 'sshwsp-icon-btn',
                title: t('dialog.close'),
                'aria-label': t('dialog.close'),
                onClick: onClose,
                children: '×',
              }),
            ]}),
            transferQueueBody(queue, t),
          ],
        }),
      ]})
    }

    // ---- host capability: is the Files panel action bar present?

    /**
     * Whether this host build declares `sidebar.right.tab.files.actions`.
     *
     * `slots.inject` waits for a declaration, so an absent slot is silent: the
     * entry would simply never render and the user would never learn why. The
     * plugin therefore records the callback's first run as `ready`, and a short
     * grace period after `apply` turns a still-pending wait into `missing`,
     * which the main panel prints as one readable line.
     */
    let transferActionsSlotState = 'pending'
    const transferActionsSlotListeners = new Set()

    function transferActionsSlotSnapshot () {
      return transferActionsSlotState
    }

    function subscribeTransferActionsSlot (listener) {
      if (typeof listener !== 'function') return () => {}
      transferActionsSlotListeners.add(listener)
      return () => { transferActionsSlotListeners.delete(listener) }
    }

    function useTransferActionsSlot () {
      return React.useSyncExternalStore(subscribeTransferActionsSlot, transferActionsSlotSnapshot, transferActionsSlotSnapshot)
    }

    function setTransferActionsSlotState (state) {
      if (transferActionsSlotState === state) return
      transferActionsSlotState = state
      for (const listener of transferActionsSlotListeners) {
        try { listener() } catch { /* a subscriber must not break the panel */ }
      }
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

    /**
     * Copy one row's remote path to the clipboard (F-08).
     *
     * Copies the `ssh://` spelling the rest of the product uses, not the bare
     * remote path: a pasted `ssh://alias/home/x` is a usable reference in the
     * composer and in the file tools, while `/home/x` names a path on whichever
     * machine the reader happens to be typing on.
     *
     * Reports failure rather than failing silently. `navigator.clipboard` needs
     * a secure context and can be refused by permission, and a copy that
     * quietly did nothing is worse than no button: the user pastes stale
     * clipboard content and believes it is the path they picked.
     */
    async function copyRowPath (absPath) {
      if (navigator.clipboard?.writeText === undefined) {
        notifyUser(toastError(translate('rowmenu.copyUnavailable'), 'navigator.clipboard.writeText is unavailable', 'SSHWSP-E-CLIPBOARD'))
        return false
      }
      try {
        await navigator.clipboard.writeText(absPath)
        notifyUser(translate('rowmenu.copied'), 'ok')
        return true
      } catch (err) {
        notifyUser(toastError(translate('rowmenu.copyUnavailable'), err, 'SSHWSP-E-CLIPBOARD'))
        return false
      }
    }

    /**
     * Mount one row's directory as a workspace root (F-08).
     *
     * The directory browser's "Mount this directory" already does this; the row
     * menu is the entry point a user reaches without opening the browser first.
     * Both land on the SAME route, so there is one implementation of "mount a
     * remote directory" rather than two that must not drift.
     *
     * `register: true` matches the browser dialog: a mount the user asked for
     * from a visible directory is one they will want back after a restart.
     */
    async function mountRowAsRoot (alias, remotePath) {
      try {
        const result = await fetchJson(API.mount, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ alias, remotePath, register: true }),
        })
        if (result?.ok === true) {
          notifyUser(translate('rowmenu.mountOk', { path: result.workspacePath ?? remotePath }), 'ok')
          return true
        }
        notifyUser(toastError(translate('rowmenu.mountFail'), result?.error ?? 'unknown', 'SSHWSP-E-MOUNT'))
        return false
      } catch (err) {
        notifyUser(toastError(translate('rowmenu.mountFail'), err, 'SSHWSP-E-MOUNT'))
        return false
      }
    }

    /** POSIX dirname of a remote absolute path. */
    function remoteDirOf (remotePath) {
      const cut = remotePath.replace(/\/+$/u, '').lastIndexOf('/')
      return cut <= 0 ? '/' : remotePath.slice(0, cut)
    }

    /**
     * Pick a destination FILE, or say why that is not possible here.
     *
     * ## Why the picker is opened BEFORE the request
     *
     * `showSaveFilePicker` needs transient user activation, and activation is
     * spent — not merely delayed — by the first `await` that crosses a network
     * round trip. Asking for the destination after the bytes have arrived
     * therefore fails with `SecurityError` on exactly the large transfers where
     * a real destination matters most: the small ones return before activation
     * expires, so the bug looks intermittent instead of structural.
     *
     * Asking first also buys the cancel case for free: a cancel costs no bytes
     * and no partial file.
     *
     * @param {string} suggestedName - the filename to propose.
     * @returns {Promise<{kind: 'handle', handle: object}|{kind: 'canceled'}|{kind: 'unsupported'}>}
     *   one of three outcomes, kept apart on purpose.
     */
    async function pickFileTarget (suggestedName) {
      const picker = typeof window === 'undefined' ? undefined : window.showSaveFilePicker
      if (typeof picker !== 'function') return { kind: 'unsupported' }
      try {
        const handle = await window.showSaveFilePicker({ suggestedName })
        return { kind: 'handle', handle }
      } catch (err) {
        // AbortError is the user closing the dialog. Anything else is a real
        // refusal (permission policy, sandboxed frame) and must NOT be reported
        // as "you cancelled", because the two produce opposite next steps.
        if (err?.name === 'AbortError') return { kind: 'canceled' }
        return { kind: 'unsupported' }
      }
    }

    /**
     * Ask the DESKTOP shell for a folder through its preload bridge.
     *
     * ## Why the shell is asked BEFORE the page's own picker
     *
     * `window.showDirectoryPicker()` is a Chromium surface, and the Electron
     * shell is not quite a browser. A field report for this plugin: on the
     * first batch download after the app opened, the folder dialog appeared and
     * a folder was chosen, yet the batch silently did nothing — and the second
     * attempt worked. The one silent exit in that path is a cancel, and the
     * page's picker is the only chooser that can answer one without the user
     * cancelling: a first call in a freshly opened window has been seen to
     * raise `AbortError` after the dialog itself was accepted. Since an abort
     * the user did not perform is indistinguishable from a real cancel
     * downstream, the safe order is to ask the shell's bridge first — the
     * chooser DSH itself uses for its workspace flow, owned and sender-checked
     * by the main process — and keep the page's picker as the fallback for
     * when that bridge is absent.
     *
     * @returns {Promise<{kind: 'path', path: string}|{kind: 'canceled'}|{kind: 'unavailable'}|null>}
     *   `null` means "no bridge in this page"; `unavailable` means the bridge
     *   refused for its own reasons, so the page's picker is still worth a try.
     */
    async function pickDesktopFolder () {
      const desktop = typeof globalThis === 'undefined' ? undefined : globalThis.__DSH_DIRECTORY_PICKER__
      if (desktop === undefined || desktop === null || typeof desktop.pick !== 'function') return null
      try {
        const picked = await desktop.pick()
        if (picked === null || picked === undefined) return { kind: 'canceled' }
        return { kind: 'path', path: String(picked) }
      } catch (err) {
        // A native dialog reports a cancel by REJECTING on some platforms, and
        // only the wording says so. Anything else is a refusal — reported as
        // `unavailable`, never as a cancel the user did not perform.
        if (/cancel|abort|dismiss/iu.test(err instanceof Error ? err.message : String(err))) return { kind: 'canceled' }
        return { kind: 'unavailable' }
      }
    }

    /**
     * Pick a destination DIRECTORY, for a batch or an archive.
     *
     * ## Four outcomes, and why "unsupported" is not "canceled"
     *
     * Order: the desktop shell's bridge (`pickDesktopFolder`), then the
     * browser's `showDirectoryPicker` — the page writes the bytes itself, so
     * it can report what the DISK accepted — then the HOST's folder chooser
     * (`uiWorkspace.pickDirectory`), whose answer is a plain path the
     * `/transfer` route accepts directly, so the bytes never have to travel
     * through the page at all.
     *
     * A cancel from any chooser is a cancel. A chooser that does not exist on
     * this platform is `unsupported`, and the caller must fall back to
     * per-file save dialogs rather than claim the user cancelled.
     *
     * @returns {Promise<{kind: 'handle', handle: object}|{kind: 'path', path: string}|{kind: 'canceled'}|{kind: 'unsupported'}>}
     *   one of four outcomes, kept apart on purpose.
     */
    async function pickDirTarget (ctx) {
      const desktop = await pickDesktopFolder()
      if (desktop !== null && desktop.kind !== 'unavailable') return desktop
      const picker = typeof window === 'undefined' ? undefined : window.showDirectoryPicker
      if (typeof picker === 'function') {
        try {
          const handle = await window.showDirectoryPicker()
          return { kind: 'handle', handle }
        } catch (err) {
          if (err?.name === 'AbortError') return { kind: 'canceled' }
          // Any other refusal falls THROUGH to the host chooser: a policy that
          // forbids the page's picker is not a reason to leave the user without
          // a destination.
        }
      }
      const folder = await pickHostFolder(ctx)
      if (folder === null) return { kind: 'unsupported' }
      if (folder === false) return { kind: 'canceled' }
      return { kind: 'path', path: folder }
    }

    /**
     * Ask the HOST service for a folder on this machine.
     *
     * The desktop shell's own bridge is NOT asked here: `pickDirTarget` already
     * tried it first, and a second attempt would either pop a second dialog or
     * (on an app whose bridge is temporarily busy) hang on the shared promise.
     * What remains is the browser-shaped hosting path — `uiWorkspace`'s
     * directory service — which answers with a plain path on this machine.
     *
     * @param {object} ctx - the plugin context (for `uiWorkspace`).
     * @returns {Promise<string|false|null>} a path, `false` for a user cancel,
     *   or `null` when this platform has no chooser at all.
     */
    async function pickHostFolder (ctx) {
      try {
        const uiWorkspace = ctx?.get?.('uiWorkspace')
        if (uiWorkspace === undefined || uiWorkspace === null) return null
        if (typeof uiWorkspace.pickDirectory !== 'function') return null
        const picked = await uiWorkspace.pickDirectory()
        return picked === null || picked === undefined ? false : String(picked)
      } catch (err) {
        // A cancelled native dialog REJECTS on some platforms, so the message
        // is the only signal available — and a genuine failure (no display, a
        // policy refusal) must not be reported as "you cancelled", because the
        // two produce opposite next steps.
        if (/cancel|abort|dismiss/iu.test(err instanceof Error ? err.message : String(err))) return false
        return null
      }
    }

    /**
     * Stream a response body into a writable file handle.
     *
     * The returned count is what the DISK accepted, chunk by chunk — the number
     * the completion notice must report. `close()` is what commits the file; a
     * failure before it aborts the writable, so a half-written file is never
     * published under the chosen name.
     *
     * @param {object} handle - a `FileSystemFileHandle`.
     * @param {Response} response - the streaming response.
     * @param {(bytes: number) => void} [onProgress] - called with the running count.
     * @param {() => boolean} [isCancelled] - checked between chunks.
     * @returns {Promise<number>} the byte count written.
     */
    async function streamIntoHandle (handle, response, onProgress, isCancelled) {
      const writable = await handle.createWritable()
      let total = 0
      try {
        if (response.body === null || typeof response.body.getReader !== 'function') {
          // No streaming body (an old engine, or a stubbed response): the blob
          // path is still a real save, it just cannot report progress.
          if (isCancelled?.() === true) throw transferCancelledError()
          const buffer = await response.arrayBuffer()
          await writable.write(buffer)
          total = buffer.byteLength
          if (typeof onProgress === 'function') onProgress(total)
        } else {
          const reader = response.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done === true) break
            if (isCancelled?.() === true) {
              // Stop pulling bytes AND abort the writable (the catch below):
              // a cancelled download must not leave a partial file under the
              // name the user chose.
              try { await reader.cancel() } catch { /* already gone */ }
              throw transferCancelledError()
            }
            await writable.write(value)
            total += value.byteLength
            if (typeof onProgress === 'function') onProgress(total)
          }
        }
        await writable.close()
        return total
      } catch (err) {
        // Abort, not close: a partially written file must not survive under the
        // name the user chose.
        try { await writable.abort() } catch { /* already closed */ }
        throw err
      }
    }

    /**
     * Save bytes through the browser's own download flow.
     *
     * This path CANNOT report whether the file was saved: the anchor hands the
     * bytes to the browser and the browser owns the save dialog, including the
     * user closing it. Callers must therefore word their notice as "started",
     * never "downloaded".
     *
     * The object URL is revoked on a timer rather than immediately: revoking it
     * in the same task as the click cancels the download in Chromium before the
     * download manager has read a byte, which is invisible for a small file and
     * fatal for a large one.
     *
     * @param {Blob} blob - the bytes.
     * @param {string} name - the suggested filename.
     */
    function saveViaAnchor (blob, name) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }

    /**
     * Pull one remote row down to this machine.
     *
     * A FILE goes through the streaming `download` route. A DIRECTORY goes
     * through `download-tree`, which answers one archive — a browser cannot be
     * handed a folder, and an archive is the shape its download flow
     * understands.
     *
     * ## Why the destination is chosen before the fetch
     *
     * "Downloaded" used to be announced as soon as the bytes reached the page —
     * which is before the browser has opened its save dialog, and therefore
     * before the user has chosen anything, or declined. The notice claimed a
     * save the page had not seen happen.
     *
     * When the File System Access API is available the page OWNS the write: it
     * picks the file, streams into it and only then reports a byte count that
     * came from the disk. When it is not, the bytes go to the browser's own
     * flow and the notice says "started" — the only claim that is true.
     *
     * The transfer itself is enqueued rather than awaited here: the queue owns
     * the request, its progress and its cancellation, so this function is only
     * the gesture that chooses a destination.
     *
     * @param {string} absPath - the row's `ssh://alias/abs/path` spelling.
     * @param {boolean} [isDir] - whether the row is a directory.
     */
    async function downloadTreeRow (absPath, isDir = false) {
      const parts = remoteTargetOf(absPath)
      if (parts === null) {
        notifyUser(toastError(translate('transfer.notRemote'), absPath, 'SSHWSP-E-TRANSFER-TARGET'))
        return
      }
      const name = parts.remotePath.replace(/\/+$/u, '').split('/').pop() ?? ''
      const label = name === '' ? parts.remotePath : name
      // A folder becomes a .zip (the route's default), not a .tar: the tar was
      // a correct archive that Windows cannot open without extra software.
      const suggested = isDir ? `${label}.zip` : label
      // FIRST await, so activation is still intact — see `pickFileTarget`.
      const target = await pickFileTarget(suggested)
      if (target.kind === 'canceled') return
      enqueueDownloadJob({
        alias: parts.alias,
        remotePath: parts.remotePath,
        suggestedName: suggested,
        isDir,
        target,
      })
    }

    /**
     * Queue local files into one remote directory, with the queue's oversize
     * refusal shown as a toast.
     *
     * One helper for every path that has no inline error surface of its own:
     * the row picker and an OS drop must split, queue and report identically.
     * It lives outside the header component deliberately; the header only
     * owns its queue entry, not upload intake.
     */
    function queueTreeUploads (alias, dir, files, skippedFolders) {
      const skipped = Array.isArray(skippedFolders) ? skippedFolders : []
      const note = skipped.length === 0
        ? ''
        : translate('osdrop.foldersSkipped', { names: dropFolderNames(skipped) })
      const split = enqueueUploads(alias, dir, files, note)
      if (split.rejected.length > 0) {
        notifyUser(toastError(oversizeTransferText(split.rejected), split.rejected, 'SSHWSP-E-TRANSFER-SIZE'))
      }
      return split
    }

    /** First three folder names plus an ellipsis, for the refusal notice. */
    function dropFolderNames (folders) {
      const names = folders.map(folder => {
        const name = folder?.name
        return typeof name === 'string' && name !== '' ? name : '?'
      })
      const shown = names.slice(0, 3).join(', ')
      return names.length > 3 ? `${shown}, …` : shown
    }

    /**
     * Where a system-file drop at `node` would upload.
     *
     * The host renders an expanded directory's children INSIDE that directory's
     * own <li>, so `closest` already answers "which folder owns this spot": a
     * child row gives that child, and blank space under an expanded folder gives
     * the folder itself. Only the tree body (no row ancestor) is the root.
     *
     * Returns `{alias, dir, highlight}` for a remote tree, `{refusal:'local'}`
     * for a local workspace, or null when the drop is not inside a file panel.
     * The panel's header / path label has no row ancestor, so it is the root.
     */
    function osDropPlan (node) {
      if (!(node instanceof Element)) return null
      // A dialog may portal a file list; never take over a drag aimed at it.
      if (node.closest('[role="dialog"]') !== null) return null
      const inTree = node.closest(OS_TREE_SELECTOR)
      const page = node.closest(OS_PAGE_SELECTOR)
      const tree = inTree ?? (page === null ? null : page.querySelector(OS_TREE_SELECTOR))
      if (tree === null) return null
      const root = tree.getAttribute('data-files-root')
      if (root === null || root === '') return null
      if (inTree === null) {
        // The path label / toolbar is part of the file panel but outside the
        // tree body. Dropping there is the same destination as the tree root.
        const parts = remoteTargetOf(root)
        if (parts === null) return { refusal: 'local', root }
        return { alias: parts.alias, dir: parts.remotePath, highlight: dropHighlightOf(null, tree) }
      }
      const row = node.closest(TREE_ROW_SELECTOR) // innermost <li data-files-entry>
      const base = row === null ? root : row.getAttribute('data-files-path')
      if (base === null || base === '') return null
      const parts = remoteTargetOf(base)
      // A local workspace has no remote side. Refuse EXPLICITLY instead of
      // letting the host turn the dropped file into a composer attachment.
      if (parts === null) return { refusal: 'local', root }
      const kind = row === null ? null : row.getAttribute('data-files-entry')
      let dir = parts.remotePath
      if (row !== null && kind !== 'directory') {
        // A file row (or the non-interactive `other` kind) means the directory
        // that holds it — exactly what uploadTreeRow does.
        dir = remoteDirOf(parts.remotePath)
      }
      return { alias: parts.alias, dir, highlight: dropHighlightOf(row, tree) }
    }

    /**
     * The element an OS drop should outline.
     *
     * A row's BUTTON, not its <li>: an expanded `li` contains the whole subtree,
     * so outlining it would wrap a block of unrelated children. A descendant
     * file/other row points at the directory that owns it.
     */
    function dropHighlightOf (row, tree) {
      if (row !== null) {
        const kind = row.getAttribute('data-files-entry')
        if (kind === 'directory') return row.querySelector('button') ?? row
        const owner = row.closest('li[data-files-entry="directory"][data-files-path]')
        if (owner !== null) return owner.querySelector('button') ?? owner
      }
      return tree.querySelector(TREE_BODY_SELECTOR) ?? tree
    }

    /**
     * The DataTransfer of an OS-file drag, or null for an internal drag.
     *
     * The host's attachment package (and this plugin's row drag) disagree about
     * where a drop belongs; `Files` in `types` is the browser's own marker for
     * "this came from outside the page", and it is the only thing this branch
     * may key on. `dataTransfer.files` is unreadable during dragover.
     */
    function filesTransferOf (event) {
      const transfer = event?.dataTransfer
      if (transfer === null || transfer === undefined) return null
      const types = Array.from(transfer.types ?? [])
      return types.some(type => String(type).toLowerCase() === 'files') ? transfer : null
    }

    /**
     * Split an OS drop into files we can upload and directories we refuse.
     *
     * v1 does not walk directories. The index pairing mirrors the host's own
     * `droppedDirectories`: `items` (kind 'file') line up with `files` one-to-one,
     * and a folder shows up as an item whose entry `isDirectory` is true.
     */
    function splitDroppedFolders (transfer, files) {
      const folders = []
      const kept = []
      const items = Array.from(transfer?.items ?? []).filter(item => item.kind === 'file')
      let cursor = 0
      for (const file of files) {
        let isDirectory = false
        const item = items[cursor]
        cursor += 1
        if (item !== undefined) {
          try {
            isDirectory = item.webkitGetAsEntry?.()?.isDirectory === true
          } catch {
            isDirectory = false
          }
        }
        if (isDirectory) folders.push(file)
        else kept.push(file)
      }
      return { files: kept, folders }
    }

    /** Remove every OS-drop outline, including one left by an older bundle. */
    function clearOsDropHighlight () {
      try {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
        for (const node of document.querySelectorAll(`[${OS_DROP_ATTR}]`)) {
          if (typeof node.removeAttribute === 'function') node.removeAttribute(OS_DROP_ATTR)
          if (typeof node.style?.removeProperty === 'function') {
            node.style.removeProperty('outline')
            node.style.removeProperty('outline-offset')
          }
        }
      } catch { /* best-effort */ }
    }

    /** Draw the one OS-drop outline; a new target replaces the previous one. */
    function setOsDropHighlight (plan) {
      clearOsDropHighlight()
      const node = plan?.highlight
      if (!(node instanceof Element) || typeof node.style?.setProperty !== 'function') return
      node.setAttribute(OS_DROP_ATTR, '1')
      // A row button keeps the ring inside the row; the tree body keeps it
      // inside the panel so it cannot paint over sibling panels.
      const inset = node.hasAttribute('data-files-body') || node.hasAttribute('data-files-state') ? '2px' : '-2px'
      node.style.setProperty('outline', '2px solid var(--dsw-alias-button-info-fill, #4a9eff)')
      node.style.setProperty('outline-offset', inset)
    }

    /**
     * Queue local files into the directory that holds `absPath`.
     *
     * Uploads land beside the row the user invoked it on. A directory row is
     * its own destination; a file row means its parent, which is what the user
     * is looking at. The picker accepts several files at once, and the whole
     * pick becomes a batch in the queue.
     */
    function uploadTreeRow (absPath, isDir) {
      const parts = remoteTargetOf(absPath)
      if (parts === null) {
        notifyUser(toastError(translate('transfer.notRemote'), absPath, 'SSHWSP-E-TRANSFER-TARGET'))
        return
      }
      const dir = isDir ? parts.remotePath : remoteDirOf(parts.remotePath)
      pickLocalFiles((files) => {
        queueTreeUploads(parts.alias, dir, files)
      })
    }

    /**
     * Whether a thrown `fetch` is a transport failure rather than an answer.
     *
     * `fetch` rejects ONLY for the former — every HTTP-level verdict arrives as
     * a Response, including the JSON refusals this plugin writes. So the
     * message is the whole test, and it is matched loosely because the engines
     * spell it differently: `Failed to fetch` (Chrome), `NetworkError when
     * attempting to fetch resource` (Firefox), `Load failed` (Safari).
     *
     * @param {unknown} err - what the fetch threw.
     * @returns {boolean} true when nothing came back over the wire.
     */
    function isNetworkFailure (err) {
      const message = err instanceof Error ? err.message : String(err)
      return /failed to fetch|networkerror|load failed|fetch failed/iu.test(message)
    }

    /**
     * Describe a transfer that died on the wire in terms the user can act on.
     *
     * `fetch` reports every network-level death with the same words — `Failed
     * to fetch` — whether the server timed out mid-body, the link dropped, or
     * nothing was listening. Repeating that tells the user nothing they cannot
     * see, and it hides the distinction that decides what to do next: WHEN it
     * died.
     *
     * An instant failure is not a slow transfer. Nothing was listening (the app
     * is restarting), or the browser refused the request outright (an
     * extension). A failure after minutes is the server giving up on the body.
     * Two different situations, two different sentences — the elapsed time is
     * the page's own evidence, so it chooses between them and is shown as well.
     *
     * @param {unknown} err - what the fetch threw.
     * @param {number} startedAt - when the request began (ms).
     * @returns {string} the sentence to show.
     */
    function describeNetworkError (err, startedAt) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isNetworkFailure(err)) return message
      const elapsed = Math.max(0, Date.now() - startedAt)
      const seconds = elapsed < 10_000 ? (elapsed / 1000).toFixed(1) : String(Math.round(elapsed / 1000))
      const sentence = translate(elapsed < 1500 ? 'transfer.networkFailFast' : 'transfer.networkFail', { seconds })
      // Appended here rather than by each caller: the fact belongs to the
      // request, and two call sites spelling it separately is exactly how the
      // panel and the toast drifted apart before.
      return err?.retried === true ? `${sentence}${translate('transfer.retried')}` : sentence
    }

    /**
     * Bytes carried by one chunked-JSON request.
     *
     * The server reads a JSON body up to 4 MiB (`readJsonBody`), and base64
     * inflates bytes by a third, so 2 MiB of file is 2.7 MB on the wire — a
     * comfortable margin rather than a fit that a future header elsewhere could
     * push over the line.
     */
    const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024

    /**
     * Why every browser upload travels base64 in JSON, not as a request body.
     *
     * The packaged desktop shell serves this plugin's pages from
     * `dsh-app://app/`, and there a fetch whose body is a `File` dies in the
     * network service with `net::ERR_UNEXPECTED` BEFORE any handler runs —
     * measured from the panel: the failure was instantaneous, the server logged
     * nothing, and the same bytes went through fine from a plain HTTP page.
     * JSON bodies cross that scheme, which every other panel action already
     * proves.
     *
     * The raw route (`POST /upload`, `content-type: application/octet-stream`)
     * still exists and is still guarded server-side, but the browser no longer
     * uses it. Once the queue required progress and cancellation for EVERY
     * upload, the raw body could offer neither: `fetch` has no upload-progress
     * event, and a body stream cannot be paused between chunks. Keeping both
     * would have meant one transport with progress and one without, chosen by
     * the origin — the same "two shapes, one feature" split this repository
     * keeps finding. One transport is the honest answer, and it is the one that
     * works in both shells.
     */

    /** Hex characters, for an upload id the server can use as a path segment. */
    function randomHexId (length) {
      const bytes = new Uint8Array(Math.ceil(length / 2))
      crypto.getRandomValues(bytes)
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length)
    }

    /** Base64 of a byte array, built in slices so a 2 MiB chunk cannot blow the stack. */
    function bytesToBase64 (bytes) {
      let binary = ''
      const step = 0x8000
      for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step))
      }
      return btoa(binary)
    }

    /**
     * One chunked-JSON request, with a single safe retry.
     *
     * Retrying a NON-final chunk is safe and idempotent: the server writes those
     * bytes at the offset this request names, so sending them twice lands them
     * once. A final chunk is not retried — it publishes by rename, and replaying
     * it after a success that merely lost its response would find the staging
     * file gone and report a failure for a file that did land.
     */
    async function postUploadChunk (request) {
      const { signal, ...body } = request
      const maxAttempts = body.final === true || body.abort === true ? 1 : 2
      let retried = false
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await fetch(API.uploadChunk, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            ...(signal === undefined ? {} : { signal }),
          })
          const text = await response.text().catch(() => '')
          let parsed
          try { parsed = JSON.parse(text) } catch { /* not JSON */ }
          if (!response.ok || parsed?.ok !== true) {
            throw new Error(parsed?.error ?? (text || `upload failed (${response.status})`))
          }
          return parsed
        } catch (err) {
          // A pause or a cancel aborted this request on purpose. A replay
          // would either send bytes the user asked to stop, or race the stop.
          if (signal?.aborted) throw err
          if (!isNetworkFailure(err) || attempt === maxAttempts) {
            if (retried && err !== null && typeof err === 'object') err.retried = true
            throw err
          }
          retried = true
          await new Promise(resolve => setTimeout(resolve, 400))
        }
      }
      throw new Error('upload: unreachable')
    }

    /** The SHA-256 round constants, shared by the one-shot and streaming forms. */
    const SHA256_K = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ])
    const SHA256_INIT = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ])

    /** Compress one 64-byte block into the running state, in place. */
    function sha256Block (h, w, block, start) {
      for (let i = 0; i < 16; i += 1) w[i] = (block[start + i * 4] << 24) | (block[start + i * 4 + 1] << 16) | (block[start + i * 4 + 2] << 8) | block[start + i * 4 + 3]
      for (let i = 16; i < 64; i += 1) {
        const x = w[i - 15]
        const y = w[i - 2]
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
      }
      let a = h[0]; let b = h[1]; let c = h[2]; let d = h[3]
      let e = h[4]; let f = h[5]; let g = h[6]; let hh = h[7]
      for (let i = 0; i < 64; i += 1) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
        const ch = (e & f) ^ (~e & g)
        const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
        const maj = (a & b) ^ (a & c) ^ (b & c)
        const t2 = (S0 + maj) >>> 0
        hh = g; g = f; f = e; e = (d + t1) >>> 0
        d = c; c = b; b = a; a = (t1 + t2) >>> 0
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
    }

    /** Hex digest of a complete byte array; small inputs only (debug/tests). */
    function sha256HexOfBytes (bytes) {
      const h = SHA256_INIT.slice()
      const w = new Uint32Array(64)
      const total = bytes.length
      const paddedLength = ((total + 9 + 63) >> 6) * 64
      const padded = new Uint8Array(paddedLength)
      padded.set(bytes)
      padded[total] = 0x80
      const view = new DataView(padded.buffer)
      const bitLength = total * 8
      view.setUint32(paddedLength - 8, Math.floor(total / 0x20000000))
      view.setUint32(paddedLength - 4, bitLength >>> 0)
      for (let at = 0; at < paddedLength; at += 64) sha256Block(h, w, padded, at)
      let out = ''
      for (const word of h) out += word.toString(16).padStart(8, '0')
      return out
    }

    /**
     * Stream a File through SHA-256 without holding it in memory.
     *
     * The retry path needs the SOURCE digest to compare against the host's
     * digest of the published file. A whole-file read would double the peak
     * memory of a 1 GiB transfer; one slice at a time does not.
     *
     * @param {File} file - the source.
     * @returns {Promise<string>} lowercase hex.
     */
    async function sha256HexOfFile (file) {
      const h = SHA256_INIT.slice()
      const w = new Uint32Array(64)
      const buffer = new Uint8Array(64)
      let buffered = 0
      let total = 0
      for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
        const chunk = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 4 * 1024 * 1024)).arrayBuffer())
        total += chunk.length
        let index = 0
        if (buffered > 0) {
          const take = Math.min(64 - buffered, chunk.length)
          buffer.set(chunk.subarray(0, take), buffered)
          buffered += take
          index += take
          if (buffered === 64) { sha256Block(h, w, buffer, 0); buffered = 0 }
        }
        while (index + 64 <= chunk.length) { sha256Block(h, w, chunk, index); index += 64 }
        if (index < chunk.length) { buffer.set(chunk.subarray(index), 0); buffered = chunk.length - index }
      }
      const tail = new Uint8Array(buffered < 56 ? 64 : 128)
      tail.set(buffer.subarray(0, buffered))
      tail[buffered] = 0x80
      const view = new DataView(tail.buffer)
      const bitLength = total * 8
      view.setUint32(tail.length - 8, Math.floor(total / 0x20000000))
      view.setUint32(tail.length - 4, bitLength >>> 0)
      for (let at = 0; at < tail.length; at += 64) sha256Block(h, w, tail, at)
      let out = ''
      for (const word of h) out += word.toString(16).padStart(8, '0')
      return out
    }

    /**
     * The chunked transport: base64 in JSON, published on the last chunk.
     *
     * The staging path comes from the item's uploadId, so a paused upload
     * leaves its bytes where a resume can find them. A retry first asks the
     * host how much of that prefix it still holds and whether it belongs to
     * the same source (size + mtime); a changed source is refused there and
     * restarted from zero rather than continued from stale bytes. The final
     * chunk of a retry carries the source SHA-256, so the host can compare the
     * published file with the bytes that were actually read.
     *
     * @param {string} alias - host alias.
     * @param {string} dir - remote directory to write into.
     * @param {File} file - the bytes.
     * @param {object} [hooks] - queue observations and the retry identity.
     * @param {string} [hooks.uploadId] - stable for the whole queue item.
     * @param {string} [hooks.identity] - source size:mtime signature.
     * @param {number} [hooks.attempt] - 0 for the first attempt, >0 for a retry.
     * @param {(bytes: number) => void} [hooks.onProgress] - bytes accepted.
     * @param {() => boolean} [hooks.isCancelled] - checked between chunks.
     * @param {() => boolean} [hooks.isPaused] - interrupts the in-flight chunk.
     * @returns {Promise<{parsed: object|undefined, restarted: string|null}>} the last answer.
     */
    async function postFileInChunks (alias, dir, file, hooks = {}) {
      const total = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0
      const isCancelled = typeof hooks?.isCancelled === 'function' ? hooks.isCancelled : () => false
      const isPaused = typeof hooks?.isPaused === 'function' ? hooks.isPaused : () => false
      const onProgress = typeof hooks?.onProgress === 'function' ? hooks.onProgress : () => {}
      const uploadId = typeof hooks?.uploadId === 'string' && hooks.uploadId !== '' ? hooks.uploadId : randomHexId(32)
      const identity = typeof hooks?.identity === 'string' && hooks.identity !== '' ? hooks.identity : `${total}:0`
      const attempt = Number.isInteger(hooks?.attempt) && hooks.attempt > 0 ? hooks.attempt : 0
      const resume = hooks?.resume === true
      const base = { alias, path: dir, name: file.name, uploadId, identity, totalBytes: total }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const signal = controller?.signal
      // A chunk is up to 2 MiB of base64 JSON; without this poll a pause would
      // take effect only after the request it was meant to interrupt returned.
      const poll = typeof setInterval === 'function'
        ? setInterval(() => {
            if (isCancelled() || isPaused()) { try { controller?.abort() } catch { /* already gone */ } }
          }, 100)
        : null
      let offset = 0
      let restarted = null
      try {
        if (attempt > 0 || resume) {
          const probe = await postUploadChunk({ ...base, probe: true, ...(signal === undefined ? {} : { signal }) })
          const held = Number(probe?.offset)
          if (Number.isFinite(held) && held > 0) offset = Math.min(total, Math.max(0, Math.trunc(held)))
          if (probe?.resume !== true && probe?.discarded === true && typeof probe?.reason === 'string') restarted = probe.reason
          if (offset > 0) onProgress(offset)
        }
        for (;;) {
          if (isCancelled()) throw transferCancelledError()
          if (isPaused()) throw transferPausedError()
          const end = Math.min(total, offset + UPLOAD_CHUNK_BYTES)
          const data = bytesToBase64(new Uint8Array(await file.slice(offset, end).arrayBuffer()))
          const final = end >= total
          const request = { ...base, offset, data, final }
          if (final && attempt > 0) {
            request.sha256 = await sha256HexOfFile(file)
            request.verify = true
          }
          const parsed = await postUploadChunk(signal === undefined ? request : { ...request, signal })
          if (final) {
            onProgress(total)
            return { parsed, restarted }
          }
          offset = end
          onProgress(offset)
        }
      } catch (err) {
        // A pause keeps the staged prefix for the resume; a cancel discards it
        // so no .dsh-up-* part is left beside the user's directory.
        if (err?.cancelled === true) {
          try { await postUploadChunk({ ...base, offset: 0, data: '', final: false, abort: true }) } catch { /* ignore */ }
          throw err
        }
        if (controller?.signal.aborted === true) {
          if (isCancelled()) {
            try { await postUploadChunk({ ...base, offset: 0, data: '', final: false, abort: true }) } catch { /* ignore */ }
            throw transferCancelledError()
          }
          if (isPaused()) throw transferPausedError()
        }
        throw err
      } finally {
        if (poll !== null) clearInterval(poll)
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


    /** The display name of the last path segment, tolerant of both separators. */
    function entryNameOf (target) {
      if (typeof target !== 'string' || target === '') return ''
      const tail = target.replace(/[\\/]+$/u, '')
      const cut = Math.max(tail.lastIndexOf('/'), tail.lastIndexOf('\\'))
      return cut < 0 ? tail : tail.slice(cut + 1)
    }

    /**
     * Client-side name rules. The server re-validates with the authoritative
     * module; this copy exists so the dialog can answer before a round-trip,
     * and it is deliberately the same list.
     */
    function localNameRefusal (name) {
      if (typeof name !== 'string' || name === '') return translate('rowmenu.renameEmpty')
      if (name.trim() === '') return translate('rowmenu.renameEmpty')
      if (name === '.' || name === '..') return translate('rowmenu.renameInvalid')
      if (name.includes('/') || name.includes('\\')) return translate('rowmenu.renameSeparator')
      return undefined
    }

    /** The same one-segment rule, worded for the new-folder prompt. */
    function folderNameRefusal (name) {
      if (typeof name !== 'string' || name === '') return translate('rowmenu.createEmpty')
      if (name.trim() === '') return translate('rowmenu.createEmpty')
      if (name === '.' || name === '..') return translate('rowmenu.createInvalid')
      if (name.includes('/') || name.includes('\\')) return translate('rowmenu.createSeparator')
      return undefined
    }

    /**
     * The session's mutation mode, for disabling the two destructive actions
     * before the user clicks them. A failed lookup answers null: the server
     * still refuses at the boundary, so an unknown mode is not an escalation.
     *
     * @param {{sessionId?: string, root?: string|null}} claim - how to find the session.
     * @returns {Promise<string|null>} `read-only`, another mode, or null.
     */
    async function mutationPolicyOf (claim) {
      try {
        const query = new URLSearchParams()
        if (typeof claim?.sessionId === 'string' && claim.sessionId !== '') query.set('sessionId', claim.sessionId)
        if (typeof claim?.root === 'string' && claim.root !== '') query.set('root', claim.root)
        const data = await fetchJson(`${API.mutationPolicy}?${query.toString()}`)
        return {
          mode: typeof data?.mode === 'string' && data.mode !== '' ? data.mode : null,
          sessionFound: data?.sessionFound === true,
          readOnly: data?.readOnly === true,
        }
      } catch {
        return null
      }
    }

    let rowActionNode = null
    let rowActionCleanup = null

    function closeRowAction () {
      if (rowActionCleanup !== null) {
        try { rowActionCleanup() } catch { /* already detached */ }
        rowActionCleanup = null
      }
      if (rowActionNode !== null) {
        rowActionNode.remove()
        rowActionNode = null
      }
    }

    /**
     * The one lightweight overlay both destructive row actions use.
     *
     * @param {object} options - title, body builder, submit label, onSubmit.
     * @returns {void}
     */
    function openRowActionDialog (options) {
      closeRowAction()
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const backdrop = document.createElement('div')
      backdrop.className = 'sshwsp-backdrop'
      backdrop.setAttribute('data-sshwsp-row-action', '1')
      const dialog = document.createElement('div')
      dialog.className = 'sshwsp-dialog sshwsp-dialog-narrow'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      const titleId = 'sshwsp-row-action-title'
      dialog.setAttribute('aria-labelledby', titleId)
      const title = document.createElement('div')
      title.className = 'sshwsp-dialog-title'
      title.id = titleId
      title.textContent = options.title
      const body = document.createElement('div')
      body.className = 'sshwsp-form'
      const error = document.createElement('div')
      error.className = 'sshwsp-error'
      error.setAttribute('role', 'alert')
      error.hidden = true
      const footer = document.createElement('div')
      footer.className = 'sshwsp-dialog-footer'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'sshwsp-btn'
      cancel.textContent = translate('editor.cancel')
      const submit = document.createElement('button')
      submit.type = 'button'
      submit.className = 'sshwsp-btn sshwsp-btn-primary'
      submit.textContent = options.submitLabel
      footer.append(cancel, submit)
      body.appendChild(options.buildBody())
      body.appendChild(error)
      dialog.append(title, body, footer)
      backdrop.appendChild(dialog)
      document.body.appendChild(backdrop)
      rowActionNode = backdrop

      const showError = (text) => {
        error.textContent = text
        error.hidden = text === ''
      }
      const setBusy = (busy) => {
        submit.disabled = busy
        cancel.disabled = busy
        if (busy) submit.textContent = options.busyLabel ?? options.submitLabel
        else submit.textContent = options.submitLabel
      }
      const close = () => {
        closeRowAction()
        opener?.focus?.()
      }
      const run = async () => {
        showError('')
        setBusy(true)
        try {
          const failure = await options.onSubmit()
          if (failure !== undefined && failure !== null && failure !== '') {
            showError(failure)
            return
          }
          close()
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err))
        } finally {
          if (rowActionNode !== null) setBusy(false)
        }
      }
      cancel.addEventListener('click', close)
      submit.addEventListener('click', () => { void run() })
      backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop) close()
      })
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
          return
        }
        if (event.key === 'Tab') {
          // A two-button dialog: keep Tab inside it, wrapping at the ends.
          const items = [cancel, submit].filter(button => !button.disabled)
          if (items.length === 0) return
          const at = items.indexOf(document.activeElement)
          event.preventDefault()
          const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1 >= items.length ? 0 : at + 1)
          items[next].focus()
        }
      }
      document.addEventListener('keydown', onKey, true)
      rowActionCleanup = () => document.removeEventListener('keydown', onKey, true)
      const focusable = options.focusNode ?? cancel
      focusable.focus?.()
      const setTitle = (text) => { title.textContent = text }
      return { showError, setBusy, setTitle, close, dialog }
    }

    /**
     * The rename prompt.
     *
     * Two shapes, ONE rule set. When the caller knows which row the user is
     * looking at — every path into here does, since rename is a row verb — the
     * editor opens IN PLACE on that row, which is how every file manager does
     * it and how the user asked for it. The modal dialog stays as the fallback
     * for a caller that has only a path (a row that has already left the DOM,
     * an integration driving this from outside a panel).
     *
     * @param {object} request - path / name / root / row.
     * @returns {void}
     */
    function requestRowRename (request) {
      const row = request.row
      if (row instanceof Element && document.contains(row)) {
        if (openInlineRename(row, request)) return
      }
      requestRowRenameDialog(request)
    }

    /**
     * What an inline rename edit means, as a pure answer.
     *
     * Kept out of the DOM handler because these three outcomes are the whole
     * contract and the one place they can silently drift: an unchanged or
     * emptied field is a CANCEL (the user changed their mind; saying "name
     * cannot be empty" about a field they cleared on the way out is noise),
     * a structurally impossible name is a REFUSAL that keeps the editor open,
     * and anything else commits.
     *
     * @param {string} original - the name the row had when the editor opened.
     * @param {string} typed - what the field holds now.
     * @returns {'cancel'|'refuse'|'commit'}
     */
    function inlineRenameDecision (original, typed) {
      const name = typeof typed === 'string' ? typed.trim() : ''
      if (name === '' || name === original) return 'cancel'
      return localNameRefusal(name) === undefined ? 'commit' : 'refuse'
    }

    /** The element an inline rename editor should cover: the row's NAME. */
    function renameAnchorOf (row) {
      const button = row.querySelector('button')
      if (button === null) return row
      // The host renders `<icon/><span>name</span>`; the name is the last
      // non-empty span. Never keyed off a host class name — those are hashed
      // per build, so a restyle upstream would silently move the editor.
      const kids = [...button.children]
      for (let at = kids.length - 1; at >= 0; at -= 1) {
        const el = kids[at]
        if (el.tagName === 'SPAN' && String(el.textContent ?? '') !== '') return el
      }
      return button
    }

    /** The one live inline editor, if any. */
    let inlineRenameNode = null

    /** Close the inline editor without committing anything. */
    function closeInlineRename () {
      if (inlineRenameNode === null) return
      const node = inlineRenameNode
      inlineRenameNode = null
      node.remove()
    }

    /**
     * Open the rename editor ON the row, replacing its name in place.
     *
     * The input is portaled to `document.body` rather than inserted into the
     * host's row: React owns that row's children, so a node put inside it would
     * be dropped on the next commit (and a nested interactive inside the row's
     * `<button>` would be invalid markup anyway). A fixed-position overlay
     * sized and placed from the name span's own rect looks identical and
     * survives every re-render.
     *
     * @param {Element} row - the host row being renamed.
     * @param {object} request - path / name / root / sessionId.
     * @returns {boolean} whether the editor opened (false = caller falls back).
     */
    function openInlineRename (row, request) {
      closeInlineRename()
      const original = typeof request.name === 'string' && request.name !== '' ? request.name : entryNameOf(request.path)
      const anchor = renameAnchorOf(row)
      if (typeof anchor?.getBoundingClientRect !== 'function') return false
      const box = anchor.getBoundingClientRect()
      const input = document.createElement('input')
      input.className = 'sshwsp-inline-rename'
      input.type = 'text'
      input.value = original
      input.setAttribute('aria-label', translate('rowmenu.rename'))
      input.spellcheck = false
      input.style.left = `${Math.round(box.left)}px`
      input.style.top = `${Math.round(box.top)}px`
      input.style.width = `${Math.max(80, Math.round(box.width))}px`
      input.style.height = `${Math.max(18, Math.round(box.height))}px`
      document.body.appendChild(input)
      inlineRenameNode = input

      let settled = false
      const settle = () => {
        if (settled) return false
        settled = true
        return true
      }

      /** Commit the typed name: one route call, one refresh, one notice. */
      const commit = async (name) => {
        try {
          await fetchJson(API.rename, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: request.path, newName: name, root: request.root ?? undefined, sessionId: request.sessionId ?? undefined }),
          })
        } catch (err) {
          // The editor is gone by now; the failure is a toast, not a modal.
          // Re-opening the field would be friendlier, but it would also mean
          // the user's next Escape lands somewhere they did not expect.
          notifyUser(toastError(describeRenameFailure(err), err, 'SSHWSP-E-RENAME'))
          return
        }
        refreshFilesPanel()
        notifyUser(translate('rowmenu.renamed'), 'ok')
      }

      const finish = (mode) => {
        if (!settle()) return
        const typed = input.value.trim()
        closeInlineRename()
        if (mode === 'commit') void commit(typed)
      }

      input.addEventListener('keydown', (event) => {
        // The tree's own key handler ignores events inside an input, but
        // stopping here also keeps the dialog-level Escape from closing a
        // panel behind the editor.
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          const decision = inlineRenameDecision(original, input.value)
          if (decision === 'refuse') {
            // Stay in the editor: the name is wrong, the user is still typing.
            input.setAttribute('aria-invalid', 'true')
            input.title = localNameRefusal(input.value.trim()) ?? ''
            return
          }
          finish(decision)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          finish('cancel')
        }
      })
      // Blur commits a real change and cancels anything else — the rule
      // Better Sidebar uses, and the one that makes "click elsewhere" safe.
      input.addEventListener('blur', () => {
        const decision = inlineRenameDecision(original, input.value)
        finish(decision === 'commit' ? 'commit' : 'cancel')
      })
      setTimeout(() => { input.focus(); input.select() }, 0)
      return true
    }

    /**
     * The rename prompt as a modal: one input, prefilled and fully selected.
     *
     * @param {object} request - path / name / root.
     * @returns {void}
     */
    function requestRowRenameDialog (request) {
      const original = typeof request.name === 'string' && request.name !== '' ? request.name : entryNameOf(request.path)
      const input = document.createElement('input')
      input.className = 'sshwsp-input'
      input.type = 'text'
      input.value = original
      input.setAttribute('aria-label', translate('rowmenu.rename'))
      input.spellcheck = false
      const hint = document.createElement('div')
      hint.className = 'sshwsp-field-hint'
      hint.textContent = translate('rowmenu.renameHint')
      const layer = openRowActionDialog({
        title: translate('rowmenu.renameTitle'),
        submitLabel: translate('rowmenu.rename'),
        busyLabel: translate('rowmenu.renaming'),
        focusNode: input,
        buildBody: () => {
          const stack = document.createElement('div')
          stack.className = 'sshwsp-field'
          stack.append(input, hint)
          return stack
        },
        onSubmit: async () => {
          const name = input.value
          const refusal = localNameRefusal(name)
          if (refusal !== undefined) return refusal
          if (name === original) return undefined
          try {
            await fetchJson(API.rename, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: request.path, newName: name, root: request.root ?? undefined, sessionId: request.sessionId ?? undefined }),
            })
          } catch (err) {
            return describeRenameFailure(err)
          }
          refreshFilesPanel()
          notifyUser(translate('rowmenu.renamed'), 'ok')
          return undefined
        },
      })
      // Blur cancels unless focus moved INTO the dialog's own buttons: clicking
      // "Rename" blurs the input first, and cancelling on that blur would make
      // the submit button impossible to click.
      input.addEventListener('blur', () => {
        setTimeout(() => {
          if (rowActionNode === null) return
          if (rowActionNode.contains(document.activeElement)) return
          layer.close()
        }, 0)
      })
      // Enter submits from the one field.
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          layer.dialog.querySelector('.sshwsp-btn-primary')?.click()
        }
      })
      setTimeout(() => { input.select() }, 0)
    }

    /**
     * The new-folder prompt.
     *
     * One text field, the same dialog chrome as rename, and the same inline
     * error rule: a refusal keeps the field open with the text selected, a
     * server refusal leaves the reason beside the button. The parent is the
     * directory row that opened the menu; the server still re-validates every
     * rule at the route boundary.
     *
     * @param {object} request - path / root / sessionId / row.
     * @returns {void}
     */
    function requestRowNewFolder (request) {
      const input = document.createElement('input')
      input.className = 'sshwsp-input'
      input.type = 'text'
      input.placeholder = translate('rowmenu.newFolder')
      input.setAttribute('aria-label', translate('rowmenu.newFolder'))
      input.spellcheck = false
      const hint = document.createElement('div')
      hint.className = 'sshwsp-field-hint'
      hint.textContent = translate('rowmenu.newFolderHint')
      const layer = openRowActionDialog({
        title: translate('rowmenu.newFolderTitle'),
        submitLabel: translate('rowmenu.newFolder'),
        busyLabel: translate('rowmenu.creating'),
        focusNode: input,
        buildBody: () => {
          const stack = document.createElement('div')
          stack.className = 'sshwsp-field'
          stack.append(input, hint)
          return stack
        },
        onSubmit: async () => {
          const name = input.value
          const refusal = folderNameRefusal(name)
          if (refusal !== undefined) return refusal
          let data
          try {
            data = await fetchJson(API.mkdir, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: request.path, name, root: request.root ?? undefined, sessionId: request.sessionId ?? undefined }),
            })
          } catch (err) {
            return describeNewFolderFailure(err)
          }
          refreshFilesPanel()
          selectCreatedRow(data?.path, request)
          notifyUser(translate('rowmenu.created'), 'ok')
          return undefined
        },
      })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          layer.dialog.querySelector('.sshwsp-btn-primary')?.click()
        }
      })
      setTimeout(() => { input.focus() }, 0)
    }

    /**
     * Put the newly created row in the tree's selection and focus it.
     *
     * The host re-lists asynchronously after the reload click, so the row does
     * not exist yet at the moment the route answers. Polling a bounded number
     * of frames is cheaper and less invasive than observing the host's React
     * tree; if the row never appears (the parent closed, the listing changed)
     * the selection is simply left alone.
     *
     * @param {string} targetPath - the path the route answered with.
     * @param {object} request - carries the row or tree body that opened the menu.
     * @returns {void}
     */
    function selectCreatedRow (targetPath, request) {
      const wanted = remoteTargetOf(targetPath)?.remotePath ?? targetPath
      if (typeof wanted !== 'string' || wanted === '') return
      const wantedKey = normalizeRoot(wanted)
      const source = request?.row
      const declared = request?.container
      const container = declared instanceof Element && document.contains(declared)
        ? declared
        : source instanceof Element && document.contains(source) ? treeContainerOf(source) : null
      if (container === null) return
      let tries = 0
      const timer = setInterval(() => {
        tries += 1
        const rows = treeSelectableRows(container)
        const at = rows.findIndex(row => {
          const path = row.getAttribute('data-files-path')
          return path === wanted || path === targetPath || normalizeRoot(path) === wantedKey
        })
        if (at >= 0) {
          clearInterval(timer)
          const path = rows[at].getAttribute('data-files-path')
          setTreeSelection(container, { ids: [path], anchor: at, cursor: at, navigate: null }, rows)
          rows[at].scrollIntoView?.({ block: 'nearest' })
          rows[at].querySelector('button')?.focus?.()
          return
        }
        if (tries >= 15) clearInterval(timer)
      }, 100)
    }

    /** Turn a mkdir failure into a sentence a user can act on. */
    function describeNewFolderFailure (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/already exists|EEXIST/u.test(message)) return translate('rowmenu.targetExists')
      return `${translate('rowmenu.createFail')}: ${message}`
    }

    /** Turn a rename failure into a sentence a user can act on. */
    function describeRenameFailure (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/already exists|EEXIST/u.test(message)) return translate('rowmenu.targetExists')
      return `${translate('rowmenu.renameFail')}: ${message}`
    }

    /** How many entries a delete confirmation counts before it says "and more". */
    const DELETE_COUNT_LIMIT = 200
    /** Concurrent listings while counting; four keeps one confirmation snappy. */
    const DELETE_COUNT_CONCURRENCY = 4
    /** The largest page the listing route will return. */
    const DELETE_COUNT_PAGE = 2000

    /** One remote directory listing, only for counting what a delete removes. */
    async function listRemoteForCount (parts) {
      const query = `?alias=${encodeURIComponent(parts.alias)}&path=${encodeURIComponent(parts.remotePath)}&limit=${DELETE_COUNT_PAGE}`
      const data = await fetchJson(`${API.ls}${query}`)
      return Array.isArray(data?.entries) ? data.entries : []
    }

    /**
     * Count what a delete is about to remove, before the dialog says it.
     *
     * The row menu carries ONE fixed label, so the number has to be stated by
     * the confirmation — and a number the confirmation invented would be worse
     * than none. This walks the same listing the panel uses, breadth-first over
     * a shared queue, up to {@link DELETE_COUNT_LIMIT} entries.
     *
     * A symlink is counted as ONE entry and never entered: the delete route
     * unlinks the link body and does not follow it, so counting the target
     * would overstate what disappears.
     *
     * A local directory is not counted at all (`localUnknown`): the listing
     * route speaks SFTP only, and walking the disk from the page would be a
     * second implementation of the same fence. A directory that fails to list
     * sets `failed` rather than throwing — the confirmation still opens, and
     * says the real scope may be larger.
     *
     * @param {Array<{path: string, name?: string, isDir?: boolean}>} items
     * @param {(counts: object) => void} [onProgress] - called after every listing
     *   that added something, so a slow tree can report what it has so far
     *   instead of leaving the dialog sitting on a spinner.
     * @returns {Promise<{files: number, dirs: number, truncated: boolean, localUnknown: boolean, failed: boolean}>}
     */
    async function countDeleteContents (items, onProgress) {
      const counts = { files: 0, dirs: 0, truncated: false, localUnknown: false, failed: false }
      const pending = []
      let scanned = 0
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.isDir !== true) { counts.files += 1; continue }
        counts.dirs += 1
        const parts = remoteTargetOf(item.path)
        if (parts === null) { counts.localUnknown = true; continue }
        pending.push(parts)
      }
      const room = () => !counts.truncated && scanned < DELETE_COUNT_LIMIT
      let cursor = 0
      const worker = async () => {
        while (cursor < pending.length) {
          const dir = pending[cursor]
          cursor += 1
          let entries
          try {
            entries = await listRemoteForCount(dir)
          } catch {
            counts.failed = true
            continue
          }
          for (const entry of entries) {
            if (!room()) break
            scanned += 1
            if (entry?.type === 'directory' && typeof entry.name === 'string') {
              counts.dirs += 1
              pending.push({ alias: dir.alias, remotePath: dir.remotePath === '/' ? `/${entry.name}` : `${dir.remotePath}/${entry.name}` })
            } else {
              counts.files += 1
            }
          }
          if (scanned >= DELETE_COUNT_LIMIT) counts.truncated = true
          if (typeof onProgress === 'function') onProgress(counts)
        }
      }
      const width = Math.min(DELETE_COUNT_CONCURRENCY, Math.max(1, pending.length))
      await Promise.all(Array.from({ length: width }, worker))
      return counts
    }

    /**
     * The delete confirmation: what will go, how much of it, and the warning.
     *
     * The ROW MENU carries one fixed label ("删除") whatever the target count,
     * so this dialog is the only place the scope is stated. Its title, its name
     * list and its counts all come from the SAME `items` array the delete later
     * runs over — never from a second pass over the selection.
     *
     * The dialog opens IMMEDIATELY. Counting what sits under a directory walks
     * the same listing the panel uses, and on a slow link that walk is not fast:
     * fourteen folders of one /home tree took four minutes' worth of round
     * trips, and a confirmation that appears only after the last one is a
     * button that looks dead. So the title is answered from the SELECTION (one
     * file, N entries) at once, the body says "counting…", and the numbers land
     * in the same two nodes when the walk finishes. A single directory cannot
     * name its size before that walk, so it opens with the scope-neutral
     * sentence and is refined in place.
     *
     * The batch is performed sequentially so one failure does not hide the rows
     * that did go.
     *
     * @param {object} request - items [{path, name, isDir}], root, sessionId.
     * @returns {Promise<void>}
     */
    async function requestRowDelete (request) {
      const items = Array.isArray(request.items) ? request.items : []
      if (items.length === 0) return
      const hasDirectory = items.some(item => item.isDir === true)
      const singleDir = items.length === 1 && items[0].isDir === true
      // Everything the selection alone can answer, answered now.
      const titleNow = items.length > 1
        ? translate('rowmenu.deleteMany', { count: items.length })
        : singleDir
          ? translate('rowmenu.deleteOneDirAll')
          : translate('rowmenu.deleteOneFile')

      const list = document.createElement('div')
      list.className = 'sshwsp-field'
      const shown = items.slice(0, 5).map(item => item.name ?? entryNameOf(item.path)).join('、')
      const more = items.length > 5 ? ' ' + translate('rowmenu.deleteMore', { count: items.length - 5 }) : ''
      const names = document.createElement('div')
      names.className = 'sshwsp-field-hint'
      names.textContent = shown + more
      list.appendChild(names)
      // The three count lines are created up front and filled in later, so the
      // dialog does not grow a new row under the pointer mid-read.
      const counted = document.createElement('div')
      counted.className = 'sshwsp-field-hint'
      const partial = document.createElement('div')
      partial.className = 'sshwsp-field-hint'
      const capped = document.createElement('div')
      capped.className = 'sshwsp-field-hint'
      if (hasDirectory) {
        counted.textContent = translate('rowmenu.deleteCountPending')
        list.append(counted, partial, capped)
      }
      const warning = document.createElement('div')
      warning.className = 'sshwsp-warn'
      warning.textContent = hasDirectory
        ? `${translate('rowmenu.deleteDirWarning')} ${translate('rowmenu.deleteIrreversible')}`
        : translate('rowmenu.deleteIrreversible')
      list.appendChild(warning)

      let closed = false
      const dialog = openRowActionDialog({
        title: titleNow,
        submitLabel: translate('rowmenu.delete'),
        busyLabel: translate('rowmenu.deleting'),
        buildBody: () => list,
        onSubmit: async () => {
          let done = 0
          let firstError = ''
          for (const item of items) {
            try {
              await fetchJson(API.deleteEntry, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: item.path, root: request.root ?? undefined, sessionId: request.sessionId ?? undefined }),
              })
              done += 1
            } catch (err) {
              if (firstError === '') firstError = err instanceof Error ? err.message : String(err)
            }
          }
          closed = true
          refreshFilesPanel()
          if (done === items.length) {
            notifyUser(translate('rowmenu.deleteDone', { count: done }), 'ok')
            return undefined
          }
          notifyUser(toastError(translate('rowmenu.deletePartial', { done, failed: items.length - done }), firstError, 'SSHWSP-E-DELETE'))
          return `${translate('rowmenu.deleteFail')}: ${firstError}`
        },
      })
      if (!hasDirectory) return

      /** Paint the counts known so far into the two lines that were reserved. */
      const paint = (counts) => {
        if (closed) return
        const filesShown = counts.truncated ? `${DELETE_COUNT_LIMIT}+` : String(counts.files)
        counted.textContent = counts.localUnknown
          ? translate('rowmenu.deleteCountLocal')
          : translate('rowmenu.deleteCounts', { dirs: counts.dirs, files: filesShown })
        partial.textContent = counts.failed ? translate('rowmenu.deleteCountFailed') : ''
        capped.textContent = counts.truncated ? translate('rowmenu.deleteCountTruncated', { limit: DELETE_COUNT_LIMIT }) : ''
        // A single directory's title names its size, so it can only be final
        // once the walk is over — but "everything inside it" was never a lie.
        if (singleDir && !counts.localUnknown) {
          dialog.setTitle?.(counts.files === 0 && !counts.truncated
            ? translate('rowmenu.deleteOneEmptyDir')
            : translate('rowmenu.deleteOneDir', { count: filesShown }))
        }
      }
      const counts = await countDeleteContents(items, paint)
      paint(counts)
    }

    // =========================================================================
    // File-panel header actions
    // =========================================================================

    /**
     * The transfer-queue entry for DSH's own "Files" panel.
     *
     * The header used to carry an upload button as well. It is gone on
     * purpose: uploading a file into the listed directory is offered by the
     * directory browser and by the tree row menu, and the second header button
     * competed for the same narrow strip as the one control that must stay
     * reachable — this one.
     *
     * It renders for a remote directory and for no other: a local listing has
     * nothing this queue could act on, and the header's actions should belong
     * to the folder on screen rather than to some other session's host. Within
     * a remote listing it renders even when the queue is empty — it used to
     * appear only while something was in flight, so the progress surface
     * vanished the moment the queue drained; a user looking for it could not
     * tell "nothing is transferring" from "this control was never here". The
     * glyph turns the queue's blue and wears its ring only while a transfer is
     * queued or running, so an idle button stays quiet without disappearing. A
     * transfer that starts from the directory browser and outlives the panel
     * keeps reporting through that dialog's inline strip and the completion
     * notice, not here.
     *
     * The button also publishes the directory the panel is showing (see the
     * `data-sshwsp-*` attributes below); the document-wide right-click handler
     * receives no props and needs it to name the folder the menu acts on.
     */
    function FilePanelTransferActions (props) {
      const absolutePath = typeof props?.absolutePath === 'string' ? props.absolutePath : ''
      const t = props?.t ?? translate
      const remote = remoteTargetOf(absolutePath)
      const queue = useTransferQueue()
      const [queueOpen, setQueueOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState({ top: 56, right: 16 })
      const queueButtonRef = React.useRef(null)
      // The popover is anchored to the button in viewport coordinates and
      // recomputed on resize and scroll: the Files panel can be collapsed or a
      // neighbouring pane can push it sideways while the overlay is open.
      React.useLayoutEffect(() => {
        if (!queueOpen) return undefined
        const measure = () => {
          const rect = queueButtonRef.current?.getBoundingClientRect?.()
          if (rect === undefined || rect === null) {
            setAnchor({ top: 56, right: 16 })
            return
          }
          const top = Math.min(Math.max(8, rect.bottom + 6), Math.max(8, window.innerHeight - 120))
          const right = Math.max(8, window.innerWidth - rect.right)
          setAnchor({ top, right })
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [queueOpen])
      const progress = transferQueueProgress(queue.items)
      const activeCount = progress.active
      // The mark carries the state; the accessible name carries the count it
      // no longer prints as a badge. One sentence serves both the tooltip and
      // the screen reader: "Show transfer progress (3)".
      const label = activeCount > 0 ? t('queue.openCount', { count: activeCount }) : t('queue.open')

      // A local listing keeps DSH's own header. The queue belongs to remote
      // workspaces, and the entry carries the alias of the folder on screen:
      // on a local path there is no alias to carry, and a button offering some
      // other session's host would be the kind of half-true control this
      // plugin avoids elsewhere. The dialog strip and the completion notice
      // still report a transfer that started elsewhere.
      if (remote === null) return null

      return jsxs(Fragment, { children: [
        jsx('button', {
          ref: queueButtonRef,
          type: 'button',
          className: 'sshwsp-fileaction sshwsp-fileaction-queue' + (activeCount > 0 ? ' sshwsp-fileaction-queue-active' : ''),
          title: label,
          'aria-label': label,
          'aria-expanded': queueOpen ? 'true' : 'false',
          // The directory this panel is showing, published for the delegated
          // right-click handler. That handler is document-wide and receives no
          // props, so the empty space below the rows had no way to name the
          // folder the menu would act on. This button is the one element in the
          // header that knows both halves (alias and remote path), so it
          // carries them rather than the menu parsing the `ssh://` string back
          // out of a header that a future tweak could reword. The local case
          // never reaches here (the entry is remote-only), so a local listing's
          // blank gesture keeps the browser's own menu.
          'data-sshwsp-dir': remote.remotePath,
          'data-sshwsp-alias': remote.alias,
          onClick: () => setQueueOpen(open => !open),
          children: activeCount > 0
            ? React.createElement(TransferProgressIcon, {
                size: 16,
                direction: progress.direction,
                percent: progress.percent,
                live: progress.live,
              })
            : React.createElement(DownloadIcon),
        }),
        queueOpen && jsx(TransferQueuePanel, { anchor, onClose: () => setQueueOpen(false), t }),
      ]})
    }

    let taskMenuEl = null
    let taskMenuDispose = null
    /** The element that opened the row menu; focus returns there on close. */
    let taskMenuOpener = null

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
      // Return focus to whatever opened the menu, as the WAI-ARIA menu pattern
      // requires. Without it, closing left focus on a removed node — which
      // sends a keyboard user to the top of the document.
      const opener = taskMenuOpener
      taskMenuOpener = null
      if (opener !== null && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
    }

    /**
     * One distinct mark per row-menu verb, drawn on the same 16-unit grid.
     *
     * The icon column is scanned before the labels, so one file/folder mark
     * shared by add, copy, rename and delete made four different actions look
     * alike. Transfers keep the shared tray (TRAY_ARROW_PATHS); these verbs get
     * outlines of their own. `file` remains the fallback for an unnamed kind.
     */
    const MENU_GLYPH_PATHS = {
      addToTask: [
        'M3.5 2.5h9a1 1 0 011 1v7a1 1 0 01-1 1H8.5l-2.5 2v-2H3.5a1 1 0 01-1-1v-7a1 1 0 011-1z',
        'M8 4.5v4.5',
        'M5.75 6.75h4.5',
      ],
      copy: [
        'M10.5 4.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h.5',
        'M5.5 5.5h7a1 1 0 011 1v6a1 1 0 01-1 1h-7a1 1 0 01-1-1v-6a1 1 0 011-1z',
      ],
      rename: [
        'M11.3 2.7l2 2L5.5 12.5 2.8 13.2l.7-2.7L11.3 2.7z',
        'M10 4l2 2',
      ],
      delete: [
        'M3 4.5h10',
        'M6.2 4.5V3.4a.9.9 0 01.9-.9h1.8a.9.9 0 01.9.9v1.1',
        'M4.3 4.5l.5 8.4a1.4 1.4 0 001.4 1.3h3.6a1.4 1.4 0 001.4-1.3l.5-8.4',
        'M6.5 7.4v4.2',
        'M9.5 7.4v4.2',
      ],
      newFolder: [
        'M2.5 4.5a1 1 0 011-1h3l1.5 1.5h3.5a1 1 0 011 1v5.5a1 1 0 01-1 1h-8a1 1 0 01-1-1v-7z',
        'M8 7v4',
        'M6 9h4',
      ],
      file: ['M4 2h5.5L13 5.5V13a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z', 'M9.5 2v3.5H13'],
    }

    /** The svg for one menu row: the action's own mark, or the file fallback. */
    function createMenuIcon (kind = 'file') {
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
      const paths = TRAY_ARROW_PATHS[kind] ?? MENU_GLYPH_PATHS[kind] ?? MENU_GLYPH_PATHS.file
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
     * One ROW-MENU action: single line, icon, 24px row with a 12px label.
     *
     * The menu is 220px wide and carries at most seven items, so it has no room
     * for the second "description" line the previous version used for the full
     * path and the overwrite policy. A disabled item keeps its reason in the
     * native tooltip, because a disabled button is not focusable and explaining
     * itself inside the row would cost the line this menu no longer spends.
     */
    function createTransferItem ({ label, disabled = false, onSelect, reason, glyph = 'file' }) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'sshwsp-menuitem'
      item.setAttribute('role', 'menuitem')
      if (disabled) item.disabled = true
      if (typeof reason === 'string' && reason !== '') item.title = reason
      const icon = document.createElement('span')
      icon.className = 'sshwsp-menuitem-icon'
      icon.appendChild(createMenuIcon(glyph))
      const textWrap = document.createElement('span')
      textWrap.className = 'sshwsp-menuitem-text'
      const title = document.createElement('span')
      title.className = 'sshwsp-menuitem-title'
      title.textContent = label
      textWrap.appendChild(title)
      item.append(icon, textWrap)
      if (!disabled) {
        item.addEventListener('click', () => {
          closeTaskMenu()
          onSelect()
        })
      }
      return item
    }

    /**
     * Open one plugin menu at the pointer, clamped to the viewport.
     *
     * This owns the whole floating lifecycle — focus, keyboard, dismissal and
     * focus restoration — so `openTaskMenu` and `openLocalBlankMenu` cannot
     * grow two close paths. `fill` appends the menu's own items.
     */
    function openMenuAt (x, y, fill) {
      closeTaskMenu()
      const el = document.createElement('div')
      el.className = 'sshwsp-flowmenu'
      el.setAttribute('role', 'menu')
      el.setAttribute(TASK_MENU_ATTR, '1')
      el.style.left = `${Math.min(Math.max(8, x), Math.max(8, window.innerWidth - FLOW_MENU_WIDTH - 8))}px`
      el.style.top = `${Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 120))}px`
      if (typeof fill === 'function') fill(el)
      document.body.appendChild(el)
      taskMenuEl = el
      taskMenuOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const firstEnabled = () => [...el.querySelectorAll('[role="menuitem"]:not([disabled])')]
      firstEnabled()[0]?.focus?.()

      const onDown = (event) => {
        const target = event.target
        if (target instanceof Node && el.contains(target)) return
        closeTaskMenu()
      }
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeTaskMenu()
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          closeTaskMenu()
          return
        }
        const items = firstEnabled()
        if (items.length === 0) return
        const current = items.indexOf(document.activeElement)
        if (current < 0 && !el.contains(document.activeElement)) return
        const next = nextMenuIndex(event.key, current, items.length)
        if (next === null) return
        event.preventDefault()
        items[next].focus()
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
      return el
    }

    /** Open the row menu at the pointer, clamped to the viewport. */
    function openTaskMenu (ctx, absPath, isDir, root, x, y, sessionId, selection) {
      // The row that opened the menu, and the one decision of what this menu
      // acts on. `selection` is the tree bridge's answer and is undefined for
      // the dialog and for a single row.
      const clickedRow = { path: absPath, name: entryNameOf(absPath), isDir }
      const resolved = resolveTargets(clickedRow, selection?.items)
      const targets = resolved.targets
      const addable = targets.some(item => mentionToken(item.path, root, item.isDir) !== null)

      openMenuAt(x, y, (el) => {
        // First item: add the row to the composer's task. Its reason now rides in
        // the native tooltip — the menu gave up its description line to stay a
        // quick action list.
        el.appendChild(createTransferItem({
          label: translate('mention.addToTask'),
          glyph: 'addToTask',
          disabled: !addable,
          reason: addable ? '' : translate('mention.unrepresentable'),
          onSelect: () => addPathsToTask(ctx, targets, root),
        }))
        // Two groups: the reference/transfer actions, then the destructive pair.
        // The menu used to carry one rule and seven actions with a two-line body
        // each, which read as a second panel; a second rule above rename/delete
        // keeps "these two change the file" visible without adding a description
        // line back.
        el.appendChild(createMenuSeparator())
        const remote = remoteTargetOf(absPath)
        // ONE download item with ONE label, whatever the selection is. The count
        // this menu used to print ("下载所选（3 项）") made the label the only
        // place the target set was stated, so a right-click that collapsed the
        // selection could still promise three rows and act on one. The target set
        // is decided once by `resolveTargets` above; the number is reported where
        // the consequence is — the destination dialog's subtitle, then the queue.
        //
        // It stays on screen for a local row — disabled, reason in the tooltip —
        // instead of vanishing: a menu whose items appear and disappear with the
        // row's kind reads as broken, and the reason is one hover away.
        const downloadable = targets.filter(item => remoteTargetOf(item.path) !== null)
        el.appendChild(createTransferItem({
          label: translate('transfer.download'),
          glyph: 'download',
          disabled: downloadable.length === 0,
          // The reason describes a DISABLED item. Handing it to an enabled one
          // made a perfectly downloadable remote row claim it was not on the
          // host at all — the tooltip contradicted the click that worked.
          reason: downloadable.length === 0 ? translate('transfer.notRemote') : '',
          onSelect: () => { void downloadRows(downloadable, ctx) },
        }))
        if (remote !== null) {
          el.appendChild(createTransferItem({
            label: translate('transfer.upload'),
            glyph: 'upload',
            // "Which name wins" is a property of this upload, so it stays
            // reachable as a tooltip even though the menu has no second line.
            reason: `${isDir ? absPath : remoteDirOf(absPath)} · ${translate('queue.overwrite')}`,
            onSelect: () => uploadTreeRow(absPath, isDir),
          }))
          // Copy the spelling the rest of the product uses. Copying the LOCAL
          // twin or dropping the `ssh://` prefix would paste a path that resolves
          // on the wrong machine.
          el.appendChild(createTransferItem({
            label: translate('rowmenu.copyPath'),
            glyph: 'copy',
            reason: absPath,
            onSelect: () => { void copyRowPath(absPath) },
          }))
        }
        // Rename and delete cover the remote row AND the local row — the same
        // pair of items, the same pair of routes, and the same confirmation.
        // They get their own rule: without it the menu read as one list of six
        // equally safe actions, and "this renames the file" was the one fact the
        // single-line layout had no room to say.
        const lastBeforeDestructive = el.lastElementChild
        if (lastBeforeDestructive !== null && !String(lastBeforeDestructive.className).includes('sshwsp-menusep')) {
          el.appendChild(createMenuSeparator())
        }
        // New folder sits in the same mutation group as rename/delete, but only
        // for a remote directory: the host's own tree owns local creation.
        const newFolderItem = remote !== null && isDir
          ? createTransferItem({
              label: translate('rowmenu.newFolder'),
              glyph: 'newFolder',
              onSelect: () => requestRowNewFolder({ path: absPath, root, sessionId, row: rowOfPath(absPath) }),
            })
          : null
        const renameItem = createTransferItem({
          label: translate('rowmenu.rename'),
          glyph: 'rename',
          onSelect: () => requestRowRename({ path: absPath, name: entryNameOf(absPath), root, sessionId, row: rowOfPath(absPath) }),
        })
        const deleteItem = createTransferItem({
          label: translate('rowmenu.delete'),
          glyph: 'delete',
          // The same fixed label whether one row or six will go. The confirmation
          // names the count, the kind and the subtree it is about to remove — the
          // menu cannot, because it is read before the target set is confirmed.
          onSelect: () => { void requestRowDelete({ items: targets, root, sessionId }) },
        })
        if (newFolderItem !== null) el.appendChild(newFolderItem)
        el.append(renameItem, deleteItem)
        // The mode is asked for asynchronously, and the two items are DISABLED
        // when it turns out to be read-only: offering an action and then
        // refusing it on click is not "disabled", it is "broke". A lookup that
        // fails leaves them enabled; the server's refusal is still the boundary.
        void mutationPolicyOf({ sessionId, root }).then(policy => {
          if (policy === null) return
          // A LOCAL path with no owning session cannot be proven inside any
          // workspace, so the actions are disabled with that reason; the server's
          // refusal remains the boundary either way.
          const localUnknown = remoteTargetOf(absPath) === null && policy.sessionFound !== true
          if (!policy.readOnly && !localUnknown) return
          const reason = policy.readOnly ? translate('rowmenu.readonly') : translate('rowmenu.localRootUnknown')
          for (const entry of [newFolderItem, renameItem, deleteItem]) {
            if (entry === null) continue
            entry.disabled = true
            entry.title = reason
          }
        })

      })
    }

    /**
     * The local blank-space menu: create one folder or copy the directory path.
     *
     * The target is the directory the empty space belongs to, already resolved
     * and fenced by `localBlankTargetOf`. This menu is deliberately not the row
     * menu: no upload, download, rename, delete or add-to-task items.
     */
    function openLocalBlankMenu (target, x, y) {
      const { dir, root, sessionId, container } = target
      openMenuAt(x, y, (el) => {
        const create = createTransferItem({
          label: translate('rowmenu.newFolder'),
          glyph: 'newFolder',
          onSelect: () => requestRowNewFolder({ path: dir, root, sessionId, row: null, container }),
        })
        const copy = createTransferItem({
          label: translate('rowmenu.copyPath'),
          glyph: 'copy',
          reason: dir,
          onSelect: () => { void copyRowPath(dir) },
        })
        el.append(create, copy)
        // Only CREATE is gated. The policy lookup is fire-and-forget so opening
        // the menu never waits on a request; a failed lookup leaves the item
        // enabled, and the server's refusal is still the boundary.
        void mutationPolicyOf({ sessionId, root }).then(policy => {
          if (policy === null) return
          const unknown = policy.sessionFound !== true
          if (!policy.readOnly && !unknown) return
          create.disabled = true
          create.title = policy.readOnly ? translate('rowmenu.readonly') : translate('rowmenu.localRootUnknown')
        })
      })
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
    /** Parse the multi-row payload carried by a drag, when the closure lost it. */
    function dragPayloadFrom (event) {
      try {
        const raw = event.dataTransfer?.getData?.(DRAG_MIME)
        if (typeof raw !== 'string' || raw === '') return null
        const parsed = JSON.parse(raw)
        if (parsed?.v !== 1 || !Array.isArray(parsed.items)) return null
        return parsed
      } catch {
        return null
      }
    }

    /** A browser text selection left in a tree row by the drag gesture. */
    function clearTreeTextSelection () {
      try {
        const selection = typeof window === 'undefined' ? null : window.getSelection?.()
        if (selection === null || selection === undefined || selection.rangeCount === 0) return
        const node = selection.anchorNode
        const element = node !== null && typeof node.closest === 'function' ? node : node?.parentElement
        if (element !== null && element !== undefined && typeof element.closest === 'function' &&
            element.closest(TREE_ROW_SELECTOR) !== null) {
          selection.removeAllRanges()
        }
      } catch { /* best-effort */ }
    }
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
        const container = treeContainerOf(row)
        const clicked = { path, name: entryNameOf(path), isDir: kind === 'directory' }
        const resolved = resolveTargets(clicked, container === null ? [] : treeSelectedItems(container))
        if (resolved.collapsed && container !== null) {
          const rows = treeSelectableRows(container)
          const index = rows.indexOf(row)
          if (index >= 0) reduceTree(container, { type: 'point', index, ctrl: false, shift: false, append: false })
        }
        const items = resolved.targets.map(item => ({ path: item.path, isDir: item.isDir === true }))
        const payload = { v: 1, items, root: treeRootOf(row) }
        dragPayload = payload
        const transfer = event.dataTransfer
        if (transfer !== null) {
          transfer.setData(DRAG_MIME, JSON.stringify(payload))
          transfer.effectAllowed = 'copy'
        }
      }

      const onDragEnter = (event) => {
        if (!firstClaim(event)) return
        if (filesTransferOf(event) === null) return
        // A new OS gesture must kill any stale internal payload from a drag
        // that ended without dragend; otherwise the composer branch could
        // claim it.
        dragPayload = null
        setDropCard(null)
        hideDropCaret()
        const plan = osDropPlan(event.target)
        if (plan === null) {
          clearOsDropHighlight()
          return
        }
        event.preventDefault()
        event.stopPropagation() // suppress the host's "drop files here" overlay
        setOsDropHighlight(plan)
      }

      const onDragOver = (event) => {
        if (!firstClaim(event)) return
        const transfer = filesTransferOf(event)
        if (transfer !== null) {
          const plan = osDropPlan(event.target)
          if (plan === null) {
            clearOsDropHighlight()
            return
          }
          event.preventDefault()
          event.stopPropagation()
          transfer.dropEffect = 'copy'
          setOsDropHighlight(plan)
          return
        }
        if (dragPayload === null) {
          hideDropCaret()
          return
        }
        const target = event.target
        const card = target instanceof Element ? target.closest(COMPOSER_CARD_SELECTOR) : null
        setDropCard(card)
        if (card === null) {
          hideDropCaret()
          return
        }
        // The caret is a hint, not an edit: dragover only paints it; drop
        // recomputes the same mapping from the event that actually lands.
        const point = dropPointFromEvent(event, card)
        if (point === null) hideDropCaret()
        else showDropCaret(point)
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      }

      const onDrop = (event) => {
        // Claimed before any state is touched: a stale instance's listener may
        // run first and clear its own payload, but only one materialization
        // gets to insert.
        if (!firstClaim(event)) return
        const transfer = filesTransferOf(event)
        if (transfer !== null) {
          const plan = osDropPlan(event.target)
          dragPayload = null
          setDropCard(null)
          hideDropCaret()
          clearOsDropHighlight()
          if (plan === null) return // outside the tree: the host keeps it
          event.preventDefault() // never let the browser open the file
          event.stopPropagation() // never let the host attach it
          if (plan.refusal === 'local') {
            notifyUser(toastError(translate('osdrop.local'), plan.root, 'SSHWSP-E-OSDROP-LOCAL'))
            return
          }
          const files = Array.from(transfer.files ?? [])
          if (files.length === 0) return
          const split = splitDroppedFolders(transfer, files)
          if (split.files.length > 0) {
            // The refusal rides on the batch toast, not beside it: one toast at
            // a time is the rule, so a second sentence opened here would erase
            // the upload's own line a moment later (or be erased by it).
            queueTreeUploads(plan.alias, plan.dir, split.files, split.folders)
          } else if (split.folders.length > 0) {
            // Nothing was queued, so there is no batch to carry the note — the
            // refusal is the whole outcome and stands on its own.
            notifyUser(toastError(
              translate('osdrop.folders', { names: dropFolderNames(split.folders) }),
              split.folders.map(file => file.name),
              'SSHWSP-E-OSDROP-FOLDER',
            ))
          }
          return
        }
        const payload = dragPayload ?? dragPayloadFromEvent(event)
        dragPayload = null
        setDropCard(null)
        hideDropCaret()
        if (payload === null || !Array.isArray(payload.items) || payload.items.length === 0) return
        const target = event.target
        const card = target instanceof Element ? target.closest(COMPOSER_CARD_SELECTOR) : null
        if (card === null) return
        event.preventDefault()
        event.stopPropagation()
        // Recompute from the drop event, never reuse a dragover cache: HMR can
        // leave dragover and drop in different materializations.
        const at = dropOffsetFromEvent(event, card)
        addPathsToTask(ctx, payload.items, payload.root, card, at)
      }

      const onDragLeave = (event) => {
        if (filesTransferOf(event) === null) return
        const related = event.relatedTarget
        if (related instanceof Element && related.closest(OS_TREE_SELECTOR) !== null) return
        clearOsDropHighlight()
      }

      const onDragEnd = (event) => {
        // Not claimed: every instance must clear its own carried payload, and
        // clearing is idempotent. A drag from a row can leave a text selection
        // in that row; the caret belongs to the composer, not the filename.
        dragPayload = null
        setDropCard(null)
        hideDropCaret()
        clearOsDropHighlight()
        clearTreeTextSelection()
        void event
      }

      document.addEventListener('dragstart', onDragStart, true)
      document.addEventListener('dragenter', onDragEnter, true)
      document.addEventListener('dragover', onDragOver, true)
      document.addEventListener('dragleave', onDragLeave, true)
      document.addEventListener('drop', onDrop, true)
      document.addEventListener('dragend', onDragEnd, true)

      return () => {
        document.removeEventListener('dragstart', onDragStart, true)
        document.removeEventListener('dragenter', onDragEnter, true)
        document.removeEventListener('dragover', onDragOver, true)
        document.removeEventListener('dragleave', onDragLeave, true)
        document.removeEventListener('drop', onDrop, true)
        document.removeEventListener('dragend', onDragEnd, true)
      }
    }

    /** Delegated right-click listener: the row menu. Returns a detach function. */
    function installTreeMenuBridge (ctx) {
      if (typeof document === 'undefined') return () => {}
      /**
       * Open the menu for the row the event landed on.
       *
       * Shared by the pointer path and the keyboard path so both compute the
       * anchor the same way: a keyboard-opened menu must appear at the row, not
       * at the top-left corner.
       */
      const openForRow = (row, event) => {
        const kind = rowReferenceKind(row)
        if (kind === null) return false
        const path = row.getAttribute('data-files-path')
        if (path === null || path === '') return false
        const box = typeof row.getBoundingClientRect === 'function' ? row.getBoundingClientRect() : null
        const x = event?.clientX ?? (box === null ? 8 : box.left + 12)
        const y = event?.clientY ?? (box === null ? 8 : box.top + 12)
        // A right-click inside an existing multi-row selection offers the batch
        // verb for THAT selection; right-clicking anywhere else offers the
        // single-row actions the menu has always had. The row under the pointer
        // is honoured either way — it is what the other items act on.
        // A right-click is a SELECTION gesture before it is a menu gesture:
        // the reducer's `point` action collapses the selection onto the row
        // unless the row is already part of it, which is the rule every file
        // manager follows and the one that keeps "download selected" honest.
        // The gesture is fed through the same reducer as clicks, so Ctrl and
        // Shift on the secondary button mean what they mean on the primary one.
        const container = treeContainerOf(row)
        if (container !== null) {
          const rows = treeSelectableRows(container)
          const index = rows.indexOf(row)
          if (index >= 0) {
            reduceTree(container, {
              type: 'point',
              index,
              ctrl: event?.ctrlKey === true || event?.metaKey === true,
              shift: event?.shiftKey === true,
              append: (event?.ctrlKey === true || event?.metaKey === true) && event?.shiftKey === true,
            })
          }
        }
        const selected = container === null ? [] : treeSelectedItems(container)
        // The selection goes to the menu UNCONDITIONALLY. `resolveTargets` is
        // the one place that decides between "this row" and "these rows"; a
        // second copy of that rule here (only when the row happened to be in a
        // batch) is a second answer waiting to disagree with the action.
        openTaskMenu(ctx, path, kind === 'directory', treeRootOf(row), x, y, undefined, { items: selected })
        return true
      }

      /**
       * Open the menu for the DIRECTORY a panel is showing.
       *
       * Right-clicking the empty space below the rows used to do nothing at
       * all: the handler looked for a row and returned, so the one gesture that
       * means "what can I do here?" answered nothing exactly where "here" is
       * the folder itself. The folder could not be read before because the
       * delegated listener is document-wide and gets no props; the transfer
       * button this plugin already renders in that panel's header publishes the
       * alias and directory it parsed from `absolutePath`, so the menu names
       * the same directory the header is showing instead of guessing one.
       *
       * The search for that button is bounded by the PANEL the pointer is in,
       * not by the document: see `blankMenuScopeOf`. Everything outside a Files
       * panel — the conversation above all — returns false and keeps the
       * browser's menu.
       */
      const openForBlank = (event, target) => {
        const scope = blankMenuScopeOf(target)
        if (scope === null) return false
        // Menu actions all parse the `ssh://` spelling; handing them the bare
        // remote path would read as a LOCAL path on the composing machine.
        const absPath = `ssh://${scope.alias}${scope.dir.startsWith('/') ? scope.dir : `/${scope.dir}`}`
        openTaskMenu(ctx, absPath, true, scope.root, event.clientX, event.clientY)
        return true
      }

      const onContextMenu = (event) => {
        if (!firstClaim(event)) return
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest(`[${TASK_MENU_ATTR}]`) !== null) {
          closeTaskMenu()
          return
        }
        const row = target.closest(TREE_ROW_SELECTOR)
        if (row !== null) {
          const rowButton = row.querySelector('button')
          const onButton = rowButton !== null && rowButton.contains(target)
          // Everything inside a row belongs to that row EXCEPT the nested list of
          // an expanded directory: that list is blank space for the directory
          // itself. Treating it as a row gesture would open the row menu (or
          // nothing, on a local tree) instead of the blank menu.
          const nestedBlank = !onButton && row.getAttribute('data-files-entry') === 'directory'
          if (!nestedBlank) {
            if (!openForRow(row, event)) return
            event.preventDefault()
            event.stopPropagation()
            return
          }
        }
        // A local tree answers with the directory the empty space belongs to;
        // a remote tree keeps its header-button path.
        const local = localBlankTargetOf(target)
        if (local !== null) {
          openLocalBlankMenu(local, event.clientX, event.clientY)
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (!openForBlank(event, target)) return
        event.preventDefault()
        event.stopPropagation()
      }

      /**
       * The keyboard path, which did not exist.
       *
       * A row menu reachable only by right-click is unreachable for anyone
       * without a mouse — and it is the only way to "download / upload / add to
       * task" for a file-tree row. Shift+F10 and the Windows menu key are the
       * conventional gestures; Enter and Space are included because the rows
       * carry `role="button"`-like affordances elsewhere in the tree.
       */
      const onKeyDown = (event) => {
        if (event.key === 'F2' || event.key === 'Delete') {
          // The Windows row gestures, on a row the keyboard already owns.
          // `target` is where focus is; if it is an input (a rename field opened
          // from somewhere else), this is not a tree shortcut and must not fire.
          const target = event.target
          if (!(target instanceof Element)) return
          if (target.closest('input, textarea, [contenteditable="true"]') !== null) return
          const row = target.closest(TREE_ROW_SELECTOR) ?? (document.activeElement instanceof Element ? document.activeElement.closest(TREE_ROW_SELECTOR) : null)
          if (row === null) return
          const kind = rowReferenceKind(row)
          const path = row.getAttribute('data-files-path')
          if (kind === null || path === null || path === '') return
          const root = treeRootOf(row)
          event.preventDefault()
          event.stopPropagation()
          void mutationPolicyOf({ root }).then((policy) => {
            if (policy?.readOnly === true) {
              notifyUser(toastError(translate('rowmenu.readonly'), root, 'SSHWSP-E-READONLY'))
              return
            }
            if (policy !== null && policy.sessionFound !== true && remoteTargetOf(path) === null) {
              notifyUser(toastError(translate('rowmenu.localRootUnknown'), path, 'SSHWSP-E-LOCAL-ROOT'))
              return
            }
            if (event.key === 'F2') {
              requestRowRename({ path, name: entryNameOf(path), root, row })
              return
            }
            // Delete must act on the set the row menu would act on, or the two
            // gestures disagree about what "delete" means. The collapse runs
            // through the shared reducer FIRST, so a selection that does not
            // include this row has already narrowed before it is read.
            const container = treeContainerOf(row)
            if (container !== null) {
              const rows = treeSelectableRows(container)
              const index = rows.indexOf(row)
              if (index >= 0) reduceTree(container, { type: 'point', index, ctrl: false, shift: false, append: false })
            }
            const resolved = resolveTargets(
              { path, name: entryNameOf(path), isDir: kind === 'directory' },
              container === null ? [] : treeSelectedItems(container),
            )
            void requestRowDelete({ items: resolved.targets, root })
          })
          return
        }
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        const target = event.target
        if (!(target instanceof Element)) return
        const row = target.closest(TREE_ROW_SELECTOR)
        if (row === null) return
        if (!openForRow(row, null)) return
        event.preventDefault()
        event.stopPropagation()
      }

      document.addEventListener('contextmenu', onContextMenu, true)
      document.addEventListener('keydown', onKeyDown, true)
      return () => {
        document.removeEventListener('contextmenu', onContextMenu, true)
        document.removeEventListener('keydown', onKeyDown, true)
      }
    }

    // =========================================================================
    // Host file tree: Windows-style multi-select
    // =========================================================================
    //
    // The tree in DSH's own Files tab belongs to the host, so this plugin
    // cannot own its selection model — there is no row-level seat, and the
    // store behind it has no `selected` field at all. What it CAN do is what
    // the row menu and the drag bridge already do: decorate host rows with
    // classes of our own, and act through document-level capture listeners.
    // Nothing here rewrites host JSX, replaces a host node or reads a private
    // store; the rows keep their own click handlers and React keeps owning
    // them. Selection state is ours, shaped by `selectReduce` — the SAME
    // reducer the browser tab and the directory dialog use, so the three
    // surfaces cannot grow three gesture dialects.
    //
    // The interesting rule is the conflict: a PLAIN click on a directory
    // navigates (the host expands it), while a Ctrl/Shift click on that same
    // directory only selects it. `selectReduce` states exactly that by
    // returning `navigate === null` for every modifier gesture, so the bridge
    // below does not re-decide it — it suppresses the host's click precisely
    // when the reducer declined to navigate.
    const TREE_SELECTED_CLASS = 'sshwsp-tree-row-selected'
    const TREE_CURSOR_CLASS = 'sshwsp-tree-row-cursor'
    const TREE_BODY_SELECTOR = '[data-files-body]'

    /** One tree container's selection, keyed by the element itself. */
    const treeSelectionStates = new WeakMap()
    /** Every tree container seen so far (a WeakMap cannot be iterated). */
    const treeSelectionContainers = new Set()
    /**
     * The selection a workspace remembers across a tab remount.
     *
     * The host unmounts a tab's body whenever it stops being the active tab
     * (`keepMounted` is opt-in and the Files type does not ask for it), so
     * clicking a file — which opens its preview tab — destroys the container
     * the WeakMap above is keyed by. Without this, the anchor that Shift
     * extends from would vanish exactly after the ordinary gesture of opening
     * a file and coming back, and a Shift+click would select one row instead
     * of a range. The entry is keyed by session + workspace root and leaves
     * with the selection it describes.
     */
    const treeSelectionScopes = new Map()
    /** A row whose click this bridge itself produced, to let it through once. */
    let treeClickBypass = null

    /** The listing model `selectReduce` consumes: path as the id, kind as isDir. */
    function treeRowModel (rows) {
      return rows.map(row => ({
        name: row.getAttribute('data-files-path') ?? '',
        isDir: row.getAttribute('data-files-entry') === 'directory',
      }))
    }

    /** Whether this row can take part in a selection at all. */
    function treeRowSelectable (row) {
      const path = row.getAttribute('data-files-path')
      const kind = row.getAttribute('data-files-entry')
      return path !== null && path !== '' && (kind === 'file' || kind === 'directory')
    }

    /** All selectable rows of one container, in visual order. */
    function treeSelectableRows (container) {
      return [...container.querySelectorAll(TREE_ROW_SELECTOR)].filter(treeRowSelectable)
    }

    /**
     * The workspace root a tree body belongs to.
     *
     * The host puts `data-files-root` on the `[data-files-state="tree"]`
     * element, which is the body's PARENT — so reading it off the body always
     * returned null and every panel looked like the same workspace, which meant
     * a root switch never reset the selection.
     */
    function treeRootOfContainer (container) {
      const tree = container.closest('[data-files-state="tree"]') ?? container.parentNode
      const value = tree?.getAttribute?.('data-files-root')
      return value === null || value === undefined || value === '' ? null : value
    }

    /** The session whose right sidebar holds this tree, or '' when unknown. */
    function treeSessionOfContainer (container) {
      const owner = container.closest('[data-sidebar-right-session]')
      const value = owner?.getAttribute?.('data-sidebar-right-session')
      return value === undefined || value === null ? '' : value
    }

    /**
     * The key a selection survives a remount under.
     *
     * Session + root: the same workspace shown in two sessions is two panels,
     * and a selection must not leak from one to the other.
     */
    function treeScopeKeyOf (container, rootOverride) {
      const root = rootOverride === undefined ? treeRootOfContainer(container) : rootOverride
      if (root === null) return null
      return `${treeSessionOfContainer(container)}\n${root}`
    }

    /** The path the anchor index points at, so a remount can find the row again. */
    function treeAnchorPath (rows, index) {
      if (!Number.isInteger(index) || index < 0 || index >= rows.length) return null
      return rows[index].getAttribute('data-files-path')
    }

    /**
     * Resolve the remembered anchor path to an index in the rows on screen.
     *
     * The reducer takes indexes, but an index is only valid for the listing
     * that produced it. The path is the durable identity: after a remount the
     * host refetches the root, so rows can arrive a commit later. This runs
     * BEFORE the reducer as well as before painting, because a Shift click can
     * land before the scheduled re-sync has had a chance to resolve anything.
     */
    function resolveTreeAnchor (state, rows) {
      if (state.anchorPath === null) return
      const at = rows.findIndex(row => row.getAttribute('data-files-path') === state.anchorPath)
      const anchor = at >= 0 ? at : null
      if (anchor !== state.selection.anchor) state.selection = { ...state.selection, anchor }
    }

    /** Record one container's selection under its workspace, for a remount. */
    function rememberTreeSelection (container, state) {
      const key = state.scopeKey ?? treeScopeKeyOf(container)
      if (key === null) return
      if (state.selection.ids.length === 0) {
        treeSelectionScopes.delete(key)
        return
      }
      treeSelectionScopes.set(key, { ids: state.selection.ids.slice(), anchorPath: state.anchorPath })
    }

    /** Set one container's selection, repaint it, and remember it. */
    function setTreeSelection (container, selection, rows) {
      const state = treeStateOf(container)
      state.selection = {
        ids: Array.isArray(selection.ids) ? selection.ids.slice() : [],
        anchor: selection.anchor ?? null,
        cursor: selection.cursor ?? null,
        navigate: selection.navigate ?? null,
      }
      state.anchorPath = treeAnchorPath(rows, state.selection.anchor)
      applyTreeSelection(container)
      rememberTreeSelection(container, state)
    }

    /** This container's state, created on first use (and restored after a remount). */
    function treeStateOf (container) {
      let state = treeSelectionStates.get(container)
      if (state === undefined) {
        const key = treeScopeKeyOf(container)
        const remembered = key === null ? undefined : treeSelectionScopes.get(key)
        state = {
          selection: remembered === undefined
            ? SELECTION_EMPTY
            : { ids: remembered.ids.slice(), anchor: null, cursor: null, navigate: null },
          root: treeRootOfContainer(container),
          scopeKey: key,
          anchorPath: remembered?.anchorPath ?? null,
          painted: [],
        }
        treeSelectionStates.set(container, state)
        treeSelectionContainers.add(container)
      }
      return state
    }

    /**
     * Paint one container's selection onto the host rows.
     *
     * Only our own two classes, `aria-selected` and the roving `tabindex` on
     * the row's existing button are written. None of them is an attribute the
     * host renders, so React's next commit leaves them alone instead of
     * fighting them — the same property the workspace-mark pass relies on for
     * its inline `style`.
     */
    function applyTreeSelection (container) {
      const state = treeSelectionStates.get(container)
      if (state === undefined) return
      const rows = treeSelectableRows(container)
      // Same resolution the reducer needs, applied here so the paint and the
      // next gesture agree about which row the anchor is.
      resolveTreeAnchor(state, rows)
      const ids = new Set(state.selection.ids)
      const cursor = state.selection.cursor
      // Rows we painted last time that are no longer part of the listing keep
      // their class unless they are cleared explicitly. React can reuse such a
      // node for a different path, and it would come back already highlighted.
      const present = new Set(rows)
      for (const painted of state.painted ?? []) {
        if (present.has(painted)) continue
        painted.classList.remove(TREE_SELECTED_CLASS)
        painted.classList.remove(TREE_CURSOR_CLASS)
        painted.removeAttribute('aria-selected')
      }
      state.painted = rows.slice()
      container.setAttribute('aria-multiselectable', 'true')
      rows.forEach((row, index) => {
        const path = row.getAttribute('data-files-path')
        const selected = ids.has(path)
        const isCursor = cursor !== null && cursor !== undefined && cursor === index
        row.classList.toggle(TREE_SELECTED_CLASS, selected)
        row.classList.toggle(TREE_CURSOR_CLASS, isCursor)
        row.setAttribute('aria-selected', selected ? 'true' : 'false')
        const button = row.querySelector('button')
        if (button !== null) {
          if (isCursor) button.setAttribute('tabindex', '0')
          else if (cursor !== null && cursor !== undefined) button.setAttribute('tabindex', '-1')
          else button.removeAttribute('tabindex')
        }
      })
      // A host re-render can drop a row the selection still names (a collapsed
      // directory, a deleted file). A selection may only claim rows the user
      // can see, so the ids are pruned against what is on screen.
      // An empty listing is ambiguous: it may be a workspace with no entries,
      // or the moment between a remount and the listing arriving. Pruning
      // against it would throw away a selection that is about to be paintable
      // again, so the prune waits for rows to look at.
      if (rows.length > 0) {
        const visible = new Set(rows.map(row => row.getAttribute('data-files-path')))
        const kept = state.selection.ids.filter(id => visible.has(id))
        if (kept.length !== state.selection.ids.length) {
          state.selection = { ...state.selection, ids: kept }
        }
      }
    }

    /** Re-read one container after the host re-rendered it. */
    function syncTreeContainer (container) {
      const state = treeStateOf(container)
      const root = treeRootOfContainer(container)
      if (root !== state.root) {
        // A different workspace in the same panel: the old rows are gone, so
        // the old claims are gone with them. Neither the root being left nor a
        // stale memory for the root being entered may repaint rows the user
        // did not select in this visit.
        const previousKey = state.scopeKey ?? treeScopeKeyOf(container, state.root)
        const nextKey = treeScopeKeyOf(container, root)
        if (previousKey !== null && previousKey !== nextKey) treeSelectionScopes.delete(previousKey)
        if (nextKey !== null) treeSelectionScopes.delete(nextKey)
        state.root = root
        state.scopeKey = nextKey
        state.selection = SELECTION_EMPTY
        state.anchorPath = null
      }
      applyTreeSelection(container)
    }

    /** Apply one action and repaint; returns the reducer's answer. */
    function reduceTree (container, action) {
      const state = treeStateOf(container)
      const rows = treeSelectableRows(container)
      // Resolve the remembered anchor BEFORE the reducer: a Shift click can
      // arrive before the scheduled re-sync has turned the anchor path into
      // an index, and reducing against `anchor: null` would select one row.
      resolveTreeAnchor(state, rows)
      const result = selectReduce(state.selection, { ...action, rows: treeRowModel(rows) })
      setTreeSelection(container, result, rows)
      return result
    }

    /** Open one row the way a click would, without this bridge eating it. */
    function activateTreeRow (row) {
      const button = row.querySelector('button')
      if (button === null) return
      treeClickBypass = row
      try { button.click() } finally {
        // `click()` is synchronous, so a listener that never ran would leave
        // the flag set — clear it unconditionally rather than trusting the host.
        if (treeClickBypass === row) treeClickBypass = null
      }
    }

    /** The rows this selection names, as menu-sized items. */
    function treeSelectedItems (container) {
      const state = treeSelectionStates.get(container)
      if (state === undefined || state.selection.ids.length === 0) return []
      return treeSelectableRows(container)
        .filter(row => state.selection.ids.includes(row.getAttribute('data-files-path')))
        .map(row => ({
          path: row.getAttribute('data-files-path'),
          isDir: row.getAttribute('data-files-entry') === 'directory',
        }))
    }

    /**
     * One action's targets, decided by the click and the selection it landed in.
     *
     * This is the only place that chooses between "the row I clicked" and "the
     * rows I had selected". The menu labels no longer carry a count, so a
     * second implementation here would be invisible until the wrong set was
     * deleted. The returned `selection` is what the caller must paint BEFORE
     * opening the menu: when the click was outside the selection, the old
     * selection has already stopped matching what the action will do.
     *
     * @param {{path: string, name?: string, isDir?: boolean}|null} clickedRow
     * @param {Array<{path: string}>} [selection]
     * @returns {{targets: Array<object>, selection: Array<object>, collapsed: boolean}}
     */
    function resolveTargets (clickedRow, selection) {
      if (clickedRow === null || typeof clickedRow !== 'object' || typeof clickedRow.path !== 'string' || clickedRow.path === '') {
        return { targets: [], selection: [], collapsed: false }
      }
      const items = (Array.isArray(selection) ? selection : [])
        .filter(item => item !== null && typeof item === 'object' && typeof item.path === 'string' && item.path !== '')
      const inside = items.some(item => item.path === clickedRow.path)
      if (inside && items.length > 1) {
        return { targets: items.slice(), selection: items.slice(), collapsed: false }
      }
      return {
        targets: [clickedRow],
        selection: [clickedRow],
        collapsed: items.length > 0 && (!inside || items.length > 1),
      }
    }

    /**
     * One destination for several rows, stated before the picker opens.
     *
     * The count lives here because the row menu no longer carries one: the
     * subtitle is the sentence that tells the user what the folder they are
     * about to choose is for. Rows that are not remote are counted out loud
     * instead of vanishing — the user selected them, so the answer has to
     * mention them.
     *
     * @param {Array<{path: string, isDir?: boolean}>} chosen - remote rows only.
     * @param {number} skipped - how many selected rows were not remote.
     * @param {object} ctx - the plugin context (folder picker).
     * @returns {void}
     */
    function requestBatchDownload (chosen, skipped, ctx) {
      const body = document.createElement('div')
      const subtitle = document.createElement('div')
      subtitle.className = 'sshwsp-field-label'
      subtitle.textContent = translate('transfer.downloadTargetSubtitle', { count: chosen.length })
      const names = document.createElement('div')
      names.className = 'sshwsp-field-hint'
      const shown = chosen.slice(0, 5).map(item => entryNameOf(item.path)).join('、')
      const more = chosen.length > 5 ? ' ' + translate('rowmenu.deleteMore', { count: chosen.length - 5 }) : ''
      names.textContent = shown + more
      body.append(subtitle, names)
      if (skipped > 0) {
        const note = document.createElement('div')
        note.className = 'sshwsp-warn'
        note.textContent = translate('transfer.skippedLocal', { count: skipped })
        body.appendChild(note)
      }
      openRowActionDialog({
        title: translate('transfer.downloadTargetTitle'),
        submitLabel: translate('transfer.chooseTarget'),
        busyLabel: translate('transfer.chooseTarget'),
        buildBody: () => body,
        // The picker is the FIRST await: the click that opened this dialog is
        // the activation the native folder chooser needs, and any round trip
        // before it would spend that activation instead of using it.
        onSubmit: async () => {
          const folder = await pickDirTarget(ctx)
          if (folder.kind === 'canceled') {
            // Cancelling is not a failure: `muted`, and the dialog still closes
            // so the user is not left in a modal that did nothing.
            notifyUser(translate('transfer.pickCanceled'), 'muted')
            return undefined
          }
          const opening = skipped > 0
            ? translate('transfer.downloadQueuedSkipped', { count: chosen.length, skipped })
            : translate('transfer.downloadQueued', { count: chosen.length })
          enqueueDownloadsInto(chosen.map(item => {
            const parts = remoteTargetOf(item.path)
            const name = parts.remotePath.replace(/\/+$/u, '').split('/').pop() ?? item.path
            return {
              alias: parts.alias,
              remotePath: parts.remotePath,
              suggestedName: item.isDir === true ? `${name}.zip` : name,
              isDir: item.isDir === true,
            }
          }), folder, opening)
          return undefined
        },
      })
    }

    /**
     * Download every row this gesture resolved to.
     *
     * ONE entry point for one row and for many: the menu, the keyboard and the
     * round-trip through `resolveTargets` all arrive here, so there is no
     * second batch path that could pick a different set. A single remote row
     * keeps its per-file save dialog (that is what "download THIS file" has
     * always meant); anything else asks once for a folder.
     *
     * @param {Array<{path: string, isDir?: boolean}>} items - resolved targets.
     * @param {object} ctx - the plugin context.
     * @returns {Promise<void>}
     */
    async function downloadRows (items, ctx) {
      const all = Array.isArray(items) ? items : []
      if (all.length === 0) return
      const chosen = all.filter(item => remoteTargetOf(item.path) !== null)
      if (chosen.length === 0) {
        notifyUser(toastError(translate('transfer.notRemote'), all, 'SSHWSP-E-TRANSFER-TARGET'))
        return
      }
      const skipped = all.length - chosen.length
      if (chosen.length === 1 && skipped === 0) {
        await downloadTreeRow(chosen[0].path, chosen[0].isDir === true)
        return
      }
      requestBatchDownload(chosen, skipped, ctx)
    }

    // ---- delegated gestures ------------------------------------------------

    /** The tree body a node belongs to, or null. */
    function treeContainerOf (node) {
      if (!(node instanceof Element)) return null
      const body = node.closest(TREE_BODY_SELECTOR)
      if (body !== null) return body
      const tree = node.closest('[data-files-state="tree"]')
      if (tree === null) return null
      return tree.querySelector(TREE_BODY_SELECTOR)
    }

    /**
     * Click: one gesture, three outcomes, decided by the shared reducer.
     *
     * The host's own handler is what navigates, so this bridge only ever
     * SUPPRESSES it — and it suppresses exactly when `selectReduce` reported
     * `navigate: null`, i.e. never for a plain click on a directory and always
     * for a modifier click. That is "choice wins, navigation yields" stated
     * once, in the reducer, instead of twice in two handlers.
     */
    function onTreeSelectClick (event) {
      const target = event.target
      if (!(target instanceof Element)) return
      const row = target.closest(TREE_ROW_SELECTOR)
      const container = treeContainerOf(row ?? target)
      if (container === null) return
      if (row === null || !treeRowSelectable(row)) {
        // Empty space inside the tree, or a row that cannot be selected: the
        // click still means "start over".
        if (row === null) {
          const state = treeSelectionStates.get(container)
          if (state !== undefined && state.selection.ids.length > 0) reduceTree(container, { type: 'blank' })
        }
        return
      }
      if (treeClickBypass === row) {
        treeClickBypass = null
        return
      }
      const rows = treeSelectableRows(container)
      const index = rows.indexOf(row)
      if (index < 0) return
      const result = reduceTree(container, {
        type: 'row',
        index,
        ctrl: event.ctrlKey === true || event.metaKey === true,
        shift: event.shiftKey === true,
        append: (event.ctrlKey === true || event.metaKey === true) && event.shiftKey === true,
      })
      if (result.navigate === null || result.navigate === undefined) {
        // The reducer declined to navigate: selection owns this gesture.
        event.preventDefault()
        event.stopPropagation()
      }
    }

    /** Move real focus to the cursor row, so the ring and the keyboard agree. */
    function focusTreeCursor (container, index) {
      if (index === null || index === undefined) return
      const rows = treeSelectableRows(container)
      const row = rows[index]
      if (row === undefined) return
      const button = row.querySelector('button')
      if (button !== null && typeof button.focus === 'function') button.focus()
    }

    /** Keyboard: the same rules as the tab and the dialog, on the host's rows. */
    function onTreeSelectKey (event) {
      const active = document.activeElement
      if (!(active instanceof Element)) return
      if (active.closest('input, textarea, [contenteditable="true"]') !== null) return
      const row = active.closest(TREE_ROW_SELECTOR)
      const container = treeContainerOf(row ?? active)
      if (container === null) return
      const known = treeSelectionStates.get(container) !== undefined
      if (!known && row === null) return
      const state = treeStateOf(container)
      const rows = treeSelectableRows(container)
      if (rows.length === 0) return
      const ctrl = event.ctrlKey === true || event.metaKey === true
      const shift = event.shiftKey === true

      if (event.key === ' ') {
        // Space must NOT toggle. On a real button it would fire `click`, which
        // this bridge turns into a selection; Enter is the open gesture.
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // The FIRST arrow key selects the row the keyboard is already on and
        // then does nothing else; only later presses step. Seeding the cursor
        // first and then running `move` stepped twice on the first press, which
        // read as "the arrow key skipped a row".
        if (state.selection.cursor === null || state.selection.cursor === undefined) {
          if (row === null) return
          const index = rows.indexOf(row)
          if (index < 0) return
          event.preventDefault()
          event.stopPropagation()
          setTreeSelection(container, { ids: [rows[index].getAttribute('data-files-path')], anchor: index, cursor: index }, rows)
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const result = reduceTree(container, {
          type: 'move',
          delta: event.key === 'ArrowDown' ? 1 : -1,
          focusOnly: ctrl && !shift,
          extend: shift,
        })
        focusTreeCursor(container, result.cursor)
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        event.stopPropagation()
        const result = reduceTree(container, {
          type: 'to',
          end: event.key === 'End',
          focusOnly: ctrl && !shift,
          extend: shift,
        })
        focusTreeCursor(container, result.cursor)
        return
      }
      if ((event.key === 'a' || event.key === 'A') && ctrl) {
        event.preventDefault()
        event.stopPropagation()
        reduceTree(container, { type: 'selectAll' })
        return
      }
      if (event.key === 'Escape') {
        if (state.selection.ids.length === 0) return
        // Caught here so the host's own Escape (close a panel, blur a field)
        // still answers when there is nothing selected to clear.
        event.preventDefault()
        event.stopPropagation()
        reduceTree(container, { type: 'escape' })
        return
      }
      if (event.key === 'Enter') {
        if (row === null) return
        event.preventDefault()
        event.stopPropagation()
        setTreeSelection(container, { ...state.selection, cursor: rows.indexOf(row) }, rows)
        activateTreeRow(row)
      }
      // Everything else (F2, Delete, ContextMenu, Shift+F10) belongs to the row
      // menu bridge, which listens on the same document.
    }

    /**
     * Re-read every tree after a host re-render; forget detached ones.
     *
     * The container set starts EMPTY — the panel may already be on screen when
     * this bundle loads, and a set that is only filled by gestures would make
     * the first click the only way to discover a tree (so nothing would be
     * decorated until after the gesture that needed the decoration). The scan
     * covers that: every `[data-files-body]` currently in the document is
     * adopted, then the known ones are re-read.
     */
    function syncAllTreeContainers () {
      for (const container of [...document.querySelectorAll(TREE_BODY_SELECTOR)]) {
        treeStateOf(container)
      }
      for (const container of [...treeSelectionContainers]) {
        if (!document.contains(container)) {
          treeSelectionContainers.delete(container)
          continue
        }
        try { syncTreeContainer(container) } catch { /* one tree must not break another */ }
      }
    }

    /**
     * Install the host-tree selection bridge. Returns its detach function.
     *
     * The MutationObserver is what keeps the decoration alive across host
     * re-renders (expanding a directory replaces rows). It is the same
     * mechanism, for the same reason, as the workspace-mark pass.
     */
    function installTreeSelectionBridge (ctx) {
      if (typeof document === 'undefined') return () => {}
      let frame = 0
      const schedule = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          try { syncAllTreeContainers() } catch { /* decoration must never break the app */ }
        })
      }
      const touchesTree = (record) => {
        if (record.target instanceof Element && record.target.closest(TREE_BODY_SELECTOR) !== null) return true
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(TREE_ROW_SELECTOR) || node.querySelector(TREE_ROW_SELECTOR) !== null)) return true
        }
        return false
      }
      let observer = null
      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver((records) => {
          if (records.some(touchesTree)) schedule()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      }
      document.addEventListener('click', onTreeSelectClick, true)
      document.addEventListener('keydown', onTreeSelectKey, true)

      // A probe pass: the tree may already be on screen when this loads.
      schedule()
      void ctx
      return () => {
        if (frame !== 0) window.cancelAnimationFrame(frame)
        if (observer !== null) observer.disconnect()
        document.removeEventListener('click', onTreeSelectClick, true)
        document.removeEventListener('keydown', onTreeSelectKey, true)

      }
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
      const disposers = [installTreeDragBridge(ctx), installTreeMenuBridge(ctx), installTreeSelectionBridge(ctx)]
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

      // Main page. `ctx` travels with the injected props because the directory
      // browser's batch download needs the plugin container for the host's
      // folder chooser; without it the dialog throws during render and the
      // whole slot blanks.
      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ translate, ctx }),
      }, RemoteWorkspacePage))

      // File-panel header action: the transfer-queue entry. DSH hands this
      // slot `absolutePath` — the directory the panel is showing — which the
      // entry republishes for the empty-space right-click menu. Uploading from
      // the header is NOT offered; the directory browser and the tree row menu
      // own that action.
      //
      // The callback running is the only evidence that this build declares the
      // slot: an absent one simply never calls it. The grace period turns that
      // silence into one readable line in the panel instead of a vanished
      // control with no explanation.
      slots.inject('sidebar.right.tab.files.actions', () => {
        setTransferActionsSlotState('ready')
        return slots.register({
          name: 'sidebar.right.tab.files.actions',
          id: `${PANEL_ID}-transfers`,
          inject: () => ({ t: translate }),
        }, FilePanelTransferActions)
      })
      const transferActionsProbe = setTimeout(() => {
        if (transferActionsSlotState === 'pending') setTransferActionsSlotState('missing')
      }, 4000)

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
        clearTimeout(transferActionsProbe)
        detachBridges()
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
