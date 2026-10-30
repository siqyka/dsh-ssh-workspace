/**
 * The contract every upstream patch depends on, in one place.
 *
 * ## Why a table and not a comment
 *
 * Each `lib/patch-*.js` reaches into a Host shape it does not own: a service
 * name, a method signature, a registration flag. The existing "self-retiring
 * probe" (patch-projection.js) answers the one question it was built for — has
 * upstream fixed the thing I work around? — but it cannot answer "is the shape
 * I attach to still there?", and an upgrade that renames a symbol produces
 * exactly the failure nobody notices: the patch installs, nothing changes, and
 * every remote feature quietly stops working.
 *
 * So each patch declares its dependency here, and `tests/upstream-contract-smoke.mjs`
 * asserts the declaration against the module source. The declaration is checked,
 * not trusted: a patch that stops touching a symbol it still lists, or starts
 * touching one it never declared, is a red build.
 *
 * @module @shiqyka/dsh-ssh-workspace/lib/upstream-contract
 */

/**
 * One patch's dependency declaration.
 *
 * `symbols` are the Host-side names the patch reads or replaces. `installs`
 * is the public entry point. `retire` is what the self-retiring probe reports,
 * or undefined when the patch has no retirement story (it is not working
 * around a defect, it is adding a capability).
 *
 * @typedef {object} Contract
 * @property {string} id - the patch id (`UPSTREAM-n-…` for a workaround).
 * @property {string} file - the module, relative to `lib/`.
 * @property {string} installs - the exported install function.
 * @property {string[]} symbols - Host-side names the module depends on.
 * @property {string} [retire] - the probe verdict that means "delete me".
 * @property {string} summary - one line: what breaks if this contract is violated.
 */

/**
 * Every patch, declared.
 *
 * The order is the installation order `lib/index.js` uses, which matters because
 * the patches share one `ctx` and later ones can observe earlier ones' effects.
 *
 * @type {Contract[]}
 */
export const CONTRACTS = Object.freeze([
  {
    id: 'UPSTREAM-1-working-directory-isAbsolute',
    file: 'patch-projection.js',
    installs: 'installProjectionRelaxation',
    symbols: ['sessionProjections', 'register', 'registrations', 'schema', 'refine'],
    retire: 'fixed',
    summary: 'a stored ssh:// session stops loading, because the projection schema rejects an ssh:// working directory',
  },
  {
    id: 'PATCH-fs',
    file: 'patch-fs.js',
    installs: 'installRemoteFileSystem',
    symbols: ['fs', 'resolve', 'stat', 'readText', 'writeText', 'editText', 'listDir', 'watch'],
    summary: 'every ssh:// file tool call fails, because the remote methods are never installed on the deployment backend',
  },
  {
    id: 'PATCH-shell',
    file: 'patch-shell.js',
    installs: 'installRemoteShell',
    symbols: ['shell', 'execute', 'workdir', 'result', 'onExpiry'],
    summary: 'pwsh/bash commands in an ssh:// workspace run on the WRONG machine — the local one',
  },
  {
    id: 'PATCH-subprocess',
    file: 'patch-subprocess.js',
    installs: 'installRemoteSubprocess',
    symbols: ['subprocess', 'spawn', 'cwd', 'exec'],
    summary: 'rg/git spawned with an ssh:// cwd run locally, or fail outright',
  },
  {
    id: 'PATCH-terminal',
    file: 'patch-terminal.js',
    installs: 'installRemoteTerminal',
    symbols: ['terminals', 'open', 'close', 'pty'],
    summary: 'a terminal opened in an ssh:// workspace is a local shell with a remote-looking title',
  },
])

/**
 * The declared contract for one module file, or undefined.
 *
 * @param {string} file - a `lib/` filename.
 * @returns {Contract|undefined} the contract.
 */
export function contractFor (file) {
  return CONTRACTS.find(contract => contract.file === file)
}

/**
 * The contracts whose modules are actually present in `lib/`.
 *
 * A declared contract for a file that no longer exists is stale in the other
 * direction — the documentation and the suite would keep asserting a patch that
 * was deleted — so the caller can compare the two sets.
 *
 * @param {string[]} files - the filenames present under `lib/`.
 * @returns {string[]} contracts with no matching file.
 */
export function missingFiles (files) {
  const present = new Set(files)
  return CONTRACTS.filter(contract => !present.has(contract.file)).map(contract => contract.file)
}
