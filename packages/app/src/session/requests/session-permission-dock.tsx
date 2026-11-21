import { Option, Schema } from "effect"
import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode/client/promise"
import type { MountedSession, SessionScreen } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Icon } from "@opencode/ui/icon"
import { PluginSlot } from "@/runtime/plugin/render"
import { useLanguage } from "@/runtime/i18n/language"

const decodeToolInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

const isString = Schema.is(Schema.String)

export function SessionPermissionDock(props: {
  request: PermissionRequest
  /** The routed session and its screen, for plugins that fill `experimental.session.permission.actions`; stories mount the dock without them. */
  context?: { readonly session: MountedSession; readonly screen: SessionScreen }
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.action}.description`
    // SAFETY: an action without a curated description returns the key itself, which the check below detects.
    const value = language.t(key as Parameters<typeof language.t>[0])

    if (value === key) return ""

    return value
  }

  const input = () =>
    Option.match(decodeToolInput(props.request.metadata?.input), {
      onNone: () => [],
      onSome: (value) =>
        Object.entries(value).map(([key, item]) => `${key}: ${isString(item) ? item : JSON.stringify(item)}`),
    })

  const buttons = () => (
    <>
      <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
        {language.t("ui.permission.deny")}
      </Button>
      <Button variant="neutral" size="normal" onClick={() => props.onDecide("always")} disabled={props.responding}>
        {language.t("ui.permission.allowAlways")}
      </Button>
      <Button variant="submit" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
        {language.t("ui.permission.allowOnce")}
      </Button>
    </>
  )

  const body = () => (
    <>
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <Show when={toolDescription()} fallback={<code data-slot="permission-action">{props.request.action}</code>}>
          <div data-slot="permission-hint">{toolDescription()}</div>
        </Show>
      </div>

      <Show when={props.request.message}>
        {(message) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint">{message()}</div>
          </div>
        )}
      </Show>

      <Show when={input().length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          {/* Scrolls rather than truncates: the user approves these arguments, so all of them must be reachable */}
          <div data-slot="permission-input" data-scrollable>
            <For each={input()}>{(line) => <code class="text-text-weak break-all">{line}</code>}</For>
          </div>
        </div>
      </Show>

      <Show when={props.request.resources.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.resources}>
              {(pattern) => <code class="text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </>
  )

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Show when={props.context} fallback={buttons()}>
              {(context) => (
                <PluginSlot
                  at="experimental.session.permission.actions"
                  fallback={buttons()}
                  input={{
                    get screen() {
                      return context().screen
                    },
                    get session() {
                      return context().session
                    },
                    get request() {
                      return props.request
                    },
                  }}
                />
              )}
            </Show>
          </div>
        </>
      }
    >
      {/* Scrolls when a plugin's body is taller than the dock; the host's own rows keep their own scrolling inside. */}
      <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-auto" data-scrollable>
        <Show when={props.context} fallback={body()}>
          {(context) => (
            <PluginSlot
              at="experimental.session.permission.body"
              fallback={body()}
              input={{
                get screen() {
                  return context().screen
                },
                get session() {
                  return context().session
                },
                get request() {
                  return props.request
                },
                fallback: body,
              }}
            />
          )}
        </Show>
      </div>
    </DockPrompt>
  )
}
