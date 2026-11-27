/**
 * The Markdown reader behind a document's preview.
 *
 * Two halves, checked where they live:
 *
 *  - `parseMarkdown` / `parseInline` are pure, so this suite calls the real
 *    functions that ship (the chunk is evaluated in a `node:vm` context with a
 *    stand-in `window.__ModuleLoader__` and a stand-in React) and asserts on the
 *    parse tree. A renderer is easy to eyeball and hard to assert on; the tree
 *    is the opposite, and it is where the decisions are.
 *  - the WIRING is asserted as source: which files open as documents, that the
 *    tab opens in preview, that unsaved work blocks the switch, and that the
 *    renderer is a separate chunk fetched on demand rather than at boot.
 *
 * Run: node tests/markdown-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { clientPartSource, clientSource } from './support/client-source.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push({ name, detail })
  console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------------------
// [1] Load the shipped chunk
// ---------------------------------------------------------------------------
//
// The chunk is browser code: it calls `window.__ModuleLoader__.load(...)` and
// requires React. Both are supplied here — the loader facade keeps the factory
// and the module returns it, React becomes a stub whose `useMemo` just calls the
// function (the renderer's only React use). No browser, nothing copied.

const markdownSource = readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.markdown.js'), 'utf8')
const sandbox = { window: { __ModuleLoader__: { load: (definition) => { sandbox.__definition = definition } } } }
vm.createContext(sandbox)
vm.runInContext(markdownSource, sandbox, { filename: 'lib/client/client.markdown.js' })

check('the chunk registers itself through the module loader',
  typeof sandbox.__definition?.factory === 'function' && sandbox.__definition.chunk === 'client.markdown.js')

/** A frozen element shape: `{ type, props }`, which is all a test needs to read. */
function element (type, props) {
  return { type, props: props ?? {} }
}
const reactStub = {
  useMemo: (factory) => factory(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  createElement: element,
}
const jsxRuntimeStub = {
  jsx: element,
  jsxs: (type, props) => element(type, props),
}
const markdown = sandbox.__definition.factory((id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return jsxRuntimeStub
  throw new Error(`unexpected require: ${id}`)
})

check('the chunk exports the parser and the renderer',
  typeof markdown.parseMarkdown === 'function' &&
    typeof markdown.parseInline === 'function' &&
    typeof markdown.splitFrontmatter === 'function' &&
    typeof markdown.safeHref === 'function' &&
    typeof markdown.MarkdownDocument === 'function')

// ---------------------------------------------------------------------------
// [2] Frontmatter
// ---------------------------------------------------------------------------
{
  const split = markdown.splitFrontmatter('---\ntitle: x\n---\n# Body\n')
  check('frontmatter is split off verbatim', split.source === 'title: x' && split.body === '# Body\n',
    JSON.stringify(split))
  check('a document without frontmatter is left whole',
    markdown.splitFrontmatter('# Body\n').source === null)
  check('an unterminated block is not frontmatter (the file is just text)',
    markdown.splitFrontmatter('---\ntitle: x\n# Body\n').source === null)
  check('an empty frontmatter block still counts',
    markdown.splitFrontmatter('---\n---\ntext').source === '')
}

// ---------------------------------------------------------------------------
// [3] Blocks
// ---------------------------------------------------------------------------
{
  const blocks = markdown.parseMarkdown(`# One
## Two ##
Setext
======
###not a heading

***

\`\`\`\`js
nested \`\`\`
\`\`\`\`

> quoted
> > deeper

- a
  - b
- [ ] todo
- [x] done

3. three
4. four

| left | right |
|:-----|------:|
| 1 | 2 |
`).blocks.map(block => block.type)

  check('blocks are recognised in one pass without stepping on each other',
    blocks.join(',') === 'heading,heading,heading,paragraph,hr,code,quote,list,list,table',
    blocks.join(','))
}

{
  const parsed = markdown.parseMarkdown('# One\n## Two ##\n###not a heading\n')
  const [first, second, third] = parsed.blocks
  check('hash count becomes the heading level', first.level === 1)
  check('a closing hash run is decoration, not content',
    second.inline.map(node => node.value).join('') === 'Two')
  // `###not` has no space after the hashes, so CommonMark says it is a
  // paragraph — asserting it keeps the fast path from swallowing prose.
  check('hashes without a space stay text', third.type === 'paragraph')
}

{
  const parsed = markdown.parseMarkdown('Setext\n======\n\nSetext two\n------\n')
  check('an underline promotes the paragraph above it to a heading',
    parsed.blocks[0].type === 'heading' && parsed.blocks[0].level === 1)
  check('two underline characters pick h1 and h2',
    parsed.blocks[1].type === 'heading' && parsed.blocks[1].level === 2)
}

{
  const fence = markdown.parseMarkdown('```ts\nconst a = 1\n```\n').blocks[0]
  check('a fence keeps its language and its body verbatim',
    fence.type === 'code' && fence.lang === 'ts' && fence.text === 'const a = 1')
  const nested = markdown.parseMarkdown('````\n```\ninner\n```\n````\n').blocks[0]
  check('a longer opener absorbs a shorter fence instead of ending early',
    nested.type === 'code' && nested.text === '```\ninner\n```', JSON.stringify(nested))
  const unclosed = markdown.parseMarkdown('```\nno end\n').blocks[0]
  check('an unclosed fence still renders its lines rather than dropping them',
    unclosed.type === 'code' && unclosed.text === 'no end\n')
}

{
  const quote = markdown.parseMarkdown('> outer\n> > inner\n').blocks[0]
  check('a quote is parsed again, so a nested quote is a block of its own',
    quote.type === 'quote' && quote.blocks.some(block => block.type === 'quote'))
}

// ---------------------------------------------------------------------------
// [4] Lists
// ---------------------------------------------------------------------------
{
  const list = markdown.parseMarkdown('- a\n  - b\n- c\n').blocks[0]
  check('an indented marker nests instead of ending the list',
    list.items.length === 2 && list.items[0].blocks.some(block => block.type === 'list'),
    JSON.stringify(list.items.map(item => item.blocks.map(block => block.type))))

  const ordered = markdown.parseMarkdown('3. three\n4. four\n').blocks[0]
  check('an ordered list keeps its starting number', ordered.ordered === true && ordered.start === 3)

  const tasks = markdown.parseMarkdown('- [ ] todo\n- [x] done\n').blocks[0]
  check('task items carry their checked state',
    tasks.items[0].checked === false && tasks.items[1].checked === true)

  const loose = markdown.parseMarkdown('- first\n\n  second paragraph\n\n- next\n').blocks[0]
  check('a blank line continues the same item rather than splitting the list',
    loose.items.length === 2 &&
      loose.items[0].blocks.filter(block => block.type === 'paragraph').length === 2,
    JSON.stringify(loose.items.map(item => item.blocks.length)))
}

// ---------------------------------------------------------------------------
// [5] Tables
// ---------------------------------------------------------------------------
{
  const table = markdown.parseMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |\n').blocks[0]
  check('the delimiter row sets per-column alignment',
    table.type === 'table' && table.align[0] === 'left' && table.align[1] === 'right')
  check('outer pipes do not become empty cells',
    table.head.length === 2 && table.rows[0].length === 2,
    JSON.stringify({ head: table.head.length, row: table.rows[0].length }))
  check('cell text is inline-parsed, not taken raw',
    table.head[0][0].type === 'text' && table.head[0][0].value === 'a')
}

// ---------------------------------------------------------------------------
// [6] Inlines
// ---------------------------------------------------------------------------
{
  const nodes = markdown.parseInline('a **b** *c* ~~d~~ `e` [f](https://x.y) ![g](i.png)')
  const kinds = nodes.map(node => node.type).join(',')
  check('the inline forms people actually write are all recognised',
    kinds === 'text,strong,text,em,text,del,text,code,text,link,text,image', kinds)
  check('strong and em nest', markdown.parseInline('**a *b* c**')[0].children.some(node => node.type === 'em'))
}

check('an underscore inside a word is not emphasis',
  markdown.parseInline('snake_case_name').every(node => node.type === 'text'))

check('a backslash escapes the character after it',
  markdown.parseInline('\\*not emphasis\\*').map(node => node.type).join(',') === 'text' &&
    markdown.parseInline('\\*not emphasis\\*')[0].value === '*not emphasis*')

check('a code span is taken verbatim, markers escaped or not',
  markdown.parseInline('`a*b*c`')[0].value === 'a*b*c')

check('one space around code content is trimmed, two are kept',
  markdown.parseInline('` a `')[0].value === 'a' && markdown.parseInline('`  a  `')[0].value === ' a ')

check('two trailing spaces are a hard break',
  markdown.parseInline('a  \nb').map(node => node.type).join(',') === 'text,br,text')

check('an autolink keeps its text and gains a mailto when it is an address',
  markdown.parseInline('<a@b.co>')[0].href === 'mailto:a@b.co' &&
    markdown.parseInline('<https://x.y>')[0].href === 'https://x.y')

check('raw HTML is text, not markup',
  markdown.parseInline('<script>alert(1)</script>').every(node => node.type === 'text'))

// ---------------------------------------------------------------------------
// [7] Link safety
// ---------------------------------------------------------------------------
check('http, https and mailto are linkable',
  markdown.safeHref('https://x.y') === 'https://x.y' &&
    markdown.safeHref('http://x.y') === 'http://x.y' &&
    markdown.safeHref('mailto:a@b.co') === 'mailto:a@b.co')
check('a javascript: URL is not a link',
  markdown.safeHref('javascript:alert(1)') === '')
check('a relative path is not a link (the file lives on another machine)',
  markdown.safeHref('./other.md') === '' && markdown.safeHref('#anchor') === '')

// ---------------------------------------------------------------------------
// [8] Rendering
// ---------------------------------------------------------------------------
{
  const doc = markdown.MarkdownDocument({ text: '# T\n\n[a](https://x.y) [b](javascript:1)\n', t: (key) => key })
  check('the document renders as one article', doc.type === 'article' && doc.props.className === 'sshwsp-md')
  const children = doc.props.children
  check('frontmatter is absent unless the file has it', children[0].type === 'h1')
  const paragraph = children[1]
  const [link, , unsafe] = paragraph.props.children
  check('a safe link opens in a new tab with no opener',
    link.props.target === '_blank' && /noopener/u.test(link.props.rel) && link.props.href === 'https://x.y')
  check('an unsafe link renders as plain text instead of an anchor',
    unsafe.type === 'span' && unsafe.props.className === 'sshwsp-md-link-plain')
}

{
  const doc = markdown.MarkdownDocument({ text: '---\na: 1\n---\n\n![alt](x.png)\n', t: (key) => key })
  check('frontmatter renders verbatim above the body', doc.props.children[0].props.className === 'sshwsp-md-front')
  const image = doc.props.children[1].props.children[0]
  check('an image becomes a labelled placeholder, not a broken <img>',
    image.type === 'span' && image.props.className === 'sshwsp-md-image' && image.props.children === 'alt')
}

{
  // The pane hands the renderer a resolver, and a resolved reference becomes a
  // real picture. `undefined` (an unknown host alias) must stay a placeholder:
  // `src=""` renders as a broken image and looks like a bug.
  const resolved = markdown.MarkdownDocument({
    text: '![alt](./img/a.png)\n',
    t: (key) => key,
    imgSrc: (value) => `byte://x?path=${value}`,
  })
  const picture = resolved.props.children[0].props.children[0]
  check('a resolved image renders as an <img> through the resolver',
    picture.type === 'img' && picture.props.src === 'byte://x?path=./img/a.png' &&
      picture.props.alt === 'alt' && picture.props.loading === 'lazy')
  const unresolved = markdown.MarkdownDocument({
    text: '![alt](./img/a.png)\n',
    t: (key) => key,
    imgSrc: () => undefined,
  })
  check('...and an unresolved one keeps the placeholder',
    unresolved.props.children[0].props.children[0].type === 'span')
}

{
  const doc = markdown.MarkdownDocument({ text: '```bash\ngit status\n```\n', t: (key) => key })
  const fence = doc.props.children[0]
  check('a fenced block renders through the code card, not as a bare <pre>',
    typeof fence.type === 'function')
  // Call the component the way React would: the renderer returns an ELEMENT
  // describing it, so its own markup only exists after that call.
  const card = fence.type(fence.props)
  check('the card is a card, and it remembers its language',
    card.props.className === 'sshwsp-md-card' && card.props['data-lang'] === 'bash')
  const head = card.props.children[0]
  check('the card names its language on a strip',
    head.props.children[0].props.children === 'bash')
  check('the card carries wrap and copy actions',
    head.props.children[1].props.children.length === 2)
  const body = card.props.children[1]
  const flatten = (children) => (Array.isArray(children) ? children : [children])
    .map(child => typeof child === 'string' ? child : flatten(child?.props?.children))
    .join('')
  check('the code keeps its text inside the card, now as coloured runs',
    body.type === 'pre' && flatten(body.props.children.props.children) === 'git status')
  const unlabelledFence = markdown.MarkdownDocument({ text: '```\nx\n```\n', t: (key) => key })
    .props.children[0]
  const unlabelled = unlabelledFence.type(unlabelledFence.props)
  check('an unlabelled fence says text instead of lying about a language',
    unlabelled.props.children[0].props.children[0].props.children === 'text')
}

{
  // Highlighting is a tone table, not a grammar: the assertion is that the
  // three things a reader scans for are separated — keywords, strings, comments.
  const fence = markdown.MarkdownDocument({
    text: '```bash\nif true; then echo "hi" fi # note\n```\n',
    t: (key) => key,
  }).props.children[0]
  const rendered = fence.type(fence.props)
  const code = rendered.props.children[1].props.children.props.children
  const serialized = JSON.stringify(code)
  check('shell keywords, strings and comments are coloured differently',
    serialized.includes('sshwsp-md-tok-keyword') &&
      serialized.includes('sshwsp-md-tok-string') &&
      serialized.includes('sshwsp-md-tok-comment'))
  check('the highlighted text still reads as the original line',
    code.map(child => typeof child === 'string' ? child : child.props.children).join('') ===
      'if true; then echo "hi" fi # note')
}

check('an empty document renders an empty article',
  markdown.MarkdownDocument({ text: '', t: (key) => key }).props.children.length === 0)

// ---------------------------------------------------------------------------
// [9] Wiring in the bundle
// ---------------------------------------------------------------------------
{
  const source = clientSource(pluginRoot)

  check('the renderer is a lazy chunk, not part of the boot bundle',
    /require\.async\('\.\/client\.markdown\.js'\)/u.test(source) &&
      // The main bundle names it (that is the require above) but never contains
      // the parser: a copy in the boot bundle would defeat the split silently.
      !/function parseMarkdown/u.test(clientPartSource(pluginRoot)))

  check('markdown extensions open as documents, mdx does not',
    /const PREVIEW_DOCUMENT_EXTENSIONS = new Set\(\['md', 'markdown', 'mdown', 'mkd'\]\)/u.test(source) &&
      /const PREVIEW_DOCUMENT_NAMES = new Set\(\['changelog', 'readme'\]\)/u.test(source))

  check('a document tab opens in preview, everything else at its source',
    /const viewer = viewerOf\(filePath\)/u.test(source) &&
      /const isDocument = viewer === 'markdown' \|\| viewer === 'html'/u.test(source) &&
      /const \[mode, setMode\] = React\.useState\(\(\) => \(isDocument \? 'preview' : 'source'\)\)/u.test(source))

  check('the mode switch sits at the top-right, in flow above the body',
    /className: 'sshwsp-filepane-bar'/u.test(source) &&
      /className: 'sshwsp-docmodes'/u.test(source) &&
      /\.sshwsp-filepane-bar \{ flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end;/u
        .test(readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.styles.js'), 'utf8')))

  check('unsaved work blocks the switch and says why in the bar',
    /if \(dirty\) \{\n\s+setModeNotice\(t\('preview\.dirtyBlocked'\)\)/u.test(source) &&
      /className: 'sshwsp-filepane-modehint'/u.test(source))

  check('the pane publishes which mode it is in',
    /'data-sshwsp-mode': isMedia \? viewer : \(isDocument \? mode : 'source'\)/u.test(source) &&
      /'data-sshwsp-viewer': viewer/u.test(source))

  check('the document read uses the same route the editor uses',
    /function DocumentPreview \(\{ path, sessionId: givenSessionId, t \}\)/u.test(source) &&
      /requestJson\(`\$\{API\.readText\}\?\$\{query\.toString\(\)\}`/u.test(source))

  check('a rendered document is capped, with a note that says so',
    /const DOCUMENT_RENDER_LIMIT = 400 \* 1024/u.test(source) &&
      /t\('preview\.clipped'\)/u.test(source))
}

{
  const styles = readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.styles.js'), 'utf8')
  check('the reading column and its parts are styled',
    /\.sshwsp-docpane \{/u.test(styles) &&
      /\.sshwsp-md \{ max-width: 860px/u.test(styles) &&
      /\.sshwsp-md \.sshwsp-md-pre \{/u.test(styles) &&
      /\.sshwsp-md \.sshwsp-md-table \{/u.test(styles) &&
      /\.sshwsp-md \.sshwsp-md-task\[data-checked="true"\]::before/u.test(styles))

  const locale = readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.locale.js'), 'utf8')
  const keys = ['preview.modes', 'preview.modePreview', 'preview.modeSource', 'preview.dirtyBlocked', 'preview.clipped', 'preview.frontmatter', 'preview.imageRemote']
  check('both dictionaries carry every string the preview uses',
    keys.every(key => (locale.match(new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'gu')) ?? []).length === 2),
    keys.filter(key => (locale.match(new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'gu')) ?? []).length !== 2).join(' '))
}

// ---------------------------------------------------------------------------

console.log(`\n=== markdown smoke: ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure.name}`)
  process.exitCode = 1
}
