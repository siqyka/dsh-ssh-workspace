window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.add-workspace.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')

    // The add-workspace flow: the local/remote chooser, the remote chooser
    // (name + host + directory picker, then mount), and the occupant that drives
    // both.
    //
    // This is 427 lines that only exist while someone is adding a workspace, and
    // the two directory pickers inside it are the heaviest part — the remote
    // branch lists a directory over SFTP before it can render a single row.
    //
    // The occupant is NOT fetched at boot: the workspace picker renders its
    // directoryFlow hole unconditionally and this component returns null while
    // it is closed, so the main bundle keeps a `FlowSlot` that returns that same
    // null and only mounts this chunk once `open` is true.
    //
    // `flowMenuPosition` stays in the main bundle even though only the chooser
    // calls it: it reads `lastTriggerRect`, which the apply-time mousedown
    // listener writes. A copy here would read a stale module-level binding.
    const {
      API,
      fetchJson,
      BROWSE_LIST_LIMIT,
      FLOW_MENU_WIDTH_ROOMY,
      flowMenuPosition,
      ArrowLeftIcon,
      CloseIcon,
      FolderIcon,
      GlobeIcon,
      RemoteMarkIcon,
      backdropDismiss,
      childDirectoryPath,
      directoryDraft,
      directoryPath,
      modalLayer,
      narrowDirectoryEntries,
      refreshRemoteWorkspaceMarks,
      useDialogA11y,
      useMenuKeyboard,
      usePathDraftPreview,
    } = require('@shiqyka/dsh-ssh-workspace')

    // =========================================================================
    // Add-workspace flow
    // =========================================================================
    // The chooser (first step) and the remote branch (second step). Both are
    // rendered by `AddWorkspaceFlow`, which the main bundle mounts only once
    // the hole is open.
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
        pos !== null && modalLayer(jsx('div', {
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
        })),
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
      // The rows the host returned for `path`; what the chooser renders is
      // these narrowed by the typed fragment (same contract as the browser
      // dialog, both go through `usePathDraftPreview`).
      const [listing, setListing] = React.useState(null)
      // Set when the server capped the listing, so the chooser can admit that
      // the directory the user wants may simply not be in the list.
      const [truncation, setTruncation] = React.useState(null)
      const [writable, setWritable] = React.useState(true)
      const [loading, setLoading] = React.useState(false)
      const [loadError, setLoadError] = React.useState(null)
      const [creating, setCreating] = React.useState(false)
      const [createError, setCreateError] = React.useState(null)
      // The row the user PICKED, as a full path — the workspace root that will
      // be created. Single click picks, double click still enters; without this
      // the only way to create a workspace at a subdirectory was to enter it and
      // then create at the directory you were standing in. One path, not a set:
      // this dialog creates exactly one workspace.
      const [picked, setPicked] = React.useState(null)
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

      // Same rule as the browser dialog: the chooser may point the workspace at
      // a directory the capped listing never shows, so the path is editable.
      const [pathDraft, setPathDraft] = React.useState('')
      // A host switch must not carry the previous host's path (or a pending
      // preview of it) across: those rows and that draft belong to the old
      // alias, and the new host's login directory is about to arrive. Runs
      // before the listing effect below for exactly that reason.
      React.useEffect(() => {
        setPathDraft('')
        setPath(null)
        setListing(null)
        setPicked(null)
      }, [alias])
      const loadDir = React.useCallback(async (target, options = {}) => {
        if (alias === '') return
        const preview = options.preview === true
        const seq = ++loadSeq.current
        // A new listing invalidates the pick: the row it named may not be in the
        // answer, and creating at a directory the list no longer shows is the
        // one failure this state must never produce.
        setPicked(null)
        // Only a NAVIGATION publishes the target before the answer; a preview
        // must not point "create workspace" at a path still being typed.
        if (!preview && typeof target === 'string' && target !== '') {
          const dir = directoryPath(target)
          setPath(dir)
          // Same contract as the browser dialog: the slash marks "inside".
          setPathDraft(directoryDraft(dir))
        }
        setLoading(true)
        setLoadError(null)
        setTruncation(null)
        if (!preview) setListing(null)
        try {
          const query = typeof target === 'string' && target !== '' ? `&path=${encodeURIComponent(target)}` : ''
          // `dirs=1`: the chooser can only create a workspace from a
          // directory, so the server filters before applying the cap and the
          // totals below count the rows that are actually shown.
          const data = await fetchJson(`${API.ls}?alias=${encodeURIComponent(alias)}${query}&limit=${BROWSE_LIST_LIMIT}&dirs=1`)
          if (seq !== loadSeq.current) return
          setListing((data.entries ?? []).sort((a, b) => a.name.localeCompare(b.name)))
          // Truncation matters MORE here than in the browser dialog: this list
          // is how the user picks the workspace root, and a directory missing
          // from it is a workspace they cannot create.
          setTruncation(data.truncated === true
            ? { total: typeof data.total === 'number' ? data.total : 0 }
            : null)
          const shown = typeof data.path === 'string' && data.path !== '' ? data.path : target
          if (typeof shown === 'string' && shown !== '') {
            const dir = directoryPath(shown)
            setPath(dir)
            if (!preview) setPathDraft(directoryDraft(dir))
          }
          setWritable(data.writable !== false)
        } catch (err) {
          if (seq === loadSeq.current) setLoadError(err.message)
        } finally {
          if (seq === loadSeq.current) setLoading(false)
        }
      }, [alias])

      const fragment = usePathDraftPreview({ draft: pathDraft, currentDir: path, listing, loadDir })
      const entries = narrowDirectoryEntries(listing, fragment)

      React.useEffect(() => { void loadDir(null) }, [loadDir])

      const handleEntry = (entry) => {
        if (path == null) return
        loadDir(childDirectoryPath(path, entry.name))
      }

      // What "create" acts on: the picked row when there is one, else the
      // directory being listed. Derived, never stored — a stored root would
      // survive a refresh that removed the row it named.
      const target = picked ?? path

      const handleUp = () => {
        if (path == null) return
        // Same normalization as the browser dialog: a typed trailing slash is
        // not a segment.
        const dir = path.replace(/\/+$/u, '') || '/'
        if (dir === '/') return
        const idx = dir.lastIndexOf('/')
        loadDir(idx <= 0 ? '/' : dir.slice(0, idx))
      }

      const handleCreate = async () => {
        setCreating(true)
        setCreateError(null)
        try {
          const result = await fetchJson(API.mount, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias, remotePath: target, title: name.trim(), register: true }),
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
      return modalLayer(jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(dismissBackdrop), children: [
        jsxs('div', { className: 'sshwsp-dialog sshwsp-dialog-fill', ...dialog.props, ref: dialog.bodyRef, tabIndex: -1, onClick: (e) => e.stopPropagation(), children: [
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
                  jsx('input', {
                    className: 'sshwsp-pathbar-path sshwsp-path-input',
                    'aria-label': t('remote.path'),
                    value: pathDraft,
                    placeholder: '/',
                    spellCheck: false,
                    autoComplete: 'off',
                    disabled: creating,
                    onChange: (e) => setPathDraft(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        const next = pathDraft.trim()
                        // Same contract as the browser dialog: the preview
                        // follows the draft, and Enter still forces a listing so
                        // a typo answers with an error instead of silence.
                        if (next.startsWith('/') && directoryPath(next) !== path) loadDir(directoryPath(next))
                        else setPathDraft(directoryDraft(path ?? ''))
                      } else if (e.key === 'Escape') setPathDraft(directoryDraft(path ?? ''))
                    },
                    // No `onBlur` reset: rows are entered by double click, and
                    // the first click blurs the input — un-filtering there would
                    // move the row out from under the second click.
                  }),
                ]}),
              ]}),
            ]}),
            path != null && !loading && loadError == null && !writable && jsx('div', { className: 'sshwsp-warn', children: t('remote.notWritable') }),
            truncation != null && jsx('div', { className: 'sshwsp-warn', role: 'status', children: t('remote.truncated', { total: truncation.total }) }),
            createError != null && jsx('div', { className: 'sshwsp-warn', children: createError }),
            jsx('div', { className: 'sshwsp-dirlist-hint', children: t('remote.enterHint') }),
            // The root is stated in words, not only in a tooltip and a highlight:
            // picking a row changes what the button does while the path bar keeps
            // showing the directory being listed, and those two disagreeing
            // silently is how a workspace lands somewhere the user did not mean.
            target != null && jsx('div', { className: 'sshwsp-picked', children: t('remote.picked', { path: target }) }),
            jsx('div', { className: 'sshwsp-dirlist', children:
              hostsError != null
                ? jsx('div', { className: 'sshwsp-empty', children: t('remote.hostsFail', { msg: hostsError }) })
                : hosts != null && hosts.length === 0
                  ? jsx('div', { className: 'sshwsp-empty', children: t('panel.empty') })
                  : loading && listing == null
                    ? jsx('div', { className: 'sshwsp-empty', children: t('remote.loading') })
                    : loadError != null
                      ? jsx('div', { className: 'sshwsp-empty', children: t('remote.loadError', { msg: loadError }) })
                      : (entries?.length ?? 0) === 0
                        ? jsx('div', { className: 'sshwsp-empty', children: fragment === '' ? t('remote.empty') : t('remote.noMatch') })
                        : entries.map((entry) => {
                            // Same two gestures as the browse dialog: a single
                            // click PICKS the row as the workspace root, a double
                            // click enters it, and a keyboard activation (the
                            // `detail === 0` click React sends) picks — pressing
                            // Enter again on the picked row enters it, so the
                            // path exists without a pointer.
                            const full = path == null ? null : childDirectoryPath(path, entry.name)
                            const isPicked = full !== null && full === picked
                            return jsxs('button', {
                              key: entry.name,
                              type: 'button',
                              className: isPicked
                                ? 'sshwsp-entry sshwsp-entry-dir sshwsp-entry-picked'
                                : 'sshwsp-entry sshwsp-entry-dir',
                              'aria-current': isPicked ? 'true' : undefined,
                              disabled: creating,
                              onClick: (event) => {
                                if (event.detail === 0 && isPicked) { handleEntry(entry); return }
                                setPicked(full)
                              },
                              onDoubleClick: () => handleEntry(entry),
                              children: [
                                jsx('span', { className: 'sshwsp-entry-icon', children: React.createElement(FolderIcon) }),
                                jsx('span', { className: 'sshwsp-entry-name', children: entry.name }),
                              ],
                            })
                          })
            }),
          ]}),
          jsxs('div', { className: 'sshwsp-dialog-footer', children: [
            jsx('button', { className: 'sshwsp-btn', disabled: creating, onClick: onCancel, children: t('remote.cancel') }),
            jsx('button', {
              className: 'sshwsp-btn sshwsp-btn-primary',
              disabled: createDisabled,
              onClick: handleCreate,
              // Names the directory this click will actually register — the
              // picked row if there is one, otherwise the listed directory.
              title: target ?? undefined,
              children: creating ? t('remote.creating') : t('remote.create'),
            }),
          ]}),
        ]}),
      ]}))
    }

    /**
     * Occupant of `sidebar.workspaces.directoryFlow` and
     * `conversation.hero.workspace.directoryFlow`. The first step is a local /
     * remote chooser: local renders the installed in-app browser
     * ({@link resolveBrowseFlow}) and falls back to the native picker bridge
     * when this deployment has none; remote opens
     * {@link RemoteWorkspaceDialog} and mounts the chosen directory before
     * handing the canonical `ssh://` path to the owner.
     */
    function AddWorkspaceFlow ({ open, busy, onPicked, onCancel, onError, pick, localFlow, t }) {
      const [mode, setMode] = React.useState('choose')
      const [picking, setPicking] = React.useState(false)

      React.useEffect(() => {
        if (!open) {
          setMode('choose')
          setPicking(false)
        }
      }, [open])

      // Resolved on every render, but cached per registration (see
      // resolveBrowseFlow): a fresh component type or listing callback per
      // frame would reset the browser instead of painting it. Only the local
      // mode needs it, and the owner's `open` conversation (open / busy /
      // onPicked / onCancel) is passed through unchanged, so the dialog closes,
      // commits and reports exactly as the shipped occupant's would.
      const browse = mode === 'local' && typeof localFlow === 'function' ? localFlow() : null

      const handleLocal = async () => {
        // Prefer the installed in-app browser: it is the only local picking
        // surface that works when the composed directoryPicker serves `browse`
        // alone (`pick()` needs `native`).
        if (typeof localFlow === 'function' && localFlow() !== null) {
          setMode('local')
          return
        }
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
      if (browse !== null) {
        return React.createElement(browse.component, {
          ...browse.props,
          open: true,
          busy,
          onPicked,
          onCancel,
        })
      }
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
    exports.AddChooser = AddChooser
    exports.RemoteWorkspaceDialog = RemoteWorkspaceDialog
    exports.AddWorkspaceFlow = AddWorkspaceFlow
    return module.exports
  },
})
