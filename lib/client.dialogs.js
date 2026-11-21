window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.dialogs.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createPortal } = require('react-dom')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')

    // Everything these three dialogs lean on outside themselves comes from the
    // main bundle, which is reachable by package id (proven in
    // tests/client-chunk-smoke.mjs): the HTTP table, three icons, the dialog
    // contract, and the directory picker's pure helpers. They are destructured
    // ONCE here rather than threaded through props — a dialog that needed twelve
    // props to render a button would be a worse component, and every call site
    // would have to remember them.
    //
    // The helpers stay in the main bundle on purpose: the panel's own path
    // preview and the Add-workspace flow call them DURING render, and a function
    // that is only reachable through a chunk cannot be called before it arrives.
    const {
      API,
      CloseIcon,
      FolderIcon,
      capabilityNotes,
      backdropDismiss,
      modalLayer,
      useDialogA11y,
      PATH_PREVIEW_DEBOUNCE_MS,
      draftDirectoryTarget,
      narrowDirectoryEntries,
      childDirectoryPath,
      directoryPath,
      directoryDraft,
      usePathDraftPreview,
    } = require('@shiqyka/dsh-ssh-workspace')

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

      return modalLayer(jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(dismissBackdrop), children: [
        jsxs('div', { className: 'sshwsp-dialog sshwsp-dialog-narrow', ...dialog.props, ref: dialog.bodyRef, tabIndex: -1, onClick: (event) => event.stopPropagation(), children: [
          jsx('div', { className: 'sshwsp-dialog-title', id: dialog.titleId, children: editing ? t('editor.title.edit') : t('editor.title.create') }),
          jsx('div', { className: 'sshwsp-dialog-body', children: jsxs('div', { className: 'sshwsp-form', children: [
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
          ]}) }),
          jsxs('div', { className: 'sshwsp-dialog-footer', children: [
            jsx('button', { className: 'sshwsp-btn', onClick: onClose, disabled: saving, children: t('editor.cancel') }),
            jsx('button', { className: 'sshwsp-btn sshwsp-btn-primary', onClick: submit, disabled: saving, children: saving ? t('editor.saving') : t('editor.save') }),
          ]}),
        ]}),
      ]}))
    }

    // =========================================================================
    // Directory browser dialog
    // =========================================================================
    function DirectoryBrowser ({ alias, onClose, onMount, ctx, t }) {
      // null until the first listing resolves — then the SSH login directory.
      const [path, setPath] = React.useState(null)
      // The rows the HOST returned for `path`. What the dialog renders is these
      // narrowed by the fragment being typed (see `narrowDirectoryEntries`):
      // a filter kept in state could disagree with the input for a frame, and
      // that frame is exactly the one the user is looking at.
      const [listing, setListing] = React.useState(null)
      // Set when the server capped the listing. Kept beside the rows rather
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

      // A deep directory must be reachable by pasting its absolute path: the
      // server caps one listing, so clicking down level by level cannot always
      // reach it. The draft also follows every navigation, so moving with the
      // list or the up button moves the text — and the list follows the text
      // back (`usePathDraftPreview`).
      const [pathDraft, setPathDraft] = React.useState('')

      /**
       * List one directory.
       *
       * `preview` marks a listing the DRAFT asked for, and the distinction is
       * load-bearing in three places:
       *
       *  - it never rewrites the input, because the text belongs to the user
       *    while they are typing it;
       *  - it keeps the rows already on screen until the answer lands, so a
       *    pause mid-path does not flash an empty list (and a failed preview
       *    leaves the rows that were there, under an error line);
       *  - it publishes `path` only after the host has answered, so "mount this
       *    directory" cannot point at a directory the user is still spelling.
       */
      const loadDir = React.useCallback(async (target, options = {}) => {
        const preview = options.preview === true
        const seq = ++loadSeq.current
        // Track a NAVIGATION target immediately: the SSH round-trip must never
        // leave the displayed path (or the mount button) pointing at the
        // previous directory.
        if (!preview && typeof target === 'string' && target !== '') {
          const dir = directoryPath(target)
          setPath(dir)
          // Navigation writes the trailing slash: it is what marks the input as
          // "inside this directory", so deleting it filters the parent.
          setPathDraft(directoryDraft(dir))
        }
        setLoading(true)
        setError(null)
        setTruncation(null)
        if (!preview) setListing(null)
        try {
          const query = typeof target === 'string' && target !== '' ? `&path=${encodeURIComponent(target)}` : ''
          // `dirs=1`: the server filters to subdirectories BEFORE it applies
          // the cap, so `total` and `truncated` count the rows this dialog
          // shows. Filtering here instead would leave a listing that says
          // "2000 of 4213" about a list holding three directories.
          const data = await fetchJson(`${API.ls}?alias=${encodeURIComponent(alias)}${query}&limit=${BROWSE_LIST_LIMIT}&dirs=1`)
          if (seq !== loadSeq.current) return
          // One kind of row is left, so there is no "directories first" to apply.
          const sorted = (data.entries ?? []).sort((a, b) => a.name.localeCompare(b.name))
          setListing(sorted)
          // The server's own verdict, not a guess from the row count: it knows
          // how many entries the directory actually has, and this dialog must
          // not tell the user "that is everything" when it is not. `shown` is
          // what the server returned, not what the typed fragment narrowed it
          // to: this warning is about the cap, and a filter is not truncation.
          setTruncation(data.truncated === true
            ? { shown: sorted.length, total: typeof data.total === 'number' ? data.total : sorted.length }
            : null)
          const shown = typeof data.path === 'string' && data.path !== '' ? data.path : target
          if (typeof shown === 'string' && shown !== '') {
            const dir = directoryPath(shown)
            setPath(dir)
            if (!preview) setPathDraft(directoryDraft(dir))
          }
        } catch (err) {
          if (seq === loadSeq.current) setError(err.message)
        } finally {
          if (seq === loadSeq.current) setLoading(false)
        }
      }, [alias])

      // The draft drives the list: narrowing inside the shown directory costs
      // nothing, and naming another one costs one listing after the pause.
      const fragment = usePathDraftPreview({ draft: pathDraft, currentDir: path, listing, loadDir })
      const entries = narrowDirectoryEntries(listing, fragment)

      React.useEffect(() => { loadDir(null) }, [loadDir])

      const handleEntry = (entry) => {
        if (entry.type !== 'directory' || path == null) return
        loadDir(childDirectoryPath(path, entry.name))
      }

      const handleUp = () => {
        if (path == null) return
        // The echoed path can carry the trailing slash the user typed; treating
        // it as a segment would make "up" a no-op on that directory.
        const dir = path.replace(/\/+$/u, '') || '/'
        if (dir === '/') return
        const idx = dir.lastIndexOf('/')
        loadDir(idx <= 0 ? '/' : dir.slice(0, idx))
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

      return modalLayer(jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(dismissBackdrop), children: [
        jsxs('div', { className: 'sshwsp-dialog sshwsp-dialog-fill', ...dialog.props, ref: dialog.bodyRef, tabIndex: -1, onClick: (e) => e.stopPropagation(), children: [
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
                jsx('input', {
                  className: 'sshwsp-browser-path sshwsp-path-input',
                  'aria-label': t('browser.path'),
                  value: pathDraft,
                  placeholder: '/',
                  spellCheck: false,
                  autoComplete: 'off',
                  onChange: (e) => setPathDraft(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const next = pathDraft.trim()
                      // Enter still means "go there". The live preview filters a
                      // parent for a path that does not resolve yet; the explicit
                      // gesture must not become a silent no-op, so it lists the
                      // typed path and lets the error branch answer for a typo.
                      // The slash is irrelevant to "go": `/raid` and `/raid/`
                      // both name the directory once Enter is pressed.
                      if (next.startsWith('/') && directoryPath(next) !== path) loadDir(directoryPath(next))
                      else setPathDraft(directoryDraft(path ?? ''))
                    } else if (e.key === 'Escape') setPathDraft(directoryDraft(path ?? ''))
                  },
                  // No `onBlur` reset. This picker is entered with a DOUBLE click,
                  // and the first click of that pair already moves focus out of the
                  // input: un-filtering the list there would shift the row under
                  // the pointer, so the second click would land on another
                  // directory — or on nothing at all.
                }),
                jsx('span', { className: 'sshwsp-browser-hint', children: t('browser.enterHint') }),
              ]}),
              jsx('div', {
                className: 'sshwsp-browser-list',
                children:
                loading && listing == null
                  ? jsx('div', { className: 'sshwsp-empty', children: t('browser.loading') })
                  : error
                    ? jsxs('div', { className: 'sshwsp-empty', children: [t('browser.error'), jsx('br', {}), jsx('span', { style: { fontSize: 11 }, children: error })] })
                    : entries?.length === 0
                      ? jsx('div', { className: 'sshwsp-empty', children: fragment === '' ? t('browser.empty') : t('browser.noMatch') })
                      : entries?.map((entry) => {
                        // One kind of row is left — a directory — and it is a
                        // control: double-click enters it, and a keyboard
                        // activation (a click with `detail === 0`) enters it too,
                        // the only path without a pointer. The request asks the
                        // server for directories only (`dirs=1`), so a file never
                        // reaches this callback.
                        //
                        // The `return` is load-bearing: with a block body a bare
                        // element expression is evaluated and discarded, so every
                        // row becomes undefined and the listing renders blank
                        // while `entries` is non-empty.
                        return jsx('button', {
                          key: entry.name,
                          type: 'button',
                          className: 'sshwsp-entry sshwsp-entry-dir',
                          onClick: (event) => { if (event.detail === 0) handleEntry(entry) },
                          onDoubleClick: () => handleEntry(entry),
                          children: [
                            jsx('span', { className: 'sshwsp-entry-icon', children: React.createElement(FolderIcon) }),
                            jsx('span', { className: 'sshwsp-entry-name', children: entry.name }),
                          ],
                        })
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
              // The dialog can be showing a parent's rows while the input holds a
              // name still being typed; the tooltip names the directory the click
              // will actually mount, which is the one the listing describes.
              title: path ?? undefined,
              children: mounting ? t('browser.mounting') : t('browser.mount'),
            }),
          ]}),
        ]}),
      ]}))
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
      return modalLayer(jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(onClose), children: [
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
      ]}))
    }

    exports.HostEditor = HostEditor
    exports.DirectoryBrowser = DirectoryBrowser
    exports.ReportDialog = ReportDialog
    return module.exports
  },
})
