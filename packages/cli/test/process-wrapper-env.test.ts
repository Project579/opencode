import { describe, expect, test } from "bun:test"
import { ServerProcess } from "../src/server-process"

describe("processWrapper", () => {
  test.each([undefined, "", "[]"])("%p means no wrapper", (raw) => {
    expect(ServerProcess.processWrapper(raw)).toBeUndefined()
  })

  test("reads a JSON array of strings", () => {
    expect(ServerProcess.processWrapper('["w","--"]')).toEqual(["w", "--"])
  })

  test.each(['"w"', "[1]", "not json"])("rejects %p naming the variable", (raw) => {
    expect(() => ServerProcess.processWrapper(raw)).toThrow(
      "OPENCODE_EXPERIMENTAL_PROCESS_WRAPPER must be a JSON array of strings",
    )
  })
})
