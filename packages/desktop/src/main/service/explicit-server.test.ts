import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { configured, connectExplicit, explicitServer, shellOverrides } from "./explicit-server"

const SERVER = "OPENCODE_EXPERIMENTAL_DESKTOP_SERVER"
const FILE = "OPENCODE_PASSWORD_FILE"

let server: ReturnType<typeof Bun.serve> | undefined
let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "explicit-server-"))
})

afterEach(() => {
  server?.stop(true)
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

function stub(respond: () => Response) {
  const requests: { path: string; authorization: string | null }[] = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
      return respond()
    },
  })
  return { origin: `http://127.0.0.1:${server.port}`, requests }
}

function write(name: string, content: string, mode = 0o600) {
  const file = path.join(dir, name)
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

function start(env: Record<string, string | undefined>) {
  const explicit = explicitServer(env)
  if (!explicit) throw new Error("expected explicit mode")
  return explicit
}

function connect(env: Record<string, string | undefined>, bundled: string | undefined = "1.0.0") {
  return Effect.runPromise(connectExplicit(start(env), bundled))
}

function failure(env: Record<string, string | undefined>) {
  return Effect.runPromise(Effect.flip(connectExplicit(start(env), "1.0.0")))
}

const passwords = { OPENCODE_PASSWORD: "plain", OPENCODE_SERVER_PASSWORD: "legacy", [FILE]: "/run/opencode/pw" }

describe("explicit server environment", () => {
  test.each([
    { name: "unset", env: { ...passwords }, expected: undefined, remaining: { ...passwords } },
    {
      name: "empty",
      env: { [SERVER]: "", ...passwords },
      expected: undefined,
      remaining: { [SERVER]: "", ...passwords },
    },
    {
      name: "127.0.0.1",
      env: { [SERVER]: "http://127.0.0.1:4096", ...passwords },
      expected: { type: "valid", origin: "http://127.0.0.1:4096", password: "plain", passwordFile: "/run/opencode/pw" },
      remaining: { [SERVER]: "http://127.0.0.1:4096", [FILE]: "/run/opencode/pw" },
    },
    {
      name: "localhost with trailing slash",
      env: { [SERVER]: "http://localhost:4096/", OPENCODE_SERVER_PASSWORD: "legacy" },
      expected: { type: "valid", origin: "http://localhost:4096", password: "legacy", passwordFile: undefined },
      remaining: { [SERVER]: "http://localhost:4096/" },
    },
    {
      // An empty variable counts as unset, the same as in the CLI.
      name: "empty OPENCODE_PASSWORD falls through",
      env: { [SERVER]: "http://127.0.0.1:4096", OPENCODE_PASSWORD: "", OPENCODE_SERVER_PASSWORD: "legacy" },
      expected: { type: "valid", origin: "http://127.0.0.1:4096", password: "legacy", passwordFile: undefined },
      remaining: { [SERVER]: "http://127.0.0.1:4096" },
    },
    {
      name: "empty password variables fall through to an empty file variable",
      env: { [SERVER]: "http://127.0.0.1:4096", OPENCODE_PASSWORD: "", OPENCODE_SERVER_PASSWORD: "", [FILE]: "" },
      expected: { type: "valid", origin: "http://127.0.0.1:4096", password: undefined, passwordFile: undefined },
      remaining: { [SERVER]: "http://127.0.0.1:4096", [FILE]: "" },
    },
    ...[
      "https://127.0.0.1:4096",
      "http://example.com:4096",
      "http://[::1]:4096",
      "http://127.0.0.1:4096/api",
      "http://127.0.0.1:4096/?a=1",
      "http://user:pw@127.0.0.1:4096",
      "not a url",
    ].map((value) => ({
      name: value,
      env: { [SERVER]: value, ...passwords },
      expected: { type: "invalid" },
      remaining: { [SERVER]: value, [FILE]: "/run/opencode/pw" },
    })),
  ])("reads the launch environment: $name", (row) => {
    const env: Record<string, string | undefined> = { ...row.env }
    expect(explicitServer(env)).toEqual(row.expected as ReturnType<typeof explicitServer>)
    expect(configured()).toEqual(row.expected as ReturnType<typeof explicitServer>)
    expect(env).toEqual(row.remaining)
  })
})

describe("explicit server connect", () => {
  test("connects with the password and returns the origin", async () => {
    const { origin, requests } = stub(() => Response.json({ version: "1.0.0", pid: 1, urls: [], paths: {} }))
    expect(await connect({ [SERVER]: origin, OPENCODE_PASSWORD: "secret" })).toEqual({
      url: origin,
      password: "secret",
    })
    expect(requests).toEqual([
      { path: "/api/info", authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}` },
    ])
  })

  test("sends no Authorization header without a password", async () => {
    const { origin, requests } = stub(() => Response.json({ version: "1.0.0" }))
    expect(await connect({ [SERVER]: origin })).toEqual({ url: origin, password: null })
    expect(requests).toEqual([{ path: "/api/info", authorization: null }])
  })

  test.each([
    {
      name: "401",
      respond: () => new Response(null, { status: 401 }),
      message: (o: string) => `The OpenCode server at ${o} rejected the password`,
    },
    {
      name: "404",
      respond: () => new Response(null, { status: 404 }),
      message: (o: string) => `The server at ${o} is not a compatible OpenCode server`,
    },
    {
      name: "503",
      respond: () => new Response(null, { status: 503, headers: { "retry-after": "1" } }),
      message: (o: string) => `The OpenCode server at ${o} is not reachable or not ready`,
    },
    {
      name: "500",
      respond: () => new Response(null, { status: 500 }),
      message: (o: string) => `The OpenCode server at ${o} is not reachable or not ready`,
    },
    {
      name: "502",
      respond: () => new Response(null, { status: 502 }),
      message: (o: string) => `The OpenCode server at ${o} is not reachable or not ready`,
    },
    {
      name: "504",
      respond: () => new Response(null, { status: 504 }),
      message: (o: string) => `The OpenCode server at ${o} is not reachable or not ready`,
    },
    // Review Focus 1: something else listens on the port.
    {
      name: "200 without version",
      respond: () => Response.json({}),
      message: (o: string) => `The server at ${o} is not a compatible OpenCode server`,
    },
    {
      name: "200 HTML",
      respond: () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      message: (o: string) => `The server at ${o} is not a compatible OpenCode server`,
    },
  ])("maps failed probes to errors: $name", async (row) => {
    const { origin } = stub(row.respond)
    expect((await failure({ [SERVER]: origin, OPENCODE_PASSWORD: "secret" })).message).toBe(row.message(origin))
  })

  test("a closed port is unavailable", async () => {
    const { origin } = stub(() => Response.json({ version: "1.0.0" }))
    server?.stop(true)
    expect((await failure({ [SERVER]: origin })).message).toBe(
      `The OpenCode server at ${origin} is not reachable or not ready`,
    )
  })

  test("connects despite a version mismatch", async () => {
    const { origin } = stub(() => Response.json({ version: "0.0.1" }))
    expect(await connect({ [SERVER]: origin }, "9.9.9")).toEqual({ url: origin, password: null })
  })

  test("an invalid value fails every connect without a request", async () => {
    const { origin, requests } = stub(() => Response.json({ version: "1.0.0" }))
    const message = "OPENCODE_EXPERIMENTAL_DESKTOP_SERVER must be http://127.0.0.1:<port> or http://localhost:<port>"
    // Points at the stub, so a bug that accepted the path would reach it.
    expect((await failure({ [SERVER]: `${origin}/api` })).message).toBe(message)
    expect(requests).toEqual([])
  })

  // Review Focus 5
  test("prefers a plain password without opening the file", async () => {
    const { origin } = stub(() => Response.json({ version: "1.0.0" }))
    expect(await connect({ [SERVER]: origin, OPENCODE_PASSWORD: "plain", [FILE]: "/nonexistent/pw" })).toEqual({
      url: origin,
      password: "plain",
    })
  })

  // The password file reader rejects Windows, and the platform lacks the POSIX file modes these tests need.
  test.skipIf(process.platform === "win32")("re-reads the password file on every connect", async () => {
    const { origin } = stub(() => Response.json({ version: "1.0.0" }))
    const explicit = start({ [SERVER]: origin, [FILE]: write("pw", "one\n") })
    expect(await Effect.runPromise(connectExplicit(explicit, "1.0.0"))).toEqual({ url: origin, password: "one" })
    write("pw", "two\n")
    expect(await Effect.runPromise(connectExplicit(explicit, "1.0.0"))).toEqual({ url: origin, password: "two" })
  })

  test.skipIf(process.platform === "win32")("an unsafe password file fails without a request", async () => {
    const { origin, requests } = stub(() => Response.json({ version: "1.0.0" }))
    const file = write("pw", "secret", 0o644)
    expect((await failure({ [SERVER]: origin, [FILE]: file })).message).toBe(
      `Cannot use the password file ${file}: it must be a regular file owned by you and readable only by you`,
    )
    expect(requests).toEqual([])
  })
})

describe("explicit server shell merge", () => {
  // Review Focus 3
  test("keeps server variables and explicit-mode passwords out of the shell merge", () => {
    const shell = {
      PATH: "/bin",
      [SERVER]: "http://127.0.0.1:1",
      [FILE]: "/x",
      OPENCODE_PASSWORD: "p",
      OPENCODE_SERVER_PASSWORD: "l",
    }
    explicitServer({})
    expect(shellOverrides(shell)).toEqual({ PATH: "/bin", OPENCODE_PASSWORD: "p", OPENCODE_SERVER_PASSWORD: "l" })
    explicitServer({ [SERVER]: "http://127.0.0.1:4096" })
    expect(shellOverrides(shell)).toEqual({ PATH: "/bin" })
  })
})
