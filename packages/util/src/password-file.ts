import fs from "node:fs"

export type PasswordFileReason =
  | "missing"
  | "symlink"
  | "type"
  | "owner"
  | "mode"
  | "size"
  | "empty"
  | "unreadable"
  | "platform"

export class PasswordFileError extends Error {
  override readonly name = "PasswordFileError"

  constructor(
    readonly reason: PasswordFileReason,
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`Password file ${path} rejected: ${reason}`, options)
  }
}

const MAX_BYTES = 4096

/**
 * Reads a server password from a file that only its owner can access. Throws only `PasswordFileError`.
 */
export function readPasswordFile(path: string): string {
  if (process.platform === "win32") throw new PasswordFileError("platform", path)
  const fd = openFile(path)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new PasswordFileError("type", path)
    if (stat.uid !== process.getuid?.()) throw new PasswordFileError("owner", path)
    if (stat.mode & 0o077) throw new PasswordFileError("mode", path)
    if (stat.size > MAX_BYTES) throw new PasswordFileError("size", path)
    const buffer = Buffer.alloc(MAX_BYTES)
    let length = 0
    while (length < MAX_BYTES) {
      const read = fs.readSync(fd, buffer, length, MAX_BYTES - length, null)
      if (read === 0) break
      length += read
    }
    const password = buffer.toString("utf8", 0, length).trim()
    if (!password) throw new PasswordFileError("empty", path)
    return password
  } catch (error) {
    if (error instanceof PasswordFileError) throw error
    throw new PasswordFileError("unreadable", path, { cause: error })
  } finally {
    fs.closeSync(fd)
  }
}

function openFile(path: string) {
  try {
    return fs.openSync(
      path,
      // O_NOFOLLOW: a symlink must not redirect the read. O_NONBLOCK: opening a FIFO with no writer would
      // otherwise block the caller (the Electron main process) forever; the type check then rejects it.
      // O_RDONLY: the file is never written.
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") throw new PasswordFileError("missing", path, { cause: error })
    if (code === "ELOOP") throw new PasswordFileError("symlink", path, { cause: error })
    throw new PasswordFileError("unreadable", path, { cause: error })
  }
}
