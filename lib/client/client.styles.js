window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.styles.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // =========================================================================
    // Stylesheet (injected once per materialization)
    // =========================================================================
    // The page must have these rules before the panel draws, so `apply` awaits
    // this chunk instead of deferring it to a gesture. Moving the text out of
    // the main bundle keeps 529 lines of CSS out of the parse every page load
    // pays for; the round trip is paid once, before anything renders.
    const CSS_ID = '@shiqyka/dsh-ssh-workspace/client.css'
    function injectStyles () {
      if (typeof document === 'undefined') return
      // An existing tag is REWRITTEN, not skipped. The client bundle is
      // re-executed whenever the host rebuilds it — client-HMR swaps the module
      // without a page reload — so this guard used to return on every execution
      // after the first: the JS ran with the new code while the page kept the
      // PREVIOUS stylesheet. A CSS-only change then looked applied and did
      // nothing until a full reload. Adopting the tag keeps injection single
      // (no duplicate <style>) while making the sheet in the page always the
      // one in the bundle.
      const existing = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
      const tag = existing ?? document.createElement('style')
      tag.dataset.plugin = '@shiqyka/dsh-ssh-workspace'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = `
.sshwsp { font-family: var(--dsw-font-family, system-ui, sans-serif); color: var(--dsw-alias-label-primary, #e0e0e0); padding: 24px; overflow-y: auto; height: 100%; }
.sshwsp h2 { font-size: 18px; font-weight: 600; margin: 0 0 16px; letter-spacing: -0.01em; }
.sshwsp h3 { font-size: 12px; font-weight: 500; margin: 24px 0 12px; color: var(--dsw-alias-label-secondary, #999); letter-spacing: 0.02em; }
/* A subheading under a section head: same size as the h3 so the zone still
   reads as one block, but lighter and dimmer so it is visibly one level down.
   The top margin stays 0 on purpose — it inherits the section head's bottom
   margin through margin collapsing, and a second 12px would open a gap that
   separates a title from the controls it names. */
.sshwsp h4 { font-size: 12px; font-weight: 400; margin: 0 0 10px; color: var(--dsw-alias-label-tertiary, #666); letter-spacing: 0.02em; }
.sshwsp-card { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
.sshwsp-host { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sshwsp-host-info { flex: 1; min-width: 0; }
.sshwsp-host-alias { font-weight: 500; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.sshwsp-host-addr { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); font-family: var(--dsw-font-markdown-code-font-family, monospace); }
.sshwsp-host-meta { display: flex; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); margin-top: 2px; }
.sshwsp-host-desc { font-size: 12px; color: var(--dsw-alias-label-secondary, #999); margin-top: 2px; overflow-wrap: anywhere; }
.sshwsp-host-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sshwsp-host-lastused { font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); margin-top: 4px; }
.sshwsp-provenance { font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); margin-bottom: 8px; }
.sshwsp-host-tag {
  font-size: 11px;
  line-height: 1.4;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #999);
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.16));
  overflow-wrap: anywhere;
}
.sshwsp-host-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.sshwsp-host-confirm { flex-basis: 100%; display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); padding-top: 8px; }
.sshwsp-host-confirm span { flex: 1; font-size: 12px; color: var(--dsw-alias-label-tertiary, #666); }
.sshwsp-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 24px 0 12px; }
.sshwsp-section-head h3 { margin: 0; }
/* The report title carries the verdict dot. inline-flex so the dot sits on
   the text's optical centre rather than its baseline, and the gap keeps it
   from touching the last glyph. */
.sshwsp-report-title { display: inline-flex; align-items: center; gap: 7px; }
.sshwsp-diagnosis { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px; }
.sshwsp-diagnosis-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 1.5; }
.sshwsp-diagnosis-detail { color: var(--dsw-alias-label-secondary, #a0a0a0); }
/* Advisory rows: collapsed by default and quieter than the findings, because
   they are context, not a verdict. They still have to be READABLE when opened —
   a self-check the user cannot read is the same as no self-check. */
.sshwsp-diagnosis-notes { margin: 0 0 12px; font-size: 12px; line-height: 1.5; }
.sshwsp-diagnosis-notes > summary { cursor: pointer; color: var(--dsw-alias-label-tertiary, #888); }
.sshwsp-diagnosis-notes > .sshwsp-diagnosis-row { padding-left: 12px; }
.sshwsp-btn { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)); color: var(--dsw-alias-label-primary, #e0e0e0); border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; transition: background 120ms ease-out, transform 100ms ease-out; white-space: nowrap; }
.sshwsp-btn:hover { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.16)); }
.sshwsp-btn:active:not(:disabled) { transform: scale(0.98); }
.sshwsp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sshwsp-btn-primary { background: var(--dsw-alias-button-info-fill, #4a9eff); color: #fff; border-color: transparent; }
.sshwsp-btn-primary:hover { background: var(--dsw-alias-button-info-hover, #3d8ee6); }
.sshwsp-btn-danger { color: var(--dsw-alias-state-error-primary, #ff6b6b); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 35%, transparent); }
.sshwsp-btn-danger:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 12%, transparent); }
.sshwsp-btn:focus-visible, .sshwsp-icon-btn:focus-visible, .sshwsp-menuitem:focus-visible, .sshwsp-entry:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: 1px; }
.sshwsp-status { font-size: 11px; padding: 2px 6px; border-radius: 4px; }
.sshwsp-status-ok { color: var(--dsw-alias-state-success-primary, #4ade80); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #4ade80) 15%, transparent); }
.sshwsp-status-err { color: var(--dsw-alias-state-error-primary, #ff6b6b); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 15%, transparent); }
.sshwsp-status-warn { color: var(--dsw-alias-state-warn-primary, #fbbf24); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fbbf24) 15%, transparent); }
/* Neutral chip for "undetermined": it is not a warning (nothing is known to be
   wrong) and it is not success (nothing is known to be right). Grey is the only
   colour that says neither. */
.sshwsp-status-off { color: var(--dsw-alias-label-tertiary, #666); background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #666) 15%, transparent); }
.sshwsp-check-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.sshwsp-check-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12px; }
.sshwsp-check-tool { font-family: var(--dsw-font-markdown-code-font-family, monospace); font-weight: 600; }
/* A self-check card: the header is the disclosure control, so the card stacks
   instead of flowing the way .sshwsp-mount (a one-line mount row) does. */
.sshwsp-mount-col { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
.sshwsp-check-head { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; padding: 0; border: none; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sshwsp-check-head:disabled { cursor: default; }
.sshwsp-check-head:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: 2px; border-radius: 4px; }
.sshwsp-check-caret { flex: 0 0 auto; width: 10px; color: var(--dsw-alias-label-tertiary, #888); font-size: 10px; }
.sshwsp-check-spacer { flex: 1; }
.sshwsp-check-inline { font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; color: var(--dsw-alias-state-warning-primary, #f0a020); overflow-wrap: anywhere; }
.sshwsp-audit-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12px; padding: 2px 0; }
.sshwsp-audit-command { font-family: var(--dsw-font-markdown-code-font-family, monospace); overflow-wrap: anywhere; }
.sshwsp-toast { position: fixed; left: 50%; top: 40px; transform: translateX(-50%); z-index: 1100; box-sizing: border-box; max-width: min(480px, 90vw); padding: 9px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); background: var(--dsw-alias-bg-layer-3, #1a1a1a); box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); font-size: 12px; line-height: 1.5; cursor: pointer; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; animation: sshwsp-toast-in 160ms ease-out; }
.sshwsp-toast-ok { color: var(--dsw-alias-state-success-primary, #4ade80); }
.sshwsp-toast-err { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.sshwsp-toast-muted { color: var(--dsw-alias-text-secondary, #9aa0a6); }
/* The toast is a fixed frame with an action row and a collapsible detail
   block. Buttons live BELOW the message rather than replacing it, so the
   sentence that says what failed survives every action. */
.sshwsp-toast-line { display: block; }
.sshwsp-toast-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 7px; }
.sshwsp-toast-action { appearance: none; padding: 1px 0; border: 0; background: none; color: inherit; font: inherit; font-size: 11px; line-height: 1.4; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; opacity: 0.9; }
.sshwsp-toast-action:hover { opacity: 1; }
.sshwsp-toast-action:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 2px; }
.sshwsp-toast-action:disabled { cursor: progress; opacity: 0.55; }
.sshwsp-toast-action[hidden] { display: none; }
.sshwsp-toast-status { display: block; margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
.sshwsp-toast-status:empty { display: none; }
.sshwsp-toast-detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); color: var(--dsw-alias-label-secondary, #aaa); cursor: text; }
.sshwsp-toast-detail[hidden] { display: none; }
.sshwsp-toast-detail-code { display: block; margin-bottom: 4px; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 10px; letter-spacing: 0.02em; opacity: 0.85; }
.sshwsp-toast-detail pre { margin: 0; max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 11px; line-height: 1.45; color: var(--dsw-alias-text-secondary, #9aa0a6); user-select: text; cursor: text; }
@keyframes sshwsp-toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
/* 'clip' rather than 'hidden': both keep the rounded corners, but 'hidden'
   makes this element a scroll container, and a sticky child would then stick
   to IT (which never scrolls) instead of to the dialog body. */
/* The frame is a flex column so its header can stay put while its list takes
   the remaining height. overflow: clip keeps the rounded corners without
   making the frame a scroll container — hidden would, and a sticky child
   would then stick to a box that never scrolls. */
.sshwsp-browser { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 8px; overflow: clip; }
/* Not sticky any more: the header sits OUTSIDE the scrolling list now, so it
   never moves in the first place. Sticky is kept off deliberately — it was the
   workaround for a single-scroller layout that no longer exists. */
.sshwsp-browser-header { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 14px; background-color: var(--dsw-alias-bg-layer-3, #1a1a1a); background-image: linear-gradient(var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06)), var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))); border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)); }
.sshwsp-browser-hint { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); white-space: nowrap; }
.sshwsp-browser-path { flex: 1; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-path-input { background: transparent; border: 0; padding: 0; outline: none; color: var(--dsw-alias-label-primary, #ddd); cursor: text; }
/* The read-only span showed the tail of a long path with RTL; an editable
   field must keep logical order or "/root" renders as "root/". */
.sshwsp-pathbar-path.sshwsp-path-input { direction: ltr; text-align: left; }
.sshwsp-path-input:disabled { cursor: default; opacity: 0.7; }
/* The listing is the dialog's ONE scrollport.
   It used to carry a max-height of its own while .sshwsp-dialog-body scrolled
   too, so a long directory was clipped by the body at whatever point the list
   happened to overflow and the rows below that point could never be reached.
   The fix is not "let the body scroll everything": that moves the form and the
   path bar out of view while the user is picking a directory, and the whole
   dialog starts to look like a page. Instead the frame above the list
   (.sshwsp-browser-header, the form, the hint) stays put and only the rows
   move — the body becomes a flex column that never scrolls, and the list takes
   the remaining height. */
.sshwsp-browser-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.sshwsp-entry { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 8px 14px; border: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); background: none; color: inherit; font: inherit; text-align: left; cursor: default; transition: background 100ms ease-out; }
.sshwsp-entry-dir { cursor: pointer; user-select: none; }
.sshwsp-entry:focus-visible { outline: 1px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -1px; }
.sshwsp-entry-dir:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
/* Host file tree (DSH's own Files tab): selection is painted onto the host's
   rows through classes of our own. Nothing here targets a host class name, so a
   restyle upstream cannot silently drop the highlight — and a selected row is
   still the host's row, with the host's handlers, underneath. */
.sshwsp-tree-row-selected { background: color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 14%, transparent) !important; }
.sshwsp-tree-row-selected > button { background: transparent; }
.sshwsp-tree-row-cursor > button { outline: 1px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -1px; border-radius: 4px; }
/* The in-place rename editor. It is PORTALED to <body>, so it is positioned
   against the viewport from the row's name span; nothing here may assume it is
   a descendant of the row it edits. */
.sshwsp-inline-rename { position: fixed; z-index: 1400; box-sizing: border-box; padding: 0 4px; border: 1px solid var(--dsw-alias-button-info-fill, #4a9eff); border-radius: 4px; background: var(--dsw-alias-bg-layer-3, #1a1a1a); color: var(--dsw-alias-label-primary, #e0e0e0); font: inherit; font-size: 13px; outline: none; }
.sshwsp-inline-rename[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary, #ff6b6b); }

.sshwsp-entry:last-child { border-bottom: none; }
.sshwsp-entry-icon { width: 16px; height: 16px; color: var(--dsw-alias-label-secondary, #888); flex-shrink: 0; }
.sshwsp-entry-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-entry-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); font-family: var(--dsw-font-markdown-code-font-family, monospace); }
.sshwsp-mount { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 8px; padding: 10px 14px; margin-bottom: 6px; display: flex; align-items: center; gap: 12px; }
.sshwsp-mount-path { flex: 1; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A detached workspace row: dimmed but fully legible, and never given
   pointer-events:none — the whole point of the row is its Enable button. */
.sshwsp-mount-off { opacity: 0.62; }
.sshwsp-mount-off .sshwsp-mount-path { color: var(--dsw-alias-label-tertiary, #666); }
/* The "also remove the workspace record" opt-in inside an armed unmount row.
   It stays a checkbox rather than a second button because the two actions
   differ only in scope, and picking the wrong button here is unrecoverable
   for the row's visibility. */
.sshwsp-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #888); cursor: pointer; white-space: nowrap; }
.sshwsp-check input { margin: 0; cursor: pointer; }
/* Sidebar rows for detached workspaces. Set by passRemoteMarks; display-only,
   so a click still reaches DSH and the panel's Enable button stays the way
   back. Intercepting the host's own row click would break on its next
   redesign, which is a worse trade than a row that opens and shows an error. */
[data-sshwsp-disabled="1"] { opacity: 0.5; }
/* The power glyph marks the WORKSPACE header only. Applying it to every
   attribute carrier would stamp one on each session row too, which reads as
   "N separate switches" rather than "this workspace is off". */
[data-row-key^="workspace:"][data-sshwsp-disabled="1"]::after { content: "⏻"; margin-left: 6px; font-size: 10px; color: var(--dsw-alias-label-tertiary, #666); }
/* A detached workspace's row actions do nothing, so they are made inert rather
   than merely dimmed. pointer-events is used instead of a click interceptor:
   the buttons belong to DSH's own row, and patching its handlers breaks on the
   next redesign, while this rule survives any markup the row grows. The
   workspace HEADER stays clickable on purpose — expanding the group is how its
   sessions (kept per the detach contract) remain visible. */
[data-sshwsp-disabled="1"] button,
[data-sshwsp-disabled="1"] [role="button"] { pointer-events: none; opacity: 0.4; }
/* The sessions inside such a group are unreachable, row and all: the row
   itself IS the control that opens the session, so dimming only its buttons
   would leave the one action that matters. Keyed off the row key so this
   cannot reach the workspace header above, whose expand affordance is
   deliberately kept. The keyboard half is set by script; this is the mouse. */
[data-row-key^="session:"][data-sshwsp-disabled="1"] { pointer-events: none; cursor: not-allowed; }
/* Empty / loading / error placeholders. Every section renders one of these
   before it has rows, so this rule must exist even while the surrounding
   layout is being reworked: without it the placeholder collapses to an
   unstyled line and the panel looks half-loaded. */
.sshwsp-empty { text-align: center; padding: 32px 16px; color: var(--dsw-alias-label-tertiary, #666); font-size: 13px; }
/* The reason behind an empty section: smaller, left-aligned, and NOT centred —
   it is a diagnosis, not a placeholder, and centring it would read as decoration. */
.sshwsp-empty-detail { margin-top: 6px; font-size: 12px; line-height: 1.5; word-break: break-word; opacity: 0.85; }
/* Layout of the add-a-forward row: fixed footprint, not a stretched field.
   The host select is capped at 180px (half of the old 360px ceiling) and the
   two port boxes stay pinned to what a 7-digit port needs; leftover space on
   the right is simply empty. justify-content: flex-start keeps the row packed
   left instead of spreading the controls apart, and flex-wrap is the escape
   valve on a narrow panel — the row breaks rather than crushing the alias
   into an ellipsis.
   Scoping both rules under .sshwsp-forward-new is load-bearing, not cosmetic:
   .sshwsp-input sets width:100% with a single class, so a bare
   .sshwsp-input-port loses to it on source order however wide it declares
   itself. That is exactly what let every port box claim the full row and
   squeeze the select down to min-content.
   88px = 2px border + 16px padding + 70px of text: seven digits at 13px need
   ~51px, and the zh placeholder "默认同远端" (5 CJK glyphs, ~65px) fits. */
.sshwsp-forward-new { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-start; margin: 0 0 8px; }
.sshwsp-forward-new .sshwsp-select { flex: 0 1 180px; width: 180px; min-width: 90px; max-width: 180px; }
.sshwsp-forward-new .sshwsp-input-port { flex: 0 0 auto; width: 88px; padding-left: 8px; padding-right: 8px; font-variant-numeric: tabular-nums; appearance: textfield; -moz-appearance: textfield; }
.sshwsp-forward-new .sshwsp-btn { flex: 0 0 auto; }
/* The spinner steals ~15px of the box and pushes the placeholder into an
   ellipsis. A port is typed, not stepped (min/max/validation still apply):
   drop it. */
.sshwsp-forward-new .sshwsp-input-port::-webkit-outer-spin-button,
.sshwsp-forward-new .sshwsp-input-port::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.sshwsp-forward-row { flex-wrap: wrap; }
/* A saved mapping with no live listener is dimmed, but stays fully operable:
   the row must still be readable enough to decide whether to turn it on. */
.sshwsp-forward-off .sshwsp-mount-path { color: var(--dsw-alias-label-tertiary, #666); }
.sshwsp-forward-error { flex-basis: 100%; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The shared .sshwsp-check spreads label and box to opposite ends, which is
   right for a two-line row but wrong here: the box must sit beside the label
   it belongs to, not float away from it. Compounded so it outranks
   .sshwsp-check regardless of where this rule lands in the sheet.
   display/flex-direction are repeated here on purpose: .sshwsp-check declares
   neither, relying on the .sshwsp-field class for display:flex, and this label
   does not carry that class. Without them the row falls back to display:inline
   and the title drops onto its own line. */
.sshwsp-check.sshwsp-forward-autostart { display: flex; flex-direction: row; align-items: center; margin: 0 0 10px; padding: 8px 0 0; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); justify-content: flex-start; gap: 8px; }
.sshwsp-porthint { font-size: 11px; margin: -2px 0 8px; color: var(--dsw-alias-label-tertiary, #666); }
.sshwsp-porthint-busy { color: var(--dsw-alias-state-warn-primary, #fbbf24); }
.sshwsp-porthint-free { color: var(--dsw-alias-state-success-primary, #4ade80); }
/* Base size for a port box used outside the forward row (none today). Inside
   .sshwsp-forward-new the scoped rule above takes over, since a single class
   here would lose to .sshwsp-input's width:100%. */
.sshwsp-input-port { width: 88px; flex: none; }
/* The host-scheme box and its Save button. Same trap as the forward row: the
   bare .sshwsp-input declares width:100%, so the field is scoped here rather
   than styled by the shared class alone. The box is capped instead of
   stretched — a scheme name is short, and a full-width field would suggest it
   takes a path. */
.sshwsp-passthrough-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-start; margin: 0 0 8px; }
.sshwsp-passthrough-row .sshwsp-input { flex: 0 1 160px; width: 160px; min-width: 90px; max-width: 160px; }
.sshwsp-passthrough-row .sshwsp-btn { flex: 0 0 auto; }
/* Both settings are meaningless while localPassthrough is empty, and saying so
   is the only way a user learns why the controls do nothing. Left-aligned and
   small: this is a diagnosis, not a placeholder or a title. */
.sshwsp-passthrough-off { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary, #fbbf24); }
.sshwsp-passthrough-hint { margin: -2px 0 10px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #666); }
/* A section with more than five rows becomes a scrolling viewport rather than
   a page-long column. CappedList sets max-height inline from the measured
   height of the first five rows; these rules only supply the flex column and,
   once it actually overflows, the scrolling.
   The gutter is reserved ALWAYS while scrolling (scrollbar-gutter: stable),
   because a scrollbar that appeared only on the sixth row would narrow the
   panel and reflow every row in it — a jump on the exact interaction that
   caused it. It is NOT reserved for a short list: those must render exactly
   as they did before the cap existed, with no 10px slot for an absent bar.
   overscroll-behavior keeps a flick at the end of a list from scrolling the
   whole panel behind it. */
.sshwsp-cap { display: flex; flex-direction: column; gap: 6px; }
.sshwsp-cap-scroll { overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding-right: 2px; }
/* Hosts and forwards are cards/rows that already bring their own bottom
   margin. Inside a flex column those margins stack ON TOP of the gap (they do
   not collapse), so a capped list would be spaced twice as loose as the same
   list uncapped. The cap owns the spacing; the rows drop theirs. */
.sshwsp-cap > .sshwsp-card, .sshwsp-cap > .sshwsp-mount { margin-bottom: 0; }
.sshwsp-conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 400; font-variant-numeric: tabular-nums; }
.sshwsp-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.sshwsp-dot-ok { background: var(--dsw-alias-state-success-primary, #4ade80); }
.sshwsp-dot-err { background: var(--dsw-alias-state-error-primary, #ff6b6b); }
.sshwsp-dot-warn { background: var(--dsw-alias-state-warning-primary, #fbbf24); }
.sshwsp-error { color: var(--dsw-alias-state-error-primary, #ff6b6b); font-size: 12px; margin-top: 4px; }
.sshwsp-backdrop { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.5)); display: flex; align-items: center; justify-content: center; z-index: 1000; animation: sshwsp-fade-in 120ms ease-out; }
.sshwsp-dialog { background: var(--dsw-alias-bg-layer-3, #1a1a1a); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 12px; width: 640px; max-width: 90vw; max-height: 80vh; display: flex; flex-direction: column; box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); animation: sshwsp-dialog-in 140ms ease-out; }
.sshwsp-dialog-narrow { width: 480px; }
/* Dialogs whose body holds a scrolling list need a HEIGHT, not just a cap: with
   only max-height the box shrinks to its content and flex: 1 on the list has
   nothing to divide, so the list would never scroll and the whole dialog would
   grow past the viewport instead. */
/* The base dialog caps at 80vh; a fill dialog must raise that cap too, or the
   cap silently wins over the height and the list never gets the extra rows. */
.sshwsp-dialog-fill { height: min(88vh, 760px); max-height: 88vh; }
.sshwsp-dialog-title { padding: 16px 20px; font-size: 16px; font-weight: 600; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); }
/* The body is a flex COLUMN, not a scrollport: the dialog owns the height, the
   body hands the leftover space to whichever child is the scroller (the
   directory list), and everything else stays where it is. overflow: hidden
   keeps a stray wide child from painting outside the rounded frame without
   making the body a second scroll container. */
.sshwsp-dialog-body { padding: 0; overflow: hidden; flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* The report is monospaced text that keeps its own line breaks but WRAPS: a
   report is read line by line, and horizontal scrolling makes the reader drag
   sideways to finish a sentence. 'pre-wrap' preserves the report's own newlines
   and its leading indentation while letting long lines flow. */
.sshwsp-report-text { display: block; box-sizing: border-box; width: 100%; min-height: 360px; max-height: 60vh; margin: 0; padding: 14px 18px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06)); color: var(--dsw-alias-label-primary, #e0e0e0); border: 0; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; overflow-y: auto; overflow-x: hidden; resize: none; }
.sshwsp-report-text:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -2px; }
.sshwsp-dialog-footer { padding: 12px 20px; border-top: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); display: flex; justify-content: flex-end; gap: 8px; }
/* The dialog's fixed head. It never scrolls and never shrinks: the whole point
   of this layout is that the fields stay where they are while the listing
   moves, and a form with its own scrollbar is the same complaint one level
   down. On a short window it is the form's own PADDING that gives way (the
   media query below), never its content. */
.sshwsp-form { flex: 0 0 auto; box-sizing: border-box; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
/* A short window pays for the dialog's chrome (title bar, hint, footer) before
   the list gets anything. Tightening the form's spacing there buys the rows
   back without touching the layout on a normal screen. */
@media (max-height: 620px) {
  .sshwsp-form { padding: 10px 20px; gap: 7px; }
  .sshwsp-dirlist-hint { padding: 4px 20px 2px; }
  .sshwsp-dlg-head { padding: 10px 18px; }
  .sshwsp-dialog-footer { padding: 8px 20px; }
}
/* Below ~500px of height the chrome itself is what starves the list: at 380px
   the title bar, form, hint and footer leave the rows 23 pixels. Three things
   give way, in this order: the 88vh breathing room becomes 100vh minus a small
   margin, the hint row goes (the double-click gesture is stated once, in the
   browser dialog, and this one still behaves the same), and the inputs get
   tighter. The form's fields themselves are never hidden or scrolled. */
@media (max-height: 500px) {
  .sshwsp-dialog-fill { height: calc(100vh - 12px); max-height: calc(100vh - 12px); }
  .sshwsp-dirlist-hint { display: none; }
  .sshwsp-form { padding: 8px 20px; gap: 5px; }
  .sshwsp-field { gap: 2px; }
  .sshwsp-form .sshwsp-input { padding-top: 5px; padding-bottom: 5px; }
}
.sshwsp-form-row { display: flex; gap: 12px; }
.sshwsp-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.sshwsp-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #999); }
.sshwsp-field-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); }
.sshwsp-check { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; }
.sshwsp-check-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sshwsp-check input[type="checkbox"] { flex: 0 0 auto; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-button-info-fill, #4a9eff); cursor: pointer; }
.sshwsp-input { background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06)); border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)); border-radius: 6px; color: var(--dsw-alias-label-primary, #e0e0e0); padding: 6px 10px; font-size: 13px; font-family: inherit; width: 100%; box-sizing: border-box; }
.sshwsp-input:focus { outline: none; border-color: var(--dsw-alias-button-info-fill, #4a9eff); }
.sshwsp-input:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 30%, transparent); }
.sshwsp-select { cursor: pointer; color-scheme: dark; }
.sshwsp-dlg-head { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); }
.sshwsp-dlg-head h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
.sshwsp-icon-btn { background: none; border: 1px solid transparent; color: var(--dsw-alias-label-secondary, #999); border-radius: 6px; padding: 5px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 120ms ease-out, transform 100ms ease-out; }
.sshwsp-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-icon-btn:active:not(:disabled) { transform: scale(0.94); }
.sshwsp-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* A busy icon is not a dead icon: its ring must stay legible while the button
   refuses a duplicate download of the same path. */
.sshwsp-icon-btn-busy:disabled { opacity: 1; cursor: default; }
/* The row menu: one line per item, 220px wide. It used to carry a second
   description line per action (the full path, the overwrite policy), which made
   a five-item menu read like a settings page and pushed it past six items once
   rename/delete arrived. A row already names the file it belongs to, so the
   path was repeating the row, not explaining the action. The add-workspace
   chooser is the one menu that keeps descriptions — they are its reason to
   exist — under the roomy modifier below. */
.sshwsp-flowmenu { position: fixed; z-index: 1300; width: 220px; box-sizing: border-box; background: var(--dsw-alias-bg-layer-3, #1a1a1a); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 8px; box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); padding: 4px; animation: sshwsp-menu-in 120ms ease-out; }
.sshwsp-menuitem { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 28px; box-sizing: border-box; padding: 5px 8px; border: none; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sshwsp-menuitem:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -2px; }
.sshwsp-menuitem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
.sshwsp-menuitem:disabled { opacity: 0.5; cursor: not-allowed; }
.sshwsp-menuitem-icon { display: inline-flex; align-self: center; color: var(--dsw-alias-label-secondary, #999); flex-shrink: 0; }
.sshwsp-menuitem-text { flex: 1; min-width: 0; }
.sshwsp-menuitem-title { display: block; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-menuitem-desc { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary, #888); margin-top: 2px; line-height: 1.45; overflow-wrap: anywhere; }
/* The right-click row menu is a quick action list, so it runs tighter than the
   add-workspace chooser: a 12px label on a 24px row. Scoped with
   :not(.sshwsp-flowmenu-roomy) because the chooser's two-line rows need the
   shared 13px / 28px base; an unscoped override would shrink both. */
.sshwsp-flowmenu:not(.sshwsp-flowmenu-roomy) .sshwsp-menuitem { min-height: 24px; gap: 6px; padding: 3px 6px; }
.sshwsp-flowmenu:not(.sshwsp-flowmenu-roomy) .sshwsp-menuitem-title { font-size: 12px; }
/* Roomier variant: the add-workspace chooser. Descriptions are its whole
   point, so it keeps the old two-line geometry and a slightly wider sheet. */
.sshwsp-flowmenu-roomy { width: 250px; padding: 5px; }
.sshwsp-flowmenu-roomy .sshwsp-menuitem { align-items: flex-start; gap: 10px; padding: 9px 10px; border-radius: 7px; }
.sshwsp-menusep { height: 1px; margin: 5px 8px; background: var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); }
.sshwsp-fileaction { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 12px; line-height: 1; white-space: nowrap; cursor: pointer; }
.sshwsp-fileaction:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-fileaction:disabled { opacity: 0.5; cursor: not-allowed; }
/* The transfer-queue entry: one glyph, not the word "Transfer". The tray
   arrow is the same mark the rows use, so the header reads as "downloads"
   before any text does. Idle it takes the primary label colour — the
   reference toolbar's near-black mark, not the muted grey of a secondary
   action — because this is the one control in that strip that must stay
   reachable while work is moving. While something is queued or running the
   mark turns the queue's blue and carries the aggregate ring; hover must not
   repaint it as a generic label, since a control that loses its blue on
   hover reads as "the transfer stopped". The count the mark no longer prints
   lives in its accessible name. */
.sshwsp-fileaction-queue { gap: 0; padding: 0 6px; color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-fileaction-queue-active { color: var(--dsw-alias-button-info-fill, #4a9eff); border-color: color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 40%, transparent); }
.sshwsp-fileaction-queue-active:hover { color: var(--dsw-alias-button-info-fill, #4a9eff); }
/* The popover's backdrop is deliberately transparent: this panel is anchored
   to a button, not a decision that should dim the page. It still covers the
   viewport so a click outside closes what the click opened. */
.sshwsp-popbackdrop { position: fixed; inset: 0; z-index: 1000; }
.sshwsp-queuepanel { position: fixed; z-index: 1001; width: 400px; max-width: calc(100vw - 16px); max-height: 320px; display: flex; flex-direction: column; box-sizing: border-box; background: var(--dsw-alias-bg-layer-3, #1a1a1a); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-radius: 10px; box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.4)); animation: sshwsp-menu-in 120ms ease-out; }
.sshwsp-queue-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); }
.sshwsp-queue-title { flex: 1; font-size: 13px; font-weight: 600; }
.sshwsp-queue-list { overflow-y: auto; min-height: 0; flex: 1; }
.sshwsp-queue-foot { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2)); }
.sshwsp-queue-foot .sshwsp-entry-meta { flex: 1; line-height: 1.4; }
.sshwsp-queuerow { display: flex; align-items: flex-start; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); font-size: 12px; line-height: 1.45; }
.sshwsp-queuerow:last-child { border-bottom: none; }
.sshwsp-queuerow-failed { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 6%, transparent); }
.sshwsp-queueicon { flex: 0 0 auto; display: inline-flex; align-items: center; width: 16px; color: var(--dsw-alias-label-secondary, #999); }
.sshwsp-queueicon-active { color: var(--dsw-alias-button-info-fill, #4a9eff); }
.sshwsp-queuebody { flex: 1; min-width: 0; }
.sshwsp-queue-line { display: flex; align-items: baseline; gap: 8px; }
.sshwsp-queuename { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-queuemeta { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); font-family: var(--dsw-font-markdown-code-font-family, monospace); font-variant-numeric: tabular-nums; }
.sshwsp-queueerror { margin-top: 2px; color: var(--dsw-alias-state-error-primary, #ff6b6b); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
.sshwsp-queuenote { margin-top: 2px; color: var(--dsw-alias-label-secondary, #999); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
/* The download mark inside its ring: the tray arrow carries the verb
   ("download"), the ring carries the distance. One control, two readings — a
   percentage-only ring would lose the verb and a bare icon would lose the
   progress, which is the same pairing the reference toolbar shows. The grey
   track belongs to the same hue family as the blue arc and as the row's own
   bar, so one transfer never presents two competing meters. */
.sshwsp-dlring { display: inline-flex; }
.sshwsp-dlring-active { color: var(--dsw-alias-button-info-fill, #4a9eff); }
.sshwsp-dlring-track { stroke: color-mix(in srgb, var(--dsw-alias-label-tertiary, #888) 55%, transparent); }
.sshwsp-dlring-arc { transform-box: view-box; transform-origin: 50% 50%; transform: rotate(-90deg); }
/* Unknown total: a spinning 30% arc. An archive has moved bytes before it can
   know how many, and an arc parked at 0% would claim a stall it is not in. A
   known total instead fills, so each redraw states a fact, not a heartbeat. */
.sshwsp-dlring-live .sshwsp-dlring-arc { animation: sshwsp-dlring-spin 1.1s linear infinite; }
@keyframes sshwsp-dlring-spin { from { transform: rotate(-90deg); } to { transform: rotate(270deg); } }
/* A light-blue rule under each row. The row's text already states the number,
   so the bar only visualises it (aria-hidden) — a bar is not readable and a
   progress number is not glanceable, and either one alone would be a worse row.
   The track is a tint of the same hue as the fill, not a second colour: this
   panel already has an error red and a success green, and a third hue here
   would compete with both. */
.sshwsp-queuebar { position: relative; height: 3px; margin-top: 5px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 12%, transparent); }
.sshwsp-queuebar-fill { height: 100%; width: 0; border-radius: inherit; background: color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 78%, transparent); transition: width 160ms ease-out; }
/* No total: sweep the fill across the track. A determinate bar at an invented
   width is indistinguishable from a stuck one, which is exactly the reading
   this row must not invite. */
.sshwsp-queuebar-live .sshwsp-queuebar-fill { width: 38%; animation: sshwsp-queuebar-sweep 1.3s ease-in-out infinite; }
@keyframes sshwsp-queuebar-sweep { from { transform: translateX(-105%); } to { transform: translateX(285%); } }
/* Settled without success: the bar stops asserting a direction. The row's own
   state text is the fact; the fill only says how far the bytes got. */
.sshwsp-queuerow-failed .sshwsp-queuebar-fill, .sshwsp-queuerow-cancelled .sshwsp-queuebar-fill { background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #888) 55%, transparent); }
@media (prefers-reduced-motion: reduce) {
  .sshwsp-queuebar-live .sshwsp-queuebar-fill { animation: none; width: 60%; opacity: 0.7; }
  .sshwsp-queuebar-fill { transition: none; }
  .sshwsp-dlring-live .sshwsp-dlring-arc { animation: none; }
}
.sshwsp-pathbar { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06)); }
/* This path started life as a read-only DISPLAY (secondary colour, code font,
   RTL so the tail of a long path stayed visible) and kept that look after it
   became the working-directory INPUT — grey 12px monospace next to the host
   picker's normal text, which reads as "disabled". It is a primary field now,
   so it wears the same typography and colour as .sshwsp-input; the RTL trick is
   gone because an editable field must keep logical order (see the
   .sshwsp-pathbar-path.sshwsp-path-input rule). */
.sshwsp-pathbar-path { flex: 1; min-width: 0; font-family: inherit; font-size: 13px; color: var(--dsw-alias-label-primary, #e0e0e0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.sshwsp-warn { color: var(--dsw-alias-state-error-primary, #ff6b6b); font-size: 12px; line-height: 1.5; padding: 0 20px 12px; }
/* Same single-scrollport rule as .sshwsp-browser-list: this list is the tail
   of a form that lives in the dialog body, so it must grow and let the body
   scroll instead of scrolling inside a box the body then clips. */
/* Same contract as .sshwsp-browser-list: the rows are the dialog's scrollport
   and the form above them does not move. */
.sshwsp-dirlist { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.08)); }
.sshwsp-dirlist-hint { flex: 0 0 auto; padding: 8px 20px 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #666); }
@keyframes sshwsp-menu-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
@keyframes sshwsp-dialog-in { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
@keyframes sshwsp-fade-in { from { opacity: 0; } to { opacity: 1; } }
/* Recent commit history under the official change-request tab.
   The split is ONE flex column: the official panel keeps its own
   height:100% + overflow-y:auto scrollport inside the upper cell (so this
   wrapper never scrolls it for the user and never steals its scroll offset),
   and only the lower cell scrolls. The lower cell is capped as a fraction of
   the pane instead of a pixel height, because the pane is resizable and can be
   floated full-screen. */
.sshwsp-cr-split { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
.sshwsp-cr-official { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; overflow: hidden; }
.sshwsp-cr-history { display: flex; flex-direction: column; flex: 0 0 auto; min-height: 0; max-height: 45%; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); }
.sshwsp-cr-history-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 4px; }
.sshwsp-cr-history-title { flex: 1; min-width: 0; margin: 0; font-size: 12px; font-weight: 500; letter-spacing: 0.02em; color: var(--dsw-alias-label-secondary, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The title row is the fold control: one button inside the heading, so Enter and
   Space come from the platform and aria-expanded describes the state. The
   chevron rotates instead of swapping glyphs — one mark for two states, and the
   rotation is what tells the user which way the content is about to move. */
.sshwsp-cr-history-toggle { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; margin: 0; padding: 0; border: none; border-radius: 4px; background: transparent; color: inherit; font: inherit; letter-spacing: inherit; cursor: pointer; }
.sshwsp-cr-history-toggle:hover { color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-cr-history-toggle:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: 2px; }
.sshwsp-cr-history-toggletext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-cr-history-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, #888); transition: transform 120ms ease; }
.sshwsp-cr-history-toggle[aria-expanded="false"] .sshwsp-cr-history-chevron { transform: rotate(-90deg); }
.sshwsp-cr-history-note { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #777); font-variant-numeric: tabular-nums; }
.sshwsp-cr-history-refresh { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 22px; height: 22px; padding: 0; border: none; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-tertiary, #888); cursor: pointer; }
.sshwsp-cr-history-refresh:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-cr-history-refresh:disabled { opacity: 0.5; cursor: default; }
/* One grey line for loading, empty, not-a-repository and failure. No red and
   no toast: the upper panel is the tab's business, and this strip must never
   look like a failing operation the user has to act on. */
.sshwsp-cr-history-state { margin: 0; padding: 4px 12px 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #888); overflow-wrap: anywhere; }
.sshwsp-cr-history-list { flex: 1; min-height: 0; margin: 0; padding: 0 12px 10px; overflow-y: auto; list-style: none; display: flex; flex-direction: column; gap: 2px; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; line-height: 18px; }
.sshwsp-cr-commit { display: grid; grid-template-columns: minmax(56px, max-content) minmax(0, 1fr); column-gap: 8px; padding: 2px 4px; border-radius: 5px; }
.sshwsp-cr-commit:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); }
.sshwsp-cr-commit-sha { color: var(--dsw-alias-label-tertiary, #888); font-variant-numeric: tabular-nums; }
.sshwsp-cr-commit-subject { min-width: 0; color: var(--dsw-alias-label-primary, #e0e0e0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-cr-commit-meta { grid-column: 2; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary, #777); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .sshwsp-toast, .sshwsp-flowmenu, .sshwsp-dialog, .sshwsp-backdrop { animation: none; }
  .sshwsp-btn, .sshwsp-icon-btn, .sshwsp-entry { transition: none; }
  .sshwsp-cr-history-chevron { transition: none; }
}
/* ---- file editor -------------------------------------------------------
   The editor is an OVERLAY ON THE PREVIEW BODY, not a modal: it is a fixed
   box placed over the measured rect of the preview's own body, so the file
   stays exactly where it was on screen and the preview header (with the same
   button, now the way out) stays visible above it.
   Because the box is fixed and sized from a measurement, the head, the foot
   and the code area are laid out as a column INSIDE it; only the code area
   scrolls. A textarea taller than the box would otherwise scroll the panel
   itself and the line numbers would drift away from their lines. */
.sshwsp-editor-panel {
  position: fixed;
  z-index: 40;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 8px 10px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #1b1b1d);
  box-shadow: 0 8px 28px rgba(0,0,0,0.28);
  /* The measured rect is in viewport pixels; without this the border and the
     padding would add to it and the box would overhang the pane. */
  overflow: hidden;
}
.sshwsp-editor-head { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; padding-bottom: 6px; }
.sshwsp-editor-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #e0e0e0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-editor-dirty { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-warning, #d9a227); font-variant-numeric: tabular-nums; }
.sshwsp-editor-notice { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #999); }
/* One row above the text, so the count and the box never cover a line. */
.sshwsp-editor-find { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 0 0 8px; }
.sshwsp-editor-find-input { flex: 1 1 auto; min-width: 0; height: 24px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22)); background: var(--dsw-alias-bg-l1, rgba(127,127,127,0.04)); color: var(--dsw-alias-label-primary, #e0e0e0); font-size: 12px; outline: none; }
.sshwsp-editor-find-input:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -2px; }
/* Fixed width so the buttons beside it do not shift as the number grows. */
.sshwsp-editor-find-count { flex: 0 0 auto; min-width: 5ch; text-align: right; font-size: 11px; color: var(--dsw-alias-label-tertiary, #777); font-variant-numeric: tabular-nums; }
.sshwsp-editor-find-case[aria-pressed="true"] { color: var(--dsw-alias-label-info, #4a9eff); background: var(--dsw-alias-bg-layer-2, rgba(74,158,255,0.12)); }
.sshwsp-editor-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.sshwsp-editor-warn { flex: 0 0 auto; margin: 0 0 8px; padding: 6px 10px; border-radius: 6px; font-size: 12px; background: var(--dsw-alias-bg-warning, rgba(217,162,39,0.12)); color: var(--dsw-alias-label-warning, #d9a227); }
.sshwsp-editor-code { flex: 1 1 auto; min-height: 0; display: flex; gap: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22)); border-radius: 6px; overflow: hidden; background: var(--dsw-alias-bg-l1, rgba(127,127,127,0.04)); }
/* The gutter is a <pre> so it keeps the textarea's line height and its own
   scroll position can be driven from the textarea. It never scrolls on its
   own (overflow hidden) — two scroll ports desynchronise the moment a wheel
   event lands on the wrong one. */
.sshwsp-editor-gutter { flex: 0 0 auto; margin: 0; padding: 8px 6px; overflow: hidden; text-align: right; color: var(--dsw-alias-label-tertiary, #777); background: var(--dsw-alias-bg-l2, rgba(127,127,127,0.06)); font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; user-select: none; }
.sshwsp-editor-area { flex: 1 1 auto; min-width: 0; min-height: 0; margin: 0; padding: 8px 10px; border: none; outline: none; resize: none; overflow: auto; background: transparent; color: var(--dsw-alias-label-primary, #e0e0e0); font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; line-height: 18px; white-space: pre; tab-size: 2; }
.sshwsp-editor-area-wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.sshwsp-editor-area:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4a9eff); outline-offset: -2px; }
.sshwsp-editor-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding-top: 10px; }
.sshwsp-editor-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #777); font-variant-numeric: tabular-nums; }
.sshwsp-editor-spacer { flex: 1 1 auto; }
.sshwsp-editor-state { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 8px; color: var(--dsw-alias-label-secondary, #999); font-size: 13px; }
.sshwsp-editor-state-error { color: var(--dsw-alias-label-danger, #e5534b); }
.sshwsp-editor-detail { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); overflow-wrap: anywhere; }
.sshwsp-editor-conflict { flex: 0 0 auto; margin-bottom: 10px; padding: 10px 12px; border-radius: 6px; background: var(--dsw-alias-bg-warning, rgba(217,162,39,0.12)); }
.sshwsp-editor-conflict-title { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-warning, #d9a227); }
.sshwsp-editor-conflict-confirm { margin: 8px 0 0; font-size: 12px; color: var(--dsw-alias-label-primary, #e0e0e0); }
.sshwsp-editor-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.sshwsp-editor-pager-area { border: 1px solid var(--dsw-alias-border-l2, #33383f); padding: 8px 10px; resize: none; }
.sshwsp-editor-pager-count { font-size: 12px; color: var(--dsw-alias-label-secondary, #a0a6ad); white-space: nowrap; }
/* The header action shares the .sshwsp-fileaction geometry with the queue
   entry beside it, so the two sit on one baseline in the preview header. */
.sshwsp-fileaction-edit:disabled { opacity: 0.4; cursor: default; }
@media (prefers-reduced-motion: reduce) {
  .sshwsp-editor-dialog, .sshwsp-editor-area { transition: none; }
}
      `
      document.head.appendChild(tag)
    }
    exports.injectStyles = injectStyles
    exports.CSS_ID = CSS_ID
    return module.exports
  },
})
