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
      // Hosts switched off by the panel's power switch. A switched-off host is
      // not detached (the workspace record is untouched), but every session and
      // workspace under it is unusable until it is switched on: the same dim
      // treatment, a different reason, and the reason has to be recoverable by
      // the user with one click — so the attribute below is a HINT, never a lock.
      hostOffIds: new Set(),
      hostOffTitles: new Set(),
      hostOffSessionIds: new Set(),
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
    function collectRemoteWorkspaces (items, disabledPaths, complete = false, disabledHosts = undefined) {
      const disabled = new Set(Array.isArray(disabledPaths) ? disabledPaths : [])
      const offHosts = new Set(Array.isArray(disabledHosts) ? disabledHosts : [])
      knownDisabledPaths.clear()
      for (const path of disabled) knownDisabledPaths.add(path)
      const ids = new Set()
      const titles = new Set()
      const localTitles = new Set()
      const disabledIds = new Set()
      const disabledTitles = new Set()
      const disabledSessionIds = new Set()
      const hostOffIds = new Set()
      const hostOffTitles = new Set()
      const hostOffSessionIds = new Set()
      /** The alias an ssh:// path names, or ''. */
      const aliasOf = (remotePath) => {
        const match = /^ssh:\/\/([^/]+)\//u.exec(remotePath)
        return match === null ? '' : match[1]
      }
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
        // A workspace whose HOST is switched off: the row and its sessions dim,
        // and the tooltip names the switch rather than a lost host. Resolved in
        // the same pass, from the same ids, exactly like detachment above.
        if (offHosts.has(aliasOf(item.path))) {
          if (id !== undefined && id !== null && String(id) !== '') hostOffIds.add(String(id))
          if (title !== '') hostOffTitles.add(title)
          if (segment !== '') hostOffTitles.add(segment)
          for (const sessionId of Array.isArray(item.sessionIds) ? item.sessionIds : []) {
            if (sessionId !== undefined && sessionId !== null && String(sessionId) !== '') hostOffSessionIds.add(String(sessionId))
          }
        }
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
      remoteMarks.hostOffIds = hostOffIds
      remoteMarks.hostOffTitles = hostOffTitles
      remoteMarks.hostOffSessionIds = hostOffSessionIds
      // Diagnostic (see __sshwspProbe in the main bundle): the sidebar rows
      // only carry an id or a title, so what the marks actually learned from
      // /status is not visible from the DOM when a row stays bright.
      globalThis.__sshwspMarks = () => ({
        hosts: [...remoteMarks.hostOffIds],
        titles: [...remoteMarks.hostOffTitles],
        sessions: [...remoteMarks.hostOffSessionIds],
      })
    }

    /**
     * Whether one displayed title identifies a REMOTE workspace.
     *
     * Sidebar rows carry a workspace id, but the picker menu and the hero chip
     * carry nothing but the label, so those surfaces have to match by title.
     * A title a local workspace also uses cannot decide anything: the same
     * directory name exists on both sides (`dsh-ssh-workspace` checked out here
     * and mounted from a host), and matching it hands the local row the remote
     * mark — or, for a detached workspace, dims a local row that has nothing
     * to do with it.
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
    /** Whether one displayed title belongs to a workspace whose host is switched off. */
    function hostOffTitleMatch (text) {
      if (!remoteMarks.titlesSettled) return false
      return text !== '' && remoteMarks.hostOffTitles.has(text) && !remoteMarks.localTitles.has(text)
    }
    /** Update the mark source from a /status reply (panel fetch, flow completion). */
    function syncRemoteWorkspaceMarks (entries, disabledPaths, disabledHosts = undefined) {
      collectRemoteWorkspaces(entries, disabledPaths, false, disabledHosts)
      scheduleRemoteMarks()
    }

    /** Fetch /status once and refresh the fallback mark source from it. */
    async function refreshRemoteWorkspaceMarks () {
      try {
        const data = await fetchJson(API.status)
        syncRemoteWorkspaceMarks(data.workspaces, data.disabled, data.disabledHosts)
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
        // The attribute is the whole treatment: the stylesheet dims the row,
        // and nothing here takes the click away — see "Nothing is disabled
        // here" in client.styles.js.
        const detached = remoteMarks.disabledIds.has(id) || detachedTitleMatch(title)
        if (detached) row.setAttribute('data-sshwsp-disabled', '1')
        else if (row.hasAttribute('data-sshwsp-disabled')) row.removeAttribute('data-sshwsp-disabled')
        // A host switched off is a different reason for the same dimming: the
        // workspace is not detached, it just cannot reach its host. Separate
        // attribute so the tooltip/style can say which one it is.
        const hostOff = remoteMarks.hostOffIds.has(id) || hostOffTitleMatch(title)
        if (hostOff) row.setAttribute('data-sshwsp-hostoff', '1')
        else if (row.hasAttribute('data-sshwsp-hostoff')) row.removeAttribute('data-sshwsp-hostoff')
      }

      // Session rows inside those groups, keyed `session:<sessionId>`. A
      // detached workspace's sessions keep their place in the group and get the
      // same dimming as the header above them — and the same freedom: the row
      // still opens the session, because the state is a hint, not a lock.
      for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
        const id = (row.getAttribute('data-row-key') ?? '').slice('session:'.length)
        const detached = id !== '' && remoteMarks.disabledSessionIds.has(id)
        if (detached) row.setAttribute('data-sshwsp-disabled', '1')
        else if (row.hasAttribute('data-sshwsp-disabled')) row.removeAttribute('data-sshwsp-disabled')
        const hostOff = id !== '' && remoteMarks.hostOffSessionIds.has(id)
        if (hostOff) row.setAttribute('data-sshwsp-hostoff', '1')
        else if (row.hasAttribute('data-sshwsp-hostoff')) row.removeAttribute('data-sshwsp-hostoff')
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

    /**
     * How often returning to the window may re-read `/status`.
     *
     * Focus and visibilitychange fire together on most platforms, and both can
     * fire on every alt-tab, so one poll per couple of seconds is the ceiling.
     */
    const MARKS_WAKE_INTERVAL_MS = 2000

    /**
     * Re-sync the mark source whenever the page comes back into view.
     *
     * The decoration is written by a pass that runs on a DOM mutation or when a
     * caller hands it fresh data. Every caller is a user action inside this
     * window, so a workspace enabled somewhere else — another window, a second
     * profile, the CLI — leaves its rows wearing the detached marks with
     * nothing scheduled to revisit them: `pointer-events: none` on the session
     * row, dimmed text, and a click that does nothing at all. That reads as a
     * broken session, not as a stale decoration, and the only fix left to the
     * user is reloading the page.
     *
     * Coming back to the window is the cheapest moment to re-read `/status`,
     * and it lands before the user's next click. The re-read is what makes this
     * self-healing: a bare pass would repaint from the last known disabled
     * list, which is exactly the stale input that caused the problem.
     */
    function installMarkWakeups () {
      if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
      let lastAt = 0
      const wake = () => {
        const now = Date.now()
        if (now - lastAt < MARKS_WAKE_INTERVAL_MS) return
        lastAt = now
        void refreshRemoteWorkspaceMarks()
      }
      const onVisibility = () => {
        if (document.visibilityState === 'visible') wake()
      }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('focus', wake)
      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('focus', wake)
      }
    }

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
      const stopWakeups = installMarkWakeups()
      return () => {
        if (marksObserver !== observer) return
        observer.disconnect()
        marksObserver = null
        stopWakeups()
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
