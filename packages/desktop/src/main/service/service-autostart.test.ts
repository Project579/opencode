import { describe, expect, test } from "bun:test"
import { serviceAutostart } from "./service-autostart"

describe("serviceAutostart", () => {
  test.each([
    [undefined, true],
    ["", true],
    ["1", true],
    ["true", true],
    ["no", true],
    ["0", false],
    ["false", false],
  ])("OPENCODE_EXPERIMENTAL_SERVICE_AUTOSTART=%p starts the service: %p", (value, expected) => {
    expect(serviceAutostart(value)).toBe(expected)
  })
})
