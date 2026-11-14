import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PasswordFileError, readPasswordFile } from "./password-file.js"

// Windows lacks O_NOFOLLOW, POSIX modes and FIFOs, and the reader rejects it.
describe.skipIf(process.platform === "win32")("readPasswordFile", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-password-file-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // chmod after writing so the umask does not matter.
  function write(name: string, content: string, mode = 0o600) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    fs.chmodSync(file, mode)
    return file
  }

  function symlink(target: string, name: string) {
    const file = path.join(dir, name)
    fs.symlinkSync(target, file)
    return file
  }

  function mkdir(name: string, mode: number) {
    const file = path.join(dir, name)
    fs.mkdirSync(file, { mode })
    return file
  }

  function mkfifo(name: string) {
    const file = path.join(dir, name)
    expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0)
    return file
  }

  function reason(file: string) {
    try {
      readPasswordFile(file)
    } catch (error) {
      if (error instanceof PasswordFileError) return error.reason
      throw error
    }
    throw new Error("readPasswordFile did not throw")
  }

  test.each([
    ["newline", "secret\n"],
    ["CRLF", "secret\r\n"],
    ["spaces", "  secret \n"],
  ])("accepts a 0600 file and trims surrounding whitespace (%s)", (_, content) => {
    expect(readPasswordFile(write("pw", content))).toBe("secret")
  })

  test("accepts a file of exactly 4096 bytes", () => {
    expect(readPasswordFile(write("pw", "a".repeat(4096)))).toBe("a".repeat(4096))
  })

  test.each([
    ["group-readable 0640", () => write("pw", "secret", 0o640), "mode"],
    ["world-readable 0604", () => write("pw", "secret", 0o604), "mode"],
    ["symlink to a 0600 file", () => symlink(write("target", "secret"), "link"), "symlink"],
    ["directory", () => mkdir("dir", 0o700), "type"],
    ["FIFO", () => mkfifo("fifo"), "type"], // Review Focus 2: must not block in open
    ["over 4 KiB", () => write("pw", "a".repeat(4097)), "size"],
    ["whitespace only", () => write("pw", " \n"), "empty"],
    ["missing", () => path.join(dir, "absent"), "missing"],
  ] as const)("rejects files it cannot trust: %s", (_, make, expected) => {
    expect(reason(make())).toBe(expected)
  })
})
