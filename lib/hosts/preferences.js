/**
 * The browser panel's viewing preferences, as data rather than as a store.
 *
 * This module is deliberately dependency-free (no `node:fs`, no peers): the two
 * halves that need the same rules are the STORE (which owns the JSON section)
 * and the HTTP ROUTE (which validates a request before it reaches the store).
 * Putting the rules between them is what keeps a hand-edited store value and a
 * hand-written request body from being judged by two different tables.
 *
 * Three settings live here:
 *
 *  - `fileView`: `sidebar` (the host's document preview — the default, so
 *    upgrading changes nothing) or `conversation` (the plugin's own tab in the
 *    conversation tab strip, see docs/features.md);
 *  - `showFiles`: whether the two directory pickers also list FILES as
 *    unselectable context rows (see docs/features.md, "show files");
 *  - `hideComposer`: while one of the plugin's file tabs is the open view,
 *    hide the composer at the bottom of the conversation. The composer is NOT
 *    part of a view — it is a sticky seat under the view area — so a file tab
 *    and the composer do coexist; hiding the composer gives the file the whole
 *    column, which is what a file view is for. Default ON, and the checkbox
 *    that turns it off is in the same 文件查看 section.
 *
 * @module @shiqyka/dsh-ssh-workspace/preferences
 */

/** The only two modes `fileView` may carry. */
export const FILE_VIEW_MODES = ['sidebar', 'conversation']

/** The default viewing preferences, i.e. the behaviour before this section existed. */
export const DEFAULT_PREFERENCES = Object.freeze({ fileView: 'sidebar', showFiles: false, hideComposer: true })

/**
 * The `preferences` section of a document, normalized.
 *
 * Every read is normalized rather than trusted: the store is a plain JSON file
 * a user can edit, and one bad value (`"bogus"`, `null`, a number) must fall
 * back to the default instead of leaving the click bridge in a mode outside the
 * two known ones — that would silently mean "neither", which looks like the
 * feature is broken rather than misconfigured.
 *
 * An unreadable section degrades to the defaults for the same reason as every
 * other section in the store: a damaged preferences block must not make the
 * host store (and with it the host list) unreadable.
 *
 * @param {object} document - the parsed store document.
 * @returns {{fileView: 'sidebar'|'conversation', showFiles: boolean, hideComposer: boolean}} the settings.
 */
export function preferencesOf (document) {
  const section = document?.preferences
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return { ...DEFAULT_PREFERENCES }
  }
  return {
    fileView: FILE_VIEW_MODES.includes(section.fileView) ? section.fileView : DEFAULT_PREFERENCES.fileView,
    showFiles: section.showFiles === true,
    // Only an explicit `false` opts out: a missing key means "never set", and
    // the default for a never-set key is the default, not the negation.
    hideComposer: section.hideComposer !== false,
  }
}

/**
 * Validate a request body for the preferences route.
 *
 * All keys are OPTIONAL (the panel saves one at a time), but a body naming
 * anything else is refused rather than ignored: a stale or hand-written client
 * that believes it saved a field the server dropped would then show a value the
 * click bridge never received. The checks return a sentence, not a boolean, so
 * the route has nothing to format and the refusal text cannot drift.
 *
 * @param {unknown} body - the parsed JSON body.
 * @returns {{ok: true, patch: object}|{ok: false, error: string}} the verdict.
 */
export function preferencesPatchOf (body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'the request body must be a JSON object' }
  }
  const keys = Object.keys(body)
  const known = new Set(['fileView', 'showFiles', 'hideComposer'])
  const unknown = keys.find(key => !known.has(key))
  if (unknown !== undefined) return { ok: false, error: `unknown preference: ${unknown}` }
  if (body.fileView !== undefined && !FILE_VIEW_MODES.includes(body.fileView)) {
    return { ok: false, error: 'fileView must be "sidebar" or "conversation"' }
  }
  if (body.showFiles !== undefined && typeof body.showFiles !== 'boolean') {
    return { ok: false, error: 'showFiles must be a boolean' }
  }
  if (body.hideComposer !== undefined && typeof body.hideComposer !== 'boolean') {
    return { ok: false, error: 'hideComposer must be a boolean' }
  }
  return {
    ok: true,
    patch: {
      ...(body.fileView === undefined ? {} : { fileView: body.fileView }),
      ...(body.showFiles === undefined ? {} : { showFiles: body.showFiles }),
      ...(body.hideComposer === undefined ? {} : { hideComposer: body.hideComposer }),
    },
  }
}
