/**
 * The one shape every tool result takes.
 *
 * The Host accepts a tool result as a list of content blocks; every tool in
 * this plugin answers with exactly one text block, and the renderers all build
 * that block through this helper so the shape cannot drift between them.
 *
 * @module @shiqyka/dsh-ssh-workspace/tool-result
 */

/**
 * Wrap text as the single content block these tools render.
 *
 * @param {string} value - the rendered text.
 * @returns {Array<{type: string, text: string}>} one text content block.
 */
export function text (value) {
  return [{ type: 'text', text: value }]
}
