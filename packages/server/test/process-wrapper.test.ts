import { mkdtempSync, rmSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Mcp } from "@opencode/core/mcp/index"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { Context, Effect, Layer, Schedule } from "effect"
import { ChildProcess } from "effect/process"
import { HttpRouter, HttpServer } from "effect/http"
import { createServer } from "node:http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it, testEffect } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

const wrapperScript = path.join(import.meta.dir, "../../core/test/fixture/record-wrapper.sh")
const headers = { authorization: `Basic ${btoa("opencode:secret")}` }

const serve = Effect.fnUntraced(function* (wrapper: ReadonlyArray<string>, config: object) {
  const directory = (yield* tmpdirScoped("opencode-process-wrapper-")).path
  const context = yield* Layer.build(
    createRoutes({
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
      models: { fetch: false },
      config: { directory, project: false, content: JSON.stringify(config) },
      fs: { filewatcher: false },
      experimental: { process: { wrapper } },
    }).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices)),
  )
  const server = createServer()
  const http = yield* NodeHttpServer.make(() => server, { port: 0, host: "127.0.0.1" })
  yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
  yield* http
    .serve(Context.get(context, HttpRouter.HttpRouter).asHttpEffect())
    .pipe(Effect.provide(NodeHttpServer.layerHttpServices))
  return {
    directory,
    base: HttpServer.formatAddress(http.address),
    inLocation: <A, E>(effect: Effect.Effect<A, E, Mcp.Service>) =>
      effect.pipe(
        Effect.provide(
          LocationServiceMap.Service.get(
            LocationServiceMap.canonical(Location.Ref.make({ directory: directory as Location.Ref["directory"] })),
          ),
        ),
        Effect.provideContext(context),
      ),
  }
})

const lines = (log: string) =>
  Effect.tryPromise(() => fs.readFile(log, "utf8")).pipe(
    Effect.map((text) => text.split("\n").filter(Boolean)),
    Effect.orElseSucceed(() => [] as Array<string>),
  )

// The wrapper writes its log before it runs the command, so a line proves the command is about to start.
const logged = (log: string) =>
  lines(log).pipe(
    Effect.repeat({ until: (found) => found.length >= 1, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("10 seconds"),
  )

describe.skipIf(process.platform === "win32")("experimental.process.wrapper", () => {
  it.live(
    "wraps a configured stdio MCP server, which still answers tools/list",
    () =>
      Effect.gen(function* () {
        const log = path.join((yield* tmpdirScoped("opencode-process-wrapper-log-")).path, "wrapper.log")
        const mcp = path.join(import.meta.dir, "fixture", "mcp-tool.cjs")
        const server = yield* serve([wrapperScript, log], {
          mcp: { servers: { wrapped: { type: "local", command: [process.execPath, mcp] } } },
        })
        const tools = () => Effect.runPromise(server.inLocation(Mcp.Service.use((service) => service.tools())))

        yield* Effect.promise(() =>
          fetch(new URL(`/api/mcp?${new URLSearchParams({ "location[directory]": server.directory })}`, server.base), {
            headers,
          }),
        )
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 10_000
          while ((await tools()).length === 0 && Date.now() < deadline) await Bun.sleep(25)
        })
        expect((yield* Effect.promise(tools)).map((tool) => [tool.server, tool.name])).toEqual([["wrapped", "ping"]])
        expect(yield* lines(log)).toEqual([`${process.execPath} ${mcp}`])
      }),
    20_000,
  )

  it.live(
    "wraps a command run through shell.create exactly once",
    () =>
      Effect.gen(function* () {
        const log = path.join((yield* tmpdirScoped("opencode-process-wrapper-log-")).path, "wrapper.log")
        const server = yield* serve([wrapperScript, log], { permission: { shell: "allow" } })
        const response = yield* Effect.promise(() =>
          fetch(
            new URL(`/api/shell?${new URLSearchParams({ "location[directory]": server.directory })}`, server.base),
            {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ command: "printf wrapped" }),
            },
          ),
        )
        expect(response.status).toBe(200)
        const found = yield* logged(log)
        expect(found).toHaveLength(1)
        expect(found[0]).toContain("printf wrapped")
      }),
    20_000,
  )

  describe("AppProcess", () => {
    // The layer is built at definition time, so the log directory is too.
    const root = mkdtempSync(path.join(os.tmpdir(), "opencode-process-wrapper-"))
    afterAll(() => rmSync(root, { recursive: true, force: true }))
    const log = path.join(root, "bypass.log")
    const wrapped = testEffect(
      LayerNode.compile(AppProcess.node, {
        replacements: [CrossSpawnSpawner.node.replace(CrossSpawnSpawner.configured({ wrapper: [wrapperScript, log] }))],
      }),
    )
    wrapped.live("does not wrap a command run under Bypass, which crosses AppProcess.run", () =>
      Effect.gen(function* () {
        const processes = yield* AppProcess.Service
        const run = processes.run(ChildProcess.make("echo", ["hi"]))
        yield* run.pipe(Effect.provideService(CrossSpawnSpawner.Bypass, true))
        expect(yield* lines(log)).toEqual([])
        yield* run
        expect(yield* lines(log)).toEqual(["echo hi"])
      }),
    )
  })
})
