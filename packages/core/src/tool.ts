export * as Tool from "./tool.js"
export { CallID, Content, Error, FileContent, TextContent } from "@opencode/schema/tool"
export type { Context, Metadata, Namespace, Options, Result } from "@opencode/schema/tool"

import { ToolDefinition, type ToolCall } from "@opencode/ai/effect"
import type { CodeMode } from "@opencode/codemode"
import { Tool } from "@opencode/schema/tool"
import { Context, Effect, Layer, Ref, Result, Schema, SchemaIssue, Types } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { Agent } from "./agent.js"
import { CodeModeCatalog } from "./codemode/catalog.js"
import { CodeModeTool } from "./codemode/tool.js"
import { Flag } from "./flag.js"
import { Image } from "./image.js"
import { Permission } from "./permission.js"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"
import { State } from "./state.js"
import { definition, effectiveName, execute, normalizedName, normalizeContent } from "./tool/runtime.js"
import { Wildcard } from "./util/wildcard.js"

export class RegistrationError extends Schema.TaggedError<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export interface Editor {
  readonly list: () => readonly (Tool.Info & { readonly id: string })[]
  readonly get: (id: string) => (Tool.Info & { readonly id: string }) | undefined
  readonly namespace: (namespace: Tool.Namespace) => void
  readonly add: (tool: Tool.Info) => void
  readonly update: (id: string, update: (tool: Types.Mutable<Tool.Info>) => void) => void
  readonly remove: (id: string) => void
}

// What the state builds per rebuild; `as` makes the plugin-facing editor for one owner and is never handed to plugins.
type Owned = { readonly as: (owner?: string) => Editor }

type Data = {
  tools: Map<string, Tool.Info & { readonly id: string }>
  // Converted once at registration; schemas cannot change without re-registering the tool.
  definitions: Map<string, ToolDefinition>
  namespaces: Map<string, Tool.Namespace>
  // Written only through `Interface.installed`, never through the plugin-facing editor or the stored tools.
  owners: Map<string, string>
  errors: { kind: "tool" | "namespace"; name: string; namespace?: string; error: RegistrationError }[]
}

export interface Interface extends State.Transformable<Editor> {
  /**
   * Like `transform`, but every tool the callback adds or updates records `owner` as the installed plugin that provided
   * it, and an add replaces any earlier owner. Only the plugin host calls this; plugins have no other way to write it.
   */
  readonly installed: (owner: string) => State.Transform<Editor>
  readonly list: () => Effect.Effect<ReadonlyArray<Tool.Info & { readonly id: string }>>
  readonly snapshot: (permissions?: Permission.Ruleset) => Effect.Effect<Snapshot>
  /**
   * Runs a Code Mode program with no model step over only the Code Mode tools named in `tools` (still subject to
   * whole-tool permission filtering and each tool's own executor policy), with no `fetch`.
   */
  readonly check: (input: CheckInput) => Effect.Effect<CodeMode.Result>
}

export interface CheckInput {
  readonly code: string
  readonly tools: ReadonlyArray<string>
  readonly bindings: Readonly<Record<string, CodeMode.DataValue>>
  readonly permissions: Permission.Ruleset
  readonly limits: CodeMode.ExecutionLimits
  readonly context: Omit<Tool.Context, "id">
}

/** A local execution result after hooks and content normalization. */
export interface NormalizedResult extends Tool.Result {
  readonly content: ReadonlyArray<Tool.Content>
}

export interface Snapshot {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly codeModeCatalog?: CodeModeCatalog.Inventory
  readonly execute: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly call: ToolCall
    readonly progress?: (update: Tool.Metadata) => Effect.Effect<void>
    /** Surviving request definitions, keyed by the names advertised after session context hooks. */
    readonly definitions?: ReadonlyMap<string, ToolDefinition>
  }) => Effect.Effect<NormalizedResult, Tool.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Tool") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const image = yield* Image.Service
    const permission = yield* Permission.Service
    const flag = yield* Flag.Service

    type NormalizedItem = Tool.Content | "decode" | "size"
    const normalizeImages = Effect.fnUntraced(function* (content: ReadonlyArray<Tool.Content>) {
      const normalized = yield* Effect.forEach(content, (item): Effect.Effect<NormalizedItem> => {
        if (item.type !== "file" || !item.mime.startsWith("image/")) return Effect.succeed(item)
        const base64 = /^data:[^,]*;base64,(.*)$/s.exec(item.uri)?.[1]
        if (base64 === undefined) return Effect.succeed(item)
        const resource = item.name ?? `${item.mime} tool output`
        return image.normalize(resource, { uri: resource, content: base64, encoding: "base64", mime: item.mime }).pipe(
          Effect.map((result) => ({
            ...item,
            uri: `data:${result.mime};base64,${result.content}`,
            mime: result.mime,
          })),
          Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(item)),
          Effect.catchTag("Image.DecodeError", () => Effect.succeed("decode" as const)),
          Effect.catchTag("Image.SizeError", () => Effect.succeed("size" as const)),
        )
      })
      const note = (reason: "decode" | "size", text: string) => {
        const count = normalized.filter((item) => item === reason).length
        if (count === 0) return []
        return [{ type: "text" as const, text: `[${count} image${count === 1 ? "" : "s"} omitted: ${text}]` }]
      }
      return [
        ...normalized.filter((item) => typeof item !== "string"),
        ...note("decode", "could not be decoded."),
        ...note("size", "could not be resized below the image size limit."),
      ]
    })

    // `target` finds the id of the tool the call will run. `experimental` reads the event's current `tool`, so a hook that
    // renames the call is told about the tool that actually runs. It is a non-configurable getter without a setter that
    // returns a fresh frozen object, so a hook cannot change what later hooks see, and core never reads it back.
    const beforeExecute = (
      data: Data,
      name: string,
      input: unknown,
      context: Tool.Context,
      target: (name: string) => string | undefined,
    ) => {
      const event: PluginHooks.Domains["tool"]["execute.before"] = {
        tool: name,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        input,
      }
      Object.defineProperty(event, "experimental", {
        get: () => experimental(data, target(event.tool)),
        enumerable: true,
        configurable: false,
      })
      return hooks.trigger("tool", "execute.before", event)
    }

    const executeTool = Effect.fn("Tool.execute")(function* (
      tool: Tool.Info,
      name: string,
      input: unknown,
      context: Tool.Context,
    ) {
      yield* Effect.annotateCurrentSpan({
        "gen_ai.tool.name": name,
        "gen_ai.tool.call.id": context.id,
        "session.id": context.sessionID,
      })
      const execution = yield* execute(tool, input, context).pipe(
        Effect.map((value) => ({ value })),
        Effect.catchTag("Tool.Error", (failure) => Effect.succeed({ failure })),
      )
      const base = {
        tool: name,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        input,
      }
      if ("failure" in execution) {
        const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
          ...base,
          status: "error",
          error: execution.failure,
        }
        yield* hooks.trigger("tool", "execute.after", afterEvent)
        return yield* afterEvent.error
      }
      const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
        ...base,
        status: "completed",
        result: {
          ...(execution.value.output === undefined ? {} : { output: execution.value.output }),
          content: execution.value.content,
          ...(execution.value.metadata === undefined ? {} : { metadata: execution.value.metadata }),
        },
      }
      yield* hooks.trigger("tool", "execute.after", afterEvent)
      const afterContent = yield* normalizeImages(normalizeContent(afterEvent.result.content, afterEvent.result.output))
      return {
        ...(afterEvent.result.output === undefined ? {} : { output: afterEvent.result.output }),
        content: afterContent,
        ...(afterEvent.result.metadata === undefined ? {} : { metadata: afterEvent.result.metadata }),
      }
    })

    const run = (data: Data, tool: Tool.Info, name: string, input: unknown, context: Tool.Context) =>
      beforeExecute(data, name, input, context, () => name).pipe(
        Effect.flatMap((event) => executeTool(tool, name, event.input, context)),
      )

    let catalog:
      | {
          data: Data
          names: string
          inventory: CodeModeTool.Inventory
          value: CodeModeCatalog.Inventory
          definition: ToolDefinition
        }
      | undefined
    const state = State.create<Data, Owned>({
      name: "tool",
      initial: () => ({
        tools: new Map(),
        definitions: new Map(),
        namespaces: new Map(),
        owners: new Map(),
        errors: [],
      }),
      editor: (editor) => {
        // The owner is fixed when the editor is made, so an editor a plugin keeps still records the same owner. A change
        // by a built-in source (no owner) leaves an existing owner alone; adding over a tool clears it.
        const as = (owner?: string): Editor => ({
          list: () => Array.from(editor.tools.values()),
          get: (id) => editor.tools.get(id),
          namespace: (namespace) => {
            const error = namespaceError(namespace.name)
            if (error) {
              editor.errors.push({ kind: "namespace", name: namespace.name, namespace: namespace.name, error })
              return
            }
            editor.namespaces.set(namespace.name, { ...namespace })
          },
          add: (tool) => {
            const id = effectiveName(tool)
            if (!commit(editor, id, { ...tool, id, options: tool.options && { ...tool.options } })) return
            if (owner === undefined) editor.owners.delete(id)
            else editor.owners.set(id, owner)
          },
          update: (id, update) => {
            const current = editor.tools.get(id)
            if (!current) return
            const tool = { ...current, options: current.options && { ...current.options } }
            update(tool)
            tool.name = current.name
            tool.id = id
            if (tool.options?.namespace !== current.options?.namespace)
              tool.options = { ...tool.options, namespace: current.options?.namespace }
            if (!commit(editor, id, tool) || owner === undefined) return
            editor.owners.set(id, owner)
          },
          remove: (id) => {
            editor.tools.delete(id)
            editor.definitions.delete(id)
            editor.owners.delete(id)
          },
        })
        return { as }
      },
      notify: (value) => {
        catalog = undefined
        return Effect.forEach(
          value.errors,
          ({ kind, name, namespace, error }) =>
            Effect.logError(`Skipping invalid ${kind} registration`, {
              name,
              namespace,
              error: error.message,
            }),
          { discard: true },
        )
      },
    })

    return Service.of({
      transform: (callback) => state.transform((editor) => callback(editor.as())),
      installed: (owner) => (callback) => state.transform((editor) => callback(editor.as(owner))),
      reload: state.reload,
      list: () => Effect.sync(() => Array.from(state.get().tools.values())),
      snapshot: Effect.fn("Tool.snapshot")((permissions) =>
        Effect.sync(() => {
          const data = state.get()
          const active = new Map<string, Tool.Info>()
          const rules = permissions ?? []
          for (const [name, tool] of data.tools) {
            if (whollyDisabled(tool.options?.permission ?? name, rules)) continue
            active.set(name, tool)
          }
          const codeModeEnabled = !whollyDisabled("execute", rules)
          // Without Code Mode its tools would be unreachable, so expose them as direct tools instead.
          const direct = codeModeEnabled
            ? new Map(Array.from(active).filter(([, tool]) => tool.options?.codemode === false))
            : active
          const codeModeTools = new Map(Array.from(active).filter(([, tool]) => tool.options?.codemode !== false))
          const names = Array.from(codeModeTools.keys()).join("\0")
          // Discovery is immutable for a registry revision and visible tool set. Keep executors
          // fresh, but share the inventory, whose prepared runtime and much larger rendered catalog
          // are cached by identity, and the execute tool's definition across steps.
          const cached = catalog?.data === data && catalog.names === names ? catalog : undefined
          const codeModeInventory = cached?.inventory ?? { tools: codeModeTools, namespaces: data.namespaces }
          const codeModeTool = codeModeEnabled
            ? CodeModeTool.create(
                codeModeInventory,
                (name, tool, input, context) => run(data, tool, name, input, context),
                permission,
                flag,
              )
            : undefined
          const codeModeCatalog = !codeModeEnabled
            ? undefined
            : (cached?.value ?? CodeModeTool.catalog(codeModeInventory))
          const codeModeDefinition = codeModeTool && (cached?.definition ?? definition(codeModeTool))
          if (codeModeCatalog && codeModeDefinition)
            catalog = {
              data,
              names,
              inventory: codeModeInventory,
              value: codeModeCatalog,
              definition: codeModeDefinition,
            }
          return {
            ...(codeModeCatalog === undefined ? {} : { codeModeCatalog }),
            definitions: [
              ...Array.from(direct)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([name]) => data.definitions.get(name)!),
              ...(codeModeDefinition ? [codeModeDefinition] : []),
            ],
            execute: Effect.fnUntraced(function* (input: Parameters<Snapshot["execute"]>[0]) {
              const context: Tool.Context = {
                sessionID: input.sessionID,
                agent: input.agent,
                messageID: input.messageID,
                id: Tool.CallID.make(input.call.id),
                progress: input.progress ?? (() => Effect.void),
              }
              const event = yield* beforeExecute(data, input.call.name, input.call.input, context, (called) => {
                const id = input.definitions?.get(called)?.name ?? called
                return direct.has(id) ? id : undefined
              })
              const requested = input.definitions?.get(event.tool)
              // Preserve session context removal and alias resolution, now after the repair hook.
              if (!requested && input.definitions && (direct.has(event.tool) || codeModeTool?.name === event.tool))
                return yield* new Tool.Error({ message: `Tool is not available for this request: ${event.tool}` })
              const name = requested?.name ?? event.tool
              if (name === "execute" && codeModeTool)
                return yield* executeTool(codeModeTool, name, event.input, context)
              const tool = direct.get(name)
              if (tool) return yield* executeTool(tool, name, event.input, context)
              return yield* new Tool.Error({
                message: `No tool named "${name}" is currently available. Please use a tool from the available tool list.`,
              })
            }),
          }
        }),
      ),
      check: Effect.fn("Tool.check")(function* (input) {
        if (whollyDisabled("execute", input.permissions)) {
          return {
            ok: false,
            error: { kind: "ExecutionFailure", message: "Code Mode is disabled for this agent" },
            toolCalls: [],
          } satisfies CodeMode.Result
        }
        const data = state.get()
        const allowed = new Set(input.tools)
        const tools = new Map(
          Array.from(data.tools).filter(
            ([name, tool]) =>
              tool.options?.codemode !== false &&
              allowed.has(CodeModeTool.qualifiedName(tool)) &&
              !whollyDisabled(tool.options?.permission ?? name, input.permissions),
          ),
        )
        const callSeq = yield* Ref.make(0)
        return yield* CodeModeTool.check(
          { tools, namespaces: data.namespaces },
          input.code,
          input.bindings,
          input.limits,
          (name, tool, toolInput) =>
            Effect.gen(function* () {
              const index = yield* Ref.getAndUpdate(callSeq, (value) => value + 1)
              const context: Tool.Context = {
                ...input.context,
                id: Tool.CallID.make(`call_${input.context.messageID}_${index}`),
              }
              return yield* run(data, tool, name, toolInput, context)
            }),
          flag,
        )
      }),
    })
  }),
)

function experimental(data: Data, id: string | undefined) {
  const tool = id === undefined ? undefined : data.tools.get(id)
  if (id === undefined || tool === undefined) return Object.freeze({})
  const plugin = data.owners.get(id)
  return Object.freeze({
    ...(plugin === undefined ? {} : { plugin }),
    selfChecks: tool.options?.experimental?.permission?.self === true,
  })
}

/** Store a valid tool under its effective name, or record why it was skipped. */
function commit(editor: Data, id: string, input: Tool.Info & { readonly id: string }) {
  // JavaScript plugins may leave out `input` for a tool that takes none.
  const tool = input.input === undefined || input.input === null ? { ...input, input: {} } : input
  const registered = register(tool)
  if (Result.isFailure(registered)) {
    editor.errors.push({
      kind: "tool",
      name: tool.name,
      namespace: tool.options?.namespace,
      error: registered.failure,
    })
    return false
  }
  editor.tools.set(id, tool)
  editor.definitions.set(id, registered.success)
  return true
}

const whollyDisabled = (action: string, rules: Permission.Ruleset) => {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

const formatSchemaIssue = SchemaIssue.makeFormatterDefault()

function schemaMakeError(error: unknown) {
  if (error instanceof Error && SchemaIssue.isIssue(error.cause)) return formatSchemaIssue(error.cause)
  return error instanceof Error ? error.message : String(error)
}

function register(tool: Tool.Info): Result.Result<ToolDefinition, RegistrationError> {
  const namespace = tool.options?.namespace
  if (namespace !== undefined) {
    const error = namespaceError(namespace)
    if (error) return Result.fail(error)
  }
  const name = normalizedName(tool)
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    return Result.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))
  const id = effectiveName(tool)
  if (tool.options?.codemode === false && id === "execute")
    return Result.fail(new RegistrationError({ name: id, message: 'Tool name "execute" is reserved for CodeMode' }))
  // Standard Schema libraries such as ArkType make schemas that are functions.
  if (typeof tool.input !== "object" && typeof tool.input !== "function")
    return Result.fail(
      new RegistrationError({ name: id, message: `Invalid tool definition ${id}: input must be a schema` }),
    )
  return Result.try({
    try: () => ToolDefinition.make(definition(tool)),
    catch: (error) =>
      new RegistrationError({ name: id, message: `Invalid tool definition ${id}: ${schemaMakeError(error)}` }),
  })
}

function namespaceError(name: string) {
  if (name.split(".").every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))) return
  return new RegistrationError({ name, message: `Invalid tool namespace: ${JSON.stringify(name)}` })
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, Image.node, Permission.node, Flag.node],
})
