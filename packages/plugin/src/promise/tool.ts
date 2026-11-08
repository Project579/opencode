export { CallID, Error } from "@opencode/schema/tool"
export type { Metadata, Options, Result } from "@opencode/schema/tool"

import { Tool } from "@opencode/schema/tool"
import type { Agent } from "@opencode/schema/agent"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Types } from "effect"
import type { Hooks, Transform } from "./registration.js"

export interface ToolContext extends Omit<Tool.Context, "progress"> {
  readonly signal: AbortSignal
  readonly progress: (update: Tool.Metadata) => Promise<void>
}

export type Info<
  Input extends Tool.ValueSchema<any> = Tool.ValueSchema<any>,
  Output extends Tool.ValueSchema<any> | undefined = Tool.ValueSchema<any> | undefined,
> = Omit<Tool.Info<Input, Output>, "execute"> & {
  readonly execute: (
    input: Parameters<Tool.Info<Input, Output>["execute"]>[0],
    context: ToolContext,
  ) => Promise<Tool.Result<Output>>
}

export interface ToolEditor {
  list(): readonly (Info & { readonly id: string })[]
  get(id: string): (Info & { readonly id: string }) | undefined
  namespace(namespace: Tool.Namespace): void
  add<Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined>(
    tool: Info<Input, Output>,
  ): void
  /** Updates an existing tool; missing IDs are ignored. */
  update(id: string, update: (tool: Types.Mutable<Info>) => void): void
  remove(id: string): void
}

interface ToolHooks {
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
     *
     * This reports attribution for permission policy, not a boundary between plugins: installed plugins run in-process
     * and can still rewrite tools through the live objects `get`/`list` return.
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

export interface ToolDomain {
  readonly transform: Transform<ToolEditor>
  readonly reload: () => Promise<void>
  /** Currently registered tools, after every transform, keyed by effective name. */
  readonly list: () => Promise<readonly (Info & { readonly id: string })[]>
  readonly hook: Hooks<ToolHooks>
}
