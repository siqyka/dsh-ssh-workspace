/**
 * The conversation's file view: one tab per opened file.
 *
 * This is the half of the feature that only exists once something is open — the
 * tab registry, the Session roster that keeps each conversation's tabs its own,
 * the composer hiding, the rendered-document pane and the editor pane. It used
 * to be sections 17-18 of `client.js`; the bundle keeps only the synchronous
 * seam (extensions, the click decision, the cached preferences) because a click
 * must be decided in the same tick the host navigates on.
 *
 * It is loaded in `apply`, not lazily: the first file click can arrive before a
 * gesture would have had time to fetch a chunk.
 *
 * It borrows the API table and `requestJson` from the bundle (both live at
 * `exports` evaluation time) and takes everything else — `slots`, `translate`,
 * the editor component — through the `host` argument, because `translate` is
 * rebound when the locale seat binds and the editor arrives with its own chunk.
 */

window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.fileview.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { API, requestJson } = require('@shiqyka/dsh-ssh-workspace')

    /**
     * Install the file view for one plugin instance.
     *
     * @param {object} host - the bundle's live handles.
     * @param {object} host.slots - the slot service.
     * @param {(key: string, params?: object) => string} host.translate - the bound translator.
     * @param {() => (Function | undefined)} host.editor - the editor component, once its chunk is there.
     * @returns {object} the controller the bundle forwards to.
     */
    function installFileView (host) {
      const slots = host.slots
    const { isPreviewablePath, isDocumentPath, previewNameOf, fileTabName, fileTabIdOf, viewerOf, aliasOfSession } = host
    /** The bundle's menu renderer: this chunk owns WHAT, the bundle owns HOW. */
    const showMenu = host.menu?.show ?? (() => {})

    /** Verdicts already known: `sessionId\0path` -> `'text'` | `'binary'`. */
    const sniffedKinds = new Map()

    /**
     * Ask the bytes what a file is, once.
     *
     * The suffix tables are a fast path; this is the rule. A `.cts`, a `.bat`
     * with no newline and an extensionless shell script all land here, get
     * 4 KiB read, and are classified by encoding and NUL bytes rather than by
     * their name. The verdict is cached because the answer cannot change while
     * the tab is open, and a probe on every click would make the second click
     * of the same file feel slower than the first.
     *
     * @param {string} path - the file.
     * @param {string} sessionId - the session it belongs to.
     * @returns {Promise<'text' | 'binary'>} the verdict; `'text'` on failure,
     *   because a failed probe is not evidence of binary content.
     */
    function probeFile (path, sessionId) {
      const key = `${sessionId}\u0000${path}`
      const known = sniffedKinds.get(key)
      if (known !== undefined) return Promise.resolve(known)
      const query = new URLSearchParams({ path, sniff: '1' })
      if (typeof sessionId === 'string' && sessionId !== '') query.set('sessionId', sessionId)
      return requestJson(`${API.readText}?${query.toString()}`)
        .then((body) => (body?.kind === 'binary' ? 'binary' : 'text'))
        .catch(() => 'text')
        .then((kind) => {
          sniffedKinds.set(key, kind)
          return kind
        })
    }

    /** A file the bytes proved binary: say so, and say where it can open. */
    function BinaryNote ({ path, t }) {
      return jsxs('div', { className: 'sshwsp-filepane-note', role: 'status', children: [
        jsx('span', { children: t('preview.binaryFile') }),
        jsx('code', { className: 'sshwsp-filepane-reason', children: previewNameOf(path) }),
        jsx('span', { children: t('preview.binaryHint') }),
      ] })
    }

    /** The alias a workspace-spelled path names, or ''. */
    function aliasOfPath (value) {
      const match = /^ssh:\/\/([^/]+)\//u.exec(String(value ?? ''))
      return match === null ? '' : match[1]
    }

    /**
     * The alias behind one file, from whichever side still knows it.
     *
     * A remote path carries its host, so it is the most specific answer. A
     * session that lives on a host answers next. '' means a LOCAL target, which
     * is served from disk under the session's workspace fence instead.
     */
    function aliasFor (path, sessionId) {
      const fromPath = aliasOfPath(path)
      if (fromPath !== '') return fromPath
      return typeof host.aliasOfSession === 'function' ? host.aliasOfSession(sessionId) : ''
    }

    /** A byte URL for either world: alias when known, session otherwise. */
    function byteUrlOf (base, path, sessionId, extra = {}) {
      const query = new URLSearchParams({ path, ...extra })
      const alias = aliasFor(path, sessionId)
      if (alias !== '') query.set('alias', alias)
      else if (typeof sessionId === 'string' && sessionId !== '') query.set('sessionId', sessionId)
      return `${base}?${query.toString()}`
    }

    /**
     * Resolve `./img.png` (or `../a/b.png`) against the document's directory.
     *
     * Remote paths are POSIX, so the split is a plain `/` walk with a stack —
     * `node:path` is not available here and its win32 form would be wrong.
     *
     * @param {string} documentPath - the file being rendered.
     * @param {string} value - the reference from the Markdown.
     * @returns {string} an absolute remote path, or '' when unusable.
     */
    function resolveRelativePath (documentPath, value) {
      const base = String(documentPath).replace(/[^/]*$/u, '')
      const parts = value.startsWith('/') ? [] : base.split('/').filter(segment => segment !== '')
      const suffix = value.startsWith('/') ? value : value
      for (const segment of suffix.split('/')) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') { parts.pop(); continue }
        parts.push(segment)
      }
      return `/${parts.join('/')}`
    }

    /**
     * Map one Markdown image reference to a byte URL on the plugin's route.
     *
     * A rendered document is read from a remote host, so an `<img src>` cannot
     * point at the source path — the browser has no such file. The plugin's
     * download route already streams remote bytes with backpressure and
     * cancellation, so the reference is resolved against the document and
     * routed through it. Absolute URLs, `data:`, and anything whose alias is
     * unknown stay as they are (or become no URL at all, which leaves the
     * host's own placeholder).
     *
     * @param {string} documentPath - the rendered file.
     * @param {string} sessionId - the reading session.
     * @returns {(value: unknown) => string|undefined} the resolver.
     */
    /**
     * How a file is shown.
     *
     * The table lives in the bundle rather than here: the click bridge (which
     * decides whether the plugin claims a file at all) has to answer
     * synchronously, before this chunk has arrived, so the bundle is the only
     * place both callers can read. `viewerOf` is injected through `host`.
     */

    function imageResolverFor (documentPath, sessionId) {
      return (value) => {
        const raw = String(value ?? '').trim()
        if (raw === '') return undefined
        if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) || raw.startsWith('//')) return raw
        const absolute = resolveRelativePath(documentPath, raw)
        if (absolute === '') return undefined
        const alias = aliasFor(absolute, sessionId)
        if (alias === '' && (typeof sessionId !== 'string' || sessionId === '')) return undefined
        return byteUrlOf(API.download, absolute, sessionId, { inline: '1' })
      }
    }
      const translate = (key, params) => host.translate(key, params)

      /**
       * The editor component, read live: `client.editor.js` arrives on first use,
       * long after this chunk installs, so a captured value would be undefined.
       */
      const Editor = (props) => {
        const Component = host.editor()
        return Component === undefined ? null : jsx(Component, props)
      }

    /**
     * What the browser really computed for the open document.
     *
     * "The styles are wrong" cannot be answered from source alone: a token that
     * never reached the pane, a stylesheet the page still holds from an older
     * bundle, and a rule losing on specificity all look identical in a
     * screenshot. This reports the resolved custom properties and the painted
     * values, so the next round is a measurement instead of a guess.
     *
     * @returns {object|null} the evidence, or null when nothing is mounted.
     */
    function styleEvidence () {
      if (typeof document === 'undefined') return null
      // The pane exists only while its tab is the ACTIVE view: the host renders
      // one view at a time. So the evidence is gathered from whatever is on
      // screen, and the element map says what that was — "null" from a chat view
      // must not be read as "the styles are missing".
      const selectors = ['.sshwsp-filepane', '[data-sshwsp-filepane]', '.sshwsp-md', '[data-sshwsp-md]']
      const found = Object.fromEntries(selectors.map(selector => [selector, document.querySelectorAll(selector).length]))
      const root = document.querySelector('.sshwsp-filepane') ??
        document.querySelector('[data-sshwsp-filepane]') ??
        document.querySelector('.sshwsp-md') ??
        document.querySelector('[data-sshwsp-md]')
      if (root === null || root === undefined) return { found, root: null }
      const computed = window.getComputedStyle(root)
      const read = (name) => computed.getPropertyValue(name).trim()
      const pre = root.querySelector('.sshwsp-md-pre')
      const cell = root.querySelector('.sshwsp-md-table td, .sshwsp-md-table th')
      const inlineCode = root.querySelector('.sshwsp-md-code-inline')
      return {
        found,
        root: { tag: root.tagName.toLowerCase(), className: String(root.className ?? '') },
        tokens: {
          text: read('--sshwsp-text'),
          border: read('--sshwsp-border'),
          surface2: read('--sshwsp-surface-2'),
        },
        painted: {
          color: computed.color,
          preBackground: pre === null ? null : window.getComputedStyle(pre).backgroundColor,
          preBorderRadius: pre === null ? null : window.getComputedStyle(pre).borderRadius,
          cellBorder: cell === null ? null : window.getComputedStyle(cell).borderBottomColor,
          inlineCodeBackground: inlineCode === null ? null : window.getComputedStyle(inlineCode).backgroundColor,
        },
        stylesheets: [...document.querySelectorAll('style[data-plugin-css]')]
          .map(tag => tag.dataset.pluginCss ?? ''),
        hasMarkdownCss: [...document.querySelectorAll('style[data-plugin-css]')]
          .some(tag => (tag.textContent ?? '').includes('.sshwsp-md-code-inline')),
      }
    }

    // =========================================================================
    // Preview in conversation (the file view tab)
    // =========================================================================
    // Where a file clicked in the host's file tree opens is a preference:
    // `sidebar` (the host's document preview, the pre-feature behaviour) or
    // `conversation` (this file view). The decision is made in the tree bridge
    // and has to be SYNCHRONOUS, because the click is prevented before the host's
    // React handler navigates. So the preference is cached in `fileViewPreferences`
    // at boot (and republished by the panel after every save) rather than
    // awaited inside the handler.
    //
    // The view is registered into `conversation.view`, i.e. it is one more tab in
    // the conversation's own tab strip — not a panel above the composer. That
    // registration is LAZY: the tab exists from the first opened file until the
    // last one closes, so a conversation that never opens a file keeps exactly
    // the tabs the host shipped. Registration happens at plugin scope, and a
    // host build without the seat returns no disposer, in which case the bridge
    // leaves the click to the host instead of swallowing it.
    //
    // State is per-session and deliberately not persisted: a reload closes every
    // preview, and no session event is written (the chat log is the host's).

    // The whitelist, the document rules and the tab name live in the bundle
    // (see the section "Preview in conversation" in client.js): the tree bridge
    // must answer a click SYNCHRONOUSLY, before this chunk has even loaded, so
    // the rules cannot live here. They arrive through `host`.

    /** The renderer chunk, fetched the first time a document is opened. */
    const markdownModule = () => require.async('./client.markdown.js')

    /**
     * How much of a document is rendered.
     *
     * The read route hands back up to 2 MiB. Parsing that on the main thread in
     * one go is a visible stall, and nobody reads the tail of a 400 KiB README
     * in a preview, so the body is cut with a note that says so. Nothing is lost
     * — the source mode still has the whole file.
     */
    const DOCUMENT_RENDER_LIMIT = 400 * 1024

    // The host renders Markdown through a component whose look comes from CSS
    // modules its own bundle imports (hashed class names). A plugin chunk cannot
    // import those, so borrowing the component produces UNSTYLED output — which
    // is exactly what it looked like in the conversation pane. The document is
    // therefore rendered by the plugin's own chunk, and the sheet in
    // `client.styles.js` copies the host's type ladder (14/24 body, 32/16
    // heading margins, code card, inline-code chip, hairline tables) so the
    // result matches the right-hand preview without depending on host internals.

    /**
     * One rendered Markdown file, read on demand.
     *
     * Reads through the same route the editor uses, so a document and its source
     * cannot disagree about what the file says. The renderer is a separate chunk
     * and is fetched in parallel with the text: a reader who opens a `.md` pays
     * for one small parse, not for the editor engine.
     */
    /**
     * A remote file painted by the browser: image, video, audio or PDF.
     *
     * The source is the byte route with `inline=1`, which answers with the
     * file's real media type and supports Range — the two things a browser
     * needs before it will seek inside a video or embed a PDF at all.
     */
    function MediaPreview ({ path, sessionId, kind, t }) {
      const alias = aliasFor(path, sessionId)
      const [failed, setFailed] = React.useState(false)
      const [reason, setReason] = React.useState('')
      if (alias === '' && (typeof sessionId !== 'string' || sessionId === '')) {
        return jsx('p', { className: 'sshwsp-filepane-note', role: 'status', children: t('preview.mediaNoAlias') })
      }
      const source = byteUrlOf(API.download, path, sessionId, { inline: '1' })
      if (failed) {
        // The element only says "no". Ask the route what it actually answered:
        // a 404 (the file moved), a 403 (the host is off) and a 415 are three
        // different repairs, and "it did not open" sends the reader guessing.
        return jsxs('div', { className: 'sshwsp-filepane-note', role: 'status', children: [
          jsx('span', { children: t('preview.mediaFailed') }),
          reason === '' ? null : jsx('code', { className: 'sshwsp-filepane-reason', children: reason }),
        ] })
      }
      const onError = () => {
        setFailed(true)
        requestJson(byteUrlOf(API.download, path, sessionId, { inline: '1' }), { method: 'GET' })
          .then((body) => {
            const text = typeof body?.error === 'string' ? body.error : ''
            if (text !== '') setReason(text)
          })
          .catch(() => {})
      }
      if (kind === 'image') {
        return jsx('div', { className: 'sshwsp-media sshwsp-media-image', children:
          jsx('img', { src: source, alt: previewNameOf(path), onError, decoding: 'async' }) })
      }
      if (kind === 'video') {
        return jsx('div', { className: 'sshwsp-media sshwsp-media-video', children:
          jsx('video', { src: source, controls: true, preload: 'metadata', onError }) })
      }
      if (kind === 'audio') {
        return jsx('div', { className: 'sshwsp-media sshwsp-media-audio', children:
          jsx('audio', { src: source, controls: true, preload: 'metadata', onError }) })
      }
      return jsx('div', { className: 'sshwsp-media sshwsp-media-pdf', children:
        jsx('embed', { src: source, type: 'application/pdf', onError }) })
    }

    /**
     * One remote HTML document, in a sandboxed frame.
     *
     * Scripts stay off by default: the document comes from another machine and
     * the frame lives inside this app. The escape hatch is explicit and says
     * what it gives up. Relative references were rewritten by the server, so
     * styles and images resolve without running anything.
     */
    function HtmlPreview ({ path, sessionId, t }) {
      const alias = aliasFor(path, sessionId)
      const [unlocked, setUnlocked] = React.useState(false)
      if (alias === '' && (typeof sessionId !== 'string' || sessionId === '')) {
        return jsx('p', { className: 'sshwsp-filepane-note', role: 'status', children: t('preview.htmlNoAlias') })
      }
      const source = byteUrlOf(API.html, path, sessionId)
      return jsxs('div', { className: 'sshwsp-htmlview', children: [
        jsxs('div', { className: 'sshwsp-htmlview-bar', children: [
          jsx('span', {
            className: 'sshwsp-htmlview-note',
            children: unlocked ? t('preview.htmlUnlocked') : t('preview.htmlSandboxed'),
          }),
          jsx('button', {
            type: 'button',
            className: 'sshwsp-btn sshwsp-htmlview-toggle',
            'aria-pressed': unlocked ? 'true' : 'false',
            onClick: () => setUnlocked(current => !current),
            children: unlocked ? t('preview.htmlLock') : t('preview.htmlUnlock'),
          }),
        ] }),
        // The key is load-bearing: sandbox flags are fixed when a document is
        // navigated, so changing the attribute alone leaves the page running
        // under the flags it loaded with — "Allow scripts" appeared to do
        // nothing until the frame was remounted.
        jsx('iframe', {
          key: unlocked ? 'unlocked' : 'sandboxed',
          className: 'sshwsp-htmlview-frame',
          title: previewNameOf(path),
          src: source,
          sandbox: unlocked ? 'allow-scripts allow-forms allow-popups' : '',
          referrerPolicy: 'no-referrer',
        }),
      ] })
    }

    function DocumentPreview ({ path, sessionId: givenSessionId, t }) {
      const [documentModule, setDocumentModule] = React.useState(null)
      const [chunkError, setChunkError] = React.useState('')
      const [state, setState] = React.useState({ phase: 'loading', text: '', clipped: false, error: '' })
      const sessionId = givenSessionId

      React.useEffect(() => {
        let alive = true
        markdownModule().then((loaded) => {
          if (alive) setDocumentModule(loaded)
        }, (error) => {
          // A chunk that cannot load is not "still loading": saying so would
          // leave a spinner up forever with no way to learn why.
          if (alive) setChunkError(error instanceof Error ? error.message : String(error))
        })
        return () => { alive = false }
      }, [])

      React.useEffect(() => {
        if (sessionId === '' || path === '') return undefined
        const controller = new AbortController()
        setState({ phase: 'loading', text: '', clipped: false, error: '' })
        const query = new URLSearchParams({ sessionId, path })
        requestJson(`${API.readText}?${query.toString()}`, { signal: controller.signal }).then(
          (reply) => {
            if (controller.signal.aborted) return
            if (!reply.ok || reply.data?.ok !== true) {
              setState({
                phase: 'failed',
                text: '',
                clipped: false,
                error: typeof reply.data?.error === 'string' ? reply.data.error : `HTTP ${reply.status}`,
              })
              return
            }
            const text = typeof reply.data.text === 'string' ? reply.data.text : ''
            const clipped = text.length > DOCUMENT_RENDER_LIMIT
            setState({ phase: 'ready', text: clipped ? text.slice(0, DOCUMENT_RENDER_LIMIT) : text, clipped, error: '' })
          },
          (error) => {
            if (controller.signal.aborted) return
            setState({ phase: 'failed', text: '', clipped: false, error: error instanceof Error ? error.message : String(error) })
          },
        )
        return () => controller.abort()
      }, [path, sessionId])

      if (chunkError !== '' || state.phase === 'failed') {
        return jsx('div', {
          className: 'sshwsp-filepane-note sshwsp-filepane-error',
          role: 'status',
          children: chunkError !== '' ? chunkError : state.error,
        })
      }
      if (state.phase === 'loading' || documentModule === null) {
        return jsx('div', { className: 'sshwsp-filepane-note', role: 'status', children: t('preview.loading') })
      }
      const Document = documentModule.MarkdownDocument
      return jsxs('div', { className: 'sshwsp-docpane', children: [
        state.clipped
          ? jsx('p', { className: 'sshwsp-filepane-note', role: 'status', children: t('preview.clipped') })
          : null,
        jsx(Document, { text: state.text, t, imgSrc: imageResolverFor(path, sessionId) }),
      ] })
    }

    /** The cached viewing preferences (see `applyPreferences`). */
    let fileViewPreferences = { fileView: 'sidebar', showFiles: false, hideComposer: true }

    /**
     * Open file tabs, in the order they were opened.
     *
     * `conversation.view` is a plugin-level LIST: one registered entry is one
     * tab, and the host draws it in EVERY conversation's strip. So the entries
     * are keyed by PATH — the file is the identity — and the session only
     * decides whose filesystem the view reads through. Clicking the same file
     * twice focuses its tab instead of adding a second one.
     */
    const openFileTabs = new Map() // path -> disposer

    /**
     * Which file each session opened last. Not the tab strip's selection (the
     * host owns that); this is what the probe reports and what a close falls
     * back from when the view itself never saw a session id.
     */
    const activeFileTabs = new Map() // sessionId -> path

    /**
     * Unsaved buffers, keyed `${sessionId}\u0000${path}`.
     *
     * The bytes live in the editor chunk; this is only the "has unsaved work"
     * bit the tab's × and Esc need in order to ask before dropping it.
     */
    const dirtyFileTabs = new Set()

    /**
     * The last file-tree click the bridge looked at.
     *
     * A click is decided synchronously inside a capture listener, so when the
     * preference "does nothing" there is no event to inspect afterwards. This
     * keeps the inputs and the outcome of the last attempt for
     * `globalThis.__sshwspProbe` (a diagnostic, not a feature).
     */
    let lastPreviewDecision = null

    /**
     * How many of our file views are mounted right now.
     *
     * Only the ACTIVE conversation view is rendered (the host passes
     * `only: viewId`), so this is 1 while a file tab is on screen and 0 when
     * Chat or any other view is. A counter rather than a boolean because the
     * next mount may overlap the previous one by a frame.
     *
     * Declared before `applyPreferences`, which reads it: a `let` initialized
     * further down the factory would be in its temporal dead zone for any call
     * that happens while the factory is still running.
     */
    let mountedFileViews = 0

    /**
     * Normalize and publish the viewing preferences.
     *
     * Called once at boot (from `/status`), after every panel save, and by any
     * later `/status` read. Normalizing here — not only on the server — is what
     * keeps a stale or hand-crafted reply from leaving the bridge in a mode
     * outside the two known ones.
     *
     * @param {{fileView?: unknown, showFiles?: unknown, hideComposer?: unknown}} [next] - the settings.
     */
    function applyPreferences (next) {
      const settings = {
        fileView: next?.fileView === 'conversation' ? 'conversation' : 'sidebar',
        showFiles: next?.showFiles === true,
        hideComposer: next?.hideComposer !== false,
      }
      if (
        settings.fileView === fileViewPreferences.fileView &&
        settings.showFiles === fileViewPreferences.showFiles &&
        settings.hideComposer === fileViewPreferences.hideComposer
      ) return
      fileViewPreferences = settings
      // The checkbox may be flipped while a file is already open, so the
      // composer must be re-decided here rather than only at mount.
      applyComposerHiding()
      // A file tab left open after switching back to the host preview is a tab
      // nobody asked to keep: closing the files is part of switching, not a
      // separate gesture.
      if (settings.fileView === 'sidebar' && openFileTabs.size > 0) closeEveryFileTab()
    }

    /**
     * Hide or show the composer to match the open view and the preference.
     *
     * The composer is NOT part of a view: it is a sticky seat under the view
     * area, so it stays on screen while a file tab is open and steals the
     * column's bottom. Hiding it is a DOM-level decision because the element
     * belongs to the host; the seat is found by walking up from the card to the
     * nearest sticky/fixed ancestor, which is the host's own seat, so the whole
     * band (card, fade mask, padding) goes away rather than just the input.
     */
    function applyComposerHiding () {
      if (typeof document === 'undefined') return
      const hide = mountedFileViews > 0 && fileViewPreferences.hideComposer === true
      const card = document.querySelector('[data-composer-card]')
      const target = composerSeatOf(card)
      if (target === null) return
      for (const node of document.querySelectorAll('[data-sshwsp-composer-off]')) {
        if (node !== target) node.removeAttribute('data-sshwsp-composer-off')
      }
      if (hide) target.setAttribute('data-sshwsp-composer-off', '')
      else target.removeAttribute('data-sshwsp-composer-off')
      // The composer just took (or gave back) its band: the pane's height is
      // measured against that band, and hiding does not resize the scrollport.
      if (typeof remeasureFilePanes === 'function') remeasureFilePanes()
    }

    /**
     * Ask the mounted file pane to measure itself again.
     *
     * Set by `useFilePaneHeight`; null while no file view is mounted. It exists
     * because the composer band can appear or vanish without any resize the
     * pane would otherwise observe.
     */
    let remeasureFilePanes = null

    /**
     * The host's composer seat: the sticky/fixed ancestor of the input card.
     *
     * Walking up instead of reading a class name keeps this working when the
     * host renames its CSS modules — the sticky behaviour is the seat's
     * defining property, not its class.
     *
     * @param {Element|null} card - the `[data-composer-card]` element.
     * @returns {Element|null} the element to hide, or null when it is not there.
     */
    function composerSeatOf (card) {
      if (card === null || card === undefined || typeof window === 'undefined') return null
      // The host marks the seat itself, which survives a layout change that
      // moves the stickiness to another wrapper. The walk below is the older
      // fallback for a build without the landmark.
      const marked = card.closest('[data-composer-seat]')
      if (marked !== null && marked !== undefined) return marked
      let node = card.parentElement
      let fallback = card.parentElement
      while (node !== null && node !== document.body) {
        const position = window.getComputedStyle(node).position
        if (position === 'sticky' || position === 'fixed') return node
        fallback = node
        node = node.parentElement
      }
      return fallback
    }

    let registerFileTab = null

    /**
     * Register a tab for one file, once.
     *
     * The tab strip renders `label`, which is a function so the language can
     * change without re-registering. The path travels through `inject` instead
     * of being read back off the DOM: two tabs can share a base name, and the
     * component must know which file it draws even before the strip exists.
     *
     * @param {string} path - the file to open.
     * @returns {boolean} whether the file now has a tab.
     */
    function ensureFileTab (path) {
      if (openFileTabs.has(path)) return true
      if (typeof registerFileTab !== 'function') return false
      const dispose = registerFileTab(path)
      if (typeof dispose !== 'function') return false
      openFileTabs.set(path, dispose)
      ensureFileTabDecoration()
      return true
    }

    /**
     * Which files each Session has open, whether or not their tabs are mounted.
     *
     * A `conversation.view` registration is plugin-wide: it shows up in EVERY
     * Session's tab strip, so a file opened in one Session would follow the
     * user into all of them. This map is what makes the tabs belong to a
     * Session — `openFileTabs` only ever holds the CURRENT Session's entries,
     * and switching away disposes them without forgetting them. Switching back
     * re-registers the same paths (their ids are derived from the path), so the
     * host's own per-Session `view` preference resolves again.
     */
    const sessionOpenFiles = new Map()

    /** The Session whose file tabs are currently registered ('' = none yet). */
    let registeredSessionId = ''

    /**
     * Point the tab roster at one Session.
     *
     * Disposing is not closing: the disposers go, the paths stay in
     * `sessionOpenFiles`, so the next visit re-registers exactly what was open.
     *
     * @param {string} sessionId - the Session that is now on screen.
     */
    function adoptSession (sessionId) {
      if (sessionId === '' || sessionId === registeredSessionId) return
      registeredSessionId = sessionId
      for (const [path, dispose] of [...openFileTabs]) {
        openFileTabs.delete(path)
        try { dispose() } catch { /* the owner may have collapsed the seat */ }
      }
      for (const path of sessionOpenFiles.get(sessionId) ?? []) ensureFileTab(path)
      ensureFileTabDecoration()
    }

    /** The last landmark element found; null until a conversation mounts. */
    let cachedSessionRoot = null

    /**
     * Read which Session the conversation shell is showing.
     *
     * The host marks it on its own content root (`data-conversation-session`),
     * which is the same landmark the host reads for Escape. The element is
     * cached because this runs on every conversation mutation: while the shell
     * stays put the answer is one attribute read, and only a replaced shell —
     * a workspace switch — pays for the lookup.
     *
     * @returns {string} the Session id, or '' before a conversation renders.
     */
    function currentSessionId () {
      if (typeof document === 'undefined') return ''
      const root = cachedSessionRoot !== null && cachedSessionRoot.isConnected === true
        ? cachedSessionRoot
        : document.querySelector('[data-conversation-session]')
      cachedSessionRoot = root ?? null
      const id = root?.getAttribute('data-conversation-session') ?? ''
      return typeof id === 'string' ? id : ''
    }

    /** Follow the open Session, so the tab strip shows that Session's files. */
    function syncSessionTabs () {
      // Nothing is open anywhere: there is no roster to re-point, and this is
      // the call the child-list observer makes on every conversation mutation.
      if (sessionOpenFiles.size === 0 && openFileTabs.size === 0) return
      const sessionId = currentSessionId()
      if (sessionId === '') return
      adoptSession(sessionId)
    }

    /**
     * Watch the conversation root for a Session switch.
     *
     * Two signals, because a Session can arrive in two shapes:
     *
     * - the shell stays mounted and only swaps `data-conversation-session` when
     *   the user switches (an ATTRIBUTE change, exact and cheap), and
     * - the shell is replaced outright — switching workspace rebuilds the whole
     *   conversation — in which case the landmark arrives inside a NEW subtree
     *   and no attribute observer ever hears about it (a CHILD LIST change).
     *
     * The child-list pass is coalesced into one animation frame and
     * `syncSessionTabs` returns immediately unless something is open, so the
     * steady state during streaming costs a cached attribute read, not a scan.
     *
     * @returns {() => void} the detach function.
     */
    function watchConversationSession () {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {}
      let frame = 0
      const run = () => {
        frame = 0
        try { syncSessionTabs() } catch { /* a host without the landmark is fine */ }
      }
      const schedule = () => {
        if (frame !== 0) return
        frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 0)
      }
      const observer = new MutationObserver(schedule)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-conversation-session'],
        childList: true,
        subtree: true,
      })
      schedule()
      return () => {
        observer.disconnect()
        if (frame !== 0) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          if (typeof clearTimeout === 'function') clearTimeout(frame)
        }
      }
    }

    /**
     * Remember one open file for a Session (the click that opened it).
     *
     * @param {string} sessionId - the Session that owns the tab.
     * @param {string} path - the file.
     */
    function rememberSessionFile (sessionId, path) {
      if (sessionId === '' || path === '') return
      const paths = sessionOpenFiles.get(sessionId)
      if (paths === undefined) {
        sessionOpenFiles.set(sessionId, [path])
        return
      }
      if (!paths.includes(path)) paths.push(path)
    }

    /** Forget one file in every Session (a close is a close wherever it happens). */
    function forgetSessionFile (path) {
      for (const [sessionId, paths] of [...sessionOpenFiles]) {
        const next = paths.filter(open => open !== path)
        if (next.length === 0) sessionOpenFiles.delete(sessionId)
        else if (next.length !== paths.length) sessionOpenFiles.set(sessionId, next)
      }
    }

    /**
     * Let go of the registered tabs but remember what was open.
     *
     * The host disposes every entry registered inside a seat when that seat is
     * re-declared, and a workspace switch can do exactly that. The disposers are
     * dead then, but the roster is not: keeping it is what lets the next seat
     * (or the next visit to this Session) put the same files back.
     */
    function deregisterFileTabs () {
      for (const dispose of [...openFileTabs.values()]) {
        try { dispose() } catch { /* the owner may have collapsed the seat first */ }
      }
      openFileTabs.clear()
      registeredSessionId = ''
      ensureFileTabDecoration()
    }

    /** Drop every file tab (preference switched to the sidebar, or teardown). */
    function closeEveryFileTab () {
      deregisterFileTabs()
      activeFileTabs.clear()
      dirtyFileTabs.clear()
      sessionOpenFiles.clear()
    }

    /**
     * Drop every file tab and the tab-decoration observer.
     *
     * The single teardown name `apply` returns with, so a materialization that
     * is replaced does not leave tabs (or an observer on the host's strip)
     * behind.
     */
    function releaseFileView () {
      closeEveryFileTab()
      registerFileTab = null
      tabMenuDetach?.()
      tabMenuDetach = null
      tabTipDetach?.()
      tabTipDetach = null
    }

    /** Open one file in its own conversation tab; false when no tab can exist. */
    function openFilePreview (sessionId, path) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      // The gate is the VIEWER, not the text whitelist: a PNG or a PDF has no
      // text to read and is still an open we can honour. Asking the text
      // predicate here made the bridge claim the click and then decline it,
      // which is why media kept landing in the host's right panel.
      const viewer = viewerOf(path)
      if (viewer === 'binary') return false
      // `unknown` still opens: the bytes decide a moment later. It needs the
      // same session the byte viewers need, because the probe is a read.
      if (viewer === 'unknown' && typeof sessionId !== 'string') return false
      // Everything but text and Markdown is painted from a byte URL, and a byte
      // URL needs the alias its session belongs to. A LOCAL workspace has no
      // alias: claiming its images would swap a picture the host can show for a
      // note saying the session is not connected. So an alias-less media click
      // stays with the host, which owns local files.
      if (viewer !== 'text' && viewer !== 'markdown') {
        const alias = aliasFor(path, sessionId)
        // A local workspace has no alias, but it does have a session to fence
        // the read against — so it is claimed too, and served from disk.
        if (alias === '' && (typeof sessionId !== 'string' || sessionId === '')) return false
      }
      // The tab roster belongs to the Session on screen: opening a file from
      // another Session's tree (a jump link, a restored preference) must not
      // leave that Session's tabs in this one's strip.
      adoptSession(sessionId)
      if (!ensureFileTab(path)) return false
      rememberSessionFile(sessionId, path)
      activeFileTabs.set(sessionId, path)
      activateFileTab(path)
      return true
    }

    /** Close one file's tab; `sessionId` is only the fallback conversation. */
    function closeFilePreview (path, sessionId) {
      const dispose = openFileTabs.get(path)
      if (dispose === undefined) return false
      openFileTabs.delete(path)
      try { dispose() } catch { /* the seat may already be gone */ }
      forgetSessionFile(path)
      for (const [id, open] of [...activeFileTabs]) {
        if (open === path) activeFileTabs.delete(id)
      }
      for (const key of [...dirtyFileTabs]) {
        if (key.endsWith(`\u0000${path}`)) dirtyFileTabs.delete(key)
      }
      ensureFileTabDecoration()
      // Leave the strip on something that resolves. Another file of this
      // session still open is the better answer than Chat: closing one of
      // several tabs should not drop the whole row of files. Only the last
      // close puts the session back on the conversation, because the host
      // would otherwise keep a stored choice that names a tab it no longer has.
      const remaining = [...openFileTabs.keys()]
      const openView = liveOpenView
      if (typeof openView === 'function' && typeof sessionId === 'string' && sessionId !== '') {
        const next = remaining.length > 0 ? remaining[remaining.length - 1] : null
        try {
          if (next === null) openView('chat', '')
          else {
            activeFileTabs.set(sessionId, next)
            activateFileTab(next)
          }
        } catch { /* an older host may not offer it */ }
      }
      return true
    }

    /**
     * The ONE file a tab label stands for, when there is exactly one.
     *
     * The decoration pass stamps every file tab with its path, so this is the
     * fallback for the frame before the stamp lands — and the answer to "may a
     * label be trusted?" is no: two open `index.ts` files make it ambiguous,
     * and guessing would close the wrong one. Undefined means "not ours to
     * claim", which keeps the browser's own menu on any tab we cannot place.
     */
    function pathOfTabLabel (text) {
      const name = String(text ?? '').replace(/\s*×\s*$/u, '').trim()
      if (name === '') return undefined
      const matches = [...openFileTabs.keys()].filter(path => fileTabName(path) === name)
      return matches.length === 1 ? matches[0] : undefined
    }

    /**
     * Close several file tabs, asking ONCE for the unsaved ones.
     *
     * One prompt per file would make "close the four tabs I opened by mistake"
     * a four-dialog interrogation, and a prompt that only names one buffer
     * hides that the others are about to go too. Closing stays cancellable as a
     * whole: any refusal aborts every tab in the batch.
     *
     * @returns {number} how many tabs were closed.
     */
    function closeTabs (paths, sessionId) {
      const list = [...new Set(paths)].filter(path => openFileTabs.has(path))
      if (list.length === 0) return 0
      // A tab strip with no Session landmark gives no id to key the dirty set
      // by, and a menu that silently discards unsaved text is worse than no
      // menu: fall back to "any Session has this path dirty".
      const isDirty = (path) => sessionId === ''
        ? [...dirtyFileTabs].some(key => key.endsWith(`\u0000${path}`))
        : isFileDirty(sessionId, path)
      const dirty = list.filter(path => isDirty(path))
      if (dirty.length > 0 && typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const prompt = dirty.length === 1
          ? translate('edit.unsavedPrompt')
          : translate('preview.tabsUnsaved', { count: String(dirty.length) })
        if (window.confirm(prompt) !== true) return 0
      }
      for (const path of list) closeFilePreview(path, sessionId)
      return list.length
    }

    /** Close one file tab, with the same single-prompt rule as a batch. */
    function closeTab (path, sessionId) { return closeTabs([path], sessionId) }

    /** The marker the decoration pass stamps: the one exact tab handle. */
    const FILE_TAB_SELECTOR = '[data-conversation-tabs] [role="tab"]'

    /**
     * The context menu for one file tab.
     *
     * The host draws no menu on conversation tabs at all (its only tab menu
     * belongs to the right sidebar), so this gesture was free: the browser's
     * menu appeared, offering "back", "reload" and "inspect" — nothing about
     * the tab. The three verbs are scoped to file tabs on purpose: "close
     * others" must never reach the conversation, the trajectory, or a view
     * another plugin registered, and those tabs never get this menu because
     * they carry no marker.
     *
     * The marker IS the claim. The label lookup is the first-frame fallback for
     * a tab whose decoration has not landed yet; it answers only when the name
     * is unique, because closing the wrong `index.ts` is worse than no menu.
     *
     * This lives here, not in the bundle: the tab strip is this feature's
     * surface, and the bundle's job is to hand the renderer over.
     */
    /**
     * Which files the two batch verbs would take, from the session's roster.
     *
     * Pure so the ORDER rule can be tested without a DOM: the roster is kept in
     * open order, the host renders in that same order, and the overflow the host
     * folds into "more views" is the right-hand end of it. A path that is not in
     * the list (opened in the same tick as the click) is still closable, so it is
     * prepended rather than ignored.
     *
     * @param {string[]} paths - the session's open files, in open order.
     * @param {string} path - the right-clicked file.
     * @returns {{others: string[], right: string[]}} the two batches.
     */
    function fileBatchFor (paths, path) {
      // A path that is not in the list was opened in the same tick as the
      // click, and new tabs append: treat it as the newest, not the oldest.
      const list = paths.includes(path) ? [...paths] : [...paths, path]
      const index = list.indexOf(path)
      return {
        others: list.filter(value => value !== path),
        right: index >= 0 ? list.slice(index + 1) : [],
      }
    }

    function openTabMenuAt (target, event) {
      const button = target.closest(FILE_TAB_SELECTOR)
      if (button === null) return false
      const marked = button.getAttribute('data-sshwsp-tab-path')
      const path = typeof marked === 'string' && marked !== ''
        ? marked
        : pathOfTabLabel(button.textContent ?? '')
      if (typeof path !== 'string' || path === '') return false
      const strip = button.closest('[data-conversation-tabs]')
      const sessionId = strip?.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? ''
      // The ROSTER, not the strip. A file tab the host has folded into its
      // "more views" menu is still an open file, but it is a menuitem up there
      // and carries no marker we could read — asking the DOM would leave those
      // files untouched by "close others", which is exactly the question that
      // started this. The roster keeps open order, and open order IS the strip's
      // order (the overflow is the right-hand end), so "to the right" still
      // means what it looks like.
      const roster = sessionOpenFiles.get(sessionId) ?? []
      const stamped = [...(strip?.querySelectorAll('[role="tab"][data-sshwsp-tab-path]') ?? [])]
        .map(node => node.getAttribute('data-sshwsp-tab-path'))
        .filter(value => typeof value === 'string' && value !== '')
      const paths = roster.length > 0 ? [...roster] : stamped
      const { others, right } = fileBatchFor(paths, path)
      showMenu([
        {
          id: 'filetab.close',
          label: translate('tabmenu.close'),
          glyph: 'file',
          run: () => { closeTab(path, sessionId) },
        },
        {
          id: 'filetab.closeOthers',
          label: translate('tabmenu.closeOthers'),
          glyph: 'file',
          disabled: others.length === 0,
          run: () => { closeTabs(others, sessionId) },
        },
        {
          id: 'filetab.closeRight',
          label: translate('tabmenu.closeRight'),
          glyph: 'file',
          disabled: right.length === 0,
          run: () => { closeTabs(right, sessionId) },
        },
      ], event.clientX, event.clientY)
      event.preventDefault()
      event.stopPropagation()
      return true
    }

    /**
     * Install the tab menu while this chunk is mounted.
     *
     * Capture phase, because the strip's own click handling must never see a
     * right-click we handled. Nothing else is claimed: a non-file tab returns
     * false and keeps the browser's menu, which is also what makes the
     * gesture's scope visible.
     */
    function installTabMenu () {
      if (typeof document === 'undefined') return () => {}
      const onContextMenu = (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest(`[data-context-menu], [data-sshwsp-flowmenu]`) !== null) return
        openTabMenuAt(target, event)
      }
      document.addEventListener('contextmenu', onContextMenu, true)
      return () => document.removeEventListener('contextmenu', onContextMenu, true)
    }

    /** Detach for the tab menu, installed lazily on the first open. */
    let tabMenuDetach = null

    /** Detach for the tab tooltip, installed with the first open. */
    let tabTipDetach = null

    /**
     * A hover label for the file tabs, drawn here instead of by the browser.
     *
     * `title` is the one piece of a tab this plugin cannot style: the OS draws
     * it in its own colours, so on a dark theme it lands as a black box over
     * the host's chrome. The tab keeps its path in `data-sshwsp-tab-path`
     * (stamped by the decoration pass) and this shows it in the plugin's own
     * shape: same hairline and corner radius as the rest of the chrome, a 320 ms
     * delay so a passing pointer does not flash it, and it flips below the tab
     * when the strip sits too close to the top of the window.
     */
    function installTabTip () {
      if (typeof document === 'undefined') return () => {}
      let tip = null
      let timer = null
      let anchor = null
      // The label hangs under the tab, but starts to the RIGHT of the pointer:
      // the eye is already there, and a box centred under the tab would cover
      // the name being read.
      let pointerX = null

      const hide = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        anchor = null
        tip?.remove()
        tip = null
        document.body?.removeAttribute('data-sshwsp-tab-hover')
      }

      const show = (button) => {
        const path = button.getAttribute('data-sshwsp-tab-path')
        if (path === null || path === '') return
        if (tip === null) {
          tip = document.createElement('div')
          tip.className = 'sshwsp-tabtip sshwsp-tokens'
          tip.setAttribute('role', 'tooltip')
          document.body.appendChild(tip)
        }
        tip.textContent = displayPathOf(path)
        // Measured after the text is in: the label is only as wide as the path,
        // and it must stay inside the window even for a deep remote directory.
        const box = button.getBoundingClientRect()
        const own = tip.getBoundingClientRect()
        const near = pointerX === null ? box.left + box.width / 2 : pointerX + 14
        const left = Math.min(Math.max(8, near), window.innerWidth - own.width - 8)
        // Under the tab by default: the label is a path, and reading it next to
        // the tab it belongs to beats reading it over the conversation. It only
        // flips above when the strip sits low enough that the label would fall
        // out of the window.
        const below = box.bottom + 8
        const top = below + own.height <= window.innerHeight - 8 ? below : box.top - own.height - 8
        tip.style.left = `${Math.round(left)}px`
        tip.style.top = `${Math.round(Math.max(8, top))}px`
      }

      const over = (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const button = target.closest('[role="tab"][data-sshwsp-tab-path]')
        if (button === null || button === anchor) return
        // The host draws its OWN tooltip on a truncated tab label: `ViewTabLabel`
        // wraps the label in the host's Tooltip primitive whenever the text is
        // wider than 88px, and our file names usually are. Two bubbles would
        // stack — the host's bare name in the dark chrome bubble, ours with the
        // path — so the host's must never open here. React synthesises
        // pointerenter from pointerover; stopping the event in the capture phase
        // keeps it from ever reaching the root listener, without touching the
        // click that switches tabs.
        if (event.pointerType === 'mouse' || event.pointerType === undefined) event.stopPropagation()
        pointerX = event.clientX
        hide()
        // React also synthesises pointerenter from a pointerOUT event on the
        // element being left, and that event is not ours to stop — it fires on
        // whatever the pointer came from. So this attribute is the second gate:
        // while a file tab is hovered, styles.css hides any host tooltip bubble
        // it managed to open anyway.
        document.body?.setAttribute('data-sshwsp-tab-hover', '')
        anchor = button
        timer = setTimeout(() => {
          timer = null
          if (anchor === button) show(button)
        }, 320)
      }

      const out = (event) => {
        if (anchor === null) return
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest('[role="tab"][data-sshwsp-tab-path]') !== anchor) return
        const next = event.relatedTarget
        if (next instanceof Node && anchor.contains(next)) return
        hide()
      }

      // Tracked only while a tab is anchored: the label appears 320ms later,
      // and the pointer rarely sits still for that long.
      const moved = (event) => {
        if (anchor !== null) pointerX = event.clientX
      }

      document.addEventListener('pointerover', over, true)
      document.addEventListener('pointerout', out, true)
      document.addEventListener('pointermove', moved, true)
      // Any scroll or resize moves the tab under a fixed label, so the label
      // has to go rather than chase it.
      window.addEventListener('scroll', hide, true)
      window.addEventListener('resize', hide)
      return () => {
        document.removeEventListener('pointerover', over, true)
        document.removeEventListener('pointerout', out, true)
        document.removeEventListener('pointermove', moved, true)
        window.removeEventListener('scroll', hide, true)
        window.removeEventListener('resize', hide)
        hide()
      }
    }

    /** One key for one buffer's unsaved state. */
    function fileDirtyKey (sessionId, path) { return `${sessionId}\u0000${path}` }

    /**
     * Publish one buffer's unsaved state.
     *
     * The host's × on the tab and this plugin's Esc handler run outside the
     * editor, so they cannot see its state. This is the one bit they need.
     */
    function setFileDirty (sessionId, path, dirty) {
      if (typeof sessionId !== 'string' || sessionId === '' || path === '') return
      const key = fileDirtyKey(sessionId, path)
      if (dirty === true) dirtyFileTabs.add(key)
      else dirtyFileTabs.delete(key)
    }

    /** Whether that buffer has unsaved work. */
    function isFileDirty (sessionId, path) {
      return dirtyFileTabs.has(fileDirtyKey(sessionId, path))
    }

    /**
     * The text a tab BUTTON carries, without the nodes this plugin appends.
     *
     * The host's label is one child span; the × and the directory tail are ours
     * and live beside it. Reading `textContent` glued them onto the name —
     * "index.ts…/src×" — and then no open file matched, which is exactly how a
     * tail survived its twin being closed: the pass stopped recognising the tab
     * and never got as far as clearing it.
     *
     * Walking the direct children also avoids stripping by suffix: the tail is
     * not a suffix of the label, it is a sibling.
     *
     * @param {Element} element - the host's tab button.
     * @returns {string} the label the host drew.
     */
    function tabTextOf (element) {
      const parts = []
      for (const node of element.childNodes) {
        // Duck-typed rather than `instanceof Element`: the tab may live in a
        // different realm, where the global Element is not the same constructor,
        // and "has attributes" is the only thing this needs.
        if (typeof node.hasAttribute === 'function' &&
          (node.hasAttribute('data-sshwsp-tab-dir') || node.hasAttribute('data-sshwsp-tab-close'))) continue
        parts.push(node.textContent ?? '')
      }
      return parts.join('').replace(/\s*×\s*$/u, '').trim()
    }

    /** `CSS.escape` where the host has it, a quoted-attribute fallback where not. */
    function cssEscape (value) {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
      return String(value).replace(/["\\]/gu, '\\$&')
    }

    /**
     * One spelling for a path the user reads.
     *
     * Paths reach this plugin from two worlds and both spellings leak: a remote
     * path is a POSIX path under an `ssh://host` prefix, a local one is a
     * Windows path (`F:\a\b`), and the tree occasionally hands over the other
     * separator. A tooltip that says `F:/a/b` beside one that says
     * `F:\a\b` reads as two different filesystems.
     *
     * The ssH prefix always keeps forward slashes (it is a URL); the path behind
     * it is POSIX. Everything else that looks Windows becomes backslashes.
     *
     * @param {string} path - the path as stored.
     * @returns {string} the path to display.
     */
    function displayPathOf (path) {
      const raw = String(path)
      const remote = /^(ssh:\/\/[^/]+)(\/.*)$/u.exec(raw)
      if (remote !== null) return remote[1] + remote[2].replace(/\\/gu, '/')
      if (/^[A-Za-z]:/u.test(raw) || raw.startsWith('\\\\') || raw.includes('\\')) {
        return raw.replace(/\//gu, '\\')
      }
      return raw
    }

    /** Path segments, splitting both separators (remote POSIX, local Windows). */
    function tabSegmentsOf (path) {
      return String(path).replace(/[?#].*$/u, '').replace(/[/\\]+$/u, '')
        .split(/[/\\]+/u)
        .filter(segment => segment !== '')
    }

    /**
     * The dim path tail a colliding tab carries, e.g. `…\api`.
     *
     * The tab's own text stays the bare file name — that is what the host draws
     * and what people scan for. Only when a second open file shares that name
     * does the tab need more, and then the extra goes in a separate span on the
     * right: `__init__.py  …\api`, so the name keeps its position in the row
     * and the tail can be ellipsised on its own. The shortest prefix that tells
     * the twins apart wins, and the roster is read per render, so the tail
     * disappears the moment the twin closes.
     *
     * @param {string} path - the open file.
     * @returns {string} the tail, or '' when the name is unique.
     */
    function tabDirTailFor (path) {
      const name = fileTabName(path)
      const roster = sessionOpenFiles.get(registeredSessionId) ?? [...openFileTabs.keys()]
      const twins = roster.filter(other => other !== path && fileTabName(other) === name)
      if (twins.length === 0) return ''
      const mine = tabSegmentsOf(path)
      // The tail is made of DIRECTORIES: the file name is already on the tab.
      const parents = mine.slice(0, -1)
      const shown = displayPathOf(path)
      const separator = shown.includes('\\') && !shown.startsWith('ssh://') ? '\\' : '/'
      for (let depth = 1; depth <= parents.length; depth += 1) {
        const candidate = parents.slice(-depth).join(separator)
        const clash = twins.some((other) => {
          const theirs = tabSegmentsOf(other).slice(0, -1)
          return theirs.length >= depth && theirs.slice(-depth).join(separator) === candidate
        })
        if (!clash) return `…${separator}${candidate}`
      }
      return ''
    }

    /**
     * Click the `index`-th element under `selector` whose text is `label`.
     *
     * Two open files may share a base name, and the tabs are then pixel-equal.
     * Registration order is the only thing that tells them apart, and the host
     * renders entries in that same order — so the n-th match is the n-th file
     * with that name.
     */
    function clickNthByText (selector, label, index) {
      let seen = 0
      for (const element of document.querySelectorAll(selector)) {
        if (tabTextOf(element) !== label) continue
        if (seen === index) {
          element.click()
          return true
        }
        seen += 1
      }
      return false
    }

    /**
     * The host's view switcher, captured from the mounted view's props.
     *
     * Closing the last tab has to put the session back on the conversation,
     * and the supported way to do that is the `openView` the seat hands its
     * views. A module-level copy is what lets the DOM-level × reach it.
     */
    let liveOpenView = null

    /**
     * Make one file's tab the active conversation view.
     *
     * The tab strip's own click handler is the only supported way in: it
     * activates the view's assembler target AND records the choice on the
     * session's conversation store, and only the second half makes the view
     * area render this tab. That handler sits on the tab element, so this
     * clicks the element the host drew — retrying for a few frames because
     * registration renders the tab asynchronously. The decoration pass marks
     * tabs with their path; before it has run the label is the only handle,
     * and the n-th same-named tab stands for the n-th same-named file.
     *
     * A narrow window puts surplus tabs into the "more views" menu, which is
     * still the same host row: after the retries run out this opens that menu
     * and clicks the entry in it. Nothing is clicked blind — both selectors are
     * the host's own landmarks, and a miss just leaves the tab for the user.
     */
    function activateFileTab (path, attempt = 0) {
      try {
        const marked = document.querySelector(`[role="tab"][data-sshwsp-tab-path="${cssEscape(path)}"]`)
        if (marked !== null) {
          marked.click()
          return
        }
        const label = fileTabName(path)
        const index = [...openFileTabs.keys()].filter(open => fileTabName(open) === label).indexOf(path)
        if (index >= 0 && clickNthByText('[role="tab"]', label, index)) return
        const row = document.querySelector('[data-conversation-tabs]')
        if (row !== null) {
          if (attempt >= 10 && clickNthByText('[role="menuitem"]', label, index)) return
          if (attempt === 10) {
            const more = row.parentElement?.querySelector('[aria-haspopup="menu"]')
            if (more !== undefined && more !== null) more.click()
          }
        }
        if (attempt < 40) window.setTimeout(() => { activateFileTab(path, attempt + 1) }, 30)
      } catch { /* a host without the tab leaves the choice to the user */ }
    }

    /**
     * The width every file tab takes, and the slice of it the × owns.
     *
     * Fixed rather than content-sized: the host's own tabs hug their labels,
     * and a row of file tabs that each changed width as names came and went
     * made the row jump. The close room is what keeps the label off the ×.
     */
    const FILE_TAB_WIDTH = 132
    const FILE_TAB_CLOSE_ROOM = 22

    /**
     * Where file tabs sit in the conversation's strip: after every built-in view.
     *
     * The host orders `conversation.view` entries by this number (Chat 0,
     * Trajectory 10, Lineage/Stats 40), and an entry WITHOUT one sorts as if it
     * were 0 — which is how a file tab ended up between "对话" and "轨迹". A file
     * tab is an aside opened from the tree, never a primary view, so it belongs
     * at the far end of the row and stays there as files open and close.
     */
    const FILE_TAB_ORDER = 100

    /**
     * Mark the host's tabs for our files and give each one a ×.
     *
     * The host draws tabs with no close affordance, and a file tab that can
     * only be closed from inside the file view is a trap once several are
     * open. The × is appended to the tab element the host already rendered —
     * the same decoration `dsh-client-file-view` performs — and the marker
     * attribute doubles as the guard that makes the pass idempotent and as the
     * activation handle (two files may share a base name).
     *
     * Every state this reads is module-level, so the pass can run from a
     * MutationObserver without a React render.
     */
    function decorateFileTabs () {
      const strip = document.querySelector('[data-conversation-tabs]')
      if (strip === null || openFileTabs.size === 0) {
        // No file tab: whatever the seat looks like now, it must not stay
        // hidden. (The mounted view's own cleanup covers the common path; this
        // covers a seat the host rebuilt after the last close.)
        applyComposerHiding()
        return
      }
      // A rebuilt conversation root carries the Session landmark as part of the
      // new subtree, so the attribute observer never sees it change. The strip
      // is already in hand here, which makes this the cheap place to notice.
      syncSessionTabs()
      const seen = new Map()
      for (const button of strip.querySelectorAll('[role="tab"]')) {
        const text = tabTextOf(button)
        const candidates = [...openFileTabs.keys()].filter(path => fileTabName(path) === text)
        if (candidates.length === 0) continue
        const at = seen.get(text) ?? 0
        seen.set(text, at + 1)
        const path = candidates[at]
        if (path === undefined) continue
        button.setAttribute('data-sshwsp-tab-path', path)
        // Hovering names the file in full. The tab is a fixed 132px, so a long
        // name is clipped with an ellipsis; the tooltip is the only place that
        // can still say which file a truncated tab stands for.
        // No tooltip. The tab is a fixed 132px, so a long name is clipped with
        // an ellipsis, and the obvious fix — a `title` attribute — draws the
        // browser's own black tooltip, which fights the host's chrome and
        // cannot be styled. The open pane already names the file in its header,
        // so the tab stays quiet on hover; the visible text stays the file name
        // for assistive technology.
        button.removeAttribute('title')
        const tail = tabDirTailFor(path)
        const labelNode = button.firstElementChild
        labelNode?.removeAttribute('title')
        if (labelNode !== null && labelNode !== undefined && !labelNode.hasAttribute('data-sshwsp-tab-close')) {
          Object.assign(labelNode.style, {
            display: 'inline-block',
            verticalAlign: 'bottom',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            // The name keeps its place in the row; the tail gets the leftover
            // space and nothing else. Two widths, because a unique name may
            // use the whole tab.
            maxWidth: tail === '' ? '100%' : '56%',
          })
        }
        const previousTail = button.querySelector('[data-sshwsp-tab-dir]')
        if (tail === '') {
          previousTail?.remove()
        } else {
          const tailNode = previousTail ?? document.createElement('span')
          if (previousTail === null) {
            tailNode.setAttribute('data-sshwsp-tab-dir', '')
            if (labelNode !== null && labelNode !== undefined) labelNode.insertAdjacentElement('afterend', tailNode)
            else button.appendChild(tailNode)
          }
          if (tailNode.textContent !== tail) tailNode.textContent = tail
          Object.assign(tailNode.style, {
            display: 'inline-block',
            verticalAlign: 'bottom',
            // The END of the tail is the part that tells twins apart (`…\api`
            // vs `…\core`), so the ellipsis must eat the LEFT edge — that is
            // what `direction: rtl` buys on a single-line box.
            direction: 'rtl',
            textAlign: 'left',
            maxWidth: '38%',
            marginLeft: '6px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-secondary, currentColor)',
          })
        }
        // A fixed width and a pinned ×: the host sizes a tab to its label and
        // draws no close button, so a name plus a hand-added × wrapped onto a
        // second line (the row grew a line taller as soon as one was open).
        // The width is fixed so the row stops reflowing as files open and
        // close, and the right padding is the space the × sits in.
        Object.assign(button.style, {
          position: 'relative',
          boxSizing: 'border-box',
          flex: `0 0 ${FILE_TAB_WIDTH}px`,
          width: `${FILE_TAB_WIDTH}px`,
          minWidth: `${FILE_TAB_WIDTH}px`,
          maxWidth: `${FILE_TAB_WIDTH}px`,
          paddingRight: `${FILE_TAB_CLOSE_ROOM}px`,
        })
        if (button.querySelector('[data-sshwsp-tab-close]') !== null) continue
        const close = document.createElement('span')
        close.setAttribute('data-sshwsp-tab-close', '')
        close.setAttribute('role', 'button')
        close.setAttribute('aria-label', translate('preview.tabClose'))
        close.setAttribute('title', translate('preview.tabClose'))
        close.textContent = '×'
        Object.assign(close.style, {
          position: 'absolute',
          right: '4px',
          top: '50%',
          transform: 'translateY(-50%)',
          padding: '0 2px',
          color: 'var(--dsw-alias-label-secondary, currentColor)',
          fontSize: '12px',
          lineHeight: '1',
          cursor: 'pointer',
        })
        close.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          // One close path for the × and for the tab's context menu: the dirty
          // prompt and the "what stays open" rule must not exist twice.
          closeTab(path, stripSessionId(strip))
        })
        button.appendChild(close)
      }
      // The strip re-decorates on every view change, which is also the moment
      // the composer seat may have been rebuilt: re-decide here rather than
      // leaving a hidden-or-shown composer that no longer matches the tab.
      applyComposerHiding()
    }

    /** The session a tab strip belongs to, from the host's own landmark. */
    function stripSessionId (strip) {
      return strip.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? ''
    }

    /** The decoration pass's observer, while at least one file tab exists. */
    let fileTabDecoration = null

    /**
     * Keep the × on file tabs across host re-renders.
     *
     * The strip is React's: it re-renders on every view change and would drop a
     * node added by hand. The pass therefore runs from a MutationObserver and
     * is idempotent (the marker attribute is the guard). It is installed only
     * while file tabs exist — a host with no file tab pays nothing — and it
     * gives up as soon as the last tab closes.
     *
     * @returns {() => void} the observer's detach function.
     */
    function installFileTabDecoration () {
      const decorate = () => {
        try { decorateFileTabs() } catch { /* decoration is cosmetic, never load-bearing */ }
      }
      let strip = null
      let stripObserver = null
      const attach = () => {
        // While the strip we hold is still in the document it IS the answer;
        // querying the whole document on every mutation (the chat streams them
        // constantly) was measurable work for no new information.
        if (strip !== null && strip.isConnected === true) return
        const next = document.querySelector('[data-conversation-tabs]')
        if (next === strip) return
        stripObserver?.disconnect?.()
        stripObserver = null
        strip = next
        if (strip === null) return
        stripObserver = new MutationObserver(decorate)
        // `characterData` is deliberately absent: writing our own nodes' text would
        // feed this observer and re-enter the pass. React replaces label nodes, it
        // does not edit their text in place.
        stripObserver.observe(strip, { childList: true, subtree: true })
        decorate()
      }
      const rootObserver = new MutationObserver(attach)
      rootObserver.observe(document.documentElement, { childList: true, subtree: true })
      attach()
      return () => {
        rootObserver.disconnect()
        stripObserver?.disconnect?.()
      }
    }

    /** Start or stop the decoration pass to match the open tab set. */
    function ensureFileTabDecoration () {
      if (openFileTabs.size > 0 && tabMenuDetach === null) tabMenuDetach = installTabMenu()
      if (openFileTabs.size > 0 && tabTipDetach === null) tabTipDetach = installTabTip()
      if (openFileTabs.size === 0) {
        fileTabDecoration?.()
        fileTabDecoration = null
        return
      }
      if (fileTabDecoration !== null) return
      if (typeof document === 'undefined') return
      fileTabDecoration = installFileTabDecoration()
    }

    /**
     * One file, filling the conversation area.
     *
     * `filePath` arrives through the registration's `inject`, so the component
     * never guesses which file it draws — two tabs may share a base name. The
     * session comes from the same place when the host provides it and from the
     * body landmark otherwise: the seat is session-scoped, but a host build is
     * not promised to hand a registered view the session id, and the host
     * itself reads that landmark for Escape.
     *
     * The view is IN FLOW, not an overlay. It is the content of the tab, so it
     * fills the conversation area the way the transcript does; a fixed,
     * measured box on top of the host's DOM would read as a layer over the
     * conversation — which is exactly what the first draft looked like.
     */
    /**
     * Size the file view to the conversation's scrollport.
     *
     * The host lets its view area grow with the view's content (`flex: 1 0
     * auto` once a transcript is on screen), so a view that measures itself by
     * its content drags the whole column into the transcript's scroller — and
     * this view's own footer scrolls away with it. A file view is a pane, not a
     * transcript: it takes the scrollport's height, the editor scrolls inside
     * it, and the footer stays on the floor.
     *
     * The height is measured rather than expressed in CSS because the two
     * numbers live in host-owned boxes: the scrollport (`clientHeight`) and the
     * composer seat, which is sticky, is not part of any view, and is hidden by
     * this plugin while a file is open (so it measures 0).
     *
     * @param {object} rootRef - ref to the pane, inside the scrollport.
     * @param {string} path - the file being shown; a new file re-measures.
     */
    function useFilePaneHeight (rootRef, path) {
      React.useEffect(() => {
        const node = rootRef.current
        if (node === null) return undefined
        const scroller = node.closest('[data-conversation-scroll]')
        if (scroller === null) return undefined
        let frame = 0
        const observedBands = new Set()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { schedule() }) : null
        const apply = () => {
          frame = 0
          const scrollRect = scroller.getBoundingClientRect()
          const paneRect = node.getBoundingClientRect()
          // Where the pane may start. Normally the top of the scrollport; a
          // host that puts something above a view still gets that space counted.
          const top = Math.max(scrollRect.top, paneRect.top)
          const floor = scrollRect.top + scroller.clientHeight
          // The composer is the host's, and it can be in flow (a sticky seat
          // pinned to the floor), laid over the content, or hidden by this
          // plugin. Its own top edge answers all three — whatever sits below
          // that edge belongs to the composer, not to the file. The seat is
          // asked first; the input card is the fallback for a build that moved
          // or renamed the seat.
          const seat = scroller.querySelector('[data-composer-seat]')
            ?? document.querySelector('[data-composer-seat]')
          const card = scroller.querySelector('[data-composer-card]')
            ?? document.querySelector('[data-composer-card]')
          let limit = floor
          for (const band of [seat, card]) {
            if (band === null) continue
            const rect = band.getBoundingClientRect()
            if (rect.height > 0 && rect.top > top && rect.top < floor) {
              limit = rect.top
              break
            }
          }
          // The floor keeps a not-yet-laid-out shell from collapsing the pane,
          // and the ceiling keeps a mid-layout pass from growing past the
          // scrollport; the write is guarded so a settled pane stops re-rendering.
          const height = Math.max(180, Math.round(Math.min(scroller.clientHeight, limit - top)))
          if (node.style.height !== `${height}px`) node.style.height = `${height}px`
          // The composer can be re-created or shown later; watching the nodes
          // that exist NOW (not only the ones from mount) keeps that honest.
          if (observer !== null) {
            observer.observe(scroller)
            for (const band of [seat, card]) {
              if (band !== null && !observedBands.has(band)) {
                observedBands.add(band)
                observer.observe(band)
              }
            }
          }
        }
        const schedule = () => {
          if (frame !== 0) return
          frame = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(apply)
            : setTimeout(apply, 0)
        }
        // The settings toggle shows/hides the composer without resizing the
        // pane, so the pane is re-measured from that side too (see
        // `applyComposerHiding`).
        remeasureFilePanes = schedule
        schedule()
        if (typeof window !== 'undefined') window.addEventListener('resize', schedule)
        // The composer mounts a beat after a session transition; two cheap
        // re-measures cover that without a polling loop.
        const timers = typeof setTimeout === 'function' ? [setTimeout(schedule, 120), setTimeout(schedule, 480)] : []
        return () => {
          if (frame !== 0) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
            if (typeof clearTimeout === 'function') clearTimeout(frame)
          }
          for (const timer of timers) clearTimeout(timer)
          if (observer !== null) observer.disconnect()
          if (remeasureFilePanes === schedule) remeasureFilePanes = null
          if (typeof window !== 'undefined') window.removeEventListener('resize', schedule)
          node.style.height = ''
        }
      }, [rootRef, path])
    }

    /**
     * The two glyphs on the document switch.
     *
     * Drawn here rather than borrowed from the icons chunk: they are 11px marks
     * that only make sense next to their word, and `stroke="currentColor"` lets
     * them follow the button's colour (muted → accent when selected) without a
     * second rule per state.
     */
    function PreviewGlyph () {
      return jsxs('svg', {
        width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        children: [
          jsx('path', { d: 'M1.4 8S3.7 3.6 8 3.6 14.6 8 14.6 8 12.3 12.4 8 12.4 1.4 8 1.4 8Z' }),
          jsx('circle', { cx: 8, cy: 8, r: 1.9 }),
        ],
      })
    }

    /** The `</>` mark for source mode: two chevrons and no slash (it crowds at 11px). */
    function SourceGlyph () {
      return jsx('svg', {
        width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        children: jsx('path', { d: 'M5.6 4.4 2.4 8l3.2 3.6M10.4 4.4 13.6 8l-3.2 3.6' }),
      })
    }

    function ConversationFileView (props) {
      const t = props.t
      const filePath = typeof props.filePath === 'string' ? props.filePath : ''
      const givenSessionId = typeof props.sessionId === 'string'
        ? props.sessionId
        : (typeof props.session?.id === 'string' ? props.session.id : '')
      const rootRef = React.useRef(null)
      const [hostSessionId, setHostSessionId] = React.useState('')
      const sessionId = givenSessionId !== '' ? givenSessionId : hostSessionId
      React.useEffect(() => {
        if (givenSessionId !== '' || hostSessionId !== '' || rootRef.current === null) return
        const host = rootRef.current.closest('[data-conversation-session]')
        const id = host?.getAttribute('data-conversation-session') ?? ''
        if (id !== '') setHostSessionId(id)
      }, [givenSessionId, hostSessionId])

      // The composer is a sticky seat UNDER the view area, not part of a view,
      // so it would otherwise stay on screen beneath an open file. Mount and
      // unmount are exactly "this file is the open view" — the host renders
      // only the active view — which makes this the one honest signal.
      React.useEffect(() => {
        mountedFileViews += 1
        applyComposerHiding()
        // The seat may be re-created a frame after the view mounts (a session
        // transition rebuilds the shell), which would drop the attribute and
        // bring the composer back under an open file.
        const frame = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(() => { applyComposerHiding() })
          : 0
        return () => {
          if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          mountedFileViews = Math.max(0, mountedFileViews - 1)
          applyComposerHiding()
        }
      }, [])

      // The host's own view switcher, kept in a module binding so the DOM-level
      // × on the tab can put the session back on Chat after the last close.
      const openView = props.openView
      React.useEffect(() => {
        if (typeof openView !== 'function') return undefined
        liveOpenView = openView
        return () => { if (liveOpenView === openView) liveOpenView = null }
      }, [openView])

      // Dirty state lives inside the editor. Publish it so the tab's × and Esc
      // can ask before dropping typed text — and keep a local copy so the
      // preview switch can refuse to hide unsaved work: the module-level map is
      // not reactive, and a button that never updates is worse than no button.
      const [dirty, setDirty] = React.useState(() => isFileDirty(sessionId, filePath))
      const onDirtyChange = React.useCallback((value) => {
        const next = value === true
        setDirty(next)
        setFileDirty(sessionId, filePath, next)
      }, [sessionId, filePath])

      // What this file IS decides how it opens: a document renders, a page gets
      // a sandboxed frame, media paints from the byte route, and a plain text
      // file opens at its source. The registry is the single answer.
      const [viewer, setViewer] = React.useState(() => viewerOf(filePath))
      const [sniffing, setSniffing] = React.useState(() => viewerOf(filePath) === 'unknown')
      React.useEffect(() => {
        const initial = viewerOf(filePath)
        if (initial !== 'unknown') {
          setViewer(initial)
          setSniffing(false)
          return undefined
        }
        let live = true
        setSniffing(true)
        probeFile(filePath, sessionId).then((kind) => {
          if (!live) return
          setViewer(kind)
          setSniffing(false)
        })
        return () => { live = false }
      }, [filePath, sessionId])
      const isDocument = viewer === 'markdown' || viewer === 'html'
      const isMedia = viewer === 'image' || viewer === 'video' || viewer === 'audio' || viewer === 'pdf'
      const [mode, setMode] = React.useState(() => (isDocument ? 'preview' : 'source'))
      const [modeNotice, setModeNotice] = React.useState('')
      const showPreview = isDocument && mode === 'preview'

      // Esc closes this tab, exactly like its ×. A modal dialog owns Escape
      // while it is open, and the editor's own find bar handles the key while
      // focus is inside it, so neither gesture is stolen here.
      const requestClose = React.useCallback(() => {
        if (isFileDirty(sessionId, filePath) && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (window.confirm(t('edit.unsavedPrompt')) !== true) return
        }
        closeFilePreview(filePath, sessionId)
      }, [filePath, sessionId, t])
      React.useEffect(() => {
        if (filePath === '') return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return
          if (document.activeElement !== null && document.activeElement.closest('.sshwsp-editor-panel') !== null) return
          requestClose()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [filePath, requestClose])

      // The footer belongs to the pane, so the pane must not be taller than the
      // space a view is given (see `useFilePaneHeight`).
      useFilePaneHeight(rootRef, filePath)

      if (filePath === '') return null

      // Two modes for a document, one for everything else. The switch reuses the
      // settings panel's segmented control (`sshwsp-seg`) in a thin bar above
      // the body — in flow, not floating over the text, so the pane still reads
      // as part of the conversation.
      //
      // A buffer with unsaved edits keeps the preview button alive but refuses
      // the switch and says why in the bar: the rendered view reads the file
      // from disk, so switching would show text that disagrees with the tab.
      const modes = isDocument
        ? jsxs('div', { className: 'sshwsp-filepane-bar', children: [
            modeNotice === ''
              ? null
              : jsx('span', { className: 'sshwsp-filepane-modehint', role: 'status', children: modeNotice }),
            jsx('div', { className: 'sshwsp-docmodes', role: 'group', 'aria-label': t('preview.modes'), children: [
              jsx('button', {
                type: 'button',
                className: 'sshwsp-docmode' + (mode === 'preview' ? ' sshwsp-docmode-on' : ''),
                'data-mode': 'preview',
                'aria-pressed': mode === 'preview' ? 'true' : 'false',
                'aria-disabled': dirty ? 'true' : undefined,
                title: dirty ? t('preview.dirtyBlocked') : t('preview.modePreviewHint'),
                onClick: () => {
                  if (dirty) {
                    setModeNotice(t('preview.dirtyBlocked'))
                    return
                  }
                  setModeNotice('')
                  setMode('preview')
                },
                children: [
                  jsx(PreviewGlyph, {}),
                  jsx('span', { children: t('preview.modePreview') }),
                ],
              }),
              jsx('button', {
                type: 'button',
                className: 'sshwsp-docmode' + (mode === 'source' ? ' sshwsp-docmode-on' : ''),
                'data-mode': 'source',
                'aria-pressed': mode === 'source' ? 'true' : 'false',
                title: t('preview.modeSourceHint'),
                onClick: () => {
                  setModeNotice('')
                  setMode('source')
                },
                children: [
                  jsx(SourceGlyph, {}),
                  jsx('span', { children: t('preview.modeSource') }),
                ],
              }),
            ] }),
          ] })
        : null

      return jsx('section', {
        ref: rootRef,
        className: 'sshwsp-filepane sshwsp-tokens',
        'data-sshwsp-filepane': '1',
        'data-sshwsp-mode': sniffing ? 'sniffing' : (isMedia ? viewer : (isDocument ? mode : 'source')),
        'data-sshwsp-viewer': viewer,
        'aria-label': t('preview.title'),
        children: [
          jsxs('div', { className: 'sshwsp-filepane-head', children: [
            jsx('span', {
              className: 'sshwsp-filepane-name',
              title: displayPathOf(filePath),
              children: fileTabName(filePath),
            }),
            jsx('button', {
              type: 'button',
              className: 'sshwsp-filepane-close',
              'aria-label': t('preview.tabClose'),
              title: t('preview.tabClose'),
              onClick: () => closeFilePreview(filePath, sessionId),
              children: '×',
            }),
          ] }),
          modes,
          jsx('div', { className: 'sshwsp-filepane-body', children:
            sniffing
              ? jsx('div', { className: 'sshwsp-filepane-note', role: 'status', children: t('preview.sniffing') })
              : viewer === 'binary'
                ? jsx(BinaryNote, { path: filePath, t })
                : isMedia
              ? jsx(MediaPreview, { path: filePath, sessionId, kind: viewer, t })
              : showPreview
                ? (viewer === 'html'
                    ? jsx(HtmlPreview, { path: filePath, sessionId, t })
                    : jsx(DocumentPreview, { path: filePath, sessionId, t }))
                : jsx(React.Suspense, { fallback: jsx('div', { className: 'sshwsp-filepane-note', role: 'status', children: t('preview.loading') }), children:
                    jsx(Editor, {
                      path: filePath,
                      sessionId,
                      t,
                      inline: true,
                      surface: 'conversation',
                      onClose: requestClose,
                      onDirtyChange,
                    }),
                  }),
          }),
        ],
      })
    }
      // The seat: one registered entry per open file, inside the declaration's
      // lifetime so a re-declared seat disposes exactly those entries.
      slots.inject('conversation.view', () => {
        registerFileTab = (path) => slots.register({
          name: 'conversation.view',
          id: fileTabIdOf(path),
          order: FILE_TAB_ORDER,
          label: () => fileTabName(path),
          inject: (sessionId) => ({ t: translate, filePath: path, sessionId }),
        }, ConversationFileView)
        const stopSessionWatch = watchConversationSession()
        return () => {
          stopSessionWatch()
          registerFileTab = null
          // The host has just disposed every entry registered inside this seat,
          // and a workspace switch re-declares the seat while the user is still
          // "in" the Session they left. Only the handles are dead — what was
          // open stays in `sessionOpenFiles`, so the next seat puts it back.
          deregisterFileTabs()
        }
      })

      return {
        open: openFilePreview,
        close: closeFilePreview,
        closeTab,
        closeTabs,
        pathOfTabLabel,
        applyPreferences,
        applyComposerHiding,
        isPreviewablePath,
        previewNameOf,
        probe: () => ({
          preferences: { ...fileViewPreferences },
          openFiles: [...openFileTabs.keys()],
          openSessions: [...sessionOpenFiles.entries()].map(([id, paths]) => [id, [...paths]]),
          registeredSession: registeredSessionId,
          dirtyFiles: [...dirtyFileTabs],
          lastClick: lastPreviewDecision,
          styles: styleEvidence(),
        }),
        release: releaseFileView,
      }
    }

    exports.installFileView = installFileView
    return module.exports
  },
})
