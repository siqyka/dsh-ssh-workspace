/**
 * The download mark and its progress ring.
 *
 * The row used to print `'↓'` — a character whose weight came from the shell
 * font, which could not be outlined into the same geometry as a progress ring,
 * and which said "down", never the verb. The replacement is three shared
 * strokes (a U-shaped tray plus an arrow) used by the React icons, by the
 * DOM-built row menu, and by the ring that reports progress. The row menu
 * keeps that tray for the transfer verbs and draws a separate mark for every
 * other verb, so a copy or delete row cannot be mistaken for a file-type row.
 *
 * Source greps alone would pass on a drawing that never renders, so this suite
 * lifts the shipped icon factory out of `lib/client.js`, runs it against a
 * minimal React double, and asserts on the tree it actually builds: viewBox,
 * stroke style, the three tray paths, the ring's arc length for a known
 * percentage, the spinning arc for an unknown one, and the clamp that keeps a
 * full ring from leaving a seam. The queue matcher is exercised the same way:
 * by calling it with real queue items rather than by grepping its conditions.
 *
 * Run: node tests/download-icon-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== download icon smoke ===\n')

/**
 * A contiguous source region, located by two markers the file has to carry.
 *
 * A missing marker throws instead of slicing an empty string: a suite that
 * asserts on `''` passes exactly the checks whose whole point was that the
 * shipped code contains something.
 */
function sliceBetween (startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`client.js no longer marks ${label} (start)`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`client.js no longer marks ${label} (end)`)
  return source.slice(start, end)
}

// ---- the shipped icon factory, driven for real ------------------------------

const iconsSource = sliceBetween(
  '    const TRAY_BASE_PATH',
  '    // =========================================================================\n    // Host card',
  'the tray mark icons',
)

/** The smallest React that this factory touches: createElement and nothing else. */
function makeReactDouble () {
  return {
    createElement (type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
  }
}

const icons = new Function('React', `${iconsSource}\n return { DownloadIcon, UploadIcon, TransferProgressIcon, TRAY_ARROW_PATHS, TRAY_BASE_PATH }`)(makeReactDouble())

check('the mark is three shared strokes, not a font character',
  Array.isArray(icons.TRAY_ARROW_PATHS.download) && icons.TRAY_ARROW_PATHS.download.length === 3 &&
    icons.TRAY_ARROW_PATHS.download.every(d => typeof d === 'string' && d !== ''),
  'the mark no longer has a shaft, a head and a tray')
check('download and upload share the tray and differ only in the arrow',
  icons.TRAY_ARROW_PATHS.download[2] === icons.TRAY_BASE_PATH &&
    icons.TRAY_ARROW_PATHS.upload[2] === icons.TRAY_BASE_PATH &&
    icons.TRAY_ARROW_PATHS.download[0] !== icons.TRAY_ARROW_PATHS.upload[0],
  'one of the two arrows no longer points its own way')

const downloadTree = icons.DownloadIcon({ size: 14 })
check('the download mark draws an svg in the 16-unit box',
  downloadTree.type === 'svg' && downloadTree.props.viewBox === '0 0 16 16' &&
    downloadTree.props.width === 14 && downloadTree.props.height === 14,
  'the mark was built outside the icon grid')
check('...with the house stroke style rather than a fill',
  downloadTree.props.fill === 'none' && downloadTree.props.stroke === 'currentColor' &&
    downloadTree.props.strokeWidth === 1.5 && downloadTree.props.strokeLinejoin === 'round',
  'the mark would not match the other icons')
check('...hidden from assistive tech, because the row names the action',
  downloadTree.props['aria-hidden'] === 'true')
check('...and carrying the tray, the shaft and the head',
  downloadTree.children.length === 3 &&
    downloadTree.children.every(child => child.type === 'path') &&
    downloadTree.children.every((child, index) => child.props.d === icons.TRAY_ARROW_PATHS.download[index]),
  'one of the three strokes is missing or reordered')

const uploadTree = icons.UploadIcon({ size: 16 })
check('the upload mark is the same drawing with the arrow flipped',
  uploadTree.children.length === 3 &&
    uploadTree.children[2].props.d === icons.TRAY_BASE_PATH &&
    uploadTree.children[0].props.d !== downloadTree.children[0].props.d,
  'the upload mark was not derived from the shared tray')

const uploadRing = icons.TransferProgressIcon({ direction: 'upload', percent: 30 })
check('the ring can wrap the upload mark for an upload-only queue',
  uploadRing.children[2].children.length === 3 &&
    uploadRing.children[2].children.every((child, index) => child.props.d === icons.TRAY_ARROW_PATHS.upload[index])
  && uploadRing.children[1].props.strokeDasharray === '30 100',
  'the header would show a download arrow while uploads are moving')
check('an unknown direction falls back to the download mark instead of throwing',
  icons.TransferProgressIcon({ direction: 'sideways', percent: 30 }).children[2].children[0].props.d === icons.TRAY_ARROW_PATHS.download[0])

// ---- the ring: percentage as arc length, unknown total as motion -----------

const ring = icons.TransferProgressIcon({ percent: 42 })
check('the ring wraps the download mark instead of replacing it',
  ring.type === 'svg' && ring.children.length === 3 &&
    ring.children[0].props.className === 'sshwsp-dlring-track' &&
    ring.children[1].props.className === 'sshwsp-dlring-arc' &&
    ring.children[2].props.transform === 'translate(2.6 2.6) scale(0.675)',
  'the ring and the mark are no longer one control')
check('the track and the arc sit on a 7.2 circle, inside the 16-unit box',
  ring.children[0].props.r === 7.2 && ring.children[1].props.r === 7.2 &&
    ring.children[0].props.cx === 8 && ring.children[0].props.cy === 8,
  'the ring would clip or float away from the tray')
check('a known total becomes that arc length',
  ring.children[1].props.pathLength === 100 && ring.children[1].props.strokeDasharray === '42 100',
  'the arc does not encode the percentage')
check('the mark is blue while the transfer is live, through the shared class',
  ring.props.className === 'sshwsp-dlring sshwsp-dlring-active')
check('the ring is decoration; the row text states the number',
  ring.props['aria-hidden'] === 'true')

const liveRing = icons.TransferProgressIcon({ percent: null, live: true })
check('an unknown total turns a fixed arc instead of claiming 0%',
  liveRing.children[1].props.strokeDasharray === '30 100')
check('...and only that case gets the spin class',
  liveRing.props.className.includes('sshwsp-dlring-live') && !ring.props.className.includes('sshwsp-dlring-live'))

const waitingRing = icons.TransferProgressIcon({ percent: null, live: false })
check('a queued row shows the ring with no movement at all',
  waitingRing.children[1].props.strokeDasharray === '0 100' &&
    !waitingRing.props.className.includes('sshwsp-dlring-live'))
check('a full ring is clamped just under 100 to avoid a cap seam',
  icons.TransferProgressIcon({ percent: 100 }).children[1].props.strokeDasharray === '99.5 100' &&
    icons.TransferProgressIcon({ percent: 150 }).children[1].props.strokeDasharray === '99.5 100')
check('a negative sample cannot draw a negative arc',
  icons.TransferProgressIcon({ percent: -3 }).children[1].props.strokeDasharray === '0 100')

// ---- the queue matcher, driven with real items ------------------------------

const matcherMatch = source.match(/    function downloadQueueItemFor \(queue, alias, remotePath\) \{[\s\S]*?\n    \}/u)
check('the listing row keys its progress through one shared matcher', matcherMatch !== null)
const findDownloadItemFor = new Function(`${matcherMatch?.[0] ?? ''}\n return downloadQueueItemFor`)()

const queueOf = (...items) => ({ items })
const itemOf = (overrides) => ({
  id: 't', direction: 'download', alias: 'word', remotePath: '/home/u/src', name: 'src',
  status: 'running', bytesTotal: null, ...overrides,
})

check('an absent queue is not an error', findDownloadItemFor(null, 'word', '/home/u/src') === null &&
  findDownloadItemFor({}, 'word', '/home/u/src') === null)
check('the active download for that path is found',
  findDownloadItemFor(queueOf(itemOf({})), 'word', '/home/u/src')?.status === 'running')
check('...but an upload of the same path is not it',
  findDownloadItemFor(queueOf(itemOf({ direction: 'upload' })), 'word', '/home/u/src') === null)
check('...nor is a download from another host',
  findDownloadItemFor(queueOf(itemOf({ alias: 'qiyk' })), 'word', '/home/u/src') === null)
check('...nor is a sibling path on the same host',
  findDownloadItemFor(queueOf(itemOf({ remotePath: '/home/u/src2' })), 'word', '/home/u/src') === null)
check('a settled row gives its control back',
  ['done', 'failed', 'cancelled'].every(status =>
    findDownloadItemFor(queueOf(itemOf({ status })), 'word', '/home/u/src') === null),
  'a finished transfer still holds the row in progress state')
check('a retried transfer is the one the row reflects, not the stale one',
  findDownloadItemFor(queueOf(itemOf({ id: 'old' }), itemOf({ id: 'new', status: 'queued' })), 'word', '/home/u/src')?.id === 'new')
check('a queued download counts as in progress',
  findDownloadItemFor(queueOf(itemOf({ status: 'queued' })), 'word', '/home/u/src')?.status === 'queued')

// ---- the row menu's DOM icon builder ---------------------------------------

const menuSource = sliceBetween(
  '    const MENU_GLYPH_PATHS = {',
  '    /** A hairline rule between the reference action and the transfer actions. */',
  'the row-menu icon builder',
)

function makeDocumentDouble () {
  function makeElement (tagName) {
    return {
      tagName,
      attrs: {},
      children: [],
      setAttribute (name, value) { this.attrs[name] = String(value) },
      getAttribute (name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null },
      appendChild (child) { this.children.push(child); return child },
    }
  }
  return { createElementNS: (_namespace, tagName) => makeElement(tagName) }
}

const menuIcons = new Function('document', 'TRAY_ARROW_PATHS', `${menuSource}\n return { createMenuIcon, MENU_GLYPH_PATHS }`)(makeDocumentDouble(), icons.TRAY_ARROW_PATHS)
const makeMenuIcon = menuIcons.createMenuIcon

const drawPaths = svg => svg.children.map(child => child.getAttribute('d')).join('|')
const menuActionKinds = ['addToTask', 'copy', 'rename', 'delete', 'newFolder']
for (const kind of menuActionKinds) {
  check(`the menu draws the ${kind} mark for that action`,
    drawPaths(makeMenuIcon(kind)) === menuIcons.MENU_GLYPH_PATHS[kind].join('|'),
    `the ${kind} row still wore the file-type mark`)
}
check('the menu still draws the download mark for a download action',
  drawPaths(makeMenuIcon('download')) === icons.TRAY_ARROW_PATHS.download.join('|'))
check('...and the upload mark for an upload action',
  drawPaths(makeMenuIcon('upload')) === icons.TRAY_ARROW_PATHS.upload.join('|'))
check('the seven row-menu verbs draw seven different marks',
  new Set([
    ...menuActionKinds.map(kind => menuIcons.MENU_GLYPH_PATHS[kind].join('|')),
    icons.TRAY_ARROW_PATHS.download.join('|'),
    icons.TRAY_ARROW_PATHS.upload.join('|'),
  ]).size === 7 &&
    !menuActionKinds.some(kind => menuIcons.MENU_GLYPH_PATHS[kind].join('|') === menuIcons.MENU_GLYPH_PATHS.file.join('|')),
  'two verbs still share one drawing')
check('an unnamed action still falls back to the file mark, not an empty icon',
  makeMenuIcon().children.length === 2 && makeMenuIcon('unknown').children.length === 2,
  'the file fallback disappeared')

// ---- the shipped wiring -----------------------------------------------------

/** Comments cannot satisfy a rendering check, so every grep below reads code. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/^\s*\/\/.*$/gmu, '')

check('no download arrow character is rendered anywhere any more',
  !/children:\s*'↓'/u.test(code) && !/children:\s*'↑'/u.test(code),
  'a text glyph survived beside the drawn mark')
const dialog = sliceBetween(
  '    function DirectoryBrowser',
  '    // =========================================================================\n    // Diagnostic report dialog',
  'the browse-only directory dialog',
)
check('the browse-only listing shows no download mark or progress ring',
  !/DownloadIcon|TransferProgressIcon|downloadQueueItemFor|queueItemPercent/u.test(dialog),
  'a row kept a transfer control the dialog no longer owns')
check('...and asks for no download/upload label',
  !/browser\.download|browser\.upload|queue\.uploadHint/u.test(dialog),
  'a transfer label survived without a control')
check('the queue row wears the same ring only while it is running',
  /React\.createElement\(TransferProgressIcon, \{ size: 16, percent, live: percent === null \}\)/u.test(code) &&
    /item\.status === 'running' \? ' sshwsp-queueicon-active' : ''/u.test(code))
check('the two directions keep their own marks in the queue column',
  /item\.direction === 'upload'\n\s*\? React\.createElement\(UploadIcon\)/u.test(code) &&
    /React\.createElement\(DownloadIcon\),/u.test(code))
const rowMenu = sliceBetween(
  '    function openTaskMenu (ctx, absPath, isDir, root, x, y, sessionId, selection) {',
  '    /**\n     * The local blank-space menu',
  'the row-menu action list',
)
const menuGlyphs = [...rowMenu.matchAll(/glyph:\s*'([^']+)'/gu)].map(match => match[1]).sort()
// One verb per action: the download item no longer forks into "download" and
// "download the whole directory", because the scope is stated by the
// destination dialog rather than by a second glyph with the same meaning.
check('every row-menu action names a glyph instead of inheriting the row type',
  (rowMenu.match(/createTransferItem\(\{/gu) ?? []).length === 7 &&
    menuGlyphs.join('|') === ['addToTask', 'copy', 'delete', 'download', 'newFolder', 'rename', 'upload'].join('|'),
  `row-menu glyphs: ${menuGlyphs.join(', ')}`)

// ---- the Files-panel entry -------------------------------------------------

const trigger = sliceBetween(
  '    function FilePanelTransferActions (props) {',
  '    let taskMenuEl = null',
  'the Files-panel transfer entry',
)

check('the Files-panel entry is the drawn mark, not the word or a badge',
  !/t\('queue\.short'\)/u.test(code) && !/sshwsp-queuebadge/u.test(code) &&
    /React\.createElement\(DownloadIcon\),/u.test(trigger),
  'the header still prints a label or a count pill')
check('...with one reading of the whole queue behind it',
  /const progress = transferQueueProgress\(queue\.items\)/u.test(trigger) &&
    /direction: progress\.direction/u.test(trigger) &&
    /percent: progress\.percent/u.test(trigger) &&
    /live: progress\.live/u.test(trigger),
  'the entry re-derived the numbers per frame instead of reading the queue')
check('...turning blue only while something is queued or running',
  /\+ \(activeCount > 0 \? ' sshwsp-fileaction-queue-active' : ''\)/u.test(trigger))
check('...and naming the count in its accessible label, since the mark cannot print it',
  /t\('queue\.openCount', \{ count: activeCount \}\)/u.test(trigger) &&
    /title: label,/u.test(trigger) && /'aria-label': label,/u.test(trigger))
check('the idle entry is an icon seat, not a text pill',
  /\.sshwsp-fileaction-queue \{ gap: 0; padding: 0 6px; color: var\(--dsw-alias-label-primary, #e0e0e0\); \}/u.test(source))
check('...while an active entry keeps its blue on hover instead of becoming a generic label',
  /\.sshwsp-fileaction-queue-active:hover \{ color: var\(--dsw-alias-button-info-fill, #4a9eff\); \}/u.test(source))

check('the icon column is no longer a monospace text column',
  /\.sshwsp-queueicon \{ flex: 0 0 auto; display: inline-flex; align-items: center; width: 16px; color: var\(--dsw-alias-label-secondary, #999\); \}/u.test(source) &&
    !/\.sshwsp-queueicon \{[\s\S]{0,200}monospace/u.test(source))
check('the ring track borrows the queue bar\'s hue family, not a fourth colour',
  /\.sshwsp-dlring-track \{ stroke: color-mix\(in srgb, var\(--dsw-alias-label-tertiary, #888\) 55%, transparent\); \}/u.test(source))
check('the arc starts at twelve o’clock and spins from there',
  /\.sshwsp-dlring-arc \{ transform-box: view-box; transform-origin: 50% 50%; transform: rotate\(-90deg\); \}/u.test(source) &&
    /\.sshwsp-dlring-live \.sshwsp-dlring-arc \{ animation: sshwsp-dlring-spin 1\.1s linear infinite; \}/u.test(source))
check('reduced motion stops the spinning arc instead of speeding it up',
  /\.sshwsp-dlring-live \.sshwsp-dlring-arc \{ animation: none; \}/u.test(source))
check('a busy button keeps its ring at full opacity',
  /\.sshwsp-icon-btn-busy:disabled \{ opacity: 1; cursor: default; \}/u.test(source))

const removedLabels = ['browser.download', 'browser.downloadDir', 'browser.downloading',
  'browser.upload', 'browser.uploading', 'browser.uploadBlocked', 'browser.uploadBlockedNote']
check('the removed dialog labels are gone from both dictionaries',
  removedLabels.every(key => !new RegExp(`'${key.replace('.', '\\.')}':`, 'u').test(source)),
  'a label for a control that no longer renders survived in a locale')

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
