/**
 * The remote-workspace marks pass: the sidebar and menu decoration.
 *
 * DSH draws every workspace with its own folder glyph and its slot ledger has no
 * seat for row icons, so an SSH-backed workspace gets that glyph swapped for the
 * remote mark after the fact. The decoration stays React-safe: React-owned nodes
 * are never removed or re-parented — the folder glyph is only hidden through an
 * inline style React never rewrites, our own svg is inserted beside it, and a
 * MutationObserver re-applies the swap whenever React replaces the nodes
 * underneath.
 *
 * Why this is a module: the whole pass owns its state (`remoteMarks`,
 * `marksCtx`, `markPassQueued`) and nobody outside reads any of it. It runs in
 * `loadBootChunks`, not lazily, because `installRemoteWorkspaceMarks` has to be
 * observing before the first paint — decoration that arrives on the second frame
 * is a visible flicker.
 *
 * It borrows three names: the viewBox the marks share with the remote-mark icon,
 * the tree-row selector, and the row-kind reader. All three are things the
 * composer bridge uses too, which is why they stayed in the bundle.
 */

window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.marks.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const {
      API,
      fetchJson,
      REMOTE_MARK_VIEWBOX,
      TREE_ROW_SELECTOR,
      rowReferenceKind,
    } = require('@shiqyka/dsh-ssh-workspace')

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
    let markPassTimer = 0
    let lastMarkPassAt = 0

    /**
     * How often the decoration pass may run, at most.
     *
     * It is deliberately slower than a frame: streaming output produces a
     * characterData record per token, and one full-document scan per frame is
     * still ~60 scans a second for decoration nobody can read that fast. The
     * window coalesces a burst into a handful of passes while staying below
     * the threshold where a menu or a drop target feels stale.
     */
    const MARKS_MIN_INTERVAL_MS = 120

    /** Coalesce a mutation burst into one pass, no more often than the window. */
    function scheduleRemoteMarks () {
      if (markPassQueued || typeof window === 'undefined') return
      markPassQueued = true
      const run = () => {
        markPassTimer = 0
        markPassQueued = false
        lastMarkPassAt = Date.now()
        try { passRemoteMarks() } catch { /* decoration must never break the app */ }
      }
      const wait = Math.max(0, MARKS_MIN_INTERVAL_MS - (Date.now() - lastMarkPassAt))
      if (wait === 0) {
        window.requestAnimationFrame(run)
        return
      }
      markPassTimer = window.setTimeout(() => {
        markPassTimer = 0
        window.requestAnimationFrame(run)
      }, wait)
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

    /** The one observer this module owns, so a re-apply replaces it. */
    let marksObserver = null

    /** Observe the app shell so the swap survives React re-renders. */
    function installRemoteWorkspaceMarks (ctx) {
      marksCtx = ctx
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      // Idempotent: a hot reload or a second apply must not leave the previous
      // observer watching document.body forever (its callback kept `marksCtx`
      // and the whole module alive).
      marksObserver?.disconnect()
      const observer = new MutationObserver((records) => {
        if (records.some(mutationTouchesMarks)) scheduleRemoteMarks()
      })
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        // The old value is never read: it would make every streamed token carry
        // a full copy of the text it replaced.
        characterDataOldValue: false,
      })
      marksObserver = observer
      return () => {
        if (marksObserver !== observer) return
        observer.disconnect()
        marksObserver = null
        if (markPassTimer !== 0 && typeof window !== 'undefined') {
          window.clearTimeout(markPassTimer)
          markPassTimer = 0
        }
        markPassQueued = false
      }
    }

    // The three entry points the bundle and the add-workspace chunk call.
    Object.assign(exports, {
      installRemoteWorkspaceMarks,
      refreshRemoteWorkspaceMarks,
      scheduleRemoteMarks,
      syncRemoteWorkspaceMarks,
    })
    return module.exports
  },
})
