/**
 * The one selection model, shared by the directory dialog and the Files tree.
 *
 * Pure and DOM-free on purpose: the gesture rules are the interesting part, and
 * they are exactly what a component tends to re-invent (usually as "click a row"
 * plus three modifiers, which then disagrees between the two surfaces). The
 * reducer takes the visible rows and one action and answers a complete next
 * state plus, when a plain click landed on a directory, the row the CALLER
 * should navigate to.
 *
 * It is a module rather than a section of the bundle because it borrows nothing:
 * no DOM, no clock, no `fetch`, no `translate`. `tests/selection-smoke` used to
 * splice this region out of the bundle by two marker comments and run it, which
 * is why the rules could be asserted at all; that splice now reads this file.
 *
 * The tree wiring that USES these rules — the WeakMaps keyed by container, the
 * captured-click suppression, the keyboard handler — stays in the bundle. This
 * file decides what a gesture means; that one decides when a gesture happened.
 */

window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.selection.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

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

    // The pure surface. `SELECTION_EMPTY` is the identity every caller starts
    // from, so it is exported rather than copied.
    Object.assign(exports, {
      SELECTION_EMPTY,
      selectReduce,
      selectionRange,
    })
    return module.exports
  },
})
