import { afterEach, expect, test } from "bun:test"
import { ConfigProvider, Effect, Redacted } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Env } from "../src/env"

const dirs: string[] = []

afterEach(() => {
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
})

function secret(content: string, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-password-"))
  dirs.push(dir)
  const file = path.join(dir, "password")
  fs.writeFileSync(file, content)
  fs.chmodSync(file, mode)
  return file
}

const resolve = (env: Record<string, string>) =>
  Effect.runPromise(Env.password.parse(ConfigProvider.fromEnv({ env }))).then((value) => value && Redacted.value(value))

const fail = (env: Record<string, string>) =>
  Effect.runPromise(Effect.flip(Env.password.parse(ConfigProvider.fromEnv({ env }))))

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OPENCODE_PASSWORD
  const previousLegacyPassword = process.env.OPENCODE_SERVER_PASSWORD
  const previousPasswordFile = process.env.OPENCODE_PASSWORD_FILE
  const previousValue = process.env.OPENCODE_SESSION_ENV_TEST
  process.env.OPENCODE_PASSWORD = "password"
  process.env.OPENCODE_SERVER_PASSWORD = "legacy"
  process.env.OPENCODE_PASSWORD_FILE = "/run/secrets/opencode"
  process.env.OPENCODE_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD
  else process.env.OPENCODE_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = previousLegacyPassword
  if (previousPasswordFile === undefined) delete process.env.OPENCODE_PASSWORD_FILE
  else process.env.OPENCODE_PASSWORD_FILE = previousPasswordFile
  if (previousValue === undefined) delete process.env.OPENCODE_SESSION_ENV_TEST
  else process.env.OPENCODE_SESSION_ENV_TEST = previousValue

  expect(environment.OPENCODE_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_PASSWORD_FILE).toBeUndefined()
  expect(environment.OPENCODE_SESSION_ENV_TEST).toBe("included")
})

// The password file reader rejects Windows, which lacks the POSIX ownership and mode semantics it relies on.
test.skipIf(process.platform === "win32")(
  "password prefers OPENCODE_PASSWORD, then OPENCODE_SERVER_PASSWORD, then OPENCODE_PASSWORD_FILE",
  async () => {
    const file = secret("from-file\n")
    expect(
      await resolve({ OPENCODE_PASSWORD: "plain", OPENCODE_SERVER_PASSWORD: "legacy", OPENCODE_PASSWORD_FILE: file }),
    ).toBe("plain")
    expect(await resolve({ OPENCODE_SERVER_PASSWORD: "legacy", OPENCODE_PASSWORD_FILE: file })).toBe("legacy")
    expect(await resolve({ OPENCODE_PASSWORD_FILE: file })).toBe("from-file")
    expect(await resolve({})).toBeUndefined()
    // A plain password never opens the file.
    expect(await resolve({ OPENCODE_PASSWORD: "plain", OPENCODE_PASSWORD_FILE: secret("x", 0o644) })).toBe("plain")
  },
)

// The password file reader rejects Windows, which lacks the POSIX ownership and mode semantics it relies on.
test.skipIf(process.platform === "win32")(
  "an unusable OPENCODE_PASSWORD_FILE fails instead of falling through",
  async () => {
    expect((await fail({ OPENCODE_PASSWORD_FILE: secret("x", 0o644) })).message).toContain("mode")
    expect((await fail({ OPENCODE_PASSWORD_FILE: "/nonexistent/opencode-password" })).message).toContain("missing")
  },
)
