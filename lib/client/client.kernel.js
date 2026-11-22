/**
 * The browser half's stateless bottom layer.
 *
 * Every declaration below is shared plumbing that owns no state: the API table,
 * the fetch helper, the tree selection's wiring, the chunk uploader, the picker
 * entry points, the menus' DOM readers, the forge-tab reflection.
 *
 * The boundary was measured, not chosen. From each declaration, walk everything
 * it references. A declaration may only move if that walk reaches no module-level
 * `let` — a rebinding would leave this file holding a stale copy, with no error
 * anywhere — and no name that must be a real value before `apply` runs: the
 * `lazyDialog` family (built at module evaluation), `inject` (cordis reads it
 * before calling `apply`), and the per-chunk loaders. What survived is exactly
 * what is here.
 *
 * The seam runs ONE way. This file borrows nothing: it destructures no name from
 * the bundle and mentions none of them. The bundle takes 117 names back
 * through `loadBootChunks()`, before it registers a single slot. That direction is
 * what makes the cut safe rather than merely smaller — the bottom of a stack is
 * allowed to be used by everything above it, and forbidding the reverse is the
 * rule that keeps a split from turning into a cycle.
 *
 * It is a boot chunk, not a lazy one: the first thing the panel does is call in
 * here.
 *
 * What is NOT here, and it is the interesting half: `apply` itself, the drag and
 * menu bridges it installs on `document`, the transfer-queue store and its
 * workers, the row-action and rename handles, the toast timer, `translate`. Those
 * own interactive state, and state is what cannot cross this seam.
 */

window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.kernel.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createPortal } = require('react-dom')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')

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
      // The editor's three doors: read one text file (with the tokens a save
      // needs), save the whole buffer, and replace one literal inside it.
      readText: '/api/dsh-ssh-workspace/read-text',
      writeText: '/api/dsh-ssh-workspace/write-text',
      editText: '/api/dsh-ssh-workspace/edit-text',
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
     * A JSON request whose STATUS matters to the caller.
     *
     * `fetchJson` deliberately collapses every failure into an Error carrying
     * the server's sentence, which is right for the panel's ordinary actions:
     * all they can do with a failure is show it. The editor cannot — a 409 is
     * not an error to report, it is a state to recover from, and the body that
     * comes with it (`current.version`, `current.revision`) is the only thing
     * that makes recovery possible without a blind reload. So this variant
     * returns the status and the parsed body, and throws only when the request
     * itself failed.
     *
     * @returns {Promise<{status: number, ok: boolean, data: object|undefined}>}
     */
    async function requestJson (url, init) {
      const res = await fetch(url, init)
      const text = await res.text().catch(() => '')
      let data
      try { data = text === '' ? undefined : JSON.parse(text) } catch { data = undefined }
      return { status: res.status, ok: res.ok, data }
    }

    /**
     * Read the diagnostic report's bytes.
     *
     * Separate from the copy/open handlers because BOTH need the same text and
     * the same failure path, and a second `fetch` spelling would drift: the
     * report route answers `text/plain`, not JSON, so `fetchJson` cannot be
     * reused and its error extraction has to be repeated here.
     *
     */
    async function fetchReportText () {
      const res = await fetch(API.supportBundle)
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || res.statusText)
      return await res.text()
    }

    // 830 lines of dictionaries plus three pure helpers, and the boot path needs
    // them only to translate the sidebar label. They live in `client.locale.js`;
    // `apply` awaits that chunk and fills the bindings below in BEFORE it
    // registers a single slot, so nothing can ask for a string that has not
    // arrived. The stand-ins return the key itself, which is what a missing
    // dictionary already renders as.

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
     * @param {number} current - index of the focused item, or -1.
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
     * @param {Array<{name: string, type: string}> | null} options.listing - that directory's rows.
     */

    function capabilityNotes (capabilities, t) {
      const notes = []
      if (capabilities.rg === false) notes.push(t('caps.rg'))
      if (capabilities.git === false) notes.push(t('caps.git'))
      if (capabilities.inotifywait === false) notes.push(t('caps.inotifywait'))
      return notes
    }

    // The panel is 1,551 lines that only exist once the sidebar row is clicked.
    // It lives in `client.panel.js`, fetched the first time the `main` slot is
    // asked for a component.
    //
    // `Suspense` is not decoration here. A lazy component whose chunk fails to
    // arrive rejects, and this bundle has no error boundary, so the rejection
    // would take down the whole plugin surface. The `main` slot receives
    // `PanelSlot` instead of the panel itself; it owns the boundary and renders
    // nothing while the chunk is in flight or after it failed.

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

    const FLOW_MENU_WIDTH = 220
    /** The add-workspace chooser keeps descriptions, so it keeps more room. */
    const FLOW_MENU_WIDTH_ROOMY = 250

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
     * @returns {boolean} true when at least one reference was inserted.
     */

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
     * @param {'ok'|'err'|'muted'} [kind] - explicit face, when the caller uses the old signature.
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
     */
    function toastActionOf (target) {
      let node = target
      while (node !== null && node !== undefined) {
        if (typeof node.getAttribute === 'function' && node.getAttribute('data-toast-action') !== null) return node
        node = node.parent === undefined ? null : node.parent
      }
      return null
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
     */

    const transferQueueListeners = new Set()
    /** id -> the live handle the UI uses to ask a worker to stop. */
    const transferQueueWorkers = new Map()
    function subscribeTransferQueue (listener) {
      if (typeof listener !== 'function') return () => {}
      transferQueueListeners.add(listener)
      return () => { transferQueueListeners.delete(listener) }
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

    const transferActionsSlotListeners = new Set()

    function subscribeTransferActionsSlot (listener) {
      if (typeof listener !== 'function') return () => {}
      transferActionsSlotListeners.add(listener)
      return () => { transferActionsSlotListeners.delete(listener) }
    }

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
     * @param {(bytes: number) => void} [onProgress] - called with the running count.
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
     * @param {boolean} [isDir] - whether the row is a directory.
     */

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
     * @param {number} startedAt - when the request began (ms).
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
     * @param {File} file - the bytes.
     * @param {number} [hooks.attempt] - 0 for the first attempt, >0 for a retry.
     * @param {(bytes: number) => void} [hooks.onProgress] - bytes accepted.
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
     * @param {(counts: object) => void} [onProgress] - called after every listing
     *   that added something, so a slow tree can report what it has so far
     *   instead of leaving the dialog sitting on a spinner.
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
     */

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

    function focusTreeCursor (container, index) {
      if (index === null || index === undefined) return
      const rows = treeSelectableRows(container)
      const row = rows[index]
      if (row === undefined) return
      const button = row.querySelector('button')
      if (button !== null && typeof button.focus === 'function') button.focus()
    }

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
     * @returns {object|null} the raw slot entry, or null.
     */

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
     * @returns {Function} `(selector, equal?) => selected`; an equal-value
     *   comparator is accepted for signature compatibility but not applied.
     */

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
     */

    // The compensation in `lib/surface/ownership.js` repairs the HOST session index and
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

    const PANEL_ID = 'ssh-workspace'
    const PANEL_ORDER = 45

    // ---------------------------------------------------------------------------
    // The surface. The bundle destructures exactly these names in
    // `loadBootChunks()`, and `tests/client-chunk-smoke.mjs` asserts the two
    // lists agree — a missing name is `undefined` at the first click, not a load
    // error, which is the failure mode this project has hit four times.
    Object.assign(exports, {
      API,
      BROWSE_LIST_LIMIT,
      COMPOSER_CARD_SELECTOR,
      DELETE_COUNT_LIMIT,
      DRAG_MIME,
      FLOW_MENU_WIDTH,
      FLOW_MENU_WIDTH_ROOMY,
      FLOW_PRIORITY,
      FORGE_TAB_GRACE_MS,
      FORGE_TAB_KEY,
      FORGE_TAB_SHADOW_PRIORITY,
      MENU_GLYPH_PATHS,
      OS_TREE_SELECTOR,
      PANEL_ID,
      PANEL_ORDER,
      PATH_PREVIEW_DEBOUNCE_MS,
      TASK_MENU_ATTR,
      TOAST_DISMISS_MS,
      TREE_BODY_SELECTOR,
      TREE_ROW_SELECTOR,
      absentForgeHook,
      applyTreeSelection,
      backdropDismiss,
      blankMenuScopeOf,
      capabilityNotes,
      childDirectoryPath,
      clearOsDropHighlight,
      clearTreeTextSelection,
      countDeleteContents,
      createMenuSeparator,
      createSessionCatchUp,
      directoryDraft,
      directoryPath,
      draftDirectoryTarget,
      dropFolderNames,
      dropOffsetFromEvent,
      dropPointFromEvent,
      entryNameOf,
      fetchJson,
      fetchReportText,
      requestJson,
      filesTransferOf,
      firstClaim,
      focusSoleComposer,
      focusTreeCursor,
      focusableWithin,
      focusedElement,
      forgeFaceOf,
      forgeHookCache,
      formatBytes,
      hasSlotTabHook,
      hideDropCaret,
      identity,
      isForgeTabEntry,
      isNetworkFailure,
      isUsableForgeSplit,
      joinLocalPath,
      localBlankTargetOf,
      makeLocalPicker,
      mentionToken,
      modalLayer,
      mutationPolicyOf,
      narrowDirectoryEntries,
      nextMenuIndex,
      normalizeRoot,
      officialTranslateSeat,
      osDropPlan,
      pickDirTarget,
      pickFileTarget,
      pickLocalFiles,
      postFileInChunks,
      postUploadChunk,
      randomHexId,
      readComposerRoot,
      readResponseBlob,
      referenceFor,
      refreshFilesPanel,
      rememberTreeSelection,
      remoteDirOf,
      remoteTargetOf,
      renameAnchorOf,
      resolveBrowseFlow,
      resolveComposerTarget,
      resolveTargets,
      resolveTreeAnchor,
      responseErrorText,
      rowOfPath,
      rowReferenceKind,
      saveViaAnchor,
      selectToastDetail,
      setOsDropHighlight,
      showDropCaret,
      splitDroppedFolders,
      splitForgeFace,
      streamIntoHandle,
      subscribeTransferActionsSlot,
      subscribeTransferQueue,
      toastActionOf,
      toastCopyText,
      toastError,
      toastModel,
      transferActionsSlotListeners,
      transferCancelledError,
      transferPausedError,
      transferQueueListeners,
      transferQueueWorkers,
      treeAnchorPath,
      treeContainerOf,
      treeRootOf,
      treeRootOfContainer,
      treeRowModel,
      treeRowSelectable,
      treeScopeKeyOf,
      treeSelectableRows,
      treeSelectedItems,
      treeSelectionContainers,
      treeSelectionScopes,
      treeSelectionStates,
    })
    return module.exports
  },
})
