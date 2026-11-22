import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const lib = path.join(root, 'lib')

function walk (dir, prefix = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel))
    else if (e.name.endsWith('.js')) out.push(rel)
  }
  return out
}

const files = walk(lib)
const graph = new Map()
for (const f of files) {
  const src = readFileSync(path.join(lib, f), 'utf8').replace(/\r\n/gu, '\n')
  const out = new Set()
  for (const m of src.matchAll(/(?:from\s+|import\()\s*'(\.[^']+)'/gu)) {
    const t = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]))
    if (files.includes(t)) out.add(t)
  }
  graph.set(f, out)
}

function cycles (g) {
  const seen = new Set(); const stack = []; const found = []
  const visit = (n) => {
    if (stack.includes(n)) { found.push([...stack.slice(stack.indexOf(n)), n].join(' -> ')); return }
    if (seen.has(n)) return
    seen.add(n); stack.push(n)
    for (const o of g.get(n) ?? []) visit(o)
    stack.pop()
  }
  for (const n of g.keys()) visit(n)
  return found
}

// Candidate grouping: module -> folder
const GROUPING = JSON.parse(process.argv[2])
const moved = new Map()
for (const [folder, members] of Object.entries(GROUPING)) {
  for (const m of members) moved.set(m, folder === '.' ? m : `${folder}/${m}`)
}

// Build the post-move graph with rewritten specifiers.
const after = new Map()
for (const f of files) {
  const dest = moved.get(f) ?? f
  const src = readFileSync(path.join(lib, f), 'utf8').replace(/\r\n/gu, '\n')
  const out = new Set()
  for (const m of src.matchAll(/(?:from\s+|import\()\s*'(\.[^']+)'/gu)) {
    const t = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]))
    if (!files.includes(t)) continue
    out.add(moved.get(t) ?? t)
  }
  after.set(dest, out)
}
const before = cycles(graph)
const post = cycles(after)
console.log('before cycles:', before.length)
console.log('after  cycles:', post.length)
for (const c of post) console.log('  NEW?', c)
console.log('modules after:', after.size)
