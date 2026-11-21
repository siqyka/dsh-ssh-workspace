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
      relativeTimeText,
      provenanceText,
      DialogSlot,
      DirectoryBrowser,
      HostEditor,
      ReportDialog,
      notifyUser,
      toastError,
      useTransferActionsSlot,
      syncRemoteWorkspaceMarks,
      capabilityNotes,
    } = require('@shiqyka/dsh-ssh-workspace')

    // =========================================================================
    // Main panel
    // =========================================================================
    /** The local URL a forward is reachable at. */
    function forwardUrlOf (forward) {
      const host = forward.localHost === '0.0.0.0' || forward.localHost === '::' ? 'localhost' : forward.localHost
      return `http://${host}:${forward.localPort}`
    }

    /** How many rows a section shows before it starts scrolling. */
    const LIST_CAP = 5


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
    function CappedList ({ className, children }) {
      const ref = React.useRef(null)
      const [capHeight, setCapHeight] = React.useState(null)
      const rows = React.Children.toArray(children)

      useLayoutEffect(() => {
        const el = ref.current
        if (el === null || typeof ResizeObserver === 'undefined') return undefined
        const measure = () => {
          const items = Array.from(el.children)
          if (items.length <= LIST_CAP) {
            setCapHeight(null)
            return
          }
          const style = window.getComputedStyle(el)
          const gap = Number.parseFloat(style.rowGap || style.gap || '0') || 0
          let height = gap * (LIST_CAP - 1)
          for (const item of items.slice(0, LIST_CAP)) height += item.getBoundingClientRect().height
          // +1 rounds the fractional pixels up rather than down: a sub-pixel
          // short cap would clip the fifth row and show a scrollbar early.
          setCapHeight(Math.ceil(height) + 1)
        }
        measure()
        const observer = new ResizeObserver(measure)
        for (const item of Array.from(el.children)) observer.observe(item)
        return () => observer.disconnect()
      }, [rows.length])

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
     * @param {Array<{tool: string, state: string}>} rows - the probed rows.
     * @param {string[]} [missing] - the server's own absent list, used when rows are absent.
     * @returns {{absent: string[], unknown: string[], present: number, total: number, absentCount: number}} the summary.
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
      // What the listing could NOT show, kept apart from "nothing configured".
      //
      // The route has always returned `skipped` and `storeError`, and the tools
      // and the report render them; the panel did not, so an unreadable store
      // and an empty one produced the same sentence ("no SSH hosts configured")
      // — the one message a user cannot act on. Empty state is the absence of
      // both facts, not the absence of rows.
      const [listingGaps, setListingGaps] = React.useState({ skipped: [], storeError: undefined })
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
      // Which workspace row has an armed unmount confirmation, and the mode it
      // would run with. Arming is separate state so the first click is
      // reversible and cannot unload a workspace by accident.
      const [unmountConfirm, setUnmountConfirm] = React.useState(null)
      const [unmountMode, setUnmountMode] = React.useState('detach')
      const [unmountBusy, setUnmountBusy] = React.useState(null)
      const [enableBusy, setEnableBusy] = React.useState(null)
      // The scheme box is a draft, not a mirror of `status.passthrough.scheme`:
      // the panel refreshes on a timer, and a refresh landing mid-typing would
      // otherwise overwrite the half-typed name with the stored one. `null`
      // means "untouched, show the stored value"; the input clears it on every
      // keystroke and the save handler re-seeds it from the server's answer.
      const [passthroughScheme, setPassthroughScheme] = React.useState(null)
      const [passthroughBusy, setPassthroughBusy] = React.useState(false)
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
          setStatus(statusData)
          syncRemoteWorkspaceMarks(statusData.workspaces, statusData.disabled)
        } catch { /* silent */ }
        finally { setLoading(false) }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

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
       * Unload one workspace.
       *
       * Two steps on purpose. The first click only arms the row, because this
       * touches every session the workspace accounts for; the second click is
       * what actually runs it. The confirm text states what survives —
       * "archived" is not "deleted", and that distinction is the whole reason
       * this is reversible.
       *
       * Whether sessions are archived is decided by the mode, not sent as a
       * separate constant: keeping the workspace record (the default) means
       * the sidebar group and its sessions must stay, so archiving them would
       * empty the group the user chose to keep.
       */
      const handleUnmount = async (workspacePath, mode) => {
        setUnmountBusy(workspacePath)
        try {
          const effectiveMode = mode ?? 'detach'
          const result = await fetchJson(API.unmount, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspacePath, mode: effectiveMode }),
          })
          if (!result.ok) {
            // No retry: unmount can partially succeed (the workspace may be
            // detached while session archiving failed), so replaying it is not
            // a safe repeat of one action.
            reportToast(toastError(t('mounted.detachFail'), result.error, 'SSHWSP-E-UNMOUNT'))
          } else if ((result.archiveFailed ?? []).length > 0) {
            reportToast(toastError(t('mounted.detachPartial'), result.archiveFailed, 'SSHWSP-E-UNMOUNT-ARCHIVE'))
          } else if (effectiveMode === 'detach') {
            // No sessions were archived on purpose: the group stays populated.
            reportToast({ kind: 'ok', text: t('mounted.detachOkKeep') })
          } else {
            reportToast({ kind: 'ok', text: t('mounted.detachOk').replace('{n}', String((result.archived ?? []).length)) })
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
      for (const retry of status.reconnecting ?? []) {
        connMap.set(retry.alias, { ...(connMap.get(retry.alias) ?? { alias: retry.alias, state: 'broken', inFlight: 0 }), retry })
      }

      // While a retry is pending the countdown must move. The panel otherwise
      // only refreshes on user action, so "in 12s" would sit there frozen.
      // Skipped while the tab is hidden: a background tab polling a host that is
      // failing to connect is pure noise, and the first visible tick catches up.
      const retrying = (status.reconnecting ?? []).length > 0
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

      return jsxs('div', { className: 'sshwsp', children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }, children: [
          jsx('h2', { style: { margin: 0 }, children: t('panel.title') }),
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

        // ---- Port forwards
        jsx('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('forwards.title') }),
        ]}),
        jsxs('div', { className: 'sshwsp-forward-new', children: [
          jsx('select', {
            className: 'sshwsp-input sshwsp-select',
            value: forwardAlias,
            disabled: forwardBusy || hosts.length === 0,
            onChange: (event) => setForwardAlias(event.target.value),
            children: [
              jsx('option', { value: '', children: t('remote.host') }),
              ...hosts.map((host) => jsx('option', { key: host.alias, value: host.alias, children: host.alias })),
            ],
          }),
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
        jsx('label', {
          className: 'sshwsp-check sshwsp-forward-autostart',
          // The explanation is a hover tooltip rather than a permanent line:
          // it only matters the first time, and leaving it inline pushed the
          // saved-mapping list down on every render.
          title: t('forwards.autoStartHint'),
          // Checkbox first, label second: the box sits to the LEFT of the title.
          children: [
            jsx('input', {
              type: 'checkbox',
              checked: status.forwardSettings?.autoStart === true,
              onChange: (event) => handleAutoStart(event.target.checked),
            }),
            jsxs('span', { className: 'sshwsp-check-text', children: [
              jsx('span', { className: 'sshwsp-field-label', children: t('forwards.autoStart') }),
            ]}),
          ],
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

        // ---- File references (host paths inside an ssh:// session)
        // TWO titles, and they are not interchangeable. The `h3` names the zone
        // ("File reference settings") exactly like the other panel sections; the
        // `h4` names what the controls in it do ("Explicit file reference
        // scheme"). Collapsing them into one line lost the distinction between
        // "where these controls live" and "what this particular control is",
        // and the scheme box's own accessible name is a third string again —
        // renaming a title must never rename the field.
        //
        // Both controls write straight through to the live matcher, so there is
        // no Apply button: the scheme box saves on Enter or on Save, and the
        // checkbox saves on click. The zone renders even when passthrough is
        // off (empty localPassthrough) because the settings still persist for
        // when it is switched on — the notice says they have no effect now.
        jsx('div', { className: 'sshwsp-section-head', children: [
          jsx('h3', { children: t('passthrough.group') }),
        ]}),
        jsx('h4', { children: t('passthrough.title') }),
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
            title: t('passthrough.schemeHint'),
            disabled: passthroughBusy,
            onChange: (event) => setPassthroughScheme(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') savePassthroughScheme() },
          }),
          jsx('button', {
            className: 'sshwsp-btn',
            disabled: passthroughBusy,
            title: t('passthrough.schemeHint'),
            onClick: () => savePassthroughScheme(),
            children: t('passthrough.schemeSave'),
          }),
        ]}),
        jsx('label', {
          className: 'sshwsp-check sshwsp-passthrough-fallback',
          // The rule is long enough that leaving it inline would push the whole
          // panel down; the tooltip carries it and the state stays one line.
          title: t('passthrough.fallbackHint'),
          children: [
            jsx('input', {
              type: 'checkbox',
              checked: status.passthrough?.remoteMissFallback === true,
              disabled: passthroughBusy,
              onChange: (event) => savePassthroughFallback(event.target.checked),
            }),
            jsxs('span', { className: 'sshwsp-check-text', children: [
              jsx('span', { className: 'sshwsp-field-label', children: t('passthrough.fallback') }),
            ]}),
          ],
        }),

        // ---- Mounted workspaces
        jsx('h3', { children: t('mounted.title') }),
        (status.mounted ?? []).length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('mounted.none') })
          : jsx(CappedList, { className: 'sshwsp-mounts', children: (status.mounted ?? []).map((wsPath) => {
              const armed = unmountConfirm === wsPath
              const busy = unmountBusy === wsPath
              return jsxs('div', { key: wsPath, className: 'sshwsp-mount', children: [
                React.createElement(RemoteMarkIcon, { size: 16, className: 'sshwsp-entry-icon' }),
                jsx('span', { className: 'sshwsp-mount-path', children: wsPath }),
                armed
                  ? jsxs(Fragment, { children: [
                      jsx('label', {
                        className: 'sshwsp-check',
                        children: [
                          jsx('input', {
                            type: 'checkbox',
                            checked: unmountMode === 'deregister',
                            onChange: (event) => setUnmountMode(event.target.checked ? 'deregister' : 'detach'),
                          }),
                          jsx('span', { children: t('mounted.removeRecord') }),
                        ],
                      }),
                      jsx('button', {
                        className: 'sshwsp-btn sshwsp-btn-danger',
                        disabled: busy,
                        // Same tooltip as the unarmed button: this IS that button
                        // once armed, and the armed state is the moment the
                        // consequence matters most — dropping the hint here would
                        // hide it exactly when the click becomes irreversible.
                        title: t('mounted.detachHint'),
                        onClick: () => handleUnmount(wsPath, unmountMode),
                        children: busy ? t('mounted.unmounting') : t('mounted.confirmDetach'),
                      }),
                      jsx('button', {
                        className: 'sshwsp-btn',
                        disabled: busy,
                        onClick: () => { setUnmountConfirm(null); setUnmountMode('detach') },
                        children: t('editor.cancel'),
                      }),
                    ]})
                  : jsx('button', {
                      className: 'sshwsp-btn sshwsp-btn-danger',
                      disabled: busy,
                      title: t('mounted.detachHint'),
                      onClick: () => { setUnmountConfirm(wsPath); setUnmountMode('detach') },
                      children: t('mounted.unmount'),
                    }),
              ]})
            })}),

        // ---- Detached workspaces
        // Always rendered: an empty section is how the user learns that
        // "unmount" leaves something behind to re-enable, and where it went.
        jsx('h3', { children: t('detached.title') }),
        (status.disabled ?? []).length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('detached.none') })
          : jsxs(Fragment, { children: [
              jsx('div', { className: 'sshwsp-entry-meta', children: t('detached.hint') }),
              jsx(CappedList, { className: 'sshwsp-mounts', children: (status.disabled ?? []).map((wsPath) => {
                const busy = enableBusy === wsPath
                return jsxs('div', { key: wsPath, className: 'sshwsp-mount sshwsp-mount-off', children: [
                  jsx('span', { className: 'sshwsp-mount-path', children: wsPath }),
                  jsx('span', { className: 'sshwsp-entry-meta', children: t('detached.badge') }),
                  jsx('button', {
                    className: 'sshwsp-btn',
                    disabled: busy,
                    onClick: () => handleEnable(wsPath),
                    children: busy ? t('detached.enabling') : t('detached.enable'),
                  }),
                ]})
              })}),
            ]}),

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

        // ---- Recent remote commands
        // Only failures, refusals and unknown outcomes are listed: a successful
        // command is not news, and a list of every `ls` would bury the one line
        // that matters. The full record is in the diagnostic report.
        (status.commands ?? []).filter(command => command.refused === true || command.outcomeUnknown === true || command.timedOut || (command.exitCode ?? 0) !== 0).length > 0 && jsxs('div', { children: [
          jsx('h3', { children: t('audit.title') }),
          jsx(CappedList, {
            className: 'sshwsp-audit',
            children: (status.commands ?? [])
              .filter(command => command.refused === true || command.outcomeUnknown === true || command.timedOut || (command.exitCode ?? 0) !== 0)
              .slice(-10)
              .map((command) => jsxs('div', {
                key: command.seq,
                className: 'sshwsp-audit-row',
                children: [
                  jsx('span', { className: 'sshwsp-entry-meta', children: command.alias }),
                  jsx('span', {
                    className: `sshwsp-status ${command.refused === true ? 'sshwsp-status-warn' : 'sshwsp-status-err'}`,
                    children: command.refused === true
                      ? t('audit.refused')
                      : command.outcomeUnknown === true
                        ? t('audit.unknown')
                        : command.timedOut
                          ? t('audit.timedOut')
                          : `exit ${command.exitCode}`,
                  }),
                  jsx('span', { className: 'sshwsp-audit-command', children: command.command }),
                ],
              })),
          }),
        ]}),

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
        (diagnosis.findings ?? []).length > 0 && jsxs('div', { className: 'sshwsp-diagnosis', children: [
          ...(diagnosis.findings ?? []).slice(0, 8).map(finding => jsxs('div', {
            key: `${finding.id}:${finding.alias ?? ''}:${finding.detail}`,
            className: 'sshwsp-diagnosis-row',
            children: [
              jsx('span', {
                className: `sshwsp-status ${finding.state === 'warn' ? 'sshwsp-status-err' : 'sshwsp-status-warn'}`,
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

      ]})
    }

    // =========================================================================
    // Host card
    // =========================================================================
    // Moved here from the main bundle: the panel is its only reader, so it was
    // 178 lines of the boot parse that nothing on the boot path touched.
    function HostCard ({ host, t, conn, onTest, onBrowse, onEdit, onDelete, onForgetKey, onDisconnect, onReconnect, testState, deleteError, deleting }) {
      // null | 'delete' | 'forget' — only one confirmation row shows at a time.
      const [confirming, setConfirming] = React.useState(null)
      const [disconnecting, setDisconnecting] = React.useState(false)
      const [retrying, setRetrying] = React.useState(false)
      const testing = testState?.status === 'testing'
      const busy = (conn?.inFlight ?? 0) > 0
      // Only store entries are editable; ~/.ssh/config rows stay read-only.
      const editable = host.source === 'store'

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
            // Only a LIVE connection can be closed. A `broken` record (and the
            // retry row built from one) is not connected — the badge beside it
            // already reads "已断开" — so offering "断开" claimed a state the
            // host was not in. Reconnecting rows get "立即重连" instead.
            (conn?.state === 'connected') && jsx('button', {
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

      // What the card can honestly say about this host. A background retry is
      // neither "connected" nor "just disconnected": it has an attempt number
      // and a next-attempt time, and the countdown must come from the server's
      // clock, not the browser's, or the two drift apart across a sleep.
      const now = Date.now()
      const retry = conn?.retry
      const retrySeconds = retry !== undefined && retry.nextAt > 0 && retry.phase === 'waiting'
        ? Math.max(0, Math.round((retry.nextAt - now) / 1000))
        : undefined
      const stateLabel = retry === undefined
        ? (conn === undefined ? undefined : t(`connections.${conn.state}`))
        : retry.phase === 'gave-up'
          ? t('connections.gaveUp')
          : retry.phase === 'connecting'
            ? t('connections.reconnectingNow', { n: retry.attempts })
            : t('connections.reconnecting', { n: retry.attempts, s: retrySeconds ?? 0 })
      const dotClass = retry !== undefined
        ? 'sshwsp-dot sshwsp-dot-warn'
        : conn === undefined
          ? ''
          : `sshwsp-dot ${conn.state === 'connected' ? 'sshwsp-dot-ok' : 'sshwsp-dot-err'}`

      return jsxs('div', { className: 'sshwsp-card sshwsp-host', children: [
        jsxs('div', { className: 'sshwsp-host-info', children: [
          jsxs('div', { className: 'sshwsp-host-alias', children: [
            jsx('span', { children: host.alias }),
            (conn !== undefined || retry !== undefined) && jsxs('span', { className: 'sshwsp-conn', children: [
              jsx('span', { className: dotClass }),
              jsx('span', {
                style: { color: retry !== undefined || conn.state !== 'connected' ? 'var(--dsw-alias-state-error-primary, #ff6b6b)' : 'var(--dsw-alias-state-success-primary, #4ade80)' },
                children: stateLabel,
              }),
              conn?.inFlight > 0 && jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary, #666)' }, children: t('connections.inFlight', { n: conn.inFlight }) }),
            ]}),
          ]}),
          retry !== undefined && retry.lastError !== '' && jsx('div', { className: 'sshwsp-error', children: retry.lastError }),
          jsx('div', { className: 'sshwsp-host-addr', children: `${host.user}@${host.host}:${host.port}` }),
          host.description && jsx('div', { className: 'sshwsp-host-desc', children: host.description }),
          // Tags are what the search box already matches on (routes.js filters
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
          jsxs('div', { className: 'sshwsp-host-meta', children: [
            jsx('span', { children: t(`hosts.auth.${host.auth}`) }),
            jsx('span', { children: '·' }),
            jsx('span', {
              className: host.keyReady ? 'sshwsp-status sshwsp-status-ok' : 'sshwsp-status sshwsp-status-warn',
              children: host.keyReady ? t('hosts.keyReady') : t('hosts.keyMissing'),
            }),
            jsx('span', { children: '·' }),
            jsx('span', { children: t(`hosts.source.${host.source === 'store' ? 'store' : 'sshConfig'}`) }),
          ]}),
          deleteError && jsx('div', { className: 'sshwsp-error', children: deleteError }),
        ]}),
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
