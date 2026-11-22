window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.editor.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')

    // Everything outside this chunk comes through the plugin's own exports: the
    // route table, the status-aware request wrapper, one glyph, the byte
    // formatter, and the body portal. Destructured once rather than threaded
    // through props — a panel needing ten props is a worse component, and every
    // call site would have to remember them.
    //
    // Note what is NOT borrowed: `backdropDismiss` and `useDialogA11y`. The
    // editor is not a modal — it portals to the body only so a transformed or
    // scrolling ancestor cannot rebase or clip it — so it has no backdrop to
    // dismiss and owns no focus ring.
    const {
      API,
      CloseIcon,
      formatBytes,
      modalLayer,
      requestJson,
    } = require('@shiqyka/dsh-ssh-workspace')

    /**
     * Where the editor's two preferences are remembered.
     *
     * One key per control, named for the plugin and the control: two plugins on
     * one page cannot collide, and a future preference adds its own key rather
     * than growing a blob. Every read and write is defended — a sandboxed frame
     * with no `localStorage` must cost the preference, never the dialog.
     */
    const WRAP_KEY = 'dsh-ssh-workspace.editor.wrap'

    /** The indent one Tab inserts, and the unit `Shift+Tab` removes. */
    const INDENT = '  '

    /** How many leading spaces `Shift+Tab` takes back at most. */
    const UNINDENT_LIMIT = INDENT.length

    /** Read the wrap preference; missing or junk reads as "do not wrap". */
    function readWrap () {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false
        return localStorage.getItem(WRAP_KEY) === '1'
      } catch {
        return false
      }
    }

    /** Remember the wrap preference. Never throws. */
    function writeWrap (wrap) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return
        localStorage.setItem(WRAP_KEY, wrap === true ? '1' : '0')
      } catch { /* the preference is lost, the toggle still works */ }
    }

    /**
     * The line count, for the gutter and the status line.
     *
     * `text.split('\n').length` rather than counting matches: a file of N lines
     * has N newline-separated pieces, and the last piece has no newline after
     * it. Empty text is one (empty) line, which is what an empty textarea shows.
     *
     * @param {string} text
     * @returns {number}
     */
    function lineCount (text) {
      if (typeof text !== 'string' || text === '') return 1
      let count = 1
      for (let at = 0; at < text.length; at += 1) {
        if (text.charCodeAt(at) === 10) count += 1
      }
      return count
    }

    /**
     * The numbers a gutter shows beside N lines.
     *
     * A separate function so the width calculation is testable and so a future
     * "show only the visible window" change has one place to grow.
     *
     * @param {number} lines
     * @returns {string[]}
     */
    function gutterNumbers (lines) {
      const total = Number.isInteger(lines) && lines > 0 ? lines : 1
      const out = new Array(total)
      for (let at = 0; at < total; at += 1) out[at] = String(at + 1)
      return out
    }

    /**
     * How wide the gutter must be, in characters.
     *
     * Grows with the file, so a 1000-line file does not shift every line one
     * column to the right when it reaches line 10.
     *
     * @param {number} lines
     * @returns {number}
     */
    function gutterWidth (lines) {
      return String(Number.isInteger(lines) && lines > 0 ? lines : 1).length
    }

    /**
     * What one save request looks like.
     *
     * Extracted so the token shape is stated once: a caller that built this by
     * hand could send `version` where `revision` belongs and get a 409 that
     * looks like a real conflict.
     *
     * @returns {{version: string, revision: string}}
     */
    function expectedTokens (base) {
      return { version: base.version, revision: base.revision }
    }

    /**
     * Whether the editor's buffer differs from what was last saved.
     *
     * A separate function because "dirty" drives the close confirmation, the
     * save button's enabled state and the title's marker: three places that
     * must never disagree, and a comparison that must stay exact (no trimming —
     * a trailing newline the user deleted IS a change).
     */
    function isDirty (text, baseText) {
      return text !== baseText
    }

    /**
     * Whether a refused save is the same file under a newer version token.
     *
     * The token is `ino:size:mtime`, so a `touch`, a checkout restoring
     * identical contents, or a backup tool rewriting a file with the same bytes
     * all move it while the content stands still. The 409 carries the digest of
     * what is on disk now and both digests are SHA-256 of the raw bytes, so
     * equality is proof rather than a guess.
     *
     * Both sides have to be real: an empty string means "no token", and two
     * absences treated as a match would resolve a conflict nobody verified.
     */
    function movedTokenOnly (current, lastSaved) {
      const now = typeof current?.revision === 'string' ? current.revision : ''
      const then = typeof lastSaved === 'string' ? lastSaved : ''
      return now !== '' && now === then
    }

    /**
     * The reason a file cannot be edited, as a copy key.
     *
     * The server answers a CODE (`binary`, `not-utf8`, `too-large`, `not-file`,
     * `not-encodable`) and this maps it to a message key. Keeping the mapping
     * here rather than in the response means the server never has to know which
     * language the page is in.
     */
    function refusalKey (reason) {
      if (reason === 'read-only') return 'edit.readOnly'
      if (reason === 'binary') return 'edit.binary'
      if (reason === 'not-utf8') return 'edit.notUtf8'
      if (reason === 'too-large') return 'edit.tooLarge'
      if (reason === 'not-file') return 'edit.notFile'
      if (reason === 'not-encodable') return 'edit.notEncodable'
      return undefined
    }

    /**
     * Insert text at the caret without breaking the browser's undo stack.
     *
     * `document.execCommand('insertText')` is the only way to get a keystroke
     * into a textarea's own undo history: assigning `value` (or a controlled
     * React state) replaces the whole buffer and drops everything the browser
     * remembered. It is deprecated and it is still the right call — the
     * alternative is reimplementing undo.
     *
     * Falls back to a manual splice when the command is unavailable (a
     * document with `execCommand` disabled), so the key is never a silent
     * no-op: losing undo is bad, losing the keystroke is worse.
     *
     * @returns {string|undefined} the new value, or undefined when the command ran.
     */
    function insertAtCaret (element, text) {
      if (element === null || element === undefined) return undefined
      try {
        if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
          if (document.execCommand('insertText', false, text) === true) return undefined
        }
      } catch { /* fall through to the splice */ }
      const start = typeof element.selectionStart === 'number' ? element.selectionStart : element.value.length
      const end = typeof element.selectionEnd === 'number' ? element.selectionEnd : start
      const next = `${element.value.slice(0, start)}${text}${element.value.slice(end)}`
      element.value = next
      element.selectionStart = start + text.length
      element.selectionEnd = start + text.length
      return next
    }

    // =========================================================================
    // The preview header's Edit button
    // =========================================================================

    /**
     * The element the editor should cover: the preview's own BODY.
     *
     * The action slot hands us `absolutePath` and nothing else — no DOM, no
     * pane handle — so the pane is found from the button's own position in the
     * tree. Walking to the preview root by a DATA attribute rather than a class
     * name matters: the Host's CSS-modules class names are hashed per build and
     * change between releases, while `data-textpreview-*` is the documented
     * surface the preview exposes for exactly this kind of consumer.
     *
     * The body (not the root) is deliberate. The root also holds the header,
     * and covering the header would hide the very button the user just pressed
     * — including the toolbar's own close/viewer controls, which stay useful
     * while editing.
     *
     * @param {Element | null | undefined} node - the button's DOM node.
     * @returns {Element | null} the box to cover, or null when the preview has
     *   been replaced by something without a body (a failed load, a remount).
     */
    function paneBoxOf (node) {
      if (node === null || node === undefined || typeof node.closest !== 'function') return null
      const root = node.closest('[data-textpreview-url]') ?? node.closest('[data-textpreview-state]')
      if (root === null) return null
      return root.querySelector('[data-textpreview-body]') ?? root
    }

    /**
     * Track the pixel box the editor must occupy, in VIEWPORT coordinates.
     *
     * A `position: fixed` panel is measured rather than laid out in flow: the
     * preview's body belongs to the Host's DOM, and inserting a wrapper into it
     * would fight the pane's own flex sizing (and be thrown away on the next
     * remount). Measuring is also what makes the editor follow a pane resize, a
     * window resize, and a scroll of an ancestor — all three change the box
     * without changing the editor's props.
     *
     * Nothing here tries to work out WHERE `position: fixed` resolves from. An
     * earlier version did, by subtracting `offsetParent`'s origin — and that was
     * wrong: `offsetParent` is the nearest POSITIONED ancestor, which for an
     * ordinary panel is not the same thing as the fixed-position CONTAINING
     * block (which stays the viewport unless an ancestor carries a transform).
     * Subtracting the sidebar's origin moved the whole editor left, over the
     * conversation. `usePanelPlacement` fixes that the only way that cannot be
     * wrong: it measures the panel after it renders and shifts it by whatever
     * the difference turns out to be.
     *
     * @param {{current: (Element | null)}} anchorRef - the button's ref.
     * @param {boolean} active - whether the editor is open.
     * @returns {{left: number, top: number, width: number, height: number} | null}
     */
    function usePaneRect (anchorRef, active) {
      const [rect, setRect] = React.useState(null)
      React.useEffect(() => {
        if (!active) {
          setRect(null)
          return undefined
        }
        let frame = 0
        const measure = () => {
          const host = paneBoxOf(anchorRef.current)
          if (host === null) {
            setRect(null)
            return
          }
          const box = host.getBoundingClientRect()
          setRect(current => (
            current !== null &&
            current.left === box.left && current.top === box.top &&
            current.width === box.width && current.height === box.height
              ? current
              : { left: box.left, top: box.top, width: box.width, height: box.height }
          ))
        }
        // One measure per frame at most: a wheel gesture fires dozens of scroll
        // events, and each would otherwise force a layout read.
        const schedule = () => {
          if (frame !== 0) return
          if (typeof requestAnimationFrame !== 'function') { measure(); return }
          frame = requestAnimationFrame(() => { frame = 0; measure() })
        }
        measure()
        const host = paneBoxOf(anchorRef.current)
        const observer = typeof ResizeObserver === 'function' && host !== null ? new ResizeObserver(schedule) : null
        observer?.observe?.(host)
        window.addEventListener('resize', schedule)
        // Capture, so a scroll of ANY ancestor (the pane, the sidebar column,
        // the page) re-measures — the editor is fixed, so it does not move with
        // the content and would otherwise hang over the wrong box.
        window.addEventListener('scroll', schedule, true)
        return () => {
          if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          observer?.disconnect?.()
          window.removeEventListener('resize', schedule)
          window.removeEventListener('scroll', schedule, true)
        }
      }, [anchorRef, active])
      return rect
    }

    /**
     * Place a fixed-position panel over a viewport rect, whatever the page does.
     *
     * `position: fixed` is relative to the viewport — until some ancestor
     * establishes a containing block with `transform` / `filter` /
     * `perspective` / `will-change`, at which point it silently becomes relative
     * to THAT element while `getBoundingClientRect()` keeps answering viewport
     * coordinates. The Host does exactly this to its composer
     * (`.composerSeat { will-change: transform }`, see `docs/ui.md`), so the
     * case is real and not hypothetical.
     *
     * Two ways to cope. The wrong one is to work out which element is the
     * containing block and subtract its origin — `offsetParent` is the nearest
     * POSITIONED ancestor, which is NOT the same question, and using it moved
     * the editor over the conversation instead of into the file pane. The right
     * one is not to reason about it at all: render, measure where the panel
     * ACTUALLY landed, and publish the delta. Whatever the containing block is,
     * the correction is exact by construction, and it stays exact if the Host
     * changes its CSS in a future release.
     *
     * One correction per mount is enough in practice (the delta is a property
     * of the ancestor chain, not of the scroll position), but it is re-derived
     * whenever the box changes so a moved panel cannot keep a stale offset.
     *
     * @param {{current: (Element | null)}} panelRef - the panel's ref.
     * @param {{left: number, top: number, width: number, height: number} | null} rect - wanted box.
     * @returns {{x: number, y: number}} the correction to add, in pixels.
     */
    function useSelfCorrectingOffset (panelRef, rect) {
      const [fix, setFix] = React.useState({ x: 0, y: 0 })
      const wanted = rect === null ? null : rect
      const wantLeft = wanted === null ? null : wanted.left
      const wantTop = wanted === null ? null : wanted.top
      React.useEffect(() => {
        const node = panelRef.current
        if (node === null || wantLeft === null || wantTop === null) return
        const actual = node.getBoundingClientRect()
        // `actual` is where the style `left = want + fix` landed, so the
        // containing block's origin is `actual - want - fix`. Solving for
        // `actual = want` gives the new correction, which is why the CURRENT
        // fix has to be added back in: computing `want - actual` alone is the
        // right answer only while `fix` is still zero, and would oscillate on
        // every re-measure after the first.
        setFix(current => {
          const nextX = wantLeft - actual.left + current.x
          const nextY = wantTop - actual.top + current.y
          // Sub-pixel differences are not worth a render, and the tolerance is
          // what stops a half-pixel from looping: rounding the correction into
          // the layout can leave a fraction that would otherwise re-trigger.
          const close = (a, b) => Math.abs(a - b) < 0.5
          return close(current.x, nextX) && close(current.y, nextY) ? current : { x: nextX, y: nextY }
        })
      }, [panelRef, wantLeft, wantTop, fix.x, fix.y])
      return fix
    }

    /**
     * The editor's entry point, rendered into the preview header's action slot.
     *
     * It PROBES before it offers anything. The slot is rendered for every file
     * the user previews — including PNGs and 400 MB logs — and a button that
     * appears and then refuses is worse than no button: the refusal arrives
     * after the click, when the user has already committed to the gesture. So
     * the probe runs on mount, and while it is in flight nothing is drawn.
     *
     * A refusal is NOT silent: the reason becomes the button's `title` while the
     * button itself stays disabled. Hiding it entirely was the first draft, and
     * it reads as "this plugin does not support editing" rather than "this file
     * cannot be edited" — the two need different fixes.
     *
     * The session comes from the slot, not from the composer. This slot is
     * `scope: 'session'`, so the Host renders it inside the Session that owns
     * the preview and hands every occupant `sessionId` as a standard prop
     * (ui-session's BUILTIN_SOURCE declares it). Reading
     * `ctx.get('uiSession').adapter.current` instead — the MAIN session, which
     * is whatever the composer is pointed at — is wrong in the one case that
     * matters: a preview opened from a workspace that is not the composer's,
     * where the probe would be asked about a session that cannot see the file
     * and the server would refuse with "could not identify the session that
     * owns this workspace". The prop is the session the panel is actually
     * showing.
     */
    function FileEditAction (props) {
      const absolutePath = typeof props?.absolutePath === 'string' ? props.absolutePath : ''
      const t = props?.t ?? (key => key)
      const ctx = props?.ctx
      const [probe, setProbe] = React.useState({ phase: 'idle', reason: null, message: '', sessionId: '' })
      const [editing, setEditing] = React.useState(false)
      const buttonRef = React.useRef(null)
      const rect = usePaneRect(buttonRef, editing)

      // The Session the Host scoped this slot to. `props.sessionId` is a string
      // for a live session; anything else (an absent scope, an older Host that
      // does not publish it) falls back to the composer's current session so the
      // button still works on the common path.
      const sessionId = React.useMemo(() => {
        if (absolutePath === '') return ''
        const scoped = typeof props?.sessionId === 'string' ? props.sessionId : ''
        if (scoped !== '') return scoped
        try {
          const value = ctx?.get?.('uiSession')?.adapter?.current?.getSnapshot?.()
          return typeof value?.key === 'string' ? value.key : ''
        } catch {
          return ''
        }
      }, [ctx, absolutePath, props?.sessionId])

      React.useEffect(() => {
        if (absolutePath === '' || sessionId === '') {
          setProbe({ phase: 'idle', reason: null, message: '', sessionId })
          return undefined
        }
        const controller = new AbortController()
        setProbe({ phase: 'probing', reason: null, message: '', sessionId })
        const query = new URLSearchParams({ sessionId, path: absolutePath, probe: '1' })
        requestJson(`${API.readText}?${query.toString()}`, { signal: controller.signal }).then(
          (reply) => {
            if (controller.signal.aborted) return
            if (reply.ok && reply.data?.editable === true) {
              setProbe({ phase: 'ready', reason: null, message: '', sessionId })
              return
            }
            // A refusal the server made explicit, or a transport failure. Both
            // keep the button visible and disabled, with the reason in its
            // tooltip — the user needs to know WHICH of the two it was.
            setProbe({
              phase: 'refused',
              reason: typeof reply.data?.reason === 'string' ? reply.data.reason : null,
              message: typeof reply.data?.error === 'string' ? reply.data.error : '',
              sessionId,
            })
          },
          (error) => {
            if (controller.signal.aborted) return
            setProbe({ phase: 'refused', reason: null, message: error instanceof Error ? error.message : String(error), sessionId })
          },
        )
        return () => controller.abort()
      }, [absolutePath, sessionId])

      // Nothing is drawn while the answer is unknown: a button that flickers in
      // and out on every preview is worse than one that arrives a moment late.
      if (probe.phase === 'idle' || probe.phase === 'probing') return null
      if (absolutePath === '') return null

      const refusal = refusalKey(probe.reason)
      const ready = probe.phase === 'ready'
      const label = ready ? t('edit.actionHint') : (refusal === undefined ? t('edit.failed') : t(refusal, { size: formatBytes(probe.size ?? 0) }))
      const title = ready ? t('edit.actionHint') : `${label}${probe.message === '' ? '' : ` — ${probe.message}`}`

      return jsx(React.Fragment, { children: [
        jsx('button', {
          ref: buttonRef,
          type: 'button',
          className: 'sshwsp-fileaction sshwsp-fileaction-edit',
          title,
          'aria-label': title,
          disabled: !ready,
          onClick: () => {
            if (!ready) return
            setEditing(true)
          },
          children: jsx(EditIcon, { size: 16 }),
        }),
        editing && ready && rect !== null
          ? jsx(React.Suspense, {
            fallback: null,
            children: jsx(FileEditorPanel, {
              path: absolutePath,
              sessionId,
              t,
              rect,
              onClose: () => setEditing(false),
              onSaved: () => setEditing(false),
            }),
          })
          : null,
      ]})
    }

    /**
     * The editor itself: a native `<textarea>`, a gutter, and two tokens.
     *
     * It is an OVERLAY ON THE PREVIEW BODY, not a modal. The request was "click
     * edit and edit right there in the file area" — a centered dialog takes the
     * user's eyes and the file's position away from them, and every dismissal
     * (Escape, the backdrop, a stray click outside) then throws away the work.
     * Covering the preview's own box keeps the file exactly where it was, and
     * the preview header stays visible above it with the same button, now
     * acting as the way out.
     *
     * The textarea is deliberate. Every editing gesture a person expects —
     * selection, undo, IME, double-click, word movement — is already correct
     * inside it, and a `contenteditable` would mean reimplementing all of them.
     * What the textarea does NOT give is Tab (the browser moves focus) and
     * Ctrl+S (the browser's own "save page"), so those two are handled here and
     * nothing else is.
     */
    function FileEditorPanel ({ path: target, sessionId, t, rect, onClose, onSaved }) {
      const [state, setState] = React.useState({
        phase: 'loading',
        text: '',
        baseText: '',
        baseVersion: '',
        baseRevision: '',
        eol: 'LF',
        bom: false,
        truncated: false,
        size: 0,
        error: '',
      })
      const [saving, setSaving] = React.useState(false)
      const [conflict, setConflict] = React.useState(null)
      const [confirmOverwrite, setConfirmOverwrite] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [wrap, setWrap] = React.useState(readWrap)
      const [requestToken, setRequestToken] = React.useState(0)
      const textareaRef = React.useRef(null)
      const gutterRef = React.useRef(null)
      const panelRef = React.useRef(null)
      // Where the panel ACTUALLY landed versus where it was asked to be. The
      // panel is fixed-positioned but may be rebased by a transformed ancestor,
      // so the wanted coordinates are corrected from a real measurement instead
      // of from a guess about which element is the containing block.
      const offset = useSelfCorrectingOffset(panelRef, rect)

      const dirty = state.phase === 'ready' && isDirty(state.text, state.baseText)
      const busy = saving
      const lines = lineCount(state.text)

      /**
       * Close, but never silently throw away typing.
       *
       * No modal confirm here: the panel sits where the file was and the user
       * can see it, so a `window.confirm` would be a second dialog on top of an
       * inline editor. The dirty check stays because losing a paragraph is
       * still losing a paragraph — it just asks the same way every other
       * unsaved-changes prompt in this plugin does.
       */
      const close = React.useCallback(() => {
        if (busy) return
        if (dirty && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (window.confirm(t('edit.unsavedPrompt')) !== true) return
        }
        onClose?.()
      }, [busy, dirty, onClose, t])

      /**
       * Warn before a page unload that would discard unsaved text.
       *
       * The close button already asks, but a refresh, a tab close or a
       * navigation away from the app never reaches that path — the draft is
       * simply gone, with nothing said. This is the only hook a page gets for
       * those, so it is bound to `dirty` and to nothing else: a listener that
       * stays on after a save would block a refresh that loses no data.
       *
       * Both `preventDefault()` and `returnValue` are set because the two are
       * each needed by different browsers, and the message text is not
       * honoured by any of them — which is why nothing is written into it.
       *
       * This is the ONE place a guard is enough. The reference implementation
       * had to persist drafts to localStorage instead, because its host took
       * the tab away via `registerCloseHandler` (a synchronous cleanup, where
       * only throwing can veto) and the desktop shell intercepts Cmd+Q before
       * the page sees it. An inline panel has no such path: the page is the
       * only thing that can lose the text.
       */
      React.useEffect(() => {
        if (dirty !== true) return undefined
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const guard = (event) => {
          event.preventDefault()
          event.returnValue = ''
          return ''
        }
        window.addEventListener('beforeunload', guard)
        return () => window.removeEventListener('beforeunload', guard)
      }, [dirty])

      // Escape closes and Ctrl/Cmd+S saves, but ONLY while the focus is inside
      // the panel. A global listener would steal Escape from the composer and
      // from any dialog opened on top of this one; a listener on the panel
      // itself cannot.
      React.useEffect(() => {
        const node = panelRef.current
        if (node === null) return undefined
        // Focus lands in the text once it arrives, so the first Tab goes into
        // the text and not into the toolbar.
        const timer = setTimeout(() => textareaRef.current?.focus?.(), 0)
        return () => clearTimeout(timer)
      }, [state.phase])

      // One load path, driven by `requestToken` so "reload" and the conflict
      // strip's reload are the same code and cannot drift.
      React.useEffect(() => {
        const controller = new AbortController()
        setState(current => ({ ...current, phase: 'loading', error: '' }))
        const query = new URLSearchParams({ sessionId, path: target })
        requestJson(`${API.readText}?${query.toString()}`, { signal: controller.signal }).then(
          (reply) => {
            if (controller.signal.aborted) return
            if (!reply.ok || reply.data?.ok !== true) {
              setState(current => ({
                ...current,
                phase: 'failed',
                error: typeof reply.data?.error === 'string' ? reply.data.error : `HTTP ${reply.status}`,
              }))
              return
            }
            const text = typeof reply.data.text === 'string' ? reply.data.text : ''
            setState({
              phase: 'ready',
              text,
              baseText: text,
              baseVersion: String(reply.data.version ?? ''),
              baseRevision: String(reply.data.revision ?? ''),
              eol: typeof reply.data.eol === 'string' ? reply.data.eol : 'LF',
              bom: reply.data.bom === true,
              truncated: reply.data.truncated === true,
              size: Number(reply.data.size ?? 0),
              error: '',
            })
          },
          (error) => {
            if (controller.signal.aborted) return
            setState(current => ({
              ...current,
              phase: 'failed',
              error: error instanceof Error ? error.message : String(error),
            }))
          },
        )
        return () => controller.abort()
      }, [sessionId, target, requestToken])

      // The gutter scrolls with the text, not independently: two scroll ports
      // would desynchronise the moment a wheel event landed on the wrong one.
      const syncScroll = React.useCallback(() => {
        const area = textareaRef.current
        const gutter = gutterRef.current
        if (area === null || gutter === null) return
        gutter.scrollTop = area.scrollTop
      }, [])

      /**
       * Save the buffer.
       *
       * `overwrite` is the ONLY way to write after a conflict, and it does not
       * skip the server's check — it re-reads the current tokens first, so the
       * save is still conditional. A `force` flag on the server would be one
       * line shorter and would eventually be called from somewhere that had no
       * business overwriting anything.
       */
      const save = React.useCallback(async ({ overwrite = false } = {}) => {
        if (state.phase !== 'ready' || saving) return
        if (state.truncated) return
        setSaving(true)
        setNotice('')
        try {
          let tokens = expectedTokens({ version: state.baseVersion, revision: state.baseRevision })
          if (overwrite) {
            // Re-read: the conflict dialog only promises "your version wins",
            // not "skip the check". A second change between the 409 and this
            // click is refused like any other.
            const query = new URLSearchParams({ sessionId, path: target })
            const fresh = await requestJson(`${API.readText}?${query.toString()}`)
            if (!fresh.ok || fresh.data?.ok !== true) {
              setNotice(typeof fresh.data?.error === 'string' ? fresh.data.error : t('edit.failed'))
              return
            }
            tokens = expectedTokens({ version: String(fresh.data.version ?? ''), revision: String(fresh.data.revision ?? '') })
          }
          const sent = state.text
          // At most two attempts. The second exists only when the refusal
          // PROVED the contents still match, and it sends the same text against
          // the newer token. It never loops: a second refusal means something
          // moved twice, which is a real conflict.
          let reply
          for (let attempt = 1; ; attempt += 1) {
            reply = await requestJson(API.writeText, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                sessionId,
                path: target,
                text: sent,
                eol: 'auto',
                bom: state.bom,
                expected: tokens,
              }),
            })
            if (reply.status !== 409 || attempt > 1) break
            const current = reply.data?.current
            if (!movedTokenOnly(current, tokens.revision)) break
            // Only the token moved, so what we read is still what is on disk:
            // adopt the new token and save straight away instead of asking the
            // user to resolve a conflict that does not exist.
            tokens = expectedTokens({
              version: String(current.version ?? ''),
              revision: String(current.revision ?? ''),
            })
          }
          if (reply.status === 409) {
            setConflict({
              version: String(reply.data?.current?.version ?? ''),
              revision: String(reply.data?.current?.revision ?? ''),
            })
            return
          }
          if (!reply.ok || reply.data?.ok !== true) {
            setNotice(typeof reply.data?.error === 'string' ? reply.data.error : `${t('edit.saveFailed')} (HTTP ${reply.status})`)
            return
          }
          setConflict(null)
          setConfirmOverwrite(false)
          // Advance the baseline, and ONLY the baseline when the user kept
          // typing: replacing `text` with what was sent would delete the
          // characters typed while the request was in flight, which reads as
          // "saving ate my last sentence".
          setState(current => ({
            ...current,
            baseText: sent,
            baseVersion: String(reply.data.version ?? ''),
            baseRevision: String(reply.data.revision ?? ''),
          }))
          setNotice(t('edit.saved'))
          onSaved?.(reply.data)
        } catch (error) {
          setNotice(`${t('edit.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setSaving(false)
        }
      }, [state, saving, sessionId, target, t, onSaved])

      const reload = React.useCallback(() => {
        setConflict(null)
        setConfirmOverwrite(false)
        setNotice('')
        setRequestToken(value => value + 1)
      }, [])

      /**
       * The textarea's own keys: Tab, Shift+Tab, Ctrl/Cmd+S, Escape.
       * Everything else is left to the browser on purpose.
       *
       * Escape is scoped to the panel rather than registered globally. The old
       * modal used `useDialogA11y`, whose listener sits on `document` in the
       * capture phase; that is right for a modal (it owns the screen) and wrong
       * for an inline editor, which must not swallow Escape while the composer
       * or a dialog opened on top of it has focus.
       */
      const onTextareaKeyDown = React.useCallback((event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
          return
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S')) {
          event.preventDefault()
          void save()
          return
        }
        if (event.key !== 'Tab') return
        event.preventDefault()
        const area = event.currentTarget
        if (event.shiftKey) {
          // Un-indent: take back at most one indent's worth of spaces from the
          // start of the current line. Anything more (a tab character, a line
          // with less whitespace) is left alone rather than half-removed.
          const value = area.value
          const caret = area.selectionStart
          const lineStart = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1
          let remove = 0
          while (remove < UNINDENT_LIMIT && value.charAt(lineStart + remove) === ' ') remove += 1
          if (remove === 0) return
          area.setSelectionRange(lineStart, lineStart + remove)
          if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
            const ran = document.execCommand('delete')
            if (ran === true) {
              setState(current => ({ ...current, text: area.value }))
              return
            }
          }
          const next = `${value.slice(0, lineStart)}${value.slice(lineStart + remove)}`
          setState(current => ({ ...current, text: next }))
          return
        }
        // Indent. `insertAtCaret` runs the browser's own command so the insert
        // lands in its undo stack; the state is then read back from the DOM
        // rather than composed, because a controlled value that disagrees with
        // what the command did would move the caret.
        const spliced = insertAtCaret(area, INDENT)
        setState(current => ({ ...current, text: spliced === undefined ? area.value : spliced }))
      }, [close, save])

      const onChange = React.useCallback((event) => {
        const value = event.target.value
        setState(current => ({ ...current, text: value }))
        setNotice('')
      }, [])

      const toggleWrap = React.useCallback(() => {
        setWrap((current) => {
          const next = current !== true
          writeWrap(next)
          return next
        })
      }, [])

      const name = baseNameOf(target)
      const title = t('edit.title', { name })

      let body
      if (state.phase === 'loading') {
        body = jsx('div', { className: 'sshwsp-editor-state', children: t('edit.loading') })
      } else if (state.phase === 'failed') {
        body = jsxs('div', { className: 'sshwsp-editor-state sshwsp-editor-state-error', children: [
          jsx('p', { children: t('edit.failed') }),
          jsx('p', { className: 'sshwsp-editor-detail', children: state.error }),
          jsx('button', { type: 'button', className: 'sshwsp-btn', onClick: reload, children: t('edit.reload') }),
        ]})
      } else {
        body = jsxs('div', { className: 'sshwsp-editor-body', children: [
          state.truncated
            ? jsx('p', { className: 'sshwsp-editor-warn', children: t('edit.truncated', { size: formatBytes(state.size) }) })
            : null,
          jsxs('div', { className: 'sshwsp-editor-code', children: [
            jsx('pre', {
              className: 'sshwsp-editor-gutter',
              ref: gutterRef,
              'aria-hidden': 'true',
              style: { width: `${gutterWidth(lines)}ch` },
              children: gutterNumbers(lines).join('\n'),
            }),
            jsx('textarea', {
              ref: textareaRef,
              className: 'sshwsp-editor-area' + (wrap ? ' sshwsp-editor-area-wrap' : ''),
              value: state.text,
              spellCheck: false,
              autoComplete: 'off',
              autoCorrect: 'off',
              autoCapitalize: 'off',
              wrap: wrap ? 'soft' : 'off',
              'aria-label': title,
              onChange,
              onKeyDown: onTextareaKeyDown,
              onScroll: syncScroll,
            }),
          ]}),
        ]})
      }

      // A FIXED box over the preview body, positioned from the measured rect.
      // `position: fixed` rather than absolute-in-flow: the preview body belongs
      // to the Host's tree, and inserting a wrapper into it would fight the
      // pane's own flex sizing and be thrown away on the next remount.
      // Portalled to `document.body`, and NOT because this is a dialog. Two
      // concrete failure modes decide it, and both are about ANCESTORS:
      //
      //  - an ancestor with `transform` / `filter` / `will-change` becomes the
      //    containing block for a fixed-position descendant, so the panel would
      //    be positioned against the sidebar instead of the viewport (the Host
      //    does this to its composer), and
      //  - a scrolling ancestor clips it: the sidebar's `.scrollArea` would cut
      //    the panel off at the pane edge, however correct its coordinates are.
      //
      // `modalLayer` is only a `createPortal(children, document.body)` — the
      // name is about where it goes, not about a modal. There is still no
      // backdrop, no `role="dialog"`, no focus trap and no document-level
      // Escape, so the panel remains an inline editor that happens to live
      // beside the app root.
      return modalLayer(jsxs('div', {
        ref: panelRef,
        className: 'sshwsp-editor-panel',
        role: 'group',
        'aria-label': title,
        style: {
          // `offset` corrects for wherever `position: fixed` actually resolved,
          // so these are plain viewport pixels either way.
          left: `${rect.left + offset.x}px`,
          top: `${rect.top + offset.y}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        },
        children: [
          jsxs('div', { className: 'sshwsp-editor-head', children: [
            jsx('span', { className: 'sshwsp-editor-title', children: title }),
            dirty ? jsx('span', { className: 'sshwsp-editor-dirty', children: t('edit.dirty') }) : null,
            notice !== '' ? jsx('span', { className: 'sshwsp-editor-notice', children: notice }) : null,
            jsx('button', {
              type: 'button',
              className: 'sshwsp-icon-btn',
              title: t('edit.close'),
              'aria-label': t('edit.close'),
              onClick: close,
              children: jsx(CloseIcon, {}),
            }),
          ]}),
          conflict !== null
            ? jsxs('div', { className: 'sshwsp-editor-conflict', role: 'alertdialog', children: [
              jsx('p', { className: 'sshwsp-editor-conflict-title', children: t('edit.conflictTitle') }),
              jsx('p', { className: 'sshwsp-editor-detail', children: t('edit.conflictBody') }),
              confirmOverwrite
                ? jsx('p', { className: 'sshwsp-editor-conflict-confirm', children: t('edit.conflictConfirm') })
                : null,
              jsxs('div', { className: 'sshwsp-editor-actions', children: [
                // Reload is FIRST and is the default action: it is the one
                // that cannot lose anyone's work, and a conflict strip whose
                // most reachable control is "overwrite" is a trap.
                jsx('button', {
                  type: 'button',
                  className: 'sshwsp-btn sshwsp-btn-primary',
                  disabled: saving,
                  onClick: reload,
                  children: t('edit.conflictReload'),
                }),
                confirmOverwrite
                  ? jsx('button', {
                    type: 'button',
                    className: 'sshwsp-btn',
                    disabled: saving,
                    onClick: () => { void save({ overwrite: true }) },
                    children: t('edit.conflictConfirmYes'),
                  })
                  : jsx('button', {
                    type: 'button',
                    className: 'sshwsp-btn',
                    disabled: saving,
                    onClick: () => setConfirmOverwrite(true),
                    children: t('edit.conflictOverwrite'),
                  }),
              ]}),
            ]})
            : null,
          body,
          jsxs('div', { className: 'sshwsp-editor-foot', children: [
            jsx('span', { className: 'sshwsp-editor-meta', children: t('edit.lines', { count: lines }) }),
            state.phase === 'ready'
              ? jsx('span', { className: 'sshwsp-editor-meta', children: state.eol === 'CRLF' ? 'CRLF' : 'LF' })
              : null,
            state.phase === 'ready' && state.bom
              ? jsx('span', { className: 'sshwsp-editor-meta', children: 'BOM' })
              : null,
            jsx('span', { className: 'sshwsp-editor-spacer' }),
            jsx('button', {
              type: 'button',
              className: 'sshwsp-btn sshwsp-editor-wrap',
              'aria-pressed': wrap ? 'true' : 'false',
              onClick: toggleWrap,
              children: t('edit.tabHint'),
            }),
            jsx('button', {
              type: 'button',
              className: 'sshwsp-btn',
              disabled: saving || state.phase !== 'ready',
              onClick: close,
              children: t('edit.cancel'),
            }),
            jsx('button', {
              type: 'button',
              className: 'sshwsp-btn sshwsp-btn-primary',
              title: t('edit.saveHint'),
              disabled: saving || state.phase !== 'ready' || state.truncated,
              onClick: () => { void save() },
              children: saving ? t('edit.saving') : t('edit.save'),
            }),
          ]}),
        ],
      }))
    }

    /** The last path segment, for the dialog's title. */
    function baseNameOf (target) {
      const cut = String(target ?? '').replace(/[/\\]+$/u, '')
      const at = Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('\\'))
      return at < 0 ? cut : cut.slice(at + 1)
    }

    /** The edit mark: a pencil on the same 16-unit grid the other glyphs use. */
    function EditIcon ({ size = 16, ...rest }) {
      return jsxs('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        ...rest,
        children: [
          jsx('path', { d: 'M11.5 2.5l2 2L5 13l-2.5.5L3 11z' }),
          jsx('path', { d: 'M10 4l2 2' }),
        ],
      })
    }

    exports.FileEditAction = FileEditAction
    exports.FileEditorPanel = FileEditorPanel
    exports.EditIcon = EditIcon
    // The box the panel covers, the coordinate conversion it needs, and the pure
    // helpers it is built from — exported so a suite can drive them without a
    // browser.
    exports.paneBoxOf = paneBoxOf
    exports.useSelfCorrectingOffset = useSelfCorrectingOffset
    exports.lineCount = lineCount
    exports.gutterNumbers = gutterNumbers
    exports.gutterWidth = gutterWidth
    exports.isDirty = isDirty
    exports.movedTokenOnly = movedTokenOnly
    exports.refusalKey = refusalKey
    exports.expectedTokens = expectedTokens
    return module.exports
  },
})
