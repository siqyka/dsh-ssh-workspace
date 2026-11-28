window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createPortal } = require('react-dom')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')

    // =========================================================================
    // Map of this file
    // =========================================================================
    //
    // The bundle loads as one `window.__ModuleLoader__.load({ id, factory })`,
    // and what a page load actually needs is in it: the API table, and the
    // behaviour that must be installed at apply time — the file-tree bridges,
    // the composer bridge, the transfer-queue state machine. Everything that
    // only appears after a gesture does NOT live here, and neither does anything
    // that is data rather than behaviour.
    //
    // Those parts are sibling chunks the Host serves from the same directory,
    // fetched with `require.async('./client.<name>.js')`. Seven load at boot:
    //
    //   `client.kernel.js`         the stateless bottom layer
    //   `client.icons.js`          SVG glyph factories
    //   `client.locale.js`         dictionaries
    //   `client.styles.js`         CSS text
    //   `client.queue.js`          the queue's pure rules
    //   `client.selection.js`      the selection reducer
    //   `client.marks.js`          the workspace decoration
    //
    // An eighth, `client.fileview.js`, is fetched in `apply` itself (not on a
    // gesture): it carries the conversation's file view — tab registry, Session
    // roster, composer hiding, the rendered-document pane and the editor pane —
    // and the first click on a file can arrive before a lazy fetch would finish.
    //
    // The other six are resolved the first time a gesture needs one:
    // `client.dialogs.js` (the dialogs), `client.panel.js` (the dashboard),
    // `client.add-workspace.js`, `client.transfer-queue.js`, `client.history.js`
    // and `client.editor.js` (the file editor the view reuses).
    //
    // A chunk may register under this bundle's id, and `require('<this
    // package>')` from inside it returns THIS module's exports. Every name a
    // chunk borrows must be listed in the `Object.assign(exports, …)` block at
    // the bottom of this file; `tests/support/free-names.mjs` fails the suite
    // when one is missing, and `tests/client-chunk-smoke.mjs` proves the channel.
    //
    // What stays here, one section per responsibility, listed below. Every
    // section starts with the same `// ====` banner, so a jump-to-next-banner
    // walk visits them in order.
    //
    //   1. The stateless bottom layer, loaded in apply (all of it; in the chunk)
    //   2. Locale, loaded in apply (the bindings; the tables are in the chunk)
    //   3. Stylesheet, loaded in apply
    //   4. SVG Icons, loaded in apply
    //   5. Dialogs, loaded on demand (host editor / directory picker / report)
    //   6. Main panel, loaded on demand (the dashboard itself)
    //   7. Add-workspace flow, loaded on demand (the picker occupants)
    //   8. Panel icon (sidebar row glyph)
    //   9. Panel page wrapper
    //  10. Remote-workspace marks, loaded in apply (the decoration; the pass is in the chunk)
    //  11. Composer file bridge (drag / right-click → @ reference)
    //  12. Transfer queue (batch uploads, progress overlay, cancellation)
    //  13. Transfers from DSH's own file tree (row rename / delete)
    //  14. File-panel header actions
    //  15. Host file tree: Windows-style multi-select
    //  16. Change-request tab: recent commit history
    //  17. Preview in conversation (the file view tab; the view itself is in the chunk)
    //  18. Plugin apply
    //
    // Sections 1-4 and 10, 12 are stubs: their names are `let` bindings filled
    // by `loadBootChunks()`, and the definitions live in a chunk. Sections 5-7
    // are stubs the same way (lazy binding, boundary, exports). The components
    // and tables live in their chunks, which carry their own banners.
    //
    // No line numbers: editing the map shifts every number below it, so a map
    // that carries them is stale the moment it is corrected. Search the banner
    // title instead.
    //
    // The map is CHECKED by `scripts/client-map.mjs` (also reported in
    // `client-shape-smoke`): entries and banners must agree in content and
    // order, and a banner with no code is a mismatch too. A comment cannot
    // fail; this makes the map wrong only while the suite is red.
    //
    // =========================================================================

    // =========================================================================
    // The stateless bottom layer, loaded in apply
    // =========================================================================
    //
    // This was the file's most-used half and its least interesting one: the API
    // table, the DOM readers, the pickers, the uploader, the reducers' wiring. It
    // now lives in `client.kernel.js`, and the boundary was measured rather than
    // chosen — see the doc comment there for the rule. What is left below is the
    // interactive layer: the bridges `apply` installs, the queue store and its
    // workers, the row-action handles, `apply` itself.
    //
    // The seam runs ONE way. The chunk borrows nothing from this file; this file
    // takes 117 names back, filled in by `loadBootChunks()` before a single
    // slot is registered. The stand-ins below exist only to keep this module
    // valid until then.
    const kernelModule = () => require.async('./client.kernel.js')
    let API = undefined

    let BROWSE_LIST_LIMIT = undefined
    let COMPOSER_CARD_SELECTOR = undefined

    let DELETE_COUNT_LIMIT = undefined
    let DRAG_MIME = undefined
    let FLOW_MENU_WIDTH = undefined

    let FLOW_MENU_WIDTH_ROOMY = undefined
    let FLOW_PRIORITY = undefined

    let FORGE_TAB_GRACE_MS = undefined
    let FORGE_TAB_KEY = undefined
    let FORGE_TAB_SHADOW_PRIORITY = undefined
    let MENU_GLYPH_PATHS = undefined
    let OS_TREE_SELECTOR = undefined
    let PANEL_ID = undefined
    let PANEL_ORDER = undefined
    let PATH_PREVIEW_DEBOUNCE_MS = undefined
    let TASK_MENU_ATTR = undefined
    let TOAST_DISMISS_MS = undefined
    let TREE_BODY_SELECTOR = undefined
    let TREE_ROW_SELECTOR = undefined
    let absentForgeHook = undefined
    let applyTreeSelection = undefined
    let backdropDismiss = undefined
    let blankMenuScopeOf = undefined
    let capabilityNotes = undefined
    let childDirectoryPath = undefined

    let clearOsDropHighlight = undefined

    let clearTreeTextSelection = undefined
    let countDeleteContents = undefined

    let createMenuSeparator = undefined
    let createSessionCatchUp = undefined
    let directoryDraft = undefined
    let directoryPath = undefined
    let draftDirectoryTarget = undefined

    let dropFolderNames = undefined

    let dropOffsetFromEvent = undefined
    let dropPointFromEvent = undefined

    let entryNameOf = undefined
    let fetchJson = undefined
    let fetchReportText = undefined
    let filesTransferOf = undefined

    let firstClaim = undefined
    let focusSoleComposer = undefined

    let focusTreeCursor = undefined
    let focusableWithin = undefined

    let focusedElement = undefined
    let forgeFaceOf = undefined
    let forgeHookCache = undefined
    let formatBytes = undefined
    let hasSlotTabHook = undefined

    let hideDropCaret = undefined

    let identity = undefined

    let isForgeTabEntry = undefined
    let isNetworkFailure = undefined
    let isUsableForgeSplit = undefined

    let joinLocalPath = undefined
    let localBlankTargetOf = undefined
    let makeLocalPicker = undefined
    let mentionToken = undefined
    let modalLayer = undefined
    let mutationPolicyOf = undefined
    let narrowDirectoryEntries = undefined
    let sortPickerEntries = undefined
    let nextMenuIndex = undefined

    let normalizeRoot = undefined
    let officialTranslateSeat = undefined
    let osDropPlan = undefined
    let pickDirTarget = undefined
    let pickFileTarget = undefined
    let pickLocalFiles = undefined
    let postFileInChunks = undefined
    let postUploadChunk = undefined

    let randomHexId = undefined

    let readComposerRoot = undefined
    let readResponseBlob = undefined

    let referenceFor = undefined
    let refreshFilesPanel = undefined

    let rememberTreeSelection = undefined

    let remoteDirOf = undefined
    let remoteTargetOf = undefined

    let renameAnchorOf = undefined
    let requestJson = undefined
    let resolveBrowseFlow = undefined

    let resolveComposerTarget = undefined
    let resolveTargets = undefined
    let resolveTreeAnchor = undefined

    let responseErrorText = undefined
    let rowOfPath = undefined

    let rowReferenceKind = undefined
    let saveViaAnchor = undefined

    let selectToastDetail = undefined

    let setOsDropHighlight = undefined

    let showDropCaret = undefined
    let splitDroppedFolders = undefined
    let splitForgeFace = undefined
    let streamIntoHandle = undefined
    let subscribeTransferActionsSlot = undefined
    let subscribeTransferQueue = undefined
    let toastActionOf = undefined
    let toastCopyText = undefined

    let toastError = undefined
    let toastModel = undefined
    let transferActionsSlotListeners = undefined

    let transferCancelledError = undefined

    let transferPausedError = undefined
    let transferQueueListeners = undefined

    let transferQueueWorkers = undefined

    let treeAnchorPath = undefined

    let treeContainerOf = undefined

    let treeRootOf = undefined
    let treeRootOfContainer = undefined

    let treeRowModel = undefined

    let treeRowSelectable = undefined
    let treeScopeKeyOf = undefined

    let treeSelectableRows = undefined

    let treeSelectedItems = undefined

    let treeSelectionContainers = undefined
    let treeSelectionScopes = undefined

    let treeSelectionStates = undefined
    let treeSessionOfContainer = undefined
    // =========================================================================
    // Locale, loaded in apply
    // =========================================================================
    const localeModule = () => require.async('./client.locale.js')
    let NS = 'dsh-ssh-workspace'
    let zh = {}
    let en = {}
    let applyParams = (text) => text
    let makeTranslate = () => (key) => key
    let relativeTimeText = () => ''
    let provenanceText = () => undefined

    // =========================================================================
    // Stylesheet, loaded in apply
    // =========================================================================
    // 529 lines of CSS text. This is the one chunk that may not be deferred to
    // a gesture: a panel that draws before its rules arrive flashes unstyled,
    // so `apply` awaits it before registering anything.
    const stylesModule = () => require.async('./client.styles.js')
    let injectStyles = () => {}

    // =========================================================================
    // SVG Icons, loaded in apply
    // =========================================================================
    // Fifteen pure React glyph factories in `client.icons.js`, awaited in
    // `apply` because three readers here are not deferred: the sidebar row's
    // glyph, the file-tree DOM menu (via TRAY_ARROW_PATHS), and the
    // remote-workspace decoration that runs the moment a workspace appears.
    const iconsModule = () => require.async('./client.icons.js')
    let REMOTE_MARK_VIEWBOX = ''
    let RemoteMarkIcon = () => null
    let ServerIcon = () => null
    let FolderIcon = () => null
    let FileIcon = () => null
    let GlobeIcon = () => null
    let ArrowLeftIcon = () => null
    let CloseIcon = () => null
    let PauseIcon = () => null
    let PlayIcon = () => null
    let RefreshIcon = () => null
    let ChevronIcon = () => null
    let TRAY_BASE_PATH = ''
    let TRAY_ARROW_PATHS = {}
    let DownloadIcon = () => null
    let UploadIcon = () => null
    let TransferProgressIcon = () => null

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
    // Dialogs, loaded on demand
    // =========================================================================
    // The host editor, the directory picker and the diagnostic report are
    // 698 lines that only exist once a user opens one. They live in
    // `client.dialogs.js`, fetched the first time a dialog is asked for.
    //
    // `require.async` resolves a sibling chunk through the Host module system,
    // and `require('@shiqyka/dsh-ssh-workspace')` from inside that chunk returns
    // THIS module's exports — which is why the kernel declarations these
    // components need (API, the icons, useDialogA11y, modalLayer,
    // backdropDismiss, capabilityNotes) are exported at the bottom of this file.
    // That channel is proven, not assumed: see tests/client-chunk-smoke.mjs.
    //
    // The second argument to `.then` is load-bearing. A lazy component whose
    // chunk fails to arrive rejects, and a rejection with no boundary takes the
    // whole panel down — the file tree, the transfer queue, everything. The
    // fallback renders nothing, so a missing chunk costs the dialog and not the
    // panel.
    const dialogsModule = () => require.async('./client.dialogs.js')
    const lazyDialog = (name) => React.lazy(async () => {
      const loaded = await dialogsModule()
      return { default: loaded[name] }
    })

    /** Render a dialog, or nothing while its chunk is arriving (or after it failed). */
    function DialogSlot ({ component: Component, ...props }) {
      return jsx(React.Suspense, { fallback: null, children: jsx(Component, props) })
    }

    const HostEditor = lazyDialog('HostEditor')
    const DirectoryBrowser = lazyDialog('DirectoryBrowser')
    const HostPowerDialog = lazyDialog('HostPowerDialog')
    const ReportDialog = lazyDialog('ReportDialog')

    // The picker's pure path helpers live in `client.kernel.js` (boot-loaded).
    // The panel's preview and the add-workspace flow call them during render,
    // so they must be real values before a dialog chunk arrives; the dialog
    // chunk imports that one set rather than carrying a second copy.

    /**
     * How long a pause in typing must last before a picker re-lists a directory.
     *
     * Every re-list is an SFTP round trip to a host that may be continents away.
     * A filter INSIDE the directory already shown costs nothing (see
     * `draftDirectoryTarget`), so this delay only applies to the keystrokes that
     * change WHICH directory is listed — a `/`, or a backspace over one.
     */
    function usePathDraftPreview ({ draft, currentDir, listing, loadDir }) {
      const [fragment, setFragment] = React.useState('')
      React.useEffect(() => {
        const target = draftDirectoryTarget(draft, currentDir)
        if (target === null) {
          setFragment('')
          return undefined
        }
        // Same directory: nothing to ask, just narrow what is here. A settled
        // draft (the directory with its trailing slash) lands here with an empty
        // fragment, which is why navigating with the list does not re-list.
        //
        // A fragment that happens to spell an existing name is NOT entered
        // here. Typing `/home/me/projects` narrows the parent to that one row;
        // going inside is an explicit gesture — a trailing `/`, Enter, or a
        // double click. Entering on an exact match made the slash meaningless:
        // the list jumped into the directory the moment the last letter was
        // typed, so the user never got to see the parent filtered.
        if (!target.refresh) {
          setFragment(target.fragment)
          return undefined
        }
        // Another directory. Wait for the pause, then ask once; the answer sets
        // `currentDir`, which re-runs this effect with the new directory.
        const timer = setTimeout(() => {
          loadDir(target.dir, { preview: true })
        }, PATH_PREVIEW_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [draft, currentDir, listing, loadDir])
      return fragment
    }

    /**
     * Advisory notes for a capability probe result.
     *
     * Mirrors the tool-side wording: a capability the probe could not
     * determine is omitted rather than reported as missing.
     */
    // =========================================================================
    // Main panel, loaded on demand
    // =========================================================================
    const panelModule = () => require.async('./client.panel.js')
    const LazyRemoteWorkspacePanel = React.lazy(async () => {
      const loaded = await panelModule()
      return { default: loaded.RemoteWorkspacePanel }
    })

    /** The `main` slot occupant: the panel, or nothing until its chunk arrives. */
    function PanelSlot (props) {
      return jsx(React.Suspense, { fallback: null, children: jsx(LazyRemoteWorkspacePanel, props) })
    }

    // =========================================================================
    // Add-workspace flow, loaded on demand (the picker occupants)
    // =========================================================================
    let lastTriggerRect = null

    function trackTriggerRects () {
      if (typeof document === 'undefined') return () => {}
      const onMouseDown = (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const button = target.closest('button')
        if (button === null) return
        const rect = button.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return
        lastTriggerRect = { left: rect.left, right: rect.right, top: rect.top, at: Date.now() }
      }
      document.addEventListener('mousedown', onMouseDown, true)
      // Returned, because a document-level listener is not owned by any
      // ctx.effect: without this, every hot reload / re-apply stacked another
      // capture listener and every mousedown ran all of them.
      return () => document.removeEventListener('mousedown', onMouseDown, true)
    }
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

    /**
     * The add-workspace flow, fetched the first time a picker opens.
     *
     * The workspace picker renders its directoryFlow hole unconditionally, and
     * the occupant answers `null` while it is closed — so the chunk must NOT be
     * fetched to render that `null`. `FlowSlot` returns it directly, and only
     * mounts the lazy component (with the Suspense boundary a lazy chunk needs)
     * once `open` is true.
     */
    const addWorkspaceModule = () => require.async('./client.add-workspace.js')
    const LazyAddWorkspaceFlow = React.lazy(async () => {
      const loaded = await addWorkspaceModule()
      return { default: loaded.AddWorkspaceFlow }
    })

    function FlowSlot (props) {
      if (props.open !== true) return null
      return jsx(React.Suspense, { fallback: null, children: jsx(LazyAddWorkspaceFlow, props) })
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
        jsx(PanelSlot, { t: translate, ctx }),
      })
    }

    // =========================================================================
    // Remote-workspace marks, loaded in apply
    // =========================================================================
    //
    // The whole decoration (446 lines: the live-workspace identity sets, the
    // glyph swap, the detached-row dimming, the MutationObserver) lives in
    // `client.marks.js`. It is a boot chunk rather than a lazy one because
    // `installRemoteWorkspaceMarks` must be observing before the first paint —
    // decoration that arrives on the second frame is a visible flicker.
    const marksModule = () => require.async('./client.marks.js')
    let installRemoteWorkspaceMarks = () => {}
    let refreshRemoteWorkspaceMarks = async () => {}
    let syncRemoteWorkspaceMarks = () => {}
    // Declared rather than left to the assignment below: an implicit global is
    // one strict-mode host away from a `ReferenceError` at boot, and
    // `republishBootNames` reads this name too.
    let scheduleRemoteMarks = () => {}
    /** Which alias a session's workspace lives on (see the marks chunk). */
    let aliasOfSession = () => ''

    // =========================================================================
    // Composer file bridge (drag / right-click → @ reference)
    // =========================================================================
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
     * @returns {string} copyable text, empty when there is nothing to say.
     */
    /** A translated toast label, or the key itself outside the app shell. */
    function toastLabel (key) {
      try {
        return typeof translate === 'function' ? translate(key) : key
      } catch {
        return key
      }
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

    // ---- selection state machine, loaded in apply
    //
    // The reducer and its four helpers live in `client.selection.js`: no DOM,
    // no clock, no `translate`, so it borrows nothing. The tree wiring below
    // (WeakMaps keyed by container, captured-click suppression, the keyboard
    // handler) stays here — that is what knows WHEN a gesture happened.
    const selectionModule = () => require.async('./client.selection.js')
    let SELECTION_EMPTY = Object.freeze({ ids: Object.freeze([]), anchor: null, cursor: null, navigate: null })
    let selectionRange = (rows, from, to) => []
    let selectReduce = (state) => state

    // ---- queue state machine, loaded in apply
    //
    // 532 lines of pure reducer: no clock, no DOM, no `fetch`, no translation.
    // `apply` awaits it with the other boot chunks, BEFORE any slot is
    // registered, because the popover and the Files-panel action bar both call
    // these rules the moment a transfer starts.
    const queueModule = () => require.async('./client.queue.js')
    let TRANSFER_QUEUE_LIMIT_TOTAL = 2
    let TRANSFER_QUEUE_LIMIT_PER_HOST = 1
    let TRANSFER_QUEUE_UPLOAD_LIMIT = 1024 * 1024 * 1024
    let queueReduce = () => ({ items: [] })
    let queueDrain = () => []
    let queueItemPercent = () => null
    let orderedTransferQueueItems = (items) => items
    let transferQueueActiveCount = () => 0
    let transferQueueIsTerminal = () => false
    let transferQueueNextSpeed = (item) => item
    let transferQueueProgress = (items) => ({ direction: null, percent: null, live: false, done: 0, total: 0 })
    let truncateTransferName = (name) => name
    let splitOversizeFiles = (files) => ({ accepted: files, rejected: [] })

    // ---- queue runtime (clock, workers, notices, subscriptions)

    /** The one store. Replaced wholesale, so a snapshot reference is stable. */
    let transferQueueState = { items: [] }
    let transferQueueSeq = 0
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
     */
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
     * @param {string} [opening] - the caller's own opening sentence.
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
    /** The one-sentence refusal for files the picker should not have accepted. */
    function oversizeTransferText (rejected) {
      return translate('queue.oversize', {
        limit: formatBytes(TRANSFER_QUEUE_UPLOAD_LIMIT),
        names: rejected.map(file => (file?.name ?? '?')).join(', '),
      })
    }
    // ---- the popover, loaded on demand
    //
    // The popover that paints the queue is 174 lines that exist only while it is
    // open. The QUEUE ITSELF stays here: `FilePanelTransferActions` subscribes to
    // it from the Files panel, and a store living in a chunk would not exist
    // before that chunk arrived.
    const TransferQueuePanel = React.lazy(async () => {
      const loaded = await require.async('./client.transfer-queue.js')
      return { default: loaded.TransferQueuePanel }
    })

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
    function transferActionsSlotSnapshot () {
      return transferActionsSlotState
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
     * @returns {boolean} true when nothing came back over the wire.
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

    /** The same one-segment rule, worded for the create prompts. */
    function entryNameRefusal (name) {
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
     * @returns {Promise<string|null>} `read-only`, another mode, or null.
     */
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
     */
    function inlineRenameDecision (original, typed) {
      const name = typeof typed === 'string' ? typed.trim() : ''
      if (name === '' || name === original) return 'cancel'
      return localNameRefusal(name) === undefined ? 'commit' : 'refuse'
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
          const refusal = entryNameRefusal(name)
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
     * The new-file prompt.
     *
     * Deliberately a twin of `requestRowNewFolder`, not a generalization of it:
     * the two routes answer different questions (a file is created empty and
     * gets a 409 on collision; a directory is created empty too, but the
     * server-side verb, the error copy and the success notice all differ), and
     * a shared "create something" dialog would have to carry a `kind` through
     * every string. The parent is the directory row that opened the menu; the
     * server still re-validates every rule at the route boundary.
     */
    function requestRowNewFile (request) {
      const input = document.createElement('input')
      input.className = 'sshwsp-input'
      input.type = 'text'
      input.placeholder = translate('rowmenu.newFile')
      input.setAttribute('aria-label', translate('rowmenu.newFile'))
      input.spellcheck = false
      const hint = document.createElement('div')
      hint.className = 'sshwsp-field-hint'
      hint.textContent = translate('rowmenu.newFileHint')
      const layer = openRowActionDialog({
        title: translate('rowmenu.newFileTitle'),
        submitLabel: translate('rowmenu.newFile'),
        busyLabel: translate('rowmenu.creatingFile'),
        focusNode: input,
        buildBody: () => {
          const stack = document.createElement('div')
          stack.className = 'sshwsp-field'
          stack.append(input, hint)
          return stack
        },
        onSubmit: async () => {
          const name = input.value
          const refusal = entryNameRefusal(name)
          if (refusal !== undefined) return refusal
          let data
          try {
            data = await fetchJson(API.createFile, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: request.path, name, root: request.root ?? undefined, sessionId: request.sessionId ?? undefined }),
            })
          } catch (err) {
            return describeNewFileFailure(err)
          }
          refreshFilesPanel()
          selectCreatedRow(data?.path, request)
          notifyUser(translate('rowmenu.fileCreated'), 'ok')
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

    /** Turn a create-file failure into a sentence a user can act on. */
    function describeNewFileFailure (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/already exists|EEXIST/u.test(message)) return translate('rowmenu.targetExists')
      return `${translate('rowmenu.createFileFail')}: ${message}`
    }

    /** Turn a rename failure into a sentence a user can act on. */
    function describeRenameFailure (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/already exists|EEXIST/u.test(message)) return translate('rowmenu.targetExists')
      return `${translate('rowmenu.renameFail')}: ${message}`
    }
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
        queueOpen && jsx(React.Suspense, {
          fallback: null,
          children: jsx(TransferQueuePanel, { anchor, onClose: () => setQueueOpen(false), t }),
        }),
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
     * Every mark a row menu can name, as one table, in the precedence the
     * drawing lookup uses: the tray pair wins over a verb mark of the same name.
     *
     * Naming the union once is what keeps every mark one name away from its
     * paths. The renderer falls back to `file` for a name it does not know,
     * which is what made a forgotten verb look plausible instead of broken: it
     * drew a file mark where a download arrow belonged. `download` and `upload` lived only in
     * `TRAY_ARROW_PATHS`, which is exactly how that gap shipped.
     */
    function menuGlyphTable () {
      return { ...MENU_GLYPH_PATHS, ...TRAY_ARROW_PATHS }
    }
    /**
     * One distinct mark per row-menu verb, drawn on the same 16-unit grid.
     *
     * The icon column is scanned before the labels, so one file/folder mark
     * shared by add, copy, rename and delete made four different actions look
     * alike. Transfers keep the shared tray (TRAY_ARROW_PATHS); these verbs get
     * outlines of their own. `file` remains the fallback for an unnamed kind.
     */
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
      const paths = menuGlyphTable()[kind] ?? MENU_GLYPH_PATHS.file
      for (const d of paths) {
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', d)
        svg.appendChild(path)
      }
      return svg
    }
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
     * The row-menu verbs a session's write policy can disable.
     *
     * One list, because the model and the late DOM pass gate the same four; two
     * lists would drift the day a fifth destructive verb arrives.
     */
    const POLICY_GATED_ROW_IDS = ['new-file', 'new-folder', 'rename', 'delete']

    /**
     * Why a write verb is unavailable, or `null` when it is available.
     *
     * `policy === null` means "not answered yet": the menu is built enabled and
     * a late pass disables it. That is what keeps opening the menu off the
     * network — the model itself never asks.
     *
     * @param {{readOnly?: boolean, sessionFound?: boolean} | null | undefined} policy
     * @param {boolean} localPath - the target is a local path, not a remote one.
     * @returns {{disabled: boolean, reason: string} | null}
     */
    function policyGate (policy, localPath) {
      if (policy === null || policy === undefined) return null
      if (policy.readOnly === true) {
        // The same boolean covers two causes; saying "read-only session" for a
        // mode the server could not read would send the user to a mode switch
        // that cannot help.
        return {
          disabled: true,
          reason: translate(policy.readOnlyReason === 'unrecognised-mode' ? 'rowmenu.unrecognisedMode' : 'rowmenu.readonly'),
        }
      }
      if (localPath && policy.sessionFound !== true) return { disabled: true, reason: translate('rowmenu.localRootUnknown') }
      return null
    }

    /**
     * The row menu as data: what to show, in what order, and what each item does.
     *
     * Rendering is a separate decision — `renderMenuDom`, and only that — so
     * this function touches no DOM and starts no request. `run` is the action as
     * the open path invokes it.
     *
     * @param {object} input
     * @param {object} input.ctx
     * @param {string} input.absPath
     * @param {boolean} input.isDir
     * @param {string} input.root
     * @param {string} input.sessionId
     * @param {{items?: object[]} | null} [input.selection]
     * @param {{readOnly?: boolean, sessionFound?: boolean} | null} [input.policy]
     * @returns {object[]} descriptors: { id, label, glyph, disabled, reason, danger, separatorBefore, run }
     */
    function rowMenuModel ({ ctx, absPath, isDir, root, sessionId, selection, policy = null }) {
      const clickedRow = { path: absPath, name: entryNameOf(absPath), isDir }
      const targets = resolveTargets(clickedRow, selection?.items).targets
      const addable = targets.some(item => mentionToken(item.path, root, item.isDir) !== null)
      const remote = remoteTargetOf(absPath)
      const downloadable = targets.filter(item => remoteTargetOf(item.path) !== null)
      const gate = policyGate(policy, remote === null)
      const gated = (entry) => (gate === null ? entry : { ...entry, disabled: true, reason: gate.reason })
      const items = [
        {
          id: 'add-to-task',
          label: translate('mention.addToTask'),
          glyph: 'addToTask',
          disabled: !addable,
          reason: addable ? '' : translate('mention.unrepresentable'),
          run: () => addPathsToTask(ctx, targets, root),
        },
        {
          id: 'download',
          label: translate('transfer.download'),
          glyph: 'download',
          disabled: downloadable.length === 0,
          reason: downloadable.length === 0 ? translate('transfer.notRemote') : '',
          separatorBefore: true,
          run: () => { void downloadRows(downloadable, ctx) },
        },
      ]
      if (remote !== null) {
        items.push({
          id: 'upload',
          label: translate('transfer.upload'),
          glyph: 'upload',
          reason: `${isDir ? absPath : remoteDirOf(absPath)} · ${translate('queue.overwrite')}`,
          run: () => uploadTreeRow(absPath, isDir),
        })
        items.push({
          id: 'copy-path',
          label: translate('rowmenu.copyPath'),
          glyph: 'copy',
          reason: absPath,
          run: () => { void copyRowPath(absPath) },
        })
      }
      const destructive = []
      if (remote !== null && isDir) {
        destructive.push(gated({
          id: 'new-file',
          label: translate('rowmenu.newFile'),
          glyph: 'newFile',
          run: () => requestRowNewFile({ path: absPath, root, sessionId, row: rowOfPath(absPath) }),
        }))
        destructive.push(gated({
          id: 'new-folder',
          label: translate('rowmenu.newFolder'),
          glyph: 'newFolder',
          run: () => requestRowNewFolder({ path: absPath, root, sessionId, row: rowOfPath(absPath) }),
        }))
      }
      destructive.push(gated({
        id: 'rename',
        label: translate('rowmenu.rename'),
        glyph: 'rename',
        run: () => requestRowRename({ path: absPath, name: entryNameOf(absPath), root, sessionId, row: rowOfPath(absPath) }),
      }))
      destructive.push(gated({
        id: 'delete',
        label: translate('rowmenu.delete'),
        glyph: 'delete',
        danger: true,
        // The whole resolved target set, not one path: the confirmation names the
        // count, the kind and the subtree, and this model has already decided
        // which rows that is.
        run: () => { void requestRowDelete({ items: targets, root, sessionId }) },
      }))
      destructive[0].separatorBefore = true
      return [...items, ...destructive]
    }

    /**
     * The blank-area menu as data: new file, new folder, copy path.
     *
     * `target` is what the empty row stands for — a directory, its root, and the
     * session that owns it — so the renderers never have to read the DOM back.
     *
     * @param {object} input
     * @param {{dir: string, root: string, sessionId: string, container: object|null}} input.target
     * @param {{readOnly?: boolean, sessionFound?: boolean} | null} [input.policy]
     * @returns {object[]} descriptors, same shape as `rowMenuModel`.
     */
    function blankMenuModel ({ target, policy = null }) {
      const { dir, root, sessionId, container } = target
      const gate = policyGate(policy, true)
      const gated = (entry) => (gate === null ? entry : { ...entry, disabled: true, reason: gate.reason })
      return [
        gated({
          id: 'new-file',
          label: translate('rowmenu.newFile'),
          glyph: 'newFile',
          run: () => requestRowNewFile({ path: dir, root, sessionId, row: null, container }),
        }),
        gated({
          id: 'new-folder',
          label: translate('rowmenu.newFolder'),
          glyph: 'newFolder',
          run: () => requestRowNewFolder({ path: dir, root, sessionId, row: null, container }),
        }),
        {
          id: 'copy-path',
          label: translate('rowmenu.copyPath'),
          glyph: 'copy',
          reason: dir,
          run: () => { void copyRowPath(dir) },
        },
      ]
    }

    /**
     * Draw a menu model with the plugin's own floating menu.
     *
     * The elements are returned by descriptor id so a late policy answer can
     * disable the gated ones in place, without rebuilding the menu under the
     * pointer.
     *
     * @param {object[]} model
     * @param {number} x
     * @param {number} y
     * @returns {{el: HTMLElement, nodes: Map<string, HTMLElement>}}
     */
    function renderMenuDom (model, x, y) {
      const nodes = new Map()
      const el = openMenuAt(x, y, (menu) => {
        for (const entry of model) {
          if (entry.separatorBefore === true) menu.appendChild(createMenuSeparator())
          const node = createTransferItem({
            label: entry.label,
            glyph: entry.glyph,
            disabled: entry.disabled === true,
            reason: entry.reason,
            onSelect: entry.run,
          })
          nodes.set(entry.id, node)
          menu.appendChild(node)
        }
      })
      return { el, nodes }
    }

    /** The attribute the HOST draws on its own menu element. */
    const CONTEXT_MENU_ATTR = 'data-context-menu'
    /** How long a mutation-policy answer is trusted, in milliseconds. */
    const POLICY_TTL_MS = 30_000

    /**
     * The mutation-policy answers already known, newest per session and root.
     *
     * The host's `resolve` has a one-second budget and `mutationPolicyOf` is a
     * round trip, so a menu that waited for it would either miss the budget or
     * open late. A stale entry is still better than none: the server refuses
     * the write either way, and the answer refreshes on the next open.
     */
    const policyCache = new Map()

    /**
     * How many answers the cache keeps.
     *
     * Nothing here is expensive to rebuild — one round trip — so the cap exists
     * only to keep a long session from accumulating a key per workspace it ever
     * opened a menu in.
     */
    const POLICY_CACHE_MAX = 32

    /**
     * Answers in flight, keyed like the cache.
     *
     * The cache is written when the answer lands, so three quick right-clicks in
     * the same second used to be three requests: every open in between missed.
     */
    const policyPending = new Map()

    /** @param {{sessionId?: string, root?: string} | null | undefined} claim */
    function policyKeyOf (claim) {
      if (claim === null || claim === undefined) return null
      // A claim that names no session is still cacheable: the server resolves it
      // by root, and one that names neither resolves to NO session — an answer
      // that is the same for every caller. Keying it on the empty id used to
      // mean the local blank menu asked again on every open.
      const sessionId = typeof claim.sessionId === 'string' ? claim.sessionId : ''
      const root = typeof claim.root === 'string' ? claim.root : ''
      return `${sessionId}|${root}`
    }

    /**
     * The cached answer, or `null` when there is none (or it has expired).
     *
     * @param {{sessionId?: string, root?: string} | null | undefined} claim
     * @returns {object | null}
     */
    function cachedPolicyOf (claim) {
      const key = policyKeyOf(claim)
      if (key === null) return null
      const hit = policyCache.get(key)
      if (hit === undefined) return null
      if (Date.now() - hit.at > POLICY_TTL_MS) {
        policyCache.delete(key)
        return null
      }
      // Re-insert with the ORIGINAL timestamp: the map is a true LRU (a hit
      // must move to the warm end, or the "oldest first" eviction below removes
      // the entry that was just used), but the TTL stays absolute — refreshing
      // `at` here would let a frequently opened menu keep one stale answer
      // alive forever.
      policyCache.delete(key)
      policyCache.set(key, hit)
      return hit.policy
    }

    /**
     * The write policy for one session, from the cache when it is fresh.
     *
     * A failed lookup is NOT cached: a host that could not answer once may
     * answer now, and the enabled item plus the server's refusal is the honest
     * fallback.
     *
     * @param {{sessionId?: string, root?: string}} claim
     * @returns {Promise<object | null>}
     */
    function policyOf (claim) {
      const cached = cachedPolicyOf(claim)
      if (cached !== null) return Promise.resolve(cached)
      const key = policyKeyOf(claim)
      const inFlight = key === null ? undefined : policyPending.get(key)
      if (inFlight !== undefined) return inFlight
      const run = mutationPolicyOf(claim).then((policy) => {
        if (policy !== null && key !== null) {
          // Oldest first: `Map` iterates in insertion order, and every hit is
          // re-inserted below, so the head is the coldest entry.
          if (policyCache.size >= POLICY_CACHE_MAX) {
            const oldest = policyCache.keys().next()
            if (oldest.done !== true) policyCache.delete(oldest.value)
          }
          policyCache.delete(key)
          policyCache.set(key, { policy, at: Date.now() })
        }
        return policy
      }).finally(() => {
        // Only if this run is still the one in flight: a newer claim for the
        // same key must not have its entry dropped by a settling older one.
        if (key !== null && policyPending.get(key) === run) policyPending.delete(key)
      })
      if (key !== null) policyPending.set(key, run)
      return run
    }

    /**
     * Draw the tree menu.
     *
     * ONE renderer, and it is this plugin's. The host publishes a context-menu
     * service (`ctx.contextMenus`) and an earlier revision handed it the model,
     * which made a menu this plugin owns look like a host menu: right-clicking a
     * file in a LOCAL workspace answered with the host's chrome while the same
     * gesture in a remote one looked like the rest of the plugin. The model is
     * the same either way; the drawing is not, and two looks for one gesture is
     * the inconsistency this removes.
     *
     * @returns {{el: HTMLElement, nodes: Map<string, HTMLElement>}} the drawn
     *   nodes, keyed by descriptor id so the policy pass can disable them.
     */
    function openTreeMenu (model, x, y) {
      return renderMenuDom(model, x, y)
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
      el.style.top = `${Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 120))}px`
      if (typeof fill === 'function') fill(el)
      document.body.appendChild(el)
      // The sheet sizes to its content (the Host's own menu does), so the clamp
      // reads the mounted element: the old fixed FLOW_MENU_WIDTH would slide a
      // 360px menu past the right edge and pull a 144px one too far left. The
      // entry animation only translates Y, so measuring here is not measuring
      // mid-transform, and a zero width (a sheet the browser has not laid out)
      // falls back to the constant rather than pinning the menu at the edge.
      const sheetWidth = el.getBoundingClientRect().width
      const room = window.innerWidth - (sheetWidth > 0 ? sheetWidth : FLOW_MENU_WIDTH) - 8
      el.style.left = `${Math.min(Math.max(8, x), Math.max(8, room))}px`
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
      const claim = { sessionId, root }
      const model = rowMenuModel({ ctx, absPath, isDir, root, sessionId, selection })
      const drawn = openTreeMenu(model, x, y)
      // The mode is asked for asynchronously, and the items are DISABLED when it
      // turns out to be read-only: offering an action and then refusing it on
      // click is not "disabled", it is "broke". A lookup that fails leaves them
      // enabled; the server's refusal is still the boundary.
      void policyOf(claim).then(policy => {
        const gate = policyGate(policy, remoteTargetOf(absPath) === null)
        if (gate === null) return
        for (const id of POLICY_GATED_ROW_IDS) {
          const node = drawn.nodes.get(id)
          if (node === undefined) continue
          node.disabled = true
          node.title = gate.reason
        }
      })
    }
    /**
     * The local blank-space menu: create a file, create a folder, or copy the
     * directory path.
     *
     * The target is the directory the empty space belongs to, already resolved
     * and fenced by `localBlankTargetOf`. This menu is deliberately not the row
     * menu: no upload, download, rename, delete or add-to-task items. Both
     * creation entries ask the same shared dialog and go through the same local
     * branch of their route; neither is offered on a local ROW, where the host
     * tree owns local creation.
     */
    function openLocalBlankMenu (ctx, target, x, y) {
      const { sessionId, root } = target
      const model = blankMenuModel({ target })
      const drawn = openTreeMenu(model, x, y)
      // Only CREATION is gated. The policy lookup is fire-and-forget so opening
      // the menu never waits on a request; a failed lookup leaves the items
      // enabled, and the server's refusal is still the boundary.
      void policyOf({ sessionId, root }).then(policy => {
        const gate = policyGate(policy, true)
        if (gate === null) return
        for (const id of ['new-file', 'new-folder']) {
          const node = drawn.nodes.get(id)
          if (node === undefined) continue
          node.disabled = true
          node.title = gate.reason
        }
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
        // A right-click inside ANY menu is not a menu gesture: ours would close
        // and reopen, and the host's would reopen over itself. Both attributes
        // are checked because each renderer marks its own element.
        if (target.closest(`[${TASK_MENU_ATTR}], [${CONTEXT_MENU_ATTR}]`) !== null) {
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
          openLocalBlankMenu(ctx, local, event.clientX, event.clientY)
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
          void policyOf({ root }).then((policy) => {
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
    /** A row whose click this bridge itself produced, to let it through once. */
    let treeClickBypass = null
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
        return
      }
      // The host is about to open this row. The viewing preference can hand a
      // plain file click to the conversation's file tab instead — claimed here,
      // in the capture phase, so the host's own React handler never sees it.
      // A modifier click never gets here (the reducer navigates only plain
      // clicks), which is what keeps Ctrl/Cmd+click as the host-preview escape.
      const decision = filePreviewDecision({
        path: row.getAttribute('data-files-path'),
        kind: row.getAttribute('data-files-entry'),
        ctrl: event.ctrlKey === true,
        shift: event.shiftKey === true,
        alt: event.altKey === true,
        fileView: savedViewPreferences.fileView,
      })
      const sessionId = treeSessionOfContainer(container)
      lastPreviewDecision = {
        at: Date.now(),
        path: row.getAttribute('data-files-path'),
        kind: row.getAttribute('data-files-entry'),
        decision,
        fileView: savedViewPreferences.fileView,
        slotReady: fileView !== undefined,
        sessionId,
        claimed: false,
      }
      if (decision === 'pane' && (fileView?.open(sessionId, row.getAttribute('data-files-path')) ?? false)) {
        lastPreviewDecision.claimed = true
        event.preventDefault()
        event.stopPropagation()
      }
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
        // Enter means "open this row" exactly like a plain click, so it must
        // honour the same preference BEFORE `activateTreeRow` bypasses the
        // bridge and lets the host open its preview.
        const decision = filePreviewDecision({
          path: row.getAttribute('data-files-path'),
          kind: row.getAttribute('data-files-entry'),
          ctrl,
          shift,
          alt: event.altKey === true,
          fileView: savedViewPreferences.fileView,
        })
        if (decision === 'pane' && (fileView?.open(treeSessionOfContainer(container), row.getAttribute('data-files-path')) ?? false)) return
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
        closeTaskMenu()
      }
    }

    // =========================================================================
    // Change-request tab: recent commit history
    // =========================================================================
    let forgeTabShadowDispose = null
    function resolveForgeTab (ctx) {
      let entries
      try {
        entries = ctx?.slots?.entries?.('sidebar.right.pane.tab') ?? []
      } catch {
        // A missing or reshaped registry is "no official panel", never a crash
        // inside the sidebar layout.
        return null
      }
      for (const entry of entries) {
        if (!isForgeTabEntry(entry)) continue
        // Both tests matter: identity catches this module instance, the marker
        // catches a shadow left by a previous one (a hot reload hands the page a
        // different function value, and rendering our own wrapper recursively
        // would be the one failure mode that looks like a working panel).
        if (entry.component === ForgeTabWithHistory || entry.component.sshwspForgeShadow === true) continue
        try {
          if (typeof ctx.slots?.isLive === 'function' && ctx.slots.isLive(entry) !== true) continue
        } catch { /* no liveness view — take the registration as live */ }
        return entry
      }
      return null
    }
    /**
     * Wrap one selector source as a hook, in the shape the renderer hands over.
     *
     * The renderer passes an entry an `observableHook`, and the official panel
     * calls it as `usePanel((current) => current)`. Handing the panel a snapshot
     * value instead compiles and renders a normal-looking component, then throws
     * on its first call. So each source becomes a function that subscribes and
     * applies the caller's selector — and one that never changes identity per
     * render, because a fresh function would resubscribe on every redraw.
     *
     */
    function forgeHookFor (source) {
      if (source === null || source === undefined) return absentForgeHook
      let hook = forgeHookCache.get(source)
      if (hook === undefined) {
        const subscribe = typeof source.subscribe === 'function'
          ? (notify) => source.subscribe(notify)
          : () => () => {}
        const getSnapshot = typeof source.getSnapshot === 'function'
          ? () => source.getSnapshot()
          : () => undefined
        hook = function useForgeSource (selector) {
          const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
          return (typeof selector === 'function' ? selector : identity)(snapshot)
        }
        forgeHookCache.set(source, hook)
      }
      return hook
    }

    function ForgeTabWithHistory (props) {
      const { ourT, sshWorkspaceCtx: ctx, ...officialProps } = props
      const copy = typeof ourT === 'function' ? ourT : (key) => key
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const official = resolveForgeTab(ctx)
      const split = official === null ? null : splitForgeFace(forgeFaceOf(official, sessionId))
      // Two independent reasons the official panel cannot be rendered, and both
      // must be checked before handing it over: its own inject face
      // (`isUsableForgeSplit`) and the seat's tab hook (`hasSlotTabHook`, see
      // there for why it is not part of the face). They are kept apart because
      // the fail-safe below treats them differently.
      const faceUsable = official !== null && isUsableForgeSplit(split)
      const usable = faceUsable && hasSlotTabHook(props)
      // The official panel is handed ITS OWN copy seat, not ours: the two seats
      // declare different namespaces (see officialTranslateSeat).
      const officialCopy = official === null ? null : officialTranslateSeat(ctx, official)
      // The official panel calls these during ITS render; they are the
      // renderer's selector-hook shape, not snapshot values (see forgeHookFor).
      const usePanel = forgeHookFor(split?.hooks.panel)
      const useHost = forgeHookFor(split?.hooks.host)
      const useLocale = forgeHookFor(split?.hooks.locale)

      // Fail safe for an incompatible upgrade: a shadow that cannot render the
      // official panel would silently hide change requests, which is worse than
      // losing this strip. Once the grace has passed without a usable OFFICIAL
      // entry, withdraw our registration so the cell returns to the official
      // occupant (or to the sidebar's own "nothing can view this" notice). Boot
      // ordering never needs the grace — both registrations land long before a
      // tab can be opened — so this only fires for a genuinely changed package.
      //
      // A missing SEAT tab hook deliberately does NOT withdraw. The hook is
      // declared by the sidebar for every occupant of this seat, so if it is
      // gone the official entry would crash in exactly the same place: handing
      // the cell back would trade a readable line plus this strip for a cell
      // that is dry. Keeping the shadow is the better failure, and `usable`
      // already stops it from rendering the official component.
      React.useEffect(() => {
        if (faceUsable) return undefined
        const timer = setTimeout(() => {
          const current = resolveForgeTab(ctx)
          if (current !== null && isUsableForgeSplit(splitForgeFace(forgeFaceOf(current, sessionId)))) return
          const dispose = forgeTabShadowDispose
          if (dispose === null) return
          forgeTabShadowDispose = null
          try { dispose() } catch { /* already gone */ }
        }, FORGE_TAB_GRACE_MS)
        return () => clearTimeout(timer)
      }, [faceUsable, ctx, sessionId])

      return jsxs('div', { className: 'sshwsp-cr-split', children: [
        jsx('div', {
          className: 'sshwsp-cr-official',
          children: usable
            ? jsx(official.component, {
              ...officialProps,
              usePanel,
              useHost,
              useLocale,
              ...split.rest,
              // LAST on purpose: the official copy seat must win over whatever
              // the seat kit or the official inject face happened to carry.
              ...(officialCopy === null ? {} : { t: officialCopy }),
            })
            : jsx('p', { className: 'sshwsp-cr-history-state', children: copy('history.missingPanel') }),
        }),
        jsx(React.Suspense, { fallback: null, children: jsx(CommitHistorySection, { sessionId, t: copy }) }),
      ]})
    }

    /**
     * The marker that tells a later module instance (or the fail-safe) which
     * registrations are ours. Set on the function object, because the slot core
     * stores only its known option fields — a custom registration option would
     * be dropped before it reaches `entry.options`.
     */
    ForgeTabWithHistory.sshwspForgeShadow = true

    // ---- the strip, loaded on demand
    //
    // The appendix under the official panel is 198 lines that exist only while
    // the change-request tab is open. It moves to `client.history.js`.
    //
    // What does NOT move is `ForgeTabWithHistory` itself, and that is the point:
    // it is the SHADOW — it resolves the official entry and renders the official
    // panel. A chunk that failed to arrive would leave the tab empty, which is
    // exactly the failure the shadow exists to prevent. So the shadow stays,
    // renders the official component, and defers only its own appendix.
    const CommitHistorySection = React.lazy(async () => {
      const loaded = await require.async('./client.history.js')
      return { default: loaded.CommitHistorySection }
    })

    // ---- the file editor, loaded on demand
    //
    // The preview header's Edit button and the panel it opens are ~700 lines
    // that exist only once a text file is previewed, so they move to
    // `client.editor.js`. The button is the lazy half and the panel rides
    // inside it: a chunk that failed to arrive costs the button, and the
    // preview it sits in keeps working — the same trade the other lazy parts
    // make.
    const FileEditAction = React.lazy(async () => {
      const loaded = await require.async('./client.editor.js')
      return { default: loaded.FileEditAction }
    })

    /**
     * The slot occupant: the lazy button behind its OWN Suspense boundary.
     *
     * This wrapper is not decoration. The Host's slot renderer has no Suspense
     * boundary anywhere above an occupant — it wraps each entry in an ERROR
     * boundary and nothing else — so a `React.lazy` component registered
     * directly into a slot suspends with nothing to catch it, and React renders
     * that subtree as empty. The symptom is a control that is simply never
     * there, with no error in the console and no failing assertion, which is
     * exactly how this button first shipped. Every other lazy occupant in this
     * file (PanelSlot, DialogSlot, the picker flows) already wraps for the same
     * reason; this one did not.
     *
     * The fallback is null rather than a spinner: the header is a single row of
     * controls, and a spinner that appears for one frame and is replaced by a
     * glyph reads as a flicker. Nothing is drawn until there is something real.
     */
    function FileEditActionSlot (props) {
      return jsx(React.Suspense, { fallback: null, children: jsx(FileEditAction, props) })
    }

    // The conversation file view reuses the SAME editor the sidebar preview
    // uses. A second lazy binding resolves to the same chunk instance, so the
    // tab/draft store and the CodeMirror engine are shared rather than copied.
    const ConversationFileEditor = React.lazy(async () => {
      const loaded = await require.async('./client.editor.js')
      return { default: loaded.FileEditorPanel }
    })

    // =========================================================================
    // Preview in conversation (the file view tab)
    // =========================================================================
    //
    // The file view itself — tab registry, per-Session rosters, composer hiding,
    // the rendered-document pane, the editor pane — lives in
    // `client.fileview.js`. What stays here is the part that has to answer
    // SYNCHRONOUSLY, because the file-tree bridge decides whether to claim a
    // click in the same tick the host would navigate on: which paths are ours,
    // which side owns a gesture, and the last saved preference.
    //
    // The seam is deliberate and one-way: the chunk receives `slots`,
    // `translate` and the editor getter through `installFileView` and owns every
    // piece of state that follows from them. Nothing below learns to render.
    const fileViewModule = () => require.async('./client.fileview.js')

    // Chunk revisions follow THIS file's metadata: when only a chunk changes,
    // the page keeps fetching the old URL. Touching the entry is how a bundle
    // whose chunks live in separate files publishes a new revision — but a
    // timestamp bump alone did not survive the trip in practice, so a work
    // session that only edits chunks should also leave a real byte here (a note
    // like this one counts) before asking anyone to reload. A forced reload
    // (Ctrl+Shift+R) covers the cache regardless of what the revision did, and
    // when a style change "did not apply", checking the reload first has been
    // right every time so far except once — where the cause was a rule that
    // never matched, not a stale chunk.
    //
    // Publication log (one line per chunk-only change, newest at the bottom):
    //   2026-11-28  audit table: one line per command, host filter, centred columns
    //               (client.panel.js, client.styles.js, client.locale.js)
    //   2026-11-28  recent events under the audit table: writes and deletes are not
    //               commands, so they get the diagnostics ring, not the table
    //               (client.panel.js, client.styles.js, client.locale.js,
    //                routes/entries.js)
    /** The installed chunk, or undefined until `apply` has fetched it. */
    let fileView = undefined

    /**
     * What the last tree click decided, for the diagnostic probe.
     *
     * The decision itself is the bridge's (it must answer synchronously); this
     * only remembers it so `__sshwspProbe()` can show why a click went where it
     * did without a reload.
     */
    let lastPreviewDecision = null

    /** The modified time the file view's tab strip was last measured at. */
    let savedViewPreferences = { fileView: 'sidebar', showFiles: false, hideComposer: true }

    /**
     * The extension whitelist the file view will show.
     *
     * A whitelist rather than "anything text": the bridge must decide BEFORE a
     * byte is read, and a guess that turns out binary would have claimed the
     * click and then had to apologise. Anything not listed keeps the host's own
     * preview, which is also the right answer for images, PDFs and binaries.
     *
     * Markdown is IN: the host renders it, but the point of this view is one
     * place to read and edit a workspace file, and .md is the file people open
     * most.
     *
     * These predicates stay in the bundle rather than in the view chunk: the
     * tree bridge runs synchronously, possibly before that chunk has loaded.
     */
    const PREVIEW_TEXT_EXTENSIONS = new Set([
      'c', 'cc', 'cfg', 'cjs', 'conf', 'cpp', 'cs', 'css', 'csv', 'go', 'gradle',
      'h', 'hpp', 'htm', 'html', 'ini', 'java', 'js', 'json', 'jsonc', 'jsx',
      'bat', 'cmd', 'cts', 'kt', 'kts', 'less', 'lua', 'md', 'mdx', 'markdown', 'mjs', 'php', 'plist', 'reg', 'mts',
      'properties', 'proto', 'ps1', 'psm1', 'py', 'rb', 'rs', 'sass', 'scss',
      'sh', 'sql', 'svelte', 'swift', 'toml', 'ts', 'tsx', 'txt', 'vb', 'vue',
      'xml', 'yaml', 'yml', 'zsh',
    ])

    /**
     * Extensionless file names that are still plain text.
     *
     * README / CHANGELOG are here because they are conventionally Markdown.
     */
    const PREVIEW_TEXT_NAMES = new Set([
      'changelog', 'dockerfile', 'gemfile', 'license', 'makefile', 'procfile',
      'rakefile', 'readme',
    ])

    /**
     * Suffixes whose bytes are never worth reading as text.
     *
     * The list exists so the sniff is not paid for the files where the answer
     * is certain — and so a zip does not open as a page of replacement
     * characters. Everything NOT listed here is `unknown` and gets sniffed,
     * which is the point: a new text extension does not need a release.
     */
    const PREVIEW_BINARY_EXTENSIONS = new Set([
      '7z', 'avi', 'bin', 'bmp', 'doc', 'docx', 'dll', 'dylib', 'eot', 'epub',
      'exe', 'flac', 'gif', 'gz', 'ico', 'img', 'iso', 'jar', 'jpeg', 'jpg', 'm4a', 'm4v',
      'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'odp', 'ods', 'odt', 'ogg',
      'ogv', 'otf', 'pdf', 'png', 'ppt', 'pptx', 'rar', 'so', 'tar', 'tgz',
      'ttf', 'wav', 'webm', 'webp', 'woff', 'woff2', 'xls', 'xlsx', 'xz', 'zip',
    ])

    /**
     * The last path segment, with its case kept: a tab shows the file's name.
     *
     * @param {unknown} path - an absolute path.
     * @returns {string} the name.
     */
    function fileTabName (path) {
      const clean = String(path).replace(/[?#].*$/u, '').replace(/[/\\]+$/u, '')
      const at = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
      return at < 0 ? clean : clean.slice(at + 1)
    }

    /** The last path segment, lowercased, with any query/fragment noise trimmed. */
    function previewNameOf (path) {
      return fileTabName(path).toLowerCase()
    }

    /**
     * Whether the file view can show this path as text.
     *
     * @param {unknown} path - the row's `data-files-path` (already absolute).
     * @returns {boolean} true when the view should claim the click.
     */
    function isPreviewablePath (path) {
      if (typeof path !== 'string' || path === '') return false
      const name = previewNameOf(path)
      if (name === '') return false
      const dot = name.lastIndexOf('.')
      if (dot <= 0) return PREVIEW_TEXT_NAMES.has(name)
      return PREVIEW_TEXT_EXTENSIONS.has(name.slice(dot + 1))
    }

    // `mdx` stays source: it carries JSX, which the renderer escapes.
    const PREVIEW_DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])
    const PREVIEW_DOCUMENT_NAMES = new Set(['changelog', 'readme'])

    /**
     * Whether this path opens as a rendered document.
     *
     * @param {unknown} path - an absolute path.
     * @returns {boolean} true for Markdown files and the two conventional names.
     */
    function isDocumentPath (path) {
      if (typeof path !== 'string' || path === '') return false
      const name = previewNameOf(path)
      if (name === '') return false
      const dot = name.lastIndexOf('.')
      if (dot <= 0) return PREVIEW_DOCUMENT_NAMES.has(name)
      return PREVIEW_DOCUMENT_EXTENSIONS.has(name.slice(dot + 1))
    }

    /** Suffix families the viewer knows. */
    const VIEWER_FAMILIES = [
      ['markdown', /\.(?:md|markdown|mdown|mkd)$/u],
      ['html', /\.(?:html?|xhtml)$/u],
      ['image', /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/u],
      ['video', /\.(?:mp4|m4v|webm|mov|mkv|ogv)$/u],
      ['audio', /\.(?:mp3|wav|ogg|m4a|flac)$/u],
      ['pdf', /\.pdf$/u],
    ]

    /**
     * Which viewer shows this file.
     *
     * The single answer used by the chunk (renderer, mode switch) and by the
     * click bridge (is this ours at all). A kind that can be edited still opens
     * at its source; the media kinds have no source mode, because showing the
     * bytes of a PNG as text is not a thing anyone wants.
     *
     * @param {unknown} path - an absolute path.
     * @returns {'markdown'|'html'|'image'|'video'|'audio'|'pdf'|'text'|'binary'} the kind.
     */
    function viewerOf (path) {
      if (typeof path !== 'string' || path === '') return 'binary'
      const name = previewNameOf(path)
      for (const [kind, pattern] of VIEWER_FAMILIES) {
        if (pattern.test(name)) return kind
      }
      if (isPreviewablePath(path)) return 'text'
      const dot = name.lastIndexOf('.')
      if (dot > 0 && PREVIEW_BINARY_EXTENSIONS.has(name.slice(dot + 1))) return 'binary'
      // Not text by name, not binary by name: the bytes decide. The suffix
      // tables are a fast path, never the rule.
      return 'unknown'
    }

    /**
     * The server capabilities this client needs to work as designed.
     *
     * A DSH process keeps the routes it booted with; the files on disk do not.
     * Without this check the mismatch surfaces as "the file does not exist" or
     * "the byte route refused it" - a symptom that points at the file instead
     * of at the process that needs restarting.
     */
    const REQUIRED_SERVER_FEATURES = ['byte-range', 'html-rewrite', 'local-bytes', 'sniff']

    /** Whether the running server is older than this client (set by /status). */
    let staleServer = false

    /**
     * Compare the running server's feature list with what this client needs.
     *
     * @param {object} status - the /status body, when one arrived.
     * @returns {boolean} true when a restart is needed.
     */
    function noteServerCompatibility (status) {
      const features = Array.isArray(status?.features) ? status.features : []
      // A server too old to publish the list is exactly the case this guards.
      const missing = REQUIRED_SERVER_FEATURES.filter((name) => !features.includes(name))
      staleServer = missing.length > 0
      if (staleServer) {
        console.warn('[dsh-ssh-workspace] the running DSH server is older than this client; restart DSH (missing: '
          + (missing.length === 0 ? 'no feature list at all' : missing.join(', ')) + ')')
      }
      return staleServer
    }

    /**
     * Whether the directory pickers list files as read-only context rows.
     *
     * Read at LISTING time (not captured in a callback): the panel saves this
     * without a reload, and the next directory the user opens must follow the
     * new value. The pickers are separate chunks, so this is exported to them
     * rather than passed through props.
     *
     * @returns {boolean} the `showFiles` preference.
     */
    function pickerShowsFiles () {
      return savedViewPreferences.showFiles === true
    }

    /**
     * Normalize and publish the viewing preferences.
     *
     * Called at boot from `/status` and again by the panel after every save. It
     * caches the value for the click bridge (which reads it synchronously) and
     * hands the chunk the same normalized object.
     *
     * @param {{fileView?: unknown, showFiles?: unknown, hideComposer?: unknown}} [next] - the settings.
     * @returns {object} the normalized value.
     */
    function applyPreferences (next) {
      const mode = next?.fileView === 'conversation' ? 'conversation' : 'sidebar'
      const settings = {
        fileView: mode,
        showFiles: next?.showFiles === true,
        hideComposer: next?.hideComposer !== false,
      }
      savedViewPreferences = settings
      fileView?.applyPreferences(settings)
      return settings
    }

    /**
     * Whether one tree gesture hands its file to the conversation tab.
     *
     * Pure on purpose: the test suite drives this shape instead of a DOM click.
     * Modifier clicks keep their existing meaning (Windows-style selection), and
     * Ctrl/Cmd+click therefore still opens the host preview — the documented
     * escape hatch.
     *
     * @param {object} input - the gesture.
     * @returns {'pane'|'host'} which side owns the gesture.
     */
    function filePreviewDecision ({ path, kind, ctrl = false, shift = false, alt = false, fileView: mode = savedViewPreferences.fileView } = {}) {
      if (mode !== 'conversation') return 'host'
      if (kind !== 'file') return 'host'
      if (ctrl === true || shift === true || alt === true) return 'host'
      // Claimed when the plugin has a VIEWER for it, not only when it is text:
      // a PNG, a video or a PDF opens in the conversation too. An unknown
      // binary keeps the host preview, which at least offers "open in app".
      return viewerOf(path) === 'binary' ? 'host' : 'pane'
    }
    /**
     * A stable id for one file's view entry.
     *
     * The host stores this id on the session when the tab is selected, so it
     * must not be the path itself: a very long path in a stored preference is
     * noise, and the seat only promises an opaque string. FNV-1a plus the
     * length (a collision inside one path length is what a 32-bit hash can
     * actually do) keeps two files apart without a registry.
     *
     * @param {string} path - the file.
     * @returns {string} the entry id.
     */
    function fileTabIdOf (path) {
      let hash = 2166136261
      for (let i = 0; i < path.length; i += 1) {
        hash ^= path.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
      return `sshwsp-file-${(hash >>> 0).toString(36)}-${path.length.toString(36)}`
    }

    /**
     * Fetch and install the chunk, then replay the saved preference into it.
     *
     * @param {object} slots - the slot service.
     * @returns {Promise<void>} resolves once the chunk is installed (or failed).
     */
    async function installFileView (slots) {
      const loaded = await fileViewModule().catch(() => undefined)
      if (loaded === undefined) {
        // A chunk that cannot load is not "still loading": leaving `fileView`
        // undefined keeps every click on the host preview, which still works.
        return
      }
      fileView = loaded.installFileView({
        slots,
        translate: (key, params) => translate(key, params),
        editor: () => ConversationFileEditor,
        isPreviewablePath,
        isDocumentPath,
        viewerOf,
        previewNameOf,
        fileTabName,
        fileTabIdOf,
        aliasOfSession: (sessionId) => aliasOfSession(sessionId),
        menu: { show: (model, x, y) => renderMenuDom(model, x, y) },
      })
      fileView.applyPreferences(savedViewPreferences)
    }


    // =========================================================================
    // Plugin apply
    // =========================================================================
    let translate = makeTranslate(zh)

    const inject = ['slots', 'locale']

    /**
     * Load the seven boot chunks in dependency order, then fill the `let`
     * bindings the stub sections above were written against.
     *
     * A cordis `apply` may be async and the sidebar row cannot be registered
     * before its glyph and label exist, so loading happens first and in one
     * place: kernel alone, icons alone, then the remaining five concurrently.
     * The order is a dependency, not a preference — see the two notes below.
     *
     * `republishBootNames` is not optional: `Object.assign(exports, …)` at the
     * bottom of this file copied VALUES while every boot binding was still a
     * stand-in. A chunk that destructured the exports before this ran would
     * hold those stand-ins forever and quietly draw nothing. The 17 owned
     * names are copied AGAIN here, after they have real values.
     *
     * Failure is loud on purpose: a swallowed rejection would register a panel
     * with no stylesheet or strings, looking like a broken plugin. The
     * rejection propagates to the loader, which reports the package as failed.
     *
     */
    async function loadBootChunks () {
      // The kernel goes FIRST, alone. `client.marks.js` destructures `API`,
      // `fetchJson`, `TREE_ROW_SELECTOR` and `rowReferenceKind` from this module
      // while ITS factory runs, and those four live in the kernel now — so the
      // marks chunk cannot even be fetched until the kernel has arrived and its
      // names are on `exports`. Fetching them together would hand the marks pass
      // four `undefined`s: it would decorate nothing while the panel looked fine.
      const kernel = await kernelModule()
      Object.assign(module.exports, kernel)
      // Every name below must also appear in `client.kernel.js`'s own
      // `Object.assign(exports, {…})`. A name the kernel defines but forgets to
      // export arrives as `undefined` here, and nothing complains until a caller
      // invokes it — that is how "sortPickerEntries is not a function" surfaced
      // from the directory pickers. The file-preview suite diffs these two lists.
      ;({
        API, BROWSE_LIST_LIMIT, COMPOSER_CARD_SELECTOR, DELETE_COUNT_LIMIT,
        DRAG_MIME, FLOW_MENU_WIDTH, FLOW_MENU_WIDTH_ROOMY, FLOW_PRIORITY,
        FORGE_TAB_GRACE_MS, FORGE_TAB_KEY, FORGE_TAB_SHADOW_PRIORITY,
        MENU_GLYPH_PATHS, OS_TREE_SELECTOR, PANEL_ID, PANEL_ORDER,
        PATH_PREVIEW_DEBOUNCE_MS, TASK_MENU_ATTR, TOAST_DISMISS_MS,
        TREE_BODY_SELECTOR, TREE_ROW_SELECTOR, absentForgeHook,
        applyTreeSelection, backdropDismiss, blankMenuScopeOf, capabilityNotes,
        childDirectoryPath, clearOsDropHighlight, clearTreeTextSelection,
        countDeleteContents, createMenuSeparator, createSessionCatchUp,
        directoryDraft, directoryPath, draftDirectoryTarget, dropFolderNames,
        dropOffsetFromEvent, dropPointFromEvent, entryNameOf, fetchJson,
        fetchReportText, filesTransferOf, firstClaim, focusSoleComposer,
        focusTreeCursor, focusableWithin, focusedElement, forgeFaceOf,
        forgeHookCache, formatBytes, hasSlotTabHook, hideDropCaret, identity,
        isForgeTabEntry, isNetworkFailure, isUsableForgeSplit, joinLocalPath,
        localBlankTargetOf, makeLocalPicker, mentionToken, modalLayer,
        mutationPolicyOf, narrowDirectoryEntries, sortPickerEntries,
        nextMenuIndex, normalizeRoot,
        officialTranslateSeat, osDropPlan, pickDirTarget, pickFileTarget,
        pickLocalFiles, postFileInChunks, postUploadChunk, randomHexId,
        readComposerRoot, readResponseBlob, referenceFor, refreshFilesPanel,
        rememberTreeSelection, remoteDirOf, remoteTargetOf, renameAnchorOf,
        requestJson,
        resolveBrowseFlow, resolveComposerTarget, resolveTargets,
        resolveTreeAnchor, responseErrorText, rowOfPath, rowReferenceKind,
        saveViaAnchor, selectToastDetail, setOsDropHighlight, showDropCaret,
        splitDroppedFolders, splitForgeFace, streamIntoHandle,
        subscribeTransferActionsSlot, subscribeTransferQueue, toastActionOf,
        toastCopyText, toastError, toastModel, transferActionsSlotListeners,
        transferCancelledError, transferPausedError, transferQueueListeners,
        transferQueueWorkers, treeAnchorPath, treeContainerOf, treeRootOf,
        treeRootOfContainer, treeRowModel, treeRowSelectable, treeScopeKeyOf,
        treeSelectableRows, treeSelectedItems, treeSelectionContainers,
        treeSelectionScopes, treeSelectionStates, treeSessionOfContainer,
      } = kernel)

      // The icons come next, also ALONE, and for the same kind of reason: the
      // marks chunk destructures `REMOTE_MARK_VIEWBOX` while its own factory
      // runs, and that constant is a VALUE, not a lazily-invoked component. A
      // stand-in cannot work here — the mark would be built with an empty
      // viewBox, which renders every path outside the visible box. Fetching the
      // two together handed the decoration pass `''`, and the only symptom was
      // a squashed glyph in the sidebar.
      const icons = await iconsModule()
      ;({
        REMOTE_MARK_VIEWBOX, RemoteMarkIcon, ServerIcon, FolderIcon, FileIcon, GlobeIcon,
        ArrowLeftIcon, CloseIcon, PauseIcon, PlayIcon, RefreshIcon, ChevronIcon, TRAY_BASE_PATH,
        TRAY_ARROW_PATHS, DownloadIcon, UploadIcon, TransferProgressIcon,
      } = icons)
      // Publishing is not the same act as destructuring, and this is where that
      // difference bit: the locals above were correct, but `module.exports` still
      // held the inert stand-ins published at module evaluation, and the marks
      // chunk destructures from `require(...)` in its factory — which runs during
      // the `Promise.all` below. Fixing the ORDER alone did nothing, because the
      // order was already right; the value on `exports` was stale.
      Object.assign(module.exports, {
        REMOTE_MARK_VIEWBOX, RemoteMarkIcon, ServerIcon, FolderIcon, FileIcon, GlobeIcon,
        ArrowLeftIcon, CloseIcon, PauseIcon, PlayIcon, RefreshIcon, ChevronIcon, TRAY_BASE_PATH,
        TRAY_ARROW_PATHS, DownloadIcon, UploadIcon, TransferProgressIcon,
      })

      const [locale, styles, queue, selection, marks] = await Promise.all([
        localeModule(),
        stylesModule(),
        queueModule(),
        selectionModule(),
        marksModule(),
      ])
      ;({ NS, zh, en, applyParams, makeTranslate, relativeTimeText, provenanceText } = locale)
      ;({ injectStyles } = styles)
      ;({
        TRANSFER_QUEUE_LIMIT_TOTAL, TRANSFER_QUEUE_LIMIT_PER_HOST, TRANSFER_QUEUE_UPLOAD_LIMIT,
        queueReduce, queueDrain, queueItemPercent, orderedTransferQueueItems,
        splitOversizeFiles, transferQueueActiveCount, transferQueueIsTerminal,
        transferQueueNextSpeed, transferQueueProgress, truncateTransferName,
      } = queue)
      ;({ SELECTION_EMPTY, selectReduce, selectionRange } = selection)
      ;({
        installRemoteWorkspaceMarks, refreshRemoteWorkspaceMarks,
        syncRemoteWorkspaceMarks, scheduleRemoteMarks, aliasOfSession,
      } = marks)
      republishBootNames()
    }

    /** Re-copy the names the boot chunks own, now that they hold real values. */
    function republishBootNames () {
      Object.assign(exports, {
        CloseIcon,
        PauseIcon,
        PlayIcon,
        FolderIcon,
        FileIcon,
        ChevronIcon,
        RefreshIcon,
        DownloadIcon,
        TransferProgressIcon,
        UploadIcon,
        RemoteMarkIcon,
        ArrowLeftIcon,
        GlobeIcon,
        relativeTimeText,
        provenanceText,
        // Also a plain string owned by a chunk, and also published as a stand-in
        // before that chunk existed. `client.marks.js` reads it at factory time,
        // so the load ORDER above matters as much as this line — but any later
        // reader (and a hot reload) needs the real value on `exports` too.
        REMOTE_MARK_VIEWBOX,
        // The queue's readers live in `client.transfer-queue.js`, which
        // destructures them. Without this line it would receive the stand-ins
        // `Object.assign(exports, …)` published at evaluation time — an empty
        // percent and an always-false terminal test, with no error anywhere.
        orderedTransferQueueItems,
        queueItemPercent,
        transferQueueIsTerminal,
        truncateTransferName,
        // Same trap, one layer worse: these four are FUNCTIONS that only exist
        // once `client.marks.js` arrives, so the export published at evaluation
        // time is the stand-in `() => {}`. Both lazy consumers destructure them
        // when their own chunk loads — `client.panel.js` calls
        // `syncRemoteWorkspaceMarks` after every `/status` it fetches, and
        // `client.add-workspace.js` calls `refreshRemoteWorkspaceMarks` after a
        // mount — and a destructured copy never follows the reassignment above.
        // Left unpublished, both are silent no-ops: the sidebar keeps whatever
        // decoration the boot pass painted, so a workspace detached or enabled
        // from the panel stays grey (and unclickable) until the page reloads.
        installRemoteWorkspaceMarks,
        refreshRemoteWorkspaceMarks,
        syncRemoteWorkspaceMarks,
        scheduleRemoteMarks,
      })
    }

    async function apply (ctx) {
      await loadBootChunks()
      // `translate` closes over the table that has just arrived.
      translate = makeTranslate(zh)
      injectStyles()
      const detachTriggerRects = trackTriggerRects()
      const detachMarks = installRemoteWorkspaceMarks(ctx)
      const detachBridges = installComposerBridges(ctx)
      refreshRemoteWorkspaceMarks()
      // The click bridge decides SYNCHRONOUSLY, so the viewing preference is
      // read once here rather than on the first click — a lazy read would send
      // that click to the host preview and only then learn it should not have.
      // The panel republishes after every save, and every later `/status` it
      // fetches is applied too (see the panel chunk).
      void fetchJson(API.status)
        .then((status) => { applyPreferences(status?.preferences); noteServerCompatibility(status) })
        .catch(() => { /* no status yet: keep the pre-feature defaults */ })
      // A page that was already open when this plugin was disabled keeps a
      // session list from before the repair; see the catch-up section.
      const sessionCatchUp = createSessionCatchUp(ctx)
      sessionCatchUp.start()

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

      // The document preview's action slot: the Edit button.
      //
      // A DIFFERENT slot from the one above, and the difference matters. The
      // Files tab hands over the directory it is showing; the document preview
      // hands over the one file in front of the user, with the Session-scoped
      // `absolutePath` the Host produced from `ctx.fs.processPath` — which is
      // the `ssh://` spelling for a remote target and a plain path for a local
      // one. That is exactly the two-worlds value the text routes branch on, so
      // the button needs no path translation of its own.
      //
      // No probe timer here: unlike the transfer-queue entry, an absent edit
      // button is not a lost control — most previewed files (images, PDFs,
      // huge logs) are legitimately not editable, and a "this slot is missing"
      // line would be indistinguishable from the ordinary refusal.
      slots.inject('sidebar.right.tab.document.actions', () => slots.register({
        name: 'sidebar.right.tab.document.actions',
        id: `${PANEL_ID}-edit`,
        inject: () => ({ t: translate, ctx }),
      }, FileEditActionSlot))

      // Add-workspace flow: shadow the built-in directory pickers so the entry
      // offers a local/remote choice. Registered into both holes through the
      // nested inject pattern — ui-workspace may declare them later or replace
      // their declarations, and `inject` waits for the declaration.
      //
      //
      // The local step does NOT call `uiWorkspace.pickDirectory()` first: on
      // this deployment the composed directoryPicker serves only `browse`, so
      // that call fails with "directoryPicker.pick needs the native capability"
      // while shadowing the working in-app browser. AddWorkspaceFlow renders
      // the installed browse occupant's own component instead (resolved from
      // the raw slot entries; see resolveBrowseFlow) and falls back to the
      // picker bridge on deployments that have no in-app browser. `localFlow`
      // is per-hole because each hole has its own browse registration.
      const flowInject = (hole) => () => ({
        pick: makeLocalPicker(ctx),
        localFlow: () => resolveBrowseFlow(ctx, hole),
        t: translate,
      })
      slots.inject('conversation.hero.workspace.directoryFlow', () => slots.inject('sidebar.workspaces.directoryFlow', function* () {
        yield slots.register({
          name: 'conversation.hero.workspace.directoryFlow',
          priority: FLOW_PRIORITY,
          inject: flowInject('conversation.hero.workspace.directoryFlow'),
        }, FlowSlot)
        yield slots.register({
          name: 'sidebar.workspaces.directoryFlow',
          priority: FLOW_PRIORITY,
          inject: flowInject('sidebar.workspaces.directoryFlow'),
        }, FlowSlot)
      }))

      // The file views: one tab per open file, in the conversation's own strip.
      //
      // The chunk owns the seat, the roster and the components; the bundle only
      // hands it the two live handles it cannot read for itself (`slots` and the
      // bound translator). Installed here rather than lazily because the first
      // click can arrive before a gesture would have had time to fetch it.
      void installFileView(slots)

      // Recent commit history under the official change-request tab.
      //
      // Same key as the shipped forge registration, lower priority: the cell
      // keeps both entries and renders ours, and our component renders the
      // official one from the raw entries view (see resolveForgeTab). The title
      // seat is untouched, so the chip stays official and no second tab is
      // created. `slots.inject` waits for the sidebar to declare the seat and
      // re-runs if that declaration is replaced; the disposer below is the one
      // the slot core calls then, and the component's fail-safe can call it too
      // (that is why it is stored in the module-level binding).
      slots.inject('sidebar.right.pane.tab', () => {
        const dispose = slots.register({
          name: 'sidebar.right.pane.tab',
          key: FORGE_TAB_KEY,
          priority: FORGE_TAB_SHADOW_PRIORITY,
          inject: () => ({ ourT: translate, sshWorkspaceCtx: ctx }),
        }, ForgeTabWithHistory)
        forgeTabShadowDispose = dispose
        return () => {
          if (forgeTabShadowDispose === dispose) forgeTabShadowDispose = null
          dispose()
        }
      })

      // Diagnostic hook, deliberately tiny: the two decisions this plugin has
      // to make synchronously (claim a tree click, dim a host-off row) leave no
      // event behind, so a browser console is the only place they can be read.
      // Remove once the "does nothing" reports are settled.
      globalThis.__sshwspProbe = () => ({
        preferences: { ...savedViewPreferences },
        slotReady: fileView !== undefined,
        preview: fileView?.probe(),
        lastClick: lastPreviewDecision,
        marks: globalThis.__sshwspMarks?.(),
      })

      // Cordis unmounts a plugin by calling the disposer `apply` returns. The
      // document-level gesture listeners are not owned by any ctx.effect, so
      // without this they would outlive the materialization that installed
      // them and every later one would stack on top.
      return () => {
        clearTimeout(transferActionsProbe)
        sessionCatchUp.stop()
        detachBridges()
        detachTriggerRects()
        detachMarks?.()
        fileView?.release()
      }
    }

    // The chunks reach back through these. `require('<plugin id>')` from a chunk
    // returns this object (tests/client-chunk-smoke.mjs), so every name a chunk
    // destructures has to be listed here — a missing one is a ReferenceError at
    // the moment a user opens a dialog, not at load.
    Object.assign(exports, {
      API,
      // ...and the viewing-preference half: the panel chunk publishes each
      // saved value through `applyPreferences` so the click bridge (which must
      // decide synchronously) sees it without a reload.
      applyPreferences,
      noteServerCompatibility,
      pickerShowsFiles,
      filePreviewDecision,
    viewerOf,
      CloseIcon,
      FolderIcon,
      capabilityNotes,
      backdropDismiss,
      modalLayer,
      useDialogA11y,
      PATH_PREVIEW_DEBOUNCE_MS,
      draftDirectoryTarget,
      narrowDirectoryEntries,
      sortPickerEntries,
      childDirectoryPath,
      directoryPath,
      directoryDraft,
      usePathDraftPreview,
      // ...and the picker's listing cap, which is a constant both halves read.
      BROWSE_LIST_LIMIT,
      // ...these are for the change-request history chunk.
      fetchJson,
      // ...and this one is for the file editor chunk: a status-aware request,
      // because a 409 is a state to recover from rather than an error to show.
      requestJson,
      ChevronIcon,
      RefreshIcon,
      // ...and these are for the transfer-queue chunk.
      DownloadIcon,
      TransferProgressIcon,
      UploadIcon,
      cancelTransferQueueItem,
      clearFinishedTransfers,
      formatBytes,
      orderedTransferQueueItems,
      pauseTransferQueueItem,
      queueItemPercent,
      resumeTransferQueueItem,
      retryTransferQueueItem,
      transferQueueIsTerminal,
      truncateTransferName,
      useTransferQueue,
      // ...and these are for the panel chunk. It is the plugin's centre, so its
      // list is the longest: the route table, the three dialogs it opens, the
      // queue entry it drives, and the mark repaint it triggers after every
      // status poll. `HostCard` is NOT here any more: it moved INTO that chunk.
      fetchReportText,
      RemoteMarkIcon,
      DialogSlot,
      HostEditor,
      DirectoryBrowser,
      HostPowerDialog,
      ReportDialog,
      notifyUser,
      toastError,
      useTransferActionsSlot,
      syncRemoteWorkspaceMarks,
      refreshRemoteWorkspaceMarks,
      // ...and the three names the marks chunk itself borrows. They stayed here
      // because the composer bridge reads them too.
      REMOTE_MARK_VIEWBOX,
      TREE_ROW_SELECTOR,
      rowReferenceKind,
      // ...and these are for the add-workspace chunk.
      ArrowLeftIcon,
      GlobeIcon,
      useMenuKeyboard,
      FLOW_MENU_WIDTH_ROOMY,
      flowMenuPosition,
      // ...and these are the locale helpers. `client.panel.js` renders an age
      // and a freshness line with them; the dictionaries themselves are not
      // handed out, because nothing outside `apply` should be reading a table.
      relativeTimeText,
      provenanceText,
    })

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
