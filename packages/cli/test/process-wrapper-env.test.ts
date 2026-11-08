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

describe("takeProcessWrapper", () => {
  test("reads the wrapper and removes the variable so children do not inherit it", () => {
    const env: Record<string, string | undefined> = {
      OPENCODE_EXPERIMENTAL_PROCESS_WRAPPER: '["w","--"]',
      OTHER: "kept",
    }
    expect(ServerProcess.takeProcessWrapper(env)).toEqual(["w", "--"])
    expect(env).toEqual({ OTHER: "kept" })
  })

  test("returns no wrapper and leaves the environment alone when the variable is unset", () => {
    const env: Record<string, string | undefined> = { OTHER: "kept" }
    expect(ServerProcess.takeProcessWrapper(env)).toBeUndefined()
    expect(env).toEqual({ OTHER: "kept" })
  })

  test("removes an empty wrapper", () => {
    const env: Record<string, string | undefined> = { OPENCODE_EXPERIMENTAL_PROCESS_WRAPPER: "[]" }
    expect(ServerProcess.takeProcessWrapper(env)).toBeUndefined()
    expect(env).toEqual({})
  })

  test("still rejects an invalid value naming the variable", () => {
    const env: Record<string, string | undefined> = { OPENCODE_EXPERIMENTAL_PROCESS_WRAPPER: "not json" }
    expect(() => ServerProcess.takeProcessWrapper(env)).toThrow(
      "OPENCODE_EXPERIMENTAL_PROCESS_WRAPPER must be a JSON array of strings",
    )
  })
})
