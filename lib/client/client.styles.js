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
/* =========================================================================
   Token contract
   =========================================================================
   Every rule below this block names a \`--sshwsp-*\` token and nothing else, so
   the palette, the radii, the type scale and the z order each have exactly one
   definition. Before this block the sheet named 32 \`--dsw-*\` tokens 231 times
   and carried 62 raw colour literals; the literals were the fallbacks, which
   meant a token the Host does not publish fell back silently and nobody could
   see it in a grep. Nine of those 32 names were exactly that — see the
   "aliases the Host does not publish" note below.

   The block hangs off a LIST of roots, not one. The panel's root is \`.sshwsp\`,
   but six other roots are portalled to <body> and are therefore NOT
   descendants of it: the three dialog backdrops, the editor panel, the flow
   menu, the inline rename box, and the transfer queue. A token defined only on
   \`.sshwsp\` would leave every one of those with no value at all, and the
   failure is quiet — an undefined token makes the declaration invalid, so the
   property falls back to its initial value rather than to the fallback written
   beside it. Any new portalled root must be added here; the presentation-token
   suite reads the roots out of the source and fails when one is missing.

   Why CSS and not a runtime \`style\` attribute (the way dsh-opencode-go does
   it): attribute selectors already recompute when the Host flips
   \`data-ds-dark-theme\`, so the light layer costs one selector and zero JS. A
   runtime injector would need a call per root, a WeakMap to avoid duplicate
   work, and a MutationObserver to notice the theme change — three moving parts
   for a result the cascade gives for free. */

.sshwsp,
.sshwsp-filepane,
.sshwsp-tokens,
.sshwsp-backdrop,
.sshwsp-editor-panel,
.sshwsp-flowmenu,
.sshwsp-tabtip,
.sshwsp-inline-rename,
.sshwsp-popbackdrop,
.sshwsp-queuepanel,
.sshwsp-toast {
  /* -- A: follows the Host ------------------------------------------------
     The fallback after each comma is the ONLY place a literal is allowed, and
     it exists so a Host that publishes none of these still draws a legible
     dark panel. Each name here was verified to exist in the installed Host's
     token set; the suite pins the list so a Host upgrade that drops one turns
     red instead of silently falling back. */
  --sshwsp-bg: var(--dsw-alias-bg-base, #0f0f0f);
  --sshwsp-surface: var(--dsw-alias-bg-layer-1, #161616);
  --sshwsp-surface-2: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06));
  --sshwsp-surface-3: var(--dsw-alias-bg-layer-3, #1a1a1a);
  --sshwsp-border: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  --sshwsp-border-strong: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.25));
  --sshwsp-text: var(--dsw-alias-label-primary, #e0e0e0);
  --sshwsp-muted: var(--dsw-alias-label-secondary, #999);
  --sshwsp-faint: var(--dsw-alias-label-tertiary, #666);
  /* The rule and trash marks in a menu are not body text: the Host paints them
     with its own menu-icon alias, which is lighter than a label in both themes.
     Using --sshwsp-muted here made the marks read one step too dark next to the
     Host's own context menu. */
  --sshwsp-menu-icon: var(--dsw-alias-menu-icon, #999);
  --sshwsp-accent: var(--dsw-alias-button-info-fill, #4a9eff);
  --sshwsp-accent-hover: var(--dsw-alias-button-info-hover, #4a9eff);
  --sshwsp-on-accent: var(--dsw-alias-label-on-color, #fff);
  --sshwsp-danger: var(--dsw-alias-state-error-primary, #ff6b6b);
  --sshwsp-danger-text: var(--dsw-alias-label-error, #e5534b);
  --sshwsp-warn: var(--dsw-alias-state-warn-primary, #fbbf24);
  --sshwsp-warn-text: var(--dsw-alias-state-warn-label, #d9a227);
  --sshwsp-success: var(--dsw-alias-state-success-primary, #4ade80);
  --sshwsp-hover: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1));
  --sshwsp-active: var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.16));
  --sshwsp-mask: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.5));
  --sshwsp-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0, 0, 0, 0.4));
  --sshwsp-font: var(--dsw-font-family, system-ui, sans-serif);
  --sshwsp-mono: var(--dsw-font-markdown-code-font-family, monospace);

  /* -- B: derived from A, so they follow the Host for free -----------------
     color-mix rather than a literal keeps these correct under a theme the
     sheet has never seen: they are ratios over whatever --sshwsp-text or
     --sshwsp-accent currently resolve to, not a second palette to maintain. */
  --sshwsp-sunken: color-mix(in srgb, var(--sshwsp-text) 4%, transparent);
  --sshwsp-border-subtle: color-mix(in srgb, var(--sshwsp-text) 10%, transparent);
  /* The host renders markdown with its own palette: a tinted code card, a
     slightly darker header strip, and a tinted inline-code chip. The generic
     surface tokens cannot express these — in the light theme the code card is
     NOT white, it is a gray panel. */
  --sshwsp-html-canvas: var(--dsw-alias-bg-base, #ffffff);
  --sshwsp-md-code-bg: var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, 0.10));
  --sshwsp-md-code-banner: var(--dsw-alias-markdown-code-block-banner, rgba(127, 127, 127, 0.06));
  --sshwsp-md-inline-code: var(--dsw-alias-markdown-inline-code, rgba(127, 127, 127, 0.12));
  /* Fence highlighting. Deliberately built from our own palette rather than the
     host's shiki variables: those are published per theme and a missing one
     would silently drop the colour, and three tones are all a README needs. */
  --sshwsp-md-tok-comment: var(--sshwsp-muted);
  --sshwsp-md-tok-string: var(--sshwsp-success);
  --sshwsp-md-tok-keyword: var(--sshwsp-accent);
  --sshwsp-md-tok-number: var(--sshwsp-warn-text);
  --sshwsp-accent-soft: color-mix(in srgb, var(--sshwsp-accent) 12%, transparent);
  --sshwsp-danger-soft: color-mix(in srgb, var(--sshwsp-danger) 14%, transparent);
  --sshwsp-warn-soft: color-mix(in srgb, var(--sshwsp-warn) 12%, transparent);
  --sshwsp-track: color-mix(in srgb, var(--sshwsp-text) 18%, transparent);
  --sshwsp-selection: color-mix(in srgb, var(--sshwsp-accent) 28%, transparent);

  /* -- C: our own scale ---------------------------------------------------
     The Host publishes radii, a focus ring and a type scale; the sheet used
     none of them and hand-wrote 9 radii, 8 font sizes, 44 padding shorthands
     and 8 z-index values. These map onto the Host's where it has a name and
     fall back to the value the sheet already used, so adopting them changes
     nothing visually until a rule is switched over. */
  --sshwsp-radius-xs: var(--dsw-radius-xs, 4px);
  --sshwsp-radius-sm: var(--dsw-radius-sm, 8px);
  --sshwsp-radius-md: var(--dsw-radius-md, 12px);
  /* The Host rounds a floating menu's own sheet with radius-lg, not radius-md:
     the sheet is large enough that the smaller radius reads as a sharp corner
     against a menu the Host drew itself. */
  --sshwsp-radius-lg: var(--dsw-radius-lg, 16px);
  --sshwsp-radius-pill: 999px;
  --sshwsp-radius-round: 50%;
  /* A surface that fills its parent has no corner of its own to round: the
     conversation file tab and the code well inside it both butt against the
     Host's edges, and a radius there would carve a notch out of the seam. */
  --sshwsp-radius-none: 0;
  /* A tab is rounded on its top two corners only; the bottom edge meets the
     surface it sits on, so rounding it there would draw a visible seam. */
  --sshwsp-radius-tab: var(--dsw-radius-sm, 6px) var(--dsw-radius-sm, 6px) 0 0;
  --sshwsp-focus-width: var(--dsw-focus-ring-width, 2px);
  /* A dense tree row gets an INSET ring, and 2px of inset ring on a 24px row
     eats the glyph. One pixel is a deliberate second weight, not a leftover. */
  --sshwsp-focus-width-thin: 1px;
  --sshwsp-focus-offset: 2px;
  --sshwsp-font-2xs: var(--dsw-font-xxxs-11-font-size, 11px);
  --sshwsp-font-xs: var(--dsw-font-xxs-12-font-size, 12px);
  --sshwsp-font-sm: var(--dsw-font-xs-13-font-size, 13px);
  --sshwsp-font-md: var(--dsw-font-s-14-font-size, 14px);
  --sshwsp-font-lg: var(--dsw-font-m-18-font-size, 18px);
  --sshwsp-space-1: 2px;
  --sshwsp-space-2: 4px;
  --sshwsp-space-3: 6px;
  --sshwsp-space-4: 8px;
  --sshwsp-space-5: 12px;
  --sshwsp-space-6: 16px;
  /* The z scale keeps the order the sheet already relied on: the host tree's
     overlay below every dialog, a backdrop below the surface it dims, and
     menus above the dialog that opened them. */
  --sshwsp-z-base: 0;
  --sshwsp-z-raised: 1;
  --sshwsp-z-overlay: 40;
  --sshwsp-z-mask: 100;
  --sshwsp-z-dialog: 200;
  --sshwsp-z-menu: 300;
}

/* The light layer overrides ONLY what the Host's own light palette cannot
   supply. Everything else is already a --dsw-* alias, and the Host swaps those
   itself when the theme flips; re-declaring them here would be the "second
   theme" the UI guide rules out. The property that matters is the selector:
   \`body:not([data-ds-dark-theme])\` is the Host's own signal (a boolean
   attribute it sets from the active colour scheme), so no observer is needed
   and no preference query is consulted behind the Host's back. */
body:not([data-ds-dark-theme]) .sshwsp,
body:not([data-ds-dark-theme]) .sshwsp-filepane,
body:not([data-ds-dark-theme]) .sshwsp-tokens,
body:not([data-ds-dark-theme]) .sshwsp-backdrop,
body:not([data-ds-dark-theme]) .sshwsp-editor-panel,
body:not([data-ds-dark-theme]) .sshwsp-flowmenu,
body:not([data-ds-dark-theme]) .sshwsp-inline-rename,
body:not([data-ds-dark-theme]) .sshwsp-popbackdrop,
body:not([data-ds-dark-theme]) .sshwsp-queuepanel,
body:not([data-ds-dark-theme]) .sshwsp-toast {
  --sshwsp-text: var(--dsw-alias-label-primary, #1f2328);
  --sshwsp-muted: var(--dsw-alias-label-secondary, #59636e);
  --sshwsp-faint: var(--dsw-alias-label-tertiary, #6e7781);
  --sshwsp-border: var(--dsw-alias-border-l2, rgba(31, 35, 40, 0.15));
  --sshwsp-border-strong: var(--dsw-alias-border-l3, rgba(31, 35, 40, 0.22));
  --sshwsp-shadow: var(--dsw-elevation-prominent, 0 8px 28px rgba(31, 35, 40, 0.16));
}

.sshwsp { font-family: var(--sshwsp-font); color: var(--sshwsp-text); padding: 0; overflow-y: auto; height: 100%; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; container-type: inline-size; container-name: sshwsp-panel; }
/* The page column. The panel used to paint edge to edge, which reads as a
   settings dump; the Host's own console page puts its content in a centred
   column with real side whitespace, and that is what these two rules copy:
   at most 980px of content, and once the page is wider than that, the surplus
   splits evenly instead of stretching every row. 980px is the reference
   console page's cap; 720px left the host cards looking like a narrow form
   with the buttons pressed against the right edge. The top padding is 72px,
   not 20px: the page title has to clear the top edge of the pane the way the
   console page does, and 32px still read as flush against the scrollport.
   The 14px padding is a flat value on purpose: \`padding: 0 calc(50% - 360px)\`
   looks like it centres the same column, but a percentage padding resolves
   against the CONTAINING BLOCK, not against this box, so on a 1400px page it
   becomes 340px per side and a 720px column is left with 40px of content —
   the panel renders as a strip of vertical text. Centring is the auto margins'
   job; padding only supplies the floor for a narrow page. */
.sshwsp-panel-inner { box-sizing: border-box; width: 100%; max-width: 980px; margin: 0 auto; padding: 72px 24px 40px; }
.sshwsp-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
/* One scrollbar for every scrollport in the panel, rather than the platform
   default: on Windows that is a light grey trough, which in a dark panel is
   the most visible place the panel stops looking like part of the app. The
   standard pair does the work; the webkit block is the fallback for engines
   that do not implement it yet, and it is the only place ::-webkit-* appears. */
.sshwsp ::-webkit-scrollbar { width: 10px; height: 10px; }
.sshwsp ::-webkit-scrollbar-track { background: transparent; }
.sshwsp ::-webkit-scrollbar-thumb { background: var(--sshwsp-track); border-radius: var(--sshwsp-radius-pill); border: 2px solid transparent; background-clip: content-box; }
.sshwsp ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--sshwsp-text) 30%, transparent); background-clip: content-box; }
.sshwsp ::-webkit-scrollbar-corner { background: transparent; }
.sshwsp-editor-panel ::-webkit-scrollbar { width: 10px; height: 10px; }
.sshwsp-editor-panel ::-webkit-scrollbar-thumb { background: var(--sshwsp-track); border-radius: var(--sshwsp-radius-pill); border: 2px solid transparent; background-clip: content-box; }
.sshwsp-editor-panel ::-webkit-scrollbar-track { background: transparent; }
.sshwsp h2 { font-size: var(--sshwsp-font-lg); font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.sshwsp h3 { font-size: var(--sshwsp-font-xs); font-weight: 500; margin: 24px 0 12px; color: var(--sshwsp-muted); letter-spacing: 0.02em; }
/* A subheading under a section head: same size as the h3 so the zone still
   reads as one block, but lighter and dimmer so it is visibly one level down.
   The top margin stays 0 on purpose — it inherits the section head's bottom
   margin through margin collapsing, and a second 12px would open a gap that
   separates a title from the controls it names. */
.sshwsp h4 { font-size: var(--sshwsp-font-xs); font-weight: 400; margin: 0 0 10px; color: var(--sshwsp-faint); letter-spacing: 0.02em; }
.sshwsp-card { background: var(--sshwsp-surface-2); border: 1px solid var(--sshwsp-border); border-radius: var(--sshwsp-radius-sm); padding: 12px 16px; margin-bottom: 8px; }
.sshwsp-host { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
/* The host power switch: a real switch, because the host has a durable on/off
   state. Sized to the card's type scale and drawn with the panel's tokens so it
   does not read as a checkbox in a form. */
.sshwsp-power { flex: 0 0 auto; width: 30px; height: 18px; padding: 2px; border-radius: var(--sshwsp-radius-pill); border: 1px solid var(--sshwsp-border); background: var(--sshwsp-surface-2); cursor: pointer; display: inline-flex; align-items: center; transition: background 120ms ease-out, border-color 120ms ease-out; }
.sshwsp-power:disabled { opacity: 0.6; cursor: progress; }
.sshwsp-power:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: var(--sshwsp-focus-offset); }
.sshwsp-power:hover:not(:disabled) { border-color: var(--sshwsp-border-strong); }
.sshwsp-power-on { background: var(--sshwsp-accent); border-color: var(--sshwsp-accent); }
.sshwsp-power-knob { width: 12px; height: 12px; border-radius: var(--sshwsp-radius-round); background: var(--sshwsp-surface); transform: translateX(0); transition: transform 120ms ease-out; }
.sshwsp-power-on .sshwsp-power-knob { transform: translateX(12px); }
.sshwsp-host-info { flex: 1; min-width: 0; }
.sshwsp-host-alias { font-weight: 500; font-size: var(--sshwsp-font-md); display: flex; align-items: center; gap: 8px; }
.sshwsp-host-addr { font-size: var(--sshwsp-font-xs); color: var(--sshwsp-muted); font-family: var(--sshwsp-mono); }
.sshwsp-host-meta { display: flex; gap: 8px; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); margin-top: 2px; font-variant-numeric: tabular-nums; }
.sshwsp-host-desc { font-size: var(--sshwsp-font-xs); color: var(--sshwsp-muted); margin-top: 2px; overflow-wrap: anywhere; }
.sshwsp-host-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sshwsp-host-lastused { font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); margin-top: 4px; }
.sshwsp-provenance { font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); margin-bottom: 8px; }
/* The tab row: an underline strip, not a segmented control. It borrowed the
   Host console page's metrics (38px tall, 13px label, 11px side padding, a 2px
   underline that stops 9px short of each edge) because the two are the same
   gesture in the same product; the tab that is selected also gains weight, so
   colour is not the only difference. The row scrolls horizontally instead of
   wrapping — wrapping moves the underline and the row jumps when a label
   changes, and no panel label is long enough to justify two lines. */
.sshwsp-tabs { display: flex; align-items: center; gap: 2px; margin: 14px 0 18px; padding: 0 2px; border-bottom: 1px solid var(--sshwsp-border-subtle); overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-tab { position: relative; flex: none; height: 38px; padding: 0 11px; border: 0; border-radius: var(--sshwsp-radius-sm) var(--sshwsp-radius-sm) 0 0; background: none; color: var(--sshwsp-muted); font: inherit; font-size: var(--sshwsp-font-sm); line-height: 1.4; white-space: nowrap; cursor: pointer; }
.sshwsp-tab:hover { color: var(--sshwsp-text); background: var(--sshwsp-surface-2); }
.sshwsp-tab[aria-selected="true"] { color: var(--sshwsp-text); font-weight: 600; }
.sshwsp-tab[aria-selected="true"]::after { content: ''; position: absolute; left: 9px; right: 9px; bottom: -1px; height: 2px; border-radius: var(--sshwsp-radius-pill); background: currentColor; }
.sshwsp-tab:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: -2px; }
/* The pane owns no chrome: it is a grouping for the tab contract, and adding a
   surface here would box the sections that already have their own cards. */
.sshwsp-tabpane { display: block; }
.sshwsp-host-tag {
  font-size: var(--sshwsp-font-2xs);
  line-height: 1.4;
  padding: 0 6px;
  border-radius: var(--sshwsp-radius-pill);
  color: var(--sshwsp-muted);
  background: var(--sshwsp-active);
  overflow-wrap: anywhere;
}
.sshwsp-host-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.sshwsp-host-confirm { flex-basis: 100%; display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--sshwsp-border-subtle); padding-top: 8px; }
.sshwsp-host-confirm span { flex: 1; font-size: var(--sshwsp-font-xs); color: var(--sshwsp-faint); }
.sshwsp-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 24px 0 12px; }
.sshwsp-section-head h3 { margin: 0; }
/* The report title carries the verdict dot. inline-flex so the dot sits on
   the text's optical centre rather than its baseline, and the gap keeps it
   from touching the last glyph. */
.sshwsp-report-title { display: inline-flex; align-items: center; gap: 7px; }
.sshwsp-diagnosis { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px; }
.sshwsp-diagnosis-row { display: flex; align-items: baseline; gap: 8px; font-size: var(--sshwsp-font-xs); line-height: 1.5; }
.sshwsp-diagnosis-detail { color: var(--sshwsp-muted); }
/* Advisory rows: collapsed by default and quieter than the findings, because
   they are context, not a verdict. They still have to be READABLE when opened —
   a self-check the user cannot read is the same as no self-check. */
.sshwsp-diagnosis-notes { margin: 0 0 12px; font-size: var(--sshwsp-font-xs); line-height: 1.5; }
.sshwsp-diagnosis-notes > summary { cursor: pointer; color: var(--sshwsp-faint); }
.sshwsp-diagnosis-notes > .sshwsp-diagnosis-row { padding-left: 12px; }
.sshwsp-btn { background: var(--sshwsp-hover); border: 1px solid var(--sshwsp-border-strong); color: var(--sshwsp-text); border-radius: var(--sshwsp-radius-sm); padding: 5px 10px; font-size: var(--sshwsp-font-xs); cursor: pointer; transition: background 120ms ease-out, transform 100ms ease-out; white-space: nowrap; }
.sshwsp-btn:hover { background: var(--sshwsp-active); }
.sshwsp-btn:active:not(:disabled) { transform: scale(0.98); }
.sshwsp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sshwsp-btn-primary { background: var(--sshwsp-accent); color: var(--sshwsp-on-accent); border-color: transparent; }
.sshwsp-btn-primary:hover { background: var(--sshwsp-accent-hover); }
.sshwsp-btn-danger { color: var(--sshwsp-danger); border-color: color-mix(in srgb, var(--sshwsp-danger) 35%, transparent); }
.sshwsp-btn-danger:hover { background: color-mix(in srgb, var(--sshwsp-danger) 12%, transparent); }
.sshwsp-btn:focus-visible, .sshwsp-icon-btn:focus-visible, .sshwsp-menuitem:focus-visible, .sshwsp-entry:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: 1px; }
.sshwsp-status { font-size: var(--sshwsp-font-2xs); padding: 2px 6px; border-radius: var(--sshwsp-radius-xs); }
.sshwsp-status-ok { color: var(--sshwsp-success); background: color-mix(in srgb, var(--sshwsp-success) 15%, transparent); }
.sshwsp-status-err { color: var(--sshwsp-danger); background: color-mix(in srgb, var(--sshwsp-danger) 15%, transparent); }
.sshwsp-status-warn { color: var(--sshwsp-warn); background: color-mix(in srgb, var(--sshwsp-warn) 15%, transparent); }
/* Neutral chip for "undetermined": it is not a warning (nothing is known to be
   wrong) and it is not success (nothing is known to be right). Grey is the only
   colour that says neither. */
.sshwsp-status-off { color: var(--sshwsp-faint); background: color-mix(in srgb, var(--sshwsp-faint) 15%, transparent); }
.sshwsp-check-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.sshwsp-check-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: var(--sshwsp-font-xs); }
.sshwsp-check-tool { font-family: var(--sshwsp-mono); font-weight: 600; }
/* A self-check card: the header is the disclosure control, so the card stacks
   instead of flowing the way .sshwsp-mount (a one-line mount row) does. */
.sshwsp-mount-col { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
.sshwsp-check-head { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; padding: 0; border: none; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sshwsp-check-head:hover:not(:disabled) { color: var(--sshwsp-text); }
.sshwsp-check-head:disabled { cursor: default; }
.sshwsp-check-head:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: var(--sshwsp-focus-offset); border-radius: var(--sshwsp-radius-xs); }
.sshwsp-check-caret { flex: 0 0 auto; width: 10px; color: var(--sshwsp-faint); font-size: var(--sshwsp-font-2xs); }
.sshwsp-check-spacer { flex: 1; }
.sshwsp-check-inline { font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); color: var(--sshwsp-warn); overflow-wrap: anywhere; }
.sshwsp-audit-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: var(--sshwsp-font-xs); padding: 2px 0; }
.sshwsp-audit-command { font-family: var(--sshwsp-mono); overflow-wrap: anywhere; }
/* The audit tab's rows carry more columns than the status section's failures
   list, so the command gets the flexible width and the fixed columns keep their
   size: a wrapping alias would otherwise push the command out of alignment on
   every row. */
.sshwsp-audit-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; margin: 8px 0; }
.sshwsp-audit-when { font-family: var(--sshwsp-mono); font-variant-numeric: tabular-nums; color: var(--sshwsp-faint); }
.sshwsp-audit-channel { color: var(--sshwsp-faint); }
.sshwsp-audit-error { color: var(--sshwsp-danger); overflow-wrap: anywhere; }
.sshwsp-audit-full .sshwsp-audit-command { flex: 1 1 240px; min-width: 0; }
.sshwsp-toast { position: fixed; left: 50%; top: 40px; transform: translateX(-50%); z-index: var(--sshwsp-z-menu); box-sizing: border-box; max-width: min(480px, 90vw); padding: 9px 14px; border-radius: var(--sshwsp-radius-sm); border: 1px solid var(--sshwsp-border); background: var(--sshwsp-surface-3); box-shadow: var(--sshwsp-shadow); font-size: var(--sshwsp-font-xs); line-height: 1.5; cursor: pointer; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; animation: sshwsp-toast-in 160ms ease-out; }
/* The toast root is focusable (tabIndex 0) and a click on it dismisses, so
   it needs the two states every other focusable element has. Without a
   ring, a keyboard user who tabbed into a notice could not see that they
   had, and Escape was the only thing that behaved differently. */
.sshwsp-toast:hover { border-color: var(--sshwsp-border-strong); }
.sshwsp-toast:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: var(--sshwsp-focus-offset); }
.sshwsp-toast-ok { color: var(--sshwsp-success); }
.sshwsp-toast-err { color: var(--sshwsp-danger); }
.sshwsp-toast-muted { color: var(--sshwsp-muted); }
/* The toast is a fixed frame with an action row and a collapsible detail
   block. Buttons live BELOW the message rather than replacing it, so the
   sentence that says what failed survives every action. */
.sshwsp-toast-line { display: block; }
.sshwsp-toast-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 7px; }
.sshwsp-toast-action { appearance: none; padding: 1px 0; border: 0; background: none; color: inherit; font: inherit; font-size: var(--sshwsp-font-2xs); line-height: 1.4; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; opacity: 0.9; }
.sshwsp-toast-action:hover { opacity: 1; }
.sshwsp-toast-action:focus-visible { outline: var(--sshwsp-focus-width) solid currentColor; outline-offset: var(--sshwsp-focus-offset); border-radius: var(--sshwsp-radius-xs); }
.sshwsp-toast-action:disabled { cursor: progress; opacity: 0.55; }
.sshwsp-toast-action[hidden] { display: none; }
.sshwsp-toast-status { display: block; margin-top: 6px; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-muted); }
.sshwsp-toast-status:empty { display: none; }
.sshwsp-toast-detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--sshwsp-border); color: var(--sshwsp-muted); cursor: text; }
.sshwsp-toast-detail[hidden] { display: none; }
.sshwsp-toast-detail-code { display: block; margin-bottom: 4px; font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-2xs); letter-spacing: 0.02em; opacity: 0.85; }
.sshwsp-toast-detail pre { margin: 0; max-height: 180px; overflow: auto; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-2xs); line-height: 1.45; color: var(--sshwsp-muted); user-select: text; cursor: text; }
@keyframes sshwsp-toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
/* 'clip' rather than 'hidden': both keep the rounded corners, but 'hidden'
   makes this element a scroll container, and a sticky child would then stick
   to IT (which never scrolls) instead of to the dialog body. */
/* The frame is a flex column so its header can stay put while its list takes
   the remaining height. overflow: clip keeps the rounded corners without
   making the frame a scroll container — hidden would, and a sticky child
   would then stick to a box that never scrolls. */
.sshwsp-browser { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--sshwsp-border); border-radius: var(--sshwsp-radius-sm); overflow: clip; }
/* Not sticky any more: the header sits OUTSIDE the scrolling list now, so it
   never moves in the first place. Sticky is kept off deliberately — it was the
   workaround for a single-scroller layout that no longer exists. */
.sshwsp-browser-header { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 14px; background-color: var(--sshwsp-surface-3); background-image: linear-gradient(var(--sshwsp-surface-2), var(--sshwsp-surface-2)); border-bottom: 1px solid var(--sshwsp-border-strong); }
.sshwsp-browser-hint { flex: 0 0 auto; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); white-space: nowrap; }
.sshwsp-browser-path { flex: 1; font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); color: var(--sshwsp-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-path-input { background: transparent; border: 0; padding: 0; outline: none; color: var(--sshwsp-text); cursor: text; }
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
.sshwsp-browser-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-entry { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 8px 14px; border: none; border-bottom: 1px solid var(--sshwsp-border-subtle); background: none; color: inherit; font: inherit; text-align: left; cursor: default; transition: background 100ms ease-out; }
.sshwsp-entry-dir { cursor: pointer; user-select: none; }
.sshwsp-entry:focus-visible { outline: var(--sshwsp-focus-width-thin) solid var(--sshwsp-accent); outline-offset: -1px; }
.sshwsp-entry-dir:hover { background: var(--sshwsp-hover); }
/* A file row in a directory picker: context, never a choice. It keeps the
   layout of a row (so the column reads as one list) but loses every signal of
   interactivity — a pointing hand, hover fill, focus ring — because a file here
   can be neither entered nor picked. */
.sshwsp-entry-file { cursor: default; user-select: none; color: var(--sshwsp-muted); }
.sshwsp-entry-file:hover { background: none; }
.sshwsp-entry-file .sshwsp-entry-icon { opacity: 0.75; }
/* The row a picker will act on. A left edge rule rather than a full fill: the
   hover state is already a fill, and a picked row under the pointer must still
   read as picked. */
.sshwsp-entry-picked { background: var(--sshwsp-active); box-shadow: inset 2px 0 0 var(--sshwsp-accent); }
.sshwsp-picked { flex: 0 0 auto; padding: 4px 2px 0; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-muted); font-family: var(--sshwsp-mono); overflow-wrap: anywhere; }
/* Host file tree (DSH's own Files tab): selection is painted onto the host's
   rows through classes of our own. Nothing here targets a host class name, so a
   restyle upstream cannot silently drop the highlight — and a selected row is
   still the host's row, with the host's handlers, underneath. */
.sshwsp-tree-row-selected { background: color-mix(in srgb, var(--sshwsp-accent) 14%, transparent) !important; }
.sshwsp-tree-row-selected > button { background: transparent; }
.sshwsp-tree-row-cursor > button { outline: var(--sshwsp-focus-width-thin) solid var(--sshwsp-accent); outline-offset: -1px; border-radius: var(--sshwsp-radius-xs); }
/* The in-place rename editor. It is PORTALED to <body>, so it is positioned
   against the viewport from the row's name span; nothing here may assume it is
   a descendant of the row it edits. */
.sshwsp-inline-rename { position: fixed; z-index: var(--sshwsp-z-menu); box-sizing: border-box; padding: 0 4px; border: 1px solid var(--sshwsp-accent); border-radius: var(--sshwsp-radius-xs); background: var(--sshwsp-surface-3); color: var(--sshwsp-text); font: inherit; font-size: var(--sshwsp-font-sm); outline: none; }
.sshwsp-inline-rename[aria-invalid="true"] { border-color: var(--sshwsp-danger); }

.sshwsp-entry:last-child { border-bottom: none; }
.sshwsp-entry-icon { width: 16px; height: 16px; color: var(--sshwsp-muted); flex-shrink: 0; }
/* The host this workspace points at is gone from the host list. Red, not
   dimmed: this is not a state to live with, it is the reason every action on
   the row will fail, and the tooltip says which host to add back. */
.sshwsp-hostgone { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 16px; height: 16px; border: 1px solid var(--sshwsp-danger); border-radius: var(--sshwsp-radius-round); font-size: var(--sshwsp-font-xs); font-weight: 700; line-height: 1; color: var(--sshwsp-danger-text); background: var(--sshwsp-danger-soft); }
.sshwsp-entry-name { flex: 1; font-size: var(--sshwsp-font-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-entry-meta { font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); font-family: var(--sshwsp-mono); font-variant-numeric: tabular-nums; }
/* Wraps because an armed row carries two checkboxes AND two buttons: in a narrow
   panel those four items are wider than the row, and pushing the last button out
   of view would hide the confirm that the flow exists to make explicit. */
.sshwsp-mount { border: 1px solid var(--sshwsp-border); border-radius: var(--sshwsp-radius-sm); padding: 10px 14px; margin-bottom: 6px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.sshwsp-mount-path { flex: 1; font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A detached workspace row: dimmed but fully legible, and never given
   pointer-events:none — the whole point of the row is its Enable button. */
.sshwsp-mount-off { opacity: 0.62; }
.sshwsp-mount-off .sshwsp-mount-path { color: var(--sshwsp-faint); }
/* The "also remove the workspace record" opt-in inside an armed unmount row.
   It stays a checkbox rather than a second button because the two actions
   differ only in scope, and picking the wrong button here is unrecoverable
   for the row's visibility. */
.sshwsp-check { display: inline-flex; align-items: center; gap: 6px; font-size: var(--sshwsp-font-xs); color: var(--sshwsp-muted); cursor: pointer; white-space: nowrap; }
.sshwsp-check input { margin: 0; cursor: pointer; }
/* Sidebar rows for detached workspaces. Set by passRemoteMarks; display-only,
   so a click still reaches DSH and the panel's Enable button stays the way
   back. Intercepting the host's own row click would break on its next
   redesign, which is a worse trade than a row that opens and shows an error. */
[data-sshwsp-disabled="1"] { opacity: 0.5; }
/* A workspace whose HOST is switched off: same dimming, different reason. The
   attribute is set by the marks pass from \`/status.disabledHosts\`; it is a hint
   — the row still opens, and switching the host back on clears it. */
[data-sshwsp-hostoff="1"] { opacity: 0.55; }
[data-sshwsp-hostoff="1"] [data-row-key] { pointer-events: auto; }
/* The power glyph marks the WORKSPACE header only. Applying it to every
   attribute carrier would stamp one on each session row too, which reads as
   "N separate switches" rather than "this workspace is off".

   Drawn as a masked SVG, not as the U+23FB character it started as: that code
   point is absent from the UI fonts this app ships with, so the row rendered a
   tofu box — a marker that reads as a glyph bug, which is worse than no marker
   at all. The mask paints the shape in currentColor, so it keeps following the
   theme the way a text glyph would. */
[data-row-key^="workspace:"][data-sshwsp-disabled="1"]::after {
  content: "";
  display: inline-block;
  flex: none;
  width: 10px;
  height: 10px;
  margin-left: 6px;
  background-color: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='2.2' stroke-linecap='round'%3E%3Cpath d='M8 2.4v5.4'/%3E%3Cpath d='M12.4 4.7a5.8 5.8 0 1 1-8.8 0'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='2.2' stroke-linecap='round'%3E%3Cpath d='M8 2.4v5.4'/%3E%3Cpath d='M12.4 4.7a5.8 5.8 0 1 1-8.8 0'/%3E%3C/svg%3E") center / contain no-repeat;
}
/* Nothing is disabled here — only dimmed. The dimming is the whole message:
   "this workspace is detached". Clicks still go through to DSH, so a session
   opens and its row actions fire exactly as they would on a mounted workspace;
   whatever the host then refuses (a file read, a command) says so itself, in
   the place the user is already looking, instead of the sidebar swallowing the
   click and leaving them to guess why. */
/* Empty / loading / error placeholders. Every section renders one of these
   before it has rows, so this rule must exist even while the surrounding
   layout is being reworked: without it the placeholder collapses to an
   unstyled line and the panel looks half-loaded. */
.sshwsp-empty { text-align: center; padding: 32px 16px; color: var(--sshwsp-faint); font-size: var(--sshwsp-font-sm); }
/* The reason behind an empty section: smaller, left-aligned, and NOT centred —
   it is a diagnosis, not a placeholder, and centring it would read as decoration. */
.sshwsp-empty-detail { margin-top: 6px; font-size: var(--sshwsp-font-xs); line-height: 1.5; word-break: break-word; opacity: 0.85; }
/* Dialog prose: distinct from a field label and from the hint line below it. */
.sshwsp-dialog-text { margin: 0 0 10px; font-size: var(--sshwsp-font-sm); line-height: 1.55; }
.sshwsp-dialog-hint { margin: 10px 0 0; font-size: var(--sshwsp-font-xs); line-height: 1.5; opacity: 0.8; }
.sshwsp-power-list { margin: 0 0 4px; padding-left: 18px; font-size: var(--sshwsp-font-sm); line-height: 1.6; }
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
.sshwsp-forward-off .sshwsp-mount-path { color: var(--sshwsp-faint); }
.sshwsp-forward-error { flex-basis: 100%; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The shared .sshwsp-check spreads label and box to opposite ends, which is
   right for a two-line row but wrong here: the box must sit beside the label
   it belongs to, not float away from it. Compounded so it outranks
   .sshwsp-check regardless of where this rule lands in the sheet.
   display/flex-direction are repeated here on purpose: .sshwsp-check declares
   neither, relying on the .sshwsp-field class for display:flex, and this label
   does not carry that class. Without them the row falls back to display:inline
   and the title drops onto its own line. */
.sshwsp-check.sshwsp-forward-autostart { display: flex; flex-direction: row; align-items: center; margin: 0 0 10px; padding: 8px 0 0; border-top: 1px solid var(--sshwsp-border-subtle); justify-content: flex-start; gap: 8px; }
/* The host card's auto-connect checkbox: box beside its label, not pushed to the
   far end of the actions row by the shared two-line .sshwsp-check rule. */
.sshwsp-check.sshwsp-host-autoconnect { display: flex; flex-direction: row; align-items: center; justify-content: flex-start; gap: 6px; white-space: nowrap; }
.sshwsp-check.sshwsp-host-autoconnect .sshwsp-check-text { font-size: var(--sshwsp-font-xs); white-space: nowrap; }
.sshwsp-porthint { font-size: var(--sshwsp-font-2xs); margin: -2px 0 8px; color: var(--sshwsp-faint); }
.sshwsp-porthint-busy { color: var(--sshwsp-warn); }
.sshwsp-porthint-free { color: var(--sshwsp-success); }
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
.sshwsp-passthrough-off { margin: 0 0 10px; font-size: var(--sshwsp-font-xs); line-height: 1.5; color: var(--sshwsp-warn); }
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
.sshwsp-cap-scroll { overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding-right: 2px; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
/* Hosts and forwards are cards/rows that already bring their own bottom
   margin. Inside a flex column those margins stack ON TOP of the gap (they do
   not collapse), so a capped list would be spaced twice as loose as the same
   list uncapped. The cap owns the spacing; the rows drop theirs. */
.sshwsp-cap > .sshwsp-card, .sshwsp-cap > .sshwsp-mount { margin-bottom: 0; }
.sshwsp-conn { display: inline-flex; align-items: center; gap: 6px; font-size: var(--sshwsp-font-xs); font-weight: 400; font-variant-numeric: tabular-nums; }
.sshwsp-dot { width: 6px; height: 6px; border-radius: var(--sshwsp-radius-round); flex-shrink: 0; }
.sshwsp-dot-ok { background: var(--sshwsp-success); }
.sshwsp-dot-err { background: var(--sshwsp-danger); }
.sshwsp-dot-warn { background: var(--sshwsp-warn); }
.sshwsp-error { color: var(--sshwsp-danger); font-size: var(--sshwsp-font-xs); margin-top: 4px; }
/* A probe answer reads as a status, not an error: the same sentence in the
   danger colour would tell a user their host is broken when the form merely
   has not been tested yet. Only the failure half borrows the alert colour. */
.sshwsp-probe { font-size: var(--sshwsp-font-xs); margin-top: 4px; font-variant-numeric: tabular-nums; }
.sshwsp-probe-ok { color: var(--sshwsp-success); }
.sshwsp-probe-err { color: var(--sshwsp-danger); }
.sshwsp-backdrop { position: fixed; inset: 0; background: var(--sshwsp-mask); display: flex; align-items: center; justify-content: center; z-index: var(--sshwsp-z-mask); animation: sshwsp-fade-in 120ms ease-out; }
.sshwsp-dialog { background: var(--sshwsp-surface-3); border: 1px solid var(--sshwsp-border); border-radius: var(--sshwsp-radius-md); width: 640px; max-width: 90vw; max-height: 80vh; display: flex; flex-direction: column; box-shadow: var(--sshwsp-shadow); animation: sshwsp-dialog-in 140ms ease-out; }
.sshwsp-dialog-narrow { width: 480px; }
/* Dialogs whose body holds a scrolling list need a HEIGHT, not just a cap: with
   only max-height the box shrinks to its content and flex: 1 on the list has
   nothing to divide, so the list would never scroll and the whole dialog would
   grow past the viewport instead. */
/* The base dialog caps at 80vh; a fill dialog must raise that cap too, or the
   cap silently wins over the height and the list never gets the extra rows. */
.sshwsp-dialog-fill { height: min(88vh, 760px); max-height: 88vh; }
.sshwsp-dialog-title { padding: 16px 20px; font-size: var(--sshwsp-font-lg); font-weight: 600; border-bottom: 1px solid var(--sshwsp-border-strong); }
/* The body is a flex COLUMN, not a scrollport: the dialog owns the height, the
   body hands the leftover space to whichever child is the scroller (the
   directory list), and everything else stays where it is. overflow: hidden
   keeps a stray wide child from painting outside the rounded frame without
   making the body a second scroll container. */
.sshwsp-dialog-body { padding: 0; overflow: hidden; flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* The report keeps its own line breaks but WRAPS: a report is read line by
   line, and horizontal scrolling makes the reader drag sideways to finish a
   sentence. 'pre-wrap' preserves the report's own newlines and its leading
   indentation while letting long lines flow.

   Lines are separate elements because the tone is per line. The tones are not
   decoration: a report is scanned for the one line that says what is broken,
   and one flat colour is what made every line look alike. 'warn' is a line the
   report marked WARN, 'bad' is a thing that is actually broken (a seam that
   failed, a key accepted but not pinned, a store that could not be read). */
.sshwsp-report-body { display: block; box-sizing: border-box; width: 100%; min-height: 360px; max-height: 60vh; margin: 0; padding: 14px 18px; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; background: var(--sshwsp-surface); color: var(--sshwsp-text); border: 0; font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; overflow-y: auto; overflow-x: hidden; }
.sshwsp-report-body:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: -2px; }
.sshwsp-report-line { min-height: 1.55em; }
.sshwsp-report-line-head { color: var(--sshwsp-text); font-weight: 600; }
.sshwsp-report-line-warn { color: var(--sshwsp-warn); }
.sshwsp-report-line-bad { color: var(--sshwsp-danger); font-weight: 500; }
.sshwsp-report-line-unknown { color: var(--sshwsp-muted); }
.sshwsp-report-line-ok { color: var(--sshwsp-success); }
.sshwsp-dialog-footer { padding: 12px 20px; border-top: 1px solid var(--sshwsp-border-strong); display: flex; justify-content: flex-end; gap: 8px; }
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
.sshwsp-field-label { font-size: var(--sshwsp-font-xs); color: var(--sshwsp-muted); }
.sshwsp-field-hint { font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); }
.sshwsp-check { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; }
.sshwsp-check-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sshwsp-check input[type="checkbox"] { flex: 0 0 auto; width: 16px; height: 16px; margin: 0; accent-color: var(--sshwsp-accent); cursor: pointer; }
.sshwsp-input { background: var(--sshwsp-surface); border: 1px solid var(--sshwsp-border-strong); border-radius: var(--sshwsp-radius-sm); color: var(--sshwsp-text); padding: 6px 10px; font-size: var(--sshwsp-font-sm); font-family: inherit; width: 100%; box-sizing: border-box; }
.sshwsp-input:focus { outline: none; border-color: var(--sshwsp-accent); }
.sshwsp-input:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--sshwsp-accent) 30%, transparent); }
.sshwsp-select { cursor: pointer; }
.sshwsp-dlg-head { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--sshwsp-border-strong); }
.sshwsp-dlg-head h2 { flex: 1; margin: 0; font-size: var(--sshwsp-font-md); font-weight: 600; }
.sshwsp-icon-btn { background: none; border: 1px solid transparent; color: var(--sshwsp-muted); border-radius: var(--sshwsp-radius-sm); padding: 5px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 120ms ease-out, transform 100ms ease-out; }
.sshwsp-icon-btn:hover { background: var(--sshwsp-hover); color: var(--sshwsp-text); }
.sshwsp-icon-btn:active:not(:disabled) { transform: scale(0.94); }
.sshwsp-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* The row menu, drawn by this plugin — the only renderer there is.
   The numbers below are copied from the Host's own context menu rather than
   chosen here: 4px sheet padding, 34px rows with 6px 8px padding at 13px/20px,
   a 12px item radius inside a 16px sheet, a .5px divider inset by 8px, and a
   sheet as wide as its longest label between 144px and 360px. That is
   deliberate: the gesture exists in both trees, so the menu should read as part
   of the same product, and matching the Host's metrics is what keeps a
   right-click from answering with two different-looking menus.
   It carries one line per item. It used to carry a second description line per
   action (the full path, the overwrite policy), which made a five-item menu read
   like a settings page and pushed it past six items once rename/delete arrived.
   A row already names the file it belongs to, so the path was repeating the row,
   not explaining the action. The add-workspace chooser is the one menu that
   keeps descriptions — they are its reason to exist — under the roomy modifier
   below. */
.sshwsp-flowmenu { position: fixed; z-index: var(--sshwsp-z-menu); width: max-content; min-width: min(144px, calc(100vw - 24px)); max-width: min(360px, calc(100vw - 24px)); box-sizing: border-box; background: var(--sshwsp-surface-3); border: 1px solid var(--sshwsp-border); border-radius: var(--sshwsp-radius-lg); box-shadow: var(--sshwsp-shadow); padding: 4px; animation: sshwsp-menu-in 120ms ease-out; }
.sshwsp-menuitem { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; box-sizing: border-box; padding: 6px 8px; border: none; border-radius: var(--sshwsp-radius-md); background: none; color: var(--sshwsp-text); font: inherit; font-size: var(--sshwsp-font-sm); line-height: 20px; text-align: left; cursor: pointer; }
.sshwsp-menuitem:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: -2px; }
.sshwsp-tabtip { position: fixed; z-index: var(--sshwsp-z-menu); box-sizing: border-box; max-width: min(560px, calc(100vw - 16px)); padding: 5px 9px; border-radius: var(--sshwsp-radius-sm); border: 1px solid var(--sshwsp-border); background: var(--sshwsp-surface-3); color: var(--sshwsp-text); box-shadow: var(--sshwsp-shadow); font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); line-height: 1.45; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; pointer-events: none; }
/* \`:not(:disabled)\` because the Host's own rule has it: a disabled item must not
   light up under the pointer either, or the row says "clickable" while its
   cursor says otherwise. */
.sshwsp-menuitem:hover:not(:disabled) { background: var(--sshwsp-hover); }
.sshwsp-menuitem:disabled { opacity: 0.4; cursor: not-allowed; }
.sshwsp-menuitem-icon { display: inline-flex; align-self: center; align-items: center; justify-content: center; width: 14px; height: 14px; color: var(--sshwsp-menu-icon); flex-shrink: 0; }
.sshwsp-menuitem-icon svg { width: 14px; height: 14px; }
/* One line, ellipsised at the sheet's 360px ceiling — the Host's own label does
   exactly this, and wrapping instead would make a long item grow the sheet
   taller than the menu it replaces. */
.sshwsp-menuitem-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-menuitem-title { display: block; font-size: var(--sshwsp-font-sm); color: inherit; }
.sshwsp-menuitem-desc { display: block; font-size: var(--sshwsp-font-xs); color: var(--sshwsp-muted); margin-top: 2px; line-height: 1.45; overflow-wrap: anywhere; }
/* Roomier variant: the add-workspace chooser. Descriptions are its whole point,
   so it trades the Host's single-line geometry for two lines: a wrapping label
   with the description under it, and a fixed 250px sheet rather than a
   content-sized one. */
.sshwsp-flowmenu-roomy { width: 250px; max-width: none; padding: 5px; }
.sshwsp-flowmenu-roomy .sshwsp-menuitem { align-items: flex-start; gap: 10px; min-height: 0; padding: 9px 10px; }
.sshwsp-flowmenu-roomy .sshwsp-menuitem-text { overflow: visible; white-space: normal; }
.sshwsp-flowmenu-roomy .sshwsp-menuitem-title { font-weight: 500; }
.sshwsp-menusep { height: 0.5px; margin: 3px 8px; background: var(--sshwsp-border); }
.sshwsp-fileaction { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border: 1px solid var(--sshwsp-border); border-radius: var(--sshwsp-radius-sm); background: transparent; color: var(--sshwsp-muted); font: inherit; font-size: var(--sshwsp-font-xs); line-height: 1; white-space: nowrap; cursor: pointer; }
.sshwsp-fileaction:hover { background: var(--sshwsp-hover); color: var(--sshwsp-text); }
.sshwsp-fileaction:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: var(--sshwsp-focus-offset); }
.sshwsp-fileaction:disabled { opacity: 0.5; cursor: not-allowed; }
/* A file the editor refuses keeps the pencil, so the action still reads as "edit
   this" rather than vanishing; the red dot is the refusal, and the tooltip (the
   button's own title) is the reason. The dot must not become a second hit
   target: it is decoration over the icon, so the whole button answers hover and
   clicks exactly as an editable one does. The ring is the header background, so
   the dot keeps its shape on any surface instead of looking like a smudge. */
.sshwsp-fileaction-edit { position: relative; }
.sshwsp-fileaction-blocked { opacity: 0.7; cursor: help; }
.sshwsp-fileaction-blocked:hover { opacity: 1; }
.sshwsp-fileaction-dot { position: absolute; top: 1px; right: 1px; width: 6px; height: 6px; border-radius: var(--sshwsp-radius-round); background: var(--sshwsp-danger); box-shadow: 0 0 0 1.5px var(--sshwsp-surface-2); pointer-events: none; }
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
.sshwsp-fileaction-queue { gap: 0; padding: 0 6px; color: var(--sshwsp-text); }
.sshwsp-fileaction-queue-active { color: var(--sshwsp-accent); border-color: color-mix(in srgb, var(--sshwsp-accent) 40%, transparent); }
.sshwsp-fileaction-queue-active:hover { color: var(--sshwsp-accent); }
/* The popover's backdrop is deliberately transparent: this panel is anchored
   to a button, not a decision that should dim the page. It still covers the
   viewport so a click outside closes what the click opened. */
.sshwsp-popbackdrop { position: fixed; inset: 0; z-index: var(--sshwsp-z-mask); }
.sshwsp-queuepanel { position: fixed; z-index: var(--sshwsp-z-dialog); width: 400px; max-width: calc(100vw - 16px); max-height: 320px; display: flex; flex-direction: column; box-sizing: border-box; background: var(--sshwsp-surface-3); border: 1px solid var(--sshwsp-border); border-radius: var(--sshwsp-radius-lg); box-shadow: var(--sshwsp-shadow); animation: sshwsp-menu-in 120ms ease-out; }
.sshwsp-queue-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--sshwsp-border-subtle); }
.sshwsp-queue-title { flex: 1; font-size: var(--sshwsp-font-sm); font-weight: 600; }
.sshwsp-queue-list { overflow-y: auto; min-height: 0; flex: 1; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-queue-foot { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--sshwsp-border-subtle); }
.sshwsp-queue-foot .sshwsp-entry-meta { flex: 1; line-height: 1.4; }
.sshwsp-queuerow { display: flex; align-items: flex-start; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--sshwsp-border-subtle); font-size: var(--sshwsp-font-xs); line-height: 1.45; }
.sshwsp-queuerow:last-child { border-bottom: none; }
.sshwsp-queuerow-failed { background: color-mix(in srgb, var(--sshwsp-danger) 6%, transparent); }
.sshwsp-queueicon { flex: 0 0 auto; display: inline-flex; align-items: center; width: 16px; color: var(--sshwsp-muted); }
.sshwsp-queueicon-active { color: var(--sshwsp-accent); }
.sshwsp-queuebody { flex: 1; min-width: 0; }
.sshwsp-queue-line { display: flex; align-items: baseline; gap: 8px; }
.sshwsp-queuename { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-queuemeta { flex: 0 0 auto; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); font-family: var(--sshwsp-mono); font-variant-numeric: tabular-nums; }
.sshwsp-queueerror { margin-top: 2px; color: var(--sshwsp-danger); font-size: var(--sshwsp-font-2xs); line-height: 1.4; overflow-wrap: anywhere; }
.sshwsp-queuenote { margin-top: 2px; color: var(--sshwsp-muted); font-size: var(--sshwsp-font-2xs); line-height: 1.4; overflow-wrap: anywhere; }
/* The download mark inside its ring: the tray arrow carries the verb
   ("download"), the ring carries the distance. One control, two readings — a
   percentage-only ring would lose the verb and a bare icon would lose the
   progress, which is the same pairing the reference toolbar shows. The grey
   track belongs to the same hue family as the blue arc and as the row's own
   bar, so one transfer never presents two competing meters. */
.sshwsp-dlring { display: inline-flex; }
.sshwsp-dlring-active { color: var(--sshwsp-accent); }
.sshwsp-dlring-track { stroke: color-mix(in srgb, var(--sshwsp-faint) 55%, transparent); }
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
.sshwsp-queuebar { position: relative; height: 3px; margin-top: 5px; border-radius: var(--sshwsp-radius-xs); overflow: hidden; background: color-mix(in srgb, var(--sshwsp-accent) 12%, transparent); }
.sshwsp-queuebar-fill { height: 100%; width: 0; border-radius: inherit; background: color-mix(in srgb, var(--sshwsp-accent) 78%, transparent); transition: width 160ms ease-out; }
/* No total: sweep the fill across the track. A determinate bar at an invented
   width is indistinguishable from a stuck one, which is exactly the reading
   this row must not invite. */
.sshwsp-queuebar-live .sshwsp-queuebar-fill { width: 38%; animation: sshwsp-queuebar-sweep 1.3s ease-in-out infinite; }
@keyframes sshwsp-queuebar-sweep { from { transform: translateX(-105%); } to { transform: translateX(285%); } }
/* Settled without success: the bar stops asserting a direction. The row's own
   state text is the fact; the fill only says how far the bytes got. */
.sshwsp-queuerow-failed .sshwsp-queuebar-fill, .sshwsp-queuerow-cancelled .sshwsp-queuebar-fill { background: color-mix(in srgb, var(--sshwsp-faint) 55%, transparent); }
@media (prefers-reduced-motion: reduce) {
  .sshwsp-queuebar-live .sshwsp-queuebar-fill { animation: none; width: 60%; opacity: 0.7; }
  .sshwsp-queuebar-fill { transition: none; }
  .sshwsp-dlring-live .sshwsp-dlring-arc { animation: none; }
}
.sshwsp-pathbar { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border: 1px solid var(--sshwsp-border-strong); border-radius: var(--sshwsp-radius-sm); background: var(--sshwsp-surface); }
/* This path started life as a read-only DISPLAY (secondary colour, code font,
   RTL so the tail of a long path stayed visible) and kept that look after it
   became the working-directory INPUT — grey 12px monospace next to the host
   picker's normal text, which reads as "disabled". It is a primary field now,
   so it wears the same typography and colour as .sshwsp-input; the RTL trick is
   gone because an editable field must keep logical order (see the
   .sshwsp-pathbar-path.sshwsp-path-input rule). */
.sshwsp-pathbar-path { flex: 1; min-width: 0; font-family: inherit; font-size: var(--sshwsp-font-sm); color: var(--sshwsp-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.sshwsp-warn { color: var(--sshwsp-danger); font-size: var(--sshwsp-font-xs); line-height: 1.5; padding: 0 20px 12px; }
/* Same single-scrollport rule as .sshwsp-browser-list: this list is the tail
   of a form that lives in the dialog body, so it must grow and let the body
   scroll instead of scrolling inside a box the body then clips. */
/* Same contract as .sshwsp-browser-list: the rows are the dialog's scrollport
   and the form above them does not move. */
.sshwsp-dirlist { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--sshwsp-border-subtle); scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-dirlist-hint { flex: 0 0 auto; padding: 8px 20px 6px; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); }
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
.sshwsp-cr-history { display: flex; flex-direction: column; flex: 0 0 auto; min-height: 0; max-height: 45%; border-top: 1px solid var(--sshwsp-border); }
.sshwsp-cr-history-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 4px; }
.sshwsp-cr-history-title { flex: 1; min-width: 0; margin: 0; font-size: var(--sshwsp-font-xs); font-weight: 500; letter-spacing: 0.02em; color: var(--sshwsp-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The title row is the fold control: one button inside the heading, so Enter and
   Space come from the platform and aria-expanded describes the state. The
   chevron rotates instead of swapping glyphs — one mark for two states, and the
   rotation is what tells the user which way the content is about to move. */
.sshwsp-cr-history-toggle { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; margin: 0; padding: 0; border: none; border-radius: var(--sshwsp-radius-xs); background: transparent; color: inherit; font: inherit; letter-spacing: inherit; cursor: pointer; }
.sshwsp-cr-history-toggle:hover { color: var(--sshwsp-text); }
.sshwsp-cr-history-toggle:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: var(--sshwsp-focus-offset); }
.sshwsp-cr-history-toggletext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-cr-history-chevron { flex: 0 0 auto; color: var(--sshwsp-faint); transition: transform 120ms ease; }
.sshwsp-cr-history-toggle[aria-expanded="false"] .sshwsp-cr-history-chevron { transform: rotate(-90deg); }
.sshwsp-cr-history-note { flex: 0 0 auto; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); font-variant-numeric: tabular-nums; }
.sshwsp-cr-history-refresh { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--sshwsp-radius-xs); background: transparent; color: var(--sshwsp-faint); cursor: pointer; }
.sshwsp-cr-history-refresh:hover { background: var(--sshwsp-hover); color: var(--sshwsp-text); }
.sshwsp-cr-history-refresh:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: var(--sshwsp-focus-offset); }
.sshwsp-cr-history-refresh:disabled { opacity: 0.5; cursor: default; }
/* One grey line for loading, empty, not-a-repository and failure. No red and
   no toast: the upper panel is the tab's business, and this strip must never
   look like a failing operation the user has to act on. */
.sshwsp-cr-history-state { margin: 0; padding: 4px 12px 10px; font-size: var(--sshwsp-font-xs); line-height: 18px; color: var(--sshwsp-faint); overflow-wrap: anywhere; }
.sshwsp-cr-history-list { flex: 1; min-height: 0; margin: 0; padding: 0 12px 10px; overflow-y: auto; list-style: none; display: flex; flex-direction: column; gap: 2px; font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); line-height: 18px; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-cr-commit { display: grid; grid-template-columns: minmax(56px, max-content) minmax(0, 1fr); column-gap: 8px; padding: 2px 4px; border-radius: var(--sshwsp-radius-xs); }
.sshwsp-cr-commit:hover { background: var(--sshwsp-hover); }
.sshwsp-cr-commit-sha { color: var(--sshwsp-faint); font-variant-numeric: tabular-nums; }
.sshwsp-cr-commit-subject { min-width: 0; color: var(--sshwsp-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-cr-commit-meta { grid-column: 2; min-width: 0; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .sshwsp-toast, .sshwsp-flowmenu, .sshwsp-queuepanel, .sshwsp-dialog, .sshwsp-backdrop { animation: none; }
  .sshwsp-btn, .sshwsp-icon-btn, .sshwsp-entry { transition: none; }
  .sshwsp-cr-history-chevron { transition: none; }
  .sshwsp-docmode { transition: none; }
}
/* ---- narrow panel ------------------------------------------------------
   The panel lives in a sidebar the user can drag narrow. Below ~420px the
   host card stops being a row: the action buttons no longer fit beside the
   alias, and wrapping them keeps the card one line taller than it needs to
   be while the title still has room. Below ~320px even that is tight, so the
   padding gives way too — the same trade the height queries make, in the
   other axis. A container query, not a media query: the WINDOW can be wide
   while the panel is narrow, and the panel is what has to reflow. */
/* The container is .sshwsp itself, so nothing here may style .sshwsp:
   a container query only reaches DESCENDANTS of the container. The padding
   therefore stays put and the rows give way instead — which is the right
   order anyway, since padding is the one thing that makes a narrow panel
   readable. */
@container sshwsp-panel (width < 420px) {
  .sshwsp-host { gap: 8px; }
  .sshwsp-host-actions { flex: 1 0 100%; justify-content: flex-start; }
  .sshwsp-host-alias { font-size: var(--sshwsp-font-sm); }
  .sshwsp-section-head { flex-wrap: wrap; }
}
@container sshwsp-panel (width < 320px) {
  .sshwsp-card { padding: 10px 12px; }
  .sshwsp-host-meta { flex-wrap: wrap; }
  .sshwsp-forward-row { flex-wrap: wrap; }
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
  /* What the code area sits on. The editor's gutter paints this so that a long
     line scrolling under the pinned line numbers cannot show through them. */
  --sshwsp-gutter-bg: var(--sshwsp-surface);
  position: fixed;
  z-index: var(--sshwsp-z-overlay);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 8px 10px 10px;
  border: 1px solid var(--sshwsp-border);
  border-radius: var(--sshwsp-radius-sm);
  background: var(--sshwsp-surface);
  box-shadow: var(--sshwsp-shadow);
  /* The measured rect is in viewport pixels; without this the border and the
     padding would add to it and the box would overhang the pane. */
  overflow: hidden;
}
.sshwsp-editor-head { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; padding-bottom: 6px; }
/* The strip of open files. It scrolls sideways rather than wrapping: a second
   row of tabs would move the text down by a whole line every time another file
   opens, and a line that moves while you read is worse than a hidden tab. */
.sshwsp-editor-tabs { flex: 0 0 auto; display: flex; align-items: stretch; gap: 2px; margin: 0 0 6px; border-bottom: 1px solid var(--sshwsp-border); overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-editor-tab { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; max-width: 200px; padding: 0 2px 0 8px; border: 1px solid transparent; border-bottom: none; border-radius: var(--sshwsp-radius-tab); }
.sshwsp-editor-tab-active { background: var(--sshwsp-surface-2); border-color: var(--sshwsp-border); }
.sshwsp-editor-tab-name { min-width: 0; max-width: 170px; padding: 4px 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; background: none; color: var(--sshwsp-muted); font: inherit; font-size: var(--sshwsp-font-xs); cursor: pointer; }
.sshwsp-editor-tab-name:hover { color: var(--sshwsp-text); }
.sshwsp-editor-tab-active .sshwsp-editor-tab-name { color: var(--sshwsp-text); }
.sshwsp-editor-tab-name:focus-visible, .sshwsp-editor-tab-close:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: -2px; }
.sshwsp-editor-tab-dirty { flex: 0 0 auto; width: 6px; height: 6px; border-radius: var(--sshwsp-radius-round); background: var(--sshwsp-warn-text); }
.sshwsp-editor-tab-close { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: var(--sshwsp-radius-xs); background: none; color: var(--sshwsp-faint); cursor: pointer; }
.sshwsp-editor-tab-close:hover { background: var(--sshwsp-surface-2); color: var(--sshwsp-text); }
.sshwsp-editor-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: var(--sshwsp-font-xs); font-weight: 600; color: var(--sshwsp-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-editor-dirty { flex: 0 0 auto; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-warn-text); font-variant-numeric: tabular-nums; }
.sshwsp-editor-notice { flex: 0 0 auto; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-muted); }
/* One row above the text, so the count and the box never cover a line. */
.sshwsp-editor-find { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 0 0 8px; }
.sshwsp-editor-find-input { flex: 1 1 auto; min-width: 0; height: 24px; padding: 0 8px; border-radius: var(--sshwsp-radius-sm); border: 1px solid var(--sshwsp-border); background: var(--sshwsp-surface); color: var(--sshwsp-text); font-size: var(--sshwsp-font-xs); outline: none; }
.sshwsp-editor-find-input:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: -2px; }
/* Fixed width so the buttons beside it do not shift as the number grows. */
.sshwsp-editor-find-count { flex: 0 0 auto; min-width: 5ch; text-align: right; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); font-variant-numeric: tabular-nums; }
.sshwsp-editor-find-case[aria-pressed="true"] { color: var(--sshwsp-accent); background: var(--sshwsp-surface-2); }
.sshwsp-editor-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.sshwsp-editor-warn { flex: 0 0 auto; margin: 0 0 8px; padding: 6px 10px; border-radius: var(--sshwsp-radius-sm); font-size: var(--sshwsp-font-xs); background: var(--sshwsp-warn-soft); color: var(--sshwsp-warn-text); }
.sshwsp-editor-code { flex: 1 1 auto; min-height: 0; display: flex; gap: 0; border: 1px solid var(--sshwsp-border); border-radius: var(--sshwsp-radius-sm); overflow: hidden; background: var(--sshwsp-surface); }
/* The gutter is a <pre> so it keeps the textarea's line height and its own
   scroll position can be driven from the textarea. It never scrolls on its
   own (overflow hidden) — two scroll ports desynchronise the moment a wheel
   event lands on the wrong one. */
.sshwsp-editor-gutter { flex: 0 0 auto; margin: 0; padding: 8px 6px; overflow: hidden; text-align: right; color: var(--sshwsp-faint); background: var(--sshwsp-surface-2); font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); line-height: 18px; font-variant-numeric: tabular-nums; user-select: none; }
.sshwsp-editor-area { position: relative; z-index: var(--sshwsp-z-raised); flex: 1 1 auto; min-width: 0; min-height: 0; margin: 0; padding: 8px 10px; border: none; outline: none; resize: none; overflow: auto; background: transparent; color: var(--sshwsp-text); font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); line-height: 18px; white-space: pre; tab-size: 2; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-editor-area-wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.sshwsp-editor-area:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: -2px; }
/* The colour layer lives in the same box as the textarea, one stacking level
   below it. It is NOT a second scroll port: the layer clips and is translated
   by the textarea's own scroll offset, so "the textarea is the only scroller"
   stays true. */
.sshwsp-editor-area-box { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; }
.sshwsp-editor-hl { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: var(--sshwsp-z-base); }
.sshwsp-editor-hl-shift { position: absolute; left: 10px; top: 8px; }
/* The CodeMirror host: it replaces the gutter + textarea pair when the engine
   loads, and it has to be the only scroller there, exactly like the textarea it
   stands in for — hence min-height: 0 and a flex child that may shrink. */
.sshwsp-editor-cm { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; position: relative; }
.sshwsp-editor-cm > .cm-editor { flex: 1 1 auto; min-width: 0; min-height: 0; }
/* These metrics MUST match .sshwsp-editor-area exactly — font, size, line
   height, tab size and origin — or the coloured glyphs ghost against the
   transparent ones. file-editor-smoke compares the two rules so a change to
   one cannot silently skip the other. */
.sshwsp-editor-hl-line { height: 18px; margin: 0; padding: 0; border: 0; white-space: pre; overflow: visible; font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); line-height: 18px; tab-size: 2; color: var(--sshwsp-text); }
/* One variable per token type, so a skin retunes the palette without touching
   the tokenizer. Defaults are for the plugin's dark surface; the light blocks
   below carry the same set, keyed to the host's own theme marker with an OS
   fallback for hosts that publish none. Declared on the PANEL, not on the
   highlight layer, so the CodeMirror engine (a sibling of that layer) inherits
   the same palette instead of growing a second theme. */
.sshwsp-editor-panel {
  --sshwsp-hl-comment: #828b94;
  --sshwsp-hl-keyword: #c586c0;
  --sshwsp-hl-string: #ce9178;
  --sshwsp-hl-number: #b5cea8;
  --sshwsp-hl-constant: #569cd6;
  --sshwsp-hl-type: #4ec9b0;
  --sshwsp-hl-fn: #dcdcaa;
  --sshwsp-hl-prop: #9cdcfe;
  --sshwsp-hl-strong: #d7ba7d;
  --sshwsp-hl-emphasis: #d7ba7d;
  --sshwsp-hl-link: #4aa3ff;
}
.sshwsp-hl-comment { color: var(--sshwsp-hl-comment); font-style: italic; }
.sshwsp-hl-keyword { color: var(--sshwsp-hl-keyword); }
.sshwsp-hl-string { color: var(--sshwsp-hl-string); }
.sshwsp-hl-number { color: var(--sshwsp-hl-number); }
.sshwsp-hl-constant { color: var(--sshwsp-hl-constant); }
.sshwsp-hl-type { color: var(--sshwsp-hl-type); }
.sshwsp-hl-fn { color: var(--sshwsp-hl-fn); }
.sshwsp-hl-prop { color: var(--sshwsp-hl-prop); }
.sshwsp-hl-strong { color: var(--sshwsp-hl-strong); font-weight: 600; }
.sshwsp-hl-emphasis { color: var(--sshwsp-hl-emphasis); font-style: italic; }
.sshwsp-hl-link { color: var(--sshwsp-hl-link); text-decoration: underline; }
/* One palette, the markers the host actually publishes, and a fallback for a
   host that publishes none.

   DSH projects the resolved theme onto the document: color-scheme on the root
   element, data-ds-theme-source="light|dark|system" (the PREFERENCE, not the
   OS) and data-ds-dark-theme on <body> only in dark mode. The distinction
   matters: a dark app on a light desktop is common, so keying the palette off
   prefers-color-scheme alone would paint light colours onto a dark surface.
   The light palette therefore needs an explicit "light" preference, or
   "system" on a light desktop — and the plain data-theme marker stays for
   hosts that use it instead. The declarations repeat because CSS has no way to
   share one block between two conditions. */
[data-ds-theme-source="light"] .sshwsp-editor-panel,
[data-theme="light"] .sshwsp-editor-panel {
  --sshwsp-hl-comment: #6a737d;
  --sshwsp-hl-keyword: #a626a4;
  --sshwsp-hl-string: #3f7f3e;
  --sshwsp-hl-number: #986801;
  --sshwsp-hl-constant: #016b9f;
  --sshwsp-hl-type: #9a6700;
  --sshwsp-hl-fn: #315fd0;
  --sshwsp-hl-prop: #c0392b;
  --sshwsp-hl-strong: #986801;
  --sshwsp-hl-emphasis: #986801;
  --sshwsp-hl-link: #315fd0;
}
@media (prefers-color-scheme: light) {
  [data-ds-theme-source="system"] .sshwsp-editor-panel,
  html:not([data-ds-theme-source]):not([data-theme]) .sshwsp-editor-panel {
    --sshwsp-hl-comment: #6a737d;
    --sshwsp-hl-keyword: #a626a4;
    --sshwsp-hl-string: #3f7f3e;
    --sshwsp-hl-number: #986801;
    --sshwsp-hl-constant: #016b9f;
    --sshwsp-hl-type: #9a6700;
    --sshwsp-hl-fn: #315fd0;
    --sshwsp-hl-prop: #c0392b;
    --sshwsp-hl-strong: #986801;
    --sshwsp-hl-emphasis: #986801;
    --sshwsp-hl-link: #315fd0;
  }
}
/* While the layer paints, the textarea's own glyphs must go — otherwise every
   character is drawn twice, one colour on top of another. The caret is named
   explicitly because caret-color defaults to color; the selection is
   translucent on purpose, or it would hide the coloured text underneath. */
.sshwsp-editor-area-box-hl .sshwsp-editor-area { color: transparent; caret-color: var(--sshwsp-text); }
.sshwsp-editor-area-box-hl .sshwsp-editor-area::selection { background: var(--sshwsp-selection); color: transparent; }
.sshwsp-editor-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding-top: 10px; }
.sshwsp-editor-meta { font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-faint); font-variant-numeric: tabular-nums; }
.sshwsp-editor-eol {
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--sshwsp-radius-xs);
  color: inherit;
  font: inherit;
  font-size: var(--sshwsp-font-2xs);
  padding: 0 2px;
  cursor: pointer;
}
.sshwsp-editor-eol:hover { border-color: var(--sshwsp-border-strong); }
.sshwsp-editor-eol:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: 1px; }
.sshwsp-editor-spacer { flex: 1 1 auto; }
.sshwsp-editor-state { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 8px; color: var(--sshwsp-muted); font-size: var(--sshwsp-font-sm); }
.sshwsp-editor-state-error { color: var(--sshwsp-danger-text); }
.sshwsp-editor-detail { margin: 0; font-size: var(--sshwsp-font-xs); color: var(--sshwsp-faint); overflow-wrap: anywhere; }
.sshwsp-editor-conflict { flex: 0 0 auto; margin-bottom: 10px; padding: 10px 12px; border-radius: var(--sshwsp-radius-sm); background: var(--sshwsp-warn-soft); }
.sshwsp-editor-conflict-title { margin: 0 0 4px; font-size: var(--sshwsp-font-sm); font-weight: 600; color: var(--sshwsp-warn-text); }
.sshwsp-editor-conflict-confirm { margin: 8px 0 0; font-size: var(--sshwsp-font-xs); color: var(--sshwsp-text); }
.sshwsp-editor-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.sshwsp-editor-pager-area { border: 1px solid var(--sshwsp-border); padding: 8px 10px; resize: none; }
.sshwsp-editor-pager-count { font-size: var(--sshwsp-font-xs); color: var(--sshwsp-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
/* The header action shares the .sshwsp-fileaction geometry with the queue
   entry beside it, so the two sit on one baseline in the preview header. */
.sshwsp-fileaction-edit:disabled { opacity: 0.4; cursor: default; }
/* ---- file view: the conversation tab a clicked tree file opens in. The host
   renders this INSIDE the conversation view area, so it owns the column — and
   its height is set by client.js to end where the composer band begins. */
/* The file view is the tab's CONTENT, not a layer over the conversation: it
   keeps the host's own background so the area it occupies reads as part of the
   app instead of a floating pane. Only the two hairlines around the header and
   the footer are ours. */
.sshwsp-tokens { }
.sshwsp-filepane { flex: 1 1 auto; display: flex; flex-direction: column; box-sizing: border-box; width: 100%; height: 100%; min-height: 0; background: transparent; font-family: var(--sshwsp-font); color: var(--sshwsp-text); }
.sshwsp-filepane-body { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
/* The composer seat is the host's, and only an inline file view ever wants it
   gone (a file gets the whole column). The attribute is put on the seat by
   client.js — the rule keys on it instead of on a host class name, which the
   host renames freely. */
[data-sshwsp-composer-off] { display: none !important; }

/* ---- inline editor (the conversation file tab) -------------------------
   Same component, different shell: in the conversation the panel is the tab's
   content, so it is laid out in flow and fills the view area. Fixed position,
   the measured box, the border, the radius and the shadow all belong to the
   sidebar overlay and are switched off here — with them on, the editor reads
   as a layer hovering over the conversation rather than as the tab. */
.sshwsp-editor-panel-inline {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: var(--sshwsp-radius-none);
  background: transparent;
  box-shadow: none;
  overflow: hidden;
}
.sshwsp-editor-panel-inline .sshwsp-editor-head { padding: 6px 14px; border-bottom: 1px solid var(--sshwsp-border); }
.sshwsp-editor-panel-inline .sshwsp-editor-find { padding: 6px 14px; }
.sshwsp-editor-panel-inline .sshwsp-editor-code { border: 0; border-radius: var(--sshwsp-radius-none); background: transparent; }
/* Inline, the code area is transparent over the conversation, so the gutter
   paints the conversation's own base colour instead of the panel's surface. */
.sshwsp-editor-panel-inline { --sshwsp-gutter-bg: var(--sshwsp-bg); }
.sshwsp-editor-panel-inline .sshwsp-editor-warn { margin: 8px 14px 0; }
.sshwsp-editor-panel-inline .sshwsp-editor-foot { padding: 8px 14px 10px; border-top: 1px solid var(--sshwsp-border); }

/* Source and preview are the same file, so they sit in the same column.
   The preview uses the docpane padding (22px) plus the 860px
   reading width — 904px in total. The inline editor is full-bleed by default,
   and the jump between a centred document and an edge-to-edge buffer reads as
   two different applications; these two rules give the buffer the document's
   measure. The editor code box already paints the gutter, so the column is
   applied to the panel, not to the body, to keep the gutter inside it. */
.sshwsp-filepane-body .sshwsp-editor-panel-inline {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1284px;
  margin: 0 auto;
  padding: 0 22px 28px;
  box-sizing: border-box;
}
.sshwsp-filepane-note { padding: 14px; font-size: var(--sshwsp-font-xs); color: var(--sshwsp-muted); font-variant-numeric: tabular-nums; }
.sshwsp-filepane-reason { display: block; margin-top: 6px; color: var(--sshwsp-danger-text); font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); overflow-wrap: anywhere; }
.sshwsp-filepane-error { color: var(--sshwsp-danger-text); }
/* The document mode switch: one hairline bar above the body, in flow. It is the
   only chrome a rendered document gets, so it stays thin and quiet. */
.sshwsp-filepane-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 10px 4px 14px; }
.sshwsp-filepane-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sshwsp-muted); font-size: var(--sshwsp-font-xs); font-family: var(--sshwsp-mono); }
.sshwsp-filepane-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 0; border-radius: var(--sshwsp-radius-xs); background: none; color: var(--sshwsp-muted); font-size: var(--sshwsp-font-md); line-height: 1; cursor: pointer; transition: background 120ms ease-out, color 120ms ease-out; }
.sshwsp-filepane-close:hover { background: var(--sshwsp-hover); color: var(--sshwsp-text); }
.sshwsp-filepane-close:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: 1px; }
.sshwsp-filepane-bar { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; gap: 10px; width: 100%; max-width: 1284px; margin: 0 auto; padding: 6px 22px 4px; box-sizing: border-box; }
.sshwsp-filepane-modehint { min-width: 0; font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-warn-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sshwsp-docmodes { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--sshwsp-border-subtle); border-radius: var(--sshwsp-radius-pill); background: var(--sshwsp-surface-2); }
.sshwsp-docmode { appearance: none; display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border: 0; border-radius: var(--sshwsp-radius-pill); background: none; color: var(--sshwsp-muted); font: inherit; font-size: var(--sshwsp-font-2xs); line-height: 1.4; cursor: pointer; transition: background 120ms ease-out, color 120ms ease-out; }
.sshwsp-docmode:hover:not(.sshwsp-docmode-on):not([aria-disabled="true"]) { background: var(--sshwsp-hover); color: var(--sshwsp-text); }
.sshwsp-docmode-on { background: var(--sshwsp-accent-soft); color: var(--sshwsp-accent); }
.sshwsp-docmode[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.sshwsp-docmode:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: 1px; }
/* ---- rendered document (Markdown preview) ------------------------------
   A reading column, not a full-width dump: lines longer than ~90 characters
   are hard to follow back to the next one. Everything here uses the same
   tokens as the rest of the UI so light and dark come for free. */
.sshwsp-media { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; min-height: 0; padding: 16px; box-sizing: border-box; overflow: auto; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-media img, .sshwsp-media video { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: var(--sshwsp-radius-sm); }
.sshwsp-media audio { width: min(560px, 100%); }
.sshwsp-media-pdf { align-items: stretch; justify-content: stretch; padding: 0; }
.sshwsp-media-pdf embed { width: 100%; height: 100%; min-height: 60vh; border: 0; }
.sshwsp-htmlview { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.sshwsp-htmlview-bar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--sshwsp-border-subtle); }
.sshwsp-htmlview-note { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sshwsp-muted); font-size: var(--sshwsp-font-xs); font-variant-numeric: tabular-nums; }
.sshwsp-htmlview-frame { flex: 1 1 auto; width: 100%; min-height: 0; border: 0; background: var(--sshwsp-html-canvas); }
.sshwsp-docpane { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px 22px 28px; box-sizing: border-box; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-md { max-width: 1240px; margin: 0 auto; color: var(--sshwsp-text); font-size: var(--sshwsp-font-md); line-height: 1.72; overflow-wrap: anywhere; }
.sshwsp-md > *:first-child { margin-top: 0; }
.sshwsp-md h1, .sshwsp-md h2, .sshwsp-md h3, .sshwsp-md h4, .sshwsp-md h5, .sshwsp-md h6 { margin: 32px 0 16px; line-height: 1.4; font-weight: 700; letter-spacing: -0.01em; }
.sshwsp-md h1 { margin-top: 8px; font-size: var(--sshwsp-font-lg); }
.sshwsp-md h2 { font-size: var(--sshwsp-font-lg); }
.sshwsp-md h3 { font-size: var(--sshwsp-font-md); }
.sshwsp-md h4, .sshwsp-md h5, .sshwsp-md h6 { margin: 16px 0 8px; font-size: var(--sshwsp-font-sm); font-weight: 600; }


.sshwsp-md-p { margin: 12px 0; }
.sshwsp-md a.sshwsp-md-link { color: var(--sshwsp-accent); text-decoration: none; }
.sshwsp-md a.sshwsp-md-link:hover { text-decoration: underline; }
.sshwsp-md .sshwsp-md-link-plain { color: var(--sshwsp-muted); }
.sshwsp-md strong { font-weight: 600; color: var(--sshwsp-text); }
.sshwsp-md code { font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-xs); }
.sshwsp-md .sshwsp-md-code-inline { padding: 1px 6px; border-radius: var(--sshwsp-radius-xs); background: var(--sshwsp-md-inline-code); font-size: var(--sshwsp-font-xs); }
.sshwsp-md .sshwsp-md-tok-comment { color: var(--sshwsp-md-tok-comment); font-style: italic; }
.sshwsp-md .sshwsp-md-tok-string { color: var(--sshwsp-md-tok-string); }
.sshwsp-md .sshwsp-md-tok-keyword { color: var(--sshwsp-md-tok-keyword); font-weight: 600; }
.sshwsp-md .sshwsp-md-tok-number { color: var(--sshwsp-md-tok-number); }
.sshwsp-md .sshwsp-md-card { margin: 16px 0; overflow: hidden; border-radius: var(--sshwsp-radius-md); background: var(--sshwsp-md-code-bg); }
.sshwsp-md .sshwsp-md-cardhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px 5px 14px; background: var(--sshwsp-md-code-banner); font-size: var(--sshwsp-font-2xs); color: var(--sshwsp-muted); }
.sshwsp-md .sshwsp-md-cardlang { font-family: var(--sshwsp-mono); letter-spacing: 0.02em; }
.sshwsp-md .sshwsp-md-cardacts { display: inline-flex; align-items: center; gap: 2px; }
.sshwsp-md .sshwsp-md-cardact { appearance: none; border: 0; background: none; color: var(--sshwsp-muted); font: inherit; font-size: var(--sshwsp-font-xs); line-height: 1; padding: 3px 7px; border-radius: var(--sshwsp-radius-xs); cursor: pointer; transition: background 120ms ease-out, color 120ms ease-out; }
.sshwsp-md .sshwsp-md-cardact:hover { background: var(--sshwsp-hover); color: var(--sshwsp-text); }
.sshwsp-md .sshwsp-md-cardact:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: 1px; }
.sshwsp-md .sshwsp-md-pre { margin: 0; padding: 12px 18px 14px; overflow: auto; background: transparent; line-height: 1.72; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-md .sshwsp-md-card-wrap .sshwsp-md-pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.sshwsp-md .sshwsp-md-pre code { font-size: var(--sshwsp-font-2xs); white-space: pre; }
.sshwsp-md .sshwsp-md-front { margin: 0 0 14px; padding: 10px 12px; overflow: auto; border: 1px dashed var(--sshwsp-border-strong); border-radius: var(--sshwsp-radius-sm); background: var(--sshwsp-surface-2); color: var(--sshwsp-faint); font-family: var(--sshwsp-mono); font-size: var(--sshwsp-font-2xs); line-height: 1.5; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-md .sshwsp-md-quote { margin: 16px 0; padding: 2px 0 2px 16px; border-left: 3px solid var(--sshwsp-border-strong); color: var(--sshwsp-muted); }
.sshwsp-md .sshwsp-md-list { margin: 10px 0; padding-left: 22px; }
.sshwsp-md .sshwsp-md-list .sshwsp-md-list { margin: 6px 0; }
.sshwsp-md .sshwsp-md-item { margin: 4px 0; }
.sshwsp-md .sshwsp-md-item > .sshwsp-md-p { margin: 0; }
.sshwsp-md .sshwsp-md-task { list-style: none; position: relative; }
.sshwsp-md .sshwsp-md-task::before { position: absolute; left: -18px; color: var(--sshwsp-muted); content: '☐'; }
.sshwsp-md .sshwsp-md-task[data-checked="true"]::before { content: '☑'; color: var(--sshwsp-success); }
.sshwsp-md .sshwsp-md-task[data-checked="true"] { color: var(--sshwsp-muted); }
.sshwsp-md .sshwsp-md-hr { margin: 20px 0; border: 0; border-top: 1px solid var(--sshwsp-border); }
.sshwsp-md .sshwsp-md-table-wrap { margin: 12px 0; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--sshwsp-track) transparent; }
.sshwsp-md .sshwsp-md-table { width: 100%; border-collapse: collapse; font-size: var(--sshwsp-font-xs); }
.sshwsp-md .sshwsp-md-table th, .sshwsp-md .sshwsp-md-table td { padding: 8px 14px; border: 0; border-bottom: 1px solid var(--sshwsp-border); text-align: left; vertical-align: top; }
.sshwsp-md .sshwsp-md-table th { background: none; font-weight: 600; border-bottom-color: var(--sshwsp-border-strong); }
.sshwsp-md .sshwsp-md-image { display: inline-block; padding: 0 6px; border: 1px dashed var(--sshwsp-border-strong); border-radius: var(--sshwsp-radius-xs); color: var(--sshwsp-faint); font-size: var(--sshwsp-font-2xs); }
/* The two settings controls: a two-state switch (a checkbox cannot express
   "the right-hand tree" as the other answer) and the file-listing box. */
.sshwsp-seg { display: inline-flex; box-sizing: border-box; padding: 2px; gap: 2px; border: 1px solid var(--sshwsp-border-strong); border-radius: var(--sshwsp-radius-sm); background: var(--sshwsp-surface-2); }
.sshwsp-seg-btn { appearance: none; border: none; border-radius: var(--sshwsp-radius-xs); padding: 4px 12px; background: none; color: var(--sshwsp-muted); font: inherit; font-size: var(--sshwsp-font-xs); cursor: pointer; }
.sshwsp-seg-btn:hover:not(:disabled):not(.sshwsp-seg-btn-on) { background: var(--sshwsp-hover); color: var(--sshwsp-text); }
.sshwsp-seg-btn-on { background: var(--sshwsp-accent); color: var(--sshwsp-on-accent); }
.sshwsp-seg-btn:disabled { opacity: 0.6; cursor: default; }
.sshwsp-seg-btn:focus-visible { outline: var(--sshwsp-focus-width) solid var(--sshwsp-accent); outline-offset: 1px; }
.sshwsp-check-stacked { margin-top: 8px; justify-content: flex-start; }
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
