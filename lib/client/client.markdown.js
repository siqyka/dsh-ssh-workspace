/**
 * The Markdown reader behind a document's preview, as data plus one renderer.
 *
 * `parseMarkdown` is the half that decides anything: it turns the file's text
 * into Blocks and Inlines, and it is a pure function — no React, no DOM, no
 * clock, no fetch. That is deliberate. A renderer is easy to eyeball and hard to
 * assert on; the parse tree is the opposite, so the interesting rules (what
 * counts as a fence, where a list item ends, which characters survive as text)
 * live where a test can call them directly.
 *
 * What it is NOT: a spec-complete CommonMark implementation. It reads what
 * people put in README files — headings, fences, lists (nested, ordered, task),
 * quotes, tables, rules, links, emphasis, inline code, images-as-placeholders.
 * Raw HTML is escaped rather than interpreted: this runs on files from a remote
 * host, and a preview is not a place to execute what a file embeds. Anything
 * that needs a browser (inlined images from a remote workspace, footnotes with
 * generated ids) degrades to text instead of silently doing nothing.
 */

window.__ModuleLoader__.load({
  id: '@shiqyka/dsh-ssh-workspace',
  chunk: 'client.markdown.js',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')

    // =========================================================================
    // Blocks
    // =========================================================================

    /** ATX heading: 1–3 leading spaces, 1–6 hashes, then a space. */
    const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/u
    /** A closing hash run is decoration, not content: `## Title ##`. */
    const HEADING_TAIL = /[ \t]+#+[ \t]*$/u
    /** Three or more of `*`, `-` or `_`, optionally spaced out. */
    const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u
    /** An opening fence: backticks or tildes, at least three, with an info word. */
    const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`~]*)$/u
    /** Blockquote marker; the optional space after it is not content. */
    const QUOTE = /^ {0,3}>[ \t]?(.*)$/u
    /** Bullet item; the marker's width is measured, not assumed. */
    const BULLET = /^( {0,3})([-*+])[ \t]+(.*)$/u
    /** Ordered item — the delimiter may be `.` or `)`. */
    const ORDERED = /^( {0,3})(\d{1,9})([.)])[ \t]+(.*)$/u
    /** A setext underline turns the paragraph above it into a heading. */
    const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/u
    /** `- [ ]` / `- [x]`, the GitHub task-list prefix inside a list item. */
    const TASK = /^\[([ xX])\][ \t]+(.*)$/u
    /** Table delimiter row: pipes with optional colon-aligned dashes. */
    const DELIMITER = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/u

    /**
     * One leading `---` block, kept verbatim.
     *
     * Frontmatter is YAML, not Markdown, and rendering it as a heading plus a
     * rule turns a metadata block into noise. Showing it verbatim in the same
     * monospace frame as a fence keeps it readable and keeps the body clean.
     */
    function splitFrontmatter (text) {
      const lines = text.split('\n')
      if (lines.length < 3) return { source: null, body: text }
      if (!/^---[ \t]*$/u.test(lines[0] ?? '')) return { source: null, body: text }
      for (let index = 1; index < lines.length; index += 1) {
        if (/^(?:---|\.\.\.)[ \t]*$/u.test(lines[index])) {
          return {
            source: lines.slice(1, index).join('\n'),
            body: lines.slice(index + 1).join('\n'),
          }
        }
      }
      return { source: null, body: text }
    }

    /**
     * Split one line of a table row into cells.
     *
     * The outer pipes are optional in GFM and a trailing `|` does not open a new
     * empty cell, so both ends are trimmed BEFORE splitting — otherwise every
     * row would end with a phantom cell.
     */
    function tableCells (line) {
      let body = line.trim()
      if (body.startsWith('|')) body = body.slice(1)
      if (body.endsWith('|')) body = body.slice(0, -1)
      return body.split('|').map(cell => cell.trim())
    }

    /** Column alignment from a delimiter row, as `'left' | 'center' | 'right'`. */
    function tableAligns (line) {
      return tableCells(line).map((cell) => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return ''
      })
    }

    /** Whether this line opens a table (a header row whose next row is a rule). */
    function opensTable (lines, index) {
      const head = lines[index] ?? ''
      const next = lines[index + 1] ?? ''
      return head.includes('|') && DELIMITER.test(next) && next.includes('-')
    }

    /** Whether this line starts any block, used to end a paragraph. */
    function startsBlock (lines, index) {
      const line = lines[index] ?? ''
      if (line.trim() === '') return true
      return HEADING.test(line) || RULE.test(line) || FENCE.test(line) || QUOTE.test(line) ||
        BULLET.test(line) || ORDERED.test(line) || opensTable(lines, index)
    }

    /**
     * Parse Markdown text into blocks.
     *
     * @param {string} text - the file's contents (any line ending).
     * @returns {{ frontmatter: string|null, blocks: object[] }}
     */
    function parseMarkdown (text) {
      const normalized = String(text ?? '').replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
      const split = splitFrontmatter(normalized)
      const lines = split.body.split('\n')
      const blocks = parseBlocks(lines)
      return { frontmatter: split.source, blocks }
    }

    /** The block loop: one pass per top-level construct, deepest first. */
    function parseBlocks (lines) {
      const blocks = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index] ?? ''
        if (line.trim() === '') { index += 1; continue }

        const fence = FENCE.exec(line)
        if (fence !== null) {
          const marker = fence[1]
          const lang = fence[2].trim().split(/\s+/u)[0] ?? ''
          const body = []
          index += 1
          while (index < lines.length) {
            const current = lines[index] ?? ''
            // A closing fence matches the OPENING character and is at least as
            // long: ``` inside a ```` block is content, not the end.
            if (new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`, 'u').test(current)) {
              index += 1
              break
            }
            body.push(current)
            index += 1
          }
          blocks.push({ type: 'code', lang, text: body.join('\n') })
          continue
        }

        const heading = HEADING.exec(line)
        if (heading !== null) {
          blocks.push({
            type: 'heading',
            level: heading[1].length,
            inline: parseInline(heading[2].replace(HEADING_TAIL, '')),
          })
          index += 1
          continue
        }

        if (RULE.test(line)) {
          blocks.push({ type: 'hr' })
          index += 1
          continue
        }

        if (QUOTE.test(line)) {
          const inner = []
          while (index < lines.length) {
            const match = QUOTE.exec(lines[index] ?? '')
            if (match === null) break
            inner.push(match[1])
            index += 1
          }
          blocks.push({ type: 'quote', blocks: parseBlocks(inner) })
          continue
        }

        if (opensTable(lines, index)) {
          const head = tableCells(line)
          const align = tableAligns(lines[index + 1] ?? '')
          index += 2
          const rows = []
          while (index < lines.length) {
            const row = lines[index] ?? ''
            if (row.trim() === '' || !row.includes('|') || startsBlock(lines, index)) break
            rows.push(tableCells(row))
            index += 1
          }
          blocks.push({
            type: 'table',
            align,
            head: head.map(cell => parseInline(cell)),
            rows: rows.map(row => row.map(cell => parseInline(cell))),
          })
          continue
        }

        const ordered = ORDERED.exec(line)
        const bullet = ordered === null ? BULLET.exec(line) : null
        if (ordered !== null || bullet !== null) {
          const parsed = parseList(lines, index, ordered !== null)
          blocks.push(parsed.block)
          index = parsed.next
          continue
        }

        // Paragraph: run to the next block start, then let setext take it. A
        // line of `=`/`-` is NOT a block start on its own — it only means
        // something as the underline of the paragraph above it.
        const paragraph = []
        while (index < lines.length && !startsBlock(lines, index)) {
          if (paragraph.length > 0 && SETEXT.test(lines[index] ?? '')) break
          paragraph.push(lines[index] ?? '')
          index += 1
        }
        const underline = SETEXT.exec(lines[index] ?? '')
        if (paragraph.length > 0 && underline !== null) {
          blocks.push({
            type: 'heading',
            level: underline[1][0] === '=' ? 1 : 2,
            inline: parseInline(paragraph.join('\n')),
          })
          index += 1
          continue
        }
        if (paragraph.length > 0) {
          blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) })
        }
      }
      return blocks
    }

    /**
     * Parse one list, markers and continuations included.
     *
     * An item's content is everything up to the next marker at the same level;
     * continuation lines are dedented by the item's own content column so a
     * nested list or fence keeps its shape when the item is parsed again.
     */
    function parseList (lines, start, isOrdered) {
      const marker = isOrdered ? ORDERED : BULLET
      const items = []
      let index = start
      // The list's own numbering: only the FIRST item decides it, so `1. 2.`
      // stays 1-based and `3. 4.` starts at 3.
      const firstMatch = marker.exec(lines[start] ?? '')
      const numberStart = isOrdered && firstMatch !== null ? Number(firstMatch[2]) : 1
      while (index < lines.length) {
        const match = marker.exec(lines[index] ?? '')
        if (match === null) break
        const contentColumn = isOrdered ? match[1].length + match[2].length + 2 : match[1].length + 2
        const first = isOrdered ? match[4] : match[3]
        const body = [first]
        index += 1
        while (index < lines.length) {
          const line = lines[index] ?? ''
          if (line.trim() === '') {
            // A blank line continues the item only when the next non-blank line
            // is still part of it (indented content). A blank line before the
            // next marker or before a dedented block ends the item.
            let peek = index
            while (peek < lines.length && (lines[peek] ?? '').trim() === '') peek += 1
            const after = lines[peek] ?? ''
            const afterMarker = marker.exec(after)
            const afterIndent = afterMarker === null ? 0 : afterMarker[1].length
            if (after.trim() === '' || (afterMarker !== null && afterIndent < contentColumn) || !/^\s+/u.test(after)) break
            body.push('')
            index += 1
            continue
          }
          const nested = marker.exec(line)
          if (nested !== null) {
            // A marker indented to (or past) this item's content column is a
            // NESTED list — it stays in the body, dedented, and the recursive
            // parse gives it its own `<ul>`. A marker to the left is a sibling.
            if (nested[1].length < contentColumn) break
            body.push(line.slice(contentColumn))
            index += 1
            continue
          }
          const indent = /^ */u.exec(line)[0].length
          if (indent === 0) break
          body.push(line.slice(Math.min(indent, contentColumn)))
          index += 1
        }
        const task = TASK.exec(body[0] ?? '')
        if (task !== null) body[0] = task[2]
        items.push({
          checked: task === null ? null : task[1].toLowerCase() === 'x',
          blocks: parseBlocks(body),
        })
        // Blank lines between items belong to the list, not to the item.
        let peek = index
        while (peek < lines.length && (lines[peek] ?? '').trim() === '' && marker.test(lines[peek + 1] ?? '')) peek += 1
        index = peek
      }
      return {
        block: { type: 'list', ordered: isOrdered, start: numberStart, items },
        next: index,
      }
    }

    // =========================================================================
    // Inlines
    // =========================================================================

    /**
     * Parse inline Markdown into a flat-ish tree.
     *
     * Kept deliberately small: the delimiters people actually write, resolved
     * left to right, with the inner text parsed again so `**a *b* c**` nests.
     * No delimiter run-length theory — a stray `*` stays a character instead of
     * silently swallowing the rest of the line.
     *
     * @param {string} text - one paragraph, heading or cell, newlines included.
     * @returns {object[]} Inline nodes.
     */
    function parseInline (text) {
      const nodes = []
      let buffer = ''
      const flush = () => {
        if (buffer !== '') {
          nodes.push({ type: 'text', value: buffer })
          buffer = ''
        }
      }
      let index = 0
      const source = String(text ?? '')
      while (index < source.length) {
        const char = source[index]

        if (char === '\\' && index + 1 < source.length && /[\\`*_{}[\]()#+\-.!|>~]/u.test(source[index + 1])) {
          buffer += source[index + 1]
          index += 2
          continue
        }

        // Two trailing spaces are a hard break; a backslash-newline also is.
        if (char === '\n') {
          if (/ {2}$/u.test(buffer) || /\\$/u.test(buffer)) {
            buffer = buffer.replace(/ {2}$/u, '').replace(/\\$/u, '')
            flush()
            nodes.push({ type: 'br' })
            index += 1
            continue
          }
          buffer += ' '
          index += 1
          continue
        }

        if (char === '`') {
          const run = /^`+/u.exec(source.slice(index))[0].length
          const close = source.indexOf('`'.repeat(run), index + run)
          if (close > -1) {
            flush()
            // CommonMark trims one space from each end when both are present.
            let code = source.slice(index + run, close)
            if (/^ .* $/u.test(code)) code = code.slice(1, -1)
            nodes.push({ type: 'code', value: code })
            index = close + run
            continue
          }
          buffer += char
          index += 1
          continue
        }

        if (char === '!' && source[index + 1] === '[') {
          const image = /^!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/u.exec(source.slice(index))
          if (image !== null) {
            flush()
            nodes.push({ type: 'image', alt: image[1], src: image[2] })
            index += image[0].length
            continue
          }
        }

        if (char === '[') {
          const link = /^\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+"([^"]*)")?\s*\)/u.exec(source.slice(index))
          if (link !== null) {
            flush()
            nodes.push({ type: 'link', href: link[2], title: link[3] ?? '', children: parseInline(link[1]) })
            index += link[0].length
            continue
          }
        }

        if (char === '<') {
          const auto = /^<((?:https?|mailto):[^\s>]+|[\w.+-]+@[\w-]+\.[\w.-]+)>/u.exec(source.slice(index))
          if (auto !== null) {
            flush()
            const href = auto[1].includes('@') && !auto[1].includes(':') ? `mailto:${auto[1]}` : auto[1]
            nodes.push({ type: 'link', href, title: '', children: [{ type: 'text', value: auto[1] }] })
            index += auto[0].length
            continue
          }
        }

        if (char === '*' || char === '_' || char === '~') {
          const pair = char === '~' ? '~~' : char + char
          if (source.startsWith(pair, index)) {
            // An underscore inside a word is not emphasis (`snake_case_name`).
            const intraword = char === '_' && /[\p{L}\p{N}]/u.test(source[index - 1] ?? '') &&
              /[\p{L}\p{N}]/u.test(source[index + 2] ?? '')
            const close = intraword ? -1 : source.indexOf(pair, index + pair.length)
            if (close > index + pair.length) {
              flush()
              const kind = char === '~' ? 'del' : 'strong'
              nodes.push({ type: kind, children: parseInline(source.slice(index + pair.length, close)) })
              index = close + pair.length
              continue
            }
          }
          const single = char !== '~' && source[index + 1] !== char
          if (single) {
            const close = source.indexOf(char, index + 1)
            const intraword = char === '_' && /[\p{L}\p{N}]/u.test(source[index - 1] ?? '') &&
              /[\p{L}\p{N}]/u.test(source[index + 1] ?? '')
            if (!intraword && close > index + 1 && source[close + 1] !== char) {
              flush()
              nodes.push({ type: 'em', children: parseInline(source.slice(index + 1, close)) })
              index = close + 1
              continue
            }
          }
        }

        buffer += char
        index += 1
      }
      flush()
      return nodes
    }

    // =========================================================================
    // Links
    // =========================================================================

    /**
     * The URL a preview is allowed to hand to `window.open`, or ''.
     *
     * Anything else — a relative path (this file lives on another machine), a
     * `javascript:` URL (this file is untrusted input), a bare fragment — is not
     * a link here. The text still shows; only the click is dropped.
     */
    function safeHref (href) {
      const value = String(href ?? '').trim()
      if (value === '') return ''
      if (/^(?:https?|mailto):/iu.test(value)) return value
      return ''
    }

    // =========================================================================
    // Rendering
    // =========================================================================

    /**
     * Render parsed inlines.
     *
     * Text nodes carry no key when they are alone in a line, but a mixed run
     * needs stable keys: the array is rebuilt only when the file changes, so the
     * index is a legitimate key here.
     */
    function renderInline (nodes, t) {
      if (!Array.isArray(nodes) || nodes.length === 0) return null
      return nodes.map((node, index) => {
        switch (node.type) {
          case 'text': return node.value
          case 'br': return jsx('br', { key: `i${index}` })
          case 'code': return jsx('code', { key: `i${index}`, className: 'sshwsp-md-code-inline', children: node.value })
          case 'strong': return jsx('strong', { key: `i${index}`, children: renderInline(node.children, t) })
          case 'em': return jsx('em', { key: `i${index}`, children: renderInline(node.children, t) })
          case 'del': return jsx('del', { key: `i${index}`, children: renderInline(node.children, t) })
          case 'image': return jsx('span', {
            key: `i${index}`,
            className: 'sshwsp-md-image',
            title: t('preview.imageRemote'),
            children: node.alt === '' ? t('preview.image') : node.alt,
          })
          case 'link': {
            const href = safeHref(node.href)
            if (href === '') {
              return jsx('span', { key: `i${index}`, className: 'sshwsp-md-link-plain', children: renderInline(node.children, t) })
            }
            return jsx('a', {
              key: `i${index}`,
              className: 'sshwsp-md-link',
              href,
              title: node.title === '' ? href : node.title,
              target: '_blank',
              rel: 'noreferrer noopener',
              children: renderInline(node.children, t),
            })
          }
          default: return null
        }
      })
    }

    /** Render a list item's blocks, unboxed: a one-paragraph item is a line. */
    function renderItemBlocks (blocks, t, keyPrefix) {
      return blocks.map((block, index) => renderBlock(block, t, `${keyPrefix}.${index}`))
    }

    /** Render one block. `key` is passed down so lists of blocks stay stable. */
    function renderBlock (block, t, key) {
      switch (block.type) {
        case 'heading': {
          const tag = `h${Math.min(6, Math.max(1, block.level))}`
          return jsx(tag, { key, className: 'sshwsp-md-heading', children: renderInline(block.inline, t) })
        }
        case 'paragraph':
          return jsx('p', { key, className: 'sshwsp-md-p', children: renderInline(block.inline, t) })
        case 'code':
          return jsx('pre', {
            key,
            className: 'sshwsp-md-pre',
            'data-lang': block.lang === '' ? undefined : block.lang,
            children: jsx('code', { children: block.text }),
          })
        case 'hr':
          return jsx('hr', { key, className: 'sshwsp-md-hr' })
        case 'quote':
          return jsx('blockquote', { key, className: 'sshwsp-md-quote', children:
            renderItemBlocks(block.blocks, t, key),
          })
        case 'list': {
          const tag = block.ordered ? 'ol' : 'ul'
          const start = block.ordered && block.start !== 1 ? { start: block.start } : undefined
          return jsx(tag, {
            key,
            className: 'sshwsp-md-list',
            ...start,
            children: block.items.map((item, index) => jsx('li', {
              key: `${key}.${index}`,
              className: item.checked === null ? 'sshwsp-md-item' : 'sshwsp-md-item sshwsp-md-task',
              'data-checked': item.checked === null ? undefined : (item.checked ? 'true' : 'false'),
              children: renderItemBlocks(item.blocks, t, `${key}.${index}`),
            })),
          })
        }
        case 'table':
          return jsx('div', { key, className: 'sshwsp-md-table-wrap', children:
            jsxs('table', { className: 'sshwsp-md-table', children: [
              jsx('thead', { children: jsx('tr', { children: block.head.map((cell, index) => jsx('th', {
                key: `${key}.h${index}`,
                style: block.align[index] === undefined || block.align[index] === ''
                  ? undefined
                  : { textAlign: block.align[index] },
                children: renderInline(cell, t),
              })) }) }),
              jsx('tbody', { children: block.rows.map((row, rowIndex) => jsx('tr', {
                key: `${key}.r${rowIndex}`,
                children: row.map((cell, cellIndex) => jsx('td', {
                  key: `${key}.r${rowIndex}c${cellIndex}`,
                  style: block.align[cellIndex] === undefined || block.align[cellIndex] === ''
                    ? undefined
                    : { textAlign: block.align[cellIndex] },
                  children: renderInline(cell, t),
                })),
              })) }),
            ] }),
          })
        default:
          return null
      }
    }

    /**
     * The document itself: frontmatter, then the body.
     *
     * `useMemo` on the text only — the parse is the expensive half, and the
     * view re-renders on every toolbar or loading change.
     */
    function MarkdownDocument ({ text, t }) {
      const parsed = React.useMemo(() => parseMarkdown(text), [text])
      const children = parsed.blocks.map((block, index) => renderBlock(block, t, `b${index}`))
      if (parsed.frontmatter !== null) {
        children.unshift(jsx('pre', {
          key: 'frontmatter',
          className: 'sshwsp-md-front',
          'aria-label': t('preview.frontmatter'),
          children: parsed.frontmatter,
        }))
      }
      return jsxs('article', { className: 'sshwsp-md', 'data-sshwsp-md': '1', children })
    }

    Object.assign(exports, {
      parseMarkdown,
      parseInline,
      splitFrontmatter,
      safeHref,
      MarkdownDocument,
    })
    return module.exports
  },
})
