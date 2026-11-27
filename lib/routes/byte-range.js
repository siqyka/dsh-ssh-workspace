/**
 * Byte-window maths for the preview routes, with no dependencies so it can be
 * tested without an SSH engine.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/byte-range
 */

/** One byte window a single request may pull. */
export const MAX_RANGE_BYTES = 16 * 1024 * 1024

/** Media types the preview actually renders. */
const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
}

/**
 * The media type a byte route should answer with.
 *
 * Octet-stream is right for a save dialog and wrong for a preview: a browser
 * will not paint an `<img>` typed octet-stream.
 *
 * @param {string} path - file path.
 * @returns {string} a media type.
 */
export function mediaTypeOfPath (path) {
  const name = String(path ?? '').toLowerCase()
  const dot = name.lastIndexOf('.')
  const extension = dot < 0 ? '' : name.slice(dot + 1)
  return MEDIA_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * Parse one `Range` header against a known size.
 *
 * Only the single-range form is served: a browser asks for exactly one window
 * when it seeks, and multipart/byteranges is a parser with no preview payoff.
 *
 * @param {string|undefined} header - the request header.
 * @param {number} size - file size.
 * @returns {{start: number, end: number}|null|'invalid'} the window, null for
 *   "no range", or 'invalid' to refuse with 416.
 */
export function parseByteRange (header, size) {
  if (typeof header !== 'string' || header.trim() === '') return null
  if (!Number.isFinite(size) || size <= 0) return 'invalid'
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}
