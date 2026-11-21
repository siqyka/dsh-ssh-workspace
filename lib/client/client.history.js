window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.history.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')

    // The strip reads this plugin's own Host route and remembers one fold
    // preference, so it needs very little from the bundle: the route table, the
    // one fetch wrapper, two glyphs, and its own two constants (which live here
    // because nothing else reads them).
    const {
      API,
      ChevronIcon,
      RefreshIcon,
      fetchJson,
    } = require('@shiqyka/dsh-ssh-workspace')

    /** Rows the strip asks for and shows. */
    const HISTORY_ROW_LIMIT = 20

    /**
     * Where the strip's fold state is remembered.
     *
     * The key names this plugin and this one control, so two plugins sharing the
     * page cannot collide, and a future control adds its own key instead of
     * growing one blob. Only `'1'` means folded: anything else (missing, `'0'`,
     * hand-edited junk) reads as open, which is the safe direction — a strip
     * that unexpectedly hides the commits looks broken.
     */
    const HISTORY_FOLD_KEY = 'dsh-ssh-workspace.commit-history.folded'

    // =========================================================================
    // Change-request history strip (the appendix under the official panel)
    // =========================================================================

    /** One phase's state; a refresh starts from a clean, explicit phase. */
    function emptyHistoryState (phase) {
      return { phase, commits: [], truncated: false, notRepository: false, message: '' }
    }

    /**
     * Whether the user left the strip folded, from the page's own storage.
     *
     * Storage is a browser facility this module does not own, so every failure
     * is "no preference": a sandboxed frame with no `localStorage`, a browser
     * in private mode that throws on access, a value written by an older build.
     * Returning `false` means the strip opens, and an opening strip can always
     * be folded again — losing the preference is cheap, crashing the tab is not.
     *
     * @returns {boolean} true when the strip was left folded.
     */
    function readHistoryFold () {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false
        return localStorage.getItem(HISTORY_FOLD_KEY) === '1'
      } catch {
        return false
      }
    }

    /**
     * Remember the strip's fold state for the next load.
     *
     * Never throws: a full quota or a blocked origin must not turn a click on a
     * heading into a broken tab. The in-memory state is already updated by the
     * caller, so the current page keeps working either way.
     *
     * @param {boolean} folded - the state the user just chose.
     */
    function writeHistoryFold (folded) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return
        localStorage.setItem(HISTORY_FOLD_KEY, folded === true ? '1' : '0')
      } catch {
        /* the preference is lost, the click still works */
      }
    }

    /**
     * What the strip shows for one disclosure state.
     *
     * Pure, so the folded state is decided in exactly one place and can be
     * exercised without a browser. Folded means the title row and nothing else:
     * no truncation note, no refresh control and no list — "click the title and
     * the whole thing folds down to just the title".
     *
     * @param {boolean} collapsed - whether the user folded the strip.
     * @param {boolean} truncated - whether more commits exist than are listed.
     * @returns {{note: boolean, refresh: boolean, body: boolean}} what to render.
     */
    function historyChrome (collapsed, truncated) {
      const open = collapsed !== true
      return {
        note: open && truncated === true,
        refresh: open,
        body: open,
      }
    }

    /**
     * The added strip: the Session directory's most recent commits, newest
     * first, one row each (short hash, subject, date · author).
     *
     * This is a read of the plugin's own Host route; a failure is one grey line
     * with the reason in its tooltip — never red, never a toast — because the
     * change-request panel above is the tab's purpose and a healthy tab must not
     * look broken because its appendix could not load.
     *
     * @param {object} props - `{sessionId, t}`.
     */
    function CommitHistorySection ({ sessionId, t }) {
      const [state, setState] = React.useState(() => emptyHistoryState('loading'))
      const [requestToken, setRequestToken] = React.useState(0)
      // Disclosure is a reading preference, so it outlives the tab: it is read
      // once on mount (lazily, never during module load — the storage owner is
      // the page, not this bundle) and written back on every toggle. A strip
      // left folded stays folded across reloads and sessions; the value is a
      // single flag, not a settings entry, so there is nothing to sync with the
      // Host and nothing to migrate.
      const [collapsed, setCollapsed] = React.useState(readHistoryFold)
      const reload = React.useCallback(() => setRequestToken((value) => value + 1), [])
      const fold = React.useCallback(() => setCollapsed((value) => {
        const next = value !== true
        writeHistoryFold(next)
        return next
      }), [])

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setState(emptyHistoryState('failed'))
          return undefined
        }
        const controller = new AbortController()
        setState(emptyHistoryState('loading'))
        const url = `${API.gitHistory}?session=${encodeURIComponent(sessionId)}&limit=${HISTORY_ROW_LIMIT}`
        fetchJson(url, { signal: controller.signal }).then(
          (reply) => {
            if (controller.signal.aborted) return
            const commits = Array.isArray(reply?.commits) ? reply.commits : []
            setState({
              phase: commits.length > 0 ? 'ready' : 'empty',
              commits,
              truncated: reply?.truncated === true,
              notRepository: reply?.notRepository === true,
              message: '',
            })
          },
          (error) => {
            if (controller.signal.aborted) return
            setState({
              ...emptyHistoryState('failed'),
              message: error instanceof Error ? error.message : String(error),
            })
          },
        )
        return () => controller.abort()
      }, [sessionId, requestToken])

      let body
      if (state.phase === 'loading') {
        body = jsx('p', { className: 'sshwsp-cr-history-state', children: t('history.loading') })
      } else if (state.phase === 'failed') {
        body = jsx('p', {
          className: 'sshwsp-cr-history-state',
          title: state.message === '' ? undefined : state.message,
          children: t('history.failed'),
        })
      } else if (state.phase === 'empty') {
        body = jsx('p', {
          className: 'sshwsp-cr-history-state',
          children: state.notRepository ? t('history.notRepository') : t('history.empty'),
        })
      } else {
        body = jsx('ul', {
          className: 'sshwsp-cr-history-list',
          children: state.commits.map((commit) => jsxs('li', {
            className: 'sshwsp-cr-commit',
            title: [commit.date, commit.author, commit.subject]
              .filter((part) => typeof part === 'string' && part !== '')
              .join(' · '),
            children: [
              jsx('span', { className: 'sshwsp-cr-commit-sha', children: commit.shortSha }),
              jsx('span', {
                className: 'sshwsp-cr-commit-subject',
                children: typeof commit.subject === 'string' && commit.subject !== '' ? commit.subject : '—',
              }),
              jsx('span', {
                className: 'sshwsp-cr-commit-meta',
                children: typeof commit.author === 'string' && commit.author !== ''
                  ? `${commit.date} · ${commit.author}`
                  : String(commit.date ?? ''),
              }),
            ],
          }, typeof commit.sha === 'string' ? commit.sha : String(commit.shortSha))),
        })
      }

      const chrome = historyChrome(collapsed, state.truncated)
      return jsxs('section', { className: 'sshwsp-cr-history', 'aria-label': t('history.title'), children: [
        jsxs('div', { className: 'sshwsp-cr-history-head', children: [
          // The heading carries one button, so the disclosure is a real control:
          // Enter and Space come from the platform and `aria-expanded` tells a
          // screen reader which state the strip is in.
          jsx('h3', { className: 'sshwsp-cr-history-title', children: jsxs('button', {
            type: 'button',
            className: 'sshwsp-cr-history-toggle',
            'aria-expanded': collapsed !== true,
            title: collapsed ? t('history.expand') : t('history.collapse'),
            onClick: fold,
            children: [
              jsx(ChevronIcon, { size: 12, className: 'sshwsp-cr-history-chevron' }),
              jsx('span', { className: 'sshwsp-cr-history-toggletext', children: t('history.title') }),
            ],
          }) }),
          chrome.note
            ? jsx('span', { className: 'sshwsp-cr-history-note', children: t('history.truncated', { count: state.commits.length }) })
            : null,
          chrome.refresh
            ? jsx('button', {
              type: 'button',
              className: 'sshwsp-cr-history-refresh',
              title: t('history.refresh'),
              'aria-label': t('history.refresh'),
              disabled: state.phase === 'loading',
              onClick: reload,
              children: jsx(RefreshIcon, { size: 12 }),
            })
            : null,
        ]}),
        chrome.body ? body : null,
      ]})
    }

    exports.CommitHistorySection = CommitHistorySection
    return module.exports
  },
})
