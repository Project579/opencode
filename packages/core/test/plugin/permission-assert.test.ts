import { expect } from "bun:test"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Tool } from "@opencode/core/tool"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import type { PermissionDomain } from "@opencode/plugin/promise/permission"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Info } from "@opencode/schema/tool"
import { Flag } from "@opencode/core/flag"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { makePluginTestLayer } from "./fixture"

const asserted: Permission.AssertInput[] = []
const floored: Permission.AssertInput[] = []

// Answers by action so each test can pick the outcome the real service would produce.
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: (input) => {
      asserted.push(input)
      if (input.action === "blocked")
        return Effect.fail(new Permission.BlockedError({ rules: [], permission: "blocked", resources: ["*"] }))
      if (input.action === "corrected") return Effect.fail(new Permission.CorrectedError({ feedback: "Use staging" }))
      if (input.action === "declined") return Effect.die(new Permission.DeclinedError())
      return Effect.void
    },
    assertNotDenied: () => Effect.void,
    assertNotWhollyDenied: (input) => {
      floored.push(input)
      if (input.action === "blocked")
        return Effect.fail(new Permission.BlockedError({ rules: [], permission: "blocked", resources: ["*"] }))
      return Effect.void
    },
    allows: () => Effect.succeed(false),
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

// Test apps run on an unknown channel, where flags default to off.
const flagOn = Layer.succeed(Flag.Overrides, "plugin_tool_permission")

const it = testEffect(Layer.merge(makePluginTestLayer(permission), flagOn))
const sessionID = Session.ID.make("ses_plugin_permission")

it.live("Effect plugins assert permissions and receive outcomes as tool errors", () =>
  Effect.gen(function* () {
    const host = yield* PluginHost.make(yield* Plugin.Service, "test")
    const assert = (action: string) =>
      host.permission.assert({ sessionID, action, resources: ["prod"], save: ["*"] }).pipe(Effect.exit)

    asserted.length = 0
    expect(Exit.isSuccess(yield* assert("deploy"))).toBe(true)
    expect(asserted).toEqual([{ sessionID, action: "deploy", resources: ["prod"], save: ["*"] }])

    const blocked = Option.getOrUndefined(Exit.findErrorOption(yield* assert("blocked")))
    expect(blocked).toBeInstanceOf(Tool.Error)
    expect(blocked).toMatchObject({ message: "Permission denied: blocked" })
    expect(blocked?.error).toBeInstanceOf(Permission.BlockedError)

    const corrected = Option.getOrUndefined(Exit.findErrorOption(yield* assert("corrected")))
    expect(corrected).toMatchObject({ message: "Use staging" })
    expect(corrected?.error).toBeInstanceOf(Permission.CorrectedError)

    const declined = yield* assert("declined")
    expect(
      Exit.isFailure(declined) &&
        declined.cause.reasons.some(
          (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
        ),
    ).toBe(true)
  }),
)

it.live("Promise plugins assert permissions with plain input", () =>
  Effect.gen(function* () {
    let assertPermission: PermissionDomain["assert"] = () => Promise.reject(new Error("Plugin did not start"))
    yield* PluginPromise.fromPromise({
      id: "promise-permission",
      async setup(context) {
        assertPermission = context.permission.assert
      },
    }).effect(yield* PluginHost.make(yield* Plugin.Service, "test"))
    const assert = (action: string) =>
      Effect.promise(() =>
        assertPermission({ sessionID: "ses_plugin_permission", action, resources: ["prod"] }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      )

    asserted.length = 0
    expect(yield* assert("deploy")).toBeUndefined()
    expect(asserted).toEqual([{ sessionID, action: "deploy", resources: ["prod"] }])
    expect(yield* assert("corrected")).toMatchObject({ _tag: "Tool.Error", message: "Use staging" })
    expect(yield* assert("declined")).toBeInstanceOf(Permission.DeclinedError)
  }),
)

const context = {
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_plugin_permission"),
  id: Tool.CallID.make("call_plugin_permission"),
  progress: () => Effect.void,
}

const echo = (name: string, ran: string[], namespace?: string): Info => ({
  name,
  description: "Echoes its input",
  input: Schema.Struct({ value: Schema.String }),
  ...(namespace ? { options: { namespace } } : {}),
  execute: (input: { value: string }) =>
    Effect.sync(() => {
      ran.push(name)
      return { content: input.value }
    }),
})

const run = Effect.fn(function* (name: string, session = sessionID) {
  const tools = yield* Tool.Service
  const tool = (yield* tools.list()).find((tool) => tool.id === name)
  if (!tool) throw new Error(`Expected tool ${name}`)
  return yield* tool.execute({ value: "hi" }, { ...context, sessionID: session }).pipe(Effect.exit)
})

it.live("tools from installed plugins ask for permission under their name before they run", () =>
  Effect.gen(function* () {
    const ran: string[] = []
    const host = yield* PluginHost.make(yield* Plugin.Service, "installed", { type: "package", target: "installed" })
    yield* host.tool.transform((editor) => {
      editor.add(echo("lookup", ran, "docs"))
      editor.add(echo("blocked", ran))
    })

    asserted.length = 0
    expect(Exit.isSuccess(yield* run("docs_lookup"))).toBe(true)
    expect(asserted).toEqual([
      {
        action: "docs_lookup",
        resources: ["*"],
        metadata: { input: { value: "hi" } },
        sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      },
    ])

    const blocked = Option.getOrUndefined(Exit.findErrorOption(yield* run("blocked")))
    expect(blocked).toMatchObject({ message: "Permission denied: blocked" })
    expect(ran).toEqual(["lookup"])
  }),
)

it.live("with the plugin_tool_permission flag off, tools from installed plugins run without a permission check", () =>
  Effect.gen(function* () {
    const ran: string[] = []
    const host = yield* PluginHost.make(yield* Plugin.Service, "installed", { type: "package", target: "installed" }).pipe(
      Effect.provideService(Flag.Overrides, "-plugin_tool_permission"),
    )
    yield* host.tool.transform((editor) => {
      editor.add(echo("lookup", ran, "docs"))
      editor.add(echo("blocked", ran))
    })

    asserted.length = 0
    floored.length = 0
    expect(Exit.isSuccess(yield* run("docs_lookup"))).toBe(true)
    expect(Exit.isSuccess(yield* run("blocked"))).toBe(true)
    expect(asserted).toEqual([])
    expect(floored).toEqual([])
    expect(ran).toEqual(["lookup", "blocked"])
  }),
)

it.live("built-in tools keep their own permission checks, even when an installed plugin edits or wraps them", () =>
  Effect.gen(function* () {
    const ran: string[] = []
    const builtin = yield* PluginHost.make(yield* Plugin.Service, "builtin")
    yield* builtin.tool.transform((editor) => editor.add(echo("blocked", ran)))

    asserted.length = 0
    expect(Exit.isSuccess(yield* run("blocked"))).toBe(true)
    expect(asserted).toEqual([])

    // A whole-tool check in front of the built-in's finer one would override its rules and save a broader approval.
    const installed = yield* PluginHost.make(yield* Plugin.Service, "installed", { type: "package", target: "x" })
    yield* installed.tool.transform((editor) =>
      editor.update("blocked", (tool) => {
        const original = tool.execute
        tool.description = "Logged"
        tool.execute = (input, context) => original(input, context).pipe(Effect.tap(() => Effect.sync(() => ran.push("log"))))
      }),
    )
    expect(Exit.isSuccess(yield* run("blocked"))).toBe(true)
    expect(asserted).toEqual([])
    expect(ran).toEqual(["blocked", "blocked", "log"])
  }),
)

it.live("installed plugin tools that declare their own checks get only the deny floor", () =>
  Effect.gen(function* () {
    const ran: string[] = []
    const host = yield* PluginHost.make(yield* Plugin.Service, "installed", { type: "package", target: "installed" })
    const self = { experimental: { permission: { self: true } } } as const
    yield* host.tool.transform((editor) => {
      editor.add({ ...echo("lookup", ran), options: self })
      editor.add({ ...echo("blocked", ran), options: self })
    })

    asserted.length = 0
    floored.length = 0
    expect(Exit.isSuccess(yield* run("lookup"))).toBe(true)
    const blocked = Option.getOrUndefined(Exit.findErrorOption(yield* run("blocked")))
    expect(blocked).toMatchObject({ message: "Permission denied: blocked" })
    expect(asserted).toEqual([])
    expect(floored.map((input) => input.action)).toEqual(["lookup", "blocked"])
    expect(ran).toEqual(["lookup"])
  }),
)

it.live("installed plugin tools never offer \"always\"", () =>
  Effect.gen(function* () {
    const ran: string[] = []
    const host = yield* PluginHost.make(yield* Plugin.Service, "installed", { type: "package", target: "installed" })
    yield* host.tool.transform((editor) => {
      // Replaces the built-in shell tool, whose saved `shell:*` would also answer the built-in's per-command checks.
      editor.add(echo("shell", ran))
      editor.add({ ...echo("rewrite", ran), options: { permission: "edit" } })
      editor.add(echo("solo", ran))
    })

    asserted.length = 0
    for (const name of ["shell", "rewrite", "solo"]) expect(Exit.isSuccess(yield* run(name))).toBe(true)
    expect(asserted.map((input) => [input.action, input.save])).toEqual([
      ["shell", undefined],
      ["edit", undefined],
      ["solo", undefined],
    ])
  }),
)

it.live("installed plugin executors keep their `this`", () =>
  Effect.gen(function* () {
    const host = yield* PluginHost.make(yield* Plugin.Service, "installed", { type: "package", target: "installed" })
    yield* host.tool.transform((editor) =>
      editor.add({
        name: "greet",
        description: "Greets",
        input: Schema.Struct({ value: Schema.String }),
        greeting: "hello",
        execute(this: { greeting: string }, input: { value: string }) {
          return Effect.succeed({ content: `${this.greeting} ${input.value}` })
        },
      } as Info),
    )

    asserted.length = 0
    const exit = yield* run("greet")
    expect(Exit.isSuccess(exit) && exit.value.content).toBe("hello hi")
    expect(asserted.map((input) => input.action)).toEqual(["greet"])
  }),
)

// The real permission service, for the rules the deny floor reads.
const real = testEffect(Layer.merge(makePluginTestLayer(null), flagOn))

const sessionWithRules = Effect.fn(function* (rules: Permission.Ruleset) {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (info) => {
      info.permissions = [...rules]
    }),
  )
  const location = yield* Location.Service
  const sessions = yield* Session.Service
  return (yield* sessions.create({ location: { directory: location.directory } })).id
})

real.live("self-checking tools are blocked only when their action is denied outright, or by policy", () =>
  Effect.gen(function* () {
    const ran: string[] = []
    const host = yield* PluginHost.make(yield* Plugin.Service, "installed", { type: "package", target: "installed" })
    const self = { experimental: { permission: { self: true } } } as const
    yield* host.tool.transform((editor) => {
      editor.add({ ...echo("lookup", ran), options: self })
      editor.add({ ...echo("denied", ran), options: self })
      editor.add({ ...echo("policed", ran), options: self })
    })
    // Stands in for managed `tool.use` policy, which denies through this hook.
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("permission", "evaluate", (event) =>
      Effect.sync(() => {
        if (event.action === "policed") event.effect = "deny"
      }),
    )
    const session = yield* sessionWithRules([
      { action: "*", resource: "*", effect: "allow" },
      // Finer rules the tool checks itself; the floor must not read the catch-all deny as a whole-tool one.
      { action: "lookup", resource: "*", effect: "deny" },
      { action: "lookup", resource: "docs/*", effect: "allow" },
      { action: "denied", resource: "*", effect: "deny" },
    ])

    expect(Exit.isSuccess(yield* run("lookup", session))).toBe(true)
    expect(Option.getOrUndefined(Exit.findErrorOption(yield* run("denied", session)))).toBeInstanceOf(Tool.Error)
    expect(Option.getOrUndefined(Exit.findErrorOption(yield* run("policed", session)))).toBeInstanceOf(Tool.Error)
    expect(ran).toEqual(["lookup"])
  }),
)
