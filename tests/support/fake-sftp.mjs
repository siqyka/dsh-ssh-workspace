/**
 * An SFTP channel over an in-memory tree, for suites that must prove what the
 * write path really does — not just which branch it took.
 *
 * ## Why this exists
 *
 * `tests/support/fake-ssh-server.mjs` is a real SSH server with a deliberately
 * fake filesystem: it answers OPEN/CLOSE/STAT with fixed values and says so in
 * its header. That is the right shape for transport tests, and the wrong shape
 * for everything downstream of the transport — staged publication, version
 * conflicts, fence refusals, cleanup after a failed write. Those only exist
 * against a tree, so until now they were either asserted against a hand-rolled
 * double inside one suite (four of them, all slightly different) or not
 * asserted at all: the success branches of `writeText` / `editText` / `listDir`
 * / `transferFile` ran only in the `live` suite against a real host.
 *
 * ## What it is, exactly
 *
 * A Map of paths to bytes, a Set of directories, a Map of symbolic links, and
 * the fourteen methods `lib/fs/remote-fs.js` actually calls. Nothing else is
 * implemented, and asking for anything else throws instead of answering
 * undefined — a double that silently returns nothing turns a missing method
 * into a passing test about nothing.
 *
 * The methods it does implement behave like a server rather than like a mock:
 *
 *  - `rename` onto an existing destination FAILS, because plain SFTP rename is
 *    specified to and OpenSSH enforces it. A double that quietly overwrites
 *    hides the only interesting decision in `publishRename`.
 *  - `ext_openssh_rename` and `_extensions` are advertised by default, so the
 *    ATOMIC path is what runs. The fallback (unlink, then rename) is reached by
 *    turning them off, which is the only way to keep the fallback honest: when
 *    the extension was missing from a double, every write silently took the
 *    non-atomic branch and every suite still passed.
 *  - `stat` reports ino, size and mtime, and mtime advances on every mutation,
 *    so `versionOf()` changes when the file does. `freezeMtime` keeps it still,
 *    which is how a same-size rewrite inside one second is reproduced — the
 *    exact change an ino:size:mtime version cannot see.
 *  - a path whose parent is missing answers ENOENT; whose parent is a file
 *    answers ENOTDIR. A double that accepts every path cannot tell a fence from
 *    a filesystem.
 *
 * ## Controls
 *
 * `createFakeSftp({ files, dirs, links, extensions })` returns
 * `{ sftp, tree, snapshot }`. Every control lives on `tree`:
 *
 *  - `tree.read(path)` / `tree.bytes(path)` — what the file holds now.
 *  - `tree.has(path)` / `tree.isDir(path)` / `tree.isLink(path)` — shape.
 *  - `tree.write(path, content)` / `tree.mkdir(path)` / `tree.link(from, to)`
 *    — seed or mutate the tree between phases.
 *  - `tree.fail({ method, path, code, message, times })` — make the NEXT call
 *    of that method (optionally for one path) answer an error. `code` is the
 *    SFTP status the server would send: 2 is ENOENT, 3 is EACCES, 4 is a
 *    generic failure (which is what an ENOSPC or a full disk arrives as), 20 is
 *    ENOTDIR.
 *  - `tree.breakConnection()` / `tree.restoreConnection()` — every call answers
 *    connection-lost until restored. This is the mid-write death that a staging
 *    directory must survive; pair it with `fake-ssh-server` when the suite needs
 *    the socket to die rather than the channel to fail.
 *  - `tree.useExtensions(false)` — hide posix-rename so the fallback runs.
 *  - `tree.calls` — every method call in order, for "nothing reached the host"
 *    assertions (`tree.calls.length === 0` is stronger than checking one map).
 *  - `tree.writes` / `tree.renames` / `tree.unlinks` / `tree.chmods` — the
 *    counters the cleanup assertions read.
 *
 * @module tests/support/fake-sftp
 */

/** The extension name OpenSSH advertises for an atomic overwrite. */
const POSIX_RENAME = 'posix-rename@openssh.com'

/** SFTP status codes, as `ssh2` reports them. */
export const SFTP_STATUS = Object.freeze({
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  NOT_A_DIRECTORY: 20,
})

/** Methods ssh2 exposes that this double deliberately does not implement. */
const NOT_IMPLEMENTED = Object.freeze([
  'appendFile', 'copyFile', 'symlink', 'readlink', 'setstat', 'fstat',
  'fchmod', 'fsetstat', 'fastGet', 'fastPut', 'createReadStream',
  'createWriteStream', 'readFile', 'writeFile', 'opendir', 'exists', 'truncate',
])

/** Build an SFTP-shaped error, the way `ssh2` reports a status. */
function sftpError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Collapse duplicate separators and resolve . and .. the way a server does. */
function normalize (target) {
  const raw = String(target === undefined || target === null ? "" : target)
  if (raw === "") return "/"
  const absolute = raw.startsWith("/") ? raw : "/" + raw
  const out = []
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") { out.pop(); continue }
    out.push(segment)
  }
  return "/" + out.join("/")
}

/** The parent of a normalized path, or null at the root. */
function parentOf (target) {
  if (target === "/") return null
  const at = target.lastIndexOf("/")
  return at <= 0 ? "/" : target.slice(0, at)
}

/** A Node-ish stats object, with the fields `remote-fs.js` reads. */
function statsFor (entry) {
  return {
    ino: entry.ino,
    size: entry.kind === "file" ? entry.bytes.length : 0,
    mode: entry.mode,
    mtime: entry.mtime,
    atime: entry.mtime,
    isFile: () => entry.kind === "file",
    isDirectory: () => entry.kind === "directory",
    isSymbolicLink: () => entry.kind === "symlink",
  }
}

/**
 * Create the double.
 *
 * @param {object} [options] - seed and behaviour.
 * @param {object|Array|Map} [options.files] - path to content; a string is
 *   encoded as UTF-8, a Buffer or Uint8Array is used as-is.
 * @param {string[]} [options.dirs] - directories; parents are created too.
 * @param {Array<[string, string]>} [options.links] - symbolic links.
 * @param {boolean} [options.extensions] - advertise the atomic-rename
 *   extension (default true: the atomic path is the one that must be proven).
 * @returns {{sftp: object, tree: object, snapshot: () => object}} the channel,
 *   its controls, and a plain-data view for assertions.
 */
export function createFakeSftp (options = {}) {
  const files = new Map()
  const dirs = new Set(["/"])
  const links = new Map()
  const modes = new Map()
  const mtimes = new Map()
  const inodes = new Map()
  const failures = []
  const calls = []
  const handles = new Map()
  const state = {
    writes: 0,
    bytesWritten: 0,
    renames: [],
    unlinks: [],
    rmdirs: [],
    chmods: [],
    mkdirs: [],
    opens: [],
  }
  /** Every write that landed, so a suite can measure one file's traffic. */
  const writeLog = []
  let handleSeq = 1
  let tick = 1000
  let extensions = options.extensions !== false
  let connected = true
  let frozenMtime = false
  // A write budget: allow this many writes, then refuse. `Infinity` disables it.
  let writeBudget = Number.POSITIVE_INFINITY
  let writeBudgetError = { code: SFTP_STATUS.FAILURE, message: 'Failure: no space left on device' }

  /** Advance the clock for one path, unless the suite froze it. */
  const stamp = (target) => {
    if (frozenMtime) {
      if (!mtimes.has(target)) mtimes.set(target, tick++)
      return
    }
    mtimes.set(target, tick++)
  }

  /** A stable inode per path, so a rewrite keeps its number. */
  const inoOf = (target) => {
    if (!inodes.has(target)) inodes.set(target, 4000 + inodes.size)
    return inodes.get(target)
  }

  /** Seed a directory chain. */
  const mkdirSeed = (target) => {
    const normalized = normalize(target)
    if (normalized === "/") return
    const parent = parentOf(normalized)
    if (parent !== null) mkdirSeed(parent)
    if (!dirs.has(normalized)) {
      dirs.add(normalized)
      if (!mtimes.has(normalized)) mtimes.set(normalized, tick++)
    }
  }

  /** Seed or replace a file. */
  const writeSeed = (target, content) => {
    const normalized = normalize(target)
    const parent = parentOf(normalized)
    if (parent !== null) mkdirSeed(parent)
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content)
    files.set(normalized, bytes)
    stamp(normalized)
  }

  for (const target of options.dirs ?? []) mkdirSeed(target)
  const seedFiles = options.files instanceof Map
    ? [...options.files]
    : (Array.isArray(options.files) ? options.files : Object.entries(options.files ?? {}))
  for (const [target, content] of seedFiles) writeSeed(target, content)
  for (const [from, to] of options.links ?? []) {
    const normalized = normalize(from)
    const parent = parentOf(normalized)
    if (parent !== null) mkdirSeed(parent)
    links.set(normalized, normalize(to))
    stamp(normalized)
  }

  /** Follow links (repeatedly, so a chain settles) to the real path. */
  const resolve = (target) => {
    let current = normalize(target)
    for (let hop = 0; hop < 16; hop += 1) {
      let hit
      for (const [from, to] of links) {
        if (current === from || current.startsWith(from + "/")) {
          if (hit === undefined || from.length > hit.from.length) hit = { from, to }
        }
      }
      if (hit === undefined) return current
      current = normalize(hit.to + current.slice(hit.from.length))
    }
    return current
  }

  /** Describe what lives at a path, following links; undefined when absent. */
  const entryAt = (target) => {
    const real = resolve(target)
    if (files.has(real)) {
      return {
        kind: "file",
        bytes: files.get(real),
        ino: inoOf(real),
        mode: modes.get(real) === undefined ? 0o644 : modes.get(real),
        mtime: mtimes.get(real) === undefined ? 0 : mtimes.get(real),
      }
    }
    if (dirs.has(real)) {
      return {
        kind: "directory",
        ino: inoOf(real),
        mode: modes.get(real) === undefined ? 0o755 : modes.get(real),
        mtime: mtimes.get(real) === undefined ? 0 : mtimes.get(real),
      }
    }
    return undefined
  }

  /** Describe a path WITHOUT following its final component (for lstat). */
  const linkAt = (target) => {
    const normalized = normalize(target)
    if (!links.has(normalized)) return undefined
    return { kind: "symlink", ino: inoOf(normalized), mode: 0o777, mtime: mtimes.get(normalized) === undefined ? 0 : mtimes.get(normalized) }
  }

  /**
   * Fail the call the way a server would, before touching the tree.
   *
   * Returns true when it answered, so every method is one `if (reject(...))
   * return` line and no method forgets the checks.
   */
  const reject = (method, target, callback) => {
    if (!connected) {
      callback(sftpError("ECONNRESET", "connection lost"))
      return true
    }
    const at = failures.findIndex(entry => entry.method === method && (entry.path === undefined || entry.path === target))
    if (at >= 0) {
      const entry = failures[at]
      entry.times -= 1
      if (entry.times <= 0) failures.splice(at, 1)
      callback(sftpError(entry.code, entry.message))
      return true
    }
    return false
  }

  /** Refuse a path whose parent cannot hold a child, the way a server does. */
  const parentRefusal = (target) => {
    const parent = parentOf(normalize(target))
    if (parent === null) return undefined
    const resolvedParent = resolve(parent)
    if (files.has(resolvedParent)) return sftpError(SFTP_STATUS.NOT_A_DIRECTORY, "Not a directory")
    if (!dirs.has(resolvedParent)) return sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")
    return undefined
  }

  const sftp = {
    /** Advertised extensions; `publishRename` checks this BEFORE the method. */
    get _extensions () { return extensions ? { [POSIX_RENAME]: "1" } : {} },

    stat (target, callback) {
      calls.push({ method: "stat", path: target })
      if (reject("stat", normalize(target), callback)) return
      const entry = entryAt(target)
      if (entry === undefined) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")); return }
      callback(null, statsFor(entry))
    },

    lstat (target, callback) {
      calls.push({ method: "lstat", path: target })
      if (reject("lstat", normalize(target), callback)) return
      const link = linkAt(target)
      if (link !== undefined) { callback(null, statsFor(link)); return }
      const entry = entryAt(target)
      if (entry === undefined) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")); return }
      callback(null, statsFor(entry))
    },

    realpath (target, callback) {
      calls.push({ method: "realpath", path: target })
      if (reject("realpath", normalize(target), callback)) return
      const real = resolve(target)
      if (!files.has(real) && !dirs.has(real)) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file"), null); return }
      callback(null, real)
    },

    readdir (target, callback) {
      calls.push({ method: "readdir", path: target })
      if (reject("readdir", normalize(target), callback)) return
      const entry = entryAt(target)
      if (entry === undefined) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")); return }
      if (entry.kind !== "directory") { callback(sftpError(SFTP_STATUS.NOT_A_DIRECTORY, "Not a directory")); return }
      const real = resolve(target)
      const prefix = real === "/" ? "/" : real + "/"
      const names = new Set()
      for (const key of [...files.keys(), ...dirs.keys(), ...links.keys()]) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === "") continue
        names.add(rest.split("/")[0])
      }
      const list = []
      for (const name of [...names].sort()) {
        const child = prefix + name
        const childEntry = linkAt(child) === undefined ? entryAt(child) : linkAt(child)
        if (childEntry === undefined) continue
        list.push({ filename: name, longname: child, attrs: statsFor(childEntry) })
      }
      callback(null, list)
    },

    mkdir (target, attrs, callback) {
      if (typeof attrs === "function") callback = attrs
      const normalized = normalize(target)
      calls.push({ method: "mkdir", path: normalized })
      if (reject("mkdir", normalized, callback)) return
      const refusal = parentRefusal(normalized)
      if (refusal !== undefined) { callback(refusal); return }
      if (dirs.has(normalized) || files.has(normalized) || links.has(normalized)) {
        // `mkdirStrict` treats exactly this shape as success, so the double must
        // report it exactly this way or that tolerance is never exercised.
        callback(sftpError(SFTP_STATUS.FAILURE, "Failure: file already exists"))
        return
      }
      dirs.add(normalized)
      state.mkdirs.push(normalized)
      if (attrs !== undefined && attrs !== null && typeof attrs === "object" && typeof attrs.mode === "number") modes.set(normalized, attrs.mode & 0o777)
      stamp(normalized)
      callback(null)
    },

    open (target, flags, attrs, callback) {
      if (typeof attrs === "function") { callback = attrs; attrs = undefined }
      const normalized = normalize(target)
      calls.push({ method: "open", path: normalized, flags })
      if (reject("open", normalized, callback)) return
      const real = resolve(normalized)
      const exists = files.has(real) || dirs.has(real) || links.has(normalized)
      if (flags === "wx" && exists) { callback(sftpError(SFTP_STATUS.FAILURE, "Failure: file already exists")); return }
      if (typeof flags === "string" && flags.startsWith("r")) {
        // Both "r" and "r+" need the file to be there already. A double that
        // conjured it would hide a resume that opened a partial which had in
        // fact been cleaned up.
        if (dirs.has(real)) { callback(sftpError(SFTP_STATUS.FAILURE, "Failure: is a directory")); return }
        if (!files.has(real)) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")); return }
      } else {
        const refusal = parentRefusal(normalized)
        if (refusal !== undefined) { callback(refusal); return }
      }
      const handle = { id: handleSeq, path: real, flags }
      handleSeq += 1
      handles.set(handle.id, handle)
      state.opens.push({ path: real, flags, mode: attrs === undefined || attrs === null ? undefined : attrs.mode })
      if (flags === "w" || flags === "w+") {
        files.set(real, Buffer.alloc(0))
        stamp(real)
      }
      if (flags === "wx") {
        files.set(real, Buffer.alloc(0))
        if (attrs !== undefined && attrs !== null && typeof attrs.mode === "number") modes.set(real, attrs.mode & 0o777)
        stamp(real)
      }
      callback(null, handle)
    },

    close (handle, callback) {
      calls.push({ method: "close" })
      if (handle !== undefined && handle !== null) handles.delete(handle.id)
      callback(null)
    },

    read (handle, buffer, offset, length, position, callback) {
      calls.push({ method: "read" })
      if (reject("read", handle === undefined ? undefined : handle.path, callback)) return
      const current = handle === undefined ? Buffer.alloc(0) : (files.get(handle.path) === undefined ? Buffer.alloc(0) : files.get(handle.path))
      const at = position === undefined || position === null ? 0 : position
      const slice = current.subarray(at, at + length)
      buffer.set(slice, offset)
      callback(null, slice.length, buffer)
    },

    write (handle, buffer, offset, length, position, callback) {
      calls.push({ method: "write" })
      if (reject("write", handle === undefined ? undefined : handle.path, callback)) return
      if (state.writes >= writeBudget) {
        callback(sftpError(writeBudgetError.code, writeBudgetError.message))
        return
      }
      state.writes += 1
      state.bytesWritten += length
      const current = files.get(handle.path) === undefined ? Buffer.alloc(0) : files.get(handle.path)
      const slice = Buffer.from(buffer.subarray(offset, offset + length))
      const at = position === undefined || position === null ? current.length : position
      const next = Buffer.alloc(Math.max(current.length, at + slice.length))
      current.copy(next, 0)
      slice.copy(next, at)
      files.set(handle.path, next)
      stamp(handle.path)
      writeLog.push({ path: handle.path, offset: at, length: slice.length })
      callback(null)
    },

    rename (from, to, callback) {
      const source = normalize(from)
      const destination = normalize(to)
      calls.push({ method: "rename", from: source, to: destination })
      if (reject("rename", source, callback)) return
      if (!files.has(source) && !dirs.has(source)) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")); return }
      if (files.has(destination) || dirs.has(destination)) {
        // Plain SFTP rename is specified to fail here and OpenSSH enforces it.
        // A double that overwrites would never exercise the fallback at all.
        callback(sftpError(SFTP_STATUS.FAILURE, "Failure"))
        return
      }
      if (files.has(source)) {
        files.set(destination, files.get(source))
        files.delete(source)
        if (modes.has(source)) { modes.set(destination, modes.get(source)); modes.delete(source) }
      } else {
        dirs.delete(source)
        dirs.add(destination)
      }
      stamp(destination)
      state.renames.push([source, destination])
      callback(null)
    },

    unlink (target, callback) {
      const normalized = normalize(target)
      calls.push({ method: "unlink", path: normalized })
      if (reject("unlink", normalized, callback)) return
      if (!files.has(normalized)) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")); return }
      files.delete(normalized)
      modes.delete(normalized)
      mtimes.delete(normalized)
      state.unlinks.push(normalized)
      callback(null)
    },

    rmdir (target, callback) {
      const normalized = normalize(target)
      calls.push({ method: "rmdir", path: normalized })
      if (reject("rmdir", normalized, callback)) return
      if (!dirs.has(normalized)) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")); return }
      const prefix = normalized + "/"
      for (const key of [...files.keys(), ...dirs.keys(), ...links.keys()]) {
        if (key.startsWith(prefix)) { callback(sftpError(SFTP_STATUS.FAILURE, "Failure: directory not empty")); return }
      }
      dirs.delete(normalized)
      state.rmdirs.push(normalized)
      callback(null)
    },

    chmod (target, mode, callback) {
      const normalized = normalize(target)
      calls.push({ method: "chmod", path: normalized, mode })
      if (reject("chmod", normalized, callback)) return
      if (!files.has(normalized) && !dirs.has(normalized)) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")); return }
      modes.set(normalized, mode & 0o777)
      state.chmods.push([normalized, mode & 0o777])
      callback(null)
    },
  }

  /**
   * The atomic publish, behind the OpenSSH extension.
   *
   * Present by default and absent on request; never "present but undefined",
   * because that is the shape that silently demotes every write to the
   * non-atomic fallback without a single test noticing.
   */
  const atomicRename = (from, to, callback) => {
    const source = normalize(from)
    const destination = normalize(to)
    calls.push({ method: "ext_openssh_rename", from: source, to: destination })
    if (reject("ext_openssh_rename", source, callback)) return
    if (!files.has(source)) { callback(sftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file")); return }
    files.set(destination, files.get(source))
    files.delete(source)
    if (modes.has(source)) { modes.set(destination, modes.get(source)); modes.delete(source) }
    stamp(destination)
    state.renames.push([source, destination])
    callback(null)
  }
  if (extensions) sftp.ext_openssh_rename = atomicRename

  // Anything the production code calls that is not implemented above must be
  // loud: a silent `undefined` turns "the code took a path I did not expect"
  // into a passing test.
  const channel = new Proxy(sftp, {
    get (target, property) {
      if (property in target) return target[property]
      if (typeof property !== "string") return undefined
      if (NOT_IMPLEMENTED.includes(property)) {
        return () => { throw new Error("fake-sftp: " + property + " is not implemented; add it here if a suite needs it") }
      }
      return undefined
    },
  })

  const tree = {
    files,
    dirs,
    links,
    modes,
    mtimes,
    calls,
    get writes () { return state.writes },
    get bytesWritten () { return state.bytesWritten },
    get renames () { return state.renames },
    get unlinks () { return state.unlinks },
    get rmdirs () { return state.rmdirs },
    get chmods () { return state.chmods },
    get mkdirs () { return state.mkdirs },
    get opens () { return state.opens },
    get connected () { return connected },
    /** Every write that landed, in order: `{ path, offset, length }`. */
    writeLog,

    /**
     * Allow `count` more writes, then refuse every one.
     *
     * `error` is the SFTP status the refusal carries; the default is a plain
     * failure, which is what a full disk (ENOSPC) arrives as over SFTP.
     */
    failAfterWrites (count, error) {
      writeBudget = count
      if (error !== undefined) writeBudgetError = error
    },

    /** How many bytes were written to one path. */
    bytesWrittenTo (target) {
      const real = resolve(target)
      return writeLog
        .filter(entry => entry.path === real)
        .reduce((total, entry) => total + entry.length, 0)
    },

    /** What the file at `target` holds, as UTF-8. Throws when absent. */
    read (target) {
      const real = resolve(target)
      if (!files.has(real)) throw new Error("fake-sftp: no file at " + real)
      return files.get(real).toString("utf8")
    },

    /** What the file at `target` holds, as bytes. Throws when absent. */
    bytes (target) {
      const real = resolve(target)
      if (!files.has(real)) throw new Error("fake-sftp: no file at " + real)
      return files.get(real)
    },

    has (target) { return entryAt(target) !== undefined },
    isDir (target) { return dirs.has(resolve(target)) },
    isLink (target) { return links.has(normalize(target)) },

    /** Seed or replace a file, creating parents. */
    write (target, content) { writeSeed(target, content) },

    /** Seed a directory chain. */
    mkdir (target) { mkdirSeed(target) },

    /** Seed a symbolic link. */
    link (from, to) {
      const normalized = normalize(from)
      const parent = parentOf(normalized)
      if (parent !== null) mkdirSeed(parent)
      links.set(normalized, normalize(to))
    },

    /**
     * Make the next `times` calls of `method` fail.
     *
     * `path` narrows it to one target; `code` is the SFTP status (2 ENOENT,
     * 3 EACCES, 4 FAILURE — which is what ENOSPC arrives as — 20 ENOTDIR).
     */
    fail ({ method, path: target, code = SFTP_STATUS.FAILURE, message = "Failure", times = 1 }) {
      failures.push({ method, path: target === undefined ? undefined : normalize(target), code, message, times })
    },

    /** Every subsequent call answers connection-lost. */
    breakConnection () { connected = false },

    /** Undo `breakConnection()`. */
    restoreConnection () { connected = true },

    /** Hide (or restore) the atomic-rename extension. */
    useExtensions (on) {
      extensions = on !== false
      if (extensions) sftp.ext_openssh_rename = atomicRename
      else delete sftp.ext_openssh_rename
    },

    /**
     * Stop the mtime clock advancing.
     *
     * A same-size rewrite inside one second is invisible to an ino:size:mtime
     * version, which is exactly the case a version-only conflict check cannot
     * catch. Freezing the clock reproduces it without sleeping.
     */
    freezeMtime (on) { frozenMtime = on !== false },

    /** Forget the call log and the counters, keeping the tree. */
    reset () {
      calls.length = 0
      state.writes = 0
      state.bytesWritten = 0
      state.renames.length = 0
      state.unlinks.length = 0
      state.rmdirs.length = 0
      state.chmods.length = 0
      state.mkdirs.length = 0
      state.opens.length = 0
      writeLog.length = 0
    },
  }

  /** A plain-data view of the tree, for comparing two moments. */
  const snapshot = () => ({
    files: [...files.entries()]
      .map(([path, bytes]) => [path, bytes.toString("utf8")])
      .sort((left, right) => left[0].localeCompare(right[0])),
    dirs: [...dirs].sort(),
    links: [...links.entries()].sort((left, right) => left[0].localeCompare(right[0])),
    modes: [...modes.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  })

  return { sftp: channel, tree, snapshot }
}

/**
 * An engine whose only job is to hand the double to `withSftp`.
 *
 * `lib/fs/remote-fs.js` reaches SFTP exclusively through
 * `engine.withSftp(alias, operation, options)`, so this is the whole surface a
 * suite needs to drive the real write path without a host. Suites that also
 * assert on capability probes can pass their own answers.
 *
 * @param {object} sftp - the channel from `createFakeSftp`.
 * @param {object} [options] - overrides.
 * @param {object} [options.capabilities] - what `probeCapabilities` answers.
 * @returns {object} an engine-shaped object.
 */
export function fakeSftpEngine (sftp, options = {}) {
  // `diagnostics.record` is not decoration: `#noteHostLocalCapture` calls it on
  // every remote write, and a double without it crashes the write path rather
  // than exercising it. Keeping the notes also lets a suite assert what was
  // reported without a logger.
  const notes = []
  return {
    async withSftp (_alias, operation) { return await operation(sftp) },
    capabilities: new Map(),
    async probeCapabilities () { return options.capabilities ?? { rg: true, git: true, inotifywait: true } },
    async assertNotDisabled () {},
    notes,
    diagnostics: {
      record (kind, detail) { notes.push({ kind, detail }) },
      emit () {},
    },
  }
}

/**
 * An engine over a `{dirs, files}` tree, on the shared in-memory SFTP.
 *
 * Fixtures are easier to write the way a reader thinks about a tree (`dirs`
 * maps a directory to its entries, `files` maps a path to its bytes) than as a
 * flat path set. This adapter is the only place that has to know both shapes,
 * and it lives next to the double it drives so a second suite that wants a
 * tree-shaped fixture does not have to rediscover the conversion.
 *
 * A symlink is seeded with a target that does NOT exist. The archive walk is
 * supposed to notice the entry is a link and skip it; a resolvable target would
 * let a walk that FOLLOWS links still produce the right archive.
 *
 * @param {{dirs: Map<string, object[]>, files: Map<string, Buffer>}} tree - the fixture.
 * @returns {object} an engine over a fake SFTP channel.
 */
export function fakeSftpEngineFromTree (tree) {
  const dirs = []
  const files = []
  const links = []
  for (const [dir, entries] of tree.dirs) {
    dirs.push(dir)
    for (const entry of entries) {
      const child = dir + '/' + entry.name
      if (entry.dir === true) dirs.push(child)
      else if (entry.link === true) links.push([child, '/nonexistent-link-target'])
      else files.push([child, tree.files.get(child) ?? Buffer.alloc(entry.size ?? 0)])
    }
  }
  for (const [file, content] of tree.files) {
    if (!files.some(([seeded]) => seeded === file)) files.push([file, content])
  }
  return fakeSftpEngine(createFakeSftp({ dirs, files, links }).sftp)
}
