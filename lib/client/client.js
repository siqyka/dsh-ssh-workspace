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
    // fetched with `require.async('./client.<name>.js')`:
    //
    //   `client.locale.js`         830 lines of dictionaries, awaited in apply
    //   `client.styles.js`         529 lines of CSS text, awaited in apply
    //   `client.icons.js`          fourteen SVG glyph factories, awaited in apply
    //   `client.queue.js`          the queue's pure rules, awaited in apply
    //   `client.dialogs.js`         three dialogs, opened on demand
    //   `client.panel.js`           the dashboard, drawn when the row is clicked
    //   `client.add-workspace.js`   the add-workspace flow, once a picker opens
    //   `client.transfer-queue.js`  the queue popover, while it is open
    //   `client.history.js`         the commit-history footer under the tab
    //
    // The first four are awaited by `loadBootChunks()` at the top of `apply`,
    // because a page load cannot proceed without them: the sidebar row needs a
    // glyph and a label, the panel must not draw before its rules arrive, and a
    // transfer started before the queue rules land would have no ceiling and no
    // drain. The rest are lazy, resolved the first time a gesture asks for one.
    //
    // A chunk may register under this bundle's id, and `require('<this
    // package>')` from inside it returns THIS module's exports — which is how a
    // moved component still reaches `API`, the icons and `useDialogA11y`. That
    // channel is proven, not assumed: see `tests/client-chunk-smoke.mjs`. Every
    // name a chunk borrows must be listed in the `Object.assign(exports, …)`
    // block at the bottom of this file, and `tests/support/free-names.mjs`
    // fails the suite when one is missing.
    //
    // What stays here, one section per responsibility, listed below. Every
    // section starts with the same `// ====` banner, so a jump-to-next-banner
    // walk visits them in order.
    //
    //   1. API client
    //   2. Locale, loaded in apply (the bindings; the tables are in the chunk)
    //   3. Stylesheet, loaded in apply
    //   4. SVG Icons, loaded in apply
    //   5. Dialogs, loaded on demand (host editor / directory picker / report)
    //   6. Main panel, loaded on demand (the dashboard itself)
    //   7. Add-workspace flow, loaded on demand (the picker occupants)
    //   8. Panel icon (sidebar row glyph)
    //   9. Panel page wrapper
    //  10. Remote-workspace marks (DOM decoration)
    //  11. Composer file bridge (drag / right-click → @ reference)
    //  12. Transfer queue (batch uploads, progress overlay, cancellation)
    //  13. Transfers from DSH's own file tree (row rename / delete)
    //  14. File-panel header actions
    //  15. Host file tree: Windows-style multi-select
    //  16. Change-request tab: recent commit history
    //  17. Session list catch-up (one re-pull after a repair)
    //  18. Plugin apply
    //
    // Sections 2, 3 and 4 are stubs: a `require.async` loader and one `let` per
    // name, filled in by `loadBootChunks()`. Sections 5, 6 and 7 are stubs too:
    // the lazy binding, the boundary, and the exports block. The components and
    // the tables themselves live in their chunks, which carry their own banners
    // (`client.dialogs.js` has three: host editor / directory browser /
    // diagnostic report; `client.panel.js` has two: Main panel and Host card;
    // `client.add-workspace.js` has one: Add-workspace flow).
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
    // suite is red. That rule now runs per part (`scripts/client-map.mjs`), so
    // the chunk's banners are checked against the chunk.
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
      gitHistory: '/api/dsh-ssh-workspace/git-history',
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
    // Locale, loaded in apply
    // =========================================================================
    // 830 lines of dictionaries plus three pure helpers, and the boot path needs
    // them only to translate the sidebar label. They live in `client.locale.js`;
    // `apply` awaits that chunk and fills the bindings below in BEFORE it
    // registers a single slot, so nothing can ask for a string that has not
    // arrived. The stand-ins return the key itself, which is what a missing
    // dictionary already renders as.
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
    // Fourteen pure React glyph factories in `client.icons.js`, awaited in
    // `apply` because three readers here are not deferred: the sidebar row's
    // glyph, the file-tree DOM menu (via TRAY_ARROW_PATHS), and the
    // remote-workspace decoration that runs the moment a workspace appears.
    const iconsModule = () => require.async('./client.icons.js')
    let REMOTE_MARK_VIEWBOX = ''
    let RemoteMarkIcon = () => null
    let ServerIcon = () => null
    let FolderIcon = () => null
    let GlobeIcon = () => null
    let ArrowLeftIcon = () => null
    let CloseIcon = () => null
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
     * Render a layer on `document.body` instead of where the component sits in
     * the React tree.
     *
     * Where a dialog is MOUNTED decides which listeners see its events; where it
     * is painted does not. Two ancestors of this panel's dialogs both hijack
     * them:
     *
     *  - The sidebar binds a `passive: false` wheel hand-off on its scroll
     *    viewport. It `preventDefault()`s the event and writes the scroll to its
     *    OWN elements unless the viewport is already at its end AND the target
     *    is inside its section scroller. A `position: fixed` dialog is visually
     *    out of the column but still a DOM descendant, so every wheel over it is
     *    swallowed there and the dialog body never scrolls — the list looks
     *    stuck however correct its own CSS is.
     *  - The composer seat carries `will-change: transform`, which makes it the
     *    containing block for fixed descendants: opening this overlay from the
     *    blank-session hero would size `inset: 0` to the seat, not the viewport.
     *
     * Portalling to the body is the contract the Host states for its own fixed
     * overlays ("every fixed overlay inside the composer must portal to the
     * document body"), and it is the only fix that does not depend on the
     * sidebar's listener learning about dialogs.
     *
     * @param {*} children - the layer to mount.
     * @returns {*} the same tree, portalled when a body exists.
     */
    function modalLayer (children) {
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return children
      return createPortal(children, document.body)
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
    const ReportDialog = lazyDialog('ReportDialog')

    // The picker's pure helpers moved with their component; the panel's own
    // path preview still calls three of them, so they are loaded once on
    // demand and cached. Until they arrive the preview shows nothing rather
    // than a second copy of the rules.
    // The picker's pure helpers stay HERE, not in the chunk: the panel's own
    // path preview and the Add-workspace flow call them during render, and a
    // helper that is only reachable through a chunk cannot be called before that
    // chunk arrives. They are exported at the bottom of this file so the dialog
    // chunk imports one set of rules instead of carrying a second copy.

    /**
     * How long a pause in typing must last before a picker re-lists a directory.
     *
     * Every re-list is an SFTP round trip to a host that may be continents away.
     * A filter INSIDE the directory already shown costs nothing (see
     * `draftDirectoryTarget`), so this delay only applies to the keystrokes that
     * change WHICH directory is listed — a `/`, or a backspace over one.
     */
    const PATH_PREVIEW_DEBOUNCE_MS = 200

    /**
     * Read a typed path as "which directory to list, narrowed by what".
     *
     * Both pickers list directories, and the input is a draft that may be a
     * complete absolute path (`/home/me/projects`), a prefix of one
     * (`/home/me/pro`), or half-edited junk. This turns that draft into the one
     * thing the list can act on, without touching the network:
     *
     *  - `{ dir: '/home/me', fragment: 'pro', refresh: false }` — the draft is
     *    still completing a name in the directory already on screen. The
     *    fragment narrows the rows locally; the host is not asked again for
     *    every prefix, which is what makes typing feel immediate over SSH.
     *  - `{ dir: '/home/me/projects', fragment: '', refresh: true }` — the
     *    draft names a directory outright (a trailing `/` says so), so list it.
     *  - `null` — not an absolute path, so it names nothing and narrows
     *    nothing; the caller keeps what it is showing.
     *
     * `refresh` says whether the current listing already describes `dir`. It is
     * the difference between "filter what is here" and "go and ask". A draft
     * that ends in `/` names the directory itself, so the settled state (the
     * trailing slash after a navigation) needs no listing; a slash-free draft is
     * always a fragment of the PARENT, even when it happens to spell the
     * directory on screen — that is the user deleting the slash to go back up.
     *
     * @param {string} draft - the raw input value.
     * @param {string | null} currentDir - the directory the listing belongs to.
     * @returns {{dir: string, fragment: string, refresh: boolean} | null} the target.
     */
    function draftDirectoryTarget (draft, currentDir) {
      const raw = typeof draft === 'string' ? draft.trim() : ''
      if (!raw.startsWith('/')) return null
      // `path` is stored canonically (see `directoryPath`), but a caller may
      // still hand over a spelling with the slash; comparing the raw strings
      // would read that slash as "a directory I have not listed yet" and
      // re-list a directory that is already on screen — once per slash.
      const current = typeof currentDir === 'string' ? (currentDir.replace(/\/+$/u, '') || '/') : null
      const trailing = /\/$/u.test(raw)
      const trimmed = raw.replace(/\/+$/u, '')
      // A trailing slash (or nothing but slashes) commits the last segment: it
      // names a DIRECTORY, never a prefix to complete.
      if (trailing || trimmed === '') {
        const dir = trimmed === '' ? '/' : trimmed
        return { dir, fragment: '', refresh: dir !== current }
      }
      // No "settled" branch here on purpose. Navigation writes the trailing
      // slash (see `directoryDraft`), so a draft equal to the directory on
      // screen WITHOUT one is the user deleting that slash: it means "filter
      // the parent", and the parent has to be listed again. Treating it as
      // settled is what made `/raid` keep showing the contents of `raid/`
      // after the slash was removed.
      const cut = trimmed.lastIndexOf('/')
      const dir = cut <= 0 ? '/' : trimmed.slice(0, cut)
      return { dir, fragment: trimmed.slice(cut + 1), refresh: dir !== current }
    }

    /**
     * Narrow a listing to the names that still fit the typed fragment.
     *
     * Case-insensitive on purpose: this is a completion list in a picker, not a
     * path resolver. The rows keep the REAL spelling the host reported, so
     * clicking one enters the real name; only the comparison is forgiving, and
     * someone typing `doc` for a remote `Documents` should still see it.
     *
     * @param {Array<{name: string}> | null} entries - the listing's rows.
     * @param {string} fragment - what the draft has typed of the last segment.
     * @returns {Array<{name: string}> | null} the rows to render.
     */
    function narrowDirectoryEntries (entries, fragment) {
      if (entries == null || fragment === '') return entries
      const needle = fragment.toLowerCase()
      return entries.filter(entry => entry.name.toLowerCase().startsWith(needle))
    }


    /**
     * Join a directory path and one child name.
     *
     * `/` must not become `//`: the server echoes the requested path back, and
     * that echo is what the input and the mount button then show.
     *
     * @param {string} dir - absolute directory path.
     * @param {string} name - one entry name.
     * @returns {string} the child path.
     */
    function childDirectoryPath (dir, name) {
      return dir === '/' ? `/${name}` : `${directoryPath(dir)}/${name}`
    }

    /**
     * The directory a path names, without a trailing slash.
     *
     * `path` is the listing's identity (and the mount target), so it is kept
     * canonical — `/raid/` and `/raid` are the same directory and must not make
     * the mount button offer two different spellings.
     *
     * @param {string} path - absolute path.
     * @returns {string} the path without trailing slashes ('/' stays '/').
     */
    function directoryPath (path) {
      const trimmed = String(path).replace(/\/+$/u, '')
      return trimmed === '' ? '/' : trimmed
    }

    /**
     * How the path INPUT spells a directory it has settled on.
     *
     * The trailing slash is the contract: a draft that ends in `/` names the
     * directory being browsed, while a draft without one is a fragment to
     * complete in the PARENT. So every navigation writes the slash — that is
     * what makes deleting it mean "go back to the parent", which is exactly
     * how users read a path (`/raid/` = inside raid, `/raid` = filtering for
     * raid). Without it the two states spell the same string and the input
     * cannot tell "I am in raid" from "I am typing raid".
     *
     * @param {string} path - absolute path.
     * @returns {string} the draft spelling.
     */
    function directoryDraft (path) {
      const dir = directoryPath(path)
      return dir === '/' ? '/' : `${dir}/`
    }

    /**
     * Keep a picker's rows in step with the path being typed.
     *
     * The listing itself is the caller's business (it owns the fetch and the
     * directory that listing belongs to). This hook owns the two decisions that
     * make typing feel live without asking the host on every keystroke:
     *
     *  - inside the directory already listed, the draft only NARROWS the rows
     *    (`narrowDirectoryEntries`), so the list follows the cursor at frame
     *    speed, even on a 400 ms link;
     *  - a draft that names another directory (a trailing `/`) asks the caller
     *    for it once the typing pauses. A fragment is only ever a filter, even
     *    when it spells a name in full: entering is the trailing slash, Enter,
     *    or a double click — never something the input does on its own.
     *
     * A draft that is not absolute (`null` from `draftDirectoryTarget`) narrows
     * nothing: the rows stay as they are and the input keeps its text, so a
     * half-deleted leading `/` cannot blank the dialog.
     *
     * The fragment is owned here rather than by the caller because it must be
     * right at the moment the rows change, not one effect later.
     *
     * @param {object} options - the hook's inputs.
     * @param {string} options.draft - the input's current value.
     * @param {string | null} options.currentDir - the directory `listing` describes.
     * @param {Array<{name: string, type: string}> | null} options.listing - that directory's rows.
     * @param {(dir: string, options: {preview: true}) => void} options.loadDir - ask for one directory.
     * @returns {string} the fragment the rows should be narrowed by.
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
    function capabilityNotes (capabilities, t) {
      const notes = []
      if (capabilities.rg === false) notes.push(t('caps.rg'))
      if (capabilities.git === false) notes.push(t('caps.git'))
      if (capabilities.inotifywait === false) notes.push(t('caps.inotifywait'))
      return notes
    }

    // =========================================================================
    // Main panel, loaded on demand
    // =========================================================================
    // The panel is 1,551 lines that only exist once the sidebar row is clicked.
    // It lives in `client.panel.js`, fetched the first time the `main` slot is
    // asked for a component.
    //
    // `Suspense` is not decoration here. A lazy component whose chunk fails to
    // arrive rejects, and this bundle has no error boundary, so the rejection
    // would take down the whole plugin surface. The `main` slot receives
    // `PanelSlot` instead of the panel itself; it owns the boundary and renders
    // nothing while the chunk is in flight or after it failed.
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

    // The in-app browser is a UI surface, not a picker capability: the shipped
    // browse plugin registers a *flow occupant* (its dialog component) into
    // these two holes and exposes no service that opens it. So a deployment
    // whose composed directoryPicker serves only `browse` — headless Linux +
    // `dsh web` — cannot reach it through `uiWorkspace.pickDirectory()`, which
    // needs `native`, even though the component that CAN pick a local directory
    // is registered right beside this plugin's shadowing occupant.
    //
    // A single-kind slot renders exactly one occupant and the core has no
    // "delegate to the next occupant" call, but the registry's raw entries view
    // keeps every registration, and a flow entry is a plain
    // `{ component, inject }`. The local branch therefore renders that sibling
    // component with this hole's owner conversation. It is the same element the
    // shipped occupant would render — same dialog, same locale, same listing
    // calls — not a second directory dialog written here.
    const BROWSE_FLOW_PACKAGE = 'directory-picker-browse'
    const BROWSE_FLOW_COMPONENT = 'BrowseDirectoryFlow'

    /** Whether one raw slot entry is the shipped in-app browse flow. */
    function isBrowseFlowEntry (entry) {
      if (entry == null || typeof entry.component !== 'function') return false
      const registrant = typeof entry.registrant === 'string' ? entry.registrant : ''
      if (registrant.includes(BROWSE_FLOW_PACKAGE)) return true
      return entry.component.name === BROWSE_FLOW_COMPONENT
    }

    // An occupant's injected props are cached by the renderer for exactly this
    // reason: `inject()` returns fresh callbacks, and the browser dialog wires
    // its scans to those identities. Caching on the entry — identity-stable per
    // registration — keeps this plugin's re-renders from restarting a listing.
    const browseFlowCache = new WeakMap()

    /**
     * The installed in-app browse flow for one directory-flow hole, or null
     * when this deployment has none (desktop preload bridge, native-only
     * composition, or a browse package whose registration changed shape).
     *
     * @returns {{ component: Function, props: object } | null}
     */
    function resolveBrowseFlow (ctx, hole) {
      let entries = []
      try {
        entries = ctx.slots?.entries?.(hole) ?? []
      } catch {
        // A missing or reshaped registry is "no in-app browser", never a crash
        // inside the owner's add-workspace flow.
        return null
      }
      const entry = entries.find(isBrowseFlowEntry)
      if (entry === undefined) return null
      if (browseFlowCache.has(entry)) return browseFlowCache.get(entry)
      let resolved = null
      try {
        const props = typeof entry.inject === 'function' ? entry.inject() : {}
        // A dynamic injection face would carry hook sources this plugin cannot
        // bind; the shipped browse flow injects plain calls only.
        if (props != null && typeof props === 'object' &&
            props.hooks === undefined && props.keyedHooks === undefined &&
            typeof props.listDirectory === 'function' &&
            typeof props.createDirectory === 'function' &&
            typeof props.t === 'function') {
          resolved = { component: entry.component, props }
        }
      } catch {
        resolved = null
      }
      browseFlowCache.set(entry, resolved)
      return resolved
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
     * The only byte formatter left: the directory dialog used to carry its own
     * `formatSize` for the file rows of a listing, and those rows are gone — a
     * picker that can only enter directories has no size column to fill. This
     * one is read ONCE, in a sentence, after the fact.
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
    // Change-request tab: recent commit history
    // =========================================================================
    // The official change-request panel is a *keyed* occupant of
    // `sidebar.right.pane.tab`: the sidebar dispatches that seat with
    // `entryKey = <tab type id>`, and the forge package registers under its own
    // TAB_ID. The tab's chip, glyph, order and title live in the sidebar's own
    // tab-type registry and the `.title` seat, NOT in this one, so taking over
    // this cell changes the panel body only — there is still exactly one tab,
    // with the official chip and title.
    //
    // The slot core keeps every registration and renders the FIRST live entry
    // of a cell in ASCENDING priority (`priority ?? 0`; the shipped entry names
    // none, so 0). A negative priority therefore shadows the official component
    // without unregistering it: our entry renders and renders the official one
    // itself. `resolveForgeTab` reads the raw entries view for exactly that
    // reason — it is the only public way to reach the shadowed component.
    //
    const FORGE_TAB_KEY = '@deepseek-ai/dsh-experimental-client-ui-forge'
    const FORGE_TAB_SHADOW_PRIORITY = -100
    // This seat deliberately declares NO locale namespace. The renderer
    // synthesizes an entry's `t` from the namespace the ENTRY declares, and the
    // forge package declares its own dictionary namespace — which is NOT this
    // TAB_ID (the id names the slot cell, the namespace names the translations).
    // Declaring one here handed the official panel a seat with no dictionary, so
    // its whole upper half painted raw keys (`checkout.project`,
    // `changes.local.title`, `changes.empty`). The official copy is now bound
    // from the OFFICIAL entry's own namespace (officialTranslateSeat); our own
    // strings travel separately as `ourT` (see the registration in apply()).
    /** One listing request asks for the server's maximum (LS_MAX_LIMIT). */
    const BROWSE_LIST_LIMIT = 2000
    /** Grace before an unusable official entry withdraws this shadow. */
    const FORGE_TAB_GRACE_MS = 5000

    // The disposer of our shadow registration, so the fail-safe below can hand
    // the cell back to the official occupant. Null while no shadow is installed.
    let forgeTabShadowDispose = null

    /** Whether one raw slot registration is a forge tab body. */
    function isForgeTabEntry (entry) {
      return entry !== null && entry !== undefined &&
        entry.options?.key === FORGE_TAB_KEY &&
        typeof entry.component === 'function'
    }

    /**
     * The installed official tab body, or null when this deployment has none.
     *
     * Deliberately lazy (resolved per render, never captured at registration
     * time): the sidebar declares the seat once and every occupant's `inject`
     * callback runs in load order, so at our own registration moment the
     * official entry may not exist yet.
     *
     * @param {object} ctx - this plugin's client context.
     * @returns {object|null} the raw slot entry, or null.
     */
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

    // Official injected props are cached the way the renderer caches them: per
    // registration and per Session. `tabFace(sessionId)` returns fresh callback
    // identities on every call and the panel wires its streams to those, so a
    // per-render call would restart the panel's subscription.
    const forgeFaceCache = new WeakMap()

    /**
     * The official entry's injected props for one Session, or null.
     *
     * The face is kept unmodified (it still carries `hooks`); splitForgeFace
     * does the renderer-shaped conversion when the component renders.
     *
     * @param {object|null} entry - resolved official registration.
     * @param {string} sessionId - Session the tab shows.
     * @returns {object|null} the official face, or null when it cannot be built.
     */
    function forgeFaceOf (entry, sessionId) {
      if (entry === null || entry === undefined || typeof entry.inject !== 'function') return null
      let bySession = forgeFaceCache.get(entry)
      if (bySession === undefined) {
        bySession = new Map()
        forgeFaceCache.set(entry, bySession)
      }
      if (bySession.has(sessionId)) return bySession.get(sessionId)
      let face = null
      try {
        face = entry.inject(sessionId)
      } catch {
        face = null
      }
      bySession.set(sessionId, face)
      return face
    }

    /**
     * Split an official injection face into plain props and hook sources.
     *
     * The renderer converts `hooks` into `use<Name>` props for the entry it
     * renders; because this wrapper renders the official component itself it
     * must perform the same conversion, while the plain half (reconnect /
     * refresh / merge / …) passes through untouched. A `keyedHooks` face needs
     * a per-occurrence key the wrapper does not own — the forge tab has never
     * declared one, so its presence means the package changed shape and the
     * shadow must not guess what to pass.
     *
     * @param {unknown} face - official injected props.
     * @returns {{rest: object, hooks: object}|null} the split, or null when unsupported.
     */
    function splitForgeFace (face) {
      if (face === null || face === undefined || typeof face !== 'object') return null
      const { hooks, keyedHooks, ...rest } = face
      if (keyedHooks !== undefined && keyedHooks !== null && Object.keys(keyedHooks).length > 0) return null
      return { rest, hooks: hooks ?? {} }
    }

    /**
     * Whether a split face carries every hook source the official panel reads.
     *
     * The panel destructures `usePanel`, `useHost` and `useLocale`; a face that
     * stopped providing one of them is a changed package, and rendering it
     * would crash the entry (which is safe, but loses the strip for the whole
     * page session). Treating it as unusable routes it through the same
     * withdraw-the-shadow path as a missing entry instead.
     *
     * @param {{rest: object, hooks: object}|null} split - result of splitForgeFace.
     * @returns {boolean} true when every required source is observable.
     */
    function isUsableForgeSplit (split) {
      if (split === null) return false
      return ['panel', 'host', 'locale'].every((name) => {
        const source = split.hooks[name]
        return source !== null && source !== undefined &&
          typeof source.subscribe === 'function' &&
          typeof source.getSnapshot === 'function'
      })
    }

    /**
     * Whether the SEAT hands this entry the tab hook the official panel calls.
     *
     * `useTabInfo` is the one hook the official panel reads that does NOT come
     * from the official entry's own inject face: it is declared by the SIDEBAR
     * on the `sidebar.right.pane.tab` seat (`inject: { hooks: { tabInfo:
     * tabInfoFactory } }`), so the renderer synthesizes it as a slot-level
     * contextual prop and every occupant of that seat receives it — including
     * this wrapper, which then forwards it to the official component with the
     * rest of `officialProps`.
     *
     * That forwarding is exactly why it needs a check here. `isUsableForgeSplit`
     * only inspects the official face, so a future Host that renames or drops
     * the seat hook would still be judged "usable", the official component
     * would then throw on its very first line (`const { tab } = useTabInfo()`),
     * and the cell would end up dry — both registrations abdicated. Testing for
     * it up front keeps the failure inside this entry, where the same
     * withdraw-the-shadow path already renders a readable line instead.
     *
     * The check is deliberately narrow: a function is all the panel needs, and
     * this wrapper never calls it itself (the official component does, during
     * its own render).
     *
     * @param {object} props - the slot props this wrapper received.
     * @returns {boolean} true when the seat supplied a callable tab hook.
     */
    function hasSlotTabHook (props) {
      return props !== null && typeof props === 'object' && typeof props.useTabInfo === 'function'
    }

    /**
     * The copy seat the OFFICIAL panel must be rendered with.
     *
     * The renderer synthesizes an entry's `t` from the namespace THAT entry
     * declares (`kit.t = localeSeat(face, entry.locale)`). The official
     * change-request registration declares its own DICTIONARY namespace, which
     * is a different string from the package id this plugin shadows under: the
     * id names the tab cell, the namespace names the translations. Forwarding
     * the `t` OUR seat was handed therefore gave the official panel a namespace
     * with no dictionary, and the upper half painted every official key
     * literally (`checkout.project`, `changes.local.title`, `changes.empty`)
     * while the panel itself kept working. Bind the namespace the OFFICIAL
     * entry declares, from the same locale face the renderer used.
     *
     * `locale.bind(ns)` memoizes one translate per namespace and resolves the
     * active language on every call, so this needs no locale subscription of
     * its own — a language switch is picked up by the next call. An entry that
     * declares no namespace, or a locale face that cannot bind one, yields
     * null: the caller then keeps the seat it already had instead of passing
     * the panel `undefined`.
     *
     * @param {object} ctx - this plugin's client context.
     * @param {object} entry - the official registration; its `locale` field is
     *   the stored dictionary namespace.
     * @returns {Function|null} the official `t`, or null when it cannot be built.
     */
    function officialTranslateSeat (ctx, entry) {
      const namespace = entry?.locale
      if (typeof namespace !== 'string' || namespace === '') return null
      try {
        const bound = ctx?.locale?.bind?.(namespace)
        return typeof bound === 'function' ? bound : null
      } catch {
        // A locale face that cannot bind this namespace is simply absent: the
        // panel keeps its seat, and a broken dictionary can never crash the tab.
        return null
      }
    }

    /**
     * The selector-hook shape the renderer hands to an entry.
     *
     * A face's `hooks` sources are NOT values. The renderer wraps each source in
     * `observableHook`, whose product is a hook FUNCTION the entry calls during
     * its own render — `usePanel((current) => current)`. This wrapper renders
     * the official component itself, so it must hand the panel that same shape:
     * a function, not a snapshot, or the panel crashes on its first render.
     *
     * The renderer's version uses `use-sync-external-store`'s selector shim,
     * which is not a module this bundle may require (the client module table
     * exposes React and the declared client peers). The selector is therefore
     * applied on top of plain `useSyncExternalStore`: correct values, and one
     * extra render only when a selector would have returned an equal object.
     * The forge panel selects the snapshot itself or one primitive field of it,
     * so that cost does not show.
     */
    const forgeHookCache = new WeakMap()

    /** Identity selector, matching the renderer's omitted-selector behavior. */
    function identity (value) { return value }

    /**
     * One source's selector hook, cached by source identity.
     *
     * `subscribe`/`getSnapshot` are built once per source so the hook itself is
     * a stable reference across renders: the panel subscribes through it, and a
     * fresh function per render would resubscribe on every redraw.
     *
     * @param {object|undefined} source - `{getSnapshot, subscribe}` or nothing.
     * @returns {Function} `(selector, equal?) => selected`; an equal-value
     *   comparator is accepted for signature compatibility but not applied.
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

    /**
     * The hook handed over when no source exists. Kept a function so the
     * official panel's call shape never changes; the value is `undefined`, and
     * this path is only reachable when the panel is not rendered anyway.
     */
    function absentForgeHook (selector) {
      return (typeof selector === 'function' ? selector : identity)(undefined)
    }

    /**
     * The official change-request body with a recent-commit strip underneath.
     *
     * It receives exactly what the official entry would have received — the
     * session kit, this slot's own injected props, owner props — plus `ourT` and
     * `ctx`. Those props are handed to the official component verbatim,
     * together with the official entry's own injected props, so every behaviour
     * the panel had (refresh, reconnect, change-request actions, its own
     * scrollport and scroll offset) is still the panel's own. Only the strip
     * below is ours.
     *
     * @param {object} props - slot props plus this plugin's two extras.
     */
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

    // =========================================================================
    // Session list catch-up (one re-pull after a repair)
    // =========================================================================
    // The compensation in `lib/ownership.js` repairs the HOST session index and
    // re-announces every workspace's membership. Neither of those reaches the
    // browser's SESSION store: the workspace list is a follow stream, so the
    // announcement fills the GROUPS, while the rows inside them come from one
    // `session.list` pull taken when the page connected. A page that was open
    // while this plugin was disabled therefore keeps a list that predates the
    // repair: the groups appear and stay EMPTY, until a page reload pulls the
    // list again. Restarting DSH "fixed" it for exactly that reason.
    //
    // Nothing can be pushed instead: the Host forwards `api-session/added` for
    // LIVE sessions only, and the ones this repair deals with are cold. What the
    // Host does on its own is re-pull the baseline on every reconnect
    // (`handleConnected` calls `refreshList`); `sessions.refresh()` is that same
    // pull, published for callers. So the browser half of the compensation is:
    // notice that a repair pass finished, then ask for one fresh baseline.
    //
    // The second half of the trick is that the pull is VERIFIED rather than
    // assumed. `refresh()` is single-flight, so a pull already in the air is
    // reused and can return the pre-repair baseline; and a pull can fail
    // outright. Counting the workspace members that the list still cannot
    // answer for says which of those happened, and only a non-zero count buys
    // another attempt.
    //
    // Everything here is best-effort by design. It is a convenience over
    // "reload the page", so a host without the `sessions` service, a status
    // route that is down, or a listing that keeps failing must all end quietly
    // rather than leave a poll running for the life of the page.

    /** First look, after the page's own baseline pull has had time to settle. */
    const CATCH_UP_FIRST_MS = 400
    /** Steady-state interval while a pass is still running, or has not started. */
    const CATCH_UP_MAX_MS = 2000
    /** Wait after a pull before asking whether it actually answered the question. */
    const CATCH_UP_SETTLE_MS = 800
    /** Pulls allowed in total: the first, then one per still-unlisted member batch. */
    const CATCH_UP_ATTEMPTS = 3
    /**
     * How long the catch-up keeps looking, measured from the plugin's apply.
     *
     * The pass itself is bounded (`lib/ownership.js`: 10 s to list sessions, 45 s
     * to rebuild, 60 s for the claims), so this covers one that starts late and
     * then runs to its own limits. Past it the catch-up stops: a pass that never
     * finishes is the panel's business to report, not a reason to poll forever.
     */
    const CATCH_UP_DEADLINE_MS = 150000

    /**
     * Whether a finished ownership pass repaired something the browser must re-read.
     *
     * `stage` is written WHILE the pass runs, so a half-way snapshot is not a
     * verdict and must not buy a request. A finished one carries the evidence:
     * `reindexed` says the very index the membership filter runs on was replaced,
     * `reclaimed` counts rows it had to re-attach, and `published` counts
     * workspaces whose membership it re-announced. In practice an activation
     * rebuilds the index unconditionally, so this fires once per activation,
     * which is exactly the number of times the index changed under the page.
     *
     * @param {object|null|undefined} ownership - the `ownership` block of `/status`.
     * @returns {boolean} true when a session-list re-pull is warranted.
     */
    function needsSessionRelist (ownership) {
      if (ownership === null || typeof ownership !== 'object') return false
      if (ownership.stage !== 'done') return false
      if (ownership.indexRebuilt === 'reindexed') return true
      if (Number(ownership.reclaimed) > 0) return true
      if (Number(ownership.published) > 0) return true
      return false
    }

    /**
     * Ask the browser's session store for one fresh baseline.
     *
     * The returned promise is never awaited: the panel must not wait for a
     * listing to render, and a listing that fails is the store's own state
     * (`phase: 'error'`), not something to surface here. It is also the promise
     * that can reject, so it is drained explicitly: an unhandled rejection would
     * reach the page console for a repair that is merely a convenience.
     *
     * @param {object} ctx - client root context.
     * @returns {boolean} true when a refresh was actually requested.
     */
    function relistSessions (ctx) {
      try {
        const sessions = ctx?.get?.('sessions')
        if (typeof sessions?.refresh !== 'function') return false
        const pending = sessions.refresh()
        if (pending !== null && typeof pending?.then === 'function') pending.then(() => {}, () => {})
        return true
      } catch { /* a host without the service keeps whatever list it has */ return false }
    }

    /**
     * Count sessions a REMOTE workspace claims that the browser's list cannot answer.
     *
     * Both snapshots are read defensively: this runs beside the live UI, and a
     * store that has not pulled yet (`phase: 'pending'`) is not evidence of a
     * defect. An unreadable store therefore reports zero, which ends the
     * catch-up instead of polling something that cannot be measured.
     *
     * @param {object} ctx - client root context.
     * @returns {number} how many claimed ids have no summary; 0 when unknowable.
     */
    function missingGroupedSessions (ctx) {
      try {
        const list = ctx?.get?.('sessions')?.list?.getSnapshot?.()
        const items = ctx?.get?.('workspaces')?.list?.getSnapshot?.()?.items
        if (list?.phase === 'pending' || !Array.isArray(items)) return 0
        const byId = list?.byId
        if (byId === null || typeof byId !== 'object') return 0
        let missing = 0
        for (const item of items) {
          if (typeof item?.path !== 'string' || !item.path.startsWith('ssh://')) continue
          for (const id of Array.isArray(item.sessionIds) ? item.sessionIds : []) {
            if (typeof id === 'string' && id !== '' && !Object.hasOwn(byId, id)) missing += 1
          }
        }
        return missing
      } catch { return 0 }
    }

    /**
     * Watch `/status` for a finished repair pass, then re-pull the session list.
     *
     * One instance per `apply`: a re-enable is a new apply, so the latch that
     * makes this "once per pass" is the closure's own and cannot leak between
     * materializations. `stop()` is the disposer: it must end both the polling
     * and any pending settle timer, or a disabled plugin would keep fetching.
     *
     * @param {object} ctx - client root context.
     * @returns {{ start: () => void, stop: () => void }} the catch-up handle.
     */
    function createSessionCatchUp (ctx) {
      let started = false
      let stopped = false
      let timer = null
      let attempts = 0
      let deadline = 0
      let wait = CATCH_UP_FIRST_MS

      const stop = () => {
        stopped = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }

      const schedule = (run, ms) => {
        timer = setTimeout(run, ms)
      }

      /** Count what the pull still cannot answer, and pull again while that helps. */
      const settle = () => {
        timer = null
        if (stopped) return
        const missing = missingGroupedSessions(ctx)
        if (missing === 0 || attempts >= CATCH_UP_ATTEMPTS || Date.now() >= deadline) {
          stop()
          return
        }
        attempts += 1
        relistSessions(ctx)
        schedule(settle, CATCH_UP_SETTLE_MS)
      }

      /** Poll `/status` until a pass that repaired something has finished. */
      const awaitPass = async () => {
        timer = null
        if (stopped) return
        let ownership = null
        try {
          ownership = (await fetchJson(API.status))?.ownership ?? null
        } catch { /* status unavailable: keep looking until the deadline */ }
        if (stopped) return
        if (needsSessionRelist(ownership)) {
          attempts = 1
          relistSessions(ctx)
          schedule(settle, CATCH_UP_SETTLE_MS)
          return
        }
        if (Date.now() >= deadline) {
          stop()
          return
        }
        wait = Math.min(Math.round(wait * 1.6), CATCH_UP_MAX_MS)
        schedule(awaitPass, wait)
      }

      const start = () => {
        if (started) return
        started = true
        deadline = Date.now() + CATCH_UP_DEADLINE_MS
        schedule(awaitPass, CATCH_UP_FIRST_MS)
      }

      return { start, stop }
    }

    // =========================================================================
    // Plugin apply
    // =========================================================================
    const PANEL_ID = 'ssh-workspace'
    const PANEL_ORDER = 45

    let translate = makeTranslate(zh)

    const inject = ['slots', 'locale']

    /**
     * Take the three boot chunks, then fill in the bindings the sections above
     * were written against.
     *
     * A cordis `apply` may be async — `cordis/lib/index.js` `_execute` unwraps a
     * returned promise and collects what it resolves to as the disposer — and
     * the sidebar row cannot be registered before its glyph and its label exist.
     * So the load happens first and in one place: three chunks, then one
     * `Object.assign` per group over the `let` bindings declared by their stub
     * sections.
     *
     * `republishBootNames` is not optional. `Object.assign(exports, …)` at the
     * bottom of this file copies VALUES, and at that moment every boot binding
     * is still its stand-in — `() => null` for the glyphs, `() => undefined` for
     * the provenance line. A chunk that destructured the exports before this
     * ran would hold those stand-ins forever and quietly draw nothing. So the
     * twelve names that live in the boot chunks are copied AGAIN here, after
     * they have real values.
     *
     * Failure is loud on purpose. A draft that swallowed it would register a
     * panel with no stylesheet and no strings, which looks like a broken plugin
     * rather than a failed download; the rejection propagates to the loader,
     * which reports the package as failed to load.
     *
     * @returns {Promise<void>} resolves once every boot chunk is in place.
     */
    async function loadBootChunks () {
      const [locale, styles, icons, queue] = await Promise.all([
        localeModule(),
        stylesModule(),
        iconsModule(),
        queueModule(),
      ])
      ;({ NS, zh, en, applyParams, makeTranslate, relativeTimeText, provenanceText } = locale)
      ;({ injectStyles } = styles)
      ;({
        REMOTE_MARK_VIEWBOX, RemoteMarkIcon, ServerIcon, FolderIcon, GlobeIcon,
        ArrowLeftIcon, CloseIcon, RefreshIcon, ChevronIcon, TRAY_BASE_PATH,
        TRAY_ARROW_PATHS, DownloadIcon, UploadIcon, TransferProgressIcon,
      } = icons)
      ;({
        TRANSFER_QUEUE_LIMIT_TOTAL, TRANSFER_QUEUE_LIMIT_PER_HOST, TRANSFER_QUEUE_UPLOAD_LIMIT,
        queueReduce, queueDrain, queueItemPercent, orderedTransferQueueItems,
        splitOversizeFiles, transferQueueActiveCount, transferQueueIsTerminal,
        transferQueueNextSpeed, transferQueueProgress, truncateTransferName,
      } = queue)
      republishBootNames()
    }

    /** Re-copy the names the boot chunks own, now that they hold real values. */
    function republishBootNames () {
      Object.assign(exports, {
        CloseIcon,
        FolderIcon,
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
        // The queue's readers live in `client.transfer-queue.js`, which
        // destructures them. Without this line it would receive the stand-ins
        // `Object.assign(exports, …)` published at evaluation time — an empty
        // percent and an always-false terminal test, with no error anywhere.
        orderedTransferQueueItems,
        queueItemPercent,
        transferQueueIsTerminal,
        truncateTransferName,
      })
    }

    async function apply (ctx) {
      await loadBootChunks()
      // `translate` closes over the table that has just arrived.
      translate = makeTranslate(zh)
      injectStyles()
      trackTriggerRects()
      installRemoteWorkspaceMarks(ctx)
      const detachBridges = installComposerBridges(ctx)
      refreshRemoteWorkspaceMarks()
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

      // Cordis unmounts a plugin by calling the disposer `apply` returns. The
      // document-level gesture listeners are not owned by any ctx.effect, so
      // without this they would outlive the materialization that installed
      // them and every later one would stack on top.
      return () => {
        clearTimeout(transferActionsProbe)
        sessionCatchUp.stop()
        detachBridges()
      }
    }

    // The chunks reach back through these. `require('<plugin id>')` from a chunk
    // returns this object (tests/client-chunk-smoke.mjs), so every name a chunk
    // destructures has to be listed here — a missing one is a ReferenceError at
    // the moment a user opens a dialog, not at load.
    Object.assign(exports, {
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
      // ...and the picker's listing cap, which is a constant both halves read.
      BROWSE_LIST_LIMIT,
      // ...these are for the change-request history chunk.
      fetchJson,
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
      ReportDialog,
      notifyUser,
      toastError,
      useTransferActionsSlot,
      syncRemoteWorkspaceMarks,
      refreshRemoteWorkspaceMarks,
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
