import { Tool } from "@opencode/schema/tool"
import type { Agent } from "@opencode/schema/agent"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Effect, Types } from "effect"
import type { Hooks, Transform } from "./registration.js"

export interface ToolEditor {
  list(): readonly (Tool.Info & { readonly id: string })[]
  get(id: string): (Tool.Info & { readonly id: string }) | undefined
  namespace(namespace: Tool.Namespace): void
  add<Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined>(
    tool: Tool.Info<Input, Output>,
  ): void
  /** Updates an existing tool; missing IDs are ignored. */
  update(id: string, update: (tool: Types.Mutable<Tool.Info>) => void): void
  remove(id: string): void
}

export interface ToolHooks {
  readonly "execute.before": {
    tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    input: unknown
    /**
     * Experimental: may change without compatibility guarantees. Read-only facts about the tool this call will run,
     * set by OpenCode and the same for direct calls and Code Mode inner calls. Assigning to or redefining the field
     * throws, which fails that call.
     *
     * `plugin` is the id of the non-built-in plugin (package, local path or SDK) that last added or updated the tool,
     * and is undefined for built-in and MCP tools. It is the plugin's self-declared id: duplicate ids are rejected and
     * the first plugin in boot order wins, so a permission plugin should not trust a tool by this id alone.
     *
     * `selfChecks` is true when the tool sets `options.experimental.permission.self`. `{}`, with no `selfChecks` key,
     * means the tool is unknown at the time of the call, unlike `{ selfChecks: false }` for a known tool.
     */
    readonly experimental?: { readonly plugin?: string; readonly selfChecks?: boolean }
  }
  readonly "execute.after": {
    readonly tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    readonly input: unknown
  } & (
    | {
        readonly status: "completed"
        result: Tool.Result
      }
    | {
        readonly status: "error"
        error: Tool.Error
      }
  )
}

// Only execute.before may fail: a Tool.Error rejects the call before the tool runs.
export interface ToolFailures extends Record<keyof ToolHooks, unknown> {
  readonly "execute.before": Tool.Error
  readonly "execute.after": never
}

export interface ToolDomain {
  readonly transform: Transform<ToolEditor>
  readonly reload: () => Effect.Effect<void>
  /** Currently registered tools, after every transform, keyed by effective name. */
  readonly list: () => Effect.Effect<readonly (Tool.Info & { readonly id: string })[]>
  readonly hook: Hooks<ToolHooks, ToolFailures>
}
