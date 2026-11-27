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
      ChevronIcon,
      CloseIcon,
      formatBytes,
      modalLayer,
      requestJson,
    } = require('@shiqyka/dsh-ssh-workspace')

    /**
     * The rich editor engine, as one lazily fetched chunk.
     *
     * CodeMirror 6 is roughly 750 KiB of parser tables and view code — an order
     * of magnitude more than the rest of this chunk — and it is needed only
     * when a file is actually opened for editing. `require.async` exists for
     * exactly this: the Host resolves it to a sibling chunk, so the engine
     * arrives on first use and never on boot.
     *
     * Failure is tolerated on purpose. A package assembled without the
     * generated file, a Host that refuses the chunk, or a bundle that throws
     * while initializing all leave the textarea editor in place: the editor is
     * the feature, the engine is an upgrade to it. That is also why the load is
     * memoised — a failed attempt must cost one request, not one per render.
     */
    let engineModulePromise = null
    function loadEditorEngine () {
      if (engineModulePromise === null) {
        engineModulePromise = Promise.resolve()
          .then(() => require.async('./client.editor-engine.js'))
          .then(engine => (typeof engine?.createEditorEngine === 'function' ? engine : null))
          .catch(() => null)
      }
      return engineModulePromise
    }

    /**
     * Bodies a probe already paid for, waiting for the click that opens them.
     *
     * The probe cannot draw the pencil until it has read the head, and for a
     * small file that head is the whole file the editor will ask for next. The
     * server sends that body with the probe answer; holding it here turns
     * preview→edit from two read round trips into one. Keyed per session AND
     * path, because the same path can be a different file in another session's
     * world, and capped because a body is real memory.
     */
    const preloadedBodies = new Map()
    const PRELOAD_CACHE_MAX = 8
    function preloadKeyOf (sessionId, path) {
      return `${sessionId}\u0000${path}`
    }
    function stashPreload (sessionId, path, preload) {
      if (typeof preload?.text !== 'string') return
      const key = preloadKeyOf(sessionId, path)
      preloadedBodies.delete(key)
      preloadedBodies.set(key, preload)
      if (preloadedBodies.size > PRELOAD_CACHE_MAX) {
        const oldest = preloadedBodies.keys().next()
        if (oldest.done !== true) preloadedBodies.delete(oldest.value)
      }
    }
    function takePreload (sessionId, path) {
      const key = preloadKeyOf(sessionId, path)
      const preload = preloadedBodies.get(key)
      if (preload === undefined) return null
      preloadedBodies.delete(key)
      return preload
    }

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

    /**
     * Python's four spaces.
     *
     * Indentation is syntax in Python, and PEP 8 — with every formatter and
     * linter a reader is likely to run — says four. Editing a `.py` file with
     * the two-space default produces a file that is valid Python but wrong by
     * the conventions of the ecosystem it lives in, and the editor should not
     * be the thing that writes that.
     */
    const PYTHON_INDENT = '    '

    /** The indent unit for one file: four spaces for Python, two otherwise. */
    function indentFor (path) {
      return /\.pyw?$/iu.test(String(path ?? '')) ? PYTHON_INDENT : INDENT
    }

    /**
     * One line's height in pixels, matching `.sshwsp-editor-area`.
     *
     * The find bar scrolls to a match with arithmetic when wrapping is off, and
     * arithmetic needs this number. It is asserted against the stylesheet in
     * `tests/file-editor-smoke.mjs`, because a line-height that drifts here
     * would scroll to the wrong place with nothing to notice.
     */
    const EDITOR_LINE_HEIGHT = 18

    /**
     * How many matches are collected before the counter says "at least this
     * many".
     *
     * Searching a 2 MiB file for `e` finds a hundred thousand occurrences, and
     * holding all of them to draw one number is worse than the number is worth.
     */
    const FIND_MATCH_CAP = 1000

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
     * `lineCount` for a value that survives re-renders.
     *
     * The editor re-renders on every keystroke, and counting a 2 MiB / 60k-line
     * buffer char by char cost ~3 ms each time even when CodeMirror was the
     * visible editor and nothing consumed the number. A single-value cache is
     * enough because React re-renders hand back the SAME string object for an
     * unchanged buffer, so the identity check is constant time.
     */
    let lastLineCount = { text: null, count: 1 }
    function lineCountCached (text) {
      if (lastLineCount.text === text) return lastLineCount.count
      lastLineCount = { text, count: lineCount(text) }
      return lastLineCount.count
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
     * Which 0-based line a character offset sits on.
     *
     * Only the wrapped-off case needs it: with wrapping, a line number is not a
     * pixel position, so the find bar asks the browser to scroll instead.
     */
    function lineIndexOf (text, index) {
      const source = typeof text === 'string' ? text : ''
      const stop = Number.isInteger(index) && index > 0 ? Math.min(index, source.length) : 0
      let line = 0
      for (let at = 0; at < stop; at += 1) {
        if (source.charCodeAt(at) === 10) line += 1
      }
      return line
    }

    /**
     * Where each occurrence of `query` starts and ends.
     *
     * Scanned, not compiled: the query is a literal, and building a pattern
     * from it would make a `.` or a `(` in a search mean something the user did
     * not type. Case folding is `toLowerCase` on both sides, the same
     * comparison the file list already sorts with.
     *
     * `capped` means the list stopped at {@link FIND_MATCH_CAP}, so the caller
     * shows "at least this many" rather than a number that is not the truth.
     */
    function findMatches (text, query, options) {
      const source = typeof text === 'string' ? text : ''
      const needle = typeof query === 'string' ? query : ''
      if (needle === '' || source === '') return { matches: [], capped: false }
      const caseSensitive = options?.caseSensitive === true
      const haystack = caseSensitive ? source : source.toLowerCase()
      const want = caseSensitive ? needle : needle.toLowerCase()
      const matches = []
      let at = haystack.indexOf(want)
      while (at >= 0) {
        matches.push({ start: at, end: at + needle.length })
        if (matches.length >= FIND_MATCH_CAP) return { matches, capped: true }
        at = haystack.indexOf(want, at + want.length)
      }
      return { matches, capped: false }
    }

    /**
     * The scroll position that puts a line about a third of the way down.
     *
     * Its own function because it is the only part of "reveal the match" that
     * can be checked without a browser: the arithmetic either agrees with the
     * stylesheet's line height or it scrolls to the wrong line.
     */
    function revealScrollTop (line, viewportHeight) {
      const index = Number.isInteger(line) && line > 0 ? line : 0
      const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0
      return Math.max(0, index * EDITOR_LINE_HEIGHT - Math.floor(height / 3))
    }

    /**
     * The index Enter or Shift+Enter lands on, wrapping at both ends.
     *
     * Wrapping is what makes the key usable: at the last match, the next one is
     * the first. `-1` means "nothing chosen yet", which is the state after a
     * query change that found nothing to select.
     */
    function stepMatchIndex (count, index, direction) {
      const total = Number.isInteger(count) && count > 0 ? count : 0
      if (total === 0) return -1
      const step = direction === 1 ? 1 : -1
      const from = Number.isInteger(index) && index >= 0 && index < total ? index : -1
      if (from < 0) return step === 1 ? 0 : total - 1
      return ((from + step) % total + total) % total
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
      if (reason === 'unrecognised-mode') return 'edit.unrecognisedMode'
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
      const [probe, setProbe] = React.useState({ phase: 'idle', reason: null, message: '', paged: false, size: 0, sessionId: '' })
      const [editing, setEditing] = React.useState(false)
      // A file past the editing cap opens the pager instead of the editor, and
      // the choice is made ONCE from the probe rather than re-decided inside the
      // panel: a panel that re-checked would have to handle "became editable
      // while open", which cannot happen — a file does not shrink on its own.
      const [paged, setPaged] = React.useState(false)
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
        setProbe({ phase: 'probing', reason: null, message: '', paged: false, size: 0, sessionId })
        const query = new URLSearchParams({ sessionId, path: absolutePath, probe: '1' })
        requestJson(`${API.readText}?${query.toString()}`, { signal: controller.signal }).then(
          (reply) => {
            if (controller.signal.aborted) return
            if (reply.ok && reply.data?.editable === true) {
              stashPreload(sessionId, absolutePath, reply.data?.preload)
              setProbe({ phase: 'ready', reason: null, message: '', paged: false, size: reply.data?.size ?? 0, sessionId })
              return
            }
            // A refusal the server made explicit, or a transport failure. Both
            // keep the button visible and disabled, with the reason in its
            // tooltip — the user needs to know WHICH of the two it was.
            setProbe({
              phase: 'refused',
              reason: typeof reply.data?.reason === 'string' ? reply.data.reason : null,
              message: typeof reply.data?.error === 'string' ? reply.data.error : '',
              // `paged` is the server saying "too big to edit, still readable".
              // It is the only refusal that unlocks the button.
              paged: reply.data?.paged === true,
              size: reply.data?.size ?? 0,
              sessionId,
            })
          },
          (error) => {
            if (controller.signal.aborted) return
            setProbe({ phase: 'refused', reason: null, message: error instanceof Error ? error.message : String(error), paged: false, size: 0, sessionId })
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
      const pageable = probe.phase === 'refused' && probe.paged === true
      const openable = ready || pageable
      const label = ready
        ? t('edit.actionHint')
        : pageable
          ? t('edit.pageHint', { size: formatBytes(probe.size) })
          : (refusal === undefined ? t('edit.failed') : t(refusal, { size: formatBytes(probe.size ?? 0) }))
      const title = openable ? label : `${label}${probe.message === '' ? '' : ` — ${probe.message}`}`
      // A file that cannot be edited keeps its button but says so: a red dot in
      // the corner, and the reason in the tooltip. The button is NOT `disabled`.
      // A disabled control does not hover its own title in every browser and
      // cannot take focus, which is exactly how the refusal was invisible: the
      // only way to learn why the pencil did nothing was to guess. `aria-disabled`
      // keeps the meaning for assistive tech while the pointer and keyboard paths
      // stay alive.
      const blocked = !ready

      return jsx(React.Fragment, { children: [
        jsx('button', {
          ref: buttonRef,
          type: 'button',
          className: 'sshwsp-fileaction sshwsp-fileaction-edit' + (blocked ? ' sshwsp-fileaction-blocked' : ''),
          title,
          'aria-label': title,
          'aria-disabled': openable ? undefined : 'true',
          onClick: () => {
            if (!openable) return
            setPaged(pageable)
            setEditing(true)
          },
          children: [
            jsx(EditIcon, { key: 'icon', size: 16 }),
            blocked
              ? jsx('span', { key: 'blocked', className: 'sshwsp-fileaction-dot', 'aria-hidden': 'true' })
              : null,
          ],
        }),
        editing && openable && rect !== null
          ? jsx(React.Suspense, {
            fallback: null,
            children: paged
              ? jsx(FilePagerPanel, {
                path: absolutePath,
                sessionId,
                t,
                rect,
                onClose: () => setEditing(false),
              })
              : jsx(FileEditorPanel, {
                path: absolutePath,
                sessionId,
                t,
                rect,
                onClose: () => setEditing(false),
                // Saving no longer closes the panel: the file now has a tab, and
                // a tab that closes itself on save cannot be saved twice.
                onSaved: () => undefined,
              }),
          })
          : null,
      ]})
    }

    // =========================================================================
    // Syntax highlighting
    // =========================================================================
    //
    // A colour LAYER under the textarea, not a new editor. The textarea keeps
    // every gesture a person expects (selection, undo, IME, word movement), and
    // the layer paints the same text again with token spans — so the decision
    // recorded on `FileEditorPanel` below ("do not reimplement the editor")
    // still holds. What the layer demands instead is exact METRICS: same font,
    // same size, same line height, same `tab-size`, same padding origin, or the
    // coloured glyphs ghost against the transparent ones. The two stylesheet
    // rules are therefore cross-checked by the suite rather than trusted.
    //
    // The layer is WINDOWED. A 2 MiB buffer is ~60k lines, and painting — or
    // retokenizing — all of them on every keystroke would cost more than the
    // colours are worth. Only the lines around the viewport are drawn, each at
    // `index * EDITOR_LINE_HEIGHT`, and the whole block is translated by the
    // textarea's own scroll offset. That keeps one scroll port: the textarea.
    //
    // Extending it is a data edit. A C-like syntax is one entry in `LANGUAGES`
    // (extensions, keywords, comment markers, quotes); a syntax that is not
    // C-like adds a `markdown: true` or `markup: true` flag and its own line
    // scanner. The tokenizer is pure and knows nothing about React, so a future
    // editor engine can reuse it unchanged or drop it with the layer.

    /**
     * How much text the layer colours before giving up.
     *
     * 512 KiB is roughly 13k lines. Past it the colours stop and the plain
     * textarea comes back: the alternative is a per-keystroke cost linear in
     * file size, which is exactly what an editor must not have.
     */
    const HIGHLIGHT_MAX_CHARS = 512 * 1024

    /** Lines painted beyond the viewport on each side, so a wheel gesture or a
     *  programmatic jump does not outrun the paint and flash an empty band. */
    const HIGHLIGHT_OVERSCAN = 12

    /** A space-separated word list as a lookup set, blank entries dropped. */
    function words (text) {
      return new Set(text.trim().split(/\s+/u).filter(word => word !== ''))
    }

    const JS_KEYWORDS = words(`
      as async await break case catch class const continue debugger default delete do else enum export extends
      finally for from function get if implements import in instanceof interface let new of return set static
      switch throw try typeof var void while with yield
    `)
    const JS_LITERALS = words('true false null undefined NaN Infinity this super')

    /**
     * Every syntax the editor knows, as data.
     *
     * `line` / `block` / `quotes` / `backtick` say HOW to scan; `keywords` /
     * `literals` / `types` say WHAT a word means; `caseInsensitive` and
     * `capitalTypes` are the two dialect switches that cannot be expressed as a
     * word list. The order is irrelevant — lookups go through the maps below.
     */
    const LANGUAGES = [
      {
        id: 'javascript',
        exts: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'],
        keywords: JS_KEYWORDS,
        literals: JS_LITERALS,
        line: ['//'],
        block: ['/*', '*/'],
        quotes: ['"', "'"],
        backtick: true,
        capitalTypes: true,
        regex: true,
      },
      {
        id: 'json',
        exts: ['json', 'jsonc', 'json5', 'webmanifest'],
        keywords: new Set(),
        literals: words('true false null'),
        line: ['//'],
        block: ['/*', '*/'],
        quotes: ['"'],
        keyish: true,
      },
      {
        id: 'css',
        exts: ['css', 'scss', 'less'],
        keywords: new Set(),
        literals: new Set(),
        line: [],
        block: ['/*', '*/'],
        quotes: ['"', "'"],
        keyish: true,
        atRules: true,
      },
      {
        id: 'markup',
        exts: ['html', 'htm', 'xhtml', 'xml', 'svg', 'vue', 'svelte', 'astro'],
        markup: true,
      },
      {
        id: 'markdown',
        exts: ['md', 'markdown', 'mdown', 'mkd'],
        markdown: true,
      },
      {
        id: 'python',
        exts: ['py', 'pyw', 'pyi'],
        keywords: words(`
          and as assert async await break class continue def del elif else except finally for from global if import
          in is lambda nonlocal not or pass raise return try while with yield
        `),
        literals: words('True False None NotImplemented Ellipsis self cls'),
        line: ['#'],
        block: null,
        quotes: ['"', "'"],
        triples: ['"""', "'''"],
        capitalTypes: true,
      },
      {
        id: 'shell',
        exts: ['sh', 'bash', 'zsh', 'ksh', 'env'],
        keywords: words(`
          if then else elif fi for while until do done case esac function in local export readonly return exit set
          unset shift source alias
        `),
        literals: words('true false'),
        line: ['#'],
        block: null,
        quotes: ['"', "'"],
      },
      {
        id: 'yaml',
        exts: ['yml', 'yaml'],
        keywords: words('yes no on off null true false'),
        literals: new Set(),
        line: ['#'],
        block: null,
        quotes: ['"', "'"],
        keyish: true,
      },
      {
        id: 'sql',
        exts: ['sql'],
        keywords: words(`
          select from where group by order having insert into values update set delete create alter drop table index
          view join left right inner outer on as and or not null is in like between union all distinct case when then
          else end limit offset primary key foreign references default unique
        `),
        literals: words('true false null'),
        line: ['--'],
        block: ['/*', '*/'],
        quotes: ['"', "'"],
        caseInsensitive: true,
      },
      {
        id: 'go',
        exts: ['go'],
        keywords: words(`
          break case chan const continue default defer else fallthrough for func go goto if import interface map package
          range return select struct switch type var
        `),
        literals: words('true false nil iota'),
        line: ['//'],
        block: ['/*', '*/'],
        quotes: ['"', "'"],
        backtick: true,
        capitalTypes: true,
      },
      {
        id: 'rust',
        exts: ['rs'],
        keywords: words(`
          as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move
          mut pub ref return self Self static struct super trait true type unsafe use where while
        `),
        literals: words('true false None Some Ok Err'),
        line: ['//'],
        block: ['/*', '*/'],
        quotes: ['"', "'"],
        capitalTypes: true,
        lifetime: true,
      },
      {
        id: 'c-like',
        exts: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'java', 'kt', 'kts', 'cs', 'swift', 'm', 'mm', 'scala', 'dart'],
        keywords: words(`
          abstract as assert auto bool boolean break byte case catch char class const constexpr continue default delete
          do double else enum explicit export extends extern false final finally float for friend func function goto if
          implements import inline instanceof int interface internal let long namespace native new null nullptr object
          operator override package private protected public readonly register return sealed short signed sizeof static
          strictfp struct super switch synchronized template this throw throws transient true try typedef typename
          union unsigned using var virtual void volatile while yield async await fun val when
        `),
        literals: words('true false null nullptr NULL Nil nil'),
        line: ['//'],
        block: ['/*', '*/'],
        quotes: ['"', "'"],
        capitalTypes: true,
      },
      {
        id: 'toml',
        exts: ['toml', 'ini', 'cfg', 'conf', 'properties'],
        keywords: new Set(),
        literals: words('true false'),
        line: ['#', ';'],
        block: null,
        quotes: ['"', "'"],
        keyish: true,
      },
      {
        id: 'dockerfile',
        exts: ['dockerfile'],
        keywords: words(`
          from run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal
          healthcheck shell
        `),
        literals: new Set(),
        line: ['#'],
        block: null,
        quotes: ['"', "'"],
        caseInsensitive: true,
      },
      {
        id: 'make',
        exts: ['mk', 'mak'],
        keywords: words('ifeq ifneq ifdef ifndef else endif define endef include export unexport override'),
        literals: new Set(),
        line: ['#'],
        block: null,
        quotes: ['"', "'"],
      },
    ]

    /** Language by id, and extension by language. Built once, so a lookup in
     *  the render path is a Map hit and not a table walk. */
    const LANGUAGE_BY_ID = new Map(LANGUAGES.map(def => [def.id, def]))
    const EXTENSION_LANGUAGE = new Map()
    for (const def of LANGUAGES) {
      for (const ext of def.exts ?? []) EXTENSION_LANGUAGE.set(ext, def.id)
    }

    /**
     * Which syntax a file name claims, or null when nothing does.
     *
     * The name is matched case-insensitively and only by its LAST extension, so
     * `foo.test.js` is JavaScript and `component.d.ts` still lands in the
     * JavaScript family (TypeScript shares its scanner — a superset that colours
     * a few extra words is a better trade than one scanner per dialect). A
     * dotfile (`.gitignore`) has no extension and gets no colour — guessing from
     * "it starts with a dot" would claim every dotfile for one syntax.
     * `Dockerfile` and `Makefile` are the two names people actually type without
     * one.
     */
    function languageOfPath (target) {
      const name = baseNameOf(target).toLowerCase()
      if (name === '') return null
      if (name.startsWith('dockerfile') || name.endsWith('.dockerfile')) return 'dockerfile'
      if (name === 'makefile' || name === 'gnumakefile') return 'make'
      // `.env` and `.env.production` are shell syntax with no extension of their
      // own: the "extension" of `.env.local` is `local`, which would claim a
      // language nobody named.
      if (name === '.env' || name.startsWith('.env.')) return 'shell'
      const dot = name.lastIndexOf('.')
      if (dot <= 0) return null
      return EXTENSION_LANGUAGE.get(name.slice(dot + 1)) ?? null
    }

    /** The next character that is not a space or a tab, or '' at end of line. */
    function nextMeaningful (line, from) {
      for (let at = from; at < line.length; at += 1) {
        const char = line.charAt(at)
        if (char !== ' ' && char !== '\t') return char
      }
      return ''
    }

    /** Where a quoted string ends (index after the closing quote), or -1. */
    function endOfString (line, from, quote) {
      for (let at = from + 1; at < line.length; at += 1) {
        const char = line.charAt(at)
        if (char === '\\') { at += 1; continue }
        if (char === quote) return at + 1
      }
      return -1
    }

    /** Where a template string ends, scanning from `from`; -1 when it runs on. */
    function endOfTemplate (line, from) {
      for (let at = from; at < line.length; at += 1) {
        const char = line.charAt(at)
        if (char === '\\') { at += 1; continue }
        if (char === '`') return at + 1
      }
      return -1
    }

    const NUMBER_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)/u

    /** Where a number literal ends. A lone digit is still a number. */
    function endOfNumber (line, from) {
      const match = NUMBER_RE.exec(line.slice(from))
      return match === null ? from + 1 : from + match[0].length
    }

    /**
     * The last non-space character before `from`, the word it ends, and where
     * it sits.
     *
     * Both halves of the answer are needed by the regex-vs-division decision:
     * the character says where the slash sits (`= /re/`, `(/re/)`), the word
     * says whether the keyword before it expects an expression (`return /re/`).
     * The index is what lets the caller see a POSTFIX `++`/`--`, which ends a
     * value just as an identifier does.
     */
    function previousMeaningful (line, from) {
      let at = from - 1
      while (at >= 0 && (line.charAt(at) === ' ' || line.charAt(at) === '\t')) at -= 1
      if (at < 0) return { char: '', word: '', at: -1 }
      const char = line.charAt(at)
      let word = ''
      if (/[A-Za-z0-9_$]/u.test(char)) {
        let start = at
        while (start > 0 && /[A-Za-z0-9_$]/u.test(line.charAt(start - 1))) start -= 1
        word = line.slice(start, at + 1)
      }
      return { char, word, at }
    }

    /** Characters after which a `/` opens a regular expression, not a division. */
    const REGEX_PREFIX_CHARS = '([{,;:=!&|?+-*%<>~^'

    /** Keywords after which a `/` opens a regular expression. */
    const REGEX_PREFIX_WORDS = words('return typeof case in of new delete void throw else do yield await')

    /**
     * Where a `/regex/flags` literal ends (index after the flags), or -1.
     *
     * A character class may contain an unescaped `/` (`/[a/]/`), so the closing
     * slash is only looked for outside brackets. The newline is the hard stop:
     * a regex cannot span lines, so a line that never closes is not a regex at
     * all, and the caller falls back to treating the slash as punctuation.
     */
    function endOfRegex (line, from) {
      let inClass = false
      for (let at = from + 1; at < line.length; at += 1) {
        const char = line.charAt(at)
        if (char === '\\') { at += 1; continue }
        if (char === '[') { inClass = true; continue }
        if (char === ']') { inClass = false; continue }
        if (char !== '/' || inClass) continue
        let end = at + 1
        while (end < line.length && /[a-z]/iu.test(line.charAt(end))) end += 1
        return end
      }
      return -1
    }

    /**
     * What one word means, or undefined for "ordinary identifier".
     *
     * The order of the questions IS the precedence, and it matters: `get` in
     * `obj.get()` is a keyword in the JavaScript list, so keywords win over the
     * call rule; a capitalised name is a type only after every precise rule has
     * declined. `before` is the previous non-space character, which is how a
     * property (`obj.key`) and an at-rule (`@media`) are recognisable without a
     * second pass.
     */
    function classifyWord ({ word, before, line, end, def }) {
      const folded = def.caseInsensitive === true ? word.toLowerCase() : word
      if (def.keywords?.has(folded) === true) return 'keyword'
      if (def.literals?.has(folded) === true) return 'constant'
      if (def.types?.has(folded) === true) return 'type'
      if (def.atRules === true && before === '@') return 'keyword'
      if (before === '.') return 'prop'
      if (def.keyish === true && nextMeaningful(line, end) === ':') return 'prop'
      if (nextMeaningful(line, end) === '(') return 'fn'
      if (def.capitalTypes === true && /^[A-Z]/u.test(word)) return 'type'
      return undefined
    }

    /**
     * Scan one line of a C-like syntax.
     *
     * A line scanner with a carried STATE rather than a whole-file tokenizer:
     * block comments, template literals and Python's triple-quoted strings are
     * the only constructs that cross a line boundary, and they are exactly what
     * `state` remembers. Everything else resets at the newline, including an
     * unterminated single-line string — colouring the rest of the file as one
     * string because a quote was left open would be worse than not colouring
     * the last line.
     */
    function scanCodeLine (state, line, def) {
      const tokens = []
      const length = line.length
      const push = (start, end, type) => {
        if (end > start) tokens.push({ start, end, type })
      }
      const defClose = Array.isArray(def.block) ? def.block[1] : ''
      let blockClose = typeof state?.close === 'string' && state.close !== '' ? state.close : defClose
      let blockType = typeof state?.type === 'string' ? state.type : 'comment'
      let at = 0
      let mode = typeof state?.mode === 'string' ? state.mode : 'code'

      if (mode === 'block') {
        const close = blockClose === '' ? -1 : line.indexOf(blockClose)
        if (close < 0) {
          push(0, length, blockType)
          return { tokens, state: { mode: 'block', close: blockClose, type: blockType } }
        }
        push(0, close + blockClose.length, blockType)
        at = close + blockClose.length
        mode = 'code'
      }

      if (mode === 'template') {
        const end = endOfTemplate(line, at)
        if (end < 0) {
          push(at, length, 'string')
          return { tokens, state: { mode: 'template' } }
        }
        push(at, end, 'string')
        at = end
        mode = 'code'
      }

      while (at < length) {
        const char = line.charAt(at)
        if (char === ' ' || char === '\t') { at += 1; continue }

        let lineMark = ''
        for (const mark of def.line ?? []) {
          if (mark !== '' && line.startsWith(mark, at)) { lineMark = mark; break }
        }
        if (lineMark !== '') {
          push(at, length, 'comment')
          return { tokens, state: { mode: 'code' } }
        }

        const blockOpen = Array.isArray(def.block) ? def.block[0] : ''
        if (blockOpen !== '' && line.startsWith(blockOpen, at)) {
          const close = line.indexOf(blockClose, at + blockOpen.length)
          if (close < 0) {
            push(at, length, 'comment')
            return { tokens, state: { mode: 'block', close: blockClose, type: 'comment' } }
          }
          push(at, close + blockClose.length, 'comment')
          at = close + blockClose.length
          continue
        }

        // JavaScript's `/` is two operators in one character. A regex literal
        // is only possible where an expression may start (`= /re/`, `(/re/)`,
        // `return /re/`); after a value it is a division (`a / b`). Getting this
        // wrong is worse than not colouring at all: a quote inside `/ab"c/`
        // would otherwise open a string and paint the rest of the line as one.
        if (char === '/' && def.regex === true) {
          const previous = previousMeaningful(line, at)
          // `y++ / 2` is a division: the `+` ends a value just as an identifier
          // does, but the prefix list alone would call it an expression start.
          const postfix = (previous.char === '+' || previous.char === '-') &&
            line.charAt(previous.at - 1) === previous.char
          const opensExpression = !postfix && (previous.char === '' ||
            REGEX_PREFIX_CHARS.includes(previous.char) ||
            REGEX_PREFIX_WORDS.has(previous.word))
          const end = opensExpression ? endOfRegex(line, at) : -1
          if (end > 0) {
            push(at, end, 'string')
            at = end
            continue
          }
          at += 1
          continue
        }

        // Python's triple-quoted strings: checked BEFORE the single quote, or
        // `"""` would open a string and immediately close it on the next one.
        let triple = ''
        for (const mark of def.triples ?? []) {
          if (line.startsWith(mark, at)) { triple = mark; break }
        }
        if (triple !== '') {
          const close = line.indexOf(triple, at + triple.length)
          if (close < 0) {
            push(at, length, 'string')
            return { tokens, state: { mode: 'block', close: triple, type: 'string' } }
          }
          push(at, close + triple.length, 'string')
          at = close + triple.length
          continue
        }

        if (char === '`' && def.backtick === true) {
          const end = endOfTemplate(line, at + 1)
          if (end < 0) {
            push(at, length, 'string')
            return { tokens, state: { mode: 'template' } }
          }
          push(at, end, 'string')
          at = end
          continue
        }

        // `&'a str` is a lifetime, not a character literal. In Rust the two
        // share a quote, and the difference is the closing quote: `'a'` has
        // one, a lifetime name does not. Telling them apart here keeps every
        // borrow signature from painting the rest of the line as a string.
        if (char === "'" && def.lifetime === true) {
          let wordEnd = at + 2
          if (/[A-Za-z_]/u.test(line.charAt(at + 1))) {
            while (wordEnd < length && /[A-Za-z0-9_]/u.test(line.charAt(wordEnd))) wordEnd += 1
            if (line.charAt(wordEnd) !== "'") { at += 1; continue }
          }
        }

        if ((def.quotes ?? []).includes(char)) {
          const end = endOfString(line, at, char)
          const stop = end < 0 ? length : end
          // A quoted KEY (`"a": 1`) is a property, not a value. The test is the
          // same one `classifyWord` applies to bare identifiers, kept here
          // because a JSON key never reaches that path.
          const type = def.keyish === true && char === '"' && nextMeaningful(line, stop) === ':' ? 'prop' : 'string'
          push(at, stop, type)
          at = stop
          continue
        }

        if (char >= '0' && char <= '9') {
          const end = endOfNumber(line, at)
          push(at, end, 'number')
          at = end
          continue
        }

        if (/[A-Za-z_$]/u.test(char)) {
          let end = at + 1
          while (end < length && /[A-Za-z0-9_$]/u.test(line.charAt(end))) end += 1
          let before = ''
          for (let back = at - 1; back >= 0; back -= 1) {
            const previous = line.charAt(back)
            if (previous !== ' ' && previous !== '\t') { before = previous; break }
          }
          const word = line.slice(at, end)
          const type = classifyWord({ word, before, line, end, def })
          if (type !== undefined) push(at, end, type)
          at = end
          continue
        }

        at += 1
      }

      return { tokens, state: { mode: 'code' } }
    }

    /**
     * Scan one line of Markdown.
     *
     * Fenced code blocks are the only carried state; headings, list markers and
     * blockquotes are decided per line and end the line's scan early, because a
     * heading's text should not then be re-scanned for emphasis.
     */
    function scanMarkdownLine (state, line) {
      const tokens = []
      const push = (start, end, type) => {
        if (end > start) tokens.push({ start, end, type })
      }
      const fence = typeof state?.fence === 'string' ? state.fence : ''
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
      if (fence !== '') {
        const closes = fenceMatch !== null &&
          fenceMatch[1].charAt(0) === fence.charAt(0) &&
          fenceMatch[1].length >= fence.length
        if (closes) {
          push(fenceMatch.index, fenceMatch.index + fenceMatch[0].length, 'keyword')
          return { tokens, state: { fence: '' } }
        }
        push(0, line.length, 'string')
        return { tokens, state: { fence } }
      }
      if (fenceMatch !== null) {
        push(fenceMatch.index, fenceMatch.index + fenceMatch[0].length, 'keyword')
        return { tokens, state: { fence: fenceMatch[1] } }
      }

      const heading = /^ {0,3}(#{1,6})\s+/u.exec(line)
      if (heading !== null) {
        push(heading.index, heading[0].length, 'keyword')
        push(heading[0].length, line.length, 'strong')
        return { tokens, state: { fence: '' } }
      }

      let at = 0
      const marker = /^ {0,3}(?:[-*+]|\d{1,9}\.)\s+/u.exec(line)
      const quote = marker === null ? /^ {0,3}>\s?/u.exec(line) : null
      if (marker !== null) {
        push(marker.index, marker[0].length, 'keyword')
        at = marker[0].length
      } else if (quote !== null) {
        push(quote.index, quote[0].length, 'keyword')
        at = quote[0].length
      }

      while (at < line.length) {
        if (line.startsWith('<!--', at)) {
          const close = line.indexOf('-->', at + 4)
          const end = close < 0 ? line.length : close + 3
          push(at, end, 'comment')
          at = end
          continue
        }
        const char = line.charAt(at)
        if (char === '`') {
          const close = line.indexOf('`', at + 1)
          const end = close < 0 ? line.length : close + 1
          push(at, end, 'string')
          at = end
          continue
        }
        if (line.startsWith('**', at) || line.startsWith('__', at)) {
          const mark = line.slice(at, at + 2)
          const close = line.indexOf(mark, at + 2)
          const end = close < 0 ? at + 2 : close + 2
          push(at, end, 'strong')
          at = end
          continue
        }
        if (char === '*' || char === '_') {
          // `_` inside a word is an identifier (`snake_case`), not emphasis:
          // only a boundary underscore may open one.
          const boundary = at === 0 || /[\s([{]/u.test(line.charAt(at - 1))
          if (boundary && nextMeaningful(line, at + 1) !== '') {
            const close = line.indexOf(char, at + 1)
            const end = close <= at ? at + 1 : close + 1
            push(at, end, 'emphasis')
            at = end
            continue
          }
        }
        if (char === '[') {
          const label = line.indexOf('](', at + 1)
          if (label > 0) {
            const tail = line.indexOf(')', label + 2)
            const end = tail < 0 ? line.length : tail + 1
            push(at, end, 'link')
            at = end
            continue
          }
        }
        at += 1
      }
      return { tokens, state: { fence: '' } }
    }

    /**
     * Scan one line of HTML / XML.
     *
     * Tags, attribute names, quoted values and comments, and nothing else: a
     * text node is ordinary text, so no token is emitted for it. Script and
     * style bodies are left uncoloured rather than parsed — a markup scanner
     * that pretends to be a JavaScript and a CSS scanner is how the wrong
     * language ends up highlighted in the wrong colour.
     */
    function scanMarkupLine (state, line) {
      const tokens = []
      const push = (start, end, type) => {
        if (end > start) tokens.push({ start, end, type })
      }
      let at = 0
      let inComment = state?.comment === true
      while (at < line.length) {
        if (inComment) {
          const close = line.indexOf('-->', at)
          if (close < 0) {
            push(at, line.length, 'comment')
            return { tokens, state: { comment: true } }
          }
          push(at, close + 3, 'comment')
          at = close + 3
          inComment = false
          continue
        }
        const next = line.indexOf('<', at)
        if (next < 0) break
        at = next
        if (line.startsWith('<!--', at)) {
          const close = line.indexOf('-->', at + 4)
          if (close < 0) {
            push(at, line.length, 'comment')
            return { tokens, state: { comment: true } }
          }
          push(at, close + 3, 'comment')
          at = close + 3
          continue
        }
        if (line.startsWith('<!', at) || line.startsWith('<?', at)) {
          const close = line.indexOf('>', at)
          const end = close < 0 ? line.length : close + 1
          push(at, end, 'keyword')
          at = end
          continue
        }
        let cursor = at + 1
        if (line.charAt(cursor) === '/') cursor += 1
        const name = /^[A-Za-z][A-Za-z0-9:_-]*/u.exec(line.slice(cursor))
        if (name === null) { at += 1; continue }
        push(cursor, cursor + name[0].length, 'keyword')
        cursor += name[0].length
        while (cursor < line.length) {
          const char = line.charAt(cursor)
          if (char === '>') { cursor += 1; break }
          if (char === '/' || char === ' ' || char === '\t') { cursor += 1; continue }
          const attribute = /^[A-Za-z_:@][A-Za-z0-9:_.-]*/u.exec(line.slice(cursor))
          if (attribute === null) { cursor += 1; continue }
          push(cursor, cursor + attribute[0].length, 'prop')
          cursor += attribute[0].length
          const equals = /^\s*=\s*/u.exec(line.slice(cursor))
          if (equals !== null) {
            cursor += equals[0].length
            const opening = line.charAt(cursor)
            if (opening === '"' || opening === "'") {
              const close = endOfString(line, cursor, opening)
              const end = close < 0 ? line.length : close
              push(cursor, end, 'string')
              cursor = end
              continue
            }
            const bare = /^[^\s>]+/u.exec(line.slice(cursor))
            if (bare !== null) {
              push(cursor, cursor + bare[0].length, 'string')
              cursor += bare[0].length
            }
          }
        }
        at = Math.max(cursor, at + 1)
      }
      return { tokens, state: { comment: false } }
    }

    /** Scan one line in the named syntax. Unknown syntax colours nothing. */
    function highlightLine (language, state, line) {
      const def = LANGUAGE_BY_ID.get(language)
      if (def === undefined) return { tokens: [], state: null }
      if (def.markdown === true) return scanMarkdownLine(state, line)
      if (def.markup === true) return scanMarkupLine(state, line)
      return scanCodeLine(state, line, def)
    }

    /**
     * Index of the first line whose content differs, or -1 when identical.
     *
     * This is what lets the token cache survive a keystroke: the state carried
     * into that line is still valid, so only that line and its successors are
     * rescanned. Counting newlines on the BEFORE text is safe because the
     * difference starts at `at`, so every character before it — including every
     * newline — is shared by both texts.
     */
    function firstChangedLine (before, after) {
      if (before === after) return -1
      const limit = Math.min(before.length, after.length)
      let at = 0
      while (at < limit && before.charCodeAt(at) === after.charCodeAt(at)) at += 1
      let line = 0
      for (let index = 0; index < at; index += 1) {
        if (before.charCodeAt(index) === 10) line += 1
      }
      return line
    }

    /**
     * Which lines to draw for a given scroll offset.
     *
     * `last` is exclusive. The result is always inside `[0, total]`, so a
     * scrollTop past the end (a resize that shrank the pane, a file that lost
     * lines) cannot ask for rows that do not exist.
     */
    function visibleLineRange (scrollTop, viewportHeight, total, overscan) {
      const count = Number.isInteger(total) && total > 0 ? total : 0
      if (count === 0) return { first: 0, last: 0 }
      const top = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0
      const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0
      const pad = Number.isFinite(overscan) && overscan > 0 ? Math.floor(overscan) : 0
      const first = Math.min(count - 1, Math.max(0, Math.floor(top / EDITOR_LINE_HEIGHT) - pad))
      const visible = Math.ceil(height / EDITOR_LINE_HEIGHT) + 1
      const last = Math.min(count, first + visible + pad * 2)
      return { first, last }
    }

    /**
     * Whether the colour layer may draw at all.
     *
     * Every condition here is a case where a colour layer would be WRONG rather
     * than merely absent, and each has its own reason: an unknown syntax has
     * nothing to say; wrapping makes a line number stop being a pixel position,
     * so the windowed layer could not place its rows; an IME composition needs
     * the textarea's own glyphs back, because the composing text exists nowhere
     * else yet; and past the size cap the layer costs more than it buys.
     */
    function highlightEnabled (input) {
      if (input?.phase !== 'ready') return false
      if (input.wrap === true) return false
      if (input.composing === true) return false
      if (typeof input.language !== 'string' || input.language === '') return false
      const length = typeof input.length === 'number' ? input.length : Number(input.length)
      if (!Number.isFinite(length) || length > HIGHLIGHT_MAX_CHARS) return false
      return true
    }

    /**
     * The token cache: one carried state per line, plus the text it describes.
     *
     * States, not tokens, are what is retained — a state is a few bytes, while
     * tokens for a whole file are not. A line's tokens are produced on demand
     * for the window being painted and then thrown away.
     */
    function createHighlightCache () {
      return { language: '', def: null, text: null, lines: [], states: [{ mode: 'code' }] }
    }

    /**
     * Point a cache at a language and a text, keeping what is still valid.
     *
     * A language change throws everything away; a text change keeps the states
     * up to the first differing line, which is why typing near the caret costs
     * a scan of the window and not of the document.
     */
    function syncHighlightCache (cache, language, text) {
      const def = LANGUAGE_BY_ID.get(language) ?? null
      if (cache.language !== language) {
        cache.language = language
        cache.def = def
        cache.text = null
        cache.lines = []
        cache.states = [{ mode: 'code' }]
      }
      if (cache.text === text) return cache
      const lines = text.split('\n')
      if (cache.text !== null) {
        const resume = firstChangedLine(cache.text, text)
        if (resume >= 0) cache.states.length = Math.min(cache.states.length, resume + 1)
      }
      cache.text = text
      cache.lines = lines
      return cache
    }

    /**
     * The tokens for one line, extending the carried state as far as needed.
     *
     * The walk forward is the only unbounded part: asking for a line near the
     * end of a file that has never been scrolled through scans everything
     * above it once. After that the states are cached and a scroll back and
     * forth costs nothing.
     */
    function tokensAt (cache, index) {
      const { def, lines } = cache
      if (def === null || def === undefined) return []
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) return []
      while (cache.states.length <= index) {
        const lineIndex = cache.states.length - 1
        const step = highlightLine(cache.language, cache.states[lineIndex], lines[lineIndex])
        cache.states.push(step.state ?? { mode: 'code' })
      }
      return highlightLine(cache.language, cache.states[index], lines[index]).tokens
    }

    /**
     * A line's text split into plain and coloured parts.
     *
     * The plain parts are kept, not dropped: the layer must render the line
     * EXACTLY as the textarea does, so every character between two tokens has
     * to survive the split. `join` of the returned texts is the input line.
     */
    function tokenSpans (line, tokens) {
      const parts = []
      let at = 0
      for (const token of tokens) {
        const start = Math.max(at, Math.min(line.length, token.start))
        const end = Math.max(start, Math.min(line.length, token.end))
        if (start > at) parts.push({ text: line.slice(at, start), type: '' })
        if (end > start) parts.push({ text: line.slice(start, end), type: token.type })
        at = Math.max(at, end)
      }
      if (at < line.length) parts.push({ text: line.slice(at), type: '' })
      return parts
    }

    /**
     * The colour layer itself.
     *
     * It owns a scroll listener because the textarea's own `onScroll` already
     * has a job (driving the gutter) and folding a second, frame-coalesced
     * responsibility into it would make that handler the place where two
     * unrelated paints have to agree. The listener only reads: translate the
     * window (every scroll), and widen it when the viewport has escaped the
     * painted band (rare, roughly every overscan lines).
     */
    function HighlightLayer ({ text, language, areaRef }) {
      const cacheRef = React.useRef(null)
      if (cacheRef.current === null) cacheRef.current = createHighlightCache()
      const cache = syncHighlightCache(cacheRef.current, language, text)
      const shiftRef = React.useRef(null)
      const total = cache.lines.length > 0 ? cache.lines.length : 1
      const [range, setRange] = React.useState({ first: 0, last: 0 })
      const rangeRef = React.useRef(range)
      rangeRef.current = range

      const measure = React.useCallback(() => {
        const area = areaRef.current
        if (area === null || area === undefined) return
        const next = visibleLineRange(area.scrollTop, area.clientHeight, total, HIGHLIGHT_OVERSCAN)
        setRange(current => (
          current.first === next.first && current.last === next.last ? current : next
        ))
      }, [areaRef, total])

      const place = React.useCallback(() => {
        const area = areaRef.current
        const shift = shiftRef.current
        if (area === null || area === undefined || shift === null) return
        const top = rangeRef.current.first * EDITOR_LINE_HEIGHT - area.scrollTop
        shift.style.transform = `translate(${-area.scrollLeft}px, ${top}px)`
      }, [areaRef])

      // After EVERY render: the range may have moved (a new first line), the
      // box may have been remeasured, or the text may have grown. Both calls are
      // reads plus one style write, and the setState inside `measure` is a no-op
      // when the range did not change.
      React.useLayoutEffect(() => {
        measure()
        place()
      })

      React.useEffect(() => {
        const area = areaRef.current
        if (area === null || area === undefined || typeof area.addEventListener !== 'function') return undefined
        let frame = 0
        const onScroll = () => {
          if (frame !== 0) return
          if (typeof requestAnimationFrame !== 'function') { measure(); place(); return }
          frame = requestAnimationFrame(() => { frame = 0; measure(); place() })
        }
        area.addEventListener('scroll', onScroll, { passive: true })
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onScroll) : null
        observer?.observe?.(area)
        return () => {
          if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          area.removeEventListener('scroll', onScroll)
          observer?.disconnect?.()
        }
      }, [areaRef, measure, place])

      const first = Math.min(range.first, total - 1)
      const last = Math.max(first, Math.min(range.last, total))
      const rows = []
      for (let index = first; index < last; index += 1) {
        const line = cache.lines[index] ?? ''
        rows.push({ index, parts: tokenSpans(line, tokensAt(cache, index)) })
      }

      return jsx('div', {
        className: 'sshwsp-editor-hl',
        'aria-hidden': 'true',
        children: jsx('div', {
          className: 'sshwsp-editor-hl-shift',
          ref: shiftRef,
          children: rows.map(row => jsx('div', {
            key: row.index,
            className: 'sshwsp-editor-hl-line',
            children: row.parts.map((part, index) => (
              part.type === ''
                ? part.text
                : jsx('span', {
                  key: `${row.index}:${index}`,
                  className: `sshwsp-hl-${part.type}`,
                  children: part.text,
                })
            )),
          })),
        }),
      })
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
    /**
     * The open files of one session, kept outside any panel.
     *
     * A panel is mounted by the edit button of ONE preview and unmounts when it
     * closes, so a tab list living inside it would vanish with it and a file
     * opened from another preview could never join the set. The store is also
     * where each buffer's draft lives: switching tabs must not lose the unsaved
     * text of the tab being left, and closing the panel must not either — the
     * text outlives the element that held it.
     *
     * Deliberately not reactive machinery: a Map keyed by session and a Set of
     * listeners is all a tab strip needs, and it cannot re-render the plugin
     * from inside a keystroke.
     */
    function createTabStore () {
      const sessions = new Map()
      function entryOf (sessionId) {
        let entry = sessions.get(sessionId)
        if (entry === undefined) {
          entry = { paths: [], active: '', drafts: new Map(), listeners: new Set() }
          sessions.set(sessionId, entry)
        }
        return entry
      }
      function emit (entry) {
        for (const listener of [...entry.listeners]) listener()
      }
      return {
        list (sessionId) { return entryOf(sessionId).paths.slice() },
        active (sessionId) { return entryOf(sessionId).active },
        open (sessionId, path) {
          if (path === '') return
          const entry = entryOf(sessionId)
          const added = entry.paths.includes(path) !== true
          if (added) entry.paths.push(path)
          const moved = entry.active !== path
          if (moved) entry.active = path
          if (added || moved) emit(entry)
        },
        activate (sessionId, path) {
          const entry = entryOf(sessionId)
          if (entry.paths.includes(path) !== true || entry.active === path) return
          entry.active = path
          emit(entry)
        },
        /**
         * Remove one tab and return the path that should be in front.
         *
         * The neighbour that takes its place is the one on the right, or the
         * one on the left when the last tab is closed — the behaviour every
         * tabbed editor shares, so nobody has to learn this one.
         */
        close (sessionId, path) {
          const entry = entryOf(sessionId)
          const at = entry.paths.indexOf(path)
          if (at < 0) return entry.active
          entry.paths.splice(at, 1)
          entry.drafts.delete(path)
          if (entry.active === path) entry.active = entry.paths[Math.min(at, entry.paths.length - 1)] ?? ''
          emit(entry)
          return entry.active
        },
        draft (sessionId, path) { return entryOf(sessionId).drafts.get(path) ?? null },
        /**
         * Remember the dirty buffer of a tab, or forget it (`null`) once the
         * text is back in sync with the file.
         *
         * Forgetting matters as much as remembering: a clean buffer kept here
         * would win over the file on the next switch and show stale text as if
         * the change had been saved.
         */
        remember (sessionId, path, draft) {
          if (path === '') return
          const entry = entryOf(sessionId)
          const had = entry.drafts.has(path)
          if (draft === null) entry.drafts.delete(path)
          else entry.drafts.set(path, draft)
          if (had !== entry.drafts.has(path)) emit(entry)
        },
        subscribe (sessionId, listener) {
          const entry = entryOf(sessionId)
          entry.listeners.add(listener)
          return () => { entry.listeners.delete(listener) }
        },
      }
    }

    const openTabs = createTabStore()

    /**
     * The one panel a session may have on screen PER SURFACE.
     *
     * The edit button lives in EACH preview's header, and the panel covers only
     * that preview's body — so opening a file from a second preview would mount
     * a second panel at the same coordinates, stacking two editors and two tab
     * strips on top of each other. Within one surface the newer mount is the
     * right one; it asks the older one to close, and the tabs survive because
     * they live in the store rather than in either panel.
     *
     * The key carries a SECOND dimension now: the right-hand document preview
     * and the conversation file view are different surfaces occupying different
     * space at the same time. Collapsing them to one key made opening a file in
     * the conversation close the editor already on screen in the sidebar (or
     * vice versa), which reads as "my edit disappeared" even though the drafts
     * were safe. `surface` defaults to 'preview' so every existing call site —
     * and the tests that pin its shape — keep their meaning.
     */
    const panelOwners = new Map()

    function FileEditorPanel ({ path: requestedPath, sessionId, t, rect, onClose, onSaved, onDirtyChange, surface = 'preview', inline = false }) {
      // Which file this panel is showing. `requestedPath` is the file whose edit
      // button mounted the panel; from then on the tab strip decides, and the
      // panel itself never moves to a different preview.
      const [target, setTarget] = React.useState(requestedPath)
      const [tabPaths, setTabPaths] = React.useState(() => openTabs.list(sessionId))
      const [state, setState] = React.useState({
        phase: 'loading',
        // Which file this buffer came from. `target` changing does not change
        // `state` in the same render, so without this the state of the tab being
        // left would be mirrored into the tab being opened.
        path: '',
        text: '',
        baseText: '',
        baseVersion: '',
        baseRevision: '',
        eol: 'LF',
        // `auto` = keep the ending detected on disk. Anything else is the
        // ending the NEXT save will write, which is why it lives in state: a
        // constant `'auto'` in the save body made the badge decorative.
        eolPolicy: 'auto',
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
      // An IME composition needs the textarea's own glyphs back: the composing
      // text exists only there until the composition commits. Bound to the
      // events, not to `keydown`, because an input method is not a keyboard
      // gesture and some of them never send one.
      const [composing, setComposing] = React.useState(false)
      const [requestToken, setRequestToken] = React.useState(0)
      // `index: -1` means "the query changed and nothing is selected yet". The
      // first match is selected eagerly on every query change, so this only
      // survives a query that found nothing.
      const [find, setFind] = React.useState({ open: false, query: '', caseSensitive: false, index: -1 })
      const findRef = React.useRef(null)
      const textareaRef = React.useRef(null)
      const gutterRef = React.useRef(null)
      const panelRef = React.useRef(null)
      // The CodeMirror engine, when its chunk has arrived. `null` is not an
      // error state: it is the textarea editor, which is what the panel is
      // before the upgrade loads and after it fails.
      const [engineModule, setEngineModule] = React.useState(null)
      const cmHostRef = React.useRef(null)
      const viewRef = React.useRef(null)
      // The text the VIEW already holds. Comparing against `state.text` is what
      // lets a reload push a new buffer into the engine without echoing the
      // user's own keystrokes back into it.
      const cmTextRef = React.useRef('')
      // Handlers live in a ref because the engine is created once and would
      // otherwise capture the first render's callbacks — which close over the
      // first render's state.
      const handlersRef = React.useRef({})
      const stateRef = React.useRef(state)
      stateRef.current = state
      const wrapRef = React.useRef(wrap)
      wrapRef.current = wrap
      // Where the panel ACTUALLY landed versus where it was asked to be. The
      // panel is fixed-positioned but may be rebased by a transformed ancestor,
      // so the wanted coordinates are corrected from a real measurement instead
      // of from a guess about which element is the containing block.
      // An inline panel is laid out by its parent, so there is no measured box
      // to correct: `null` switches the hook off, and the hook itself is still
      // called every render (hooks order is not negotiable).
      const offset = useSelfCorrectingOffset(panelRef, inline ? null : rect)

      const eolDirty = state.phase === 'ready' && state.eolPolicy !== 'auto' && state.eolPolicy !== state.eol
      const dirty = state.phase === 'ready' && (isDirty(state.text, state.baseText) || eolDirty)
      const busy = saving
      const language = React.useMemo(() => languageOfPath(target), [target])
      // Resolved once per render, so the `<textarea>` and the layer can never
      // disagree about whether the layer is the one painting the glyphs.
      const highlighting = highlightEnabled({
        phase: state.phase,
        language,
        wrap,
        composing,
        length: state.text.length,
      })

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

      // The panel follows the strip from the outside (a tab closed in another
      // panel, a new file opened from a different preview) as well as from its
      // own clicks, so the list is read from the store rather than held here.
      React.useEffect(
        () => openTabs.subscribe(sessionId, () => setTabPaths(openTabs.list(sessionId))),
        [sessionId],
      )

      React.useEffect(() => {
        // One panel per (session, surface): two different surfaces may be on
        // screen at once, but a second mount into the SAME surface still wins.
        //
        // An inline panel is one file's TAB, and several of those coexist by
        // design (they are separate views, mounted one at a time). Keying them
        // by path keeps a tab switch from "taking over" — and therefore
        // closing — the file whose tab is being left.
        const ownerKey = `${sessionId}\u0000${surface}${inline ? `\u0000${requestedPath}` : ''}`
        const handle = { close: () => onClose?.() }
        const previous = panelOwners.get(ownerKey)
        panelOwners.set(ownerKey, handle)
        if (previous !== undefined && previous !== handle) previous.close()
        return () => {
          if (panelOwners.get(ownerKey) === handle) panelOwners.delete(ownerKey)
        }
      }, [sessionId, surface, onClose, inline, requestedPath])

      // A file opened while this panel is up: add it and bring it to the front.
      React.useEffect(() => {
        if (sessionId === '' || requestedPath === '') return
        openTabs.open(sessionId, requestedPath)
        setTabPaths(openTabs.list(sessionId))
        setTarget(requestedPath)
        setState(current => (current.path === requestedPath
          ? current
          : { ...current, phase: 'loading', path: requestedPath, error: '' }))
      }, [requestedPath, sessionId])

      /**
       * Write the current buffer into the store.
       *
       * Called on every state change (cheap: one Map entry, and only a dirty /
       * clean flip notifies anyone) and again before a tab switch, because a
       * click can arrive before React flushed the last keystroke.
       */
      const rememberActive = React.useCallback(() => {
        const current = stateRef.current
        if (current.phase !== 'ready' || current.path !== target || target === '') return
        // A pending line-ending conversion is unsaved work even when the text
        // is untouched; dropping it here would make the splitter silently
        // forget a choice the user made on this tab.
        const eolPending = current.eolPolicy !== 'auto' && current.eolPolicy !== current.eol
        if (current.text === current.baseText && !eolPending) {
          openTabs.remember(sessionId, target, null)
          return
        }
        openTabs.remember(sessionId, target, {
          text: current.text,
          baseText: current.baseText,
          baseVersion: current.baseVersion,
          baseRevision: current.baseRevision,
          eol: current.eol,
          eolPolicy: current.eolPolicy,
          bom: current.bom,
          truncated: current.truncated,
          size: current.size,
        })
      }, [sessionId, target])

      React.useEffect(() => {
        rememberActive()
      }, [state, rememberActive])

      /**
       * Which tabs are dirty.
       *
       * The active tab answers from `state` (it may be one keystroke ahead of
       * the store); every other tab answers from its draft. A draft only exists
       * while its text differs from the file, so "has a draft" is dirty, and no
       * buffer has to be compared on every render.
       */
      const dirtyPaths = React.useMemo(() => {
        const paths = new Set()
        for (const tabPath of tabPaths) {
          const dirtyHere = tabPath === target ? dirty : openTabs.draft(sessionId, tabPath) !== null
          if (dirtyHere) paths.add(tabPath)
        }
        return paths
      }, [tabPaths, target, dirty, sessionId])

      // The conversation host owns the tab's × and Esc; the panel lives in a
      // different surface, so it cannot see those gestures. Publishing THIS
      // FILE's unsaved state lets the host run the same guard the panel's own
      // close button uses instead of dropping typed text. It is per file, not
      // "any tab in the strip": tabs are separate views now, and a dirty
      // sidebar buffer must not make a conversation tab ask about nothing.
      // Optional and off for every existing (sidebar) call site.
      React.useEffect(() => {
        if (typeof onDirtyChange !== 'function') return undefined
        onDirtyChange(dirtyPaths.has(target))
        return () => onDirtyChange(false)
      }, [dirtyPaths, onDirtyChange, target])

      // A draft can live in a tab that is not the visible one, so "unsaved work"
      // is the strip's answer, not the active buffer's. Reading it from
      // `dirtyPaths` also means the guard appears the moment any tab goes dirty
      // and disappears the moment the last one is saved.
      React.useEffect(() => {
        if (dirtyPaths.size === 0) return undefined
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const guard = (event) => {
          event.preventDefault()
          event.returnValue = ''
          return ''
        }
        window.addEventListener('beforeunload', guard)
        return () => window.removeEventListener('beforeunload', guard)
      }, [dirtyPaths])

      const activateTab = React.useCallback((nextPath) => {
        if (nextPath === target) return
        // A save in flight is keyed to the tab it started in. Switching away
        // mid-request used to write the reply's baseline tokens into the newly
        // activated tab; refuse the switch for the duration instead (the tab
        // buttons are disabled too, so this is the keyboard/programmatic net).
        if (busy) return
        rememberActive()
        openTabs.activate(sessionId, nextPath)
        setTarget(nextPath)
        setState(current => ({ ...current, phase: 'loading', path: nextPath, error: '' }))
        setConflict(null)
        setConfirmOverwrite(false)
        setNotice('')
        setFind(current => ({ ...current, open: false, index: -1 }))
      }, [busy, rememberActive, sessionId, target])

      const closeTab = React.useCallback((closedPath) => {
        if (busy) return
        const isDirty = closedPath === target ? dirty : openTabs.draft(sessionId, closedPath) !== null
        if (isDirty && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (window.confirm(t('edit.unsavedPrompt')) !== true) return
        }
        // The draft of a closed tab is dropped by the store; remembering first
        // only matters for the ACTIVE tab, whose buffer may be newer than its
        // stored draft.
        if (closedPath === target) rememberActive()
        const nextPath = openTabs.close(sessionId, closedPath)
        // Closing the last tab closes the panel: a strip with no tabs has
        // nothing to show and no file to save.
        if (nextPath === '') {
          onClose?.()
          return
        }
        // Closing a tab BEHIND the visible one changes nothing on screen: the
        // active buffer must not be pushed back into loading, or it would sit
        // there forever (the load effect keys on the path, which did not move).
        if (closedPath !== target) return
        setTarget(nextPath)
        setState(current => ({ ...current, phase: 'loading', path: nextPath, error: '' }))
        setConflict(null)
        setConfirmOverwrite(false)
        setNotice('')
      }, [busy, dirty, onClose, rememberActive, sessionId, t, target])

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

      // Escape closes and Ctrl/Cmd+S saves, but ONLY while the focus is inside
      // the panel. A global listener would steal Escape from the composer and
      // from any dialog opened on top of this one; a listener on the panel
      // itself cannot.
      React.useEffect(() => {
        const node = panelRef.current
        if (node === null) return undefined
        // Focus lands in the text once it arrives, so the first Tab goes into
        // the text and not into the toolbar. The engine is created a render
        // later than the textarea would be, hence `engineModule` in the deps.
        const timer = setTimeout(() => {
          const engine = viewRef.current
          if (engine !== null) engine.focus()
          else textareaRef.current?.focus?.()
        }, 0)
        return () => clearTimeout(timer)
      }, [state.phase, engineModule])

      // One load path, driven by `requestToken` so "reload" and the conflict
      // strip's reload are the same code and cannot drift.
      React.useEffect(() => {
        if (target === '') return undefined
        // A tab switched away from with unsaved text comes back as it was:
        // re-reading the file here would silently replace the draft. Reload
        // (below) is the one path that clears the draft first.
        const draft = openTabs.draft(sessionId, target)
        if (draft !== null) {
          // A draft restores the text, its tokens and any pending ending
          // choice; only a draft from before that field existed falls back to
          // "keep what is on disk".
          setState({ phase: 'ready', path: target, ...draft, eolPolicy: draft.eolPolicy ?? 'auto' })
          return undefined
        }
        // The probe already read this file (it is small enough to travel with
        // its answer). Starting from that body skips the read the click would
        // otherwise pay for; the tokens travel with it, so a save still detects
        // a file that changed between the probe and the click.
        const preloaded = takePreload(sessionId, target)
        if (preloaded !== null) {
          setState({
            phase: 'ready',
            path: target,
            text: preloaded.text,
            baseText: preloaded.text,
            baseVersion: String(preloaded.version ?? ''),
            baseRevision: String(preloaded.revision ?? ''),
            eol: typeof preloaded.eol === 'string' ? preloaded.eol : 'LF',
            eolPolicy: 'auto',
            bom: preloaded.bom === true,
            truncated: false,
            size: Number(preloaded.size ?? 0),
            error: '',
          })
          return undefined
        }
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
              path: target,
              text,
              baseText: text,
              baseVersion: String(reply.data.version ?? ''),
              baseRevision: String(reply.data.revision ?? ''),
              eol: typeof reply.data.eol === 'string' ? reply.data.eol : 'LF',
              eolPolicy: 'auto',
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

      // Ask for the engine once the buffer is on screen. Doing this before the
      // read would fetch 750 KiB for a file the user then cancels; doing it in
      // the same tick as the read would delay the text behind the parser.
      React.useEffect(() => {
        if (state.phase !== 'ready' || engineModule !== null) return undefined
        let alive = true
        loadEditorEngine().then((engine) => {
          if (alive && engine !== null) setEngineModule(engine)
        })
        return () => { alive = false }
      }, [state.phase, engineModule])

      // Create the view once the host element exists. The host is rendered only
      // when `engineModule` is non-null, so this effect runs after that render
      // and never races the element it mounts into.
      React.useEffect(() => {
        const host = cmHostRef.current
        if (engineModule === null || host === null || state.phase !== 'ready') return undefined
        const engine = engineModule.createEditorEngine({
          parent: host,
          doc: stateRef.current.text,
          language: languageOfPath(target),
          path: target,
          wrap: wrapRef.current === true,
          onChange: (text) => {
            cmTextRef.current = text
            setNotice('')
            setState(current => (current.text === text ? current : { ...current, text }))
          },
          // Read through the ref: the engine outlives this render, and the
          // handlers close over state that changes on every keystroke.
          onSave: () => handlersRef.current.save?.(),
          onFind: () => handlersRef.current.openFind?.(),
          onEscape: () => handlersRef.current.escape?.(),
        })
        viewRef.current = engine
        cmTextRef.current = stateRef.current.text
        engine.focus()
        return () => {
          engine.destroy()
          viewRef.current = null
        }
      }, [engineModule, target, state.phase])

      // Push a buffer the VIEW did not produce (initial load, reload, conflict
      // reload) into it. Comparing against `cmTextRef` instead of the view's own
      // document keeps this from re-dispatching on every keystroke, which would
      // move the caret to the end of the file.
      React.useEffect(() => {
        const engine = viewRef.current
        if (engine === null || state.text === cmTextRef.current) return
        cmTextRef.current = state.text
        engine.setValue(state.text)
      }, [state.text])

      // Wrapping is a view preference, not a document change.
      React.useEffect(() => {
        viewRef.current?.setWrap?.(wrap === true)
      }, [wrap])

      // The gutter scrolls with the text, not independently: two scroll ports
      // would desynchronise the moment a wheel event landed on the wrong one.
      const syncScroll = React.useCallback(() => {
        const area = textareaRef.current
        const gutter = gutterRef.current
        if (area === null || gutter === null) return
        gutter.scrollTop = area.scrollTop
      }, [])

      // Recomputed from the text rather than cached across edits: a match list
      // that outlived the buffer it describes would select the wrong span after
      // the first keystroke.
      const found = React.useMemo(
        () => (state.phase === 'ready'
          ? findMatches(state.text, find.query, { caseSensitive: find.caseSensitive })
          : { matches: [], capped: false }),
        [state.phase, state.text, find.query, find.caseSensitive],
      )

      /**
       * Select one match and bring it into view.
       *
       * Selecting is the whole highlight: a textarea has no way to paint a
       * range, and the alternatives are an overlay that has to track the
       * textarea's own metrics pixel for pixel or a `contenteditable` that would
       * mean reimplementing selection, undo and IME.
       *
       * The scroll has two paths because only one of them can be arithmetic.
       * With wrapping off, a line number IS a vertical position. With wrapping
       * on it is not, so the browser is asked instead: focusing the area scrolls
       * the caret it was just given into view, and the focus goes back to the
       * query box so the next Enter still steps.
       */
      const revealMatch = React.useCallback((match) => {
        if (match === undefined) return
        const engine = viewRef.current
        if (engine !== null) {
          // CodeMirror owns the scroll: `scrollIntoView` centres the match, so
          // the same call works whether wrapping is on or off.
          engine.reveal(match.start, match.end)
          return
        }
        const area = textareaRef.current
        if (area === null) return
        area.setSelectionRange(match.start, match.end)
        if (wrap !== true) {
          const line = lineIndexOf(state.text, match.start)
          area.scrollTop = revealScrollTop(line, area.clientHeight)
          return
        }
        if (typeof area.focus === 'function') {
          area.focus()
          const scrolled = area.scrollTop
          findRef.current?.focus?.()
          area.scrollTop = scrolled
        }
      }, [state.text, wrap])

      // Reveal the first match of a query the moment it is typed, so the count
      // and the selection agree without the user pressing anything. Done from
      // the handler rather than an effect: an effect would also fire when the
      // TEXT changed, and re-selecting a match after every keystroke in the
      // textarea would move the caret out from under the typing.
      const revealFirstOf = React.useCallback((query, caseSensitive) => {
        const next = findMatches(state.text, query, { caseSensitive })
        const first = next.matches[0]
        if (first !== undefined) revealMatch(first)
        return first === undefined ? -1 : 0
      }, [state.text, revealMatch])

      const changeQuery = React.useCallback((value) => {
        setFind(current => ({
          ...current,
          query: value,
          index: revealFirstOf(value, current.caseSensitive),
        }))
      }, [revealFirstOf])

      const toggleFindCase = React.useCallback(() => {
        setFind(current => ({
          ...current,
          caseSensitive: current.caseSensitive !== true,
          index: revealFirstOf(current.query, current.caseSensitive !== true),
        }))
      }, [revealFirstOf])

      /**
       * Open the bar, seeded from the text selected in the file.
       *
       * Seeding is what makes Ctrl+F useful on the second press: selecting a
       * word and hitting the key again searches for that word instead of
       * whatever was in the box. A multi-line selection is not a query, so it is
       * ignored rather than truncated.
       */
      const openFind = React.useCallback(() => {
        const area = textareaRef.current
        const engine = viewRef.current
        const chosen = engine !== null
          ? engine.selectionText()
          : (area !== null && area.selectionEnd > area.selectionStart
            ? state.text.slice(area.selectionStart, area.selectionEnd)
            : '')
        const seed = chosen !== '' && !chosen.includes('\n') ? chosen : find.query
        setFind(current => ({
          ...current,
          open: true,
          query: seed,
          index: seed === '' || seed === find.query ? current.index : revealFirstOf(seed, current.caseSensitive),
        }))
      }, [state.text, find.query, revealFirstOf])

      const closeFind = React.useCallback(() => {
        // Collapse to the end of the match rather than leaving it selected: a
        // selection left behind means the next character typed REPLACES the
        // match, which is a data loss nobody asked for.
        const area = textareaRef.current
        const engine = viewRef.current
        if (engine !== null) engine.collapseSelection()
        else if (area !== null) area.setSelectionRange(area.selectionEnd, area.selectionEnd)
        setFind(current => ({ ...current, open: false, index: -1 }))
        if (engine !== null) engine.focus()
        else area?.focus?.()
      }, [])

      const stepFind = React.useCallback((direction) => {
        const index = stepMatchIndex(found.matches.length, find.index, direction)
        const match = found.matches[index]
        if (match !== undefined) revealMatch(match)
        setFind(current => ({ ...current, index }))
      }, [find.index, found.matches, revealMatch])

      // Focus the query box when the bar opens, and select what is in it so a
      // second Ctrl+F can be typed over.
      React.useEffect(() => {
        if (find.open !== true) return
        findRef.current?.focus?.()
        findRef.current?.select?.()
      }, [find.open])

      const onFindKeyDown = React.useCallback((event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeFind()
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          stepFind(event.shiftKey ? -1 : 1)
        }
      }, [closeFind, stepFind])

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
        // Pin the FILE this save belongs to. `target` is a render value and the
        // panel can move to another tab while the request is in flight; the
        // reply must never be written into whatever tab happens to be visible
        // by then (that produced a phantom dirty dot, a guaranteed 409 on the
        // next save, and a notice about the wrong file).
        const savingPath = target
        const sent = state.text
        setSaving(true)
        setNotice('')
        // Reads the live "which tab is on screen" answer after an await.
        const stillActive = () => stateRef.current.path === savingPath
        try {
          let tokens = expectedTokens({ version: state.baseVersion, revision: state.baseRevision })
          if (overwrite) {
            // Re-read: the conflict dialog only promises "your version wins",
            // not "skip the check". A second change between the 409 and this
            // click is refused like any other.
            const query = new URLSearchParams({ sessionId, path: target })
            const fresh = await requestJson(`${API.readText}?${query.toString()}`)
            if (!fresh.ok || fresh.data?.ok !== true) {
              if (stillActive()) setNotice(typeof fresh.data?.error === 'string' ? fresh.data.error : t('edit.failed'))
              return
            }
            tokens = expectedTokens({ version: String(fresh.data.version ?? ''), revision: String(fresh.data.revision ?? '') })
          }
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
                // Per save, from state: `auto` keeps what the file already
                // uses, LF/CRLF converts it. The badge writes this field.
                eol: state.eolPolicy === 'auto' ? 'auto' : state.eolPolicy,
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
            if (!stillActive()) return
            setConflict({
              version: String(reply.data?.current?.version ?? ''),
              revision: String(reply.data?.current?.revision ?? ''),
            })
            return
          }
          if (!reply.ok || reply.data?.ok !== true) {
            if (stillActive()) {
              setNotice(typeof reply.data?.error === 'string' ? reply.data.error : `${t('edit.saveFailed')} (HTTP ${reply.status})`)
            }
            return
          }
          // The file this save belongs to is no longer on screen (an external
          // navigation moved the panel). The write did land, so rebase that
          // tab's stored draft on the tokens the save produced: clearing it
          // would drop any text typed while the request was in flight, and
          // leaving the old baseline would guarantee a 409 on its next save.
          if (!stillActive()) {
            const draft = openTabs.draft(sessionId, savingPath)
            if (draft !== null && draft.text !== sent) {
              openTabs.remember(sessionId, savingPath, {
                ...draft,
                baseText: sent,
                baseVersion: String(reply.data.version ?? ''),
                baseRevision: String(reply.data.revision ?? ''),
                eol: typeof reply.data.eol === 'string' ? reply.data.eol : draft.eol,
                eolPolicy: 'auto',
              })
            } else {
              openTabs.remember(sessionId, savingPath, null)
            }
            onSaved?.(reply.data)
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
            // The server echoes the ending it actually wrote (after `auto`
            // resolution), so the badge stops lying after a conversion.
            eol: typeof reply.data.eol === 'string' ? reply.data.eol : current.eol,
            eolPolicy: 'auto',
          }))
          setNotice(t('edit.saved'))
          onSaved?.(reply.data)
        } catch (error) {
          if (stillActive()) {
            setNotice(`${t('edit.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`)
          }
        } finally {
          setSaving(false)
        }
      }, [state, saving, sessionId, target, t, onSaved])

      const reload = React.useCallback(() => {
        setConflict(null)
        setConfirmOverwrite(false)
        setNotice('')
        // Reload means "show me what is on disk": a draft would win over the
        // read and the button would appear to do nothing.
        openTabs.remember(sessionId, target, null)
        setRequestToken(value => value + 1)
      }, [sessionId, target])

      /**
       * The textarea's own keys: Tab, Shift+Tab, Ctrl/Cmd+F, Ctrl/Cmd+S, Escape.
       * Everything else is left to the browser on purpose.
       *
       * Escape is scoped to the panel rather than registered globally. The old
       * modal used `useDialogA11y`, whose listener sits on `document` in the
       * capture phase; that is right for a modal (it owns the screen) and wrong
       * for an inline editor, which must not swallow Escape while the composer
       * or a dialog opened on top of it has focus.
       *
       * Escape closes the find bar before it closes the panel: the bar is the
       * innermost thing open, and a user pressing Escape twice expects to lose
       * one layer per press, not the whole editor with unsaved text in it.
       */
      /**
       * The panel's Escape policy, shared by the textarea and the engine.
       *
       * The find bar is the innermost thing open, so it closes first: a user
       * pressing Escape twice expects one layer per press, not the whole editor
       * (with unsaved text) on the first.
       */
      const handleEscape = React.useCallback(() => {
        if (find.open === true) closeFind()
        else close()
      }, [find.open, closeFind, close])

      const onTextareaKeyDown = React.useCallback((event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          handleEscape()
          return
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'f' || event.key === 'F')) {
          // The browser's own find cannot see a textarea's buffer in a way this
          // panel can act on, and it would match the rest of the page instead.
          event.preventDefault()
          openFind()
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
        const indent = indentFor(target)
        if (event.shiftKey) {
          // Un-indent: take back at most one indent's worth of spaces from the
          // start of the current line. Anything more (a tab character, a line
          // with less whitespace) is left alone rather than half-removed.
          const value = area.value
          const caret = area.selectionStart
          const lineStart = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1
          let remove = 0
          while (remove < indent.length && value.charAt(lineStart + remove) === ' ') remove += 1
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
        const spliced = insertAtCaret(area, indent)
        setState(current => ({ ...current, text: spliced === undefined ? area.value : spliced }))
      }, [handleEscape, save, target])

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

      // The engine is created once and reads its handlers through this ref, so
      // it always calls the current render's save/find/escape closures instead
      // of the ones captured when the view was mounted.
      handlersRef.current = { save, openFind, closeFind, escape: handleEscape }

      const name = baseNameOf(target)
      // Inline, the panel IS the file's view: there is no preview behind it to
      // go back to, so the header names the full path (the tab already says the
      // base name, and two files may share one).
      const title = inline ? target : t('edit.title', { name })

      // The counter is stated as a position in the list, so it is derived from
      // the index the stepper holds rather than recounted from the selection.
      const findTotal = found.capped ? `${FIND_MATCH_CAP}+` : String(found.matches.length)
      const findLabel = find.query === ''
        ? ''
        : found.matches.length === 0
          ? t('edit.findNone')
          : t('edit.findCount', { current: (find.index < 0 ? 0 : find.index) + 1, total: findTotal })

      const findBar = find.open !== true || state.phase !== 'ready'
        ? null
        : jsxs('div', { className: 'sshwsp-editor-find', children: [
          jsx('input', {
            ref: findRef,
            className: 'sshwsp-editor-find-input',
            type: 'search',
            value: find.query,
            placeholder: t('edit.findHint'),
            'aria-label': t('edit.find'),
            onChange: (event) => changeQuery(event.target.value),
            onKeyDown: onFindKeyDown,
          }),
          jsx('span', {
            className: 'sshwsp-editor-find-count',
            'aria-live': 'polite',
            children: findLabel,
          }),
          jsx('button', {
            type: 'button',
            className: 'sshwsp-btn sshwsp-editor-find-case',
            'aria-pressed': find.caseSensitive ? 'true' : 'false',
            title: t('edit.findCase'),
            onClick: toggleFindCase,
            children: 'Aa',
          }),
          jsx('button', {
            type: 'button',
            className: 'sshwsp-icon-btn',
            title: t('edit.findPrev'),
            'aria-label': t('edit.findPrev'),
            onClick: () => stepFind(-1),
            // The drawn chevron, turned over, rather than a text arrow: a text
            // glyph beside this plugin's icons reads as a rendering failure.
            children: jsx(ChevronIcon, { style: { transform: 'rotate(180deg)' } }),
          }),
          jsx('button', {
            type: 'button',
            className: 'sshwsp-icon-btn',
            title: t('edit.findNext'),
            'aria-label': t('edit.findNext'),
            onClick: () => stepFind(1),
            children: jsx(ChevronIcon, {}),
          }),
          jsx('button', {
            type: 'button',
            className: 'sshwsp-icon-btn',
            title: t('edit.findClose'),
            'aria-label': t('edit.findClose'),
            onClick: closeFind,
            children: jsx(CloseIcon, {}),
          }),
        ]})

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
            // Two editors, one buffer. The engine (CodeMirror) is what a file
            // gets when its chunk has loaded; the textarea below is both the
            // pre-upgrade surface and the permanent fallback, which is why its
            // shape is still the one the suite pins.
            engineModule !== null
              ? jsx('div', { className: 'sshwsp-editor-cm', ref: cmHostRef })
              : [
                jsx('pre', {
                  className: 'sshwsp-editor-gutter',
                  ref: gutterRef,
                  'aria-hidden': 'true',
                  style: { width: `${gutterWidth(lineCountCached(state.text))}ch` },
                  children: gutterNumbers(lineCountCached(state.text)).join('\n'),
                }),
                // The textarea keeps its own box dimensions; the layer is
                // absolutely positioned inside this wrapper, which is nothing
                // but that box.
                jsxs('div', {
                  className: 'sshwsp-editor-area-box' + (highlighting ? ' sshwsp-editor-area-box-hl' : ''),
                  children: [
                    highlighting
                      ? jsx(HighlightLayer, { text: state.text, language, areaRef: textareaRef })
                      : null,
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
                      onCompositionStart: () => setComposing(true),
                      onCompositionEnd: () => setComposing(false),
                    }),
                  ],
                }),
              ],
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
      //
      // An INLINE panel (the conversation view) inverts all of that: it is the
      // tab's content, so it is not portalled and not measured — it is one flex
      // child of the view area and fills it. Rendering it as a fixed box over
      // the host's DOM was the "layer on top of the conversation" the first
      // draft looked like.
      const shell = jsxs('div', {
        ref: panelRef,
        className: 'sshwsp-editor-panel' + (inline ? ' sshwsp-editor-panel-inline' : ''),
        role: 'group',
        'aria-label': title,
        style: inline
          ? undefined
          : {
            // `offset` corrects for wherever `position: fixed` actually resolved,
            // so these are plain viewport pixels either way.
            left: `${rect.left + offset.x}px`,
            top: `${rect.top + offset.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          },
        children: [
          // The strip is the set of files this session has opened, not just the
          // one that mounted the panel: a second edit click joins the strip.
          // Inline, the HOST draws the strip (one tab per file), so a second
          // one here would be a copy.
          inline ? null : jsx('div', { className: 'sshwsp-editor-tabs', role: 'group', 'aria-label': t('edit.tabs'), children: tabPaths.map((tabPath) => jsxs('div', {
            className: 'sshwsp-editor-tab' + (tabPath === target ? ' sshwsp-editor-tab-active' : ''),
            children: [
              jsx('button', {
                type: 'button',
                // Deliberately NOT `role=tab`: a tablist promises APG keyboard
                // semantics (roving tabindex, arrows, aria-controls) that this
                // strip does not implement, and a half-implemented tablist is
                // worse for a keyboard user than an honest group of buttons.
                // `aria-current` carries the one fact that matters — which file
                // is on screen — without claiming the rest.
                'aria-current': tabPath === target ? 'true' : undefined,
                // A switch is refused while a save is in flight (the reply is
                // keyed to the tab it started in), so the control must say so
                // rather than silently ignoring the click.
                disabled: busy,
                className: 'sshwsp-editor-tab-name',
                // The full path is the title, because two files may share a base
                // name and the label alone cannot tell them apart.
                title: tabPath,
                onClick: () => activateTab(tabPath),
                children: baseNameOf(tabPath),
              }),
              dirtyPaths.has(tabPath)
                ? jsx('span', { className: 'sshwsp-editor-tab-dirty', 'aria-hidden': 'true' })
                : null,
              jsx('button', {
                type: 'button',
                className: 'sshwsp-editor-tab-close',
                disabled: busy,
                title: t('edit.tabClose'),
                'aria-label': t('edit.tabClose'),
                onClick: () => closeTab(tabPath),
                children: jsx(CloseIcon, { size: 12 }),
              }),
            ],
          })) }),
          // Inline, the host's tab IS the title: the file's name is on it and
          // its × (or Esc) closes the file, so a header repeating the path
          // would be the very "layer over the conversation" this mode exists
          // to remove. It still appears when it has something the tab cannot
          // carry — unsaved text, or the result of a save.
          !inline || dirty || notice !== ''
            ? jsxs('div', { className: 'sshwsp-editor-head', children: [
              inline ? null : jsx('span', { className: 'sshwsp-editor-title', children: title }),
              dirty ? jsx('span', { className: 'sshwsp-editor-dirty', children: t('edit.dirty') }) : null,
              notice !== ''
                ? jsx('span', {
                  className: 'sshwsp-editor-notice',
                  // Save results are otherwise invisible to a screen reader: the
                  // notice is plain text that appears beside the title.
                  role: 'status',
                  'aria-live': 'polite',
                  children: notice,
                })
                : null,
              inline
                ? null
                : jsx('button', {
                  type: 'button',
                  className: 'sshwsp-icon-btn',
                  title: t('edit.close'),
                  'aria-label': t('edit.close'),
                  onClick: close,
                  children: jsx(CloseIcon, {}),
                }),
            ]})
            : null,
          conflict !== null
            ? jsxs('div', {
              className: 'sshwsp-editor-conflict',
              role: 'alertdialog',
              // An alertdialog without an accessible name announces as
              // "dialog" and nothing else, which is exactly the moment the user
              // needs to hear what happened.
              'aria-labelledby': 'sshwsp-editor-conflict-title',
              children: [
                jsx('p', { id: 'sshwsp-editor-conflict-title', className: 'sshwsp-editor-conflict-title', children: t('edit.conflictTitle') }),
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
          findBar,
          body,
          jsxs('div', { className: 'sshwsp-editor-foot', children: [
            // Nothing is claimed while another tab's buffer is still on screen:
            // a stale line count reads as a file fact, not as "still loading".
            state.phase === 'ready'
              ? jsx('span', { className: 'sshwsp-editor-meta', children: t('edit.lines', { count: lineCountCached(state.text) }) })
              : null,
            // The line-ending badge is also the control: what is shown is the
            // file's current ending when the save policy is "auto", and the
            // chosen ending once the user picks one. Sending `eol` per save is
            // the server's documented contract (`auto` keeps what it detects),
            // so a CRLF conversion is one save away instead of an external tool.
            state.phase === 'ready'
              ? jsx('select', {
                className: 'sshwsp-editor-meta sshwsp-editor-eol',
                title: t('edit.eolHint'),
                'aria-label': t('edit.eolLabel'),
                value: state.eolPolicy,
                onChange: (event) => {
                  const eolPolicy = event.target.value === 'LF' || event.target.value === 'CRLF' ? event.target.value : 'auto'
                  setState(current => ({ ...current, eolPolicy }))
                },
                children: [
                  jsx('option', { value: 'auto', children: `${t('edit.eolAuto')} (${state.eol === 'CRLF' ? 'CRLF' : 'LF'})` }),
                  jsx('option', { value: 'LF', children: 'LF' }),
                  jsx('option', { value: 'CRLF', children: 'CRLF' }),
                ],
              })
              : null,
            state.phase === 'ready' && state.bom
              ? jsx('span', { className: 'sshwsp-editor-meta', children: 'BOM' })
              : null,
            jsx('span', { className: 'sshwsp-editor-spacer' }),
            jsx('button', {
              type: 'button',
              className: 'sshwsp-btn sshwsp-editor-wrap',
              'aria-pressed': wrap ? 'true' : 'false',
              title: t('edit.wrapHint'),
              onClick: toggleWrap,
              children: t('edit.wrap'),
            }),
            // "Cancel" means "leave the editor and go back to the preview".
            // There is no preview behind an inline panel — closing the file is
            // the × in its header — so the button would name a state that does
            // not exist.
            inline
              ? null
              : jsx('button', {
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
      })
      return inline ? shell : modalLayer(shell)
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

    /**
     * Bytes in one page of a paged preview.
     *
     * A copy of the server's `PAGE_BYTES`, not a shared import: the browser
     * bundle cannot import a route module, and the number is only used to draw
     * "page 2 of 5". Nothing breaks if they disagree — `nextOffset` is what
     * actually walks the file — but the counter would lie, so a suite pins the
     * two together.
     */
    const PAGE_BYTES = 128 * 1024

    /**
     * Which page of how many a byte offset falls on.
     *
     * Derived from the offset rather than counted in the component, so a jump,
     * a reload and a backwards step all agree about the number in the corner.
     */
    function pageOf (offset, size) {
      const pages = Math.max(1, Math.ceil(Math.max(0, size) / PAGE_BYTES))
      const page = Math.min(pages, Math.floor(Math.max(0, offset) / PAGE_BYTES) + 1)
      return { page, pages }
    }

    /**
     * A read-only window that pages through a file too large to open whole.
     *
     * Deliberately NOT the editor with `readOnly` set: the editor's contract is
     * "one buffer, two tokens, save writes it back", and a page has no whole
     * buffer, no revision and nothing to save. Sharing the component would mean
     * a `paged` flag threaded through every save path, which is how a read-only
     * mode grows a way to write. What IS shared is the shell: same box, same
     * head, same measured rect, so the pager lands exactly where the editor
     * would have and the two do not feel like different features.
     *
     * Pages are fetched by OFFSET, never re-sniffed: `encoding` and `eol` come
     * back from the first page and are echoed on every later request, because a
     * page taken from the middle of a GB18030 file can be valid UTF-8 and would
     * then decode differently from the page above it.
     */
    function FilePagerPanel ({ path: target, sessionId, t, rect, onClose }) {
      const [state, setState] = React.useState({
        phase: 'loading',
        text: '',
        offset: 0,
        nextOffset: 0,
        partial: false,
        size: 0,
        encoding: 'utf8',
        eol: 'LF',
        error: '',
      })
      // Offsets already visited, so "previous" is a byte offset the server has
      // not moved underneath us rather than a guess at `offset - PAGE_BYTES`.
      const [visited, setVisited] = React.useState([])
      const panelRef = React.useRef(null)
      const offset = useSelfCorrectingOffset(panelRef, rect)
      const abortRef = React.useRef(null)

      const load = React.useCallback((at, encoding, eol) => {
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        setState(previous => ({ ...previous, phase: previous.text === '' ? 'loading' : previous.phase, error: '' }))
        const query = new URLSearchParams({ sessionId, path: target, offset: String(at) })
        if (encoding !== undefined) query.set('encoding', encoding)
        if (eol !== undefined) query.set('eol', eol)
        requestJson(`${API.readText}?${query.toString()}`, { signal: controller.signal }).then(
          (reply) => {
            if (controller.signal.aborted) return
            if (reply.ok !== true || typeof reply.data?.text !== 'string') {
              setState(previous => ({ ...previous, phase: 'failed', error: typeof reply.data?.error === 'string' ? reply.data.error : '' }))
              return
            }
            setState({
              phase: 'ready',
              text: reply.data.text,
              offset: reply.data.offset,
              nextOffset: reply.data.nextOffset,
              partial: reply.data.partial === true,
              size: reply.data.size,
              encoding: reply.data.encoding,
              eol: reply.data.eol,
              error: '',
            })
          },
          (error) => {
            if (controller.signal.aborted) return
            setState(previous => ({ ...previous, phase: 'failed', error: error instanceof Error ? error.message : String(error) }))
          },
        )
        return () => controller.abort()
      }, [sessionId, target])

      React.useEffect(() => load(0), [load])
      React.useEffect(() => () => abortRef.current?.abort(), [])

      const atStart = visited.length === 0
      const atEnd = state.partial !== true
      const forward = React.useCallback(() => {
        if (atEnd) return
        setVisited(previous => [...previous, state.offset])
        load(state.nextOffset, state.encoding, state.eol)
      }, [atEnd, load, state.encoding, state.eol, state.nextOffset, state.offset])
      const backward = React.useCallback(() => {
        if (atStart) return
        const previous = visited[visited.length - 1]
        setVisited(rest => rest.slice(0, -1))
        load(previous, state.encoding, state.eol)
      }, [atStart, load, state.encoding, state.eol, visited])

      const counter = pageOf(state.offset, state.size)
      const title = `${baseNameOf(target)} · ${t('edit.pageTitle')}`
      const detail = state.phase === 'failed' ? state.error : ''

      let body
      if (state.phase === 'loading') {
        body = jsx('div', { className: 'sshwsp-editor-state', children: t('edit.loading') })
      } else if (state.phase === 'failed') {
        body = jsxs('div', { className: 'sshwsp-editor-state sshwsp-editor-state-error', children: [
          jsx('p', { children: t('edit.failed') }),
          jsx('p', { className: 'sshwsp-editor-detail', children: detail }),
          jsx('button', { type: 'button', className: 'sshwsp-btn', onClick: () => load(state.offset, state.encoding, state.eol), children: t('edit.reload') }),
        ]})
      } else {
        body = jsx('div', { className: 'sshwsp-editor-body', children: jsx('textarea', {
          className: 'sshwsp-editor-area sshwsp-editor-pager-area',
          value: state.text,
          // Read-only rather than disabled: the text stays selectable and
          // scrollable, which is the whole point of looking at it.
          readOnly: true,
          spellCheck: false,
          'aria-label': title,
          children: undefined,
        }) })
      }

      return modalLayer(jsxs('div', {
        ref: panelRef,
        className: 'sshwsp-editor-panel',
        role: 'group',
        'aria-label': title,
        style: {
          left: `${rect.left + offset.x}px`,
          top: `${rect.top + offset.y}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        },
        children: [
          jsxs('div', { className: 'sshwsp-editor-head', children: [
            jsx('span', { className: 'sshwsp-editor-title', children: title }),
            jsx('span', { className: 'sshwsp-editor-dirty', children: t('edit.pageReadOnly') }),
            jsx('button', {
              type: 'button',
              className: 'sshwsp-icon-btn',
              title: t('edit.close'),
              'aria-label': t('edit.close'),
              onClick: onClose,
              children: jsx(CloseIcon, {}),
            }),
          ]}),
          body,
          jsxs('div', { className: 'sshwsp-editor-actions', children: [
            jsx('button', {
              type: 'button',
              className: 'sshwsp-btn',
              disabled: atStart || state.phase !== 'ready',
              title: t('edit.pagePrev'),
              onClick: backward,
              children: t('edit.pagePrev'),
            }),
            jsx('span', {
              className: 'sshwsp-editor-pager-count',
              children: state.phase === 'ready'
                ? t('edit.pageCounter', { page: String(counter.page), pages: String(counter.pages) })
                : '',
            }),
            jsx('button', {
              type: 'button',
              className: 'sshwsp-btn',
              disabled: atEnd || state.phase !== 'ready',
              title: atEnd ? t('edit.pageEnd') : t('edit.pageNext'),
              onClick: forward,
              children: t('edit.pageNext'),
            }),
            jsx('button', {
              type: 'button',
              className: 'sshwsp-btn',
              onClick: onClose,
              children: t('edit.close'),
            }),
          ]}),
        ],
      }))
    }

    exports.FileEditAction = FileEditAction
    exports.FileEditorPanel = FileEditorPanel
    // The tab store is pure state with no DOM in it, so a suite can drive open /
    // activate / close / draft without mounting a panel.
    exports.createTabStore = createTabStore
    exports.FilePagerPanel = FilePagerPanel
    exports.pageOf = pageOf
    exports.PAGE_BYTES = PAGE_BYTES
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
    exports.findMatches = findMatches
    exports.stepMatchIndex = stepMatchIndex
    exports.lineIndexOf = lineIndexOf
    exports.revealScrollTop = revealScrollTop
    exports.EDITOR_LINE_HEIGHT = EDITOR_LINE_HEIGHT
    exports.FIND_MATCH_CAP = FIND_MATCH_CAP
    // The colour layer: the language table and the pure scanning / windowing
    // helpers behind it, exported so a suite can drive them without a browser.
    exports.LANGUAGES = LANGUAGES
    exports.HIGHLIGHT_MAX_CHARS = HIGHLIGHT_MAX_CHARS
    exports.HIGHLIGHT_OVERSCAN = HIGHLIGHT_OVERSCAN
    exports.languageOfPath = languageOfPath
    exports.highlightLine = highlightLine
    exports.tokenSpans = tokenSpans
    exports.firstChangedLine = firstChangedLine
    exports.visibleLineRange = visibleLineRange
    exports.highlightEnabled = highlightEnabled
    exports.createHighlightCache = createHighlightCache
    exports.syncHighlightCache = syncHighlightCache
    exports.tokensAt = tokensAt
    return module.exports
  },
})
