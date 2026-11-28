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
      FileIcon,
      pickerShowsFiles,
      sortPickerEntries,
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
      fetchJson,
      BROWSE_LIST_LIMIT,
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
      // The probe: `null` until the user tests, then the answer plus the form it
      // was measured against. Keeping that signature is what stops a green
      // "reachable" from surviving an edit to the address that produced it.
      const [testing, setTesting] = React.useState(false)
      const [probe, setProbe] = React.useState(null)

      // Secrets are never sent back to the browser, so an untouched field is
      // empty on edit — blank means "keep the stored one".
      const keepPassword = editing && host.auth === 'password'
      const keepPassphrase = editing && host.auth === 'key'

      // One payload for both verbs. Saving and testing must describe the SAME
      // host, and two hand-built bodies is how a probe ends up green about a
      // field the save route never receives.
      const buildPayload = () => ({
        originalAlias: editing ? host.alias : undefined,
        alias: alias.trim(),
        host: hostName.trim(),
        port: Number.parseInt(port, 10),
        user: user.trim(),
        auth: { kind: authKind, keyPath: keyPath.trim(), passphrase, password, agentPath: agentPath.trim() },
        description: description.trim(),
        // Split on commas, trim, drop blanks, de-duplicate — the same
        // normalization the store applies, done here so the saved entity
        // and the reopened editor agree without a round trip.
        tags: [...new Set(tags.split(',').map(tag => tag.trim()).filter(tag => tag !== ''))],
        agentForward,
        compress,
      })

      // What the form must say before either verb may run. Returns the message
      // rather than setting it, so the caller decides whether the complaint
      // belongs under the form or is simply a refused probe.
      const validate = () => {
        if (!/^\d+$/u.test(port.trim())) return t('editor.badPort')
        const portNumber = Number.parseInt(port, 10)
        if (portNumber < 1 || portNumber > 65535) return t('editor.badPort')
        for (const [value, key] of [[alias, 'editor.alias'], [hostName, 'editor.host'], [user, 'editor.user']]) {
          if (value.trim() === '') return t('editor.required', { field: t(key) })
        }
        if (authKind === 'key' && keyPath.trim() === '') return t('editor.required', { field: t('editor.keyPath') })
        if (authKind === 'password' && password === '' && !keepPassword) return t('editor.required', { field: t('editor.password') })
        return null
      }

      // Test the host as typed, without saving it. The old panel could only
      // test a host that already existed, so "is this address right?" was a
      // question you answered by saving a possibly-wrong host first.
      const test = async () => {
        const problem = validate()
        if (problem !== null) { setError(problem); setProbe(null); return }
        const payload = buildPayload()
        setTesting(true)
        setError(null)
        setProbe(null)
        try {
          const result = await fetchJson(API.test, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ form: payload }),
          })
          setProbe(result.ok
            ? { ok: true, durationMs: result.durationMs ?? 0, for: JSON.stringify(payload) }
            : { ok: false, error: result.error ?? t('editor.testFail'), for: JSON.stringify(payload) })
        } catch (err) {
          setProbe({ ok: false, error: err.message, for: JSON.stringify(payload) })
        } finally {
          setTesting(false)
        }
      }
      // Shown only while the form still says what was tested.
      const probeLive = probe !== null && probe.for === JSON.stringify(buildPayload())
      const busy = saving || testing

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
        const problem = validate()
        if (problem !== null) { setError(problem); return }
        setSaving(true)
        setError(null)
        try {
          const result = await fetchJson(API.hostSave, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildPayload()),
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
            probeLive && jsx('div', {
              className: probe.ok ? 'sshwsp-probe sshwsp-probe-ok' : 'sshwsp-probe sshwsp-probe-err',
              role: 'status',
              children: probe.ok
                ? t('editor.testOk', { ms: probe.durationMs })
                : t('editor.testFail', { error: probe.error }),
            }),
          ]}) }),
          jsxs('div', { className: 'sshwsp-dialog-footer', children: [
            jsx('button', { className: 'sshwsp-btn', onClick: onClose, disabled: busy, children: t('editor.cancel') }),
            // Between the two verbs, where the question it answers sits: "is
            // this host right?" is what you ask BEFORE committing the form.
            jsx('button', {
              className: 'sshwsp-btn',
              onClick: test,
              disabled: busy,
              children: testing ? t('editor.testing') : t('editor.test'),
            }),
            jsx('button', { className: 'sshwsp-btn sshwsp-btn-primary', onClick: submit, disabled: busy, children: saving ? t('editor.saving') : t('editor.save') }),
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
      // means the listing holds no SELECTION SET: there is no batch verb left
      // to serve.
      //
      // It does hold one picked row, though — the mount target. A single click
      // picks it and a double click still enters, so reading the listing no
      // longer costs a navigation; before this, mounting a subdirectory meant
      // entering it first and mounting the directory you were then in. One
      // path, not a set: this picker has exactly one verb.
      const [picked, setPicked] = React.useState(null)
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
        // Any new listing invalidates the pick: the row it named may not even be
        // in the answer, and a mount button pointing at an invisible row is the
        // one failure this state must never produce.
        setPicked(null)
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
          // `dirs=1` keeps a directory row the only row, and it makes the server
          // filter BEFORE it applies the cap, so `total` and `truncated` count
          // the rows this dialog shows. With "show files" on, the request drops
          // it: the same cap then counts directories AND files, ordered with
          // directories first, and the file rows render as context only.
          const listingQuery = pickerShowsFiles() ? '' : '&dirs=1'
          const data = await fetchJson(`${API.ls}?alias=${encodeURIComponent(alias)}${query}&limit=${BROWSE_LIST_LIMIT}${listingQuery}`)
          if (seq !== loadSeq.current) return
          // Directories first, then names: the server only orders by this rule
          // when it truncates, and a file between two directories would read as
          // a row this picker can enter.
          const sorted = sortPickerEntries(data.entries)
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

      // What the mount button acts on: the picked row when there is one, else
      // the directory being listed. Derived, never stored — a stored target
      // would survive a refresh that removed the row it named.
      const target = picked ?? path

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
            body: JSON.stringify({ alias, remotePath: target, register: true }),
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
                        // Two kinds of row when "show files" is on. A DIRECTORY is
                        // a control with two gestures: a single click PICKS it as
                        // the mount target, a double click enters it. A FILE is
                        // context and deliberately NOT a control: this dialog
                        // cannot enter, mount, download or preview a file, so a
                        // button would advertise an action it does not have. A
                        // keyboard activation arrives as a click with `detail ===
                        // 0` on the directories only.
                        //
                        // The `return`s are load-bearing: with a block body a bare
                        // element expression is evaluated and discarded, so every
                        // row becomes undefined and the listing renders blank while
                        // `entries` is non-empty.
                        if (entry.type !== 'directory') {
                          return jsx('div', {
                            key: entry.name,
                            className: 'sshwsp-entry sshwsp-entry-file',
                            // No onClick, no aria-current, no tabIndex: a file row
                            // must not be pickable, focusable or announced as a
                            // choice. `title` is the only affordance it gets.
                            title: t('browser.fileHint'),
                            children: [
                              jsx('span', { className: 'sshwsp-entry-icon', children: React.createElement(FileIcon) }),
                              jsx('span', { className: 'sshwsp-entry-name', children: entry.name }),
                            ],
                          })
                        }
                        const full = path == null ? null : childDirectoryPath(path, entry.name)
                        const isPicked = full !== null && full === picked
                        return jsx('button', {
                          key: entry.name,
                          type: 'button',
                          className: isPicked
                            ? 'sshwsp-entry sshwsp-entry-dir sshwsp-entry-picked'
                            : 'sshwsp-entry sshwsp-entry-dir',
                          'aria-current': isPicked ? 'true' : undefined,
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
            // The target is stated in words, not only in a tooltip and a
            // highlight: picking a row changes what the button does while the
            // path bar keeps showing the directory being listed, and those two
            // disagreeing silently is how the wrong directory gets mounted.
            target != null && jsx('div', { className: 'sshwsp-picked', children: t('browser.picked', { path: target }) }),
          ]}),
          jsxs('div', { className: 'sshwsp-dialog-footer', children: [
            jsx('button', { className: 'sshwsp-btn', onClick: onClose, children: t('dialog.close') }),
            jsx('button', {
              className: 'sshwsp-btn sshwsp-btn-primary',
              disabled: mounting || target == null || mountResult?.ok === true,
              onClick: handleMount,
              // The tooltip names the directory the click will actually mount —
              // the picked row if there is one, otherwise the listed directory.
              title: target ?? undefined,
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
     * The tone of one report line.
     *
     * The report is a plain-text artifact and stays one: copy must paste the
     * same bytes the reader sees, so the tone is presentational only. It is
     * read off the leading word the report already prints, which is why the
     * colour cannot end up describing something the text does not say. A line
     * this does not recognise stays neutral rather than guessing.
     *
     * `bad` is the tone for the lines that name a thing that is BROKEN —
     * a seam that failed to install, a host key that was accepted but not
     * pinned, a store that could not be read. Those are the ones a reader is
     * expected to act on; everything else is information.
     */
    function reportLineTone (line) {
      if (/^#{1,6} /u.test(line)) return 'head'
      // Broken first, and deliberately BEFORE the WARN branch: a WARN line
      // whose detail names a failed seam is the same fact the panel paints red
      // on its badge, and the two surfaces must not disagree.
      if (/\bfailed\b|NOT PINNED|^store error:|^skipped:/u.test(line)) return 'bad'
      if (/^WARN\b/u.test(line) || /^verdict: needs attention\b/u.test(line)) return 'warn'
      if (/^UNKNOWN\b/u.test(line) || /^NOTE\b/u.test(line) || /^verdict: could not judge\b/u.test(line)) return 'unknown'
      if (/^verdict: ok\b/u.test(line)) return 'ok'
      return ''
    }

    /**
     * The diagnostic report, rendered as wrapped, selectable text.
     *
     * This dialog exists because the report's own URL cannot be opened as a
     * window in the Desktop app (see `openSupportBundle`), and because the one
     * thing a user needs from it — getting the text onto the clipboard — has to
     * work even where `navigator.clipboard` is unavailable. So the text is
     * rendered as selectable lines: the report is scanned for the ONE line that
     * says what is wrong, and a single monospaced field made every line look
     * identical. Each line keeps the tone its own first word already carries
     * (`WARN` / `UNKNOWN` / `failed` / `NOT PINNED`), so the colour can never
     * disagree with the text, and the copy path still puts the same plain text
     * on the clipboard. When the clipboard is denied, the selection fallback
     * selects these very lines, so what the reader sees is what Ctrl+C takes.
     *
     * The text WRAPS (`white-space: pre-wrap`). It used to keep
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
      const bodyRef = React.useRef(null)
      const lines = String(text ?? '').split('\n')
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
        const body = bodyRef.current
        if (body === null || typeof window.getSelection !== 'function') return
        const range = document.createRange()
        range.selectNodeContents(body)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
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
            // One element per line rather than one `<pre>`: the tone lives on
            // the line, and a single text node cannot carry five colours. The
            // nbsp keeps the empty rows (the report uses blank lines between
            // sections) from collapsing to zero height.
            jsx('div', {
              ref: bodyRef,
              className: 'sshwsp-report-body',
              role: 'document',
              'aria-label': t('support.title'),
              children: lines.map((line, index) => {
                const tone = reportLineTone(line)
                return jsx('div', {
                  key: index,
                  className: tone === '' ? 'sshwsp-report-line' : `sshwsp-report-line sshwsp-report-line-${tone}`,
                  children: line === '' ? '\u00a0' : line,
                })
              }),
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

    // =========================================================================
    // Host power dialog (confirm a hard switch-off)
    // =========================================================================
    /**
     * Confirm switching one host hard off.
     *
     * The dialog exists because the action is not reversible by undo: it aborts
     * commands, closes shells, tunnels, watchers and terminals, and drops the
     * connection. So it names what will be interrupted, from the live counts the
     * hosts route just read (not from a cached snapshot), and it says plainly
     * what stays: the sessions stay open, dimmed, until the host is switched
     * back on.
     *
     * Presentational only: the POST is the panel's, so the busy and error states
     * live where every other host action already keeps them.
     */
    function HostPowerDialog ({ host, busy, error, onConfirm, onCancel, t }) {
      const dialog = useDialogA11y({ onClose: onCancel, busy, label: t('hosts.powerOffTitle', { alias: host?.alias ?? '' }) })
      const counts = host?.resources ?? {}
      const lines = [
        ['hosts.resources.connections', counts.connections ?? 0, 'hosts.resources.connection'],
        ['hosts.resources.commands', counts.inFlight ?? 0, 'hosts.resources.command'],
        ['hosts.resources.shells', counts.shells ?? 0, 'hosts.resources.shell'],
        ['hosts.resources.forwards', (counts.forwards ?? 0) + (counts.savedForwards ?? 0), 'hosts.resources.forward'],
        ['hosts.resources.reverseForwards', counts.reverseForwards ?? 0, 'hosts.resources.reverseForward'],
        ['hosts.resources.watches', counts.watches ?? 0, 'hosts.resources.watch'],
        ['hosts.resources.terminals', counts.terminals ?? 0, 'hosts.resources.terminal'],
      ].filter(([, n]) => n > 0)
      return modalLayer(jsxs('div', { className: 'sshwsp-backdrop', ...backdropDismiss(busy ? () => {} : onCancel), children: [
        jsxs('div', { className: 'sshwsp-dialog sshwsp-dialog-narrow', ...dialog.props, ref: dialog.bodyRef, tabIndex: -1, onClick: (e) => e.stopPropagation(), children: [
          jsxs('div', { className: 'sshwsp-dlg-head', children: [
            jsx('h2', { id: dialog.titleId, children: t('hosts.powerOffTitle', { alias: host?.alias ?? '' }) }),
            jsx('button', {
              className: 'sshwsp-icon-btn',
              'aria-label': t('dialog.close'),
              disabled: busy,
              onClick: onCancel,
              children: React.createElement(CloseIcon, { size: 14 }),
            }),
          ]}),
          // The body is PROSE, so it carries the inset itself: the shell's body is a
          // scrollport with padding 0, which is right when a list owns its own insets
          // (the directory browser) and wrong here, where the paragraph IS the content
          // and sat flush against the frame's border.
          jsxs('div', { className: 'sshwsp-dialog-body sshwsp-dialog-body-pad', children: [
            jsx('p', { className: 'sshwsp-power-lead', children: t('hosts.powerOffLead') }),
            lines.length === 0
              // A sentence, not the empty-state box: nothing is wrong here, there is
              // simply nothing to interrupt, and a dashed placeholder would read as a
              // broken panel inside a confirm dialog.
              ? jsx('p', { className: 'sshwsp-power-idle', children: t('hosts.powerOffIdle') })
              : jsx('ul', { className: 'sshwsp-power-list', children: lines.map(([key, n, one]) => jsx('li', {
                  key,
                  children: t(n === 1 ? one : key, { n }),
                })) }),
            jsx('p', { className: 'sshwsp-warnnote', children: t('hosts.powerOffWarn') }),
            jsx('p', { className: 'sshwsp-power-stays', children: t('hosts.powerOffStays') }),
            error !== undefined && error !== null && jsx('div', { className: 'sshwsp-status sshwsp-status-err', children: error }),
          ]}),
          jsxs('div', { className: 'sshwsp-dialog-footer', children: [
            jsx('button', { className: 'sshwsp-btn', disabled: busy, onClick: onCancel, children: t('hosts.powerOffCancel') }),
            jsx('button', {
              className: 'sshwsp-btn sshwsp-btn-danger',
              disabled: busy,
              onClick: onConfirm,
              children: busy ? t('hosts.powerOffBusy') : t('hosts.powerOffConfirm'),
            }),
          ]}),
        ]}),
      ]}))
    }

    exports.HostEditor = HostEditor
    exports.DirectoryBrowser = DirectoryBrowser
    exports.ReportDialog = ReportDialog
    exports.HostPowerDialog = HostPowerDialog
    return module.exports
  },
})
