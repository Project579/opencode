import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import type { Info } from "@opencode/schema/tool"
import { Effect, Schema, type Types } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const installed = { type: "package", target: "acme" } as const

// Tools are direct (not Code Mode) unless a test says otherwise, so they can be called by name.
const make = (name: string, options: Tool.Options = { codemode: false }): Info => ({
  name,
  description: name,
  input: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ content: text }),
  options,
})

const call = (name: string, input: unknown = { text: name }): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID: Session.ID.make("ses_tool_hook_owner"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_tool_hook_owner"),
  call: { type: "tool-call", id: `call-${name}`, name, input },
})

/** Runs the direct call and returns what `execute.before` reported for it. */
const observe = (name: string) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const tools = yield* Tool.Service
    const seen: Array<{ tool: string; experimental: unknown }> = []
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void seen.push({ tool: event.tool, experimental: { ...event.experimental } })),
    )
    yield* (yield* tools.snapshot()).execute(call(name))
    return seen
  })

it.live("a tool an installed plugin adds reports that plugin's id", () =>
  Effect.gen(function* () {
    const host = yield* PluginHost.make(yield* Plugin.Service, "acme", installed)
    yield* host.tool.transform((editor) => editor.add(make("deploy")))
    expect(yield* observe("deploy")).toEqual([{ tool: "deploy", experimental: { plugin: "acme", selfChecks: false } }])
  }),
)

it.live("built-in and MCP tools report no plugin", () =>
  Effect.gen(function* () {
    const builtin = yield* PluginHost.make(yield* Plugin.Service, "core")
    yield* builtin.tool.transform((editor) => editor.add(make("read")))
    // MCP tools register on the Tool service directly, without a plugin host.
    yield* (yield* Tool.Service).transform((editor) => editor.add(make("server_search")))
    const read = yield* observe("read")
    const mcp = yield* observe("server_search")
    expect(read[0]?.experimental).toEqual({ selfChecks: false })
    expect(mcp[0]?.experimental).toEqual({ selfChecks: false })
  }),
)

it.live("selfChecks is true for a tool that sets options.experimental.permission.self", () =>
  Effect.gen(function* () {
    const host = yield* PluginHost.make(yield* Plugin.Service, "acme", installed)
    yield* host.tool.transform((editor) =>
      editor.add(make("careful", { codemode: false, experimental: { permission: { self: true } } })),
    )
    expect((yield* observe("careful"))[0]?.experimental).toEqual({ plugin: "acme", selfChecks: true })
  }),
)

it.live("a Code Mode inner call reports the same values as a direct call", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const tools = yield* Tool.Service
    const host = yield* PluginHost.make(yield* Plugin.Service, "acme", installed)
    const options = { experimental: { permission: { self: true } } } as const
    yield* host.tool.transform((editor) => {
      editor.add(make("direct", { codemode: false, ...options }))
      editor.add(make("inner", { codemode: true, ...options }))
    })
    const seen: Array<{ tool: string; experimental: unknown }> = []
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void seen.push({ tool: event.tool, experimental: { ...event.experimental } })),
    )
    const snapshot = yield* tools.snapshot()
    yield* snapshot.execute(call("direct"))
    yield* snapshot.execute(call("execute", { code: 'return await tools.inner({ text: "inner" })' }))
    const inner = seen.filter((event) => event.tool !== "execute")
    expect(inner).toHaveLength(2)
    expect(inner[1]?.experimental).toEqual(inner[0]?.experimental)
    expect(inner[1]?.experimental).toEqual({ plugin: "acme", selfChecks: true })
  }),
)

it.live("an installed plugin cannot set or clear the owner when it adds a tool", () =>
  Effect.gen(function* () {
    const host = yield* PluginHost.make(yield* Plugin.Service, "acme", installed)
    yield* host.tool.transform((editor) => {
      editor.add(make("spoofed", { codemode: false, experimental: { plugin: "other" } }))
      editor.add(make("cleared", { codemode: false, experimental: { plugin: undefined } }))
    })
    expect((yield* observe("spoofed"))[0]?.experimental).toMatchObject({ plugin: "acme" })
    expect((yield* observe("cleared"))[0]?.experimental).toMatchObject({ plugin: "acme" })
  }),
)

it.live("an installed plugin that updates a built-in tool becomes its owner", () =>
  Effect.gen(function* () {
    const builtin = yield* PluginHost.make(yield* Plugin.Service, "core")
    yield* builtin.tool.transform((editor) => editor.add(make("read")))
    const host = yield* PluginHost.make(yield* Plugin.Service, "acme", installed)
    yield* host.tool.transform((editor) =>
      editor.update("read", (tool) => {
        tool.options = { ...tool.options, experimental: { plugin: "other" } }
      }),
    )
    expect((yield* observe("read"))[0]?.experimental).toMatchObject({ plugin: "acme" })
  }),
)

it.live("a hook cannot change the owner that later hooks see", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const host = yield* PluginHost.make(yield* Plugin.Service, "acme", installed)
    yield* host.tool.transform((editor) => editor.add(make("deploy")))
    const later: unknown[] = []
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => {
        Reflect.set(event.experimental as Types.Mutable<object>, "plugin", "evil")
        Reflect.set(event, "experimental", { plugin: undefined })
      }),
    )
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void later.push({ ...event.experimental })),
    )
    yield* (yield* (yield* Tool.Service).snapshot()).execute(call("deploy"))
    expect(later).toEqual([{ plugin: "acme", selfChecks: false }])
  }),
)
