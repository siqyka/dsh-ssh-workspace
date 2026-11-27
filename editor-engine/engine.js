/**
 * The editor engine: CodeMirror 6, bundled into one lazy chunk.
 *
 * This file is NOT shipped as source. `scripts/build-editor-engine.mjs` bundles
 * it into `lib/client/client.editor-engine.js`, which the panel loads with
 * `require.async` the first time a file is opened for editing. Keeping it out of
 * the hand-written client means the plugin's own 730 KB stay hand-written while
 * the one genuinely large dependency arrives as a single file with a single
 * seam: `createEditorEngine`.
 *
 * The seam is deliberately narrow — mount, replace text, change language, wrap,
 * reveal a match, destroy — so the panel keeps owning the parts that must
 * remain this plugin's: the save protocol (version + revision tokens), the
 * conflict flow, the find bar, i18n and the panel chrome. CodeMirror supplies
 * what a textarea cannot: syntax highlighting that survives wrapping, real
 * bracket matching, multi-cursor and a proper undo stack.
 */

import { Annotation, Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { c, cpp } from '@codemirror/legacy-modes/mode/clike'

/** Marks a transaction as coming from the panel, not from the keyboard, so
 *  the change listener does not echo an externally loaded buffer back. */
const External = Annotation.define()

const TYPESCRIPT = new Set(['ts', 'tsx', 'mts', 'cts'])
const JSX = new Set(['jsx', 'tsx'])
const CPP = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh'])

const extensionOf = (path) => {
  const name = String(path ?? '')
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Which CodeMirror language a panel language id maps to.
 *
 * The ids are the ones `languageOfPath` already produces, so the two halves of
 * the plugin cannot drift into using different names for the same syntax. A
 * language the bundle does not carry returns an empty extension: plain text is
 * a correct answer, a guessed grammar is not.
 */
function languageSupport (language, path) {
  switch (language) {
    case 'javascript':
      return javascript({ typescript: TYPESCRIPT.has(extensionOf(path)), jsx: JSX.has(extensionOf(path)) })
    case 'json': return json()
    case 'css': return css()
    case 'markup': return html()
    case 'markdown': return markdown()
    case 'python': return python()
    case 'sql': return sql()
    case 'yaml': return yaml()
    case 'rust': return rust()
    case 'go': return go()
    case 'c-like': return StreamLanguage.define(CPP.has(extensionOf(path)) ? cpp : c)
    case 'shell': return StreamLanguage.define(shell)
    case 'toml': return StreamLanguage.define(toml)
    case 'dockerfile': return StreamLanguage.define(dockerFile)
    case 'make': return StreamLanguage.define(shell)
    default: return []
  }
}

/**
 * Colours come from the same `--sshwsp-hl-*` variables the textarea fallback
 * paints with, so the two editors share one palette (and one light/dark
 * decision) instead of drifting into two themes.
 */
const highlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--sshwsp-hl-comment)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.heading], color: 'var(--sshwsp-hl-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: 'var(--sshwsp-hl-string)' },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--sshwsp-hl-number)' },
  { tag: [tags.bool, tags.null, tags.atom, tags.constant(tags.variableName), tags.constant(tags.propertyName)], color: 'var(--sshwsp-hl-constant)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.variableName)], color: 'var(--sshwsp-hl-type)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--sshwsp-hl-fn)' },
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.propertyName)], color: 'var(--sshwsp-hl-prop)' },
  { tag: tags.link, color: 'var(--sshwsp-hl-link)', textDecoration: 'underline' },
  { tag: tags.strong, color: 'var(--sshwsp-hl-strong)', fontWeight: '600' },
  { tag: tags.emphasis, color: 'var(--sshwsp-hl-emphasis)', fontStyle: 'italic' },
  { tag: tags.meta, color: 'var(--sshwsp-hl-comment)' },
])

/**
 * Metrics are not cosmetic here: the panel is an overlay with a fixed height,
 * and 12/18 matches the textarea fallback line for line, so switching between
 * the two (a chunk that fails to load) does not reflow the text under the user.
 */
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-primary, #e0e0e0)',
    fontSize: '12px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--dsw-font-markdown-code-font-family, monospace)',
    lineHeight: '18px',
    overflow: 'auto',
  },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--dsw-alias-label-primary, #e0e0e0)' },
  '.cm-line': { padding: '0 12px 0 0' },
  '.cm-gutters': {
    // Opaque on purpose: CodeMirror pins the gutters to the left edge while the
    // text scrolls under them, so a see-through gutter lets a long line run
    // straight over the line numbers once word wrap is off. The variable is the
    // surface the code area itself sits on — `--sshwsp-surface` in the right
    // pane, the conversation background for the inline view.
    backgroundColor: 'var(--sshwsp-gutter-bg, transparent)',
    color: 'var(--dsw-alias-label-tertiary, #777)',
    borderRight: 'none',
    paddingLeft: '8px',
  },
  // Room to the right of the digits: at the 2ch floor a three-digit line number
  // already fills the gutter, and with no padding the first character of the
  // line butts against it.
  '.cm-gutterElement': { padding: '0 14px 0 0', minWidth: '2ch' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--dsw-alias-label-secondary, #999)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-label-primary, #e0e0e0)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(74, 158, 255, 0.28)',
  },
})

/**
 * Mount one editor.
 *
 * The caller owns the document (loaded, possibly reloaded, saved with tokens);
 * this object only renders it and reports edits. Every method is intentionally
 * synchronous and side-effect free about the network.
 */
export function createEditorEngine ({ parent, doc, language, path, wrap, onChange, onSave, onFind, onEscape }) {
  const languageCompartment = new Compartment()
  const wrapCompartment = new Compartment()

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        indentOnInput(),
        bracketMatching(),
        EditorState.tabSize.of(2),
        EditorState.allowMultipleSelections.of(true),
        editorTheme,
        syntaxHighlighting(highlightStyle),
        languageCompartment.of(languageSupport(language, path)),
        wrapCompartment.of(wrap === true ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((update) => {
          const external = update.transactions.some((transaction) => transaction.annotation(External) === true)
          if (update.docChanged && !external) onChange(update.state.doc.toString())
        }),
        keymap.of([
          // The panel's keys come FIRST: the defaults below bind Mod-s to
          // nothing useful and Escape to "simplify selection", and either
          // would swallow the gesture the panel promises.
          { key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true } },
          { key: 'Mod-f', preventDefault: true, run: () => { onFind?.(); return true } },
          { key: 'Escape', run: () => { onEscape?.(); return true } },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
      ],
    }),
  })

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue (text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: External.of(true),
      })
    },
    setLanguage (nextLanguage, nextPath) {
      view.dispatch({ effects: languageCompartment.reconfigure(languageSupport(nextLanguage, nextPath)) })
    },
    setWrap (next) {
      view.dispatch({ effects: wrapCompartment.reconfigure(next === true ? EditorView.lineWrapping : []) })
    },
    focus: () => view.focus(),
    /** Select `from..to` and bring it into view. `y: 'center'` matters when the
     *  match is already on screen: the caret may sit under the find bar, and a
     *  plain `nearest` scroll would leave it hidden there. */
    reveal (from, to = from) {
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      })
    },
    selectionText () {
      const { from, to } = view.state.selection.main
      return from === to ? '' : view.state.sliceDoc(from, to)
    },
    collapseSelection () {
      const { to } = view.state.selection.main
      view.dispatch({ selection: { anchor: to } })
    },
    destroy: () => view.destroy(),
  }
}
