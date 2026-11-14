import type { PermissionApi } from "@opencode/client/promise/api"
import type { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import type { AssertInput } from "../permission.js"
import type { Hooks } from "./registration.js"

export interface PermissionEvaluation {
  readonly sessionID: Session.ID
  readonly agent?: Agent.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: Permission.Source
  effect: Permission.Effect
  message?: string
  /**
   * Experimental: may change without compatibility guarantees.
   *
   * Which rule decided each resource, in the order of `resources`: the last configured rule that matched
   * (`rule`), or `saved: true` when a saved approval matched last. Neither is set when no rule matched and
   * the default `ask` applied. Configured denies end the evaluation before the hook runs, so none appear here.
   */
  readonly experimental?: {
    readonly rules: ReadonlyArray<{
      readonly resource: string
      readonly effect: Permission.Effect
      readonly rule?: Permission.Rule
      readonly saved?: boolean
    }>
  }
}

export interface PermissionHooks {
  readonly evaluate: PermissionEvaluation
}

export type PermissionDomain = Pick<PermissionApi, "list" | "get" | "reply"> & {
  readonly hook: Hooks<PermissionHooks>
  /**
   * Evaluates the session's permission rules and, when approval is required, prompts the user and
   * waits for the reply. Resolves when allowed. A deny rule or a rejection with feedback rejects with
   * a `Tool.Error` carrying the reason. A plain rejection rejects with an error that ends the current
   * step; rethrow it rather than returning it as tool output.
   */
  readonly assert: (input: typeof AssertInput.Encoded) => Promise<void>
}
