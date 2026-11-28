window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.panel.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')

    // The panel is the one surface that is always on screen once the sidebar row
    // is clicked, but it is still not needed to BOOT the plugin: the sidebar row
    // and the file-tree bridges are. Splitting it out keeps 1,551 lines of
    // dashboard out of the parse that every page load pays for.
    //
    // Everything below is reached through the main bundle by package id
    // (tests/client-chunk-smoke.mjs proves that channel). The list is longer
    // than the dialogs' because the panel is the plugin's centre: it renders
    // the host cards, opens the three dialogs, drives the transfer-queue entry,
    // and repaints the sidebar marks after every status poll.
    const {
      API,
      fetchJson,
      fetchReportText,
      RemoteMarkIcon,
      GitHubIcon,
      ExternalLinkIcon,
      relativeTimeText,
      provenanceText,
      DialogSlot,
      DirectoryBrowser,
      HostEditor,
      HostPowerDialog,
      ReportDialog,
      notifyUser,
      toastError,
      useTransferActionsSlot,
      syncRemoteWorkspaceMarks,
      capabilityNotes,
      // Published by the main bundle: the tree bridge decides synchronously, so
      // every saved preference has to reach it without a reload.
      applyPreferences,
  noteServerCompatibility,
    } = require('@shiqyka/dsh-ssh-workspace')

    // =========================================================================
    // Main panel
    // =========================================================================
    /** The local URL a forward is reachable at. */
    /**
     * Where the panel's three exits and its one ask point.
     *
     * Hard-coded because the browser bundle cannot read package.json, and pinned by
     * `tests/client-shape-smoke.mjs` against the package's own `repository` field —
     * a repository that moves shows up as a red test instead of a 404 a user finds.
     * `tree/main` and `blob/main` are spelled out rather than derived: a link that
     * guesses the default branch sends readers to a 404 on a repository that renamed
     * it, and the branch is a fact, not a computation.
     */
    const REPOSITORY_URL = 'https://github.com/siqyka/dsh-ssh-workspace'
    const ABOUT_LINKS = Object.freeze({
      star: REPOSITORY_URL,
      items: Object.freeze([
        // No "repository" link: the Star row above already IS one, and two ways out
        // to the same page in one strip read as two different destinations.
        Object.freeze({ key: 'about.docs', href: `${REPOSITORY_URL}/tree/main/docs` }),
        Object.freeze({ key: 'about.changelog', href: `${REPOSITORY_URL}/blob/main/CHANGELOG.md` }),
      ]),
    })
    function forwardUrlOf (forward) {
      const host = forward.localHost === '0.0.0.0' || forward.localHost === '::' ? 'localhost' : forward.localHost
      return `http://${host}:${forward.localPort}`
    }

    /**
     * The host alias a `ssh://` workspace path belongs to, or null.
     *
     * A one-line parse on purpose, not the kernel's `remoteTargetOf`: that name is
     * filled in by the boot chunks, and this file is a chunk that loads later, so
     * borrowing it would make the panel depend on the republish list — the exact
     * trap that turned the marks calls into silent no-ops. Only the alias is needed
     * here, and it is the leading segment by definition.
     */
    function workspaceAliasOf (workspacePath) {
      const match = /^ssh:\/\/([^/]+)\//u.exec(String(workspacePath))
      return match === null ? null : match[1]
    }

    /**
     * The alias of a workspace whose host is no longer in the host list, or null.
     *
     * The host list is the only authority: a workspace pointing at an alias that is
     * not in it cannot be connected to at all, so every operation on it fails with
     * an unknown-host error rather than anything the user can act on. The red mark
     * names that cause before the failure does.
     *
     * Only consulted when the listing is COMPLETE. An unreadable store, or config
     * entries skipped while parsing, would turn "I could not look" into "it is
     * gone" — and a red mark nobody can explain is worse than no mark.
     */
    function missingHostOf (workspacePath, knownAliases, listingComplete) {
      if (!listingComplete) return null
      const alias = workspaceAliasOf(workspacePath)
      if (alias === null) return null
      return knownAliases.has(alias) ? null : alias
    }

    /**
     * The red exclamation shown before a workspace whose host is gone.
     *
     * `role="img"` plus `aria-label`, not a bare glyph: an exclamation mark read as
     * text says nothing about which host is missing, and a `title` alone is
     * unreachable from a keyboard.
     */
    function MissingHostMark ({ alias, text }) {
      const label = text.replace('{alias}', alias)
      return jsx('span', {
        className: 'sshwsp-hostgone',
        role: 'img',
        'aria-label': label,
        title: label,
        children: '!',
      })
    }

    // Ids for the tip bubbles. A module counter, not React.useId: this chunk is
    // loaded into whatever React the Host ships, and the mark only has to be
    // unique among the marks on screen — it never crosses a hydration boundary
    // where a server-rendered id would have to match.
    let tipSeq = 0

    /**
     * An explanation kept one gesture away, for a rule too long to sit inline.
     *
     * A `title` attribute was the previous answer and it failed twice: a tooltip
     * that only appears on hover is unreachable from a keyboard, and a rule the
     * user never hovers is a rule the user never learns. The mark is therefore
     * focusable and the bubble opens on focus as well, with the text wired up
     * through `aria-describedby` so it is read out rather than only shown.
     *
     * `preventDefault` on click matters: one of the three call sites sits inside
     * a `<label>`, where a click on a focusable child would otherwise toggle the
     * checkbox the explanation belongs to.
     *
     * Only static text belongs here. A live value — a port probe result, a save
     * outcome — has to stay on screen; hiding it behind a gesture means the user
     * sees the consequence without the cause.
     */
    function TipMark ({ label, text }) {
      const idRef = React.useRef(null)
      if (idRef.current === null) {
        tipSeq += 1
        idRef.current = `sshwsp-tip-${tipSeq}`
      }
      const id = idRef.current
      return jsxs('span', {
        className: 'sshwsp-tipwrap',
        children: [
          jsx('span', {
            className: 'sshwsp-tipmark',
            tabIndex: 0,
            'aria-label': label,
            'aria-describedby': id,
            onClick: (event) => { event.preventDefault() },
            children: '?',
          }),
          jsx('span', { className: 'sshwsp-tip', id, role: 'tooltip', children: text }),
        ],
      })
    }

    /**
     * The two questions "delete" asks, rendered inside the armed row.
     *
     * Both start checked — that is what the word means — and both can be cleared
     * independently, because the four combinations are all legitimate answers:
     * drop the record and take its sessions out too, drop the record but leave the
     * sessions where they are, or keep the record and only clear the sessions.
     * With both cleared there is nothing left to do, so the caller disables the
     * confirm button instead of quietly doing one of the two.
     *
     * The sessions box says ARCHIVE in its tooltip: DSH has no session-delete API,
     * so the files stay on disk and only the listing entries go away. Promising a
     * deletion that does not happen is worse than a wordier tooltip.
     *
     * `t` is a prop for the same reason it is on `MissingHostMark`: this is module
     * scope inside the chunk, and the translator arrives with the panel's props.
     */
    function DiscardChoices ({ t, record, sessions, busy, onRecord, onSessions }) {
      return jsxs(Fragment, { children: [
        jsx('label', {
          className: 'sshwsp-check',
          title: t('workspace.deleteRecordHint'),
          children: [
            jsx('input', {
              type: 'checkbox',
              checked: record,
              disabled: busy,
              onChange: (event) => onRecord(event.target.checked),
            }),
            jsx('span', { children: t('workspace.deleteRecord') }),
          ],
        }),
        jsx('label', {
          className: 'sshwsp-check',
          title: t('workspace.deleteSessionsHint'),
          children: [
            jsx('input', {
              type: 'checkbox',
              checked: sessions,
              disabled: busy,
              onChange: (event) => onSessions(event.target.checked),
            }),
            jsx('span', { children: t('workspace.deleteSessions') }),
          ],
        }),
      ]})
    }

    /** How many rows a section shows before it starts scrolling. */
    const LIST_CAP = 5

    /**
     * How many audit rows are visible at once.
     *
     * A log is read differently from a list of controls: its rows are uniform,
     * and "what just ran" is answered by a page of them, not by five. The ring
     * still honours the retention setting — this is only the window.
     */
    const AUDIT_LIST_CAP = 15

    /**
     * Whether the panel renders its own "Remote environment self-check" section.
     *
     * Turned off on request: one section per probed host, plus a button, for
     * information that is advisory at best — a missing `rg` is a property of that
     * machine, not of this session.
     *
     * It is a gated-off TREE, not a deleted or commented-out one, for a specific
     * reason. Every assertion in `client-shape-smoke` greps this file, so a block
     * turned into comments would keep all of them green while rendering nothing:
     * the suite would describe a section that does not exist. Gating keeps the
     * tree parseable and makes "is it on" a single named value that the suite
     * pins. Flipping it back to `true` restores the section exactly as it was,
     * including the per-card disclosure and the `/status`-first rows.
     *
     * Nothing is lost by hiding it. The same rows remain reachable through the
     * advisory block under the status dot, the diagnostic report
     * (`advisory (not counted in the verdict):`), `GET /self-check`, and the
     * `selfCheck` field of `ssh_workspace_status`. No fact became invisible; the
     * panel just stopped repeating one it had no verdict attached to.
     *
     * @type {boolean}
     */
    const SHOW_SELF_CHECK_SECTION = false

    /** Layout effect when there is a DOM, plain effect otherwise. */
    const useLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

    /**
     * Cap a section at LIST_CAP visible rows and scroll the rest.
     *
     * A `slice(0, 5)` would silently drop rows, which for a control panel is
     * worse than a long list: a tunnel you cannot see is a tunnel you cannot
     * turn off. The cap is a viewport, not a truncation — every row stays
     * reachable by scrolling, so it never removes an action.
     *
     * The height is MEASURED, not assumed. Rows in these sections are not a
     * uniform height: a host card grows with its description and with a
     * confirmation row, a forward row grows when an error line appears, and
     * any row can wrap taller on a narrow panel. A hardcoded `5 * 64px` would
     * show four and a half rows on one row shape and only three on another.
     * We sum the first LIST_CAP rows plus the flex gap, then pin that as the
     * max height — the exact boundary where the 6th row starts to scroll.
     *
     * Re-measure is driven by the rows themselves (not the box): a width
     * change reflows the rows, their heights change, and the observer fires.
     * Observing the box instead would feed back into itself, since we are the
     * ones setting its height.
     */
    /**
     * A timestamp as a clock time, for the audit table.
     *
     * The date is dropped on purpose: the table only ever holds rows from the
     * retention window (hours to days), and "14:32" is what a reader scans for.
     * The date is part of the stamp, not a separate column: the kept ring can
     * reach back across days, and `11:21:44` on its own makes yesterday's row
     * look like this morning's. Local time, because the reader is the person at
     * this machine.
     *
     * @param {number} at - epoch ms.
     * @returns {string} `YYYY-MM-DD HH:MM:SS`, or an empty string for an invalid
     *   value.
     */
    function formatAuditTime (at) {
      if (!Number.isFinite(at)) return ''
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function CappedList ({ className, children, cap = LIST_CAP }) {
      const ref = React.useRef(null)
      const [capHeight, setCapHeight] = React.useState(null)
      const rows = React.Children.toArray(children)

      useLayoutEffect(() => {
        const el = ref.current
        if (el === null || typeof ResizeObserver === 'undefined') return undefined
        const measure = () => {
          const items = Array.from(el.children)
          if (items.length <= cap) {
            setCapHeight(null)
            return
          }
          const style = window.getComputedStyle(el)
          const gap = Number.parseFloat(style.rowGap || style.gap || '0') || 0
          let height = gap * (cap - 1)
          for (const item of items.slice(0, cap)) height += item.getBoundingClientRect().height
          // +1 rounds the fractional pixels up rather than down: a sub-pixel
          // short cap would clip the fifth row and show a scrollbar early.
          setCapHeight(Math.ceil(height) + 1)
        }
        measure()
        const observer = new ResizeObserver(measure)
        for (const item of Array.from(el.children)) observer.observe(item)
        return () => observer.disconnect()
      }, [rows.length, cap])

      return jsx('div', {
        ref,
        className: capHeight === null ? `sshwsp-cap ${className}` : `sshwsp-cap sshwsp-cap-scroll ${className}`,
        style: capHeight === null ? undefined : { maxHeight: `${capHeight}px` },
        children: rows,
      })
    }

    /**
     * Summarise one host's self-check rows.
     *
     * Split out as a pure function so it can be EXECUTED by the suite rather
     * than grepped for: the interesting cases are the ones a screenshot never
     * shows — no rows at all (a card that must say "not probed" instead of
     * rendering nothing), and rows whose `missing` list disagrees with them
     * (which is exactly the state the panel used to get stuck in after a page
     * switch: it kept the count and lost the names).
     *
     * @param {string[]} [missing] - the server's own absent list, used when rows are absent.
     */
    function selfCheckSummary (rows, missing) {
      const list = Array.isArray(rows) ? rows : []
      const absent = list.filter(row => row.state === 'absent').map(row => row.tool)
      const unknown = list.filter(row => row.state !== 'present' && row.state !== 'absent').map(row => row.tool)
      // A host whose rows have not arrived yet still knows how many are missing:
      // the count travels in `/status` on its own. Reporting the count without
      // the names is the honest intermediate state, and naming them is what the
      // expanded view is for.
      const absentCount = list.length === 0 && Array.isArray(missing) ? missing.length : absent.length
      return {
        absent,
        unknown,
        present: list.filter(row => row.state === 'present').length,
        total: list.length,
        absentCount,
      }
    }

    /**
     * Render one host's self-check rows.
     *
     * Present rows are collapsed into a count: a report that lists seven
     * installed tools buries the two that are missing, and the missing ones are
     * the entire reason the report exists. Unknown rows stay visible (they are
     * not "fine", they are "not known"), but they carry no install hint — the
     * hint belongs to a fact, not to an absence of one.
     */
    function SelfCheckList ({ rows, t }) {
      if (!Array.isArray(rows) || rows.length === 0) return null
      const present = rows.filter(row => row.state === 'present')
      const rest = rows.filter(row => row.state !== 'present')
      return jsxs('div', { className: 'sshwsp-check-list', children: [
        jsx('div', { className: 'sshwsp-entry-meta', children: `${present.length}/${rows.length} ${t('check.present')}` }),
        rest.map((row) => jsxs('div', {
          key: row.tool,
          className: `sshwsp-check-row sshwsp-check-${row.state}`,
          children: [
            jsx('span', { className: 'sshwsp-check-tool', children: row.tool }),
            jsx('span', {
              className: `sshwsp-status ${row.state === 'absent' ? 'sshwsp-status-warn' : 'sshwsp-status-off'}`,
              children: row.state === 'absent' ? t('check.absent') : t('check.unknown'),
            }),
            jsx('span', { className: 'sshwsp-entry-meta', children: row.detail ?? '' }),
            row.install !== undefined && jsx('span', { className: 'sshwsp-entry-meta', children: `${t('check.install')}${row.install}` }),
          ],
        })),
      ]})
    }

    // ---- Panel tabs --------------------------------------------------------
    //
    // The list and the remembered selection live at MODULE scope, not in the
    // component: the host unmounts the panel whenever the user goes back to the
    // conversation, so a component-local tab would snap back to the first tab
    // on every re-entry — including the entry a user-visible action triggered.
    // The reference console keeps its page tab in a module store for the same
    // reason.
    // Three tabs. Forwarding and the diagnostic report used to be tabs of their
    // own, which made the row wide and left each of those tabs with a single
    // section in it; they are now sections of "settings", together with the
    // file-reference settings they sit next to.
    // Three tabs, then four: forwarding and the diagnostic report used to be
    // tabs of their own, which made the row wide and left each of those tabs
    // with a single section in it; they are now sections of "settings". The
    // audit earned its own tab back because it is a LOG, not a setting: a user
    // opens it to read what happened, and burying a table inside settings (whose
    // other sections are switches) made it unreachable.
    const PANEL_TABS = ['hosts', 'workspaces', 'audit', 'settings']
    /** Copy key per tab, so the label list and the order stay one fact. */
    const PANEL_TAB_KEYS = {
      hosts: 'panel.tabHosts',
      workspaces: 'panel.tabWorkspaces',
      audit: 'panel.tabAudit',
      settings: 'panel.tabSettings',
    }
    /** The single element the tab buttons control. */
    const PANEL_TABPANEL_ID = 'sshwsp-panel-body'
    const panelTabIdOf = (id) => `sshwsp-tab-${id}`
    /** The selected tab, remembered across remounts. */
    let panelTabChoice = 'hosts'
    /**
     * The tone of one finding, for its badge.
     *
     * ONE rule, shared in spirit with `reportLineTone` in the dialogs chunk:
     * a finding the report marked WARN is a warning (yellow), only a finding
     * whose own text names something actually broken is red, and "could not be
     * judged" is the quiet one. The badge is not a second opinion about the
     * verdict — it is the same sentence in colour, so it must not be possible
     * for the badge and the report to describe one finding two ways.
     */
    function findingToneOf (finding) {
      const detail = String(finding?.detail ?? '')
      if (/\bfailed\b|NOT PINNED|could not be saved/u.test(detail)) return 'bad'
      return finding?.state === 'warn' ? 'warn' : 'unknown'
    }


    /**
     * The panel page.
     *
     * `ctx` is threaded explicitly from the apply-time container (see the
     * `main` slot registration) because the directory browser's batch download
     * asks the HOST's own folder chooser for a destination. The browser dialog
     * reads it only when a batch actually runs, but the identifier must exist
     * in this scope either way: a missing binding is a ReferenceError thrown
     * during render, which unmounts the whole slot and leaves a blank page —
     * exactly what "click 浏览目录 and the page goes white" looked like.
     */
    function RemoteWorkspacePanel ({ t, ctx }) {
      const [hosts, setHosts] = React.useState([])
      const [panelTab, setPanelTab] = React.useState(panelTabChoice)

      /**
       * Move to a tab: remember it, focus its button, and put the pane's top in
       * view.
       *
       * The focus is APG's "selection follows focus" for the arrow keys — the
       * key handler calls this, so the button that just became selected is also
       * the one holding focus. The scroll reset exists because switching tabs
       * halfway down a long section used to land halfway down the next one.
       */
      const selectPanelTab = (id) => {
        panelTabChoice = id
        setPanelTab(id)
        if (typeof document === 'undefined') return
        const button = document.getElementById(panelTabIdOf(id))
        if (button instanceof HTMLElement) button.focus()
        const pane = document.getElementById(PANEL_TABPANEL_ID)
        const scroller = pane instanceof Element ? pane.closest('.sshwsp') : null
        if (scroller instanceof HTMLElement) scroller.scrollTop = 0
      }

      /**
       * APG keyboard for the tab row: arrows wrap around, Home/End jump to the
       * ends, and only the selected tab sits in the Tab order (each button
       * writes its own `tabIndex`).
       */
      const handleTabKeys = (event) => {
        const current = Math.max(0, PANEL_TABS.indexOf(panelTab))
        const last = PANEL_TABS.length - 1
        const next = event.key === 'ArrowRight'
          ? (current === last ? 0 : current + 1)
          : event.key === 'ArrowLeft'
            ? (current === 0 ? last : current - 1)
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? last
                : -1
        if (next < 0) return
        event.preventDefault()
        selectPanelTab(PANEL_TABS[next])
      }
      // What the listing could NOT show, kept apart from "nothing configured".
      //
      // The route has always returned `skipped` and `storeError`, and the tools
      // and the report render them; the panel did not, so an unreadable store
      // and an empty one produced the same sentence ("no SSH hosts configured")
      // — the one message a user cannot act on. Empty state is the absence of
      // both facts, not the absence of rows.
      const [listingGaps, setListingGaps] = React.useState({ skipped: [], storeError: undefined })
      // Whether the host list has EVER been read successfully. An empty list is a
      // legitimate answer (every host deleted, workspaces left behind) but so is a
      // failed fetch, and only the first one may be read as "these hosts are gone".
      const [hostListingLoaded, setHostListingLoaded] = React.useState(false)
      const [status, setStatus] = React.useState({ mounted: [], disabled: [], connections: [], forwards: [], forwardRows: [], forwardSettings: { autoStart: false }, passthrough: { scheme: 'local', remoteMissFallback: false, enabled: false } })
      const [testStates, setTestStates] = React.useState({})
      const [browserAlias, setBrowserAlias] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      // undefined = closed, null = create, a host row = edit that host.
      const [editorHost, setEditorHost] = React.useState(undefined)
      const [deletingAlias, setDeletingAlias] = React.useState(null)
      const [deleteErrors, setDeleteErrors] = React.useState({})
      // Whether this host build rendered the Files panel action bar at all.
      // A slot the host never declares is otherwise silent, so the panel says
      // so instead of letting the upload entry disappear without a reason.
      const transferActionsSlot = useTransferActionsSlot()
      const [forwardAlias, setForwardAlias] = React.useState('')
      const [forwardRemotePort, setForwardRemotePort] = React.useState('')
      const [forwardLocalPort, setForwardLocalPort] = React.useState('')
      const [forwardBusy, setForwardBusy] = React.useState(false)
      // Which saved row is mid-toggle, so only that row's button shows progress.
      const [forwardRowBusy, setForwardRowBusy] = React.useState(null)
      const [forwardDeleteId, setForwardDeleteId] = React.useState(null)
      // Advisory local-port verdict for the form, keyed by "host:port".
      const [portCheck, setPortCheck] = React.useState(null)
      // Which workspace row has an armed unmount confirmation. Arming is separate
      // state so the first click is reversible and cannot unload a workspace by
      // accident. Unmount itself takes no options — see handleUnmount.
      const [unmountConfirm, setUnmountConfirm] = React.useState(null)
      const [unmountBusy, setUnmountBusy] = React.useState(null)
      const [enableBusy, setEnableBusy] = React.useState(null)
      // Deleting is the destructive action, and it is the only place the two
      // questions are asked: whether the workspace goes, and whether its sessions
      // go with it. Both default to "yes" because that is what "delete" means,
      // and the confirm row shows the boxes before anything happens.
      const [discardConfirm, setDiscardConfirm] = React.useState(null)
      const [discardRecord, setDiscardRecord] = React.useState(true)
      const [discardSessions, setDiscardSessions] = React.useState(true)
      const [discardBusy, setDiscardBusy] = React.useState(null)
      // The scheme box is a draft, not a mirror of `status.passthrough.scheme`:
      // the panel refreshes on a timer, and a refresh landing mid-typing would
      // otherwise overwrite the half-typed name with the stored one. `null`
      // means "untouched, show the stored value"; the input clears it on every
      // keystroke and the save handler re-seeds it from the server's answer.
      const [passthroughScheme, setPassthroughScheme] = React.useState(null)
      const [passthroughBusy, setPassthroughBusy] = React.useState(false)
      const [fileViewBusy, setFileViewBusy] = React.useState(false)
      // true when /status says the running server predates this client: the
      // files on disk changed, the process did not.
      const [restartNeeded, setRestartNeeded] = React.useState(false)
      // What the box shows: the draft while there is one, the stored name
      // otherwise. Deriving it here rather than seeding state from `status`
      // keeps a timer refresh from resurrecting a name the user just erased.
      const passthroughSchemeValue = passthroughScheme ?? status.passthrough?.scheme ?? 'local'
      // Self-check: which alias is being probed, and the last report per alias.
      // Kept per alias rather than as one "last report" so switching hosts in
      // the panel does not silently show another host's verdicts.
      const [checkBusy, setCheckBusy] = React.useState(null)
      const [checkReports, setCheckReports] = React.useState({})
      /**
       * Which host's self-check card is expanded.
       *
       * Keyed by alias and kept here rather than inside the card, because
       * `CappedList` re-creates the rows on every poll (the panel refreshes on a
       * timer) — state living inside a row would collapse itself every few
       * seconds, which is a worse bug than the one this replaces.
       *
       * @type {[Record<string, boolean>, Function]}
       */
      const [expandedChecks, setExpandedChecks] = React.useState({})
      const [supportBusy, setSupportBusy] = React.useState(false)
      // null = the report dialog is closed; a string = its text is on screen.
      const [reportText, setReportText] = React.useState(null)
      // undefined = closed, a host row = that host's switch-off confirmation is
      // on screen. Switching a host ON takes no dialog (it neither interrupts
      // anything nor dials the host), so this state only ever holds an "off".
      const [powerHost, setPowerHost] = React.useState(undefined)
      // Which alias is mid-switch, so only that card's switch shows progress.
      const [powerBusyAlias, setPowerBusyAlias] = React.useState(null)
      const [powerError, setPowerError] = React.useState(undefined)
      // ---- the command audit tab
      //
      // Rows are fetched from their own route rather than carried on `/status`:
      // the status poll runs every couple of seconds and answers "how are
      // things", while this tab wants every retained row the moment it opens
      // (see the route's comment). They are kept here so switching tabs does not
      // refetch, and `auditWorkspace` filters them client-side.
      //
      // The filter is by WORKSPACE, as the prototype has it, and the column it
      // filters on is the one the row can answer honestly: `/status` ships each
      // remote workspace together with its `sessionIds`, so a row whose call
      // named a session resolves to that session's workspace. A row with no
      // session — a capability probe, the plugin asking a host what it can do —
      // has no workspace and shows a dash rather than a guess; it stays visible
      // under "all workspaces" and drops out of a narrowed view, which is the
      // truth (it does not belong to the workspace you asked about).
      const [auditRows, setAuditRows] = React.useState([])
      const [auditBusy, setAuditBusy] = React.useState(false)
      const [auditError, setAuditError] = React.useState(undefined)
      const [auditWorkspace, setAuditWorkspace] = React.useState('')
      // The retention box is a draft for the same reason the scheme box is: a
      // timer refresh must not overwrite a half-typed number.
      const [auditRetention, setAuditRetention] = React.useState(null)
      const [auditSaveBusy, setAuditSaveBusy] = React.useState(false)

      // ONE notice implementation for the panel and the tree/transfer code.
      // A string keeps the old call shape; an object can add a diagnostic
      // code, raw detail and a retry action. Nothing here holds React state:
      // the DOM node owns its own timer and is rewritten in place.
      const reportToast = (input, kind) => notifyUser(input, kind)

      const refresh = React.useCallback(async () => {
        setLoading(true)
        try {
          const [hostsData, statusData] = await Promise.all([
            fetchJson(API.hosts),
            fetchJson(API.status),
          ])
          setHosts(hostsData.hosts ?? [])
          setListingGaps({ skipped: hostsData.skipped ?? [], storeError: hostsData.storeError })
          setHostListingLoaded(true)
          setStatus(statusData)
          // The click bridge caches this and decides synchronously; a poll is
          // also how a value changed in another tab (or by hand in the store)
          // reaches this page without a reload.
          applyPreferences(statusData?.preferences)
          setRestartNeeded(noteServerCompatibility(statusData) === true)
        syncRemoteWorkspaceMarks(statusData.workspaces, statusData.disabled, statusData.disabledHosts)
        } catch { /* silent */ }
        finally { setLoading(false) }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      // The audit tab reads on open (and only on open): the route is not on the
      // poll, so something has to ask, and asking once per visit is why it is a
      // separate route in the first place.
      React.useEffect(() => {
        if (panelTab !== 'audit') return
        if (auditRows.length > 0) return
        void loadAudit()
      }, [panelTab])

      /**
       * Run the self-check for one host.
       *
       * Reports into `checkReports` rather than into `status`, because a
       * self-check is a deliberate, expensive action (it opens a connection and
       * runs a command) while `status` is refreshed on a timer. Mixing them
       * would mean a refresh either overwrites the report or re-probes a host
       * on every tick.
       *
       * The report is then MERGED into the rendered list, so a host that has
       * a fresh report shows it and a host that has only the cached probe still
       * shows what the server knows.
       */
      const selfCheckAction = async (alias) => {
        if (typeof alias !== 'string' || alias === '') return null
        setCheckBusy(alias)
        try {
          const report = await fetchJson(`${API.selfCheck}?alias=${encodeURIComponent(alias)}`)
          setCheckReports((prev) => ({ ...prev, [alias]: report }))
          await refresh()
          return { kind: 'ok', text: t('check.done') }
        } catch (err) {
          return toastError(t('check.fail'), err, 'SSHWSP-E-SELF-CHECK', () => selfCheckAction(alias))
        } finally {
          setCheckBusy(null)
        }
      }

      /**
       * Run the self-check and report the outcome.
       *
       * A success is already visible in the report card, so the direct path
       * does not raise a toast. A failure does, and it can replay the probe
       * from the same node; the replay's success is shown because the user
       * pressed a button and needs to see that it worked.
       */
      const runSelfCheck = async (alias) => {
        const result = await selfCheckAction(alias)
        if (result !== null && result.kind === 'err') reportToast(result)
      }

      /**
       * Copy the report that is already on screen.
       *
       * The dialog's own button, and the panel's only copy path. It copies the
       * string the dialog is showing rather than re-fetching: the user is
       * looking at one particular report, and a second request could return a
       * different one (another host connected, a command finished) — the text
       * on screen and the text on the clipboard have to be the same text.
       *
       * Resolves to whether the clipboard write actually happened, so the
       * dialog can fall back to selecting the text for a manual copy.
       * `navigator.clipboard` needs a secure context, which a loopback GUI
       * normally has; a rejection (permission denied, non-secure context) is
       * reported as `false` rather than thrown, because the caller decides what
       * to show.
       */
      const copyOpenReport = async () => {
        if (reportText === null) return false
        if (navigator.clipboard?.writeText === undefined) {
          reportToast(toastError(t('support.noClipboard'), 'navigator.clipboard.writeText is unavailable', 'SSHWSP-E-CLIPBOARD'))
          return false
        }
        try {
          await navigator.clipboard.writeText(reportText)
          reportToast({ kind: 'ok', text: t('support.copied') })
          return true
        } catch (err) {
          reportToast(toastError(t('support.noClipboard'), err, 'SSHWSP-E-CLIPBOARD'))
          return false
        }
      }

      /**
       * Show the diagnostic report inside the panel.
       *
       * The report is served as `text/plain` at its own URL, and the obvious
       * implementation — an `<a target="_blank">` on that URL — is the one that
       * does not work in the Desktop app. There the document origin is
       * `dsh-app://app/`, so a relative `href` resolves against that scheme
       * instead of the Host's HTTP address; the window's open handler only
       * admits `http:`/`https:` and denies everything else, so the click does
       * nothing at all. Even when the scheme were admitted, the system browser
       * it would be handed to carries no Host session and answers 401.
       *
       * Fetching the same bytes and rendering them in a dialog sidesteps both:
       * one request, through the panel's own credentials, and the text lands
       * where the user can select it.
       */
      const supportBundleAction = async () => {
        setSupportBusy(true)
        setReportText(null)
        try {
          const text = await fetchReportText()
          setReportText(text)
          return { kind: 'ok', text: t('support.opened') }
        } catch (err) {
          return toastError(t('support.fail'), err, 'SSHWSP-E-SUPPORT-BUNDLE', () => supportBundleAction())
        } finally {
          setSupportBusy(false)
        }
      }

      /**
       * Open the report; a failure can be replayed from the toast.
       */
      const openSupportBundle = async () => {
        const result = await supportBundleAction()
        if (result.kind === 'err') reportToast(result)
      }

      /**
       * Probe one host: connect, prove it works, then let the connection go.
       *
       * "Test" answers "does this host answer at all" — it is not a way to open
       * a session. The server releases the connection it just proved (unless an
       * open port forward pins it), so the panel's connection indicator does not
       * light up from a mere probe. The refresh below therefore reports what is
       * actually left rather than assuming the test left a connection behind.
       */
      const testAction = async (alias) => {
        setTestStates((prev) => ({ ...prev, [alias]: { status: 'testing' } }))
        try {
          const result = await fetchJson(API.test, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          setTestStates((prev) => ({
            ...prev,
            [alias]: { status: result.ok ? 'ok' : 'failed', durationMs: result.durationMs, error: result.error },
          }))
          // The probe released its connection, so the indicator must be
          // re-read rather than optimistically marked connected. A failed
          // status read must not turn a successful probe into a failure.
          try {
            const s = await fetchJson(API.status)
            setStatus(s)
          } catch { /* best-effort refresh */ }
          if (!result.ok) {
            return toastError(t('hosts.testFail'), result.error, 'SSHWSP-E-HOST-TEST', () => testAction(alias))
          }
          return { kind: 'ok', text: t('hosts.testOk', { ms: result.durationMs }) }
        } catch (err) {
          setTestStates((prev) => ({
            ...prev,
            [alias]: { status: 'failed', error: err.message },
          }))
          return toastError(t('hosts.testFail'), err, 'SSHWSP-E-HOST-TEST', () => testAction(alias))
        }
      }

      const handleTest = async (alias) => {
        reportToast(await testAction(alias))
      }

      const handleDelete = async (alias) => {
        setDeletingAlias(alias)
        setDeleteErrors((prev) => {
          const next = { ...prev }
          delete next[alias]
          return next
        })
        try {
          const result = await fetchJson(API.hostDelete, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            setDeleteErrors((prev) => ({ ...prev, [alias]: result.error ?? t('hosts.deleteFail') }))
          } else {
            await refresh()
          }
        } catch (err) {
          setDeleteErrors((prev) => ({ ...prev, [alias]: err.message }))
        } finally {
          setDeletingAlias(null)
        }
      }

      const handleForgetKey = async (alias) => {
        try {
          const result = await fetchJson(API.hostForgetKey, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            // No retry: forgetting a key changes the trust anchor, and a
            // replay after a partial failure would be a policy change, not a
            // repeat of a safe read.
            reportToast(toastError(t('hosts.forgetKeyFail'), result.error, 'SSHWSP-E-HOST-KEY-FORGET'))
          } else {
            reportToast({ kind: 'ok', text: t('hosts.forgetKeyOk') })
            // The pooled connection was dropped server-side; refresh so the
            // connection rows stop claiming it is still up.
            const s = await fetchJson(API.status)
            setStatus(s)
          }
        } catch (err) {
          reportToast(toastError(t('hosts.forgetKeyFail'), err, 'SSHWSP-E-HOST-KEY-FORGET'))
        }
      }

      const disconnectAction = async (alias) => {
        try {
          const result = await fetchJson(API.hostDisconnect, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            return toastError(t('hosts.disconnectFail'), result.error, 'SSHWSP-E-HOST-DISCONNECT', () => disconnectAction(alias))
          }
          // Report the tunnels too: they went away because the user asked for
          // it, and saying so is what keeps this from looking like the failure
          // the panel would otherwise show for a dropped connection.
          const closedForwards = Number(result.closedForwards ?? 0)
          // The connection is gone server-side; refresh so the indicator follows.
          try {
            const s = await fetchJson(API.status)
            setStatus(s)
          } catch { /* best-effort refresh */ }
          return {
            kind: 'ok',
            text: closedForwards > 0
              ? t('hosts.disconnectOkForwards').replace('{n}', String(closedForwards))
              : t('hosts.disconnectOk'),
          }
        } catch (err) {
          return toastError(t('hosts.disconnectFail'), err, 'SSHWSP-E-HOST-DISCONNECT', () => disconnectAction(alias))
        }
      }

      const handleDisconnect = async (alias) => {
        reportToast(await disconnectAction(alias))
      }

      /**
       * Skip the backoff and try now.
       *
       * Reports the real error rather than a hopeful "retrying": the background
       * loop already prints its own progress on the card, so a manual attempt
       * that failed must not look like it worked.
       */
      const reconnectAction = async (alias) => {
        try {
          const result = await fetchJson(API.hostReconnect, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias }),
          })
          if (!result.ok) {
            return toastError(t('connections.retryFail'), result.error, 'SSHWSP-E-HOST-RECONNECT', () => reconnectAction(alias))
          }
          try {
            const s = await fetchJson(API.status)
            setStatus(s)
          } catch { /* best-effort refresh */ }
          return { kind: 'ok', text: t('connections.retryOk') }
        } catch (err) {
          return toastError(t('connections.retryFail'), err, 'SSHWSP-E-HOST-RECONNECT', () => reconnectAction(alias))
        }
      }

      const handleReconnect = async (alias) => {
        reportToast(await reconnectAction(alias))
      }

      /**
       * Record (or clear) the "connect on startup" intent — nothing else.
       *
       * This is deliberately NOT `/hosts/reconnect` and NOT `/hosts/disconnect`:
       * the box is a marker, so ticking it must not dial the host and unticking
       * it must not drop the socket the user is working in. The connection keeps
       * its own controls (「立即重连」/「断开」), and those still act immediately.
       */
      const intentAction = async (alias, enabled) => {
        try {
          const result = await fetchJson(API.hostIntent, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias, enabled }),
          })
          if (!result.ok) {
            return toastError(t('hosts.autoConnectFail'), result.error, 'SSHWSP-E-HOST-INTENT', () => intentAction(alias, enabled))
          }
          try {
            const s = await fetchJson(API.status)
            setStatus(s)
          } catch { /* best-effort refresh */ }
          return { kind: 'ok', text: enabled ? t('hosts.autoConnectOkOn') : t('hosts.autoConnectOkOff') }
        } catch (err) {
          return toastError(t('hosts.autoConnectFail'), err, 'SSHWSP-E-HOST-INTENT', () => intentAction(alias, enabled))
        }
      }

      const handleSetIntent = async (alias, enabled) => {
        reportToast(await intentAction(alias, enabled))
      }

      /**
       * Switch one stored host hard off, or back on.
       *
       * This is ONE server call per switch, and the two directions are not
       * symmetrical in the UI on purpose: switching off interrupts work, so it
       * asks first (the dialog lists exactly what will be cut, from the counts
       * the route just read); switching on interrupts nothing and does not dial
       * the host — auto-connect owns dialling — so it happens immediately.
       *
       * Returns true when the stored state actually changed, so the dialog
       * knows whether it may close.
       */
      const switchHost = async (alias, enabled) => {
        setPowerBusyAlias(alias)
        try {
          const result = await fetchJson(API.hostToggle, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias, enabled }),
          })
          if (!result.ok) {
            const failure = result.error ?? ''
            if (enabled) reportToast(toastError(t('hosts.powerOnFail'), failure, 'SSHWSP-E-HOST-POWER', () => switchHost(alias, enabled)))
            else setPowerError(failure)
            return false
          }
          await refresh()
          return true
        } catch (err) {
          if (enabled) reportToast(toastError(t('hosts.powerOnFail'), err, 'SSHWSP-E-HOST-POWER', () => switchHost(alias, enabled)))
          else setPowerError(String(err?.message ?? err))
          return false
        } finally {
          setPowerBusyAlias(null)
        }
      }

      const handleHostPower = async (host) => {
        if (host.enabled === false) {
          if (await switchHost(host.alias, true)) reportToast({ kind: 'ok', text: t('hosts.powerOnDone', { alias: host.alias }) })
          return
        }
        setPowerError(undefined)
        setPowerHost(host)
      }

      const confirmHostPowerOff = async () => {
        const host = powerHost
        if (host === undefined) return
        if (await switchHost(host.alias, false)) {
          setPowerHost(undefined)
          reportToast({ kind: 'ok', text: t('hosts.powerOffDone', { alias: host.alias }) })
        }
      }

      /**
       * Unload one workspace — the reversible half, and the only one that asks
       * nothing.
       *
       * Two steps, but no choices: unmount ALWAYS keeps the record and the
       * sessions, so the sidebar group stays populated and "Enable" is the way
       * back. Every destructive decision lives in the same row's "Delete", which
       * is where the answer actually changes what happens — asking the same
       * question in two places is how the two answers end up disagreeing.
       */
      const handleUnmount = async (workspacePath) => {
        setUnmountBusy(workspacePath)
        try {
          const result = await fetchJson(API.unmount, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspacePath, mode: 'detach' }),
          })
          if (!result.ok) {
            // No retry: unmount can partially succeed (the workspace may be
            // detached while session archiving failed), so replaying it is not
            // a safe repeat of one action.
            reportToast(toastError(t('mounted.detachFail'), result.error, 'SSHWSP-E-UNMOUNT'))
          } else {
            reportToast({ kind: 'ok', text: t('mounted.detachOkKeep') })
          }
          setUnmountConfirm(null)
          await refresh()
        } catch (err) {
          reportToast(toastError(t('mounted.detachFail'), err, 'SSHWSP-E-UNMOUNT'))
        } finally {
          setUnmountBusy(null)
        }
      }

      /** Mount a detached workspace again and unarchive its sessions. */
      const enableAction = async (workspacePath) => {
        setEnableBusy(workspacePath)
        try {
          const result = await fetchJson(API.enable, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspacePath, unarchiveSessions: true }),
          })
          if (!result.ok) {
            return toastError(t('detached.enableFail'), result.error, 'SSHWSP-E-ENABLE', () => enableAction(workspacePath))
          }
          return { kind: 'ok', text: t('detached.enableOk').replace('{path}', workspacePath) }
        } catch (err) {
          return toastError(t('detached.enableFail'), err, 'SSHWSP-E-ENABLE', () => enableAction(workspacePath))
        } finally {
          setEnableBusy(null)
          await refresh()
        }
      }

      /** Mount a detached workspace again and unarchive its sessions. */
      const handleEnable = async (workspacePath) => {
        reportToast(await enableAction(workspacePath))
      }

      /**
       * Delete a workspace, asking the two questions separately.
       *
       * `record` decides whether the workspace itself goes (deregister) or stays
       * detached (detach); `sessions` decides whether its sessions are taken out
       * of every list. They are independent on purpose: wanting the group gone
       * but the sessions kept is a real answer, and so is the reverse — keeping a
       * workspace that can be re-enabled while clearing its sessions out of the
       * way.
       *
       * "Delete sessions" is ARCHIVE, and the checkbox says so on hover: the
       * sessions leave every grouping surface, their files stay on disk. DSH
       * exposes no session-delete API, and this plugin will not reach around the
       * service layer to unlink logs, so the UI must not promise a deletion it
       * cannot perform.
       *
       * Two steps, and no retry on failure: the request can partially succeed
       * (the record deleted while archiving failed), so a blind replay is not a
       * safe repeat of one action.
       */
      const discardAction = async (workspacePath, record, sessions) => {
        setDiscardBusy(workspacePath)
        try {
          const result = await fetchJson(API.unmount, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspacePath,
              mode: record === true ? 'deregister' : 'detach',
              archiveSessions: sessions === true,
            }),
          })
          if (!result.ok) {
            return toastError(t('workspace.deleteFail'), result.error, 'SSHWSP-E-DISCARD')
          }
          if (sessions === true && (result.archiveFailed ?? []).length > 0) {
            // The record's fate is already settled either way; naming the
            // sessions that did not archive is what keeps this from reading as
            // a clean success.
            return toastError(t('mounted.detachPartial'), result.archiveFailed, 'SSHWSP-E-DISCARD-ARCHIVE')
          }
          const archived = String((result.archived ?? []).length)
          return {
            kind: 'ok',
            text: record === true && sessions === true
              ? t('workspace.deleteOk').replace('{n}', archived)
              : record === true
                ? t('workspace.deleteOkKeepSessions')
                : t('workspace.deleteArchiveOnly').replace('{n}', archived),
          }
        } catch (err) {
          return toastError(t('workspace.deleteFail'), err, 'SSHWSP-E-DISCARD')
        } finally {
          setDiscardBusy(null)
          setDiscardConfirm(null)
          await refresh()
        }
      }

      const handleDiscard = async (workspacePath, record, sessions) => {
        reportToast(await discardAction(workspacePath, record, sessions))
      }

      const handleForward = async () => {
        const remotePort = Number.parseInt(forwardRemotePort.trim(), 10)
        const localPortText = forwardLocalPort.trim()
        const localPort = localPortText === '' ? remotePort : Number.parseInt(localPortText, 10)
        const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535
        if (!validPort(remotePort) || !validPort(localPort)) {
          reportToast(toastError(t('editor.badPort'), `remotePort=${forwardRemotePort.trim()} localPort=${localPortText}`, 'SSHWSP-E-BAD-PORT'))
          return
        }
        setForwardBusy(true)
        try {
          // A saved mapping pins its local port, so the form always sends one
          // (defaulting to the remote port) rather than asking for an ephemeral
          // port the store could not describe.
          const result = await fetchJson(API.forwardSave, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ alias: forwardAlias, remotePort, localPort }),
          })
          if (!result.ok) {
            reportToast(toastError(t('forwards.fail'), result.error, 'SSHWSP-E-FORWARD-SAVE'))
          } else {
            setForwardRemotePort('')
            setForwardLocalPort('')
            if (result.error !== undefined) reportToast(toastError(t('forwards.fail'), result.error, 'SSHWSP-E-FORWARD-SAVE'))
          }
          await refresh()
        } catch (err) {
          reportToast(toastError(t('forwards.fail'), err, 'SSHWSP-E-FORWARD-SAVE'))
        } finally {
          setForwardBusy(false)
          setPortCheck(null)
        }
      }

      /**
       * Check the local port the form would bind, before the user commits.
       *
       * Runs on blur rather than on every keystroke: a probe binds a real
       * listener, and doing that per character would both spam the OS and race
       * the user's typing. The verdict is advisory — the save path probes again
       * and the bind itself stays authoritative.
       */
      const checkForwardPort = async () => {
        const remotePort = Number.parseInt(forwardRemotePort.trim(), 10)
        const localPortText = forwardLocalPort.trim()
        const localPort = localPortText === '' ? remotePort : Number.parseInt(localPortText, 10)
        if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) { setPortCheck(null); return }
        const key = `127.0.0.1:${localPort}`
        setPortCheck({ key, state: 'checking' })
        try {
          const url = `${API.forwardProbe}?localHost=127.0.0.1&localPort=${localPort}`
          const result = await fetchJson(url)
          setPortCheck({ key, state: result.available === true ? 'free' : 'busy', code: result.code })
        } catch {
          // A probe that cannot run must not block the form: the save path is
          // the authority, and a failed probe says nothing about the port.
          setPortCheck(null)
        }
      }

      const handleForwardToggle = async (row) => {
        setForwardRowBusy(row.id)
        try {
          const result = await fetchJson(API.forwardToggle, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // The requested state comes from the runtime fact, not from the
            // stored intent: a row whose intent is on but whose tunnel died is
            // still showing "turn on".
            body: JSON.stringify({ id: row.id, enabled: row.live !== true }),
          })
          if (!result.ok) {
            reportToast(toastError(t('forwards.fail'), result.error, 'SSHWSP-E-FORWARD-TOGGLE'))
          }
          await refresh()
        } catch (err) {
          reportToast(toastError(t('forwards.fail'), err, 'SSHWSP-E-FORWARD-TOGGLE'))
        } finally {
          setForwardRowBusy(null)
        }
      }

      const handleForwardRemember = async (id) => {
        setForwardRowBusy(id)
        try {
          const result = await fetchJson(API.forwardRemember, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          if (!result.ok) reportToast(toastError(t('forwards.fail'), result.error, 'SSHWSP-E-FORWARD-REMEMBER'))
          await refresh()
        } catch (err) {
          reportToast(toastError(t('forwards.fail'), err, 'SSHWSP-E-FORWARD-REMEMBER'))
        } finally {
          setForwardRowBusy(null)
        }
      }

      const handleForwardDelete = async (id) => {
        setForwardRowBusy(id)
        try {
          await fetchJson(API.forwardDelete, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          setForwardDeleteId(null)
          await refresh()
        } catch { /* silent */ } finally {
          setForwardRowBusy(null)
        }
      }

      /** Persist the auto-start preference. Optimistic, rolled back on failure. */
      const handleAutoStart = async (next) => {
        setStatus((prev) => ({ ...prev, forwardSettings: { ...(prev.forwardSettings ?? {}), autoStart: next } }))
        try {
          const result = await fetchJson(API.forwardSettings, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoStart: next }),
          })
          if (!result.ok) {
            setStatus((prev) => ({ ...prev, forwardSettings: { ...(prev.forwardSettings ?? {}), autoStart: !next } }))
            reportToast(toastError(t('forwards.autoStartFail'), result.error, 'SSHWSP-E-AUTOSTART'))
          }
        } catch (err) {
          setStatus((prev) => ({ ...prev, forwardSettings: { ...(prev.forwardSettings ?? {}), autoStart: !next } }))
          reportToast(toastError(t('forwards.autoStartFail'), err, 'SSHWSP-E-AUTOSTART'))
        }
      }

      /**
       * Persist one local-passthrough setting.
       *
       * Not optimistic, unlike the auto-start box: the server validates the
       * scheme name and is the only writer of the live matcher, so echoing the
       * requested value first would briefly show a scheme the filesystem seams
       * are not using. The answer carries the stored settings, which is what
       * the panel then renders.
       */
      const savePassthrough = async (patch, failureKey, code) => {
        setPassthroughBusy(true)
        try {
          const result = await fetchJson(API.passthroughSettings, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (!result.ok) {
            reportToast(toastError(t(failureKey), result.error, code))
            return
          }
          if (result.settings !== undefined) {
            // A save is what confirms the degraded value, so the stale warning
            // goes with it. The next status poll would clear it too, but until
            // then the panel would keep telling the user to do the thing they
            // just did.
            setStatus((prev) => ({
              ...prev,
              passthrough: {
                ...(prev.passthrough ?? {}),
                ...result.settings,
                ...(patch.scheme === undefined ? {} : { schemeWarning: null }),
              },
            }))
            if (typeof result.settings.scheme === 'string') setPassthroughScheme(result.settings.scheme)
          }
          if (patch.scheme !== undefined) reportToast({ kind: 'ok', text: t('passthrough.schemeSaved').replace('{scheme}', result.settings?.scheme ?? patch.scheme) })
        } catch (err) {
          reportToast(toastError(t(failureKey), err, code))
        } finally {
          setPassthroughBusy(false)
        }
      }

      /**
       * Persist one viewing preference.
       *
       * Not optimistic, unlike the auto-start box: the server normalizes the
       * value (and rejects an unknown one), and the answer is the shape both
       * this panel and the click bridge then run with. Echoing the click first
       * would let the panel show "conversation" while the bridge still holds
       * "sidebar", which is a state the user cannot see or undo.
       */
      const saveFileViewPreference = async (patch) => {
        setFileViewBusy(true)
        try {
          const result = await fetchJson(API.preferences, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (result?.ok === false) {
            reportToast(toastError(t('fileview.saveFail'), result.error, 'SSHWSP-E-FILEVIEW'))
            return
          }
          if (result?.preferences !== undefined) {
            setStatus((prev) => ({ ...prev, preferences: result.preferences }))
            applyPreferences(result.preferences)
          }
        } catch (err) {
          reportToast(toastError(t('fileview.saveFail'), err, 'SSHWSP-E-FILEVIEW'))
        } finally {
          setFileViewBusy(false)
        }
      }

      /**
       * Read the whole command audit.
       *
       * Called when the tab opens, when the user asks to reload, and after a
       * retention change (which can drop rows). A failed read is shown in the
       * tab rather than swallowed: an empty table and an unreadable log look
       * identical, and only one of them is normal.
       */
      const loadAudit = async () => {
        setAuditBusy(true)
        setAuditError(undefined)
        try {
          const payload = await fetchJson(API.audit)
          setAuditRows(Array.isArray(payload?.entries) ? payload.entries : [])
        } catch (err) {
          setAuditError(String(err?.message ?? err))
        } finally {
          setAuditBusy(false)
        }
      }

      /**
       * Put one audited command back on the clipboard so it can be re-run.
       *
       * Same contract as the row menu's path copy: a silent no-op is worse than
       * no button, because the user pastes whatever was on the clipboard
       * before and believes it is the command they clicked. The clipboard needs
       * a secure context and can be refused by permission, so a rejection is
       * reported rather than swallowed.
       */
      const copyAuditCommand = async (command) => {
        if (navigator.clipboard?.writeText === undefined) {
          reportToast(toastError(t('audit.copyFailed'), 'navigator.clipboard.writeText is unavailable', 'SSHWSP-E-CLIPBOARD'))
          return
        }
        try {
          await navigator.clipboard.writeText(command)
          reportToast({ kind: 'ok', text: t('audit.copied') })
        } catch (err) {
          reportToast(toastError(t('audit.copyFailed'), err, 'SSHWSP-E-CLIPBOARD'))
        }
      }

      /**
       * Save the retention, then reload: the server trims the ring immediately,
       * so the table must show the trimmed rows rather than the old ones.
       */
      const saveAuditRetention = async () => {
        const retention = Number.parseInt(String(auditRetention ?? '').trim(), 10)
        if (!Number.isInteger(retention)) return
        // Committing on blur means the same value is offered twice (Enter, then
        // the blur that follows it). The server's current value is the answer to
        // "is there anything to save?", so an unchanged number costs nothing.
        if (retention === status.audit?.retention) {
          setAuditRetention(retention)
          return
        }
        setAuditSaveBusy(true)
        try {
          const result = await fetchJson(API.auditSettings, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ retention }),
          })
          if (result?.ok === false) {
            reportToast(toastError(t('audit.saveFail'), result.error, 'SSHWSP-E-AUDIT'))
            return
          }
          // The server's answer is the truth (it clamps to its bounds), so the
          // box is re-seeded from it instead of keeping the typed value.
          if (Number.isInteger(result?.retention)) setAuditRetention(result.retention)
          await loadAudit()
        } catch (err) {
          reportToast(toastError(t('audit.saveFail'), err, 'SSHWSP-E-AUDIT'))
        } finally {
          setAuditSaveBusy(false)
        }
      }

      /**
       * Save the scheme box.
       *
       * The name is lowercased before it is validated, exactly as the host
       * does, so typing "Local" is accepted rather than bounced with a rule
       * the user cannot see being applied.
       *
       * The rules themselves come from the server (`status.passthrough
       * .schemeRules`), which publishes them from the same tables
       * `schemeRefusal` enforces. This bundle deliberately carries NO copy of
       * the syntax, the minimum length or the reserved list: a copy can
       * disagree with what the server accepts, and then the panel either
       * refuses a name the host would take or promises one it would refuse. The
       * check is still done here so "that is not a name" is answered without a
       * round trip; when the status reply predates the rules (an older server)
       * only the empty case is caught locally and the server's own refusal
       * text is the answer for everything else.
       */
      const savePassthroughScheme = async () => {
        const requested = String(passthroughSchemeValue).trim().toLowerCase()
        const rules = status.passthrough?.schemeRules
        if (requested === '') {
          reportToast(toastError(t('passthrough.schemeInvalid'), requested, 'SSHWSP-E-PASSTHROUGH-SCHEME'))
          return
        }
        // Same order as `schemeRefusal`: syntax, then length, then the reserved
        // list — so the toast names the rule the server would have named.
        if (typeof rules?.pattern === 'string' && rules.pattern !== '') {
          let syntaxOk = true
          try { syntaxOk = new RegExp(rules.pattern, 'u').test(requested) } catch { syntaxOk = true }
          if (!syntaxOk) {
            reportToast(toastError(t('passthrough.schemeInvalid'), requested, 'SSHWSP-E-PASSTHROUGH-SCHEME'))
            return
          }
        }
        if (rules !== undefined && requested.length < (rules.minLength ?? 3)) {
          reportToast(toastError(t('passthrough.schemeTooShort'), requested, 'SSHWSP-E-PASSTHROUGH-SCHEME'))
          return
        }
        const taken = (rules?.reserved ?? []).find(entry => entry?.name === requested)
        if (taken !== undefined) {
          reportToast(toastError(
            t('passthrough.schemeReserved')
              .replace('{scheme}', requested)
              .replace('{reason}', String(taken.reason ?? '')),
            requested,
            'SSHWSP-E-PASSTHROUGH-SCHEME',
          ))
          return
        }
        await savePassthrough({ scheme: requested }, 'passthrough.schemeFail', 'SSHWSP-E-PASSTHROUGH-SCHEME')
      }

      const handleUnforward = async (id) => {
        try {
          await fetchJson(API.unforward, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          refresh()
        } catch { /* silent */ }
      }

      /**
       * Save the remote-miss fallback box.
       *
       * Same non-optimistic path as the scheme: the flag is read by the live
       * matcher on every remote read, so the panel shows what the host applied
       * rather than what was clicked.
       */
      const savePassthroughFallback = async (next) => {
        await savePassthrough({ remoteMissFallback: next }, 'passthrough.fallbackFail', 'SSHWSP-E-PASSTHROUGH-FALLBACK')
      }

      // Merge the background-retry rows onto the connection rows. A host that
      // dropped out of the pool entirely still has a retry entry, so keying off
      // `connections` alone would hide exactly the host the user needs to see.
      const connMap = new Map()
      for (const c of status.connections ?? []) connMap.set(c.alias, { ...c })
      // Connection intent / boot-dial / last failure decorate the SAME `conn`
      // object the card already receives — no new prop, so the card's compiled
      // test harness and the pinned meta row are untouched. A host that is only
      // connecting (no pool record yet) still gets a row so its badge appears.
      const autoConnectSet = new Set(status.autoConnect ?? [])
      const connectingSet = new Set(status.connecting ?? [])
      const failureMap = new Map()
      for (const row of status.failures ?? []) {
        if (typeof row?.alias === 'string' && typeof row.error === 'string') failureMap.set(row.alias, row.error)
      }
      const ensureRow = (alias) => {
        if (!connMap.has(alias)) connMap.set(alias, { alias, state: 'broken', inFlight: 0 })
        return connMap.get(alias)
      }
      for (const alias of failureMap.keys()) ensureRow(alias).failure = failureMap.get(alias)
      for (const alias of connectingSet) ensureRow(alias).connecting = true
      for (const alias of autoConnectSet) ensureRow(alias).autoConnect = true
      for (const retry of status.reconnecting ?? []) {
        connMap.set(retry.alias, { ...ensureRow(retry.alias), retry })
      }

      // Which workspace rows can no longer reach their host: the host list is
      // what the mount dialog offers, so an alias missing from it is gone, not
      // merely disconnected. Guarded on a complete listing — see missingHostOf.
      const knownAliases = new Set(hosts.map(host => host.alias))
      // The hosts a control may OFFER: a host switched off is still listed on the
      // cards (that is where the switch back lives), but it cannot be dialled, so
      // offering it in a "connect to…"-style picker would only produce an error.
      const enabledHosts = hosts.filter(host => host.enabled !== false)
      // Hosts switched off from their card. Their workspaces stay mounted — the
      // record is untouched, and unmounting is a different decision the user has
      // not made — but nothing under them can be reached until the switch is
      // back, so the row dims and the chip says which switch to look for.
      const offHosts = new Set(hosts.filter(host => host.enabled === false).map(host => host.alias))
      const hostListingComplete = hostListingLoaded && listingGaps.storeError === undefined && (listingGaps.skipped ?? []).length === 0

      // While a retry is pending the countdown must move. The panel otherwise
      // only refreshes on user action, so "in 12s" would sit there frozen.
      // Skipped while the tab is hidden: a background tab polling a host that is
      // failing to connect is pure noise, and the first visible tick catches up.
      const retrying = (status.reconnecting ?? []).length > 0 || (status.connecting ?? []).length > 0
      React.useEffect(() => {
        if (!retrying) return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden === true) return
          refresh()
        }, 5000)
        return () => clearInterval(timer)
      }, [retrying, refresh])

      // The server's verdict for the report section: `state` plus one row per
      // finding. Derived from the same fields `/support-bundle` prints, so the
      // dot and the paste cannot disagree — which is why it is computed on the
      // server and shipped here rather than re-derived in the browser.
      const diagnosis = status.diagnosis ?? { version: 0, state: 'unknown', warn: 0, unknown: 0, findings: [] }

      // The self-check list the panel renders: the server's cached probe for
      // each host, overlaid with any report this panel fetched on demand. The
      // overlay is per alias, so a fresh report for one host never replaces
      // another host's cached verdicts.
      // The rows come from `/status` FIRST, and that ordering is the whole bug
      // fix: `checkReports` is React state, so it dies with the panel. Switching
      // to another page and back left this list holding only `missing` (which
      // travels in `/status`) and no `rows` at all — the card kept saying
      // "2 missing" and could not name a single one. `/status` re-derives the
      // same rows from the server's probe cache on every poll, so it is both
      // the durable source and an equally fresh one; a report fetched here by
      // pressing Self-check wins when it exists, because it may be newer than
      // the last poll.
      // Empty while the section is gated off, so a hidden section does no merge
      // work on a list that arrives on every poll — and still an array, so
      // nothing that reads it has to know about the flag.
      const selfCheckRows = !SHOW_SELF_CHECK_SECTION ? []
        : ((status.selfCheck ?? []).length > 0
        ? (status.selfCheck ?? []).map((check) => ({
            alias: check.alias,
            missing: check.missing ?? [],
            rows: checkReports[check.alias]?.rows ?? check.rows ?? [],
          }))
        : Object.entries(checkReports).map(([alias, report]) => ({
            alias,
            missing: report.missing ?? [],
            rows: report.rows ?? [],
          })))

      // One array per tab. A tab owns SEVERAL sections — workspaces is mounted +
      // detached, diagnostics is self-check + recent commands + the report — and
      // only the active pane renders. That is the point of the tabs: nine
      // sections used to be one long scroll, so "where is the forward form"
      // depended on remembering how far down it was.
      const paneHosts = [
        // ---- Hosts
        jsxs('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('hosts.title') }),
          jsx('button', { className: 'sshwsp-btn', onClick: () => setEditorHost(null), children: t('hosts.add') }),
        ]}),
        hosts.length === 0
          ? jsxs('div', { className: 'sshwsp-empty', children: [
              // "Nothing configured" and "I could not read the configuration"
              // are different facts and must not share a sentence: only the
              // second one is actionable, and it was previously invisible.
              jsx('div', { children: loading
                ? t('panel.loading')
                : listingGaps.storeError !== undefined ? t('panel.storeError') : t('panel.empty') }),
              listingGaps.storeError !== undefined &&
                jsx('div', { className: 'sshwsp-empty-detail', children: String(listingGaps.storeError) }),
              listingGaps.skipped.length > 0 &&
                jsx('div', { className: 'sshwsp-empty-detail', children: t('panel.skipped').replace('{n}', String(listingGaps.skipped.length)) }),
            ]})
          : jsxs('div', { children: [
              jsx(CappedList, {
                className: 'sshwsp-hosts',
                children: hosts.map((host) => jsx(HostCard, {
                  key: host.alias,
                  host,
                  t,
                  conn: connMap.get(host.alias),
                  onTest: handleTest,
                  onBrowse: setBrowserAlias,
                  onEdit: (row) => setEditorHost(row),
                  onDelete: handleDelete,
                  onForgetKey: handleForgetKey,
                  onDisconnect: handleDisconnect,
                  onReconnect: handleReconnect,
                  onSetIntent: handleSetIntent,
                  onTogglePower: handleHostPower,
                  powerBusy: powerBusyAlias === host.alias,
                  testState: testStates[host.alias],
                  deleteError: deleteErrors[host.alias],
                  deleting: deletingAlias === host.alias,
                })),
              }),
              // Gaps stay visible even when some rows DID load: a host that
              // exists but cannot be used is the one the user is looking for.
              listingGaps.storeError !== undefined &&
                jsx('div', { className: 'sshwsp-empty-detail', children: `${t('panel.storeError')}: ${listingGaps.storeError}` }),
              listingGaps.skipped.length > 0 &&
                jsx('div', { className: 'sshwsp-empty-detail', children: t('panel.skipped').replace('{n}', String(listingGaps.skipped.length)) }),
            ]}),
      ]

      // /status lists a mounted workspace by PATH, but the name the user gave it
      // is what the sidebar and the tabs call it. A row shows both, so a list of
      // near-identical remote paths stays scannable. When the record carries no
      // title — or the path is not a registered workspace at all — the last path
      // segment is the honest fallback rather than an empty line.
      const workspaceTitleOf = (wsPath) => {
        const record = (status.workspaces ?? []).find(workspace => workspace.path === wsPath)
        const title = typeof record?.title === 'string' ? record.title.trim() : ''
        if (title !== '') return title
        const trimmed = wsPath.replace(/[\\/]+$/u, '')
        const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
        return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
      }

      const paneWorkspaces = [
        // ---- Mounted workspaces
        jsx('h3', { children: t('mounted.title') }),
        (status.mounted ?? []).length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('mounted.none') })
          : jsx(CappedList, { className: 'sshwsp-mounts', children: (status.mounted ?? []).map((wsPath) => {
              const unmounting = unmountBusy === wsPath
              const discarding = discardBusy === wsPath
              const busy = unmounting || discarding
              const armedUnmount = unmountConfirm === wsPath
              const armedDiscard = discardConfirm === wsPath
              const goneHost = missingHostOf(wsPath, knownAliases, hostListingComplete)
              const offHost = offHosts.has(workspaceAliasOf(wsPath) ?? '')
              return jsxs('div', {
                key: wsPath,
                className: offHost ? 'sshwsp-mount sshwsp-mount-hostoff' : 'sshwsp-mount',
                'data-sshwsp-hostoff': offHost ? '1' : undefined,
                children: [
                // Two lines, not one: the name is what the sidebar calls this
                // workspace and the path is what every dialog asks for, so the
                // row carries both. One line held only the path, which made a
                // list of `/home/<user>/<similar>` entries impossible to scan.
                jsxs('div', { className: 'sshwsp-mount-info', children: [
                  jsxs('div', { className: 'sshwsp-mount-titlerow', children: [
                    goneHost !== null && jsx(MissingHostMark, { alias: goneHost, text: t('workspace.hostMissing') }),
                    React.createElement(RemoteMarkIcon, { size: 16, className: 'sshwsp-entry-icon' }),
                    jsx('span', { className: 'sshwsp-mount-title', children: workspaceTitleOf(wsPath) }),
                    offHost && jsx('span', { className: 'sshwsp-badge', children: t('hosts.powerOffBadge') }),
                  ]}),
                  jsx('span', { className: 'sshwsp-mount-path', children: wsPath }),
                ]}),
                armedUnmount
                  ? jsxs(Fragment, { children: [
                      jsx('button', {
                        className: 'sshwsp-btn',
                        disabled: busy,
                        // Same tooltip as the unarmed button: this IS that button
                        // once armed, and the armed state is the moment the
                        // consequence matters most.
                        title: t('mounted.detachHint'),
                        onClick: () => handleUnmount(wsPath),
                        children: unmounting ? t('mounted.unmounting') : t('mounted.confirmDetach'),
                      }),
                      jsx('button', {
                        className: 'sshwsp-btn',
                        disabled: busy,
                        onClick: () => setUnmountConfirm(null),
                        children: t('editor.cancel'),
                      }),
                    ]})
                  : armedDiscard
                    ? jsxs(Fragment, { children: [
                        jsx(DiscardChoices, {
                          t,
                          record: discardRecord,
                          sessions: discardSessions,
                          busy,
                          onRecord: setDiscardRecord,
                          onSessions: setDiscardSessions,
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn sshwsp-btn-danger',
                          disabled: busy || (!discardRecord && !discardSessions),
                          title: t('workspace.deleteHint'),
                          onClick: () => handleDiscard(wsPath, discardRecord, discardSessions),
                          children: discarding ? t('workspace.deleting') : t('workspace.confirmDelete'),
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn',
                          disabled: busy,
                          onClick: () => setDiscardConfirm(null),
                          children: t('editor.cancel'),
                        }),
                      ]})
                    : jsxs(Fragment, { children: [
                        jsx('button', {
                          className: 'sshwsp-btn',
                          disabled: busy,
                          title: t('mounted.detachHint'),
                          onClick: () => { setUnmountConfirm(wsPath); setDiscardConfirm(null) },
                          children: t('mounted.unmount'),
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn sshwsp-btn-danger',
                          disabled: busy,
                          title: t('workspace.deleteHint'),
                          onClick: () => {
                            setDiscardConfirm(wsPath)
                            setUnmountConfirm(null)
                            setDiscardRecord(true)
                            setDiscardSessions(true)
                          },
                          children: t('workspace.delete'),
                        }),
                      ]}),
              ]})
            })}),
        // ---- Detached workspaces
        // Always rendered: an empty section is how the user learns that
        // "unmount" leaves something behind to re-enable, and where it went.
        // What "detached" means is one focus stop away instead of a paragraph
        // between the heading and the rows it describes.
        jsxs('h3', { children: [
          t('detached.title'),
          jsx(TipMark, { label: t('detached.title'), text: t('detached.hint') }),
        ]}),
        (status.disabled ?? []).length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('detached.none') })
          : jsxs(Fragment, { children: [
              jsx(CappedList, { className: 'sshwsp-mounts', children: (status.disabled ?? []).map((wsPath) => {
                const enabling = enableBusy === wsPath
                const discarding = discardBusy === wsPath
                const busy = enabling || discarding
                // Same armed row as the mounted list, same two boxes: a detached
                // workspace is deleted by the same request, and the only thing
                // that differs is what "delete" means for a row that is already
                // off — which is exactly why the boxes have to be visible here
                // too instead of one fixed choice baked in.
                const armed = discardConfirm === wsPath
                const goneHost = missingHostOf(wsPath, knownAliases, hostListingComplete)
                return jsxs('div', { key: wsPath, className: 'sshwsp-mount sshwsp-mount-off', children: [
                  jsxs('div', { className: 'sshwsp-mount-info', children: [
                    jsxs('div', { className: 'sshwsp-mount-titlerow', children: [
                      goneHost !== null && jsx(MissingHostMark, { alias: goneHost, text: t('workspace.hostMissing') }),
                      React.createElement(RemoteMarkIcon, { size: 16, className: 'sshwsp-entry-icon' }),
                      jsx('span', { className: 'sshwsp-mount-title', children: workspaceTitleOf(wsPath) }),
                      // The state chip belongs on the title line, next to the
                      // name it qualifies, not after the path: "detached" is a
                      // fact about the workspace, and the path is only where it
                      // used to point.
                      jsx('span', { className: 'sshwsp-badge', children: t('detached.badge') }),
                    ]}),
                    jsx('span', { className: 'sshwsp-mount-path', children: wsPath }),
                  ]}),
                  armed
                    ? jsxs(Fragment, { children: [
                        jsx(DiscardChoices, {
                          t,
                          record: discardRecord,
                          sessions: discardSessions,
                          busy,
                          onRecord: setDiscardRecord,
                          onSessions: setDiscardSessions,
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn sshwsp-btn-danger',
                          disabled: busy || (!discardRecord && !discardSessions),
                          // Kept on the CONFIRM button, not only on the unarmed
                          // one: this is the click that cannot be undone when the
                          // record box is ticked, so the explanation must not
                          // disappear on the way in.
                          title: t('workspace.deleteHint'),
                          onClick: () => handleDiscard(wsPath, discardRecord, discardSessions),
                          children: discarding ? t('workspace.deleting') : t('workspace.confirmDelete'),
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn',
                          disabled: busy,
                          onClick: () => setDiscardConfirm(null),
                          children: t('editor.cancel'),
                        }),
                      ]})
                    : jsxs(Fragment, { children: [
                        jsx('button', {
                          className: 'sshwsp-btn',
                          disabled: busy,
                          onClick: () => handleEnable(wsPath),
                          children: enabling ? t('detached.enabling') : t('detached.enable'),
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn sshwsp-btn-danger',
                          disabled: busy,
                          title: t('workspace.deleteHint'),
                          onClick: () => {
                            setDiscardConfirm(wsPath)
                            setDiscardRecord(true)
                            setDiscardSessions(true)
                          },
                          children: t('workspace.delete'),
                        }),
                      ]}),
                ]})
              })}),
            ]}),
      ]

      const paneSettings = [
        // ---- A server older than this client: say it once, at the top
        restartNeeded
          ? jsxs('div', { className: 'sshwsp-status sshwsp-status-warn', role: 'status', children: [
              jsx('strong', { children: t('settings.restartRequired') }),
              jsx('span', { children: t('settings.restartRequiredHint') }),
            ] })
          : null,
        // ---- Port forwards
        // The autostart switch lives in the head, next to the title, the way the
        // prototype has it: it is a property OF forwarding, not a step after the
        // form, and as its own row it read like a third field of the form.
        jsxs('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('forwards.title') }),
          jsx('label', {
            className: 'sshwsp-check sshwsp-forward-autostart',
            // The explanation is a hover tooltip rather than a permanent line:
            // it only matters the first time, and leaving it inline pushed the
            // saved-mapping list down on every render.
            title: t('forwards.autoStartHint'),
            children: [
              jsx('input', {
                type: 'checkbox',
                className: 'sshwsp-switch',
                checked: status.forwardSettings?.autoStart === true,
                onChange: (event) => handleAutoStart(event.target.checked),
              }),
              jsxs('span', { className: 'sshwsp-check-text', children: [
                jsx('span', { className: 'sshwsp-field-label', children: t('forwards.autoStart') }),
              ]}),
            ],
          }),
        ]}),
        jsxs('div', { className: 'sshwsp-forward-new', children: [
          jsx('select', {
            className: 'sshwsp-input sshwsp-select',
            value: forwardAlias,
            disabled: forwardBusy || enabledHosts.length === 0,
            onChange: (event) => setForwardAlias(event.target.value),
            children: [
              jsx('option', { value: '', children: t('remote.host') }),
              ...enabledHosts.map((host) => jsx('option', { key: host.alias, value: host.alias, children: host.alias })),
            ],
          }),
          hosts.length > 0 && enabledHosts.length === 0 && jsx('div', { className: 'sshwsp-empty-detail', children: t('forwards.allHostsOff') }),
          jsx('input', {
            className: 'sshwsp-input sshwsp-input-port',
            type: 'number',
            min: 1,
            max: 65535,
            // The box is deliberately narrow, so the placeholder is also the
            // only label: title keeps the full meaning reachable when the
            // text clips.
            placeholder: t('forwards.remotePort'),
            title: t('forwards.remotePort'),
            value: forwardRemotePort,
            disabled: forwardBusy,
            onChange: (event) => { setForwardRemotePort(event.target.value); setPortCheck(null) },
            onKeyDown: (event) => { if (event.key === 'Enter') handleForward() },
          }),
          jsx('input', {
            className: 'sshwsp-input sshwsp-input-port',
            type: 'number',
            min: 1,
            max: 65535,
            placeholder: t('forwards.localPlaceholder'),
            title: `${t('forwards.localPort')} — ${t('forwards.localPlaceholder')}`,
            value: forwardLocalPort,
            disabled: forwardBusy,
            onChange: (event) => { setForwardLocalPort(event.target.value); setPortCheck(null) },
            onBlur: checkForwardPort,
            onKeyDown: (event) => { if (event.key === 'Enter') handleForward() },
          }),
          jsx('button', {
            className: 'sshwsp-btn sshwsp-btn-primary',
            disabled: forwardBusy || forwardAlias === '' || forwardRemotePort.trim() === '',
            onClick: handleForward,
            children: forwardBusy ? t('forwards.saving') : t('forwards.save'),
          }),
        ]}),
        // The probe is advisory: it names the reason early, but the save path
        // probes again and the real bind stays the authority.
        portCheck !== null && jsx('div', {
          className: `sshwsp-porthint ${portCheck.state === 'busy' ? 'sshwsp-porthint-busy' : portCheck.state === 'free' ? 'sshwsp-porthint-free' : ''}`,
          children: portCheck.state === 'checking'
            ? t('forwards.checking')
            : portCheck.state === 'free'
              ? t('forwards.portFree')
              : portCheck.code === 'EADDRINUSE' ? t('forwards.portBusy') : t('forwards.portReserved'),
        }),
        (status.forwardRows ?? []).length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('forwards.none') })
          : jsx(CappedList, { className: 'sshwsp-forwards', children: (status.forwardRows ?? []).map((forward) => {
              const busy = forwardRowBusy === forward.id
              const live = forward.live === true
              const url = forwardUrlOf(forward)
              return jsxs('div', {
                key: forward.id,
                className: `sshwsp-mount sshwsp-forward-row${live ? '' : ' sshwsp-forward-off'}`,
                children: [
                  jsx('span', {
                    className: 'sshwsp-mount-path',
                    children: `${forward.localHost}:${forward.localPort} → ${forward.alias}:${forward.remoteHost}:${forward.remotePort}`,
                  }),
                  // The state chip reports the runtime fact; the stored intent
                  // only decides whether a tunnel comes back on startup.
                  jsx('span', {
                    className: `sshwsp-status ${live ? 'sshwsp-status-ok' : 'sshwsp-status-warn'}`,
                    children: live ? t('forwards.enabled') : t('forwards.disabled'),
                  }),
                  live && forward.connections > 0 && jsx('span', { className: 'sshwsp-entry-meta', children: t('forwards.connections', { n: forward.connections }) }),
                  !live && typeof forward.error === 'string' && forward.error !== '' && jsx('span', {
                    className: 'sshwsp-error sshwsp-forward-error',
                    title: forward.error,
                    children: forward.error.includes('connection') ? t('forwards.lost') : forward.error,
                  }),
                  live && jsx('a', {
                    className: 'sshwsp-btn',
                    href: url,
                    target: '_blank',
                    rel: 'noreferrer',
                    children: t('forwards.open'),
                  }),
                  forward.persisted === true
                    ? jsx('button', {
                        className: 'sshwsp-btn',
                        disabled: busy,
                        // Label follows the runtime fact, so a dead tunnel never
                        // shows "turn off".
                        onClick: () => handleForwardToggle(forward),
                        children: busy ? t('forwards.busy') : live ? t('forwards.disable') : t('forwards.enable'),
                      })
                    : jsxs(Fragment, { children: [
                        // A transient tunnel (opened by the agent tool) can be
                        // closed here too, but it has no stored row to toggle:
                        // it can only be closed or kept.
                        jsx('button', {
                          className: 'sshwsp-btn sshwsp-btn-danger',
                          disabled: busy,
                          onClick: () => handleUnforward(forward.id),
                          children: t('forwards.close'),
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn',
                          disabled: busy,
                          title: t('forwards.rememberHint'),
                          onClick: () => handleForwardRemember(forward.id),
                          children: busy ? t('forwards.busy') : t('forwards.remember'),
                        }),
                      ]}),
                  forward.persisted === true && forwardDeleteId === forward.id
                    ? jsxs(Fragment, { children: [
                        jsx('button', {
                          className: 'sshwsp-btn sshwsp-btn-danger',
                          disabled: busy,
                          onClick: () => handleForwardDelete(forward.id),
                          children: t('forwards.deleteConfirm'),
                        }),
                        jsx('button', {
                          className: 'sshwsp-btn',
                          disabled: busy,
                          onClick: () => setForwardDeleteId(null),
                          children: t('editor.cancel'),
                        }),
                      ]})
                    : forward.persisted === true && jsx('button', {
                        className: 'sshwsp-btn sshwsp-btn-danger',
                        disabled: busy,
                        onClick: () => setForwardDeleteId(forward.id),
                        children: t('forwards.delete'),
                      }),
                  // A saved row that is not live but whose intent is on means
                  // the tunnel went away by itself — clarify that it will come
                  // back only when auto-start is on and the plugin restarts.
                  forward.persisted === true && !live && forward.enabled === true && jsx('span', {
                    className: 'sshwsp-entry-meta',
                    children: status.forwardSettings?.autoStart === true ? t('forwards.autoStart') : '',
                  }),
                ],
              })
            })}),
        // ---- Persistent remote shells
        // Only shown once the agent has opened one: an empty section would
        // suggest a control this panel does not own.
        (status.shells ?? []).length > 0 && jsxs('div', { children: [
          jsx('h3', { children: t('shells.title') }),
          (status.shells ?? []).map((shell) => jsxs('div', {
            key: `${shell.alias}:${shell.session}`,
            className: 'sshwsp-mount',
            children: [
              jsx('span', { className: 'sshwsp-mount-path', children: `${shell.alias} [${shell.session}]` }),
              jsx('span', {
                className: 'sshwsp-entry-meta',
                children: shell.alive ? t('shells.alive') : t('shells.closed'),
              }),
            ],
          })),
        ]}),
        // ---- File references (host paths inside an ssh:// session)
        // ONE title over the field, the way the prototype has it: the zone head
        // names the zone ("File reference settings") and the field label names
        // both halves of the setting — what a scheme is for, and what this one
        // is called. There used to be an `h4` between them, which gave the same
        // control two headings and pushed the box a line further from the thing
        // it belongs to.
        //
        // Both controls write straight through to the live matcher, so there is
        // no Apply button: the scheme box saves on Enter or on Save, and the
        // switch saves on click. The zone renders even when passthrough is
        // off (empty localPassthrough) because the settings still persist for
        // when it is switched on — the notice says they have no effect now.
        jsx('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('passthrough.group') }),
        ]}),
        !loading && status.passthrough?.enabled === false &&
          jsx('div', { className: 'sshwsp-passthrough-off', children: t('passthrough.disabled') }),
        // A value saved by an older build may no longer be legal (`file`, or a
        // one-character name). It is degraded rather than rewritten — the
        // store is the user's file — so the panel has to say which value is
        // stored, which one is actually in force, and that only a save confirms
        // the change. Without this line the prefix just "stops working" with no
        // visible cause.
        !loading && status.passthrough?.schemeWarning != null &&
          jsx('div', {
            className: 'sshwsp-passthrough-off sshwsp-passthrough-stale',
            children: (() => {
              const warning = status.passthrough.schemeWarning
              return t('passthrough.schemeWarning')
                .replace('{stored}', String(warning.stored))
                .replace('{effective}', String(warning.effective))
                .replace('{message}', String(warning.message))
            })(),
          }),
        // The scheme box used to be an unlabelled input: nothing on screen said
        // what a word typed into it would do, so the rule lived in a `title`.
        // The label is what makes the tip reachable without a mouse; it names
        // the whole setting, while the input keeps `passthrough.scheme` as its
        // own accessible name so renaming the label cannot rename the field.
        jsxs('div', { className: 'sshwsp-field', children: [
          jsxs('div', { className: 'sshwsp-field-label-row', children: [
            jsx('span', { className: 'sshwsp-field-label', children: t('passthrough.schemeLabel') }),
            jsx(TipMark, { label: t('passthrough.schemeLabel'), text: t('passthrough.schemeHint') }),
          ]}),
          jsxs('div', { className: 'sshwsp-passthrough-row', children: [
            jsx('input', {
              className: 'sshwsp-input',
              type: 'text',
              // Not `spellCheck: false` alone: the box holds a scheme name, and
              // both autocorrect and the OS credential/password manager offer to
              // "help" with a one-word field, which is never what is wanted here.
              autoComplete: 'off',
              spellCheck: false,
              value: passthroughSchemeValue,
              placeholder: t('passthrough.schemePlaceholder'),
              // A scheme name has no reason to be long. The limit is a comfort
              // bound, not a rule: the server publishes the real minimum and the
              // real syntax through `schemeRules`, and nothing here rejects on
              // width.
              maxLength: 32,
              'aria-label': t('passthrough.scheme'),
              disabled: passthroughBusy,
              onChange: (event) => setPassthroughScheme(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') savePassthroughScheme() },
            }),
            jsx('button', {
              className: 'sshwsp-btn',
              disabled: passthroughBusy,
              onClick: () => savePassthroughScheme(),
              children: t('passthrough.schemeSave'),
            }),
          ]}),
        ]}),
        jsx('label', {
          className: 'sshwsp-check sshwsp-passthrough-fallback',
          children: [
            jsx('input', {
              type: 'checkbox',
              className: 'sshwsp-switch',
              checked: status.passthrough?.remoteMissFallback === true,
              disabled: passthroughBusy,
              onChange: (event) => savePassthroughFallback(event.target.checked),
            }),
            jsx('span', { className: 'sshwsp-check-text', children: jsxs('span', {
              className: 'sshwsp-field-label-row',
              children: [
                jsx('span', { className: 'sshwsp-field-label', children: t('passthrough.fallback') }),
                jsx(TipMark, { label: t('passthrough.fallback'), text: t('passthrough.fallbackHint') }),
              ],
            }) }),
          ],
        }),
        // ---- Browse dialogs
        //
        // Its own section, the way the prototype has it: the two directory
        // pickers are the only place a file can appear, and whether they show
        // files is a property OF those dialogs, not of the file viewer below.
        // Filing it under "file viewing" was one heading too few and made the
        // switch look like it changed where a file opens.
        jsx('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('fileview.browserGroup') }),
        ]}),
        // Files appear as context rows — never as pickable targets. Off by
        // default: the pickers exist to choose a directory, and a file in the
        // way of that choice is the first thing a user would complain about.
        jsx('label', {
          className: 'sshwsp-check sshwsp-check-stacked',
          children: [
            jsx('input', {
              type: 'checkbox',
              className: 'sshwsp-switch',
              checked: status.preferences?.showFiles === true,
              disabled: fileViewBusy,
              onChange: (event) => saveFileViewPreference({ showFiles: event.target.checked }),
            }),
            jsxs('span', { className: 'sshwsp-check-text', children: [
              jsxs('span', { className: 'sshwsp-field-label-row', children: [
                jsx('span', { className: 'sshwsp-field-label', children: t('fileview.showFiles') }),
                jsx(TipMark, { label: t('fileview.showFiles'), text: t('fileview.showFilesHint') }),
              ]}),
            ]}),
          ],
        }),
        // ---- File viewing (where a clicked tree file opens)
        //
        // A TWO-STATE switch, not a checkbox: "open in the right-hand tree"
        // is a real second answer, and a single box can only say "on/off" —
        // the user would have to guess what "off" falls back to. The composer
        // switch below it is a separate question and stays one: the composer
        // does not belong to any view, so it is on screen under a file tab too.
        jsx('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('fileview.group') }),
        ]}),
        // The segmented control gets its own line, with the question on the
        // left and the answer on the right: without a visible label the two
        // buttons read as a filter for the section rather than as the answer to
        // "where does a clicked file open".
        jsxs('div', { className: 'sshwsp-seg-row', children: [
          jsx('span', { className: 'sshwsp-field-label', children: t('fileview.target') }),
          jsx('div', {
            className: 'sshwsp-seg',
            role: 'radiogroup',
            'aria-label': t('fileview.target'),
            children: ['sidebar', 'conversation'].map((mode) => {
              const on = (status.preferences?.fileView ?? 'sidebar') === mode
              return jsx('button', {
                key: mode,
                type: 'button',
                role: 'radio',
                'aria-checked': on,
                className: on ? 'sshwsp-seg-btn sshwsp-seg-btn-on' : 'sshwsp-seg-btn',
                disabled: fileViewBusy,
                onClick: () => { if (!on) saveFileViewPreference({ fileView: mode }) },
                children: t(mode === 'sidebar' ? 'fileview.sidebar' : 'fileview.conversation'),
              })
            }),
          }),
        ]}),
        // The composer is a sticky seat UNDER the view area, not part of it, so
        // it stays on screen while a file tab is open. This is the switch that
        // gives the file the whole column instead. Default ON (the server's
        // default, mirrored here by `!== false`).
        //
        // Only when the target is the conversation: with the right-hand tree the
        // composer is not the same question (the file never covers it), and a
        // switch that cannot change anything is furniture — the prototype hides
        // the row outright rather than greying it out.
        (status.preferences?.fileView ?? 'sidebar') === 'conversation' && jsx('label', {
          className: 'sshwsp-check sshwsp-composer-toggle',
          children: [
            jsx('input', {
              type: 'checkbox',
              className: 'sshwsp-switch',
              checked: status.preferences?.hideComposer !== false,
              disabled: fileViewBusy,
              onChange: (event) => saveFileViewPreference({ hideComposer: event.target.checked }),
            }),
            jsxs('span', { className: 'sshwsp-check-text', children: [
              jsx('span', { className: 'sshwsp-field-label', children: t('fileview.hideComposer') }),
            ]}),
          ],
        }),
        // ---- Remote environment self-check
        // Rendered even when empty: the section is how a user DISCOVERS that a
        // missing remote tool is the reason a feature is degraded, and an
        // always-empty section teaches that it exists.
        //
        // Gated off for now — see SHOW_SELF_CHECK_SECTION. Both elements of the
        // section carry the guard, because they are one section: a heading with
        // no list under it would be worse than either half alone.
        SHOW_SELF_CHECK_SECTION && jsxs('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('check.title') }),
          jsx('button', {
            className: 'sshwsp-btn',
            disabled: checkBusy !== null || hosts.length === 0,
            onClick: () => runSelfCheck(hosts[0]?.alias),
            children: checkBusy !== null ? t('check.running') : t('check.run'),
          }),
        ]}),
        SHOW_SELF_CHECK_SECTION && (selfCheckRows.length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('check.none') })
          : jsx(CappedList, {
              className: 'sshwsp-check',
              children: selfCheckRows.map((check) => {
                const summary = selfCheckSummary(check.rows, check.missing)
                const open = expandedChecks[check.alias] === true
                // Expandable even with nothing missing: "which tools were
                // checked" is the question a green row raises, and a card that
                // cannot answer it is a card the user learns to ignore.
                const canExpand = summary.total > 0 || summary.absentCount > 0
                return jsxs('div', {
                  key: check.alias,
                  className: 'sshwsp-mount sshwsp-mount-col',
                  children: [
                    // A real button, not a div with onClick: the disclosure has
                    // to be reachable by keyboard and has to announce whether it
                    // is open, and both come free with the element.
                    jsxs('button', {
                      type: 'button',
                      className: 'sshwsp-check-head',
                      'aria-expanded': canExpand ? open : undefined,
                      disabled: !canExpand,
                      onClick: () => setExpandedChecks((prev) => ({ ...prev, [check.alias]: !open })),
                      children: [
                        jsx('span', { className: 'sshwsp-check-caret', 'aria-hidden': 'true', children: canExpand ? (open ? '▾' : '▸') : '·' }),
                        jsx('span', { className: 'sshwsp-mount-path', children: check.alias }),
                        summary.absentCount > 0 && jsx('span', {
                          className: 'sshwsp-status sshwsp-status-warn',
                          children: `${summary.absentCount} ${t('check.absent')}`,
                        }),
                        summary.unknown.length > 0 && jsx('span', {
                          className: 'sshwsp-status sshwsp-status-off',
                          children: `${summary.unknown.length} ${t('check.unknown')}`,
                        }),
                        // The names, inline, when the list cannot be expanded —
                        // a count with no way to see what it counts is the
                        // puzzle this whole section exists to avoid.
                        !canExpand && (check.missing ?? []).length > 0 && jsx('span', {
                          className: 'sshwsp-check-inline',
                          children: (check.missing ?? []).join(', '),
                        }),
                        jsx('span', { className: 'sshwsp-check-spacer' }),
                        summary.total > 0 && jsx('span', {
                          className: 'sshwsp-entry-meta',
                          children: `${summary.present}/${summary.total} ${t('check.present')}`,
                        }),
                      ],
                    }),
                    open && jsx(SelfCheckList, { rows: check.rows, t }),
                  ],
                })
              }),
            })),
        // ---- Diagnostic report
        // The one artifact meant to be pasted in public. The hint states what
        // it contains (and that it is already masked), because "copy my
        // diagnostics" is a request a careful user should be able to refuse
        // with full information.
        //
        // The dot beside the title is the verdict: green when the server
        // judged everything fine, red when something needs attention, amber
        // when something could not be judged. It is derived server-side from
        // the same fields the report prints, so the dot and the paste cannot
        // disagree — and it is the ONE thing this section could not say
        // before: the report is a fact sheet with no verdict anywhere in it.
        //
        // "Copy" lives inside the report window, not here: copying only makes
        // sense once there is a report to copy, and a button that silently
        // produces a dialog instead of a clipboard entry (the no-clipboard
        // fallback) is a button whose label promised the wrong thing.
        jsxs('div', { className: 'sshwsp-section-head', children: [
          jsxs('h3', { className: 'sshwsp-report-title', children: [
            jsx('span', { children: t('support.title') }),
            diagnosis !== undefined && jsx('span', {
              className: `sshwsp-dot sshwsp-dot-${diagnosis.state === 'ok' ? 'ok' : diagnosis.state === 'warn' ? 'err' : 'warn'}`,
              role: 'img',
              title: diagnosis.state === 'ok'
                ? t('diagnosis.ok')
                : diagnosis.state === 'warn'
                  ? t('diagnosis.warn', { n: diagnosis.warn })
                  : t('diagnosis.unknown', { n: diagnosis.unknown }),
              'aria-label': diagnosis.state === 'ok'
                ? t('diagnosis.ok')
                : diagnosis.state === 'warn'
                  ? t('diagnosis.warn', { n: diagnosis.warn })
                  : t('diagnosis.unknown', { n: diagnosis.unknown }),
            }),
          ]}),
          // A button, not an `<a href>`: the panel may run under the Desktop
          // app's `dsh-app://` origin, where a relative href resolves against
          // that scheme and the window-open policy denies it. `openSupportBundle`
          // fetches the same bytes through the panel's own credentials and
          // renders them in a dialog, which works in both shells.
          jsx('button', {
            className: 'sshwsp-btn',
            disabled: supportBusy,
            title: t('support.hint'),
            onClick: openSupportBundle,
            children: supportBusy ? t('check.running') : t('support.open'),
          }),
        ]}),
        jsx('div', { className: 'sshwsp-entry-meta', children: t('support.hint') }),
        transferActionsSlot === 'missing' && jsx('div', {
          className: 'sshwsp-status sshwsp-status-warn',
          style: { marginTop: 8, padding: '8px 12px', borderRadius: 6, display: 'inline-block' },
          role: 'status',
          children: t('queue.slotMissing'),
        }),
        // The findings, in the panel, so a red dot is actionable without
        // opening anything: a dot that says "something is wrong" and names
        // nothing is a puzzle, not a report.
        //
        // The badge tone follows the same rule as the report's own lines: a
        // finding the report marked WARN is a warning (yellow), only a line
        // that names something actually broken is red, and "could not be
        // judged" stays quiet (it is the weakest of the three, not a second
        // kind of alarm). Keeping the two surfaces on one rule is what stops
        // the badge and the report from disagreeing about the same finding.
        (diagnosis.findings ?? []).length > 0 && jsxs('div', { className: 'sshwsp-diagnosis', children: [
          ...(diagnosis.findings ?? []).slice(0, 8).map(finding => jsxs('div', {
            key: `${finding.id}:${finding.alias ?? ''}:${finding.detail}`,
            className: 'sshwsp-diagnosis-row',
            children: [
              jsx('span', {
                className: `sshwsp-status ${findingToneOf(finding) === 'bad' ? 'sshwsp-status-err' : findingToneOf(finding) === 'warn' ? 'sshwsp-status-warn' : 'sshwsp-status-off'}`,
                children: finding.state === 'warn' ? t('diagnosis.warnLabel') : t('diagnosis.unknownLabel'),
              }),
              finding.alias !== undefined && jsx('span', { className: 'sshwsp-entry-meta', children: finding.alias }),
              jsx('span', { className: 'sshwsp-diagnosis-detail', children: finding.detail }),
            ],
          })),
          (diagnosis.findings ?? []).length > 8 && jsx('div', { className: 'sshwsp-entry-meta', children: t('audit.more', { n: diagnosis.findings.length }) }),
        ]}),

        // Advisory rows: the self-check's own observations, rendered BESIDE the
        // findings and visually quieter. A missing optional tool degrades one
        // feature and is often not even changeable on that host, so it must not
        // read as the reason the dot is a colour — which is exactly what listing
        // it as a finding used to do.
        (diagnosis.notes ?? []).length > 0 && jsxs('details', { className: 'sshwsp-diagnosis-notes', children: [
          jsx('summary', { children: t('diagnosis.notes', { n: (diagnosis.notes ?? []).length }) }),
          ...(diagnosis.notes ?? []).slice(0, 12).map(note => jsxs('div', {
            key: `${note.id}:${note.alias ?? ''}:${note.detail}`,
            className: 'sshwsp-diagnosis-row',
            children: [
              note.alias !== undefined && jsx('span', { className: 'sshwsp-entry-meta', children: note.alias }),
              jsx('span', { className: 'sshwsp-diagnosis-detail', children: note.detail }),
            ],
          })),
          (diagnosis.notes ?? []).length > 12 && jsx('div', { className: 'sshwsp-entry-meta', children: t('audit.more', { n: diagnosis.notes.length }) }),
        ]}),

        // ---- About: the ask and the three exits
        //
        // Last thing on the page, below a hairline. Settings is where a reader goes
        // looking for "what is this thing", so the question and where to answer it
        // belong here; they are not SETTINGS, though, and mixing them into the rows
        // above would put a link where the eye expects a control.
        //
        // `target="_blank"` rather than a click handler: the Host's window-open hook
        // admits http/https and hands them to the system browser (see the note on
        // the report dialog for the scheme trap this avoids), and `rel` keeps the
        // opened page from reaching back through `window.opener`.
        jsxs('div', { className: 'sshwsp-about', children: [
          jsxs('a', {
            className: 'sshwsp-about-star',
            href: ABOUT_LINKS.star,
            target: '_blank',
            rel: 'noreferrer noopener',
            children: [
              React.createElement(GitHubIcon, { size: 16 }),
              jsx('span', { children: t('about.starLead') }),
              jsx('span', { className: 'sshwsp-about-cta', children: t('about.starCta') }),
            ],
          }),
          jsx('nav', {
            className: 'sshwsp-about-links',
            'aria-label': t('about.links'),
            children: ABOUT_LINKS.items.map(item => jsxs('a', {
              key: item.key,
              className: 'sshwsp-about-link',
              href: item.href,
              target: '_blank',
              rel: 'noreferrer noopener',
              children: [
                jsx('span', { children: t(item.key) }),
                React.createElement(ExternalLinkIcon, { size: 11 }),
              ],
            })),
          }),
        ]}),
      ]

      // ---- The command audit
      //
      // A tab of its own rather than another section under settings: this is
      // the one surface that answers "what ran on my hosts", and it is the
      // question a user opens the panel FOR after something surprising
      // happened. Settings is where a number lives; this is where the rows do.
      //
      // Which workspace a row belongs to is derived, not guessed: every remote
      // workspace on `/status` carries the ids of its sessions, so a row that
      // recorded a session resolves to that session's workspace. Rows without
      // one (the capability probes the plugin runs itself) get a dash and stay
      // out of a narrowed view — they belong to no workspace, and saying so is
      // better than filing them under whichever one happens to be first.
      const auditWorkspaceBySession = new Map()
      for (const workspace of status.workspaces ?? []) {
        for (const sessionId of workspace.sessionIds ?? []) {
          auditWorkspaceBySession.set(String(sessionId), String(workspace.path ?? ''))
        }
      }
      const workspacePathOfRow = (row) => (typeof row?.sessionId === 'string' && row.sessionId !== ''
        ? auditWorkspaceBySession.get(row.sessionId) ?? ''
        : '')
      const workspaceLabelOf = (path) => workspaceTitleOf(path) || path.split('/').filter(Boolean).pop() || path
      // The options come from the rows themselves, not from `/status`: a
      // workspace can be unmounted and still own half this log, and an option
      // that always filters to nothing is worse than no option at all.
      const auditWorkspaces = [...new Set(auditRows.map(workspacePathOfRow).filter(path => path !== ''))].sort()
      const auditVisible = auditWorkspace === ''
        ? auditRows
        : auditRows.filter(row => workspacePathOfRow(row) === auditWorkspace)
      const auditRetentionValue = auditRetention ?? status.audit?.retention ?? 200
      const paneAudit = [
        // Two questions, two places: how many rows to keep is a SETTING and
        // sits beside the button that saves it; which workspace to look at is a
        // FILTER and sits beside the count it filters. Stacked as four equal
        // boxes they read as one undifferentiated form.
        //
        // No Save button, as in the prototype: the number saves on Enter and on
        // blur, so the only visible control next to a setting is the setting.
        // The tooltip says so — a value that looks saved and is not is worse
        // than a button.
        jsxs('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('audit.tab') }),
          jsxs('div', { className: 'sshwsp-audit-tools', children: [
            jsxs('label', { className: 'sshwsp-retention', children: [
              jsx('span', { children: t('audit.retentionShort') }),
              jsx('input', {
                className: 'sshwsp-input sshwsp-retention-input',
                type: 'number',
                min: 1,
                max: 2000,
                value: String(auditRetentionValue),
                disabled: auditSaveBusy,
                title: t('audit.retentionHint'),
                'aria-label': t('audit.retention'),
                onChange: (event) => setAuditRetention(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') void saveAuditRetention() },
                onBlur: () => { void saveAuditRetention() },
              }),
              jsx('span', { className: 'sshwsp-retention-unit', children: t('audit.retentionUnit') }),
            ]}),
            jsx('button', {
              className: 'sshwsp-btn',
              disabled: auditBusy,
              onClick: () => { void loadAudit() },
              children: auditBusy ? t('audit.loading') : t('audit.reload'),
            }),
          ]}),
        ]}),
        jsxs('div', { className: 'sshwsp-audit-toolbar', children: [
          // Only real options: a select whose only entry is "all workspaces" is
          // furniture, and a greyed one reads as broken.
          auditWorkspaces.length > 0 && jsx('select', {
            className: 'sshwsp-input sshwsp-select',
            value: auditWorkspace,
            'aria-label': t('audit.workspace'),
            onChange: (event) => setAuditWorkspace(event.target.value),
            children: [
              jsx('option', { value: '', children: t('audit.allWorkspaces') }),
              ...auditWorkspaces.map(path => jsx('option', { key: path, value: path, children: workspaceLabelOf(path) })),
            ],
          }),
          // The number on screen is what the filter let through; the tooltip
          // carries the whole sentence (recorded / kept) so the toolbar stays
          // one line without hiding the totals.
          jsx('span', {
            className: 'sshwsp-audit-count',
            title: t('audit.summary', { shown: auditVisible.length, total: status.audit?.sequence ?? 0, keep: status.audit?.retention ?? 200 }),
            children: t('audit.count', { n: auditVisible.length }),
          }),
        ]}),
        auditError !== undefined && jsx('div', { className: 'sshwsp-status sshwsp-status-err', role: 'status', children: auditError }),
        auditVisible.length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: auditBusy ? t('audit.loading') : auditWorkspace === '' ? t('audit.empty') : t('audit.emptyFilter') })
          : jsxs(Fragment, {
              children: [
                // The header only exists when there are rows to name: an empty
                // log already has its own dashed box saying so, and a header
                // floating above nothing reads as a table that failed to load.
                jsxs('div', { className: 'sshwsp-audit-head', children: [
                  jsx('span', { children: t('audit.col.status') }),
                  jsx('span', { children: t('audit.col.command') }),
                  jsx('span', { children: t('audit.col.host') }),
                  jsx('span', { children: t('audit.col.workspace') }),
                  jsx('span', { children: t('audit.col.time') }),
                ]}),
                jsx(CappedList, {
                  className: 'sshwsp-audit sshwsp-audit-full',
                  // Every row is reachable; the window is fifteen rows tall.
                  cap: AUDIT_LIST_CAP,
                  children: auditVisible.slice().reverse().map((row) => {
                    // A short label in a fixed-width column, the full sentence in
                    // the tooltip: 「被拒绝（未执行）」 belongs in the record, not in
                    // a 62px cell that has to hold every status the same height.
                    const status = row.refused === true
                      ? t('audit.refusedShort')
                      : row.outcomeUnknown === true
                        ? t('audit.unknownShort')
                        : row.timedOut
                          ? t('audit.timedOut')
                          : row.exitCode === null || row.exitCode === 0
                            ? t('audit.ok')
                            : `exit ${row.exitCode}`
                    const statusDetail = row.refused === true
                      ? t('audit.refused')
                      : row.outcomeUnknown === true
                        ? t('audit.unknown')
                        : row.timedOut
                          ? t('audit.timedOut')
                          : `exit ${row.exitCode === null ? '?' : row.exitCode}`
                    const tone = row.refused === true ? 'sshwsp-status-warn' : row.outcomeUnknown === true || row.timedOut || (row.exitCode ?? 0) !== 0 ? 'sshwsp-status-err' : 'sshwsp-status-ok'
                    return jsxs('div', {
                      key: String(row.seq),
                      className: 'sshwsp-audit-row',
                      children: [
                        jsx('span', { className: `sshwsp-status ${tone}`, title: statusDetail, children: status }),
                        jsx('span', { className: 'sshwsp-audit-command', title: row.command, children: row.command }),
                        // The three trailing fields travel as one group so the
                        // narrow panel can stack them on their own line while
                        // `display:contents` still lets the wide grid place
                        // them in separate columns.
                        jsxs('span', { className: 'sshwsp-audit-meta', children: [
                          jsx('span', { className: 'sshwsp-audit-host', title: row.alias, children: row.alias }),
                          // The workspace this row's call named, or a dash with the
                          // reason in the tooltip: a probe was the plugin asking a
                          // host about itself, not somebody's work in a folder.
                          (() => {
                            const path = workspacePathOfRow(row)
                            return jsx('span', {
                              className: 'sshwsp-audit-workspace',
                              title: path === '' ? t('audit.noWorkspace') : path,
                              children: path === '' ? '—' : workspaceLabelOf(path),
                            })
                          })(),
                          jsx('span', { className: 'sshwsp-audit-when', children: formatAuditTime(row.at) }),
                        ]}),
                        typeof row.error === 'string' && row.error !== '' && jsx('span', { className: 'sshwsp-audit-error', title: row.error, children: row.error }),
                        jsx('button', {
                          type: 'button',
                          className: 'sshwsp-audit-copy',
                          title: t('audit.copyCommand'),
                          'aria-label': `${t('audit.copyCommand')}: ${row.command}`,
                          onClick: () => { void copyAuditCommand(row.command) },
                          children: jsx('svg', {
                            viewBox: '0 0 16 16',
                            fill: 'none',
                            stroke: 'currentColor',
                            'stroke-width': 1.6,
                            'stroke-linecap': 'round',
                            'stroke-linejoin': 'round',
                            'aria-hidden': 'true',
                            children: [
                              jsx('path', { d: 'M6 6h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z' }),
                              jsx('path', { d: 'M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5' }),
                            ],
                          }),
                        }),
                      ],
                    })
                  }),
                }),
              ],
            }),
        // The one sentence a reader needs before trusting the table: these are
        // the commands as they were typed, credentials included, and masking
        // happens only when a bundle leaves the machine.
        jsx('p', { className: 'sshwsp-audit-foot', children: t('audit.footHint') }),
        // ---- everything that is not a command
        //
        // A file save, a delete, a dropped connection: none of these is a
        // command, so none of them can be a row in the table above — a save has
        // no command text and no exit code, and one row per autosave would push
        // the `rm` a user is looking for out of the 200-row ring. They ARE
        // recorded, in the diagnostics ring, and until now that ring shipped
        // with every `/status` reply and nothing ever drew it. This is that
        // surface: the same reply, the same three-part rhythm, no second route.
        (status.events ?? []).length > 0 && jsxs('div', { children: [
          jsx('div', { className: 'sshwsp-section-head', children: [
            jsx('h3', { children: t('audit.events') }),
          ]}),
          jsx('div', { className: 'sshwsp-event-list', children: (status.events ?? []).map((event, index) => jsxs('div', {
            key: `${event.at ?? index}-${index}`,
            className: 'sshwsp-event',
            children: [
              jsx('span', { className: 'sshwsp-event-kind', title: event.kind, children: t(`audit.kind.${event.kind}`, { defaultValue: event.kind ?? '' }) }),
              jsx('span', { className: 'sshwsp-event-text', title: event.message, children: event.message }),
              jsx('span', { className: 'sshwsp-event-when', children: formatAuditTime(event.at) }),
            ],
          })) }),
          jsx('p', { className: 'sshwsp-event-foot', children: t('audit.eventsNote') }),
        ]}),
      ]

      // Three tabs, not five: forwarding, the file-reference settings and the
      // diagnostic report are all "the rest of the panel" — they answer
      // questions about THIS workspace set rather than being places a user
      // visits on their own. Keeping them as separate tabs made the row wide
      // and each tab nearly empty.
      const panes = {
        hosts: paneHosts,
        workspaces: paneWorkspaces,
        audit: paneAudit,
        settings: paneSettings,
      }
      const visiblePane = panes[panelTab] ?? paneHosts

      return jsxs('div', { className: 'sshwsp', children: [
        jsxs('div', { className: 'sshwsp-panel-inner', children: [
          jsxs('div', { className: 'sshwsp-panel-head', children: [
            jsx('h2', { children: t('panel.title') }),
            jsx('button', { className: 'sshwsp-btn', onClick: refresh, disabled: loading, children: t('refresh') }),
          ]}),
          // The one place the panel admits an age. It says nothing about the
          // connection list (read live) and everything about the probe rows
          // (a cache that can be older than the user's last change to the host),
          // because that section is the one a user reads as "current".
          provenanceText(t, status.provenance?.capabilities) !== undefined && jsx('div', {
            className: 'sshwsp-provenance',
            children: `${t('provenance.selfCheck')} · ${provenanceText(t, status.provenance?.capabilities)}`,
          }),
          // Underline tabs, not a segmented control: the panel is a page of
          // sections rather than a filter bar, and the underline keeps the tab
          // row from competing with the section headings below it.
          jsx('div', {
            className: 'sshwsp-tabs',
            role: 'tablist',
            'aria-label': t('panel.tabsLabel'),
            onKeyDown: handleTabKeys,
            // `PANEL_TABS` is a list of IDS, not of records: dereferencing
            // `.id` off a string yields undefined, which renders five empty
            // buttons that all select the same pane. The parameter is the id.
            children: PANEL_TABS.map(id => jsx('button', {
              key: id,
              type: 'button',
              role: 'tab',
              id: panelTabIdOf(id),
              className: 'sshwsp-tab',
              'aria-selected': id === panelTab ? 'true' : 'false',
              'aria-controls': PANEL_TABPANEL_ID,
              tabIndex: id === panelTab ? 0 : -1,
              onClick: () => selectPanelTab(id),
              children: t(PANEL_TAB_KEYS[id]),
            })),
          }),
          // `jsxs`, not `jsx`: the pane is an ARRAY of static elements, and the
          // static-children entry point is what keeps React from asking each of
          // them for a key it does not need.
          jsxs('div', {
            className: 'sshwsp-tabpane',
            role: 'tabpanel',
            id: PANEL_TABPANEL_ID,
            'aria-labelledby': panelTabIdOf(panelTab),
            children: visiblePane,
          }),
        ]}),
        // ---- Diagnostic report dialog
        reportText !== null && jsx(DialogSlot, {
          component: ReportDialog,
          text: reportText,
          onClose: () => setReportText(null),
          onCopy: copyOpenReport,
          t,
        }),

        // ---- Browser dialog
        browserAlias !== null && jsx(DialogSlot, {
          component: DirectoryBrowser,
          alias: browserAlias,
          onClose: () => setBrowserAlias(null),
          onMount: () => { refresh(); setBrowserAlias(null) },
          ctx,
          t,
        }),

        // ---- Host editor dialog
        editorHost !== undefined && jsx(DialogSlot, {
          component: HostEditor,
          host: editorHost,
          t,
          onClose: () => setEditorHost(undefined),
          onSaved: () => { setEditorHost(undefined); refresh() },
        }),

        // ---- Host power-off confirmation
        powerHost !== undefined && jsx(DialogSlot, {
          component: HostPowerDialog,
          host: powerHost,
          busy: powerBusyAlias === powerHost.alias,
          error: powerError,
          onConfirm: confirmHostPowerOff,
          onCancel: () => { if (powerBusyAlias === null) { setPowerHost(undefined); setPowerError(undefined) } },
          t,
        }),

      ]})

    }

    // =========================================================================
    // Host card
    // =========================================================================
    // Moved here from the main bundle: the panel is its only reader, so it was
    // 178 lines of the boot parse that nothing on the boot path touched.
    function HostCard ({ host, t, conn, onTest, onBrowse, onEdit, onDelete, onForgetKey, onDisconnect, onReconnect, onSetIntent, onTogglePower, powerBusy, testState, deleteError, deleting }) {
      // null | 'delete' | 'forget' — only one confirmation row shows at a time.
      const [confirming, setConfirming] = React.useState(null)
      const [disconnecting, setDisconnecting] = React.useState(false)
      const [retrying, setRetrying] = React.useState(false)
      // Only this box's own write in flight; it never touches the connection, so
      // a busy socket must not freeze it.
      const [intentBusy, setIntentBusy] = React.useState(false)
      const testing = testState?.status === 'testing'
      const busy = (conn?.inFlight ?? 0) > 0
      const live = conn?.state === 'connected'
      // The box marks the persisted INTENT and nothing else: it is on while the
      // host is set to connect at the next start, whatever the socket is doing.
      // A live host the user never ticked therefore reads as off, and toggling
      // the box neither dials nor disconnects — those are the buttons' jobs.
      const on = conn?.autoConnect === true
      // Only store entries are editable; ~/.ssh/config rows stay read-only —
      // and so does a store record whose alias ALSO has a Host block in that
      // file (`configAlias`): deleting it would only uncover the block, and
      // editing it would shadow what every other ssh client resolves.
      const editable = host.source === 'store' && host.configAlias !== true

      const actions = confirming === 'delete'
        ? [
            jsx('button', {
              key: 'confirm',
              className: 'sshwsp-btn sshwsp-btn-danger',
              disabled: deleting,
              onClick: () => onDelete(host.alias),
              children: deleting ? t('hosts.deleting') : t('hosts.deleteConfirm'),
            }),
            jsx('button', {
              key: 'cancel',
              className: 'sshwsp-btn',
              disabled: deleting,
              onClick: () => setConfirming(null),
              children: t('hosts.deleteCancel'),
            }),
          ]
        : confirming === 'forget'
          ? [
              jsx('button', {
                key: 'confirm',
                className: 'sshwsp-btn',
                onClick: () => { setConfirming(null); onForgetKey(host.alias) },
                children: t('hosts.forgetKeyConfirm'),
              }),
              jsx('button', {
                key: 'cancel',
                className: 'sshwsp-btn',
                onClick: () => setConfirming(null),
                children: t('hosts.deleteCancel'),
              }),
            ]
          : [
            jsx('button', {
              key: 'test',
              className: 'sshwsp-btn sshwsp-btn-primary',
              disabled: testing,
              onClick: () => onTest(host.alias),
              children: testing ? t('hosts.testing') : t('hosts.test'),
            }),
            // Only a LIVE connection has something to close. The intent box is
            // not a switch for the socket, so it cannot stand in for this button:
            // a host that is merely marked shows no 「断开」, and clearing the
            // mark is done by unticking it.
            live && jsx('button', {
              key: 'disconnect',
              className: 'sshwsp-btn',
              disabled: busy || disconnecting,
              title: busy ? t('hosts.disconnectBusy') : undefined,
              onClick: async () => {
                setDisconnecting(true)
                try { await onDisconnect(host.alias) } finally { setDisconnecting(false) }
              },
              children: disconnecting ? t('hosts.disconnecting') : t('hosts.disconnect'),
            }),
            // Offered while a background retry is running or has stopped: the
            // loop may be waiting out a 60s backoff, and a user who just fixed
            // the network should not have to wait for it.
            (conn?.retry !== undefined) && jsx('button', {
              key: 'retry',
              className: 'sshwsp-btn',
              disabled: retrying,
              onClick: async () => {
                setRetrying(true)
                try { await onReconnect(host.alias) } finally { setRetrying(false) }
              },
              children: retrying ? t('connections.retrying') : t('connections.retry'),
            }),
            jsx('button', {
              key: 'browse',
              className: 'sshwsp-btn sshwsp-btn-primary',
              onClick: () => onBrowse(host.alias),
              children: t('hosts.browse'),
            }),
            editable && jsx('button', {
              key: 'edit',
              className: 'sshwsp-btn',
              onClick: () => onEdit(host),
              children: t('hosts.edit'),
            }),
            editable && jsx('button', {
              key: 'delete',
              className: 'sshwsp-btn sshwsp-btn-danger',
              onClick: () => setConfirming('delete'),
              children: t('hosts.delete'),
            }),
            // Offered for every host: keys are recorded per alias for store
            // and ~/.ssh/config hosts alike.
            jsx('button', {
              key: 'forget',
              className: 'sshwsp-btn',
              onClick: () => setConfirming('forget'),
              children: t('hosts.forgetKey'),
            }),
          ]

      // A native checkbox, not a button: "connect on startup" is a persisted
      // setting, so it reads and behaves like the other checkboxes in the panel
      // (forward auto-start, passthrough fallback). Its checked state is the
      // STORED INTENT — not the live socket — and toggling it only writes that
      // intent: ticking does not dial, and unticking does not drop the connection
      // the user is working in. Reusing the exempt `.sshwsp-check` label keeps
      // hover/ring on the native box, and CSS draws it as a switch.
      //
      // It sits OUTSIDE the action row on purpose: the actions do something now,
      // this one records what the next start will do, and a row of confirm
      // buttons must not be able to push it around (or hide it while a delete is
      // being confirmed).
      const autoConnectBadge = jsxs('label', {
        key: 'autoConnect',
        className: 'sshwsp-check sshwsp-host-autoconnect',
        title: t(on ? 'hosts.autoConnectOn' : 'hosts.autoConnectOff'),
        children: [
          jsx('input', {
            type: 'checkbox',
            checked: on,
            disabled: intentBusy,
            onChange: async (event) => {
              const next = event.target.checked
              setIntentBusy(true)
              try { await onSetIntent(host.alias, next) } finally { setIntentBusy(false) }
            },
          }),
          jsx('span', { className: 'sshwsp-check-text', children: t('hosts.autoConnect') }),
        ],
      })

      // What the card can honestly say about this host. A background retry is
      // neither "connected" nor "just disconnected": it has an attempt number
      // and a next-attempt time, and the countdown must come from the server's
      // clock, not the browser's, or the two drift apart across a sleep.
      const now = Date.now()
      const retry = conn?.retry
      const retrySeconds = retry !== undefined && retry.nextAt > 0 && retry.phase === 'waiting'
        ? Math.max(0, Math.round((retry.nextAt - now) / 1000))
        : undefined
      // "connecting" is a boot-dial (or a queued acquire) with no socket yet.
      // The switch already reflects the stored intent, so this is the only
      // honest status line during the handshake — "not connected" reads as
      // "never tried", the exact wrong message. A fatal failure arms no retry
      // row, so `conn.failure` is the only way to say "connection failed".
      const starting = conn?.connecting === true && !live && retry === undefined
      const failed = !live && !starting && (typeof conn?.failure === 'string' && conn.failure !== '')
      const stateLabel = starting
        ? t('connections.connecting')
        : failed
          ? t('connections.failed')
          : retry === undefined
            ? (conn === undefined ? undefined : t(`connections.${conn.state}`))
            : retry.phase === 'gave-up'
              ? t('connections.gaveUp')
              : retry.phase === 'connecting'
                ? t('connections.reconnectingNow', { n: retry.attempts })
                : t('connections.reconnecting', { n: retry.attempts, s: retrySeconds ?? 0 })
      const dotClass = starting
        ? 'sshwsp-dot sshwsp-dot-warn'
        : failed
          ? 'sshwsp-dot sshwsp-dot-err'
          : retry !== undefined
            ? 'sshwsp-dot sshwsp-dot-warn'
            : conn === undefined
              ? ''
              : `sshwsp-dot ${live ? 'sshwsp-dot-ok' : 'sshwsp-dot-err'}`

      const powered = host.enabled !== false
      return jsxs('div', {
        className: powered ? 'sshwsp-card sshwsp-host' : 'sshwsp-card sshwsp-host sshwsp-host-off',
        children: [
        // The power control is the card's statement about the host as a whole,
        // so it leads the card. Every card has one — the switch is a runtime
        // gate, not a property of the file: a store host keeps the flag in its
        // own entry, and a ~/.ssh/config host is remembered in the store's
        // `disabledAliases` list. The title says so, because "switch off" is
        // exactly the moment a user wonders whether their ssh config was edited.
        // It keeps its switch semantics — role and aria-checked are what a screen
        // reader announces — and only the drawing changed to the 28px square. The
        // two paths are the same geometry the sidebar's power marker is masked
        // from (client.styles.js, `[data-row-key^="workspace:"]`); a CSS mask
        // cannot import a component, so the note is what keeps the two in step.
        jsx('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': powered,
          'aria-label': t('hosts.power', { alias: host.alias }),
          'data-sshwsp-power-source': host.source,
          title: host.source === 'store'
            ? t(powered ? 'hosts.powerOn' : 'hosts.powerOff')
            : t(powered ? 'hosts.powerOnConfig' : 'hosts.powerOffConfig'),
          className: powered ? 'sshwsp-powerbtn sshwsp-powerbtn-on' : 'sshwsp-powerbtn',
          disabled: powerBusy === true,
          onClick: () => onTogglePower(host),
          children: jsxs('svg', {
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            'aria-hidden': 'true',
            children: [
              jsx('path', { d: 'M8 2.4v5.4' }),
              jsx('path', { d: 'M12.4 4.7a5.8 5.8 0 1 1-8.8 0' }),
            ],
          }),
        }),
        jsxs('div', { className: 'sshwsp-host-info', children: [
          jsxs('div', { className: 'sshwsp-host-alias', children: [
            jsx('span', { children: host.alias }),
            (conn !== undefined || retry !== undefined) && jsxs('span', { className: 'sshwsp-conn', children: [
              jsx('span', { className: dotClass }),
              // The state word carries its own colour class rather than an inline
              // --dsw-* lookup: those literals were the last place the client half
              // read a Host token directly, which the presentation contract keeps
              // out of everything but the stylesheet's token block.
              jsx('span', {
                className: starting
                  ? 'sshwsp-conn-state sshwsp-conn-state-idle'
                  : retry !== undefined || !live
                    ? 'sshwsp-conn-state sshwsp-conn-state-bad'
                    : 'sshwsp-conn-state sshwsp-conn-state-good',
                children: stateLabel,
              }),
              conn?.inFlight > 0 && jsx('span', { className: 'sshwsp-conn-busy', children: t('connections.inFlight', { n: conn.inFlight }) }),
            ]}),
          ]}),
          retry !== undefined && retry.lastError !== '' && jsx('div', { className: 'sshwsp-error', children: retry.lastError }),
          // A fatal connect failure arms no retry row, so its reason would be
          // invisible without this line. A switched-off host with a stale
          // failure does not show it (the switch is the statement that nobody
          // is trying to connect); those records stay in the engine only.
          failed && typeof conn.failure === 'string' && conn.failure !== '' && jsx('div', { className: 'sshwsp-error', children: conn.failure }),
          jsx('div', { className: 'sshwsp-host-addr', children: `${host.user}@${host.host}:${host.port}` }),
          host.description && jsx('div', { className: 'sshwsp-host-desc', children: host.description }),
          // Why this card has no 编辑/删除 even though it IS a store record: the
          // same alias also has a Host block, so the plugin owns half a host and
          // changing it here would silently shadow the file for every other ssh
          // client. Said in words rather than left to an absent button.
          host.configAlias === true && jsx('div', { className: 'sshwsp-host-desc', children: t('hosts.configShadow') }),
          // Tags are what the search box already matches on (the hosts route filters
          // alias, host, user, description AND tags), so showing them is what
          // makes a tag-driven search result explicable: without this, typing
          // "prod" narrows the list to hosts whose cards never mention "prod".
          Array.isArray(host.tags) && host.tags.length > 0 && jsx('div', {
            className: 'sshwsp-host-tags',
            children: host.tags.map(tag => jsx('span', { key: tag, className: 'sshwsp-host-tag', children: tag })),
          }),
          // The list is ordered recent-first, so a card that never says WHY it
          // sits at the top makes the order look arbitrary, and a card with no
          // marker makes "the one I used ten minutes ago" indistinguishable
          // from one that has never been connected to.
          typeof host.lastUsedAt === 'number' && jsx('div', {
            className: 'sshwsp-host-lastused',
            children: `${t('hosts.lastUsed')} · ${relativeTimeText(t, host.lastUsedAt)}`,
          }),
          // Readiness leads: a key that is not there yet is the one line on this
          // card that can stop a connection from working, so it sits before the
          // description of how the host authenticates and where it came from —
          // the two facts that are merely context.
          jsxs('div', { className: 'sshwsp-host-meta', children: [
            jsx('span', {
              className: host.keyReady ? 'sshwsp-status sshwsp-status-ok' : 'sshwsp-status sshwsp-status-warn',
              children: host.keyReady ? t('hosts.keyReady') : t('hosts.keyMissing'),
            }),
            jsx('span', { children: '·' }),
            jsx('span', { children: t(`hosts.auth.${host.auth}`) }),
            jsx('span', { children: '·' }),
            jsx('span', { children: t(`hosts.source.${host.source === 'store' ? 'store' : 'sshConfig'}`) }),
          ]}),
          deleteError && jsx('div', { className: 'sshwsp-error', children: deleteError }),
        ]}),
        autoConnectBadge,
        jsx('div', { className: 'sshwsp-host-actions', children: actions }),
        confirming !== null && jsx('div', { className: 'sshwsp-host-confirm', children:
          jsx('span', { children: confirming === 'delete' ? t('hosts.deleteDesc') : t('hosts.forgetKeyDesc') }),
        }),
      ]})
    }

    exports.RemoteWorkspacePanel = RemoteWorkspacePanel
    return module.exports
  },
})
