export * as ExplicitServer from "./explicit-server"

// This module must not import `electron`, `../constants` or `@opencode/client/service` (type imports included), so
// that it loads under plain `bun test` without the Electron binary.
import { readPasswordFile } from "@opencode/util/password-file"
import { Effect, Schema } from "effect"
import { nativeT } from "../native/translations"
import { authorization, type Data } from "./sidecar-credentials"

export type Server =
  | {
      readonly type: "valid"
      readonly origin: string
      readonly password: string | undefined
      readonly passwordFile: string | undefined
    }
  | { readonly type: "invalid" }

const SERVER = "OPENCODE_EXPERIMENTAL_DESKTOP_SERVER"
const PASSWORD = "OPENCODE_PASSWORD"
const SERVER_PASSWORD = "OPENCODE_SERVER_PASSWORD"
const PASSWORD_FILE = "OPENCODE_PASSWORD_FILE"

const Info = Schema.Struct({ version: Schema.String })

let current: Server | undefined

/**
 * Reads explicit-server mode from the launch environment. Mode is on when the variable is set and non-empty, whether
 * or not it parses. Then the plain password variables leave `env`, so nothing that inherits it can see them; the
 * password file variable stays, because the file is the credential's only copy. An empty password variable counts as
 * unset, as it does in the CLI.
 */
export function explicitServer(env: Record<string, string | undefined>): Server | undefined {
  const value = env[SERVER]
  if (!value) {
    current = undefined
    return current
  }

  const password = env[PASSWORD] || env[SERVER_PASSWORD] || undefined
  delete env[PASSWORD]
  delete env[SERVER_PASSWORD]
  const origin = parseOrigin(value)
  current = origin
    ? { type: "valid", origin, password, passwordFile: env[PASSWORD_FILE] || undefined }
    : { type: "invalid" }
  return current
}

/** What the last `explicitServer` call stored. */
export function configured() {
  return current
}

/** The login shell's environment without anything that could switch the mode or inject a password. */
export function shellOverrides(shellEnv: Readonly<Record<string, string>>) {
  const dropped: string[] = current ? [SERVER, PASSWORD_FILE, PASSWORD, SERVER_PASSWORD] : [SERVER, PASSWORD_FILE]
  return Object.fromEntries(Object.entries(shellEnv).filter(([key]) => !dropped.includes(key)))
}

export const connectExplicit = Effect.fn("ExplicitServer.connect")(function* (
  server: Server,
  bundled: string | undefined,
) {
  if (server.type === "invalid") return yield* Effect.fail(new Error(nativeT("desktop.server.explicit.invalid")))

  const origin = server.origin
  const password = server.password ?? (server.passwordFile ? yield* readPassword(server.passwordFile) : undefined)
  const header = authorization({ url: origin, password: password ?? null }, origin)

  // The body is read inside this step: a timeout or reset while it streams means the server is unavailable.
  const response = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${origin}/api/info`, {
        headers: header ? { authorization: header } : {},
        // A redirect means something else answers on this port; it is not followed.
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      })
      return { status: response.status, text: response.status === 200 ? await response.text() : "" }
    },
    catch: () => serverError("unavailable", origin),
  })

  if (response.status === 401) return yield* Effect.fail(serverError("unauthorized", origin))
  if ([500, 502, 503, 504].includes(response.status)) return yield* Effect.fail(serverError("unavailable", origin))
  if (response.status !== 200) return yield* Effect.fail(serverError("incompatible", origin))

  // Decoded apart from the fetch: a body that is not JSON means something else answers on this port, not that the
  // server is down.
  const info = Schema.decodeUnknownOption(Schema.fromJsonString(Info))(response.text)
  if (info._tag === "None") return yield* Effect.fail(serverError("incompatible", origin))

  if (bundled !== undefined && info.value.version !== bundled) {
    yield* Effect.logWarning("explicit server version differs", { origin, version: info.value.version, bundled })
  }

  return { url: origin, password: password ?? null } satisfies Data
})

// The reader throws only `PasswordFileError`.
const readPassword = (path: string) =>
  Effect.try({
    try: () => readPasswordFile(path),
    catch: () => new Error(nativeT("desktop.server.explicit.passwordFile", { path })),
  })

function parseOrigin(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "http:") return
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return
  if (url.pathname !== "/" || url.search || url.username || url.password) return
  return url.origin
}

function serverError(kind: "unavailable" | "unauthorized" | "incompatible", origin: string) {
  return new Error(nativeT(`desktop.server.explicit.${kind}`, { origin }))
}
