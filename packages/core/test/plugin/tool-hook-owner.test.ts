import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import type { Info } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const builtin = { type: "builtin" } as const
const installed = { type: "package", target: "acme" } as const

// Tools are direct (not Code Mode) unless a test says otherwise, so they can be called by name.
const make = (name: string, options: Tool.Options = { codemode: false }): Info => ({
  name,
  description: name,
  input: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ content: `${name}:${text}` }),
  options,
})

const call = (name: string, input: unknown = { text: name }): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID: Session.ID.make("ses_tool_hook_owner"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_tool_hook_owner"),
  call: { type: "tool-call", id: `call-${name}`, name, input },
})

/** Records what each `execute.before` hook sees, then runs the call. */
const observe = (name: string, input?: unknown) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const tools = yield* Tool.Service
    const seen: Array<{ tool: string; experimental: unknown }> = []
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void seen.push({ tool: event.tool, experimental: { ...event.experimental } })),
    )
    const snapshot = yield* tools.snapshot()
    const result = yield* snapshot.execute(call(name, input))
    return { seen, result }
  })

it.live("a tool an installed plugin adds reports that plugin's id", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, "acme", installed)
    yield* host.tool.transform((editor) => editor.add(make("deploy")))
    const observed = yield* observe("deploy")
    expect(observed.seen).toEqual([
      { tool: "deploy", experimental: { plugin: "acme", addedBy: "acme", selfChecks: false } },
    ])
  }),
)

it.live("built-in and MCP tools report no plugin", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const core = yield* PluginHost.make(plugins, "core", builtin)
    yield* core.tool.transform((editor) => editor.add(make("read")))
    // MCP tools register on the Tool service directly, without a plugin host.
    yield* tools.transform((editor) => editor.add(make("server_search")))
    const read = yield* observe("read")
    const mcp = yield* observe("server_search")
    expect(read.seen[0]?.experimental).toEqual({ selfChecks: false })
    expect(mcp.seen[0]?.experimental).toEqual({ selfChecks: false })
  }),
)

it.live("selfChecks is true for a tool that sets options.experimental.permission.self", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, "acme", installed)
    yield* host.tool.transform((editor) =>
      editor.add(make("careful", { codemode: false, experimental: { permission: { self: true } } })),
    )
    const observed = yield* observe("careful")
    expect(observed.seen[0]?.experimental).toEqual({ plugin: "acme", addedBy: "acme", selfChecks: true })
  }),
)

it.live("a Code Mode inner call reports the same values as a direct call", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const tools = yield* Tool.Service
    const host = yield* PluginHost.make(plugins, "acme", installed)
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
    expect(inner[1]?.experimental).toEqual({ plugin: "acme", addedBy: "acme", selfChecks: true })
  }),
)

it.live("a plugin cannot forge or clear the owner through the tools it can reach", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, "acme", installed)
    const kept: Array<{ options?: unknown }> = []
    yield* host.tool.transform((editor) => {
      editor.add(make("deploy"))
      editor.update("deploy", (tool) => void kept.push(tool))
      // Live objects from get and list, and a kept update reference, can be rewritten but carry no owner.
      const forged = { codemode: false, experimental: { plugin: "other" } }
      Object.assign(editor.get("deploy") ?? {}, { options: forged })
      Object.assign(editor.list()[0] ?? {}, { options: forged })
    })
    Object.assign(kept[0] ?? {}, { options: { codemode: false, experimental: { plugin: undefined } } })
    expect((yield* observe("deploy")).seen[0]?.experimental).toMatchObject({ plugin: "acme", addedBy: "acme" })
  }),
)

it.live("an installed plugin that updates a built-in tool becomes its owner", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const core = yield* PluginHost.make(plugins, "core", builtin)
    yield* core.tool.transform((editor) => editor.add(make("read")))
    const host = yield* PluginHost.make(plugins, "acme", installed)
    yield* host.tool.transform((editor) => editor.update("read", (tool) => void (tool.description = "wrapped")))
    const observed = yield* observe("read")
    expect(observed.seen[0]?.experimental).toEqual({ plugin: "acme", selfChecks: false })
  }),
)

it.live("the owner follows the latest add, a removal clears it, and a built-in add replaces it", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const acme = yield* PluginHost.make(plugins, "acme", installed)
    const beta = yield* PluginHost.make(plugins, "beta", { type: "local", path: "/beta" })
    const core = yield* PluginHost.make(plugins, "core", builtin)
    yield* acme.tool.transform((editor) => editor.add(make("deploy")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toMatchObject({ plugin: "acme" })

    yield* beta.tool.transform((editor) => editor.add(make("deploy")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toMatchObject({ plugin: "beta" })

    // A built-in update leaves the owner; a built-in add clears it.
    yield* core.tool.transform((editor) => editor.update("deploy", (tool) => void (tool.description = "again")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toMatchObject({ plugin: "beta" })
    yield* core.tool.transform((editor) => editor.add(make("deploy")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({ selfChecks: false })

    // Removed, then added again by another plugin, the tool does not keep the earlier owner.
    yield* acme.tool.transform((editor) => editor.remove("deploy"))
    yield* beta.tool.transform((editor) => editor.add(make("deploy")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toMatchObject({ plugin: "beta" })
  }),
)

it.live("a hook cannot change the owner that later hooks see, and core still runs the tool", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const tools = yield* Tool.Service
    const host = yield* PluginHost.make(plugins, "acme", installed)
    yield* host.tool.transform((editor) => editor.add(make("deploy")))
    const attempts: boolean[] = []
    const later: unknown[] = []
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => {
        // Reflect reports whether each write was refused; plain assignment would throw instead of returning a result.
        attempts.push(
          // oxlint-disable-next-line no-restricted-globals -- The test asserts the refusal result of the write.
          Reflect.set(event.experimental ?? {}, "plugin", "evil"),
          // oxlint-disable-next-line no-restricted-globals -- The test asserts the refusal result of the write.
          Reflect.set(event, "experimental", { plugin: undefined }),
          // oxlint-disable-next-line no-restricted-globals -- The test asserts the refusal result of the redefinition.
          Reflect.defineProperty(event, "experimental", { value: { plugin: undefined } }),
          // oxlint-disable-next-line no-restricted-globals -- The test asserts the refusal result of the delete.
          Reflect.deleteProperty(event, "experimental"),
        )
      }),
    )
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void later.push({ ...event.experimental })),
    )
    const snapshot = yield* tools.snapshot()
    const result = yield* snapshot.execute(call("deploy"))
    expect(attempts).toEqual([false, false, false, false])
    expect(later).toEqual([{ plugin: "acme", addedBy: "acme", selfChecks: false }])
    expect(result.content).toEqual([{ type: "text", text: "deploy:deploy" }])
  }),
)

it.live("a hook that renames the call is reported, and runs, as the tool it renamed to", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const tools = yield* Tool.Service
    const core = yield* PluginHost.make(plugins, "core", builtin)
    const host = yield* PluginHost.make(plugins, "acme", installed)
    yield* core.tool.transform((editor) => editor.add(make("read")))
    yield* host.tool.transform((editor) => editor.add(make("deploy")))
    const later: unknown[] = []
    yield* hooks.register("tool", "execute.before", (event) => Effect.sync(() => void (event.tool = "read")))
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void later.push({ ...event.experimental })),
    )
    const snapshot = yield* tools.snapshot()
    const result = yield* snapshot.execute(call("deploy"))
    expect(later).toEqual([{ selfChecks: false }])
    expect(result.content).toEqual([{ type: "text", text: "read:deploy" }])
  }),
)

it.live("a Promise plugin's tools report the plugin's id", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, "promise-acme", installed)
    const seen: unknown[] = []
    yield* PluginPromise.fromPromise({
      id: "promise-acme",
      async setup(context) {
        await context.tool.transform((editor) =>
          editor.add({
            name: "deploy",
            description: "deploy",
            input: Schema.Struct({ text: Schema.String }),
            execute: async ({ text }) => ({ content: text }),
            options: { codemode: false },
          }),
        )
        await context.tool.hook("execute.before", async (event) => {
          seen.push({ ...event.experimental })
        })
      },
    }).effect(host)
    const observed = yield* observe("deploy")
    expect(observed.seen[0]?.experimental).toEqual({
      plugin: "promise-acme",
      addedBy: "promise-acme",
      selfChecks: false,
    })
    expect(seen).toEqual([{ plugin: "promise-acme", addedBy: "promise-acme", selfChecks: false }])
  }),
)

it.live("addedBy keeps the adding plugin across updates by other plugins and built-in sources", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const a = yield* PluginHost.make(plugins, "a", installed)
    const b = yield* PluginHost.make(plugins, "b", { type: "local", path: "/b" })
    const core = yield* PluginHost.make(plugins, "core", builtin)
    const reword = (description: string) => (editor: Tool.Editor) =>
      editor.update("deploy", (tool) => void (tool.description = description))
    yield* a.tool.transform((editor) => editor.add(make("deploy")))
    yield* b.tool.transform(reword("b"))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({
      plugin: "b",
      addedBy: "a",
      selfChecks: false,
    })

    // A built-in update changes neither field.
    yield* core.tool.transform(reword("core"))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({
      plugin: "b",
      addedBy: "a",
      selfChecks: false,
    })

    // The same plugin updating its own tool keeps addedBy too.
    yield* a.tool.transform(reword("a"))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({
      plugin: "a",
      addedBy: "a",
      selfChecks: false,
    })

    // A later add by B takes both fields.
    yield* b.tool.transform((editor) => editor.add(make("deploy")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({
      plugin: "b",
      addedBy: "b",
      selfChecks: false,
    })
  }),
)

it.live("a built-in tool an installed plugin updates has an owner but no addedBy", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const core = yield* PluginHost.make(plugins, "core", builtin)
    const b = yield* PluginHost.make(plugins, "b", installed)
    yield* core.tool.transform((editor) => editor.add(make("shell")))
    yield* b.tool.transform((editor) => editor.update("shell", (tool) => void (tool.description = "wrapped")))
    expect((yield* observe("shell")).seen[0]?.experimental).toEqual({ plugin: "b", selfChecks: false })

    // A tool of the same name added later by B is B's.
    yield* b.tool.transform((editor) => editor.add(make("shell")))
    expect((yield* observe("shell")).seen[0]?.experimental).toEqual({
      plugin: "b",
      addedBy: "b",
      selfChecks: false,
    })
  }),
)

it.live("remove deletes addedBy, and a built-in or MCP add clears it", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const a = yield* PluginHost.make(plugins, "a", installed)
    const core = yield* PluginHost.make(plugins, "core", builtin)
    yield* a.tool.transform((editor) => editor.add(make("deploy")))
    yield* a.tool.transform((editor) => editor.remove("deploy"))
    // Re-added by a built-in source after a removal: nothing is left over from A.
    yield* core.tool.transform((editor) => editor.add(make("deploy")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({ selfChecks: false })

    yield* a.tool.transform((editor) => editor.add(make("deploy")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toMatchObject({ addedBy: "a" })
    yield* core.tool.transform((editor) => editor.add(make("deploy")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({ selfChecks: false })

    // MCP tools register on the Tool service directly, over a tool an installed plugin added.
    yield* a.tool.transform((editor) => editor.add(make("deploy")))
    yield* tools.transform((editor) => editor.add(make("deploy")))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({ selfChecks: false })
  }),
)

it.live("a rejected add changes neither plugin nor addedBy", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const a = yield* PluginHost.make(plugins, "a", installed)
    const b = yield* PluginHost.make(plugins, "b", { type: "local", path: "/b" })
    yield* a.tool.transform((editor) => editor.add(make("deploy")))
    // Not a schema, so `commit` refuses it.
    yield* b.tool.transform((editor) => editor.add({ ...make("deploy"), input: 5 as never }))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({
      plugin: "a",
      addedBy: "a",
      selfChecks: false,
    })
  }),
)

it.live("namespaced tools follow the same addedBy rules", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const a = yield* PluginHost.make(plugins, "a", installed)
    const b = yield* PluginHost.make(plugins, "b", { type: "local", path: "/b" })
    yield* a.tool.transform((editor) => editor.add(make("deploy", { codemode: false, namespace: "ops" })))
    // An update cannot move the tool out of its namespace, so the id and addedBy stay put.
    yield* b.tool.transform((editor) =>
      editor.update("ops_deploy", (tool) => void (tool.options = { codemode: false, namespace: "other" })),
    )
    expect((yield* observe("ops_deploy")).seen[0]?.experimental).toEqual({
      plugin: "b",
      addedBy: "a",
      selfChecks: false,
    })
  }),
)

it.live("a plugin cannot forge addedBy through the editor or the tool objects", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const a = yield* PluginHost.make(plugins, "a", installed)
    const b = yield* PluginHost.make(plugins, "b", { type: "local", path: "/b" })
    const kept: Array<{ options?: unknown }> = []
    yield* a.tool.transform((editor) => {
      editor.add(make("deploy"))
      editor.update("deploy", (tool) => void kept.push(tool))
    })
    yield* b.tool.transform((editor) => {
      const forged = { codemode: false, experimental: { addedBy: "b", plugin: "b" } }
      Object.assign(editor.get("deploy") ?? {}, { options: forged })
      Object.assign(editor.list()[0] ?? {}, { options: forged })
      editor.update("deploy", (tool) => void Object.assign(tool, { addedBy: "b" }))
    })
    // The reference A kept cannot clear it either.
    Object.assign(kept[0] ?? {}, {
      options: { codemode: false, experimental: { addedBy: undefined } },
      addedBy: undefined,
    })
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({
      plugin: "b",
      addedBy: "a",
      selfChecks: false,
    })
  }),
)

it.live("a Code Mode inner call and a renamed call report addedBy of the tool that runs", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const tools = yield* Tool.Service
    const a = yield* PluginHost.make(plugins, "a", installed)
    const b = yield* PluginHost.make(plugins, "b", { type: "local", path: "/b" })
    yield* a.tool.transform((editor) => {
      editor.add(make("inner", { codemode: true }))
      editor.add(make("direct", { codemode: false }))
    })
    yield* b.tool.transform((editor) => editor.update("inner", (tool) => void (tool.description = "wrapped")))
    const seen: Array<{ tool: string; experimental: unknown }> = []
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void seen.push({ tool: event.tool, experimental: { ...event.experimental } })),
    )
    const snapshot = yield* tools.snapshot()
    yield* snapshot.execute(call("direct"))
    yield* snapshot.execute(call("execute", { code: 'return await tools.inner({ text: "inner" })' }))
    expect(seen.find((event) => event.tool === "inner")?.experimental).toEqual({
      plugin: "b",
      addedBy: "a",
      selfChecks: false,
    })
    expect(seen.find((event) => event.tool === "direct")?.experimental).toEqual({
      plugin: "a",
      addedBy: "a",
      selfChecks: false,
    })

    // A hook that renames a call to a built-in tool sees no addedBy afterwards.
    const core = yield* PluginHost.make(plugins, "core", builtin)
    yield* core.tool.transform((editor) => editor.add(make("read")))
    const later: unknown[] = []
    yield* hooks.register("tool", "execute.before", (event) => Effect.sync(() => void (event.tool = "read")))
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void later.push({ ...event.experimental })),
    )
    const renamed = yield* tools.snapshot()
    yield* renamed.execute(call("direct"))
    expect(later).toEqual([{ selfChecks: false }])
  }),
)

it.live("an unknown tool reports an empty object with no addedBy", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const a = yield* PluginHost.make(plugins, "a", installed)
    yield* a.tool.transform((editor) => editor.add(make("deploy")))
    yield* a.tool.transform((editor) => editor.remove("deploy"))
    const hooks = yield* PluginHooks.Service
    const tools = yield* Tool.Service
    const seen: unknown[] = []
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void seen.push({ ...event.experimental })),
    )
    const snapshot = yield* tools.snapshot()
    yield* snapshot.execute(call("deploy")).pipe(Effect.ignore)
    expect(seen).toEqual([{}])
  }),
)

it.live("a call renamed between two installed tools reports the target tool's addedBy", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const tools = yield* Tool.Service
    const a = yield* PluginHost.make(plugins, "a", installed)
    const b = yield* PluginHost.make(plugins, "b", { type: "local", path: "/b" })
    yield* a.tool.transform((editor) => editor.add(make("first")))
    yield* b.tool.transform((editor) => editor.add(make("second")))
    const later: unknown[] = []
    yield* hooks.register("tool", "execute.before", (event) => Effect.sync(() => void (event.tool = "second")))
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => void later.push({ ...event.experimental })),
    )
    const snapshot = yield* tools.snapshot()
    const result = yield* snapshot.execute(call("first"))
    expect(later).toEqual([{ plugin: "b", addedBy: "b", selfChecks: false }])
    expect(result.content).toEqual([{ type: "text", text: "second:first" }])
  }),
)

it.live("a rejected built-in add over an installed tool leaves addedBy unchanged", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const a = yield* PluginHost.make(plugins, "a", installed)
    const core = yield* PluginHost.make(plugins, "core", builtin)
    yield* a.tool.transform((editor) => editor.add(make("deploy")))
    // Not a schema, so `commit` refuses it before the built-in add can clear anything.
    yield* core.tool.transform((editor) => editor.add({ ...make("deploy"), input: 5 as never }))
    expect((yield* observe("deploy")).seen[0]?.experimental).toEqual({
      plugin: "a",
      addedBy: "a",
      selfChecks: false,
    })
  }),
)
