import { expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OPENCODE_PASSWORD
  const previousLegacyPassword = process.env.OPENCODE_SERVER_PASSWORD
  const previousValue = process.env.OPENCODE_SESSION_ENV_TEST
  process.env.OPENCODE_PASSWORD = "password"
  process.env.OPENCODE_SERVER_PASSWORD = "legacy"
  process.env.OPENCODE_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD
  else process.env.OPENCODE_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.OPENCODE_SESSION_ENV_TEST
  else process.env.OPENCODE_SESSION_ENV_TEST = previousValue

  expect(environment.OPENCODE_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SESSION_ENV_TEST).toBe("included")
})

test("service autostart turns off only for 0 or false", () => {
  const autostart = (env: Record<string, string>) =>
    Effect.runSync(Env.serviceAutostart.parse(ConfigProvider.fromEnv({ env })))

  expect(autostart({})).toBe(true)
  expect(autostart({ OPENCODE_EXPERIMENTAL_SERVICE_AUTOSTART: "0" })).toBe(false)
  expect(autostart({ OPENCODE_EXPERIMENTAL_SERVICE_AUTOSTART: "false" })).toBe(false)
  expect(autostart({ OPENCODE_EXPERIMENTAL_SERVICE_AUTOSTART: "1" })).toBe(true)
  expect(autostart({ OPENCODE_EXPERIMENTAL_SERVICE_AUTOSTART: "" })).toBe(true)
  expect(autostart({ OPENCODE_EXPERIMENTAL_SERVICE_AUTOSTART: "no" })).toBe(true)
})
