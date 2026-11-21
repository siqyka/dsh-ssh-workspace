window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.icons.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // =========================================================================
    // SVG Icons
    // =========================================================================
    // Every glyph is a pure React function, so this chunk is safe to await in
    // `apply`: nothing here reads the DOM or a service.
    // Two 45° chevrons facing each other — the remote-workspace mark. Geometry
    // traced 1:1 from the reference bitmap (29×28): right chevron apex
    // (16.5, 11.5) with arms to (20, 8)/(20, 15); left chevron apex
    // (16.5, 15.5) with arms to (12.5, 11.5)/(12.5, 19.5). The viewBox crops
    // to the drawn chevrons (plus a hair of padding) — the full 29×28 canvas
    // would render the mark tiny and thin at 16px.
    const REMOTE_MARK_VIEWBOX = '10.5 6.25 11.5 15'

    function RemoteMarkIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: REMOTE_MARK_VIEWBOX, width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M20 8 L16.5 11.5 L20 15' }),
        React.createElement('path', { d: 'M12.5 11.5 L16.5 15.5 L12.5 19.5' }),
      )
    }

    function ServerIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('rect', { x: 2, y: 2.5, width: 12, height: 4.5, rx: 1 }),
        React.createElement('rect', { x: 2, y: 9, width: 12, height: 4.5, rx: 1 }),
        React.createElement('circle', { cx: 4.5, cy: 4.75, r: 0.5, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: 4.5, cy: 11.25, r: 0.5, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function FolderIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M2 4.5v7a1.5 1.5 0 001.5 1.5h9a1.5 1.5 0 001.5-1.5v-5.5A1.5 1.5 0 0012.5 4.5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z' }),
      )
    }

    function GlobeIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('circle', { cx: 8, cy: 8, r: 6 }),
        React.createElement('ellipse', { cx: 8, cy: 8, rx: 2.6, ry: 6 }),
        React.createElement('path', { d: 'M2 8h12' }),
      )
    }

    function ArrowLeftIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M12.5 8H3.5' }),
        React.createElement('path', { d: 'M7 4.5L3.5 8L7 11.5' }),
      )
    }

    function CloseIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M4 4l8 8' }),
        React.createElement('path', { d: 'M12 4l-8 8' }),
      )
    }

    /**
     * Circular arrow: re-read something that is already on screen.
     *
     * Used by the commit-history strip's refresh control. Two strokes, not a
     * glyph: at 12px a text arrow cannot keep the circular feel that separates
     * "reload this list" from "open this link".
     */
    function RefreshIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M12.5 8a4.5 4.5 0 1 1-1.32-3.18' }),
        React.createElement('path', { d: 'M12.5 2.5v3h-3' }),
      )
    }

    /**
     * Disclosure chevron: down while a section is open, right while it is folded.
     *
     * The rotation lives in the stylesheet, not in a second path, so both states
     * share one outline and the change reads as the same control moving rather
     * than as two unrelated affordances.
     */
    function ChevronIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      },
        React.createElement('path', { d: 'M4 6.5L8 10.5L12 6.5' }),
      )
    }

    /**
     * Shared geometry for the tray-and-arrow mark, in the 16-unit box.
     *
     * One tray, two arrows: the page's React icons and the row menu's DOM-built
     * svg draw the same mark, so a re-tune of these numbers moves both. The tray
     * is a U — two rails and a rounded base — rather than a rule, because at
     * 16px a lone rule under an arrow reads as "save to disk" only on a second
     * glance.
     */
    const TRAY_BASE_PATH = 'M3.2 8.9v2.5a1.2 1.2 0 001.2 1.2h7.2a1.2 1.2 0 001.2-1.2v-2.5'
    const TRAY_ARROW_PATHS = {
      download: ['M8 2.6v6.7', 'M5.4 6.6L8 9.3l2.6-2.7', TRAY_BASE_PATH],
      upload: ['M8 11.2v-5.4', 'M5.4 8.4L8 5.8l2.6 2.6', TRAY_BASE_PATH],
    }

    /**
     * Down arrow into a tray: the download mark.
     *
     * Drawn from the toolbar reference, not as the '↓' character: a font glyph
     * changes weight with every shell theme and cannot be outlined into the
     * same geometry as the progress ring. The character it replaces also said
     * "down", never the noun "download".
     */
    function DownloadIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      }, TRAY_ARROW_PATHS.download.map((d, index) => React.createElement('path', { key: index, d })))
    }

    /**
     * Up arrow out of a tray: the upload mark, the download mark mirrored.
     *
     * The queue prints both directions in one column, so the two glyphs are the
     * same drawing with the arrow flipped — anything less and that column reads
     * as two unrelated symbols at 16px.
     */
    function UploadIcon ({ size = 16, ...props }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props,
      }, TRAY_ARROW_PATHS.upload.map((d, index) => React.createElement('path', { key: index, d })))
    }

    /**
     * The transfer mark inside a progress ring.
     *
     * Percent is the arc's length; an unknown total (`percent` null) turns a
     * fixed 30% arc instead. The two readings are deliberately different: a
     * filled arc states how far the transfer got, while a parked 0% arc would
     * claim a stall that an archive download is not in. A known total is
     * clamped just under 100, because a full ring's round caps would meet and
     * leave a visible seam.
     *
     * The ring wraps the mark instead of replacing it, which is what lets one
     * control carry both the verb and the distance. `direction` keeps that
     * verb honest: the header entry speaks for a queue that may be moving
     * either way, while the listing and queue rows are downloads and take the
     * default. The circle radius (7.2 of 16) leaves the tray clear of the
     * stroke at every size.
     */
    function TransferProgressIcon ({ size = 16, direction = 'download', percent = null, live = false, ...props }) {
      const known = typeof percent === 'number' && Number.isFinite(percent)
        ? Math.min(99.5, Math.max(0, percent))
        : null
      const paths = TRAY_ARROW_PATHS[direction] ?? TRAY_ARROW_PATHS.download
      const classes = 'sshwsp-dlring sshwsp-dlring-active' + (live ? ' sshwsp-dlring-live' : '')
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', ...props, className: classes,
      },
        React.createElement('circle', { key: 'track', className: 'sshwsp-dlring-track', cx: 8, cy: 8, r: 7.2, strokeWidth: 1.3 }),
        React.createElement('circle', {
          key: 'arc', className: 'sshwsp-dlring-arc', cx: 8, cy: 8, r: 7.2, strokeWidth: 1.3,
          pathLength: 100,
          strokeDasharray: known === null ? (live ? '30 100' : '0 100') : `${known} 100`,
        }),
        React.createElement('g', { key: 'mark', transform: 'translate(2.6 2.6) scale(0.675)', strokeWidth: 1.9 },
          paths.map((d, index) => React.createElement('path', { key: index, d }))),
      )
    }
    exports.REMOTE_MARK_VIEWBOX = REMOTE_MARK_VIEWBOX
    exports.RemoteMarkIcon = RemoteMarkIcon
    exports.ServerIcon = ServerIcon
    exports.FolderIcon = FolderIcon
    exports.GlobeIcon = GlobeIcon
    exports.ArrowLeftIcon = ArrowLeftIcon
    exports.CloseIcon = CloseIcon
    exports.RefreshIcon = RefreshIcon
    exports.ChevronIcon = ChevronIcon
    exports.TRAY_BASE_PATH = TRAY_BASE_PATH
    exports.TRAY_ARROW_PATHS = TRAY_ARROW_PATHS
    exports.DownloadIcon = DownloadIcon
    exports.UploadIcon = UploadIcon
    exports.TransferProgressIcon = TransferProgressIcon
    return module.exports
  },
})
