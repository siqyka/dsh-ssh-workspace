#!/usr/bin/env node
/**
 * Import-graph cycle report for `lib/`.
 *
 * Used while merging modules: each merge either keeps the cycle count the same
 * or removes one, and a merge that ADDS a cycle is the failure mode this file
 * exists to catch before the tests are run.
 *
 * The count is not a lint rule — `lib/routes/routes.js` legitimately sits in
 * five cycles with its own submodules, because `ROUTES` lives in the composition
 * point and each handler module reads it. What this script protects is the
 * opposite: a merge that looks unrelated but quietly couples two hubs.
 *
 * @module scripts/graph-cycles
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { modulePaths } from '../tests/support/lib-modules.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const files = modulePaths(path.join(root, 'lib')).map(relative => `lib/${relative}`)
const known = new Set(files)

/**
 * The absolute modules a module imports, following only relative specifiers.
 *
 * @param {string} file - module path relative to the repository root.
 * @returns {string[]} the callees that exist in the graph.
 */
function edgesOf (file) {
  const source = readFileSync(path.join(root, file), 'utf8')
  const out = new Set()
  for (const match of source.matchAll(/(?:from|import)\s*'(\.[^']+)'/gu)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]))
    if (known.has(resolved)) out.add(resolved)
  }
  return [...out]
}

const graph = new Map(files.map(file => [file, edgesOf(file)]))

const color = new Map()
const cycles = new Set()

/**
 * Depth-first search recording every back edge as a cycle.
 *
 * @param {string} node - current module.
 * @param {string[]} stack - the current path.
 */
function visit (node, stack) {
  color.set(node, 'grey')
  stack.push(node)
  for (const next of graph.get(node)) {
    if (color.get(next) === 'grey') {
      const start = stack.indexOf(next)
      cycles.add([...stack.slice(start), next].join(' -> '))
    } else if (color.get(next) === undefined) {
      visit(next, stack)
    }
  }
  stack.pop()
  color.set(node, 'black')
}

for (const file of files) if (color.get(file) === undefined) visit(file, [])

console.log(`modules: ${files.length}  cycles: ${cycles.size}`)
for (const cycle of [...cycles].sort()) console.log(`  ${cycle}`)
