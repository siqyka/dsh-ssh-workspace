window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.transfer-queue.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')

    // The QUEUE itself stays in the main bundle: the Files-panel action bar reads
    // it too, and a store that lived in a chunk would not exist before the chunk
    // arrived. Only the popover that PAINTS it lives here.
    const {
      CloseIcon,
      DownloadIcon,
      PauseIcon,
      PlayIcon,
      RefreshIcon,
      TransferProgressIcon,
      UploadIcon,
      backdropDismiss,
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
      useDialogA11y,
      useTransferQueue,
    } = require('@shiqyka/dsh-ssh-workspace')


    // =========================================================================
    // Transfer queue panel (the popover that paints the queue)
    // =========================================================================
    // ---- progress UI

    function queueItemMetaText (item, percent, t) {
      if (item.status === 'queued') {
        return item.bytesTotal === null ? t('queue.queued') : `${t('queue.queued')} · ${formatBytes(item.bytesTotal)}`
      }
      if (item.status === 'running') {
        if (item.cancelRequested === true) return t('queue.cancelling')
        // The rate is measured by the reducer and claimed only after two
        // samples cover real time; bytes and percentage are still shown when
        // it is unknown, because bytes ALREADY moved.
        const speed = typeof item.speed === 'number' && Number.isFinite(item.speed) && item.speed > 0
          ? t('queue.perSecond', { size: formatBytes(item.speed) })
          : null
        const bytes = formatBytes(item.bytesDone)
        if (percent === null) return speed === null ? bytes : `${speed} · ${bytes}`
        return speed === null ? `${percent}% · ${bytes}` : `${percent}% · ${speed} · ${bytes}`
      }
      if (item.status === 'pausing') return t('queue.pausing')
      if (item.status === 'paused') return item.bytesTotal === null ? t('queue.paused') : `${t('queue.paused')} · ${formatBytes(item.bytesDone)}`
      if (item.status === 'done') return `${t('queue.done')} · ${formatBytes(item.bytesDone)}`
      if (item.status === 'failed') return t('queue.failed')
      return t('queue.cancelled')
    }

    /** One queue row: direction, name, progress or bytes, cancel. */
    function TransferQueueRow ({ item, t }) {
      const percent = queueItemPercent(item)
      const meta = queueItemMetaText(item, percent, t)
      const active = !transferQueueIsTerminal(item.status)
      const paused = item.status === 'paused'
      const pausing = item.status === 'pausing'
      // The bar is decoration of the row's own text, never its only carrier
      // (`aria-hidden`): a known total fills to its percentage, a finished row
      // is full, and an archive with no total sweeps instead of asserting 0%
      // or 100% for a stream that is actually moving.
      const live = item.status === 'running' && percent === null
      const fillPercent = item.status === 'done' ? 100 : (percent ?? 0)
      return jsxs('div', { className: `sshwsp-queuerow sshwsp-queuerow-${item.status}`, children: [
        // Running transfers turn blue; a download also wears its own ring so
        // the queue row and the listing row that started it show one number. A
        // finished or failed row keeps the plain mark: blue there would read
        // as "still going".
        jsx('span', {
          className: 'sshwsp-queueicon' + (item.status === 'running' ? ' sshwsp-queueicon-active' : ''),
          'aria-hidden': 'true',
          children: item.direction === 'upload'
            ? React.createElement(UploadIcon)
            : item.status === 'running'
              ? React.createElement(TransferProgressIcon, { size: 16, percent, live: percent === null })
              : React.createElement(DownloadIcon),
        }),
        jsxs('div', { className: 'sshwsp-queuebody', children: [
          jsxs('div', { className: 'sshwsp-queue-line', children: [
            jsx('span', { className: 'sshwsp-queuename', title: item.name, children: truncateTransferName(item.name, 38) }),
            jsx('span', { className: 'sshwsp-queuemeta', children: meta }),
          ]}),
          jsx('div', {
            className: `sshwsp-queuebar${live ? ' sshwsp-queuebar-live' : ''}`,
            'aria-hidden': 'true',
            children: jsx('div', {
              className: 'sshwsp-queuebar-fill',
              style: live ? undefined : { width: `${fillPercent}%` },
            }),
          }),
          item.status === 'failed' && typeof item.error === 'string' && item.error !== '' && jsx('div', {
            className: 'sshwsp-queueerror',
            title: item.error,
            children: item.error,
          }),
          // A retry's verdict (and the restart reason) lives in the row's own
          // note; the toast that opens the batch is gone by then.
          item.status === 'done' && typeof item.note === 'string' && item.note !== '' && jsx('div', {
            className: 'sshwsp-queuenote',
            title: item.note,
            children: item.note,
          }),
          // A failed row's recovery is a WORD, not a sideways arrow in the
          // gutter: retrying is the only thing that row is for, and its reason
          // is already on screen, so the button sits under the sentence it
          // answers instead of pretending to be one more icon next to cancel.
          item.status === 'failed' && jsxs('div', { className: 'sshwsp-queue-actions', children: [
            jsx('button', {
              type: 'button',
              className: 'sshwsp-btn',
              onClick: () => retryTransferQueueItem(item.id),
              children: t('queue.retryItem'),
            }),
          ]}),
        ]}),
        (item.status === 'running' || item.status === 'queued' || pausing) && jsx('button', {
          type: 'button',
          className: 'sshwsp-icon-btn',
          title: t('queue.pauseItem'),
          'aria-label': t('queue.pauseItem'),
          disabled: pausing,
          onClick: () => pauseTransferQueueItem(item.id),
          children: React.createElement(PauseIcon),
        }),
        paused && jsx('button', {
          type: 'button',
          className: 'sshwsp-icon-btn',
          title: t('queue.resumeItem'),
          'aria-label': t('queue.resumeItem'),
          onClick: () => resumeTransferQueueItem(item.id),
          children: React.createElement(PlayIcon),
        }),
        active && jsx('button', {
          type: 'button',
          className: 'sshwsp-icon-btn',
          title: t('queue.cancelItem'),
          'aria-label': t('queue.cancelItem'),
          onClick: () => cancelTransferQueueItem(item.id),
          children: React.createElement(CloseIcon),
        }),
      ]})
    }

    /** The list + footer shared by the popover and the dialog's inline seat. */
    function transferQueueBody (queue, t) {
      const terminal = queue.items.filter(item => transferQueueIsTerminal(item.status)).length
      return jsxs(Fragment, { children: [
        jsx('div', { className: 'sshwsp-queue-list', children: queue.items.length === 0
          ? jsx('div', { className: 'sshwsp-empty', children: t('queue.empty') })
          // Live first, then the most recent result: see
          // `orderedTransferQueueItems` for why the store's arrival order is
          // the wrong thing to paint.
          : orderedTransferQueueItems(queue.items).map(item => jsx(TransferQueueRow, { key: item.id, item, t })) }),
        jsxs('div', { className: 'sshwsp-queue-foot', children: [
          jsx('span', { className: 'sshwsp-entry-meta', children: t('queue.refreshNote') }),
          jsx('button', {
            type: 'button',
            className: 'sshwsp-btn',
            disabled: terminal === 0,
            onClick: () => clearFinishedTransfers(),
            children: t('queue.clear'),
          }),
        ]}),
      ]})
    }

    /**
     * The popover anchored to the Files panel's queue button.
     *
     * Rendered only while open, so `useDialogA11y` moves focus IN on open
     * rather than on the button's mount (a hook that runs once cannot move
     * focus into a panel that does not exist yet).
     */
    function TransferQueuePanel ({ anchor, onClose, t }) {
      const queue = useTransferQueue()
      const dialog = useDialogA11y({ onClose, label: t('queue.title') })
      return jsxs('div', { className: 'sshwsp-popbackdrop', ...backdropDismiss(onClose), children: [
        jsxs('div', {
          className: 'sshwsp-queuepanel',
          ...dialog.props,
          ref: dialog.bodyRef,
          tabIndex: -1,
          style: { top: `${anchor.top}px`, right: `${anchor.right}px` },
          onClick: (event) => event.stopPropagation(),
          children: [
            jsxs('div', { className: 'sshwsp-queue-head', children: [
              jsx('span', { className: 'sshwsp-queue-title', id: dialog.titleId, children: t('queue.title') }),
              jsx('button', {
                type: 'button',
                className: 'sshwsp-icon-btn',
                title: t('dialog.close'),
                'aria-label': t('dialog.close'),
                onClick: onClose,
                children: '×',
              }),
            ]}),
            transferQueueBody(queue, t),
          ],
        }),
      ]})
    }
    exports.TransferQueuePanel = TransferQueuePanel
    return module.exports
  },
})
